/**
 * dsh-peak-guard · 被拦截列表（纯逻辑）测试
 *
 * 盯住三件事：**不重**（同会话同内容 60 秒内只记一条）、**有界**（条数/存活时长上限）、
 * **只读**（坏 JSON 里能救回来的项，界面拿到的永远是最新在前）。
 * 跑法：node test/blocked.test.mjs
 */
import {
  PREVIEW_MAX,
  addItem,
  dropExpired,
  extractPreview,
  isItem,
  makeItem,
  sanitizeList,
  setDone,
  setSkipped,
  summarize,
  truncate,
} from '../lib/blocked.js'

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

const T0 = 1_760_000_000_000

// ── 预览抽取 ────────────────────────────────────────────────────────────────

check('extractPreview 取最后一条 user 消息的文本', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '第一问' }] },
    { role: 'assistant', content: [{ type: 'text', text: '答' }] },
    { role: 'user', content: [{ type: 'text', text: '  请帮我   看看 这个报错 ' }] },
  ]
  eq(extractPreview(messages), '请帮我 看看 这个报错', '连续空白压成一个空格')
})

check('extractPreview 兼容纯图片 / 空 / 垃圾输入', () => {
  eq(extractPreview([{ role: 'user', content: [{ type: 'image', attachment: {} }] }]), '（图片或附件）', '纯图片给占位')
  eq(extractPreview([]), '', '空数组')
  eq(extractPreview(undefined), '', 'undefined')
  eq(extractPreview([null, 42, 'x']), '', '垃圾项跳过')
  eq(extractPreview([{ role: 'user', content: 'not-an-array' }]), '', 'content 不是数组')
  eq(extractPreview([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(300) }] }]).length, PREVIEW_MAX + 1, '超长被截断（含省略号）')
})

check('truncate 不切断代理对', () => {
  const emoji = '😀'.repeat(50) // 每个占 2 个 UTF-16 码元
  const cut = truncate(emoji, 5)
  eq(cut.length, 4 + 1, '截到偶数位再补省略号')
  ok(cut.endsWith('…'), '有省略号')
  ok(!cut.includes('\uFFFD'), '没有半个代理对')
  eq(truncate('short', 10), 'short', '不超长则原样')
})

// ── 记一笔 / 去重 / 上限 ────────────────────────────────────────────────────

check('makeItem 归一化字段', () => {
  const item = makeItem({ id: 'a', sessionId: 'session-1', preview: '问', atMs: T0 })
  eq(item.id, 'a', 'id 转字符串')
  eq(item.sessionId, 'session-1', '会话 id 转字符串')
  eq(item.atMs, T0, '时间戳原样')
  eq(makeItem({ id: 'a', sessionId: 's', preview: 'x', atMs: Number.NaN }).atMs > 0, true, '坏时间戳落回 now')
  eq(makeItem({ id: 'a', sessionId: 's', preview: 123, atMs: T0 }).preview, '', '非字符串预览归一成空串')
})

check('addItem：同会话同内容 60 秒内只记一条', () => {
  const first = addItem([], makeItem({ id: 'a', sessionId: 's1', preview: '问问', atMs: T0 }), 50)
  eq(first.added, true, '第一条记下')
  const again = addItem(first.list, makeItem({ id: 'b', sessionId: 's1', preview: '问问', atMs: T0 + 30_000 }), 50)
  eq(again.added, false, '重复不新增')
  eq(again.replaced, true, '标记为替换')
  eq(again.list.length, 1, '列表长度不变')
  eq(again.list[0].id, 'a', '保留原 id（避免界面跳变）')
  eq(again.list[0].atMs, T0 + 30_000, '时间更新')

  const later = addItem(first.list, makeItem({ id: 'c', sessionId: 's1', preview: '问问', atMs: T0 + 90_000 }), 50)
  eq(later.added, true, '超过窗口就是新的一条')

  const otherSession = addItem(first.list, makeItem({ id: 'd', sessionId: 's2', preview: '问问', atMs: T0 }), 50)
  eq(otherSession.added, true, '同内容不同会话各自记一条')
})

check('addItem：超上限时丢最老的', () => {
  let list = []
  for (let index = 0; index < 3; index += 1) {
    const result = addItem(list, makeItem({ id: `i${index}`, sessionId: `s${index}`, preview: `p${index}`, atMs: T0 + index }), 3)
    list = result.list
  }
  eq(list.length, 3, '到上限')
  const overflow = addItem(list, makeItem({ id: 'i9', sessionId: 's9', preview: 'p9', atMs: T0 + 9 }), 3)
  eq(overflow.list.length, 3, '仍然不超过上限')
  eq(overflow.dropped, 1, '丢了一条')
  ok(!overflow.list.some((item) => item.id === 'i0'), '被丢的是最老那条')
  ok(overflow.list.some((item) => item.id === 'i9'), '新项在列表里')
})

check('addItem 容忍坏输入与超范围上限', () => {
  const result = addItem([null, 'x', { id: 1 }], makeItem({ id: 'a', sessionId: 's', preview: 'p', atMs: T0 }), Number.NaN)
  eq(result.list.length, 1, '坏项被过滤')
  const huge = addItem([], makeItem({ id: 'a', sessionId: 's', preview: 'p', atMs: T0 }), 99999)
  eq(huge.list.length, 1, '上限被夹到硬上限以内仍正常')
})

// ── 过期 / 净化 / 摘要 ──────────────────────────────────────────────────────

check('dropExpired 按最大存活时长丢弃', () => {
  const queue = [
    makeItem({ id: 'old', sessionId: 's1', preview: 'p', atMs: T0 }),
    makeItem({ id: 'new', sessionId: 's2', preview: 'p', atMs: T0 + 3_600_000 }),
  ]
  // 站在 T0+2 小时看：old 活了 2 小时、new 活了 1 小时；上限 1.5 小时 → 只丢 old
  const { fresh, expired } = dropExpired(queue, T0 + 2 * 3_600_000, 1.5 * 3_600_000)
  eq(expired.length, 1, '丢一条')
  eq(expired[0].id, 'old', '丢的是老的')
  eq(fresh.length, 1, '留一条')
  eq(fresh[0].id, 'new', '留的是新的')
  eq(dropExpired(queue, T0, 0).expired.length, 0, 'maxAge=0 表示不丢')
  eq(dropExpired(queue, T0 + 99 * 3_600_000, 3_600_000).expired.length, 2, '都超时就都丢')
})

check('sanitizeList 从坏 JSON 里救回能用的项', () => {
  const list = sanitizeList([
    { id: 'ok', sessionId: 's', preview: 'p', atMs: T0 },
    { id: 'no-session', preview: 'p', atMs: T0 },
    { id: 'bad-time', sessionId: 's', preview: 'p', atMs: '昨天' },
    null,
    'x',
  ])
  eq(list.length, 1, '只留下合法那条')
  eq(list[0].id, 'ok', '留下的是那条好的')
  eq(sanitizeList('not-array').length, 0, '非数组返回空')
  ok(isItem({ id: 'a', sessionId: 's', preview: '', atMs: 1 }), '空预览也算合法')
  ok(!isItem({ id: '', sessionId: 's', preview: '', atMs: 1 }), '空 id 不合法')
})

check('summarize 给界面的是「最新在前 + 总数 + 截断标记」', () => {
  const list = [
    makeItem({ id: 'a', sessionId: 's1', preview: 'p1', atMs: T0 }),
    makeItem({ id: 'b', sessionId: 's2', preview: 'p2', atMs: T0 + 1 }),
    makeItem({ id: 'c', sessionId: 's3', preview: 'p3', atMs: T0 + 2 }),
  ]
  const summary = summarize(list, 10)
  eq(summary.listCount, 3, '总数')
  eq(summary.listTruncated, false, '没截断')
  eq(summary.list.map((item) => item.id).join(','), 'c,b,a', '最新在前（列表是拿来看的）')
  const short = summarize(list, 2)
  eq(short.list.length, 2, '列表按上限截断')
  eq(short.listCount, 3, '总数不受截断影响')
  eq(short.listTruncated, true, '截断了要标记出来')
  eq(summarize([], 5).listCount, 0, '空列表')
})

check('setDone：勾选 / 取消勾选，找不到就原样返回（纯函数）', () => {
  const list = [
    makeItem({ id: 'a', sessionId: 's1', preview: 'p1', atMs: T0 }),
    makeItem({ id: 'b', sessionId: 's2', preview: 'p2', atMs: T0 + 1 }),
  ]
  const marked = setDone(list, 'a', true)
  eq(marked.found, true, '找得到')
  eq(marked.list[0].done, true, '勾上了')
  eq(list[0].done, undefined, '不改原数组')
  const undone = setDone(marked.list, 'a', false)
  eq(undone.list[0].done, undefined, '取消后字段直接去掉（文件保持干净）')
  const missing = setDone(list, 'nope', true)
  eq(missing.found, false, '找不到要如实报 missing')
  eq(missing.list.length, 2, '列表原样返回')
  eq(setDone('not-array', 'a', true).found, false, '坏输入不抛错')
})

check('summarize 把 done 带出去（界面据此画对勾）', () => {
  const list = [
    makeItem({ id: 'a', sessionId: 's1', preview: 'p1', atMs: T0 }),
    { ...makeItem({ id: 'b', sessionId: 's2', preview: 'p2', atMs: T0 + 1 }), done: true },
  ]
  const summary = summarize(list, 10)
  eq(summary.list[0].done, true, '最新在前，且带着已办标记')
  eq(summary.list[1].done, false, '没勾的是 false')
  const restored = sanitizeList([{ id: 'c', sessionId: 's', preview: 'p', atMs: T0, done: true }, { id: 'd', sessionId: 's', preview: 'p', atMs: T0, done: 'yes' }])
  eq(restored[0].done, true, '落盘的 done 读得回来')
  eq(restored[1].done, undefined, '非布尔的 done 直接丢掉')
})

check('setSkipped：关卡片时标记未处理的、按 id 恢复成正常待办，已办的不动', () => {
  const list = [
    makeItem({ id: 'a', sessionId: 's1', preview: 'p1', atMs: T0 }),
    { ...makeItem({ id: 'b', sessionId: 's2', preview: 'p2', atMs: T0 + 1 }), done: true },
    makeItem({ id: 'c', sessionId: 's3', preview: 'p3', atMs: T0 + 2 }),
  ]
  // 关展示框：ids 给空数组 = 把「还没处理」的全部标记为跳过（已办的不动）
  const marked = setSkipped(list, [], T0 + 100)
  eq(marked.changed, 2, '两条未处理的被标记')
  eq(marked.list[0].skippedAt, T0 + 100, '第一条盖上戳')
  eq(marked.list[1].skippedAt, undefined, '已办那条不动')
  eq(list[0].skippedAt, undefined, '不改原数组（纯函数）')

  // 按 id 恢复成正常待办（单向）
  const restored = setSkipped(marked.list, ['a'], null)
  eq(restored.changed, 1, '恢复一条')
  eq(restored.list[0].skippedAt, undefined, '字段直接去掉')
  eq(restored.list[2].skippedAt, T0 + 100, '另一条仍是跳过')
  eq(setSkipped(marked.list, ['nope'], null).changed, 0, '不存在的 id 不改动')
  eq(setSkipped('not-array', [], T0).changed, 0, '坏输入不抛错')

  const saved = sanitizeList(marked.list)
  eq(saved[0].skippedAt, T0 + 100, '写盘净化要留住 skippedAt')
  eq(sanitizeList([{ id: 'x', sessionId: 's', preview: 'p', atMs: T0, skippedAt: 'nope' }])[0].skippedAt, undefined,
    '非数字的 skippedAt 丢掉')
})

// ── 汇总 ────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败：`)
  for (const failure of failures) console.error(`   ✗ ${failure}`)
}
console.log(`\nblocked.test.mjs：${passed} 项通过，${failures.length} 项失败`)
process.exit(failures.length === 0 ? 0 : 1)
