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
const { isQuotaExceededError, QUOTA_EXCEEDED_CODE, EMPTY_RESPONSE_CODE } = hostErrors
if (typeof isQuotaExceededError !== 'function' || typeof QUOTA_EXCEEDED_CODE !== 'string') {
  console.error('宿主 error.js 里找不到 isQuotaExceededError / QUOTA_EXCEEDED_CODE——契约变了')
  process.exit(1)
}

/* ------------------------------------------- 2. 本插件真的文案（真执行） ---- */

const { streamChat } = await import('../src/host/upstream.ts')
const { ProtocolShapeChangedError, thrownFlag } = await import('../src/host/errors.ts')

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

/**
 * 驱动一次真实回合，返回抛出的错误与发出的请求数。
 *
 * `replies` 用完后就重复最后一条，所以「退化成重试」的场景会以请求数暴增表现出来
 * （而不是挂到超时）。需要让 fetch 直接抛（传输层失败）时给该项 `{ throw: <error> }`。
 */
async function driveChat(replies) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    const reply = replies[Math.min(calls, replies.length - 1)]
    calls += 1
    if (reply.throw !== undefined) throw reply.throw
    return new Response(reply.text, {
      status: reply.status,
      // 200 流必须是 `text/event-stream`：帧读取器只在 SSE 载体上解析 `data:` 行，
      // 用 `application/json` 送帧会被当成「一个都没读懂的流」→ 形状漂移判决。
      headers: { 'content-type': reply.contentType ?? 'application/json' },
    })
  }
  let error
  try {
    for await (const chunk of streamChat(REGION, CREDENTIAL, CHAT_REQUEST, new AbortController().signal)) {
      void chunk
    }
  } catch (thrown) {
    error = thrown
  } finally {
    globalThis.fetch = original
  }
  return { error, attempts: calls }
}

/** 一帧 `data:` 包体，形状与上游的 200 流一致（信封的 `body` 是 JSON 字符串）。 */
const sseFrame = (body) => `data: ${JSON.stringify({ body: JSON.stringify(body) })}\n\n`

/** 让 fetch 抛出一个 undici 形状的 ECONNRESET（含 `cause.code`）。 */
const ecReset = () => Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })

const { error: rejection, attempts } = await driveChat([{ status: 429, text: JSON.stringify(BODY) }])

const ourMessage = String(rejection?.message ?? '')
console.log(`commit: attempts=${attempts} name=${rejection?.name} retryable=${rejection?.retryable} dailyLimit=${rejection?.dailyLimit}`)
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

/* ---- 4. 端到端矩阵：本插件的各种失败 → 宿主会判成什么、会不会重试 ------ */

/**
 * 判定器用的是**宿主源码里每个分支的原文**，不是手抄的一份规则：把
 * `if (<条件>) return <码>;` 逐行取出，条件与返回值都按它们自己的文本求值。
 * 宿主新增或重排分支时本探针跟着变；兜底分支另按原文断言存在，不静默退化。
 */
function buildHostClassifier(body) {
  const branches = []
  for (const line of body.split('\n')) {
    const matched = /^\s*if \((.*)\) return (.*);$/.exec(line)
    if (matched === null) continue
    branches.push({
      test: new Function('message', 'isQuotaExceededError', `return (${matched[1]});`),
      value: new Function('QUOTA_EXCEEDED_CODE', `return (${matched[2]});`),
    })
  }
  return {
    count: branches.length,
    classify: (message) => {
      for (const branch of branches) {
        if (branch.test(message, isQuotaExceededError) === true) return branch.value(QUOTA_EXCEEDED_CODE)
      }
      return 'PI_AI_ERROR'
    },
  }
}

const { classify, count } = buildHostClassifier(classifier)
// 宿主这版正好 9 条 `if`（末行是 `return "PI_AI_ERROR"` 兜底，不参与解析）。数字变了
// 说明宿主改了分类器，本探针的矩阵与注释得跟着重读——所以按相等断言，而不是“至少几条”。
check(count === 9, `分类器解析出 ${count} 条 if（宿主这版是 9 条）`)
check(classifier.includes('return "PI_AI_ERROR"'), '兜底分支 `return "PI_AI_ERROR"` 还在')

/** 可重试集合：字面量里的字符串码 + 标识符形式的 EMPTY_RESPONSE_CODE（原样取自宿主常量）。 */
const RETRYABLE = new Set([...retryable.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]))
if (retryable.includes('EMPTY_RESPONSE_CODE')) RETRYABLE.add(EMPTY_RESPONSE_CODE)

/**
 * shim 的三个出口（`src/host/shim.ts:438-461`）：`retryable` → 503 `rate_limit`、
 * `dailyLimit` → 429 `daily_limit_exceeded`、其余 → 502 `upstream_error`。
 * 下面是它的镜像；先用源码文本断言那三行还在，免得镜像悄悄过期。
 */
const shimSource = readFileSync(new URL('../src/host/shim.ts', import.meta.url), 'utf8')
const SHIM_EXITS = {
  queue: { text: "writeError(res, 503, 'rate_limit'", status: 503, type: 'rate_limit' },
  quota: { text: "writeError(res, 429, 'daily_limit_exceeded'", status: 429, type: 'daily_limit_exceeded' },
  other: { text: "writeError(res, 502, 'upstream_error'", status: 502, type: 'upstream_error' },
}
for (const exit of Object.values(SHIM_EXITS)) {
  check(shimSource.includes(exit.text), `shim 出口仍在：${exit.text}…)`)
}

const shimExitFor = (error) => {
  if (thrownFlag(error, 'retryable') === true) return SHIM_EXITS.queue
  if (thrownFlag(error, 'dailyLimit') === true) return SHIM_EXITS.quota
  return SHIM_EXITS.other
}

/**
 * 宿主看到的文本。两条合成路径见 [1] 的出处；`inband` 表示这次失败发生在 200 流内部
 * （shim 已经提交了响应头，所以没有状态前缀——见 `src/host/shim.ts:561-601`）。
 */
const hostTexts = (carrier, status, type, message) =>
  carrier === 'inband'
    ? { inband: message }
    : {
        'http(json)': `${status}: ${JSON.stringify({ message, type, code: type })}`,
        'http(msg)': `${status} ${message}`,
      }

/**
 * 每一行记录**宿主当前的行为**（不是我们希望的行为）。`open` 标记的是「终态判决却被
 * 宿主当成可重试」——那是记在案的口子；宿主一旦改好，这一行会变成 CHANGED，提醒改表。
 * `carrier: 'inband'` 表示这次失败发生在 200 流内部、shim 已提交响应头，因此没有状态前缀。
 */
const SSE = { contentType: 'text/event-stream' }
const frameCase = (body) => ({ status: 200, text: sseFrame(body), ...SSE })

const CASES = [
  {
    label: '每日额度：429 + daily_limit_exceeded（首个响应 → shim 出口 429）',
    drive: () => driveChat([{ status: 429, text: JSON.stringify(BODY) }]),
    expect: 'QUOTA',
    expectRetryable: false,
  },
  {
    label: '每日额度：200 流内的错误帧，首个帧（shim 出口仍是 429）',
    drive: () => driveChat([frameCase({ code: 'daily_limit_exceeded', message: 'daily request allowance is used up' })]),
    expect: 'QUOTA',
    expectRetryable: false,
  },
  {
    label: '登录过期：200 流内的错误帧（105），首个帧 → shim 出口 502',
    drive: () => driveChat([frameCase({ code: '105', message: 'Login expired' })]),
    expect: 'SERVER',
    expectRetryable: true,
    open: '首帧就失败 → 502，文案里没有 401/403 也没有 4xx 数字 → 宿主判 SERVER，白重试 5 次',
  },
  {
    label: '登录过期：200 流内的错误帧（105），已有分片之后 → 帧内交付',
    carrier: 'inband',
    drive: () =>
      driveChat([
        {
          status: 200,
          text: sseFrame({ choices: [{ delta: { content: 'hi' } }] }) + sseFrame({ code: '105', message: 'Login expired' }),
          ...SSE,
        },
      ]),
    expect: 'PI_AI_ERROR',
    expectRetryable: false,
  },
  {
    label: '登录过期：HTTP 401（文案里带 HTTP 401）',
    drive: () => driveChat([{ status: 401, text: JSON.stringify({ message: 'Login expired' }) }]),
    expect: 'AUTH',
    expectRetryable: false,
  },
  {
    label: '协议形状漂移（终态，shim 出口 502）',
    drive: async () => ({ error: new ProtocolShapeChangedError('{"unexpected":true}'), attempts: 0 }),
    expect: 'SERVER',
    expectRetryable: true,
    open: '502 命中 `\\b5\\d\\d\\b` → SERVER → 重试 5 次；而它的文案正是「插件需要更新」',
  },
  {
    label: '上游拒绝（HTTP 400 的不明 body，shim 出口 502）',
    drive: () => driveChat([{ status: 400, text: JSON.stringify({ message: 'account is not allowed to use this model' }) }]),
    expect: 'INVALID_REQUEST',
    expectRetryable: false,
    note: '宿主判对是因为插件文案保留了上游状态（`(HTTP 400: …)`），不是刻意设计——换状态码就会变',
  },
]

console.log('\n[4] 矩阵：本插件的失败 → shim 出口 → 宿主的判决')
for (const item of CASES) {
  const { error, attempts: tries } = await item.drive()
  const message = String(error?.message ?? '')
  const exit = item.carrier === 'inband' ? SHIM_EXITS.other : shimExitFor(error)
  const texts = hostTexts(item.carrier ?? 'http', exit.status, exit.type, message)
  const codes = Object.entries(texts).map(([carrier, text]) => [carrier, classify(text)])
  const verdicts = [...new Set(codes.map(([, code]) => code))]
  const retried = verdicts.some((code) => RETRYABLE.has(code))
  const head =
    `${item.label}\n        shim=${item.carrier === 'inband' ? `in-band/${exit.type}` : `${exit.status}/${exit.type}`} ` +
    `name=${error?.name ?? '-'} attempts=${tries} ` +
    `code=${verdicts.join('/')} retryable=${retried}`
  const codeMatches = verdicts.includes(item.expect)
  const retryMatches = item.expectRetryable === undefined || item.expectRetryable === retried
  const tag = item.open !== undefined ? 'ok  [OPEN]' : 'ok       '
  if (!codeMatches || !retryMatches) {
    console.log(`  CHANGED ${head}\n        记录的是 code=${item.expect} retryable=${item.expectRetryable ?? '（未记）'}——宿主行为变了就来改这张表`)
    failures += 1
  } else if (verdicts.length !== 1) {
    console.log(`  ${tag} ${head}\n        两种合成分别是 ${codes.map(([carrier, code]) => `${carrier}=${code}`).join(' / ')}，“会不会重试”一致`)
  } else {
    console.log(`  ${tag} ${head}`)
  }
  if (item.open !== undefined) console.log(`        记在案的口子：${item.open}`)
  if (item.note !== undefined) console.log(`        说明：${item.note}`)
}

/**
 * 传输层失败不驱动：它会被插件自己的阶梯接住并把 120 s 预算跑满（实测 11 次请求），
 * 探针不该为此停两分钟。改用源码断言——那一条分类规则还在，宿主的判决就还是可重试。
 */
const sseSource = readFileSync(new URL('../src/host/upstream/sse.ts', import.meta.url), 'utf8')
check(
  sseSource.includes("code === 'ECONNRESET'") && sseSource.includes('throw new QueueRejection(0, `network: ${detail}`)'),
  '传输层失败（ECONNRESET 等）仍是 QueueRejection → shim 出口 503 → 宿主 RATE_LIMIT/SERVER（设计意图：会重试）',
)

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}：${failures === 0 ? '每日额度这条 429 不可重试；其余各行与探针记录一致（[OPEN] 是记在案的口子）' : '契约已漂移，或每日额度这条 429 又变成可重试了'}`)
process.exitCode = failures === 0 ? 0 : 1
