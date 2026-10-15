// DEMO 阶段 · 新状态与新迁移：可操作前端 DEMO 的两个状态与四条边（**不往 states.js 堆**）。
/**
 * dsh-pipeline · DEMO 阶段 · 状态与迁移
 * ============================================================================
 * 定稿 §3.4：「新状态放**新模块** `lib/states/demo-phase.js`（**不往 states.js 堆**）」。
 *
 * ---------------------------------------------------------------------------
 * DEMO 阶段在流程里的位置（为什么是这两个状态）
 * ---------------------------------------------------------------------------
 * 用户口径：「复杂任务**先出可操作前端 DEMO** → **用户确认后**才继续后端」。
 * 所以 DEMO 卡在 **`planning` 与 `ready_dev` 之间**：
 *
 *     planning ──(plan_ready_demo)──▶ demo_building ──(demo_submitted)──▶ demo_confirm
 *                                          ▲                                   │
 *                                          └────────(demo_rework)──────────────┤
 *                                                                              │
 *                                          ready_dev ◀──(demo_confirmed)───────┘
 *
 *   · `demo_building` = DEMO **还在做**（或刚被要求重做一轮）；
 *   · `demo_confirm`  = DEMO **已经交上来了，等用户点头**。
 *
 *   分成两个状态的理由与既有各站一致：它们回答的问题不同 ——
 *   前者催**做 DEMO 的人**，后者催**用户**。合成一个，主对话就答不出"现在该催谁"。
 *
 * ---------------------------------------------------------------------------
 * 为什么本文件**自己不改 states.js**
 * ---------------------------------------------------------------------------
 * 本批次要求"纯新增、零修改既有文件"，所以本文件导出
 * {@link demoPhaseMerge}：**由接线方**把返回值并进 `states.js` 的 `ST` / `STATE_LABEL` /
 * `TRANSITIONS`。要加的那几行写在 `WIRING.md` 里（那一步没做 ⇒ DEMO 闸门不会真的拦人）。
 *
 * ★ 本文件**不 import `states.js`**：那会成环（states.js 要 import 本文件来合并）。
 *   既有状态的 id 通过参数注入 —— 这样也不会出现"两份 ST 常量"的漂移。
 *
 * @module dsh-pipeline/lib/states/demo-phase
 */

/** DEMO 阶段的两个新状态 id（**唯一出处**；接线方从这里取，不手抄字符串）。 */
export const DEMO_ST = Object.freeze({
  /** DEMO 制作中 / 重做中。 */
  BUILDING: 'demo_building',
  /** DEMO 待用户确认。 */
  CONFIRM: 'demo_confirm',
})

/** 两个新状态的中文名（给 `STATE_LABEL` 用）。 */
export const DEMO_STATE_LABEL = Object.freeze({
  [DEMO_ST.BUILDING]: 'DEMO 制作中',
  [DEMO_ST.CONFIRM]: 'DEMO 待用户确认',
})

/** 本阶段新增的事件名（唯一出处）。 */
export const DEMO_EVENTS = Object.freeze({
  START: 'plan_ready_demo',
  SUBMIT: 'demo_submitted',
  CONFIRM: 'demo_confirmed',
  REWORK: 'demo_rework',
})

/**
 * ★ **要并进 `TRANSITIONS` 的四条边**。
 *
 * @param {object} ctx
 * @param {object} ctx.ST - 既有状态常量（`states.js` 的 `ST`，注入以避免成环）
 * @param {object} ctx.ROLE - 既有角色常量（`roles.js` 的 `ROLE`）
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
        '★ 计划自检通过 ⇒ 进 **DEMO 阶段**（而不是直接进「待开发」）。' +
        '判据与原来那条 `planned` 同一份（`plan_ready`），只是**目的地换了**：' +
        'L3+ 的任务必须先出可操作 DEMO（裁定 5）。',
    },
    {
      from: DEMO_ST.BUILDING,
      event: DEMO_EVENTS.SUBMIT,
      to: DEMO_ST.CONFIRM,
      by: ['writer', 'main'],
      guard: 'demo_round_ok',
      note:
        '★ 交一轮 DEMO ⇒ 落到「DEMO 待用户确认」。' +
        '闸门 `demo_round_ok` 判三件事：本轮**产出了新交付物**（不许原地重交）、' +
        '本轮**挂上了一条人工请求**、交付物引用非空（验收 A18）。',
    },
    {
      from: DEMO_ST.CONFIRM,
      event: DEMO_EVENTS.REWORK,
      to: DEMO_ST.BUILDING,
      by: ['writer', 'main'],
      guard: 'demo_round_ok',
      note:
        '★ 用户不满意 ⇒ 回去再改一轮。**不设轮次硬上限**（裁定 13）：' +
        '连做多少轮都不会因为"轮次用尽"被拒 —— 唯一的约束是那三条软约束（A18）。',
    },
    {
      from: DEMO_ST.CONFIRM,
      event: DEMO_EVENTS.CONFIRM,
      to: ST.READY_DEV,
      by: ['main'],
      guard: 'demo_confirmed',
      note:
        '★★ **本批次最关键的一条边**：DEMO **未获用户确认**时这条边过不去（验收 A17）。' +
        '判据 `demo_confirmed` 要求：有一轮 DEMO 交付 + 那条人工请求**已被用户答复**且答复为"认可"。',
    },
  ]
}

/**
 * ★ **这两个状态"轮到了谁"**（并进 `states.js` 的 `STATE_OWNER`）。
 *
 * `demo_building` ⇒ 编写席（DEMO 还在做）；`demo_confirm` ⇒ 主对话（DEMO 交上来了、
 * 等用户点头，而本插件里只有主对话能与用户对话）。
 * ★ 刻意**不给** `null`：`null` 的既有含义是"**终态，没人可催**"（`closed`/`cancelled`），
 *   而这两个是**活跃态且在等人** —— 给 `null` 就等于把"该催谁"重新变回答不出来。
 * ★ 与 {@link demoTransitions} 同纪律：`ROLE` 由接线方注入，不手抄角色 id（避免成环）。
 * 完整理由与"漏登记即红"的判据见 `WIRING.md` §W1 落点 E 与 `tests/p10-state-owner-check.mjs`。
 *
 * @param {{ROLE:object}} ctx
 * @returns {Record<string, string>} 两个状态的 owner 条目
 */
export function demoStateOwners({ ROLE }) {
  if (ROLE === undefined) {
    throw new TypeError('demoStateOwners 需要注入 ROLE（避免与 states.js / roles.js 成环）。')
  }
  return {
    [DEMO_ST.BUILDING]: ROLE.WRITER,
    [DEMO_ST.CONFIRM]: ROLE.MAIN,
  }
}

/**
 * 一次性把 DEMO 阶段并进状态机（**接线方调用**，见 `WIRING.md`）。
 *
 * 用法（写在 `states.js` 里的三处小改）：
 *   · `ST` 里加 `...demoPhaseMerge({ST, ROLE}).states`
 *   · `STATE_LABEL` 里加 `...demoPhaseMerge({ST, ROLE}).labels`
 *   · `TRANSITIONS` 数组末尾加 `...demoPhaseMerge({ST, ROLE}).transitions`
 *   · `STATE_OWNER` 里加 `...demoPhaseMerge({ST, ROLE}).owners`
 *
 * @param {object} ctx
 * @param {object} ctx.ST
 * @param {object} ctx.ROLE
 * @returns {{states:object, labels:object, transitions:Array<object>, events:object, owners:object}}
 */
export function demoPhaseMerge(ctx) {
  return {
    states: { DEMO_BUILDING: DEMO_ST.BUILDING, DEMO_CONFIRM: DEMO_ST.CONFIRM },
    labels: { ...DEMO_STATE_LABEL },
    transitions: demoTransitions(ctx),
    events: { ...DEMO_EVENTS },
    owners: { ...demoStateOwners(ctx) },
  }
}

/**
 * 这两个状态是不是"DEMO 阶段"（给状态查询与闸门复用，避免各处手抄两个字符串）。
 *
 * @param {string} state
 * @returns {boolean}
 */
export function isDemoState(state) {
  return state === DEMO_ST.BUILDING || state === DEMO_ST.CONFIRM
}

/**
 * DEMO 阶段**没有任何轮次硬上限**（裁定 13）。
 *
 * ★ 刻意导出成一个显式的 `null`，而不是"不写这个常量"：
 *   `null` 在这里是**结论**（"不设上限"），不是"忘了设"。零也会是错的语义
 *   （`0` 看起来像"一轮都不许"）。接线方与测试都应引用它。
 */
export const DEMO_ROUND_CAP = null
