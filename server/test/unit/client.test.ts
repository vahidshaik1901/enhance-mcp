import { describe, expect, it } from 'vitest';
import { createEnhanceClient } from '../../src/client/client.js';
import { EnhanceApiError } from '../../src/client/errors.js';
import { loadConfig } from '../../src/config.js';
import { authGuard, fakeFetch } from '../helpers/fakeFetch.js';
import { memberships, ORG_ID, PANEL_URL, TOKEN, twoMemberships, websitesList } from '../fixtures/panel.js';

const config = (extra: Record<string, string> = {}) => loadConfig({ env: { ENHANCE_PANEL_URL: PANEL_URL, ENHANCE_TOKEN: TOKEN, ...extra }, home: '/tmp' });
const noSleep = async () => undefined;

describe('createEnhanceClient', () => {
  it('detects auth, picks the single org, and sends auth on every call', async () => {
    const f = fakeFetch([
      authGuard({ bearer: TOKEN }, { method: 'GET', path: '/login/memberships', body: memberships }),
      authGuard({ bearer: TOKEN }, { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: websitesList }),
    ]);
    const client = await createEnhanceClient(config(), { fetch: f, sleep: noSleep });
    expect(client.authMode).toBe('bearer');
    expect(client.orgId).toBe(ORG_ID);
    expect(client.orgName).toBe('Shaik Vahid');
    const data = await client.call('GET', '/orgs/{org_id}/websites', () => client.api.GET('/orgs/{org_id}/websites', { params: { path: { org_id: ORG_ID }, query: { showAliases: true } } }));
    expect(data.total).toBe(1);
    expect(f.calls.at(-1)?.path).toBe(`/orgs/${ORG_ID}/websites?showAliases=true`);
    expect(f.calls.at(-1)?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('leaves orgId undefined with several memberships and no ENHANCE_ORG_ID', async () => {
    const f = fakeFetch([authGuard({ bearer: TOKEN }, { method: 'GET', path: '/login/memberships', body: twoMemberships })]);
    const client = await createEnhanceClient(config(), { fetch: f, sleep: noSleep });
    expect(client.orgId).toBeUndefined();
    expect(client.memberships).toHaveLength(2);
  });

  it('rejects ENHANCE_ORG_ID that is not a membership', async () => {
    const f = fakeFetch([authGuard({ bearer: TOKEN }, { method: 'GET', path: '/login/memberships', body: memberships })]);
    await expect(createEnhanceClient(config({ ENHANCE_ORG_ID: '22222222-2222-4222-8222-222222222222' }), { fetch: f, sleep: noSleep })).rejects.toThrow(/not a member/);
  });

  it('throws EnhanceApiError with explanation on 403 and retries GET on 503', async () => {
    let hits = 0;
    const f = fakeFetch([
      authGuard({ bearer: TOKEN }, { method: 'GET', path: '/login/memberships', body: memberships }),
      { method: 'GET', path: '/servers', status: 403, body: { code: 'only_mo_allowed', message: 'Only an MO admin may perform this operation' } },
      {
        method: 'GET', path: `/orgs/${ORG_ID}/websites`,
        handler: async () => {
          hits += 1;
          if (hits < 2) return new Response(JSON.stringify({ code: 'internal' }), { status: 503, headers: { 'content-type': 'application/json' } });
          return new Response(JSON.stringify(websitesList), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
    ]);
    const client = await createEnhanceClient(config(), { fetch: f, sleep: noSleep });
    const err = await client.call('GET', '/servers', () => client.api.GET('/servers')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnhanceApiError);
    expect((err as EnhanceApiError).code).toBe('only_mo_allowed');
    expect((err as EnhanceApiError).explanation.explanation).toMatch(/master org/i);
    const data = await client.call('GET', '/orgs/{org_id}/websites', () => client.api.GET('/orgs/{org_id}/websites', { params: { path: { org_id: ORG_ID } } }));
    expect(data.total).toBe(1);
    expect(hits).toBe(2);
  });

  it('returns undefined data for 204 responses', async () => {
    const f = fakeFetch([
      authGuard({ bearer: TOKEN }, { method: 'GET', path: '/login/memberships', body: memberships }),
      { method: 'PATCH', path: `/orgs/${ORG_ID}/websites/x`, status: 204 },
    ]);
    const client = await createEnhanceClient(config(), { fetch: f, sleep: noSleep });
    const data = await client.call('PATCH', '/orgs/{org_id}/websites/{website_id}', () =>
      client.api.PATCH('/orgs/{org_id}/websites/{website_id}', { params: { path: { org_id: ORG_ID, website_id: 'x' } }, body: { phpVersion: 'php84' } }),
    );
    expect(data).toBeUndefined();
    expect(f.calls.at(-1)?.body).toBe('{"phpVersion":"php84"}');
  });
});
