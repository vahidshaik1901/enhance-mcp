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
- **Database**: create the database and user first with the `enhance-database` skill, then write the app config with `DB_HOST=localhost` and the full `<unixUser>_` prefixed names.
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

Stop here unless `website_get` shows `canUse.persistentApps: true`: without it the plan does not
run Node processes (safety rule 4). Every `persistent_app_create`, `persistent_app_update` and
`persistent_app_delete` restarts the whole website container (verified live), not just the app, so
the site's PHP and static pages are interrupted for a second or two each time.

1. **Runtime.** `node_versions_installed` shows what the panel believes is installed — it is a hint
   only; `. ~/.nvm/nvm.sh && nvm ls` over SSH is the truth, and the panel's list omits exactly the
   version nvm's `default` alias points at (verified live). If there is no `~/.nvm`, run
   `node_install` (nvm plus the current stable Node; allow a minute). For the version the project
   wants (`.nvmrc`, `engines.node`, else the current LTS from `node_versions_available`):
   `node_version_install version=<x.y.z>` then `node_version_set_default version=<x.y.z>`. Pin
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
3. **Port.** Pick the port the app will listen on (3000–3999 by convention) and check
   `persistent_apps_list` does not already show it: the panel accepts a duplicate port without
   complaint (verified live), so that check is yours. **The command is not a shell line.** The
   panel splits it on whitespace and execs it as argv, and it injects no `PORT`, so an environment
   assignment in front of the command cannot work — the create tool refuses those, along with
   pipes, redirection and quoted segments containing whitespace (quotes are fine only around a
   segment with no whitespace). The app has to choose the proxy's port itself:
   - put it in the npm start script — `"start": "node --env-file=.env server.js"` with a `PORT=3000`
     line in the server-side `.env` (Node 20.6+), or `"start": "next start -p 3000"` — and use
     `npm start` as the command;
   - or use `node --env-file=.env server.js` as the command directly;
   - or hard-code the port in the app.
4. **Proxy path.** The URL path the web server forwards to the app: `node`, `api`, `app/v2`. No
   leading slash (the panel rejects it; the tool strips one and says so). A path another app
   already uses is refused (409), but a path that a real directory under `public_html` serves is
   accepted — and **the proxy wins even while the app is stopped**: verified live, an app merely
   registered on `demo-login` turned that PHP page into a 503 until the app was deleted. Pick a
   path that does not exist in the docroot.

Everything below calls `<home>/<app>` the **`<app dir>`** for Node too.

### 8. Deploy with rsync
- Always dry-run first and show the summary:
  `rsync -rltvz --dry-run --exclude .git --exclude node_modules --exclude .env <src>/ <user>@<host>:<docroot>/`
- Use `-rltvz`, not `-a`. With a trailing-slash source, `-a` copies the local folder's owner, group and mode onto the document root, which the panel keeps at `750` with the web server's group (verified live 2026-09-05).
- Add `-e "ssh -i <key>"` when the authorized key is not the user's default one.
- Then run it for real. Use `--delete` only if the user explicitly asked to remove files not in the source.
- Target is the document root, a directory under it, or a named directory in the home (`app/` for the Laravel layout in step 7 — that one runs twice, once into `app/` and once into `public_html/`). Never the home directory root itself. For Node, the target is the `<app dir>` from the Node layout, excluding `.git`, `node_modules`, `.env` and the build output (`.next`, `dist`, `build`): `rsync -rltvz --exclude .git --exclude node_modules --exclude .env --exclude .next --exclude dist <src>/ <user>@<host>:<app>/`.
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
- **Node**, in this order, all over SSH in the `<app dir>` with nvm loaded (`. ~/.nvm/nvm.sh &&`). Registering or changing the app restarts the whole website container, so deploy at a quiet moment:
  1. `npm ci --omit=dev` when a lockfile exists, else `npm install --omit=dev`. Frameworks that build with dev dependencies (Next.js, Vite) need `npm ci` without `--omit=dev`, then the build, then optionally `npm prune --omit=dev`.
  2. `npm run build` when `package.json` has a build script. If the build is killed for memory, build locally instead and rsync the output directory up (Next.js: set `output: 'standalone'`), and say so.
  3. Write `.env` on the server (never rsync a local one). Put the `PORT=<port>` line in it when the app reads its port from the file — `node --env-file=.env server.js`, or an npm `start` script that does — because the command itself cannot carry it.
  4. Register the app: `persistent_app_create website=<site> command="npm start" working_directory=<app> proxy_path=<path> port=<port>`. `command` is argv, not a shell line, so the port lives in the app's own config and never in front of the command. Add `allow_websocket=true` for Socket.IO and similar, and `node_version=<x.y.z>` when the project pins one (otherwise the app runs on nvm's `default` alias). Note the `id` it returns.
  5. `persistent_app_log app_id=<id>` until it shows the listening line. A crash shows here first; fix it before touching the proxy, then verify with `persistent_app_probe` (step 10).
  6. For a later deploy: rsync again, rebuild, then restart. An update restarts the app and, verified live, the whole website container, so the site's PHP and static pages are interrupted for a second or two — a no-change `persistent_app_update` is therefore the restart. The same tool changes the command, port, path or Node version.
- WordPress: `wp cache flush` if WP-CLI reports a site.
- Then both caches, which are different things: `website_restart_php` for PHP OPcache, which otherwise keeps serving the previous code, and `cache_clear` for the domain's FastCGI (page) cache.

### 10. Verify
- Request a file you just deployed, not just `/`: an empty docroot returns 404 on every hostname.
  `curl -sS -o /dev/null -w '%{http_code}' https://<preview-domain>/index.html` (or `curl -k --resolve …` when there is no preview domain).
- **Node**: `persistent_app_probe website=<site> app_id=<id>` — it connects to the app server's IP with the domain as SNI, so it works before DNS. `HTTP 200` with the app's body means the proxy and the process are up; `502`/`503` means the web server is fine and the app is not listening on its port (read `persistent_app_log`, and confirm the app really binds the proxy's port — nothing injects `PORT` into it). Once DNS resolves, `curl https://<primary domain>/<path>/`. The preview URL returns 404 for the app path; that is expected, not a failure.
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
- **Apps**: `persistent_apps_list` shows every app with its URL. `persistent_app_log` is the first thing to read when an app misbehaves: the panel keeps a 256 KB tail that is truncated on every restart, so it only ever covers the current run, and the tool returns the newest 64 KB of it. `persistent_app_probe` fetches the app's URL straight from the app server, so it answers before DNS does. `persistent_app_update` changes command, port, path, WebSocket flag or Node version; `clear_proxy=true` takes an app off the web (not yet verified live).
- **Commands**: the panel execs the command as argv with no shell and injects no `PORT`, so the port belongs in the app's npm `start` script, its server-side `.env` (`node --env-file=.env server.js`) or its code — never in front of the command. `working_directory` is relative to the site home and must not be empty; omit it only when the app should run from the home directory itself.
- **Restarts**: `persistent_app_create`, `persistent_app_update` and `persistent_app_delete` each restart the whole website container (verified live), not just the app, so the site's PHP and static pages are interrupted for a second or two. A no-change `persistent_app_update` is how you restart an app after a deploy.
- **`persistent_app_delete`** is destructive: it stops the process and removes the proxy at once, and the user types the website's domain name to confirm. The app's files and its `persistent_app_<id>.log` stay in the home directory.
- **Ports and paths**: one app per port, and the panel does not check for a clash — pick a free one from `persistent_apps_list`. A proxy path that collides with a directory in `public_html` is the app's, not PHP's, and answers 503 while the app is stopped (verified live), so pick paths that do not exist in the docroot. A path another app already uses is refused (409).

## Access control and rewrites

- Read `htaccess_rewrites_get` first, always: it lists the panel-managed `RewriteRule`/`RewriteCond` chains with their line numbers. `htaccess_rewrites_set` upserts by `lineNumber` — chains you do not list are kept exactly as they are — and `htaccess_rewrites_delete` removes by line number, after which the panel **renumbers the rest from 1**. Re-read before deleting more.
- Rules an app ships in its own `.htaccess` (Laravel's `public/.htaccess`, WordPress's permalink block) are never shown by these tools, even after the panel has rewritten the file around them. **Verified live 2026-09-16:** an rsync that brings an app `.htaccess` replaces the panel's `<RequireAll>` block outright and the site keeps serving; the next panel write (`ip_rules_set`, `htaccess_rewrites_set`) re-parses the file, keeps the app's rules and appends the panel's block after them. So deploying an app `.htaccess` is safe, and a later panel write does not destroy it. Still read the file over SSH after a deploy when something behaves oddly.
- `ip_rules_get` / `ip_rules_set` write an Apache 2.4 `Require ip` block. **Verified live: (Open)LiteSpeed servers ignore it** — an allow list naming a single address still answered 200 to every other IP, on static, PHP and 404 paths alike. Never present it as a security control. If the user asks for one, set it and then verify from an address that should be blocked with `curl -o /dev/null -w '%{http_code}' https://<domain>/`; when that returns 200, say plainly that this server does not enforce the rule and that access control belongs in the application or at the CDN.
- An allow list that leaves out the user's own IP locks them out wherever the rule *is* enforced. `ip_rules_set website=<site> kind=block ips=[]` clears the rule.

## Rollback
The panel keeps automatic backups (`backups_list` arrives in a later milestone). For now: keep the previous build locally; re-run rsync from it to roll back.
