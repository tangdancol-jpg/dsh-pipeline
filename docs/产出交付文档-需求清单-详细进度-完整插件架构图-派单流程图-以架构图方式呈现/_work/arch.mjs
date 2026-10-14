import { box, txt, frame, arrow, svgWrap, C } from './svglib.mjs'

// ===========================================================================
// 图 ③-A · dsh-pipeline 完整插件架构图
//   几何：所有盒子高度按 svglib 的 need() 核算过，不留溢出
// ===========================================================================
export function archDiagram() {
  const b = []
  const W = 1500, H = 2210

  b.push(txt(750, 34, '图③-A · dsh-pipeline 插件完整架构图', { anchor: 'middle', size: 26, weight: 700 }))
  b.push(txt(750, 60, '实读生效副本：<DSH_HOME>\\profiles\\desktop\\node_modules\\dsh-pipeline —— 22 个 lib 模块 + 1 个 transport 子目录 + 1 个客户端半边 + 29 套自测', { anchor: 'middle', size: 12.5, fill: '#555' }))

  // --- 图例 ---
  const leg = [
    ['blue', '常规模块（今晚未动）'],
    ['red', '今晚（10-12 夜 20:10–22:46）改过'],
    ['orange', '今晚改过 · 仍有病'],
    ['green', '今晚新增 / 新角色'],
    ['purple', '四类不变量落点'],
    ['grey', '数据面 / 非本插件'],
  ]
  let lx = 120
  b.push(txt(38, 96, '图例', { size: 12.5, weight: 700 }))
  for (const [c, label] of leg) {
    b.push(`<rect x="${lx}" y="85" width="15" height="15" rx="3" fill="${C[c].fill}" stroke="${C[c].stroke}" stroke-width="1.4"/>`)
    b.push(txt(lx + 21, 97, label, { size: 12 }))
    lx += 15 + 21 + [...label].length * 12.4 + 22
  }

  const RL = (y, s) => txt(44, y, s, { size: 12, weight: 700, fill: '#666' })

  // ========================================================================
  // ① 宿主半边
  // ========================================================================
  b.push(frame(30, 118, 1440, 692, '① 宿主半边（Node / Cordis 进程）—— 工具、判据、账本、通道都在这一半'))

  RL(184, '入口与装配')
  b.push(box({
    x: 180, y: 132, w: 476, h: 98, c: 'red', title: 'index.js · apply(ctx, rawConfig)',
    sub: '插件入口：依赖装配 → 注册 → 索引',
    lines: ['装配：令牌表 / 任务账本 / 派活通道 / 唤醒器 / 总开关',
            '注册 29 个 pipeline_* 工具 + 守门链 + 拦截缝（tools/pre-execute 等）',
            '同步任务索引 taskIndex：进程内存，重启即空（诚实边界，源码注释写明）'],
    ts: 13, ls: 11,
  }))
  b.push(box({
    x: 666, y: 132, w: 350, h: 98, c: 'blue', title: 'lib/config.js', sub: 'DEFAULTS / mergeConfig',
    lines: ['changeScopeAnchor = 授权面锚点', '（默认插件包根，不是项目根）',
            'seatSilenceMs / maxReworkPerLeg', 'requireHumanConfirmCode / hashGateEscalateAfter'],
    ts: 13, ls: 11,
  }))
  b.push(box({
    x: 1026, y: 132, w: 414, h: 98, c: 'blue', title: 'lib/switch.js + lib/switch-routes.js',
    sub: '「多 AI 协调」总开关 = Web GUI 右上角那个按钮',
    lines: ['状态落盘 .pipeline/switch.json，重启保持（实读当前 on:false rev:9）',
            'HTTP 端点 /.dsh-pipeline/state（仅 loopback 可达）',
            '关 ≠ 卸载：守卫照旧注册，守门第一句弃权（改链序会造成用户可见抖动）'],
    ts: 13, ls: 11,
  }))

  RL(272, '工具面')
  b.push(box({
    x: 180, y: 240, w: 880, h: 96, c: 'red', title: 'lib/tools.js · 29 个 pipeline_* 工具（230,154 B · 今晚改过）',
    sub: 'task_open · orchestrate · plan · dispatch · handoff · artifact · transition · close · clarify_request / clarify_reply · human_request / human_relay / human_reply · roster_request / roster_review · status · selftest · boundaries · change_audit · security_check · succession · switch · record_submit · compile_requirement · context_report · rework · full_test · contacts · bind_role',
    lines: ['★ 工具是唯一能写 task.json / audit.jsonl / handoffs/ 的口（文件工具写不进去 —— 这是「状态只有一处」的实现）',
            'defineTool 退化兜底：宿主不供定义时工具自己吐严格 JSON Schema（objSchemaStrict）',
            '★ 每次工具调用结束 → 登记主对话会话（唤醒的登记点，不依赖任何特定路径）'],
    ts: 13, ls: 10.6,
  }))
  b.push(box({
    x: 1070, y: 240, w: 370, h: 96, c: 'blue', title: 'lib/context.js', sub: '席位水位自报与继任',
    lines: ['validateContextReport：水位只能席位自报', '（DSH 没有面向插件的上下文用量接口）',
            'relayPolicy：warn 45 / trigger 55 / hardLimit 75',
            'checkSuccessionActor / checkRelayAuthorization / validateSeatHandover'],
    ts: 13, ls: 10.6,
  }))

  RL(398, '判据面\n（谁被拒）')
  b.push(box({
    x: 180, y: 348, w: 278, h: 120, c: 'orange', title: 'lib/guard.js', sub: '守门判据主体（88,064 B）',
    lines: ['decide()：按角色 writes 判文件读写', 'NO_CODE_READ_ROLES = main / orchestrator / planner',
            'scanTestRunnerCommand：编写不得跑测试', 'owningChangeScopeEntry：授权面归属判定',
            '⚠ 判据不稳定：同形状命令先放行后拒绝', '　（今晚 3 次，无法稳定复现）'],
    ts: 13, ls: 10.6,
  }))
  b.push(box({
    x: 468, y: 348, w: 212, h: 120, c: 'orange', title: 'lib/guard-factory.js', sub: 'fail-closed 包装',
    lines: ['createGuardFor(deps)', '内部异常 → 「守门内部异常，', '　按 fail-closed 拒绝」',
            '⚠ B9 只修了一半：冷索引时', '　「整段跳过」的 fail-open 仍在'],
    ts: 12.5, ls: 10.4,
  }))
  b.push(box({
    x: 690, y: 348, w: 300, h: 120, c: 'red', title: 'lib/handoff.js', sub: '交接物形状与方向（99,046 B）',
    lines: ['HANDOFF_SCHEMAS：每种 kind 的固定字段（缺字段即拒）',
            '方向表 HANDOFF_DIRECTION（谁能交给谁）',
            'validateRoleScope / validateChangeScope / validateRoleBoundaries',
            '★ 三权分立在此落判据：writer 白名单里没有 test_to_review / review_verdict'],
    ts: 12.5, ls: 10.4,
  }))
  b.push(box({
    x: 1000, y: 348, w: 228, h: 120, c: 'red', title: 'lib/hashgate.js', sub: '哈希前置闸门',
    lines: ['hashGateVerdict：改动面 vs 授权面', '三类越界：越权新增 / 越权修改 /',
            '　　　　　声明不实', '连续 3 次不通过 ⇒ 升级人工', 'hashGateBlocksTests：闸门不过禁跑全量'],
    ts: 12.5, ls: 10.4,
  }))
  b.push(box({
    x: 1238, y: 348, w: 202, h: 120, c: 'blue', title: 'lib/testscope.js', sub: '全量测试四级审批',
    lines: ['classifyTestCommand 分类命令', 'sameTestCommand：批一条跑另一条 =',
            '　没审批', '默认只跑定向 / 增量'],
    ts: 12.5, ls: 10.4,
  }))

  RL(512, '状态与\n角色面')
  b.push(box({
    x: 180, y: 480, w: 258, h: 98, c: 'red', title: 'lib/states.js', sub: '状态机（唯一权威）',
    lines: ['ST 18 个状态 · TRANSITIONS 迁移表（by + guard）',
            '等待态不覆盖 previous_state（否则永久卡死）',
            'resolveUnblockRecovery 恢复点'],
    ts: 13, ls: 10.8,
  }))
  b.push(box({
    x: 448, y: 480, w: 258, h: 98, c: 'blue', title: 'lib/roles.js', sub: '角色表 = 能力边界',
    lines: ['ROLES：writes / handoffKinds / canRework',
            '★ ROLE.SUPERVISOR 已登记（只读 · 白名单无 review_verdict）',
            '白名单方向：忘了加 = 少一条能力'],
    ts: 13, ls: 10.8,
  }))
  b.push(box({
    x: 716, y: 480, w: 348, h: 98, c: 'red', title: 'lib/tiers.js', sub: '档位 / 角色清单 / 四槽（59,821 B）',
    lines: ['TIERS L0–L5 · proposeTier · buildRoster · buildWriters',
            '四槽 ROSTER_SLOT_KEYS = permission / mode / model / reasoning',
            '权限三档 read-only · workspace-write · danger-full-access（未指定取最小档）',
            'dispatchOpenRecord：每次开对话留痕（accept 与 reject 都留）'],
    ts: 12.5, ls: 10.6,
  }))
  b.push(box({
    x: 1074, y: 480, w: 366, h: 98, c: 'blue', title: 'lib/boundaries.js', sub: '边界清单（诚实分档）',
    lines: ['RULES R1–R8 · class = (a) 已判据化 —— 每条指向 guard/store 的函数名',
            'ADVISORY_LIMITS C1–… · class = (c) 判据化不了，如实写明为什么',
            'boundaryManifest() 只读导出 —— 给 DSH 层钩子读，不必读本插件源码'],
    ts: 12.5, ls: 10.6,
  }))

  RL(640, '账本与\n通道面')
  b.push(box({
    x: 180, y: 590, w: 296, h: 118, c: 'red', title: 'lib/store.js', sub: '任务账本（325,426 B · 最大模块）',
    lines: ['task.json 读写 · audit.jsonl 只追加（appendJsonl）',
            'planAdvance：交接物 → 状态推进的唯一实现',
            'checkAllSeatsSubmitted = dev_submitted 的门（三席齐备判据）',
            'sampleSessionActivity / checkLiveness：会话活动采样',
            '⚠ root===null ⇒ gate_applicable:false（B2 未修根因）'],
    ts: 12.5, ls: 10.4,
  }))
  b.push(box({
    x: 486, y: 590, w: 388, h: 118, c: 'red', title: 'lib/transport/index.js', sub: '派活通道（57,321 B）',
    lines: ['SessionTransport（真实会话）· SubagentTransport（provider=spawn）',
            'ManualTransport / SimulatedTransport / UnreachableTransport',
            'FULL_PERMISSION_CHAIN = [orchestrator, main, user]（完全档三段链）',
            'ensureProjectGroup：会话按项目分组（B7 修：组名取项目名）',
            '⚠ 实读 dispatched[] 全部 via="subagent" ⇒ 真实会话通道未被真单走过'],
    ts: 12.5, ls: 10.4,
  }))
  b.push(box({
    x: 884, y: 590, w: 140, h: 118, c: 'blue', title: 'lib/tokens.js', sub: '席位令牌',
    lines: ['createTokenStore', 'DEFAULT_TOKEN_TTL_MS', '　= 2 小时', 'PT-… 绑定席位与角色',
            '★ 只在内存 ⇒ DSH 重启', '　即失效（孤儿单成因）'],
    ts: 12, ls: 10.2,
  }))
  b.push(box({
    x: 1034, y: 590, w: 150, h: 118, c: 'red', title: 'lib/hostmsg.js', sub: '宿主消息唯一出口',
    lines: ['hostMessage(spec)', '必带 source.kind', '（缺它 ⇒ 子会话', '　277 ms 静默死亡）',
            '（缺 id ⇒ 会话历史', '　加载失败）'],
    ts: 12, ls: 10.2,
  }))
  b.push(box({
    x: 1194, y: 590, w: 246, h: 118, c: 'orange', title: 'lib/wakeup.js', sub: '唤醒器（57,619 B · 今晚改过）',
    lines: ['wakeKeyOf = taskId|kind|actor|稳定身份',
            'ledgerIdentityOf：身份从台账取，',
            '　绝不退到递增计数器',
            'deliverWake：(a) agents.followup 保 source（首选）',
            '　(b) sessionController.prompt 改写为 user（留痕）',
            '⚠ 取不到身份 ⇒ wake:skipped 静默跳过'],
    ts: 12, ls: 10.2,
  }))

  b.push(box({
    x: 180, y: 718, w: 380, h: 96, c: 'orange', title: 'lib/liveness.js', sub: '席位存活判据（30,416 B · 今晚改过）',
    lines: ['seatLiveness()：5 分钟静默阈值 · evidenceOfLife（交接物/流水/水位）',
            'B2 第四条判据：会话日志 size/mtime 是否在长',
            '⚠ gateOn 被 gateApplicable 关掉 ⇒ 退回「一次安静即冻结」'],
    ts: 12.5, ls: 10.4,
  }))
  b.push(box({
    x: 570, y: 718, w: 330, h: 96, c: 'blue', title: 'lib/security.js', sub: 'pipeline_security_check',
    lines: ['泄密面：密钥 / 凭证 / 隐私出现在制品、报告、日志、收据、audit.jsonl',
            '网络面：外联地址 / 未解释外联 / 凭证出网',
            '结果只回「哪个文件第几行命中哪一类」+ 打码片段'],
    ts: 12.5, ls: 10.4,
  }))
  b.push(box({
    x: 910, y: 718, w: 288, h: 96, c: 'blue', title: 'lib/util.js', sub: '路径与哈希基元',
    lines: ['PACKAGE_ROOT · resolveAgainstAnchor · toAbsolute',
            'isInside / pathKey（授权面与守门共用同一套路径解析）',
            'stableStringify · shortHash · fullHash · newTaskId'],
    ts: 12.5, ls: 10.4,
  }))
  b.push(box({
    x: 1208, y: 718, w: 232, h: 96, c: 'red', title: 'lib/intercept.js', sub: '拦截缝（29,727 B）',
    lines: ['INTERCEPT_EVENTS：tools/pre-execute ·', '　agent/pre-step · tools/post-execute',
            'seatBriefing：席位简报 + 「四问」注入（stop-ladder）',
            'LIVENESS_CHECK_THROTTLE_MS = 60s'],
    ts: 12, ls: 10.4,
  }))

  // ========================================================================
  // ② 客户端半边
  // ========================================================================
  b.push(frame(30, 848, 1440, 122, '② 客户端半边（Web GUI · 浏览器）—— 只有开关与展示，不持有任何判据'))
  b.push(box({
    x: 180, y: 882, w: 560, h: 78, c: 'blue', title: 'lib/client.js（14,903 B · 非 ESM）',
    sub: '经典脚本，靠 window.__ModuleLoader__.load({id, factory}) 注册',
    lines: ['挂载点：conversation.session.header.utilities —— list 槽，可与他人共存（给 id + order 即可）',
            '⚠ 没有「窗口级顶栏」槽；shell.leading 只在 macOS 且侧栏收起时挂载 ⇒ Windows 不渲染'],
    ts: 12.5, ls: 10.8,
  }))
  b.push(box({
    x: 750, y: 882, w: 300, h: 78, c: 'blue', title: '多 AI 协调开关按钮', sub: '读 / 写宿主开关',
    lines: ['fetch(\'/.dsh-pipeline/state\') 相对同端口', '与宿主 switch.js 是同一个开关位'],
    ts: 12.5, ls: 10.8,
  }))
  b.push(box({
    x: 1060, y: 882, w: 380, h: 78, c: 'grey', title: '⚠ 不属本插件：询问卡 / 提问气泡',
    sub: '宿主 @deepseek-ai/dsh-user-questions + dsh-client-ui-tool',
    lines: ['「主界面弹不出能点的气泡」是宿主侧缺陷（今晚另有三轮修复任务）',
            '本插件的 pipeline_human_request 只负责把请求写进账本并唤醒主对话'],
    ts: 12.5, ls: 10.8,
  }))

  // ========================================================================
  // ③ 角色层
  // ========================================================================
  b.push(frame(30, 1000, 1440, 292, '③ 角色层（lib/roles.js 的 ROLES 表 = 能力边界表；忘加 = 少一条能力，忘删 = 悄悄多一条）'))
  b.push(txt(44, 1044, '控制角色\nwrites = readonly', { size: 11.5, weight: 700, fill: '#666' }))
  const ctrl = [
    ['main', '主对话 · Main', '只调度不干活 · 不看代码 · 不做技术判断', '唯一关单口（close）· 唯一转告用户口'],
    ['orchestrator', '需求分析 · Orchestrator', '出任务卡 + 不清楚处清单（不分配 AI）', '★ 两级澄清梯的第一级：答执行角色的问题'],
    ['planner', '计划 · Planner', '出计划 → 自检 → 分配角色清单与授权面', '自检 gaps 时退回需求分析，不自行分配'],
    ['supervisor', '主管 · Supervisor ★新登记', '需求确认后那一站：两次独立确认后下放', '只读 · 白名单无 review_verdict / dev_to_test'],
  ]
  ctrl.forEach(([id, zh, l1, l2], i) => {
    b.push(box({
      x: 180 + i * 312, y: 1030, w: 300, h: 88, c: id === 'supervisor' ? 'green' : 'blue',
      title: zh, sub: 'writes = readonly',
      lines: [l1, l2], ts: 13, ls: 10.6,
    }))
  })
  b.push(txt(44, 1160, '执行角色\n三权分立', { size: 11.5, weight: 700, fill: '#666' }))
  const exec = [
    ['writer', '编写 · Writer', 'writes = workdir（项目源码树）', 'handoffKinds：dev_to_test · human_request · clarification_request', '★ 白名单里没有 test_to_review / review_verdict ⇒ 交不到审核'],
    ['tester', '测试 · Tester', 'writes = own-dir（reports/ 与自有目录）', 'handoffKinds：test_to_review · test_to_dev · full_test_request', 'canRework = true（可打回编写）· 默认只跑定向测试'],
    ['reviewer', '审核 · Reviewer', 'writes = own-log（只有自己的日志文件）', 'handoffKinds：review_verdict（唯一能出审核结论的角色）', 'canRework = true（可打回编写或测试）'],
  ]
  exec.forEach(([id, zh, l1, l2, l3], i) => {
    b.push(box({
      x: 180 + i * 416, y: 1148, w: 404, h: 92, c: 'purple',
      title: zh, sub: '三权分立的一极',
      lines: [l1, l2, l3], ts: 13, ls: 10.5,
    }))
  })
  b.push(box({
    x: 180, y: 1252, w: 1240, h: 44, c: 'grey', title: '',
    lines: ['顾问角色（writes = own-dir，只写自己的 reports/ 目录，不持有三权中任何一权的写权限）：architect · security · diagrammer · archivist · release · docs · performance · arbiter　|　其它：human（人工出口）'],
    ts: 10, ls: 11,
  }))

  // ========================================================================
  // ④ 四类不变量
  // ========================================================================
  b.push(frame(30, 1322, 1440, 206, '④ 四类不变量 —— 任何一单都不许改它们，只能「把新站点纳入同一套判据」'))
  const inv = [
    ['三权分立', 'writer / tester / reviewer 互不兼任', ['判据落点：', '· roles.js handoffKinds 白名单', '· states.js TRANSITIONS 的 by 列表', '· handoff.js 方向表 HANDOFF_DIRECTION', '反例：writer 交 test_to_review ⇒ 拒']],
    ['闸门链', '每条迁移须由合法角色带合法事件触发', ['判据落点：', '· states.js:172–260 TRANSITIONS（by + guard）', '· store.js planAdvance 的实现', '· applyTransition / explainRefusal', '反例：跳步 / 单确认冒充双确认 ⇒ 拒']],
    ['守门作用域', '越权写在工具层被硬拦，不靠自觉', ['判据落点：', '· guard.js decide()（88 KB）', '· guard-factory.js fail-closed 包装', '· checkOwnPath / writeClassOf / owningSeat', '⚠ 今晚 3 次判据抖动，只报备未修']],
    ['哈希前置闸门', '改动面必须与授权面相等', ['判据落点：', '· hashgate.js hashGateVerdict', '· baseline-BL-*.json（改动基线）', '· 连续 3 次 ⇒ HASH_GATE_ESCALATION', '⚠ 他单足迹会污染本单（今晚多次）']],
  ]
  inv.forEach(([t, sub, ls], i) => {
    b.push(box({
      x: 180 + i * 312, y: 1360, w: 300, h: 148, c: 'purple', title: t, sub,
      lines: ls, ts: 14, ls: 10.4,
    }))
  })

  // ========================================================================
  // ⑤ 状态机
  // ========================================================================
  b.push(frame(30, 1558, 1440, 372, '⑤ 状态机（实读 lib/states.js —— 18 个状态 · 24 条迁移）'))

  const SB = (x, y, label, id, c, w = 124) => box({
    x, y, w, h: 50, c, title: label, sub: id, ts: 12, ls: 9.8, rx: 6, tp: 17,
  })

  const row1 = [['待分配', 'pending'], ['需求分析中', 'analyzing'], ['待计划', 'ready_plan'], ['计划中', 'planning'], ['待开发', 'ready_dev']]
  row1.forEach(([zh, id], i) => b.push(SB(180 + i * 150, 1594, zh, id, i === 1 ? 'red' : 'blue')))
  for (let i = 0; i < row1.length - 1; i++) {
    b.push(arrow([[180 + i * 150 + 124, 1619], [180 + (i + 1) * 150, 1619]], { marker: 'ahBlue' }))
  }
  const row2 = [['开发中', 'developing'], ['待测试', 'ready_test'], ['测试中', 'testing'], ['待审核', 'ready_review'], ['审核中', 'reviewing'], ['已通过', 'passed'], ['已关闭', 'closed']]
  row2.forEach(([zh, id], i) => b.push(SB(180 + i * 150, 1684, zh, id, id === 'closed' ? 'green' : 'blue')))
  for (let i = 0; i < row2.length - 1; i++) {
    b.push(arrow([[180 + i * 150 + 124, 1709], [180 + (i + 1) * 150, 1709]], { marker: 'ahBlue' }))
  }
  const row3 = [['已打回编写', 'returned_to_dev'], ['已打回测试', 'returned_to_test'], ['等待需求分析答复', 'awaiting_clarification'], ['等待人工答复', 'awaiting_human']]
  row3.forEach(([zh, id], i) => b.push(SB(180 + i * 176, 1792, zh, id, 'yellow', 150)))
  b.push(SB(180, 1862, '已阻塞', 'blocked', 'orange'))
  b.push(SB(330, 1862, '已取消', 'cancelled', 'grey'))

  b.push(arrow([[806, 1644], [806, 1663], [242, 1663], [242, 1684]], { marker: 'ahBlue', color: '#6c8ebf' }))
  b.push(txt(400, 1658, 'dispatch_writer（by main）', { size: 10.2, fill: '#6c8ebf' }))
  b.push(arrow([[530, 1734], [530, 1756], [242, 1756], [242, 1792]], { marker: 'ahRed', color: '#b85450', dash: '5 3' }))
  b.push(txt(150, 1752, 'test_failed · review_ng_dev → dispatch_writer 回来（guard=rework_budget）', { size: 9.6, fill: '#b85450' }))
  b.push(arrow([[700, 1734], [700, 1756], [418, 1756], [418, 1792]], { marker: 'ahRed', color: '#b85450', dash: '5 3' }))
  b.push(txt(560, 1772, 'review_ng_test → dispatch_tester 回来', { size: 9.6, fill: '#b85450' }))

  b.push(box({
    x: 920, y: 1590, w: 520, h: 300, c: 'white', title: '合法事件速查（实读 states.js:174–259）',
    lines: [
      'open (main) → pending　　dispatch_orchestrator (main) → analyzing',
      'requirement_confirmed (main · guard=requirement_confirm_gate) → ready_plan',
      'dispatch_orchestrator (main) → analyzing　【用户不认可 ⇒ 退回重做】',
      'dispatch_planner (main) → planning　　planned (planner · plan_ready) → ready_dev',
      'plan_gap (planner · plan_gap_gate) → awaiting_clarification　【计划自检发现缺失】',
      'dispatch_writer (main) → developing　　dev_submitted (writer · dev_to_test) → ready_test',
      'dispatch_writer (main) → developing　【从 returned_to_dev 回来，预算已扣过】',
      'dispatch_tester (main) → testing　　　test_passed (tester · test_to_review) → ready_review',
      'test_failed (tester · rework_budget) → returned_to_dev',
      'dispatch_tester (main) → testing　【从 returned_to_test 回来，不再扣预算】',
      'dispatch_reviewer (main) → reviewing　review_ok (reviewer · review_verdict_ok) → passed',
      'review_ng_dev (reviewer|security · rework_budget) → returned_to_dev',
      'review_ng_test (reviewer · rework_budget) → returned_to_test',
      'close (main · close_gates) → closed　【必须有针对当前版本的审核 OK】',
      'clarification_request (执行/顾问角色 · clarification_blocking) → awaiting_clarification',
      'clarification_reply (orchestrator · clarification_reply_ok) → (previous)',
      'human_request (除 main 外全部角色 · human_request_blocking) → awaiting_human',
      'human_reply (main · human_reply_has_source) → (previous)',
      'block / unblock / cancel (main · human) —— 任意非终态',
    ], ts: 12.5, ls: 10.4,
  }))

  // ========================================================================
  // ⑥ 数据面
  // ========================================================================
  b.push(frame(30, 1946, 1440, 222, '⑥ 数据面 —— .pipeline\\<task>\\（账本目录；只有 pipeline_* 工具能写）'))
  b.push(box({
    x: 180, y: 1988, w: 170, h: 140, c: 'dark', title: '.pipeline\\', sub: '<taskId>\\',
    lines: ['一张单一个目录', '（+ switch.json', '在 .pipeline\\ 根上）'], ts: 14, ls: 11,
  }))
  const data = [
    ['task.json', '任务账本（唯一真相源）', ['state / previous_state', 'roster', 'handoffs[] / artifacts[]', 'records[]', 'clarification_requests[]', 'human_requests[]', 'dispatched[]', 'liveness.escalations[]', 'history[] / contacts.main', 'baselines[]']],
    ['audit.jsonl', '只追加的动作流水', ['transition:* / handoff:*', 'wake:*', 'gate:hash / gate:hash_reset', 'human:request|relay|reply', 'human:resume', 'clarify:request|reply', 'clarify:escalate / clarify:resume', 'artifact:register', 'seat:submit', 'context:report']],
    ['handoffs\\', '结构化交接物', ['NNN-<kind>.json', '（序号即先后）', 'requirement_analysis', 'plan / design', 'dev_to_test / test_to_dev', 'test_to_review', 'review_verdict', 'human_request', 'clarification_*', 'seat_handover']],
    ['artifacts\\vN\\', '制品版本（审核依据）', ['每个版本一个目录', '含 sha256 + bytes', '+ note', '审核结论必须写明', '对应哪个 vN', '不一致 ⇒ 拒'],],
    ['records\\ reports\\', '席位记录与证据', ['records/<role>.md', 'records/<role>.json', '各席位只写自己那份', 'reports/<role>/', '只写自己目录', 'baseline-BL-*.json', '改动基线', '（逐文件哈希）'],],
  ]
  data.forEach(([t, s, ls], i) => {
    b.push(box({ x: 360 + i * 212, y: 1988, w: 200, h: 160, c: i === 3 ? 'green' : 'grey', title: t, sub: s, lines: ls, ts: 12.5, ls: 10.2 }))
  })

  b.push(txt(750, 2196, '制作：主对话席位 · 全部内容取自实读文件；每条数字的出处见配套文档「⑤ 证据出处与未核实项」。本图不含推断性内容。', { anchor: 'middle', size: 11, fill: '#777' }))

  return svgWrap(W, H, b.join('\n'))
}
