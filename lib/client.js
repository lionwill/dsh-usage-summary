/**
 * dsh-usage-summary — client 半边。
 *
 * 注册进输入框下方状态栏插槽 `conversation.composer.dock`（order -10，排在
 * 「N 轮 M 步」统计胶囊左侧）。面板按**当前会话正在使用的渠道**切换：
 *
 *   · DeepSeek 官方渠道（deepseek-official / deepseek-account）
 *       → 只显示官方数据：本会话官方 token、按时段计费的估算金额、账户余额；
 *         标题「DeepSeek 官方余额」，胶囊显示余额。
 *   · OpenCode Go 渠道（其他情况）
 *       → 显示套餐三窗口（5 小时 / 周 / 月）+ 顶部「本会话」Go token 总量；
 *         标题「OpenCode Go 用量汇总」，胶囊显示三窗口百分比。
 *
 * 明细面板通过 portal 挂到 body 并用 fixed 定位锚定胶囊，避免被输入框卡片
 * 裁切。数据来自 host 侧两个同源端点：
 *   GET /usage-summary/v1/plan
 *   GET /usage-summary/v1/session?session=<sessionId>
 */
window.__ModuleLoader__.load({
  id: 'dsh-usage-summary',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const reactDom = require('react-dom')
    const h = react.createElement

    const inject = ['slots']
    const PLAN_PATH = '/usage-summary/v1/plan'
    const SESSION_PATH = '/usage-summary/v1/session'
    const POLL_MS = 60_000
    const CARD_WIDTH = 262
    const THRESHOLD_KEY = 'dsh-usage-summary:thresholds'
    const DEFAULT_THRESHOLDS = { warn: 60, bad: 85 }

    /** Read the user's color thresholds, falling back to the defaults. */
    function loadThresholds() {
      try {
        const raw = localStorage.getItem(THRESHOLD_KEY)
        if (raw === null) return { ...DEFAULT_THRESHOLDS }
        const parsed = JSON.parse(raw)
        const warn = Number(parsed?.warn)
        const bad = Number(parsed?.bad)
        if (!Number.isFinite(warn) || !Number.isFinite(bad)) return { ...DEFAULT_THRESHOLDS }
        if (warn < 1 || bad > 100 || warn >= bad) return { ...DEFAULT_THRESHOLDS }
        return { warn: Math.round(warn), bad: Math.round(bad) }
      } catch {
        return { ...DEFAULT_THRESHOLDS }
      }
    }

    const zh = !(navigator.language || '').toLowerCase().startsWith('en')
    const L = zh
      ? {
          titleGo: 'OpenCode Go 用量汇总',
          titleDs: 'DeepSeek 官方余额',
          pillGo: 'Go',
          pillDs: 'DS',
          short: { rolling: '5h', weekly: '周', monthly: '月' },
          long: { rolling: '5 小时', weekly: '本周', monthly: '本月' },
          reset: '重置',
          session: '本会话',
          tok: 'tok',
          calls: '次',
          loading: '读取中…',
          pending: '统计中…',
          error: '取数失败',
          retry: '重试',
          refresh: '刷新',
          close: '关闭',
          tipGo: '套餐数据来自 opencode.ai/inference/go/v1/usage',
          tipDs: '用量取自本机会话日志；余额来自 DeepSeek 官方',
          dsInput: '输入(未命中)',
          dsCache: '缓存命中',
          dsOutput: '输出',
          dsCost: '花费(估算)',
          dsBalance: '余额',
          dsAcc: '账号',
          dsApi: 'API',
          dsUnavailable: '取数失败',
          dsCostHint: '按官方 CNY 价目表逐次计费，区分高峰/空闲时段；法定节假日按工作日近似。',
          setTitle: '颜色阈值设置',
          setWarn: '橙色起点 (%)',
          setBad: '红色起点 (%)',
          setLegend: '绿 / 橙 / 红 三个区间',
          setSave: '保存',
          setReset: '恢复默认',
          setCancel: '取消',
          setInvalid: '需满足 1 ≤ 橙色起点 < 红色起点 ≤ 100',
          setHint: '只影响本浏览器的显示，保存在 localStorage。',
        }
      : {
          titleGo: 'OpenCode Go usage',
          titleDs: 'DeepSeek official balance',
          pillGo: 'Go',
          pillDs: 'DS',
          short: { rolling: '5h', weekly: 'wk', monthly: 'mo' },
          long: { rolling: '5-hour', weekly: 'Weekly', monthly: 'Monthly' },
          reset: 'resets',
          session: 'This session',
          tok: 'tok',
          calls: 'calls',
          loading: 'loading…',
          pending: 'indexing…',
          error: 'failed',
          retry: 'retry',
          refresh: 'refresh',
          close: 'Close',
          tipGo: 'plan data: opencode.ai/inference/go/v1/usage',
          tipDs: 'usage: local session log · balance: DeepSeek official',
          dsInput: 'input (miss)',
          dsCache: 'cache hit',
          dsOutput: 'output',
          dsCost: 'cost (est.)',
          dsBalance: 'balance',
          dsAcc: 'account',
          dsApi: 'API',
          dsUnavailable: 'unavailable',
          dsCostHint: 'Priced per call from the official CNY table with peak/off-peak rates; public holidays approximated.',
          setTitle: 'Color thresholds',
          setWarn: 'Amber from (%)',
          setBad: 'Red from (%)',
          setLegend: 'Green / amber / red ranges',
          setSave: 'Save',
          setReset: 'Defaults',
          setCancel: 'Cancel',
          setInvalid: 'Requires 1 ≤ amber start < red start ≤ 100',
          setHint: 'Affects this browser only; stored in localStorage.',
        }

    const WINDOWS = ['rolling', 'weekly', 'monthly']

    const CSS = [
      /* compact pill living in the composer dock */
      '.ogu-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;padding:1px 8px;',
      'border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;',
      'color:var(--dsw-alias-label-tertiary,#8a8a94);',
      'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
      'cursor:pointer;user-select:none;white-space:nowrap;transition:background .15s ease,color .15s ease}',
      '.ogu-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,#9a9aa5)}',
      '.ogu-pill[data-open="1"]{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,#9a9aa5)}',
      '.ogu-dot{width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-state-success-primary,#3ecf8e);flex:none}',
      '.ogu-dot.warn{background:var(--dsw-alias-state-warn-primary,#f5a524)}.ogu-dot.bad{background:var(--dsw-alias-state-error-primary,#f31260)}.ogu-dot.off{background:var(--dsw-alias-label-tertiary,#8a8a94)}',
      '.ogu-brand{font-weight:600}',
      '.ogu-sep{opacity:.35}',
      '.ogu-chip{font-variant-numeric:tabular-nums}',
      '.ogu-chip.warn{color:var(--dsw-alias-state-warn-primary,#f5a524)}.ogu-chip.bad{color:var(--dsw-alias-state-error-primary,#f31260)}.ogu-chip.off{opacity:.5}',
      /* popover */
      '.ogu-pop{position:fixed;z-index:1200;box-sizing:border-box;width:262px;',
      'padding:9px 10px 7px;border-radius:12px;',
      'background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#1b1b20));color:var(--dsw-alias-label-primary,#e7e7ea);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));',
      'box-shadow:0 10px 30px rgba(0,0,0,.36);',
      'font:12px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;user-select:none}',
      '.ogu-pop-head{display:flex;align-items:center;gap:6px;margin-bottom:6px}',
      '.ogu-btn{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9a9aa5);',
      'cursor:pointer;padding:0 3px;font-size:12px;line-height:16px;border-radius:4px}',
      '.ogu-btn:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '.ogu-row{display:grid;grid-template-columns:46px 1fr 36px;align-items:center;gap:8px;padding:1px 0}',
      '.ogu-k{color:var(--dsw-alias-label-secondary,#a9a9b3);white-space:nowrap}',
      '.ogu-bar{display:block;height:5px;border-radius:3px;background:rgba(128,128,144,.22);overflow:hidden}',
      '.ogu-fill{display:block;height:5px;border-radius:3px;background:var(--dsw-alias-state-success-primary,#3ecf8e);transition:width .35s ease}',
      '.ogu-fill.warn{background:var(--dsw-alias-state-warn-primary,#f5a524)}.ogu-fill.bad{background:var(--dsw-alias-state-error-primary,#f31260)}',
      '.ogu-p{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}',
      '.ogu-reset{padding:0 0 3px 54px;color:var(--dsw-alias-label-secondary,#7f7f89);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ogu-err{color:var(--dsw-alias-state-error-primary,#ff9db8);font-size:11px;word-break:break-word;padding:2px 0}',
      /* summary rows (session total / DeepSeek block) */
      '.ogu-div{border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));margin:7px 0 5px}',
      '.ogu-ds-head{display:flex;align-items:center;gap:5px;margin-bottom:3px;font-size:11px;font-weight:600;',
      'color:var(--dsw-alias-label-secondary,#a9a9b3)}',
      '.ogu-ds-auth{flex:none;font-weight:400;font-size:10px;line-height:14px;padding:0 4px;border-radius:4px;',
      'background:rgba(128,128,144,.18);color:var(--dsw-alias-label-secondary,#a9a9b3)}',
      '.ogu-ds-model{margin-left:auto;font-weight:400;max-width:126px;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a8a94)}',
      '.ogu-ds-row{display:flex;align-items:baseline;gap:8px;padding:0 0 1px}',
      '.ogu-ds-k{flex:none;width:86px;color:var(--dsw-alias-label-tertiary,#8a8a94);white-space:nowrap}',
      '.ogu-ds-v{flex:1;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ogu-sum .ogu-ds-v{font-weight:600;color:var(--dsw-alias-label-primary,#e7e7ea)}',
      '.ogu-pop-title{flex:1;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ogu-sum{padding-bottom:3px}',
      '.ogu-bal .ogu-ds-v{font-weight:600;color:var(--dsw-alias-label-primary,#e7e7ea)}',
      '.ogu-bal .ogu-ds-v.low{color:var(--dsw-alias-state-error-primary,#f31260)}',
      /* threshold settings */
      '.ogu-set{margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));',
      'display:flex;flex-direction:column;gap:4px}',
      '.ogu-set-legend{display:flex;gap:8px;flex-wrap:wrap;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a94);padding-bottom:1px}',
      '.ogu-swatch{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:3px;vertical-align:middle}',
      '.ogu-swatch.g{background:var(--dsw-alias-state-success-primary,#3ecf8e)}',
      '.ogu-swatch.o{background:var(--dsw-alias-state-warn-primary,#f5a524)}',
      '.ogu-swatch.b{background:var(--dsw-alias-state-error-primary,#f31260)}',
      '.ogu-set-row{display:flex;align-items:center;gap:8px}',
      '.ogu-set-k{flex:1;color:var(--dsw-alias-label-tertiary,#8a8a94);white-space:nowrap}',
      '.ogu-set-input{width:58px;box-sizing:border-box;background:rgba(128,128,144,.12);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:5px;',
      'color:var(--dsw-alias-label-primary,#e7e7ea);font:inherit;font-size:11px;padding:2px 5px;text-align:right}',
      '.ogu-set-input:focus{outline:1px solid var(--dsw-focus-ring-color,#4d9fff);border-color:transparent}',
      '.ogu-set-actions{display:flex;gap:6px;margin-top:2px}',
      '.ogu-set-btn{flex:1;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:transparent;',
      'color:var(--dsw-alias-label-secondary,#9a9aa5);border-radius:6px;padding:2px 0;font:inherit;font-size:11px;cursor:pointer}',
      '.ogu-set-btn:hover{color:var(--dsw-alias-label-primary,#fff)}',
      '.ogu-set-btn.primary{background:var(--dsw-alias-state-success-primary,#3ecf8e);color:#0b1f14;border-color:transparent;font-weight:600}',
      '.ogu-set-hint{font-size:10px;color:var(--dsw-alias-label-tertiary,#7f7f89)}',
    ].join('')

    /** Band classification from the user's thresholds. */
    const pctClassFor = (percent, thresholds) =>
      (percent >= thresholds.bad ? 'bad' : percent >= thresholds.warn ? 'warn' : '')

    /** Local-time label for a reset instant; time only inside the next 24h. */
    function fmtReset(iso) {
      if (!iso) return ''
      const when = new Date(iso)
      if (Number.isNaN(when.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      if (when.getTime() - Date.now() < 24 * 3600_000) return `${pad(when.getHours())}:${pad(when.getMinutes())}`
      return `${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
    }

    /** Compact token count: 123 / 1.2K / 14.4M. */
    function fmtTokens(value) {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (n < 1000) return String(Math.round(n))
      if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 2 : 1)}K`
      return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`
    }

    /** CNY amount: small numbers keep four decimals, otherwise two. */
    function fmtMoney(value, digits) {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (digits !== undefined) return n.toFixed(digits)
      if (n === 0) return '0.0000'
      if (n < 1) return n.toFixed(4)
      return n.toFixed(2)
    }

    /** Fetch a same-origin JSON endpoint, reporting a usable error string. */
    async function getJson(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      const data = await response.json()
      if (data && data.ok === true) return { ok: true, data }
      return { ok: false, error: (data && data.error) || '请求失败' }
    }

    function usePlan() {
      const [state, setState] = react.useState({ status: 'loading' })
      const alive = react.useRef(true)

      const read = react.useCallback(async (force) => {
        try {
          const result = await getJson(PLAN_PATH + (force ? '?refresh=1' : ''))
          if (!alive.current) return
          if (result.ok) setState({ status: 'ready', data: result.data })
          else setState({ status: 'error', error: result.error })
        } catch (error) {
          if (alive.current) setState({ status: 'error', error: String(error && error.message ? error.message : error) })
        }
      }, [])

      react.useEffect(() => {
        alive.current = true
        const tick = () => { if (!document.hidden) void read(false) }
        tick()
        const timer = Number(setInterval(tick, POLL_MS))
        const onVisible = () => { if (!document.hidden) void read(false) }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive.current = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [read])

      return { state, read }
    }

    /** Per-session channel summary: drives both the pill content and the panel mode. */
    function useSessionSummary(sessionId) {
      const [state, setState] = react.useState({ status: 'idle' })
      const alive = react.useRef(true)

      const read = react.useCallback(async (force) => {
        if (!sessionId) return
        try {
          const query = `?session=${encodeURIComponent(sessionId)}${force ? '&refresh=1' : ''}`
          const result = await getJson(SESSION_PATH + query)
          if (!alive.current) return
          if (result.ok) setState({ status: 'ready', data: result.data })
          else setState({ status: 'error', error: result.error })
        } catch (error) {
          if (alive.current) setState({ status: 'error', error: String(error && error.message ? error.message : error) })
        }
      }, [sessionId])

      react.useEffect(() => {
        alive.current = true
        if (!sessionId) return () => { alive.current = false }
        const tick = () => { if (!document.hidden) void read(false) }
        tick()
        const timer = Number(setInterval(tick, POLL_MS))
        const onVisible = () => { if (!document.hidden) void read(false) }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive.current = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [read, sessionId])

      return { state, read }
    }

    /** Anchored popover that opens upward above the pill. */
    function Panel({ anchor, onClose, children }) {
      const popRef = react.useRef(null)
      const [pos, setPos] = react.useState(null)

      const place = react.useCallback(() => {
        const rect = anchor?.getBoundingClientRect?.()
        if (!rect) return
        const left = Math.min(Math.max(8, rect.left + rect.width / 2 - CARD_WIDTH / 2), window.innerWidth - CARD_WIDTH - 8)
        setPos({ left, bottom: Math.max(8, window.innerHeight - rect.top + 8) })
      }, [anchor])

      react.useEffect(() => {
        place()
        const onResize = () => place()
        window.addEventListener('resize', onResize)
        window.addEventListener('scroll', onResize, true)
        return () => {
          window.removeEventListener('resize', onResize)
          window.removeEventListener('scroll', onResize, true)
        }
      }, [place])

      react.useEffect(() => {
        const onDown = (event) => {
          const target = event.target
          if (popRef.current?.contains(target) || anchor?.contains?.(target)) return
          onClose()
        }
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [anchor, onClose])

      if (!pos) return null
      return reactDom.createPortal(
        h('div', {
          ref: popRef,
          className: 'ogu-pop',
          role: 'dialog',
          'aria-label': L.titleGo,
          style: { left: `${pos.left}px`, bottom: `${pos.bottom}px` },
        }, children),
        document.body,
      )
    }

    function UsagePill(props) {
      const sessionId = props && props.sessionId
      const pillRef = react.useRef(null)
      const [open, setOpen] = react.useState(false)
      const plan = usePlan()
      const summary = useSessionSummary(sessionId)
      const [thresholds, setThresholds] = react.useState(loadThresholds)
      const [settingsOpen, setSettingsOpen] = react.useState(false)
      const [draftWarn, setDraftWarn] = react.useState('')
      const [draftBad, setDraftBad] = react.useState('')
      const [settingsError, setSettingsError] = react.useState('')
      const pctClass = (percent) => pctClassFor(percent, thresholds)

      const openSettings = () => {
        setDraftWarn(String(thresholds.warn))
        setDraftBad(String(thresholds.bad))
        setSettingsError('')
        setSettingsOpen(true)
      }
      const saveSettings = () => {
        const warn = Number(draftWarn)
        const bad = Number(draftBad)
        if (!Number.isFinite(warn) || !Number.isFinite(bad) || warn < 1 || bad > 100 || warn >= bad) {
          setSettingsError(L.setInvalid)
          return
        }
        const next = { warn: Math.round(warn), bad: Math.round(bad) }
        setThresholds(next)
        try { localStorage.setItem(THRESHOLD_KEY, JSON.stringify(next)) } catch { /* storage may be denied */ }
        setSettingsOpen(false)
      }
      const resetSettings = () => {
        setThresholds({ ...DEFAULT_THRESHOLDS })
        try { localStorage.removeItem(THRESHOLD_KEY) } catch { /* ignore */ }
        setSettingsOpen(false)
      }

      const summaryData = summary.state.status === 'ready' ? summary.state.data : undefined
      const mode = summaryData?.mode === 'deepseek' ? 'deepseek' : 'go'
      const usage = plan.state.status === 'ready' ? plan.state.data?.usage : undefined
      const pending = summaryData?.pending === true
      const ds = mode === 'deepseek' ? summaryData : undefined
      const go = summaryData?.go

      const worst = usage ? Math.max(...WINDOWS.map((key) => (usage[key] ? usage[key].percent : 0))) : 0
      const balance = ds?.deepseek?.balance
      const balanceOk = balance && balance.ok === true && Number.isFinite(balance.total)
      const balanceLow = balanceOk && balance.total < 1

      // Pill content follows the current channel.
      const pillChildren = [h('span', { key: 'dot', className: 'ogu-dot' + (
        mode === 'deepseek'
          ? (balanceLow ? ' bad' : balanceOk ? (balance.total < 10 ? ' warn' : '') : ' off')
          : (plan.state.status === 'ready' ? ` ${pctClass(worst)}` : ' off')
      ) }), h('span', { key: 'brand', className: 'ogu-brand', children: mode === 'deepseek' ? L.pillDs : L.pillGo })]

      if (mode === 'deepseek') {
        pillChildren.push(h('span', {
          key: 'bal',
          className: 'ogu-chip',
          title: L.titleDs,
          children: balanceOk ? `¥${fmtMoney(balance.total, 2)}` : '—',
        }))
      } else {
        for (const key of WINDOWS) {
          const window_ = usage?.[key]
          if (!window_) continue
          if (pillChildren.length > 2) pillChildren.push(h('span', { key: `${key}-sep`, className: 'ogu-sep', children: '·' }))
          pillChildren.push(h('span', {
            key,
            className: `ogu-chip ${pctClass(window_.percent)}`.trim(),
            title: `${L.long[key]} ${Math.round(window_.percent)}%`,
            children: `${L.short[key]} ${Math.round(window_.percent)}%`,
          }))
        }
      }

      // A historical session's first fold is queued; poll briefly so the row
      // turns from 统计中… into numbers without waiting for the 60s tick.
      react.useEffect(() => {
        if (!open || !pending) return undefined
        let tries = 0
        let stopped = false
        const timer = Number(setInterval(() => {
          if (stopped) return
          tries += 1
          if (tries > 15) { clearInterval(timer); return }
          void summary.read(false)
        }, 2000))
        return () => { stopped = true; clearInterval(timer) }
      }, [open, pending, summary.read])

      const pill = h('button', {
        ref: pillRef,
        type: 'button',
        className: 'ogu-pill',
        'data-open': open ? '1' : '0',
        'aria-expanded': open,
        'aria-haspopup': 'dialog',
        title: mode === 'deepseek'
          ? `${L.titleDs}${balanceOk ? ` ¥${fmtMoney(balance.total, 2)}` : ''}`
          : L.titleGo,
        onClick: () => setOpen((previous) => !previous),
      }, pillChildren)

      const rows = []

      if (mode === 'deepseek' && ds) {
        const tokens = ds.deepseek?.tokens ?? {}
        const cost = ds.deepseek?.cost ?? {}
        const calls = ds.deepseek?.calls ?? 0
        rows.push(h('div', { key: 'ds-head', className: 'ogu-ds-head' }, [
          h('span', { key: 'name', children: L.titleDs }),
          h('span', {
            key: 'auth',
            className: 'ogu-ds-auth',
            title: ds.route?.provider ?? '',
            children: ds.auth === 'account' ? L.dsAcc : L.dsApi,
          }),
          h('span', {
            key: 'model',
            className: 'ogu-ds-model',
            title: `${ds.route?.model ?? ''} · ${calls} ${L.calls}`,
            children: `${ds.route?.model ?? ''} · ${calls} ${L.calls}`,
          }),
        ]))
        rows.push(h('div', { key: 'ds-in', className: 'ogu-ds-row' }, [
          h('span', { key: 'k', className: 'ogu-ds-k', children: L.dsInput }),
          h('span', { key: 'v', className: 'ogu-ds-v', children: fmtTokens(tokens.uncachedInput) }),
        ]))
        rows.push(h('div', { key: 'ds-cache', className: 'ogu-ds-row' }, [
          h('span', { key: 'k', className: 'ogu-ds-k', children: L.dsCache }),
          h('span', { key: 'v', className: 'ogu-ds-v', children: fmtTokens(tokens.cacheRead) }),
        ]))
        rows.push(h('div', { key: 'ds-out', className: 'ogu-ds-row' }, [
          h('span', { key: 'k', className: 'ogu-ds-k', children: L.dsOutput }),
          h('span', { key: 'v', className: 'ogu-ds-v', children: fmtTokens(tokens.output) }),
        ]))
        rows.push(h('div', { key: 'ds-cost', className: 'ogu-ds-row', title: L.dsCostHint }, [
          h('span', { key: 'k', className: 'ogu-ds-k', children: L.dsCost }),
          h('span', { key: 'v', className: 'ogu-ds-v', children: `¥${fmtMoney(cost.total)}` }),
        ]))
        rows.push(h('div', { key: 'ds-bal', className: `ogu-ds-row ogu-bal${balanceLow ? ' low' : ''}` }, [
          h('span', { key: 'k', className: 'ogu-ds-k', children: L.dsBalance }),
          h('span', {
            key: 'v',
            className: 'ogu-ds-v',
            children: balanceOk ? `¥${fmtMoney(balance.total, 2)}` : L.dsUnavailable,
          }),
        ]))
      } else {
        // OpenCode Go block: this session's Go-only tokens first, then the plan windows.
        const goTokens = go?.tokens?.total ?? 0
        const goCalls = go?.calls ?? 0
        rows.push(h('div', { key: 'go-session', className: 'ogu-ds-row ogu-sum' }, [
          h('span', { key: 'k', className: 'ogu-ds-k', children: L.session }),
          h('span', {
            key: 'v',
            className: 'ogu-ds-v',
            children: pending ? L.pending : `${fmtTokens(goTokens)} ${L.tok} · ${goCalls} ${L.calls}`,
          }),
        ]))
        if (plan.state.status === 'loading') {
          rows.push(h('div', { key: 'loading', className: 'ogu-reset', style: { paddingLeft: 0 }, children: L.loading }))
        } else if (plan.state.status === 'error') {
          rows.push(h('div', { key: 'err', className: 'ogu-err' }, [
            `${L.error} `,
            h('button', { key: 'retry', type: 'button', className: 'ogu-btn', onClick: () => void plan.read(true), children: L.retry }),
          ]))
        } else {
          for (const key of WINDOWS) {
            const window_ = usage?.[key]
            if (!window_) continue
            rows.push(h('div', { key, className: 'ogu-row' }, [
              h('span', { key: 'k', className: 'ogu-k', children: L.long[key] }),
              h('span', { key: 'bar', className: 'ogu-bar' }, [
                h('span', {
                  key: 'fill',
                  className: `ogu-fill ${pctClass(window_.percent)}`.trim(),
                  style: { width: `${Math.min(100, Math.max(0, window_.percent))}%` },
                }),
              ]),
              h('span', { key: 'p', className: 'ogu-p', children: `${Math.round(window_.percent)}%` }),
            ]))
            rows.push(h('div', { key: `${key}-reset`, className: 'ogu-reset', children: `${L.long[key]} ${L.reset} ${fmtReset(window_.resetsAt)}` }))
          }
        }
      }

      const panel = open
        ? h(Panel, { anchor: pillRef.current, onClose: () => setOpen(false) }, [
            h('div', { key: 'head', className: 'ogu-pop-head' }, [
              h('span', { key: 'dot', className: `ogu-dot${plan.state.status === 'ready' && mode !== 'deepseek' ? ` ${pctClass(worst)}` : ''}` }),
              h('span', { key: 'title', className: 'ogu-pop-title', children: mode === 'deepseek' ? L.titleDs : L.titleGo }),
              h('button', {
                key: 'refresh', type: 'button', className: 'ogu-btn', title: L.refresh,
                onClick: (event) => {
                  event.stopPropagation()
                  void plan.read(true)
                  void summary.read(true)
                },
                children: '↻',
              }),
              h('button', {
                key: 'settings', type: 'button', className: 'ogu-btn', title: L.setTitle,
                'data-role': 'settings',
                onClick: (event) => {
                  event.stopPropagation()
                  if (settingsOpen) setSettingsOpen(false)
                  else openSettings()
                },
                children: '⚙',
              }),
              h('button', {
                key: 'close', type: 'button', className: 'ogu-btn', title: L.close,
                onClick: (event) => { event.stopPropagation(); setOpen(false) }, children: '×',
              }),
            ]),
            ...rows,
            settingsOpen ? h('div', { key: 'settings', className: 'ogu-set' }, [
              h('div', { key: 'legend', className: 'ogu-set-legend' }, [
                h('span', { key: 'g' }, [h('span', { key: 's', className: 'ogu-swatch g' }), `0–${thresholds.warn}%`]),
                h('span', { key: 'o' }, [h('span', { key: 's', className: 'ogu-swatch o' }), `${thresholds.warn}–${thresholds.bad}%`]),
                h('span', { key: 'b' }, [h('span', { key: 's', className: 'ogu-swatch b' }), `${thresholds.bad}–100%`]),
              ]),
              h('label', { key: 'warn', className: 'ogu-set-row' }, [
                h('span', { key: 'k', className: 'ogu-set-k', children: L.setWarn }),
                h('input', {
                  key: 'i', className: 'ogu-set-input', type: 'number', min: 1, max: 100, step: 1,
                  value: draftWarn, 'data-role': 'warn',
                  onChange: (event) => setDraftWarn(event.target.value),
                }),
              ]),
              h('label', { key: 'bad', className: 'ogu-set-row' }, [
                h('span', { key: 'k', className: 'ogu-set-k', children: L.setBad }),
                h('input', {
                  key: 'i', className: 'ogu-set-input', type: 'number', min: 1, max: 100, step: 1,
                  value: draftBad, 'data-role': 'bad',
                  onChange: (event) => setDraftBad(event.target.value),
                }),
              ]),
              settingsError ? h('div', { key: 'err', className: 'ogu-err', children: settingsError }) : null,
              h('div', { key: 'actions', className: 'ogu-set-actions' }, [
                h('button', { key: 'reset', type: 'button', className: 'ogu-set-btn', 'data-role': 'reset', onClick: resetSettings, children: L.setReset }),
                h('button', { key: 'cancel', type: 'button', className: 'ogu-set-btn', onClick: () => setSettingsOpen(false), children: L.setCancel }),
                h('button', { key: 'save', type: 'button', className: 'ogu-set-btn primary', 'data-role': 'save', onClick: saveSettings, children: L.setSave }),
              ]),
              h('div', { key: 'hint', className: 'ogu-set-hint', children: L.setHint }),
            ]) : null,
            h('div', { key: 'foot', className: 'ogu-foot', children: mode === 'deepseek' ? L.tipDs : L.tipGo }),
          ])
        : null

      return h(react.Fragment, null, pill, panel)
    }

    function apply(ctx) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-usage-summary'
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { style.remove() }, 'usage-summary: styles')
      // Left of the chat statistics pills ("N 轮 M 步 · tok/s"), which carry
      // orders 0 and 1 in this list slot.
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'usage-summary',
        order: -10,
        inject: () => ({}),
      }, UsagePill))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
