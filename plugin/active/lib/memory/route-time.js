// 记忆取回 · **时间路**：按时间窗筛选 + 按 recency 排序（"这个任务之前怎么处理的""最近改过什么"）。
/**
 * dsh-pipeline · 记忆 · 取回 · 时间路
 * ============================================================================
 * 三条取回路径里最便宜的一条（设计 `03-模块拆分.md` §3）：真实查询形状是
 * **"这个任务之前怎么处理的"**、**"最近改过什么"** —— 都只需要"谁、什么时候"。
 *
 * ---------------------------------------------------------------------------
 * 为什么排序**不能**用 `Array.prototype.sort` 的默认比较
 * ---------------------------------------------------------------------------
 * 默认比较把元素转成字符串按 UTF-16 码元比 —— 对 ISO 时刻**碰巧**能用，但那是
 * 巧合（一旦有 `+08:00` 这种带偏移的写法就不再是"时间序"）。所以：
 *   · 先 `Date.parse` 成毫秒（解析失败 ⇒ `-Infinity`，即"最旧"，**不丢**）；
 *   · 时刻相同时用 `id` 升序兜底 —— **确定性**的前提是没有并列不定的比较键。
 *
 * ★ 本文件是**纯函数**：不读盘、不认识 `fs`，输入是 `load.js` 产出的条目数组。
 *
 * @module dsh-pipeline/lib/memory/route-time
 */

/** 时间路的固定路由名（合并时用它做权重与来源标记）。 */
export const ROUTE_TIME = 'time'

/**
 * 把一个时刻解析成毫秒。
 *
 * @param {unknown} value - ISO 串 / 数字时间戳 / Date
 * @returns {number} 解析失败 ⇒ `-Infinity`（排序上"最旧"，**不是 0** —— 0 是 1970）
 */
export function parseTime(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : -Infinity
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const s = String(value ?? '').trim()
  if (s.length === 0) return -Infinity
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : -Infinity
}

/**
 * 时间路的序（**倒序**：新的在前；同刻按 id 升序）。
 *
 * @param {object[]} records
 * @returns {object[]} 新数组（不改入参）
 */
export function sortByRecency(records) {
  return [...records].sort((a, b) => {
    const ta = parseTime(a?.at)
    const tb = parseTime(b?.at)
    if (ta !== tb) return tb - ta
    const ia = String(a?.id ?? '')
    const ib = String(b?.id ?? '')
    return ia < ib ? -1 : ia > ib ? 1 : 0
  })
}

/**
 * ★ **时间路取回**。
 *
 * @param {object[]} records - 全部候选（`load.js` 的产物）
 * @param {object} [opts]
 * @param {string} [opts.since] - 起（含）；解析失败 ⇒ 视为没给
 * @param {string} [opts.until] - 止（含）；解析失败 ⇒ 视为没给
 * @param {string} [opts.taskId] - 只看这一张单（按 `refs.task_id`）
 * @param {number} [opts.limit] - 最多几条（不给 = 不限）
 * @returns {object[]} 命中的条目（**已按 recency 排序**）
 */
export function routeTime(records, opts = {}) {
  const list = Array.isArray(records) ? records : []
  const since = opts.since === undefined || opts.since === null ? -Infinity : parseTime(opts.since)
  const until = opts.until === undefined || opts.until === null ? Infinity : parseTime(opts.until)
  const taskId = typeof opts.taskId === 'string' ? opts.taskId.trim() : ''
  const limit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : Infinity

  const hit = list.filter((r) => {
    if (taskId.length > 0 && String(r?.refs?.task_id ?? '') !== taskId) return false
    const t = parseTime(r?.at)
    // ★ 解析不出来的时刻（`-Infinity`）：**时间窗开着就不要它**（它答不了"什么时候"），
    //   但窗口没给时仍然保留 —— 让它有机会被关键词路捞出来。
    if (t === -Infinity) return since === -Infinity && until === Infinity
    return t >= since && t <= until
  })
  const sorted = sortByRecency(hit)
  return Number.isFinite(limit) ? sorted.slice(0, limit) : sorted
}
