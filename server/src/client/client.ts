import createClient, { type Middleware } from 'openapi-fetch';
import type { Config } from '../config.js';
import { safe } from '../core/respond.js';
import { authHeaders, detectAuthMode, type AuthMode, type LoginMembership } from './auth.js';
import { EnhanceApiError, MAX_API_MESSAGE } from './errors.js';
import type { paths } from './generated/types.js';
import { createLimiter, withRetry, type Limiter } from './ratelimit.js';

export type Api = ReturnType<typeof createClient<paths>>;

export interface FetchLikeResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

export interface EnhanceClient {
  api: Api;
  authMode: AuthMode;
  memberships: LoginMembership[];
  orgId: string | undefined;
  orgName: string | undefined;
  /** Runs one typed request through the limiter and retry policy; throws EnhanceApiError on any non-2xx. */
  call<T>(method: string, path: string, exec: () => Promise<FetchLikeResult<T>>): Promise<T>;
}

export interface ClientDeps {
  fetch?: typeof fetch;
  limiter?: Limiter;
  sleep?: (ms: number) => Promise<void>;
}

function retryAfterMsFromHeaders(response: Response): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  return retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
}

/**
 * openapi-fetch already reads the response body (via response.text()) to populate `error` on a
 * non-2xx result, which consumes the stream. Re-reading it through EnhanceApiError.fromResponse
 * throws "Body is unusable" in Node's fetch, and the brief's own catch(() => '') swallows that,
 * silently downgrading every error to a bare `http_<status>` code. Build the error from the
 * already-parsed `error` value instead; fall back to fromResponse only when openapi-fetch didn't
 * parse a body (e.g. an empty-content error response), where the stream is still readable.
 */
async function errorFromResult(response: Response, error: unknown, method: string, path: string): Promise<EnhanceApiError> {
  if (error === undefined) return EnhanceApiError.fromResponse(response, method, path);
  const retryAfterMs = retryAfterMsFromHeaders(response);
  let code = `http_${response.status}`;
  let message: string | undefined;
  if (error && typeof error === 'object') {
    const body = error as { code?: string; message?: string; detail?: string };
    if (typeof body.code === 'string') code = body.code;
    message = (body.message ?? body.detail)?.slice(0, MAX_API_MESSAGE);
  } else if (typeof error === 'string') {
    message = error.slice(0, MAX_API_MESSAGE);
  }
  return new EnhanceApiError(response.status, code, message, method, path, retryAfterMs);
}

/**
 * Normalises an endpoint that answers with a bare scalar rather than a JSON object. The panel
 * sends these as `text/plain` with an unquoted body (`ForeignServer`), but the spec describes a
 * JSON string and some deployments send `"ForeignServer"`. Fetched with `parseAs: 'text'`, both
 * shapes arrive here as a string; anything else means the endpoint answered unexpectedly.
 */
export function parseScalarText(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Not valid JSON after all: fall through and use the trimmed text as-is.
    }
  }
  return trimmed;
}

export async function createEnhanceClient(config: Config, deps: ClientDeps = {}): Promise<EnhanceClient> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const limiter = deps.limiter ?? createLimiter();
  const { mode, memberships } = await detectAuthMode(fetchFn, config.apiBase, config.token);

  let orgId: string | undefined;
  if (config.orgId) {
    if (!memberships.some((m) => m.orgId === config.orgId)) {
      throw new Error(`ENHANCE_ORG_ID ${config.orgId} is set but this credential is not a member of that org. Memberships: ${memberships.map((m) => `${safe(m.orgName)} (${m.orgId})`).join(', ') || 'none'}`);
    }
    orgId = config.orgId;
  } else if (memberships.length === 1) {
    orgId = memberships[0]?.orgId;
  }
  const orgName = memberships.find((m) => m.orgId === orgId)?.orgName;

  const auth: Middleware = {
    onRequest({ request }) {
      for (const [k, v] of Object.entries(authHeaders(mode, config.token))) request.headers.set(k, v);
      request.headers.set('Accept', 'application/json');
      return request;
    },
  };

  const api = createClient<paths>({
    baseUrl: config.apiBase,
    fetch: (req) => fetchFn(req, { signal: AbortSignal.timeout(config.timeoutMs) }),
  });
  api.use(auth);

  return {
    api,
    authMode: mode,
    memberships,
    orgId,
    orgName,
    async call<T>(method: string, path: string, exec: () => Promise<FetchLikeResult<T>>): Promise<T> {
      return limiter.run(() =>
        withRetry(
          async () => {
            const { data, error, response } = await exec();
            if (!response.ok) throw await errorFromResult(response, error, method, path);
            if (response.status === 204) return undefined as T;
            return data as T;
          },
          method,
          { sleep: deps.sleep },
        ),
      );
    },
  };
}
