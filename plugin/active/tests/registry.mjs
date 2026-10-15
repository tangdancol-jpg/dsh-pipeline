// 附加自测套件的**注册清单**（一文件一职责：清单在这里，跑法留在 `run-all.mjs`）。
//
// 从 `tests/run-all.mjs` 抽出来（2026-10-16 · 行数纪律）：那一份已 800+ 行，而本次要加两条
// （p14 / p15）—— 规矩是"给 ≥400 行的文件加行，先拆再改"。
// **形状一个字没变**：
//   · 每项 `{ file, exportName, zh }`；
//   · 文件缺失 / 没导出 `exportName` ⇒ 如实标「尚未落地」、**不计入通过率**（原样保留）；
//   · `zh` 是给人看的一句话说明，原样打进取报告里。
//
// @module dsh-pipeline/tests/registry

export const EXTRA_SUITES = [
  { file: './gate-states-check.mjs', exportName: 'runGateStatesCheck', zh: '守门与状态层（开对话权的发起方 / 主管两站 / 两次确认）' },
  { file: './dispatch-channel-check.mjs', exportName: 'runDispatchChannelCheck', zh: '通道与派活层（四槽下发与读回 / 拒绝留痕）' },
  // ★★ 本条补齐（T-20261011-56a37e）：用户原话里「如果同意…**如果否掉**…」的**下半条**。
  //    补之前 ①③④ 三道**没有回边**（状态机上从 supervising / ready_review / passed
  //    各只有一条出边，且那条都要求"确认方点头"）⇒ 主管在那三站说"不满足"时只剩 block/cancel。
  //    本条把四条否掉回边（含 ② 道既有那条）一起钉住：正例走完回边 + 反例（无记录 / 超预算 /
  //    越权代发 / 非枢纽任务 / 预算用尽连记录都交不上来）+ ⑤ 不是确认站点 + 四条边同构性。
  { file: './station-reject-check.mjs', exportName: 'runStationRejectCheck', zh: '站点否掉层（①③④ 三条新回边 + ② 道既有那条的同构性）' },
  // ★★ P0-1：用户新需求里「**主对话agent递给主管agent**」与
  //    「需求agent确认后递交主管agent**二次确认**，**无问题后**将架构agent递交计划agent」
  //    这两段的判据落点。本套给**正例**（新单递单 ⇒ 枢纽激活 + 逐站可达）与
  //    **反例**（中途单 / 非主对话 / 重复递单 / 递单后主对话仍想自己派需求位 /
  //    跳过 ②b·②c 交计划 / ②c 缺记录 / 顺序颠倒）—— "反例跑不过就不算实现"。
  { file: './p01-handoff-entry-check.mjs', exportName: 'runP01HandoffEntryCheck', zh: 'P0-1 入口与补确认环（主对话递给主管 / ②b 需求位确认 + ②c 主管二次确认）' },
  { file: './notify-only-delivery-check.mjs', exportName: 'runNotifyOnlyDeliveryCheck', zh: '只传话不派活的投递面（递给宿主的 signal 不许是 undefined；调用方真中止时仍然如实失败）' },
  // ★★ P2-7（2026-10-14）：交接物里的「**谁交的（席位）**」—— 补 `from_seat`。
  //    现象：真单 T-20261012-8cdee0 的 22 份 handoffs **一份都没有**这个键
  //    （不是 null，是压根不存在 ⇒ 按 `=== null` 筛不出来）。
  //    本套钉住四件事：多席位交付**落盘后** `from_seat === 'writer#2'`（判据是读盘）/
  //    单席位角色交付是**角色名**（不是 undefined / null）/ 旧记录**不迁移、不重写**
  //    （缺字段照样读得出）/ 取值三级来源可追溯（令牌席位 > 分区席位 > 角色名，
  //    且绝不误读 `seat_handover` 的 `payload.from_seat`）。
  //    ★ 全程密闭：夹具自造临时任务目录，**不引用活体真单**（不重蹈 orphan-rescue-check 那条）。
  { file: './handoff-seat-check.mjs', exportName: 'runHandoffSeatCheck', zh: '交接物席位（P2-7：from_seat 落盘 / 旧记录向后兼容 / 取值来源）' },
  // ★★ P2-8 的「**仍未验证**」那半边（2026-10-14 第二批）：`wake:delivered` /
  //    `wake:failed` / `wake:dedup` / `wake:escalated` 这四条各自的"顶走孤儿身份"效果
  //    —— C3 段只跑了 `wake:skipped` 一支，bug 单 P2-8 把剩下四条**如实登记为未逐条实测**。
  //    本套把那四条**逐个**放进生产形状里跑：正例（身份一字不变 ⇒ 第 4 轮 abandon +
  //    播报）/ 反例①（名字改一个字符 ⇒ 身份每轮都换 ⇒ **永不** abandon，"证明正例不是假绿"）/
  //    反例②（`wake:Delivered` 大小写漂移同样不命中 —— 剔除是**逐字**比对动作名）。
  //    ★ 全程密闭：时刻写死在盘上，**不靠 sleep 换秒**（不重蹈 P1-12 那条非密闭测试）。
  { file: './wake-identity-carry-check.mjs', exportName: 'runWakeIdentityCarryCheck', zh: '唤醒留痕与孤儿身份（P2-8：四条名字逐条实测 —— 身份不许被机制自己的留痕顶走）' },
  // ★★ P1-4：shell 守门的误判（2>$null / 引号里的 => 被当成写文件）、常见绕过写法、
  //    以及"一个会话绑着多张单时拿最老那张判"的作用域放大。全程密闭（临时项目根）。
  { file: './shell-guard-check.mjs', exportName: 'runShellGuardCheck', zh: 'shell 守门（P1-4：误判收窄 / 绕过补上 / 多单绑定按活跃单判）' },
  // ★★ 真机端到端测试（T-20261015-bb30bc）确认的 8 条缺陷 —— 一条修复一个独立小套。
  //    为什么**逐条**注册而不是合并成一个"修复回归套"：每条修复的判据不同源；合并之后
  //    "红一条 = 八条一起看"，退化时定位不到是哪一条。
  //    ★ 八套全程密闭：自造临时项目根，**不引用活体真单**（不重蹈 P1-12 那条）。
  { file: './f1-scope-root-marker-check.mjs', exportName: 'runF1ScopeRootMarkerCheck', zh: '缺陷①授权面锚点（`.` = 整棵项目根，与渲染口径同一边界）' },
  { file: './f2-slot-truth-check.mjs', exportName: 'runF2SlotTruthCheck', zh: '缺陷②四槽（声明 vs 事实：声明冻结、占位可覆盖且必须留痕）' },
  { file: './f3-path-targets-check.mjs', exportName: 'runF3PathTargetsCheck', zh: '缺陷③目标路径（正文不再被当成路径；拒绝文案点名真实目标与来源）' },
  { file: './f4-tester-exts-check.mjs', exportName: 'runF4TesterExtsCheck', zh: '缺陷④测试位允许面（可执行扩展名补上 + 拒绝文案给替代路径）' },
  { file: './f5-l0-baseline-check.mjs', exportName: 'runF5L0BaselineCheck', zh: '缺陷⑤L0 改动基线（自批那一刻记一次，R6 前后对比这才有判据）' },
  { file: './f6-patrol-notice-check.mjs', exportName: 'runF6PatrolNoticeCheck', zh: '缺陷⑥巡检播报（正文按判据本身写，不再一律自称「长时间无进展」）' },
  { file: './f7-task-purge-check.mjs', exportName: 'runF7TaskPurgeCheck', zh: '缺陷⑦收尾清理（终态单归档/删除：只认终态、先留痕、默认可恢复）' },
  { file: './f8-nonfinite-hint-check.mjs', exportName: 'runF8NonfiniteHintCheck', zh: '缺陷⑧非有限入参（需求侧提示，不改行为、不代写 boundaries）' },
  // ★★ 第二批（简报完整版带来的 ⑦b / ⑧ / ⑨ 与 ⑥ 的判据面）：
  { file: './f6b-patrol-clock-check.mjs', exportName: 'runF6bPatrolClockCheck', zh: '缺陷⑥巡检时钟（可复现判据：输入面逐条 + 现场时刻复算 + A23 幂等键）' },
  { file: './f8b-shell-attribution-check.mjs', exportName: 'runF8bShellAttributionCheck', zh: '缺陷⑦b/⑧shell 守门（引号里的英文单词不再当命令；拒绝理由按角色归因）' },
  { file: './f9-transition-record-check.mjs', exportName: 'runF9TransitionRecordCheck', zh: '缺陷⑨不改状态的迁移（必须交代"记了什么"，且不许指向不存在的台账）' },
  // ★★ 第三批（F11：四槽"声明 vs 生效"同源 + 逐槽证据等级）：
  { file: './f11-slot-truth-check.mjs', exportName: 'runF11SlotTruthCheck', zh: 'F11 四槽同源（声明 vs 生效；哪一槽是读回来的、哪一槽只是发出去了，逐槽给证据）' },
  // ★★ 第四批（F12：spawn=false 必须真的不建会话）：
  { file: './f12-spawn-false-check.mjs', exportName: 'runF12SpawnFalseCheck', zh: 'F12 spawn=false（不许碰宿主 create / subagents.start，只出可粘贴的派活单）' },
  // ★★ P1–P5 接线（`WIRING.md` §W8）：8 套对照测试**登记进聚合跑**。
  //    本批次（P1–P5）当初带"既有文件一个都不许改"的约束，所以这 8 套**刻意没登记**
  //    （理由逐条写在 `CONVENTIONS.md` §6 的"唯一例外"里）；解除约束的这一次补上，
  //    否则"run-all 全绿"会被读成"新功能也全绿" —— 而它们根本**跑不到**（假绿）。
  //    ★ 前置改动：这 8 个文件原来是"顶层立即执行 + process.exit()"的写法、没有导出运行器，
  //      已按本文件既有的 `{passed,total,text}` 约定各补一个 `runPNXxxCheck()`
  //      （直接 `node tests/pN-*.mjs` 的行为逐字未变）。落在这里而不是各自加 import，
  //      是沿用下面那条"按约定名发现"的既有通道 —— 发现不到就如实标"尚未落地"。
  { file: './p1-project-dir-check.mjs', exportName: 'runP1ProjectDirCheck', zh: 'P1 项目目录（幂等建目录 / 复用 / 既存优先 / 与授权面同源）' },
  { file: './p2-snapshot-version-check.mjs', exportName: 'runP2SnapshotVersionCheck', zh: 'P2 快照版本号（解析 / 段进位 / 序数比较：**禁止字符串排序**）' },
  { file: './p3-git-init-check.mjs', exportName: 'runP3GitInitCheck', zh: 'P3 git 化闸门（只有显式确认才 init；远端写不可表达）' },
  { file: './p4-agents-md-check.mjs', exportName: 'runP4AgentsMdCheck', zh: 'P4 AGENTS.md（独立模板 + 幂等四情形落盘）' },
  { file: './p5-product-catalog-check.mjs', exportName: 'runP5ProductCatalogCheck', zh: 'P5 产品目录 + 产品设计文档（分组校验：空 MVP 被拒 / 每条带验收判据）' },
  { file: './p6-demo-phase-check.mjs', exportName: 'runP6DemoPhaseCheck', zh: 'P6 DEMO 阶段（三档策略 / ★W3 接线专项：未确认不得进 ready_dev / 三条软约束）' },
  { file: './p7-hub-required-check.mjs', exportName: 'runP7HubRequiredCheck', zh: 'P7 L3+ 强制主管（先设后撤 / 需求位派活判据）' },
  { file: './p8-scope-root-check.mjs', exportName: 'runP8ScopeRootCheck', zh: 'P8 授权面锚点（项目目录与授权面同源）' },
  // ★★ 2026-10-16（用户原则：代码判定优先于 AI 判断）：把两条**存疑项**判据化。
  //    它们不是"再补一个用例"，而是把原来只能靠人读代码确认的两件事变成**会红的断言**：
  //      · p9  —— W6 的调用点**传对了参数没有**：探针记录 `requirementConfirmed` 的实际取值，
  //              并把"照 WIRING 原文会 BAD_TIER 误拒"做成断言（见该文件 §③）。
  //      · p10 —— `STATE_OWNER` 漏登记即红（判据：状态全集 ⊆ owner 键集合）。
  { file: './p9-orchestrator-dispatch-gate-check.mjs', exportName: 'runP9OrchestratorDispatchGateCheck', zh: 'P9 需求位派活判据（W6 判据化：接线处传的参数 + 照原文会误拒的对照）' },
  { file: './p10-state-owner-check.mjs', exportName: 'runP10StateOwnerCheck', zh: 'P10 STATE_OWNER 完整性（状态全集 ⊆ owner 键集合，漏一个即红）' },
  // ★★ 第五批（缺陷⑬：`pipeline_switch` 关掉后插件仍在拦 —— "开关只关一半"）：
  //    现场是**两条相邻调用**：`pipeline_switch {on:false}` 返回「任何调用都不再被本插件拦」，
  //    紧接着那次调用的**结果仍被 `tools/post-execute` 的"第二道网"换掉**。
  //    ★ 刻意拆成**六套各自只测一件事**（用户原话：「分文件，分文件」）——
  //      合并成一套"开关大测试"之后，"红一条 = 六件事一起看"，退化时定位不到是哪一件：
  //        · off ⇒ 结果不过滤      （缺陷现场）
  //        · on  ⇒ 结果被过滤      （正例对照：没有它，"off 不过滤"可能只是"缝本来就坏了"）
  //        · off ⇒ 无 hook 生效    （**计数**判据：挂载面 0 + 触发面 7 个 spy 全 0）
  //        · off ⇒ 不注入/不写盘   （唤醒咽喉 + 主对话记账面）
  //        · off ⇒ 周期机制停表    （巡检 / 孤儿单自恢复两条 setInterval）
  //        · 关掉的文案 = 事实     （面清单驱动文案 + 防漂移条数核对）
  //    夹具在 `switch-fixtures.mjs`（**不是测试**，刻意不登记 —— 它没有断言）。
  { file: './switch-off-no-filter-check.mjs', exportName: 'runSwitchOffNoFilterCheck', zh: '开关回归：off ⇒ 含代码正文的工具结果**不被过滤**（缺陷现场）' },
  { file: './switch-on-filter-check.mjs', exportName: 'runSwitchOnFilterCheck', zh: '开关回归：on ⇒ 含代码正文的工具结果**被过滤**（与今天行为一致）' },
  { file: './switch-off-no-hooks-check.mjs', exportName: 'runSwitchOffNoHooksCheck', zh: '开关回归：off ⇒ **无任何 hook 生效**（挂载面 0 + 7 个 spy 计数全 0）' },
  { file: './switch-off-no-inject-check.mjs', exportName: 'runSwitchOffNoInjectCheck', zh: '开关回归：off ⇒ 不注入会话、不写项目目录（唤醒咽喉 + 记账面）' },
  { file: './switch-off-mechanisms-check.mjs', exportName: 'runSwitchOffMechanismsCheck', zh: '开关回归：off ⇒ 巡检 / 孤儿单自恢复**停表**（不是空转）' },
  { file: './switch-off-text-check.mjs', exportName: 'runSwitchOffTextCheck', zh: '开关回归：关掉的**文案 = 事实**（面清单驱动 + 防漂移条数核对）' },
  // ★★ 记忆域（E0，`design/memory/06-分阶段.md`）：**只读切片**那两套。
  //    为什么现在就登记：本域是**解除"零修改既有文件"约束之后**写的（用户裁定 2），
  //    所以没有 `p1`–`p8` 那条"刻意不登记"的理由 —— 不登记就是**假绿**。
  //    E1 的 m1/m2/m3/m4/m8 落地后按同一位置继续追加。
  { file: './m5-memory-route-check.mjs', exportName: 'runM5MemoryRouteCheck', zh: '记忆取回 · 两路各自命中 + 合并去重 + 结果确定（R6/R7）' },
  { file: './m6-memory-budget-check.mjs', exportName: 'runM6MemoryBudgetCheck', zh: '记忆取回 · ★ 上限是硬的（R8/R9：超了必须截断，且保留高分那一段）' },
  // ★★ 记忆域 E1（retain 开始攒原料）：五套各自只测一件事。
  //    m8 是其中的**硬条件**：off ⇒ 一条缝都不挂 + 库一个字节不变（用户报过的"开关只关一半"）。
  { file: './m1-memory-record-check.mjs', exportName: 'runM1MemoryRecordCheck', zh: '记忆形状与校验（畸形点名拒绝 + 库落点 R16 + 迁移记忆形状）' },
  { file: './m2-memory-alias-check.mjs', exportName: 'runM2MemoryAliasCheck', zh: '实体归一（R4 折叠 / R5 **不误折**）' },
  { file: './m3-memory-append-check.mjs', exportName: 'runM3MemoryAppendCheck', zh: '追加写（R3 绝不抛 + 并发不互相覆盖、不写半行）' },
  { file: './m4-memory-retain-hook-check.mjs', exportName: 'runM4MemoryRetainHookCheck', zh: 'retain 缝只在"该记"时记（R1/R2/R3）+ 注入形状合法（R14）' },
  { file: './m8-memory-switch-check.mjs', exportName: 'runM8MemorySwitchCheck', zh: '★ 总开关：off ⇒ 零缝 + 库一个字节不变（R12/R13/R15）' },
  // ★★ 记忆域 E3（活文档）：渲染纯函数（R10）+ 写盘幂等（R11）+ **触发点正确**
  //    （关单 / 状态迁移会更新、普通工具调用不会、off ⇒ 一个字节都不改）。
  { file: './m7-memory-live-doc-check.mjs', exportName: 'runM7MemoryLiveDocCheck', zh: '活文档：渲染是纯函数 + 写盘幂等 + 触发点正确（E3）' },
  // ★★ 记忆域 E4（跨项目用户裁定库）：幂等 + **不覆盖外来 skill** + 写前备份 + 只在有用例时写。
  { file: './m9-memory-user-rulings-check.mjs', exportName: 'runM9MemoryUserRulingsCheck', zh: '用户裁定库：四条硬要求（幂等/不覆盖/先备份/不写空壳）+ off ⇒ 不写盘' },
  // ★★ 缺陷 A（记忆摘要变成 `[object Object]`，真机 2026-10-15 实测）：
  //    夹具形状必须与宿主一致（`tools/post-execute` 交来的是**信封** `{isError,value,content}`，
  //    不是工具的返回值）—— 否则判据再对也照绿。这一套用**真机那两条的真实结果**钉死它。
  { file: './m10-memory-digest-check.mjs', exportName: 'runM10MemoryDigestCheck', zh: '★ 结果摘要是"人话"（宿主信封 ⇒ 正文与去重键都不许出现 `[object Object]`）' },
  // ★★ 缺陷 B（水位下调读不到投影：`inject` 少了 `sessionProjections`）：
  //    装配面（`inject` 的**精确集合**）与"服务装得上 / 装不上 / 读失败"三种情形各自一条断言。
  { file: './m11-memory-pressure-inject-check.mjs', exportName: 'runM11MemoryPressureInjectCheck', zh: '★ 水位下调的装配面：`inject` 精确集合 + 装得上/装不上/读失败三种情形' },
  // ★★ 用户第 1 件（2026-10-16）：「补全主对话的能力 + 限制做成可见但需申请」。两套各测一件事：
  //    p12 —— **能力面**：`pl-main` 不低于 shipped 的 `preset-computer-use`（集合差 = 0），
  //           且受限工具**不隐藏**（`deriveToolFace` 给 main 的 denied 是空集）。
  //    p13 —— **申请通道**：未申请拒 / 申请中仍拒 / 批准后放行一次 / 用完再拒（四个状态逐条钉）。
  { file: './p12-main-capability-check.mjs', exportName: 'runP12MainCapabilityCheck', zh: '主对话能力面（不低于 computer-use + 可见但不隐藏 + 三条负例自证）' },
  { file: './p13-capability-grant-check.mjs', exportName: 'runP13CapabilityGrantCheck', zh: '★ 能力申请通道（申请 → 用户答复 → **放行一次** → 用尽即失效）' },
  // ★★ 用户第 2 件（2026-10-16）：「预设要在被安排身份后使用，而不是摆设」。
  //    p14 —— **派活那一刻**的 mode 实测值 = `pl-<role>`（显式声明优先；宿主没有 ⇒ 报错不降级）。
  { file: './p14-roster-preset-mode-check.mjs', exportName: 'runP14RosterPresetModeCheck', zh: '★ 派活按角色取 `pl-<role>`（显式声明优先 / role-preset 能下发 / 宿主没有 ⇒ 报错不降级）' },
  // ★★ 用户第 3 件（2026-10-16）：跨项目裁定库的**形状**要随插件走（内容不越界）。
  //    p15 —— 模板随插件发布：marker/begin/end 与运行时常量**逐字同源**，且模板不在
  //    运行时会写的那个路径上（否则 `publishRulings` 永远判 FOREIGN_SKILL_EXISTS）。
  { file: './p15-user-rulings-template-check.mjs', exportName: 'runP15UserRulingsTemplateCheck', zh: '★ 跨项目裁定库模板随插件发布（形状可复制、内容不越界、不在产物路径上）' },
]
