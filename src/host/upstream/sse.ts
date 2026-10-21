/**
 * sse — moved verbatim from `src/host/upstream.ts` during the protocol split
 * (docs/issues/22-upstream-split.md); only imports and exports were tidied. The
 * protocol facts live in the header of `crypto.ts`.
 *
 * NO LONGER A VERBATIM COPY: stream-idle-patience ticket 01 replaced the
 * per-attempt absolute deadline with an idle window that measures SILENCE (see
 * `IDLE_WINDOW_MS` in `retry.ts` and the idle clock in `streamChat`), and split
 * what a stall MEANS by phase — retryable before the first yielded frame,
 * terminal after it. Ticket 02 narrowed what counts as progress from "bytes
 * arrived" to "a frame was reached", so a stream that only sends heartbeats is
 * judged stuck HERE rather than by the Host's blind watchdog. Ticket 03 replaces
 * the give-up branch's wording.
 */

import crypto from 'node:crypto'
import { encodeBody } from './crypto.ts'
import { authHeaders } from './cosy-sign.ts'
import { chatUrl } from './endpoints.ts'
import { IDLE_WINDOW_MS, QUEUE_WAIT_BUDGET_MS, sleep, queueWaitFor } from './retry.ts'
import type { QoderMessage } from './messages.ts'
import { classifyUpstreamError, describeThrown, errorMessage, parseRetryAfterSeconds, ProtocolShapeChangedError, redactSecrets, SignInExpiredError, thrownFlag } from '../errors.ts'
import type { ChatTurnRequest, QoderCredential, Region, RequestLimits, UpstreamChunk } from '../domain.ts'

/**
 * Classify one error frame into `{ kind, retryAfterSeconds, code, detail }`.
 *
 * Shared by the HTTP-status path and the in-band frame path so both agree on
 * what a given payload means. A frame that carries no failure at all — no error
 * code and no explicit `success: false` — returns `undefined`, which is how the
 * frame reader tells a status frame apart from a chunk.
 *
 * @param chunk - one decoded frame, or a synthetic `{ code, message }` built
 *   from a non-2xx HTTP reply.
 * @param fallbackCode - code to assume when the payload names none (the HTTP
 *   status, on the transport path).
 */
function readFailure(chunk: unknown, fallbackCode = ''):
  | { kind: string; retryAfterSeconds: number; code: string; detail: string }
  | undefined {
  if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) return undefined
  // A frame is only a failure if it carries identifying detail. Bare status or
  // keepalive frames (`{ success: true }`, `{ success: false }` with no code
  // and no message, plain arrays, etc.) must not kill the stream.
  const frame = chunk as Record<string, unknown>
  const hasCode = frame.code != null || frame.errorCode != null
  const hasMessage =
    (typeof frame.message === 'string' && frame.message.length > 0) ||
    (typeof frame.errorMessage === 'string' && frame.errorMessage.length > 0)
  if (!hasCode && !hasMessage) {
    // No identifying fields at all. A `fallbackCode` (HTTP status) still
    // identifies the failure on the transport path; without it, this is not
    // an error frame.
    if (fallbackCode === '') return undefined
  }
  const { code, detail } = unwrapFailure(frame)
  const effective = code !== '' ? code : fallbackCode
  const kind = classifyUpstreamError(chunk, effective, detail)
  return { kind: kind.kind, retryAfterSeconds: kind.retryAfterSeconds ?? 0, code: effective, detail }
}
/**
 * The shape probe a chat turn hands to its frame reader.
 *
 * The doubly-wrapped SSE protocol is measured, not contracted, so the one
 * evidence that a turn's wire has moved is the frame itself: a `data:` payload
 * this build cannot read as an envelope, a chunk, or a named failure. A
 * healthy turn yields chunks and never consults the probe, so counting the
 * unreadable frames costs nothing; the verdict (in `streamChat`'s retry loop)
 * fires only when a WHOLE attempt stream carried frames and not one of them
 * was usable — the chat-side twin of the model-list freeze the catalog path
 * already triages (`protocol-shape-changed`).
 */
interface ChatShapeProbe {
  /** Data payloads the gateway streamed that this build does not read. */
  skipped: number
  /**
   * The first unreadable payload, as received — the evidence the verdict names.
   *
   * Present-but-`undefined` until a frame is noted, not absent: the probe is
   * built with the key spelled out, so `'sample' in probe` is true from the
   * start. `exactOptionalPropertyTypes` makes that distinction part of the
   * type, which is why this reads `| undefined` rather than a bare `?`.
   */
  sample?: string | undefined
}

/** Note one unreadable frame on the turn's probe; the first is the one kept. */
function noteUnreadableFrame(probe: ChatShapeProbe, payload: string): void {
  probe.skipped += 1
  if (probe.sample === undefined) probe.sample = payload.slice(0, 300)
}

/**
 * One chat turn, streamed.
 *
 * Yields plain objects in the OpenAI chunk vocabulary
 * (`{ choices: [{ delta, finish_reason }] }`) so the caller can forward them
 * without knowing about Qoder's envelope.
 *
 * @param region - the region descriptor.
 * @param credential - `{ userID, token, name, email, machineID }`.
 * @param request - `{ model, messages, tools, maxTokens, enableThinking, alwaysThinking, reasoningEffort, sessionId }`.
 *   `alwaysThinking` marks a model that rejects `enable_thinking: false`; for
 *   those the flag is omitted entirely rather than sent as `false`.
 * @param signal - the caller's abort. Whatever it rejects with is surfaced
 *   unchanged, never reclassified as a stall or a queue.
 * @param limits - this single request's idle window and patience. Absent means
 *   the module defaults ({@link IDLE_WINDOW_MS} / {@link QUEUE_WAIT_BUDGET_MS}),
 *   which are the default patience tier's numbers; the parameter exists so a
 *   request can be given its own limits (and so a test can drive the whole
 *   policy with tens of milliseconds).
 * @yields OpenAI-shaped chat completion chunks.
 */
export async function* streamChat(
  region: Region,
  credential: QoderCredential,
  request: ChatTurnRequest,
  signal?: AbortSignal,
  limits?: RequestLimits,
): AsyncGenerator<UpstreamChunk> {
  // The two numbers this request is judged by. Cheap to read up front, and
  // reading them ONCE is what keeps one request on one policy even if a caller
  // mutates the object it passed in.
  const idleWindowMs = limits?.idleWindowMs ?? IDLE_WINDOW_MS
  const patienceMs = limits?.patienceMs ?? QUEUE_WAIT_BUDGET_MS
  const model = request.model
  const recordID = crypto.randomUUID()
  const messages = request.messages as QoderMessage[]
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const lastText = typeof lastUser?.content === 'string' ? lastUser.content : ''

  // A model that always thinks answers `enable_thinking: false` with a
  // `provider_error` (1210) instead of a completion, so the flag is left off
  // for those and thinking is only ever requested positively.
  //
  // `max_tokens` is forwarded only when the caller actually specifies one. The
  // caller is the harness, and it now passes the declared `PROBED_MAX_TOKENS`
  // ceiling (see `pi-model.ts`) through as `request.maxTokens`. Forwarding is
  // the whole job: an over-small value is harmful because reasoning and the
  // answer share this budget upstream, so we never invent or lower it here —
  // and an absent value sends NO key rather than a made-up default.
  // Mixed value types by design (booleans and numbers, and only the keys the
  // caller actually asked for), so the honest type is a record of unknowns.
  // The three assignments below are what prove each value is the right one.
  const parameters: Record<string, unknown> = {}
  // Bound first: `Number.isSafeInteger` is not a type predicate, so testing
  // `request.maxTokens` directly leaves it `number | undefined` inside the
  // branch. Testing the local narrows it, and the comment above is why an
  // absent value must send NO key rather than a default.
  const maxTokens = request.maxTokens
  if (maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
    parameters.max_tokens = maxTokens
  }
  if (request.enableThinking === true) {
    parameters.enable_thinking = true
    if (typeof request.reasoningEffort === 'string' && request.reasoningEffort.length > 0) {
      parameters.reasoning_effort = request.reasoningEffort
    }
  } else if (request.alwaysThinking !== true) {
    parameters.enable_thinking = false
  }

  // The literal is annotated rather than inferred: every `null` and every `[]`
  // below is a REQUIRED field the gateway expects to see present, and inference
  // widens them to `any`/`never[]` precisely because their emptiness is the
  // point. `image_urls: null` is not "no images" vs "images" — the key has to
  // be there as null, and a future edit that drops it should be a type error.
  const body: {
    image_urls: null
    messages: unknown
    tools: unknown
    chat_context: {
      chatPrompt: string
      imageUrls: null
      extra: { context: unknown[]; modelConfig: { key: unknown; is_reasoning: boolean }; originalContent: string }
      features: unknown[]
      text: string
    }
    [field: string]: unknown
  } = {
    request_id: crypto.randomUUID(),
    request_set_id: recordID,
    chat_record_id: recordID,
    session_id: request.sessionId ?? `dsh-${crypto.randomUUID()}`,
    stream: true,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    // The upstream ignores a top-level `system` field; a leading role:system
    // message is what it actually honours.
    system: '',
    messages: request.messages,
    tools: request.tools ?? [],
    parameters,
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: model, is_reasoning: request.enableThinking === true },
        originalContent: lastText,
      },
      features: [],
      text: lastText,
    },
    model_config: { key: model, source: 'system', is_reasoning: request.enableThinking === true },
    business: {
      product: 'cli',
      version: '1.0.0',
      type: 'agent',
      stage: 'start',
      id: crypto.randomUUID(),
      name: lastText.slice(0, 30),
      begin_at: Date.now(),
    },
  }

  const url = chatUrl(region)
  const bodyBytes = encodeBody(Buffer.from(JSON.stringify(body)))

  // The turn's shape probe: shared across the attempts of this loop, because
  // the verdict is reached only when a WHOLE stream carried frames and none of
  // them was usable (see ChatShapeProbe).
  const shapeProbe: ChatShapeProbe = { skipped: 0, sample: undefined }

  // ---- the idle clock ------------------------------------------------------
  //
  // What counts as progress is a FRAME, never a byte. The clock is stamped
  // BEFORE the handshake (no body byte can exist yet, so that is a phase
  // boundary rather than a claim about the wire), re-stamped when the handshake
  // settles, and from then on ONLY where a frame is recognised and yielded —
  // the `choices`/`usage` branch in `readFrames`. SSE comments
  // (`: keep-alive`), blank lines, non-`data:` lines, unparseable payloads,
  // `[DONE]` and failure frames are the upstream breathing, not working: they
  // refill no window, so a gateway that only keeps its connection alive is
  // judged stuck HERE — retryable before the first frame, terminal after it —
  // instead of outliving this plugin's window and dying at the Host's blind
  // watchdog, which would retry the whole turn and spend the daily allowance
  // again.
  //
  // It is ALSO stamped whenever this generator resumes from a `yield` (see
  // `noteResume`): a consumer that takes its time is not upstream silence, and
  // without that stamp a slow consumer would spend the window and the next read
  // would expire on the spot without giving the upstream a chance to answer.
  // Only time in which a read was actually outstanding is upstream's to answer
  // for. `noteResume` runs only after a real chunk has been yielded, so a
  // heartbeat cannot reach it.
  let lastProgressAt = Date.now()
  const idleRemaining = () => Math.max(0, idleWindowMs - (Date.now() - lastProgressAt))
  /** The generator is about to hand control back to its consumer, not to the wire. */
  const noteResume = () => {
    lastProgressAt = Date.now()
  }

  /**
   * Await one step of the attempt (the handshake, or one body read) under this
   * request's idle window.
   *
   * WHY A RACE AND NOT JUST AN ABORT. Aborting alone does not release a hung
   * read reliably (measured), and it does not release a `fetch` stub that
   * ignores its signal at all. The race is what SETTLES the step; the abort is
   * what releases a real socket. Both are needed, for different jobs.
   *
   * The losing read is deliberately left dangling on the socket — the abort is
   * what closes it — which is why `work` gets a `.catch()`. Without that,
   * Node reports the eventual rejection as unhandled and fails the process for
   * a reason that has nothing to do with this turn.
   *
   * @param work - the step to await; it may reject on its own.
   * @param controller - the attempt's controller, aborted when the window
   *   expires so the transport lets go of the connection.
   */
  function underIdleWindow<T>(work: Promise<T>, controller: AbortController): Promise<T> {
    work.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new IdleWindowExpiredError(idleWindowMs))
      }, idleRemaining())
    })
    return Promise.race([work, expired]).finally(() => {
      // Disarmed the moment the step settles, the same way the handshake
      // deadline is disarmed when headers arrive. This is the property the old
      // `AbortSignal.timeout` comment claimed and did not have.
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  /**
   * Open one attempt and hand back its frame stream.
   *
   * Nothing is yielded until the first frame arrives, so a queue rejection
   * raised here is still safe to retry: the caller has seen no output yet.
   *
   * @param response - the handshake's response.
   * @param probe - the turn's shape probe; shared by every attempt.
   * @param controller - the abort handle that releases this attempt's socket.
   */
  async function* readFrames(
    response: Response,
    probe: ChatShapeProbe,
    controller: AbortController,
  ): AsyncGenerator<UpstreamChunk> {
    // A response with no body is not a stream that ended — it is an answer this
    // transport cannot read, and `getReader()` on `null` would throw a
    // TypeError that the caller would classify as an ordinary fetch failure.
    // Naming it here keeps the retry path and the error message honest; the
    // caller's `try` already covers it, since a generator body does not run
    // until the first `next()`.
    const body = response.body
    if (body === null) {
      throw new Error(`dsh-connect-qoder: response ${response.status} carried no body to stream`)
    }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let streamDone = false
    let endOfStream = false
    try {
      while (!streamDone) {
        // Every read is bounded by the idle window, so a body that goes quiet
        // mid-answer is judged stuck instead of parking this generator on a
        // socket that will never speak again.
        const { done, value } = await underIdleWindow(reader.read(), controller)
        // Deliberately NO stamp here: bytes are not frames. A `: keep-alive`
        // comment, a blank line and a payload this build cannot parse all arrive
        // as bytes and none of them is progress. The clock is re-armed only
        // where a frame is recognised and yielded, below.
        if (done) {
          // The stream ENDED: flush the decoder and hand the residual buffer
          // to the SAME line path below. A last frame that arrives without a
          // trailing newline used to be dropped here, and the drop was silent:
          // the user saw a complete-looking answer that was missing its last
          // sentence, and nothing anywhere said so. Flushing the decoder too
          // releases a multi-byte character that was cut between the last two
          // chunks (it would otherwise be replaced by nothing at all).
          endOfStream = true
          buffer += decoder.decode()
          if (buffer.trim() !== '') buffer += '\n'
        } else {
          buffer += decoder.decode(value, { stream: true })
        }
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload.length === 0) continue
          if (payload === '[DONE]') { streamDone = true; break }

          // The frame is an envelope whose `body` is itself JSON — but a few
          // frames carry the chunk inline, so both shapes are accepted. Every
          // data payload this build ends up not reading is noted on the probe
          // rather than dropped: the verdict at the end of a stream that
          // yielded nothing is the drift triage (see ChatShapeProbe).
          let envelope
          try {
            envelope = JSON.parse(payload)
          } catch {
            noteUnreadableFrame(probe, payload)
            continue
          }
          let chunk = envelope
          if (typeof envelope?.body === 'string') {
            try {
              chunk = JSON.parse(envelope.body)
            } catch {
              noteUnreadableFrame(probe, payload)
              continue
            }
          } else if (envelope?.body !== undefined && typeof envelope.body === 'object') {
            chunk = envelope.body
          }
          // A token-accounting frame carries `choices: []` (or omits the field)
          // and a top-level `usage`. It must be forwarded, not treated as a
          // failure: the shim turns it into the counts DSH records per turn.
          //
          // THIS is the only place a body read re-arms the idle clock. Everything
          // the reader throws away — comments, blank lines, unparseable payloads,
          // `[DONE]`, failure frames — leaves it alone on purpose.
          if (chunk?.choices !== undefined || (chunk?.usage !== undefined && chunk.usage !== null)) {
            yield chunk
            // Back from the consumer: whatever it spent deciding is not silence.
            noteResume()
            continue
          }

          // A failure arrives as an ordinary 200 frame carrying an error object
          // rather than a chunk. Silently dropping it would present the user
          // with an empty assistant turn, so it is raised instead. A frame that
          // is none of chunk, usage, or a NAMED failure — a renamed field, a
          // new wrapper — is noted like the unparseable ones: the verdict that
          // fires when the whole stream is like this says the wire moved.
          const failure = readFailure(chunk)
          if (failure === undefined) {
            noteUnreadableFrame(probe, payload)
            continue
          }
          // Checked before the queue branch on purpose: a spent daily allowance
          // arrives WITH queue markers and a multi-hour Retry-After, so anything
          // that classified on the marker fallback first would turn it into a
          // long sleep. It must not be retried at all.
          if (failure.kind === 'daily-limit') throw new DailyLimitRejection(failure.detail, failure.retryAfterSeconds)
          if (failure.kind === 'rate-limit') {
            // Retryable: the caller waits it out and re-sends, so this is not
            // reported as a rejection.
            throw new QueueRejection(failure.retryAfterSeconds, failure.detail)
          }
          const message = failureMessage(failure, region)
          // The flag is on the class, not hung on a bare `Error` through an
          // `any` local: `isStaleCredentialError` reads it, and this way the
          // reader and this throw cannot drift apart.
          if (failure.kind === 'sign-in-expired') throw new SignInExpiredError(message)
          throw new Error(message)
        }
        // The end of the body is the end of the turn: the residual buffer was
        // handed to the line path above, so there is nothing left to wait for.
        if (endOfStream) break
      }
    } finally {
      // On a retryable rejection the body is abandoned mid-stream; cancelling
      // releases the socket now instead of leaving it to the garbage collector,
      // which matters because the retry loop may open several of these.
      //
      // BOUNDED, and the bound is not a nicety: cancelling awaits the transport,
      // and a stuck socket can park this `finally` forever — in which case the
      // classified error never reaches the retry loop and the user sees an
      // idle hang instead of a verdict. The cancel is raced against a short
      // timer that is cleared on success; the controller has already been
      // aborted by the time this runs on the stuck path, which is what actually
      // releases a real connection.
      let cancelTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          reader.cancel(),
          new Promise<void>((resolve) => {
            cancelTimer = setTimeout(resolve, CLEANUP_TIMEOUT_MS)
          }),
        ])
      } catch {
        // Already closed or errored — nothing left to release.
      } finally {
        if (cancelTimer !== undefined) clearTimeout(cancelTimer)
      }
    }
  }

  /**
   * Send one request. Throws for terminal failures, returns the open stream.
   *
   * The attempt's controller is created here and handed back WITH the response:
   * the body outlives this scope, so the idle window has to be able to abort the
   * body for as long as this attempt is the one being read. It is aborted (and
   * therefore released) when `readFrames` gives up on the body.
   *
   * @returns `{ response, controller }` — the body handshake cleared for, and
   *   the abort handle that releases it.
   */
  async function openAttempt() {
    let response
    // Build headers outside the try so that a programming error (e.g.
    // `credential` is undefined) throws directly rather than being caught
    // and misclassified as a transient network failure.
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Accept-Encoding': 'identity',
      'X-Model-Key': String(model),
      'X-Model-Source': 'system',
      ...authHeaders(bodyBytes, url, credential),
    }
    // One controller for this attempt. Its ONLY trigger is the idle window in
    // `underIdleWindow`: it owns no timer, so nothing here can fire on its own.
    const controller = new AbortController()
    // What `fetch` actually sees: the caller's abort, and this attempt's
    // controller. `AbortSignal.any` is right for THIS pair because the composite
    // dies with the request — there is no deadline inside it to disarm, which is
    // exactly what was wrong before. The old code passed
    // `AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)])`: a
    // healthy body was aborted a minute into the answer because that timer was
    // still armed long after the headers arrived.
    const attemptSignal =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    // The handshake gets the same idle window as the body, re-stamped the moment
    // headers arrive (see `lastProgressAt`). This stamp is a PHASE BOUNDARY, not
    // a progress claim: headers mean the upstream accepted the request, and no
    // body byte could have arrived before them. From here on, only a frame
    // re-arms the clock. The returned response body outlives this scope, so this
    // deadline MUST NOT stay armed past the headers — which is exactly what the
    // race in `underIdleWindow` guarantees, since it clears its timer as soon as
    // `fetch` settles.
    lastProgressAt = Date.now()
    try {
      response = await underIdleWindow(
        fetch(url, {
          method: 'POST',
          headers,
          // `Buffer` is a `Uint8Array` and `fetch` accepts binary bodies at
          // runtime, but `BodyInit` in the DOM/Node lib types does not list it —
          // it is spelled as the `URLSearchParams` / `Blob` / `ReadableStream`
          // union. The bytes handed over are exactly the encoded body
          // `authHeaders` just signed, and the signature is computed over THESE
          // bytes, so re-encoding or re-copying them here would break the
          // pairing. One cast at the type boundary, with no runtime effect.
          body: bodyBytes as unknown as BodyInit,
          redirect: 'error',
          signal: attemptSignal,
        }),
        controller,
      )
    } catch (thrown) {
      throw classifyHandshakeFailure(thrown, signal)
    }
    // The handshake is over: its deadline was disarmed as soon as `fetch`
    // settled (see `underIdleWindow`), and the body's clock starts now — a
    // fresh window, not a progress claim, because the next stamp that counts as
    // progress has to be a frame. THIS is the disarm the old code promised in a
    // comment and never performed.
    lastProgressAt = Date.now()

    if (!response.ok) {
      // The error body is a READ like any other, so it is bounded by the same
      // idle window: a gateway that answers 429 and then dribbles (or stalls)
      // its body would otherwise park the turn with no verdict at all, which is
      // the exact failure mode this ticket exists to remove. The clock was
      // re-stamped above, so this gets a full window of its own.
      //
      // Redact BEFORE the slice: the body is copied into the error messages
      // below, and a credential riding its tail would otherwise be cut in half
      // and slip past every shape rule. The read goes through `redactSecrets`
      // on the spot — not into a raw variable — because `test/redaction-closure`
      // fences exactly that shape, and the fence is right: a captured raw body
      // is one later use away from an unredacted message.
      const text = redactSecrets(await underIdleWindow(response.text(), controller)).slice(0, 500)

      // A non-2xx reply carries the same nested envelope as an in-band error
      // frame, so it is unwrapped the same way: the outer status is often a
      // bare 403 whose real meaning (`10605`, queued) lives two JSON strings
      // deeper. It is unwrapped BEFORE the transient-status branch below,
      // because the status is not a reliable signal for the terminal verdicts a
      // body can carry — see the daily-limit check.
      const failure = readFailure({ code: String(response.status), message: text }, String(response.status))
      // (An expired window while reading `text` throws `IdleWindowExpiredError`
      // out of this block; the retry loop's phase-1 classification turns it into
      // a retryable rejection, because no frame has been yielded yet.)

      // A spent daily allowance is checked ahead of the transient branch, at
      // every status, for the same reason the frame path checks it ahead of its
      // queue branch: it carries queue markers and a multi-hour hint, and it
      // must not become a sleep. Reading the status FIRST is what let the newer
      // gateway's `429` + `daily_limit_exceeded` reply run the escalation ladder
      // for its full queue patience and twelve attempts, then hand DSH a
      // `rate_limit` it retried five more times (docs/issues/23-upstream-429-daily-limit.md);
      // the failure does not become less final by arriving under a 429.
      if (failure !== undefined && failure.kind === 'daily-limit') {
        throw new DailyLimitRejection(failure.detail, failure.retryAfterSeconds)
      }

      // Transient HTTP failures (429, 5xx) are safe to retry before the first
      // frame: the caller has seen no output yet. Honour a `Retry-After` hint
      // when present; otherwise let the escalation ladder in `queueWaitFor`
      // take over.
      if (response.status === 429 || response.status >= 500) {
        // `parseRetryAfterSeconds` in `errors.ts` is the one parser for this
        // header across the plugin (a numeric delta, a numeric string, or an
        // HTTP-date; `undefined` = the platform said nothing). It was duplicated
        // here until the issue-22 split; the two copies agreed by accident.
        const retryAfter = parseRetryAfterSeconds(response.headers.get('retry-after')) ?? 0
        throw new QueueRejection(retryAfter, `HTTP ${response.status} — ${text}`)
      }

      if (failure === undefined) {
        throw new Error(`Qoder chat failed: HTTP ${response.status} ${response.statusText} — ${text}`)
      }
      if (failure.kind === 'rate-limit') throw new QueueRejection(failure.retryAfterSeconds, failure.detail)
      const message = failureMessage(failure, region, response.status, response.statusText)
      // Same reasoning as the frame path above.
      if (failure.kind === 'sign-in-expired') throw new SignInExpiredError(message)
      throw new Error(message)
    }
    // A 200 that claims a document content-type is the endpoint answering with
    // something other than the SSE stream: an SSO/HTML page, a JSON error
    // document, a non-streaming answer to a `stream: true` request. Left to
    // the frame reader, every one of those surfaces as an "empty response"
    // that names nothing about why. The check stays narrow on purpose — only
    // the content types the documented drift modes arrive as are triaged; an
    // absent header or an event-stream one passes untouched, and the frame
    // probe below is the second half of the same verdict.
    const contentType = response.headers.get('content-type') ?? ''
    if (/json|html|xml/i.test(contentType)) {
      throw new ProtocolShapeChangedError(
        `chat answered \`200 ${contentType}\` where \`text/event-stream\` was expected`,
      )
    }
    if (response.body === null) throw new Error('Qoder chat returned no body')
    return { response, controller }
  }

  // Qoder queues rather than rejecting, and tells us how long to wait. That wait
  // belongs here, not in DSH's retry loop: DSH's policy is fixed (5 attempts,
  // 500 ms doubling to 10 s, ignoring the hint) and its patience is often
  // shorter than the queue. Waiting internally also keeps the turn alive, so the
  // user does not have to send the message again and restart it.
  let waitedMs = 0
  for (let attempt = 1; ; attempt++) {
    let stream
    let first
    // Everything this request costs — the handshake, the first frame, and any
    // retry delay — is charged to the patience, not just the delay. Counting
    // only the sleep is what made the patience decorative: a slow-but-progressing
    // attempt could spend unbounded time without ever exhausting it.
    const attemptStartedAt = Date.now()
    try {
      const opened = await openAttempt()
      stream = readFrames(opened.response, shapeProbe, opened.controller)
      // Pull the first frame before committing to a response, so a queue
      // rejection surfaces here rather than mid-stream where it could not be
      // retried without duplicating output.
      first = await stream.next()
    } catch (thrown) {
      waitedMs += Date.now() - attemptStartedAt
      // PHASE 1 of the stall classification, applied BEFORE the ladder is asked:
      // nothing has been yielded yet, so an idle expiry is retryable and is
      // translated into the queue shape, exactly like a real queue rejection.
      // Every other failure passes through unchanged.
      const error = signal?.aborted === true ? thrown : reclassifyIdle(thrown, idleWindowMs, region)
      const queueWaitMs = queueWaitFor(error, waitedMs, attempt, patienceMs)
      if (queueWaitMs === undefined) throw error
      // The caller aborted while we were deciding, so stop rather than sleep.
      if (signal?.aborted) throw error
      await sleep(queueWaitMs, signal)
      waitedMs += queueWaitMs
      continue
    }
    waitedMs += Date.now() - attemptStartedAt

    if (first.done === true) {
      // The gateway accepted the request but yielded no usable frame. Two
      // shapes are kept apart, because their answers differ: a stream that
      // carried frames this build does not parse says the WIRE moved — a
      // renamed envelope, a new wrapper, an error shape this code does not
      // name — and that is the drift verdict the card's "update the plugin"
      // copy exists for; a stream that carried no data payloads at all is an
      // empty answer, not a defect of this build. Before the split, both
      // cases read as "empty response" and a changed protocol kept the turn
      // failing silently — the chat-side twin of the model-list freeze the
      // catalog path triages as `protocol-shape-changed`.
      if (shapeProbe.skipped > 0) {
        throw new ProtocolShapeChangedError(
          `${region.displayName} chat stream: ${shapeProbe.skipped} frame(s) this build does not parse; first: ${shapeProbe.sample ?? '(none kept)'}`,
        )
      }
      throw new Error(`${region.displayName} returned an empty response`)
    }

    // Once the first chunk is out the turn is committed — there is no going
    // back — so the remaining frames are forwarded as they arrive. The `finally`
    // covers the case where the consumer stops early (the shim aborts on client
    // disconnect): without it the upstream socket would stay open until the
    // gateway closed it on its own.
    //
    // PHASE 2 of the stall classification: the answer is partly delivered, so an
    // idle expiry here is NOT retryable — re-sending regenerates the reply from
    // the start and repeats what the user already read. It is wrapped so it
    // surfaces as a plain error about silence; the caller's own abort passes
    // through untouched.
    try {
      yield first.value
      noteResume()
      for (;;) {
        const step = await stream.next()
        if (step.done === true) break
        yield step.value
        noteResume()
      }
    } catch (error) {
      if (signal?.aborted === true) throw error
      // An error frame raised by the reader is a real upstream verdict, not a
      // stall; only the idle window's own error is re-worded here.
      if (!(error instanceof IdleWindowExpiredError)) throw error
      throw new Error(stalledMidAnswerMessage(error.idleWindowMs, region))
    } finally {
      await stream.return(undefined).catch(() => {})
    }
    return
  }
}

/**
 * How long the bounded body cleanup waits before abandoning the cancel.
 *
 * Cancelling is how the socket is released early, so it normally answers at
 * once; a socket that never does must not keep this generator parked in its
 * `finally`, because the classified error is what the retry loop needs to see.
 * The abort that accompanied the idle expiry is what actually closes a real
 * connection, so giving up on the cancel costs nothing but a little garbage.
 */
const CLEANUP_TIMEOUT_MS = 1000

/**
 * The idle window expired while one step of an attempt was outstanding.
 *
 * PRIVATE on purpose (named, not exported): it is the marker that tells this
 * module's own stall apart from every other throw, and it must not become part
 * of any caller's vocabulary. The classification — retryable before the first
 * frame, terminal after it — happens where the phase is known.
 */
class IdleWindowExpiredError extends Error {
  /** The window that expired, so the user-facing sentence can name it. */
  idleWindowMs: number

  constructor(idleWindowMs: number) {
    super(
      `Qoder's stream sent nothing for about ${Math.round(idleWindowMs / 1000)}s`,
    )
    this.name = 'IdleWindowExpiredError'
    this.idleWindowMs = idleWindowMs
  }
}

/**
 * The pre-first-frame half of the phase classification.
 *
 * A stall before anything was yielded is retryable for the same reason a reset
 * socket is: the caller has seen no output, so trying again duplicates nothing.
 * It is translated into the queue shape — a `QueueRejection` carrying the
 * silence as its detail — so that `queueWaitFor`'s ladder waits it out under
 * the request's patience, exactly as it waits a real queue. "No response
 * headers at all" therefore keeps the path it already had.
 *
 * Anything that is NOT this module's idle expiry is returned unchanged: a
 * caller abort, a sign-in rejection, a daily limit and a protocol-shape verdict
 * all have their own answers and must not be re-read as a stall.
 *
 * @param error - whatever the attempt threw.
 * @param idleWindowMs - the window this request is judged by.
 * @param region - for the display name in the detail.
 */
function reclassifyIdle(error: unknown, idleWindowMs: number, region: Region): unknown {
  if (!(error instanceof IdleWindowExpiredError)) return error
  const seconds = Math.round(idleWindowMs / 1000)
  return new QueueRejection(
    0,
    `${region.displayName} sent no content for about ${seconds >= 1 ? `${seconds}s` : `${idleWindowMs}ms`} before the first frame`,
  )
}

/**
 * The post-first-frame half: a stall is terminal, and the sentence says so.
 *
 * Two facts have to survive into the wording, because they are what the user
 * decides on: WHAT happened (the upstream went silent) and WHY re-sending is not
 * free (it regenerates the answer and repeats what was already read). Both
 * languages, English first — the host-side convention for user-visible failure
 * messages. This deliberately borrows none of the queue vocabulary: waiting is
 * not the remedy here, and ticket 03's patience-exhausted message is the one
 * that talks about queues.
 */
function stalledMidAnswerMessage(idleWindowMs: number, region: Region): string {
  // Real windows are tens of seconds, so the sentence names seconds; a test that
  // injects tens of MILLISECONDS would round to "about 0s", which reads as a
  // broken message rather than a small window, so the sub-second case says what
  // it actually is.
  const seconds = Math.round(idleWindowMs / 1000)
  const silence = seconds >= 1 ? `${seconds}s` : `${idleWindowMs}ms`
  return (
    `${region.displayName}'s stream sent no content for about ${silence}, so this reply was cut off; ` +
    'sending it again regenerates from the start and repeats what you already saw. ' +
    `上游已经约 ${silence} 没有输出任何内容，这条回答被判为卡死并中断；重发会从头再生成，已输出的部分会重复。`
  )
}

/**
 * Classify whatever came out of the handshake.
 *
 * Only the HANDSHAKE goes through this. A transport failure while reading the
 * BODY is deliberately left alone: once the attempt is committed the retry
 * decision belongs to the phase split (an idle expiry is the only thing this
 * module re-reads mid-body), and dressing a mid-body socket reset up as a
 * retryable queue would tell the shim to answer 503 for a turn whose output has
 * already started. That is pre-existing behaviour, preserved on purpose.
 *
 * The caller's abort always wins inside this function: it is the user's own
 * doing and must surface unchanged, even when the underlying socket error
 * happens to look transient.
 *
 * @param error - the thrown value.
 * @param signal - the caller's abort signal, when there is one.
 */
function classifyHandshakeFailure(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted === true) return error
  // The idle window expiring is not a network verdict; the callers classify it
  // by phase (see `reclassifyIdle`).
  if (error instanceof IdleWindowExpiredError) return error
  // Network-level failures (ECONNRESET, DNS, proxy timeout, undici socket
  // errors) are transient and safe to retry before the first frame. The
  // caller's `queueWaitFor` will apply the escalation ladder.
  // `cause` is an undici `Error` wrapping the socket failure, and its `code`
  // is where the real diagnosis lives; `error.code` is the fallback for a
  // throw that carried no cause. Both reads are narrowed rather than
  // assumed, so a non-object throw answers `undefined` for each and falls
  // through to the `message` test below instead of matching a code by luck.
  const cause = thrownFlag(error, 'cause')
  const code = thrownFlag(cause, 'code') ?? thrownFlag(error, 'code') ?? ''
  if (
    code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE' ||
    code === 'ENOTFOUND' || code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' ||
    String(thrownFlag(error, 'message') ?? '').includes('fetch failed')
  ) {
    // Prefer the cause's own message — it names the socket failure — and
    // fall back to the wrapper's when the throw carried no usable cause.
    const detail = errorMessage(cause) !== '' ? errorMessage(cause) : describeThrown(error)
    return new QueueRejection(0, `network: ${detail}`)
  }
  // A bare `TypeError` used to land in that list, on the theory that undici
  // wraps transport failures in one. It does not: `TypeError` is also what a
  // malformed URL or an illegal header value throws, so a plain coding bug
  // was retried as though the network were flaky — silently, for the whole
  // patience. Only the transport-shaped ones are retried now; everything else
  // propagates and is reported as itself.
  return error
}

/**
 * A queue rejection that can be waited out.
 *
 * `retryable` is what the shim reads to decide between a retryable status and a
 * hard failure, so this stays a plain `Error` carrying the same flags the shim
 * already understood.
 */
class QueueRejection extends Error {
  /** Always true: waiting can clear a queue. */
  retryable: boolean
  /** Seconds to wait before retrying. */
  retryAfterSeconds: number
  /** The upstream detail, in a form a human can act on. */
  upstreamDetail: unknown

  constructor(retryAfterSeconds: number, detail: unknown) {
    super(
      `Qoder is busy — the request was queued` +
        `${retryAfterSeconds > 0 ? ` (retry in ~${retryAfterSeconds}s)` : ''}`,
    )
    this.name = 'QueueRejection'
    this.retryable = true
    this.retryAfterSeconds = retryAfterSeconds
    this.upstreamDetail = detail
  }
}

/**
 * The account's daily billing allowance is spent. NOT a queue: the counter resets
 * at the day boundary rather than draining, so `retryable: false` stops this
 * plugin's own queue ladder; the host's retries need two locks — this route's
 * policy (src/host/route-retry-policy.ts, docs/issues/24-terminal-failure-status-codes.md)
 * does not retry the verdict, and the message says "daily quota exhausted", the wording the host's quota predicate reads. */
class DailyLimitRejection extends Error {
  /** Always false: waiting within the session cannot fix a daily limit. */
  retryable: boolean
  /** Marks this as a daily-limit (not queue) failure. */
  dailyLimit: boolean
  /** Seconds until the counter resets (from the gateway, else 0). */
  retryAfterSeconds: number
  /** The upstream detail, in a form a human can act on. */
  upstreamDetail: unknown

  constructor(detail: unknown, retryAfterSeconds = 0) {
    super(
      // "daily quota exhausted" is a host-classifier contract, not decoration:
      // see the class doc. Keep the two words adjacent — the host's predicate is
      // `(?:quota|usage limit)[\s_-]+(?:exceeded|exhausted|reached)`.
      `Qoder's daily request allowance for this account is used up (daily quota exhausted)` +
        `${retryAfterSeconds > 0 ? ` — it resets in about ${Math.round(retryAfterSeconds / 3600)}h` : ''}. ` +
        'Waiting within the session will not help; the off-peak price (22:00–08:00 Asia/Shanghai) ' +
        'and the daily check-in both still work.',
    )
    this.name = 'DailyLimitRejection'
    this.retryable = false
    this.dailyLimit = true
    // Kept for the UI to show "resets at HH:MM" rather than a raw count.
    this.retryAfterSeconds = retryAfterSeconds
    this.upstreamDetail = detail
  }
}

/**
 * Build the readable sentence for a non-queue failure.
 *
 * Both parameters are the real shapes rather than `any`: `failure` is exactly
 * what {@link readFailure} returns (the only producer), and `region` is the
 * plugin's own `Region`. The `any` here meant the five field reads below —
 * including `failure.detail.length`, which throws on a non-string — were never
 * checked against the object that actually flows in.
 */
function failureMessage(
  failure: { kind: string; code: string; detail: string },
  region: Region,
  status?: number,
  statusText?: string,
) {
  if (failure.kind === 'sign-in-expired') {
    return (
      `${region.displayName} sign-in is no longer valid — open the ${region.displayName} app ` +
      `to sign in again, then restart DSH` +
      `${status !== undefined ? ` (HTTP ${status}: ${failure.detail})` : ` (upstream ${failure.code || 'error'}: ${failure.detail})`}`
    )
  }
  if (status === 401 || status === 403) {
    return (
      `${region.displayName} was refused by Qoder — check that this account can use this model ` +
      `(HTTP ${status}: ${failure.detail})`
    )
  }
  if (status !== undefined) {
    return `Qoder chat failed: HTTP ${status} ${statusText ?? ''} — ${failure.detail}`
  }
  return `Qoder upstream error${failure.code !== '' ? ` ${failure.code}` : ''}${failure.detail.length > 0 ? `: ${failure.detail}` : ''}`
}

/**
 * Parse a string that is expected to hold a JSON object, else `undefined`.
 */
function tryJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** Whether a value is a plain (non-array) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Unwrap the gateway's failure envelope to its deepest level.
 *
 * Qoder nests the real complaint instead of stating it once: an outer
 * transport code wraps a `message` that is itself a JSON *string*, which wraps
 * another code and message, and the queue descriptor sits at the bottom —
 *
 * ```
 * { code: "403",
 *   message: "{\"code\":\"10605\",
 *              \"message\":\"{\\\"isQueued\\\":false,\\\"retryAfterSeconds\\\":2,...}\"}" }
 * ```
 *
 * Reading only the first level therefore reports a bare `403` and hides both
 * the true code (`10605`) and the retry hint. The whole chain is walked here so
 * the deepest code — the one that names the actual problem — wins.
 *
 * @returns `{ code, detail }`, the most specific code and the most informative
 *   detail text found.
 */
function unwrapFailure(chunk: Record<string, unknown>): { code: string; detail: string } {
  let code = ''
  let detail = ''
  let node: Record<string, unknown> = chunk
  let descended = false

  for (let depth = 0; depth < 8; depth++) {
    if (!isPlainObject(node)) break
    const levelCode = node.errorCode ?? node.code
    // Both spellings occur in the wild: a quoted `"10605"` and a bare JSON
    // number. Normalising numbers keeps the code usable for the exact matches
    // downstream instead of silently falling through to `''`.
    if (typeof levelCode === 'string' && levelCode.length > 0) code = levelCode
    else if (typeof levelCode === 'number' && Number.isFinite(levelCode)) code = String(levelCode)
    const message = node.message ?? node.errorMessage
    if (typeof message === 'string' && message.length > 0) detail = message

    // The next level sits under `details`/`error`, or inside a `message`
    // string that is itself a JSON document.
    const nested = isPlainObject(node.details) ? node.details : isPlainObject(node.error) ? node.error : undefined
    const next = nested ?? (typeof message === 'string' ? tryJsonObject(message) : undefined)
    if (next === undefined) break
    node = next
    descended = true
  }

  // When the walk bottoms out on a payload object (the queue descriptor), that
  // object is far more useful than the JSON string that carried it.
  if (descended && isPlainObject(node) && typeof node.message !== 'string') {
    detail = JSON.stringify(node)
  }
  return { code, detail }
}
