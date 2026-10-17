/**
 * dsh-pipeline · **错误码常量（唯一出处）**
 * ============================================================================
 * 为什么单独一个文件：错误码是**跨文件契约** —— 产出方在 `store/` / `guard/`
 * 里写一个字面量，判断方在 `tools/` 里再写一遍，两边一改就漂移。而本插件的大量
 * 自测是**按字面断言**的（`assert(code === 'TASK_NOT_FOUND')` 那种），所以
 * 集中的前提是 **值逐字相同**：常量只是名字，值仍然是那个字符串本身。
 *
 * ---------------------------------------------------------------------------
 * 收录判据（宁缺毋滥）
 * ---------------------------------------------------------------------------
 * 只收**这两个角色之一**的字符串：
 *   ① 由某处 `deny(...)` / `fail(...)` / `code:` 产出、且调用方会拿它做判断的**判据码**；
 *   ② 结果里的**状态码**（`OK`）。
 * **不收**：role / state / tool 名、事件名、`kind` 值、`source.kind` 白名单 ——
 * 它们是**枚举**不是错误码，落到这里会把"错误从哪来"和"世界长什么样"搅在一起。
 *
 * ---------------------------------------------------------------------------
 * 范围说明（本次重构的边界）
 * ---------------------------------------------------------------------------
 * 本次只把**范围内**（`lib/guard/**`、`lib/tools/**`）的调用点改成引用常量。
 * 产出这些码的另一半在 `lib/store/**` 等目录，那些文件正被并行任务改动，
 * **一个字节都没动** —— 所以这里出现的常量目前是"范围内唯一出处"，
 * 等那些目录也接过来之后才会变成全插件唯一出处。**值相同**，两边混用不会错。
 *
 * @module dsh-pipeline/lib/errors/codes
 */

// ---------------------------------------------------------------------------
// 通用判据码
// ---------------------------------------------------------------------------

/**
 * 没有这张任务单（`store.get()` 返回 null 时最常见的第一个拒绝）。
 *
 * ★ 本码的**拒绝文案**另有一份模板：`text.js` 的 `taskNotFound()`。
 *   两者是同一件事的两半（码 + 文案），改一个别忘了另一个。
 */
export const TASK_NOT_FOUND = 'TASK_NOT_FOUND'

/** 要一张任务卡却没给（`pipeline_project_init` 的入口判据）。 */
export const NO_TASK = 'NO_TASK'

/** 判不出调用方身份（既没绑会话也没带 `role_token`）。 */
export const NO_ACTOR = 'NO_ACTOR'

/** 工具入参里的 `action` 认不出来。 */
export const BAD_ACTION = 'BAD_ACTION'

/**
 * 授权面为空 —— 不是失败：`ok:true` 但**不建目录**（见 `tools/project.js`）。
 * 收进来是因为它也是结果里的判据码，调用方要按它分流。
 */
export const SCOPE_EMPTY = 'SCOPE_EMPTY'

/** `AGENTS.md` 落盘失败（且上游没给出更具体的码时的兜底）。 */
export const AGENTS_MD_FAILED = 'AGENTS_MD_FAILED'

/**
 * 交接物"跳步"被拒（产出方：`lib/store/review.js`）。
 *
 * ★ 这里只被 `lib/tools/flow.js` **读**来做分流（被拒收的交付要不要留档）。
 *   它必须与产出方逐字一致，否则"被拒收的交付不许静默消失"那条会悄悄失效。
 */
export const HANDOFF_STEP_SKIPPED = 'HANDOFF_STEP_SKIPPED'

/**
 * 待机席位还没到唤醒点（产出方：`lib/store/hub.js`）。
 *
 * ★ 范围内只在 `lib/guard/decide.js` 的**拒绝文案里点名**它（告诉调用方
 *   "这条判据在 store 那边叫什么"）。点名也走常量：用户是照着这个码去查日志的。
 */
export const HUB_STANDBY_NOT_WOKEN = 'HUB_STANDBY_NOT_WOKEN'

/** 结果状态码：这一路判据通过（`code` 字段的"没有错误"取值）。 */
export const OK = 'OK'

// ---------------------------------------------------------------------------
// DEMO 闸门判据码（产出方：lib/guard/demo-gate.js）
// ---------------------------------------------------------------------------
//
// 验收 A17 的四个拒收理由。它们是**互斥**的四条，调用方（主对话 / tool 层）
// 靠码区分"该去交 DEMO"还是"该去催用户答复"—— 所以不许合并成一个码。

/** 一轮可操作 DEMO 都没交过。 */
export const DEMO_NOT_DELIVERED = 'DEMO_NOT_DELIVERED'

/** 交过 DEMO，但还没拿到用户确认（或确认信不完整）。 */
export const DEMO_NOT_CONFIRMED = 'DEMO_NOT_CONFIRMED'

/** 确认信指向的人工请求在任务上找不到（凭据缺失）。 */
export const DEMO_CONFIRM_REQUEST_NOT_FOUND = 'DEMO_CONFIRM_REQUEST_NOT_FOUND'

/** 人工请求还在，但状态不是 `answered`（转告 ≠ 答复）。 */
export const DEMO_CONFIRM_NOT_ANSWERED = 'DEMO_CONFIRM_NOT_ANSWERED'
