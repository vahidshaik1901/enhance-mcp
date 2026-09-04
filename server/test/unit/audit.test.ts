import { describe, expect, it, vi } from 'vitest';
import { AuditLog, redact } from '../../src/core/audit.js';

describe('redact', () => {
  it('masks secret-named keys and values containing a secret', () => {
    const out = redact({ website: 'vahi.dev', password: 'p', nested: { token: 't', note: 'contains SECRETVALUE here' }, list: ['SECRETVALUE', 'fine'], key_id: '0' }, ['SECRETVALUE']);
    expect(out).toEqual({ website: 'vahi.dev', password: '[redacted]', nested: { token: '[redacted]', note: '[redacted]' }, list: ['[redacted]', 'fine'], key_id: '0' });
  });

  it('only treats secrets of length >= 5 as redaction triggers', () => {
    expect(redact({ a: 'has tok inside', b: 'has LONGSECRET inside' }, ['tok', 'LONGSECRET'])).toEqual({ a: 'has tok inside', b: '[redacted]' });
  });
});

describe('AuditLog', () => {
  it('appends one redacted JSON line with a timestamp', () => {
    const lines: string[] = [];
    const log = new AuditLog('/x/audit.jsonl', ['SECRETVALUE'], (_p, line) => lines.push(line));
    log.append({
      tool: 'website_delete',
      risk: 'destructive',
      target: { kind: 'website', id: 'id', name: 'vahi.dev' },
      args: { website: 'vahi.dev', password: 'x' },
      outcome: 'ok',
      durationMs: 12,
      gate: 'token',
      message: 'panel said tok... Authorization: Bearer SECRETVALUE',
    });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry['ts']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry['args']).toEqual({ website: 'vahi.dev', password: '[redacted]' });
    expect(entry['message']).toBe('[redacted]');
    expect(lines[0]!.endsWith('\n')).toBe(true);
    expect(lines[0]!).not.toContain('SECRETVALUE');
  });

  it('does not throw on a non-serializable entry and logs the failure instead of writing', () => {
    const write = vi.fn();
    const log = new AuditLog('/x/audit.jsonl', [], write);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => log.append({ tool: 'website_delete', risk: 'destructive', args: { circular }, outcome: 'error', durationMs: 1, gate: 'none' })).not.toThrow();
      expect(write).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0]?.[0]).toContain('audit: could not write');
    } finally {
      errSpy.mockRestore();
    }
  });
});
