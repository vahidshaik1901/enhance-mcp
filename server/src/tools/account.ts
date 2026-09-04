import * as z from 'zod/v4';
import { redactSecret } from '../config.js';
import { requireOrg } from '../core/context.js';
import { identityBlock } from '../core/identity.js';
import { defineTool, type ToolDef } from '../core/registry.js';
import { kv, ok, table } from '../core/respond.js';

const DAY_MS = 86_400_000;

export const authStatus = defineTool({
  name: 'auth_status',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only. Shows who the credential is, which org is active, whether it is a Bearer access token or a panel session, token roles and expiry, and the panel version. Run this first whenever a call returns unauthorized.',
  input: z.object({}),
  async handler(_args, ctx) {
    const { client, config } = ctx;
    const version = await client.call('GET', '/version', () => client.api.GET('/version'));
    const login = await client.call('GET', '/login', () => client.api.GET('/login'));
    const warnings: string[] = [];
    let credential = 'panel session credential (browser session; ends on logout or timeout; create an access token under Settings > Access Tokens for anything long-lived)';
    let token: Record<string, unknown> | undefined;
    if (client.authMode === 'bearer' && client.orgId) {
      const org = client.orgId;
      const tokens = await client.call('GET', '/orgs/{org_id}/access_tokens', () => client.api.GET('/orgs/{org_id}/access_tokens', { params: { path: { org_id: org } } }));
      const mine = tokens.find((t) => config.token.startsWith(t.firstFive));
      if (mine) {
        token = { id: mine.id, friendlyName: mine.friendlyName, roles: mine.roles, tokenExpires: mine.tokenExpires ?? null, ipRestricted: mine.ipRestricted ?? false };
        credential = `Bearer access token "${mine.friendlyName ?? '(unnamed)'}" · roles: ${mine.roles.join(', ')} · expires: ${mine.tokenExpires ?? 'never'}`;
        if (mine.tokenExpires) {
          const left = new Date(mine.tokenExpires).getTime() - Date.now();
          if (left < 7 * DAY_MS) warnings.push(left < 0 ? 'The access token has expired.' : `The access token expires in ${Math.ceil(left / DAY_MS)} day(s). Create a new one soon.`);
        }
      } else {
        credential = 'Bearer access token (not listed in this org; it may belong to a parent org)';
      }
    } else if (client.authMode === 'cookie') {
      warnings.push('Using a panel session credential. It can stop working at any time; prefer an access token.');
    }
    const orgLine = client.orgId ? identityBlock({ name: client.orgName, id: client.orgId }) : `org: none selected (${client.memberships.length} memberships; set ENHANCE_ORG_ID)`;
    const text = [
      orgLine,
      kv([
        ['panel', config.panelUrl],
        ['panel version', version],
        ['login', `${login.name} <${login.email}>`],
        ['credential', credential],
        ['credential prefix', redactSecret(config.token)],
        ['tiers', config.tiers.join(', ')],
        ['read-only', config.readOnly ? 'yes' : 'no'],
      ]),
      'memberships:',
      table(client.memberships.map((m) => ({ org: m.orgName, id: m.orgId, roles: m.roles, master: m.isMasterOrg ? 'yes' : 'no' })), ['org', 'id', 'roles', 'master']),
      warnings.length ? `warnings:\n- ${warnings.join('\n- ')}` : undefined,
    ].filter(Boolean).join('\n');
    return ok(text, { version, authMode: client.authMode, login: { id: login.id, name: login.name, email: login.email }, org: client.orgId ? { id: client.orgId, name: client.orgName } : null, memberships: client.memberships, token: token ?? null, readOnly: config.readOnly, tiers: config.tiers, warnings });
  },
});

function quota(total: number | null | undefined, usage: number | undefined): string {
  return `${usage ?? 0}/${total === null || total === undefined ? 'unlimited' : total}`;
}

export const subscriptionsList = defineTool({
  name: 'subscriptions_list',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only. Lists the org\'s hosting subscriptions with plan name, quotas (websites, staging sites, disk, mailboxes, databases), feature allowances such as featureSSH, allowed apps and PHP versions. Use it to pick a subscription for website_create and to know what a plan permits.',
  input: z.object({}),
  async handler(_args, ctx) {
    const { client } = ctx;
    const org = requireOrg(client);
    const res = await client.call('GET', '/orgs/{org_id}/subscriptions', () => client.api.GET('/orgs/{org_id}/subscriptions', { params: { path: { org_id: org } } }));
    const items = res.items.map((s) => {
      const r = Object.fromEntries(s.resources.map((x) => [x.name, { total: x.total ?? null, usage: x.usage }]));
      return {
        id: s.id, planId: s.planId, planName: s.planName, planType: s.planType, status: s.status,
        resources: r, allowances: s.allowances.map((a) => a.name), allowedApps: s.allowedApps ?? null,
        allowedPhpVersions: s.allowedPhpVersions, defaultPhpVersion: s.defaultPhpVersion, persistentAppsAllowed: s.persistentAppsAllowed, redisAllowed: s.redisAllowed,
      };
    });
    const blocks = items.map((s) =>
      [
        `subscription ${s.id} · ${s.planName} (plan ${s.planId}, ${s.planType}, ${s.status})`,
        kv([
          ['websites', quota(s.resources['websites']?.total, s.resources['websites']?.usage)],
          ['staging websites', quota(s.resources['stagingWebsites']?.total, s.resources['stagingWebsites']?.usage)],
          ['disk (bytes)', quota(s.resources['diskspace']?.total, s.resources['diskspace']?.usage)],
          ['mailboxes', quota(s.resources['mailboxes']?.total, s.resources['mailboxes']?.usage)],
          ['mysql databases', quota(s.resources['mysqlDbs']?.total, s.resources['mysqlDbs']?.usage)],
          ['allowances', s.allowances.join(', ')],
          ['allowed apps', s.allowedApps ? s.allowedApps.join(', ') : 'all'],
          ['php', `default ${s.defaultPhpVersion}${s.allowedPhpVersions.length ? `, allowed ${s.allowedPhpVersions.join(', ')}` : ''}`],
          ['node / persistent apps', s.persistentAppsAllowed ? 'allowed' : 'not allowed'],
          ['redis', s.redisAllowed ? 'allowed' : 'not allowed'],
        ]),
      ].join('\n'),
    );
    return ok([identityBlock({ name: client.orgName, id: org }), ...blocks].join('\n\n'), { items, total: res.total });
  },
});

function describeActivity(a: { kind: string; createdAt: string; activityObject?: unknown; context?: unknown; message?: string | null }): Record<string, unknown> {
  const obj = a.activityObject as { type?: string; content?: { id?: string; detail?: { ok?: { domain?: string; name?: string; email?: string } } } } | undefined;
  const actor = (a.context as { actor?: { type?: string; content?: { detail?: { ok?: { name?: string; email?: string; friendlyName?: string } } } } } | undefined)?.actor;
  const detail = obj?.content?.detail?.ok;
  const object = obj?.type ? `${obj.type} ${detail?.domain ?? detail?.name ?? detail?.email ?? obj.content?.id ?? ''}`.trim() : '-';
  const who = actor?.content?.detail?.ok;
  return { at: a.createdAt, kind: a.kind, object, actor: who ? `${who.name ?? who.friendlyName ?? ''}${who.email ? ` <${who.email}>` : ''}`.trim() : actor?.type ?? '-', message: a.message ?? '' };
}

export const activityLog = defineTool({
  name: 'activity_log',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only. Shows the panel\'s own audit trail for this org: websites added or removed, backups, errors, with who did it. Use it to verify what a previous action did or to investigate a surprise.',
  input: z.object({
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
    entity_kind: z.enum(['website', 'login', 'org', 'domain']).optional(),
    search: z.string().optional(),
  }),
  async handler(args, ctx) {
    const { client } = ctx;
    const org = requireOrg(client);
    // `??` fallbacks here (not just the zod `.default()`) because this handler can be invoked
    // directly with a partial args object that bypassed schema parsing (see the test helper).
    const res = await client.call('GET', '/v2/orgs/{org_id}/activities', () =>
      client.api.GET('/v2/orgs/{org_id}/activities', { params: { path: { org_id: org }, query: { limit: args.limit ?? 20, offset: args.offset ?? 0, entityKind: args.entity_kind, search: args.search } } }),
    );
    const rows = res.items.map(describeActivity);
    const offset = args.offset ?? 0;
    return ok([identityBlock({ name: client.orgName, id: org }), `activities ${offset + 1}-${offset + rows.length} of ${res.total}:`, table(rows, ['at', 'kind', 'object', 'actor', 'message'])].join('\n'), { total: res.total, items: rows });
  },
});

export const platformInfo = defineTool({
  name: 'platform_info',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only. Platform facts the customer needs for DNS and verification: the platform nameservers to point a registrar at, whether preview domains are available and their suffix, the control panel and phpMyAdmin hosts.',
  input: z.object({}),
  async handler(_args, ctx) {
    const { client } = ctx;
    const b = await client.call('GET', '/branding', () => client.api.GET('/branding', { params: { query: { orgId: client.orgId } } }));
    const stagingDomain = b.stagingDomain ?? null;
    const text = kv([
      ['platform nameservers', b.nameServers ?? []],
      ['preview domains', stagingDomain ? `available (*.${stagingDomain})` : 'not configured by the provider; verify deploys with curl --resolve against the app server IP'],
      ['control panel', b.controlPanelDomain],
      ['phpMyAdmin', b.phpMyAdminDomain],
      ['webmail', b.roundcubeDomain],
    ]);
    return ok(text, { nameServers: b.nameServers ?? [], stagingDomain, previewDomainsAvailable: Boolean(stagingDomain), controlPanelDomain: b.controlPanelDomain ?? null, phpMyAdminDomain: b.phpMyAdminDomain ?? null, roundcubeDomain: b.roundcubeDomain ?? null });
  },
});

const CHECK_TEXT: Record<string, string> = {
  notInUse: 'The domain is free on this platform and can be created here with website_create.',
  inUseCurrentOrg: 'There is already a website in this org for this domain. Use it instead of creating a new one.',
  inUseAnotherOrg: 'The domain is in use by another org on this platform. It cannot be created here; contact the hosting provider if you own it.',
  inUseDeletedSite: 'A deleted website still holds this domain. The provider can restore that site; a new one cannot be created until it is purged.',
  prohibited: 'The platform prohibits this domain (reserved or blocked). Choose another.',
};

export const domainCheck = defineTool({
  name: 'domain_check',
  tier: 'customer',
  risk: 'read',
  description: 'Read-only preflight: can this domain be added as a website here? Returns notInUse, inUseCurrentOrg (with the website id), inUseAnotherOrg, inUseDeletedSite, or prohibited. Always call it before website_create.',
  input: z.object({ domain: z.string().min(3).transform((d) => d.trim().toLowerCase()) }),
  async handler({ domain }, ctx) {
    const { client } = ctx;
    const org = requireOrg(client);
    const res = await client.call('POST', '/orgs/{org_id}/domains/check', () => client.api.POST('/orgs/{org_id}/domains/check', { params: { path: { org_id: org } }, body: { domain } }));
    const text = [identityBlock({ name: client.orgName, id: org }), `domain: ${domain}`, `status: ${res.status}`, CHECK_TEXT[res.status] ?? 'Unknown status.', res.websiteId ? `website id: ${res.websiteId}` : undefined].filter(Boolean).join('\n');
    return ok(text, { domain, status: res.status, websiteId: res.websiteId ?? null });
  },
});

export const tools: ToolDef[] = [authStatus, subscriptionsList, activityLog, platformInfo, domainCheck];
