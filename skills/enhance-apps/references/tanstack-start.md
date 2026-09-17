# TanStack Start on Enhance

**Status: verified live 2026-09-17** (Live test C3 in `docs/research.md`).

## What it is, and when to pick it

A full-stack React framework: TanStack Router with SSR and server functions, built on Nitro. It is
**not a CMS** — there is no admin, no content editor and no login. Pick it when the customer wants
an application or a site *they* will write code for, and pick a CMS (Ghost, Payload, EmDash) when
they want to write content in a browser.

## Requirements

- Mode B: a website of its own (`website_create`), app registered with `serve_at_root=true`.
- Node 22 LTS. The trial ran on v22.23.2 through nvm's `default` alias; nothing was pinned on the
  app.
- No database. Add one with the `enhance-database` skill only if the app needs it.
- `canUse.persistentApps` true, `featureSSH` on the subscription.

## Scaffold (locally)

Use the project's current create command and select the **Nitro deployment target**:

```sh
npx create-start-app@latest <name>    # check the current command in the TanStack docs
# what matters: --deployment nitro
```

The `--deployment nitro` target is the one that produces a plain Node server entry
(`.output/server/index.mjs`). Other targets build for other hosts and may produce no Node entry at
all — the trial used nitro; nothing else was tried.

Add the start script to `package.json` before uploading:

```json
"scripts": { "start": "node --env-file=.env .output/server/index.mjs" }
```

## Upload and build

```sh
# local, sandbox disabled
rsync -rltvz --exclude .git --exclude node_modules --exclude .env --exclude .output \
  <src>/ <user>@<host>:startapp/

# on the server
ssh <user>@<host> '. ~/.nvm/nvm.sh && cd startapp && npm ci && npm run build'
```

Trial timings on the container: `npm ci` 4 s, build 2 s. The build writes `.output/`.

## Env file (`<app dir>/.env`, written on the server)

```
PORT=3000
```

The Nitro server entry reads `NITRO_PORT ?? PORT`, so either name works; `PORT` keeps it consistent
with the other recipes. The command cannot carry it — the panel execs argv with no shell and injects
no `PORT`.

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

## First admin

The framework ships no admin and no authentication, so there is nothing to claim — but say that
plainly: **everything the app serves is public from the moment it answers.** If the customer's app
has its own login, their code owns that story; ask whether anything sensitive is in the build before
handing over the URL.

## Verification

- `persistent_app_probe website=<site> app_id=<id>` → HTTP 200, certificate valid, assets all
  answered (2/2 in the trial).
- `persistent_app_log` → the listening line, no stack traces.
- `curl -sS -o /dev/null -w '%{http_code}' https://<domain>/` and one client-side route.

## What to back up

The source repository. Nothing in the container is authoritative except any `.env` values the
customer added; `.output/` and `node_modules` are rebuilt.

## Traps

| Trap | Fix |
|---|---|
| The app never starts and the log shows `Cannot find module` | the entry is `.output/server/index.mjs`; check `working_directory` is the app directory relative to the home, not absolute |
| A build target without a Node server entry | scaffold with `--deployment nitro` (the verified target) |
| Port not honoured | nothing injects `PORT`; it must reach the process through `--env-file=.env` (or `-p`-style config), never as a `VAR=value` prefix on the command |
