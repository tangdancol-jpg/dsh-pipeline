// 拦截缝 ④ `tools/post-execute`：结果里的**代码正文**不许进控制角色的上下文（"第二道网"）。
/**
 * dsh-pipeline · 拦截缝 ④ · `tools/post-execute`（结果"第二道网"）★ 本次缺陷的现场
 * ============================================================================
 * 正常路径在 `tools/pre-execute` 就被守门拦了（控制角色根本调不到读代码的工具）。
 * 这里治的是**漏网**：判据没覆盖到的工具、或提示词把内容骗回来的那条路 ——
 * 结果**已经拿到了**，只能在交付给模型之前把它换成一段反馈（`{kind:'block'}`）。
 *
 * ---------------------------------------------------------------------------
 * ★★ 它曾经**完全没读总开关** —— 这就是用户报的那个缺陷
 * ---------------------------------------------------------------------------
 * 现场（用户亲自遇到）：`pipeline_switch { on: false }` 返回「守门已弃权（**任何调用
 * 都不再被本插件拦**）」，而**紧接着**那次调用的结果仍被下面这段文案替换掉。
 *
 * 修法（两层，都在本文件与 `lib/intercept/registry.js` 里）：
 *   · 关掉时这条缝**根本不挂**（`registry` 按闸门挂/摘 ⇒ "挂着的缝 = 0"可断言）；
 *   · 本函数第一句仍然问一次闸门（逐次判据，覆盖两次采样之间那次调用）。
 *
 * ---------------------------------------------------------------------------
 * ★ 宁可漏判也不误伤
 * ---------------------------------------------------------------------------
 * {@link looksLikeCode} 是**粗判**：它只回答"这段文本像不像代码"，判错的代价是
 * 把一个控制角色的合法结果吞掉。所以三条正则都要求**强特征**
 * （声明关键字 + 标识符 / 箭头函数体 / 行尾分号换行），不做单关键字匹配。
 *
 * @module dsh-pipeline/lib/guard/hook-post
 */

import { NO_CODE_READ_ROLES, agentIdOf } from '../guard.js'
import { roleLabel } from '../roles.js'

/**
 * 粗判"这段文本像不像代码正文"（控制角色那道网用；宁可漏判也不误伤）。
 *
 * @param {string} body
 * @returns {boolean}
 */
export function looksLikeCode(body) {
  return (
    /(^|[^A-Za-z])(function|const|let|class|import|export|def|public|private)\s+[A-Za-z_$]/.test(body) ||
    /=>\s*\{/.test(body) ||
    /;\s*\n/.test(body)
  )
}

/**
 * ★★ **判：这次工具结果要不要对这个席位拦下**（纯函数，判定与副作用分开）。
 *
 * @param {{role:string}|null} seat - 席位（`lib/intercept/seat.js` 的产物）；null ⇒ 不拦
 * @param {*} result - 宿主要的工具结果（原样）
 * @returns {{kind:'block', feedback:Array<{type:'text', text:string}>}|null}
 *   null = 放行（调用方照常 `next()`）
 */
export function resultNetVerdict(seat, result) {
  if (seat === null || seat === undefined) return null
  if (!NO_CODE_READ_ROLES.includes(seat.role)) return null
  const body = JSON.stringify(result ?? '')
  if (body.length === 0 || !looksLikeCode(body)) return null
  return {
    kind: 'block',
    feedback: [
      {
        type: 'text',
        text:
          `[pipeline] 这次工具结果里有**代码正文**，你是「${roleLabel(seat.role)}」——不看代码。\n` +
          '★ 这是**第二道网**：正常路径在 `tools/pre-execute` 就被拦了；这里是"结果已经拿到"的兜底。\n' +
          '要看"改了什么"：pipeline_status（脱敏摘要）或 pipeline_change_audit（路径 + 哈希）。',
      },
    ],
  }
}

/**
 * 造 post-execute「结果网」缝的中间件。
 *
 * @param {object} svc
 * @param {()=>boolean} svc.ask
 * @param {(agentId:string)=>object|null} svc.seatOf
 * @returns {(exec:object, result:*, next:Function)=>Promise<*>}
 */
export function createResultNetHook(svc) {
  const { ask, seatOf } = svc
  return async function resultNetHook(exec, result, next) {
    // ★★ 总开关：关 ⇒ 结果**原样**交给下游（这一句就是缺陷的修复点）。
    if (!ask()) return next()
    const verdict = resultNetVerdict(seatOf(agentIdOf(exec)), result)
    if (verdict !== null) return verdict
    return next()
  }
}
