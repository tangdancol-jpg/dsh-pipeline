// 记忆取回 · **显式 token 上限**：逐条计价、硬截断到上限（必要时**单条**截断并标注）。
/**
 * dsh-pipeline · 记忆 · 取回 · 预算（上限是**硬的**）
 * ============================================================================
 * 判据 R8 是整份设计里**最该先立起来**的一条（`design/memory/05-判据与测试.md` §1）：
 *   没有它，"防上下文被记忆撑爆"就只是愿望 —— 而 `recall` 存在的**唯一理由**
 *   就是替代"整份读"（痛点 A）。
 *
 * ---------------------------------------------------------------------------
 * 计价用**宿主原生**的 `ctx.tokenMeter`（不自造 estimator）
 * ---------------------------------------------------------------------------
 * `ctx.tokenMeter.estimateMessage(message)`（设计 `02` §5 已核实：确定性、不调模型）。
 * 拿不到它时（自测夹具 / 装配不全）降级到本文件的 {@link estimateTokens}，
 * 并在返回里**如实报** `metered_by` —— 不假装两条路一样。
 *
 * ---------------------------------------------------------------------------
 * 三条边界（设计 `05` §3 写死的规定，逐条落在这里）
 * ---------------------------------------------------------------------------
 *   · 上限 `0`        ⇒ 返回空（合法用法：只要计数）；
 *   · 超过天花板      ⇒ 夹到 {@link MAX_LIMIT} 并如实报 `clamped:true`；
 *   · **单条就超上限** ⇒ **截断这一条**并标注 `truncated:true`（不返回半条把整批顶超）。
 *
 * ★ 截断的是**尾部**（R9）：先按传入顺序（调用方已按分数排好）从头放，
 *   第一条放不下就**停** —— 于是"保留了下来"的永远等于"排序后前 k 条"。
 *
 * @module dsh-pipeline/lib/memory/budget
 */

import { meterMessage } from '../hostmsg.js'
// ★ E5：水位档位**读既有阈值**（`lib/context.js` 的 `levelOf` + `DEFAULT_RELAY_POLICY`）——
//   绝不新造第二套 warn/trigger/hard（`CONVENTIONS.md` §7 一个常量只有一个出处）。
import { DEFAULT_RELAY_POLICY, levelOf } from '../context.js'

/** 默认上限（设计 `01` §2 的"取回有显式 token 上限"：默认 4096）。 */
export const DEFAULT_LIMIT = 4096

/** 绝对天花板（再怎么要也不超过它；设计 `05` §3 建议 8192）。 */
export const MAX_LIMIT = 8192

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g

/**
 * 降级用的**确定性**估算法（只在 `ctx.tokenMeter` 拿不到时用）。
 *
 * 口径：CJK 每字 1 token；其余每 4 字符 1 token（向上取整）；非空串至少 1。
 * ★ 它**不追求精确**（精确的那条路是宿主自己的 meter），只保证两件事：
 *   同一输入同一结果、量级与真实分词器同阶 —— R8 关心的是"上限被真的执行"。
 *
 * @param {unknown} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  if (s.length === 0) return 0
  const cjk = (s.match(CJK_RE) ?? []).length
  const other = s.length - cjk
  return Math.max(1, cjk + Math.ceil(other / 4))
}

/**
 * 把宿主的 `ctx.tokenMeter` 适配成 `(text) => number`。
 *
 * ★ **绝不抛**：meter 坏掉 / 抛错 / 返回非有限数 ⇒ 退回 {@link estimateTokens}
 *   （取回是只读动作，"计价器坏了"不该让整次取回失败）。
 *
 * ★ 计价用的消息**必须**经 `hostmsg.js` 的 `meterMessage()` 构造 ——
 *   `role:'user'` 那个字面量在全插件只许出现在那一处（`tests/liveness-check.mjs`
 *   的 A5 是**机械判据**：扫 `lib/**` 的代码行，别处出现即红）。
 *
 * @param {object|null|undefined} tokenMeter - `ctx.tokenMeter`（有 `estimateMessage`）
 * @returns {{meter:(text:string)=>number, metered_by:string}}
 */
export function meterFrom(tokenMeter) {
  const fn = tokenMeter !== null && typeof tokenMeter === 'object' ? tokenMeter.estimateMessage : null
  if (typeof fn !== 'function') return { meter: estimateTokens, metered_by: 'estimate-fallback' }
  const meter = (text) => {
    try {
      const n = fn.call(tokenMeter, meterMessage(text))
      return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : estimateTokens(text)
    } catch {
      return estimateTokens(text)
    }
  }
  return { meter, metered_by: 'tokenMeter.estimateMessage' }
}

/**
 * 一条记忆**给模型看的那一行**（计价的对象 = 返回的对象）。
 *
 * ★ 为什么计价与渲染必须是同一个函数：否则"上限管的是 A、返回的是 B"，
 *   R8 就变成了一句测不到的承诺。所以分数与命中路径也**写进这一行**
 *   （它们是排序的依据，读者需要看见），并且**逐字**出现在返回摘要里。
 *
 * @param {object} item
 * @returns {string}
 */
export function wireLine(item) {
  const score = Number.isFinite(item?.score) ? `[${item.score}]` : ''
  const routes = Array.isArray(item?.routes) && item.routes.length > 0 ? `{${item.routes.join('+')}}` : ''
  const at = String(item?.at ?? '')
  const kind = String(item?.kind ?? '')
  const taskId = String(item?.refs?.task_id ?? '')
  const text = String(item?.text ?? '')
  return `${score}${routes} ${at} 〔${kind}〕${taskId.length > 0 ? `(${taskId}) ` : ''}${text}`.trim()
}

/**
 * ★★ **水位档 → 上限折扣**（E5 的唯一出处；档位由 `lib/context.js` 的 `levelOf()` 给）。
 *
 * 为什么按档打折而不是"水位一高就砍到 0"：水位高的时候**更需要**记忆来交接
 * （`04` §7.2 的原话是"水位已经 55% 还硬塞 4096 token ⇒ 加速触发换班"）——
 * 所以是**下调**，不是**停掉**；越接近硬限给得越少。
 */
export const PRESSURE_DISCOUNT = Object.freeze({
  ok: 1,
  warn: 0.75,
  succession: 0.5,
  hard_limit: 0.25,
})

/**
 * 会话投影的 `contextPressure` → 我们能用的一行水位（**纯函数**）。
 *
 * 实测形状（设计 `02` §4.2）：`{surfaceTokens, contextWindow, pressureTokens, sampledSurfaceTokens}`。
 * 口径：`percent = pressureTokens / contextWindow`（缺 `pressureTokens` 时退到 `surfaceTokens`）；
 * **分母缺失或非正 ⇒ `null`**（读不到水位 ⇒ 不下调，并如实报，而不是猜一个数）。
 *
 * @param {unknown} contextPressure
 * @returns {{percent:number, pressureTokens:number, surfaceTokens:number, contextWindow:number}|null}
 */
export function pressureOf(contextPressure) {
  const p = contextPressure !== null && typeof contextPressure === 'object' ? contextPressure : null
  if (p === null) return null
  const window = Number(p.contextWindow)
  if (!Number.isFinite(window) || window <= 0) return null
  const pressureTokens = Number.isFinite(Number(p.pressureTokens)) ? Number(p.pressureTokens) : Number(p.surfaceTokens)
  if (!Number.isFinite(pressureTokens)) return null
  const percent = Math.max(0, Math.min(100, (pressureTokens / window) * 100))
  return {
    percent: Math.round(percent * 10) / 10,
    pressureTokens,
    surfaceTokens: Number.isFinite(Number(p.surfaceTokens)) ? Number(p.surfaceTokens) : 0,
    contextWindow: window,
  }
}

/**
 * ★★ **按水位下调本次上限**（E5 的核心判据；**纯函数**，输入→输出完全确定）。
 *
 * 规则（写死在这里，测试逐格钉住）：
 *   · 读不到水位（`pressure === null`）⇒ **原样返回**（`reduced:false`，`band:'unknown'`）；
 *   · 否则档位 = `levelOf(percent, policy)`（**既有阈值**），折扣 = {@link PRESSURE_DISCOUNT}[档]；
 *   · `limit` 本来就 ≤ 0（合法用法：只要计数）⇒ 仍然是 0；
 *   · 下调后**至少 1**（只要原来 > 0）—— 不能因为水位高就把切片变成"永远空"。
 *
 * @param {number} limit - 已夹过天花板的上限
 * @param {object|null} pressure - {@link pressureOf} 的产物
 * @param {object} [policy] - `relayPolicy`（缺省 {@link DEFAULT_RELAY_POLICY}）
 * @returns {{limit:number, base:number, reduced:boolean, band:string, percent:number|null, factor:number}}
 */
export function reduceBudgetForPressure(limit, pressure, policy) {
  const base = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0
  const pol = policy !== null && typeof policy === 'object' ? policy : DEFAULT_RELAY_POLICY
  if (pressure === null || pressure === undefined || !Number.isFinite(pressure.percent)) {
    return { limit: base, base, reduced: false, band: 'unknown', percent: null, factor: 1 }
  }
  const band = levelOf(pressure.percent, pol)
  const factor = Number.isFinite(PRESSURE_DISCOUNT[band]) ? PRESSURE_DISCOUNT[band] : 1
  if (factor >= 1 || base === 0) {
    return { limit: base, base, reduced: false, band, percent: pressure.percent, factor }
  }
  const next = Math.max(1, Math.floor(base * factor))
  return { limit: next, base, reduced: next < base, band, percent: pressure.percent, factor }
}

/**
 * ★ **进程内的"最近一次 recall 用量"**（E5 的 04 §7.4：让调参看得见）。
 *
 * 为什么不落盘：它是**观测**不是事实 —— 一次会话里跑了几次 recall、各用了多少，
 * 重启即失效才是对的（落盘会变成第二份需要维护的账）。
 *
 * @param {{tokens:number, limit:number, count:number, reduced_by:string, project_dir:string}} entry
 */
export function noteRecallUsage(entry) {
  LAST_RECALL_USAGE = {
    tokens: Number.isFinite(Number(entry?.tokens)) ? Number(entry.tokens) : 0,
    limit: Number.isFinite(Number(entry?.limit)) ? Number(entry.limit) : 0,
    count: Number.isFinite(Number(entry?.count)) ? Number(entry.count) : 0,
    reduced_by: String(entry?.reduced_by ?? ''),
    project_dir: String(entry?.project_dir ?? ''),
  }
  return LAST_RECALL_USAGE
}

/** 最近一次 recall 的用量（没跑过 ⇒ `null`）。 */
export function lastRecallUsage() {
  return LAST_RECALL_USAGE
}

/** @type {null|{tokens:number, limit:number, count:number, reduced_by:string, project_dir:string}} */
let LAST_RECALL_USAGE = null

/**
 * 把上限夹到合法区间。
 *
 * @param {unknown} value - 调用方给的上限
 * @returns {{limit:number, clamped:boolean}}
 */
export function clampLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return { limit: DEFAULT_LIMIT, clamped: false }
  const i = Math.floor(n)
  if (i < 0) return { limit: 0, clamped: true }
  if (i > MAX_LIMIT) return { limit: MAX_LIMIT, clamped: true }
  return { limit: i, clamped: false }
}

/**
 * 把一条记忆截到"放得进 room"为止（二分找最长的前缀）。
 *
 * @param {object} item
 * @param {number} room - 还剩多少 token
 * @param {(t:string)=>number} meter
 * @returns {{item:object, tokens:number}|null} 连"最短形式"都放不下 ⇒ `null`
 */
export function truncateToFit(item, room, meter) {
  const text = String(item?.text ?? '')
  const base = { ...item, truncated: true }
  const costOf = (cut) => meter(wireLine({ ...base, text: cut }))
  if (costOf('…') > room) return null
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (costOf(`${text.slice(0, mid)}…`) <= room) lo = mid
    else hi = mid - 1
  }
  const cut = lo >= text.length ? text : `${text.slice(0, lo)}…`
  const tokens = costOf(cut)
  return { item: { ...base, text: cut }, tokens }
}

/**
 * ★★ **按上限截断**（本域唯一执行上限的地方）。
 *
 * @param {object[]} items - 已排好序的候选（分数高的在前）
 * @param {object} [opts]
 * @param {number} [opts.limit] - token 上限（缺省 {@link DEFAULT_LIMIT}）
 * @param {(t:string)=>number} [opts.meter]
 * @returns {{items:object[], tokens:number, limit:number, clamped:boolean,
 *            truncated:number, dropped:number, metered_by:string}}
 */
export function applyBudget(items, opts = {}) {
  const list = Array.isArray(items) ? items : []
  const { limit, clamped } = clampLimit(opts.limit === undefined ? DEFAULT_LIMIT : opts.limit)
  const meter = typeof opts.meter === 'function' ? opts.meter : estimateTokens
  const metered_by = typeof opts.metered_by === 'string' ? opts.metered_by : 'estimate-fallback'
  const out = { items: [], tokens: 0, limit, clamped, truncated: 0, dropped: 0, metered_by }
  if (limit <= 0) return { ...out, dropped: list.length }

  let used = 0
  for (const it of list) {
    const line = wireLine(it)
    const cost = meter(line)
    if (used + cost <= limit) {
      out.items.push({ ...it, tokens: cost })
      used += cost
      continue
    }
    // ★ 到这里：这一条放不下。只在**一条都还没放下**时才截断它（单条超上限那条边界），
    //   否则一律停 —— "截断的是尾部"（R9）就是这么保证的。
    if (out.items.length === 0) {
      const cut = truncateToFit(it, limit, meter)
      if (cut !== null) {
        out.items.push({ ...cut.item, tokens: cut.tokens })
        used += cut.tokens
        out.truncated += 1
      }
    }
    break
  }
  out.tokens = used
  out.dropped = Math.max(0, list.length - out.items.length)
  return out
}
