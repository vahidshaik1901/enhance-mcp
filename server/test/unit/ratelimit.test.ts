import { describe, expect, it } from 'vitest';
import { EnhanceApiError } from '../../src/client/errors.js';
import { createLimiter, isIdempotent, withRetry } from '../../src/client/ratelimit.js';

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('createLimiter', () => {
  it('never runs more than `concurrency` at once', async () => {
    const clock = fakeClock();
    const limiter = createLimiter({ rps: 1000, concurrency: 2, now: clock.now, sleep: clock.sleep });
    let active = 0;
    let peak = 0;
    const job = () =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      });
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(peak).toBe(2);
  });

  it('spaces starts to respect rps', async () => {
    const clock = fakeClock();
    const limiter = createLimiter({ rps: 5, concurrency: 10, now: clock.now, sleep: clock.sleep });
    await Promise.all([1, 2, 3].map(() => limiter.run(async () => undefined)));
    // 5 rps => 200 ms between starts; second and third start must have waited
    expect(clock.sleeps.filter((ms) => ms > 0).length).toBeGreaterThanOrEqual(2);
  });
});

describe('withRetry', () => {
  it('treats only GET/HEAD/OPTIONS as idempotent', () => {
    expect(isIdempotent('get')).toBe(true);
    expect(isIdempotent('HEAD')).toBe(true);
    expect(isIdempotent('POST')).toBe(false);
    expect(isIdempotent('DELETE')).toBe(false);
  });

  it('retries a GET on 503 with 1s, 2s, 4s backoff then succeeds', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new EnhanceApiError(503, 'internal', undefined, 'GET', '/x');
        return 'ok';
      },
      'GET',
      { sleep: clock.sleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([1000, 2000]);
  });

  it('honours Retry-After on 429', async () => {
    const clock = fakeClock();
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new EnhanceApiError(429, 'rate_limited', undefined, 'GET', '/x', 3000);
        return 1;
      },
      'GET',
      { sleep: clock.sleep },
    );
    expect(clock.sleeps).toEqual([3000]);
  });

  it('gives up after 3 attempts', async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new EnhanceApiError(502, 'bad_gateway', undefined, 'GET', '/x');
        },
        'GET',
        { sleep: clock.sleep },
      ),
    ).rejects.toBeInstanceOf(EnhanceApiError);
    expect(calls).toBe(3);
  });

  it('never retries a POST, even on 503', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new EnhanceApiError(503, 'internal', undefined, 'POST', '/x');
        },
        'POST',
      ),
    ).rejects.toBeInstanceOf(EnhanceApiError);
    expect(calls).toBe(1);
  });

  it('never retries 4xx other than 429', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new EnhanceApiError(403, 'unauthorized', undefined, 'GET', '/x');
        },
        'GET',
      ),
    ).rejects.toBeInstanceOf(EnhanceApiError);
    expect(calls).toBe(1);
  });

  it('retries network errors (TypeError from fetch) on GET', async () => {
    const clock = fakeClock();
    let calls = 0;
    const v = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        return 'up';
      },
      'GET',
      { sleep: clock.sleep },
    );
    expect(v).toBe('up');
  });
});
