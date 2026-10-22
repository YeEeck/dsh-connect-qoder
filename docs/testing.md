# 测试与验证

本文是验证链与测试结构的参考。用户安装与使用见根目录 [README](../README.md)，模块结构见 [architecture.md](architecture.md)。

## 运行测试

```sh
npm run verify          # typecheck + 两道 any 审计 + 测试树两道类型门禁 + build + test + 市场条目 + 产物核验，全过才算过
npm run typecheck       # tsc -p tsconfig.json，源码全量类型检查（0 error）
npm run audit:test-types # 测试树自己的类型程序：tsc -p tsconfig.test.json（已 opt-in 的文件数见输出）
npm test                # node --test "test/*.test.js"
npm run test:coverage   # 同上 + 覆盖率门槛（行 68 / 分支 82 / 函数 66，跌破即失败）
npm run build           # 从 src/ 重建 lib/（宿主 bundle + 卡片产物）
```

`npm run verify` 是一条链，每一步回答一个不同的问题。下表与 `package.json` 的 `verify` 脚本
一一对应——`test/docs-facts.test.js` 会核对这张表和那条链是不是同一份，改了一个忘了另一个，
当场就红：

<!-- verify-steps -->
| 步骤 | 回答什么 | 全过时的输出 |
|---|---|---|
| `typecheck` | `src/**` 的每个 `.ts` 都过类型检查 | `tsc` 退出 0、无输出 |
| `audit:any` | 源码里没有隐式 any | `implicit-any sites: <数量> (budget <上限>)` |
| `audit:explicit:any` | 源码里没有显式 any | `explicit-any sites: <数量> (budget <上限>)` |
| `audit:test-types` | 测试文件自己也过类型检查（坏 import、改了名的导出、变了形的参数） | `opted in to type checking: <数量> (floor <下限>)` |
| `audit:test-type-errors` | 测试树的类型债不许涨：新债进不来，旧债只许降 | `test type errors: <实测> (budget <上限>)` |
| `build`（宿主 + 卡片） | `lib/index.js` 与 `lib/client.js` 确实由 `src/` 生成 | `MATCH: … byte-for-byte identical` |
| `test` | 卡片逻辑与宿主半边没被改坏；发布门禁仍能被打破 | 最后一行 `# fail 0` |
| `test:market-entry` | 市场条目还合规则吗（对着上游那份条目规则核一遍） | `market-entry.test.mjs: all checks passed` |
| `verify:host` | 宿主 bundle 不陈旧、公开面与 peer 外置都还在 | `all 11 checks passed`（装了 `tsdown` 时 11 条；没装时 9 条，见下） |
| `verify:bundle` | 重建产物与上一份已发布产物的行为一致 | `behaviour: IDENTICAL` + `OK: …` |

四道类型/any 门禁的阈值都住在 `scripts/ratchet-ledger.json` 这本账里（谁、什么时候、为什么），
不在脚本里——脚本里改阈值这件事本身会当场被账本对不上而红。

中间那条是最要紧的：宿主与卡片两步都**只比较、不认账**。它过了，就说明产物不是手抄进来的
副本——改 `src/` 而产物不变的情况会在这里红。`verify:host` 补的是迁移带来的新缺口：源码
在 `src/host/`、产物在 `lib/` 之后，「改了源码忘了重建」第一次成为可能的错误；`lib/` 如今
受版本管理（`docs/issues/19`），这道本地对拍之外，CI 的 `git diff --exit-code -- lib` 门禁
也会在推上去时看见它。

## 覆盖率、类型门禁与变异测试

**测试树自己也有类型门禁。** 主 `tsconfig.json` 只管 `src/`（它的 `exclude` 里写着 `test`），
所以测试文件过去完全不在任何编译器程序里：套件经 Node 的剥类型加载器 import `src/**/*.ts`，
注解被抹掉，一个都没查；测试自身的 `.js` 更连解析都没发生过。`tsconfig.test.json` 是另一半——
它把测试树放进一个程序，opt-in 的测试文件用 `// @ts-check` 逐个打开，`npm run audit:test-types`
盯着这个程序。**两个程序是分开的**：`npm run typecheck` 仍然只意味着「每个 `src/**/*.ts` 是
干净的」，测试程序有自己的门禁与自己的范围。

`allowJs: true` 是让 `.js` 测试文件进程序的那一步，`checkJs: false` 是让没 opt-in 的文件
只被解析、不被检查。**别把 `checkJs` 打开在 `tsconfig.test.json` 里**：整棵树是数千条错误的
量级（今天的实测数见 `npm run audit:test-type-errors` 的输出），那需要一次有预算的迁移，不是一次
翻开关。整棵树打开的那份程序是
`tsconfig.test.budget.json`（同源、`checkJs: true`），它只用来**数债**：`npm run
audit:test-type-errors` 把整棵树的错误总数与预算比，只许降不许涨。棘轮轴从「文件数」换成
「错误数」是有理由的：给一个干净文件加 pragma，文件数 +1（有本事不要钱）；而给一个带着 60 条
错的文件 opt-in，它当场就变红（最该被看的文件进不来）；新写的测试文件带 20 条错进来，文件数
一动不动。错误预算反过来：新债一进来就被数进去。
`tsconfig.test.json` 里的 `exclude` 必须重新声明：
`extends` 会继承父配置的 `exclude`（`["node_modules","lib","test"]`），继承了之后 `include`
里的 `test` 根本不进程序，门禁会报「0 error、0 个被检查的文件」，然后一脸无辜地绿着。
pragma 的规则是实测出来的、不是猜的：只有 `//` 行注释算数（块注释里的 `@ts-check` 编译器
根本不看），token 必须在注释开头，且最后一个 pragma 赢。没 opt-in 的测试文件还剩一大半
（总数见 `npm run audit:test-types` 的输出），缺口与代价记在
`docs/KNOWN_GAPS.md` 第 10 条（测试树的类型债被记成预算）。

**绿灯不等于门禁有效。** 这几道门禁每条都用故意的破坏验过：`build` 缺关键串时会拒绝写入
（第一次构建摇掉全部模块、只剩 84 行，bundler 仍然退出 0）；`verify:host` 往 `lib/index.js`
尾上追加一行就让 `fresh` 那条红（`the artifact is stale`）并以非 0 退出；`verify:bundle` 把
探针下界从 `Math.max(0, …)` 改成 `1`，就会在 `formatCountdown|undefined|0` 上报出
`00:00:00` → `00:00:01` 并以非 0 退出；`audit:test-types` 有四种破法——摘掉某个文件的
`// @ts-check`（棘轮立刻点名「opt-in 的文件数低于下限」）、给已 opt-in 的文件塞一个类型
错误（tsc 点名到行）、把 `tsconfig.test.json` 的 `exclude` 加回 `test`（逐个点名「这个文件
opt-in 了却不在程序里」）、在前导区补一行 `// @ts-nocheck`（点名「这个文件的检查被静默关掉
了」）；`audit:test-type-errors` 有三种破法——把 `tsconfig.test.budget.json` 的 `checkJs` 翻成
`false`（债数塌成 0、门禁从此永远绿）、把 `tsconfig.test.json` 的 `include` 里的 `test` 删掉
（测试树整个离开程序、债数同样塌成 0），或者把上限本身悄悄抬高（账本对不上，门禁当场点名
「这个阈值没有记录」）——三种都会被当场点名。四道门禁的阈值都住在
`scripts/ratchet-ledger.json` 里，所以「抬阈值」永远是一笔带理由的记账，而不是改一行常量：
单独改账本里的 `value`、不补一条 `changes`，门禁立刻红（`the ratchet ledger is not
consistent`）。怀疑门禁时照这个法子再破一次，比看它绿不绿有用。

**上面那几条破法现在自己会跑。** `test/gate-mutations.test.js` 把门禁要读的那些文件复制到
`.verify-tmp/` 下的临时目录（**检出本身一个字节都不动**，所以它可以和别的套件并行跑），在副本
上破一道门禁，要求那道门禁**自己**变红、并且用它自己的话作证（`the build is incomplete` /
`the artifact is stale` / `does not behave like its baseline` / `the debt is above the ceiling` /
`the ratchet ledger is not consistent`），再跑一遍没破的副本当对照，
证明红是这次破坏造成的、不是本来就在红。债那条的破法是往副本里塞一个带类型错误的测试文件
（债真的涨了），账本那条是把账本里的上限改大却不记账（门槛被人悄悄抬了）。副本留在仓内是有原因的：`verify:host` 与
`verify:bundle` 从 git 和 `node_modules` 读基准，放在系统临时目录里两道门禁都会因为
「找不到基准」而直接放行——那正是这道测试要抓的空转绿。怀疑门禁时照上面的法子再破一次仍然
有用；只是想确认门禁还活着，让这道测试跑一遍就行。

`npm run build` 需要构建器（`tsdown`），它是 devDependency，跑之前先 `npm install`。
**测试与 `typecheck` 都不需要 `lib/`**：测试直接 import `src/**` 的源码（Node 原生剥类型），
`verify:host` 在没有 `tsdown` 时打印一声响亮的 SKIP 并以 0 退出。

两条关于这道 SKIP 的实话，免得它被当成 CI 的实际路径：

- **CI 永远走不到 SKIP**：两个 job 都是先 `npm install` 再 `npm run build`，`tsdown` 一定在。
  那是给裸检出直接 `node scripts/verify-host-bundle.mjs` 的人准备的。
- **`npm run verify` 也走不到**：它自己的 `build` 那步就需要 `tsdown`，会先在 `build` 失败。
  换句话说，这一条**不可能**靠跳过而"绿着通过"。

`verify:bundle` 另有一条容易误读的性质，2026-10 起它的行为是：baseline **不再默认取 `HEAD`**
（CI 的 `build` job 先跑 `npm run build`，那时 `HEAD:lib/client.js` 就是工作树产物本身，跟自己比
必然 IDENTICAL，什么也没证明），而是**自动回溯历史（上限 80 条），选最新一条 `lib/client.js`
与工作树不同的提交**作为 baseline——「最新的、其产物与我不一样的那个 ref」才是这个问题该有的
问法。固定的 ref（比如 `HEAD^`）是错答案：`lib/client.js` 大多数提交根本没碰（本分支上曾连续
24 条提交都相同），任何固定 ref 都可能恰好逐字节相同。回溯无果（80 条内全相同，或浅克隆没有
历史可走）时退回 `HEAD`，而那是一次**失败而非放行**：`FAIL (vacuous)` 并 exit 1，浅克隆分支
还单独报出（修法是给 checkout 加 `fetch-depth: 0`，CI 的 `build` job 正是为此设置的；修法恰好
相反——走完全相同是传一个显式 ref，浅克隆是改 checkout，所以分开报）。确需跨大距离对照某份
已发布产物时仍传 `--baseline <ref>`。

对拍覆盖不到渲染：JSX 被 stub 成 `null`，所以**改了 UI 仍然要在浏览器里看一眼**（展开卡片 →
切区域 → 改图像档位 → 保存 → 看错峰倒计时）。

## 测试分层：卡片侧测三层，别互相替代

卡片的可编辑逻辑（`dirty` / `save` / `discard`、staged 与 saved、per-region 允许清单、名称
过滤）住在 `src/client/controller.ts` 的 `QoderCardController` 里，是个**纯类**——不 import
React、不碰 DOM、不发 `fetch`。这不是顺手为之，是为了让测它不需要浏览器：

| 层 | 测什么 | 跑在哪里 |
|---|---|---|
| `test/controller.test.js`（16 条） | 状态机的**规则**：什么时候算 dirty、拒绝写入怎么呈现、discard 回滚到哪、auto 怎么写最小、过滤为什么只窄化视图 | 裸 `node:test`，无 jsdom、无 React |
| `test/card-dom.test.js`（9 条） | **产物级**渲染接线：`QoderPluginCard` 真的把快照渲染成了用户看见的 DOM、按钮 disabled 条件对不对 | jsdom，驱动 `lib/client.js`（出货包） |
| 浏览器手动 | 视觉与交互手感（样式、错峰倒计时动效） | 人类 |

规则在 controller、接线在 card-dom，**两者都在 CI 里**，谁都不能替谁：只测 controller 会漏掉
「快照没接到 JSX」这种接线错误，只测 card-dom 会把状态机的每条规则塞进 jsdom、慢且脆。改
规则去 `test/controller.test.js`，改渲染去 `test/card-dom.test.js`——一条规则同时出现在两个
文件里，通常是抽得不够干净，而不是「保险起见各写一遍」。

`useSyncExternalStore` 的签名（含「为什么 `subscribe` / `getSnapshot` 必须做箭头属性、
`getSnapshot` 为什么必须引用稳定」）写在 `src/client/react-shim.d.ts` 里，改 store 接口先看
那段注释。

## 依赖与安装形态

`.npmrc` 里的 `legacy-peer-deps=true` 是必需的、不是随手加的：本包的 peer 依赖是
`@deepseek-ai/*`，由宿主在运行时提供，不在公共 registry 上，npm 自动安装 peer 会在装到
devDependencies 之前就失败。

**本机两份安装形态不同、这是有意的**：`web` profile 是指向本仓库的符号链接（开发态，改完刷新
即生效）；`desktop` profile 走 **npm 官方安装**，与真实用户同形态，跑的是已发布版。桌面端要试本地
代码：`dsh plugin add <本仓库路径> --profile desktop`。
（形态定义与"版本号相同 ≠ 内容相同"这条坑见 [AGENTS.md](../AGENTS.md)「工作目录与装载方式」。）

## CI

CI 在 Node 22.19 / 24 × Ubuntu / Windows 上跑（`.github/workflows/test.yml`）——
Windows 不是冗余：shim 绑定回环监听、目录缓存依赖 rename 覆盖、凭据读取要调
PowerShell，这些在别的平台上行为不同。

测试只用 Node 内置的 `node:test`，不需要安装任何依赖——**也不需要安装 peer 依赖**，
这是刻意的：`src/host/` 中凡是纯逻辑的部分都放在无 peer 依赖的模块里（见上表），
这样它们才能被直接 import 并断言真实的实现，而不是在测试里手抄一份。

几个文件存在的理由，都是因为曾经出过问题：

- `test/catalog-fields.test.js` 与 `test/model-row.test.js` —— 错峰机制曾因
  `promotion.active` / `promotion.timezone` 在 Host 投影时被丢掉而全程哑火，
  而当时的测试是绿的，因为它测的是自己手抄的副本。同一个毛病在客户端又犯过一次：
  卡片自己算窗口时漏看 `promotion.active`，把**拿不到**的折扣价显示给用户，
  而模型选择器按 `before` 价计费，两个界面自相矛盾。
  `model-row.test.js` 现在逐状态对拍两个门控；`client-bundle.test.js` 更进一步，
  直接从产物里提取卡片的 `offPeakState` 并执行——删掉那行门控会让它变红，
  而只会让 `model-row.test.js` 保持绿色。**副本不是防线。**
- `test/credential-cache.test.js` —— 「重新登录无需重启」这条卖点的完整链路：
  网关拒绝 → 谓词判定 → 置失效标志 → 下次请求重读。此前只有两端被测。也覆盖
  env-PAT 兑换的 429 节流闸门：平台自述窗口被 honour、窗口内的 poll 不重探
  （兑换计数是证据）、二次拒绝指数翻倍、401/403 停泊仅「重读登录」释放、5xx 不闸门。
- `test/exchange-throttle-e2e.test.js` —— 上面那条闸门的端到端版：真实的
  `exchangePat` 走 `fetch` 打到真实 fake platform，「poll 有没有重探」的答案是
  fake 自己的请求计数器，而不是插件自述。与姊妹插件的 429 e2e 同一标准。
- `test/throttle-store.test.js` —— 节流闸门的磁盘持久化，用真实临时目录跑：
  未过期的 rate-limit 窗口跨重启读回、parked 与令牌一律不落盘、过期窗口在读取时
  丢弃、原子写不留半截文件。
- `test/credential-invalidation.test.js` —— 上面那条链路上的两个纯谓词。
- `test/account-state.test.js` —— 账号状态四档判定（`src/host/account-state.ts`）：
  全注入的存储读器 + 真实临时目录跑目录存在性检查，钉住「判定只信本地证据」
  与「状态记录不含任何凭据材料」两条不变量。
- `test/credential-kind.test.js` —— 「这个版本现在是谁在服务」这句话曾经**只有卡片能猜**：
  宿主把桌面端与插件自有两条凭据并列上报，卡片靠 `source` 字段反推，而 `source` 只在
  「桌面端 → PAT」的读取链里产生，插件自有登录那条永远不出现——桌面端登录一过期，
  卡片就显示成"没登录"。现在宿主是唯一知道实际解出哪条凭据的一方，它把答案写成
  `credentialKind`（`desktop` / `device` / `env`）随账号面板与 status 路由上报，
  卡片不再猜。这个文件钉住三档命名、缓存解析前后的取值，以及「宿主还没解析出凭据时
  那个键不出现」（出现了就成了另一种撒谎）。
- `test/oscrypt-unwrap.test.js` —— OSCrypt 链（`src/host/oscrypt-unwrap.ts`）曾经
  **只有一台装了 Qoder 的 Windows 机器能测**：解包要真 PowerShell、真 DPAPI、真登录态，
  于是「临时目录建好 → 标记写好 → 交接文件读回 → 失败路径」这一段在覆盖率报告里长期
  是空的。两个解包入口现在都接受注入的 spawner，测试用假 spawner 写出与真解释器同形的
  交接文件，于是这些环节在任何机器上都能跑。这个文件钉住：子进程拿到的 key 就是调用方
  拿到的 key、成功与**每一条失败路径**都不留临时目录（明文主密钥不能活过这一次调用）、
  子进程永远看不到用户的 PAT、解释器是绝对路径的系统 PowerShell、非 Windows 主机
  拿到的是「为什么读不了」而不是一句「没登录」，以及清零会覆盖字节、且拒绝清零不是
  普通文件的目标（越界那条红线）。
- `test/mutation-gates.test.js` —— 「这些闸门到底有没有被测住」以前只能靠人读代码：
  断言走通路径的测试，删掉闸门照样全绿。这个文件把「改坏 → 看是否变红」变成门禁：
  它把 `src/host/oscrypt-unwrap.ts` 的**副本**里的一道闸删掉（不碰检出本身），再跑
  真正守着它的那套测试，要求变红，**且红在守这道闸的那条断言上**。当前钉住 sweep 的
  五道闸（不跟随联接、联接碰撞必须上报、身份标记、目录恰好两件、32 字节主密钥）、
  年龄闸，以及 `zeroOutFile` 的「必须是普通文件」与「必须真的写零」；每次先跑一遍
  不删闸的对照，副本必须全绿，否则这套结论就是空的。
- `test/errors-classify.test.js` —— 105 与 10605 的优先级决定了「提示用户重新登录」
  还是「排队等待」，两者弄反的代价完全不同。
- `test/settings-save.test.js` —— DSH 0.2 代上 `set()` 会静默成功而不落盘；
  这段代码用「写入→读回→深比较」把假成功变成显式失败，测试里直接模拟
  「`mutate` 成功但文档没变」的那个场景。也钉住了两件靠肉眼会漏的事：
  命名空间只做全等匹配（`llm-qoder-extra` 不算我们的），字段白名单用
  `Object.hasOwn`（`constructor` 不是一个字段）。
- `test/pi-model.test.js` —— `toPiModel` 抽离成纯函数后的直接覆盖：
  `compat.supportsDeveloperRole: false` 与「不声明 `maxTokens`」这两处，
  失效时每个请求都会 403，或长回复被截成 `finish: max-tokens`。
- `test/catalog-store.test.js` —— 目录缓存的原子落盘，用真实临时目录跑，
  在 CI 所在的平台上实测 `rename` 覆盖行为，而不是在注释里假设。
- `test/shim.test.js` —— 回环端点的鉴权与 `/v1/models` 过滤；对着真实
  HTTP 服务器说话，Host 头用裸 socket 发送（`fetch` 禁止设置该头）。
- `test/oscrypt.test.js` —— 凭据解密往返；夹具用真实 AES-256-GCM 构造，
  key 是固定哈希，失败可复现。
- `test/upstream-protocol.test.js` —— 编码与签名。两个盲区是**原理上不可测**的，
  已在文件头写明。
- `test/upstream-messages.test.js` —— 消息与工具调用翻译，注释里自称
  「最重要的一件事」，此前零覆盖。
- `test/docs-markdown.test.js` —— `docs/docs-qoder-cn/*.md` 是**一次性转换的产物**：
  `convert-qoder-docs.ps1` 把抓回的原始资料洗成纯 Markdown，随后**原始 `.txt` 被删除**，
  于是「转换是否忠实」在事后无法从内容本身判断，而 `docs-facts.test.js` 只管散文断言、
  不读这个目录。2026-10 因此放过去两类静默污染：转义顺序写反（先 `<` 后 `&`，把刚生成的
  `&lt;` 二次转成 `&amp;lt;`）让两段「Temporarily hidden … Keep for restoration」的隐藏
  注释渲染成可见文本，同一 bug 又把链接里的 `\&` 转成 `\&amp;`、弄坏三个订阅链接。
  门禁只查转换器真能损坏的形状（双重转义、注释开合、围栏配对、MDX 残留），并带**存活守卫**
  （文件数与最小长度）——否则目录被改名或清空时，循环跑零次、门禁照样全绿。

尚未覆盖的部分集中登记在 `docs/KNOWN_GAPS.md`，不在各文件里重复叙述——
重复三处正是「手抄副本」那类问题的文档版。
