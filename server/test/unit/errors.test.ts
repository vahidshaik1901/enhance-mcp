import { describe, expect, it } from 'vitest';
import { EnhanceApiError, explainError } from '../../src/client/errors.js';

describe('explainError', () => {
  it('maps the codes seen on the live panel', () => {
    expect(explainError(401, 'no_session_token').explanation).toMatch(/no credential/i);
    expect(explainError(403, 'unauthorized').explanation).toMatch(/invalid, expired, IP-restricted, or lacks the role/);
    expect(explainError(403, 'unauthorized').nextStep).toMatch(/auth_status/);
    expect(explainError(403, 'only_mo_allowed').explanation).toMatch(/master org/i);
    expect(explainError(403, 'unauthorized', 'Only a reseller or the MO may perform this operation').explanation).toMatch(/reseller/i);
    expect(explainError(404, 'not_found').explanation).toMatch(/not found/i);
    expect(explainError(404, 'http_404', 'UUID parsing failed: invalid character').explanation).toMatch(/internal bug/i);
    expect(explainError(409, 'conflict').explanation).toMatch(/already exists|conflicting/i);
    expect(explainError(429, 'rate_limited').explanation).toMatch(/rate limit/i);
    expect(explainError(503, 'internal').explanation).toMatch(/panel error/i);
    expect(explainError(418, 'teapot').explanation).toMatch(/unexpected/i);
  });
});

describe('EnhanceApiError.fromResponse', () => {
  it('parses a JSON error body', async () => {
    const res = new Response(JSON.stringify({ code: 'only_mo_allowed', message: 'Only an MO admin may perform this operation' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
    const err = await EnhanceApiError.fromResponse(res, 'GET', '/servers');
    expect(err.status).toBe(403);
    expect(err.code).toBe('only_mo_allowed');
    expect(err.apiMessage).toBe('Only an MO admin may perform this operation');
    expect(err.toText()).toContain('GET /servers');
    expect(err.toText()).toContain('only_mo_allowed');
  });

  it('parses a plain-text body and Retry-After', async () => {
    const res = new Response('UUID parsing failed: invalid character', { status: 404, headers: { 'retry-after': '2' } });
    const err = await EnhanceApiError.fromResponse(res, 'GET', '/orgs//websites');
    expect(err.code).toBe('http_404');
    expect(err.apiMessage).toMatch(/UUID parsing failed/);
    expect(err.retryAfterMs).toBe(2000);
  });
});
