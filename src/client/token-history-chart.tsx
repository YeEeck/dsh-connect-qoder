/**
 * 迷你柱状图 — 7 天 token 消耗趋势。
 *
 * SVG 手绘（DSH 的 UI 组件库没有图表组件）。柱高按当天 token 数占 7 天最大值的比例，
 * 颜色按消耗量分三档：低（绿）、中（黄）、高（红）。底部标注周总量与日均。
 *
 * 数据源：`tokensHistory`（host 下发的过去 7 天每日记录，按 day 升序）。
 */
export interface TokenDayRecord {
  day: string
  total: number
  cached: number
}

export interface TokenHistoryChartProps {
  history: TokenDayRecord[]
  t: (key: string, vars?: Record<string, string | number>) => string
}

/** 柱子颜色阈值：按 7 天最大值的比例分三档。 */
function barColorForRatio(ratio: number): string {
  if (ratio >= 0.75) return 'var(--dsw-alias-state-warn-primary, #e8850c)'
  if (ratio >= 0.4) return 'var(--dsw-alias-state-info-primary, #3b82f6)'
  return 'var(--dsw-alias-state-success-primary, #22c55e)'
}

/** 周总量求和。 */
function weeklyTotal(history: TokenDayRecord[]): number {
  return history.reduce((sum, r) => sum + r.total, 0)
}

/** 日均（按有数据的天数）。 */
function dailyAverage(history: TokenDayRecord[]): number {
  if (history.length === 0) return 0
  return Math.round(weeklyTotal(history) / history.length)
}

/** 趋势箭头：今天 vs 昨天。 */
function trendArrow(history: TokenDayRecord[]): 'up' | 'down' | 'flat' | null {
  if (history.length < 2) return null
  const yesterday = history[history.length - 2]
  const today = history[history.length - 1]
  if (!yesterday || !today) return null
  if (today.total === 0 && yesterday.total === 0) return 'flat'
  const diff = today.total - yesterday.total
  if (diff === 0) return 'flat'
  return diff > 0 ? 'up' : 'down'
}

/** 趋势百分比。 */
function trendPercent(history: TokenDayRecord[]): number {
  if (history.length < 2) return 0
  const yesterday = history[history.length - 2]
  const today = history[history.length - 1]
  if (!yesterday || !today) return 0
  if (yesterday.total === 0) return 100
  const diff = today.total - yesterday.total
  return Math.round((diff / yesterday.total) * 100)
}

/** 格式化 token 数：小于 1 万用千分位，否则用 k/m。 */
function formatCount(n: number): string {
  if (n < 10000) return n.toLocaleString()
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1000000).toFixed(1)}m`
}

export function TokenHistoryChart({ history, t }: TokenHistoryChartProps) {
  if (history.length === 0) return null

  const max = Math.max(...history.map((r) => r.total), 1)
  const total = weeklyTotal(history)
  const avg = dailyAverage(history)
  const trend = trendArrow(history)
  const trendPct = trendPercent(history)

  const chartHeight = 24
  const barWidth = 14
  const barGap = 4
  const chartWidth = history.length * (barWidth + barGap) - barGap

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, opacity: 0.7 }}>{t('usage.tokensHistoryTitle')}</span>
        <span style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
          {trend === 'up' ? (
            <span style={{ color: 'var(--dsw-alias-state-warn-primary, #e8850c)' }}>
              {t('usage.tokensTrendUp', { pct: trendPct })}
            </span>
          ) : trend === 'down' ? (
            <span style={{ color: 'var(--dsw-alias-state-success-primary, #22c55e)' }}>
              {t('usage.tokensTrendDown', { pct: Math.abs(trendPct) })}
            </span>
          ) : trend === 'flat' ? (
            <span style={{ opacity: 0.5 }}>{t('usage.tokensTrendFlat')}</span>
          ) : null}
        </span>
      </div>
      <svg width={chartWidth} height={chartHeight} style={{ display: 'block' }}>
        {history.map((r, i) => {
          const ratio = r.total / max
          const barHeight = Math.max(2, ratio * chartHeight)
          const x = i * (barWidth + barGap)
          const y = chartHeight - barHeight
          return (
            <rect
              key={r.day}
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              rx={2}
              fill={barColorForRatio(ratio)}
            />
          )
        })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, opacity: 0.6 }}>
        <span>{t('usage.tokensWeeklyTotal', { total: formatCount(total) })}</span>
        <span>{t('usage.tokensDailyAvg', { avg: formatCount(avg) })}</span>
      </div>
    </div>
  )
}
