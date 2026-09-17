import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';

export interface ProbeRequest {
  /** The app server's IP: the connection goes here, whatever DNS says. */
  ip: string;
  /** The primary domain, sent as SNI and as the Host header. */
  host: string;
  /** Absolute URL path, e.g. `/node/`. */
  path: string;
  timeoutMs: number;
  maxBodyBytes: number;
}

export interface ProbeResponse {
  status: number;
  latencyMs: number;
  contentType: string | null;
  /** The first `maxBodyBytes` of the body, decoded as UTF-8. */
  body: string;
  /** `valid`, `placeholder` (the panel's self-signed 1975 certificate), or `error:<reason>`. */
  certificate: string;
}

export type HttpProbe = (req: ProbeRequest) => Promise<ProbeResponse>;

interface CertLike {
  issuer?: { CN?: string };
  subject?: { CN?: string };
  valid_from?: string;
}

/** Pure: the verdict from what the socket reports. The placeholder is what every new Enhance
 *  domain serves until Let's Encrypt issues (issuer equals the domain, dated 1975). */
export function classifyCertificate(cert: CertLike | undefined, host: string, authorized: boolean, authorizationError?: string): string {
  if (authorized) return 'valid';
  if (!cert || Object.keys(cert).length === 0) return 'error:no certificate';
  const selfIssued = cert.issuer?.CN === host && cert.subject?.CN === host;
  if (selfIssued || cert.valid_from?.includes('1975')) return 'placeholder';
  return `error:${authorizationError ?? 'unverified'}`;
}

/** Pure: the first `max` bytes of the chunks kept so far, and whether that cap was reached. The
 *  cap is the whole point — the probe reports a page's first bytes, never downloads it — so the
 *  caller stops reading as soon as `hitCap` would be true. */
export function collectCapped(chunks: Buffer[], max: number): { body: string; hitCap: boolean } {
  const joined = Buffer.concat(chunks);
  return { body: joined.subarray(0, max).toString('utf8'), hitCap: joined.length >= max };
}

/** `<img>`, `<script>` and `<link>` open tags, with their attribute text. */
const ASSET_TAG_RE = /<(img|script|link)\b([^>]*)>/gi;
/** One `name="value"`, `name='value'` or `name=value` pair inside a tag. */
const ATTR_RE = /([A-Za-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
/** The `rel` values whose target the browser fetches as part of rendering the page. */
const FETCHED_REL = new Set(['stylesheet', 'icon', 'preload']);
/** Assets checked per page. A dozen covers a page's CSS, JS and hero images; the cap is what keeps
 *  one bad page from turning the probe into a crawl of the whole site. */
const MAX_ASSETS = 12;

function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR_RE)) found[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return found;
}

/**
 * Pure: every reference in `html` that the browser would fetch from the page's own origin, as a
 * path on that origin (`/next.svg?a=1`), in document order, deduplicated and capped.
 *
 * Only same-origin references are returned: another host's 404 is not this deploy's problem, and
 * a `data:` URI, a fragment or a `javascript:` handler is nothing to fetch. A regex rather than a
 * DOM parser because the question is "which URLs does this page name", not "what does it mean" —
 * a missed attribute costs one unchecked asset, never a wrong verdict.
 */
export function extractAssetUrls(html: string, pageUrl: string): string[] {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (raw === undefined || out.length >= MAX_ASSETS) return;
    // `&amp;` is how a query string is written in HTML; fetching it verbatim would 404 on a URL
    // that works perfectly in a browser.
    const ref = raw.trim().replace(/&amp;/gi, '&');
    if (ref === '' || ref.startsWith('#')) return;
    let u: URL;
    try {
      u = new URL(ref, pageUrl);
    } catch {
      return;
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== origin) return;
    const path = `${u.pathname}${u.search}`;
    if (seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };
  for (const tag of html.matchAll(ASSET_TAG_RE)) {
    const name = tag[1]!.toLowerCase();
    const attrs = attributes(tag[2] ?? '');
    if (name === 'link') {
      const rel = (attrs['rel'] ?? '').toLowerCase().split(/\s+/);
      if (rel.some((r) => FETCHED_REL.has(r))) add(attrs['href']);
      continue;
    }
    add(attrs['src']);
    // A srcset lists `<url> <descriptor>` candidates: the first one is enough to tell whether the
    // app serves that family of images at all.
    if (attrs['srcset'] !== undefined) add(attrs['srcset'].split(',')[0]?.trim().split(/\s+/)[0]);
  }
  return out;
}

/**
 * The `curl --resolve <host>:443:<ip>` equivalent: TLS to the IP with the domain as SNI. The
 * certificate is inspected and REPORTED, not enforced (`rejectUnauthorized: false`), because a
 * new domain serves the panel's self-signed placeholder until Let's Encrypt issues and the tool
 * exists to verify a deploy before that. This is safe only because the probe is one-way and
 * secret-free: it never sends the panel credential, a cookie or any header beyond Host and
 * User-Agent, follows no redirects, and reads at most `maxBodyBytes` of a page the customer
 * publishes. Never reuse this transport for anything that carries a credential.
 *
 * Two things bound it, and both are needed. `timeout` below is an INACTIVITY timeout: every
 * chunk resets it, so a page that dribbles a byte a second (or an SSE endpoint that never ends)
 * would keep the call pending forever. The `deadline` is absolute, so the whole probe is over
 * within `timeoutMs` whatever the server does. And once `maxBodyBytes` are collected there is
 * nothing left to learn, so the response is settled and the socket destroyed rather than read to
 * the end. The `settled` flag makes the promise settle exactly once across all of those paths.
 */
export const httpsProbe: HttpProbe = (req) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const settle = (act: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      act();
    };
    const done = (value: ProbeResponse): void => settle(() => resolve(value));
    const failed = (e: Error): void => settle(() => reject(e));
    const r = request(
      { host: req.ip, port: 443, servername: req.host, path: req.path, method: 'GET', headers: { host: req.host, 'user-agent': 'enhance-mcp/probe' }, rejectUnauthorized: false, timeout: req.timeoutMs },
      (res) => {
        const socket = res.socket as TLSSocket | null;
        const authError = socket?.authorizationError;
        const certificate = classifyCertificate(socket?.getPeerCertificate?.() as CertLike | undefined, req.host, socket?.authorized === true, authError ? String(authError) : undefined);
        const chunks: Buffer[] = [];
        let size = 0;
        const answer = (): ProbeResponse => ({ status: res.statusCode ?? 0, latencyMs: Date.now() - started, contentType: res.headers['content-type'] ?? null, body: collectCapped(chunks, req.maxBodyBytes).body, certificate });
        res.on('data', (c: Buffer) => {
          if (size < req.maxBodyBytes) {
            const pushed = c.subarray(0, req.maxBodyBytes - size);
            chunks.push(pushed);
            size += pushed.length;
          }
          if (size >= req.maxBodyBytes) {
            done(answer());
            res.destroy();
          }
        });
        res.on('end', () => done(answer()));
        res.on('error', failed);
      },
    );
    deadline = setTimeout(() => r.destroy(new Error(`no response within ${req.timeoutMs} ms`)), req.timeoutMs);
    r.on('timeout', () => r.destroy(new Error(`no response within ${req.timeoutMs} ms`)));
    r.on('error', failed);
    r.end();
  });
