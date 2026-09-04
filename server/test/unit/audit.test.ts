import { describe, expect, it } from 'vitest';
import { AuditLog, redact } from '../../src/core/audit.js';

describe('redact', () => {
  it('masks secret-named keys and values containing a secret', () => {
    const out = redact({ website: 'vahi.dev', password: 'p', nested: { token: 't', note: 'contains SECRETVALUE here' }, list: ['SECRETVALUE', 'fine'], key_id: '0' }, ['SECRETVALUE']);
    expect(out).toEqual({ website: 'vahi.dev', password: '[redacted]', nested: { token: '[redacted]', note: '[redacted]' }, list: ['[redacted]', 'fine'], key_id: '0' });
  });
});

describe('AuditLog', () => {
  it('appends one redacted JSON line with a timestamp', () => {
    const lines: string[] = [];
    const log = new AuditLog('/x/audit.jsonl', ['tok'], (_p, line) => lines.push(line));
    log.append({ tool: 'website_delete', risk: 'destructive', target: { kind: 'website', id: 'id', name: 'vahi.dev' }, args: { website: 'vahi.dev', password: 'x' }, outcome: 'ok', durationMs: 12, gate: 'token' });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry['ts']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry['args']).toEqual({ website: 'vahi.dev', password: '[redacted]' });
    expect(lines[0]!.endsWith('\n')).toBe(true);
  });
});
