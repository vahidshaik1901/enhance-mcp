# Milestone B: PHP and databases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add customer-tier PHP configuration and MySQL/PostgreSQL database management to the Enhance MCP, plus an `enhance-database` skill and a live PHP+MySQL deploy test, all on the milestone A foundation.

**Architecture:** New tool groups (`tools/php.ts`, `tools/mysql.ts`, `tools/postgres.ts`, `tools/cron.ts`) follow the milestone A `defineTool` contract exactly: each response opens with the identity block, panel strings pass through `safe()`, destructive tools (`db_delete`, `db_user_delete`, `db_import_sql`, `pg_db_delete`, `pg_user_delete`, `pg_user_revoke`, `cron_delete`) declare `target()`+`preview()` and go through the confirmation gate. A shared `dbName`/`dbUser` helper resolves the `<unixUser>_` prefix the panel adds. The `enhance-database` skill and PHP-aware additions to `enhance-deploy` teach Claude the flow. A new opt-in live e2e file exercises a real database round trip.

**Tech Stack:** TypeScript, `@modelcontextprotocol/server` 2.0.0, `openapi-fetch` over the vendored spec types, zod 4 (`zod/v4`), vitest 4. No new dependencies.

## Global Constraints

- Language TypeScript, Node >= 20, ESM. Official `@modelcontextprotocol/*` 2.0.0 SDK. zod imported from `zod/v4`. No new runtime dependencies.
- Every tool is created with `defineTool` from `src/core/registry.ts` and added to a group array re-exported through `src/tools/index.ts`.
- Every tool response begins with `identityBlock(...)` (convention 3). Any interpolated panel string passes through `safe()` (convention 8); free text rendered in `kv`/`table` cells is already collapsed by `cell()`.
- Non-destructive tool tests call `callTool(byName(tools, name), args, ctx)` (convention 1); destructive-tool tests drive `target()`, then `preview()`, then `handler(args, ctx, target)` directly.
- Destructive tools (`risk: 'destructive'`) MUST define `target()` and `preview()`; `preview()` uses the handed target, never re-resolves by name (convention 12). Their names go in the never-exposed guard's allowlist of the MCP test only if intentionally destructive; `db_delete`, `db_user_delete`, `pg_db_delete`, `pg_user_delete`, `pg_user_revoke`, `db_import_sql`, `cron_delete` are the milestone B destructive set.
- MySQL and PostgreSQL database and user names are auto-prefixed by the panel with `<unixUser>_`. Tools accept either the short or the full name and always display and return the full name. `db_create` takes the short name.
- Generated database credentials in any app config use `DB_HOST=localhost` (the unix socket); never `127.0.0.1` or a `dbServerIps` value (verified 2026-09-05: `127.0.0.1` is refused).
- MySQL privilege grants use the lowercase enum (`all, alter, alterRoutine, create, createRoutine, createTablespace, createTemporaryTables, createView, delete, drop, event, execute, index, insert, lockTables, references, select, showView, trigger, update`), never SQL text like `ALL PRIVILEGES`.
- PostgreSQL tools gate on `canUse.postgresql`; when false they return a clear "not available on this plan" message without calling the API.
- Secrets: a generated database password is shown to the user once in the tool result and returned in `structuredContent`; it is redacted in the audit log (the audit `redact()` already covers `password`). Never write a password into a file on the user's machine without the user asking.
- Tests: unit (fake panel), MCP in-memory, and opt-in live e2e. `npm run typecheck`, `npm test`, `npm run build` all clean before each commit.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01TxsHEDfwqXQ4iRBtYhZrhN
  ```

## Design decisions (spec tool names -> real endpoints)

The spec's milestone B tool list predates the live probe. These bindings are fixed (see `docs/research.md`, "Live probe: milestone B and C endpoints"):

| Spec name | This plan | Endpoint |
|---|---|---|
| `php_extensions_get` | `php_extensions_list` | `GET /websites/{id}/php_extensions` + available + built_in |
| `php_extension_enable/disable` | same | `POST`/`DELETE /websites/{id}/php_extensions` (bare-string body) |
| `php_ini_get/set` | `php_settings_get/set` | `GET/PUT /websites/{id}/lsphp_settings` (`lsapiChildren` only) |
| `php_error_log` | `php_error_log` | `GET /websites/{id}/php_error_log` |
| `redis_get/set` | `redis_state_get/set` | `GET/PUT /v2/websites/{id}/redis` (boolean) |
| `cache_clear` | `cache_clear` | `DELETE /v2/domains/{id}/nginx_fastcgi` + `website_restart_php` |
| `htaccess_rewrites_get/update` | `htaccess_rewrites_get/set` | `GET/PATCH /orgs/{org}/websites/{id}/htaccess` |
| `ip_rules_get/set` | `ip_rules_get/set` | `GET/PUT /orgs/{org}/websites/{id}/htaccess/ips` |
| `db_*` (MySQL) | `db_*` | `/orgs/{org}/websites/{id}/mysql-dbs`, `.../mysql-users`, privileges, access-hosts, sql, sso |
| `pg_*` (PostgreSQL) | `pg_*` | `/orgs/{org}/websites/{id}/postgresql-dbs`, `.../postgresql-users`, privileges |
| `cron_*` | `cron_*` | `/orgs/{org}/websites/{id}/crontab`, `/websites/{id}/container_cron_enabled` |

There is no generic php.ini editor at customer tier; `php_settings_*` exposes `lsapiChildren` only, and the tool says so. PostgreSQL is off on the test plan (`canUse.postgresql=false`), so its live e2e is skipped with a note; unit and MCP tests still cover it.

## File Structure

- `server/src/tools/dbcommon.ts` (new) - shared helpers: `resolveDbName`, `resolveDbUser`, `MYSQL_GRANTS`, `websiteArg`, `siteWebsite(ctx, ref)`; one responsibility: database naming and website resolution shared by mysql/postgres tools.
- `server/src/tools/mysql.ts` (new) - MySQL db + user + privilege + access-host + sql + phpMyAdmin tools.
- `server/src/tools/postgres.ts` (new) - PostgreSQL db + user + privilege tools, all `canUse.postgresql` gated.
- `server/src/tools/php.ts` (new) - extensions, lsphp settings, error log, redis state, cache clear, htaccess rewrites, IP rules.
- `server/src/tools/cron.ts` (new) - crontab get/set/delete, container cron toggle.
- `server/src/tools/index.ts` (modify) - register the new groups in `allTools`.
- `server/test/unit/tools-mysql.test.ts`, `tools-postgres.test.ts`, `tools-php.test.ts`, `tools-cron.test.ts` (new).
- `server/test/mcp/server.test.ts` (modify) - extend the parameterised destructive-gate test with the new destructive tools; extend the never-exposed guard.
- `server/test/fixtures/panel.ts` (modify) - add mysql/postgres/cron/php fixtures.
- `server/test/e2e/milestone-b.e2e.test.ts` (new) - opt-in live database round trip.
- `skills/enhance-database/SKILL.md` (new) + `skills/enhance-deploy/SKILL.md` (modify) - PHP/Laravel build and post-deploy steps, `localhost` DB host rule, Node proxy-on-primary note.
- `.claude-plugin/plugin.json`, `README.md`, `CLAUDE.md` (modify) - tool count, status.

Also fold these deferred milestone A minors (from `.superpowers/sdd/progress.md`) where the touched file is already open:
- `client.ts:88` org-mismatch message: wrap `orgName` in `safe()` (Task 1 touches the client).
- Extend `respond.ts` collapse class with `U+061C, U+202F, U+00AD, U+180E, U+FFF9-U+FFFB` and tag chars `U+E0000-U+E007F` (Task 1).
- Never-exposed guard: add `mysql`/`postgres` are NOT forbidden, but confirm the regex still excludes only platform/org/token/member forms (Task in MCP test).

---

### Task 1: Database naming helpers and shared plumbing

**Files:**
- Create: `server/src/tools/dbcommon.ts`
- Modify: `server/src/core/registry.ts` (extend `Target.kind`)
- Modify: `server/src/client/client.ts:88` (fold minor: `safe()` on the org-mismatch message)
- Modify: `server/src/core/respond.ts` (fold minor: extend the collapse class)
- Test: `server/test/unit/tools-dbcommon.test.ts`

**Interfaces:**
- Consumes: `ToolContext`, `Resolver.resolveWebsite`, `requireOrg`, `Website` (from milestone A).
- Produces:
  - `websiteArg: z.ZodString` - the standard website reference field.
  - `siteWebsite(ctx: ToolContext, ref: string): Promise<{ org: string; w: Website }>`.
  - `resolveDbName(unixUser: string, input: string): string` - returns the full `<unixUser>_<name>` form, accepting either the short or the already-prefixed name.
  - `resolveDbUser(unixUser: string, input: string): string` - same rule for users.
  - `MYSQL_GRANTS: readonly string[]` - the lowercase grant enum.
  - `Target.kind` gains `'mysql_db' | 'mysql_user' | 'pg_db' | 'pg_user' | 'crontab'`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/unit/tools-dbcommon.test.ts
import { describe, expect, it } from 'vitest';
import { MYSQL_GRANTS, resolveDbName, resolveDbUser } from '../../src/tools/dbcommon.js';

describe('resolveDbName', () => {
  it('prefixes a short name with the unix user', () => {
    expect(resolveDbName('vahi_dev1', 'demo')).toBe('vahi_dev1_demo');
  });
  it('passes an already-prefixed name through unchanged', () => {
    expect(resolveDbName('vahi_dev1', 'vahi_dev1_demo')).toBe('vahi_dev1_demo');
  });
  it('does not double-prefix a name that merely starts with a similar string', () => {
    // "vahi_dev10" is a different unix user prefix; treat as a short name.
    expect(resolveDbName('vahi_dev1', 'vahi_dev10things')).toBe('vahi_dev1_vahi_dev10things');
  });
  it('trims and rejects empty input', () => {
    expect(() => resolveDbName('vahi_dev1', '   ')).toThrow(/name/i);
  });
});

describe('resolveDbUser', () => {
  it('prefixes like resolveDbName', () => {
    expect(resolveDbUser('vahi_dev1', 'app')).toBe('vahi_dev1_app');
    expect(resolveDbUser('vahi_dev1', 'vahi_dev1_app')).toBe('vahi_dev1_app');
  });
});

describe('MYSQL_GRANTS', () => {
  it('is the lowercase enum, not SQL text', () => {
    expect(MYSQL_GRANTS).toContain('all');
    expect(MYSQL_GRANTS).toContain('select');
    expect(MYSQL_GRANTS).not.toContain('ALL PRIVILEGES');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/unit/tools-dbcommon.test.ts`
Expected: FAIL, `Cannot find module '../../src/tools/dbcommon.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/tools/dbcommon.ts
import * as z from 'zod/v4';
import { requireOrg, type ToolContext } from '../core/context.js';
import type { Website } from '../core/resolver.js';

export const websiteArg = z.string().min(1).describe('Website domain name (primary or alias) or website UUID');

/** The panel prefixes every database and database-user name with `<unixUser>_`. Accept either the
 *  short name the user types or the full prefixed name, and always return the full form. */
function prefixed(unixUser: string, input: string): string {
  const name = input.trim();
  if (name.length === 0) throw new Error('database name must not be empty');
  const prefix = `${unixUser}_`;
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

export function resolveDbName(unixUser: string, input: string): string {
  return prefixed(unixUser, input);
}

export function resolveDbUser(unixUser: string, input: string): string {
  return prefixed(unixUser, input);
}

export const MYSQL_GRANTS = [
  'all', 'alter', 'alterRoutine', 'create', 'createRoutine', 'createTablespace',
  'createTemporaryTables', 'createView', 'delete', 'drop', 'event', 'execute', 'index',
  'insert', 'lockTables', 'references', 'select', 'showView', 'trigger', 'update',
] as const;

export async function siteWebsite(ctx: ToolContext, ref: string): Promise<{ org: string; w: Website }> {
  const org = requireOrg(ctx.client);
  const w = await ctx.resolver.resolveWebsite(ref);
  return { org, w };
}
```

Extend the `Target` union in `server/src/core/registry.ts`:

```ts
export interface Target {
  kind: 'website' | 'domain' | 'ssh_key' | 'mysql_db' | 'mysql_user' | 'pg_db' | 'pg_user' | 'crontab';
  id: string;
  name: string;
}
```

Fold minor at `server/src/client/client.ts:88` - wrap the org name in `safe()` (import `safe` from `../core/respond.js` if not already imported):

```ts
// before: `...belongs to "${orgName}"...`
// after:
throw new ConfigError(`ENHANCE_ORG_ID is set to ${config.orgId} but the credential belongs to "${safe(orgName)}" (${resolvedOrgId}). Fix ENHANCE_ORG_ID.`);
```
(Keep the surrounding message text exactly as it is; only wrap the interpolated `orgName`.)

Fold minor in `server/src/core/respond.ts` - extend the control-character class used by `cell()`/`safe()` to also collapse `؜ ­᠎￹-￻` and tag characters `0-F`. Add them to the existing character class/regex; do not change its structure.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/unit/tools-dbcommon.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (the `Target` change compiles because all existing `kind` values are still members).

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/dbcommon.ts server/src/core/registry.ts server/src/client/client.ts server/src/core/respond.ts server/test/unit/tools-dbcommon.test.ts
git commit -m "feat(db): database naming helpers and shared plumbing"
```

---

### Task 2: MySQL databases

**Files:**
- Create: `server/src/tools/mysql.ts`
- Modify: `server/test/fixtures/panel.ts` (add mysql fixtures)
- Test: `server/test/unit/tools-mysql.test.ts`

**Interfaces:**
- Consumes: `websiteArg`, `siteWebsite`, `resolveDbName`, `MYSQL_GRANTS` (Task 1); `identityBlock`, `ok`, `fail`, `kv`, `table`, `safe`, `defineTool`, `ToolDef`.
- Produces: `mysqlDatabaseTools: ToolDef[]` (subset: `db_list`, `db_create`, `db_delete`, `db_export_sql`, `db_import_sql`, `db_phpmyadmin_url`). Task 3 adds the user tools to `mysql.ts` and both are exported together as `tools` at the end of Task 3.
  - `db_list(website)` -> databases with size and user count.
  - `db_create(website, name)` -> creates `<unixUser>_<name>`, returns the full name.
  - `db_delete(website, name)` DESTRUCTIVE.
  - `db_export_sql(website, name)` -> SQL dump as text.
  - `db_import_sql(website, name, sql, force?)` DESTRUCTIVE (overwrites).
  - `db_phpmyadmin_url(website, name?)` -> a single-use signon URL.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/unit/tools-mysql.test.ts
import { describe, expect, it } from 'vitest';
import { byName, callTool, makeContext } from '../helpers/context.js';
import { ORG_ID, WEBSITE_ID, base } from '../fixtures/panel.js';
import { tools } from '../../src/tools/mysql.js';

const dbs = { items: [{ name: 'vahi_dev1_demo', size: 40960, createdAt: '2026-09-05T15:00:34.000100Z', websiteId: WEBSITE_ID, userCount: 1 }] };

describe('db_list', () => {
  it('lists databases with the full name, size and user count', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/mysql-dbs`, body: dbs }]);
    const r = await callTool(byName(tools, 'db_list'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain('vahi_dev1_demo');
    expect(r.structured).toMatchObject({ total: 1 });
  });
});

describe('db_create', () => {
  it('sends the short name and reports the full prefixed name', async () => {
    let sent: string | undefined;
    const { ctx } = await makeContext([
      ...base(),
      { method: 'POST', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/mysql-dbs`, handler: async (req) => { sent = (await req.json()).name; return new Response(null, { status: 201 }); } },
    ]);
    const r = await callTool(byName(tools, 'db_create'), { website: 'vahi.dev', name: 'demo' }, ctx);
    expect(sent).toBe('demo');
    expect(r.structured).toMatchObject({ database: 'vahi_dev1_demo', created: true });
    expect(r.text).toContain('DB_HOST=localhost');
  });
});

describe('db_delete', () => {
  it('is destructive, previews by the full name, and deletes by it', async () => {
    let deleted: string | undefined;
    const { ctx } = await makeContext([
      ...base(),
      { method: 'DELETE', path: new RegExp(`/orgs/${ORG_ID}/websites/${WEBSITE_ID}/mysql-dbs/(.+)$`), handler: async (_req, url) => { deleted = decodeURIComponent(url.pathname.split('/').pop()!); return new Response(null, { status: 204 }); } },
    ]);
    const del = byName(tools, 'db_delete');
    const target = await del.target!({ website: 'vahi.dev', name: 'demo' }, ctx);
    expect(target).toMatchObject({ kind: 'mysql_db', name: 'vahi_dev1_demo' });
    const preview = await del.preview!({ website: 'vahi.dev', name: 'demo' }, ctx, target);
    expect(preview).toContain('vahi_dev1_demo');
    const r = await del.handler({ website: 'vahi.dev', name: 'demo' }, ctx, target);
    expect(deleted).toBe('vahi_dev1_demo');
    expect(r.structured).toMatchObject({ database: 'vahi_dev1_demo', deleted: true });
  });
});

describe('db_phpmyadmin_url', () => {
  it('returns the signon url', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/phpmyadmin`, body: 'https://phpmyadmin.example/signon.php?sess=abc' }]);
    const r = await callTool(byName(tools, 'db_phpmyadmin_url'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ url: 'https://phpmyadmin.example/signon.php?sess=abc' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/unit/tools-mysql.test.ts`
Expected: FAIL, `Cannot find module '../../src/tools/mysql.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/tools/mysql.ts
import * as z from 'zod/v4';
import { parseScalarText } from '../client/client.js';
import type { ToolContext } from '../core/context.js';
import { identityBlock } from '../core/identity.js';
import { defineTool, type ToolDef } from '../core/registry.js';
import { fail, kv, ok, safe, table } from '../core/respond.js';
import { MYSQL_GRANTS, resolveDbName, resolveDbUser, siteWebsite, websiteArg } from './dbcommon.js';

const nameArg = z.string().min(1).describe('Database name (short, or the full <unixUser>_ prefixed form)');

/** Every db tool needs the site (for the org, the unix user prefix and the identity block). */
async function dbSite(ctx: ToolContext, website: string): Promise<{ org: string; unixUser: string; id: string; identity: string }> {
  const { org, w } = await siteWebsite(ctx, website);
  return { org, unixUser: w.unixUser ?? '', id: w.id, identity: identityBlock({ name: ctx.client.orgName, id: org }, w) };
}

export const dbList = defineTool({
  name: 'db_list',
  tier: 'customer',
  risk: 'read',
  description: 'Lists the MySQL databases for a website, with size and how many users can access each. Database names are shown in full (the panel prefixes them with the unix user).',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await dbSite(ctx, website);
    const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/mysql-dbs', () => ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/mysql-dbs', { params: { path: { org_id: s.org, website_id: s.id } } }));
    const rows = (res.items ?? []).map((d) => ({ database: d.name, 'size (bytes)': d.size, users: d.userCount }));
    return ok([s.identity, `databases (${rows.length}):`, table(rows, ['database', 'size (bytes)', 'users'])].join('\n'), { total: rows.length, items: rows });
  },
});

export const dbCreate = defineTool({
  name: 'db_create',
  tier: 'customer',
  risk: 'write',
  description: 'Creates a MySQL database. The panel prefixes the name with the unix user, so "shop" becomes "<unixUser>_shop"; the full name is returned. Apps connect with host "localhost" (the unix socket), never 127.0.0.1.',
  input: z.object({ website: websiteArg, name: nameArg }),
  async handler({ website, name }, ctx) {
    const s = await dbSite(ctx, website);
    const full = resolveDbName(s.unixUser, name);
    const short = full.slice(s.unixUser.length + 1);
    await ctx.client.call('POST', '/orgs/{org_id}/websites/{website_id}/mysql-dbs', () => ctx.client.api.POST('/orgs/{org_id}/websites/{website_id}/mysql-dbs', { params: { path: { org_id: s.org, website_id: s.id } }, body: { name: short } }));
    ctx.resolver.invalidate();
    return ok([s.identity, `database ${safe(full)} created.`, kv([['connect from PHP', 'host DB_HOST=localhost, socket; not 127.0.0.1'], ['next', `db_user_create website=${safe(website)} to add a login, then db_user_set_privileges`]])].join('\n'), { database: full, created: true });
  },
});

export const dbDelete = defineTool({
  name: 'db_delete',
  tier: 'customer',
  risk: 'destructive',
  description: 'DESTRUCTIVE. Permanently drops a MySQL database and all its tables. Requires the user to confirm by typing the full database name. There is no soft delete for databases.',
  input: z.object({ website: websiteArg, name: nameArg }),
  async target({ website, name }, ctx) {
    const s = await dbSite(ctx, website);
    return { kind: 'mysql_db', id: `${s.id}:${resolveDbName(s.unixUser, name)}`, name: resolveDbName(s.unixUser, name) };
  },
  async preview({ website, name }, ctx, target) {
    const s = await dbSite(ctx, website);
    return `This will permanently drop MySQL database ${safe(target.name)} on ${safe(s.identity.split('\n')[0])}. Every table and row is destroyed and cannot be restored from the panel. Export first with db_export_sql if you need a backup.`;
  },
  async handler({ website }, ctx, target) {
    const s = await dbSite(ctx, website);
    const dbName = target!.name;
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}', () => ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}', { params: { path: { org_id: s.org, website_id: s.id, db_name: dbName } } }));
    ctx.resolver.invalidate();
    return ok(`${s.identity}\ndatabase ${safe(dbName)} dropped.`, { database: dbName, deleted: true });
  },
});

export const dbExportSql = defineTool({
  name: 'db_export_sql',
  tier: 'customer',
  risk: 'read',
  description: 'Returns a SQL dump of a MySQL database as text. Use it to back up before db_delete or db_import_sql, or to move a database.',
  input: z.object({ website: websiteArg, name: nameArg }),
  async handler({ website, name }, ctx) {
    const s = await dbSite(ctx, website);
    const full = resolveDbName(s.unixUser, name);
    const raw = await ctx.client.call<string>('GET', '/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}/sql', () => ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}/sql', { params: { path: { org_id: s.org, website_id: s.id, db_name: full } }, parseAs: 'text' }));
    const sql = parseScalarText(raw);
    return ok(`${s.identity}\nSQL export of ${safe(full)} (${sql.length} bytes) returned in structuredContent.sql.`, { database: full, bytes: sql.length, sql });
  },
});

export const dbImportSql = defineTool({
  name: 'db_import_sql',
  tier: 'customer',
  risk: 'destructive',
  description: 'DESTRUCTIVE. Runs a SQL file against a MySQL database, overwriting whatever the statements touch (DROP/CREATE/INSERT). Requires the user to confirm by typing the full database name. Export first with db_export_sql.',
  input: z.object({ website: websiteArg, name: nameArg, sql: z.string().min(1).describe('The SQL to execute'), force: z.boolean().default(false).describe('Pass through the panel force flag') }),
  async target({ website, name }, ctx) {
    const s = await dbSite(ctx, website);
    return { kind: 'mysql_db', id: `${s.id}:${resolveDbName(s.unixUser, name)}`, name: resolveDbName(s.unixUser, name) };
  },
  async preview({ website, name, sql }, ctx, target) {
    const s = await dbSite(ctx, website);
    return `This will run ${sql.length} bytes of SQL against MySQL database ${safe(target.name)} on ${safe(s.identity.split('\n')[0])}. Statements such as DROP TABLE and TRUNCATE destroy data and cannot be undone from the panel. Export first with db_export_sql.`;
  },
  async handler({ website, name, sql, force }, ctx, target) {
    const s = await dbSite(ctx, website);
    const full = target!.name;
    const form = new FormData();
    form.set('sql', new Blob([sql]), `${full}.sql`);
    await ctx.client.call('POST', '/v2/websites/{website_id}/mysql/{db_id}/sql', () => ctx.client.api.POST('/v2/websites/{website_id}/mysql/{db_id}/sql', { params: { path: { website_id: s.id, db_id: full }, query: force ? { force: true } : {} }, body: form as unknown as { sql: string } }));
    return ok(`${s.identity}\nran ${sql.length} bytes of SQL against ${safe(full)}.`, { database: full, imported: true, bytes: sql.length });
  },
});

export const dbPhpmyadminUrl = defineTool({
  name: 'db_phpmyadmin_url',
  tier: 'customer',
  risk: 'read',
  description: 'Returns a single-use phpMyAdmin sign-on URL for the website (or a specific database). The URL logs the user straight in; treat it like a password and do not post it anywhere.',
  input: z.object({ website: websiteArg, name: z.string().min(1).optional().describe('Optional database name to open directly') }),
  async handler({ website, name }, ctx) {
    const s = await dbSite(ctx, website);
    const raw = name
      ? await ctx.client.call<string>('GET', '/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}/sso', () => ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}/sso', { params: { path: { org_id: s.org, website_id: s.id, db_name: resolveDbName(s.unixUser, name) }, query: { shouldRedirect: false } }, parseAs: 'text' }))
      : await ctx.client.call<string>('GET', '/orgs/{org_id}/websites/{website_id}/phpmyadmin', () => ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/phpmyadmin', { params: { path: { org_id: s.org, website_id: s.id }, query: { shouldRedirect: false } }, parseAs: 'text' }));
    const url = parseScalarText(raw);
    return ok(`${s.identity}\nphpMyAdmin sign-on URL (single use, opens logged in) returned in structuredContent.url.`, { url });
  },
});
```

Add mysql fixtures and a `base()`-compatible route helper to `server/test/fixtures/panel.ts` if not present (a `mysqlDbs` object and reuse `base()`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/unit/tools-mysql.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/mysql.ts server/test/unit/tools-mysql.test.ts server/test/fixtures/panel.ts
git commit -m "feat(mysql): database list, create, delete, export, import, phpMyAdmin URL"
```

---

### Task 3: MySQL users, privileges and access hosts

**Files:**
- Modify: `server/src/tools/mysql.ts` (add user tools; export `tools`)
- Test: `server/test/unit/tools-mysql.test.ts` (add user cases)

**Interfaces:**
- Consumes: Task 2 helpers (`dbSite`, `resolveDbUser`, `resolveDbName`, `MYSQL_GRANTS`).
- Produces (appended to `mysql.ts`, all exported in a final `tools` array):
  - `db_users_list(website)`.
  - `db_user_create(website, username, password?)` -> creates `<unixUser>_<username>`; generates a strong password when none is given and shows it once.
  - `db_user_update(website, username, password)` -> sets a new password.
  - `db_user_delete(website, username)` DESTRUCTIVE.
  - `db_user_set_privileges(website, username, database, grants[])`.
  - `db_user_access_hosts_set(website, username, hosts[])`.
  - `export const tools: ToolDef[] = [dbList, dbCreate, dbDelete, dbExportSql, dbImportSql, dbPhpmyadminUrl, dbUsersList, dbUserCreate, dbUserUpdate, dbUserDelete, dbUserSetPrivileges, dbUserAccessHostsSet];`

- [ ] **Step 1: Write the failing test**

```ts
// append to server/test/unit/tools-mysql.test.ts
import { generateKeyPairSync } from 'node:crypto';

const users = { items: [{ username: 'vahi_dev1_app', accessHosts: ['10.169.0.1'], authPlugin: 'mysql_native_password', grants: { vahi_dev1_demo: ['all'] }, createdAt: '2026-09-05T15:00:35.000099999Z', isEphemeral: false }] };

describe('db_user_create', () => {
  it('generates a password when none is given and shows it once', async () => {
    let body: { username: string; password: string } | undefined;
    const { ctx } = await makeContext([
      ...base(),
      { method: 'POST', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/mysql-users`, handler: async (req) => { body = await req.json(); return new Response(null, { status: 201 }); } },
    ]);
    const r = await callTool(byName(tools, 'db_user_create'), { website: 'vahi.dev', username: 'app' }, ctx);
    expect(body!.username).toBe('app');
    expect(body!.password.length).toBeGreaterThanOrEqual(20);
    expect(r.structured).toMatchObject({ user: 'vahi_dev1_app', password: body!.password });
    expect(r.text).toContain('DB_HOST=localhost');
    expect(r.text).toContain('shown once');
  });
});

describe('db_user_set_privileges', () => {
  it('sends the lowercase grant enum with the full db name', async () => {
    let body: { dbName: string; grants: string[] } | undefined;
    const { ctx } = await makeContext([
      ...base(),
      { method: 'PUT', path: new RegExp(`/orgs/${ORG_ID}/websites/${WEBSITE_ID}/mysql-users/(.+)/privileges$`), handler: async (req) => { body = await req.json(); return new Response(null, { status: 201 }); } },
    ]);
    const r = await callTool(byName(tools, 'db_user_set_privileges'), { website: 'vahi.dev', username: 'app', database: 'demo', grants: ['all'] }, ctx);
    expect(body).toMatchObject({ dbName: 'vahi_dev1_demo', grants: ['all'] });
    expect(r.structured).toMatchObject({ user: 'vahi_dev1_app', database: 'vahi_dev1_demo', grants: ['all'] });
  });
  it('rejects a grant outside the enum before calling the panel', async () => {
    const { ctx, f } = await makeContext([...base()]);
    await expect(callTool(byName(tools, 'db_user_set_privileges'), { website: 'vahi.dev', username: 'app', database: 'demo', grants: ['ALL PRIVILEGES'] }, ctx)).rejects.toThrow();
    expect(f.calls.some((c) => c.path.includes('/privileges'))).toBe(false);
  });
});

describe('db_user_delete', () => {
  it('is destructive and deletes by the full user name', async () => {
    let deleted: string | undefined;
    const { ctx } = await makeContext([
      ...base(),
      { method: 'DELETE', path: new RegExp(`/orgs/${ORG_ID}/websites/${WEBSITE_ID}/mysql-users/(.+)$`), handler: async (_req, url) => { deleted = decodeURIComponent(url.pathname.split('/').pop()!); return new Response(null, { status: 204 }); } },
    ]);
    const del = byName(tools, 'db_user_delete');
    const target = await del.target!({ website: 'vahi.dev', username: 'app' }, ctx);
    expect(target).toMatchObject({ kind: 'mysql_user', name: 'vahi_dev1_app' });
    await del.preview!({ website: 'vahi.dev', username: 'app' }, ctx, target);
    await del.handler({ website: 'vahi.dev', username: 'app' }, ctx, target);
    expect(deleted).toBe('vahi_dev1_app');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/unit/tools-mysql.test.ts -t db_user`
Expected: FAIL, `no tool db_user_create`.

- [ ] **Step 3: Write the implementation (append to `server/src/tools/mysql.ts`)**

```ts
import { randomBytes } from 'node:crypto';

const userArg = z.string().min(1).describe('Database user name (short, or the full <unixUser>_ prefixed form)');

/** A strong password with mixed classes; 24 URL-safe bytes plus guaranteed symbol/digit/case. */
function generatePassword(): string {
  const body = randomBytes(18).toString('base64').replace(/[+/=]/g, '');
  return `Db${body}9!`;
}

export const dbUsersList = defineTool({
  name: 'db_users_list',
  tier: 'customer',
  risk: 'read',
  description: 'Lists MySQL users for a website, with the hosts each may connect from and the databases they can access.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await dbSite(ctx, website);
    const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/mysql-users', () => ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/mysql-users', { params: { path: { org_id: s.org, website_id: s.id } } }));
    const rows = (res.items ?? []).map((u) => ({ user: u.username, 'access hosts': (u.accessHosts ?? []).join(', ') || 'none', databases: Object.keys(u.grants ?? {}).join(', ') || 'none', auth: u.authPlugin }));
    return ok([s.identity, `users (${rows.length}):`, table(rows, ['user', 'access hosts', 'databases', 'auth'])].join('\n'), { total: rows.length, items: rows });
  },
});

export const dbUserCreate = defineTool({
  name: 'db_user_create',
  tier: 'customer',
  risk: 'write',
  description: 'Creates a MySQL user. The panel prefixes the name with the unix user. When no password is given a strong one is generated and shown once. Apps connect with host "localhost".',
  input: z.object({ website: websiteArg, username: userArg, password: z.string().min(8).optional().describe('Optional; a strong password is generated when omitted') }),
  async handler({ website, username, password }, ctx) {
    const s = await dbSite(ctx, website);
    const full = resolveDbUser(s.unixUser, username);
    const short = full.slice(s.unixUser.length + 1);
    const pw = password ?? generatePassword();
    await ctx.client.call('POST', '/orgs/{org_id}/websites/{website_id}/mysql-users', () => ctx.client.api.POST('/orgs/{org_id}/websites/{website_id}/mysql-users', { params: { path: { org_id: s.org, website_id: s.id } }, body: { username: short, password: pw } }));
    ctx.resolver.invalidate();
    return ok([s.identity, `MySQL user ${safe(full)} created.`, kv([['password', 'shown once, in structuredContent.password; store it now'], ['connect from PHP', 'host DB_HOST=localhost'], ['next', `db_user_set_privileges website=${safe(website)} username=${safe(short)} database=<db> grants=all`]])].join('\n'), { user: full, password: pw });
  },
});

export const dbUserUpdate = defineTool({
  name: 'db_user_update',
  tier: 'customer',
  risk: 'write',
  description: "Sets a MySQL user's password. The new password is shown once.",
  input: z.object({ website: websiteArg, username: userArg, password: z.string().min(8) }),
  async handler({ website, username, password }, ctx) {
    const s = await dbSite(ctx, website);
    const full = resolveDbUser(s.unixUser, username);
    await ctx.client.call('PUT', '/orgs/{org_id}/websites/{website_id}/mysql-users/{username}', () => ctx.client.api.PUT('/orgs/{org_id}/websites/{website_id}/mysql-users/{username}', { params: { path: { org_id: s.org, website_id: s.id, username: full } }, body: { password } }));
    return ok(`${s.identity}\npassword for ${safe(full)} updated (shown once in structuredContent.password).`, { user: full, password });
  },
});

export const dbUserDelete = defineTool({
  name: 'db_user_delete',
  tier: 'customer',
  risk: 'destructive',
  description: 'DESTRUCTIVE. Deletes a MySQL user. Any app using this login stops working. Requires the user to confirm by typing the full user name.',
  input: z.object({ website: websiteArg, username: userArg }),
  async target({ website, username }, ctx) {
    const s = await dbSite(ctx, website);
    return { kind: 'mysql_user', id: `${s.id}:${resolveDbUser(s.unixUser, username)}`, name: resolveDbUser(s.unixUser, username) };
  },
  async preview({ website }, ctx, target) {
    const s = await dbSite(ctx, website);
    return `This will delete MySQL user ${safe(target.name)} on ${safe(s.identity.split('\n')[0])}. Any application or connection string using this login will fail immediately. The databases themselves are not touched.`;
  },
  async handler({ website }, ctx, target) {
    const s = await dbSite(ctx, website);
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/mysql-users/{username}', () => ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/mysql-users/{username}', { params: { path: { org_id: s.org, website_id: s.id, username: target!.name } } }));
    return ok(`${s.identity}\nMySQL user ${safe(target!.name)} deleted.`, { user: target!.name, deleted: true });
  },
});

export const dbUserSetPrivileges = defineTool({
  name: 'db_user_set_privileges',
  tier: 'customer',
  risk: 'write',
  description: "Sets a MySQL user's privileges on one database. Grants are chosen from the fixed set (all, select, insert, update, delete, create, drop, alter, index, references, ...); use 'all' for a typical app user. This replaces the user's grants on that database.",
  input: z.object({ website: websiteArg, username: userArg, database: z.string().min(1), grants: z.array(z.enum(MYSQL_GRANTS)).min(1) }),
  async handler({ website, username, database, grants }, ctx) {
    const s = await dbSite(ctx, website);
    const user = resolveDbUser(s.unixUser, username);
    const db = resolveDbName(s.unixUser, database);
    await ctx.client.call('PUT', '/orgs/{org_id}/websites/{website_id}/mysql-users/{username}/privileges', () => ctx.client.api.PUT('/orgs/{org_id}/websites/{website_id}/mysql-users/{username}/privileges', { params: { path: { org_id: s.org, website_id: s.id, username: user } }, body: { dbName: db, grants } }));
    return ok(`${s.identity}\n${safe(user)} now has [${grants.map(safe).join(', ')}] on ${safe(db)}.`, { user, database: db, grants });
  },
});

export const dbUserAccessHostsSet = defineTool({
  name: 'db_user_access_hosts_set',
  tier: 'customer',
  risk: 'write',
  description: "Sets the hosts a MySQL user may connect from (replaces the list). The default host is the app tier; only change this if the user connects from elsewhere.",
  input: z.object({ website: websiteArg, username: userArg, hosts: z.array(z.string().min(1)).min(1) }),
  async handler({ website, username, hosts }, ctx) {
    const s = await dbSite(ctx, website);
    const user = resolveDbUser(s.unixUser, username);
    await ctx.client.call('POST', '/orgs/{org_id}/websites/{website_id}/mysql-users/{username}/access-hosts', () => ctx.client.api.POST('/orgs/{org_id}/websites/{website_id}/mysql-users/{username}/access-hosts', { params: { path: { org_id: s.org, website_id: s.id, username: user } }, body: { accessHosts: hosts } }));
    return ok(`${s.identity}\naccess hosts for ${safe(user)} set to [${hosts.map(safe).join(', ')}].`, { user, accessHosts: hosts });
  },
});

export const tools: ToolDef[] = [dbList, dbCreate, dbDelete, dbExportSql, dbImportSql, dbPhpmyadminUrl, dbUsersList, dbUserCreate, dbUserUpdate, dbUserDelete, dbUserSetPrivileges, dbUserAccessHostsSet];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/unit/tools-mysql.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/mysql.ts server/test/unit/tools-mysql.test.ts
git commit -m "feat(mysql): users, privileges and access hosts"
```

---

### Task 4: PostgreSQL databases and users

**Files:**
- Create: `server/src/tools/postgres.ts`
- Test: `server/test/unit/tools-postgres.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers; `Website.canUse.postgresql`.
- Produces `tools: ToolDef[]`: `pg_db_list`, `pg_db_create`, `pg_db_delete` (D), `pg_users_list`, `pg_user_create`, `pg_user_update`, `pg_user_delete` (D), `pg_user_grant`, `pg_user_revoke` (D). Every tool first checks `canUse.postgresql` and returns a clear unavailable message when false.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/unit/tools-postgres.test.ts
import { describe, expect, it } from 'vitest';
import { byName, callTool, makeContext } from '../helpers/context.js';
import { ORG_ID, WEBSITE_ID, base, websiteDetail } from '../fixtures/panel.js';
import { tools } from '../../src/tools/postgres.js';

// vahi.dev has postgresql: false. A site with it enabled for the enabled-path tests.
function pgBase() {
  const pgSite = { ...websiteDetail, canUse: { ...websiteDetail.canUse, postgresql: true } };
  return [
    { method: 'GET' as const, path: '/login/memberships', body: undefined },
  ];
}

describe('pg gating', () => {
  it('reports unavailable and does not call the API when canUse.postgresql is false', async () => {
    const { ctx, f } = await makeContext([...base()]); // websiteDetail has postgresql:false
    const r = await callTool(byName(tools, 'pg_db_list'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/postgresql.*not available/i);
    expect(f.calls.some((c) => c.path.includes('postgresql-dbs'))).toBe(false);
  });
});

describe('pg_db_create (enabled site)', () => {
  it('creates and reports the full name when postgresql is enabled', async () => {
    const enabled = { ...websiteDetail, canUse: { ...websiteDetail.canUse, postgresql: true } };
    let sent: string | undefined;
    const { ctx } = await makeContext([
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: enabled },
      { method: 'POST', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/postgresql-dbs`, handler: async (req) => { sent = (await req.json()).name; return new Response(null, { status: 201 }); } },
    ]);
    const r = await callTool(byName(tools, 'pg_db_create'), { website: WEBSITE_ID, name: 'shop' }, ctx);
    expect(sent).toBe('shop');
    expect(r.structured).toMatchObject({ database: 'vahi_dev1_shop', created: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/unit/tools-postgres.test.ts`
Expected: FAIL, `Cannot find module '../../src/tools/postgres.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/tools/postgres.ts
import * as z from 'zod/v4';
import { randomBytes } from 'node:crypto';
import type { ToolContext } from '../core/context.js';
import { identityBlock } from '../core/identity.js';
import { defineTool, type ToolDef } from '../core/registry.js';
import { fail, kv, ok, safe, table } from '../core/respond.js';
import { resolveDbName, resolveDbUser, siteWebsite, websiteArg } from './dbcommon.js';

const nameArg = z.string().min(1).describe('Database name (short, or the full <unixUser>_ prefixed form)');
const userArg = z.string().min(1).describe('Database user name (short, or the full prefixed form)');

function generatePassword(): string {
  return `Pg${randomBytes(18).toString('base64').replace(/[+/=]/g, '')}9!`;
}

/** Returns the site, or an error ToolResult when PostgreSQL is not on this plan. */
async function pgSite(ctx: ToolContext, website: string): Promise<{ ok: true; org: string; unixUser: string; id: string; identity: string } | { ok: false; result: ReturnType<typeof fail> }> {
  const { org, w } = await siteWebsite(ctx, website);
  const identity = identityBlock({ name: ctx.client.orgName, id: org }, w);
  if (w.canUse?.postgresql !== true) {
    return { ok: false, result: fail(`${identity}\nPostgreSQL is not available on this website's plan (canUse.postgresql is false). Ask the hosting provider to enable it, or use MySQL (db_* tools).`, { available: false }) };
  }
  return { ok: true, org, unixUser: w.unixUser ?? '', id: w.id, identity };
}

export const pgDbList = defineTool({
  name: 'pg_db_list', tier: 'customer', risk: 'read',
  description: 'Lists the PostgreSQL databases for a website. Requires PostgreSQL to be enabled on the plan.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await pgSite(ctx, website); if (!s.ok) return s.result;
    const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/postgresql-dbs', () => ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/postgresql-dbs', { params: { path: { org_id: s.org, website_id: s.id } } }));
    const rows = (res.items ?? []).map((d) => ({ database: d.name, 'size (bytes)': d.size, users: d.userCount }));
    return ok([s.identity, `postgresql databases (${rows.length}):`, table(rows, ['database', 'size (bytes)', 'users'])].join('\n'), { total: rows.length, items: rows });
  },
});

export const pgDbCreate = defineTool({
  name: 'pg_db_create', tier: 'customer', risk: 'write',
  description: 'Creates a PostgreSQL database. The panel prefixes the name with the unix user; the full name is returned. Apps connect with host "localhost".',
  input: z.object({ website: websiteArg, name: nameArg }),
  async handler({ website, name }, ctx) {
    const s = await pgSite(ctx, website); if (!s.ok) return s.result;
    const full = resolveDbName(s.unixUser, name); const short = full.slice(s.unixUser.length + 1);
    await ctx.client.call('POST', '/orgs/{org_id}/websites/{website_id}/postgresql-dbs', () => ctx.client.api.POST('/orgs/{org_id}/websites/{website_id}/postgresql-dbs', { params: { path: { org_id: s.org, website_id: s.id } }, body: { name: short } }));
    ctx.resolver.invalidate();
    return ok(`${s.identity}\nPostgreSQL database ${safe(full)} created. Apps connect with host localhost.`, { database: full, created: true });
  },
});

export const pgDbDelete = defineTool({
  name: 'pg_db_delete', tier: 'customer', risk: 'destructive',
  description: 'DESTRUCTIVE. Permanently drops a PostgreSQL database. Requires the user to confirm by typing the full database name.',
  input: z.object({ website: websiteArg, name: nameArg }),
  async target({ website, name }, ctx) {
    const s = await pgSite(ctx, website); if (!s.ok) throw new Error('PostgreSQL is not available on this plan.');
    return { kind: 'pg_db', id: `${s.id}:${resolveDbName(s.unixUser, name)}`, name: resolveDbName(s.unixUser, name) };
  },
  async preview({ website }, ctx, target) {
    const s = await pgSite(ctx, website); const head = s.ok ? s.identity.split('\n')[0] : 'this website';
    return `This will permanently drop PostgreSQL database ${safe(target.name)} on ${safe(head)}. Every table and row is destroyed and cannot be restored from the panel.`;
  },
  async handler({ website }, ctx, target) {
    const s = await pgSite(ctx, website); if (!s.ok) return s.result;
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/postgresql-dbs/{db_name}', () => ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/postgresql-dbs/{db_name}', { params: { path: { org_id: s.org, website_id: s.id, db_name: target!.name } } }));
    ctx.resolver.invalidate();
    return ok(`${s.identity}\nPostgreSQL database ${safe(target!.name)} dropped.`, { database: target!.name, deleted: true });
  },
});

export const pgUsersList = defineTool({
  name: 'pg_users_list', tier: 'customer', risk: 'read',
  description: 'Lists PostgreSQL users for a website and the databases each may access.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await pgSite(ctx, website); if (!s.ok) return s.result;
    const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/postgresql-users', () => ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/postgresql-users', { params: { path: { org_id: s.org, website_id: s.id } } }));
    const rows = (res.items ?? []).map((u) => ({ user: u.username, databases: (u.privs ?? []).join(', ') || 'none' }));
    return ok([s.identity, `postgresql users (${rows.length}):`, table(rows, ['user', 'databases'])].join('\n'), { total: rows.length, items: rows });
  },
});

export const pgUserCreate = defineTool({
  name: 'pg_user_create', tier: 'customer', risk: 'write',
  description: 'Creates a PostgreSQL user. A strong password is generated when none is given and shown once. Apps connect with host "localhost".',
  input: z.object({ website: websiteArg, username: userArg, password: z.string().min(8).optional() }),
  async handler({ website, username, password }, ctx) {
    const s = await pgSite(ctx, website); if (!s.ok) return s.result;
    const full = resolveDbUser(s.unixUser, username); const short = full.slice(s.unixUser.length + 1);
    const pw = password ?? generatePassword();
    await ctx.client.call('POST', '/orgs/{org_id}/websites/{website_id}/postgresql-users', () => ctx.client.api.POST('/orgs/{org_id}/websites/{website_id}/postgresql-users', { params: { path: { org_id: s.org, website_id: s.id } }, body: { username: short, password: pw } }));
    ctx.resolver.invalidate();
    return ok([s.identity, `PostgreSQL user ${safe(full)} created.`, kv([['password', 'shown once, in structuredContent.password'], ['connect from PHP', 'host DB_HOST=localhost']])].join('\n'), { user: full, password: pw });
  },
});

export const pgUserUpdate = defineTool({
  name: 'pg_user_update', tier: 'customer', risk: 'write',
  description: "Sets a PostgreSQL user's password (shown once).",
  input: z.object({ website: websiteArg, username: userArg, password: z.string().min(8) }),
  async handler({ website, username, password }, ctx) {
    const s = await pgSite(ctx, website); if (!s.ok) return s.result;
    const full = resolveDbUser(s.unixUser, username);
    await ctx.client.call('PATCH', '/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}', () => ctx.client.api.PATCH('/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}', { params: { path: { org_id: s.org, website_id: s.id, username: full } }, body: { password } }));
    return ok(`${s.identity}\npassword for ${safe(full)} updated (in structuredContent.password).`, { user: full, password });
  },
});

export const pgUserDelete = defineTool({
  name: 'pg_user_delete', tier: 'customer', risk: 'destructive',
  description: 'DESTRUCTIVE. Deletes a PostgreSQL user. Requires the user to confirm by typing the full user name.',
  input: z.object({ website: websiteArg, username: userArg }),
  async target({ website, username }, ctx) {
    const s = await pgSite(ctx, website); if (!s.ok) throw new Error('PostgreSQL is not available on this plan.');
    return { kind: 'pg_user', id: `${s.id}:${resolveDbUser(s.unixUser, username)}`, name: resolveDbUser(s.unixUser, username) };
  },
  async preview({ website }, ctx, target) {
    const s = await pgSite(ctx, website); const head = s.ok ? s.identity.split('\n')[0] : 'this website';
    return `This will delete PostgreSQL user ${safe(target.name)} on ${safe(head)}. Any app using this login will fail. The databases are not touched.`;
  },
  async handler({ website }, ctx, target) {
    const s = await pgSite(ctx, website); if (!s.ok) return s.result;
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}', () => ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}', { params: { path: { org_id: s.org, website_id: s.id, username: target!.name } } }));
    return ok(`${s.identity}\nPostgreSQL user ${safe(target!.name)} deleted.`, { user: target!.name, deleted: true });
  },
});

export const pgUserGrant = defineTool({
  name: 'pg_user_grant', tier: 'customer', risk: 'write',
  description: 'Grants a PostgreSQL user all privileges on one database.',
  input: z.object({ website: websiteArg, username: userArg, database: nameArg }),
  async handler({ website, username, database }, ctx) {
    const s = await pgSite(ctx, website); if (!s.ok) return s.result;
    const user = resolveDbUser(s.unixUser, username); const db = resolveDbName(s.unixUser, database);
    await ctx.client.call('POST', '/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}/privileges', () => ctx.client.api.POST('/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}/privileges', { params: { path: { org_id: s.org, website_id: s.id, username: user } }, body: db as unknown as string }));
    return ok(`${s.identity}\n${safe(user)} granted access to ${safe(db)}.`, { user, database: db, granted: true });
  },
});

export const pgUserRevoke = defineTool({
  name: 'pg_user_revoke', tier: 'customer', risk: 'destructive',
  description: "DESTRUCTIVE. Revokes a PostgreSQL user's privileges on one database. The app loses access. Requires the user to confirm by typing the full user name.",
  input: z.object({ website: websiteArg, username: userArg, database: nameArg }),
  async target({ website, username }, ctx) {
    const s = await pgSite(ctx, website); if (!s.ok) throw new Error('PostgreSQL is not available on this plan.');
    return { kind: 'pg_user', id: `${s.id}:${resolveDbUser(s.unixUser, username)}`, name: resolveDbUser(s.unixUser, username) };
  },
  async preview({ website, database }, ctx, target) {
    const s = await pgSite(ctx, website); const head = s.ok ? s.identity.split('\n')[0] : 'this website';
    const db = s.ok ? resolveDbName(s.unixUser, database) : database;
    return `This will revoke ${safe(target.name)}'s access to PostgreSQL database ${safe(db)} on ${safe(head)}. Any app connecting as that user loses access at once.`;
  },
  async handler({ website, database }, ctx, target) {
    const s = await pgSite(ctx, website); if (!s.ok) return s.result;
    const db = resolveDbName(s.unixUser, database);
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}/privileges/{db_name}', () => ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}/privileges/{db_name}', { params: { path: { org_id: s.org, website_id: s.id, username: target!.name, db_name: db } } }));
    return ok(`${s.identity}\nrevoked ${safe(target!.name)}'s access to ${safe(db)}.`, { user: target!.name, database: db, revoked: true });
  },
});

export const tools: ToolDef[] = [pgDbList, pgDbCreate, pgDbDelete, pgUsersList, pgUserCreate, pgUserUpdate, pgUserDelete, pgUserGrant, pgUserRevoke];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/unit/tools-postgres.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/postgres.ts server/test/unit/tools-postgres.test.ts
git commit -m "feat(postgres): databases and users, gated on canUse.postgresql"
```

---

### Task 5: PHP extensions, settings, error log, Redis, cache

**Files:**
- Create: `server/src/tools/php.ts`
- Test: `server/test/unit/tools-php.test.ts`

**Interfaces:**
- Consumes: `websiteArg`, `siteWebsite` (Task 1); `Resolver.resolveDomain` for `cache_clear`.
- Produces `tools: ToolDef[]`: `php_extensions_list`, `php_extension_enable`, `php_extension_disable`, `php_settings_get`, `php_settings_set`, `php_error_log`, `redis_state_get`, `redis_state_set`, `cache_clear`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/unit/tools-php.test.ts
import { describe, expect, it } from 'vitest';
import { byName, callTool, makeContext } from '../helpers/context.js';
import { WEBSITE_ID, DOMAIN_ID, base } from '../fixtures/panel.js';
import { tools } from '../../src/tools/php.js';

describe('php_extensions_list', () => {
  it('shows enabled, available and built-in extensions', async () => {
    const { ctx } = await makeContext([
      ...base(),
      { method: 'GET', path: `/websites/${WEBSITE_ID}/php_extensions`, body: ['pgsql', 'pdo_pgsql'] },
      { method: 'GET', path: `/websites/${WEBSITE_ID}/available_php_extensions`, body: ['apcu', 'pgsql'] },
      { method: 'GET', path: `/websites/${WEBSITE_ID}/built_in_php_extensions`, body: ['mysqli', 'redis'] },
    ]);
    const r = await callTool(byName(tools, 'php_extensions_list'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ enabled: ['pgsql', 'pdo_pgsql'], builtIn: ['mysqli', 'redis'] });
    expect(r.text).toContain('apcu');
  });
});

describe('php_extension_enable', () => {
  it('sends the extension name as a bare JSON string', async () => {
    let raw: string | undefined;
    const { ctx } = await makeContext([...base(), { method: 'POST', path: `/websites/${WEBSITE_ID}/php_extensions`, handler: async (req) => { raw = await req.text(); return new Response(null, { status: 200 }); } }]);
    const r = await callTool(byName(tools, 'php_extension_enable'), { website: 'vahi.dev', extension: 'apcu' }, ctx);
    expect(raw).toBe('"apcu"');
    expect(r.structured).toMatchObject({ extension: 'apcu', enabled: true });
  });
});

describe('redis_state_set', () => {
  it('sends a boolean body', async () => {
    let raw: string | undefined;
    const { ctx } = await makeContext([...base(), { method: 'PUT', path: `/v2/websites/${WEBSITE_ID}/redis`, handler: async (req) => { raw = await req.text(); return new Response(null, { status: 200 }); } }]);
    const r = await callTool(byName(tools, 'redis_state_set'), { website: 'vahi.dev', enabled: true }, ctx);
    expect(raw).toBe('true');
    expect(r.structured).toMatchObject({ redis: true });
  });
});

describe('cache_clear', () => {
  it('clears the FastCGI cache for the resolved domain', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'DELETE', path: `/v2/domains/${DOMAIN_ID}/nginx_fastcgi`, status: 200, body: null }]);
    const r = await callTool(byName(tools, 'cache_clear'), { website: 'vahi.dev' }, ctx);
    expect(f.calls.some((c) => c.method === 'DELETE' && c.path.includes('nginx_fastcgi'))).toBe(true);
    expect(r.text).toMatch(/website_restart_php/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/unit/tools-php.test.ts`
Expected: FAIL, `Cannot find module '../../src/tools/php.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/tools/php.ts
import * as z from 'zod/v4';
import { parseScalarText } from '../client/client.js';
import type { ToolContext } from '../core/context.js';
import { identityBlock } from '../core/identity.js';
import { defineTool, type ToolDef } from '../core/registry.js';
import { kv, ok, safe, table } from '../core/respond.js';
import { siteWebsite, websiteArg } from './dbcommon.js';

const domainArg = z.string().min(1).optional().describe('Domain name or UUID; defaults to the primary domain');

async function phpSite(ctx: ToolContext, website: string) {
  const { org, w } = await siteWebsite(ctx, website);
  return { org, id: w.id, w, identity: identityBlock({ name: ctx.client.orgName, id: org }, w) };
}

export const phpExtensionsList = defineTool({
  name: 'php_extensions_list', tier: 'customer', risk: 'read',
  description: 'Lists PHP extensions for a website: enabled now, available to enable, and built in (always on). Use php_extension_enable to turn on one of the available ones.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await phpSite(ctx, website);
    const call = (p: '/websites/{website_id}/php_extensions' | '/websites/{website_id}/available_php_extensions' | '/websites/{website_id}/built_in_php_extensions') =>
      ctx.client.call(p === '/websites/{website_id}/php_extensions' ? 'GET' : 'GET', p, () => ctx.client.api.GET(p, { params: { path: { website_id: s.id } } }));
    const [enabled, available, builtIn] = await Promise.all([
      call('/websites/{website_id}/php_extensions'),
      call('/websites/{website_id}/available_php_extensions'),
      call('/websites/{website_id}/built_in_php_extensions'),
    ]);
    return ok([s.identity, kv([['enabled', (enabled ?? []).map(safe).join(', ') || 'none'], ['available to enable', (available ?? []).map(safe).join(', ') || 'none'], ['built in (always on)', (builtIn ?? []).map(safe).join(', ')]])].join('\n'), { enabled, available, builtIn });
  },
});

export const phpExtensionEnable = defineTool({
  name: 'php_extension_enable', tier: 'customer', risk: 'write',
  description: 'Enables a PHP extension for a website (from the available list). Restart PHP after with website_restart_php if a running app needs it.',
  input: z.object({ website: websiteArg, extension: z.string().min(1) }),
  async handler({ website, extension }, ctx) {
    const s = await phpSite(ctx, website);
    await ctx.client.call('POST', '/websites/{website_id}/php_extensions', () => ctx.client.api.POST('/websites/{website_id}/php_extensions', { params: { path: { website_id: s.id } }, body: extension as unknown as string }));
    return ok(`${s.identity}\nPHP extension ${safe(extension)} enabled. Run website_restart_php if a running app needs it.`, { extension, enabled: true });
  },
});

export const phpExtensionDisable = defineTool({
  name: 'php_extension_disable', tier: 'customer', risk: 'write',
  description: 'Disables a PHP extension for a website.',
  input: z.object({ website: websiteArg, extension: z.string().min(1) }),
  async handler({ website, extension }, ctx) {
    const s = await phpSite(ctx, website);
    await ctx.client.call('DELETE', '/websites/{website_id}/php_extensions', () => ctx.client.api.DELETE('/websites/{website_id}/php_extensions', { params: { path: { website_id: s.id } }, body: extension as unknown as string }));
    return ok(`${s.identity}\nPHP extension ${safe(extension)} disabled.`, { extension, enabled: false });
  },
});

export const phpSettingsGet = defineTool({
  name: 'php_settings_get', tier: 'customer', risk: 'read',
  description: 'Shows the tunable PHP (LSPHP) settings for a website. At the customer tier this is the number of LSAPI child processes; arbitrary php.ini directives are not editable here.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await phpSite(ctx, website);
    const cfg = await ctx.client.call('GET', '/websites/{website_id}/lsphp_settings', () => ctx.client.api.GET('/websites/{website_id}/lsphp_settings', { params: { path: { website_id: s.id } } }));
    return ok(`${s.identity}\n${kv([['LSAPI children', cfg.lsapiChildren]])}`, { lsapiChildren: cfg.lsapiChildren });
  },
});

export const phpSettingsSet = defineTool({
  name: 'php_settings_set', tier: 'customer', risk: 'write',
  description: 'Sets the number of LSPHP (LSAPI) child processes for a website. Raising it allows more concurrent PHP requests at the cost of memory.',
  input: z.object({ website: websiteArg, lsapi_children: z.number().int().min(1).max(200) }),
  async handler({ website, lsapi_children }, ctx) {
    const s = await phpSite(ctx, website);
    await ctx.client.call('PUT', '/websites/{website_id}/lsphp_settings', () => ctx.client.api.PUT('/websites/{website_id}/lsphp_settings', { params: { path: { website_id: s.id } }, body: { lsapiChildren: lsapi_children } }));
    return ok(`${s.identity}\nLSAPI children set to ${lsapi_children}.`, { lsapiChildren: lsapi_children });
  },
});

export const phpErrorLog = defineTool({
  name: 'php_error_log', tier: 'customer', risk: 'read',
  description: 'Returns the last 256 KB of the PHP error log for a website. Empty when there have been no errors.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await phpSite(ctx, website);
    const raw = await ctx.client.call<string>('GET', '/websites/{website_id}/php_error_log', () => ctx.client.api.GET('/websites/{website_id}/php_error_log', { params: { path: { website_id: s.id } }, parseAs: 'text' }));
    const log = parseScalarText(raw);
    const body = log.trim().length === 0 ? 'PHP error log is empty.' : 'PHP error log (last 256 KB) in structuredContent.log.';
    return ok(`${s.identity}\n${body}`, { bytes: log.length, log });
  },
});

export const redisStateGet = defineTool({
  name: 'redis_state_get', tier: 'customer', risk: 'read',
  description: 'Shows whether the per-site Redis instance is on. Redis here is an on/off feature, not a key-value API.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await phpSite(ctx, website);
    const on = await ctx.client.call('GET', '/v2/websites/{website_id}/redis', () => ctx.client.api.GET('/v2/websites/{website_id}/redis', { params: { path: { website_id: s.id } } }));
    return ok(`${s.identity}\n${kv([['redis', on ? 'on' : 'off']])}`, { redis: !!on });
  },
});

export const redisStateSet = defineTool({
  name: 'redis_state_set', tier: 'customer', risk: 'write',
  description: 'Turns the per-site Redis instance on or off. Check canUse.redis first; some plans do not offer it.',
  input: z.object({ website: websiteArg, enabled: z.boolean() }),
  async handler({ website, enabled }, ctx) {
    const s = await phpSite(ctx, website);
    if (enabled && s.w.canUse?.redis !== true) return ok(`${s.identity}\nRedis is not available on this plan (canUse.redis is false).`, { redis: false, available: false });
    await ctx.client.call('PUT', '/v2/websites/{website_id}/redis', () => ctx.client.api.PUT('/v2/websites/{website_id}/redis', { params: { path: { website_id: s.id } }, body: enabled as unknown as boolean }));
    return ok(`${s.identity}\nredis turned ${enabled ? 'on' : 'off'}.`, { redis: enabled });
  },
});

export const cacheClear = defineTool({
  name: 'cache_clear', tier: 'customer', risk: 'write',
  description: "Clears a domain's FastCGI (page) cache. For PHP OPcache, run website_restart_php as well. Defaults to the primary domain.",
  input: z.object({ website: websiteArg, domain: domainArg }),
  async handler({ website, domain }, ctx) {
    const s = await phpSite(ctx, website);
    const d = await ctx.resolver.resolveDomain(s.w, domain);
    await ctx.client.call('DELETE', '/v2/domains/{domain_id}/nginx_fastcgi', () => ctx.client.api.DELETE('/v2/domains/{domain_id}/nginx_fastcgi', { params: { path: { domain_id: d.domainId } } }));
    return ok(`${s.identity}\nFastCGI cache cleared for ${safe(d.domain)}. For PHP OPcache, also run website_restart_php.`, { domain: d.domain, cleared: true });
  },
});

export const tools: ToolDef[] = [phpExtensionsList, phpExtensionEnable, phpExtensionDisable, phpSettingsGet, phpSettingsSet, phpErrorLog, redisStateGet, redisStateSet, cacheClear];
```

Note: `resolveDomain` returns a `DomainMapping` whose id field is `domainId` (milestone A). Confirm the field name against `src/core/resolver.ts` and use it consistently.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/unit/tools-php.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/php.ts server/test/unit/tools-php.test.ts
git commit -m "feat(php): extensions, LSPHP settings, error log, Redis toggle, cache clear"
```

---

### Task 6: htaccess rewrites and IP access rules

**Files:**
- Create: `server/src/tools/htaccess.ts`
- Test: `server/test/unit/tools-htaccess.test.ts`

**Interfaces:**
- Produces `tools: ToolDef[]`: `htaccess_rewrites_get`, `htaccess_rewrites_set`, `ip_rules_get`, `ip_rules_set`.
- `ip_rules_set(website, kind: 'allow'|'block', ips[])` replaces the whole rule.
- `htaccess_rewrites_get(website)` reads the rewrite chains; `htaccess_rewrites_set(website, items)` replaces them with the given chains.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/unit/tools-htaccess.test.ts
import { describe, expect, it } from 'vitest';
import { byName, callTool, makeContext } from '../helpers/context.js';
import { ORG_ID, WEBSITE_ID, base } from '../fixtures/panel.js';
import { tools } from '../../src/tools/htaccess.js';

describe('ip_rules_get', () => {
  it('shows the current allow/block list', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/htaccess/ips`, body: { kind: 'block', ips: ['1.2.3.4'] } }]);
    const r = await callTool(byName(tools, 'ip_rules_get'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ kind: 'block', ips: ['1.2.3.4'] });
  });
});

describe('ip_rules_set', () => {
  it('replaces the rule with the given kind and ips', async () => {
    let body: { kind: string; ips: string[] } | undefined;
    const { ctx } = await makeContext([...base(), { method: 'PUT', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/htaccess/ips`, handler: async (req) => { body = await req.json(); return new Response(null, { status: 204 }); } }]);
    const r = await callTool(byName(tools, 'ip_rules_set'), { website: 'vahi.dev', kind: 'allow', ips: ['203.0.113.9'] }, ctx);
    expect(body).toMatchObject({ kind: 'allow', ips: ['203.0.113.9'] });
    expect(r.structured).toMatchObject({ kind: 'allow', ips: ['203.0.113.9'] });
  });
});

describe('htaccess_rewrites_get', () => {
  it('returns the rewrite chains', async () => {
    const chain = { lineNumber: 1, rule: { pattern: '^old$', substitution: '/new', flags: ['R=301'] }, conds: [] };
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/htaccess`, body: { items: [chain] } }]);
    const r = await callTool(byName(tools, 'htaccess_rewrites_get'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ total: 1 });
    expect(r.text).toContain('^old$');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/unit/tools-htaccess.test.ts`
Expected: FAIL, `Cannot find module '../../src/tools/htaccess.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/tools/htaccess.ts
import * as z from 'zod/v4';
import type { ToolContext } from '../core/context.js';
import { identityBlock } from '../core/identity.js';
import { defineTool, type ToolDef } from '../core/registry.js';
import { kv, ok, safe, table } from '../core/respond.js';
import { siteWebsite, websiteArg } from './dbcommon.js';

async function htSite(ctx: ToolContext, website: string) {
  const { org, w } = await siteWebsite(ctx, website);
  return { org, id: w.id, identity: identityBlock({ name: ctx.client.orgName, id: org }, w) };
}

const rewriteChain = z.object({
  lineNumber: z.number().int(),
  rule: z.object({ pattern: z.string(), substitution: z.string(), flags: z.array(z.string()) }),
  conds: z.array(z.object({ testString: z.string(), condPattern: z.string(), flags: z.array(z.string()) })).default([]),
});

export const htaccessRewritesGet = defineTool({
  name: 'htaccess_rewrites_get', tier: 'customer', risk: 'read',
  description: 'Reads the mod_rewrite rules the panel manages for a website (RewriteRule/RewriteCond chains). Rules the app ships in its own .htaccess are not shown here.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await htSite(ctx, website);
    const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/htaccess', () => ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/htaccess', { params: { path: { org_id: s.org, website_id: s.id } } }));
    const rows = (res.items ?? []).map((c) => ({ line: c.lineNumber, pattern: c.rule.pattern, substitution: c.rule.substitution, flags: c.rule.flags.join(',') , conds: c.conds.length }));
    return ok([s.identity, `managed rewrite chains (${rows.length}):`, table(rows, ['line', 'pattern', 'substitution', 'flags', 'conds'])].join('\n'), { total: rows.length, items: res.items ?? [] });
  },
});

export const htaccessRewritesSet = defineTool({
  name: 'htaccess_rewrites_set', tier: 'customer', risk: 'write',
  description: 'Replaces the panel-managed mod_rewrite chains for a website with the given list. Read htaccess_rewrites_get first and send the full desired set; this overwrites the managed rules.',
  input: z.object({ website: websiteArg, items: z.array(rewriteChain) }),
  async handler({ website, items }, ctx) {
    const s = await htSite(ctx, website);
    await ctx.client.call('PATCH', '/orgs/{org_id}/websites/{website_id}/htaccess', () => ctx.client.api.PATCH('/orgs/{org_id}/websites/{website_id}/htaccess', { params: { path: { org_id: s.org, website_id: s.id } }, body: { items } }));
    return ok(`${s.identity}\nreplaced the managed rewrite chains (${items.length} chain(s)).`, { total: items.length });
  },
});

export const ipRulesGet = defineTool({
  name: 'ip_rules_get', tier: 'customer', risk: 'read',
  description: 'Shows the website\'s IP access rule: whether it is an allow list or a block list, and the IPs in it.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await htSite(ctx, website);
    const rule = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/htaccess/ips', () => ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/htaccess/ips', { params: { path: { org_id: s.org, website_id: s.id } } }));
    return ok(`${s.identity}\n${kv([['mode', rule.kind], ['ips', (rule.ips ?? []).map(safe).join(', ') || 'none']])}`, { kind: rule.kind, ips: rule.ips ?? [] });
  },
});

export const ipRulesSet = defineTool({
  name: 'ip_rules_set', tier: 'customer', risk: 'write',
  description: "Sets the website's IP access rule. kind='allow' permits only the listed IPs and blocks the rest; kind='block' blocks the listed IPs. This replaces the whole rule; an empty list clears it.",
  input: z.object({ website: websiteArg, kind: z.enum(['allow', 'block']), ips: z.array(z.string().min(1)) }),
  async handler({ website, kind, ips }, ctx) {
    const s = await htSite(ctx, website);
    await ctx.client.call('PUT', '/orgs/{org_id}/websites/{website_id}/htaccess/ips', () => ctx.client.api.PUT('/orgs/{org_id}/websites/{website_id}/htaccess/ips', { params: { path: { org_id: s.org, website_id: s.id } }, body: { kind, ips } }));
    return ok(`${s.identity}\nIP rule set: ${kind} [${ips.map(safe).join(', ') || 'empty'}].`, { kind, ips });
  },
});

export const tools: ToolDef[] = [htaccessRewritesGet, htaccessRewritesSet, ipRulesGet, ipRulesSet];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/unit/tools-htaccess.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/htaccess.ts server/test/unit/tools-htaccess.test.ts
git commit -m "feat(htaccess): managed rewrite chains and IP access rules"
```

---

### Task 7: Cron

**Files:**
- Create: `server/src/tools/cron.ts`
- Test: `server/test/unit/tools-cron.test.ts`

**Interfaces:**
- Produces `tools: ToolDef[]`: `cron_get`, `cron_set`, `cron_delete` (D), `container_cron_get`, `container_cron_set`.
- `cron_get(website)` lists the crontab (commands and variables). `cron_set(website, jobs[])` replaces command lines. `cron_delete(website)` removes the whole crontab (destructive). `container_cron_get/set(website[, enabled])` toggles whether the container runs cron at all.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/unit/tools-cron.test.ts
import { describe, expect, it } from 'vitest';
import { byName, callTool, makeContext } from '../helpers/context.js';
import { ORG_ID, WEBSITE_ID, base } from '../fixtures/panel.js';
import { tools } from '../../src/tools/cron.js';

describe('cron_get', () => {
  it('lists command lines from the crontab', async () => {
    const body = { items: [{ cronCmd: { lineNumber: 1, expr: '0 3 * * * php /var/www/x/cron.php' } }, { variable: { lineNumber: 2, key: 'MAILTO', val: 'me@example.com' } }] };
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/crontab`, body }]);
    const r = await callTool(byName(tools, 'cron_get'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain('0 3 * * *');
    expect(r.structured).toMatchObject({ commands: 1, variables: 1 });
  });
});

describe('cron_set', () => {
  it('sends the jobs as cronCmd items', async () => {
    let body: { items: Array<{ cronCmd: { lineNumber: number; expr: string } }> } | undefined;
    const { ctx } = await makeContext([...base(), { method: 'PATCH', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/crontab`, handler: async (req) => { body = await req.json(); return new Response(null, { status: 204 }); } }]);
    const r = await callTool(byName(tools, 'cron_set'), { website: 'vahi.dev', jobs: ['*/5 * * * * php artisan schedule:run'] }, ctx);
    expect(body!.items[0].cronCmd.expr).toBe('*/5 * * * * php artisan schedule:run');
    expect(r.structured).toMatchObject({ commands: 1 });
  });
});

describe('cron_delete', () => {
  it('is destructive and clears the crontab', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'DELETE', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/crontab`, status: 204, body: null }]);
    const del = byName(tools, 'cron_delete');
    const target = await del.target!({ website: 'vahi.dev' }, ctx);
    expect(target.kind).toBe('crontab');
    await del.preview!({ website: 'vahi.dev' }, ctx, target);
    await del.handler({ website: 'vahi.dev' }, ctx, target);
    expect(f.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/crontab'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/unit/tools-cron.test.ts`
Expected: FAIL, `Cannot find module '../../src/tools/cron.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/tools/cron.ts
import * as z from 'zod/v4';
import type { ToolContext } from '../core/context.js';
import { identityBlock } from '../core/identity.js';
import { defineTool, type ToolDef } from '../core/registry.js';
import { kv, ok, safe, table } from '../core/respond.js';
import { siteWebsite, websiteArg } from './dbcommon.js';

async function cronSite(ctx: ToolContext, website: string) {
  const { org, w } = await siteWebsite(ctx, website);
  return { org, id: w.id, identity: identityBlock({ name: ctx.client.orgName, id: org }, w) };
}

type CronItem = { cronCmd?: { lineNumber: number; expr: string }; variable?: { lineNumber: number; key: string; val: string } };

export const cronGet = defineTool({
  name: 'cron_get', tier: 'customer', risk: 'read',
  description: "Lists the website's crontab: scheduled command lines and any variables (like MAILTO). Container cron must be on for jobs to run (container_cron_get).",
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await cronSite(ctx, website);
    const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/crontab', () => ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/crontab', { params: { path: { org_id: s.org, website_id: s.id } } }));
    const items = (res.items ?? []) as CronItem[];
    const cmds = items.filter((i) => i.cronCmd).map((i) => ({ line: i.cronCmd!.lineNumber, schedule_and_command: i.cronCmd!.expr }));
    const vars = items.filter((i) => i.variable).map((i) => ({ line: i.variable!.lineNumber, key: i.variable!.key, value: i.variable!.val }));
    const out = [s.identity, `cron commands (${cmds.length}):`, table(cmds, ['line', 'schedule_and_command'])];
    if (vars.length) out.push(`variables (${vars.length}):`, table(vars, ['line', 'key', 'value']));
    return ok(out.join('\n'), { commands: cmds.length, variables: vars.length, items });
  },
});

export const cronSet = defineTool({
  name: 'cron_set', tier: 'customer', risk: 'write',
  description: "Replaces the website's cron command lines. Each job is a full crontab line ('<schedule> <command>', e.g. '*/5 * * * * php artisan schedule:run'). This overwrites existing command lines; read cron_get first.",
  input: z.object({ website: websiteArg, jobs: z.array(z.string().min(1)) }),
  async handler({ website, jobs }, ctx) {
    const s = await cronSite(ctx, website);
    const items = jobs.map((expr, i) => ({ cronCmd: { lineNumber: i + 1, expr } }));
    await ctx.client.call('PATCH', '/orgs/{org_id}/websites/{website_id}/crontab', () => ctx.client.api.PATCH('/orgs/{org_id}/websites/{website_id}/crontab', { params: { path: { org_id: s.org, website_id: s.id } }, body: { items } }));
    return ok(`${s.identity}\nset ${jobs.length} cron command line(s). Ensure container cron is on (container_cron_get).`, { commands: jobs.length });
  },
});

export const cronDelete = defineTool({
  name: 'cron_delete', tier: 'customer', risk: 'destructive',
  description: "DESTRUCTIVE. Removes the website's entire crontab (every scheduled job). Requires the user to confirm by typing the website domain.",
  input: z.object({ website: websiteArg }),
  async target({ website }, ctx) {
    const { w } = await siteWebsite(ctx, website);
    return { kind: 'crontab', id: w.id, name: w.domain.domain };
  },
  async preview({ website }, ctx) {
    const s = await cronSite(ctx, website);
    return `This will remove the entire crontab for ${safe(s.identity.split('\n')[0])}. Every scheduled job stops. Read cron_get first if you want to keep a copy.`;
  },
  async handler({ website }, ctx, target) {
    const s = await cronSite(ctx, website);
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/crontab', () => ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/crontab', { params: { path: { org_id: s.org, website_id: s.id } } }));
    return ok(`${s.identity}\ncrontab cleared for ${safe(target!.name)}.`, { website: target!.id, cleared: true });
  },
});

export const containerCronGet = defineTool({
  name: 'container_cron_get', tier: 'customer', risk: 'read',
  description: 'Shows whether the container runs cron at all. When off, the crontab exists but nothing fires.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await cronSite(ctx, website);
    const on = await ctx.client.call('GET', '/websites/{website_id}/container_cron_enabled', () => ctx.client.api.GET('/websites/{website_id}/container_cron_enabled', { params: { path: { website_id: s.id } } }));
    return ok(`${s.identity}\n${kv([['container cron', on ? 'on' : 'off']])}`, { enabled: !!on });
  },
});

export const containerCronSet = defineTool({
  name: 'container_cron_set', tier: 'customer', risk: 'write',
  description: 'Turns the container cron runner on or off. Turn it on for scheduled jobs (e.g. Laravel schedule:run) to fire.',
  input: z.object({ website: websiteArg, enabled: z.boolean() }),
  async handler({ website, enabled }, ctx) {
    const s = await cronSite(ctx, website);
    await ctx.client.call('PUT', '/websites/{website_id}/container_cron_enabled', () => ctx.client.api.PUT('/websites/{website_id}/container_cron_enabled', { params: { path: { website_id: s.id } }, body: enabled as unknown as boolean }));
    return ok(`${s.identity}\ncontainer cron turned ${enabled ? 'on' : 'off'}.`, { enabled });
  },
});

export const tools: ToolDef[] = [cronGet, cronSet, cronDelete, containerCronGet, containerCronSet];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/unit/tools-cron.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/cron.ts server/test/unit/tools-cron.test.ts
git commit -m "feat(cron): crontab get/set/delete and the container cron toggle"
```

---

### Task 8: Register the tools and extend the MCP-level tests

**Files:**
- Modify: `server/src/tools/index.ts`
- Modify: `server/test/mcp/server.test.ts`
- Test: `server/test/unit/smoke.test.ts` (update the tool count if it asserts one)

**Interfaces:**
- Consumes: the `tools` arrays exported by `mysql.ts`, `postgres.ts`, `php.ts`, `htaccess.ts`, `cron.ts`.
- Produces: `allTools` includes every milestone B tool; the parameterised destructive-gate MCP test covers all seven new destructive tools; the never-exposed guard still passes.

- [ ] **Step 1: Write the failing test**

Extend the never-exposed guard and destructive coverage in `server/test/mcp/server.test.ts`. Add a test that every destructive tool is reachable only through the gate:

```ts
// in server/test/mcp/server.test.ts, extend the destructive parameterisation list
const destructiveDbCases = [
  { tool: 'db_delete', args: { website: 'vahi.dev', name: 'demo' }, typed: 'vahi_dev1_demo', route: { method: 'DELETE', path: new RegExp(`/mysql-dbs/(.+)$`), status: 204 } },
  { tool: 'db_user_delete', args: { website: 'vahi.dev', username: 'app' }, typed: 'vahi_dev1_app', route: { method: 'DELETE', path: new RegExp(`/mysql-users/(.+)$`), status: 204 } },
  { tool: 'cron_delete', args: { website: 'vahi.dev' }, typed: 'vahi.dev', route: { method: 'DELETE', path: new RegExp(`/crontab$`), status: 204 } },
];
// For each: with the bare elicitation capability, calling the tool prompts once, executes on an
// exact typed-name match, and records an audit line { tool, gate: 'elicitation', outcome: 'ok' }.
```

Add a count/coverage assertion:

```ts
it('every destructive tool defines target() and preview()', () => {
  for (const t of allTools.filter((t) => t.risk === 'destructive')) {
    expect(t.target, `${t.name} target`).toBeTypeOf('function');
    expect(t.preview, `${t.name} preview`).toBeTypeOf('function');
  }
});

it('the never-exposed guard still holds with the database tools added', () => {
  const forbidden = /(^|_)(servers?|settings?|licences?|licenses?|members?|owners?)(_|$)|(token_create|org_delete|subscription_delete)/;
  expect(allTools.filter((t) => forbidden.test(t.name)).map((t) => t.name)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/mcp/server.test.ts`
Expected: FAIL, the new destructive db tools are not registered (`no tool db_delete`) until `index.ts` is updated.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/tools/index.ts
import type { ToolDef } from '../core/registry.js';
import { tools as account } from './account.js';
import { tools as cron } from './cron.js';
import { tools as domains } from './domains.js';
import { tools as htaccess } from './htaccess.js';
import { tools as mysql } from './mysql.js';
import { tools as php } from './php.js';
import { tools as postgres } from './postgres.js';
import { tools as ssh } from './ssh.js';
import { tools as websites } from './websites.js';

export const allTools: ToolDef[] = [...account, ...websites, ...domains, ...ssh, ...mysql, ...postgres, ...php, ...htaccess, ...cron];
```

If `smoke.test.ts` asserts an exact tool count, update it to the new total (29 milestone A tools + 12 mysql + 9 postgres + 9 php + 4 htaccess + 5 cron = 68). Prefer asserting `allTools.length >= 29` and that names are unique over a brittle exact count:

```ts
it('registers a unique, non-empty tool set', () => {
  const names = allTools.map((t) => t.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toContain('db_create');
  expect(names).toContain('php_extensions_list');
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test && npm run typecheck && npm run build`
Expected: all suites PASS; typecheck and build clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/index.ts server/test/mcp/server.test.ts server/test/unit/smoke.test.ts
git commit -m "feat(tools): register PHP, MySQL, PostgreSQL, cron; extend the gate and guard tests"
```

---

### Task 9: enhance-database skill, PHP deploy steps, and docs

**Files:**
- Create: `skills/enhance-database/SKILL.md`
- Modify: `skills/enhance-deploy/SKILL.md` (PHP/Laravel build and post-deploy)
- Modify: `README.md`, `CLAUDE.md`, `.claude-plugin/plugin.json` (description/keywords already include php)

**Interfaces:** documentation only; no code.

- [ ] **Step 1: Write the `enhance-database` skill**

Create `skills/enhance-database/SKILL.md` with front matter and the flow. It MUST state:
- Preconditions from `canUse`: `mysqlKind` present means MySQL is available; `canUse.postgresql` gates the `pg_*` tools.
- The naming rule: names are prefixed with the unix user; always use the full name the tool returns.
- The `localhost` connection rule for app config (never `127.0.0.1`).
- The order for a new app database: `db_create` -> `db_user_create` (capture the one-time password) -> `db_user_set_privileges database=<db> grants=all` -> write the app config with `DB_HOST=localhost`, the full db and user names, and the password.
- Destructive tools (`db_delete`, `db_user_delete`, `db_import_sql`, `pg_db_delete`, `pg_user_delete`, `pg_user_revoke`, `cron_delete`) prompt for the typed name; never auto-approve them (link `references/safety-rules.md`).
- phpMyAdmin: `db_phpmyadmin_url` returns a single-use login URL; treat it as a secret.
- Backups: export with `db_export_sql` before any destructive database change.

```markdown
---
name: enhance-database
description: Create and manage MySQL or PostgreSQL databases and users on an Enhance-hosted website, and wire them into an app. Use when the user says "create a database", "add a db user", "set up MySQL for my app", "import this SQL", or asks for a phpMyAdmin login.
---

# Enhance database management

Shared rules: `references/safety-rules.md` (same folder as the connect skill).

## Preconditions
- `website_get` and read `canUse`. `mysqlKind` (e.g. `mariaDbLts`) means MySQL is available. `canUse.postgresql` must be true for the `pg_*` tools; if false, tell the user PostgreSQL is not on their plan.

## Naming
- The panel prefixes every database and user name with the site's unix user (e.g. `demo` becomes `vahi_dev1_demo`). The tools accept the short name and return the full one. Always use the full name in connection strings.

## Connect from an app (critical)
- The database host is always `localhost` (the unix socket). Never `127.0.0.1` (refused) or an external IP.

## New app database, in order
1. `db_create website=<site> name=<db>` -> note the full db name.
2. `db_user_create website=<site> username=<user>` -> the password is shown once; capture it now.
3. `db_user_set_privileges website=<site> username=<user> database=<db> grants=all`.
4. Write the app config (`.env`, `wp-config.php`): `DB_HOST=localhost`, `DB_DATABASE=<full db>`, `DB_USERNAME=<full user>`, `DB_PASSWORD=<the shown password>`. Never commit it.

## Import / export
- Back up first: `db_export_sql`. Import with `db_import_sql` (destructive: it runs arbitrary SQL and prompts for the db name).

## phpMyAdmin
- `db_phpmyadmin_url` returns a single-use sign-on URL. Give it to the user directly; do not post it anywhere.

## Destructive tools
- `db_delete`, `db_user_delete`, `db_import_sql`, and the `pg_*` deletes/revokes and `cron_delete` prompt for a typed name. Never add them to an always-allow rule; never type the name yourself.
```

- [ ] **Step 2: Extend `enhance-deploy` for PHP and Laravel**

In `skills/enhance-deploy/SKILL.md`, under "Build" (step 6) and "Post-deploy" (step 8), add:
- PHP static-ish: rsync the app into the docroot; do not upload `vendor/` when `composer.json` is present.
- Laravel: rsync excluding `vendor`, `node_modules`, `.env`; then over SSH `composer install --no-dev --optimize-autoloader`; write `.env` from the database tool output with `DB_HOST=localhost`; `php artisan migrate --force` only on the user's confirmation; `php artisan config:cache`. Set the docroot to the app's `public/` if the panel document root can be pointed there, otherwise deploy so the framework's `public` is the served directory.
- Database: use the `enhance-database` skill to create the db and user first; the app config uses `localhost`.
- Node note (mode A, milestone C preview): a persistent-app proxy path is served on the PRIMARY domain, not the `*.mystaging.site` preview URL; verify Node routes with `curl --resolve <domain>:443:<serverIp>` until DNS resolves. (This is a forward note; Node tools arrive in milestone C.)

- [ ] **Step 3: Update docs**

- `README.md`: bump the feature list to mention databases (MySQL/PostgreSQL), PHP extensions and settings, and cron; keep the "verified live" wording.
- `CLAUDE.md`: set status to milestone B in progress / complete on `feat/milestone-b`.
- `.claude-plugin/plugin.json`: keywords already include `php`; no change needed unless adding `mysql`.

- [ ] **Step 4: Verify the skills are well-formed**

Run: `claude plugin validate .` from the repo root.
Expected: "Validation passed" (warnings about author/CLAUDE.md root are pre-existing and acceptable).

- [ ] **Step 5: Commit**

```bash
git add skills/enhance-database/SKILL.md skills/enhance-deploy/SKILL.md README.md CLAUDE.md .claude-plugin/plugin.json
git commit -m "docs(skills): enhance-database skill; PHP/Laravel deploy steps; status"
```

---

### Task 10: Live e2e for databases

**Files:**
- Create: `server/test/e2e/milestone-b.e2e.test.ts`
- Modify: `.env.example` (note that milestone B reuses the same e2e vars)

**Interfaces:** opt-in (`ENHANCE_E2E=1`), scoped to a throwaway database on `ENHANCE_E2E_DOMAIN` (defaults to the existing e2e site) or on the site created by the milestone A suite. It creates a db and user, grants, reads them back, exports SQL, then deletes the user and db through the gate contract. It never touches an existing database (names are randomised and asserted before delete).

- [ ] **Step 1: Write the e2e test**

```ts
// server/test/e2e/milestone-b.e2e.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import type { ToolContext } from '../../src/core/context.js';
import type { ToolDef, ToolResult } from '../../src/core/registry.js';

const enabled = process.env['ENHANCE_E2E'] === '1';
const suite = enabled ? describe : describe.skip;

suite('milestone B databases against the live panel', () => {
  let ctx: ToolContext; let tools: ToolDef[];
  const site = process.env['ENHANCE_E2E_DOMAIN'] || '';
  const slug = `mcpb${Math.random().toString(36).slice(2, 7)}`;
  let fullDb: string | undefined; let fullUser: string | undefined;

  function tool(name: string): ToolDef { const t = tools.find((x) => x.name === name); if (!t) throw new Error(`no tool ${name}`); return t; }
  async function call<A>(t: ToolDef<A>, args: unknown): Promise<ToolResult> { return t.handler(t.input.parse(args), ctx); }

  beforeAll(async () => {
    ({ ctx, tools } = await bootstrap(process.env));
    expect(site, 'ENHANCE_E2E_DOMAIN must name an existing website for the milestone B live test').toBeTruthy();
  });

  afterAll(async () => {
    // Delete only the randomised db/user this run created, by the exact full names it recorded.
    if (fullUser) { const del = tool('db_user_delete'); const t = await del.target!({ website: site, username: fullUser }, ctx).catch(() => undefined); if (t && t.name === fullUser) await del.handler({ website: site, username: fullUser }, ctx, t); }
    if (fullDb) { const del = tool('db_delete'); const t = await del.target!({ website: site, name: fullDb }, ctx).catch(() => undefined); if (t && t.name === fullDb) await del.handler({ website: site, name: fullDb }, ctx, t); }
  });

  it('creates a database and user, grants, reads back, exports', async () => {
    const created = await call(tool('db_create'), { website: site, name: slug });
    fullDb = (created.structured as { database: string }).database;
    expect(fullDb).toContain(slug);

    const u = await call(tool('db_user_create'), { website: site, username: slug });
    fullUser = (u.structured as { user: string }).user;
    expect((u.structured as { password: string }).password.length).toBeGreaterThanOrEqual(20);

    await call(tool('db_user_set_privileges'), { website: site, username: slug, database: slug, grants: ['all'] });

    const dbs = await call(tool('db_list'), { website: site });
    expect((dbs.structured as { items: Array<{ database: string }> }).items.some((d) => d.database === fullDb)).toBe(true);

    const users = await call(tool('db_users_list'), { website: site });
    expect((users.structured as { items: Array<{ user: string }> }).items.some((x) => x.user === fullUser)).toBe(true);

    const sql = await call(tool('db_export_sql'), { website: site, name: slug });
    expect((sql.structured as { sql: string }).sql.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run in skip mode to prove it is opt-in**

Run: `cd server && npm test 2>&1 | grep milestone-b`
Expected: the suite is skipped (no `ENHANCE_E2E`), the rest of the suite passes.

- [ ] **Step 3: Live run (needs a fresh credential)**

Run from `server/`:
```bash
set -a && source ../.env && set +a && export ENHANCE_TOKEN="$ENHANCE_SESSION_COOKIE"
ENHANCE_E2E=1 ENHANCE_E2E_DOMAIN=vahi.dev npm run test:e2e
```
Expected: PASS; the randomised `<unixUser>_mcpb…` database and user are created and then removed in `afterAll`. Verify on the panel that no `mcpb…` database remains.

- [ ] **Step 4: Live PHP + MySQL walkthrough (with the user)**

The spec's milestone B live test: deploy a small PHP page that reads from a MySQL table on vahi.dev, and a Laravel app with `composer install` over SSH and `migrate`. Record findings in `docs/research.md` and fix tools/skills as needed. This mirrors milestone A's Task 19 and is done with the user watching. Key checks:
- `db_create`/`db_user_create`/`db_user_set_privileges`, then a PHP page connecting with `DB_HOST=localhost` returns a row (verified in the 2026-09-05 probe; confirm through the tools and skill).
- Laravel: `.env` from tool output, `composer install --no-dev`, `php artisan migrate --force`, page renders.
- `db_delete` and `db_user_delete` show the typed-name prompt in Claude Code.

- [ ] **Step 5: Commit**

```bash
git add server/test/e2e/milestone-b.e2e.test.ts .env.example
git commit -m "test(e2e): live database round trip for milestone B"
```

---

## Self-review against the spec

**Spec coverage (§6 Milestone B):**
- PHP: `php_extensions_get/enable/disable` -> Task 5 (`php_extensions_list`, `php_extension_enable/disable`). `php_ini_get/set` -> Task 5 `php_settings_get/set` (lsphp; documented limitation). `php_error_log` -> Task 5. `redis_get/set` -> Task 5 `redis_state_get/set`. `cache_clear` -> Task 5. `htaccess_rewrites_get/update` -> Task 6 (`_get`/`_set`). `ip_rules_get/set` -> Task 6.
- MySQL: `db_list/create/delete/users_list/user_create/user_update/user_delete/user_set_privileges/user_access_hosts_set/phpmyadmin_url/export_sql/import_sql` -> Tasks 2-3, all present.
- PostgreSQL: `pg_db_list/create/delete/users_list/user_create/user_update/user_delete/user_grant/user_revoke` -> Task 4, all present, `canUse` gated.
- Cron: `cron_get/update/delete` -> Task 7 (`cron_get`/`cron_set`/`cron_delete`) plus `container_cron_get/set`.
- `enhance-database` skill -> Task 9. Live test B (PHP+MySQL, Laravel) -> Task 10.

**Placeholder scan:** no TBD/TODO; every code step contains the code; no "similar to Task N".

**Type consistency:** `Target.kind` extended once in Task 1 and used with the new members in Tasks 2-4, 7. `siteWebsite`/`resolveDbName`/`resolveDbUser`/`MYSQL_GRANTS` defined in Task 1, consumed unchanged in Tasks 2-7. `dbSite`/`pgSite`/`phpSite`/`htSite`/`cronSite` are per-file local helpers with the same `{ org, id, identity }` shape. Every tool group exports `tools: ToolDef[]`; `index.ts` (Task 8) imports each. Destructive tools all define `target()`+`preview()` (enforced by `defineTool` and asserted in Task 8).

**Deferred milestone A minors folded:** `client.ts:88` `safe()` and the `respond.ts` collapse-class extension in Task 1; the never-exposed guard re-checked in Task 8. Remaining milestone A minors that are not in a touched file stay deferred to a cleanup pass and are listed in `.superpowers/sdd/progress.md`.

**Open items for the live run (Task 10):** whether `db_import_sql` multipart upload works through `openapi-fetch` (the body is `FormData`; if the client rejects it, fall back to a raw `fetch` with the auth header, mirroring the milestone A text-body handling); the exact `postgresql-users` update verb (`PATCH` per the generated types; confirm live if PostgreSQL is enabled on any plan); and confirming the phpMyAdmin SSO URL is single-use.
