/**
 * dsh-pipeline · 通用工具
 * ============================================================================
 * 纯函数集合，不依赖 cordis / ctx，可被自测直接 import。
 *
 * @module dsh-pipeline/lib/util
 */

import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 统一路径键：反斜杠转正斜杠、折叠 `.`/`..`、Windows 下小写化。
 * 用于「同一条路径」比较 —— 同一个目录可能从 `C:\a\b`、`c:/a/b`、
 * `C:\a\.\b` 三种写法进来，不归一化就会漏判。
 *
 * @param {string} p
 * @returns {string}
 */
export function pathKey(p) {
  let s = String(p ?? '').replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const parts = []
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else parts.push('..')
      continue
    }
    parts.push(seg)
  }
  s = parts.join('/')
  if (/^[a-z]:/i.test(s)) s = s.toLowerCase()
  return s
}

/**
 * `child` 是否位于目录 `root` 之内（含 root 自身）。
 * 两侧都过 {@link pathKey}，所以大小写与分隔符不影响判定。
 *
 * @param {string} root
 * @param {string} child
 * @returns {boolean}
 */
export function isInside(root, child) {
  const r = pathKey(root)
  const c = pathKey(child)
  if (r.length === 0 || c.length === 0) return false
  if (c === r) return true
  return c.startsWith(r.endsWith('/') ? r : r + '/')
}

// ---------------------------------------------------------------------------
// ★ **锚点**：裸相对路径按谁解析
// ---------------------------------------------------------------------------

/**
 * ★ 本插件的**包根**（= `lib/` 的上一级）。
 *
 * 它是**授权面锚点**的默认值：`change_scope[].path` 与 `writers.partitions[].scope_paths`
 * 里写的裸相对路径（`index.js`、`lib/tools.js`、`tests/`…）一律按**插件包根**解析，
 * 而**不是**按任务的 `project_root`（工作区根）。
 *
 * 为什么必须分开：本插件被用来改自己的时候，任务的工作区根是
 * `<profile>/`，而真正要改的文件在 `<profile>/node_modules/dsh-pipeline/` 之下。
 * 拿工作区根去拼裸相对路径 ⇒ 20 条授权**条条落空**（三个编写席全被挡死）；
 * 反过来，工作区根下**恰好同名**的 `package.json` / `cordis.patch.yml`
 * 又会被**误放行**（那两份正是越界清单点名禁改的档）。
 *
 * 怎么算出来的：从**本模块自己的位置**（`lib/util.js`）往上退一级 ——
 * 这是"包根"唯一无歧义的来源，**不依赖授权面本身**（拿被判定对象去推断判定基准
 * 会引入歧义，自己判自己）。
 */
export const PACKAGE_ROOT = pathKey(resolve(dirname(fileURLToPath(import.meta.url)), '..'))

/**
 * ★ **按锚点解析一条可能相对的路径**（授权面 / 分区路径专用）。
 *
 * 规则（三条，别改）：
 *   ① 空串 ⇒ 空串（调用方自己决定怎么处理"没写"）；
 *   ② `.` / `./` ⇒ 锚点自身；
 *   ③ 绝对路径（`C:\…` / `/…`）⇒ 原样归一化；**裸相对路径 ⇒ 一律拼到锚点下**。
 *
 * ⚠️ 绝不按"从授权面自身推断出的唯一落点目录"解析 —— 那会让判定基准依赖被判定对象。
 *
 * @param {string} anchor - 锚点（绝对目录；通常是插件包根）
 * @param {string} p - 待解析路径
 * @returns {string} pathKey 形式的绝对路径；入参为空时返回空串
 */
export function resolveAgainstAnchor(anchor, p) {
  const s = String(p ?? '').trim()
  if (s.length === 0) return ''
  if (s === '.' || s === './' || s === '.\\') return pathKey(anchor)
  if (isAbsolute(s) || /^[a-z]:[\\/]/i.test(s) || s.startsWith('/') || s.startsWith('\\')) return pathKey(s)
  return pathKey(`${pathKey(anchor)}/${s}`.replace(/\/{2,}/g, '/'))
}

/**
 * 把可能是相对路径的目标解析成绝对路径。
 *
 * @param {string} base - 基准目录（通常是 session cwd）
 * @param {string} target
 * @returns {string}
 */
export function toAbsolute(base, target) {
  const t = String(target ?? '')
  if (t.length === 0) return ''
  return isAbsolute(t) ? resolve(t) : resolve(base, t)
}

/**
 * 相对路径展示（尽量短、但保持可读）。无法相对化时原样返回绝对路径。
 *
 * @param {string} base
 * @param {string} target
 * @returns {string}
 */
export function displayPath(base, target) {
  try {
    const rel = relative(base, target)
    if (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
  } catch {
    /* 跨盘符 relative 会抛，退回绝对路径 */
  }
  return target
}

/** 稳定字符串化：对象键排序后再序列化，保证同样内容得到同样的哈希。 */
export function stableStringify(value) {
  const seen = new WeakSet()
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return '[circular]'
    seen.add(v)
    if (Array.isArray(v)) return v.map(walk)
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k])
    return out
  }
  return JSON.stringify(walk(value))
}

/** 内容 sha256（前 16 位十六进制，够用且短）。 */
export function shortHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

/** 完整 sha256（十六进制）。 */
export function fullHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** 随机 id（小写十六进制）。 */
export function randomId(bytes = 8) {
  return randomBytes(bytes).toString('hex')
}

/**
 * 生成任务 id：`T-<YYYYMMDD>-<6hex>`。
 * 带日期是为了人肉翻目录时能一眼看出先后。
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function newTaskId(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `T-${y}${m}${d}-${randomId(3)}`
}

/** ISO 时间戳（秒精度足够，且比毫秒好读）。 */
export function nowIso(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 把值收敛成字符串数组（去空、去重、保序）。 */
export function toStringArray(value) {
  if (Array.isArray(value)) {
    const out = []
    const seen = new Set()
    for (const v of value) {
      const s = typeof v === 'string' ? v.trim() : ''
      if (s.length === 0 || seen.has(s)) continue
      seen.add(s)
      out.push(s)
    }
    return out
  }
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()]
  return []
}

/** 截断长文本（给日志与错误信息用）。 */
export function clamp(text, max = 600) {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}…(共 ${s.length} 字符)`
}

/**
 * 截断长文本（给审计行 / 单行摘要用）。
 *
 * 与 {@link clamp} 的区别只在省略号的措辞：clamp 会报出总长度（排障时有用），
 * clip 不报（审计行里长度是噪音）。
 */
export function clip(text, max = 200) {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}…`
}
