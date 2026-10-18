/**
 * dsh-pipeline · 哈希前置闸门 · **判定与打回文案**
 * ============================================================================
 * 从 `lib/hashgate.js` 机械拆分而来（判据与文案逐字未改）：
 * `hashGateVerdict`（三类越界 + 声明不实 + 归属/机器产物豁免）与 `renderGateRejection`。
 * 纯函数、无 IO。
 *
 * @module dsh-pipeline/lib/hashgate/verdict
 */

import {
  isMachineArtifactPath,
  buildForeignWriteIndex,
  buildSeatWriteIndex,
  foreignAttributionOf,
  seatClaimOf,
  seatTouchOf,
  GUARD_WRITE_ALLOWED_SOURCE,
} from './ledger.js'

/** 越界类型 → 人话。 */
const HOW_ZH = {
  created_unauthorized: '新增了**清单外**的文件',
  modified_unauthorized: '修改了**清单外**的文件',
  removed_unauthorized: '删除了**清单外**的文件',
  undeclared_change: '动了但**没在改动声明里报**（声明与实际不一致）',
}

/**
 * 从 `store.changeAudit()` 的结果算出闸门判定。
 *
 * @param {object} audit - changeAudit 的返回值
 * @param {object[]} [manifest] - 编写交的 change_manifest
 * @param {object} [opts] - ★ 路径归一化器（本轮修 ③「授权面用绝对路径、校验只认相对路径」）
 * @param {(p:string)=>string} [opts.absOfDeclared] - `change_manifest[].path` → 规范绝对键
 *   （按**授权面锚点**解析：绝对路径原样归一化，裸相对路径拼到锚点下）
 * @param {(p:string)=>string} [opts.absOfTouched] - 审计里那条路径（**相对项目根的基线键**）
 *   → 同一个坐标系里的绝对键
 *
 *   ← 为什么必须有这两个：`touched` 的路径是**相对项目根**的（`audit` 由基线算出来），
 *   而编写在 `change_manifest` 里完全可能按授权面的写法填**绝对路径**（本单授权面就是
 *   绝对路径）。两条字符串直接比 ⇒ 实际动过的那条**永远**盖不住声明 ⇒ 每一处改动
 *   都被判"声明不实"。归一到同一个坐标系之后，"同一个文件身份"才对得上。
 *   ⚠️ 这是**附加**判据：下面那套字符串前缀比对**原样保留**，只会少报"声明不实"，
 *      **不会**让任何一处越界改动（`unauthorized`）放行 —— 那一支一个字节没动。
 * @param {object[]} [opts.writeLedger] - ★★ **席位级写入台账**的全部行（本单的 + 别单的，
 *   由 `store` 读盘后原样传进来；见模块顶部「席位级写入台账」）
 * @param {string} [opts.writeLedgerTaskId] - 本单 id（台账里 `task_id === 它` 的行
 *   **永远不豁免本单** —— 线 ①）
 * @param {string[]} [opts.writerRoles] - 哪些角色算"编写席"（默认 `['writer']`；只影响
 *   机器产物豁免的**收回**方向，即只会更严）
 * @param {string[]} [opts.foreignAckKeys] - ★★ P1-9：**已被 store 核过**的「外来路径显式确认」
 *   （`dev_to_test.foreign_paths_ack`）的规范绝对键。命中的 touched 路径**不进本席的声明对账** ——
 *   因为它是**别的编写席位分区**里的本次变化，本席本来就不该为它背书。
 *   ⚠️ 三道护栏（由 `lib/hashgate/foreign-ack.js` 在上游落实，这里再兜一次）：
 *   ① 只由 store 核过才进得来（本函数不读 payload、不认字符串声明）；
 *   ② 对 `unauthorized` **不生效**（越界照旧拒 —— 见循环里的 `unauthorizedAckBlocked`）；
 *   ③ 删除类（拿不到哈希）**不适用**。
 * @param {object[]} [opts.foreignAck] - 与 `foreignAckKeys` 同批的可读记录
 *   `[{ path, reason, owner_seat, key }]`（用于**可见**输出与文案，不参与判定）
 * @returns {{pass:boolean, violations:object[], counts:object, summary:string}}
 */
export function hashGateVerdict(audit, manifest = [], opts = {}) {
  const violations = []
  /**
   * ★★ 归属给**别的单**的改动（不静默：逐条列出来，谁归属给了谁、凭什么）。
   * ⚠️ **按路径去重**：同一条路径可能同时被"越界"和"声明不实"两支碰到，
   *    但对人来说它只该出现一次（"这处改动是别人的"）。
   */
  const attributedForeign = []
  const attributedForeignKeys = new Set()
  const noteForeign = (path, how, extra) => {
    const k = String(path ?? '').replace(/\\/g, '/').toLowerCase()
    if (k.length === 0 || attributedForeignKeys.has(k)) return
    attributedForeignKeys.add(k)
    attributedForeign.push({ path, how, ...extra })
  }
  /**
   * ★ 声明面与改动面各自的归一化器（缺任一个就退回纯字符串比对 = 历史行为）。
   * ⚠️ 位置在**函数最前面**：它同时被 ①（越界那一支的归属判据）与 ②（声明对账）用。
   */
  const { absOfDeclared, absOfTouched } = opts
  const canAbs = typeof absOfDeclared === 'function' && typeof absOfTouched === 'function'
  const safeAbs = (fn, p) => {
    try {
      return String(fn(p) ?? '')
    } catch {
      return ''
    }
  }
  /**
   * ★★ 席位级写入台账（见模块顶部那一整段）：**只**用于两件事 ——
   *   ① 把"可证明是别的单的产物"从本单的越界/未申报里排除出去（**带哈希证据**）；
   *   ② 收回"本单编写席按哈希认领过的"机器产物豁免（这个方向只会**更严**）。
   * 台账为空 / 读不到 / 坏行 ⇒ 两个索引都是空 Map ⇒ 判定与改前**逐字相同**。
   */
  const writeLedger = Array.isArray(opts.writeLedger) ? opts.writeLedger : []
  const writeLedgerTaskId = String(opts.writeLedgerTaskId ?? '')
  const foreignWriteIndex = buildForeignWriteIndex(writeLedger, writeLedgerTaskId)
  const writerClaimIndex = buildSeatWriteIndex(writeLedger, writeLedgerTaskId, opts.writerRoles)

  /**
   * ★★ P1-9：「外来路径显式确认」的**已核过**集合（见 `lib/hashgate/foreign-ack.js`）。
   * 空集合 ⇒ 判定与改前**逐字相同**（多席并行以外的所有提交都是这一支）。
   */
  const foreignAckKeys = new Set(
    (Array.isArray(opts.foreignAckKeys) ? opts.foreignAckKeys : [])
      .map((k) => String(k ?? '').trim().toLowerCase())
      .filter((k) => k.length > 0),
  )
  const foreignAckByKey = new Map()
  for (const x of Array.isArray(opts.foreignAck) ? opts.foreignAck : []) {
    const k = String(x?.key ?? '').trim().toLowerCase()
    if (k.length > 0) foreignAckByKey.set(k, x)
  }
  /** ★ 逐条列出**按 foreign_paths_ack 排除出本席声明对账**的路径（谁归属给谁、凭什么 —— 事后可核）。 */
  const acknowledgedForeign = []

  // ① 三类越界（新增 / 修改 / 删除，只要不在授权面内）
  for (const x of Array.isArray(audit?.unauthorized) ? audit.unauthorized : []) {
    // ★★ 归属判据（见模块顶部）：这处改动**可证明是别的单的产物**（另一张单的席位
    //    声明过这条路径，且当前内容与它当时产出的哈希逐字节一致）⇒ 不算本单越界。
    //    ⚠️ 拿不到哈希（删除 / 目录 / 读不到）⇒ `foreignAttributionOf` 返回 null
    //       ⇒ 这一支与改前**逐字相同**地进 violations。
    const attr = foreignAttributionOf(
      foreignWriteIndex,
      canAbs ? safeAbs(absOfTouched, x?.path) : '',
      x?.actual_sha256 ?? null,
    )
    if (attr !== null) {
      noteForeign(x.path, x.how, {
        baseline_sha256: x.baseline_sha256 ?? null,
        actual_sha256: x.actual_sha256 ?? null,
        attributed_to: attr,
        evidence: `另一张单（${attr.task_id}）的${attr.role ?? '席位'}${attr.seat === null ? '' : `#${String(attr.seat).replace(/^[^#]*#/, '')}`}在 ${attr.at ?? '(时间未记)'} 的 ${attr.source ?? '交接物'} 里声明过这条路径，且当前内容的 sha256 与它当时产出的**逐字节一致**`,
      })
      continue
    }
    violations.push({
      how: x.how,
      zh: HOW_ZH[x.how] ?? x.how,
      path: x.path,
      baseline_sha256: x.baseline_sha256 ?? null,
      actual_sha256: x.actual_sha256 ?? null,
      expected: '要么撤回这处改动，要么让计划 AI 把该路径补进 change_scope 拿到新授权',
    })
  }

  // ② 声明不实：实际动了、但没在 change_manifest 里报
  //
  //    判据：把 changeAudit 算出的"实际动过"与 manifest 里的 path 对一遍。
  //    为什么也算不过：哈希是**真相**，声明是**承诺**；两者不一致时，
  //    测试与审核按声明去核对就等于核对了假的 —— 那比越界更危险（越界至少看得见）。
  const declared = new Set(
    (Array.isArray(manifest) ? manifest : [])
      .map((m) => String(m?.path ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase())
      .filter((p) => p.length > 0),
  )
  const touched = [
    ...(audit?.added ?? []).map((x) => ({ path: x.path, sha256: x.sha256 ?? null })),
    ...(audit?.modified ?? []).map((x) => ({ path: x.path, sha256: x.sha256 ?? null })),
    // 删除类**拿不到"当前内容"** ⇒ 没有哈希 ⇒ 归属判据对它一律返回 null（照旧拒）
    ...(audit?.removed ?? []).map((x) => ({ path: x.path, sha256: null })),
  ]
  /**
   * ★★ 「谁改的」分账（T-20261011-56a37e 追加项 ①）—— 见 `isMachineArtifactPath` 的模块注释。
   *
   * `exemptMachineArtifacts` 默认 **true**（= 排除机器产物）。
   * 传 **false** = **严格模式**（等价于改前的行为，机器产物也要求申报）——
   * 这个开关**只能收紧、不能放松**：它的默认值是"已豁免"，而 `false` 是把豁免收回去。
   * 它存在的唯一目的是让"改前 / 改后"能在**同一份真实数据**上做对照复现
   * （见 `tests/quickfix-20261013-check.mjs` 与 `tests/hashgate-check.mjs`）。
   */
  const exemptMachineArtifacts = opts.exemptMachineArtifacts !== false
  /**
   * ★ 已被判**越界**的那批路径 —— 豁免对它们**不生效**。
   *
   * 这就是"不放松闸门"的第二条硬论证：一条路径只要进了 `unauthorized`，
   * 它就**永远**不会被机器产物豁免吞掉 ⇒ 豁免在数学上不可能掩盖任何越界改动。
   *
   * ⚠️ ★ 构造它用的是**原始**越界清单（`audit.unauthorized`），**不是**被归属判据
   *    排除之后剩下的那份 —— 这个选择是刻意的：一条越界路径即使可证明是别的单的产物，
   *    也**不该**顺带获得"机器产物豁免"的资格（两套豁免各管各的，不叠加）。
   */
  const unauthorizedKeys = new Set(
    (Array.isArray(audit?.unauthorized) ? audit.unauthorized : []).map((x) =>
      String(x?.path ?? '').replace(/\\/g, '/').toLowerCase(),
    ),
  )
  /**
   * ★ P1-9 的护栏 ②：**越界路径绝不能被归属确认排除**（越界判据不因归属放宽）。
   * 与 ack 用**同一个坐标系**（`absOfTouched`）再算一遍 —— store 上游已经拦过，这里是判定层的兜底。
   */
  const unauthorizedAbsKeys = new Set(
    (Array.isArray(audit?.unauthorized) ? audit.unauthorized : [])
      .map((x) => (canAbs ? safeAbs(absOfTouched, x?.path) : ''))
      .filter((k) => k.length > 0),
  )
  const ignoredMachineArtifacts = []
  /** ★ 被**收回**豁免的机器产物（本单编写席按哈希认领过它 —— 只会更严，不静默）。 */
  const withdrawnMachineArtifacts = []
  for (const item of touched) {
    const p = item.path
    const key = String(p).replace(/\\/g, '/').toLowerCase()
    const tKey = canAbs ? safeAbs(absOfTouched, p) : ''
    // ★★ 归零：这处改动**可证明是别的单的产物** ⇒ 不进本单的声明对账（见模块顶部）。
    const foreign = foreignAttributionOf(foreignWriteIndex, tKey, item.sha256)
    if (foreign !== null) {
      noteForeign(p, 'attributed_foreign', {
        baseline_sha256: null,
        actual_sha256: item.sha256,
        attributed_to: foreign,
        evidence: `另一张单（${foreign.task_id}）在 ${foreign.at ?? '(时间未记)'} 的 ${foreign.source ?? '交接物'} 里声明过这条路径，且当前内容的 sha256 与它当时产出的**逐字节一致**`,
      })
      continue
    }
    // ★★ P1-9：**本席显式确认过归属别的编写席位**的路径 ⇒ 不进本席的声明对账。
    //    三道前提：拿到哈希（只对新增/修改；删除类不适用）、不在越界清单、在已核过的 ack 集合里。
    if (item.sha256 !== null && tKey.length > 0 && foreignAckKeys.has(tKey) && !unauthorizedAbsKeys.has(tKey)) {
      const acked = foreignAckByKey.get(tKey) ?? null
      acknowledgedForeign.push({
        path: p,
        reason: typeof acked?.reason === 'string' ? acked.reason : '',
        owner_seat: acked?.owner_seat ?? null,
      })
      continue
    }
    // ★ 机器产物豁免：**只对"没被判越界"的路径生效**（见上面那段注释）。
    if (exemptMachineArtifacts && !unauthorizedKeys.has(key) && isMachineArtifactPath(p)) {
      // ★★ 归属判据对**豁免本身**的收紧（P1-5 的残余风险）：这条机器产物若**本单编写席
      //    按哈希认领过**（它在自己某次 `dev_to_test` 里声明过这条路径，且当前内容与
      //    那次产出的哈希一致），那它就不是"测试台自己写的运行产物"，而是**编写的产物**
      //    ⇒ 豁免**收回**，落回下面的"声明不实"对账。**只会更严，不会更松**。
      //    再加一条（同样只会更严）：本单编写席**用写类工具真的写过**它（守门放行观察行）
      //    ⇒ 即使从没申报过，也不是测试台的运行产物 ⇒ 豁免收回。
      const claim = seatClaimOf(writerClaimIndex, tKey, item.sha256)
      const touch = claim === null ? seatTouchOf(writerClaimIndex, tKey) : null
      if (claim === null && touch === null) {
        ignoredMachineArtifacts.push({ path: p, why: '机器产物（测试台自己写的运行产物）：不属于任何席位，不该逼谁为它背书' })
        continue
      }
      const who = (c) => `**本单的${c.role}${c.seat === null ? '' : `（${c.seat}）`}**`
      withdrawnMachineArtifacts.push({
        path: p,
        why: claim !== null
          ? `这条路径被${who(claim)}在 ${claim.at ?? '(时间未记)'} 声明过，且当前内容的 sha256 与那次产出的**逐字节一致** ⇒ 它不是"测试台自己写的运行产物"，豁免收回`
          : `这条路径被${who(touch)}在 ${touch.at ?? '(时间未记)'} 用写类工具写过（守门放行留痕 ${GUARD_WRITE_ALLOWED_SOURCE}）⇒ 它不是"测试台自己写的运行产物"，豁免收回`,
      })
    }
    // 目录级声明（授权的是一个目录）也算覆盖到了里面
    let covered = [...declared].some((d) => key === d || key.startsWith(`${d}/`) || d.startsWith(`${key}/`))
    // ★ 修 ③：字符串比不过时，再按**规范绝对键**比一次（同一文件身份就算覆盖到）。
    if (!covered && canAbs) {
      const tAbs = safeAbs(absOfTouched, p)
      if (tAbs.length > 0) {
        covered = (Array.isArray(manifest) ? manifest : []).some((m) => {
          const dAbs = safeAbs(absOfDeclared, m?.path)
          return dAbs.length > 0 && (dAbs === tAbs || dAbs.startsWith(`${tAbs}/`) || tAbs.startsWith(`${dAbs}/`))
        })
      }
    }
    if (!covered) {
      violations.push({
        how: 'undeclared_change',
        zh: HOW_ZH.undeclared_change,
        path: p,
        baseline_sha256: null,
        actual_sha256: null,
        expected:
          '把这处改动补进 change_manifest（path / action / scope_id）再提交；' +
          '若它不是本席改的（别的编写席位先写进了工作区）⇒ 用 foreign_paths_ack 显式确认归属他人（见下方说明），别写假账',
      })
    }
  }

  const counts = {
    added: audit?.counts?.added ?? (audit?.added ?? []).length,
    modified: audit?.counts?.modified ?? (audit?.modified ?? []).length,
    removed: audit?.counts?.removed ?? (audit?.removed ?? []).length,
    // ★ 剩下的越界处数 = 原始越界数 − 可证明是**别的单**的产物那部分（前者在 audit 里）
    unauthorized: violations.filter((x) => x.how !== 'undeclared_change').length,
    undeclared: violations.filter((x) => x.how === 'undeclared_change').length,
    /** ★ 被豁免的机器产物条数（**不静默**：豁免了什么都看得见）。 */
    machine_artifacts: ignoredMachineArtifacts.length,
    /** ★ 归属给**别的单**、因而不计入本单的改动处数（P2-13 的那个病：不静默，可核）。 */
    attributed_foreign: attributedForeign.length,
    /** ★ 被**收回**机器产物豁免的条数（本单编写席按哈希认领过 —— 更严，也要看得见）。 */
    machine_artifacts_withdrawn: withdrawnMachineArtifacts.length,
    /** ★★ P1-9：按 `foreign_paths_ack` 显式确认归属别的编写席位、因而不计入本席声明对账的条数。 */
    foreign_paths_acked: acknowledgedForeign.length,
  }
  return {
    pass: violations.length === 0,
    violations,
    counts,
    /** ★ 逐条列出被豁免的路径（审计与交付说明直接引用这一栏，不靠 summary 措辞）。 */
    ignored_machine_artifacts: ignoredMachineArtifacts,
    /** ★★ 逐条列出**归属给别的单**的改动（谁归属给了谁、凭什么 —— 事后可核）。 */
    attributed_foreign: attributedForeign,
    /** ★★ P1-9：逐条列出**本席显式确认归属别的编写席位**的路径（理由与归属席位一并留档）。 */
    acknowledged_foreign: acknowledgedForeign,
    /** ★ 逐条列出**被收回豁免**的机器产物。 */
    withdrawn_machine_artifacts: withdrawnMachineArtifacts,
    summary:
      violations.length === 0
        ? `哈希对比通过：新增 ${counts.added} · 修改 ${counts.modified} · 删除 ${counts.removed}，全部落在授权面内` +
          (counts.machine_artifacts > 0
            ? `（另有机器产物 ${counts.machine_artifacts} 条不计入声明对账：${ignoredMachineArtifacts.map((x) => x.path).join('、')}）`
            : '') +
          (counts.attributed_foreign > 0
            ? `（另有 ${counts.attributed_foreign} 处改动**可证明是别的单的产物**，不计入本单：${attributedForeign.map((x) => `${x.path}→${x.attributed_to.task_id}`).join('、')}）`
            : '') +
          (counts.foreign_paths_acked > 0
            ? `（另有 ${counts.foreign_paths_acked} 处已按 foreign_paths_ack **显式确认归属别的编写席位**，不计入本席：${acknowledgedForeign.map((x) => `${x.path}→${x.owner_seat ?? '别的席位'}`).join('、')}）`
            : '')
        : `哈希对比**不通过**：越界 ${counts.unauthorized} 处 · 声明不实 ${counts.undeclared} 处` +
          (counts.machine_artifacts > 0 ? `（机器产物 ${counts.machine_artifacts} 条已排除在声明对账之外）` : '') +
          (counts.attributed_foreign > 0
            ? `（**已排除** ${counts.attributed_foreign} 处可证明是别的单的产物，未计入你头上）`
            : '') +
          (counts.foreign_paths_acked > 0
            ? `（**已排除** ${counts.foreign_paths_acked} 处按 foreign_paths_ack 确认归属别的编写席位的路径，未计入你头上）`
            : '') +
          (counts.machine_artifacts_withdrawn > 0
            ? `（另有 ${counts.machine_artifacts_withdrawn} 条机器产物**豁免被收回** —— 它们其实是本单编写的产物：${withdrawnMachineArtifacts.map((x) => x.path).join('、')}）`
            : ''),
  }
}

/**
 * ★ **打回理由必须可执行**：列出越界/失配的文件、基线哈希、实际哈希、期望是什么。
 * 让编写一眼知道该改哪儿 —— 而不是收到一句"你的改动不合规"。
 *
 * @param {object} input
 * @param {object} input.verdict - hashGateVerdict 的结果
 * @param {object} input.audit - changeAudit 的结果
 * @param {object[]} input.scope - task.change_scope
 * @param {object|null} input.baseline - 当前基线
 * @returns {string}
 */
export function renderGateRejection({ verdict, audit, scope, baseline, streak = null, threshold = null, escalation = null }) {
  const L = []
  L.push('拒绝提交（**哈希前置闸门**）：实际改动面与授权面/声明对不上，**直接打回编写**。')
  L.push('')
  L.push(`基线：${baseline?.baseline_id ?? '(无)'}（${baseline?.file_count ?? 0} 个文件，记于 ${baseline?.taken_at ?? '-'}）`)
  L.push(`判定：${verdict.summary}`)
  L.push('')
  L.push('**要改哪里**（逐条给出证据）：')
  for (const v of verdict.violations.slice(0, 20)) {
    L.push(`  · ${v.zh}：${v.path}`)
    if (v.baseline_sha256 !== null || v.actual_sha256 !== null) {
      L.push(`      基线哈希：${v.baseline_sha256 ?? '(基线里没有这个文件)'}`)
      L.push(`      实际哈希：${v.actual_sha256 ?? '(现在没有这个文件)'}`)
    }
    L.push(`      期望：${v.expected}`)
  }
  if (verdict.violations.length > 20) L.push(`  …（还有 ${verdict.violations.length - 20} 处，见审计记录 gate:hash）`)
  // ★★ P1-9：多编写席位并行时，「别的席位先写进工作区」是**正常节奏**（先干完先交），
  //    那些文件在本席的 change_manifest 里**本来就不该有**（写进去才是假账）。
  //    所以打回文案必须给出这条正路 —— 否则编写只会反复补假声明，越补越错。
  if (verdict.violations.some((v) => v.how === 'undeclared_change')) {
    L.push('')
    L.push('★ 其中「动了但没在改动声明里报」的那些，**先分清是谁改的**：')
    L.push('  · **本席自己**改的 ⇒ 补进 change_manifest（path / action / scope_id）；')
    L.push('  · **别的编写席位**先写进工作区的（多席并行）⇒ **别写进你的 change_manifest**（那是假账），')
    L.push('    在本次 dev_to_test 的 payload 里加一次显式确认：')
    L.push('      `foreign_paths_ack: [{ path: "上面的路径", reason: "属于 writer#X 的分区，本席未改动" }]`')
    L.push('    它只对「**别的编写席位分区内** + **本次确实有变化**」的路径生效；本席自己分区的改动、越界改动都确认不了。')
  }
  // ★★ 归属判据的**可见面**：已经按席位级写入台账排除掉的那批（可证明是别的单的产物）。
  //    为什么必须列出来：不静默是这套机制的一贯要求 —— 编写要能看见"哪些**不是**它的活"，
  //    否则它会去撤回别人的改动（那是它做不到的事）。
  if (Array.isArray(verdict.attributed_foreign) && verdict.attributed_foreign.length > 0) {
    L.push('')
    L.push(`★ **已按席位级写入台账排除 ${verdict.attributed_foreign.length} 处**（可证明是**别的单**的产物，不计入你头上）：`)
    for (const x of verdict.attributed_foreign.slice(0, 10)) {
      L.push(`  · ${x.path} —— 属于 ${x.attributed_to?.task_id ?? '?'}（${x.attributed_to?.role ?? '席位'}${x.attributed_to?.seat === null || x.attributed_to?.seat === undefined ? '' : ` ${x.attributed_to.seat}`}）`)
    }
    if (verdict.attributed_foreign.length > 10) L.push(`  …（还有 ${verdict.attributed_foreign.length - 10} 处）`)
    L.push('  判据：另一张单的席位在自己的交接物里声明过这条路径，**且当前内容的哈希与它当时产出的逐字节一致**。')
  }
  // ★★ P1-9：本席按 `foreign_paths_ack` **显式确认归属别的编写席位**、因而不计入本席的路径。
  //    必须列出来的理由与上一条同源：编写要能看见"哪些**不是**它的活"，否则它会去撤回别人的改动。
  if (Array.isArray(verdict.acknowledged_foreign) && verdict.acknowledged_foreign.length > 0) {
    L.push('')
    L.push(`★ **已按你的 foreign_paths_ack 排除 ${verdict.acknowledged_foreign.length} 处**（显式确认属于别的编写席位，不计入本席的声明对账）：`)
    for (const x of verdict.acknowledged_foreign.slice(0, 10)) {
      L.push(`  · ${x.path}${x.owner_seat === null || x.owner_seat === undefined ? '' : ` —— 属于 ${x.owner_seat} 的分区`}（理由：${x.reason || '(未写)'}）`)
    }
    if (verdict.acknowledged_foreign.length > 10) L.push(`  …（还有 ${verdict.acknowledged_foreign.length - 10} 处）`)
    L.push('  判据：路径**本次确实有变化**、落在**别的编写席位分区**内、且不在越界清单里（本席自己分区的改动确认不了）。')
  }
  // ★ 机器产物豁免**被收回**的那些（它们其实是本单编写的产物）—— 也要看得见。
  if (Array.isArray(verdict.withdrawn_machine_artifacts) && verdict.withdrawn_machine_artifacts.length > 0) {
    L.push('')
    L.push(`★ **机器产物豁免已收回 ${verdict.withdrawn_machine_artifacts.length} 条**（它们不是测试台的运行产物，而是本单的产物）：`)
    for (const x of verdict.withdrawn_machine_artifacts.slice(0, 10)) L.push(`  · ${x.path} —— ${x.why}`)
  }
  L.push('')
  L.push('**本次授权改动面**（计划给的，超出即越界）：')
  L.push(...(Array.isArray(scope) && scope.length > 0 ? scope.map((e) => `  · ${e.id} ${e.action} ${e.path}（${e.why}）`) : ['  （无）']))
  L.push('')
  L.push('**实测明细**（哈希比对结果）：')
  L.push(`  新增 ${verdict.counts.added} · 修改 ${verdict.counts.modified} · 删除 ${verdict.counts.removed}`)
  for (const x of (audit?.added ?? []).slice(0, 10)) L.push(`  + ${x.path}  ${x.sha256 ?? ''}`)
  for (const x of (audit?.modified ?? []).slice(0, 10)) L.push(`  ~ ${x.path}  ${x.sha256 ?? ''}`)
  for (const x of (audit?.removed ?? []).slice(0, 10)) L.push(`  - ${x.path}`)
  L.push('')
  L.push('★ **测试没有被触发** —— 这次提交根本没进测试，也**没有消耗测试预算**，')
  L.push('  更不需要走"是否跑全量"的审批链。修好改动面再交即可。')
  L.push('★ 不合格的提交不该消耗测试资源：让测试去跑一套注定被打回的产物，是纯浪费。')
  L.push('')
  // --- ★ 连续不过的计数与自动升级（P13 的结论）-----------------------------
  if (Number.isInteger(streak) && Number.isInteger(threshold) && threshold > 0) {
    L.push(`★ **连续不通过计数：${streak} / ${threshold}**（一次通过就归零；撤回越界改动**不**归零）。`)
    if (escalation?.escalated === true) {
      L.push('')
      L.push(`★★ 已到阈值 ⇒ **机制自动交人工**：这件事不再由编写反复重交，改由用户拍板。`)
      L.push(`  人工请求：${escalation.request_id ?? '(见 task.human_requests)'}（由 ${escalation.from_role ?? '?'} 发起，第 ${escalation.round ?? 1} 次升级）`)
      L.push('  任务已推进到「等待人工答复」。**在用户答复之前，本任务的再次提交会被直接拒收** ——')
      L.push('  这不是提醒，是拒收（`HASH_GATE_ESCALATED`）：机制不许无限重交。')
      L.push('  人工那一站走的是**既有**的 human_request / 两级梯（发起 → 主对话转告 → 用户答复 → 恢复），')
      L.push('  答复仍然必须带来源与用户本人的原话。')
    } else if (escalation?.escalated === false && escalation.reason === 'request_denied') {
      L.push(`⚠ 本轮本该自动交人工，但那条 human_request 没发出去（${escalation.error ?? '见审计 gate:hash_escalate_failed'}）。`)
      L.push('  已记入审计；下一次不通过时会再试一次。')
    } else {
      L.push(`（离自动交人工还差 ${Math.max(0, threshold - streak)} 次；到了就由机制直接交人工，不需要谁去申请。）`)
    }
  }
  L.push('')
  L.push('两条出路：① 撤回越界改动（或被删的文件找回来）；② 真需要扩大范围 →')
  L.push('  走澄清/变更（pipeline_clarify_request 或 pipeline_roster_request），拿到**新授权**再交。')
  return L.join('\n')
}
