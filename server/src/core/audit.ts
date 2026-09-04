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

const SECRET_KEYS = new Set(['password', 'token', 'secret', 'key', 'apikey', 'api_key', 'mailboxpassword', 'adminpassword', 'cookie', 'authorization']);

export function redact(value: unknown, secrets: string[]): unknown {
  const live = secrets.filter((s) => s.length >= 5);
  if (typeof value === 'string') return live.some((s) => value.includes(s)) ? '[redacted]' : value;
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
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry, args: redact(entry.args, this.secrets) });
    try {
      this.write(this.path, `${line}\n`);
    } catch (e) {
      console.error(`audit: could not write ${this.path}: ${(e as Error).message}`);
    }
  }
}
