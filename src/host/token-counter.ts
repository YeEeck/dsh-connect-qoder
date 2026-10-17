/**
 * 本地 token 消耗累加器 — 本客户端经本插件发往上游、每轮对话上游明确下发的
 * token 数（prompt / completion / total / 缓存命中），按 region + 上海本地日
 * 在本地累加落盘。
 *
 * 与「本地请求计数器」（`request-counter.ts`）的区别与边界：
 *
 * - 请求计数上游**根本不给**每日上限，只能本地自计「发了几发」——那一条是纯粹的
 *   本地口径，不画比例条（画 N/上限 等于发明上游没公布的口径）。
 * - token 数则是**上游每轮对话都明确下发**的（见 `shim.ts` 抓 `chunk.usage`
 *   的 `total_tokens` / `prompt_tokens_details.cached_tokens` 并转发给 DSH）。
 *   所以这里做的是「本地聚合一份已经公开的数据」，不是编造——可以做、也
 *   **应该**画出来，否则用户在插件卡里看不到自己消耗了多少 token。
 * - 桌面端与 Web 端各记各的（同 request-counter 的「本客户端口径」），官方口径
 *   以 DSH 宿主侧的会话记账为准；此处只是把同样的数据在插件卡里也呈现一份。
 *
 * 落盘契约（踩红线 1 / 凭据清理那套纪律，与 `request-counter.ts` 同款）：
 *
 * - 一个 JSON 文件、按 region + 本地日期（Asia/Shanghai 日历日）命名，落在
 *   `$DSH_HOME/.qoder-token-count.<region>.<YYYY-MM-DD>.json`。沿用
 *   `throttle-store.ts` 的「写临时文件再 rename 覆盖」原子套路。
 * - 计数发生在 shim 抓到 usage 帧时（`chatCompletions` 遍历流，累加该轮的
 *   `totalTokens`），与请求计数的「发了一发 +1」同源但不互相耦合：token 数
 *   上游直接给，重试同一轮只在那一轮的统计里加一次（流内的 usage 帧也只有
 *   一个，不会重复加）。
 * - **零点翻页**：每次读/写都重新算本地日期 key，落到不同文件，旧文件按 GC 清理。
 * - **越界防护**：region / 日期分量过 `sanitizeComponent` 白名单，任何非法
 *   分量返回 `null`（不计数、不写盘），绝不拼出目录外的路径。
 * - **永不抛**：读不到 / 写失败一律降级为「不可用」（`count === null`），不
 *   阻塞对话、不给用户假的成功读数。
 *
 * @module dsh-connect-qoder/token-counter
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { localDayKey, sanitizeComponent } from './request-counter.ts'

/** 落盘 JSON 的版本号；与 `request-counter.ts` 同约定，读错版本即丢弃。 */
const TOKEN_FORMAT_VERSION = 1

/** 一天毫秒数，用于零点翻页与 GC 窗口。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 计数器对外暴露的读数：今日消耗的 token 与缓存命中，或 `null`（本地口径不可用）。 */
export interface TokenCountSnapshot {
  /** 今日经本客户端累计消耗的 token 总数（上游 `total_tokens` 之和）；不可用为 `null`。 */
  total: number | null
  /** 今日经本客户端累计命中的缓存 token 数（上游 `cached_tokens` 之和）；不可用为 `null`。 */
  cached: number | null
  /** 该读数的本地日历日（与计数文件同名），用于客户端标注「今日」语义。 */
  day: string | null
}

/** 构造选项：路径前缀 + 注入时钟 + 日志。 */
export interface TokenCounterOptions {
  /** 生成文件名前缀的函数（注入 `qoderCatalogPath`，永远落在 `$DSH_HOME` 内）。 */
  basePath: (filename: string) => string
  /** 墙钟，注入便于测试；默认 `Date.now`。 */
  now?: () => number
  /** 可选日志。 */
  logger?: { warn?: (message: string, error?: unknown) => void }
  /** 保留几天旧文件，默认 7；GC 时删除更早的按本插件命名且日期早于该窗口的文件。 */
  keepDays?: number
}

/**
 * 把上游 usage 帧里的 token 数收敛成本累加器认识的增量。
 *
 * Qoder 的 usage 块是 OpenAI 同款 `stream_options.include_usage` 形状：
 * `{ prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details:
 * { cached_tokens } }`。只取**上游实际下发**的字段，缺则按 0 计（不编造）。
 * 任一值不是有限非负数即整体返回 `null`（该帧坏掉，宁可不加也不加错）。
 *
 * @param usage - 上游 usage 帧（任意形状，缺失字段按 0）。
 * @returns 可累加的增量，或 `null`。
 */
export function tokensFromUsage(usage: unknown): { total: number; cached: number } | null {
  if (usage === null || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const total = Number(u.total_tokens)
  const cachedRaw = (u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens
  const cached = Number(cachedRaw)
  if (!Number.isFinite(total) || total < 0) return null
  const cachedValue = Number.isFinite(cached) && cached >= 0 ? Math.floor(cached) : 0
  return { total: Math.floor(total), cached: cachedValue }
}

/**
 * 本客户端每日 token 消耗累加器。
 *
 * 一个 region 一个实例；文件按 `region + 本地日` 分文件，零点翻页自动切文件。
 * 所有磁盘操作吞错降级，绝不把计数失败传导到对话链路。
 */
export class TokenCounter {
  private basePath: (filename: string) => string
  private now: () => number
  private logger?: { warn?: (message: string, error?: unknown) => void }
  private keepDays: number

  constructor({ basePath, now = () => Date.now(), logger, keepDays = 7 }: TokenCounterOptions) {
    this.basePath = basePath
    this.now = now
    this.logger = logger
    this.keepDays = keepDays
  }

  /**
   * 当前 region + 本地日的计数文件路径；任一分量非法返回 `null`（越界防护）。
   */
  private pathFor(region: string): string | null {
    const safeRegion = sanitizeComponent(region)
    if (safeRegion === null) return null
    const day = localDayKey(this.now())
    if (day === null) return null
    return this.basePath(`.qoder-token-count.${safeRegion}.${day}.json`)
  }

  /**
   * 读今日 token 计数（不出错）。
   *
   * @param region - region id。
   * @returns 读数；文件不存在 / 损坏 / 越界 / 时区不可用 → 全部 `null`。
   */
  read(region: string): TokenCountSnapshot {
    const path = this.pathFor(region)
    if (path === null) return { total: null, cached: null, day: null }
    const day = localDayKey(this.now())
    if (!existsSync(path)) return { total: null, cached: null, day }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      const record = parsed as { version?: unknown; total?: unknown; cached?: unknown }
      if (record?.version !== TOKEN_FORMAT_VERSION) return { total: null, cached: null, day }
      const total = Number(record.total)
      const cached = Number(record.cached)
      if (!Number.isFinite(total) || total < 0) return { total: null, cached: null, day }
      const cachedValue = Number.isFinite(cached) && cached >= 0 ? Math.floor(cached) : 0
      return { total: Math.floor(total), cached: cachedValue, day }
    } catch {
      return { total: null, cached: null, day }
    }
  }

  /**
   * 把上游某轮的 token 增量累加进今日文件（不出错）。
   *
   * 与 `bump` 不同：这里累加的是「上游下发的真实 token 数」，缺字段按 0，坏
   * 帧整体跳过（返回 `null` 而非写脏数据）。读失败以 0 起写——这一轮的消耗
   * 已经发生，只是本插件没记下，降级即可，不丢数也不造数。
   *
   * @param region - region id。
   * @param usage - 上游 usage 帧。
   * @returns 累加后的读数；帧无效 / 越界 / 写失败 → `null`。
   */
  addUsage(region: string, usage: unknown): TokenCountSnapshot {
    const delta = tokensFromUsage(usage)
    if (delta === null) return { total: null, cached: null, day: null }
    return this.write(region, (prevTotal, prevCached) => ({
      total: prevTotal + delta.total,
      cached: prevCached + delta.cached,
    }))
  }

  /**
   * 计数累加 + 合并的底层落盘：读旧值 → 套用 `next` 得到新计数 → 原子写。读失败
   * 以 `{0,0}` 起写（不丢数、不裸抛）。失败清 tmp 不裸抛、warn 降级。
   */
  private write(
    region: string,
    next: (prevTotal: number, prevCached: number) => { total: number; cached: number },
  ): TokenCountSnapshot {
    const path = this.pathFor(region)
    if (path === null) return { total: null, cached: null, day: null }
    const day = localDayKey(this.now())
    let total = 0
    let cached = 0
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
        const record = parsed as { version?: unknown; total?: unknown; cached?: unknown }
        if (record?.version === TOKEN_FORMAT_VERSION) {
          const prevTotal = Number(record.total)
          const prevCached = Number(record.cached)
          if (Number.isFinite(prevTotal) && prevTotal >= 0) total = Math.floor(prevTotal)
          if (Number.isFinite(prevCached) && prevCached >= 0) cached = Math.floor(prevCached)
        }
      } catch {
        // 损坏文件：以 0 起写覆盖，不要因为旧文件坏了就丢这一轮的消耗。
      }
    }
    const result = next(total, cached)
    const tmp = `${path}.tmp`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(
        tmp,
        JSON.stringify(
          { version: TOKEN_FORMAT_VERSION, total: result.total, cached: result.cached, day },
          null,
          2,
        ),
        'utf8',
      )
      renameSync(tmp, path)
      return { total: result.total, cached: result.cached, day }
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        // 残留临时文件由 GC 回收；此处不裸抛。
      }
      this.logger?.warn?.(`dsh-connect-qoder: could not persist token count ${path}`, error)
      return { total: null, cached: null, day }
    }
  }

  /**
   * 清理过期旧文件（GC）。只删除**本插件命名且日期早于保留窗口**的 token 文件，
   * 绝不碰目录里其它文件（越界防护）。
   */
  gc(now: number = this.now()): void {
    const dir = dirname(this.basePath('x'))
    if (!existsSync(dir)) return
    const keepDays = this.keepDays
    const cutoffDay = localDayKey(now - keepDays * DAY_MS)
    if (cutoffDay === null) return
    let names: string[]
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
    } catch (error) {
      this.logger?.warn?.(`dsh-connect-qoder: could not scan token-count dir ${dir}`, error)
      return
    }
    for (const name of names) {
      const match = /^\.qoder-token-count\.([A-Za-z0-9_-]+)\.(\d{4}-\d{2}-\d{2})\.json$/.exec(name)
      if (match === null) continue
      const fileDay = match[2] as string
      if (fileDay < cutoffDay) {
        try {
          unlinkSync(`${dir}/${name}`)
        } catch (error) {
          this.logger?.warn?.(`dsh-connect-qoder: could not remove stale token-count ${name}`, error)
        }
      }
    }
  }
}
