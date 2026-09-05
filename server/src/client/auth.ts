import type { components } from './generated/types.js';

export type AuthMode = 'bearer' | 'cookie';
export type LoginMembership = components['schemas']['LoginMembership'];

export function authHeaders(mode: AuthMode, token: string): Record<string, string> {
  return mode === 'bearer' ? { Authorization: `Bearer ${token}` } : { Cookie: `id0=${token}` };
}

export class AuthError extends Error {
  override name = 'AuthError';
  constructor(
    message: string,
    readonly lastStatus: number,
    readonly lastCode: string,
  ) {
    super(message);
  }
}

async function probe(fetchFn: typeof fetch, apiBase: string, mode: AuthMode, token: string): Promise<{ ok: true; memberships: LoginMembership[] } | { ok: false; status: number; code: string }> {
  const res = await fetchFn(`${apiBase}/login/memberships`, { headers: { Accept: 'application/json', ...authHeaders(mode, token) } });
  if (res.ok) {
    const body = (await res.json()) as { memberships: LoginMembership[] };
    return { ok: true, memberships: body.memberships ?? [] };
  }
  let code = `http_${res.status}`;
  try {
    const body = (await res.json()) as { code?: string };
    if (body.code) code = body.code;
  } catch {
    /* non-JSON body */
  }
  return { ok: false, status: res.status, code };
}

/** Tries Bearer first, then the panel session cookie. */
export async function detectAuthMode(fetchFn: typeof fetch, apiBase: string, token: string): Promise<{ mode: AuthMode; memberships: LoginMembership[] }> {
  const bearer = await probe(fetchFn, apiBase, 'bearer', token);
  if (bearer.ok) return { mode: 'bearer', memberships: bearer.memberships };
  const cookie = await probe(fetchFn, apiBase, 'cookie', token);
  if (cookie.ok) return { mode: 'cookie', memberships: cookie.memberships };
  throw new AuthError(
    `The panel rejected the credential as a Bearer access token (HTTP ${bearer.status} ${bearer.code}) and as a session cookie (HTTP ${cookie.status} ${cookie.code}). ` +
      'It is invalid, expired, IP-restricted, or for a different panel. Create a new access token under Settings > Access Tokens, or copy a fresh session credential.',
    cookie.status,
    cookie.code,
  );
}
