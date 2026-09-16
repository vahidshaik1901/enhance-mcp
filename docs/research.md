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

Cloudflare proxy and Let's Encrypt (reported by the panel owner 2026-09-05, from experience;
not yet reproduced live because vahi.dev has no records at Cloudflare): the panel's automatic
Let's Encrypt issuance fails while the A record is proxied (orange cloud). Customer flow the
tools and the deploy skill now give: add A `@` and CNAME `www` as "DNS only" (grey cloud),
wait for `Resolved`, issue via `domain_ssl_issue`, confirm a real issuer with `domain_ssl_get`,
then turn the proxy on with Cloudflare SSL/TLS mode Full (strict). Flexible mode loops once
force-https is on. Open question for milestone D: whether the 60-day renewals also need the
proxy off, or pass through the proxy once Full (strict) is set.

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

## Live test A: static site from a fresh domain to a verified URL (2026-09-05)

Driver: a scripted MCP client over stdio against the built server (`node dist/index.js serve`),
declaring the bare `elicitation: {}` capability Claude Code 2.1.258 declares, on the legacy
protocol era Claude Code negotiates. Credential: a panel session JWT sent as the `id0` cookie.
Subscription 664 (shared plan). The live e2e suite ran first: 8/8 in 13 s, its throwaway
`mcp-e2e-*.test` site created and soft-deleted (the domain lingers in `/orgs/{org}/domains`,
as documented for soft deletes).

| Step | Tool | Result |
|---|---|---|
| Domain free | `domain_check` | `notInUse` for `mcp-demo-vyruhg.test`; `.test` names are accepted for creation |
| Create | `website_create` | site on 664, `php81` (plan default; `php85` offered), unix user `mcp_demo1`, app server `209.42.27.117`, preview alias created by the panel at creation, next steps listed |
| Preview | `website_preview_domain` | `(existing)`, `created: false`; the hostname did not resolve for about five minutes, then resolved on `ns1/ns2.stableserver.net` and public resolvers |
| DNS | `domain_dns_status` | `Failed`, no nameservers found, provider `unknown`, platform nameservers plus the A record alternative |
| SSL | `domain_ssl_get` | placeholder detected on the primary domain (issuer equals the name, 1975 to 4096, force https off) |
| SSH key | `ssh_key_add` twice | `added: true` then `added: false`, key id `0`; `public_key` shows as `[redacted]` in the audit log |
| SSH | `ssh_connection_info` | login, home, docroot, one key; login worked from an unsandboxed shell with `ssh -i <key>` |
| Deploy | rsync dry-run, then real | three files into `public_html`; `-a` changed the docroot mode from `750` to `755` (restored by hand) |
| Verify | curl on the preview URL | `200` on `/`, `/index.html`, `/style.css`, `/app.js`; heading matched; plain HTTP `200` with no redirect |
| Delete | `website_delete` via elicitation | prompt carried the preview and asked for the typed name; one soft-delete on the resolved id; audit line `gate: elicitation, outcome: ok`; site gone from the list (12:44, second session JWT) |
| DNS tree | `domain_dns_status` and `domain_dns_records` on vahi.dev | `ForeignServer`, Cloudflare nameservers, provider `cloudflare`, both fix paths offered; records listed from the panel zone (see the two findings below) |

Findings and what changed because of them:

- **Session cookies expire.** The JWT worked from 07:56 to 08:01 local and was rejected at its
  next use, 12:23, with 401 `invalid_session_token` (a code distinct from `no_session_token`;
  an expiry or a newer login replacing the session; the lifetime is under four and a half hours
  and was not measured more precisely). `explainError` now names this case and points at access
  tokens. A second session JWT (12:44) completed the remaining steps; real use needs an access
  token from Settings > Access Tokens.
- **Preview DNS propagates in about five minutes.** The vhost answered at once when pinned
  with `curl --resolve`, and the record appeared on the authoritative servers after a few
  minutes. `website_preview_domain` and the deploy skill now say so and give the `--resolve`
  check for the gap. The platform nameservers `ns1/ns2.stableserver.net` resolve to the same IPs
  as `ns1/ns2.a2hosting.com`, which serve the `mystaging.site` zone.
- **The preview host gets a real certificate at creation.** Let's Encrypt issued for
  `<preview>` and `www.<preview>` with a notBefore one hour before creation (the usual backdate),
  while the primary domain keeps the placeholder until DNS resolves. So a customer has a
  working HTTPS URL before touching DNS.
- **rsync flags.** With a trailing-slash source, `-a` copies the local folder's owner, group and
  mode onto the docroot, which the panel keeps at `750` with group gid 33. The tool example and
  the skill now use `-rltvz` and mention `-e "ssh -i <key>"`.
- Container facts for a new shared-plan site: home `/var/www/<website id>`, docroot
  `public_html` (750, owner unix user, group 33), rsync present, `ssh: false` in the payload
  while key auth works.
- **The panel's `auth-ns` `matchesPlatform` flag is not reliable.** vahi.dev on Cloudflare
  nameservers came back `{"matchesPlatform": true, "authNs": [cloudflare names with empty ips]}`.
  `domain_dns_status` now derives `matchesPlatform` from the nameserver names itself and exposes
  the raw flag as `panelMatchesPlatform`.
- **Mail routing is `local` for every site, mailboxes or not.** In `auto` mode
  `domain_dns_records` therefore listed MX, SPF, DMARC and the mail hosts for vahi.dev, which has
  zero mailboxes (`GET .../websites/{id}/emails` returns `{items: [], total: 0}`). A customer
  whose mail lives elsewhere would have been told to add the platform MX at Cloudflare. `auto`
  now includes mail records only when routing is local and the website has at least one
  email account (mailbox or forwarder) on that domain; `include_mail=yes` still forces them, and the text says which rule
  applied.
- The demo site was soft-deleted through the elicitation gate at 12:44; only vahi.dev remains.

## Live probe: milestone B and C endpoints (2026-09-05)

All verified on vahi.dev (website 6106382b-143f-4d24-9bea-0e9368ad2a1f, unix user vahi_dev1,
plan DMax, subscription 686, php84) with a panel session cookie. Every resource created was
deleted again; the site is back to the static page plus an installed Node runtime.

### PHP connects to MySQL over `localhost` only (critical)

A PHP page deployed to the docroot connected to MySQL with `new mysqli('localhost', ...)`:
created a table, inserted and read back a row on MariaDB 11.4.13. The same page against
`127.0.0.1` got `Connection refused`. So generated app config (`.env`, `wp-config.php`,
Laravel `DB_HOST`) must use `localhost` (the unix socket), never `127.0.0.1` or the
`dbServerIps` value. The admin `~/.my.cnf` also uses `host=localhost`.

### MySQL (all work)

- List `GET /orgs/{org}/websites/{id}/mysql-dbs` -> `{items: MySQLDB[]}`,
  `MySQLDB {name, size, createdAt, websiteId, serverId, userCount}` (no id; the name is the key). `size` is bytes: 0 for an empty database, 16384 after one InnoDB table (verified 2026-09-11).
- Create `POST .../mysql-dbs {name}` -> 201. **Names are auto-prefixed with `<unixUser>_`.**
  Sending `name: "demo"` created `vahi_dev1_demo`. Every later call (delete, grant, sql) uses
  the FULL prefixed name. A tool must show the full name and accept either the short or full form.
- Delete `DELETE .../mysql-dbs/{db_name}` -> 204 (uses the full name).
- Users: `GET/POST .../mysql-users`, `DELETE/PUT .../mysql-users/{username}`.
  `NewMySQLUser {username, password, authPlugin?}`; `authPlugin` is
  `mysql_native_password` (default) or `caching_sha2_password`. Username is prefixed the same way.
  `MySQLUser {username, accessHosts[], authPlugin, grants: {dbName: grant[]}, createdAt, isEphemeral}`.
  A new user's default `accessHosts` is `["10.169.0.1"]` (the app tier source IP).
- Privileges `PUT .../mysql-users/{username}/privileges {dbName, grants[]}` -> 201. **grants are a
  lowercase enum**, not SQL text: `all, alter, alterRoutine, create, createRoutine,
  createTablespace, createTemporaryTables, createView, delete, drop, event, execute, index,
  insert, lockTables, references, select, showView, trigger, update`. `["all"]` works;
  `"ALL PRIVILEGES"` is a 400 that lists the valid variants. After grant, the user's `grants`
  became `{"vahi_dev1_demo": ["all"]}`.
- Access hosts `POST/DELETE .../mysql-users/{username}/access-hosts {accessHosts[]}`. Verified
  2026-09-06: POST **adds** the listed hosts (the default `10.169.0.1` stays), DELETE with the
  same body removes them; neither replaces the list.
- No password policy: `abc12345` was accepted (201). The MCP's generated passwords are the
  only strength guarantee.
- Side effect: the first phpMyAdmin SSO call created a MySQL user `<unixUser>_phpma` with the
  phpMyAdmin host in its accessHosts and no grants (`isEphemeral: false`). It persists; leave
  it alone, it is the panel's own login for phpMyAdmin.
- Password change `PUT .../mysql-users/{username} {password}`.
- Export `GET .../mysql-dbs/{db_name}/sql` -> a JSON string holding a **filename**, not the dump
  (verified 2026-09-06: `"sql_backup_vahi_dev1_mcpxport_06-09-2026_01:29.sql.gz"`). The panel
  writes a gzipped dump to the website HOME directory (`/var/www/<id>/<filename>`, mode 0600,
  outside the docroot). Fetch it with scp over SSH or the panel file manager; old backups
  accumulate until removed. An earlier note here wrongly said the body was the SQL itself.
- Import `POST /v2/websites/{id}/mysql/{db_name}/sql` is a multipart upload with optional `?force`.
  **The spec's part name `sql` does not work** (verified live 2026-09-11, orchd 12.25.5): the panel
  takes the file extension from the multipart *field* name (the `name="..."` in Content-Disposition),
  not from `filename="..."`, so `sql` is rejected with 400
  `{"code":"invalid_argument","detail":"mysql_db","message":"Invalid file extension"}` whatever the
  filename and part Content-Type are. Name the field `<something>.sql` (or `.sql.gz` with a gzipped
  body) and it is accepted; the MCP sends `<database>.sql`. A failing statement returns 400
  `{"code":"invalid_argument","detail":"mysql_backup","message":"Unable to import mysql backup,
  code 1, ... ERROR 1062 (23000) at line 1 ..."}` carrying the mysql CLI output, and the statements
  before it have already run; `?force=true` is the documented way to continue past failures
  (the mysql CLI `--force`).
- phpMyAdmin SSO `GET .../phpmyadmin?shouldRedirect=false` -> a signon URL string
  (`https://phpmyadmin.<panel>/signon.php?sess=...`); per-db variant `.../mysql-dbs/{db_name}/sso`.

### PostgreSQL

Endpoints mirror MySQL (`/postgresql-dbs`, `/postgresql-users`, grant/revoke). On this plan
`canUse.postgresql` is `false` and `php_extensions` shows `pgsql` enabled but the DB feature is
off, so PG tools must gate on `canUse.postgresql` and report unavailable rather than call.
`PostgresqlUser {username, privs[], createdAt}`; grant body is a bare db-name string, revoke is
`DELETE .../postgresql-users/{username}/privileges/{db_name}`. `getWebsitePostgresqlDbs` reuses
the `MySQLDBsFullListing` type.

### PHP settings, extensions, cache

- Enabled extensions `GET /websites/{id}/php_extensions` -> string[] (was `["pgsql","pdo_pgsql"]`).
  Available to enable `GET .../available_php_extensions` — on this panel that list was
  `["apcu","brotli","oauth","pdo_dblib","pdo_pgsql","pgsql","xmlrpc"]` (observed 2026-09-06), so
  `apcu` is a valid `php_extension_enable` example. Compiled-in
  `GET .../built_in_php_extensions` (mysqli, pdo_mysql, redis, gd, intl, imagick, ... always on).
- Enable `POST .../php_extensions` / disable `DELETE .../php_extensions`, body is a **bare JSON
  string** (the extension name), not an object.
- PHP error log `GET .../php_error_log` -> string, last 256KB (empty `""` when none).
- The only php.ini-style knob at customer tier is `GET/PUT /websites/{id}/lsphp_settings`
  `{lsapiChildren: number}` (was 100). There is **no generic php.ini get/set endpoint**; the
  spec's `php_ini_get/set` must map to lsphp settings, not arbitrary directives.
- Redis is a feature toggle, not a KV API: `GET/PUT /v2/websites/{id}/redis` boolean (was false).
  The spec's `redis_get/set` means this on/off state.
- Cache: `DELETE /v2/domains/{domain_id}/nginx_fastcgi` clears the FastCGI cache (per domain);
  OPcache is cleared by `website_restart_php`. That pair is the spec's `cache_clear`.
- htaccess rewrites `GET/PATCH /orgs/{org}/websites/{id}/htaccess`
  (`RewriteChain {lineNumber, rule{pattern, substitution, flags[]}, conds[]}`), and IP rules
  `GET/PUT .../htaccess/ips {kind: "allow"|"block", ips[]}` (was `{ips:[], kind:"block"}`).
  Domain-level `GET/PUT/DELETE /v2/domains/{id}/webserver_rewrites [{path, destinationFile}]`.

  **Verified live 2026-09-06 (rewrites):** `PATCH .../htaccess {items}` MERGES by `lineNumber`
  (posting line 2 alone kept line 1); a bare `{lineNumber: N}` DELETES that chain; after a delete
  the remaining chains are RENUMBERED from 1, so deleting several must go highest-first (or
  re-read between deletes); the rules take effect at once (`/old-a` answered 302). The chains are
  written into `public_html/.htaccess` next to the panel's `<RequireAll>` block.
  **Verified live 2026-09-06 (IP rules):** the panel writes `<RequireAny> Require ip … </RequireAny>`
  (Apache 2.4 syntax) into `public_html/.htaccess`, but this server runs **LiteSpeed**
  (`server: LiteSpeed`), which ignores it: with `allow [203.0.113.9]` every request from another
  IP still got 200 (static, PHP, 404 paths, preview and primary domain), and `block [my ip]` did
  not block me either. So `ip_rules_set` is a no-op on (Open)LiteSpeed servers and presumably
  works only on Apache ones. Tools must say so and tell the user to verify with curl.
  Open question for the walkthrough: how the panel-managed `.htaccess` block coexists with an
  app's own `.htaccess` (Laravel, WordPress) after an rsync deploy.

### Cron

- `GET /orgs/{org}/websites/{id}/crontab` -> `{items: CrontabValue[]}` where each item is
  `{variable:{lineNumber,key,val}}` or `{cronCmd:{lineNumber,expr}}` (was empty). The spec marks
  the response 204 but it is 200 with a body.
- `PATCH .../crontab {items: UpdateCrontabValue[]}`; `DELETE .../crontab`.
- Container cron on/off `GET/PUT /websites/{id}/container_cron_enabled` boolean (was false). The
  PUT's spec summary is mislabeled "Set backups disabled status" -- ignore the label.
- **Verified live 2026-09-06 (crontab):** `PATCH {items}` MERGES like htaccess. Line numbers in
  responses are **0-based** (`lineNumber: 0` for the first line); on input a `lineNumber` beyond
  the current count APPENDS (sending 1 to an empty crontab stored it at 0, sending 2 next stored
  it at 1); an in-range number replaces that line. A bare `{cronCmd: {lineNumber: N}}` DELETES
  line N (0-based) and the rest renumber. `DELETE .../crontab` clears everything. Variables:
  `MAILTO` is blacklisted (400 `invalid_syntax` "Variable MAILTO is blacklisted"). `crontab -l`
  inside the container answers "Command unavailable in website container": the panel manages
  cron outside the container. `container_cron_enabled` PUT true/false round-trips (was false).
- **Verified live 2026-09-06 (what `container_cron_enabled` means):** it does NOT gate execution.
  With the flag `false`, a panel-managed `* * * * * /bin/date >> <home>/cron-probe.log` job fired
  on the next minute boundary (log written at 08:13:01 UTC). What the flag changes is the
  container's own access to its crontab: with `false`, `crontab -l` inside the container says
  "Command unavailable in website container"; with `true`, `crontab -l` lists the panel-managed
  jobs. So the tools must describe it as "let the container read/edit its own crontab", never
  as a scheduler switch. Also: `%` is special in crontab command text (it ends the command and
  feeds the rest to stdin), so `date +%s >> file` never wrote the file; commands must escape it
  as `\%`.

### Node and persistent apps (milestone C, probed now)

- `POST /websites/{id}/apps/node` installs nvm **and the stable node** (26.8.1); 200. Before this
  the container has no node and no `~/.nvm`.
- `GET .../apps/node/possible_versions` -> string[] (0.12 through 26.8.1).
- `POST .../apps/node/versions` body bare string `"22.23.2"` installs it; 200.
  `PUT .../apps/node/versions/default` body bare string sets the nvm `default` alias; 200. SSH
  confirmed `node -v` = v22.23.2, npm 10.9.8.
- **Bug: `GET .../apps/node/versions` is out of sync.** After installing 22.23.2 via the API and
  setting it default, the list returned only `["26.8.1"]`, omitting 22.23.2, though `nvm ls`
  shows both and default -> 22.23.2. A tool must not present this list as authoritative (rule
  pinned in the Task 1 probe below: it omits the `default`-alias version).
- Persistent apps `GET/POST /websites/{id}/apps/persistent`,
  `PATCH/DELETE .../apps/persistent/{app_id}`, `GET .../apps/persistent/{app_id}` returns the
  **startup+stdout log** (nvm load, node version, app output) as a string.
  `PersistentApp {proxyDetails{path, port, allowWebSocketUpgrade?}, startMode: automatic|manual,
  command, workingDirectory?, nodeVersion?}`.
  - `proxyDetails.path` **must not start with `/`**: alphanumeric and underscore, with hyphens,
    dots and slashes allowed only in the middle. `"node"` works, `"/node"` is a 400.
  - `workingDirectory` **must be relative to home**; an absolute path is silently stored as
    `null` (so `node server.js` ran from home and failed with "Cannot find module"). `"nodeapp"`
    worked and the app started ("listening on 3000").
  - **The app proxy binds to the PRIMARY domain, not the preview/staging alias.** With the app
    listening on 3000, `/node/` returned 200 with the app's JSON on `vahi.dev` (via
    `curl --resolve` to the app server), but 404 on the `*.mystaging.site` preview URL. So Node
    deploys are verified on the primary domain (via `--resolve` until DNS resolves), unlike
    static and PHP which serve on the preview URL. Record this in the deploy skill for mode A.
  - A `persistent_app_<id>.log` file remains in the home directory after the app is deleted.

#### Milestone C Task 1 probe (2026-09-16)

Probed live on vahi.dev with a session JWT. Every app created here was deleted again, the
`persistent_app_*.log` files were removed, the app listing is back to `[]` and
`https://vahi.dev/demo-login/` answers 200 from PHP. nvm was left installed.

1. Second `installNvm`: HTTP 200 in ~0.5 s with an empty body, and a **no-op** — `nvm ls` and the
   mtimes of `~/.nvm` and `~/.nvm/nvm.sh` were unchanged (still 2026-09-05). The panel's
   `/usr/bin/install_nvm_and_node.sh` prints "NVM already installed" and exits 0 when
   `~/.nvm/nvm.sh` exists, so a repeat call never reinstalls nvm and never installs a node
   version. It is safe to call again. `GET .../apps/node/versions` after it: still disagrees with
   `nvm ls`, and the rule is now known — **it lists the installed versions except the one nvm's
   `default` alias points at**. With default -> 22.23.2 and v22.23.2, v26.8.1, v26.8.2 installed
   it returned `["26.8.1","26.8.2"]`; after `nvm alias default 26.8.1` the same set returned
   `["22.23.2","26.8.2"]` (the alias was restored afterwards). The version the nvm `default` alias
   points at is exactly the one missing from the list; apps that pin `nodeVersion` explicitly are
   unaffected by this (finding 6's app ran v26.8.2 while the list still contained 26.8.2). Either
   way the list must never be presented as authoritative.
2. Restart: **every `PATCH` restarts the app, even a no-change one**, and it restarts the whole
   website container with it. `PATCH {"startMode":"automatic"}` on an app already `automatic`
   returned HTTP 200, and one second later both the container's PID 1 (`appinit ... lsphp`) and
   the `node server.js` process showed fresh start times (16:53:13 and 16:53:14 for a PATCH issued
   at 16:53:13; before it they had started at 16:51:56 and 16:51:57). **The pid is not a restart
   signal**: the app lands on pid 5 in every fresh container, so the probe page printed the same
   `probe-5` before and after; only `ps -eo pid,lstart,etimes` tells the truth. `startMode:
   "manual"` stops the process — the proxy path answered HTTP 503 at 5 s and at 20 s. Back to
   `"automatic"` starts a new process (200 again within 8 s, new start time). A partial PATCH is
   field-safe: after sending only `startMode`, the listing still carried `command`,
   `workingDirectory`, `nodeVersion` and `proxyDetails` unchanged. Create and delete bounce the
   container the same way, so the site's PHP process (PID 1 is `appinit` running `lsphp`) is
   restarted on every persistent-app write, not just the app.
3. Duplicate port: **accepted**, HTTP 201 — a second app on port 3077 while a live app already
   used 3077 was created without complaint, so the panel does not validate ports. The duplicate
   was created with `startMode: "manual"` and never started, so what happens when both try to
   listen was not observed; presumably the second fails to bind. Proxy path colliding with a
   docroot directory (`demo-login`, a live PHP page): **accepted, HTTP 201, and the proxy wins.**
   With the app merely registered and `startMode: "manual"` (nothing listening),
   `https://vahi.dev/demo-login/` went from 200 to **503**; the PHP page returned to 200 within
   seconds of deleting the app. So a proxy path silently shadows a real directory under
   `public_html`, and an app that is not running turns that URL into a 503. A path that collides
   with **another app** is the one case the panel refuses: HTTP 409
   `{"code":"already_exists","detail":"website","message":"An app already exists with this path"}`.
4. Log endpoint: **capped tail of 262144 bytes (256 KiB)**, cut mid-line. A 5,100,608-byte log file
   came back as exactly 262144 decoded bytes (267287 bytes on the wire as a JSON string), starting
   in the middle of a line and ending at the file's last line. A small log comes back whole (a
   608-byte file returned a 608-byte string). The file is also **truncated on every app restart**,
   so it only ever holds the current run, and it outlives the app's deletion.
5. `appKind`: `generic` on our app — the panel returns the field, it is not sent on create.
   `openclaw` is a panel-provided app kind the tools display but never create.
6. `nodeVersion: "stable"` on create: **accepted**, HTTP 201, stored and echoed back as
   `"stable"`. At start the runner does `nvm install stable; nvm use stable`, which resolved to
   v26.8.2 and installed it on the fly (nvm held 22.23.2 and 26.8.1 before). POST body: **empty** —
   HTTP 201 with `content-length: 0` and no `Location` header, so the new id must come from a
   follow-up `GET .../apps/persistent`. `workingDirectory` may be omitted entirely (stored as
   `null`). A successful `DELETE .../apps/persistent/{app_id}` answers HTTP 200 with an empty body
   (every delete in this probe did).

Two further behaviours this probe uncovered, both of which the tools must guard:

- **`command` is word-split, not shell-parsed.** The runner seen in `ps` is
  `bash -l -c 'date; install_nvm_and_node.sh; ... nvm install stable; nvm use stable; exec "$@"' -- ` followed
  by the command words, so quoting inside `command` does not survive. `node -e "const s=require(...)"`
  reached node as the argv `node`, `-e`, `"const`, `s=require(...)` and crash-looped every few
  seconds with `[eval]:1 / "const / Unterminated string constant / SyntaxError: Invalid or
  unexpected token`. The same app written as `node server.js` with `workingDirectory:
  "mcpprobe-app"` started and served on the first try. The tools and the skill must point
  `command` at a script or an npm script, never at an inline one-liner with quoted arguments.
- **`workingDirectory: ""` is accepted (HTTP 201) but the app never starts.** Its log stopped
  after the `Starting app with params ... working_directory: Some(RelativePathBuf(""))` header —
  not even the runner's first `date` ran — and the proxy path was still 503 on every check over
  the three minutes it was left up. Omit the field or send a real relative directory; the create tool should reject an
  empty string rather than pass it through.

Two follow-up probes by the controller (same day, throwaway apps `mcpenv`, deleted; demo-login 200 after each):

7. **The runner injects no `PORT`** (or any app-specific variable): an app that printed its
   environment, filtered to variable names matching /port|app|proxy|enhance|nvm/i, saw only
   `NVM_INC`, `NVM_DIR`, `NVM_CD_FLAGS` and `NVM_BIN` — the filter, not the environment, is why
   `PATH` and `HOME` do not appear; cwd = the site home when `workingDirectory` is unset. The
   proxy port is not passed to the process, so the app must read its port from its own config: an
   npm script (`"start": "node --env-file=.env server.js"`, `"start": "next start -p 3002"`) or a
   hard-coded value. `VAR=value` prefixes in `command` cannot work because the command is exec'd
   as argv, not through a shell.
8. **An app created without `nodeVersion` never starts**: the runner skips the nvm load and logs
   `exec: node: not found`. `nodeVersion: "default"` works (nvm prints a harmless
   `Version 'default' not found` from its install step, then `Now using node v22.23.2`, the
   default alias). So the create tool must always send a `nodeVersion`, defaulting to `"default"`.
   The 2026-09-05 bullet above, where an app with `workingDirectory: "nodeapp"` started and logged
   "listening on 3000", did not record what `nodeVersion` that create sent, so it does not
   contradict this.

## Live test B: databases, PHP, cron and the gate on vahi.dev (2026-09-11)

Driver: the milestone B e2e suite (`server/test/e2e/milestone-b.e2e.test.ts`) calling the tool
handlers directly against the live panel with a fresh session JWT as the `id0` cookie, inside the
existing site vahi.dev (subscription 686, LiteSpeed, php84). Every write was a randomly named
`mcpb…` resource the run created itself. 4/4 in 26 to 28 s, run twice (before and after the import
fix); the panel was checked clean afterwards (no `mcpb*` database or user, empty crontab and
rewrite chain; the one user left is `vahi_dev1_phpma`, created by the phpMyAdmin SSO probe of
2026-09-05).

| Step | Tools | Result |
|---|---|---|
| Database round trip | `db_create`, `db_user_create`, `db_user_set_privileges`, `db_list`, `db_users_list`, `db_export_sql`, `db_phpmyadmin_url` | created as `vahi_dev1_mcpb<5>`, listed, exported to `sql_backup_….sql.gz` in the home directory, SSO URL minted |
| Reads | the PHP, Redis, htaccess, IP-rule, container-cron and PostgreSQL read tools | answered with the shapes the tools promise (PostgreSQL through its `canUse` gate) |
| Cron | `cron_add`, `cron_get`, `cron_remove` | one job appended, shown, removed; nothing else on the crontab touched |
| Gate | `db_user_delete`, `db_delete` | preview carries the site identity and the full name; a mistyped name is refused (`mismatch`); the typed full name deletes exactly that resource |
| SQL import (extra probe, not in the suite) | `db_import_sql` | FAILED before the fix: 400 "Invalid file extension" on every call; PASSES after 910e494 (finding below) |

Findings:

- **`db_import_sql` was broken live.** The panel takes the file extension from the multipart
  field name, not the filename, so the spec's `sql` part name is rejected. Fixed by naming the
  field `<database>.sql` (details under "MySQL (all work)" above). A dependent statement in a
  second import proved the first one executed; a duplicate key and a missing table came back as
  400 `invalid_argument` with the mysql error text, which the tool surfaces verbatim.
- **`MySQLDB.size` is bytes.** An empty database lists as 0; after one InnoDB table it lists as
  16384. The tool's `sizeBytes` column is right.
- **Session cookies keep expiring within hours.** The 2026-09-06 cookie was dead by the next
  session; the one pasted on 2026-09-11 worked for the whole run. The org still has no access
  token, so every live session starts with a fresh cookie.
- The Task 10 walkthrough was done on 2026-09-16 (next section).

### Task 10 walkthrough: PHP + MySQL page, Laravel over SSH, the typed-name prompt (2026-09-16)

Run inside Claude Code with the plugin installed permanently from the repo as a local marketplace
(`enhance@enhance-mcp`, user scope), a fresh session cookie, and ssh/rsync/scp run with the
sandbox disabled. Everything below went through the MCP tools and the `enhance-database` /
`enhance-deploy` skills; nothing through the panel UI. The panel was left clean (no databases, only
`vahi_dev1_phpma`; the static test site is back in `public_html`).

| Step | Tools / commands | Result |
|---|---|---|
| Database for the app | `db_create walk`, `db_user_create walk`, `db_user_set_privileges grants=[all]` | `vahi_dev1_walk` / `vahi_dev1_walk`, password shown once |
| Seed data | `db_import_sql` (CREATE TABLE + INSERT) | typed-name prompt shown in Claude Code; `imported: true`, 250 bytes |
| PHP page | `db.php` rsynced to `public_html/`, config file scp'd to the home dir (mode 600, outside the docroot), PDO on `localhost` | `https://<preview>/db.php` → 200 and the seeded row |
| Laravel | `composer create-project laravel/laravel` locally (13.32), rsync to `<home>/app` excluding vendor/node_modules/.env, `composer install --no-dev --optimize-autoloader` over SSH, `.env` written on the server, `key:generate`, `db_export_sql`, `migrate --force`, `config:cache`, `route:cache`, `view:cache`, `public/` rsynced to `public_html/`, `index.php` requires repointed to `../app/` | `/` → 200 (welcome page, 70 KB), `/up` → 200, the three default migrations created their tables next to `greetings` |
| Post-deploy | `website_restart_php`, `cache_clear`, `php_error_log` | restarted, cleared, log empty; pages still 200 |
| htaccess probe | `htaccess_rewrites_get`, `ip_rules_get`, `ip_rules_set block [203.0.113.1]`, `ip_rules_set block []` | see finding below |
| Gate | `db_delete walk`, `db_user_delete walk` | first attempt: the user typed `vahid_dev1_walk` and `vahi_dev1_walk2`, both cancelled with the mismatch reason; second attempt with the exact names deleted both |

Findings:

- **The typed-name prompt works inside Claude Code** through the SDK `inputRequired` flow: the
  prompt appeared for `db_import_sql`, `db_delete` and `db_user_delete`; a mismatched name cancels
  the call with `{"cancelled": true, "reason": "Confirmation text … did not match …"}` and nothing
  is sent to the panel; the exact name goes through.
- **App `.htaccess` vs the panel's block, settled.** An rsync of Laravel's `public/` replaces
  `public_html/.htaccess` outright: the panel's `<RequireAll> Require all granted </RequireAll>`
  block is gone and the site keeps serving (200 on static, PHP and Laravel routes). When the panel
  next writes the file (`ip_rules_set`), it **re-parses and merges**: Laravel's whole rewrite block
  is kept (indentation stripped) and the panel's `<RequireAll>` block is appended after it; clearing
  the rule leaves `Require all granted` in that block. `htaccess_rewrites_get` reports 0 chains
  before and after, so the panel tracks its own rules separately and never shows the app's, even
  once it has rewritten the file around them. Deploying an app `.htaccess` is therefore safe on
  this server, and a later panel write does not destroy it.
- **Laravel 13 `public/index.php` has three `__DIR__.'/../'` paths** (maintenance file, autoload,
  bootstrap); `sed 's#__DIR__\.'"'"'/\.\./#…/../app/#g'` covers all of them and the page renders.
  `storage/` and `bootstrap/cache` were writable as uploaded (owner `vahi_dev1`, 755); no chmod
  needed because PHP runs as the same unix user.
- **`db_export_sql` before `migrate`** wrote `sql_backup_vahi_dev1_walk_<date>.sql.gz` into the
  home directory as documented; removed afterwards. The five `sql_backup_vahi_dev1_mcpb*` files
  from the 2026-09-11 e2e runs are still there.
- **The authorized key is `~/.ssh/enhance_vahi_dev_ed25519`** (panel name `claude-mcp-test`), not
  the default `id_ed25519`; the default key is refused. The skill's "add `-e "ssh -i <key>"`" note
  is the right advice.
- **Plugin install copies the checkout.** `claude plugin install enhance@enhance-mcp` from a
  local-directory marketplace copied the whole repo (164 MB, including `.env`) into
  `~/.claude/plugins/cache/enhance-mcp/enhance/0.1.0/`; the copied `.env` was deleted by hand.
  `claude plugin update` is version-gated (it reported "already at the latest version" and left the
  copy at the old commit), so a rebuild or pull needs
  `claude plugin uninstall enhance@enhance-mcp && claude plugin install enhance@enhance-mcp`
  (verified: the cache's recorded commit moved to the checkout's HEAD) or a version bump first.

## Spec re-vendored: 12.25.8 → 12.25.11 (2026-09-16)

- `server/spec/oas3-api.yaml` and `docs/enhance-api/oas3-api.yaml` now carry 12.25.11; the
  `spec-drift` CI job is green again (`npm run check:spec` went from
  "upstream spec (version 12.25.11) differs …" / exit 1 to "vendored spec matches upstream" / exit 0).
- Paths added: none. Paths removed: none. 302 paths before and after; `diff` of the sorted path
  lists is empty.
- Schema changes that touched a tool: none; all 313 tests passed unchanged, `tsc --noEmit` is clean
  and `tsup` builds. No tool source was edited.
- Milestone C endpoints (`/websites/{id}/apps/node…`, `/websites/{id}/apps/persistent…`) are
  unchanged apart from nothing: all six of `/websites/{website_id}/apps/persistent`,
  `/websites/{website_id}/apps/persistent/{app_id}`, `/websites/{website_id}/apps/node`,
  `/websites/{website_id}/apps/node/possible_versions`, `/websites/{website_id}/apps/node/versions`
  and `/websites/{website_id}/apps/node/versions/default` are byte-identical to the 12.25.8 copy.
- **The 12.25.11 spec is byte-identical to 12.25.8 apart from the `info.version` line.** The only
  diff in either vendored YAML is `version: 12.25.8` → `version: 12.25.11`, so
  `openapi-typescript` regenerated `server/src/client/generated/types.ts` with zero content change
  (git reports no diff for it). Upstream bumped the orchd release without touching the OpenAPI
  surface; the drift job was flagging a version-string mismatch, not an API change.
- The non-standard `type: int` count is still exactly 2, so `EXPECTED_INT_OCCURRENCES` in
  `server/scripts/patch-spec.ts` (and the `test/unit/spec.test.ts` assertion that reads it) needed
  no change.
