import * as z from 'zod/v4';
import { parseScalarText } from '../client/client.js';
import type { ToolContext } from '../core/context.js';
import { requireOrg } from '../core/context.js';
import { identityBlock, previewDomain, websiteHome } from '../core/identity.js';
import { defineTool, type ToolDef } from '../core/registry.js';
import { fail, kv, ok, safe, table } from '../core/respond.js';
import type { Website } from '../core/resolver.js';
import { confirmedByReadNote, describeError, unknownOutcome, writeThenVerify } from '../core/verify.js';

export const PHP_VERSIONS = ['php52', 'php53', 'php54', 'php55', 'php56', 'php70', 'php71', 'php72', 'php73', 'php74', 'php80', 'php81', 'php82', 'php83', 'php84', 'php85'] as const;

const websiteArg = z.string().min(1).describe('Website domain name (primary or alias) or website UUID');

function serverIp(w: Website): string | undefined {
  return (w.serverIps?.find((s) => s.isPrimary) ?? w.serverIps?.[0])?.ip;
}

/** `CanUse` mixes boolean feature flags with non-boolean fields (phpVersions, mysqlKind); keep only the flags. */
function canUseFlags(w: Website): Array<[string, boolean]> {
  const can = w.canUse;
  if (!can) return [];
  return Object.entries(can).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean');
}

export const websitesList = defineTool({
  name: 'websites_list',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only. Lists websites in the org with domain, id, status, PHP version, plan, subscription and aliases. Supports search and paging.',
  input: z.object({ search: z.string().optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }),
  async handler(args, ctx) {
    const { client } = ctx;
    const org = requireOrg(client);
    const res = await client.call('GET', '/orgs/{org_id}/websites', () =>
      client.api.GET('/orgs/{org_id}/websites', { params: { path: { org_id: org }, query: { showAliases: true, search: args.search, limit: args.limit, offset: args.offset, sortBy: 'domain', sortOrder: 'asc' } } }),
    );
    const rows = res.items.map((w) => ({ domain: w.domain.domain, id: w.id, status: w.status, php: w.phpVersion, kind: w.kind, plan: w.plan, subscription: w.subscriptionId, aliases: w.aliases.map((a) => `${a.domain} (${a.kind})`) }));
    return ok([identityBlock({ name: client.orgName, id: org }), `websites ${args.offset + 1}-${args.offset + rows.length} of ${res.total}:`, table(rows, ['domain', 'id', 'status', 'php', 'kind', 'plan', 'subscription', 'aliases'])].join('\n'), { total: res.total, items: rows });
  },
});

function websiteText(ctx: ToolContext, w: Website): string {
  const flags = canUseFlags(w);
  return [
    identityBlock({ name: ctx.client.orgName, id: w.orgId }, w),
    kv([
      ['status', `${w.status}${w.kind !== 'normal' ? ` · ${w.kind}` : ''}`],
      ['plan', w.plan ? `${w.plan} (subscription ${w.subscriptionId})` : undefined],
      ['php', w.phpVersion],
      ['unix user', w.unixUser],
      ['home', websiteHome(w)],
      ['document root', `${websiteHome(w)}/${w.domain.documentRoot}`],
      ['app server ip', serverIp(w)],
      ['preview domain', previewDomain(w)],
      // `ssh` is not part of the generated Website response type (it is only a PATCH request
      // field to toggle the PHP-CD SSH daemon); narrowly cast in case the panel ever echoes it.
      ['ssh flag', (w as { ssh?: boolean }).ssh === undefined ? undefined : String((w as { ssh?: boolean }).ssh)],
      ['size (bytes)', w.size],
      ['created', w.createdAt],
      ['can use', flags.filter(([, v]) => v).map(([k]) => k)],
      ['cannot use', flags.filter(([, v]) => !v).map(([k]) => k)],
      ['php versions', w.canUse?.phpVersions],
      ['mysql', w.canUse?.mysqlKind],
    ]),
    'domains:',
    table([{ domain: w.domain.domain, kind: w.domain.kind, docroot: w.domain.documentRoot, id: w.domain.id }, ...w.aliases.map((a) => ({ domain: a.domain, kind: a.kind, docroot: a.documentRoot, id: a.id }))], ['domain', 'kind', 'docroot', 'id']),
  ].join('\n');
}

export const websiteGet = defineTool({
  name: 'website_get',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only. Full detail of one website by domain or id: status, PHP, plan, unix user, home and document root, app server IP, preview domain, capabilities (canUse), and all mapped domains. Start here before any deploy.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const w = await ctx.resolver.resolveWebsite(website);
    return ok(websiteText(ctx, w), { website: w, home: websiteHome(w), previewDomain: previewDomain(w) ?? null, serverIp: serverIp(w) ?? null });
  },
});

/** Live 2026-09-17: four parallel creates, two client-side timeouts at 30 s, and the panel finished
 *  both sites anyway. The panel keeps working long after the client gives up, so the re-reads cover
 *  a long window, spaced so they cost one request every 5 s. */
const WEBSITE_CREATE_WINDOW_MS = 90_000;
const WEBSITE_CREATE_INTERVAL_MS = 5_000;

function nextSteps(domain: string): string {
  return ['next steps:', `1. DNS: domain_dns_status website=${domain} (point the registrar at the platform nameservers or add the A record; the preview domain works meanwhile).`, `2. SSL: domain_ssl_issue website=${domain} once DNS resolves.`, `3. SSH: ssh_key_add website=${domain} public_key=<your key>, then ssh_connection_info.`].join('\n');
}

export const websiteCreate = defineTool({
  name: 'website_create',
  tier: 'customer',
  risk: 'write',
  description: 'Creates a new website for a domain. Runs domain_check first and refuses if the domain is in use. Picks the subscription automatically when exactly one has free website quota; otherwise requires subscription_id (see subscriptions_list). Returns the new site and the next steps (DNS, SSL, SSH).',
  input: z.object({
    domain: z
      .string()
      .transform((d) => d.trim().toLowerCase())
      .refine((d) => d.length >= 3 && /^[a-z0-9.-]+$/.test(d), { error: 'domain must be a hostname (letters, digits, dots, hyphens)' }),
    subscription_id: z.number().int().optional(),
    php_version: z.enum(PHP_VERSIONS).optional(),
  }),
  async handler(args, ctx) {
    const { client } = ctx;
    const org = requireOrg(client);
    const id = identityBlock({ name: client.orgName, id: org });
    // The pre-check and every re-read after an unclear create ask the panel the same question.
    const checkDomain = () => client.call('POST', '/orgs/{org_id}/domains/check', () => client.api.POST('/orgs/{org_id}/domains/check', { params: { path: { org_id: org } }, body: { domain: args.domain } }));
    const check = await checkDomain();
    if (check.status !== 'notInUse') {
      return fail(
        [id, `Cannot create ${safe(args.domain)}: domain_check returned ${safe(check.status)}${check.websiteId ? ` (website ${check.websiteId})` : ''}.`, check.status === 'inUseCurrentOrg' ? 'It is already a website in this org; use website_get.' : undefined].filter(Boolean).join('\n'),
        { status: check.status, websiteId: check.websiteId ?? null },
      );
    }
    const subs = await client.call('GET', '/orgs/{org_id}/subscriptions', () => client.api.GET('/orgs/{org_id}/subscriptions', { params: { path: { org_id: org } } }));
    // Convention 14: no `websites` resource entry means websites are not included in the plan, so
    // the subscription is not eligible. Only `total === null` means unlimited.
    const eligible = subs.items.filter((s) => {
      const q = s.resources.find((r) => r.name === 'websites');
      return s.status === 'active' && q !== undefined && (q.total === null || q.total === undefined || q.usage < q.total);
    });
    let subscriptionId = args.subscription_id;
    if (subscriptionId === undefined) {
      if (eligible.length === 1) subscriptionId = eligible[0]!.id;
      else {
        const list = eligible.map((s) => `${s.id} (${safe(s.planName)})`).join(', ') || 'none with free website quota';
        return fail([id, `Pass subscription_id. Eligible subscriptions: ${list}.`].join('\n'), { eligible: eligible.map((s) => ({ id: s.id, planName: s.planName })) });
      }
    } else if (!eligible.some((s) => s.id === subscriptionId)) {
      return fail([id, `Subscription ${subscriptionId} is not active with free website quota. Eligible: ${eligible.map((s) => s.id).join(', ') || 'none'}.`].join('\n'));
    }
    const outcome = await writeThenVerify({
      write: () => client.call('POST', '/orgs/{org_id}/websites', () => client.api.POST('/orgs/{org_id}/websites', { params: { path: { org_id: org } }, body: { domain: args.domain, subscriptionId, ...(args.php_version ? { phpVersion: args.php_version } : {}) } })),
      // domain_check said notInUse a moment ago, so a website of this org that holds the domain now
      // is the one this call created.
      find: async () => {
        const again = await checkDomain();
        return again.status === 'inUseCurrentOrg' && again.websiteId ? again.websiteId : undefined;
      },
      windowMs: WEBSITE_CREATE_WINDOW_MS,
      intervalMs: WEBSITE_CREATE_INTERVAL_MS,
      sleep: ctx.sleep,
    });
    // Whatever happened, the website list may have changed under the resolver's cache.
    ctx.resolver.invalidate();
    const domain = safe(args.domain);
    if (outcome.state === 'unknown') {
      return unknownOutcome(id, outcome, { action: `the create of website ${domain}`, settle: `domain_check domain=${domain} (inUseCurrentOrg with a website id means it exists; then website_get)` }, { created: null, domain: args.domain });
    }
    const websiteId = outcome.confirmedBy === 'response' ? outcome.written.id : outcome.found;
    const confirmed = outcome.confirmedBy === 'verify' ? confirmedByReadNote(outcome.writeError) : undefined;
    let w: Website;
    try {
      w = await ctx.resolver.getWebsite(websiteId);
    } catch (e) {
      // The website exists; only the read that renders it failed. Reporting that as an error would
      // tell the caller nothing was created and invite a second create of the same domain.
      return ok(
        [id, `website ${domain} created (id ${websiteId}).`, confirmed, `Reading it back failed (${describeError(e)}); run website_get website=${websiteId} for its details.`, nextSteps(domain)].filter(Boolean).join('\n'),
        { created: true, websiteId, confirmedBy: outcome.confirmedBy, website: null },
      );
    }
    return ok([websiteText(ctx, w), confirmed, nextSteps(safe(w.domain.domain))].filter(Boolean).join('\n'), { created: true, websiteId: w.id, confirmedBy: outcome.confirmedBy, website: w, home: websiteHome(w), previewDomain: previewDomain(w) ?? null, serverIp: serverIp(w) ?? null });
  },
});

export const websiteSetPhpVersion = defineTool({
  name: 'website_set_php_version',
  tier: 'customer',
  risk: 'write',
  description: 'Changes the PHP version of a website (php74 … php85). Only versions listed in website_get canUse.phpVersions are accepted by the panel.',
  input: z.object({ website: websiteArg, php_version: z.enum(PHP_VERSIONS) }),
  async handler({ website, php_version }, ctx) {
    const { client } = ctx;
    const org = requireOrg(client);
    const w = await ctx.resolver.resolveWebsite(website);
    await client.call('PATCH', '/orgs/{org_id}/websites/{website_id}', () => client.api.PATCH('/orgs/{org_id}/websites/{website_id}', { params: { path: { org_id: org, website_id: w.id } }, body: { phpVersion: php_version } }));
    ctx.resolver.invalidate();
    const previous = w.phpVersion ? safe(w.phpVersion) : 'unknown';
    // Convention 13: render the state after the write, so the identity line shows the new version.
    return ok(`${identityBlock({ name: client.orgName, id: org }, { ...w, phpVersion: php_version })}\nphp version set to ${php_version} (was ${previous}).`, { website: w.id, phpVersion: php_version, previous: w.phpVersion ?? null });
  },
});

export const websiteRestartPhp = defineTool({
  name: 'website_restart_php',
  tier: 'customer',
  risk: 'write',
  description: 'Restarts the PHP container of a website. Use after changing php.ini or extensions, or when OPcache holds stale code after a deploy. Brief interruption.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const { client } = ctx;
    const w = await ctx.resolver.resolveWebsite(website);
    await client.call('POST', '/v2/websites/{website_id}/restart_php', () => client.api.POST('/v2/websites/{website_id}/restart_php', { params: { path: { website_id: w.id } } }));
    return ok(`${identityBlock({ name: client.orgName, id: w.orgId }, w)}\nphp container restarted.`, { website: w.id, restarted: true });
  },
});

export const websitePreviewDomain = defineTool({
  name: 'website_preview_domain',
  tier: 'customer',
  risk: 'write',
  description: 'Returns the website\'s preview URL (a *.<stagingDomain> alias that works before DNS points at the site), creating it if the provider allows. When the provider has no staging domain it returns available=false with a curl --resolve fallback instead of failing. Idempotent.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const { client } = ctx;
    const org = requireOrg(client);
    const w = await ctx.resolver.resolveWebsite(website);
    const existing = previewDomain(w);
    const id = identityBlock({ name: client.orgName, id: org }, w);
    const ip = safe(serverIp(w) ?? '<app-server-ip>');
    // A preview host created minutes ago can take about five minutes to resolve (verified live
    // 2026-09-05); the vhost itself is ready at once, so give the --resolve check for the gap.
    const propagation = (domain: string) => `if curl cannot resolve the host yet, the record is still propagating (a few minutes after creation); verify meanwhile with: curl -k --resolve ${domain}:443:${ip} https://${domain}/`;
    if (existing) {
      const domain = safe(existing);
      return ok(`${id}\npreview domain: ${domain} (existing)\nverify with: curl -I https://${domain}/\n${propagation(domain)}`, { available: true, previewDomain: existing, created: false });
    }
    const b = await client.call('GET', '/branding', () => client.api.GET('/branding', { params: { query: { orgId: org } } }));
    if (!b.stagingDomain) {
      const d = safe(w.domain.domain);
      return ok([id, 'preview domain: not available (the provider has not configured a staging domain).', 'verify deploys against the app server directly instead:', `  curl -k --resolve ${d}:443:${ip} https://${d}/`, `  browser: add "${ip} ${d}" to /etc/hosts temporarily`].join('\n'), { available: false, previewDomain: null, created: false, fallback: { serverIp: serverIp(w) ?? null, domain: w.domain.domain } });
    }
    // The panel answers this with a bare hostname as text/plain, not a JSON object; read it as
    // text and normalise so a JSON-quoted body works too.
    const raw = await client.call<string>('POST', '/orgs/{org_id}/websites/{website_id}/preview', () => client.api.POST('/orgs/{org_id}/websites/{website_id}/preview', { params: { path: { org_id: org, website_id: w.id } }, parseAs: 'text' }));
    const name = parseScalarText(raw);
    ctx.resolver.invalidate();
    const domain = safe(name);
    return ok(`${id}\npreview domain: ${domain} (created)\nverify with: curl -I https://${domain}/\n${propagation(domain)}`, { available: true, previewDomain: name, created: true });
  },
});

export const websiteDelete = defineTool({
  name: 'website_delete',
  tier: 'customer',
  risk: 'destructive',
  description: 'DESTRUCTIVE. Soft-deletes a website: it goes offline and its domains are released, but the panel keeps the data and the provider can restore it. Requires the user to confirm by typing the domain name. Never wipes data (force delete is not available through this tool).',
  input: z.object({ website: websiteArg }),
  async target({ website }, ctx) {
    const w = await ctx.resolver.resolveWebsite(website);
    return { kind: 'website', id: w.id, name: w.domain.domain };
  },
  async preview({ website }, ctx) {
    const w = await ctx.resolver.resolveWebsite(website);
    return [
      `This will soft-delete website ${safe(w.domain.domain)} (${w.id}).`,
      kv([['aliases', `${w.aliases.length} alias(es): ${w.aliases.map((a) => a.domain).join(', ') || 'none'}`], ['php', w.phpVersion], ['size (bytes)', w.size], ['status', w.status], ['subscription', w.subscriptionId]]),
      'The site goes offline immediately. Files, databases and mailboxes are retained by the panel and can be restored by the hosting provider. Domains become free to reuse only after the provider purges the site.',
    ].join('\n');
  },
  async handler(_args, ctx, target) {
    const { client } = ctx;
    const org = requireOrg(client);
    const id = target!.id;
    await client.call('DELETE', '/orgs/{org_id}/websites/{website_id}', () => client.api.DELETE('/orgs/{org_id}/websites/{website_id}', { params: { path: { org_id: org, website_id: id } } }));
    ctx.resolver.invalidate();
    return ok(`${identityBlock({ name: client.orgName, id: org })}\nwebsite ${safe(target!.name)} (${id}) soft-deleted. The provider can restore it from the panel.`, { website: id, domain: target!.name, deleted: true, soft: true });
  },
});

export const tools: ToolDef[] = [websitesList, websiteGet, websiteCreate, websiteSetPhpVersion, websiteRestartPhp, websitePreviewDomain, websiteDelete];
