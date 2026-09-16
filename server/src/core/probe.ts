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
