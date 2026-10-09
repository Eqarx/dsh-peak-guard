/**
 * dsh-peak-guard · 宿主半边集成测试（假 ctx，不需要 DSH）
 *
 * 用一个最小 cordis 替身把插件真的 apply 起来，然后像 DSH 那样去 dispatch
 * `llm/stream`，验证四件事：
 *   1. 高峰时**根本不调用 next()**（= 没碰任何模型适配器）；
 *   2. 吐出去的分片是合法的 StreamChunk 序列，且能组装成「那句话」；
 *   3. 谷时 / 白名单 / 管家调用 / 环境变量 / `/peak off` 都能正常放行；
 *   4. 任何畸形输入都 fail-open（放行）而不是抛错 —— 插件不许把 DSH 弄死。
 *
 * 跑法：node test/plugin.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JOKE, PLUGIN_NAME, POLITE } from '../lib/peak.js'
import { apply, blockedStream } from '../lib/index.js'
import { header, pathname, sameOrigin } from '../lib/http.js'
import { writeState } from '../lib/store.js'
import { makeItem } from '../lib/blocked.js'

// 让「默认落盘路径」落进临时目录：某些用例故意传垃圾 config，此时会走
// <DSH_HOME>/plugin-data/... 的默认路径，不能让它写进用户真实的 profile 数据目录。
const HERMETIC_HOME = mkdtempSync(join(tmpdir(), 'peak-guard-home-'))
process.env.DSH_HOME = HERMETIC_HOME

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`${name}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`${name}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

function eq(actual, expected, what) {
  if (!Object.is(actual, expected)) throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function ok(value, what) {
  if (!value) throw new Error(`${what}：期望为真，实际 ${JSON.stringify(value)}`)
}

// ── 测试替身 ────────────────────────────────────────────────────────────────

/** 最小 ctx：只提供插件真正用到的几样东西。 */
function makeCtx({ withCommands = true, withLogger = true, withWebServer = true, injectMode = 'immediate', rejectDuplicateCommands = false } = {}) {
  const listeners = new Map()
  const commands = []
  const routes = []
  const logs = []
  const applied = []
  const injectQueue = []
  const ctx = {
    on(event, callback) {
      listeners.set(event, [...(listeners.get(event) ?? []), callback])
      return () => {}
    },
    effect(callback) {
      applied.push(callback)
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  if (withLogger) ctx.logger = (scope) => ({
    info: (message) => logs.push(['info', scope, message]),
    warn: (message) => logs.push(['warn', scope, message]),
  })
  if (withCommands) {
    ctx.commands = {
      register(definition) {
        if (rejectDuplicateCommands && commands.some((existing) => existing.name === definition.name)) {
          throw new Error(`commands: duplicate name "${definition.name}"`)
        }
        commands.push(definition)
        return () => {}
      },
    }
  }
  if (withWebServer) {
    ctx.webServer = {
      register(route) {
        if (routes.some((existing) => existing.kind === route.kind && existing.path === route.path)) {
          throw new Error(`webServer: duplicate route ${route.path}`)
        }
        routes.push(route)
        return () => {}
      },
    }
  }
  const scope = () => ({
    commands: ctx.commands,
    webServer: ctx.webServer,
    sessionController: ctx.sessionController,
    effect: ctx.effect,
  })
  // cordis 的 ctx.inject([...], cb)：服务就绪才回调（这里模拟三种时序）。
  if (injectMode !== 'absent') {
    ctx.inject = (deps, callback) => {
      const ready = (deps ?? []).every((dep) => ctx[dep] !== undefined)
      if (injectMode === 'immediate' && ready) callback(scope())
      else if (injectMode === 'deferred') injectQueue.push({ deps, callback })
      return () => {}
    }
  }
  return {
    ctx,
    logs,
    commands,
    routes,
    injectQueue,
    fireInject: (dep) => {
      const pending = injectQueue.splice(0).filter((entry) => {
        if (dep === undefined) return true
        return (entry.deps ?? []).includes(dep)
      })
      for (const entry of pending) entry.callback(scope())
      return pending.length
    },
    streamListener: () => {
      const found = listeners.get('llm/stream') ?? []
      eq(found.length, 1, 'llm/stream 监听器数量')
      return found[0]
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  }
}

/** 假 HTTP 请求：AsyncIterable 的 body + headers/method/url。 */
function fakeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
}

/** 假 HTTP 响应：把 status/headers/body 收下来。 */
function fakeResponse() {
  const captured = { status: 0, headers: {}, body: '' }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers ?? {}
    },
    end(body) {
      captured.body = body ?? ''
    },
    json() {
      return JSON.parse(captured.body)
    },
  }
}

/** 取插件注册的路由处理器。 */
function routeHandler(harness, path) {
  const found = harness.routes.find((route) => route.path === path)
  ok(found !== undefined, `应注册路由 ${path}`)
  return found.handler
}

/** 打一次 JSON 写接口（默认带上正确的自定义头与同源 host）。 */
async function callSet(harness, body, headers = { 'x-peak-guard': '1', host: '127.0.0.1:19387' }) {
  const response = fakeResponse()
  await routeHandler(harness, '/peak-guard/set')(fakeRequest({ method: 'POST', url: '/peak-guard/set', headers, body }), response)
  return response
}

/** 假的 next()：记下它有没有被调用，并吐一个可辨认的「真模型」分片。 */
function spyNext() {
  const calls = { count: 0 }
  async function* realModelStream() {
    calls.count += 1
    yield { type: 'text-delta', index: 0, text: '真模型的回答' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return { calls, next: realModelStream }
}

async function drain(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

/**
 * BlockAssembler 的最小镜像（照 @deepseek-ai/dsh-llm/lib/types/assembler.js 的语义写）：
 * 只需要证明我们吐的分片能组装成一条文本消息。
 */
function assembleMirror(chunks) {
  const partials = new Map()
  const order = []
  let finish
  let usageBeforeFinish = true
  let sawFinish = false
  for (const chunk of chunks) {
    if (chunk.type === 'usage' && sawFinish) usageBeforeFinish = false
    switch (chunk.type) {
      case 'block-start':
        if (!partials.has(chunk.index)) {
          order.push(chunk.index)
          partials.set(chunk.index, { blockType: chunk.blockType, text: '' })
        }
        break
      case 'text-delta': {
        if (!partials.has(chunk.index)) {
          order.push(chunk.index)
          partials.set(chunk.index, { blockType: 'text', text: '' })
        }
        partials.get(chunk.index).text += chunk.text
        break
      }
      case 'block-end': {
        if (!partials.has(chunk.index)) {
          order.push(chunk.index)
          partials.set(chunk.index, { blockType: chunk.block.type, text: '' })
        }
        partials.get(chunk.index).block = chunk.block
        break
      }
      case 'usage':
      case 'finish':
        if (chunk.type === 'finish') {
          finish = chunk.reason
          sawFinish = true
        }
        break
      default:
        throw new Error(`未知分片类型 ${chunk.type}`)
    }
  }
  const blocks = order.map((index) => {
    const partial = partials.get(index)
    if (partial.block) return partial.block
    if (partial.blockType === 'text') return { type: 'text', text: partial.text }
    throw new Error(`无法组装 ${partial.blockType}`)
  })
  return { blocks, finish: finish ?? { kind: 'stop' }, usageBeforeFinish }
}

const ALLOWED_CHUNK_TYPES = new Set(['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end', 'usage', 'finish'])

/**
 * 全天高峰 + 不带 hint + 彩蛋话术：输出应恰好是那句彩蛋，判定与真实时钟无关。
 * （默认话术是正经版；这里显式选 joke，让「分片组装出来的就是那句话」的断言继续有效。）
 */
const FULL_PEAK = { peakWindows: ['00:00-24:00'], weekendsOffPeak: false, holidays: [], hint: false, tone: 'joke', statePath: '' }
/** 从不拦截。 */
const NEVER_PEAK = { peakWindows: [], statePath: '' }

// ── 1. 注册面 ───────────────────────────────────────────────────────────────

await checkAsync('apply 注册一个 llm/stream 监听器与 /peak 命令', () => {
  const harness = makeCtx()
  apply(harness.ctx, FULL_PEAK)
  eq(harness.listenerCount('llm/stream'), 1, 'llm/stream 监听器')
  eq(harness.commands.length, 1, '命令数量')
  const definition = harness.commands[0]
  eq(definition.name, 'peak', '命令名')
  eq(typeof definition.handler, 'function', 'handler 是函数')
  ok(definition.description.trim().length > 0, 'description 非空')
  ok(/^[a-z][a-z0-9_-]*$/u.test(definition.name), '命令名符合 COMMAND_NAME')
  ok(definition.definitionId === PLUGIN_NAME, 'definitionId 等于包名')
  ok(harness.logs.some(([level]) => level === 'info'), '加载时应打一行 info 回执')
})

await checkAsync('没有 commands 服务时也照常拦截', async () => {
  const harness = makeCtx({ withCommands: false })
  apply(harness.ctx, FULL_PEAK)
  const spy = spyNext()
  const chunks = await drain(harness.streamListener()({ provider: 'deepseek', model: 'deepseek-flash' }, spy.next))
  eq(spy.calls.count, 0, 'next 调用次数')
  ok(chunks.length > 0, '应吐出分片')
})

await checkAsync('commands 迟到：ctx.inject 就绪后补注册，且只注册一次', async () => {
  const harness = makeCtx({ injectMode: 'deferred' })
  apply(harness.ctx, FULL_PEAK)
  eq(harness.commands.length, 0, 'apply 当场还没注册（服务没就绪）')
  eq(harness.listenerCount('llm/stream'), 1, '拦截不受影响，监听器已挂上')

  eq(harness.fireInject('commands'), 1, 'commands 的就绪回调只挂了一个')
  eq(harness.commands.length, 1, '服务就绪后补注册成功')
  eq(harness.commands[0].name, 'peak', '命令名')
  ok(harness.logs.some(([level, , message]) => level === 'info' && message.includes('已注册')), '应留下注册回执行')

  // 幂等：再次触发（例如热重载后重复注入）不能注册第二份。
  const harness2 = makeCtx({ injectMode: 'deferred' })
  apply(harness2.ctx, FULL_PEAK)
  harness2.fireInject()
  eq(harness2.commands.length, 1, '第一次注册')
  const handler = harness2.commands[0].handler
  eq((await handler({ rawInput: 'status' })).kind, 'success', '命令可用')
})

await checkAsync('commands 永不到来：命令缺席但拦截照旧', async () => {
  const harness = makeCtx({ injectMode: 'never' })
  apply(harness.ctx, FULL_PEAK)
  eq(harness.commands.length, 0, '没有命令')
  const spy = spyNext()
  const chunks = await drain(harness.streamListener()({ provider: 'deepseek', model: 'm' }, spy.next))
  eq(spy.calls.count, 0, '拦截仍然生效')
  eq(assembleMirror(chunks).blocks[0].text, JOKE, '仍然回那句话')
})

await checkAsync('重复注册被 commands 拒绝时：只告警，不抛错', () => {
  const harness = makeCtx({ rejectDuplicateCommands: true })
  apply(harness.ctx, FULL_PEAK)
  eq(harness.commands.length, 1, '第一次注册成功')
  apply(harness.ctx, FULL_PEAK) // 模拟热重载后再次 apply
  eq(harness.commands.length, 1, '第二次没有重复插入')
  ok(harness.logs.some(([level]) => level === 'warn'), '应留下告警而不是抛出')
})

// ── 2. 核心：高峰短路 ───────────────────────────────────────────────────────

await checkAsync('高峰：不调用 next，分片组装成原话', async () => {
  const harness = makeCtx()
  apply(harness.ctx, FULL_PEAK)
  const spy = spyNext()
  const options = { provider: 'deepseek', model: 'deepseek-flash', sessionId: 'session-abc' }
  const chunks = await drain(harness.streamListener()(options, spy.next))

  eq(spy.calls.count, 0, '绝不允许碰到真适配器')
  for (const chunk of chunks) ok(ALLOWED_CHUNK_TYPES.has(chunk.type), `分片类型合法（${chunk.type}）`)
  eq(chunks[0].type, 'block-start', '首个分片')
  eq(chunks[chunks.length - 1].type, 'finish', '末个分片')
  eq(chunks[chunks.length - 1].reason.kind, 'stop', '结束原因')

  const assembled = assembleMirror(chunks)
  eq(assembled.blocks.length, 1, '块数量')
  eq(assembled.blocks[0].type, 'text', '块类型')
  eq(assembled.blocks[0].text, JOKE, '模型「说」的话')
  eq(assembled.finish.kind, 'stop', '组装后的结束原因')
  ok(assembled.usageBeforeFinish, 'usage 必须在 finish 之前')
})

check('blockedStream 本身自洽（可以脱离监听器单独消费）', async () => {
  const chunks = await drain(blockedStream('测试'))
  const assembled = assembleMirror(chunks)
  eq(assembled.blocks[0].text, '测试', '文本')
  eq(assembled.blocks[0].type, 'text', '文本块')
})

await checkAsync('默认 hint 打开时：首行仍是原话，但附上逃生门', async () => {
  const harness = makeCtx()
  apply(harness.ctx, { ...FULL_PEAK, hint: true })
  const spy = spyNext()
  const chunks = await drain(harness.streamListener()({ provider: 'deepseek', model: 'deepseek-flash' }, spy.next))
  eq(spy.calls.count, 0, 'next 调用次数')
  const text = assembleMirror(chunks).blocks[0].text
  eq(text.split('\n')[0], JOKE, '首行原话')
  ok(text.includes('/peak off'), '应给出逃生门')
})

// ── 3. 放行路径 ─────────────────────────────────────────────────────────────

await checkAsync('谷时：原样放行给真模型', async () => {
  const harness = makeCtx()
  apply(harness.ctx, NEVER_PEAK)
  const spy = spyNext()
  const chunks = await drain(harness.streamListener()({ provider: 'deepseek', model: 'deepseek-flash' }, spy.next))
  eq(spy.calls.count, 1, 'next 调用次数')
  eq(chunks[0].text, '真模型的回答', '拿到的是真模型的输出')
})

await checkAsync('enabled=false：整体停用', async () => {
  const harness = makeCtx()
  apply(harness.ctx, { ...FULL_PEAK, enabled: false })
  const spy = spyNext()
  await drain(harness.streamListener()({}, spy.next))
  eq(spy.calls.count, 1, 'next 调用次数')
})

await checkAsync('管家调用（purpose）默认放行，可配置成一起拦', async () => {
  const lenient = makeCtx()
  apply(lenient.ctx, FULL_PEAK)
  const spyA = spyNext()
  await drain(lenient.streamListener()({ provider: 'deepseek', model: 'm', purpose: 'session-title' }, spyA.next))
  eq(spyA.calls.count, 1, '默认放行会话标题调用')

  const strict = makeCtx()
  apply(strict.ctx, { ...FULL_PEAK, blockUtilityCalls: true })
  const spyB = spyNext()
  const chunks = await drain(strict.streamListener()({ provider: 'deepseek', model: 'm', purpose: 'session-title' }, spyB.next))
  eq(spyB.calls.count, 0, '开启后一起拦')
  eq(assembleMirror(chunks).blocks[0].text, JOKE, '连管家调用也回那句话')
})

await checkAsync('白名单会话永远放行', async () => {
  const harness = makeCtx()
  apply(harness.ctx, { ...FULL_PEAK, allowSessions: ['session-b4b3e00f', 42] })
  const spy = spyNext()
  await drain(harness.streamListener()({ provider: 'deepseek', model: 'm', sessionId: 'session-b4b3e00f' }, spy.next))
  eq(spy.calls.count, 1, '白名单内放行')

  const spy2 = spyNext()
  const chunks = await drain(harness.streamListener()({ provider: 'deepseek', model: 'm', sessionId: 'session-other' }, spy2.next))
  eq(spy2.calls.count, 0, '白名单外照拦')
  eq(assembleMirror(chunks).blocks[0].text, JOKE, '拦下的仍是那句话')
})

await checkAsync('环境变量 DSH_PEAK_GUARD=off 是硬逃生门', async () => {
  const previous = process.env.DSH_PEAK_GUARD
  process.env.DSH_PEAK_GUARD = 'off'
  try {
    const harness = makeCtx()
    apply(harness.ctx, FULL_PEAK)
    const spy = spyNext()
    await drain(harness.streamListener()({ provider: 'deepseek', model: 'm' }, spy.next))
    eq(spy.calls.count, 1, '环境变量关掉后放行')
  } finally {
    if (previous === undefined) delete process.env.DSH_PEAK_GUARD
    else process.env.DSH_PEAK_GUARD = previous
  }
})

// ── 4. /peak 命令 ───────────────────────────────────────────────────────────

await checkAsync('/peak 子命令：status / off / on / forever / 错误输入', async () => {
  const harness = makeCtx()
  apply(harness.ctx, FULL_PEAK)
  const handler = harness.commands[0].handler
  const listener = harness.streamListener()

  const status = await handler({ rawInput: '', agent: undefined, signal: undefined })
  eq(status.kind, 'success', 'status 返回 success')
  ok(status.text.includes(PLUGIN_NAME), 'status 文本含插件名')
  ok(status.text.includes('高峰'), 'status 标出高峰')

  const off = await handler({ rawInput: 'off 30' })
  eq(off.kind, 'success', 'off 返回 success')
  const spyDuringSnooze = spyNext()
  await drain(listener({ provider: 'deepseek', model: 'm' }, spyDuringSnooze.next))
  eq(spyDuringSnooze.calls.count, 1, 'snooze 期间放行')

  const on = await handler({ rawInput: 'on' })
  eq(on.kind, 'success', 'on 返回 success')
  const spyAfterOn = spyNext()
  await drain(listener({ provider: 'deepseek', model: 'm' }, spyAfterOn.next))
  eq(spyAfterOn.calls.count, 0, 'on 之后恢复拦截')

  const forever = await handler({ rawInput: 'off forever' })
  eq(forever.kind, 'success', 'forever 返回 success')
  const spyForever = spyNext()
  await drain(listener({ provider: 'deepseek', model: 'm' }, spyForever.next))
  eq(spyForever.calls.count, 1, 'forever 一直放行')

  const badNumber = await handler({ rawInput: 'off 不是数字' })
  eq(badNumber.kind, 'error', '非法分钟数返回 error')
  const badVerb = await handler({ rawInput: '起飞' })
  eq(badVerb.kind, 'error', '未知子命令返回 error')
  const help = await handler({ rawInput: 'help' })
  eq(help.kind, 'success', 'help 返回 success')

  // 命令处理器还要扛得住没有 rawInput 的调用
  const bare = await handler({})
  eq(bare.kind, 'success', '缺 rawInput 时退化为 status')
})

await checkAsync('/peak test 是纯 dry-run：不改状态、不拦调用', async () => {
  const harness = makeCtx()
  apply(harness.ctx, NEVER_PEAK)
  const handler = harness.commands[0].handler
  const listener = harness.streamListener()

  const test = await handler({ rawInput: 'test' })
  eq(test.kind, 'success', 'test 返回 success')
  ok(test.text.includes(POLITE), 'test 里能看到提示语（默认正经版）')
  ok(test.text.includes('谷时'), 'test 说明现在是谷时')

  const spy = spyNext()
  await drain(listener({ provider: 'deepseek', model: 'm' }, spy.next))
  eq(spy.calls.count, 1, 'test 之后仍放行（没改状态）')
})

await checkAsync('/peak force：谷时也能强制拦，直到 on 收回', async () => {
  const harness = makeCtx()
  apply(harness.ctx, NEVER_PEAK) // 配置成从不拦截，只要 force 还能拦就说明是真的强制
  const handler = harness.commands[0].handler
  const listener = harness.streamListener()

  const spyBefore = spyNext()
  await drain(listener({ provider: 'deepseek', model: 'm' }, spyBefore.next))
  eq(spyBefore.calls.count, 1, 'force 之前放行')

  const force = await handler({ rawInput: 'force 5' })
  eq(force.kind, 'success', 'force 返回 success')
  const spyForced = spyNext()
  const chunks = await drain(listener({ provider: 'deepseek', model: 'm' }, spyForced.next))
  eq(spyForced.calls.count, 0, 'force 期间拦下')
  const forcedText = assembleMirror(chunks).blocks[0].text
  eq(forcedText.split('\n')[0], POLITE, 'force 期间首行仍是提示语（默认正经版）')
  ok(forcedText.includes('强制拦截'), 'force 期间话术标明是手动拦的，不谎称高峰')

  const status = await handler({ rawInput: 'status' })
  ok(status.text.includes('强制拦截'), 'status 标出强制拦截')

  await handler({ rawInput: 'on' })
  const spyAfter = spyNext()
  await drain(listener({ provider: 'deepseek', model: 'm' }, spyAfter.next))
  eq(spyAfter.calls.count, 1, 'on 之后恢复放行')

  const badForce = await handler({ rawInput: 'force forever' })
  eq(badForce.kind, 'error', 'force forever 被拒绝')
})

// ── 5. 谷时补答（V1）：记录 / 投递 / 命令 / 自动开关 ─────────────────────────

/** 假 sessionController：记下每次 prompt 的请求，可指定哪些会话在跑 / 哪些投递失败。 */
function makeController({ running = [], fail = [] } = {}) {
  const calls = []
  return {
    calls,
    async list() {
      return { items: running.map((sessionId) => ({ sessionId, running: true })) }
    },
    async prompt(request) {
      calls.push(request)
      if (fail.includes(request.sessionId)) throw new Error('prompt rejected by test')
      return { accepted: true }
    },
  }
}

/** 捕获「大延时」定时器（自动补答的排程），小延时照常放行。 */
function captureTimers() {
  const original = globalThis.setTimeout
  const captured = []
  globalThis.setTimeout = (fn, delay, ...rest) => {
    if ((delay ?? 0) >= 4000) {
      captured.push({ fn, delay })
      return 0
    }
    return original(fn, delay, ...rest)
  }
  return {
    captured,
    restore() {
      globalThis.setTimeout = original
    },
  }
}

await checkAsync('高峰拦下的对话请求会进「被拦截列表」（带会话与原文预览），且只记录不动作', async () => {
  const harness = makeCtx()
  apply(harness.ctx, FULL_PEAK)
  const listener = harness.streamListener()

  const spy = spyNext()
  await drain(listener({
    provider: 'deepseek',
    model: 'm',
    sessionId: 'session-aaa',
    messages: [{ role: 'user', content: [{ type: 'text', text: '帮我看看这个报错' }] }],
  }, spy.next))
  eq(spy.calls.count, 0, '拦下了')

  const response = fakeResponse()
  await routeHandler(harness, '/peak-guard/state')(fakeRequest({ method: 'GET', url: '/peak-guard/state' }), response)
  const body = response.json()
  eq(body.listCount, 1, '列表 1 条')
  eq(body.list.length, 1, '快照带上列表内容')
  eq(body.list[0].sessionId, 'session-aaa', '会话 id')
  eq(body.list[0].preview, '帮我看看这个报错', '预览是用户原文')
  eq(body.tone, 'joke', '话术透出（本测试配置成彩蛋版）')
  eq(body.listTruncated, false, '没截断')
  ok(!('lastRelease' in body) && !('autoReplay' in body) && !('hasController' in body), '补发相关的字段已经全部砍掉')

  // 再拦一次（同会话同内容）→ 60 秒内去重
  await drain(listener({
    provider: 'deepseek', model: 'm', sessionId: 'session-aaa',
    messages: [{ role: 'user', content: [{ type: 'text', text: '帮我看看这个报错' }] }],
  }, spyNext().next))
  const again = fakeResponse()
  await routeHandler(harness, '/peak-guard/state')(fakeRequest({ method: 'GET', url: '/peak-guard/state' }), again)
  eq(again.json().listCount, 1, '重复拦截不产生第二条')

  // 没有 sessionId 的手搓调用不进列表（归不到具体会话）
  await drain(listener({ provider: 'deepseek', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, spyNext().next))
  const third = fakeResponse()
  await routeHandler(harness, '/peak-guard/state')(fakeRequest({ method: 'GET', url: '/peak-guard/state' }), third)
  eq(third.json().listCount, 1, '没有会话的调用不记录')
})

await checkAsync('/peak list：把列表原样打出来（只记录，不重投）', async () => {
  const harness = makeCtx()
  apply(harness.ctx, FULL_PEAK)
  const handler = harness.commands[0].handler
  const listener = harness.streamListener()
  await drain(listener({
    provider: 'deepseek', model: 'm', sessionId: 'session-list',
    messages: [{ role: 'user', content: [{ type: 'text', text: '列表里的这句话' }] }],
  }, spyNext().next))

  const other = makeCtx()
  apply(other.ctx, FULL_PEAK)
  const empty = await other.commands[0].handler({ rawInput: 'list' })
  eq(empty.kind, 'success', '空列表也是成功回执')
  ok(empty.text.includes('还没有记录'), '空列表文案')

  const filled = await handler({ rawInput: 'list' })
  eq(filled.kind, 'success', '有记录时成功')
  ok(filled.text.includes('列表里的这句话'), '把原文打出来')
  ok(filled.text.includes('不重投'), '明确说明不会替用户重投')

  const aliased = await handler({ rawInput: 'queue' })
  eq(aliased.kind, 'success', '老写法 /peak queue 仍然认')

  const gone = await handler({ rawInput: 'replay' })
  eq(gone.kind, 'error', '/peak replay 已经不存在了')
  const auto = await handler({ rawInput: 'auto on' })
  eq(auto.kind, 'error', '/peak auto 已经不存在了')
})
await checkAsync('GET /peak-guard/state 返回可用的状态快照', async () => {
  const harness = makeCtx()
  apply(harness.ctx, FULL_PEAK)
  eq(harness.routes.length, 2, '应注册两条路由（state/set）')
  eq(harness.routes[0].kind, 'exact', 'kind=exact')
  const response = fakeResponse()
  await routeHandler(harness, '/peak-guard/state')(fakeRequest({ method: 'GET', url: '/peak-guard/state' }), response)
  eq(response.captured.status, 200, 'HTTP 状态')
  eq(response.captured.headers['cache-control'], 'no-store', '不缓存')
  const body = response.json()
  eq(body.ok, true, 'ok')
  eq(body.plugin, PLUGIN_NAME, 'plugin 名')
  eq(body.enabled, true, '开关默认跟随配置 → 开')
  eq(body.enabledSource, 'config', '来源=配置')
  eq(body.peak, true, '全天高峰配置下 peak=true')
  eq(body.weekendsOffPeak, false, '周末规则透出')
  ok(Array.isArray(body.windows) && body.windows.length === 1, '窗口透出')
  eq(body.blockedCount, 0, '拦截计数')
})

await checkAsync('POST /peak-guard/set 关掉开关：立刻放行，且状态可读', async () => {
  const harness = makeCtx()
  apply(harness.ctx, FULL_PEAK)
  const listener = harness.streamListener()

  const spyBefore = spyNext()
  await drain(listener({ provider: 'deepseek', model: 'm' }, spyBefore.next))
  eq(spyBefore.calls.count, 0, '开关开着时高峰照拦')

  const off = await callSet(harness, { enabled: false })
  eq(off.captured.status, 200, 'HTTP 状态')
  eq(off.json().enabled, false, '返回新状态')
  eq(off.json().enabledSource, 'switch', '来源=开关')

  const spyAfter = spyNext()
  await drain(listener({ provider: 'deepseek', model: 'm' }, spyAfter.next))
  eq(spyAfter.calls.count, 1, '关掉后一律放行')

  const back = await callSet(harness, { enabled: true })
  eq(back.json().enabled, true, '再打开')
  const spyBack = spyNext()
  await drain(listener({ provider: 'deepseek', model: 'm' }, spyBack.next))
  eq(spyBack.calls.count, 0, '打开后恢复拦截')
})

await checkAsync('POST /peak-guard/set 的两道闸：自定义头与同源', async () => {
  const harness = makeCtx()
  apply(harness.ctx, FULL_PEAK)

  // 缺 x-peak-guard 头（跨站表单能做到的那种请求）
  const noHeader = await callSet(harness, { enabled: false }, { host: '127.0.0.1:19387' })
  eq(noHeader.captured.status, 403, '缺自定义头 → 403')
  eq(noHeader.json().error, 'missing-guard-header', '错误码')

  // 头对了，但 origin 不同源
  const crossOrigin = await callSet(harness, { enabled: false }, { 'x-peak-guard': '1', host: '127.0.0.1:19387', origin: 'https://evil.example' })
  eq(crossOrigin.captured.status, 403, '跨站 → 403')
  eq(crossOrigin.json().error, 'cross-origin', '错误码')

  // 同源（带 origin 且与 host 一致）放行
  const sameOrigin = await callSet(harness, { enabled: false }, { 'x-peak-guard': '1', host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' })
  eq(sameOrigin.captured.status, 200, '同源 → 200')
})

await checkAsync('写接口的其它坏输入：方法/字段/类型/体积', async () => {
  const harness = makeCtx()
  apply(harness.ctx, FULL_PEAK)
  const set = routeHandler(harness, '/peak-guard/set')

  const wrongMethod = fakeResponse()
  await set(fakeRequest({ method: 'GET', url: '/peak-guard/set' }), wrongMethod)
  eq(wrongMethod.captured.status, 405, 'GET 写接口 → 405')

  const unknownField = await callSet(harness, { enabled: true, 起飞: 1 })
  eq(unknownField.captured.status, 400, '未知字段 → 400')
  ok(unknownField.json().error.includes('unknown-field'), '错误码')

  const wrongType = await callSet(harness, { enabled: 'yes' })
  eq(wrongType.captured.status, 400, '类型不对 → 400')

  const badJson = fakeResponse()
  await set(fakeRequest({ method: 'POST', url: '/peak-guard/set', headers: { 'x-peak-guard': '1' }, body: '{不是 json' }), badJson)
  eq(badJson.captured.status, 400, '坏 JSON → 400')
  eq(badJson.json().error, 'body-not-json', '错误码')

  const tooBig = fakeResponse()
  await set(fakeRequest({ method: 'POST', url: '/peak-guard/set', headers: { 'x-peak-guard': '1' }, body: JSON.stringify({ enabled: true, pad: 'x'.repeat(9000) }) }), tooBig)
  eq(tooBig.captured.status, 400, '超大 body → 400')
  eq(tooBig.json().error, 'body-too-large', '错误码')
})

check('HTTP 辅助函数：路径去 query / 头大小写 / 坏 origin', () => {
  eq(pathname({ url: '/peak-guard/state?a=1' }), '/peak-guard/state', '去 query')
  eq(header({ headers: { 'X-Peak-Guard': '1' } }, 'x-peak-guard'), '1', '头名大小写不敏感')
  eq(sameOrigin({ headers: { origin: 'not a url', host: 'x' } }), false, '坏 origin 拒绝')
  eq(sameOrigin({ headers: { host: 'x' } }), true, '没有 origin = 本机调用，放行')
})

await checkAsync('开关落盘：换一个进程重新 apply 仍然记得', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-guard-'))
  const file = join(dir, 'state.json')
  try {
    const first = makeCtx()
    apply(first.ctx, { ...FULL_PEAK, statePath: file })
    await callSet(first, { enabled: false })
    ok(existsSync(file), 'state.json 应已写出')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    eq(saved.enabled, false, '落盘内容')

    // 模拟重启：新的 ctx / 新的 apply 读同一个文件
    const second = makeCtx()
    apply(second.ctx, { ...FULL_PEAK, statePath: file })
    const spy = spyNext()
    await drain(second.streamListener()({ provider: 'deepseek', model: 'm' }, spy.next))
    eq(spy.calls.count, 1, '重启后仍然记得「关」')
    eq(second.routes.length, 2, '路由照旧注册')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await checkAsync('老状态文件里的 queue 会被当成 list 读回来（不丢用户记录）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-guard-legacy-'))
  const file = join(dir, 'state.json')
  try {
    // 上一版（「谷时补答队列」）写下的形状
    writeFileSync(file, JSON.stringify({
      enabled: true,
      autoReplay: false,
      queue: [{ id: 'old-1', sessionId: 'session-old', preview: '上一版记下的请求', atMs: 1_700_000_000_000, status: 'pending' }],
      updatedAt: Date.now(),
    }), 'utf8')
    const harness = makeCtx()
    apply(harness.ctx, { ...FULL_PEAK, statePath: file })
    const response = fakeResponse()
    await routeHandler(harness, '/peak-guard/state')(fakeRequest({ method: 'GET', url: '/peak-guard/state' }), response)
    const body = response.json()
    eq(body.listCount, 1, '老队列被搬进 list')
    eq(body.list[0].preview, '上一版记下的请求', '内容还在')
    ok(!('queue' in body), '对外不再有 queue 字段')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await checkAsync('POST /peak-guard/set 的 check：把某条勾成已办并落盘，坏输入一律 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-guard-check-'))
  const file = join(dir, 'state.json')
  try {
    const harness = makeCtx()
    apply(harness.ctx, { ...FULL_PEAK, statePath: file })
    await drain(harness.streamListener()({
      provider: 'deepseek', model: 'm', sessionId: 'session-check',
      messages: [{ role: 'user', content: [{ type: 'text', text: '勾我' }] }],
    }, spyNext().next))

    const before = fakeResponse()
    await routeHandler(harness, '/peak-guard/state')(fakeRequest({ method: 'GET', url: '/peak-guard/state' }), before)
    const item = before.json().list[0]
    eq(item.done, false, '默认待办')

    const marked = await callSet(harness, { check: { id: item.id, done: true } })
    eq(marked.captured.status, 200, '勾选成功')
    eq(marked.json().list[0].done, true, '回执里已是已办')
    eq(JSON.parse(readFileSync(file, 'utf8')).list[0].done, true, '落盘')

    const undo = await callSet(harness, { check: { id: item.id, done: false } })
    eq(undo.json().list[0].done, false, '取消勾选')
    eq(JSON.parse(readFileSync(file, 'utf8')).list[0].done, undefined, '取消后不再写 done 字段')

    eq((await callSet(harness, { check: { id: 'nope', done: true } })).captured.status, 400, '不存在的 id → 400')
    eq((await callSet(harness, { check: { id: item.id, done: 'yes' } })).captured.status, 400, 'done 必须是布尔')
    eq((await callSet(harness, { check: { id: '', done: true } })).captured.status, 400, '空 id → 400')
    eq((await callSet(harness, { check: 'x' })).captured.status, 400, 'check 必须是对象')
    eq((await callSet(harness, { check: { id: item.id, done: true, extra: 1 } })).captured.status, 400, 'check 里的未知字段 → 400')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await checkAsync('设置页接口：?limit 分页、checkAll 批量已办、remove 删除、clear 清空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-guard-manage-'))
  const file = join(dir, 'state.json')
  try {
    const harness = makeCtx()
    apply(harness.ctx, { ...FULL_PEAK, statePath: file })
    const listener = harness.streamListener()
    for (const text of ['第一条', '第二条', '第三条']) {
      await drain(listener({
        provider: 'deepseek', model: 'm', sessionId: `session-${text}`,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      }, spyNext().next))
    }

    const viaQuery = fakeResponse()
    await routeHandler(harness, '/peak-guard/state')(
      fakeRequest({ method: 'GET', url: '/peak-guard/state?limit=200' }), viaQuery)
    eq(viaQuery.json().listCount, 3, '带 limit 返回全部')
    const badLimit = fakeResponse()
    await routeHandler(harness, '/peak-guard/state')(
      fakeRequest({ method: 'GET', url: '/peak-guard/state?limit=abc' }), badLimit)
    eq(badLimit.json().listCount, 3, '坏 limit 退回默认，不报错')
    ok(typeof viaQuery.json().version === 'string' && viaQuery.json().version !== 'unknown',
      `版本号透出给设置页：${viaQuery.json().version}`)

    const allDone = await callSet(harness, { checkAll: true })
    eq(allDone.captured.status, 200, 'checkAll 成功')
    eq(allDone.json().list.every((item) => item.done === true), true, '三条都成已办')
    eq(JSON.parse(readFileSync(file, 'utf8')).list.every((item) => item.done === true), true, '落盘')
    eq((await callSet(harness, { checkAll: 'yes' })).captured.status, 400, 'checkAll 必须布尔')

    const ids = allDone.json().list.map((item) => item.id)
    const removed = await callSet(harness, { remove: [ids[0]] })
    eq(removed.json().listCount, 2, '删掉一条剩两条')
    ok(!removed.json().list.some((item) => item.id === ids[0]), '删掉的那条不在了')
    eq((await callSet(harness, { remove: 'nope' })).captured.status, 400, 'remove 必须是数组')
    eq((await callSet(harness, { remove: [1] })).captured.status, 400, 'remove 里必须都是字符串')

    const cleared = await callSet(harness, { clear: true })
    eq(cleared.json().listCount, 0, '清空后 0 条')
    eq(JSON.parse(readFileSync(file, 'utf8')).list.length, 0, '落盘也是空')
    eq((await callSet(harness, { clear: false })).captured.status, 400, 'clear 只认 true')

    const noHeader = await callSet(harness, { clear: true }, { host: '127.0.0.1:19387' })
    eq(noHeader.captured.status, 403, '这几个字段同样过写接口的两道闸')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await checkAsync('关展示框：未处理的标为「跳过」+ 从此默认不展示已办；restore 恢复成待办（单向）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-guard-dismiss-'))
  const file = join(dir, 'state.json')
  try {
    const harness = makeCtx()
    apply(harness.ctx, { ...FULL_PEAK, statePath: file })
    const listener = harness.streamListener()
    for (const text of ['甲', '乙', '丙']) {
      await drain(listener({
        provider: 'deepseek', model: 'm', sessionId: `session-${text}`,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      }, spyNext().next))
    }

    const before = fakeResponse()
    await routeHandler(harness, '/peak-guard/state')(fakeRequest({ method: 'GET', url: '/peak-guard/state' }), before)
    const first = before.json().list[0]
    eq(before.json().dismissedAtMs, null, '还没关过：dismissedAtMs=null')
    await callSet(harness, { check: { id: first.id, done: true } })

    const dismissed = await callSet(harness, { dismiss: true })
    eq(dismissed.captured.status, 200, 'dismiss 成功')
    const body = dismissed.json()
    ok(typeof body.dismissedAtMs === 'number' && body.dismissedAtMs > 0, '记下了关闭时刻')
    const firstAfter = body.list.find((item) => item.id === first.id)
    ok(firstAfter.doneAt <= body.dismissedAtMs, '关闭前就已办的那条：doneAt ≤ 关闭时刻 → 会被收起')
    const skipped = body.list.filter((item) => item.skippedAt !== null)
    eq(skipped.length, 2, '两条未处理的被标记为跳过（已办那条不动）')
    ok(!skipped.some((item) => item.id === first.id), '已办的那条不会被标跳过')
    ok(skipped.every((item) => typeof item.skippedAt === 'number' && item.skippedAt > 0), '带时间戳')
    eq(body.list.filter((item) => item.done !== true && item.skippedAt === null).length, 0, '没有正常待办剩下了')

    const saved = JSON.parse(readFileSync(file, 'utf8'))
    eq(typeof saved.dismissedAtMs, 'number', '关闭时刻落盘')
    eq(saved.list.filter((item) => item.skippedAt !== undefined).length, 2, '跳过戳落盘')

    const second = makeCtx()
    apply(second.ctx, { ...FULL_PEAK, statePath: file })
    const after = fakeResponse()
    await routeHandler(second, '/peak-guard/state')(fakeRequest({ method: 'GET', url: '/peak-guard/state' }), after)
    eq(after.json().dismissedAtMs, body.dismissedAtMs, '重启后关闭时刻还在')
    eq(after.json().list.filter((item) => item.skippedAt !== null).length, 2, '重启后跳过戳还在')

    const restored = await callSet(second, { restore: [skipped[0].id] })
    eq(restored.captured.status, 200, 'restore 成功')
    eq(restored.json().list.find((item) => item.id === skipped[0].id).skippedAt, null, '这条恢复成正常待办')
    eq(restored.json().list.filter((item) => item.skippedAt !== null).length, 1, '另一条仍是跳过')
    eq(JSON.parse(readFileSync(file, 'utf8')).list.find((item) => item.id === skipped[0].id).skippedAt, undefined,
      '恢复后字段直接从文件里去掉')

    // 关闭之后才标已办的：doneAt 必须晚于关闭时刻（卡片据此继续展示它）
    const later = await callSet(second, { check: { id: skipped[1].id, done: true } })
    const laterItem = later.json().list.find((item) => item.id === skipped[1].id)
    ok(laterItem.doneAt > body.dismissedAtMs, `关闭后才办的 doneAt(${laterItem.doneAt}) 应晚于 dismissedAtMs(${body.dismissedAtMs})`)

    eq((await callSet(second, { restore: 'nope' })).captured.status, 400, 'restore 必须是数组')
    eq((await callSet(second, { dismiss: false })).captured.status, 400, 'dismiss 只认 true')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await checkAsync('默认路径下会留一份 last-apply.json（判断新代码有没有生效的排障件）', () => {
  const harness = makeCtx()
  apply(harness.ctx, { ...FULL_PEAK, statePath: undefined }) // undefined = 走 <DSH_HOME> 默认路径
  const file = join(HERMETIC_HOME, 'plugin-data', PLUGIN_NAME, 'last-apply.json')
  ok(existsSync(file), `应写出 ${file}`)
  const record = JSON.parse(readFileSync(file, 'utf8'))
  eq(record.plugin, PLUGIN_NAME, 'plugin')
  eq(record.stage, 'ready', '最后一次 trace 应是 ready 阶段')
  eq(record.routes, true, '路由已注册')
  eq(record.commands, true, '命令已注册')
  eq(typeof record.pid, 'number', 'pid')
  ok(typeof record.at === 'string' && record.at.includes('T'), 'ISO 时间戳')
})

await checkAsync('commands / webServer 都缺席时：拦截照旧，命令与界面缺席', async () => {
  const harness = makeCtx({ withCommands: false, withWebServer: false })
  apply(harness.ctx, FULL_PEAK)
  eq(harness.commands.length, 0, '没有命令')
  eq(harness.routes.length, 0, '没有路由')
  const spy = spyNext()
  const chunks = await drain(harness.streamListener()({ provider: 'deepseek', model: 'm' }, spy.next))
  eq(spy.calls.count, 0, '拦截照旧生效')
  eq(assembleMirror(chunks).blocks[0].text, JOKE, '照旧回那句话')
})

await checkAsync('没有 ctx.inject 的老宿主：退回直接注册，缺服务只告警不抛错', async () => {
  const harness = makeCtx({ withWebServer: false, injectMode: 'absent' })
  apply(harness.ctx, FULL_PEAK)
  eq(harness.routes.length, 0, '没有路由')
  ok(harness.logs.some(([level, , message]) => level === 'warn' && message.includes('界面路由')), '应告警说明路由没注册')
  const spy = spyNext()
  await drain(harness.streamListener()({ provider: 'deepseek', model: 'm' }, spy.next))
  eq(spy.calls.count, 0, '拦截照旧生效')
})

// ── 6. fail-open：畸形输入必须放行而不是抛错 ────────────────────────────────

await checkAsync('options 为 null / 抛错 getter：不抛错', async () => {
  const harness = makeCtx()
  apply(harness.ctx, FULL_PEAK)
  const listener = harness.streamListener()

  // null options 不是错误：全天高峰配置下它就该被拦。
  const spyNull = spyNext()
  const fromNull = await drain(listener(null, spyNull.next))
  eq(spyNull.calls.count, 0, 'null options 在全天高峰下仍拦下')
  eq(assembleMirror(fromNull).blocks[0].text, JOKE, 'null options 也回那句话')

  // 真正的 fail-open：内部逻辑一旦抛错，必须把调用让给真模型。
  const hostile = {}
  Object.defineProperty(hostile, 'sessionId', { get() { throw new Error('boom') } })
  const spyHostile = spyNext()
  await drain(listener(hostile, spyHostile.next))
  eq(spyHostile.calls.count, 1, 'getter 抛错时放行')
  ok(harness.logs.some(([level, , message]) => level === 'warn' && message.includes('fail-open')), '应留下 fail-open 告警')
})

await checkAsync('next 不是函数时不抛错', () => {
  const harness = makeCtx()
  apply(harness.ctx, FULL_PEAK)
  const returned = harness.streamListener()({ provider: 'deepseek', model: 'm' }, undefined)
  eq(returned, undefined, '原样返回')
})

await checkAsync('apply 面对垃圾 ctx / 垃圾 config 都不抛错（下面这段故意制造错误日志）', () => {
  const originalInfo = console.info
  const originalWarn = console.warn
  console.info = () => {}
  console.warn = () => {}
  try {
    for (const [ctx, config] of [
      [undefined, {}],
      [{}, {}],
      [makeCtx().ctx, 12345],
      [makeCtx().ctx, null],
      [makeCtx({ withLogger: false }).ctx, { peakWindows: 'broken', holidays: 1, allowSessions: 'nope' }],
      [{ on() { throw new Error('on 挂了') } }, FULL_PEAK],
    ]) {
      apply(ctx, config)
    }
  } finally {
    console.info = originalInfo
    console.warn = originalWarn
  }
})

// ── 汇总 ────────────────────────────────────────────────────────────────────

try {
  rmSync(HERMETIC_HOME, { recursive: true, force: true })
} catch {
  /* 临时目录清不掉就算了 */
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败：`)
  for (const failure of failures) console.error(`   ✗ ${failure}`)
}
console.log(`\nplugin.test.mjs：${passed} 项通过，${failures.length} 项失败`)
process.exit(failures.length === 0 ? 0 : 1)
