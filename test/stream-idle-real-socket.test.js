/**
 * The phase classification on a REAL socket.
 *
 * Run: node --test test/stream-idle-real-socket.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * Every other stall test drives `streamChat` through a stubbed global `fetch`
 * that returns a `ReadableStream` whose `read()` IGNORES the abort signal. That
 * is the seam the spec chose, and it is right for the shapes it pins — but it
 * cannot reproduce the production path, and the difference hid a load-bearing
 * defect through a full green suite:
 *
 *   `underIdleWindow` used to call `controller.abort()` and then reject with the
 *   module's own sentinel. On a real socket the abort rejects the outstanding
 *   `reader.read()` SYNCHRONOUSLY, so that rejection reached the race first and
 *   the sentinel was discarded. A stall therefore surfaced as a bare
 *   `AbortError`, which the phase classification cannot recognise: a stuck
 *   stream before the first frame became a non-retryable 502 instead of a
 *   retryable queue rejection, and a stall mid-answer lost its bilingual
 *   "the upstream went silent" sentence. The fake-stream tests stayed green
 *   because there the sentinel was the only settler.
 *
 * So this file drives the real transport: a loopback `http.Server` that writes
 * SSE headers and then goes quiet, with `fetch` pointed at it. It asserts the
 * two phases by their OUTCOME (retryable or not, and which sentence the user
 * reads), never by internal names.
 *
 * The server is released in a `finally` and every turn is bounded, so a failure
 * here is a red test rather than a hung suite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { streamChat } from '../src/host/upstream.ts'

/** @type {import('../src/host/domain.ts').Region} */
const REGION = {
  id: 'qoder',
  mode: 'global',
  displayName: 'Qoder',
  appNames: ['Qoder'],
  baseUrl: 'http://127.0.0.1/',
  openApiUrl: 'http://127.0.0.1/',
  centerUrl: 'http://127.0.0.1/',
  manageUrl: 'http://127.0.0.1/',
  downloadUrl: 'http://127.0.0.1/',
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
 * One answer frame, as the gateway sends it.
 * @param {string} text
 * @returns {string}
 */
const frame = (text) => `data: ${JSON.stringify({ body: { choices: [{ index: 0, delta: { content: text } }] } })}\n`

/**
 * Start a loopback server that answers with SSE headers and then behaves as
 * `handler` says; `fetch` is redirected to it for the duration of `run`.
 *
 * The redirect is what makes this a REAL-socket test while keeping the plugin's
 * own URL construction untouched: the request undici sends is the plugin's, and
 * the socket it reads is a real one whose body can stall.
 *
 * @param {(res: import('node:http').ServerResponse) => void} handler - writes the body, or not.
 * @param {() => Promise<T>} run - the turn to drive while the stub is installed.
 * @template T
 * @returns {Promise<T>}
 */
async function withLoopbackSse(handler, run) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    handler(res)
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(undefined) }) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const realFetch = globalThis.fetch
  /** @type {typeof globalThis.fetch} */
  const redirect = (_input, init) => realFetch(`http://127.0.0.1:${port}/algo/chat`, init)
  globalThis.fetch = redirect
  try {
    return await run()
  } finally {
    globalThis.fetch = realFetch
    // `close` alone waits for the (deliberately stalled) connection to end;
    // `closeAllConnections` is what actually releases this test's socket.
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

/**
 * Drive a turn to settlement, keeping what it yielded and what it threw.
 *
 * @param {{ idleWindowMs: number; patienceMs: number }} limits
 * @param {number} [timeoutMs]
 * @returns {Promise<{ chunks: any[]; error: any; elapsedMs: number }>}
 */
async function drainTurn(limits, timeoutMs = 6000) {
  /** @type {any[]} */
  const chunks = []
  /** @type {any} */
  let error
  const started = Date.now()
  const iterator = streamChat(REGION, CREDENTIAL, REQUEST, undefined, limits)
  await Promise.race([
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
    new Promise((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`the turn never settled (${timeoutMs}ms) — this is the hang this file exists to catch`)),
        timeoutMs,
      )
    }),
  ])
  await iterator.return?.(undefined).catch(() => {})
  return { chunks, error, elapsedMs: Date.now() - started }
}

test('a real socket that stalls AFTER one chunk is terminal, and says the upstream went silent', async () => {
  // The row "一个 chunk 后沉默 | 不可重试的错误，不重试，不重复产出". On a real
  // socket this used to arrive as a bare `AbortError` — no silence sentence, and
  // (through the shim) a 502 for a stall the plugin is supposed to name.
  const { chunks, error } = await withLoopbackSse(
    (res) => {
      res.write(frame('hi'))
      // Deliberately never ends: the socket stays open and silent.
    },
    () => drainTurn({ idleWindowMs: 120, patienceMs: 300 }),
  )
  assert.equal(chunks.length, 1, 'exactly the chunk the caller already saw')
  assert.ok(error, 'a stall after the first chunk must end the turn')
  assert.notEqual(error.retryable, true, 'the answer is partly delivered — re-sending would duplicate it')
  assert.match(
    String(error.message),
    /no content|没有输出任何内容/,
    `the sentence must name the silence, not a transport failure; got: ${String(error.name)}: ${String(error.message)}`,
  )
  assert.doesNotMatch(String(error.message), /aborted/i, 'an abort is not a verdict about the upstream')
})

test('a real socket that stalls BEFORE the first frame is retryable, and the rerun can succeed', async () => {
  // The rows "响应头后一直沉默 | 可重试的排队拒绝，尝试次数 > 1" and
  // "只发心跳不发内容 | 在空闲窗口到期时判定失败". The first attempt gets headers
  // and only heartbeats; the second answers. On a real socket the stall used to
  // surface as `AbortError`, which is NOT retryable, so the turn died on the
  // first attempt and this second half was unreachable.
  let calls = 0
  const { chunks, error } = await withLoopbackSse(
    (res) => {
      calls += 1
      if (calls === 1) {
        // Headers are already written; send only comments, then go quiet.
        const beat = setInterval(() => {
          try {
            res.write(': keep-alive\n')
          } catch {
            // The client gave up: the interval is cleared on close.
          }
        }, 15)
        res.on('close', () => clearInterval(beat))
        return
      }
      res.write(frame('hi'))
      res.write(frame(' tail'))
      res.end('data: [DONE]\n')
    },
    () => drainTurn({ idleWindowMs: 120, patienceMs: 4000 }),
  )
  assert.ok(calls > 1, `a pre-first-frame stall must be retried; got ${calls} attempt(s)`)
  assert.equal(error, undefined, `the recovered attempt must be allowed to succeed: ${error}`)
  assert.equal(
    chunks.map((chunk) => chunk?.choices?.[0]?.delta?.content ?? '').join(''),
    'hi tail',
    'the retried attempt frames are forwarded in order',
  )
})
