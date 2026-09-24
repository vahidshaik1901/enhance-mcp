export interface Route {
  method: string;
  path: string | RegExp; // pathname without the /api prefix, no query string
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  handler?: (req: Request, url: URL) => Response | Promise<Response>;
}

export interface RecordedCall {
  method: string;
  path: string; // includes query string
  headers: Headers;
  body?: string;
}

export type FakeFetch = typeof fetch & { calls: RecordedCall[] };

export function fakeFetch(routes: Route[]): FakeFetch {
  const calls: RecordedCall[] = [];
  // No "dom" lib is in scope (see tsconfig.json), so the global `RequestInfo` alias used by the
  // brief isn't declared here; @types/node's web-globals/fetch.d.ts types the global fetch's
  // first parameter as `string | URL | Request`, which is what fn must be assignable to.
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '');
    // Read the body off a clone so a route's own `handler` (e.g. one that calls req.json())
    // still finds an unconsumed stream on `req` itself.
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.clone().text();
    calls.push({ method: req.method, path: path + url.search, headers: req.headers, body });
    const route = routes.find((r) => r.method.toUpperCase() === req.method && (typeof r.path === 'string' ? r.path === path : r.path.test(path)));
    if (!route) {
      return new Response(JSON.stringify({ code: 'not_found', message: `fakeFetch: no route for ${req.method} ${path}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (route.handler) return route.handler(req, url);
    const status = route.status ?? 200;
    if (status === 204) return new Response(null, { status, headers: route.headers });
    return new Response(JSON.stringify(route.body ?? {}), { status, headers: { 'content-type': 'application/json', ...(route.headers ?? {}) } });
  };
  return Object.assign(fn as typeof fetch, { calls });
}

/** A route that answers 403 unauthorized unless the request carries the expected auth header. */
export function authGuard(expected: { bearer?: string; cookie?: string }, route: Route): Route {
  return {
    ...route,
    handler: async (req, url) => {
      const auth = req.headers.get('authorization');
      const cookie = req.headers.get('cookie');
      const okBearer = expected.bearer !== undefined && auth === `Bearer ${expected.bearer}`;
      const okCookie = expected.cookie !== undefined && cookie === `id0=${expected.cookie}`;
      if (!okBearer && !okCookie) {
        return new Response(JSON.stringify({ code: 'unauthorized' }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      if (route.handler) return route.handler(req, url);
      return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

/**
 * A write and the listing that shows its result: the listing answers `before` until the write has
 * been attempted and `after` from then on, whatever the write itself answered. That is the case
 * write-then-verify exists for — the request "failed" (threw, timed out, 5xx) and still landed.
 * Put these routes BEFORE any other route for the same paths: the first match wins.
 */
export function writeThenList(opts: { writeMethod?: string; writePath: string; listPath: string; before: unknown; after: unknown; write: (req: Request) => Response | Promise<Response> }): Route[] {
  let written = false;
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return [
    { method: opts.writeMethod ?? 'POST', path: opts.writePath, handler: async (req) => { written = true; return opts.write(req); } },
    { method: 'GET', path: opts.listPath, handler: async () => json(written ? opts.after : opts.before) },
  ];
}
