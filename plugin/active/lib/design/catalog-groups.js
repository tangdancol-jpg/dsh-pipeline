// 产品目录 · 分组常量：两组（MVP 必须 / 后续再说）的键、中文名与取值规则，一处定义。
/**
 * dsh-pipeline · 产品目录 · 分组
 * ============================================================================
 * 需求 3 的原话：需求 agent 的核心目的就是**设计产品目录**，按 **MVP** 建立，不要复杂化。
 * 定稿 §3.3：产品目录分两组 —— **`MVP 必须`** / **`后续再说`**，**每条含验收判据**。
 *
 * ★ 本文件只管"分组是什么"，不管"分组里的条目合不合法"（那是 `catalog-schema.js`）。
 *   拆开是因为这两件事的**改动原因不同**：分组名几乎不变，校验规则会随验收标准演进。
 *
 * @module dsh-pipeline/lib/design/catalog-groups
 */

/** 分组的**键**（数据里就写这两个词，别写中文）。 */
export const GROUP_MVP = 'mvp'
export const GROUP_LATER = 'later'

/** 两组的中文名（给人看的唯一出处）。 */
export const GROUP_LABELS = Object.freeze({
  [GROUP_MVP]: 'MVP 必须',
  [GROUP_LATER]: '后续再说',
})

/** 分组的展示顺序（MVP 在前 —— 先做必须的）。 */
export const GROUP_ORDER = Object.freeze([GROUP_MVP, GROUP_LATER])

/** 全部合法分组键。 */
export const GROUP_KEYS = Object.freeze([...GROUP_ORDER])

/** 某个键是不是合法分组。 */
export function isGroupKey(key) {
  return GROUP_KEYS.includes(String(key ?? ''))
}

/** 分组的中文名（认不出就原样返回，便于报错时看得见到底写的是什么）。 */
export function groupLabel(key) {
  return GROUP_LABELS[key] ?? String(key ?? '')
}

/**
 * 把一份产品目录按组切开（不做校验；结构不对时给空数组，让校验器去报）。
 *
 * @param {object} catalog
 * @returns {{[GROUP_MVP]:object[], [GROUP_LATER]:object[]}}
 */
export function groupOf(catalog) {
  const c = catalog ?? {}
  return {
    [GROUP_MVP]: Array.isArray(c[GROUP_MVP]) ? c[GROUP_MVP] : [],
    [GROUP_LATER]: Array.isArray(c[GROUP_LATER]) ? c[GROUP_LATER] : [],
  }
}

/**
 * 建一份空目录（**空 MVP 是会被校验器拒的** —— 这个函数只用于"从头收集条目"）。
 *
 * @returns {{mvp:object[], later:object[]}}
 */
export function emptyCatalog() {
  return { [GROUP_MVP]: [], [GROUP_LATER]: [] }
}

/**
 * 统计信息（给状态展示与摘要用）。
 *
 * @param {object} catalog
 * @returns {{mvp:number, later:number, total:number, acceptance:number, withAcceptance:number}}
 */
export function catalogStats(catalog) {
  const g = groupOf(catalog)
  const all = [...g[GROUP_MVP], ...g[GROUP_LATER]]
  let acceptance = 0
  let withAcceptance = 0
  for (const e of all) {
    const acc = Array.isArray(e?.acceptance) ? e.acceptance.filter((a) => String(a ?? '').trim().length > 0) : []
    acceptance += acc.length
    if (acc.length > 0) withAcceptance += 1
  }
  return { mvp: g[GROUP_MVP].length, later: g[GROUP_LATER].length, total: all.length, acceptance, withAcceptance }
}
