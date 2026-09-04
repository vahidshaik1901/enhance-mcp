import { describe, expect, it } from 'vitest';
import { tools } from '../../src/tools/account.js';
import { byName, makeContext } from '../helpers/context.js';
import { accessTokens, activities, branding, brandingNoStaging, login, ORG_ID, subscriptions, WEBSITE_ID } from '../fixtures/panel.js';

describe('auth_status', () => {
  it('reports version, login, org, bearer token expiry', async () => {
    const { ctx } = await makeContext([
      { method: 'GET', path: '/version', body: '12.25.5' },
      { method: 'GET', path: '/login', body: login },
      { method: 'GET', path: `/orgs/${ORG_ID}/access_tokens`, body: accessTokens },
    ]);
    const r = await byName(tools, 'auth_status').handler({}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('org: Shaik Vahid');
    expect(r.text).toContain('panel version: 12.25.5');
    expect(r.text).toContain('credential: Bearer access token "claude-mcp-test"');
    expect(r.text).toContain('roles: SuperAdmin');
    expect(r.structured).toMatchObject({ authMode: 'bearer', org: { id: ORG_ID }, token: { friendlyName: 'claude-mcp-test' } });
  });
});

describe('subscriptions_list', () => {
  it('lists quotas and allowances', async () => {
    const { ctx } = await makeContext([{ method: 'GET', path: `/orgs/${ORG_ID}/subscriptions`, body: subscriptions }]);
    const r = await byName(tools, 'subscriptions_list').handler({}, ctx);
    expect(r.text).toContain('664');
    expect(r.text).toContain('websites: 0/50');
    expect(r.text).toContain('websites: 1/unlimited');
    expect(r.text).toContain('featureSSH');
    expect((r.structured as { items: unknown[] }).items).toHaveLength(2);
  });
});

describe('activity_log', () => {
  it('summarises entries with actor and object', async () => {
    const { ctx, f } = await makeContext([{ method: 'GET', path: `/v2/orgs/${ORG_ID}/activities`, body: activities }]);
    const r = await byName(tools, 'activity_log').handler({ limit: 5 }, ctx);
    expect(f.calls.at(-1)?.path).toBe(`/v2/orgs/${ORG_ID}/activities?limit=5&offset=0`);
    expect(r.text).toContain('added');
    expect(r.text).toContain('website vahi.dev');
    expect(r.text).toContain('Shaik Vahid');
  });
});

describe('platform_info', () => {
  it('reports nameservers and preview availability', async () => {
    const { ctx } = await makeContext([{ method: 'GET', path: '/branding', body: branding }]);
    const r = await byName(tools, 'platform_info').handler({}, ctx);
    expect(r.text).toContain('ns1.stableserver.net');
    expect(r.text).toContain('preview domains: available (*.sgp1.mystaging.site)');
    expect(r.structured).toMatchObject({ previewDomainsAvailable: true, stagingDomain: 'sgp1.mystaging.site' });
  });
  it('says so when the provider has no staging domain', async () => {
    const { ctx } = await makeContext([{ method: 'GET', path: '/branding', body: brandingNoStaging }]);
    const r = await byName(tools, 'platform_info').handler({}, ctx);
    expect(r.text).toContain('preview domains: not configured by the provider');
    expect(r.structured).toMatchObject({ previewDomainsAvailable: false });
  });
});

describe('domain_check', () => {
  it('explains each status', async () => {
    const { ctx, f } = await makeContext([
      { method: 'POST', path: `/orgs/${ORG_ID}/domains/check`, handler: async (req) => {
        const { domain } = (await req.json()) as { domain: string };
        const body = domain === 'vahi.dev' ? { status: 'inUseCurrentOrg', websiteId: WEBSITE_ID } : domain === 'taken.example' ? { status: 'inUseAnotherOrg', websiteId: null } : { status: 'notInUse', websiteId: null };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      } },
    ]);
    const a = await byName(tools, 'domain_check').handler({ domain: 'vahi.dev' }, ctx);
    expect(a.text).toContain('already a website in this org');
    expect(a.structured).toMatchObject({ status: 'inUseCurrentOrg', websiteId: WEBSITE_ID });
    const b = await byName(tools, 'domain_check').handler({ domain: 'new.example' }, ctx);
    expect(b.text).toContain('can be created');
    const c = await byName(tools, 'domain_check').handler({ domain: 'taken.example' }, ctx);
    expect(c.text).toContain('another org');
    expect(f.calls.at(-1)?.body).toBe('{"domain":"taken.example"}');
  });
});
