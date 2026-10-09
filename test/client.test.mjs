/**
 * dsh-peak-guard · 客户端半边离线测试
 *
 * 没有浏览器控制的情况下，这是能对 UI 半边做的最强验收（对应官方 skill 的
 * references/verification.md 精神：装上了、注册了 ≠ 用户能看到什么）。它证明：
 *   1. 模块形态符合官方模板：`window.__ModuleLoader__.load({id, factory})`，
 *      id 等于包名，factory 返回 `{inject, apply}`；
 *   2. `apply` 真的往 `conversation.input.left` 注册了一个带 id 的条目
 *      （list 插槽没有 id 会抛错，所以这条必须过）；
 *   3. **样式只用了主题令牌** `--dsw-alias-*`，没有硬编码颜色 —— 官方 skill 明写的硬规矩；
 *   4. 组件在各种宿主状态下都能渲染出正确的 `aria-checked` / 提示文案，且不抛错；
 *   5. factory 里没有副作用（材质化时不碰 document）。
 *
 * 跑法：node test/client.test.mjs
 */
import { readFileSync } from 'node:fs'

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

function eq(actual, expected, what) {
  if (!Object.is(actual, expected)) throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function ok(value, what) {
  if (!value) throw new Error(`${what}：期望为真，实际 ${JSON.stringify(value)}`)
}

// ── 浏览器替身 ──────────────────────────────────────────────────────────────

/** 极简 React：够把组件函数调用一次并检查产出的元素树。 */
let useStateQueue = []
const FakeReact = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.filter((child) => child !== null && child !== undefined) } }
  },
  useState(initial) {
    // 队列里预置了值就用预置的（用来把组件渲染进某个宿主状态），否则用初始值。
    const seeded = useStateQueue.length > 0 ? useStateQueue.shift() : undefined
    return [seeded !== undefined ? seeded : typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
}

/** 抓取 factory：模拟浏览器里的 __ModuleLoader__。 */
function loadClient({ reactAvailable = true, withSlots = true, state = null, fetchResult } = {}) {
  const registrations = []
  const effects = []
  const calls = []
  const doc = { head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }) }
  const recorded = { id: undefined, factory: undefined }

  const windowStub = {
    __ModuleLoader__: {
      load(entry) {
        recorded.id = entry.id
        recorded.factory = entry.factory
      },
    },
    addEventListener() {},
    removeEventListener() {},
  }
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (fetchResult !== undefined) return fetchResult(url, options)
    if (url.endsWith('/state')) return { ok: true, json: async () => ({ ok: true, ...(state ?? {}) }) }
    return { ok: true, json: async () => ({ ok: true, ...(state ?? {}) }) }
  }
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 客户端产物只在浏览器里跑：给它 window / document / console / fetch / navigator。
  const factory = new Function(
    'window',
    'document',
    'console',
    'fetch',
    'navigator',
    'setInterval',
    'clearInterval',
    code,
  )
  factory(
    windowStub,
    doc,
    { log() {}, error() {} },
    fetchImpl,
    { language: 'zh-CN' },
    () => 0,
    () => {},
  )

  const exports = recorded.factory((name) => {
    if (name === 'react' && reactAvailable) return FakeReact
    throw new Error(`unknown module: ${name}`)
  })

  const ctx = {
    effect(callback, label) {
      effects.push(label)
      return callback()
    },
  }
  if (withSlots) {
    ctx.slots = {
      inject(name, callback) {
        registrations.push({ via: 'inject', name })
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ via: 'register', options, component })
        return () => {}
      },
    }
  }
  return { recorded, exports, ctx, registrations, effects, calls }
}

/** 按 class 找节点（找第一个）。 */
function findByClass(node, className) {
  if (node === null || typeof node !== 'object') return undefined
  const list = Array.isArray(node.props?.className) ? node.props.className : String(node.props?.className ?? '').split(/\s+/)
  if (list.includes(className)) return node
  for (const child of node.props?.children ?? []) {
    const hit = findByClass(child, className)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 找所有匹配 class 的节点。 */
function findAllByClass(node, className, out = []) {
  if (node === null || typeof node !== 'object') return out
  const list = Array.isArray(node.props?.className) ? node.props.className : String(node.props?.className ?? '').split(/\s+/)
  if (list.includes(className)) out.push(node)
  for (const child of node.props?.children ?? []) findAllByClass(child, className, out)
  return out
}

/** 在元素树里找第一个 type 匹配的节点。 */
function find(node, type) {
  if (node === null || typeof node !== 'object') return undefined
  if (node.type === type) return node
  for (const child of node.props?.children ?? []) {
    const hit = find(child, type)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 把渲染结果里所有文本收集起来（含 tooltip）；数组会被摊平。 */
function texts(node, out = []) {
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  for (const child of node.props?.children ?? []) texts(child, out)
  return out
}

// ── 1. 模块形态 ─────────────────────────────────────────────────────────────

check('模块用官方模板形态注册，id 等于包名', () => {
  const { recorded } = loadClient()
  eq(recorded.id, 'dsh-peak-guard', 'id 必须是包名')
  eq(typeof recorded.factory, 'function', 'factory 是函数')
})

check('factory 返回 { inject, apply }，且 inject 只要 slots', () => {
  const { exports } = loadClient()
  eq(typeof exports.apply, 'function', 'apply 是函数')
  ok(Array.isArray(exports.inject), 'inject 是数组')
  eq(exports.inject.join(','), 'slots', '只声明 slots（多声明缺席的服务会让 fiber 停 PENDING）')
})

check('factory 里没有副作用：不碰 document、不注册插槽', () => {
  const { registrations, effects } = loadClient()
  eq(registrations.length, 0, 'factory 阶段不应注册插槽')
  eq(effects.length, 0, 'factory 阶段不应登记 effect')
})

// ── 2. 插槽注册 ─────────────────────────────────────────────────────────────

check('apply 往 conversation.input.left 注册带 id 的条目', () => {
  const { exports, ctx, registrations, effects } = loadClient()
  exports.apply(ctx)
  const inject = registrations.find((entry) => entry.via === 'inject')
  ok(inject !== undefined, '应通过 slots.inject 等插槽就绪')
  eq(inject.name, 'conversation.input.left', '插槽名')
  const register = registrations.find((entry) => entry.via === 'register')
  ok(register !== undefined, '应调用 slots.register')
  eq(register.options.name, 'conversation.input.left', '注册的 name 与插槽一致')
  eq(register.options.id, 'peak-guard-toggle', 'list 插槽必须有 id')
  eq(typeof register.options.order, 'number', 'order 是数字')
  eq(typeof register.options.label, 'function', 'label 是 thunk（跟随语言/主题读取）')
  eq(register.options.label(), '高峰保护', '中文环境下的标签')
  eq(typeof register.component, 'function', '注册的是组件函数')
  ok(effects.some((label) => String(label).includes('styles')), '样式应通过 ctx.effect 登记（可回收）')
})

check('拿不到 slots 服务时只报错、不抛出', () => {
  const { exports, ctx } = loadClient({ withSlots: false })
  exports.apply(ctx) // 不应该 throw
})

// ── 3. 官方硬规矩：样式只用主题令牌 ─────────────────────────────────────────

check('CSS 只用 DSH 的设计/布局令牌，没有硬编码颜色', () => {
  const { exports } = loadClient()
  const css = exports.__internals.CSS
  const variables = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1])
  ok(variables.length >= 8, `应大量使用令牌，实际 ${variables.length} 处`)
  // 允许三类：--dsw-alias-*（语义色）、--dsw-*（设计系统：圆角/阴影/焦点环/面板底）、
  // --dsh-*（布局：composer 宽度与内缩）。都是 DSH 自己的令牌，不是硬编码值。
  const foreign = variables.filter((name) => !name.startsWith('--dsw-') && !name.startsWith('--dsh-'))
  eq(foreign.join(','), '', '出现了非 DSH 令牌的变量')
  // 颜色只能来自令牌；box-shadow 里允许纯黑阴影（官方组件也这么写）。
  const colors = [...css.matchAll(/(#[0-9a-fA-F]{3,8}|rgb\([^)]*\)|hsl\([^)]*\))/g)].map((match) => match[1])
  const suspicious = colors.filter((value) => !/^rgb\(0 0 0/.test(value))
  eq(suspicious.join(','), '', '出现了硬编码颜色')
})

check('卡片宽度用官方那套 composer 变量（所以跟聊天区一样宽）', () => {
  const { exports } = loadClient()
  const css = exports.__internals.CSS
  const rule = /\.pk-card\{[^}]*\}/.exec(css)
  ok(rule !== null, '有 .pk-card 规则')
  const text = rule[0]
  ok(text.includes('var(--dsh-composer-card-max-width)'), 'max-width 用官方 composer 卡片宽度变量')
  ok(text.includes('var(--dsh-composer-side-clearance)'), '宽度扣掉侧向留白')
  ok(text.includes('var(--dsh-composer-dock-inset)'), '宽度扣掉 dock 内缩')
  ok(text.includes('margin:0 auto'), '居中')
  const body = /\.pk-card__body\{[^}]*\}/.exec(css)
  ok(body !== null && body[0].includes('padding:6px 12px'), '内边距在 __body 上（照官方结构）')
})

check('样式带自己的清理函数（卸载即摘掉 <style>）', () => {
  const { exports } = loadClient()
  const dispose = exports.__internals.installStyles()
  eq(typeof dispose, 'function', 'installStyles 返回 disposer')
  dispose()
})

// ── 4. 状态 → 外观/文案 ─────────────────────────────────────────────────────

check('describe：开关关闭时提示怎么打开', () => {
  const { exports } = loadClient()
  const view = exports.__internals.describe({ enabled: false, peak: true, hardOff: false }, false)
  eq(view.on, false, 'on=false')
  eq(view.blocking, false, '关着就不会拦')
  eq(view.unavailable, false, '状态正常')
  ok(view.lines.some((line) => line.includes('点击打开')), `应提示打开：${JSON.stringify(view.lines)}`)
})

check('describe：高峰 + 开着 = 正在拦，并给出谷时倒计时', () => {
  const { exports } = loadClient()
  const next = Date.now() + 3 * 3600_000 + 12 * 60_000
  const view = exports.__internals.describe(
    { enabled: true, peak: true, hardOff: false, blockedCount: 3, nextTransitionAt: next, nextIntoPeak: false, remainingMs: next - Date.now(), snoozeUntilMs: null },
    false,
  )
  eq(view.on, true, 'on=true')
  eq(view.blocking, true, 'blocking=true')
  ok(view.lines.some((line) => line.includes('会被拦下')), '应说明正在拦')
  ok(view.lines.some((line) => line.includes('谷时') && line.includes('开始')), '应给出谷时开始时刻')
  ok(view.lines.some((line) => line.includes('3 次')), '应报拦截次数')
})

check('describe：谷时 + 开着 = 待命，并给出下一段高峰', () => {
  const { exports } = loadClient()
  const next = Date.now() + 2 * 86400_000 + 11 * 3600_000
  const view = exports.__internals.describe(
    { enabled: true, peak: false, hardOff: false, blockedCount: 0, nextTransitionAt: next, nextIntoPeak: true, remainingMs: next - Date.now(), snoozeUntilMs: null },
    false,
  )
  eq(view.blocking, false, '不在拦')
  ok(view.lines.some((line) => line.includes('放行')), '应说明放行')
  ok(view.lines.some((line) => line.includes('下一段高峰') && line.includes('2 天')), `应给出下一段高峰与天数：${JSON.stringify(view.lines)}`)
  ok(!view.lines.some((line) => line.includes('次模型调用')), '没拦过就不该报计数')
})

check('describe：宿主没就绪 / 环境变量关停都说清楚', () => {
  const { exports } = loadClient()
  const down = exports.__internals.describe(null, true)
  eq(down.unavailable, true, 'unavailable')
  ok(down.lines.some((line) => line.includes('宿主半边未就绪')), '应说明宿主未就绪')
  const killed = exports.__internals.describe({ enabled: true, peak: false, hardOff: true }, false)
  ok(killed.lines.some((line) => line.includes('DSH_PEAK_GUARD')), '应说明被环境变量关掉')
})

check('shortDuration / localClock 边界', () => {
  const { exports } = loadClient()
  const { shortDuration, localClock } = exports.__internals
  ok(shortDuration(3 * 3600_000 + 12 * 60_000).includes('3 小时 12 分'), '3h12m')
  ok(shortDuration(2 * 86400_000 + 11 * 3600_000).includes('2 天 11 小时'), '2d11h')
  ok(shortDuration(0).includes('0 分'), '0 分')
  ok(/^\d{2}:\d{2}$/.test(localClock(Date.now())), 'HH:MM')
  eq(localClock('nonsense'), '--:--', '坏输入不炸')
})

// ── 5. 渲染 ─────────────────────────────────────────────────────────────────

/**
 * 把组件渲染进指定的宿主状态。
 * 组件的状态来自共享 store（`__internals.store`），所以这里直接摆 store；
 * hook 顺序：usePeakGuardState 里的计数器 → 其余 useState 按声明顺序。
 */
function renderWith(exports, state, { failed = false, busy = false, tipOpen = false, tip = null } = {}) {
  exports.__internals.store.state = state
  exports.__internals.store.failed = failed
  useStateQueue = [0, busy, tipOpen, tip]
  try {
    return exports.__internals.PeakGuardToggle()
  } finally {
    useStateQueue = []
  }
}

/** 渲染待补答面板（hook：计数器 → busy → confirming → expandOverride → notice）。 */
function renderStrip(exports, state, { expandOverride = null } = {}) {
  exports.__internals.store.state = state
  exports.__internals.store.failed = false
  // usePeakGuardState 自己先吃掉一个 useState（内部的重渲染计数器），然后才是展开覆盖值
  useStateQueue = [0, expandOverride]
  try {
    return exports.__internals.PendingCard()
  } finally {
    useStateQueue = []
  }
}

/** 渲染设置页「拦截记录」；hook 顺序：snapshot / failed / tab / query / busy / confirmClear / notice（无 usePeakGuardState）。 */
function renderSection(exports, state) {
  exports.__internals.store.state = state
  exports.__internals.store.failed = false
  useStateQueue = [state ?? null, false, 'all', '', false, false, null]
  try {
    return exports.__internals.BlockedSection()
  } finally {
    useStateQueue = []
  }
}

check('组件在「开着 + 高峰」下渲染出 role=switch / aria-checked=true 与提示点', () => {
  const { exports } = loadClient()
  const rendered = renderWith(exports, {
    enabled: true,
    peak: true,
    hardOff: false,
    blockedCount: 2,
    nextTransitionAt: Date.now() + 3600_000,
    nextIntoPeak: false,
    remainingMs: 3600_000,
    snoozeUntilMs: null,
  })
  const button = find(rendered, 'button')
  ok(button !== undefined, '应有 button')
  eq(button.props.role, 'switch', 'role=switch')
  eq(button.props['aria-checked'], true, 'aria-checked')
  eq(button.props['data-on'], 'true', 'data-on')
  eq(button.props['data-blocking'], 'true', 'data-blocking')
  eq(typeof button.props.onClick, 'function', '可点击')
})

check('组件在「关着」下 aria-checked=false 且不是不可用态', () => {
  const { exports } = loadClient()
  const button = find(renderWith(exports, { enabled: false, peak: true, hardOff: false, blockedCount: 0, snoozeUntilMs: null }), 'button')
  eq(button.props['aria-checked'], false, 'aria-checked')
  eq(button.props['data-unavailable'], 'false', '状态拿到了，不是不可用')
  eq(button.props['data-blocking'], 'false', '关着不会拦')
})

check('组件在「还没拿到状态」下渲染为不可用态，且不抛错', () => {
  const { exports } = loadClient()
  const rendered = renderWith(exports, null)
  const button = find(rendered, 'button')
  eq(button.props['data-unavailable'], 'true', 'data-unavailable')
  eq(button.props['aria-checked'], false, '未就绪按关闭呈现')
})

check('渲染里没有裸 <script>/dangerous 注入，且 aria-label 非空', () => {
  const { exports } = loadClient()
  const button = find(exports.__internals.PeakGuardToggle(), 'button')
  ok(typeof button.props['aria-label'] === 'string' && button.props['aria-label'].length > 0, 'aria-label 必填')
  eq(find(exports.__internals.PeakGuardToggle(), 'script'), undefined, '不应插 script')
})

check('悬浮/聚焦时按锚点渲染 tooltip（fixed 定位，不会被输入区裁剪）', () => {
  const { exports } = loadClient()
  const rendered = renderWith(
    exports,
    { enabled: true, peak: true, hardOff: false, blockedCount: 4, nextTransitionAt: Date.now() + 3600_000, nextIntoPeak: false, remainingMs: 3600_000, snoozeUntilMs: null },
    { tipOpen: true, tip: { left: 12, bottom: 34 } },
  )
  const tip = find(rendered, 'div')
  const tooltip = (function seek(node) {
    if (node === null || typeof node !== 'object') return undefined
    if (node.props?.className === 'pk-guard__tip') return node
    for (const child of node.props?.children ?? []) {
      const hit = seek(child)
      if (hit !== undefined) return hit
    }
    return undefined
  })(rendered)
  ok(tooltip !== undefined, '应渲染 tooltip')
  eq(tooltip.props.role, 'tooltip', 'role=tooltip')
  eq(tooltip.props.style.left, '12px', '锚点 left')
  eq(tooltip.props.style.bottom, '34px', '锚点 bottom')
  const all = texts(tooltip).join(' | ')
  ok(all.includes('高峰保护已开启'), `应含标题：${all}`)
  ok(all.includes('4 次'), `应含拦截计数：${all}`)
  ok(tip !== undefined, '（占位，确保上面的变量被使用）')
})

check('tipOpen 但还没量到坐标时不渲染气泡（避免 NaN 定位）', () => {
  const { exports } = loadClient()
  const rendered = renderWith(exports, { enabled: true, peak: false, hardOff: false, blockedCount: 0, snoozeUntilMs: null }, { tipOpen: true, tip: null })
  eq(find(rendered, 'div') !== undefined, true, '根节点仍在')
  const hasTip = texts(rendered).some((line) => line.includes('高峰保护已开启'))
  eq(hasTip, false, '不应出现气泡文案')
})

// ── 6. 待补答面板 ───────────────────────────────────────────────────────────

/** 造一个带队列的宿主状态。 */
function listState(count, { truncated = false } = {}) {
  return {
    enabled: true,
    peak: false,
    hardOff: false,
    nextTransitionAt: Date.now() + 3600_000,
    nextIntoPeak: true,
    remainingMs: 3600_000,
    snoozeUntilMs: null,
    blockedCount: count,
    tone: 'polite',
    listCount: count,
    listTruncated: truncated,
    // 宿主给的就是「最新在前」
    list: Array.from({ length: count }, (_, index) => ({
      id: `q${index}`,
      sessionId: `session-${index}`,
      preview: `第 ${index + 1} 个被拦下的请求`,
      atMs: Date.now() - index * 60_000,
    })),
  }
}

check('三个插槽：开关注册到 input.left、卡片到 input.dock、设置页到 settings.section', () => {
  const { exports, ctx, registrations } = loadClient()
  exports.apply(ctx)
  const slots = registrations.filter((entry) => entry.via === 'register').map((entry) => entry.options.name)
  eq(slots.join(','), 'conversation.input.left,conversation.input.dock,settings.section', '三个插槽各一个条目')
  const ids = registrations.filter((entry) => entry.via === 'register').map((entry) => entry.options.id)
  eq(ids.join(','), 'peak-guard-toggle,peak-guard-pending,peak-guard-records', 'id 不重复')
  const labels = registrations.filter((entry) => entry.via === 'register').map((entry) => entry.options.label())
  eq(labels[2], '拦截记录', '设置页在左侧导航里的文案')
})

check('没有记录时：卡片完全不占位', () => {
  const { exports } = loadClient()
  eq(renderStrip(exports, listState(0)), null, '空列表 → 不渲染')
  eq(renderStrip(exports, null), null, '宿主未就绪 → 不渲染')
})

check('条数少（≤3）默认展开列表', () => {
  const { exports } = loadClient()
  const rendered = renderStrip(exports, listState(2))
  const items = findAllByClass(rendered, 'pk-card__item')
  eq(items.length, 2, '两条都列出来')
  ok(texts(rendered).join(' ').includes('高峰期间有 2 条请求被拦下'), '标题带条数')
  ok(texts(rendered).join(' ').includes('没有发给模型'), '说明这些请求没花钱')
  const chev = findByClass(rendered, 'pk-card__iconbtn--chevron')
  eq(chev.props['aria-expanded'], true, '标记为已展开')
  eq(findByClass(rendered, 'pk-card__iconbtn--chevron').props['data-dir'], 'down', '展开态是向下箭头（点它收起）')
})

check('条数多（>3）默认折叠：只剩标题和箭头，且没有任何按钮', () => {
  const { exports } = loadClient()
  const rendered = renderStrip(exports, listState(6))
  eq(findAllByClass(rendered, 'pk-card__item').length, 0, '默认不列条目')
  const chev = findByClass(rendered, 'pk-card__iconbtn--chevron')
  eq(chev.props['aria-expanded'], false, '标记为折叠')
  eq(findByClass(rendered, 'pk-card__iconbtn--chevron').props['data-dir'], 'up', '折叠态是向上箭头（点它展开）')
  // 只读：卡片里只有「折叠」和「关闭」两个图标键，没有会替用户发请求的按钮
  eq(findAllByClass(rendered, 'pk-card__iconbtn').length, 2, '两个图标键（折叠 + 关闭）')
  eq(findAllByClass(rendered, 'pk-btn').length, 0, '没有任何功能按钮')
  eq(findAllByClass(rendered, 'pk-switch').length, 0, '没有开关')
  eq(findAllByClass(rendered, 'pk-modal').length, 0, '没有弹窗')
})

check('手动展开/收起覆盖默认行为', () => {
  const { exports } = loadClient()
  const expanded = renderStrip(exports, listState(6), { expandOverride: true })
  eq(findAllByClass(expanded, 'pk-card__item').length, 6, '手动展开后 6 条都在')
  const collapsed = renderStrip(exports, listState(2), { expandOverride: false })
  eq(findAllByClass(collapsed, 'pk-card__item').length, 0, '手动收起后不列条目')
})

check('列表截断时标题里说明「只显示最新的几条」', () => {
  const { exports } = loadClient()
  const rendered = renderStrip(exports, listState(9, { truncated: true }))
  ok(texts(rendered).join(' ').includes('只显示最新的几条'), '标出截断')
})

check('卡片是纯展示：渲染期间一个写请求都不发', async () => {
  const { exports, calls } = loadClient({ state: listState(3) })
  const rendered = renderStrip(exports, listState(3))
  // 点折叠键（唯一的交互）也不该打任何写接口
  findByClass(rendered, 'pk-card__chevron').props.children[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  eq(calls.filter((call) => call.options?.method === 'POST').length, 0, '没有 POST')
})

// ── 设置页「拦截记录」 ──────────────────────────────────────────────────────

check('设置页：标签页计数与搜索（纯函数）', () => {
  const { exports } = loadClient()
  const list = [
    { id: 'a', sessionId: 'session-alpha', preview: '帮我看看这个报错', atMs: 1, done: false },
    { id: 'b', sessionId: 'session-beta', preview: '把 README 截图换掉', atMs: 2, done: true },
    { id: 'c', sessionId: 'session-gamma', preview: '再跑一遍测试', atMs: 3, done: false },
  ]
  const all = exports.__internals.filterBlocked(list, {})
  eq(all.counts.all, 3, '总数')
  eq(all.counts.todo, 2, '未办数')
  eq(all.counts.done, 1, '已办数')
  eq(all.items.length, 3, '全部标签页给三条')

  eq(exports.__internals.filterBlocked(list, { tab: 'todo' }).items.map((i) => i.id).join(','), 'a,c', '未办标签页')
  eq(exports.__internals.filterBlocked(list, { tab: 'done' }).items.map((i) => i.id).join(','), 'b', '已办标签页')

  eq(exports.__internals.filterBlocked(list, { query: 'README' }).items.length, 1, '按内容搜（大小写不敏感）')
  eq(exports.__internals.filterBlocked(list, { query: 'readme' }).items.length, 1, '小写也命中')
  eq(exports.__internals.filterBlocked(list, { query: 'gamma' }).items.length, 1, '按会话 id 搜')
  eq(exports.__internals.filterBlocked(list, { query: '不存在的词' }).items.length, 0, '搜不到就是空')
  eq(exports.__internals.filterBlocked(list, { tab: 'done', query: '报错' }).items.length, 0, '标签页与搜索叠加')
  eq(exports.__internals.filterBlocked(null, {}).counts.all, 0, '坏输入不抛错')
})

check('设置页：有记录时渲染标题/版本/标签页/搜索/行，且每行有勾选与删除', () => {
  const { exports } = loadClient()
  const state = { ...listState(3), version: '1.0.0' }
  const rendered = renderSection(exports, state)
  const text = texts(rendered).join(' ')
  ok(text.includes('拦截记录'), '标题')
  ok(text.includes('v1.0.0'), '版本号')
  ok(
    text.includes('全部 3') && text.includes('待办 3') && text.includes('已办 0') && text.includes('跳过 0'),
    `标签页带计数：${text.slice(0, 80)}`,
  )
  ok(!text.includes('undefined'), '标签页/行里不能出现 undefined（tabSkipped 曾经漏定义）')
  const input = find(rendered, 'input')
  ok(input !== undefined && String(input.props.placeholder).includes('搜索'), '搜索框')
  eq(findAllByClass(rendered, 'pk-set__row').length, 3, '三行记录')
  eq(findAllByClass(rendered, 'pk-set__tab').length, 4, '四个标签页（全部/待办/已办/跳过）')
  ok(!text.includes('undefined'), '标签页/行里不能出现 undefined（曾经 tabSkipped 漏定义）')
  ok(findAllByClass(rendered, 'pk-card__glyph').length === 3, '每行一个勾选键')
  const removes = findAllByClass(rendered, 'pk-card__iconbtn')
  eq(removes.length, 3, '每行一个删除键')
  eq(removes[0].props['aria-label'], '删除这条记录', '删除键有无障碍标签')
})

check('设置页：没有记录时是空态（收件箱图标 + 文案），不是空白页', () => {
  const { exports } = loadClient()
  const rendered = renderSection(exports, { ...listState(0), version: '1.0.0' })
  eq(findAllByClass(rendered, 'pk-set__row').length, 0, '没有行')
  const empty = findByClass(rendered, 'pk-set__empty')
  ok(empty !== undefined, '有空态容器')
  ok(texts(empty).join(' ').includes('暂无拦截记录'), '空态文案')
  const svg = empty.props.children[0]
  eq(svg.type, exports.__internals.InboxIcon, '空态用收件箱图标')
})

check('设置页：操作会打到宿主接口（勾选 / 删除 / 清空需要二次确认）', async () => {
  const { exports, calls } = loadClient({ state: { ...listState(2), version: '1.0.0' } })
  const rendered = renderSection(exports, { ...listState(2), version: '1.0.0' })

  // 勾选第一行
  await findAllByClass(rendered, 'pk-card__glyph')[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 25))
  const check = calls.filter((call) => call.options?.method === 'POST').pop()
  eq(JSON.parse(check.options.body).check.id, 'q0', '勾选发的是这条的 id')

  // 删除第二行
  await findAllByClass(rendered, 'pk-card__iconbtn')[1].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 25))
  const removed = calls.filter((call) => call.options?.method === 'POST').pop()
  eq(JSON.parse(removed.options.body).remove[0], 'q1', '删除发的是这条的 id')

  // 清空：第一次点是二次确认，不请求
  const clearButton = findAllByClass(rendered, 'pk-set__btn').find((node) => texts(node).join('').includes('清空记录'))
  ok(clearButton !== undefined, '有清空按钮')
  const before = calls.filter((call) => call.options?.method === 'POST').length
  await clearButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 25))
  eq(calls.filter((call) => call.options?.method === 'POST').length, before, '第一次点只进入确认态，不发请求')
})

check('设置页：拉的是完整列表（?limit=200），不是卡片那 20 条', async () => {
  const { exports, calls } = loadClient({ state: listState(3) })
  renderSection(exports, listState(3))
  await new Promise((resolve) => setTimeout(resolve, 25))
  const stateCall = calls.find((call) => call.url.includes('/peak-guard/state'))
  ok(stateCall !== undefined, '拉了状态')
  ok(stateCall.url.includes('limit=200'), `设置页要 200 条：${stateCall.url}`)
})

check('卡片过滤：跳过永不展示；已办看「是不是关闭那一刻之前就办的」', () => {
  const { exports } = loadClient()
  const { cardItems, countUnhandled } = exports.__internals
  const SWEPT = 1000
  const list = [
    { id: 'a', atMs: 10, done: false, doneAt: null, skippedAt: null },   // 正常待办
    { id: 'b', atMs: 20, done: true, doneAt: 900, skippedAt: null },     // 关闭之前就办了 → 收起
    { id: 'c', atMs: 30, done: false, doneAt: null, skippedAt: 999 },    // 跳过 → 永不展示
    { id: 'e', atMs: 40, done: true, doneAt: 1100, skippedAt: null },    // 关闭之后才办的 → 先留着
    { id: 'f', atMs: 50, done: false, doneAt: null, skippedAt: null },   // 正常待办
  ]
  eq(cardItems(list, null).map((i) => i.id).join(','), 'a,b,e,f', '还没关过：已办都留着（方便反悔）')
  eq(cardItems(list, SWEPT).map((i) => i.id).join(','), 'a,e,f', '关过之后：只收起「那一刻之前就已办」的')
  ok(!cardItems(list, SWEPT).some((i) => i.id === 'c'), '跳过的永远不展示')
  // 关键回归：刚勾的已办（doneAt 晚于关闭时刻）不能当场消失
  const justChecked = { id: 'g', atMs: 60, done: true, doneAt: SWEPT + 1, skippedAt: null }
  ok(cardItems([...list, justChecked], SWEPT).some((i) => i.id === 'g'), '关闭之后才标已办的仍留在卡上')
  // 老数据没有 doneAt：退回记录自身时间（当作很早就办了）
  const legacy = { id: 'h', atMs: 10, done: true, skippedAt: null }
  ok(!cardItems([legacy], SWEPT).some((i) => i.id === 'h'), '老数据缺失 doneAt 时按记录时间算')
  eq(countUnhandled(list), 2, '角标只数「还等着处理」的（不含已办、不含跳过）')
  eq(cardItems([], SWEPT).length, 0, '空列表')
})

check('三态图标：点 / 勾 / 空心环+斜杠 共用同一个 SVG，靠 data-state 切换', () => {
  const { exports } = loadClient()
  const glyphState = exports.__internals.glyphState
  eq(glyphState({ done: false, skippedAt: null }), 'todo', '正常待办')
  eq(glyphState({ done: true, skippedAt: null }), 'done', '已办')
  eq(glyphState({ done: false, skippedAt: 123 }), 'skipped', '跳过')
  eq(glyphState({}), 'todo', '缺字段按待办算')

  const todo = exports.__internals.TodoGlyph({ state: 'todo' })
  eq(todo.props['data-glyph'], 'todo', 'svg 带 data-glyph')
  eq(todo.props.children.length, 3, '同一个 SVG 里有三笔：圆点 + 对勾 + 斜杠')
  eq(todo.props.children[0].props.className, 'pk-glyph__dot', '第一笔是圆点')
  eq(todo.props.children[1].props.className, 'pk-glyph__check', '第二笔是对勾')
  eq(todo.props.children[2].props.className, 'pk-glyph__slash', '第三笔是斜杠')
  eq(todo.props.children[2].props.strokeWidth, exports.__internals.ICON_STROKE, '斜杠与卡头图标同描边')

  const css = exports.__internals.CSS
  ok(/\[data-state="todo"\] \.pk-glyph__dot\{[^}]*fill-opacity:1/.test(css), '待办 = 实心点')
  ok(/\[data-state="skipped"\] \.pk-glyph__dot\{[^}]*fill-opacity:0[^}]*r:3\.7/.test(css), '跳过 = 点撑成空心环（r 3→3.7）')
  ok(/\[data-state="done"\] \.pk-glyph__check\{[^}]*stroke-dashoffset:0/.test(css), '已办 = 对勾画出来')
  ok(/\[data-state="skipped"\] \.pk-glyph__slash\{[^}]*stroke-dashoffset:0/.test(css), '跳过 = 斜杠画出来')
  ok(/\.pk-glyph__dot\{[^}]*transition/.test(css), '圆点有过渡（r / 透明度动画）')
  ok(/prefers-reduced-motion[^}]*\.pk-glyph__slash/.test(css), '尊重减弱动画偏好')
})

check('卡片里点「跳过」的那条 = 恢复为待办（不是勾已办）', async () => {
  const { exports, calls } = loadClient({ state: listState(2) })
  const withSkipped = listState(2)
  withSkipped.list[0].skippedAt = 123
  const rendered = renderStrip(exports, withSkipped)
  const glyphs = findAllByClass(rendered, 'pk-card__glyph')
  eq(glyphs.length, 1, '跳过的还在列表里时也可以点（这里只造了一条待办 + 一条跳过）')
  eq(glyphs[0].props['data-state'], 'todo', '第一条是正常待办')
  await glyphs[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 25))
  const post = calls.filter((call) => call.options?.method === 'POST').pop()
  eq(JSON.parse(post.options.body).check.done, true, '正常待办 → 勾成已办')
})

check('设置页：跳过与待办分开计数、分开列，且能一键恢复', async () => {
  const { exports, calls } = loadClient({ state: listState(3) })
  const state = listState(4)
  state.list[0].skippedAt = 999      // 跳过
  state.list[1].done = true          // 已办
  const { items, counts } = exports.__internals.filterBlocked(state.list, {})
  eq(counts.all, 4, '总数')
  eq(counts.todo, 2, '待办只算正常待办')
  eq(counts.done, 1, '已办')
  eq(counts.skipped, 1, '跳过单独一档')
  eq(items.length, 4, '「全部」标签页给四条')
  eq(exports.__internals.filterBlocked(state.list, { tab: 'skipped' }).items[0].id, state.list[0].id, '跳过标签页')
  const todoItems = exports.__internals.filterBlocked(state.list, { tab: 'todo' }).items
  ok(!todoItems.some((i) => i.skippedAt !== undefined && i.skippedAt !== null), '待办标签页里没有跳过项')

  // 渲染 + 点跳过那行的图标 → restore
  const rendered = renderSection(exports, state)
  const rows = findAllByClass(rendered, 'pk-set__row')
  eq(rows.length, 4, '四行')
  ok(String(rows[0].props.className).includes('pk-set__row--skipped'), '跳过那行带独立类名')
  const glyph = findByClass(rows[0], 'pk-card__glyph')
  eq(glyph.props['data-state'], 'skipped', '图标是跳过态')
  eq(glyph.props['aria-label'], '点一下恢复为待办', '提示是恢复而不是勾选')
  await glyph.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 25))
  const post = calls.filter((call) => call.options?.method === 'POST').pop()
  eq(JSON.parse(post.options.body).restore[0], state.list[0].id, '打的是 restore 接口')
})

// ── 图标几何：不看坐标，直接算真实墨迹的重心与重量 ─────────────────────────

/** 把简单路径（M/L/l/H/V/h/v）拆成折线。 */
function parsePathData(d) {
  const tokens = d.match(/[MmLlHhVvZz]|-?\d*\.?\d+/g) ?? []
  const polys = []
  let current = null
  let x = 0
  let y = 0
  let command = null
  let i = 0
  const num = () => Number(tokens[i++])
  while (i < tokens.length) {
    if (/[MmLlHhVvZz]/.test(tokens[i])) { command = tokens[i]; i += 1; if (command === 'Z' || command === 'z') continue }
    if (command === 'M' || command === 'm') {
      const nx = num(); const ny = num()
      x = command === 'm' ? x + nx : nx
      y = command === 'm' ? y + ny : ny
      current = [[x, y]]; polys.push(current)
      command = command === 'M' ? 'L' : 'l'
    } else if (command === 'L' || command === 'l') {
      const nx = num(); const ny = num()
      x = command === 'l' ? x + nx : nx
      y = command === 'l' ? y + ny : ny
      current.push([x, y])
    } else if (command === 'H' || command === 'h') { const nx = num(); x = command === 'h' ? x + nx : nx; current.push([x, y]) }
    else if (command === 'V' || command === 'v') { const ny = num(); y = command === 'v' ? y + ny : ny; current.push([x, y]) }
    else i += 1
  }
  return polys
}

/**
 * 真实墨迹指标：包围盒、质量（≈面积）、重心。
 * 重心 = 直线段 + 圆头端帽(πr²/2) + 拐点接点((π/2−1)r²) 的加权平均 —— 这才是「视觉重心」；
 * 箭头两端的圆帽会把它往上拽，这正是需要校正的量，只看包围盒中心是看不出来的。
 */
function inkMetrics(d, stroke) {
  const polys = parsePathData(d)
  const r = stroke / 2
  const capMass = (Math.PI * r * r) / 2
  const joinMass = (Math.PI / 2 - 1) * r * r
  let mass = 0; let mx = 0; let my = 0
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (const poly of polys) {
    for (const [px, py] of poly) {
      minX = Math.min(minX, px - r); maxX = Math.max(maxX, px + r)
      minY = Math.min(minY, py - r); maxY = Math.max(maxY, py + r)
    }
    for (let i = 0; i + 1 < poly.length; i += 1) {
      const [x0, y0] = poly[i]
      const [x1, y1] = poly[i + 1]
      const length = Math.hypot(x1 - x0, y1 - y0)
      const segMass = length * stroke
      mass += segMass; mx += segMass * ((x0 + x1) / 2); my += segMass * ((y0 + y1) / 2)
      if (i > 0) { mass += joinMass; mx += joinMass * x0; my += joinMass * y0 }
    }
    for (const [px, py] of [poly[0], poly[poly.length - 1]]) { mass += capMass; mx += capMass * px; my += capMass * py }
  }
  return {
    centroid: [mx / mass, my / mass],
    mass,
    width: maxX - minX,
    height: maxY - minY,
    boxCenter: [(minX + maxX) / 2, (minY + maxY) / 2],
  }
}

/** 从真实渲染产出的组件里取回 (path, stroke)。 */
function glyphOf(exports, kind) {
  if (kind === 'chevron-down' || kind === 'chevron-up') {
    const svg = exports.__internals.Chevron({ direction: kind === 'chevron-down' ? 'down' : 'up' })
    return [svg.props.children[0].props.d, svg.props.strokeWidth]
  }
  if (kind === 'close') {
    const svg = exports.__internals.CloseIcon()
    return [svg.props.children[0].props.d, svg.props.strokeWidth]
  }
  if (kind === 'check') {
    const svg = exports.__internals.TodoGlyph({ done: true })
    return [svg.props.children[1].props.d, svg.props.children[1].props.strokeWidth]
  }
  if (kind === 'lead') {
    const svg = exports.__internals.CardGlyph()
    return [svg.props.children[0].props.d, svg.props.strokeWidth]
  }
  throw new Error(`unknown glyph ${kind}`)
}

check('图标几何：两个方向的箭头墨迹盒完全重合（切换不跳），且都比 × 略低一点', () => {
  const { exports } = loadClient()
  const down = inkMetrics(...glyphOf(exports, 'chevron-down'))
  const up = inkMetrics(...glyphOf(exports, 'chevron-up'))
  const close = inkMetrics(...glyphOf(exports, 'close'))
  // 横向必须严格居中（浮点容差）
  ok(Math.abs(down.centroid[0] - 8) <= 1e-6, `向下：横向重心 ${down.centroid[0]}`)
  ok(Math.abs(up.centroid[0] - 8) <= 1e-6, `向上：横向重心 ${up.centroid[0]}`)
  // ★ 两态**用同一段 y 区间**：墨迹盒完全重合，展开/收起切换时图标不会上下跳
  ok(Math.abs(down.boxCenter[1] - up.boxCenter[1]) <= 0.02,
    `两态盒心必须重合（下 ${down.boxCenter[1].toFixed(3)} / 上 ${up.boxCenter[1].toFixed(3)}）`)
  // 箭头相对 × 的纵向偏移 = 模型值 0.1 + 用户目测微调档 CHEVRON_Y_SHIFT（当前 −0.5 → 净 −0.4，略高）
  const bias = down.boxCenter[1] - close.boxCenter[1]
  const shift = exports.__internals.CHEVRON_Y_SHIFT
  ok(Math.abs(bias - (0.1 + shift)) <= 0.02,
    `箭头相对 × 的偏移 ${bias.toFixed(3)}px，应等于模型值 0.1 + 微调档 ${shift}`)
  // 端帽在上的那个质心略高、在下的略低 —— 形状自身的不对称，两者相差约 0.28px
  const centroidGap = Math.abs(up.centroid[1] - down.centroid[1])
  ok(centroidGap >= 0.2 && centroidGap <= 0.35, `两态真实重心差 ${centroidGap.toFixed(3)}px（由端帽位置决定，≈0.28）`)
  ok(Math.abs(down.centroid[1] - 8) <= 0.6, `向下真实重心 y=${down.centroid[1].toFixed(3)}`)
  ok(Math.abs(up.centroid[1] - 8) <= 0.6, `向上真实重心 y=${up.centroid[1].toFixed(3)}`)
})

check('回归：两个图标键的 DOM 结构必须对称，且 SVG 不能按文字基线对齐', () => {
  const { exports } = loadClient()
  const rendered = renderStrip(exports, listState(2))
  const chevron = findByClass(rendered, 'pk-card__iconbtn--chevron')
  const close = findByClass(rendered, 'pk-card__iconbtn--close')
  // 两边都必须是「按钮里直接装组件」，谁都不能多套一层（曾因折叠键外面多包一个 span、
  // 而那层 span 的样式又被删掉，导致 inline SVG 按文字基线对齐、被顶高 1.44px）
  eq(Array.isArray(chevron.props.children), true, '折叠键的子节点是数组')
  eq(chevron.props.children.length, 1, '折叠键只有一颗子节点')
  eq(close.props.children.length, 1, '关闭键只有一颗子节点')
  eq(typeof chevron.props.children[0].type, 'function', '折叠键直接装组件')
  eq(typeof close.props.children[0].type, 'function', '关闭键直接装组件')
  const css = exports.__internals.CSS
  ok(/\.pk-card__iconbtn > svg\{[^}]*display:block/.test(css), 'SVG 必须 display:block（挡掉基线对齐）')
  ok(!css.includes('pk-card__chevron{'), '那层丢掉样式的 span 规则不应再出现')
})

check('图标几何：叉号重心精确居中，但重量不能压过箭头', () => {
  const { exports } = loadClient()
  const close = inkMetrics(...glyphOf(exports, 'close'))
  const chevron = inkMetrics(...glyphOf(exports, 'chevron-down'))
  ok(Math.abs(close.centroid[0] - 8) <= 0.02, `× 横向重心 ${close.centroid[0].toFixed(3)}`)
  ok(Math.abs(close.centroid[1] - 8) <= 0.02, `× 纵向重心 ${close.centroid[1].toFixed(3)}`)
  // 尺寸关系照用户给的「光学校正示意」：× 的墨迹宽度 ≈ 箭头宽度、× 高度 ≈ 箭头的 1.64 倍
  const widthRatio = close.width / chevron.width
  const heightRatio = close.height / chevron.height
  ok(Math.abs(widthRatio - 1) <= 0.12, `× 宽/箭头宽 = ${widthRatio.toFixed(2)}（参考图 1.00）`)
  ok(heightRatio >= 1.5 && heightRatio <= 1.8, `× 高/箭头高 = ${heightRatio.toFixed(2)}（参考图 1.64）`)
  const ratio = close.mass / chevron.mass
  ok(ratio >= 1.6 && ratio <= 2.1, `×/箭头 墨迹比 ${ratio.toFixed(2)}（参考图 ≈2.4，原实现 1.56）`)
})

check('图标几何：卡头三枚图标同一笔画重量；可见间距与表头行距同节奏', () => {
  const { exports } = loadClient()
  const strokes = ['lead', 'chevron-down', 'close'].map((kind) => glyphOf(exports, kind)[1])
  eq(new Set(strokes).size, 1, `lead/chevron/close 必须同描边（实际 ${strokes.join('/')}）`)
  eq(strokes[0], 1.3, '对齐 DSH 自带的 ICON_MEDIUM_STROKE = 1.3')
  ok(glyphOf(exports, 'check')[1] > strokes[0], '对勾是状态标记，允许略重')

  const chevron = inkMetrics(...glyphOf(exports, 'chevron-down'))
  const close = inkMetrics(...glyphOf(exports, 'close'))
  const gapRule = /\.pk-card__actions\{[^}]*gap:0/.exec(exports.__internals.CSS)
  ok(gapRule !== null, '两个键之间不再额外留容器间距')
  const inkGap = (20 - chevron.width) / 2 + (20 - close.width) / 2
  ok(inkGap >= 9.5 && inkGap <= 11.5, `可见笔画间距 ${inkGap.toFixed(2)}px（表头行距 10px，应同节奏）`)
})

check('图标几何：对勾的重心也在中心（勾号天然一头沉，必须校正）', () => {
  const { exports } = loadClient()
  const check = inkMetrics(...glyphOf(exports, 'check'))
  ok(Math.abs(check.centroid[1] - 8) <= 0.05, `对勾纵向重心 ${check.centroid[1].toFixed(3)}（未校正时约 8.25）`)
  ok(Math.abs(check.centroid[0] - 8) <= 0.05, `对勾横向重心 ${check.centroid[0].toFixed(3)}`)
})

check('折叠箭头是 SVG 描边图标（16px 画布 / 圆头 / 卡头同重）', () => {
  const { exports } = loadClient()
  const rendered = renderStrip(exports, listState(2))
  const button = findByClass(rendered, 'pk-card__iconbtn--chevron')
  ok(button !== undefined, '表头里有折叠按钮')
  eq(button.props.children[0].type, exports.__internals.Chevron, '按钮里直接装 Chevron 组件（不再套 span）')
  const svg = exports.__internals.Chevron({ direction: 'down' })
  eq(svg.props.width, 16, '16px 画布')
  eq(svg.props.strokeWidth, 1.3, '与卡头其它图标同描边')
  eq(svg.props.strokeLinecap, 'round', '圆头端点')
  eq(svg.props.strokeLinejoin, 'round', '圆角拐点')
  eq(svg.props.stroke, 'currentColor', '继承文字色（跟着主题走）')
  const up = exports.__internals.Chevron({ direction: 'up' })
  ok(up.props.children[0].props.d !== svg.props.children[0].props.d, '两个方向是不同路径')
  ok(!svg.props.children[0].props.d.includes('rotate'), '不靠旋转复制（旋转得不到同样的墨迹分布）')
})

check('关闭键：和折叠键同一套外观（同一个 iconbtn 类），点了就把「未处理」交给宿主收起', async () => {
  const { exports } = loadClient()
  const rendered = renderStrip(exports, listState(2))
  const close = findByClass(rendered, 'pk-card__iconbtn--close')
  ok(close !== undefined, '有关闭键')
  ok(String(close.props.className).includes('pk-card__iconbtn'), '与折叠键共用 iconbtn 类（外观统一）')
  eq(close.props['aria-label'], '关闭这个列表', '有无障碍标签')
  const icon = exports.__internals.CloseIcon()
  eq(icon.props.strokeWidth, exports.__internals.ICON_STROKE, '叉号与 Chevron 同描边参数')
  eq(icon.props.strokeLinecap, 'round', '圆头')

  // 关闭 = 通知宿主：把当时未处理的记录标记为「跳过」并从此默认不展示已办（卡片随即变空）
  const view = loadClient({ state: listState(2) })
  const cardRendered = renderStrip(view.exports, listState(2))
  await findByClass(cardRendered, 'pk-card__iconbtn--close').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const dismiss = view.calls.find((call) => call.options?.method === 'POST')
  ok(dismiss !== undefined, '关闭键打了写接口')
  eq(JSON.parse(dismiss.options.body).dismiss, true, '请求体是 {dismiss:true}')
})

check('行首圆点可点：勾成「已办」会把状态写回宿主（落盘）', async () => {
  const { exports, calls } = loadClient({ state: listState(2) })
  const rendered = renderStrip(exports, listState(2))
  const dots = findAllByClass(rendered, 'pk-card__glyph')
  eq(dots.length, 2, '每行一个勾选键')
  eq(dots[0].props['aria-pressed'], false, '初始是待办')
  eq(dots[0].props['data-done'], false, '数据属性同步')
  await dots[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const post = calls.find((call) => call.url.endsWith('/peak-guard/set') && call.options?.method === 'POST')
  ok(post !== undefined, '打了 set 端点')
  eq(post.options.headers['x-peak-guard'], '1', '带防 CSRF 头')
  eq(post.options.body, '{"check":{"id":"q0","done":true}}', '把 id 与目标状态一起送出去')
})

check('已办那一行的观感：对勾 + 划线 + 变淡，且再点一下能变回待办', async () => {
  const { exports, calls } = loadClient({ state: listState(2) })
  const doneState = listState(2)
  doneState.list[0].done = true
  const rendered = renderStrip(exports, doneState)
  const dots = findAllByClass(rendered, 'pk-card__glyph')
  eq(dots[0].props['aria-pressed'], true, '已办行标记为按下')
  const glyph = exports.__internals.TodoGlyph({ done: true })
  eq(glyph.props.children[1].props.d.includes('8.3'), true, '对勾路径')
  const css = exports.__internals.CSS
  ok(/\.pk-card__item--done \.pk-card__content\{[^}]*line-through/.test(css), '已办文字划掉')
  ok(/\.pk-card__glyph\[aria-pressed="true"\] path\{[^}]*stroke-dashoffset:0/.test(css), '对勾按描边画出来')
  ok(/\.pk-card__glyph circle\{[^}]*transition/.test(css), '圆点有过渡（动画流畅）')
  await dots[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const post = calls.find((call) => call.url.endsWith('/peak-guard/set'))
  eq(JSON.parse(post.options.body).check.done, false, '再点一下是取消勾选')
})

check('表头：说明位永远渲染（它既报状态，也是把箭头推到最右的弹簧）', () => {
  const { exports } = loadClient()
  const rendered = renderStrip(exports, listState(2))
  const progress = findByClass(rendered, 'pk-card__progress')
  ok(progress !== undefined, '说明位一定存在')
  eq(texts(progress).join('').includes('没有发给模型'), true, '说明这些请求没花钱')
  const rule = /\.pk-card__progress\{[^}]*\}/.exec(exports.__internals.CSS)
  ok(rule !== null && rule[0].includes('flex:auto'), '说明位 flex:auto（弹簧）')
})

check('圆点 glyph 用 SVG 画（16×16 盒子里一个圆，跟着 label 色走）', () => {
  const { exports } = loadClient()
  const css = exports.__internals.CSS
  const rule = /\.pk-card__glyph\{[^}]*\}/.exec(css)
  ok(rule !== null && rule[0].includes('width:16px') && rule[0].includes('height:16px'), 'glyph 是 16×16 的盒子')
  const dot = exports.__internals.TodoGlyph({ done: false })
  eq(dot.type, 'svg', '用 svg 而不是 CSS 圆（保证跟 16px 盒子对齐）')
  eq(dot.props.children[0].props.r, 3, '半径 3')
  eq(dot.props.children[0].props.fill, 'currentColor', '颜色继承文字色')
})

check('角标与警告点都带 corner-shape:round（否则被全局 superellipse 压成方圆角）', () => {
  const { exports } = loadClient()
  const css = exports.__internals.CSS
  for (const selector of ['pk-guard__dot', 'pk-badge']) {
    const rule = new RegExp(`\\.${selector}\\{[^}]*\\}`).exec(css)
    ok(rule !== null, `有 .${selector} 规则`)
    ok(rule[0].includes('corner-shape:round'), `.${selector} 需要 corner-shape:round`)
  }
  ok(!css.includes('pk-switch'), '补发开关的样式已清干净')
  ok(!css.includes('pk-modal'), '弹窗样式已清干净')
})
check('写接口失败时把宿主的错误码带出来，而不是只报 HTTP 409', async () => {
  const withCode = loadClient({
    fetchResult: async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: 'enabled-must-be-boolean' }) }),
  })
  let message = null
  try {
    await withCode.exports.__internals.putEnabled(true)
  } catch (error) {
    message = error.message
  }
  eq(message, 'enabled-must-be-boolean', '错误码原样透出')

  const bare = loadClient({
    fetchResult: async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json')
      },
    }),
  })
  let bareMessage = null
  try {
    await bare.exports.__internals.putEnabled(true)
  } catch (error) {
    bareMessage = error.message
  }
  eq(bareMessage, 'HTTP 500', '拿不到 body 时退回状态码')
})

check('英文环境走英文文案', () => {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const recorded = {}
  const factory = new Function('window', 'document', 'console', 'fetch', 'navigator', 'setInterval', 'clearInterval', code)
  factory(
    { __ModuleLoader__: { load: (entry) => { recorded.factory = entry.factory } }, addEventListener() {}, removeEventListener() {} },
    { head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, remove() {} }) },
    { log() {}, error() {} },
    async () => ({ ok: true, json: async () => ({ ok: true }) }),
    { language: 'en-US' },
    () => 0,
    () => {},
  )
  const exports = recorded.factory((name) => (name === 'react' ? FakeReact : (() => { throw new Error(name) })()))
  const view = exports.__internals.describe({ enabled: true, peak: true, hardOff: false }, false)
  eq(view.title, 'Peak guard is on', '英文标题')
  ok(view.lines.some((line) => line.includes('blocked')), `英文提示：${JSON.stringify(view.lines)}`)
})

// ── 汇总 ────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败：`)
  for (const failure of failures) console.error(`   ✗ ${failure}`)
}
console.log(`\nclient.test.mjs：${passed} 项通过，${failures.length} 项失败`)
process.exit(failures.length === 0 ? 0 : 1)
