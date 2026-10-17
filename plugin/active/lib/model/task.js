// 任务对象 · 初始结构与默认字段：新任务卡的字段清单 / 默认值，以及「任务卡」`task.task_card` 的形状。
/**
 * dsh-pipeline · 领域对象（实现）
 * ============================================================================
 * 从 `lib/store/lifecycle.js` 的 `open()` 与 `lib/store/roster.js` 的 `setRoster()` 原样搬来（**只改了 import 路径、取值来源与说明文字，行为未改**）。
 * 对外仍经原模块使用 / 转出，调用方不需要改 import。
 *
 * ★ 依赖方向（单向）：`lib/store/**` 与 `lib/handoff/**` → `lib/model/**`；
 *   `lib/model/**` **不 import** store / handoff。
 * ★ 两个对象字面量**原样搬过来**（一个字段、一个默认值都没动），只是把「值从哪来」变成入参。
 *
 * @module dsh-pipeline/lib/model/task
 */

import { ST } from '../states.js'
import { toStringArray } from '../util.js'

/**
 * 建一张新任务卡的初始结构（字段 + 默认值）。
 *
 * @param {object} spec
 * @param {string} spec.id - 任务 id
 * @param {string} spec.stamp - 开单时刻（ISO 8601，同时用于 created_at / updated_at）
 * @param {string} spec.projectRoot - 项目根
 * @param {string} spec.requirement - **已 trim** 的原始需求
 * @param {object} spec.input - `open()` 的原始入参（constraints / acceptance / deadline / deliverableFormat 从这里取）
 * @returns {object}
 */
export function makeTaskRecord({ id, stamp, projectRoot, requirement, input }) {
  return {
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
}

/**
 * 任务卡（需求分析 + 计划分配的产物）—— `task.task_card` 的形状。
 *
 * @param {object} spec
 * @param {object} spec.task - 任务对象
 * @param {object} spec.roster - 本次建好的角色清单
 * @param {object} spec.input - 本次调用的原始入参（acceptance / testPoints / boundaries 从这里取）
 * @returns {object}
 */
export function makeTaskCard({ task, roster, input }) {
  return {
    task_id: task.id,
    requirement: task.requirement,
    acceptance: toStringArray(input.acceptance),
    test_points: toStringArray(input.testPoints),
    boundaries: toStringArray(input.boundaries),
    tier: roster.tier,
    ai_count: roster.ai_count,
    roles: roster.conversations.slice(),
    sequence: roster.sequence.map((s) => s.role),
    reason: roster.reason,
    judged_by: roster.judged_by,
  }
}
