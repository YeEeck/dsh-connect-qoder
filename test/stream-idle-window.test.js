/**
 * The idle window: how long the upstream may stay SILENT, and what a stall
 * means depending on whether the caller has already seen output.
 *
 * Run: node --test test/stream-idle-window.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * `streamChat` used to bound an attempt with `AbortSignal.timeout(60000)` — an
 * ABSOLUTE deadline, created per attempt and never cancelled. Its own comment
 * claimed the deadline "must NOT stay armed for the whole stream", but nothing
 * cancelled it: the timer aborted the RESPONSE BODY a minute after the attempt
 * started, so an answer that was arriving steadily was cut off mid-sentence and
 * the failure looked like a network fault. Total duration was the wrong
 * question: an upstream that keeps producing is not stuck, however long it
 * runs.
 *
 * The replacement measures SILENCE. What a stall MEANS then depends on the
 * phase, and that split is the load-bearing part of this ticket:
 *
 *   - BEFORE the first yielded chunk nothing has been handed to the caller, so
 *     a stall is retryable and takes the queue ladder (`queueWaitFor`) under
 *     the request's patience;
 *   - AFTER the first chunk the answer is partly delivered, so a stall is a
 *     plain non-retryable error: re-sending would regenerate the whole reply
 *     and repeat what the user already read.
 *
 * The six scenarios below drive `streamChat` through `globalThis.fetch` with
 * the helpers `test/chat-stream-reader.test.js` established (no gateway, no
 * install, deterministic) and inject tiny windows (`idleWindowMs: 60`,
 * `patienceMs: 200`) so every case settles in well under a second.
 *
 * What this file deliberately does NOT pin (ticket 03 owns them): the class
 * name and the exact sentence of the give-up error. It asserts only that the
 * failure is retryable, that more than one attempt happened, and that the wait
 * is bounded by the injected patience — so ticket 03 can replace the wording
 * without editing these tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { streamChat } from '../src/host/upstream.ts'
import { IDLE_WINDOW_MS, QUEUE_WAIT_BUDGET_MS, QUEUE_WAIT_MAX_SLEEP_MS } from '../src/host/upstream.ts'

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
 * One SSE response: the body is the given text, sent in the given chunks.
 * @param {string[]} chunks
 * @param {string} [contentType]
 */
function sseResponse(chunks, contentType = 'text/event-stream') {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': contentType } })
}

/**
 * One SSE response whose body stays open after the given chunks.
 * @param {string[]} chunks
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
  const response = new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  return {
    response,
    close: () => {
      try {
        open?.close()
      } catch {
        // Already closed.
      }
    },
  }
}

/**
 * One SSE response whose chunks arrive with a REAL silence between them.
 *
 * The first chunk is enqueued immediately; each later one waits `gapMs` on the
 * wall clock. This is what makes "silence shorter than the window" measurable
 * without simulating minutes.
 * @param {string[]} chunks
 * @param {number} gapMs
 */
function trickleResponse(chunks, gapMs) {
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, gapMs))
        controller.enqueue(new TextEncoder().encode(chunks[i]))
      }
      try {
        controller.close()
      } catch {
        // The turn was abandoned (a failing assertion path) before the close.
      }
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
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

/**
 * One answer frame, as the gateway sends it.
 * @param {string} text
 */
function frame(text) {
  return `data: ${JSON.stringify({ body: { choices: [{ index: 0, delta: { content: text } }] } })}\n`
}

test('the two module defaults satisfy the inequality their own comments claim', () => {
  // `retry.ts` states two constraints on the idle window in prose, and prose is
  // exactly what rots when a number is tuned: the window must be at least the
  // longest single sleep (or "sleep as long as the gateway asked, then
  // reconnect" would be killed by the window itself), and it must be below the
  // patience (or it could never fire before the patience ran out and would be a
  // knob that does nothing). The tier derivation that scales all three together
  // lives in `src/host/patience.ts` and is pinned by test/patience.test.js;
  // this pins the module defaults a request with no limits gets.
  assert.ok(
    IDLE_WINDOW_MS >= QUEUE_WAIT_MAX_SLEEP_MS,
    `the idle window (${IDLE_WINDOW_MS}) must not be shorter than one max sleep (${QUEUE_WAIT_MAX_SLEEP_MS})`,
  )
  assert.ok(
    IDLE_WINDOW_MS < QUEUE_WAIT_BUDGET_MS,
    `the idle window (${IDLE_WINDOW_MS}) must stay below the patience (${QUEUE_WAIT_BUDGET_MS})`,
  )
})

test('a healthy turn completes and is not touched by the window', async () => {
  const restore = stubFetch(async () => sseResponse([frame('hi'), frame(' there'), 'data: [DONE]\n']))
  try {
    const { chunks, error } = await withTimeout(
      drain(streamChat(REGION, CREDENTIAL, REQUEST, undefined, { idleWindowMs: 60, patienceMs: 200 })),
      2000,
      'a healthy turn must finish',
    )
    assert.equal(error, undefined, `the turn must not fail: ${error}`)
    assert.equal(textOf(chunks), 'hi there')
  } finally {
    restore()
  }
})

test('the window measures silence, not the length of the turn', async () => {
  // The old defect was an ABSOLUTE deadline: 60 s after the attempt started the
  // body was aborted no matter what was still arriving. Waiting 60 s of wall
  // time would make the suite unusable, so the window is INJECTED instead: with
  // a 120 s window a 120 ms silence is proportionally the same case. The second
  // half then makes the property measurable at test scale — a 60 ms window and
  // a trickle whose TOTAL life is ~160 ms: every single gap is shorter than the
  // window, the turn as a whole is longer, and it must still finish.
  const slow = stubFetch(async () =>
    trickleResponse([frame('a'), frame('b'), frame('c'), 'data: [DONE]\n'], 120),
  )
  try {
    const { chunks, error } = await withTimeout(
      drain(streamChat(REGION, CREDENTIAL, REQUEST, undefined, { idleWindowMs: 120000, patienceMs: 200 })),
      3000,
      'silences shorter than the window must not end the turn',
    )
    assert.equal(error, undefined, `the turn must not fail: ${error}`)
    assert.equal(textOf(chunks), 'abc')
  } finally {
    slow()
  }

  const trickle = stubFetch(async () =>
    trickleResponse([frame('1'), frame('2'), frame('3'), frame('4'), 'data: [DONE]\n'], 40),
  )
  try {
    const { chunks, error } = await withTimeout(
      drain(streamChat(REGION, CREDENTIAL, REQUEST, undefined, { idleWindowMs: 60, patienceMs: 400 })),
      3000,
      'a trickle whose total is longer than the window must still finish',
    )
    assert.equal(error, undefined, `the turn must not fail: ${error}`)
    assert.equal(textOf(chunks), '1234', 'every frame of a slow-but-alive turn must arrive')
  } finally {
    trickle()
  }
})

test('silence after the headers, then a recovery: the retry finishes the answer', async () => {
  // Headers arrived, so the handshake succeeded — but no frame ever came. This
  // is the pre-first-chunk phase: nothing reached the caller, so re-sending
  // duplicates nothing and the queue ladder is allowed to wait it out.
  let calls = 0
  const restore = stubFetch(async () => {
    calls += 1
    if (calls === 1) return openSseResponse([]).response
    return sseResponse([frame('hi'), frame(' tail'), 'data: [DONE]\n'])
  })
  try {
    // Patience only has to cover the 60 ms stall plus one retry sleep; the
    // ladder floors a hintless sleep at QUEUE_WAIT_MIN_SLEEP_MS, so a large
    // patience here would just make the test slow rather than prove anything.
    const { chunks, error } = await withTimeout(
      drain(streamChat(REGION, CREDENTIAL, REQUEST, undefined, { idleWindowMs: 60, patienceMs: 300 })),
      3000,
      'a silent first attempt must be abandoned and retried',
    )
    assert.equal(error, undefined, `the retry must be allowed to succeed: ${error}`)
    assert.equal(calls, 2, 'the silent attempt is abandoned and re-sent exactly once')
    assert.equal(textOf(chunks), 'hi tail', 'the recovered attempt\'s frames are forwarded in order')
  } finally {
    restore()
  }
})

test('silence after the headers forever: retryable, retried, bounded by the patience', async () => {
  // Every attempt gets headers and then nothing. Nothing is ever yielded, so the
  // verdict stays retryable and the queue ladder must spend the patience and
  // then stop — not hang, and not wait for the module's real budget.
  let calls = 0
  const restore = stubFetch(async () => {
    calls += 1
    return openSseResponse([]).response
  })
  const started = Date.now()
  try {
    const { chunks, error } = await withTimeout(
      drain(streamChat(REGION, CREDENTIAL, REQUEST, undefined, { idleWindowMs: 60, patienceMs: 200 })),
      5000,
      'the give-up must be bounded, not a silent hang',
    )
    const elapsedMs = Date.now() - started
    assert.equal(chunks.length, 0, 'nothing was ever yielded to the caller')
    assert.ok(error, 'the turn must fail once the patience is spent')
    assert.equal(error.retryable, true, 'a stall before the first chunk is a queue-shaped rejection')
    assert.ok(calls > 1, `the ladder must have re-sent at least once; got ${calls} attempt(s)`)
    // The bound is loose on purpose: what it separates is "bounded by the
    // injected patience (a few hundred ms)" from "any hidden default" (60 s /
    // 120 s), which differ by two orders of magnitude.
    assert.ok(elapsedMs < 2000, `bounded by the injected patience, took ${elapsedMs} ms`)
  } finally {
    restore()
  }
})

test('one chunk and then silence: a non-retryable error, no retry, no duplicated output', async () => {
  // The answer is already partly in the user's hands. Re-sending would regenerate
  // it from the start and repeat what was already read, so this phase must NOT
  // take the queue ladder, whatever the queue ladder would have done.
  let calls = 0
  const restore = stubFetch(async () => {
    calls += 1
    return openSseResponse([frame('hi')]).response
  })
  try {
    const { chunks, error } = await withTimeout(
      drain(streamChat(REGION, CREDENTIAL, REQUEST, undefined, { idleWindowMs: 60, patienceMs: 200 })),
      5000,
      'a stall after the first chunk must end the turn, not hang',
    )
    assert.equal(calls, 1, 'the turn is committed after the first chunk — it must not be re-sent')
    assert.equal(chunks.length, 1, 'exactly the chunk the caller already saw')
    assert.equal(textOf(chunks), 'hi', 'what was delivered must not be duplicated')
    assert.ok(error, 'the turn must fail with a visible error')
    assert.notEqual(error.retryable, true, 'after the first chunk a stall is NOT retryable')
    // The message names silence. Borrowing the queue wording here would tell the
    // user to wait for a queue that is not the problem (ticket 03 owns the
    // patience-exhausted wording; this ticket owns the silence wording).
    assert.match(String(error.message), /no content|没有输出任何内容/, 'the message must name the silence')
    assert.doesNotMatch(String(error.message), /queued|排队/i, 'this must not read as a queue rejection')
  } finally {
    restore()
  }
})

test('a slow consumer is not upstream silence: the window does not run while suspended', async () => {
  // The window measures the upstream's silence, so it must only run while a read
  // is actually outstanding. One chunk arrives; the consumer then takes longer
  // than a whole window before asking for the next one. If the deadline kept
  // running through the `yield`, the very next read would expire instantly — a
  // slow consumer would be blamed on the upstream, and ticket 02 (which keeps a
  // heartbeat-only stream on the same clock) would inherit that bug.
  let calls = 0
  const restore = stubFetch(async () => {
    calls += 1
    return openSseResponse([frame('hi')]).response
  })
  try {
    /** @type {AsyncIterator<any>} */
    const iterator = streamChat(REGION, CREDENTIAL, REQUEST, undefined, {
      idleWindowMs: 120,
      patienceMs: 200,
    })
    const started = Date.now()
    const first = await iterator.next()
    assert.equal(first.done, false, 'the chunk must arrive')
    // Longer than two windows: if the deadline survived the suspension, the next
    // read would already be expired before the upstream got a chance.
    await new Promise((resolve) => setTimeout(resolve, 260))
    const resumedAt = Date.now()
    let thrown
    try {
      await iterator.next()
    } catch (error) {
      thrown = error
    }
    const waitedAfterResume = Date.now() - resumedAt
    const total = Date.now() - started
    await iterator.return?.()
    assert.ok(thrown, 'the stall must still be judged, just from the resume')
    assert.equal(calls, 1, 'a stall after the first chunk is terminal — never re-sent')
    // The failure took about one full window AFTER the resume, not zero.
    assert.ok(
      waitedAfterResume >= 80,
      `the window must restart on resume, not be inherited: failed after ${waitedAfterResume} ms`,
    )
    assert.ok(total >= 260, 'the consumer\'s own delay must not be charged to the upstream')
  } finally {
    restore()
  }
})

test("the caller's own abort surfaces unchanged, and is never reclassified", async () => {
  // A client disconnect is the user's own doing. The phase split must not touch
  // it: it is not a stall (nothing expired) and not a queue (no waiting helps).
  // The shim reads the flags off the thrown value to answer 503 vs 502, so a
  // reclassified abort would both lie to the user and schedule a pointless retry.
  /** @type {any} */
  const reason = Object.assign(new Error('client went away'), { name: 'AbortError' })
  const restore = stubFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        // A real transport rejects the pending fetch when its signal aborts.
        init?.signal?.addEventListener('abort', () => reject(reason), { once: true })
      }),
  )
  const controller = new AbortController()
  try {
    const pending = drain(streamChat(REGION, CREDENTIAL, REQUEST, controller.signal, {
      idleWindowMs: 5000,
      patienceMs: 5000,
    }))
    setTimeout(() => controller.abort(reason), 30)
    const { chunks, error } = await withTimeout(pending, 3000, 'the abort must settle the turn')
    assert.equal(chunks.length, 0)
    assert.equal(error, reason, 'the caller\'s abort must arrive as itself, not as a stall or a queue')
    assert.equal(error.retryable, undefined, 'the caller abort must not acquire a retry flag')
    assert.doesNotMatch(String(error.message), /no content|没有输出任何内容/, 'it must not be rewritten as silence')
  } finally {
    restore()
  }
})

test('never any response headers: still a retryable queue rejection', async () => {
  // The pre-existing behaviour, which must not regress: a fetch that ignores the
  // abort signal entirely (no headers, ever) is judged stuck by the window, and
  // the failure is retryable exactly as it was before this ticket.
  let calls = 0
  const restore = stubFetch(async () => {
    calls += 1
    return new Promise(() => {})
  })
  try {
    const { chunks, error } = await withTimeout(
      drain(streamChat(REGION, CREDENTIAL, REQUEST, undefined, { idleWindowMs: 60, patienceMs: 200 })),
      5000,
      'a header-less attempt must be judged stuck, not hang',
    )
    assert.equal(chunks.length, 0)
    assert.ok(error, 'the turn must fail once the patience is spent')
    assert.equal(error.retryable, true, 'no headers is a queue-shaped rejection, exactly as before')
    assert.ok(calls > 1, `the ladder must have re-sent at least once; got ${calls} attempt(s)`)
  } finally {
    restore()
  }
})
