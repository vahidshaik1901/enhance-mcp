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

1. Run the plugin's built server first: `node <plugin dir>/server/dist/index.js doctor`, where `<plugin dir>` is the repo checkout you ran `claude plugin add` on (or, for a marketplace install after publish, `~/.claude/plugins/…`). From the checkout itself that is `node server/dist/index.js doctor`, run in the repo root. If `server/dist` or `server/node_modules` is missing, build once first: `cd server && npm ci && npm run build` — the plugin needs both, since the build bundles the plugin's own code but not its runtime dependencies. Confirm no line starts with `FAIL`, and the last line reads `doctor: all good`.
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

## After connecting

Offer the next step: "Want me to deploy something? I can take a static site, PHP or WordPress project, or a Node app from this folder to one of your sites." Then use the `enhance-deploy` skill.
