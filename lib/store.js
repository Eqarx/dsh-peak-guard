/**
 * dsh-peak-guard · 极小的 JSON 状态文件
 *
 * 只存两件事：UI 开关（enabled）与被拦截列表（list）。
 * 落盘位置走 DSH 既有约定：`<DSH_HOME>/plugin-data/<插件名>/state.json`
 * —— 本机 `<DSH_HOME>` = C:\Users\Eqarx\.dsh，该目录下已经有别的插件在用。
 *
 * 三条纪律：
 *   1. **读写都不抛错**：拿不到路径/没权限/文件坏了，一律退化成「没有持久化」，
 *      绝不能因为一个存开关的小文件把插件（乃至 DSH）弄挂。
 *   2. **原子替换**：先写 .tmp 再 rename，避免断电/崩溃留下半个 JSON。
 *   3. **只存自己认识的键**：读回来的东西按白名单过滤，别把垃圾再写回去。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { sanitizeList } from './blocked.js'

/** 本文件认识的键；其余一律丢弃。 */
const KNOWN_KEYS = ['enabled', 'list', 'dismissedAtMs', 'hideDone', 'updatedAt']

/**
 * 解析状态文件路径。
 * @param {object} [options] - 依赖注入点（测试用）。
 * @param {Record<string, string | undefined>} [options.env] - 环境变量表。
 * @param {() => string} [options.home] - 用户主目录回退。
 * @param {string} [options.pluginName] - 插件名（= 目录名）。
 * @returns {string | undefined} 绝对路径；完全推不出来时 undefined。
 */
export function resolveStatePath(options = {}) {
  try {
    const env = options.env ?? (typeof process !== 'undefined' ? process.env : {})
    const pluginName = options.pluginName ?? 'dsh-peak-guard'
    const home = env?.DSH_HOME && String(env.DSH_HOME).trim() !== ''
      ? String(env.DSH_HOME)
      : join((options.home ?? homedir)(), '.dsh')
    return join(home, 'plugin-data', pluginName, 'state.json')
  } catch {
    return undefined
  }
}

/** 只保留认识的键，并做类型检查；坏的直接丢。 */
export function sanitizeState(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const key of KNOWN_KEYS) {
    if (!Object.hasOwn(raw, key)) continue
    const value = raw[key]
    if (key === 'enabled') {
      if (typeof value === 'boolean') out.enabled = value
    } else if (key === 'updatedAt') {
      if (typeof value === 'number' && Number.isFinite(value)) out.updatedAt = value
    } else if (key === 'list') {
      out.list = sanitizeList(value)
    } else if (key === 'dismissedAtMs') {
      if (typeof value === 'number' && Number.isFinite(value)) out.dismissedAtMs = value
    } else if (key === 'hideDone') {
      // 老字段：读得回来，交给上层换算成 dismissedAtMs
      if (typeof value === 'boolean') out.hideDone = value
    }
  }
  // 兼容上一版写下的 `queue`（那时叫「补答队列」）：搬进 list，别让用户的记录凭空消失。
  if (out.list === undefined && Object.hasOwn(raw, 'queue')) out.list = sanitizeList(raw.queue)
  return out
}

/**
 * 读状态。文件不存在/坏掉/读不动都返回 `{}`。
 * @param {string | undefined} path - 状态文件路径。
 * @returns {object} 净化后的状态。
 */
export function readState(path) {
  if (typeof path !== 'string' || path === '') return {}
  try {
    return sanitizeState(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return {}
  }
}

/**
 * 写状态（原子替换）。失败只返回 false，绝不抛错。
 * @param {string | undefined} path - 状态文件路径。
 * @param {object} value - 要落盘的状态（会被 sanitize）。
 * @returns {boolean} 是否写入成功。
 */
export function writeState(path, value) {
  if (typeof path !== 'string' || path === '') return false
  try {
    const payload = { ...sanitizeState(value), updatedAt: Date.now() }
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
    return true
  } catch {
    try {
      rmSync(`${path}.tmp`, { force: true })
    } catch {
      /* 清理失败就算了 */
    }
    return false
  }
}
