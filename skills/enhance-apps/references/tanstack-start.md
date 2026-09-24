# TanStack Start on Enhance

**Status: verified live 2026-09-17** (Live test C3 in `docs/research.md`).

## What it is, and when to pick it

A full-stack React framework: TanStack Router with SSR and server functions, built on Nitro. It is
**not a CMS** — there is no admin, no content editor and no login. Pick it when the customer wants
an application or a site *they* will write code for, and pick a CMS (Ghost, Payload, EmDash) when
they want to write content in a browser.

## Requirements

- Mode B: a website of its own (`website_create`), app registered with `serve_at_root=true`.
- Node 22 LTS. The trial ran on v22.23.2 through nvm's `default` alias (`node_install` →
  `node_version_install 22.23.2` → `node_version_set_default 22.23.2`) — or today's newest release of the 22 LTS line from `node_versions_available`; nothing was pinned on the
  app.
- No database. Add one with the `enhance-database` skill only if the app needs it.
- `canUse.persistentApps` true, `featureSSH` on the subscription.

## Scaffold (locally)

**Verified live 2026-09-17** — this exact command:

```sh
npx --yes @tanstack/cli create <name> --framework React --deployment nitro \
  --package-manager npm --no-git --no-intent --no-toolchain --no-examples --yes
```

It produced Vite 8.3 and Nitro 3.0 beta with the **`node-server` preset**. The `--no-*` flags just
keep the scaffolder non-interactive and the tree minimal; the load-bearing one is
**`--deployment nitro`**, the target that produces a plain Node server entry
(`.output/server/index.mjs`). Other targets build for other hosts and may produce no Node entry at
all — the trial used nitro; nothing else was tried.

The scaffold ships no `start` script, so add this one to `package.json` before uploading
(**verified live 2026-09-17**):

```json
"scripts": { "start": "node --env-file=.env .output/server/index.mjs" }
```

## Upload (skill step 8)

The exclude list the trial used (**verified live 2026-09-17**):

```sh
# local, sandbox disabled
rsync -rltvz --exclude .git --exclude node_modules --exclude .output --exclude .env \
  --exclude dist --exclude build --exclude .tanstack --exclude .nitro \
  <src>/ <user>@<host>:startapp/
```

`.tanstack` and `.nitro` are build caches; uploading them wastes time and can confuse the build.

## Env file (`<app dir>/.env`) — on the server BEFORE install and build (skill step 9)

```
PORT=3000
```

`chmod 600`, never in the rsync, never committed. The Nitro server entry reads `NITRO_PORT ?? PORT`,
so either name works; `PORT` keeps it consistent with the other recipes. The command cannot carry it
— the panel execs argv with no shell and injects no `PORT`. Write it before the build so anything the
customer's app reads from the environment at build time sees the same file the running app will.

## Install and build (skill steps 10 and 12 — no migrations in between)

```sh
ssh <user>@<host> '. ~/.nvm/nvm.sh && cd startapp && npm ci && npm run build'
```

Trial timings on the container: `npm ci` 4 s, `npm run build` 2 s. The build writes `.output/`.

## Register the app

```
persistent_app_create website=<site> command="npm start" working_directory=startapp \
  serve_at_root=true port=3000
```

- `command="npm start"` runs `node --env-file=.env .output/server/index.mjs`.
- The entry point is `.output/server/index.mjs`, not a `server.js` in the project root.
- Registering restarts the website container (seconds, on a site dedicated to this app).

## Migrations

None.

## Verification (skill step 14) — before the customer is told anything

- `persistent_app_probe website=<site> app_id=<id>` → HTTP 200, certificate valid, assets all
  answered (2/2 in the trial).
- `persistent_app_log` → the listening line
  (`Listening on: http://localhost:3000/ (all interfaces)` in the trial), no stack traces.
- `curl -sS -o /dev/null -w '%{http_code}' https://<domain>/` and one client-side route.
- `files_list website=<site> path=startapp` → `.output/` (list `path=startapp/.output` to see
  `server/index.mjs`, the entry the start script runs), `node_modules/` with its contents skipped,
  and `.env` with mode `600`.

## First admin (skill step 15)

The framework ships no admin and no authentication, so there is nothing to claim — but say that
plainly: **everything the app serves is public from the moment it answers.** If the customer's app
has its own login, their code owns that story; ask whether anything sensitive is in the build before
handing over the URL.

## What to back up

The source repository. Nothing in the container is authoritative except any `.env` values the
customer added; `.output/` and `node_modules` are rebuilt.

## Traps

| Trap | Fix |
|---|---|
| The app never starts and the log shows `Cannot find module` | the entry is `.output/server/index.mjs`; check `working_directory` is the app directory relative to the home, not absolute |
| A build target without a Node server entry | scaffold with `--deployment nitro` (the verified target) |
| Port not honoured | nothing injects `PORT`; it must reach the process through `--env-file=.env` (or `-p`-style config), never as a `VAR=value` prefix on the command |
