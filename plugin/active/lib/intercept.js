// 拦截缝的**对外门面**：只做转出，实现按职责拆在 lib/intercept/ 与 lib/guard/ 下。
/**
 * dsh-pipeline · **拦截缝（harness interception seams）** —— 门面
 * ============================================================================
 * 用户原话：
 *   「**我是让你安排写入多 ai 协同插件中去阻止他们干不该干的事，而不是新写**」
 *   「四问 Skill 只是"引导"；**真正的拦截必须是代码**」
 *
 * ---------------------------------------------------------------------------
 * 文件布局（对外导出名与拆分前逐一相同，调用方不需要改 import）
 * ---------------------------------------------------------------------------
 *   intercept/seat.js          席位认人（"这个会话是不是管线席位"）
 *   intercept/prompt-rules.js  提示词的两条硬约束 + 席位开场简报（四问）
 *   intercept/wake-disc.js     从"这一次调用的返回值"里取唤醒判别子
 *   intercept/registry.js      ★ 挂载编排：按总开关**真挂真摘**，并把四条缝装配起来
 *   ../guard/hook-pre.js       ① tools/pre-execute（与 ctx.tools.guard 同一份判据）
 *   ../guard/hook-prompt.js    ② agent/pre-step（提示词硬拦 + 上下文注入）
 *   ../guard/hook-wake.js      ③ tools/post-execute（交付即唤醒）
 *   ../guard/hook-post.js      ④ tools/post-execute（结果"第二道网"）★ 缺陷现场
 *
 * 拆分的理由（`CONVENTIONS.md`：一文件一职责、单文件 ≤400 行）：改前的单文件
 * 一个文件里同时住着"认人 / 提示词判据 / 上下文文案 / 结果粗判 / 挂载 / 失联检测"，
 * 六种改动原因 —— 而缺陷「开关只关一半」恰恰是因为**每条缝各自为政**（守门读了开关，
 * 四条缝一条没读）。职责拆开之后，"每条缝都必须问同一个闸门"才能被按条数核对。
 *
 * ---------------------------------------------------------------------------
 * ★★ 总开关（缺陷「开关只关一半」的修复）
 * ---------------------------------------------------------------------------
 * 判据只有一处：`lib/switch/gate.js` 的 `isEnabled()` / `shouldFire(hookId)`。
 * 关掉时**这四条缝一条都不挂**（见 `intercept/registry.js`），并且每条缝的第一句
 * 仍然问一次闸门 —— 两层，前者可程序化断言（挂着的缝 = 0），后者覆盖两次采样之间的调用。
 * 受管的**面清单**在 `SWITCH_SURFACES`：新增任何"会拦 / 会注入"的面都必须登记一行，
 * 自测按条数核对，漏一条就红。
 *
 * ★ 另一层 kill-switch 是配置层的 `config.intercept !== true`（需要重启）——
 *   关掉时 `index.js` 连 `registerInterception` 都不调，一条缝都不挂。
 *
 * @module dsh-pipeline/lib/intercept
 */

export { createSeatResolver } from './intercept/seat.js'
export { collectPromptText, judgePrompt, seatBriefing, PROMPT_CODE_READ_RE, STOP_LADDER_FOUR } from './intercept/prompt-rules.js'
export { readWakeDisc } from './intercept/wake-disc.js'
export { INTERCEPT_EVENTS, LIVENESS_CHECK_THROTTLE_MS, registerInterception } from './intercept/registry.js'
