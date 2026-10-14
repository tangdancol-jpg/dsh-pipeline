import { box, txt, frame, arrow, svgWrap, C } from './svglib.mjs'

// ===========================================================================
// 图 ④-A · 派单任务端到端流程图
// ===========================================================================
export function flowDiagram() {
  const b = []
  const W = 1500, H = 2360

  b.push(txt(750, 34, '图④-A · 派单任务端到端流程图（合法事件名以实读 lib/states.js:174–259 为准）', { anchor: 'middle', size: 24, weight: 700 }))
  b.push(txt(750, 60, '实线 = 合法迁移；虚线 = 旁路（不推状态）；红虚线 = 今晚实际断掉的投递路径。所有事件名、by、guard 均逐条实读，未作推断。', { anchor: 'middle', size: 12.5, fill: '#555' }))

  // ========================================================================
  // Panel A · 主链
  // ========================================================================
  b.push(frame(30, 96, 880, 1210, 'A · 端到端主链（11 站）'))
  const steps = [
    ['① 用户下达', '用户（拓扑上唯一与 main 相连的一端）', '载体：对话框里的自然语言 / 选项卡片点选 / 截图', '本项目里就是 13 张单的 requirement 字段原文'],
    ['② 主对话登记', 'main · 唯一开单口', '事件 open（by main）→ 状态 pending', 'pipeline_task_open{reattach:true} = DSH 重启后重新认领身份的唯一入口'],
    ['③ 需求分析', 'orchestrator · 不看代码', '事件 dispatch_orchestrator（by main）→ analyzing', '产出 requirement_analysis：任务卡 + 验收标准 + 边界条件 + 测试要点', '★ unclear_points **必填**（没有也要显式给空数组）'],
    ['④ 需求确认 · 用户拍板', '用户（经 main 用 pipeline_human_relay 转告）', '事件 requirement_confirmed（by main）', 'guard = requirement_confirm_gate', '★ 判据：**没有用户答复原文，这条边过不去**'],
    ['⑤ 计划 · 分配', 'planner · 不看代码', '事件 dispatch_planner（by main）→ planning', '产出 plan：步骤 + 层清单 + 角色清单 + 授权面 change_scope', '　　　　　+ 越界清单 forbidden + 角色边界卡 + 四槽 slots'],
    ['⑥ 留档（旁路）', 'archivist · 不设闸门', '各角色 pipeline_record_submit 写自己那份（互不覆盖）', 'pipeline_compile_requirement 汇总成唯一 requirement.md', '★ 每条必须标来源；记录矛盾时**不得自拍板**，走澄清或升级'],
    ['⑦ 编写', 'writer#1..N（席位数 = 层数）', '事件 dispatch_writer（by main）→ developing', 'pipeline_artifact 登记 vN → pipeline_handoff(dev_to_test)', '⇒ dev_submitted（by writer · guard=dev_to_test）→ ready_test　★ 唯一出口'],
    ['⑧ 测试', 'tester · 不参考编写自述', '事件 dispatch_tester（by main）→ testing', '通过 ⇒ test_to_review + test_passed（guard=test_to_review）→ ready_review', '不通过 ⇒ test_to_dev + test_failed（guard=rework_budget）→ returned_to_dev'],
    ['⑨ 审核', 'reviewer · 只读 + 基线哈希前后对比', '事件 dispatch_reviewer（by main）→ reviewing', 'OK ⇒ review_verdict + review_ok（guard=review_verdict_ok）→ passed', 'NG ⇒ review_ng_dev / review_ng_test（guard=rework_budget）'],
    ['⑩ 关单', 'main · 唯一关单口', '事件 close（by main）→ closed', 'guard = close_gates', '★ 必须有针对**当前制品版本**的审核 OK；角色清单含架构图角色时还必须有架构图'],
    ['⑪ 交付用户', 'main 回报', '用户收到结果 —— 整条链闭环', '本项目 13 张单里，走到这一步的：**0 张**（见第②节进度）'],
  ]
  steps.forEach((s, i) => {
    const y = 136 + i * 104
    const c = i === 7 ? 'red' : i === 4 ? 'red' : i === 10 ? 'grey' : 'blue'
    b.push(box({ x: 150, y, w: 500, h: 84, c, title: s[0], sub: s[1], lines: s.slice(2), ts: 14.5, ls: 10.8 }))
    if (i < steps.length - 1) {
      b.push(arrow([[400, y + 84], [400, y + 104]], { marker: 'ahBlue', color: '#6c8ebf' }))
    }
    // 左侧角色标签
    b.push(txt(44, y + 44, ['用户', '主对话', '需求分析', '用户', '计划', '留档', '编写', '测试', '审核', '主对话', '主对话'][i], { size: 12, weight: 700, fill: '#555' }))
  })
  // 计划分叉：planned / plan_gap
  b.push(box({ x: 668, y: 552, w: 226, h: 98, c: 'yellow', title: '自检结论', sub: 'plan 交接物里的 self_check',
    lines: ['ok ⇒ 事件 planned', '　　（guard=plan_ready）', '　　→ ready_dev（回到主链⑦）', 'gaps ⇒ 事件 plan_gap'],
    ts: 13, ls: 10.4 }))
  b.push(arrow([[650, 594], [668, 594]], { marker: 'ahOrange', color: '#d79b00' }))
  b.push(arrow([[894, 636], [894, 656], [1000, 656]], { marker: 'ahOrange', color: '#d79b00', dash: '4 3' }))
  b.push(txt(906, 652, 'plan_gap → 走 C 面板的澄清梯', { size: 10.2, fill: '#d79b00' }))

  // ========================================================================
  // Panel B · 打回环与预算
  // ========================================================================
  b.push(frame(930, 96, 540, 500, 'B · 打回环与打回预算'))
  b.push(box({ x: 952, y: 136, w: 496, h: 152, c: 'red', title: '三条打回边（实读 states.js:221 / 228 / 229）',
    sub: '全部带 guard = rework_budget', lines: [
      '① test_failed　　by tester　　　　　testing → returned_to_dev',
      '② review_ng_dev　by reviewer|security　reviewing → returned_to_dev',
      '③ review_ng_test　by reviewer　　　　reviewing → returned_to_test',
      '',
      '回程边（刻意**不挂** rework_budget）：',
      'returned_to_dev → developing（dispatch_writer，by main）',
      'returned_to_test → testing（dispatch_tester，by main）',
    ], ts: 13.5, ls: 11 }))
  b.push(box({ x: 952, y: 300, w: 496, h: 132, c: 'orange', title: '预算语义（states.js:211–215 的注释原话）',
    lines: [
      'maxReworkPerLeg = 2（cordis.patch.yml 默认值）',
      '计数分两条腿：rework.dev / rework.test，各自独立',
      '',
      '★「预算在**打回那一刻**就已经扣过了。如果回程边再扣一次，',
      '　 就会出现『第 2 次打回成功 → 但再也派不出编写 → 任务永久',
      '　 卡在已打回编写』的死结。（第一版就是这样，自测把死结照出来了。）」',
    ], ts: 13.5, ls: 10.6 }))
  b.push(box({ x: 952, y: 444, w: 496, h: 128, c: 'grey', title: '超限后的合法出路（不是死结）',
    lines: [
      'pipeline_rework 超限 ⇒ 被拒（编辑拒绝原文会给出当前可用事件）',
      '改用 pipeline_transition{event:"block"} 交人工 —— 任意非终态可阻塞',
      '或走 pipeline_roster_request → pipeline_roster_review 追加仲裁角色',
      '',
      '实读佐证：T-20261012-6884af 在 15:06:27Z 用过一次 test_failed：',
      'audit「rework:writer | via=handoff:test_to_dev | used=1 | budget=2」',
    ], ts: 13.5, ls: 10.6 }))

  // ========================================================================
  // Panel C · 两级澄清梯
  // ========================================================================
  b.push(frame(930, 618, 540, 430, 'C · 两级澄清梯（用户只与主对话相连 ⇒ 只有这一条上升通道）'))
  b.push(box({ x: 952, y: 656, w: 496, h: 96, c: 'grey', title: '第 0 级：执行角色直接找用户',
    sub: '★ 拓扑上**不存在**这条路', lines: [
      '用户只与主对话相连，执行角色没有用户的对话框。',
      '所以「问不到人就自己猜」不是选项 —— 必须走下面两级。',
      '实读：ROLES_CAN_RAISE_HUMAN 里**没有 main**（它就在用户的对话框里，直接问即可）。',
    ], ts: 13, ls: 10.6 }))
  b.push(box({ x: 952, y: 764, w: 496, h: 116, c: 'blue', title: '第 1 级：执行/顾问角色 → 需求分析（orchestrator）',
    lines: [
      '事件 clarification_request（by ROLES_CAN_ASK_CLARIFICATION）',
      '　= architect · security · writer · tester · reviewer · release · docs',
      '　　· performance · arbiter · diagrammer · planner',
      'guard = clarification_blocking（**只有 blocking=true 才推状态**）',
      '→ awaiting_clarification（等待态，不覆盖 previous_state）',
    ], ts: 13, ls: 10.4 }))
  b.push(box({ x: 952, y: 892, w: 240, h: 102, c: 'green', title: '裁定：answered',
    lines: ['clarification_reply', '（by orchestrator）', 'guard=clarification_reply_ok', '结论：**原地继续**', '(previous)'],
    ts: 12.5, ls: 10.2 }))
  b.push(box({ x: 1208, y: 892, w: 240, h: 102, c: 'red', title: '裁定：cannot_answer',
    lines: ['同一次调用里写结论', '　⇒ 升级给用户', '★ **单向门**：一旦升级', '　这条澄清不能再改口', '　（实读 ladder 自测断言）'],
    ts: 12.5, ls: 10.2 }))
  b.push(box({ x: 952, y: 996, w: 496, h: 100, c: 'orange', title: '第 2 级：任意非 main 角色 → 用户', sub: 'guard = human_request_blocking',
    lines: ['human_request → awaiting_human',
            'main 用 pipeline_human_relay 转告（不改状态，只留痕 + 给确认码 HC-…）',
            '用户答复 ⇒ pipeline_human_reply（guard = human_reply_has_source，',
            '必须带 user_quote + attribution）→ (previous)　★ 原地继续'],
    ts: 12.5, ls: 10.2 }))

  // ========================================================================
  // Panel D · 谁有权发什么
  // ========================================================================
  b.push(frame(930, 1066, 540, 240, 'D · 合法发起方速查（by 列表，实读）'))
  b.push(box({ x: 952, y: 1104, w: 496, h: 186, c: 'white', title: '',
    lines: [
      'by = [main] 独享：open · dispatch_orchestrator · requirement_confirmed',
      '　　　　　　　dispatch_planner · dispatch_writer · dispatch_tester',
      '　　　　　　　dispatch_reviewer · close · human_reply · block/unblock/cancel',
      'by = [planner]：planned · plan_gap　　by = [planner, rule-engine]：orchestrated（L0）',
      'by = [writer]：dev_submitted　　　by = [tester]：test_passed · test_failed',
      'by = [reviewer]：review_ok · review_ng_test　　by = [reviewer, security]：review_ng_dev',
      'by = [orchestrator]：clarification_reply',
      'by = ROLES_CAN_RAISE_HUMAN（除 main 外全部角色）：human_request',
      'by = ROLES_CAN_ASK_CLARIFICATION（执行/顾问 11 个角色）：clarification_request',
      'by = [main, human]：block · unblock · cancel',
      '',
      '★ 主对话不能替任何角色发它的事件；角色也发不了主对话的事件。',
      '★ T-20261012-8cdee0 用户口径指出的缺口正在这里：',
      '　 **「编写→主管/需求，主管→主对话/需求」这一层在 by 列表里不存在。**',
    ], ts: 13, ls: 10.4 }))

  // ========================================================================
  // Panel E · 唤醒投递路径 + 今晚断掉的
  // ========================================================================
  b.push(frame(30, 1336, 1440, 966, 'E · 唤醒的投递路径（谁该叫醒谁）＋ 今晚实际断掉的 6 处 ＋ 缺失的那一层'))

  // 拓扑
  b.push(box({ x: 60, y: 1398, w: 210, h: 94, c: 'blue', title: '席位', sub: '编写 / 测试 / 审核 / 顾问 / 需求 / 计划',
    lines: ['每个席位有自己的会话', 'PT-… 令牌绑定身份'], ts: 13.5, ls: 10.6 }))
  b.push(box({ x: 430, y: 1398, w: 210, h: 94, c: 'blue', title: '主对话 main', sub: '用户唯一的对话框',
    lines: ['task.contacts.main（落盘）', 'mainSessions registry（内存）'], ts: 13.5, ls: 10.6 }))
  b.push(box({ x: 800, y: 1398, w: 150, h: 94, c: 'blue', title: '用户', sub: '只在主对话里',
    lines: ['点选 / 手输 / 截图'], ts: 13.5, ls: 10.6 }))
  b.push(box({ x: 1010, y: 1398, w: 200, h: 94, c: 'orange', title: '机制', sub: 'liveness / 状态机 / 闸门',
    lines: ['冻结播报 · 闸门升级 · 预算超限'], ts: 13.5, ls: 10.6 }))
  b.push(box({ x: 1270, y: 1398, w: 170, h: 94, c: 'green', title: '主管 supervisor', sub: '角色已登记 · 不在拓扑里',
    lines: ['roles.js:160 有这条', 'states.js 里没有它的站'], ts: 13.5, ls: 10.6 }))

  // 通路
  b.push(arrow([[270, 1424], [430, 1424]], { marker: 'ahGreen', color: '#82b366' }))
  b.push(txt(350, 1414, '✅ deliverWake', { anchor: 'middle', size: 10.4, fill: '#82b366' }))
  b.push(txt(350, 1444, '(1) 交付 / 提问 / 人工请求', { anchor: 'middle', size: 9.6, fill: '#666' }))

  b.push(arrow([[640, 1424], [800, 1424]], { marker: 'ahBlue', color: '#6c8ebf' }))
  b.push(txt(720, 1416, '转告 relay', { anchor: 'middle', size: 10.4, fill: '#6c8ebf' }))
  b.push(arrow([[800, 1456], [640, 1456]], { marker: 'ahBlue', color: '#6c8ebf' }))
  b.push(txt(720, 1476, '答复 reply', { anchor: 'middle', size: 10.4, fill: '#6c8ebf' }))

  // 机制 → 主对话（走下方，避开用户盒）
  b.push(arrow([[1110, 1492], [1110, 1516], [535, 1516], [535, 1492]], { marker: 'ahRed', color: '#b85450' }))
  b.push(txt(830, 1512, '⚠ 机制 → 主对话（冻结播报 / 闸门升级 / 预算超限）', { anchor: 'middle', size: 10.4, fill: '#b85450' }))

  // 回投席位（虚线，标 ⚠）
  b.push(arrow([[480, 1492], [480, 1548], [165, 1548], [165, 1492]], { marker: 'ahOrange', color: '#d79b00', dash: '5 3' }))
  b.push(txt(560, 1544, '⚠ (2) 裁定 / 人工答复 → 发起席位（wakeResumedSeat / nudgeSeat）', { anchor: 'middle', size: 10.4, fill: '#d79b00' }))

  // 缺失的一层
  b.push(arrow([[165, 1398], [165, 1374], [1355, 1374], [1355, 1398]], { marker: 'ahRed', color: '#b85450', dash: '7 4' }))
  b.push(txt(760, 1368, '✗ 缺失：席位 ⇄ 主管/需求　·　✗ 缺失：主管 → 主对话/需求', { anchor: 'middle', size: 11, weight: 700, fill: '#b85450' }))

  // 断点表
  b.push(box({ x: 60, y: 1596, w: 1380, h: 686, c: 'white', title: '今晚在真单上实测到的 6 种「吞掉唤醒」+ 1 处缺失（每条都带审计原文或数字）',
    lines: [], ts: 15 }))

  const fails = [
    ['吞法 1 · 静默跳过', 'wake:skipped | reason=no-stable-identity | kind=clarify', 'T-20261012-8cdee0 audit 2026-10-12T15:36:58Z；T-20261012-6884af audit 14:36:22Z。hint 原文：「这一次既没在工具返回值里读到交付身份，台账里也没有对应类别的记录 ⇒ **不播报**（改前会退回"任务历史长度"这个递增计数器，那保证每次都不同 ⇒ 去重永不命中 ⇒ 同一条交付反复重放）」。'],
    ['吞法 2 · 去重吃掉不同消息', 'wake:delivered | note=目标会话里已有同一条（确定性消息 id 命中），不再注入。', 'T-20261011-214043 audit 2026-10-12T15:14:01Z。关键：这条 note 意味着**「任务被冻结」的播报从未送达主对话** —— 审计写着 delivered，实际一次都没注入。（另见 §18 记载：该单 20 条 wake:skipped reason=no-main-session）'],
    ['吞法 3 · 拿错身份', '键 = T-20261012-6884af|handoff|tester|H-7d661abef1479500', 'T-20261012-6884af audit 2026-10-12T15:06:16Z：测试席交的交付唤醒，键里用的是**编写席**那份 handoff 的 id —— 账本里那条新交接物（test_to_dev H-f48fbeb883344e39）根本没被引用。'],
    ['吞法 4 · 延迟重放', '同一条事件在已处理完之后再响一次', 'T-20261012-6884af|clarify|writer#1|CQ-ae58365e3cdea060（audit 15:14:41Z 已投过一次，15:20:50Z 又一次 wake:delivered）。另 §18 记载重放链 h215→h216→h220→h228→h233→h237（同一人工请求被播报三遍）。'],
    ['吞法 5 · 投错单', '同一主对话在 A 单交的记录，被报成 B 单的交付', 'T-20261012-8cdee0 的 records/main.md 修订 3（sha256 96802d69…，1248 B）登记了这条：**三次复现**。records/main.json 的 sections 第 1 条即「第五种错法：投错单」。'],
    ['吞法 6 · 无主会话可投', 'wake:skipped | reason=no-main-session | hint=主对话还没调用过任何 pipeline 工具，且 task.contacts.main 里也没有登记 ⇒ 不知道唤醒该投到哪。', '实读 T-20261011-214043 audit：2026-10-11 共 **20 条**（13:48:10Z ×2、13:48:32Z、13:48:51Z、13:48:59Z、13:49:13Z、13:59:13Z、13:59:19Z、13:59:43Z、14:45:06Z、14:45:36Z、14:46:23Z、14:47:00Z、14:47:05Z、14:47:13Z、14:47:24Z、14:47:36Z、14:53:56Z、14:53:57Z、14:54:06Z）。'],
    ['✗ 缺失的一层', '用户口径（T-20261012-8cdee0 records/main.md 修订 1）：「上报流程问题：编写→主管/需求，主管→主对话/需求，而现在缺失这一层」', '实读佐证：states.js:148–162 的 ROLES_CAN_RAISE_HUMAN 里只有 orchestrator/planner/architect/security/writer/tester/reviewer/release/docs/performance/arbiter/human —— **没有 supervisor**；roles.js:182 的 supervisor.handoffKinds 只有 [human_request, clarification_reply, seat_handover]，也就是说「主管向上报」这条边**在表里就不存在**。'],
  ]
  let fy = 1650
  fails.forEach(([t, ev, src]) => {
    b.push(box({ x: 72, y: fy, w: 300, h: 76, c: 'red', title: t, lines: [], ts: 13 }))
    b.push(txt(388, fy + 22, ev, { size: 10.6, mono: true, fill: '#7a2b28' }))
    // 源说明按字符宽度折行
    const maxCh = 96
    const chunks = []
    let rest = src
    while (rest.length > 0) { chunks.push(rest.slice(0, maxCh)); rest = rest.slice(maxCh) }
    chunks.slice(0, 3).forEach((c, i) => b.push(txt(388, fy + 40 + i * 15, c, { size: 10.4, fill: '#444' })))
    fy += 84
  })

  b.push(txt(750, 2330, '图④-A 完。配套的「应然 vs 实然对照图」见图④-B。所有事件名/guard/状态名均实读 lib/states.js；所有审计原文均实读 .pipeline\\<task>\\audit.jsonl。', { anchor: 'middle', size: 11, fill: '#777' }))

  return svgWrap(W, H, b.join('\n'))
}

// ===========================================================================
// 图 ④-B · 「主管枢纽」应然 vs 实然对照图
// ===========================================================================
export function hubDiagram() {
  const b = []
  const W = 1500, H = 1560

  b.push(txt(750, 34, '图④-B · 「主管枢纽」目标拓扑：应然 vs 实然', { anchor: 'middle', size: 24, weight: 700 }))
  b.push(txt(750, 60, '应然 = T-20261011-56a37e 的 task.json → requirement 字段（用户原话照抄，未替我改语义）　|　实然 = 实读 lib/states.js TRANSITIONS / lib/roles.js ROLES / 各单 task.json', { anchor: 'middle', size: 12, fill: '#555' }))

  // ---------------- 应然 ----------------
  b.push(frame(30, 96, 710, 1180, '应然（用户设计 · T-20261011-56a37e 原话）'))
  b.push(box({
    x: 52, y: 136, w: 666, h: 114, c: 'yellow', title: '用户原话（照抄）',
    lines: [
      '「再修插件逻辑，应该让用户下达任务→主对话转发→主管发起（需求分析/计划/架构ai）对话',
      '→主管将主对话转发内容交给需求ai分析同时计划和架构ai待机→需求ai分析将结果提交主管',
      '→同意后交给架构ai先画架构图→架构图完成后给主管确认是否满足要求→主管确认后交给',
      '计划ai并由计划ai安排其他ai干活→编程ai干活完成后提交给测试ai（测试ai提前收到计划ai',
      '安排任务内容）→测试无问题后提交给主管和需求ai确认→无问题后交给审核验收→无问题提交',
      '给主管和需求，确认后提交主对话→用户收到结果」',
    ], ts: 13, ls: 10.2,
  }))
  b.push(box({
    x: 52, y: 260, w: 666, h: 88, c: 'orange', title: '主对话整理的 5 条差异（原话里写明「与现行顺序不同 ✗」）',
    lines: [
      '① 主管成为枢纽：由它**发起**（需求分析 / 计划 / 架构）三方对话',
      '② 架构图前置：需求确认后 → **先出架构图** → 主管确认 → **才**交计划（现行是「计划 → 架构 → 安全 → 编写」）',
      '③ 计划 / 架构**待机**：主管发起后先待机，到点才动　　④ 测试**提前预 brief**（现行是编写完才给测试）',
      '⑤ 多道双确认：共 5 道（见下）',
    ], ts: 13, ls: 10.4,
  }))

  const ideal = [
    ['用户下达任务', '主对话转发', 'grey'],
    ['主管发起三方对话', '需求分析 / 计划 / 架构 —— 后两者【待机】', 'green'],
    ['需求分析出结论', '★ 双确认①：结果提交主管 → **主管同意**', 'green'],
    ['架构位出架构图', '★ 双确认②：架构图完成 → **主管确认是否满足要求**', 'green'],
    ['计划位接活', '唤醒点：主管确认架构图满足要求之后才动', 'green'],
    ['计划位安排执行位干活', '★ 测试位**提前**收到计划给它的任务内容（预 brief）', 'green'],
    ['编写完成 → 交测试', '—', 'blue'],
    ['测试无问题', '★ 双确认③：提交 **主管 + 需求** 双方确认', 'green'],
    ['审核验收无问题', '★ 双确认④：**主管 + 需求** 再确认', 'green'],
    ['提交主对话 → 用户收到结果', '★ 第⑤道：主对话关单并交付', 'blue'],
  ]
  ideal.forEach((s, i) => {
    const y = 362 + i * 88
    b.push(box({ x: 52, y, w: 666, h: 72, c: s[2], title: s[0], lines: [s[1]], ts: 13.5, ls: 11 }))
    if (i < ideal.length - 1) b.push(arrow([[385, y + 72], [385, y + 88]], { marker: 'ahBlue', color: '#6c8ebf' }))
  })

  // ---------------- 实然 ----------------
  b.push(frame(770, 96, 700, 1180, '实然（实读代码与账本）'))
  const real = [
    ['主对话仍是唯一推手', '★ states.js:174–232 里，open / dispatch_orchestrator / dispatch_planner / dispatch_writer / dispatch_tester / dispatch_reviewer / close 的 by **全部是 [main]**。T-20261011-5a871c 想改的正是这个（「把开对话权交给需求分析/主管/计划这条链」）。', 'red'],
    ['主管角色已登记，但不在状态机里', '★ roles.js:160–193 有 ROLE.SUPERVISOR（zh「主管」· kind=control · writes=readonly · handoffKinds=[human_request, clarification_reply, seat_handover] · canRework=false · canRequestRosterChange=false）。但 states.js 的 TRANSITIONS **没有任何一条 by 里出现 supervisor**，也没有「主管确认」这一站。', 'red'],
    ['架构图不在计划之前', '★ 现行顺序（T-20261011-214043 的 roster.sequence）是 orchestrator → planner → architect/security → writer/tester/reviewer → diagrammer → archivist；55a37e 的 change_scope 备注也写明「现行是计划 → 架构 → 安全 → 编写」。**没有「架构图前置」这条硬序。**', 'red'],
    ['没有「待机」语义', '★ 状态机里没有 standby 状态，也没有「已登记未开工」的可见态；最接近的是 ready_dev（待开发）。', 'red'],
    ['没有「测试提前预 brief」', '★ tester 的交接物白名单里没有「预登记」类型；测试位的输入只有 dev_to_test。', 'red'],
    ['五道双确认只落地了 1 道', '★ 落地的那道：close 的 guard=close_gates（必须有针对**当前制品版本**的审核 OK）。另外四道（主管同意需求 / 主管确认架构图 / 测试后主管+需求双确认 / 审核后主管+需求确认）在 states.js 里**一条都不存在**。', 'red'],
    ['双确认的「两次独立」语义无处安放', '★ T-20261011-5a871c 的验收 C2 要求「两次确认 = 审计里两条独立记录，各自独立的时间戳与结论」；实读 5a871c 的 audit.jsonl，**没有**任何 double-confirm 记录。', 'red'],
  ]
  real.forEach((s, i) => {
    const y = 136 + i * 162
    b.push(box({ x: 792, y, w: 656, h: 148, c: s[2], title: s[0], lines: [], ts: 14 }))
    const maxCh = 62
    const chunks = []
    let rest = s[1]
    while (rest.length > 0) { chunks.push(rest.slice(0, maxCh)); rest = rest.slice(maxCh) }
    chunks.slice(0, 8).forEach((c, j) => b.push(txt(802, y + 42 + j * 13.4, c, { size: 10.6, fill: '#222' })))
  })

  // ---------------- 差集 ----------------
  b.push(frame(30, 1306, 1440, 224, '差集 —— 要把「实然」推到「应然」，缺的是这 6 件事（按可判据化程度排序）'))
  const gaps = [
    ['G1', '主管站进状态机', '新增状态 + 事件（by=supervisor）', '5a871c 验收 C1 已给判据：状态迁移表里**不存在**「需求确认 → 直接进计划」的合法边'],
    ['G2', '两次独立确认', '两条各自留痕的审计记录 + 未完成不得下放', 'C2/C3 已给判据：只做一次就尝试下放 ⇒ 拒'],
    ['G3', '主管向上报的通道', '把 supervisor 加进 ROLES_CAN_RAISE_HUMAN', '★ 8cdee0 用户口径点名的就是这一条：「主管→主对话/需求，而现在缺失这一层」'],
    ['G4', '架构图前置硬序', '56a37e 验收第 2 条：主管确认架构图之前，计划产物不得出现', '需在 states.js 加一条 guard，并有可复现的拒绝断言'],
    ['G5', '待机与两个唤醒点', '架构位/计划位的「已登记未开工」可见态', '两个唤醒点 = 主管同意需求结论 / 主管确认架构图满足要求'],
    ['G6', '测试位预 brief', '计划位 → 测试位的任务内容预登记交接物', '56a37e 验收第 3 条：测试位的交付里必须写明「我提前收到的任务内容」'],
  ]
  gaps.forEach((g, i) => {
    b.push(box({ x: 52 + i * 238, y: 1346, w: 226, h: 164, c: 'orange', title: g[0] + ' · ' + g[1], lines: [], ts: 12.5 }))
    const chunk = (s, n) => { const o = []; let r = s; while (r.length) { o.push(r.slice(0, n)); r = r.slice(n) } return o }
    chunk(g[2], 26).slice(0, 3).forEach((c, j) => b.push(txt(62 + i * 238, 1378 + j * 13, c, { size: 10.2, fill: '#333' })))
    b.push(`<line x1="${62 + i * 238}" y1="${1428}" x2="${268 + i * 238}" y2="${1428}" stroke="#d79b00" stroke-width="0.9"/>`)
    chunk(g[3], 26).slice(0, 6).forEach((c, j) => b.push(txt(62 + i * 238, 1446 + j * 13, c, { size: 10, fill: '#7a5b00' })))
  })

  b.push(txt(750, 1550, '说明：T-20261011-56a37e 的本体状态是 ready_dev（待开发），artifact_version_counter = 0，artifacts = 0，三个编写席全部零制品 ⇒ 上图「应然」的 10 站**一站都没落地**。', { anchor: 'middle', size: 11.5, fill: '#b85450', weight: 700 }))

  return svgWrap(W, H, b.join('\n'))
}
