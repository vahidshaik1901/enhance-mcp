import type { components } from '../../src/client/generated/types.js';
import type { Route } from '../helpers/fakeFetch.js';

type DnsZone = components['schemas']['DnsZone'];

export const PANEL_URL = 'https://panel.test';
export const TOKEN = 'testtoken.payload.signature';
export const ORG_ID = '98071de9-291f-4bc4-82e8-b3d1da46d19e';
export const PARENT_ORG_ID = 'eaea6c26-9c43-4e58-bb3b-149bac236463';
export const WEBSITE_ID = '6106382b-143f-4d24-9bea-0e9368ad2a1f';
export const DOMAIN_ID = 'ae7dbbff-a477-417a-adfb-5e09190f052c';
export const PREVIEW_DOMAIN_ID = '469237d9-bb87-4282-80d5-d66f0ce6ac52';
export const SERVER_IP = '65.98.32.45';

export const memberships = {
  memberships: [
    { memberId: '49334cbc-774a-48d0-985e-176adb519ad1', orgId: ORG_ID, orgName: 'Shaik Vahid', isMasterOrg: false, roles: ['Owner'], siteAccessCount: 0 },
  ],
};

export const twoMemberships = {
  memberships: [
    ...memberships.memberships,
    { memberId: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222', orgName: 'Second Org', isMasterOrg: false, roles: ['SuperAdmin'], siteAccessCount: 0 },
  ],
};

export const login = { id: '84d3f51f-e896-471e-8801-7cb32ba45b66', name: 'Shaik Vahid', email: 'owner@example.com', colorCode: '9C6C33', registeredAt: '2026-08-27T05:42:06.841597Z', authMethod: 'basic', locale: 'en' };

export const org = { id: ORG_ID, parentId: PARENT_ORG_ID, name: 'Shaik Vahid', status: 'active', createdAt: '2026-08-27T05:42:06.673121Z', owner: 'Shaik Vahid', ownerEmail: 'owner@example.com', ownerId: '49334cbc-774a-48d0-985e-176adb519ad1', ownerLoginId: '84d3f51f-e896-471e-8801-7cb32ba45b66', subscriptionsCount: 2, websitesCount: 1, locale: 'en' };

export const subscriptions = {
  items: [
    {
      id: 664, planId: 4, planName: 'Max [Shared Webhosting]', subscriberId: ORG_ID, vendorId: PARENT_ORG_ID, status: 'active', planType: 'shared',
      resources: [
        { name: 'diskspace', total: 100000000000, usage: 0 }, { name: 'websites', total: 50, usage: 0 }, { name: 'stagingWebsites', total: 200, usage: 0 },
        { name: 'mailboxes', total: 50, usage: 0 }, { name: 'mysqlDbs', total: null, usage: 0 },
      ],
      allowances: [{ name: 'featureSSH' }, { name: 'featureDNSEditor' }, { name: 'featureWebsiteClone' }, { name: 'backupsAllowSelfRestore' }, { name: 'featureSelfInstallSSL' }],
      selections: [], allowedPhpVersions: [], defaultPhpVersion: 'php81', redisAllowed: true, friendlyName: 'Max [Shared Webhosting]', persistentAppsAllowed: true, allowedApps: ['wordpress', 'joomla'],
    },
    {
      id: 686, planId: 91, planName: 'DMax', subscriberId: ORG_ID, vendorId: PARENT_ORG_ID, status: 'active', planType: 'dedicated',
      resources: [{ name: 'diskspace', total: null, usage: 6322 }, { name: 'websites', total: null, usage: 1 }, { name: 'stagingWebsites', total: null, usage: 0 }],
      allowances: [{ name: 'featureSSH' }, { name: 'backupsAllowManual' }], selections: [], allowedPhpVersions: [], defaultPhpVersion: 'php81', redisAllowed: true, friendlyName: 'DMax', persistentAppsAllowed: true,
    },
  ],
  total: 2,
};

export const websiteSummary = {
  id: WEBSITE_ID,
  domain: { id: DOMAIN_ID, domain: 'vahi.dev', documentRoot: 'public_html', kind: 'primary', cloudflareStatus: 'Disconnected' },
  aliases: [{ id: PREVIEW_DOMAIN_ID, domain: 'vahi-dev-ccyq.sgp1.mystaging.site', documentRoot: 'public_html', kind: 'preview', cloudflareStatus: 'Disconnected' }],
  subdomains: [], subscriptionId: 686, planId: 91, plan: 'DMax', status: 'active', colorCode: '6E39AF', tags: [], size: 6322, orgId: ORG_ID, kind: 'normal', createdAt: '2026-09-04T01:14:32.476922Z', phpVersion: 'php84',
};

export const websitesList = { items: [websiteSummary], total: 1 };

export const websiteDetail = {
  ...websiteSummary,
  unixUser: 'vahi_dev1',
  siteAccessMembers: [],
  serverIps: [{ ip: SERVER_IP, isPrimary: true }],
  backupServerIps: [{ ip: '185.149.115.19', isPrimary: true }],
  dbServerIps: [{ ip: SERVER_IP, isPrimary: true }],
  postgresqlServerIps: [{ ip: SERVER_IP, isPrimary: true }],
  emailServerIps: [{ ip: SERVER_IP, isPrimary: true }],
  filerdAddress: '/filerd/eeb96869-a7f6-4804-b256-a4f5735fe4fa',
  ssh: false,
  canUse: { fileManager: true, ftp: true, phpVersions: ['php74', 'php80', 'php81', 'php82', 'php83', 'php84', 'php85'], redis: true, modSec: false, backup: true, mysqlKind: 'mariaDbLts', persistentApps: true, roundcubeSso: false, postgresql: false },
};

export const domainMappings = {
  items: [
    { domain: 'vahi.dev', domainId: DOMAIN_ID, websiteId: WEBSITE_ID, mappingKind: 'primary', documentRoot: 'public_html', cloudflareStatus: 'Disconnected',
      cert: { cn: 'vahi.dev', expires: '4096-01-01 00:00:00 UTC', issued: '1975-01-01 00:00:00 UTC', issuer: 'vahi.dev', sans: ['vahi.dev', 'www.vahi.dev'], forceHttps: false } },
    { domain: 'vahi-dev-ccyq.sgp1.mystaging.site', domainId: PREVIEW_DOMAIN_ID, websiteId: WEBSITE_ID, mappingKind: 'preview', documentRoot: 'public_html', cloudflareStatus: 'Disconnected' },
  ],
};

export const sslPlaceholder = { cn: 'vahi.dev', expires: '4096-01-01 00:00:00 UTC', issued: '1975-01-01 00:00:00 UTC', issuer: 'vahi.dev', sans: ['vahi.dev', 'www.vahi.dev'], forceHttps: false, cert: '-----BEGIN CERTIFICATE-----\nMIIB...' };
export const sslReal = { cn: 'vahi.dev', expires: '2026-12-03 00:00:00 UTC', issued: '2026-09-04 00:00:00 UTC', issuer: "Let's Encrypt", sans: ['vahi.dev', 'www.vahi.dev'], forceHttps: true, cert: '-----BEGIN CERTIFICATE-----\nMIIF...' };

export const sshKeys = { items: [{ id: '0', name: 'claude-mcp-test', createdAt: '2026-09-04T12:57:04Z', value: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIO/0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }] };

export const branding = {
  orgName: 'Administrator', parent: null, controlPanelDomain: 'panel.test', phpMyAdminDomain: 'phpmyadmin.panel.test', roundcubeDomain: null,
  nameServers: ['ns1.stableserver.net', 'ns2.stableserver.net', 'ns3.stableserver.net', 'ns4.stableserver.net'], settings: [], stagingDomain: 'sgp1.mystaging.site', locale: 'en',
};
export const brandingNoStaging = { ...branding, stagingDomain: null };

export const authNsCloudflare = { matchesPlatform: true, authNs: [{ name: 'sofia.ns.cloudflare.com.', ips: [] }, { name: 'terin.ns.cloudflare.com.', ips: [] }] };
export const authNsPlatform = { matchesPlatform: true, authNs: [{ name: 'ns1.stableserver.net.', ips: ['1.2.3.4'] }, { name: 'ns2.stableserver.net.', ips: ['1.2.3.5'] }] };
export const authNsOther = { matchesPlatform: false, authNs: [{ name: 'dns1.registrar-servers.com.', ips: [] }] };

export const dnsZone = {
  origin: 'vahi.dev',
  soa: { adminEmail: 'admin.vahi.dev.', nameServer: 'ns1.stableserver.net.', expire: 86400, refresh: 1400, retry: 7200, ttl: 1400 },
  records: [
    { id: 'r1', kind: 'A', name: '@', value: SERVER_IP, proxy: false },
    { id: 'r2', kind: 'A', name: 'mail', value: SERVER_IP, proxy: false },
    { id: 'r3', kind: 'A', name: 'mysql', value: SERVER_IP, proxy: false },
    { id: 'r4', kind: 'CNAME', name: 'www', value: 'vahi.dev.', proxy: false },
    { id: 'r5', kind: 'CNAME', name: 'ftp', value: 'vahi.dev.', proxy: false },
    { id: 'r6', kind: 'CNAME', name: 'imap', value: 'mail.vahi.dev.', proxy: false },
    { id: 'r7', kind: 'CNAME', name: 'pop', value: 'mail.vahi.dev.', proxy: false },
    { id: 'r8', kind: 'CNAME', name: 'smtp', value: 'mail.vahi.dev.', proxy: false },
    { id: 'r9', kind: 'MX', name: '@', value: '0 mail.vahi.dev.', proxy: false },
    { id: 'r10', kind: 'TXT', name: '@', value: 'v=spf1 +a +mx include:spf.example.com ~all', ttl: 86400, proxy: false },
    { id: 'r11', kind: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=none;', proxy: false },
    { id: 'r12', kind: 'NS', name: '@', value: 'ns1.stableserver.net.', proxy: false },
    { id: 'r13', kind: 'NS', name: '@', value: 'ns2.stableserver.net.', proxy: false },
  ],
  // `satisfies` (rather than a type annotation) checks this against the generated DnsZone shape
  // while keeping each record's `kind` narrowed to its literal ("A", "CNAME", ...) instead of
  // widening to `string`, which callers that take a typed `DnsRecord[]` (e.g.
  // filterZoneForThirdParty) need.
} satisfies DnsZone;

export const activities = {
  total: 1,
  items: [
    {
      id: '3725a89b-633a-4145-84fc-20c28e2b2220', orgId: ORG_ID, kind: 'added',
      activityObject: { type: 'website', content: { id: WEBSITE_ID, detail: { ok: { orgId: ORG_ID, domain: 'vahi.dev', subscriptionId: 686 } } } },
      context: { actor: { type: 'login', content: { id: '84d3f51f-e896-471e-8801-7cb32ba45b66', detail: { ok: { name: 'Shaik Vahid', email: 'owner@example.com', realmId: PARENT_ORG_ID } } } } },
      message: null, createdAt: '2026-09-04T01:14:33.714646Z',
    },
  ],
};

export const accessTokens = [
  { id: 'd2314fff-4aec-4ebc-833d-7cf758a60809', firstFive: 'testt', roles: ['SuperAdmin'], tokenExpires: '2026-12-31T00:00:00Z', friendlyName: 'claude-mcp-test', allowedIps: [], ipRestricted: false },
];

/** The three routes every website-scoped tool needs: the list and detail the resolver walks, and
 *  the domain mappings. Spread it into `makeContext` and add the routes under test. */
export const base = (): Route[] => [
  { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: websitesList },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: websiteDetail },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains`, body: domainMappings },
];

export const MYSQL_DB = 'vahi_dev1_demo';

export const mysqlDbs = {
  items: [{ name: MYSQL_DB, size: 40960, createdAt: '2026-09-05T15:00:34.000100Z', websiteId: WEBSITE_ID, serverId: '4b5f6a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b', userCount: 1 }],
};

export const APP_ID = '54bd4d05-4f8e-4291-a507-9be9e8424a89';

/** One panel-managed Node app, the shape `GET /websites/{id}/apps/persistent` returns. The
 *  command is an npm script because the panel exec's the command as argv without a shell
 *  (verified live), so a `PORT=3000` prefix or a quoted argument would never work. */
export const persistentApp = {
  id: APP_ID,
  appKind: 'generic',
  command: 'npm start',
  workingDirectory: 'nodeapp',
  startMode: 'automatic',
  nodeVersion: '22.23.2',
  proxyDetails: { path: 'node', port: 3000, allowWebSocketUpgrade: false },
};

export const persistentApps = [persistentApp];
