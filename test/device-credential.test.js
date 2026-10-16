/**
 * Tests for the plugin's own credential source (device login).
 *
 * Run: node --test test/device-credential.test.js
 *
 * The vault is real (a temporary directory) and the network is a stubbed
 * `fetch`, because the interesting behaviour is exactly the seam between them:
 * which failures are remembered, what gets written back after a rotation, and
 * whether the uid survives one.
 *
 * The rotation fixtures are the MEASURED refresh envelope, not a convenient
 * one: six fields, the access token named `device_token`, and **no user_id**.
 * Using a friendlier fixture here would test a service that does not exist --
 * the live one answers `403 {"code":"101"}` when the uid is dropped, on both
 * regions. See docs/issues/21-device-login-credential-source.md.
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CredentialVault, VAULT_FORMAT_VERSION } from '../src/host/credential-vault.ts'
import {
  DEVICE_APP_NAME,
  DeviceCredentialSource,
  REFRESH_FAILURE_TTL_MS,
} from '../src/host/device-credential.ts'

const created = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-device-cred-'))
  created.push(dir)
  return dir
}
afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true })
})

/** A fixed clock, so "expired" is a decision the test makes rather than the calendar. */
const NOW = Date.parse('2026-10-17T01:00:00Z')
const HOUR = 3600 * 1000

/** A stored credential that is good for another hour. */
function liveRecord(overrides = {}) {
  return {
    token: 'dt-live',
    refreshToken: 'drt-live',
    expiresAt: NOW + HOUR,
    refreshTokenExpiresAt: NOW + 365 * 24 * HOUR,
    userID: 'uid-abc',
    name: 'Someone',
    email: 'someone@example.test',
    machineID: 'machine-1',
    savedAt: NOW - HOUR,
    ...overrides,
  }
}

/**
 * The refresh envelope as the service actually sends it.
 *
 * `device_token` rather than `token`, timestamps as ISO strings, and no
 * `user_id` -- all three measured. A tripwire test below asserts this key set,
 * so a later edit cannot quietly turn a realistic fixture into a convenient
 * one and defuse the trap it exists to catch.
 */
const ROTATED_BODY = {
  created_at: '2026-10-17T01:00:00Z',
  device_token: 'dt-rotated',
  expires_at: '2026-11-16T01:00:00Z',
  refresh_token: 'drt-rotated',
  refresh_token_expires_at: '2027-10-12T01:00:00Z',
  token_type: 'Bearer',
}

/** A `fetch` that answers with `body`/`status` and records every call. */
function stubbingFetch({ body = ROTATED_BODY, status = 200, throws } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (throws !== undefined) throw throws
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { impl, calls }
}

/** A source over a real vault in a temporary directory. */
function makeSource({ record, fetchImpl, now = () => NOW, logger } = {}) {
  const path = join(tempDir(), 'qoder-auth.qoder-cn.json')
  const vault = new CredentialVault({ path, now })
  if (record !== undefined) vault.save(record)
  return {
    path,
    vault,
    source: new DeviceCredentialSource({
      region: 'qoder-cn',
      vault,
      fetchImpl: fetchImpl?.impl ?? (async () => new Response('{}', { status: 200 })),
      now,
      logger,
    }),
  }
}

test('the refresh fixture is the measured envelope, trap included', () => {
  // Tripwire: if someone "helpfully" adds user_id or renames device_token, the
  // trap test below stops testing the trap.
  assert.deepStrictEqual(Object.keys(ROTATED_BODY).sort(), [
    'created_at',
    'device_token',
    'expires_at',
    'refresh_token',
    'refresh_token_expires_at',
    'token_type',
  ])
  assert.ok(!('user_id' in ROTATED_BODY), 'the live refresh response carries no uid')
})

test('no vault file means no credential, and the panel says so', async () => {
  const { source } = makeSource()
  assert.strictEqual(await source.load(), undefined)
  assert.deepStrictEqual(source.status, { state: 'none' })
})

test('a live credential is served without touching the network', async () => {
  const network = stubbingFetch()
  const { source } = makeSource({ record: liveRecord(), fetchImpl: network })

  const credential = await source.load()
  assert.ok(credential !== undefined)
  assert.strictEqual(credential.source, 'device')
  assert.strictEqual(credential.appName, DEVICE_APP_NAME)
  assert.strictEqual(credential.token, 'dt-live')
  assert.strictEqual(credential.userID, 'uid-abc')
  assert.strictEqual(credential.machineID, 'machine-1')
  assert.strictEqual(credential.expired, false)
  assert.deepStrictEqual(source.status, { state: 'ok' })
  assert.strictEqual(network.calls.length, 0, 'a usable token must not cost a request')
})

test('a lapsed token is renewed, and the uid the response omits is kept', async () => {
  // The trap, reproduced at this layer: the refresh response has no user_id, so
  // a loader that substitutes it hands the signer an empty uid.
  const network = stubbingFetch()
  const { source, vault } = makeSource({
    record: liveRecord({ token: 'dt-stale', expiresAt: NOW - HOUR }),
    fetchImpl: network,
  })

  const credential = await source.load()
  assert.ok(credential !== undefined)
  assert.strictEqual(credential.token, 'dt-rotated', 'the rotation took effect')
  assert.strictEqual(credential.userID, 'uid-abc', 'the uid survived a response that never carried it')
  assert.strictEqual(credential.machineID, 'machine-1')
  assert.ok(credential.expiresAt > NOW, 'and the new expiry is the one the service stated')
  assert.deepStrictEqual(source.status, { state: 'ok' })

  assert.strictEqual(network.calls.length, 1)
  // The refresh is a POST to the region's own open API host, carrying the
  // refresh token and the machine id the session was created with.
  assert.strictEqual(network.calls[0].url, 'https://openapi.qoder.com.cn/api/v1/deviceToken/refresh')
  const sent = JSON.parse(network.calls[0].init.body)
  assert.strictEqual(sent.refresh_token, 'drt-live')
  assert.strictEqual(sent.machine_id, 'machine-1')

  // And the rotation is what got STORED -- otherwise every later call would
  // rotate the same spent token again.
  const held = vault.read()
  assert.strictEqual(held.token, 'dt-rotated')
  assert.strictEqual(held.refreshToken, 'drt-rotated')
  assert.strictEqual(held.userID, 'uid-abc')
})

test('a spent refresh token is reported as expired, without a request', async () => {
  const network = stubbingFetch()
  const { source } = makeSource({
    record: liveRecord({ expiresAt: NOW - HOUR, refreshTokenExpiresAt: NOW - HOUR }),
    fetchImpl: network,
  })

  assert.strictEqual(await source.load(), undefined)
  assert.deepStrictEqual(source.status, { state: 'expired' })
  assert.strictEqual(network.calls.length, 0, 'the answer is already known; asking would be noise')
})

test('a refused renewal says so rather than calling it "not signed in"', async () => {
  const network = stubbingFetch({ status: 403 })
  const { source } = makeSource({
    record: liveRecord({ expiresAt: NOW - HOUR }),
    fetchImpl: network,
  })

  assert.strictEqual(await source.load(), undefined)
  assert.deepStrictEqual(source.status, { state: 'expired' }, '403 is the service saying the refresh token is dead')
})

test('a failed renewal is remembered, so a doomed call is not made per request', async () => {
  const network = stubbingFetch({ status: 500 })
  let clock = NOW
  const { source } = makeSource({
    record: liveRecord({ expiresAt: NOW - HOUR }),
    fetchImpl: network,
    now: () => clock,
  })

  await source.load()
  assert.deepStrictEqual(source.status, { state: 'refresh-failed', reason: 'Http500' })
  assert.strictEqual(network.calls.length, 1)

  // Every request in the window re-enters this loader; none of them may reach
  // the network again, or a refused account turns into a rate-limited one.
  assert.strictEqual(await source.load(), undefined)
  assert.strictEqual(await source.load(), undefined)
  assert.strictEqual(network.calls.length, 1)
  assert.deepStrictEqual(source.status, { state: 'refresh-failed', reason: 'Http500' })

  // Past the window it tries again -- and this time the service answers, so the
  // credential returns. A fresh source, because the window is per-process state
  // and this asserts the WINDOW is what stopped it, not the loader.
  clock = NOW + REFRESH_FAILURE_TTL_MS + 1
  const healthy = stubbingFetch()
  const retried = makeSource({
    record: liveRecord({ expiresAt: NOW - HOUR }),
    fetchImpl: healthy,
    now: () => clock,
  })
  assert.ok((await retried.source.load()) !== undefined, 'the window closed, so the renewal should be attempted')
  assert.strictEqual(healthy.calls.length, 1)
})

test('a deliberate retry clears the failure window', async () => {
  const network = stubbingFetch({ status: 500 })
  const { source } = makeSource({
    record: liveRecord({ expiresAt: NOW - HOUR }),
    fetchImpl: network,
  })

  await source.load()
  assert.strictEqual(network.calls.length, 1)
  // The same signal that invalidates the credential cache resets this: the user
  // may well have just signed in again, and making them wait out the window
  // would be the same mistake from the other side.
  source.retry()
  await source.load()
  assert.strictEqual(network.calls.length, 2)
})

test('a damaged vault file reads as unreadable, not as "never signed in"', async () => {
  const path = join(tempDir(), 'qoder-auth.qoder-cn.json')
  writeFileSync(path, '{ truncated', 'utf8')
  const source = new DeviceCredentialSource({
    region: 'qoder-cn',
    vault: new CredentialVault({ path, now: () => NOW }),
    fetchImpl: stubbingFetch().impl,
    now: () => NOW,
  })

  assert.strictEqual(await source.load(), undefined)
  assert.strictEqual(source.status.state, 'unreadable')
  assert.ok(source.status.reason.length > 0, 'a warning that explains nothing is the thing to avoid')
  assert.ok(
    !/sign in|signed in/i.test(source.status.reason),
    'the user must not be told to sign in about a file problem',
  )
})

test('a vault file from another version reads as unreadable, and is not quarantined', async () => {
  const dir = tempDir()
  const path = join(dir, 'qoder-auth.qoder-cn.json')
  writeFileSync(path, JSON.stringify({ ...liveRecord(), version: VAULT_FORMAT_VERSION + 1 }), 'utf8')
  const source = new DeviceCredentialSource({
    region: 'qoder-cn',
    vault: new CredentialVault({ path, now: () => NOW }),
    fetchImpl: stubbingFetch().impl,
    now: () => NOW,
  })

  assert.strictEqual(await source.load(), undefined)
  assert.strictEqual(source.status.state, 'unreadable')
})

test('a rotation that cannot be stored is still served, and complains', async () => {
  const warnings = []
  const network = stubbingFetch()
  // A vault whose read works and whose write does not: the real case is a full
  // or read-only home directory, which is not portably arrangeable in a test,
  // so the one method under test is the one that is replaced.
  const held = liveRecord({ expiresAt: NOW - HOUR, token: 'dt-stale' })
  const vault = {
    readResult: () => ({ kind: 'ok', record: held }),
    update: async () => false,
  }
  const source = new DeviceCredentialSource({
    region: 'qoder-cn',
    vault,
    fetchImpl: network.impl,
    now: () => NOW,
    logger: { warn: (message) => warnings.push(message) },
  })

  // The credential in hand is good for this request, so refusing to serve it
  // would be wrong -- but the user must be able to find out why nothing is
  // being remembered.
  const credential = await source.load()
  assert.ok(credential !== undefined, 'a storage failure must not break the request it can still serve')
  assert.strictEqual(credential.token, 'dt-rotated')
  assert.strictEqual(credential.userID, 'uid-abc')
  assert.deepStrictEqual(source.status, { state: 'ok' })
  assert.strictEqual(warnings.length, 1)
  assert.match(warnings[0], /could not store/)
})

test('a throwing network is reported, never thrown out of load', async () => {
  const network = stubbingFetch({ throws: new Error('socket hang up') })
  const { source } = makeSource({
    record: liveRecord({ expiresAt: NOW - HOUR }),
    fetchImpl: network,
  })

  // `load` feeds every request in the region; a rejection here would turn a
  // login problem into a broken provider.
  const credential = await source.load()
  assert.strictEqual(credential, undefined)
  assert.strictEqual(source.status.state, 'refresh-failed')
  assert.ok(source.status.reason.length > 0)
})
