import { EnhanceApiError } from '../client/errors.js';
import type { ToolResult } from './registry.js';
import { fail, safe } from './respond.js';

/**
 * What a create's one request turned out to be.
 *
 * - `landed` / `response`: the panel answered 2xx; `written` is its answer.
 * - `landed` / `verify`: the answer was unclear, and a re-read found the object this call made.
 * - `unknown`: the answer was unclear and the re-reads never found it. It may still land.
 *
 * A 4xx is not an outcome: it is the panel refusing, and `writeThenVerify` rethrows it unchanged so
 * the existing error mapping still explains it.
 */
export type WriteOutcome<W, T> =
  | { state: 'landed'; confirmedBy: 'response'; written: W }
  | { state: 'landed'; confirmedBy: 'verify'; found: T; writeError: string }
  | { state: 'unknown'; writeError: string; verifyError?: string };

export interface WriteThenVerifyOptions<W, T> {
  /** The one request that creates the object. Called exactly once and never retried here: the
   *  panel has no idempotency keys, so a blind retry of a create that landed is the very bug this
   *  module exists to prevent (live 2026-09-17: two website creates "timed out" and landed). */
  write: () => Promise<W>;
  /**
   * Called only after an UNCLEAR write: a cheap read returning the object THIS call created, or
   * undefined while it is not there. It must never match an object that existed before the write,
   * and each caller guarantees that one of three ways: it refuses up front when the object exists,
   * it excludes what a snapshot taken before the write already held, or it writes a slot nothing
   * else can hold (a crontab line past the last one).
   */
  find: () => Promise<T | undefined>;
  /** How long to keep re-reading after an unclear write. */
  windowMs?: number;
  /** Pause between two re-reads. */
  intervalMs?: number;
  /** Test seam (`ToolContext.sleep`); production waits for real. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_WINDOW_MS = 10_000;
export const DEFAULT_INTERVAL_MS = 2_000;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A 4xx is the panel refusing the request (400 invalid, 404 unknown parent, 409 exists, 429 not
 *  processed): nothing landed. A 5xx is not a refusal: the panel says "error" about work it may
 *  well have finished, so it is settled by reading, like a timeout. */
export function isDefiniteRefusal(e: unknown): boolean {
  return e instanceof EnhanceApiError && e.status >= 400 && e.status < 500;
}

/** One sanitised clause for a failed request, to sit inside "(…)" in a sentence. */
export function describeError(e: unknown): string {
  if (e instanceof EnhanceApiError) return `HTTP ${e.status} ${safe(e.code)}${e.apiMessage ? `: ${safe(e.apiMessage)}` : ''}`;
  // `AbortSignal.timeout` rejects with a DOMException named TimeoutError, an explicit abort with an
  // AbortError; the message ("The operation was aborted due to timeout") reads like a failure, and
  // it is not one: the request may still be running on the panel.
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
  if (name === 'TimeoutError' || name === 'AbortError') return 'no answer before the client stopped waiting';
  if (e instanceof Error) return safe(e.message);
  return safe(String(e));
}

/**
 * Sends a create and settles what happened to it. A landed create is never reported as an error,
 * and an unclear one is never reported as a failure: see `WriteOutcome`.
 */
export async function writeThenVerify<W, T>(opts: WriteThenVerifyOptions<W, T>): Promise<WriteOutcome<W, T>> {
  let written: W;
  try {
    written = await opts.write();
  } catch (e) {
    if (isDefiniteRefusal(e)) throw e;
    return settle(opts, describeError(e));
  }
  return { state: 'landed', confirmedBy: 'response', written };
}

/** Counts reads rather than watching a clock: a test with a no-op sleep pins the number exactly,
 *  and a frozen test clock can never make the loop spin forever. */
async function settle<W, T>(opts: WriteThenVerifyOptions<W, T>, writeError: string): Promise<WriteOutcome<W, T>> {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const intervalMs = Math.max(1, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const sleep = opts.sleep ?? realSleep;
  const reads = Math.max(1, Math.ceil(windowMs / intervalMs));
  let verifyError: string | undefined;
  for (let i = 0; i < reads; i += 1) {
    if (i > 0) await sleep(intervalMs);
    try {
      const found = await opts.find();
      if (found !== undefined) return { state: 'landed', confirmedBy: 'verify', found, writeError };
      verifyError = undefined;
    } catch (e) {
      verifyError = describeError(e);
    }
  }
  return verifyError === undefined ? { state: 'unknown', writeError } : { state: 'unknown', writeError, verifyError };
}

export interface UnknownOutcomeWording {
  /** What was attempted, already sanitised: `the create of website shop.example`. */
  action: string;
  /** The read that settles it, already sanitised: `domain_check domain=shop.example`. */
  settle: string;
  /** The window the re-reads covered, for the sentence. */
  windowMs: number;
  /** One more line for the caller, e.g. what happened to a password or to the other lines. */
  extra?: string;
}

/** The one way every create says "unknown": never "failed", never "not created", always "do not
 *  retry yet" and always the read that settles it. */
export function unknownOutcome(identity: string, o: { writeError: string; verifyError?: string }, w: UnknownOutcomeWording, structured: Record<string, unknown> = {}): ToolResult {
  const seconds = Math.max(1, Math.round(w.windowMs / 1000));
  const lines = [
    identity,
    `OUTCOME UNKNOWN: the panel gave no clear answer to ${w.action} (${o.writeError}), and ${seconds} s of re-reading did not find it${o.verifyError ? ` (the last re-read failed: ${o.verifyError})` : ''}. It may still land: the panel can keep working after the client stops waiting.`,
    `Do not retry yet. Run ${w.settle} first: retrying a create that did land makes a duplicate or fails with "already exists".`,
  ];
  if (w.extra) lines.push(w.extra);
  return fail(lines.join('\n'), { outcome: 'unknown', writeError: o.writeError, ...(o.verifyError ? { verifyError: o.verifyError } : {}), ...structured });
}

/** The line a success carries when a re-read, not the panel's answer, proved the write landed. */
export function confirmedByReadNote(writeError: string): string {
  return `the panel's answer was unclear (${writeError}), so this was confirmed by reading it back: it did land.`;
}
