/**
 * Frontend-backend contract test.
 *
 * The client (`src/client/`) and host (`src/host/`) halves — both TypeScript —
 * must agree on two things:
 *
 * 1. **Route paths** — the client's `paths.ts` defines the paths it fetches;
 *    the host's `index.ts` registers them. A mismatch is a silent 404.
 * 2. **Settings field names** — the client's `settings-write.ts` posts fields
 *    to `__save`; the host's `settings-save.ts` whitelists them. A mismatch
 *    is a silent 400.
 *
 * This test reads the host's `index.ts` as text and extracts the constants —
 * it cannot import it (the host pulls in the Cordis peer dependencies, so it
 * cannot be imported by a test). The save whitelist is different:
 * `settings-save.ts` is framework-free (that was the point of extracting it),
 * so `SAVE_FIELDS` is imported and asserted as the real runtime value — a
 * brace-walking text parser there would be a second parser to keep correct
 * for no gain.
 *
 * Every extraction is required to prove it extracted something (`requireExtracted`)
 * before two sides are compared: a regex that stops matching returns `undefined`
 * on both sides, and `assert.strictEqual(undefined, undefined)` would pass with
 * zero evidence. A broken anchor must turn red, never silently agree.
 *
 * Run: node --test test/contract.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// settings-save.ts is framework-free by design (see its module header), so the
// whitelist can be asserted as the real value instead of via text extraction.
import { SAVE_FIELDS } from '../src/host/settings-save.ts'
// The host owns the tier vocabulary; the client's copy exists only because the
// card must normalise what it renders. Both are imported rather than restated,
// so this file compares the REAL lists instead of transcriptions of them.
import { DEFAULT_PATIENCE_TIER, PATIENCE_TIERS } from '../src/host/patience.ts'
import {
  DEFAULT_PATIENCE_TIER as CLIENT_DEFAULT_PATIENCE_TIER,
  PATIENCE_TIERS as CLIENT_PATIENCE_TIERS,
} from '../src/client/controller.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Read a source file as text. */
const read = (path) => readFileSync(join(root, path), 'utf8')

/** Extract a string constant from source: `export const NAME = "value";` */
const extractString = (source, name) => {
  const re = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`)
  const match = re.exec(source)
  return match === null ? undefined : match[1]
}

/**
 * Prove an extraction actually extracted something.
 *
 * The guard-liveness lesson that cost a sibling plugin a CI failure: a
 * text-parser whose regex stops matching returns `undefined` on BOTH sides,
 * and `assert.strictEqual(undefined, undefined)` passes with zero evidence —
 * the client and host can drift apart forever while the guard stays green.
 * Every extraction below therefore proves it found its anchor, so a renamed
 * constant or a restructured declaration turns red with a readable message
 * instead of silently agreeing.
 */
const requireExtracted = (value, what) => {
  assert.ok(
    value !== undefined && value !== null,
    `could not extract \`${what}\` from its source — the anchor changed or the regex no longer matches. ` +
      'Fix the extractor; do not let this comparison pass silently.',
  )
  return value
}

// --- Route paths ----------------------------------------------------------

const clientPaths = read('src/client/paths.ts')
const hostIndex = read('src/host/index.ts')

test('route paths: client and host agree on the model route', () => {
  const client = requireExtracted(extractString(clientPaths, 'QODER_MODELS_PATH'), 'QODER_MODELS_PATH in src/client/paths.ts')
  const host = requireExtracted(extractString(hostIndex, 'QODER_MODELS_PATH'), 'QODER_MODELS_PATH in src/host/index.ts')
  assert.strictEqual(client, host, `model route mismatch: client="${client}" host="${host}"`)
})

test('route paths: client and host agree on the usage route', () => {
  const client = requireExtracted(extractString(clientPaths, 'QODER_USAGE_PATH'), 'QODER_USAGE_PATH in src/client/paths.ts')
  const host = requireExtracted(extractString(hostIndex, 'QODER_USAGE_PATH'), 'QODER_USAGE_PATH in src/host/index.ts')
  assert.strictEqual(client, host, `usage route mismatch: client="${client}" host="${host}"`)
})

test('route paths: client and host agree on the account route', () => {
  const client = requireExtracted(extractString(clientPaths, 'QODER_ACCOUNT_PATH'), 'QODER_ACCOUNT_PATH in src/client/paths.ts')
  const host = requireExtracted(extractString(hostIndex, 'QODER_ACCOUNT_PATH'), 'QODER_ACCOUNT_PATH in src/host/index.ts')
  assert.strictEqual(client, host, `account route mismatch: client="${client}" host="${host}"`)
})

test('route paths: client and host agree on the account reload route', () => {
  const client = requireExtracted(extractString(clientPaths, 'QODER_ACCOUNT_RELOAD_PATH'), 'QODER_ACCOUNT_RELOAD_PATH in src/client/paths.ts')
  const host = requireExtracted(extractString(hostIndex, 'QODER_ACCOUNT_RELOAD_PATH'), 'QODER_ACCOUNT_RELOAD_PATH in src/host/index.ts')
  assert.strictEqual(client, host, `account reload route mismatch: client="${client}" host="${host}"`)
})

test('route paths: client and host agree on the account confirm route', () => {
  const client = requireExtracted(extractString(clientPaths, 'QODER_ACCOUNT_CONFIRM_PATH'), 'QODER_ACCOUNT_CONFIRM_PATH in src/client/paths.ts')
  const host = requireExtracted(extractString(hostIndex, 'QODER_ACCOUNT_CONFIRM_PATH'), 'QODER_ACCOUNT_CONFIRM_PATH in src/host/index.ts')
  assert.strictEqual(client, host, `account confirm route mismatch: client="${client}" host="${host}"`)
})

test('route paths: client and host agree on the checkin route', () => {
  const client = requireExtracted(extractString(clientPaths, 'QODER_CHECKIN_PATH'), 'QODER_CHECKIN_PATH in src/client/paths.ts')
  const host = requireExtracted(extractString(hostIndex, 'QODER_CHECKIN_PATH'), 'QODER_CHECKIN_PATH in src/host/index.ts')
  assert.strictEqual(client, host, `checkin route mismatch: client="${client}" host="${host}"`)
})

test('route paths: client and host agree on the save route', () => {
  // The save route is hardcoded in settings-write.ts as a fetch URL.
  const clientMatch = /fetch\(["']([^"']+)["']/.exec(clientWrite)
  assert.ok(clientMatch !== null, 'settings-write.ts no longer fetches the save endpoint — the route contract has lost its anchor')
  const client = clientMatch[1]
  const host = requireExtracted(extractString(hostIndex, 'QODER_SAVE_PATH'), 'QODER_SAVE_PATH in src/host/index.ts')
  assert.strictEqual(client, host, `save route mismatch: client="${client}" host="${host}"`)
})

// --- Settings field names ---------------------------------------------------

const clientWrite = read('src/client/settings-write.ts')

test('settings fields: client and host agree on the field names', () => {
  // The client posts fields by string literal; the host whitelists them.
  // The whitelist is imported (see the header note); the client side is still
  // extracted from `settings-write.ts` because the card posts literals inline.
  const clientFields = []
  for (const m of clientWrite.matchAll(/field\s*===\s*["'](\w+)["']/g)) clientFields.push(m[1])
  // Deduplicate while preserving order.
  const clientUnique = [...new Set(clientFields)]
  // Both sides must have produced evidence before they are compared — an empty
  // set on each side agrees vacuously, which is the silent-pass failure mode
  // this file exists to rule out (see requireExtracted).
  assert.ok(clientUnique.length > 0, 'no settings field comparisons found in settings-write.ts — the guard has nothing to check')
  const hostKeys = Object.keys(SAVE_FIELDS)
  assert.ok(hostKeys.length > 0, 'SAVE_FIELDS imported as an empty object — the declaration changed')
  // The client references fields in comparisons; the host declares them all.
  // Every field the client checks must be in the host's whitelist.
  for (const field of clientUnique) {
    assert.ok(
      hostKeys.includes(field),
      `client checks field "${field}" but it is not in SAVE_FIELDS [${hostKeys.join(', ')}]`,
    )
  }
})

// --- Plugin namespace --------------------------------------------------------

test('namespace: host defines the expected settings namespace', () => {
  // The host's QODER_SETTINGS_NS is the authoritative namespace. The client
  // hardcodes "dsh-connect-qoder" in its fetch URLs (settings-write.ts) and
  // card registration (card.tsx). A future refactor could extract a shared
  // constant, but for now this test pins the host's value so a rename fails.
  const hostNs = requireExtracted(extractString(hostIndex, 'QODER_SETTINGS_NS'), 'QODER_SETTINGS_NS in src/host/index.ts')
  assert.strictEqual(hostNs, 'dsh-connect-qoder', 'host namespace must be dsh-connect-qoder')
})

// --- Patience tier vocabulary ------------------------------------------------

const cardSource = read('src/client/card.tsx')

/**
 * The tier values the card's patience <select> renders, read from SOURCE TEXT.
 *
 * The card writes its three options out literally — each one carries its own
 * copy key — so there is no value array to import; the list exists only as
 * markup. This walks from the select's aria-label to its closing tag, the same
 * way the route-path extractors above walk their constants, and funnels the
 * result through `requireExtracted`: a renamed aria-label must turn red rather
 * than compare two empty lists.
 */
const cardPatienceOptions = () => {
  const anchor = cardSource.indexOf('aria-label={t("row.patience")}')
  assert.notStrictEqual(anchor, -1, 'card.tsx no longer renders the patience select (its aria-label moved)')
  const close = cardSource.indexOf('</select>', anchor)
  assert.notStrictEqual(close, -1, 'the patience select is unterminated in card.tsx')
  const values = [...cardSource.slice(anchor, close).matchAll(/value="([^"]+)"/g)].map((m) => m[1])
  return requireExtracted(values.length > 0 ? values : undefined, 'the patience <option> values in card.tsx')
}

test('the card offers exactly the tiers the host declares', () => {
  // The card hardcodes its three options because each one carries its own copy
  // key; the host owns the authoritative list in `src/host/patience.ts`. Two
  // lists, one meaning — so this compares them instead of trusting them to stay
  // in step. A tier added on one side only is a setting the user can save but
  // never select, or select and never see again.
  const options = cardPatienceOptions()
  assert.deepStrictEqual(
    options,
    [...PATIENCE_TIERS],
    `the card's <option> values must be the host's tiers; card=${options.join(',')} host=${PATIENCE_TIERS.join(',')}`,
  )
  // The client controller keeps its own copy too — it normalises both the value
  // the host shipped and the value the select hands back — and it must agree
  // with the host, or the card would normalise a good tier to the default.
  assert.deepStrictEqual([...CLIENT_PATIENCE_TIERS], [...PATIENCE_TIERS])
  assert.strictEqual(CLIENT_DEFAULT_PATIENCE_TIER, DEFAULT_PATIENCE_TIER)
})

test('the tier select renders in the settings row, above the commit bar', () => {
  // The repo rule (pinned for the DOM by test/card-dom.test.js, 'every setting
  // the commit bar saves renders above it') is that a persisted setting sits
  // above the row that saves it. This is the source-side half: the select is
  // inside the `.dsm-qoder-switches` block, and that block is declared before
  // the commit bar rather than after it.
  const selectAt = cardSource.indexOf('aria-label={t("row.patience")}')
  assert.notStrictEqual(selectAt, -1, 'card.tsx lost the patience select')
  const switchesAt = cardSource.lastIndexOf('dsm-qoder-switches', selectAt)
  const barAt = cardSource.indexOf('dsm-qoder-actions-save', selectAt)
  assert.ok(switchesAt !== -1 && switchesAt < selectAt, 'the select must live in the settings switch row')
  assert.ok(barAt !== -1, 'card.tsx no longer renders the commit bar')
  assert.ok(selectAt < barAt, 'the select must be declared above the commit bar')
})

// --- Guard liveness (negative control) ---------------------------------------

test('guard liveness: a broken anchor turns red instead of passing silently', () => {
  // Replays the silent-pass failure mode this file used to have: rename the
  // anchor constant in memory on BOTH sides. The old code extracted
  // `undefined` from each and compared `undefined === undefined` — green, with
  // the routes free to drift apart. requireExtracted must make the same
  // scenario throw.
  const broken = read('src/client/paths.ts').replaceAll('QODER_MODELS_PATH', 'RENAMED_MODELS_PATH')
  assert.throws(
    () => requireExtracted(extractString(broken, 'QODER_MODELS_PATH'), 'QODER_MODELS_PATH'),
    /could not extract/,
  )
})
