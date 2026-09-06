import { describe, expect, it } from 'vitest';
import { tailLog, tools } from '../../src/tools/php.js';
import { base, DOMAIN_ID, ORG_ID, PREVIEW_DOMAIN_ID, websiteDetail, WEBSITE_ID } from '../fixtures/panel.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import type { Route } from '../helpers/fakeFetch.js';

const detailPath = `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`;
const websiteLine = `website: vahi.dev (${WEBSITE_ID})`;

/** Captures the raw request body exactly as it went over the wire. The extension and Redis
 *  endpoints take a bare JSON scalar (`"apcu"`, `true`), not an object, so the test has to see
 *  the unparsed text: `req.json()` would hide the difference between `"apcu"` and `{...}`. */
function captureRaw(route: Omit<Route, 'handler'>, sink: { raw?: string; path?: string }, status = 200): Route {
  return {
    ...route,
    handler: async (req, url) => {
      sink.raw = await req.text();
      sink.path = url.pathname.replace(/^\/api/, '');
      return new Response(null, { status });
    },
  };
}

describe('php_extensions_list', () => {
  it('shows enabled, available and built-in extensions', async () => {
    const { ctx, f } = await makeContext([
      ...base(),
      { method: 'GET', path: `/websites/${WEBSITE_ID}/php_extensions`, body: ['pgsql', 'pdo_pgsql'] },
      { method: 'GET', path: `/websites/${WEBSITE_ID}/available_php_extensions`, body: ['apcu', 'pgsql'] },
      { method: 'GET', path: `/websites/${WEBSITE_ID}/built_in_php_extensions`, body: ['mysqli', 'redis'] },
    ]);
    const r = await callTool(byName(tools, 'php_extensions_list'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ enabled: ['pgsql', 'pdo_pgsql'], available: ['apcu', 'pgsql'], builtIn: ['mysqli', 'redis'] });
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain('apcu');
    expect(r.isError).toBeUndefined();
    const paths = f.calls.filter((c) => c.method === 'GET').map((c) => c.path);
    expect(paths).toContain(`/websites/${WEBSITE_ID}/php_extensions`);
    expect(paths).toContain(`/websites/${WEBSITE_ID}/available_php_extensions`);
    expect(paths).toContain(`/websites/${WEBSITE_ID}/built_in_php_extensions`);
  });

  it('says none rather than an empty line when nothing is enabled', async () => {
    const { ctx } = await makeContext([
      ...base(),
      { method: 'GET', path: `/websites/${WEBSITE_ID}/php_extensions`, body: [] },
      { method: 'GET', path: `/websites/${WEBSITE_ID}/available_php_extensions`, body: ['apcu'] },
      { method: 'GET', path: `/websites/${WEBSITE_ID}/built_in_php_extensions`, body: ['mysqli'] },
    ]);
    const r = await callTool(byName(tools, 'php_extensions_list'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain('enabled: none');
    expect(r.structured).toMatchObject({ enabled: [] });
  });
});

describe('php_extension_enable', () => {
  it('sends the extension name as a bare JSON string', async () => {
    const sink: { raw?: string; path?: string } = {};
    const { ctx } = await makeContext([...base(), captureRaw({ method: 'POST', path: `/websites/${WEBSITE_ID}/php_extensions` }, sink)]);
    const r = await callTool(byName(tools, 'php_extension_enable'), { website: 'vahi.dev', extension: 'apcu' }, ctx);
    expect(sink.raw).toBe('"apcu"');
    expect(sink.path).toBe(`/websites/${WEBSITE_ID}/php_extensions`);
    expect(r.structured).toMatchObject({ extension: 'apcu', enabled: true });
    expect(r.text).toContain('website_restart_php');
  });
});

describe('php_extension_disable', () => {
  it('sends the extension name as a bare JSON string on DELETE', async () => {
    const sink: { raw?: string; path?: string } = {};
    const { ctx, f } = await makeContext([...base(), captureRaw({ method: 'DELETE', path: `/websites/${WEBSITE_ID}/php_extensions` }, sink)]);
    const r = await callTool(byName(tools, 'php_extension_disable'), { website: 'vahi.dev', extension: 'pgsql' }, ctx);
    expect(sink.raw).toBe('"pgsql"');
    expect(f.calls.some((c) => c.method === 'DELETE' && c.path === `/websites/${WEBSITE_ID}/php_extensions`)).toBe(true);
    expect(r.structured).toMatchObject({ extension: 'pgsql', enabled: false });
  });
});

describe('php_workers_get', () => {
  it('shows the LSAPI child process count', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `/websites/${WEBSITE_ID}/lsphp_settings`, body: { lsapiChildren: 10 } }]);
    const r = await callTool(byName(tools, 'php_workers_get'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain('LSAPI children: 10');
    expect(r.structured).toMatchObject({ lsapiChildren: 10 });
  });
});

describe('php_workers_set', () => {
  it('puts the new child count', async () => {
    const sink: { raw?: string; path?: string } = {};
    const { ctx } = await makeContext([...base(), captureRaw({ method: 'PUT', path: `/websites/${WEBSITE_ID}/lsphp_settings` }, sink)]);
    const r = await callTool(byName(tools, 'php_workers_set'), { website: 'vahi.dev', lsapi_children: 25 }, ctx);
    expect(sink.raw).toBe('{"lsapiChildren":25}');
    expect(r.structured).toMatchObject({ lsapiChildren: 25 });
    expect(r.text).toContain('LSAPI children set to 25');
  });

  it('rejects a child count outside the allowed range before any request', async () => {
    const { ctx, f } = await makeContext([...base()]);
    const before = f.calls.length;
    await expect(callTool(byName(tools, 'php_workers_set'), { website: 'vahi.dev', lsapi_children: 0 }, ctx)).rejects.toThrow();
    expect(f.calls.length).toBe(before);
  });
});

describe('php_error_log', () => {
  it('reports an empty log plainly', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `/websites/${WEBSITE_ID}/php_error_log`, body: '' }]);
    const r = await callTool(byName(tools, 'php_error_log'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain('empty');
    expect(r.structured).toMatchObject({ log: '', bytes: 0, truncated: false });
  });

  it('returns the log body in structuredContent', async () => {
    const log = 'PHP Warning:  Undefined variable $x in /var/www/index.php on line 3\n';
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `/websites/${WEBSITE_ID}/php_error_log`, body: log }]);
    const r = await callTool(byName(tools, 'php_error_log'), { website: 'vahi.dev' }, ctx);
    // parseScalarText unwraps the JSON quoting but leaves the log's own text untouched,
    // trailing newline included, so nothing in a line is lost.
    expect(r.structured).toMatchObject({ log, bytes: Buffer.byteLength(log), truncated: false });
    expect(r.text).toContain('structuredContent.log');
  });

  it('keeps only the last 64 KB of a long log and says it was truncated', async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} PHP Warning: something happened in /var/www/index.php`);
    const log = lines.join('\n');
    expect(Buffer.byteLength(log)).toBeGreaterThan(65536);
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `/websites/${WEBSITE_ID}/php_error_log`, body: log }]);
    const r = await callTool(byName(tools, 'php_error_log'), { website: 'vahi.dev' }, ctx);
    const s = r.structured as { log: string; bytes: number; truncated: boolean };
    expect(s.truncated).toBe(true);
    expect(s.bytes).toBe(Buffer.byteLength(log));
    expect(Buffer.byteLength(s.log)).toBeLessThanOrEqual(65536);
    expect(s.log.endsWith(lines[lines.length - 1] as string)).toBe(true);
    expect(s.log.startsWith('line ')).toBe(true);
    expect(s.log).not.toContain('line 0 PHP');
    expect(r.text).toContain('truncated');
  });
});

describe('tailLog', () => {
  it('leaves a log at or under the cap untouched', () => {
    const text = 'x'.repeat(16);
    expect(tailLog(text, 16)).toEqual({ log: text, bytes: 16, truncated: false });
  });

  it('counts bytes, not characters', () => {
    // Four two-byte characters are 8 bytes: over a 7-byte cap, under an 8-character one.
    expect(tailLog('\u00e9\u00e9\u00e9\u00e9', 7).truncated).toBe(true);
    expect(tailLog('\u00e9\u00e9\u00e9\u00e9', 8).truncated).toBe(false);
  });

  it('keeps the raw tail when the excerpt holds no line break', () => {
    const r = tailLog('abcdefghij', 4);
    expect(r).toEqual({ log: 'ghij', bytes: 10, truncated: true });
  });

  it('drops the partial first line, and with it any half of a multi-byte character', () => {
    const text = `${'\u00e9'.repeat(20)}\nsecond line\n`;
    const r = tailLog(text, 20);
    expect(r.truncated).toBe(true);
    expect(r.log).toBe('second line\n');
    expect(r.log).not.toContain('\ufffd');
  });
});

describe('redis_state_get', () => {
  it('reports the current state', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `/v2/websites/${WEBSITE_ID}/redis`, body: true }]);
    const r = await callTool(byName(tools, 'redis_state_get'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain('redis: on');
    expect(r.structured).toMatchObject({ redis: true });
  });

  it('reports off when the panel says false', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `/v2/websites/${WEBSITE_ID}/redis`, body: false }]);
    const r = await callTool(byName(tools, 'redis_state_get'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain('redis: off');
    expect(r.structured).toMatchObject({ redis: false });
  });
});

describe('redis_state_set', () => {
  it('sends a bare boolean body when turning it on', async () => {
    const sink: { raw?: string; path?: string } = {};
    const { ctx } = await makeContext([...base(), captureRaw({ method: 'PUT', path: `/v2/websites/${WEBSITE_ID}/redis` }, sink)]);
    const r = await callTool(byName(tools, 'redis_state_set'), { website: 'vahi.dev', enabled: true }, ctx);
    expect(sink.raw).toBe('true');
    expect(sink.path).toBe(`/v2/websites/${WEBSITE_ID}/redis`);
    expect(r.structured).toMatchObject({ redis: true });
  });

  it('sends false rather than dropping the body when turning it off', async () => {
    const sink: { raw?: string; path?: string } = {};
    const { ctx } = await makeContext([...base(), captureRaw({ method: 'PUT', path: `/v2/websites/${WEBSITE_ID}/redis` }, sink)]);
    const r = await callTool(byName(tools, 'redis_state_set'), { website: 'vahi.dev', enabled: false }, ctx);
    expect(sink.raw).toBe('false');
    expect(r.structured).toMatchObject({ redis: false });
  });

  it('refuses to enable Redis on a plan without it and sends nothing', async () => {
    const noRedis = { ...websiteDetail, canUse: { ...websiteDetail.canUse, redis: false } };
    const { ctx, f } = await makeContext([{ method: 'GET', path: detailPath, body: noRedis }]);
    const r = await callTool(byName(tools, 'redis_state_set'), { website: WEBSITE_ID, enabled: true }, ctx);
    expect(r.isError).toBe(true);
    expect(r.structured).toMatchObject({ redis: false, available: false });
    expect(f.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('still turns Redis off on a plan without it', async () => {
    const noRedis = { ...websiteDetail, canUse: { ...websiteDetail.canUse, redis: false } };
    const sink: { raw?: string; path?: string } = {};
    const { ctx } = await makeContext([{ method: 'GET', path: detailPath, body: noRedis }, captureRaw({ method: 'PUT', path: `/v2/websites/${WEBSITE_ID}/redis` }, sink)]);
    const r = await callTool(byName(tools, 'redis_state_set'), { website: WEBSITE_ID, enabled: false }, ctx);
    expect(sink.raw).toBe('false');
    expect(r.isError).toBeUndefined();
  });
});

describe('cache_clear', () => {
  it('clears the FastCGI cache for the resolved domain', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'DELETE', path: `/v2/domains/${DOMAIN_ID}/nginx_fastcgi`, status: 200, body: null }]);
    const r = await callTool(byName(tools, 'cache_clear'), { website: 'vahi.dev' }, ctx);
    expect(f.calls.some((c) => c.method === 'DELETE' && c.path === `/v2/domains/${DOMAIN_ID}/nginx_fastcgi`)).toBe(true);
    expect(r.text).toMatch(/website_restart_php/);
    expect(r.text).toContain(`domain: vahi.dev (${DOMAIN_ID}) \u00b7 primary`);
    expect(r.structured).toMatchObject({ domain: 'vahi.dev', domainId: DOMAIN_ID, cleared: true });
  });

  it('clears the cache for a named alias domain', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'DELETE', path: `/v2/domains/${PREVIEW_DOMAIN_ID}/nginx_fastcgi`, status: 200, body: null }]);
    const r = await callTool(byName(tools, 'cache_clear'), { website: 'vahi.dev', domain: 'vahi-dev-ccyq.sgp1.mystaging.site' }, ctx);
    expect(f.calls.some((c) => c.method === 'DELETE' && c.path === `/v2/domains/${PREVIEW_DOMAIN_ID}/nginx_fastcgi`)).toBe(true);
    expect(r.structured).toMatchObject({ domain: 'vahi-dev-ccyq.sgp1.mystaging.site', domainId: PREVIEW_DOMAIN_ID });
  });
});

describe('the php tool set', () => {
  it('exports every tool at the customer tier with no destructive ones', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'php_extensions_list', 'php_extension_enable', 'php_extension_disable', 'php_workers_get',
      'php_workers_set', 'php_error_log', 'redis_state_get', 'redis_state_set', 'cache_clear',
    ]);
    expect(tools.every((t) => t.tier === 'customer')).toBe(true);
    expect(tools.some((t) => t.risk === 'destructive')).toBe(false);
  });
});
