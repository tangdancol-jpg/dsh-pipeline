// 按最终布局重建规格：修正列序（枢纽路径里「架构图」在「计划」之前）、控制边数、每条边带被拒后果。
import { readFileSync, writeFileSync } from 'node:fs'

const DIR = '<DSH_HOME>/dsh_orb/架构图-完整流程-含被拒后果/'
const BASE = DIR + '完整流程.workflow.json'

const src = JSON.parse(readFileSync(BASE, 'utf8'))
const byId = new Map(src.nodes.map((n) => [n.id, n]))

// --- 修正列序：需求分析(1) → 架构与安全(2) → 计划与授权面(3) → 编写席执行(4) --------
byId.get('n_requirement').col = 1
byId.get('n_architecture').col = 2
byId.get('n_planning').col = 3
byId.get('n_execution').col = 4

const nodes = src.nodes.map((n) => ({ ...n }))

const edges = [
  // ---- 主路径（放行） ----
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
  // ---- 被拒后果：六条往回走的边（实线、已实现） ----
  { id: 'e_r1_test_to_dev', from: 'n_test', to: 'n_execution', label: '测试不过⇒打回编写·预算 2', variant: 'default', role: 'error' },
  { id: 'e_r2_review_to_dev', from: 'n_review', to: 'n_execution', label: '审核 NG⇒退回编写·预算 2', variant: 'default', role: 'error' },
  { id: 'e_r3_review_to_test', from: 'n_review', to: 'n_test', label: '审核 NG⇒退回测试·预算 2', variant: 'default', role: 'error' },
  { id: 'e_r4_reject_diagram', from: 'n_supervision', to: 'n_architecture', label: '否掉⇒重画限 1 次·超限交人工', variant: 'default', role: 'error' },
  { id: 'e_r5_back_to_analysis', from: 'n_intake', to: 'n_requirement', label: '用户不认⇒退回重析', variant: 'default', role: 'return' },
  { id: 'e_r6_plan_gap', from: 'n_planning', to: 'n_requirement', label: '计划缺失⇒回流澄清梯', variant: 'default', role: 'return' },
  { id: 'e_clarify_ask', from: 'n_execution', to: 'n_requirement', label: '澄清⇒停等 · 裁定后投回', variant: 'default', role: 'return' },
  // ---- ★ 虚线：已设计、待重载后验证（①③④三个站点的「否掉」回边） ----
  { id: 'e_x_reject_need', from: 'n_supervision', to: 'n_requirement', label: '否掉⇒退回需求分析·待重载', variant: 'dashed', role: 'branch' },
  { id: 'e_x_reject_test', from: 'n_supervision', to: 'n_test', label: '站点③否掉⇒退回测试·待重载', variant: 'dashed', role: 'branch' },
  { id: 'e_x_reject_review', from: 'n_supervision', to: 'n_review', label: '站点④否掉⇒退回复核·待重载', variant: 'dashed', role: 'branch' },
  // ---- 机制底座 · 投递与兜底 ----
  { id: 'e_wake_main', from: 'n_wakeup', to: 'n_intake', label: '叫醒主对话', variant: 'default', role: 'async' },
  { id: 'e_wake_seat', from: 'n_hostmsg', to: 'n_test', label: '投进席位下一轮', variant: 'default', role: 'async' },
  { id: 'e_notify_seat', from: 'n_seatnotify', to: 'n_execution', label: '传话 · 不建会话', variant: 'default', role: 'async' },
  { id: 'e_ledger_wake', from: 'n_ledger', to: 'n_wakeup', label: '恰播一次', variant: 'default', role: 'async' },
  { id: 'e_liveness_ledger', from: 'n_liveness', to: 'n_ledger', label: '失联触发', variant: 'default', role: 'async' },
  { id: 'e_patrol_liveness', from: 'n_patrol', to: 'n_liveness', label: '只播报不动作', variant: 'default', role: 'async' },
  { id: 'e_reattach_hostmsg', from: 'n_reattach', to: 'n_hostmsg', label: '重启后认得席位', variant: 'default', role: 'async' },
  { id: 'e_orphan_notify', from: 'n_orphan', to: 'n_seatnotify', label: '识别孤儿⇒重投', variant: 'default', role: 'async' },
  { id: 'e_runfail_liveness', from: 'n_runfail', to: 'n_liveness', label: '崩≠闲 · 不冻', variant: 'default', role: 'async' },
  // ---- 机制底座 · 约束链 ----
  { id: 'e_r_tokens', from: 'n_plumbing', to: 'n_tokens', label: '每席位一枚', variant: 'security', role: 'async' },
  { id: 'e_r_guard', from: 'n_tokens', to: 'n_guard', label: '越权⇒拦', variant: 'security', role: 'async' },
  { id: 'e_r_hashing', from: 'n_guard', to: 'n_hashing', label: '足迹对账', variant: 'security', role: 'async' },
  { id: 'e_r_states', from: 'n_hashing', to: 'n_states', label: '越界⇒拒', variant: 'security', role: 'async' }
]

const out = { ...src, nodes, edges }
writeFileSync(BASE, JSON.stringify(out, null, 2), 'utf8')
console.log('nodes', nodes.length, 'edges', edges.length)
