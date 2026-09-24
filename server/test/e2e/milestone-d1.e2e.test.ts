import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import type { ToolContext } from '../../src/core/context.js';
import { listSiteFiles } from '../../src/core/files.js';
import type { ToolDef, ToolResult } from '../../src/core/registry.js';
import { pathPreflight } from '../../src/tools/apps.js';

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

  it('a clash refusal names what is on disk and registers nothing', async () => {
    const w = await ctx.resolver.resolveWebsite(site);
    const docroot = w.domain.documentRoot;
    const { entries } = await listSiteFiles(ctx, w, { levels: docroot.split('/').length + 1 });
    // A dot folder such as .well-known is not a proxy path the panel accepts, so the create would be
    // refused by validation before the clash guard ever ran.
    const folder = entries.find((e) => e.kind === 'dir' && e.path.startsWith(`${docroot}/`) && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(e.path.slice(docroot.length + 1)));
    expect(folder, `the test site needs one folder directly in ${docroot} (vahi.dev has demo-login)`).toBeTruthy();
    const name = folder!.path.slice(docroot.length + 1);
    // Belt and braces: the create is only called when HTTP already calls the path taken, so this
    // test can never register an app or restart the container.
    const pre = await pathPreflight(ctx, w, name);
    expect(pre.taken, `HTTP must call /${name} taken before this test may try to register it (${pre.detail})`).toBe(true);
    const list = tool(tools, 'persistent_apps_list');
    const ids = async (): Promise<string[]> => ((await call(ctx, list, { website: site })).structured as { items: Array<{ id: string }> }).items.map((i) => i.id);
    const before = await ids();
    const r = await call(ctx, tool(tools, 'persistent_app_create'), { website: site, command: 'node never-registered.js', proxy_path: name, port: 39999 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`${docroot}/${name} is an existing folder`);
    expect(await ids()).toEqual(before);
  });
});

createSuite('milestone D1: website_create lands and is reported, even when the client gives up early', () => {
  let ctx: ToolContext;
  let tools: ToolDef[];
  let impatient: { ctx: ToolContext; tools: ToolDef[] };
  const domains: string[] = [];

  beforeAll(async () => {
    ({ ctx, tools } = await bootstrap(process.env));
    // A client that stops waiting after 3 s while the panel keeps creating: the unclear write the
    // helper exists for, forced instead of hoped for.
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
