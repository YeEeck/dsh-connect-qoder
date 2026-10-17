/** Simplified Chinese — usage panel copy. */
export const zhUsage = {
	"usage.title": "我的用量",
	// "刷新" alone was ambiguous next to the card's other refresh: this one
	// re-reads the quota, the other re-reads the model catalog.
	"usage.refresh": "刷新用量",
	"usage.loading": "正在读取用量…",
	"usage.empty": "当前账户暂无可展示的用量。",
	"usage.unavailable": "这个区域暂时读不到用量。",
	"usage.none": "这个版本暂时没有用量数据（未登录或尚未上线）。",
	// `{reason}` carries the host's own words, not a guess. The international
	// edition's campaigns endpoint is gated on the desktop app's machine
	// identity, so the check-in card is absent for THAT reason — not because
	// there is nothing to claim. Rendering nothing was indistinguishable from
	// "no round today", which is the silent-failure shape (red line 1).
	"usage.checkinUnavailable": "每日签到暂不可用：{reason}",
	"usage.error": "读取用量失败",
	"usage.planCredits": "套餐内 Credits",
	"usage.resourcePackage": "个人资源包",
	"usage.dedicatedPackage": "专属资源包",
	"usage.renewsOn": "将于 {date} 续订",
	"usage.expiresOn": "将于 {date} 结束",
	"usage.remaining": "剩余",
	"usage.used": "已使用",
	"usage.exceeded": "额度用完",
	"usage.promotion": "限时特惠",
	// Upstream can ship several campaigns at once. Each used to take a full
	// line — same badge, same weight, no way to tell which one is relevant —
	// until the promo block was taller than the quota it sits under. More than
	// one now collapses behind a count. The folded label keeps the offer
	// wording the per-line badge carried: folding the campaigns away must not
	// also drop the signal that there ARE offers on this account.
	"usage.promoCount": "限时特惠 · {count} 个活动",
	"usage.promoCollapse": "收起活动",
	// 促销行读失败时的可见降级：配额数字照旧显示，但「今天没有活动」与
	// 「活动没读出来」不再长得一样（红线 1）。{reason} 是宿主原话。
	"usage.promotionsUnavailable": "活动信息暂不可用：{reason}",
	"usage.viewDetails": "查看详情",
	"usage.credits": "Credits",
	// The daily check-in. Wording follows dsh-connect-workbuddy's own
	// check-in so two sibling cards read alike in the same list: a three-state
	// button plus a line telling you what today's round is worth. `checkinGain`
	// is the card's headline and reads the amount the HOST resolved from the
	// live campaign — a repeat claim grants nothing and must not be rendered as
	// though it did, which is why the granted/already notices stay separate.
	"usage.checkin": "每日签到",
	"usage.checkinGain": "+{amount} Credits",
	"usage.checkinClaim": "立即签到",
	"usage.checkinClaiming": "签到中…",
	"usage.checkinClaimed": "今日已签到",
	"usage.checkinGranted": "已领取 {amount} Credits",
	"usage.checkinAlready": "今天这份已经领过了",
	"usage.checkinError": "签到失败：{message}",
	// 对话框用量胶囊（composer-usage-pill.tsx）。胶囊正文只放 `Qoder CN · 1,034`，
	// 这些词都是展开面板里的：面板右上「余额」标签、读不到时的说明、以及今日签到行
	// 的两个状态。复用 `usage.planCredits` / `usage.dedicatedPackage` / `usage.remaining`
	// / `usage.used` / `usage.exceeded`，所以胶囊与 Plugins 页卡片说同一套词。
	"pill.details": "用量详情",
	"pill.balance": "余额",
	"pill.loading": "正在读取用量…",
	"pill.unavailable": "读不到用量",
	// 数字还在、读取已经断了：面板顶部一行小字，诚实标注这是旧数（红线 1 的
	// 「显式降级」——数值保留不等于宣称它仍是当刻事实）。
	"pill.stale": "数据可能已过期",
	"pill.checkinDone": "今日已签到",
	// 胶囊面板里的签到**动作**（不只是显示）：可领取时给一个真按钮，点了就走
	// 与 Plugins 页同一个 claim 路由。`busy` 是请求在途，`failed` 是宿主给的失败
	// 理由（红线 1：新失败路径必须给用户可见的错误，不许吞）。
	"pill.checkinNow": "签到领 {amount} Credits",
	"pill.checkinBusy": "签到中…",
	"pill.checkinFailed": "签到失败：{message}",
	// 错峰折扣（面板顶部的「当前模型」块）。折扣挂在模型上，所以块里先说当前是哪个
	// 模型，再说它的窗口状态；`offpeakIdle` 是「有窗口但不在窗口内」，不是假装在打折。
	"pill.modelLabel": "当前模型",
	"pill.offpeakActive": "错峰折扣生效 · 费率 {rate}",
	"pill.offpeakIdle": "错峰窗口 {window} · 未生效",
	"pill.offpeakRemaining": "剩余 {time}"
};
/** English — usage panel copy. */
export const enUsage = {
	"usage.title": "My usage",
	"usage.refresh": "Refresh usage",
	"usage.loading": "Reading usage…",
	"usage.empty": "This account has no usage to show right now.",
	"usage.unavailable": "Usage is unavailable for this region right now.",
	"usage.none": "No usage data for this edition (not signed in, or offline yet).",
	// See the zh note: the reason is the host's, and it is the whole message.
	"usage.checkinUnavailable": "Daily check-in unavailable: {reason}",
	"usage.error": "Could not read usage",
	"usage.planCredits": "Plan Credits",
	"usage.resourcePackage": "Personal resource package",
	"usage.dedicatedPackage": "Dedicated package",
	"usage.renewsOn": "Renews on {date}",
	"usage.expiresOn": "Ends on {date}",
	"usage.remaining": "remaining",
	"usage.used": "used",
	"usage.exceeded": "Quota exhausted",
	"usage.promotion": "Limited offer",
	"usage.promoCount": "Limited offer · {count} offers",
	"usage.promoCollapse": "Hide offers",
	// See the zh note: the reason is the host's, and it is the whole message.
	"usage.promotionsUnavailable": "Offers unavailable: {reason}",
	"usage.viewDetails": "View details",
	"usage.credits": "Credits",
	"usage.checkin": "Daily check-in",
	"usage.checkinGain": "+{amount} Credits",
	"usage.checkinClaim": "Check in",
	"usage.checkinClaiming": "Claiming…",
	"usage.checkinClaimed": "Checked in today",
	"usage.checkinGranted": "Claimed {amount} Credits",
	"usage.checkinAlready": "Already claimed today",
	"usage.checkinError": "Check-in failed: {message}",
	"pill.details": "Usage details",
	"pill.balance": "Balance",
	"pill.loading": "Reading usage…",
	"pill.unavailable": "No usage reading",
	"pill.stale": "Data may be stale",
	"pill.checkinDone": "Checked in today",
	"pill.checkinNow": "Check in · {amount} Credits",
	"pill.checkinBusy": "Checking in…",
	"pill.checkinFailed": "Check-in failed: {message}",
	"pill.modelLabel": "Current model",
	"pill.offpeakActive": "Off-peak active · rate {rate}",
	"pill.offpeakIdle": "Off-peak window {window} · inactive",
	"pill.offpeakRemaining": "{time} remaining"
};
