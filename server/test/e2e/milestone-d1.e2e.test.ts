import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import type { ToolContext } from '../../src/core/context.js';
import { listSiteFiles } from '../../src/core/files.js';
import { httpsProbe, type HttpProbe } from '../../src/core/probe.js';
import type { ToolDef, ToolResult } from '../../src/core/registry.js';
import { PROXY_PATH_RE, pathPreflight } from '../../src/tools/apps.js';

const enabled = process.env['ENHANCE_E2E'] === '1';
const suite = enabled ? describe : describe.skip;
const createSuite = enabled && process.env['ENHANCE_E2E_CREATE'] === '1' ? describe : describe.skip;

function tool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

async function call<A>(ctx: ToolContext, t: ToolDef<A>, args: unknown): Promise<ToolResult> {
  return t.handler(t.input.parse(args), ctx);
}

/** A JWT anywhere in a result means the site token leaked. */
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;

suite('milestone D1 against the live panel (read-only)', () => {
  let ctx: ToolContext;
  let tools: ToolDef[];
  let site: string;

  beforeAll(async () => {
    ({ ctx, tools } = await bootstrap(process.env));
    site = process.env['ENHANCE_E2E_SITE'] ?? '';
    expect(site, 'ENHANCE_E2E_SITE must name an existing website with the file manager on its plan (e.g. vahi.dev)').toBeTruthy();
  });

  it('the file service still answers in the shape core/files.ts validates', async () => {
    const w = await ctx.resolver.resolveWebsite(site);
    const { levels, entries } = await listSiteFiles(ctx, w, { levels: 2 });
    expect(levels).toBe(2);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.find((e) => e.path === w.domain.documentRoot)?.kind).toBe('dir');
    for (const e of entries) {
      expect(['file', 'dir', 'symlink']).toContain(e.kind);
      expect(e.path.startsWith('/')).toBe(false);
      expect(e.path.split('/').length).toBeLessThanOrEqual(2);
      expect(typeof e.size).toBe('number');
      expect(typeof e.modified).toBe('number');
      expect(typeof e.mode).toBe('number');
    }
    // Only folders on the last level asked for are left unopened.
    expect(entries.filter((e) => e.unexpanded).every((e) => e.kind === 'dir' && e.path.split('/').length === 2)).toBe(true);
  });

  it('files_list shows the document root with honest totals and never the site token', async () => {
    const r = await call(ctx, tool(tools, 'files_list'), { website: site });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/^org: /);
    expect(r.text).toMatch(/entries: \d+ found, \d+ shown/);
    expect(r.text).not.toMatch(JWT_RE);
    expect(JSON.stringify(r.structured)).not.toMatch(JWT_RE);
  });

  it('a clash refusal names what is on disk, never shows the site token and registers nothing', async () => {
    const w = await ctx.resolver.resolveWebsite(site);
    const docroot = w.domain.documentRoot;
    const { entries } = await listSiteFiles(ctx, w, { levels: docroot.split('/').length + 1 });
    // Folders directly in the document root whose name the panel would accept as a proxy path (no
    // dot folder such as .well-known, which validation refuses before the clash guard runs), in
    // name order with demo-login first, so every run tries the same folder.
    const candidates = entries
      .filter((e) => e.kind === 'dir' && e.path.startsWith(`${docroot}/`))
      .map((e) => e.path.slice(docroot.length + 1))
      .filter((n) => !n.includes('/') && !n.startsWith('.') && !n.includes('..') && PROXY_PATH_RE.test(n))
      .sort((a, b) => (a === 'demo-login' ? -1 : b === 'demo-login' ? 1 : a < b ? -1 : a > b ? 1 : 0));
    expect(candidates.length, `the test site needs one folder directly in ${docroot} (vahi.dev has demo-login)`).toBeGreaterThan(0);
    // Prefer a folder that answers non-404 on BOTH forms (demo-login: 301 on the bare path, 200 with
    // the slash), so the create's own preflight still sees it taken if one of its fetches fails.
    const ip = (w.serverIps?.find((x) => x.isPrimary) ?? w.serverIps?.[0])?.ip;
    expect(ip, `${site} has no server IP recorded, so its paths cannot be probed`).toBeTruthy();
    const status = (path: string): Promise<number | undefined> =>
      httpsProbe({ ip: ip!, host: w.domain.domain, path, timeoutMs: 5000, maxBodyBytes: 512 }).then(
        (res) => res.status,
        () => undefined,
      );
    let name: string | undefined;
    for (const n of candidates) {
      const both = await Promise.all([status(`/${n}`), status(`/${n}/`)]);
      if (both.every((s) => s !== undefined && s !== 404)) {
        name = n;
        break;
      }
    }
    name ??= candidates[0]!;
    // What keeps this test from registering an app, which would restart the container and shadow a
    // live folder:
    // 1. HTTP must call the path taken before the create is tried at all;
    // 2. the create runs with a fail-closed probe: a fetch that throws counts as taken (HTTP 599)
    //    instead of "could not be checked", which the real preflight lets through to the write;
    // 3. whatever still slips through is deleted in the finally below, and the test fails naming it.
    const failClosedProbe: HttpProbe = async (req) => {
      try {
        return await httpsProbe(req);
      } catch {
        return { status: 599, latencyMs: 0, contentType: null, body: '', certificate: 'error:probe failed', location: null };
      }
    };
    const failClosed: ToolContext = { ...ctx, httpProbe: failClosedProbe };
    const pre = await pathPreflight(failClosed, w, name);
    expect(pre.taken, `HTTP must call /${name} taken before this test may try to register it (${pre.detail})`).toBe(true);
    const list = tool(tools, 'persistent_apps_list');
    type Row = { id: string; command: string };
    const rows = async (): Promise<Row[]> => ((await call(ctx, list, { website: site })).structured as { items: Row[] }).items;
    const before = (await rows()).map((a) => a.id);
    const command = 'node never-registered.js';
    let r: ToolResult;
    try {
      r = await call(failClosed, tool(tools, 'persistent_app_create'), { website: site, command, proxy_path: name, port: 39999 });
    } finally {
      // Bypasses the gate on purpose, and only for an app this call registered: new since `before`
      // and running this test's command (the milestone A precedent for what a run itself made).
      const leaked = (await rows()).filter((a) => !before.includes(a.id) && a.command === command);
      const failures: string[] = [];
      for (const app of leaked) {
        try {
          const del = tool(tools, 'persistent_app_delete');
          const args = del.input.parse({ website: site, app_id: app.id });
          const target = await del.target!(args, ctx);
          if (!target.id.endsWith(`:${app.id}`)) throw new Error(`the delete resolved ${target.id}`);
          await del.handler(args, ctx, target);
        } catch (e) {
          failures.push(`${app.id} (${(e as Error).message})`);
        }
      }
      if (leaked.length > 0) {
        throw new Error(`persistent_app_create REGISTERED ${leaked.map((a) => a.id).join(', ')} on ${site} at /${name} although the path was taken; ${failures.length > 0 ? `could not delete ${failures.join('; ')}: delete it by hand` : 'it was deleted again'}`);
      }
    }
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`${docroot}/${name} is an existing folder`);
    // The on-disk line minted a site token to read the listing; it must not show anywhere.
    expect(r.text).not.toMatch(JWT_RE);
    expect(JSON.stringify(r.structured)).not.toMatch(JWT_RE);
    expect((await rows()).map((a) => a.id)).toEqual(before);
  });
});

createSuite('milestone D1: website_create lands and is reported, even when the client gives up early', () => {
  let ctx: ToolContext;
  let tools: ToolDef[];
  let impatient: { ctx: ToolContext; tools: ToolDef[] };
  const domains: string[] = [];

  beforeAll(async () => {
    ({ ctx, tools } = await bootstrap(process.env));
    // A client that stops waiting after 3 s while the panel keeps creating, meant to force the
    // unclear write the helper exists for. On 2026-09-24 the panel answered all three creates inside
    // 3 s, so that run did not exercise it; the unclear path was proven by a separate forced check
    // (see "Live test D1" in docs/research.md). Every create must still end as created.
    impatient = await bootstrap({ ...process.env, ENHANCE_TIMEOUT_MS: '3000' });
  });

  afterAll(async () => {
    // Cleanup bypasses the confirmation gate on purpose, for the sites this run created and nothing
    // else (the milestone A precedent). Each domain is re-checked, so a create that ended "unknown"
    // is still found and removed.
    const del = tool(tools, 'website_delete');
    for (const d of domains) {
      try {
        const check = (await call(ctx, tool(tools, 'domain_check'), { domain: d })).structured as { status: string; websiteId: string | null };
        if (check.status !== 'inUseCurrentOrg' || !check.websiteId) continue;
        const args = del.input.parse({ website: check.websiteId });
        const target = await del.target!(args, ctx);
        if (target.name === d) await del.handler(args, ctx, target);
      } catch (e) {
        console.error(`cleanup of ${d} failed: ${(e as Error).message}`);
      }
    }
  });

  it('three parallel creates, two of them on a 3 s client timeout, all end as created', async () => {
    const parent = process.env['ENHANCE_E2E_PARENT_DOMAIN'] ?? process.env['ENHANCE_E2E_SITE'] ?? '';
    const subscription = Number(process.env['ENHANCE_E2E_SUBSCRIPTION_ID']);
    expect(parent, 'ENHANCE_E2E_PARENT_DOMAIN (or ENHANCE_E2E_SITE) names the domain the throwaway subdomains go under').toBeTruthy();
    expect(subscription, 'ENHANCE_E2E_SUBSCRIPTION_ID must name a subscription with free website quota').toBeGreaterThan(0);
    const tag = randomBytes(3).toString('hex');
    domains.push(...[1, 2, 3].map((i) => `d1-${tag}-${i}.${parent}`));
    const results = await Promise.all(domains.map((domain, i) => (i === 0 ? call(ctx, tool(tools, 'website_create'), { domain, subscription_id: subscription }) : call(impatient.ctx, tool(impatient.tools, 'website_create'), { domain, subscription_id: subscription }))));
    for (const [i, r] of results.entries()) {
      console.log(`${domains[i]}: confirmedBy=${(r.structured as { confirmedBy?: string } | undefined)?.confirmedBy ?? '-'} ${r.text.split('\n').find((l) => /confirmed by reading|OUTCOME UNKNOWN/.test(l)) ?? ''}`);
      expect(r.isError, r.text).toBeFalsy();
      expect(r.structured).toMatchObject({ created: true });
    }
  });
});
