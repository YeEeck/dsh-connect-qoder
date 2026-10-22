# 凭据与平台边界

本文说明插件从哪里取得 Qoder 凭据、每一条来源在本机留下什么，以及各平台实际能走哪条路。README 只保留摘要；改动凭据/临时目录代码前先读 `issues/01`、`02`、`21`。

## 三种来源与优先级

插件有三个凭据来源，按优先级依次尝试（**桌面应用优先**）：

1. **Qoder 桌面应用自己的登录状态**（下面几段描述的解密过程）。只要它在**且没过期**，用的就是它：
   应用运行时自己保持登录新鲜，本机没有比它更新的凭据。
2. **插件自己的设备登录**。在浏览器里批准一个码，插件把换回来的可刷新令牌存进
   `$DSH_HOME/.qoder-auth.<region>.json`。这是没装桌面端（或不想装）的机器零配置登录的路径 ——
   详见 [写入与安全](#写入与安全) 与 `issues/21-device-login-credential-source.md`。
3. **环境变量 PAT**（`QODERCN_PAT` 等）。最后的兜底，需要用户自己到后台造一个长期令牌。

**桌面端那条过期了就不算数**：过期的 access token 什么都干不了——每个带它签名的
请求都会被拒，这个版本本身也不会被注册（`region-gate` 直接按"登录已过期"跳过发布）。所以它
不再压住后面两条：插件会继续往设备登录、再往 PAT 找一条**还能用**的凭据。只有三条都拿不出
东西时，那条过期的桌面端登录才作为"本机真实发生过的事"被报出去，而不是被一句含糊的"没登录"
盖过去。

无论走哪一条，**都不写入应用的文件**：桌面端的凭据文件始终以只读方式打开。

**卡片按"真正在服务这个版本的是谁"说话**：宿主把桌面端登录与插件自有登录**并列**
上报（两条凭据两种寿命，不合并），但账号卡要回答的其实只有一个问题——"这个版本登录了吗"。
所以当插件自有凭据在服务、而桌面端那条不在服务（过期、读不到、或只是环境变量 PAT 在服务）时，
这个版本读作**"已登录"**，并配一句"当前用的是插件自有登录（浏览器登录）——不需要桌面端
客户端"；此时那条"本地登录信息读不到"的红字不再出现——它描述的是桌面端，不是这个版本能不能用。
只签浏览器登录的用户也因此有「在线校验登录」按钮可点——按钮不再依赖账号行是否有 `source` 字段。

## 桌面端登录态

Qoder 把登录信息放在 Chromium OSCrypt 格式的凭据文件里（`v10` + nonce + 密文 + tag，AES-256-GCM）。
新版（0.3.x）的凭据直接保存在 `<userData>/auth.v1.dat`，旧版（0.2.x 及更早）则放在
VS Code 风格的 `state.vscdb` SQLite 数据库里。两种布局都支持，新版优先尝试。
密文用的密钥保存在应用的 `Local State` 中，由操作系统 keystore 包裹 —— Windows 上是当前用户
作用域的 DPAPI，因此同一用户下的进程都能解开它。
Node 没有内置 DPAPI 绑定，这一步交给 PowerShell，并通过临时文件交换结果（不使用管道），
这样在禁止管道 stdio 的沙箱里同样可用。

没有桌面应用登录时，可以用官方文档的 **PAT** 兜底：设置 `QODERCN_PAT`（国内版）或
`QODER_PAT`（国际版），插件会用它换取 job token。

## 平台边界

**读桌面端登录态那条路径只在 Windows 成立。** 解密链路是 PowerShell + DPAPI
（`Crypt32.dll`），`src/host/` 里没有任何 macOS / Linux 解包分支——在其它平台上应用目录
**找得到**（应用数据根目录已按平台解析，见下），但凭据读不出来（`loadCredential` 返回
`undefined`）。非 Windows 上的失败**说的是真话**：`runUnwrap` 在 spawn 之前就判平台，
记下的是"这个版本只在 Windows 上读得到登录"，而不是一条在 Mac 上显示的 Windows 路径；
账号面板的提示也随之改为指向**在哪个平台都成立**的路子（先「浏览器登录」，再 PAT），
而不是让一个已经装了客户端的用户去确认"客户端在不在"。

**但那些平台已经不再只有 PAT 一条路**：插件自己的**设备登录**（上面「三种来源与优先级」的第 2 条）
不读桌面端任何东西——在浏览器里批准一次，凭据就落在本机，平台无关。所以第 1 项 keystore
从"必须补"变成"可选"。**诚实的限定**：设备登录这条路径**只在 Windows 上真机跑过**（两区各
一次授权闭环，见 [`probe/qoder-device-login.mjs`](../probe/qoder-device-login.mjs)），它用到的
都是跨平台 API，但"在 macOS / Linux 上也确实能用"仍属下面第 2 项那类实机验证。

**这不是"没有跨平台客户端"，而是客户端已跨平台、插件尚未跟上**：Qoder 桌面版在
macOS 12+ / Linux (.deb/.rpm) / HarmonyOS 上都有下载（[qoder.com.cn/download](https://qoder.com.cn/download)），
但 `src/host/` 只实现了 Windows 这一条解密链。缺口在两处，全部登记在
[KNOWN_GAPS.md 第 6 条（跨平台凭据链未实现）](KNOWN_GAPS.md)：

1. **OS keystore 封装（含 key 派生）**：Windows 走 DPAPI；macOS 需 Keychain（`security`），
   且 Chromium 在 macOS 上对 `encrypted_key` 还要做 PBKDF2-HMAC-SHA1 派生（"peanuts" 常量 +
   1003 次迭代）——与 DPAPI 直解是两种算法，不是换个命令；Linux 需 libsecret（`secret-tool`）
   或 Chromium 在 Linux 上的 `peanuts` 硬编码 key 兜底。
2. **跨平台 CI 与实机验证**：GitHub Actions 的 macos / ubuntu runner 可以编译并跑单测，但
   Keychain 弹窗、签名打包、`secret-tool` 的 D-Bus session 都得在实机或 runner 上验。

**已按平台解析的两项**：应用数据根目录现在按平台解析（Windows `%APPDATA`、
macOS `~/Library/Application Support`、Linux `$XDG_CONFIG_HOME`/`~/.config`）——此前直接读
`process.env.APPDATA`，而该变量在 macOS 上不存在，于是探测得到空串、把"应用装着但读不出密钥"
谎报成"您没登录"；`MACHINE_OS` 也补上了 darwin 档（本机实测过网关对
`x86_64_darwin` / `aarch64_darwin` 一律正常应答）。

剩下的是**实机工作**：service 名、PBKDF2 参数、Linux 的变体都必须实测确认，写出来就是盲代码。
macOS / Linux 用户现在可以走设备登录（零配置），或 PAT 兜底，或自行从本仓库移植解密链。

CI 的 Ubuntu 绿灯说明**测试**在那边能跑，不等于零配置在 Linux 上存在。

## 写入与安全

来源不同，插件是否在本机留下东西也不同：

- **桌面应用的凭据**：只读打开（新版 `auth.v1.dat` / 旧版 `state.vscdb`，不做任何写入），
  不存储、不复制。解密主密钥会在 `%TEMP%` 短暂明文落盘，回收窗口见
  `issues/02`。
- **设备登录换来的令牌**：这是插件**自己持有**的唯一凭据，因此也是唯一会被写下来的 ——
  存在 `$DSH_HOME/.qoder-auth.<region>.json`，`0600` + 临时文件改名写入（不会留下半写文件），
  按 region 分文件（两个版本互不影响）。面板上的「退出插件登录」删的就是这个文件；它不影响
  桌面端的登录，也不影响环境变量里的 PAT。令牌过期时插件用同一次的刷新令牌换新，换新失败
  会在面板上说明原因，而不是装作还登录着。
- **环境变量 PAT**：只读，插件不写入任何地方。
- 进程内随机 bearer token 绑定 loopback 端口；Qoder 真实的 RSA 包装 key 与 session key
  不会离开本插件的沙箱。
