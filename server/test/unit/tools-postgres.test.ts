import { describe, expect, it } from 'vitest';
import { tools } from '../../src/tools/postgres.js';
import { base, ORG_ID, websiteDetail, WEBSITE_ID, websiteSummary, websitesList } from '../fixtures/panel.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import type { Route } from '../helpers/fakeFetch.js';

const dbsPath = `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/postgresql-dbs`;
const usersPath = `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/postgresql-users`;
const websiteLine = `website: vahi.dev (${WEBSITE_ID})`;
const PG_DB = 'vahi_dev1_shop';
const PG_USER = 'vahi_dev1_app';

/** The fixture site is on a plan without PostgreSQL (`canUse.postgresql: false`), which is what
 *  the live test panel returns. This is the same site on a plan that includes it. Every enabled
 *  test addresses the website by UUID, so the resolver goes straight to the detail route and no
 *  website listing is needed. */
const enabled = { ...websiteDetail, canUse: { ...websiteDetail.canUse, postgresql: true } };
const enabledBase = (): Route[] => [{ method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: enabled }];

/** The shapes the panel returns: the database listing reuses MySQL's, users carry `privs`. */
const pgDbs = { items: [{ name: PG_DB, size: 8192, createdAt: '2026-09-06T10:00:00.000Z', userCount: 1 }] };
const pgUsers = { items: [{ username: PG_USER, privs: [PG_DB], createdAt: '2026-09-06T10:00:00.000Z' }] };

/** Captures the JSON body and path of the single write a test makes. */
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

/** A second website that takes over the domain after `target()` has already resolved it. */
const OTHER_WEBSITE_ID = 'a1b2c3d4-5566-4778-9900-aabbccddeeff';
function movingTargetRoutes(seen: string[]): Route[] {
  let listCalls = 0;
  return [
    {
      method: 'GET',
      path: `/orgs/${ORG_ID}/websites`,
      handler: async () => {
        listCalls += 1;
        const body = listCalls === 1 ? websitesList : { items: [{ ...websiteSummary, id: OTHER_WEBSITE_ID }], total: 1 };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
    { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: enabled },
    { method: 'GET', path: `/orgs/${ORG_ID}/websites/${OTHER_WEBSITE_ID}`, body: { ...enabled, id: OTHER_WEBSITE_ID, unixUser: 'other_dev1' } },
    {
      method: 'DELETE',
      path: new RegExp(`^/orgs/${ORG_ID}/websites/[^/]+/postgresql-dbs/`),
      handler: async (_req, url) => {
        seen.push(url.pathname.replace(/^\/api/, ''));
        return new Response(null, { status: 204 });
      },
    },
  ];
}

describe('the canUse.postgresql gate', () => {
  it('reports unavailable and sends nothing to the panel when PostgreSQL is not on the plan', async () => {
    const { ctx, f } = await makeContext([...base()]);
    const r = await callTool(byName(tools, 'pg_db_list'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/postgresql.*not available/i);
    // The identity block leads, so the human sees which website was checked.
    expect(r.text).toContain(websiteLine);
    expect(r.text.indexOf(websiteLine)).toBeLessThan(r.text.indexOf('PostgreSQL is not available'));
    // It points at the MySQL tools, which this plan does have.
    expect(r.text).toContain('db_');
    expect(r.structured).toMatchObject({ available: false });
    expect(f.calls.some((c) => c.path.includes('postgresql'))).toBe(false);
  });

  it("refuses a destructive tool at target(), before anything is previewed or confirmed", async () => {
    const { ctx, f } = await makeContext([...base()]);
    const del = byName(tools, 'pg_db_delete');
    const args = del.input.parse({ website: 'vahi.dev', name: 'shop' });
    await expect(del.target!(args, ctx)).rejects.toThrow(/PostgreSQL is not available/);
    expect(f.calls.some((c) => c.path.includes('postgresql'))).toBe(false);
  });
});

describe('pg_db_list', () => {
  it('lists databases with the full name, size and user count', async () => {
    const { ctx } = await makeContext([...enabledBase(), { method: 'GET', path: dbsPath, body: pgDbs }]);
    const r = await callTool(byName(tools, 'pg_db_list'), { website: WEBSITE_ID }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain(PG_DB);
    expect(r.text).toContain('size (bytes)');
    expect(r.structured).toMatchObject({ total: 1, items: [{ database: PG_DB, sizeBytes: 8192, users: 1 }] });
  });
});

describe('pg_db_create', () => {
  it('sends the short name and reports the full prefixed name', async () => {
    const sink: { body?: unknown; path?: string } = {};
    const { ctx } = await makeContext([...enabledBase(), captureBody({ method: 'POST', path: dbsPath }, 201, sink)]);
    const r = await callTool(byName(tools, 'pg_db_create'), { website: WEBSITE_ID, name: 'shop' }, ctx);
    expect(sink.path).toBe(dbsPath);
    expect(sink.body).toEqual({ name: 'shop' });
    expect(r.structured).toMatchObject({ database: PG_DB, created: true });
    expect(r.text).toContain('localhost');
  });

  it('strips the prefix the user typed rather than sending it twice', async () => {
    const sink: { body?: unknown } = {};
    const { ctx } = await makeContext([...enabledBase(), captureBody({ method: 'POST', path: dbsPath }, 201, sink)]);
    const r = await callTool(byName(tools, 'pg_db_create'), { website: WEBSITE_ID, name: PG_DB }, ctx);
    expect(sink.body).toEqual({ name: 'shop' });
    expect(r.structured).toMatchObject({ database: PG_DB });
  });
});

describe('pg_db_delete', () => {
  it('is destructive, previews by the full name behind the identity block, and drops by it', async () => {
    let deleted: string | undefined;
    const { ctx } = await makeContext([
      ...enabledBase(),
      { method: 'DELETE', path: new RegExp(`^${dbsPath}/(.+)$`), handler: async (_req, url) => { deleted = decodeURIComponent(url.pathname.split('/').pop()!); return new Response(null, { status: 204 }); } },
    ]);
    const del = byName(tools, 'pg_db_delete');
    const args = del.input.parse({ website: WEBSITE_ID, name: 'shop' });
    const target = await del.target!(args, ctx);
    expect(target).toMatchObject({ kind: 'pg_db', id: `${WEBSITE_ID}:${PG_DB}`, name: PG_DB });
    const preview = await del.preview!(args, ctx, target);
    expect(preview).toContain(PG_DB);
    expect(preview).toContain(`org: Shaik Vahid (${ORG_ID})`);
    expect(preview).toContain(websiteLine);
    expect(preview.indexOf(websiteLine)).toBeLessThan(preview.indexOf('permanently drop'));
    const r = await del.handler(args, ctx, target);
    expect(deleted).toBe(PG_DB);
    expect(r.structured).toMatchObject({ database: PG_DB, deleted: true });
  });

  it('acts on the website the target named, even if the domain now resolves elsewhere', async () => {
    const seen: string[] = [];
    const { ctx } = await makeContext(movingTargetRoutes(seen));
    const del = byName(tools, 'pg_db_delete');
    const args = del.input.parse({ website: 'vahi.dev', name: 'shop' });
    const target = await del.target!(args, ctx);
    expect(target.id).toBe(`${WEBSITE_ID}:${PG_DB}`);
    // The panel changed under us: a different website now answers for vahi.dev.
    ctx.resolver.invalidate();
    const preview = await del.preview!(args, ctx, target);
    expect(preview).toContain(WEBSITE_ID);
    expect(preview).not.toContain(OTHER_WEBSITE_ID);
    await del.handler(args, ctx, target);
    expect(seen).toEqual([`${dbsPath}/${PG_DB}`]);
  });

  it('re-checks the gate on the confirmed website and drops nothing when PostgreSQL went away', async () => {
    let detailCalls = 0;
    const { ctx, f } = await makeContext([
      {
        method: 'GET',
        path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`,
        handler: async () => {
          detailCalls += 1;
          const body = detailCalls === 1 ? enabled : websiteDetail;
          return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
    ]);
    const del = byName(tools, 'pg_db_delete');
    const args = del.input.parse({ website: WEBSITE_ID, name: 'shop' });
    const target = await del.target!(args, ctx);
    const r = await del.handler(args, ctx, target);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/postgresql.*not available/i);
    expect(f.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('pg_users_list', () => {
  it('renders the databases each user has privileges on', async () => {
    const { ctx } = await makeContext([...enabledBase(), { method: 'GET', path: usersPath, body: pgUsers }]);
    const r = await callTool(byName(tools, 'pg_users_list'), { website: WEBSITE_ID }, ctx);
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain(PG_USER);
    expect(r.text).toContain(PG_DB);
    expect(r.text).toContain('databases');
    // structuredContent keeps the panel's own shape: the privilege list stays an array.
    expect(r.structured).toMatchObject({ total: 1, items: [{ user: PG_USER, databases: [PG_DB], createdAt: '2026-09-06T10:00:00.000Z' }] });
  });

  it('says "none" in the table for a user with no privileges', async () => {
    const { ctx } = await makeContext([...enabledBase(), { method: 'GET', path: usersPath, body: { items: [{ ...pgUsers.items[0], privs: [] }] } }]);
    const r = await callTool(byName(tools, 'pg_users_list'), { website: WEBSITE_ID }, ctx);
    expect(r.text).toContain('none');
    expect(r.structured).toMatchObject({ total: 1, items: [{ user: PG_USER, databases: [] }] });
  });
});

describe('pg_user_create', () => {
  it('generates a password when none is given and keeps it out of the rendered text', async () => {
    const sink: { body?: unknown; path?: string } = {};
    const { ctx } = await makeContext([...enabledBase(), captureBody({ method: 'POST', path: usersPath }, 201, sink)]);
    const r = await callTool(byName(tools, 'pg_user_create'), { website: WEBSITE_ID, username: 'app' }, ctx);
    const body = sink.body as { username: string; password: string };
    expect(sink.path).toBe(usersPath);
    // The panel adds the `<unixUser>_` prefix itself, so only the short name goes over the wire.
    expect(body.username).toBe('app');
    // The same fixed-length generator the MySQL tools use: `Db` + 32 base64url characters + `9x`.
    expect(body.password).toHaveLength(36);
    expect(body.password).toMatch(/^Db[A-Za-z0-9_-]{32}9x$/);
    expect(r.structured).toMatchObject({ user: PG_USER, password: body.password });
    expect(r.text).toContain('shown once');
    expect(r.text).not.toContain(body.password);
  });

  it('sends the password the user supplied and keeps it out of the rendered text', async () => {
    const sink: { body?: unknown } = {};
    const { ctx } = await makeContext([...enabledBase(), captureBody({ method: 'POST', path: usersPath }, 201, sink)]);
    const r = await callTool(byName(tools, 'pg_user_create'), { website: WEBSITE_ID, username: PG_USER, password: 'sup3r-secret-pw' }, ctx);
    expect(sink.body).toEqual({ username: 'app', password: 'sup3r-secret-pw' });
    expect(r.structured).toMatchObject({ user: PG_USER, password: 'sup3r-secret-pw' });
    expect(r.text).not.toContain('sup3r-secret-pw');
  });
});

describe('pg_user_update', () => {
  it('PATCHes the password by the full user name and keeps it out of the rendered text', async () => {
    const sink: { body?: unknown; path?: string } = {};
    const { ctx, f } = await makeContext([...enabledBase(), captureBody({ method: 'PATCH', path: new RegExp(`^${usersPath}/[^/]+$`) }, 200, sink)]);
    const r = await callTool(byName(tools, 'pg_user_update'), { website: WEBSITE_ID, username: 'app', password: 'n3w-secret-pw' }, ctx);
    expect(f.calls.at(-1)?.method).toBe('PATCH');
    expect(sink.path).toBe(`${usersPath}/${PG_USER}`);
    expect(sink.body).toEqual({ password: 'n3w-secret-pw' });
    expect(r.structured).toMatchObject({ user: PG_USER, password: 'n3w-secret-pw' });
    expect(r.text).toContain(websiteLine);
    expect(r.text).not.toContain('n3w-secret-pw');
  });
});

describe('pg_user_delete', () => {
  it('is destructive and deletes by the full user name', async () => {
    let deleted: string | undefined;
    const { ctx } = await makeContext([
      ...enabledBase(),
      { method: 'DELETE', path: new RegExp(`^${usersPath}/[^/]+$`), handler: async (_req, url) => { deleted = decodeURIComponent(url.pathname.split('/').pop()!); return new Response(null, { status: 204 }); } },
    ]);
    const del = byName(tools, 'pg_user_delete');
    const args = del.input.parse({ website: WEBSITE_ID, username: 'app' });
    const target = await del.target!(args, ctx);
    expect(target).toMatchObject({ kind: 'pg_user', id: `${WEBSITE_ID}:${PG_USER}`, name: PG_USER });
    const preview = await del.preview!(args, ctx, target);
    expect(preview).toContain(PG_USER);
    expect(preview).toContain(websiteLine);
    expect(preview.indexOf(websiteLine)).toBeLessThan(preview.indexOf('delete PostgreSQL user'));
    const r = await del.handler(args, ctx, target);
    expect(deleted).toBe(PG_USER);
    expect(r.structured).toMatchObject({ user: PG_USER, deleted: true });
  });
});

describe('pg_user_grant', () => {
  it('posts the database name as a bare JSON string, not an object', async () => {
    const { ctx, f } = await makeContext([
      ...enabledBase(),
      { method: 'POST', path: new RegExp(`^${usersPath}/[^/]+/privileges$`), handler: async () => new Response(null, { status: 201 }) },
    ]);
    const r = await callTool(byName(tools, 'pg_user_grant'), { website: WEBSITE_ID, username: 'app', database: 'shop' }, ctx);
    const call = f.calls.at(-1);
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe(`${usersPath}/${PG_USER}/privileges`);
    // The panel takes the db name itself as the body; JSON-encoded that is a quoted string.
    expect(call?.body).toBe(`"${PG_DB}"`);
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(r.structured).toMatchObject({ user: PG_USER, database: PG_DB, granted: true });
  });
});

describe('pg_user_revoke', () => {
  it('is destructive, names the database in the preview, and deletes the privilege path', async () => {
    const { ctx, f } = await makeContext([
      ...enabledBase(),
      { method: 'DELETE', path: new RegExp(`^${usersPath}/[^/]+/privileges/[^/]+$`), handler: async () => new Response(null, { status: 200 }) },
    ]);
    const t = byName(tools, 'pg_user_revoke');
    const args = t.input.parse({ website: WEBSITE_ID, username: 'app', database: 'shop' });
    const target = await t.target!(args, ctx);
    // The database is not part of the target: only the user is confirmed by name.
    expect(target).toMatchObject({ kind: 'pg_user', id: `${WEBSITE_ID}:${PG_USER}`, name: PG_USER });
    const preview = await t.preview!(args, ctx, target);
    expect(preview).toContain(websiteLine);
    expect(preview).toContain(PG_USER);
    // The preview says which database access is being taken away.
    expect(preview).toContain(PG_DB);
    const r = await t.handler(args, ctx, target);
    expect(f.calls.at(-1)?.method).toBe('DELETE');
    expect(f.calls.at(-1)?.path).toBe(`${usersPath}/${PG_USER}/privileges/${PG_DB}`);
    expect(r.structured).toMatchObject({ user: PG_USER, database: PG_DB, revoked: true });
  });
});

describe('the tool set', () => {
  it('registers the nine PostgreSQL tools, with the three destructive ones marked', () => {
    expect(tools.map((t) => t.name)).toEqual(['pg_db_list', 'pg_db_create', 'pg_db_delete', 'pg_users_list', 'pg_user_create', 'pg_user_update', 'pg_user_delete', 'pg_user_grant', 'pg_user_revoke']);
    expect(tools.filter((t) => t.risk === 'destructive').map((t) => t.name)).toEqual(['pg_db_delete', 'pg_user_delete', 'pg_user_revoke']);
    expect(tools.every((t) => t.tier === 'customer')).toBe(true);
  });
});
