import { describe, expect, it } from 'vitest';
import { tools } from '../../src/tools/htaccess.js';
import { base, ORG_ID, WEBSITE_ID } from '../fixtures/panel.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import type { Route } from '../helpers/fakeFetch.js';

const htPath = `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/htaccess`;
const ipsPath = `${htPath}/ips`;
const websiteLine = `website: vahi.dev (${WEBSITE_ID})`;

/** Captures the method, path and parsed JSON body of the single write a test makes, so the
 *  assertion is on what the panel actually saw rather than on what the tool claims it sent. */
function captureBody(route: Omit<Route, 'handler'>, sink: { method?: string; path?: string; body?: unknown }): Route {
  return {
    ...route,
    handler: async (req, url) => {
      sink.method = req.method;
      sink.path = url.pathname.replace(/^\/api/, '');
      sink.body = await req.json();
      return new Response(null, { status: 204 });
    },
  };
}

/** Captures every write to a route, in order, so a tool that sends a sequence of requests can be
 *  asserted on exactly what the panel saw and in which order. */
function captureBodies(route: Omit<Route, 'handler'>, sink: unknown[]): Route {
  return {
    ...route,
    handler: async (req) => {
      sink.push(await req.json());
      return new Response(null, { status: 204 });
    },
  };
}

const chain = { lineNumber: 1, rule: { pattern: '^old$', substitution: '/new', flags: ['R=301', 'L'] }, conds: [{ testString: '%{HTTP_HOST}', condPattern: '^www\\.', flags: ['NC'] }] };

describe('htaccess_rewrites_get', () => {
  it('returns the rewrite chains as a table and untouched in structuredContent', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: htPath, body: { items: [chain] } }]);
    const r = await callTool(byName(tools, 'htaccess_rewrites_get'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain('^old$');
    expect(r.text).toContain('/new');
    expect(r.text).toContain('R=301,L');
    expect(r.structured).toEqual({ total: 1, items: [chain] });
  });

  it('renders an empty chain list without inventing rows', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: htPath, body: { items: [] } }]);
    const r = await callTool(byName(tools, 'htaccess_rewrites_get'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain('managed rewrite chains (0)');
    expect(r.structured).toEqual({ total: 0, items: [] });
  });
});

describe('htaccess_rewrites_set', () => {
  it('PATCHes exactly the given chains, defaulting conds to an empty array', async () => {
    const sink: { method?: string; path?: string; body?: unknown } = {};
    const { ctx } = await makeContext([...base(), captureBody({ method: 'PATCH', path: htPath }, sink)]);
    const bare = { lineNumber: 4, rule: { pattern: '^gone$', substitution: '-', flags: ['G'] } };
    const r = await callTool(byName(tools, 'htaccess_rewrites_set'), { website: 'vahi.dev', items: [chain, bare] }, ctx);
    expect(sink.method).toBe('PATCH');
    expect(sink.path).toBe(htPath);
    expect(sink.body).toEqual({ items: [chain, { ...bare, conds: [] }] });
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain('2 chain(s)');
    expect(r.structured).toEqual({ total: 2 });
  });

  it('reports the upsert semantics the panel actually has: chains left out are kept', async () => {
    const sink: { method?: string; path?: string; body?: unknown } = {};
    const { ctx } = await makeContext([...base(), captureBody({ method: 'PATCH', path: htPath }, sink)]);
    const r = await callTool(byName(tools, 'htaccess_rewrites_set'), { website: 'vahi.dev', items: [chain] }, ctx);
    expect(r.text).toContain('line(s) 1');
    expect(r.text).toContain('kept');
    expect(r.text).not.toContain('dropped');
    expect(byName(tools, 'htaccess_rewrites_set').description).toContain('htaccess_rewrites_delete');
  });

  it('rejects a chain with no rule pattern before anything is sent', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'PATCH', path: htPath, status: 204 }]);
    const bad = { lineNumber: 1, rule: { substitution: '/new', flags: [] } };
    await expect(callTool(byName(tools, 'htaccess_rewrites_set'), { website: 'vahi.dev', items: [bad] }, ctx)).rejects.toThrow();
    expect(f.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

describe('htaccess_rewrites_delete', () => {
  it('deletes the highest line first, one request per line, so renumbering cannot shift a target', async () => {
    const bodies: unknown[] = [];
    const { ctx } = await makeContext([...base(), captureBodies({ method: 'PATCH', path: htPath }, bodies)]);
    const r = await callTool(byName(tools, 'htaccess_rewrites_delete'), { website: 'vahi.dev', line_numbers: [1, 3] }, ctx);
    expect(bodies).toEqual([{ items: [{ lineNumber: 3 }] }, { items: [{ lineNumber: 1 }] }]);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain('3, 1');
    expect(r.text).toContain('renumbered from 1');
    expect(r.structured).toEqual({ removed: [3, 1] });
  });

  it('sends one request per distinct line number', async () => {
    const bodies: unknown[] = [];
    const { ctx } = await makeContext([...base(), captureBodies({ method: 'PATCH', path: htPath }, bodies)]);
    const r = await callTool(byName(tools, 'htaccess_rewrites_delete'), { website: 'vahi.dev', line_numbers: [2, 5, 2] }, ctx);
    expect(bodies).toEqual([{ items: [{ lineNumber: 5 }] }, { items: [{ lineNumber: 2 }] }]);
    expect(r.structured).toEqual({ removed: [5, 2] });
  });

  it('rejects an empty list and a line number below 1 before anything is sent', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'PATCH', path: htPath, status: 204 }]);
    await expect(callTool(byName(tools, 'htaccess_rewrites_delete'), { website: 'vahi.dev', line_numbers: [] }, ctx)).rejects.toThrow();
    await expect(callTool(byName(tools, 'htaccess_rewrites_delete'), { website: 'vahi.dev', line_numbers: [0] }, ctx)).rejects.toThrow();
    expect(f.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

describe('ip_rules_get', () => {
  it('shows the current allow/block list', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: ipsPath, body: { kind: 'block', ips: ['1.2.3.4', '2001:db8::/32'] } }]);
    const r = await callTool(byName(tools, 'ip_rules_get'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain('mode: block');
    expect(r.text).toContain('1.2.3.4, 2001:db8::/32');
    expect(r.structured).toEqual({ kind: 'block', ips: ['1.2.3.4', '2001:db8::/32'] });
  });

  it('says none when no IPs are listed', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: ipsPath, body: { kind: 'block', ips: [] } }]);
    const r = await callTool(byName(tools, 'ip_rules_get'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain('ips: none');
    expect(r.structured).toEqual({ kind: 'block', ips: [] });
  });

  it('warns in its description that LiteSpeed servers ignore the rule', async () => {
    expect(byName(tools, 'ip_rules_get').description).toContain('LiteSpeed');
  });
});

describe('ip_rules_set', () => {
  const clientIpRoute = (ip: string): Route => ({ method: 'GET', path: '/client_ip', body: ip });

  it('PUTs the whole rule, warns about the 403 and prints the undo call', async () => {
    const sink: { method?: string; path?: string; body?: unknown } = {};
    const { ctx } = await makeContext([...base(), captureBody({ method: 'PUT', path: ipsPath }, sink), clientIpRoute('203.0.113.9')]);
    const r = await callTool(byName(tools, 'ip_rules_set'), { website: 'vahi.dev', kind: 'allow', ips: ['203.0.113.9', '198.51.100.0/24'] }, ctx);
    expect(sink.method).toBe('PUT');
    expect(sink.path).toBe(ipsPath);
    expect(sink.body).toEqual({ kind: 'allow', ips: ['203.0.113.9', '198.51.100.0/24'] });
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain('allow');
    expect(r.text).toContain('203.0.113.9, 198.51.100.0/24');
    expect(r.text).toContain('403');
    expect(r.text).toContain('ip_rules_set website=vahi.dev kind=block ips=[]');
    expect(r.text).toContain('LiteSpeed');
    expect(r.text).toContain("curl -o /dev/null -w '%{http_code}'");
    // The caller's own IP is on the list, so no advisory line is added.
    expect(r.text).not.toContain('your current IP');
    expect(r.structured).toEqual({ kind: 'allow', ips: ['203.0.113.9', '198.51.100.0/24'], clientIp: '203.0.113.9', clientIpListed: true });
  });

  it('notes when the caller’s own IP is not on the allow list', async () => {
    const { ctx } = await makeContext([...base(), { method: 'PUT', path: ipsPath, status: 204 }, clientIpRoute('198.51.100.7')]);
    const r = await callTool(byName(tools, 'ip_rules_set'), { website: 'vahi.dev', kind: 'allow', ips: ['203.0.113.9'] }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('your current IP 198.51.100.7 is not in this list');
    expect(r.text).toContain('CIDR');
    expect(r.structured).toEqual({ kind: 'allow', ips: ['203.0.113.9'], clientIp: '198.51.100.7', clientIpListed: false });
  });

  it('sets the rule anyway when the client IP lookup fails', async () => {
    const { ctx } = await makeContext([...base(), { method: 'PUT', path: ipsPath, status: 204 }, { method: 'GET', path: '/client_ip', status: 500, body: { code: 'boom' } }]);
    const r = await callTool(byName(tools, 'ip_rules_set'), { website: 'vahi.dev', kind: 'allow', ips: ['203.0.113.9'] }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.text).not.toContain('your current IP');
    expect(r.structured).toEqual({ kind: 'allow', ips: ['203.0.113.9'], clientIp: null, clientIpListed: null });
  });

  it('refuses an empty allow list without sending anything', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'PUT', path: ipsPath, status: 204 }]);
    const r = await callTool(byName(tools, 'ip_rules_set'), { website: 'vahi.dev', kind: 'allow', ips: [] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(websiteLine);
    expect(r.text).toContain('kind=block');
    expect(f.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('clears the rule with an empty block list and looks up no client IP', async () => {
    const sink: { method?: string; path?: string; body?: unknown } = {};
    const { ctx, f } = await makeContext([...base(), captureBody({ method: 'PUT', path: ipsPath }, sink)]);
    const r = await callTool(byName(tools, 'ip_rules_set'), { website: 'vahi.dev', kind: 'block', ips: [] }, ctx);
    expect(sink.body).toEqual({ kind: 'block', ips: [] });
    expect(r.text).toContain('empty');
    expect(r.text).toContain('LiteSpeed');
    expect(f.calls.some((c) => c.path === '/client_ip')).toBe(false);
    expect(r.structured).toEqual({ kind: 'block', ips: [], clientIp: null, clientIpListed: null });
  });

  it('rejects an IP with whitespace in it before anything is sent', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'PUT', path: ipsPath, status: 204 }]);
    await expect(callTool(byName(tools, 'ip_rules_set'), { website: 'vahi.dev', kind: 'block', ips: ['1.2.3 .4'] }, ctx)).rejects.toThrow();
    expect(f.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
