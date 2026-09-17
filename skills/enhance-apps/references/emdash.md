# EmDash CMS on Enhance

**Status: verified live 2026-09-17** — EmDash 0.38 on Astro 7.3 with `@astrojs/node` in standalone
mode (Live test C3 in `docs/research.md`).

## What it is, and when to pick it

An Astro-based CMS: a content site with a browser admin, SQLite storage through Node's built-in
`node:sqlite`, and local file uploads. It ships finished themes. Pick it for a content site the
customer edits in a browser and wants to look good immediately; pick Ghost for a
newsletter/membership publication, Payload when the content model is written in code.

## Requirements

- Mode B: a website of its own (`website_create`), app registered with `serve_at_root=true`.
- **Node ≥ 22.16** — it uses `node:sqlite`. The trial ran v22.23.2 through nvm's `default` alias;
  pin it on the app with `node_version=` if the site's default may move below 22.16.
- No database to provision: SQLite in a file inside the app directory.
- `canUse.persistentApps`, `featureSSH`.

## Scaffold (locally) — pick a finished template

Use EmDash's own create command (check its docs for the current name) with:

```
--template blog --platform node
```

- Templates: **`blog`**, `starter`, `marketing`, `portfolio`. Platforms: `node`, `cloudflare` — on
  Enhance it is always `node`.
- **Never `starter` for a customer install.** It is intentionally unstyled ("minimal styling … a
  base you can build on", per its own README). The trial deployed it and the customer read the
  unstyled page as a broken install — correctly, from their side. `blog` ships a real theme
  (~27 KB of CSS with theme tokens).
- The scaffolder generates an **`EMDASH_ENCRYPTION_KEY`**. Keep it: it encrypts stored secrets, so
  the same value has to travel to the server and stay the same across redeploys.

Add or confirm the start script:

```json
"scripts": { "start": "node --env-file=.env ./dist/server/entry.mjs" }
```

## Upload and build

```sh
# local, sandbox disabled
rsync -rltvz --exclude .git --exclude node_modules --exclude .env --exclude dist \
  --exclude '*.db' --exclude uploads <src>/ <user>@<host>:emdashapp/

# on the server
ssh <user>@<host> '. ~/.nvm/nvm.sh && cd emdashapp && npm ci && npm run build'
```

Trial timings: `npm ci` 12–14 s, `astro build` about 10 s. The build writes
`dist/server/entry.mjs`.

## Env file (`<app dir>/.env`, written on the server)

```
HOST=0.0.0.0
PORT=4321
EMDASH_ENCRYPTION_KEY=<the key the scaffolder generated>
```

`HOST=0.0.0.0` is required for the panel's proxy to reach the standalone Astro server. The command
cannot carry any of these (argv, no shell, no injected `PORT`), which is why the start script uses
`--env-file`.

## Register the app

```
persistent_app_create website=<site> command="npm start" working_directory=emdashapp \
  serve_at_root=true port=4321
```

## Migrations

None to run. The database **auto-migrates and auto-seeds on the first request**, so make that first
request yourself — `persistent_app_probe` does it — before looking at the setup status or telling
the customer anything.

## First admin — a passkey, so a human must do it

While unclaimed, `GET https://<domain>/_emdash/api/setup/status` answers `{"needsSetup":true}` and
the setup wizard is open to anyone who finds the site.

**The first admin is created with a browser passkey. It cannot be automated.** So:

1. Have the customer ready before you register the app.
2. Send them to the site's setup URL the moment it answers, with the admin name and email.
3. Stay with them until the passkey is created — do not move on to cleanup or hand-over.
4. Confirm: `GET /_emdash/api/setup/status` no longer reports `needsSetup: true`.

If they cannot do it now, say plainly that the setup wizard is open to the internet until they do,
and offer to park the app (`persistent_app_update … start_mode=manual`) until they are ready.

## Verification

- `persistent_app_probe website=<site> app_id=<id>` → 200 with its assets answering. The `blog`
  template's page pulls a real stylesheet; if the page renders unstyled, you shipped `starter`.
- `curl https://<domain>/_emdash/api/setup/status` → the setup state.
- `persistent_app_log` → **benign noise:** an `ExperimentalWarning` from `node:sqlite` on every
  start. Anything else is a problem.
- Do **not** grep the admin HTML for "error": it carries the whole i18n catalogue, "an error
  occurred" strings included, and they mean nothing.

## Changing the template later

A different template means a **fresh database**: the trial scaffolded `blog` into a second directory
and pointed the app at it with `persistent_app_update website=<site> app_id=<id>
working_directory=emdashblog` (which restarted it). The site came up styled, with the setup wizard
open again — the earlier setup did not carry over. So **decide the template before the customer
claims the site**, and if you must switch afterwards, warn them that the admin account and any
content are being left behind in the old directory.

## What to back up

- the SQLite file (`<app dir>/data.db`) — copy it over SSH **with the app stopped**
  (`persistent_app_update … start_mode=manual`, then `automatic`);
- `<app dir>/uploads/` — the media, which is not in the database;
- the source repository plus the `EMDASH_ENCRYPTION_KEY` (in the customer's password manager, never
  in a file in the repo).

## Traps, all seen live

| Trap | What you see | Fix |
|---|---|---|
| `starter` template | a correct deploy that looks broken: an unstyled page | scaffold `--template blog` (or another finished theme) for any customer install |
| Node below 22.16 | the app fails to start on `node:sqlite` | install and default the Node 22 LTS line; pin `node_version` on the app |
| Missing `HOST=0.0.0.0` | the proxy gets nothing; 502/503 on the domain | `HOST` and `PORT` in `.env`, loaded by `--env-file` in the start script |
| Passkey setup skipped "for later" | the setup wizard stays open to the internet | claim it immediately, or park the app with `start_mode=manual` |
| "error occurred" in the admin HTML | looks like a failure | it is the i18n catalogue; check the log instead |
| Template swap | setup wizard open again, content gone | fresh database per app directory; decide the template up front |
