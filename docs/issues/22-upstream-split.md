# 上游层拆分：2,335 行的 upstream.ts 拆成 11 个叶模块 + ~50 行门面

**P2 · 规模 L · 依赖 —**（2026-10-17 深挖结论：upstream.ts 是三个单文件巨石
（upstream.ts 2,335 / credentials.ts 1,579 / index.ts 1,544）中拆分收益最高、
路径最清晰的一个。本文既是问题记录也是拆分蓝图，动手时照它执行。）

## 背景

`src/host/upstream.ts` 现在 2,335 行，混装六类职责：COSY 签名、置换字母表 base64、
SSE 双层解码、fetch 封装、重试与队列预算、以及各 API 调用（登录/目录/用量/签到/账号）。
任何一处协议变化都要在这个文件里改；test/ 下 12 个测试文件 import 它，另有 5 个 probe、
3 个 src 内 importer——动导出面等于 20 个文件跟着动，所以此前一直没人动它。

## 顺带整改清单（拆分时逐条核销）

| # | 问题 | 证据 | 处置 |
|---|---|---|---|
| 1 | `fetchCampaigns` 是死导出，无任何调用方 | upstream.ts:765 | 拆分时直接删除（先 grep 全仓确认仍为 0 调用） |
| 2 | Retry-After 解析器重复实现两份 | upstream.ts:1774-1787 vs errors.ts `parseRetryAfterSeconds` | 保留 errors.ts 版本，upstream.ts 改 import |
| 3 | `readUmidInfo` 重新实现了 `normalizeUmidBlock` 的逻辑 | 拆分时以 errors/normalize 实测为准 | 收敛到一份，另一处改 import |
| 4 | `fetchUsage` 吞错：catch 后只置 flag，无日志 | upstream.ts:1028-1030 | 违红线 1（静默失败）；拆分时改为可见错误或显式降级 |

## 拆分蓝图（11 叶 + ~50 行门面）

按现有内部结构切；新模块**整体搬迁**代码，不改逻辑；upstream.ts 保留为 ~50 行门面
（re-export 全部现名导出），则 20 个下游文件一行不动。

| 新叶模块（upstream/ 下） | 内容 |
|---|---|
| `crypto.ts` | `aesEncryptCBCBase64`（upstream.ts:247）、RSA 包 AES key（:287）、置换字母表 base64 Encode=1（:1-92 一带） |
| `cosy-sign.ts` | COSY 签名头组装（MD5 over base64 payload + ts + body + sigpath） |
| `sse.ts` | 双层包裹 SSE 解码 |
| `client-constants.ts` | CLIENT_TYPE '5'、DATA_POLICY 'disagree'、UA 等协议常量 |
| `retry.ts` | 重试策略、QUEUE_WAIT_BUDGET_MS=120000（含 rationale 注释） |
| `fetch-usage.ts` | fetchUsage（含整改 #4） |
| `fetch-campaigns.ts` | fetchCampaigns（含整改 #1：预计整个文件删除） |
| `sign.ts` | signaturePath / 签名 info 块（upstream.ts:257、:279 uid 进签名块） |
| `headers.ts` | Cosy-* 头组装（:328 Cosy-User 明文 uid） |
| `endpoints.ts` | 各 API 端点 URL 与信封形状 |
| `api-calls.ts` | 登录/目录/用量/签到/账号各调用编排 |

门面 upstream.ts re-export 全部现名导出（含整改 #1 死导出除外）。

## 验收标准

- [ ] 门面 re-export 后，12 个测试文件 + 5 个 probe + 3 个 importer **一行不改**全绿
- [ ] `npm run typecheck`、`npm test`、`npm run build` 全绿；`lib/` 与 `src/` 同一次提交（红线 3）
- [ ] 整改清单四条全部核销（#1 删除后 grep 复核 0 调用；#4 改后带可见失败测试）
- [ ] `test/audit:any` 两道审计保持 0 命中（client 不涉及，但跑一遍确认）
- [ ] AGENTS.md 协议事实锚点（upstream.ts:80 头部读法）原文整体搬迁，注明新路径
- [ ] 拆分提交里每个叶模块的文件头注明「自 upstream.ts 原文搬迁，未改逻辑」

## 风险（不粉饰）

1. **搬迁时行号漂移**：本文行号是 2026-10-17 时点，动手时以当时源码重量为准，别按行号硬切。
2. **`export *` 门面会放大表面积**：门面逐名 re-export，不用 `export *`，让删除一个导出时
   门面必须显式表态（TS 编译器当场报错），防止死导出悄悄回流。
3. **test/ 里若有对 upstream.ts 文件路径本身的断言**（如 probe-imports 守门），拆分时要同步改——
   这类断言是守门不是负担，改路径不改语义。
