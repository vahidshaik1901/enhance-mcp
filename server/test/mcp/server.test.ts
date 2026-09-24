import { Client, type ClientOptions, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { describe, expect, it } from 'vitest';
import { selectTools } from '../../src/core/registry.js';
import { createServer } from '../../src/server.js';
import { allTools } from '../../src/tools/index.js';
import { makeContext } from '../helpers/context.js';
import { type FakeFetch, type Route, writeThenList } from '../helpers/fakeFetch.js';
import { APP_ID, domainMappings, MYSQL_DB, ORG_ID, persistentApps, PREVIEW_DOMAIN_ID, sshKeys, WEBSITE_ID, websiteDetail, websitesList, websiteSummary } from '../fixtures/panel.js';

/**
 * The SDK's `ElicitResult` (what an `elicitation/create` handler must return) types `content`
 * as `Record<string, string | number | boolean | string[]>`, not `Record<string, unknown>` —
 * see ElicitResultSchema in node_modules/@modelcontextprotocol/client/dist/index.d.mts.
 */
type ElicitAnswer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> };

/**
 * The three client capability shapes that matter here:
 * - `none`: no `elicitation` at all — the token path.
 * - `bare`: `{ elicitation: {} }`, exactly what Claude Code 2.1.258 declares. The SDK's
 *   multi-round-trip gate reads a bare declaration as form support
 *   (`isImpliedCapabilityMember`, server/dist/src-CX2iR2pK.mjs:471), and the client accepts an
 *   `elicitation/create` handler for it (`assertRequestHandlerCapability`, client/dist/index.mjs:3484,
 *   `getSupportedElicitationModes`, client/dist/index.mjs:2877).
 * - `form`: `{ elicitation: { form: {} } }`, the explicit declaration.
 */
type Caps = 'none' | 'bare' | 'form';

const capabilities = (caps: Caps): ClientOptions => (caps === 'none' ? {} : { capabilities: { elicitation: caps === 'bare' ? {} : { form: {} } } });

const base = () => [
  { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: websitesList },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: websiteDetail },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains`, body: domainMappings },
  { method: 'DELETE', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, status: 204 },
];

async function connect(opts: { readOnly?: boolean; env?: Record<string, string>; elicit?: (msg: string) => ElicitAnswer; caps?: Caps; routes?: Route[] } = {}) {
  const t = await makeContext(opts.routes ?? base(), opts.env);
  // `readOnly` unset falls through to the configuration, so a test can pass ENHANCE_READ_ONLY in
  // `env` and exercise the same path bootstrap() takes rather than setting the flag by hand.
  const tools = selectTools(allTools, { tiers: ['customer'], readOnly: opts.readOnly ?? t.ctx.config.readOnly });
  const server = createServer(t.ctx, tools);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' }, capabilities(opts.caps ?? (opts.elicit ? 'form' : 'none')));
  if (opts.elicit) {
    const elicit = opts.elicit;
    client.setRequestHandler('elicitation/create', async (req) => elicit(String((req.params as { message?: string }).message ?? '')));
  }
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { ...t, client, call: caller(client) };
}

function caller(client: Client) {
  return async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
    return { text: r.content.map((c) => c.text ?? '').join('\n'), structured: r.structuredContent, isError: r.isError ?? false };
  };
}

/**
 * The same server, served on the 2026-07-28 era instead of 2025 — the era Task 15's `serveStdio`
 * wiring will run in production. `LATEST_PROTOCOL_VERSION` is `2025-11-25`, so a plain
 * `server.connect()` / `client.connect()` pair can only ever negotiate the legacy era; the modern
 * era is reachable only through a serving entry (`serveStdio`) plus a client pinned to it. That
 * era has no server-to-client request channel at all, so it is the case the old `elicitInput` call
 * could not serve.
 */
async function connectModern(elicit: (msg: string) => ElicitAnswer) {
  const t = await makeContext(base());
  const tools = selectTools(allTools, { tiers: ['customer'], readOnly: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createServer(t.ctx, tools), { transport: serverTransport, legacy: 'reject' });
  // Bare `{ elicitation: {} }`, exactly as Claude Code declares it. Unlike the 2025 handshake, the
  // modern per-request envelope carries it un-normalised — no `form` member is added.
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: { elicitation: {} }, versionNegotiation: { mode: { pin: '2026-07-28' } } });
  client.setRequestHandler('elicitation/create', async (req) => elicit(String((req.params as { message?: string }).message ?? '')));
  await client.connect(clientTransport);
  return { ...t, call: caller(client), close: () => handle.close() };
}

/** The database and user names the milestone B fixtures use, as the panel returns them: every one
 *  is prefixed with the website's unix user, which is what the human has to type to confirm. */
const MYSQL_USER = 'vahi_dev1_app';
const PG_DB = 'vahi_dev1_shop';
const PG_USER = 'vahi_dev1_app';
const IMPORT_SQL = 'DROP TABLE `t`;';

/** One destructive tool driven through the prompt: the args it takes, the name the human types,
 *  and the single panel write it is allowed to make. `postgresql` picks the plan that has it. */
interface DestructiveCase {
  tool: string;
  args: Record<string, unknown>;
  typed: string;
  postgresql?: boolean;
  write: { method: string; path: string; multipart?: boolean };
}

describe('createServer', () => {
  it('lists tools with risk annotations and hides writes in read-only mode', async () => {
    const full = await connect();
    const list = await full.client.listTools();
    const del = list.tools.find((t) => t.name === 'website_delete');
    expect(del?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(list.tools.find((t) => t.name === 'website_get')?.annotations).toMatchObject({ readOnlyHint: true });
    // Claude Code reads this to require user approval before the call is made at all.
    expect(del?._meta).toMatchObject({ 'anthropic/requiresUserInteraction': true });
    const confirm = list.tools.find((t) => t.name === 'confirm_action');
    expect(confirm?._meta).toMatchObject({ 'anthropic/requiresUserInteraction': true });
    // Schemas with .transform() convert only under io:'input'; domain_check has one.
    expect((list.tools.find((t) => t.name === 'domain_check')?.inputSchema as { properties: Record<string, unknown> }).properties).toHaveProperty('domain');
    const ro = await connect({ readOnly: true });
    const names = (await ro.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('website_get');
    expect(names).not.toContain('website_delete');
    expect(names).not.toContain('ssh_key_add');
    expect(names).not.toContain('confirm_action');
  });

  it('runs a read tool and returns identity plus structured content', async () => {
    const { call } = await connect();
    const r = await call('website_get', { website: 'vahi.dev' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`website: vahi.dev (${WEBSITE_ID})`);
    expect((r.structured as { home: string }).home).toBe(`/var/www/${WEBSITE_ID}`);
  });

  it('audits a create whose outcome is unknown as unknown, not as an error', async () => {
    // An unknown create may have landed: an audit line saying "error" would tell whoever reads the
    // trail later that nothing happened, which is the one thing this outcome cannot promise.
    const dbsPath = `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/mysql-dbs`;
    const { call, auditLines } = await connect({ routes: [...writeThenList({ writePath: dbsPath, listPath: dbsPath, before: { items: [] }, after: { items: [] }, write: () => { throw new TypeError('fetch failed'); } }), ...base()] });
    const r = await call('db_create', { website: 'vahi.dev', name: 'demo' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('OUTCOME UNKNOWN');
    expect(JSON.parse(auditLines.at(-1)!)).toMatchObject({ tool: 'db_create', risk: 'write', outcome: 'unknown', message: expect.stringContaining('OUTCOME UNKNOWN') });
  });

  it('turns tool errors into isError results with suggestions', async () => {
    const { call } = await connect();
    const r = await call('website_get', { website: 'vahi.de' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Closest matches: vahi.dev');
  });

  it('without elicitation: a destructive call returns a preview and token, nothing is deleted, confirm_action executes', async () => {
    const { call, f, auditLines } = await connect();
    const first = await call('website_delete', { website: 'vahi.dev' });
    expect(first.isError).toBe(false);
    expect(first.text).toContain('NOT EXECUTED');
    expect(first.text).toContain('soft-delete');
    const token = (first.structured as { confirmation_token: string }).confirmation_token;
    expect(token.split('.')).toHaveLength(3);
    expect(f.calls.some((c) => c.method === 'DELETE')).toBe(false);

    const wrong = await call('confirm_action', { confirmation_token: token, confirm_target: 'vahi.com' });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain('does not match');
    expect(f.calls.some((c) => c.method === 'DELETE')).toBe(false);

    const done = await call('confirm_action', { confirmation_token: token, confirm_target: 'VAHI.dev' });
    expect(done.isError).toBe(false);
    expect(done.text).toContain('soft-deleted');
    expect(f.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    const audit = auditLines.map((l) => JSON.parse(l) as { tool: string; gate: string; outcome: string });
    expect(audit.at(-1)).toMatchObject({ tool: 'website_delete', gate: 'token', outcome: 'ok' });

    const reuse = await call('confirm_action', { confirmation_token: token, confirm_target: 'vahi.dev' });
    expect(reuse.isError).toBe(true);
    expect(reuse.text).toContain('already used');
  });

  it('confirm_action refuses when the name now points at a different record', async () => {
    const OTHER_ID = '2ec0e1a1-9d1b-4f24-8c3a-77b0c3f7ab19';
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    let recreated = false;
    const { call, f, ctx, auditLines } = await connect({
      routes: [
        { method: 'GET', path: `/orgs/${ORG_ID}/websites`, handler: () => json(recreated ? { items: [{ ...websiteSummary, id: OTHER_ID }], total: 1 } : websitesList) },
        { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: websiteDetail },
        { method: 'GET', path: `/orgs/${ORG_ID}/websites/${OTHER_ID}`, body: { ...websiteDetail, id: OTHER_ID } },
        { method: 'DELETE', path: /^\/orgs\/[^/]+\/websites\/[^/]+$/, status: 204 },
      ],
    });
    const first = await call('website_delete', { website: 'vahi.dev' });
    const token = (first.structured as { confirmation_token: string }).confirmation_token;

    // The site is deleted and recreated elsewhere: same domain, new id.
    recreated = true;
    ctx.resolver.invalidate();

    const r = await call('confirm_action', { confirmation_token: token, confirm_target: 'vahi.dev' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('target changed');
    expect(f.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(JSON.parse(auditLines.at(-1)!)).toMatchObject({ tool: 'website_delete', gate: 'token', outcome: 'error' });
  });

  // Both declarations must reach the human. A bare `{ elicitation: {} }` is what the shipping
  // Claude Code sends, and the old `elicitInput` path refused it outright.
  for (const caps of ['bare', 'form'] as const) {
    it(`with ${caps} elicitation capability: the server asks the human directly and executes on an exact match`, async () => {
      const seen: string[] = [];
      const { call, f, auditLines } = await connect({ caps, elicit: (msg) => { seen.push(msg); return { action: 'accept', content: { confirm_name: 'Vahi.Dev' } }; } });
      const r = await call('website_delete', { website: 'vahi.dev' });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('soft-delete');
      expect(seen[0]).toContain('Type the name "vahi.dev"');
      expect(r.isError).toBe(false);
      expect(r.text).toContain('soft-deleted');
      expect(r.text).not.toContain('confirmation_token');
      expect(f.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
      expect(JSON.parse(auditLines.at(-1)!)).toMatchObject({ tool: 'website_delete', gate: 'elicitation', outcome: 'ok' });
    });
  }

  it('with elicitation: decline, cancel and a wrong name never execute', async () => {
    for (const caps of ['bare', 'form'] as const) {
      for (const answer of [{ action: 'decline' as const }, { action: 'cancel' as const }, { action: 'accept' as const, content: { confirm_name: 'vahi.com' } }]) {
        const { call, f, auditLines } = await connect({ caps, elicit: () => answer });
        const r = await call('website_delete', { website: 'vahi.dev' });
        expect(r.isError).toBe(false);
        expect(r.text).toMatch(/cancelled|did not match/);
        expect(f.calls.some((c) => c.method === 'DELETE')).toBe(false);
        expect(JSON.parse(auditLines.at(-1)!)).toMatchObject({ tool: 'website_delete', gate: 'elicitation', outcome: 'cancelled' });
      }
    }
  });

  it('on the 2026-07-28 era the prompt still reaches the human, where a server-to-client request could not', async () => {
    const seen: string[] = [];
    const { call, f, auditLines, close } = await connectModern((msg) => { seen.push(msg); return { action: 'accept', content: { confirm_name: 'Vahi.Dev' } }; });
    try {
      const r = await call('website_delete', { website: 'vahi.dev' });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('Type the name "vahi.dev"');
      expect(r.isError).toBe(false);
      expect(r.text).toContain('soft-deleted');
      expect(f.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
      expect(JSON.parse(auditLines.at(-1)!)).toMatchObject({ tool: 'website_delete', gate: 'elicitation', outcome: 'ok' });
    } finally {
      await close();
    }
  });

  it('audits every confirm_action failure exit, without ever logging the token', async () => {
    const { call, f, auditLines } = await connect();
    const token = (await call('website_delete', { website: 'vahi.dev' })).structured as { confirmation_token: string };
    const last = () => JSON.parse(auditLines.at(-1)!) as Record<string, unknown>;

    // Mismatch: the human typed the wrong thing. Cancelled, not an error; the token survives.
    const wrong = await call('confirm_action', { confirmation_token: token.confirmation_token, confirm_target: 'vahi.com' });
    expect(wrong.isError).toBe(true);
    expect(last()).toMatchObject({ tool: 'confirm_action', risk: 'destructive', gate: 'token', outcome: 'cancelled', args: { confirm_target: 'vahi.com' } });
    expect(JSON.stringify(last())).not.toContain(token.confirmation_token);

    // A UUID is never accepted as confirmation — also a cancellation.
    const uuid = await call('confirm_action', { confirmation_token: token.confirmation_token, confirm_target: WEBSITE_ID });
    expect(uuid.isError).toBe(true);
    expect(last()).toMatchObject({ tool: 'confirm_action', gate: 'token', outcome: 'cancelled' });
    expect(f.calls.some((c) => c.method === 'DELETE')).toBe(false);

    // The token was still valid through both refusals.
    const done = await call('confirm_action', { confirmation_token: token.confirmation_token, confirm_target: 'vahi.dev' });
    expect(done.isError).toBe(false);
    expect(f.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);

    const reuse = await call('confirm_action', { confirmation_token: token.confirmation_token, confirm_target: 'vahi.dev' });
    expect(reuse.isError).toBe(true);
    expect(last()).toMatchObject({ tool: 'confirm_action', gate: 'token', outcome: 'error', args: { confirm_target: 'vahi.dev' } });

    const malformed = await call('confirm_action', { confirmation_token: 'not-a-real-token', confirm_target: 'vahi.dev' });
    expect(malformed.isError).toBe(true);
    expect(malformed.text).toContain('malformed');
    expect(last()).toMatchObject({ tool: 'confirm_action', gate: 'token', outcome: 'error' });
  });

  /**
   * Never-exposed guard. Platform, org and credential administration is out of scope for the
   * customer tier and must stay unregistered; matching on whole name segments rather than raw
   * substrings so the legitimate `domain_cloudflare_nameservers` is not a false positive.
   */
  it('registers no platform, org or credential administration tool', () => {
    const forbidden = /(^|_)(servers?|settings?|licences?|licenses?|members?|owners?|purge|bulk)(_|$)|(token_create|org_delete|subscription_delete)|(^|_)(orgs?|subscriptions?|websites)_(delete|remove)(_|$)/;
    expect(allTools.filter((t) => forbidden.test(t.name)).map((t) => t.name)).toEqual([]);
    // The plural is the bulk endpoint (`DELETE /orgs/{id}/websites` with a body of UUIDs) and the
    // singular is the one gated tool this server does expose, so the guard must separate them.
    expect(forbidden.test('websites_delete')).toBe(true);
    expect(forbidden.test('website_delete')).toBe(false);
  });

  it('every destructive tool defines target() and preview()', () => {
    const destructive = allTools.filter((t) => t.risk === 'destructive');
    expect(destructive).not.toHaveLength(0);
    for (const t of destructive) {
      expect(t.target, `${t.name} target`).toBeTypeOf('function');
      expect(t.preview, `${t.name} preview`).toBeTypeOf('function');
    }
  });

  it('with ENHANCE_READ_ONLY=1 no write or destructive tool is listed', async () => {
    const ro = await connect({ env: { ENHANCE_READ_ONLY: '1' } });
    const names = (await ro.client.listTools()).tools.map((t) => t.name);
    const writes = new Set(allTools.filter((t) => t.risk !== 'read').map((t) => t.name));
    expect(names.filter((n) => writes.has(n))).toEqual([]);
    // With nothing destructive registered there is nothing to confirm either.
    expect(names).not.toContain('confirm_action');
    expect(names).toEqual(expect.arrayContaining(['db_list', 'php_extensions_list', 'cron_get', 'ip_rules_get']));
  });

  /**
   * Every destructive tool, driven end to end through the bare `{ elicitation: {} }` capability
   * Claude Code declares: exactly one panel write, on the method and path for the resolved target,
   * never with a force flag, and one audit line recording that a human answered the prompt.
   */
  const sitePath = `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`;

  /** The fixture site is on a plan without PostgreSQL (`canUse.postgresql: false`), which is what
   *  the live panel returns; the pg_* tools refuse outright on it, so those cases run against the
   *  same site on a plan that includes it. */
  const pgEnabled = { ...websiteDetail, canUse: { ...websiteDetail.canUse, postgresql: true } };

  /** Spelled out rather than spreading `base()`: fakeFetch takes the *first* matching route, and
   *  the site-detail GET here is the one overridden for the PostgreSQL cases, so a spread base()
   *  ahead of it would shadow the override with the plan that has `canUse.postgresql: false`. */
  const destructiveRoutes = (postgresql = false): Route[] => [
    { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: websitesList },
    { method: 'GET', path: sitePath, body: postgresql ? pgEnabled : websiteDetail },
    { method: 'GET', path: `${sitePath}/domains`, body: domainMappings },
    { method: 'GET', path: `${sitePath}/ssh/keys`, body: sshKeys },
    { method: 'DELETE', path: sitePath, status: 204 },
    { method: 'DELETE', path: `${sitePath}/domains/${PREVIEW_DOMAIN_ID}`, status: 204 },
    { method: 'DELETE', path: `${sitePath}/ssh/keys/0`, status: 204 },
    { method: 'DELETE', path: `${sitePath}/mysql-dbs/${MYSQL_DB}`, status: 204 },
    { method: 'DELETE', path: `${sitePath}/mysql-users/${MYSQL_USER}`, status: 204 },
    { method: 'POST', path: `/v2/websites/${WEBSITE_ID}/mysql/${MYSQL_DB}/sql`, status: 204 },
    { method: 'DELETE', path: `${sitePath}/crontab`, status: 204 },
    { method: 'GET', path: `/websites/${WEBSITE_ID}/apps/persistent`, body: persistentApps },
    { method: 'DELETE', path: `/websites/${WEBSITE_ID}/apps/persistent/${APP_ID}`, status: 200 },
    { method: 'DELETE', path: `${sitePath}/postgresql-dbs/${PG_DB}`, status: 204 },
    { method: 'DELETE', path: `${sitePath}/postgresql-users/${PG_USER}`, status: 204 },
    { method: 'DELETE', path: `${sitePath}/postgresql-users/${PG_USER}/privileges/${PG_DB}`, status: 204 },
  ];

  const destructiveCases: DestructiveCase[] = [
    { tool: 'website_delete', args: { website: 'vahi.dev' }, typed: 'vahi.dev', write: { method: 'DELETE', path: sitePath } },
    { tool: 'domain_remove', args: { website: 'vahi.dev', domain: 'vahi-dev-ccyq.sgp1.mystaging.site' }, typed: 'vahi-dev-ccyq.sgp1.mystaging.site', write: { method: 'DELETE', path: `${sitePath}/domains/${PREVIEW_DOMAIN_ID}` } },
    { tool: 'ssh_key_remove', args: { website: 'vahi.dev', key: '0' }, typed: 'vahi.dev', write: { method: 'DELETE', path: `${sitePath}/ssh/keys/0` } },
    { tool: 'db_delete', args: { website: 'vahi.dev', name: 'demo' }, typed: MYSQL_DB, write: { method: 'DELETE', path: `${sitePath}/mysql-dbs/${MYSQL_DB}` } },
    { tool: 'db_user_delete', args: { website: 'vahi.dev', username: 'app' }, typed: MYSQL_USER, write: { method: 'DELETE', path: `${sitePath}/mysql-users/${MYSQL_USER}` } },
    // The one destructive tool whose panel write is not a DELETE: a multipart POST carrying the SQL.
    { tool: 'db_import_sql', args: { website: 'vahi.dev', name: 'demo', sql: IMPORT_SQL }, typed: MYSQL_DB, write: { method: 'POST', path: `/v2/websites/${WEBSITE_ID}/mysql/${MYSQL_DB}/sql`, multipart: true } },
    { tool: 'cron_delete', args: { website: 'vahi.dev' }, typed: 'vahi.dev', write: { method: 'DELETE', path: `${sitePath}/crontab` } },
    { tool: 'persistent_app_delete', args: { website: 'vahi.dev', app_id: APP_ID }, typed: 'vahi.dev', write: { method: 'DELETE', path: `/websites/${WEBSITE_ID}/apps/persistent/${APP_ID}` } },
    { tool: 'pg_db_delete', args: { website: 'vahi.dev', name: 'shop' }, typed: PG_DB, postgresql: true, write: { method: 'DELETE', path: `${sitePath}/postgresql-dbs/${PG_DB}` } },
    { tool: 'pg_user_delete', args: { website: 'vahi.dev', username: 'app' }, typed: PG_USER, postgresql: true, write: { method: 'DELETE', path: `${sitePath}/postgresql-users/${PG_USER}` } },
    { tool: 'pg_user_revoke', args: { website: 'vahi.dev', username: 'app', database: 'shop' }, typed: PG_USER, postgresql: true, write: { method: 'DELETE', path: `${sitePath}/postgresql-users/${PG_USER}/privileges/${PG_DB}` } },
  ];

  /**
   * The real invariant, on every request rather than only on the DELETEs: the panel's purge
   * (`?force=true`, which wipes a website's data outright and needs a privileged master-org
   * member), its `?purge=` sibling and the master-org-only `?showDeleted=` are never sent at all,
   * whatever the method. Deliberately not a ban on the `force` substring everywhere — it appears
   * once in the codebase, as `db_import_sql`'s continue-on-error flag (the mysql CLI's --force),
   * and that rides only on the POST carrying the SQL. Anything else carrying one of these flags,
   * on any method, is a bug in a tool.
   */
  const IMPORT_SQL_PATH = /^\/v2\/websites\/[^/]+\/mysql\/[^/]+\/sql/;
  const expectNoDangerousFlags = (f: Pick<FakeFetch, 'calls'>) => {
    expect(f.calls.filter((x) => /[?&](purge|showDeleted)=/.test(x.path)).map((x) => `${x.method} ${x.path}`)).toEqual([]);
    expect(f.calls.filter((x) => /[?&]force=/.test(x.path) && !(x.method === 'POST' && IMPORT_SQL_PATH.test(x.path))).map((x) => `${x.method} ${x.path}`)).toEqual([]);
  };

  it('the dangerous-flag guard would catch a purge, a showDeleted listing and a forced delete', () => {
    const call = (method: string, path: string) => ({ method, path, headers: new Headers() });
    for (const bad of [call('DELETE', `/orgs/x/websites/y?force=true`), call('DELETE', '/orgs/x/websites/y?purge=true'), call('GET', '/orgs/x/websites?showDeleted=true')]) {
      expect(() => expectNoDangerousFlags({ calls: [bad] })).toThrow();
    }
    // ...and still lets db_import_sql's own continue-on-error flag through.
    expect(() => expectNoDangerousFlags({ calls: [call('POST', `/v2/websites/${WEBSITE_ID}/mysql/${MYSQL_DB}/sql?force=true`)] })).not.toThrow();
  });

  it('drives every registered destructive tool through the cases below', () => {
    expect(destructiveCases.map((c) => c.tool).sort()).toEqual(allTools.filter((t) => t.risk === 'destructive').map((t) => t.name).sort());
  });

  for (const c of destructiveCases) {
    it(`${c.tool} runs one ${c.write.method} on the resolved target through the bare elicitation prompt`, async () => {
      const seen: string[] = [];
      const { call, f, auditLines } = await connect({
        caps: 'bare',
        routes: destructiveRoutes(c.postgresql),
        elicit: (msg) => { seen.push(msg); return { action: 'accept', content: { confirm_name: c.typed } }; },
      });
      const r = await call(c.tool, c.args);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain(`Type the name "${c.typed}"`);
      expect(r.isError).toBe(false);
      // Everything the resolver and the previews read is a GET, so the writes are what is left.
      const writes = f.calls.filter((x) => x.method !== 'GET');
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ method: c.write.method, path: c.write.path });
      if (c.write.multipart) {
        expect(writes[0]?.headers.get('content-type')).toMatch(/^multipart\/form-data/);
        expect(writes[0]?.body).toContain(IMPORT_SQL);
      }
      expectNoDangerousFlags(f);
      expect(JSON.parse(auditLines.at(-1)!)).toMatchObject({ tool: c.tool, gate: 'elicitation', outcome: 'ok' });
    });
  }

  it('website_delete through the gate sends one plain DELETE, never the panel purge', async () => {
    const { call, f } = await connect({ caps: 'bare', routes: destructiveRoutes(), elicit: () => ({ action: 'accept', content: { confirm_name: 'vahi.dev' } }) });
    const r = await call('website_delete', { website: 'vahi.dev' });
    expect(r.isError).toBe(false);
    expect(f.calls.filter((x) => x.method === 'DELETE').map((x) => x.path)).toEqual([sitePath]);
    expectNoDangerousFlags(f);
  });

  it("db_import_sql's own force flag rides on its POST, and the guard above still holds", async () => {
    const { call, f } = await connect({ caps: 'bare', routes: destructiveRoutes(), elicit: () => ({ action: 'accept', content: { confirm_name: MYSQL_DB } }) });
    const r = await call('db_import_sql', { website: 'vahi.dev', name: 'demo', sql: IMPORT_SQL, force: true });
    expect(r.isError).toBe(false);
    const writes = f.calls.filter((x) => x.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'POST', path: `/v2/websites/${WEBSITE_ID}/mysql/${MYSQL_DB}/sql?force=true` });
    expectNoDangerousFlags(f);
  });

  it('db_delete with the wrong name typed drops nothing and audits a cancellation', async () => {
    const { call, f, auditLines } = await connect({
      caps: 'bare',
      routes: destructiveRoutes(),
      elicit: () => ({ action: 'accept', content: { confirm_name: 'wrong-name' } }),
    });
    const r = await call('db_delete', { website: 'vahi.dev', name: 'demo' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('did not match');
    expect(f.calls.some((x) => x.method !== 'GET')).toBe(false);
    expect(JSON.parse(auditLines.at(-1)!)).toMatchObject({ tool: 'db_delete', gate: 'elicitation', outcome: 'cancelled' });
  });
});
