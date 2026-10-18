// 哈希前置闸门 · 外来路径显式确认（P1-9）：多编写席位并行时，别的席位先写进工作区的变化，不该算成本席"未申报"。
/**
 * dsh-pipeline · 哈希前置闸门 · **外来路径显式确认**（`foreign_paths_ack`）
 * ============================================================================
 * P1-9（`内部复盘（2026-10-18，不公开）`）：
 *
 *   多编写席位并行时，`dev_to_test` 的哈希闸门拿「**基线以来**的全部变化」去对本席的
 *   `change_manifest` —— 于是**别的席位先写进工作区**的文件（新增/修改）就成了本席的
 *   "未申报"（`undeclared_change`）。实测 writer#2 连续被误判；闸门"连续 3 次不过 ⇒ 机制
 *   自动交人工"那条还会把整张任务推到「已阻塞」—— 一次**归属误报**变成一次**停机**。
 *
 *   根因一句话：`changeAudit` 只知道"变了什么"，**不知道是谁改的**；而声明对账却按本席算。
 *
 * ---------------------------------------------------------------------------
 * 这个模块做什么（纯判据、无 IO）
 * ---------------------------------------------------------------------------
 *   编写可以在 `dev_to_test` 的 payload 里给一次**显式确认**：
 *
 *     foreign_paths_ack: [{ path: "src/web/index.js", reason: "属于 writer#1 的分区，本席未改动" }]
 *
 *   本模块回答的**唯一问题**：这些被点名的路径，够不够格从「本席的声明对账」里排除出去。
 *   （排除之后，`hashGateVerdict` 会把它记进 `acknowledged_foreign` —— **不静默**，可审计。）
 *
 * ---------------------------------------------------------------------------
 * 五条硬判据（全部满足才算"够格"；任一条不满足 ⇒ 整次提交被拒，并给可操作文案）
 * ---------------------------------------------------------------------------
 *   ① **本次真有变化**：路径必须出现在 `changeAudit` 的 `added` / `modified` 里。
 *      —— ack 是对"眼前这处变化"的署名，不是提前买保险；点了一堆没变化的路径 ⇒ 拒。
 *   ② **不是本席的分区**：路径落在本席 `writers.partitions[].scope_paths` 内 ⇒ 拒。
 *      —— 否则 ack 就是"把自己的改动洗成别人的"的万能洗白口，核心判据被掏空。
 *   ③ **是别的编写席位的分区**：必须落在**另一个在册编写席位**的 `scope_paths` 内 ⇒ 否则拒。
 *      —— 这让"归属给谁"有一个**具体对象**，而不是一句"反正不是我的"。
 *   ④ **不在越界清单里**：路径若进了 `changeAudit.unauthorized` ⇒ 拒。
 *      —— ack 只调整「声明对账」的归属，**一个字都不碰越界判据**：授权面之外的改动照旧拒。
 *   ⑤ **删除类不适用**：删除拿不到"当前内容哈希"，没有可核对的归属，不在本机制范围（照旧按未申报判）。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么这不算放宽（三条可机械复核的论证）
 * ---------------------------------------------------------------------------
 *   ① **越界那一支一个字节没动**：`unauthorized` 仍由授权面算出；判据 ④ 明确把越界路径拒在门外。
 *   ② **核心判据（本席自己分区的改动没申报）不可能被 ack 覆盖** —— 判据 ② 就是拦它的。
 *   ③ **没写 ack 的提交走到的判据与改前逐字相同**：`hashGateVerdict` 的默认行为没变，
 *      ack 是**附加**输入（`foreignAckKeys`），不改变原有任何一支。
 *
 * ---------------------------------------------------------------------------
 * ★ 残余风险（如实写出来）
 * ---------------------------------------------------------------------------
 *   ack 是**本席的显式确认**，不是"作者身份"的密码学证明 —— 若某席绕过守门用 shell 往
 *   **别人的分区**里写了东西，它能把那处改动 ack 成别人的。这是"显式确认"这一档的已知代价。
 *   缓解三条：
 *     ① 路径必须落在**别人的分区**内，且必须**本次真有变化**（判据 ①②③）；
 *     ② ack 逐条进 `verdict.acknowledged_foreign` 与 `gate:hash` 审计 —— **不静默**，事后可核；
 *     ③ 守门侧对 `write` / `edit` 有「跨分区写入」拦截（`lib/guard/decide.js` 2b）；
 *        ⚠️ shell 写入那条是 **best-effort 字符串判据**（`lib/guard/shell.js` 自己注明的），
 *        不是按分区精确执法 —— "用 shell 往别人分区写、再 ack 成别人的"这条越过守门的路径
 *        就是本机制**剩下**的残余风险；它留下的每一条 ack 记录都带路径 + 理由，事后可核。
 *
 * ---------------------------------------------------------------------------
 * 落点（一处判据，一圈接线）
 * ---------------------------------------------------------------------------
 *   字段表   `lib/model/handoff-schemas.js` 的 `dev_to_test.foreign_paths_ack`
 *   形状校验 `lib/handoff/validate.js`（逐条 path/reason、上限、不许通配）
 *   接线     `lib/store/seat-checks.js` 的 `checkForeignPathsAck` ← `lib/store/submit.js`
 *   判定     `lib/hashgate/verdict.js`（把 `foreignAckKeys` 命中的 touched 排除出声明对账）
 *
 * @module dsh-pipeline/lib/hashgate/foreign-ack
 */

/** 一次提交最多能确认多少条外来路径（防"扫一片"式的一揽子声明）。 */
export const FOREIGN_ACK_MAX = 50

/**
 * 判据码（调用方 / 测试按它分流；**值即字符串本身**，与其它判据码同一口径）。
 *
 * 每个码都对应**一条独立的拒绝理由** —— 不合并：编写看到码就知道该改哪一处
 * （"洗自己的"和"确认没变化的路径"是两种完全不同的错误）。
 */
export const FOREIGN_ACK_CODES = Object.freeze({
  /** 点名的路径落在**本席**的分区里 —— 不能把自己的改动确认成别人的。 */
  OWN_PARTITION: 'FOREIGN_PATH_ACK_OWN_PARTITION',
  /** 点名的路径**不在任何别的编写席位**的分区里 —— 没有可归属的对象。 */
  NOT_FOREIGN: 'FOREIGN_PATH_ACK_NOT_FOREIGN',
  /** 点名的路径**本次相对基线没有变化** —— ack 不是提前买保险。 */
  UNCHANGED: 'FOREIGN_PATH_ACK_UNCHANGED',
  /** 点名的路径**授权面之外**（越界）—— ack 不能给越界改动背书。 */
  OUT_OF_SCOPE: 'FOREIGN_PATH_ACK_OUT_OF_SCOPE',
  /** 本任务没有**别的编写席位**（单席位 / 分区表缺失）—— 没有"外来路径"可确认。 */
  NO_OTHER_SEAT: 'FOREIGN_PATH_ACK_NO_OTHER_SEAT',
  /** 路径解析不出来（空串 / 目录 / 通配这类形状问题由 `validate.js` 先拦，这里兜底）。 */
  BAD_PATH: 'FOREIGN_PATH_ACK_BAD_PATH',
})

/** 路径归一化器缺失时的内部错误码（装配错误；不静默，按拒绝处理）。 */
const BAD_INPUT = 'FOREIGN_PATH_ACK_BAD_INPUT'

const uniq = (list) => {
  const out = []
  for (const x of list) {
    const s = String(x ?? '')
    if (s.length > 0 && !out.includes(s)) out.push(s)
  }
  return out
}

const safe = (fn, p) => {
  try {
    return String(fn(p) ?? '')
  } catch {
    return ''
  }
}

const renderEntry = (x) =>
  `  · ${x.path}${x.owner_seat === undefined || x.owner_seat === null ? '' : `（${x.owner_seat} 的分区）`}` +
  (x.errors.length > 0 ? `\n      ${x.errors.join('\n      ')}` : '')

/**
 * 核一次「外来路径显式确认」。
 *
 * @param {object} input
 * @param {object[]} input.ack - `dev_to_test.foreign_paths_ack`（形状已由 `validate.js` 归一化）
 * @param {string} [input.seat] - 本席的席位 id（`writer#2` …；缺省按在册第一席）
 * @param {string[]} input.seats - 本任务在册的编写席位（`writers.partitions[].seat`）
 * @param {(seat:string)=>object|null} input.partitionOf - 席位 → 分区（要 `scope_paths`）
 * @param {object} input.audit - `store.changeAudit()` 的结果（`added` / `modified` / `unauthorized`）
 * @param {(p:string)=>string} input.absOfDeclared - 声明面路径 → 规范绝对键（授权面坐标系）
 * @param {(p:string)=>string} input.absOfTouched - 审计路径 → 规范绝对键（基线坐标系）
 * @param {(root:string,child:string)=>boolean} input.isInside - `util.isInside`
 * @returns {{ok:true, keys:string[], entries:object[]} | {ok:false, code:string, error:string}}
 *   `ok:true` 时：`keys` = 可排除出声明对账的规范绝对键；`entries` = 逐条可读记录
 *   （`path` 审计里的相对路径 · `reason` 编写的理由 · `owner_seat` 归属的别的席位 · `key`）。
 */
export function vetForeignPathsAck(input = {}) {
  const ack = Array.isArray(input.ack) ? input.ack : []
  const empty = { ok: true, keys: [], entries: [] }
  if (ack.length === 0) return empty

  // --- 装配检查：判据需要的三样东西缺一个都不能"猜" ---------------------------
  const { absOfDeclared, absOfTouched, isInside, partitionOf } = input
  if (
    typeof absOfDeclared !== 'function' ||
    typeof absOfTouched !== 'function' ||
    typeof isInside !== 'function' ||
    typeof partitionOf !== 'function'
  ) {
    return {
      ok: false,
      code: BAD_INPUT,
      error: '外来路径确认判据装配不全（缺路径归一化器或分区查询）—— 这是插件内部错误，按拒绝处理，不猜。',
    }
  }

  // --- 本席 / 别的编写席位的**分区范围**（判据 ②③ 的落点）-------------------
  const seats = (Array.isArray(input.seats) ? input.seats : []).map(String).filter((s) => s.length > 0)
  const selfSeat = String(input.seat ?? '').trim() || (seats[0] ?? '')
  const scopeKeysOf = (seat) => {
    const part = partitionOf(seat)
    const paths = Array.isArray(part?.scope_paths) ? part.scope_paths : []
    return uniq(paths.map((p) => (typeof p === 'string' ? p.trim() : '')).map((p) => (p.length === 0 ? '' : safe(absOfDeclared, p))))
  }
  const ownKeys = scopeKeysOf(selfSeat)
  const otherSeats = seats.filter((s) => s !== selfSeat).map((s) => ({ seat: s, keys: scopeKeysOf(s) }))
  const otherWithScope = otherSeats.filter((x) => x.keys.length > 0)

  if (otherWithScope.length === 0) {
    return {
      ok: false,
      code: FOREIGN_ACK_CODES.NO_OTHER_SEAT,
      error:
        `**外来路径确认不成立**（foreign_paths_ack）：本任务没有**别的编写席位**可归属` +
        `（在册编写席位：${seats.length > 0 ? seats.join('、') : '(无)'}；本席=${selfSeat || '(未知)'}）。\n` +
        '★ `foreign_paths_ack` 只用来声明「这处变化属于**另一个编写席位**的分区」—— 单席位任务里没有这种对象。\n' +
        '  如果这处变化确实不是你改的：让计划 AI 把席位/分区补上（`pipeline_roster_request` → `pipeline_roster_review`），' +
        '或者由主对话重取一次基线（`pipeline_change_audit { take: true }`）把别人的产物划进新起点。\n' +
        '  如果它就是你改的：把它补进你自己的 `change_manifest`（path / action / scope_id）。',
    }
  }

  // --- 本次真实变化 + 越界清单（判据 ①④ 的落点）------------------------------
  const audit = input.audit !== null && typeof input.audit === 'object' ? input.audit : {}
  const changed = []
  for (const x of [...(Array.isArray(audit.added) ? audit.added : []), ...(Array.isArray(audit.modified) ? audit.modified : [])]) {
    const rel = String(x?.path ?? '')
    if (rel.length === 0) continue
    const keys = uniq([safe(absOfTouched, rel), safe(absOfDeclared, rel)])
    if (keys.length === 0) continue
    changed.push({
      path: rel,
      keys,
      key: safe(absOfTouched, rel) || keys[0],
      sha256: typeof x?.sha256 === 'string' && x.sha256.length > 0 ? x.sha256.toLowerCase() : null,
    })
  }
  const unauthorizedKeys = new Set(
    (Array.isArray(audit.unauthorized) ? audit.unauthorized : []).flatMap((x) => uniq([safe(absOfTouched, x?.path), safe(absOfDeclared, x?.path)])),
  )

  // --- 逐条核（五条判据；错误**一次列全**，不让编写逐条试错）-------------------
  const out = { ok: true, keys: [], entries: [] }
  const failed = []
  const seenKeys = new Set()
  /** 第一条失败判据的码（返回给调用方分流用；`null` = 还没有失败）。 */
  let firstCode = null
  for (const [i, raw] of ack.entries()) {
    const path = typeof raw?.path === 'string' ? raw.path.trim() : ''
    const reason = typeof raw?.reason === 'string' ? raw.reason.trim() : ''
    const errors = []
    let code = null

    if (path.length === 0) {
      code = FOREIGN_ACK_CODES.BAD_PATH
      errors.push('path 是空的 —— 外来路径确认必须逐条点名具体文件。')
    } else {
      const cand = uniq([safe(absOfTouched, path), safe(absOfDeclared, path)])
      // ② 不是本席的分区（**先判这条**：它挡的正是"洗自己的改动"）
      const inOwn = cand.some((k) => ownKeys.some((sk) => isInside(sk, k)))
      // ③ 是别的编写席位的分区
      const owner = otherWithScope.find((o) => cand.some((k) => o.keys.some((sk) => isInside(sk, k))))
      // ① 本次真有变化
      const hit = changed.find((c) => c.keys.some((k) => cand.includes(k)))
      // ④ 不在越界清单里
      const hitKeys = hit === undefined ? [] : uniq([safe(absOfTouched, hit.path), safe(absOfDeclared, hit.path)])
      const outOfScope = hitKeys.some((k) => unauthorizedKeys.has(k))

      if (!inOwn && owner === undefined) {
        code = FOREIGN_ACK_CODES.NOT_FOREIGN
        errors.push('它不在**任何别的编写席位**的分区里 —— 外来路径确认只对"别的编写席位分区内"的变化生效。')
      } else if (inOwn) {
        code = FOREIGN_ACK_CODES.OWN_PARTITION
        errors.push('它落在**本席自己的分区**里 —— 不能把自己的改动确认成别人的。')
      } else if (hit === undefined) {
        code = FOREIGN_ACK_CODES.UNCHANGED
        errors.push('它**本次相对基线没有变化** —— 外来路径确认只对"本次确实变了"的路径有意义（不是提前买保险）。')
      } else if (outOfScope) {
        code = FOREIGN_ACK_CODES.OUT_OF_SCOPE
        errors.push('它在**授权面之外**（越界改动）—— 外来路径确认**不能**给越界改动背书；越界只能撤回或拿到新授权。')
      } else {
        // 全部通过 —— 只把 **hit 那条审计路径的规范键**交给判定层（同一个坐标系）。
        if (!seenKeys.has(hit.key)) {
          seenKeys.add(hit.key)
          out.keys.push(hit.key)
          out.entries.push({ path: hit.path, reason, owner_seat: owner.seat, key: hit.key })
        }
        continue
      }
    }
    failed.push({ path: path.length > 0 ? path : `(空路径 #${i + 1})`, owner_seat: null, errors })
    if (firstCode === null) firstCode = code
  }

  if (failed.length > 0) {
    const shown = failed.slice(0, 10)
    const more = failed.length > shown.length ? `\n  …（还有 ${failed.length - shown.length} 条，未展开）` : ''
    return {
      ok: false,
      code: firstCode ?? FOREIGN_ACK_CODES.BAD_PATH,
      error:
        '**外来路径确认不成立**（foreign_paths_ack）：下面这些点名确认不能成立 ——\n' +
        showOwnerHint() +
        shown.map(renderEntry).join('\n') +
        more +
        '\n\n★ 规则（五条，缺一不可）：\n' +
        '  ① 路径必须**本次真有变化**（出现在改动审计的 added/modified 里，是"眼前这处变化"的署名，不是提前买保险）；\n' +
        '  ② 路径**不能在本席自己的分区**里（否则就是把自己的改动洗成别人的）；\n' +
        '  ③ 路径必须是**别的编写席位的分区**（归属要有一个具体对象）；\n' +
        '  ④ 路径**不能是越界改动**（授权面之外的改动照旧拒，ack 不碰越界判据）；\n' +
        '  ⑤ 删除类的改动拿不到哈希证据，不在本机制范围内（照旧按未申报判）。\n' +
        '下一步：\n' +
        '  · 是你自己改的 ⇒ 补进 `change_manifest`（path / action / scope_id）；\n' +
        '  · 确实是别的编写席位先写进工作区的 ⇒ 把**那条审计路径**原样点名，并写清理由（例如"属于 writer#1 的分区，本席未改动"）；\n' +
        '  · 只是想"先确认一片" ⇒ 不行：ack 不是通配，必须逐条点名本次真有变化的路径。',
    }
  }
  return out

  /** 出错时把"本席是什么范围、别的席位是什么范围"一并给出（编写不用去猜自己的分区）。 */
  function showOwnerHint() {
    const own = ownKeys.length === 0 ? '(未配置 scope_paths)' : ownKeys.join('、')
    const others = otherWithScope.map((o) => `${o.seat}: ${o.keys.join('、') || '(无)'}`).join('；')
    return `本席（${selfSeat || '(未知)'}）的分区：${own}\n别的编写席位分区：${others || '(无)'}\n\n`
  }
}
