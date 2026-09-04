import { describe, expect, it } from 'vitest';
import { AuthError, authHeaders, detectAuthMode } from '../../src/client/auth.js';
import { authGuard, fakeFetch } from '../helpers/fakeFetch.js';
import { memberships, PANEL_URL, TOKEN } from '../fixtures/panel.js';

const API = `${PANEL_URL}/api`;

describe('authHeaders', () => {
  it('builds bearer and cookie headers', () => {
    expect(authHeaders('bearer', 'abc')).toEqual({ Authorization: 'Bearer abc' });
    expect(authHeaders('cookie', 'abc')).toEqual({ Cookie: 'id0=abc' });
  });
});

describe('detectAuthMode', () => {
  it('prefers bearer when the panel accepts it', async () => {
    const f = fakeFetch([authGuard({ bearer: TOKEN }, { method: 'GET', path: '/login/memberships', body: memberships })]);
    const r = await detectAuthMode(f, API, TOKEN);
    expect(r.mode).toBe('bearer');
    expect(r.memberships[0]?.orgName).toBe('Shaik Vahid');
    expect(f.calls).toHaveLength(1);
  });

  it('falls back to the session cookie when bearer is rejected', async () => {
    const f = fakeFetch([authGuard({ cookie: TOKEN }, { method: 'GET', path: '/login/memberships', body: memberships })]);
    const r = await detectAuthMode(f, API, TOKEN);
    expect(r.mode).toBe('cookie');
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]?.headers.get('cookie')).toBe(`id0=${TOKEN}`);
  });

  it('throws AuthError with the panel code when both fail', async () => {
    const f = fakeFetch([authGuard({ bearer: 'other' }, { method: 'GET', path: '/login/memberships', body: memberships })]);
    await expect(detectAuthMode(f, API, TOKEN)).rejects.toMatchObject({ name: 'AuthError', lastStatus: 403, lastCode: 'unauthorized' });
  });
});
