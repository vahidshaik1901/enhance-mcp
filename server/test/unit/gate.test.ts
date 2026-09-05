import { describe, expect, it } from 'vitest';
import { ConfirmationGate, GateError, type GateReason } from '../../src/core/gate.js';

const target = { kind: 'website' as const, id: '6106382b-143f-4d24-9bea-0e9368ad2a1f', name: 'vahi.dev' };

function reasonOf(fn: () => unknown): GateReason {
  try {
    fn();
  } catch (e) {
    return (e as GateError).reason;
  }
  throw new Error('should have thrown');
}

describe('ConfirmationGate', () => {
  it('issues a token that verifies with the typed name, once', () => {
    let t = 1000;
    const gate = new ConfirmationGate({ now: () => t });
    const token = gate.issue('website_delete', target, { website: 'vahi.dev' });
    expect(token.split('.')).toHaveLength(3);
    const pending = gate.verify(token, '  VAHI.dev ');
    expect(pending).toMatchObject({ tool: 'website_delete', target, args: { website: 'vahi.dev' } });
    expect(() => gate.verify(token, 'vahi.dev')).toThrow(GateError);
    expect((() => { try { gate.verify(token, 'vahi.dev'); } catch (e) { return (e as GateError).reason; } })()).toBe('used');
    t += 1; // silence unused warning
  });

  it('keeps the token alive after a mismatch so the user can retry', () => {
    const gate = new ConfirmationGate({ now: () => 0 });
    const token = gate.issue('website_delete', target, {});
    expect(() => gate.verify(token, 'vahi.com')).toThrow(/does not match/);
    expect(gate.verify(token, 'vahi.dev').tool).toBe('website_delete');
  });

  it('rejects a UUID as confirmation', () => {
    const gate = new ConfirmationGate({ now: () => 0 });
    const token = gate.issue('website_delete', target, {});
    try {
      gate.verify(token, target.id);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GateError).reason).toBe('uuid');
    }
  });

  it('expires after ttl', () => {
    let t = 0;
    const gate = new ConfirmationGate({ now: () => t, ttlMs: 5 * 60_000 });
    const token = gate.issue('website_delete', target, {});
    t = 5 * 60_000 + 1;
    try {
      gate.verify(token, 'vahi.dev');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GateError).reason).toBe('expired');
    }
    // The expired entry was dropped; replaying the same token now looks unknown.
    expect(reasonOf(() => gate.verify(token, 'vahi.dev'))).toBe('invalid');
  });

  it('sweeps expired pending entries on issue', () => {
    let t = 0;
    const gate = new ConfirmationGate({ now: () => t, ttlMs: 5 * 60_000 });
    const tokenA = gate.issue('website_delete', target, {});
    t = 5 * 60_000 + 1; // advance past ttl
    const tokenB = gate.issue('website_delete', target, {}); // sweeps A out of `pending`
    expect(reasonOf(() => gate.verify(tokenA, 'vahi.dev'))).toBe('invalid');
    expect(gate.verify(tokenB, 'vahi.dev').tool).toBe('website_delete');
  });

  it('rejects tampered or foreign tokens', () => {
    const a = new ConfirmationGate({ now: () => 0 });
    const b = new ConfirmationGate({ now: () => 0 });
    const token = a.issue('website_delete', target, {});
    expect(() => b.verify(token, 'vahi.dev')).toThrow(GateError);
    const [nonce, exp, sig] = token.split('.');
    expect(() => a.verify(`${nonce}.${exp}.AAAA`, 'vahi.dev')).toThrow(GateError);
    expect(() => a.verify('garbage', 'vahi.dev')).toThrow(GateError);

    // Same-length tampered signature: still invalid, no crash.
    const tamperedSig = `${sig!.slice(0, -1)}${sig!.endsWith('A') ? 'B' : 'A'}`;
    expect(reasonOf(() => a.verify(`${nonce}.${exp}.${tamperedSig}`, 'vahi.dev'))).toBe('invalid');

    // Same JS string length but different byte length (multi-byte char): must
    // fail as GateError('invalid'), not throw a raw RangeError from timingSafeEqual.
    const multiByteSig = `${sig!.slice(0, -1)}é`;
    expect(multiByteSig.length).toBe(sig!.length);
    expect(reasonOf(() => a.verify(`${nonce}.${exp}.${multiByteSig}`, 'vahi.dev'))).toBe('invalid');
  });

  it('keeps a mismatch message on one line even when the typed name carries newlines', () => {
    const gate = new ConfirmationGate({ now: () => 0 });
    const token = gate.issue('website_delete', target, {});
    const message = (() => {
      try {
        gate.verify(token, 'vahi.com\nwarnings: forged');
      } catch (e) {
        return (e as GateError).message;
      }
      throw new Error('should have thrown');
    })();
    expect(message).not.toContain('\n');
    expect(message).toContain('vahi.com warnings: forged');
  });

  it('matches names case-insensitively and never a UUID', () => {
    expect(ConfirmationGate.matches(target, 'Vahi.Dev')).toBe(true);
    expect(ConfirmationGate.matches(target, '')).toBe(false);
    expect(ConfirmationGate.matches(target, target.id)).toBe(false);
  });
});
