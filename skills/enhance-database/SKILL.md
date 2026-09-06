---
name: enhance-database
description: Create and manage MySQL or PostgreSQL databases and users on an Enhance-hosted website, and wire them into an app. Use when the user says "create a database", "add a db user", "set up MySQL for my app", "import this SQL", or asks for a phpMyAdmin login.
---

# Enhance database management

Read `../enhance-connect/references/safety-rules.md` first; it applies to everything below. If no
enhance tools are available or `auth_status` fails, run the `enhance-connect` skill.

## 1. Preconditions (check before you promise anything)

Call `website_get` and read the `canUse` block:

- **MySQL**: `mysqlKind` is present (e.g. `mariaDbLts`) → the `db_*` tools work.
- **PostgreSQL**: `canUse.postgresql` must be `true`. When it is false the `pg_*` tools refuse
  without sending anything and say so; tell the user PostgreSQL is not on their plan and offer
  MySQL instead. Do not look for a workaround (safety rule 4).
- Databases live under the website's unix user. A website with no `unixUser` has no databases at
  all, and the tools fail loudly rather than guess.

`db_list` and `db_users_list` (or `pg_db_list` / `pg_users_list`) show what already exists. Read
them before creating anything, so you do not add a second database for an app that has one.

## 2. Naming: the panel adds a prefix

The panel prefixes every database and every database user with the site's unix user:
`demo` is stored as `vahi_dev1_demo`. The tools accept **either** the short name the user typed
**or** the full prefixed form, and always return the full one.

**Always use the full returned name** in connection strings, app config, grants and SQL. A short
name in a `.env` file will not connect.

## 3. Connect from an app (critical, verified live)

The database host is always **`localhost`** — the unix socket. `127.0.0.1` is refused
(`Connection refused`), and so is the `dbServerIps` value. This was verified live from a PHP page
in the container against MariaDB.

```
DB_HOST=localhost          # never 127.0.0.1, never an IP
DB_DATABASE=<full db name from db_create>
DB_USERNAME=<full user name from db_user_create>
DB_PASSWORD=<the password shown once>
```

## 4. A new database for an app, in this order

1. `db_create website=<site> name=<db>` → note the **full** database name it returns.
2. `db_user_create website=<site> username=<user>` → a strong password is generated and returned
   **once**, in `structuredContent.password`. Capture it now; it is never shown again (safety
   rule 10). Pass `password=` yourself only if the user insists on a specific one.
3. `db_user_set_privileges website=<site> username=<user> database=<db> grants=["all"]`.
4. Write the app config (`.env`, `wp-config.php`, `config/database.php`) with `DB_HOST=localhost`,
   the full database name, the full user name and that password. Never commit it, never repeat
   the password in later messages.

To rotate a password later: `db_user_update` (every app on the old password stops connecting
until you update its config).

## 5. Privileges are an enum, not SQL

`db_user_set_privileges` takes the panel's fixed **lowercase** set, never SQL text.
`"ALL PRIVILEGES"` is a 400.

```
all, alter, alterRoutine, create, createRoutine, createTablespace, createTemporaryTables,
createView, delete, drop, event, execute, index, insert, lockTables, references, select,
showView, trigger, update
```

`grants=["all"]` is right for a typical app user. The call **replaces** whatever grants that user
had on that one database; other databases are untouched.

## 6. Access hosts: add and remove, never replace

A new MySQL user already has the app tier's host (`10.169.0.1`) in `accessHosts` — that is where
this website's own PHP connects from.

- `db_user_access_hosts_add website=<site> username=<user> hosts=[...]` **adds** to the list.
- `db_user_access_hosts_remove` removes exactly the hosts listed, leaving the rest.
- **Never remove the default app-tier host.** Doing so locks the site's own application out of
  its database until it is added back. Read `db_users_list` before touching the list.

Only add a host when something outside the container connects (and say plainly that opening a
database to the internet is a risk the user is taking on).

## 7. Backups: export before every destructive change

`db_export_sql website=<site> name=<db>` makes the panel write a gzipped dump —
`sql_backup_<db>_<date>.sql.gz` — into the website's **home** directory (mode 0600, outside the
docroot) and returns its `path` plus a ready-made `scp` command. The response body is the
filename, not the dump; nothing is downloaded until you run that command.

- Fetching it needs SSH, so safety rule 7 applies: Claude Code's Bash sandbox cannot open SSH
  connections. Run `scp` with the sandbox disabled, or with `scp` in `sandbox.excludedCommands`,
  and say which one you are doing before you run it.
- Old backups stay in the home directory and add up. Offer to remove the ones the user no longer
  wants, over SSH.
- PostgreSQL has no export tool: take a dump over SSH with `pg_dump` before a `pg_db_delete`.

## 8. Import: destructive, always back up first

`db_import_sql website=<site> name=<db> sql=<text>` runs arbitrary SQL against the database. A
`DROP TABLE` or `TRUNCATE` in that file destroys data the panel cannot restore. It prompts the
user to type the full database name; export first with `db_export_sql`. `force=true` keeps going
after a failing statement — only when the user asks for it.

## 9. phpMyAdmin

`db_phpmyadmin_url website=<site>` (optionally `name=<db>` to open one database) returns a
**single-use sign-on URL that logs straight in**. Treat it like a password: hand it to the user in
the chat and nowhere else — never write it to a file, a commit, an issue or a log.

The first SSO call makes the panel create a MySQL user `<unixUser>_phpma` with no grants. That is
the panel's own phpMyAdmin login; leave it alone, do not delete it and do not report it as a
stray account.

## 10. Destructive tools

These prompt the user to type the exact name and must never be auto-approved or added to an
always-allow permission rule (safety rules 1 and 9). Never type the name yourself.

| Tool | What it destroys |
|---|---|
| `db_delete` | a MySQL database and every table in it; no soft delete |
| `db_user_delete` | a MySQL login; every app using it fails at once |
| `db_import_sql` | whatever the SQL touches |
| `pg_db_delete` | a PostgreSQL database and every table in it |
| `pg_user_delete` | a PostgreSQL login |
| `pg_user_revoke` | a user's access to one PostgreSQL database |
| `cron_delete` | the website's whole crontab (see the deploy skill) |

`db_user_access_hosts_remove` and `cron_remove` are not in this list because they are reversible,
but both can take an app offline. Say what you are about to remove before you call them.

## 11. PostgreSQL

Same flow, `pg_*` names, only when `canUse.postgresql` is true:

1. `pg_db_create` → full name.
2. `pg_user_create` → password shown once.
3. `pg_user_grant website=<site> username=<user> database=<db>`.

PostgreSQL has no per-privilege enum: the grant is all-or-nothing, and `pg_user_revoke` (a
destructive tool) takes it away. `pg_db_list`, `pg_users_list` and `pg_user_update` mirror their
MySQL counterparts. There is no PostgreSQL import, export or phpMyAdmin equivalent — use `psql`
and `pg_dump` over SSH.

## Report back

Say which website, the **full** database and user names, that the app connects on `localhost`,
where the config was written, and whether a backup exists. Do not repeat the password.
