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

/**
 * The `curl --resolve <host>:443:<ip>` equivalent: TLS to the IP with the domain as SNI. The
 * certificate is inspected and REPORTED, not enforced (`rejectUnauthorized: false`), because a
 * new domain serves the panel's self-signed placeholder until Let's Encrypt issues and the tool
 * exists to verify a deploy before that. This is safe only because the probe is one-way and
 * secret-free: it never sends the panel credential, a cookie or any header beyond Host and
 * User-Agent, follows no redirects, and reads at most `maxBodyBytes` of a page the customer
 * publishes. Never reuse this transport for anything that carries a credential.
 */
export const httpsProbe: HttpProbe = (req) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const r = request(
      { host: req.ip, port: 443, servername: req.host, path: req.path, method: 'GET', headers: { host: req.host, 'user-agent': 'enhance-mcp/probe' }, rejectUnauthorized: false, timeout: req.timeoutMs },
      (res) => {
        const socket = res.socket as TLSSocket;
        const certificate = classifyCertificate(socket.getPeerCertificate?.() as CertLike | undefined, req.host, socket.authorized === true, socket.authorizationError ? String(socket.authorizationError) : undefined);
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size < req.maxBodyBytes) {
            chunks.push(c.subarray(0, req.maxBodyBytes - size));
            size += c.length;
          }
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, latencyMs: Date.now() - started, contentType: res.headers['content-type'] ?? null, body: Buffer.concat(chunks).toString('utf8'), certificate }));
        res.on('error', reject);
      },
    );
    r.on('timeout', () => r.destroy(new Error(`no response within ${req.timeoutMs} ms`)));
    r.on('error', reject);
    r.end();
  });
