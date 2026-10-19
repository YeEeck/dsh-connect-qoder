/**
 * 探针：宿主（DSH 运行时）拿到 shim 的 `429 daily_limit_exceeded` 后，还会不会继续重试？
 *
 * 为什么要问这个问题：本插件的 `DailyLimitRejection` 有 `retryable:false`，但**宿主看不见
 * 这个标志**。宿主只拿到 HTTP 状态 + 一段文本，然后按文本分类
 * （`classifyPiAiError`，见下）。所以「不重试」这半边靠的是——文案里出现宿主认得的
 * quota 措辞。这条耦合在 `src/host/upstream/sse.ts` 的类注释里写明了，本探针用**宿主自己
 * 的代码**把它验一遍，而不是拿一份手抄的规则去对比手抄的规则。
 *
 * 做法（不复制任何规则）：
 *   1. 从安装副本的 `app.asar` 取出 `@deepseek-ai/dsh-llm/lib/types/error.js`——该文件零
 *      import，可直接 `import()`，于是 `isQuotaExceededError` / `QUOTA_EXCEEDED_CODE`
 *      是**真代码执行**出来的判定；
 *   2. 用真的 `streamChat` + fetch stub 跑一次真实回合，拿到本插件真的错误文案；
 *   3. 按宿主真实的文本合成路径判定（两条都试，见 COMPOSITIONS）；
 *      负对照：把括注去掉的旧文案必须**不**命中；
 *   4. **读取**（不执行）宿主分类器的顺序和可重试码表：quota 必须在 `429|rate.?limit`
 *      之前判定，且 QUOTA 不在 `DEFAULT_RETRYABLE_CODES` 里。任一处漂移，本探针报 FAIL。
 *
 * 运行：node probe/host-retry-classification-probe.mjs [--asar <path/to/app.asar>]
 *
 * 退出码：0 = 宿主会把它当不可重试的额度错误；1 = 会重试（或在宿主里找不到那些规则）。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? null : args[at + 1]
}

/* ---------------------------------------------------------------- asar ---- */

/**
 * Electron "pickle" 头：header 长度在 offset 12（不是 4），正文起点按 4 字节对齐。
 * 这段读法与 `probe/host-compat.mjs` 的同名部分一致（那份是这套事实的来源）。
 */
function openAsar(archive) {
  const fd = openSync(archive, 'r')
  const frame = Buffer.alloc(16)
  readSync(fd, frame, 0, 16, 0)
  const headerSize = frame.readUInt32LE(12)
  const headerBuf = Buffer.alloc(headerSize)
  readSync(fd, headerBuf, 0, headerSize, 16)
  closeSync(fd)
  return { archive, tree: JSON.parse(headerBuf.toString('utf8')), base: 16 + Math.ceil(headerSize / 4) * 4 }
}

function walk(node, prefix = '', out = new Map()) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (child.files) walk(child, path, out)
    else if (typeof child.offset === 'string') out.set(path, child)
  }
  return out
}

function readNode({ archive, base }, node) {
  const fd = openSync(archive, 'r')
  const buf = Buffer.alloc(Number(node.size))
  readSync(fd, buf, 0, Number(node.size), base + Number(node.offset))
  closeSync(fd)
  return buf
}

function findAsar() {
  const explicit = flag('--asar')
  if (explicit) return existsSync(explicit) ? explicit : null
  const env = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  for (const root of [join(env, 'Programs'), '/Applications', join(homedir(), 'Applications')]) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root)) {
      if (!/deepseek|harness/i.test(entry)) continue
      for (const rel of ['resources/app.asar', 'Contents/Resources/app.asar']) {
        const candidate = join(root, entry, rel)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

const archive = findAsar()
if (archive === null) {
  console.error('找不到 DSH 安装副本。显式指定：--asar <path/to/app.asar>')
  process.exit(1)
}

const handle = openAsar(archive)
const files = walk(handle.tree)
const textOf = (path) => {
  const node = files.get(path)
  return node === undefined ? undefined : readNode(handle, node).toString('utf8')
}

const ERROR_JS = 'dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/error.js'
const RETRY_POLICY_JS = 'dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/retry-policy.js'
const PI_AI_ADAPTER_JS = 'dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'

/* ------------------------------------------- 1. 宿主自己的判据（真执行） ---- */

const source = textOf(ERROR_JS)
if (source === undefined) {
  console.error(`安装副本里没有 ${ERROR_JS}——路径变了，探针需要更新`)
  process.exit(1)
}
// 零 import，所以可以直接落到临时目录再 import：判定用的是宿主自己的正则。
const dir = join(tmpdir(), `dsh-quota-predicate-${process.pid}`)
mkdirSync(dir, { recursive: true })
const entry = join(dir, 'error.mjs')
writeFileSync(entry, source)
const hostErrors = await import(pathToFileURL(entry).href)
const { isQuotaExceededError, QUOTA_EXCEEDED_CODE } = hostErrors
if (typeof isQuotaExceededError !== 'function' || typeof QUOTA_EXCEEDED_CODE !== 'string') {
  console.error('宿主 error.js 里找不到 isQuotaExceededError / QUOTA_EXCEEDED_CODE——契约变了')
  process.exit(1)
}

/* ------------------------------------------- 2. 本插件真的文案（真执行） ---- */

const { streamChat } = await import('../src/host/upstream.ts')

const REGION = { id: 'qoder', displayName: 'Qoder', baseUrl: 'https://gateway.example' }
const CREDENTIAL = { userID: 'u-probe', token: 'tok-probe', name: 'n', email: 'e@x', machineID: 'm' }
const CHAT_REQUEST = {
  model: 'model-key',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  maxTokens: undefined,
  enableThinking: false,
  alwaysThinking: false,
  reasoningEffort: undefined,
  sessionId: 's-probe',
}
const BODY = {
  message:
    "Qoder's daily request allowance for this account is used up. Waiting within the session will not help; " +
    'the off-peak price (22:00–08:00 Asia/Shanghai) and the daily check-in both still work.',
  type: 'daily_limit_exceeded',
  code: 'daily_limit_exceeded',
}

const originalFetch = globalThis.fetch
let calls = 0
globalThis.fetch = async () => {
  calls += 1
  return new Response(JSON.stringify(BODY), { status: 429, headers: { 'content-type': 'application/json' } })
}
let rejection
try {
  for await (const chunk of streamChat(REGION, CREDENTIAL, CHAT_REQUEST, new AbortController().signal)) {
    void chunk
  }
} catch (thrown) {
  rejection = thrown
} finally {
  globalThis.fetch = originalFetch
}

const ourMessage = String(rejection?.message ?? '')
console.log(`commit: attempts=${calls} name=${rejection?.name} retryable=${rejection?.retryable} dailyLimit=${rejection?.dailyLimit}`)
console.log(`plugin message: ${ourMessage.slice(0, 160)}…`)

/* --------------------------------- 3. 宿主会拿去分类的文本（两种合成） ---- */

/**
 * `classifyPiAiError(text)` 收到的 `text` 是 pi-ai 写下的 `errorMessage`
 * （`dsh-llm-pi-ai/lib/index.js` 里 `case "error"`），而它是
 * `formatProviderError(normalizeProviderError(error))`
 * （`@earendil-works/pi-ai/dist/api/openai-completions.js:502`）。
 * 那条路径会得到两种字符串之一，取决于 SDK 是否已把 body 折进 message：
 *   A `"<status>: <JSON body>"`；B `"<status> <message>"`。
 * 两种都试：只要宿主实际走的那条命中，结论就成立；两条都命中更稳。
 *
 * 关键：body 里的 `message` 是 **shim 写的**（`describeThrown(error)`，也就是本插件的
 * 文案），不是上游那句原文。负对照用的才是上游原文——它没有括注，也正是修复前
 * 宿主唯一能看到的东西。
 */
const HOST_BODY = { message: ourMessage, type: 'daily_limit_exceeded', code: 'daily_limit_exceeded' }
const COMPOSITIONS = {
  'A: "<status>: <JSON body>"': `429: ${JSON.stringify(HOST_BODY)}`,
  'B: "<status> <message>"': `429 ${ourMessage}`,
  'C: 裸文案（body 被折进 message 时）': ourMessage,
}
/** 负对照：上游原文，没有括注——修复前宿主看到的就是它（或它的 JSON 包装）。 */
const LEGACY = `429: ${JSON.stringify({ message: BODY.message, type: BODY.type, code: BODY.code })}`

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`)
  if (!ok) failures += 1
}

console.log('\n[1] 宿主自己的 isQuotaExceededError()（真执行）')
for (const [label, text] of Object.entries(COMPOSITIONS)) {
  check(isQuotaExceededError(text) === true, `${label} → QUOTA 命中`)
}
check(
  isQuotaExceededError(LEGACY) === false,
  '负对照：上游原文（无括注）必须**不**命中——否则这句话不是关键',
)
check(QUOTA_EXCEEDED_CODE === 'QUOTA', `QUOTA_EXCEEDED_CODE = ${QUOTA_EXCEEDED_CODE}`)

/* --------------------------- 4. 宿主分类顺序与可重试码表（读，不执行） ---- */

console.log('\n[2] 宿主分类器顺序（读 dsh-llm-pi-ai/lib/index.js，不执行）')
const adapter = textOf(PI_AI_ADAPTER_JS)
const start = adapter?.indexOf('function classifyPiAiError(message) {') ?? -1
const end = start === -1 ? -1 : adapter.indexOf('\n}', start)
const classifier = start === -1 || end === -1 ? '' : adapter.slice(start, end)
check(classifier !== '', '找得到 classifyPiAiError 的函数体')
check(
  classifier.indexOf('isQuotaExceededError') !== -1 &&
    classifier.indexOf('isQuotaExceededError') < classifier.indexOf('429'),
  'quota 判定在 `\\b429\\b|rate.?limit` 之前（顺序变了这条耦合就失效）',
)
check(classifier.includes('QUOTA_EXCEEDED_CODE'), '返回的是 QUOTA_EXCEEDED_CODE 而不是 RATE_LIMIT')

console.log('\n[3] 可重试码表（读 dsh-llm/lib/types/retry-policy.js）')
const policy = textOf(RETRY_POLICY_JS) ?? ''
const listStart = policy.indexOf('DEFAULT_RETRYABLE_CODES = Object.freeze([')
const listEnd = listStart === -1 ? -1 : policy.indexOf(']', listStart)
const retryable = listStart === -1 || listEnd === -1 ? '' : policy.slice(listStart, listEnd)
check(retryable !== '', '找得到 DEFAULT_RETRYABLE_CODES 的字面量')
check(retryable.includes('RATE_LIMIT'), 'RATE_LIMIT 在可重试集合里（所以分类错误就真的会重试）')
check(!retryable.includes('QUOTA'), 'QUOTA 不在可重试集合里')

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}：${failures === 0 ? '宿主会把这条 429 当不可重试的额度错误' : '宿主仍会重试，或契约已漂移'}`)
process.exitCode = failures === 0 ? 0 : 1
