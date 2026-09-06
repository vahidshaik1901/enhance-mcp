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
- **Node**: handled by a later milestone; for now stop and say so. Forward note: a Node persistent app's proxy path is served on the **primary domain**, not the `*.mystaging.site` preview URL (verified live), so its verification step will not match static and PHP.

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
   needs the same `/app` prefix. Re-apply the edit whenever step 2's rsync overwrites `index.php`.

Everything below calls `<home>/app` the **`<app dir>`**.

### 8. Deploy with rsync
- Always dry-run first and show the summary:
  `rsync -rltvz --dry-run --exclude .git --exclude node_modules --exclude .env <src>/ <user>@<host>:<docroot>/`
- Use `-rltvz`, not `-a`. With a trailing-slash source, `-a` copies the local folder's owner, group and mode onto the document root, which the panel keeps at `750` with the web server's group (verified live 2026-09-05).
- Add `-e "ssh -i <key>"` when the authorized key is not the user's default one.
- Then run it for real. Use `--delete` only if the user explicitly asked to remove files not in the source.
- Target is the document root, a directory under it, or a named directory in the home (`app/` for the Laravel layout in step 7 — that one runs twice, once into `app/` and once into `public_html/`). Never the home directory root itself.
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
- WordPress: `wp cache flush` if WP-CLI reports a site.
- Then both caches, which are different things: `website_restart_php` for PHP OPcache, which otherwise keeps serving the previous code, and `cache_clear` for the domain's FastCGI (page) cache.

### 10. Verify
- Request a file you just deployed, not just `/`: an empty docroot returns 404 on every hostname.
  `curl -sS -o /dev/null -w '%{http_code}' https://<preview-domain>/index.html` (or `curl -k --resolve …` when there is no preview domain).
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

## Access control and rewrites

- Read `htaccess_rewrites_get` first, always: it lists the panel-managed `RewriteRule`/`RewriteCond` chains with their line numbers. `htaccess_rewrites_set` upserts by `lineNumber` — chains you do not list are kept exactly as they are — and `htaccess_rewrites_delete` removes by line number, after which the panel **renumbers the rest from 1**. Re-read before deleting more.
- Rules an app ships in its own `.htaccess` (Laravel's `public/.htaccess`, WordPress's permalink block) are not shown by these tools. **Open question, not yet verified:** how the panel-managed block in `public_html/.htaccess` coexists with an app's own file after an rsync deploy. Check it on the first PHP deploy — read the file over SSH before and after — and report what you find instead of assuming the panel's block survived.
- `ip_rules_get` / `ip_rules_set` write an Apache 2.4 `Require ip` block. **Verified live: (Open)LiteSpeed servers ignore it** — an allow list naming a single address still answered 200 to every other IP, on static, PHP and 404 paths alike. Never present it as a security control. If the user asks for one, set it and then verify from an address that should be blocked with `curl -o /dev/null -w '%{http_code}' https://<domain>/`; when that returns 200, say plainly that this server does not enforce the rule and that access control belongs in the application or at the CDN.
- An allow list that leaves out the user's own IP locks them out wherever the rule *is* enforced. `ip_rules_set website=<site> kind=block ips=[]` clears the rule.

## Rollback
The panel keeps automatic backups (`backups_list` arrives in a later milestone). For now: keep the previous build locally; re-run rsync from it to roll back.
