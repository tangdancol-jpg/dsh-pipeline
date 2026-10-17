/**
 * dsh-pipeline · 哈希前置闸门 · **连续不通过计数与自动升级**
 * ============================================================================
 * 从 `lib/hashgate.js` 机械拆分而来（判据与文案逐字未改）：
 * 连续计数、重取基线时重新起算、升级判据 / 选项 / 文案，以及「闸门是否正卡着」。
 * 纯函数、无 IO。
 *
 * @module dsh-pipeline/lib/hashgate/streak
 */

// ===========================================================================
// ★ 本轮新增：**连续不通过**的计数与"自动交人工"
// ===========================================================================
//
// 用户拍板（P13，2026-10-11）：
//   · 闸门不通过 **不消耗** `maxReworkPerLeg`（保持现状）；
//   · 但**同一任务连续 N 次不过 ⇒ 自动交人工**（走既有的 human_request / 两级梯）。
//
// 下面这段全是**纯函数**：判定与文案在这里，执法在 `lib/store.js`。
// 分开的理由与 `hashGateVerdict` / `renderGateRejection` 一样 ——
// 判定能单测，执法能被夹具真跑，两边不会各写一份口径。

/**
 * ★ 连续失败计数的下一步。
 *
 * 语义（用户要求"写死"，所以写在这里，不许别处再定义一遍）：
 *   · **闸门真通过一次 ⇒ 归零**（这是"连续"唯一的终点）；
 *   · 不通过 ⇒ +1。
 *
 * **撤回越界改动为什么不归零**：机制看不到"撤回"这个动作 ——
 * 编写把文件改回来，机制看到的只是"文件变了"。它唯一能看到的事实是
 * "这个任务连续几次交上来的东西没过闸门"。若按"撤回就归零"，
 * `撤回 → 重交 → 再越界 → 再撤回` 可以无限循环，而每一次都**看起来有进展**。
 *
 * @param {number|undefined|null} prev - 当前计数
 * @param {boolean} passed - 这一次闸门过了没有
 * @returns {number}
 */
export function nextHashGateStreak(prev, passed) {
  if (passed === true) return 0
  const n = Number.isInteger(prev) && prev > 0 ? prev : 0
  return n + 1
}

/**
 * ★ **重取基线 = 新起点**：把「连续不通过」的计数与判定按**新基线**重新起算。
 *
 * -----------------------------------------------------------------------------
 * 为什么需要这一条（现场：真单 T-20261011-214043，闸门长期显示「卡着 连续不通过 1/3」）
 * -----------------------------------------------------------------------------
 * 闸门判的是「**相对基线**的变化」：基线记的是"派活那一刻的项目快照"。
 * 可这个项目里，基线一旦取早了（本单开工基线早于当晚那几次**基础设施前置修复**），
 * 那些**与本单无关**的改动就会永远显示成"本单越界" ——
 * 修不掉：编写席没法把别人的活撤回；许可的出路只有一条，就是**重取基线**。
 *
 * 而重取基线之后，旧基线下的"连续不通过 **1/3**"却**跟着走了** ——
 * 下一次提交仍背着那一格，再攒两次就触发"机制自动交人工"，
 * 等于**让编写替别人的改动去挨那张人工单**。这是归属错位，不是执法。
 *
 * 所以：**基线换了，连续计数就重新起算**（新基线 = 新起点），
 * 同时**作废基于旧基线算出的那份闸门判定**（`task.hash_gate`）——
 * 它自己的 `baseline_id` 就是"它已经过期"的证据，留着只会让守门继续拿旧结论
 * 拦"跑测试"（`hashGateBlocksTests` 读的就是它）。
 *
 * ⚠️ **这不是放宽越界判定**：三类越界（新增/修改/删除清单外）与"声明不实"
 *    一个字都没动，仍然照拒；拒了仍然照计数、照在连续 N 次后自动交人工。
 *    改的只有**起点**：新基线之下的越界，从 1 开始数。
 *
 * ⚠️ **不碰 `hash_gate_escalation`**：那张已经交到用户手上的单不会因为重取基线
 *    而被悄悄撤回（"机制不替用户撤单"）。要了结它，只能走答复。
 *
 * 语义写死在这里（与 `nextHashGateStreak` 同源）—— 不许别处再定义一遍。
 *
 * @param {object|null} task
 * @param {string} baselineId - **新**基线的 id
 * @returns {{changed:boolean, prev_baseline_id:string|null, prev_streak:number, prev_gate_baseline_id:string|null, prev_gate_blocked:boolean}}
 *          改动前的现场（供审计留痕；`changed=false` 表示本来就没什么要清的）
 */
export function resetHashGateOrigin(task, baselineId) {
  const before = {
    changed: false,
    prev_baseline_id: typeof task?.baseline_current === 'string' ? task.baseline_current : null,
    prev_streak: Number.isInteger(task?.hash_gate_streak) ? task.hash_gate_streak : 0,
    prev_gate_baseline_id: typeof task?.hash_gate?.baseline_id === 'string' ? task.hash_gate.baseline_id : null,
    prev_gate_blocked: task?.hash_gate?.blocked === true,
  }
  if (task === null || typeof task !== 'object') return before

  const gateIsStale = task.hash_gate !== null && task.hash_gate !== undefined && before.prev_gate_baseline_id !== baselineId
  if (before.prev_streak === 0 && !gateIsStale) return before

  task.hash_gate_streak = 0
  if (gateIsStale) task.hash_gate = null
  return { ...before, changed: true }
}

/**
 * ★ 升级是否**还没了结**（= 已经交人工、但用户还没答复）。
 *
 * 这个布尔值有两个用处，缺一不可：
 *   ① 决定"要不要再升级"（了结之前不重复升级）；
 *   ② 决定"还收不收重交"（了结之前**拒收** `dev_to_test`）。
 *
 * @param {object|null} task
 * @returns {boolean}
 */
export function hashGateEscalationPending(task) {
  const e = task?.hash_gate_escalation
  if (e === null || e === undefined || typeof e !== 'object') return false
  return e.answered_at === null || e.answered_at === undefined
}

/**
 * ★ 到阈值了没有（纯判据，不含任何 IO）。
 *
 * @param {object|null} task
 * @param {number} threshold - `config.hashGateEscalateAfter`（0 = 关掉自动升级）
 * @returns {boolean}
 */
export function shouldEscalateHashGate(task, threshold) {
  const cap = Number.isInteger(threshold) ? threshold : 0
  if (cap <= 0) return false
  if (hashGateEscalationPending(task)) return false
  const streak = Number.isInteger(task?.hash_gate_streak) ? task.hash_gate_streak : 0
  return streak >= cap
}

/**
 * ★ 交给用户看的**选项**（人话，不含代码、不含路径）。
 *
 * ⚠️ `consequence` 会被 `detectCodeInHumanText` 扫（它是要给用户看的），
 *    所以这里刻意不写任何路径/命令/代码片段。
 */
export const HASH_GATE_ESCALATION_OPTIONS = [
  {
    label: '按原授权范围重做（把越界的改动撤回去）',
    consequence: '任务回到「开发中」，编写只动已经授权的部分，改完重新提交；连续不过的计数从零开始。',
  },
  {
    label: '重新出计划，把范围补齐之后再交',
    consequence: '由计划角色重出授权改动面与新基线，会多一次计划往返；期间任务停在「等待人工答复」。',
  },
  {
    label: '先停住，等我看过实际改动再定',
    consequence: '任务保持「等待人工答复」，不会自己往下走；想继续时由主对话重新派活。',
  },
]

/**
 * ★ 自动升级时的**给用户看的内容**（问句 + 背景 + 选项）。
 *
 * 三条硬约束（都由 `lib/handoff.js` 在提交时执法，写错就提交失败）：
 *   ① 必须**不含代码**（主对话不读代码，含代码它转告不了）；
 *   ② 必须真的是个**问句**（有个问号）；
 *   ③ 长度有上限（几百字符 —— 给用户看的东西要能一眼读完）。
 *
 * @param {object} input
 * @param {number} input.streak
 * @param {number} input.threshold
 * @param {number} [input.round] - 第几次升级（用户答复过之后可以再来一次）
 * @returns {{question:string, context:string, options:object[]}}
 */
export function renderHashGateEscalation({ streak, threshold, round = 1 }) {
  const n = Number.isInteger(streak) ? streak : 0
  const cap = Number.isInteger(threshold) ? threshold : 0
  const question =
    `同一个任务的改动面已经连续 ${n} 次没有通过哈希前置闸门（改动落在授权范围之外，或与编写自己交的改动声明对不上），` +
    '机制已经把它停下来交给你定夺。接下来想怎么走？'
  const context =
    `这道闸排在"提交进测试"之前：它拿派活那一刻的文件基线逐个文件比对，查出四类问题 —— ` +
    '动了授权清单外的文件、新增了清单外的文件、删了清单外的文件，以及"实际动了却没在改动声明里报"。' +
    `连续 ${n} 次都没过（阈值 ${cap}），说明不是一次手滑。按机制规定，这时不再让编写自己反复重交。` +
    '任务现在仍停在「开发中」：测试没有被触发，也没有消耗测试的打回预算。' +
    (round > 1 ? `（这是第 ${round} 次升级：上一次你已经拍板过，但之后又连续不过。）` : '')
  return { question, context, options: HASH_GATE_ESCALATION_OPTIONS.map((o) => ({ ...o })) }
}

/**
 * ★ **同步判据**：这道闸是不是正卡着？
 *
 * 守门要用它拦"绕过闸门先跑一下看看"——守门是**同步**的，所以读的是同步索引里
 * 预先算好的布尔值（`makeTaskIndexEntry({ hashGateBlocked })`）。
 *
 * @param {object|null} task
 * @returns {boolean}
 */
export function hashGateBlocksTests(task) {
  return task?.hash_gate?.blocked === true
}
