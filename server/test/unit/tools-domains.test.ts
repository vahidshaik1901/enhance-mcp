import { describe, expect, it } from 'vitest';
import { detectProvider, filterZoneForThirdParty, isPlaceholderCert, tools } from '../../src/tools/domains.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import { authNsCloudflare, authNsOther, authNsPlatform, branding, dnsZone, DOMAIN_ID, domainMappings, ORG_ID, PREVIEW_DOMAIN_ID, sslPlaceholder, sslReal, WEBSITE_ID, websiteDetail, websitesList } from '../fixtures/panel.js';

const base = () => [
  { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: websitesList },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: websiteDetail },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains`, body: domainMappings },
  { method: 'GET', path: '/branding', body: branding },
];

describe('helpers', () => {
  it('detects the placeholder certificate', () => {
    expect(isPlaceholderCert(sslPlaceholder)).toBe(true);
    expect(isPlaceholderCert(sslReal)).toBe(false);
  });
  it('detects the DNS provider from nameservers', () => {
    const platform = branding.nameServers;
    expect(detectProvider(authNsCloudflare.authNs.map((n) => n.name), platform)).toBe('cloudflare');
    expect(detectProvider(authNsPlatform.authNs.map((n) => n.name), platform)).toBe('platform');
    expect(detectProvider(authNsOther.authNs.map((n) => n.name), platform)).toBe('other');
    expect(detectProvider([], platform)).toBe('unknown');
  });
  it('filters the zone for a third-party provider', () => {
    const web = filterZoneForThirdParty(dnsZone.records, { mail: false, extras: false });
    expect(web.map((r) => `${r.kind} ${r.name}`)).toEqual(['A @', 'CNAME www']);
    const withMail = filterZoneForThirdParty(dnsZone.records, { mail: true, extras: false });
    expect(withMail.map((r) => `${r.kind} ${r.name}`)).toEqual(expect.arrayContaining(['A mail', 'MX @', 'TXT @', 'TXT _dmarc', 'CNAME imap']));
    expect(withMail.some((r) => r.kind === 'NS')).toBe(false);
    const all = filterZoneForThirdParty(dnsZone.records, { mail: true, extras: true });
    expect(all.map((r) => `${r.kind} ${r.name}`)).toEqual(expect.arrayContaining(['A mysql', 'CNAME ftp']));
  });
});

describe('domains_list', () => {
  it('shows kinds, docroots and certificate state', async () => {
    const { ctx } = await makeContext(base());
    const r = await callTool(byName(tools, 'domains_list'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain('primary');
    expect(r.text).toContain('placeholder (no real certificate)');
    expect(r.text).toContain('preview');
  });
});

describe('domain_add / domain_set_primary / domain_remove', () => {
  it('adds an alias and sets primary', async () => {
    const { ctx, f } = await makeContext([
      ...base(),
      { method: 'POST', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains`, status: 201, body: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } },
      { method: 'PUT', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains/primary`, status: 200, body: null },
    ]);
    const a = await callTool(byName(tools, 'domain_add'), { website: 'vahi.dev', domain: 'WWW2.vahi.dev', kind: 'alias' }, ctx);
    expect(f.calls.find((c) => c.method === 'POST')?.body).toBe('{"domain":"www2.vahi.dev","kind":"alias"}');
    expect(a.text).toContain('www2.vahi.dev');
    const b = await callTool(byName(tools, 'domain_set_primary'), { website: 'vahi.dev', domain: 'vahi-dev-ccyq.sgp1.mystaging.site' }, ctx);
    expect(f.calls.find((c) => c.method === 'PUT')?.body).toBe(`{"domainId":"${PREVIEW_DOMAIN_ID}"}`);
    expect(b.text).toContain('primary');
  });
  it('refuses to remove the primary domain and removes an alias through the gate contract', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'DELETE', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains/${PREVIEW_DOMAIN_ID}`, status: 204 }]);
    const t = byName(tools, 'domain_remove');
    await expect(t.target!({ website: 'vahi.dev', domain: 'vahi.dev' }, ctx)).rejects.toThrow(/primary/);
    const target = await t.target!({ website: 'vahi.dev', domain: 'vahi-dev-ccyq.sgp1.mystaging.site' }, ctx);
    expect(target).toEqual({ kind: 'domain', id: PREVIEW_DOMAIN_ID, name: 'vahi-dev-ccyq.sgp1.mystaging.site' });
    expect(await t.preview!({ website: 'vahi.dev', domain: target.name }, ctx, target)).toContain('preview');
    const r = await t.handler({ website: 'vahi.dev', domain: target.name }, ctx, target);
    expect(r.text).toContain('removed');
    expect(f.calls.find((c) => c.method === 'DELETE')?.path).toBe(`/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains/${PREVIEW_DOMAIN_ID}`);
  });
});

describe('domain_dns_status', () => {
  it('explains the Cloudflare case with both paths', async () => {
    const { ctx } = await makeContext([
      ...base(),
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains/${DOMAIN_ID}/dns-status`, body: 'ForeignServer' },
      { method: 'GET', path: `/orgs/${ORG_ID}/domains/${DOMAIN_ID}/auth-ns`, body: authNsCloudflare },
    ]);
    const r = await callTool(byName(tools, 'domain_dns_status'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ status: 'ForeignServer', provider: 'cloudflare', serverIp: '65.98.32.45' });
    expect(r.text).toContain('Cloudflare');
    expect(r.text).toContain('domain_cloudflare_connect');
    expect(r.text).toContain('domain_dns_records');
    expect(r.text).toContain('preview domain');
  });
  it('explains the platform and failed cases', async () => {
    const { ctx } = await makeContext([
      ...base(),
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains/${DOMAIN_ID}/dns-status`, body: 'Failed' },
      { method: 'GET', path: `/orgs/${ORG_ID}/domains/${DOMAIN_ID}/auth-ns`, body: { matchesPlatform: false, authNs: [] } },
    ]);
    const r = await callTool(byName(tools, 'domain_dns_status'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ status: 'Failed', provider: 'unknown' });
    expect(r.text).toContain('ns1.stableserver.net');
    expect(r.text).toContain('A record');
  });
});

describe('domain_dns_records', () => {
  it('uses local/remote mail routing for auto', async () => {
    const { ctx } = await makeContext([
      ...base(),
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains/${DOMAIN_ID}/dns-zone`, body: dnsZone },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains/${DOMAIN_ID}/local_remote`, body: { localRemote: 'remote' } },
    ]);
    const r = await callTool(byName(tools, 'domain_dns_records'), { website: 'vahi.dev', include_mail: 'auto', include_extras: false }, ctx);
    const recs = (r.structured as { records: Array<{ kind: string; name: string }> }).records;
    expect(recs.map((x) => `${x.kind} ${x.name}`)).toEqual(['A @', 'CNAME www']);
    expect(r.text).toContain('65.98.32.45');
  });
});

describe('ssl tools', () => {
  it('reads the certificate and flags the placeholder', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `/v2/domains/${DOMAIN_ID}/ssl`, body: sslPlaceholder }]);
    const r = await callTool(byName(tools, 'domain_ssl_get'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ placeholder: true, issuer: 'vahi.dev' });
    expect(r.text).not.toContain('BEGIN CERTIFICATE');
    expect(r.text).toContain('domain_ssl_issue');
  });
  it('issues after a successful preflight and reports the new cert', async () => {
    let issued = false;
    const { ctx } = await makeContext([
      ...base(),
      { method: 'POST', path: `/v2/domains/${DOMAIN_ID}/letsencrypt_preflight`, body: { canIssue: true } },
      { method: 'POST', path: `/v2/domains/${DOMAIN_ID}/letsencrypt`, handler: async () => { issued = true; return new Response(null, { status: 200 }); } },
      { method: 'GET', path: `/v2/domains/${DOMAIN_ID}/ssl`, handler: async () => new Response(JSON.stringify(issued ? sslReal : sslPlaceholder), { status: 200, headers: { 'content-type': 'application/json' } }) },
    ]);
    const r = await callTool(byName(tools, 'domain_ssl_issue'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.structured).toMatchObject({ issued: true, placeholder: false });
    expect(r.text).toContain("Let's Encrypt");
  });
  it('stops on a failed preflight with the panel\'s reason', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'POST', path: `/v2/domains/${DOMAIN_ID}/letsencrypt_preflight`, body: { canIssue: false, error: 'DNS does not resolve to this server' } }]);
    const r = await callTool(byName(tools, 'domain_ssl_issue'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('DNS does not resolve to this server');
    expect(f.calls.some((c) => c.path.endsWith('/letsencrypt'))).toBe(false);
  });
  it('sets force ssl', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'PUT', path: `/v2/domains/${DOMAIN_ID}/ssl/force_ssl`, status: 200, body: null }]);
    await callTool(byName(tools, 'domain_set_force_ssl'), { website: 'vahi.dev', enabled: true }, ctx);
    expect(f.calls.find((c) => c.method === 'PUT')?.body).toBe('true');
  });
});

describe('cloudflare tools', () => {
  it('lists keys, connects a domain, reads nameservers', async () => {
    const key = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', token: 'abcd****', updatedAt: '2026-09-04', friendlyName: 'my cf', lastSync: null, lastMessage: null, domains: [] };
    const { ctx, f } = await makeContext([
      ...base(),
      { method: 'GET', path: `/orgs/${ORG_ID}/cloudflare`, body: [key] },
      { method: 'PUT', path: `/orgs/${ORG_ID}/domains/${DOMAIN_ID}/cloudflare`, status: 200, body: null },
      { method: 'GET', path: `/orgs/${ORG_ID}/domains/${DOMAIN_ID}/cloudflare/nameservers`, body: { nameServers: ['sofia.ns.cloudflare.com', 'terin.ns.cloudflare.com'], status: 'active' } },
    ]);
    const a = await callTool(byName(tools, 'cloudflare_keys_list'), {}, ctx);
    expect(a.text).toContain('my cf');
    expect(a.text).not.toContain('abcd****abcd');
    const b = await callTool(byName(tools, 'domain_cloudflare_connect'), { website: 'vahi.dev', key_id: key.id }, ctx);
    expect(f.calls.find((c) => c.method === 'PUT')?.body).toBe(`"${key.id}"`);
    expect(b.text).toContain('Enhance will now sync');
    const c = await callTool(byName(tools, 'domain_cloudflare_nameservers'), { website: 'vahi.dev' }, ctx);
    expect(c.structured).toMatchObject({ status: 'active' });
  });
});
