/** Simplified Chinese — account panel copy. */
export const zhAccount = {
	"account.reload": "重新读取登录状态",
	"account.confirm": "在线校验登录",
	"account.confirming": "校验中…",
	"account.confirmed": "在线校验通过：登录有效",
	"account.confirmExpired": "在线校验发现登录已过期——在 Qoder 客户端里重新登录后点「重新读取登录状态」",
	"account.confirmFailed": "在线校验失败：{detail}",
	"account.state.ok": "正常",
	"account.state.expired": "已过期",
	"account.state.needs-app": "读不到",
	"account.state.signed-out": "未登录",
	"account.envPat": "来自环境变量 PAT",
	"account.appFrom": "来自 {app}",
	"account.expiresAt": "有效期至 {date}",
	"account.unsigned": "本机没装这个版本的 Qoder 客户端",
	"account.expiredHint": "登录已失效——请打开 Qoder 客户端（{app}）重新登录，然后点「重新读取登录状态」",
	// The advice has to be true on every platform the plugin can run on. The
	// previous wording ("make sure a signed-in Qoder client is on this machine")
	// is exactly wrong for a macOS or Linux user: they HAVE one, the plugin just
	// cannot read that platform's keychain yet, and the host now says so in
	// `detail`. A PAT is the one fallback that works everywhere, so it is what
	// this points at; "re-read" only helps if the cause really was a stale read.
	"account.readFail": "本地登录信息读不到：{detail}。可改用环境变量 PAT（QODERCN_PAT / QODER_PAT），或点「重新读取登录状态」",
	"account.download": "没装 Qoder 客户端？到「下载」区安装 {edition}，装好后登录",
	"account.downloadLink": "下载 {edition}",
	"account.error": "读取账号状态失败",
	// Now a VISIBLE label on the switch, not a tooltip. It used to be "模型"
	// with the whole explanation living in a 57-character `title` that a touch
	// user or a keyboard focus never saw — and the switch sat inside the region
	// pill, eight pixels from a tab button that did something else entirely.
	"account.offer": "启用此版本",
	"account.offerTitle": "关闭后这个版本的模型不会出现在 DSH 的模型下拉框里；登录、用量与模型设置都会保留，重新开启即恢复。",
	"account.offerOff": "已关闭：该版本的模型不会出现在 DSH 的模型下拉框里",
	"account.offerError": "保存「启用此版本」开关失败：{detail}",
	"account.regionTabs": "版本：点哪个就看哪个版本的账号、用量与模型",
	// The plugin's OWN credential, reported BESIDE the application's sign-in and
	// never merged into it: two credentials, two lifetimes. `device.*` keys live
	// here because this is the account surface, the same way `pill.*` keys live
	// in `copy-usage.ts`.
	//
	// Every key below that carries a `{reason}`/`{detail}` exists so a failure
	// says WHICH failure. The alternative — one "something went wrong" — is the
	// silent-failure class this repo's first red line names, and a sign-in button
	// that quietly does nothing is the worst place to have one.
	"device.title": "插件自有登录",
	"device.available": "不装桌面端也能用：在浏览器里批准一个码，插件把换来的可刷新令牌存在本机，只放在这个版本自己的文件里。",
	"device.signIn": "浏览器登录",
	"device.starting": "正在获取授权链接…",
	"device.waiting": "已打开授权页，等待批准（最多 5 分钟）",
	"device.reopen": "重新打开授权页",
	"device.signOut": "退出插件登录",
	"device.signingOut": "正在退出…",
	"device.state.ok": "插件已登录",
	"device.state.none": "本机没有插件自己的登录",
	"device.state.expired": "插件登录已过期——点「浏览器登录」重新授权",
	"device.state.unknown": "插件登录状态未知（宿主比本卡片新）",
	"device.renewFailed": "插件登录续期被拒：{reason}——点「浏览器登录」重新授权",
	"device.saveFailed": "插件登录续期成功，但没能写入本机文件：{reason}。当前会话照常用，重启后会失效——请检查磁盘与插件目录的写入权限",
	"device.unreadable": "插件保存的登录文件读不出来：{reason}",
	"device.startFailed": "打开授权页失败：{detail}",
	"device.loginFailed": "登录失败：{reason}",
	"device.loginExpired": "授权超时了，请重新点「浏览器登录」",
	"device.loginLost": "这次登录已经不在等待中了，请重新发起",
	"device.signOutFailed": "退出插件登录失败：{detail}",
	"device.signOutNote": "只删除插件自己的令牌；桌面端的登录、环境变量 PAT、另一个版本的文件都不受影响。"
};
/** English — account panel copy. */
export const enAccount = {
	"account.reload": "Re-read sign-in",
	"account.confirm": "Confirm online",
	"account.confirming": "Confirming…",
	"account.confirmed": "Confirmed: sign-in is valid",
	"account.confirmFailed": "Could not confirm: {detail}",
	"account.state.ok": "OK",
	"account.state.expired": "Expired",
	"account.state.needs-app": "Unreadable",
	"account.state.signed-out": "Not signed in",
	"account.envPat": "from an environment PAT",
	"account.appFrom": "from {app}",
	"account.expiresAt": "Valid until {date}",
	"account.unsigned": "No Qoder client for this edition is installed on this machine",
	"account.expiredHint": "Sign-in has lapsed — sign in again in the Qoder client ({app}), then click Re-read sign-in",
	// See the zh note above: the remedy has to be valid everywhere, and a PAT is.
	"account.readFail": "Could not read the local credential: {detail}. Either set an environment PAT (QODERCN_PAT / QODER_PAT), or press Re-read sign-in",
	"account.download": "The Qoder client is missing — install {edition} from the Download section, then sign in",
	"account.downloadLink": "Download {edition}",
	"account.confirmExpired": "Confirmed: sign-in expired — sign in again in the Qoder client, then re-read",
	"account.error": "Could not read the account states",
	"account.offer": "Offer this edition",
	"account.offerTitle": "Turning this off hides the edition's models from DSH's model picker; the sign-in, usage and model settings are kept, and turning it back on restores them.",
	"account.offerOff": "Disabled: this edition's models are not offered to the model picker",
	"account.offerError": "Could not save the edition switch: {detail}",
	"account.regionTabs": "Editions: pick which one's account, usage and models to view",
	// See the zh note above; these mirror those keys exactly.
	"device.title": "Plugin sign-in",
	"device.available": "Works without the desktop client: approve a code in your browser and the plugin stores the refreshable token it gets back, in this edition's own file only.",
	"device.signIn": "Sign in with a browser",
	"device.starting": "Getting the sign-in URL…",
	"device.waiting": "Authorization page opened — waiting for approval (up to 5 minutes)",
	"device.reopen": "Open the authorization page again",
	"device.signOut": "Sign out of the plugin",
	"device.signingOut": "Signing out…",
	"device.state.ok": "Signed in to the plugin",
	"device.state.none": "This machine has no plugin sign-in",
	"device.state.expired": "The plugin sign-in has expired — press Sign in with a browser to authorize again",
	"device.state.unknown": "The plugin sign-in is in a state this card does not know (the host is newer)",
	"device.renewFailed": "The plugin sign-in could not be renewed: {reason} — press Sign in with a browser to authorize again",
	"device.saveFailed": "The plugin sign-in renewed successfully but could not be written to disk: {reason} — this session keeps working, a restart will not; check that the plugin directory is writable",
	"device.unreadable": "The plugin's saved sign-in file cannot be read: {reason}",
	"device.startFailed": "Could not open the authorization page: {detail}",
	"device.loginFailed": "Sign-in failed: {reason}",
	"device.loginExpired": "The authorization timed out — press Sign in with a browser to start again",
	"device.loginLost": "That sign-in attempt is no longer pending — start it again",
	"device.signOutFailed": "Could not sign out of the plugin: {detail}",
	"device.signOutNote": "Only the plugin's own token is deleted; the desktop client's sign-in, an environment PAT, and the other edition's file are all untouched."
};
