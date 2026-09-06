<h1><img src="https://enhance.com/favicon.svg" alt="Enhance" width="36" height="36" align="absmiddle"> Enhance MCP for Claude Code</h1>

Manage and deploy to your Enhance-hosted websites from Claude Code. One plugin gives you an MCP server with 71 typed, safety-gated tools for the Enhance control panel API plus skills that walk Claude through connecting, deploying and setting up databases (the deploy skill includes the domain, DNS and SSL preflight).

- **Safe by design.** Every tool carries a risk class. Destructive actions (delete a site (a soft delete the provider can restore), remove a domain or SSH key) require your confirmation: Claude Code shows a prompt where you type the domain name yourself, before anything happens; if a client cannot show prompts, the tool instead returns a preview and a single-use token, and the model must relay what you typed. Force deletes, org and subscription deletes, and server administration are not exposed at all. Never add `confirm_action` or any destructive tool (`website_delete`, `domain_remove`, `ssh_key_remove`, `db_delete`, `db_user_delete`, `db_import_sql`, `pg_db_delete`, `pg_user_delete`, `pg_user_revoke`, `cron_delete`) to an always-allow permission rule; they must prompt every time.
- **Fresh hosting to live site.** Domain check, site creation, DNS instructions built from your panel's own nameservers and zone, Let's Encrypt, SSH key setup, rsync deploy, verification on the preview URL.
- **Databases and PHP.** MySQL databases and users with the panel's grant model, phpMyAdmin single sign-on, gzipped SQL export and import; PostgreSQL the same way where the plan allows it. PHP extensions, worker count and error log; the per-site Redis toggle; FastCGI cache clear and PHP restart; panel-managed `.htaccess` rewrites and IP rules; cron jobs.
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
2. Start Claude Code with the plugin loaded from the directory you just built in: `claude --plugin-dir /path/to/enhance-mcp` (Claude Code 2.1.258 has no `plugin add`; a marketplace install comes with the npm publish)
   (the repo root, the directory containing `.claude-plugin/`).

   The plugin runs `server/dist/index.js` in place, so **both `server/dist` and
   `server/node_modules` must exist inside that directory**: the build bundles our own code but
   not the runtime dependencies, and neither directory is committed. Don't move or prune the
   checkout after installing; if you re-clone or run `npm ci` elsewhere, build again.
3. Create a credential: in your panel, Settings → Access Tokens → Create (name it, choose an expiry).
4. Save it where the server reads it:
   ```json
   // ~/.enhance-mcp/config.json
   { "profiles": { "default": { "panelUrl": "https://panel.example.com", "token": "…" } } }
   ```
   `chmod 600 ~/.enhance-mcp/config.json`
5. Check, from the repo root: `node server/dist/index.js doctor`. Confirm no line starts with
   `FAIL` and the last line reads `doctor: all good`.
6. In Claude Code: "connect to my enhance hosting" and follow the `enhance-connect` skill.

**After npm publish** (not available yet): `/plugin marketplace add <this repo>` then
`/plugin install enhance` for the install, and `npx enhance-mcp doctor` for the check, neither of
which needs a local checkout.

## Configuration

| Variable | Purpose |
|---|---|
| `ENHANCE_PANEL_URL` | `https://panel.example.com` |
| `ENHANCE_TOKEN` | access token or panel session credential (auto-detected) |
| `ENHANCE_ORG_ID` | only when the credential belongs to several orgs |
| `ENHANCE_READ_ONLY=1` | register read tools only |
| `ENHANCE_PROFILE` | profile name in the config file |

Environment variables win over the profile file.

## Sandbox note

Claude Code's Bash sandbox cannot open SSH connections. For rsync/ssh deploy steps, add `ssh` and `rsync` to `sandbox.excludedCommands` in your Claude Code settings, or approve the command with the sandbox disabled when asked.

## Status

Milestone A (account, preflight, websites, domains, DNS, SSL, SSH, static-site deploy) is implemented and verified live against a real panel on 2026-09-05 (see "Live test A" in `docs/research.md`).

Milestone B (MySQL, PostgreSQL, PHP settings, Redis, cache, `.htaccess`, cron) is code-complete: every tool has unit and MCP-level tests, and each endpoint's behaviour was probed against the live panel while the tools were written (see "Live probe: milestone B and C endpoints" in `docs/research.md`). **The milestone B live end-to-end test is still pending.**

See `docs/superpowers/specs/2026-09-04-enhance-mcp-design.md` for the roadmap (Node, WordPress, email, backups, staging, GitHub auto-deploy).
