import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tools } from '../../src/tools/mysql.js';
import { base, MYSQL_DB, mysqlDbs, ORG_ID, websiteDetail, WEBSITE_ID, websiteSummary, websitesList } from '../fixtures/panel.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import type { Route } from '../helpers/fakeFetch.js';

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
  const sqlWithMultibyte = "DROP TABLE IF EXISTS `t`;\nINSERT INTO `t` VALUES ('café');\n";
  const exportRoute = (body: string): Route => ({
    method: 'GET',
    path: `${dbsPath}/${MYSQL_DB}/sql`,
    handler: async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  });

  it('returns the dump the panel sends as a JSON string, sized in bytes', async () => {
    const { ctx } = await makeContext([...base(), exportRoute(sqlWithMultibyte)]);
    const r = await callTool(byName(tools, 'db_export_sql'), { website: 'vahi.dev', name: 'demo' }, ctx);
    expect(Buffer.byteLength(sqlWithMultibyte)).not.toBe(sqlWithMultibyte.length);
    expect(r.structured).toMatchObject({ database: MYSQL_DB, sql: sqlWithMultibyte, bytes: Buffer.byteLength(sqlWithMultibyte) });
    expect(r.text).toContain(MYSQL_DB);
    // The dump itself must not be interpolated into the rendered text (convention 4).
    expect(r.text).not.toContain('INSERT INTO');
  });

  it('refuses to inline a dump over 256 KB and points at save_to', async () => {
    const big = `-- big dump\n${'a'.repeat(262_200)}`;
    const { ctx } = await makeContext([...base(), exportRoute(big)]);
    const r = await callTool(byName(tools, 'db_export_sql'), { website: 'vahi.dev', name: 'demo' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.structured).toMatchObject({ database: MYSQL_DB, bytes: Buffer.byteLength(big), tooLarge: true });
    expect(r.structured).not.toHaveProperty('sql');
    expect(r.text).toContain('save_to');
  });

  it('writes the dump to save_to at mode 0600 and keeps it out of structuredContent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'enhance-mcp-export-'));
    const path = join(dir, 'dump.sql');
    const { ctx } = await makeContext([...base(), exportRoute(sqlWithMultibyte)]);
    const r = await callTool(byName(tools, 'db_export_sql'), { website: 'vahi.dev', name: 'demo', save_to: path }, ctx);
    expect(r.isError).toBeFalsy();
    expect(readFileSync(path, 'utf8')).toBe(sqlWithMultibyte);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(r.structured).toMatchObject({ database: MYSQL_DB, path, bytes: Buffer.byteLength(sqlWithMultibyte), saved: true });
    expect(r.structured).not.toHaveProperty('sql');
    expect(r.text).toContain(path);
  });

  it('refuses to overwrite an existing file unless overwrite is passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'enhance-mcp-export-'));
    const path = join(dir, 'dump.sql');
    writeFileSync(path, 'keep me');
    const { ctx } = await makeContext([...base(), exportRoute(sqlWithMultibyte)]);
    const r = await callTool(byName(tools, 'db_export_sql'), { website: 'vahi.dev', name: 'demo', save_to: path }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('overwrite');
    expect(readFileSync(path, 'utf8')).toBe('keep me');
    expect(r.structured).not.toHaveProperty('sql');

    const r2 = await callTool(byName(tools, 'db_export_sql'), { website: 'vahi.dev', name: 'demo', save_to: path, overwrite: true }, ctx);
    expect(r2.isError).toBeFalsy();
    expect(readFileSync(path, 'utf8')).toBe(sqlWithMultibyte);
  });

  it('fails clearly when the save_to directory does not exist, and never writes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'enhance-mcp-export-'));
    const path = join(dir, 'nope', 'dump.sql');
    const { ctx } = await makeContext([...base(), exportRoute(sqlWithMultibyte)]);
    const r = await callTool(byName(tools, 'db_export_sql'), { website: 'vahi.dev', name: 'demo', save_to: path }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('directory');
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a relative save_to rather than writing next to whatever the cwd happens to be', async () => {
    const { ctx } = await makeContext([...base(), exportRoute(sqlWithMultibyte)]);
    const r = await callTool(byName(tools, 'db_export_sql'), { website: 'vahi.dev', name: 'demo', save_to: 'dump.sql' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('absolute');
    expect(existsSync('dump.sql')).toBe(false);
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
