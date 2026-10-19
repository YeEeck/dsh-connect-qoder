# 终态判决的出口状态：shim 一律 502、宿主一律当 SERVER——白重试 5 次

**P2 · 规模 S · 依赖 23 · ✅ 已修（2026-10-19）§1–§3；§4 未动**

23 修掉了「每日额度这条 429 被当成队列」。修完顺手把**每一种**失败都喂给宿主自己的
分类器（`probe/host-retry-classification-probe.mjs` 的 [4] 矩阵），于是同一类的其余口子
一次看全：宿主对**终态判决**也会重试，而且队列的两层预算会相乘。

## 修复（本次）

**收窄本路由交给宿主的重试策略**——`src/host/route-retry-policy.ts`（新文件）：

```ts
export const ROUTE_RETRY_POLICY = {
  mode: 'normal' as const,
  retryableCodes: ['EMPTY_RESPONSE', 'TIMEOUT', 'TRANSPORT'],
}
```

`src/host/adapter.ts:255` 不再传 `undefined`（宿主默认，含 `RATE_LIMIT`/`SERVER`），改传这份
策略。留下的三个码都是**宿主与 shim 之间那一跳**的失败：插件看不见它们，也就重试不了。
`maxRetries`/`backoff` 故意不写——宿主自己的预算与退避不归插件定，收窄的只是集合。

配套改动：

- `probe/host-retry-classification-probe.mjs`：第 [3] 段从「读宿主默认表」改成「默认表 vs
  本路由的生效集合」，硬断言 `RATE_LIMIT`/`SERVER` 不在后者、且后者只从默认表里做减法
  （不自己造码）；第 [4] 段矩阵的 `[OPEN]` 渲染已删——现在任何一行重新变成可重试都是 FAIL。
- `test/route-retry-policy.test.js`（新）：钉住这份字面量、钉住「没写 `maxRetries`/`backoff`」，
  并用源码断言钉住 `adapter.ts` 的接线（回到 `resolveRetryPolicy(undefined` 会红）。
- `src/host/upstream/sse.ts` 的 `DailyLimitRejection` 类注释改写为如实的两道锁说明。

## 方法（可复跑）

```sh
node probe/host-retry-classification-probe.mjs   # 0.3 s，PASS 时 exit 0
node --test test/route-retry-policy.test.js
```

矩阵不手抄宿主的规则：它从安装副本里取出 `classifyPiAiError` 的**每个分支原文**求值
（9 条 `if` + `PI_AI_ERROR` 兜底），默认可重试码表读 `DEFAULT_RETRYABLE_CODES` 的字面量，
生效集合取本插件交出去的 `ROUTE_RETRY_POLICY`，并把 shim 的三个出口
（`src/host/shim.ts:438-461`）用源码文本断言钉住。因此宿主改判法、或本插件把策略改宽，
矩阵都会 `CHANGED` 而不是继续给出旧结论。

## 矩阵（2026-10-19 实测；`retryable` = 宿主的判决落不落在**本路由**的策略里）

| 失败 | shim 出口 | 宿主判决 | 宿主会重试？ |
|---|---|---|---|
| 每日额度：429 + `daily_limit_exceeded` | 429 `daily_limit_exceeded` | `QUOTA` | 否 ✅（23 的修复） |
| 每日额度：200 流内的错误帧 | 429 `daily_limit_exceeded` | `QUOTA` | 否 ✅ |
| 登录过期：200 流内的错误帧（105），**首个帧** | 502 `upstream_error` | `SERVER` | 否 ✅（本次） |
| 登录过期：同一帧但已有分片之后 | in-band `upstream_error` | `PI_AI_ERROR` | 否 |
| 登录过期：HTTP 401（文案带 `HTTP 401`） | 502 `upstream_error` | `AUTH` | 否 |
| 协议形状漂移（终态，"插件需要更新"） | 502 `upstream_error` | `SERVER` | 否 ✅（本次） |
| 上游拒绝（HTTP 400 的不明 body） | 502 `upstream_error` | `INVALID_REQUEST` | 否 |
| 传输层失败（ECONNRESET 等）→ 插件自判可重试 | 503 `rate_limit` | `RATE_LIMIT` | **否**（§3 记下的代价） |

## 修前修后

### 1. 协议形状漂移被重试 5 次（修前：`⚠️ 语义明确，代价小`）

`ProtocolShapeChangedError` 的文案是"本插件不认识的格式，请更新插件"，而 shim 对一切非
队列、非每日额度的失败都回 `502 upstream_error`，`502` 命中宿主的 `\b5\d\d\b` → `SERVER`
→ 在默认集合里。用户看到的是"正在重试"约 15 s（`maxRetries: 5`，指数退避 0.5→10 s），
然后才看到"请更新插件"。宿主的判决仍是 `SERVER`（这句话里没有别的可认的词），但现在
`SERVER` 不在本路由的策略里，所以它立刻显示。

### 2. 首帧的登录过期同上（修前：`⚠️ 同机制`）

首帧失败 → 502 → `SERVER` → 5 次，每次都会走 `invalidateCredential`
（`shim.ts:434-437`），重试期间反复重读应用登录态。现在同样一次就报出来。

### 3. 队列预算 × 宿主重试：最长 ~12 分钟（修前：`❗️ 需要决策`；本次选择"收窄"，代价见下）

这不是分类错误，而是两层预算的乘法：插件自己的阶梯已经等了 120 s
（`QUEUE_WAIT_BUDGET_MS`），放弃时 shim 回 `503 rate_limit` → 宿主按默认策略**再**重试
5 次，每次都可能再烧 120 s。最坏 6 × 120 s ≈ 12 min，期间用户只看到"重试中"。

**收窄策略**（本次采用）：上面 1、2 与本节全部消失，插件的阶梯成为唯一重试来源——它本来
就更懂队列（认得队列标记、会用 `retryAfterSeconds`）。

**代价（要记住的一条）**：传输层失败（ECONNRESET 等，`sse.ts:374-383`）与"队列预算花完"
走出**同一个** `QueueRejection` → 同一个 `503 rate_limit`，所以在编码层面分不开：收窄
`RATE_LIMIT` 等于把网络抖动的宿主兜底也一起去掉。剩下的持久化预算是插件阶梯的 120 s。
若哪天要只把网络那条接回宿主的兜底，得先让两者走不同的出口状态——那是**另一件改动**，
不是把这里改宽的借口。

**未采用的备选**：换出口状态（让终态失败走宿主机不重试的状态，如 409/422 → 落
`PI_AI_ERROR`）。代价是往"状态码是给宿主看的"这条隐式契约上再加一层，且 4xx 语义对
"上游形状变了"并不贴切；而策略收窄一次覆盖了所有终态失败，不需要每种失败各挑一个状态码。

### 4. 非 chat 路径不参与分类，也不写 `markExhausted`（`ℹ️ 一致性`，**未动**）

`fetchModels` / `fetchUserInfo` / `fetchUsage` / 签到 / 兑换在 `!ok` 时只抛裸状态码
（`api-calls.ts:104/136/232/443`、`fetch-usage.ts:395`），既不跑 `classifyUpstreamError`，
也不调 `requestCounter.markExhausted`（全仓唯一调用点在 `shim.ts:457`）。后果：撞上每日
限流时，chat 给的是"今天用完了、零点重置"，而卡片刷新只说"上次更新：{time}（刷新失败）"
（`card-model.ts` 的 `refreshNoticeKey` 只分 `protocol-shape-changed`/`persist`/`transient`），
且卡片的本地推断"今日额度疑似已用尽"（`usage.requestsExhausted`）不会亮。

（23 的修复让 429 载体的每日限流真的走到 `markExhausted`，所以 chat 那一侧的
「今日额度疑似已用尽」现在会亮；这里说的是非 chat 路径。）

## 顺带确认的、**不是**问题的

- **传输层失败在插件内仍会重试**（`sse.ts:374-383` 的 `ECONNRESET/ECONNREFUSED/EPIPE/ENOTFOUND/UND_ERR_*` →
  `QueueRejection`；裸 `TypeError` 故意不在列）。变的只是宿主那一层（§3 的代价）。
- **PAT 兑换的 429** 走 `credential-cache.ts:154` 的限流窗口（有平台给定窗口就照用、
  不设上限；没有才本地退避），与 chat 的 429 是两条独立的线，语义正确。
- **上游失败帧的形状**：上游方向读的是**顶层** `code`/`errorCode`/`message`/`errorMessage`
  （`sse.ts:38-48`），而 shim 写向 DSH 的是 OpenAI 的 `{error:{…}}`。两个方向不同形是
  对的（实测：把 `{error:{…}}` 当上游帧送进去会被判成形状漂移）。
- **宿主确实装着重试插件**：`@deepseek-ai/dsh-llm-retry` 由基座包无条件组合
  （`@deepseek-ai/dsh-base/cordis.patch.yml` 的 `- id: llm-retry`），本机 profile 的
  `cordis.patch.yml` 没有覆盖它——所以这份策略不是"配了也不生效"。

## 验收标准

- [x] 探针 [4] 矩阵里两处 `[OPEN]` 消失，矩阵表随之更新。
- [x] 一条测试钉住 provider 的 `retryPolicy`：`test/route-retry-policy.test.js`。
- [x] `docs/issues/23` 的宿主侧说明里同步"重试来源"的现状。
- [ ] §4 若动手：`api-calls.ts`/`fetch-usage.ts` 的 `!ok` 路径至少把 `daily-limit` 分类
      出来（复用 `classifyUpstreamError` + `describeThrown`），并让卡片带上额度措辞。
