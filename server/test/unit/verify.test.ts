import { describe, expect, it } from 'vitest';
import { EnhanceApiError } from '../../src/client/errors.js';
import { confirmedByReadNote, describeError, isDefiniteRefusal, unknownOutcome, writeThenVerify } from '../../src/core/verify.js';

const noSleep = async (): Promise<void> => undefined;

describe('writeThenVerify', () => {
  it('reports a normal answer as landed by the response and never re-reads', async () => {
    let finds = 0;
    const o = await writeThenVerify({ write: async () => ({ id: 'x' }), find: async () => { finds += 1; return 'y'; }, sleep: noSleep });
    expect(o).toEqual({ state: 'landed', confirmedBy: 'response', written: { id: 'x' } });
    expect(finds).toBe(0);
  });

  it('rethrows a 4xx unchanged: the panel refused, so nothing landed and nothing is re-read', async () => {
    const refusal = new EnhanceApiError(409, 'already_exists', 'exists', 'POST', '/x');
    let finds = 0;
    await expect(writeThenVerify({ write: async () => { throw refusal; }, find: async () => { finds += 1; return 'y'; }, sleep: noSleep })).rejects.toBe(refusal);
    expect(finds).toBe(0);
  });

  it.each([
    ['a 5xx', new EnhanceApiError(502, 'http_502', undefined, 'POST', '/x'), /HTTP 502/],
    ['a network error', new TypeError('fetch failed'), /fetch failed/],
    ['the client timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError'), /client stopped waiting/],
  ])('treats %s as unclear and re-reads until the object shows up', async (_label, error, wording) => {
    let finds = 0;
    const o = await writeThenVerify({ write: async () => { throw error; }, find: async () => (++finds === 3 ? 'found-it' : undefined), sleep: noSleep });
    expect(o).toMatchObject({ state: 'landed', confirmedBy: 'verify', found: 'found-it' });
    expect(o.state === 'landed' && o.confirmedBy === 'verify' ? o.writeError : '').toMatch(wording);
    expect(finds).toBe(3);
  });

  it('gives up as unknown after ceil(window / interval) reads, the first one immediate', async () => {
    const pauses: number[] = [];
    let finds = 0;
    const o = await writeThenVerify({ write: async () => { throw new TypeError('fetch failed'); }, find: async () => { finds += 1; return undefined; }, windowMs: 10_000, intervalMs: 2_000, sleep: async (ms) => { pauses.push(ms); } });
    expect(o).toEqual({ state: 'unknown', writeError: 'fetch failed' });
    expect(finds).toBe(5);
    expect(pauses).toEqual([2000, 2000, 2000, 2000]);
  });

  it('keeps re-reading through a failing read and reports the last failure', async () => {
    let finds = 0;
    const o = await writeThenVerify({ write: async () => { throw new TypeError('fetch failed'); }, find: async () => { finds += 1; throw new EnhanceApiError(500, 'http_500', 'listing down', 'GET', '/y'); }, windowMs: 4_000, intervalMs: 2_000, sleep: noSleep });
    expect(finds).toBe(2);
    expect(o).toEqual({ state: 'unknown', writeError: 'fetch failed', verifyError: 'HTTP 500 http_500: listing down' });
  });

  it('forgets a read failure once a later read answers cleanly', async () => {
    let finds = 0;
    const o = await writeThenVerify({ write: async () => { throw new TypeError('fetch failed'); }, find: async () => { finds += 1; if (finds === 1) throw new TypeError('reset'); return undefined; }, windowMs: 4_000, intervalMs: 2_000, sleep: noSleep });
    expect(o).toEqual({ state: 'unknown', writeError: 'fetch failed' });
  });

  it('reads at least once even with a zero window', async () => {
    let finds = 0;
    await writeThenVerify({ write: async () => { throw new TypeError('x'); }, find: async () => { finds += 1; return undefined; }, windowMs: 0, sleep: noSleep });
    expect(finds).toBe(1);
  });
});

describe('isDefiniteRefusal / describeError', () => {
  it('counts only a 4xx panel answer as a refusal', () => {
    expect(isDefiniteRefusal(new EnhanceApiError(400, 'invalid', undefined, 'POST', '/x'))).toBe(true);
    expect(isDefiniteRefusal(new EnhanceApiError(429, 'http_429', undefined, 'POST', '/x'))).toBe(true);
    expect(isDefiniteRefusal(new EnhanceApiError(500, 'http_500', undefined, 'POST', '/x'))).toBe(false);
    expect(isDefiniteRefusal(new TypeError('fetch failed'))).toBe(false);
  });

  it('collapses a newline an error message carries, so it cannot forge a line', () => {
    expect(describeError(new Error('boom\nforged: line'))).toBe('boom forged: line');
  });
});

describe('unknownOutcome / confirmedByReadNote', () => {
  it('leads with the identity block, says UNKNOWN, forbids a retry and names the settling read', () => {
    const r = unknownOutcome('org: Test (o1)', { writeError: 'no answer before the client stopped waiting' }, { action: 'the create of website shop.example', settle: 'domain_check domain=shop.example', windowMs: 90_000 }, { created: null });
    expect(r.isError).toBe(true);
    expect(r.text.split('\n')[0]).toBe('org: Test (o1)');
    expect(r.text).toContain('OUTCOME UNKNOWN');
    expect(r.text).toContain('90 s of re-reading');
    expect(r.text).toContain('Do not retry yet. Run domain_check domain=shop.example first');
    expect(r.text).not.toMatch(/failed to create|was not created/);
    expect(r.structured).toEqual({ outcome: 'unknown', writeError: 'no answer before the client stopped waiting', created: null });
  });

  it('names the last read failure and appends the extra line when given', () => {
    const r = unknownOutcome('org: T (o)', { writeError: 'HTTP 502 http_502', verifyError: 'HTTP 500 http_500' }, { action: 'x', settle: 'y', windowMs: 10_000, extra: 'One more thing.' });
    expect(r.text).toContain('the last re-read failed: HTTP 500 http_500');
    expect(r.text.split('\n').at(-1)).toBe('One more thing.');
    expect(r.structured).toMatchObject({ verifyError: 'HTTP 500 http_500' });
  });

  it('says a read-confirmed write did land', () => {
    expect(confirmedByReadNote('HTTP 502 http_502')).toBe("the panel's answer was unclear (HTTP 502 http_502), so this was confirmed by reading it back: it did land.");
  });
});
