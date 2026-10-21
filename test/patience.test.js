/**
 * The three numbers a patience tier derives, and the inequality that holds
 * them together.
 *
 * Run: node --test test/patience.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * `docs/adr/0001-patience-knob-exposure.md` exposes ONE knob (排队耐心) and
 * derives the other two values from it — 空闲窗口 and 流空闲天花板. The
 * derivation is the whole design: it is what makes
 *
 *     空闲窗口 < 排队耐心 < 流空闲天花板
 *
 * (CONTEXT.md, 判定的先后) true by construction instead of by three literals
 * that happen to be ordered today.
 *
 * That inequality is load-bearing, and its failure mode is quiet in every
 * direction:
 *
 * - an idle window at or above the patience can never fire before the patience
 *   ends, so it is a knob that does nothing;
 * - a stream-idle ceiling at or below the patience lets the HOST's watchdog
 *   fire first, and `TIMEOUT` IS in `ROUTE_RETRY_POLICY`'s retryable set — so
 *   the turn the plugin was about to give up on VISIBLY (with a sentence saying
 *   how long it waited) is instead retried up to five times, each attempt
 *   starting the queue from zero and spending another bite of Qoder's daily
 *   allowance. The ADR calls this the most expensive of the four constraints.
 *
 * So this file does three separate jobs, and the third is not decoration:
 *
 * 1. the exact numbers, for all three tiers (they are user-visible through the
 *    card's labels and the failure sentences, so a silent drift is a lie);
 * 2. the INEQUALITY itself, asserted per tier — this is the test that stops
 *    somebody tuning one number later without re-deriving the others;
 * 3. the SHAPE of the derivation — idle is half the patience, the ceiling is
 *    the patience plus 60 s — asserted from the functions rather than from a
 *    second hardcoded table. A second table would pass the same assertions
 *    while proving nothing about the code, and would have to be edited by the
 *    very change it is supposed to catch.
 *
 * Plus the agreement with `retry.ts`: `streamChat`'s module defaults are what
 * a request with no limits gets, and they must BE the default tier's numbers or
 * "no setting" and "the default setting" would behave differently. The two
 * files are independent on purpose (the retry module must not import the tier
 * vocabulary), so the agreement is pinned here rather than by construction.
 *
 * The module is peer-free (see its header), so this runs under bare
 * `node --test` with no install and no mocks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_PATIENCE_TIER,
  PATIENCE_TIERS,
  limitsFor,
  patienceTierOf,
  streamIdleCeilingFor,
} from '../src/host/patience.ts'
import { IDLE_WINDOW_MS, QUEUE_WAIT_BUDGET_MS, QUEUE_WAIT_MAX_SLEEP_MS } from '../src/host/upstream.ts'

/** The numbers, written down once — the tiers in the order the card renders. */
const EXPECTED = [
  { tier: '2m', patienceMs: 120000, idleWindowMs: 60000, ceilingMs: 180000 },
  { tier: '4m', patienceMs: 240000, idleWindowMs: 120000, ceilingMs: 300000 },
  { tier: '6m', patienceMs: 360000, idleWindowMs: 180000, ceilingMs: 420000 },
]

test('every tier derives exactly the three published numbers', () => {
  // Pinned as a table rather than three loose assertions so a fourth tier
  // cannot be added without a line here — the vocabulary test in
  // test/patience-setting.test.js catches the list, this catches the numbers.
  assert.deepEqual(
    PATIENCE_TIERS.map((tier) => ({ tier, ...limitsFor(tier), ceilingMs: streamIdleCeilingFor(tier) })),
    EXPECTED,
  )
})

test('the derivation has its shape, not just its values', () => {
  // The ADR states two RULES, so they are re-derived here from the functions
  // instead of restated: idle = patience / 2, ceiling = patience + 60 s. If
  // someone replaced the division with a third per-tier table, the exact-value
  // test above would still pass while the property it exists for was gone.
  for (const tier of PATIENCE_TIERS) {
    const { patienceMs, idleWindowMs } = limitsFor(tier)
    assert.equal(idleWindowMs * 2, patienceMs, `${tier}: the idle window must be half the patience`)
    assert.equal(
      streamIdleCeilingFor(tier) - patienceMs,
      60000,
      `${tier}: the stream-idle ceiling must be the patience plus 60 s of slack`,
    )
  }
})

test('空闲窗口 < 排队耐心 < 流空闲天花板, for every tier', () => {
  // THE test of this ticket. Not "the three numbers are ordered in the file" —
  // the ordering of the VALUES the functions return, asserted for every tier
  // including the default, so tuning any single number fails here instead of
  // in production, where the symptom is an extra five retries and a spent
  // daily allowance with nothing on screen to explain it.
  for (const tier of PATIENCE_TIERS) {
    const { patienceMs, idleWindowMs } = limitsFor(tier)
    const ceiling = streamIdleCeilingFor(tier)
    assert.ok(
      idleWindowMs < patienceMs,
      `${tier}: the idle window (${idleWindowMs}) must stay BELOW the patience (${patienceMs}), ` +
        'or it can never fire and the knob does nothing',
    )
    assert.ok(
      patienceMs < ceiling,
      `${tier}: the patience (${patienceMs}) must stay BELOW the stream-idle ceiling (${ceiling}), ` +
        "or the HOST's watchdog fires first and retries the whole turn with a fresh patience",
    )
  }
  // The default tier is one of the three, so the loop covers it — stated
  // explicitly because "the default was the one tier nobody asserted" is
  // exactly the gap a loop over a list invites.
  assert.ok(PATIENCE_TIERS.includes(DEFAULT_PATIENCE_TIER), 'the default tier must be in the list the loop walks')
})

test('the idle window also clears the longest single queue sleep', () => {
  // The OTHER constraint on the window, and the one that has nothing to do
  // with the tier: "sleep as long as the gateway asked, then reconnect" must
  // not be killed by this very window before the reconnect happens. It holds
  // for the smallest tier by a factor of two, so the derivation cannot be
  // tuned below it by shrinking the patience alone.
  for (const tier of PATIENCE_TIERS) {
    assert.ok(
      limitsFor(tier).idleWindowMs >= QUEUE_WAIT_MAX_SLEEP_MS,
      `${tier}: the idle window must not be shorter than one max sleep (${QUEUE_WAIT_MAX_SLEEP_MS})`,
    )
  }
})

test('the default tier and retry.ts module defaults cannot drift', () => {
  // Two independent modules publish the same two numbers, on purpose:
  // `retry.ts` must keep working (and stay importable) without the tier
  // vocabulary, and `patience.ts` must stay free of the upstream layer. The
  // consequence is that "no tier saved" (module defaults) and "the default
  // tier saved" (derived) are two code paths that have to agree by hand —
  // so a test is the only thing holding them together.
  //
  // If this fails, decide which side is right and change BOTH — relaxing the
  // assertion would leave the two paths free to disagree in production.
  const defaults = limitsFor(DEFAULT_PATIENCE_TIER)
  assert.equal(
    defaults.patienceMs,
    QUEUE_WAIT_BUDGET_MS,
    `patience.ts derives ${defaults.patienceMs} ms for the default tier but retry.ts defaults to ${QUEUE_WAIT_BUDGET_MS} ms`,
  )
  assert.equal(
    defaults.idleWindowMs,
    IDLE_WINDOW_MS,
    `patience.ts derives ${defaults.idleWindowMs} ms for the default tier but retry.ts defaults to ${IDLE_WINDOW_MS} ms`,
  )
  // The ceiling has no module-level twin to compare with — the adapter's
  // fallback is deliberately a literal (see adapter.ts) — but it must still be
  // the default tier's number, or a plugin that never got the resolver would
  // declare a ceiling that does not match the request path's patience.
  assert.equal(streamIdleCeilingFor(DEFAULT_PATIENCE_TIER), 300000)
})

test('a stored value that is not a tier derives the DEFAULT tier numbers', () => {
  // The read side is asserted in test/patience-setting.test.js (the flag, the
  // absent/null/shell cases); this is the derivation's half of the same fact,
  // and it is not the same assertion: a garbage stored value must not merely
  // resolve to a usable tier, it must resolve to the numbers this file has
  // just pinned — otherwise a hand-edited settings file would quietly run on
  // some third set of timeouts that nothing derives and nothing tests.
  const resolution = patienceTierOf({ patienceTier: '5m' })
  assert.deepEqual(resolution, { tier: DEFAULT_PATIENCE_TIER, invalid: true })
  assert.deepEqual(limitsFor(resolution.tier), limitsFor(DEFAULT_PATIENCE_TIER))
  assert.equal(streamIdleCeilingFor(resolution.tier), streamIdleCeilingFor(DEFAULT_PATIENCE_TIER))
})
