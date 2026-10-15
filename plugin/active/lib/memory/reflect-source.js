// reflect 的**输入**：宿主物化的 `turnOutline`（会话投影）+ `.pipeline` 既有档 —— 取到多少算多少，绝不抛。
/**
 * dsh-pipeline · 记忆 · reflect 的输入（会话投影）
 * ============================================================================
 * 设计 `02-DSH-原生设施.md` §4.2 的实测结论：宿主**已经**把逐轮过程物化好了 ——
 * 会话投影里有 `turnOutline = {turns:[{turn, seq, prompt, response}], draft}`（实测 373 条）。
 * 所以这一块**不需要**我们去解会话日志（那件事 §3.3 明写了很坑：多帧 zstd，
 * `zstdDecompressSync` 只解得出第一帧）。
 *
 * ---------------------------------------------------------------------------
 * 两条纪律
 * ---------------------------------------------------------------------------
 *   ① **纯函数负责"折"，读盘/读宿主负责"取"** —— {@link normalizeOutline} 是纯的
 *      （可单测、可断言"同输入同输出"），{@link hostTurnOutline} 只负责把宿主那份
 *      拿回来，**拿不到就如实说 `via:'unavailable'`**，绝不抛、绝不猜。
 *   ② **不新增装配期依赖**：`sessionProjections` 是**唯一**新增的 inject 项
 *      （见 `lib/host-surface.js`；它必须注入 —— 直接取属性在没 inject 时会抛）。
 *      其余服务（`agents` / `sessionProjectionCache`）一律走 {@link readHostService}
 *      的**运行期探测**（拿到就用、拿不到就降级），与 `lib/tools/memory.js` 取
 *      `ctx.tokenMeter` 的做法同一条路子。
 *      ★ 2026-10-15（缺陷 B）：探测**不能**写成 `ctx.X` —— 那在没 inject 时是**抛**，
 *        不是回 `undefined`（真机现场：`cannot get property "sessionProjections" without inject`）。
 *
 * ★ 时刻/随机数一概不取：投影里的 `turn` / `seq` 都是宿主给的整数。
 *
 * @module dsh-pipeline/lib/memory/reflect-source
 */

import { readHostService } from '../host-surface.js'
import { clip } from './record.js'

/** 投影里那个键的名字（写在一处，免得两处手抄字符串）。 */
export const TURN_OUTLINE_KEY = 'turnOutline'

/** ★ E5：水位那一个键（`02` §4.2 实测形状 `{surfaceTokens, contextWindow, pressureTokens, …}`）。 */
export const CONTEXT_PRESSURE_KEY = 'contextPressure'

/** 活文档里最多写几轮（多出来的只计数，不写正文 —— 活文档不是会话日志的副本）。 */
export const MAX_TURNS = 12

/** 单轮 prompt / response 各自的最大长度。 */
export const TURN_TEXT_MAX = 120

/**
 * ★ **把宿主物化的 `turnOutline` 折成我们自己的形状**（纯函数）。
 *
 * 容错口径（边界都写死在这里，免得"怎么实现都不算错"）：
 *   · 不是对象 / `turns` 不是数组 ⇒ `{available:false, turns:0, items:[]}`（**不抛**）；
 *   · 单条形状不对 ⇒ 该条的字段取空串，**仍然占一行**（丢一条不如留个占位）；
 *   · 只取**最后 `MAX_TURNS` 条**（`slice(-n)`）。
 *
 * @param {unknown} raw - 投影里的 `turnOutline`
 * @param {object} [opts]
 * @param {number} [opts.maxTurns]
 * @param {number} [opts.textMax]
 * @returns {{available:boolean, turns:number, items:Array<{turn:number|null, prompt:string, response:string}>}}
 */
export function normalizeOutline(raw, opts = {}) {
  const outline = raw !== null && typeof raw === 'object' ? raw : null
  const turns = Array.isArray(outline?.turns) ? outline.turns : []
  const maxTurns = Number.isInteger(opts.maxTurns) && opts.maxTurns > 0 ? opts.maxTurns : MAX_TURNS
  const textMax = Number.isInteger(opts.textMax) && opts.textMax > 0 ? opts.textMax : TURN_TEXT_MAX
  const items = turns.slice(-maxTurns).map((t) => {
    const row = t !== null && typeof t === 'object' ? t : {}
    const n = Number(row.turn)
    return {
      turn: Number.isFinite(n) ? Math.trunc(n) : null,
      prompt: clip(row.prompt, textMax),
      response: clip(row.response, textMax),
    }
  })
  return { available: outline !== null && turns.length > 0, turns: turns.length, items }
}

/** 空投影（唯一出处：`normalizeOutline` 与 `hostTurnOutline` 的降级都返回它）。 */
export function emptyOutline() {
  return { available: false, turns: 0, items: [] }
}

/**
 * 从宿主里取出**会话对象**（`{agent:{id}}` → session）。取不到 ⇒ `null`。
 *
 * @param {object} ctx - `deps.ctx`
 * @param {string} agentId
 * @returns {object|null}
 */
function sessionOf(ctx, agentId) {
  try {
    // ★ 缺陷 B：显式注入的服务用 `ctx.get`（**不带 inject 要求**）读 —— `ctx.agents`
    //   这种直接取属性在没 inject 时是**抛**，会把"这个会话是谁"静默降级成 null，
    //   于是连投影都不会去试（水位因此永远读不到）。
    const agents = readHostService(ctx, 'agents')
    if (agents === null || agents === undefined || typeof agents.get !== 'function') return null
    const entry = agents.get(agentId)
    const session = entry?.session ?? entry ?? null
    return session !== null && typeof session === 'object' ? session : null
  } catch {
    return null
  }
}

/** 从宿主投影的两种返回形状里取某个键（`{values:{…}}` / `{rows:{…}}` / 裸对象都认）。 */
function pickFrom(value, key) {
  if (value === null || value === undefined || typeof value !== 'object') return undefined
  if (value.values !== undefined && typeof value.values === 'object') return value.values[key]
  if (value.rows !== undefined && typeof value.rows === 'object') return value.rows[key]
  return value[key]
}

/**
 * ★★ **把宿主会话投影里的一个键取回来**（懒读 + 绝不抛 + 如实报从哪来）。
 *
 * 这是 E3（`turnOutline`）与 E5（`contextPressure`）**共用**的那一步读取 ——
 * 两条宿主路（`02` §4.1 的实测）：
 *   ① `ctx.sessionProjections.snapshot(session, [key])` —— 同步一致的切面；
 *   ② `ctx.sessionProjectionCache.cachedSnapshot(header, [key])` —— 零日志冷读。
 * 都拿不到 ⇒ `{ok:false, value:null, via:'unavailable'}`：**这不是错误**，
 * 只是"这一次触发读不到那个投影"（调用方自己决定怎么如实交代）。
 *
 * @param {object} svc - `{ctx, warn?}`
 * @param {string} agentId
 * @param {string} key - 投影键（`turnOutline` / `contextPressure` …）
 * @returns {Promise<{ok:boolean, value:*, via:string, note:string}>}
 */
export async function hostProjection(svc, agentId, key) {
  const missing = { ok: false, value: null, via: 'unavailable', note: '' }
  try {
    const ctx = svc?.ctx ?? null
    if (ctx === null) return { ...missing, note: '没有 ctx（自测替身 / 装配不全）' }
    const session = sessionOf(ctx, String(agentId ?? ''))
    const keys = [String(key)]

    const projections = readHostService(ctx, 'sessionProjections')
    if (session !== null && typeof projections?.snapshot === 'function') {
      const raw = pickFrom(await projections.snapshot(session, keys), key)
      if (raw !== undefined) return { ok: true, value: raw, via: 'sessionProjections.snapshot', note: '' }
    }

    // ★ 兜底那条路同样**只探测**：`sessionProjectionCache` 由可选包提供，写进 inject
    //   会让"没有那个包的构建"整个插件装不上 —— 而它只是兜底。
    const cache = readHostService(ctx, 'sessionProjectionCache')
    if (typeof cache?.cachedSnapshot === 'function') {
      const header = session?.header ?? session ?? null
      const raw = pickFrom(await cache.cachedSnapshot(header, keys), key)
      if (raw !== undefined) return { ok: true, value: raw, via: 'sessionProjectionCache.cachedSnapshot', note: '' }
    }

    return { ...missing, note: '宿主没有可用的会话投影（或这个会话还没有投影）' }
  } catch (err) {
    // ★ 投影是"能更好"，不是"没它就不对"：读失败只降级，不许把触发它的那次调用带崩。
    return { ...missing, note: `读投影失败：${String(err?.message ?? err)}` }
  }
}

/**
 * ★ **把宿主的 `turnOutline` 取回来**（E3；`hostProjection` 的一层包装，判据不变）。
 *
 * @param {object} svc - `{ctx, warn?}`
 * @param {string} agentId
 * @returns {Promise<{ok:boolean, outline:object|null, via:string, note:string}>}
 */
export async function hostTurnOutline(svc, agentId) {
  try {
    const got = await hostProjection(svc, agentId, TURN_OUTLINE_KEY)
    if (got.ok !== true) return { ok: false, outline: null, via: got.via, note: got.note }
    return { ok: true, outline: normalizeOutline(got.value), via: got.via, note: '' }
  } catch (err) {
    return { ok: false, outline: null, via: 'unavailable', note: `读投影失败：${String(err?.message ?? err)}` }
  }
}

/**
 * ★ **把会话投影的 `contextPressure` 取回来**（E5；给"按水位下调上限"用）。
 *
 * @param {object} svc
 * @param {string} agentId
 * @returns {Promise<{ok:boolean, pressure:object|null, via:string, note:string}>}
 */
export async function hostContextPressure(svc, agentId) {
  try {
    const got = await hostProjection(svc, agentId, CONTEXT_PRESSURE_KEY)
    if (got.ok !== true) return { ok: false, pressure: null, via: got.via, note: got.note }
    const p = got.value
    if (p === null || typeof p !== 'object') return { ok: false, pressure: null, via: got.via, note: '投影里的 contextPressure 不是对象' }
    return { ok: true, pressure: p, via: got.via, note: '' }
  } catch (err) {
    return { ok: false, pressure: null, via: 'unavailable', note: `读投影失败：${String(err?.message ?? err)}` }
  }
}
