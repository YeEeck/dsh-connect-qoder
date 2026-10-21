/**
 * The wording of THE OTHER failure: the patience budget running out.
 *
 * Run: node --test test/patience-message.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * The give-up branch of `streamChat`'s retry loop has always thrown whatever the
 * last attempt threw — a `QueueRejection` whose message was "Qoder is busy — the
 * request was queued". That sentence says nothing the user can act on: not how
 * long the plugin already waited, not what it was willing to wait, and not
 * whether sending the message again is worth anything. After 0.7.4 narrowed the
 * host's retry set (ROUTE_RETRY_POLICY no longer retries RATE_LIMIT), this
 * plugin's own patience is the ONLY patience a queued request gets, so the user
 * needs to know what it cost (docs/adr/0001-patience-knob-exposure.md, 后果).
 *
 * So the give-up now has its own class and its own sentence, in both languages
 * (English first, then Chinese — the host-side convention), and it must state
 * exactly three facts: Qoder kept the request waiting, how long we waited, and
 * that re-sending restarts the clock. It also carries the last upstream detail
 * when there is one, because that is the part a maintainer reads.
 *
 * WHAT MUST NOT CHANGE, AND IS ASSERTED HERE
 *
 *   - the thrown value is still `retryable === true` (the shim answers 503
 *     `rate_limit`, shim.ts:438-445 — that is the host behaviour being
 *     preserved), and `retryAfterSeconds` is 0: we have given up, so a hint
 *     would promise a wait we will not do;
 *   - a terminal failure (the daily limit) still propagates as ITSELF, message
 *     and flags untouched — the patience is not to blame for it;
 *   - the caller's own abort still surfaces unchanged;
 *   - the idle-window failure keeps its own sentence (silence, not a queue), and
 *     this message never borrows it.
 *
 * The stub drives `streamChat` through `globalThis.fetch` (the seam
 * `test/chat-stream-reader.test.js` established), with a patience injected in
 * tens of milliseconds so every case settles well under a second.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { streamChat } from '../src/host/upstream.ts'
import { createQoderShim } from '../src/host/shim.ts'

/** @type {import('../src/host/domain.ts').Region} */
const REGION = {
  id: 'qoder',
  mode: 'global',
  displayName: 'Qoder',
  appNames: ['Qoder'],
  baseUrl: 'https://gateway.example/',
  openApiUrl: 'https://openapi.example/',
  centerUrl: 'https://center.example/',
  manageUrl: 'https://manage.example/',
  downloadUrl: 'https://download.example/',
  patEnvNames: [],
}
const CREDENTIAL = { userID: 'u-test', token: 'tok-test', name: 'n', email: 'e@x', machineID: 'm' }
const REQUEST = {
  model: 'model-key',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  maxTokens: undefined,
  enableThinking: false,
  alwaysThinking: false,
  reasoningEffort: undefined,
  sessionId: 's-test',
}

/** The queue answer as the gateway sends it: a 429 carrying the 10605 descriptor. */
const QUEUE_BODY = JSON.stringify({
  code: '10605',
  message: JSON.stringify({
    isQueued: true,
    queueType: 'DEFAULT',
    retryAfterSeconds: 2,
    serviceAvailable: true,
  }),
})

/**
 * The daily-limit answer, as the newer gateway sends it: the same carrier (429),
 * a body that says the allowance is gone rather than the queue is long.
 */
const DAILY_LIMIT_BODY = JSON.stringify({
  message:
    "Qoder's daily request allowance for this account is used up. Waiting within the session will not help; " +
    'the off-peak price (22:00–08:00 Asia/Shanghai) and the daily check-in both still work.',
  type: 'daily_limit_exceeded',
  code: 'daily_limit_exceeded',
})

/** @returns {Response} */
function queuedResponse() {
  return new Response(QUEUE_BODY, { status: 429, headers: { 'content-type': 'application/json' } })
}

/** @returns {Response} */
function dailyLimitResponse() {
  return new Response(DAILY_LIMIT_BODY, { status: 429, headers: { 'content-type': 'application/json' } })
}

/**
 * One SSE response: the body is the given chunks, then the stream closes.
 * @param {string[]} chunks
 * @returns {Response}
 */
function sseResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/**
 * One SSE response whose body stays open after the given chunks — the shape a
 * stall is measured on.
 * @param {string[]} chunks
 * @returns {Response}
 */
function openSseResponse(chunks) {
  /** @type {ReadableStreamDefaultController<Uint8Array> | undefined} */
  let controller
  const stream = new ReadableStream({
    start(c) {
      controller = c
    },
  })
  const open = controller
  for (const chunk of chunks) {
    if (open) open.enqueue(new TextEncoder().encode(chunk))
  }
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** One answer frame, as the gateway sends it. @param {string} text */
function frame(text) {
  return `data: ${JSON.stringify({ body: { choices: [{ index: 0, delta: { content: text } }] } })}\n`
}

/**
 * Fail instead of hanging when a turn never ends.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms)
    }),
  ])
}

/**
 * Answer one request through the fetch seam.
 * @callback Reply
 * @param {number} call - 0-based index of the attempt being answered.
 * @param {RequestInit | undefined} init - what `streamChat` passed to fetch.
 * @returns {Response | Promise<Response>}
 */

/**
 * Drive one chat turn to settlement against a scripted reply.
 *
 * The default patience is deliberately tiny (80 ms): the ladder spends it in
 * one or two sleeps, so the give-up branch is reached in a blink and the number
 * in the sentence is still the REAL one this request spent.
 *
 * @param {{
 *   reply: Reply,
 *   patienceMs?: number,
 *   idleWindowMs?: number,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ calls: number, chunks: any[], error: any, elapsedMs: number }>}
 */
async function driveChat(options) {
  const original = globalThis.fetch
  let calls = 0
  // The URL is not read: what matters is the ORDER of the answers, not the
  // endpoint. The leading underscore is what keeps `noUnusedParameters` quiet
  // for a parameter the fetch signature requires.
  globalThis.fetch = async (_input, init) => {
    const index = calls
    calls += 1
    return options.reply(index, init)
  }
  const started = Date.now()
  /** @type {any} */
  let error
  /** @type {any[]} */
  const chunks = []
  const iterator = streamChat(REGION, CREDENTIAL, REQUEST, options.signal, {
    idleWindowMs: options.idleWindowMs ?? 60,
    patienceMs: options.patienceMs ?? 80,
  })
  try {
    await withTimeout(
      (async () => {
        for (;;) {
          let step
          try {
            step = await iterator.next()
          } catch (thrown) {
            error = thrown
            return
          }
          if (step.done === true) return
          chunks.push(step.value)
        }
      })(),
      options.timeoutMs ?? 8000,
      'the turn must settle',
    )
    await iterator.return?.(undefined)
  } finally {
    globalThis.fetch = original
  }
  return { calls, chunks, error, elapsedMs: Date.now() - started }
}

/**
 * The number of milliseconds a duration token stands for.
 * @param {RegExpExecArray} match
 * @returns {number}
 */
function msOf(match) {
  const value = Number(match[1])
  return match[2] === 's' ? value * 1000 : value
}

test('a spent patience states the wait, the patience and that re-sending restarts it — in both languages', async () => {
  const { chunks, error, elapsedMs } = await driveChat({
    patienceMs: 80,
    idleWindowMs: 60,
    reply: () => queuedResponse(),
  })
  assert.equal(chunks.length, 0, 'nothing was ever yielded to the caller')
  assert.ok(error, 'the turn must fail once the patience is spent')
  assert.equal(
    error.name,
    'PatienceExhaustedError',
    `the give-up must have its own sentence; got ${String(error.name)}: ${String(error.message)}`,
  )
  const message = String(error.message)

  // ---- the three facts, in English -----------------------------------------
  assert.match(message, /kept this request waiting for about \d+(?:ms|s)/, 'EN: Qoder kept it waiting, for how long')
  assert.match(message, /patience limit \(80ms\) is spent/, 'EN: the patience we gave this request')
  assert.match(message, /sending it again restarts the wait/, 'EN: re-sending restarts the clock')

  // ---- the same three facts, in Chinese ------------------------------------
  assert.match(message, /一直在排队/, 'ZH: it was kept queued')
  assert.match(message, /已等待约 \d+(?:ms|s)/, 'ZH: the wait')
  assert.match(message, /等待耐心（80ms）已用完/, 'ZH: the patience')
  assert.match(message, /重新发送会重新计时/, 'ZH: re-sending restarts the clock')

  // ---- the waited duration is the REAL one, not a constant -----------------
  // Spent means the request genuinely waited at least its patience; the upper
  // bound is the wall clock of the turn (plus slack). A hardcoded sentence —
  // say the patience itself, or the module default — cannot satisfy both.
  const waited = /waiting for about (\d+)(ms|s)/.exec(message)
  assert.ok(waited, `the message must name the wait: ${message}`)
  const waitedInMessage = msOf(waited)
  assert.ok(
    waitedInMessage >= 80,
    `a spent patience means at least the patience was waited; the message says ${waitedInMessage}ms`,
  )
  assert.ok(
    waitedInMessage <= elapsedMs + 100,
    `the message says ${waitedInMessage}ms but the whole turn took ${elapsedMs}ms — it is inventing a number`,
  )
  assert.equal(error.waitedMs, waitedInMessage, 'the sentence states the same number the error carries')
  assert.equal(error.patienceMs, 80, 'the patience this request was given')

  // ---- the last upstream detail, in both languages -------------------------
  assert.match(message, /Last response: /, 'EN: the last upstream detail is carried')
  assert.match(message, /上游最后一次回答：/, 'ZH: and in the Chinese half too')
  assert.match(message, /10605/, 'the detail is the real one the gateway sent')

  // ---- host behaviour preserved --------------------------------------------
  assert.equal(error.retryable, true, 'the shim keeps answering 503 rate_limit — behaviour must not change')
  assert.equal(error.retryAfterSeconds, 0, 'we have given up: a hint would promise a wait we will not do')

  // ---- and it is NOT the idle-window sentence ------------------------------
  assert.doesNotMatch(message, /no content|没有输出任何内容/, 'the idle window is a different failure with its own sentence')
  assert.doesNotMatch(message, /^Qoder is busy/, 'the old wording — the one that named no numbers — must be gone')
})

test('a terminal failure propagates as itself: the patience is not to blame for the daily limit', async () => {
  const { calls, error } = await driveChat({
    patienceMs: 80,
    reply: () => dailyLimitResponse(),
  })
  assert.equal(calls, 1, 'a daily limit must never enter the retry ladder')
  assert.equal(error.name, 'DailyLimitRejection', `the class must be untouched; got ${String(error.name)}`)
  assert.equal(error.dailyLimit, true)
  assert.equal(error.retryable, false)
  assert.equal(error.retryAfterSeconds, 0)
  assert.match(String(error.message), /daily quota exhausted/i, 'the host quota predicate reads this phrase')
  assert.doesNotMatch(
    String(error.message),
    /patience limit|等待耐心|restarts the wait|重新计时|一直在排队/,
    'a terminal verdict must not be reworded as a spent patience',
  )
})

test("the caller's abort still surfaces unchanged, never as a spent patience", async () => {
  /** @type {any} */
  const reason = Object.assign(new Error('client went away'), { name: 'AbortError' })
  const controller = new AbortController()
  const pending = driveChat({
    // A real transport rejects the pending fetch when its signal aborts.
    reply: (_call, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(reason), { once: true })
      }),
    signal: controller.signal,
    idleWindowMs: 5000,
    patienceMs: 5000,
  })
  setTimeout(() => controller.abort(reason), 30)
  const { error } = await pending
  assert.equal(error, reason, "the caller's abort must arrive as itself")
  assert.equal(error.retryable, undefined, 'the abort must not acquire a retry flag')
  assert.doesNotMatch(
    String(error.message),
    /patience limit|等待耐心|一直排队|restarts the wait/,
    'a client disconnect is not a queue verdict',
  )
})

test('an abort that races a spent patience still wins: the retryable failure is not reworded', async () => {
  // The sharp case for this ticket's branch. The upstream answers a queue
  // rejection a moment AFTER the patience is spent (patience 20 ms, answer at
  // ~80 ms) while the caller disconnects in between. The last failure IS
  // retryable and the patience IS spent, so only the abort check keeps the
  // verdict from being rewritten into "Qoder kept this request waiting" — which
  // would be a lie about a request the user themselves cancelled.
  const controller = new AbortController()
  const pending = driveChat({
    // The idle window is deliberately wider than the answer, so the queue
    // rejection is what the attempt throws — the case this test is about.
    idleWindowMs: 500,
    reply: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(queuedResponse()), 80)
      }),
    signal: controller.signal,
    patienceMs: 20,
  })
  // The caller disconnects while the answer is still on its way: after the
  // patience (20 ms) is already spent, before the queue rejection lands (80 ms).
  setTimeout(() => controller.abort(), 20)
  const { error } = await pending
  assert.ok(error, 'the turn must settle')
  assert.equal(error.name, 'QueueRejection', `the abort must win; got ${String(error.name)}: ${String(error.message)}`)
  assert.match(String(error.message), /queued/, 'the untouched queue wording')
  assert.doesNotMatch(String(error.message), /patience limit|等待耐心/, 'a cancelled request is not a spent patience')
})

test('a failure that carried no detail contributes no clause — nothing is invented', async () => {
  // The detail clause is conditional on there BEING a detail, in both languages.
  // The shape below is reachable: `classifyHandshakeFailure` leaves a
  // non-transport throw untouched, so a retryable failure with no
  // `upstreamDetail` reaches the give-up branch as-is. The sentence must then
  // simply stop after the remedy — inventing a reason (or the literal text
  // 'undefined', the way a bare `String(detail)` would) is worse than saying
  // nothing, because the user would read it as a diagnosis.
  const { error } = await driveChat({
    patienceMs: 40,
    reply: () => {
      // Retryable, but it carries no `upstreamDetail`: the handshake classifier
      // returns a non-transport throw untouched, so this reaches the give-up
      // branch exactly as raised.
      throw Object.assign(new Error('socket parked'), { retryable: true })
    },
  })
  assert.ok(error, 'the turn must fail once the patience is spent')
  assert.equal(error.name, 'PatienceExhaustedError')
  const message = String(error.message)
  assert.doesNotMatch(message, /Last response:|上游最后一次回答：/, 'no detail means no clause')
  assert.doesNotMatch(message, /undefined|\[object Object\]/, 'and certainly not a placeholder')
  assert.match(message, /restarts the wait/, 'the remedy survives')
  assert.match(message, /重新发送会重新计时/, 'in both languages')
})

test('the idle window is a different failure with a different sentence — never the patience wording', async () => {
  // Mid-answer silence: the answer has started, so the verdict is terminal and
  // the sentence is about SILENCE. Ticket 01 owns that wording; this test is the
  // fence that keeps the two sentences from collapsing into one.
  const { error } = await driveChat({
    idleWindowMs: 60,
    patienceMs: 200,
    reply: () => openSseResponse([frame('hi')]),
  })
  assert.ok(error, 'the turn must fail with a visible error')
  assert.notEqual(error.name, 'PatienceExhaustedError', 'a stall is not a queue verdict')
  assert.notEqual(error.retryable, true, 'after the first chunk a stall is terminal')
  const message = String(error.message)
  assert.match(message, /no content|没有输出任何内容/, 'the stall sentence names the silence')
  assert.doesNotMatch(
    message,
    /patience limit|等待耐心|一直在排队|kept this request waiting|restarts the wait|重新发送会重新计时/,
    'the idle-window sentence must not borrow the queue wording',
  )
})

test('control: a queue that clears inside the patience is retried, not reworded', async () => {
  // The negative control for the give-up branch: while the patience still has
  // time in it, a retryable rejection must go back through the ladder and the
  // recovered answer must reach the caller. A branch that converted every
  // queue rejection would pass the test above and fail this one.
  const { calls, chunks, error } = await driveChat({
    patienceMs: 300,
    reply: (call) => (call === 0 ? queuedResponse() : sseResponse([frame('hi'), 'data: [DONE]\n'])),
  })
  assert.equal(error, undefined, `the recovered turn must not fail: ${String(error?.message)}`)
  assert.equal(calls, 2, 'the queue rejection was waited out and re-sent exactly once')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]?.choices?.[0]?.delta?.content, 'hi')
})
test('through the real shim: still a 503 rate_limit, now with the patience sentence and no Retry-After', async () => {
  // Acceptance item 5, stated at the boundary the HOST actually sees. `retryable`
  // is not observable over HTTP — the shim turns it into a status code and a
  // message — so asserting the flag on the thrown value alone would leave the
  // host's own behaviour unpinned. This drives the real shim on a real port with
  // the real `streamChat`, and checks the two halves that matter: the status stays
  // the retryable one (`503 rate_limit`, exactly as before this ticket), and the
  // `Retry-After` header is ABSENT because `retryAfterSeconds` is 0 — we have
  // given up, so advertising a wait would promise something no one will do.
  const shim = createQoderShim({
    region: REGION,
    resolveCredential: async () => CREDENTIAL,
    resolveModels: () => [{ id: 'model-key', key: 'model-key', name: 'Model Key' }],
    resolveEnabledIds: () => ['model-key'],
    resolveUpstreamKey: (id) => id,
    // The REAL `streamChat`, with the tiny limits injected through its own
    // parameter. They are injected HERE rather than through the shim's
    // `resolveLimits` option on purpose: this file is about the give-up
    // SENTENCE, so it must not depend on the patience tier wiring (ticket 05)
    // or on the module defaults — a test that had to save a tier first would
    // fail for reasons that are not its subject. Everything below stays real:
    // the ladder, the class, the sentence, and the shim's translation of the
    // thrown value.
    runChat: (region, credential, request, signal) =>
      streamChat(region, credential, request, signal, { idleWindowMs: 60, patienceMs: 80 }),
    logger: { warn() {} },
  })
  const original = globalThis.fetch
  try {
    await shim.ready
    globalThis.fetch = async () => queuedResponse()
    const response = await original(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'model-key', messages: [{ role: 'user', content: 'hi' }] }),
    })

    assert.equal(response.status, 503, 'the retryable status is the behaviour being preserved')
    assert.equal(response.headers.get('retry-after'), null, 'a spent patience promises no wait')
    const body = await response.json()
    assert.equal(body.error.code, 'rate_limit', 'the host retries this code; the wording must not change that')
    const message = String(body.error.message)
    assert.match(message, /kept this request waiting for about \d+(?:ms|s)/, 'the sentence reaches the host')
    assert.match(message, /一直在排队/, 'both languages reach the host')
    assert.match(message, /restarts the wait/, 'and the remedy does too')
    assert.match(message, /重新发送会重新计时/)
  } finally {
    globalThis.fetch = original
    await shim.close()
  }
})
