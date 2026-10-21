/**
 * The patience tier must reach the REQUEST PATH: read once per single request,
 * kept for the life of that request, and re-read for the next one.
 *
 * Run: node --test test/patience-request-path.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * Tickets 01–04 shipped three of the four halves of this feature: the stream
 * measures SILENCE, counts only a parsed frame as progress, words its give-up,
 * and the card can save a tier. None of that changed a single timeout — the
 * tier was a setting that described nothing. This ticket wires it, and the
 * wiring has two independent failure modes, neither visible from the outside:
 *
 * 1. THE READ HAPPENS AT THE WRONG TIME. If the shim resolved the limits once
 *    at start-up, or again on every frame pull, a saved tier would either need
 *    a restart or move the deadline UNDER a turn that is already streaming —
 *    the second is worse: the user watches a request fail at a boundary that
 *    belongs to a different setting than the one in force when they sent it.
 *    The contract is "once per single request, when it starts", and it is
 *    asserted here on the REAL shim:
 *      - the resolver is consulted exactly once per chat request;
 *      - a request already in flight keeps the limits it started with, even
 *        when the resolver's answer changes mid-stream;
 *      - the NEXT request sees the new answer.
 * 2. THE PROFILE KEEPS A CONSTANT. The Host's watchdog on this route's SSE
 *    stream is `streamIdleTimeoutMs`, and `adapter.ts` used to declare it as
 *    one module constant — so any derived value would have been frozen at
 *    import time and a settings save would never reach the Host without a
 *    restart. `createQoderAdapter` builds a real `PiAiAdapter` at construction
 *    and needs the pi-ai peer, so it cannot be called from a test; the wiring
 *    is asserted on the SOURCE TEXT, following
 *    `test/region-enabled-defaults.test.js` and `test/route-retry-policy.test.js`.
 *
 * The shim half is behavioural, not textual: `createQoderShim` is peer-free,
 * and `test/shim.test.js` (whose helpers this file's shape follows) drives it
 * on a real ephemeral port. Nothing here is mocked except the upstream call
 * itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createQoderShim } from '../src/host/shim.ts'
import { DEFAULT_PATIENCE_TIER, limitsFor, streamIdleCeilingFor } from '../src/host/patience.ts'

/**
 * A complete {@link import('../src/host/domain.ts').Region}.
 *
 * Spelled out rather than trimmed: the shim takes a real `Region`, and a
 * three-field stand-in would be a test asserting against a shape the plugin
 * never passes.
 */
const REGION = {
  id: 'qoder-cn',
  mode: 'cn',
  displayName: 'Qoder CN',
  appNames: ['QoderCN'],
  baseUrl: 'https://gateway.example/',
  openApiUrl: 'https://openapi.example/',
  centerUrl: 'https://center.example/',
  manageUrl: 'https://manage.example/',
  downloadUrl: 'https://download.example/',
  patEnvNames: [],
}

const adapterSource = readFileSync(new URL('../src/host/adapter.ts', import.meta.url), 'utf8')
const hostSource = readFileSync(new URL('../src/host/index.ts', import.meta.url), 'utf8')

/**
 * Start the real shim on a real ephemeral port.
 *
 * @param {{
 *   runChat: import('../src/host/domain.ts').RunChat,
 *   resolveLimits?: () => import('../src/host/domain.ts').RequestLimits,
 * }} options
 * @returns {Promise<import('../src/host/shim.ts').ShimHandle>}
 */
async function startShim(options) {
  const shim = createQoderShim({
    region: REGION,
    resolveCredential: async () => ({ userID: 'u-test', token: 'tok-test' }),
    resolveModels: () => [{ id: 'ModelA', key: 'a', name: 'Model A' }],
    resolveEnabledIds: () => [],
    resolveUpstreamKey: () => 'a',
    runChat: options.runChat,
    // Spread rather than the bare property: an absent resolver must reach the
    // shim as an ABSENT option, which is the behaviour under test in the last
    // case — handing over `undefined` explicitly would also work today, but it
    // would stop proving the optional-property contract.
    ...(options.resolveLimits === undefined ? {} : { resolveLimits: options.resolveLimits }),
    logger: { warn() {} },
  })
  await shim.ready
  return shim
}

/**
 * POST one streaming chat completion and return the raw response.
 *
 * @param {import('../src/host/shim.ts').ShimHandle} shim
 * @returns {Promise<Response>}
 */
async function postChat(shim) {
  return fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'ModelA', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
}

/**
 * Read a response body to the end, returning its text.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function drainBody(response) {
  const body = response.body
  assert.ok(body !== null, 'the shim must send a body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    text += decoder.decode(step.value, { stream: true })
  }
  return text
}

test('one request reads the limits once, and keeps them while it runs', async () => {
  /** @type {(import('../src/host/domain.ts').RequestLimits | undefined)[]} */
  const observed = []
  let reads = 0
  /** @type {import('../src/host/domain.ts').RequestLimits} */
  const FIRST = limitsFor('2m')
  /** @type {import('../src/host/domain.ts').RequestLimits} */
  const SECOND = limitsFor('6m')
  /** @type {import('../src/host/domain.ts').RequestLimits} */
  let current = FIRST
  /** @type {() => void} */
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined)
  })

  // The upstream holds the stream open after its first frame, so the client
  // can change the resolver's answer while THIS request is still in flight.
  /** @type {import('../src/host/domain.ts').RunChat} */
  const runChat = async function* (_region, _credential, _request, _signal, limits) {
    observed.push(limits)
    yield { choices: [{ delta: { content: 'first' } }] }
    await gate
    yield { choices: [{ delta: { content: 'second' } }] }
  }
  const shim = await startShim({
    runChat,
    resolveLimits: () => {
      reads += 1
      return current
    },
  })

  try {
    const response = await postChat(shim)
    assert.equal(response.status, 200)
    const body = response.body
    assert.ok(body !== null, 'a 200 stream must carry a body')
    const reader = body.getReader()
    const decoder = new TextDecoder()
    // The first frame proves `runChat` was called — and therefore that the
    // shim's single read of the limits has already happened.
    const head = await reader.read()
    assert.ok(!head.done, 'the first frame must arrive before the stream is switched')
    assert.match(decoder.decode(head.value), /first/)

    // MID-FLIGHT: the tier changes. If the shim re-read the resolver per frame
    // — or handed `runChat` something it consults lazily — this request would
    // start being judged by the new tier halfway through.
    current = SECOND
    release()
    let tail = ''
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      tail += decoder.decode(step.value, { stream: true })
    }
    assert.match(tail, /second/, 'the request must finish with the tier it started on')
    assert.match(tail, /\[DONE\]/, 'and still terminate normally')

    assert.equal(reads, 1, 'the resolver must be consulted exactly once for this single request')
    assert.deepEqual(observed, [FIRST], 'runChat must receive the limits of the tier in force when the request started')
    assert.notDeepEqual(observed[0], SECOND, 'a mid-flight change must not reach the running request')

    // THE NEXT REQUEST gets the new tier — otherwise "read once" would be
    // indistinguishable from "read once, ever", which is the restart bug.
    assert.match(await drainBody(await postChat(shim)), /first[\s\S]*second/, 'the second request streams normally')
    assert.equal(reads, 2, 'a second single request reads the resolver a second time')
    assert.deepEqual(observed[1], SECOND, 'the second request runs under the tier in force when IT started')
  } finally {
    release()
    await shim.close()
  }
})

test('an absent resolver leaves runChat on its own module defaults', async () => {
  // The optional-option contract: an older caller that knows nothing about
  // limits must keep the exact behaviour it had — `streamChat`'s own defaults,
  // which test/patience.test.js pins to the default tier's numbers. Passing a
  // fabricated default here instead would be a second source for those numbers.
  /** @type {import('../src/host/domain.ts').RequestLimits | undefined} */
  let received
  let called = 0
  /** @type {import('../src/host/domain.ts').RunChat} */
  const runChat = async function* (_region, _credential, _request, _signal, limits) {
    called += 1
    received = limits
    yield { choices: [{ delta: { content: 'ok' } }] }
  }
  const shim = await startShim({ runChat })
  try {
    assert.match(await drainBody(await postChat(shim)), /ok/)
    assert.equal(called, 1)
    assert.equal(received, undefined, 'no resolver means no limits argument, which is the old behaviour')
  } finally {
    await shim.close()
  }
})

test('the profile reads the ceiling from the resolver, not from a module constant', () => {
  // `createQoderAdapter` constructs a real `PiAiAdapter`, so this cannot be
  // called here. What can be pinned is the shape that makes the save reach the
  // Host without a restart: a resolver read INSIDE `buildProfiles()`, and the
  // old module constant gone.
  assert.match(
    adapterSource,
    /streamIdleTimeoutMs: streamIdleCeiling\(\),/,
    'the profile must read the ceiling resolver per build, or a saved tier never reaches the Host',
  )
  assert.match(
    adapterSource,
    /const streamIdleCeiling = options\.streamIdleCeiling \?\? \(\(\) => DEFAULT_STREAM_IDLE_TIMEOUT_MS\)/,
    "an absent resolver must fall back to the default tier's ceiling, not to undefined",
  )
  // `\b` (not a plain substring): the surviving DEFAULT_* fallback legitimately
  // ends in the same words, and a substring check would confuse the two.
  assert.equal(
    /\bconst STREAM_IDLE_TIMEOUT_MS\s*=/.test(adapterSource),
    false,
    'the old module constant must stay deleted — reintroducing it freezes the ceiling at import time',
  )
  // The fallback literal must be the DEFAULT TIER's derived ceiling, not just
  // "some number near the old one": a plugin that never received the resolver
  // would otherwise declare a ceiling that disagrees with the patience
  // `streamChat` uses by default, and the Host's watchdog could fire first.
  const fallback = /const DEFAULT_STREAM_IDLE_TIMEOUT_MS = (\d+)/.exec(adapterSource)
  assert.ok(fallback !== null, 'adapter.ts must keep a ceiling for a caller that supplies no resolver')
  assert.equal(
    Number(fallback[1]),
    streamIdleCeilingFor(DEFAULT_PATIENCE_TIER),
    'the adapter\'s no-resolver fallback must equal the default tier\'s derived ceiling',
  )

  // Ordering, not mere presence: the build function is what `invalidate()`
  // calls again, so the read has to be inside it. A line that merely appears
  // somewhere in the file could sit in a one-shot initialiser.
  const buildAt = adapterSource.indexOf('const buildProfiles = ()')
  const readAt = adapterSource.indexOf('streamIdleTimeoutMs: streamIdleCeiling()')
  const firstBuildAt = adapterSource.indexOf('let profiles = buildProfiles()')
  assert.ok(buildAt !== -1, 'adapter.ts no longer has a buildProfiles()')
  assert.ok(readAt > buildAt, 'the ceiling must be read inside buildProfiles()')
  assert.ok(firstBuildAt === -1 || readAt < firstBuildAt, 'the read must not be in a one-shot initialiser')
})

test('the activation wires both resolvers to the live settings, and warns once per bad value', () => {
  // index.ts cannot be imported (Cordis peers), so its wiring is asserted as
  // source text — the same precedent as the two tests named in this file's
  // header. What must hold:
  //   - both resolvers derive from the SAME tier reader, or the Host's
  //     watchdog and the request path could disagree about the tier (the
  //     failure this whole ticket exists to prevent);
  //   - both are passed as RESOLVERS, not values;
  //   - a bad stored tier is warned about ONCE per distinct value: this runs
  //     on every request and every build, and a warn per render would train
  //     the user to ignore the one line that matters (红线 1 asks for
  //     visibility, not for a flood).
  assert.match(hostSource, /const limitsForCurrentTier = \(\): RequestLimits => limitsFor\(patienceTier\(\)\)/)
  assert.match(hostSource, /const streamIdleCeiling = \(\): number => streamIdleCeilingFor\(patienceTier\(\)\)/)
  assert.match(hostSource, /resolveLimits,/)
  assert.match(hostSource, /streamIdleCeiling,/)
  assert.match(
    hostSource,
    /if \(fingerprint !== lastBadPatienceFingerprint\) \{[\s\S]*?lastBadPatienceFingerprint = fingerprint/,
    'the bad-tier warn must be gated on a value it then remembers, or it fires on every request',
  )
  assert.match(hostSource, /ctx\.logger\.warn\?\.\(/, 'the bad-tier fallback must be visible in the host log')
})
