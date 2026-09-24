import * as z from 'zod/v4';
import type { ToolContext } from '../core/context.js';
import { defineTool, type Target, type ToolDef, type ToolResult } from '../core/registry.js';
import { fail, kv, ok, safe, table } from '../core/respond.js';
import type { Website } from '../core/resolver.js';
import { confirmedByReadNote, unknownOutcome, writeThenVerify } from '../core/verify.js';
import { dbTargetSite, generatePassword, resolveDbName, resolveDbUser, siteOf, siteWebsite, unixUserOf, websiteArg, type DbSite, type DbSiteWithUser } from './dbcommon.js';

const nameArg = z.string().min(1).describe('Database name (short, or the full <unixUser>_ prefixed form)');
const userArg = z.string().min(1).describe('Database user name (short, or the full <unixUser>_ prefixed form)');

/**
 * PostgreSQL is a per-plan feature: the panel reports it in `canUse.postgresql`, and on a plan
 * without it every `/postgresql-*` endpoint is there but answers with an error. Check the flag and
 * say so plainly instead of sending a request that can only fail — the MySQL tools are what this
 * plan actually has.
 */
function pgGate(site: DbSite, w: Website): ToolResult | undefined {
  if (w.canUse?.postgresql === true) return undefined;
  return fail(
    `${site.identity}\nPostgreSQL is not enabled for this website's plan (canUse.postgresql is not true), so nothing was sent to the panel. Ask the hosting provider to add it to the plan, or use MySQL instead with the db_* tools (db_list, db_create, db_user_create).`,
    { available: false },
  );
}

type PgSite = ({ ok: true } & DbSiteWithUser) | { ok: false; result: ToolResult };

/** The site plus its unix user, or the "not on this plan" result. Gate first, then act: the flag
 *  is checked before the unix user is demanded and before anything is sent to the panel. */
async function pgSite(ctx: ToolContext, website: string): Promise<PgSite> {
  const { org, w } = await siteWebsite(ctx, website);
  const site = siteOf(ctx, org, w);
  const gate = pgGate(site, w);
  return gate ? { ok: false, result: gate } : { ok: true, ...site, unixUser: unixUserOf(w) };
}

/** The `target()` form. A destructive tool has no result to return at this stage, so a plan
 *  without PostgreSQL refuses outright and the gate wrapper reports it. */
async function pgTarget(ctx: ToolContext, website: string): Promise<DbSiteWithUser> {
  const s = await pgSite(ctx, website);
  if (!s.ok) throw new Error("PostgreSQL is not enabled for this website's plan");
  return s;
}

/**
 * Convention 12 for the destructive tools: the site and the full name come from the target the
 * human confirmed, never from re-resolving the `website` argument. The plan flag is re-read on
 * that same website, so a feature removed between the preview and the confirmation stops the
 * write rather than being sent anyway.
 */
async function pgConfirmed(ctx: ToolContext, target: Target): Promise<{ site: DbSite; name: string; website: Website; gate: ToolResult | undefined }> {
  const { site, name, website } = await dbTargetSite(ctx, target);
  return { site, name, website, gate: pgGate(site, website) };
}

/** Every PostgreSQL database name on the site; the creates read it first and to settle an unclear
 *  answer, exactly as the MySQL tools do (mysqlDbNames). */
async function pgDbNames(ctx: ToolContext, s: DbSiteWithUser): Promise<string[]> {
  const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/postgresql-dbs', () => ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/postgresql-dbs', { params: { path: { org_id: s.org, website_id: s.id } } }));
  return (res.items ?? []).map((d) => d.name);
}

async function pgUserNames(ctx: ToolContext, s: DbSiteWithUser): Promise<string[]> {
  const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/postgresql-users', () => ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/postgresql-users', { params: { path: { org_id: s.org, website_id: s.id } } }));
  return (res.items ?? []).map((u) => u.username);
}

// Like the MySQL tools, none of these invalidates the resolver cache: it holds only the website
// list, and databases and users are not in it, so a write here cannot make it stale.
export const pgDbList = defineTool({
  name: 'pg_db_list',
  tier: 'customer',
  risk: 'read',
  description: 'Lists the PostgreSQL databases for a website, with size and how many users can access each. Requires PostgreSQL to be enabled on the plan; use db_list for MySQL.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await pgSite(ctx, website);
    if (!s.ok) return s.result;
    const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/postgresql-dbs', () =>
      ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/postgresql-dbs', { params: { path: { org_id: s.org, website_id: s.id } } }),
    );
    const items = (res.items ?? []).map((d) => ({ database: d.name, sizeBytes: d.size, users: d.userCount }));
    const rows = items.map((i) => ({ database: i.database, 'size (bytes)': i.sizeBytes, users: i.users }));
    return ok([s.identity, `postgresql databases (${items.length}):`, table(rows, ['database', 'size (bytes)', 'users'])].join('\n'), { total: items.length, items });
  },
});

export const pgDbCreate = defineTool({
  name: 'pg_db_create',
  tier: 'customer',
  risk: 'write',
  description: 'Creates a PostgreSQL database. The panel prefixes the name with the unix user, so "shop" becomes "<unixUser>_shop"; the full name is returned. Apps connect with host "localhost".',
  input: z.object({ website: websiteArg, name: nameArg }),
  async handler({ website, name }, ctx) {
    const s = await pgSite(ctx, website);
    if (!s.ok) return s.result;
    const full = resolveDbName(s.unixUser, name);
    // The panel adds the prefix itself, so send the short form even when the user typed the
    // full name; sending the prefixed name back would create `<unixUser>_<unixUser>_<name>`.
    const short = full.slice(s.unixUser.length + 1);
    if ((await pgDbNames(ctx, s)).includes(full)) {
      return fail(`${s.identity}\nPostgreSQL database ${safe(full)} already exists. Nothing was sent to the panel; use it, or pick another name.`, { database: full, created: false });
    }
    const outcome = await writeThenVerify({
      write: () => ctx.client.call('POST', '/orgs/{org_id}/websites/{website_id}/postgresql-dbs', () => ctx.client.api.POST('/orgs/{org_id}/websites/{website_id}/postgresql-dbs', { params: { path: { org_id: s.org, website_id: s.id } }, body: { name: short } })),
      find: async () => ((await pgDbNames(ctx, s)).includes(full) ? full : undefined),
      sleep: ctx.sleep,
    });
    if (outcome.state === 'unknown') {
      return unknownOutcome(s.identity, outcome, { action: `the create of PostgreSQL database ${safe(full)}`, settle: `pg_db_list website=${safe(website)}` }, { database: full, created: null });
    }
    return ok(
      [
        s.identity,
        `PostgreSQL database ${safe(full)} created.`,
        ...(outcome.confirmedBy === 'verify' ? [confirmedByReadNote(outcome.writeError)] : []),
        kv([
          ['connect from PHP', 'host DB_HOST=localhost'],
          ['next', `pg_user_create website=${safe(website)} to add a login, then pg_user_grant`],
        ]),
      ].join('\n'),
      { database: full, created: true },
    );
  },
});

export const pgDbDelete = defineTool({
  name: 'pg_db_delete',
  tier: 'customer',
  risk: 'destructive',
  description: 'DESTRUCTIVE. Permanently drops a PostgreSQL database and all its tables. Requires the user to confirm by typing the full database name. There is no soft delete for databases.',
  input: z.object({ website: websiteArg, name: nameArg }),
  async target({ website, name }, ctx) {
    const s = await pgTarget(ctx, website);
    const full = resolveDbName(s.unixUser, name);
    return { kind: 'pg_db', id: `${s.id}:${full}`, name: full };
  },
  async preview(_args, ctx, target) {
    const { site, name: database } = await pgConfirmed(ctx, target);
    // The identity block leads so the human confirming sees which site the database belongs to.
    return `${site.identity}\nThis will permanently drop PostgreSQL database ${safe(database)}. Every table and row is destroyed and cannot be restored from the panel; take a dump over SSH with pg_dump first if you need a backup.`;
  },
  async handler(_args, ctx, target) {
    const { site, name: database, gate } = await pgConfirmed(ctx, target!);
    if (gate) return gate;
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/postgresql-dbs/{db_name}', () =>
      ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/postgresql-dbs/{db_name}', { params: { path: { org_id: site.org, website_id: site.id, db_name: database } } }),
    );
    return ok(`${site.identity}\nPostgreSQL database ${safe(database)} dropped.`, { database, deleted: true });
  },
});

export const pgUsersList = defineTool({
  name: 'pg_users_list',
  tier: 'customer',
  risk: 'read',
  description: 'Lists PostgreSQL users for a website and the databases each one has privileges on.',
  input: z.object({ website: websiteArg }),
  async handler({ website }, ctx) {
    const s = await pgSite(ctx, website);
    if (!s.ok) return s.result;
    const res = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/postgresql-users', () =>
      ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/postgresql-users', { params: { path: { org_id: s.org, website_id: s.id } } }),
    );
    // structuredContent keeps the panel's own shape (`privs` is the list of databases this user is
    // an admin on), so a caller can act on it without re-parsing the table.
    const items = (res.items ?? []).map((u) => ({ user: u.username, databases: u.privs ?? [], createdAt: u.createdAt }));
    const rows = items.map((i) => ({ user: i.user, databases: i.databases.join(', ') || 'none' }));
    return ok([s.identity, `postgresql users (${items.length}):`, table(rows, ['user', 'databases'])].join('\n'), { total: items.length, items });
  },
});

export const pgUserCreate = defineTool({
  name: 'pg_user_create',
  tier: 'customer',
  risk: 'write',
  description: 'Creates a PostgreSQL user. The panel prefixes the name with the unix user. When no password is given a strong one is generated and returned once, in structuredContent. Apps connect with host "localhost".',
  input: z.object({ website: websiteArg, username: userArg, password: z.string().min(8).optional().describe('Optional; a strong password is generated when omitted') }),
  async handler({ website, username, password }, ctx) {
    const s = await pgSite(ctx, website);
    if (!s.ok) return s.result;
    const full = resolveDbUser(s.unixUser, username);
    // As with databases, the panel adds the prefix itself: send the short form (see pgDbCreate).
    const short = full.slice(s.unixUser.length + 1);
    // Checked first so a password is never handed back for a user that already existed.
    if ((await pgUserNames(ctx, s)).includes(full)) {
      return fail(`${s.identity}\nPostgreSQL user ${safe(full)} already exists. Nothing was sent to the panel; change its password with pg_user_update, or pick another name.`, { user: full, created: false });
    }
    const pw = password ?? generatePassword();
    const outcome = await writeThenVerify({
      write: () => ctx.client.call('POST', '/orgs/{org_id}/websites/{website_id}/postgresql-users', () => ctx.client.api.POST('/orgs/{org_id}/websites/{website_id}/postgresql-users', { params: { path: { org_id: s.org, website_id: s.id } }, body: { username: short, password: pw } })),
      find: async () => ((await pgUserNames(ctx, s)).includes(full) ? full : undefined),
      sleep: ctx.sleep,
    });
    if (outcome.state === 'unknown') {
      return unknownOutcome(
        s.identity,
        outcome,
        { action: `the create of PostgreSQL user ${safe(full)}`, settle: `pg_users_list website=${safe(website)}`, extra: 'If the user does appear, its password is the one in structuredContent.password (shown once); if it never appears, nothing was created.' },
        { user: full, created: null, password: pw, passwordNote: 'valid only if pg_users_list now shows this user' },
      );
    }
    return ok(
      [
        s.identity,
        `PostgreSQL user ${safe(full)} created.`,
        ...(outcome.confirmedBy === 'verify' ? [confirmedByReadNote(outcome.writeError)] : []),
        kv([
          ['password', 'shown once, in structuredContent.password; store it now'],
          ['connect from PHP', 'host DB_HOST=localhost'],
          ['next', `pg_user_grant website=${safe(website)} username=${safe(short)} database=<db>`],
        ]),
      ].join('\n'),
      { user: full, created: true, password: pw },
    );
  },
});

export const pgUserUpdate = defineTool({
  name: 'pg_user_update',
  tier: 'customer',
  risk: 'write',
  description: "Sets a PostgreSQL user's password. Every application using the old password stops connecting until it is updated. The new password is returned once, in structuredContent.",
  input: z.object({ website: websiteArg, username: userArg, password: z.string().min(8) }),
  async handler({ website, username, password }, ctx) {
    const s = await pgSite(ctx, website);
    if (!s.ok) return s.result;
    const full = resolveDbUser(s.unixUser, username);
    await ctx.client.call('PATCH', '/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}', () =>
      ctx.client.api.PATCH('/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}', { params: { path: { org_id: s.org, website_id: s.id, username: full } }, body: { password } }),
    );
    return ok(`${s.identity}\npassword for ${safe(full)} updated (shown once in structuredContent.password).`, { user: full, password });
  },
});

export const pgUserDelete = defineTool({
  name: 'pg_user_delete',
  tier: 'customer',
  risk: 'destructive',
  description: 'DESTRUCTIVE. Deletes a PostgreSQL user. Any app using this login stops working. Requires the user to confirm by typing the full user name.',
  input: z.object({ website: websiteArg, username: userArg }),
  async target({ website, username }, ctx) {
    const s = await pgTarget(ctx, website);
    const full = resolveDbUser(s.unixUser, username);
    return { kind: 'pg_user', id: `${s.id}:${full}`, name: full };
  },
  async preview(_args, ctx, target) {
    const { site, name: user } = await pgConfirmed(ctx, target);
    // The identity block leads so the human confirming sees which site the login belongs to.
    return `${site.identity}\nThis will delete PostgreSQL user ${safe(user)}. Any application or connection string using this login will fail immediately. The databases themselves are not touched.`;
  },
  async handler(_args, ctx, target) {
    const { site, name: user, gate } = await pgConfirmed(ctx, target!);
    if (gate) return gate;
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}', () =>
      ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}', { params: { path: { org_id: site.org, website_id: site.id, username: user } } }),
    );
    return ok(`${site.identity}\nPostgreSQL user ${safe(user)} deleted.`, { user, deleted: true });
  },
});

export const pgUserGrant = defineTool({
  name: 'pg_user_grant',
  tier: 'customer',
  risk: 'write',
  description: 'Grants a PostgreSQL user admin privileges on one database. PostgreSQL has no per-privilege panel enum the way MySQL does: the grant is all-or-nothing, and pg_user_revoke takes it away.',
  input: z.object({ website: websiteArg, username: userArg, database: nameArg }),
  async handler({ website, username, database }, ctx) {
    const s = await pgSite(ctx, website);
    if (!s.ok) return s.result;
    const user = resolveDbUser(s.unixUser, username);
    const db = resolveDbName(s.unixUser, database);
    // The request body is the database name itself, a bare JSON string rather than an object
    // (verified against the spec: `requestBody.content['application/json']` is `string`).
    await ctx.client.call('POST', '/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}/privileges', () =>
      ctx.client.api.POST('/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}/privileges', {
        params: { path: { org_id: s.org, website_id: s.id, username: user } },
        body: db,
      }),
    );
    return ok(`${s.identity}\n${safe(user)} now has admin privileges on ${safe(db)}.`, { user, database: db, granted: true });
  },
});

export const pgUserRevoke = defineTool({
  name: 'pg_user_revoke',
  tier: 'customer',
  risk: 'destructive',
  description: "DESTRUCTIVE. Revokes a PostgreSQL user's privileges on one database; any app connecting as that user loses access at once. Requires the user to confirm by typing the full user name.",
  input: z.object({ website: websiteArg, username: userArg, database: nameArg }),
  async target({ website, username }, ctx) {
    // Only the user is pinned by the target: the database is an ordinary argument, resolved
    // against the confirmed website's unix user in preview() and handler() below.
    const s = await pgTarget(ctx, website);
    const full = resolveDbUser(s.unixUser, username);
    return { kind: 'pg_user', id: `${s.id}:${full}`, name: full };
  },
  async preview({ database }, ctx, target) {
    const { site, name: user, website: w } = await pgConfirmed(ctx, target);
    const db = resolveDbName(unixUserOf(w), database);
    return `${site.identity}\nThis will revoke ${safe(user)}'s privileges on PostgreSQL database ${safe(db)}. Any application connecting as that user loses access at once. The database itself is not touched.`;
  },
  async handler({ database }, ctx, target) {
    const { site, name: user, website: w, gate } = await pgConfirmed(ctx, target!);
    if (gate) return gate;
    const db = resolveDbName(unixUserOf(w), database);
    await ctx.client.call('DELETE', '/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}/privileges/{db_name}', () =>
      ctx.client.api.DELETE('/orgs/{org_id}/websites/{website_id}/postgresql-users/{username}/privileges/{db_name}', {
        params: { path: { org_id: site.org, website_id: site.id, username: user, db_name: db } },
      }),
    );
    return ok(`${site.identity}\nrevoked ${safe(user)}'s privileges on ${safe(db)}.`, { user, database: db, revoked: true });
  },
});

/** What `src/tools/index.ts` registers (Task 8). */
export const tools: ToolDef[] = [pgDbList, pgDbCreate, pgDbDelete, pgUsersList, pgUserCreate, pgUserUpdate, pgUserDelete, pgUserGrant, pgUserRevoke];
