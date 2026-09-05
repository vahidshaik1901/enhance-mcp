import { EnhanceApiError } from './errors.js';

export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface LimiterOptions {
  rps?: number;
  concurrency?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createLimiter({ rps = 5, concurrency = 2, now = () => Date.now(), sleep = realSleep }: LimiterOptions = {}): Limiter {
  const minGapMs = 1000 / rps;
  let inFlight = 0;
  let lastStart = -Infinity;
  const waiters: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    while (inFlight >= concurrency) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    inFlight += 1;
    const nextStart = Math.max(now(), lastStart + minGapMs);
    lastStart = nextStart;
    const wait = nextStart - now();
    if (wait > 0) await sleep(wait);
  };

  const release = (): void => {
    inFlight -= 1;
    waiters.shift()?.();
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

export function isIdempotent(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function isRetryable(e: unknown): boolean {
  if (e instanceof EnhanceApiError) return e.status === 429 || e.status >= 500;
  return e instanceof TypeError; // undici/fetch network failure
}

export async function withRetry<T>(fn: () => Promise<T>, method: string, { attempts = 3, baseDelayMs = 1000, sleep = realSleep }: RetryOptions = {}): Promise<T> {
  const max = isIdempotent(method) ? attempts : 1;
  let lastError: unknown;
  for (let i = 0; i < max; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i === max - 1 || !isRetryable(e)) throw e;
      const retryAfter = e instanceof EnhanceApiError ? e.retryAfterMs : undefined;
      await sleep(retryAfter ?? baseDelayMs * 2 ** i);
    }
  }
  throw lastError;
}
