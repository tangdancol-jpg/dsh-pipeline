// 主对话身份自查：绑没绑上、没绑上该做什么（重启后那堵墙的"看得见的那一半"）。
/**
 * dsh-pipeline · 唤醒 · **主对话身份自查**
 * ============================================================================
 * 修的是哪条缺陷（真机 `T-20261016-fullai`，2026-10-16 实测）
 * ----------------------------------------------------------------------------
 * ★ **重启后【主对话身份也丢】**：`tokens` 是进程内存态 ⇒ 重启后主对话调
 *   `pipeline_dispatch` / `pipeline_task_purge` 一律被拒，原文：
 *
 *       本会话既没有绑定任何角色，也没有携带 role_token
 *
 *   ⇒ 必须先 `pipeline_task_open { task_id, reattach: true }` 才能继续。
 *   现场就是靠这一条人工动作救回来的 —— 问题是**没有人告诉主对话这件事**，
 *   它是**撞**上那堵墙才知道的。
 *
 * ----------------------------------------------------------------------------
 * 本模块做什么（只做两件事，都不改判据）
 * ----------------------------------------------------------------------------
 *   ① **判**：这个会话在这张单上"是不是已经绑上了主对话"（纯判据，见 {@link judgeMainBinding}）；
 *   ② **给下一步**：没绑上时把**确切的那一条命令**写出来（含本任务 id），
 *      而不是让调用方自己从"既没有绑定会话"这句话里猜。
 *
 * ★ 三条边界（写在代码里，不写在善意里）：
 *   · **不放宽任何身份校验**：本模块**不碰** `tokens`、不碰守门、不绑任何身份。
 *     它判的是"现在是什么状态"，不是"该不该放行"。
 *   · **不静默**：判不出来（拿不到盘上的记录）就说"判不出来"，不写成"不用绑"。
 *   · **自动恢复仍然优先**：DSH 重启后主对话侧的**自动**认领在
 *     `lib/reattach.js`（`mainReattachEnabled` → `judgeMainClaim`，判据 = 盘上的
 *     `contacts.main.agent_id` 与本会话 id **逐字相等**）。本模块给的是它**没成功**
 *     时的那条明确出口 —— 两条路各管一段，互不冒充。
 *
 * @module dsh-pipeline/lib/wakeup/main-identity
 */

import { ROLE } from '../roles.js'

/**
 * 解释**为什么没绑上**（机器可读、稳定；`reason` 永不用自由文本）。
 *
 * | 码 | 含义 | 要动作吗 |
 * |---|---|---|
 * | `bound` | 本会话就是这张单的主对话 | 否 |
 * | `no-session` | 本会话没有会话身份（`exec.agent` 为空，例如 PTC 子调用） | 否（不是它的问题） |
 * | `unbound` | ★ 有会话身份，但**这张单上没绑任何角色** —— 重启后的主对话就是这个形状 | **要** |
 * | `other-role` | 本会话在本单里绑的是**别的角色**（一个会话一单只能一个角色） | 要（换会话） |
 */
export const MAIN_BINDING_REASONS = Object.freeze({
  BOUND: 'bound',
  NO_SESSION: 'no-session',
  UNBOUND: 'unbound',
  OTHER_ROLE: 'other-role',
})

/** 「未绑定」时那句给主对话照抄的话（判据与文案**唯一出处**，自测按它断言）。 */
export const MAIN_REATTACH_HINT = '主对话身份**未绑定**'

/**
 * ★★ **判据本体**（纯函数：不读盘、不写盘、不抛、不改入参）。
 *
 * @param {object} spec
 * @param {object|null} spec.task - 盘上那张单（`store.get()` / `store.peek()` 的形状）
 * @param {string} spec.taskId
 * @param {string|null} spec.sessionId - 调用方会话 id（`exec.agent.id`）
 * @param {{ok:boolean, role?:string, seat?:string|null}|null} spec.actor - `resolveActor` 的结论
 * @param {{agentId:string, at:string, action:string}|null} [spec.lastKnownMain] -
 *   兜底解析：盘上"上一次为止主对话在哪个会话"（`store.lastKnownMainAgent`；只读，不写回）
 * @returns {{bound:boolean, reason:string, should_act:boolean, recorded_main:string,
 *   last_known_main:string, hint:string, evidence:object}}
 */
export function judgeMainBinding(spec = {}) {
  const task = spec.task
  const taskId = String(spec.taskId ?? task?.id ?? '')
  const sessionId = typeof spec.sessionId === 'string' ? spec.sessionId : ''
  const actor = spec.actor !== null && typeof spec.actor === 'object' ? spec.actor : null
  const contacts = task !== null && typeof task === 'object' ? task?.contacts : null
  const recorded = contacts !== null && typeof contacts === 'object' && contacts.main !== null && typeof contacts.main === 'object'
    ? String(contacts.main.agent_id ?? '')
    : ''
  const lastKnown = typeof spec.lastKnownMain?.agentId === 'string' ? spec.lastKnownMain.agentId : ''
  const evidence = {
    task_id: taskId,
    caller_session: sessionId,
    recorded_main_session: recorded,
    last_known_main_session: lastKnown,
    last_known_main_at: typeof spec.lastKnownMain?.at === 'string' ? spec.lastKnownMain.at : '',
    recorded_generation: Number.isInteger(contacts?.main?.generation) ? contacts.main.generation : null,
    actor_ok: actor?.ok === true,
    actor_role: actor?.ok === true ? String(actor.role ?? '') : '',
  }
  const base = { recorded_main: recorded, last_known_main: lastKnown, evidence }

  /** ① 本会话没有会话身份 ⇒ 这不是"没绑上"，是"压根没法绑"。 */
  if (sessionId.length === 0) {
    return {
      ...base,
      bound: false,
      reason: MAIN_BINDING_REASONS.NO_SESSION,
      should_act: false,
      hint:
        '本次调用**没有会话身份**（`exec.agent` 为空，例如 PTC 子调用或外部脚本）—— ' +
        '这不是"主对话没绑定"，而是"没法绑"。带 `role_token` 调用即可绕开这一格。',
    }
  }
  /** ② 已经绑成主对话 ⇒ 什么都不用做（正常态，零输出）。 */
  if (actor !== null && actor.ok === true && String(actor.role ?? '') === ROLE.MAIN) {
    return { ...base, bound: true, reason: MAIN_BINDING_REASONS.BOUND, should_act: false, hint: '' }
  }
  /** ③ 绑了别的角色 ⇒ 一个会话在同一单里只能一个角色，出路是换会话（或撤旧绑定）。 */
  if (actor !== null && actor.ok === true) {
    return {
      ...base,
      bound: false,
      reason: MAIN_BINDING_REASONS.OTHER_ROLE,
      should_act: true,
      hint:
        `本会话在这张单里绑的是「${String(actor.role ?? '')}」而不是主对话（一个会话在同一任务里只能担任一个角色）。\n` +
        `  要拿回主对话身份：改在**主对话那个会话**里调 ` +
        `\`pipeline_task_open { task_id: "${taskId}", reattach: true }\`（或 \`pipeline_task_purge\` 之前先认领）。`,
    };
  }

  /**
   * ④ ★★ **本件的主现场**：有会话身份、但这张单上一个角色都没绑（重启后必然如此）。
   *
   * 提示里**必须**出现确切的那一条命令 + 本任务 id —— 用户要的就是"别让我撞墙才懂"。
   * 若盘上还留着"上一次主对话在哪个会话"（`contacts.main` 或 `task.history` 的兜底解析），
   * 一并报出来：那是**判据**，不是建议（自动认领就是拿它与本会话 id 逐字比的）。
   */
  const who =
    recorded.length > 0
      ? `盘上记着本单的主对话会话是 ${recorded}`
      : lastKnown.length > 0
        ? `盘上**没有** \`contacts.main\`，但历史里上一次以主对话身份动过的是 ${lastKnown}`
        : '盘上**既没有** `contacts.main`、历史里也没有主对话的痕迹'
  return {
    ...base,
    bound: false,
    reason: MAIN_BINDING_REASONS.UNBOUND,
    should_act: true,
    hint:
      `★ ${MAIN_REATTACH_HINT}（本会话 ${sessionId}）。${who}。\n` +
      '  为什么会这样：角色令牌表是**进程内存态**（`lib/tokens.js`），DSH 一重启**所有**令牌全清空 ——\n' +
      '  包括主对话开单时铸的那一枚（这与"令牌 TTL 到期"是两回事）。\n' +
      `  ⇒ **下一步**：在本会话调 \`pipeline_task_open { task_id: "${taskId}", reattach: true }\` 重新认领，` +
      '之后 `pipeline_dispatch` / `pipeline_transition` / `pipeline_close` 才会认你。\n' +
      '  ★ 机制侧还有一条**自动**认领（`config.mainReattachEnabled` → `lib/reattach.js`）：' +
      '它的判据是"盘上的 `contacts.main.agent_id` 与本会话 id 逐字相等"，' +
      '所以**换了会话**（或那条记录缺失/损坏）时自动认领会如实报"认领不了"，' +
      '那就只能走上面那条手动命令（`main:reattach-refused` 留痕在 `audit.jsonl` 里）。',
  }
}
