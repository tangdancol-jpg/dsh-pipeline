/**
 * dsh-pipeline · **哈希前置闸门**（排在一切测试之前）
 * ============================================================================
 * 用户原话：
 *   「**先过哈希对比，哈希对比不过全量测试直接打回**」
 *
 * ---------------------------------------------------------------------------
 * 它在流程里的位置（这是本模块存在的全部理由）
 * ---------------------------------------------------------------------------
 *
 *   编写交产物（dev_to_test）
 *     └─ ① 形状核对：change_manifest 每条引用一个存在的授权条目（既有）
 *     └─ ② ★**哈希闸门**：按派活基线逐文件比 —— 新增 / 修改 / 删除三类都查
 *          ├─ 通过（实际改动面 ⊆ 授权面，且声明与实际一致）→ 放行 → 进测试
 *          │    └─ ★ **连续不过的计数归零**（唯一的归零点）
 *          └─ 不通过 → **直接打回编写**：
 *               · 不进入测试（状态停在"开发中"）
 *               · **不消耗测试预算**（也不消耗 `maxReworkPerLeg` —— 打回严格说没发生）
 *               · **不进"是否跑全量"的审批链**
 *               · ★ 连续不过计数 +1；**连续 N 次**（`hashGateEscalateAfter`，默认 3）
 *                 ⇒ **机制自动交人工**（走既有的 human_request / 两级梯），
 *                 并在用户答复之前**拒收**同一任务的再次提交
 *     └─ ③ 之后的才是：测试 → 审核 → 关单
 *
 * **设计意图：不合格的提交不该消耗测试资源。** 让测试去跑一套注定被打回的产物，
 * 是纯浪费 —— 时间、token、以及测试角色的注意力。这是省时间省 token 的**第一道闸**。
 *
 * **为什么还要"连续 N 次就交人工"**：不消耗打回预算有一个副作用 ——
 * 编写**可以无限重交**。预算是为"来回拉锯"设的（打回真的发生过），
 * 而闸门不通过时任务从未离开"开发中"，那笔预算不该被扣；所以堵这个副作用的
 * 正确位置不是"扣预算"，而是"**连续 N 次不过就把人请回来**"（用户 P13 的拍板）。
 *
 * ---------------------------------------------------------------------------
 * 判定口径（三类 + 一类"声明不实"）
 * ---------------------------------------------------------------------------
 *   比对对象 = ① 派活那一刻的**基线**（文件清单 + 每个文件的 sha256）
 *             ② 计划给的**授权改动面**（change_scope）
 *             ③ 编写自己交的**改动声明**（change_manifest）
 *
 *   · **新增**（基线里没有、现在有）—— 不在授权面内 ⇒ 越界
 *   · **修改**（两边都有、哈希不同）—— 不在授权面内 ⇒ 越界
 *   · **删除**（基线里有、现在没有）—— 不在授权面内 ⇒ 越界
 *   · **声明不实**：实际动了、但 change_manifest 里没报 ⇒ 也算不过
 *     （哈希是真相，声明是承诺，两者必须对得上）
 *
 * ⚠️ **L0 没有"计划"这一站 ⇒ 没有基线**，所以这道闸在 L0 上**不适用**
 *    （与"改动面 = 授权面"那条同源，见 README 待拍板 P4）。
 *
 * @module dsh-pipeline/lib/hashgate
 */

export {
  GUARD_WRITE_ALLOWED_SOURCE,
  MACHINE_ARTIFACT_BASENAMES,
  WRITE_LEDGER_FILE_NAME,
  WRITE_LEDGER_KIND,
  WRITE_LEDGER_SOURCES,
  buildForeignWriteIndex,
  buildSeatWriteIndex,
  foreignAttributionOf,
  isMachineArtifactPath,
  makeWriteLedgerEntry,
  parseWriteLedger,
  seatClaimOf,
  seatTouchOf,
} from './hashgate/ledger.js'

export {
  hashGateVerdict,
  renderGateRejection,
} from './hashgate/verdict.js'

export {
  HASH_GATE_ESCALATION_OPTIONS,
  hashGateBlocksTests,
  hashGateEscalationPending,
  nextHashGateStreak,
  renderHashGateEscalation,
  resetHashGateOrigin,
  shouldEscalateHashGate,
} from './hashgate/streak.js'
