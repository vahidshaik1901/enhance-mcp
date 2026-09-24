import { describe, expect, it } from 'vitest';
import { FileServiceUnavailable, listSiteFiles, MAX_LEVELS, MAX_RESPONSE_BYTES } from '../../src/core/files.js';
import type { Website } from '../../src/core/resolver.js';
import { base, fileServiceRoutes, FILERD_ADDRESS, fsDir, fsFile, fsLink, fsRoot, ORG_ID, SITE_TOKEN, websiteDetail, WEBSITE_ID } from '../fixtures/panel.js';
import { makeContext } from '../helpers/context.js';
import type { Route } from '../helpers/fakeFetch.js';

const site = websiteDetail as unknown as Website;
const entriesPath = `${FILERD_ADDRESS}/websites/${WEBSITE_ID}/entries`;
const tokenPath = `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/access-tokens`;

const twoLevels = fsRoot(
  fsFile('.bashrc', 3968),
  fsDir('public_html', [fsFile('public_html/index.html', 1234), fsDir('public_html/demo-login', []), fsLink('public_html/current')]),
  fsDir('empty'),
);

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FileServiceUnavailable) return e.reason;
    throw e;
  }
  throw new Error('expected a FileServiceUnavailable');
}

describe('listSiteFiles', () => {
  it('mints a site token, sends one GET carrying only that token, and flattens the tree', async () => {
    const seen: Request[] = [];
    const { ctx, f } = await makeContext([...fileServiceRoutes(twoLevels, seen), ...base()]);
    const listing = await listSiteFiles(ctx, site, { levels: 2 });
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe('GET');
    expect(req.redirect).toBe('error');
    expect(req.headers.get('authorization')).toBe(`Bearer ${SITE_TOKEN}`);
    expect(req.headers.get('cookie')).toBeNull();
    const url = new URL(req.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://panel.test${entriesPath}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ recursive: 'true', maxDepth: '1', fetchMetadata: 'true' });
    expect(f.calls.filter((c) => c.method === 'POST' && c.path === tokenPath)).toHaveLength(1);
    expect(listing.levels).toBe(2);
    expect(listing.entries).toEqual([
      { path: '.bashrc', kind: 'file', size: 3968, modified: 1789629449, mode: 0o644, unexpanded: false },
      { path: 'public_html', kind: 'dir', size: 4096, modified: 1789629449, mode: 0o755, unexpanded: false },
      { path: 'public_html/index.html', kind: 'file', size: 1234, modified: 1789629449, mode: 0o644, unexpanded: false },
      // `entries: []` on the last level asked for: not opened.
      { path: 'public_html/demo-login', kind: 'dir', size: 4096, modified: 1789629449, mode: 0o755, unexpanded: true },
      { path: 'public_html/current', kind: 'symlink', size: 9, modified: 1789629449, mode: 0o777, unexpanded: false },
      // No `entries` key: a folder the service knows is empty.
      { path: 'empty', kind: 'dir', size: 4096, modified: 1789629449, mode: 0o755, unexpanded: false },
    ]);
  });

  it('never puts the token in what it returns or in what it throws', async () => {
    const ok = await makeContext([...fileServiceRoutes(twoLevels), ...base()]);
    expect(JSON.stringify(await listSiteFiles(ok.ctx, site, { levels: 2 }))).not.toContain(SITE_TOKEN);
    const broken = await makeContext([{ method: 'GET', path: entriesPath, handler: async () => { throw new TypeError(`connect failed while sending ${SITE_TOKEN}`); } }, ...fileServiceRoutes(twoLevels), ...base()]);
    const e = await listSiteFiles(broken.ctx, site, { levels: 2 }).catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(FileServiceUnavailable);
    expect((e as Error).message).not.toContain(SITE_TOKEN);
    expect((e as Error).message).toContain('[redacted]');
  });

  it('refuses an address that is not a path on the panel before any token is minted', async () => {
    for (const filerdAddress of ['https://evil.example/filerd/x', '//evil.example/x', '/filerd/../x', '/filerd/x?y=1', '/filerd/x#y', '', undefined]) {
      const { ctx, f } = await makeContext([...fileServiceRoutes(twoLevels), ...base()]);
      expect(await reason(listSiteFiles(ctx, { ...site, filerdAddress } as Website, { levels: 1 })), String(filerdAddress)).toBe('unsupported');
      expect(f.calls.some((c) => c.path === tokenPath || c.path.startsWith('/filerd')), String(filerdAddress)).toBe(false);
    }
  });

  it('maps every way the service can fail to a typed reason', async () => {
    const cases: Array<[string, Route[]]> = [
      ['mint_refused', [{ method: 'POST', path: tokenPath, status: 403, body: { code: 'unauthorized' } }]],
      ['mint_refused', [{ method: 'POST', path: tokenPath, body: 'not-a-token' }]],
      ['unauthorized', fileServiceRoutes(twoLevels, [], { status: 401 })],
      ['not_found', fileServiceRoutes(twoLevels, [], { status: 404 })],
      ['http_error', fileServiceRoutes(twoLevels, [], { status: 500 })],
      ['bad_shape', fileServiceRoutes(twoLevels, [], { raw: 'not json' })],
      ['bad_shape', fileServiceRoutes({ dir: { path: '', entries: [{ socket: { path: 'x' } }] } })],
      ['network', [{ method: 'GET', path: entriesPath, handler: async () => { throw new TypeError('fetch failed'); } }, ...fileServiceRoutes(twoLevels)]],
      ['timeout', [{ method: 'GET', path: entriesPath, handler: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } }, ...fileServiceRoutes(twoLevels)]],
    ];
    for (const [want, routes] of cases) {
      const { ctx } = await makeContext([...routes, ...base()]);
      expect(await reason(listSiteFiles(ctx, site, { levels: 1 })), want).toBe(want);
    }
  });

  it('refuses a listing over the size cap, whether it says so up front or not', async () => {
    const declared = await makeContext([{ method: 'GET', path: entriesPath, handler: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES + 1) } }) }, ...fileServiceRoutes(twoLevels), ...base()]);
    expect(await reason(listSiteFiles(declared.ctx, site, { levels: 1 }))).toBe('too_large');
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const streamed = await makeContext([
      {
        method: 'GET',
        path: entriesPath,
        handler: async () => {
          let sent = 0;
          const body = new ReadableStream<Uint8Array>({ pull(c) { if (sent++ < 9) c.enqueue(chunk); else c.close(); } });
          return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
      ...fileServiceRoutes(twoLevels),
      ...base(),
    ]);
    expect(await reason(listSiteFiles(streamed.ctx, site, { levels: 1 }))).toBe('too_large');
  });

  it('asks for between 1 and MAX_LEVELS levels, whatever it is given', async () => {
    for (const [levels, maxDepth] of [[20, String(MAX_LEVELS - 1)], [0, '0'], [3.7, '2']] as const) {
      const seen: Request[] = [];
      const { ctx } = await makeContext([...fileServiceRoutes(fsRoot(), seen), ...base()]);
      await listSiteFiles(ctx, site, { levels });
      expect(new URL(seen[0]!.url).searchParams.get('maxDepth'), String(levels)).toBe(maxDepth);
    }
  });
});
