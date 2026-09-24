import { describe, expect, it } from 'vitest';
import { tools } from '../../src/tools/websites.js';
import { byName, callTool, makeContext } from '../helpers/context.js';
import type { Route } from '../helpers/fakeFetch.js';
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

  it('treats a subscription with no websites resource entry as ineligible (convention 14)', async () => {
    const first = subscriptions.items[0]!;
    const noQuota = { ...first, resources: first.resources.filter((r) => r.name !== 'websites') };
    const created = { ...websiteDetail, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', domain: { ...websiteDetail.domain, domain: 'new.example' }, aliases: [] };
    const { ctx, f } = await makeContext([
      ...base(),
      { method: 'POST', path: `/orgs/${ORG_ID}/domains/check`, body: { status: 'notInUse', websiteId: null } },
      { method: 'GET', path: `/orgs/${ORG_ID}/subscriptions`, body: { items: [noQuota, subscriptions.items[1]], total: 2 } },
      { method: 'POST', path: `/orgs/${ORG_ID}/websites`, status: 201, body: { id: created.id } },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${created.id}`, body: created },
    ]);
    // 686 is the only eligible subscription left, so it is picked without asking.
    const r = await callTool(byName(tools, 'website_create'), { domain: 'new.example' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(f.calls.find((c) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/websites`)?.body).toBe('{"domain":"new.example","subscriptionId":686}');
    // ... and naming 664 explicitly is refused, listing only 686.
    const bad = await callTool(byName(tools, 'website_create'), { domain: 'other.example', subscription_id: 664 }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Eligible: 686.');
  });

  const created = { ...websiteDetail, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', domain: { ...websiteDetail.domain, domain: 'new.example' }, aliases: [] };
  const oneSubscription = { method: 'GET', path: `/orgs/${ORG_ID}/subscriptions`, body: { ...subscriptions, items: [subscriptions.items[0]] } };
  /** domain_check answers notInUse to the pre-check, then `later` to every re-read after the create. */
  const checkThen = (later: unknown, seen: { checks: number }): Route => ({
    method: 'POST',
    path: `/orgs/${ORG_ID}/domains/check`,
    handler: async () => {
      seen.checks += 1;
      return new Response(JSON.stringify(seen.checks === 1 ? { status: 'notInUse', websiteId: null } : later), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const websitesPost = (c: { method: string; path: string }) => c.method === 'POST' && c.path === `/orgs/${ORG_ID}/websites`;

  it('confirms a create whose answer never came by re-checking the domain, and never posts twice', async () => {
    const seen = { checks: 0 };
    const { ctx, f } = await makeContext([
      ...base(),
      checkThen({ status: 'inUseCurrentOrg', websiteId: created.id }, seen),
      oneSubscription,
      { method: 'POST', path: `/orgs/${ORG_ID}/websites`, handler: async () => { throw new TypeError('fetch failed'); } },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${created.id}`, body: created },
    ]);
    const r = await callTool(byName(tools, 'website_create'), { domain: 'new.example' }, ctx);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toContain('website: new.example');
    expect(r.text).toContain('confirmed by reading it back');
    expect(r.text).toContain('next steps');
    expect(r.structured).toMatchObject({ created: true, websiteId: created.id, confirmedBy: 'verify' });
    expect(f.calls.filter(websitesPost)).toHaveLength(1);
    expect(seen.checks).toBe(2);
  });

  it('says the outcome is unknown, not failed, when 90 s of re-checks never see the site', async () => {
    const seen = { checks: 0 };
    const { ctx, f } = await makeContext([
      ...base(),
      checkThen({ status: 'notInUse', websiteId: null }, seen),
      oneSubscription,
      { method: 'POST', path: `/orgs/${ORG_ID}/websites`, handler: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } },
    ]);
    const r = await callTool(byName(tools, 'website_create'), { domain: 'new.example' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('OUTCOME UNKNOWN');
    expect(r.text).toContain('Do not retry yet');
    expect(r.text).toContain('domain_check domain=new.example');
    expect(r.structured).toMatchObject({ outcome: 'unknown', created: null, domain: 'new.example', reads: 18 });
    expect(f.calls.filter(websitesPost)).toHaveLength(1);
    // The pre-check, then a re-read every 5 s for 90 s.
    expect(seen.checks).toBe(1 + 18);
    // The sentence counts the reads that were made, not the window they were allowed.
    expect(r.text).toContain('18 re-reads');
  });

  it('passes a 409 through as the panel refusing, with no re-reads', async () => {
    const seen = { checks: 0 };
    const { ctx } = await makeContext([
      ...base(),
      checkThen({ status: 'inUseCurrentOrg', websiteId: created.id }, seen),
      oneSubscription,
      { method: 'POST', path: `/orgs/${ORG_ID}/websites`, status: 409, body: { code: 'already_exists', message: 'website exists' } },
    ]);
    await expect(callTool(byName(tools, 'website_create'), { domain: 'new.example' }, ctx)).rejects.toThrow(/409/);
    expect(seen.checks).toBe(1);
  });

  it('confirms a create the gateway answered 502 for, by re-checking the domain', async () => {
    const seen = { checks: 0 };
    const { ctx, f } = await makeContext([
      ...base(),
      checkThen({ status: 'inUseCurrentOrg', websiteId: created.id }, seen),
      oneSubscription,
      // A proxy in front of the panel gives up on a slow create and answers 502 while the panel
      // carries on and finishes the site.
      { method: 'POST', path: `/orgs/${ORG_ID}/websites`, handler: async () => new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, headers: { 'content-type': 'text/html' } }) },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${created.id}`, body: created },
    ]);
    const r = await callTool(byName(tools, 'website_create'), { domain: 'new.example' }, ctx);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toContain('HTTP 502');
    expect(r.text).toContain('confirmed by reading it back');
    expect(r.structured).toMatchObject({ created: true, websiteId: created.id, confirmedBy: 'verify' });
    expect(f.calls.filter(websitesPost)).toHaveLength(1);
    expect(seen.checks).toBe(2);
  });

  it('settles the id of a create answered 2xx with no body by one domain check, and renders the site', async () => {
    // openapi-fetch hands back `undefined` for an empty 2xx body: the site exists, only its id is
    // missing, and the same question `find` asks names it.
    const seen = { checks: 0 };
    const { ctx, f } = await makeContext([
      ...base(),
      checkThen({ status: 'inUseCurrentOrg', websiteId: created.id }, seen),
      oneSubscription,
      { method: 'POST', path: `/orgs/${ORG_ID}/websites`, handler: async () => new Response(null, { status: 201 }) },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${created.id}`, body: created },
    ]);
    const r = await callTool(byName(tools, 'website_create'), { domain: 'new.example' }, ctx);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toContain('website: new.example');
    expect(r.text).not.toContain('undefined');
    expect(r.structured).toMatchObject({ created: true, websiteId: created.id, confirmedBy: 'response' });
    expect(f.calls.filter(websitesPost)).toHaveLength(1);
    // The pre-check, then exactly one read for the id: the write answered, so nothing polls.
    expect(seen.checks).toBe(2);
  });

  it('stays a success with no id when a body-less create cannot be found by the domain check either', async () => {
    const seen = { checks: 0 };
    const { ctx, f } = await makeContext([
      ...base(),
      checkThen({ status: 'notInUse', websiteId: null }, seen),
      oneSubscription,
      { method: 'POST', path: `/orgs/${ORG_ID}/websites`, handler: async () => new Response(null, { status: 201 }) },
    ]);
    const r = await callTool(byName(tools, 'website_create'), { domain: 'new.example' }, ctx);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text.split('\n')[0]).toContain('org:');
    expect(r.text).toContain('website new.example created; the panel returned no id — run domain_check domain=new.example (inUseCurrentOrg shows its id), then website_get');
    expect(r.text).not.toContain('undefined');
    expect(r.structured).toEqual({ created: true, websiteId: null, confirmedBy: 'response', website: null });
    expect(f.calls.filter(websitesPost)).toHaveLength(1);
    expect(seen.checks).toBe(2);
    // Never a read of a website with no id.
    expect(f.calls.some((c) => c.method === 'GET' && c.path.startsWith(`/orgs/${ORG_ID}/websites/`))).toBe(false);
  });

  it('stays a success with no id when the domain check for a body-less create fails, and says why', async () => {
    let checks = 0;
    const { ctx } = await makeContext([
      ...base(),
      {
        method: 'POST',
        path: `/orgs/${ORG_ID}/domains/check`,
        handler: async () => {
          checks += 1;
          return checks === 1
            ? new Response(JSON.stringify({ status: 'notInUse', websiteId: null }), { status: 200, headers: { 'content-type': 'application/json' } })
            : new Response(JSON.stringify({ code: 'internal', message: 'check is down' }), { status: 500, headers: { 'content-type': 'application/json' } });
        },
      },
      oneSubscription,
      { method: 'POST', path: `/orgs/${ORG_ID}/websites`, handler: async () => new Response(null, { status: 201 }) },
    ]);
    const r = await callTool(byName(tools, 'website_create'), { domain: 'new.example' }, ctx);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toContain('the panel returned no id');
    expect(r.text).toContain('The domain check for the id failed (HTTP 500 internal: check is down).');
    expect(r.structured).toEqual({ created: true, websiteId: null, confirmedBy: 'response', website: null });
  });

  it('stays a success when the read-back of a created site fails, and names website_get', async () => {
    const { ctx } = await makeContext([
      ...base(),
      { method: 'POST', path: `/orgs/${ORG_ID}/domains/check`, body: { status: 'notInUse', websiteId: null } },
      oneSubscription,
      { method: 'POST', path: `/orgs/${ORG_ID}/websites`, status: 201, body: { id: created.id } },
      { method: 'GET', path: `/orgs/${ORG_ID}/websites/${created.id}`, status: 500, body: { code: 'internal', message: 'detail is down' } },
    ]);
    const r = await callTool(byName(tools, 'website_create'), { domain: 'new.example' }, ctx);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toContain(`created (id ${created.id})`);
    expect(r.text).toContain(`website_get website=${created.id}`);
    expect(r.text).toContain('detail is down');
    expect(r.structured).toMatchObject({ created: true, websiteId: created.id, confirmedBy: 'response', website: null });
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
    // Convention 13: the identity block shows the state after the write, not before.
    expect(a.text.split('\n')[1]).toBe(`website: vahi.dev (${WEBSITE_ID}) \u00b7 php83 \u00b7 active \u00b7 subscription 686`);
    const b = await callTool(byName(tools, 'website_restart_php'), { website: 'vahi.dev' }, ctx);
    expect(b.text).toContain('restarted');
  });
});

describe('website_preview_domain', () => {
  it('returns the existing preview alias without a write', async () => {
    const { ctx, f } = await makeContext([...base(), { method: 'GET', path: '/branding', body: branding }]);
    const r = await callTool(byName(tools, 'website_preview_domain'), { website: 'vahi.dev' }, ctx);
    expect(r.structured).toMatchObject({ available: true, previewDomain: 'vahi-dev-ccyq.sgp1.mystaging.site', created: false });
    expect(r.text).toContain('curl -k --resolve vahi-dev-ccyq.sgp1.mystaging.site:443:65.98.32.45 https://vahi-dev-ccyq.sgp1.mystaging.site/');
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
  });
  // The preview endpoint answers with a bare scalar: the live panel sends `text/plain` with an
  // unquoted body, the spec a JSON string. Both must normalise to the same hostname.
  for (const as of ['text', 'json'] as const) {
    it(`creates one when missing and the provider has a staging domain (${as} body)`, async () => {
      const noAlias = { ...websiteDetail, aliases: [] };
      const { ctx } = await makeContext([
        { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: { items: [noAlias], total: 1 } },
        { method: 'GET', path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}`, body: noAlias },
        { method: 'GET', path: '/branding', body: branding },
        {
          method: 'POST',
          path: `/orgs/${ORG_ID}/websites/${WEBSITE_ID}/preview`,
          handler: async () =>
            as === 'text'
              ? new Response('vahi-dev-zzzz.sgp1.mystaging.site', { status: 201, headers: { 'content-type': 'text/plain' } })
              : new Response(JSON.stringify('vahi-dev-zzzz.sgp1.mystaging.site'), { status: 201, headers: { 'content-type': 'application/json' } }),
        },
      ]);
      const r = await callTool(byName(tools, 'website_preview_domain'), { website: 'vahi.dev' }, ctx);
      expect(r.structured).toMatchObject({ available: true, previewDomain: 'vahi-dev-zzzz.sgp1.mystaging.site', created: true });
      expect(r.text).toContain('preview domain: vahi-dev-zzzz.sgp1.mystaging.site (created)');
      expect(r.text).toContain('curl -k --resolve vahi-dev-zzzz.sgp1.mystaging.site:443:65.98.32.45 https://vahi-dev-zzzz.sgp1.mystaging.site/');
    });
  }
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
