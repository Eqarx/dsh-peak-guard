// 用 DSH 自己那份 js-yaml 解析插件的 cordis.patch.yml，并把 config 真的过一遍 normalizeConfig。
// 这验证的是「YAML 写得对不对」+「DSH 传进来的 config 会不会被正确接住」这一段。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { normalizeConfig, isPeak, buildMessage, statusText } from '../lib/peak.js'

const require = createRequire('C:/Users/Eqarx/.dsh/profiles/desktop/package.json')
let yaml
try {
  yaml = require('js-yaml')
} catch {
  // 这台机器上找不到 DSH 自带的 js-yaml（profile 不存在/换机器）——明说跳过，不假装通过。
  console.log('⚠ SKIP patch.test.mjs：解析不到 DSH 的 js-yaml，未校验 cordis.patch.yml')
  process.exit(0)
}
const path = new URL('../cordis.patch.yml', import.meta.url)
const doc = yaml.load(readFileSync(path, 'utf8'))

const entry = doc?.[0]?.insert?.[0]
if (entry === undefined) throw new Error('patch 结构不对：找不到 [0].insert[0]')
console.log('patch 行：', JSON.stringify({ id: entry.id, name: entry.name }))
if (entry.name !== 'dsh-peak-guard') throw new Error(`patch 里的包名不对：${entry.name}`)

const { config, warnings } = normalizeConfig(entry.config)
console.log('归一化告警：', warnings.length === 0 ? '（无）' : warnings)
if (warnings.length > 0) throw new Error('随包配置不该产生告警')

const at = Date.parse('2026-10-09T15:00:00+08:00') // 周五下午 = 高峰
const off = Date.parse('2026-10-09T20:00:00+08:00') // 周五晚上 = 谷时
console.log('配置摘要：', JSON.stringify({
  enabled: config.enabled,
  timeZone: config.timeZone,
  peakWindows: config.peakWindows.map((w) => `${w.start}-${w.end}`),
  weekendsOffPeak: config.weekendsOffPeak,
  holidayCount: config.holidays.length,
  hint: config.hint,
  blockUtilityCalls: config.blockUtilityCalls,
  allowSessions: config.allowSessions,
  snoozeMinutes: config.snoozeMinutes,
}))
console.log('周五15:00 isPeak =', isPeak(at, config), '(应为 true)')
console.log('周五20:00 isPeak =', isPeak(off, config), '(应为 false)')
if (isPeak(at, config) !== true || isPeak(off, config) !== false) throw new Error('峰谷判定与配置不符')
console.log('\n高峰期用户会看到：\n---')
console.log(buildMessage(config, at))
console.log('---')
console.log('\n/peak status：\n---')
console.log(statusText(config, { blockedCount: 0, lastBlockAtMs: undefined, overrideUntilMs: undefined, forceUntilMs: undefined, hardOff: false }, at))
console.log('---')
console.log('\nOK：cordis.patch.yml 可解析、随包配置零告警、峰谷判定符合预期')
