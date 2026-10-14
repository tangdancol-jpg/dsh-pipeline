/**
 * 四槽的**证据等级** —— 每一槽「我们凭什么说它生效了」。
 *
 * ★ 为什么需要它（缺陷 F11，用户的原话）：
 *   「派活输出里的『读回核对一致』到底是不是真的在读会话头？」
 *   逐个槽的答案**不一样**，而改前文案把它们**说成了同一件事**：
 *
 *   | 槽 | 改前实际做了什么 | 该说成什么 |
 *   | --- | --- | --- |
 *   | `mode`       | `create({agentPreset})` 之后读会话头 `meta.agentPreset` 并**比对**，不符就拒绝派活 | **真读回** |
 *   | `permission` | `permissionPresets.current(session)` 读回并**比对**，不符就拒绝派活；接口不在时 `readback=null` | **真读回**（接口不在 = 未读回，须明说） |
 *   | `model`      | 只调 `selectModel`，**从不回读**；`selectModel` 没抛错就算成功 | **已请求·未回读** |
 *   | `reasoning`  | 同 `model`（塞在同一个 `selectModel` 调用里） | **已请求·未回读** |
 *
 *   ⇒ 所以"读回核对一致"这四个字对 `mode`/`permission` 是真话，对 `model`/`reasoning`
 *     **没有依据**。本模块把这件事变成**结构化的字段**（而不是散落在文案里），
 *     好让测试钉住它、让渲染不可能再含混过去。
 *
 * ★ 一条铁律：**没有读回来的值，任何地方都不许写成"一致"。**
 *   `EVIDENCE.REQUESTED` 的槽，`effective` 恒为 `null` —— 结构上就写不出"一致"。
 */

/** 证据等级。 */
export const EVIDENCE = Object.freeze({
  /** 真读回：从宿主读到了值（并且调用方会拿它跟请求值比对）。 */
  READBACK: 'readback',
  /** 想读回，但宿主没给这个接口 ⇒ **未读回**（如实登记，不当作通过）。 */
  READBACK_UNAVAILABLE: 'readback_unavailable',
  /** 只发了请求，**没有回读**（宿主没有该槽的读回接口）。 */
  REQUESTED: 'requested',
  /** 下发失败。 */
  FAILED: 'failed',
  /** 这一槽没指定，明确不下发。 */
  NOT_SPECIFIED: 'not_specified',
})

export const EVIDENCE_LABEL = Object.freeze({
  [EVIDENCE.READBACK]: '会话读回',
  [EVIDENCE.READBACK_UNAVAILABLE]: '想读回但宿主没有这个接口（未读回）',
  [EVIDENCE.REQUESTED]: '已请求·**未回读**',
  [EVIDENCE.FAILED]: '下发失败',
  [EVIDENCE.NOT_SPECIFIED]: '未指定（没下发）',
})

/** 结构化的一槽证据。`effective` 只在 `READBACK` 时非 null。 */
export function slotEvidence(kind, requested, effective, detail) {
  const k = Object.values(EVIDENCE).includes(kind) ? kind : EVIDENCE.FAILED
  return {
    kind: k,
    label: EVIDENCE_LABEL[k],
    requested: requested === undefined ? null : requested,
    // ★ 结构闸：不是真读回，就不许带"生效值"出去
    effective: k === EVIDENCE.READBACK ? (effective === undefined ? null : effective) : null,
    detail: String(detail ?? ''),
  }
}

/**
 * 把一槽渲染成一行。**"一致"只可能出现在 READBACK 的行上**，且必须真的相等。
 */
export function renderSlot(name, ev) {
  if (ev === null || ev === undefined) return `${name}：（缺证据记录）`
  const req = ev.requested === null ? '（未指定）' : String(ev.requested)
  if (ev.kind === EVIDENCE.READBACK) {
    const same = ev.effective === ev.requested
    return `${name}：${req} · ${ev.label}**${ev.effective === null ? '不可用' : ev.effective}** ⇒ ${same ? '核对一致' : '**核对不一致**'}${ev.detail.length > 0 ? `（${ev.detail}）` : ''}`
  }
  return `${name}：${req} · ${ev.label}${ev.detail.length > 0 ? ` —— ${ev.detail}` : ''}`
}

/**
 * 四槽证据汇总渲染。
 * @param {{mode:object, permission:object, model:object, reasoning:object, roster?:object}} slots
 * @param {{declared?:object}} [declared] 名单里记的**声明值**（不传就不谈名单）
 */
export function renderSlotsEvidence(slots, declared = {}) {
  const lines = [
    renderSlot('模式（会话头 agentPreset）', slots.mode),
    renderSlot('权限档', slots.permission),
    renderSlot('模型', slots.model),
    renderSlot('推理等级', slots.reasoning),
  ]
  const d = declared?.declared ?? null
  if (d !== null && typeof d === 'object') {
    const diffs = []
    for (const [key, label] of [['permission', '权限档'], ['mode', '模式'], ['model', '模型'], ['reasoning', '推理等级']]) {
      const decl = d[key]
      if (decl === undefined || decl === null) continue
      const applied = slots[key]?.effective ?? null
      // 只有真读回（或已下发的请求值）才谈得上"跟名单不同"；未读回的槽不下这个判断
      const requested = slots[key]?.requested ?? null
      if (applied !== null && applied !== decl) diffs.push(`${label}：名单记 ${decl}，实际 ${applied}`)
      else if (applied === null && requested !== null && requested !== decl) diffs.push(`${label}：名单记 ${decl}，本次请求 ${requested}（未回读，所以"实际是多少"**不知道**）`)
    }
    if (diffs.length > 0) {
      lines.push(`名单（roster.slots）与本次派活**不一致**：${diffs.join('；')} —— 名单是**声明表**，不是"席位实际拿到了什么"；实际生效值见 task.dispatch_slots[]`)
    } else {
      lines.push('名单（roster.slots）与本次派活一致。')
    }
  }
  return lines
}

/** 给测试与调用方用的一句话结论：四槽里有没有"声称一致但其实没读回"的。 */
export function anyFalseConsistencyClaim(records) {
  const bad = []
  for (const [name, ev] of Object.entries(records)) {
    if (ev === null || ev === undefined) continue
    if (ev.kind !== EVIDENCE.READBACK && ev.effective !== null) bad.push(name)
  }
  return bad
}

/**
 * 从名单里取出**这个席位**的声明槽。
 *
 * 名单的键有两种形状（见 `lib/tiers.js` 的 `slotKeyOf`）：带席位的 `role@seat`、
 * 不带席位的 `role`。这里**两种都试**而不是 import 那个函数 —— 少一条模块间依赖，
 * 而且顺序明确（先精确的 `role@seat`，再退到 `role`），行为可读可测。
 *
 * @returns {{key:string, slots:object}|null} 找不到就 null（**不是**空对象 —— 空对象会被读成"声明了空值"）
 */
export function pickDeclaredSlot(roster, role, seat) {
  const slots = roster?.slots
  if (slots === null || typeof slots !== 'object') return null
  const keys = []
  if (typeof seat === 'string' && seat.length > 0) keys.push(`${role}@${seat}`)
  keys.push(String(role))
  for (const k of keys) {
    const hit = slots[k]
    if (hit !== null && typeof hit === 'object') return { key: k, slots: hit }
  }
  return null
}
