// 生成主规格：旧规格为底 → ① 拆「测试与审核」为「测试位」+「审核位」 ② 每条边补「被拒后果」标签。
//
// 硬约束（实读 renderer 得来，非猜测）：
//   · 节点文本（label/sublabel/tag）在最小字号下放不进盒宽时，渲染器**崩**（internal/unclassified），
//     而不是给结构化诊断。tag/sublabel 预算：textUnits ≤ (width-8)/(6*0.6)；label 预算：textUnits ≤ (width+6)/6.8
//   · 边标签写死 8px，宽 ≈ textUnits*4.8px ⇒ 标签必须短（全角按 2 unit 计）
//   · 不从机制车道新增连到 n_execution / n_review 的边（那条垂直走廊不存在）
//   · 一条旧边都不丢
//
// 用法：node build-spec.mjs <旧规格> <输出> [--with-reject-back] [--with-review-ng]
import { readFileSync, writeFileSync } from 'node:fs'

const [src, dst, ...flags] = process.argv.slice(2)
const ON = (f) => flags.includes(f)
const doc = JSON.parse(readFileSync(src, 'utf8'))
const byId = new Map(doc.nodes.map((n) => [n.id, n]))
const must = (id) => { const n = byId.get(id); if (!n) throw new Error('missing node ' + id); return n }

// ---------- 改动 1：拆节点（label 逐字等于 normify 模块名） ----------
const ver = must('n_verification')
doc.nodes = doc.nodes.filter((n) => n.id !== 'n_verification')
const testNode = { id: 'n_test', lane: ver.lane, col: ver.col, type: ver.type, label: '测试位', sublabel: '自己跑判据', tag: 'test_passed / failed', width: ver.width, yOffset: 0, height: ver.height }
const reviewNode = { id: 'n_review', lane: ver.lane, col: ver.col, type: ver.type, label: '审核位', sublabel: '唯一开闸结论', tag: 'review_ok / ng', width: ver.width, yOffset: 80, height: ver.height }
doc.nodes.splice(doc.nodes.indexOf(must('n_execution')) + 1, 0, testNode, reviewNode)

// 指向 n_verification 的三条边按语义分派（dev_to_test→测试位；review_ok→审核位；test_failed→测试位）
const rewired = { e_dev_submitted: ['n_execution', 'n_test'], e_review_ok: ['n_review', 'n_archiving'], e_rework: ['n_test', 'n_execution'] }
for (const e of doc.edges) if (rewired[e.id]) [e.from, e.to] = rewired[e.id]

// ---------- 改动 2：每条边补「被拒 / 失败后果」标签 ----------
// 标签规格：≤19 unit（全角按 2 计）≈ 91px。完整口径（用户的原文案）落在 cards 里，画布上只留短句：
//   composition/*** 的硬数字是 viewBox 宽 ≤ 1085px，长标签会把画布撑宽、把投影字号压到 6px 地板以下。
const LABELS = {
  e_open: '不受理 ⇒ 停 pending',
  e_dispatch_orchestrator: '答不了 ⇒ 升级用户',
  e_requirement_confirmed: '否掉 ⇒ 退回补析',
  e_planned: '缺口径 ⇒ 退回需求',
  e_plan_gap: '口径缺口 ⇒ 退回',
  e_dispatch_writer: '否掉 ⇒ 重画限 1 次',
  e_dev_submitted: '测试不过 ⇒ 打回编写',
  e_test_to_review: '审核不过 ⇒ 退回',
  e_rework: '打回 · 预算 2',
  e_review_ok: '同意 ⇒ 放行',
  e_close: '无审核结论 ⇒ 拒关',
  e_wake_main: '叫不醒 ⇒ 转孤儿单',
  e_wake_seat: '投不进 ⇒ 判失联',
  e_d_ledger: '无稳定身份 ⇒ 不播报',
  e_d_liveness: '判据不齐 ⇒ 不误报',
  e_d_patrol: '只播报不动作',
  e_d_reattach: '认不出 ⇒ 留痕',
  e_r_tokens: '无令牌 ⇒ 拒写',
  e_r_guard: '越界写入 ⇒ 拦下',
  e_r_hashing: '足迹越界 ⇒ 拒交付',
  e_r_states: '非法迁移 ⇒ 拒掉',
  e_rule_close: '不满足闸门 ⇒ 拒关',
}
// ---------- 改动 3（超出"两处最小改动"，但硬约束"不许编造"要求）----------
// 旧规格写这 4 个部件"完全没有实现（planned）"。本次实读代码：4 个都有实现落点，
// normify 结构树里也**没有** state=planned 的模块 ⇒ 那句话现在是假的，必须改掉。
//   · lib/states.js:298/313/326-338/418/437-460 + lib/store.js:2301-2455 + lib/tools.js:2510-2740
//   · lib/wakeledger.js:54-157  · lib/patrol.js:42-219  · lib/reattach.js:67-269（2026-10-14 新建）
const TRUTH = {
  n_supervision: { sublabel: '四道站点确认', tag: 'supervisor_*' },
  n_ledger: { sublabel: '恰播一次', tag: 'wakeledger.js' },
  n_patrol: { sublabel: '只播报不动作', tag: 'patrol.js' },
  n_reattach: { sublabel: '重启认得席位', tag: '本次新增·未验证' },
}
for (const [id, patch] of Object.entries(TRUTH)) Object.assign(must(id), patch)
for (const l of doc.lanes) if (l.id === 'hub') l.label = '主管枢纽（本次实读已落地）'
doc.meta.legend.entries.security.label = '★ 红 = 最近落地的机制部件（已实读源码）'
doc.meta.subtitle =
  '主路径一站不落。实读 normify-dsh-pipeline 与 lib/states.js；旧版标「未实现」的 4 个机制部件本次实读代码均已落地（重启认领尚无重启验证）。'
const missingView = doc.meta.views.find((v) => v.id === 'missing')
if (missingView) {
  missingView.label = '★ 最近落地的 4 个机制部件'
  missingView.note =
    '主管枢纽 / 幂等播报账本 / 巡检兜底 / 重启认领 —— 本次实读源码全部落地：states.js+store.js+tools.js / wakeledger.js / patrol.js / reattach.js；重启认领尚无重启验证'
}
// 主路径导语也要跟上拆分：原来的「测试审核」是一站，现在是两站
const mainView = doc.meta.views.find((v) => v.id === 'main_path')
if (mainView) mainView.note = mainView.note.replace('测试审核', '测试 → 审核')
const roseCard = doc.cards[0]
roseCard.title = '★ 旧版标"完全没有实现"的 4 个部件 —— 本次实读代码均已落地（重启认领尚无重启验证）'
roseCard.items = [
  '主管枢纽：由它发起需求分析 / 计划 / 架构三方并登记后两者待机；四道站点确认归它点头。实读 lib/states.js:413-418/437-460（supervisor_initiate / supervisor_agree_need / supervisor_confirm_diagram / supervisor_reject_*）、lib/store.js:2301-2455、lib/tools.js:2510-2740',
  '幂等播报账本：落盘记录「哪条事件已经播过」，让「恰播一次」跨进程重启仍成立；取不到稳定交付身份就不播报（留痕 wake:skipped）。实读 lib/wakeledger.js:54-157',
  '巡检兜底：定时扫「长时间无进展」并**只播报、不动作**（用户裁定 A22）；真正去叫人的是孤儿单自恢复（lib/orphan.js）。实读 lib/patrol.js:42-219',
  '重启认领：DSH 重启后令牌表全空，机制须认得出既有席位；新增 autoReattachMain() + 纯函数判据 judgeMainClaim()，认不出留痕 main:reattach-refused。实读 lib/reattach.js:67-269 —— **本次新增，尚无重启验证**',
]

for (const e of doc.edges) if (LABELS[e.id] !== undefined) e.label = LABELS[e.id]

// 主路径：测试位 → 审核位（原合并节点内部的一跳，拆开后必须显式成边）
if (!doc.edges.some((e) => e.id === 'e_test_to_review')) {
  doc.edges.splice(doc.edges.findIndex((e) => e.id === 'e_review_ok'), 0, {
    id: 'e_test_to_review', from: 'n_test', to: 'n_review', label: LABELS.e_test_to_review, variant: 'emphasis', role: 'main',
  })
}

const addEdge = (e) => {
  if (doc.edges.some((x) => x.id === e.id)) return 'exists'
  if (doc.edges.some((x) => x.from === e.from && x.to === e.to)) return `skip:duplicate-pair(${e.from}->${e.to})`
  doc.edges.push(e)
  return 'added'
}
const notes = []

// 审核位的两条打回边（review_ng_dev / review_ng_test，实读 lib/states.js:491-492）
if (ON('--with-review-ng')) {
  notes.push(['e_review_ng_dev', addEdge({ id: 'e_review_ng_dev', from: 'n_review', to: 'n_execution', label: '审核不过 ⇒ 打回编写', variant: 'dashed', role: 'error' })])
  notes.push(['e_review_ng_test', addEdge({ id: 'e_review_ng_test', from: 'n_review', to: 'n_test', label: '审核不过 ⇒ 退回测试', variant: 'dashed', role: 'error' })])
}
// 四条站点「否掉」回边（lib/states.js:418 / 437-460，本次新增；预算各 1 次）
if (ON('--with-reject-back')) {
  notes.push(['e_reject_need', addEdge({ id: 'e_reject_need', from: 'n_supervision', to: 'n_requirement', label: '否掉 ⇒ 退回补析', variant: 'dashed', role: 'error' })])
  notes.push(['e_reject_diagram', addEdge({ id: 'e_reject_diagram', from: 'n_supervision', to: 'n_architecture', label: '否掉 ⇒ 重画 1 次', variant: 'dashed', role: 'error' })])
  notes.push(['e_reject_test', addEdge({ id: 'e_reject_test', from: 'n_supervision', to: 'n_test', label: '否掉 ⇒ 退回重跑', variant: 'dashed', role: 'error' })])
  notes.push(['e_reject_review', addEdge({ id: 'e_reject_review', from: 'n_supervision', to: 'n_review', label: '否掉 ⇒ 退回重审', variant: 'dashed', role: 'error' })])
}
// 澄清梯（lib/states.js:502-503）
if (ON('--with-clarify')) {
  notes.push(['e_clarify', addEdge({ id: 'e_clarify', from: 'n_execution', to: 'n_requirement', label: '澄清 ⇒ 发起席停等', variant: 'dashed', role: 'branch' })])
}

// 视图 focus：n_verification 已不存在
for (const v of doc.meta.views) v.focus = v.focus.flatMap((id) => (id === 'n_verification' ? ['n_test', 'n_review'] : [id]))

// ---------- 体检 ----------
const FULLWIDTH = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/
const textUnits = (t) => { let u = 0; for (const ch of String(t ?? '')) u += FULLWIDTH.test(ch) ? 2 : 1; return u }
const bad = []
for (const n of doc.nodes) {
  const avail = n.width - 8
  if (n.label && textUnits(n.label) * 6.8 > n.width + 6) bad.push(`label ${n.id} (${textUnits(n.label)}u)`)
  for (const f of ['sublabel', 'tag']) if (n[f] && textUnits(n[f]) * 3.6 > avail) bad.push(`${f} ${n.id} needs ${Math.ceil(textUnits(n[f]) * 3.6)}px > ${avail}px`)
}
if (bad.length) { console.error('TEXT BUDGET VIOLATION (renderer → crash):\n' + bad.join('\n')); process.exit(2) }
const ids = new Set(doc.nodes.map((n) => n.id))
for (const e of doc.edges) if (!ids.has(e.from) || !ids.has(e.to)) throw new Error(`dangling ${e.id}`)
const unlabeled = doc.edges.filter((e) => !e.label).map((e) => e.id)
if (unlabeled.length) { console.error('UNLABELED EDGES: ' + unlabeled.join(',')); process.exit(3) }

doc.meta.output = 'main-path.html'
const text = JSON.stringify(doc, null, 2) + '\n'
writeFileSync(dst, text)
console.log(`nodes=${doc.nodes.length} edges=${doc.edges.length} bytes=${Buffer.byteLength(text)}`)
if (notes.length) console.log('notes: ' + notes.map(([k, v]) => `${k}=${v}`).join(' '))
console.log('longest label units: ' + Math.max(...doc.edges.map((e) => textUnits(e.label))))
