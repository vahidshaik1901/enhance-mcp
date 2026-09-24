import { describe, expect, it } from 'vitest';
import { tools } from '../../src/tools/mysql.js';
import { base, MYSQL_DB, mysqlDbs, ORG_ID, SERVER_IP, websiteDetail, WEBSITE_ID, websiteSummary, websitesList } from '../fixtures/panel.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import { type Route, writeThenList } from '../helpers/fakeFetch.js';

const dbsPath = `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/mysql-dbs`;
const websiteLine = `website: vahi.dev (${WEBSITE_ID})`;

/** A second website that takes over the domain after `target()` has already resolved it. */
const OTHER_WEBSITE_ID = 'a1b2c3d4-5566-4778-9900-aabbccddeeff';
const otherSummary = { ...websiteSummary, id: OTHER_WEBSITE_ID };
const otherDetail = { ...websiteDetail, id: OTHER_WEBSITE_ID, unixUser: 'other_dev1' };

/** The routes for a panel where `GET /websites` answers with a different site the second time it
 *  is asked, so a tool that re-resolves the user's `website` string lands on the wrong website. */
function movingTargetRoutes(seen: string[]): Route[] {
  let listCalls = 0;
  return [
    {
      method: 'GET',
      path: `/orgs/${ORG_ID}/websites`,
      handler: async () => {
        listCalls += 1;
        const body = listCalls === 1 ? websitesList : { items: [otherSummary], total: 1 };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
    { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: websiteDetail },
    { method: 'GET', path: `/orgs/${ORG_ID}/websites/${OTHER_WEBSITE_ID}`, body: otherDetail },
    {
      method: 'DELETE',
      path: new RegExp(`^/orgs/${ORG_ID}/websites/[^/]+/mysql-dbs/`),
      handler: async (_req, url) => {
        seen.push(url.pathname.replace(/^\/api/, ''));
        return new Response(null, { status: 204 });
      },
    },
    {
      method: 'DELETE',
      path: new RegExp(`^/orgs/${ORG_ID}/websites/[^/]+/mysql-users/`),
      handler: async (_req, url) => {
        seen.push(url.pathname.replace(/^\/api/, ''));
        return new Response(null, { status: 204 });
      },
    },
    {
      method: 'POST',
      path: new RegExp('^/v2/websites/[^/]+/mysql/[^/]+/sql$'),
      handler: async (_req, url) => {
        seen.push(url.pathname.replace(/^\/api/, ''));
        return new Response(null, { status: 200 });
      },
    },
  ];
}

describe('db_list', () => {
  it('lists databases with the full name, size and user count', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: dbsPath, body: mysqlDbs }]);
    const r = await callTool(byName(tools, 'db_list'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain(MYSQL_DB);
    expect(r.text).toContain(websiteLine);
    // The table header stays human ("size (bytes)"); the structured item uses a plain key.
    expect(r.text).toContain('size (bytes)');
    expect(r.structured).toMatchObject({ total: 1, items: [{ database: MYSQL_DB, sizeBytes: 40960, users: 1 }] });
  });
});

describe('db_create', () => {
  it('sends the short name and reports the full prefixed name', async () => {
    let sent: unknown;
    const { ctx } = await makeContext([
      ...base(),
      { method: 'GET', path: dbsPath, body: { items: [] } },
      { method: 'POST', path: dbsPath, handler: async (req) => { sent = await req.json(); return new Response(null, { status: 201 }); } },
    ]);
    const r = await callTool(byName(tools, 'db_create'), { website: 'vahi.dev', name: 'demo' }, ctx);
    expect(sent).toEqual({ name: 'demo' });
    expect(r.structured).toMatchObject({ database: MYSQL_DB, created: true });
    expect(r.text).toContain('DB_HOST=localhost');
    // Node is the other half of this: the same "localhost" is TCP to a Node driver and refused.
    expect(r.text).toContain('/run/mysqld/mysqld.sock');
  });

  it('strips the prefix the user typed rather than sending it twice', async () => {
    let sent: unknown;
    const { ctx } = await makeContext([
      ...base(),
      { method: 'GET', path: dbsPath, body: { items: [] } },
      { method: 'POST', path: dbsPath, handler: async (req) => { sent = await req.json(); return new Response(null, { status: 201 }); } },
    ]);
    const r = await callTool(byName(tools, 'db_create'), { website: 'vahi.dev', name: MYSQL_DB }, ctx);
    expect(sent).toEqual({ name: 'demo' });
    expect(r.structured).toMatchObject({ database: MYSQL_DB });
  });
});

describe('db_delete', () => {
  it('is destructive, previews by the full name, and deletes by it', async () => {
    let deleted: string | undefined;
    const { ctx } = await makeContext([
      ...base(),
      { method: 'DELETE', path: new RegExp(`${dbsPath}/(.+)$`), handler: async (_req, url) => { deleted = decodeURIComponent(url.pathname.split('/').pop()!); return new Response(null, { status: 204 }); } },
    ]);
    const del = byName(tools, 'db_delete');
    const args = del.input.parse({ website: 'vahi.dev', name: 'demo' });
    const target = await del.target!(args, ctx);
    expect(target).toMatchObject({ kind: 'mysql_db', name: MYSQL_DB });
    const preview = await del.preview!(args, ctx, target);
    expect(preview).toContain(MYSQL_DB);
    expect(preview).toContain('db_export_sql');
    const r = await del.handler(args, ctx, target);
    expect(deleted).toBe(MYSQL_DB);
    expect(r.structured).toMatchObject({ database: MYSQL_DB, deleted: true });
  });

  it('names the website in the preview, not just the org', async () => {
    const { ctx } = await makeContext(base());
    const del = byName(tools, 'db_delete');
    const args = del.input.parse({ website: 'vahi.dev', name: 'demo' });
    const preview = await del.preview!(args, ctx, await del.target!(args, ctx));
    expect(preview).toContain(`org: Shaik Vahid (${ORG_ID})`);
    expect(preview).toContain(websiteLine);
    // The identity block comes first, then the warning.
    expect(preview.indexOf(websiteLine)).toBeLessThan(preview.indexOf('permanently drop'));
  });

  it('acts on the website the target named, even if the domain now resolves elsewhere', async () => {
    const seen: string[] = [];
    const { ctx } = await makeContext(movingTargetRoutes(seen));
    const del = byName(tools, 'db_delete');
    const args = del.input.parse({ website: 'vahi.dev', name: 'demo' });
    const target = await del.target!(args, ctx);
    expect(target.id).toBe(`${WEBSITE_ID}:${MYSQL_DB}`);
    // The panel changed under us: a different website now answers for vahi.dev.
    ctx.resolver.invalidate();
    const preview = await del.preview!(args, ctx, target);
    expect(preview).toContain(WEBSITE_ID);
    expect(preview).not.toContain(OTHER_WEBSITE_ID);
    await del.handler(args, ctx, target);
    expect(seen).toEqual([`/orgs/${ORG_ID}/websites/${WEBSITE_ID}/mysql-dbs/${MYSQL_DB}`]);
  });
});

describe('db_export_sql', () => {
  // Verified live 2026-09-06: the endpoint answers with the backup's *filename* as a JSON
  // string, not with the SQL. The panel writes the gzipped dump into the website's home.
  // The live filename carries a colon (`..._06-09-2026_01:29.sql.gz`), so the path must be quoted
  // in the scp line the caller is told to run.
  const FILE = 'sql_backup_vahi_dev1_demo_06-09-2026_01:29.sql.gz';
  const SERVER_PATH = `/var/www/${WEBSITE_ID}/${FILE}`;
  const exportRoute: Route = {
    method: 'GET',
    path: `${dbsPath}/${MYSQL_DB}/sql`,
    handler: async () => new Response(JSON.stringify(FILE), { status: 200, headers: { 'content-type': 'application/json' } }),
  };

  it('returns the server-side path of the backup the panel wrote, and the scp line to fetch it', async () => {
    const { ctx } = await makeContext([...base(), exportRoute]);
    const r = await callTool(byName(tools, 'db_export_sql'), { website: 'vahi.dev', name: 'demo' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.structured).toMatchObject({ database: MYSQL_DB, file: FILE, path: SERVER_PATH });
    // Nothing of the dump itself comes back: the body was never the SQL.
    expect(r.structured).not.toHaveProperty('sql');
    const scp = (r.structured as { scpCommand: string }).scpCommand;
    // The remote path is single-quoted so a filename with a colon or a space survives the shell.
    expect(scp).toBe(`scp -P 22 vahi_dev1@${SERVER_IP}:'${SERVER_PATH}' .`);
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain(SERVER_PATH);
    expect(r.text).toContain('scp');
    // The Bash sandbox cannot open SSH connections, so the caller has to be told.
    expect(r.text).toContain('sandbox');
  });

  it('fails rather than rendering a path when the panel returns no filename', async () => {
    // An empty JSON string, and a 200 with no body at all: parseScalarText answers '' and
    // 'unknown' respectively, and neither names a file.
    for (const empty of [() => new Response('""', { status: 200, headers: { 'content-type': 'application/json' } }), () => new Response(null, { status: 200 })]) {
      const { ctx } = await makeContext([...base(), { method: 'GET', path: `${dbsPath}/${MYSQL_DB}/sql`, handler: async () => empty() }]);
      const r = await callTool(byName(tools, 'db_export_sql'), { website: 'vahi.dev', name: 'demo' }, ctx);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('did not return a backup filename');
      expect(r.text).not.toContain(`/var/www/${WEBSITE_ID}/unknown`);
      expect(r.structured).not.toHaveProperty('path');
    }
  });

  it('is a write tool, because it creates a file on the server', () => {
    expect(byName(tools, 'db_export_sql').risk).toBe('write');
  });
});

describe('db_import_sql', () => {
  it('is destructive and uploads the sql as multipart to the v2 endpoint', async () => {
    let seen: { contentType: string | null; field: string; filename: string; sql: string; path: string } | undefined;
    const { ctx, f } = await makeContext([
      ...base(),
      {
        method: 'POST',
        path: new RegExp(`^/v2/websites/${WEBSITE_ID}/mysql/[^/]+/sql$`),
        handler: async (req, url) => {
          const [field, file] = [...(await req.formData()).entries()][0] as [string, File];
          seen = { contentType: req.headers.get('content-type'), field, filename: file.name, sql: await file.text(), path: url.pathname.replace(/^\/api/, '') };
          return new Response(null, { status: 200 });
        },
      },
    ]);
    const t = byName(tools, 'db_import_sql');
    const args = t.input.parse({ website: 'vahi.dev', name: 'demo', sql: 'INSERT INTO `t` VALUES (1);' });
    const target = await t.target!(args, ctx);
    expect(target).toMatchObject({ kind: 'mysql_db', name: MYSQL_DB });
    expect(await t.preview!(args, ctx, target)).toContain(MYSQL_DB);
    const r = await t.handler(args, ctx, target);
    expect(seen?.contentType).toMatch(/^multipart\/form-data/);
    expect(seen?.sql).toBe('INSERT INTO `t` VALUES (1);');
    expect(seen?.field).toBe(`${MYSQL_DB}.sql`);
    expect(seen?.filename).toBe(`${MYSQL_DB}.sql`);
    // The spec's path template names its parameters differently from its own declaration; assert
    // the placeholders were actually substituted.
    expect(seen?.path).toBe(`/v2/websites/${WEBSITE_ID}/mysql/${MYSQL_DB}/sql`);
    expect(f.calls.at(-1)?.path).not.toContain('force');
    expect(r.structured).toMatchObject({ database: MYSQL_DB, imported: true, bytes: 27 });
  });

  // Verified live 2026-09-11 (orchd 12.25.5): the panel reads the upload's file extension from the
  // multipart *field* name, not from the filename. The spec's `sql` field name is rejected with
  // 400 invalid_argument, detail mysql_db, "Invalid file extension", whatever the filename says.
  it('names the multipart part after the database so it carries the .sql extension, never `sql`', async () => {
    let fields: string[] | undefined;
    const { ctx } = await makeContext([
      ...base(),
      {
        method: 'POST',
        path: new RegExp(`^/v2/websites/${WEBSITE_ID}/mysql/[^/]+/sql$`),
        handler: async (req) => {
          fields = [...(await req.formData()).keys()];
          return new Response(null, { status: 200 });
        },
      },
    ]);
    const t = byName(tools, 'db_import_sql');
    const args = t.input.parse({ website: 'vahi.dev', name: 'demo', sql: 'SELECT 1;' });
    await t.handler(args, ctx, await t.target!(args, ctx));
    expect(fields).toEqual([`${MYSQL_DB}.sql`]);
    expect(fields).not.toContain('sql');
    expect(fields?.every((n) => n.endsWith('.sql'))).toBe(true);
  });

  it('passes the force flag through as a query parameter, and says so in the preview', async () => {
    const { ctx, f } = await makeContext([
      ...base(),
      { method: 'POST', path: new RegExp(`^/v2/websites/${WEBSITE_ID}/mysql/[^/]+/sql$`), handler: async () => new Response(null, { status: 200 }) },
    ]);
    const t = byName(tools, 'db_import_sql');
    const args = t.input.parse({ website: 'vahi.dev', name: 'demo', sql: 'SELECT 1;', force: true });
    const target = await t.target!(args, ctx);
    // The human confirming has to be told that a failing statement will not stop the run.
    expect(await t.preview!(args, ctx, target)).toMatch(/continue|keeps going|past/i);
    await t.handler(args, ctx, target);
    expect(f.calls.at(-1)?.path).toContain('force=true');
  });

  it('says nothing about continuing past failures when force is off', async () => {
    const { ctx } = await makeContext(base());
    const t = byName(tools, 'db_import_sql');
    const args = t.input.parse({ website: 'vahi.dev', name: 'demo', sql: 'SELECT 1;' });
    expect(await t.preview!(args, ctx, await t.target!(args, ctx))).not.toMatch(/continue/i);
  });

  it('names the website in the preview and counts bytes, not characters', async () => {
    const sql = "INSERT INTO `t` VALUES ('café');";
    const { ctx } = await makeContext([
      ...base(),
      { method: 'POST', path: new RegExp(`^/v2/websites/${WEBSITE_ID}/mysql/[^/]+/sql$`), handler: async () => new Response(null, { status: 200 }) },
    ]);
    const t = byName(tools, 'db_import_sql');
    const args = t.input.parse({ website: 'vahi.dev', name: 'demo', sql });
    const target = await t.target!(args, ctx);
    const preview = await t.preview!(args, ctx, target);
    expect(preview).toContain(websiteLine);
    expect(preview.indexOf(websiteLine)).toBeLessThan(preview.indexOf('This will run'));
    expect(preview).toContain(`${Buffer.byteLength(sql)} bytes`);
    expect(Buffer.byteLength(sql)).not.toBe(sql.length);
    const r = await t.handler(args, ctx, target);
    expect(r.structured).toMatchObject({ bytes: Buffer.byteLength(sql) });
  });

  it('acts on the website the target named, even if the domain now resolves elsewhere', async () => {
    const seen: string[] = [];
    const { ctx } = await makeContext(movingTargetRoutes(seen));
    const t = byName(tools, 'db_import_sql');
    const args = t.input.parse({ website: 'vahi.dev', name: 'demo', sql: 'SELECT 1;' });
    const target = await t.target!(args, ctx);
    ctx.resolver.invalidate();
    expect(await t.preview!(args, ctx, target)).toContain(WEBSITE_ID);
    await t.handler(args, ctx, target);
    expect(seen).toEqual([`/v2/websites/${WEBSITE_ID}/mysql/${MYSQL_DB}/sql`]);
  });
});

describe('db_phpmyadmin_url', () => {
  it('returns the signon url', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/phpmyadmin`, body: 'https://phpmyadmin.example/signon.php?sess=abc' }]);
    const r = await callTool(byName(tools, 'db_phpmyadmin_url'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ url: 'https://phpmyadmin.example/signon.php?sess=abc' });
    expect(f.calls.at(-1)?.path).toContain('shouldRedirect=false');
    // The URL logs whoever opens it straight in, so it stays out of the rendered text.
    expect(r.text).not.toContain('sess=abc');
  });

  it('uses the per-database sso endpoint when a database is named', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: `${dbsPath}/${MYSQL_DB}/sso`, body: 'https://phpmyadmin.example/signon.php?sess=db' }]);
    const r = await callTool(byName(tools, 'db_phpmyadmin_url'), { website: 'vahi.dev', name: 'demo' }, ctx);
    expect(r.structured).toMatchObject({ url: 'https://phpmyadmin.example/signon.php?sess=db' });
    expect(f.calls.at(-1)?.path).toContain(`${dbsPath}/${MYSQL_DB}/sso`);
  });

  it('accepts the full prefixed name for the optional database, like every other db tool', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: `${dbsPath}/${MYSQL_DB}/sso`, body: 'https://phpmyadmin.example/signon.php?sess=db' }]);
    await callTool(byName(tools, 'db_phpmyadmin_url'), { website: 'vahi.dev', name: MYSQL_DB }, ctx);
    expect(f.calls.at(-1)?.path).toContain(`${dbsPath}/${MYSQL_DB}/sso`);
  });

  it('is a write tool, because minting the session makes the panel create a persistent MySQL user', () => {
    const t = byName(tools, 'db_phpmyadmin_url');
    expect(t.risk).toBe('write');
    // The description has to say what the URL is worth and what it leaves behind.
    expect(t.description).toMatch(/full[- ]privilege/i);
    expect(t.description).toContain('_phpma');
  });
});

describe('databases need a unix user', () => {
  it('refuses a website that has none rather than sending a bare _ prefix', async () => {
    const { unixUser: _drop, ...noUnixUser } = websiteDetail;
    const { ctx } = await makeContext([
      { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: { items: [noUnixUser], total: 1 } },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: noUnixUser },
    ]);
    await expect(callTool(byName(tools, 'db_list'), { website: 'vahi.dev' }, ctx)).rejects.toThrow(/no unix user/);
  });
});

const usersPath = `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/mysql-users`;
const MYSQL_USER = 'vahi_dev1_app';
/** The shape a live panel returned (docs/research.md, live probe 2026-09-05). */
const mysqlUser = { username: MYSQL_USER, accessHosts: ['10.169.0.1'], authPlugin: 'mysql_native_password', grants: { [MYSQL_DB]: ['all'] }, createdAt: '2026-09-05T15:00:35.000099999Z', isEphemeral: false };
const mysqlUsers = { items: [mysqlUser] };

/** Captures the JSON body of the single write the test makes. */
function captureBody(route: Omit<Route, 'handler'>, status: number, sink: { body?: unknown; path?: string }): Route {
  return {
    ...route,
    handler: async (req, url) => {
      sink.body = await req.json();
      sink.path = url.pathname.replace(/^\/api/, '');
      return new Response(null, { status });
    },
  };
}

describe('db_users_list', () => {
  it('lists users with their access hosts and the databases they can reach', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: usersPath, body: mysqlUsers }]);
    const r = await callTool(byName(tools, 'db_users_list'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain(MYSQL_USER);
    expect(r.text).toContain('10.169.0.1');
    expect(r.text).toContain(MYSQL_DB);
    expect(r.text).toContain('access hosts');
    // The table renders the ephemeral flag as yes/no, in its own column after the auth plugin.
    expect(r.text).toContain('ephemeral');
    expect(r.text).toMatch(/mysql_native_password\s+no/);
    // structuredContent keeps the panel's own shapes: the hosts stay an array and `grants` stays
    // the database -> privileges map, so a caller can act on it without re-parsing the table.
    expect(r.structured).toMatchObject({
      total: 1,
      items: [{ user: MYSQL_USER, accessHosts: ['10.169.0.1'], grants: { [MYSQL_DB]: ['all'] }, authPlugin: 'mysql_native_password', ephemeral: false }],
    });
  });

  it('says "none" in the table for a user with no access hosts and no databases, and keeps the empty shapes in structuredContent', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: usersPath, body: { items: [{ ...mysqlUser, accessHosts: [], grants: {} }] } }]);
    const r = await callTool(byName(tools, 'db_users_list'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toMatch(/none\s+none/);
    expect(r.structured).toMatchObject({ total: 1, items: [{ user: MYSQL_USER, accessHosts: [], grants: {}, ephemeral: false }] });
  });
});

describe('db_user_create', () => {
  it('generates a password when none is given and shows it once', async () => {
    const sink: { body?: unknown } = {};
    const { ctx } = await makeContext([...base(), { method: 'GET', path: usersPath, body: { items: [] } }, captureBody({ method: 'POST', path: usersPath }, 201, sink)]);
    const r = await callTool(byName(tools, 'db_user_create'), { website: 'vahi.dev', username: 'app' }, ctx);
    const body = sink.body as { username: string; password: string };
    // The panel adds the `<unixUser>_` prefix itself, so only the short name goes over the wire.
    expect(body.username).toBe('app');
    // Fixed length, no probabilistic branch: `Db` + 32 base64url characters + `9x`. base64url
    // never yields `+`, `/` or `=`, so the password is safe unquoted in a `.env` file and inside
    // shell double quotes.
    expect(body.password).toHaveLength(36);
    expect(body.password).toMatch(/^Db[A-Za-z0-9_-]{32}9x$/);
    expect(r.structured).toMatchObject({ user: MYSQL_USER, password: body.password });
    expect(r.text).toContain('DB_HOST=localhost');
    // Node is the other half of this: the same "localhost" is TCP to a Node driver and refused.
    expect(r.text).toContain('/run/mysqld/mysqld.sock');
    expect(r.text).toContain('shown once');
    // The password itself belongs in structuredContent only, like the phpMyAdmin sign-on URL.
    expect(r.text).not.toContain(body.password);
  });

  it('generates a different password every time', async () => {
    const seen: string[] = [];
    const { ctx } = await makeContext([
      ...base(),
      { method: 'GET', path: usersPath, body: { items: [] } },
      { method: 'POST', path: usersPath, handler: async (req) => { seen.push(((await req.json()) as { password: string }).password); return new Response(null, { status: 201 }); } },
    ]);
    await callTool(byName(tools, 'db_user_create'), { website: 'vahi.dev', username: 'app' }, ctx);
    await callTool(byName(tools, 'db_user_create'), { website: 'vahi.dev', username: 'other' }, ctx);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).toHaveLength(36);
    expect(seen[1]).toHaveLength(36);
  });

  it('sends the password the user supplied and keeps it out of the rendered text', async () => {
    const sink: { body?: unknown } = {};
    const { ctx } = await makeContext([...base(), { method: 'GET', path: usersPath, body: { items: [] } }, captureBody({ method: 'POST', path: usersPath }, 201, sink)]);
    const r = await callTool(byName(tools, 'db_user_create'), { website: 'vahi.dev', username: 'app', password: 'sup3r-secret-pw' }, ctx);
    expect(sink.body).toEqual({ username: 'app', password: 'sup3r-secret-pw' });
    expect(r.structured).toMatchObject({ user: MYSQL_USER, password: 'sup3r-secret-pw' });
    expect(r.text).not.toContain('sup3r-secret-pw');
  });

  it('strips the prefix the user typed rather than sending it twice', async () => {
    const sink: { body?: unknown } = {};
    const { ctx } = await makeContext([...base(), { method: 'GET', path: usersPath, body: { items: [] } }, captureBody({ method: 'POST', path: usersPath }, 201, sink)]);
    const r = await callTool(byName(tools, 'db_user_create'), { website: 'vahi.dev', username: MYSQL_USER, password: 'sup3r-secret-pw' }, ctx);
    expect(sink.body).toMatchObject({ username: 'app' });
    expect(r.structured).toMatchObject({ user: MYSQL_USER });
  });
});

describe('db_user_update', () => {
  it('sets the password by the full user name and keeps it out of the rendered text', async () => {
    const sink: { body?: unknown; path?: string } = {};
    const { ctx } = await makeContext([...base(), captureBody({ method: 'PUT', path: new RegExp(`^${usersPath}/[^/]+$`) }, 200, sink)]);
    const r = await callTool(byName(tools, 'db_user_update'), { website: 'vahi.dev', username: 'app', password: 'n3w-secret-pw' }, ctx);
    expect(sink.path).toBe(`${usersPath}/${MYSQL_USER}`);
    expect(sink.body).toEqual({ password: 'n3w-secret-pw' });
    expect(r.structured).toMatchObject({ user: MYSQL_USER, password: 'n3w-secret-pw' });
    expect(r.text).toContain(websiteLine);
    expect(r.text).not.toContain('n3w-secret-pw');
  });
});

describe('db_user_set_privileges', () => {
  it('sends the lowercase grant enum with the full db name', async () => {
    const sink: { body?: unknown; path?: string } = {};
    const { ctx } = await makeContext([...base(), captureBody({ method: 'PUT', path: new RegExp(`^${usersPath}/[^/]+/privileges$`) }, 201, sink)]);
    const r = await callTool(byName(tools, 'db_user_set_privileges'), { website: 'vahi.dev', username: 'app', database: 'demo', grants: ['all'] }, ctx);
    expect(sink.path).toBe(`${usersPath}/${MYSQL_USER}/privileges`);
    expect(sink.body).toMatchObject({ dbName: MYSQL_DB, grants: ['all'] });
    expect(r.structured).toMatchObject({ user: MYSQL_USER, database: MYSQL_DB, grants: ['all'] });
  });

  it('rejects a grant outside the enum before calling the panel', async () => {
    const { ctx, f } = await makeContext([...base()]);
    await expect(callTool(byName(tools, 'db_user_set_privileges'), { website: 'vahi.dev', username: 'app', database: 'demo', grants: ['ALL PRIVILEGES'] }, ctx)).rejects.toThrow();
    expect(f.calls.some((c) => c.path.includes('/privileges'))).toBe(false);
  });

  it('rejects an empty grant list', async () => {
    const { ctx, f } = await makeContext([...base()]);
    await expect(callTool(byName(tools, 'db_user_set_privileges'), { website: 'vahi.dev', username: 'app', database: 'demo', grants: [] }, ctx)).rejects.toThrow();
    expect(f.calls.some((c) => c.path.includes('/privileges'))).toBe(false);
  });
});

describe('db_user_access_hosts_add', () => {
  it('posts the hosts for the full user name', async () => {
    const sink: { body?: unknown; path?: string } = {};
    const { ctx } = await makeContext([...base(), captureBody({ method: 'POST', path: new RegExp(`^${usersPath}/[^/]+/access-hosts$`) }, 200, sink)]);
    const r = await callTool(byName(tools, 'db_user_access_hosts_add'), { website: 'vahi.dev', username: 'app', hosts: ['10.169.0.1', '203.0.113.7'] }, ctx);
    expect(sink.path).toBe(`${usersPath}/${MYSQL_USER}/access-hosts`);
    expect(sink.body).toEqual({ accessHosts: ['10.169.0.1', '203.0.113.7'] });
    expect(r.structured).toMatchObject({ user: MYSQL_USER, added: ['10.169.0.1', '203.0.113.7'] });
    expect(r.text).toContain('added hosts');
    expect(r.text).toContain('203.0.113.7');
    expect(r.text).toContain(websiteLine);
  });
});

describe('db_user_access_hosts_remove', () => {
  // Verified live 2026-09-06: DELETE on the same path with the same body removes exactly the
  // hosts listed and leaves the rest, so it is the inverse of the POST, not a replace.
  it('sends DELETE with the hosts in the body', async () => {
    const sink: { body?: unknown; path?: string } = {};
    const { ctx, f } = await makeContext([...base(), captureBody({ method: 'DELETE', path: new RegExp(`^${usersPath}/[^/]+/access-hosts$`) }, 204, sink)]);
    const r = await callTool(byName(tools, 'db_user_access_hosts_remove'), { website: 'vahi.dev', username: 'app', hosts: ['203.0.113.7'] }, ctx);
    expect(f.calls.at(-1)?.method).toBe('DELETE');
    expect(sink.path).toBe(`${usersPath}/${MYSQL_USER}/access-hosts`);
    // The hosts travel in the body of the DELETE, not in the path or the query string.
    expect(sink.body).toEqual({ accessHosts: ['203.0.113.7'] });
    expect(f.calls.at(-1)?.body).toBe(JSON.stringify({ accessHosts: ['203.0.113.7'] }));
    expect(r.structured).toMatchObject({ user: MYSQL_USER, removed: ['203.0.113.7'] });
    expect(r.text).toContain('removed hosts');
    expect(r.text).toContain(websiteLine);
  });

  it('is a write tool, not a destructive one, because _add puts the host back', () => {
    expect(byName(tools, 'db_user_access_hosts_remove').risk).toBe('write');
  });
});

describe('db_user_delete', () => {
  it('is destructive and deletes by the full user name', async () => {
    let deleted: string | undefined;
    const { ctx } = await makeContext([
      ...base(),
      { method: 'DELETE', path: new RegExp(`^${usersPath}/[^/]+$`), handler: async (_req, url) => { deleted = decodeURIComponent(url.pathname.split('/').pop()!); return new Response(null, { status: 204 }); } },
    ]);
    const del = byName(tools, 'db_user_delete');
    const args = del.input.parse({ website: 'vahi.dev', username: 'app' });
    const target = await del.target!(args, ctx);
    expect(target).toMatchObject({ kind: 'mysql_user', id: `${WEBSITE_ID}:${MYSQL_USER}`, name: MYSQL_USER });
    const preview = await del.preview!(args, ctx, target);
    expect(preview).toContain(MYSQL_USER);
    expect(preview).toContain(`org: Shaik Vahid (${ORG_ID})`);
    expect(preview).toContain(websiteLine);
    // The identity block leads, then the warning.
    expect(preview.indexOf(websiteLine)).toBeLessThan(preview.indexOf('delete MySQL user'));
    const r = await del.handler(args, ctx, target);
    expect(deleted).toBe(MYSQL_USER);
    expect(r.structured).toMatchObject({ user: MYSQL_USER, deleted: true });
  });

  it('acts on the website the target named, even if the domain now resolves elsewhere', async () => {
    const seen: string[] = [];
    const { ctx } = await makeContext(movingTargetRoutes(seen));
    const del = byName(tools, 'db_user_delete');
    const args = del.input.parse({ website: 'vahi.dev', username: 'app' });
    const target = await del.target!(args, ctx);
    expect(target.id).toBe(`${WEBSITE_ID}:${MYSQL_USER}`);
    // The panel changed under us: a different website (with a different unix user) now answers.
    ctx.resolver.invalidate();
    const preview = await del.preview!(args, ctx, target);
    expect(preview).toContain(WEBSITE_ID);
    expect(preview).not.toContain(OTHER_WEBSITE_ID);
    await del.handler(args, ctx, target);
    expect(seen).toEqual([`${usersPath}/${MYSQL_USER}`]);
  });
});

describe('db_create and db_user_create settle an unclear answer (write-then-verify)', () => {
  const noDbs = { items: [] };
  const oneDb = { items: [{ name: MYSQL_DB, size: 0, createdAt: '2026-09-24T00:00:00Z', websiteId: WEBSITE_ID, serverId: '4b5f6a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b', userCount: 0 }] };
  const failed502 = (): Response => new Response(JSON.stringify({ code: 'http_502' }), { status: 502, headers: { 'content-type': 'application/json' } });

  it('refuses a database that already exists, sending nothing', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: dbsPath, body: oneDb }]);
    const r = await callTool(byName(tools, 'db_create'), { website: 'vahi.dev', name: 'demo' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain(`database ${MYSQL_DB} already exists`);
    expect(r.text).toMatch(/Nothing was sent to the panel/);
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(r.structured).toMatchObject({ database: MYSQL_DB, created: false });
  });

  it('confirms a database whose create answer never came, by finding it in the listing', async () => {
    const { ctx, f } = await makeContext([...writeThenList({ writePath: dbsPath, listPath: dbsPath, before: noDbs, after: oneDb, write: () => { throw new TypeError('fetch failed'); } }), ...base()]);
    const r = await callTool(byName(tools, 'db_create'), { website: 'vahi.dev', name: 'demo' }, ctx);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toContain('confirmed by reading it back');
    expect(r.structured).toMatchObject({ database: MYSQL_DB, created: true });
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('says the outcome is unknown, not failed, when the database never shows up', async () => {
    const { ctx, f } = await makeContext([...writeThenList({ writePath: dbsPath, listPath: dbsPath, before: noDbs, after: noDbs, write: failed502 }), ...base()]);
    const r = await callTool(byName(tools, 'db_create'), { website: 'vahi.dev', name: 'demo' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('OUTCOME UNKNOWN');
    expect(r.text).toContain('HTTP 502');
    expect(r.text).toContain('db_list website=vahi.dev');
    expect(r.structured).toMatchObject({ outcome: 'unknown', database: MYSQL_DB, created: null });
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    // The existence check, then five re-reads over the default 10 s window.
    expect(f.calls.filter((c) => c.method === 'GET' && c.path === dbsPath)).toHaveLength(6);
  });

  it('refuses a user that already exists, sending nothing', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: usersPath, body: { items: [mysqlUser] } }]);
    const r = await callTool(byName(tools, 'db_user_create'), { website: 'vahi.dev', username: 'app' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`MySQL user ${MYSQL_USER} already exists`);
    expect(r.text).toContain('db_user_update');
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(r.structured).toMatchObject({ user: MYSQL_USER, created: false });
  });

  it('confirms a user whose create answer never came and hands back the password it was created with', async () => {
    let sent: { password?: string } = {};
    const { ctx } = await makeContext([...writeThenList({ writePath: usersPath, listPath: usersPath, before: { items: [] }, after: { items: [mysqlUser] }, write: async (req) => { sent = (await req.json()) as { password: string }; throw new TypeError('fetch failed'); } }), ...base()]);
    const r = await callTool(byName(tools, 'db_user_create'), { website: 'vahi.dev', username: 'app' }, ctx);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.structured).toMatchObject({ user: MYSQL_USER, password: sent.password });
    expect(r.text).not.toContain(sent.password!);
  });

  it('on an unknown outcome still returns the password, labelled as valid only if the user exists', async () => {
    let sent: { password?: string } = {};
    const { ctx } = await makeContext([...writeThenList({ writePath: usersPath, listPath: usersPath, before: { items: [] }, after: { items: [] }, write: async (req) => { sent = (await req.json()) as { password: string }; throw new TypeError('fetch failed'); } }), ...base()]);
    const r = await callTool(byName(tools, 'db_user_create'), { website: 'vahi.dev', username: 'app' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('OUTCOME UNKNOWN');
    expect(r.text).toContain('db_users_list website=vahi.dev');
    expect(r.text).toContain('structuredContent.password');
    expect(r.text).not.toContain(sent.password!);
    expect(r.structured).toMatchObject({ outcome: 'unknown', user: MYSQL_USER, created: null, password: sent.password, passwordNote: expect.stringContaining('only if') });
  });
});
