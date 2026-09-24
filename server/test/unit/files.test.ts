import { describe, expect, it } from 'vitest';
import { FileServiceUnavailable, listSiteFiles, MAX_LEVELS, MAX_RESPONSE_BYTES } from '../../src/core/files.js';
import type { Website } from '../../src/core/resolver.js';
import { base, fileServiceRoutes, FILERD_ADDRESS, fsDir, fsFile, fsLink, fsRoot, ORG_ID, SITE_TOKEN, twoMemberships, websiteDetail, WEBSITE_ID } from '../fixtures/panel.js';
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

async function failure(p: Promise<unknown>): Promise<FileServiceUnavailable> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FileServiceUnavailable) return e;
    throw e;
  }
  throw new Error('expected a FileServiceUnavailable');
}

async function reason(p: Promise<unknown>): Promise<string> {
  return (await failure(p)).reason;
}

describe('listSiteFiles', () => {
  it('mints a site token, sends one GET carrying only that token, and flattens the tree', async () => {
    const seen: Request[] = [];
    const { ctx, f, auditLines } = await makeContext([...fileServiceRoutes(twoLevels, seen), ...base()]);
    const listing = await listSiteFiles(ctx, site, { levels: 2 });
    // Rule 1 (GET only) is asserted on every call the fake received, not on `seen`: `seen` counts only
    // requests that matched the GET route, so a token-carrying POST to the service would slip past it.
    expect(f.calls[0]?.path).toBe('/login/memberships');
    expect(f.calls.slice(1).map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual([`POST ${tokenPath}`, `GET ${entriesPath}`]);
    expect(f.calls.filter((c) => c.path.startsWith(FILERD_ADDRESS)).map((c) => c.method)).toEqual(['GET']);
    // Rule 2: never audited.
    expect(auditLines.join('\n')).not.toContain(SITE_TOKEN);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe('GET');
    expect(req.redirect).toBe('error');
    expect(req.headers.get('authorization')).toBe(`Bearer ${SITE_TOKEN}`);
    expect(req.headers.get('cookie')).toBeNull();
    const url = new URL(req.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://panel.test${entriesPath}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ recursive: 'true', maxDepth: '1', fetchMetadata: 'true' });
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
    // '/filerd//x' passes the character class and is refused only by the `//` rule.
    for (const filerdAddress of ['https://evil.example/filerd/x', '//evil.example/x', '/filerd//x', '/filerd/../x', '/filerd/x?y=1', '/filerd/x#y', '', undefined]) {
      const { ctx, f } = await makeContext([...fileServiceRoutes(twoLevels), ...base()]);
      expect(await reason(listSiteFiles(ctx, { ...site, filerdAddress } as Website, { levels: 1 })), String(filerdAddress)).toBe('unsupported');
      expect(f.calls.some((c) => c.path === tokenPath || c.path.startsWith('/filerd')), String(filerdAddress)).toBe(false);
    }
  });

  it('refuses a website id that is not a UUID before any token is minted', async () => {
    const { ctx, f } = await makeContext([...fileServiceRoutes(twoLevels), ...base()]);
    expect(await reason(listSiteFiles(ctx, { ...site, id: '../6106382b' } as Website, { levels: 1 }))).toBe('unsupported');
    expect(f.calls.some((c) => c.method === 'POST' || c.path.startsWith('/filerd'))).toBe(false);
  });

  it('reports a credential with no org selected as a typed refusal, before anything is minted', async () => {
    const { ctx, f } = await makeContext([...fileServiceRoutes(twoLevels), ...base()], {}, twoMemberships);
    const e = await failure(listSiteFiles(ctx, site, { levels: 1 }));
    expect(e.reason).toBe('mint_refused');
    expect(e.message).toContain('ENHANCE_ORG_ID');
    expect(f.calls.some((c) => c.method === 'POST' || c.path.startsWith('/filerd'))).toBe(false);
  });

  it('maps every way the service can fail to a typed reason', async () => {
    const cases: Array<[string, Route[]]> = [
      ['mint_refused', [{ method: 'POST', path: tokenPath, status: 403, body: { code: 'unauthorized' } }]],
      ['mint_refused', [{ method: 'POST', path: tokenPath, body: 'not-a-token' }]],
      ['unauthorized', fileServiceRoutes(twoLevels, [], { status: 401 })],
      ['unauthorized', fileServiceRoutes(twoLevels, [], { status: 403 })],
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

  it('says a token request that failed on the way or on the panel could not be asked, not that it was refused', async () => {
    // Only a 4xx is the panel saying no. A 5xx or a reset says nothing about the token, and calling
    // it "refused" sends the reader looking for a permission problem that is not there.
    for (const [label, route] of [
      ['a 502', { method: 'POST', path: tokenPath, status: 502, body: { code: 'bad_gateway', message: 'upstream down' } }],
      ['a reset', { method: 'POST', path: tokenPath, handler: async () => { throw new TypeError('fetch failed'); } }],
    ] as Array<[string, Route]>) {
      const { ctx, f } = await makeContext([route, ...base()]);
      const e = await failure(listSiteFiles(ctx, site, { levels: 1 }));
      expect(e.reason, label).toBe('network');
      expect(e.message, label).toContain('the panel could not be asked for a site token (');
      expect(e.message, label).not.toContain('refused');
      expect(f.calls.some((c) => c.path.startsWith('/filerd')), label).toBe(false);
    }
    const refused = await makeContext([{ method: 'POST', path: tokenPath, status: 403, body: { code: 'unauthorized', message: 'no' } }, ...base()]);
    const e = await failure(listSiteFiles(refused.ctx, site, { levels: 1 }));
    expect(e.reason).toBe('mint_refused');
    expect(e.message).toContain('the panel refused a site access token (HTTP 403');
  });

  it('says a token request that got no answer timed out, not that the panel refused it', async () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      const { ctx, f } = await makeContext([{ method: 'POST', path: tokenPath, handler: async () => { throw new DOMException('The operation was aborted', name); } }, ...base()]);
      const e = await failure(listSiteFiles(ctx, site, { levels: 1 }));
      expect(e.reason, name).toBe('timeout');
      expect(e.message, name).toContain('token request');
      expect(f.calls.some((c) => c.path.startsWith('/filerd')), name).toBe(false);
    }
  });

  it('names the cause of a network failure, with the token scrubbed from it', async () => {
    // undici reports a refused redirect (redirect: 'error') as TypeError('fetch failed') and puts the
    // reason in `cause`, so the message alone says nothing useful.
    const { ctx } = await makeContext([{ method: 'GET', path: entriesPath, handler: async () => { throw new TypeError('fetch failed', { cause: new Error(`unexpected redirect\nwhile sending ${SITE_TOKEN}`) }); } }, ...fileServiceRoutes(twoLevels), ...base()]);
    const e = await failure(listSiteFiles(ctx, site, { levels: 1 }));
    expect(e.reason).toBe('network');
    expect(e.message).toContain('fetch failed: unexpected redirect while sending [redacted]');
    expect(e.message).not.toContain(SITE_TOKEN);
  });

  it('refuses a tree deeper than the levels asked for, so a service that ignores maxDepth is not trusted', async () => {
    const threeDeep = fsRoot(fsDir('a', [fsDir('a/b', [fsFile('a/b/c')])]));
    const shallow = await makeContext([...fileServiceRoutes(threeDeep), ...base()]);
    expect(await reason(listSiteFiles(shallow.ctx, site, { levels: 2 }))).toBe('bad_shape');
    const deep = await makeContext([...fileServiceRoutes(threeDeep), ...base()]);
    expect((await listSiteFiles(deep.ctx, site, { levels: 3 })).entries.map((e) => e.path)).toEqual(['a', 'a/b', 'a/b/c']);
  });

  it('marks only a folder on the last level as unexpanded', async () => {
    // Live, `entries: []` sat only on the last level; one above it is not "not opened".
    const tree = fsRoot(fsDir('odd', []), fsDir('a', [fsDir('a/b', [])]));
    const { ctx } = await makeContext([...fileServiceRoutes(tree), ...base()]);
    const { entries } = await listSiteFiles(ctx, site, { levels: 2 });
    expect(entries.map((e) => [e.path, e.unexpanded])).toEqual([['odd', false], ['a', false], ['a/b', true]]);
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
