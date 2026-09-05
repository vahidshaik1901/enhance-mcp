import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/doctor.js';
import { authGuard, fakeFetch } from '../helpers/fakeFetch.js';
import { accessTokens, login, memberships, ORG_ID, PANEL_URL, subscriptions, TOKEN, websitesList } from '../fixtures/panel.js';

describe('doctor', () => {
  it('prints checks and returns 0 when healthy', async () => {
    const f = fakeFetch([
      { method: 'GET', path: '/version', body: '12.25.5' },
      authGuard({ bearer: TOKEN }, { method: 'GET', path: '/login/memberships', body: memberships }),
      authGuard({ bearer: TOKEN }, { method: 'GET', path: '/login', body: login }),
      authGuard({ bearer: TOKEN }, { method: 'GET', path: `/orgs/${ORG_ID}/access_tokens`, body: accessTokens }),
      authGuard({ bearer: TOKEN }, { method: 'GET', path: `/orgs/${ORG_ID}/subscriptions`, body: subscriptions }),
      authGuard({ bearer: TOKEN }, { method: 'GET', path: `/orgs/${ORG_ID}/websites`, body: websitesList }),
    ]);
    const lines: string[] = [];
    const code = await runDoctor({ ENHANCE_PANEL_URL: PANEL_URL, ENHANCE_TOKEN: TOKEN, HOME: '/tmp' }, { fetch: f, sleep: async () => undefined }, (l) => lines.push(l));
    expect(code).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('ok  config');
    expect(out).toContain('ok  panel reachable (12.25.5)');
    expect(out).toContain('ok  credential: bearer');
    expect(out).toContain('ok  org: Shaik Vahid');
    expect(out).toContain('ok  websites: 1');
    expect(out).not.toContain(TOKEN);
  });
  it('returns 1 and explains when the credential is rejected', async () => {
    const f = fakeFetch([{ method: 'GET', path: '/version', body: '12.25.5' }, authGuard({ bearer: 'other' }, { method: 'GET', path: '/login/memberships', body: memberships })]);
    const lines: string[] = [];
    const code = await runDoctor({ ENHANCE_PANEL_URL: PANEL_URL, ENHANCE_TOKEN: TOKEN, HOME: '/tmp' }, { fetch: f, sleep: async () => undefined }, (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('FAIL credential');
  });
  it('returns 1 when config is missing', async () => {
    const lines: string[] = [];
    const code = await runDoctor({ HOME: '/tmp' }, {}, (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('ENHANCE_PANEL_URL');
  });
});
