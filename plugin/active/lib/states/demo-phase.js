// DEMO 阶段 · 状态机：两个状态 + 四条迁移边 + 交付席位白名单（**不往 states.js 堆**）。
/**
 * dsh-pipeline · DEMO 阶段 · 状态与迁移
 * ============================================================================
 * 设计档 `design/conventions/04-demo与制品模型.md` §1（用户已拍板「推荐 A」）：
 *
 *     planning ──demo_started──▶ demo_building ──demo_submitted──▶ demo_review
 *                                     ▲                                  │
 *                                     └──────────demo_rework─────────────┤
 *                                                                        │
 *                                     ready_dev ◀──────demo_passed───────┘
 *
 *   · `demo_building` = DEMO **还在做**（或刚被要求重做一轮）⇒ 催**做 DEMO 的人**；
 *   · `demo_review`   = DEMO **已经交上来了，等用户点头** ⇒ 催**用户**（主对话转告）。
 *   ★ 两个状态分开的理由：它们回答的"下一步该催谁"完全不同；合成一个，主对话就答不出。
 *
 * ---------------------------------------------------------------------------
 * P1-7（2026-10-18）改名说明 + 旧名兼容
 * ---------------------------------------------------------------------------
 * P4 批次先把这两个状态叫 `demo_building` / `demo_confirm`，进入事件叫 `plan_ready_demo`、
 * 推进事件叫 `demo_confirmed`。本批次按**设计档定名**统一成：
 *
 *     demo_started / demo_submitted / demo_passed / demo_rework
 *     demo_building / demo_review
 *
 * 为不打断既有的引用（`tests/p6-demo-phase-check.mjs`、`tests/p10-state-owner-check.mjs`
 * 都按常量取值），旧常量键**保留为别名**：
 *   · `DEMO_ST.CONFIRM`        → `'demo_review'`（**新值**；旧断言 `=== 'demo_confirm'` 会红，已报给 Lead）
 *   · `DEMO_EVENTS.CONFIRM`    → `'demo_passed'`
 *   · `DEMO_ST.LEGACY_CONFIRM` → `'demo_confirm'`（旧状态 id，仅旧单兼容用）
 *   · `DEMO_EVENTS.LEGACY_CONFIRM` → `'demo_confirmed'`（旧事件名，仅旧单兼容用）
 *
 * 旧单兼容的边界（任务书原文）：「已到 `ready_dev` 及之后的任务不因缺新状态而红」——
 * 迁移判据只对**从 `planning` 出发**的那条边生效；旧单原样可读可查。
 *
 * ★ 本文件**不 import `states.js`**（那会成环：states.js 要 import 本文件来合并）：
 *   既有状态的 id 通过参数注入 —— 这样也不会出现"两份 ST 常量"的漂移。
 *
 * @module dsh-pipeline/lib/states/demo-phase
 */

import { demoRequiredForTier } from './demo-tier-policy.js'

/**
 * ★ **可以交付 DEMO 的角色**（P1-8 的唯一出处）。
 *
 * 设计档 §2「推荐 A」：`pipeline_demo` 留给 main；DEMO 内容由**交付席位**用
 * `pipeline_demo_submit` 交上来。白名单只认这三个角色 —— 它们本来就是"把东西做出来"的人：
 *   · `writer`      —— 实现/页面本体；
 *   · `architect`   —— 设计态骨架；
 *   · `diagrammer`  —— 可交互原型 / 示意图。
 *
 * ★ 守门（`lib/guard/rules.js`）、工具（`lib/tools/demo.js`）、计划自检（`lib/tools/plan.js`）、
 *   store 层（`lib/store/demo.js`）**全部引用这一份**（各写一份必然漂移）。
 */
export const DEMO_SUBMIT_ROLES = Object.freeze(['writer', 'architect', 'diagrammer'])

/** DEMO 阶段的两个状态 id（**唯一出处**；接线方从这里取，不手抄字符串）。 */
export const DEMO_ST = Object.freeze({
  /** DEMO 制作中 / 重做中。 */
  BUILDING: 'demo_building',
  /** DEMO 已交上来、待用户确认（设计档定名）。 */
  REVIEW: 'demo_review',
  /**
   * ★ P4 旧名别名 —— 新值指向 `demo_review`。
   *   保留它是为了不改既有的 `DEMO_ST.CONFIRM` 引用（工具/测试里还有它）。
   * @deprecated 新代码请用 {@link DEMO_ST.REVIEW}
   */
  CONFIRM: 'demo_review',
  /** ★ **仅旧单兼容**：P4 期间落盘的旧状态 id。新流程不会进入它。 */
  LEGACY_CONFIRM: 'demo_confirm',
})

/** 两个新状态的中文名（给 `STATE_LABEL` 用；只放**新状态**，旧名标签由 states.js 单列）。 */
export const DEMO_STATE_LABEL = Object.freeze({
  [DEMO_ST.BUILDING]: 'DEMO 制作中',
  [DEMO_ST.REVIEW]: 'DEMO 待用户确认',
})

/** 本阶段的事件名（唯一出处）。 */
export const DEMO_EVENTS = Object.freeze({
  /** planning → demo_building（计划自检通过 ⇒ 进 DEMO 阶段）。 */
  START: 'demo_started',
  /** demo_building → demo_review（交一轮 DEMO，落到"等用户确认"）。 */
  SUBMIT: 'demo_submitted',
  /** demo_review → ready_dev（用户确认后放行）。 */
  PASS: 'demo_passed',
  /** demo_review → demo_building（用户不满意 ⇒ 重做一轮，**不设轮次上限**）。 */
  REWORK: 'demo_rework',
  /**
   * ★ P4 旧名别名 —— 新值指向 `demo_passed`（配合 `DEMO_ST.CONFIRM` 的旧引用）。
   * @deprecated 新代码请用 {@link DEMO_EVENTS.PASS}
   */
  CONFIRM: 'demo_passed',
  /** ★ **仅旧单兼容**：P4 期间落盘的旧事件名（只在旧边里用）。 */
  LEGACY_CONFIRM: 'demo_confirmed',
})

/**
 * ★ **要并进 `TRANSITIONS` 的四条边**（设计档 §1 的状态机图，逐条对应）。
 *
 * @param {object} ctx
 * @param {object} ctx.ST - 既有状态常量（注入以避免成环）
 * @param {object} ctx.ROLE - 既有角色常量
 * @returns {Array<object>} 四条 `TRANSITIONS` 表项（形状与既有表项逐字一致）
 */
export function demoTransitions({ ST, ROLE }) {
  if (ST === undefined || ROLE === undefined) {
    throw new TypeError('demoTransitions 需要注入 ST 与 ROLE（避免与 states.js 成环）。')
  }
  return [
    {
      from: ST.PLANNING,
      event: DEMO_EVENTS.START,
      to: DEMO_ST.BUILDING,
      by: ['planner'],
      guard: 'plan_ready',
      note:
        '★ 计划自检通过 ⇒ 进 **DEMO 阶段**（L3+ 必出；L2 由用户显式选择；L0–L2 默认仍走 planning→ready_dev）。' +
        '闸门与原来那条 `planned` 同一份（`plan_ready`），只是**目的地换了**。',
    },
    {
      from: DEMO_ST.BUILDING,
      event: DEMO_EVENTS.SUBMIT,
      to: DEMO_ST.REVIEW,
      by: [...DEMO_SUBMIT_ROLES, 'main'],
      guard: 'demo_round_ok',
      note:
        '★ 交一轮 DEMO ⇒ 落到「DEMO 待用户确认」。' +
        '交付物由**交付席位**交（`pipeline_demo_submit`），主对话的 `pipeline_demo round` 定稿这一轮；' +
        '闸门 `demo_round_ok` 判本轮**请求仍是新的、已答复、未被别的轮消费**（一条请求只能用一次）。',
    },
    {
      from: DEMO_ST.REVIEW,
      event: DEMO_EVENTS.REWORK,
      to: DEMO_ST.BUILDING,
      by: ['main'],
      guard: 'demo_round_ok',
      note:
        '★ 用户不满意 ⇒ 回去再改一轮（**主对话**按用户答复触发）。' +
        '**不设轮次硬上限**（裁定 13）：连做多少轮都不会因为"轮次用尽"被拒。',
    },
    {
      from: DEMO_ST.REVIEW,
      event: DEMO_EVENTS.PASS,
      to: ST.READY_DEV,
      by: ['main'],
      guard: 'demo_confirmed',
      note:
        '★★ **本批次最关键的一条边**：`demo_review → ready_dev`。' +
        '判据 `demo_confirmed` 要求：有一轮**已确认**的 DEMO、' +
        '该轮的 `human_request` 是**本轮创建**（不是复用旧请求）、**已 answered**（转告 ≠ 答复）、' +
        '且**未被别的轮消费过**。否则拒绝并给出下一步。',
    },
  ]
}

/**
 * ★ 两个（+ 旧名）DEMO 状态"轮到了谁"（并进 `STATE_OWNER`）。
 *
 * `demo_building` ⇒ 交付席位（DEMO 还在做）；`demo_review` ⇒ 主对话（等用户点头）。
 * ★ 刻意**不给** `null`：`null` 的既有含义是"**终态，没人可催**"，而这两个是活跃态。
 *
 * @param {{ROLE:object}} ctx
 * @returns {Record<string, string>}
 */
export function demoStateOwners({ ROLE }) {
  if (ROLE === undefined) {
    throw new TypeError('demoStateOwners 需要注入 ROLE（避免与 states.js / roles.js 成环）。')
  }
  return {
    [DEMO_ST.BUILDING]: ROLE.WRITER,
    [DEMO_ST.REVIEW]: ROLE.MAIN,
    // ★ 旧单兼容：旧状态仍有 owner（否则 p10 的"状态全集 ⊆ owner"会红）。
    [DEMO_ST.LEGACY_CONFIRM]: ROLE.MAIN,
  }
}

/**
 * 一次性把 DEMO 阶段并进状态机（**接线方调用**，见 `WIRING.md`）。
 *
 * 用法（写在 `states.js` 里的四处小改）：
 *   · `ST` 里加 `...demoPhaseMerge({ST, ROLE}).states`
 *   · `STATE_LABEL` 里加 `...demoPhaseMerge({ST, ROLE}).labels`
 *   · `TRANSITIONS` 数组末尾加 `...demoPhaseMerge({ST, ROLE}).transitions`
 *   · `STATE_OWNER` 里加 `...demoPhaseMerge({ST, ROLE}).owners`
 *
 * ★ 返回的 `states` / `labels` / `owners` **只含新状态**（旧名标签由 states.js 单列，
 *   这样 p6 的「labels 里带两个中文名」保持成立）。
 *
 * @param {object} ctx
 * @param {object} ctx.ST
 * @param {object} ctx.ROLE
 * @returns {{states:object, labels:object, transitions:Array<object>, events:object, owners:object}}
 */
export function demoPhaseMerge(ctx) {
  return {
    states: { DEMO_BUILDING: DEMO_ST.BUILDING, DEMO_REVIEW: DEMO_ST.REVIEW },
    labels: { ...DEMO_STATE_LABEL },
    transitions: demoTransitions(ctx),
    events: { ...DEMO_EVENTS },
    owners: { ...demoStateOwners(ctx) },
  }
}

/**
 * 这两个状态（含旧名）是不是"DEMO 阶段"（给状态查询与闸门复用，避免各处手抄字符串）。
 *
 * @param {string} state
 * @returns {boolean}
 */
export function isDemoState(state) {
  return state === DEMO_ST.BUILDING || state === DEMO_ST.REVIEW || state === DEMO_ST.LEGACY_CONFIRM
}

/**
 * ★ **这个档位要不要走 DEMO 显式阶段**（P1-7 的路由判据；单一出处）。
 *
 * 设计档 §1：`planning --demo_started--> demo_building`；「仅 L3+ 强制、L0–L2 轻量」。
 * 用户拍板 B（本批）：**L3+ require 必走新阶段；L2 ask 仍可选择跳过**；L0/L1 默认旧路径。
 *
 * 判据（全部可查）：
 *   1. 任务上有显式的 `demo.plan.decision === 'demo'` ⇒ 走新阶段（任何档位都可以显式要看）；
 *   2. `demo.plan.decision === 'skip'` ⇒ 旧路径（只允许 skip/ask 档位这样选，require 由 demoPlan 拒）；
 *   3. 否则按档位策略：`require`（L3+）⇒ 新阶段；`ask` / `skip` ⇒ 旧路径。
 *
 * @param {unknown} tier - 档位（L0…L5，大小写不敏感）
 * @param {object|null} demoRecord - `task.demo`（可为 null/undefined）
 * @returns {boolean}
 */
export function demoStageRequiredFor(tier, demoRecord) {
  const rec = demoRecord !== null && typeof demoRecord === 'object' && !Array.isArray(demoRecord) ? demoRecord : null
  const plan = rec?.plan !== null && typeof rec?.plan === 'object' && !Array.isArray(rec.plan) ? rec.plan : null
  if (plan !== null && plan.decision === 'demo') return true
  if (plan !== null && plan.decision === 'skip') return false
  const action = plan?.action
  if (action === 'require') return true
  if (action === 'skip') return false
  if (action === 'demo') return true
  // 没有记账 / 记的是 ask：L3+ 必须走（不能因为"没算过档位"就跳过 DEMO）。
  return demoRequiredForTier(tier)
}

/**
 * DEMO 阶段**没有任何轮次硬上限**（裁定 13）。
 *
 * ★ 刻意导出成一个显式的 `null`，而不是"不写这个常量"：
 *   `null` 在这里是**结论**（"不设上限"），不是"忘了设"。
 */
export const DEMO_ROUND_CAP = null
