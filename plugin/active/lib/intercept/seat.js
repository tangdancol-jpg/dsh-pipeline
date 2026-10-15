// 席位认人：把 agentId 解析成"本插件派出去的哪个席位"（拦截缝的**第一条判据**）。
/**
 * dsh-pipeline · 拦截缝 · 席位解析
 * ============================================================================
 * 这些缝是**宿主级**的：全机的每个会话都会经过。所以每条缝的第一条判据永远是
 * **"这个会话是不是本插件派出去的管线席位"**：
 *   · 判据 = 该 `agentId` 在**本插件的令牌表**里绑定了某个任务的某个角色
 *     （`tokens.roleOfAgent(agentId)`，进程内、同步、无法伪造）；
 *   · 不是 ⇒ **直通放行**（用户自己的对话、别的项目的会话、别的插件的会话一律不管）；
 *   · 主对话（用户正在打字的那个会话）**默认不在令牌表里**，所以也直通 ——
 *     它只在**调用 pipeline_* 工具**时受 `ctx.tools.guard` 约束（那是另一条缝）。
 *
 * @module dsh-pipeline/lib/intercept/seat
 */

/**
 * 造一个"这个会话是不是管线席位"的解析器。
 *
 * @param {{tokens:{roleOfAgent:(a:string,t?:string)=>any}}} deps
 * @returns {(agentId:string)=>null|{role:string, taskId:string, seat:string|null}}
 */
export function createSeatResolver(deps) {
  return function seatOf(agentId) {
    if (typeof agentId !== 'string' || agentId.length === 0) return null
    let rec = null
    try {
      rec = deps.tokens.roleOfAgent(agentId)
    } catch {
      return null
    }
    if (rec === null || rec === undefined) return null
    if (typeof rec.role !== 'string' || rec.role.length === 0) return null
    return {
      role: rec.role,
      taskId: typeof rec.taskId === 'string' ? rec.taskId : '',
      seat: typeof rec.seat === 'string' && rec.seat.length > 0 ? rec.seat : null,
    }
  }
}
