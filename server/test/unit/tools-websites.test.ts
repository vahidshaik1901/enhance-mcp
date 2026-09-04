import { describe, expect, it } from 'vitest';
import { tools } from '../../src/tools/websites.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import { branding, brandingNoStaging, domainMappings, ORG_ID, subscriptions, WEBSITE_ID, websiteDetail, websitesList } from '../fixtures/panel.js';

const base = () => [
  { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: websitesList },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: websiteDetail },
  { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/domains`, body: domainMappings },
];

describe('websites_list', () => {
  it('tabulates websites with aliases', async () => {
    const { ctx, f } = await makeContext(base());
    const r = await callTool(byName(tools, 'websites_list'), { limit: 50, offset: 0 }, ctx);
    expect(r.text).toContain('vahi.dev');
    expect(r.text).toContain('php84');
    expect(f.calls.at(-1)?.path).toContain('showAliases=true');
    expect((r.structured as { total: number }).total).toBe(1);
  });
});

describe('website_get', () => {
  it('shows identity, connection facts and capabilities', async () => {
    const { ctx } = await makeContext(base());
    const r = await callTool(byName(tools, 'website_get'), { website: 'vahi.dev' }, ctx);
    expect(r.text).toContain(`website: vahi.dev (${WEBSITE_ID})`);
    expect(r.text).toContain('unix user: vahi_dev1');
    expect(r.text).toContain(`home: /var/www/${WEBSITE_ID}`);
    expect(r.text).toContain('preview domain: vahi-dev-ccyq.sgp1.mystaging.site');
    expect(r.text).toContain('can use: fileManager, ftp, redis, backup, persistentApps');
    expect(r.text).toContain('cannot use: modSec, roundcubeSso, postgresql');
  });
  it('returns an error with suggestions for an unknown site', async () => {
    const { ctx } = await makeContext(base());
    await expect(callTool(byName(tools, 'website_get'), { website: 'vahi.de' }, ctx)).rejects.toThrow(/Closest matches: vahi.dev/);
  });
});

describe('website_create', () => {
  it('checks the domain, picks the only subscription with quota, creates, and returns next steps', async () => {
    const created = { ...websiteDetail, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', domain: { ...websiteDetail.domain, domain: 'new.example' }, aliases: [] };
    const { ctx, f } = await makeContext([
      ...base(),
      { method: 'POST', path: `/orgs/${ORG_ID}/domains/check`, body: { status: 'notInUse', websiteId: null } },
      { method: 'GET', path: `/orgs/${ORG_ID}/subscriptions`, body: { ...subscriptions, items: [subscriptions.items[0]] } },
      { method: 'POST', path: `/orgs/${ORG_ID}/websites`, status: 201, body: { id: created.id } },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${created.id}`, body: created },
    ]);
    const r = await callTool(byName(tools, 'website_create'), { domain: 'New.Example' }, ctx);
    expect(f.calls.find((c) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/websites`)?.body).toBe('{"domain":"new.example","subscriptionId":664}');
    expect(r.text).toContain('website: new.example');
    expect(r.text).toContain('next steps');
  });
  it('refuses when the domain is in use and when several subscriptions qualify', async () => {
    const { ctx } = await makeContext([
      ...base(),
      { method: 'POST', path: `/orgs/${ORG_ID}/domains/check`, body: { status: 'inUseCurrentOrg', websiteId: WEBSITE_ID } },
      { method: 'GET', path: `/orgs/${ORG_ID}/subscriptions`, body: subscriptions },
    ]);
    const a = await callTool(byName(tools, 'website_create'), { domain: 'vahi.dev' }, ctx);
    expect(a.isError).toBe(true);
    expect(a.text).toContain('already');
    const { ctx: ctx2 } = await makeContext([
      ...base(),
      { method: 'POST', path: `/orgs/${ORG_ID}/domains/check`, body: { status: 'notInUse', websiteId: null } },
      { method: 'GET', path: `/orgs/${ORG_ID}/subscriptions`, body: subscriptions },
    ]);
    const b = await callTool(byName(tools, 'website_create'), { domain: 'new.example' }, ctx2);
    expect(b.isError).toBe(true);
    expect(b.text).toContain('subscription_id');
    expect(b.text).toContain('664');
    expect(b.text).toContain('686');
  });
});

describe('website_set_php_version / website_restart_php', () => {
  it('patches and restarts', async () => {
    const { ctx, f } = await makeContext([
      ...base(),
      { method: 'PATCH', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, status: 204 },
      { method: 'POST', path: `/v2/websites/${WEBSITE_ID}/restart_php`, status: 200, body: null },
    ]);
    const a = await callTool(byName(tools, 'website_set_php_version'), { website: 'vahi.dev', php_version: 'php83' }, ctx);
    expect(f.calls.find((c) => c.method === 'PATCH')?.body).toBe('{"phpVersion":"php83"}');
    expect(a.text).toContain('php83');
    const b = await callTool(byName(tools, 'website_restart_php'), { website: 'vahi.dev' }, ctx);
    expect(b.text).toContain('restarted');
  });
});

describe('website_preview_domain', () => {
  it('returns the existing preview alias without a write', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: '/branding', body: branding }]);
    const r = await callTool(byName(tools, 'website_preview_domain'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ available: true, previewDomain: 'vahi-dev-ccyq.sgp1.mystaging.site', created: false });
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
  });
  it('creates one when missing and the provider has a staging domain', async () => {
    const noAlias = { ...websiteDetail, aliases: [] };
    const { ctx } = await makeContext([
      { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: { items: [noAlias], total: 1 } },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: noAlias },
      { method: 'GET', path: '/branding', body: branding },
      { method: 'POST', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/preview`, status: 201, body: 'vahi-dev-zzzz.sgp1.mystaging.site' },
    ]);
    const r = await callTool(byName(tools, 'website_preview_domain'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ available: true, previewDomain: 'vahi-dev-zzzz.sgp1.mystaging.site', created: true });
  });
  it('reports unavailable with the curl --resolve fallback when the provider has none', async () => {
    const noAlias = { ...websiteDetail, aliases: [] };
    const { ctx } = await makeContext([
      { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: { items: [noAlias], total: 1 } },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: noAlias },
      { method: 'GET', path: '/branding', body: brandingNoStaging },
    ]);
    const r = await callTool(byName(tools, 'website_preview_domain'), { website: 'vahi.dev' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.structured).toMatchObject({ available: false });
    expect(r.text).toContain('curl -k --resolve vahi.dev:443:65.98.32.45 https://vahi.dev/');
  });
});

describe('website_delete', () => {
  it('has a target and preview and soft-deletes without force', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'DELETE', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, status: 204 }]);
    const t = byName(tools, 'website_delete');
    const target = await t.target!({ website: 'vahi.dev' }, ctx);
    expect(target).toEqual({ kind: 'website', id: WEBSITE_ID, name: 'vahi.dev' });
    const preview = await t.preview!({ website: 'vahi.dev' }, ctx, target);
    expect(preview).toContain('soft-delete');
    expect(preview).toContain('1 alias');
    const r = await t.handler({ website: 'vahi.dev' }, ctx, target);
    expect(r.text).toContain('deleted');
    const del = f.calls.find((c) => c.method === 'DELETE');
    expect(del?.path).toBe(`/orgs/${ORG_ID}/websites/${WEBSITE_ID}`);
    expect(del?.path).not.toContain('force');
  });
});
