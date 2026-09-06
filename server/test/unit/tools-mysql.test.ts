import { describe, expect, it } from 'vitest';
import { tools } from '../../src/tools/mysql.js';
import { base, MYSQL_DB, mysqlDbs, ORG_ID, WEBSITE_ID, websiteDetail } from '../fixtures/panel.js';
import { byName, callTool, makeContext } from '../helpers/context.js';

const dbsPath = `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/mysql-dbs`;

describe('db_list', () => {
  it('lists databases with the full name, size and user count', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: dbsPath, body: mysqlDbs }]);
    const r = await callTool(byName(tools, 'db_list'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain(MYSQL_DB);
    expect(r.text).toContain(`website: vahi.dev (${WEBSITE_ID})`);
    expect(r.structured).toMatchObject({ total: 1, items: [{ database: MYSQL_DB, users: 1 }] });
  });
});

describe('db_create', () => {
  it('sends the short name and reports the full prefixed name', async () => {
    let sent: unknown;
    const { ctx } = await makeContext([
      ...base(),
      { method: 'POST', path: dbsPath, handler: async (req) => { sent = await req.json(); return new Response(null, { status: 201 }); } },
    ]);
    const r = await callTool(byName(tools, 'db_create'), { website: 'vahi.dev', name: 'demo' }, ctx);
    expect(sent).toEqual({ name: 'demo' });
    expect(r.structured).toMatchObject({ database: MYSQL_DB, created: true });
    expect(r.text).toContain('DB_HOST=localhost');
  });

  it('strips the prefix the user typed rather than sending it twice', async () => {
    let sent: unknown;
    const { ctx } = await makeContext([
      ...base(),
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
});

describe('db_export_sql', () => {
  it('returns the dump the panel sends as a JSON string', async () => {
    const sql = 'DROP TABLE IF EXISTS `t`;\nCREATE TABLE `t` (`id` int);\n';
    const { ctx } = await makeContext([
      ...base(),
      { method: 'GET', path: `${dbsPath}/${MYSQL_DB}/sql`, handler: async () => new Response(JSON.stringify(sql), { status: 200, headers: { 'content-type': 'application/json' } }) },
    ]);
    const r = await callTool(byName(tools, 'db_export_sql'), { website: 'vahi.dev', name: 'demo' }, ctx);
    expect(r.structured).toMatchObject({ database: MYSQL_DB, sql, bytes: sql.length });
    expect(r.text).toContain(MYSQL_DB);
    // The dump itself must not be interpolated into the rendered text (convention 4).
    expect(r.text).not.toContain('CREATE TABLE');
  });
});

describe('db_import_sql', () => {
  it('is destructive and uploads the sql as multipart to the v2 endpoint', async () => {
    let seen: { contentType: string | null; filename: string; sql: string; path: string } | undefined;
    const { ctx, f } = await makeContext([
      ...base(),
      {
        method: 'POST',
        path: new RegExp(`^/v2/websites/${WEBSITE_ID}/mysql/[^/]+/sql$`),
        handler: async (req, url) => {
          const file = (await req.formData()).get('sql') as File;
          seen = { contentType: req.headers.get('content-type'), filename: file.name, sql: await file.text(), path: url.pathname.replace(/^\/api/, '') };
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
    expect(seen?.filename).toBe(`${MYSQL_DB}.sql`);
    // The spec's path template names its parameters differently from its own declaration; assert
    // the placeholders were actually substituted.
    expect(seen?.path).toBe(`/v2/websites/${WEBSITE_ID}/mysql/${MYSQL_DB}/sql`);
    expect(f.calls.at(-1)?.path).not.toContain('force');
    expect(r.structured).toMatchObject({ database: MYSQL_DB, imported: true, bytes: 27 });
  });

  it('passes the force flag through as a query parameter', async () => {
    const { ctx, f } = await makeContext([
      ...base(),
      { method: 'POST', path: new RegExp(`^/v2/websites/${WEBSITE_ID}/mysql/[^/]+/sql$`), handler: async () => new Response(null, { status: 200 }) },
    ]);
    const t = byName(tools, 'db_import_sql');
    const args = t.input.parse({ website: 'vahi.dev', name: 'demo', sql: 'SELECT 1;', force: true });
    await t.handler(args, ctx, await t.target!(args, ctx));
    expect(f.calls.at(-1)?.path).toContain('force=true');
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
