---
name: enhance-deploy
description: Deploy a local project to an Enhance-hosted website from fresh hosting to a verified URL. Use when the user says deploy, publish, "put this live on <domain>", "push to my site", or asks to set up a new site on their Enhance hosting. Covers domain check, site creation, DNS instructions, SSL, SSH preparation, rsync deploy and verification.
---

# Deploy to an Enhance website

Read `../enhance-connect/references/safety-rules.md` first. If no enhance tools are available or `auth_status` fails, run the `enhance-connect` skill.

## Deploy modes offered to the customer

| Mode | How it works | Status |
|---|---|---|
| **A. Direct** | Claude Code runs rsync over SSH from this machine to the site | available now (this skill) |
| **B. GitHub auto-deploy** | push to GitHub; a workflow rsyncs to the site on every push, using a deploy key only | coming in a later milestone |
| **C. Git push to server** | `git push enhance main` into a bare repo in the container | coming in a later milestone |

Explain the three in one short paragraph when the user first deploys, then proceed with A.

## The flow (mode A)

Work through the steps in order. Say which step you are on. Stop and report whenever a step needs the customer to act outside Claude Code (DNS at their registrar, a token in the panel).

### 1. Domain and site
- Ask for the domain if not given. Call `domain_check`.
- `inUseCurrentOrg` → use that site (`website_get`).
- `notInUse` → offer `website_create`. It picks the subscription when only one has free quota; otherwise show `subscriptions_list` and ask.
- `inUseAnotherOrg`, `prohibited`, `inUseDeletedSite` → stop and explain; nothing can be deployed under that domain here.

### 2. Site facts
- `website_get`. Note `phpVersion`, `documentRoot`, `home`, `serverIp`, `canUse` and the preview domain.
- If the project is Node and `canUse.persistentApps` is false, or the plan lacks `featureSSH`, stop and tell the user what their plan does not allow.

### 3. Preview URL
- `website_preview_domain`. Keep the URL; every verification below uses it. If it reports `available: false`, use the `curl --resolve` command it returns instead.

### 4. DNS (parallel to the deploy, never a blocker)
- `domain_dns_status`. Relay its advice verbatim to the user:
  - `Resolved` → nothing to do.
  - provider `platform` → wait for propagation.
  - provider `cloudflare` → offer (a) the integration: user adds a Cloudflare API token in the panel, then you call `domain_cloudflare_connect` with the key id from `cloudflare_keys_list`; or (b) manual: `domain_dns_records` and the user adds them at Cloudflare with the proxy OFF ("DNS only", grey cloud) on the A and CNAME records until SSL is issued (step 5).
  - provider `other` or `unknown` / status `Failed` → give the platform nameservers from `platform_info` or the A record; `domain_dns_records` for the full list.
  - status `ForeignServer` → the domain currently points somewhere else (often a CDN or an old host); continue on the preview domain and give the customer the instructions for their provider; do not tell them the site is live.
  - Mail: `domain_dns_records` adds MX, SPF, DMARC and the mail hosts only when the domain has email accounts on the platform. Never tell a customer to add the platform's mail records for a domain whose mail lives elsewhere (Google Workspace, Microsoft 365, and so on); that breaks their email. `include_mail=yes` forces them when the customer says mail should move here.
  - status `Mixed` → the website's domains resolve differently; run `domain_dns_status` per domain and treat each on its own.
- Never change the registrar or a third-party DNS host yourself.

### 5. SSL
- `domain_ssl_get`. If `placeholder` is true and DNS already resolves (`Resolved`), call `domain_ssl_issue`. If DNS does not resolve yet, say SSL will be issued after DNS and continue; the preview domain already has HTTPS.
- Cloudflare: the panel's Let's Encrypt issuance fails while Cloudflare proxies the A record. Sequence: records on DNS only, `domain_dns_status` reports `Resolved`, `domain_ssl_issue`, `domain_ssl_get` shows a real issuer, then tell the customer to turn the proxy on and set Cloudflare SSL/TLS to Full (strict). Never Flexible: it redirect-loops once force-https is on.
- After a real certificate exists, offer `domain_set_force_ssl enabled=true`.

### 6. SSH
- `ssh_keys_list`. If the user's public key is not listed, read `~/.ssh/id_ed25519.pub` (or ask which key) and call `ssh_key_add`. Never read or send a private key.
- `ssh_connection_info` gives the login command, home, document root and an rsync example.

### 7. Build locally
Detect the project type and build here, never on the server for PHP:
- **Static** (index.html at the root or a `dist/`/`build/` output): nothing to build, or run the project's build script.
- **PHP**: never upload `vendor/` when `composer.json` is present. Composer exists in the container and runs there in step 9; a locally built `vendor/` carries this machine's platform and absolute paths. Exclude it from the rsync.
- **Laravel**: use the two-directory layout below. There is **no MCP tool that repoints an existing domain's document root** — that is a panel-UI action today (a future milestone may add one) — so the served directory stays `<home>/public_html` and the app lives beside it.
- **Database**: create the database and user first with the `enhance-database` skill, then write the app config with `DB_HOST=localhost` and the full `<unixUser>_` prefixed names. `localhost` is the PHP answer only — it is the unix socket there; a **Node** MySQL client reads it as TCP and is refused, so a Node app needs `socketPath: '/run/mysqld/mysqld.sock'` and no host (verified live, see `enhance-apps`).
- **WordPress theme or plugin**: deploy into `public_html/wp-content/themes/<name>` or `plugins/<name>`, never the docroot root.
- **Node**: use the Node layout below. The app runs as a panel-managed **persistent app** behind the reverse proxy; there is no document root involved. Verification differs from static and PHP: a persistent app answers on the **primary domain only**, never on the `*.mystaging.site` preview URL (verified live), so use `persistent_app_probe` until DNS resolves.

#### Laravel layout (the supported path)

`<home>` is `/var/www/<website_id>` — where the SSH login lands. The served document root is
`<home>/public_html` (mode 750, group `www-data`); you may create sibling directories in `<home>`.

1. **Deploy the application to `<home>/app`**, never into the docroot, so `.env`, `vendor/` and
   `storage/` are never web-served. rsync target `app/`, excluding `vendor`, `node_modules` and
   `.env`. Build front-end assets locally (`npm run build`) and upload the built output.
2. **Make `public_html` serve Laravel's `public/`**: rsync `app/public/` into `public_html/`, then
   edit `public_html/index.php` so its two requires point one level up into the app directory:
   ```php
   require __DIR__.'/../app/vendor/autoload.php';
   $app = require_once __DIR__.'/../app/bootstrap/app.php';
   ```
   Any other `__DIR__.'/../…'` path in that file (Laravel's maintenance-mode check, for example)
   needs the same `/app` prefix; Laravel 13 has three such lines and
   `sed -i "s#__DIR__\.'/\.\./#__DIR__.'/../app/#g" public_html/index.php` over SSH covers them
   (verified live 2026-09-16). Re-apply the edit whenever step 2's rsync overwrites `index.php`.

Everything below calls `<home>/app` the **`<app dir>`**.

#### Node layout (persistent apps)

**Installing a known CMS or framework rather than the customer's own project?** Use the
`enhance-apps` skill instead: it has verified end-to-end recipes (Ghost, Payload, EmDash, TanStack
Start) with the exact commands, the first-admin step and the verification each one needs. Come back
here for a project the customer wrote.

Stop here unless `website_get` shows `canUse.persistentApps: true`: without it the plan does not
run Node processes (safety rule 4). `persistent_app_create`, `persistent_app_update` and
`persistent_app_delete` usually restart the whole website container, not just the app, so expect
the site's PHP and static pages to be interrupted for a second or two each time (verified live for
create, delete, and updates that change the start mode, the command or clear the proxy; one update
that only added a proxy to an app that had none was seen to apply without a restart).

**Ask first: is this an API or single-page app, or a whole multi-page site?** An API or a
single-page app is happy under a path on a site that also serves PHP or static files. A Node app
that *is* the site — any multi-page framework build — belongs on its own website or subdomain with
`serve_at_root=true`, and that is a decision to take **before** deploying, not after the customer
reports broken links. Read "PHP or static site plus a Node app" below before choosing.

1. **Runtime.** `node_versions_installed` shows what the panel believes is installed — it is a hint
   only; `. ~/.nvm/nvm.sh && nvm ls` over SSH is the truth, and the panel's list omits exactly the
   version nvm's `default` alias points at (verified live). If there is no `~/.nvm`, run
   `node_install` (nvm plus the current stable Node; allow a minute). For the version the project
   wants — the project's `.nvmrc` or `engines.node`, else the newest even-numbered major from
   `node_versions_available` that is **already in LTS** (even majors are the LTS lines, but the
   newest one is still Current for months after its release and the tool returns bare versions with
   no LTS marker; when unsure, take one even major behind the newest):
   `node_version_install website=<site> version=<x.y.z>` then
   `node_version_set_default website=<site> version=<x.y.z>`. Pin
   `node_version` on the app when the project needs a specific version; otherwise the app runs on
   nvm's `default` alias, which `node_version_set_default` controls. An app registered with no Node
   version at all never starts (`exec: node: not found`, verified live), so the create tool always
   sends one.
2. **Directory.** The app lives in a named directory in the home, `<home>/<app>` (for example
   `/var/www/<website_id>/nodeapp`), never in `public_html` and never the home root. That
   directory name, relative to the home, is the `working_directory` the panel needs — relative,
   never absolute, and never an empty string: the panel accepts an empty one and the app then never
   starts (verified live), so the tool rejects it. Omit the argument only when the app is meant to
   run from the home directory itself.
3. **Port.** Pick the port the app will listen on — the app's own default when it has one (Ghost
   2368, EmDash/Astro 4321 in the C3 trial), otherwise anything in 3000–3999 — and check
   `persistent_apps_list` does not already show it: the panel accepts a duplicate port without
   complaint (verified live), so that check is yours. **The command is not a shell line.** The
   panel splits it on whitespace and execs it as argv, and it injects no `PORT`, so an environment
   assignment in front of the command cannot work — the create tool refuses those, along with
   pipes and redirection. Never quote anything inside the command string: quotes reach the program
   as literal characters (the tool only refuses a quoted segment that contains whitespace, but
   `node "server.js"` would still fail to exec). The app has to choose the proxy's port itself:
   - put it in the npm start script — `"start": "node --env-file=.env server.js"` with a `PORT=3000`
     line in the server-side `.env` (Node 20.6+), or `"start": "next start -p 3000"` — and use
     `npm start` as the command;
   - or use `node --env-file=.env server.js` as the command directly;
   - or hard-code the port in the app.
4. **Proxy path.** The URL path the web server forwards to the app: `node`, `api`, `app/v2`. No
   leading slash (the panel rejects it; the tool strips one and says so). A path another app
   already uses is refused (409), but a path that a real directory under `public_html` serves is
   accepted by the panel — and **the proxy wins even while the app is stopped**: verified live, an
   app merely registered on `demo-login` turned that PHP page into a 503 until the app was deleted.
   Pick a path that returns 404 on the live site today; `persistent_app_create` fetches both
   `/<path>` and `/<path>/` first and refuses unless both answer 404 (an existing directory shows
   only on the bare form, as a 301). "PHP or static site plus a Node app" below has both directions of that
   check and the layout choice. For an app that is the whole site, use `serve_at_root=true` on a
   website or subdomain of its own instead of a path.
   **The proxy strips the prefix before it forwards** (verified live 2026-09-17): a request to
   `https://<domain>/<path>/foo/bar?x=1` reached the app as `/foo/bar?x=1`, and `/<path>/` as `/`
   (`/<path>` without the trailing slash answers too; the `Host` header stays the domain and
   `x-forwarded-for` carries the client IP). So the app serves its routes at `/` — an Express app
   needs no `app.use('/<path>', …)` and no mount prefix — while the *asset URLs in its HTML* still
   have to carry the prefix, because the browser asks for them at the public path. Next.js: set
   `assetPrefix: '/<path>'` in `next.config.*` **before the build**, and no `basePath`; a build
   with `basePath` serves only `/<path>/…` and answers its own 404 page to the `/` the proxy hands
   it (verified live, then fixed by rebuilding with `assetPrefix` alone). Links the app generates
   itself (`<Link href="/about">`) are not prefixed by `assetPrefix`, so a multi-page framework app
   needs prefix-aware links or a domain or subdomain of its own rather than a path. Verify with
   `persistent_app_probe` — a 404 carrying the app's own error page means it was built for the
   wrong path, not that it is down — and by loading one of the page's asset URLs
   (`https://<domain>/<path>/_next/static/…`) in the browser.

Everything below calls `<home>/<app>` the **`<app dir>`** for Node too.

### 8. Deploy with rsync
- Always dry-run first and show the summary:
  `rsync -rltvz --dry-run --exclude .git --exclude node_modules --exclude .env <src>/ <user>@<host>:<docroot>/`
- Use `-rltvz`, not `-a`. With a trailing-slash source, `-a` copies the local folder's owner, group and mode onto the document root, which the panel keeps at `750` with the web server's group (verified live 2026-09-05).
- Add `-e "ssh -i <key>"` when the authorized key is not the user's default one.
- Then run it for real. Use `--delete` only if the user explicitly asked to remove files not in the source.
- Target is the document root, a directory under it, or a named directory in the home (`app/` for the Laravel layout in step 7 — that one runs twice, once into `app/` and once into `public_html/`). Never the home directory root itself. For Node, the target is the `<app dir>` from the Node layout, excluding `.git`, `node_modules`, `.env` and the build output (`.next`, `dist`, `build`): `rsync -rltvz --exclude .git --exclude node_modules --exclude .env --exclude .next --exclude dist --exclude build <src>/ <user>@<host>:<app>/`.
- **Sandbox**: this command needs the sandbox disabled (or `ssh`/`rsync` in `sandbox.excludedCommands`). Say so before running.

### 9. Post-deploy (over the same SSH)
`<app dir>` is where the application code lives: the document root for a plain PHP app, and
`<home>/app` (`/var/www/<website_id>/app`) for the Laravel layout in step 7.
- PHP with Composer: `ssh <user>@<host> 'cd <app dir> && composer install --no-dev --optimize-autoloader'`.
- **Laravel**, in this order:
  1. `composer install --no-dev --optimize-autoloader` over SSH, in the `<app dir>`. Every `php artisan` command below runs there too.
  2. Write `.env` on the server from the database tool output: `DB_HOST=localhost` (never `127.0.0.1`), the full `<unixUser>_` prefixed database and user names, and the password `db_user_create` showed once, plus `APP_ENV=production`, `APP_DEBUG=false` and an `APP_KEY` (`php artisan key:generate` when there is none). Never rsync a local `.env` up, never commit it, and do not repeat the password afterwards.
  3. `php artisan migrate --force` **only when the user explicitly confirms it** — it changes the schema and can drop columns. Take `db_export_sql` first.
  4. `php artisan config:cache` (and `route:cache` / `view:cache` if the app uses them). Re-run it after any later `.env` change, or the cached config keeps winning.
- **Node**, in this order, all over SSH in the `<app dir>` with nvm loaded (`. ~/.nvm/nvm.sh &&`). Registering or changing the app usually restarts the whole website container, so deploy at a quiet moment:
  1. Write `.env` on the server (never rsync a local one). Put the `PORT=<port>` line in it when the app reads its port from the file — `node --env-file=.env server.js`, or an npm `start` script that does — because the command itself cannot carry it. It goes first because **builds read it**: a framework config that reads a secret or a database URL at import time (Payload) is imported by `next build`, so a `.env` written afterwards produces a build made against the wrong values.
  2. `npm ci --omit=dev` when a lockfile exists, else `npm install --omit=dev`. Frameworks that build with dev dependencies (Next.js, Vite) need `npm ci` without `--omit=dev`, then the build, then optionally `npm prune --omit=dev`.
  3. **Migrations, when the project has them, before the build.** An app that starts against an empty database can answer HTTP 200 and still be wholly broken: Payload's `/admin` returned 200 while the page said "This page couldn't load" and the log said `no such table: users` (verified live 2026-09-17). Generate migrations locally and upload them when you can, else create them on the server after the install; run them, then build. The `enhance-apps` skill has the exact commands per stack and marks the recipes that need no migration step.
  4. `npm run build` when `package.json` has a build script. If the build is killed for memory, build locally instead and rsync the output directory up (Next.js: set `output: 'standalone'`), and say so. For that upload drop the build-output excludes from step 8 — rsync `.next/` (with `output: 'standalone'`, also `.next/standalone/` and `.next/static/`) and `public/` explicitly.
     To run a standalone build, copy `.next/static` to `.next/standalone/.next/static` and `public` to `.next/standalone/public` (Next.js does not), then register `command="node server.js"` with `working_directory=<app>/.next/standalone`. The generated `server.js` reads `PORT` (and `HOSTNAME`), so pass it with `--env-file` (`command="node --env-file=.env server.js"` and a `PORT=<port>` line in a `.env` placed **inside `.next/standalone`**, next to the generated `server.js`: `--env-file` resolves against the working directory, not the `<app dir>`) or by setting `hostname`/`port` in the generated `server.js`. Not yet verified live.
  5. Register the app: `persistent_app_create website=<site> command="npm start" working_directory=<app> proxy_path=<path> port=<port>`. `command` is argv, not a shell line, so the port lives in the app's own config and never in front of the command. Add `allow_websocket=true` for Socket.IO and similar, and `node_version=<x.y.z>` when the project pins one (otherwise the app runs on nvm's `default` alias). Note the `id` it returns.
  6. `persistent_app_log website=<site> app_id=<id>` until it shows the listening line. A crash shows here first; fix it before touching the proxy, then verify with `persistent_app_probe` (step 10).
  7. For a later deploy: rsync again, rebuild, then restart. An update usually restarts the app and the whole website container, so expect the site's PHP and static pages to be interrupted for a second or two — resending a field the app already has is therefore the deliberate restart, e.g. `persistent_app_update website=<site> app_id=<id> start_mode=automatic` (verified live: it restarted the app and picked up a fresh build); an update carrying no field at all is refused ("nothing to change") and never reaches the panel. The same tool changes the command, port, path or Node version.
- WordPress: `wp cache flush` if WP-CLI reports a site.
- Then both caches (PHP and static deploys only — a Node app has no OPcache or FastCGI cache, and `website_restart_php` is another interruption), which are different things: `website_restart_php` for PHP OPcache, which otherwise keeps serving the previous code, and `cache_clear` for the domain's FastCGI (page) cache.

### 10. Verify
- Request a file you just deployed, not just `/`: an empty docroot returns 404 on every hostname.
  `curl -sS -o /dev/null -w '%{http_code}' https://<preview-domain>/index.html` (or `curl -k --resolve …` when there is no preview domain).
- **Node**: run `persistent_app_probe website=<site> app_id=<id>` after **every** Node deploy, before telling the customer anything is live — it connects to the app server's IP with the domain as SNI, so it works before DNS. `HTTP 200` with the app's body means the proxy and the process are up; `502`/`503` means the web server is fine and the app is not listening on its port (read `persistent_app_log`, and confirm the app really binds the proxy's port — nothing injects `PORT` into it); `404` means either the app's own error page — the process is up but was built for `/<path>/` instead of `/`, because the proxy strips the prefix (Node layout, step 4) — or, when no app owns that path, the site's docroot answering, and the probe now says which.
- **Failed assets are a failed deploy.** The probe also fetches the images, scripts and stylesheets an HTML page references and fails when one is definitely missing (`404`, `410` or `5xx`): a page can be `200` with every image broken, because a reference like `/logo.svg` is asked for at the domain root, outside the app's path. Do not report the deploy as done. Either write those references with the prefix (`/<path>/logo.svg`) and redeploy, or move the app to its own website or subdomain with `serve_at_root=true`; then probe again and only then tell the customer it is live.
- **"Could not be checked in time" is not a failure.** Assets whose fetch timed out come back as *unchecked* and never fail the probe — a slow link says nothing about the file (the first version of this check called two healthy Next.js chunks broken from a distant client). An asset answering 401 or 403 is *restricted*: it is served, just not to an anonymous probe, and it is reported and never fails the deploy either. Re-run the probe, or open that URL yourself, before treating one of these as a problem. The check covers the first 12 references on the page and says so when the page names more; `check_assets=false` skips it entirely, for a page whose assets are behind auth or on another host.
- Once DNS resolves, `curl https://<primary domain>/<path>/`. The preview URL returns 404 for the app path; that is expected, not a failure.
- `curl: (6) Could not resolve host` on a preview domain created minutes ago is DNS propagation, not a failed deploy (about five minutes live). Verify the vhost meanwhile with `curl -k --resolve <preview-domain>:443:<app-server-ip> https://<preview-domain>/index.html`, then retry the plain URL.
- Report: preview URL, primary URL and its DNS status, SSL state, what was uploaded (from the rsync summary), and what the user still has to do (DNS at the registrar, if anything).

## PHP settings and cron

Only once the deploy works; none of this is part of the happy path.

- **Extensions**: `php_extensions_list` shows enabled, available to enable, and built in (mysqli, pdo_mysql, redis, gd, intl, imagick among others are always on). `php_extension_enable website=<site> extension=apcu` turns on one of the available ones and `php_extension_disable` reverses it; run `website_restart_php` afterwards if a running app needs it.
- **Workers**: `php_workers_get` and `php_workers_set website=<site> lsapi_children=<n>` set how many PHP requests the site runs at once. That count is the only php.ini-style knob at customer tier — arbitrary directives are not editable here, so never promise a `memory_limit` change. Raising it costs memory.
- **Debugging a 500**: `php_error_log` returns the newest 64 KB of the panel's log. Read it before guessing. An empty log means PHP never errored — look at the document root and the rewrite rules instead.
- **Redis**: `redis_state_get` / `redis_state_set` is an on/off toggle for the per-site instance, not a key-value API; enabling it needs `canUse.redis`.
- **Cron**: `cron_add website=<site> jobs=["* * * * * php /var/www/<website_id>/app/artisan schedule:run"]` for the Laravel scheduler — it wants to run **every minute** and dispatches the due tasks itself, and `artisan` sits in the `<app dir>` from step 7, not in the docroot. The rules that bite:
  - A job is a full crontab line: five schedule fields (or `@reboot`/`@daily`/...) then the command.
  - **Escape every `%` as `\%`.** Cron ends the command at the first unescaped one and feeds the rest to the command's stdin, so `date +%s >> out.log` runs and writes nothing (verified live).
  - `cron_get` numbers lines from 0. `cron_remove` takes those numbers and the panel renumbers what is left after each removal, so re-read `cron_get` before removing more. `cron_delete` wipes the whole crontab and is destructive.
  - `container_cron_get` / `container_cron_set` only control whether `crontab -l` and `crontab -e` work **inside** the container over SSH. They do not schedule or stop anything: panel-managed jobs run either way (verified live). Turn it on only for a deploy script that installs its own jobs.

## Node runtime

- **Versions**: `node_versions_available` (newest of each major in the text, all in `structuredContent.versions`), `node_version_install`, `node_version_set_default`. `node_versions_installed` is a hint only; `nvm ls` over SSH is the truth — it omits exactly the version nvm's `default` alias points at (verified live), so never read a missing version as absent.
- **Apps**: `persistent_apps_list` shows every app with its URL. `persistent_app_log` is the first thing to read when an app misbehaves: the panel keeps a 256 KB tail that is truncated on every restart, so it only ever covers the current run, and the tool returns the newest 64 KB of it. `persistent_app_probe` fetches the app's URL straight from the app server, so it answers before DNS does. `persistent_app_update` changes command, working directory, port, path, start mode, WebSocket flag or Node version (`command`, `working_directory`, `port`, `proxy_path`, `start_mode`, `allow_websocket`, `node_version`); `clear_proxy=true` takes an app off the web: verified live, the listing comes back with `proxy: null`, the URL falls through to the docroot (404) and the Node process keeps running with its command, working directory, Node version and start mode untouched — re-expose it later with another `persistent_app_update` carrying `proxy_path` and `port`.
- **Commands**: the panel execs the command as argv with no shell and injects no `PORT`, so the port belongs in the app's npm `start` script, its server-side `.env` (`node --env-file=.env server.js`) or its code — never in front of the command. `working_directory` is relative to the site home and must not be empty; omit it only when the app should run from the home directory itself.
- **Restarts**: `persistent_app_create`, `persistent_app_update` and `persistent_app_delete` usually restart the whole website container, not just the app, so expect the site's PHP and static pages to be interrupted for a second or two. Verified live for create, delete, and updates that change the start mode, the command or clear the proxy; one update that only added a proxy to an app that had none applied without a restart, so do not count on an update being the restart by accident. Resending a field the app already has is how you restart one after a deploy, e.g. `persistent_app_update website=<site> app_id=<id> start_mode=automatic` — an update carrying no field is refused ("nothing to change").
- **`persistent_app_delete`** is destructive: it stops the process and removes the proxy at once, and the user types the website's domain name to confirm. The app's files and its `persistent_app_<id>.log` stay in the home directory.
- **Ports and paths**: one app per port, and the panel does not check for a clash — pick a free one from `persistent_apps_list`. A proxy path that collides with a directory in `public_html` is the app's, not PHP's, and answers 503 while the app is stopped (verified live), so pick paths that do not exist in the docroot; `persistent_app_create` and a path-changing `persistent_app_update` fetch both `/<path>` and `/<path>/` first and refuse unless both answer 404, unless `replace_existing_path=true`. A path another app already uses is refused by the panel (409). `serve_at_root=true` on create gives an app the whole domain instead of a path — see "PHP or static site plus a Node app".

## PHP or static site plus a Node app

One website can serve both: the web server serves `public_html`, and every registered proxy path
goes to a Node app instead. Where the two overlap the proxy wins, even while the app is stopped
(verified live: an app registered on `demo-login` turned that live PHP page into a 503 until it was
deleted), so decide who owns which path before registering anything.

- **Picking a path for a new app**: one that returns 404 on the live site today — in **both** forms.
  Verified live 2026-09-17: an existing directory answers **301 to `https://<domain>/<dir>/` on the
  bare `/<dir>`**, whether it is empty, holds files, or holds an index page, while `/<dir>/` itself
  answers **404 unless it has an index file**; a file answers 200 on `/<file>` and 404 on `/<file>/`;
  a path that exists nowhere answers 404 both ways. So the bare path is what reveals a directory, and
  `persistent_app_create` fetches both forms and refuses unless both are 404, naming what it would
  replace; `replace_existing_path=true` overrides that and only makes sense when taking that page off
  the web is the point. `ls public_html/<first segment>` over SSH remains the exact check, and the
  only one that also shows what is inside.
- **Before rsyncing files into `public_html/<dir>`**, run the reverse check: `persistent_apps_list`,
  and stop if an app already proxies that path. The upload would succeed and the URL would keep
  answering from the app.
- **After registering**, re-request the site's known URLs (the home page, one PHP page, one static
  file). The registration restarted the container too, so this is the moment to notice anything that
  stopped working.
- **Timing**: most registrations restart the whole website container, so do it at a quiet moment.

**A subdomain is two different things here.** `domain_add website=<site> kind=subdomain
document_root=<dir>` maps a subdomain *inside* an existing website: it gets a docroot beside
`public_html` in the same container, sharing the unix user, PHP version, databases and quota, and no
website slot is used. That serves static pages and PHP fine — **but a persistent app never answers
there** (verified live 2026-09-17: the website's app paths returned 404 on such a subdomain, because
the app proxy binds to the primary domain only). A Node app therefore needs the subdomain to be its
**own website** (`website_create`), with its own container and unix user, registered with
`serve_at_root=true`. Offer the customer both and say which their project needs; the `enhance-apps`
skill walks through that choice for a CMS install.

**The layout choice.** An API or a single-page app under a path is fine. A Node app that is the
whole site, or any multi-page framework site, goes on its own website or subdomain with
`serve_at_root=true`: it receives the full request path with nothing stripped, absolute URLs and
generated links just work, and no `assetPrefix` is needed. That site serves nothing else —
`public_html` is not served while a root app is registered — so create the site for the app rather
than taking over one that already has content (the tool refuses that too, unless
`replace_existing_path=true`).

Under a path, the verified limits:

- The proxy strips the `/<path>` prefix, so the app serves its routes at `/` (Node layout, step 4).
- `assetPrefix` covers only the framework's own bundles (`/_next/static/…`). Files in `public/`,
  links the app generates (`<Link href="/about">`) and absolute `fetch('/api')` calls still go to the
  **domain root**. The user hit exactly this: images on `https://vahi.dev/next/` were broken because
  the page referenced `/next.svg`, which is a 404 at the domain root, while `/next/next.svg` was 200.
  Write those references with the prefix (`src="/next/next.svg"`) or move the app to its own site.
- `persistent_app_probe` checks the page's assets for you; treat a failure as a failed deploy
  (step 10).

## Access control and rewrites

- Read `htaccess_rewrites_get` first, always: it lists the panel-managed `RewriteRule`/`RewriteCond` chains with their line numbers. `htaccess_rewrites_set` upserts by `lineNumber` — chains you do not list are kept exactly as they are — and `htaccess_rewrites_delete` removes by line number, after which the panel **renumbers the rest from 1**. Re-read before deleting more.
- Rules an app ships in its own `.htaccess` (Laravel's `public/.htaccess`, WordPress's permalink block) are never shown by these tools, even after the panel has rewritten the file around them. **Verified live 2026-09-16:** an rsync that brings an app `.htaccess` replaces the panel's `<RequireAll>` block outright and the site keeps serving; the next panel write (`ip_rules_set`, `htaccess_rewrites_set`) re-parses the file, keeps the app's rules and appends the panel's block after them. So deploying an app `.htaccess` is safe, and a later panel write does not destroy it. Still read the file over SSH after a deploy when something behaves oddly.
- `ip_rules_get` / `ip_rules_set` write an Apache 2.4 `Require ip` block. **Verified live: (Open)LiteSpeed servers ignore it** — an allow list naming a single address still answered 200 to every other IP, on static, PHP and 404 paths alike. Never present it as a security control. If the user asks for one, set it and then verify from an address that should be blocked with `curl -o /dev/null -w '%{http_code}' https://<domain>/`; when that returns 200, say plainly that this server does not enforce the rule and that access control belongs in the application or at the CDN.
- An allow list that leaves out the user's own IP locks them out wherever the rule *is* enforced. `ip_rules_set website=<site> kind=block ips=[]` clears the rule.

## Rollback
The panel keeps automatic backups (`backups_list` arrives in a later milestone). For now: keep the previous build locally; re-run rsync from it to roll back.
