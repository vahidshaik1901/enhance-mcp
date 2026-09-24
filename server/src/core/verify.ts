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
 * Both settled outcomes carry the re-reads that were actually made and the real time they took,
 * so a sentence about them never quotes a window the reads did not keep.
 *
 * A 4xx is not an outcome: it is the panel refusing, and `writeThenVerify` rethrows it unchanged so
 * the existing error mapping still explains it.
 */
export type WriteOutcome<W, T> =
  | { state: 'landed'; confirmedBy: 'response'; written: W }
  | { state: 'landed'; confirmedBy: 'verify'; found: T; writeError: string; reads: number; elapsedMs: number }
  | { state: 'unknown'; writeError: string; verifyError?: string; reads: number; elapsedMs: number };

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
   *
   * Only `undefined` means "not there yet". Any other value, `null`, `0` and `''` included, is a
   * find, so a caller whose read can yield such a value maps it to `undefined` itself; the check is
   * deliberately not `!= null`.
   */
  find: () => Promise<T | undefined>;
  /** How long to keep re-reading after an unclear write, on the real clock. */
  windowMs?: number;
  /** Pause between two re-reads. */
  intervalMs?: number;
  /** Test seam (`ToolContext.sleep`); production waits for real. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for the window's clock; production reads `Date.now`. Adopters leave it unset: the
   *  unit suite's `ctx.now` is a fixed instant, and its no-op sleep and instant fakes keep the real
   *  clock's elapsed time near zero, so the read count alone decides there. */
  now?: () => number;
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

/**
 * Re-reads until the object shows up, bounded two ways. The read count, `ceil(windowMs / intervalMs)`
 * with the first read immediate, is the upper bound: a test with a no-op sleep pins it exactly, and
 * a frozen test clock can never make the loop spin forever. The real clock is the other bound: one
 * read can take the client's whole 30 s timeout (and a GET is retried on a 5xx or a reset), so
 * counting alone let a struggling panel hold website_create for about ten minutes behind its 90 s
 * window (the final review's simulation, ~625 s). So no read starts once the window has passed,
 * and the wait is at most the window plus the one read in flight.
 */
async function settle<W, T>(opts: WriteThenVerifyOptions<W, T>, writeError: string): Promise<WriteOutcome<W, T>> {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const intervalMs = Math.max(1, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const maxReads = Math.max(1, Math.ceil(windowMs / intervalMs));
  const start = now();
  const deadline = start + windowMs;
  let reads = 0;
  let verifyError: string | undefined;
  for (let i = 0; i < maxReads; i += 1) {
    if (i > 0) {
      // Checked before the pause, so no time is spent waiting for a read that will not be made,
      // and after it, so no read starts past the window.
      if (now() >= deadline) break;
      await sleep(intervalMs);
      if (now() >= deadline) break;
    }
    reads += 1;
    try {
      const found = await opts.find();
      if (found !== undefined) return { state: 'landed', confirmedBy: 'verify', found, writeError, reads, elapsedMs: now() - start };
      verifyError = undefined;
    } catch (e) {
      verifyError = describeError(e);
    }
  }
  const elapsedMs = now() - start;
  return verifyError === undefined ? { state: 'unknown', writeError, reads, elapsedMs } : { state: 'unknown', writeError, verifyError, reads, elapsedMs };
}

export interface UnknownOutcomeWording {
  /** What was attempted, already sanitised: `the create of website shop.example`. */
  action: string;
  /** The read that settles it, already sanitised: `domain_check domain=shop.example`. */
  settle: string;
  /** One more line for the caller, e.g. what happened to a password or to the other lines. */
  extra?: string;
}

/** `18 re-reads over 92 s`, `1 re-read within 1 s`: what the settling loop really did. */
function rereadSpan(reads: number, elapsedMs: number): string {
  const count = `${reads} re-read${reads === 1 ? '' : 's'}`;
  const seconds = Math.round(elapsedMs / 1000);
  return seconds < 1 ? `${count} within 1 s` : `${count} over ${seconds} s`;
}

/** The one way every create says "unknown": never "failed", never "not created", always "do not
 *  retry yet" and always the read that settles it. */
export function unknownOutcome(identity: string, o: { writeError: string; verifyError?: string; reads: number; elapsedMs: number }, w: UnknownOutcomeWording, structured: Record<string, unknown> = {}): ToolResult {
  const lines = [
    identity,
    `OUTCOME UNKNOWN: the panel gave no clear answer to ${w.action} (${o.writeError}), and ${rereadSpan(o.reads, o.elapsedMs)} did not find it${o.verifyError ? ` (the last re-read failed: ${o.verifyError})` : ''}. It may still land: the panel can keep working after the client stops waiting.`,
    `Do not retry yet. Run ${w.settle} first: retrying a create that did land makes a duplicate or fails with "already exists".`,
  ];
  if (w.extra) lines.push(w.extra);
  return fail(lines.join('\n'), { outcome: 'unknown', writeError: o.writeError, ...(o.verifyError ? { verifyError: o.verifyError } : {}), reads: o.reads, elapsedMs: o.elapsedMs, ...structured });
}

/** The line a success carries when a re-read, not the panel's answer, proved the write landed. */
export function confirmedByReadNote(writeError: string): string {
  return `the panel's answer was unclear (${writeError}), so this was confirmed by reading it back: it did land.`;
}
