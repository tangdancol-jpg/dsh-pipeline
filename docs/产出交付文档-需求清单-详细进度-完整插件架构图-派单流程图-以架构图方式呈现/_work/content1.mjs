// ===========================================================================
// 全文内容（唯一真相源 —— HTML 与 Markdown 都从这里生成，保证两份内容一致）
// 每条事实都带出处；「（归纳）」= 我做的归纳，其余为原话照抄 / 实读结论。
// ===========================================================================

export const META = {
  title: '需求清单 · 详细进度 · 完整插件架构图 · 派单流程图',
  subtitle: 'dsh-pipeline 多对话 AI 协作流水线 —— 实读账本与源码的交付文档',
  generatedAt: '2026-10-12 夜（本地时区 UTC+8）',
  scope: [
    '只读：本轮未改动 dsh-pipeline 插件的任何文件，未改动 .pipeline\\ 下的任何账本。',
    '全部事实来源：.pipeline\\ 下 13 张单的 task.json / audit.jsonl / handoffs / artifacts / records / reports；插件生效副本的 lib\\*.js 源码；dsh_orb\\ 下的报告与诊断档。',
    '凡我做的归纳一律标「（归纳）」；凡原话一律标「（照抄）」。不确定的一律写「未核实」。',
    '时区说明：账本时间是 UTC（Z 结尾），本机是 UTC+8。文中同时给出两种，便于对照。',
  ],
}

// ===========================================================================
// ① 需求清单
// ===========================================================================
export const S1 = {
  id: 's1',
  num: '①',
  title: '需求清单',
  intro: [
    '共 12 条需求来源。每条给出：**来源**（哪张单 / 哪份文档 / 哪次口述）、**用户原话**（照抄，不提炼）、**三态判定**、**证据**（文件 + 行 / 审计条目 / 命令输出）。',
    '三态口径：✅ 已实现 = 有可核对的实现落点 + 测试证据；🟡 部分实现 = 代码在但真单未走通，或测试未通过；❌ 未实现 = 零制品或零落点；⚪ 已取消 = 用户主动取消，不计入未完成；❓ 未核实 = 我拿不到可核对证据。',
  ],
  items: [
    {
      rid: 'R-01',
      title: '修正协调插件逻辑（真实会话通道 / 三档权限 / 内置模式 / 主管评估）',
      source: 'T-20261011-214043 · task.json → requirement（751 字符，2026-10-11T10:59:33Z 开单）',
      quote: [
        '【需求1 · 修正协调插件逻辑】',
        '· 「不要用 DSH 的子代理，用 Computer Use 模式的方式，调用生成对话」—— 即派活通道改为创建**真实会话/对话**，而不是 provider=spawn 的子代理。',
        '· 「让需求分析 AI 根据需求让计划 AI 安排其他 AI 开启时的权限（仅查看，工作区，完全）」—— 三档权限由计划 AI 指定。',
        '· 「一般禁用完全，如果要的话需要递交给需求，需求再给主对话让用户判定能不能开完全」—— 「完全」档默认禁用，开启必须走「需求 AI → 主对话 → 用户判定」。',
        '· 「同时计划 AI 安排其他 AI 内置模式，如创造，极简，还有使用模型和推理等级」—— 计划 AI 为每个角色指定内置模式 / 模型 / 推理等级。',
        '【需求2 · 追加新的内置模式】',
        '· 「要求追加新的内置模式，满足用于不同 ai 的专属模式」—— 新增内置模式，并支持角色专属模式。',
        '【需求3 · 考虑加一个「项目主管 AI」】',
        '· 「考虑需求和计划 ai 是否要中间再追加一个项目主管 ai，再需求 ai 提交给主管，主管才分配给计划」·「简单判断都由主管自行决定」·「主管不看全代码」',
        '· 「其他 ai 递交问题时只能截取小部分，并说明修改点，原因，理由，是否有必要」',
        '· 说明：本条是「**考虑**」，请给评估结论与取舍建议，不强制立刻实现。',
      ],
      sub: [
        {
          t: '1a 派活通道 = 真实会话（不用子代理）',
          st: 'partial',
          note: '代码在，但**从未在任何真单上被走过**。',
          ev: [
            '落点存在：lib/transport/index.js:863 `export class SessionTransport`；:1070 `export class UnreachableTransport`；:1123 `createTransport(ctx, config, deps)`；:438 `probeSessionChannel(ctx)`。',
            '测试证据：tests/load-smoke-last-run.txt 24/24 通过（含降级甲 manual / 降级乙 subagent 的如实说明）。',
            '★ 反证（实读账本）：T-20261011-214043 的 task.json → dispatched[] 共 8 条，**全部** `"via":"subagent"`；T-20261011-5a871c 7 条、T-20261011-56a37e 2 条、T-20261012-6884af 5 条、T-20261012-8cdee0 1 条 —— **无一条 via="session"**。',
            '★ 需求分析自己的结论（T-20261012-8cdee0 · records/main.md 修订 1，2026-10-12T15:33:50Z）：审计明说「真实会话通道不可达，无法投递」。',
          ],
        },
        {
          t: '1b 三档权限由计划 AI 指定 + 「完全」档默认禁用 + 三段审批',
          st: 'done',
          note: '落点与测试都有。',
          ev: [
            'lib/tiers.js:827 `ROSTER_PERMISSION_TIERS = [read-only, workspace-write, danger-full-access]`；:830 `ROSTER_MIN_PERMISSION = "read-only"`；:833 `ROSTER_FULL_PERMISSION`；:978 `normalizeRosterSlots`。',
            'lib/transport/index.js:379 `PERMISSION_TIERS`；:388 `FULL_PERMISSION_CHAIN = Object.freeze([orchestrator, main, user])`；:500 `fullPermissionGate(slot, spec)`。',
            '测试证据：tests/roster-authority-check-last-run.txt **70/72 通过**（2 条 ✗ —— 见 ② 遗留项）。',
            '真单证据（实读）：T-20261012-6884af 的 roster:set 审计条目里，7 个角色的四槽全部 `"declared":true,"origin":"declared"`。',
          ],
        },
        {
          t: '1c 四槽（权限档 / 内置模式 / 模型 / 推理等级）由计划 AI 下发',
          st: 'done',
          note: '',
          ev: [
            'lib/tiers.js:824 `ROSTER_SLOT_KEYS = Object.freeze(["permission","mode","model","reasoning"])`；:1094 `buildRosterSlots`；:1147 `compareDispatchSlots`（逐字段判定，不是「看起来差不多」）；:1177 `checkDispatchQuota`；:1204 `validateDispatchSequence`。',
            'lib/tiers.js:847 `DISPATCH_OPEN_AUDIT_FIELDS`（12 个字段）+ :863 `DISPATCH_OPEN_ACTION = "dispatch:open"`：开对话留痕 accept/reject 都留。',
            '★ 回归记录：本功能曾把**所有任务**的计划路径卡死（计划被「writer 席位未声明四槽」打回，插件自带正例夹具自检也同因失败）—— 见 ② 的 B1。',
          ],
        },
        {
          t: '1d 角色专属模式（按工作分类）',
          st: 'unverified',
          note: '当时的 change_scope 允许「若判定并入既有模块则不新建」，所以「找不到 modes.js / permissions.js」本身不算未实现；但我没找到可核对的角色专属模式注册表。',
          ev: [
            '实读 lib\\ 目录：**没有** modes.js、**没有** permissions.js（当时的 change_scope 把这两条都写成 create，并附注「若判定并入既有配置/角色两模块则不新建」）。',
            '「模式」这个槽存在（tiers.js:824 的 mode），且 6884af 真单上 7 个角色的 mode 槽都 = "standard"。',
            '「一个 AI 一个专属模式」的粒度由用户在 HR-4dc4643d207f77e8 裁定（2026-10-11）：user_quote「3) 一个 AI 一个专属模式」；我在代码里**没有找到**按角色分别登记模式的表。',
          ],
        },
        {
          t: '1d′ 主管 AI 评估（需求3，用户明确说是「考虑」项）',
          st: 'done',
          note: '评估结论已落地为角色表条目；但**主管站没有进状态机** —— 那属 R-02 的范围。',
          ev: [
            'lib/roles.js:63 `SUPERVISOR: "supervisor"`；:160–193 完整条目：kind=control · writes=readonly · handoffKinds=[human_request, clarification_reply, seat_handover] · canRework=false · canRequestRosterChange=false。',
            'lib/guard.js:114 `NO_WRITE_ROLES = ["supervisor"]` —— 真只读在守门层落判据。',
            '★ 反证：lib/states.js 的 TRANSITIONS（:174–259）里**没有任何一条** by 里出现 supervisor。',
          ],
        },
      ],
    },

    {
      rid: 'R-02',
      title: '「主管枢纽」完整拓扑（主管发起 / 承接 / 五道双确认 / 架构图前置 / 测试提前预 brief）',
      source: 'T-20261011-56a37e · task.json → requirement（717 字符，2026-10-11T14:30:54Z 开单）',
      quote: [
        '用户原话（照抄）：「再修插件逻辑，应该让用户下达任务→主对话转发→主管发起（需求分析/计划/架构ai）对话→主管将主对话转发内容交给需求ai分析同时计划和架构ai待机→需求ai分析将结果提交主管→同意后交给架构ai先画架构图→架构图完成后给主管确认是否满足要求→主管确认后交给计划ai并由计划ai安排其他ai干活→编程ai干活完成后提交给测试ai（测试ai提前收到计划ai安排任务内容）→测试无问题后提交给主管和需求ai确认→无问题后交给审核验收→无问题提交给主管和需求，确认后提交主对话→用户收到结果」',
        '主对话整理（照抄）：「主管成为枢纽：由它**发起**（需求分析 / 计划 / 架构）三方对话 ✓；架构图前置：需求确认后 → **先出架构图** → 主管确认「是否满足要求」 → **才**交计划 ✓（与现行顺序「计划 → 架构 → 安全 → 编写」不同 ✗）；计划 / 架构 待机 ✓；测试提前预 brief ✓；多道双确认：① 需求分析结果 → 主管同意 ② 架构图 → 主管确认 ③ 测试无问题 → 主管 + 需求 双确认 ④ 审核无问题 → 主管 + 需求 确认 ⑤ 才交主对话 → 用户收到结果 ✓」',
      ],
      sub: [
        {
          t: '整体落地情况',
          st: 'not',
          note: '10 站一站未落地。',
          ev: [
            '实读 T-20261011-56a37e 的 task.json：state = "ready_dev"，artifact_version_counter = 0，artifacts = []，handoffs 只有 4 份（requirement_analysis ×1、human_request ×1、plan ×1、orchestration ×1，全部 av=null）。',
            '三个编写席（writer#1 topology-authority / writer#2 gate-criteria / writer#3 dispatch-standby）**无一有制品**；dispatched 只有 orchestrator 与 planner 两条。',
            'states.js 的 TRANSITIONS 里没有「主管确认」站；roles.js:182 的 supervisor.handoffKinds 里没有能承载「两次确认」的交接物类型（源码注释自己写明：「该类型落地后补进这张白名单 —— **在那之前不许先写一个不存在的类型**」）。',
            '★ 这张单的最后一次更新是 2026-10-12T14:19:35Z（本机 22:19），此后没有再动。',
          ],
        },
      ],
    },

    {
      rid: 'R-03',
      title: '修「澄清答复后不唤醒席位」+「失联误报」，且**必须走管道自身完成、不得绕开管道**',
      source: 'T-20261012-6884af · task.json → requirement（1726 字符，2026-10-12T13:08:15Z 开单）',
      quote: [
        '用户原话（照抄）：「把「澄清答复后不唤醒席位」+「失联误报」两条一起修（落点已在授权面内）。修完再回头推 214043，以后每轮不用人守着。」',
        '★ 用户并明确要求：**走管道自身完成本次修复**（正统路径），**不得绕开管道**用旁路工具落地。',
        '缺陷 1 实测反证 A（照抄）：「席位 session-…… 于 20:53:25 派出，20:58:30 被判失联并冻结任务；而同一时刻主对话实测该会话日志 session.v4.jsonl.zstd **30 秒内从 381,679 B 增至 392,396 B（+10,717 B）** ⇒ 席位**正在活动**。」',
        '缺陷 2 实测反证（照抄）：「席位会话日志自 21:03:01 起**冻结不动**；主对话于 21:05:36–21:06:21 观测 45 秒，size 恒为 600,357 B、mtime 恒为 21:03:01 ⇒ **无任何路径去叫醒它**。」',
      ],
      sub: [
        {
          t: '缺陷 2 · 澄清裁定后不唤醒发起席位',
          st: 'partial',
          note: '基础设施前置 + 一处根因补丁已落盘，但**测试位当场判不通过并打回编写**（rework 1/2）。',
          ev: [
            '主对话落的盘（制品 v1 的「来路声明」表里点名）：lib/tools.js 的 `wakeResumedSeat` / `nudgeSeat` / `pipeline_seat_message`。',
            'writer#1 补的根因（制品 v1 §二·改动 1，文件 .pipeline\\T-20261012-6884af\\artifacts\\v1\\v1-writer1-seat-liveness-wake.patch.md）：`createClarificationEntry`（lib/store.js）**从来没有写过 `from_seat`** ⇒ 恒为 undefined ⇒ `nudgeSeat` 退化成只按 role 找派活台账、`find` 命中第一个同角色记录 ⇒ **多编写席位时可复现的错投**。补法：`clarification.from_seat = input.actorSeat`（+15 行）。',
            '★ 判定证据（实读 audit）：2026-10-12T15:06:27Z｜handoff:test_to_dev｜H-f48fbeb883344e39｜av=v1；同行 transition:test_failed（testing → returned_to_dev）+ rework:writer「used=1 | budget=2」。',
            '制品 v1 大小 14,354 B / sha256 c9815c47a4d913f798944c54f11d978be69ca5bdedf665d1d1af5c48d41c20b3（audit artifact:register 14:47:32Z）。',
          ],
        },
        {
          t: '缺陷 1 · 失联误报（会话活动判据）',
          st: 'partial',
          note: 'B2 判据的**两条根因在补丁之后依然在磁盘上**；且真单上这条修复「没有拦住」误判。',
          ev: [
            '已落的：lib/liveness.js 第四条判据（会话日志 size/mtime 增长，源码注释「★ B2：第四条判据 —— 会话日志还在长吗？（优先级最高，因为它是最硬的"它还在动"）」）；DEFAULT_ACTIVITY_MIN_BYTES=1024；DEFAULT_ACTIVITY_MAX_MS=2min；DEFAULT_SILENCE_CONFIRMATIONS=2。',
            '★ 反证 A（实读 audit 14:44:15Z 的 unblock 备注原文）：「B2 那条「补会话活动判据」的修复**这次没有拦住误判**（会话 id 是 session-… 形状，本应命中）。」实测：session-… 的日志在 22:43:36–22:43:49 的 13 秒内由 563,327 B 增至 575,960 B（+12,633 B）。',
            '★ 根因仍在（源码行号 2026-10-12 23:5x 实读）：lib/store.js:401 `if (root === null) return { …, gate_applicable: false }`；lib/liveness.js:373 `const gateOn = confirmations >= 2 && opts.gateApplicable === true`；lib/liveness.js:432 `quiet_streak: silentHere ? quiet + 1 : 0`（pending 分支在 :413 把 silentHere 置 false ⇒ 计数永远回 0 ⇒ 永远累加不到 confirmations=2）。',
            '当前状态：本单 state = "developing"，正在返工轮里；routers 卡在「修改测试目录内已有文件」的授权面语义（用户 15:18:05Z 已裁定「允许：由计划 AI 扩权」）。',
          ],
        },
        {
          t: '「走管道自身完成、不得绕开管道」这条元要求',
          st: 'done',
          note: '',
          ev: [
            '实读 audit：本单的交付全部经 pipeline_artifact（14:47:32Z artifact:register v1）+ pipeline_handoff（14:47:56Z handoff:dev_to_test）+ pipeline_record_submit（record:submit ×5）。',
            '打回也走管道：15:06:27Z handoff:test_to_dev（tester → writer），3,585 B 且带失败说明。',
            '澄清也走管道：15:14:41Z clarify:request CQ-ae58365e3cdea060 → 15:17:05Z clarify:reply（orchestrator 判 cannot_answer）→ 15:17:11Z clarify:escalate 到 HR-eaa8652871847c11。',
          ],
        },
      ],
    },

    {
      rid: 'R-04',
      title: '修「唤醒 / 投递」那条根 + 用户最新口径：上报流程**缺了主管这一层**',
      source: 'T-20261012-8cdee0 · task.json → requirement（1862 字符）+ records\\main.md 三段（2026-10-12T15:33:50Z / 15:34:20Z / 15:34:44Z）',
      quote: [
        '用户原话（方向裁定，照抄）：「**改方向：先修唤醒那条根**」（前一句语境：两条真单都卡在「等一个不会响的唤醒」上；用户判定不要再往单子里加席位，先把这条根做掉。）',
        '★ 用户最新口径（records\\main.md 里登记，照抄）：「上报流程问题：编写→主管/需求，主管→主对话/需求，而现在缺失这一层」',
        'requirement 里的根因一句话（照抄）：「唤醒的「身份」不是从事件本身来的 —— 取不到就静默跳过、取错了就挂在别的实体上、粒度太粗就互相吃掉、不认「已处理」就延迟重放；再叠加缺一条反向通道（机制→既有席位）与失联判据缺「崩溃」这一维。」',
      ],
      sub: [
        {
          t: '整体进度',
          st: 'not',
          note: '需求分析结论已出，但**零制品**，且卡在一条未答复的人工请求上。',
          ev: [
            '实读 task.json：state = "awaiting_human"，previous_state = "analyzing"，artifact_version_counter = 0，artifacts = []，handoffs 只有 2 份（001-requirement_analysis.json 15,041 B / H-88ff0a1c40c61dc9；002-human_request.json 3,588 B / H-47d3637b41168c20）。',
            '需求分析结论的验收标准已细化到 A1–A14，测试要点 T1–T13，边界条件 B1–B14（实读 handoffs\\001-requirement_analysis.json）。',
            '★ 阻塞点：HR-27a45750e07f4316（reason_kind=scope_change，blocking=true，decision_kind=choose_option，timeout_behavior=stay_blocked），问的是「本单和还在飞的那张老单（T-20261012-6884af）怎么合流」。status = "relayed"（15:37:10Z main 已转告用户），**尚未答复**。',
          ],
        },
        {
          t: '「缺主管这一层」的实读佐证',
          st: 'not',
          note: '「主管向上报」这条边在表里就不存在。',
          ev: [
            'lib/states.js:148–162 `ROLES_CAN_RAISE_HUMAN = [orchestrator, planner, architect, security, writer, tester, reviewer, release, docs, performance, arbiter, human]` —— **没有 supervisor**。',
            'lib/roles.js:182 `handoffKinds: [human_request, clarification_reply, seat_handover]` —— 主管**能**发 human_request（因为它在 ROLES_CAN_RAISE_HUMAN 之外另有白名单），但**不在这条角色清单里** ⇒ 守门的 `human_request` 归属判定与 `ROLES_CAN_RAISE_HUMAN` 这一份清单不一致。这一处属我实读两处清单后发现的**不一致**，未在账本里找到对应的裁定条目。',
            '★ 同一形状的缺口还有一处（用户口径点名的另一半）：「编写→主管/需求」—— writer 的 handoffKinds 是 [dev_to_test, human_request, clarification_request, seat_handover]，没有「交给主管」这条边。',
          ],
        },
        {
          t: '那条「再也不要人守着」的验收',
          st: 'not',
          note: '',
          ev: [
            '用户 6884af 的 HR-6af850589614db01 答复里定的口径：「修完」= 自动化测试通过 + 用今晚那串实测数据离线复算必须判为「还活着」。',
            '实读：T-20261012-6884af 在 15:06:27Z 被判**不通过**并打回 ⇒ 这条验收**当场没过**。',
          ],
        },
      ],
    },

    {
      rid: 'R-05',
      title: '用户今晚逐条裁定的口径（全部出自 audit.jsonl 的 human:reply 条目）',
      source: 'T-20261012-6884af · audit.jsonl · human:reply（HR-6af850589614db01，2026-10-12T13:12:32Z；本机 21:12）',
      quote: [
        'user_quote（照抄）：「①②③ 全按推荐（推荐）」　reply_channel = selected　attribution = 用户在当前会话的选项卡片中点选（由主对话经 pipeline_human_relay 转告后答复）',
        'decision 原文（照抄）：「① 唤醒消息里的旧状态快照跟着主线一起修，守门判据本次只报备、不动；② 「修完」= 自动化测试通过 + 用今晚那串实测数据（席位被判死的同时会话文件 30 秒长了 10,717 字节）离线复算必须判为「还活着」，当场生效留到下次自然重启；③ 席位叫不醒时只要求报出一个看得见的失败、不许悄悄失败、任务不许停在半路，不要求自动补新席位。」',
      ],
      sub: [
        { t: '⑤-1 旧快照要一起修、守门判据只报备不动', st: 'partial',
          ev: ['快照：lib/wakeup.js 的 stateOfTask / renderWakeText / wake() —— 制品 v1 的来路声明表点名「唤醒正文状态取投递时刻（A6）」，作者标为主对话落的盘。',
               '守门判据：实读 lib/guard.js 今晚改过（88,064 B，mtime 10-12 21:56）—— 改的是 B9 的**缓存冷热**那一半，不是判据本体；changes.md:183 自陈「**B9 的"缓存冷热"只修了一半**：…但 guard-factory 冷索引时"整段跳过"的 fail-open 仍在」。⇒ 与「只报备不动」的口径**基本一致，但有半修动作**，如实记录。'] },
        { t: '⑤-2 「修完」= 自动化测试通过 + 离线复算', st: 'partial',
          ev: ['自动化测试：selftest 70/70（tests/selftest-last-run.txt:626）、t14-fix-check 38/38（tests/t14-fix-check-last-run.txt:98）—— 数字真实存在。',
               '★ 但三处口径必须说清：① 这两组数字是**修复者当晚自报**，交接档 :690 原文写「上表四行为**转述**（修复者当晚自报，本次**未**复跑）」；② 离线复算是把规格里的两个数（381,679 / 392,396）**写死在夹具里**重放（tests/t14-fix-check.mjs:153-154），**不是**重读那台会话文件 ⇒ 不能当作「独立复测了席位确实活着」；③ 测试位在 15:06:27Z 判**不通过**。'] },
        { t: '⑤-3 席位叫不醒时必须报出看得见的失败 / 不许静默失败 / 任务不许停在半路 / 不要求自动补新席位', st: 'partial',
          ev: ['「看得见的失败」这部分机制在：t14-fix-check 38/38 里含「★ L1 的执行角色里，缺卡的角色**逐条点得出名**」。',
               '★ 但今晚真单上发生的正是**静默失败**：wake:skipped reason=no-stable-identity（8cdee0 15:36:58Z、6884af 14:36:22Z）；去重吞掉「任务被冻结」的唤醒（214043 15:14:01Z，note=「目标会话里已有同一条（确定性消息 id 命中），不再注入。」）。',
               '「任务不许停在半路」：214043 被冻 **4 次以上**（12:58:36 / 13:16:50 / 13:43:26 / 15:14:01 / 15:19:32 等），其中一次冻结**直接挡掉一份已提交的交付**（席位在冻结后仍工作 2 分钟，那 2 分钟里交的 test_to_review 被「任务已阻塞」拒收）。',
               '「不要求自动补新席位」：机制侧做到（UnreachableTransport 如实报不可达、不伪造）；这一条 ✅。'] },
        { t: '⑤-4 其他今晚裁定（出处逐条）', st: 'done',
          ev: ['守门不稳定性只报备 —— 6884af HR-6af850589614db01 decision ①；实读 guard.js 未动判据本体（仅缓存层半修）。',
               '「先解冻 214043，派测试席先把回归抓出来」（正统三权分立）—— HR-e1b52562cd218f1a，user_quote「B：先走测试位抓回归…多一个测试席，但责任链干净。」',
               '「允许：由计划 AI 扩权，把『修改测试目录内已有文件』纳入授权面」—— HR-eaa8652871847c11，2026-10-12T15:18:05Z，reply_channel=selected。',
               '「由主对话立刻落实…以后同类『席位失联』误冻再现时，主对话直接解除，不必逐次再问你」—— T-20261011-214043 HR-97269de32e5d5eeb。',
               '「人打回不需要理由，打回的目的是防止一次又一次的重试，ai 可能不知道哈希打回的情况，导致一直重试」—— T-20261012-7b9408 HR-a1b726450f7cfac4，user_quote 照抄。',
               '「11 按项目分组；12 如实报不可达 + 降级方案。12 先上报方案再确定是否执行」—— T-20261011-214043 HR-3560d756ddadfb70。',
               '「继续，且我要出去半小时，期间你自行审核，注意会不会有做完但没汇报的情况」—— T-20261011-5a871c HR-6434b6733a70c8e7。'] },
      ],
    },

    {
      rid: 'R-06',
      title: '★ 孤儿单需求：「要让每个工具 AI 知道自己要干什么，去运行，被切断后自己能意识到，然后重新输出正确内容」',
      source: 'T-20261011-4a2dc7 · task.json → requirement（734 字符，2026-10-11T08:15:50Z 开单）—— **用户点名要找的那张单**',
      quote: [
        '用户原话（原样照抄）：「真单，但开发内容就是改定该插件的完善，要让每个工具ai知道自己要干什么，而是去运行，然后被切断，或者切断后自己能意识到，然后重新输出正确内容。」',
        '主对话补充的真实触发场景（照抄）：「主对话开单后被自动绑定为该任务的「主对话」，随即一条"读 DSH 日志"的 shell 命令被守门拦下，拒绝原文：`[pipeline] 拒绝：主对话不得通过 shell 读取项目代码。任务：T-20261011-… 原因：主对话与代码正文隔离。请用 pipeline_status 看脱敏摘要。`」',
        '「用户要的是三层：① **事前**：每个角色的 AI 在行动前就知道自己该干什么、不该干什么；② **事中**：越界仍要被切断（已有）；③ **事后**：切断之后要能**意识到自己被切了**，并**自己纠正、重新输出正确内容**（不是卡死、不是报错终止、也不是反复撞同一面墙）。」',
      ],
      sub: [
        { t: 'T-20261011-4a2dc7 —— **找到了，就是这张**', st: 'not',
          note: '孤儿单：既不能推进也不能取消。',
          ev: ['实读 task.json：state = "analyzing"，previous_state = "analyzing"，artifact_version_counter = 0，handoffs = []，artifacts = []，dispatched = []，records = []，close_report = null。',
               'history 只有 3 条：{open:1, transition:dispatch_orchestrator:1, reattach:1}；最后更新 2026-10-11T10:00:40Z。',
               '它**没有** liveness 字段（该字段是后来才加的），也没有 contacts —— 正是「派活发生在台账字段之前」的老任务。'] },
        { t: 'T-20261011-a5fe41 —— 同一需求的「重启后重开」单，同样是孤儿', st: 'not',
          note: 'why：DSH 重启后主对话绑定丢失、令牌失效。',
          ev: ['实读 task.json 的 requirement 开头：「⚠️ 本单是**重启后重开**：前一张 T-20261011-4a2dc7 承载同一需求，但 DSH 在 2026-10-11 16:46:58 重启后**主对话绑定丢失、令牌失效**（pipeline_bind_role 报"role_token 无效或已过期"；pipeline_task_open 用同一 id 报"已存在"）⇒ 那张单成为**孤儿**，既不能推进也不能取消。」',
               'state = "blocked"，最后更新 2026-10-11T10:58:48Z，liveness.escalations 只有一条：「席位失联：计划 静默阈值 5 分 原状态「计划中」」—— **从未解除**。',
               '有 6 份交接物（requirement_analysis ×3 + human_request ×3），但 artifacts = 0、records = 0。',
               '用户答复原文（照抄，HR-0deeea4ffa4ab1e3）：「方案1，另外你的问题又注入到ava里，我点不了，只能靠orb转告了」。'] },
        { t: '三层里各层的落点', st: 'partial',
          note: '事前卡与事中拦截有；事后自纠没有可核对证据。',
          ev: ['事前：lib/intercept.js 的 `seatBriefing(seat, task)`（intercept.js:178）+ STOP_LADDER_FOUR（:93）+ judgePrompt（:140）+ registerInterception（:210）—— 四问注入（「用户让你做了吗？结果需要它吗？有证据吗？没它会失败吗？」）。测试：tests/intercept-check-last-run.txt 25/25 通过。',
               '事中：守门层（lib/guard.js）确实拦得住 —— 触发场景里那条拒绝原文就是证据。',
               '事后：需求要求「拒绝返回必须给出可执行的替代动作，被拦角色能据此重新产出正确内容（要有正反例：反例=撞墙后卡死或原地重试；正例=收到拒绝→改道→成功）」—— 我在两张单上都**没有找到**这类正反例的原始输出，也**没有**找到该需求对应的制品。⇒ 未核实（不是「确认没做」，是「拿不到证据」）。'] },
      ],
    },

    {
      rid: 'R-07',
      title: '把「开对话」的权交给需求分析 / 主管 / 计划这条链（用户原话只有两个字：「修改」）',
      source: 'T-20261011-5a871c · task.json → requirement（797 字符，2026-10-11T13:35:49Z 开单）',
      quote: [
        '用户原话（本次，照抄）：「修改」',
        '本次要做的修改（照抄）：「1. **把「开对话」（真正创建会话 / 派活）的权交给 需求分析 / 主管 / 计划 这条链** —— 不再要求主对话逐站人肉推。2. **同时用代码层把它锁住**：能开几个、开什么角色、什么顺序、什么权限档（四槽）**全写死在角色清单里**；**清单外一律开不出来**；开对话必须留痕。3. **主管站做实**（从"定位稿"推进到"有权"）…4. **不许动摇四类不变量** …5. 验收必须**可判定**…凡声称已实现的，必须同时写明"**需重启后复验**"。」',
      ],
      sub: [
        { t: '落地情况', st: 'partial',
          note: '三个制品版本在盘上、两棵树自述哈希一致；但**没有 dev_to_test，测试从未跑，未验收**。',
          ev: [
            '实读 task.json：state = "developing"，artifact_version_counter = 3，artifacts = 3 版。',
            'v1（artifacts\\v1\\writer1-roster-authority-v2.diff，4,167 B / 2026-10-11T17:13:28Z）：note 原文「writer#1（roster-authority 层）改动集 v2：7 个文件（6 改 1 增），+516 行 / -28 行…两棵树逐一哈希一致（差异 0）。所有声明需重启 DSH 后复验。」',
            'v2（12:02:36Z）：note 原文「第 1 任的 7 个文件 + 第 2 任对 tests/run-all.mjs 三处结构性损伤的修复…两棵树 7/7 哈希一致，差异 0。所有声明需重启 DSH 后复验。」',
            'v3（12:25:21Z）：note 原文「第 3 任改动集 v3：补齐「开对话留痕落盘」缺口（tiers.js 纯函数 + store.js 只追加审计行），并修掉本层自测套件里一处会让全套断言恒红的记录器签名缺陷。3 个文件 +263/-5；两棵树逐一哈希一致（差异 0）；本席探针 13/13。全部改动需重启后复验。」',
            '★ 未验收的硬证据：handoffs 里**没有** dev_to_test；writer_submissions = {}；liveness.escalations 有 3 次失联冻结（13:47:39Z planner、16:59:37Z writer#3、12:20:45Z writer#1）。',
            '★ 测试面：tests/roster-authority-check-last-run.txt **70/72 通过** —— 2 条 ✗；changes.md:186 自陈「tests/roster-authority-check.mjs 有 2 条自相矛盾的断言（我**没有改**）…改前 70/72、改后 70/72，逐字相同」。',
          ] },
      ],
    },

    {
      rid: 'R-08',
      title: '打回必须告知原因（系统打回也一样）+ 被拒后禁止继续',
      source: 'T-20261012-7b9408 · task.json → requirement（551 字符，2026-10-11T16:31:15Z 开单）',
      quote: [
        '用户原话（照抄）：「打回时要告知原因，系统打回也是，要告知 **agent** 原因并且禁止继续」（"打会"为"打回"笔误）',
        '★ 用户后续裁定（照抄，HR-a1b726450f7cfac4）：「**人打回不需要理由**，打回的目的是防止一次又一次的重试，AI 可能**不知道哈希打回的情况**，导致**一直重试**。」—— 即：人发起的打回不必强制写「哪条判据/缺什么/怎么改」；**系统自动打回必须给可读原因，且要停手**。',
      ],
      sub: [
        { t: '落地情况', st: 'partial',
          note: '「打回带原因」在真单上已生效；但本单自己没有推进到计划之后。',
          ev: [
            '实读 task.json：state = "analyzing"，artifact_version_counter = 0，artifacts = []，handoffs 只有 2 份（001-requirement_analysis.json + 002-human_request.json）；history 里 reattach ×3，最后动作是 human:resume（2026-10-11T16:36:34Z）。',
            '★ 生效证据（别单）：T-20261012-6884af audit 2026-10-12T15:06:57Z 的 dispatch_writer note 原文：「测试位经独立复核判定**不通过**，已交 test_to_dev（016-test_to_dev.json，3,585 B，H-f48fbeb883344e39）并自动推进 test_failed → rework:writer（编写打回计数 1/2）。主对话按合法事件派编写席去读原因、按原因修。★ 注意：本次打回**必带原因**（3,585 B 的失败说明），这正是用户「打回必带原因 + 禁止继续」那条需求在生效。」',
            '★ 该需求本身的状态机落点：states.js 的三条打回边（test_failed / review_ng_dev / review_ng_test）都带 guard=rework_budget，超限即拒 ⇒ 「禁止继续」在机制上成立。',
          ] },
      ],
    },

    {
      rid: 'R-09',
      title: '点餐测试单（跑通全流程）+ 附带缺陷：派活会话必须归入以**项目名**命名的分组',
      source: 'T-20261011-207ede（第一次，436 字符）、T-20261011-63633e（第二次重跑，615 字符）',
      quote: [
        '用户原话（两次相同，照抄）：「尝试跑1个任务，项目名就是点餐，效果是写一个常见点餐小程序的样子，做成exe，不联网，不要图片，只是测试全流程」',
        '★ 第二次追加的真实缺陷（照抄）：「**「派活生成的会话必须归入以【项目名】命名的分组」** —— 上一轮它建出的分组名是插件自己的目录名（`desktop`），而不是任务的项目名（点餐），用户因此把它删了。分组名要按**任务的项目名/落点目录名**取，并能在侧栏一眼认出属于哪个项目。」',
      ],
      sub: [
        { t: '两张单的进度', st: 'not',
          ev: [
            'T-20261011-207ede：state = "ready_dev"，artifact_version_counter = 0，artifacts = []；handoffs 5 份（全部 av=null）；dispatched 只有 orchestrator 与 planner。2026-10-11T13:07:50Z 之后未再更新。',
            'T-20261011-63633e：state = "blocked"（由 transition:block 冻结，未解除），artifact_version_counter = 0，artifacts = []；handoffs 3 份；dispatched 2 条。',
            '两次都没有编写席被派出过 ⇒ **零制品**。',
          ] },
        { t: '分组名缺陷（B7）', st: 'partial',
          note: '落点已修，但真单上无 via="session" 记录 ⇒ 无法验证生效。',
          ev: [
            '落点：lib/transport/index.js:564 `groupTitleOf(cfg, task, root)`；:594 `ensureProjectGroup(ctx, cfg, spec)`。changes.md 自述 B7 已修，t14-fix-check 里「B7」3 条通过。',
            '交接档 §19.4 第 ⑤ 项把它列入「当晚未修」，并写「**遗留破口仍在**」；§18.3 P2 也写「分组名…**遗留破口仍在**」。⇒ 两处记录与 changes.md 自述**冲突**，我按「有落点、有夹具、但真单未验」记 partial。',
            '未核实的部分：我没有办法在不建真实会话的前提下验证分组名。',
          ] },
      ],
    },

    {
      rid: 'R-10',
      title: 'install.ps1 提示文案的数字与实际注册工具数一致（17 → 29）',
      source: 'T-20261011-5f31b2 · task.json → requirement（582 字符，2026-10-11T08:12:09Z 开单）',
      quote: ['用户原话（照抄，主对话在安装验收时发现）：「修正 dsh-pipeline 插件安装脚本 install.ps1 里的错误提示文案：它写「dsh-pipeline 0.1.0 已加载：**17** 个 pipeline_* 工具已注册」，而实际注册的是 **29** 个（index.js:312 用的是动态计数，实测 29）。把该提示文案改成与实际一致。**纯文案修正，不改任何运行逻辑。**」'],
      sub: [{ t: '状态', st: 'cancelled',
          ev: ['实读 task.json：state = "cancelled"，previous_state = "pending"；history 只有 2 条：{open:1, transition:cancel:1}；无 handoffs、无 artifacts、无 records。',
               '⇒ 用户主动取消，不计入未完成项。'] }],
    },

    {
      rid: 'R-11',
      title: '询问卡 / 提问气泡：系统问用户话时必须送到**能当场点、能当场答**的地方',
      source: '不是 .pipeline 单，而是 dsh_orb\\ 下四个任务目录 + T-20261011-a5fe41 的 human:reply',
      quote: [
        '用户原话（照抄，T-20261011-a5fe41 HR-75d8de7463bdc9ed）：「你刚才顺口提的那件事，要不要算进这次改动：「你的问题又注入到 ava 里，我点不了，只能靠 orb 转告了」」',
        '用户答复（照抄，HR-75d8de7463bdc9ed）：「我现在要的是能正常主界面跳提问气泡」',
        '用户答复（照抄，HR-a3c728b1744d8e02）：「我现在要的是能正常主界面跳提问气泡」',
      ],
      sub: [
        { t: '第一轮 · 卡片根本不出现', st: 'done',
          ev: ['落点：dsh_orb\\cordis.patch.yml L53–57，+3 行，补 config:{mode:timed,timeout:-1}；文件 3,546 → 3,618 B。',
               '根因（交接档 §19.2.1）：顶层 `- id: tool-ask-user` 覆盖 preset 子行 ⇒ 宿主 buildMap 只索引顶层 ⇒ 静默跳过 ⇒ mode 停在 legacy ⇒ answerable=false ⇒ 掉兜底裸 JSON。',
               '★ 结果「已生效」在交接档 :627 里标为**转述**（用户重启后现场确认）——我无法独立核对。'] },
        { t: '第二轮 · 卡片正文渲染', st: 'done',
          ev: ['报告：修-dsh-web-gui-的-询问卡正文-渲染-第二层缺陷-上一轮已经做过一次\\报告-第二层-询问卡正文渲染.md（25,240 B）。',
               '根因：AskQuestionRow 的 state==="running" 分支（宿主 dsh-client-ui-tool\\lib\\client.js:2238–2240）是全文 9 处 transcript 赋值中**唯一缺的那一处** ⇒ askQuestion=null；且宿主 AskQuestionCard **根本不画 button**。',
               '修法：新建 dsh-askcard-row 插件（priority:-1 遮蔽同一 keyed 槽位）。',
               '★ 报告 §7 自陈：「**像素层未自证**…**这是本次最大的一步没做成**」；「bundle 层 patch 是否会热重载 —— **我没实测**」。'] },
        { t: '第三轮 · 选项按钮点了没反应', st: 'partial',
          ev: ['报告：修-dsh-询问卡的选项按钮-点了没反应-前一轮已把卡片渲染修好-这一步修交互\\报告-选项按钮点击无反应.md（15,848 B）。',
               '根因（报告 :124–126）：选项按钮的全部动作只有 `revealPanel(callId)` 一条…被 `try{}catch{}` 吞掉…**保证静默的空操作**。',
               '修法：新增 submitAnswerVia() 三通道（① uiSession.pendingSnapshot 的实时卡 ② remote ③ 宿主 waterfall）+ 本地状态行；失败时把 card / remote / reveal / waterfall 四个探针的结果原文写出来。',
               '行为夹具证据：verify-askcard-submit.cjs **32/32**；复跑 verify-askcard-wiring.cjs **6/6**。',
               '★ 报告自陈：「**未决**：这次提问的卡片当时到底在不在注册表里」；仍非浏览器实测。'] },
        { t: '第四轮 · 三条通道全失败', st: 'not',
          ev: ['目录：修-询问卡选项的-提交-三条通道全失败-这次带着完整的运行时错误串来-新会话-上 —— **实读为空（0 文件）**。',
               '第 4 轮的改动痕迹在 dsh_orb\\_asar-work\\（plugin-waterfall.test.cjs / plugin-rejection.test.cjs / audit.cjs）。',
               '★ **诚实说明**：用户给出的现场串 `waterfall=no-live-request; card=absent; remote={"ok":true,"value":false}; reveal=false` 在本机**找不到逐字原文**。我全库检索到的只有它的四个分量：_asar-work\\plugin-waterfall.test.cjs:84–87（分别断言 /waterfall=no-live-request/、/card=absent/、/remote=/、/reveal=false/）、_asar-work\\audit.cjs:50、报告 :211 的状态行**模板**（用「；」分隔且 remote=… 是省略号，与该串格式不同）。**解压全部 65 份会话日志（session.v4.jsonl.zstd，约 55.5 MB）搜 waterfall= / no-live-request / card=absent ⇒ 零命中。** ⇒ 该串应视为**用户侧的重建表述**，不是可直接引用的账本原文。'] },
        { t: '仍未解决的那一层：宿主侧 pending 注册时机', st: 'not',
          ev: ['出处：报告-选项按钮点击无反应.md:66–96。',
               '卡片只有两个来源：前台瀑布 `cards.ensure(...)`（宿主 client.js:1757–1761）与投影回填 `publishContinuedQuestions()`。',
               '而投影**只在「记录下来的 schema 是 timed 版」时才记账** —— 宿主 @deepseek-ai/dsh-user-questions\\lib\\index.js:200 的注释原文：「**a call made under the blocking legacy schema is never tracked, so a Session that only ever used that tool folds to the empty view.**」',
               '且 `reconcile()` 会**主动删卡**（宿主 client.js:1874–1877）。',
               '⇒ 瀑布一结算、投影又不记账，`reveal` 只会返回 false。这就是「点了没反应」的最后一层：**请求已经不在那里了**，而不是按钮没绑事件。这一层不在 dsh-pipeline 插件里。'] },
      ],
    },

    {
      rid: 'R-12',
      title: 'dsh-pipeline 插件 14 条缺陷修复（B1–B14）',
      source: '规格：dsh_orb\\插件缺陷修复规格-20261012.md（119 行，B1 在 :22、B14 在 :88）；变更说明：dsh_orb\\任务-修复-dsh-pipeline-插件的-14-条缺陷-用户已裁定-本次只修\\changes.md（30,950 B / 270 行）',
      quote: ['用户原话（规格起点，照抄）：「十四条第 12 条已修…」为 changes.md 的自述起点；规格本体是主对话从当晚真单现场整理出的缺陷清单。'],
      sub: [{ t: '逐条结论', st: 'partial',
          note: '**12 条自述已修 · B9 部分 · B10 未修。**',
          ev: ['明细见第 ② 节「缺陷修复核对表」。'] }],
    },
  ],
}
