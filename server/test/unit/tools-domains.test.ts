import { describe, expect, it } from 'vitest';
import { detectProvider, filterZoneForThirdParty, isPlaceholderCert, tools } from '../../src/tools/domains.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import { type Route, writeThenList } from '../helpers/fakeFetch.js';
import { authNsCloudflare, authNsOther, authNsPlatform, branding, dnsZone, DOMAIN_ID, domainMappings, ORG_ID, PREVIEW_DOMAIN_ID, sslPlaceholder, sslReal, WEBSITE_ID, websiteDetail, websitesList } from '../fixtures/panel.js';

/**
 * `dns-status` answers with a bare scalar, not a JSON object: the live panel sends
 * `text/plain` with an unquoted body, while the spec (and some deployments) send a JSON
 * string. Both shapes must normalise to the same status.
 */
const dnsStatusRoute = (status: string, as: 'text' | 'json'): Route => ({
  method: 'GET',
  path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains/${DOMAIN_ID}/dns-status`,
  handler: async () =>
    as === 'text'
      ? new Response(status, { status: 200, headers: { 'content-type': 'text/plain' } })
      : new Response(JSON.stringify(status), { status: 200, headers: { 'content-type': 'application/json' } }),
});

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
    expect(b.text).toContain('website: vahi-dev-ccyq.sgp1.mystaging.site (');
    expect(b.text).toContain('· primary');
  });
  it('refuses to remove the primary domain and removes an alias through the gate contract', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'DELETE', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains/${PREVIEW_DOMAIN_ID}`, status: 204 }]);
    const t = byName(tools, 'domain_remove');
    await expect(t.target!({ website: 'vahi.dev', domain: 'vahi.dev' }, ctx)).rejects.toThrow(/primary/);
    const target = await t.target!({ website: 'vahi.dev', domain: 'vahi-dev-ccyq.sgp1.mystaging.site' }, ctx);
    expect(target).toEqual({ kind: 'domain', id: PREVIEW_DOMAIN_ID, name: 'vahi-dev-ccyq.sgp1.mystaging.site' });
    expect(await t.preview!({ website: 'vahi.dev', domain: target.name }, ctx, target)).toContain('preview');
    const callsBeforeHandler = f.calls.length;
    const r = await t.handler({ website: 'vahi.dev', domain: target.name }, ctx, target);
    expect(r.text).toContain('removed');
    expect(f.calls.find((c) => c.method === 'DELETE')?.path).toBe(`/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains/${PREVIEW_DOMAIN_ID}`);
    expect(f.calls.length - callsBeforeHandler).toBe(2);
  });
});

describe('domain_add settles an unclear answer and is idempotent', () => {
  const domainsPath = `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains`;
  const shop = { domain: 'shop.example', domainId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', websiteId: WEBSITE_ID, mappingKind: 'alias', documentRoot: 'public_html', cloudflareStatus: 'Disconnected' };
  const withShop = { items: [...domainMappings.items, shop] };

  it('confirms a domain whose add answer never came, by finding it in the mapping list', async () => {
    const { ctx, f } = await makeContext([...writeThenList({ writePath: domainsPath, listPath: domainsPath, before: domainMappings, after: withShop, write: () => { throw new TypeError('fetch failed'); } }), ...base()]);
    const r = await callTool(byName(tools, 'domain_add'), { website: 'vahi.dev', domain: 'shop.example', kind: 'alias' }, ctx);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toContain('confirmed by reading it back');
    expect(r.structured).toMatchObject({ domainId: shop.domainId, domain: 'shop.example', added: true });
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('says the outcome is unknown when the domain never shows up', async () => {
    const { ctx, f } = await makeContext([...writeThenList({ writePath: domainsPath, listPath: domainsPath, before: domainMappings, after: domainMappings, write: () => { throw new TypeError('fetch failed'); } }), ...base()]);
    const r = await callTool(byName(tools, 'domain_add'), { website: 'vahi.dev', domain: 'shop.example', kind: 'alias' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('OUTCOME UNKNOWN');
    expect(r.text).toContain('domains_list website=vahi.dev');
    expect(r.structured).toMatchObject({ outcome: 'unknown', domain: 'shop.example', added: null });
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('stays a success when the add answers 2xx with no body, and names the listing that has the id', async () => {
    // openapi-fetch hands back `undefined` for an empty 2xx body; reading `.id` off it threw after
    // the domain had already been added, and an error there invites a second add.
    const { ctx, f } = await makeContext([{ method: 'POST', path: domainsPath, handler: async () => new Response(null, { status: 201 }) }, ...base()]);
    const r = await callTool(byName(tools, 'domain_add'), { website: 'vahi.dev', domain: 'shop.example', kind: 'alias' }, ctx);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toContain('added alias domain shop.example');
    expect(r.text).toContain('run domains_list website=vahi.dev for its id');
    expect(r.text).not.toContain('undefined');
    expect(r.structured).toMatchObject({ domainId: null, domain: 'shop.example', added: true });
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('passes a 409 from the add through as the panel refusing, with no re-read', async () => {
    const { ctx, f } = await makeContext([{ method: 'POST', path: domainsPath, status: 409, body: { code: 'already_exists', message: 'domain exists' } }, ...base()]);
    await expect(callTool(byName(tools, 'domain_add'), { website: 'vahi.dev', domain: 'shop.example', kind: 'alias' }, ctx)).rejects.toThrow(/409/);
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    // The idempotency read before the add, and none after it.
    expect(f.calls.filter((c) => c.method === 'GET' && c.path.split('?')[0] === domainsPath)).toHaveLength(1);
  });

  it('names the document root of an addon already mapped, and refuses another document root, sending nothing', async () => {
    const blog = { domain: 'blog.example', domainId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', websiteId: WEBSITE_ID, mappingKind: 'addon', documentRoot: 'blog', cloudflareStatus: 'Disconnected' };
    const { ctx, f } = await makeContext([{ method: 'GET', path: domainsPath, body: { items: [...domainMappings.items, blog] } }, ...base()]);
    for (const document_root of [undefined, '', 'blog', 'blog/']) {
      const r = await callTool(byName(tools, 'domain_add'), { website: 'vahi.dev', domain: 'blog.example', kind: 'addon', ...(document_root === undefined ? {} : { document_root }) }, ctx);
      expect(r.isError, `${document_root}: ${r.text}`).toBeFalsy();
      expect(r.text).toContain('already mapped to this website as addon');
      expect(r.text).toContain('with document root blog. Nothing changed.');
      expect(r.structured).toMatchObject({ domainId: blog.domainId, documentRoot: 'blog', added: false });
    }
    const moved = await callTool(byName(tools, 'domain_add'), { website: 'vahi.dev', domain: 'blog.example', kind: 'addon', document_root: 'public_html/blog' }, ctx);
    expect(moved.isError).toBe(true);
    expect(moved.text).toContain('already mapped to this website as addon with document root blog, not public_html/blog');
    expect(moved.text).toMatch(/Nothing was sent to the panel/);
    expect(moved.structured).toMatchObject({ domainId: blog.domainId, domain: 'blog.example', documentRoot: 'blog', added: false });
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('never advises domain_remove for the primary or the preview domain', async () => {
    const { ctx, f } = await makeContext([{ method: 'GET', path: domainsPath, body: withShop }, ...base()]);
    const primary = await callTool(byName(tools, 'domain_add'), { website: 'vahi.dev', domain: 'vahi.dev', kind: 'alias' }, ctx);
    expect(primary.isError).toBe(true);
    expect(primary.text).toContain("it is the website's primary domain and cannot be re-added as another kind");
    expect(primary.text).not.toContain('domain_remove');
    const preview = await callTool(byName(tools, 'domain_add'), { website: 'vahi.dev', domain: 'vahi-dev-ccyq.sgp1.mystaging.site', kind: 'alias' }, ctx);
    expect(preview.isError).toBe(true);
    expect(preview.text).toContain("it is the platform's preview domain and must be left as it is");
    expect(preview.text).not.toContain('domain_remove');
    const alias = await callTool(byName(tools, 'domain_add'), { website: 'vahi.dev', domain: 'shop.example', kind: 'subdomain' }, ctx);
    expect(alias.text).toContain('remove it with domain_remove first if the kind has to change');
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('reports a domain already mapped with the same kind as done, and refuses another kind, sending nothing', async () => {
    const { ctx, f } = await makeContext([{ method: 'GET', path: domainsPath, body: withShop }, ...base()]);
    const same = await callTool(byName(tools, 'domain_add'), { website: 'vahi.dev', domain: 'shop.example', kind: 'alias' }, ctx);
    expect(same.isError).toBeFalsy();
    expect(same.text).toContain('already mapped to this website as alias');
    expect(same.text).toContain('Nothing changed');
    expect(same.structured).toMatchObject({ domainId: shop.domainId, added: false });
    const other = await callTool(byName(tools, 'domain_add'), { website: 'vahi.dev', domain: 'shop.example', kind: 'addon' }, ctx);
    expect(other.isError).toBe(true);
    expect(other.text).toContain('already mapped to this website as alias, not addon');
    expect(other.text).toMatch(/Nothing was sent to the panel/);
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('domain_dns_status', () => {
  it('explains the Cloudflare case with both paths', async () => {
    const { ctx } = await makeContext([
      ...base(),
      dnsStatusRoute('ForeignServer', 'text'),
      { method: 'GET', path: `/orgs/${ORG_ID}/domains/${DOMAIN_ID}/auth-ns`, body: authNsCloudflare },
    ]);
    const r = await callTool(byName(tools, 'domain_dns_status'), { website: 'vahi.dev' }, ctx);
    // The live panel answers auth-ns with matchesPlatform: true for Cloudflare nameservers; ours
    // comes from the names, and the panel's flag is exposed separately.
    expect(r.structured).toMatchObject({ status: 'ForeignServer', provider: 'cloudflare', serverIp: '65.98.32.45', matchesPlatform: false, panelMatchesPlatform: true });
    expect(r.text).toContain('Cloudflare');
    expect(r.text).toContain('domain_cloudflare_connect');
    expect(r.text).toContain('domain_dns_records');
    expect(r.text).toContain('"DNS only" (grey cloud, proxy off) until domain_ssl_get shows a real certificate');
    expect(r.text).toContain('Full (strict)');
    expect(r.text).toContain('preview domain');
  });
  it('explains the platform and failed cases', async () => {
    const { ctx } = await makeContext([
      ...base(),
      dnsStatusRoute('Failed', 'json'),
      { method: 'GET', path: `/orgs/${ORG_ID}/domains/${DOMAIN_ID}/auth-ns`, body: { matchesPlatform: false, authNs: [] } },
    ]);
    const r = await callTool(byName(tools, 'domain_dns_status'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ status: 'Failed', provider: 'unknown' });
    expect(r.text).toContain('ns1.stableserver.net');
    expect(r.text).toContain('A record');
  });
  it('reports lookup failure when auth-ns returns 500', async () => {
    const { ctx } = await makeContext([
      ...base(),
      dnsStatusRoute('Failed', 'text'),
      { method: 'GET', path: `/orgs/${ORG_ID}/domains/${DOMAIN_ID}/auth-ns`, status: 500, body: { code: 'internal' } },
    ]);
    const r = await callTool(byName(tools, 'domain_dns_status'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('current nameservers: lookup failed');
    expect(r.structured).toMatchObject({ provider: 'unknown', authNsLookupFailed: true });
  });
});

describe('domain_dns_records', () => {
  const zoneRoute = { method: 'GET' as const, path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains/${DOMAIN_ID}/dns-zone`, body: dnsZone };
  const routing = (localRemote: 'local' | 'remote') => ({ method: 'GET' as const, path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains/${DOMAIN_ID}/local_remote`, body: { localRemote } });
  const mailboxes = (...addresses: string[]) => ({ method: 'GET' as const, path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/emails`, body: { items: addresses.map((address) => ({ address })), total: addresses.length } });
  const kinds = (r: { structured?: unknown }) => (r.structured as { records: Array<{ kind: string; name: string }> }).records.map((x) => `${x.kind} ${x.name}`);

  it('auto omits mail records when routing is remote', async () => {
    const { ctx } = await makeContext([...base(), zoneRoute, routing('remote')]);
    const r = await callTool(byName(tools, 'domain_dns_records'), { website: 'vahi.dev', include_mail: 'auto', include_extras: false }, ctx);
    expect(kinds(r)).toEqual(['A @', 'CNAME www']);
    expect(r.text).toContain('mail records omitted: mail routing is remote');
    expect(r.text).toContain('65.98.32.45');
    expect(r.text).toContain('cloudflare proxy: keep every record on "DNS only"');
    expect((r.structured as { records: Array<{ proxyEligible: boolean }> }).records.every((x) => typeof x.proxyEligible === 'boolean')).toBe(true);
  });
  // Routing is "local" for every site (live 2026-09-05, vahi.dev with zero mailboxes), so on its
  // own it must not put the platform MX in front of a customer whose mail lives elsewhere.
  it('auto omits mail records when routing is local but the domain has no email accounts', async () => {
    const { ctx } = await makeContext([...base(), zoneRoute, routing('local'), mailboxes()]);
    const r = await callTool(byName(tools, 'domain_dns_records'), { website: 'vahi.dev', include_mail: 'auto', include_extras: false }, ctx);
    expect(kinds(r)).toEqual(['A @', 'CNAME www']);
    expect(r.text).toContain('mail records omitted: no email accounts on vahi.dev in the panel; pass include_mail=yes');
    expect(r.structured).toMatchObject({ includeMail: false, emailAccounts: 0, localRemote: 'local' });
  });
  it('auto includes mail records when routing is local and an email account exists on this domain', async () => {
    const { ctx } = await makeContext([...base(), zoneRoute, routing('local'), mailboxes('info@vahi.dev', 'x@other.example')]);
    const r = await callTool(byName(tools, 'domain_dns_records'), { website: 'vahi.dev', include_mail: 'auto', include_extras: false }, ctx);
    expect(kinds(r)).toContain('MX @');
    expect(r.text).toContain('mail records included: 1 email account(s) on vahi.dev are hosted on the platform mail server');
    expect(r.structured).toMatchObject({ includeMail: true, emailAccounts: 1 });
  });
  it('auto ignores email accounts that belong to another domain', async () => {
    const { ctx } = await makeContext([...base(), zoneRoute, routing('local'), mailboxes('x@other.example')]);
    const r = await callTool(byName(tools, 'domain_dns_records'), { website: 'vahi.dev', include_mail: 'auto', include_extras: false }, ctx);
    expect(kinds(r)).toEqual(['A @', 'CNAME www']);
    expect(r.structured).toMatchObject({ includeMail: false, emailAccounts: 0 });
  });
  it('include_mail=yes forces mail records without any lookup', async () => {
    const { ctx, f } = await makeContext([...base(), zoneRoute]);
    const r = await callTool(byName(tools, 'domain_dns_records'), { website: 'vahi.dev', include_mail: 'yes', include_extras: false }, ctx);
    expect(kinds(r)).toContain('MX @');
    expect(r.text).toContain('mail records included: include_mail=yes');
    expect(f.calls.some((c) => c.path.includes('/local_remote') || c.path.includes('/emails'))).toBe(false);
  });
  it('reports lookup failure when local_remote returns 500', async () => {
    const { ctx } = await makeContext([
      ...base(),
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains/${DOMAIN_ID}/dns-zone`, body: dnsZone },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains/${DOMAIN_ID}/local_remote`, status: 500, body: { code: 'internal' } },
    ]);
    const r = await callTool(byName(tools, 'domain_dns_records'), { website: 'vahi.dev', include_mail: 'auto', include_extras: false }, ctx);
    const recs = (r.structured as { records: Array<{ kind: string; name: string }> }).records;
    expect(recs.some((x) => x.kind === 'MX')).toBe(true);
    expect(r.text).toContain('mail records included: mail routing and email account lookups failed; treating mail as local');
    expect(r.structured).toMatchObject({ localRemote: 'unknown', emailAccounts: null });
  });
});

describe('ssl tools', () => {
  it('reads the certificate and flags the placeholder', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `/v2/domains/${DOMAIN_ID}/ssl`, body: sslPlaceholder }]);
    const r = await callTool(byName(tools, 'domain_ssl_get'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ placeholder: true, issuer: 'vahi.dev' });
    expect(r.structured).not.toHaveProperty('cert');
    expect(r.structured).not.toHaveProperty('key');
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
    // `justIssued` is our own flag; `issued` stays the certificate's own issue date.
    expect(r.structured).toMatchObject({ justIssued: true, placeholder: false, issued: sslReal.issued });
    expect(r.structured).not.toHaveProperty('cert');
    expect(r.structured).not.toHaveProperty('key');
    expect(r.text.split('\n')[0]).toMatch(/^org: /);
    expect(r.text).toContain('certificate issued.');
  });
  it('stops on a failed preflight with the panel\'s reason', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'POST', path: `/v2/domains/${DOMAIN_ID}/letsencrypt_preflight`, body: { canIssue: false, error: 'DNS does not resolve to this server' } }]);
    const r = await callTool(byName(tools, 'domain_ssl_issue'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('DNS does not resolve to this server');
    expect(r.text).not.toContain('Cloudflare');
    expect(r.structured).toMatchObject({ cloudflare: false });
    expect(f.calls.some((c) => c.path.endsWith('/letsencrypt'))).toBe(false);
  });
  // The panel's Let's Encrypt challenge fails while Cloudflare proxies the record (panel owner,
  // 2026-09-05): a Cloudflare domain gets the proxy-off instruction on failure and the
  // proxy-on / Full (strict) step on success.
  it('names the Cloudflare proxy rule when the domain is on Cloudflare', async () => {
    const cf = { method: 'GET' as const, path: `/orgs/${ORG_ID}/domains/${DOMAIN_ID}/auth-ns`, body: authNsCloudflare };
    const failed = await makeContext([...base(), cf, { method: 'POST', path: `/v2/domains/${DOMAIN_ID}/letsencrypt_preflight`, body: { canIssue: false, error: 'challenge failed' } }]);
    const r1 = await callTool(byName(tools, 'domain_ssl_issue'), { website: 'vahi.dev' }, failed.ctx);
    expect(r1.isError).toBe(true);
    expect(r1.text).toContain('"DNS only" (grey cloud, proxy off) until the certificate is issued');
    expect(r1.structured).toMatchObject({ cloudflare: true });
    const ok = await makeContext([
      ...base(),
      cf,
      { method: 'POST', path: `/v2/domains/${DOMAIN_ID}/letsencrypt_preflight`, body: { canIssue: true } },
      { method: 'POST', path: `/v2/domains/${DOMAIN_ID}/letsencrypt`, status: 200, body: null },
      { method: 'GET', path: `/v2/domains/${DOMAIN_ID}/ssl`, body: sslReal },
    ]);
    const r2 = await callTool(byName(tools, 'domain_ssl_issue'), { website: 'vahi.dev' }, ok.ctx);
    expect(r2.isError).toBeFalsy();
    expect(r2.text).toContain('the proxy can be turned on now, with SSL/TLS mode Full (strict)');
    expect(r2.structured).toMatchObject({ justIssued: true, cloudflare: true });
  });
  it('sets force ssl', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'PUT', path: `/v2/domains/${DOMAIN_ID}/ssl/force_ssl`, status: 200, body: null }]);
    await callTool(byName(tools, 'domain_set_force_ssl'), { website: 'vahi.dev', enabled: true }, ctx);
    expect(f.calls.find((c) => c.method === 'PUT')?.body).toBe('true');
  });
});

describe('cloudflare tools', () => {
  it('lists keys, connects a domain, reads nameservers', async () => {
    const key = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', token: 'cf-abcdefghijklmnopqrstuvwxyz0123', updatedAt: '2026-09-04', friendlyName: 'my cf', lastSync: null, lastMessage: null, domains: [] };
    const { ctx, f } = await makeContext([
      ...base(),
      { method: 'GET', path: `/orgs/${ORG_ID}/cloudflare`, body: [key] },
      { method: 'PUT', path: `/orgs/${ORG_ID}/domains/${DOMAIN_ID}/cloudflare`, status: 200, body: null },
      { method: 'GET', path: `/orgs/${ORG_ID}/domains/${DOMAIN_ID}/cloudflare/nameservers`, body: { nameServers: ['sofia.ns.cloudflare.com', 'terin.ns.cloudflare.com'], status: 'active' } },
    ]);
    const a = await callTool(byName(tools, 'cloudflare_keys_list'), {}, ctx);
    expect(a.text).toContain('my cf');
    // The panel hands back whatever it stored; never echo it, in text or in structured output.
    expect(a.text).not.toContain(key.token);
    expect(JSON.stringify(a.structured)).not.toContain(key.token);
    expect(a.text).toContain('cf-a\u20260123');
    expect(JSON.stringify(a.structured)).toContain('cf-a\u20260123');
    const b = await callTool(byName(tools, 'domain_cloudflare_connect'), { website: 'vahi.dev', key_id: key.id }, ctx);
    expect(f.calls.find((c) => c.method === 'PUT')?.body).toBe(`"${key.id}"`);
    expect(b.text).toContain('Enhance will now sync');
    const c = await callTool(byName(tools, 'domain_cloudflare_nameservers'), { website: 'vahi.dev' }, ctx);
    expect(c.structured).toMatchObject({ status: 'active' });
  });
});
