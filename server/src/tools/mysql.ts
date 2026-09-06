import type { PathSerializer } from 'openapi-fetch';
import * as z from 'zod/v4';
import { parseScalarText } from '../client/client.js';
import type { ToolContext } from '../core/context.js';
import { identityBlock } from '../core/identity.js';
import { defineTool, type ToolDef } from '../core/registry.js';
import { kv, ok, safe, table } from '../core/respond.js';
import { resolveDbName, siteWebsite, unixUserOf, websiteArg } from './dbcommon.js';

const nameArg = z.string().min(1).describe('Database name (short, or the full <unixUser>_ prefixed form)');

export interface DbSite {
  org: string;
  unixUser: string;
  id: string;
  identity: string;
}

/** Every db tool needs the site (for the org, the unix user prefix and the identity block). */
export async function dbSite(ctx: ToolContext, website: string): Promise<DbSite> {
  const { org, w } = await siteWebsite(ctx, website);
  return { org, unixUser: unixUserOf(w), id: w.id, identity: identityBlock({ name: ctx.client.orgName, id: org }, w) };
}

/**
 * The SQL upload is the one operation whose path template disagrees with its own parameter
 * declaration: the template is `/v2/websites/{websiteId}/mysql/{db_id}/sql` while the operation
 * declares `website_id` and `db_name`. openapi-fetch's default serializer looks the placeholders
 * up by name, finds neither, and would leave both literals in the URL, so substitute them here.
 */
const uploadSqlPath: PathSerializer = (pathname, params) =>
  pathname.replace('{websiteId}', encodeURIComponent(String(params['website_id']))).replace('{db_id}', encodeURIComponent(String(params['db_name'])));

export const dbList = defineTool({
  name: 'db_list',
  tier: 'customer',
  risk: 'read',
  description: 'Lists the MySQL databases for a website, with size and how many users can access each. Database names are shown in full (the panel prefixes them with the unix user).',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await dbSite(ctx, website);
    const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/mysql-dbs', () =>
      ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/mysql-dbs', { params: { path: { org_id: s.org, website_id: s.id } } }),
    );
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
    // The panel adds the prefix itself, so send the short form even when the user typed the
    // full name; sending the prefixed name back would create `<unixUser>_<unixUser>_<name>`.
    const short = full.slice(s.unixUser.length + 1);
    await ctx.client.call('POST', '/orgs/{org_id}/websites/{website_id}/mysql-dbs', () =>
      ctx.client.api.POST('/orgs/{org_id}/websites/{website_id}/mysql-dbs', { params: { path: { org_id: s.org, website_id: s.id } }, body: { name: short } }),
    );
    ctx.resolver.invalidate();
    return ok(
      [
        s.identity,
        `database ${safe(full)} created.`,
        kv([
          ['connect from PHP', 'host DB_HOST=localhost, socket; not 127.0.0.1'],
          ['next', `db_user_create website=${safe(website)} to add a login, then db_user_set_privileges`],
        ]),
      ].join('\n'),
      { database: full, created: true },
    );
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
    const full = resolveDbName(s.unixUser, name);
    return { kind: 'mysql_db', id: `${s.id}:${full}`, name: full };
  },
  async preview({ website }, ctx, target) {
    const s = await dbSite(ctx, website);
    return `This will permanently drop MySQL database ${safe(target.name)} on ${safe(s.identity.split('\n')[0])}. Every table and row is destroyed and cannot be restored from the panel. Export first with db_export_sql if you need a backup.`;
  },
  async handler({ website }, ctx, target) {
    const s = await dbSite(ctx, website);
    const dbName = target!.name;
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}', () =>
      ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}', { params: { path: { org_id: s.org, website_id: s.id, db_name: dbName } } }),
    );
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
    // The panel sends the dump as a JSON string, so read it as text and unquote it rather than
    // letting the JSON parser hand back a value that is not the object the types promise.
    const raw = await ctx.client.call<string>('GET', '/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}/sql', () =>
      ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}/sql', { params: { path: { org_id: s.org, website_id: s.id, db_name: full } }, parseAs: 'text' }),
    );
    const sql = parseScalarText(raw);
    return ok(`${s.identity}\nSQL export of ${safe(full)} (${sql.length} bytes) returned in structuredContent.sql.`, { database: full, bytes: sql.length, sql });
  },
});

export const dbImportSql = defineTool({
  name: 'db_import_sql',
  tier: 'customer',
  risk: 'destructive',
  description: 'DESTRUCTIVE. Runs a SQL file against a MySQL database, overwriting whatever the statements touch (DROP/CREATE/INSERT). Requires the user to confirm by typing the full database name. Export first with db_export_sql.',
  input: z.object({
    website: websiteArg,
    name: nameArg,
    sql: z.string().min(1).describe('The SQL to execute'),
    force: z.boolean().default(false).describe('Keep executing after a statement fails (the panel force flag)'),
  }),
  async target({ website, name }, ctx) {
    const s = await dbSite(ctx, website);
    const full = resolveDbName(s.unixUser, name);
    return { kind: 'mysql_db', id: `${s.id}:${full}`, name: full };
  },
  async preview({ website, sql }, ctx, target) {
    const s = await dbSite(ctx, website);
    return `This will run ${sql.length} bytes of SQL against MySQL database ${safe(target.name)} on ${safe(s.identity.split('\n')[0])}. Statements such as DROP TABLE and TRUNCATE destroy data and cannot be undone from the panel. Export first with db_export_sql.`;
  },
  async handler({ website, sql, force }, ctx, target) {
    const s = await dbSite(ctx, website);
    const full = target!.name;
    await ctx.client.call('POST', '/v2/websites/{websiteId}/mysql/{db_id}/sql', () =>
      ctx.client.api.POST('/v2/websites/{websiteId}/mysql/{db_id}/sql', {
        params: { path: { website_id: s.id, db_name: full }, query: force ? { force: true } : {} },
        pathSerializer: uploadSqlPath,
        // The endpoint takes a multipart upload, not a JSON body: build the form here so the
        // typed body stays the `{ sql }` the spec declares. The spec marks the request body
        // optional, so `b` is nullable to openapi-fetch even though it is always sent below.
        bodySerializer: (b) => {
          const form = new FormData();
          form.set('sql', new Blob([b?.sql ?? sql]), `${full}.sql`);
          return form;
        },
        body: { sql },
      }),
    );
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
    // Both endpoints answer with the URL as a JSON string body (see dbExportSql).
    const raw = name
      ? await ctx.client.call<string>('GET', '/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}/sso', () =>
          ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}/sso', {
            params: { path: { org_id: s.org, website_id: s.id, db_name: resolveDbName(s.unixUser, name) }, query: { shouldRedirect: false } },
            parseAs: 'text',
          }),
        )
      : await ctx.client.call<string>('GET', '/orgs/{org_id}/websites/{website_id}/phpmyadmin', () =>
          ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/phpmyadmin', { params: { path: { org_id: s.org, website_id: s.id }, query: { shouldRedirect: false } }, parseAs: 'text' }),
        );
    const url = parseScalarText(raw);
    return ok(`${s.identity}\nphpMyAdmin sign-on URL (single use, opens logged in) returned in structuredContent.url.`, { url });
  },
});

/** Task 3 appends the MySQL user tools; `tools` is what `src/tools/index.ts` registers. */
export const mysqlDatabaseTools: ToolDef[] = [dbList, dbCreate, dbDelete, dbExportSql, dbImportSql, dbPhpmyadminUrl];

export const tools: ToolDef[] = [...mysqlDatabaseTools];
