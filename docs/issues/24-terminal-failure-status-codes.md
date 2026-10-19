# 终态判决的出口状态：shim 一律 502、宿主一律当 SERVER——白重试 5 次

**P2 · 规模 S · 依赖 23 · 🔍 已摸排（2026-10-19），未改**

23 修掉了「每日额度这条 429 被当成队列」。修完顺手把**每一种**失败都喂给宿主自己的
分类器（`probe/host-retry-classification-probe.mjs` 的 [4] 矩阵），于是同一类的其余口子
一次看全。本文只记录摸排结果与取舍，**没有**改代码——每条都牵到行为取舍，不该顺手改。

## 方法（可复跑）

```sh
node probe/host-retry-classification-probe.mjs   # 0.3 s，PASS 时 exit 0
```

矩阵不手抄宿主的规则：它从安装副本里取出 `classifyPiAiError` 的**每个分支原文**求值
（9 条 `if` + `PI_AI_ERROR` 兜底），可重试集合也读 `DEFAULT_RETRYABLE_CODES` 的字面量，
并把 shim 的三个出口（`src/host/shim.ts:438-461`）用源码文本断言钉住。因此宿主改判法
或插件改出口，矩阵会 `CHANGED` 而不是继续给出旧结论。

## 矩阵（2026-10-19 实测；`retryable` = 宿主的判决落不落在可重试集合里）

| 失败 | shim 出口 | 宿主判决 | 宿主会重试？ |
|---|---|---|---|
| 每日额度：429 + `daily_limit_exceeded` | 429 `daily_limit_exceeded` | `QUOTA` | 否 ✅（23 的修复） |
| 每日额度：200 流内的错误帧 | 429 `daily_limit_exceeded` | `QUOTA` | 否 ✅ |
| **登录过期**：200 流内的错误帧（105），**首个帧** | 502 `upstream_error` | `SERVER` | **是**❗️ |
| 登录过期：同一帧但已有分片之后 | in-band `upstream_error` | `PI_AI_ERROR` | 否 |
| 登录过期：HTTP 401（文案带 `HTTP 401`） | 502 `upstream_error` | `AUTH` | 否 |
| **协议形状漂移**（终态，"插件需要更新"） | 502 `upstream_error` | `SERVER` | **是**❗️ |
| 上游拒绝（HTTP 400 的不明 body） | 502 `upstream_error` | `INVALID_REQUEST` | 否 |
| 传输层失败（ECONNRESET 等）→ 插件自判可重试 | 503 `rate_limit` | `RATE_LIMIT`/`SERVER` | 是（设计意图） |

两处 `❗️` 的机制相同：**shim 对一切非队列、非每日额度的失败都回 502**，而 `502` 命中
宿主的 `\b5\d\d\b` → `SERVER` → 在 `DEFAULT_RETRYABLE_CODES` 里。插件的 `retryable:false`
跨不过进程边界，于是"终态判决"在宿主侧变成"服务器故障、再试 5 次"。

为什么多数行没踩到？因为**插件文案自己保留了上游状态**（`(HTTP 400: …)`），宿主读到
`400` 就落 `INVALID_REQUEST`、读到 `401` 就落 `AUTH`。这不是设计，是巧合——换一个
不带上游状态码的终态（协议形状、首帧的 `upstream 105`）就漏了。

## 三个口子（按影响排序）

### 1. 协议形状漂移被重试 5 次（`⚠️ 语义明确，代价小`）

`ProtocolShapeChangedError` 的文案就是"本插件不认识的格式，请更新插件"，而宿主会带着
这句话重试 5 次（默认 `maxRetries: 5`，指数退避 0.5→10 s，合计 ~15 s）。用户看到的是
"正在重试"，然后才看到"请更新插件"。

### 2. 首帧的登录过期同上（`⚠️ 同机制`）

首帧失败 → shim 502 → `SERVER` → 5 次。每次都会走 `invalidateCredential`（`shim.ts:434-437`），
所以重试期间会反复重读应用登录态；对用户仍然是"先等 15 秒才被告知要重新登录"。

### 3. 队列预算 × 宿主重试：最长 ~12 分钟（`❗️ 需要决策，不是纯 bug`）

这条**不是**上面的分类错误，而是两层预算的乘法：插件自己的阶梯已经等了 120 s
（`QUEUE_WAIT_BUDGET_MS`），放弃时 shim 回 `503 rate_limit` → 宿主按默认策略**再**重试
5 次，每次都可能再烧 120 s。最坏 6 × 120 s ≈ 12 min，期间用户只看到"重试中"。

可选的收窄方式（都没做，因为各有代价）：

- **收窄 provider 的 `retryPolicy.retryableCodes`**（`src/host/adapter.ts:253` 现在传
  `undefined` = 默认）。把 `RATE_LIMIT`/`SERVER` 去掉、只留
  `EMPTY_RESPONSE`/`TIMEOUT`/`TRANSPORT`：上面 1、2 与本节全部立刻消失，且"插件自己
  的阶梯"成为唯一的重试来源（它本来就更懂队列）。**代价**：罕见的、非 transport 形状的
  本地异常也不再被宿主兜底重试——但现在那些异常（见 `sse.ts:385-391` 的注释）本来就
  被判为"代码 bug、报它本身"，不重试是对的。
- **换出口状态**：让终态失败走一个宿主机不重试的状态（如 409/422 → 落 `PI_AI_ERROR`）。
  代价是往"状态码是给宿主看的"这条路上再加一层隐式契约，且 4xx 语义对"上游形状变了"
  并不贴切。
- **不动**：只在本文记录。用户可见代价是几次白重试，不影响正确性。

### 4. 非 chat 路径不参与分类，也不写 `markExhausted`（`ℹ️ 一致性`）

`fetchModels` / `fetchUserInfo` / `fetchUsage` / 签到 / 兑换在 `!ok` 时只抛裸状态码
（`api-calls.ts:104/136/232/443`、`fetch-usage.ts:395`），既不跑 `classifyUpstreamError`，
也不调 `requestCounter.markExhausted`（全仓唯一调用点在 `shim.ts:457`）。后果：撞上每日
限流时，chat 给的是"今天用完了、零点重置"，而卡片刷新只说"上次更新：{time}（刷新失败）"
（`card-model.ts` 的 `refreshNoticeKey` 只分 `protocol-shape-changed`/`persist`/`transient`），
且卡片的本地推断"今日额度疑似已用尽"（`usage.requestsExhausted`）不会亮。

## 顺带确认的、**不是**问题的

- **传输层失败仍会重试**（`sse.ts:374-383` 的 `ECONNRESET/ECONNREFUSED/EPIPE/ENOTFOUND/UND_ERR_*` →
  `QueueRejection`；裸 `TypeError` 故意不在列），宿主接续重试是**有用**的安全网——保持。
- **PAT 兑换的 429** 走 `credential-cache.ts:154` 的限流窗口（有平台给定窗口就照用、
  不设上限；没有才本地退避），与 chat 的 429 是两条独立的线，语义正确。
- **上游失败帧的形状**：上游方向读的是**顶层** `code`/`errorCode`/`message`/`errorMessage`
  （`sse.ts:38-48`），而 shim 写向 DSH 的是 OpenAI 的 `{error:{…}}`。两个方向不同形是
  对的（实测：把 `{error:{…}}` 当上游帧送进去会被判成形状漂移）。

## 验收标准（若动手）

- 探针 [4] 矩阵里两处 `[OPEN]` 消失（`SERVER` → 不可重试的那个码），矩阵表随之更新。
- 第 3 节的决策若选"收窄"，需要一条测试钉住 provider 的 `retryPolicy`，并在
  `docs/issues/23` 的宿主侧说明里同步"插件是唯一重试来源"。
- 第 4 节若动手：`api-calls.ts`/`fetch-usage.ts` 的 `!ok` 路径至少把 `daily-limit` 分类
  出来（复用 `classifyUpstreamError` + `describeThrown`），并让卡片带上额度措辞。
