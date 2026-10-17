/**
 * dsh-pipeline · 任务存储 · 开单、认领、查询、状态迁移
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/lifecycle
 */

import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { ST, STATE_LABEL, TERMINAL_STATES, WAITING_STATES, applyTransition, resolveUnblockRecovery } from '../states.js'
import { ROLE, roleLabel } from '../roles.js'
import { clamp, newTaskId, nowIso, shortHash, toStringArray } from '../util.js'
import { seatKey, upsertDispatch } from '../liveness.js'
import { RESUME_EVENTS } from './shared.js'
import { describeTransitionRecord } from './transition-record.js'
// ★ E3（设计 04 §3.3 / §3.1）：状态迁移落一条 `kind:'transition'` 记忆，并让活文档跟着更新。
import { appendTransition } from '../memory/retain-transition.js'
import { refreshLiveDocForTask } from '../memory/live-doc-write.js'
// ★★ WP-B 接线（设计 02 §4 / 01 §D10）：开单 / 关单·取消成功后把流水线任务镜像到
//    官方 Agent Teams 任务板。镜像**best-effort**：服务缺失 / `teamBoard:'off'` / 任何
//    异常都只落审计（`team:board-error`）或 skipped，**绝不**改本文件的返回值。
import { boardEnvFromStore, mirrorClose, mirrorOpen } from '../team/board.js'

/**
 * 任务存储 · 开单、认领、查询、状态迁移
 * 返回的方法由 `createTaskStore` 原位展开进同一个对象，方法里的 `this` 仍指向那个对象。
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function lifecycleMethods(ctx) {
  const { projectRoot, root, now, cache, taskFile, audit, deny, loadTask, persist, applyHubSideEffects, swOf } = ctx

  /**
   * ★★ WP-B hook：把「开单 / 关单·取消」这个**已经成功的事实**镜像到官方 Team 任务板。
   *
   * 为什么挂在 store 这一层而不是工具层：这两个动作"真的成功了"的唯一判据在这里
   * （`persist` 已落盘）。接在工具层会多出第二个入口，一旦哪个入口漏接，
   * 就会出现"回执说成功了、官方板上却查不到"的半截现场。
   *
   * ★ 这个函数**只**负责把能拿到的现场交给 `lib/team/board.js`：能不能镜像、
   *   怎么降级（服务缺失 / `teamBoard:'off'` / revision CAS 重试）全在那边判，
   *   避免同一套判据散落在两个文件里各写一遍。
   * ★ 外面再包一层 try/catch：即使 board.js 自身有 bug，也**绝不许**它改变
   *   主流程的 `ok` —— 任务板是辅助面（D10）。
   *
   * @param {'open'|'close'} action
   * @param {object} task - 已落盘的任务卡
   * @param {{callerAgentId?:string|null, reason?:string}} [extra]
   */
  async function mirrorBoard(action, task, extra = {}) {
    try {
      const env = boardEnvFromStore({
        // store 的 ctx 没有宿主 ctx/config —— 那两个由 `board.js` 的模块级登记补
        // （`index.js` 的 `apply()` 装配时登记一次；没登记就整体 skipped）。
        dirs: { projectRoot, pipelineRoot: root },
        // 审计签名对齐 store 的（每行自带 task_id/actor）；board 只给 action + detail。
        audit: (name, detail) => audit(task.id, ROLE.MAIN, name, detail),
        callerAgentId: typeof extra.callerAgentId === 'string' ? extra.callerAgentId : null,
      })
      if (action === 'open') return await mirrorOpen(env, task)
      return await mirrorClose(env, task, { reason: extra.reason })
    } catch {
      // 镜像内部异常（理论上不该有，board.js 自己全程 catch）⇒ 一律吞掉。
      return { ok: false, skipped: true, note: '任务板镜像内部异常（已按 best-effort 忽略）。' }
    }
  }

  return {
    /**
     * 开单。主对话的动作。
     *
     * @param {object} input
     * @param {string} input.requirement
     * @param {string[]} [input.constraints]
     * @param {string[]} [input.acceptance]
     * @param {string} [input.deadline]
     * @param {string} [input.deliverableFormat]
     * @param {string} [input.id] - 指定任务 id（测试用）
     * @param {string} input.actorRole - 调用方角色（必须是 main）
     * @param {string} input.actorAgentId
     */
    async open(input) {
      if (input.actorRole !== ROLE.MAIN) {
        return deny(
          'ROLE_NOT_ALLOWED',
          `只有主对话（main）能开单，当前调用方是「${roleLabel(input.actorRole)}」。这一步是流水线的入口，必须由主对话发起。`,
        )
      }
      const requirement = String(input.requirement ?? '').trim()
      if (requirement.length === 0) return deny('BAD_ARGUMENT', '开单必须给 requirement（原始需求）。')

      const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : newTaskId(now())
      if (cache.has(id) || existsSync(taskFile(id))) {
        return deny('TASK_EXISTS', `任务 ${id} 已存在，请换一个 id。`)
      }

      const stamp = nowIso(now())
      const task = {
        id,
        created_at: stamp,
        updated_at: stamp,
        state: ST.PENDING,
        previous_state: null,
        project_root: projectRoot,
        requirement,
        constraints: toStringArray(input.constraints),
        acceptance_from_user: toStringArray(input.acceptance),
        deadline: typeof input.deadline === 'string' ? input.deadline : '',
        deliverable_format: typeof input.deliverableFormat === 'string' ? input.deliverableFormat : '',
        /** 角色清单：null 表示还没做计划分配（planner 尚未产出）。 */
        roster: null,
        /** 任务卡：需求分析 + 计划分配的产物。 */
        task_card: null,
        artifact_version_counter: 0,
        /** 打回计数：dev = 被打回编写的次数；test = 被打回测试的次数。 */
        rework: { dev: 0, test: 0 },
        /** 每一次动作的流水（审计日志的镜像，便于一屏看全）。 */
        history: [],
        /**
         * ★ **哈希前置闸门连续不通过计数**（用户拍板 P13）。
         *
         * 归零的**唯一**时点：一次**闸门真通过**的提交（或用户答复了自动升级那件事，
         * 见 `replyHumanRequest` 里的"重新武装"）。撤回越界改动**不**归零 ——
         * 理由写在 `lib/hashgate.js` 的 `nextHashGateStreak`。
         */
        hash_gate_streak: 0,
        /** 每一次哈希比对的结果（含失败的时间与理由）—— 可追溯。 */
        hash_gate_checks: [],
        /** 最后一次比对的可同步判据（守门分支 4g 读它）。 */
        hash_gate: null,
        /**
         * ★ **自动交人工**的记录（连续不过到阈值时由机制写）。
         * 形状：`{ round, at, streak, threshold, request_id, handoff_id, from_role, answered_at, ... }`
         * `answered_at === null` = **还没了结** ⇒ 既不再重复升级，也**拒收**同一任务的再次提交。
         */
        hash_gate_escalation: null,
        /** 交接物（完整记录，同时逐个落盘）。 */
        handoffs: [],
        /** 制品登记表。 */
        artifacts: [],
        /** 角色变更申请。 */
        roster_requests: [],
        /**
         * ★ **授权面变更（amendment）历史** —— 窄通道 `pipeline_scope_amend` 留下的账。
         *
         * 为什么需要这条通道（真事，不是设计洁癖）：用户已经在**需求层**裁定
         * "允许把某样东西纳入授权面"，但计划工具只在「计划中」交得进计划
         * （`checkHandoffAgainstState` 的 `plan: [ST.PLANNING]`）——
         * 任务一进「待开发」，就变成 **裁定有了、动作做不了**，那个交付单元卡死。
         *
         * 每次变更在这里留一条：谁、何时、加了什么、**为什么**、
         * 变更前后的授权面长什么样。形状：
         *   `{ amendment_id, at, by, agent, why, note, state_at_amend,
         *      added[], removed[], forbidden_added[], forbidden_removed[],
         *      before{change_scope[],forbidden[]}, after{change_scope[],forbidden[]} }`
         * ★ 它**只**记授权面的变化 —— 席位/角色清单/档位/顺序/层根本不在这条通道的能力范围内。
         */
        amendments: [],
        /**
         * ★ 各编写席位本轮的提交情况（`dev_to_test` 落在这里）。
         * 进「开发中」时清空；**全部在册席位到齐**才允许推进到「待测试」。
         * 键 = 席位 id（`writer#1`…），值 = `{handoff_id, artifact_version, at}`。
         */
        writer_submissions: {},
        // ★ 需求档**不在这里登记** —— 它靠**目录约定**定位：
        //     <项目根>/.pipeline/<taskId>/requirement.md（人可读）
        //     <项目根>/.pipeline/<taskId>/requirement.json（结构化）
        //     <项目根>/.pipeline/<taskId>/requirement.index.json（版本索引）
        //   为什么不在任务卡里记路径：**每个 AI 只干自己的事** ——
        //   需要需求的人自己去约定目录读，不需要主对话告诉它"文件在哪"。
        //   主对话的任务卡也**不引用**该文件。
        //   （上一轮曾把路径 + sha256 记进任务卡，那条已作废。）
        /** ★ 上下文水位上报（席位自报 + 必须给依据）。 */
        context_reports: [],
        /**
         * ★ 席位继任记录（**换班**，不是改角色）。
         * shape：{ succession_id, seat, role, from_agent, to_agent, handoff_id, reason, at, generation }
         */
        successions: [],

        /**
         * ★ 两级升级梯**第一级**的生命周期记录（每一条对应一份 clarification_request）。
         * 提问 → 需求分析裁定（答了 / 答不了）→（必要时）升级。
         */
        clarification_requests: [],
        /**
         * ★ 人工介入请求的**生命周期**记录（每一条对应一份 human_request 交接物）。
         * 四步都留在这里 + audit.jsonl：发起 → 转告 → 答复 → 恢复。
         */
        human_requests: [],
        /**
         * ★ **全量测试审批链**（用户要求：测试要跑全量，必须四级都点头）。
         *
         * 与别的"请求列表"的区别：这里记的是**一条链**的进度，不是一堆散请求 ——
         * 四站（需求分析 → 审核 → 人工 → 计划）是同一条链上的四个节点，
         * 任一站否决就整条停住（`status='rejected'` + `rejected_at_stage`）。
         */
        full_test_approvals: [],
        /**
         * ★ **派活台账**：派出去了哪些席位、什么时候派的。
         *
         * 形状：`{ key, role, seat, agent_id, token, at, at_ms, via }`。
         * 为什么必须落盘（而不是只放内存）：进程重启后 `pipeline_status` 要能回答
         *   「这个任务是派出去了没人回，还是根本没派出去」—— 那是两件完全不同的事。
         * ★ 它是失联检测（`lib/liveness.js`）的**唯一计时起点**。
         */
        dispatched: [],
        /**
         * ★ **失联处置台账**：机制因为"席位失联"做过什么（谁、什么时候、推到哪个状态）。
         * 形状：`{ at, at_ms, seats:string[], to_state, reason }`。
         */
        liveness: { escalations: [] },
        close_report: null,
      }
      cache.set(id, task)
      await persist(task)
      const entry = await audit(id, ROLE.MAIN, 'open', { requirement_digest: shortHash(requirement), agent: input.actorAgentId })
      task.history.push(entry)
      await persist(task)
      /**
       * ★★ P5 接线（`WIRING.md` §W4）：**开单先强制设主管**（裁定 1 / 定稿 §3.5 的 `pending` 那一条）。
       *
       * ★ 刻意**不做试算**：`pending` 时还没有 tier，先猜档位再决定设不设主管，
       *   会在"猜 L1、实际 L4"时留下一个**没有责任人的补救动作**。
       * ★ 幂等：`hubForceOnOpen` 自己判重，重复调用不写盘。
       * ★ 放在两次 persist **之后**：强制设主管要把 `hub_requirement` 与上面那条 `open`
       *   审计行一起落进同一个任务卡，顺序反了会把审计行挤掉。
       */
      await this.hubForceOnOpen(id, { by: input.actorRole })

      // ★★ WP-B 接线（02 §4 / 01 §D10）：**开单成功之后**才镜像（此时 task 已落盘）。
      //    best-effort：服务缺失 / teamBoard:'off' / 异常 ⇒ skipped 或只记审计，
      //    上面那个 `ok:true` 与返回值一个字都不改（任务板是辅助面）。
      await mirrorBoard('open', task, { callerAgentId: input.actorAgentId })

      return { ok: true, task, summary: `已开单 ${id}，状态：${STATE_LABEL[ST.PENDING]}。下一步：pipeline_orchestrate 做**需求分析**（出任务卡 + 不清楚处清单；分配 AI 是后面 planner 的事）。` }
    },

    /**
     * ★ **认领一张已存在的任务单** —— 重启后的恢复入口（2026-10-11 补）。
     *
     * ---------------------------------------------------------------------
     * 为什么需要它（现场）
     * ---------------------------------------------------------------------
     * DSH 重启后：会话↔角色绑定（`lib/tokens.js` 的内存 Map）与角色令牌**全部丢失**，
     * 而 {@link open} 对已存在的 id 一律 `deny('TASK_EXISTS')` —— 于是老单成了**孤儿**：
     *   · 不能推进（没有身份）；
     *   · 不能取消（`states.js` 里 `cancel` 这条边**一直都有**，只是**身份先没了**，
     *     连状态机都走不到 —— 这一点很容易被误判成"状态机缺边"）；
     *   · 也不能用同一个 id 重开。
     * 用户当初拍板的设计要求是「**被切断后要能恢复**」，这一条正是补上那个缺口。
     *
     * ---------------------------------------------------------------------
     * 为什么是"认领"而不是"覆盖重开"
     * ---------------------------------------------------------------------
     * 直接覆盖会丢掉 `history` / `handoffs` / `artifacts` 整条审计链，
     * 而"可追溯"是本插件的核心卖点之一。认领**保留全部历史**，只换身份。
     *
     * ---------------------------------------------------------------------
     * 边界（诚实写出来，别在别处又吹一遍）
     * ---------------------------------------------------------------------
     * · 本方法**不校验调用方身份** —— 它没法校验：重启后谁都拿不出令牌。
     *   这与 `open()` 的既有安全等级**相同**：`pipeline_task_open` 在守门表里
     *   （`lib/guard.js` 的 `PIPELINE_TOOL_ROLES`）本就是 `null`（不判角色），
     *   所以"谁都能认领"**没有降低任何门槛** —— 现状是"谁都能开新单并成为它的主对话"。
     * · 真正要保留的不变量是「一个任务同时只认一个主对话会话」，由**铸新令牌 +
     *   覆盖绑定**体现：旧会话的令牌已随重启失效，不存在两个活跃 main。
     * · 终态（已关闭 / 已取消）的单**也允许认领**（用户可能只是要看它一眼），
     *   但会被标成 `terminal: true`，提示层据此说明"它已经走完了，推不动了"。
     *
     * @param {string} taskId
     * @param {{agentId?:string|null}} [opts]
     * @returns {Promise<{ok:true, task:object, reattached:true, terminal:boolean} | {ok:false, error:string}>}
     */
    async reattach(taskId, opts = {}) {
      const id = String(taskId ?? '')
      if (id.length === 0) {
        return deny('BAD_ARGUMENT', '认领必须给 task_id（那张已存在的单的 id）。')
      }

      const task = await loadTask(id)
      if (task === null) {
        return deny(
          'TASK_NOT_FOUND',
          `找不到任务 ${id}，无法认领。\n` +
            '★ 认领（`reattach`）只针对**已存在**的单；要开新单请不带 `reattach` 调用。\n' +
            `  工作区：${root}`,
        )
      }

      const terminal = TERMINAL_STATES.includes(task.state)
      const entry = await audit(id, ROLE.MAIN, 'reattach', {
        agent: typeof opts.agentId === 'string' ? opts.agentId : null,
        from_state: task.state,
        note: '★ 重启后重新认领主对话身份（不覆盖任何历史）',
      })
      task.history.push(entry)
      await persist(task)

      return { ok: true, task, reattached: true, terminal }
    },

    /** 取任务（不同步落盘）。 */
    async get(taskId) {
      return loadTask(taskId)
    },

    /** 列任务（扫目录）。 */
    async list() {
      if (!existsSync(root)) return []
      const dirs = await readdir(root, { withFileTypes: true })
      const out = []
      for (const d of dirs) {
        if (!d.isDirectory()) continue
        const t = await loadTask(d.name)
        if (t !== null) out.push({ id: t.id, state: t.state, state_zh: STATE_LABEL[t.state], requirement: clamp(t.requirement, 120), created_at: t.created_at })
      }
      return out.sort((a, b) => a.created_at.localeCompare(b.created_at))
    },

    /**
     * 应用一次状态转移。
     *
     * @param {object} input
     * @param {string} input.taskId
     * @param {string} input.event
     * @param {string} input.actorRole
     * @param {string} [input.actorAgentId]
     * @param {string} [input.note]
     */
    async transition(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)

      const from = task.state
      // ★ **恢复点**（本轮修 ①：重复 `block` 覆盖恢复点 ⇒ `unblock` 空转）。
      //
      //   现场（真单 T-20261011-5a871c）：主对话对同一张单 `block` 了两次。
      //   `block` 是 `{ from:'*' }`，所以第二次的 `from` 已经是 `blocked`；而记
      //   恢复点的那条判据只问"`from` 是不是等待态"，对 `blocked` 照样成立
      //   ⇒ **恢复点被覆盖成 `blocked` 自己** ⇒ 之后 `unblock` 回退到 `blocked`，
      //   成了空操作（主对话连调两次，回执都是「已阻塞 → 已阻塞」；audit 两条都在）。
      //
      //   两处收紧/兜底：
      //     · **首次才记**：已经处在阻塞态时**不覆盖**（下面 `repeatedBlock` 那条）；
      //     · **不可用就回落**：`unblock` 时若恢复点缺失 / 等于 `blocked` / 非法，
      //       按**该任务自己的进度**回落到一个明确的合法状态（`states.js` 的
      //       `resolveUnblockRecovery`），并把回落原因写进 audit。
      //   两条都**不碰终态**：`cancelled` / `closed` 上的 `block` 本来就被状态机拒掉，
      //   回落也只落在 `developing` / `ready_dev` 两个非终态上。
      const repeatedBlock = from === ST.BLOCKED && input.event === 'block'
      let previousForApply = task.previous_state ?? undefined
      /** 修好后的恢复点（非 null 时才写回账本，免得被下面的通用规则盖掉）。 */
      let repairedPrevious = null
      /** 与本次转移有关的说明，进 audit / history（回落原因 / 恢复点保持不变）。 */
      let ledgerNote = ''
      if (input.event === 'unblock') {
        const rec = resolveUnblockRecovery(task)
        if (rec.ok === true) {
          previousForApply = rec.state
          if (rec.fallback === true) {
            // ★ **就地修好账本**：把恢复点写回一个合法落点，下一次 `unblock`
            //   就走正常路径、不用再回落一遍（"已卡死的单也要能一次性救回来"）。
            repairedPrevious = rec.state
            ledgerNote = rec.reason
          }
        }
      }
      const res = applyTransition(from, input.event, input.actorRole, previousForApply)
      if (res.ok !== true) {
        return deny('BAD_TRANSITION', `状态迁移被拒（任务 ${task.id}）：${res.error}`)
      }

      // --- 迁移前置条件（guard 名 → 判据）----------------------------------
      const g = res.transition.guard
      if (g !== undefined) {
        const check = await this.checkPrecondition(task, g, input)
        if (check.ok !== true) return check
      }

      // ★ **不把等待态记进 previous_state**。
      //
      //   为什么：两级升级梯会有「待测试 → 等需求分析 → 等用户」这样的链。
      //   如果每跳都记，previous_state 会被写成 'awaiting_clarification'，
      //   用户答复完就"恢复"到"等需求分析" —— 任务永久卡死。
      //   规则本身是通用的：**等待态不是"被打断的工作"**，它只是路上的一站。
      if (repeatedBlock) {
        // ★ 修 ①：**已经在阻塞态 ⇒ 恢复点已存在，保持不变**（不覆盖）。
        //   覆盖的后果就是上面那段现场："回到阻塞前的状态"变成了"回到已阻塞"。
        ledgerNote =
          `恢复点已存在（${typeof task.previous_state === 'string' && task.previous_state.length > 0 ? task.previous_state : '缺失'}），保持不变。` +
          '（重复 block 不覆盖恢复点 —— 否则 unblock 会退化成空操作。）'
      } else if (!WAITING_STATES.includes(from)) {
        task.previous_state = from
      }
      // 回落的修复写在**后面**：让上面那条通用规则先跑完，再把账本改成可用的落点。
      if (repairedPrevious !== null) task.previous_state = repairedPrevious
      task.state = res.to
      // ★★ 主管枢纽的**唯一写点**（T-20261011-56a37e）。
      //   为什么放在这里而不是各个 guard 里：guard 的职责是**判**，
      //   写账本是状态推进的一部分 —— 两件事混在一起会出现"判过了但没写"的中间态。
      //   放在 `persist(task)` 之前 ⇒ 要么全落盘、要么一点都不落（与既有的
      //   "交接物 + 状态一起落、失败一起撤"同一条纪律）。
      applyHubSideEffects(task, input.event, res.to, input)
      // ★ 进「开发中」= 新一轮编写开始：清空上一轮的席位提交表。
      //   打回重做时这一条尤其重要 —— 否则上一轮的提交记录会让「全部到齐」判据误判为已齐。
      //
      //   ★★ 2026-10-14 判据修正（真单 T-20261011-5a871c）：判据从**状态**改成**事件**。
      //     · 原判据：`res.to === ST.DEVELOPING` —— 把「恢复」也当成「开新一轮」。
      //     · 新判据：`res.to === ST.DEVELOPING && !RESUME_EVENTS.has(input.event)` ——
      //       `(previous)` 那一类事件（unblock / human_reply / clarification_reply）是
      //       **同一轮续做**，不清表；其余（`dispatch_writer`，含打回重做那一次）照旧清。
      //   实测形状：11:33:40Z writer#1 交付（1/3，被席位闸**合法**拦下）→ 12:01:32Z block
      //     → 12:23:03Z unblock ⇒ 原来的判据在这里把提交表清成 `{}`，于是
      //     ① 「全部到齐」在本轮永远凑不齐（席位白交）；② 交付 H-073a6a57aaf0ecc7 不再算
      //     「本轮交付」⇒ `patrol.js:260-262` 的兜底支也不成立 ⇒ **一条播报都没有**。
      //   ⚠️ 刻意**不放宽**：`dispatch_writer` 那两条边（ready_dev / returned_to_dev ⇒ developing）
      //     是唯一的"开新一轮"，它们照旧清空 —— 「打回重做时上一轮记录不许冒充本轮已齐」不受影响。
      if (res.to === ST.DEVELOPING && !RESUME_EVENTS.has(input.event)) task.writer_submissions = {}
      const entry = await audit(task.id, input.actorRole, `transition:${input.event}`, {
        from,
        to: res.to,
        note: [input.note ?? '', ledgerNote].filter((s) => String(s).length > 0).join(' '),
        agent: input.actorAgentId,
        // ★ 结构化留痕：恢复点这一笔独立成字段，翻 audit 时不必去解析 note 文本。
        ...(ledgerNote.length > 0
          ? { recovery_point: { used: res.to, previous_state: task.previous_state ?? null, fallback: repairedPrevious !== null } }
          : {}),
      })
      task.history.push(entry)
      await persist(task)

      // ★★ E3（设计 `04-§3.3` + `§3.1`）：迁移出口是记忆域**唯一**能同时拿到
      //   `from` / `to` / 任务对象的地方 —— 所以"落一条迁移记忆"与"活文档跟着更新"
      //   （库变了 ⇒ 活文档该变）都挂在这一句上。两句都**绝不抛**、都受总开关管：
      //   写失败只 warn，被包裹的这次 `pipeline_transition` 照旧返回原结果。
      await appendTransition(task.project_dir ?? projectRoot, { task, from, to: res.to, event: input.event, at: nowIso(now()), by: input.actorRole }, { swOf })
      await refreshLiveDocForTask(task, { swOf, projectDir: projectRoot })

      // ★★ WP-B 接线（02 §4 / 01 §D10）：**关单 / 取消成功之后**把官方任务板上的
      //    那条任务标完成。判据用 `res.to`（真的落到终态）而不是只信事件名；
      //    best-effort：失败只审计，不影响下面这个 `ok:true` 与状态迁移结果。
      if ((input.event === 'close' || input.event === 'cancel') && TERMINAL_STATES.includes(res.to)) {
        await mirrorBoard('close', task, {
          callerAgentId: input.actorAgentId,
          reason: input.event === 'cancel' ? '任务取消' : '任务关闭',
        })
      }

      /**
       * ★★ **缺陷 ⑨**：`from === to` 的迁移必须自己交代"记了什么"。
       *
       * 真机现场：主对话递单给主管（`handoff_to_supervisor`，状态机里是 `pending → pending`）
       * 拿到的返回是「任务 X：待分配 → 待分配。」—— 看不出台账改了没有，
       * 于是无法判断递单成没成。理由与落点见 `lib/store/transition-record.js`。
       * ★ 只在 `from === to` 时追加；真有状态变化的迁移**一个字没改**。
       */
      const recorded = describeTransitionRecord({ event: input.event, task, from, to: res.to })
      return {
        ok: true,
        task,
        from,
        to: res.to,
        state_zh: STATE_LABEL[res.to],
        summary:
          `任务 ${task.id}：${STATE_LABEL[from]} → ${STATE_LABEL[res.to]}。` +
          (recorded.length > 0 ? `\n${recorded}` : ''),
      }
    },

    /**
     * ★ **记一条派活台账**（失联检测的计时起点）。
     *
     * 为什么由 store 来记、而不是派活那边直接塞：
     *   · 落盘要原子写（`persist` 已经做了）；
     *   · 派活**失败**时不该留下台账（否则会被误判成"派出去了没回话"）——
     *     所以调用方只在 `res.ok === true` 之后调这里。
     *
     * 同一 (role, seat) 重复派活**覆盖**旧记录：重派之后按新的时间算超时。
     *
     * @param {string} taskId
     * @param {{role:string, seat?:string|null, agentId?:string|null, token?:string|null, at?:string, atMs?:number, via?:string}} entry
     * @returns {Promise<{ok:boolean, error?:string, task?:object, entry?:object}>}
     */
    async recordDispatch(taskId, entry) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      const at = typeof entry?.at === 'string' && entry.at.length > 0 ? entry.at : nowIso(now())
      const next = upsertDispatch(task.dispatched, { ...entry, at })
      task.dispatched = next
      await persist(task)
      const rec = next.find((x) => x.key === seatKey(entry?.role, entry?.seat)) ?? null
      return { ok: true, task, entry: rec }
    },
  }
}
