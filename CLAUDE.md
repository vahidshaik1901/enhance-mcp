# Enhance MCP + Skills

Professional MCP server and Claude Code skills for the Enhance hosting control panel
(https://enhance.com). Focused purely on Enhance and its API; not tied to any hosting
provider or billing system. Lets a customer manage and deploy to their Enhance-hosted
websites from Claude Code, with strong guardrails so an AI can never wipe a server or
delete a site by accident.

## Current status (2026-09-04)

**Phase: design approved, spec written, awaiting the user's final spec review.**
Spec: `docs/superpowers/specs/2026-09-04-enhance-mcp-design.md`. After approval, invoke
`superpowers:writing-plans` for milestone A, then implement. No code exists yet.

### Decisions made

1. **Tiered scope, built to scale.**
   - **v1 = Customer tier.** A hosting customer with a credential for their own org.
     Websites, domains, DNS, SSL, email, MySQL/PostgreSQL, backups, WordPress, PHP,
     Node/persistent apps, SSH deploy, staging/push-live.
   - **v2 = Reseller tier.** Customer orgs, subscriptions, plans, branding, invites.
   - **v3 = Platform tier.** Servers, roles, IPs, settings, licence. Highest risk.
   - Architecture must let v2/v3 be added as separate tool groups behind an explicit
     opt-in, never enabled by default.
2. **Test panel exists and is verified live (2026-09-04).** See "Live test panel" below.
   Every tool gets verified against it, not just the spec. Secrets live only in `.env`
   (gitignored, chmod 600); never commit, log, or paste them into docs.
3. **Node.js is in scope.** Enhance supports Node via nvm + persistent apps, so Node app
   deploys are a customer-tier feature, not just PHP/WordPress.

4. **Transport: local stdio MCP as a Claude Code plugin** (npm package + bundled skills).
   Remote HTTP/OAuth is a possible later add-on on the same tool layer. Decided 2026-09-04.
5. **Deploy: SSH key via API + rsync over SSH.** Verified end to end on the test panel.
   tar.gz upload via the backup-restore endpoint is the documented fallback for plans
   without `featureSSH`. Decided 2026-09-04.
6. **Credential: the panel session JWT is a first-class credential for now.** The panel UI will
   surface it later; today the user copied it from browser network calls. MCP sends it as the `id0` cookie. Bearer access
   tokens are the second mode. The MCP auto-detects which was pasted by probing
   `/login/memberships`. Decided 2026-09-04.
7. **Destructive ops: two-step confirmation gate** (preview + confirmation token + the
   human typing the domain name). Never expose `force=true`, org delete, subscription
   delete, or bulk website delete. Assumed from my recommendation; confirm in design review.

### Remaining before code

- User reviews the spec. Then `superpowers:writing-plans` for milestone A, then implement
  with TDD against the live panel.
- Milestone ladder (each ends with a live test pass that feeds changes back):
  A static site + preflight (domain check, DNS, SSL, SSH), B PHP + databases,
  C Node.js + persistent apps, D advanced (WordPress, email, backups, DNS zone,
  staging) + deploy modes B (GitHub Actions) and C (git push to server).
- Deploy modes: A direct rsync (implemented first); B and C documented, built in D.

## Live test panel (verified 2026-09-04, read-only probes)

- Panel: `https://e4500.sgp1.stableserver.net`, API base `/api`, orchd version **12.25.5**
  (spec copy is 12.25.8; treat small deltas as possible).
- The user's login is **Owner of a customer org**, not the master org. `isMasterOrg: false`,
  `parentId` = the provider's reseller org. Server, licence, plans, and customers endpoints
  return 403. This is exactly the v1 customer persona, so it is the right test bed.
- Org id and website id are in `.env` (`ENHANCE_ORG_ID`, and the first website is
  `vahi.dev`, id `6106382b-143f-4d24-9bea-0e9368ad2a1f`, unix user `vahi_dev1`, php84).
- Two subscriptions: 664 "Max [Shared Webhosting]" (plan 4) and 686 "DMax" (plan 91,
  unlimited resources). The website is on 686.
- **Auth gotcha:** the JWT the user first pasted is the browser session cookie `id0`,
  not an API access token. It works as `Cookie: id0=...` and is rejected as Bearer.
  The org has **zero access tokens** so far. The MCP must use Bearer access tokens
  created under Settings > Access Tokens. Stored as `ENHANCE_SESSION_COOKIE` for
  read-only probing only; `ENHANCE_TOKEN` is empty until a real one is created.
- **Structured error codes** seen: 401 `no_session_token`; 403 `unauthorized`;
  403 `only_mo_allowed` ("Only an MO admin may perform this operation"); 403
  `unauthorized` with message "Only a reseller or the MO may perform this operation";
  404 plain-text "UUID parsing failed" for malformed ids. Map these to clear messages.
- `GET /orgs/{org}/websites/{id}` returns a **`canUse` block** (fileManager, ftp,
  phpVersions[], redis, modSec, backup, mysqlKind, persistentApps, roundcubeSso,
  postgresql) plus `ssh: false|true`, `unixUser`, `serverIps`, `dbServerIps`,
  `emailServerIps`, `backupServerIps`. Use `canUse` to pre-check tool availability.
- **SSH deploy path is verified end to end.** `POST .../ssh/keys` then
  `ssh -p 22 <unixUser>@<serverIps[0].ip>` lands in the container at
  `/var/www/<website_id>` with php, composer, wp-cli, rsync, git, mysql (passwordless
  via `~/.my.cnf`), psql, redis-cli. Node is absent until installNvm is called.
  The `ssh: false` field does not block key auth; its meaning is unconfirmed.
- **Claude Code's Bash sandbox resets outbound SSH** while allowing HTTPS. Any rsync or
  ssh step in a skill must run with the sandbox disabled or with the host allowlisted.
  Verified 2026-09-04: same command failed sandboxed, worked unsandboxed.
- Soft-deleted websites disappear from `/websites` (non-MO cannot set `showDeleted`)
  but their domains still appear in `/orgs/{org}/domains` and in the activity log.
- Backups: one automatic backup exists; `storageKind: enhance`, ids are epoch-ms ints.
- Subscription payload exposes `resources[]` (quotas + usage), `allowances[]`
  (feature flags such as featureSSH, backupsAllowSelfRestore, featureWebsiteClone),
  `allowedApps` (wordpress, joomla), `persistentAppsAllowed`, `redisAllowed`.
- Unauthenticated: `/version`, `/status`, `/client_ip` work without a token.
- No rate-limit headers were returned on these calls.

## Enhance API facts (verified from the live spec)

- Spec: https://apidocs.enhance.com/spec/oas3-api.yaml (OpenAPI 3.0.3, version 12.25.8).
  Local copy: `docs/enhance-api/oas3-api.yaml`. Endpoint list with operationIds:
  `docs/enhance-api/endpoint-inventory.txt`. Full research notes: `docs/research.md`.
- Base URL is the customer's own panel: `https://<panel-host>/api/...`. There is no
  central Enhance API host.
- Auth: `Authorization: Bearer <token>`. Tokens are created in the panel UI under
  Settings > Access Tokens. Token carries roles, optional expiry, optional IP allowlist.
  401 = bad token, 403 = token lacks role. ~60 req/min per token, honours `Retry-After`.
- 302 paths, 482 operations, 24 tags. Server/platform admin is ~120 of those.
- Roles: Owner, SuperAdmin, Sysadmin, Support, Business, SiteAccess (UI: "Collaborator",
  scoped to specific websites).
- Hierarchy: master org > reseller org > customer org > subscription > website > domain.
  org/website/domain IDs are UUIDs; subscription and plan IDs are integers.
- `GET /login/memberships` tells a token which orgs it belongs to and with which roles.
  Use it for discovery and for the "identity echo" in every tool response.
- `GET /v2/orgs/{org_id}/activities` is the audit log (Owner/SuperAdmin/Sysadmin only).

### Safety-relevant API behaviour

- `DELETE /orgs/{org_id}/websites/{website_id}` is a **soft delete** by default; data
  stays and can be restored. `?force=true` wipes everything and needs a privileged
  master-org member. **Never expose force.**
- `DELETE /orgs/{org_id}` and `DELETE .../subscriptions/{id}` cascade to every website
  underneath. **Never expose in v1; v2 only behind gate if ever.**
- `DELETE /orgs/{org_id}/websites` (bulk, body of UUIDs) exists. **Never expose.**
- Backup restore (`PUT .../backups/{backup_id}`) overwrites files and DBs. Treat as
  destructive.
- `POST .../ssh/keys` appends a public key to the website container's authorized_keys.
  This is the deploy path. `POST .../ssh/password` replaces the unix user password.
- `PATCH .../websites/{id}` with `isSuspended` or `status` can take a site offline.
  Treat as destructive-adjacent.
- `POST /orgs/{org_id}/websites` creates a website; needs `subscriptionId` for
  customer orgs. Clone and push-live are separate endpoints under `/websites/clone`.

## Conventions (to be refined in the design)

- Language: TypeScript, official `@modelcontextprotocol/sdk`. Node 20+.
- Every tool response must echo the resolved target (org name, domain, website UUID)
  so the model and the human both see what was touched.
- Tools are grouped by tier and by risk class: `read`, `write`, `destructive`.
- Secrets (panel URL, token) come from env or a local config file, never from tool
  arguments, never logged, never committed.
