/**
 * dsh-peak-guard · 宿主半边给界面用的 HTTP 路由（客户端半边同源 fetch 取/改状态）
 *
 * 为什么用 HTTP 而不是 Typert Remote：本机已安装的第三方宿主+客户端插件
 * （dsh-cost-meter）就是这么通的 —— 宿主 `ctx.provide()` + 客户端
 * `fetch('/plugins/...', { credentials: 'same-origin' })`。少一套 schema 生成，
 * 少一层版本耦合，而且这套路由的响应天然可以脱离 DSH 用 curl 自测。
 *
 * 安全：路由挂在 DSH 自带的 127.0.0.1 HTTP 服务上，默认只有本机可达。但“本机可达”
 * 不等于安全 —— 用户浏览器里任何一个网页都可能朝 127.0.0.1 发跨站请求（CSRF），
 * 所以写接口有两道闸：
 *   1. 必须带自定义头 `x-peak-guard: 1`。跨站 <form> 设不了自定义头；跨站 fetch 想设
 *      就会先发 OPTIONS 预检，而我们**不返回任何 CORS 头**、预检直接 405。
 *   2. 带了 `origin` 头时，必须与 `host` 同源。
 * 读接口（GET state）无副作用，随便读；跨站也读不到内容（没有 CORS 头）。
 *
 * 本文件不 import 任何 DSH 东西：全部逻辑都可以用假 req/res 直接测。
 */

/** 单次请求体的上限（这个接口只收一个小 JSON）。 */
export const MAX_BODY_BYTES = 4096

/** 路由路径（客户端半边要拼同样的字符串）。 */
export const ROUTES = {
  state: '/peak-guard/state',
  set: '/peak-guard/set',
}

/**
 * 写一个 JSON 响应。永远带 no-store，避免界面拿到缓存里的旧状态。
 * @param {object} res - node ServerResponse（或测试替身）。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - 会被 JSON.stringify 的对象。
 */
export function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    body = '{"ok":false,"error":"unserializable"}'
    status = 500
  }
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  }
  try {
    if (typeof res.writeHead === 'function') res.writeHead(status, headers)
    else if (typeof res.setHeader === 'function') for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  } catch {
    /* 头部写失败也继续尝试 body */
  }
  try {
    if (typeof res.end === 'function') res.end(body)
  } catch {
    /* 连接已经断了 */
  }
}

/** 小写化的请求头取值（node 已经小写，测试替身可能不是）。 */
export function header(req, name) {
  const headers = req?.headers
  if (headers === null || typeof headers !== 'object') return undefined
  const direct = headers[name]
  if (typeof direct === 'string') return direct
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : typeof value === 'string' ? value : undefined
  }
  return undefined
}

/** 请求路径（去掉 query）。 */
export function pathname(req) {
  const url = typeof req?.url === 'string' ? req.url : '/'
  const cut = url.indexOf('?')
  return cut === -1 ? url : url.slice(0, cut)
}

/**
 * 写接口的第二道闸：带 origin 时必须与 host 同源。
 * @param {object} req - 请求。
 * @returns {boolean} 是否放行。
 */
export function sameOrigin(req) {
  const origin = header(req, 'origin')
  if (origin === undefined || origin === 'null') return origin === undefined
  try {
    const parsed = new URL(origin)
    const host = header(req, 'host')
    return typeof host === 'string' && parsed.host === host
  } catch {
    return false
  }
}

/**
 * 读一个 JSON 请求体（带大小上限）。
 * @param {object} req - 请求（AsyncIterable of Buffer）。
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: string}>}
 */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  if (req === null || typeof req !== 'object' || req[Symbol.asyncIterator] === undefined) {
    return { ok: false, error: 'no-body-stream' }
  }
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limit) return { ok: false, error: 'body-too-large' }
      chunks.push(buffer)
    }
  } catch {
    return { ok: false, error: 'body-read-failed' }
  }
  if (size === 0) return { ok: true, value: {} }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'body-must-be-object' }
    return { ok: true, value: parsed }
  } catch {
    return { ok: false, error: 'body-not-json' }
  }
}

/**
 * 读 query 里的一个参数（没有就返回 undefined）。
 * @param {object} req - node IncomingMessage（或测试替身）。
 * @param {string} name - 参数名。
 * @returns {string | undefined}
 */
export function queryParam(req, name) {
  try {
    const url = String(req?.url ?? '')
    const mark = url.indexOf('?')
    if (mark === -1) return undefined
    const params = new URLSearchParams(url.slice(mark + 1))
    const value = params.get(name)
    return value === null ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * 写接口的两道闸（读接口不需要）：自定义头 + 同源。
 * @param {object} req - 请求。
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function writeGate(req) {
  if (header(req, 'x-peak-guard') !== '1') return { ok: false, status: 403, error: 'missing-guard-header' }
  if (!sameOrigin(req)) return { ok: false, status: 403, error: 'cross-origin' }
  return { ok: true }
}

/**
 * 建两个路由处理器（读状态 / 改状态）。
 * @param {object} control - 插件控制面：`snapshot()` 读状态、`set(patch)` 改状态。
 * @param {(message: string) => void} [warn] - 告警出口。
 * @returns {{state: Function, set: Function}} node 风格 `(req, res)` 处理器。
 */
export function createRouteHandlers(control, warn = () => {}) {
  return {
    state(req, res) {
      try {
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        // ?limit=N 让设置页一次拿到完整列表（默认 20 给输入框上方那张卡用）
        const parsed = Number(queryParam(req, 'limit'))
        const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(200, Math.trunc(parsed))) : undefined
        const body = limit === undefined ? control.snapshot() : control.snapshot(Date.now(), limit)
        return sendJson(res, 200, { ok: true, ...body })
      } catch (error) {
        warn(`GET state 处理失败：${String(error)}`)
        return sendJson(res, 500, { ok: false, error: 'internal' })
      }
    },
    async set(req, res) {
      try {
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        const gate = writeGate(req)
        if (!gate.ok) return sendJson(res, gate.status, { ok: false, error: gate.error })
        const body = await readJsonBody(req)
        if (!body.ok) return sendJson(res, 400, { ok: false, error: body.error })
        const parsedLimit = Number(queryParam(req, 'limit'))
        const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(200, Math.trunc(parsedLimit))) : undefined
        const result = limit === undefined ? control.set(body.value) : control.set(body.value, limit)
        if (result?.ok === false) return sendJson(res, 400, result)
        return sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        warn(`POST set 处理失败：${String(error)}`)
        return sendJson(res, 500, { ok: false, error: 'internal' })
      }
    },
  }
}