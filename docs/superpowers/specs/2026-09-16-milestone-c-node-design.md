# Milestone C: Node.js and persistent apps — design

Date: 2026-09-16. Status: approved in brainstorming, awaiting the implementation plan.
Parent spec: `2026-09-04-enhance-mcp-design.md` §6 "Milestone C". This document refines that
section with the live facts learned on 2026-09-05 (see "Node and persistent apps" in
`docs/research.md`) and the decisions taken with the user on 2026-09-16.

## 1. Goal

A customer deploys a Node.js application to their Enhance-hosted website from Claude Code:
install Node in the site container, upload the code, build it, register it as a persistent app
behind the web server's reverse proxy, watch its log, and verify it on the domain. Same
guardrails as milestones A and B: thin tools that mirror the panel API, one destructive tool
behind the typed-name gate, every response echoing the target site.

Out of scope: WordPress, email, backups, DNS zone editing, staging (milestone D); a restart
endpoint (the API has none — see §3.4); a document-root change (panel UI only).

## 2. Decisions taken on 2026-09-16

1. **Task 0 re-vendors the API spec** from 12.25.8 to the upstream 12.25.11 and regenerates the
   types before any milestone C tool is written. The advisory `spec-drift` CI job currently fails.
   Milestone B's after-merge minors stay parked in `.superpowers/sdd/milestone-b-minors.md`.
2. **Live test and walkthrough run on vahi.dev** (DNS resolves, real certificate, site id
   `6106382b-143f-4d24-9bea-0e9368ad2a1f`, unix user `vahi_dev1`). The static site and the
   `demo-login/` PHP page stay; Node apps sit beside them on proxy paths.
3. **Thin tools plus skill orchestration.** Ten tools mirror the API one to one, plus one
   verification read (`persistent_app_probe`). No composite deploy tool. The deploy skill does
   rsync, `npm ci` and the build over SSH, as it does for PHP.

## 3. Tools

All tools take `website` (domain, alias or UUID) like every milestone A/B tool and resolve it
through the existing resolver. Tool names, risk classes and file placement:

| Tool | Risk | File | Endpoint |
|---|---|---|---|
| `node_install` | write | `tools/node.ts` | `POST /websites/{id}/apps/node` |
| `node_versions_available` | read | `tools/node.ts` | `GET .../apps/node/possible_versions` |
| `node_versions_installed` | read | `tools/node.ts` | `GET .../apps/node/versions` |
| `node_version_install` | write | `tools/node.ts` | `POST .../apps/node/versions` (body: bare semver string) |
| `node_version_set_default` | write | `tools/node.ts` | `PUT .../apps/node/versions/default` (body: bare string) |
| `persistent_apps_list` | read | `tools/apps.ts` | `GET .../apps/persistent` |
| `persistent_app_create` | write | `tools/apps.ts` | `POST .../apps/persistent` |
| `persistent_app_update` | write | `tools/apps.ts` | `PATCH .../apps/persistent/{app_id}` |
| `persistent_app_delete` | **destructive** | `tools/apps.ts` | `DELETE .../apps/persistent/{app_id}` |
| `persistent_app_log` | read | `tools/apps.ts` | `GET .../apps/persistent/{app_id}` |
| `persistent_app_probe` | read | `tools/apps.ts` | none (HTTPS request from the MCP process) |

Registered count goes from 71 to 82 (83 as listed by a client, with `confirm_action`).

### 3.1 Node runtime tools (`node.ts`)

- **`node_install`** installs nvm and the current stable Node into the container (verified
  2026-09-05: 26.8.1 arrived, `~/.nvm` created). Pre-check: `canUse.persistentApps` must be true
  (the panel gates Node behind the same allowance); refuse with a plan message otherwise. The
  response names the site and says that installing takes up to a minute. Task 1 probes live what
  a second call does (no-op, reinstall, or error) and the description states it.
- **`node_versions_available`** returns the nvm list as strings, newest first, with a count. It
  is long (0.12 through 26.x); the text rendering shows the newest of each major and says how
  many more there are, `structuredContent.versions` carries all of them.
- **`node_versions_installed`** returns the panel's list **labelled "as reported by the panel"**.
  Live finding: after `node_version_install 22.23.2` and setting it default, this endpoint still
  returned only `["26.8.1"]` while `nvm ls` showed both. The description and the text output say
  the list can lag and that `ssh … 'nvm ls'` is authoritative. The tool never claims a version
  is absent.
- **`node_version_install`** takes `version` (semver, validated by zod against
  `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`) and sends it as a bare JSON string.
  Pre-check as `node_install`. Says the install can take a minute.
- **`node_version_set_default`** takes `version` as semver, `"stable"` or `"default"` (the API's
  `NodeVersion` selector) and sends it as a bare JSON string. Says that apps without an explicit
  `nodeVersion` start on the default alias.

### 3.2 Persistent app tools (`apps.ts`)

Shared pre-check `persistentAppsGate(site)`: `canUse.persistentApps` must be true, else refuse
without sending anything (same pattern as the PostgreSQL gate, but say "not enabled" when the
block is absent, per the B review note).

- **`persistent_apps_list`** renders a table: id, kind (`generic` or `openclaw`, from the new
  `appKind` field), command, working directory, node version (or `default`), start mode, proxy
  path, port, WebSocket flag. Empty list says so and points at `persistent_app_create`.
- **`persistent_app_create`** arguments:
  - `command` (string, required) — e.g. `node server.js`, `npm start`.
  - `working_directory` (string, optional) — **relative to the site home**. Absolute paths are
    rejected by the tool (the panel silently stores them as `null`, so the app runs from the home
    directory and fails with "Cannot find module"; verified live). Also reject `..` segments.
  - `proxy_path` (string, optional) — the URL path the web server proxies to the app. Must match
    the panel's rule: starts with `[A-Za-z0-9_]`, may contain `-`, `.`, `/` only in the middle,
    **no leading slash** (a leading slash is a 400; verified). The tool strips one leading slash
    with a note rather than failing, and rejects anything else that does not match.
  - `port` (integer 1024–65535, required when `proxy_path` is given) — the port the app listens on.
    The skill passes it to the app as `PORT`.
  - `allow_websocket` (boolean, default false).
  - `start_mode` (`automatic` | `manual`, default `automatic`).
  - `node_version` (semver | `stable` | `default`, optional).
  The response echoes the created app (id, everything above) and the URL where it will answer:
  `https://<primary domain>/<proxy_path>/`, with the reminder that the preview domain never
  proxies persistent apps (verified live: 200 on the primary domain, 404 on `*.mystaging.site`).
- **`persistent_app_update`** takes `app_id` (uuid) plus any subset of the create arguments, and
  two flags for the API's `Unset` shape: `clear_proxy` (drops the proxy so the app is no longer
  exposed) and `clear_node_version` (back to the default alias). Sends only the fields given.
  Task 1 probes live whether a PATCH restarts the running process; the description states the
  finding (either "an update restarts the app" or "an update does not restart the app; set
  `start_mode` to manual then automatic to restart", whichever proves true).
- **`persistent_app_delete`** is destructive: it stops the process and removes the app and its
  proxy. Preview names the app (id, command, path) and the site; the human types the **domain
  name** (the gate's existing contract). Note in the response that
  `persistent_app_<id>.log` stays in the home directory (verified) and can be removed over SSH.
- **`persistent_app_log`** returns the newest 64 KB of the app's startup and stdout log (the
  endpoint returns the whole log as a string; cap and mark `truncated` like `php_error_log`).
  Empty log says the app has not started yet or has not written anything.
- **`persistent_app_probe`** takes `app_id` (or `proxy_path` directly), performs an HTTPS `GET`
  to `https://<serverIps[0].ip>/<path>/` with SNI and `Host` set to the **primary domain**, a
  5 s timeout, no redirects followed, certificate errors tolerated (the domain may still carry the
  placeholder certificate). Returns status, latency, `content-type`, the first 512 bytes of the
  body, and `certificate: 'placeholder' | 'valid' | 'error:<reason>'`. This is the `curl
  --resolve` fallback from milestone A, done in-process so the model can verify without a shell.
  It is `risk: read` and audited like other reads (not at all).

### 3.3 Validation and error mapping

- Panel 400 on a bad proxy path or unknown version is surfaced verbatim through `EnhanceApiError`,
  as milestone B does for MySQL.
- 403 `unauthorized` on the Node endpoints maps to the existing role message.
- A site with no `unixUser` cannot host apps; the resolver's existing guard applies.

### 3.4 Restart

The API has no restart endpoint. The skill's documented restart is whatever Task 1 verifies live:
a no-change PATCH, or toggling `start_mode`. If neither restarts the process, the skill says so
and documents `persistent_app_delete` + `persistent_app_create` as the only way, and the plan
adds a research note asking Enhance for a restart endpoint.

## 4. Skill changes (`enhance-deploy` only)

The Node bullet in step 7 ("handled by a later milestone; stop") is replaced by a Node path.
No new skill file.

1. **Detect** a Node project (`package.json` with a `start` or `build` script, or a framework
   marker such as `next.config.*`). Stop and say so when `canUse.persistentApps` is false.
2. **Runtime**: `node_versions_installed` (labelled as possibly stale) then `ssh 'nvm ls'` to
   confirm; `node_install` when `~/.nvm` is absent; `node_version_install` + `node_version_set_default`
   for the version in `.nvmrc` or `engines.node`, else the current LTS.
3. **Upload** with rsync to a named directory in the home (`<home>/<app>`; never the docroot,
   never the home root), excluding `.git`, `node_modules`, `.env` and build output (`.next`,
   `dist`, `build`) — `-rltvz`, dry run first, as for PHP.
4. **Build on the server** over SSH: `npm ci` (or `npm install` without a lockfile) then
   `npm run build` when the script exists. If the build is killed for memory, fall back to a
   local build and upload the output directory (Next.js: `output: 'standalone'`), and say so.
5. **Configure**: write `.env` on the server (never rsync a local one); pick a free port in
   3000–3999 not used by `persistent_apps_list`; the command carries it: `PORT=<port> npm start`
   (or `PORT=<port> node server.js`). Next.js: `next start -p <port>`.
6. **Register**: `persistent_app_create` with `working_directory=<app>`, `proxy_path`, `port`,
   `allow_websocket` when the app uses WebSockets (Socket.IO, Next.js dev is not relevant in
   production), `node_version` when pinned.
7. **Watch**: `persistent_app_log` until it shows the listening line or an error; on an error read
   the log before changing anything.
8. **Verify**: `persistent_app_probe`, then `curl https://<primary domain>/<path>/` when DNS
   resolves. State that the preview URL will not work for the app.
9. **Later changes**: rsync again, rebuild, then restart per §3.4; `persistent_app_update` for
   port, path or version changes.

A short "Node runtime" paragraph under "PHP settings and cron" covers listing versions, reading
logs, and the `persistent_app_delete` gate.

## 5. Testing

- **Unit** (`test/tools-node.test.ts`, `test/tools-apps.test.ts`): request shapes for every tool
  with the fake-fetch harness (bare-string bodies for the two version endpoints; PATCH sends only
  the given fields; `Unset` for the clear flags), the validation refusals (absolute working
  directory, bad proxy path, port range, semver), the `persistentApps` gate for every tool in
  `apps.ts` and the two Node writes, the 64 KB log cap, and the probe against a local HTTPS
  server stub (status, timeout, placeholder detection).
- **MCP smoke**: registered count 82; `persistent_app_delete` in the destructive set; the
  never-exposed guard still passes.
- **e2e** (`test/e2e/milestone-c.e2e.test.ts`, opt-in, `ENHANCE_E2E_SITE=vahi.dev`): install
  Node if `~/.nvm` is absent (skip otherwise), install one version and set it default, create an
  app whose command is an inline server —
  `node -e "require('http').createServer((q,s)=>s.end('mcp-c ok')).listen(process.env.PORT)"`
  with `PORT=` in the command — on proxy path `mcpc-<rand>`, wait for the log, probe the domain
  and expect `mcp-c ok`, update the port, delete through the gate, and assert `persistent_apps_list`
  no longer shows it. Guarded cleanup in `afterAll`. Runs in about a minute.
- **Walkthrough with the user** on vahi.dev: an Express app and a Next.js app deployed through
  the skill, each reachable on `https://vahi.dev/<path>/`, each surviving the §3.4 restart, and
  the typed-name prompt for `persistent_app_delete` inside Claude Code. Findings go to
  `docs/research.md` under "Live test C".

## 6. Delivery

- Branch `feat/milestone-c`, `superpowers:subagent-driven-development`, every subagent on Opus.
- Task order: 0 spec re-vendor and type regeneration; 1 live probe of the open questions (§7)
  with the fresh credential, results into `docs/research.md`; 2 `node.ts`; 3 `apps.ts` reads and
  writes; 4 `persistent_app_delete` gate and `persistent_app_probe`; 5 registration, smoke count,
  never-exposed guard; 6 skill; 7 e2e harness; 8 docs (README, CLAUDE.md) and the walkthrough.
- Docs: README tool list and status, CLAUDE.md status, `research.md` "Live test C".

## 7. Open questions, settled live in Task 1 before the tools are written

1. What a second `node_install` does (no-op, reinstall, or error).
2. Whether a PATCH on a running app restarts it; whether toggling `start_mode` does.
3. Whether the panel rejects a port already used by another app, and what a proxy path that
   collides with a real directory in the docroot does.
4. The size of a long-running app's log through `GET .../apps/persistent/{id}` (is it capped
   server-side?).
5. What `appKind: openclaw` is; the tools display it and otherwise ignore it.
6. Whether `nodeVersion` on an app accepts `"stable"`/`"default"` as the schema says.
