/**
 * dsh-pipeline · 缺陷 ⑥：巡检播报一律自称"长时间无进展"
 * ============================================================================
 *     node tests/f6-patrol-notice-check.mjs
 *
 * 真机现场（T-20261015-bb30bc，2026-10-14T17:51:39Z）：
 *   主对话收到「**巡检发现长时间无进展**」，于是去查失联 —— 结果任务进 `reviewing`
 *   才 **1 分 49 秒**（口径 20 分钟）、审核席位 52 秒前刚有流水、`silent: []`；
 *   而账本里那条唤醒的键是 `…|unresolved-wake|…|handoff|no-stable-identity`
 *   ⇒ 它压根不是"无进展"，是一条"**该叫没叫**"。
 *   根因：`index.js` 把播报的 `what` **写死**成一句话，而判据有**五种**。
 *
 * 本套钉住四件事：
 *   A. 五种判据 ⇒ **五句不同的话**（逐条对照 `lib/patrol.js` 真实产出的 kind）；
 *   B. 现场形状：`unresolved-wake` 的播报**不许**再出现"长时间无进展"字样；
 *   C. `task-stall` 该说"无进展"时**照旧说**（别把真话一起收掉）；
 *   D. 认不出的类别 ⇒ **照抄 kind 如实登记**，不编一个像模像样的中文名去冒名；
 *      且正文始终带 A22 的"只播报，不动作"后缀、明细一个字不改。
 *
 * ★ 全程密闭：不建任务、不投递、不落盘 —— 只验文案生成这一层。
 */

import { pathToFileURL } from 'node:url'

import { PATROL_DISCIPLINE, PATROL_KIND_LABEL, patrolHeadline, patrolKindLabel, patrolNotice } from '../lib/patrol/notice-text.js'

/** `lib/patrol.js` 真实会产出的 kind（grep `kind: '…'` 得到的全集）。 */
const REAL_KINDS = ['task-stall', 'unconsumed-delivery', 'unresolved-wake', 'missing-transition', 'patrol-stalled']

function createRecorder() {
  const items = []
  return {
    items,
    add(group, name, pass, detail) {
      items.push({ group, name, pass: pass === true, detail: String(detail ?? '') })
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
    text() {
      const L = ['dsh-pipeline · 缺陷 ⑥：巡检播报一律自称"长时间无进展"', '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('', `【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(`      ${it.detail.split('\n').join('\n      ')}`)
      }
      L.push('', '='.repeat(78), `总计：${this.passed}/${this.total} 通过`, '='.repeat(78))
      return L.join('\n')
    },
  }
}

/** 现场那条判据的**原样形状**（账本键里的类别段就是 unresolved-wake）。 */
const LIVE_FINDING = {
  id: 'T-20261015-bb30bc|unresolved-wake|mechanism|T-20261015-bb30bc|unresolved-wake|2026-10-14T17:49:35Z|handoff|no-stable-identity',
  kind: 'unresolved-wake',
  at: '2026-10-14T17:51:39Z',
  detail: '一条唤醒没有投出去（no-stable-identity，类别 handoff，2026-10-14T17:49:35Z）—— 这是"该叫没叫"，不是静默（A8）。',
}

export async function runF6PatrolNoticeCheck() {
  const rec = createRecorder()
  try {
    // ------------------------------------------------------------ A 五种五种话
    const G1 = 'A 五种判据 ⇒ 五句不同的话'
    const heads = REAL_KINDS.map((k) => patrolHeadline({ kind: k }))
    rec.add(G1, '★ `lib/patrol.js` 真实产出的五个 kind **全部**登记了标签（加判据不会静默变成"无进展"）', REAL_KINDS.every((k) => Object.hasOwn(PATROL_KIND_LABEL, k)), REAL_KINDS.map((k) => `${k} → ${PATROL_KIND_LABEL[k]}`).join('\n'))
    rec.add(G1, '★★ 五句正文**两两不同**（改前五条共用一句话）', new Set(heads).size === REAL_KINDS.length, heads.join('\n'))
    rec.add(G1, '★ 每句都带 A22 的纪律后缀', heads.every((h) => h.includes(PATROL_DISCIPLINE)), PATROL_DISCIPLINE)

    // ------------------------------------------------------------ B 现场形状
    const G2 = 'B 现场形状：`unresolved-wake` 不许再自称"长时间无进展"'
    const live = patrolNotice(LIVE_FINDING)
    rec.add(G2, '★★ 真机上那条（`unresolved-wake`）的正文**不含**"长时间无进展"', !live.what.includes('长时间无进展'), live.what)
    rec.add(G2, '★★ 它说的是"**一条唤醒没有投出去**"', live.what.includes('没有投出去'), live.what)
    rec.add(G2, '★ 正文点明**判据类别**（`unresolved-wake`），主对话能据此选对动作', live.note.includes('`unresolved-wake`'), live.note.split('\n')[0])
    rec.add(G2, '★ 判据自己的明细**一个字不改**地跟在后面', live.note.includes(LIVE_FINDING.detail), live.note.split('\n')[1] ?? '')
    rec.add(G2, '★ `kind` 原样透传给唤醒（下游按类别去重的那条键不许漂）', live.kind === 'unresolved-wake', live.kind)

    // ------------------------------------------------------------ C 真话不许收
    const G3 = 'C 该说"无进展"的时候照旧说（别把真话一起收掉）'
    const stall = patrolNotice({ kind: 'task-stall', id: 'X|task-stall|developing|2026-01-01T00:00:00Z', detail: '任务「开发中」已经 **25 分钟**没有任何进展' })
    rec.add(G3, '★ `task-stall` 照旧说"长时间无进展"', stall.what.includes('长时间无进展'), stall.what)
    rec.add(G3, '★ 它的明细（算出来的分钟数）原样保留', stall.note.includes('25 分钟'), stall.note.split('\n')[1] ?? '')
    const noDetail = patrolNotice({ kind: 'task-stall' })
    rec.add(G3, '★ 没有明细时只回归属行，不编内容', noDetail.note.split('\n').length === 1 && noDetail.note.includes('task-stall'), noDetail.note)

    // ------------------------------------------------------------ D 认不出就照抄
    const G4 = 'D 认不出的类别 ⇒ 照抄 kind 如实登记，不冒名'
    rec.add(G4, '★ 未知 kind ⇒ 正文里带着**原样的 kind**', patrolHeadline({ kind: 'brand-new-judgement' }).includes('brand-new-judgement'), patrolHeadline({ kind: 'brand-new-judgement' }))
    rec.add(G4, '★★ 未知 kind **不许**被说成"长时间无进展"', !patrolHeadline({ kind: 'brand-new-judgement' }).includes('长时间无进展'), '')
    rec.add(G4, '★ 连 kind 都没有 ⇒ 也不冒名（给一句中性的）', !patrolKindLabel({}).includes('长时间无进展') && !patrolKindLabel('').includes('长时间无进展'), patrolKindLabel({}))
    rec.add(G4, '`patrolKindLabel` 兼容直接传 kind 字符串', patrolKindLabel('task-stall') === PATROL_KIND_LABEL['task-stall'], patrolKindLabel('task-stall'))
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF6PatrolNoticeCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
