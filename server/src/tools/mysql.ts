import { chmodSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { defaultPathSerializer, type PathSerializer } from 'openapi-fetch';
import * as z from 'zod/v4';
import { parseScalarText } from '../client/client.js';
import type { ToolContext } from '../core/context.js';
import { identityBlock } from '../core/identity.js';
import { defineTool, type Target, type ToolDef } from '../core/registry.js';
import { fail, kv, ok, safe, table } from '../core/respond.js';
import type { Website } from '../core/resolver.js';
import { resolveDbName, siteWebsite, siteWebsiteById, unixUserOf, websiteArg } from './dbcommon.js';

const nameArg = z.string().min(1).describe('Database name (short, or the full <unixUser>_ prefixed form)');

/** How much SQL may ride back inside a tool response before the caller must save it to a file
 *  instead. A dump past this fills the transcript with data nobody reads. */
export const MAX_INLINE_SQL_BYTES = 262_144;

export interface DbSite {
  org: string;
  unixUser: string;
  id: string;
  identity: string;
}

function siteOf(ctx: ToolContext, org: string, w: Website): DbSite {
  return { org, unixUser: unixUserOf(w), id: w.id, identity: identityBlock({ name: ctx.client.orgName, id: org }, w) };
}

/** Every db tool needs the site (for the org, the unix user prefix and the identity block). */
export async function dbSite(ctx: ToolContext, website: string): Promise<DbSite> {
  const { org, w } = await siteWebsite(ctx, website);
  return siteOf(ctx, org, w);
}

/**
 * Convention 12: a destructive `preview()`/`handler()` acts on the target it was handed. The
 * target id is `<websiteId>:<full db name>`, so split it and re-read that website by id rather
 * than resolving the user's `website` string again — otherwise the preview the human confirmed
 * and the drop that follows could land on different sites.
 */
export async function dbTargetSite(ctx: ToolContext, target: Target): Promise<{ site: DbSite; database: string }> {
  const cut = target.id.indexOf(':');
  if (cut <= 0) throw new Error(`malformed database target "${safe(target.id)}"`);
  const { org, w } = await siteWebsiteById(ctx, target.id.slice(0, cut));
  return { site: siteOf(ctx, org, w), database: target.id.slice(cut + 1) };
}

/**
 * The SQL upload is the one operation whose path template disagrees with its own parameter
 * declaration: the template is `/v2/websites/{websiteId}/mysql/{db_id}/sql` while the operation
 * declares `website_id` and `db_name`. openapi-fetch's default serializer looks the placeholders
 * up by name, finds neither, and would leave both literals in the URL, so substitute them here.
 * If the spec is ever fixed, those literals are gone and whatever placeholders remain are named
 * after the declared parameters, so hand the rest to openapi-fetch's own serializer.
 */
const uploadSqlPath: PathSerializer = (pathname, params) => {
  const patched = pathname.replace('{websiteId}', encodeURIComponent(String(params['website_id']))).replace('{db_id}', encodeURIComponent(String(params['db_name'])));
  return patched.includes('{') ? defaultPathSerializer(patched, params) : patched;
};

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
    const items = (res.items ?? []).map((d) => ({ database: d.name, sizeBytes: d.size, users: d.userCount }));
    const rows = items.map((i) => ({ database: i.database, 'size (bytes)': i.sizeBytes, users: i.users }));
    return ok([s.identity, `databases (${items.length}):`, table(rows, ['database', 'size (bytes)', 'users'])].join('\n'), { total: items.length, items });
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
  async preview(_args, ctx, target) {
    const { site, database } = await dbTargetSite(ctx, target);
    // The identity block leads so the human confirming sees which site the database belongs to.
    return `${site.identity}\nThis will permanently drop MySQL database ${safe(database)}. Every table and row is destroyed and cannot be restored from the panel. Export first with db_export_sql if you need a backup.`;
  },
  async handler(_args, ctx, target) {
    const { site, database } = await dbTargetSite(ctx, target!);
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}', () =>
      ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}', { params: { path: { org_id: site.org, website_id: site.id, db_name: database } } }),
    );
    ctx.resolver.invalidate();
    return ok(`${site.identity}\ndatabase ${safe(database)} dropped.`, { database, deleted: true });
  },
});

export const dbExportSql = defineTool({
  name: 'db_export_sql',
  tier: 'customer',
  risk: 'read',
  description: `Exports a MySQL database as SQL. Use it to back up before db_delete or db_import_sql, or to move a database. Without save_to the dump comes back in structuredContent.sql, but only up to ${MAX_INLINE_SQL_BYTES} bytes (256 KB); a larger dump is refused with its size, and you must call again with save_to. With save_to the dump is written to that absolute local path at mode 0600 and kept out of the response.`,
  input: z.object({
    website: websiteArg,
    name: nameArg,
    save_to: z.string().min(1).optional().describe('Absolute local file path to write the dump to instead of returning it. The parent directory must already exist.'),
    overwrite: z.boolean().default(false).describe('Allow save_to to replace a file that already exists'),
  }),
  async handler({ website, name, save_to, overwrite }, ctx) {
    const s = await dbSite(ctx, website);
    const full = resolveDbName(s.unixUser, name);
    if (save_to !== undefined && !isAbsolute(save_to)) {
      return fail(`${s.identity}\nsave_to must be an absolute path; ${safe(save_to)} is relative and nothing was written.`, { database: full, saved: false });
    }
    // The panel sends the dump as a JSON string, so read it as text and unquote it rather than
    // letting the JSON parser hand back a value that is not the object the types promise.
    const raw = await ctx.client.call<string>('GET', '/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}/sql', () =>
      ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}/sql', { params: { path: { org_id: s.org, website_id: s.id, db_name: full } }, parseAs: 'text' }),
    );
    const sql = parseScalarText(raw);
    const bytes = Buffer.byteLength(sql);
    if (save_to === undefined) {
      if (bytes > MAX_INLINE_SQL_BYTES) {
        return fail(
          `${s.identity}\nSQL export of ${safe(full)} is ${bytes} bytes, over the ${MAX_INLINE_SQL_BYTES}-byte inline limit. Call db_export_sql again with save_to=<absolute local file path> to write it to a file instead.`,
          { database: full, bytes, tooLarge: true },
        );
      }
      return ok(`${s.identity}\nSQL export of ${safe(full)} (${bytes} bytes) returned in structuredContent.sql.`, { database: full, bytes, sql });
    }
    try {
      // `wx` makes "already there" an atomic refusal rather than a stat-then-clobber race; the
      // explicit chmod matters on the overwrite path, where the mode option is not applied.
      writeFileSync(save_to, sql, { mode: 0o600, flag: overwrite ? 'w' : 'wx' });
      chmodSync(save_to, 0o600);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        return fail(`${s.identity}\n${safe(save_to)} already exists and was left untouched. Pass overwrite=true to replace it, or choose another path.`, { database: full, bytes, saved: false });
      }
      if (code === 'ENOENT') {
        return fail(`${s.identity}\nthe directory for ${safe(save_to)} does not exist, so nothing was written. Create it first, or choose a path under a directory that exists.`, { database: full, bytes, saved: false });
      }
      throw e;
    }
    return ok(`${s.identity}\nSQL export of ${safe(full)} written to ${safe(save_to)} (${bytes} bytes, mode 0600). It is not in structuredContent.`, { database: full, bytes, path: save_to, saved: true });
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
  async preview({ sql }, ctx, target) {
    const { site, database } = await dbTargetSite(ctx, target);
    return `${site.identity}\nThis will run ${Buffer.byteLength(sql)} bytes of SQL against MySQL database ${safe(database)}. Statements such as DROP TABLE and TRUNCATE destroy data and cannot be undone from the panel. Export first with db_export_sql.`;
  },
  async handler({ sql, force }, ctx, target) {
    const { site, database } = await dbTargetSite(ctx, target!);
    const bytes = Buffer.byteLength(sql);
    await ctx.client.call('POST', '/v2/websites/{websiteId}/mysql/{db_id}/sql', () =>
      ctx.client.api.POST('/v2/websites/{websiteId}/mysql/{db_id}/sql', {
        params: { path: { website_id: site.id, db_name: database }, query: force ? { force: true } : {} },
        pathSerializer: uploadSqlPath,
        // The endpoint takes a multipart upload, not a JSON body: build the form here so the
        // typed body stays the `{ sql }` the spec declares. The spec marks the request body
        // optional, so `b` is nullable to openapi-fetch even though it is always sent below.
        bodySerializer: (b) => {
          const form = new FormData();
          form.set('sql', new Blob([b!.sql]), `${database}.sql`);
          return form;
        },
        body: { sql },
      }),
    );
    return ok(`${site.identity}\nran ${bytes} bytes of SQL against ${safe(database)}.`, { database, imported: true, bytes });
  },
});

export const dbPhpmyadminUrl = defineTool({
  name: 'db_phpmyadmin_url',
  tier: 'customer',
  risk: 'read',
  description: 'Returns a single-use phpMyAdmin sign-on URL for the website (or a specific database). The URL logs the user straight in; treat it like a password and do not post it anywhere.',
  input: z.object({ website: websiteArg, name: nameArg.optional().describe('Optional database name to open directly (short, or the full <unixUser>_ prefixed form)') }),
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
