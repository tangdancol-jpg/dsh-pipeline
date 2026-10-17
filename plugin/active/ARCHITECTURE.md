# dsh-pipeline · 架构物料

> 这份文件是**画架构图的原料**：分层、节点清单、边清单，全部中文标签，
> 每条边都标明类型与触发条件。拿去喂 drawio / mermaid / archify 都能直接用。

---

## ★ 零·零、设计目的（**目标函数**：画图前先读）

> **用户原话：**
> 「分开跑项目的目的是让 ai 别过度工程化，要求只干自己该干的，
> **编程别跑测试，编排别看代码**」
>
> 「还有如**修一个 bug 就别该整个模块**，分析和计划 ai **确认他们只干什么，不要多干**」
>
> 「**审核 ai 要一起配合确认有没有多改**……**审核 ai 只读，只有属于他的日志文件有权限写入**」

这张图上的**每一条"不能"**（角色不能读什么 / 不能写什么 / 不能产出什么 / 不能改到哪里）
都不是流程装饰，它们合起来就是这一个目标：**用角色边界把过度工程化挡在门外**。
六条规则：① 编写不跑测试 ② 控制角色不看代码 ③ **改动面必须与授权面相等**
④ **职责自限**（分析与计划只干什么、不要多干；并为每个角色写死边界卡）
⑤ **双轨派活**（编写与审核同时接任务；审核开工前就拿到判据）
⑥ **审核只读 + 前后版本对比**（只有自己的日志可写；靠基线哈希对比确认有没有多改）。

**★ 总原则（比上面六条更上一层）：**

> 「**ai 的行为不要靠自然语言限制，要靠代码层直接拦截**」

它落成**两条缝、一份判据**：
· `ctx.tools.guard`（工具服务那条路，靠令牌/会话绑定认人）；
· 宿主的**拦截扩展点** `tools/pre-execute` / `agent/pre-step` / `tools/post-execute`
  （按"这个会话是不是本插件派出去的管线席位"认人，**只对管线席位生效**，其余直通）。
两条缝调用**同一个** `guard(exec)` —— 判据只有一份，所以不会漂移。
Stop Ladder 四问由插件自带（`skills/stop-ladder/SKILL.md`）并由代码注入到席位上下文；
**四问是引导，拦截是代码**，两者都要有。

**哈希前置闸门**排在**一切测试之前**：交产物时先按派活基线做逐文件哈希对比（新增/修改/删除三类），
不通过 ⇒ **直接打回编写**，不进测试、不消耗测试预算、不进全量审批链 —— 画图时它是"提交"之后**第一道**边，
在"跑测试"之前。**不合格的提交不该消耗测试资源。**

同一条闸上还挂着**连续不过的计数**（`task.hash_gate_streak`，只有"闸门真通过"才归零）：
**连续 `hashGateEscalateAfter` 次（默认 3）不通过 ⇒ 机制自动交人工**
（走既有的 `human_request` / 两级梯，`reason_kind=hash_gate_escalation`）。
画图时这是一条 **"提交 → 人工"的异常边**（只在计数到阈值时才走），
并且升级之后**同一条"提交"边会被拒收**（`HASH_GATE_ESCALATED`）直到用户答复 ——
也就是"提交"这条边在那一刻**暂时不存在**。

**全量测试审批链**是同一套目标函数的延伸：默认只跑**定向/增量**（按改动面挑用例），
跑**整套**要四级点头（需求分析 → 审核 → 用户人工 → 计划），守门按"批准的那条命令"放行。
画图时注意与**澄清梯**的区别：澄清梯问"需求清不清楚"，这条链问"这套测试值不值得跑"。

所以这张图上任何一条"不能"，都必须能落到**一处的代码**上：
守门（`lib/guard.js` 的 `execute`）、状态机（`lib/states.js` 的迁移表 + `lib/store.js` 的
前置条件）、或者 schema 校验（`lib/handoff.js`）。**落不到代码上的"不能"，不算这条图上的边**，
它属于下面这份诚实清单：

| 类别 | 含义 | 去处 |
|---|---|---|
| **(a) 已判据化** | 能指出"哪一行代码会因为它拒绝一次调用" | 画成图上的边（图例：实线 + 判据名） |
| **(b) 可判据化但尚未做** | 看得出来该怎么判，只是还没写 | **不许留在图上** —— 要么做掉，要么降级进 (c) |
| **(c) 判据化不了** | 主观的（别过度设计、计划要合理、写清楚…） | 画成**虚线 + 灰色注记**，并在图上注明"这条是愿望，不是边界" |

三张表的当前内容（33 条 (a) / 0 条 (b) / 8 条 (c)）见 `README.md` 的
[三类盘点](README.md#自然语言-vs-代码层三类盘点)；
它们的**机器可读版本**由只读子命令 `pipeline_boundaries` 导出
（`format=json`，含 `roles[]` / `rules[]` / `advisory_limits[]` / `unmapped[]` 漂移检查），
供 DSH 层的 `UserPromptSubmit` / `PreToolUse` 钩子复用 —— 那一层不需要读本插件源码。

画图时的三条硬要求：

1. **"不能"的边要画出来，而且要标判据名**。例如
   `编写 --✗ 跑测试--> 测试`（判据 `scanTestRunnerCommand`）、
   `需求分析/计划 --✗ 读源码--> 代码树`（判据 `NO_CODE_READ_ROLES`）。
   只画"谁能做什么"、不画"谁不能做什么"，这张图就丢了它的目标函数。
2. **同一条命令，不同角色结论不同**：`npm test` 由 `tester` 跑 → 放行；
   由 `writer` 跑 → 拦。图上要体现"拦的是**职责**，不是命令"。
3. **控制角色（主对话 / 需求分析 / 计划）到"代码树"的边**：
   全部是**禁行**，但到 `.pipeline/`（需求档 / 交接物 / 记录 / 摘要）的边是**允许**。
   这条分界是"它们凭什么在没读代码的前提下出计划"的答案：
   只吃需求档 + 验收标准与边界 + **只给路径不给正文**的目录结构。

> 可执法清单（41 条正反例）见 `tests/boundary-check.mjs`；
> 完整取舍见 `REPORT.md` 第十八节。

---

## 零、拓扑硬约束（画图前先看这一条）

```
        ┌──────────────────────────────────────────────────┐
        │  用户                                            │
        │  └─ 只有一个对话框 ──► 主对话会话                 │
        └──────────────────────────────────────────────────┘
                              ▲
                              │ 人工介入请求（唯一上升通道）
                              │
   ┌──────────────────────────┴───────────────────────────┐
   │  执行 / 顾问角色：编排 · 架构 · 安全 · 编写 · 测试 ·   │
   │                 审核 · 发布 · 文档 · 性能 · 仲裁      │
   │  ★ 它们与用户之间**没有边** —— 不是"不该连"，是没有线  │
   └──────────────────────────────────────────────────────┘
```

**画图时记住三件事：**

1. **用户只与主对话相连。** 执行/顾问角色到用户之间**不画边**
   （画了就错 —— 它们没有用户的对话框）。
2. **`main` 是唯一的转告者。** 它到用户是双向的（转告 + 听答复）。
3. **人工介入是单向上升、单向回落**：角色 → main → 用户，然后原路返回。
   角色之间不横向讨论人事，状态机也不接受"没答复就恢复"。

这条约束落到实现上就是一个状态（`awaiting_human`）+ 三个工具
（`pipeline_human_request` / `pipeline_human_relay` / `pipeline_human_reply`）
+ 一份 `human_request` 交接物 + 四步审计。

### 另外两条画图时必须遵守的

4. **编写可以被拆成 1~3 个席位**（`writer#1` / `writer#2` / `writer#3`）。
   画图时它们是**三个并列的编写节点**，各自带自己的范围标签；
   **它们之间没有边** —— 分区互不重叠，两个席位不直接通信，接缝由编排划界。
   `count=1` 时就是一个节点（同一套机制，只是只有一条分区）。
5. **架构图必须带回执**。`diagrammer` → `architecture_diagram` 这条边上，
   要么挂着 `diagram_deliver` 的收据（`receipt_path`），要么显式标 `degraded: true`。
   画图时建议在这条边旁标注 **"带收据 / 或标降级"** ——
   因为"没走闸门的图冒充走过闸门"会被拒，这是机制不是约定。
6. **★人工介入是两级梯，不是一条边。** 执行/顾问角色到用户之间**没有直连边** ——
   它们要问，先走 `clarification_request` 问**需求分析**；需求分析答不了才由**它**升级。
   画图时如果从 `writer`/`tester`/`reviewer` 直接画一条到 `user` 的边，**那是错的**。
   唯一的例外是 **L0**：那一档没有独立编排对话，执行角色直连 `main` 才是合法路径 ——
   画图时建议用**虚线**区分，并标注"仅 L0"。
7. **`awaiting_clarification`（等需求分析）与 `awaiting_human`（等用户）是两个状态**。
   画状态图时**不要合并**：前者主对话不用动，后者要转告、要催。
9. **★需求以本地档为准**，路径靠**目录约定**：`.pipeline/<taskId>/requirement.md`。
   **任务卡里不登记它**（每个 AI 只干自己的事 —— 谁需要谁自己去读）。
   **需求档不存在 / 版本不可追溯就不许分发任务**。
   ★ **分权落档**：各角色在 `records/<role>[-<seat>].md` 下写**自己那份**（互不覆盖），
   **留档 AI（archivist）**收集后汇总成唯一的 `requirement.md`。
   画图时：`requirement.md` 是**一个**公共节点（所有角色向它汇聚读），
   **写入边只从留档 AI 出发**；各角色 → `records/` 是另一组边。
10. **★分配 AI = 编排 AI（`orchestrator`），与主对话是两个角色**。
   水位上报的收件人是**编排**；继任由**编排**决策与指派（**包括给它自己**）。
   **主对话不参与分配** —— 它只更新状态、跟踪、最终关单。
   ⇒ 「主对话不能自行增删角色」这条约束**完全不用破**。
10. **★分配 AI = 编排 AI（`orchestrator`），与主对话是两个角色**。
   水位上报的收件人是**编排**；继任由**编排**决策与指派。**主对话不参与分配** ——
   它只更新状态、跟踪、最终关单。⇒ 「主对话不能自行增删角色」这条约束**完全不用破**。
11. **★席位继任是"换班"，不是"改角色"**。角色数量不变、任务状态不变，只是同一角色的席位换个人。
   画图时：旧席位与新席位**画成同一个角色的两个世代**（`writer#1@1` → `writer#1@2`），
   中间那条边标"交接物 + 令牌失效"；**不要**画成"新增了一个 writer 角色"。
12. **★编排自己也会继任**，继任时**广播新联系人**给所有已绑定席位。
   画图时：从编排席位拉一条**广播边**扇形连到所有已绑定席位（标"新联系人 = X"）；
   再加一个 `contacts` 查询节点（每个席位行动前都该先查"当前编排是谁"）。

8. **★审核结论里必须有"安全确认"段**（`review_verdict.security`）。判据落在**关单**上：
   `attestation` 缺失 / `unknown` / 有未解决 finding / 依据不存在 / L3+ 没有独立安全结论
   —— 任一条都**关不了单**。画图时把这条挂在 `passed → closed` 那条边上，
   并注明"**安全否决优先于审核 OK**"（L3+ 的 `security_review.blocked=true` 一票否决）。

---

## 一、分层

```
┌──────────────────────────────────────────────────────────────────────────┐
│ L5 · 交互层（人 / 主对话 / 浏览器 UI）                                     │
│   用户  ·  主对话会话（只调度不干活）  ·  ★右上角「多AI 协调」开关          │
├──────────────────────────────────────────────────────────────────────────┤
│ L4 · 角色层（每个角色 = 一个独立会话）                                     │
│   编排判断 · 架构 · 安全审计 · 编写 · 测试 · 审核 · 发布 · 文档 · 性能 · 仲裁 │
├──────────────────────────────────────────────────────────────────────────┤
│ L3 · 工具层（36 个 pipeline_* 工具，模型可见）                              │
│   开单 · 编排 · 派活 · 认领 · 交接 · 迁移 · 打回 · 关单 · 查询 · 角色变更 …   │
│   + 总开关 pipeline_switch                                                 │
├──────────────────────────────────────────────────────────────────────────┤
│ L2 · 机制层（本插件的核心逻辑，纯函数 + 内存态）                             │
│   ★功能开关 · 角色表 · 分档规则引擎 · 状态机 · 交接物 schema · 令牌表 ·        │
│   任务存储 · 守门判据                                                       │
├──────────────────────────────────────────────────────────────────────────┤
│ L1 · 宿主接入层（只挂三个点）                                               │
│   ctx.tools.register （工具）  ctx.tools.guard （单调守卫）                 │
│   ★ctx.webServer.register （开关的 HTTP 面，可选）                          │
├──────────────────────────────────────────────────────────────────────────┤
│ L0 · DSH 宿主 / profile                                                    │
│   tools 执行流水线 · 子代理服务 · system prompt · 文件与 shell 工具 ·        │
│   webServer（同端口 HTTP）· 客户端模块加载器 __ModuleLoader__                │
└──────────────────────────────────────────────────────────────────────────┘
```

**一句话概括**：L2 是全部业务真相，L1 只是把 L2 的判断挂到宿主仅有的三个扩展点上。
L3 是给模型的手；L4 是干活的人；L5 是下命令的人。
★ 标记的是「UI 开关」这条增量加进来的部分。

---

## 二、节点清单

> `类型`：`actor` 角色 / `tool` 工具 / `core` 机制模块 / `store` 存储 / `host` 宿主 / `art` 制品

### L5 · 交互层

| id | 中文标签 | 类型 | 说明 |
|---|---|---|---|
| `user` | 用户 | actor | 提需求、看结果、必要时人工介入（阻塞/取消/放行） |
| `main` | 主对话 | actor | 接需求、开单、按清单派活、催办、维护状态、收到 OK 后关单。**不读代码、不写代码、不跑测试、不做技术判断、不决定要几个 AI**。\n★ **不参与分配**：水位上报的收件人与继任的指派者都是**编排**，不是它。它只**更新状态、跟踪、最终关单** |
| `toggle_ui` | 右上角「多AI 协调」开关 | actor | 浏览器里的一个按钮。**开** = 编排 + 守门 + 状态机全管；**关** = 回到普通 DSH 行为。挂在 `conversation.session.header.utilities`（会话头部右侧、右侧栏切换按钮左边一格） |
| `role_asks` | 角色向上提问（非节点，是一种**边**） | actor | 执行/顾问角色与用户**没有连线**；它要人拍板只能走 ② → 主对话。画图时**不要**从任何一个执行角色画一条到用户的边 |

### L4 · 角色层

| id | 中文标签 | 类型 | 说明 |
|---|---|---|---|
| `orchestrator` | 需求分析·编排判断 | actor | 把模糊需求变成任务卡 + 角色清单 + 调用顺序 + **判断理由**；复核角色变更申请。
★ 还是**两级升级梯的第一级**：裁定执行角色提上来的澄清请求（`clarification_reply`）；答不了时由它升级给用户（`human_request` 带 `escalated_from`）。\n★ 还是**分配 AI**：席位水位上报的收件人；**继任由它决策与指派**（追加/指派继任者本来就是它的本职），**包括给它自己换班**。\n★ 它**不写** `requirement.md` —— 那由留档 AI 汇总产生；编排只交**自己那份记录**（`records/orchestrator.md`，任务卡就是它的记录） |
| `architect` | 架构/技术方案 | actor | 模块划分、接口契约、技术选型（L2+） |
| `security` | 安全/合规审计 | actor | 安全基线审计，可独立打回（L3+） |
| `writer` | 编写 | actor | 按任务卡改代码、自测、产出 `dev_to_test`。**只能交测试**。
★ **可有 1~3 个席位**（`writer#1`/`#2`/`#3`），每个席位一段互不重叠的写入范围；
画图时是三个并列节点，**彼此之间没有边**（分区不重叠，接缝由编排划界）。count=1 时就是一个节点 |
| `tester` | 测试 | actor | 独立设计用例并执行，产出 `test_to_review` 交审核；不通过打回编写。**不得替编写改代码** |
| `reviewer` | 审核 | actor | 核对需求/产物/测试报告，发 `OK` 或 `NG`。**不得替编写改代码** |
| `diagrammer` | ★架构图 | actor | **编写完成之后**渲染架构图作为交付物（L2+）。与 `architect` 不是一回事：
`architect` 是编写**之前**的顾问（出 `design`），`diagrammer` 是编写**之后**的产出者（出 `architecture_diagram`） |
| `archivist` | ★**留档** | actor | **`requirement.md` 的唯一写者**（L1+）：收集各方在 `records/` 下落的记录 → 汇总成唯一需求档；每条内容标来源（记录 id + 提交者 + 时间）；记录**互相矛盾**时不得自己拍板（走 `clarification_request` / 升级）；**不得凭空写入无来源内容** |
| `release` | 发布/运维 | actor | 上线步骤、回滚方案、灰度与监控（L4） |
| `docs` | 文档 | actor | 用户文档、变更日志（L5 按需） |
| `performance` | 性能/压测 | actor | 基准与压测结论（L5 按需） |
| `arbiter` | 仲裁/争议解决 | actor | 打回次数用尽且结论分歧时介入裁定 |
| `human` | 人工 | actor | 异常出口：阻塞、取消、人工放行、回滚 |

### L3 · 工具层（36 个；下表只画**关键 22 个**节点，完整清单以 `lib/tools.js` 注册与 `pipeline_boundaries.tool_face` 为准）

| id | 中文标签 | 类型 | 允许角色 |
|---|---|---|---|
| `t_open` | 开单 | tool | main |
| `t_orchestrate` | 编排判断 | tool | orchestrator；main 仅可调规则引擎自批 L0 |
| `t_dispatch` | 派活 | tool | main |
| `t_bind` | 角色认领 | tool | 任何持令牌的会话 |
| `t_handoff` | 提交交接物 | tool | 按交接物类型分派 |
| `t_transition` | 状态迁移 | tool | main / human |
| `t_rework` | 打回 | tool | tester / reviewer / security / human |
| `t_close` | 关单 | tool | main |
| `t_status` | 状态查询 | tool | 任何人 |
| `t_roster_req` | 角色变更申请 | tool | 执行角色 |
| `t_roster_review` | 角色变更复核 | tool | orchestrator |
| `t_artifact` | 制品登记 | tool | writer / human |
| `t_selftest` | 守门自检 | tool | 任何人 |
| `t_switch` | ★总开关 | tool | 任何人 |
| `t_clarify_req` | ★两级梯 ①：问需求分析 | tool | 执行/顾问角色 |
| `t_clarify_reply` | ★两级梯 ②：需求分析裁定 | tool | 只有 orchestrator |
| `t_security_scan` | ★安全确认扫描 | tool | reviewer / security / main / human |
| `t_context_report` | ★上报上下文水位 | tool | 任何角色 |
| `t_succession` | ★席位继任（换班） | tool | 只有 main |
| `t_human_req` | ★两级梯 ③ / 人工介入：发起 | tool | 执行角色（**仅 L0**）/ orchestrator（升级） |
| `t_human_relay` | ★人工介入：转告 | tool | 只有 main |
| `t_human_reply` | ★人工介入：记答复+恢复 | tool | 只有 main |

### L2 · 机制层

| id | 中文标签 | 类型 | 源文件 | 说明 |
|---|---|---|---|---|
| `m_roles` | 角色表 | core | `lib/roles.js` | 谁是谁、谁能写哪、谁能产出哪种交接物。**唯一的角色事实来源** |
| `m_tiers` | 分档规则引擎 | core | `lib/tiers.js` | 13 组不平凡信号 + 3 条硬闸 → L0~L5 + 角色清单 + 理由 |
| `m_states` | 状态机 | core | `lib/states.js` | 14 个状态、全部合法转移、**没有** 开发中→待审核 这条边 |
| `m_handoff` | 交接物 schema | core | `lib/handoff.js` | 13 种交接物的固定字段 + 跨字段约束 + 脱敏摘要 |
| `m_tokens` | 角色令牌表 | core | `lib/tokens.js` | 铸令牌、令牌↔任务、令牌↔会话二次绑定、按 agent 反查角色 |
| `m_store` | 任务存储 | store | `lib/store.js` | 状态推进、交接物落盘、打回预算、制品版本、有效 OK 判定、审计 |
| `m_guard` | 守门判据 | core | `lib/guard.js` | 纯函数：越权 / 跳步 / 测试改码 / 主对话读码 / shell 旁路 |
| `m_guard_factory` | 守门接线 | core | `lib/guard-factory.js` | 把同步判据接到 `ctx.tools.guard`，含 fail-closed；**开关关掉时第一句就弃权** |
| `m_switch` | ★功能开关 | core | `lib/switch.js` | 同步可读的开/关位；落盘到 `.pipeline/switch.json`；订阅通知 |
| `m_switch_routes` | ★开关的 HTTP 面 | core | `lib/switch-routes.js` | `GET/POST /.dsh-pipeline/state`；只服务环回；拿不到 webServer 则安静降级 |
| `m_client` | ★客户端半边 | core | `lib/client.js` | 经典脚本；`__ModuleLoader__.load({id, factory})`；注册开关按钮，相对 fetch 读写宿主开关 |
| `m_transport` | 通信通道 | core | `lib/transport/index.js` | `subagent` / `manual` / `simulated` 三档可插拔 |
| `m_config` | 配置 | core | `lib/config.js` | 默认值 + 宽松合并（刻意不导出 Config schema） |
| `m_seats` | ★编写席位 | core | `lib/tiers.js` | `buildWriters` / `seatOwningPath` / `recommendWriters`。分区不得重叠（含包含关系） |
| `m_context` | ★水位与继任 | core | `lib/context.js` | 阈值 **45/55/65** / 档位计算 / 交接物校验（含编排的 `pending_requests`）/ **谁能执行继任**（`checkSuccessionActor`）/ 工具调用计数器 |
| `m_security` | ★安全确认扫描 | core | `lib/security.js` | 11 类本地泄密特征 + 2 类网络特征；**只扫本任务工作区**；结果**打码**不回显原文 |

### L2 · 存储

| id | 中文标签 | 类型 | 路径 |
|---|---|---|---|
| `s_task` | 任务卡 | store | `<项目>/.pipeline/<taskId>/task.json` |
| `s_handoffs` | 交接物 | store | `<项目>/.pipeline/<taskId>/handoffs/NNN-<kind>.json` |
| `s_artifacts` | 制品库 | art | `<项目>/.pipeline/<taskId>/artifacts/vN/` |
| `s_reports` | 报告目录 | art | `<项目>/.pipeline/<taskId>/reports/` |
| `s_audit` | 审计流水 | store | `<项目>/.pipeline/<taskId>/audit.jsonl`（只追加） |
| `s_switch` | ★开关状态 | store | `<项目>/.pipeline/switch.json`（先写 .tmp 再 rename） |
| `s_human` | ★人工介入请求生命周期 | store | `task.json` 的 `human_requests[]`（原件在 `handoffs/NNN-human_request.json`） |
| `s_records` | ★分权落档 | store | `<项目>/.pipeline/<taskId>/records/<role>[-<seat>].md` + `.json`（**各写各的，互不覆盖**；提交带令牌校验来路） |
| `s_reqdoc` | ★需求档（权威快照） | store | `<项目>/.pipeline/<taskId>/requirement.md` + `.json` + **`requirement.index.json`（版本索引 = 可追溯凭据）** + 历史 `requirement.rN.md`（**不覆盖**）。★ 由**留档 AI 汇总**产生；路径靠目录约定，任务卡里不登记 |
| `s_contacts` | ★当前联系人 | store | `task.json` 的 `contacts{role → {agent_id, generation, since}}` —— 谁是指派者 |
| `s_relay` | ★水位上报 + 继任记录 | store | `task.json` 的 `context_reports[]` / `successions[]` |

### L1/L0 · 宿主

| id | 中文标签 | 类型 | 说明 |
|---|---|---|---|
| `h_tools` | 工具执行流水线 | host | `tools/pre-execute` → **`tools.guard`（单调）** → dispatch → `tools/post-execute` → `tools/result` |
| `h_subagents` | 子代理服务 | host | `startContinuable` / `start` / `sendMessage` / `interrupt`；提供角色会话的独立上下文 |
| `h_fs` | 文件工具 | host | `read` / `write` / `edit` / `str_replace_editor` —— 守门按**路径**判它们 |
| `h_shell` | Shell 工具 | host | `pwsh` / `bash` —— 守门按**命令串**判它们（best-effort） |
| `h_prompt` | system prompt | host | `ctx.systemPrompt.section()`，注入一段角色行为契约 |
| `h_web` | ★webServer | host | `ctx.webServer.register({kind:"prefix", path, handler})`；开关的 HTTP 面挂在它上面。**运行期探测**，不写进 inject |
| `h_clientmod` | ★客户端模块加载器 | host | `window.__ModuleLoader__.load({id, factory})`；bundle 走 `<script async src="/plugins/<id>/client.js">`（**经典脚本**，不是 ES 模块） |
| `h_slots` | ★插槽服务 | host | `ctx.slots.inject(key, cb)` / `ctx.slots.register(spec, Component)`；槽位名与 kind 由**声明方**（各 ui-* 包的 client 半边）定 |

---

## 三、边清单

> `类型`：`call` 调用 / `event` 事件 / `dataflow` 数据流 / `control` 控制

### A. 主流程（正例：编排 → 编写 → 测试 → 审核 → 关单）

| # | from | to | 中文标签 | 类型 | 触发条件 |
|---|---|---|---|---|---|
| A1 | `user` | `main` | 提交需求 | dataflow | 用户把需求交给主对话 |
| A2 | `main` | `t_open` | 开单 | call | 登记原始需求，**不做技术分析** |
| A3 | `t_open` | `s_task` | 建任务卡 | dataflow | 状态 = 待分配 |
| A4 | `main` | `t_orchestrate` | 请求编排判断 | call | 主对话**只能调规则引擎**，不能手写清单 |
| A5 | `t_orchestrate` | `m_tiers` | 跑平凡性判据 | call | 命中任一不平凡信号 → 拒绝自批 L0 |
| A6 | `m_tiers` | `main` | **拒绝 + 升档建议** | control | "这个需求需要独立的编排判断对话" |
| A7 | `main` | `t_dispatch` | 派编排角色 | call | `role=orchestrator`；状态 待分配 → 需求分析中 |
| A8 | `t_dispatch` | `m_transport` | 建角色会话 | call | subagent 通道下真的建子代理；manual 下渲染派活单 |
| A9 | `m_transport` | `orchestrator` | 派活单 + 角色令牌 | dataflow | 令牌只属于这一个角色 |
| A10 | `orchestrator` | `t_bind` | 认领身份 | call | 令牌 ↔ 会话二次绑定，一笔锁死 |
| A11 | `orchestrator` | `t_orchestrate` | 产出角色清单 | call | 必须带 `tier` + `reason` |
| A12 | `t_orchestrate` | `s_task` | 写清单 + 任务卡 | dataflow | 状态 → 待开发 |
| A13 | `t_orchestrate` | `s_handoffs` | 落 `orchestration` 交接物 | dataflow | 判断理由留痕，可追溯 |
| A14 | `main` | `t_dispatch` | 派编写 | call | 清单里**必须**有 writer |
| A15 | `t_dispatch` | `writer` | 派活单 + writer 令牌 | dataflow | 状态 → 开发中 |
| A16 | `writer` | `t_artifact` | 登记制品 vN | call | 只有 writer 能登记 |
| A17 | `t_artifact` | `s_artifacts` | 落制品 | art | 旧版本不删，可回滚 |
| A18 | `writer` | `t_handoff` | 交 `dev_to_test` | call | 代码/变更说明/运行命令/自测结果/已知问题 |
| A19 | `t_handoff` | `m_handoff` | 字段校验 | call | 缺字段 → 拒 |
| A20 | `t_handoff` | `m_states` | 状态推进 | event | `dev_submitted`：开发中 → 待测试 |
| A21 | `t_handoff` | `s_handoffs` | 落交接物 | dataflow | 一份一个文件 |
| A22 | `main` | `t_dispatch` | 派测试 | call | 状态 → 测试中 |
| A23 | `tester` | `t_handoff` | 交 `test_to_review` | call | 用例/结果/失败日志/通过证据/风险说明 |
| A24 | `t_handoff` | `m_store` | 版本一致性校验 | control | 与当前有效制品不一致 → 拒 |
| A25 | `t_handoff` | `m_states` | `test_passed` | event | 测试中 → 待审核 |
| A26 | `main` | `t_dispatch` | 派审核 | call | 状态 → 审核中 |
| A27 | `reviewer` | `t_handoff` | 发 `review_verdict` | call | 结论 OK/NG、风险、是否放行、交付说明 |
| A28 | `t_handoff` | `m_states` | `review_ok` | event | 审核中 → 已通过 |
| A29 | `main` | `t_close` | 关单 | call | **必须已有有效审核 OK** |
| A30 | `t_close` | `m_store` | 校验有效 OK | control | 无 OK / 版本不符 / OK 在打回之前 → 拒 |
| A31 | `m_store` | `s_task` | 写关单报告 | dataflow | 记录放行依据与最终交付说明 |
| A32 | `t_close` | `m_tokens` | 回收本任务全部令牌 | control | 关单即失效 |

### B. 打回与异常

| # | from | to | 中文标签 | 类型 | 触发条件 |
|---|---|---|---|---|---|
| B1 | `tester` | `t_rework` | 测试打回编写 | call | `target=writer`；状态 测试中 → 已打回编写 |
| B2 | `reviewer` | `t_rework` | 审核打回编写 | call | `target=writer`；审核中 → 已打回编写 |
| B3 | `reviewer` | `t_rework` | 审核打回测试 | call | `target=tester`；审核中 → 已打回测试 |
| B4 | `t_rework` | `m_store` | 消耗打回预算 | control | 超限 → 拒，并给出替代出路 |
| B5 | `t_rework` | `m_store` | **作废上一轮审核 OK** | control | 改完代码不能拿旧 OK 关单 |
| B6 | `main` | `t_transition` | 阻塞 / 解除 / 取消 | call | 异常出口；也可由 `human` 触发 |
| B7 | `t_transition` | `m_states` | 回到阻塞前状态 | event | `unblock` 用 `previous_state` 回退 |

### C. 守门（每一条都会在 dispatch **之前**拦住）

| # | from | to | 中文标签 | 类型 | 判据 |
|---|---|---|---|---|---|
| C1 | `h_tools` | `m_guard` | 每一次工具调用先过守卫 | event | `tools.guard` 在 `tools/pre-execute` 之后、dispatch 之前 |
| C2 | `m_guard` | `m_tokens` | 反查调用方角色 | call | `exec.agent.id` → 令牌表 → 角色 |
| C3 | `m_guard` | `writer` | 拒绝：编写跳审核 | control | `pipeline_handoff(kind=review_verdict)` 的方向表里没有 writer |
| C4 | `m_guard` | `main` | 拒绝：无身份/越权调工具 | control | 流水线工具的角色白名单 |
| C5 | `m_guard` | `main` | 拒绝：主对话改角色 | control | `pipeline_roster_review` 只允许 orchestrator |
| C6 | `tester` | `m_guard` | 拒绝：测试改代码 | control | 角色 ∈ {tester, reviewer} + 写工具 + 受保护路径 |
| C7 | `reviewer` | `m_guard` | 拒绝：审核改代码 | control | 同上 |
| C8 | `main` | `m_guard` | 拒绝：主对话读代码 | control | 角色 = main + 读工具 + 受保护路径 |
| C9 | `h_shell` | `m_guard` | 拒绝：shell 旁路改/读 | control | 命令串里同时出现动作动词与受保护路径（best-effort） |
| C10 | `m_guard` | `h_tools` | 放行 | control | **必须返回 `undefined`** —— 返回任何非 undefined 值都算拒绝 |
| C11 | `m_guard` | `h_tools` | fail-closed | control | 守卫自身异常 → 返回明确拒绝理由，**不静默放行** |

### D. 角色变更（主对话不能自己增减人）

| # | from | to | 中文标签 | 类型 | 触发条件 |
|---|---|---|---|---|---|
| D1 | `writer` / `tester` / `reviewer` | `t_roster_req` | 提出角色变更申请 | call | 必须给 `reason` |
| D2 | `t_roster_req` | `s_task` | 登记待复核申请 | dataflow | 状态 pending |
| D3 | `main` | `t_roster_review` | 主对话想自己批 | control | **被守门拒**（角色越权） |
| D4 | `orchestrator` | `t_roster_review` | 编排复核 | call | 批准 → 直接改写角色清单并留痕 |
| D5 | `t_roster_review` | `m_tiers` | 重建清单 | call | 三权分立角色不可移除 |
| D6 | `main` | `t_dispatch` | 按**新**清单派活 | call | 清单外的角色派不出去 |

### E. 与宿主的接口（只有三条）

| # | from | to | 中文标签 | 类型 | 说明 |
|---|---|---|---|---|---|
| E1 | `dsh-pipeline` | `h_tools` | 注册 36 个工具 | call | `ctx.effect(() => ctx.tools.register(def))` |
| E2 | `dsh-pipeline` | `h_tools` | 注册 1 个单调守卫 | call | `ctx.effect(() => ctx.tools.guard(fn))` |
| E3 | `dsh-pipeline` | `h_prompt` | 注入角色行为契约 | call | `ctx.systemPrompt.section()`，order 2650 |
| E4 | `m_transport` | `h_subagents` | 建会话 / 投消息 | call | `startContinuable` / `sendMessage`（仅 subagent 通道） |
| E5 | ★`dsh-pipeline` | ★`h_web` | 注册开关端点 | call | `ctx.webServer.register({kind:"prefix", path:"/.dsh-pipeline"})`；**运行期探测**，拿不到就跳过 |

### G. ★UI 开关链路（这条增量新加的）

| # | from | to | 中文标签 | 类型 | 说明 |
|---|---|---|---|---|---|
| G1 | `dsh-pipeline/client.js` | `h_clientmod` | 注册客户端模块 | call | `window.__ModuleLoader__.load({id:"dsh-pipeline", factory})`；宿主扫 `dsh.client.platform==="web"` 后按 `/plugins/dsh-pipeline/client.js` 以**经典脚本**加载 |
| G2 | `dsh-pipeline/client.js` | `h_slots` | 注入槽位等声明 | call | `ctx.slots.inject("conversation.session.header.utilities", cb)` —— 槽位没声明时**等着**，不报错 |
| G3 | `dsh-pipeline/client.js` | `h_slots` | 占据槽位 | call | `ctx.slots.register({name, id:"pipeline-coordination-toggle", order:100}, Toggle)`。该槽是 **list** 槽，`id` 必填 |
| G4 | `toggle_ui` | `h_web` | 读开关状态 | call | `GET /.dsh-pipeline/state`（相对 fetch，same-origin 凭据） |
| G5 | `toggle_ui` | `h_web` | 写开关状态 | call | `POST /.dsh-pipeline/state` body `{on:false}` 或 `{}`（翻转） |
| G6 | `h_web` | `m_switch_routes` | 路由处理 | call | 只服务**环回**；非环回 403 |
| G7 | `m_switch_routes` | `m_switch` | 读写开关位 | dataflow | `sw.isOn()` / `sw.set()` |
| G8 | `m_switch` | `s_switch` | 落盘 | dataflow | `.pipeline/switch.json`（先写 .tmp 再 rename） |
| G9 | `m_switch` | `m_guard_factory` | ★守门第一句读开关 | control | **同步**读（`guardReason` 是同步遍历）。关 = 返回 `undefined`（**弃权**，不是"允许"） |
| G10 | `m_switch` | `t_*`（11 个写工具） | ★写工具第一句读开关 | control | 关 = 直接返回拒绝 + 恢复指引，**连 store 都不碰** |
| G11 | `m_switch` | `t_status` / `t_selftest` / `t_switch` | 只读工具不受影响 | control | 关掉之后仍可查历史任务、自检、再打开 |
| G12 | `t_switch` | `m_switch` | 工具侧的开关入口 | call | 与 `toggle_ui` 是**同一个开关位**（headless 下唯一的入口） |

**G9/G10 为什么两处都要判**：守门管"越权"，开关管"这功能本身开没开"，两者正交。
而且守门对**没有身份**的调用方是放行的（只约束流水线参与者），
所以关掉之后光靠守门拦不住 `pipeline_task_open` 这类动作 —— 必须在工具层再判一次。

### H. ★人工介入（用户只与主对话相连）

| # | from | to | 中文标签 | 类型 | 说明 |
|---|---|---|---|---|---|
| H1 | `writer` / `tester` / `reviewer` / `security` / `architect` / `orchestrator` / … | `t_human_req` | ① 角色向上发起 | call | 提交 `human_request` 交接物。**发起者不能是 main** |
| H2 | `t_human_req` | `s_human` | 登记请求生命周期 | dataflow | 记 `state_at_request`（被打断前的状态）+ `reason_kind` + `question_for_human` |
| H3 | `t_human_req` | `s_task` | 阻塞则推状态 | event | `blocking=true` → `awaiting_human`；`false` 则不动 |
| H4 | `main` | `t_human_relay` | ② 主对话转告 | call | **不改状态**，只留痕（`relayed_at` + 确认码） |
| H5 | `t_human_relay` | `user` | **照抄给用户看** | dataflow | 只送 `question_for_human` + 方案 + 建议。**这是角色的话唯一能到用户面前的路径** |
| H6 | `user` | `main` | 用户答复 | dataflow | 用户只在主对话的对话框里说话 |
| H7 | `main` | `t_human_reply` | ③ 记答复 | call | 必须带 `user_quote`（原话）+ `attribution`（谁在哪说）+ `reply_channel` |
| H8 | `t_human_reply` | `s_human` | 答复落痕 | dataflow | `human:reply` 审计行里能看到"用户说了什么" |
| H9 | `t_human_reply` | `m_states` | ④ 据答复恢复 | event | `human_reply`：`awaiting_human` → **回到 `state_at_request`** |
| H10 | `t_human_reply` | `s_audit` | 恢复留痕 | dataflow | `human:resume` 里 `based_on` 指回那条答复 |
| H11 | 非 main 角色 | `t_human_relay` | 角色想自己转告 | control | ✗ **拒**（守门：只有 main） |
| H12 | 非 main 角色 | `t_human_reply` | 角色想自己标记已解决 | control | ✗ **拒**（守门 + execute 双层） |
| H13 | `main` | `t_human_reply` | 未转告就想记答复 | control | ✗ **拒**（顺序闸："不可能有用户答复"） |
| H14 | `main` | `t_human_reply` | 答复不带用户原话 / 无归属 | control | ✗ **拒**（来源闸） |
| H15 | `main` | `t_human_reply` | 答复形状与 `decision_kind` 不符 | control | ✗ **拒**（形状闸） |
| H16 | `main` | `t_transition` | 直接推 `human_reply`（没有答复记录） | control | ✗ **拒**（状态闸："不能自行把请求标记为已解决"） |
| H17 | `main` | `t_human_req` | 主对话自己发起请求 | control | ✗ **拒**（它就在用户的对话框里，不需要绕一圈） |
| H18 | `t_human_reply` | `t_human_reply` | 超时路径（`answer_source=timeout`） | control | 只在"声明过截止时间 + 策略非 stay_blocked"时放行；否则 ✗ **拒**（否则就是绕过用户的后门） |
| H19 | `t_human_reply` | `t_dispatch` | 回投给发起角色 | call | 恢复后主对话重新派活即可（状态已经回到该在的地方） |

### I. ★编写席位与架构图（这次增量新加的）

| # | from | to | 中文标签 | 类型 | 说明 |
|---|---|---|---|---|---|
| I1 | `orchestrator` | `t_orchestrate` | 定编写分几块 | call | `writers: {count, partitions[], reason}`。**只有编排能给** |
| I2 | `t_orchestrate` | `m_seats` | 分区校验 | control | 分区**不得重叠**（含包含关系）→ 重叠即拒，编排清单不落盘 |
| I3 | `main` | `t_dispatch` | 逐席位派活 | call | `{role:"writer", seat:"writer#2"}`。只能派**在册**席位 |
| I4 | `writer#k` | `workdir` | 改自己那段 | dataflow | 守门按 `scope_paths` 判归属 |
| I5 | `writer#k` | `t_handoff` | 各交一份 | call | `dev_to_test` + `partition:{seat,index,total,scope_paths}` |
| I6 | `t_handoff` | `s_task` | 记席位提交 | dataflow | `writer_submissions[seat]` + `seat:submit` 审计 |
| I7 | `t_handoff` | `m_states` | **全部到齐才推进** | event | 未到齐：交接物照收、状态不动 |
| I8 | `writer#k` | `workdir` | 越界写别人的分区 | control | ✗ **拒**（守门指出归属） |
| I9 | `writer#k` | `workdir` | 写分区外 | control | ✗ **拒**（"不在任何编写席位的分区里"） |
| I10 | `writer#k` 的令牌 | `t_handoff` | 交别人的分区 | control | ✗ **拒**（席位不匹配，守门 + execute 双层） |
| I11 | 任意 | `m_states` | 未到齐就推「待测试」 | control | ✗ **拒**（SEATS_INCOMPLETE） |
| I12 | `main` | `t_orchestrate` | 主对话自己定 count | control | ✗ **拒**（"主对话不能自己产出角色清单"） |
| I13 | `main` | `t_dispatch` | 派一个不在册的席位 | control | ✗ **拒**（"不能自行加席位"） |
| I14 | `diagrammer` | `t_handoff` | 交架构图 | call | `architecture_diagram`，必须**编写之后** |
| I15 | `diagrammer` | `diagram_deliver` | 优先走 archigate | call | 别的插件的工具；本插件**不替它调**，只**校验它的说法** |
| I16 | `t_handoff` | `s_files` | 校验收据文件 | control | 声称走过闸门但收据不存在 → ✗ **拒** |
| I17 | `t_handoff` | `s_task` | 交图落痕 | dataflow | 记 `receipt_path` / `html_sha256` / `degraded` |
| I18 | `diagrammer` | `t_handoff` | 自备产物但不标降级 | control | ✗ **拒**（"必须明确标出来"） |
| I19 | `diagrammer` | `t_handoff` | 编写完成前交图 | control | ✗ **拒**（状态闸 + 产物闸） |
| I20 | `main` | `t_close` | 清单里有 diagrammer 却没交图 | control | ✗ **拒**（架构图是交付物之一） |

---

### J. ★两级升级梯（这次增量新加的）

| # | from | to | 中文标签 | 类型 | 说明 |
|---|---|---|---|---|---|
| J1 | `writer`/`tester`/`reviewer`/`security`/`architect`/`performance`/`release`/`docs`/`arbiter`/`diagrammer` | `t_clarify_req` | ① 向上提问 | call | 提交 `clarification_request`，投给 `orchestrator` |
| J2 | `t_clarify_req` | `s_task` | 登记澄清记录 | dataflow | 记 `question_key` / `round` / `state_at_request` |
| J3 | `t_clarify_req` | `m_states` | 阻塞则推状态 | event | `blocking=true` → `awaiting_clarification` |
| J4 | `orchestrator` | `t_clarify_reply` | ② 裁定 | call | `answered`（给结论）或 `cannot_answer`（给理由） |
| J5 | `t_clarify_reply` | `m_states` | 恢复 | event | `clarification_reply`：`awaiting_clarification` → **回到被打断前的状态** |
| J6 | `t_clarify_reply` | `s_audit` | 裁定留痕 | dataflow | `clarify:reply`（含 `verdict` / `reason` / `boundary_warning`） |
| J7 | `orchestrator` | `t_human_req` | ③ 升级 | call | 带 `escalated_from` / `raised_by` / `orchestrator_reason` |
| J8 | `t_human_req` | `s_task` | 标记上游已升级 | control | 上游澄清请求 → `escalated`（**单向门**） |
| J9 | `t_human_req` | `m_states` | 推「等待人工答复」 | event | `awaiting_clarification` → `awaiting_human`（`previous_state` **不被覆盖**） |
| J10 | `main`/`human` | `t_human_relay`→`user` | ④ 转告 → ⑤ 答复 | call | 沿用既有四步留痕 |
| J11 | `main` | `t_human_reply` | ⑥ 恢复 | event | `awaiting_human` → **最初那个工作状态** |
| J12 | 执行角色 | `t_human_req` | 跳级（有独立编排对话时） | control | ✗ **拒**（指路 `pipeline_clarify_request`） |
| J13 | 执行角色 | `t_human_req` | 直发（**L0**，无独立编排对话） | call | ✓ **放行**（唯一合法路径，`orchestrator_mode='rule-engine'`） |
| J14 | `orchestrator` | `t_human_req` | 升级一条**自己答过**的请求 | control | ✗ **拒**（"只能升级自己确实答不了的问题"） |
| J15 | `orchestrator` | `t_human_req` | 升级但没给 `orchestrator_reason` | control | ✗ **拒**（用户有权知道为什么轮到他拍板） |
| J16 | `orchestrator` | `t_human_req` | `escalated_from` 指向不存在的请求 | control | ✗ **拒** |
| J17 | 执行角色 | `t_clarify_req` | 同一个问题问第 3 次 | control | ✗ **拒**（防踢皮球） |
| J18 | `orchestrator` | `t_clarify_reply` | 对**已升级**的请求改口裁定 | control | ✗ **拒**（单向门） |
| J19 | 非 orchestrator | `t_clarify_reply` | 替需求分析出裁定 | control | ✗ **拒**（守门：只允许 orchestrator） |

---

### K. ★安全确认（这次增量新加的）

| # | from | to | 中文标签 | 类型 | 说明 |
|---|---|---|---|---|---|
| K1 | `reviewer`（L0~L2）/ `security`（L3+） | `t_security_scan` | 跑安全确认扫描 | call | 本地泄密面（`lib/security.js` 的 11 类特征）+ 网络面（外联地址、未解释外联、凭证出网） |
| K2 | `t_security_scan` | `s_task` | 扫描结果落盘 | dataflow | 写 `reports/security-scan-<时间>.json`，返回 `checks_ref = 相对路径#sha256前缀` |
| K3 | `security` | `t_handoff` | L3+ 出独立结论 | call | `security_review`（含 `blocked` / `severity`） |
| K4 | `reviewer` | `t_handoff` | 审核出安全确认 | call | `review_verdict.security`：两个面 `checked` + `checks_ref` + `attestation` + `findings` |
| K5 | `t_handoff` | `m_states` | 关单闸 | control | `close_gates` = `review_ok_exists` → **`security_not_blocked`** → `security_attested` → `diagram_delivered` |
| K6 | `t_handoff` | `reviewer` | attestation=unknown | control | ✗ **拒**（"没查"≠"查了没问题"） |
| K7 | `t_handoff` | `reviewer` | 缺 security 段 / `checked:false` / `checks_ref` 空 | control | ✗ **拒** |
| K8 | `t_handoff` | `s_files` | `checks_ref` 指向的文件不存在 | control | ✗ **拒**（依据必须可核对） |
| K9 | `main` | `t_close` | 有未解决 finding | control | ✗ **拒**（指路：打回编写 / 转 security / 升级人工） |
| K10 | `security` | `t_close` | `blocked: true` | control | ✗ **拒**（**安全否决优先于审核 OK**，一票否决） |
| K11 | `security` | `t_close` | L3+ 但没有 `security_review` | control | ✗ **拒**（"审核自己说没问题"不够，要有独立那一票） |
| K12 | `reviewer` | `t_handoff` | `checked_by: 'security'` | control | ✗ **拒**（安全角色的结论是**输入证据**，不是审核结论） |
| K13 | `reviewer` | `t_handoff` | finding 里抄了命中原文 | control | ✗ **拒**（等于把泄露搬到结论里） |
| K14 | `t_security_scan` | `s_files` | 扫到哪为止 | control | **只扫本任务工作区**；越界的 `extra_paths` 被拒并记入结果 |

#### ★安全确认时序（画成时序图用）

```
审核/安全      扫描工具        文件系统       状态机        关单闸
   │              │              │            │            │
   │ ①pipeline_security_check    │            │            │
   ├─────────────►│              │            │            │
   │              │ 扫 .pipeline/<taskId>/   │            │
   │              ├─────────────►│            │            │
   │              │◄─────────────┤            │            │
   │              │ ★ 结果打码（不回显原文）   │            │
   │              │ 落盘 reports/security-scan-*.json      │
   │◄─────────────┤ 返回 checks_ref           │            │
   │              │              │            │            │
   │ ②review_verdict.security{attestation, checks_ref, findings}
   ├──────────────────────────────────────────►│            │
   │              │              │            │            │
   │              │              │      审核 OK → passed     │
   │              │              │            ├───────────►│
   │              │              │            │  ③ review_ok_exists   ✓
   │              │              │            │  ④ security_not_blocked
   │              │              │            │     ★ blocked=true → ✗ 拒
   │              │              │            │  ⑤ security_attested
   │              │              │            │     缺段/unknown/有 finding/
   │              │              │            │     checks_ref 不存在 → ✗ 拒
   │              │              │            │  ⑥ diagram_delivered  ✓
   │◄──────────────────────────────────────────┴───────────┤ closed
```

**画图要点**：

1. **安全确认有两个来源**：审核自己的结论（L0~L2 全程；L3+ 也要）+ 安全角色的独立结论（L3+ 必须）。
   两者**不能互相替代** —— 安全角色的 是**输入证据**。
2. **④ 那条边要画粗、画红**：`blocked: true` 是**一票否决**，优先级高于审核 OK。
3. **扫描工具那条自环要标"只扫本任务工作区 / 结果打码"** ——
   这是它作为安全工具能成立的前提（不越界、不自成泄密渠道）。

---

### L. ★分权落档 + 留档 AI（更正版：推翻"编排独占写权"）

| # | from | to | 中文标签 | 类型 | 说明 |
|---|---|---|---|---|---|
| L1 | `orchestrator` | `t_orchestrate` | 产出任务卡 | call | 交出的是**自己那份记录**，不是 `requirement.md` |
| L2 | `t_orchestrate` | `s_records` | 编排那份记录 | dataflow | `records/orchestrator.md`（档位 / 角色 / 验收标准都在里面） |
| L3 | 各角色 / 席位 | `t_record_submit` | **各写各的**（带令牌） | call | 落 `records/<role>[-<seat>].md`；**互不覆盖** |
| L4 | `t_record_submit` | `s_records` | 收下记录 | dataflow | 校验：任务 ↔ 角色 ↔ 席位三者一致 |
| L5 | 非本人 | `s_records` | 写**别人那份**记录 | control | ✗ **拒**（等于伪造来源） |
| L6 | 匿名 / 冒名 | `t_record_submit` | 无令牌 / 令牌不符 | control | ✗ **拒**（留档 AI 不得收） |
| L7 | `archivist` | `t_compile` | **收集 + 统一编写** | call | 唯一能写 `requirement.md` 的角色 |
| L8 | `t_compile` | `s_reqdoc` | 落唯一需求档 | dataflow | `requirement.md` + `.json` + 版本索引 + 历史 |
| L9 | `t_compile` | `s_reqdoc` | 无来源条目 | control | ✗ **拒**（不得凭空写入） |
| L10 | `archivist` | `t_clarify` | 记录**互相矛盾** | call | 不得自己拍板 → 提问或升级 |
| L11 | 非留档 AI | `s_reqdoc` | 直接写 `requirement.md` | control | ✗ **拒**（只有留档 AI 能写） |
| L12 | `s_reqdoc` | **所有角色** | **以本地档为准**（按目录约定自己读） | dataflow | ★ 画成公共节点，星型汇聚 |
| L13 | `main` | `t_dispatch` | 需求档不存在 / 版本不可追溯 | control | ✗ **拒**（"没有留档就不许开工"） |
| L14 | `orchestrator` / `archivist` | `t_dispatch` | 这两个角色本身 | control | ✓ **豁免**（档是它们产出的；卡它们就成死锁） |

**★ 顺序（画图时按这个次序，否则会死锁）**：

```
① 编排产出任务卡 → 交 records/orchestrator.md（不是 requirement.md）
② 主对话派留档 AI   （豁免留档闸）
③ 留档 AI 汇总     → 产出 requirement.md（r1）
④ 其余角色才能派活   （派活时查"档在不在 + 版本可不可追溯"）
```
### M. ★上下文水位与席位继任（更正版：分配 AI = 编排 AI）

| # | from | to | 中文标签 | 类型 | 说明 |
|---|---|---|---|---|---|
| M1 | 任何角色 | `t_context_report` | ① 上报上下文水位 | call | 百分比 + **依据（必填）** |
| M2 | `t_context_report` | `s_relay` | 记水位 | dataflow | 附**插件侧客观观测**（工具调用次数 / 活跃时长） |
| M3 | `t_context_report` | `water_level` | 判档位 | control | 预警 **45** / 触发继任 **55** / 硬限 **65** |
| M4 | `t_context_report` | **`orchestrator`** | ★ **通知分配 AI** | call | **不是主对话** —— 分配是编排的职权 |
| M5 | `orchestrator` | 该席位 | ② 决定追加席位 + 指派继任者 | call | 编排掌握继任策略（`relayPolicy`） |
| M6 | `orchestrator` | 旧席位 | ③「你的继任者是 X，请交接」 | call | |
| M6a | `orchestrator` | **`orchestrator`** | ★ **编排给自己换班** | call | 编排也会到 55%/65%；**自己新建编排席位**，更新清单指向（`succeeds`） |
| M6b | `orchestrator`(新) | **所有已绑定席位** | ★ **广播新联系人** | event | 「旧的那个不要再发了，后续发给新编排」—— 扇形连到每个席位 |
| M6c | 任何席位 | `t_contacts` | ★ 查**当前编排是谁** | call | 行动前先查 —— 发给已退场的席位等于发进黑洞 |
| M6d | 任何席位 | `t_context_report` | 上报发给**已退场的编排** | control | ✗ **拒**并指出当前联系人 |
| M6e | `orchestrator` | `t_handoff` | 交接物缺 `pending_requests` | control | ✗ **拒**（编排专有：谁在等答复；不写那些请求永远悬着） |
| M6f | `main` | `t_succession` | 编排**没产出继任者**就撞硬限 | call | ★ **异常路径**：主对话按「清单不变」触发例外；办不成 → **明确升级**，不许静默失联 |
| M7 | 旧席位 | `t_handoff` | ④ 提交 `seat_handover` | call | 必填含 `must_read_files` / `open_questions` / `do_not_repeat` |
| M8 | 旧席位 | 新席位 | ⑤ 交接（必读清单 + 决定 + 未决问题 + 别重复的事） | dataflow | |
| M9 | `orchestrator` | `t_succession` | 建新会话 + 指派 | call | 编排是执行者 |
| M10 | `t_succession` | `tokens` | **撤旧令牌** | control | 旧席位从此不得再写 |
| M11 | `t_succession` | `guard` | 旧会话登记退休 | control | ★ 只撤令牌不够：绑定没了守门会当"无关会话"放行 |
| M12 | `t_succession` | `s_relay` | 记 lineage | dataflow | 世代 / from / to / 依据 / 交接物 id |
| M13 | `main` | `m_states` | 跟踪 + 更新状态 | control | ★ **主对话不参与分配**，它只收状态、跟踪、关单 |
| M14 | `main` | `t_succession` | 给**执行席位**指派继任 | control | ✗ **拒**（越权 —— 分配是编排的事） |
| M15 | `main` | `t_succession` | 给**编排席位自己**换班 | call | ✓ **唯一的例外**（指派者不能是自己；按"清单不变"兜底） |
| M16 | 编排席位 | `t_context_report` | 编排自己到 55% | call | 见 M15 —— 由主对话兜底 |
| M17 | `orchestrator` | `t_succession` | 该席位没上报水位 | control | ✗ **拒**（"我觉得它快满了"不是依据） |
| M18 | `orchestrator` | `t_succession` | 水位没到触发线 | control | ✗ **拒**（白丢一个还记得上下文的席位） |
| M19 | `orchestrator` | `t_succession` | 次数超 `maxSuccessionsPerSeat` | control | ✗ **拒**（反复换班说明问题不在上下文） |
| M20 | 旧席位 | 任何写操作 | 继任之后继续写 | control | ✗ **拒**（令牌已撤 + 已登记退休） |
| M21 | 该席位 | `t_handoff` | 交接物缺三个 ★ 清单之一 | control | ✗ **拒**（防继任者从零开始） |
| M22 | 任何角色 | `t_context_report` | 上报却不给依据 | control | ✗ **拒**（"我 55% 了" ≠ "我觉得差不多了"） |
| M23 | L0 的任何角色 | `t_succession` | L0 请求继任 | control | ✗ **拒**（L0 故意不启用：没有独立编排对话做指派） |
#### ★席位继任时序（画成时序图用）

```
席位(旧)      编排 AI       分配决策       transport      守门        任务状态
  │             │             │              │            │            │
  │ ①context_report{percent:55, basis:...}   │            │            │
  ├────────────►│             │              │            │            │
  │◄────────────┤ ★ 附插件侧客观观测（工具调用 N 次）      │            │
  │             │             │              │            │            │
  │ ②seat_handover{must_read_files[], open_questions[], next_step, ...}
  ├────────────►│             │              │            │            │
  │             │ ③planSuccession（只校验，不改任何东西）  │            │
  │             ├────────────►│              │            │            │
  │             │  授权？水位到线？交接物合法？            │            │
  │             │◄────────────┤              │            │            │
  │             │ ④建新会话    │              │            │            │
  │             ├───────────────────────────►│            │            │
  │             │◄───────────────────────────┤ 新令牌      │            │
  │             │ ⑤撤旧令牌 + 旧会话登记退休  │            │            │
  │             ├────────────────────────────────────────►│            │
  │  ✗ 再写入被拒（"席位已继任换班"）          │            │            │
  │◄─────────────────────────────────────────────────────┤            │
  │             │ ⑥记 succession（世代 / 依据 / 交接物 id）│            │
  │             ├──────────────────────────────────────────────────────►│
  │             │             │              │            │  ★ 状态不变 │
新席位           │             │              │            │            │
  │ 读 must_read_files（至少含 requirement.md）→ 按 next_step 继续      │
  └────────────────────────────────────────────────────────────────────►│
```

**画图要点**：

1. **旧席位与新席位是"同一角色的两个世代"**（`writer#1@1` → `writer#1@2`），不是两个角色。
2. **⑥ 那条边务必标"任务状态不变"** —— 继任是换班，不是重开。
3. **⑤ 之后旧席位那条边要画成"被切断"**（红色 ✗），并注明「**只撤令牌不够，还要登记退休**」。

---



| # | from | to | 中文标签 | 类型 | 说明 |
|---|---|---|---|---|---|
| F1 | `dsh-archigate` | `h_tools` | 另一个单调守卫 | call | archify 交付守门 |
| F2 | `m_guard` | `dsh-archigate` | 互不翻转 | control | `guardReason` 取第一个非 undefined 即返回，谁都不能翻谁的盘 |
| F3 | `m_guard` | 无关会话 | 完全放行 | control | 守门只约束**流水线参与者** |

---

## 四、守门决策树（画成流程图用）

```
工具调用进入
    │
    ├─ ★功能开关是「关」？ → 返回 undefined（**弃权**，不是"允许"）
    │                      别的插件的守卫照样能拒 —— 关掉的是"多 AI 协调"，
    │                      不是"整个 DSH 的其它保护"
    │
    ├─ 工具名以 pipeline_ 开头？
    │      │
    │      ├─ 是 pipeline_human_request？ ── main 调用 → 拒（它就在用户的对话框里）
    │      │
    │      ├─ 是 pipeline_handoff？ ── 查交接物方向表 ── 角色不符 → 拒（编写跳审核在这里被拦）
    │      │
    │      ├─ 该工具有角色白名单？ ── 解析调用方角色（会话绑定 > 参数令牌）
    │      │        ├─ 解析不出角色 → 拒（"流水线工具必须能回答你是谁"）
    │      │        └─ 角色不在白名单 → 拒（主对话改角色在这里被拦）
    │      │
    │      └─ 放行到 execute 层
    │
    ├─ 调用方**没有**绑定任何角色？ → 放行（守门只约束流水线参与者）
    │
    ├─ 是写类文件工具（write / edit / str_replace_editor）？
    │      └─ 角色 ≠ writer/human 且 目标路径在项目根内且不在本任务 reports/ 下 → 拒
    │
    ├─ 是读类文件工具（read / read_image）？
    │      └─ 角色 = main 且 目标路径在项目根内且不在 .pipeline 下 → 拒
    │
    ├─ 是 shell 类工具（pwsh / bash）？
    │      ├─ 角色 ≠ writer/human 且 命令里有写动词或重定向 → 拒
    │      ├─ 角色 = main 且 命令里有读动词且提到受保护路径 → 拒
    │      └─ 命令里有删除动词且提到 .pipeline → 拒（保审计留痕）
    │
    └─ 返回 undefined（放行）
```

### ★开关关闭时的两条独立闸（画在同一张图上的话，它们并列）

```
                      ┌─────────────────────────┐
   用户点右上角按钮 ──► │  /.dsh-pipeline/state    │
   或 pipeline_switch  │  （POST，只服务环回）     │
                      └───────────┬─────────────┘
                                  │
                      ┌───────────▼─────────────┐
                      │  m_switch（同步可读）     │
                      │  + .pipeline/switch.json │
                      └────┬───────────────┬────┘
                           │               │
              ┌────────────▼───┐    ┌──────▼─────────────────┐
              │ 守门第一句       │    │ 11 个写工具第一句        │
              │ 关 → undefined  │    │ 关 → 直接拒绝 + 恢复指引 │
              │ （弃权）         │    │ （连 store 都不碰）      │
              └────────────────┘    └────────────────────────┘
                 越权不再被拦            流水线不再能推进
                 （别的插件照常拦）       （查询/自检/开关仍可用）
```

---

## 五、正例时序（画成时序图用）

```
用户      主对话      编排      编写      测试      审核      存储
 │          │          │         │         │         │         │
 ├─需求────►│          │         │         │         │         │
 │          ├─开单─────────────────────────────────────────────►│ task.json (待分配)
 │          ├─请求编排─►│         │         │         │         │
 │          │◄─拒绝(升档建议)─────│         │         │         │
 │          ├─派活─────►│         │         │         │         │
 │          │          ├─角色清单──────────────────────────────►│ roster + orchestration
 │          │◄─────────┤         │         │         │         │ (待开发)
 │          ├─派活──────────────►│         │         │         │ (开发中)
 │          │          │         ├─登记制品 v1─────────────────►│ artifacts/v1
 │          │          │         ├─dev_to_test─────────────────►│ handoffs/ (待测试)
 │          ├─派活────────────────────────►│         │         │ (测试中)
 │          │          │         │         ├─test_to_review─────►│ handoffs/ (待审核)
 │          ├─派活──────────────────────────────────►│         │ (审核中)
 │          │          │         │         │         ├─OK──────►│ handoffs/ (已通过)
 │          ├─关单（校验有效 OK）──────────────────────────────►│ close_report (已关闭)
 │◄─交付────┤          │         │         │         │         │
```

---

## 六、反例时序（越权被拦在哪一层）

```
① 编写 ──pipeline_handoff(review_verdict)──► [守门] 交接物方向表：允许 reviewer ──► ✗ 拒
② 主对话 ──pipeline_close（无 OK）────────► [守门] 角色白名单通过
                                            └─► [execute] 有效 OK 判据 ──► ✗ 拒
③ 测试 ──write(项目源码)──────────────────► [守门] 角色+路径 ──► ✗ 拒
④ 主对话 ──pipeline_roster_review────────► [守门] 角色白名单：只允许 orchestrator ──► ✗ 拒
⑤ 测试 ──pipeline_rework（第 3 次）───────► [execute] 打回预算耗尽 ──► ✗ 拒
⑥ 主对话 ──read(项目源码)─────────────────► [守门] 角色+路径 ──► ✗ 拒
⑦ 编写会话 ──用测试的令牌────────────────► [守门] 令牌↔会话二次绑定 ──► ✗ 拒
⑧ 审核 ──对 v2 出 OK（有效制品是 v1）────► [execute] 版本一致性 ──► ✗ 拒
⑨ 主对话 ──未转告就记"用户答复"──────────► [execute] 顺序闸 ──► ✗ 拒
⑩ 主对话 ──记答复但不带用户原话──────────► [execute] 来源闸 ──► ✗ 拒
⑪ 主对话 ──直接推 human_reply────────────► [execute] 状态闸 ──► ✗ 拒
⑫ 测试 ──pipeline_human_reply────────────► [守门] 只允许 main ──► ✗ 拒
     （摘掉守门直接打 execute 也拒 —— 两层各有一份判据）
⑬ 主对话 ──pipeline_human_request────────► [守门] 主对话不发起 ──► ✗ 拒
⑭ 测试 ──human_request（含 diff）────────► [execute] 人话判据 ──► ✗ 拒
⑮ writer#2 ──write(src/web/…)─────────────► [守门] 席位分区 ──► ✗ 拒（属 writer#1）
⑯ writer#1 的令牌 ──dev_to_test(writer#2)─► [守门]+[execute] 席位不匹配 ──► ✗ 拒
⑰ 任意 ──推「待测试」（3 席位只交 2 份）──► [execute] 全部到齐闸 ──► ✗ 拒
⑱ 主对话 ──pipeline_orchestrate───────────► [守门]+[execute] 编排独占 ──► ✗ 拒
⑲ 主对话 ──dispatch(seat:writer#2)───────► [execute] 在册席位 ──► ✗ 拒
⑳ diagrammer ──architecture_diagram──────► [execute] 收据不存在 ──► ✗ 拒
㉑ diagrammer ──交图（开发中）────────────► [execute] 时序闸 ──► ✗ 拒
㉒ 主对话 ──close（清单有图角色却没交图）─► [execute] 关单闸 ──► ✗ 拒
㉓ 执行角色 ──human_request（未走第一级）──► [execute] 跳级闸 ──► ✗ 拒（L0 例外：放行）
㉔ 需求分析 ──升级自己答过的问题──────────► [execute] 来源闸 ──► ✗ 拒
㉕ 同一问题第 3 次 ──clarification_request─► [execute] 防踢皮球 ──► ✗ 拒
㉖ 需求分析 ──对已升级的请求改口裁定──────► [execute] 单向门 ──► ✗ 拒
㉗ 非需求分析 ──clarification_reply────────► [守门] 角色白名单 ──► ✗ 拒
㉘ 主对话 ──pipeline_succession（执行席位）─► [execute] 分配权归编排 ──► ✗ 拒
㉙ 非留档 AI ──写 requirement.md────────────► [守门] 写权独占 ──► ✗ 拒（只有**留档 AI**能写）
㉜ 任何角色 ──写**别人那份** records/*.md────► [守门] 谁的记录谁写 ──► ✗ 拒（等于伪造来源）
㉝ 匿名 / 冒名 ──record_submit─────────────► [execute] 来路校验 ──► ✗ 拒（留档 AI 不得收）
㉞ 留档 AI ──compile（条目无 source_record）─► [execute] 来源闸 ──► ✗ 拒（不得凭空写入）
㉟ 留档 AI ──compile（conflicts 非空）──────► [execute] 矛盾闸 ──► ✗ 拒（不得自己拍板）
㊱ 任何席位 ──上报发给已退场的编排─────────► [execute] 联系人闸 ──► ✗ 拒并指出当前联系人
㊲ 编排 ──交接物缺 pending_requests────────► [execute] 编排专有项 ──► ✗ 拒
㉚ 主对话 ──dispatch（需求档不存在/不可追溯）─► [execute] 留档闸 ──► ✗ 拒
㉛ 旧席位 ──继任后任何写操作───────────────► [守门] 已登记退休 ──► ✗ 拒
```

---

## 六·五、★人工介入时序（画成时序图用）

```
 测试        主对话        用户        状态机      审计
  │            │            │           │          │
  │ ①human_request(blocking=true)        │          │
  ├───────────►│            │           │          │
  │            ├──状态：测试中 → 等待人工答复────────►│ human:request
  │            │            │           │          │
  │            │ ②human_relay（照抄给用户看的那段）  │
  │            ├───────────►│           │          │ human:relay
  │            │            │           │          │
  │            │ ③用户原话   │           │          │
  │            │◄───────────┤           │          │
  │            │ ③human_reply(user_quote+attribution)│
  │            ├──────────────────────►│          │ human:reply
  │            │ ④状态：等待人工答复 → 测试中 ────────►│ human:resume
  │◄───────────┤            │           │          │
  │ 用 pipeline_status 看结论，继续干活  │          │
```

**画图要点**：`测试 → 用户` 这条边**不存在**。角色的话到用户面前**必须经过主对话**，
而且是"照抄一段本就写给用户看的文字"—— 这正是 `question_for_human` 被要求
不含代码、必须是问句的原因（主对话不读代码，含代码它转告不了）。

---

## 六·六、★编写席位时序（画成时序图用）

```
编排        主对话      writer#1    writer#2    writer#3    diagrammer   测试/审核
 │            │            │           │           │            │            │
 │ ①writers{count:3,partitions[],reason}
 ├───────────►│            │           │           │            │            │
 │            │ ②逐席位派活（seat=…），各给独立令牌 + 独立会话
 │            ├───────────►├──────────►├───────────►│            │            │
 │            │            │           │           │            │            │
 │            │            │ 写 src/web│ 写 src/api│ 写 docs     │            │
 │            │            │（守门按 scope_paths 判归属；越界即拒）  │            │
 │            │            │           │           │            │            │
 │            │            │ ③dev_to_test(partition 1/3)         │            │
 │            │◄───────────┤  状态**不动**（还差 2 个）           │            │
 │            │◄───────────────────────┤ ③dev_to_test(2/3)       │            │
 │            │            │  状态**不动**（还差 1 个）           │            │
 │            │◄───────────────────────────────────┤ ③dev_to_test(3/3)
 │            ├──状态：开发中 → 待测试（★全部到齐才推进）           │            │
 │            │            │           │           │            │            │
 │            │ ④派架构图 ──────────────────────────────────────►│            │
 │            │            │           │           │  diagram_deliver         │
 │            │            │           │           │  （normify → 映射闸门 →  │
 │            │            │           │           │   archify 四道门 → 收据）│
 │            │◄─────────────────────────────────────────────────┤            │
 │            │  architecture_diagram{diagram_path, receipt_path, sha256}      │
 │            │  ★收据文件不存在 → 拒；自备产物不标 degraded → 拒    │            │
 │            ├──────────────────────────────────────────────────────────────►│
 │            │            │           │           │            │   测试 → 审核
 │            │◄──────────────────────────────────────────────────────────────┤
 │            │ ⑤审核 OK → 关单（★清单里有 diagrammer 就必须已交图）│            │
```

**画图要点**：

1. **三个编写席位之间没有边** —— 它们不直接通信，接缝由编排划界。
2. **"全部到齐才推进"是这条时序里最重要的一条水平线** —— 前两份交上来时状态**一动不动**。
3. **架构图那条边必须标"带收据"** —— 没走 `diagram_deliver` 的图必须显式标 `degraded`，
   否则会被拒。这是"图必须带回执"的落点。

---

## 六·七、★两级升级梯时序（画成时序图用）

```
执行角色      需求分析        主对话         用户        状态机      审计
  │              │              │            │           │          │
  │ ①clarification_request{stage,question,context_digest,blocking}
  ├─────────────►│              │            │           │          │
  │              │              │            │  状态 → 等待需求分析答复 │ clarify:request
  │              │              │            │           │          │
  │         ┌────┴──── 能在需求层定吗？        │           │          │
  │         │            │            │           │          │
  │  能 ────┘            │            │           │          │
  │              │ ②a clarify_reply{verdict:answered, answer, reason}
  │◄─────────────┤              │            │           │ clarify:reply
  │              │              │            │  状态 → 回到被打断前    │ clarify:resume
  │  原地继续干活 │              │            │           │          │
  │              │              │            │           │          │
  │         ┌────┴──── 答不了            │           │          │
  │         │            │            │           │          │
  │              │ ②b clarify_reply{verdict:cannot_answer, reason, escalate:true}
  │◄─────────────┤   （状态先恢复）        │           │ clarify:reply
  │              │              │            │           │          │
  │              │ ③human_request{escalated_from, raised_by, orchestrator_reason}
  │              ├─────────────►│            │           │ clarify:escalate
  │              │              │            │  状态 → 等待人工答复    │
  │              │              │            │  ★previous_state 仍是  │
  │              │              │            │  最初那个工作状态       │
  │              │              │ ④human_relay{照抄给用户看}          │
  │              │              ├───────────►│           │ human:relay
  │              │              │ ⑤用户原话   │           │          │
  │              │              │◄───────────┤           │          │
  │              │              │ ⑥human_reply{user_quote, attribution}
  │              │              ├───────────────────────►│ human:reply
  │              │              │            │  状态 → 最初工作状态    │ human:resume
  │◄─────────────┴──────────────┤            │           │          │
  │  用 pipeline_status 看结论，继续干活      │           │          │
```

**画图要点**：

1. **执行角色到用户之间没有直连边** —— 必须经过需求分析那一列。这是这一节的全部意义。
2. **"能在需求层定吗"那个判断是分叉点** —— 左边（能）是**常态**，右边（不能）才是例外。
   画图时把左边画粗一点，视觉上表达"大多数问题到此为止，用户不该被打扰"。
3. **②b 之后状态先恢复、再由 ③ 推进** —— 这是实现上的顺序（裁定先落、升级再发），
   画成两条背靠背的边即可。
4. **③ 那条边旁务必标注 `previous_state 不覆盖`** ——
   否则看图的人会以为恢复目标是 `awaiting_clarification`（那正是永久卡死的成因）。

---

## 七、配色建议（画图时用）

| 层 | 建议色 |
|---|---|
| L5 交互层 | 深蓝 |
| L4 角色层 —— 控制类（main / orchestrator / human） | 靛紫 |
| L4 角色层 —— 执行类（writer / tester / reviewer） | **三色区分**：编写=绿、测试=橙、审核=青 |
| L4 角色层 —— 咨询类（architect / security / release / docs / performance / arbiter） | 灰蓝 |
| L3 工具层 | 浅灰 |
| L2 机制层 | 琥珀 |
| L1/L0 宿主 | 中性深灰 |
| ★用户 ↔ 主对话 | **粗实线双向**（这是唯一一条连到用户的线，画粗一点） |
| ★角色 → 主对话（人工介入） | 蓝色实线向上（①②③④ 四步可以标号） |
| ★执行角色 → 用户 | **不画**（不存在这条线） |
| ★编写席位 | 每个席位一个节点，**同一颜色不同深浅**（同角色不同实例）；范围标在节点旁 |
| ★席位之间的边 | **不画**（分区不重叠、互不通信；接缝由编排划界） |
| ★架构图边 | 蓝色实线，边旁标「带收据 / 或 degraded」 |
| ★两级升级梯 ①② | 绿色实线（**内部解决**，用户不受打扰） |
| ★两级升级梯 ③④⑤⑥ | 橙色实线（**升级到用户**，是例外路径） |
| ★L0 直发 human_request | **橙色虚线**，边旁标「仅 L0」 |
| ★等待态 | `awaiting_clarification` 与 `awaiting_human` **两个节点，不要合并** |
| ★安全确认节点 | 用**盾牌/闸门**形状；放在「审核中」之后、「已通过」之前 |
| ★安全否决边 | **红色实线加粗**（一票否决，与普通拒绝的虚线区分开） |
| ★扫描工具 | 边上标注「只扫本任务工作区 / 结果打码」 |
| ★需求档节点 | **画成一个公共节点**（所有角色都指向它），别在每条边上挂副本 |
| ★水位档位 | 绿（正常）/ 黄（预警 45%）/ 橙（触发继任 55%）/ 红（硬限 75%） |
| ★继任边 | 橙色实线，标「世代 +1 / 状态不变」；旧席位那条画成被切断的红虚线 |
| ★水位上报边 | 从席位指向**编排 AI**（不是主对话）—— 这条画错整张图的语义就反了 |
| ★需求档写入边 | **只从留档 AI 出发**（唯一写者）；读的边从所有角色汇聚过去 |
| ★records 边 | 每个角色 → `records/<自己>.md`（**各写各的**，互不交叉）；再由留档 AI 汇聚成 `requirement.md` |
| ★广播边 | 从**新编排**扇形连到所有已绑定席位，标「新联系人 = X」；旧编排那条画成切断 |
| ★主对话 | 只画「跟踪 / 更新状态 / 关单」三条边；**不要**给它画分配相关的边（除了编排席位兜底那一条虚线） |
| **拒绝路径** | **统一红色虚线**，边上标反例编号 ①~⑭ |
| 审计/留痕的写入边 | 虚线灰 |

---

## 八、一页纸版本（贴在墙上那种）

```
                    ┌──────────────────────────────────────┐
                    │  用户（**只有一个对话框**）            │
                    └──────────────────┬───────────────────┘
                                       │ ⇅ 双向：转告 / 听答复
                    ┌──────────────────▼───────────────────┐
                    │  主对话：只调度，不干活                 │
                    │  · 不读/不写/不测/不审                 │
                    │  · 不判断要几个 AI                     │
                    │  · ★是**唯一**能对用户说话的会话        │
                    └──────────────────┬───────────────────┘
                                       │ 只按清单派活
                    ┌──────────────────▼───────────────────┐
                    │  编排判断：要几个 AI、谁、顺序          │
                    │  L0=4 L1=5 L2=6 L3=7 L4=8             │
                    └──────────────────┬───────────────────┘
                                       │ 角色清单
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
      ┌───────▼──────────────────────────────┐ ┌───────▼──────────┐ ┌───────▼──────────┐
      │  编写（★1~3 个席位，各写各的一段）      │ │  测试             │ │  审核            │
      │  writer#1 → src/web                  │►│  独立验证         │►│  核对 + 放行      │
      │  writer#2 → src/api   彼此无边        │ │  不改代码         │ │  不改代码         │
      │  writer#3 → docs      全到齐才推进    │ │                  │ │                  │
      └──────┬───────────────────────────────┘ └────────┬─────────┘ └────────┬─────────┘
             │                                          │                    │
             │  写完 → 架构图角色（★编写之后）             │                    │
             │  出图必须带回执（收据 或 标 degraded）      │                    │
             │                       │ 不通过→打回编写        │ OK
             │                       │                       │
             │  ★卡住了、拿不准了、发现需求有歧义了            │
             │  只能向上发起 human_request（它们**没有**用户的对话框）
             └───────────┬───────────────────────────────────┘
                         │ ① 发起（状态 → 等待人工答复）
                    ┌────▼───────────────────────────────────┐
                    │  主对话：② 照抄给用户看 → ③ 记用户原话   │
                    │          → ④ 据答复恢复（回到被打断前）  │
                    └────┬───────────────────────────────────┘
                         │
                    ┌────▼───────────────────────────────────┐
                    │  主对话关单 —— 必须先看到审核 OK         │
                    │  没有 OK：拒绝，并告诉你判据是什么        │
                    └────────────────────────────────────────┘
```

---

## 九、★第九轮增补：需求 → 确认 → 计划 → 按层编写（画图用）

> 第八轮之前那几节里凡是写「编排判断」的地方，本轮都要读成**两个角色**：
> `orchestrator`（需求分析）与 `planner`（计划）。取舍理由见 `REPORT.md` 第十八节。

### 9.1 拓扑变化（**本层新增两个节点、拆掉一个旧节点**）

| 动作 | 节点 id 建议 | 标签（zh） | 说明 |
|---|---|---|---|
| **删** | ~~`orchestrator:编排判断`~~ | — | 旧节点"需求分析/编排判断"不存在了，**不要**再画成一个圆角矩形 |
| **加** | `role:orchestrator` | 需求分析 | 出任务卡 / 验收标准 / 边界 / 测试要点 + **不清楚处清单**；仍是澄清梯第一级 |
| **加** | `role:planner` | 计划 | 出计划 → 自检 → **分配 AI**（角色清单 / 几个 AI / 派谁 / 顺序） |
| 改标签 | `role:human` | 人工（用户） | 它现在有一个**固定**入口（需求确认），不再只是"异常出口" |

### 9.2 主链（开工前四步，**顺序不能反**）

```
主对话 --dispatch_orchestrator--> 需求分析
需求分析 --requirement_analysis（含 unclear_points）--> 主对话
需求分析 --human_request(reason_kind=requirement_confirmation)--> 主对话 --转告--> 用户
用户 --human_reply（原话 + 归属）--> 主对话
主对话 --requirement_confirmed（★ guard：必须有用户答复）--> 待计划
主对话 --dispatch_planner--> 计划
计划 --plan（含 self_check）--> 主对话
计划 --setRoster（judged_by=planner）--> 角色清单 --> 待开发
```

**★ 画这张图时最容易画错的三处：**

1. **需求分析 → 用户 之间没有直连**。它只能 `human_request` 给主对话，
   由主对话转告。用户只与主对话相连这条拓扑约束**没变**。
2. **`已经确认` 那条边是机制，不是礼貌**。图上要标出 guard 名
   （`requirement_confirm_gate`），并注明"判据是 `status='answered'`，只认答复不认转告"。
3. **计划 → 角色清单是同一个角色一口气做完的**（`plan` + `orchestration` 两份交接物），
   不要画成两个节点。

### 9.3 计划缺失回流（**复用**第一级梯，不要画第二条通道）

```
计划 --plan(self_check.verdict=gaps + gap_question)--> 等待需求分析答复
等待需求分析答复 --clarification_reply(answered)--> 计划中（原地继续）
等待需求分析答复 --clarification_reply(cannot_answer)--> 需求分析 --human_request--> 主对话 --> 用户
用户答复 --> 回到**最初**被打断的工作状态（计划中）
```

- 状态 id 就是**既有的** `awaiting_clarification`，标签「等待需求分析答复」——
  **不要**为它新画一个状态框。
- 回流那条边上要标 `plan_gap`（事件名）；`self_check.verdict=gaps` 时
  `setRoster` 会被拒（两道闸：状态机 + 角色清单写入）。

### 9.4 按层分工（编写席位的画法要改）

```
计划 --writers{layers:['interface','data','logic'], partitions[...]}--> 编写角色
编写角色 --(层)--> 编写席位 writer#1（接口层）
编写角色 --(层)--> 编写席位 writer#2（数据层）
编写角色 --(层)--> 编写席位 writer#3（处理层）
各席位 --dev_to_test（partition{seat, layer, scope_paths}）--> 测试
```

画法要点：
- 每个席位框里写三行：`席位 id` / `层` / `scope_paths`。
- **层不是"权限"**：越界写执法仍然靠 `scope_paths`（守门 `owningSeat`）。
  图上别把"层"画成一条能挡住写入的闸 —— 挡住写入的是路径分区。
- `count=1` 的退化形态：一个席位，层写 `all`，范围写"整棵项目根"。

### 9.5 状态机增补（给画状态图的会话）

| 增/改 | 内容 |
|---|---|
| 加状态 | `ready_plan`（待计划）· `planning`（计划中） |
| 删边 | ~~`analyzing --orchestrated--> ready_dev`~~ |
| 加边 | `analyzing --requirement_confirmed(main, guard=requirement_confirm_gate)--> ready_plan` |
| 加边 | `ready_plan --dispatch_planner(main)--> planning` |
| 加边 | `ready_plan --dispatch_orchestrator(main)--> analyzing`（用户不认可时退回重做分析） |
| 加边 | `planning --planned(planner, guard=plan_ready)--> ready_dev` |
| 加边 | `planning --plan_gap(planner, guard=plan_gap_gate)--> awaiting_clarification` |
| 保留 | `pending --orchestrated(rule-engine)--> ready_dev`（**L0 专用**，两件事都由规则引擎承担） |

### 9.6 设计目的的边界（**画"不能"的边**，本轮同批追加）

用户原话：「分开跑项目的目的是让 ai 别过度工程化，要求只干自己该干的，
编程别跑测试，编排别看代码」。图上要有下面这六条**禁行边**（每条都标判据）：

| 从 | 到 | 边型 | 标签 | 判据（写在边上） |
|---|---|---|---|---|
| 编写 | 测试运行器 | **禁行** | 不跑测试 | `scanTestRunnerCommand`：`npm test` / `pytest` / `node --test` / `node tests/*` / `--coverage` |
| 编写 | 测试产物流水线 | **禁行** | 不交测试报告 | 白名单里没有 `test_to_review` / `test_to_dev`；`dev_to_test` 不许夹带 `test_cases` / `pass_evidence` / `verdict` |
| 编写 | 构建/冒烟 | **放行** | 可以构建 | `npm run build` / `node build.mjs` / `node -e …` / `tsc --noEmit`（⚠️ 最小限度待拍板，见 README P1） |
| 测试 | 测试运行器 | **放行** | 这是它的活 | 同一条命令，`tester` 跑放行 —— **拦的是职责，不是命令** |
| 主对话 / 需求分析 / 计划 | 源码树 | **禁行** | 不看代码 | `NO_CODE_READ_ROLES`：读工具 + 检索工具（`grep`/`findstr`/`Select-String`）+ shell 读 |
| 主对话 / 需求分析 / 计划 | `.pipeline/`（需求档 / 交接物 / 记录 / 摘要） | **放行** | 这是它们该看的 | 路径判据：`isInside(task.pipelineDir)` |

**另加两条"面与边界"的边**（用户原话：**修一个 bug 就别该整个模块**，
分析和计划 AI **确认他们只干什么，不要多干**）：

| 从 | 到 | 边型 | 标签 | 判据 |
|---|---|---|---|---|
| 编写 | 授权面**之外**的任何路径 | **禁行** | 改动面 = 授权面 | `change_scope` 逐条核对（`owningChangeScopeEntry`）；**新增文件也算越界**；`create` 授权不得用于改已存在文件 |
| 编写 | `.pipeline/` 台账 | **放行** | 台账不算改动面 | 与分区判据同一豁免 |
| 编写 → 测试 | 交接物 | **必填** | 实际改动面 | `dev_to_test.change_manifest`：每条必须引用一个授权条目（`scope_id`）⇒ 每处改动都有授权来源 |
| 计划 AI | 审核结论 | **禁行** | 越界事实不得带过审 | `scope_conformance.within_scope=false` ⇒ `review_verdict` 直接拒 |
| 计划 AI | 每个执行角色 | **唯一边** | 边界卡 | `plan.role_boundaries` **必须覆盖 roster 的每个执行角色**（`setRoster` 核对）；`pipeline_dispatch` 把该角色的卡贴进派活单 |
| 需求分析 | 分配内容 | **禁行** | 那不是我该定的 | `scanRequirementAnalysisForAllocation`：产物里出现"派谁 / 用几个 AI / 档位 / 角色清单" ⇒ 拒 |
| 需求分析 / 计划 | 自己的产物 | **必填** | 职责自限声明 | `role_scope { will_do, will_not_do }`，两栏都要有内容（`will_not_do` 空 ⇒ 拒） |

**再加三条"双轨 + 基线 + 只读"的边**（用户原话：**审核 ai 要一起配合确认有没有多改**；
**审核 ai 只读，只有属于他的日志文件有权限写入**）：

| 从 | 到 | 边型 | 标签 | 判据 |
|---|---|---|---|---|
| 计划 AI | 编写 **与** 审核 | **双轨（同时）** | 一起接任务 | `pipeline_dispatch role=writer` + `role=reviewer` **都在 `ready_dev` 就能派**；审核的派活单里附开工前简报（授权面 / 越界清单 `plan.forbidden` / 边界卡 / 基线） |
| 审核 | 审核结论 | **禁行（开工前）** | 只是知情，不是判定 | `review_verdict` 仍只在 `reviewing` 可交（状态机没动）⇒ 双轨 ≠ 提前判定 |
| 计划 AI | 项目根快照 | **一次**（派活那一刻） | 改动基线 | `pipeline_plan` 自动 `takeBaseline`：文件清单 + 每文件 sha256（**不复制源码**）+ 绑定 plan handoff id |
| 审核 | 当前状态 | **只读对比** | 前后版本对比 | `pipeline_change_audit` 按基线逐文件比 ⇒ 多改 / 少改 / 改错地方；结论进 `review_verdict.change_audit`，store **自己重算核对** |
| 审核 | 任何写入位置 | **禁行** | 只读 | `writes: 'own-log'`：**只有** `.pipeline/<任务>/reports/reviewer/reviewer.log\|.jsonl` 可写；`reports/` 下别人的文件、源码、需求档、别的任务目录**全拒** |
| 编写 | 改动基线 | **禁行** | 不能自己重设基准 | `pipeline_change_audit { take: true }` 只有计划 AI / 主对话能调（否则可以洗掉越界痕迹） |

**另加一条"产物"边**：控制角色（需求分析 / 计划）→ 任何下游，
若产物里出现代码正文（任务卡 / 分析依据 / 不清楚处 / 计划理由 / 自检说明），
该交接物**拒收**（`scanControlRoleProductForCode`）。

**画法提醒**：

- 这两条"禁行"是**开环的 best-effort**（shell 侧字符串匹配）—— 图上建议用虚线 + 注一行
  "形式化保证需要环境侧不给（测试环境 / 源码挂载）"。
- `glob` / 列目录**不画成禁行**：它们只给文件名，不构成"看代码"。
  把"知道有哪些文件"也拦掉，只会让计划 AI 做出更不合实际的计划 —— 那是另一种过度工程化。
- 边界画在**路径**上（源码树 vs `.pipeline/`），不画在"人"上。
- ★ 规则③的边要画成**两层**：`scope_paths`（你负责哪一块，长期）+ `change_scope`
  （这次允许动哪些，本轮）—— 写入要**同时**满足两者，不是二选一。

> 可执法清单：规则①② `tests/boundary-check.mjs`（42 条）、规则③④ `tests/scope-check.mjs`（28 条）。

### 9.7 明确**不该**画的东西

- 不要画「需求分析 → 用户」的直连（没有这条边）。
- 不要画「计划 AI 直接找用户」的边（会被 `MUST_ASK_ORCHESTRATOR_FIRST` 拒）。
- 不要画第二个人工介入通道（需求确认**就是** `human_request` 链，不另开）。
- 不要画「主对话决定要几个 AI」（它从来没这个权力，本轮更明确）。
- 不要给 L0 画需求分析与计划两个节点（L0 是规则引擎自批，仍是 4 个对话）。

---

## 十、★ 官方 Agent Teams 通道（本轮新增，画图用）

**背景**：DSH 0.2.1 起官方带「智能体团队」：根会话是 Lead，可 `spawn_teammate` 出具名、
持久、可续接的 teammate。本插件把它接成**第三条真实通道** `transport: 'team'`（前两条：
`session` 一等公民会话、`subagent` 子代理）。**默认仍是 `auto`（session 优先），本通道只在
显式配置或 `teamAuto: true` 时启用** —— 画图时不要把它画成默认路径。

### 10.1 拓扑变化（**只加一层，不改主轴**）

```
主对话（根会话 = 官方 Team Lead）
   │  pipeline_dispatch（既有）
   ▼
Transport 选择点 createTransport()          ← 唯一选择点，没变
   ├─ session  ──► sessionController.create（既有）
   ├─ subagent ──► ctx.subagents（既有）
   └─ team ★新增 ──► ctx.agentTeams
                        ├─ spawnTeammate(caller=主对话…) → 具名 teammate（subagent 延续子会话）
                        ├─ sendMessage(caller, {target, content}) → 投消息 / 唤醒 / 催办
                        └─ interrupt(caller, name) → 打断（{stop:true} 那条路）
```

★ **teammate 不是侧栏一等公民会话**：它是 `origin=subagent` 的延续子会话，出现在官方
Team 名单里、可地址、可续接。图上把 `team` 通道的产物画成「官方 Team 成员」节点，
**不要**和 session 通道的「侧栏会话」节点画成同一个东西。

★ **角色预设不下发**（官方 `spawnTeammate` 没有 agentPreset 参数）：teammate 继承 Lead 的
preset；角色人格由**派活单正文**补（`lib/team/brief.js` 读 `presets/src/<role>/`）。

### 10.2 节点清单（画图用）

| 节点 | 落点 | 说明 |
|---|---|---|
| `TeamTransport` | `lib/transport/team.js` | 通道实现：`spawnRole` / `notifyRole` / `interrupt` / `listMembers` |
| `team 命名` | `lib/team/naming.js` | `(task, role, seat)` → lower-kebab 名字；重派 `-rN`；官方名字永不重用 |
| `team 探测` | `lib/team/preflight.js` | `ctx.get('agentTeams')` 的可用性与缺件报告（不抛） |
| `角色人格注入` | `lib/team/brief.js` | 派活单 = `renderDispatchBrief` + `presets/src/<role>/` 的 prefix+prompt+suffix |
| `四槽补钉` | `lib/team/slots.js` | `mode` 恒 UNAVAILABLE；permission/model spawn 后钉 + 读回 |
| `任务板镜像` | `lib/team/board.js` + `board-state.js` | pipeline 任务 ↔ 官方 `team_task_*`，best-effort |
| `官方工具分类` | `lib/guard/official-tools.js` | team 协作 / 委派 / 插件管理 / 会话搜索四类拒绝名单 + shell 正文补扫 |

### 10.3 边清单（画成箭头）

| 从 | 到 | 边型 | 标签 | 判据 |
|---|---|---|---|---|
| `createTransport` | `TeamTransport` | 选择 | `transport:'team'` 或 `auto && teamAuto` | `lib/transport/index.js` 的唯一选择点 |
| `pipeline_dispatch` | `TeamTransport.spawnRole` | 调用 | 派活 | `spec.parent` 必须是**活 Lead Agent**（官方凭据），否则 `TEAM_NO_LIVE_CALLER` |
| `spawnRole` | `ctx.agentTeams.spawnTeammate` | 调用 | 建 teammates | 同名已存在 ⇒ **复用**并改走 `sendMessage`（不重复 spawn） |
| `notifyRole`（催办 / 孤儿重投 / 失联唤醒） | `ctx.agentTeams.sendMessage` | 投递 | 唤醒 | 按 sessionId 反查名单拿名字；超 64KB 截断并注明 |
| `notifyRole{stop}` | `ctx.agentTeams.interrupt` | 打断 | 停手 | 官方 `interrupt` 失败 ⇒ **不假装成功** |
| `store.open` | `board.mirrorOpen` → `createTask` | 镜像（虚线） | 辅助面 | best-effort：失败只写 `audit.jsonl` 的 `team:board-error` |
| `spawnRole` | `board.mirrorDispatch` → `updateTask(reassign)` | 镜像（虚线） | 辅助面 | revision CAS，冲突重读重试一次 |
| `store.close/cancel` | `board.mirrorClose` → `updateTask(complete)` | 镜像（虚线） | 辅助面 | 只从 in_progress 能 complete；未派活就取消 ⇒ 先 claim 再 complete |
| 绑定角色（非 main） | 官方四类工具 | **禁行** | 绕过三权分立 / 旁路 | `officialDenyForRole(role)`；席位工具面同时隐藏（`restrict({deny})`） |
| `terminal_send` | 源码树 | **禁行（best-effort）** | 持久终端不能当 shell 旁路 | `text` 参数进命令扫描（`SHELL_TEXT_ARG_TOOLS`） |

### 10.4 画法提醒

- **任务板镜像画虚线**：它不是流水线权威状态（权威永远在 `.pipeline/<任务>/task.json`），
  失败不影响主流程。
- **四槽图**：`mode` 那一格画成「官方不支持 · 未下发（UNAVAILABLE）」，别画成绿勾；
  `permission` / `model` 画成「spawn 后补钉 + 读回」。
- **别画「team 通道 = 侧栏多会话」**：验收词是「官方 Team 名单里出现具名 teammate、消息可达」。
- **别画「机制自愈在 team 通道派新席位」**：机制发起没有活 Lead Agent，明确失败（图上是断开）。
- 名额上限（官方 `maxMembers`）画一条**容量边界**：到顶就派不出去，只能新开会话或调大配置。