/**
 * dsh-peak-guard · 峰谷时段判定与话术（纯逻辑，零依赖，可脱离 DSH 直接测）
 *
 * 判定「高峰」的口径与 dsh-cost-meter 的峰谷计价**一致**（那个插件的窗口来自
 * DeepSeek 控制台公告并已随官方页面同步）：
 *   · 高峰窗口：Asia/Shanghai 本地 09:00–12:00、14:00–18:00（半开区间 [start, end)）
 *   · 本地周六 / 周日全天谷价
 *   · 国务院办公厅 2026 年安排的公众假期全天谷价
 * 高峰时段官方按谷价的 2 倍计价 —— 这正是这个插件拦人的理由。
 *
 * 本文件刻意不 import 任何模块，也不碰 DSH：任何一行都能被 node 直接跑。
 */

/** 插件身份（日志前缀 / 错误信息用）。 */
export const PLUGIN_NAME = 'dsh-peak-guard'

/** 高峰期的彩蛋话术（`tone: 'joke'` 时用它）。 */
export const JOKE = '现在是梁文峰时间，你马内不要了？胆子真是肥嘟嘟的'

/** 高峰期的默认提示语（正经版，`tone: 'polite'`）。 */
export const POLITE = '⛔ 高峰时段暂停模型调用（本次未产生费用）'

/** 两套内置话术。配置里显式写了 `message` 时优先于这两套。 */
export const MESSAGE_PRESETS = Object.freeze({ polite: POLITE, joke: JOKE })

/** 默认高峰窗口（本地钟点，半开区间）。 */
export const DEFAULT_PEAK_WINDOWS = ['09:00-12:00', '14:00-18:00']

/**
 * 默认法定假期（本地日历日，全天谷价）。
 * 与 dsh-cost-meter 的 DEFAULT_PEAK_HOLIDAYS 逐项相同；每年国务院安排公布后需要更新。
 */
export const DEFAULT_HOLIDAYS = [
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]

/** 默认配置。config 里没写的键一律取这里。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  timeZone: 'Asia/Shanghai',
  peakWindows: DEFAULT_PEAK_WINDOWS,
  weekendsOffPeak: true,
  holidays: DEFAULT_HOLIDAYS,
  // 话术：tone 选内置那两套之一；message 显式写了就盖过 tone。
  tone: 'polite',
  message: undefined,
  hint: true,
  blockUtilityCalls: false,
  allowSessions: [],
  snoozeMinutes: 30,
  // 被拦截列表：高峰期间被拦下的对话请求会记一笔，界面上**只展示、不做任何动作**。
  /** 最多记多少条（1–200）。 */
  blockedLimit: 50,
  /** 记录最大存活分钟数，超过就丢弃（默认 12 小时）。 */
  blockedMaxAgeMinutes: 720,
  /** 开关状态的落盘位置。不写 = 自动用 <DSH_HOME>/plugin-data/dsh-peak-guard/state.json；
   * 显式写空字符串 '' = 不落盘（只在内存里，重启回到配置口径）。 */
  statePath: undefined,
})

/** 环境的硬开关取值：这些值出现时插件整体闭嘴（逃生门 #1，重启前无需改配置）。 */
export const ENV_KILL_VALUES = ['0', 'off', 'false', 'no', 'disable', 'disabled']

const WEEKDAY_NAMES = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

// ── 时间解析 ────────────────────────────────────────────────────────────────

/**
 * 解析 `HH:MM` 为当天分钟数。`24:00` 合法（= 1440，表示当天结束）。
 * @param {unknown} text - 待解析文本。
 * @returns {number | undefined} 0–1440；非法返回 undefined。
 */
export function parseTimeOfDay(text) {
  if (typeof text !== 'string') return undefined
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text)
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined
  if (hour === 24 && minute === 0) return 24 * 60
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return hour * 60 + minute
}

/**
 * 解析一个窗口 `HH:MM-HH:MM`（本地钟点，半开区间，允许跨午夜）。
 * `start === end` 视为全天。
 * @param {unknown} text - 待解析文本。
 * @returns {{start: number, end: number, text: string} | undefined}
 */
export function parseWindow(text) {
  if (typeof text !== 'string') return undefined
  const parts = text.split('-')
  if (parts.length !== 2) return undefined
  const start = parseTimeOfDay(parts[0])
  const end = parseTimeOfDay(parts[1])
  if (start === undefined || end === undefined) return undefined
  return { start, end, text: `${text}`.trim() }
}

/** 把 `YYYY-MM-DD` 或 `YYYY-MM-DD..YYYY-MM-DD` 展开成日历日字符串数组（上限 400 天）。 */
function expandDateEntry(entry) {
  if (typeof entry !== 'string') return undefined
  const single = /^\d{4}-\d{2}-\d{2}$/
  const range = /^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/
  if (single.test(entry)) return [entry]
  const match = range.exec(entry)
  if (match === null) return undefined
  const start = Date.parse(`${match[1]}T00:00:00Z`)
  const end = Date.parse(`${match[2]}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  const days = Math.round((end - start) / 86_400_000) + 1
  if (days > 400) return undefined
  const out = []
  for (let i = 0; i < days; i += 1) out.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10))
  return out
}

// ── 配置归一化 ──────────────────────────────────────────────────────────────

/**
 * 把任意（可能来自 YAML 的、可能被手写坏的）config 归一化成可信配置。
 * **永不抛错**：坏值退回默认值并留下 warning —— 一个话痨插件不该让 DSH 起不来。
 * @param {unknown} raw - 原始 config。
 * @returns {{config: object, warnings: string[]}}
 */
export function normalizeConfig(raw) {
  const warnings = []
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push('config 不是对象，已整体忽略')
  }
  const known = new Set(Object.keys(DEFAULT_CONFIG))
  for (const key of Object.keys(source)) {
    if (!known.has(key)) warnings.push(`不认识的配置键 "${key}"，已忽略`)
  }

  const bool = (key) => {
    const value = source[key]
    if (value === undefined) return DEFAULT_CONFIG[key]
    if (typeof value === 'boolean') return value
    warnings.push(`"${key}" 需要布尔值，收到 ${JSON.stringify(value)}，已用默认值 ${DEFAULT_CONFIG[key]}`)
    return DEFAULT_CONFIG[key]
  }

  const number = (key, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) => {
    const value = source[key]
    if (value === undefined) return DEFAULT_CONFIG[key]
    const ok = typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))
    if (ok) return value
    warnings.push(`"${key}" 需要 ${min}–${max} 的${integer ? '整数' : '数字'}，收到 ${JSON.stringify(value)}，已用默认值 ${DEFAULT_CONFIG[key]}`)
    return DEFAULT_CONFIG[key]
  }

  const config = { ...DEFAULT_CONFIG }
  // 对外默认值是可读字符串；内部一律用解析后的 {start,end,text}。
  const defaultWindows = DEFAULT_PEAK_WINDOWS.map((text) => parseWindow(text))
  config.peakWindows = defaultWindows

  config.enabled = bool('enabled')
  config.hint = bool('hint')
  config.blockUtilityCalls = bool('blockUtilityCalls')
  config.weekendsOffPeak = bool('weekendsOffPeak')

  // 时区：能被 Intl 认下来才收。
  if (source.timeZone !== undefined) {
    if (typeof source.timeZone === 'string' && isValidTimeZone(source.timeZone)) config.timeZone = source.timeZone
    else warnings.push(`"timeZone" 不是合法 IANA 时区（${JSON.stringify(source.timeZone)}），已用 ${DEFAULT_CONFIG.timeZone}`)
  }

  // 高峰窗口。`[]` 是合法输入，表示「从不拦截」。
  if (source.peakWindows !== undefined) {
    if (!Array.isArray(source.peakWindows)) {
      warnings.push('"peakWindows" 需要字符串数组，已用默认窗口')
    } else {
      const parsed = []
      let bad = 0
      for (const entry of source.peakWindows) {
        const window = parseWindow(entry)
        if (window === undefined) bad += 1
        else parsed.push(window)
      }
      if (bad > 0) warnings.push(`"peakWindows" 里有 ${bad} 项不是 "HH:MM-HH:MM"，已丢弃`)
      if (parsed.length === 0 && source.peakWindows.length > 0) {
        warnings.push('"peakWindows" 全部非法，已退回默认窗口（想要「从不拦截」请显式传空数组 []）')
      } else {
        config.peakWindows = parsed
      }
    }
  }

  // 假期。
  if (source.holidays !== undefined) {
    if (!Array.isArray(source.holidays)) {
      warnings.push('"holidays" 需要字符串数组，已用默认假期')
      config.holidays = [...DEFAULT_HOLIDAYS]
    } else {
      const dates = []
      let bad = 0
      for (const entry of source.holidays) {
        const expanded = expandDateEntry(entry)
        if (expanded === undefined) bad += 1
        else dates.push(...expanded)
      }
      if (bad > 0) warnings.push(`"holidays" 里有 ${bad} 项不是 YYYY-MM-DD（或 A..B），已丢弃`)
      config.holidays = dates
    }
  } else {
    config.holidays = [...DEFAULT_HOLIDAYS]
  }

  // 话术：tone 选内置预设，message 显式写了就盖过它。
  if (source.tone !== undefined) {
    if (typeof source.tone === 'string' && Object.hasOwn(MESSAGE_PRESETS, source.tone)) config.tone = source.tone
    else warnings.push(`"tone" 只能是 ${Object.keys(MESSAGE_PRESETS).join(' / ')}，已用默认值 ${DEFAULT_CONFIG.tone}`)
  }
  if (source.message !== undefined) {
    if (typeof source.message === 'string' && source.message.trim().length > 0) config.message = source.message
    else warnings.push('"message" 需要非空字符串（不写就用 tone 预设），已忽略')
  }

  // 被拦截列表。
  config.blockedLimit = number('blockedLimit', { min: 1, max: 200, integer: true })
  config.blockedMaxAgeMinutes = number('blockedMaxAgeMinutes', { min: 0, max: 60 * 24 * 30 })

  // 白名单会话。坏项丢掉、好项留下（一项写坏不该让整张白名单失效）。
  if (source.allowSessions !== undefined) {
    if (!Array.isArray(source.allowSessions)) {
      warnings.push('"allowSessions" 需要字符串数组，已忽略')
    } else {
      const ids = source.allowSessions.filter((id) => typeof id === 'string')
      if (ids.length !== source.allowSessions.length) warnings.push(`"allowSessions" 里有 ${source.allowSessions.length - ids.length} 项不是字符串，已丢弃`)
      config.allowSessions = ids
    }
  }

  // 放行分钟数。
  if (source.snoozeMinutes !== undefined) {
    const value = source.snoozeMinutes
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) config.snoozeMinutes = value
    else warnings.push(`"snoozeMinutes" 需要 ≥0 的数字，已用默认值 ${DEFAULT_CONFIG.snoozeMinutes}`)
  }

  // 开关状态落盘位置（空字符串 = 明确不落盘）。
  if (source.statePath !== undefined && source.statePath !== null) {
    if (typeof source.statePath === 'string') config.statePath = source.statePath
    else warnings.push('"statePath" 需要字符串（空字符串表示不落盘），已忽略')
  }
  // DEFAULT_CONFIG 里这个键是显式 undefined，别让它进 known 之外的告警路径。

  return { config, warnings }
}

/** Intl 认不认这个时区。 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim().length === 0) return false
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone })
    return true
  } catch {
    return false
  }
}

// ── 本地钟点 ────────────────────────────────────────────────────────────────

const formatterCache = new Map()
const partsCache = new Map()
const PARTS_CACHE_LIMIT = 8192

function partsFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    formatterCache.set(timeZone, formatter)
  }
  return formatter
}

/**
 * 某一时刻在指定时区的墙上钟点。
 * @param {number} atMs - epoch ms。
 * @param {string} timeZone - IANA 时区。
 * @returns {{dateKey: string, weekday: number, hour: number, minute: number, minutes: number}}
 */
export function localParts(atMs, timeZone) {
  const cacheKey = `${timeZone}|${Math.floor(atMs / MINUTE_MS)}`
  const cached = partsCache.get(cacheKey)
  if (cached !== undefined) return cached

  let parts
  try {
    parts = partsFormatter(timeZone).formatToParts(new Date(atMs))
  } catch {
    // Intl 抽风时退回 UTC+8 手算（Asia/Shanghai 无夏令时，永远正确）。
    parts = partsFormatter('Asia/Shanghai').formatToParts(new Date(atMs + 8 * HOUR_MS))
  }
  const pick = (type) => parts.find((part) => part.type === type)?.value
  const hour = Number(pick('hour'))
  const minute = Number(pick('minute'))
  const partsValue = Object.freeze({
    dateKey: `${pick('year')}-${pick('month')}-${pick('day')}`,
    weekday: WEEKDAY_NAMES[pick('weekday')] ?? new Date(atMs).getUTCDay(),
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
    minutes: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
  })
  if (partsCache.size >= PARTS_CACHE_LIMIT) partsCache.clear()
  partsCache.set(cacheKey, partsValue)
  return partsValue
}

/** 分钟数是否落在窗口内（半开区间，支持跨午夜与全天）。 */
function insideWindow(minuteOfDay, window) {
  if (window.start === window.end) return true
  if (window.start < window.end) return minuteOfDay >= window.start && minuteOfDay < window.end
  return minuteOfDay >= window.start || minuteOfDay < window.end
}

/**
 * 这一时刻是不是高峰（= 该被拦）。
 *
 * **纯时间问题**：只看窗口、周末、假期，**不看开关**。要不要因此拦下一次调用是调用方的
 * 策略（宿主半边用 effectiveEnabled() 决定）。这样界面开关才能覆盖 config.enabled，
 * 而相位显示不会跟着失真。
 * @param {number} atMs - epoch ms。
 * @param {object} config - 归一化后的配置（或任何带 peakWindows/timeZone 的对象）。
 * @returns {boolean}
 */
export function isPeak(atMs, config) {
  const raw = Array.isArray(config?.peakWindows) ? config.peakWindows : []
  if (raw.length === 0) return false
  if (!Number.isFinite(atMs)) return false

  // 容忍没经过 normalizeConfig 的调用方（字符串窗口也能用），绝不因此抛错。
  const windows = []
  for (const entry of raw) {
    const window = typeof entry === 'string' ? parseWindow(entry) : entry
    if (window !== undefined && window !== null && Number.isFinite(window.start) && Number.isFinite(window.end)) windows.push(window)
  }
  if (windows.length === 0) return false

  const local = localParts(atMs, config.timeZone)
  if (config.weekendsOffPeak === true && (local.weekday === 0 || local.weekday === 6)) return false
  if (Array.isArray(config.holidays) && config.holidays.includes(local.dateKey)) return false
  return windows.some((window) => insideWindow(local.minutes, window))
}

/**
 * 下一个「高峰 ⇄ 谷时」切换点。
 *
 * 实现：先按小时粗扫（最多 45 天）找到状态变化的那个小时，再在小时内按分钟精确定位。
 * 默认窗口都是小时级、间隔 ≥3 小时，因此不会漏掉任何切换；差分测试会拿
 * dsh-cost-meter 的 peakPhaseAt 逐个采样点核对。
 * @param {number} atMs - epoch ms。
 * @param {object} config - 归一化后的配置。
 * @returns {{atMs: number, intoPeak: boolean} | undefined} 找不到（例如全天高峰）返回 undefined。
 */
export function nextTransition(atMs, config) {
  if (!Number.isFinite(atMs)) return undefined
  const current = isPeak(atMs, config)
  let cursor = atMs
  for (let hour = 0; hour < 45 * 24; hour += 1) {
    const next = cursor + HOUR_MS
    if (isPeak(next, config) === current) {
      cursor = next
      continue
    }
    for (let probe = cursor + MINUTE_MS; probe <= next; probe += MINUTE_MS) {
      const value = isPeak(probe, config)
      if (value !== current) return { atMs: probe, intoPeak: value }
    }
    cursor = next
  }
  return undefined
}

/** 人类可读的剩余时长（向上取整：倒计时里「还有 0 分」比多算一分钟更糟）。 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / MINUTE_MS))
  const days = Math.floor(total / (24 * 60))
  const hours = Math.floor((total % (24 * 60)) / 60)
  const minutes = total % 60
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  return `${minutes} 分`
}

/** 本地 `HH:MM`。 */
export function formatClock(atMs, timeZone) {
  const local = localParts(atMs, timeZone)
  return `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`
}

/** 本地 `YYYY-MM-DD HH:MM`。 */
export function formatStamp(atMs, timeZone) {
  const local = localParts(atMs, timeZone)
  return `${local.dateKey} ${formatClock(atMs, timeZone)}`
}

/** 时区的中文说明（只在话术里用）。 */
export function describeZone(timeZone) {
  return timeZone === 'Asia/Shanghai' ? '北京时间' : timeZone
}

/** 窗口列表的可读形式：`09:00–12:00、14:00–18:00`。 */
export function describeWindows(config) {
  const windows = Array.isArray(config.peakWindows) ? config.peakWindows : []
  if (windows.length === 0) return '（未配置 → 从不拦截）'
  return windows
    .map((window) => `${minutesToClock(window.start)}–${minutesToClock(window.end)}`)
    .join('、')
}

function minutesToClock(minutes) {
  const hour = Math.floor(minutes / 60)
  return `${String(hour).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

// ── 用户可见文本 ────────────────────────────────────────────────────────────

/** 当前配置该用哪句提示语：显式 `message` > `tone` 预设 > 正经版。 */
export function resolveMessage(config) {
  if (typeof config?.message === 'string' && config.message.trim().length > 0) return config.message
  const tone = typeof config?.tone === 'string' ? config.tone : DEFAULT_CONFIG.tone
  return MESSAGE_PRESETS[tone] ?? POLITE
}

/** 当前用的是哪套话术（`custom` / `polite` / `joke`）。 */
export function resolveTone(config) {
  if (typeof config?.message === 'string' && config.message.trim().length > 0) return 'custom'
  const tone = typeof config?.tone === 'string' ? config.tone : DEFAULT_CONFIG.tone
  return Object.hasOwn(MESSAGE_PRESETS, tone) ? tone : DEFAULT_CONFIG.tone
}

/**
 * 拦截时甩给用户的话术：第一行是按 tone 选定的那句话，`hint` 打开时再补几行可操作信息。
 * @param {object} config - 归一化后的配置。
 * @param {number} atMs - epoch ms。
 * @param {{forced?: boolean}} [options] - `forced` 表示这次是 `/peak force` 手动拦的，不是真高峰。
 * @returns {string}
 */
export function buildMessage(config, atMs, options = {}) {
  const head = resolveMessage(config)
  if (config.hint !== true) return head

  const tone = resolveTone(config)
  const polite = tone === 'polite'
  const zone = describeZone(config.timeZone)
  const next = nextTransition(atMs, config)
  const lines = []

  if (options.forced === true) {
    lines.push(polite
      ? `— 手动强制拦截中（/peak force）：本次模型调用已被 ${PLUGIN_NAME} 拦下，没有产生费用。`
      : `— 手动强制拦截中（/peak force），模型调用已被 ${PLUGIN_NAME} 拦下。`)
    lines.push(polite
      ? (isPeak(atMs, config) ? '现在本来也是高峰，不收手的话照样会拦。' : '现在是谷时，这次是你自己要求拦的。')
      : (isPeak(atMs, config)
        ? '现在本来也是高峰，不收手的话照样会拦。'
        : `现在是谷时${next === undefined ? '' : `（下一段高峰 ${formatClock(next.atMs, config.timeZone)} 开始）`}，这次是你自己要求拦的。`))
  } else {
    lines.push(polite
      ? `— 现在是 DeepSeek 高峰计价时段（${zone} ${describeWindows(config)}），高峰单价约为谷时的 2 倍；本次调用没有产生费用。`
      : `— ${zone}高峰计价中，模型调用已被 ${PLUGIN_NAME} 拦下（高峰按谷价 2 倍计费）。`)
    if (next !== undefined) {
      if (next.intoPeak) {
        lines.push(polite
          ? `下一段高峰 ${formatClock(next.atMs, config.timeZone)} 开始（${formatDuration(next.atMs - atMs)} 后），那之前都可以正常调用。`
          : `下一段高峰 ${formatClock(next.atMs, config.timeZone)} 开始（${formatDuration(next.atMs - atMs)} 后）。`)
      } else {
        lines.push(polite
          ? `谷时 ${formatClock(next.atMs, config.timeZone)} 开始（还有 ${formatDuration(next.atMs - atMs)}），届时再发即可。`
          : `谷时 ${formatClock(next.atMs, config.timeZone)} 开始，还有 ${formatDuration(next.atMs - atMs)}，那时候再问便宜一半。`)
      }
    }
  }

  lines.push(polite
    ? '需要现在继续：`/peak off 30`（放行 30 分钟） · 查看状态：`/peak status`'
    : '真要烧钱：发 `/peak off 30` 放行 30 分钟；`/peak status` 看状态。')
  return `${head}\n\n${lines.join('\n')}`
}

/**
 * `/peak status` 的文本。
 * @param {object} config - 归一化后的配置。
 * @param {{blockedCount: number, lastBlockAtMs: number | undefined, overrideUntilMs: number | undefined, hardOff: boolean}} state - 运行时状态。
 * @param {number} atMs - epoch ms。
 * @returns {string}
 */
export function statusText(config, state, atMs) {
  const zone = describeZone(config.timeZone)
  const peak = isPeak(atMs, config)
  const next = nextTransition(atMs, config)
  // 开关的有效值优先取 state.enabled（界面开关/命令设过），否则跟随配置默认值。
  const enabled = typeof state?.enabled === 'boolean' ? state.enabled : config.enabled === true
  const switchSource = state?.enabledSource === 'switch' ? '（开关设定）' : '（跟随配置）'
  const lines = []
  lines.push(`${PLUGIN_NAME} · 高峰保护${enabled ? '已开启' : '已关闭'}${switchSource}`)
  lines.push(`现在 ${formatStamp(atMs, config.timeZone)}(${zone})，处于${peak ? '**高峰**' : '谷时'}${enabled ? (peak ? '，模型调用会被拦下' : '，模型调用放行') : '（开关关着，一律放行）'}`)
  lines.push(`高峰窗口：${describeWindows(config)}${config.weekendsOffPeak ? '；周末全天谷价' : ''}${Array.isArray(config.holidays) && config.holidays.length > 0 ? `；${config.holidays.length} 天法定假期全天谷价` : ''}`)
  if (next !== undefined) {
    lines.push(`下一段${next.intoPeak ? '高峰' : '谷时'}：${formatStamp(next.atMs, config.timeZone)}（${formatDuration(next.atMs - atMs)} 后）`)
  }
  if (state.hardOff) lines.push('逃生门：环境变量 DSH_PEAK_GUARD 关掉了本插件（重启前一直有效）')
  if (typeof state.overrideUntilMs === 'number' && state.overrideUntilMs > atMs) {
    const rest = state.overrideUntilMs === Number.POSITIVE_INFINITY ? '无限期' : `${formatDuration(state.overrideUntilMs - atMs)}`
    lines.push(`临时放行中：还剩 ${rest}（\`/peak on\` 立即恢复拦截）`)
  }
  if (typeof state.forceUntilMs === 'number' && state.forceUntilMs > atMs) {
    lines.push(`强制拦截中（无视峰谷）：还剩 ${formatDuration(state.forceUntilMs - atMs)}（\`/peak on\` 收回）`)
  }
  if (Array.isArray(config.allowSessions) && config.allowSessions.length > 0) {
    lines.push(`白名单会话：${config.allowSessions.length} 个（这些会话永远不拦）`)
  }
  lines.push(state.blockedCount > 0
    ? `本次运行已拦下 ${state.blockedCount} 次模型调用，最近一次 ${state.lastBlockAtMs === undefined ? '—' : formatStamp(state.lastBlockAtMs, config.timeZone)}`
    : '本次运行还没拦过任何模型调用')
  const tone = resolveTone(config)
  lines.push(`拦截话术：${tone === 'polite' ? '正经版' : tone === 'joke' ? '彩蛋版' : '自定义（config.message）'}`)
  const listCount = Number.isFinite(state.listCount) ? state.listCount : Array.isArray(state.list) ? state.list.length : 0
  if (listCount > 0) {
    const newest = Array.isArray(state.list) && state.list.length > 0 ? state.list[0] : undefined
    lines.push(`被拦截列表：${listCount} 条${newest === undefined ? '' : `，最近一条 ${formatStamp(newest.atMs, config.timeZone)}`}（\`/peak list\` 看列表；只记录，不重投）`)
  }
  lines.push('用法：`/peak` · `/peak on|off [分钟|forever]` · `/peak enable|disable` · `/peak test` · `/peak force [分钟]` · `/peak list`')
  return lines.join('\n')
}

/** `/peak` 的帮助文本。 */
export function helpText() {
  return [
    `${PLUGIN_NAME}：高峰时段拦下模型调用，并替模型回你一句说明。`,
    '',
    '`/peak` 或 `/peak status` —— 看当前峰谷状态、窗口、拦截计数与被拦截列表',
    '`/peak test` —— 不下发请求，先看看提示语长什么样',
    '`/peak force [分钟]` —— 无视峰谷，强制拦一段时间（默认 5 分钟，用来现场验收）',
    '`/peak enable|disable` —— 高峰保护总开关（和输入框左边那个开关是同一个状态，会落盘）',
    `\`/peak off [分钟|forever]\` —— 临时放行（默认 ${DEFAULT_CONFIG.snoozeMinutes} 分钟；forever = 放行到重启）`,
    '`/peak on` —— 立刻恢复拦截（同时收回 force / off）',
    '`/peak list` —— 列出高峰期间被拦下的请求（只是记录，插件不会替它们重投）',
    '',
    '配置在 profile 的 cordis.patch.yml 里（id: peak-guard）。',
    `提示语默认正经版；想要彩蛋版把 tone 设成 joke（原文：${JOKE}）。`,
    '环境变量 DSH_PEAK_GUARD=off 可以直接关掉整个插件（需要重启 DSH）。',
  ].join('\n')
}
