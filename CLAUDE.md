# Enhance MCP + Skills

Professional MCP server and Claude Code skills for the Enhance hosting control panel
(https://enhance.com). Focused purely on Enhance and its API; not tied to any hosting
provider or billing system. Lets a customer manage and deploy to their Enhance-hosted
websites from Claude Code, with strong guardrails so an AI can never wipe a server or
delete a site by accident.

## Current status (2026-09-24)

**Phase: milestone D1 MERGED to `main` (2026-09-24, PR #5, merge commit be91476).** Milestone D was
split into D1-D6 (spec `docs/superpowers/specs/2026-09-17-milestone-d1-foundations-design.md`,
section 1): D1 foundations and files (done), D2 backups and staging (NEXT: brainstorm, spec, plan),
D3 WordPress and apps, D4 email, D5 DNS zone, D6 deploy modes B/C + more app recipes. D1 (plan
`docs/superpowers/plans/2026-09-24-milestone-d1-foundations.md`, 9 tasks, every subagent on Opus,
user gave full authority on 2026-09-24) added:
- **write-then-verify** (`server/src/core/verify.ts`) on the nine creates (`website_create`,
  `domain_add`, `ssh_key_add`, `db_create`, `db_user_create`, `pg_db_create`, `pg_user_create`,
  `cron_add`, `persistent_app_create`): a 4xx passes through; an unclear answer (timeout, network
  error, 5xx) is settled by re-reading, bounded by a read count AND a real-clock deadline; a found
  object reports "…confirmed by reading it back: it did land."; otherwise "OUTCOME UNKNOWN … Do not
  retry yet. Run <settling read> first". Each adopter guarantees a found object is its own (pre-check
  refusal, snapshot of ids, or a slot nothing else holds). `website_create` re-checks `domain_check`
  every 5 s for 90 s and also handles a body-less 2xx. This fixed the one live bug on record (two
  parallel creates reported as client timeouts on 2026-09-17 although the panel created them).
- **`files_list`** (tool 83; a client lists 84 with `confirm_action`): read-only listing through the
  panel's undocumented file service. It mints a 240 s site token that CAN WRITE, so `core/files.ts`
  sends exactly one GET shape, checks the address before minting, refuses redirects, caps at 8 MiB,
  zod-validates, refuses a tree deeper than asked, and never returns/logs/audits the token. File
  tooling is list-only by decision: reads, uploads, renames and deletes stay on rsync/SSH.
- the clash refusal's "on disk (the panel's file service): …" second opinion (5 s budget, never
  decides; wording never reads as leave to override), the asset check moved to `core/probe.ts`,
  three descriptions trimmed under 1000 chars, milestone C minors, a no-wait test harness
  (unit suite 3.5 s), and the spec re-vendored to 12.25.12 (version line only).
538 unit tests. LIVE on vahi.dev 2026-09-24 ("Live test D1" in docs/research.md): D1 suite 4/4 incl.
three parallel creates (soft-deleted by the suite), B 4/4 and C 2/2 regressions, all green again at
the final commit; a forced check (create POST reached the panel, client told it timed out) answered
created=true, confirmedBy=verify in 6 s. NOT YET DONE: the in-Claude-Code walkthrough (files_list, a
clash refusal, a typed website_delete) after the plugin refresh. After-merge minors from the D1
reviews are in the ledger (`.superpowers/sdd/progress.md`, "AFTER MERGE (for D2+ planning)"),
including a `domain_update` tool (PATCH `.../domains/{id}`) so remap refusals need not advise
`domain_remove`. Soft-deleted test domains `d1-5911d7-1/2/3.vahi.dev` and `d1v-652a97.vahi.dev`
linger in `/orgs/{org}/domains`. The Ghost and EmDash trial installers are STILL UNCLAIMED (an
attempt to claim Ghost was blocked by the permission classifier on 2026-09-24): the user decides.

Milestone C is MERGED to `main` (2026-09-17, PR #4, merge commit ce642b7; all of Tasks 0-9 of
`docs/superpowers/plans/2026-09-16-milestone-c-node.md` done, walkthrough included). Tasks 0-8 are
LIVE-VERIFIED; Task 9's path-clash guard and asset check were first exercised live on 2026-09-17,
where the asset check made one genuine catch (a `/favicon.ico` referenced at the domain root, 404
there while `/next/favicon.ico` was 200) and two FALSE failures (healthy Next.js chunks that blew
the 2 s deadline because twelve fetches ran at once), fixed in commit a806b59: asset
fetches now run 4 at a time with an 8 s deadline and a timeout is reported as unchecked, never as a
failure (item 15 under "Milestone C Task 1 probe" in docs/research.md).
82 tools are registered (a client lists 83 with `confirm_action`): milestones A and B plus
`node_install`, `node_versions_available`, `node_versions_installed`, `node_version_install`,
`node_version_set_default`, `persistent_apps_list`, `persistent_app_create`,
`persistent_app_update`, `persistent_app_delete` (destructive, typed domain), `persistent_app_log`
and `persistent_app_probe`. 424 unit tests; the milestone C live suite passed 2/2 against vahi.dev
on 2026-09-16 and again on 2026-09-17 after the review fixes — **that suite** found no tool bug and
needed no tool fix, which is not the same as "the tools were clean": the user's own probe the same
day found the asset check's false failures (item 15), and the C3 trial produced the
`enhance-apps` corrections (see "Live test C" and "Live test C3" in docs/research.md). The Task 8 walkthrough ran on 2026-09-17 on vahi.dev
inside Claude Code with the plugin reinstalled from this branch: an Express app and a Next.js app
deployed behind the proxy and verified in the browser, `clear_proxy`, a deliberate restart, and the
typed-domain prompt for `persistent_app_delete` twice (see "Walkthrough (2026-09-17)" under "Live
test C" in docs/research.md). It found no tool bug but forced the corrections in commits
8f86607 and da0702e: the proxy strips the path prefix, a 404-from-the-app hint in `persistent_app_probe`,
`clear_proxy` verified, and honest ("usually") restart wording. Task 9 then added the guardrails it
called for: `persistent_app_create` and a path-moving `persistent_app_update` fetch both `/<path>`
and `/<path>/` before writing and refuse unless both answer 404 (`replace_existing_path=true`
overrides, and an existing directory shows only as a 301 on the bare form), `serve_at_root=true`
hands an app the whole domain through the panel's empty proxy path, and `persistent_app_probe` now
fetches the assets an HTML page references (4 at a time, 8 s each) and fails the probe when one is
definitely missing — 404, 410 or 5xx — while a fetch that timed out is reported as unchecked and
never fails anything. The final-review wave (2026-09-17) then made a create whose follow-up listing
fails stay a success with `id: null`, made the asset check report its own cap
(`attempted`/`checked`/`truncated`/`totalFound`, so a page naming more than 12 references is never
summarised as "all 12 answered"), dropped the listing GET the delete handler never read, and turned
the probe's missing-argument throw and the three "no persistent app with id" refusals into the
standard identity-block refusals. Skills: `enhance-deploy` extended
with the Node path (runtime, app directory, port, proxy path and prefix stripping, rsync target,
post-deploy order, probe) and `persistent_app_delete` added to its safety rules.
On 2026-09-17 a live trial with the product owner installed four popular Node stacks end to end
through the tools — TanStack Start, Ghost 6.64 (on MariaDB 11.4, socket-only), Payload 3.89 and
EmDash 0.38, each on its own subdomain website with `serve_at_root=true` — and produced the new
`enhance-apps` skill (four recipes plus `candidates.md`, the two subdomain modes, the first-admin
rule, log+asset verification, finished-theme default); see "Live test C3" in docs/research.md. The
four trial sites (`start`, `ghost`, `payload`, `emdash` under vahi.dev) and the two demo apps on
vahi.dev (`/express/`, `/next/`) are LIVE TEST RESOURCES left running on purpose: remove them
(`persistent_app_delete`, `rm -rf` over SSH, then `website_delete`) only when the user says so.
The final whole-branch reviews (code; skills and docs), one fix wave and a focused re-review
ended "Ready to merge: Yes" (424 unit tests). Its after-merge follow-ups (write-then-verify, the
probe move to `core/probe.ts`, `files_list`) were delivered in milestone D1 above.
Milestone B is MERGED to `main` (2026-09-16, PR #3, merge commit ecb0d96); all 10 tasks of
`docs/superpowers/plans/2026-09-05-milestone-b-php-databases.md` done, including the Task 10
walkthrough on 2026-09-16: PHP page reading MySQL, Laravel 13 `composer install` + `migrate` over
SSH, and the typed-name prompt for `db_import_sql`/`db_delete`/`db_user_delete` inside Claude Code;
see "Task 10 walkthrough" in docs/research.md. It added MySQL, PostgreSQL, PHP
extensions/workers/error log, Redis, FastCGI cache, htaccess rewrites and IP rules, and cron; the
milestone B live suite passed 4/4 against vahi.dev on 2026-09-11 with a fresh session JWT (see
"Live test B" in docs/research.md). That run found and fixed one live bug: `db_import_sql` must name
the multipart field `<database>.sql` (commit 910e494; the spec's `sql` name is rejected by the
panel). Skills: `enhance-database` added, `enhance-deploy` extended with the PHP/Laravel build and
post-deploy steps, PHP settings and cron, and access control. After-merge minors from the B
reviews are in `.superpowers/sdd/milestone-b-minors.md`, and milestone C's in
`.superpowers/sdd/milestone-c-minors.md` (both git-ignored). The upstream spec was
re-vendored on 2026-09-16 (milestone C Task 0): both vendored copies are 12.25.11 and the advisory
`spec-drift` CI job is green.
Milestone A is MERGED to `main` (2026-09-05, PR #1, merge commit 7c0e4fa) in the public repo
https://github.com/vahidshaik1901/enhance-mcp and was live-verified (e2e 8/8 plus the Task 19
walkthrough; see "Live test A" in docs/research.md). The static test site from
`~/enhance-e2e-site` is still deployed on vahi.dev (preview URL vahi-dev-ccyq.sgp1.mystaging.site).
Since 2026-09-16 vahi.dev resolves: A and www at Cloudflare (DNS only, proxy off) to 65.98.32.45,
Let's Encrypt cert for vahi.dev + www (expires 2026-12-04), force-HTTPS on. A PHP login demo
lives at https://vahi.dev/demo-login/ (db + user `vahi_dev1_demo`, source not in the repo).**
Spec: `docs/superpowers/specs/2026-09-04-enhance-mcp-design.md`.
Plans: milestone A `docs/superpowers/plans/2026-09-04-milestone-a-foundation.md` (19 tasks, TDD);
milestone B `docs/superpowers/plans/2026-09-05-milestone-b-php-databases.md` (10 tasks, TDD);
milestone C `docs/superpowers/plans/2026-09-16-milestone-c-node.md` (Tasks 0-9, TDD);
milestone D1 `docs/superpowers/plans/2026-09-24-milestone-d1-foundations.md` (9 tasks, TDD; its spec
`docs/superpowers/specs/2026-09-17-milestone-d1-foundations-design.md`).
Execute with `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
Key library facts: MCP TypeScript SDK is v2 (`@modelcontextprotocol/server`
2.0.0, `serveStdio`, `registerTool`, elicitation via the SDK's `inputRequired` flow), zod 4
(`zod/v4`), openapi-fetch 0.17, openapi-typescript 7.13, npm name `enhance-mcp` is free.
Claude Code supports MCP elicitation (>= 2.1.76) but advertises a bare `elicitation: {}`
capability and negotiates the legacy protocol era; the server uses the SDK's `inputRequired`
flow (not `elicitInput`) so the human prompt works on both eras (see docs/research.md).
`outputSchema` has known issues so tools return `structuredContent` without declaring one;
the Bash sandbox can never carry SSH (use `sandbox.excludedCommands` or run unsandboxed).
Progress: milestones A, B, C and D1 are merged to `main` (ledger in `.superpowers/sdd/progress.md`, git-ignored; `git log` is the
recovery map). Session JWTs expire within hours and the org still has no access token, so ask for
a fresh cookie before any live work. To run the live suite: put the credential in `.env`
(`ENHANCE_TOKEN`, or a session JWT as `ENHANCE_SESSION_COOKIE`), then from the repo root:
`cd server && set -a && source ../.env && set +a && ENHANCE_TOKEN="${ENHANCE_TOKEN:-$ENHANCE_SESSION_COOKIE}" ENHANCE_E2E=1 ENHANCE_E2E_SITE=vahi.dev npx vitest run --config vitest.e2e.config.ts test/e2e/milestone-b.e2e.test.ts`.
The milestone C suite runs the same way with `test/e2e/milestone-c.e2e.test.ts` (same env recipe; it
needs nvm on the site, installs it on first run, and leaves one `persistent_app_<id>.log` behind).
The milestone D1 suite `test/e2e/milestone-d1.e2e.test.ts` runs the same way and is read-only by
default (file-service shape, `files_list`, one clash refusal that can never register an app); its
create half needs `ENHANCE_E2E_CREATE=1 ENHANCE_E2E_SUBSCRIPTION_ID=686` (optional
`ENHANCE_E2E_PARENT_DOMAIN`) and creates then soft-deletes three `d1-<tag>-N.<parent>` websites.
(`npm run test:e2e` also runs the milestone A suite, which creates and deletes a throwaway
website and additionally needs `ENHANCE_E2E_SUBSCRIPTION_ID=664`.)
The plugin is installed permanently at user scope from this repo as a local marketplace
(`.claude-plugin/marketplace.json`; installed 2026-09-16 via `claude plugin marketplace add <repo>`
+ `claude plugin install enhance@enhance-mcp`). Claude Code COPIES the checkout into
`~/.claude/plugins/cache/enhance-mcp/enhance/0.1.0/`, and `claude plugin update` is version-gated
(a no-op while plugin.json stays 0.1.0), so after a rebuild or pull refresh it with
`claude plugin uninstall enhance@enhance-mcp && claude plugin install enhance@enhance-mcp`
(verified 2026-09-16), then delete the copied `.env` from the cache dir.
The project-scope `.mcp.json` (same server, `${CLAUDE_PLUGIN_ROOT}` unresolved) still shows
"Connection closed" inside this repo; the plugin copy is the one that works. The server reads
`~/.enhance-mcp/config.json`; `node server/dist/index.js doctor` checks it.

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
   `/login/memberships`. Decided 2026-09-04. **OAuth is coming** (the Enhance team is building
   it, per the user on 2026-09-16): add it as a third credential mode when it ships, browser
   sign-in with the token stored by the server, tools unchanged. Noted in the README.
7. **Destructive ops: two-step confirmation gate** (preview + confirmation token + the
   human typing the domain name). Never expose `force=true`, org delete, subscription
   delete, or bulk website delete. Assumed from my recommendation; confirm in design review.

## Live test panel (verified 2026-09-04, read-only probes)

- Panel: `https://e4500.sgp1.stableserver.net`, API base `/api`, orchd version **12.25.5** at first,
  **12.25.11** on 2026-09-24 (panel and filerd); the vendored spec copy is 12.25.12 (treat small
  deltas as possible).
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
- **Milestone C live facts** (Node and persistent apps, probed 2026-09-16/17; full notes in
  docs/research.md under "Milestone C Task 1 probe"):
  - A persistent-app create, update or delete **usually restarts the whole website container**, not
    just the app, so expect the site's PHP and static pages to be interrupted for a second or two
    each time. Verified for create, delete, and updates that change the start mode or the command
    or clear the proxy; one update that only added a proxy to an app that had none applied without
    a restart (one observation). To restart on purpose, resend a field the app already has
    (`start_mode=automatic`).
  - `command` is exec'd as argv with no shell and no injected `PORT`, so a `VAR=value` prefix, a
    pipe or a redirection can never work; the app must take its port from its own config.
  - An app created without a `nodeVersion` never starts (`exec: node: not found`); `"default"` is
    the nvm alias and is what the create tool sends when the caller pins nothing.
  - A proxy path shadows a same-named `public_html/<path>` directory, and returns 503 while the app
    is stopped (a live PHP page went 200 → 503 on registration alone).
  - A duplicate proxy path is refused with 409 `already_exists`; duplicate ports are accepted
    unchecked, so the port check is the caller's job.
  - The log endpoint returns a 256 KiB tail (cut mid-line), the file is truncated on every restart,
    and it outlives the app's deletion as `persistent_app_<id>.log` in the home.
  - `GET .../apps/node/versions` omits exactly the version nvm's `default` alias points at, so it is
    never authoritative; `nvm ls` over SSH is.
  - Apps answer on the **primary domain only**; the `*.mystaging.site` preview URL 404s the proxy
    path.
  - The proxy **strips the path prefix** before forwarding (walkthrough): `/express/foo` reaches the
    app as `/foo`, so an app serves its routes at `/` and must never mount itself under the path.
    Next.js therefore needs `assetPrefix: '/<path>'` and **no** `basePath` — a `basePath` build
    answers its own 404 page to the `/` the proxy hands it.
  - `clear_proxy` is verified live: `proxyDetails: Unset` leaves `proxy: null`, the URL falls
    through to the docroot (404) and the Node process keeps running untouched; re-expose the app
    with a later `proxy_path`/`port` update.
  - An **empty proxy path is accepted and owns the whole site** (probed on vahid2.dev 2026-09-17):
    `/`, `/anything/deep` and `/index.html` all answered 503 while a stopped app held `""`, and the
    docroot came back only when the app was deleted; `"/"` and `"."` are a 400. Exposed as
    `serve_at_root` on `persistent_app_create`, behind the path preflight; `validateProxyPath` still
    rejects `""`.
  - **`assetPrefix` covers only the framework's own bundles.** Files in `public/`, generated links
    and absolute `fetch` calls still go to the domain root: the user's broken images on
    `https://vahi.dev/next/` were `/next.svg` (404 at the root) while `/next/next.svg` was 200. So a
    200 page can be wholly broken, and `persistent_app_probe` now fetches a page's assets and fails
    when any of them does not answer.
  - **A directory shows only on the bare path** (probed on vahi.dev 2026-09-17): an existing
    directory answers **404 on `/dir/`** unless it holds an index file, while the bare `/dir` answers
    **301 → `https://<domain>/dir/`** for every directory that exists — empty, holding files, or
    holding an index page. A file is
    200 on `/file` and 404 on `/file/`, a nonexistent path 404s both ways, and a path an app owns
    answers 200 both ways. So the path-clash preflight asks **both** forms and calls a path free only
    when both answer 404.

## Enhance API facts (verified from the live spec)

- Spec: https://apidocs.enhance.com/spec/oas3-api.yaml (OpenAPI 3.0.3, version 12.25.12,
  re-vendored 2026-09-24; 12.25.8, 12.25.11 and 12.25.12 differ only in the `info.version` line;
  the advisory `spec-drift` CI job is green).
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
- `POST /orgs/{org_id}/websites/{id}/access-tokens` mints a 240 s site JWT with `read_only: false`
  (it can write through the panel's file service, `filerd`, whose routes are not in the public spec).
  The MCP uses it for exactly one GET (`files_list`, the clash refusal's on-disk line); file tooling
  is list-only by decision. filerd always lists from the site home; `maxDepth=N` returns N+1 levels.
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
