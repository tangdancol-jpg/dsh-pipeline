// 「这一次调用的返回值」→ 唤醒判别子：拦截缝唯一能看见真实返回值的地方。
/**
 * dsh-pipeline · 拦截缝 · 唤醒判别子（从返回值里取）
 * ============================================================================
 * ★★ **T12 / E3：从"这一次调用的返回值"里取判别子。**
 *
 * 为什么在这里取：拦截缝是唯一能看见"这一次工具调用真实返回了什么"的地方，
 * 而既有用例 `tests/wake-check.mjs` E3 逐字断言交给唤醒器的 spec 上**必须带**
 * `disc === 'HO-XYZ'`（`pipeline_handoff` 的成功返回值里给的就是 `handoff_id`）。
 *
 * 取法与 `lib/wakeup.js` 的 `discriminatorOf` 同一套（封信层深搜 → `content[].json`），
 * 字段名单直接取自已导入的 `WAKE_TRIGGER_TOOLS`（不另立一份名单）。
 * ★ 两份实现是否会漂移：由自测逐例比对两者输出（包含封信层 / 缺字段 / 非字符串等边界），
 *   不一致就会红。
 *
 * @module dsh-pipeline/lib/intercept/wake-disc
 */

/**
 * @param {object|null} result
 * @param {string[]} fields
 * @returns {string|null}
 */
export function readWakeDisc(result, fields) {
  if (result === null || typeof result !== 'object') return null
  const list = Array.isArray(fields) ? fields : []
  const envs = [result, result.structuredContent, result.data, result.result, result.value, result.output]
  const take = (o, f) => {
    if (o === null || o === undefined || typeof o !== 'object') return null
    const v = o[f]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    return null
  }
  const anywhere = (f) => {
    for (const e of envs) {
      const v = take(e, f)
      if (v !== null) return v
    }
    for (const c of Array.isArray(result.content) ? result.content : []) {
      const v = take(c, f) ?? take(c?.json, f)
      if (v !== null) return v
    }
    return null
  }
  if (list.length === 2 && list[0] === 'from' && list[1] === 'to') {
    const a = anywhere('from')
    const b = anywhere('to')
    return a !== null && b !== null ? `${a}→${b}` : null
  }
  for (const f of list) {
    const v = anywhere(f)
    if (v !== null) return v
  }
  return null
}
