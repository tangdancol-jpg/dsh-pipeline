// 记忆取回 · **合并与重排**：多路并起来、按 id 去重、用**确定性打分**定序（无 learned rerank）。
/**
 * dsh-pipeline · 记忆 · 取回 · 合并与重排
 * ============================================================================
 * 三路各自会命中同一批记忆（同一张任务单既能被时间路捞到、也能被关键词路捞到）。
 * 本文件回答两个问题：**留哪一条**（去重）、**排第几**（重排）。
 *
 * ---------------------------------------------------------------------------
 * 为什么不用交叉编码器 / 也不用"模型打分"（用户点名"不抄"）
 * ---------------------------------------------------------------------------
 * 打分的输入全是**整数命中数**，没有任何浮点、没有任何外部调用 ⇒
 * **同一输入必然同一输出**（判据 R6 就是这么断言"跑两次字节级相同"的）。
 * 而 learned rerank 恰恰是**不可解释且不确定**的那一类，正是设计 `01` §4.2 砍掉的。
 *
 * ---------------------------------------------------------------------------
 * 定序规则（顺序即优先级，写死在这里）
 * ---------------------------------------------------------------------------
 *   ① `score` 倒序   —— 实体命中（+{@link ROUTE_WEIGHT}.entity）> 关键词命中（按命中强度累加）
 *                        > 只有时间路兜底命中（+1）；
 *   ② `at` 倒序      —— 同分时**新的在前**；
 *   ③ `id` 升序      —— 再同分时用 id 兜底：**没有它就存在"并列不定"，同一输入可能给出不同顺序**。
 *
 * ★ 纯函数：不读盘、不认识 `fs`。
 *
 * @module dsh-pipeline/lib/memory/merge
 */

import { parseTime } from './route-time.js'

/** 各路命中一次的权重（实体 > 关键词 > 时间）。 */
export const ROUTE_WEIGHT = Object.freeze({
  entity: 8,
  keyword: 1,
  time: 1,
})

/** 路由名的固定顺序（决定 `routes[]` 的写法，避免"看起来不一样但语义相同"）。 */
export const ROUTE_ORDER = Object.freeze(['entity', 'keyword', 'time'])

/**
 * 按 `id` 去重（**保序**：先出现的那条留下）。
 *
 * @param {object[]} records
 * @returns {object[]}
 */
export function dedupeById(records) {
  const seen = new Set()
  const out = []
  for (const r of Array.isArray(records) ? records : []) {
    const id = String(r?.id ?? '')
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(r)
  }
  return out
}

/** 把路由名按 {@link ROUTE_ORDER} 规范排序（保证 `routes` 字段可比对）。 */
function normalizeRoutes(names) {
  const set = new Set(names)
  return ROUTE_ORDER.filter((n) => set.has(n))
}

/**
 * ★ **合并多路取回的结果**。
 *
 * @param {object} routes - `{time?:object[], keyword?:object[], entity?:object[]}`
 *   · `time` / `keyword` / `entity` 各路**可以缺席**（E0 只有时间与关键词两路，
 *     实体路在 E2 落地）—— 缺席按空数组算，合并规则不变。
 * @param {object} [opts]
 * @param {number} [opts.limit] - 最多几条（合并**之后**截断；不给 = 不限）
 * @returns {object[]} 合并后的条目：`{...record, score, routes[], hits[]}`
 */
export function mergeRoutes(routes, opts = {}) {
  const src = routes !== null && typeof routes === 'object' ? routes : {}
  const byId = new Map()
  for (const name of ROUTE_ORDER) {
    const list = Array.isArray(src[name]) ? src[name] : []
    for (const r of list) {
      const id = String(r?.id ?? '')
      if (id.length === 0) continue
      const cur = byId.get(id) ?? { record: r, routes: [], keywordScore: 0, hits: [] }
      cur.routes.push(name)
      if (name === 'keyword') {
        cur.keywordScore += Number.isFinite(r?.score) ? Number(r.score) : 0
        if (Array.isArray(r?.hits)) cur.hits.push(...r.hits)
      }
      // ★ 实体路也把它"命中了哪几个实体键"带进 `hits` —— 否则"为什么这条排在前面"
      //   在实体命中那一条上答不出来（可解释性是这一路选它的全部理由）。
      else if (name === 'entity' && Array.isArray(r?.hits)) cur.hits.push(...r.hits)
      byId.set(id, cur)
    }
  }

  const merged = [...byId.values()].map((e) => {
    const routes = normalizeRoutes(e.routes)
    const score =
      (routes.includes('entity') ? ROUTE_WEIGHT.entity : 0) +
      e.keywordScore * ROUTE_WEIGHT.keyword +
      (routes.includes('time') ? ROUTE_WEIGHT.time : 0)
    // ★ 去掉各路带进来的临时字段（`score` / `hits` 由这里统一给）——
    //   否则"同一份数据"会因为"它是从哪一路来的"而长得不一样。
    const { score: _s, hits: _h, ...record } = e.record
    return { ...record, score, routes, hits: [...new Set(e.hits)].sort() }
  })

  merged.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const ta = parseTime(a.at)
    const tb = parseTime(b.at)
    if (ta !== tb) return tb - ta
    const ia = String(a.id ?? '')
    const ib = String(b.id ?? '')
    return ia < ib ? -1 : ia > ib ? 1 : 0
  })

  const limit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : Infinity
  return Number.isFinite(limit) ? merged.slice(0, limit) : merged
}
