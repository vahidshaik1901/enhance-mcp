import { describe, expect, it } from 'vitest';
import { createEnhanceClient } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { closest, ResolveError, Resolver } from '../../src/core/resolver.js';
import { authGuard, fakeFetch } from '../helpers/fakeFetch.js';
import { domainMappings, memberships, ORG_ID, PANEL_URL, TOKEN, WEBSITE_ID, websiteDetail, websitesList } from '../fixtures/panel.js';

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
  });
  it('expires the list cache after ttl', async () => {
    let t = 0;
    const { f, resolver } = await setup(() => t);
    await resolver.resolveWebsite('vahi.dev');
    t = 61_000;
    await resolver.resolveWebsite('vahi.dev');
    expect(f.calls.filter((c) => c.path.startsWith(`/orgs/${ORG_ID}/websites?`))).toHaveLength(2);
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
