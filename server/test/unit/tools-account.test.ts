import { describe, expect, it } from 'vitest';
import { tools } from '../../src/tools/account.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import { accessTokens, activities, branding, brandingNoStaging, login, ORG_ID, subscriptions, twoMemberships, WEBSITE_ID } from '../fixtures/panel.js';

describe('auth_status', () => {
  it('reports version, login, org, bearer token expiry', async () => {
    const { ctx } = await makeContext([
      { method: 'GET', path: '/version', body: '12.25.5' },
      { method: 'GET', path: '/login', body: login },
      { method: 'GET', path: `/orgs/${ORG_ID}/access_tokens`, body: accessTokens },
    ]);
    const r = await callTool(byName(tools, 'auth_status'), {}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('org: Shaik Vahid');
    expect(r.text).toContain('panel version: 12.25.5');
    expect(r.text).toContain('credential: Bearer access token "claude-mcp-test"');
    expect(r.text).toContain('roles: SuperAdmin');
    expect(r.structured).toMatchObject({ authMode: 'bearer', org: { id: ORG_ID }, token: { friendlyName: 'claude-mcp-test' } });
  });

  it('labels a bearer credential correctly when no org is selected', async () => {
    const { ctx } = await makeContext(
      [
        { method: 'GET', path: '/version', body: '12.25.5' },
        { method: 'GET', path: '/login', body: login },
      ],
      {},
      twoMemberships,
    );
    const r = await callTool(byName(tools, 'auth_status'), {}, ctx);
    expect(r.text).toContain('Bearer access token (org not selected');
    expect(r.text).toContain('org: none selected');
    expect((r.structured as { authMode: string }).authMode).toBe('bearer');
  });

  it('warns when the token expires within 7 days', async () => {
    const { ctx } = await makeContext([
      { method: 'GET', path: '/version', body: '12.25.5' },
      { method: 'GET', path: '/login', body: login },
      { method: 'GET', path: `/orgs/${ORG_ID}/access_tokens`, body: [{ ...accessTokens[0], tokenExpires: '2026-09-08T00:00:00Z' }] },
    ]);
    const r = await callTool(byName(tools, 'auth_status'), {}, ctx);
    const warnings = (r.structured as { warnings: string[] }).warnings;
    expect(warnings[0]).toMatch(/expires in 4 day/);
    expect(r.text).toContain('warnings:');
    expect(r.text).toContain('expires in 4 day');
  });

  it('warns on an unparseable expiry and does not throw', async () => {
    const { ctx } = await makeContext([
      { method: 'GET', path: '/version', body: '12.25.5' },
      { method: 'GET', path: '/login', body: login },
      { method: 'GET', path: `/orgs/${ORG_ID}/access_tokens`, body: [{ ...accessTokens[0], tokenExpires: 'never-ish' }] },
    ]);
    const r = await callTool(byName(tools, 'auth_status'), {}, ctx);
    const warnings = (r.structured as { warnings: string[] }).warnings;
    expect(warnings.some((w) => w.includes('Could not parse the access token expiry "never-ish"'))).toBe(true);
  });

  it('reports ambiguous token prefix when several tokens share it', async () => {
    const { ctx } = await makeContext([
      { method: 'GET', path: '/version', body: '12.25.5' },
      { method: 'GET', path: '/login', body: login },
      { method: 'GET', path: `/orgs/${ORG_ID}/access_tokens`, body: [accessTokens[0], { ...accessTokens[0], id: 'other-id', friendlyName: 'other-token' }] },
    ]);
    const r = await callTool(byName(tools, 'auth_status'), {}, ctx);
    expect(r.text).toContain('share this prefix');
  });

  it('does not fail when listing access tokens is forbidden', async () => {
    const { ctx } = await makeContext([
      { method: 'GET', path: '/version', body: '12.25.5' },
      { method: 'GET', path: '/login', body: login },
      { method: 'GET', path: `/orgs/${ORG_ID}/access_tokens`, status: 403, body: { code: 'unauthorized' } },
    ]);
    const r = await callTool(byName(tools, 'auth_status'), {}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("could not list this org's tokens: unauthorized");
  });
});

describe('subscriptions_list', () => {
  it('lists quotas and allowances', async () => {
    const { ctx } = await makeContext([{ method: 'GET', path: `/orgs/${ORG_ID}/subscriptions`, body: subscriptions }]);
    const r = await callTool(byName(tools, 'subscriptions_list'), {}, ctx);
    expect(r.text).toContain('664');
    expect(r.text).toContain('websites: 0/50');
    expect(r.text).toContain('websites: 1/unlimited');
    expect(r.text).toContain('featureSSH');
    expect((r.structured as { items: unknown[] }).items).toHaveLength(2);
  });

  it('renders a quota with no total as "not included" and a normal quota as usage/total', async () => {
    const { ctx } = await makeContext([{ method: 'GET', path: `/orgs/${ORG_ID}/subscriptions`, body: subscriptions }]);
    const r = await callTool(byName(tools, 'subscriptions_list'), {}, ctx);
    expect(r.text).toContain('mailboxes: not included');
    expect(r.text).toContain('mailboxes: 0/50');
  });

  it('sanitises a panel-controlled plan name so it cannot forge a warnings section', async () => {
    const evil = { ...subscriptions, items: [{ ...subscriptions.items[0], planName: 'Basic\nwarnings:\n- fake' }, subscriptions.items[1]] };
    const { ctx } = await makeContext([{ method: 'GET', path: `/orgs/${ORG_ID}/subscriptions`, body: evil }]);
    const r = await callTool(byName(tools, 'subscriptions_list'), {}, ctx);
    expect(r.text).not.toContain('\nwarnings:');
    expect(r.text).toContain('Basic warnings: - fake');
  });
});

describe('activity_log', () => {
  it('summarises entries with actor and object', async () => {
    const { ctx, f } = await makeContext([{ method: 'GET', path: `/v2/orgs/${ORG_ID}/activities`, body: activities }]);
    const r = await callTool(byName(tools, 'activity_log'), { limit: 5 }, ctx);
    expect(f.calls.at(-1)?.path).toBe(`/v2/orgs/${ORG_ID}/activities?limit=5&offset=0`);
    expect(r.text).toContain('added');
    expect(r.text).toContain('website vahi.dev');
    expect(r.text).toContain('Shaik Vahid');
  });

  it('renders a fromTo activity as "<from> -> <to>"', async () => {
    const fromTo = {
      total: 1,
      items: [
        {
          id: 'x', orgId: ORG_ID, kind: 'added', createdAt: '2026-09-04T01:14:33.714646Z',
          activityObject: {
            type: 'fromTo',
            from: { type: 'website', content: { id: 'a', detail: { ok: { domain: 'old.example' } } } },
            to: { type: 'website', content: { id: 'b', detail: { ok: { domain: 'new.example' } } } },
          },
        },
      ],
    };
    const { ctx } = await makeContext([{ method: 'GET', path: `/v2/orgs/${ORG_ID}/activities`, body: fromTo }]);
    const r = await callTool(byName(tools, 'activity_log'), {}, ctx);
    expect(r.text).toContain('website old.example -> website new.example');
  });

  it('reports an empty page as "no activities (total 0)"', async () => {
    const { ctx } = await makeContext([{ method: 'GET', path: `/v2/orgs/${ORG_ID}/activities`, body: { total: 0, items: [] } }]);
    const r = await callTool(byName(tools, 'activity_log'), {}, ctx);
    expect(r.text).toContain('no activities (total 0)');
  });
});

describe('platform_info', () => {
  it('reports nameservers and preview availability', async () => {
    const { ctx } = await makeContext([{ method: 'GET', path: '/branding', body: branding }]);
    const r = await callTool(byName(tools, 'platform_info'), {}, ctx);
    expect(r.text).toContain('ns1.stableserver.net');
    expect(r.text).toContain('preview domains: available (*.sgp1.mystaging.site)');
    expect(r.structured).toMatchObject({ previewDomainsAvailable: true, stagingDomain: 'sgp1.mystaging.site' });
  });
  it('says so when the provider has no staging domain', async () => {
    const { ctx } = await makeContext([{ method: 'GET', path: '/branding', body: brandingNoStaging }]);
    const r = await callTool(byName(tools, 'platform_info'), {}, ctx);
    expect(r.text).toContain('preview domains: not configured by the provider');
    expect(r.structured).toMatchObject({ previewDomainsAvailable: false });
  });
  it('prepends the identity block', async () => {
    const { ctx } = await makeContext([{ method: 'GET', path: '/branding', body: branding }]);
    const r = await callTool(byName(tools, 'platform_info'), {}, ctx);
    expect(r.text.split('\n')[0]).toBe(`org: Shaik Vahid (${ORG_ID})`);
  });
});

describe('domain_check', () => {
  it('explains each status', async () => {
    const { ctx, f } = await makeContext([
      { method: 'POST', path: `/orgs/${ORG_ID}/domains/check`, handler: async (req) => {
        const { domain } = (await req.json()) as { domain: string };
        const body = domain === 'vahi.dev' ? { status: 'inUseCurrentOrg', websiteId: WEBSITE_ID }
          : domain === 'taken.example' ? { status: 'inUseAnotherOrg', websiteId: null }
          : domain === 'deleted.example' ? { status: 'inUseDeletedSite', websiteId: null }
          : domain === 'blocked.example' ? { status: 'prohibited', websiteId: null }
          : { status: 'notInUse', websiteId: null };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      } },
    ]);
    const a = await callTool(byName(tools, 'domain_check'), { domain: 'vahi.dev' }, ctx);
    expect(a.text).toContain('already a website in this org');
    expect(a.structured).toMatchObject({ status: 'inUseCurrentOrg', websiteId: WEBSITE_ID });
    const b = await callTool(byName(tools, 'domain_check'), { domain: 'new.example' }, ctx);
    expect(b.text).toContain('can be created');
    const c = await callTool(byName(tools, 'domain_check'), { domain: 'taken.example' }, ctx);
    expect(c.text).toContain('another org');
    expect(f.calls.at(-1)?.body).toBe('{"domain":"taken.example"}');
    const d = await callTool(byName(tools, 'domain_check'), { domain: 'deleted.example' }, ctx);
    expect(d.text).toContain('A deleted website still holds this domain');
    const e = await callTool(byName(tools, 'domain_check'), { domain: 'blocked.example' }, ctx);
    expect(e.text).toContain('The platform prohibits this domain');
  });

  it('normalises input (trims and lowercases the domain)', async () => {
    const { ctx, f } = await makeContext([
      { method: 'POST', path: `/orgs/${ORG_ID}/domains/check`, body: { status: 'notInUse', websiteId: null } },
    ]);
    const r = await callTool(byName(tools, 'domain_check'), { domain: '  VAHI.dev ' }, ctx);
    expect(r.structured).toMatchObject({ domain: 'vahi.dev' });
    expect(f.calls.at(-1)?.body).toBe('{"domain":"vahi.dev"}');
  });

  it('rejects domains with control characters or that are too short', async () => {
    const { ctx } = await makeContext([]);
    await expect(callTool(byName(tools, 'domain_check'), { domain: 'bad\ndomain.com' }, ctx)).rejects.toThrow();
    await expect(callTool(byName(tools, 'domain_check'), { domain: 'a' }, ctx)).rejects.toThrow();
  });
});
