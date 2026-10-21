/**
 * The patience tier vocabulary — the three stored values, the default, and the
 * resolver that reads a stored setting.
 *
 * Run: node --test test/patience-setting.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * "排队耐心" (CONTEXT.md) becomes a user-visible setting with three tiers
 * (docs/adr/0001-patience-knob-exposure.md). The stored document can be edited
 * by hand, and the schema that guards the CARD's writes does not guard a value
 * that arrived some other way — so the read side has to resolve the value
 * itself, and it has to say when it could not.
 *
 * That last part is the point. Falling back to the default is correct (a
 * corrupt value must not stop the plugin from answering); falling back
 * SILENTLY is the failure this repository has a standing red line against
 * (AGENTS.md 红线 1, docs/issues/16-silent-failure-policy.md). So every case
 * below asserts the `invalid` flag as well as the tier: `invalid: true` is the
 * one bit that turns the fallback into something the card can show.
 *
 * The module is intentionally peer-free (see its header), so it is imported
 * straight from the source with bare `node --test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_PATIENCE_TIER,
  PATIENCE_TIERS,
  patienceTierOf,
} from '../src/host/patience.ts'

test('the vocabulary is exactly the three tiers, and the default is one of them', () => {
  // The card renders this list and the host validates against it; a fourth
  // tier, or a default outside the list, is a setting the user could never
  // select or one that could never be stored.
  assert.deepEqual([...PATIENCE_TIERS], ['2m', '4m', '6m'])
  assert.equal(DEFAULT_PATIENCE_TIER, '4m')
  assert.ok(
    PATIENCE_TIERS.includes(DEFAULT_PATIENCE_TIER),
    'the default tier must be one the card can also show as selected',
  )
})

test('each stored tier resolves to itself, and is not flagged', () => {
  for (const tier of PATIENCE_TIERS) {
    assert.deepEqual(patienceTierOf({ patienceTier: tier }), { tier, invalid: false }, tier)
  }
})

test('an absent setting is the default, not a fallback', () => {
  // Nothing was ever saved, so there is nothing to warn about: this is the
  // fresh-install state, not a value that had to be replaced.
  assert.deepEqual(patienceTierOf(undefined), { tier: '4m', invalid: false })
  assert.deepEqual(patienceTierOf({}), { tier: '4m', invalid: false })
})

test('an unrecognised stored value falls back to the default AND says so', () => {
  // Every one of these is a hand-edited settings file: a tier that never
  // existed, a number where the enum is expected, an empty string, a
  // near-miss. The tier must be usable and the flag must be true — a silent
  // default is exactly the branch this repository forbids.
  const stored = ['5m', '', '4', ' 4m', '2M', 4, 0, true, [], {}, { get: () => '5m' }]
  for (const value of stored) {
    assert.deepEqual(
      patienceTierOf({ patienceTier: value }),
      { tier: '4m', invalid: true },
      `stored value ${JSON.stringify(value)}`,
    )
  }
})

test('an explicit null is absence, matching every other reader in the plugin', () => {
  // `imageModeFor` / `enabledIdsFor` / `regionEnabledFor` all read a null map
  // as "nothing was saved" rather than as an error, and the schema fills the
  // default for an absent field. A null here is the same statement one hop
  // later, so it must NOT raise the warning: a permanent red line on a card
  // whose document merely carries nulls would train the user to ignore the
  // line that matters.
  assert.deepEqual(patienceTierOf({ patienceTier: null }), { tier: '4m', invalid: false })
})

test('a volatile shell is unwrapped before the value is judged', () => {
  // On the 0.2 host a volatile field arrives as `{ get() }`. Reading it
  // without unwrapping would judge the shell itself — an object, therefore
  // "invalid" — and warn on a perfectly good setting.
  assert.deepEqual(patienceTierOf({ patienceTier: { get: () => '6m' } }), { tier: '6m', invalid: false })
  assert.deepEqual(patienceTierOf({ patienceTier: { get: () => '2m' } }), { tier: '2m', invalid: false })
  // A shell that resolves to nothing is the absent case, not a fallback.
  assert.deepEqual(patienceTierOf({ patienceTier: { get: () => undefined } }), { tier: '4m', invalid: false })
  // A shell that resolves to garbage is a fallback, and stays visible.
  assert.deepEqual(patienceTierOf({ patienceTier: { get: () => 'forever' } }), { tier: '4m', invalid: true })
})
