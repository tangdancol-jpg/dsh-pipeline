// 关单报告 · `task.close_report` 的形状：关单时间 / 放行依据 / 制品版本 / 风险说明 / 最终交付说明。
/**
 * dsh-pipeline · 领域对象（实现）
 * ============================================================================
 * 从 `lib/store/review.js` 的 `close()` 原样搬来（**只改了 import 路径、取值来源与说明文字，行为未改**）。
 * 对外仍经原模块使用 / 转出，调用方不需要改 import。
 *
 * ★ 依赖方向（单向）：`lib/store/**` 与 `lib/handoff/**` → `lib/model/**`；
 *   `lib/model/**` **不 import** store / handoff。
 * ★ 字面量**原样搬过来**（字段顺序、默认值都没动）。
 *
 * @module dsh-pipeline/lib/model/close-report
 */

import { ROLE } from '../roles.js'
import { nowIso } from '../util.js'

/**
 * 建一份关单报告。
 *
 * @param {object} spec
 * @param {object} spec.task - 任务对象
 * @param {object|null} spec.reviewOk - 有效的那份审核 OK 交接物
 * @param {(task:object) => string|null} spec.currentArtifactVersion - 取「当前有效制品版本」的判据（由 store 提供）
 * @param {() => Date} spec.now - 时钟
 * @returns {object}
 */
export function makeCloseReport({ task, reviewOk, currentArtifactVersion, now }) {
  return {
    closed_at: nowIso(now()),
    closed_by: ROLE.MAIN,
    artifact_version: currentArtifactVersion(task),
    review_ok_handoff: reviewOk?.handoff_id ?? null,
    risk_notes: reviewOk?.payload?.risk_notes ?? [],
    final_delivery_note: reviewOk?.payload?.final_delivery_note ?? '',
    release_approved: reviewOk?.payload?.release_approved === true,
  }
}
