import { randomBytes } from 'node:crypto';
import { defaultPathSerializer, type PathSerializer } from 'openapi-fetch';
import * as z from 'zod/v4';
import { parseScalarText } from '../client/client.js';
import type { ToolContext } from '../core/context.js';
import { identityBlock, websiteHome } from '../core/identity.js';
import { defineTool, type Target, type ToolDef } from '../core/registry.js';
import { fail, kv, ok, safe, table } from '../core/respond.js';
import type { Website } from '../core/resolver.js';
import { MYSQL_GRANTS, resolveDbName, resolveDbUser, siteWebsite, siteWebsiteById, unixUserOf, websiteArg } from './dbcommon.js';

const nameArg = z.string().min(1).describe('Database name (short, or the full <unixUser>_ prefixed form)');
const userArg = z.string().min(1).describe('Database user name (short, or the full <unixUser>_ prefixed form)');

export interface DbSite {
  org: string;
  id: string;
  identity: string;
}

/** A site plus its unix user, for the tools that have to build a `<unixUser>_` prefixed name. */
export interface DbSiteWithUser extends DbSite {
  unixUser: string;
}

function siteOf(ctx: ToolContext, org: string, w: Website): DbSite {
  return { org, id: w.id, identity: identityBlock({ name: ctx.client.orgName, id: org }, w) };
}

/** The site plus the unix user, for every tool that turns the name the user typed into the full
 *  prefixed one. Fails loudly on a website without a unix user (see `unixUserOf`). */
export async function dbSite(ctx: ToolContext, website: string): Promise<DbSiteWithUser> {
  const { org, w } = await siteWebsite(ctx, website);
  return { ...siteOf(ctx, org, w), unixUser: unixUserOf(w) };
}

/**
 * Convention 12: a destructive `preview()`/`handler()` acts on the target it was handed. The
 * target id is `<websiteId>:<full db or user name>`, so split it and re-read that website by id
 * rather than resolving the user's `website` string again — otherwise the preview the human
 * confirmed and the drop that follows could land on different sites.
 */
export async function dbTargetSite(ctx: ToolContext, target: Target): Promise<{ site: DbSite; name: string }> {
  const cut = target.id.indexOf(':');
  if (cut <= 0) throw new Error(`malformed database target "${safe(target.id)}"`);
  const { org, w } = await siteWebsiteById(ctx, target.id.slice(0, cut));
  // No unix user is looked up here: the name is already the full prefixed one carried by
  // `target.id`, so only the create/user-facing paths need the prefix.
  return { site: siteOf(ctx, org, w), name: target.id.slice(cut + 1) };
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

// None of the database or database-user tools invalidates the resolver cache: it holds only the
// website list, and databases and users are not in it, so a write here cannot make it stale.
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
    const { site, name: database } = await dbTargetSite(ctx, target);
    // The identity block leads so the human confirming sees which site the database belongs to.
    return `${site.identity}\nThis will permanently drop MySQL database ${safe(database)}. Every table and row is destroyed and cannot be restored from the panel. Export first with db_export_sql if you need a backup.`;
  },
  async handler(_args, ctx, target) {
    const { site, name: database } = await dbTargetSite(ctx, target!);
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}', () =>
      ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}', { params: { path: { org_id: site.org, website_id: site.id, db_name: database } } }),
    );
    return ok(`${site.identity}\ndatabase ${safe(database)} dropped.`, { database, deleted: true });
  },
});

export const dbExportSql = defineTool({
  name: 'db_export_sql',
  tier: 'customer',
  // It writes a file on the server, so it is not a read-only tool.
  risk: 'write',
  description: "Creates a gzipped SQL backup of a MySQL database in the website's home directory on the server and returns its path. Fetch it with scp. Use before db_delete or db_import_sql.",
  input: z.object({ website: websiteArg, name: nameArg }),
  async handler({ website, name }, ctx) {
    // Unlike the other database tools this one needs the whole website record — the home
    // directory, the unix user and the server IP for the scp line — so it resolves the site here.
    const { org, w } = await siteWebsite(ctx, website);
    const s = siteOf(ctx, org, w);
    const unixUser = unixUserOf(w);
    const full = resolveDbName(unixUser, name);
    // Verified live 2026-09-06: the body is not the dump. The panel writes a gzipped dump into
    // the website's home directory and answers with that *filename* as a JSON string, so read it
    // as text and unquote it rather than letting the JSON parser hand back a non-object.
    const raw = await ctx.client.call<string>('GET', '/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}/sql', () =>
      ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/mysql-dbs/{db_name}/sql', { params: { path: { org_id: s.org, website_id: s.id, db_name: full } }, parseAs: 'text' }),
    );
    const file = parseScalarText(raw);
    // `parseScalarText` answers "unknown" for a body that is not a string and "" for an empty one.
    // Either way the panel named no backup, and `<home>/unknown` would send the caller after a
    // file that does not exist, so say so instead of rendering a path.
    if (file === '' || file === 'unknown') {
      return fail(`${s.identity}\nthe panel did not return a backup filename for ${safe(full)}, so there is no path to fetch. Nothing was downloaded; retry, or take the dump over SSH with mysqldump.`, { database: full });
    }
    const path = `${websiteHome(w)}/${file}`;
    const host = (w.serverIps?.find((ip) => ip.isPrimary) ?? w.serverIps?.[0])?.ip;
    // The panel's filenames carry a colon (`..._06-09-2026_01:29.sql.gz`), so the remote path is
    // single-quoted: unquoted, a colon or a space would split the argument in the user's shell.
    const scpCommand = host ? `scp -P 22 ${unixUser}@${host}:'${path}' .` : undefined;
    const text = [
      s.identity,
      `gzipped SQL backup of ${safe(full)} written on the server, in the website's home directory (mode 0600, outside the docroot).`,
      kv([
        ['path', path],
        ['fetch with', scpCommand ?? 'unavailable — this website has no server IP recorded'],
      ]),
      'old backups stay in the home directory and add up; remove the ones you no longer need over SSH.',
      "sandbox: Claude Code's Bash sandbox cannot open SSH connections. Run scp with the sandbox disabled for that command, or add \"scp\" to sandbox.excludedCommands in settings.",
    ].join('\n');
    return ok(text, { database: full, file, path, scpCommand });
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
    const { site, name: database } = await dbTargetSite(ctx, target);
    return `${site.identity}\nThis will run ${Buffer.byteLength(sql)} bytes of SQL against MySQL database ${safe(database)}. Statements such as DROP TABLE and TRUNCATE destroy data and cannot be undone from the panel. Export first with db_export_sql.`;
  },
  async handler({ sql, force }, ctx, target) {
    const { site, name: database } = await dbTargetSite(ctx, target!);
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

/**
 * A password for a database login the human never types: 24 random bytes (192 bits) as base64url,
 * which is always exactly 32 characters and, unlike base64, never contains `+`, `/` or `=` — so
 * nothing is stripped and the length is fixed rather than probabilistic. The `Db`/`9x` frame
 * guarantees an upper case letter, a lower case one and a digit for any password policy (the live
 * panel enforces none), and every character is safe unquoted in a `.env` file and inside shell
 * double quotes: no `!`, `$`, backtick or quote. Always 36 characters.
 */
function generatePassword(): string {
  return `Db${randomBytes(24).toString('base64url')}9x`;
}

export const dbUsersList = defineTool({
  name: 'db_users_list',
  tier: 'customer',
  risk: 'read',
  description: 'Lists MySQL users for a website, with the hosts each may connect from and the databases they can access.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await dbSite(ctx, website);
    const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/mysql-users', () =>
      ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/mysql-users', { params: { path: { org_id: s.org, website_id: s.id } } }),
    );
    const items = (res.items ?? []).map((u) => ({
      user: u.username,
      accessHosts: u.accessHosts ?? [],
      // The generated type renders the panel's open-ended map as `Record<string, never>`; the
      // live payload is database name -> list of privileges (noted cast, convention 6). Keeping
      // the map intact lets a caller read the privileges, which the table only summarises.
      grants: (u.grants ?? {}) as Record<string, string[]>,
      authPlugin: u.authPlugin,
      ephemeral: u.isEphemeral ?? false,
    }));
    const rows = items.map((i) => ({
      user: i.user,
      'access hosts': i.accessHosts.join(', ') || 'none',
      databases: Object.keys(i.grants).join(', ') || 'none',
      auth: i.authPlugin,
      ephemeral: i.ephemeral ? 'yes' : 'no',
    }));
    return ok([s.identity, `users (${items.length}):`, table(rows, ['user', 'access hosts', 'databases', 'auth', 'ephemeral'])].join('\n'), { total: items.length, items });
  },
});

export const dbUserCreate = defineTool({
  name: 'db_user_create',
  tier: 'customer',
  risk: 'write',
  description: 'Creates a MySQL user. The panel prefixes the name with the unix user. When no password is given a strong one is generated and returned once, in structuredContent. Apps connect with host "localhost".',
  input: z.object({ website: websiteArg, username: userArg, password: z.string().min(8).optional().describe('Optional; a strong password is generated when omitted') }),
  async handler({ website, username, password }, ctx) {
    const s = await dbSite(ctx, website);
    const full = resolveDbUser(s.unixUser, username);
    // As with databases, the panel adds the prefix itself: send the short form (see dbCreate).
    const short = full.slice(s.unixUser.length + 1);
    const pw = password ?? generatePassword();
    await ctx.client.call('POST', '/orgs/{org_id}/websites/{website_id}/mysql-users', () =>
      ctx.client.api.POST('/orgs/{org_id}/websites/{website_id}/mysql-users', { params: { path: { org_id: s.org, website_id: s.id } }, body: { username: short, password: pw } }),
    );
    return ok(
      [
        s.identity,
        `MySQL user ${safe(full)} created.`,
        kv([
          ['password', 'shown once, in structuredContent.password; store it now'],
          ['connect from PHP', 'host DB_HOST=localhost'],
          ['next', `db_user_set_privileges website=${safe(website)} username=${safe(short)} database=<db> grants=all`],
        ]),
      ].join('\n'),
      { user: full, password: pw },
    );
  },
});

export const dbUserUpdate = defineTool({
  name: 'db_user_update',
  tier: 'customer',
  risk: 'write',
  description: "Sets a MySQL user's password. Every application using the old password stops connecting until it is updated. The new password is returned once, in structuredContent.",
  input: z.object({ website: websiteArg, username: userArg, password: z.string().min(8) }),
  async handler({ website, username, password }, ctx) {
    const s = await dbSite(ctx, website);
    const full = resolveDbUser(s.unixUser, username);
    await ctx.client.call('PUT', '/orgs/{org_id}/websites/{website_id}/mysql-users/{username}', () =>
      ctx.client.api.PUT('/orgs/{org_id}/websites/{website_id}/mysql-users/{username}', { params: { path: { org_id: s.org, website_id: s.id, username: full } }, body: { password } }),
    );
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
    const full = resolveDbUser(s.unixUser, username);
    return { kind: 'mysql_user', id: `${s.id}:${full}`, name: full };
  },
  async preview(_args, ctx, target) {
    const { site, name: user } = await dbTargetSite(ctx, target);
    // The identity block leads so the human confirming sees which site the login belongs to.
    return `${site.identity}\nThis will delete MySQL user ${safe(user)}. Any application or connection string using this login will fail immediately. The databases themselves are not touched.`;
  },
  async handler(_args, ctx, target) {
    const { site, name: user } = await dbTargetSite(ctx, target!);
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/mysql-users/{username}', () =>
      ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/mysql-users/{username}', { params: { path: { org_id: site.org, website_id: site.id, username: user } } }),
    );
    return ok(`${site.identity}\nMySQL user ${safe(user)} deleted.`, { user, deleted: true });
  },
});

export const dbUserSetPrivileges = defineTool({
  name: 'db_user_set_privileges',
  tier: 'customer',
  risk: 'write',
  description:
    "Sets a MySQL user's privileges on one database, replacing whatever grants that user had on it. Grants come from the panel's fixed lowercase set (all, select, insert, update, delete, create, drop, alter, index, references, ...), not SQL text; use ['all'] for a typical app user.",
  input: z.object({ website: websiteArg, username: userArg, database: nameArg, grants: z.array(z.enum(MYSQL_GRANTS)).min(1) }),
  async handler({ website, username, database, grants }, ctx) {
    const s = await dbSite(ctx, website);
    const user = resolveDbUser(s.unixUser, username);
    const db = resolveDbName(s.unixUser, database);
    await ctx.client.call('PUT', '/orgs/{org_id}/websites/{website_id}/mysql-users/{username}/privileges', () =>
      ctx.client.api.PUT('/orgs/{org_id}/websites/{website_id}/mysql-users/{username}/privileges', {
        params: { path: { org_id: s.org, website_id: s.id, username: user } },
        body: { dbName: db, grants },
      }),
    );
    return ok(`${s.identity}\n${safe(user)} now has [${grants.map(safe).join(', ')}] on ${safe(db)}.`, { user, database: db, grants });
  },
});

export const dbUserAccessHostsAdd = defineTool({
  name: 'db_user_access_hosts_add',
  tier: 'customer',
  risk: 'write',
  description:
    "Adds hosts a MySQL user may connect from. The panel adds the hosts given rather than replacing the list, so the hosts the user already had stay; db_users_list shows the full list afterwards. A new user already has the app tier's host, which is what a PHP app on this website connects from; only add a host when the user connects from somewhere else. Remove one again with db_user_access_hosts_remove.",
  input: z.object({ website: websiteArg, username: userArg, hosts: z.array(z.string().min(1)).min(1).describe('Host names or IPs to add to the hosts the user may connect from') }),
  async handler({ website, username, hosts }, ctx) {
    const s = await dbSite(ctx, website);
    const user = resolveDbUser(s.unixUser, username);
    await ctx.client.call('POST', '/orgs/{org_id}/websites/{website_id}/mysql-users/{username}/access-hosts', () =>
      ctx.client.api.POST('/orgs/{org_id}/websites/{website_id}/mysql-users/{username}/access-hosts', {
        params: { path: { org_id: s.org, website_id: s.id, username: user } },
        body: { accessHosts: hosts },
      }),
    );
    return ok(`${s.identity}\nadded hosts [${hosts.map(safe).join(', ')}] for ${safe(user)}; db_users_list shows the full list.`, { user, added: hosts });
  },
});

export const dbUserAccessHostsRemove = defineTool({
  name: 'db_user_access_hosts_remove',
  tier: 'customer',
  // Reversible with db_user_access_hosts_add, so it is a write rather than a destructive tool:
  // nothing is destroyed, the login and its grants stay, and the host can be put straight back.
  risk: 'write',
  description:
    "Removes hosts a MySQL user may connect from, leaving every other host on the list alone; db_users_list shows the full list afterwards. WARNING: 10.169.0.1 is the app tier host a new user gets by default and is where this website's own PHP applications connect from — removing it locks them out of the database until it is added back with db_user_access_hosts_add. Check db_users_list first.",
  input: z.object({ website: websiteArg, username: userArg, hosts: z.array(z.string().min(1)).min(1).describe('Host names or IPs to remove from the hosts the user may connect from') }),
  async handler({ website, username, hosts }, ctx) {
    const s = await dbSite(ctx, website);
    const user = resolveDbUser(s.unixUser, username);
    // Verified live 2026-09-06: the same path as the add, with the same body, removes exactly the
    // hosts listed. The hosts travel in the DELETE body, not in the path or the query string.
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/mysql-users/{username}/access-hosts', () =>
      ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/mysql-users/{username}/access-hosts', {
        params: { path: { org_id: s.org, website_id: s.id, username: user } },
        body: { accessHosts: hosts },
      }),
    );
    return ok(`${s.identity}\nremoved hosts [${hosts.map(safe).join(', ')}] for ${safe(user)}; db_users_list shows the full list.`, { user, removed: hosts });
  },
});

export const mysqlDatabaseTools: ToolDef[] = [dbList, dbCreate, dbDelete, dbExportSql, dbImportSql, dbPhpmyadminUrl];
export const mysqlUserTools: ToolDef[] = [dbUsersList, dbUserCreate, dbUserUpdate, dbUserDelete, dbUserSetPrivileges, dbUserAccessHostsAdd, dbUserAccessHostsRemove];

/** What `src/tools/index.ts` registers (Task 8). */
export const tools: ToolDef[] = [...mysqlDatabaseTools, ...mysqlUserTools];
