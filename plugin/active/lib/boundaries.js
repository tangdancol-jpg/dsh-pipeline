/**
 * dsh-pipeline · **机器可读的边界清单**
 * ============================================================================
 * 用户原话（本项目的目标函数）：
 *   「**ai 的行为不要靠自然语言限制，要靠代码层直接拦截**」
 *
 * 这个模块把"**谁、能做什么、判据在哪**"导成一份结构化清单 —— 它**不是文档**，
 * 而是给**别的执法层**（例如在 DSH 层挂 `UserPromptSubmit` / `PreToolUse` 钩子的那条线）
 * 复用的数据：钩子层不需要读懂本插件的源码，只要读这份清单就能知道
 * "哪个角色不许碰什么、命中哪条判据"。
 *
 * 三条设计约束：
 *   ① **派生，不手抄**：角色/交接物/读禁名单都从 `roles.js` / `guard.js` / `handoff.js`
 *      的**真实常量**里取 —— 手抄一份必然与代码漂移，而漂移了的清单比没有更危险
 *      （钩子层会照着错的清单执法）。
 *   ② **只读**：本模块不产生任何副作用，也不写盘。
 *   ③ **认不出的东西要暴露**：`writeClassOf()` 认不出的 `writes` 取值会进
 *      `unmapped` 列表 —— 让"表里有个值守门不认识"这件事看得见（那正是能力漂移的入口）。
 *
 * @module dsh-pipeline/lib/boundaries
 */

export { ADVISORY_LIMITS, RULE_CLASS, RULES } from './boundaries/rules.js'
export { deriveToolFace, eventLevelToolNames, parseToolAuthority } from './boundaries/tool-face.js'
export { boundaryManifest, renderBoundaryManifest } from './boundaries/manifest.js'
