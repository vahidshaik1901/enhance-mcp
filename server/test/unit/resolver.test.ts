import { describe, expect, it } from 'vitest';
import { createEnhanceClient } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { closest, ResolveError, Resolver } from '../../src/core/resolver.js';
import { authGuard, fakeFetch } from '../helpers/fakeFetch.js';
import { domainMappings, memberships, ORG_ID, PANEL_URL, TOKEN, WEBSITE_ID, websiteDetail, websitesList, websiteSummary } from '../fixtures/panel.js';

async function setup(now = () => 0) {
  const f = fakeFetch([
    authGuard({ bearer: TOKEN }, { method: 'GET', path: '/login/memberships', body: memberships }),
    { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: websitesList },
    { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: websiteDetail },
    { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains`, body: domainMappings },
  ]);
  const client = await createEnhanceClient(loadConfig({ env: { ENHANCE_PANEL_URL: PANEL_URL, ENHANCE_TOKEN: TOKEN }, home: '/tmp' }), { fetch: f, sleep: async () => undefined });
  return { f, resolver: new Resolver(client, now) };
}

describe('Resolver.resolveWebsite', () => {
  it('resolves by uuid with one detail call', async () => {
    const { f, resolver } = await setup();
    const w = await resolver.resolveWebsite(WEBSITE_ID.toUpperCase());
    expect(w.unixUser).toBe('vahi_dev1');
    expect(f.calls.filter((c) => c.path.startsWith(`/orgs/${ORG_ID}/websites`))).toHaveLength(1);
  });
  it('resolves by primary domain and by alias, case-insensitively, then fetches detail', async () => {
    const { f, resolver } = await setup();
    expect((await resolver.resolveWebsite('VAHI.dev')).id).toBe(WEBSITE_ID);
    expect((await resolver.resolveWebsite('vahi-dev-ccyq.sgp1.mystaging.site')).id).toBe(WEBSITE_ID);
    const listCalls = f.calls.filter((c) => c.path.startsWith(`/orgs/${ORG_ID}/websites?`));
    expect(listCalls).toHaveLength(1); // cached
    expect(listCalls[0]?.path).toContain('showAliases=true');
  });
  it('throws ResolveError with suggestions on a miss', async () => {
    const { resolver } = await setup();
    const err = await resolver.resolveWebsite('vahi.de').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect((err as ResolveError).suggestions[0]).toBe('vahi.dev');
    expect((err as ResolveError).message).toBe('No website named "vahi.de" in org Shaik Vahid. Closest matches: vahi.dev, vahi-dev-ccyq.sgp1.mystaging.site');
  });
  it('expires the list cache after ttl', async () => {
    let t = 0;
    const { f, resolver } = await setup(() => t);
    await resolver.resolveWebsite('vahi.dev');
    t = 61_000;
    await resolver.resolveWebsite('vahi.dev');
    expect(f.calls.filter((c) => c.path.startsWith(`/orgs/${ORG_ID}/websites?`))).toHaveLength(2);
  });
  it('invalidate() forces a fresh list fetch', async () => {
    const { f, resolver } = await setup();
    await resolver.resolveWebsite('vahi.dev');
    resolver.invalidate();
    await resolver.resolveWebsite('vahi.dev');
    const listCalls = f.calls.filter((c) => c.path.startsWith(`/orgs/${ORG_ID}/websites?`));
    expect(listCalls).toHaveLength(2);
  });
  it('pages through the website list by 100 and stops at total', async () => {
    const f = fakeFetch([
      authGuard({ bearer: TOKEN }, { method: 'GET', path: '/login/memberships', body: memberships }),
      {
        method: 'GET',
        path: `/orgs/${ORG_ID}/websites`,
        handler: (req, url) => {
          const offset = url.searchParams.get('offset');
          const limit = url.searchParams.get('limit');
          expect(limit).toBe('100');
          if (offset === '0') {
            const items = Array.from({ length: 100 }, (_, i) => ({
              ...websiteSummary,
              id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
              domain: { ...websiteSummary.domain, domain: `site${i}.example` },
              aliases: [],
            }));
            return new Response(JSON.stringify({ items, total: 150 }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          if (offset === '100') {
            const items = Array.from({ length: 50 }, (_, i) => ({
              ...websiteSummary,
              id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`,
              domain: { ...websiteSummary.domain, domain: `site${100 + i}.example` },
              aliases: [],
            }));
            return new Response(JSON.stringify({ items, total: 150 }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return new Response(JSON.stringify({ code: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
        },
      },
    ]);
    const client = await createEnhanceClient(loadConfig({ env: { ENHANCE_PANEL_URL: PANEL_URL, ENHANCE_TOKEN: TOKEN }, home: '/tmp' }), { fetch: f, sleep: async () => undefined });
    const resolver = new Resolver(client);
    const items = await resolver.listWebsites();
    expect(items).toHaveLength(150);
    const listCalls = f.calls.filter((c) => c.path.startsWith(`/orgs/${ORG_ID}/websites?`));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]?.path).toContain('offset=0');
    expect(listCalls[1]?.path).toContain('offset=100');
    expect(listCalls[0]?.path).toContain('limit=100');
    expect(listCalls[1]?.path).toContain('limit=100');
  });
  it('keeps paging when the panel returns fewer than 100 per page', async () => {
    const f = fakeFetch([
      authGuard({ bearer: TOKEN }, { method: 'GET', path: '/login/memberships', body: memberships }),
      {
        method: 'GET',
        path: `/orgs/${ORG_ID}/websites`,
        handler: (req, url) => {
          const offset = url.searchParams.get('offset');
          const limit = url.searchParams.get('limit');
          expect(limit).toBe('100');
          if (offset === '0') {
            const items = Array.from({ length: 30 }, (_, i) => ({
              ...websiteSummary,
              id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
              domain: { ...websiteSummary.domain, domain: `site${i}.example` },
              aliases: [],
            }));
            return new Response(JSON.stringify({ items, total: 75 }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          if (offset === '30') {
            const items = Array.from({ length: 30 }, (_, i) => ({
              ...websiteSummary,
              id: `00000000-0000-4000-8000-${String(30 + i).padStart(12, '0')}`,
              domain: { ...websiteSummary.domain, domain: `site${30 + i}.example` },
              aliases: [],
            }));
            return new Response(JSON.stringify({ items, total: 75 }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          if (offset === '60') {
            const items = Array.from({ length: 15 }, (_, i) => ({
              ...websiteSummary,
              id: `00000000-0000-4000-8000-${String(60 + i).padStart(12, '0')}`,
              domain: { ...websiteSummary.domain, domain: `site${60 + i}.example` },
              aliases: [],
            }));
            return new Response(JSON.stringify({ items, total: 75 }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return new Response(JSON.stringify({ code: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
        },
      },
    ]);
    const client = await createEnhanceClient(loadConfig({ env: { ENHANCE_PANEL_URL: PANEL_URL, ENHANCE_TOKEN: TOKEN }, home: '/tmp' }), { fetch: f, sleep: async () => undefined });
    const resolver = new Resolver(client);
    const items = await resolver.listWebsites();
    expect(items).toHaveLength(75);
    const listCalls = f.calls.filter((c) => c.path.startsWith(`/orgs/${ORG_ID}/websites?`));
    expect(listCalls).toHaveLength(3);
    expect(listCalls[0]?.path).toContain('offset=0');
    expect(listCalls[1]?.path).toContain('offset=30');
    expect(listCalls[2]?.path).toContain('offset=60');
  });
});

describe('Resolver.resolveDomain', () => {
  it('defaults to the primary mapping and matches by name or id', async () => {
    const { resolver } = await setup();
    const site = await resolver.resolveWebsite('vahi.dev');
    expect((await resolver.resolveDomain(site)).mappingKind).toBe('primary');
    expect((await resolver.resolveDomain(site, 'VAHI-DEV-CCYQ.sgp1.mystaging.site')).mappingKind).toBe('preview');
    expect((await resolver.resolveDomain(site, domainMappings.items[1]!.domainId)).mappingKind).toBe('preview');
    await expect(resolver.resolveDomain(site, 'nope.example')).rejects.toBeInstanceOf(ResolveError);
  });
});

describe('closest', () => {
  it('ranks by edit distance', () => {
    expect(closest('vahi.de', ['example.com', 'vahi.dev', 'vahi-dev-ccyq.sgp1.mystaging.site'], 2)).toEqual(['vahi.dev', 'example.com']);
  });
});
