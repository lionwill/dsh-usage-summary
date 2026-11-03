/**
 * dsh-usage-summary — host 半边。
 *
 * 两个同源只读端点（按"渠道"取数）：
 *
 *   GET {apiPath}/plan               OpenCode Go 套餐用量（滚动 5h / 周 / 月）
 *   GET {apiPath}/session?session=<id>  当前会话汇总：
 *        · 路由判定：会话最新 request/header / assistant/message 的 provider
 *        · DeepSeek 官方渠道（deepseek-official / deepseek-account）→ 本会话官方
 *          token（未命中输入 / 缓存命中 / 输出 / 推理）、按官方 CNY 价目逐次按时段
 *          计费的估算金额、账户余额（优先匹配认证方式的来源，失败回退另一来源）
 *        · OpenCode Go 渠道（goProviders）→ 本会话只统计 Go 的 token 总量与调用次数
 *
 * `/plan` 轮询 OpenCode Go 的官方用量接口并按 refreshMs 缓存；`/session` 折叠
 * 该会话的持久事件日志（纯本地，零额外 API 调用），余额按 balanceRefreshMs 缓存。
 *
 * 密钥由 Harness 的 credentials 服务解析（不落盘、不进日志）；上游失败时仍返回
 * 200 与 { ok:false, error }，客户端显示错误态。新增渠道 = 在这里加一个 provider
 * 集合 + 取数来源，客户端按 mode 渲染。
 */

import { stat as statFile } from 'node:fs/promises'

/** @type {string} */
export const name = 'usage-summary'

/** Services this plugin needs mounted before it applies. */
export const inject = ['webServer', 'credentials', 'sessions']

const DEFAULT_API_BASE = 'https://opencode.ai/inference/go/v1'
const DEFAULT_API_PATH = '/usage-summary/v1'
const DEFAULT_REFRESH_MS = 60_000
const DEFAULT_TIMEOUT_MS = 15_000
const ERROR_TTL_MS = 15_000
/** Background indexer: pause between sessions and rescan interval for stored logs. */
const DEFAULT_INDEX_DELAY_MS = 120
const DEFAULT_INDEX_RESCAN_MS = 300_000
const DEFAULT_INDEX_TIMEOUT_MS = 8_000
/** Empty fold, used while a historical session is still queued for indexing. */
const emptyGo = () => ({ calls: 0, tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } })
const emptyFold = () => ({
  route: null,
  calls: 0,
  peakCalls: 0,
  tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
  cost: 0,
  byModel: [],
  unpricedModels: [],
  go: emptyGo(),
})

const DEFAULT_DEEPSEEK_API_BASE = 'https://api.deepseek.com'
const DEFAULT_DEEPSEEK_KEY_ENV = 'DEEPSEEK_API_KEY'
/** Both official routes: API-key auth and DeepSeek-account token auth. */
const DEFAULT_DEEPSEEK_PROVIDERS = ['deepseek-official', 'deepseek-account']
/** Routes billed to the OpenCode Go subscription (console/zen route excluded on purpose). */
const DEFAULT_GO_PROVIDERS = ['opencode-go']
const DEFAULT_BALANCE_REFRESH_MS = 60_000
const SESSION_SCAN_TTL_MS = 2_000

/**
 * Official DeepSeek API prices in CNY per 1M tokens, from
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing (2026-10-17 V4 line).
 * Peak = Beijing time Mon–Fri 09:00–12:00 and 14:00–18:00, excluding Chinese
 * public holidays (holidays are not modelled — the cost is an estimate).
 */
const DEFAULT_DEEPSEEK_PRICES = {
  'deepseek-flash': {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  'deepseek-v4-pro': {
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  },
}

const WINDOWS = ['rolling', 'weekly', 'monthly']

/**
 * Normalize one upstream window into the shape the client renders.
 * @param {unknown} value raw upstream window
 * @returns {{percent: number, status: string, resetsAt: string | null} | null}
 */
function normalizeWindow(value) {
  if (typeof value !== 'object' || value === null) return null
  const raw = /** @type {Record<string, unknown>} */ (value)
  const percent = typeof raw.percent === 'number' && Number.isFinite(raw.percent) ? raw.percent : null
  if (percent === null) return null
  return {
    percent,
    status: typeof raw.status === 'string' ? raw.status : 'ok',
    resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : null,
  }
}

/**
 * Pick the documented windows out of the upstream body.
 * @param {unknown} body parsed upstream JSON
 * @returns {Record<string, ReturnType<typeof normalizeWindow>> | null}
 */
function normalizeUsage(body) {
  if (typeof body !== 'object' || body === null) return null
  const usage = /** @type {Record<string, unknown>} */ (/** @type {Record<string, unknown>} */ (body).usage)
  if (typeof usage !== 'object' || usage === null) return null
  const windows = {}
  for (const key of WINDOWS) {
    const normalized = normalizeWindow(usage[key])
    if (normalized !== null) windows[key] = normalized
  }
  return Object.keys(windows).length === 0 ? null : windows
}

/** @param {import('node:http').ServerResponse} res */
function sendJson(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(json)
}

/** Count of a possibly-absent token bucket. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Whether an instant falls in DeepSeek's peak window: Beijing time
 * Mon–Fri 09:00–12:00 / 14:00–18:00 (China has no DST; fixed UTC+8).
 * @param {unknown} time ISO timestamp from the session event
 * @returns {boolean}
 */
function isPeakHour(time) {
  const when = typeof time === 'string' ? new Date(time) : undefined
  if (when === undefined || Number.isNaN(when.getTime())) return false
  const beijing = new Date(when.getTime() + 8 * 3600_000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = beijing.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

class GoUsage {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {Record<string, unknown>} config
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.apiBase = String(config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
    this.apiKeyEnv = String(config.apiKeyEnv ?? 'OPENCODE_GO_API_KEY')
    this.apiPath = String(config.apiPath ?? DEFAULT_API_PATH).replace(/\/+$/, '')
    this.refreshMs = Math.max(5_000, Number(config.refreshMs ?? DEFAULT_REFRESH_MS))
    this.timeoutMs = Math.max(1_000, Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS))
    /** @type {{at: number, body: unknown} | undefined} */
    this.cache = undefined
    /** @type {Promise<unknown> | undefined} */
    this.inflight = undefined

    this.deepseekApiBase = String(config.deepseekApiBase ?? DEFAULT_DEEPSEEK_API_BASE).replace(/\/+$/, '')
    this.deepseekKeyEnv = String(config.deepseekKeyEnv ?? DEFAULT_DEEPSEEK_KEY_ENV)
    const configuredProviders = config.deepseekProviders
      ?? (config.deepseekProvider === undefined ? DEFAULT_DEEPSEEK_PROVIDERS : [config.deepseekProvider])
    this.deepseekProviders = new Set(
      (Array.isArray(configuredProviders) ? configuredProviders : [configuredProviders]).map(String),
    )
    this.deepseekAccountVersion = String(config.deepseekAccountVersion ?? process.env.npm_package_version ?? '1.0.0')
    const configuredGo = config.goProviders ?? DEFAULT_GO_PROVIDERS
    this.goProviders = new Set(
      (Array.isArray(configuredGo) ? configuredGo : [configuredGo]).map(String),
    )
    this.balanceRefreshMs = Math.max(5_000, Number(config.balanceRefreshMs ?? DEFAULT_BALANCE_REFRESH_MS))
    this.prices = config.deepseekPrices ?? DEFAULT_DEEPSEEK_PRICES
    /** @type {{at: number, body: unknown} | undefined} */
    this.balanceCache = undefined
    /** @type {Promise<unknown> | undefined} */
    this.balanceInflight = undefined
    /** @type {{at: number, body: unknown} | undefined} */
    this.accountBalanceCache = undefined
    /** @type {Promise<unknown> | undefined} */
    this.accountBalanceInflight = undefined
    /** @type {Map<string, {seq: number, at: number, body: unknown}>} */
    this.sessionCache = new Map()

    // Background index over stored sessions, most recently active first.
    this.indexDelayMs = Math.max(0, Number(config.indexDelayMs ?? DEFAULT_INDEX_DELAY_MS))
    this.indexRescanMs = Math.max(30_000, Number(config.indexRescanMs ?? DEFAULT_INDEX_RESCAN_MS))
    this.indexTimeoutMs = Math.max(1_000, Number(config.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS))
    /** @type {Map<string, {revision?: string, at: number, folded?: unknown, error?: string}>} */
    this.index = new Map()
    /** @type {string[]} */
    this.queue = []
    /** @type {Map<string, {resolve: (value: unknown) => void, promise: Promise<unknown>}>} */
    this.jobs = new Map()
    this.workingIndex = false
    this.stoppedIndex = false
    this.rescanTimer = undefined
  }

  /** Resolve a stored credential through the Harness credentials service. */
  async resolveCredential(ref) {
    const resolved = await this.ctx.credentials.resolve(ref)
    const value = resolved?.value
    if (typeof value !== 'string' || value === '') {
      throw new Error(`凭据 ${ref} 未配置；请在模型设置页填入对应的 API key`)
    }
    return value
  }

  /** Fetch (or reuse) the OpenCode Go usage snapshot. */
  async load(force) {
    const now = Date.now()
    if (!force && this.cache !== undefined && now - this.cache.at < this.refreshMs) return this.cache.body
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.fetchUsage()
      .then((body) => {
        this.cache = { at: Date.now(), body }
        return body
      })
      .catch((error) => {
        const body = {
          ok: false,
          fetchedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }
        // Keep a failed probe for a short while so a burst of client polls does
        // not hammer a failing upstream, but refresh far sooner than success.
        this.cache = { at: Date.now() - this.refreshMs + ERROR_TTL_MS, body }
        return body
      })
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /** One upstream OpenCode Go usage request. */
  async fetchUsage() {
    const apiKey = await this.resolveCredential(this.apiKeyEnv)
    const response = await fetch(`${this.apiBase}/usage`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        'user-agent': 'dsh-usage-summary',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`用量接口返回 ${response.status}：${text.slice(0, 200)}`)
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('用量接口返回的不是 JSON')
    }
    const windows = normalizeUsage(parsed)
    if (windows === null) throw new Error('用量接口返回的结构无法识别')
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      refreshMs: this.refreshMs,
      source: `${this.apiBase}/usage`,
      usage: windows,
    }
  }

  /** Price entry for one model id, falling back to the Flash table. */
  priceFor(model) {
    const table = this.prices ?? DEFAULT_DEEPSEEK_PRICES
    if (table[model] !== undefined) return { entry: table[model], pricedAs: model }
    return { entry: table['deepseek-flash'] ?? DEFAULT_DEEPSEEK_PRICES['deepseek-flash'], pricedAs: 'deepseek-flash' }
  }

  /**
   * Cost in CNY of one billed call.
   * @param {{uncachedInput: number, cacheRead: number, output: number}} tokens
   * @param {string} model
   * @param {boolean} peak
   */
  costOf(tokens, model, peak) {
    const { entry } = this.priceFor(model)
    const price = peak ? entry.peak : entry.offPeak
    return tokens.cacheRead / 1e6 * price.cacheHit
      + tokens.uncachedInput / 1e6 * price.cacheMiss
      + tokens.output / 1e6 * price.output
  }

  /**
   * Fold one session's durable log into the DeepSeek-official accounting.
   * Only events whose provider is the official route are billed.
   * @param {any} session
   */
  foldEvents(events) {
    let route
    let calls = 0
    const tokens = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }
    let cost = 0
    let peakCalls = 0
    const byModel = new Map()
    const unpriced = new Set()
    let goCalls = 0
    const goTokens = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }

    // Caller supplies the log: live sessions pass the deprecated synchronous
    // snapshot read, stored sessions come from the persistence backend.
    for (const event of events) {
      const data = event?.data
      if (event?.type === 'request/header') {
        const config = data?.header?.config
        if (typeof config?.provider === 'string' && config.provider !== '') {
          route = { provider: config.provider, model: typeof config.model === 'string' ? config.model : route?.model }
        }
        continue
      }
      if (event?.type !== 'assistant/message') continue
      const source = data?.message?.source
      const provider = typeof source?.provider === 'string' ? source.provider : undefined
      if (provider !== undefined) route = { provider, model: typeof source?.model === 'string' ? source.model : route?.model }
      const isOfficial = provider !== undefined && this.deepseekProviders.has(provider)
      const isGo = provider !== undefined && this.goProviders.has(provider)
      if (!isOfficial && !isGo) continue

      const usage = data?.usage
      if (typeof usage !== 'object' || usage === null) continue
      const model = typeof source?.model === 'string' && source.model !== '' ? source.model : 'unknown'
      const buckets = {
        uncachedInput: count(usage.inputTokens),
        cacheRead: count(usage.cacheReadTokens),
        cacheWrite: count(usage.cacheWriteTokens),
        output: count(usage.outputTokens),
        reasoning: count(usage.reasoningTokens),
      }
      if (isGo) {
        goCalls += 1
        goTokens.uncachedInput += buckets.uncachedInput
        goTokens.cacheRead += buckets.cacheRead
        goTokens.cacheWrite += buckets.cacheWrite
        goTokens.output += buckets.output
        goTokens.total += buckets.uncachedInput + buckets.cacheRead + buckets.cacheWrite + buckets.output
      }
      if (!isOfficial) continue
      const peak = isPeakHour(event.time)
      const callCost = this.costOf(buckets, model, peak)
      if (!(model in (this.prices ?? {}))) unpriced.add(model)

      calls += 1
      if (peak) peakCalls += 1
      tokens.uncachedInput += buckets.uncachedInput
      tokens.cacheRead += buckets.cacheRead
      tokens.cacheWrite += buckets.cacheWrite
      tokens.output += buckets.output
      tokens.reasoning += buckets.reasoning
      tokens.total += buckets.uncachedInput + buckets.cacheRead + buckets.cacheWrite + buckets.output
      cost += callCost

      const row = byModel.get(model) ?? { model, calls: 0, tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }, cost: 0 }
      row.calls += 1
      row.tokens.uncachedInput += buckets.uncachedInput
      row.tokens.cacheRead += buckets.cacheRead
      row.tokens.cacheWrite += buckets.cacheWrite
      row.tokens.output += buckets.output
      row.tokens.reasoning += buckets.reasoning
      row.cost += callCost
      byModel.set(model, row)
    }

    return {
      route: route ?? null,
      calls,
      peakCalls,
      tokens,
      cost,
      byModel: [...byModel.values()],
      unpricedModels: [...unpriced],
      go: { calls: goCalls, tokens: goTokens },
      scannedSeq: events.length > 0 ? (events[events.length - 1]?.seq ?? null) : null,
    }
  }

  /**
   * Session accounting with a tiny cache keyed by the session's log cursor.
   * @param {string} sessionId
   */
  /**
   * Live session (already loaded in this process) folds immediately; a
   * historical one is served from the background index, or `undefined` while
   * it is still queued.
   * @param {string} sessionId
   */
  readSession(sessionId) {
    const sessions = this.ctx.sessions
    const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
    if (session !== undefined && session !== null) {
      const seq = typeof session.seq === 'number' ? session.seq : -1
      const cached = this.sessionCache.get(sessionId)
      if (cached !== undefined && cached.seq === seq && Date.now() - cached.at < SESSION_SCAN_TTL_MS) return cached.body
      let folded
      try {
        folded = this.foldEvents(typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [])
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      const body = { ok: true, ...folded }
      this.sessionCache.set(sessionId, { seq, at: Date.now(), body })
      return body
    }
    const cached = this.index.get(sessionId)
    if (cached?.folded !== undefined && cached.error === undefined) return { ok: true, ...cached.folded }
    if (cached?.error !== undefined) return { ok: false, error: cached.error }
    return undefined
  }

  /** Last-modified instant of one stored session (falls back to its header). */
  async storedMtimeOf(snapshot) {
    const path = snapshot?.location?.path
    if (typeof path === 'string' && path !== '') {
      try {
        const info = await statFile(path)
        if (Number.isFinite(info.mtimeMs)) return info.mtimeMs
      } catch { /* fall back to the header */ }
    }
    const created = snapshot?.header?.createdAt
    return typeof created === 'number' && Number.isFinite(created) ? created : 0
  }

  /** Fold one stored session through the persistence backend (read-only handle). */
  async foldStored(sessionId) {
    const persistence = typeof this.ctx.get === 'function' ? this.ctx.get('sessionPersistence') : undefined
    if (persistence === undefined || typeof persistence.open !== 'function') throw new Error('会话持久化服务不可用')
    const handle = await persistence.open(sessionId, 'read')
    try {
      const result = await handle.read()
      return this.foldEvents(Array.isArray(result?.events) ? result.events : [])
    } finally {
      try { await handle.close() } catch { /* a close failure must not mask the fold */ }
    }
  }

  /**
   * Queue one stored-session fold; repeated requests join the pending job.
   * `front` lifts it to the head of the queue (the explicit refresh path).
   */
  enqueueIndex(sessionId, front) {
    const existing = this.jobs.get(sessionId)
    if (existing !== undefined) return existing.promise
    let resolve
    const promise = new Promise((settle) => { resolve = settle })
    this.jobs.set(sessionId, { resolve, promise })
    if (front === true) this.queue.unshift(sessionId)
    else this.queue.push(sessionId)
    void this.pumpIndex()
    return promise
  }

  /** Quiet background worker: one stored session at a time, pausing between them. */
  async pumpIndex() {
    if (this.workingIndex || this.stoppedIndex) return
    this.workingIndex = true
    try {
      while (!this.stoppedIndex && this.queue.length > 0) {
        const sessionId = this.queue.shift()
        const job = this.jobs.get(sessionId)
        if (job === undefined) continue
        this.jobs.delete(sessionId)
        try {
          const folded = await this.foldStored(sessionId)
          this.index.set(sessionId, { ...this.index.get(sessionId), at: Date.now(), folded, error: undefined })
          job.resolve(folded)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.index.set(sessionId, { ...this.index.get(sessionId), at: Date.now(), folded: undefined, error: message })
          job.resolve({ __error: message })
        }
        if (this.indexDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.indexDelayMs))
      }
    } finally {
      this.workingIndex = false
    }
  }

  /**
   * Discover stored sessions and queue the changed ones, most recently active
   * first. Live sessions are skipped (they fold on demand and may have
   * unflushed events the stored log does not carry yet).
   */
  async bootstrapIndex() {
    const persistence = typeof this.ctx.get === 'function' ? this.ctx.get('sessionPersistence') : undefined
    if (persistence === undefined || typeof persistence.list !== 'function') return
    let snapshots
    try { snapshots = await persistence.list() } catch { return }
    const rows = []
    for (const snapshot of snapshots) {
      const id = snapshot?.header?.id
      if (typeof id !== 'string' || id === '') continue
      const live = typeof this.ctx.sessions?.get === 'function' ? this.ctx.sessions.get(id) : undefined
      if (live !== undefined && live !== null) continue
      const revision = snapshot?.revision === undefined ? undefined : String(snapshot.revision)
      const cached = this.index.get(id)
      if (revision !== undefined && cached?.revision === revision) continue
      rows.push({ id, revision, mtime: await this.storedMtimeOf(snapshot) })
    }
    rows.sort((left, right) => right.mtime - left.mtime)
    for (const row of rows) {
      this.index.set(row.id, { revision: row.revision, at: 0 })
      void this.enqueueIndex(row.id, false)
    }
  }

  /** Start the background index, retrying once the persistence service is mounted. */
  startIndex() {
    void this.bootstrapIndex()
    this.rescanTimer = setInterval(() => {
      if (!this.stoppedIndex) void this.bootstrapIndex()
    }, this.indexRescanMs)
    if (typeof this.rescanTimer.unref === 'function') this.rescanTimer.unref()
  }

  /** Fetch (or reuse) the official DeepSeek balance. */
  async loadBalance(force) {
    const now = Date.now()
    if (!force && this.balanceCache !== undefined && now - this.balanceCache.at < this.balanceRefreshMs) return this.balanceCache.body
    if (this.balanceInflight !== undefined) return this.balanceInflight
    this.balanceInflight = this.fetchBalance()
      .then((body) => {
        this.balanceCache = { at: Date.now(), body }
        return body
      })
      .catch((error) => {
        const body = {
          ok: false,
          fetchedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }
        this.balanceCache = { at: Date.now() - this.balanceRefreshMs + ERROR_TTL_MS, body }
        return body
      })
      .finally(() => {
        this.balanceInflight = undefined
      })
    return this.balanceInflight
  }

  /** One official balance request. */
  async fetchBalance() {
    const apiKey = await this.resolveCredential(this.deepseekKeyEnv)
    const response = await fetch(`${this.deepseekApiBase}/user/balance`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        'user-agent': 'dsh-usage-summary',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`余额接口返回 ${response.status}：${text.slice(0, 200)}`)
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('余额接口返回的不是 JSON')
    }
    const infos = Array.isArray(parsed?.balance_infos) ? parsed.balance_infos : []
    const info = infos.find((row) => row?.currency === 'CNY') ?? infos[0]
    if (info === undefined) throw new Error('余额接口未返回可用余额')
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      isAvailable: parsed?.is_available !== false,
      currency: String(info.currency ?? 'CNY'),
      total: Number(info.total_balance),
      granted: Number(info.granted_balance),
      toppedUp: Number(info.topped_up_balance),
      source: `${this.deepseekApiBase}/user/balance`,
    }
  }

  /** Identity headers the account platform service expects from a first-party client. */
  accountClientMetadata() {
    return {
      version: this.deepseekAccountVersion,
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
  }

  /** Fetch (or reuse) the signed-in DeepSeek account's wallet balance. */
  async loadAccountBalance(force) {
    const now = Date.now()
    if (!force && this.accountBalanceCache !== undefined && now - this.accountBalanceCache.at < this.balanceRefreshMs) {
      return this.accountBalanceCache.body
    }
    if (this.accountBalanceInflight !== undefined) return this.accountBalanceInflight
    this.accountBalanceInflight = this.fetchAccountBalance()
      .then((body) => {
        this.accountBalanceCache = { at: Date.now(), body }
        return body
      })
      .catch((error) => {
        const body = {
          ok: false,
          fetchedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }
        this.accountBalanceCache = { at: Date.now() - this.balanceRefreshMs + ERROR_TTL_MS, body }
        return body
      })
      .finally(() => {
        this.accountBalanceInflight = undefined
      })
    return this.accountBalanceInflight
  }

  /** One platform-wallet query through the account service, shaped like the API-key balance. */
  async fetchAccountBalance() {
    const service = typeof this.ctx.get === 'function' ? this.ctx.get('deepseekAccount') : undefined
    if (service === undefined || typeof service.getBalance !== 'function') {
      throw new Error('DeepSeek 账号服务不可用（未登录或账号插件未挂载）')
    }
    const result = await service.getBalance(this.accountClientMetadata())
    if (result === null || result === undefined) throw new Error('DeepSeek 账号未登录')
    if (result.status !== 'ready') throw new Error('账号余额查询失败')
    const normal = Array.isArray(result.value) ? result.value : []
    const bonus = Array.isArray(result.bonusWallets) ? result.bonusWallets : []
    const wallets = [...normal, ...bonus]
    if (wallets.length === 0) throw new Error('账号未返回可用钱包')
    const currency = (wallets.find((wallet) => wallet?.currency === 'CNY') ?? wallets[0]).currency ?? 'CNY'
    const sumOf = (list) => list
      .filter((wallet) => wallet?.currency === currency)
      .reduce((total, wallet) => total + Number(wallet.balance), 0)
    const toppedUp = sumOf(normal)
    const granted = sumOf(bonus)
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      source: 'account',
      isAvailable: true,
      currency,
      total: Number((toppedUp + granted).toFixed(2)),
      granted: Number(granted.toFixed(2)),
      toppedUp: Number(toppedUp.toFixed(2)),
    }
  }

  /**
   * Balance for the session's route: prefer the source that matches the auth
   * in use, then fall back to the other one (same account when both work).
   * @param {{provider: string, model?: string} | null} route
   * @param {boolean} [force]
   */
  async balanceFor(route, force) {
    const prefersAccount = route !== null && route.provider === 'deepseek-account'
    const first = prefersAccount ? await this.loadAccountBalance(force) : await this.loadBalance(force)
    if (first !== undefined && first.ok === true) return first
    const second = prefersAccount ? await this.loadBalance(force) : await this.loadAccountBalance(force)
    if (second !== undefined && second.ok === true) return second
    return first ?? second ?? { ok: false, error: '余额取数失败' }
  }

  /**
   * Per-session summary, switched by the route the session is actually using:
   * a DeepSeek official route serves the official block only; everything else
   * serves the OpenCode Go block (with this session's Go-only token total).
   */
  async sessionFor(sessionId, force) {
    let folded = this.readSession(sessionId)
    if (folded === undefined) {
      // Historical session: serve the background index, or queue it.
      if (force === true) {
        const awaited = await Promise.race([
          this.enqueueIndex(sessionId, true),
          new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), this.indexTimeoutMs)),
        ])
        if (awaited !== null && typeof awaited === 'object'
          && awaited.__error === undefined && awaited.__timeout === undefined) {
          folded = { ok: true, ...awaited }
        }
      } else {
        void this.enqueueIndex(sessionId, false)
      }
      if (folded === undefined) {
        const cached = this.index.get(sessionId)
        if (cached?.error !== undefined) return { ok: false, error: cached.error }
        return { ok: true, mode: 'go', pending: true, route: null, go: emptyGo() }
      }
    }
    if (folded.ok !== true) return folded
    const route = folded.route
    const go = folded.go ?? emptyGo()
    const isDeepseek = route !== null && this.deepseekProviders.has(route.provider)
    if (!isDeepseek) return { ok: true, mode: 'go', route, go }
    const balance = await this.balanceFor(route, force)
    return {
      ok: true,
      mode: 'deepseek',
      route,
      auth: route.provider === 'deepseek-account' ? 'account' : 'api-key',
      deepseek: {
        calls: folded.calls,
        peakCalls: folded.peakCalls,
        tokens: folded.tokens,
        cost: {
          total: Number(folded.cost.toFixed(6)),
          currency: 'CNY',
          peakAware: true,
          unpricedModels: folded.unpricedModels,
        },
        byModel: folded.byModel.map((row) => ({ ...row, cost: Number(row.cost.toFixed(6)) })),
        balance,
      },
      go,
      pricesAsOf: '2026-10-17',
    }
  }

  /** @param {import('node:http').IncomingMessage} req */
  async handle(req, res) {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const force = url.searchParams.get('refresh') === '1'

    if (url.pathname === `${this.apiPath}/session`) {
      const sessionId = url.searchParams.get('session') ?? ''
      if (sessionId === '') {
        sendJson(res, 200, { ok: false, error: '缺少 session 参数' })
        return
      }
      try {
        sendJson(res, 200, await this.sessionFor(sessionId, force))
      } catch (error) {
        sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (url.pathname !== this.apiPath && url.pathname !== `${this.apiPath}/plan`) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    const body = await this.load(force)
    sendJson(res, 200, body)
  }

  start() {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'prefix',
      path: this.apiPath,
      handler: (req, res) => this.handle(req, res),
    }), 'usage-summary: read-only usage API')
    this.ctx.inject(['sessionPersistence'], (scope) => {
      this.startIndex()
      scope.effect(() => () => {
        this.stoppedIndex = true
        if (this.rescanTimer !== undefined) clearInterval(this.rescanTimer)
        for (const job of this.jobs.values()) job.resolve({ __error: 'cancelled' })
        this.jobs.clear()
        this.queue.length = 0
      }, 'usage-summary: session indexer')
    })
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  new GoUsage(ctx, config).start()
}
