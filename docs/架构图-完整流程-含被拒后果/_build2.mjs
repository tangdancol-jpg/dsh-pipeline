// 重建节点/边：① 修正列序（枢纽路径：架构图先于计划）；② 机制底座的对外出口全部走 col0（唯一在 seats 车道空着的列）。
import { readFileSync, writeFileSync } from 'node:fs'
const DIR = '~/.dsh/dsh_orb/架构图-完整流程-含被拒后果/'
const BASE = DIR + '完整流程.workflow.json'
const src = JSON.parse(readFileSync(BASE, 'utf8'))

const nodeSpec = {
  n_intake: { lane: 'entry', col: 0 },
  n_supervision: { lane: 'hub', col: 1 },
  n_requirement: { lane: 'seats', col: 1 },
  n_architecture: { lane: 'seats', col: 3 },
  n_planning: { lane: 'seats', col: 2 },
  n_execution: { lane: 'seats', col: 4 },
  n_test: { lane: 'gates', col: 4 },
  n_review: { lane: 'gates', col: 5 },
  n_archiving: { lane: 'archive', col: 5 },
  n_closeout: { lane: 'closeout', col: 5 },
  n_hostmsg: { lane: 'mech_deliver', col: 0, yOffset: -45 },
  n_seatnotify: { lane: 'mech_deliver', col: 0, yOffset: 45 },
  n_wakeup: { lane: 'mech_deliver', col: 1, yOffset: -90 },
  n_orphan: { lane: 'mech_deliver', col: 1, yOffset: 0 },
  n_reattach: { lane: 'mech_deliver', col: 1, yOffset: 90 },
  n_ledger: { lane: 'mech_deliver', col: 2, yOffset: 0 },
  n_liveness: { lane: 'mech_deliver', col: 3, yOffset: -45 },
  n_runfail: { lane: 'mech_deliver', col: 3, yOffset: 45 },
  n_patrol: { lane: 'mech_deliver', col: 4, yOffset: 0 },
  n_plumbing: { lane: 'mech_rule', col: 0 },
  n_tokens: { lane: 'mech_rule', col: 1 },
  n_guard: { lane: 'mech_rule', col: 2 },
  n_hashing: { lane: 'mech_rule', col: 3 },
  n_states: { lane: 'mech_rule', col: 4 }
}

const nodes = src.nodes.map((n) => {
  const s = nodeSpec[n.id]
  const out = { ...n, lane: s.lane, col: s.col }
  delete out.yOffset
  if (s.yOffset !== undefined) out.yOffset = s.yOffset
  return out
})

const edges = [
  // 主路径
  { id: 'e_open', from: 'n_intake', to: 'n_supervision', label: '非主管代发⇒拒', variant: 'emphasis', role: 'main' },
  { id: 'e_initiate', from: 'n_supervision', to: 'n_requirement', label: '发起⇒分析开工', variant: 'emphasis', role: 'main' },
  { id: 'e_need_to_supervisor', from: 'n_requirement', to: 'n_supervision', label: '结论交主管受理', variant: 'emphasis', role: 'main' },
  { id: 'e_agree_need', from: 'n_supervision', to: 'n_architecture', label: '同意⇒放行', variant: 'emphasis', role: 'main' },
  { id: 'e_diagram_submitted', from: 'n_architecture', to: 'n_supervision', label: '架构图交主管确认', variant: 'emphasis', role: 'main' },
  { id: 'e_confirm_diagram', from: 'n_supervision', to: 'n_planning', label: '同意⇒唤醒计划位', variant: 'emphasis', role: 'main' },
  { id: 'e_planned', from: 'n_planning', to: 'n_execution', label: '计划齐备⇒派编写', variant: 'emphasis', role: 'main' },
  { id: 'e_design', from: 'n_architecture', to: 'n_execution', label: '方案先行 · 不推状态', variant: 'default', role: 'async' },
  { id: 'e_dev_submitted', from: 'n_execution', to: 'n_test', label: '交付⇒交测试', variant: 'emphasis', role: 'main' },
  { id: 'e_test_passed', from: 'n_test', to: 'n_review', label: '测试通过⇒放行', variant: 'emphasis', role: 'main' },
  { id: 'e_review_ok', from: 'n_review', to: 'n_archiving', label: '审核 OK⇒放行', variant: 'emphasis', role: 'main' },
  { id: 'e_close', from: 'n_archiving', to: 'n_closeout', label: '关单闸六道 · 缺一⇒拒', variant: 'emphasis', role: 'main' },
  // 被拒后果：六条往回走的边（实线，已实现）
  { id: 'e_r1_test_to_dev', from: 'n_test', to: 'n_execution', label: '测试不过⇒打回编写·预算 2', variant: 'default', role: 'error' },
  { id: 'e_r2_review_to_dev', from: 'n_review', to: 'n_execution', label: '审核 NG⇒退回编写·预算 2', variant: 'default', role: 'error' },
  { id: 'e_r3_review_to_test', from: 'n_review', to: 'n_test', label: '审核 NG⇒退回测试·预算 2', variant: 'default', role: 'error' },
  { id: 'e_r4_reject_diagram', from: 'n_supervision', to: 'n_architecture', label: '否掉⇒重画限 1 次·超限交人工', variant: 'default', role: 'error' },
  { id: 'e_r5_back_to_analysis', from: 'n_intake', to: 'n_requirement', label: '用户不认⇒退回重析', variant: 'default', role: 'return' },
  { id: 'e_r6_plan_gap', from: 'n_planning', to: 'n_requirement', label: '计划缺失⇒回流澄清梯', variant: 'default', role: 'return' },
  { id: 'e_clarify_ask', from: 'n_execution', to: 'n_requirement', label: '澄清⇒停等 · 裁定后投回', variant: 'default', role: 'return' },
  // ★ 虚线：已设计、待重载后验证
  { id: 'e_x_reject_need', from: 'n_supervision', to: 'n_requirement', label: '否掉⇒退回需求分析·待重载', variant: 'dashed', role: 'branch' },
  { id: 'e_x_reject_test', from: 'n_supervision', to: 'n_test', label: '站点③否掉⇒退回测试·待重载', variant: 'dashed', role: 'branch' },
  { id: 'e_x_reject_review', from: 'n_supervision', to: 'n_review', label: '站点④否掉⇒退回复核·待重载', variant: 'dashed', role: 'branch' },
  // 机制底座 · 投递与兜底（出口统一在 col0）
  { id: 'e_wakeup_hostmsg', from: 'n_wakeup', to: 'n_hostmsg', label: '经宿主通道投递', variant: 'default', role: 'async' },
  { id: 'e_ledger_wake', from: 'n_ledger', to: 'n_wakeup', label: '恰播一次', variant: 'default', role: 'async' },
  { id: 'e_liveness_ledger', from: 'n_liveness', to: 'n_ledger', label: '失联触发', variant: 'default', role: 'async' },
  { id: 'e_runfail_liveness', from: 'n_runfail', to: 'n_liveness', label: '崩≠闲 · 不冻', variant: 'default', role: 'async' },
  { id: 'e_patrol_liveness', from: 'n_patrol', to: 'n_liveness', label: '只播报不动作', variant: 'default', role: 'async' },
  { id: 'e_orphan_notify', from: 'n_orphan', to: 'n_seatnotify', label: '识别孤儿⇒重投', variant: 'default', role: 'async' },
  { id: 'e_reattach_hostmsg', from: 'n_reattach', to: 'n_hostmsg', label: '重启后认得席位', variant: 'default', role: 'async' },
  { id: 'e_hostmsg_main', from: 'n_hostmsg', to: 'n_intake', label: '注进下一轮上下文', variant: 'default', role: 'async' },
  { id: 'e_seatnotify_main', from: 'n_seatnotify', to: 'n_intake', label: '传话 · 不建会话', variant: 'default', role: 'async' },
  // 机制底座 · 约束链
  { id: 'e_r_tokens', from: 'n_plumbing', to: 'n_tokens', label: '每席位一枚', variant: 'security', role: 'async' },
  { id: 'e_r_guard', from: 'n_tokens', to: 'n_guard', label: '越权⇒拦', variant: 'security', role: 'async' },
  { id: 'e_r_hashing', from: 'n_guard', to: 'n_hashing', label: '足迹对账', variant: 'security', role: 'async' },
  { id: 'e_r_states', from: 'n_hashing', to: 'n_states', label: '越界⇒拒', variant: 'security', role: 'async' }
]

writeFileSync(BASE, JSON.stringify({ ...src, nodes, edges }, null, 2), 'utf8')
console.log('nodes', nodes.length, 'edges', edges.length)
