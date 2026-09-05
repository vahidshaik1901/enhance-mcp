import { Client, type ClientOptions, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { describe, expect, it } from 'vitest';
import { selectTools } from '../../src/core/registry.js';
import { createServer } from '../../src/server.js';
import { allTools } from '../../src/tools/index.js';
import { makeContext } from '../helpers/context.js';
import type { Route } from '../helpers/fakeFetch.js';
import { domainMappings, ORG_ID, WEBSITE_ID, websiteDetail, websitesList, websiteSummary } from '../fixtures/panel.js';

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

async function connect(opts: { readOnly?: boolean; elicit?: (msg: string) => ElicitAnswer; caps?: Caps; routes?: Route[] } = {}) {
  const t = await makeContext(opts.routes ?? base());
  const tools = selectTools(allTools, { tiers: ['customer'], readOnly: opts.readOnly ?? false });
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
});
