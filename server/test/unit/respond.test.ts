import { describe, expect, it } from 'vitest';
import { fail, kv, ok, safe, table } from '../../src/core/respond.js';

describe('respond', () => {
  it('ok and fail set isError', () => {
    expect(ok('a', { b: 1 })).toEqual({ text: 'a', structured: { b: 1 } });
    expect(fail('boom')).toEqual({ text: 'boom', structured: undefined, isError: true });
  });
  it('kv skips empty values', () => {
    expect(kv([['a', 1], ['b', undefined], ['c', null], ['d', 'x']])).toBe('a: 1\nd: x');
  });
  it('table aligns columns and renders arrays and nulls', () => {
    const out = table([{ domain: 'vahi.dev', kind: 'primary', n: null }, { domain: 'a.b', kind: 'alias', n: [1, 2] }], ['domain', 'kind', 'n']);
    expect(out.split('\n')).toEqual(['domain    kind     n', 'vahi.dev  primary  -', 'a.b       alias    1, 2']);
  });
  it('collapses control characters so a cell cannot forge extra output lines', () => {
    const out = table([{ a: 'x\ny', b: 'z' }], ['a', 'b']);
    expect(out.split('\n')).toEqual(['a    b', 'x y  z']);
  });
  it('collapses control characters in kv values', () => {
    expect(kv([['name', 'evil\nwarnings: fake']])).toBe('name: evil warnings: fake');
  });
  it('safe collapses control characters and handles empty/null', () => {
    expect(safe('a\tb')).toBe('a b');
    expect(safe(null)).toBe('-');
  });
});
