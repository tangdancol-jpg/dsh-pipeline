# dsh-pipeline · 多对话 AI 协作开发流水线

> 主对话只调度不干活；**编写 / 测试 / 审核三权分立**。
> 把「分档编排 → 结构化交接物 → 状态机 → 审核 OK 才关单」从**约定**变成**机制**。

一个 DSH（DeepSeek Harness）Host 半边插件。它不新建运行时、不改宿主、不碰别的插件，
只做一件事：**让"该走的流程"变成走不过去就走不下去的东西。**

---

## ★ 设计目的（本项目的目标函数，先读这一节）

> **用户原话：**
> 「分开跑项目的目的是让 ai 别过度工程化，要求只干自己该干的，
> **编程别跑测试，编排别看代码**」

这不是一句口号，它是**这个插件为什么存在**。整个项目可以理解成：
**把"防过度工程化"翻译成机器可执法的角色边界。**

### 过度工程化在实践里长什么样

它很少长得像"我故意写复杂了"。它长得像下面这两件事 —— 都很合理，都很难反驳：

| 现象 | 听起来像 | 实际后果 |
|---|---|---|
| 写实现的人顺手把测试也写了 | 「我自己测过了，没问题，省一轮」 | 测试证明的是**他自己的理解**，不是需求。缺陷会被写成"符合预期" |
| 做需求/计划的人先去读实现 | 「不了解现状怎么定方案」 | 他开始定字段名、选算法库、加抽象层 —— 于是**方案里出现了需求里没有的复杂度**，而这份复杂度没人要求过 |

### 为什么"分角色"能防住它

关键不在于**分工**，而在于**能力边界**：

1. **能力不给，而不是"劝你别用"**。
   `writer` 的白名单里**压根没有**测试类产物（`test_to_review` / `test_to_dev`），
   测试类命令在守门层被**拦下**；`orchestrator` / `planner` **读不到**源码正文
   （read / 检索 / shell 读三道都拦），产物里出现代码正文会被**拒收**。
   —— 提示词里写"请不要"是建议；把能力从手里拿走才是机制。
2. **边界画在"该干的活"上，不画在"人"上**。
   同一个 `pwsh`：`tester` 跑 `npm test` **放行**，`writer` 跑 `npm test` **拦**。
   拦的是职责，不是命令。
3. **白名单方向**：忘了给某角色加能力 = 少一条能力（会被明确拒绝）；
   忘了从黑名单里删 = **悄悄多一条能力**。所以全项目一律只写"谁能做"。
4. **交接物是固定字段的**：没有"自由发挥"的字段，越权与跳步才有可能被**机械判定** ——
   这也是为什么"设计目的"能落成判据，而不是落成一句劝告。

### ★ 总原则（用户原话，先读这一句）

> 「**ai 的行为不要靠自然语言限制，要靠代码层直接拦截**」

写在角色卡（`summary`）、提示词、README 里的“不得 / 不许”，那是**愿望**；
只有落在守门（`guard.execute`）、状态机（迁移表 + 前置条件）、schema 校验里的，
才是**边界**。本项目的做法是：**每条能判据化的要求都必须有一个判据落点**；
判据化不了的**如实列出来**（见下面的[三类盘点](#自然语言-vs-代码层三类盘点)），
**不许假装它被执法了**。

这条原则的机器可读版本：只读子命令 **`pipeline_boundaries`**
（`format=json` 给出「谁、什么边界、命中哪条判据」的完整清单，
并做一次**漂移检查**：角色表里的 `writes` 取值若守门认不出，会出现在 `unmapped` 里）。

### ★ 哈希前置闸门（**排在一切测试之前**）

用户原话：「**先过哈希对比，哈希对比不过全量测试直接打回**」。

```
编写交产物（dev_to_test）
  ├─ ① 形状核对：change_manifest 每条引用一个存在的授权条目
  ├─ ② ★哈希闸门：按派活基线逐文件比（新增 / 修改 / 删除 三类都查）
  │     ├─ 通过 → 放行 → 进测试
  │     └─ 不通过 → **直接打回编写**：不进测试、**不消耗测试预算**、不进全量审批链
  └─ ③ 之后的才是：测试 → 审核 → 关单
```

- **对比对象**：派活那一刻的**基线**（文件清单 + sha256）＋ 计划的**授权面** ＋ 编写的**改动声明**。
- **四类不通过**：新增清单外文件 / 修改清单外文件 / **删除清单外文件** / **声明不实**
  （实际动了却没在 `change_manifest` 里报 —— 哈希是真相，声明是承诺，对不上就等于核对了假的）。
- **打回理由可执行**：逐条给出 哪个文件 · 基线哈希 · 实际哈希 · 期望怎么办 · 本次授权面。
- **不许"先跑一下看看"**：闸门没过期间，**任何角色（含 tester）**跑测试（定向与全量都算）
  都会被守门拦下（分支 4g，排在"全量审批"那条 4f **之前**）。
- **落档**：`task.hash_gate_checks[]`（每次比对的时间 / 发起人 / 席位 / 通过与否 / 连续第几次 / 越界明细）
  + 审计事件 `gate:hash`（可追溯）。
- **设计意图**：**不合格的提交不该消耗测试资源** —— 省时间省 token 的第一道闸。
- **L0 弃权**：L0 没有"计划"这一站 ⇒ 没有基线 ⇒ 这道闸不适用（与 P4 同源）。

> 正反例：`tests/hashgate-check.mjs`（**61 条**：判定层 7 + 执法层 31 + 连续不过与自动交人工 17 + 打回预算回归 3 + 关掉自动升级 3）。

#### ★ 连续 N 次不过 ⇒ 自动交人工（用户拍板 P13，2026-10-11）

闸门不通过**不消耗** `maxReworkPerLeg`（`hash_gate` 那一段一个字都没动）。理由：

> 任务从未离开 `developing` —— **"打回"严格说没发生**（提交本身就不成立，
> 交接物根本没落盘）。预算是为"真的来回拉锯过"设的（审核/测试把产物打回来），
> 不该被一次没成立的提交扣掉。

代价是"编写可以无限重交"。堵这个副作用的位置**不是扣预算**，而是**把人请回来**：

| 项 | 语义（写死，别处不许再定义一遍） |
|---|---|
| 计数 | `task.hash_gate_streak`：闸门不通过 +1 |
| **归零的唯一点** | **一次闸门真通过的提交**（或用户答复了本机制发出的那条人工请求） |
| **撤回越界改动** | **不归零** —— 撤回不是机制可观测的事件（机制只看得到"下一次提交过没过"）；若撤回就归零，`撤回→重交→再越界→再撤回` 可以无限循环，而每次**看起来都有进展** |
| 阈值 | `hashGateEscalateAfter`，**默认 3**；**`0` = 关掉自动升级**（退回 P13 之前的行为，闸门照旧拦、预算照旧不扣） |
| 到阈值 | **机制自动**发起一条 `human_request`（`reason_kind=hash_gate_escalation`），走**既有的**两级梯：发起 → 主对话转告 → 用户答复 → 恢复 |
| 谁发起 | `from_role` **逐级回退**：需求分析（`orchestrator_mode=separate`）→ **取基线的那个人**（`baseline.taken_by`）→ **计划 AI**。每一步都过 `ROLES_CAN_RAISE_HUMAN`（原因见下面的"发起人必须发得出来"） |
| 升级之后 | 用户答复之前，同一任务的 `dev_to_test` **被拒收**（`HASH_GATE_ESCALATED`）—— 不是提醒，是拒收 |
| 答复之后 | **重新武装**：计数归零、可再次累计、可再次升级（`round` +1）。理由：答复未必真能解决问题；若升级一次就永久失效，第 4 次以后的失败就**没人管**了 —— 那正是本条要堵的"无限重交" |
| 人工答复 | **一个字没放宽**：仍必须带 `user_quote`（本人原话）+ `attribution`（谁在哪说的），`human_reply_has_source` 判据原样生效 |

- **不是另起一套并行机制**：用的是既有的 `human_request` 交接物 + `task.human_requests`
  生命周期 + `awaiting_human` 那两条边 + 既有的转告/答复/恢复四步。唯一"新"的东西是
  **一个枚举值**，以及"**只有机制发得出来**"那条闸 ——
  角色走 `pipeline_handoff` 发 `reason_kind=hash_gate_escalation` 会被拒
  （`HASH_GATE_ESCALATION_IS_SYSTEM`）：阈值是机制数的数，不该交给被考核的那一方去声明。
- **落档**：`task.hash_gate_escalation`（`round` / `streak` / `threshold` / `request_id` /
  `handoff_id` / `from_role` / `answered_at` / `user_quote`）+ 审计
  `gate:hash_escalate`、`gate:hash_rearm`（答复后重新武装）、`gate:hash_escalate_failed`（升级没发出去时）。
- **发起人必须发得出来**：`from_role` 逐级回退 —— 需求分析（有独立编排）→ **取基线的那个人**
  → **计划 AI**；每一步都要过 `ROLES_CAN_RAISE_HUMAN`。为什么不能直接照抄 `baseline.taken_by`：
  基线**可以重取**，重取允许"主对话兜底"，而 `main` **不在**能发起人工介入的白名单里 ——
  照抄会让升级**静默发不出去**（只剩一条 `gate:hash_escalate_failed`）。
- **可见性**：`pipeline_status` 给出 `hash_gate` 视图（`blocked` / `streak` / `threshold` /
  `accepting_submissions` / 最近 20 次比对 / 升级记录）；守门分支 4g 的文案也会区分
  "你回去改" 与 "已经交人工了，等人回话"。

### ★ 全量测试审批链（默认定向；全量要四级点头）

用户原话：「**需求 ai 要确认是否，并尽可能让测试 ai 少跑全量测试**，如果测试 ai 要跑
必须提交给需求 ai 和审核 ai 确认，如果都认为要做再提交给主对话给用户人工审核，
确认人工通过后再提交给计划 ai 安排」。

**默认产物是定向/增量测试**：按本次**改动面**挑相关用例。全量是**例外**，走这条链：

```
tester 交 full_test_request（改动面 / 已跑过的定向 / 为什么定向不够 / 打算怎么跑）
  → ① 需求分析  full_test_review stage=need    （这次是否真的需要）
  → ② 审核      full_test_review stage=worth   （值不值得）
  → ③ 主对话     pipeline_human_request reason_kind=full_test_approval → 用户答复
  → ④ 计划 AI   full_test_review stage=arrange（范围 + **最终批准的命令**）
  → 守门按"批准的那条命令"放行
```

- **缺一级都不许开跑**；任一站否决 ⇒ 链停住、留痕，之后全量命令**仍然被拦**。
- **判据**（`lib/testscope.js`）：带 `-k/--grep/-t/--filter/--testPathPattern/具体测试文件/具体包`
  ⇒ **定向，直接放行**；裸跑整套（`npm test` / `pytest` / `go test ./...` / `node --test tests/`）
  ⇒ 全量，要凭据。批一条跑另一条也会被拒。
- 与**澄清梯**的分工：`clarification_*` 问答的是"**需求清不清楚**"；这条链回答的是
  "**这套测试值不值得跑**"（成本决策）。形状相同，所以**合流**：人工那一站直接用既有的
  `human_request` / `human_reply`（`human_reply_has_source` 判据一个字没动）。
- **与目标函数的关系**：这条链是"改动面 = 授权面"（定向就是按改动面挑用例）与
  Stop Ladder 第四问（"没它会失败吗？" ⇒ 申请单里必填 `why_targeted_insufficient`）的延伸。
- 看进度：只读工具 **`pipeline_full_test`**（还差谁点头、凭据是哪条命令）。

> 正反例：`tests/fulltest-check.mjs`（44 条：判定层 24 + 执法层 9 + 终点 11）。

### ★ 拦截缝（做在插件自己里，不是另起一套）

用户原话：「**我是让你安排写入多 ai 协同插件中去阻止他们干不该干的事，而不是新写**」
「真正的拦截必须是代码」。

所以本插件把守门判据**同时**挂在宿主的**拦截扩展点**上（原生 Cordis 事件，不走 hooks.json）：

| 缝 | 事件 | 拦什么 / 给什么 |
|---|---|---|
| ① | `tools/pre-execute`（PreToolUse） | **同一份守门判据**：编写跑测试 / 控制角色读代码 / 写到授权面外 / 退休席位动手 ⇒ `{kind:"deny", reason}`（理由用户可见；★ 并落一行 `seam:tool-deny` 审计，见下） |
| ② | `agent/pre-step`（UserPromptSubmit） | **注入**席位边界卡 + Stop Ladder 四问（每席位一次）；★ **不否决**：判据命中只注入一条**用户看得见的说明**（+ `seam:prompt-advice` 审计）—— **用户消息层不做越界判据**（用户有权粘贴任何东西），判据落点在 ① |
| ③ | `tools/post-execute`（PostToolUse） | **第二道网**：控制角色的工具结果里带代码正文 ⇒ `{kind:"block", feedback:[…]}` |

> ★★ **绝不静默**（2026-10-16 真机缺陷）：`agent/pre-step` 的 `{kind:"reject"}` 是宿主的
> **一票否决** —— turn 根本不开始，所以拒绝理由**没有任何出口**（现场：把 `pl-main`
> 预设全文粘进主对话 ⇒ 命中自己文档里的那条规则散文 ⇒ **这一轮 1 秒结束、消息像没发出去**，
> 插件侧零留痕）。修法三条：①**用户消息层不做越界判据**（那条规则的本意是拦
> **Agent 自己去看实现**，不是拦用户叙述规则）；②判据落点收窄到 ① 的 `tools/pre-execute`；
> ③ 凡是否决 / 提示，**必有可见文案 + 一行审计**（`lib/intercept/seam-voice.js`，
> 只追加 `.pipeline/<任务>/audit.jsonl`，**不碰 `task.json`**——拒绝不是进展）。
> ★★ **扫的是整轮 prompt**（三条路径全中招）：判据的输入端是 `collectPromptText(payload)`
> （`lib/intercept/prompt-rules.js:73-81`，调用点 `lib/guard/hook-prompt.js:81`）——
> 它把 `payload.messages[]` 里**每一条**消息**拼起来**再跑正则，而且
> **一个字节都不读 `m.source`**。所以下面三**类**文本被同等对待：
> ① **用户输入**；② **席位派活 / 唤醒**（派活单 + runtime context + 记忆切片 + 边界卡 + notify + persona 首尾 —— 席位可能被**自己的人设**掐死）；
> ③ ★ **注入 / 回灌**（真凶）：席位干完 → 结论经 `lib/hostmsg.js` 回灌 / 唤醒给主对话 → 那条**注入消息**命中扫描 → 主对话这一轮被静默掐掉（UI 显示"已完成，用时 1 秒"）→ **席位看起来"停住了"、任务看起来"卡住了"，且零报错**。
> 回归：`node tests/silent-veto-check.mjs`（① 语料 A/B/C）·
> `node tests/silent-veto-seat-check.mjs`（② 回归 16/17）·
> `node tests/silent-veto-inject-check.mjs`（③ 回归 19/20）。

**为什么不走 `dsh-hooks-claude-code`**：`dsh-hook-protocol` 自己的 README 就写着
「定制行为请避开整个组：原生 Cordis 插件拥有完整的 harness API」；而且 (b) 要往别人的
profile 配置里加条目、每个钩子起一个子进程、判据还得重写一份（必然与守门漂移）。
走 (a) 时两条缝调用**同一个** `guard(exec)` —— 判据只有一份。

**作用域（不做就是事故）**：这些缝是宿主级的，每个会话都会经过。所以第一句永远是
「这个会话是不是本插件派出去的管线席位」（判据 = 该 agentId 在**本插件的令牌表**里绑了角色）。
不是 ⇒ **直通放行**。用户自己的对话、别的项目、别的插件的会话一律不管；
主对话也直通（它只在调 `pipeline_*` 工具时受守门约束，行为与以前完全一致）。

**kill-switch**：① 配置 `intercept: false`（重启生效）；② 右上角总开关 / `pipeline_switch`（**即时**）。

**重启影响面**：插件本体（含拦截缝）**要重启**；自带的 Skill **不用**（下个会话可见）；
总开关**不用**。详见 `REPORT.md` 第十八节 §18.14。

**Stop Ladder 四问**作为插件自带资源躺在 [`skills/stop-ladder/SKILL.md`](skills/stop-ladder/SKILL.md)，
由 `install.ps1` 一步装到 `<dsh-home>/skills/stop-ladder/`，`rollback.ps1` 一步撤（只撤带本插件标记的那份）。
四问是**引导**，拦截在代码里 —— 两者都要有。

### 自然语言 vs 代码层：三类盘点

用户要求做一次**逐条盘点**：把现有代码/文档里所有"靠 summary、注释、提示词、README 约束"的条目
列出来，分三类。下面是**如实**的清单（不是抽样，是这一版的全量）。

判定口径：一条要求算 **(a) 已判据化**，必须能指出"哪一行代码会因为它拒绝一次调用"。
指不出具体判据落点的，一律不许往 (a) 里放。

#### (a) 已判据化 —— 有判据落点（**33 条**）

| # | 以前只写在文档 / summary / 提示词里 | 现在的判据落点 |
|---|---|---|
| 1 | 编写"不得替测试跑测试" | `guard.scanTestRunnerCommand`（8 条命令模式） |
| 2 | 主对话 / 需求分析 / 计划"不读代码" | `guard.NO_CODE_READ_ROLES`（读工具 + 检索工具 + shell 三路） |
| 3 | 控制角色"产物里别贴代码" | `handoff.scanControlRoleProductForCode`（`validateHandoff` 里） |
| 4 | 需求分析"不分配 AI" | `handoff.scanRequirementAnalysisForAllocation` + `pipeline_orchestrate` 不可传 tier |
| 5 | 需求分析 / 计划"要写清自己只干什么" | `handoff.validateRoleScope`（`will_do` / `will_not_do` 两栏都非空） |
| 6 | 计划"必须给每个角色写边界卡" | `store.setRoster` 的 `ROLE_BOUNDARIES_INCOMPLETE` 覆盖性核对 |
| 7 | 编写"别改整个模块" | `guard.owningChangeScopeEntry` + `store.checkManifestAgainstScope` |
| 8 | 编写"别顺手重构 / 升级依赖" | 同上：`change_scope` 的 `why` 写不出来 ⇒ 拿不到授权（守门按路径拦） |
| 9 | 编写"新增文件也算越界" | `guard` 判定里 `existsSync` 分支（`create` 授权不得用于改已存在文件） |
| 10 | 编写"要交实际改动面" | `store` ④b0：有授权面则 `change_manifest` 必填，每条须引用存在的授权条目 |
| 11 | 审核"要确认没多改" | `store.changeAudit`（基线哈希比对）+ `SCOPE_CONFORMANCE_FAILED` |
| 12 | 审核"不能只说我看了一遍" | `MISSING_CHANGE_AUDIT` / `CHANGE_AUDIT_STALE` / `CHANGE_AUDIT_MISMATCH` |
| 13 | 审核"有多改不许发 OK" | `CHANGE_OUT_OF_SCOPE_OK` |
| 14 | 审核"要一起配合（开工前知情）" | `pipeline_dispatch` 的 reviewer 开工前简报（授权面 / 禁令 / 边界卡 / 基线） |
| 15 | 审核"不能提前下结论" | 状态机：`review_verdict` 只在 `reviewing` 可交 |
| 16 | **审核只读**（只有自己的日志可写） | `guard.writeClassOf('reviewer')='own-log'` + `checkOwnPath` |
| 17 | **测试只读**（只有自己的产物/日志可写） | `guard.writeClassOf('tester')='own-dir'` + `checkOwnPath` |
| 18 | 控制角色"不写文件" | `guard.writeClassOf('main'/'orchestrator'/'planner')='readonly'`（连 reports/ 也不给） |
| 19 | 测试 / 审核"不得替编写改代码" | **本轮从 summary 变成判据**：`own-dir` / `own-log` 的路径判据（源码路径天然不在允许面内） |
| 20 | 需求档"唯一写者是留档 AI" | `guard` 的需求档路径判据（别的角色写 `requirement.md` 即拒） |
| 21 | 留档 AI"不得凭空写入无来源内容" | `store.compileRequirement` 的 `UNSOURCED_CONTENT`（每条须指向真实记录） |
| 22 | 发布 / 文档 / 性能"关单前必须给出产物" | **本轮新增**：关单组合闸 `role_products_delivered`（与 `diagram_delivered` 同形） |
| 23 | 架构图角色"必须交图（或标 degraded）" | 关单组合闸 `diagram_delivered` / `DIAGRAM_STALE` |
| 24 | 安全角色"有否决权" | `security_not_blocked` + `security_attested` 关单闸 |
| 25 | 审核 OK"是关单唯一入口" | `review_ok_exists` 关单闸 + `review_ok` 迁移（只有 reviewer 能发） |
| 26 | 三权分立"不能互换" | 迁移表 + `guard.HANDOFF_DIRECTION`（方向表） |
| 27 | 编写"不能直接交审核" | `roles.handoffKinds`（白名单方向）+ 状态机（`developing → ready_review` 不存在） |
| 28 | "不能无限打回" | `rework_budget` 前置条件（`maxReworkPerLeg`） |
| 29 | "不能无限澄清" | `maxClarifyRounds` + `clarification_blocking` 前置条件 |
| 30 | 主对话"不能自己加人减人" | `roles.canRequestRosterChange=false` + `reviewRosterChange` 只认 planner |
| 31 | 主对话"不能决定用几个 AI" | `pipeline_orchestrate` 的 tier 由规则引擎给 + 计划 AI 才出角色清单 |
| 32 | "不许删审计留痕" | `guard` 的 shell 判据（删 `.pipeline/` 台账即拒） |
| 33 | 席位"只能交自己那份" | `store` 的 ④b 席位归属核对（`SEAT_PATTERN` + `scope_paths`） |

#### (b) 可判据化但尚未做 —— **本轮做完了，本类现在为空**

| 本轮做掉的 | 之前的状态 | 现在的判据 |
|---|---|---|
| B1 测试 / 审核"不得替编写改代码" | 只写在 `roles.js` 的 `summary` 里 | `own-dir` / `own-log` 路径判据（源码路径不在允许面内 ⇒ 天然拦下） |
| B2 测试只写"自己的测试产物/日志" | `writes: 'reports'`（整个 reports/ 随便写） | `own-dir`：只写 `reports/tester/tester*.<ext>` |
| B3 控制角色"不写文件" | `writes: 'none'` 但守门实际上**放行 reports/** | `readonly`：项目内任何写入都拒（连 reports/ 也不给） |
| B4 发布 / 文档 / 性能"关单前必须交产物" | 只写在 `summary` 里（"关单前必须给出……"） | 关单组合闸 `role_products_delivered` |
| B5 全角色权限"文档与代码对齐" | 没有对账机制，靠人记得改两处 | `pipeline_boundaries` 的 **`unmapped` 漂移检查** + 自测断言"认得出的角色 = 全部角色" |

#### (c) 判据化不了 —— **仍是自然语言约束**（如实列出，不假装被执法）

| # | 约束 | 为什么判据化不了 |
|---|---|---|
| C1 | 别过度设计 / 计划要合理 | "过度"取决于具体项目与验收标准，没有可机械判定的形式。能判的只有它的**可观测形态**（改动面超授权、新增未授权文件）—— 那已由 (a)-7/8/9 覆盖 |
| C2 | 需求分析要问得全 / 计划自检要到位 | 只能强制"必须显式产出清单"（`unclear_points`、`self_check.checked` 必填），但"清单够不够"没有形式化判据 —— 那正是需要**用户确认**那一步的原因 |
| C3 | 交接物要写得清楚（补丁说明 / 变更说明的质量） | 只能约束字段存在与长度下限；写得好不好是主观判断 |
| C4 | 测试要"独立设计"用例 | 独立性来自 DSH 的子代理上下文（另一个会话、没有编写的上下文）；本插件能保证的只是"谁的活谁交"与"用例/证据字段必填" |
| C5 | 主对话不得把令牌转手 | 令牌就在主对话手里，这是设计上的**信任根**。开了 `requireAgentBinding` 之后令牌与会话一一对应、转手即失效 —— 那是**配置项**，不是判据 |
| C6 | 不得用 shell 刻意混淆绕过判据（变量拼接 / 编码执行 / 先写脚本再跑） | shell 侧本来就是**字符串匹配**的 best-effort。硬的只有文件工具那一路（直接读参数里的路径）。真封死要靠环境侧（不给 shell / 不给测试环境） |
| C7 | 未绑定角色的会话不受约束 | 刻意如此：守门只约束**流水线参与者**，否则会和别的插件打架 |
| C8 | 记录之间矛盾时留档 AI 不得自己拍板 | "两条记录互相矛盾"是语义判断。能判的只有"每条内容必须指向真实记录"与"必须走澄清/升级"这个**出口**的存在 |

> 上面三张表的机器可读版本就是 `pipeline_boundaries` 的输出：
> `rules[]`（(a) 的规则 → 判据函数）、`advisory_limits[]`（(c) 的诚实边界）、
> `unmapped[]`（漂移告警）。**别的执法层**（例如在 DSH 层挂 `UserPromptSubmit` /
> `PreToolUse` 钩子的那条线）不需要读本插件源码，读这份 JSON 就能复用同一套边界。
> (c) 类也一并导出 —— 好让钩子层知道**哪些位置它拦不住**，别白费力气。

### 一句话记法（**六条规则**）

```
① 编写  只写代码           → 不跑测试、不判通过、不交测试报告
② 需求分析 / 计划          → 不看代码，只吃需求档 + 脱敏摘要 + 只给路径的目录结构
③ 最小改动                 → 改动面必须与授权面相等；多改一行也算越界
④ 职责自限                 → 分析与计划的产物里写明"我只做什么、不做什么"，
                             并为每个角色写死边界卡，派活时按它派
⑤ 双轨派活                 → 计划一出，编写与审核**同时**接任务；审核开工前就拿到
                             授权面 / 越界清单 / 边界卡 / 改动基线（链路不变）
⑥ 审核只读 + 前后版本对比  → 审核除自己的日志外**什么都写不了**；
                             靠**改动基线**逐文件哈希对比确认"有没有多改"
```

前两条是「能力不给」（守门拦工具调用），第三四条是「面与边界」（改动面 = 授权面；
每个角色的边界卡），第五六条是「开工前知情 + 事后有据」。六条合起来是同一件事：
**让"顺手多干"在机制上做不到，而且做了也留痕。**

### 规则⑤⑥ 的执法点（用户原话：「审核 ai 要一起配合确认有没有多改……审核 ai 只读，只有属于他的日志文件有权限写入」）

| 规则 | 判据落在哪 | 拦的是什么 / 给出什么 |
|---|---|---|
| **⑤ 双轨派活** | `pipeline_plan` 产出计划后，`pipeline_dispatch role=reviewer` 在**开工前**就能派出；派活单里附**开工前简报**（授权面 / 越界清单 / 边界卡 / 基线） | 审核不再"等产物到了才知道要审什么"；但**不能提前出结论**（状态机那道闸没动） |
| **⑥ 审核只读 + 对比** | ① 角色表 `writes: 'own-log'` + 守门的专属路径判据；② `pipeline_change_audit` 按**基线**逐文件哈希比对；③ `review_verdict.change_audit` 必填且 store **自己重算核对** | ① 写 `reports/` 下别人的文件、写源码、写需求档 → 全拒；② 多改 / 少改 / 改错地方三类都报；③ 报"没多改"但实测有 → 拒；有多改还发 OK → 拒 |

**改动基线**（`pipeline_plan` 产出计划时**自动**记录）：项目根的文件清单 + 每个文件的 sha256，
**只存清单与哈希、不复制源码**，并绑定那次计划的 `handoff_id` ⇒
"可证明就是派活那一刻的状态"。审核**不需要读代码**就能做前后对比 —— 与规则②兼容。

**审核为什么必须只读**：它一旦手里有"写"的权限，就有"顺手改一下"的诱惑，
而它的角色意义恰恰是**独立核对**。给审核一支笔，它就从"核对者"滑向"共谋者"：
发现问题顺手改掉，然后判自己 OK。收掉这支笔，它就只能**报出来**。

> 可执法清单 + 正反例：规则①② 见 [`tests/boundary-check.mjs`](tests/boundary-check.mjs)（42 条），
> 规则③④ 见 [`tests/scope-check.mjs`](tests/scope-check.mjs)（28 条），
> 规则⑤⑥ 见 [`tests/review-check.mjs`](tests/review-check.mjs)（51 条）。
> 总原则的三类盘点见上（含 (c) 类诚实清单）。
> 完整取舍见 `REPORT.md` 第十八节。

---

## 目录

- [★ 设计目的（本项目的目标函数，先读这一节）](#-设计目的本项目的目标函数先读这一节)
- [三十秒看懂它在干什么](#三十秒看懂它在干什么)
- [装 / 卸](#装--卸)
- [右上角那个开关（UI）](#右上角那个开关ui)
- [怎么用（一整个任务的生命周期）](#怎么用一整个任务的生命周期)
- [角色](#角色)
- [分档与编排判断（L0~L5）](#分档与编排判断l0l5)
- [状态机](#状态机)
- [人工介入（两级升级梯）](#人工介入两级升级梯)
- [分权落档与「留档 AI」](#分权落档与留档-ai)
- [编排自己的继任与「新联系人广播」](#编排自己的继任与新联系人广播)
- [安全确认](#安全确认)
- [编写分工（1~3 席位）](#编写分工13-席位)
- [架构图角色](#架构图角色)
- [结构化交接物 schema](#结构化交接物-schema)
- [工具面（38 个）](#工具面38-个)
- [落盘布局](#落盘布局)
- [守门：哪些是真拦截，哪些只是约定](#守门哪些是真拦截哪些只是约定)
- [通信通道（可插拔）](#通信通道可插拔)
- [与其它插件共存](#与其它插件共存)
- [自测](#自测)
- [已知限制](#已知限制)
- [待确认项（规格里没定的，我**没有**替你拍板）](#待确认项规格里没定的我没有替你拍板)
- [排障](#排障)

---

## 三十秒看懂它在干什么

传统做法：你写一段提示词，告诉模型"你是主对话，别写代码，要派活给别的 AI"。
模型心情好就照做，心情不好就自己动手了。

本插件的做法：**把规则写进 `ctx.tools.guard`**（DSH 的单调守卫，在工具真正执行**之前**判定）。

| 你想禁止的事 | 传统做法 | 本插件 |
|---|---|---|
| 主对话自己写代码 | 提示词 | 它没有 writer 令牌 → 状态机不认 → 就算硬写，写文件工具会被守门按**路径**拦下 |
| 编写绕过测试直接找审核 | 提示词 | `review_verdict` 的产出角色只认 reviewer；状态表里**根本没有** `developing → ready_review` 这条边 |
| 没有审核 OK 就关单 | 提示词 | `pipeline_close` 硬校验"存在有效 OK 交接物"，没有就拒（附判据原文） |
| 测试偷偷替编写改代码 | 提示词 | 测试角色写项目源码 → 守门按"角色 + 受保护路径"拒 |
| 主对话自己加人减人 | 提示词 | 角色清单只能由编排判断写；主对话连 `pipeline_roster_review` 都调不动 |
| 无限打回 | 提示词 | 打回计数 + 预算，超限即拒，并给出替代出路 |

这些**不是**"文档里写了"，是 `tests/selftest.mjs` 里真跑出来的反例，每条都带拒绝原文。
详见 [守门](#守门哪些是真拦截哪些只是约定)。

---

## 装 / 卸

> ⚠️ **本插件的作者没有替你装。** 安装脚本写好了、在沙箱 profile 上验证过（改造→幂等→回滚→逐字节还原），
> 但**没有对真实 profile 执行过**。装不装、什么时候装，由你决定。

本插件**没有任何运行期第三方依赖**：只用 node 内置模块 +（可选的）`@deepseek-ai/dsh-tools`（宿主提供）。
所以安装**不跑 pnpm、不装包**，只是复制文件 + 追加两行配置。

### 安装

```powershell
cd <插件目录>
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

先预演一遍（不改任何文件）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
```

常用参数：

| 参数 | 说明 |
|---|---|
| `-Profile desktop` | profile 名（默认 `desktop`） |
| `-ProjectRoot "C:\path\to\repo"` | 流水线工作区根；留空 = 用 session 的工作目录 |
| `-Transport auto\|subagent\|manual` | 角色驱动通道（默认 `auto`） |
| `-NoSpawnRoles` | 只发令牌、**不创建**角色会话（零 token 的演示/试跑模式） |
| `-GuardMainReadsCode:$false` | 不拦"主对话读代码" |
| `-MaxReworkPerLeg 2` | 单条打回链上限 |
| `-L0OrchestratorSeparate` | L0 也拆出独立编排对话（见[待确认项](#待确认项规格里没定的我没有替你拍板)） |
| `-WithDocs` | 额外装上 `examples/` `REPORT.md` `tools/`。**`tests/` 是默认装的**（`pipeline_selftest` 依赖它） |

脚本做五件事，**改任何文件之前先备份**：

1. 备份 `cordis.patch.yml` 与 `package.json`（带时间戳，同目录）
2. 复制运行期文件到 `<profile>\node_modules\dsh-pipeline`
   （`index.js` / `lib/` / **`tests/`** / `package.json` / `cordis.patch.yml` / `README.md` /
   `ARCHITECTURE.md` / 两个 `.ps1`；自动剔除 `last-run.txt`、`demo-project/` 这类跑出来的产物）
3. 清掉目标目录里上一轮留下的非运行期目录
4. 往 `package.json` 的 `dsh.profile.bundles` **append** 一个名字（幂等）
5. 往 `cordis.patch.yml` **append** 一个 `insert` 条目（幂等）

> 它**只动自己那一行**：不重写整份文件、不碰别人的条目、不碰 `cordis.yml`。
> `package.json` 用正则定位 `bundles` 数组后插入，避免重新序列化丢掉原有格式。

### 生效方式

**安装 / 卸载 / 改配置需要重启 DSH。** Host 半边插件在启动时装载，热更不覆盖。
**但右上角那个开关是运行期状态，切换立即生效，不需要重启、不需要刷新页面。**

重启后在日志里找这一行确认装上了：

```
[pipeline] dsh-pipeline 0.1.0 已加载：38 个 pipeline_* 工具已注册；守门已启用；通道=<auto|session|team|subagent|manual>（...）；工作区=...；多AI 协调开关=**开**（revision 0，默认值）。
[pipeline] 开关 UI 端点已挂载：GET/POST /.dsh-pipeline/state（右上角「多AI 协调」按钮走它）。
```

### 装完第一件事：跑自检

在任意对话里调一次：

```
pipeline_selftest
```

它会当场跑完**正例全流程 + 10 组反例 + 分档验证**，并**原样打出每条拒绝理由**。
不创建任何真实会话，只在一个临时目录里跑，跑完即删。

看到 `ok: true` 就说明机制真的在生效，而不是"以为装上了"。

### 卸载

install 脚本结束时**会打印精确的回滚命令**，直接复制：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<profile>\node_modules\dsh-pipeline\rollback.ps1" -Stamp <时间戳>
```

或者用插件目录里的（不需要先装过）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\rollback.ps1 -Stamp 20261011-052152
```

`-Stamp` 留空 = 自动挑最新的一对备份。加 `-PurgePluginDir` 连插件目录一起删。
备份被删掉时还有兜底路径：只把 `dsh-pipeline` 从 `bundles` 里摘掉、把它那个 `insert` 块删掉，
不还原整份文件（这条路径也在沙箱里验过，验证方式是回滚后与原始 profile 逐字节比对）。

回滚**同样需要重启 DSH**。

---

## 右上角那个开关（UI）

DSH 窗口右上角头部那一排里会出现一个**「多AI 协调」**按钮，带一个状态点：

```
┌────────────────────────────────────────────────┐
│  ⋯ 菜单        ● 多AI 协调  开   ⇥ 右侧栏切换  │   ← 会话头部右侧
└────────────────────────────────────────────────┘
```

点一下即切，**立即生效，不需要重启**。

### 「多AI协调团队」面板（开关右边）

同一个标题栏槽位里，开关右边还有一个**「多AI协调团队 N」**按钮。**悬停 140ms 展开、移开 800ms 后收起；点一下按钮可钉住（钉住后怎么移都不收，点外部/ESC 才收）**。点开是**面板**（快照只读；操作走写接口）：

- **任务**：每张流水线单一卡（最左侧 **L0–L5 等级徽标** + 团队 AI 人数、`[pipeline] T-…` + 中文状态徽标 + 需求摘要前 80 字）；
- **席位**：该单的每个席位一行，用**中文易懂名**（`主对话` / `主管` / `需求分析` / `计划` / `编写 · 1号席` / `测试` / `审核` …）+ 状态；
- **当前对话高亮**：主对话那张卡带一圈高亮 + 「当前对话」标签；
- **点名字打开对话**：点席位卡直接跳到该席位会话（team 通道的队员按具名 teammate 的 `continuable` 子会话打开）；
- **操作**：卡片右上角「⋯」菜单按状态列出「终止 / 恢复 / 归档 / 删单」（删单要连点两次确认；写操作走 `POST /.dsh-pipeline/panel/action`，开关关着时直接拒）；
- **置顶**：每张卡可「置顶 / 取消置顶」，置顶任务排最前（📌 标记）；
- **批量**：头部「批量」→ 圆勾多选卡（选中整卡高亮）→ 底部批量栏「归档所选 / 删除所选」，串行执行并显示进度；
- **归档视图**：头部「归档 N」查看已归档单，可在卡片「⋯」里「恢复」或「永久删除」（后者两击确认），「← 返回任务」切回；
- **会话预览**：鼠标停在席位 chip 上 → 在面板**左侧**弹出约 520×520 的「会话预览」大窗（用户靠右、AI 靠左的聊天气泡，可滚轮翻最近 12 条）；只显示**真实用户/AI 对话**（过滤注入的系统上下文、不显示工具行），AI 回答为空时显示「正在思考…」；**点任意气泡直接打开该会话**；
- 数据来自 `GET /.dsh-pipeline/panel`（**快照只读**、5 秒轮询、页面隐藏时跳过）：只读 `<项目根>/.pipeline/*/task.json` 的**非敏感字段**（任务 id / 状态 / 需求摘要 / 席位 / 待办计数 / 任务板编号），**不含**交接物正文、补丁、代码；
- `uiWorkspace` 服务拿不到时，面板只显示一行「打不开会话：…」的人话错误，**不影响**开关与其它功能。

**客户端半边 = 入口 375 行 + 18 个 chunk。** 入口 `lib/client.js` **375 行**，面板实现拆在
`lib/client.panel-<职责>.js` 共 **18 个**；入口 + chunk 共 **19 个文件、合计 4743 行**。
文件大小是**信号不是死限**：超过 400 行先按 `CONVENTIONS §4` 的四问自检（单一改动原因 /
能否一句话命名 / 评审能否看出边界 / 并行改动是否撞车），拆不拆由人和评审判断；体检报告见
`tests/file-size-check.mjs`。宿主按 `/plugins/dsh-pipeline/client.js?rev=…`
把入口当**经典脚本**加载，入口自己 `window.__ModuleLoader__.load({ id, factory })` 注册；面板
**第一次被渲染**时才用 `Promise.all` 逐个 `require.async('./client.<name>.js')` 把 18 个 chunk 取回来，
交给 `shell` 按依赖序 `create(deps)` 组装（没打开过面板就不下载）。chunk 由宿主按
`/plugins/dsh-pipeline/<chunk>?rev=<入口 rev>` 提供并 **immutable 缓存**，必须与入口同目录、也是经典
脚本、彼此**不能**同步 `require` —— 所以组合只在入口做。手工 JS 直接放同级文件即可，**不需要 tsdown**；
新增客户端逻辑一律新开 chunk，理由与约束见 `CONVENTIONS.md` §4，设计取舍见
[`design/panel/01-面板设计.md`](design/panel/01-面板设计.md)。

| chunk | 行数 | 职责 |
|---|---|---|
| `client.panel-view.js` | 388 | 纯渲染：任务卡 / 归档卡 / 列表 / `[pipeline]` 标签，不取数、不持状态 |
| `client.panel-menu.js` | 335 | ⋯ 菜单：触发器、菜单项、两击确认文案、卡片内下拉、置顶按钮 |
| `client.panel-shell.js` | 320 | 组件骨架：共享作用域 `S`、按依赖序调 chunk 的 `create` / `setup`、把骨架串起来 |
| `client.panel-actions.js` | 297 | 动作契约：三条路由、动作表与文案、两击确认判据、取数 / 提交写操作 |
| `client.panel-preview.js` | 296 | 预览底料：尺寸 / 时机 / 过滤常量、`uiWorkspace` 与 `sessions` 服务、事件窗口 → 预览行 |
| `client.panel-atoms.js` | 294 | 内容原子：状态 / 档位色板、等级徽标、团队人数、状态徽标、id、摘要、可选卡身 |
| `client.panel-preview-control.js` | 281 | 预览状态机：悬停计时、30 秒缓存、在途序号防串台、点气泡开真实会话、卸载 / 切换时收层 |
| `client.panel-portal.js` | 249 | 弹层容器与出口：`createPortal` → `document.body`、fixed 落点计算、滚动 / 改尺寸重算 |
| `client.panel-batch.js` | 240 | 批量状态机：进 / 出批量、整卡选中、两击删除、串行执行与进度、归档视图切换 |
| `client.panel-interact.js` | 223 | 交互 glue：开关 / 钉住与悬停慢关、卡片菜单、动作 UI、批量与预览状态槽、打开席位会话 |
| `client.panel-batch-bar.js` | 206 | 底部批量栏：sticky 通栏、按视图给按钮、进度与两击确认 |
| `client.panel-preview-bubble.js` | 201 | 预览浮层：定高圆角窗、标题行、最多 12 条气泡（用户靠右 / AI 靠左、空正文「正在思考…」） |
| `client.panel-seats.js` | 198 | 席位格：角色中文名、席位号、状态圆点、chip 渲染与可点 / tooltip 判据 |
| `client.panel-outside.js` | 196 | 点外面 / ESC 判据：`ref.contains` + `target.closest` 复核、document 捕获监听、挂摘 effect |
| `client.panel-preview-data.js` | 180 | 预览取数与几何：`retain` 会话引用读事件窗口、贴着面板左边缘算浮层落点 |
| `client.panel-poll.js` | 168 | 轮询 / 取数：5 秒轮询任务快照与归档列表、页面隐藏时跳过、失败保留上次数据 |
| `client.panel-card-actions.js` | 167 | 卡片动作执行：⋯ 菜单开合、删单 / 永久删除两击确认、置顶、动作后刷新哪份数据 |
| `client.panel-controls.js` | 129 | 可点小控件：头部按钮、批量圆勾、置顶标记，全部自带 no-drag 与宿主事件截断 |

**弹层为什么经 portal 挂到 `document.body`**：宿主会话头部是窗口拖拽区，又自带层叠顺序与命中区 ——
弹层（⋯ 菜单 / 预览浮层）只要还长在它的 DOM 里，点击就可能被吞掉。所以用
`ReactDOM.createPortal(children, document.body)` + `position:fixed` 渲染：落点按触发按钮的
`getBoundingClientRect()` 算（右缘对齐 `right = 视口宽 − rect.right`、`top = rect.bottom + 6`、
`min(440, 92vw)` × `min(560, 70vh)`、四周至少留 8px），滚动 / 改尺寸后 100ms 节流重算；点外面用
`target.closest('[data-pipeline-panel]')` 复核，判不出来就不关（宁可漏关一次，不误关正在用的面板）。
取不到 `react-dom` 时回退成原样渲染，不把面板弄挂。

| 状态 | 编排（角色清单/顺序） | 守门（越权拦截） | 流水线写操作 | 查询/自检 |
|---|---|---|---|---|
| **开**（绿点） | 生效 | 生效 | 正常 | 正常 |
| **关**（灰点） | 不介入 | **完全弃权** | **被拒**（附恢复指引） | 正常 |
| 未知（黄点） | —— | 按上一次已知状态 | —— | —— |

「未知」只在**读不到宿主状态**时出现（例如端点没挂上）。这时既不说开也不说关 ——
说错比不说更糟。

### 挂在哪：`conversation.session.header.utilities`

这是**会话头部那一排的右侧区域**，紧挨着最右边的 `…header.corner`
（右侧栏切换按钮就在 corner 里）。选它的三条依据都来自源码：

1. 它是 **list 槽**（`dsh-client-ui-conversation/lib/client.js:18272-18275`
   `"conversation.session.header.utilities": { kind: "list", scope: "session" }`）——
   多个条目共存，注册时给 `id` + `order` 即可，不会顶掉别人。
   已装的 `dsh-client-ui-open-in-app` 就住在这儿（`id: "open-in-app", order: -10`）。
2. 它的渲染**不受 `hideChrome` 影响**（`…/client.js:16463` 的 `!hideChrome &&` 只圈住了
   面包屑与 `headerActions`；utilities 在 `16404-16406` 是平级）⇒ 空会话时也看得见。
3. 它就在 `conversation.session.header.corner` **左边一格** —— 与用户指的位置同一带。

### ⚠️ 这里**没有**"窗口级顶栏"槽位（如实说明）

全树扫了 177 个客户端 bundle，`shell.*` 只有两个：

| 槽位 | 能用吗 | 证据 |
|---|---|---|
| `shell.overlay` | 能挂，但它是**整框覆盖层**，没有定位意见；拿它做"右上角按钮"要靠绝对定位，还可能压住弹层 | `dsh-client-ui-layout/lib/client.js:312`、`:343-347` |
| `shell.leading` | **Windows 上根本不存在** | `…/client.js:313-314` `const leadingMounted = darwin && sidebarCollapsed;`，`:348-352` 只在 mounted 时渲染 |

所以**没有**"窗口头部 / 顶栏"这一类槽位。本插件挂的是**最接近它的那个**：
会话头部右侧（`utilities`），也就是用户红框那一排的右侧区域。
它挂在**中列**的顶部；当右侧栏收起时，视觉上就是窗口右上角。

**没有硬塞**，也没有假装挂在窗口级槽位上。

### 关掉之后谁受影响

| 主体 | 影响 |
|---|---|
| 守门（`ctx.tools.guard`） | **弃权**：对任何调用都返回 `undefined`。注意 `undefined` 是**弃权**不是"允许" —— `dsh-archigate` 等其它插件的守卫**照样能拒**（自测 G3 验过这条） |
| 全部 `pipeline_*` 工具 | **注册结构不变**（工具照旧在列表里），但写操作会返回明确拒绝；只读（`pipeline_status` / `pipeline_selftest` / `pipeline_switch` 等）照常 |
| 已有任务的落盘数据 | **完全不受影响**（`.pipeline/` 下的 task.json / handoffs / audit.jsonl 一个字节不动） |
| 其它插件 | **不受影响**（本插件从不注销、不改别人的任何东西） |
| 正在跑的会话 | 立即生效；不需要刷新页面、不需要重启 DSH |

**为什么不注销守卫和工具**：守卫注销再注册会改变它在 `ToolLayer.guards` 里的**顺序**，
而守卫链是"取第一个非 `undefined`"（`dsh-tools/lib/index.js:2646-2651`）——
顺序一变，与 `dsh-archigate` 同时命中时的**拒绝文案**就会跟着变。
那是对用户可见的行为抖动，为一个开关不值得。所以：**结构恒常，行为可变**。

### 状态存在哪 / 重启后还在吗

- 内存里一份（守门**同步**读它 —— `guardReason` 是同步遍历，`dsh-tools:2928`）
- 同时落盘到 `<项目根>/.pipeline/switch.json`（先写 `.tmp` 再 rename）

**重启后保持上次的选择**。落盘失败时内存态仍生效，日志里会写明"重启会丢"。

### 没有 UI 时的入口

`pipeline_switch` 工具，与右上角按钮是**同一个开关位**：

```
pipeline_switch                      → 直接翻转
pipeline_switch { on: true }         → 显式打开
pipeline_switch { on: false, reason: "在做别的事" }
```

headless 形态（拿不到 `ctx.webServer`）下 UI 端点自动跳过，插件照常激活，
开关只能用这个工具翻 —— 装载日志里会明说。

### 这条通道的安全边界

`GET/POST /.dsh-pipeline/state` 只做两件事：读一个布尔、写一个布尔。但：

- **只服务环回地址**（非环回 `remoteAddress` 一律 403）。开关能整体关掉守门，
  那是安全相关的状态位，不该被局域网里的别人翻。
- **没有 CSRF token、没有鉴权挑战**。它依赖"这个端口本来就只绑定环回"这个前提。
  如果你的 profile 把 `webServer` 配成对外监听，请设 `switchRoute: false`。
- 没有做的事不要误以为有：它不校验 `Origin`，也不区分是哪个页面发来的。

---

## 怎么用（一整个任务的生命周期）

下面是一段**能照着做**的完整流程。五种角色各是一个独立对话。

### 第 0 步：主对话开单

主对话只做登记，**不做任何技术分析**：

```
pipeline_task_open
  requirement: "给 fizzbuzz 加一个按步长过滤的查询参数，并补上单元测试。约束：不引入任何第三方依赖。"
  constraints: ["不引入任何第三方依赖"]
  deliverable_format: "补丁 + 变更说明 + 可运行命令"
```

返回 `task_id` 与**主对话自己的令牌** `role_token`。

### 第 1 步：编排判断（不是主对话干的）

主对话**先试一次** `pipeline_orchestrate`——但注意，它不是在"自己判断"，
它是在**调用规则引擎**；引擎要自批 L0 必须先过一组平凡性判据。上面这个需求有约束、命中"引入/接口/测试"信号，引擎判 L1，于是直接拒：

```
拒绝：主对话不能自己产出角色清单。

规则引擎建议档位：L1（普通功能）
  · L0 被否：声明了 1 条约束条件（有约束就不是"极简脚本"）
  命中的不平凡信号：
    - [L1] 涉及外部依赖（匹配「引入」）

规则引擎判的是 L1，不是 L0 —— 这个需求需要**独立的编排判断对话**。
下一步：pipeline_dispatch role=orchestrator，把需求交给它做编排判断。
★ 主对话不自行判断需要几个 AI，只按判断结果去调用和跟踪。
```

主对话于是派出编排角色：

```
pipeline_dispatch { role: "orchestrator" }     → 任务状态：待分配 → 需求分析中
```

编排对话接到派活单，认领身份，然后给出**结构化角色清单**：

```
pipeline_bind_role { role_token: "<派活单里带的令牌>" }

pipeline_orchestrate {
  tier: "L1",
  reason: "涉及接口参数与单元测试、且声明了'不引入第三方依赖'这条约束；有明确功能边界但不止一处改动。
           不需要架构决策（改动局限在单文件函数内），也没有鉴权/安全面，故 L1（5 个对话）足够，不上 L2。",
  acceptance: ["带 step 参数的查询按步长过滤", "step 缺省或非法时返回全部而非报错"],
  test_points: ["step=2 过滤正确", "step=0/负数/非数字的兜底"],
  boundaries: ["只改 fizzbuzz 一个文件", "不新增运行期依赖"]
}
```

得到：

```
角色清单已产出（judged_by=orchestrator）。
档位：L1（普通功能） —— 有明确功能边界，但涉及多文件、外部依赖、配置、接口变更中的任意一项。
需要几个独立对话：5 个
  对话：主对话 / 需求分析·编排判断 / 编写 / 测试 / 审核
  执行角色：writer / tester / reviewer
调用顺序：orchestrator → writer → tester → reviewer
判断理由：...
```

**主对话这时才第一次知道"要调用几个 AI"。** 它不能改这份清单。

### 第 2~3 步：派活 → 编写交测试

主对话按清单逐个派：

```
pipeline_dispatch { role: "writer" }   → 任务状态：待开发 → 开发中
```

编写会话拿到自己的令牌（**只有 writer 一个角色**），然后：

```
pipeline_artifact { content: "<补丁或代码>", file_name: "fizzbuzz.js" }   → 制品 v1

pipeline_handoff {
  kind: "dev_to_test",
  payload: {
    artifact_version: "v1",
    patch_or_code: "diff --git ...",
    change_note: "新增 step 参数...",
    run_commands: ["node --test tests/"],
    selftest_result: "本地 5/5 通过",
    known_issues: [],                  ← 必须显式回答"有没有已知问题"
    acceptance_map: { "带 step 参数的查询按步长过滤": "src/fizzbuzz.js:fizzbuzz" }
  }
}                                        → 任务状态：开发中 → 待测试
```

> 编写**没有** `review_verdict` 的产出权。它想跳过测试直接找审核，会在守门层就被拦：
> 见 [`examples/example-refusal.txt`](examples/example-refusal.txt) 的反例 ①。

### 第 4~5 步：派测试 → 测试交审核

```
pipeline_dispatch { role: "tester" }   → 任务状态：待测试 → 测试中

pipeline_handoff {
  kind: "test_to_review",
  payload: {
    artifact_version: "v1",
    test_cases: ["n=0 → []", "n=1 → [\"1\"]", "step=2 过滤正确", ...],
    execution_result: "5/5 通过",
    failure_logs: [],
    pass_evidence: ["node --test：5 pass / 0 fail", "边界 n=0、n=1 均覆盖"],
    risk_notes: ["未做超大 n 的性能验证"],
    verdict: "pass"                        ← verdict=fail 的交接物根本提交不了，要用 pipeline_rework
  }
}                                          → 任务状态：测试中 → 待审核
```

测试**不能替编写改代码**：它写项目源码会被守门按路径拦下（反例 ③），
它只能 `pipeline_rework { target: "writer", reason: "..." }` 把问题打回去。

### 第 6~7 步：派审核 → 审核发 OK

```
pipeline_dispatch { role: "reviewer" }  → 任务状态：待审核 → 审核中

pipeline_handoff {
  kind: "review_verdict",
  payload: {
    artifact_version: "v1",
    conclusion: "OK",
    risk_notes: ["未做超大 n 的性能验证（不影响本任务验收标准）"],
    release_approved: true,
    final_delivery_note: "交付 src/fizzbuzz.js 的 fizzbuzz(n)，制品 v1，测试 5/5 通过，无第三方依赖。",
    acceptance_check: { "带 step 参数的查询按步长过滤": "pass" }
  }
}                                          → 任务状态：审核中 → 已通过
```

不通过就 `pipeline_rework { target: "writer" | "tester", reason: "..." }`。

### 第 8 步：主对话关单

```
pipeline_close { note: "审核 OK，放行" }   → 任务状态：已通过 → 已关闭
```

**没有有效的审核 OK，这一步会被拒**，并且会告诉你判据是什么（反例 ②）：

```
拒绝关单：任务 T-... 不存在有效的审核 OK。
判据：需要一份 review_verdict，conclusion=OK，且 artifact_version 等于当前有效制品版本（v1），
     且在最近一次打回之后。
主对话不能凭"看起来做完了"关单 —— 必须先走完 测试→审核，由审核角色发 OK。
```

> 「有效」的含义很关键：**打回会作废上一轮的 OK**。
> 编写改完代码拿旧 OK 来关单，会被 `artifact_version` 一致性判据拦下。

### 随时可查

```
pipeline_status { task_id: "T-..." }                    → 脱敏摘要（主对话视图）
pipeline_status { task_id: "T-...", include_audit: true } → 附完整审计流水
pipeline_status                                          → 列出全部任务
```

---

## 角色

| 角色 id | 中文 | 类型 | 能写哪（**守门按路径判，不按这张表判**） | 能产出哪些交接物 | 能否打回 |
|---|---|---|---|---|---|
| `main` | 主对话 | 控制 | ★ **真只读**（一字节都不许写，连 reports/ 也不给） | （无） | 否 |
| `orchestrator` | 需求分析 | 控制 | ★ **真只读** | `requirement_analysis` / **`clarification_reply`**（裁定）/ `human_request`（升级） | 否 |
| `planner` | 计划·分配 | 控制 | ★ **真只读** | `plan` / `orchestration` / `clarification_reply` | 否 |
| `architect` | 架构/技术方案 | 咨询 | 只写 `reports/architect/` | `design` | 否 |
| `security` | 安全/合规审计 | 咨询 | 只写 `reports/security/` | `security_review` | **能** |
| `writer` | 编写 | 执行 | 项目源码（受 `scope_paths` + `change_scope` **双重**约束） | `dev_to_test` / `seat_handover` | 否 |
| `tester` | 测试 | 执行 | ★ 只写 `reports/tester/`（源码**只读**） | `test_to_review` / `test_to_dev` | **能** |
| `reviewer` | 审核 | 执行 | ★ 只写 `reports/reviewer/reviewer.log`（**只有日志**） | `review_verdict` / `human_request` | **能** |
| `archivist` | **留档** | 执行 | 只写 `reports/archivist/`；**`requirement.md` 只有它能写** | `compilation` / `clarification_request` | **能** |
| `diagrammer` | **架构图** | 执行 | 只写 `reports/diagrammer/` | `architecture_diagram` / `human_request` | 否 |
| `release` | 发布/运维 | 执行 | 只写 `reports/release/` | `release_plan` | 能 |
| `docs` | 文档 | 咨询 | 只写 `reports/docs/` | `docs_note` | 否 |
| `performance` | 性能/压测 | 咨询 | 只写 `reports/performance/` | `perf_report` | 能 |
| `arbiter` | 仲裁/争议解决 | 咨询 | 只写 `reports/arbiter/` | `arbitration` | 否 |
| `human` | 人工 | 控制 | 项目源码（人工兜底） | `human_note` | 能 |

> ★ 这张表的"能写哪"一列**不是判据**，它只是把判据写清楚；真正的判据在
> `lib/guard.js` 的 `writeClassOf()` / `checkOwnPath()`。
> 两边是否一致由 `pipeline_boundaries` 的 **`unmapped` 漂移检查**兜着（自测里也断言了）。

**三权分立的不变量**（编码在 `lib/roles.js` 的数据里，不是散文）：

1. `writer` 的 `handoffKinds` 里**没有** `review_verdict`
2. `tester` / `reviewer` 的 `writes` 是 `reports`，不是 `workdir`
3. `main` 的 `handoffKinds` 是**空数组**——它不产出任何技术交接物
4. `SEPARATION_ROLES = [writer, tester, reviewer]`，任何档位的角色清单都必须同时包含这三个，
   申请移除会被直接拒（`buildRoster` 里的硬检查）
5. `architect`（编写前的顾问，出 `design`）与 `diagrammer`（编写后的产出者，出 `architecture_diagram`）
   **是两个角色**，方向、时机、产物都不同 —— 见「架构图角色」一节

---

## 分档与编排判断（L0~L5）

| 档位 | 名称 | 执行角色 | 编排对话 | 独立对话总数 | **最大编写席位** | 触发条件 |
|---|---|---|---|---|---|---|
| **L0** | 极简脚本 | writer / tester / reviewer | 规则引擎 | **4** | **1** | 单文件、无外部依赖、无安全面、无持久化、无并发 |
| **L1** | 普通功能 | writer / tester / reviewer | 独立 | **5** | **1** | 有明确功能边界，但涉及多文件/外部依赖/配置/接口变更任一 |
| **L2** | 中大型 | + architect **+ diagrammer** | 独立 | **7** | **3** | 跨模块、需架构决策、接口契约要冻结、迁移或兼容性 |
| **L3** | 安全敏感 | + security **+ diagrammer** | 独立 | **8** | **3** | 碰鉴权/凭证/权限/加密/外部输入边界/合规 |
| **L4** | 生产上线 | + release **+ diagrammer** | 独立 | **9** | **3** | 要真的动生产环境 |
| **L5** | 特殊要求 | 按需从扩展池挑 **+ diagrammer** | 独立 | **11** | **3** | 对外交付/文档与性能硬指标/需要仲裁 |

> **注意**：这里的"独立对话总数"是**按 count=1 算的下限**。
> 编排拆成 2~3 个编写席位时，实际会话数会相应增加（L2 三席位就是 7 + 2 = 9 个会话）。
> 架构图角色（`diagrammer`）**L2 起默认纳入** —— 见「架构图角色」一节。

### 规则引擎怎么判（`lib/tiers.js`）

13 组「不平凡信号」，命中任意一组就**不许自批 L0**：

```
[L3] 鉴权/凭证/权限面     [L3] 安全/合规         [L4] 生产上线/发布
[L2] 迁移/兼容性          [L2] 架构决策          [L2] 并发/事务
[L2] 持久化/外部存储      [L2] 性能指标          [L1] 接口/网络边界
[L1] 外部依赖             [L1] 多文件/系统级     [L1] 配置/环境
[L1] 对外文档
```

外加三条硬闸：需求文本 ≤ 240 字符、验收标准 ≤ 4 条、**不能声明任何约束条件**。

取「最严的那一条信号」所对应的档位；一个信号都没命中但 L0 又被否时，落到配置的兜底档
（默认 `L1`，**宁高不低**）。

实测（`tests/selftest-core.mjs` 的「分档」组，5/5 通过）：

| 需求 | 判出 | 对话数 |
|---|---|---|
| 写一个函数 fizzbuzz(n)，返回 1 到 n 的 FizzBuzz 字符串数组。 | L0 | 4 |
| 给订单**接口**加一个按状态过滤的查询参数，并补上单元测试。 | L1 | 5 |
| **重构**订单模块，把支付逻辑拆成独立服务，同时做数据库**迁移**。 | L2 | 6 |
| 实现基于 **JWT** 的**鉴权**中间件，校验 token 并做**权限**控制。 | L3 | 7 |
| 把新版服务**发布到生产环境**，**灰度** 10% 流量，准备好**回滚**方案。 | L4 | 8 |

### 增减角色必须走的路

```
执行角色 pipeline_roster_request { add: ["security"], reason: "..." }
        ↓
编排角色 pipeline_roster_review { approve: true, note: "..." }
        ↓  （批准动作本身改写角色清单，主对话没有别的路径能改）
主对话按新清单 pipeline_dispatch
```

- 主对话调 `pipeline_roster_review` → 守门拒（反例 ④）
- 主对话 `pipeline_dispatch` 一个清单外的角色 → 拒，并提示走上面那条路
- 申请移除 writer/tester/reviewer → 直接拒（三权分立不可拆）
- 每一条申请与复核意见都写进 `roster.reason` 与 `audit.jsonl`，**可追溯**

---

## 状态机

```
                    ┌──────────────┐
                    │ 待分配 pending│
                    └──────┬───────┘
        dispatch_orchestrator│         │orchestrated（L0：规则引擎自批）
                    ┌───────▼────────┐ │
                    │需求分析中 analyzing│ │
                    └───────┬────────┘ │
                            │orchestrated│
                    ┌───────▼────────▼──┐
                    │   待开发 ready_dev │
                    └───────┬───────────┘
                            │dispatch_writer
                    ┌───────▼───────────┐
              ┌─────┤  开发中 developing ├─────┐
              │     └───────┬───────────┘     │
              │             │dev_submitted    │（没有直达 ready_review 的边）
              │     ┌───────▼───────────┐     │
              │     │  待测试 ready_test │     │
              │     └───────┬───────────┘     │
              │             │dispatch_tester  │
              │     ┌───────▼───────────┐     │
              │     │  测试中 testing    │     │
              │     └───┬───────────┬───┘     │
   test_failed│         │test_passed│         │
              │ ┌───────▼──────┐    │         │
              │ │待审核 ready_review│◄───┐    │
              │ └───────┬──────┘    │    │    │
              │         │dispatch_reviewer  │ │
              │ ┌───────▼──────┐    │    │    │
              │ │ 审核中 reviewing│   │    │    │
              │ └──┬──────┬───┘    │    │    │
   review_ng_dev│  │      │review_ng_test  │ │
              └───┼──┐   └────────┼────┘    │
                  │  │            │         │
        ┌─────────▼──┴──┐  ┌──────▼────────┐ │
        │ 已打回编写      │  │ 已打回测试     │ │
        │returned_to_dev │  │returned_to_test│ │
        └────────┬───────┘  └──────┬────────┘ │
                 │dispatch_writer  │dispatch_tester
                 └────────┬────────┘
                          │review_ok（只有审核能触发，且必须 conclusion=OK）
                  ┌───────▼───────┐
                  │ 已通过 passed  │
                  └───────┬───────┘
                          │close（只有主对话能触发，且必须已有有效 OK）
                  ┌───────▼───────┐
                  │ 已关闭 closed  │
                  └───────────────┘

★ 两级升级梯：任意非终态 ──clarification_request(blocking)──► 等待需求分析答复 awaiting_clarification
                    ──clarification_reply──► 回到被打断前的状态（answered：原角色继续）
                    答不了时 ──human_request(blocking, 带 escalated_from)──► 等待人工答复 awaiting_human
                    ──human_reply──► 回到被打断前的状态（**仍然是最初那个工作状态**，不是 awaiting_clarification）
★ 人工介入（单级，L0 用）：任意非终态 ──human_request(blocking)──► 等待人工答复 awaiting_human ──human_reply──► 回到被打断前的状态
异常出口（任意非终态）：block → 已阻塞 blocked → unblock → 回到阻塞前的状态
                       cancel → 已取消 cancelled
```

**三条写死的不变量**（`lib/states.js`）：

1. `developing` 只能走到 `ready_test` —— 表里**没有** `→ ready_review` 的边
2. `passed` 只能由 `reviewing` + 审核 OK 到达
3. `closed` 只能由 `passed` 到达

终态（`closed` / `cancelled`）不再接受任何转移。

---

## 人工介入（两级升级梯）

### 拓扑：用户只与主对话相连，所以人工介入是**两级**的

> **用户的对话框只在主对话里。**

意思是：`writer` / `tester` / `reviewer` / `security` / `architect` / `performance` / `arbiter` / `diagrammer`
这些角色**根本没有对用户说话的通道**。但它们也不该一遇到问题就去打扰用户 —— 大多数"确定不了的事"
其实在**需求层**就能定下来。

所以是**两级**：

```
   编写 / 测试 / 审核 / 安全 / 架构 / 性能 / 发布 / 文档 / 仲裁 / 架构图
                          │
                          │ ① clarification_request（提问）
                          ▼
              需求分析 / 编排判断  orchestrator
                          │
        ┌─────────────────┴─────────────────┐
        │ ②-a 能确认                          │ ②-b 确认不了
        │                                    │
        ▼                                    ▼
   直接裁定（answered）              ③ 升级：human_request
   带 answer + reason                带 escalated_from / raised_by
        │                                    │        / orchestrator_reason
        │                                    ▼
        │                             主对话 ──④ 转告──► 用户
        │                                    │              │
        │                                    │◄──⑤ 答复 ────┘
        │                                    │
        └────────────┬───────────────────────┘
                     ▼
        ⑥ 恢复：回到**被打断前的那个状态**，原角色原地继续
```

**②-a 是常态，②-b 是例外。** 大部分问题根本不该走到用户面前 —— 这正是加这一级的理由。

### 什么时候该答、什么时候该升级

| 需求分析**该自己答**的（需求层） | 需求分析**该升级**的 |
|---|---|
| 验收标准的解释、边界条件的取舍 | 需要用户拍板（审批、放行、破坏性操作） |
| 优先级、范围取舍（在**原任务卡范围内**） | **涉及新需求** —— 超出原任务卡 |
| 测试要点、验收怎么算通过 | 需求层内部冲突无法自解 |
| 两条验收标准冲突时取哪条 | 缺环境 / 缺权限 / 缺凭证 |
| 术语口径的统一 | 安全否决（要不要接受风险） |

**边界写死在代码里的是"升级那一侧"**：`verdict=cannot_answer` 时必须给 `reason`，
而拒绝文案里直接列出了合法与非法理由：

```
verdict=cannot_answer 时必须给 reason（为什么需求分析答不了）。
★ 这条是"防踢皮球"的第一道：说不出为什么答不了，就不许往上推。
合法的理由类型：需要用户拍板 / 涉及新需求（超出原任务卡范围）/ 需求层内部冲突无法自解 / 缺环境或权限。
非法的理由：这个我不太懂 / 让用户决定吧 / 实现细节我不管（那些属于本可以在需求层裁定的事）。
```

反过来（"能答的却推给用户"）有**两道机械闸**，见下面的反例③。
另外，需求分析如果答得越界（去裁"用哪个库""怎么写"这类实现层的事），
本插件**不阻断**但会在审计里记一条 `boundary_warning` —— 那是有灰色地带的地方，标出来比硬拦更合适。

### 第一级的两个交接物

**`clarification_request`**（执行/顾问角色 → `orchestrator`）：

| 字段 | 说明 |
|---|---|
| `task_id` / `from_role` | 必填，`from_role` 必须与调用方一致 |
| `stage` | 卡在哪一步（例如"测试：边界值判定"） |
| `question` | 必须是**清晰可答的问句**（没有问号会被拒） |
| **`context_digest`** | ★ **脱敏摘要**，**不许含代码正文** |
| `options[]` | 可选方案 + 后果（`{label, consequence}`） |
| `blocking` / `urgency` / `deadline` | 阻塞、紧急度、期望答复时间 |

`context_digest` 强制脱敏的理由：**需求分析是"不读代码也能判断"的那一级**。
摘要里塞了代码，要么它读不懂，要么它被迫去读代码 —— 两条路都违背这一级存在的意义。
而且升级到用户时这份摘要会被复用，含代码就转告不了。

**`clarification_reply`**（`orchestrator` → 发起角色）：

| 字段 | 说明 |
|---|---|
| `answer_to` | 回给哪条请求 |
| `verdict` | `answered` / `cannot_answer` |
| `answer` | 结论（`answered` 时必填，`cannot_answer` 时**不许有**） |
| **`reason`** | ★ **必填**：为什么这么答 / 为什么答不了 |
| `constraints_added[]` | 因这次裁定而新增/收紧的约束 |
| `escalate` | `cannot_answer` 时必须为 `true` |

`cannot_answer` 时 `escalate` 必须为 true 的理由：
"答不了"的唯一合法去处就是升级给用户。答不了又不升级 = 发起角色永远卡在等待里。

### 状态机：**分开**，不复用

新增状态 **`awaiting_clarification`（等待需求分析答复）**，与 `awaiting_human`（等待人工答复）**并存**。

| | `awaiting_clarification` | `awaiting_human` |
|---|---|---|
| 在等谁 | **内部**某一级（需求分析） | **用户** |
| 主对话要不要动 | **不用** —— 用户不该被打扰 | 要转告、要催 |
| 谁来解 | `orchestrator` | `main` 记用户答复 |

**为什么分开**：合成一个之后，"这个任务到底在等谁"就答不出来了 ——
而那正是主对话最需要知道的事（它要不要去惊动用户？还是根本不用？）。
`pipeline_status` 里现在有一个 `waiting` 字段直接回答这个问题：

```json
"waiting": { "waiting_for": "orchestrator", "waiting_zh": "等需求分析裁定（还不用惊动用户）", "will_resume_to": "testing" }
```

**恢复到哪**：两条边都是 `to: '(previous)'` —— **回到被打断前的那个状态**（沿用既有语义）。

★ 这里有个**必须处理好的坑**（第二轮的 `awaiting_human` 踩过一次，这次一开始就绕开了）：

`待测试 → 等需求分析 → 等用户` 这条链里，如果每跳都记 `previous_state`，
它会被写成 `awaiting_clarification`，用户答复完就"恢复"到"等需求分析" —— **永久卡死**。

现在有一条通用规则兜着：

```js
// transition() 里
if (!WAITING_STATES.includes(from)) task.previous_state = from
```

**等待态不是"被打断的工作"，它只是路上的一站。** 规则是通用的，
将来再加任何等待态都自动受益。自测正例②专门验了这条：

```
state=awaiting_human
previous_state=testing  （应为 testing，**不是** awaiting_clarification）
human_requests[0].state_at_request=testing
```

### 防踢皮球：**单向门** + **同一问题问不过两次**

两个机制，第一个是主的：

**① 单向门（结构性规则）**：一旦升级，那条澄清请求**不能再被需求分析改口裁定**。

```
澄清请求 CQ-… 已经**升级**给人工了（2026-…），不能再由需求分析裁定。
★ 这是刻意设计的**单向门**：一旦升级，就只剩用户答复这一条出路 ——
否则"先升级、再自己改口"会变成绕开用户的旁路，用户那边的待办也永远清不掉。
```

**② 同一问题最多问 2 次**（`maxClarifyRounds`，默认 2）：允许"答了还是不明白再确认一次"，
第三次开始拒：

```
防踢皮球：同一个问题已经问过 2 次（上限 2 次）。
问题：参数为 0 时应当报错还是返回空结果？…
上一次：CQ-…，状态 answered（verdict=answered）
★ 反复问同一件事说明它不是"需求层能定的" —— 那就该走升级路径，而不是在原地打转。
```

去重键是 `hash(task_id | from_role | 归一化(stage) | 归一化(question))` ——
**换个问法就是新问题**（自测里有对照用例：问"负数呢"仍然放行）。
闸不是按角色封的，是按问题封的。

**取舍**：单靠"限次数"只能拖住打转，挡不住"先升级再自己改口"那条旁路；
单靠"单向门"又挡不住"反复问、每次都不升级"的软钉子。两个一起才闭环。

### 守门：谁能走哪条路

| 场景 | 结果 |
|---|---|
| 有独立编排对话（L2+），执行角色直接发 `human_request` | ✗ **拒**，指路去 `pipeline_clarify_request` |
| **L0**（编排由规则引擎承担，没有独立编排对话） | ✓ **放行** —— 这是唯一合法路径 |
| `orchestrator` 升级（带 `escalated_from` + `raised_by` + `orchestrator_reason`） | ✓ 放行 |
| `orchestrator` 发 `human_request` 但 `reason_kind=requirement_ambiguous` | ✓ 放行（需求本身有歧义是它的份内事） |
| `orchestrator` 发 `human_request` 既没来源也不是需求歧义 | ✗ 拒（`ESCALATION_NEEDS_SOURCE`） |
| `escalated_from` 指向不存在的请求 | ✗ 拒（`ESCALATION_SOURCE_NOT_FOUND`） |
| 升级一条**自己答过**的请求 | ✗ 拒（`ESCALATION_SOURCE_NOT_DECLINED`） |
| 升级但 `raised_by` 与上游发起角色不符 | ✗ 拒（`ESCALATION_RAISED_BY_MISMATCH`） |
| 升级但没有 `orchestrator_reason` | ✗ 拒（`ESCALATION_NEEDS_REASON`） |

### ★ L0 例外怎么判

**判据不是硬编码档位，而是读 roster 里已有的字段**：

```js
const mode = task.roster?.orchestrator_mode  // 'separate' | 'rule-engine'
```

- `orchestrator_mode === 'separate'` ⇒ 有独立编排对话 ⇒ **必须**先走第一级
- `orchestrator_mode === 'rule-engine'`（L0）⇒ 没有那一级可走 ⇒ **直接发 human_request 是合法的**

这样判的好处：**将来任何一档改成规则引擎编排，例外自动生效**，不需要再改一次守门。
这条在自测反例②里实测过 —— 同一个动作，L2 下被拒、L0 下放行。

### 审计：每一跳都留痕

| 跳 | `action` | 关键字段 |
|---|---|---|
| ① 角色提问 | `clarify:request` | `request_id` / `from_role` / `stage` / `question_key` / `round` / `state_at_request` |
| ② 需求分析裁定 | `clarify:reply` | `verdict` / `answer` / **`reason`** / `constraints_added` / `boundary_warning` |
| ③ 升级 | `clarify:escalate` | `escalated_to` / **`raised_by`** / **`orchestrator_reason`** |
| ④ 主对话转告 | `human:relay` | `relayed_at` / `relay_channel` / `to_user` |
| ⑤ 用户答复 | `human:reply` | **`user_quote`** / `attribution` / `decision` |
| ⑥ 恢复 | `human:resume` / `clarify:resume` | **`based_on`** / `from` → `to` |

"这事是谁问的、需求分析怎么处理的、最后谁拍板" —— 一眼可读：

```
clarify:request → clarify:reply → clarify:escalate → human:relay → human:reply → human:resume
```

### 四个工具

| 工具 | 谁能调 | 干什么 |
|---|---|---|
| `pipeline_clarify_request` | **执行/顾问角色** | ① 向上提问（第一级） |
| `pipeline_clarify_reply` | **只有 orchestrator** | ② 裁定：`answered` / `cannot_answer`。不带 `request_id` = 收件箱 |
| `pipeline_human_request` | 执行角色（**L0 才允许**）/ orchestrator（升级） | ③ 升级或 L0 直发 |
| `pipeline_human_relay` / `pipeline_human_reply` | **只有主对话** | ④⑤⑥ 转告 / 记答复 / 恢复 |
| `pipeline_context_report` | 任何角色 | ★ 上报上下文水位（百分比 + **依据**），附插件侧客观观测；到线时**通知编排 AI**（分配 AI） |
| `pipeline_succession` | **编排 AI**（主对话仅限"编排席位自己"兜底） | ★ 席位继任（**换班**，不是改角色）：分配 AI = 编排 AI，指派权在它手里；编排换人时**广播新联系人**；旧令牌失效 + 旧会话退休 |
| `pipeline_record_submit` | 除留档 AI 外的所有角色 | ★ 把**自己那份**记录提交给留档 AI（带席位令牌，校验来路；只能写自己那份） |
| `pipeline_compile_requirement` | **只有留档 AI** | ★ 汇总各方记录成唯一的需求档；每条必须有来源，有矛盾则拒 |
| `pipeline_contacts` | 任何角色 | ★ 查**当前联系人**（现在谁是指派者、哪个席位已退场） |

`pipeline_handoff { kind: "clarification_request" | "clarification_reply" }` 与上面两个工具是**同一条路径**。

### 兼容：单级路径仍然可用

- **L0 / 没有独立编排对话**：直接 `pipeline_human_request` —— 这是**合法且推荐**的路径
- 老的四步留痕（`human:request` → `human:relay` → `human:reply` → `human:resume`）一字未改
- 第二轮那 44 项人工介入自测**一项没改**，全部照旧通过

### 试一下

```powershell
node tests\ladder-check.mjs       # 39 项：正例①直接裁定 / 正例②升级 / 四类反例
```

完整原始输出在 [`tests/ladder-check-last-run.txt`](tests/ladder-check-last-run.txt)。

---

## 分权落档与「留档 AI」

> ★ 这一节是**更正版**：上一轮"需求分析独占写权"的设计**已作废**。
> 现在是 **分权写 + 专人汇总**。

### 为什么改

> 用户原话：「A，ai 独立落档后设密钥提交给单独的留档 ai（新追加），留档 ai 负责收集后再统一编写到
> `<项目根>/.pipeline/<taskId>/requirement.md` 中」

一个角色独占写权有两个问题：**别的角色有话说却写不进去**（只能靠转述），
以及**那个角色一换人，需求就没人写得动了**。改成各写各的 + 专人汇总，两个问题都没了。

### 约定布局

```
<项目根>/.pipeline/<taskId>/
  records/                     ← ★ 各方**各写各的**（互不覆盖）
    orchestrator.md / .json    ← 编排那份（任务卡：档位 / 角色清单 / 验收标准）
    architect.md / .json
    writer-writer1.md / .json  ← 编写 1 号席位
    writer-writer2.md / .json
    tester.md / .json
    reviewer.md / .json
    …
  requirement.md               ← ★ 留档 AI **汇总出的唯一需求档**（人可读）
  requirement.json             ← 结构化（含 compiled_by / records_used）
  requirement.index.json       ← 版本索引（r1/r2/… + sha256 + supersedes + 差异摘要）
  requirement.rN.md / .rN.json ← 每一版历史（**绝不覆盖**）
```

**路径靠目录约定**，任务卡里**不登记**（沿用上一轮）：谁需要谁自己去读，不需要主对话告诉它。

### ★ 提交必须带密钥：留档 AI 校验来路

`pipeline_record_submit` 会把调用方的**席位令牌**一起递过去。留档 AI 校验三件事：
**任务 ↔ 角色 ↔ 席位**三者一致。任一不符就拒：

```
拒绝收下这份记录：**没有带席位令牌**。
★ 留档 AI 要**校验来路** —— 谁写的、哪个席位、哪一版。拒绝匿名提交。

拒绝收下这份记录：令牌与声明的来路**不符**（冒名）。
  令牌属于：任务 T-… / 角色 writer / 席位 writer#1
  声明的是：任务 T-… / 角色 tester / 席位 (无)
★ 记录的价值全在「这是谁说的」—— 来路不明或冒名的记录，汇总时一文不值。

拒绝收下这份记录：令牌的席位是「writer#1」，声明的是「writer#2」。
★ 只能提交**自己那份**。
```

`records/` 的**文件名也是约定**的：`<role>[-<seat>].md`。守门同时挡两条：
**写别人的记录文件**（伪造来源）与**直接写 `requirement.md`**（跳过汇总）。

### ★ 留档 AI（`archivist`，中文「留档」）

| 项 | 说明 |
|---|---|
| 职责 | **收集**各方记录 → **统一编写**成唯一的 `requirement.md` + 结构化 JSON |
| 工具 | `pipeline_record_submit`（不收 —— 它不给自己提交）/ `pipeline_compile_requirement`（汇总） |
| `requirement.md` | ★ **它是唯一写者**。其他角色**只读**（只往自己的 `records/` 里写） |
| 版本与差异 | `r1/r2/…` + `supersedes` + 差异摘要，历史另存不覆盖 |
| 矛盾 | **不得自己拍板** → 走 `clarification_request` 或升级 |
| 无来源内容 | **不得写入** —— 每条必须 `source_record` 指向一份真实记录 |
| 分档 | **L1+** 纳入；**L0 不纳入**（见下） |

汇总出来的需求档里，**每条内容都带来源**：

```markdown
## 验收标准

1. 导出 CSV 带 BOM（Excel 打开不乱码）
2. 10 万行不 OOM
3. 空表产出只有表头的文件

<sub>来源：RC-5fc9bd6ff1b31ef3（tester，第 1 版，2026-10-10T22:34:55Z）</sub>
```

### 汇总的两条硬规则

**① 不得凭空写入没有记录来源的内容：**

```
拒绝汇总：有 2 条内容**没有可追溯的来源**。
  · entries[0]：没有 source_record
  · entries[1]：source_record=「RC-不存在的记录」找不到对应的记录
★ 留档 AI **不得凭空写入没有记录来源的内容**。
  否则需求档就不再是「大家说的话的汇总」，而是你自己编的东西。
  当前已收下的记录：RC-43f3…、RC-0985…、RC-5fc9…
```

**② 遇到互相矛盾的记录，不得自己拍板：**

```
拒绝汇总：你报告了 1 处**互相矛盾的记录**。
  · 导出格式要不要带 BOM　(RC-0985… vs RC-5fc9…)
★ 留档 AI **不得自己拍板** —— 你的职责是收集与统一编写，不是裁定谁对。
两条出路：
  ① 走 pipeline_clarify_request 问需求分析/编排；
  ② 确实定不了 → 由编排升级给用户（pipeline_human_request）。
（把 conflicts 清空之前，requirement.md 不会被改写。）
```

### 分档：L0 不纳入，L1+ 纳入

| 档位 | 留档 AI | 需求档怎么来 |
|---|---|---|
| **L0** | **不纳入** | 单文件/单函数级改动，需求本就一句话；而且 L0 的编排由**规则引擎**承担，没有独立编排对话来派留档 AI —— 由**规则引擎直接生成**单一需求档更省 |
| L1~L5 | 纳入 | 需求开始有多方视角（架构 / 编写 / 测试 / 安全…），**分权落档才有意义** |

各档对话数：L0=4（主/编写/测试/审核）· L1=6 · L2=8 · L3=9 · L4=10 · L5=12。

### ★ 一个必须说清的顺序（否则会死锁）

"没有留档就不许开工" + "留档 AI 才能写档" = 谁都开不了工。
所以顺序是**约定死的**：

```
① 编排产出任务卡  →  交出的不是 requirement.md，而是**编排自己那份记录**
                      records/orchestrator.md（档位 / 角色 / 验收标准都在里面）
② 主对话派留档 AI  →  留档 AI 读编排那份记录（+ 各方陆续交上来的）
③ 留档 AI 汇总     →  产出 requirement.md（r1）
④ 其余角色才能派活  →  派活时查"需求档在不在 + 版本可不可追溯"
```

⇒ 留档闸**豁免 `orchestrator` 与 `archivist`** 两个角色 —— 它们是产出档的人，卡它们就成死锁。
其余角色一律要档。

---

## 编排自己的继任与「新联系人广播」

### ★ 编排也会到 55%/65%

> 用户原话：「B，编排 AI 在慢上下文时也就新建编排 AI 并通知其他 ai 新交接者」

编排席位到线时：**自己新建一个编排席位**，更新席位清单里编排的指向（`succeeds`），
并交接（同一份 `seat_handover` 契约）。

### ★ 编排的交接物多一项：待处理的请求队列

这是**编排特有**的交接项，别漏 —— 否则新编排根本不知道**谁在等答复**：

```jsonc
{
  "from_seat": "orchestrator",
  "to_seat": "orchestrator",
  "reason": "编排自己到 58%",
  "//……": "其余字段与通用 seat_handover 相同（must_read_files / key_decisions / open_questions / do_not_repeat）",
  "pending_requests": [                                  // ★ 编排专有
    { "from": "writer#1", "about": "导出格式要不要带 BOM？", "waiting_since": "10 分钟前" },
    { "from": "tester",   "about": "测试环境的数据库怎么连？", "waiting_since": "3 分钟前" }
  ]
}
```

缺了它就被拒：

```
编排的交接物缺少 `pending_requests` —— **待处理的请求队列必须显式给**（没有就写空数组）。
★ 这是编排特有的交接项：谁在等你的答复、等到什么程度了。
  不写的话，新编排不知道有人还在等 —— 那些请求会**永远悬着**。
```

### ★ 广播：通知所有已绑定席位「新联系人是谁」

编排换人时，插件**自动广播**给所有已绑定席位：

```
【联系人变更】任务 T-… 的**编排 AI（分配 AI）**已换人。

  旧：fake-agent-002（已退场，令牌已撤销，**不要再发给他**）
  新：fake-agent-011　第 2 代
  依据：水位 58%：编排过程读了 20 个文件、写了很长的清单

★ 后续的**水位上报 / 澄清请求 / 任何需要编排裁决的事**，都发给**新编排**。
  不确定当前联系人是谁 → 调 pipeline_contacts 查一下。
```

### ★ 每个席位都要能查「当前编排是谁」

`pipeline_contacts` 随时可查 —— 不然上报会发给一个**已经退场的席位**，那条消息永远没人看：

```
当前联系人 · 任务 T-…

★ 编排 AI（分配 AI）：fake-agent-011　第 2 代　（orchestrator）

各席位当前占位：
  · architect → fake-agent-003
  · writer / writer#1 → fake-agent-004
  · tester → fake-agent-008

已退场（继任换掉的旧会话）：1 个
  · orchestrator　第 2 代：fake-agent-002 → fake-agent-011　依据：水位 58%：……

★ 行动前先确认联系人 —— 发给已退场的席位等于发进黑洞。
```

**上报时可以指定收件人**（`to_orchestrator_agent`），指定错了就当场拦下：

```
拒绝：你要发给的编排 fake-agent-002 **不是当前联系人**。

  当前：fake-agent-011（第 2 代，自 2026-10-10T22:34:55Z 起）
  你要发的：fake-agent-002

★ 编排自己也会继任 —— 发给一个已经退场的席位，那条消息永远不会有人看。
  先用 pipeline_contacts 查「当前编排是谁」，再发。
```

### ★ 异常路径：编排没产出继任者就撞硬限

**不许静默失联。** 规则：

| 情形 | 谁来做 |
|---|---|
| 正常情况下编排到线 | **编排自己**给自己换班（更正 B） |
| **编排撞到 65% 硬限，且没有产出继任者** | **主对话**按"清单不变"原则触发例外处理；办不成 → **明确升级**（`pipeline_human_request`），说明「编排席位已满、且没有交接物」 |

主对话在这条路径上是**唯一被允许**执行继任的角色，而且范围**死限**在 `role === 'orchestrator'`：

```
拒绝：主对话**不参与继任指派**。
★ 分配 AI 是**编排 AI**（orchestrator），不是主对话 —— 追加/指派继任者本来就是编排的本职。
主对话只负责**更新状态、跟踪、最终关单**。
（唯一的例外：给**编排席位自己**换班 —— 指派者不能是自己，那时主对话按"清单不变"原则兜底。
  本次要换的是「writer」，不在那个例外里。）
```

**为什么不由 `security` / `arbiter` 接手**：那会**改变角色清单**（新增一个"能指派继任"的角色）——
那才是真正的角色变更，得走 `roster_review`。而主对话给编排席位换班**不新增、不删减任何角色**。

### 三个工具

| 工具 | 谁能调 | 干什么 |
|---|---|---|
| `pipeline_record_submit` | 除留档 AI 外的所有角色 | ★ 把**自己那份**记录提交给留档 AI（带令牌，校验来路） |
| `pipeline_compile_requirement` | **只有留档 AI** | ★ 汇总成唯一的 `requirement.md`（每条有来源；有矛盾则拒） |
| `pipeline_contacts` | 任何角色 | ★ 查**当前联系人**（现在谁是指派者、谁已退场） |

### 试一下

```powershell
node tests\records-check.mjs      # 23 项：分权落档 + 留档 AI
node tests\relay-check.mjs        # 54 项：水位 / 继任 / 编排自己继任 + 广播
```

原始输出：[`tests/records-check-last-run.txt`](tests/records-check-last-run.txt) · [`tests/relay-check-last-run.txt`](tests/relay-check-last-run.txt)

---

## 安全确认

> **审核必须确认"网络安全 / 本地泄密是否发生"。**

这一节把上面那句话从"验收标准里的一行字"变成**可执行、可追问依据**的检查项。

### 两条面，各查什么

| 面 | 查什么 |
|---|---|
| **本地泄密**（`local_leak`） | 密钥/凭证模式（私钥头、`sk-`、`AKIA`、`SESSDATA`、cookie、Bearer、JWT、带密码的连接串、疑似 `key=value`）、真实邮箱/手机号；**敏感内容落错地方**（写进了 `audit.jsonl`、收据、报告、日志、制品） |
| **网络**（`network`） | 产物/脚本/依赖里的**外联地址清单**；**未解释的外联**（对不上需求 ⇒ finding）；**凭证出现在出网请求里**（同一行既有 URL 又有凭证 ⇒ 一律 finding） |

### 谁在什么时候做

| 档位 | 谁做 | 要求 |
|---|---|---|
| **L3+** | `security` 角色出独立结论（`security_review`）**+ 审核复核** | **两者都要有**。缺了独立那一票，"审核自己说没问题"就不够 |
| **L0~L2** | 审核**自己跑** `pipeline_security_check` | L0/L1 至少跑本地泄密面；网络面无外联时可标 `applicable:false` + **说明依据** |

放在流程里的位置：**测试通过 → 审核中** 做安全确认 → 写进 `review_verdict.security` → 关单闸校验。

### 怎么给依据

跑一次扫描，把它返回的 `checks_ref` 原样填进结论：

```jsonc
// review_verdict.security（**必填**）
{
  "local_leak": { "checked": true, "evidence": ["扫过，未见凭证特征"],
                  "checks_ref": ["reports/security-scan-2026-….json#<sha256前缀>"] },
  "network":    { "checked": true, "evidence": ["产物无出网调用"],
                  "checks_ref": ["reports/security-scan-2026-….json#<sha256前缀>"] },
  "attestation": "clean",          // clean | issues | unknown
  "checked_by": "reviewer",
  "checks_ref": ["reports/security-scan-2026-….json#<sha256前缀>"],
  "findings": []                   // [{ location, type, why, resolved }]
}
```

`pipeline_security_check` 会把完整结果落盘到 `.pipeline/<任务>/reports/security-scan-<时间>.json`，
`checks_ref` 就是 `相对路径#sha256前缀`。

**★ 依据必须真实存在** —— 关单时会去磁盘上核对。只写路径不落盘，等于没有依据：

```
拒绝关单：安全确认里给的 checks_ref 指向的检查产物**一个都不存在**。
  · reports/never-written.json
★ "我扫过了"必须留下可核对的东西：调 pipeline_security_check 会把扫描结果落盘到本任务的
reports/，把它返回的 checks_ref 原样填进来即可。
（只写路径不落盘，等于没有依据。）
```

### 什么算通过、什么算不通过

**通过**：`attestation: 'clean'` 或 `'issues'`，两个面都 `checked:true`（或标了不适用 + 依据），
`checks_ref` 都有且**真实存在**，`findings` 里**没有未解决项**。

**不通过**（每一条都是关单闸，实测拒绝原文见 [`tests/security-check-last-run.txt`](tests/security-check-last-run.txt)）：

| 情形 | 错误码 | 出路 |
|---|---|---|
| 结论里没有 `security` 段 | `BAD_HANDOFF`（提交层） | 补上 |
| `attestation: 'unknown'` | `SECURITY_ATTESTATION_UNKNOWN` | 查清它，或打回 |
| `checked: false` | `BAD_HANDOFF` | 不许跳过检查 |
| `checks_ref` 为空 | `BAD_HANDOFF` | 给依据 |
| `checks_ref` 指向的文件不存在 | `SECURITY_CHECKS_REF_MISSING` | 真跑一次扫描 |
| 有**未解决**的 finding | `SECURITY_FINDINGS_OPEN` | 打回编写 / 转 security 角色 / 升级人工 |
| `security` 角色报 `blocked: true` | `SECURITY_VETO` | 强制打回，**不得关单** |
| L3+ 没有独立 `security_review` | `MISSING_SECURITY_REVIEW` | 让安全角色出一份 |
| `checked_by: 'security'` | `BAD_HANDOFF` | 审核必须自己出结论 |

`attestation: 'unknown'` 被拒的理由写进了拒绝文案本身：

```
security.attestation=unknown —— **不允许通过**。
★ 要么查清（clean / issues），要么打回让编写补齐可查的证据。
"没查"和"查了没问题"是两件完全不同的事，不能都算过。
```

### ★ 审核不能只写"安全角色说没问题"

`security_review`（安全角色出的）是**输入证据**，不是审核结论。
`checked_by: 'security'` 会被直接拒：

```
security.checked_by=security —— 审核不能只写"安全角色说没问题"。
★ 安全角色（L3+）产出的 security_review 是**输入证据**，不是审核结论。
审核必须自己跑一遍检查（或复核安全角色的证据）并给出自己的 attestation。
```

（注意：`security_not_blocked` 闸仍然**独立地**尊重安全角色的否决 —— 审核说 OK 也翻不了它。）

### finding 必须可追问，但不许抄原文

每条 finding 三个必填字段：

| 字段 | 说明 |
|---|---|
| `location` | **位置** —— 哪个文件第几行 / 哪份制品 |
| `type` | 类型（如 `openai_style_key` / `unexplained_outbound` / `credential_in_outbound`） |
| `why` | 为什么算问题 |
| `resolved` | 是否已解决（默认 false） |

**但不得把命中内容原文写进结论** —— 那等于把泄露从制品搬到了结论里（结论会落盘、会被转告、会进审计）：

```
security.findings[0] 里出现了疑似凭证**原文**（openai_style_key）。
★ 这条是刻意的：把命中的密钥原文抄进审核结论，等于**把泄露从制品搬到了结论里** ——
结论会落盘、会被转告、会进审计。
正确写法：只写'哪个文件第几行命中哪一类'（例如 "artifacts/v1/x.json 第 3 行命中 generic_assigned_secret"）。
```

### ★ 扫描范围边界

**只扫本任务工作区**：

- `<项目>/.pipeline/<任务>/` 底下的全部文本类文件（制品、报告、交接物、`audit.jsonl`、收据）
- 加上调用方显式给出的 `extra_paths` —— 但**必须落在项目根之内**，越界的会被**拒绝并记入结果**

**不扫用户全盘、不遍历无关目录。** 理由三条：

1. **越界**：一个做安全扫描的工具去读用户整个硬盘，是权限越界；
2. **慢**：扫描时间随磁盘增大而增长，与任务大小无关；
3. **最小权限**：本插件的所有其它动作都严守"只碰本任务工作区"，扫描不该是例外。

边界会**写进结果**（`scan.scope.boundary`）并在摘要里出现，让调用方一眼看到"扫到哪为止"：

```
扫描范围：.pipeline/T-20261011-xxxx　文件 5 个 / 12.3 KB
边界：只扫本任务工作区（.pipeline/<taskId>/ 与显式给出的、落在项目根内的路径）；不遍历用户其它目录。
```

其他限制：单文件 2 MB 上限、最多 500 个文件、跳过 `node_modules`/`.git`/`dist` 等目录、二进制（含 NUL 字节）跳过。

### ★ 工具自身如何脱敏（自我指涉）

**扫描结果里不得回显命中原文** —— 否则这个工具本身就成了泄密渠道。做法：

| 位置 | 写什么 |
|---|---|
| 命中记录 | `{ file, line, type, severity, why, preview }` —— **没有** `match` 字段 |
| `preview` | **打码**片段：`sk-************34（共 23 字符）`（头 3 位 + 尾 2 位，中间全 `*`） |
| 人可读摘要 | 只写「`<文件>` 第 N 行命中 `<类型>`」 |
| 落盘的完整 JSON | 与上面同构 —— 同样不含原文 |

自测里有一条**工具缺陷断言**专门盯这件事：把假密钥的原文在**摘要**与**落盘 JSON**里各搜一遍，
搜到就判失败（反例⑤）。同时还有一条对照断言证明"确实给了打码片段"
（不然"什么都不输出"也能骗过前一条）。

### 一个诚实的边界

**扫描不是万能的。** 它只查已知模式（11 类本地泄密特征 + 2 类网络特征）。
`attestation: clean` 的意思是"**在这些模式上**没扫出问题"，不是"绝对安全"。
工具返回里也写着这句：

```
★ 建议结论：attestation=clean
（扫描未见命中。注意：**扫描不是万能的** —— 它只查已知模式；结论仍要你自己负责。）
```

### 验收标准里那一条

规格要求把这句话写进**验收标准**。它现在是任务卡的一部分：

> **审核必须确认网络安全 / 本地泄密是否发生**，并在 `review_verdict.security` 里给出
> `attestation`（`clean` / `issues`）与可核对的依据（`checks_ref` 必须真实存在）。
> `unknown` 不允许通过；有未解决 finding 不允许关单；安全角色 `blocked: true` 时强制打回。

### 试一下

```powershell
node tests\security-check.mjs     # 33 项：正例 + 八组反例 + 边界 + 工具缺陷断言
```

完整原始输出在 [`tests/security-check-last-run.txt`](tests/security-check-last-run.txt)。

---

## 编写分工（1~3 席位）

### 一句话

「编写」不再必然是一个 AI。编排可以把它拆成 **1~3 个独立席位**（`writer#1` / `writer#2` / `writer#3`），
每个席位一份独立令牌、一个独立会话、**一段互不重叠的写入范围**。

### ★ count=1 是同一套机制的退化情形（这条是硬要求）

不存在"单编写模式"与"多编写模式"两套代码。`count=1` 时：

- 分区表里有且只有一条：`{ seat: 'writer#1', scope_paths: ['.'] }`（范围 = 整棵项目根）
- 走**完全相同**的校验、完全相同的守门判据、完全相同的推进闸

因为范围是 `.`，守门的"越界"判据恒真 ⇒ 行为与改造前**等价**。
自测正例①就是在验这一点：它跑的就是原来的 happy path，一行没改。

### 席位从哪来：**编排给，不是主对话给**

```jsonc
// pipeline_orchestrate 的 writers 参数（只有编排角色能调）
{
  "count": 3,
  "partitions": [
    { "seat": "writer#1", "role_id": "writer", "scope_paths": ["src/web"], "interface_owner": "writer#1", "deliverables": ["前端页面"] },
    { "seat": "writer#2", "role_id": "writer", "scope_paths": ["src/api"], "interface_owner": "writer#1", "deliverables": ["后端接口"] },
    { "seat": "writer#3", "role_id": "writer", "scope_paths": ["docs"],    "interface_owner": "writer#1", "deliverables": ["文档"] }
  ],
  "reason": "接口契约已冻结，三块互不相干，可并行推进"
}
```

- `reason` 在 `count>1` 时**必填**（可追溯：为什么分、怎么分的）
- `decided_by` 固定写成 `orchestrator` —— 谁是决策者这件事要留在数据里
- 主对话只能**派在册席位**（`pipeline_dispatch { role:"writer", seat:"writer#2" }`），
  派一个不存在的席位会被明确拒绝："主对话不能自行加席位"

编排产出的摘要里会直接列出席位与范围：

```
需要几个独立对话：7 个
编写席位：3 个（本档上限 3）
  · writer#1 → src/web（前端页面）
  · writer#2 → src/api（后端接口）
  · writer#3 → docs（文档）
  为什么这么分：接口契约已冻结，三块互不相干，可并行推进
  对话：主对话 / 需求分析/编排判断 / 架构/技术方案 / 编写 / 测试 / 审核 / 架构图
```

### 三条执法点（都是机制，不是约定）

| 在哪 | 判据 | 拒绝原文（实测） |
|---|---|---|
| **编排时** | 分区**不得重叠**（含包含关系：`src/a` 与 `src/a/b` 也算重叠） | 「分区重叠：writer#2 的「src/a/b」与 writer#1 的「src/a」互相包含。」 |
| **写入时**（守门） | 席位只能写自己那段 | 「越界写入别人的分区。… 该路径属于：writer#1（范围：src/web）」 |
| **提交时** | 令牌席位必须与交接物声明的席位一致 | 「席位不匹配：你这枚令牌属于「writer#1」，但这份交接物声明的是「writer#2」。」 |

**为什么"重叠"选择编排时就拒，而不是运行时警告**：
等运行时才发现重叠，两个席位可能都已经写过了 —— 那时再警告已经晚了。
而"分区无重叠"本来就是编排划界时**必须想清楚**的事，让它在这里付出代价是最便宜的。

### 汇总与推进：**全部席位到齐才推进**

每个席位各交一份带分区元数据的 `dev_to_test`：

```jsonc
{
  "artifact_version": "v1",
  "patch_or_code": "…",
  "partition": { "seat": "writer#2", "index": 2, "total": 3, "scope_paths": ["src/api"] }
}
```

**为什么不让"主编写席位"汇总成一份**（另一个选项）：

1. **汇总会引入一个隐藏的等级**。"谁是主编写席位？谁定的？"—— 编排划界时并没有这个角色，
   凭空冒出来就等于在席位之间加了一层没人审计过的从属关系。
2. **汇总那一步本身不可审计**。合并 N 份报告时丢了什么、改了什么都看不出来。
   测试与审核**直接看 N 份分区报告**反而更清楚"谁改了什么、边界在哪"。
3. **接缝问题会被汇总掩盖**。三份报告并排看，接缝处（前端调后端的那个接口）谁负责一目了然；
   汇总成一份之后，接缝恰好是最容易被写没的那部分。

代价是测试要读 N 份而不是 1 份。这个代价我认为值 —— 分区本来就是给"看清边界"用的。

**先交的不会被退回去**：一个席位先干完先交是正常节奏，
所以提交时如果还没到齐，**交接物照收、照留痕，但状态先不动**：

```
已提交：H-…（编写交付给测试，编写 → 测试）。
任务 T-… 当前状态：开发中。
本席位「writer#1」已交（1/3）。还差：writer#2、writer#3 —— 全部到齐前不会推进到「待测试」。
```

最后一个席位交完时由**它**触发推进。每次提交都留一条 `seat:submit` 审计（含 `done`/`total`）。

### 分档：允许多少个席位

| 档位 | `maxWriters` | 为什么 |
|---|---|---|
| L0 | 1 | 单文件/单函数级改动。拆开的话，沟通成本比改动本身还大 |
| L1 | 1 | 有明确边界但仍是一块活。接口没冻结就拆，两个席位会在边界上互相改 |
| L2 | 3 | 跨模块/跨服务 —— **这是拆分真正开始划算的档位** |
| L3 | 3 | 安全敏感，但还是那几个模块 |
| L4 | 3 | 要动生产，但不改变"几个模块"这个事实 |
| L5 | 3 | 同上 |

**为什么 L0/L1 是 1**：拆分的**前提是接口已冻结**。L0/L1 的需求本来就没到需要冻结接口的复杂度，
硬拆只会让两个席位在同一个概念上各写一半，然后互相改。
**为什么上限是 3**：超过 3 之后，席位之间的接口对齐成本增长快过并行收益；
而且真实需求里"三块互不相干"已经很罕见了，第四块通常是第一块的延伸。
上限是 `MAX_WRITER_SEATS` 常量，要改就改它（但请连带想清楚评审与测试要读几份报告）。

### 编排怎么判"该不该拆"（可执行信号）

`lib/tiers.js` 的 `recommendWriters()` 给规则引擎用，产出**建议**：

| 信号 | 权重 | 说明 |
|---|---|---|
| 接口/契约已明确（"接口已冻结""先定接口"） | **3** | ★ **前提条件**，权重最高 |
| 跨模块/可并行/互不相干 | 2 | |
| 前后端 / 多包（client·server·sdk·plugin…） | 2 | |
| 改动量大 / 文件数多 | 1 | `expectedFiles > 8` 另计 +2 |

判据：**没有"接口已冻结"这类前提条件时，无论命中多少弱信号都建议 1 个席位** ——
理由写在建议里：

```
命中了 2 条弱信号（涉及多个互不相干的模块；改动量偏大），但**接口尚未冻结** ——
没有冻结的接口就拆，两个席位会在边界上互相改，比一个人还慢。建议仍用 1 个席位。
```

**这始终只是建议**。最终仍由独立编排对话判断并把理由写进 `writers.reason`。

### 主对话在席位这件事上的边界

| 能做 | 不能做 |
|---|---|
| 按 `roster.writers.partitions` 逐席位 `pipeline_dispatch` | ❌ 决定 `count` |
| 看 `pipeline_status.writers` 知道谁交完了 | ❌ 派一个不在册的席位 |
| 催还没交的席位 | ❌ 改任何席位的 `scope_paths` |
| 在席位全到齐后看到状态自动推进 | ❌ 在没到齐时手动推状态 |

要改席位方案：执行角色 `pipeline_roster_request` 提出 → 编排 `pipeline_roster_review` 复核。

### 一个已知的简化（诚实写在这里）

多席位时每个席位各登记一个制品版本（v1/v2/v3），`currentArtifactVersion` 返回**最后一个**。
也就是说测试与审核对着的是"最后交的那一份的版本号"，而不是"这一轮的版本"。
实际影响很小（三份都属于同一轮，且各自的 `dev_to_test` 里都写清了自己的版本与分区），
但严格说这是个简化。要做成"一轮一个版本号"需要引入 round 概念，那是另一个增量。

### 试一下

```powershell
node tests\writers-check.mjs      # 39 项：count=1 退化 + count=3 全流程 + 五类反例 + 回执闸
```

---

## 架构图角色

### 与 `architect` 的区别（最容易混的一个）

| | `architect`（架构/技术方案） | `diagrammer`（架构图） |
|---|---|---|
| 时机 | 编写**之前** | 编写**之后** |
| 产物 | 文字方案 `design` | **图** `architecture_diagram` |
| 性质 | 输入约束（"该怎么写"） | **交付物**（"写成了什么样"） |
| 关单要不要 | 不要 | **要**（清单里派了它就必须交） |

一个是给人看的约束，一个是给交付的成品。混成一个会导致"图在代码之前画完了"这种荒唐结果。

### 时机（两道闸）

1. **状态闸**：`architecture_diagram` 只允许在 `待测试 / 测试中 / 待审核 / 审核中 / 已通过` 提交。
   还在 `开发中` 就交 → 拒。
2. **产物闸**：必须已经存在至少一份 `dev_to_test`。

两道一起挡"还没写完就交图"。第二道是必要的 —— 光看状态不够，
"待测试"也可能是被回退回来的，那时同样没有新产物。

拒绝原文（实测）：

```
跳步：交接物「architecture_diagram」只能在这些状态下提交 —— 待测试(ready_test) / 测试中(testing) /
待审核(ready_review) / 审核中(reviewing) / 已通过(passed)；任务 T-… 当前是「开发中(developing)」。
★ 架构图必须在**编写完成之后**交。现在还在「开发中」—— 先让编写交 dev_to_test。
```

### 产出路径：优先 `diagram_deliver`，可降级但必须标出来

本机装的 `dsh-archigate` 提供 **`diagram_deliver`**：
一次跑完「normify 建树校验 → 组件↔模块映射闸门 → archify 渲染四道门 → 落**交付收据**」。
架构图角色**优先**走它，然后把返回的 `html_path` / `html_sha256` / `receipt_path` / `receipt_id`
填进 `architecture_diagram` 交接物。

**本插件不替它调用那个工具**（跨插件耦合能少则少），而是**校验它的说法**：

| `produced_by` | 要求 | 不满足时 |
|---|---|---|
| `diagram_deliver` | `receipt_path` **必须真实存在**；给了 `html_sha256` 就与磁盘核对 | **拒**（`RECEIPT_MISSING` / `DIAGRAM_HASH_MISMATCH`） |
| `self-provided` | `degraded` **必须为 true** 且 `degraded_reason` 非空 | **拒**（`BAD_HANDOFF`） |

无论哪条路，`diagram_path` 指向的文件都必须真实存在。

**为什么降级要"必须标出来"**：没走 `diagram_deliver` 就没有闸门、没有收据。
不标出来的话，下游（测试/审核/主对话）会以为这张图过了 normify 校验与组件映射闸门 ——
那是一次**无声的质量降级**。标出来之后，审核可以据此决定要不要打回。

实测拒绝原文：

```
produced_by=diagram_deliver，但收据文件不存在：…\nope.json
★ diagram_deliver 的价值就在那份**交付收据**（含被引用模块的 id 与 fingerprint、
规格文件 sha256、产物 sha256、所用命令与版本）。没有收据，事后就答不出
"这张图基于哪一版结构数据、当时校验过没有"。
两条出路：① 真的调一次 diagram_deliver，把它返回的 receipt_path 填进来；
② 如果 dsh-archigate 没装/被禁用，把 produced_by 改成 self-provided 并标 degraded=true + 原因。

produced_by=self-provided 时 degraded 必须是 true。
★ 这条是刻意的：没走 diagram_deliver 就没有闸门、没有收据，那必须在交接物上**明确标出来**，
不能让下游（测试/审核/主对话）误以为这张图过了 normify 校验与组件映射闸门。
```

### 交接物字段

| 字段 | 说明 |
|---|---|
| `based_on_artifact_version` | 这张图对应哪个制品版本（关单时会核对，旧版本的图会被拒） |
| `diagram_path` | 渲染出来的 HTML 路径（**必须真实存在**） |
| `produced_by` | `diagram_deliver` / `self-provided` |
| `receipt_path` / `receipt_id` | 交付收据（走 `diagram_deliver` 时必填） |
| `html_sha256` | 产物哈希（可选；给了就核对） |
| `covered_modules[]` | 覆盖了哪些模块 |
| `degraded` / `degraded_reason` | 是否降级 + 为什么 |
| `notes[]` | 说明 |

### 分档

**L2 起默认纳入**（L2/L3/L4/L5）。L0/L1 不默认给 —— 单文件/单函数级改动画架构图没有信息增量，
画出来只会是一张"一个框加一个箭头"。L0/L1 需要时由编排用 `extra_roles` 临时加。

### 关单闸

角色清单里**派了** `diagrammer`，架构图就是**交付物之一**，没交不能关单：

```
拒绝关单：本任务的角色清单里有「架构图」角色（diagrammer），但没有任何 architecture_diagram 交接物。
★ 它在本任务里是**交付物之一**，不是可选项 —— 清单里派了它，就得交。
要么让架构图角色交图（走 diagram_deliver 拿收据，或降级并标 degraded=true），
要么让编排复核后把该角色从清单里去掉（roster_request → roster_review）。
```

还有一条**版本**判据：图对应的制品版本必须等于当前有效制品版本，否则拒（`DIAGRAM_STALE`）——
防止"代码改了但图还是旧的"。

**注意**：清单里**没有** `diagrammer` 的任务完全不受影响（判据直接放行），所以这条闸不会波及既有任务。


---

## 结构化交接物 schema

四份核心交接物，字段是**固定**的 —— 因为下游角色与守门判据都要按字段名读。
一旦允许"自由发挥"，越权与跳步就没法机械判定。

### `dev_to_test` · 编写 → 测试

| 字段 | 类型 | 说明 |
|---|---|---|
| `task_id` | string | 必填 |
| `artifact_version` | string | 必填，例如 `v1`。与当前有效制品必须一致 |
| `patch_or_code` | text | 必填。代码或补丁 |
| `change_note` | text | 必填。变更说明 |
| `run_commands` | string[] | 必填。运行命令 |
| `selftest_result` | text | 必填。自测结果 |
| `known_issues` | string[] | 必填，**可以是空数组**（"没有已知问题"本身要显式回答） |
| `acceptance_map` | object | 选填。验收标准 → 实现位置 的对照 |

### `test_to_review` · 测试 → 审核

| 字段 | 类型 | 说明 |
|---|---|---|
| `task_id` | string | 必填 |
| `artifact_version` | string | 必填。必须与编写交付一致 |
| `test_cases` | string[] | 必填，至少 1 条 |
| `execution_result` | text | 必填 |
| `failure_logs` | string[] | 必填，**可为空数组** |
| `pass_evidence` | string[] | 必填，至少 1 条（`verdict=pass` 时尤其） |
| `risk_notes` | string[] | 必填，**可为空数组** |
| `verdict` | `pass` \| `fail` | 必填。**`fail` 的交接物会被拒**——请改用 `pipeline_rework` |

### `review_verdict` · 审核 → 主对话/用户

| 字段 | 类型 | 说明 |
|---|---|---|
| `task_id` | string | 必填 |
| `artifact_version` | string | 必填。必须与测试报告一致 |
| `conclusion` | `OK` \| `NG` | 必填 |
| `risk_notes` | string[] | 必填，**可为空数组** |
| `release_approved` | boolean | 必填。`OK` 必须是 `true`，`NG` 必须是 `false`（自相矛盾会被拒） |
| `final_delivery_note` | text | 必填。最终交付说明 |
| `acceptance_check` | object | 选填。逐条验收标准的核对结果 |
| `reject_to` | `writer` \| `tester` \| `none` | `NG` 时必填 |
| `reject_reason` | text | `NG` 时必填 |

### `dispatch` · 主对话 → 执行角色

任务ID、原始需求、验收标准、约束条件、交付格式、截止要求。
实际派活时由 `pipeline_dispatch` 自动渲染成一份**可粘贴的派活单**
（见 [`examples/example-dispatch-brief.md`](examples/example-dispatch-brief.md)）。

### 其余类型

`orchestration`（编排结论）、`test_to_dev`（测试打回）、**`clarification_request` / `clarification_reply`（两级升级梯第一级）**、**`human_request`（人工介入请求）**、`architecture_diagram`（架构图交付）、**`seat_handover`（席位交接 / 换班，编排的还要带 `pending_requests`）**、**`compilation`（留档汇总）**、`design`、`security_review`（安全角色独立结论）、
`release_plan`、`docs_note`、`perf_report`、`arbitration`、`human_note`。
完整 schema 定义在 `lib/handoff.js` 的 `HANDOFF_SCHEMAS`。

### 跨字段约束（不只是"字段齐了就行"）

- `review_verdict`：`conclusion=NG` 必须有 `reject_to` + `reject_reason`；`OK` 必须 `release_approved=true`
- `test_to_review`：`verdict=fail` 直接拒；`verdict=pass` 必须有 `pass_evidence`
- `orchestration`：`ai_count` 不得小于 4；`roles` 必须含 writer/tester/reviewer
- 所有带 `artifact_version` 的交接物：必须等于**当前有效制品版本**

---

## 工具面（38 个）

> 下表只列**常用/关键**的 20 个（它们覆盖 99% 的日常操作）；**完整清单（38 个）**以
> `lib/tools.js` 的注册、`pipeline_boundaries` 的 `tool_face` 与 `tests/load-smoke.mjs`
> 的计数断言为准（本轮已按 36 校准；`lib/tools/` 下按工具分组）。

| 工具 | 谁能调 | 干什么 |
|---|---|---|
| `pipeline_task_open` | 主对话 | 开单。返回任务 id 与主对话令牌 |
| `pipeline_orchestrate` | 主对话（只能走规则引擎）/ 编排 | 产出角色清单 + 任务卡。支持 `dry_run` 试算 |
| `pipeline_dispatch` | 主对话 | 按清单派活 + 铸角色令牌 + 推进状态。清单外的角色派不出去；`reassign:true` 重派会**吊销旧席位令牌**（旧会话写不进去，避免双写） |
| `pipeline_bind_role` | 任意角色会话 | 用令牌认领身份（一笔绑定，不可改绑） |
| `pipeline_handoff` | 各角色 | 提交结构化交接物（唯一的交付入口） |
| `pipeline_transition` | 主对话 / 人工 | 状态迁移与异常出口（block / unblock / cancel） |
| `pipeline_rework` | 测试 / 审核 / 安全 | 打回，带次数预算 |
| `pipeline_close` | 主对话 | 关单。**必须已有有效审核 OK**；按**档位产物矩阵**检查必需产物（测试/审核/安全类不可豁免），`deferred_artifacts` 可豁免仪式性产物（理由 + 批准人）；失败时附**完整缺口清单**，支持 `dry_run:true` 只预演 |
| `pipeline_status` | 任何人 | 查询状态、角色清单、制品、OK、打回计数、下一步合法事件、审计流水；`page`/`page_size` 可对 handoffs/history/dispatch_slots 分页（不传 `page` 输出不变），返回只读 `storage`（task.json/baseline/artifacts 体积 + 超 1 MiB 提示） |
| `pipeline_wait` | 任何人 | ★ 只读长轮询：等到某状态/某历史动作（`until_state` / `until_event`，默认 60s 上限 120s）；超时给当前状态 + 最近动作 + 建议；不改状态、不写盘 —— 替代"主对话 sleep 轮询" |
| `pipeline_roster_request` | 执行角色 | 提出角色增减申请 |
| `pipeline_roster_review` | 编排 | 复核申请；批准即改写清单 |
| `pipeline_artifact` | 编写 | 登记制品版本（v1、v2…）或回滚到历史版本；可选 `files:[{path,sha256}]` 登记**整体交付快照**（`snapshot_id` + 逐文件校验），`action:"verify"` 可重算；L3+ 关单要求当前制品快照完整 |
| `pipeline_selftest` | 任何人 | 当场跑正例 + 反例 + 分档，打印拒绝原文 |
| `pipeline_switch` | 任何人 | **多 AI 协调功能的总开关**（与右上角 UI 按钮是同一个开关位）。不带参数 = 翻转；带 `on` = 显式设定 |
| `pipeline_clarify_request` | **执行/顾问角色** | ★ 两级升级梯 ① 向上问需求分析（用户根本不用被打扰） |
| `pipeline_clarify_reply` | **只有 orchestrator** | ★ ② 裁定：`answered`（给结论）/ `cannot_answer`（答不了，准备升级）。不带 `request_id` = 收件箱 |
| `pipeline_security_check` | reviewer / security / main / human | ★ 安全确认扫描：本地泄密面 + 网络面，产出脱敏摘要 + 落盘 JSON（审核把它填进 `review_verdict.security`） |
| `pipeline_human_request` | 执行角色（**仅 L0**）/ orchestrator（升级） | ★ ③ 升级给用户，或 L0 直发 |
| `pipeline_human_relay` | **只有主对话** | ★ ② 把请求转告用户（不带 request_id = 收件箱）。不改状态 |
| `pipeline_human_reply` | **只有主对话** | ★ ③④ 记录用户答复（原话+归属）并据它恢复状态 |

（工具总数 **38**。上表里的 20 个是常用面；其余 18 个按分组在 `lib/tools/`：
分档编排/项目目录（`pipeline_demo` / `pipeline_demo_submit` / `pipeline_project_init` / `pipeline_supervise`）、
计划与授权面（`pipeline_plan` / `pipeline_scope_amend` / `pipeline_change_audit` / `pipeline_boundaries`）、
分权落档（`pipeline_record_submit` / `pipeline_compile_requirement` / `pipeline_contacts`）、
继任与水位（`pipeline_context_report` / `pipeline_succession`）、
能力申请（`pipeline_capability_request`）、全量测试（`pipeline_full_test`）、
记忆（`pipeline_recall`）、清理（`pipeline_task_purge`）。）

> ★ **自动审查（Auto review，实验性 · 仅设计）**：借鉴官方 `dsh-permission-presets` 的 Auto review，
> 但只借结构不借"模型说行就行"。设计与不变量（不自我批准 / 不扩大授权面 / 一次性 / fail-closed /
> 成对审计 / 熔断 / 默认关闭）见 [`design/approvals/01-自动审查.md`](design/approvals/01-自动审查.md)。
> 当前 **P0 仅设计、未实现**（等用户拍板 §15 的 5 个问题）。

---

## 落盘布局

```
<项目根>/.pipeline/<taskId>/
├── task.json                  任务卡 + 当前状态 + 角色清单 + 打回计数 + 制品表
├── handoffs/
│   ├── 001-orchestration.json
│   ├── 002-dev_to_test.json
│   ├── 003-test_to_review.json
│   └── 004-review_verdict.json
├── artifacts/
│   └── v1/                    每个版本一个目录，旧版本不删（可回滚）
├── reports/                   测试报告、审核意见（非编写角色唯一可写的地方）
├── records/                   ★ 分权落档：各方**各写各的**（orchestrator / architect /
│                              writer-writer1 / tester / …），互不覆盖
├── requirement.md             ★ 留档 AI **汇总出的唯一需求档**（人可读）
├── requirement.json           结构化版本（compiled_by / records_used）
├── requirement.index.json     ★ 版本索引（r1/r2/… + sha256 + supersedes + 差异摘要）
├── requirement.rN.md/.rN.json 每一版历史（**绝不覆盖**）
└── audit.jsonl                只追加的动作流水，永不删除
```

`audit.jsonl` 一行一个动作，含时间、任务 id、actor（角色）、action、以及该动作的关键字段。
它是"全流程可查询可追溯"的凭据。删它会被守门拦下。

实物见 [`examples/demo-project/`](examples/demo-project)。

---

## 守门：哪些是真拦截，哪些只是约定

这一节是**最重要**的一节。我把"能拦的"和"拦不住的"分开写清楚，不含糊。

### ✅ 真拦截（可实测复现）

| # | 拦什么 | 判据在哪一层 | 反例编号 |
|---|---|---|---|
| 1 | 编写直接提交审核（`review_verdict`） | `tools.guard`（dispatch 之前） | ① |
| 2 | 编写推状态到 `review_ok` / `test_passed` | guard + 状态机 | ① |
| 3 | 测试冒充审核、审核冒充编写 | guard（交接物方向表） | ① |
| 4 | 无有效审核 OK 关单 | guard + `execute` + 状态机（三道） | ② |
| 5 | 审核 NG 之后关单 | 同上 | ② |
| 6 | 测试/审核用文件工具改项目源码 | guard（角色 + 路径） | ③ |
| 7 | 测试用 **shell 旁路**改项目源码 | guard（命令串匹配） | ③ |
| 8 | 主对话用文件工具读代码正文 | guard（角色 + 路径） | ⑥ |
| 9 | 主对话用 **shell 旁路**读代码正文 | guard（命令串匹配） | ⑥ |
| 10 | 主对话自行批角色变更 | guard（工具角色白名单） | ④ |
| 11 | 主对话派清单外的角色 | `execute`（清单比对） | ④ |
| 12 | 主对话绕过独立编排自己定档 | `execute`（规则引擎闸门） | ④ |
| 13 | 打回次数超限 | `execute`（预算计数） | ⑤ |
| 14 | 令牌跨任务使用 | guard（令牌 ↔ 任务绑定） | ⑦ |
| 15 | 令牌转手给别的会话 | guard（令牌 ↔ 会话二次绑定） | ⑦ |
| 16 | 一个会话在同一任务里兼两个角色 | guard（会话绑定排他） | ⑦ |
| 17 | 交接物版本与当前制品不一致 | `execute`（版本比对） | ⑧ |
| 18 | 交接物跳过状态（跳步） | `execute`（状态 ↔ 交接物对照表） | ⑧ |
| 19 | 删除审计留痕（`.pipeline` 工作区） | guard（shell 模式） | — |
| 20 | 守门自身异常 → **fail-closed**（宁可拦住，不静默放行） | guard 的 try/catch | ⑩ |
| 21 | ★ **编写跑测试**（`npm test` / `pytest` / `node --test` / `node tests/x.mjs` / `--coverage` …） | guard（命令串匹配 + `guardWriterRunsTests`） | B-① |
| 22 | ★ **编写出测试结论**：交 `test_to_review` / `test_to_dev`（白名单里没有），或在 `dev_to_test` 里夹带 `test_cases` / `pass_evidence` / `verdict` | guard（交接物方向表）+ `execute`（`canProduceHandoff`）+ `validateHandoff`（内容） | B-① |
| 23 | ★ **需求分析 / 计划读代码正文**（文件工具） | guard（角色 + 路径；`NO_CODE_READ_ROLES`） | B-② |
| 24 | ★ **需求分析 / 计划用检索工具翻源码树**（`grep` / `findstr` / `Select-String` …；没限定在 `.pipeline/` 内即拦） | guard（角色 + 工具名 + 路径） | B-② |
| 25 | ★ **需求分析 / 计划用 shell 读代码正文** | guard（命令串匹配） | B-② |
| 26 | ★ **控制角色的产物里出现代码正文**（任务卡 / 分析依据 / 不清楚处 / 计划理由 / 自检说明…） | `validateHandoff`（`scanControlRoleProductForCode`，比人话判据更严） | B-② |
| 27 | ★ **编写写到授权改动面之外**（含**新增**未授权的文件；`create` 授权不得用于改已存在文件） | guard（`change_scope` 逐条核对；`guardChangeScope` 可关） | S-①②③ |
| 28 | ★ **编写用 shell 写到授权面之外**（best-effort） | guard（命令串 + 路径提取） | S-④ |
| 29 | ★ **有授权面却不交「实际改动面」**，或改动清单引用不存在的授权条目 | `execute`（`checkManifestAgainstScope`） | S-⑤⑥⑦ |
| 30 | ★ **越界事实存在时审核出结论** | `execute`（`scope_conformance` 直接拒） | S-审核 |
| 31 | ★ **需求分析的产物里出现分配内容**（派谁 / 用几个 AI / 档位 / 角色清单） | `validateHandoff`（`scanRequirementAnalysisForAllocation`） | S-B④ |
| 32 | ★ **缺职责自限声明**（`role_scope`），或 `will_not_do` 空 | `validateHandoff`（`validateRoleScope`） | S-B⑤⑥ |
| 33 | ★ **计划的角色边界卡没覆盖全部执行角色** | `execute`（`setRoster` 覆盖性核对） | S-B / selftest |
| 34 | ★ **两份控制产物互换角色**（需求分析交计划、计划交需求分析结论） | guard（交接物方向表） | S-B①② |
| 35 | ★ **审核写任何位置**（除 `reports/reviewer/<role>.log\|.jsonl` 之外：别人的报告、源码、需求档、别的任务目录） | guard（`writes: 'own-log'` 专属路径判据） | R-D①~⑥ |
| 36 | ★ **有基线却不交前后版本对比结论**（`review_verdict.change_audit`） | `execute`（有基线时必填） | R-C① |
| 37 | ★ **对比结论与实测不符**（`baseline_id` 过期 / `verdict` 填反） | `execute`（store **自己重算**核对） | R-C②③ |
| 38 | ★ **实测有多改却发 OK** | `execute`（`CHANGE_OUT_OF_SCOPE_OK`） | R-C④ |
| 39 | ★ **编写自己重设改动基线**（洗掉越界痕迹） | `execute`（只有计划 AI / 主对话能 `take`） | R-C |
| 40 | ★ **审核在开工前就出结论**（双轨派活 ≠ 提前判定） | guard + 状态机（`review_verdict` 只在 `reviewing` 可交） | R-A |

第 21~26 条是**设计目的**规则①②的落点（反例编号 `B-*` →
[`tests/boundary-check.mjs`](tests/boundary-check.mjs)）；
第 27~34 条是规则③④的落点（`S-*` →
[`tests/scope-check.mjs`](tests/scope-check.mjs)）；
第 35~40 条是规则⑤⑥的落点（`R-*` →
[`tests/review-check.mjs`](tests/review-check.mjs)）。
其余每条都在 `tests/selftest.mjs` 里有对应断言，报告里**原样附拒绝原文**。

### ⚠️ 拦不住的（约定，不是机制）

1. **主对话把别人的令牌转手交出去。**
   主对话手里握着它派出去的每一个角色的令牌（`pipeline_dispatch` 的返回值里就带着），
   这是设计上的信任根。令牌能挡住"角色会话自己搞错/越权"，挡不住"主对话主动递刀"。
   要收紧：配置 `requireAgentBinding: true` 并只走真实子代理通道 ——
   那时令牌与子会话 id 一一对应，转手即失效。

2. **shell 旁路的刻意混淆。**
   shell 侧是**字符串匹配**的 best-effort 判据：命令里同时出现"动作动词"与"受保护路径"就拦。
   `Set-Content "C:\...\x.js"` 拦得住；但把路径拆成变量拼接、`base64` 解码后执行、
   先写个脚本再跑 —— 这些绕得过去。
   **文件工具那一路是结构化的（直接读参数里的路径），那才是硬的。**

   ★ 同一条限制也适用于设计目的那两条：**"编写不跑测试"与"控制角色不看代码"在 shell 侧
   同样是 best-effort** —— 写一个 `run-tests.ps1` 再执行它、把命令拼成变量，都拦不住。
   要真保证只能靠**环境侧**（不给编写席位测试环境、不给控制角色源码挂载），那不是插件能给的。
   （`grep` / `glob` 这类工具走的是**结构化的工具名 + 路径参数**判定，那一路是硬的。）

3. **不绑定角色的会话完全不受约束。**
   守门只约束**流水线参与者**。一个和流水线无关的会话，或者一个拿到了任务但没走
   `pipeline_bind_role` 的会话，对它做不了任何事。这是刻意的（否则会和别的插件打架）。

4. **★ 同步索引的"空窗期"：索引里没有该任务时，靠索引的那几条文件判据会整段跳过（fail-open）。**
   守门要**同步**查询（`guardReason` 是同步遍历），而任务数据在盘上、读取是异步的。
   所以项目根 / 路径映射放在一张内存索引里，任务被打开或加载时登记。
   这段时间里**文件工具层面**的越权判定不生效（令牌层面的不受影响，它只看内存令牌表）。

   **影响哪些操作**（实测，见 `tests/records-check.mjs` 的「★ 已知限制」一组）：

   | 判据 | 空窗期里的行为 |
   |---|---|
   | 测试/审核不得改项目源码 | ✗ 不生效 |
   | 需求档写权独占（只有留档 AI 能写） | ✗ 不生效 |
   | `records/` 只能写自己那份 | ✗ 不生效 |
   | 编写席位的分区边界 | ✗ 不生效 |
   | 不得用 shell 旁路改项目文件 | ✗ 不生效 |
   | ★ 控制角色不得读代码正文（文件工具 / 检索工具） | ✗ 不生效 |
   | ★ 编写不得跑测试（shell 侧） | ✗ 不生效 |
   | ★ **改动面执法**（写到授权面之外） | ✗ 不生效 |
   | **令牌层面**（角色越权、退休席位、写权独占等工具调用判定） | ✅ **照常生效** |
   | ★ **交接物内容判据**（方向表、夹带测试结论、控制角色产物含代码、分配内容、职责自限、改动清单核对） | ✅ **照常生效**（它们不看索引，只看 payload） |

   **为什么不做成 fail-closed**：索引为空是"还没热身"，不是"调用方可疑"；
   一次误拦会打断正当工作。所以选择**保留 fail-open，但绝不允许它静默**。

   **★ 现在会留痕**：命中空窗期时，守门会通过 `ctx.logger.warn` 报一次（**每个任务只报一次**）：

   ```
   [pipeline] 守门提示：任务 T-… 还没进同步索引，**靠索引的那几条文件判据本次没有生效**
   （工具=write，角色=writer）。
     这不是拒绝，是"没查到" —— 判据整段跳过（fail-open）。
     为什么会这样：守门必须同步判定，而任务数据在盘上、读取是异步的，索引只是缓存。
     怎么缓解：让该会话先做一次流水线动作（任何 pipeline_* 调用都会把任务登记进索引），
     或在派活之后再做文件写入。本提示每个任务只报一次。
   ```

   **怎么缓解**：任何一次 `pipeline_*` 调用都会顺带把任务加载进索引 ——
   正常流程里"派活"就发生在"写文件"之前，所以窗口很窄。
   自测**不假设**它已经预热：`records-check` 开头显式预热并断言，
   另外单独有一组用例**如实覆盖**空窗期（放行 + 有留痕 + 预热后立刻恢复）。

5. **角色的"独立上下文"不是本插件提供的。**
   那是 DSH 子代理机制提供的。如果你把五个角色都塞进同一个对话里，
   "三权分立"就退化成角色扮演 —— 令牌还在，独立性没了。
   本插件能保证的是**一个会话在同一任务里只能担任一个角色**。

6. **`writer` 角色对项目源码的写权限是"整个项目根"。**
   守门不知道你的源码树和文档树分界在哪。要更细的粒度，
   用 `guardFileTools.write` 调工具名单，或者把项目根设小一点。

### 与 `tools/pre-execute` 的关系

本插件**只**注册 `ctx.tools.guard`，**不**监听 `tools/pre-execute`。
理由：pre-execute 是一条会挂在**每一次**工具调用上的 waterfall，多一个监听者就多一类
"整条链被带坏"的风险；而 guard 的**单调**语义（一旦拒绝，后续无人能翻回允许）
正好是我们需要的。

---

## 通信通道（可插拔）

「对话之间怎么通信」这条**没有替你拍板**，做成了接口（`lib/transport/`）：

| 通道 | 行为 | 副作用 |
|---|---|---|
| `session` | 用 `ctx.sessionController.create({agentPreset, workspaceId})` 建**侧栏里点得进的**一等公民会话；四槽 + 建组 + 读回核对 + 令牌绑定 | 会花 token；最"真" |
| `team` | 用**官方 Agent Teams** 原语派具名 teammate：`spawnTeammate` 建、`sendMessage` 投、`interrupt` 打断；角色人格写进派活单（官方没有 preset 参数） | 会花 token；成员名额有限（见 [docs/agent-teams.md](../../docs/agent-teams.md)） |
| `subagent` | 用 `ctx.subagents.startContinuable()` 建**真的**子代理会话，把派活单投进去；令牌与会话 id **二次绑定** | 会花 token |
| `manual` | **不创建任何会话**。只铸令牌 + 渲染一段可粘贴的派活单，人来复制 | 零副作用、零 token |
| `simulated` | 内存假会话，自测用 | 零副作用 |

配置 `transport: auto | session | team | subagent | manual`（默认 `auto`：先试 `session`，拿不到只上报、不静默降级）。
`teamAuto: true` 时 `auto` 先把 `team` 排在 `session` 前面（**默认 false，生产行为不变**）。
`spawnRoles: false` 时连建都不建，只发令牌 —— 试跑/演示用这个。

**为什么 `subagent` 是默认方向**：真实子代理通道下，令牌在铸造时就记下 `childId`，
后续每次调用都要求 `exec.agent.id` 与之相符 ——**令牌转手即失效**，第 1 条"拦不住的"
就补上了。manual 通道下这条保证拿不到。

### 官方 Agent Teams（`transport: 'team'`）

DSH 0.2.1 起官方带「智能体团队」：根会话是 Lead，可以 `spawn_teammate` 出具名、持久、
可续接的 teammate，用 `send_message` 投递、`team_task_*` 维护共享任务板。本插件把它接成
**第三条真实通道**（`lib/transport/team.js`）：

- 派活 = `spawnTeammate`（同名已存在则**复用**并 `sendMessage`，官方名字永不重用）；
- 催办 / 孤儿重投 / 失联唤醒 = `sendMessage`；`{ stop: true }` = `interrupt`；
- 四槽：`mode` **恒 UNAVAILABLE**（官方 API 没有 agentPreset，如实登记不假装）；
  `permission` / `model` spawn 后补钉并读回；`teamStrictSlots: true` 时钉不上就拒绝派活；
- 任务板镜像（`teamBoard: auto`）：开单 `createTask` → 派活 `reassign` → 关单 `complete`，
  best-effort，失败只写 `audit.jsonl` 的 `team:board-*`，**不改变流水线状态**；
- 守门：绑定角色一律拒绝 team 协作 / 委派 / 插件管理 / 会话搜索工具（席位工具面也隐藏），
  `terminal_send` 的正文（`text` 参数）按 shell 命令检查 —— 详见 `lib/guard/official-tools.js`。

完整用法、能力边界与排障见 [`docs/agent-teams.md`](../../docs/agent-teams.md)，
设计事实与取舍见 [`design/agent-teams/01-目标与边界.md`](design/agent-teams/01-目标与边界.md)。

派活单长什么样见 [`examples/example-dispatch-brief.md`](examples/example-dispatch-brief.md)。

---

## 与其它插件共存

已装的 `dsh-archigate` 也占用一个 guard。两边**都是只拒不放的单调守卫**，
`ToolLayer.guardReason` 取第一个非 `undefined` 立即返回
（`dsh-tools/lib/index.js:2646-2651`），**没有任何通路**能让后注册的守卫把先注册的拒绝
翻回允许。而且 guard 只在 `tools/pre-execute` 决议为 `allow` 时才跑（`:3241`）——
别的插件（archigate 的 archify 交付守门、`experimental-auto-review` 的授权闸门）
先拒的调用根本走不到这里。

`tests/selftest-core.mjs` 的「反例⑨」专门验这件事，5/5 通过：

- 别人的拒绝不会被本插件翻回允许
- 本插件的拒绝也不会被别人翻回允许
- **交换注册顺序结论不变**
- 与流水线无关的调用完全不受影响
- 未绑定角色的会话完全不受本约束

---

## 自测

```powershell
cd <插件目录>
$env:DSH_APP_ASAR = '<DSH 安装>\resources\app.asar'   # 预设/宿主 schema 类判据要读宿主安装
node tests\run-all.mjs            # 126 套一起跑（4098 项，含残留检查）
node tests\run-all.mjs --quiet    # 只打结论，不贴完整拒绝原文
```

**当前口径**：设了 `DSH_APP_ASAR` 时 **4098/4098 通过（126 套）**；不设时会有 3 条
"读不到宿主安装"的预置校验判红（环境面，不是代码面）。单套清单与每套的判据写在
`tests/run-all.mjs` 与 `tests/registry.mjs` 里（新增能力用新套 + registry 一行登记）。

按能力分组（不逐一列 126 套）：

| 分组 | 代表套件 | 内容 |
|---|---|---|
| 内核全流程 | `selftest.mjs` | 正例全流程 + 12 组反例 + 5 档分档验证（70 项） |
| 装载/注册 | `load-smoke.mjs`、`schema-check.mjs` | 假 ctx 上调 `apply`，验注册 / 守门 / 开关路由 / 卸载 / 降级；工具定义计数（38 个） |
| 通道 | `channel-check.mjs`、`dispatch-channel-check.mjs`、`team-transport-check.mjs` | 四条真实通道（session / team / subagent / manual）+ 选择点 + 官方 teammate 命名/复用/四槽证据/投递截断 |
| 守门 | `shell-guard-check.mjs`、`intercept-check.mjs`、`silent-veto-*.mjs`、`team-guard-check.mjs` | 越权/跳步/旁路；官方新工具（team 协作 / 委派 / 插件管理 / 会话搜索）拒绝；`terminal_send` 的 `text` 按 shell 检查 |
| 流程各站 | `human-check`、`writers-check`、`ladder-check`、`security-check`、`relay-check`、`records-check`、`plan-check`、`review-check`、`gate-states-check`… | 人工介入、编写席位、升级梯、安全确认、继任、分权落档、计划/审核/状态机 |
| 任务板镜像 | `team-board-check.mjs` | 开单/派活/关单三处镜像 + revision CAS 重试 + best-effort 降级 |
| 自建面板 | `panel-snapshot-check.mjs`、`panel-actions-check.mjs`、`panel-ui-check.mjs`、`panel-portal-check.mjs`、`client-check.mjs` | 只读快照契约（任务/席位/待办/摘要截断，74 项）、坏 JSON 降级、`/panel` 与 `?view=archived` 路由、`/state` 不回归；动作/执行器/归档（allowed_actions、参数透传与 confirm 闸、`_trash` 恢复/删除、pins 写，99 项）；客户端入口与 18 个 chunk 的装载契约（经典脚本、`require.async`、`load({id,chunk,factory})`、行数只作报告不判红）与桩 React 渲染/点击（30 项）；面板头部「批量 / 归档」点击回归（`rootRef` 缺失不得关面板、按钮自身 stopPropagation，旧代码 8/11 → 现 11/11，14 项）；弹层 portal 到 `document.body` + fixed 落点与回退（3 项） |
| 预设与真机 | `p11-presets-check.mjs`、`p12-*`、`e-route-check.mjs` | 16 个角色预设与 shipped/schema 对形；需要 `DSH_APP_ASAR` |
| 文件规模体检 | `file-size-check.mjs` | `CONVENTIONS §4.1`：**只报告，不是闸** —— 列出超过预警线（400 行）的文件与最大文件，**永远全绿、不判红、不设基线/登记表**（为拆而拆没有意义；拆不拆按 §4 四问判断）。设计见 `design/conventions/01-文件规模体检.md`（7 项） |
| 文件规模提醒 | `size-reminder-check.mjs` | `CONVENTIONS §4.2`：文件 **>150 / >300 / ≥400** 三档由**程序自动发起**询问（注入成用户消息）——「有必要写这么大吗？顺手还是功能需求」→ 同一句再问 → 第三次要求「一定这个写法吗？有没有更优的写法」并实际调用 `web_search` / `web_fetch`。钉住阈值/文案/过滤/去重/注入形状（20 项） |
| 修复批次（2026-10-18） | `f24-browser-profile-guard-check.mjs`、`f25-hashgate-attribution-check.mjs`、`f26-liveness-approval-check.mjs` | 长单实测反馈的三处判据缺口：①浏览器 Profile/凭证不得进工作区（写类工具 + shell 复制都拦，`security_check` 一等命中）；②hash 闸门区分「基线已有他人文件」与「本次新增未声明」（`foreign_paths_ack` 归属确认，不能洗自己/越界）；③liveness 识别「在等审批」而不是误判失联（`awaiting_approval`，不冻结；真死照旧判）（33 + 25 + 40 项） |
| P2 批次（2026-10-18） | `f27-pipeline-wait-check.mjs`、`f28-p2-polish-check.mjs` | ①新增 `pipeline_wait` 只读长轮询（等到状态/事件，替代 sleep 轮询；非法参数立刻拒、超时给完整状态、不改任务，43 项）；②四级小修：`human_relay` 照抄块真实换行、`pipeline_demo confirm` 参数文档、`pipeline_status fields` 可用键清单 + 大体积提示、拒绝文案补"允许的替代形态"（27 项） |
| P1-18 批次（2026-10-18） | `f29-artifact-matrix-check.mjs` | 按档位的产物矩阵（L0–L5 必需产物）+ `deferred_artifacts` 豁免：理由必填、批准人只能 `user`/`supervisor`（supervisor 仅 L4+），测试/审核/安全类不可豁免；关单缺产物且未豁免才拒；`pipeline_status` 显示"必需/已交/已豁免（理由、批准人）"（43 项） |
| P1-10 批次（2026-10-18） | `f30-artifact-snapshot-check.mjs` | 制品 = 整体交付快照：`files+sha256` 登记算 `snapshot_id`、逐文件校验；`action:"verify"` 重算并写回；L3+ 关单要求当前制品快照完整（L0–L2 不强制，legacy 只拦关单）（32 项） |
| P1-7/8 批次（2026-10-18） | `f31-demo-stage-check.mjs`、`f32-demo-submit-check.mjs` | DEMO 显式阶段（`demo_building` / `demo_review` + 四条迁移边；L3+ 必经、L2 可跳过；round 请求必须本轮创建/已答复/未被消费；旧单兼容）+ `pipeline_demo_submit`（writer/architect/diagrammer 交付 DEMO 交付物，`pipeline_demo` 仍 main 专用；plan 自检拒收矛盾计划）（35 + 21 项） |
| backlog 批次（2026-10-19） | `f33-demo-request-check.mjs`、`f34-ghost-role-check.mjs` | DEMO 审阅请求的生产通道（`pipeline_demo round` 自动建 `demo_review` 请求 → relay/reply → confirm，显式 id 沿用旧判据）+ 状态机投影过滤（不在册角色不展示事件；supervisor 仅 hub 启用且在册；原始边表不变）（23 + 18 项） |
| P2-13 第一步（2026-10-19） | `f35-status-paging-check.mjs` | `pipeline_status` 大对象分页（`page`/`page_size`；不传 page 逐字节不变；越界不报错）+ 只读 `storage` 体积诊断（task.json/baseline/artifacts，>1 MiB 提示分页/fields/detail=summary；顺带修好旧体积提示在生产里从不触发的坑）（27 项） |
| P2-13 第二步（2026-10-19） | `f36-history-archive-check.mjs` | history 超 700 触发、`task.json` 只留最近 500 条；更早条目**原样逐条**归档到 `archive/history-<seq>.jsonl`（不删数据）；失败不裁剪并留 `archive:failed`；status 显示归档摘要（24 项） |
| 回归专项 | `f1`–`f36`、`p1`–`p16`、`m1`–`m11` 等 | 每轮缺陷的判据化回归（一个缺陷一个套件） |

报告落到 `tests/last-run.txt`。

**全程零副作用**：不创建任何真实会话（走 `SimulatedTransport` 内存假会话），
临时目录跑完即删。

装完之后也可以在对话里直接调 `pipeline_selftest`，同一份内核当场跑一遍。

生成一份可翻阅的实物样例：

```powershell
node examples\run-example.mjs
```

产物在 `examples/demo-project/`（含 `task.json`、4 份交接物、审计流水）与
`examples/example-refusal.txt`（4 条拒绝原文）。

---

## 操作口径（跑长单之前先看）

> 来源：2026-10-18 用本流水线跑一张 L5 单之后的复盘（`内部复盘（2026-10-18，不公开）`）。
> 这些是**操作建议**，不是缺陷判据 —— 但按它们做，能少踩已经踩过的坑。

1. **`ask` 审批策略与全自动长单不兼容**：席位会在审批卡上"静止"，而 liveness 在这种场景下可能
   误判失联（P1-4 正在修）。全自动跑长单请用 `never`（或在有修好的审批态识别之后再开 `ask`）。
2. **`user_quote` 可被复用**：你一句"不用问我，按推荐走"，主对话就能拿它回答后面**所有**人工请求
   （含 DEMO 确认）——这是机制允许的。想保留否决权，就别给 blanket 授权，逐条回。
3. **交付根以守门的 scope 根为准**：`pipeline_status` / 计划里的 `change_scope` 显示的路径才是
   席位真正写入的位置；不要只看 `projects/<task_id>/`（那可能是"版本目录"的壳）。
4. **DSH 重启 = 本进程的角色令牌作废**（含主对话）：重启后先 `pipeline_task_open { reattach: true }`，
   再 dispatch；顺序反了会先撞"没有身份"。
5. **测试席位的浏览器 profile 是真实数据**：`reports/tester/edge-*` 里有 Cookies / Login Data 等；
   收尾必须清理（P0-2 修复后，把它们复制进工作区会被守门拦下）。清理只删**本单的临时残留**。
6. **L5 不要贪**：一个静态页/小工具用 L2/L3 就够；L5 会拉满 10 个角色、产物矩阵大一倍以上，
   其中仪式性产物现在可以用 `deferred_artifacts` 豁免（理由 + 人/主管批准，P1-18）。

### 旧单兼容（2026-10-18 这批改动之后）

- **DEMO 阶段（P1-7）**：只有**从「计划中」出发**的新单才可能进入 `demo_building/demo_review`；
  已经到 `ready_dev` 及之后的旧单不受影响（旧状态 `demo_confirm` 与旧事件保留兼容边）。
- **产物矩阵（P1-18）**：L0–L3 不受新矩阵影响；L4/L5 旧单若在册角色没交产物，关单会多报一条
  `MISSING_ROLE_PRODUCT`（原来由 `MISSING_DIAGRAM` 拦，结论不变、文案更全）。补交产物，
  或在计划阶段就写 `deferred_artifacts`（旧单只能重交计划或用 `pipeline_scope_amend` 的既有通道）。
- **制品快照（P1-10）**：L3+ 旧单的制品登记没有 `snapshot` ⇒ 关单会要求"重新登记带 `files` 的快照，
  或先 `pipeline_artifact {action:"verify"}` 看明细"。L0–L2 不强制；legacy 数据不改写。
- **工具数 36→38**：新增 `pipeline_wait`（只读长轮询）与 `pipeline_demo_submit`（交付席位交 DEMO）；
  其它工具的调用形状未变。
- **history 归档（P2-13）**：单张任务 history 超过 700 条后，更早条目**原样逐条**归档到
  `.pipeline/<任务>/archive/history-*.jsonl`（不删除、可追溯），`task.json` 只留最近 500 条；
  `pipeline_status` 的 storage 行显示「归档 N 文件 / M 条（窗口 500）」——看全量历史去归档文件里取。

---

## 已知限制

1. **重启后才生效。** Host 半边插件在 DSH 启动时装载。
2. **同步索引的空窗期**（见上文「拦不住的」第 4 条）。
3. **shell 侧是 best-effort**（见第 2 条）。
4. **`defineTool` 退化路径。** 解析不到 `@deepseek-ai/dsh-tools` 时，
   `defineTool` 退化成恒等函数 —— 插件仍激活、工具仍注册，但**参数校验交给注册表**，
   且参数不会在进入 `execute` 前被规范化。日志里会打 warn。
   本机实测：正常路径（解析成功）。
5. **`pipeline_selftest` 会在临时目录里跑。** 它不碰你的项目，但会在 `%TEMP%` 下建目录
   （跑完删）。审批策略把它当普通工具调用。
6. **L0 配置下角色变更复核路径不可达。** L0 的清单里没有 orchestrator，
   而 `pipeline_roster_review` 只有 orchestrator 能调 —— 所以 L0 任务想加角色时，
   先去 `pipeline_orchestrate` 请求升档（会得到"需要独立编排对话"的拒绝），
   再 `pipeline_dispatch { role: "orchestrator" }` 把它拉进清单即可。
   自测里 §「反例④」把这条限制显式记成了一条断言，没有藏起来。
7. **打包不带上 `node_modules`。** `tests/schema-check.mjs` 依赖一棵 vendored 的
   `dsh-tools/lib/types/schema.js`（在工作区根的 `node_modules/` 下）才能用真编译器校验。
   拷不到时会**明确报"跳过、这不算通过"**，不会假装绿。
   这不影响装完之后的 `pipeline_selftest` —— 那套（67 项）用的是插件自己的代码，
   在"已安装形态"下实测过是 67/67。
8. **右上角那个按钮没有在真实浏览器里验过。** 本机没有截图能力，所以只验到了：
   装载契约（经典脚本 + `__ModuleLoader__.load`）、挂载契约（挂到哪个槽、带什么 spec）、
   入口与 18 个 `client.panel-*.js` chunk 的一一对应，以及「按职责拆、文件大小是信号不是死限」的拆分纪律，
   以及用**桩 React** 跑出来的渲染与点击行为（`tests/client-check.mjs`，30 项）。
   **没验**：真实排版与像素位置、真实点击、与宿主主题的视觉协调。
   组件用纯内联样式、不读宿主 CSS 变量，所以「长得不好看」的风险大于「不显示」的风险。
9. **开关的 HTTP 端点只有环回保护**，没有 CSRF token。依赖"端口只绑定环回"这个前提。
   `webServer` 对外监听时请设 `switchRoute: false`（那时 UI 按钮会显示"未知"，
   开关改用 `pipeline_switch` 工具翻）。
10. **开关状态按项目根存放**（`<项目根>/.pipeline/switch.json`）。
    不同项目根 = 不同开关文件。要全局统一就配 `switchStateFile` 指向一个固定路径。
11. **关掉开关不删数据、不停任务。** 关掉时正在跑的任务就停在那儿；
    重新打开后可以接着走（状态机不认时间，只认状态与交接物）。

---

## 待确认项（规格里没定的，我**没有**替你拍板）

需求原文末尾列了 8 个风险与待确认项。下面逐条说明**本插件给出的机制**与
**仍然需要你决定的部分**。

| # | 问题 | 本插件的机制 | 仍需你决定 |
|---|---|---|---|
| 1 | 对话之间怎么通信？ | 做成可插拔通道（`subagent` / `manual`），默认 `auto`。manual 下渲染可粘贴的派活单 | 你的环境里哪种更合适？要不要接消息队列 / 任务板？ |
| 2 | 怎么保证主对话不偷看代码？ | 守门按**角色 + 路径**拦文件工具与 shell；`pipeline_status` 默认返回**脱敏摘要**（补丁正文、失败日志、运行命令一律隐去） | 脱敏字段够不够？要不要连"变更说明"也隐去？ |
| 3 | 测试环境谁提供？ | 未实现。测试角色拿到的是一份 `run_commands`，跑在它自己的会话环境里 | 需要专门的测试沙箱吗？还是就复用当前工作目录？ |
| 4 | 审核 OK 的标准格式？ | 已固化成 `review_verdict` 的固定字段（`conclusion` / `risk_notes` / `release_approved` / `final_delivery_note` / `acceptance_check`） | 是否要加签名字段、版本号、CI 流水线 URL？ |
| 5 | 单个任务最多允许打回几次？ | `maxReworkPerLeg`（默认 **2**），按"打回编写"与"打回测试"**分别**计数；超限即拒并给出替代出路（block 交人工 / 申请仲裁角色） | 默认 2 合适吗？要不要按档位区分（L3/L4 给更多预算）？ |
| 6 | 哪些节点需要人工介入？ | 异常出口 `block` / `unblock` / `cancel` 由 `human` 或主对话触发；打回预算用尽、`security` 报 `blocked:true` 时应转人工 | 要不要在某些档位**强制**人工卡点（例如 L4 关单前必须人工放行）？ |
| 7 | 代码和测试报告存在哪？ | `<项目根>/.pipeline/<taskId>/{artifacts/vN, handoffs, reports, audit.jsonl}` | 目录名/位置要改吗？要不要接到外部制品库？ |
| 8 | 要不要权限控制防越权？ | 角色令牌 + 会话二次绑定 + 单调守门（见[守门](#守门哪些是真拦截哪些只是约定)） | 要不要开 `requireAgentBinding: true`（更严，但**要求走真实子代理通道**）？ |

### ★ 设计目的带来的**待拍板**清单（本轮新增，我**没有**替你决定）

用户本轮补的设计目的是「编程别跑测试，编排别看代码」。其中**没有歧义**的部分
已经执法（见 [设计目的](#-设计目的本项目的目标函数先读这一节) 与 `tests/boundary-check.mjs`），
下面三条**互相冲突**，我按"先执法没歧义的、冲突的列出来"处理：

| # | 冲突点 | 现状（我做到的） | 需要你拍板 |
|---|---|---|---|
| P1 | **"自测的最小限度"到哪**：`writer` 的 summary 与 `dev_to_test` 的固定字段里都有「**自测结果**」（`selftest_result`），而设计目的说"编程别跑测试" | 只拦**明确的测试执行**（`npm test` / `pytest` / `node --test` / `node tests/x.mjs` / `--coverage`…）；**放行**构建/启动级冒烟（`npm run build` / `node build.mjs` / `node -e …` / `tsc --noEmit`） | ① 冒烟算不算"测试"？② 要不要**连冒烟一起拦**？③ `selftest_result` 字段是保留（改叫"构建/冒烟结果"）、还是删掉？④ 若保留，是否允许它写"通过/不通过"这类**判定词**？ |
| P2 | **`writer` 能不能读 `tests/` 目录**：设计目的说的是"别**跑**测试"，读测试目录没被点名 | 现在**不拦**（读源码树对 `writer` 一向允许，它只受 `scope_paths` 分区约束） | 要不要把"读测试目录/测试文件"也划出 `writer` 的权限？（拦了会更彻底，但 `writer` 就没法照着已有用例改实现） |
| P3 | **`pipeline_selftest` 算不算"跑测试"**：它跑的是**插件自己**的自检（工具定义、守门行为），不是项目测试 | 现在**谁都能调**（包括 `writer`）；它不碰项目制品、跑在临时目录 | 要不要限制给主对话/人工？（我认为它是"插件体检"，与项目测试无关，所以**没有**动） |
| P4 | **L0 没有"计划"这一站 ⇒ 没有授权改动面**：`change_scope` 是计划给的，而 L0 由规则引擎自批 | L0 任务上「改动面 = 授权面」这条判据**整体弃权**（不是放行，是那段判据不存在），并且 `pipeline_status` 会明写"无授权面" | ① L0 要不要也强制一张授权面（谁来给？规则引擎？）② 还是给 L0 也加一个"微型计划"？③ 或者接受"L0 单文件级改动本来就不需要改动面"？ |
| P5 | **授权的粒度**：`change_scope` 的 `path` 可以是**文件**也可以是**目录**（授权目录 = 授权它底下的改动，含在其中新建） | 目录授权是放行的（那正是"改这个模块"的自然含义）；`create` 授权**只**给新建，改已存在文件会被拒 | 要不要强制**逐文件**授权（更严，但计划会变成一份台账）？还是保持"目录级 + create/modify/delete 语义"？ |
| P6 | **中途加人 = 加一张新边界卡**：`pipeline_roster_review` 批准加人时必须顺带给新角色的 `role_boundaries` | 不给就拒（`ROSTER_APPLY_FAILED`，申请退回 pending 可重批） | 认可这个额外要求吗？（替代方案：批准后强制让计划 AI 重出一份计划 —— 更重，但边界卡与计划始终同源） |
| ~~P7~~ | ~~`tester` 要不要也收紧~~ | **已按你的话拍板并做掉**：`tester` → `own-dir`（只写 `reports/tester/` 下自己的产物/日志），源码**只读** | —— |
| P8 | **基线的重取权限**：现在只有计划 AI / 主对话能 `pipeline_change_audit { take: true }` 重设基准 | 编写不能重设（否则可以洗掉越界痕迹）；重取会留痕 | 要不要更严（例如重取必须走人工确认）？或者反过来——允许 writer 在自己重跑后重取？ |
| ~~P9~~ | ~~把边界清单导给另一条钩子线~~ | **已撤回**：用户明确「安排写入多 ai 协同插件中去，而不是新写」—— 拦截就做在本插件里（见上一节）。`pipeline_boundaries` 保留为**只读可审计导出**，不是执法依赖 | —— |
| P10 | **要不要也挂 `Stop`（回合结束）缝**：现在挂了前置 / 提示词 / 后置三条；`Stop` 的契约要求构造宿主内部的 agent 消息（桥接里用的是 harness 的 `createUserMessage`），插件不在那个模块里 | 没挂 `Stop` ⇒ "席位没交产物就想收工"这件事目前没有硬拦（只有四问引导 + 状态机的"跳步"拦） | ① 保持（不猜宿主内部消息形状）？② 还是让插件 import harness 的消息工厂来挂 `Stop`（多一个宿主内部依赖）？ |
| P11 | **自定义测试入口认不出**：`make test` / `npm run check` 这类名字不在判据里 ⇒ **弃权**（宁可漏判也不误拦） | 这类命令不会被这条链管（但审核看 `what_will_run` 仍能兜住） | ① 保持弃权？② 还是让项目声明一份"自定义测试入口"清单（写在需求档或计划里），让判据认得出？ |
| P12 | **凭据是一次性的**：批准的那条命令能跑，但**不自动失效**、也不绑定轮次 | 跑完不会自动作废；下一轮改动之后仍可复用（除非重新提链） | ① 加**有效期**（例如 24h）？② 还是加**轮次绑定**（制品版本一变就失效，必须重走链）？③ 或保持现状（凭据代表"这件事被批准过"）？ |
| ~~P13~~ | ~~闸门不通过要不要消耗打回预算~~ | **已按你的话拍板并做掉（2026-10-11）**：**不扣预算**（保持现状），但**连续 N 次不过就自动交人工**。`N` 默认 **3**，开关是 `hashGateEscalateAfter`（与 `guardHashGate` 并列）；**`0` = 关掉自动升级**。归零点写死：**只有一次闸门真通过**（或用户答复了本机制发出的那条人工请求）才归零，**撤回不归零**。升级走**既有**的 `human_request` / 两级梯，且答复前**拒收**重交。见上文「连续 N 次不过 ⇒ 自动交人工」与 `tests/hashgate-check.mjs` 的 C/D/E 三组（22 条） | —— |

> 这几项一旦拍板，改动点都很小：P1/P2 在 `lib/guard.js` 的 `scanTestRunnerCommand` 与
> `guardWriterRunsTests` 配置；P1 的字段问题在 `lib/handoff.js` 的 `dev_to_test` schema
> 与 `lib/roles.js` 的 `writer.summary`（那里已经标注了这条待拍板）；
> P4/P5 在 `lib/handoff.js` 的 `validateChangeScope` 与 `lib/guard.js` 的改动面判据；
> P6 在 `lib/store.js` 的 `reviewRosterChange`；P8 在 `pipeline_change_audit` 的 `take` 权限；
> P9 在 `lib/boundaries.js`（加一个运行时快照导出即可）。
> **P13 已拍板并落地**：`hashGateEscalateAfter` 在 `lib/config.js`，语义在 `lib/hashgate.js`，
> 执法在 `lib/store.js`（`escalateHashGate` + 提交前的 `HASH_GATE_ESCALATED` 拒收）；
> 本次**没有**新增待拍板项（P13 的取舍没有牵出新的歧义）。

### 另外一条：规格自身的歧义（我做了取舍，**可以一句话翻回来**）

需求原文里这两句互相拉扯：

- 「最少 4 个独立对话：主对话、编写、测试、审核」
- 「推荐起步 5 个：在四角色外增加「需求分析/编排判断对话」」
- 分档表：「L0 极简脚本 = 4（主/编写/测试/审核）」

**L0 到底有没有独立的编排对话？** 本插件的取舍：

> L0 的「编排判断」**依然发生**，但执行者不是另一个 AI 会话，而是 `lib/tiers.js` 里的
> **确定性规则引擎**。这就是 `orchestrator_mode: "rule-engine"`。
>
> 为什么这不算"主对话自己判断"：主对话只能**调用**引擎，既不能改引擎的结论，
> 也不能手写角色清单。引擎要输出 L0，需求必须先通过一组**保守的**平凡性判据；
> 任何一条不满足，引擎直接拒绝自批 L0，**强制升到 L1** —— 也就是"复杂需求不漏配"。
> 反过来，引擎判 L0 时主对话也抬不到 L4 —— 也就是"简单需求不超配"。

要翻回来（让 L0 也必须是 5 个独立对话）：配置 `l0OrchestratorSeparate: true`，
或安装时加 `-L0OrchestratorSeparate`。这条路径自测里也验过（拒绝文案会明说）。

---

## 排障

**装了但工具没出现？**

1. 重启 DSH 了吗（Host 插件不热更）
2. 日志里有没有 `[pipeline] dsh-pipeline ... 已加载 ...`
3. `enabled` 是不是被设成了 `false`
4. 检查 `<profile>\package.json` 的 `dsh.profile.bundles` 里有没有 `dsh-pipeline`

**守门太严，误伤了正常操作？**

配置里逐个关：

```yaml
- id: dsh-pipeline
  config:
    guardMainReadsCode: false      # 不拦"主对话读代码"
    guardShellTools: []            # 关掉整个 shell 旁路判定（文件工具那层保留）
    guardFileTools:
      write: ['write', 'edit']     # 只对这些工具名做路径判定
    guardEnabled: false            # 整个守门关掉（**明确降级**，日志会写"没有硬拦截"）
```

**某个任务卡住不动了？**

```
pipeline_status { task_id: "T-...", include_audit: true }
```

它会列出**当前状态下所有合法事件**以及各自允许的角色，一眼看出卡在哪。
状态卡死且打回预算用尽时，出路是 `pipeline_transition { event: "block" }` 交人工，
或让编排复核后追加仲裁角色。

**想确认机制是不是真在生效？**

```
pipeline_selftest
```

它会把每条拒绝原文打出来。看到"角色越权被拦下""拒绝关单"这类字样就是真的在拦；
如果全是 ✓ 但你怀疑它没跑，看报告里每条的 `拦截层` ——
`guard` / `execute` 是真的被拦了，`missing` 是"工具压根没注册"（那不算通过）。

---

## ★ 第九轮追加（本轮）：需求分析 / 计划 / 澄清前置 / 按层分工

> 这一节是**增量说明**，覆盖上面几节里与它冲突的表述（尤其是"编排判断"这个词）。
> 完整取舍理由见 `REPORT.md` 第十八节。

### 一、角色：`orchestrator` 与 `planner` 是**两个**角色（14 个）

| 角色 | 中文名 | 干什么 | **不干什么** |
|---|---|---|---|
| `orchestrator` | **需求分析** | 第 1 轮分析：任务卡 / 验收标准 / 边界条件 / 测试要点 + **「需求不清楚处」清单** | **不分配 AI**（不再接 `tier`，传了就拒） |
| `planner` | **计划** | 接**用户确认过**的需求 → 出计划 → **自检有无缺失** → 无缺失才**分配 AI**（档位 / 几个独立对话 / 角色清单 / 顺序 / 编写席位与层分工） | 自检有缺失时**不分配**，只能回流 |

- `orchestrator` 仍然是**两级澄清梯的第一级**（执行/顾问角色答不了的问题先问它）。
- `planner` 也在第一级白名单里 —— 它的「计划自检发现缺失」**就是**退回需求分析。
- 分配权跟着职责走：角色变更复核（`pipeline_roster_review`）、继任指派（`pipeline_succession`）、
  `relayPolicy`、编写席位方案，**全部归 `planner`**。

### 二、状态：多了两站（正常链变成 12 站）

```
待分配 → 需求分析中 → 待计划 → 计划中 → 待开发 → 开发中 → 待测试 → 测试中
       → 待审核 → 审核中 → 已通过 → 已关闭
```

| 状态 | 谁在干活 | 为什么单独一站 |
|---|---|---|
| `ready_plan`（待计划） | 主对话 | "活儿还没切"与"活儿已切好只等派"是两件不同的事；并起来就答不出"该催计划还是催编写" |
| `planning`（计划中） | planner | 计划 + 自检 + 分配是同一个人一口气做完的一段 |

### 三、开工前的**强制**顺序（四步，一步都不能跳）

```
① pipeline_orchestrate   需求分析出结论（含 unclear_points 清单）
② pipeline_human_request 把不清楚处提交主对话 → 转告**用户** → 用户答复
③ pipeline_transition    event=requirement_confirmed（**没有用户答复这条边过不去**）
④ pipeline_plan          计划 → 自检 → 分配 AI（角色清单）
```

- 第 ③ 步的判据（guard `requirement_confirm_gate`）读的是既有的 `human_requests` 记录，
  要求那条 `reason_kind=requirement_confirmation` 的请求 **`status='answered'`**。
  **只认答复，不认转告** —— 转告只证明"话带到了"。
- **为什么不新开状态**：这一段与既有 `human_request` 链**完全同构**（提交 → 转告 → 答复 → 恢复），
  差别只在"问的是什么"，而那件事由 `reason_kind` 一个数据字段回答就够了。
  单开状态会制造第二套并行的人工通道，而拓扑上用户只与主对话相连，通道本来只有一条。

### 四、计划缺失回流（**沿用**两级梯，没有另起一套）

```
planner 自检 verdict=gaps
   → plan 交接物自带 gap_stage / gap_question / gap_context
   → 状态推到「等待需求分析答复」（= 第一级的那个等待态）
   → 需求分析 pipeline_clarify_reply
        · answered       → 状态回到「计划中」，planner 重出计划
        · cannot_answer  → 由需求分析 pipeline_human_request 升级给用户（带三个溯源字段）
```

**"自检没过就不许分配"** 落在两处（同一条判据、同一份数据）：`setRoster(judgedBy='planner')`
的开头，以及状态机的 `plan_ready` guard。任何调用路径都绕不过去。

### 五、编写按**层**分工，席位 3 → 6

- 默认层清单：**接口层（`interface`）/ 数据层（`data`）/ 处理层（`logic`）**；
  由 planner 按项目裁剪或扩展（`writers.layers`）。
- **席位数 = 层数**（`count === layers.length`）：一个层一个席位，
  给了对不上的 `count` 直接拒；多席位不给层也拒。
- 每条分区带 `layer`，**同时**带 `scope_paths` ——
  **按层分工不取消路径执法**：层说"负责哪一层"，路径说"能写哪里"。
- `count=1` 是**同一套机制的退化情形**：层清单退化成 `['all']`，范围整棵项目根，
  走同一份 `buildWriters`、同一套越界判据。
- 上限：`MAX_WRITER_SEATS = 6`（L0 仍 1，L1 = 3，L2~L5 = 6）。
  为什么是 6：默认 3 层 × （按层拆 + 每层再拆前后端）= 6；再往上协调成本超过并行收益，
  而"全部席位到齐才推进"这条规矩会让等待时间线性变长。

### 六、工具面（**29 个**）

新增 1 个：**`pipeline_plan`**（【计划 AI 专用】出计划 → 自检 → 分配 AI）。

```
pipeline_plan {
  task_id, plan_steps[], layers[{layer, scope_paths[], deliverables[]}],
  self_check_verdict: 'ok'|'gaps', self_check_checked[], self_check_gaps[],
  gap_stage?, gap_question?, gap_context?, gap_urgency?,        # verdict=gaps 时必填
  plan_reason, risks[],
  tier, reason, extra_roles[], writers{layers[], partitions[], reason}, relay_policy,   # verdict=ok 时才用得到
  acceptance[], test_points[], boundaries[], role_token
}
→ { ok, summary, tier, ai_count, roles, sequence, allocated }
```

改动 1 个：`pipeline_orchestrate` **收窄成只做需求分析**：

```
pipeline_orchestrate {
  task_id, acceptance[], test_points[], boundaries[],
  unclear_points[],        # ★ 必填（没有就给空数组 —— 那也是一个必须显式回答的结论）
  open_assumptions[], analysis_reason, task_card?,
  tier?, ...               # 只有 L0（主对话 + 规则引擎）还用得到
}
```

### 七、新交接物（2 种）与受限字段

| kind | 方向 | 关键字段 |
|---|---|---|
| `requirement_analysis` | `orchestrator` → 主/plan | `acceptance` `test_points` `boundaries` **`unclear_points`**（必填）`open_assumptions` `analysis_reason` |
| `plan` | `planner` → 主 | `plan_steps` `layers` **`self_check`** `gap_*`（gaps 时必填）`plan_reason` |

- `orchestration.from`：`['orchestrator']` → **`['planner']`**。
- `HUMAN_REASON_KINDS` 新增 **`requirement_confirmation`**（澄清前置那一步用的）。
- `dev_to_test.partition` 新增 **`layer`**。

### 八、这一轮**没有**动的东西

三权分立单向链 / `review_ok` 唯一入口 / 关单三闸 / `scope_paths` 越界写执法 /
"全部席位到齐才推进" / 水位 45-55-65 与继任流程 / L0 由规则引擎自批 /
需求档唯一写者仍是留档 AI —— **一条都没改**。
继任只是把"执行继任的人"从 `orchestrator` 换成 `planner`（分配权换了持有者，职权跟着职责走）。

### 十、★ 设计目的（同批追加）：防过度工程化 = 只干自己该干的

用户在同批里补了本项目的**目标函数**，分三次说完，共**六条规则**：

> 「分开跑项目的目的是让 ai 别过度工程化，要求只干自己该干的，
> **编程别跑测试，编排别看代码**」
>
> 「还有如**修一个 bug 就别该整个模块**，分析和计划 ai **确认他们只干什么，不要多干**」
>
> 「**审核 ai 要一起配合确认有没有多改**……**审核 ai 只读，只有属于他的日志文件有权限写入**」

它落成六条**机器可执法**的边界（不是提示词里劝一句，完整说明见开头
[设计目的](#-设计目的本项目的目标函数先读这一节) 一节）：

| 规则 | 执法点 | 自测 |
|---|---|---|
| ① **编写不跑测试** | 守门拦测试类命令（`scanTestRunnerCommand`）；白名单里没有测试类交接物；`dev_to_test` 不许夹带测试结论字段 | `boundary-check` ①（18 条） |
| ② **控制角色不看代码** | `NO_CODE_READ_ROLES` = 主对话 / 需求分析 / 计划：读工具 + 检索工具 + shell 三道；产物含代码正文即拒收 | `boundary-check` ②（18 条） |
| ③ **最小改动**（改动面 = 授权面） | 计划的 `change_scope` + 守门逐条核对写入（含新增文件）；`dev_to_test.change_manifest` 每条引用一个授权；越界时审核不得出结论 | `scope-check` A（15 条） |
| ④ **职责自限**（只干什么，不要多干） | `role_scope` 必填；需求分析产物里出现分配内容即拒；计划必须为每个执行角色写边界卡，派活按它派 | `scope-check` B（13 条） |
| ⑤ **双轨派活** | 计划一出，编写与审核**同时**接任务；审核的开工前简报里带授权面 / 越界清单 / 边界卡 / 基线；但**不能提前出结论** | `review-check` A（12 条） |
| ⑥ **审核只读 + 前后版本对比** | `writes: 'own-log'`（只有自己的日志可写）；`pipeline_change_audit` 按基线哈希对比；`review_verdict.change_audit` 必填且 store 重算核对 | `review-check` B/C/D（31 条） |
| ★ **白名单方向**（贯穿六条） | `roles.handoffKinds` + 守门两张表 —— 只写"谁能做" | `boundary-check` ③（6 条） |

⚠️ **十三项待你拍板**（详见下文「待确认项」一节的 P1~P13；其中 **P7 / P9 / P13 已拍板并做掉**，现挂 **P1~P6、P8、P10~P12** 共 10 项）：
`writer` 的「自测」与"编程别跑测试"直接冲突（P1）、`writer` 能不能读 `tests/` 没被点名（P2）、
`pipeline_selftest` 算不算跑测试（P3）、**L0 没有授权改动面**（P4）、
授权粒度是文件还是目录（P5）、中途加人要不要顺带给边界卡（P6）。
**我没有替你决定**，只先执法了没有歧义的那半。

### 九、自测

`node tests/run-all.mjs` → **十八套，723/723 通过**（连跑三次结果一致，exit 0）
（本批新增 `tests/plan-check.mjs` 44 条 + `tests/boundary-check.mjs` 42 条
+ `tests/scope-check.mjs` 28 条 + `tests/review-check.mjs` 51 条 + `tests/intercept-check.mjs` 24 条 + `tests/fulltest-check.mjs` 44 条 + `tests/hashgate-check.mjs` **61 条**）。
