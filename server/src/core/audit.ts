import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GateMechanism } from './gate.js';
import type { Risk, Target } from './registry.js';

export interface AuditEntry {
  ts: string;
  tool: string;
  risk: Risk;
  target?: Target;
  args: Record<string, unknown>;
  outcome: 'ok' | 'error' | 'cancelled';
  status?: number;
  durationMs: number;
  gate: GateMechanism;
  message?: string;
}

// `key` on its own is not a secret name here: ssh_key_remove's `key` argument is a key id, name
// or fingerprint, and stays readable so the audit trail says which key went. The key material
// itself travels under `public_key` / `private_key`.
const SECRET_KEYS = new Set(['password', 'token', 'secret', 'public_key', 'private_key', 'apikey', 'api_key', 'mailboxpassword', 'adminpassword', 'cookie', 'authorization']);

/** A PEM private key pasted into any argument, whatever the argument is called. */
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY/;

/** Longest string argument written verbatim. `db_import_sql`'s `sql` (and any future large
 *  payload) would otherwise land in ~/.enhance-mcp/audit.jsonl in full; the audit trail only needs
 *  to say that a payload of that size went, not what was in it. Redaction still wins over elision,
 *  so an oversized secret is never merely summarised. */
const MAX_STRING = 512;

export function redact(value: unknown, secrets: string[]): unknown {
  const live = secrets.filter((s) => s.length >= 5);
  if (typeof value === 'string') {
    if (PRIVATE_KEY_RE.test(value) || live.some((s) => value.includes(s))) return '[redacted]';
    return value.length > MAX_STRING ? `[elided ${value.length} chars]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v, secrets)]));
  }
  return value;
}

function defaultWrite(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, line, { mode: 0o600 });
}

export class AuditLog {
  constructor(
    private readonly path: string,
    private readonly secrets: string[],
    private readonly write: (path: string, line: string) => void = defaultWrite,
  ) {}

  append(entry: Omit<AuditEntry, 'ts'>): void {
    try {
      const redacted = redact(entry, this.secrets) as Record<string, unknown>;
      const line = JSON.stringify({ ts: new Date().toISOString(), ...redacted });
      this.write(this.path, `${line}\n`);
    } catch (e) {
      console.error(`audit: could not write ${this.path}: ${(e as Error).message}`);
    }
  }
}
