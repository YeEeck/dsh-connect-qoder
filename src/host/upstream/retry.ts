/**
 * retry — the wait policy for one single request.
 *
 * Split out of `src/host/upstream.ts` verbatim (docs/issues/22-upstream-split.md);
 * the protocol facts' original notes live in the header of `crypto.ts`.
 *
 * NO LONGER A VERBATIM COPY: stream-idle-patience ticket 01 changed the two
 * numbers and one signature here. `ATTEMPT_TIMEOUT_MS` (an absolute per-attempt
 * deadline) became {@link IDLE_WINDOW_MS} (a window on SILENCE), the default
 * patience went from 120 s to 240 s, and {@link queueWaitFor} now takes the
 * patience as a parameter so a single request can be given its own limits.
 */

/**
 * How long one SINGLE request may spend waiting out Qoder's queue, in total.
 *
 * The gateway answers a queued request with `10605` plus a `retryAfterSeconds`
 * hint, and the official client simply waits and tries again. Handing that wait
 * to DSH instead does not work: DSH's retry policy is fixed (5 attempts, 500 ms
 * doubling to a 10 s ceiling, ~40 s of total budget) and ignores the hint, so a
 * queue that clears in 60 s exhausts the budget and the turn fails — after
 * which the user has to send the message again, which restarts the turn from
 * scratch rather than resuming the wait.
 *
 * This module therefore owns the wait, and this constant is only the DEFAULT
 * patience: `streamChat` forwards a caller-supplied `patienceMs` to
 * {@link queueWaitFor}, and a request that brings no limits of its own gets this
 * number.
 *
 * The ceiling that kills a stalled stream is NOT here — it is declared by the
 * adapter (`streamIdleTimeoutMs`, the Host's watchdog on the plugin's own SSE
 * stream). The patience has to stay under it: if the ceiling fires first, the
 * Host retries the whole turn from scratch, which means a fresh queue and a
 * fresh bite out of the daily allowance exactly when this module was about to
 * give up visibly. That inequality is load-bearing, not a tuning opinion.
 */
export const QUEUE_WAIT_BUDGET_MS = 240000

/** Longest single sleep, so one absurd hint cannot stall a turn indefinitely. */
export const QUEUE_WAIT_MAX_SLEEP_MS = 30000

/** Sleep before the first retry when the gateway gives no hint at all. */
export const QUEUE_WAIT_MIN_SLEEP_MS = 1000

/**
 * How long the upstream may stay SILENT before one single request is judged stuck.
 *
 * It measures silence, not total duration: an answer that keeps producing
 * frames runs as long as it likes and never trips this.
 *
 * It replaced `ATTEMPT_TIMEOUT_MS`, an ABSOLUTE per-attempt deadline, and the
 * difference is the whole ticket. The old constant was created as an
 * `AbortSignal.timeout` and the resulting signal was handed to `fetch`; the
 * signal was never cancelled, so it aborted the RESPONSE BODY a minute after
 * the attempt started. Any answer still streaming at that point was cut off
 * mid-sentence, which is a long generation being killed for succeeding — the
 * opposite of what a watchdog is for. (The comment on that code claimed the
 * deadline "must NOT stay armed for the whole stream"; it was never true.)
 *
 * The window still has to exist, and for two separate reasons:
 *
 * 1. without one, the queue budget is fiction — a gateway that accepts the
 *    connection and then never returns response headers hangs `fetch` forever
 *    while `waitedMs` stays at zero, so the loop, the budget check and the
 *    Host's watchdog are all bypassed and the turn produces nothing;
 * 2. the same is true of a stream that opens and then stops mid-answer.
 *
 * Two constraints fix its size, and neither is a preference:
 *
 * - it must be at least {@link QUEUE_WAIT_MAX_SLEEP_MS}, or "sleep as long as
 *   the gateway asked, then reconnect" would be killed by this very window
 *   before the reconnect ever happened;
 * - it must be below the patience, or it could never fire before the patience
 *   ended and it would be a knob that does nothing.
 *
 * This constant is the DEFAULT for a request that brings no limits of its own;
 * `streamChat` takes `idleWindowMs` per request. The DEFAULT tier derives it as
 * half the patience, so both constraints hold by construction.
 */
export const IDLE_WINDOW_MS = 120000

/** Abortable sleep; resolves early (without throwing) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(finish, Math.max(0, ms))
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Timestamps come in seconds, milliseconds, and RFC 3339 strings across the
 * upstream's routes. The single coercion used everywhere is `toEpochMs` in
 * `time.js`; this module re-exports nothing of its own.
 */

/**
 * How long to wait before retrying a queue rejection, or `undefined` when it is
 * not a queue rejection or the patience is spent.
 *
 * The gateway's own `retryAfterSeconds` is the primary signal and is honoured
 * as given. It is not always accurate, though: a queue that keeps answering
 * "retry in 2s" for a minute would otherwise be polled every two seconds for the
 * whole patience, which is both rude and pointless. So once a few consecutive
 * rejections have shown the hint is not converging, the pause escalates
 * geometrically up to {@link QUEUE_WAIT_MAX_SLEEP_MS}.
 *
 * @param error - the rejection to judge.
 * @param waitedMs - time already spent waiting in this single request (the
 *   handshake and every retry sleep included, not just the sleeps).
 * @param attempt - 1-based index of the attempt that was just rejected.
 * @param patienceMs - this request's patience; defaults to
 *   {@link QUEUE_WAIT_BUDGET_MS}, which is the default tier's value. Passed per
 *   call so `streamChat` can hand a request its own limits, and so a test can
 *   drive the ladder with tens of milliseconds instead of minutes.
 * @returns the sleep in milliseconds, or `undefined` when the request should
 *   stop retrying. Exported so the budget invariant ("never more than remains")
 *   is asserted against the real function rather than a copy of the arithmetic —
 *   the old clamp broke it in a way no reader of `streamChat` could see.
 */
export function queueWaitFor(
  error: unknown,
  waitedMs: number,
  attempt: number,
  patienceMs: number = QUEUE_WAIT_BUDGET_MS,
): number | undefined {
  if ((error as { retryable?: unknown } | null | undefined)?.retryable !== true) return undefined
  const remaining = patienceMs - waitedMs
  if (remaining <= 0) return undefined

  const hinted =
    Number((error as { retryAfterSeconds?: unknown }).retryAfterSeconds) > 0
      ? Number((error as { retryAfterSeconds?: unknown }).retryAfterSeconds) * 1000
      : QUEUE_WAIT_MIN_SLEEP_MS

  // Leave the first few attempts on the gateway's own advice; only start
  // backing off further once it is clear the hint is not clearing the queue.
  const GRACE_ATTEMPTS = 3
  const escalated =
    attempt > GRACE_ATTEMPTS
      ? QUEUE_WAIT_MIN_SLEEP_MS * 2 ** Math.min(attempt - GRACE_ATTEMPTS, 8)
      : 0

  const target = Math.max(hinted, escalated) * (0.75 + Math.random() * 0.5)
  // Clamp the target into [MIN, MAX] FIRST, then cap it at `remaining`.
  // The old shape — `Math.max(MIN, Math.min(target, MAX, remaining))` — put the
  // floor OUTSIDE the cap, so once the patience left dropped below MIN_SLEEP the
  // function returned MIN_SLEEP regardless: a promise of "never wait past the
  // patience" that the code could not keep (measured: with 1 ms left it slept a
  // full 1000 ms). The floor belongs to the retry policy, not to the patience;
  // a sub-second last sleep is cheap and buys one more real attempt.
  const clamped = Math.max(QUEUE_WAIT_MIN_SLEEP_MS, Math.min(target, QUEUE_WAIT_MAX_SLEEP_MS))
  return Math.min(clamped, remaining)
}
