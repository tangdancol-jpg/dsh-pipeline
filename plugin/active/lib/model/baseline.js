// 改动基线记录 · `baseline-<id>.json` 与 `task.baselines[]` 的形状：谁 / 何时 / 基于哪份计划 / 清单哈希 / 逐文件 sha256。
/**
 * dsh-pipeline · 领域对象（实现）
 * ============================================================================
 * 从 `lib/store/baseline.js` 的 `takeBaseline()` 原样搬来（**只改了 import 路径、取值来源与说明文字，行为未改**）。
 * 对外仍经原模块使用 / 转出，调用方不需要改 import。
 *
 * ★ 依赖方向（单向）：`lib/store/**` 与 `lib/handoff/**` → `lib/model/**`；
 *   `lib/model/**` **不 import** store / handoff。
 * ★ 字面量**原样搬过来**（字段顺序、默认值都没动）。
 *
 * @module dsh-pipeline/lib/model/baseline
 */

import { ROLE } from '../roles.js'
import { nowIso, shortHash } from '../util.js'

/**
 * 记录一份改动基线（派活那一刻的文件清单 + 每个文件的 sha256）。
 *
 * @param {object} spec
 * @param {object} spec.task - 任务对象（baseline_id 用到它的 id 与已有基线数）
 * @param {string} spec.digest - 整份清单的 sha256
 * @param {Record<string,{sha256:string,bytes:number}>} spec.files - 逐文件清单
 * @param {number} spec.bytes - 总字节数
 * @param {() => Date} spec.now - 时钟
 * @param {object} spec.input - `takeBaseline()` 的原始入参（by / planHandoffId / note 从这里取）
 * @returns {object}
 */
export function makeBaselineRecord({ task, digest, files, bytes, now, input }) {
  return {
    baseline_id: `BL-${shortHash(`${task.id}|${(task.baselines ?? []).length}|${digest}`)}`,
    taken_at: nowIso(now()),
    taken_by: String(input.by ?? ROLE.PLANNER),
    plan_handoff_id: typeof input.planHandoffId === 'string' ? input.planHandoffId : null,
    note: typeof input.note === 'string' ? input.note : '',
    file_count: Object.keys(files).length,
    total_bytes: bytes,
    digest,
    files,
  }
}
