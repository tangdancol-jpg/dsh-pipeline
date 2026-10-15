// 快照版本号 · 段进位：算出「下一个段」，01→02…99→A-01…A-99→B-01，到 Z-99 报错并建议改用 git。
/**
 * dsh-pipeline · 快照版本号 · 进位
 * ============================================================================
 * 裁定 12：段 = `01…99 → A-01…A-99 → B-01…`。
 *
 * ★ 两条硬边界（写在代码里，不是写在文档里）：
 *   ① **不静默回绕**：`Z-99` 之后再没有合法段 —— 报错并建议改用 git，
 *      绝不回绕成 `01`（那会覆盖历史快照，且让"最新"永远算错）。
 *   ② **不跳段也不补位**：非法段一律拒绝，不猜"用户大概想要 01"。
 *
 * @module dsh-pipeline/lib/project/snapshot-next
 */

import {
  MAX_LETTER,
  MAX_SEGMENT_ORDINAL,
  formatSnapshotVersion,
  datePartsOf,
  ordinalOfSegment,
  parseSnapshotVersion,
  segmentOfOrdinal,
} from './snapshot-parse.js'

/** 段用尽时的建议（报错文案里必须带上，别只说"失败了"）。 */
export const SEGMENT_EXHAUSTED_ADVICE =
  '段序号已达上限 `Z-99`（单日 2699 个快照）。★ 正确出路是**改用 git**（pipeline_project_init { git: true }），' +
  '而不是继续堆快照目录 —— 快照是「没有 git 时的替代品」，不是长期版本方案。'

/**
 * 序数 +1，并**跳过不对应任何合法段的空档**。
 *
 * ★ 为什么需要它：段序数不是连续的 —— `99` 是 99、`A-01` 是 **101**，
 *   中间的 **100 没有对应的段**（每个字母段的 `-00` 都不存在）。
 *   直接 `ordinal + 1` 会在 `99→A-01`、`A-99→B-01` 这些地方**掉进空档**，
 *   然后被 `segmentOfOrdinal` 当成"越界"报出来 —— 症状就是"进位根本进不过去"。
 *   本函数把空档跳掉：`99 ⇒ 101`、`199 ⇒ 201`、`2599 ⇒ 2601`。
 *
 * @param {number} ordinal
 * @returns {number}
 */
export function nextValidOrdinal(ordinal) {
  const c = Number(ordinal) + 1
  return c % 100 === 0 ? c + 1 : c
}

/**
 * 下一个段。
 *
 *   01 → 02 ；98 → 99 ；99 → A-01 ；A-01 → A-02 ；A-99 → B-01 ；Z-98 → Z-99 ；Z-99 → 报错
 *
 * @param {string} segment
 * @returns {{ok:true, segment:string, ordinal:number, carried:boolean, from:string}
 *          |{ok:false, code:string, message:string}}
 */
export function nextSegment(segment) {
  const cur = ordinalOfSegment(segment)
  if (!cur.ok) return cur
  if (cur.ordinal >= MAX_SEGMENT_ORDINAL) {
    return {
      ok: false,
      code: 'SEGMENT_EXHAUSTED',
      message: `快照段已经到顶（\`${String(segment).trim()}\` = \`${MAX_LETTER}-99\`，序数 ${MAX_SEGMENT_ORDINAL}），没有下一个段。\n${SEGMENT_EXHAUSTED_ADVICE}`,
    }
  }
  const next = segmentOfOrdinal(nextValidOrdinal(cur.ordinal))
  if (!next.ok) return next
  return {
    ok: true,
    segment: next.segment,
    ordinal: ordinalOfSegment(next.segment).ordinal,
    /** 是否发生了**跨形态/跨字母**的进位（99→A-01、A-99→B-01、Y-99→Z-01）。 */
    carried: cur.n === 99,
    from: String(segment).trim(),
  }
}

/**
 * 给一个已存在段，算出**当天**应该新建的快照版本号。
 *
 * @param {{year?:number, month?:number, day?:number, segments?:string[], existing?:string[], now?:Date}} input
 *   `segments` = 当天已有的段（无顺序要求）；`existing` = 当天已有的**完整版本号**（会先解析出段）。
 * @returns {{ok:true, version:string, segment:string, ordinal:number, dateOrdinal:number, carried:boolean}
 *          |{ok:false, code:string, message:string}}
 */
export function nextSnapshotVersion(input = {}) {
  const date = input.now instanceof Date ? input.now : new Date()
  const parts = datePartsOf(date)
  const year = Number.isInteger(input.year) ? input.year : parts.year
  const month = Number.isInteger(input.month) ? input.month : parts.month
  const day = Number.isInteger(input.day) ? input.day : parts.day

  /** 收集当天已有的段（两种入参形状都收）。 */
  const segs = []
  for (const s of Array.isArray(input.segments) ? input.segments : []) {
    const one = ordinalOfSegment(s)
    if (!one.ok) return one
    segs.push(String(s).trim())
  }
  for (const v of Array.isArray(input.existing) ? input.existing : []) {
    const one = parseSnapshotVersion(v)
    if (!one.ok) return one
    // 只认**同一天**的版本号；别的天的段与今天无关（边界：当天无快照则段从 01 起）。
    if (one.year === year && one.month === month && one.day === day) segs.push(one.segment)
  }

  let segment = '01'
  let carried = false
  if (segs.length > 0) {
    let max = 0
    for (const s of segs) {
      const one = ordinalOfSegment(s)
      if (one.ordinal > max) max = one.ordinal
    }
    const next = nextSegment(segmentOfOrdinal(max).segment)
    if (!next.ok) return next
    segment = next.segment
    carried = next.carried
  }

  const built = formatSnapshotVersion({ year, month, day, segment })
  if (!built.ok) return built
  const echo = parseSnapshotVersion(built.version)
  if (!echo.ok) return echo
  return {
    ok: true,
    version: built.version,
    segment,
    ordinal: echo.ordinal,
    dateOrdinal: echo.dateOrdinal,
    carried,
  }
}
