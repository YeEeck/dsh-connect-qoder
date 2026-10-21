/**
 * The queue-patience tier: the one user-facing knob, and the only place its
 * vocabulary lives.
 *
 * WHY THIS MODULE EXISTS
 *
 * `docs/adr/0001-patience-knob-exposure.md` decided that the card exposes ONE
 * setting — the patience tier — and that the three numbers the request path
 * actually needs (the idle window, the patience, the stream-idle ceiling) are
 * DERIVED from it rather than configured. The derivation is what makes the
 * load-bearing inequality `idle window < patience < stream-idle ceiling`
 * (CONTEXT.md, 判定的先后) true by construction: a user cannot pick a
 * combination that breaks it.
 *
 * That ruling needs one module that owns the tier list, because the same three
 * strings are read by the host schema, the settings-save whitelist, the model
 * route's payload and the card's `<select>` — and two places spelling them is
 * two places they can drift. This is that module.
 *
 * It is deliberately peer-free (no settings service, no Cordis, not even the
 * retry module): the resolver is read on every card render and on every
 * adapter build, and it must be directly importable by `node --test`. It takes
 * the `Preferences` and `RequestLimits` types and `unwrapVolatile`, and
 * nothing else — types only, so the module still costs nothing at runtime.
 *
 * WHAT THIS MODULE HOLDS
 *
 * Two halves, and both exist so the inequality has exactly one home:
 *
 * 1. the vocabulary and the READ side — which tiers exist, which one is the
 *    default, and how to resolve a stored value without ever falling back
 *    silently; and
 * 2. the DERIVATION — `limitsFor` and `streamIdleCeilingFor` at the bottom,
 *    the only place in the plugin where the patience, the idle window and the
 *    stream-idle ceiling become numbers. The adapters and the shim both read
 *    them through resolvers, once per request / per profile build, so a tier
 *    saved on the card reaches the request path without a restart.
 *
 * Still nothing of its own: no timeout is declared here, only arithmetic over
 * the one table below, and the module stays peer-free so a bare
 * `node --test` can import it and assert the numbers directly. That matters
 * because the assembly layer that consumes them (`index.ts`) cannot be
 * imported by a test at all.
 *
 * @module dsh-connect-qoder/patience
 */
import { unwrapVolatile } from './volatile.ts'
import type { RequestLimits } from './domain.ts'
import type { Preferences } from './preferences.ts'

// ---------------------------------------------------------------------------
// The tier vocabulary — the single source both halves of the plugin read.
// ---------------------------------------------------------------------------

/**
 * The patience tiers the user may choose between.
 *
 * The labels are duration strings rather than numbers for the reason the ADR
 * gives: an enum removes "out of range" as a failure mode instead of
 * validating it. A number input would need parsing, empty-value, NaN and
 * bounds branches, each of which would owe the user a visible error state.
 */
export type PatienceTier = '2m' | '4m' | '6m'

/**
 * Every tier, in the order the card's `<select>` renders them.
 *
 * The card hardcodes the same three values in its option list; a contract test
 * compares the two so a fourth tier cannot be added to one side only.
 */
export const PATIENCE_TIERS: readonly PatienceTier[] = ['2m', '4m', '6m']

/**
 * The tier in force when nothing (usable) is stored.
 *
 * 4m is the number 0.7.4 shipped as an unwritten constant (240 s), so a fresh
 * install and an existing one behave identically the moment this setting
 * appears — the setting starts out describing what already happens.
 */
export const DEFAULT_PATIENCE_TIER: PatienceTier = '4m'

/** What a stored value resolved to, and whether it had to be replaced. */
export interface PatienceResolution {
  /** The tier to use. Always one of {@link PATIENCE_TIERS}. */
  tier: PatienceTier
  /**
   * True when a stored value existed and was not a known tier.
   *
   * This flag is the ONLY reason the fallback is allowed at all: the card
   * renders a warning from it, so a hand-edited settings file cannot silently
   * run on the default while the user believes it runs on something else
   * (AGENTS.md 红线 1).
   */
  invalid: boolean
}

/**
 * Resolve the patience tier out of a (possibly volatile) settings document.
 *
 * Three different states collapse to `tier: DEFAULT_PATIENCE_TIER`, and they
 * are NOT the same fact:
 *
 * - the field is absent — nothing was ever saved, so nothing is wrong;
 * - the field is a volatile shell resolving to nothing — the same, one hop
 *   later;
 * - the field holds something that is not a tier — a hand-edited document, a
 *   value from a future version, a typo. This alone sets `invalid`, because
 *   the user asked for a tier they are not getting.
 *
 * @param preferences - the resolved settings document, or `undefined`.
 * @returns the tier to use, plus whether a stored value had to be replaced.
 */
export function patienceTierOf(preferences: Preferences | undefined): PatienceResolution {
  const stored = unwrapVolatile(preferences?.patienceTier)
  // Absent is not invalid: a fresh install has saved nothing, and warning
  // about it would put a permanent red line on every new user's card.
  if (stored === undefined || stored === null) {
    return { tier: DEFAULT_PATIENCE_TIER, invalid: false }
  }
  // The type predicate is written out rather than a `as PatienceTier` cast:
  // the value is `unknown` off a settings document, and the cast would assert
  // exactly the membership this check is here to establish.
  const tier = PATIENCE_TIERS.find((candidate) => candidate === stored)
  return tier === undefined
    ? { tier: DEFAULT_PATIENCE_TIER, invalid: true }
    : { tier, invalid: false }
}

// ---------------------------------------------------------------------------
// The derived numbers — the ONLY place the three values are derived.
// ---------------------------------------------------------------------------

/**
 * The patience each tier buys, in milliseconds.
 *
 * The single input both derivations below read. Declared as a whole-table
 * `Record` rather than three scattered literals so that a tier cannot exist
 * without a patience: adding a fourth string to {@link PatienceTier} is a
 * compile error here until it is given a number, and the numbers themselves
 * have exactly one home (docs/adr/0001-patience-knob-exposure.md).
 */
const PATIENCE_MS: Readonly<Record<PatienceTier, number>> = {
  '2m': 120000,
  '4m': 240000,
  '6m': 360000,
}

/**
 * The idle window is the patience divided by this.
 *
 * WHY HALF — and why it is a DIVISION rather than a third number.
 *
 * Two constraints bound the window, and both are stated where the number they
 * constrain lives (`retry.ts`'s doc block; CONTEXT.md 判定的先后):
 *
 * - it must be ABOVE {@link QUEUE_WAIT_MAX_SLEEP_MS} (30 s), or "sleep as long
 *   as the gateway asked, then reconnect" would be killed by the watchdog the
 *   sleep is supposed to satisfy. Half of the SMALLEST tier is 60 s, so even
 *   the tightest tier clears that by 2×;
 * - it must be BELOW the patience, or it could never fire before the patience
 *   ran out and it would be a knob that does nothing.
 *
 * A half keeps the gap as wide as it can be while still giving the window a
 * job: it fires with a full half of the patience still unspent, so there is
 * always room for the retry the window itself provokes to happen INSIDE the
 * same budget. Closer to 1 would spend almost the whole patience proving the
 * stream is stuck and leave the reconnect it asks for no time at all.
 *
 * The division is the point: `idleWindowMs < patienceMs` then holds for any
 * positive patience. Had the window been written down per tier, the inequality
 * would be three literals that merely happen to be ordered today, and one
 * tuning edit would break a property nobody re-checks.
 */
const IDLE_WINDOW_DIVISOR = 2

/**
 * How much looser than the patience the stream-idle ceiling is.
 *
 * WHY THE OUTER LAYER MUST ALWAYS BE ONE NOTCH LOOSER. The ceiling is the
 * HOST's watchdog on the plugin's own SSE stream, and `TIMEOUT` is in
 * `ROUTE_RETRY_POLICY`'s retryable set. If it fired first, the Host would
 * retry the WHOLE turn with a completely fresh patience — up to five times —
 * each attempt starting the queue from zero and spending another bite of
 * Qoder's daily allowance. The ADR calls this "这一条是最贵的" (the most
 * expensive one) for exactly that reason. So the inner layer (the patience,
 * which gives up visibly and says how long it waited) must always fire first,
 * and the outer one must be strictly larger for EVERY tier.
 *
 * WHY 60 s. Any strictly positive slack satisfies the ordering, so the number
 * is chosen for two practical reasons and neither is "it looked about right":
 *
 * - it is one idle window of the smallest tier (60 s), i.e. a full window's
 *   worth of room for the final attempt the patience allows to arrive and be
 *   delivered before the Host steps in;
 * - it keeps the Host's watchdog within a minute of the plugin's own verdict,
 *   so a genuinely dead stream is still noticed promptly instead of being left
 *   to a proportionally later deadline.
 *
 * It is an ADDITION, not a multiplier, so the slack is the same at every tier:
 * choosing 6m buys patience, not a later Host watchdog.
 */
const STREAM_IDLE_SLACK_MS = 60000

/**
 * The limits ONE single request runs under at this tier.
 *
 * `idleWindowMs` is COMPUTED from `patienceMs` rather than stored beside it,
 * so `idleWindowMs < patienceMs` is arithmetic instead of agreement — see
 * {@link IDLE_WINDOW_DIVISOR}. The pair travels to `streamChat` as `RunChat`'s
 * optional fifth argument, read once per single request, so changing the tier
 * affects the NEXT request and never one already in flight.
 *
 * The returned object is fresh on every call on purpose: a resolver hands one
 * snapshot to one request, and nothing downstream can see a later read move
 * the numbers under it.
 *
 * @param tier - the tier in force, normally from {@link patienceTierOf}.
 * @returns this tier's patience and idle window, in milliseconds.
 */
export function limitsFor(tier: PatienceTier): RequestLimits {
  const patienceMs = PATIENCE_MS[tier]
  return { patienceMs, idleWindowMs: patienceMs / IDLE_WINDOW_DIVISOR }
}

/**
 * The Host-facing stream-idle ceiling for this tier.
 *
 * This is what the adapter declares as `streamIdleTimeoutMs`, and it must
 * always be LOOSER than {@link limitsFor}'s patience for the same tier — else
 * the Host's retry pre-empts the plugin's own give-up (see
 * {@link STREAM_IDLE_SLACK_MS}). The adapter reads it through a resolver on
 * every profile build, so saving a new tier reaches the running adapter
 * without a restart.
 *
 * @param tier - the tier in force.
 * @returns the ceiling in milliseconds, strictly above this tier's patience.
 */
export function streamIdleCeilingFor(tier: PatienceTier): number {
  return PATIENCE_MS[tier] + STREAM_IDLE_SLACK_MS
}
