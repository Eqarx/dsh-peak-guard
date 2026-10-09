/**
 * dsh-peak-guard · 被拦截列表（纯逻辑，零依赖，可单跑）
 *
 * 高峰期间被拦下的**对话请求**在这里记一笔：哪个会话、问了什么、什么时候。
 * 它只用来**看** —— 不排队、不重投、不打扰任何会话（早先有过一版「一键补发 / 谷时自动补发」，
 * 因为投递链路脆弱且语义上自相矛盾，整体砍掉了）。
 *
 * 三条不变式：
 *   1. **不重**：同会话同内容 60 秒内的重复拦截只记一条（重试/抖动不该刷屏）。
 *   2. **有界**：条数、存活时长都有上限，坏数据一律丢弃。
 *   3. **只读**：本模块不产生任何副作用，也不依赖 DSH 的任何服务。
 */

/** 单条预览文本的最大长度。 */
export const PREVIEW_MAX = 80
/** 同会话同内容在这个窗口内视为重复。 */
export const DEDUPE_WINDOW_MS = 60_000
/** 列表硬上限（配置可以调小，但不会超过这个）。 */
export const LIST_HARD_LIMIT = 200

/**
 * 从一次模型调用的请求里抽出「用户最后问了什么」。
 * 取最后一条 role==='user' 的消息里的文本块；没有文本（纯图片/附件）给个占位。
 * @param {unknown} messages - GenerateOptions.messages。
 * @returns {string} 单行、已截断的预览。
 */
export function extractPreview(messages) {
  try {
    if (!Array.isArray(messages)) return ''
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message === null || typeof message !== 'object') continue
      if (message.role !== 'user') continue
      const parts = Array.isArray(message.content) ? message.content : []
      const texts = []
      let hasNonText = false
      for (const part of parts) {
        if (part === null || typeof part !== 'object') continue
        if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
        else hasNonText = true
      }
      const joined = texts.join(' ').replace(/\s+/g, ' ').trim()
      if (joined !== '') return truncate(joined, PREVIEW_MAX)
      if (hasNonText) return '（图片或附件）'
    }
    return ''
  } catch {
    return ''
  }
}

/** 截断到 n 个字符（不切断代理对）。 */
export function truncate(text, n) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= n) return value
  const cut = value.slice(0, n)
  const last = cut.charCodeAt(cut.length - 1)
  const safe = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
  return `${safe}…`
}

/** 造一条记录。 */
export function makeItem({ id, sessionId, preview, atMs }) {
  return {
    id: String(id),
    sessionId: String(sessionId),
    preview: truncate(typeof preview === 'string' ? preview : '', PREVIEW_MAX),
    atMs: Number.isFinite(atMs) ? atMs : Date.now(),
  }
}

/**
 * 记一笔（纯函数）。重复项按「同会话 + 同预览 + 在窗口内」判定，用新的替换旧的
 * （保留原 id，只更新时间），避免重试产生两条。
 * @param {object[]} list - 现有列表。
 * @param {object} item - 新记录。
 * @param {number} limit - 列表上限。
 * @returns {{list: object[], added: boolean, replaced: boolean, dropped: number}}
 */
export function addItem(list, item, limit = 50) {
  const existing = Array.isArray(list) ? list.filter(isItem) : []
  const cap = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 50, LIST_HARD_LIMIT))

  const duplicateIndex = existing.findIndex((candidate) =>
    candidate.sessionId === item.sessionId
    && candidate.preview === item.preview
    && Math.abs(item.atMs - candidate.atMs) <= DEDUPE_WINDOW_MS,
  )
  if (duplicateIndex !== -1) {
    const next = [...existing]
    next[duplicateIndex] = { ...next[duplicateIndex], atMs: item.atMs }
    return { list: next, added: false, replaced: true, dropped: 0 }
  }

  const next = [...existing, item]
  let dropped = 0
  while (next.length > cap) {
    next.shift()
    dropped += 1
  }
  return { list: next, added: true, replaced: false, dropped }
}

/** 丢弃超过最大存活时长的记录。 */
export function dropExpired(list, nowMs, maxAgeMs) {
  const existing = Array.isArray(list) ? list.filter(isItem) : []
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return { fresh: existing, expired: [] }
  const fresh = []
  const expired = []
  for (const item of existing) {
    if (nowMs - item.atMs > maxAgeMs) expired.push(item)
    else fresh.push(item)
  }
  return { fresh, expired }
}

/** 从任意（可能来自坏 JSON 的）输入里判断一条记录是否合法。 */
export function isItem(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (typeof value.id !== 'string' || value.id === '') return false
  if (typeof value.sessionId !== 'string' || value.sessionId === '') return false
  if (typeof value.preview !== 'string') return false
  if (typeof value.atMs !== 'number' || !Number.isFinite(value.atMs)) return false
  return true
}

/** 净化整份列表（丢掉坏项、截断预览、保持顺序）。 */
export function sanitizeList(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const value of raw) {
    if (!isItem(value)) continue
    const item = {
      id: value.id,
      sessionId: value.sessionId,
      preview: truncate(value.preview, PREVIEW_MAX),
      atMs: value.atMs,
    }
    // done 只在为 true 时才写回去，保持文件干净。
    if (value.done === true) item.done = true
    if (value.done === true && typeof value.doneAt === 'number' && Number.isFinite(value.doneAt)) item.doneAt = value.doneAt
    // skippedAt：关展示框时还没处理的那批（时间戳，写盘时也留着）
    if (typeof value.skippedAt === 'number' && Number.isFinite(value.skippedAt)) item.skippedAt = value.skippedAt
    out.push(item)
    if (out.length >= LIST_HARD_LIMIT) break
  }
  return out
}

/**
 * 给界面看的摘要：**最新的在前**（列表是拿来看的，倒序比 FIFO 有用），
 * 同时给出总数与截断标记。
 * @param {object[]} list - 内部按时间正序保存的列表。
 * @param {number} limit - 返回多少条。
 */
export function summarize(list, limit = 20) {
  const existing = Array.isArray(list) ? list.filter(isItem) : []
  const newestFirst = [...existing].reverse()
  return {
    listCount: existing.length,
    listTruncated: newestFirst.length > limit,
    list: newestFirst.slice(0, Math.max(0, limit)).map((item) => ({
      id: item.id,
      sessionId: item.sessionId,
      preview: item.preview,
      atMs: item.atMs,
      /** 「已办」是纯本地的勾选状态（用户自己在界面上点的），落盘跟着列表一起走。 */
      done: item.done === true,
      /** 勾选的时刻；老数据没有这个字段时退回记录自身的时间（当作「很早就办了」）。 */
      doneAt: item.done === true ? (typeof item.doneAt === 'number' && Number.isFinite(item.doneAt) ? item.doneAt : item.atMs) : null,
      /** 「跳过」：关掉展示框的那一刻它还没被处理。值为当时的时间戳，没有这个字段就是正常待办。 */
      skippedAt: typeof item.skippedAt === 'number' ? item.skippedAt : null,
    })),
  }
}

/**
 * 勾选 / 取消勾选一条（纯函数，返回新列表；找不到就原样返回并报 missing）。
 * 勾选状态只影响界面观感，不改变记录本身。同时记下**何时**勾的（`doneAt`）——
 * 展示框靠它区分「关闭之前就已办（该收起）」和「关闭之后才办（先留着）」。
 * @param {object[]} list - 现有列表。
 * @param {string} id - 记录 id。
 * @param {boolean} done - 目标状态。
 * @param {number} [atMs] - 勾选时刻（取消勾选不需要）。
 * @returns {{list: object[], found: boolean}}
 */
export function setDone(list, id, done, atMs) {
  const existing = Array.isArray(list) ? list.filter(isItem) : []
  let found = false
  const next = existing.map((item) => {
    if (item.id !== id) return item
    found = true
    if (done) return { ...item, done: true, doneAt: Number.isFinite(atMs) ? atMs : Date.now() }
    const { done: _ignored, doneAt: _alsoIgnored, ...rest } = item
    return rest
  })
  return { list: found ? next : existing, found }
}

/**
 * 「跳过」状态：关掉展示框时，把当时**还没处理**的记录都盖一个时间戳，
 * 于是在拦截记录页里它们能和正常待办区分开（点了就恢复成正常待办，单向）。
 *
 * @param {object[]} list - 现有列表。
 * @param {string[]} ids - 要恢复的记录 id；为空数组表示「不指定」。
 * @param {number | null} atMs - 时间戳 = 标记为跳过；null = 清掉标记（恢复为正常待办）。
 * @returns {{list: object[], changed: number}}
 */
export function setSkipped(list, ids, atMs) {
  const existing = Array.isArray(list) ? list.filter(isItem) : []
  const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null
  const stamp = typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : null
  let changed = 0

  const next = existing.map((item) => {
    if (wanted !== null ? !wanted.has(item.id) : item.done === true) return item
    if (stamp === null) {
      if (item.skippedAt === undefined) return item
      const { skippedAt: _ignored, ...rest } = item
      changed += 1
      return rest
    }
    changed += 1
    return { ...item, skippedAt: stamp }
  })
  return { list: changed === 0 ? existing : next, changed }
}
