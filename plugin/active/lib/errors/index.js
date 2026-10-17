/**
 * dsh-pipeline · **错误码与拒绝文案的汇总出口**
 * ============================================================================
 * 两个子模块一件事各占一半，本文件只是把它们**汇总**成一条 import 路径：
 *
 *   · `codes.js` —— 错误码常量（值逐字相同；判据码 + 状态码）
 *   · `text.js`  —— 拒绝/提示文案模板（含原 `lib/switch/text.js` 的固定文案）
 *
 * 用法二选一（都对，导出的是**同一批绑定**）：
 *
 * ```js
 * import { TASK_NOT_FOUND, taskNotFound } from '../errors/index.js'   // 扁平
 * import { codes, text } from '../errors/index.js'                     // 分门别类
 * ```
 *
 * ★ 刻意**不做**"按错误码查文案"的映射表：码与文案不是一对一（同一个
 *   `TASK_NOT_FOUND` 在不同工具里可以配不同细节的句子），硬做映射会把
 *   "改一句文案"变成"改一张表"，正是这次重构要避免的那种耦合。
 *
 * @module dsh-pipeline/lib/errors
 */

export * from './codes.js'
export * from './text.js'

export * as codes from './codes.js'
export * as text from './text.js'
