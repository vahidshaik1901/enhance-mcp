# Payload CMS on Enhance

**Status: verified live 2026-09-17** — Payload 3.89 on Next.js 16.3.3 with the SQLite adapter
(Live test C3 in `docs/research.md`).

## What it is, and when to pick it

A headless CMS that is also a Next.js app: collections and fields are defined in TypeScript, the
admin UI is generated from them, and the content is served over REST/GraphQL as well as from the
same Next app. Pick it when the customer wants to model their own content and code against it. Pick
Ghost for a blog someone just writes in.

## Requirements

- Mode B: a website of its own (`website_create`), app registered with `serve_at_root=true`.
- Node 22 LTS (trial: v22.23.2 via nvm's `default` alias — `node_install` →
  `node_version_install 22.23.2` → `node_version_set_default 22.23.2`) — or today's newest release of the 22 LTS line from `node_versions_available`.
- A database. The trial used **`@payloadcms/db-sqlite`** — a file inside the app directory, nothing
  to provision. Payload's Postgres and MySQL adapters exist; **neither was tried here**, and the
  MySQL one would need `socketPath: '/run/mysqld/mysqld.sock'` (see the skill's "MySQL from Node").
- `canUse.persistentApps`, `featureSSH`.

## Scaffold (locally)

**Verified live 2026-09-17** — this exact command:

```sh
npx --yes create-payload-app@latest -n <name> -t blank --db sqlite \
  --db-connection-string "file:./payload.db" --use-npm --no-deps --no-agent
```

It produced **Payload 3.89.0, Next 16.3.3, `@payloadcms/db-sqlite`**, and wrote a local `.env` with
`DATABASE_URL` and a generated `PAYLOAD_SECRET`.

**`--no-deps` is the trial's choice, not a recommendation.** It skips the install, so the scaffold
has **no `package-lock.json`** — which is why the server step below is `npm install` and not
`npm ci`. For a real customer project, **scaffold with dependencies** (drop `--no-deps`): a lockfile
exists, the server build is a reproducible `npm ci`, and — because the `payload` binary is then
installed locally — you can generate the migrations before you upload:

```sh
npm run payload -- migrate:create initial   # only with a dependency-installed scaffold
```

Commit the generated `src/migrations/` (or wherever the template puts them) so they travel with the
upload, and the server then only runs `payload migrate`.

With `--no-deps` there is **no local `payload` binary**, so nothing can be generated locally; the
migrations are created on the server after `npm install` instead (see "Migrations"). Nothing else
about the recipe changes.

## Upload (skill step 8)

```sh
# local, sandbox disabled
rsync -rltvz --exclude .git --exclude node_modules --exclude .env --exclude .next \
  --exclude '*.db' <src>/ <user>@<host>:payloadapp/
```

## Env file (`<app dir>/.env`) — on the server BEFORE install and build (skill step 9)

```
DATABASE_URL=file:./payload.db
PAYLOAD_SECRET=<32+ random characters>
```

The scaffolder writes this file locally with both values. The trial copied it to the server with a
single `scp` and **never** let it into the rsync (the rsync excludes `.env`, and a heredoc over SSH
works just as well); `chmod 600` it there. Either way it must never be committed.

**It has to be in place before the build, not after it.** `payload.config.ts` reads
`PAYLOAD_SECRET` and `DATABASE_URL` at import time, and both `next build` and the `payload` CLI
import that config — without the file they fail or build against the wrong database.

Next.js loads `.env` from the working directory itself, so `npm start` picks these up without
`--env-file`. The template's start script is
`cross-env NODE_OPTIONS=--no-deprecation next start`, and `next start` listens on **3000** unless
the script passes `-p` — which is why the trial registered port 3000.

## Install, migrate, build (skill steps 10–12)

In that order, on the server in the app directory with nvm loaded:

```sh
ssh <user>@<host> '. ~/.nvm/nvm.sh && cd payloadapp && npm install'
ssh <user>@<host> '. ~/.nvm/nvm.sh && cd payloadapp && npm run payload -- migrate:create initial'   # ONLY when no migrations came with the upload; skip it otherwise
ssh <user>@<host> '. ~/.nvm/nvm.sh && cd payloadapp && npm run payload -- migrate'
ssh <user>@<host> '. ~/.nvm/nvm.sh && cd payloadapp && npm run build'
```

`npm install`, **not `npm ci`**, because the trial's `--no-deps` scaffold shipped no lockfile. If you
scaffolded with dependencies (the recommendation above), upload the lockfile, use `npm ci`, and skip
the `migrate:create` line — the migrations came with the upload.

`npm install` plus `next build` took 36 s in the trial with no out-of-memory kill, on a 3.9 GB
container with about 2.4 GB free; `payload migrate` took 75 ms. If the template's build script
carries `NODE_OPTIONS=--max-old-space-size=8000`, that is a **ceiling, not a requirement** — leave
it, it costs nothing. (It works inside `package.json` because npm runs scripts through a shell; the
persistent-app command has no shell and could not carry it.)

## Migrations — the trap, and why they come before the build

**Verified live.** The SQLite adapter only pushes the schema automatically in *development*. Started
with `next start` in production, Payload created `payload.db` as a **0-byte file** and the blank
template ships no migrations, so:

- `https://<domain>/admin` answered **HTTP 200**,
- the browser showed "This page couldn't load" (the error is rendered client-side),
- and `persistent_app_log` showed `SQLITE_ERROR: no such table: users`.

**In the trial the migration was run afterwards, as the repair** — `migrate:create` + `migrate` on
the server, then a restart with
`persistent_app_update website=<site> app_id=<id> start_mode=automatic`, after which
`/admin/login` and `/admin/create-first-user` answered 200 with no database errors in the log. The
order above is the corrected one: **migrate before the build and therefore long before the first
start**, so the app never serves a request against an empty database. Never rely on the schema
appearing by itself in production.

## Register the app

```
persistent_app_create website=<site> command="npm start" working_directory=payloadapp \
  serve_at_root=true port=3000
```

## Verification (skill step 14) — before the customer is told anything

- `persistent_app_probe website=<site> app_id=<id>` → 200 with its assets answering.
- **`persistent_app_log`** → no `SQLITE_ERROR`, no stack traces. This is the check that catches the
  empty-database failure; the status code does not.
- `curl` `/`, `/admin`, `/admin/login`, and open `/admin` in a browser when the customer is there.
- (expected from this recipe's layout; not yet re-run with files_list) `files_list website=<site> path=payloadapp` → `.next/` (the build), `node_modules/` with its
  contents skipped, `.env` with mode `600`, and `payload.db` with a size above 0: a 0-byte
  `payload.db` is the empty-database failure described under "Migrations".

## First admin (skill step 15) — only once the checks above passed

`https://<domain>/admin` shows **"Create first user"** to anyone who finds it until it is claimed.
Claim it immediately (skill section 5).

- Payload exposes the first-user creation over its REST API (`POST /api/users` while no user
  exists). **Not exercised in the trial** — if you use it, check the response body and then confirm
  with the page below.
- Verified path: send the customer to `https://<domain>/admin/create-first-user` — which you have
  just loaded yourself — with the name, email and generated password, and stay with them. The
  trial's admin was created this way and the customer confirmed it works.
- Confirm afterwards (skill step 16): `/admin` now lands on the **login** form, not the
  create-first-user screen.

`GET /api/users` answering **403** while signed out is correct, not a fault.

## What to back up

- the SQLite file `<app dir>/payload.db` — copy it over SSH **with the app stopped**
  (`persistent_app_update … start_mode=manual`, then back to `automatic`);
- the media/uploads directory if the customer's collections use uploads;
- the source repository, **including the migrations**, which are part of the schema's history.

## Traps

| Trap | What you see | Fix |
|---|---|---|
| Empty database in production | `/admin` 200 but "This page couldn't load"; log: `no such table: users` | `payload migrate:create` + `payload migrate`, then restart; in the recipe order they run **before the build**, so the app never starts against an empty database |
| `.env` written after the build | the build fails, or builds against the wrong database | the env file goes on the server before `npm install`; the config reads `PAYLOAD_SECRET`/`DATABASE_URL` at import time |
| Verifying by status code | a 200 that is broken in the browser | probe **and** read the log **and** load `/admin/login` |
| `PORT` not honoured | app answers nothing on the proxy port | `next start` defaults to 3000; register that port or pass `-p <port>` in the start script |
| An 8 GB heap flag in the build script | looks like a 8 GB requirement | it is a ceiling; the 3.9 GB container built in 36 s |
| A stale `payload.db` uploaded from the laptop | production data silently replaced | exclude `*.db` from the rsync, always |
