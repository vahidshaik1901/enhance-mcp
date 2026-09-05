import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { requireOrg, type ToolContext } from '../../src/core/context.js';
import type { ToolDef } from '../../src/core/registry.js';
import { callTool } from '../helpers/context.js';
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

  beforeAll(async () => {
    ({ ctx, tools } = await bootstrap(process.env));
    domain = process.env['ENHANCE_E2E_DOMAIN'] || `mcp-e2e-${Math.random().toString(36).slice(2, 8)}.test`;
    expect(Number.isInteger(subscriptionId), 'ENHANCE_E2E_SUBSCRIPTION_ID must be set').toBe(true);
  });

  afterAll(async () => {
    if (!websiteId) return;
    const del = tool(tools, 'website_delete');
    const args = del.input.parse({ website: websiteId });
    const target = await del.target!(args, ctx).catch(() => undefined);
    if (target) await del.handler(args, ctx, target);
  });

  it('auth_status, platform_info and subscriptions_list answer with spec-shaped data', async () => {
    const a = await callTool(tool(tools, 'auth_status'), {}, ctx);
    expect(a.isError).toBeFalsy();
    const p = await callTool(tool(tools, 'platform_info'), {}, ctx);
    expect((p.structured as { nameServers: string[] }).nameServers.length).toBeGreaterThan(0);
    const s = await callTool(tool(tools, 'subscriptions_list'), {}, ctx);
    expect(s.isError, s.text).toBeFalsy();
    // subscriptions_list's structured `items` are a projected subset (resources reshaped into a
    // map, several spec-required fields such as subscriberId/vendorId/friendlyName dropped), so
    // validate against the raw panel payload instead, per review.
    const org = requireOrg(ctx.client);
    const raw = await ctx.client.call('GET', '/orgs/{org_id}/subscriptions', () => ctx.client.api.GET('/orgs/{org_id}/subscriptions', { params: { path: { org_id: org } } }));
    for (const item of raw.items) assertRequired('Subscription', item);
  });

  it('domain_check says the throwaway domain is free', async () => {
    const r = await callTool(tool(tools, 'domain_check'), { domain }, ctx);
    expect((r.structured as { status: string }).status).toBe('notInUse');
  });

  it('website_create creates the site and website_get returns spec-shaped detail', async () => {
    const r = await callTool(tool(tools, 'website_create'), { domain, subscription_id: subscriptionId }, ctx);
    expect(r.isError, r.text).toBeFalsy();
    const w = (r.structured as { website: { id: string } }).website;
    websiteId = w.id;
    // `w` is the raw Website detail the panel returned (ctx.resolver.getWebsite), not a
    // projected subset, so it can be checked directly against the spec's Website schema.
    assertRequired('Website', w);
    const g = await callTool(tool(tools, 'website_get'), { website: domain }, ctx);
    expect(g.text).toContain(`website: ${domain}`);
  });

  it('domains_list, dns status, dns records, ssl state work on the new site', async () => {
    const d = await callTool(tool(tools, 'domains_list'), { website: domain }, ctx);
    expect(d.isError, d.text).toBeFalsy();
    // domains_list's structured items are a projected subset (renamed/omitted fields), so
    // validate the raw domain mapping objects instead, per review.
    const rawMappings = await ctx.resolver.listDomains(websiteId!);
    for (const m of rawMappings) assertRequired('DomainMapping', m);
    const s = await callTool(tool(tools, 'domain_dns_status'), { website: domain }, ctx);
    expect(['Resolved', 'ForeignServer', 'Failed', 'Mixed', 'Unknown', 'Error']).toContain((s.structured as { status: string }).status);
    const recs = await callTool(tool(tools, 'domain_dns_records'), { website: domain, include_mail: 'no', include_extras: false }, ctx);
    expect((recs.structured as { records: Array<{ kind: string; name: string }> }).records.some((x) => x.kind === 'A' && x.name === '@')).toBe(true);
    const ssl = await callTool(tool(tools, 'domain_ssl_get'), { website: domain }, ctx);
    expect((ssl.structured as { placeholder: boolean }).placeholder).toBe(true);
  });

  it('website_preview_domain returns or creates a preview URL when the provider has one', async () => {
    const r = await callTool(tool(tools, 'website_preview_domain'), { website: domain }, ctx);
    const s = r.structured as { available: boolean; previewDomain: string | null };
    if (s.available) expect(s.previewDomain).toMatch(/\./);
  });

  it('ssh_key_add is idempotent and ssh_key_remove works through the gate contract', async () => {
    const pub = sshPublicKey();
    const a = await callTool(tool(tools, 'ssh_key_add'), { website: domain, public_key: pub, name: 'e2e' }, ctx);
    expect((a.structured as { added: boolean }).added).toBe(true);
    const b = await callTool(tool(tools, 'ssh_key_add'), { website: domain, public_key: pub }, ctx);
    expect((b.structured as { added: boolean }).added).toBe(false);
    const info = await callTool(tool(tools, 'ssh_connection_info'), { website: domain }, ctx);
    expect((info.structured as { keysAuthorized: number }).keysAuthorized).toBeGreaterThanOrEqual(1);
    const rm = tool(tools, 'ssh_key_remove');
    const rmArgs = rm.input.parse({ website: domain, key: 'e2e' });
    const target = await rm.target!(rmArgs, ctx);
    const token = ctx.gate.issue(rm.name, target, rmArgs);
    // ssh_key_remove's target.name is the website domain (the thing the human must type), and
    // target.id is the panel's SSH key id — per docs/research.md, a small per-authorized_keys-line
    // integer ("0", "1", ...), not a UUID. Typing it back therefore fails gate.verify's name match
    // (GateReason 'mismatch'), not the 'uuid' short-circuit; accept either so this doesn't depend
    // on the panel's id format.
    expect(() => ctx.gate.verify(token, target.id)).toThrow(/UUID|not accepted|does not match/);
    const pending = ctx.gate.verify(token, domain);
    await rm.handler(pending.args, ctx, target);
    const list = await callTool(tool(tools, 'ssh_keys_list'), { website: domain }, ctx);
    expect((list.structured as { items: Array<{ name: string }> }).items.some((k) => k.name === 'e2e')).toBe(false);
  });

  it('website_set_php_version changes the version', async () => {
    const g = await callTool(tool(tools, 'website_get'), { website: domain }, ctx);
    const versions = ((g.structured as { website: { canUse?: { phpVersions?: string[] } } }).website.canUse?.phpVersions ?? []).filter((v) => v !== (g.structured as { website: { phpVersion?: string } }).website.phpVersion);
    if (!versions.length) return;
    const r = await callTool(tool(tools, 'website_set_php_version'), { website: domain, php_version: versions.at(-1) }, ctx);
    expect(r.isError, r.text).toBeFalsy();
  });

  it('website_delete soft-deletes through the gate contract and the site disappears from the list', async () => {
    const del = tool(tools, 'website_delete');
    const delArgs = del.input.parse({ website: domain });
    const target = await del.target!(delArgs, ctx);
    const preview = await del.preview!(delArgs, ctx, target);
    expect(preview).toContain('soft-delete');
    const token = ctx.gate.issue(del.name, target, delArgs);
    const pending = ctx.gate.verify(token, domain);
    const r = await del.handler(pending.args, ctx, target);
    expect(r.isError, r.text).toBeFalsy();
    websiteId = undefined;
    const list = await callTool(tool(tools, 'websites_list'), { limit: 200, offset: 0 }, ctx);
    expect((list.structured as { items: Array<{ domain: string }> }).items.some((w) => w.domain === domain)).toBe(false);
  });
});
