// 记下"主对话在哪个会话里"（交付即唤醒的第四步要用的那一份输入）。
/**
 * dsh-pipeline · 唤醒 · 主对话会话登记
 * ============================================================================
 * 从 `lib/tools/kit.js` 拆出来的一部分（**代码原样搬过来，行为未改**；
 * 拆分理由见 `CONVENTIONS.md`：一文件一职责、单文件 ≤400 行）。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有它
 * ---------------------------------------------------------------------------
 * 唤醒消息必须投到**主对话所在会话**，而这个 id **只有主对话自己调用插件工具时**
 * 才拿得到（`exec.agent.id`，见 `lib/guard.js` 的 `agentIdOf`）。所以挂在
 * `lib/tools/kit.js` 的 `tool()` **唯一出口**上：任何一次 pipeline 工具调用都会顺手记一次。
 *
 * 两条纪律：
 *   · **只有主对话记** —— 席位的会话 id 不是唤醒目标（投错了主对话还是收不到）；
 *   · **不抛** —— 记账失败绝不能把这次工具调用带崩（唤醒是副作用，不是判据）。
 *
 * ★ 登记表有两层：内存（`deps.wakeup.registry`，进程内即查即用）+ 落盘
 *   （`task.contacts.main`，进程重启后 `pipeline_contacts` 还能查到）。
 *   只在**发生变化**时才落盘 —— 别让每次工具调用都写一次任务文件。
 *
 * ★★ 总开关：关 ⇒ **不记账**（见函数体第一句）—— 它是"关 = 彻底摘干净"里的最后一块，
 *   也是**唯一一处"只读工具也会写项目目录"**的路径。
 *
 * @module dsh-pipeline/lib/wakeup/main-contact
 */

import { ROLE } from '../roles.js'
import { agentIdOf } from '../guard.js'
import { isEnabled } from '../switch/gate.js'

/**
 * 记一次"主对话在这个会话里"。
 *
 * @param {object} deps - 工具层依赖（要 `sw` / `wakeup` / `tokens`）
 * @param {object} exec
 * @param {{mutating?:boolean, action?:string}} [opts]
 * @returns {boolean} 是否真的记下了（测试用）
 */
export function rememberMainCaller(deps, exec, opts = {}) {
  if (deps === null || deps === undefined) return false
  /**
   * ★★ **总开关：关 ⇒ 不记账** —— 这是"关 = 彻底摘干净"里的最后一块。
   *
   * 为什么必须在这儿也判一次：它是**唯一一处"只读工具也会写项目目录"**的路径 ——
   * `rememberMain` 会（在值变了时）落盘 `task.contacts.main`。关掉功能之后：
   *   · 消费者的那一位（唤醒投递）已经整个停了 ⇒ 记下来**没有任何人读**；
   *   · 而它是**写**：用户在"关掉"状态下点一下 `pipeline_status`，
   *     项目里的 `task.json` 就被改了 —— 那正是"开关只关一半"的观感来源之一。
   *
   * ★ 打开之后会不会丢信息：不会。主对话下一次调用任何 pipeline 工具时会重新登记
   *   （`store.rememberMainContact` 认的是"值变了才写盘"，重放是零成本空转）。
   */
  if (!isEnabled(deps.sw)) return false
  const wakeup = deps.wakeup
  if (wakeup === null || wakeup === undefined || typeof wakeup.rememberMain !== 'function') return false
  const tokens = deps.tokens
  if (tokens === null || tokens === undefined) return false
  const agentId = agentIdOf(exec)
  if (agentId === null) return false

  /**
   * ★★ **这个会话手上的每一张"我是主对话"的单** —— 一张都不能漏。
   *
   * 2026-10-11 的现场（用户原话："唤醒从约 22:17 之后就不响了"）就出在这里：
   * 原来这里写的是 `tokens.roleOfAgent(agentId)`，而它是按 `Map` 插入顺序返回
   * **第一条**命中 —— 主对话会话为每一张开过/认领过的单都持有一枚 `main` 令牌，
   * 于是它永远返回**最早那张单**。结果：`rememberMain` 每次都在刷新老单，
   * **新单的 `task.contacts.main` 一个字节都落不下来**，新单的交付唤醒全部
   * `wake:skipped / no-main-session`（老单却一切正常，特别像"某个时间点之后
   * 突然坏了"，其实是"之后开的新单都没登记过"）。
   *
   * 修法：**不做取舍**，把该会话手上的主对话任务**全部**登记一遍。
   * 这同时就是"自愈"—— 主对话换了会话 id（重开 / 重启 / 重新认领）之后，
   * 它**下一次**调用任何 pipeline 工具就会把新会话 id 覆盖进每一张单的
   * `contacts.main`（`store.rememberMainContact` 认的是"值变了才写盘"，
   * 没变就是零成本的空转）。
   *
   * 为什么不是"从 `args.task_id` 里取"：那个字段**不是每个工具都有**
   * （`pipeline_selftest` / `pipeline_switch` 就没有），漏一条路径就漏一张单。
   * 令牌表才是"这张单的主对话是谁"的**权威来源**（它是 `task_open` / `reattach`
   * 亲手铸的），不在参数字符串上赌。
   */
  let taskIds = []
  try {
    taskIds = typeof tokens.tasksOfAgent === 'function'
      ? tokens.tasksOfAgent(agentId, ROLE.MAIN)
      : // 退化路径：宿主加载的是旧版 tokens（热替换的半途状态）时，退回老行为，
        // 至少不比改之前差；不做猜测式的补全。
        (() => {
          const one = tokens.roleOfAgent(agentId, undefined)
          return one !== null && one !== undefined && one.role === ROLE.MAIN ? [one.taskId] : []
        })()
  } catch {
    return false
  }
  if (!Array.isArray(taskIds) || taskIds.length === 0) return false

  let any = false
  for (const taskId of taskIds) {
    if (typeof taskId !== 'string' || taskId.length === 0) continue
    try {
      // ★ 一张单失败不影响其它单 —— 唤醒是副作用，不是判据。
      if (wakeup.rememberMain(taskId, agentId, 'tool-call') === true) any = true
    } catch {
      void 0
    }
    /**
     * ★★ **A28(c)：主对话的"接管"留痕。**
     *
     * 「送达 ≠ 接管」的主对话侧判据是：**目标确实据此推进了**
     * （状态迁移 / 派活 / 答复），或者明确回复"已收到但不推进"并留下可见留痕。
     * 所以这里**只认会改状态的那类工具**（`opts.mutating === true`）——
     * 一次 `pipeline_status` 只读查询**不算**接管，把它算进去就会把
     * "18 小时零动作"洗成"已接管"，A28 当场失效。
     */
    if (opts.mutating === true && typeof wakeup.markConsumed === 'function') {
      try {
        wakeup.markConsumed(taskId, { by: 'main', action: String(opts.action ?? 'tool-call') })
      } catch {
        void 0
      }
    }
  }
  return any
}
