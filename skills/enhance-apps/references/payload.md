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
- Node 22 LTS (trial: v22.23.2 via nvm's `default` alias).
- A database. The trial used **`@payloadcms/db-sqlite`** — a file inside the app directory, nothing
  to provision. Payload's Postgres and MySQL adapters exist; **neither was tried here**, and the
  MySQL one would need `socketPath: '/run/mysqld/mysqld.sock'` (see the skill's "MySQL from Node").
- `canUse.persistentApps`, `featureSSH`.

## Scaffold (locally)

```sh
npx create-payload-app@latest <name>
```

The trial used the **blank template with the SQLite adapter** (Payload 3.89, Next 16.3.3,
`@payloadcms/db-sqlite`); the exact answers to the scaffolder's prompts were not recorded beyond
that. Generate the migrations locally straight after scaffolding (see "Migrations" — this is the
trap that cost the trial the most time):

```sh
npm run payload -- migrate:create initial
```

and commit the generated `src/migrations/` (or wherever the template puts them) so they travel with
the upload.

## Upload and build

```sh
# local, sandbox disabled
rsync -rltvz --exclude .git --exclude node_modules --exclude .env --exclude .next \
  --exclude '*.db' <src>/ <user>@<host>:payloadapp/

# on the server
ssh <user>@<host> '. ~/.nvm/nvm.sh && cd payloadapp && npm install && npm run build'
```

`npm install` plus `next build` took 36 s in the trial with no out-of-memory kill, on a 3.9 GB
container with about 2.4 GB free. If the template's build script carries
`NODE_OPTIONS=--max-old-space-size=8000`, that is a **ceiling, not a requirement** — leave it, it
costs nothing. (It works inside `package.json` because npm runs scripts through a shell; the
persistent-app command has no shell and could not carry it.)

## Env file (`<app dir>/.env`, written on the server)

```
DATABASE_URL=file:./payload.db
PAYLOAD_SECRET=<32+ random characters>
```

Next.js loads `.env` from the working directory itself, so `npm start` (`next start`) picks these up
without `--env-file`. `next start` listens on **3000** unless the script passes `-p`, which is why
the trial registered port 3000.

## Migrations — run them before the first start

**The trap, verified live.** The SQLite adapter only pushes the schema automatically in
*development*. Started with `next start` in production, Payload created `payload.db` as a **0-byte
file** and the blank template ships no migrations, so:

- `https://<domain>/admin` answered **HTTP 200**,
- the browser showed "This page couldn't load" (the error is rendered client-side),
- and `persistent_app_log` showed `SQLITE_ERROR: no such table: users`.

Fix, on the server in the app directory with nvm loaded:

```sh
npm run payload -- migrate:create initial   # only if no migrations were committed
npm run payload -- migrate                  # 75 ms in the trial
```

then restart: `persistent_app_update website=<site> app_id=<id> start_mode=automatic`. After that
`/admin/login` and `/admin/create-first-user` answered 200 with no database errors in the log.

**Rule:** generate the migrations locally, upload them, and run `payload migrate` on the server
**before** the first start — ideally before `next build`. Never rely on the schema appearing by
itself in production.

## Register the app

```
persistent_app_create website=<site> command="npm start" working_directory=payloadapp \
  serve_at_root=true port=3000
```

## First admin

`https://<domain>/admin` shows **"Create first user"** to anyone who finds it until it is claimed.
Claim it immediately (skill section 4).

- Payload exposes the first-user creation over its REST API (`POST /api/users` while no user
  exists). **Not exercised in the trial** — if you use it, check the response body and then confirm
  with the page below.
- Verified path: send the customer to `https://<domain>/admin/create-first-user` right away with the
  name, email and generated password, and stay with them. The trial's admin was created this way and
  the customer confirmed it works.
- Confirm afterwards: `/admin` now lands on the **login** form, not the create-first-user screen.

`GET /api/users` answering **403** while signed out is correct, not a fault.

## Verification

- `persistent_app_probe website=<site> app_id=<id>` → 200 with its assets answering.
- **`persistent_app_log`** → no `SQLITE_ERROR`, no stack traces. This is the check that catches the
  empty-database failure; the status code does not.
- `curl` `/`, `/admin`, `/admin/login`, and open `/admin` in a browser when the customer is there.

## What to back up

- the SQLite file `<app dir>/payload.db` — copy it over SSH **with the app stopped**
  (`persistent_app_update … start_mode=manual`, then back to `automatic`);
- the media/uploads directory if the customer's collections use uploads;
- the source repository, **including the migrations**, which are part of the schema's history.

## Traps

| Trap | What you see | Fix |
|---|---|---|
| Empty database in production | `/admin` 200 but "This page couldn't load"; log: `no such table: users` | `payload migrate:create` + `payload migrate`, then restart; run migrations before the first start |
| Verifying by status code | a 200 that is broken in the browser | probe **and** read the log **and** load `/admin/login` |
| `PORT` not honoured | app answers nothing on the proxy port | `next start` defaults to 3000; register that port or pass `-p <port>` in the start script |
| An 8 GB heap flag in the build script | looks like a 8 GB requirement | it is a ceiling; the 3.9 GB container built in 36 s |
| A stale `payload.db` uploaded from the laptop | production data silently replaced | exclude `*.db` from the rsync, always |
