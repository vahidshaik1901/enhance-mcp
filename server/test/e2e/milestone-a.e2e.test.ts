import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { requireOrg, type ToolContext } from '../../src/core/context.js';
import { GateError } from '../../src/core/gate.js';
import type { ToolDef, ToolResult } from '../../src/core/registry.js';
import { assertRequired } from './contract.js';

const enabled = process.env['ENHANCE_E2E'] === '1';
const suite = enabled ? describe : describe.skip;

function tool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

function sshPublicKey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = der.subarray(der.length - 32);
  const type = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([Buffer.from([0, 0, 0, type.length]), type, Buffer.from([0, 0, 0, 32]), raw]);
  return `ssh-ed25519 ${blob.toString('base64')} enhance-mcp-e2e`;
}

suite('milestone A against the live panel', () => {
  let ctx: ToolContext;
  let tools: ToolDef[];
  let domain: string;
  let websiteId: string | undefined;
  const subscriptionId = Number(process.env['ENHANCE_E2E_SUBSCRIPTION_ID']);

  // Live suite only: call tools directly against the live-panel `ctx`, without pulling in the
  // fake-panel test helpers (test/helpers/context.ts) that the unit suite's `callTool` depends on.
  async function call<A>(t: ToolDef<A>, args: unknown): Promise<ToolResult> {
    return t.handler(t.input.parse(args), ctx);
  }

  /**
   * Every test after website_create must address the site by the UUID this run actually
   * created, never by `domain` (a human-typed name the resolver maps to whatever site
   * currently owns it). If `ENHANCE_E2E_DOMAIN` names a pre-existing site, or website_create
   * failed to set `websiteId`, calling by name would let this suite write an SSH key to,
   * change PHP on, or soft-delete a site it never created. Refuse instead.
   */
  const createdId = (): string => {
    expect(websiteId, 'no throwaway site was created by this run; refusing to touch anything').toBeTruthy();
    return websiteId!;
  };

  beforeAll(async () => {
    ({ ctx, tools } = await bootstrap(process.env));
    domain = process.env['ENHANCE_E2E_DOMAIN'] || `mcp-e2e-${Math.random().toString(36).slice(2, 8)}.test`;
    expect(Number.isInteger(subscriptionId), 'ENHANCE_E2E_SUBSCRIPTION_ID must be set').toBe(true);
  });

  afterAll(async () => {
    const del = tool(tools, 'website_delete');
    if (websiteId) {
      // Cleanup deliberately bypasses the confirmation gate: it calls website_delete's
      // target()/handler() directly by id rather than going through gate.issue/verify, and it
      // only ever targets `websiteId` -- the id this run's own website_create call produced.
      const args = del.input.parse({ website: websiteId });
      const target = await del.target!(args, ctx).catch(() => undefined);
      if (target) await del.handler(args, ctx, target);
      return;
    }
    // Orphan sweep: website_create may have thrown after its POST already created a real site
    // (e.g. a network timeout, or an assertion failing before `websiteId` was assigned), leaving
    // nothing to clean up by id. Look for it defensively, but only ever delete a website whose
    // domain both matches this run's randomly generated `mcp-e2e-<slug>.test` shape AND is an
    // exact match for this run's own `domain` -- never a site named after ENHANCE_E2E_DOMAIN
    // (which never matches that shape), and never anything else in the org.
    const list = await call(tool(tools, 'websites_list'), { limit: 200, offset: 0, search: 'mcp-e2e-' });
    const orphans = (list.structured as { items: Array<{ domain: string; id: string }> }).items.filter((w) => /^mcp-e2e-[a-z0-9]+\.test$/.test(w.domain) && w.domain === domain);
    for (const orphan of orphans) {
      const args = del.input.parse({ website: orphan.id });
      const target = await del.target!(args, ctx).catch(() => undefined);
      if (target) await del.handler(args, ctx, target);
    }
  });

  it('auth_status, platform_info and subscriptions_list answer with spec-shaped data', async () => {
    const a = await call(tool(tools, 'auth_status'), {});
    expect(a.isError).toBeFalsy();
    const p = await call(tool(tools, 'platform_info'), {});
    expect((p.structured as { nameServers: string[] }).nameServers.length).toBeGreaterThan(0);
    const s = await call(tool(tools, 'subscriptions_list'), {});
    expect(s.isError, s.text).toBeFalsy();
    // subscriptions_list's structured `items` are a projected subset (resources reshaped into a
    // map, several spec-required fields such as subscriberId/vendorId/friendlyName dropped), so
    // validate against the raw panel payload instead, per review.
    const org = requireOrg(ctx.client);
    const raw = await ctx.client.call('GET', '/orgs/{org_id}/subscriptions', () => ctx.client.api.GET('/orgs/{org_id}/subscriptions', { params: { path: { org_id: org } } }));
    for (const item of raw.items) assertRequired('Subscription', item);
  });

  it('domain_check says the throwaway domain is free', async () => {
    const r = await call(tool(tools, 'domain_check'), { domain });
    expect((r.structured as { status: string }).status).toBe('notInUse');
  });

  it('website_create creates the site and website_get returns spec-shaped detail', async () => {
    const r = await call(tool(tools, 'website_create'), { domain, subscription_id: subscriptionId });
    expect(r.isError, r.text).toBeFalsy();
    // `websiteId` is set on every success; `website` is null when only the tool's read-back of the
    // new site failed, so the id must not be taken from it.
    const s = r.structured as { websiteId: string; website: unknown };
    websiteId = s.websiteId;
    // `website` is the raw Website detail the panel returned (ctx.resolver.getWebsite), not a
    // projected subset, so it can be checked directly against the spec's Website schema.
    expect(s.website, 'website_create could not read the new site back').not.toBeNull();
    assertRequired('Website', s.website);
    const g = await call(tool(tools, 'website_get'), { website: createdId() });
    expect(g.text).toContain(`website: ${domain}`);
  });

  it('domains_list, dns status, dns records, ssl state work on the new site', async () => {
    createdId();
    const d = await call(tool(tools, 'domains_list'), { website: createdId() });
    expect(d.isError, d.text).toBeFalsy();
    // domains_list's structured items are a projected subset (renamed/omitted fields), so
    // validate the raw domain mapping objects instead, per review.
    const rawMappings = await ctx.resolver.listDomains(createdId());
    for (const m of rawMappings) assertRequired('DomainMapping', m);
    const s = await call(tool(tools, 'domain_dns_status'), { website: createdId() });
    expect(['Resolved', 'ForeignServer', 'Failed', 'Mixed', 'Unknown', 'Error']).toContain((s.structured as { status: string }).status);
    const recs = await call(tool(tools, 'domain_dns_records'), { website: createdId(), include_mail: 'no', include_extras: false });
    expect((recs.structured as { records: Array<{ kind: string; name: string }> }).records.some((x) => x.kind === 'A' && x.name === '@')).toBe(true);
    const ssl = await call(tool(tools, 'domain_ssl_get'), { website: createdId() });
    expect((ssl.structured as { placeholder: boolean }).placeholder).toBe(true);
  });

  it('website_preview_domain returns or creates a preview URL when the provider has one', async () => {
    createdId();
    const r = await call(tool(tools, 'website_preview_domain'), { website: createdId() });
    const s = r.structured as { available: boolean; previewDomain: string | null };
    if (s.available) expect(s.previewDomain).toMatch(/\./);
  });

  it('ssh_key_add is idempotent and ssh_key_remove works through the gate contract', async () => {
    createdId();
    const pub = sshPublicKey();
    const a = await call(tool(tools, 'ssh_key_add'), { website: createdId(), public_key: pub, name: 'e2e' });
    expect((a.structured as { added: boolean }).added).toBe(true);
    const b = await call(tool(tools, 'ssh_key_add'), { website: createdId(), public_key: pub });
    expect((b.structured as { added: boolean }).added).toBe(false);
    const info = await call(tool(tools, 'ssh_connection_info'), { website: createdId() });
    expect((info.structured as { keysUnavailable: boolean }).keysUnavailable).toBe(false);
    expect((info.structured as { keysAuthorized: number }).keysAuthorized).toBeGreaterThanOrEqual(1);
    // Resolve the website by id before touching keys, and confirm it's the site this run
    // created -- not whatever site the (human) domain name happens to resolve to right now.
    const g = await call(tool(tools, 'website_get'), { website: createdId() });
    expect((g.structured as { website: { id: string } }).website.id).toBe(createdId());
    const rm = tool(tools, 'ssh_key_remove');
    const rmArgs = rm.input.parse({ website: createdId(), key: 'e2e' });
    const target = await rm.target!(rmArgs, ctx);
    const token = ctx.gate.issue(rm.name, target, rmArgs);
    // ssh_key_remove's target.name is the website domain (the thing the human must type), and
    // target.id is the panel's SSH key id -- per docs/research.md, a small per-authorized_keys-line
    // integer ("0", "1", ...), not a UUID. Typing it back therefore fails gate.verify's name match
    // (GateReason 'mismatch'), not the 'uuid' short-circuit; accept either reason so this doesn't
    // depend on the panel's id format.
    let mistyped: unknown;
    try {
      ctx.gate.verify(token, target.id);
    } catch (e) {
      mistyped = e;
    }
    expect(mistyped).toBeInstanceOf(GateError);
    expect(['mismatch', 'uuid']).toContain((mistyped as GateError).reason);
    // The gate confirmation itself still types the human name -- that's what gate.verify expects.
    const pending = ctx.gate.verify(token, domain);
    await rm.handler(pending.args, ctx, target);
    const list = await call(tool(tools, 'ssh_keys_list'), { website: createdId() });
    expect((list.structured as { items: Array<{ name: string }> }).items.some((k) => k.name === 'e2e')).toBe(false);
  });

  it('website_set_php_version changes the version', async () => {
    createdId();
    const g = await call(tool(tools, 'website_get'), { website: createdId() });
    const versions = ((g.structured as { website: { canUse?: { phpVersions?: string[] } } }).website.canUse?.phpVersions ?? []).filter((v) => v !== (g.structured as { website: { phpVersion?: string } }).website.phpVersion);
    if (!versions.length) return;
    const r = await call(tool(tools, 'website_set_php_version'), { website: createdId(), php_version: versions.at(-1) });
    expect(r.isError, r.text).toBeFalsy();
  });

  it('website_delete soft-deletes through the gate contract and the site disappears from the list', async () => {
    const del = tool(tools, 'website_delete');
    const delArgs = del.input.parse({ website: createdId() });
    const target = await del.target!(delArgs, ctx);
    expect(target.id).toBe(createdId());
    const preview = await del.preview!(delArgs, ctx, target);
    expect(preview).toContain('soft-delete');
    const token = ctx.gate.issue(del.name, target, delArgs);
    // The gate confirmation still types the human name -- that's what gate.verify expects.
    const pending = ctx.gate.verify(token, domain);
    const r = await del.handler(pending.args, ctx, target);
    expect(r.isError, r.text).toBeFalsy();
    websiteId = undefined;
    const list = await call(tool(tools, 'websites_list'), { limit: 200, offset: 0 });
    expect((list.structured as { items: Array<{ domain: string }> }).items.some((w) => w.domain === domain)).toBe(false);
  });
});
