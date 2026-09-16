import { describe, expect, it } from 'vitest';
import { compareSemverDesc, tools } from '../../src/tools/node.js';
import { base, ORG_ID, websiteDetail, WEBSITE_ID } from '../fixtures/panel.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import type { Route } from '../helpers/fakeFetch.js';

const websiteLine = `website: vahi.dev (${WEBSITE_ID})`;
const nodeBase = `/websites/${WEBSITE_ID}/apps/node`;

/** A site whose plan has no persistent apps: every tool here must refuse without a request. */
const noApps = (): Route[] => [
  { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: { items: [websiteDetail], total: 1 } },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: { ...websiteDetail, canUse: { ...websiteDetail.canUse, persistentApps: false } } },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains`, body: { items: [] } },
];

/** Captures the raw wire body: the two version endpoints take a bare JSON string. */
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

describe('the persistent-apps gate', () => {
  for (const [name, args] of [
    ['node_install', {}],
    ['node_versions_available', {}],
    ['node_versions_installed', {}],
    ['node_version_install', { version: '22.23.2' }],
    ['node_version_set_default', { version: 'stable' }],
  ] as const) {
    it(`${name} refuses when canUse.persistentApps is not true and sends nothing`, async () => {
      const { ctx, f } = await makeContext(noApps());
      const r = await callTool(byName(tools, name), { website: 'vahi.dev', ...args }, ctx);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('not enabled');
      expect(r.text).toContain(websiteLine);
      expect(f.calls.some((c) => c.path.includes('/apps/node'))).toBe(false);
    });
  }
});

describe('node_install', () => {
  it('posts to the nvm endpoint and says it takes a while', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'POST', path: nodeBase, status: 200 }]);
    const r = await callTool(byName(tools, 'node_install'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(f.calls.some((c) => c.method === 'POST' && c.path === nodeBase)).toBe(true);
    expect(r.text).toContain(websiteLine);
    expect(r.text).toMatch(/minute/);
    expect(r.structured).toMatchObject({ installed: true });
  });
});

describe('compareSemverDesc', () => {
  it('orders newest first, numerically per segment', () => {
    expect(['0.12.18', '22.23.2', '26.8.1', '4.9.1', '22.3.0'].sort(compareSemverDesc)).toEqual(['26.8.1', '22.23.2', '22.3.0', '4.9.1', '0.12.18']);
  });
});

describe('node_versions_available', () => {
  it('lists newest first, summarises by major, and keeps the full list in structuredContent', async () => {
    const all = ['0.12.18', '4.9.1', '20.19.0', '22.3.0', '22.23.2', '26.8.1'];
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `${nodeBase}/possible_versions`, body: all }]);
    const r = await callTool(byName(tools, 'node_versions_available'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ total: 6, versions: ['26.8.1', '22.23.2', '22.3.0', '20.19.0', '4.9.1', '0.12.18'] });
    expect(r.text).toContain('26.8.1');
    expect(r.text).toContain('22.23.2');
    expect(r.text).not.toContain('22.3.0'); // only the newest of each major is rendered
    expect(r.text).toMatch(/6 versions/);
  });
});

describe('node_versions_installed', () => {
  it('labels the list as the panel\'s and points at nvm ls, never claiming a version is absent', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `${nodeBase}/versions`, body: ['26.8.1'] }]);
    const r = await callTool(byName(tools, 'node_versions_installed'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ versions: ['26.8.1'], authoritative: false });
    expect(r.text).toContain('as reported by the panel');
    expect(r.text).toContain('nvm ls');
  });

  it('says so when the panel reports none', async () => {
    const { ctx } = await makeContext([...base(), { method: 'GET', path: `${nodeBase}/versions`, body: [] }]);
    const r = await callTool(byName(tools, 'node_versions_installed'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toMatch(/none reported/);
    expect(r.structured).toMatchObject({ versions: [] });
  });
});

describe('node_version_install', () => {
  it('sends the version as a bare JSON string', async () => {
    const sink: { raw?: string; path?: string } = {};
    const { ctx } = await makeContext([...base(), captureRaw({ method: 'POST', path: `${nodeBase}/versions` }, sink)]);
    const r = await callTool(byName(tools, 'node_version_install'), { website: 'vahi.dev', version: '22.23.2' }, ctx);
    expect(sink.raw).toBe('"22.23.2"');
    expect(sink.path).toBe(`${nodeBase}/versions`);
    expect(r.structured).toMatchObject({ version: '22.23.2', installed: true });
    expect(r.text).toContain('node_version_set_default');
  });

  it('rejects a non-semver version before resolving anything', async () => {
    const { ctx, f } = await makeContext([...base()]);
    // makeContext has already spent one call on the /login/memberships auth probe, so the count
    // to hold at zero is the one the tool itself adds — same idiom as tools-php.test.ts.
    const before = f.calls.length;
    await expect(callTool(byName(tools, 'node_version_install'), { website: 'vahi.dev', version: 'stable' }, ctx)).rejects.toThrow();
    expect(f.calls.length).toBe(before);
  });
});

describe('node_version_set_default', () => {
  it('puts a semver as a bare JSON string', async () => {
    const sink: { raw?: string; path?: string } = {};
    const { ctx } = await makeContext([...base(), captureRaw({ method: 'PUT', path: `${nodeBase}/versions/default` }, sink)]);
    const r = await callTool(byName(tools, 'node_version_set_default'), { website: 'vahi.dev', version: '22.23.2' }, ctx);
    expect(sink.raw).toBe('"22.23.2"');
    expect(r.structured).toMatchObject({ version: '22.23.2', default: true });
  });

  it('accepts the stable and default selectors', async () => {
    const sink: { raw?: string } = {};
    const { ctx } = await makeContext([...base(), captureRaw({ method: 'PUT', path: `${nodeBase}/versions/default` }, sink)]);
    await callTool(byName(tools, 'node_version_set_default'), { website: 'vahi.dev', version: 'stable' }, ctx);
    expect(sink.raw).toBe('"stable"');
  });

  it('rejects anything else', async () => {
    const { ctx } = await makeContext([...base()]);
    await expect(callTool(byName(tools, 'node_version_set_default'), { website: 'vahi.dev', version: 'latest' }, ctx)).rejects.toThrow();
  });
});
