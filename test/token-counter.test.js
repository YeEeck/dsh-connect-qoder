/**
 * Round-trip tests for the local token-consumption accumulator.
 *
 * Run: node --test test/token-counter.test.js
 *
 * The accumulator is a filesystem claim (the same atomic write shape as the
 * request counter and the exchange throttle store), so the load-bearing
 * properties are asserted against a real temporary directory:
 *
 *   - an addUsage persists and round-trips through a NEW instance over the same
 *     path (the "survives a restart" guarantee);
 *   - each region and each local day is a separate file, so midnight rollover
 *     does not carry yesterday's total forward;
 *   - the write is atomic (temp file + rename), so a crash never leaves a
 *     half-written JSON;
 *   - an invalid / out-of-bounds region component is refused (never escapes the
 *     plugin dir);
 *   - a failed write is logged and leaves no temp orphan;
 *   - gc removes only this plugin's stale day files, never neighbours;
 *   - a malformed usage frame (missing / negative / non-numeric total) is
 *     skipped, not written as dirty data.
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TokenCounter, tokensFromUsage } from '../src/host/token-counter.ts'
import { localDayKey } from '../src/host/request-counter.ts'

const created = []

/** A fresh temporary directory, removed after the test. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-tc-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop(), { recursive: true, force: true })
  }
})

// A fixed wall clock so the Shanghai calendar day is deterministic.
const NOW = Date.UTC(2023, 10, 15, 15, 30, 0) // 23:30 UTC = 23:30 Asia/Shanghai (UTC+8)
const clock = () => NOW
const nextDay = () => NOW + 24 * 60 * 60 * 1000

function counterIn(dir, extra = {}) {
  return new TokenCounter({
    basePath: (filename) => join(dir, filename),
    now: clock,
    ...extra,
  })
}

// A realistic Qoder usage frame (OpenAI stream_options.include_usage shape).
const USAGE_100 = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100, prompt_tokens_details: { cached_tokens: 20 } }
const USAGE_50 = { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 }

test('tokensFromUsage extracts total_tokens and cached_tokens', () => {
  const r = tokensFromUsage(USAGE_100)
  assert.strictEqual(r.total, 100)
  assert.strictEqual(r.cached, 20)
})

test('tokensFromUsage defaults cached to 0 when the field is absent', () => {
  const r = tokensFromUsage(USAGE_50)
  assert.strictEqual(r.total, 50)
  assert.strictEqual(r.cached, 0)
})

test('tokensFromUsage returns null for a malformed frame', () => {
  assert.strictEqual(tokensFromUsage(undefined), null)
  assert.strictEqual(tokensFromUsage(null), null)
  assert.strictEqual(tokensFromUsage({}), null)
  assert.strictEqual(tokensFromUsage({ total_tokens: -1 }), null)
  assert.strictEqual(tokensFromUsage({ total_tokens: 'not-a-number' }), null)
  assert.strictEqual(tokensFromUsage({ total_tokens: 'not-a-number', cached_tokens: 5 }), null)
})

test('tokensFromUsage floors fractional values', () => {
  const r = tokensFromUsage({ total_tokens: 12.7, prompt_tokens_details: { cached_tokens: 3.9 } })
  assert.strictEqual(r.total, 12)
  assert.strictEqual(r.cached, 3)
})

test('an addUsage persists and round-trips through a new instance (restart)', () => {
  const dir = tempDir()
  const first = counterIn(dir)
  assert.deepStrictEqual(first.read('qoder-cn'), { total: null, cached: null, day: '2023-11-15' })

  first.addUsage('qoder-cn', USAGE_100)
  first.addUsage('qoder-cn', USAGE_50)

  const second = counterIn(dir)
  const snapshot = second.read('qoder-cn')
  assert.strictEqual(snapshot.total, 150, 'a fresh process still sees today\'s total')
  assert.strictEqual(snapshot.cached, 20)
  assert.strictEqual(snapshot.day, '2023-11-15')
})

test('regions are isolated from each other', () => {
  const dir = tempDir()
  const c = counterIn(dir)
  c.addUsage('qoder-cn', USAGE_100)
  c.addUsage('qoder', USAGE_50)

  assert.strictEqual(c.read('qoder-cn').total, 100)
  assert.strictEqual(c.read('qoder').total, 50)
})

test('a midnight rollover starts a fresh file', () => {
  const dir = tempDir()
  const first = counterIn(dir)
  first.addUsage('qoder-cn', USAGE_100)

  const second = counterIn(dir, { now: nextDay })
  assert.deepStrictEqual(second.read('qoder-cn'), { total: null, cached: null, day: '2023-11-16' })
  second.addUsage('qoder-cn', USAGE_50)
  assert.strictEqual(second.read('qoder-cn').total, 50)

  // The first day's file is untouched.
  const third = counterIn(dir)
  assert.strictEqual(third.read('qoder-cn').total, 100)
})

test('an invalid region component is refused, never escapes the dir', () => {
  const dir = tempDir()
  const c = counterIn(dir)
  assert.deepStrictEqual(c.read('../escape'), { total: null, cached: null, day: null })
  assert.deepStrictEqual(c.read('a/b'), { total: null, cached: null, day: null })
  c.addUsage('../escape', USAGE_100)
  // No file was written outside the plugin dir.
  const files = readdirSync(dir)
  assert.strictEqual(files.some((f) => f.includes('..')), false)
})

test('a malformed usage frame is skipped without writing dirty data', () => {
  const dir = tempDir()
  const c = counterIn(dir)
  c.addUsage('qoder-cn', { total_tokens: -1 })
  c.addUsage('qoder-cn', {})
  c.addUsage('qoder-cn', undefined)
  assert.deepStrictEqual(c.read('qoder-cn'), { total: null, cached: null, day: '2023-11-15' })
})

test('gc removes only this plugin\'s stale day files', () => {
  const dir = tempDir()
  const c = counterIn(dir, { keepDays: 1 })
  // Write a file two days before the clock; gc with keepDays=1 should remove it
  // (the cutoff day is inclusive, so a file exactly one day old survives).
  const staleDay = localDayKey(NOW - 2 * 24 * 60 * 60 * 1000)
  writeFileSync(join(dir, `.qoder-token-count.qoder-cn.${staleDay}.json`), JSON.stringify({ version: 1, total: 5, cached: 0, day: staleDay }))
  // Write today's file.
  c.addUsage('qoder-cn', USAGE_100)
  // Write a neighbour file (not this plugin's) that should never be touched.
  writeFileSync(join(dir, '.other-plugin.json'), '{}')

  c.gc()

  assert.strictEqual(existsSync(join(dir, `.qoder-token-count.qoder-cn.${staleDay}.json`)), false)
  assert.strictEqual(existsSync(join(dir, '.other-plugin.json')), true)
  // Today's file survives.
  assert.strictEqual(c.read('qoder-cn').total, 100)
})

test('gc with a missing timezone degrades, never throws', () => {
  const dir = tempDir()
  const c = new TokenCounter({ basePath: (f) => join(dir, f), now: clock, keepDays: 1, logger: { warn() {} } })
  c.gc()
})

test('a failed write leaves no temp orphan', () => {
  const dir = tempDir()
  // Point basePath at a path that cannot be written to.
  const unwritable = join(dir, 'nope', 'deeper')
  const c = new TokenCounter({ basePath: (f) => join(unwritable, f), now: clock, logger: { warn() {} } })
  c.addUsage('qoder-cn', USAGE_100)
  const files = readdirSync(dir)
  assert.strictEqual(files.some((f) => f.endsWith('.tmp')), false)
})


