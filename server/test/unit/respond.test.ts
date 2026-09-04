import { describe, expect, it } from 'vitest';
import { fail, kv, ok, table } from '../../src/core/respond.js';

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
});
