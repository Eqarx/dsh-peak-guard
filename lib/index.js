/**
 * dsh-peak-guard · 宿主半边
 *
 * 干的事只有一件：在 `llm/stream` 瀑布式事件上，高峰时段**不调用 `next()`**，
 * 也就是根本不会走到任何模型适配器，直接吐一段自己捏的分片流回去 —— 于是模型
 * 用用户原话回了他一句。谷时（周末/法定假期全天算谷）什么都不做，原样放行。
 *
 * 三条设计纪律：
 *   1. **fail-open**：拦截逻辑任何一步出错/看不懂，都退回 `next()`。插件坏了可以
 *      不干活，但绝不能把 DSH 的模型调用弄死。
 *   2. **apply 绝不抛错**：宿主半边加载失败会污染整棵插件树；这里整体 try/catch，
 *      最坏情况是插件静默不生效并在日志里留一句。
 *   3. **有逃生门**：环境变量（重启前有效）、`/peak off`（运行时）、`allowSessions`
 *      （配置）三条路，任何一种都能把用户从「高峰期被锁在门外」里捞出来。
 *
 * 分片协议按 @deepseek-ai/dsh-llm 的 `StreamChunk`：block-start → text-delta →
 * block-end → usage → finish({kind:'stop'})，且 usage 必须在 finish 之前。
 */

import {
  DEFAULT_CONFIG,
  ENV_KILL_VALUES,
  JOKE,
  PLUGIN_NAME,
  buildMessage,
  describeWindows,
  formatClock,
  formatStamp,
  helpText,
  isPeak,
  nextTransition,
  normalizeConfig,
  resolveTone,
  statusText,
} from './peak.js'
import { ROUTES, createRouteHandlers } from './http.js'
import { readState, resolveStatePath, writeState } from './store.js'
import { addItem, dropExpired, extractPreview, makeItem, setDone, setSkipped, summarize } from './blocked.js'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** DSH 加载器读这个（和 package.json 的 name 保持一致，日志里好认）。 */
export const name = PLUGIN_NAME

/**
 * 插件版本（设置页标题里显示）。读包里的 package.json；读不到就退回 'unknown'，
 * 绝不因为读个版本号把插件搞崩。
 */
export const VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

/** 输入框上方那张卡只要前几条；设置页要完整列表，会显式传更大的 limit。 */
const SNAPSHOT_LIST_LIMIT = 20
const SNAPSHOT_LIST_LIMIT_MAX = 200

/** 逃生门 #1：环境里出现这些值就整体闭嘴（重启前一直有效，改配置都来不及时用它）。 */
const KILL_ENV = 'DSH_PEAK_GUARD'

/** 造一个绝不抛错的 logger（cordis 的 logger 形态在不同版本里是函数或对象）。 */
function makeLogger(ctx) {
  const silent = { info() {}, warn() {} }
  try {
    const candidate = ctx?.logger
    const sink = typeof candidate === 'function' ? candidate(PLUGIN_NAME) : candidate
    const emit = (level, message) => {
      try {
        const target = sink?.[level]
        if (typeof target === 'function') target.call(sink, message)
        else if (level === 'warn') console.warn(`[${PLUGIN_NAME}] ${message}`)
        else console.info(`[${PLUGIN_NAME}] ${message}`)
      } catch {
        /* 连日志都不能抛 */
      }
    }
    return { info: (message) => emit('info', message), warn: (message) => emit('warn', message) }
  } catch {
    return silent
  }
}

/** 把 throw 出来的任何东西渲染成一行，别信它的 toString。 */
function renderError(error) {
  try {
    if (error instanceof Error) return `${error.name}: ${error.message}`
    return String(error)
  } catch {
    return '<unrenderable error>'
  }
}

/**
 * 捏一段「模型说了那句话」的分片流。
 * @param {string} text - 要说的内容。
 * @returns {AsyncIterable<object>} 合法且自洽的 StreamChunk 序列。
 */
export async function* blockedStream(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield {
    type: 'usage',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** 一句话描述被拦的调用，写日志用。 */
function describeCall(options) {
  try {
    const provider = typeof options?.provider === 'string' ? options.provider : '?'
    const model = typeof options?.model === 'string' ? options.model : '?'
    const purpose = typeof options?.purpose === 'string' ? `，purpose=${options.purpose}` : ''
    const sessionId = typeof options?.sessionId === 'string' ? `，session=${options.sessionId}` : ''
    return `${provider}/${model}${purpose}${sessionId}`
  } catch {
    return '<?>'
  }
}

/** 解析 `/peak off` 的参数：`undefined` = 用配置默认值，`Infinity` = 放行到重启。 */
function parseSnoozeArg(text, fallbackMinutes) {
  const value = text.trim()
  if (value.length === 0) return { minutes: fallbackMinutes }
  if (/^(forever|inf|infinity|∞|永久|一直)$/i.test(value)) return { minutes: Number.POSITIVE_INFINITY }
  const minutes = Number(value.replace(/分钟|分|min|m$/i, ''))
  if (!Number.isFinite(minutes) || minutes <= 0) return { error: `看不懂 "${value}"。用法：\`/peak off 30\` 或 \`/peak off forever\`` }
  return { minutes }
}

/**
 * 宿主半边入口。
 * @param {object} ctx - cordis 上下文（DSH 宿主）。
 * @param {unknown} rawConfig - 来自 cordis.patch.yml 的 config。
 */
export function apply(ctx, rawConfig) {
  const log = makeLogger(ctx)

  try {
    const { config, warnings } = normalizeConfig(rawConfig)
    for (const warning of warnings) log.warn(`配置：${warning}`)

    const hardOff = (() => {
      try {
        const value = typeof process?.env?.[KILL_ENV] === 'string' ? process.env[KILL_ENV].trim().toLowerCase() : ''
        return value.length > 0 && ENV_KILL_VALUES.includes(value)
      } catch {
        return false
      }
    })()

    const allowSet = new Set(Array.isArray(config.allowSessions) ? config.allowSessions : [])
    /**
     * 运行时状态。
     * 落盘的只有两样：`enabledOverride`（高峰保护开关）与 `list`（被拦截列表）；
     * 其余（snooze / force）重启即回到默认。
     */
    const state = {
      blockedCount: 0,
      lastBlockAtMs: undefined,
      overrideUntilMs: undefined,
      forceUntilMs: undefined,
      hardOff,
      enabledOverride: undefined,
      /** 被拦截列表（时间正序保存；给界面时倒序）。只记录，不重投。 */
      list: [],
      idSeq: 0,
    }

    // ── 开关的持久化：<DSH_HOME>/plugin-data/dsh-peak-guard/state.json ──────
    // 配置里显式给 statePath 就用它；给空字符串 = 不落盘（测试与临时会话用）。
    const statePath = config.statePath === undefined
      ? resolveStatePath()
      : (config.statePath === '' ? undefined : config.statePath)
    const persisted = readState(statePath)
    if (typeof persisted.enabled === 'boolean') state.enabledOverride = persisted.enabled
    if (Array.isArray(persisted.list)) state.list = persisted.list
    if (typeof persisted.dismissedAtMs === 'number') state.dismissedAtMs = persisted.dismissedAtMs
    // 老状态文件里只有 hideDone 布尔值：换算成「刚刚关过一次」
    else if (persisted.hideDone === true) state.dismissedAtMs = Date.now()
    const persist = () => {
      if (statePath === undefined) return false
      const ok = writeState(statePath, { enabled: state.enabledOverride, list: state.list, dismissedAtMs: state.dismissedAtMs })
      if (!ok) log.warn(`状态写不进 ${statePath}（不影响拦截，只是重启后会回到配置文件口径）`)
      return ok
    }

    /**
     * 把「这次加载干了什么」写到插件数据目录的 last-apply.json。
     *
     * 为什么值得永久保留：宿主模块是**启动时 import** 的，改了 lib/*.js 之后
     * 「到底生效没有」在界面上完全看不出来（路由 404、命令还在、日志看不到）。
     * 有这份文件，看一眼 mtime/内容就知道当前跑的是哪一版、路由/命令挂上没有。
     * 写失败一律忽略。
     * @param {object} extra - 追加的字段。
     */
    const trace = (extra) => {
      if (statePath === undefined) return
      try {
        const file = `${statePath.slice(0, Math.max(statePath.lastIndexOf('\\'), statePath.lastIndexOf('/')) + 1)}last-apply.json`
        const previous = (() => {
          try {
            return JSON.parse(readFileSync(file, 'utf8'))
          } catch {
            return {}
          }
        })()
        const next = { ...previous, ...extra, plugin: PLUGIN_NAME, pid: process.pid, at: new Date().toISOString() }
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
        renameSync(`${file}.tmp`, file)
      } catch {
        /* 排障件写不出来就算了 */
      }
    }

    /** 开关的有效值：界面/命令设过就用它，否则跟随配置。 */
    const effectiveEnabled = () => (typeof state.enabledOverride === 'boolean' ? state.enabledOverride : config.enabled === true)

    /**
     * 记一笔「刚被拦下了什么」。
     *
     * 只记**带 sessionId 的对话调用**：管家调用（标题/压缩）本来就不拦，没有 sessionId 的
     * 手搓调用也归不到具体会话。预览取请求里最后一条 user 消息的文本。
     * 这份列表只用于展示，插件不会替它做任何事（不重投、不排队、不打扰会话）。
     * @param {object} options - llm/stream 的请求。
     * @param {number} now - 拦截时刻。
     */
    const recordBlock = (options, now) => {
      try {
        const sessionId = options !== null && typeof options === 'object' && typeof options.sessionId === 'string' ? options.sessionId : undefined
        if (sessionId === undefined) return
        state.idSeq += 1
        const item = makeItem({
          id: `peak-${now.toString(36)}-${state.idSeq.toString(36)}`,
          sessionId,
          preview: extractPreview(options.messages),
          atMs: now,
        })
        const result = addItem(state.list, item, config.blockedLimit)
        state.list = result.list
        persist()
        if (result.dropped > 0) log.info(`被拦截列表超过上限 ${config.blockedLimit}，丢了 ${result.dropped} 条最老的`)
      } catch (error) {
        log.warn(`记录被拦截请求失败（不影响拦截）：${renderError(error)}`)
      }
    }

    /**
     * 这一通模型调用要不要拦。
     * @returns {{block: false} | {block: true, now: number, text: string}}
     */
    const decide = (options, now) => {
      if (hardOff) return { block: false }
      if (!effectiveEnabled()) return { block: false }
      if (typeof state.overrideUntilMs === 'number' && state.overrideUntilMs > now) return { block: false }
      const isObject = options !== null && typeof options === 'object'
      const purpose = isObject ? options.purpose : undefined
      // 会话标题、压缩这类「管家调用」默认不拦：它们不产生对话内容，
      // 拦了只会让标题变成那句话、或者让上下文压不动。
      if (purpose !== undefined && config.blockUtilityCalls !== true) return { block: false }
      const sessionId = isObject && typeof options.sessionId === 'string' ? options.sessionId : undefined
      if (sessionId !== undefined && allowSet.has(sessionId)) return { block: false }
      // `/peak force`：无视峰谷强制拦一会儿，用来现场验收插件是不是真的在拦。
      if (typeof state.forceUntilMs === 'number' && state.forceUntilMs > now) {
        return { block: true, now, text: buildMessage(config, now, { forced: true }) }
      }
      if (!isPeak(now, config)) return { block: false }
      return { block: true, now, text: buildMessage(config, now) }
    }

    /**
     * 给界面（HTTP 路由）看的控制面。
     *
     * `limit` 是列表条数（设置页要完整列表，输入框上方那张卡只要前几条）。
     * @param {number} [now] - 取快照的时刻。
     * @param {number} [limit] - 列表返回多少条（1–200）。
     * @returns {object} 可 JSON 化的状态快照。
     */
    const snapshot = (now = Date.now(), limit = SNAPSHOT_LIST_LIMIT) => {
      const next = nextTransition(now, config)
      return {
        plugin: PLUGIN_NAME,
        version: VERSION,
        enabled: effectiveEnabled(),
        enabledSource: typeof state.enabledOverride === 'boolean' ? 'switch' : 'config',
        configEnabled: config.enabled === true,
        hardOff,
        peak: isPeak(now, config),
        now,
        timeZone: config.timeZone,
        windows: Array.isArray(config.peakWindows) ? config.peakWindows.map((window) => window.text ?? `${window.start}-${window.end}`) : [],
        weekendsOffPeak: config.weekendsOffPeak === true,
        nextTransitionAt: next?.atMs ?? null,
        nextIntoPeak: next?.intoPeak ?? null,
        remainingMs: next === undefined ? null : Math.max(0, next.atMs - now),
        blockedCount: state.blockedCount,
        lastBlockAtMs: state.lastBlockAtMs ?? null,
        snoozeUntilMs: typeof state.overrideUntilMs === 'number' && state.overrideUntilMs > now ? state.overrideUntilMs : null,
        forceUntilMs: typeof state.forceUntilMs === 'number' && state.forceUntilMs > now ? state.forceUntilMs : null,
        allowSessions: allowSet.size,
        tone: resolveTone(config),
        /** 最近一次关掉展示框的时刻：卡片据此收起「关闭之前就已办」的记录。 */
        dismissedAtMs: typeof state.dismissedAtMs === 'number' ? state.dismissedAtMs : null,
        ...summarize(state.list, limit),
      }
    }

    /**
     * 界面改状态。认识五种字段：
     *   · `enabled`（布尔）—— 高峰保护总开关
     *   · `snoozeMinutes`（正数或 null）—— 临时放行
     *   · `check`（`{id, done}`）—— 把某条勾成「已办」
     *   · `remove`（id 字符串数组）—— 删掉若干条记录
     *   · `clear`（布尔）—— 清空整份记录
     * @param {object} patch - 请求体。
     * @returns {object} 新快照，或 `{ok:false,error}`。
     */
    const setState = (patch, limit = SNAPSHOT_LIST_LIMIT) => {
      const source = patch !== null && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
      const allowed = new Set(['enabled', 'snoozeMinutes', 'check', 'checkAll', 'restore', 'dismiss', 'remove', 'clear'])
      const unknown = Object.keys(source).filter((key) => !allowed.has(key))
      if (unknown.length > 0) return { ok: false, error: `unknown-field:${unknown.join(',')}` }
      const now = Date.now()
      if (Object.hasOwn(source, 'enabled')) {
        if (typeof source.enabled !== 'boolean') return { ok: false, error: 'enabled-must-be-boolean' }
        state.enabledOverride = source.enabled
        persist()
        log.info(`界面把高峰保护切成 ${source.enabled ? '开' : '关'}（${source.enabled ? '高峰会拦' : '一律放行'}）`)
      }
      if (Object.hasOwn(source, 'snoozeMinutes')) {
        const minutes = source.snoozeMinutes
        if (minutes === null) state.overrideUntilMs = undefined
        else if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) state.overrideUntilMs = now + minutes * 60_000
        else return { ok: false, error: 'snoozeMinutes-must-be-positive-number-or-null' }
      }
      if (Object.hasOwn(source, 'check')) {
        const check = source.check
        if (check === null || typeof check !== 'object' || Array.isArray(check)) return { ok: false, error: 'check-must-be-object' }
        const extra = Object.keys(check).filter((key) => key !== 'id' && key !== 'done')
        if (extra.length > 0) return { ok: false, error: `unknown-field:check.${extra.join(',')}` }
        if (typeof check.id !== 'string' || check.id === '') return { ok: false, error: 'check.id-must-be-string' }
        if (typeof check.done !== 'boolean') return { ok: false, error: 'check.done-must-be-boolean' }
        const result = setDone(state.list, check.id, check.done, now)
        if (!result.found) return { ok: false, error: 'unknown-item' }
        state.list = result.list
        persist()
      }
      if (Object.hasOwn(source, 'checkAll')) {
        if (typeof source.checkAll !== 'boolean') return { ok: false, error: 'checkAll-must-be-boolean' }
        state.list = state.list.map((item) => {
          if (source.checkAll) return { ...item, done: true }
          const { done: _ignored, ...rest } = item
          return rest
        })
        persist()
      }
      if (Object.hasOwn(source, 'restore')) {
        const restore = source.restore
        if (!Array.isArray(restore) || restore.some((id) => typeof id !== 'string' || id === '')) {
          return { ok: false, error: 'restore-must-be-string-array' }
        }
        // 清掉「跳过」= 恢复成正常待办；单向：没有把记录改回跳过的接口
        const result = setSkipped(state.list, restore, null)
        if (result.changed > 0) {
          state.list = result.list
          persist()
        }
      }
      if (Object.hasOwn(source, 'dismiss')) {
        if (source.dismiss !== true) return { ok: false, error: 'dismiss-must-be-true' }
        // 关掉展示框：未处理的盖「跳过」戳；并把「此刻」记下来 —— 早于此刻就已办的记录，
        // 从此不再出现在卡片上（关闭之后才标已办的仍然留在卡上，直到下一次关闭）。
        const result = setSkipped(state.list, [], now)
        state.list = result.list
        state.dismissedAtMs = now
        persist()
        log.info(`界面关掉了展示框：${result.changed} 条未处理的记录标记为「跳过」；此刻之前就已办的记录不再出现在卡片上`)
      }
      if (Object.hasOwn(source, 'remove')) {
        const remove = source.remove
        if (!Array.isArray(remove) || remove.some((id) => typeof id !== 'string' || id === '')) {
          return { ok: false, error: 'remove-must-be-string-array' }
        }
        const wanted = new Set(remove)
        const before = state.list.length
        state.list = state.list.filter((item) => !wanted.has(item.id))
        if (state.list.length !== before) persist()
      }
      if (Object.hasOwn(source, 'clear')) {
        if (source.clear !== true) return { ok: false, error: 'clear-must-be-true' }
        if (state.list.length > 0) {
          log.info(`界面清空了被拦截记录（${state.list.length} 条）`)
          state.list = []
          persist()
        }
      }
      return snapshot(now, limit)
    }

    /** `/peak status` 的文本视图（把开关的有效值一起交给 peak.js 的纯函数）。 */
    const statusView = (now = Date.now()) => statusText(config, {
      ...state,
      enabled: effectiveEnabled(),
      enabledSource: typeof state.enabledOverride === 'boolean' ? 'switch' : 'config',
    }, now)

    // 第一笔 trace 尽早写：后面任何一步出问题，也能看出「新代码到底加载了没有」。
    trace({ stage: 'apply', enabled: effectiveEnabled(), peak: isPeak(Date.now(), config), list: state.list.length })

    // ── 拦截：llm/stream 瀑布 ───────────────────────────────────────────────
    const disposeStream = ctx.on('llm/stream', function peakGuardStream(options, next) {
      try {
        if (typeof next !== 'function') return next
        const decision = decide(options, Date.now())
        if (!decision.block) return next()
        state.blockedCount += 1
        state.lastBlockAtMs = decision.now
        log.info(`高峰拦截 #${state.blockedCount}（${describeCall(options)}）`)
        recordBlock(options, decision.now)
        return blockedStream(decision.text)
      } catch (error) {
        // fail-open：自己炸了就老老实实把这次调用让给真正的模型。
        log.warn(`拦截逻辑出错，已放行本次调用（fail-open）：${renderError(error)}`)
        return next()
      }
    })

    // ── 逃生门 #2：/peak 命令（走 commands 服务，不需要模型参与） ─────────
    const commandHandler = async (invocation) => {
      try {
        const now = Date.now()
        const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
        const match = /^(\S+)\s*([\s\S]*)$/.exec(raw)
        const verb = (match?.[1] ?? '').toLowerCase()
        const rest = match?.[2] ?? ''

        if (verb === '' || verb === 'status' || verb === 's') {
          return { kind: 'success', text: statusView(now) }
        }
        if (verb === 'on' || verb === 'resume') {
          state.overrideUntilMs = undefined
          state.forceUntilMs = undefined
          return { kind: 'success', text: `已恢复拦截。${isPeak(now, config) ? '现在是高峰，下一次模型调用就会被拦。' : '现在是谷时，本来也不会拦。'}` }
        }
        if (verb === 'off' || verb === 'snooze') {
          const parsed = parseSnoozeArg(rest, config.snoozeMinutes)
          if (parsed.error !== undefined) return { kind: 'error', text: parsed.error }
          state.forceUntilMs = undefined
          state.overrideUntilMs = parsed.minutes === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : now + parsed.minutes * 60_000
          const until = parsed.minutes === Number.POSITIVE_INFINITY
            ? '到本次重启为止'
            : `${parsed.minutes} 分钟（${formatClock(state.overrideUntilMs, config.timeZone)} 前）`
          return { kind: 'success', text: `放行 ${until}，模型调用恢复放行。要立刻收回：\`/peak on\`。` }
        }
        if (verb === 'test' || verb === 'dryrun') {
          return { kind: 'success', text: `现在是${isPeak(now, config) ? '高峰（**真的会拦**）' : '谷时（不会拦）'}。\n如果此刻来一次模型调用（或先 /peak force 强制），用户会看到：\n\n${buildMessage(config, now)}` }
        }
        if (verb === 'force') {
          const parsed = parseSnoozeArg(rest, 5)
          if (parsed.error !== undefined) return { kind: 'error', text: parsed.error }
          if (parsed.minutes === Number.POSITIVE_INFINITY) return { kind: 'error', text: '`force` 只接受有限分钟数（例如 `/peak force 5`），要长期放行请用 `/peak off`。' }
          state.forceUntilMs = now + parsed.minutes * 60_000
          return { kind: 'success', text: `已开启强制拦截 ${parsed.minutes} 分钟（无视峰谷，白名单会话仍然放行）。随便发一句话就能看到效果；收回用 \`/peak on\`。` }
        }
        if (verb === 'enable' || verb === 'disable') {
          const next = verb === 'enable'
          const applied = setState({ enabled: next })
          if (applied.ok === false) return { kind: 'error', text: applied.error }
          return { kind: 'success', text: `高峰保护已${next ? '打开' : '关闭'}（和输入框左边那个开关是同一个状态；已落盘，重启后仍然有效）。\n\n${statusView(now)}` }
        }
        if (verb === 'list' || verb === 'queue' || verb === 'q') {
          if (state.list.length === 0) {
            return { kind: 'success', text: '还没有记录 —— 高峰期间被拦下的对话请求会出现在这里（只记录，不会替你重投）。' }
          }
          const lines = state.list.map((item, index) =>
            `${index + 1}. [${formatStamp(item.atMs, config.timeZone)}] ${item.sessionId.slice(-8)} · ${item.preview || '（无文本）'}`)
          return { kind: 'success', text: `高峰期间被拦下 ${state.list.length} 条（只记录，不重投；界面上也能看到这份列表）：\n${lines.join('\n')}` }
        }
        if (verb === 'help' || verb === '-h' || verb === '--help' || verb === '?') {
          return { kind: 'success', text: helpText() }
        }
        return { kind: 'error', text: `不认识的子命令 "${verb}"。\n\n${helpText()}` }
      } catch (error) {
        return { kind: 'error', text: `${PLUGIN_NAME} 执行出错：${renderError(error)}` }
      }
    }

    let commandRegistered = false
    /**
     * 注册 /peak。
     *
     * 关键：**不要假设 apply 执行时 `commands` 已经就位**。直接读 `ctx.commands`，
     * 服务还没 provide 时会拿到 undefined，于是命令静默不存在 —— 表现就是用户在输入框
     * 里打 `/peak test`，客户端在本地命令目录里查不到这个名字，把它当普通消息发给模型
     * （dsh-client-ui-commands 的 `matchEnter`：`desc === undefined → return void 0`）。
     * 所以这里走 cordis 的 `ctx.inject(['commands'], …)`：服务就绪才回调，且注册动作
     * 挂在这个注入作用域上，插件重载时会被正确回收、不会重复注册。
     *
     * @param {object} scope - 带 commands 服务的上下文（注入子上下文或原 ctx）。
     */
    const registerCommand = (scope) => {
      if (commandRegistered) return
      try {
        const commands = scope?.commands ?? ctx?.commands
        if (typeof commands?.register !== 'function') {
          log.warn('/peak 命令未注册：拿不到 commands 服务（拦截本身不受影响）')
          return
        }
        const definition = {
          definitionId: PLUGIN_NAME,
          name: 'peak',
          description: '峰谷时段拦截：看状态 / 临时放行 / 恢复拦截',
          input: { hint: '[status|off [分钟|forever]|on]' },
          handler: commandHandler,
        }
        if (typeof scope?.effect === 'function') scope.effect(() => commands.register(definition), 'peak-guard: /peak')
        else commands.register(definition)
        commandRegistered = true
        log.info('/peak 命令已注册（name=peak）')
        trace({ stage: 'register', commands: true })
      } catch (error) {
        log.warn(`/peak 命令注册失败（拦截本身不受影响）：${renderError(error)}`)
      }
    }
    try {
      if (typeof ctx?.inject === 'function') {
        // 服务就绪即注册；若 commands 永远缺席，也只是没有命令，不影响拦截。
        ctx.inject(['commands'], (scope) => { registerCommand(scope) })
      } else {
        registerCommand(ctx)
      }
    } catch (error) {
      log.warn(`/peak 命令注入失败，退回直接注册：${renderError(error)}`)
      registerCommand(ctx)
    }

    // ── 界面通路：两个同源 JSON 路由（客户端半边 fetch 它们） ──────────────
    // 与命令同样走 ctx.inject：webServer 是可选服务（契约里写明 ctx.get 后要判 undefined），
    // 晚到就晚注册，永远缺席也只是没有界面开关，拦截照旧。
    let routesRegistered = false
    const registerRoutes = (scope) => {
      if (routesRegistered) return
      try {
        const webServer = scope?.webServer ?? ctx?.webServer
        if (webServer === undefined || typeof webServer.register !== 'function') {
          log.warn('界面路由未注册：拿不到 webServer 服务（拦截本身不受影响）')
          return
        }
        const handlers = createRouteHandlers({ snapshot, set: setState }, log.warn)
        const route = (path, handler) => ({ kind: 'exact', path, handler })
        const disposers = [
          webServer.register(route(ROUTES.state, handlers.state)),
          webServer.register(route(ROUTES.set, handlers.set)),
        ]
        routesRegistered = true
        if (typeof scope?.effect === 'function') scope.effect(() => () => { for (const dispose of disposers) try { dispose() } catch { /* 已经摘掉了 */ } }, 'peak-guard: routes')
        log.info(`界面路由已注册（GET ${ROUTES.state} / POST ${ROUTES.set}）`)
        trace({ stage: 'register', routes: true, routePaths: [ROUTES.state, ROUTES.set] })
      } catch (error) {
        log.warn(`界面路由注册失败（界面开关不会出现，拦截本身不受影响）：${renderError(error)}`)
      }
    }
    try {
      if (typeof ctx?.inject === 'function') ctx.inject(['webServer'], (scope) => { registerRoutes(scope) })
      else registerRoutes(ctx)
    } catch (error) {
      log.warn(`界面路由注入失败，退回直接注册：${renderError(error)}`)
      registerRoutes(ctx)
    }

    // ── 加载回执：一句话说清现在是拦还是放 ────────────────────────────────
    const now = Date.now()
    trace({ stage: 'ready' })
    const phase = isPeak(now, config) ? '高峰 → 会拦' : '谷时 → 放行'
    const parts = [
      `已加载（开关=${effectiveEnabled() ? '开' : '关'}${typeof state.enabledOverride === 'boolean' ? '（界面/命令设定）' : '（跟随配置）'}，现在${phase}）`,
      `窗口 ${describeWindows(config)} @ ${config.timeZone}${config.weekendsOffPeak ? '，周末/法定假期全天谷价' : ''}`,
    ]
    if (hardOff) parts.push(`环境变量 ${KILL_ENV} 已关闭本插件`)
    if (config.blockUtilityCalls === true) parts.push('连会话标题/压缩这类管家调用也一并拦下')
    if (allowSet.size > 0) parts.push(`白名单会话 ${allowSet.size} 个`)
    parts.push(`话术=${resolveTone(config)}`)
    if (state.list.length > 0) parts.push(`被拦截列表 ${state.list.length} 条（只记录，重启后仍在）`)
    parts.push(statePath === undefined ? '开关状态不落盘' : `开关状态存 ${statePath}`)
    parts.push(commandRegistered ? '/peak 命令已注册' : '命令注册走 ctx.inject（commands 就绪时会再打一行「已注册」；没打就是没注册）')
    log.info(parts.join('；'))

    // 让加载器的心跳检查看得见我们：ctx.on 已经把监听器挂在 fiber 上了。
    return disposeStream
  } catch (error) {
    // 走到这里说明连归一化都炸了 —— 唯一正确的动作是安静地不生效。
    log.warn(`初始化失败，本插件不生效（DSH 不受影响）：${renderError(error)}`)
    return undefined
  }
}

export const JOKE_MESSAGE = JOKE
export { DEFAULT_CONFIG }

export default { name, apply }
