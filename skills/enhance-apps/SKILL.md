---
name: enhance-apps
description: Install a ready-made Node app or CMS on Enhance hosting end to end — website or subdomain, SSL, runtime, database, build, persistent app, first admin, verification, hand-over. Use when the user says "install Ghost", "one-click install", "set up Ghost/Payload/EmDash/TanStack Start on my Enhance hosting", "put a CMS on a subdomain", or names a Node CMS or framework they want live on a domain.
---

# Install an app on Enhance hosting

Read `../enhance-connect/references/safety-rules.md` first; it applies to everything below. If no
enhance tools are available or `auth_status` fails, run the `enhance-connect` skill.

This skill installs a **known** app from a verified recipe: the customer says
"install Ghost on blog.example.com" and you take it from an empty domain to a working login,
without them touching the panel. For deploying the customer's *own* project, use `enhance-deploy`.

## Recipes

| App | What it is | Database | Recipe | Status |
|---|---|---|---|---|
| **Ghost** | publishing platform: blog, newsletter, members, admin at `/ghost/` | MySQL | `references/ghost.md` | verified live 2026-09-17 |
| **Payload** | headless CMS with a Next.js admin, code-first collections | SQLite (Postgres/MySQL adapters untested) | `references/payload.md` | verified live 2026-09-17 |
| **EmDash** | Astro-based CMS, browser editing, finished themes | SQLite (`node:sqlite`) | `references/emdash.md` | verified live 2026-09-17 |
| **TanStack Start** | full-stack React framework (not a CMS): the customer writes the app | none by default | `references/tanstack-start.md` | verified live 2026-09-17 |
| Strapi, Directus, KeystoneJS | headless CMSes that fit this platform on paper | MySQL | `references/candidates.md` | **not yet verified** |

- Read the recipe before you start. It carries the exact commands, the env file, the
  `persistent_app_create` arguments and the traps that cost the trial an hour each.
- An app that is not in the table has **no verified recipe**. Say so plainly, offer the nearest
  verified one, and if the customer still wants it, treat the install as an experiment: follow the
  common flow below, keep notes, and never claim it is supported.
- WordPress and Joomla are not Node apps; the panel has its own installer for them and no MCP tool
  drives it yet.

## 1. First decision: where does the app live?

Ask this **before** anything else, in the customer's words, and wait for an answer. A subdomain on
Enhance means one of two different things:

| | **A. Subdomain inside an existing website** | **B. Subdomain as its own website** |
|---|---|---|
| Tool | `domain_add website=<site> domain=blog.example.com kind=subdomain document_root=blog` | `website_create domain=blog.example.com` |
| Runs in | the main site's container, unix user, PHP version, databases and quota | its own container, unix user, PHP version, databases and quota |
| Website slot | none used | uses one website slot on the subscription |
| Good for | a static page, a PHP app, a landing page that shares the main site's files | anything, and the **only** option for a Node app |
| Node apps | **do not answer there** | yes, registered with `serve_at_root=true` |

Say it to the customer roughly like this: *"A: cheapest — it is a folder on your existing site, shares
its resources, and is fine for static pages or PHP. B: its own little server — separate files, users
and limits, uses one of your website slots, and it is the only way to run a Node app like Ghost."*

- **Verified live 2026-09-17** (mode A probe): `domain_add kind=subdomain document_root=apptest`
  created `<home>/apptest` as a sibling of `public_html` and a static page answered 200 on
  `https://apptest.<domain>/` with a placeholder certificate — but the website's persistent apps
  answered **404** on that hostname. The app proxy binds to the **primary domain only**, so a Node
  app can never be reached through a mode-A subdomain.
- So: **every recipe in this skill needs mode B.** Steer the customer there and give that reason —
  not "it is better", but "your Node app will not answer on the other kind".
- Check the slot first: `subscriptions_list` shows the website quota and its usage. If it is full,
  stop and tell the customer; do not delete anything to make room (safety rule 4).

## 2. The common flow

Every recipe runs these steps in this order. Say which step you are on. Stop and report whenever
the customer has to act outside Claude Code (DNS at their registrar, a setup screen in a browser).

1. **Domain.** `domain_check`. `notInUse` → `website_create domain=<subdomain>` (mode B) or
   `domain_add` (mode A, non-Node only). `inUseCurrentOrg` → `website_get` and reuse that site.
   `inUseAnotherOrg`, `prohibited`, `inUseDeletedSite` → stop and explain.
   - **Create sites one at a time.** Verified live: four `website_create` calls issued in parallel
     returned two client-side timeouts ("operation was aborted due to timeout") although the panel
     had created both sites. On a timeout, **do not retry** — run `domain_check` and report what it
     says (`inUseCurrentOrg` means the site exists).
2. **Capabilities.** `website_get`. Confirm `canUse.persistentApps` for a Node app, and the
   subscription's `featureSSH`. Note `unixUser`, `home`, `serverIp` and the preview domain.
3. **DNS.** `domain_dns_status`, then relay `domain_dns_records` advice verbatim. For a family of
   subdomains, one wildcard `A` record (`*.<domain>` → the site's IP, **DNS only / no CDN proxy**)
   covers them all; otherwise one `A` record per subdomain. Never touch the registrar yourself.
4. **SSL.** Once DNS resolves, `domain_ssl_issue`, then `domain_ssl_get` to confirm a real issuer,
   then offer `domain_set_force_ssl enabled=true`. An admin login must not be handed over on a
   placeholder certificate or over plain HTTP.
5. **SSH.** `ssh_keys_list`; add the key with `ssh_key_add` if it is missing; `ssh_connection_info`
   for the login line. A mode-B subdomain is a **separate container with its own unix user**, so the
   key has to be added per site. `ssh` and `rsync` need the sandbox disabled (safety rule 7).
6. **Node runtime.** `node_versions_installed` is a hint only (it omits the version nvm's `default`
   alias points at); `. ~/.nvm/nvm.sh && nvm ls` over SSH is the truth. No `~/.nvm` → `node_install`
   (allow a minute). Then put the site on the **Node 22 LTS line** unless the recipe says otherwise:
   `node_version_install website=<site> version=22.x.y` then
   `node_version_set_default website=<site> version=22.x.y`. All four trial stacks ran on v22.23.2.
7. **Database**, only when the recipe needs one. Use the `enhance-database` skill: `db_create`,
   `db_user_create` (password shown once), `db_user_set_privileges grants=["all"]`. Keep the **full
   prefixed names**. Read "MySQL from Node" below before writing the config.
8. **Scaffold or fetch the app.** Either scaffold locally and upload (TanStack Start, Payload,
   EmDash) or run the app's own installer on the server (Ghost). Pick a **finished theme or
   template**, never a bare starter — see step 12.
9. **Upload with rsync**, sandbox disabled, dry run first:
   ```sh
   rsync -rltvz --dry-run --exclude .git --exclude node_modules --exclude .env \
     --exclude .next --exclude .output --exclude dist --exclude build \
     --exclude '*.db' --exclude uploads <src>/ <user>@<host>:<app dir>/
   ```
   Use `-rltvz`, never `-a` (it would copy this machine's modes onto the server). The `<app dir>` is
   a **named directory in the home** (`<home>/ghost`, `<home>/payloadapp`), never `public_html` and
   never the home root. Never upload a local `.env` or a local database file.
10. **Install and build on the server**, over SSH in the `<app dir>` with nvm loaded
    (`. ~/.nvm/nvm.sh && cd <app dir> && …`): `npm ci` (frameworks need dev dependencies to build,
    so not `--omit=dev`), then the build. Building in the container is fine on this plan — the trial
    built Next.js, Astro and Nitro on a 3.9 GB box with no memory kill.
11. **Write `.env` on the server** (heredoc over SSH, never rsync one up, never commit it). It holds
    the port, the database credentials and any secret key the scaffolder generated.
12. **Migrations, before the first start.** Recipes that need them say so. An app that starts
    against an empty database can answer 200 and still be broken (Payload did exactly that).
13. **Register the app:**
    ```
    persistent_app_create website=<site> command="npm start" working_directory=<app dir name> \
      serve_at_root=true port=<port>
    ```
    `serve_at_root=true` hands the app the whole domain, which is what a CMS wants: the full request
    path arrives unstripped, generated links and absolute asset URLs just work, and no asset prefix
    is needed. It refuses if the site already serves something at its root — on a site created for
    this app, it does not. Add `node_version=<x.y.z>` when the recipe pins one, and
    `allow_websocket=true` for apps with live updates. Note the `id` it returns.
14. **First admin** — section 4. Never skip it, never postpone it.
15. **Verify** — section 5. All three checks.
16. **Hand over** — section 6.

## 3. Panel facts that bite every Node app

- **The command is argv, not a shell line.** The panel splits it on whitespace and execs it; there
  is no shell, so `NODE_ENV=production node x.js`, pipes, redirection and quoted arguments with
  spaces cannot work (the tool refuses them). Put the environment in the `.env` and load it —
  `node --env-file=.env <entry>` — or hide it in an npm script and register `command="npm start"`.
- **Nothing injects `PORT`.** The app must take the proxy's port from its own config: a `PORT=` line
  in the server-side `.env` read by `--env-file`, a `-p <port>` flag in the start script, or code.
- **An app with no Node version never starts** (`exec: node: not found`). `persistent_app_create`
  always sends one; `default` means nvm's `default` alias, which `node_version_set_default` controls.
- **MySQL from Node is socket-only.** Verified live: inside the container MariaDB answers on the
  unix socket `/run/mysqld/mysqld.sock`; `127.0.0.1` is refused. A Node MySQL client treats
  `host: localhost` as TCP, so it needs `socketPath: '/run/mysqld/mysqld.sock'` and no host (mysql2,
  knex and Ghost all take that). PHP's `localhost` resolves to the socket on its own; Node's does not.
- **The panel's MySQL is MariaDB 11.4** (`canUse.mysqlKind: mariaDbLts`). Apps that document
  "MySQL 8 only" may still run — Ghost 6 did, migrations and seeding included — but that is
  unsupported upstream. Say so before installing one, and again in the hand-over.
- **`persistent_app_create`, `persistent_app_update` and `persistent_app_delete` usually restart the
  whole website container**, not just the app. On a site dedicated to this app that only means a
  second or two of downtime; on a shared site it interrupts PHP and static pages too. To restart on
  purpose, resend a field the app already has: `persistent_app_update … start_mode=automatic`.
- **A root app owns everything.** While an app holds the root, `public_html` is not served at all.
  Do not put a root app on a site that has other content.
- **Apps answer on the primary domain only** — never on the `*.mystaging.site` preview URL, which
  404s the app. Use `persistent_app_probe` (it connects to the app server's IP with the domain as
  SNI) to verify before DNS resolves.
- **Ports:** the panel accepts duplicates without complaint, so check `persistent_apps_list` for a
  free one yourself. On a dedicated site the app's own default (3000, 2368, 4321) is fine.

## 4. The first admin — never leave an installer unclaimed

**Verified live 2026-09-17:** the moment each site answered, its installer was open to anyone on the
internet — Ghost's `/ghost/` owner screen, Payload's `/admin` "Create first user", EmDash's setup
wizard. Whoever reaches it first becomes the owner of the customer's site.

Every install ends with a claimed admin account:

1. **Ask up front**, before the install starts: the admin's **name** and **email address**. Some
   installers take them on the command line; all of them need them at the end.
2. **Generate a strong password** where the app accepts one (24+ random characters — `openssl rand
   -base64 24`). Never reuse a password the customer typed in chat, and never invent one they gave
   you for something else.
3. **Create the account through the app's own API or CLI** when the recipe has a verified one.
4. **Otherwise send the customer to the setup URL immediately** and stay with them until it is done.
   EmDash's first admin is a **browser passkey** — it cannot be automated, a human must be at the
   keyboard. Do not wander off to the next step while the window is open.
5. **Verify the setup screen is closed**: the app's setup status endpoint stops asking for setup, or
   the admin URL now shows a login instead of "create first user". Check, do not assume.
6. **Hand the login over once**, in the chat and nowhere else (section 6).
7. If the customer cannot claim it right now, say plainly that the installer is open to the
   internet until they do, and offer to park the app —
   `persistent_app_update website=<site> app_id=<id> start_mode=manual` stops the process (the URL
   then answers 503) — until they are ready.

**Never write credentials to a file, a commit, an issue or a log** (safety rule 10), and never
repeat the password in a later message.

## 5. Verification — a customer must never be the one to find a broken install

A status code is not verification. **Verified live:** Payload's `/admin` answered **200** while the
database had no tables at all and the browser showed "This page couldn't load"; the error was
rendered client-side and the log said `SQLITE_ERROR: no such table: users`.

Run all three, every time, before saying anything is live:

1. **`persistent_app_probe website=<site> app_id=<id>`** — it fetches the page *and* the images,
   scripts and stylesheets it references. A missing asset (404, 410, 5xx) is a **failed install**:
   fix it and probe again, do not hand over. "Could not be checked in time" means *unchecked*, not
   broken — re-run or open that URL yourself before treating it as a problem. The asset check
   usually adds a few seconds and, on a site whose assets hang, up to about half a minute.
2. **`persistent_app_log website=<site> app_id=<id>`** — read it after the first start and after
   every restart. The log is truncated on each restart, so it only covers the current run. Know each
   recipe's benign noise (Ghost: an ActivityPub webhook self-fetch error at boot; EmDash: an
   `ExperimentalWarning` from `node:sqlite`) and treat everything else as a problem.
3. **Load the real pages**: the home page, the **login/admin page** (not just `/admin` — the one
   behind it, `/admin/login`, `/ghost/`), one deep route, and one thing the app generates (Ghost's
   `/rss/`). `curl -sS -o /dev/null -w '%{http_code}'`, and open the admin page in a browser when
   the customer is present.

Also look at *what* it serves, not only that it serves. An unstyled page is usually the wrong
template, not a broken deploy — the trial shipped EmDash's `starter` and the customer reasonably
read the unstyled result as broken. And do not grep a page for the word "error": EmDash's admin HTML
carries the whole i18n catalogue, "an error occurred" strings included.

**Default to a finished theme.** For a customer-facing install always pick the project's finished
template (EmDash `blog`, marketing, portfolio) over a deliberately bare `starter`. Changing template
later can mean a fresh database and a second setup.

## 6. Hand-over message

One message, at the end, containing:

- the live URL and the admin URL;
- the admin email and the generated password, with "change it on first login, and turn on
  two-factor if the app offers it";
- what is running: app and version, Node version, port, the app directory, the database name;
- what is not configured yet — outgoing mail (Ghost sends nothing useful without real SMTP), DNS
  still propagating, a CDN proxy still off;
- how backups work for this app (section 7);
- that redeploys restart the site for a second or two.

Then stop repeating the password.

## 7. Backups

| Storage | How to back it up |
|---|---|
| **MySQL** (Ghost) | `db_export_sql website=<site> name=<db>` writes a gzipped dump into the site home (mode 0600) and returns an `scp` line; fetch it with the sandbox disabled. Old dumps pile up in the home — offer to remove them. |
| **SQLite file** (Payload, EmDash) | the database is a file in the app directory (`payload.db`, `data.db`). Copy it over SSH **with the app stopped** (`persistent_app_update … start_mode=manual`, then back to `automatic`) so the copy cannot catch a half-written transaction. |
| **Uploaded media** | lives outside the database: Ghost `<home>/ghost/content`, EmDash `<app dir>/uploads`, Payload's configured media directory. A database dump alone is not a backup. |
| **The app itself** | the customer's source repo, or a fresh scaffold plus the recipe. Do not back up `node_modules` or the build output. |

The panel takes its own automatic backups of the site; tools for listing and restoring them arrive
in a later milestone, so for now a restore is a panel-UI action.

## 8. Removing an app

`persistent_app_delete` is destructive and prompts the customer to type the website's domain — never
type it yourself (safety rules 1 and 9). It stops the process and removes the proxy; the app's
files, its database and its `persistent_app_<id>.log` stay in the home directory and have to be
removed over SSH. Deleting the **website** is a different, larger action and belongs to
`enhance-deploy`'s rules, not this skill.
