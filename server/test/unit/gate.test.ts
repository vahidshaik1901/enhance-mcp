import { describe, expect, it } from 'vitest';
import { ConfirmationGate, GateError } from '../../src/core/gate.js';

const target = { kind: 'website' as const, id: '6106382b-143f-4d24-9bea-0e9368ad2a1f', name: 'vahi.dev' };

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
  });

  it('rejects tampered or foreign tokens', () => {
    const a = new ConfirmationGate({ now: () => 0 });
    const b = new ConfirmationGate({ now: () => 0 });
    const token = a.issue('website_delete', target, {});
    expect(() => b.verify(token, 'vahi.dev')).toThrow(GateError);
    const [nonce, exp] = token.split('.');
    expect(() => a.verify(`${nonce}.${exp}.AAAA`, 'vahi.dev')).toThrow(GateError);
    expect(() => a.verify('garbage', 'vahi.dev')).toThrow(GateError);
  });

  it('matches names case-insensitively and never a UUID', () => {
    expect(ConfirmationGate.matches(target, 'Vahi.Dev')).toBe(true);
    expect(ConfirmationGate.matches(target, '')).toBe(false);
    expect(ConfirmationGate.matches(target, target.id)).toBe(false);
  });
});
