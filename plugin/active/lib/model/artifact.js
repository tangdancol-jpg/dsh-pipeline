// 制品版本记录 · `task.artifacts[]` 与 `artifacts/v<N>/` 的形状：版本号 / 路径 / 字节数 / sha256 / 登记时间 / 备注。
/**
 * dsh-pipeline · 领域对象（实现）
 * ============================================================================
 * 从 `lib/store/review.js` 的 `registerArtifact()` 原样搬来（**只改了 import 路径、取值来源与说明文字，行为未改**）。
 * 对外仍经原模块使用 / 转出，调用方不需要改 import。
 *
 * ★ 依赖方向（单向）：`lib/store/**` 与 `lib/handoff/**` → `lib/model/**`；
 *   `lib/model/**` **不 import** store / handoff。
 * ★ 字面量**原样搬过来**（字段顺序、默认值都没动）。
 *
 * @module dsh-pipeline/lib/model/artifact
 */

import { fullHash, nowIso } from '../util.js'

/**
 * 登记一个制品版本（编写角色的动作）。
 *
 * @param {object} spec
 * @param {string} spec.version - 形如 `v1` 的版本号
 * @param {string} spec.file - 制品落盘路径
 * @param {string} spec.content - 制品正文
 * @param {string|undefined} spec.note - 备注
 * @param {() => Date} spec.now - 时钟
 * @returns {object}
 */
export function makeArtifactRecord({ version, file, content, note, now }) {
  return {
    version,
    file,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: fullHash(content),
    created_at: nowIso(now()),
    note: typeof note === 'string' ? note : '',
  }
}
