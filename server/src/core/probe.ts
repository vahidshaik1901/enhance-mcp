import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { safe } from './respond.js';

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
  /** The `Location` header when the answer is a redirect (nothing is followed). Only ever used to
   *  word what was seen: a bare `/dir` redirecting to `/dir/` is how an existing directory shows. */
  location?: string | null;
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
 *  cap is the whole point — the probe reports a page's first bytes, never downloads it.
 *  `httpsProbe` tracks the size itself and stops reading at the cap; `hitCap` is for callers that
 *  collect first and ask afterwards (and for the tests). */
export function collectCapped(chunks: Buffer[], max: number): { body: string; hitCap: boolean } {
  const joined = Buffer.concat(chunks);
  return { body: joined.subarray(0, max).toString('utf8'), hitCap: joined.length >= max };
}

/** `<img>`, `<script>` and `<link>` open tags, with their attribute text. */
const ASSET_TAG_RE = /<(img|script|link)\b([^>]*)>/gi;
/** The BODY of a `<script>` or `<style>` element; the open tag is kept, because a script's own
 *  `src` is a real asset. Neither body is markup: `document.write('<img src="/x.png">')` and a
 *  `background: url(…)` inside them are not references the page necessarily requests, and reading
 *  them as tags invents assets that then "fail". */
const SCRIPT_BODY_RE = /(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi;
const STYLE_BODY_RE = /(<style\b[^>]*>)[\s\S]*?<\/style\s*>/gi;
/** A commented-out tag is not fetched by anything, so it must not be checked either. */
const COMMENT_RE = /<!--[\s\S]*?-->/g;
/** One `name="value"`, `name='value'` or `name=value` pair inside a tag. */
const ATTR_RE = /([A-Za-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
/** The `rel` values whose target the browser fetches as part of rendering the page. */
const FETCHED_REL = new Set(['stylesheet', 'icon', 'preload']);
/** Assets checked per page. A dozen covers a page's CSS, JS and hero images; the cap is what keeps
 *  one bad page from turning the probe into a crawl of the whole site. */
export const MAX_ASSETS = 12;

function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR_RE)) found[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return found;
}

/**
 * The URL of a `srcset`'s first candidate, or undefined when there is nothing to fetch. The list is
 * `<url> <descriptor>, <url> <descriptor>`, and a URL may itself hold commas (`/a,b.png`) or be a
 * `data:` URI whose base64 is full of them — so the split needs the whitespace that always follows
 * the separating comma, and a `data:` candidate is dropped rather than cut in half.
 *
 * A candidate list with no space after its commas (`/a.png,/b.png`) is taken whole on purpose: the
 * HTML srcset parser collects every non-space character into the URL, so a browser requests exactly
 * that string too.
 */
function firstSrcsetCandidate(value: string): string | undefined {
  const first = value.trim().split(/\s*,\s+/)[0]?.trim();
  if (first === undefined || first === '' || /^data:/i.test(first)) return undefined;
  return first.split(/\s+/)[0];
}

export interface AssetUrls {
  /** At most MAX_ASSETS paths, in document order, deduplicated. */
  urls: string[];
  /** More same-origin references were found than `urls` holds, so some were never fetched. */
  truncated: boolean;
  /** Every distinct same-origin reference on the page, cap or no cap. */
  totalFound: number;
}

/**
 * Pure: every reference in `html` that the browser would fetch from the page's own origin, as a
 * path on that origin (`/next.svg?a=1`), in document order, deduplicated and capped.
 *
 * Only same-origin references are returned: another host's 404 is not this deploy's problem, and
 * a `data:` URI, a fragment or a `javascript:` handler is nothing to fetch. A regex rather than a
 * DOM parser because the question is "which URLs does this page name", not "what does it mean".
 * A missed attribute costs one unchecked asset; a reference read here that the browser would never
 * request costs a FALSE failure, which is the worse error — so comments and the bodies of
 * `<script>` and `<style>` are removed before anything is matched.
 *
 * The cap is reported rather than applied silently: a caller that says "all 12 assets answered"
 * about a page naming thirty has told the customer something that is not true.
 */
export function extractAssetUrls(html: string, pageUrl: string): AssetUrls {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return { urls: [], truncated: false, totalFound: 0 };
  }
  // Script and style bodies first: a `"<!--"` string inside one would otherwise open a comment
  // that swallows the real markup after it.
  const markup = html.replace(SCRIPT_BODY_RE, '$1').replace(STYLE_BODY_RE, '$1').replace(COMMENT_RE, '');
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (raw === undefined) return;
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
    // Counting past the cap is the only reason to keep going: `seen` is what makes `totalFound`
    // a count of distinct references rather than of tags.
    if (out.length < MAX_ASSETS) out.push(path);
  };
  for (const tag of markup.matchAll(ASSET_TAG_RE)) {
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
    if (attrs['srcset'] !== undefined) add(firstSrcsetCandidate(attrs['srcset']));
  }
  return { urls: out, truncated: seen.size > out.length, totalFound: seen.size };
}

/**
 * Pure: `Promise.allSettled` with at most `limit` calls in flight, results in INPUT order so the
 * caller can pair them with its inputs by index. A rejection is reported per item and never stops
 * the rest, because one asset that will not answer must not hide the eleven that would.
 *
 * The limit is the point. Every one of these calls is its own TLS handshake to the same server, and
 * firing a dozen at once from a distant client made each of them slow enough to blow its deadline —
 * the live defect this exists to prevent. Same-thread `next++` is the whole mutual exclusion: each
 * worker takes the next index and nothing else can take it.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i] as T, i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  // At least one worker whenever there is anything to do. NaN — which every comparison here would
  // carry through to `Array.from({ length: NaN })` — means one worker, because a list of holes that
  // every caller would read as "nothing answered" is the failure to prevent. Infinity means what it
  // says, every item at once: no caller passes it, and the item count still bounds it.
  // Truncated before the test, because `Number.isNaN` does not coerce: an `undefined` from an
  // untyped caller is not NaN to it, yet `Math.trunc(undefined)` is.
  const whole = Math.trunc(limit);
  const wanted = Number.isNaN(whole) ? 1 : whole;
  const workers = items.length === 0 ? 0 : Math.max(1, Math.min(wanted, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/** The URL path the web server serves a proxy path at: `/node/`, or `/` for a whole-site app. */
export function proxyRequestPath(path: string): string {
  return path === '' ? '/' : `/${path}/`;
}

export interface AssetCheck {
  /** How many references a fetch was started for: the page's distinct same-origin references, up
   *  to MAX_ASSETS. It includes the ones that never produced a status (`unchecked`). */
  attempted: number;
  /** Of those, how many produced a definite HTTP status — `attempted` minus the unchecked ones.
   *  This is the denominator of every claim the probe makes about assets. */
  checked: number;
  /** The page names more same-origin references than were fetched, so nothing above covers them. */
  truncated: boolean;
  /** Distinct same-origin references on the page, cap or no cap. */
  totalFound: number;
  failed: Array<{ url: string; status: number; outsidePrefix: boolean }>;
  /** 401/403: the asset is served but guarded (a login, an IP rule). Reported, never a failure. */
  restricted: Array<{ url: string; status: number }>;
  /** The fetch never produced a status (timeout, reset, an answer with no status line). Reported,
   *  never a failure — see below. */
  unchecked: Array<{ url: string; reason: string }>;
  /** Set when the page could not be re-read, so nothing was checked. */
  error?: string;
}

/** Answers that prove a reference is broken: gone (404/410), or the server failing on it (5xx).
 *  Every other non-2xx — a 401 or 403 behind auth, a 405, a redirect to a file that does exist —
 *  is not proof of anything, and a probe that fails a healthy deploy is worse than one that misses
 *  a broken reference. No answer at all is not proof either: see checkPageAssets. */
const RESTRICTED_STATUSES = new Set([401, 403]);
function assetIsBroken(status: number): boolean {
  return status === 404 || status === 410 || status >= 500;
}

/** Long enough that a real asset on a slow link answers inside it. The first version used 2 s and
 *  false-failed two Next.js chunks that answer 200 in 1.1-1.7 s from a distant client. */
export const ASSET_TIMEOUT_MS = 8000;
/** How many asset fetches are open at once. Each is its own TLS handshake to the same server, and a
 *  dozen at once is what made every one of them slow enough to time out (live, 2026-09-17). */
export const ASSET_CONCURRENCY = 4;

/**
 * Whether the page's own images, scripts and stylesheets answer. A page can be HTTP 200 while
 * every image on it is broken: under a proxy path the prefix is stripped, so anything the app
 * references by absolute URL (`/logo.svg`, a file in Next.js's `public/`) is requested at the
 * DOMAIN root, where the site's own files live — the user's live case, `/next/` 200 with
 * `/next.svg` 404. A customer must never be the one who discovers that, so the probe asks.
 *
 * One byte of each asset is enough for its status, and the fetches run ASSET_CONCURRENCY at a time
 * with an ASSET_TIMEOUT_MS deadline. A fetch that never produced a status is UNCHECKED, not failed:
 * the probe reports only what it saw, and a slow link is not a broken deploy. Same transport as the
 * page: no credential, no header beyond Host.
 */
export async function checkPageAssets(probe: HttpProbe, at: { ip: string; host: string; pageUrl: string; path: string }): Promise<AssetCheck> {
  let html: string;
  try {
    html = (await probe({ ip: at.ip, host: at.host, path: proxyRequestPath(at.path), timeoutMs: 5000, maxBodyBytes: 65536 })).body;
  } catch (e) {
    return { attempted: 0, checked: 0, truncated: false, totalFound: 0, failed: [], restricted: [], unchecked: [], error: safe((e as Error).message) };
  }
  const { urls, truncated, totalFound } = extractAssetUrls(html, at.pageUrl);
  const answers = await mapLimit(urls, ASSET_CONCURRENCY, (u) => probe({ ip: at.ip, host: at.host, path: u, timeoutMs: ASSET_TIMEOUT_MS, maxBodyBytes: 1 }));
  const prefix = proxyRequestPath(at.path);
  const failed: AssetCheck['failed'] = [];
  const restricted: AssetCheck['restricted'] = [];
  const unchecked: AssetCheck['unchecked'] = [];
  answers.forEach((a, i) => {
    const url = urls[i]!;
    if (a.status === 'rejected') {
      unchecked.push({ url, reason: safe(a.reason instanceof Error ? a.reason.message : String(a.reason)) });
      return;
    }
    const status = a.value.status;
    // `res.statusCode ?? 0` is how the transport says "no status line came back": not an answer.
    if (status === 0) {
      unchecked.push({ url, reason: 'no HTTP status' });
      return;
    }
    if (RESTRICTED_STATUSES.has(status)) restricted.push({ url, status });
    // A whole-site app owns every path, so nothing it references can be "outside" it.
    else if (assetIsBroken(status)) failed.push({ url, status, outsidePrefix: at.path !== '' && !url.startsWith(prefix) });
  });
  return { attempted: urls.length, checked: urls.length - unchecked.length, truncated, totalFound, failed, restricted, unchecked };
}

/**
 * The one sentence the asset check is entitled to: how many of how many answered, and — when the
 * page names more references than the cap allows — that the rest were never looked at. "All 12
 * assets answered" about a page naming thirty is the failure this wording exists to prevent.
 */
export function assetsAnswered(a: AssetCheck): string {
  const scope = `${a.truncated ? `the first ${a.attempted}` : `the ${a.attempted}`} assets the page references`;
  const more = a.truncated ? `; more were not checked (the page names ${a.totalFound})` : '';
  if (a.unchecked.length === 0) return a.truncated ? `${scope} answered${more}` : `all ${a.attempted} assets the page references answered`;
  return `${a.checked} of ${scope} answered${more}`;
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
 *
 * COVERAGE: no unit test reaches a real TLS socket — the tools inject a fake probe through
 * `ctx.httpProbe`, and the pure parts above are tested on their own. This function's coverage of
 * record is `test/e2e/milestone-c.e2e.test.ts`, which probes the live site over TLS; change it and
 * run that suite.
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
        const answer = (): ProbeResponse => ({ status: res.statusCode ?? 0, latencyMs: Date.now() - started, contentType: res.headers['content-type'] ?? null, body: collectCapped(chunks, req.maxBodyBytes).body, certificate, location: res.headers['location'] ?? null });
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
