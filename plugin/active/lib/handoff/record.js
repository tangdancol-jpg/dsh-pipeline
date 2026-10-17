// 交接物记录 · 构造/席位/摘要/任务 id：实现已搬到 `lib/model/handoff-record.js`，本文件只做转出。
/**
 * dsh-pipeline · 交接物 · 记录与摘要（转出）
 * ============================================================================
 * 交接物这个领域对象的构造与对象级纯函数集中在 `lib/model/handoff-record.js`；
 * 本文件只把它的导出原样转出 —— **对外导出面与搬迁前逐字相同**。
 *
 * @module dsh-pipeline/lib/handoff/record
 */

export {
  resolveHandoffSeat,
  buildHandoffRecord,
  summarizeHandoff,
  makeTaskId,
} from '../model/handoff-record.js'
