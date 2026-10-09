/**
 * dsh-peak-guard · 纯逻辑测试
 *
 * 两类断言：
 *   1. 手写用例 —— 边界、半开区间、周末/假期、坏配置。
 *   2. **差分测试** —— 逐点比对本机 dsh-cost-meter 的峰谷实现（它跟着官方公告同步）。
 *      两边只要有一个采样点不一致就判失败；参考实现找不到时明确标记 SKIP，不假装通过。
 *
 * 跑法：node test/peak.test.mjs
 */
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_CONFIG,
  JOKE,
  POLITE,
  buildMessage,
  describeWindows,
  formatDuration,
  isPeak,
  localParts,
  nextTransition,
  normalizeConfig,
  parseTimeOfDay,
  parseWindow,
  resolveMessage,
  resolveTone,
  statusText,
} from '../lib/peak.js'

let passed = 0
const failures = []
const skips = []

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

/** 北京时间墙上时刻 → epoch ms。 */
const beijing = (text) => Date.parse(`${text}+08:00`)

// ── 1. 时间解析 ─────────────────────────────────────────────────────────────

check('parseTimeOfDay 正常值与边界', () => {
  eq(parseTimeOfDay('00:00'), 0, '00:00')
  eq(parseTimeOfDay('09:30'), 570, '09:30')
  eq(parseTimeOfDay('23:59'), 1439, '23:59')
  eq(parseTimeOfDay('24:00'), 1440, '24:00')
  eq(parseTimeOfDay('24:01'), undefined, '24:01')
  eq(parseTimeOfDay('25:00'), undefined, '25:00')
  eq(parseTimeOfDay('9:5'), undefined, '9:5')
  eq(parseTimeOfDay('09:60'), undefined, '09:60')
  eq(parseTimeOfDay(930), undefined, '数字输入')
  eq(parseTimeOfDay(undefined), undefined, 'undefined')
})

check('parseWindow 正常值与跨午夜', () => {
  eq(parseWindow('09:00-12:00').start, 540, 'start')
  eq(parseWindow('09:00-12:00').end, 720, 'end')
  eq(parseWindow('22:00-02:00').start, 1320, '跨午夜 start')
  eq(parseWindow('22:00-02:00').end, 120, '跨午夜 end')
  eq(parseWindow('09:00-12:00-15:00'), undefined, '三段式')
  eq(parseWindow('09:00'), undefined, '缺结尾')
  eq(parseWindow('abc-def'), undefined, '非时间')
})

// ── 2. 配置归一化 ───────────────────────────────────────────────────────────

check('normalizeConfig 默认值可用', () => {
  const { config, warnings } = normalizeConfig(undefined)
  eq(warnings.length, 0, '默认无告警')
  eq(config.enabled, true, 'enabled')
  eq(config.timeZone, 'Asia/Shanghai', 'timeZone')
  eq(config.tone, 'polite', '默认正经话术')
  eq(config.message, undefined, '没显式配置 message')
  eq(resolveMessage(config), POLITE, '解析出来是正经版')
  eq(config.peakWindows.length, 2, '两个默认窗口')
  eq(config.peakWindows[0].start, 540, '窗口已解析成对象')
  eq(config.blockedLimit, 50, '被拦截列表默认 50 条')
  eq(config.blockedMaxAgeMinutes, 720, '被拦截列表保留默认 12 小时')
})

check('normalizeConfig 坏值退回默认且不抛错', () => {
  const { config, warnings } = normalizeConfig({
    enabled: 'yes',
    timeZone: 'Mars/Olympus',
    peakWindows: ['not-a-window', 42],
    holidays: 'nope',
    message: '   ',
    allowSessions: [1, 2],
    snoozeMinutes: -5,
    unknownKey: true,
  })
  eq(config.enabled, true, 'enabled 退回默认')
  eq(config.timeZone, 'Asia/Shanghai', 'timeZone 退回默认')
  eq(config.peakWindows.length, 2, 'peakWindows 退回默认')
  eq(config.holidays.length, DEFAULT_CONFIG.holidays.length, 'holidays 退回默认')
  eq(config.message, undefined, '坏 message 不写进配置（回落到 tone）')
  eq(resolveMessage(config), POLITE, '解析成正经版')
  eq(config.allowSessions.length, 0, 'allowSessions 忽略')
  eq(config.snoozeMinutes, 30, 'snoozeMinutes 退回默认')
  ok(warnings.length >= 6, `应留下多条告警，实际 ${warnings.length}`)
  ok(warnings.some((w) => w.includes('unknownKey')), '应报告不认识的键')
})

check('normalizeConfig 空窗口数组 = 从不拦截', () => {
  const { config } = normalizeConfig({ peakWindows: [] })
  eq(config.peakWindows.length, 0, '空窗口')
  eq(isPeak(beijing('2026-10-09T10:00:00'), config), false, '高峰时刻也不拦')
})

check('normalizeConfig 支持假期区间写法', () => {
  const { config, warnings } = normalizeConfig({ holidays: ['2027-01-01..2027-01-03'] })
  eq(warnings.length, 0, '区间不该告警')
  eq(config.holidays.length, 3, '展开成 3 天')
  eq(config.holidays[0], '2027-01-01', '首日')
  eq(config.holidays[2], '2027-01-03', '末日')
})

check('normalizeConfig 删掉没有已知键的输入也不炸', () => {
  for (const bad of [null, 0, '', [], { peakWindows: null, holidays: null }]) {
    const { config } = normalizeConfig(bad)
    ok(config !== undefined && Array.isArray(config.peakWindows), `输入 ${JSON.stringify(bad)} 仍产出可用配置`)
  }
})

// ── 3. 峰谷判定（手写边界） ────────────────────────────────────────────────

const cfg = normalizeConfig(undefined).config

check('窗口半开区间：09:00 进、12:00 出、14:00 进、18:00 出', () => {
  const friday = '2026-10-09'
  eq(localParts(beijing(`${friday}T10:00:00`), 'Asia/Shanghai').weekday, 5, '2026-10-09 应是周五')
  eq(isPeak(beijing(`${friday}T08:59:00`), cfg), false, '08:59 谷')
  eq(isPeak(beijing(`${friday}T09:00:00`), cfg), true, '09:00 峰')
  eq(isPeak(beijing(`${friday}T11:59:00`), cfg), true, '11:59 峰')
  eq(isPeak(beijing(`${friday}T12:00:00`), cfg), false, '12:00 谷')
  eq(isPeak(beijing(`${friday}T13:59:00`), cfg), false, '13:59 谷')
  eq(isPeak(beijing(`${friday}T14:00:00`), cfg), true, '14:00 峰')
  eq(isPeak(beijing(`${friday}T17:59:00`), cfg), true, '17:59 峰')
  eq(isPeak(beijing(`${friday}T18:00:00`), cfg), false, '18:00 谷')
  eq(isPeak(beijing(`${friday}T23:59:00`), cfg), false, '23:59 谷')
})

check('周末全天谷价', () => {
  eq(localParts(beijing('2026-10-10T10:00:00'), 'Asia/Shanghai').weekday, 6, '2026-10-10 应是周六')
  eq(isPeak(beijing('2026-10-10T10:00:00'), cfg), false, '周六上午不拦')
  eq(isPeak(beijing('2026-10-11T15:00:00'), cfg), false, '周日下午不拦')
  eq(localParts(beijing('2026-10-12T10:00:00'), 'Asia/Shanghai').weekday, 1, '2026-10-12 应是周一（且不在假期表里）')
  eq(isPeak(beijing('2026-10-12T10:00:00'), cfg), true, '周一上午照拦')
})

check('法定假期全天谷价', () => {
  eq(localParts(beijing('2026-10-01T10:00:00'), 'Asia/Shanghai').weekday, 4, '2026-10-01 应是周四')
  eq(isPeak(beijing('2026-10-01T10:00:00'), cfg), false, '国庆不拦')
  eq(isPeak(beijing('2026-09-25T15:00:00'), cfg), false, '中秋不拦')
  eq(isPeak(beijing('2026-10-09T15:00:00'), cfg), true, '节后工作日照拦')
})

check('关掉周末规则 / 清空假期后判定随之改变', () => {
  const strict = normalizeConfig({ weekendsOffPeak: false, holidays: [] }).config
  eq(isPeak(beijing('2026-10-10T10:00:00'), strict), true, '周末也拦')
  eq(isPeak(beijing('2026-10-01T10:00:00'), strict), true, '假期也拦')
})

check('窗口是「配置时区的墙上钟点」，换时区窗口跟着走', () => {
  const utc = normalizeConfig({ timeZone: 'UTC', weekendsOffPeak: false, holidays: [] }).config
  eq(isPeak(Date.parse('2026-10-09T09:00:00Z'), utc), true, 'UTC 09:00 落在窗口内')
  eq(isPeak(Date.parse('2026-10-09T02:00:00Z'), utc), false, 'UTC 02:00 不在窗口内（09:00-12:00 是 UTC 墙上时间）')
})

// ── 4. 话术 ─────────────────────────────────────────────────────────────────

check('buildMessage 首行是提示语，hint 里给逃生门', () => {
  const at = beijing('2026-10-09T15:00:00')
  const text = buildMessage(cfg, at)
  eq(text.split('\n')[0], POLITE, '默认正经首行')
  ok(text.includes('/peak off'), 'hint 里给出逃生门')
  eq(buildMessage({ ...cfg, hint: false }, at), POLITE, 'hint=false 时只有那一句')
})

check('buildMessage 在谷时也能算下一段高峰', () => {
  const text = buildMessage(cfg, beijing('2026-10-09T20:00:00'))
  ok(text.includes('09:00'), `应指出下一段高峰 09:00：${text}`)
})

check('buildMessage 的 forced 模式不谎称高峰（彩蛋话术）', () => {
  const at = beijing('2026-10-09T20:00:00') // 谷时
  const jokeCfg = normalizeConfig({ tone: 'joke' }).config
  const forced = buildMessage(jokeCfg, at, { forced: true })
  eq(forced.split('\n')[0], JOKE, '首行彩蛋原文')
  ok(forced.includes('强制拦截'), '标明手动强制')
  ok(forced.includes('谷时'), '如实说明现在是谷时')
  ok(!forced.includes('高峰计价中'), '不能谎称高峰计价')
})

check('话术三态：正经（默认）/ 彩蛋 / 自定义', () => {
  const at = beijing('2026-10-09T15:00:00')
  const polite = normalizeConfig(undefined).config
  eq(resolveTone(polite), 'polite', '默认正经')
  const politeText = buildMessage(polite, at)
  eq(politeText.split('\n')[0], POLITE, '正经首行')
  ok(politeText.includes('高峰单价约为谷时的 2 倍'), '正经版说明计价')
  ok(politeText.includes('没有产生费用'), '正经版强调没花钱')
  ok(!politeText.includes('梁文峰'), '正经版不该出现彩蛋')
  eq(buildMessage({ ...polite, hint: false }, at), POLITE, 'hint=false 只有首行')

  const joke = normalizeConfig({ tone: 'joke' }).config
  eq(resolveTone(joke), 'joke', '彩蛋 tone')
  eq(buildMessage(joke, at).split('\n')[0], JOKE, '彩蛋首行')

  const custom = normalizeConfig({ message: '自定话术', tone: 'joke' }).config
  eq(resolveTone(custom), 'custom', 'message 盖过 tone')
  eq(buildMessage(custom, at).split('\n')[0], '自定话术', '自定义首行')

  const badTone = normalizeConfig({ tone: '起飞' })
  eq(badTone.config.tone, 'polite', '坏 tone 退回默认')
  ok(badTone.warnings.some((w) => w.includes('tone')), '应告警')
})

check('statusText 反映峰谷与拦截计数', () => {
  const peakText = statusText(cfg, { blockedCount: 3, lastBlockAtMs: beijing('2026-10-09T15:00:00'), overrideUntilMs: undefined, hardOff: false }, beijing('2026-10-09T15:30:00'))
  ok(peakText.includes('高峰'), '应标出高峰')
  ok(peakText.includes('3 次'), '应报拦截次数')
  const offText = statusText(cfg, { blockedCount: 0, lastBlockAtMs: undefined, overrideUntilMs: beijing('2026-10-09T16:00:00'), hardOff: false }, beijing('2026-10-09T15:30:00'))
  ok(offText.includes('临时放行'), '应标出临时放行')
  ok(offText.includes('30 分'), '应给出剩余时长')
})

check('describeWindows / formatDuration 可读', () => {
  eq(describeWindows(cfg), '09:00–12:00、14:00–18:00', '窗口文本')
  eq(describeWindows({ peakWindows: [] }), '（未配置 → 从不拦截）', '空窗口文本')
  eq(formatDuration(90_000), '2 分', '90 秒向上取整')
  eq(formatDuration(3 * 3600_000 + 12 * 60_000), '3 小时 12 分', '3h12m')
  eq(formatDuration(50 * 3600_000), '2 天 2 小时', '2d2h')
})

// ── 5. 差分：与本机 dsh-cost-meter 的峰谷实现逐点对齐 ──────────────────────

const referencePath = (() => {
  const home = process.env.DSH_HOME ?? process.env.USERPROFILE ?? ''
  const candidates = [
    home ? `${home}\\profiles\\desktop\\node_modules\\dsh-cost-meter\\lib\\pricing.js` : undefined,
    home ? `${home}/profiles/desktop/node_modules/dsh-cost-meter/lib/pricing.js` : undefined,
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate))
})()

if (referencePath === undefined) {
  skips.push('差分测试：找不到 dsh-cost-meter/lib/pricing.js，未比对')
} else {
  const reference = await import(pathToFileURL(referencePath).href)
  const windows = reference.DEFAULT_PEAK_WINDOWS
  const holidays = reference.DEFAULT_PEAK_HOLIDAYS
  // 参考实现的「周末全天谷价」从 2026-08-22T16:00Z 起生效；比对起点与之对齐。
  const START = Date.parse('2026-08-22T16:00:00Z')
  const END = Date.parse('2027-03-01T00:00:00Z')
  const STEP = 7 * 60_000

  check(`差分 isPeak ≡ cost-meter.isPeakHour（${new Date(START).toISOString()} → 2027-03-01，步长 7 分钟）`, () => {
    let samples = 0
    for (let at = START; at <= END; at += STEP) {
      const mine = isPeak(at, cfg)
      const theirs = reference.isPeakHour(at, undefined, windows, holidays)
      if (mine !== theirs) {
        throw new Error(`在 ${new Date(at).toISOString()}（北京时间 ${new Date(at + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')}）不一致：本插件 ${mine}，cost-meter ${theirs}`)
      }
      samples += 1
    }
    ok(samples > 30_000, `采样点应足够多，实际 ${samples}`)
  })

  check('差分 nextTransition ≡ cost-meter.peakPhaseAt.nextAtMs（60 天，步长 53 分钟）', () => {
    const from = Date.parse('2026-09-01T00:00:00Z')
    const to = Date.parse('2026-10-31T00:00:00Z')
    let compared = 0
    for (let at = from; at <= to; at += 53 * 60_000) {
      const mine = nextTransition(at, cfg)
      const theirs = reference.peakPhaseAt(at, windows, holidays)
      if (theirs === null || theirs.nextAtMs === undefined) continue
      if (mine === undefined) throw new Error(`在 ${new Date(at).toISOString()} 本插件找不到切换点，cost-meter 给出 ${new Date(theirs.nextAtMs).toISOString()}`)
      if (mine.atMs !== theirs.nextAtMs) {
        throw new Error(`在 ${new Date(at).toISOString()} 切换点不一致：本插件 ${new Date(mine.atMs).toISOString()}，cost-meter ${new Date(theirs.nextAtMs).toISOString()}`)
      }
      if (mine.intoPeak !== theirs.nextIntoPeak) {
        throw new Error(`在 ${new Date(at).toISOString()} 切换方向不一致：本插件 intoPeak=${mine.intoPeak}，cost-meter=${theirs.nextIntoPeak}`)
      }
      compared += 1
    }
    ok(compared > 1000, `比对样本应足够多，实际 ${compared}`)
  })
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

for (const skip of skips) console.log(`  ⚠ SKIP ${skip}`)
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败：`)
  for (const failure of failures) console.error(`   ✗ ${failure}`)
}
console.log(`\npeak.test.mjs：${passed} 项通过，${failures.length} 项失败，${skips.length} 项跳过`)
process.exit(failures.length === 0 ? 0 : 1)
