// 快照版本号 · 序数比较：按解析出来的整数比大小（禁止字符串排序），给出最新快照与排序结果。
/**
 * dsh-pipeline · 快照版本号 · 序数比较
 * ============================================================================
 * 裁定 12 的后半句：**比较必须解析成序数，禁止字符串排序**。
 *
 * 本文件是那句话的**唯一落点**：所有"哪个更新"的判断都从这里走，
 * 别处不许再写一次 `a < b`。
 *
 * ★ 文件头给的现场反例（`10.9` vs `10.15`）在这里是可执行的 ——
 *   见 {@link lexicographicCompare}：它**故意**保留字符串比较，只为让测试能
 *   证明"字符串排序确实会判错"。**产品代码只许用 {@link compareSnapshotVersions}。**
 *
 * @module dsh-pipeline/lib/project/snapshot-compare
 */

import { parseSnapshotVersion } from './snapshot-parse.js'

/**
 * ★ **仅供参考/取证用的字符串比较** —— 产品代码**不许**用它判"最新"。
 *
 * 保留它的理由只有一个：验收 A09 要求"有反例用例证明字符串排序会得出错误结论"，
 * 而反例要能**真的跑给你看**（不能只在注释里断言）。测试拿它当"错误实现"的对照组。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 | 0 | 1
 */
export function lexicographicCompare(a, b) {
  const x = String(a ?? '')
  const y = String(b ?? '')
  if (x === y) return 0
  return x < y ? -1 : 1
}

/**
 * **正确的**比较：解析成序数再比。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} -1（a 更早）| 0（同一个版本号）| 1（a 更新）
 * @throws {TypeError} 任一侧不是合法快照版本号时**抛错**（不静默当成相等 —— 静默相等会让"最新"随机化）
 */
export function compareSnapshotVersions(a, b) {
  const pa = parseSnapshotVersion(a)
  if (!pa.ok) throw new TypeError(`比较快照版本号时左侧非法：${pa.message}`)
  const pb = parseSnapshotVersion(b)
  if (!pb.ok) throw new TypeError(`比较快照版本号时右侧非法：${pb.message}`)
  if (pa.totalOrdinal === pb.totalOrdinal) return 0
  return pa.totalOrdinal < pb.totalOrdinal ? -1 : 1
}

/**
 * 带 `{ok}` 信封的比较（不想让调用方 try/catch 时用这个）。
 *
 * @param {string} a
 * @param {string} b
 * @returns {{ok:true, cmp:number}|{ok:false, code:string, message:string}}
 */
export function compareSnapshotVersionsSafe(a, b) {
  try {
    return { ok: true, cmp: compareSnapshotVersions(a, b) }
  } catch (err) {
    return { ok: false, code: 'VERSION_UNPARSABLE', message: String(err?.message ?? err) }
  }
}

/**
 * 按**序数**升序排序（不改入参）。
 *
 * @param {string[]} versions
 * @returns {{ok:true, sorted:string[]}|{ok:false, code:string, message:string}}
 */
export function sortSnapshotVersions(versions) {
  const list = Array.isArray(versions) ? versions.map((v) => String(v)) : []
  for (const v of list) {
    const p = parseSnapshotVersion(v)
    if (!p.ok) return p
  }
  const sorted = [...list].sort(compareSnapshotVersions)
  return { ok: true, sorted }
}

/**
 * 最新快照（**按序数**，不是按字符串）。
 *
 * @param {string[]} versions
 * @returns {{ok:true, latest:string|null, ordinal:number|null}|{ok:false, code:string, message:string}}
 */
export function latestSnapshot(versions) {
  const r = sortSnapshotVersions(versions)
  if (!r.ok) return r
  if (r.sorted.length === 0) return { ok: true, latest: null, ordinal: null }
  const latest = r.sorted[r.sorted.length - 1]
  return { ok: true, latest, ordinal: parseSnapshotVersion(latest).totalOrdinal }
}

/**
 * ★ **用字符串排序判"最新"会得到什么** —— 只给测试/取证用。
 *
 * 存在意义：让 `tests/p2` 能**同时**打印出"错误实现给出什么"与"正确实现给出什么"，
 * 从而把"A09 有反例"落成可运行的证据，而不是一句注释。
 *
 * @param {string[]} versions
 * @returns {{latest:string|null, sorted:string[]}}
 */
export function latestSnapshotByStringSort(versions) {
  const list = (Array.isArray(versions) ? versions : []).map((v) => String(v))
  const sorted = [...list].sort(lexicographicCompare)
  return { latest: sorted.length === 0 ? null : sorted[sorted.length - 1], sorted }
}
