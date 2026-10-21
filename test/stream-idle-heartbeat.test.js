/**
 * A heartbeat is not progress: the idle window re-arms on a FRAME, not a byte.
 *
 * Run: node --test test/stream-idle-heartbeat.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * Ticket 01 replaced the absolute per-attempt deadline with a window on
 * SILENCE, and classified what a stall MEANS by phase. It left the progress
 * stamp where it had always been: immediately after every body read, so every
 * arriving BYTE counted as progress. Bytes are not frames. A gateway that keeps
 * its connection alive with SSE comments (`: keep-alive\n`), blank lines, or
 * payloads this build cannot parse stays perfectly "not silent" while producing
 * nothing, so `streamChat` would never judge it stuck — the Host's own watchdog
 * would fire first, and its error is a blind `TIMEOUT` it retries several times,
 * each retry paying a fresh queue patience and a fresh bite out of the daily
 * allowance.
 *
 * This ticket narrows the stamp to "a frame was actually reached": the two
 * yield sites that forward a real chunk (`choices`/`usage`). Comments, blank
 * lines, non-`data:` lines, unparseable payloads, `[DONE]` and failure frames
 * are bytes without a frame and do NOT reset the clock.
 *
 * The four cases below, driven through `globalThis.fetch` with the helpers
 * `test/stream-idle-window.test.js` established (no gateway, no loopback
 * server, deterministic) and tens-of-milliseconds injected windows:
 *
 *   1. heartbeat-only, nothing yielded  => stuck, RETRYABLE (queue-shaped);
 *   2. heartbeat after one real chunk   => stuck, NOT retryable, no duplication;
 *   3. control: real frames closer than the window but a longer TOTAL stream
 *      must finish normally (a frame does re-arm the clock);
 *   4. control: unparseable `data:` payloads are bytes without a frame too.
 *
 * What this file deliberately does NOT pin: the class name and the exact
 * sentence of the give-up error (ticket 03 replaces both), and how many attempts
 * the ladder makes (that is `queueWaitFor`'s business). It asserts only what
 * ticket 02 owns.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { streamChat } from '../src/host/upstream.ts'

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

/**
 * One SSE line that is a comment, not a frame: the keep-alive shape.
 * @param {string} [text]
 */
function comment(text = 'keep-alive') {
  return `: ${text}\n`
}

/** One blank line — the other way an SSE stream says "still here, nothing to say". */
const BLANK = '\n'

/**
 * One answer frame, as the gateway sends it (the existing test helper's shape).
 * @param {string} text
 */
function frame(text) {
  return `data: ${JSON.stringify({ body: { choices: [{ index: 0, delta: { content: text } }] } })}\n`
}

/**
 * One response whose chunks arrive with a REAL silence between them.
 *
 * `initial` is sent first, one chunk every `gapMs`; when a `repeat` list is
 * given the stream KEEPS going with those chunks (cycled), and that tail must
 * never contain a real frame — it is how the heartbeat-only shape is built. The
 * gaps are what make "a heartbeat every gapMs" a measurable silence: each one is
 * shorter than the window, so only a clock that counts bytes would keep the turn
 * alive. `stop()` ends the source once the test has its answer, so no timer
 * outlives the test.
 *
 * @param {string[]} initial
 * @param {number} gapMs
 * @param {{ repeat?: string[] }} [options]
 */
function pacedResponse(initial, gapMs, options = {}) {
  let stopped = false
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (let i = 0; ; i++) {
          if (stopped) return
          if (i > 0) await new Promise((resolve) => setTimeout(resolve, gapMs))
          if (stopped) return
          const text = i < initial.length ? initial[i] : options.repeat?.[(i - initial.length) % options.repeat.length]
          if (text === undefined) {
            controller.close()
            return
          }
          controller.enqueue(new TextEncoder().encode(text))
        }
      } catch {
        // The turn was abandoned (a failing assertion path) before the close.
      }
    },
  })
  return {
    response: new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    stop: () => {
      stopped = true
    },
  }
}

/**
 * Pull a chat generator to settlement, keeping the chunks and the thrown error.
 * @param {AsyncIterator<any>} iterator
 */
async function drain(iterator) {
  const chunks = []
  /** @type {any} */
  let error
  for (;;) {
    let step
    try {
      step = await iterator.next()
    } catch (thrown) {
      error = thrown
      break
    }
    if (step.done) break
    chunks.push(step.value)
  }
  try {
    await iterator.return?.()
  } catch {
    // Already settled by the error path.
  }
  return { chunks, error }
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
 * @param {typeof globalThis.fetch} handler
 */
function stubFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return () => {
    globalThis.fetch = original
  }
}

/**
 * The text of the answer, in the order the frames carried it.
 * @param {any[]} chunks
 */
function textOf(chunks) {
  return chunks
    .map((chunk) => chunk?.choices?.[0]?.delta?.content ?? '')
    .join('')
}

test('heartbeat-only, nothing yielded yet: judged stuck at the idle window, retryable', async () => {
  // The upstream opens the stream and then only breathes: an SSE comment every
  // 15 ms against a 120 ms window. Those bytes must not feed the clock. Nothing
  // is ever yielded, so this is ticket 01's PRE-FIRST-FRAME phase: the stall is
  // retryable and the queue ladder is allowed to wait it out — bounded by the
  // injected patience, never by the module's real 240 s.
  let calls = 0
  /** @type {Array<{ stop: () => void }>} */
  const sources = []
  const restore = stubFetch(async () => {
    calls += 1
    const source = pacedResponse([], 15, { repeat: [comment()] })
    sources.push(source)
    return source.response
  })
  const started = Date.now()
  try {
    const { chunks, error } = await withTimeout(
      drain(streamChat(REGION, CREDENTIAL, REQUEST, undefined, { idleWindowMs: 120, patienceMs: 400 })),
      5000,
      'a heartbeat-only upstream must be judged stuck, not hang',
    )
    const elapsedMs = Date.now() - started
    assert.equal(chunks.length, 0, 'a heartbeat is not a frame: nothing may reach the caller')
    assert.ok(error, 'the turn must fail at the idle window instead of outliving it')
    assert.equal(error.retryable, true, 'before the first frame a stall is queue-shaped, exactly as in ticket 01')
    assert.ok(calls > 1, `the ladder must be allowed to re-send; got ${calls} attempt(s)`)
    assert.ok(
      elapsedMs < 2000,
      `bounded by the injected patience, not the module default; took ${elapsedMs} ms`,
    )
  } finally {
    restore()
    for (const source of sources) source.stop()
  }
})

test('heartbeat-only after a real chunk: terminal at the idle window, no retry, no duplicated output', async () => {
  // The same heartbeat shape AFTER the answer has started. The first frame is
  // real, so the clock is re-armed on it — that is the control ticket 02 must
  // not break — and from then on only comments arrive. Re-sending would
  // regenerate the reply and repeat what the user already read, so this phase
  // must not take the queue ladder, however long the upstream keeps purring.
  let calls = 0
  /** @type {Array<{ stop: () => void }>} */
  const sources = []
  const restore = stubFetch(async () => {
    calls += 1
    // The tail is comments and blank lines ONLY — replaying the frame would
    // re-arm the clock and quietly turn this into the healthy case.
    const source = pacedResponse([frame('hi')], 15, { repeat: [comment(), BLANK] })
    sources.push(source)
    return source.response
  })
  const started = Date.now()
  try {
    const { chunks, error } = await withTimeout(
      drain(streamChat(REGION, CREDENTIAL, REQUEST, undefined, { idleWindowMs: 120, patienceMs: 200 })),
      5000,
      'heartbeats after the first chunk must not keep the turn alive',
    )
    const elapsedMs = Date.now() - started
    assert.equal(calls, 1, 'the turn is committed after the first chunk — it must not be re-sent')
    assert.equal(chunks.length, 1, 'exactly the chunk the caller already saw')
    assert.equal(textOf(chunks), 'hi', 'what was delivered must not be duplicated')
    assert.ok(error, 'the turn must fail with a visible error')
    assert.notEqual(error.retryable, true, 'after the first chunk a stall is NOT retryable')
    assert.match(String(error.message), /no content|没有输出任何内容/, 'the message must name the silence')
    assert.doesNotMatch(String(error.message), /queued|排队/i, 'this must not read as a queue rejection')
    // The claim the whole ticket turns on: the verdict came from the window
    // measured in FRAMES. Before ticket 02 the comments re-armed the clock, so
    // this stream outlived every window and only the 5000 ms guard ended it.
    assert.ok(
      elapsedMs < 1000,
      `heartbeats must not feed the clock: the turn must end at ~one window, took ${elapsedMs} ms`,
    )
  } finally {
    restore()
    for (const source of sources) source.stop()
  }
})

test('control: a real frame still re-arms the clock, so a long stream of frames completes', async () => {
  // The guard against "narrowed" turning into "removed": five frames 40 ms
  // apart against a 60 ms window. Every gap fits inside a window, the stream's
  // TOTAL life (~200 ms) does not — and it must still complete, because each
  // frame re-arms the clock. A stamp taken only once, at the start, would abort
  // this turn mid-answer.
  const restore = stubFetch(async () =>
    pacedResponse([frame('1'), frame('2'), frame('3'), frame('4'), frame('5'), 'data: [DONE]\n'], 40).response,
  )
  try {
    const { chunks, error } = await withTimeout(
      drain(streamChat(REGION, CREDENTIAL, REQUEST, undefined, { idleWindowMs: 60, patienceMs: 400 })),
      5000,
      'frames closer together than the window must never be judged a stall',
    )
    assert.equal(error, undefined, `a frame-producing turn must finish; got ${error}`)
    assert.equal(textOf(chunks), '12345', 'every frame must be forwarded')
  } finally {
    restore()
  }
})

test('control: unparseable data payloads are bytes without a frame — not progress either', async () => {
  // The sibling shape to a heartbeat, and the one that is easiest to miss: a
  // `data:` payload that is not JSON still arrives as bytes. It is not a frame.
  // Before ticket 02 it re-armed the clock per chunk, so this stream survived
  // the window; nothing is yielded, so it must fail in the pre-first-frame
  // phase — retryable — and the parser's "unreadable frame" bookkeeping must not
  // be turned into progress by accident.
  let calls = 0
  /** @type {Array<{ stop: () => void }>} */
  const sources = []
  const restore = stubFetch(async () => {
    calls += 1
    const source = pacedResponse([], 15, { repeat: ['data: {"body":"not-json-any-more"}\n'] })
    sources.push(source)
    return source.response
  })
  const started = Date.now()
  try {
    const { chunks, error } = await withTimeout(
      drain(streamChat(REGION, CREDENTIAL, REQUEST, undefined, { idleWindowMs: 120, patienceMs: 400 })),
      5000,
      'unparseable payloads must not keep the turn alive',
    )
    const elapsedMs = Date.now() - started
    assert.equal(chunks.length, 0, 'an unparseable payload yields nothing')
    assert.ok(error, 'the turn must fail at the idle window instead of outliving it')
    assert.equal(error.retryable, true, 'nothing was yielded, so the stall stays retryable')
    assert.ok(calls > 1, `the ladder must be allowed to re-send; got ${calls} attempt(s)`)
    assert.ok(
      elapsedMs < 2000,
      `bounded by the injected patience, not the module default; took ${elapsedMs} ms`,
    )
  } finally {
    restore()
    for (const source of sources) source.stop()
  }
})
