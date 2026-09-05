# Enhance research notes (2026-09-04)

## Product

Enhance is a multi-server hosting control panel. Each website runs in its own container.
A cluster has a master (control) server running `orchd`, the orchestrator daemon that
serves the API and the UI, plus servers holding roles: application, database, email,
backup, dns, postgresql. Comparable to cPanel/WHM but container-isolated and API-first.

## API

- Docs UI: https://apidocs.enhance.com/ (Swagger UI).
- Spec: https://apidocs.enhance.com/spec/oas3-api.yaml, `info.title: orchd`,
  `info.version: 12.25.8`.
- Security schemes: `bearerAuth` (http bearer) and `sessionCookie` (cookie `id0`).
  Use bearer only.
- No `servers` block in the spec. Real base is `https://<panel-host>/api`.
- Rate limit roughly 60 req/min per token (community/KB sources, verify on test server).

### Tags and operation counts

| Tag | Ops | Tier |
|---|---|---|
| websites | 80 | customer |
| wordpress | 31 | customer |
| apps (incl. node, persistent, openclaw) | 23 | customer |
| emails + email-client | 25 | customer |
| domains | 16 | customer |
| dns | 15 | customer (zone records); platform (third-party providers, defaults) |
| mysql | 11 | customer |
| postgresql | 9 | customer |
| backups | 12 | customer (org-scoped); platform (`/backups` global) |
| joomla | 7 | customer |
| subscriptions | 6 | customer (read); reseller (write) |
| orgs | 44 | mixed: customer (read own, SSL, activity), reseller (customers, plans, members) |
| customers | 3 | reseller |
| invites | 3 | reseller |
| branding | 21 | reseller |
| members | 3 | reseller |
| logins | 24 | mostly out of scope (session mgmt) |
| importers | 19 | reseller/platform |
| migrations | 6 | platform |
| servers | 82 | platform |
| settings | 35 | platform |
| install, licence, reports | 6 | platform |

### Roles (from enhance.com/docs/account/admin/users-and-roles)

- **Owner**: unrestricted, cannot be deleted.
- **SuperAdmin**: unrestricted except cannot delete Owner.
- **Sysadmin**: servers, services, customers, websites, service and platform settings.
- **Support**: manage customers and customer websites.
- **Business**: packages and branding.
- **SiteAccess / Collaborator**: only the websites they were granted.

Spec descriptions repeat the pattern: "Session holder must be at least a `SuperAdmin`
in this org or a parent org, or be a member in this org that has access to the website."
So a SiteAccess token can operate on its own sites for most website-level endpoints.

### Key schemas

- `NewAccessToken { roles[], tokenExpires?, friendlyName?, allowedIps[]?, ipRestricted? }`
- `LoginMembership { memberId, orgId, orgName, isMasterOrg, roles, siteAccessCount }`
- `NewWebsite { domain*, subscriptionId?, appServerId?, ..., phpVersion?, wordPressAdminCredentials? }`
- `Website { id, domain{id,domain,documentRoot,kind}, aliases[], status(active|disabled|deleted), kind(normal|staging|...), unixUser, serverIps, ... }`
- `UpdateWebsite { phpVersion?, status?, isSuspended?, tags[]?, subscriptionId?, orgId? }`
- `NewSshKey { value*, name? }`  ->  `SshKey { id, createdAt, value, name }`
- `NewWebsiteApp { app(wordpress|joomla|openclaw)*, version?, path?, adminUsername?, adminPassword?, adminEmail?, domainId? }`
- `PersistentApp { startMode(automatic|manual)*, command*, workingDirectory?, nodeVersion?, proxyDetails? }`
- `BackupRestoreOptions { restoreFiles?, restoreOnlyFiles[]?, restoreDatabases[]?, restoreEmails[]?, restoreAllEmails? }`
- `DomainMappingKind: primary|preview|addon|alias|subdomain`
- `PhpVersion: php52..php85`
- `HttpError { code*, detail?, message? }`

### Deploy path candidates

1. `POST /orgs/{org}/websites/{site}/ssh/keys` then `rsync -e ssh` or `git push` to
   `<unixUser>@<serverIp>`. Best: incremental, standard, no size limits.
2. `POST /orgs/{org}/websites/{site}/ftp/users` then SFTP/FTP. Fallback only.
3. `POST /websites/{site}/backup/upload` (tar.gz restore). Whole-site replace; risky.

Also relevant for deploy: `getWebsiteContainerIp`, `getWebsite` (unixUser, serverIps,
documentRoot), `restartWebsitePhp`, `clearDomainNginxFastCgi`, persistent app
create/update/log for Node, `installNvm`/`installNodeVersion`.

## Sources

- https://apidocs.enhance.com/spec/oas3-api.yaml
- https://enhance.com/docs/account/admin/users-and-roles
- https://stackharbor.com/en/knowledge-base/enhance-api-provisioning-automation/
- https://wpemailmanager.com/docs/how-to-obtain-your-enhance-panel-api-token-organization-id/
- No existing Enhance MCP server found on GitHub or the web as of 2026-09-04.

## Live panel probe results (2026-09-04)

Panel `e4500.sgp1.stableserver.net`, orchd 12.25.5. Login is Owner of customer org
`98071de9-291f-4bc4-82e8-b3d1da46d19e` ("Shaik Vahid"), parent org
`eaea6c26-9c43-4e58-bb3b-149bac236463` (the provider's reseller org). Not the master org.

Working with session cookie `id0` (read-only GETs):

| Endpoint | Result |
|---|---|
| /version, /status, /client_ip | 200, no auth needed |
| /login/memberships | 200 with cookie, 403 `unauthorized` with Bearer (cookie is not a token) |
| /login | 200: login id, name, email, authMethod basic |
| /orgs/{org} | 200: parentId, owner, subscriptionsCount 2, websitesCount 1 |
| /orgs/{org}/access_tokens | 200: `[]` (none created yet) |
| /orgs/{org}/subscriptions | 200: two subs with resources, allowances, selections, allowedApps |
| /orgs/{org}/websites | 200: 1 website vahi.dev (php84, sub 686) |
| /orgs/{org}/websites/{id} | 200: full detail incl. unixUser, serverIps, canUse, ssh:false |
| /orgs/{org}/websites/{id}/domains | 200: primary + preview mapping |
| /orgs/{org}/websites/{id}/ssh/keys | 200: `[]` |
| /orgs/{org}/websites/{id}/backups | 200: 1 automatic backup |
| /websites/{id}/container_ip | 200: containerIp 10.169.0.1 |
| /orgs/{org}/domains | 200: includes domains of soft-deleted websites |
| /orgs/{org}/members | 200: 1 Owner |
| /v2/orgs/{org}/activities | 200: structured actor/object events incl. past deletes |
| /servers, /servers/{id}/roles, /licence | 403 `only_mo_allowed` |
| /orgs/{org}/customers, /plans | 403 "Only a reseller or the MO" |

Observations that shape the design:

1. Error bodies are `{code, message?}`; codes are stable strings. Build an error map.
2. `canUse` on website detail is the per-site capability truth. Tools should read it
   before attempting SSH, redis, persistent apps, postgresql, modsec.
3. Subscription `allowances[]` is the plan-level capability truth (featureSSH,
   featureWebsiteClone, backupsAllowSelfRestore, featureDNSEditor, ...).
4. Preview domain `*.sgp1.mystaging.site` is auto-created per website (kind `preview`).
5. Website `ssh` is false until enabled; SSH keys list is empty. Deploy skill needs an
   "enable SSH + authorize key" pre-step.
6. Backup ids are epoch-millisecond integers, not UUIDs.

## Panel UI network capture: website "Developer tools" page (2026-09-04)

Captured with Claude in Chrome on `/websites/{id}/devtools`. All GET, all under `/api`.
No dedicated endpoint exists for the SSH login details: the UI builds
`ssh -p 22 <unixUser>@<serverIps[0].ip>` from `GET /orgs/{org}/websites/{id}`. The
password field is a placeholder; the password is write-only via `POST .../ssh/password`.
Clicking "SSH password authentication" in the side nav fires no request.

Shell/session bootstrap calls:
`/status`, `/login`, `/login/memberships`, `/logins/ui-preferences` (404 when unset),
`/branding?orgId=`, `/v2/settings/demo_mode`, `/orgs/{org}/subscriptions`,
`/v2/orgs/{org}/import`, `/orgs/{org}/websites`,
`/orgs/{org}/websites?sortBy=domain&sortOrder=asc&recursion=directCustomers`.

Website page calls:
`/orgs/{org}/websites/{id}`, `/websites/{id}/backups_disabled`,
`/orgs/{org}/websites/{id}/apps`, `/orgs/{org}/websites/{id}/domains?withSsl=true`,
`/orgs/{org}/websites/{id}/emails`, `/orgs/{org}/websites/{id}/mysql-dbs`,
`/orgs/{org}/websites/{id}/mysql-users`.

Developer tools tab calls:
`/websites/{id}/built_in_php_extensions`, `/websites/{id}/available_php_extensions`,
`/websites/{id}/php_extensions`, `/websites/{id}/php_error_log`,
`/v2/websites/{id}/webserver_kind`, `/orgs/{org}/websites/{id}/settings/phpIni`,
`/orgs/{org}/websites/{id}/ssh/keys`, `/orgs/{org}/websites/{id}/crontab`,
`/v2/websites/{id}/ioncube`, `/v2/websites/{id}/redis`,
`/websites/{id}/container_cron_enabled`.

Useful hints: `domains?withSsl=true` returns cert info inline; `recursion=directCustomers`
is how the UI lists websites; the UI never calls filerd on this page.

## SSH deploy path test (2026-09-04, in progress)

- `POST /orgs/{org}/websites/{id}/ssh/keys` with `{value, name}` -> 201 `{"id":"0"}`.
  Key ids are small integers as strings, per authorized_keys line. Confirmed in UI.
- `PATCH /orgs/{org}/websites/{id}` with `{"ssh": true}` -> 204, but `ssh` stayed
  `false` in the website detail. Meaning of the `ssh` field is unconfirmed.
- First `ssh -p 22 vahi_dev1@65.98.32.45` attempts from the Claude Code Bash tool:
  "kex_exchange_identification: Connection reset by peer".
- **Root cause: the Claude Code Bash sandbox.** It allowed HTTPS to the panel but reset
  raw SSH on port 22. The same command worked from the user's own terminal and from the
  Bash tool with `dangerouslyDisableSandbox: true`. The server was fine all along.
- `ssh: false` on the website detail does NOT gate key-based SSH. Login works with the
  flag false. Its meaning is still unconfirmed (possibly password-auth state).

### Verified: SSH deploy path works end to end (2026-09-04)

`POST .../ssh/keys` -> key accepted by host OpenSSH 9.6p1 (Ubuntu 24.04) -> shell in
the website container as `vahi_dev1@d20858.sgp1.stableserver.net`.

| Item | Value |
|---|---|
| Home | `/var/www/<website_id>` (also `$HOME`) |
| Docroot | `~/public_html` (matches `documentRoot` from the API) |
| authorized_keys | `~/.ssh/authorized_keys`, line N = API key id N, options: agent-forwarding port-forwarding pty user-rc x11-forwarding |
| OS | Ubuntu 24.04.4 LTS x86_64, container hostname `d20858` |
| PHP | 8.4.25 CLI (matches website phpVersion) |
| Composer | 2.10.3 |
| WP-CLI | 2.12.0 |
| rsync | 3.2.7 |
| git | 2.43.0 |
| mysql client | MariaDB 11.4.13, and `~/.my.cnf` is pre-provisioned so `mysql` needs no password |
| psql | 16.15 |
| redis-cli | 7.0.15 |
| node / npm | MISSING until `POST /websites/{id}/apps/node` (installNvm) is called |
| Disk | 99G volume, 13G used |

Implications for the design:
1. The deploy skill can rsync straight to `~/public_html` (or a subdir) using the
   `unixUser` and `serverIps[0].ip` from the website detail call.
2. WordPress work can use `wp` over SSH; DB work can use `mysql` over SSH with no
   credentials handling on our side.
3. Node deploys need the nvm install endpoint first, then `~/.nvm` appears.
4. **Claude Code sandbox blocks outbound SSH by default.** The deploy skill must either
   instruct the sandbox to allow the app server host, or run the rsync/ssh step with the
   sandbox disabled and say so explicitly. This is a first-class requirement.


## GitHub survey: SDKs and prior art (2026-09-04)

Enhance publishes no source and no official SDK on GitHub. The only official artifacts are
the OpenAPI spec and the WHMCS module (which bundles a generated PHP client). Prior art:

| Repo | What | Useful takeaway |
|---|---|---|
| upmind/enhance-sdk-php | PHP SDK auto-generated with OpenAPI Generator 7.12 from the same spec; package version = spec version | Generating from the spec is the established approach; pin our vendored spec version the same way |
| managingwp/enhance-bash-cli | Bash wrapper with `~/.enhance` ini profiles (API_TOKEN, API_URL, ORG_ID) | Multi-profile config is a nice UX; "cluster org id" is shown under Settings > Access Tokens |
| casperh123/Website-Maintainer-Wordpress | C# client via Kiota | Spec has `type: int` (non-standard) in 2 places (lines ~15306, 15316); must be patched to `integer` before codegen. Also uses non-standard formats: path, domain, semver, datetime, ip, password |
| namncn/wscrm | Hand-written TS client for reseller flows | `POST /logins?orgId=` creates a customer login; roles are capitalised (`Owner`); 409 on existing login; subscription endpoints take the customer org id |
| spss20/HestiaEnhanceMigrator | TS migration tool (axios + bottleneck + ssh2) | Rate limit 5 req/s, 2 concurrent; retry 429/5xx only; SQL upload via `/v2/websites/{id}/mysql/{db_id}/sql` with `application/gzip`; tar-pipe over SSH beats SFTP; `subscriptionId` may be required on website create |
| webdighost/enhance-whmcs | Community WHMCS module | Reseller-tier reference for v2 |
| rdbf/nginxtune-enhance, webservertune-enhance | Server tuning scripts | Platform-tier reference for v3 |

Decision: generate TypeScript types with `openapi-typescript` and use `openapi-fetch` for
the typed client, with a preprocessing step that patches `type: int` and vendors the spec
at a pinned version. Add a CI job that diffs the upstream spec and fails on drift.

## Preflight endpoints verified live (2026-09-04)

| Endpoint | Result on the test panel |
|---|---|
| `GET /branding?orgId=` | `nameServers: ns1..ns4.stableserver.net`, `stagingDomain: sgp1.mystaging.site`, `controlPanelDomain`, `phpMyAdminDomain`. This is where "the nameservers given by the server" come from |
| `POST /orgs/{org}/domains/check` | `vahi.dev` -> `inUseCurrentOrg` + websiteId; `mcp-e2e-x1.test` -> `notInUse`; `example-not-mine.com` -> `notInUse` |
| `GET /orgs/{org}/domains/{id}/auth-ns` | vahi.dev: Cloudflare nameservers, `ips: []`, `matchesPlatform: true` (semantics unclear; do not rely on it alone) |
| `GET …/dns-status` | vahi.dev: `ForeignServer` (behind Cloudflare). Valid state, not an error |
| `GET /v2/domains/{id}/ssl` | vahi.dev: self-signed placeholder, issuer `vahi.dev`, issued 1975-01-01, expires 4096-01-01, sans include www. Must be detected as "no real certificate" |
| `GET …/server_domains` | all arrays empty on this panel |

## DNS and Cloudflare, verified live (2026-09-04)

Panel pages `/websites/{id}/domains` and `/websites/{id}/domains/{domain_id}` were
captured with Claude in Chrome. The domains page calls `…/domains/{id}/dns-status` per
domain and shows a warning for vahi.dev (`ForeignServer`) and a green check for the
preview domain. The domain detail page calls `…/domains/{id}/dns-zone`,
`…/local_remote`, `/websites/{id}/domains/{name}/email-auth`, and `/orgs/{org}/cloudflare`.

`dns-zone` for vahi.dev returns `origin`, `soa` (ns1.stableserver.net, refresh 1400,
retry 7200, expire 86400, ttl 1400), and 15 records: A `@`, `mail`, `mysql` ->
65.98.32.45; CNAME `www`, `ftp` -> `vahi.dev.`; CNAME `imap`, `pop`, `smtp` ->
`mail.vahi.dev.`; MX `@` -> `0 mail.vahi.dev.`; TXT `@` SPF
(`v=spf1 +a +mx include:spf.mysecurecloudhost.com ~all`, ttl 86400); TXT `_dmarc`
(`v=DMARC1; p=none;`); NS `@` x4 (ns1..ns4.stableserver.net). Records carry `id`,
`kind`, `name`, `value`, optional `ttl`, and `proxy` (Cloudflare proxy flag).

Cloudflare integration: `GET /orgs/{org}/cloudflare` -> `[]` (no keys yet);
`GET /orgs/{org}/domains/{id}/cloudflare` -> 404 `not_found` "Domain does not have
CloudFlare configured". Flow: `POST /orgs/{org}/cloudflare {token, friendlyName}` (done
by the customer in the panel, not through the MCP), then
`PUT /orgs/{org}/domains/{id}/cloudflare <keyId>`; Enhance then syncs the zone and
`cloudflareStatus` on the domain becomes `Connected`. `…/cloudflare/nameservers`
reports the Cloudflare nameservers and `active`/`pending`.

Provider detection: nameserver names ending in `.ns.cloudflare.com` mean Cloudflare;
names matching `platform_info.nameServers` mean the platform; anything else is `other`.

## Preview domain availability (2026-09-04)

- `GET /branding?orgId=` -> `stagingDomain: "sgp1.mystaging.site"` on this panel. This
  value is set by the provider (`POST /orgs/{org}/staging-domain`, reseller/MO only;
  customers get 403 on `GET /orgs/{org}/staging-domain`). Absent or null means the
  provider has not configured preview domains and `POST …/preview` will fail.
- Existing preview domain is visible as `website.aliases[].kind == "preview"`.
- `POST /orgs/{org}/websites/{id}/preview` -> 200 with the existing name
  (`"vahi-dev-ccyq.sgp1.mystaging.site"`), 201 when created, 400 when it cannot.
- Fallback verification without a preview domain works:
  `curl -k --resolve vahi.dev:443:65.98.32.45 https://vahi.dev/` reaches the container
  (404 because `public_html` is empty; `ssl_verify_result=18` = self-signed placeholder).
- An empty docroot returns 404 on every hostname, so verification must request a file
  that was deployed.

## MCP TypeScript SDK v2 facts learned in Task 14 (2026-09-05)

- Installed: `@modelcontextprotocol/server` 2.0.0, `core` 2.0.0, `client` 2.0.0.
  `LATEST_PROTOCOL_VERSION` is `2025-11-25`; a `2026-07-28` "modern era" exists and is
  entered when the process is served via `serveStdio`/`createMcpHandler` and the client
  negotiates it.
- Claude Code 2.1.258 advertises `capabilities: { elicitation: {} }` (bare) and
  negotiates the legacy era over stdio. The SDK's `ElicitationCapabilitySchema`
  preprocesses a bare `{}` into `{ form: {} }`, so `elicitInput` works on legacy
  connections, but `elicitInput` throws `MethodNotSupportedByProtocolVersion` on the
  modern era.
- The portable API is the **`inputRequired` flow**: the tool callback returns
  `inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema }) } })`;
  on legacy connections the SDK's default-on shim performs `elicitation/create` and
  re-invokes the (zod-validated) callback with `inputResponses`; on the modern era the
  client drives it. Read the answer with `inputResponse(ctx.mcpReq.inputResponses, 'confirm')`
  (distinguishes accept/decline/cancel/missing).
- Client capability detection: `getClientCapabilities()` is `undefined` under
  `serveStdio`; read `ctx.mcpReq.envelope['io.modelcontextprotocol/clientCapabilities']`
  first (required on the modern era), then fall back.
- `_meta: { 'anthropic/requiresUserInteraction': true }` is accepted by `registerTool`'s
  config type; `outputSchema` is deliberately not declared (Claude Code issues).
- Residual: if a client's elicitation handler itself errors, the SDK shim returns its own
  `isError` result without re-entering the callback; nothing executes, but that attempt
  is not audited. Fix direction: audit destructive *intent* at round 1.
