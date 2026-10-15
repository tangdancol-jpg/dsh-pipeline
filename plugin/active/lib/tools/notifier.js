/**
 * dsh-pipeline · 工具层 · 席位侧投递器
 * ============================================================================
 * 从 `lib/tools.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/tools.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/tools/notifier
 */

import { roleLabel } from '../roles.js'
import { STATE_LABEL } from '../states.js'

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * 构造全部工具定义。
 *
 * @param {object} deps
 * @param {Function} deps.defineTool
 * @param {object} deps.ctx
 * @param {object} deps.config
 * @param {ReturnType<import('./store.js').createTaskStore>} deps.store
 * @param {ReturnType<import('./tokens.js').createTokenStore>} deps.tokens
 * @param {object} deps.transport
 * @param {(taskId:string, task:object)=>void} deps.indexTask - 把任务登记进守门用的同步索引
 * @returns {object[]}
 */
/**
 * ★★ **席位侧投递器**（唯一实现；`pipeline_dispatch { notify_only: true }` 与
 *    **孤儿单自恢复的重投**用的是**同一份代码**）。
 *
 * 为什么把它从 `buildTools` 里提出来（2026-10-14，孤儿单自恢复）：
 *   自恢复要"重新投递"，而用户点名的通道就是**已经修好的** `notify_only`
 *   （本文件的 `notifySeat`）—— 不建会话、不改状态、投不出去
 *   返回 `ok:false` + 原因。若让 `lib/orphan.js` 自己再写一份投递，
 *   就会有**第二份**"投给谁 / 怎么算投成功"的口径 —— 那正是本项目反复吃亏的形状。
 *   所以：**搬出来、两边共用**（`buildTools` 与 `index.js` 各取一次），
 *   行为与改前**逐字相同**（同一份闭包、同一个 `transport.notifyRole`、
 *   同一组审计动作 `seat:wake-delivered` / `seat:wake-failed`）。
 *
 * @param {object} deps - 与 `buildTools(deps)` 同一份依赖（只用其中的
 *   `store` / `transport` / `wakeup`）
 * @returns {{noteSeatDelivery:Function, nudgeSeat:Function, notifyOnly:Function}}
 */
export function createSeatNotifier(deps = {}) {
  const store = deps.store
  const transport = deps.transport

  /**
   * ★★ **A6 / A7 / A28(b)：席位侧投递的**成败**都必须留痕**（盘上，跨进程可查）。
   *
   * 现场：裁定落地了、席位没被叫醒，而这件事**只活在一次工具调用的返回值里**
   * （"叫不醒"这句话说完就没了）；另一头，A28 要求「已投递」与「已接管」
   * **配对可读** —— 所以两边用**同一个键**：`<任务>|<类别>|seat:<席位>|<请求 id>`。
   *
   * ★ 不抛：留痕失败绝不能把"投递"这个判决本身带崩（与唤醒同一条纪律）。
   */
  async function noteSeatDelivery(task, role, seat, kind, requestId, ok, sessionId, note) {
    const actorKey = `${String(role)}${seat === null || seat === undefined || String(seat).length === 0 ? '' : `#${String(seat).replace(/^[a-z_]+#/, '')}`}`
    const key = `${String(task?.id ?? '')}|${String(kind)}|seat:${actorKey}|${String(requestId ?? '')}`
    try {
      deps.wakeup?.noteSeatDelivery?.({ key, task_id: String(task?.id ?? ''), kind: String(kind), role: String(role), seat: seat === null || seat === undefined ? '' : String(seat), session: String(sessionId ?? ''), ok, note: String(note ?? '') })
    } catch {
      void 0
    }
    try {
      await store.recordAudit(task.id, role, ok === true ? 'seat:wake-delivered' : 'seat:wake-failed', {
        key,
        request_id: String(requestId ?? ''),
        target_session: String(sessionId ?? ''),
        seat: seat ?? null,
        kind: String(kind),
        note: String(note ?? ''),
      })
    } catch {
      void 0
    }
    return key
  }

  async function nudgeSeat(task, role, seat, text, meta = {}) {
    const list = Array.isArray(task?.dispatched) ? task.dispatched : []
    const rec = list.find((x) => String(x?.role ?? '') === String(role) && (seat === null || String(x?.seat ?? '') === String(seat))) ?? null
    const sessionId = rec === null
      ? null
      : (typeof rec.session_id === 'string' && rec.session_id.length > 0
        ? rec.session_id
        : typeof rec.agent_id === 'string' && rec.agent_id.length > 0 ? rec.agent_id : null)
    const kind = String(meta.kind ?? 'notify')
    const requestId = String(meta.requestId ?? '')
    if (rec === null) {
      const note = `派活台账里没有「${role}${seat === null ? '' : `/${seat}`}」这一条 —— 不知道它在哪个会话，**没有投递**。`
      await noteSeatDelivery(task, role, seat, kind, requestId, false, null, note)
      return { ok: false, sessionId: null, note }
    }
    if (sessionId === null) {
      const note = `「${role}${seat === null ? '' : `/${seat}`}」的派活台账里没有会话 id（session_id / agent_id 都是空的）—— **没有投递**。`
      await noteSeatDelivery(task, role, seat, kind, requestId, false, null, note)
      return { ok: false, sessionId: null, note }
    }
    try {
      const r = await transport.notifyRole({ task, roster: task.roster, role, seat, sessionId, message: text })
      if (r !== null && r !== undefined && r.ok === false) {
        const note = String(r.note ?? '通道拒绝投递。')
        await noteSeatDelivery(task, role, seat, kind, requestId, false, sessionId, note)
        return { ok: false, sessionId, note }
      }
      const note = String(r?.note ?? `已投给会话 ${sessionId}。`)
      await noteSeatDelivery(task, role, seat, kind, requestId, true, sessionId, note)
      return { ok: true, sessionId, note }
    } catch (err) {
      const note = `投递异常：${String(err?.message ?? err)}`
      await noteSeatDelivery(task, role, seat, kind, requestId, false, sessionId, note)
      return { ok: false, sessionId, note }
    }
  }

  /**
   * ★★ **B8：只传话、不派活**（`notify_only: true` 的内核）。
   *
   * "停会话 / 催办"这条**可见**通道 —— 改前完全没有（当晚只能由用户用 GUI 手动打字
   * 把席位叫醒）。它复用本工具的 role/seat 身份解析，从**派活台账**里找会话，
   * 结构上投不错人；投不出去返回 `ok:false` + 原因 + 等价路径（**不静默失败**）。
   *
   * ★ 2026-10-14：本函数**原样搬出** `buildTools`（见 {@link createSeatNotifier}），
   *   逻辑一个字节没改 —— 孤儿单自恢复的重投走的就是它。
   */
  async function notifyOnly(task, role, seat, text, stop) {
    const head = stop === true
      ? '【流水线 · 主对话指令 · **停手**】立即停止你正在做的事，不要继续改任何东西。\n'
      : '【流水线 · 主对话留言】\n'
    const r = await nudgeSeat(task, role, seat, `${head}${text}\n（任务 ${task.id}；这条是**运行时上下文**，不是用户说的话。）`)
    return r
  }

  /**
   * ★★ **B3：裁定落地后唤醒"停手等答复"的那个席位**。
   *
   * 失败**绝不静默**：把失败原文拼进返回的 summary，让主对话当场看见，
   * 并且给出等价可达路径（`pipeline_dispatch { notify_only: true }` 手动催 / `reassign` 重派）。
   *
   * ★ 2026-10-16：本函数**原样搬出** `lib/tools.js`（连同它上面那段注释与下面这段文案），
   *   逻辑一个字节没改 —— 搬家的理由是**行数纪律**（`CONVENTIONS.md` §4：单文件 ≤400 行）：
   *   `lib/tools.js` 已经 404 行，再往上接线就要先抽一块出来。
   *   抽的就是它（席位侧投递的最后一段，与 `nudgeSeat` 同域），抽完 `lib/tools.js` 掉到 384 行。
   *   它**只从 `createSeatNotifier` 的返回值里出**（`lib/tools.js` 内部解构后传给 `buildHumanTools`），
   *   模块级没有第二个导出点 —— 所以这次搬家对**所有调用方**是透明的。
   */
  async function wakeResumedSeat(task, role, seat, why, meta = {}) {
    const body =
      `【流水线 · 裁定已落地】你之前停手等的那件事有结论了（${why}）。\n` +
      `任务 ${task.id} 当前状态：${STATE_LABEL[task.state] ?? task.state}（\`${task.state}\`）。\n` +
      '★ 这条是**运行时上下文**，不是用户说的话。\n' +
      '下一步：用 pipeline_status 重读任务状态，然后继续你那一份活（你原来的边界不变）。'
    const r = await nudgeSeat(task, role, seat, body, meta)
    if (r.ok === true) return { ok: true, line: `★ 已唤醒发起席位「${roleLabel(role)}${seat === null ? '' : `（${seat}）`}」（会话 ${r.sessionId}）。\n` }
    return {
      ok: false,
      line:
        `⚠ **裁定已落地，但叫不醒发起席位**「${roleLabel(role)}${seat === null ? '' : `（${seat}）`}」—— 这是**看得见的失败**（不是静默）：\n` +
        `  原因：${r.note}\n` +
        `  等价可达路径（择一）：\n` +
        `    · 手动催一次：pipeline_dispatch { task_id: "${task.id}", role: "${role}"${seat === null ? '' : `, seat: "${seat}"`}, notify_only: true, note: "裁定已落地，请继续" }（**不建会话、不改状态**）\n` +
        `    · 重派同一席位：pipeline_dispatch { task_id: "${task.id}", role: "${role}"${seat === null ? '' : `, seat: "${seat}"`}, reassign: true }\n`,
    }
  }

  return { noteSeatDelivery, nudgeSeat, notifyOnly, wakeResumedSeat }
}
