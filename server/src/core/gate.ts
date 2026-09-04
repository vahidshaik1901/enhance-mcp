import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Target } from './registry.js';
import { UUID_RE } from './resolver.js';

export type GateReason = 'invalid' | 'expired' | 'used' | 'mismatch' | 'uuid';

export class GateError extends Error {
  override name = 'GateError';
  constructor(
    readonly reason: GateReason,
    message: string,
  ) {
    super(message);
  }
}

export interface PendingAction {
  tool: string;
  target: Target;
  args: Record<string, unknown>;
  exp: number;
}

export type GateMechanism = 'elicitation' | 'token' | 'none';

export class ConfirmationGate {
  private readonly pending = new Map<string, PendingAction>();
  private readonly used = new Map<string, number>();
  private readonly secret: Buffer;
  private readonly now: () => number;
  readonly ttlMs: number;

  constructor(opts: { secret?: Buffer; now?: () => number; ttlMs?: number } = {}) {
    this.secret = opts.secret ?? randomBytes(32);
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
  }

  static matches(target: Target, typed: string): boolean {
    const t = typed.trim().toLowerCase();
    if (!t || UUID_RE.test(t)) return false;
    return t === target.name.trim().toLowerCase();
  }

  issue(tool: string, target: Target, args: Record<string, unknown>): string {
    this.sweep();
    const nonce = randomBytes(12).toString('base64url');
    const exp = this.now() + this.ttlMs;
    this.pending.set(nonce, { tool, target, args, exp });
    return `${nonce}.${exp}.${this.sign(nonce, exp, tool, target.id)}`;
  }

  verify(token: string, typedName: string): PendingAction {
    const parts = token.trim().split('.');
    if (parts.length !== 3) throw new GateError('invalid', 'Confirmation token is malformed.');
    const [nonce, expStr, sig] = parts as [string, string, string];
    if (this.used.has(nonce)) throw new GateError('used', 'This confirmation token was already used. Start the action again to get a new one.');
    const p = this.pending.get(nonce);
    // Sweep after capturing `p` locally so a token that is legitimately expired
    // right now still gets its specific 'expired' error below, rather than
    // being pruned out from under us and reported as merely 'invalid'.
    this.sweep();
    if (!p) throw new GateError('invalid', 'Unknown confirmation token. It may belong to a previous server session; start the action again.');
    const exp = Number(expStr);
    const expected = this.sign(nonce, exp, p.tool, p.target.id);
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (exp !== p.exp || sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      throw new GateError('invalid', 'Confirmation token failed verification.');
    }
    if (this.now() > exp) {
      this.pending.delete(nonce);
      throw new GateError('expired', 'Confirmation token expired (5 minutes). Start the action again to get a new one.');
    }
    if (UUID_RE.test(typedName.trim())) throw new GateError('uuid', `A UUID is not accepted as confirmation. Type the name exactly: ${p.target.name}`);
    if (!ConfirmationGate.matches(p.target, typedName)) {
      throw new GateError('mismatch', `"${typedName.trim()}" does not match the target name "${p.target.name}". The token is still valid; ask the user to type it exactly.`);
    }
    this.pending.delete(nonce);
    this.used.set(nonce, exp);
    return p;
  }

  /** Bounds the growth of `pending` and `used` by dropping stale entries. */
  private sweep(): void {
    const t = this.now();
    for (const [nonce, p] of this.pending) {
      if (p.exp < t) this.pending.delete(nonce);
    }
    for (const [nonce, exp] of this.used) {
      if (exp < t - this.ttlMs) this.used.delete(nonce);
    }
  }

  private sign(nonce: string, exp: number, tool: string, targetId: string): string {
    return createHmac('sha256', this.secret).update(`${nonce}|${exp}|${tool}|${targetId}`).digest('base64url');
  }
}
