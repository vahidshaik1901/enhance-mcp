import { describe, expect, it } from 'vitest';
import type { HttpProbe, ProbeRequest } from '../../src/core/probe.js';
import { tools, validateCommand, validateProxyPath, validateWorkingDirectory } from '../../src/tools/apps.js';
import { APP_ID, base, ORG_ID, persistentApp, persistentApps, SERVER_IP, websiteDetail, WEBSITE_ID } from '../fixtures/panel.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import type { Route } from '../helpers/fakeFetch.js';

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
    const { ctx } = await makeContext([
      ...base(),
      captureBody({ method: 'POST', path: appsPath }, sink, 201),
      { method: 'GET', path: appsPath, body: persistentApps },
    ]);
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
    const { ctx, f } = await makeContext([...base(), captureBody({ method: 'POST', path: appsPath }, sink, 201), { method: 'GET', path: appsPath, body: [{ ...persistentApp, proxyDetails: undefined, command: 'node worker.js' }] }]);
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
    const { ctx } = await makeContext([...base(), captureBody({ method: 'POST', path: appsPath }, sink, 201), { method: 'GET', path: appsPath, body: [{ ...persistentApp, proxyDetails: undefined, command: 'node worker.js' }] }]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'node worker.js', port: 3000, allow_websocket: true }, ctx);
    // Nothing exposes the app, so the port and the WebSocket flag were dropped: say it.
    expect(sink.body).toEqual({ command: 'node worker.js', startMode: 'automatic', nodeVersion: 'default' });
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/port\/allow_websocket ignored/);
    expect(r.structured).toMatchObject({ created: true, url: null, note: expect.stringContaining('not exposed') });
  });

  it('strips one leading slash from the proxy path and says so; rejects an absolute working directory', async () => {
    const sink: { body?: unknown } = {};
    const { ctx, f } = await makeContext([...base(), captureBody({ method: 'POST', path: appsPath }, sink, 201), { method: 'GET', path: appsPath, body: persistentApps }]);
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
    const { ctx, f } = await makeContext([...base(), { method: 'POST', path: appsPath, status: 201 }, { method: 'GET', path: appsPath, body: persistentApps }]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'PORT=3000 node server.js' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/environment/);
    expect(r.text).toMatch(/Nothing was sent to the panel/);
    expect(f.calls.some((c) => c.path.includes('/apps/persistent'))).toBe(false);
  });

  it('reports the app even when the listing cannot match it', async () => {
    const { ctx } = await makeContext([...base(), { method: 'POST', path: appsPath, status: 201 }, { method: 'GET', path: appsPath, body: [] }]);
    const r = await callTool(byName(tools, 'persistent_app_create'), { website: 'vahi.dev', command: 'node other.js' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.structured).toMatchObject({ created: true, id: null });
    expect(r.text).toContain('persistent_apps_list');
  });

  it('warns about the duplicate-path 409 and the unchecked port in its description', () => {
    const d = byName(tools, 'persistent_app_create').description;
    expect(d).toMatch(/409/);
    expect(d).toMatch(/does not check ports/);
    expect(d).toMatch(/public_html/);
    expect(d).toMatch(/without a shell/);
    expect(d).toMatch(/restarts the whole website container/);
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
    expect(r.text).toMatch(/restarts the app and, verified live, the whole website container/);
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

  it('mentions the restart behaviour in its description', () => {
    expect(byName(tools, 'persistent_app_update').description).toMatch(/restart/);
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

  it('refuses at target() for an unknown app or a plan without persistent apps, sending nothing', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: appsPath, body: [] }]);
    const del = byName(tools, 'persistent_app_delete');
    await expect(del.target!(del.input.parse({ website: 'vahi.dev', app_id: APP_ID }), ctx)).rejects.toThrow(/no persistent app/);
    const { ctx: gated, f: f2 } = await makeContext(noApps());
    await expect(del.target!(del.input.parse({ website: 'vahi.dev', app_id: APP_ID }), gated)).rejects.toThrow(/not enabled/);
    expect([...f.calls, ...f2.calls].some((c) => c.method === 'DELETE')).toBe(false);
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
    await expect(callTool(byName(tools, 'persistent_app_probe'), { website: 'vahi.dev' }, ctx)).rejects.toThrow(/app_id or proxy_path/);
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
