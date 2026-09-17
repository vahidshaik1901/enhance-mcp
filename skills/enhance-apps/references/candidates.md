# Candidates: apps that look like a fit but are NOT YET VERIFIED

Nothing on this page has been installed on an Enhance panel. Do not present any of it as a recipe,
do not promise a customer it will work, and do not copy the commands below without checking the
project's current documentation — they are the projects' well-known create commands, written from
memory, not from a trial.

If a customer wants one of these, say it is untried here, offer a verified recipe
(`ghost.md`, `payload.md`, `emdash.md`), and if they still want it, run it as an experiment: follow
the common flow in `../SKILL.md`, keep notes on every trap, and bring them back so this page can
become a recipe.

## Why these three

All three are the same shape as the four verified stacks, which is why they are the next ones worth
a trial:

- **They support MySQL**, which is what the platform offers (MariaDB 11.4 on the unix socket) — so
  they need no database the plan cannot provide, unlike anything Postgres-only where
  `canUse.postgresql` is false.
- **They run as one long-lived Node process** behind a reverse proxy, which is exactly what a
  persistent app is.
- **They build to a Node entry point** that can be started by an npm script — the pattern all four
  recipes use.
- **They have an admin UI with a first-admin flow**, so the skill's "never leave an installer
  unclaimed" rule applies and has somewhere to hook in.

| Candidate | What it is | Create command (UNVERIFIED) |
|---|---|---|
| **Strapi** | headless CMS, admin UI, REST/GraphQL, plugin ecosystem | `npx create-strapi-app@latest <name>` |
| **Directus** | data platform over an existing or new SQL database, admin UI | `npx create-directus-project@latest <name>` |
| **KeystoneJS** | code-first headless CMS with a generated admin and GraphQL API | `npm init keystone-app@latest <name>` |

## What a trial must confirm, for each

1. **MariaDB 11.4 is accepted.** Each project documents specific MySQL/MariaDB versions; the panel
   gives MariaDB 11.4 and nothing else. Ghost's "MySQL 8 only" turned out to work — that is evidence
   it is worth trying, not evidence it will.
2. **The MySQL client can use a unix socket.** Verified live: `127.0.0.1` is refused inside the
   container and the socket is `/run/mysqld/mysqld.sock`. Confirm the app passes a `socketPath`
   through to its driver (knex/mysql2 for Strapi and Keystone, the connection config for Directus)
   rather than only accepting a host and port or a `mysql://` URL.
3. **The admin build fits the container.** 3.9 GB total, about 2.4 GB free in the trial; Next.js
   built in 36 s there, but Strapi's and Directus' admin builds are heavier. If a build is killed,
   the fallback is building locally and uploading the output — which is a different recipe shape.
4. **The first-admin flow.** Is there a CLI or an API to create the first administrator
   (Strapi's `strapi admin:create-user`, Directus' `directus users create` / bootstrap env vars), or
   is it a web wizard open to the internet until claimed? The skill's section 4 needs a concrete
   answer per app.
5. **Host and port from the environment.** The panel injects no `PORT` and execs argv with no shell,
   so the app must read `HOST`/`PORT` from a `.env` (loaded with `--env-file` or by the framework)
   or from its own config file.
6. **Where uploads land**, so the backup advice is real: a database dump alone is never a backup.
7. **Migrations before the first start.** Payload's empty-database failure (200 with no tables) is
   the pattern to look for: does the app create its schema on boot in production, or does it need an
   explicit migration/bootstrap step first?
8. **Whether it wants to be at the root.** All four recipes use `serve_at_root=true`; an app that
   insists on a base path would need the proxy-path route instead, and the proxy strips the prefix.

Record the answers the way `ghost.md` and `payload.md` do — exact commands, exact
`persistent_app_create` arguments, exact traps — and only then move the app into the recipe table in
`../SKILL.md` with the date it was verified.
