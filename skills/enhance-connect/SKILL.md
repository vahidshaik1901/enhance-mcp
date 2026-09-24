---
name: enhance-connect
description: Set up, verify and troubleshoot the connection between Claude Code and an Enhance hosting control panel. Use when the user says "connect to enhance", "set up my hosting", mentions an Enhance panel URL or token, or when any enhance tool returns unauthorized, no_session_token, or a config error.
---

# Connect Claude Code to an Enhance panel

Read `references/safety-rules.md` first; it applies to everything below.

## What the customer needs

1. **Panel URL**: the address they log into, e.g. `https://panel.example.com`. The MCP appends `/api` itself.
2. **Credential**, one of:
   - an **access token** created in the panel under Settings → Access Tokens (recommended; give it a name, roles SuperAdmin or SiteAccess, an expiry, no IP restriction unless they know their IP);
   - a **panel session credential** copied from the panel (works until they log out or the session times out).
   The MCP detects which one it was given.

## Where the values go

Preferred, a profile file the server reads on its own:

```json
// ~/.enhance-mcp/config.json  (chmod 600)
{ "profiles": { "default": { "panelUrl": "https://panel.example.com", "token": "…" } } }
```

Alternative: environment variables `ENHANCE_PANEL_URL` and `ENHANCE_TOKEN` in the shell that starts Claude Code. Optional: `ENHANCE_ORG_ID` (only when the credential belongs to several orgs), `ENHANCE_READ_ONLY=1` (browse safely, no writes), `ENHANCE_PROFILE=<name>`.

Never ask the user to paste the credential into the chat. Point them at the file or the env var.

## Verify

1. Run the plugin's built server first: `node <plugin dir>/server/dist/index.js doctor`, where `<plugin dir>` is the checkout you pass to `claude --plugin-dir` (or, for a marketplace install after publish, `~/.claude/plugins/…`). From the checkout itself that is `node server/dist/index.js doctor`, run in the repo root. If `server/dist` or `server/node_modules` is missing, build once first: `cd server && npm ci && npm run build` — the plugin needs both, since the build bundles the plugin's own code but not its runtime dependencies. Confirm no line starts with `FAIL`, and the last line reads `doctor: all good`.
   Note: after the package is published to npm, `npx enhance-mcp doctor` works too.
2. Call the `auth_status` tool. Confirm the org name and, for access tokens, the expiry. Warn if it expires within a week.
3. Call `subscriptions_list` and `websites_list` and summarise what the account can do: number of sites, free website quota, whether `featureSSH` and persistent apps are allowed.

This applies to every enhance tool, not just `doctor`: the plugin always runs the server from `server/dist`, which is a build output and is not committed to the repository.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| `Missing ENHANCE_PANEL_URL` | nothing configured | create the profile file above |
| `panel unreachable` | wrong URL or the panel is down | open the URL in a browser; it must show the Enhance login |
| `credential: … rejected … as a Bearer … and as a session cookie` | token expired, wrong panel, or IP-restricted | create a new access token in the panel; check the token's IP list |
| `no_session_token` (HTTP 401) | no credential reached the panel (configuration problem, not permissions) | check `ENHANCE_TOKEN` or the profile file, then run `auth_status` |
| `unauthorized` on one tool only | the panel returns one code for invalid, expired, IP-restricted, or lacks-the-role; `auth_status` shows roles and expiry | run `auth_status`; if it also fails, create a new access token in the panel |
| `only_mo_allowed` / `Only a reseller or the MO` | platform or reseller operation | not available to a customer account; nothing to fix |
| `credential spans N orgs` | login is a member of several orgs | set `ENHANCE_ORG_ID` from the list in `auth_status` |
| ssh/rsync fail with `Connection reset by peer` from Claude Code but work in a terminal | Claude Code sandbox | run the command with the sandbox disabled, or add `ssh` and `rsync` to `sandbox.excludedCommands` |

## Two tool behaviours to know

The binding part of both is in `references/safety-rules.md` (rules 11 to 13), the one file every
enhance skill loads; this is the longer explanation.

- **`files_list` is the read-only look at a site's files**: a tree under the document root, or any
  folder in the site home, with sizes, modes and modified times. It mints a four-minute site token
  for that one read and never shows it. Safety rule 12 has the SSH fallback for when the file
  service cannot answer.
- **A create that answers "OUTCOME UNKNOWN" is never retried until its settling read shows the
  object absent.** Nine create tools — `website_create`, `domain_add`, `ssh_key_add`, `db_create`,
  `db_user_create`, `pg_db_create`, `pg_user_create`, `cron_add` and `persistent_app_create` —
  confirm an unclear panel answer by reading the object back, and say so ("confirmed by reading it
  back"). Only when that read-back cannot settle it does the answer say OUTCOME UNKNOWN. Then run
  the settling read the answer names first: if it shows the object, the create landed, so carry on
  with it; if it shows it absent, tell the user before creating it again, because it may still land
  late. Retrying a create that did land makes a duplicate or fails with "already exists".

## After connecting

Offer the next step, both halves of it: "Want me to deploy something? I can take a static site, PHP or WordPress project, or a Node app from this folder to one of your sites — or install a ready-made app for you, like Ghost or a CMS, on a domain or subdomain." Deploying what is in the folder is the `enhance-deploy` skill; installing a ready-made app or a fresh scaffold is `enhance-apps`.
