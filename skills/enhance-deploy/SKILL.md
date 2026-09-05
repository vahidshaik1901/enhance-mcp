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
  - provider `cloudflare` → offer (a) the integration: user adds a Cloudflare API token in the panel, then you call `domain_cloudflare_connect` with the key id from `cloudflare_keys_list`; or (b) manual: `domain_dns_records` and the user adds them at Cloudflare.
  - provider `other` or `unknown` / status `Failed` → give the platform nameservers from `platform_info` or the A record; `domain_dns_records` for the full list.
  - status `ForeignServer` → the domain currently points somewhere else (often a CDN or an old host); continue on the preview domain and give the customer the instructions for their provider; do not tell them the site is live.
  - Mail: `domain_dns_records` adds MX, SPF, DMARC and the mail hosts only when the domain has email accounts on the platform. Never tell a customer to add the platform's mail records for a domain whose mail lives elsewhere (Google Workspace, Microsoft 365, and so on); that breaks their email. `include_mail=yes` forces them when the customer says mail should move here.
  - status `Mixed` → the website's domains resolve differently; run `domain_dns_status` per domain and treat each on its own.
- Never change the registrar or a third-party DNS host yourself.

### 5. SSL
- `domain_ssl_get`. If `placeholder` is true and DNS already resolves (`Resolved`), call `domain_ssl_issue`. If DNS does not resolve yet, say SSL will be issued after DNS and continue; the preview domain already has HTTPS.
- After a real certificate exists, offer `domain_set_force_ssl enabled=true`.

### 6. SSH
- `ssh_keys_list`. If the user's public key is not listed, read `~/.ssh/id_ed25519.pub` (or ask which key) and call `ssh_key_add`. Never read or send a private key.
- `ssh_connection_info` gives the login command, home, document root and an rsync example.

### 7. Build locally
Detect the project type and build here, never on the server for PHP:
- **Static** (index.html at the root or a `dist/`/`build/` output): nothing to build, or run the project's build script.
- **PHP / Laravel**: `composer install --no-dev --optimize-autoloader` locally is not required; Composer exists in the container. Do not upload `vendor/` if `composer.json` exists; install remotely in step 9.
- **WordPress theme or plugin**: deploy into `public_html/wp-content/themes/<name>` or `plugins/<name>`, never the docroot root.
- **Node**: handled by a later milestone; for now stop and say so.

### 8. Deploy with rsync
- Always dry-run first and show the summary:
  `rsync -rltvz --dry-run --exclude .git --exclude node_modules --exclude .env <src>/ <user>@<host>:<docroot>/`
- Use `-rltvz`, not `-a`. With a trailing-slash source, `-a` copies the local folder's owner, group and mode onto the document root, which the panel keeps at `750` with the web server's group (verified live 2026-09-05).
- Add `-e "ssh -i <key>"` when the authorized key is not the user's default one.
- Then run it for real. Use `--delete` only if the user explicitly asked to remove files not in the source.
- Target is the document root or a named subdirectory. Never the home directory root.
- **Sandbox**: this command needs the sandbox disabled (or `ssh`/`rsync` in `sandbox.excludedCommands`). Say so before running.

### 9. Post-deploy (over the same SSH)
- PHP with Composer: `ssh <user>@<host> 'cd <docroot> && composer install --no-dev --optimize-autoloader'`.
- Laravel: `php artisan migrate --force` only when the user confirms; `php artisan config:cache`.
- WordPress: `wp cache flush` if WP-CLI reports a site.
- Then `website_restart_php` if OPcache might hold old code (PHP projects), and `cache_clear` when it becomes available (later milestone).

### 10. Verify
- Request a file you just deployed, not just `/`: an empty docroot returns 404 on every hostname.
  `curl -sS -o /dev/null -w '%{http_code}' https://<preview-domain>/index.html` (or `curl -k --resolve …` when there is no preview domain).
- `curl: (6) Could not resolve host` on a preview domain created minutes ago is DNS propagation, not a failed deploy (about five minutes live). Verify the vhost meanwhile with `curl -k --resolve <preview-domain>:443:<app-server-ip> https://<preview-domain>/index.html`, then retry the plain URL.
- Report: preview URL, primary URL and its DNS status, SSL state, what was uploaded (from the rsync summary), and what the user still has to do (DNS at the registrar, if anything).

## Rollback
The panel keeps automatic backups (`backups_list` arrives in a later milestone). For now: keep the previous build locally; re-run rsync from it to roll back.
