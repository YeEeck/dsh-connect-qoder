/**
 * 对话框用量胶囊：纯模型层 + 归属门控 + 分级阈值 + i18n + 座席注册一致性 + slot-gate。
 *
 * Run: node --test test/composer-pill.test.js
 *
 * 四块：
 *   1. `pill-model` 纯函数（门控、主额度、分级、格式化）——直接 import src（无 JSX）。
 *   2. i18n key 完整性：`pill.*` 在 zh/en 两份字典里都在，且 key 集一致（漏 key 的
 *      字典会让那一侧回落到 key 回显，见 index.ts 的 resolveNamespace 事故注）。
 *   3. 座席注册一致性：`index.ts` 真的把 `conversation.input.right` 交给
 *      `ComposerUsagePill`，且注册进 lib 产物。
 *   4. slot-gate：peer 契约在，`conversation.input.right` 是可挂的 `kind:'list'`/
 *      `scope:'session'` 座席，renderer 对 session 作用域严格物化（`optional=false`）。
 *      peer 路径是开发机布局，找不到时 skip 而非失败。
 *
 * DOM 行为（真的渲染 lib 产物、断言用户看到什么）在 `composer-pill-dom.test.js`，
 * 走 `test/helpers/render-card.js`，与本文件的静态断言分开。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isQoderRegion,
  regionPrefixOf,
  selectedRegionOf,
  selectedModelOf,
  candidateOf,
  primaryQuotaOf,
  remainingOf,
  formatCredits,
  tierOfQuota,
  num,
  usableTotal,
  matchingModel,
  offPeakSummary,
  WARN_SHARE,
} from '../src/client/pill-model.ts'
import { zh, en } from '../src/client/copy.ts'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = (path) => readFileSync(`${REPO_ROOT}${path}`, 'utf8')

/* ---------------------------------------------------------------- */
/* 1. 归属门控                                                        */
/* ---------------------------------------------------------------- */

test('isQoderRegion accepts the two shipped regions and nothing else', () => {
  assert.equal(isQoderRegion('qoder-cn'), true)
  assert.equal(isQoderRegion('qoder'), true)
  assert.equal(isQoderRegion('deepseek'), false)
  assert.equal(isQoderRegion(''), false)
  assert.equal(isQoderRegion(undefined), false)
})

test('selectedRegionOf prefers next, falls back to lastUsed, ignores an empty next', () => {
  assert.equal(selectedRegionOf({ next: { provider: 'qoder-cn' }, lastUsed: { provider: 'qoder' } }), 'qoder-cn')
  assert.equal(selectedRegionOf({ lastUsed: { provider: 'qoder-cn' } }), 'qoder-cn')
  // 切换模型的瞬态：next 是空对象，不得遮蔽仍可用的 lastUsed。
  assert.equal(selectedRegionOf({ next: {}, lastUsed: { provider: 'qoder-cn' } }), 'qoder-cn')
  assert.equal(selectedRegionOf({ next: { model: 'qwen3-coder' } }), undefined)
  assert.equal(selectedRegionOf({}), undefined)
  assert.equal(selectedRegionOf(undefined), undefined)
})

test('candidateOf only trusts candidates that carry a provider or a model', () => {
  assert.deepEqual(candidateOf({ next: { provider: 'qoder-cn' }, lastUsed: { provider: 'qoder' } }), { provider: 'qoder-cn' })
  assert.deepEqual(candidateOf({ next: {}, lastUsed: { provider: 'qoder' } }), { provider: 'qoder' })
  assert.deepEqual(candidateOf({ next: { model: 'x' } }), { model: 'x' })
  assert.equal(candidateOf({ next: {} }), undefined)
  assert.equal(candidateOf(undefined), undefined)
})

test('regionPrefixOf names the two regions and falls back to Qoder', () => {
  assert.equal(regionPrefixOf('qoder-cn'), 'Qoder CN')
  assert.equal(regionPrefixOf('qoder'), 'Qoder')
  assert.equal(regionPrefixOf('deepseek'), 'Qoder')
  assert.equal(regionPrefixOf(undefined), 'Qoder')
})

/* ---------------------------------------------------------------- */
/* 2. 主额度选择                                                      */
/* ---------------------------------------------------------------- */

test('primaryQuotaOf prefers the plan when it has a usable total', () => {
  const plan = { used: 266, total: 1300, remaining: 1034, percentage: 0.2046 }
  const addOn = { used: 0, total: 100, remaining: 100 }
  const out = primaryQuotaOf({ region: 'qoder-cn', userQuota: plan, addOnQuota: addOn })
  assert.deepEqual(out, { quota: plan, known: true })
})

test('primaryQuotaOf falls back to the add-on for the CN free tier (plan total 0)', () => {
  const plan = { used: 0, total: 0, remaining: 0 }
  const addOn = { used: 0, total: 100, remaining: 100 }
  const out = primaryQuotaOf({ region: 'qoder-cn', userQuota: plan, addOnQuota: addOn })
  assert.deepEqual(out, { quota: addOn, known: true })
})

test('primaryQuotaOf reports unknown when neither quota is usable', () => {
  assert.deepEqual(primaryQuotaOf({ region: 'qoder-cn' }), { quota: undefined, known: false })
  assert.deepEqual(primaryQuotaOf(undefined), { quota: undefined, known: false })
  assert.deepEqual(primaryQuotaOf({ userQuota: { total: 0 } }), { quota: undefined, known: false })
})

/* ---------------------------------------------------------------- */
/* 3. 剩余与格式化                                                     */
/* ---------------------------------------------------------------- */

test('remainingOf reads remaining, derives from used/total, and 0 is a reading', () => {
  assert.equal(remainingOf({ used: 266, total: 1300, remaining: 1034 }), 1034)
  assert.equal(remainingOf({ used: 266, total: 1300 }), 1034)
  assert.equal(remainingOf({ used: 1300, total: 1300, remaining: 0 }), 0)
  assert.equal(remainingOf({}), null)
  assert.equal(remainingOf(undefined), null)
})

test('formatCredits adds thousands separators and renders — for unknown', () => {
  assert.equal(formatCredits(1034), '1,034')
  assert.equal(formatCredits(100), '100')
  assert.equal(formatCredits(0), '0')
  assert.equal(formatCredits(null), '—')
})

/* ---------------------------------------------------------------- */
/* 4. 分级阈值（与卡片 QuotaBlock 同源）                                */
/* ---------------------------------------------------------------- */

test('tierOfQuota follows the card thresholds: exhausted, warn at 0.8, ok, unknown', () => {
  assert.equal(tierOfQuota({ total: 100, remaining: 0, percentage: 1 }), 'exhausted')
  assert.equal(tierOfQuota({ total: 100, remaining: 0, used: 100 }), 'exhausted')
  // 剩余 20% = 已用 80% → warn（WARN_SHARE 与卡片 0.8 同源）。
  assert.equal(tierOfQuota({ total: 100, remaining: 20, percentage: 0.8 }), 'warn')
  assert.equal(tierOfQuota({ total: 100, remaining: 21, percentage: 0.79 }), 'ok')
  assert.equal(tierOfQuota({ total: 100, remaining: 50 }), 'ok')
  // percentage 缺失时用 used/total 反推。
  assert.equal(tierOfQuota({ total: 100, used: 85 }), 'warn')
  assert.equal(tierOfQuota({ total: 100, used: 10 }), 'ok')
  // 缺字段 → unknown（不是 ok）。
  assert.equal(tierOfQuota({}), 'unknown')
  assert.equal(tierOfQuota({ total: 0, remaining: 0 }), 'unknown')
  assert.equal(tierOfQuota(undefined), 'unknown')
})

test('WARN_SHARE is 0.8, matching the card quota block', () => {
  assert.equal(WARN_SHARE, 0.8)
  const cardSource = read('src/client/card.tsx')
  assert.match(cardSource, /percentage >= 0\.8/)
})

/* ---------------------------------------------------------------- */
/* 5. 辅助窄化                                                        */
/* ---------------------------------------------------------------- */

test('num and usableTotal narrow numbers without inventing values', () => {
  assert.equal(num(5), 5)
  assert.equal(num('5'), null)
  assert.equal(num(NaN), null)
  assert.equal(num(undefined), null)
  assert.equal(usableTotal({ total: 1300 }), true)
  assert.equal(usableTotal({ total: 0 }), false)
  assert.equal(usableTotal(undefined), false)
})

/* ---------------------------------------------------------------- */
/* 6. i18n：pill.* 在 zh/en 都在，key 集一致                           */
/* ---------------------------------------------------------------- */

test('pill copy exists in both dictionaries with the same key set', () => {
  const zhKeys = Object.keys(zh).filter((key) => key.startsWith('pill.'))
  const enKeys = Object.keys(en).filter((key) => key.startsWith('pill.'))
  assert.deepEqual(enKeys.sort(), [...zhKeys].sort())
  assert.ok(zhKeys.length >= 5, `expected at least five pill.* keys, got ${zhKeys.length}`)
  for (const key of zhKeys) {
    assert.ok(zh[key].length > 0, `${key} must not be an empty string`)
    assert.ok(en[key].length > 0, `${key} must not be an empty string`)
  }
  // 中文必须真翻译，不得回显 key。
  assert.equal(zh['pill.details'], '用量详情')
  assert.equal(zh['pill.unavailable'], '读不到用量')
  assert.equal(en['pill.details'], 'Usage details')
})

/* ---------------------------------------------------------------- */
/* 7. 座席注册一致性                                                   */
/* ---------------------------------------------------------------- */

test('index.ts registers the composer pill on conversation.input.right', () => {
  const source = read('src/client/index.ts')
  assert.match(source, /inject\("conversation\.input\.right"/)
  assert.match(source, /ComposerUsagePill/)
  assert.match(source, /"conversation\.input\.right"/)
})

test('the composer pill registration degrades to console.error, not a throw', () => {
  const source = read('src/client/index.ts')
  // 红线 1：新失败路径必须发声，不许吞。
  assert.match(source, /composer pill slot failed to register/)
})

/* ---------------------------------------------------------------- */
/* 8. slot-gate：peer 契约在                                         */
/* ---------------------------------------------------------------- */

/** 定位 peer 包根；多候选路径遍历，找不到返回 undefined。 */
function peerRootOf(pkg) {
  const candidates = [
    `${REPO_ROOT}node_modules/@deepseek-ai/${pkg}`,
    `${process.env.HOME}/.dsh/profiles/web/node_modules/@deepseek-ai/${pkg}`,
    `${process.env.USERPROFILE}/.dsh/profiles/web/node_modules/@deepseek-ai/${pkg}`,
    // 实际开发机布局：`~/.dsh/profiles/node_modules/@deepseek-ai/*`（web 与桌面共用这份 peer）。
    `${process.env.HOME}/.dsh/profiles/node_modules/@deepseek-ai/${pkg}`,
    `${process.env.USERPROFILE}/.dsh/profiles/node_modules/@deepseek-ai/${pkg}`,
    `${process.env.LOCALAPPDATA}/Programs/DeepSeek Harness/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/${pkg}`,
  ]
  return candidates.find((path) => existsSync(path))
}

const conversationRoot = peerRootOf('dsh-client-ui-conversation')
const sessionRoot = peerRootOf('dsh-client-ui-session')
const rendererRoot = peerRootOf('dsh-client-ui-renderer')

test('A: the host declares conversation.input.right as a session-scoped list slot', { skip: conversationRoot === undefined }, () => {
  const dts = readFileSync(`${conversationRoot}/lib/types/client/contract/slots.d.ts`, 'utf8')
  assert.match(dts, /'conversation\.input\.right'/)
  assert.match(dts, /scope:\s*['"]session['"]/)
})

test('B: the host actually renders conversation.input.right (and left)', { skip: conversationRoot === undefined }, () => {
  const js = readFileSync(`${conversationRoot}/lib/client.js`, 'utf8')
  assert.match(js, /renderSlot\(["']conversation\.input\.right["']/)
  assert.match(js, /renderSlot\(["']conversation\.input\.left["']/)
})

test('C: the session adapter declares and serves the projection keyed hook', { skip: sessionRoot === undefined }, () => {
  const js = readFileSync(`${sessionRoot}/lib/client.js`, 'utf8')
  assert.match(js, /keyedHooks:\s*\[["']projection["']\]/)
  assert.match(js, /projections\.faceOf/)
})

test('D: the renderer materializes session scopes strictly (optional=false)', { skip: rendererRoot === undefined }, () => {
  const js = readFileSync(`${rendererRoot}/lib/client.js`, 'utf8')
  assert.match(js, /materializeStandardBinding\(binding,\s*optional/)
  assert.match(js, /materializeStandardBinding\(scopeBinding,\s*scope\s*===\s*["']session-maybe["']/)
  assert.match(js, /if \(source === void 0 && !optional\) throw/)
})

/* ---------------------------------------------------------------- */
/* 9. 错峰折扣（模型级事实，面板顶部）                                   */
/* ---------------------------------------------------------------- */

const tOf = (key) => zh[key] ?? key

test('selectedModelOf reads the model of the active candidate only', () => {
  assert.equal(selectedModelOf({ next: { provider: 'qoder-cn', model: 'qwen3.5-coder' } }), 'qwen3.5-coder')
  assert.equal(selectedModelOf({ next: { provider: 'qoder-cn' } }), undefined)
  assert.equal(selectedModelOf({ next: { provider: 'qoder-cn', model: '' } }), undefined)
  assert.equal(selectedModelOf(undefined), undefined)
})

test('matchingModel finds a row by id or by display name, never by guessing', () => {
  const rows = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Beta' },
  ]
  assert.equal(matchingModel(rows, 'a').id, 'a')
  assert.equal(matchingModel(rows, 'Beta').id, 'b')
  assert.equal(matchingModel(rows, 'gamma'), undefined)
  assert.equal(matchingModel(rows, undefined), undefined)
  assert.equal(matchingModel('not-an-array', 'a'), undefined)
})

const offPeakModel = (windowStart, windowEnd) => ({
  id: 'qwen3.5-coder',
  name: 'Qwen3.5 Coder',
  region: 'qoder-cn',
  priceFactor: 0.5,
  promotion: {
    active: true,
    windowStart,
    windowEnd,
    timezone: 'Asia/Shanghai',
    discountFactor: 1,
    beforePromotionPriceFactor: 0.5,
  },
})
const AT_NIGHT = new Date('2026-10-16T23:00:00+08:00')

test('offPeakSummary reports an active window with the discounted rate and the window label', () => {
  const summary = offPeakSummary(offPeakModel('22:00:00', '08:00:00'), AT_NIGHT, tOf)
  assert.equal(summary.active, true)
  assert.equal(summary.rate, 'x0.50')
  assert.equal(summary.window, '22:00:00–08:00:00')
  assert.ok(summary.remainingSeconds > 0)
})

test('offPeakSummary reports inactive when now is outside the window, instead of pretending', () => {
  const summary = offPeakSummary(offPeakModel('08:00:00', '22:00:00'), AT_NIGHT, tOf)
  assert.equal(summary.active, false)
  assert.equal(summary.rate, 'x0.50')
})

test('offPeakSummary returns undefined when the model carries no usable promotion', () => {
  assert.equal(offPeakSummary(undefined, AT_NIGHT, tOf), undefined)
  assert.equal(offPeakSummary({ id: 'a', promotion: null }, AT_NIGHT, tOf), undefined)
  assert.equal(offPeakSummary({ id: 'a' }, AT_NIGHT, tOf), undefined)
  // active 窗口但窗口起点不可解析 → 算不出状态，不显示。
  assert.equal(offPeakSummary(offPeakModel(undefined, '08:00:00'), AT_NIGHT, tOf), undefined)
})

test('off-peak pill copy exists in both dictionaries with non-echo values', () => {
  const keys = ['pill.modelLabel', 'pill.offpeakActive', 'pill.offpeakIdle', 'pill.offpeakRemaining']
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh.${key}`)
    assert.equal(typeof en[key], 'string', `en.${key}`)
    assert.ok(zh[key].length > 0)
    assert.ok(en[key].length > 0)
    assert.notEqual(zh[key], key, `zh.${key} must not echo the key`)
    assert.notEqual(en[key], key, `en.${key} must not echo the key`)
  }
})