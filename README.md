# Enhance MCP for Claude Code

Manage and deploy to your Enhance-hosted websites from Claude Code. One plugin gives you an MCP server with typed, safety-gated tools for the Enhance control panel API plus skills that walk Claude through connecting and deploying (the deploy skill includes the domain, DNS and SSL preflight).

- **Safe by design.** Every tool carries a risk class. Destructive actions (delete a site (a soft delete the provider can restore), remove a domain or SSH key) require your confirmation: Claude Code shows a prompt where you type the domain name yourself, before anything happens; if a client cannot show prompts, the tool instead returns a preview and a single-use token, and the model must relay what you typed. Force deletes, org and subscription deletes, and server administration are not exposed at all.
- **Fresh hosting to live site.** Domain check, site creation, DNS instructions built from your panel's own nameservers and zone, Let's Encrypt, SSH key setup, rsync deploy, verification on the preview URL.
- **Tested at every layer.** Every tool has unit tests and MCP-level tests, the client was built against a live Enhance panel, and an opt-in live suite exercises the full flow on a throwaway site.

## Install

1. Build the plugin server from a git checkout of this repo (once): `cd server && npm install && npm run build` (`npm ci` also works; the lockfile is committed).
2. Install the plugin in Claude Code: `claude plugin add /path/to/this/repo` (or, once a marketplace is set up for it, `/plugin marketplace add <this repo>` then `/plugin install enhance`).
3. Create a credential: in your panel, Settings → Access Tokens → Create (name it, choose an expiry).
4. Save it where the server reads it:
   ```json
   // ~/.enhance-mcp/config.json
   { "profiles": { "default": { "panelUrl": "https://panel.example.com", "token": "…" } } }
   ```
   `chmod 600 ~/.enhance-mcp/config.json`
5. Check: `node server/dist/index.js doctor` (or, wherever Claude Code installed the plugin, `node <plugin>/server/dist/index.js doctor`). Confirm no line starts with `FAIL` and the last line reads `doctor: all good`.
   Note: after the package is published to npm, `npx enhance-mcp doctor` will work too, without a local checkout.
6. In Claude Code: "connect to my enhance hosting" and follow the `enhance-connect` skill.

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

Milestone A (account, preflight, websites, domains, DNS, SSL, SSH, static-site deploy) is implemented; the live milestone test against a real panel is pending. See `docs/superpowers/specs/2026-09-04-enhance-mcp-design.md` for the roadmap (PHP and databases, Node, WordPress, email, backups, staging, GitHub auto-deploy).
