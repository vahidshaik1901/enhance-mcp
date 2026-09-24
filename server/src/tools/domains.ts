import * as z from 'zod/v4';
import { parseScalarText } from '../client/client.js';
import type { components } from '../client/generated/types.js';
import { requireOrg, type ToolContext } from '../core/context.js';
import { identityBlock, previewDomain } from '../core/identity.js';
import { defineTool, type ToolDef } from '../core/registry.js';
import { fail, kv, ok, safe, table } from '../core/respond.js';
import type { DomainMapping, Website } from '../core/resolver.js';
import { confirmedByReadNote, DEFAULT_WINDOW_MS, unknownOutcome, writeThenVerify } from '../core/verify.js';

type DnsRecord = components['schemas']['DnsRecord'];
type Cert = Pick<components['schemas']['DomainSslCert'], 'cn' | 'issuer' | 'issued' | 'expires' | 'sans'> & { forceHttps?: boolean };

const websiteArg = z.string().min(1).describe('Website domain name (primary or alias) or website UUID');
const domainArg = z.string().min(1).optional().describe('Domain name or domain UUID mapped to the website; defaults to the primary domain');

export function isPlaceholderCert(cert: Pick<Cert, 'cn' | 'issuer' | 'issued' | 'expires'>): boolean {
  return cert.issuer === cert.cn || cert.issued.startsWith('1975') || cert.expires.startsWith('4096');
}

function normNs(n: string): string {
  return n.trim().toLowerCase().replace(/\.$/, '');
}

export type DnsProvider = 'platform' | 'cloudflare' | 'other' | 'unknown';

export function detectProvider(authNs: string[], platformNs: string[]): DnsProvider {
  const ns = authNs.map(normNs).filter(Boolean);
  if (!ns.length) return 'unknown';
  const platform = new Set(platformNs.map(normNs));
  if (ns.some((n) => platform.has(n))) return 'platform';
  if (ns.some((n) => n.endsWith('.ns.cloudflare.com'))) return 'cloudflare';
  return 'other';
}

const MAIL_HOSTS = new Set(['mail', 'imap', 'pop', 'smtp', 'webmail', 'autoconfig', 'autodiscover']);
const EXTRA_HOSTS = new Set(['mysql', 'ftp', 'cpanel', 'phpmyadmin']);

export function filterZoneForThirdParty(records: DnsRecord[], opts: { mail: boolean; extras: boolean }): DnsRecord[] {
  return records.filter((r) => {
    if (r.kind === 'NS') return false;
    if (r.name === '@' && (r.kind === 'A' || r.kind === 'AAAA')) return true;
    if (r.name === 'www' && (r.kind === 'CNAME' || r.kind === 'A' || r.kind === 'AAAA')) return true;
    const isMail = r.kind === 'MX' || MAIL_HOSTS.has(r.name) || r.name === '_dmarc' || r.name.endsWith('._domainkey') || (r.kind === 'TXT' && r.name === '@' && r.value.startsWith('v=spf1'));
    if (isMail) return opts.mail;
    if (EXTRA_HOSTS.has(r.name)) return opts.extras;
    return false;
  });
}

function certSummary(cert?: { cn: string; issuer: string; issued: string; expires: string; forceHttps?: boolean }): string {
  if (!cert) return 'none';
  return isPlaceholderCert(cert) ? 'placeholder (no real certificate)' : `${cert.issuer}, expires ${cert.expires}${cert.forceHttps ? ', force https' : ''}`;
}

/**
 * Resolves the website and one of its domain mappings. `domain` may be a name or a domain UUID
 * (e.g. a destructive tool's `target.id`, per convention 12: preview/handler act on the target
 * they are handed rather than re-resolving by the raw args.domain name).
 */
async function site(ctx: ToolContext, website: string, domain?: string): Promise<{ org: string; w: Website; d: DomainMapping }> {
  const org = requireOrg(ctx.client);
  const w = await ctx.resolver.resolveWebsite(website);
  const d = await ctx.resolver.resolveDomain(w, domain);
  return { org, w, d };
}

function serverIp(w: Website): string | undefined {
  return (w.serverIps?.find((s) => s.isPrimary) ?? w.serverIps?.[0])?.ip;
}

export const domainsList = defineTool({
  name: 'domains_list',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only. Lists the domains mapped to a website (primary, aliases, subdomains, preview) with document root, Cloudflare state and certificate state (placeholder or real).',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const w = await ctx.resolver.resolveWebsite(website);
    const items = await ctx.resolver.listDomains(w.id);
    const rows = items.map((d) => ({ domain: d.domain, kind: d.mappingKind, docroot: d.documentRoot, certificate: certSummary(d.cert), cloudflare: d.cloudflareStatus, id: d.domainId }));
    return ok([identityBlock({ name: ctx.client.orgName, id: w.orgId }, w), table(rows, ['domain', 'kind', 'docroot', 'certificate', 'cloudflare', 'id'])].join('\n'), { website: w.id, items });
  },
});

export const domainAdd = defineTool({
  name: 'domain_add',
  tier: 'customer',
  risk: 'write',
  description: 'Maps an additional domain to a website: addon (own docroot), alias (same content as primary), or subdomain. Creates its DNS zone on the platform.',
  input: z.object({
    website: websiteArg,
    domain: z
      .string()
      .transform((d) => d.trim().toLowerCase())
      .refine((d) => d.length >= 3 && /^[a-z0-9.-]+$/.test(d), { error: 'domain must be a hostname (letters, digits, dots, hyphens)' }),
    kind: z.enum(['addon', 'alias', 'subdomain']),
    document_root: z.string().optional(),
  }),
  async handler(args, ctx) {
    const { client } = ctx;
    const org = requireOrg(client);
    const w = await ctx.resolver.resolveWebsite(args.website);
    const identity = identityBlock({ name: client.orgName, id: org }, w);
    const mapped = async (): Promise<DomainMapping | undefined> => (await ctx.resolver.listDomains(w.id)).find((d) => d.domain.toLowerCase() === args.domain);
    // Read first: an unclear write is settled by finding the domain in this same list, which only
    // proves anything when the domain was not in it before.
    const existing = await mapped();
    if (existing) {
      if (existing.mappingKind === args.kind) {
        return ok(`${identity}\n${safe(args.domain)} is already mapped to this website as ${safe(existing.mappingKind)} (${existing.domainId}). Nothing changed.`, { website: w.id, domainId: existing.domainId, domain: args.domain, kind: args.kind, added: false });
      }
      return fail(`${identity}\n${safe(args.domain)} is already mapped to this website as ${safe(existing.mappingKind)}, not ${args.kind}. Nothing was sent to the panel; remove it with domain_remove first if the kind has to change.`, { website: w.id, domainId: existing.domainId, domain: args.domain, added: false });
    }
    const outcome = await writeThenVerify({
      write: () => client.call('POST', '/orgs/{org_id}/websites/{website_id}/domains', () => client.api.POST('/orgs/{org_id}/websites/{website_id}/domains', { params: { path: { org_id: org, website_id: w.id } }, body: { domain: args.domain, kind: args.kind, ...(args.document_root ? { documentRoot: args.document_root } : {}) } })),
      find: async () => (await mapped())?.domainId,
      sleep: ctx.sleep,
    });
    ctx.resolver.invalidate();
    if (outcome.state === 'unknown') {
      return unknownOutcome(identity, outcome, { action: `adding ${safe(args.domain)} to ${safe(w.domain.domain)}`, settle: `domains_list website=${safe(w.domain.domain)}`, windowMs: DEFAULT_WINDOW_MS }, { website: w.id, domain: args.domain, added: null });
    }
    const domainId = outcome.confirmedBy === 'response' ? outcome.written.id : outcome.found;
    const lines = [identity, `added ${args.kind} domain ${safe(args.domain)} (${domainId}). Run domain_dns_status website=${safe(w.domain.domain)} domain=${safe(args.domain)} for DNS instructions.`];
    if (outcome.confirmedBy === 'verify') lines.push(confirmedByReadNote(outcome.writeError));
    return ok(lines.join('\n'), { website: w.id, domainId, domain: args.domain, kind: args.kind, added: true });
  },
});

export const domainSetPrimary = defineTool({
  name: 'domain_set_primary',
  tier: 'customer',
  risk: 'write',
  description: 'Makes one of the website\'s mapped domains the primary domain (the one the site is known by).',
  input: z.object({ website: websiteArg, domain: z.string().min(1) }),
  async handler(args, ctx) {
    const { org, w, d } = await site(ctx, args.website, args.domain);
    await ctx.client.call('PUT', '/orgs/{org_id}/websites/{website_id}/domains/primary', () =>
      ctx.client.api.PUT('/orgs/{org_id}/websites/{website_id}/domains/primary', { params: { path: { org_id: org, website_id: w.id } }, body: { domainId: d.domainId } }),
    );
    ctx.resolver.invalidate();
    // Render the identity with the updated website (new primary) and mapping (now primary), per convention 13.
    const updatedMapping: DomainMapping = { ...d, mappingKind: 'primary' };
    return ok(`${identityBlock({ name: ctx.client.orgName, id: org }, { ...w, domain: { ...w.domain, domain: d.domain, id: d.domainId } }, updatedMapping)}\n${safe(d.domain)} is now the primary domain.`, { website: w.id, primaryDomainId: d.domainId, domain: d.domain });
  },
});

export const domainRemove = defineTool({
  name: 'domain_remove',
  tier: 'customer',
  risk: 'destructive',
  description: 'DESTRUCTIVE. Removes a non-primary domain mapping (alias, addon, subdomain, preview) from a website and drops its DNS zone. Requires the user to type the domain name. The primary domain cannot be removed; set another primary first.',
  input: z.object({ website: websiteArg, domain: z.string().min(1) }),
  async target(args, ctx) {
    const { d } = await site(ctx, args.website, args.domain);
    if (d.mappingKind === 'primary') throw new Error(`${safe(d.domain)} is the primary domain and cannot be removed. Use domain_set_primary to promote another domain first.`);
    return { kind: 'domain', id: d.domainId, name: d.domain };
  },
  async preview(args, ctx, target) {
    // Act on the target it was handed (convention 12): resolve the domain by target.id, not by
    // re-parsing args.domain, so the preview can't drift from what handler() will actually delete.
    const { w, d } = await site(ctx, args.website, target.id);
    return `This will remove the ${safe(d.mappingKind)} domain ${safe(target.name)} (${target.id}) from website ${safe(w.domain.domain)}. Its DNS zone on the platform is deleted and any certificate for it is dropped. Files in ${safe(d.documentRoot)} are not deleted.`;
  },
  async handler(args, ctx, target) {
    const org = requireOrg(ctx.client);
    const w = await ctx.resolver.resolveWebsite(args.website);
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/domains/{domain_id}', () =>
      ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/domains/{domain_id}', { params: { path: { org_id: org, website_id: w.id, domain_id: target!.id } } }),
    );
    ctx.resolver.invalidate();
    return ok(`${identityBlock({ name: ctx.client.orgName, id: org }, w)}\ndomain ${safe(target!.name)} removed.`, { website: w.id, domainId: target!.id, removed: true });
  },
});

export const domainDnsStatus = defineTool({
  name: 'domain_dns_status',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only DNS preflight for a domain: whether it resolves to this site (Resolved, ForeignServer, Failed, Mixed), which nameservers it uses now, a provider guess (platform, cloudflare, other), and exactly what the customer should do. Deploys never wait on this: the preview domain works meanwhile.',
  input: z.object({ website: websiteArg, domain: domainArg }),
  async handler(args, ctx) {
    const { client } = ctx;
    const { org, w, d } = await site(ctx, args.website, args.domain);
    let authNsLookupFailed = false;
    const [rawStatus, authNs, b] = await Promise.all([
      // The panel answers this with a bare word as text/plain, not a JSON object; read it as text
      // and normalise so a JSON-quoted body works too.
      client.call<string>('GET', '/orgs/{org_id}/websites/{website_id}/domains/{domain_id}/dns-status', () => client.api.GET('/orgs/{org_id}/websites/{website_id}/domains/{domain_id}/dns-status', { params: { path: { org_id: org, website_id: w.id, domain_id: d.domainId } }, parseAs: 'text' })),
      client.call('GET', '/orgs/{org_id}/domains/{domain_id}/auth-ns', () => client.api.GET('/orgs/{org_id}/domains/{domain_id}/auth-ns', { params: { path: { org_id: org, domain_id: d.domainId } } })).catch(() => { authNsLookupFailed = true; return { matchesPlatform: false, authNs: [] as Array<{ name: string; ips: string[] }> }; }),
      client.call('GET', '/branding', () => client.api.GET('/branding', { params: { query: { orgId: org } } })),
    ]);
    const status = parseScalarText(rawStatus);
    const platformNs = b.nameServers ?? [];
    const current = authNs.authNs.map((n) => normNs(n.name));
    const provider = detectProvider(current, platformNs);
    const ip = safe(serverIp(w) ?? '<app-server-ip>');
    const websiteDomain = safe(w.domain.domain);
    const domainName = safe(d.domain);
    const preview = previewDomain(w);
    const advice: string[] = [];
    if (status === 'Resolved') advice.push('DNS already points at this site. Nothing to do.');
    else if (provider === 'platform') advice.push('The registrar already uses the platform nameservers. Wait for propagation (minutes to 48 h); nothing else to do.');
    else if (provider === 'cloudflare') {
      advice.push('The domain is on Cloudflare. Two options:');
      advice.push(`  a) Integration: add a Cloudflare API token in the panel (Settings > Cloudflare), then run domain_cloudflare_connect website=${websiteDomain} key_id=<id from cloudflare_keys_list>. Enhance then creates and maintains the records at Cloudflare itself.`);
      advice.push(`  b) Manual: run domain_dns_records website=${websiteDomain} and add those records in the Cloudflare dashboard (A @ -> ${ip}, CNAME www -> ${domainName}).`);
      advice.push('  Either way, keep the A and CNAME records on "DNS only" (grey cloud, proxy off) until domain_ssl_get shows a real certificate: the panel\'s Let\'s Encrypt issuance fails while Cloudflare proxies the record.');
      advice.push('  Once the certificate is issued the customer can turn the proxy on and set Cloudflare SSL/TLS to Full (strict). Never Flexible: it loops with force-https.');
    } else {
      advice.push('Either switch the registrar to the platform nameservers:');
      advice.push(`  ${platformNs.length ? platformNs.map(safe).join(', ') : '(provider has not published nameservers)'}`);
      advice.push(`or keep the current DNS host and add an A record for @ -> ${ip} plus CNAME www -> ${domainName} (run domain_dns_records for the full list).`);
    }
    advice.push(preview ? `Meanwhile the site is reachable on the preview domain: https://${safe(preview)}/` : `Meanwhile verify with: curl -k --resolve ${domainName}:443:${ip} https://${domainName}/`);
    const currentNsDisplay = authNsLookupFailed ? 'lookup failed' : (current.length ? current : 'none found');
    const text = [
      identityBlock({ name: client.orgName, id: org }, w, d),
      kv([['dns status', status], ['current nameservers', currentNsDisplay], ['provider', provider], ['platform nameservers', platformNs], ['app server ip', ip], ['preview domain', preview]]),
      ...advice,
    ].join('\n');
    return ok(text, { website: w.id, domainId: d.domainId, domain: d.domain, status, provider, currentNameservers: current, platformNameservers: platformNs, serverIp: ip, previewDomain: preview ?? null, matchesPlatform: provider === 'platform', panelMatchesPlatform: authNsLookupFailed ? null : authNs.matchesPlatform, authNsLookupFailed });
  },
});

export const domainDnsQuery = defineTool({
  name: 'domain_dns_query',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only, for debugging DNS: the panel\'s full delegation walk for the domain, from the root servers down to the resolved IPs.',
  input: z.object({ website: websiteArg, domain: domainArg }),
  async handler(args, ctx) {
    const { org, w, d } = await site(ctx, args.website, args.domain);
    const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/domains/{domain_id}/dns-query', () =>
      ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/domains/{domain_id}/dns-query', { params: { path: { org_id: org, website_id: w.id, domain_id: d.domainId } } }),
    );
    // JSON.stringify escapes any control characters inside string values (e.g. "\n" -> the two
    // characters backslash-n) rather than emitting them raw, so this dump can't forge extra
    // output lines the way a raw template-literal interpolation of panel text could.
    return ok(`${identityBlock({ name: ctx.client.orgName, id: org }, w, d)}\n${JSON.stringify(res, null, 1)}`, { query: res });
  },
});

export const domainDnsRecords = defineTool({
  name: 'domain_dns_records',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only. The DNS records the customer must create at a third-party DNS provider (Cloudflare or other), taken from the panel\'s own zone: A @ and CNAME www always; mail records only when mail routing is local AND the domain has email accounts on the platform (or include_mail=yes); mysql/ftp only with include_extras. Never NS or SOA.',
  input: z.object({ website: websiteArg, domain: domainArg, include_mail: z.enum(['auto', 'yes', 'no']).default('auto'), include_extras: z.boolean().default(false) }),
  async handler(args, ctx) {
    const { client } = ctx;
    const { org, w, d } = await site(ctx, args.website, args.domain);
    const path = { org_id: org, website_id: w.id, domain_id: d.domainId };
    const zone = await client.call('GET', '/orgs/{org_id}/websites/{website_id}/domains/{domain_id}/dns-zone', () => client.api.GET('/orgs/{org_id}/websites/{website_id}/domains/{domain_id}/dns-zone', { params: { path } }));
    let mail = args.include_mail === 'yes';
    let localRemote: 'local' | 'remote' | 'unknown' = 'local';
    let emailAccounts: number | null = null;
    let mailReason = args.include_mail === 'yes' ? 'include_mail=yes' : 'include_mail=no';
    if (args.include_mail === 'auto') {
      const lr = await client.call('GET', '/orgs/{org_id}/websites/{website_id}/domains/{domain_id}/local_remote', () => client.api.GET('/orgs/{org_id}/websites/{website_id}/domains/{domain_id}/local_remote', { params: { path } })).catch(() => ({ localRemote: undefined }));
      localRemote = lr.localRemote === undefined ? 'unknown' : lr.localRemote;
      if (localRemote === 'remote') {
        mail = false;
        mailReason = 'mail routing is remote';
      } else {
        // Routing is "local" for every site, mailboxes or not (verified live 2026-09-05), so it
        // cannot tell whether the customer's mail lives here. Only real email accounts (mailboxes or
        // forwarders) on this domain can; without them, handing a customer the platform MX would
        // break mail hosted elsewhere.
        const suffix = `@${d.domain.toLowerCase()}`;
        const emails = await client.call('GET', '/orgs/{org_id}/websites/{website_id}/emails', () => client.api.GET('/orgs/{org_id}/websites/{website_id}/emails', { params: { path: { org_id: org, website_id: w.id }, query: { search: d.domain } } })).catch(() => undefined);
        if (emails === undefined) {
          mail = true;
          mailReason = `${localRemote === 'unknown' ? 'mail routing and email account lookups' : 'email account lookup'} failed; treating mail as local`;
        } else {
          emailAccounts = emails.items.filter((e) => e.address.toLowerCase().endsWith(suffix)).length;
          mail = emailAccounts > 0;
          mailReason = mail ? `${emailAccounts} email account(s) on ${safe(d.domain)} are hosted on the platform mail server` : `no email accounts on ${safe(d.domain)} in the panel; pass include_mail=yes if mail should be hosted here`;
        }
      }
    }
    const records = filterZoneForThirdParty(zone.records, { mail, extras: args.include_extras });
    const rows = records.map((r) => ({ host: r.name, type: r.kind, value: r.value, ttl: r.ttl ?? zone.soa.ttl, proxy: r.proxy ? 'DNS only until SSL is issued' : 'DNS only' }));
    const text = [identityBlock({ name: client.orgName, id: org }, w, d), `records to create at your DNS provider (mail records ${mail ? 'included' : 'omitted'}: ${mailReason}):`, table(rows, ['host', 'type', 'value', 'ttl', 'proxy']), 'cloudflare proxy: keep every record on "DNS only" (grey cloud) until domain_ssl_get shows a real certificate; the panel\'s Let\'s Encrypt issuance fails through the proxy. After that, the records marked above may be proxied with SSL/TLS mode Full (strict).'].join('\n');
    return ok(text, { website: w.id, domain: d.domain, includeMail: mail, mailReason, emailAccounts, localRemote, records: records.map((r) => ({ kind: r.kind, name: r.name, value: r.value, ttl: r.ttl ?? zone.soa.ttl, proxyEligible: !!r.proxy })) });
  },
});

function certText(w: Website, d: DomainMapping, cert: Cert, orgName: string | undefined): string {
  const placeholder = isPlaceholderCert(cert);
  return [
    identityBlock({ name: orgName, id: w.orgId }, w, d),
    kv([['certificate', placeholder ? 'placeholder (self-signed by the panel; browsers will warn)' : 'real certificate'], ['issuer', cert.issuer], ['common name', cert.cn], ['sans', cert.sans], ['issued', cert.issued], ['expires', cert.expires], ['force https', cert.forceHttps === undefined ? undefined : cert.forceHttps ? 'on' : 'off']]),
    placeholder ? `Run domain_ssl_issue website=${safe(w.domain.domain)}${d.mappingKind !== 'primary' ? ` domain=${safe(d.domain)}` : ''} once DNS resolves to this site.` : '',
  ].filter(Boolean).join('\n');
}

export const domainSslGet = defineTool({
  name: 'domain_ssl_get',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only. Shows the TLS certificate for a domain and whether it is the panel\'s self-signed placeholder (issuer equals the domain, dated 1975), which means no real certificate has been issued yet.',
  input: z.object({ website: websiteArg, domain: domainArg }),
  async handler(args, ctx) {
    const { w, d } = await site(ctx, args.website, args.domain);
    const cert = await ctx.client.call('GET', '/v2/domains/{domain_id}/ssl', () => ctx.client.api.GET('/v2/domains/{domain_id}/ssl', { params: { path: { domain_id: d.domainId } } }));
    // Never surface the PEM cert/key material, in text or in structured output.
    const { cert: _pem, key: _key, ...rest } = cert;
    return ok(certText(w, d, rest, ctx.client.orgName), { website: w.id, domainId: d.domainId, placeholder: isPlaceholderCert(rest), ...rest });
  },
});

export const domainSslIssue = defineTool({
  name: 'domain_ssl_issue',
  tier: 'customer',
  risk: 'write',
  description: 'Requests a Let\'s Encrypt certificate for a domain. Runs the panel\'s preflight first and stops with the reason when the domain is not yet reachable (usually DNS). Takes up to a minute.',
  input: z.object({ website: websiteArg, domain: domainArg }),
  async handler(args, ctx) {
    const { w, d } = await site(ctx, args.website, args.domain);
    const path = { domain_id: d.domainId };
    // Cloudflare's proxy breaks the panel's Let's Encrypt challenge (reported by the panel owner,
    // 2026-09-05), so name it in both outcomes. A failed nameserver lookup just drops the hint.
    const authNs = await ctx.client.call('GET', '/orgs/{org_id}/domains/{domain_id}/auth-ns', () => ctx.client.api.GET('/orgs/{org_id}/domains/{domain_id}/auth-ns', { params: { path: { org_id: w.orgId, domain_id: d.domainId } } })).catch(() => ({ authNs: [] as Array<{ name: string }> }));
    const onCloudflare = detectProvider(authNs.authNs.map((n) => normNs(n.name)), []) === 'cloudflare';
    const pre = await ctx.client.call('POST', '/v2/domains/{domain_id}/letsencrypt_preflight', () => ctx.client.api.POST('/v2/domains/{domain_id}/letsencrypt_preflight', { params: { path } }));
    if (!pre.canIssue) {
      const cfHint = onCloudflare ? '\nThe domain is on Cloudflare: its A and CNAME records must be "DNS only" (grey cloud, proxy off) until the certificate is issued; the challenge fails through the proxy. Turn the proxy back on afterwards with SSL/TLS mode Full (strict).' : '';
      return fail(`${identityBlock({ name: ctx.client.orgName, id: w.orgId }, w, d)}\nLet's Encrypt preflight failed: ${safe(pre.error ?? 'no reason given')}.\nFix DNS first (domain_dns_status) and retry. The preview domain already has HTTPS.${cfHint}`, { website: w.id, domainId: d.domainId, issued: false, preflightError: pre.error ?? null, cloudflare: onCloudflare });
    }
    await ctx.client.call('POST', '/v2/domains/{domain_id}/letsencrypt', () => ctx.client.api.POST('/v2/domains/{domain_id}/letsencrypt', { params: { path } }));
    const cert = await ctx.client.call('GET', '/v2/domains/{domain_id}/ssl', () => ctx.client.api.GET('/v2/domains/{domain_id}/ssl', { params: { path } }));
    const { cert: _pem, key: _key, ...rest } = cert;
    ctx.resolver.invalidate();
    // `rest.issued` is the certificate's own issue date; our "we just issued it" flag is a
    // separate key so neither shadows the other.
    const cfNext = onCloudflare ? '\nThe domain is on Cloudflare: the proxy can be turned on now, with SSL/TLS mode Full (strict).' : '';
    return ok(`${certText(w, d, rest, ctx.client.orgName)}\ncertificate issued.${cfNext}`, { website: w.id, domainId: d.domainId, ...rest, justIssued: true, placeholder: isPlaceholderCert(rest), cloudflare: onCloudflare });
  },
});

export const domainSetForceSsl = defineTool({
  name: 'domain_set_force_ssl',
  tier: 'customer',
  risk: 'write',
  description: 'Turns the HTTP to HTTPS redirect on or off for a domain. Only enable after a real certificate exists.',
  input: z.object({ website: websiteArg, domain: domainArg, enabled: z.boolean() }),
  async handler(args, ctx) {
    const { w, d } = await site(ctx, args.website, args.domain);
    await ctx.client.call('PUT', '/v2/domains/{domain_id}/ssl/force_ssl', () => ctx.client.api.PUT('/v2/domains/{domain_id}/ssl/force_ssl', { params: { path: { domain_id: d.domainId } }, body: args.enabled }));
    return ok(`${identityBlock({ name: ctx.client.orgName, id: w.orgId }, w, d)}\nforce https ${args.enabled ? 'enabled' : 'disabled'}.`, { website: w.id, domainId: d.domainId, forceHttps: args.enabled });
  },
});

/**
 * The panel returns whatever it stored for a Cloudflare API token, which on some deployments is
 * the token itself rather than an obfuscated form. Never echo it: show only enough to tell two
 * stored tokens apart.
 */
export function maskToken(token: unknown): string {
  const s = typeof token === 'string' ? token : '';
  return s.length > 12 ? `${s.slice(0, 4)}\u2026${s.slice(-4)}` : '****';
}

export const cloudflareKeysList = defineTool({
  name: 'cloudflare_keys_list',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only. Lists the Cloudflare API tokens the customer has stored in the panel (obfuscated), with which domains they sync. Tokens are added in the panel UI, never through this MCP.',
  input: z.object({}),
  async handler(_args, ctx) {
    const org = requireOrg(ctx.client);
    const keys = await ctx.client.call('GET', '/orgs/{org_id}/cloudflare', () => ctx.client.api.GET('/orgs/{org_id}/cloudflare', { params: { path: { org_id: org } } }));
    const rows = keys.map((k) => ({ id: k.id, name: k.friendlyName, token: maskToken(k.token), lastSync: k.lastSync ?? '', lastMessage: k.lastMessage ?? '', domains: k.domains ?? [] }));
    return ok([identityBlock({ name: ctx.client.orgName, id: org }), keys.length ? table(rows, ['id', 'name', 'token', 'lastSync', 'lastMessage', 'domains']) : 'no Cloudflare tokens stored. Add one in the panel under Settings > Cloudflare, then call this again.'].join('\n'), { items: rows });
  },
});

export const domainCloudflareConnect = defineTool({
  name: 'domain_cloudflare_connect',
  tier: 'customer',
  risk: 'write',
  description: 'Connects a domain to a stored Cloudflare token (id from cloudflare_keys_list). Enhance then creates and maintains the DNS records at Cloudflare itself; check domain_cloudflare_nameservers and domains_list for the Connected state.',
  input: z.object({ website: websiteArg, domain: domainArg, key_id: z.uuid() }),
  async handler(args, ctx) {
    const { org, w, d } = await site(ctx, args.website, args.domain);
    await ctx.client.call('PUT', '/orgs/{org_id}/domains/{domain_id}/cloudflare', () => ctx.client.api.PUT('/orgs/{org_id}/domains/{domain_id}/cloudflare', { params: { path: { org_id: org, domain_id: d.domainId } }, body: args.key_id }));
    ctx.resolver.invalidate();
    return ok(`${identityBlock({ name: ctx.client.orgName, id: org }, w, d)}\nconnected to Cloudflare token ${args.key_id}. Enhance will now sync the zone to Cloudflare; re-run domains_list in a minute to see cloudflare=Connected.`, { website: w.id, domainId: d.domainId, keyId: args.key_id });
  },
});

export const domainCloudflareNameservers = defineTool({
  name: 'domain_cloudflare_nameservers',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only. The Cloudflare nameservers assigned to a domain and whether the Cloudflare zone is active or pending. Only meaningful after domain_cloudflare_connect.',
  input: z.object({ website: websiteArg, domain: domainArg }),
  async handler(args, ctx) {
    const { org, w, d } = await site(ctx, args.website, args.domain);
    const res = await ctx.client.call('GET', '/orgs/{org_id}/domains/{domain_id}/cloudflare/nameservers', () => ctx.client.api.GET('/orgs/{org_id}/domains/{domain_id}/cloudflare/nameservers', { params: { path: { org_id: org, domain_id: d.domainId } } }));
    return ok(`${identityBlock({ name: ctx.client.orgName, id: org }, w, d)}\n${kv([['cloudflare nameservers', res.nameServers], ['zone status', res.status]])}`, { website: w.id, domainId: d.domainId, nameServers: res.nameServers, status: res.status });
  },
});

export const tools: ToolDef[] = [domainsList, domainAdd, domainSetPrimary, domainRemove, domainDnsStatus, domainDnsQuery, domainDnsRecords, domainSslGet, domainSslIssue, domainSetForceSsl, cloudflareKeysList, domainCloudflareConnect, domainCloudflareNameservers];
