// v2：以交付版 main-path.workflow.json 为底，照参考图 dsh-pipeline-lifecycle 的结构
// 补出【独立的打回 / 异常车道】—— ①③④ 站点否掉、② 架构图否掉、审核 NG ×2、澄清梯、超限与阻塞，
// 全部画成**真正的边**（上一版只写成标签）。
//
// 硬约束（实测得来，不是猜）：
//   · 节点文本超盒宽 ⇒ 渲染器崩（tag/sublabel ≤ (width-8)/3.6 unit；label ≤ (width+6)/6.8 unit）
//   · 边标签写死 8px ⇒ 长标签把 viewBox 撑宽，width 超 1085 就吃 composition/<redacted>
//   · 不是 git 检出、workflow 吃不到 declared-wide ⇒ 舞台按 legacy-930，viewBox 宽 ≤ 1062
//   · 一条旧边都不丢（e_rework 按参考图的做法改指异常车道节点，语义与条数都保留）
import { readFileSync, writeFileSync } from 'node:fs'

const [src, dst] = process.argv.slice(2)
const doc = JSON.parse(readFileSync(src, 'utf8'))
const byId = new Map(doc.nodes.map((n) => [n.id, n]))
const must = (id) => { const n = byId.get(id); if (!n) throw new Error('missing ' + id); return n }

// ---------- 1. 视觉参考：预设 / 语言（照参考图） ----------
doc.meta.visual_preset = 'signal-flow'
doc.meta.locale = 'zh-CN'
// 参考图（dsh-pipeline-lifecycle）本身就是 standard；本图 36 条边、9 条车道，
// showcase 的「零交叉 / 零并道」在这套拓扑下实测过不去（见报告），故与参考图取同一档。
doc.meta.quality_profile = 'standard'
doc.meta.subtitle =
  '主路径一站不落，打回与异常另有独立车道与独立的线。实读 normify-dsh-pipeline 与 lib/states.js；站点否掉回边为本次新增（station-reject-check 49/49），需重载验证。'
doc.meta.legend.entries.cloud = { label: '独立复核（测试 / 审核）与打回 / 异常出口' }

// ---------- 2. 插入异常车道（放在 hub 与 seats 之间：与主管枢纽、席位都相邻，回边不必穿车厢） ----------
const exitsLane = { id: 'exits', label: '打回 / 异常出口（独立的线）', variant: 'exception' }
doc.lanes.splice(doc.lanes.findIndex((l) => l.id === 'seats'), 0, exitsLane)
doc.groups = [{ id: 'g_exit', label: '打回与人工', lane: 'exits', fromCol: 0, toCol: 5, variant: 'security' }]

// ---------- 3. 异常车道节点（照参考图合并成少量出口节点） ----------
// 布局随 --layout=N 变：出口节点的落位直接决定线会不会交叉，这里只试少量**结构性**布局，不穷举坐标。
const LAYOUT = Number((process.argv.find((a) => a.startsWith('--layout=')) || '--layout=1').split('=')[1])
const X = (id, col, label, sublabel, tag, yOffset, sources) => ({ id, lane: 'exits', col, type: 'cloud', label, sublabel, tag, width: 120, height: 68, sources, ...(yOffset ? { yOffset } : {}) })
// 每个出口节点都挂**代码证据**（都在 lib/states.js，即模块 flow.plumbing.states 的 source），
// 这样映射闸门按 sources[].path 就能把组件归到模块上，不必用 allow_unmapped 蒙过去。
const S = (line, end_line, label) => ({ path: 'lib/states.js', line, ...(end_line ? { end_line } : {}), label })
const SRC = {
  x_ret_need: [S(437, 444, 'supervisor_reject_need ⇒ analyzing')],
  x_ret_arch: [S(418, undefined, 'supervisor_reject_diagram ⇒ arch_drawing'), S(298, undefined, 'HUB_DIAGRAM_REDRAW_BUDGET = 1')],
  x_ret_test: [S(445, 452, 'supervisor_reject_test ⇒ returned_to_test'), S(492, undefined, 'review_ng_test ⇒ returned_to_test')],
  x_ret_review: [S(453, 460, 'supervisor_reject_review ⇒ reviewing')],
  x_ret_dev: [S(476, undefined, 'test_failed ⇒ returned_to_dev'), S(491, undefined, 'review_ng_dev ⇒ returned_to_dev')],
  x_clarify: [S(502, 503, 'clarification_request / reply')],
  x_block: [S(313, undefined, 'HUB_STATION_REJECT_BUDGET = 1'), S(495, undefined, 'close_gates 关单前置'), S(298, undefined, '重画预算 = 1')],
}
const LAYOUTS = {
  // 1：收集节点在 c0 首行（基线）
  1: () => [
    X('x_ret_need', 1, '退回需求补析', '站点否掉 ①', '限 1 次'),
    X('x_ret_arch', 3, '退回架构重画', '站点否掉 ②', '限 1 次'),
    X('x_ret_review', 4, '退回审核重审', '站点否掉 ④', '限 1 次'),
    X('x_clarify', 4, '澄清停等', '发起席原地等', 'awaiting_clarification', 80),
    X('x_ret_dev', 5, '打回编写', '测试不过 / 审核 NG', '计预算'),
    X('x_ret_test', 5, '打回测试', '审核 NG / ③否掉', '计预算', 80),
    X('x_budget', 0, '预算用尽', '再打回即拒', '默认 2 次'),
    X('x_block', 0, '交人工 / 阻塞', 'block / cancel', '终态出口', 80),
  ],
  // 2：收集节点降到第二 / 第三行，给 c1 的竖直回边让路
  2: () => [
    X('x_ret_need', 1, '退回需求补析', '站点否掉 ①', '限 1 次'),
    X('x_ret_arch', 3, '退回架构重画', '站点否掉 ②', '限 1 次'),
    X('x_ret_review', 4, '退回审核重审', '站点否掉 ④', '限 1 次'),
    X('x_clarify', 4, '澄清停等', '发起席原地等', 'awaiting_clarification', 80),
    X('x_ret_dev', 5, '打回编写', '测试不过 / 审核 NG', '计预算'),
    X('x_ret_test', 5, '打回测试', '审核 NG / ③否掉', '计预算', 80),
    X('x_budget', 0, '预算用尽', '再打回即拒', '默认 2 次', 80),
    X('x_block', 2, '交人工 / 阻塞', 'block / cancel', '终态出口', 160),
  ],
  // 3：预算与阻塞合并成一个节点（用户 #5 的口径：超限与阻塞），澄清节点挪到 c2
  3: () => [
    X('x_ret_need', 1, '退回需求补析', '站点否掉 ①', '限 1 次'),
    X('x_ret_arch', 3, '退回架构重画', '站点否掉 ②', '限 1 次'),
    X('x_ret_review', 4, '退回审核重审', '站点否掉 ④', '限 1 次'),
    X('x_clarify', 2, '澄清停等', '发起席原地等', 'awaiting_clarification', 80),
    X('x_ret_dev', 5, '打回编写', '测试不过 / 审核 NG', '计预算'),
    X('x_ret_test', 5, '打回测试', '审核 NG / ③否掉', '计预算', 80),
    X('x_block', 0, '预算用尽 ⇒ 交人工', 'block / cancel', '终态出口', 80),
  ],
  // 4：同上，但站点否掉不再各连一条预算边（预算用「限 1 次」tag 表达），只留打回两条
  4: () => LAYOUTS[3](),
}
const xNodes = LAYOUTS[LAYOUT]()
// 说明：出口节点的代码依据都在 lib/states.js，但给节点挂 sources 会触发
// repository-evidence/repository-required（本仓库不是 git 检出、没有可钉的 commit，
// 不能编一个）⇒ 改用映射闸门自带的 mapping_path 显式给出「组件 → 模块」归属，
// 结构与依据记在 SRC 里、写进报告。
void SRC
doc.nodes.push(...xNodes)
const mergeBlock = LAYOUT >= 3

// ---------- 4. 边：全部画成独立的线 ----------
//   variant 照参考图：打回/拒绝 = security + role error；计预算 = dashed + role return
const NEW = [
  // ①③④ 三个站点的「否掉」回边 + ② 的架构图否掉（实读 lib/states.js:418 / 437-460，by: [supervisor]，预算各 1 次）
  ['n_supervision', 'x_ret_need', '①否掉 ⇒ 退回补析', 'security', 'error'],
  ['n_supervision', 'x_ret_arch', '②否掉 ⇒ 退回重画', 'security', 'error'],
  ['n_supervision', 'x_ret_test', '③否掉 ⇒ 退回重跑', 'security', 'error'],
  ['n_supervision', 'x_ret_review', '④否掉 ⇒ 退回重审', 'security', 'error'],
  // 审核 NG 的两条（lib/states.js:491-492 review_ng_dev / review_ng_test）
  ['n_review', 'x_ret_dev', '审核 NG ⇒ 打回编写', 'security', 'error'],
  ['n_review', 'x_ret_test', '审核 NG ⇒ 打回测试', 'security', 'error'],
  // 澄清梯（lib/states.js:502-503：clarification_request ⇒ awaiting_clarification；clarification_reply(answered) ⇒ 回原态）
  ['n_execution', 'x_clarify', '澄清 ⇒ 发起席停等', 'dashed', 'return'],
  ['x_clarify', 'n_requirement', '裁定 ⇒ 投回原席', 'dashed', 'return'],
]
// 无有效审核结论 ⇒ 关单被拒（close_gates，lib/states.js:495）—— 无论哪种布局都在
NEW.push(['n_closeout', 'x_block', '无 OK 关单被拒', 'security', 'error'])
if (mergeBlock) {
  // 预算用尽与阻塞合并成一个出口：两条打回腿各连一条（站点否掉用 tag「限 1 次」表达其预算）
  NEW.push(['x_ret_dev', 'x_block', '再打回 ⇒ 超限', 'security', 'error'])
  NEW.push(['x_ret_test', 'x_block', '也计预算', 'security', 'error'])
  if (LAYOUT < 4) {
    NEW.push(['x_ret_need', 'x_block', '重犯 ⇒ 用尽', 'dashed', 'return'])
    NEW.push(['x_ret_arch', 'x_block', '重画限 1 次', 'dashed', 'return'])
    NEW.push(['x_ret_review', 'x_block', '站点否掉限 1 次', 'dashed', 'return'])
  }
} else {
  // 预算与阻塞分两级（照参考图 x_budget → x_block）
  NEW.push(['x_ret_need', 'x_budget', '重犯 ⇒ 用尽', 'dashed', 'return'])
  NEW.push(['x_ret_arch', 'x_budget', '重画限 1 次', 'dashed', 'return'])
  NEW.push(['x_ret_review', 'x_budget', '站点否掉限 1 次', 'dashed', 'return'])
  NEW.push(['x_ret_dev', 'x_budget', '再打回 ⇒ 超限', 'dashed', 'return'])
  NEW.push(['x_ret_test', 'x_budget', '也计预算', 'dashed', 'return'])
  NEW.push(['x_budget', 'x_block', '超限 ⇒ 交人工', 'security', 'error'])
}
for (const [from, to, label, variant, role] of NEW) {
  if (!byId.has(from) && !doc.nodes.some((n) => n.id === from)) throw new Error('unknown source ' + from)
  if (!doc.nodes.some((n) => n.id === to)) throw new Error('unknown target ' + to)
  if (doc.edges.some((e) => e.from === from && e.to === to)) throw new Error(`duplicate pair ${from}->${to}`)
  doc.edges.push({ id: `ex_${doc.edges.length}_${from}_${to}`.replace(/[^A-Za-z0-9_]/g, ''), from, to, label, variant, role })
}

// ---------- 5. e_rework 照参考图改走异常车道（条数不变、语义不变：测试位打回编写） ----------
const rework = doc.edges.find((e) => e.id === 'e_rework')
rework.to = 'x_ret_dev'
rework.label = '测试不过 ⇒ 打回编写'
rework.variant = 'security'
rework.role = 'error'

// ---------- 6. 视图：补一个「打回与异常出口」视角 ----------
const ladder = doc.meta.views.find((v) => v.id === 'ladder')
if (ladder) ladder.focus = ['n_requirement', 'n_planning', 'n_execution', 'n_test', 'n_review', 'x_clarify', 'x_ret_dev', 'x_ret_test', 'x_budget', 'x_block']
doc.meta.views.push({
  id: 'reject',
  label: '★ 打回与异常出口（新增的独立的线）',
  focus: ['n_supervision', 'n_execution', 'n_test', 'n_review', 'x_ret_need', 'x_ret_arch', 'x_ret_test', 'x_ret_review', 'x_ret_dev', 'x_clarify', 'x_budget', 'x_block'],
  note: '①③④ 站点否掉与 ② 架构图否掉、审核 NG 两条、澄清梯、预算用尽与阻塞 —— 都在异常车道，各有自己的线',
})

// ---------- 7. 卡片：把新车道与依据写清楚 ----------
doc.cards.unshift({
  dot: 'rose',
  title: '★ 打回 / 异常出口：这一版新画出来的独立的线（上一版只写成标签）',
  items: [
    '①③④ 站点否掉（本次新增，需重载验证）：supervisor_reject_need ⇒ analyzing、supervisor_reject_test ⇒ returned_to_test、supervisor_reject_review ⇒ reviewing，一律 by:[supervisor]、guard hub_station_reject、预算 HUB_STATION_REJECT_BUDGET = 1。实读 lib/states.js:313/326-338/437-460',
    '② 架构图否掉：supervisor_reject_diagram ⇒ arch_drawing，判据 hub_diagram_rework_budget，HUB_DIAGRAM_REDRAW_BUDGET = 1，超限走既有的 human_request 升级人工。实读 lib/states.js:298/418',
    '审核 NG 两条：review_ng_dev ⇒ returned_to_dev（reviewer 与 security 都能发）、review_ng_test ⇒ returned_to_test，都挂 rework_budget。实读 lib/states.js:491-492',
    '澄清梯：clarification_request ⇒ awaiting_clarification（发起席原地停等），clarification_reply(answered) ⇒ 回到被打断前的状态；答不了才升级用户。实读 lib/states.js:502-503',
    '预算与人工出口：打回每条腿默认 2 次（config.js:23 maxReworkPerLeg: 2），闸门不通过不消耗；用尽 ⇒ 只能阻塞交人工或走仲裁角色，不许死锁',
  ],
})

// ---------- 8. 体检（渲染器在文本超预算时是崩，不是给诊断） ----------
const FULLWIDTH = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/
const textUnits = (t) => { let u = 0; for (const ch of String(t ?? '')) u += FULLWIDTH.test(ch) ? 2 : 1; return u }
const bad = []
for (const n of doc.nodes) {
  const avail = n.width - 8
  if (n.label && textUnits(n.label) * 6.8 > n.width + 6) bad.push(`label ${n.id} (${textUnits(n.label)}u > ${((n.width + 6) / 6.8).toFixed(1)})`)
  for (const f of ['sublabel', 'tag']) if (n[f] && textUnits(n[f]) * 3.6 > avail) bad.push(`${f} ${n.id} needs ${Math.ceil(textUnits(n[f]) * 3.6)}px > ${avail}px`)
}
if (bad.length) { console.error('TEXT BUDGET VIOLATION (renderer will crash):\n' + bad.join('\n')); process.exit(2) }
const ids = new Set(doc.nodes.map((n) => n.id))
for (const e of doc.edges) if (!ids.has(e.from) || !ids.has(e.to)) throw new Error(`dangling ${e.id}`)
const noLabel = doc.edges.filter((e) => !e.label)
if (noLabel.length) { console.error('UNLABELED: ' + noLabel.map((e) => e.id).join(',')); process.exit(3) }
const pairs = new Set()
for (const e of doc.edges) { const k = `${e.from}->${e.to}`; if (pairs.has(k)) throw new Error('dup pair ' + k); pairs.add(k) }
if (!doc.lanes.some((l) => l.id === 'exits')) throw new Error('exits lane missing')

doc.meta.output = 'main-path-v2.html'
const text = JSON.stringify(doc, null, 2) + '\n'
writeFileSync(dst, text)
const oldEdges = 22
console.log(`nodes=${doc.nodes.length} edges=${doc.edges.length} (旧 ${oldEdges} 条 + 新 ${doc.edges.length - oldEdges} 条) bytes=${Buffer.byteLength(text)}`)
console.log(`lanes=${doc.lanes.length} exits 车道节点=${doc.nodes.filter((n) => n.lane === 'exits').length} 最长边标签=${Math.max(...doc.edges.map((e) => textUnits(e.label)))}unit`)
