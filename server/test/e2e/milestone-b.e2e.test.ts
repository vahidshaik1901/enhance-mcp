import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { requireOrg, type ToolContext } from '../../src/core/context.js';
import { GateError } from '../../src/core/gate.js';
import type { ToolDef, ToolResult } from '../../src/core/registry.js';
import { assertRequired } from './contract.js';

const enabled = process.env['ENHANCE_E2E'] === '1';
const suite = enabled ? describe : describe.skip;

function tool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

/** The two halves of the crontab listing, as `cron_get` puts the panel's own union in
 *  `structuredContent.items`. Only the command half carries an expression to match on. */
interface CronRow {
  cronCmd?: { lineNumber: number; expr: string };
  variable?: { lineNumber: number; key: string; val: string };
}

suite('milestone B against the live panel', () => {
  let ctx: ToolContext;
  let tools: ToolDef[];
  /**
   * The site every tool here addresses. Unlike milestone A, this suite creates no website: it
   * works inside an existing one, so it takes its own `ENHANCE_E2E_SITE` ("an existing website")
   * rather than milestone A's `ENHANCE_E2E_DOMAIN` ("a free domain to create"), and `beforeAll`
   * refuses to run without it. Nothing that belongs to the site is touched — every write this
   * suite makes is a randomly named `mcpb…` resource it created itself.
   */
  let site: string;
  // Exactly five hex characters, so the database and user names are the documented
  // `<unixUser>_mcpb<5>` shape and nothing depends on how many digits Math.random() drops.
  const slug = `mcpb${randomBytes(3).toString('hex').slice(0, 5)}`;
  const cronMarker = `mcp-e2e-${slug}`;
  const cronJob = `17 3 * * * /bin/true # ${cronMarker}`;
  // The exact full names the panel gave back, recorded so cleanup can only ever act on the two
  // resources this run created. They are deliberately NOT cleared after the delete test: the
  // cleanup below checks the live listings first, so a name that is already gone is skipped.
  let fullDb: string | undefined;
  let fullUser: string | undefined;
  let cronLineNumber: number | undefined;

  // Live suite only: call tools directly against the live-panel `ctx`, parsing through the tool's
  // own schema (convention 1) without the fake-panel helpers the unit suite uses.
  async function call<A>(t: ToolDef<A>, args: unknown): Promise<ToolResult> {
    return t.handler(t.input.parse(args), ctx);
  }

  async function listedDatabases(): Promise<string[]> {
    const r = await call(tool(tools, 'db_list'), { website: site });
    return (r.structured as { items: Array<{ database: string }> }).items.map((d) => d.database);
  }

  async function listedUsers(): Promise<string[]> {
    const r = await call(tool(tools, 'db_users_list'), { website: site });
    return (r.structured as { items: Array<{ user: string }> }).items.map((u) => u.user);
  }

  /** The crontab line holding this run's marker, or undefined when the panel no longer has it. */
  async function markerLine(): Promise<number | undefined> {
    const r = await call(tool(tools, 'cron_get'), { website: site });
    const items = (r.structured as { items?: CronRow[] }).items ?? [];
    return items.find((i) => i.cronCmd?.expr.includes(cronMarker))?.cronCmd?.lineNumber;
  }

  beforeAll(async () => {
    ({ ctx, tools } = await bootstrap(process.env));
    site = process.env['ENHANCE_E2E_SITE'] ?? '';
    expect(site, 'ENHANCE_E2E_SITE must name an existing website (e.g. vahi.dev) for the milestone B live suite; it creates throwaway mcpb… databases, users and one cron line on that site').toBeTruthy();
    // A read-only registry never registers db_create and friends, so say why here instead of
    // failing several lines later with a bare "tool db_create not registered".
    expect(ctx.config.readOnly, 'ENHANCE_READ_ONLY is set: the milestone B live suite needs the write and destructive tools, which a read-only registry does not register').toBe(false);
  });

  afterAll(async () => {
    // `beforeAll` refused before it could name a site: there is nothing this run created.
    if (!site) return;
    // Cleanup deliberately bypasses the confirmation gate: it calls the destructive tools'
    // target()/handler() directly, and only ever for the exact full names this run recorded and
    // that the live listing still shows. A name that is already gone (the delete test ran) is
    // skipped rather than re-sent, so cleanup cannot turn a passing run red on a 404.
    // Each of the three steps is guarded on its own: a step that fails prints one line naming
    // exactly what is left on the panel, and the next step still runs, so one error (an expired
    // credential mid-run, say) cannot strand the other two resources as well.
    try {
      if (fullUser && (await listedUsers()).includes(fullUser)) {
        const del = tool(tools, 'db_user_delete');
        const args = del.input.parse({ website: site, username: fullUser });
        const target = await del.target!(args, ctx).catch(() => undefined);
        if (target?.name === fullUser) await del.handler(args, ctx, target);
      }
    } catch (e) {
      console.error(`e2e cleanup: could not remove the MySQL user ${fullUser}; delete it by hand: ${(e as Error).message}`);
    }
    try {
      if (fullDb && (await listedDatabases()).includes(fullDb)) {
        const del = tool(tools, 'db_delete');
        const args = del.input.parse({ website: site, name: fullDb });
        const target = await del.target!(args, ctx).catch(() => undefined);
        if (target?.name === fullDb) await del.handler(args, ctx, target);
      }
    } catch (e) {
      console.error(`e2e cleanup: could not remove the MySQL database ${fullDb}; delete it by hand: ${(e as Error).message}`);
    }
    // The cron line is found by this run's own marker, never by the number recorded earlier: the
    // panel renumbers the file after every removal, so a stale number could name someone else's
    // job. cron_delete is never used here — it would wipe the whole customer crontab.
    try {
      const line = await markerLine();
      if (line !== undefined) await call(tool(tools, 'cron_remove'), { website: site, line_numbers: [line] });
    } catch (e) {
      console.error(`e2e cleanup: could not remove the cron line marked ${cronMarker}; delete it by hand: ${(e as Error).message}`);
    }
    // The gzipped dump db_export_sql wrote stays in the website's home directory on purpose:
    // removing it needs SSH, which this harness has no key for. It is 0600 and outside the
    // docroot; delete the `sql_backup_…mcpb….sql.gz` files by hand over SSH if they pile up.
  });

  it('db_create, db_user_create and db_user_set_privileges round-trip through the listings, export and phpMyAdmin SSO', async () => {
    const created = await call(tool(tools, 'db_create'), { website: site, name: slug });
    expect(created.isError, created.text).toBeFalsy();
    fullDb = (created.structured as { database: string }).database;
    // The panel prefixes every name with `<unixUser>_`, so the full name is the short one it was
    // asked for with a prefix in front — that is what every later call has to use.
    expect(fullDb.endsWith(`_${slug}`), `db_create returned ${fullDb}, which is not <unixUser>_${slug}`).toBe(true);

    const u = await call(tool(tools, 'db_user_create'), { website: site, username: slug });
    expect(u.isError, u.text).toBeFalsy();
    const user = u.structured as { user: string; password: string };
    fullUser = user.user;
    expect(fullUser.endsWith(`_${slug}`), `db_user_create returned ${fullUser}, which is not <unixUser>_${slug}`).toBe(true);
    // generatePassword(): `Db` + 24 random bytes as base64url (always 32 chars) + `9x`.
    expect(user.password).toHaveLength(36);

    const priv = await call(tool(tools, 'db_user_set_privileges'), { website: site, username: slug, database: slug, grants: ['all'] });
    expect(priv.isError, priv.text).toBeFalsy();

    expect(await listedDatabases()).toContain(fullDb);

    const users = await call(tool(tools, 'db_users_list'), { website: site });
    const mine = (users.structured as { items: Array<{ user: string; grants: Record<string, string[]>; accessHosts: string[] }> }).items.find((x) => x.user === fullUser);
    expect(mine, `db_users_list does not list ${fullUser}`).toBeTruthy();
    expect(mine!.grants[fullDb]).toContain('all');
    // A new user is created with the app tier's own source host, which is what a PHP page on this
    // website connects from; the list is never empty.
    expect(mine!.accessHosts.length).toBeGreaterThan(0);

    // db_list's and db_users_list's structured items are projections (renamed and dropped fields),
    // so the spec contract is checked against the raw panel payloads instead, as milestone A does
    // for subscriptions and domain mappings.
    const org = requireOrg(ctx.client);
    const w = await ctx.resolver.resolveWebsite(site);
    const path = { params: { path: { org_id: org, website_id: w.id } } };
    const rawDbs = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/mysql-dbs', () => ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/mysql-dbs', path));
    for (const item of rawDbs.items ?? []) assertRequired('MySQLDB', item);
    const rawUsers = await ctx.client.call('GET', '/orgs/{org_id}/websites/{website_id}/mysql-users', () => ctx.client.api.GET('/orgs/{org_id}/websites/{website_id}/mysql-users', path));
    const rawMine = (rawUsers.items ?? []).find((x) => x.username === fullUser);
    expect(rawMine, `the raw mysql-users listing does not carry ${fullUser}`).toBeTruthy();
    // NOT assertRequired('MySQLUser', …): that schema lists `internal` as required while defining
    // no such property, and the live payload has never carried one (docs/research.md, 2026-09-05
    // probe), so the contract helper would fail on a spec defect rather than on a real gap. The
    // fields the tools and the enhance-database skill actually read are checked directly instead.
    for (const key of ['username', 'accessHosts', 'authPlugin', 'grants', 'createdAt']) expect(rawMine).toHaveProperty(key);

    const sql = await call(tool(tools, 'db_export_sql'), { website: site, name: slug });
    expect(sql.isError, sql.text).toBeFalsy();
    const dump = sql.structured as { database: string; file: string; path: string };
    expect(dump.database).toBe(fullDb);
    // The panel answers with a *filename*, not the dump, and writes the file into the website's
    // home directory. The file is left there deliberately (see the cleanup note in afterAll).
    expect(dump.file).toMatch(/^sql_backup_.*\.sql\.gz$/);
    expect(dump.path.endsWith(`/${dump.file}`), `${dump.path} does not end with the filename the panel returned`).toBe(true);

    const pma = await call(tool(tools, 'db_phpmyadmin_url'), { website: site });
    expect(pma.isError, pma.text).toBeFalsy();
    // Asserted as a boolean, never matched or printed: the URL logs straight in, so it must not
    // reach the test output. Note the panel creates its own `<unixUser>_phpma` MySQL user on the
    // first SSO call; it persists and is the panel's, so nothing here removes it.
    expect((pma.structured as { url: string }).url.startsWith('https://'), 'the phpMyAdmin SSO URL is not an https URL').toBe(true);
  });

  it('the PHP, redis, htaccess, IP-rule, container-cron and PostgreSQL reads answer with the shapes the tools promise', async () => {
    const ext = await call(tool(tools, 'php_extensions_list'), { website: site });
    // mysqli is compiled in on every Enhance PHP build, so it is in `builtIn`, never `available`.
    expect((ext.structured as { builtIn: string[] }).builtIn).toContain('mysqli');

    const workers = await call(tool(tools, 'php_workers_get'), { website: site });
    const children = (workers.structured as { lsapiChildren: number }).lsapiChildren;
    expect(Number.isInteger(children) && children > 0, `lsapiChildren was ${children}`).toBe(true);

    const log = await call(tool(tools, 'php_error_log'), { website: site });
    // Empty when the site has had no PHP errors, but always a string.
    expect(typeof (log.structured as { log: string }).log).toBe('string');

    const redis = await call(tool(tools, 'redis_state_get'), { website: site });
    expect(typeof (redis.structured as { redis: boolean }).redis).toBe('boolean');

    const rewrites = await call(tool(tools, 'htaccess_rewrites_get'), { website: site });
    expect(typeof (rewrites.structured as { total: number }).total).toBe('number');

    const ips = await call(tool(tools, 'ip_rules_get'), { website: site });
    expect(['allow', 'block']).toContain((ips.structured as { kind: string }).kind);

    const containerCron = await call(tool(tools, 'container_cron_get'), { website: site });
    expect(typeof (containerCron.structured as { enabled: boolean }).enabled).toBe('boolean');

    // PostgreSQL is off on the test plan (`canUse.postgresql` is false), so pg_db_list must refuse
    // locally and send nothing to the panel. On a plan that does have PostgreSQL this expectation
    // is the wrong one — it would list databases instead — so revisit it if the plan changes.
    const pg = await call(tool(tools, 'pg_db_list'), { website: site });
    expect(pg.isError, 'pg_db_list did not refuse; is PostgreSQL now on this plan?').toBe(true);
    expect((pg.structured as { available: boolean }).available).toBe(false);
  });

  it('cron_add appends one job, cron_get shows it and cron_remove takes only that line away', async () => {
    const added = await call(tool(tools, 'cron_add'), { website: site, jobs: [cronJob] });
    expect(added.isError, added.text).toBeFalsy();
    const rows = (added.structured as { added: Array<{ line: number; expr: string }> }).added;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.expr).toBe(cronJob);
    cronLineNumber = row.line;

    // Line numbers are the panel's own and 0-based. Match the line by this run's marker and only
    // then remove it: removing the number cron_add reported without checking it still holds that
    // job could take out a line the customer added in between.
    expect(await markerLine(), 'the job cron_add reported is not at that line in cron_get').toBe(cronLineNumber);

    const removed = await call(tool(tools, 'cron_remove'), { website: site, line_numbers: [cronLineNumber] });
    expect(removed.isError, removed.text).toBeFalsy();
    expect(await markerLine(), 'the cron line is still in the crontab after cron_remove').toBeUndefined();
    cronLineNumber = undefined;
  });

  it('db_user_delete and db_delete refuse a mistyped name and then remove both through the gate contract', async () => {
    expect(fullUser, 'the create test did not record a user; refusing to delete anything').toBeTruthy();
    expect(fullDb, 'the create test did not record a database; refusing to delete anything').toBeTruthy();

    const delUser = tool(tools, 'db_user_delete');
    const userArgs = delUser.input.parse({ website: site, username: fullUser });
    const userTarget = await delUser.target!(userArgs, ctx);
    expect(userTarget.kind).toBe('mysql_user');
    // The name is what the human has to type, so it is the full prefixed one, not the short slug.
    expect(userTarget.name).toBe(fullUser);
    const userPreview = await delUser.preview!(userArgs, ctx, userTarget);
    // The identity block leads the preview: the human confirming sees which site the login is on.
    // Only the `website:` label is asserted, because the block names the site's *primary* domain,
    // which need not be the ENHANCE_E2E_SITE alias the suite addressed it by.
    expect(userPreview).toContain('website: ');
    expect(userPreview).toContain(fullUser!);
    const userToken = ctx.gate.issue(delUser.name, userTarget, userArgs);
    let mistypedUser: unknown;
    try {
      ctx.gate.verify(userToken, `${fullUser}-wrong`);
    } catch (e) {
      mistypedUser = e;
    }
    expect(mistypedUser).toBeInstanceOf(GateError);
    expect((mistypedUser as GateError).reason).toBe('mismatch');
    // The happy path on the same token: the full prefixed name the preview showed is what the
    // gate's matcher accepts, and the deletion then runs the handler with the args the gate
    // pinned, exactly as milestone A's website_delete test does.
    const userPending = ctx.gate.verify(userToken, fullUser!);
    expect(userPending.tool).toBe(delUser.name);
    expect(userPending.target.name).toBe(fullUser);
    const deletedUser = await delUser.handler(userPending.args, ctx, userTarget);
    expect(deletedUser.isError, deletedUser.text).toBeFalsy();
    expect(await listedUsers()).not.toContain(fullUser);

    const delDb = tool(tools, 'db_delete');
    const dbArgs = delDb.input.parse({ website: site, name: fullDb });
    const dbTarget = await delDb.target!(dbArgs, ctx);
    expect(dbTarget.kind).toBe('mysql_db');
    expect(dbTarget.name).toBe(fullDb);
    const dbPreview = await delDb.preview!(dbArgs, ctx, dbTarget);
    expect(dbPreview).toContain('website: ');
    expect(dbPreview).toContain(fullDb!);
    const dbToken = ctx.gate.issue(delDb.name, dbTarget, dbArgs);
    let mistypedDb: unknown;
    try {
      ctx.gate.verify(dbToken, `${fullDb}-wrong`);
    } catch (e) {
      mistypedDb = e;
    }
    expect(mistypedDb).toBeInstanceOf(GateError);
    expect((mistypedDb as GateError).reason).toBe('mismatch');
    const dbPending = ctx.gate.verify(dbToken, fullDb!);
    expect(dbPending.tool).toBe(delDb.name);
    expect(dbPending.target.name).toBe(fullDb);
    const deletedDb = await delDb.handler(dbPending.args, ctx, dbTarget);
    expect(deletedDb.isError, deletedDb.text).toBeFalsy();
    expect(await listedDatabases()).not.toContain(fullDb);
  });
});
