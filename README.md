<h1><img src="https://enhance.com/favicon.svg" alt="Enhance" width="36" height="36" align="absmiddle"> Enhance MCP for Claude Code</h1>

Manage and deploy to your Enhance-hosted websites from Claude Code. One plugin gives you an MCP server with 82 typed, safety-gated tools for the Enhance control panel API plus skills that walk Claude through connecting (`enhance-connect`), deploying (`enhance-deploy`, including the domain, DNS and SSL preflight), setting up databases (`enhance-database`) and installing ready-made Node apps from verified recipes (`enhance-apps`).

- **Safe by design.** Every tool carries a risk class. Destructive actions (delete a site (a soft delete the provider can restore), remove a domain or SSH key) require your confirmation: Claude Code shows a prompt where you type the domain name yourself, before anything happens; if a client cannot show prompts, the tool instead returns a preview and a single-use token, and the model must relay what you typed. Force deletes, org and subscription deletes, and server administration are not exposed at all. Never add `confirm_action` or any destructive tool (`website_delete`, `domain_remove`, `ssh_key_remove`, `db_delete`, `db_user_delete`, `db_import_sql`, `pg_db_delete`, `pg_user_delete`, `pg_user_revoke`, `cron_delete`, `persistent_app_delete`) to an always-allow permission rule; they must prompt every time.
- **Fresh hosting to live site.** Domain check, site creation, DNS instructions built from your panel's own nameservers and zone, Let's Encrypt, SSH key setup, rsync deploy, verification on the preview URL.
- **Databases and PHP.** MySQL databases and users with the panel's grant model, phpMyAdmin single sign-on, gzipped SQL export and import; PostgreSQL databases and users the same way where the plan allows it (export, import and phpMyAdmin are MySQL only). PHP extensions, worker count and error log; the per-site Redis toggle; FastCGI cache clear and PHP restart; panel-managed `.htaccess` rewrites; IP allow/block rules (written as Apache `Require ip`; LiteSpeed servers ignore them, verified live, so verify with curl); cron jobs.
- **Node apps.** Install Node with nvm, register a persistent app with its proxy path and port, watch its log, and verify it on the domain with an in-process probe. A proxy path silently shadows a same-named directory in the document root, so registering one first fetches the path on the live site and refuses to take over a page that already answers there; an app that is the whole site gets the domain root instead (`serve_at_root`). The probe also fetches the images, scripts and stylesheets a page references, so a deploy whose page is 200 with every asset broken is reported as a failure rather than left for the customer to find. Apps answer on the primary domain, not the preview URL.
- **One-click installs of popular Node apps.** Say "install Ghost on blog.example.com" and the `enhance-apps` skill takes it from an empty domain to a working login: the subdomain (its own website, or a folder on an existing one — it explains the trade-off, asks you which you want, and steers Node projects to the isolated website, the only layout a persistent app answers on), SSL, Node, the database, the build, the app behind the proxy, the **first admin account** so no installer is left open to the internet, and a verification pass that reads the app's log and its page assets rather than trusting a status code. Recipes verified live for **Ghost, Payload, EmDash and TanStack Start**.
- **Tested at every layer.** Every tool has unit tests and MCP-level tests, the client was built against a live Enhance panel, and an opt-in live suite exercises the full flow on a throwaway site.

Community project for the [Enhance](https://enhance.com) control panel; not affiliated with or endorsed by Enhance. The icon above is Enhance's own favicon, linked from enhance.com.

## Install

The package is not on npm yet, so there is exactly **one** supported install path: build from a
git checkout and point Claude Code at that same directory.

1. Clone this repo and build the server:
   ```sh
   git clone https://github.com/vahidshaik1901/enhance-mcp.git && cd enhance-mcp
   cd server && npm ci && npm run build
   ```
2. Install the plugin permanently (user scope, so it loads in every Claude Code session).
   The repo root doubles as a local marketplace (`.claude-plugin/marketplace.json`):
   ```sh
   claude plugin marketplace add /path/to/enhance-mcp --scope user
   claude plugin install enhance@enhance-mcp --scope user
   ```
   Claude Code copies the checkout into `~/.claude/plugins/cache/enhance-mcp/enhance/<version>/`,
   so **build first**: `server/dist` and `server/node_modules` must exist when you install
   (the build bundles our own code but not the runtime dependencies, and neither is committed).
   `claude plugin update` is version-gated and does nothing while `plugin.json` still says the
   same version, so after you rebuild or pull refresh the copy with
   `claude plugin uninstall enhance@enhance-mcp && claude plugin install enhance@enhance-mcp`
   (or bump `version` in `.claude-plugin/plugin.json` first, then `claude plugin update`).
   For a one-off session without installing: `claude --plugin-dir /path/to/enhance-mcp`.

3. Create a credential: in your panel, Settings → Access Tokens → Create (name it, choose an expiry).
   A panel session credential works too and is auto-detected, but it expires within hours.
   **OAuth is coming:** the Enhance team is building OAuth sign-in for the panel API. Once it
   ships, this plugin will add it as a third credential mode (sign in from the browser, nothing to
   copy or store by hand) alongside access tokens; the tools and skills stay the same.
4. Save it where the server reads it:
   ```json
   // ~/.enhance-mcp/config.json
   { "profiles": { "default": { "panelUrl": "https://panel.example.com", "token": "…" } } }
   ```
   `chmod 600 ~/.enhance-mcp/config.json`
5. Check, from the repo root: `node server/dist/index.js doctor`. Confirm no line starts with
   `FAIL` and the last line reads `doctor: all good`.
6. In Claude Code: "connect to my enhance hosting" and follow the `enhance-connect` skill.

**After npm publish** (not available yet): `/plugin marketplace add vahidshaik1901/enhance-mcp`
then `/plugin install enhance@enhance-mcp` for the install, and `npx enhance-mcp doctor` for the
check, neither of which needs a local checkout.

## Configuration

| Variable | Purpose |
|---|---|
| `ENHANCE_PANEL_URL` | `https://panel.example.com` |
| `ENHANCE_TOKEN` | access token or panel session credential (auto-detected) |
| `ENHANCE_ORG_ID` | only when the credential belongs to several orgs |
| `ENHANCE_READ_ONLY=1` | register read tools only |
| `ENHANCE_PROFILE` | profile name in the config file |

Environment variables win over the profile file.

Credential modes today: a Bearer access token (recommended) or a panel session credential; the
server probes `/login/memberships` to tell them apart. OAuth will become the third mode when the
Enhance team releases it (see the note in Install).

## Sandbox note

Claude Code's Bash sandbox cannot open SSH connections. For rsync/ssh deploy steps, add `ssh` and `rsync` to `sandbox.excludedCommands` in your Claude Code settings, or approve the command with the sandbox disabled when asked.

## Status

Milestone A (account, preflight, websites, domains, DNS, SSL, SSH, static-site deploy) is implemented and verified live against a real panel on 2026-09-05 (see "Live test A" in `docs/research.md`).

Milestone B (MySQL, PostgreSQL, PHP settings, Redis, cache, `.htaccess`, cron, the `enhance-database` skill and the PHP/Laravel deploy path) is merged and verified live: the milestone B end-to-end suite passed against a real panel on 2026-09-11, and the PHP + MySQL page, a Laravel 13 deploy over SSH and the typed-name confirmation prompt were walked through inside Claude Code on 2026-09-16 (see "Live test B" and "Task 10 walkthrough" in `docs/research.md`).

Milestone C (Node.js via nvm and panel-managed persistent apps: install and pin Node versions, register an app behind the reverse proxy, read its log, probe it on the domain before DNS, delete it through the typed-name gate, plus the Node path in the deploy skill) is merged and verified live by its end-to-end suite, which passed against a real panel on 2026-09-16 and again on 2026-09-17 (see "Live test C" in `docs/research.md`).
An Express app and a Next.js app were deployed to vahi.dev inside Claude Code on 2026-09-17, with the typed-domain delete prompt exercised along the way; both are still up as demos (see "Walkthrough (2026-09-17)" in the same section). Four ready-made Node stacks — Ghost, Payload, EmDash and TanStack Start — were then installed end to end on four subdomain websites on 2026-09-17, each from an empty domain to a claimed admin login, and those runs are what the `enhance-apps` recipes are written from (see "Live test C3" in `docs/research.md`).

Next: email, backups, DNS zone editing, WordPress, staging and the other deploy modes (milestone D). OAuth support lands as soon as the panel offers it.

See `docs/superpowers/specs/2026-09-04-enhance-mcp-design.md` for the roadmap (Node, WordPress, email, backups, staging, GitHub auto-deploy).
