import { describe, expect, it } from 'vitest';
import type { HttpProbe, ProbeRequest, ProbeResponse } from '../../src/core/probe.js';
import { commandArg, tools, validateCommand, validateProxyPath, validateWorkingDirectory } from '../../src/tools/apps.js';
import { APP_ID, base, ORG_ID, persistentApp, persistentApps, SERVER_IP, websiteDetail, WEBSITE_ID } from '../fixtures/panel.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import { writeThenList, type Route } from '../helpers/fakeFetch.js';

const websiteLine = `website: vahi.dev (${WEBSITE_ID})`;
const appsPath = `/websites/${WEBSITE_ID}/apps/persistent`;
const appPath = `${appsPath}/${APP_ID}`;

const noApps = (): Route[] => [
  { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: { items: [websiteDetail], total: 1 } },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: { ...websiteDetail, canUse: { ...websiteDetail.canUse, persistentApps: false } } },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains`, body: { items: [] } },
];

/** Captures the parsed JSON body of a write. */
function captureBody(route: Omit<Route, 'handler'>, sink: { body?: unknown; path?: string }, status = 200): Route {
  return {
    ...route,
    handler: async (req, url) => {
      const text = await req.text();
      sink.body = text ? JSON.parse(text) : undefined;
      sink.path = url.pathname.replace(/^\/api/, '');
      return new Response(null, { status });
    },
  };
}

/**
 * The create POST (its body captured into `sink`) and the app listing around it: `before` until the
 * POST, `after` from then on. The create now snapshots the listing before it writes and only counts
 * an app that was not in it, so a test that wants the new app's id must list it only AFTER the POST.
 */
function appsCreate(sink: { body?: unknown; path?: string }, after: unknown, before: unknown = [], status = 201): Route[] {
  return writeThenList({
    writePath: appsPath,
    listPath: appsPath,
    before,
    after,
    write: async (req) => {
      const text = await req.text();
      sink.body = text ? JSON.parse(text) : undefined;
      sink.path = new URL(req.url).pathname.replace(/^\/api/, '');
      return new Response(null, { status });
    },
  });
}

/**
 * A probe that answers by request path, which is what both new probe users key on: the create /
 * update preflight (one request for the candidate path) and the probe's asset check (the page,
 * then one request per asset URL). Anything not listed answers 404, the "nothing serves this" case.
 */
function pathProbe(answers: Record<string, number | Partial<ProbeResponse>>, seen: ProbeRequest[] = []): HttpProbe {
  return async (req) => {
    seen.push(req);
    const answer = answers[req.path] ?? 404;
    return { status: 200, latencyMs: 4, contentType: 'text/html', body: '', certificate: 'valid', ...(typeof answer === 'number' ? { status: answer } : answer) };
  };
}

describe('validateProxyPath', () => {
  it('accepts the panel shape and strips exactly one leading slash with a note', () => {
    expect(validateProxyPath('node')).toEqual({ path: 'node' });
    expect(validateProxyPath('api/v1.2-beta')).toEqual({ path: 'api/v1.2-beta' });
    expect(validateProxyPath('/node')).toMatchObject({ path: 'node' });
    expect(validateProxyPath('/node').note).toMatch(/leading slash/);
  });
  it('rejects what the panel rejects', () => {
    for (const bad of ['', '//node', 'node/', '-node', 'no de', 'nöde', '../x']) {
      expect(() => validateProxyPath(bad), bad).toThrow(/proxy path/);
    }
  });
});

describe('validateWorkingDirectory', () => {
  it('accepts a relative path and trims a trailing slash', () => {
    expect(validateWorkingDirectory('nodeapp')).toBe('nodeapp');
    expect(validateWorkingDirectory('apps/web/')).toBe('apps/web');
  });
  it('rejects absolute paths and parent segments', () => {
    expect(() => validateWorkingDirectory('/var/www/x/nodeapp')).toThrow(/relative to the site home/);
    expect(() => validateWorkingDirectory('../other')).toThrow(/relative to the site home/);
    expect(() => validateWorkingDirectory('a/../b')).toThrow(/relative to the site home/);
  });
});

describe('validateCommand', () => {
  it('accepts what the runner can exec as argv', () => {
    expect(validateCommand('node server.js')).toBe('node server.js');
    expect(validateCommand('  npm start  ')).toBe('npm start');
    // Quotes are fine as long as no quoted segment contains whitespace: the runner keeps them
    // verbatim inside one argv word.
    const inline = "node -e require('http').createServer((q,s)=>s.end('ok')).listen(3901)";
    expect(validateCommand(inline)).toBe(inline);
  });

  it('rejects an environment prefix, a shell operator and a quoted argument with a space', () => {
    // The runner exec's argv, so `PORT=3000` would be the program name, not a variable.
    expect(() => validateCommand('PORT=3000 node server.js')).toThrow(/environment/);
    expect(() => validateCommand('node -e "const x = 1"')).toThrow(/quoted/);
    expect(() => validateCommand('npm start | tee log')).toThrow(/shell operator/);
    expect(() => validateCommand('sh -c "npm start"')).toThrow(/quoted/);
    // A bare `&` would background the app and `$PORT` expands in no shell: both are literal argv.
    expect(() => validateCommand('npm start &')).toThrow(/shell operator/);
    expect(() => validateCommand('node server.js $PORT')).toThrow(/shell operator/);
  });

  it('always names the way out: an npm script or a wrapper script', () => {
    for (const bad of ['PORT=3000 node server.js', 'node -e "const x = 1"', 'npm start | tee log']) {
      const message = (() => {
        try {
          validateCommand(bad);
          return '';
        } catch (e) {
          return (e as Error).message;
        }
      })();
      expect(message, bad).toMatch(/without a shell/);
      expect(message, bad).toMatch(/npm script/);
      expect(message, bad).toMatch(/npm start/);
    }
  });
});

describe('the persistent-apps gate', () => {
  for (const [name, args] of [
    ['persistent_apps_list', {}],
    ['persistent_app_create', { command: 'node server.js' }],
    ['persistent_app_update', { app_id: APP_ID, command: 'node app.js' }],
    ['persistent_app_log', { app_id: APP_ID }],
  ] as const) {
    it(`${name} refuses when canUse.persistentApps is not true and sends nothing`, async () => {
      const { ctx, f } = await makeContext(noApps());
      const r = await callTool(byName(tools, name), { website: 'vahi.dev', ...args }, ctx);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('not enabled');
      expect(f.calls.some((c) => c.path.includes('/apps/persistent'))).toBe(false);
    });
  }
});

describe('persistent_apps_list', () => {
  it('renders every field and the primary-domain URL', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    const r = await callTool(byName(tools, 'persistent_apps_list'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain(APP_ID);
    expect(r.text).toContain('npm start');
    expect(r.text).toContain('https://vahi.dev/node/');
    expect(r.text).toContain('preview');
    expect(r.structured).toMatchObject({ total: 1, items: [{ id: APP_ID, kind: 'generic', command: 'npm start', workingDirectory: 'nodeapp', nodeVersion: '22.23.2', startMode: 'automatic', proxy: { path: 'node', port: 3000, websocket: false }, url: 'https://vahi.dev/node/' }] });
  });

  it('says so when there are none and points at persistent_app_create', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: [] }]);
    const r = await callTool(byName(tools, 'persistent_apps_list'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toMatch(/no persistent apps/);
    expect(r.text).toContain('persistent_app_create');
    expect(r.structured).toMatchObject({ total: 0, items: [] });
  });

  it('renders an app with the empty proxy path as the whole site', async () => {
    // Verified live: the panel accepts an empty proxy path and the app then owns every URL on the
    // domain, so the cell must not render as a blank path next to a port.
    const root = { ...persistentApp, proxyDetails: { path: '', port: 3000, allowWebSocketUpgrade: false } };
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: [root] }]);
    const r = await callTool(byName(tools, 'persistent_apps_list'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain('/ (whole site) → :3000');
    expect(r.structured).toMatchObject({ items: [{ proxy: { path: '', port: 3000 }, url: 'https://vahi.dev/' }] });
  });

  it('says an app with no Node version will not start rather than calling it the default', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: [{ ...persistentApp, nodeVersion: undefined }] }]);
    const r = await callTool(byName(tools, 'persistent_apps_list'), { website: 'vahi.dev' }, ctx);
    // Verified live: no nodeVersion means "exec: node: not found", not nvm's default alias.
    expect(r.text).toContain('will not start');
    expect(r.text).toContain('node_version');
    expect(r.structured).toMatchObject({ total: 1, items: [{ id: APP_ID, nodeVersion: null }] });
  });
});

describe('persistent_app_create', () => {
  it('posts the panel shape, then finds the new app in the listing and names its URL', async () => {
    const sink: { body?: unknown; path?: string } = {};
    const { ctx } = await makeContext([...base(), ...appsCreate(sink, persistentApps)]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', working_directory: 'nodeapp', proxy_path: 'node', port: 3000, node_version: '22.23.2' }, ctx);
    expect(sink.body).toEqual({ command: 'npm start', workingDirectory: 'nodeapp', startMode: 'automatic', nodeVersion: '22.23.2', proxyDetails: { path: 'node', port: 3000, allowWebSocketUpgrade: false } });
    expect(r.isError).toBeUndefined();
    expect(r.structured).toMatchObject({ id: APP_ID, url: 'https://vahi.dev/node/', created: true });
    expect(r.text).toContain('https://vahi.dev/node/');
    expect(r.text).toMatch(/preview .*not/);
    expect(r.text).toContain('persistent_app_log');
    // Verified live: create bounces the whole container, and the proxy path shadows a real
    // directory under public_html. Both have to reach the human who just created the app.
    expect(r.text).toMatch(/restarted the website container/);
    expect(r.text).toContain('public_html/');
  });

  it('always sends a node version and omits proxyDetails when no proxy path is given; requires a port when one is', async () => {
    const sink: { body?: unknown } = {};
    const { ctx, f } = await makeContext([...base(), ...appsCreate(sink, [{ ...persistentApp, proxyDetails: undefined, command: 'node worker.js' }])]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'node worker.js' }, ctx);
    // Verified live: an app created without a nodeVersion never starts ("exec: node: not found").
    expect(sink.body).toEqual({ command: 'node worker.js', startMode: 'automatic', nodeVersion: 'default' });
    expect(r.structured).toMatchObject({ created: true, url: null });
    // The missing port is bad input like any other: a refusal the caller can read, not a throw.
    const before = f.calls.length;
    const bad = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'node server.js', proxy_path: 'node' }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/port/);
    expect(bad.text).toContain(websiteLine);
    expect(bad.text).toMatch(/Nothing was sent to the panel/);
    expect(f.calls.slice(before).some((c) => c.method === 'POST')).toBe(false);
  });

  it('says so when port or allow_websocket is given without a proxy path', async () => {
    const sink: { body?: unknown } = {};
    const { ctx } = await makeContext([...base(), ...appsCreate(sink, [{ ...persistentApp, proxyDetails: undefined, command: 'node worker.js' }])]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'node worker.js', port: 3000, allow_websocket: true }, ctx);
    // Nothing exposes the app, so the port and the WebSocket flag were dropped: say it.
    expect(sink.body).toEqual({ command: 'node worker.js', startMode: 'automatic', nodeVersion: 'default' });
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/port\/allow_websocket ignored/);
    expect(r.structured).toMatchObject({ created: true, url: null, note: expect.stringContaining('not exposed') });
  });

  it('strips one leading slash from the proxy path and says so; rejects an absolute working directory', async () => {
    const sink: { body?: unknown } = {};
    const { ctx, f } = await makeContext([...base(), ...appsCreate(sink, persistentApps)]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', proxy_path: '/node', port: 3000 }, ctx);
    expect((sink.body as { proxyDetails: { path: string } }).proxyDetails.path).toBe('node');
    expect(r.text).toMatch(/leading slash/);
    const before = f.calls.length;
    const bad = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'node server.js', working_directory: '/var/www/x/nodeapp' }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/relative to the site home/);
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(f.calls.slice(before).some((c) => c.path.includes('/apps/persistent'))).toBe(false);
  });

  it('refuses a command the runner cannot exec without sending anything', async () => {
    const { ctx, f } = await makeContext([...base(), ...appsCreate({}, persistentApps)]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'PORT=3000 node server.js' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/environment/);
    expect(r.text).toMatch(/Nothing was sent to the panel/);
    expect(f.calls.some((c) => c.path.includes('/apps/persistent'))).toBe(false);
  });

  it('reports the app even when the listing cannot match it', async () => {
    const { ctx } = await makeContext([...base(), ...appsCreate({}, [])]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'node other.js' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.structured).toMatchObject({ created: true, id: null });
    expect(r.text).toContain('persistent_apps_list');
  });

  it('stays a success when the follow-up listing fails, because the app was already created', async () => {
    // The POST landed; only the read that looks up its id failed. Reporting that as an error would
    // tell the caller nothing was created and invite a second create of the same app.
    let posted = false;
    const { ctx } = await makeContext([
      { method: 'POST', path: appsPath, handler: async () => { posted = true; return new Response(null, { status: 201 }); } },
      { method: 'GET', path: appsPath, handler: async () => (posted ? new Response(JSON.stringify({ code: 'internal', message: 'listing is down' }), { status: 500, headers: { 'content-type': 'application/json' } }) : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })) },
      ...base(),
    ]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'node other.js' }, ctx);
    expect(r.isError, r.text).toBeUndefined();
    expect(r.structured).toMatchObject({ created: true, id: null });
    expect(r.text).toContain('persistent_apps_list');
    expect(r.text).toContain('listing is down');
  });

  it("lists every command shape the validator refuses in the argument's own description", () => {
    // The model reads this before it writes a command; the refusal text arrives too late.
    const d = commandArg.description ?? '';
    expect(d).toMatch(/VAR=value/);
    for (const op of ['|', '&', ';', '<', '>', '$', '`']) expect(d, op).toContain(op);
    expect(d).toMatch(/quoted/);
  });

  it('states what the preflight costs, in both writing tools', () => {
    for (const name of ['persistent_app_create', 'persistent_app_update']) {
      expect(byName(tools, name).description, name).toMatch(/parallel/);
      expect(byName(tools, name).description, name).toMatch(/5 s|5 seconds/);
    }
  });

  it('warns about the duplicate-path 409 and the unchecked port in its description', () => {
    const d = byName(tools, 'persistent_app_create').description;
    expect(d).toMatch(/409/);
    expect(d).toMatch(/does not check ports/);
    expect(d).toMatch(/public_html/);
    expect(d).toMatch(/without a shell/);
    expect(d).toMatch(/restarts the whole website container/);
    // Verified live: what reaches the app is the path minus the proxy prefix.
    expect(d).toMatch(/strips the path prefix/);
    expect(d).toMatch(/not basePath/);
  });

  it('reports the app this call created, not an older one with the same command', async () => {
    const OLD_ID = '11111111-2222-4333-8444-555555555555';
    const worker = { ...persistentApp, id: OLD_ID, command: 'node worker.js', workingDirectory: 'nodeapp', proxyDetails: undefined };
    // The new app is listed FIRST: "the last match" (the old heuristic) would pick the older app.
    const { ctx } = await makeContext([...appsCreate({}, [{ ...worker, id: APP_ID }, worker], [worker]), ...base()]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'node worker.js', working_directory: 'nodeapp' }, ctx);
    expect(r.isError, r.text).toBeUndefined();
    expect(r.structured).toMatchObject({ id: APP_ID, created: true });
  });

  it('confirms a create whose answer never came by finding the new app in the listing', async () => {
    const { ctx, f } = await makeContext([
      ...writeThenList({ writePath: appsPath, listPath: appsPath, before: [], after: persistentApps, write: () => { throw new TypeError('fetch failed'); } }),
      ...base(),
    ]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', working_directory: 'nodeapp', proxy_path: 'node', port: 3000 }, ctx);
    expect(r.isError, r.text).toBeUndefined();
    expect(r.text).toContain('confirmed by reading it back');
    expect(r.structured).toMatchObject({ id: APP_ID, created: true });
    expect(f.calls.filter((c) => c.method === 'POST' && c.path === appsPath)).toHaveLength(1);
  });

  it('says the outcome is unknown when the new app never appears, and posts once', async () => {
    const { ctx, f } = await makeContext([
      ...writeThenList({ writePath: appsPath, listPath: appsPath, before: [], after: [], write: () => { throw new TypeError('fetch failed'); } }),
      ...base(),
    ]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', working_directory: 'nodeapp', proxy_path: 'node', port: 3000 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain('OUTCOME UNKNOWN');
    expect(r.text).toContain('persistent_apps_list website=vahi.dev');
    expect(r.structured).toMatchObject({ outcome: 'unknown', created: null, id: null, url: 'https://vahi.dev/node/' });
    expect(f.calls.filter((c) => c.method === 'POST' && c.path === appsPath)).toHaveLength(1);
  });

  it('passes the duplicate-path 409 through as the panel refusing, with no re-reads', async () => {
    const { ctx, f } = await makeContext([{ method: 'POST', path: appsPath, status: 409, body: { code: 'already_exists', detail: 'website', message: 'An app already exists with this path' } }, { method: 'GET', path: appsPath, body: [] }, ...base()]);
    await expect(callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', proxy_path: 'node', port: 3000 }, ctx)).rejects.toThrow(/409/);
    // One read: the snapshot before the write. A refusal is never re-read.
    expect(f.calls.filter((c) => c.method === 'GET' && c.path === appsPath)).toHaveLength(1);
  });

  it('refuses without sending anything when the listing before the write cannot be read', async () => {
    // Without the snapshot the id it would report could be an older app's, so it stops before the POST.
    const { ctx, f } = await makeContext([
      { method: 'POST', path: appsPath, status: 201 },
      { method: 'GET', path: appsPath, status: 500, body: { code: 'internal', message: 'listing is down' } },
      ...base(),
    ]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'node other.js' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain('listing is down');
    expect(r.text).toMatch(/nothing was sent to the panel/);
    expect(r.text).toContain('persistent_apps_list');
    expect(r.structured).toMatchObject({ created: false });
    expect(f.calls.some((c) => c.method === 'POST' && c.path === appsPath)).toBe(false);
  });
});

describe('persistent_app_create path preflight', () => {
  /** Create routes plus whatever the follow-up listing should return. */
  const routes = (sink: { body?: unknown; path?: string }, listing: unknown = persistentApps): Route[] => [...appsCreate(sink, listing), ...base()];
  const rootApp = { ...persistentApp, workingDirectory: undefined, proxyDetails: { path: '', port: 3000, allowWebSocketUpgrade: false } };

  it('refuses a proxy path that already serves something, and sends nothing', async () => {
    // Verified live: the proxy shadows a real public_html directory, so a path that answers
    // anything but 404 today is a page this create would silently take off the web.
    const sink: { body?: unknown } = {};
    const seen: ProbeRequest[] = [];
    const { ctx, f } = await makeContext(routes(sink));
    ctx.httpProbe = pathProbe({ '/node/': 200 }, seen);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', proxy_path: 'node', port: 3000 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain('HTTP 200 on /node/');
    expect(r.text).toContain('https://vahi.dev/node/');
    expect(r.text).toContain('Registering this app would replace');
    expect(r.text).toContain('replace_existing_path');
    expect(r.text).toMatch(/Nothing was sent to the panel/);
    // Both forms are asked, because they answer differently on a real site.
    expect(seen.map((s) => s.path)).toEqual(['/node', '/node/']);
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(r.structured).toMatchObject({ created: false });
  });

  it('refuses a directory that has no index file, which only the bare path reveals', async () => {
    // Verified live 2026-09-17 on vahi.dev: an existing directory answers 404 on /dir/ whether it
    // is empty or full, and 301 to https://<domain>/dir/ on the bare /dir. The trailing-slash probe
    // alone called that directory free, and the app would then have shadowed it.
    const sink: { body?: unknown } = {};
    const seen: ProbeRequest[] = [];
    const { ctx, f } = await makeContext(routes(sink));
    ctx.httpProbe = pathProbe({ '/assets': { status: 301, location: 'https://vahi.dev/assets/' } }, seen);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', proxy_path: 'assets', port: 3000 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('HTTP 301 on /assets: an existing directory in public_html');
    expect(r.text).toMatch(/Nothing was sent to the panel/);
    expect(seen.map((s) => s.path)).toEqual(['/assets', '/assets/']);
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(r.structured).toMatchObject({ created: false, pathStatus: 301 });
  });

  it('refuses a bare path that serves a file, a trailing-slash path that serves content, and names the 200 when both answer', async () => {
    // A file answers 200 on /file and 404 on /file/; the reverse cannot happen for a directory,
    // but either form answering anything but 404 is content this create would replace. A directory
    // that does have an index answers both ways (live: demo-login), and the 200 is the more useful
    // half to name, because it is a page the reader can open.
    for (const [answers, seenText] of [
      [{ '/report.pdf': 200 }, 'HTTP 200 on /report.pdf'],
      [{ '/node/': 200 }, 'HTTP 200 on /node/'],
      [{ '/demo-login': { status: 301, location: 'https://vahi.dev/demo-login/' }, '/demo-login/': 200 }, 'HTTP 200 on /demo-login/'],
    ] as const) {
      const sink: { body?: unknown } = {};
      const { ctx, f } = await makeContext(routes(sink));
      ctx.httpProbe = pathProbe(answers);
      const path = Object.keys(answers)[0]!.replace(/^\/|\/$/g, '');
      const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', proxy_path: path, port: 3000 }, ctx);
      expect(r.isError, seenText).toBe(true);
      expect(r.text).toContain(seenText);
      expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
    }
  });

  it('creates without a word about replacing when both forms of the path answer 404 today', async () => {
    const sink: { body?: unknown } = {};
    const seen: ProbeRequest[] = [];
    const { ctx, f } = await makeContext(routes(sink));
    ctx.httpProbe = pathProbe({}, seen);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', working_directory: 'nodeapp', proxy_path: 'node', port: 3000 }, ctx);
    expect(r.isError).toBeUndefined();
    expect(seen.map((s) => s.path)).toEqual(['/node', '/node/']);
    expect(f.calls.some((c) => c.method === 'POST')).toBe(true);
    expect(r.text).not.toMatch(/would replace|replaced/);
    expect(r.text).not.toMatch(/could not be checked/);
    expect(r.structured).not.toHaveProperty('replaced');
  });

  it('proceeds with replace_existing_path and records what the app replaced', async () => {
    const sink: { body?: unknown } = {};
    const { ctx, f } = await makeContext(routes(sink));
    ctx.httpProbe = pathProbe({ '/node': { status: 301, location: 'https://vahi.dev/node/' } });
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', working_directory: 'nodeapp', proxy_path: 'node', port: 3000, replace_existing_path: true }, ctx);
    expect(r.isError).toBeUndefined();
    expect(f.calls.some((c) => c.method === 'POST')).toBe(true);
    expect(r.text).toMatch(/replaced/);
    expect(r.text).toContain('HTTP 301 on /node: an existing directory in public_html');
    // Machine-readable, so a caller that has to put the replaced content back knows what it was.
    expect(r.structured).toMatchObject({ created: true, replaced: { status: 301, path: '/node' } });
  });

  it('keeps what it took off the web when a create over a taken path has an unknown outcome', async () => {
    // Only this call saw what answered there before, and an app that lands late still replaces it.
    const { ctx } = await makeContext([
      ...writeThenList({ writePath: appsPath, listPath: appsPath, before: [], after: [], write: () => { throw new TypeError('fetch failed'); } }),
      ...base(),
    ]);
    ctx.httpProbe = pathProbe({ '/node': { status: 301, location: 'https://vahi.dev/node/' } });
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', working_directory: 'nodeapp', proxy_path: 'node', port: 3000, replace_existing_path: true }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('OUTCOME UNKNOWN');
    expect(r.text).toContain('replaced what https://vahi.dev/node/ served before');
    expect(r.text).toContain('HTTP 301 on /node: an existing directory in public_html');
    expect(r.structured).toMatchObject({ outcome: 'unknown', created: null, id: null, url: 'https://vahi.dev/node/', replaced: { status: 301, path: '/node' } });
  });

  it('says a whole-site app would own the domain even when its outcome is unknown', async () => {
    const { ctx } = await makeContext([
      ...writeThenList({ writePath: appsPath, listPath: appsPath, before: [], after: [], write: () => { throw new TypeError('fetch failed'); } }),
      ...base(),
    ]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', serve_at_root: true, port: 3000 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('OUTCOME UNKNOWN');
    expect(r.text).toContain('owns the whole domain');
    expect(r.structured).toMatchObject({ outcome: 'unknown', created: null, id: null, url: 'https://vahi.dev/' });
    expect(r.structured).not.toHaveProperty('replaced');
  });

  it('creates anyway when the preflight cannot run, and says the path was not checked', async () => {
    const sink: { body?: unknown } = {};
    const { ctx, f } = await makeContext(routes(sink));
    ctx.httpProbe = async () => {
      throw new Error('no response within 5000 ms');
    };
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', working_directory: 'nodeapp', proxy_path: 'node', port: 3000 }, ctx);
    expect(r.isError).toBeUndefined();
    expect(f.calls.some((c) => c.method === 'POST')).toBe(true);
    expect(r.text).toMatch(/could not be checked/);
    expect(r.text).toContain('no response within 5000 ms');
  });

  it('serve_at_root sends the empty proxy path, owns the domain root, and probes "/"', async () => {
    // Verified live on an empty site: an app holding the empty path answered on /, /index.html and
    // /anything/deep, and the docroot came back only when the app was deleted.
    const sink: { body?: unknown } = {};
    const seen: ProbeRequest[] = [];
    const { ctx } = await makeContext(routes(sink, [rootApp]));
    ctx.httpProbe = pathProbe({}, seen);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', serve_at_root: true, port: 3000 }, ctx);
    expect(seen.map((s) => s.path)).toEqual(['/']);
    expect(sink.body).toEqual({ command: 'npm start', startMode: 'automatic', nodeVersion: 'default', proxyDetails: { path: '', port: 3000, allowWebSocketUpgrade: false } });
    expect(r.isError).toBeUndefined();
    expect(r.structured).toMatchObject({ id: APP_ID, url: 'https://vahi.dev/', created: true });
    expect(r.text).toContain('whole domain');
    expect(r.text).toContain('public_html');
  });

  it('refuses serve_at_root on a site that already serves its root, in stronger words', async () => {
    const sink: { body?: unknown } = {};
    const { ctx, f } = await makeContext(routes(sink, [rootApp]));
    ctx.httpProbe = pathProbe({ '/': 200 });
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', serve_at_root: true, port: 3000 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('ENTIRE site');
    expect(r.text).toContain('HTTP 200 on /');
    expect(r.text).toMatch(/subdomain/);
    // Every refusal in this server says what did not happen, and this one is no exception.
    expect(r.text).toMatch(/Nothing was sent to the panel/);
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses serve_at_root together with proxy_path without probing or sending anything', async () => {
    const sink: { body?: unknown } = {};
    const { ctx, f } = await makeContext(routes(sink));
    ctx.httpProbe = async () => {
      throw new Error('must not be called');
    };
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'npm start', serve_at_root: true, proxy_path: 'node', port: 3000 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/serve_at_root/);
    expect(r.text).toMatch(/Nothing was sent to the panel/);
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('says in its description what the preflight does and what the two new flags mean', () => {
    const d = byName(tools, 'persistent_app_create').description;
    expect(d).toMatch(/404/);
    expect(d).toMatch(/replace_existing_path/);
    expect(d).toMatch(/serve_at_root/);
  });
});

describe('persistent_app_update', () => {
  it('patches only the given fields and merges the proxy with the current one', async () => {
    const sink: { body?: unknown; path?: string } = {};
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }, captureBody({ method: 'PATCH', path: appPath }, sink)]);
    const r = await callTool(byName(tools, 'persistent_app_update'), { website: 'vahi.dev', app_id: APP_ID, port: 3100 }, ctx);
    expect(sink.path).toBe(appPath);
    expect(sink.body).toEqual({ proxyDetails: { path: 'node', port: 3100, allowWebSocketUpgrade: false } });
    expect(r.structured).toMatchObject({ id: APP_ID, updated: true, url: 'https://vahi.dev/node/' });
    // Honest wording: one walkthrough PATCH (a proxy added to an app that had none) applied
    // without a restart, so the note says "usually" and names the deliberate restart.
    expect(r.text).toMatch(/usually restarts the app and the whole website container/);
    expect(r.text).toMatch(/start_mode=automatic/);
    // The URL above is the primary domain; the preview alias never proxies an app.
    expect(r.text).toContain('primary domain');
  });

  it('sends the Unset shape for clear_proxy and the "default" alias for clear_node_version', async () => {
    const sink: { body?: unknown } = {};
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }, captureBody({ method: 'PATCH', path: appPath }, sink)]);
    const r = await callTool(byName(tools, 'persistent_app_update'), { website: 'vahi.dev', app_id: APP_ID, clear_proxy: true, clear_node_version: true, start_mode: 'manual', port: 3100, node_version: '22.23.2' }, ctx);
    expect(sink.body).toEqual({ proxyDetails: { unset: true }, nodeVersion: 'default', startMode: 'manual' });
    // The clear flags win over the contradictory arguments, and the text says which were dropped.
    expect(r.text).toMatch(/clear_proxy won/);
    expect(r.text).toMatch(/clear_node_version won/);
    expect(r.structured).toMatchObject({ url: null });
    // Nothing is exposed any more, so there is no URL the preview note could be about.
    expect(r.text).not.toContain('primary domain');
  });

  it('refuses an unknown app id without patching, and refuses an empty update', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    const r = await callTool(byName(tools, 'persistent_app_update'), { website: 'vahi.dev', app_id: '00000000-0000-4000-8000-000000000000', command: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no persistent app/);
    const empty = await callTool(byName(tools, 'persistent_app_update'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/nothing to change/);
    expect(f.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('refuses a command the runner cannot exec without patching', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    const r = await callTool(byName(tools, 'persistent_app_update'), { website: 'vahi.dev', app_id: APP_ID, command: 'npm start | tee log' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/shell operator/);
    expect(f.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('refuses to move the proxy onto a path that already serves something, without patching', async () => {
    const seen: ProbeRequest[] = [];
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }, { method: 'PATCH', path: appPath }]);
    ctx.httpProbe = pathProbe({ '/demo-login/': 200 }, seen);
    const r = await callTool(byName(tools, 'persistent_app_update'), { website: 'vahi.dev', app_id: APP_ID, proxy_path: 'demo-login' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('HTTP 200 on /demo-login/');
    expect(r.text).toContain('replace_existing_path');
    // The same clash, worded for the edit that caused it: this app already exists, it is moving.
    expect(r.text).toContain("Moving this app's proxy here would replace");
    expect(r.text).not.toContain('Registering this app');
    expect(seen.map((s) => s.path)).toEqual(['/demo-login', '/demo-login/']);
    expect(f.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(r.structured).toMatchObject({ updated: false });
  });

  it('moves the proxy anyway with replace_existing_path and records what it replaced', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }, { method: 'PATCH', path: appPath }]);
    ctx.httpProbe = pathProbe({ '/demo-login/': 200 });
    const r = await callTool(byName(tools, 'persistent_app_update'), { website: 'vahi.dev', app_id: APP_ID, proxy_path: 'demo-login', replace_existing_path: true }, ctx);
    expect(r.isError, r.text).toBeUndefined();
    expect(f.calls.some((c) => c.method === 'PATCH')).toBe(true);
    expect(r.text).toMatch(/replaced/);
    expect(r.structured).toMatchObject({ updated: true, replaced: { status: 200, path: '/demo-login/' } });
  });

  it('does not preflight an update that leaves the proxy path where it is', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }, { method: 'PATCH', path: appPath }]);
    ctx.httpProbe = async () => {
      throw new Error('must not be called');
    };
    // A port-only edit, and a re-send of the path the app already holds: neither can newly shadow
    // anything, so neither is worth a request to the site.
    for (const args of [{ port: 3100 }, { proxy_path: 'node', port: 3100 }]) {
      const r = await callTool(byName(tools, 'persistent_app_update'), { website: 'vahi.dev', app_id: APP_ID, ...args }, ctx);
      expect(r.isError, r.text).toBeUndefined();
    }
    expect(f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
  });

  it('mentions the restart behaviour and the preflight in its description', () => {
    expect(byName(tools, 'persistent_app_update').description).toMatch(/restart/);
    expect(byName(tools, 'persistent_app_update').description).toMatch(/replace_existing_path/);
    // There is no patch that turns a path app into a whole-site app: the panel's empty path can
    // only be set at create time through serve_at_root, so the description has to say so.
    expect(byName(tools, 'persistent_app_update').description).toMatch(/serve_at_root/);
    expect(byName(tools, 'persistent_app_update').description).toMatch(/delete/i);
  });
});

describe('an unknown app id', () => {
  it('is refused the same way by update, log and probe, each saying nothing happened', async () => {
    // Every other refusal in this server ends by saying what did not happen; these three said only
    // "no persistent app", leaving a reader to wonder whether the call had any effect.
    for (const [name, args] of [
      ['persistent_app_update', { command: 'node app.js' }],
      ['persistent_app_log', {}],
      ['persistent_app_probe', {}],
    ] as const) {
      const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
      ctx.httpProbe = async () => {
        throw new Error('must not be called');
      };
      const r = await callTool(byName(tools, name), { website: 'vahi.dev', app_id: '00000000-0000-4000-8000-000000000000', ...args }, ctx);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(/no persistent app/);
      expect(r.text, name).toMatch(/[Nn]othing was (sent|changed|read|probed)/);
    }
  });
});

describe('persistent_app_log', () => {
  it('returns the newest 64 KB of the JSON-string log', async () => {
    const big = `${'x'.repeat(70_000)}\nlistening on 3000\n`;
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }, { method: 'GET', path: appPath, body: big }]);
    const r = await callTool(byName(tools, 'persistent_app_log'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    const s = r.structured as { bytes: number; truncated: boolean; log: string };
    expect(s.truncated).toBe(true);
    expect(s.bytes).toBe(Buffer.byteLength(big));
    expect(s.log.endsWith('listening on 3000\n')).toBe(true);
    expect(r.text).toMatch(/newest 64 KB/);
  });

  it('says the app has not written anything when the log is empty', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }, { method: 'GET', path: appPath, body: '' }]);
    const r = await callTool(byName(tools, 'persistent_app_log'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.text).toMatch(/not started yet or has not written/);
    expect(r.structured).toMatchObject({ bytes: 0, log: '' });
  });

  it('says what the panel keeps and what it returns in its description', () => {
    expect(byName(tools, 'persistent_app_log').description).toMatch(/256 KB/);
    expect(byName(tools, 'persistent_app_log').description).toMatch(/truncated on every restart/);
    expect(byName(tools, 'persistent_app_log').description).toMatch(/newest 64 KB/);
  });
});

describe('persistent_app_delete', () => {
  it('is destructive, previews the app behind the identity block, and the human types the domain', async () => {
    let deleted: string | undefined;
    const { ctx } = await makeContext([
      ...base(),
      { method: 'GET', path: appsPath, body: persistentApps },
      { method: 'DELETE', path: appPath, handler: async (_req, url) => { deleted = url.pathname.split('/').pop(); return new Response(null, { status: 200 }); } },
    ]);
    const del = byName(tools, 'persistent_app_delete');
    const args = del.input.parse({ website: 'vahi.dev', app_id: APP_ID });
    const target = await del.target!(args, ctx);
    expect(target).toMatchObject({ kind: 'persistent_app', id: `${WEBSITE_ID}:${APP_ID}`, name: 'vahi.dev' });
    const preview = await del.preview!(args, ctx, target);
    expect(preview).toContain(websiteLine);
    expect(preview).toContain('npm start');
    expect(preview).toContain('/node/');
    expect(preview.indexOf(websiteLine)).toBeLessThan(preview.indexOf('stop'));
    // Verified live: a delete bounces the whole container, exactly like create and update.
    expect(preview).toMatch(/restarts the website container/);
    const r = await del.handler(args, ctx, target);
    expect(deleted).toBe(APP_ID);
    expect(r.structured).toMatchObject({ id: APP_ID, deleted: true });
    expect(r.text).toContain(`persistent_app_${APP_ID}.log`);
  });

  it('does not re-read the app listing between the confirmation and the DELETE', async () => {
    // target() already looked the app up; the handler needs only the site, the id and the plan
    // gate, so a second listing GET is a request that is issued and then thrown away.
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }, { method: 'DELETE', path: appPath }]);
    const del = byName(tools, 'persistent_app_delete');
    const args = del.input.parse({ website: 'vahi.dev', app_id: APP_ID });
    const target = await del.target!(args, ctx);
    const before = f.calls.length;
    const r = await del.handler(args, ctx, target);
    expect(r.structured).toMatchObject({ deleted: true });
    expect(f.calls.slice(before).filter((c) => c.method === 'GET' && c.path.endsWith('/apps/persistent'))).toHaveLength(0);
  });

  it('refuses at target() for an unknown app or a plan without persistent apps, sending nothing', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: appsPath, body: [] }]);
    const del = byName(tools, 'persistent_app_delete');
    await expect(del.target!(del.input.parse({ website: 'vahi.dev', app_id: APP_ID }), ctx)).rejects.toThrow(/no persistent app/);
    const { ctx: gated, f: f2 } = await makeContext(noApps());
    await expect(del.target!(del.input.parse({ website: 'vahi.dev', app_id: APP_ID }), gated)).rejects.toThrow(/not enabled/);
    expect([...f.calls, ...f2.calls].some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('previews a whole-site app as served at the domain root, with no double slash', async () => {
    const rootApp = { ...persistentApp, proxyDetails: { path: '', port: 3000, allowWebSocketUpgrade: false } };
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: [rootApp] }]);
    const del = byName(tools, 'persistent_app_delete');
    const args = del.input.parse({ website: 'vahi.dev', app_id: APP_ID });
    const preview = await del.preview!(args, ctx, await del.target!(args, ctx));
    expect(preview).toContain('served at https://vahi.dev/');
    expect(preview).not.toContain('https://vahi.dev//');
  });

  it('cannot be made to forge an extra preview line from a hostile proxy path', async () => {
    // Everything in the preview past the identity block is panel-supplied; a path carrying a
    // newline must collapse into the line it belongs to, never open one of its own.
    const forged = { ...persistentApp, proxyDetails: { ...persistentApp.proxyDetails, path: 'node\nforged: line' } };
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: [forged] }]);
    const del = byName(tools, 'persistent_app_delete');
    const args = del.input.parse({ website: 'vahi.dev', app_id: APP_ID });
    const preview = await del.preview!(args, ctx, await del.target!(args, ctx));
    expect(preview.split('\n').some((line) => line.startsWith('forged'))).toBe(false);
  });

  it('says in its description that it is destructive and restarts the container', () => {
    const d = byName(tools, 'persistent_app_delete').description;
    expect(d).toMatch(/DESTRUCTIVE/);
    expect(d).toMatch(/restarts the website container/);
  });
});

describe('persistent_app_probe', () => {
  const fakeProbe = (answer: Partial<Awaited<ReturnType<HttpProbe>>>, seen: ProbeRequest[]): HttpProbe => async (req) => {
    seen.push(req);
    return { status: 200, latencyMs: 12, contentType: 'text/plain', body: 'mcp-c ok', certificate: 'valid', ...answer };
  };

  it('connects to the server IP with the primary domain as host and reports the answer', async () => {
    const seen: ProbeRequest[] = [];
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    ctx.httpProbe = fakeProbe({}, seen);
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(seen).toEqual([{ ip: SERVER_IP, host: 'vahi.dev', path: '/node/', timeoutMs: 5000, maxBodyBytes: 512 }]);
    expect(r.isError).toBeUndefined();
    expect(r.structured).toMatchObject({ url: 'https://vahi.dev/node/', status: 200, certificate: 'valid', body: 'mcp-c ok', reachable: true });
    expect(r.text).toContain('HTTP 200');
  });

  it('takes a proxy_path directly, flags a placeholder certificate, and treats 502/503 as the app not listening', async () => {
    const seen: ProbeRequest[] = [];
    const { ctx } = await makeContext([...base()]);
    ctx.httpProbe = fakeProbe({ status: 502, certificate: 'placeholder', body: '' }, seen);
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', proxy_path: 'node' }, ctx);
    expect(seen[0]?.path).toBe('/node/');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not (listening|answering)/);
    expect(r.text).toMatch(/placeholder/);
    expect(r.structured).toMatchObject({ status: 502, reachable: false, certificate: 'placeholder' });
  });

  it('reads a 404 under a registered app as the app not serving "/" behind the prefix-stripping proxy', async () => {
    // Verified live 2026-09-17: a Next.js app built with basePath answered its own 404 page,
    // because the proxy hands it "/" and it only serves /<path>/…. That is a build mistake, not
    // an unreachable app, so it must stay a success result carrying the hint.
    const seen: ProbeRequest[] = [];
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    ctx.httpProbe = fakeProbe({ status: 404, body: 'This page could not be found.' }, seen);
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/most likely the app's own/);
    expect(r.text).toMatch(/strips the \/node prefix/);
    expect(r.text).toMatch(/assetPrefix, not basePath/);
    expect(r.structured).toMatchObject({ status: 404, reachable: true });
  });

  it('reads a 404 on a path no app owns as the docroot answering, not the app', async () => {
    // Seen live after clear_proxy and after every delete: the same 404 the docroot returns for any
    // path that does not exist. Calling that "the app's own" sent a reader hunting a build bug.
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: [] }]);
    ctx.httpProbe = fakeProbe({ status: 404, body: '' }, []);
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', proxy_path: 'node' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/no persistent app is registered on \/node\//);
    expect(r.text).toMatch(/docroot/);
    expect(r.text).not.toMatch(/assetPrefix/);
  });

  it('checks the page assets and stays a success when every one answers', async () => {
    const seen: ProbeRequest[] = [];
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    const html = '<html><body><img src="/node/logo.svg"><script src="/node/app.js"></script></body></html>';
    ctx.httpProbe = pathProbe({ '/node/': { status: 200, body: html, contentType: 'text/html; charset=utf-8' }, '/node/logo.svg': 200, '/node/app.js': 200 }, seen);
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.structured).toMatchObject({ reachable: true, assets: { checked: 2, failed: [] } });
    // The page is read twice on purpose: 512 bytes for the report, then 64 KB to find the assets,
    // and one byte of each asset is all the status needs.
    expect(seen.map((s) => [s.path, s.maxBodyBytes])).toEqual([
      ['/node/', 512],
      ['/node/', 65536],
      ['/node/logo.svg', 1],
      ['/node/app.js', 1],
    ]);
  });

  it('fails the probe when a page asset 404s at the domain root and names the prefixed URL', async () => {
    // The user's live case: /next/ was 200 while its <img src="/next.svg"> was 404 at the domain
    // root, because assetPrefix covers only the framework's own bundles.
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    ctx.httpProbe = pathProbe({ '/node/': { status: 200, body: '<img src="/next.svg">' }, '/next.svg': 404 });
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('/next.svg');
    expect(r.text).toContain('/node/next.svg');
    expect(r.text).toMatch(/outside \/node\//);
    // The app itself is up: only its HTML is wrong, and the structured content has to keep saying so.
    expect(r.structured).toMatchObject({ status: 200, reachable: true, assets: { checked: 1, failed: [{ url: '/next.svg', status: 404, outsidePrefix: true }] } });
  });

  it('reports a 401/403 asset as access-controlled instead of failing the deploy', async () => {
    // A guarded asset is served, just not to an anonymous probe: calling that a broken deploy would
    // fail a site that works for the people who are allowed in.
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    ctx.httpProbe = pathProbe({ '/node/': { status: 200, body: '<img src="/node/private.png"><img src="/node/ok.png">' }, '/node/private.png': 403, '/node/ok.png': 200 });
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/access-controlled/);
    expect(r.text).toContain('/node/private.png');
    expect(r.structured).toMatchObject({ assets: { checked: 2, failed: [], restricted: [{ url: '/node/private.png', status: 403 }] } });
  });

  it('fails only on a definite 404, 410 or 5xx, not on every non-2xx', async () => {
    for (const [status, fails] of [[404, true], [410, true], [500, true], [503, true], [405, false], [302, false]] as const) {
      const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
      ctx.httpProbe = pathProbe({ '/node/': { status: 200, body: '<img src="/node/a.png">' }, '/node/a.png': status });
      const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
      expect(r.isError, String(status)).toBe(fails ? true : undefined);
      expect((r.structured as { assets: { failed: unknown[] } }).assets.failed, String(status)).toHaveLength(fails ? 1 : 0);
    }
  });

  it('probes a whole-site app on "/" and never calls its assets outside a prefix', async () => {
    // A root app owns every URL, so there is no prefix to be outside of — and no proxy_path to
    // pass either, which is why app_id is the only way to probe one.
    const rootApp = { ...persistentApp, proxyDetails: { path: '', port: 3000, allowWebSocketUpgrade: false } };
    const seen: ProbeRequest[] = [];
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: [rootApp] }]);
    ctx.httpProbe = pathProbe({ '/': { status: 200, body: '<img src="/logo.svg">' }, '/logo.svg': 404 }, seen);
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(seen.map((s) => s.path)).toEqual(['/', '/', '/logo.svg']);
    expect(r.isError).toBe(true);
    expect(r.structured).toMatchObject({ url: 'https://vahi.dev/', assets: { failed: [{ url: '/logo.svg', outsidePrefix: false }] } });
    expect(r.text).not.toMatch(/outside/);
    expect(byName(tools, 'persistent_app_probe').description).toMatch(/serve_at_root.*app_id|app_id.*serve_at_root/s);
  });

  it('reports an asset fetch that times out as unchecked, never as a failure', async () => {
    // The live defect: twelve parallel fetches against a 2 s deadline timed out from a distant
    // client and two healthy 200 chunks were reported broken. A timeout is not evidence.
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    const answers = pathProbe({ '/node/': { status: 200, body: '<img src="/node/slow.png">' } });
    ctx.httpProbe = async (req) => {
      if (req.path === '/node/slow.png') throw new Error('no response within 8000 ms');
      return answers(req);
    };
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/1 asset.? could not be checked in time/);
    expect(r.text).toContain('/node/slow.png');
    // `checked` counts assets that produced a definite status: a timed-out fetch is not one of them.
    expect(r.structured).toMatchObject({ assets: { attempted: 1, checked: 0, failed: [], restricted: [], unchecked: [{ url: '/node/slow.png', reason: 'no response within 8000 ms' }] } });
  });

  it('says so instead of claiming a clean bill of health when the page references more than twelve assets', async () => {
    // The cap is what keeps the probe from crawling a site, but a silent cap turns "12 assets
    // answered" into a claim about a page that names thirty.
    const urls = Array.from({ length: 14 }, (_, i) => `/node/a${i}.png`);
    const answers: Record<string, number | Partial<ProbeResponse>> = { '/node/': { status: 200, body: urls.map((u) => `<img src="${u}">`).join('') } };
    for (const u of urls) answers[u] = 200;
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    ctx.httpProbe = pathProbe(answers);
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.structured).toMatchObject({ assets: { attempted: 12, checked: 12, truncated: true, totalFound: 14, failed: [] } });
    expect(r.text).toContain('the first 12 assets the page references answered');
    expect(r.text).toContain('more were not checked');
    expect(r.text).not.toMatch(/all 12 assets/);
  });

  it('does not imply the unchecked assets are healthy when a truncated page has a broken one', async () => {
    const urls = Array.from({ length: 14 }, (_, i) => `/node/a${i}.png`);
    const answers: Record<string, number | Partial<ProbeResponse>> = { '/node/': { status: 200, body: urls.map((u) => `<img src="${u}">`).join('') }, '/node/a3.png': 404 };
    for (const u of urls) answers[u] ??= 200;
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    ctx.httpProbe = pathProbe(answers);
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('/node/a3.png');
    expect(r.text).toMatch(/not checked/);
    expect(r.structured).toMatchObject({ assets: { attempted: 12, checked: 12, truncated: true, totalFound: 14 } });
  });

  it('does not call an exactly-twelve-asset page truncated', async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `/node/b${i}.png`);
    const answers: Record<string, number | Partial<ProbeResponse>> = { '/node/': { status: 200, body: urls.map((u) => `<img src="${u}">`).join('') } };
    for (const u of urls) answers[u] = 200;
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    ctx.httpProbe = pathProbe(answers);
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.structured).toMatchObject({ assets: { attempted: 12, checked: 12, truncated: false, totalFound: 12 } });
    expect(r.text).toContain('all 12 assets the page references answered');
  });

  it('fails on a definite 404 while a timed-out asset in the same page stays unchecked', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    const html = '<img src="/next.svg"><script src="/node/slow.js"></script><link rel="stylesheet" href="/node/app.css">';
    const answers = pathProbe({ '/node/': { status: 200, body: html }, '/node/app.css': 200, '/next.svg': 404 });
    ctx.httpProbe = async (req) => {
      if (req.path === '/node/slow.js') throw new Error('no response within 8000 ms');
      return answers(req);
    };
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.isError).toBe(true);
    const assets = (r.structured as { assets: { failed: unknown[]; unchecked: unknown[] } }).assets;
    expect(assets.failed).toEqual([{ url: '/next.svg', status: 404, outsidePrefix: true }]);
    expect(assets.unchecked).toEqual([{ url: '/node/slow.js', reason: 'no response within 8000 ms' }]);
    expect(r.text).toMatch(/could not be checked in time/);
    expect(r.text).toContain('/node/slow.js');
  });

  it('fetches at most four assets at a time, with an 8 s deadline and one byte each', async () => {
    // Twelve at once is what pushed each fetch past its deadline on a ~0.8 s round trip.
    const urls = Array.from({ length: 12 }, (_, i) => `/node/a${i}.png`);
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    const seen: ProbeRequest[] = [];
    let inFlight = 0;
    let peak = 0;
    ctx.httpProbe = async (req) => {
      seen.push(req);
      if (req.path === '/node/') return { status: 200, latencyMs: 4, contentType: 'text/html', body: urls.map((u) => `<img src="${u}">`).join(''), certificate: 'valid' };
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return { status: 200, latencyMs: 4, contentType: 'image/png', body: '', certificate: 'valid' };
    };
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(peak).toBe(4);
    const assetRequests = seen.filter((s) => s.path.startsWith('/node/a'));
    expect(assetRequests).toHaveLength(12);
    expect(assetRequests.every((s) => s.timeoutMs === 8000 && s.maxBodyBytes === 1)).toBe(true);
    expect(r.isError).toBeUndefined();
    expect(r.structured).toMatchObject({ assets: { checked: 12, failed: [], unchecked: [] } });
  });

  it('checks no assets for a non-HTML response or when check_assets is off', async () => {
    for (const [args, answer] of [
      [{}, { status: 200, body: '{"ok":true}', contentType: 'application/json' }],
      [{ check_assets: false }, { status: 200, body: '<img src="/next.svg">', contentType: 'text/html' }],
    ] as const) {
      const seen: ProbeRequest[] = [];
      const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
      ctx.httpProbe = pathProbe({ '/node/': answer }, seen);
      const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID, ...args }, ctx);
      expect(r.isError).toBeUndefined();
      expect(seen).toHaveLength(1);
      expect(r.structured).not.toHaveProperty('assets');
    }
  });

  it('reports a connection failure as an error result with the reason', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
    ctx.httpProbe = async () => { throw new Error('no response within 5000 ms'); };
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('no response within 5000 ms');
    expect(r.structured).toMatchObject({ reachable: false });
  });

  it('refuses an app without a proxy and requires app_id or proxy_path', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: [{ ...persistentApp, proxyDetails: undefined }] }]);
    ctx.httpProbe = async () => { throw new Error('must not be called'); };
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no proxy/);
    // Missing arguments are a refusal like any other: the identity block first, then the reason.
    const neither = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev' }, ctx);
    expect(neither.isError).toBe(true);
    expect(neither.text).toContain(websiteLine);
    expect(neither.text).toMatch(/app_id or proxy_path/);
    expect(neither.structured).toMatchObject({ reachable: false });
  });
  it('maps 503 and 504 like 502: the web server answered, the app did not', async () => {
    for (const status of [503, 504]) {
      const seen: ProbeRequest[] = [];
      const { ctx } = await makeContext([...base(), { method: 'GET', path: appsPath, body: persistentApps }]);
      ctx.httpProbe = fakeProbe({ status, body: '' }, seen);
      const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
      expect(r.isError, String(status)).toBe(true);
      expect(r.text, String(status)).toMatch(/not listening/);
      // The failure prints the URL, so it carries the same caveat the success line does.
      expect(r.text, String(status)).toMatch(/primary domain only/);
      expect(r.structured, String(status)).toMatchObject({ status, reachable: false });
    }
  });

  it('connects to the primary server IP, not merely the first one listed', async () => {
    const seen: ProbeRequest[] = [];
    // The override comes first: fakeFetch answers with the first matching route.
    const { ctx } = await makeContext([
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: { ...websiteDetail, serverIps: [{ ip: '10.0.0.1', isPrimary: false }, { ip: SERVER_IP, isPrimary: true }] } },
      ...base(),
      { method: 'GET', path: appsPath, body: persistentApps },
    ]);
    ctx.httpProbe = fakeProbe({}, seen);
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(seen[0]?.ip).toBe(SERVER_IP);
    expect(r.structured).toMatchObject({ ip: SERVER_IP });
  });

  it('refuses when the website has no server IP, without probing', async () => {
    const { ctx } = await makeContext([
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: { ...websiteDetail, serverIps: [] } },
      ...base(),
      { method: 'GET', path: appsPath, body: persistentApps },
    ]);
    ctx.httpProbe = async () => { throw new Error('must not be called'); };
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', app_id: APP_ID }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no server IP/);
    expect(r.structured).toMatchObject({ reachable: false });
  });

  it('refuses a proxy_path the panel would reject, without probing', async () => {
    const { ctx } = await makeContext([...base()]);
    ctx.httpProbe = async () => { throw new Error('must not be called'); };
    const r = await callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev', proxy_path: '../etc' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/proxy path/);
    expect(r.structured).toMatchObject({ reachable: false });
  });
});
