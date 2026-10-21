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
 * the `Preferences` type and `unwrapVolatile` and nothing else.
 *
 * WHAT IS HERE NOW, AND WHAT IS NOT
 *
 * This module currently holds the vocabulary and the READ side only: which
 * tiers exist, which one is the default, and how to resolve a stored value
 * without ever falling back silently. The three derived numbers
 * (`limitsFor`, `streamIdleCeilingFor`) belong here too — see the marked
 * section at the bottom — but they land with the ticket that wires the tier
 * into the request path. Nothing in this file may grow a timeout of its own
 * before then: the setting is savable and nothing more.
 *
 * @module dsh-connect-qoder/patience
 */
import { unwrapVolatile } from './volatile.ts'
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
// The derived numbers — RESERVED for the ticket that makes the tier take
// effect (it adds `limitsFor` and `streamIdleCeilingFor` here, and those are
// the ONLY place the three numbers may be derived):
//
//   patience           2m / 4m / 6m   →  120000 / 240000 / 360000 ms
//   idle window        patience / 2  →   60000 / 120000 / 180000 ms
//   stream-idle ceiling patience + 60 s → 180000 / 300000 / 420000 ms
//
// The inequality idleWindow < patience < streamIdleCeiling then holds for all
// three tiers by construction, which is the ADR's whole point.
//
// Nothing above is computable from this file today ON PURPOSE: ticket 04 adds
// the setting surface only, and a tier that changed a timeout here would
// change behaviour that has no test and no wiring yet.
// ---------------------------------------------------------------------------
