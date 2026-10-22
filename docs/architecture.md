# 架构与模块目录

本文是代码结构参考：数据流、模块职责、构建产物与插件自己持有的持久化文件。安装与使用见根目录 [README](../README.md)。

```
DSH PiAiAdapter（每个区域一套）
  -> 安全 loopback shim（随机端口 + 进程内随机 secret）
  -> COSY 签名 + 自定义 base64 编码
  -> 国内版 https://gateway.qoder.com.cn/
  -> 国际版 https://api3.qoder.sh/
  -> Qoder 双层包装 SSE
  -> OpenAI SSE
  -> DSH 本地执行工具并回传结果
```

Qoder 不是 OpenAI 兼容端点，所以需要三样东西：

1. **COSY 签名头** —— 每个网关请求都带 `Cosy-*` 头与 `Authorization: Bearer COSY.<payload>.<sig>`，
   签名是对 base64 负载、RSA 包装的 AES 密钥、时间戳、请求体与签名路径做 MD5。
2. **置换 base64 请求体** —— 查询串里的 `Encode=1` 表示 JSON 体要先 base64、再按换过的字母表
   逐字符替换、最后按三分之一旋转。
3. **双层 SSE** —— 每个 `data:` 帧是一个信封对象，它的 `body` 字段本身又是 JSON 字符串，
   里面才是 OpenAI 风格的 chunk。

## 模块目录

### Host（`src/host/`）

| 文件 | 作用 |
| --- | --- |
| `src/host/credentials.ts` | 从 Qoder 应用**读取**登录凭据的存储半边：探测候选应用目录、以只读方式打开 `state.vscdb`、解码各行（2026-10-20 从中拆出 OSCrypt 链，链在下一行） |
| `src/host/oscrypt-unwrap.ts` | OSCrypt 链：PowerShell/DPAPI 解包主密钥、密钥缓存与 `Local State` 绑定、失败窗口 60 s、清零与启动清扫（**唯一会把密文写到进程外、唯一 spawn 子进程、唯一删东西**的一半；两个解包入口都接受注入的 spawner，因此链内环节可无 PowerShell 测） |
| `src/host/upstream.ts` | 上游层的**门面**（26 行）：逐名 re-export `src/host/upstream/` 下的 11 个叶模块，让 20 个下游 importer 一行不动（2026-10-17 拆分，`docs/issues/22`） |
| `src/host/upstream/crypto.ts` | RSA 公钥、置换字母表与 `Encode=1` 请求体编码（`CUSTOM_ALPHABET` / `encodeBody`）；协议事实原文注释在此文件头 |
| `src/host/upstream/client-constants.ts` | `COSY_VERSION` / `CLIENT_TYPE` / `MACHINE_TYPE` / `DATA_POLICY` / `LOGIN_VERSION` / `MACHINE_OS` |
| `src/host/upstream/sign.ts` | `signaturePath`（签名路径，剥掉 gateway 路由掉的 `/algo` 前缀） |
| `src/host/upstream/cosy-sign.ts` | `authHeaders`：COSY 签名头组装（AES 加密签名 info 块、RSA 包 AES key、MD5 over payload/key/ts/body/path） |
| `src/host/upstream/headers.ts` | `openApiHeaders` 与 umid 机器身份头（Windows 定位 `runtime-info.exe`；读不到时显式降级，`__dshQoderUmidState` 报原因） |
| `src/host/upstream/endpoints.ts` | 各 API 端点 URL 构造（目录/对话/兑换/账号/用量/签到） |
| `src/host/upstream/retry.ts` | 重试与排队耐心（`QUEUE_WAIT_*`、`queueWaitFor`，以及衡量**沉默**而非总时长的空闲窗口 `IDLE_WINDOW_MS`） |
| `src/host/upstream/sse.ts` | 双层包裹 SSE 解码与对话流（`streamChat`，含重试循环与 `Retry-After` 处理） |
| `src/host/upstream/fetch-usage.ts` | 用量快照（`fetchUsage` / `UsageSnapshot` / `normalizeQuotaBucket` / `normalizeDedicatedPackage` / `normalizePromotion`）；促销读失败时**具名降级**而非静默（`campaignsError`） |
| `src/host/upstream/api-calls.ts` | 各调用的编排与 JSON 读取（`readJson` / `readCampaigns` / `claimCampaign` / `fetchModels` / `readModelCatalogShape` / `exchangePat` / `fetchUserInfo`） |
| `src/host/upstream/messages.ts` | DSH ↔ Qoder 的消息与工具描述转换（`toQoderMessages` / `toQoderTools`） |
| `src/host/shim.ts` | 面向 pi-ai 的 OpenAI 兼容回环端点 |
| `src/host/adapter.ts` | pi-ai provider 与 `PiAiAdapter` profile（被关的 provider 以零模型组呈现，由 DSH 自行隐藏） |
| `src/host/route-retry-policy.ts` | 本路由**交出去给宿主**的重试策略：只留 `EMPTY_RESPONSE` / `TIMEOUT` / `TRANSPORT`，让插件的队列阶梯成为唯一重试源——宿主默认策略含 `RATE_LIMIT` / `SERVER`，会把已烧完 120 s 预算的队列失败再续 5 次（≈12 min），也会白重试 shim 一律用 502 表达的终态判决；刻意不设 `maxRetries` / `backoff`（未知键会让整个 profile 注册失败；`docs/issues/24`，无 peer 依赖） |
| `src/host/catalog-entry.ts` | 目录条目的归一化、模型过滤（含按区域开关）与卡片行投影（无 peer 依赖） |
| `src/host/catalog-store.ts` | 目录的磁盘缓存与原子落盘（无 peer 依赖） |
| `src/host/catalog-refresh.ts` | 一次目录刷新的结果如何落地：**空目录也是结果**（照实清空并推进 `fetchedAt`），只有失败才保留上一份，且失败按 `credential` / `no-credential` / `fetch` / `protocol-shape-changed` 分档（无 peer 依赖） |
| `src/host/credential-cache.ts` | 凭据缓存与「登录失效后重读」规则，以及 env-PAT 兑换的 429 节流闸门（平台自述窗口优先、否则指数退避；401/403 停泊，仅「重读登录」释放；无 peer 依赖）。三源顺序是「桌面端（**没过期**才算在场）→ 插件自有设备登录 → 环境变量 PAT」：过期的桌面端 access token 什么都干不了（连 provider 都不会被注册），所以它不再压住后面两条 |
| `src/host/credential-kind.ts` | 「这个版本现在是谁在服务」的答案：凭据来源标签 → `desktop` / `device` / `env` 三档。宿主是唯一知道实际解出哪条凭据的一方，所以由它说；卡片与 status 路由据此把「桌面端登录」与「插件自有登录」两本账并成一条，不再靠面板猜（无 peer 依赖） |
| `src/host/throttle-store.ts` | 兑换节流闸门的磁盘持久化（只存未过期的 rate-limit 窗口、parked 停泊与令牌一律不落盘，原子写，无 peer 依赖） |
| `src/host/request-counter.ts` | 本地「今日经本客户端请求次数」计数：上游只报「用完了」不给每日上限，故只能本地自计（每次对话轮 +1，重试不重复计）。按 region + 上海本地日分文件、零点翻页、原子写（`temp/rename`）、越界 region 分量拒绝写盘、`gc` 只删本插件命名且早于保留期的旧日文件；撞 `daily_limit_exceeded` 时置 `dailyLimitHit` 不丢计数（无 peer 依赖） |
| `src/host/token-counter.ts` | 本地「今日经本客户端消耗的 token 数」累加器：shim 每抓到一个上游 usage 帧（`total_tokens` / `cached_tokens`，上游每轮明确下发）就累加进本插件文件（`.qoder-token-count.<region>.<day>.json`）。与请求计数器同源同套路（按 region + 上海本地日分文件、零点翻页、原子写、越界防护、`gc` 只删本插件旧文件），但数据来自上游而非本地估算——聚合的是上游已经公开的真实 token 数，不画比例条（无每日上限口径）；`tokensFromUsage` 对坏帧返回 `null` 宁可不加也不加错 |
| `src/host/credential-vault.ts` | 插件自有凭据文件的读写（设备登录换来的可刷新令牌）：`0600` + `temp/rename` 原子写、损坏文件**隔离留存**而非被后来者覆盖、读-改-写整体串行（并发的刷新不会把刚登出的凭据写回来，无 peer 依赖） |
| `src/host/device-login.ts` | 设备登录的协议层（两个 region 各自的端点、`client_id`、PKCE 与轮询/刷新请求）：404 与「还没审批」的空信封都读作未授权而非失败；**刷新应答不是凭据**——实测只有六个字段、把访问令牌叫 `device_token` 且**不带 `user_id`**，必须叠加回被刷新的那一份，否则签名带上空 uid 会被网关回 403 `Signature invalid`（无 peer 依赖） |
| `src/host/device-credential.ts` | 把 vault 里那份令牌变成可签名的凭据、并在过期时轮换：**五档状态**（`none` / `ok` / `expired` / `refresh-failed` / `unreadable`）而非两档——「本机没登录过」与「文件读不出来」指向不同下一步；刷新被拒后有 60s 窗口（否则每轮对话都会重试一条已被吊销的刷新令牌）；刷新成功但落盘失败仍照常出借凭据、只 warn；**从不抛**（抛出去就等于把登录问题变成 provider 坏掉）（无 peer 依赖） |
| `src/host/device-login-flow.ts` | 设备登录的会话状态机（按 region 一次一个尝试，5 分钟 TTL）：把探针那种「一个进程等着」拆成卡片能驱动的 `start` / `poll` / `cancel`，否则一个路由要挂五分钟且面板一关就丢；PKCE verifier 只留在宿主内存、**绝不出现在任何返回值里**；`poll` 每次只发一次请求；**兑换码只能用一次**（尝试先删再写凭据，否则之后的 poll 会给第二个令人困惑的答案）；「批准了但没存下」报 `failed` 而非成功（假确认是红线 1 禁止的）（无 peer 依赖） |
| `src/host/account-payload.ts` | 账号面板三条路由共用的那份应答：逐区域状态 + 开关映射，以及「渲染读缓存 / 重读登录读真」这一个开关（从 `index.ts` 抽出以便直测，无 peer 依赖） |
| `src/host/account-state.ts` | 每区域账号状态四档判定（`ok` / `expired` / `needs-app` / `signed-out`；纯本地证据、不含凭据，无 peer 依赖）；三种读取模式（默认 / `cachedOnly` 不解包 / `force` 忽略失败窗口） |
| `src/host/settings-save.ts` | 设置命名空间的解析（0.2 代由宿主推导，插件不能自选）、设置写入、按区域合并与落盘读回校验（无 peer 依赖） |
| `src/host/pi-model.ts` | pi-ai 模型描述符的构造（纯函数，无 peer 依赖） |
| `src/host/adapter-models.ts` | 单个区域向 DSH 提供的模型列表：区域开关（只认显式 `true`）、勾选过滤、最大上下文开关、逐模型图像模式（从 `adapter.ts` 抽出以便直测，无 peer 依赖） |
| `src/host/region-gate.ts` | 一个区域能否作为 provider 上线：三档拒绝（无登录 / 已过期 / 读不到）各自的判定与日志级别（从 `index.ts` 抽出以便直测，无 peer 依赖） |
| `src/host/lifecycle.ts` | 插件 fiber 退出时要撤销的东西：路由注册的注销句柄收集与释放（宿主是否随 fiber 回收无法从插件侧确认，故两种语义都正确；无 peer 依赖） |
| `src/host/preferences.ts` | 设置项的读取与 volatile 解包（`enabledRegions` 区域开关：缺失/非对象一律读作开启，只有显式 `false` 才关；排队耐心档位的读取在下一行的 `patience.ts`） |
| `src/host/patience.ts` | 排队耐心档位的**单一词表与唯一推导处**：`PatienceTier` / `PATIENCE_TIERS` / `DEFAULT_PATIENCE_TIER` 与解析器 `patienceTierOf`（返回 `{ tier, invalid }`——回落默认档时必须带 `invalid: true`，卡片据此显示告警，不许静默）；`limitsFor(tier)` 给出该档的排队耐心（2/4/6 分钟 = 120000/240000/360000 ms）与**推出**的空闲窗口（耐心 ÷ 2 = 60000/120000/180000 ms），`streamIdleCeilingFor(tier)` 给出流空闲天花板（耐心 + 60 s = 180000/300000/420000 ms）。三项由**派生**而非三个并列常量保证「空闲窗口 < 排队耐心 < 流空闲天花板」，档位由 shim 每单次请求读一次、adapter 每次建 profile 读一次（无 peer 依赖） |
| `src/host/offpeak.ts` | 错峰窗口与费率算术（无 peer 依赖） |
| `src/host/single-flight.ts` | 同类异步任务的并发合并：刷新在途时，后来的调用并入同一次请求（目录/用量刷新用，无 peer 依赖） |
| `src/host/claim.ts` | 每日签到：当轮活动的挑选、可领状态判定与领取结果的归一化（纯函数，无 peer 依赖） |
| `src/host/errors.ts` | 上游错误帧的判定：105（登录没了）与 10605（在排队）的分诊，队列提示的提取，以及**协议形状变化**这一档（`ProtocolShapeChangedError`，`retryable: false` 所以它不会被当成"排队"慢慢等）（无 peer 依赖） |
| `src/host/time.ts` | 上游时间戳的单一换算（秒 / 毫秒 / RFC 3339 → epoch 毫秒），曾经的两份副本行为不一致（无 peer 依赖） |
| `src/host/volatile.ts` | volatile 活引用 `{ get() }` 的解包，此前散在三处（无 peer 依赖） |
| `src/host/http-utils.ts` | 回环路由共用的 JSON / OpenAI 形状错误响应（`no-store`，卡片轮询读不到陈旧数据；无 peer 依赖） |
| `src/host/domain.ts` | 各宿主模块标注时共用的领域词表（`Region` / `CatalogEntry` / `Promotion` / `CatalogOutcome` 等）。**只有类型、没有运行时值**，所以不进产物、不改变任何 bundle 字节；刻意不描述任何 peer 模块的形状——那些包由宿主运行时提供、此处只有 `declare module` 空壳，凭空造一个"看起来对"的接口比 `any` 更危险，因为它不会承认自己不知道（无 peer 依赖） |
| `src/host/routes.ts` | 每条卡片路由共用的两道闸：方法检查（405 带 `Allow`、`HEAD` 交给 GET）与**同源**来源检查（403；比对 `Host` 头，POST 路由靠它挡住本机其它端口的网页），以及带 64 KiB 上限的 JSON body 读取器（无 peer 依赖） |
| `src/host/handlers.ts` | 七条卡片路由的 handler，`(req, res, deps) => Promise<void>` 形态：方法/来源两道闸 + 业务判定 + 应答全在这（含签到 `claimTodayFor` 与「重读登录」的失败保护），`index.ts` 只保留 `webServer.register` 与 deps 装配（从 `index.ts` 抽出以便直测，无 peer 依赖）。「在线校验登录」的兜底路径经 `deps.readCredential` 取凭据，宿主把它接到**按 region 共享的凭据缓存**上，所以没有 runtime 的 region 也能校验插件自有登录（无 peer 依赖） |
| `src/host/publish-regions.ts` | 把当前区域集发布给宿主（`registerAdapter` + `registerConfigurableProviders`）以及失败时的三层回滚：先释放旧的一对，新注册失败则释放半注册的 adapter 并把旧的一对装回去，装不回去则如实留空而不谎称已注册（从 `index.ts` 抽出以便直测，宿主两处注册接缝靠注入，无 peer 依赖） |
| `src/host/route-mount.ts` | 一组路由的挂载判定：**要么全挂上、要么全撤下**。三个账号路由是一个功能，宿主若只收下 `/account` 而拒了 `/account/confirm`，旧写法会留下一个"能读状态、两个按钮却不动"的半截面板，且日志写着"account routes unavailable"——那句话是假的，比没有日志更坏，因为它让人不再往下查。组内任一注册被拒即回滚已拿到的 release 并如实报失败（无 peer 依赖） |
| `src/host/dispose-order.ts` | fiber 注销时的**次序**（次序本身就是内容）：provider 注册先撤、路由先于 runtime 拆（否则 issue 13 那条泄漏）、`disposed` 必须在 `clearInterval` **之前**置位——否则一次还在途的 `refreshCatalog().then` 会把一个全新的 interval 装到已经没人管的 runtime 上，成为活过插件的僵尸凭据解析循环。此前这条只由注释担保（无 peer 依赖） |
| `src/host/injected.ts` | `requireInjected`：把 "`ctx.inject(['webServer'], cb)` 保证 cb 跑时该服务已在" 这个只活在注释里的前提，转成**一次**类型收窄——服务缺失就抛错点名该服务，而不是让后续注册把路由挂到 `undefined` 上、再于更晚静默失败。此前它是 `activate()` 里的内联闭包（七处调用共用），此前这条也只由注释担保；抽出以便直测，只认 `undefined`（其它 falsy 值是宿主自己的契约违反，原样交回、不改写）（无 peer 依赖） |
| `src/host/index.ts` | 按区域注册 provider 的插件入口，与七条路由的注册接线（handler 本体在 `handlers.ts`；发布与回滚的判定在 `publish-regions.ts`；挂载分组在 `route-mount.ts`；注销次序在 `dispose-order.ts`；注入服务缺失的判定在 `injected.ts`） |

`docs/docs-qoder-cn/` 是从 Qoder CN 官方文档抓回并清洗的资料（**纯 Markdown，源 `.txt` 已删**），
由根目录的 `convert-qoder-docs.ps1` 一次性转换而成——它**只处理这一批抓取件**，不是常规构建步骤；
产物由 `test/docs-markdown.test.js` 守着，改动转换规则后重跑该测试即可。文档与代码的对应关系
（哪条系数/活动/签到事实落在哪个模块）记录在该目录的 `Qoder CN 文档与插件设计佐证.md`。

### Client（`src/client/`）

卡片侧的源码在 `src/client/`（产物是 `lib/client.js`，`react` 由宿主提供，产物不打包它）：

| `src/client/paths.ts` | 卡片用到的五条插件路由 |
| `src/client/styles.ts` | 卡片样式与 `installStyles`（`dsm-*` 一套与 `dsh-connect-workbuddy` 逐字一致，原因见文件头） |
| `src/client/settings-write.ts` | 「写入后读回校验」的浏览器半边 |
| `src/client/controller.ts` | 卡片可编辑状态机（staged/saved 四个字段——按区勾选、逐模型图像、最大上下文开关、排队耐心档位——`dirty`、`save`、`discard` 与派生的模型视图）——无 React、无 DOM，可被 `node:test` 直接测 |
| `src/client/copy.ts` | 卡片文案聚合入口（中/英），`index.ts` 与 `card.tsx` 只从这里取 |
| `src/client/copy-row.ts` `copy-usage.ts` `copy-account.ts` | 按面板拆分的三段文案：模型行与错峰、用量与签到、账号与区域标签条 |
| `src/client/card-model.ts` | 卡片的**浏览器无关决策层**：视图模型类型词汇 + 纯规则（`offPeakState` / `rateAt` / `windowLabelOf` / `refreshNoticeKey` / 格式化 / `describeThrown`——卡片所有 catch 块给用户看的失败文案都过它）。无 React、无 DOM、无 `fetch`，因此 Node 测试可直接 import 真规则，而非镜像副本（这是向 sensenova `snapshot.ts` 对齐的那一刀；`describeThrown` 也从 `card.tsx` 挪进来，拆掉装配层与两个容器之间的循环 import） |
| `src/client/http.ts` | 卡片**唯一的 `fetch` 收口**：`getJson` / `postJson`，模型名册读与两台容器（用量 / 账号）共六道宿主路由 fetch 都只通过这里（向 sensenova `http.ts` 看齐）；GET / POST 失败都先取宿主的 `error` 字段（如 loopback origin 检查的 `origin-not-trusted`），无才回落 `HTTP {status}`；宿主的 `writeError` 写的是 `{error:{message,type,code}}`，故对象形状也取它的 `message`（否则每道 `writeError` 拒绝都会退化成一句没有下文的 `HTTP 500`）；GET 200 但 body 解析失败按 `unparseable JSON body` 抛出而非当空数据，避免「假 undefined 失败」 |
| `src/client/usage-panel.tsx` | 用量容器 `QoderUsagePanel`：自有额度读 + 每日签到领取两条 fetch，渲染 `RegionUsage` / `CheckinCard`（二者留在 `card.tsx` 作为无 hook 纯展示件） |
| `src/client/account-panel.tsx` | 账号容器 `QoderAccountPanel`：区域条 + 选中区域登录卡，四道 fetch（读 / 重读 / 确认 / 开关写），开关写仍带完整 `enabledRegions` map。**按"在服务的是谁"显示**：`effectiveStateOf()` 判出这个版本真正在服务的是桌面端还是插件自有凭据，只有后者在服务时才读作"已登录"、才给「在线校验登录」按钮（桌面端那条在服务时按钮同样在） |
| `src/client/device-login-panel.tsx` | **插件自有登录**那一块（第三个凭据来源的卡片半边）：与账号行的 `state` **并列上报、绝不合并**——桌面端登录与插件令牌是两份凭据两种寿命。两层结构（外层无 hook 做门控，`device` 缺席 = 老宿主 → 什么都不渲染、绝不报「未登录」；内层持全部 hook）。`start` → `window.open` 授权页 + 保留可点回退链接 → 每 2s 轮询一次（链式而非 interval，慢响应只会推迟下一次而不会叠请求）；`authorized` 停并回读，`expired`/`idle`/`failed` 各给不同文案；卸载时若仍在等待就 best-effort `cancel`（宿主 5 分钟 TTL 是兜底）。**每个失败都说出是哪个失败**，`t`/`onChanged` 由 ref 持有并刻意排除在轮询 effect 依赖外（否则父组件每次渲染都会重启计时器） |
| `src/client/card.tsx` | 卡片的装配层 `QoderPluginCard`（把 `QoderAccountPanel` / `QoderUsagePanel` 与模型列表拼起来，纯规则委托 `card-model.ts`、可编辑状态委托 `controller.ts`、名册读走 `http.ts`）+ 三个无 hook 纯展示件（`RegionUsage` / `CheckinCard` / `QuotaBlock`） |
| `src/client/pill-model.ts` | 输入框用量胶囊的**浏览器无关决策层**：区域归属门控（`isQoderRegion` / `selectedRegionOf` / `candidateOf`）、主额度选择（`primaryQuotaOf`——套餐优先，CN 免费层 plan 为 0 回落资源包）、分级（`tierOfQuota`，阈值与卡片同源 `WARN_SHARE = 0.8`）、读数格式化（`remainingOf` / `formatCredits`）。无 React、无 DOM、无 `fetch`，Node 测试直接 import 真规则 |
| `src/client/composer-usage-pill.tsx` | 对话框用量胶囊 `ComposerUsagePill`：挂在宿主输入框工具栏 `conversation.input.right` 座席，读数 `Qoder CN · 1,034`（区域前缀 · 主额度剩余 Credits）+ 分级色点，点击展开原始用量卡（未签到给领取按钮，走与 Plugins 页同一条 claim 路由，领完立刻重读把 Credits 推回余额）；面板顶部画当前模型的错峰窗口状态（折扣挂在模型上，必须 `projection.model` 匹配到名册里的 `id`/`name` 才画，匹配不上不声称打折）；5 分钟轮询、读失败保留上次数值不抛。归属由 `useProjection("modelSelection")` 物化，provider 非 `qoder-cn`/`qoder` 整颗胶囊不挂载（不跑 fetch）。样式走 inline style + 一条容器锚定规则，不注入整表样式以免覆盖宿主工具栏 |
| `src/client/token-history-chart.tsx` | 迷你柱状图 `TokenHistoryChart`：SVG 手绘 7 天 token 消耗趋势（柱高按占比、颜色按消耗量分三档），底部标注周总量与日均、趋势箭头（今天 vs 昨天）。无依赖，内联样式 |
| `src/client/index.ts` | 注册入口（`apply` / `inject` / `name`），含 `conversation.input.right` 座席注册（失败降级 `console.error`，不影响 host provider） |
| `src/client/react-shim.d.ts` | 最小 React 类型垫片（只管类型检查，不参与构建、不随包发布） |

## 构建产物

**源码全在 `src/`，`lib/` 是构建产物，但**受版本管理**（`docs/issues/19`：DSH 市场的
`github:` 源安装正是把这两个文件原样发给用户的，缺了它装出来的插件没有宿主入口，所以
`lib/` 必须入库，`.gitignore` 里不许再出现 `/lib/`）。改 `src/` 后跑 `npm run build` 并把
`lib/` 与源码**同一次提交**（CI 有新鲜度门禁：重建产物必须与提交里的一致）；发到 registry
的那一份仍由 `prepack` 现场构建。`npm run build` 从 `src/` 重建出两个文件：

| 产物 | 由谁构建 | 内容 |
| --- | --- | --- |
| `lib/index.js` | `tsdown -c tsdown.config.mjs`（`npm run build:host`） | 上面那张表里全部 `src/host/*.ts` 打成的**单个** ESM bundle——发布面就是 `package.json#main` 一个入口，peer 包一律外置 |
| `lib/client.js` | `node scripts/build-client.mjs`（`npm run build:client`） | 注入到宿主设置页的那张卡片，外面套着 `window.__ModuleLoader__.load(...)` 的加载器外壳 |

**这些源码不是原始手稿，是还原出来的**：2026-09 用 `docs/history/restore-client-src.mjs` 把当时的
产物按 `//#region` 标记机械切分而成，模块边界来自产物，`card.ts` 那一段在产物里没有标记、
是按引用关系推断的。还原后做过一次对拍——把卡片里每个纯函数用同一组输入各调一遍，新旧产物的
返回值与抛错逐条一致（方法记录在 `docs/issues/17-client-source-restore.md`；现在的探针清单与
调用数以 `npm run verify:bundle` 的输出为准，不再在文档里写死数字）。

产物是构建输出：**改源码重建，不要手改产物**。`test/client-bundle.test.js` 从产物里**提取并
执行**卡片的纯函数，所以产物一改那里的断言就得跟着看一眼。

`test/*.test.js` 直接 import `src/host/*.ts`（Node 原生剥类型），**不经过 `lib/`**——所以一套
测试跑的是源码，产物陈旧与否由 `npm run verify:host` 单独把关。

`probe/` 下是一次性只读探针，每个文件头写明 WHY 与 Run，不参与构建、也不被测试收集。
其中 `probe/host-compat.mjs` 回答的是「本机装的 DSH 是什么版本、本仓库的 peer 声明它还认不认」——
宿主把代码打在 `app.asar` 里，这件事从仓库内部看不出来。手法与三个会浪费时间的坑记在
[`docs/howto/host-version-probe.md`](../docs/howto/host-version-probe.md)。


## 持久化文件

插件自己只写这些文件，全部位于 DSH home（默认 `~/.dsh`）。桌面应用的登录文件始终只读打开，不在此列。

| 文件 | 作用 | 保留策略 |
|---|---|---|
| `.qoder-auth.<region>.json` | 插件设备登录换来的可刷新令牌 | 按 region 分文件；`0600` + 临时文件改名原子写；退出插件登录时删除 |
| `.qoder-exchange-throttle.<region>.json` | PAT 兑换的 429 等待窗口 | 只存未过期的 rate-limit 窗口；停泊状态与令牌不落盘 |
| `.qoder-catalog.<region>.json` | 模型目录缓存 | 原子写；空目录也是结果，会覆盖旧缓存并推进抓取时间 |
| `.qoder-request-count.<region>.<day>.json` | 今日经本客户端的请求数 | 按 region + 上海本地日分文件；零点翻页；只回收本插件命名且早于保留期的旧文件 |
| `.qoder-token-count.<region>.<day>.json` | 今日经本客户端的 token 消耗 | 与请求计数同源；保留 7 天；只回收本插件命名的旧文件 |

目录缓存的路径常量与命名约定在 `src/host/index.ts` 的 `qoderCatalogPath` 附近；请求/ token 计数器的落盘与 GC 分别在 `request-counter.ts` / `token-counter.ts`。
