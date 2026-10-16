/**
 * Regression tests for `probe/qoder-device-login.mjs`.
 *
 * Run: node --test test/probe-device-login.test.js
 *
 * WHY THIS FILE EXISTS
 *
 * The probe's first real run against qoder.cn SUCCEEDED at the login and then
 * destroyed its own evidence. `pollOnce` read the poll body as
 * `(await response.text()).slice(0, 400)`, which cut a real device-token
 * payload mid-string; `JSON.parse` then threw, and because the throw was
 * uncaught, Node printed the offending input — a LIVE device token — into the
 * log.
 *
 * Two defects, one root cause: bounding was applied to the READ instead of to
 * the PRINT. Both are pinned here. Transport must be lossless so the credential
 * can be parsed at all, and a body that will not parse may contribute only its
 * byte count and shape to anything that leaves the probe.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bodyForDisplay, mask, parsePollBody, parseTokenPayload, pollOnce } from '../probe/qoder-device-login.mjs'

/** The shape qoder.cn actually answered with; the token value is a placeholder. */
const CN_PAYLOAD = {
  id: '01a14590-538b-7e1e-8a9e-33ac4b367354',
  token: 'dt-EXAMPLE00000000000000000',
  user_id: '019ec931-baf3-7de9-8363-65fbacc369b4',
  code_challenge: 'QipFX9pZAQskb5pMZWPoeT4mJ2wij3eU4dbeqW0BIC4',
  code_challenge_method: 'S256',
  nonce: '7706ae3b-adfd-4bf1-a4da-79b3df44e7b1',
  expires_at: '2026-11-15T16:34:08Z',
  refresh_token_id: '01a14590-537f-7413-86e4-20ba6b870816',
  created_at: '2026-10-16T16:34:08',
}

const REGION = { openApiUrl: 'https://openapi.example.test' }
const SESSION = { nonce: 'n', pkce: { verifier: 'v'.repeat(43) }, machineId: 'm' }

test('a poll body is read whole, never bounded at the read site', async () => {
  const body = JSON.stringify(CN_PAYLOAD)
  // The real payload is longer than the 400 characters that used to cut it, so
  // a fixture that shrank below that bound would silently stop testing anything.
  assert.ok(body.length > 400, `fixture must exceed the old 400-char bound, got ${body.length}`)

  const result = await pollOnce(SESSION, REGION, async () => ({ status: 200, text: async () => body }))

  assert.deepStrictEqual(result, { reachable: true, status: 200, text: body })
  assert.strictEqual(parsePollBody(result.text).ok, true, 'the body must still parse after the read')
})

test('a body that will not parse gives up its shape and size, never its contents', () => {
  const secret = 'dt-LIVEDEVICETOKEN0123456789'
  const truncated = `{"token":"${secret}","user_id":"019ec931`

  const read = parsePollBody(truncated)

  assert.strictEqual(read.ok, false)
  assert.strictEqual(read.bytes, truncated.length)
  assert.strictEqual(read.truncated, true, 'a payload cut mid-string does not end with a closing brace')
  // The whole point. V8 embeds a slice of its input in JSON syntax errors, which
  // is why the parser's message is not among the fields this returns: whatever a
  // caller logs must not contain the credential.
  const escaped = JSON.stringify(read)
  assert.ok(!escaped.includes(secret), `the secret escaped: ${escaped}`)
  assert.ok(!escaped.includes('LIVEDEVICETOKEN'), `part of the secret escaped: ${escaped}`)
  assert.ok(!escaped.includes('token'), 'no field of the body may be carried out')
})

test('a body that ends in a brace is not blamed on truncation', () => {
  const read = parsePollBody('{"a":1}}')
  assert.strictEqual(read.ok, false)
  assert.strictEqual(read.truncated, false)
})

test('an empty body is a distinct, reportable case', () => {
  assert.deepStrictEqual(parsePollBody(''), { ok: false, bytes: 0, truncated: false, name: 'EmptyBody' })
})

test('the CN poll payload maps onto the plugin credential shape', () => {
  const parsed = parseTokenPayload(CN_PAYLOAD)

  assert.strictEqual(parsed.accessToken, CN_PAYLOAD.token)
  assert.strictEqual(parsed.expiresAt, '2026-11-15T16:34:08Z', 'the region answers an ISO string, not epoch millis')
  assert.strictEqual(parsed.uid, CN_PAYLOAD.user_id)
  assert.strictEqual(parsed.userName, undefined)
  // A refresh_token_id is NOT a refresh token; reporting it as one would invent
  // a credential the region never issued.
  assert.strictEqual(parsed.refreshToken, undefined)
  assert.strictEqual(parsed.refreshTokenId, CN_PAYLOAD.refresh_token_id)
})

test('mask reports a secret without disclosing it', () => {
  const secret = 'dt-LIVEDEVICETOKEN0123456789'
  const masked = mask(secret)

  assert.ok(!masked.includes(secret))
  assert.ok(!masked.includes('LIVEDEVICETOKEN'))
  assert.ok(masked.includes(String(secret.length)))
  assert.strictEqual(mask(''), 'absent')
  assert.strictEqual(mask(undefined), 'absent')
})

test('bodyForDisplay bounds the print and still reports the real size', () => {
  const long = 'x'.repeat(500)
  const shown = bodyForDisplay(long)

  assert.ok(shown.length < long.length, 'the display must be bounded')
  assert.ok(shown.includes('500'), 'the real size must survive the bound')
  assert.strictEqual(bodyForDisplay('short'), 'short')
  assert.strictEqual(bodyForDisplay(''), '<empty>')
})
