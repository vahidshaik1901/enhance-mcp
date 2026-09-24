# Ghost on Enhance

**Status: verified live 2026-09-17** — Ghost 6.64.0 installed with ghost-cli, running on the
panel's MariaDB (Live test C3 in `docs/research.md`).

## What it is, and when to pick it

A publishing platform: posts, pages, a members/newsletter system and a polished admin at `/ghost/`.
Pick it for a blog, a publication or a newsletter the customer writes in. Pick Payload instead when
they want to model their own content types in code, and EmDash when they want an Astro site with
browser editing.

## Requirements

- Mode B: a website of its own (`website_create`), app registered with `serve_at_root=true`.
- Node 22 LTS (trial: v22.23.2 via nvm's `default` alias — `node_install` →
  `node_version_install 22.23.2` → `node_version_set_default 22.23.2`) — or today's newest release of the 22 LTS line from `node_versions_available`.
- A **MySQL database and user** on that site — create them with the `enhance-database` skill and
  keep the full `<unixUser>_` prefixed names.
- **Tell the customer this before installing:** Ghost officially supports **MySQL 8 only**, and the
  panel's MySQL is **MariaDB 11.4** (`canUse.mysqlKind: mariaDbLts`). Ghost 6.64.0 ran on it in the
  trial — it booted in 4.9 s and ran its migrations and seed without complaint — but it is an
  unsupported combination upstream, so a future Ghost release could break it.

## Install (on the server, not locally — skill steps 8 and 10 in one)

ghost-cli downloads Ghost itself; there is nothing to scaffold, nothing to rsync and **no build
step**, so the config and `.env` below are written between this install and the first start, which is
where the canonical order puts them (step 9 is "config before anything runs", and nothing runs until
step 13). The database (step 7) must already exist, because its credentials go into the config.
**Verified live 2026-09-17** — this exact command, run over SSH with nvm loaded:

```sh
ssh <user>@<host> '. ~/.nvm/nvm.sh && npx --yes ghost-cli@latest install \
  --no-prompt --no-stack --no-setup --no-setup-linux-user --dir $HOME/ghost'
```

`npx --yes ghost-cli@latest` avoids a global install; `--dir $HOME/ghost` creates and uses the app
directory, so no `mkdir`/`cd` is needed. About **40 s** in the trial (ghost-cli installs Ghost
**6.64.0** with pnpm via corepack under the hood). It lays out `<home>/ghost/versions/<version>`
with a `current` symlink.

Every flag is load-bearing:

- `--no-setup-linux-user` — **the trap**. The trial's first attempt, without it, failed **both**
  ghost-cli doctor checks on the mode-`711` site home: the node-version check and the folder
  permission check ("not readable by other users"). The fix is this flag, **never** a `chmod` on
  the site home: the panel owns those modes and loosening them exposes the container's files.
- `--no-stack` — no nginx/systemd stack checks; the panel is the web server and the process manager.
- `--no-setup` / `--no-prompt` — no interactive wizard; the config below is written by hand.

## Configuration (`<home>/ghost/config.production.json`) — skill step 9, before anything runs

```json
{
  "url": "https://<domain>",
  "server": { "host": "0.0.0.0", "port": 2368 },
  "database": {
    "client": "mysql",
    "connection": {
      "socketPath": "/run/mysqld/mysqld.sock",
      "user": "<full db user>",
      "password": "<password from db_user_create>",
      "database": "<full db name>"
    }
  },
  "mail": { "transport": "Direct" },
  "process": "local",
  "paths": { "contentPath": "/var/www/<website_id>/ghost/content" }
}
```

- **`socketPath`, never `host`/`port`** — verified live: MariaDB answers on
  `/run/mysqld/mysqld.sock` inside the container and `127.0.0.1` is refused. A Node MySQL client
  treats `localhost` as TCP, so the socket path has to be explicit.
- `server.host: "0.0.0.0"` so the panel's proxy can reach it; port 2368 is Ghost's own default and
  what the trial registered.
- `process: "local"` — Ghost's systemd mode does not exist in the container.
- `contentPath` is absolute (`<home>/ghost/content`) and is where images, themes and member data
  live.
- Write the file over SSH with a heredoc and `chmod 600` it. The database password belongs in this
  config and nowhere else — not in another file, not in a commit, not in a later message
  (safety rule 10).

## Env file (`<home>/ghost/.env`) — skill step 9 as well

```
NODE_ENV=production
```

Ghost reads `config.production.json` only when `NODE_ENV=production`, and the panel's command is
argv with no shell — `NODE_ENV=production node …` is refused and would not work anyway. So the
variable goes in the env file and the command loads it.

## Register the app

```
persistent_app_create website=<site> command="node --env-file=.env current/index.js" \
  working_directory=ghost serve_at_root=true port=2368
```

`current/index.js` is the symlink ghost-cli maintains, so the command survives a `ghost update`.

## Migrations (skill step 11)

None to run by hand: Ghost migrates and seeds its own database on first boot (4.9 s in the trial).
Read `persistent_app_log` once and confirm it finished before opening the admin.

## Verification (skill step 14) — before the customer is told anything

- `persistent_app_probe website=<site> app_id=<id>` → 200 with the page's assets answering
  (7 assets, all OK in the trial).
- `persistent_app_log` → migrations finished, `Ghost is running`. **Benign noise:** an ActivityPub
  webhook self-fetch error at boot, logged while the site was not yet being served. Anything else is
  a problem.
- `curl` each of `/`, `/ghost/` and `/rss/` — all 200 in the trial.
- `files_list website=<site> path=ghost` → `current` (a symlink), `versions/<version>`,
  `content/`, `config.production.json` with mode `600`, and `.env`. `node_modules` is not at this
  level: it lives under `versions/<version>/`, below the default depth, so its absence here is
  normal. The `.env` holds only `NODE_ENV` and is not a secret, so its mode is not a check.

## First admin (skill step 15) — only once the checks above passed

`https://<domain>/ghost/` is an **open owner-creation screen** until someone claims it. Claim it
immediately (skill section 5).

- **The documented path, verified live:** send the customer to `https://<domain>/ghost/` — the URL
  you have just loaded yourself — with the name, email and generated password, and stay with them
  until the account exists.
- **Option, not exercised in the trial:** Ghost's own setup endpoint
  (`POST /ghost/api/admin/authentication/setup/` with the name, email, password and blog title).
  Confirm the request shape against Ghost's current Admin API documentation before relying on it, and
  whatever the response says, verify with the check below rather than assuming it worked.
- Confirm afterwards (skill step 16): `https://<domain>/ghost/` shows a **sign-in** form, not
  "create your account".

Then hand over URL, email and password once, and tell them to enable 2FA in Ghost's settings.

## Outgoing mail

The `Direct` transport does not deliver reliably, so member signups, invites and password resets go
nowhere. Ask the customer for SMTP credentials (any provider) and put them in the `mail` block of
`config.production.json`, then restart with `persistent_app_update … start_mode=automatic`. Until
then, say plainly in the hand-over that the site works but sends no email.

Those SMTP credentials get **exactly the same handling as the database password** (safety rule 10):
straight into `config.production.json` on the server, `chmod 600`, and nowhere else — not echoed
back in chat, not into another file, a commit or a log, and not repeated in a later message.

## What to back up

- the **MySQL database**: `db_export_sql website=<site> name=<db>`, then fetch the dump with the
  `scp` line it returns;
- **`<home>/ghost/content`** — images, themes, member data, routes;
- not `versions/`, not `node_modules`: ghost-cli re-downloads those.

## Upgrades

`ghost update` in `<home>/ghost` with nvm loaded, then restart with
`persistent_app_update website=<site> app_id=<id> start_mode=automatic`. Take the database dump and
a copy of `content/` first. **Not verified in the trial.**

## Traps, all seen live

| Trap | What you see | Fix |
|---|---|---|
| ghost-cli's doctor checks | install refuses on the mode-711 home: node-version check **and** "is not readable by other users" | `--no-setup-linux-user`; never chmod the site home |
| TCP database connection | Ghost cannot connect; MySQL refuses `127.0.0.1` | `socketPath: "/run/mysqld/mysqld.sock"`, no `host`/`port` |
| `NODE_ENV` in front of the command | `persistent_app_create` refuses the command | `NODE_ENV=production` in `.env` + `node --env-file=.env current/index.js` |
| MariaDB, not MySQL 8 | nothing at install time; an unsupported combination | works today (verified); say so in the hand-over |
| ActivityPub error at boot | a self-fetch failure in the log | benign, the site was not being served yet |
