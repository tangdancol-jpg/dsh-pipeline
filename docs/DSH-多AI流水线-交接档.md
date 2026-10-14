# DSH 多 AI 协作流水线 —— 交接档

> 生成时间：2026-10-11 06:2x（本地）｜生成者：Computer Use 会话「在D盘tool部署ComfyUI」
> 生成原因：**本会话上下文已到 ~60%（累计 146M tok）**，按项目自身规则（45 预警 / 55 触发继任 / 65 硬限）提前交接。
> 接手者请**先读本档再动手**；本档是权威入口，细节以仓库内文件为准。

---

## 0. 一句话现状

在给 DSH 做**两个插件**，都服务于同一目标：**让 AI 干的活得能查账**。

| 插件 | 是什么 | 状态 |
|---|---|---|
| `dsh-archigate` | 可信架构图交付：normify 校验 → 映射闸门 → archify 四道门 → 交付收据；外加硬拦截"绕过流程出图" | **已装 0.5.0**，但 **JS 改动需重启 DSH 才生效** |
| `dsh-pipeline` | 多对话协作流水线：主对话只调度不干活；编写/测试/审核三权分立；编排决定用几个 AI | **未安装**（源码与自测完成，仍在追加需求） |

---

## 1. 关键路径（照抄可用）

### dsh-pipeline（未装）
- 源码：`<DSH_HOME>\dsh_orb\新任务-为-dsh-写一个插件-实现用户要的-多对话-ai-协作开发流水线-主对\dsh-pipeline`
- 含：`index.js` / `lib/`（roles·states·tiers·handoff·tools·guard·tokens·store·transport）/ `tests/` / `README.md` / `ARCHITECTURE.md` / `REPORT.md` / `install.ps1` / `rollback.ps1`

### dsh-archigate（已装 0.5.0）
- 源码：`<DSH_HOME>\dsh_orb\写一个-dsh-插件-把-normify-建树校验-archify-渲染交付-这\dsh-archigate`
- 安装副本：`<DSH_HOME>\profiles\desktop\node_modules\dsh-archigate`（与源码逐文件哈希一致；node_modules 内有 4 份 `.bak-*` 可回滚）
- 结构数据：`<HOME>\Documents\deepseek-harness\default-workspace\normify-dsh-archigate`（32 模块）、`…\normify-dsh-pipeline`（20 模块）

### 交付产物（HTML + 收据）
- 架构图（8 组件）/ 小白版 / 带解释版：`…\dsh_orb\任务-收尾并复验一个已写好的-dsh-插件-dsh-archigate-然后-用\archify-deliver\out\` 与 `…\dsh_orb\dsh-archigate-arch\`
- **流程图 v1/v2/v3**：`…\dsh_orb\dsh-pipeline-flow\`（v3 = 25/25 节点机制级命中；收据在 `.receipts\`）

### profile 三个配置（改动前必须备份）
`<DSH_HOME>\profiles\desktop\{cordis.yml, cordis.patch.yml, package.json}`
- `cordis.yml` 现在是**空根**（注释写明 "Edit cordis.patch.yml, not this file"）—— **不要往里写**
- 现有 bundles 13 项（含 `dsh-archigate`）；`dsh-pipeline` **出现 0 次**（未装）

---

## 2. 用户拍板的设计决定（别自作主张改）

1. **主对话只调度不干活**：接需求、跟踪状态、关单；不读代码、不写代码、不测试、不审核。
2. **「分配 AI」= 编排 AI**（`orchestrator`），**与主对话是两个角色**。角色清单、用几个 AI、派谁，**全部由编排决定**；主对话只按清单执行与跟踪。
3. **三权分立**：编写 → 测试 → 审核**单向**；**审核发 OK 主对话才能关单**；打回按规则走。
4. **人工介入是两级梯**：执行角色 → **需求分析/编排**（能答就答）→ 答不了才 → **主对话 → 用户**（用户的对话框只在主对话里，任何角色不得直接对用户说话）。
5. **需求留档**：各 AI **独立落档**（`records/<role>-<seat>`）→ **带席位密钥提交** → **新增「留档 AI」（archivist）收集并统一编写**成唯一的 `<项目根>/.pipeline/<taskId>/requirement.md`；**留档 AI 是唯一写者**，其他角色只读；版本化可追溯；矛盾不得自己拍板。
6. **上下文水位三级：45% 预警 / 55% 触发继任 / 65% 硬限**。
7. **继任 = 席位换班，不是角色变更**；**编排自己也会继任**（就近新建编排 + **广播新联系人** + 交接要带走"待处理请求队列"）。
8. **审核必须确认网络安全 / 本地泄密是否发生**（结构化 `security` 段；`unknown` 不许通过；有未解决 finding 不许关单）。
9. **图必须带回执**：走 `diagram_deliver`；映射闸门要求"图上每个组件都能对上代码模块"。
10. 8 项待用户拍板：通信通道（subagent/manual）、测试环境谁提供、OK 标准格式、最大打回次数（默认 2）、人工介入点、制品存放、权限控制（`requireAgentBinding`）、`requireHumanConfirmCode` 默认开关。

---

## 3. 纪律与已踩过的坑（**违反会出事**）

1. **任何时刻只允许一个流程写 profile** —— 曾因并发写导致 DSH 配置被写坏、**整个 DSH 崩了一次**（05:03 那次）。
2. **小步走**：单次工具参数别塞太大（一次塞 17 个模块的 batch、超长规格都触发过 `MALFORMED_RESPONSE: tool input is invalid JSON`，整轮中断零产出）。规格类内容**走文件路径传参**，别用内联全文。
3. **`.ps1` 必须 UTF-8 with BOM** —— 本机只有 PowerShell 5.1，无 BOM 会按 ANSI 解码直接语法崩。
4. **archify 的交付类子命令被本机守门拦着**（具体名单见 `dsh-archigate\README.md`）；**交付只能走 `diagram_deliver`**；只读子命令（`validate` / `inspect` / `guide` 等）可以随便用。
   - ⚠️ 已知假阳性：**文档正文里提到那些子命令名**也可能被"原文兜底判据"拦下（连无关路径都会被当成"规格文件"）。写文档时避免把命令名与 archify 挨着写。
5. **不要给 archify 造 git 仓库或填假 revision** —— 曾有人为过"仓库证据"门临时 `git init` + 伪造提交，已被 v0.5.0 判据识别（占位远端/证据型提交/伪造身份/硬编码日期/无历史），并如实记为"无来源"。那次伪造的 `.git` **已删**（源码逐字节未变）。
6. **DSH 没有窗口级顶栏槽位**（Windows 上 `shell.leading` 不渲染）；可用挂载点是 `conversation.session.header.utilities`（右侧栏切换按钮左边一格）。
7. 安装脚本别把 `examples/`、`tests/` 复制进 `node_modules`（体积）。

---

## 4. 正在跑的后台会话（用 `code_agent_status` 复核）

| 会话 | 在做什么 |
|---|---|
| `<session-id>` | dsh-pipeline 追加需求，**队列 5 轮**：①建筑图角色+编写 1~3 席位 ②两级升级梯 ③安全确认 ④需求留档+水位继任 ⑤留档 AI + 编排继任广播 |
| 其余 | `a9dbc5e5`（archigate 0.5.0，已完成）、`2de77f0c`（流程图 v1~v3，已完成）、`a770b287`/`ac1232f3`/`dda53e5a`（架构图与小白版，已完成）—— 均 idle |

**⚠️ 注意**：`<session-id>` 自己也可能上下文变长 → 若产出质量下滑，按 §5.2 拆会话。

---

## 5. 待办（按优先级）

1. **等 `<session-id>` 当前轮结束** → **逐条验收**（核源码与自测，不要只信汇报）→ 输出"已完成/未完成"清单。
2. **拆会话**：把剩余轮次交给新会话（用本档 + 仓库内 README/REPORT 交接）。
3. **安装 dsh-pipeline**（`install.ps1`，UTF-8 with BOM；先备份 profile）→ **重启 DSH** → archigate 0.5.0 同时生效。
4. **装完必做的正例反例实测**（缺一不可）：
   - 正：count=1 跑完整流程（老行为没坏）；count=3 分工 → 全到齐才推进；编排 → 编写 → 测试 → 审核 → **OK 才关单**
   - 反：编写直接交审核 → 拒；无 OK 关单 → 拒；测试/审核改代码 → 拒；主对话读代码正文 → 拒；主对话自行增删角色/参与继任 → 拒；打回超限 → 拒；水位未上报就继任 → 拒；无需求档开工 → 拒；安全段 `unknown` 或带 finding 关单 → 拒
5. **验收标准以用户原话为准**（见 `dsh-pipeline\README.md` 与 `REPORT.md`）。

---

## 6. 给接手者的第一步（3 个动作）

1. 读本档；再读 `dsh-pipeline\README.md` 与 `REPORT.md`（最新状态在那里）。
2. `code_agent_status` 看谁还在跑；**不要同时写 profile**。
3. 从 §5 第 1 条开始：**验收**，不要从头重做。
---

## 7. 终版增补（2026-10-11 06:4x）—— 两个插件最终状态

### dsh-pipeline（未安装，源码就绪）
- **工具 25 个**（初版 13 → 25）：`task_open` / `orchestrate` / `dispatch` / `bind_role` / `handoff` / `transition` / `rework` / `close` / `status` / `roster_request` / `roster_review` / `artifact` / `selftest` / `switch` / `record_submit` / `compile_requirement` / `contacts` / `context_report` / `succession` / `security_check` / `clarify_request` / `clarify_reply` / `human_request` / `human_relay` / `human_reply`
- **角色 13 个**：main / orchestrator / architect / security / writer / tester / reviewer / release / docs / performance / arbiter / human / **archivist（留档，新增）**
- **状态机**：新增 `awaiting_human`（等人）与 `awaiting_clarification`（等需求分析），恢复均回 `(previous)`
- **规模**：59 个文件 / 1.6 MB；`README.md` 98 KB · `ARCHITECTURE.md` 78.7 KB · `REPORT.md` 222.5 KB（第十五节起是各轮更正的取舍记录）
- **已落地机制**：编写 1~3 席位与分区执法 · 架构图角色（图必须带回执，降级要标 `degraded`）· 两级澄清梯（角色→编排→主对话→用户）· 安全确认（网安/本地泄密，`unknown` 不许通过）· 需求留档（各角色独立 `records/<role>[-<seat>].md` → **留档 AI 唯一写 `requirement.md`**）· 上下文水位 45/55/65 与继任 · **编排自身继任 + 自动广播新联系人**（交接必须带 `pending_requests`）· `pipeline_contacts` 查当前编排

### dsh-archigate（已装 0.6.0，**需重启生效**）
- 判据从"词共现"改为"**调用形态**"；假阳性消失、且**顺带补上一个既有漏拦**（`只读调用 && 交付调用` 曾停在只读那次上放行真调用）
- 映射闸门**与图型无关**（`components`/`nodes`/… 取第一个非空集合）；**读不到集合 → 硬拒绝，不许 0/0 空过**
- 证据判据：占位远端 / 证据型提交 / 伪造身份 / 硬编码日期 / 无历史 → 一律"不可信 + 说明原因"；**不阻断交付**
- 参数形状：`spec_path` 首选、内联规格 8KB 护栏
- **我亲跑 `bin/archigate.mjs selftest` → 全部通过（66 项），exit 0**；源码与安装副本逐文件哈希一致；node_modules 内 5 份 `.bak-*` 可回滚

## 8. 已知问题（**接手者必读**）

1. **`records` 套自测有状态依赖**：单跑 22/23（失败项「对照：写自己那份记录是允许的（守门不挡）」），全量 23/23。疑似**守门的同步索引空窗期**（守门要同步查任务索引，任务数据异步从盘上读；未预热时可能误拦）。**已派修**：要求查清根因、让用例自包含可重复、**不许靠删断言掩盖**（若根因是空窗期，就把它写成显式覆盖的已知限制）。**不影响交付，但接手时务必复跑三次确认。**
2. 守门"原文兜底判据"曾把**文档正文里提到的子命令名**当成真调用（假阳性，0.6.0 已修）；写文档时仍建议避免把命令名与 archify 挨着写。
3. 裸 `archify` + **零参数**的调用漏拦（只打印 usage、不产出交付物，低危）；变量持有 CLI 名（`node "$CLI" …`）**本来就拦不住**，与改动无关。
4. archigate 的 JS 改动**需重启 DSH 生效**（0.6.0 已就位）。
5. `<session-id>` 产出量很大（`REPORT.md` 222 KB），接手时**优先读 README 与 REPORT 最新节**，不要从第一节顺序读。

## 9. 下一步（不变）

安装 `dsh-pipeline` → 重启 DSH（同时让 archigate 0.6.0 生效）→ **正例反例实测**（清单见 §5.4）→ 通过后把"多 AI 协调"开关打开试一次真需求。

---

## 10. 图尺寸硬上限（v4 阻塞的实测结论，**接手者必读**）

**结论**：`browser-check` 给"一张 archify 图能画多少"定了个**硬上限**，超过就只能拆成多张图。

### 已证伪的路
- **多视图：不支持**。`skills\archify\schemas\README.md` 明写 **"`meta.views` is retired … renderers ignore it; do not author it"**；且 `browser-check` **按整张 canvas 判**，不按视图。→ 拆视图这条路不通。
- **`workflow` 型（26 节点 / 25 边 / 6 泳道）**：反复卡在 `workflow/solver-budget-exhausted`（某条边"no feasible readable-v2 automatic route"）。**v3 能过是因为它的几何恰好落在求解器可解集里**；换了泳道序/行高层级就不在可解集。
- **`architecture` 型（显式几何，26 组件 / 31 连接）**：两个约束**互斥**——
  - 紧凑（2000×826）：只差一点 —— 投影 **4.89px < 6px**（1440 视口）/ 5.48px（1600）
  - 放宽（1850×1050）：退化成 `clean-flow/edge-through-node` 成堆
  - **数学**：1440 视口下舞台宽 1346px，`投影 = 字号 × min(1, 舞台宽 / viewBox 宽)`；要让 10px 的**边标签**投到 ≥6px，**viewBox 宽须 ≤ ~1800**；而该宽度下 26 个 300×96 盒子必然密集 → **边穿框**。放宽到不穿框须 ≥ ~2200 → 投影 ≤5px。
  - **卡的是"边标签"的字号下限**（不是节点字号）；而 `connections` 在 schema 里**没有字号字段**，IR 层调不动。

### 试过且均未过的方案（实测）
8 泳道平铺（5622 高）· 7 泳道（4147×2359）· 6 泳道低叠（2307 高）· 5 泳道 42→41→26 节点 · 去掉全部 `width/height` · 6 种泳道顺序 · architecture 2000×826 / 2200×1000 / 1850×1050 · 边降级成标签（减 6 节点）· 标签自动避让（脚本迭代，标签重叠已全清）。

### 可用数字（供以后设计图用）
- **最小可行节点数 ≈ 25**（与 v3 同量级），且必须沿用 v3 那套几何家族（状态轨 + 3 执行角色 + 少量出口，gate 类降级为边标签）
- `browser-check` 的 `MIN_PROJECTED_NODE_TEXT_PX = 6`（`renderers/shared/<redacted>.mjs:5`）
- `layout/constraint`：连线直线段 **≥24px**；`clean-flow`：与无关组件 **≥2px 净空**
- `workflow` v2 自路由：端点 stub **≥8px**、中间转折段 **≥16px**

### 因此的路线
**「从需求到关单」这张生命周期图以 v3 为准**（四道闸门全过、25/25 节点机制级命中），它之后新增的机制**另出独立图**（各自交付、各自带收据），例如：
- 「留档与继任」——各角色 `records/` → 留档 AI 唯一写 `requirement.md`；45/55/65 → 继任 → 广播新联系人 · `pending_requests`
- 「异常与人工」——打回 · 两级澄清梯 · 人工介入 · 安全确认不通过

**不要硬塞进一张。**

---

## 11. 本轮进展（2026-10-11 07:1x）—— 图线已交付 · 第 6 轮在跑

### 11.1 「留档与继任」独立图：**已交付，以 v2 为准**
- 产物：`<DSH_HOME>\dsh_orb\dsh-pipeline-flow\dsh-pipeline-留档与继任.v2.html`（**812,715 B**，sha256 `75cfcd48ad44ddf809c5df5e525637a845a7108ec061d7f084a0edb68ccd9253`）
- 收据：`…\dsh-pipeline-flow\.receipts\2026-10-10T23-12-47-139Z.json`（22,972 B）；旁证 `…v2.finalize-summary.json` / `…v2.browser-check.json` / `…v2.delivery.json`
- 四道闸门全 pass · diagnostics 0 · 映射 **25/25**（显式映射与 sources 两条路一致，0 unmapped / 0 dangling）
- v1（812,985 B / `065b29dd…`）原样保留作对照；v1 规格曾被动过，已按收据里的 `origin_sha256` 还原，哈希未变
- 规模：7 泳道 / 25 节点 / 33 边。内容 = 各角色独立落档 `records/` → 留档 AI 唯一写 `requirement.md` → 水位 45/55/65 → 席位换班继任 → 广播新联系人 + `pending_requests`
- 绕行（v1 → v2）：`routesOverSuggestedBends` 22/33 → **15/33**；`routesOverSuggestedStretch` 16/33 → **12/33**；maxStretch 8.15 → **3.00**
- 未清零的原因（已诊断，非手感问题）：端口被同侧其他边挤开 → 只剩"三条走廊"解 → 走廊解天生 4 折弯；代价函数里 `bendCount` 只排第 6

### 11.2 §10 数字的修订（实测，**推翻早先的推算**）
- 本渲染器下 **`viewBox` 宽 ≤ ~1200** 才是真上限（v1 = 1199、v2 = 1113），不是早先推算的 ~1800
- 投影最小文字 **6.002 ~ 6.005 px**（下限 6px）—— 两张图都是**踩着天花板**过的，再宽一点就掉线
- 四视口 1440×900 / 1600×1000 / 1920×1080 / 2048×1320 全 ok

### 11.3 运行时版本发现（**接手者必读**）
交付收据里 `tool_version: "0.2.0"`，而磁盘上 `profiles\desktop\node_modules\dsh-archigate\package.json` 是 **0.6.0** —— **DSH 进程里跑的还是 0.2.0**。
0.2.0 的映射闸门只读 `spec.components`，对 workflow 规格读出 **0/0（假绿）**。本轮交付是拿 0.6.0 源码的 `mapComponents` 对同一份 `tree.json` 复验的（证据：`dsh-pipeline-records-succession.v1.gate.json` / `.v2.gate.json`）。
→ **"必须重启"不是可选项**：不重启，交付门用的是旧判据。

### 11.4 插件线：第 6 轮追加需求（**进行中**，会话 `<session-id>`）
改 `…\dsh_orb\新任务-为-dsh-写一个插件-…-主对\dsh-pipeline` 源码，队列含三批追加：
1. **拆角色**：`orchestrator` 收窄为**纯需求分析**；新增 **`planner`（计划 AI）** —— 出计划、自检计划有无缺失、**分配 AI**（分配权从 orchestrator 移走）
2. **澄清前置**：需求分析第 1 轮后**必须**把"不清楚处"交主对话 → **用户人工确认** → 才递交 planner；planner 发现计划缺失 → 退回需求分析 → 答不了 → 主对话 → 人工
3. **编写按层分工**：默认 **接口层 / 数据层 / 处理层**，层清单由 planner 定；**席位上限 3 → 6**；`count=1` 退化等价的不变量不许破
4. **四条"防过度工程化"规则**（用户原话，本项目的目标函数）：**编程别跑测试** · **编排别看代码** · **改动面必须等于授权面**（修一个 bug 别改整个模块，清单外一行也拦）· **职责自限**（只干什么写死，越界能力不给）
5. **审核新职责**：planner **双轨派活**（同时发 writer 与 reviewer）· 派活时记**改动基线** · 审核按基线做**前后版本对比**，报"多改 / 少改 / 改错地方" · 审核**只读**，只有它自己的日志文件可写

纪律：该会话被告知**不安装、不重启、不碰 profile**，也不碰 `dsh-pipeline-flow\` 与 `normify-dsh-pipeline` 的模块。

### 11.5 下一步（顺序不变，但多两件收尾活）
等第 6 轮落地 → **逐条验收**（核源码与自测，不要只信汇报）→ 安装 `dsh-pipeline`（先备份 profile）→ **重启 DSH**（同时把 archigate 0.2.0 → 0.6.0 换掉）→ 正例反例实测。
收尾两件：① `normify-dsh-pipeline` 结构数据**尚未同步第 6 轮的新角色**（并发写被禁止，需另轮补 `planner` 等模块）；② 本档 §2 的"「分配 AI」= 编排 AI"已被用户改动，见 §11.4 第 1 条。
---

## 12. 第 6 轮落地（2026-10-11 08:1x）—— **已核源码，未安装**

**状态**：源码改完；**未安装、未重启、profile 零改动**（`cordis.patch.yml` 里 `dsh-pipeline` 出现 **0 次**）。

**规模变化**：角色 **14 → 15**（新增 `planner` 计划 AI）· 工具 **25 → 29** · 编写席位上限 **3 → 6** · 自测 **25 个文件 → 18 套 699~700 条全绿**（我独立数的：17 套汇总行 670 + `schema-check` 的 29 个定义 = **699**；对方报 700，差 1 不替它圆）。

**新增模块**：`lib/hashgate.js`（哈希前置闸门）· `lib/intercept.js`（宿主拦截缝 + 席位四问注入）· `lib/boundaries.js`（边界清单 a/b/c 三类，**数据不是散文**）· `lib/testscope.js`（定向 vs 全量判定）。

**本轮机制（用户逐条拍板）**：
1. **拆角色**：`orchestrator` 只做需求分析（写入档 `readonly`）；新增 `planner` —— 出计划 → 自检缺失 → **分配 AI**（分配权从 orchestrator 移走）
2. **澄清前置**：需求分析第 1 轮 → 主对话 → **用户人工确认** → 才递 planner；计划缺失 → 回流需求分析（复用同一部澄清梯，没另起一套）
3. **编写按层分工**（默认 接口层 / 数据层 / 处理层），席位数由层数决定，上限 6；`count=1` 退化等价的不变量保持
4. **四条目标函数（防过度工程化）**：**编程别跑测试** · **编排别看代码**（`main` / `orchestrator` / `planner` 全 `readonly`）· **改动面 = 授权面**（新增文件也算越界）· **职责自限**（判据化不了的 (c) 类如实列出，ARCHITECTURE 里画虚线并注明"这是愿望，不是边界"）
5. **审核**：planner **双轨派活**（同时发 writer 与 reviewer）· 派活记**改动基线** · 前后版本对比报"多改/少改/改错地方" · 审核**只读**（`own-log`：只许写 `.log` / `.jsonl`）
6. **哈希前置闸门**：比对 基线 + 授权面 + 改动声明，查 新增/修改/删除 三类越界 + **声明不实**；不过 ⇒ 直接打回，**不进测试、不消耗测试预算、不进全量审批链**
7. **全量测试四级审批链**：tester → 需求分析(need) → 审核(worth) → 主对话 → 用户 → 计划 AI(arrange 定范围与**最终命令**)；**凭据绑具体命令**（批一条跑另一条也拒）
8. **拦截做进插件**（不是另起一套）：宿主前置缝 `tools/pre-execute` + 提示词缝；**作用域靠席位令牌**（`roleOfAgent`，非管线席位**直通**）；**kill-switch 三层**（配置项需重启 / `pipeline_switch` 即时 / 与 `ctx.tools.guard` 共用同一份判据）
9. **Stop Ladder 四问由插件自带**（`skills/stop-ladder/SKILL.md`），`install.ps1` 一步落到 `<dsh-home>\skills\stop-ladder\`，随 `agent/pre-step` 注入席位开场上下文（每席位仅一次，防撑爆上下文）；`rollback.ps1` 可撤

**诚实边界**：L0 档无计划站 ⇒ 无基线 ⇒ 哈希闸门**"不适用"**（文档与自测都写明"不适用"，**不是"放行"**）；`node --test tests/`（整目录）曾有**漏拦**，已归为全量。

**待用户拍板**：**P8** 基线重取权限 · **P9** 钩子层运行时状态 · **P10** `Stop` 缝 · **P11** 自定义测试入口 · **P12** 凭据有效期。**P13 已完成（已核）**：不扣打回预算 + 连续 3 次不过自动交人工；开关 `hashGateEscalateAfter` 默认 3、**0 = 关闭**；**撤回不归零**（唯一归零点 = 一次真通过的提交或用户答复本机制发出的人工请求）；升级后同一任务 `dev_to_test` **拒收**（`HASH_GATE_ESCALATED`），答复后**重新武装**。

**会话**：旧线 `<session-id>` **已退役**（上下文 63%，按本项目 55% 继任 / 65% 硬限的规矩）；继任 `<session-id>` 正在做 P13。

**下一步**：装（**先备份 profile 三件**）→ **重启 DSH**（同时把 archigate 0.2.0 → 0.6.0 换掉）→ 正例反例实测。装之前不要同时有另一个流程写 profile。
### 12.1 核验补记（2026-10-11 08:20，独立复算）
- 自测**确实重跑过**：`tests\last-run.txt` 落盘 **08:19:28**（晚于 08:11~08:15 那批代码改动）
- `hashgate-check` **38 → 61/61**（新增 C/D/E 三组 + 发起人兜底）
- 我独立汇总：17 套有汇总行 = **693** + `schema-check` 29 个定义 = **722**（对方报 723，**差 1 与我上一轮数到的差 1 同源**，按我的数字记）
- P13 已从待拍板清单划掉（REPORT 新增 18.17）
- **教训记一笔**：上一次它「断在半路」时，代码写完但自测落盘时间**早于**代码改动时间 —— **光看"报告说完成"会漏**，用文件时间戳交叉核对才抓得住
---

## 13. 安装完成（2026-10-11 08:22）—— **待重启才生效**

- 命令：`& "…\新任务-为-dsh-写一个插件-…-主对\dsh-pipeline\install.ps1"`（先跑过 `-DryRun` 预演，确认只会 append 自己那一行）
- 备份（脚本自动，带时间戳）：`profiles\desktop\cordis.patch.yml.bak-20261011-082157` 与 `package.json.bak-20261011-082157`
- **逐项核验（我查的）**：
  - `node_modules\dsh-pipeline` 已就位（`lib` / `skills` / `tests` / README / ARCHITECTURE / install.ps1 / rollback.ps1），约 2.0 MB
  - `dsh.profile.bundles` **13 → 14** 项，末位是 `dsh-pipeline`
  - `cordis.patch.yml` 与备份**逐行对比：+14 行 / −0 行** —— 只 append 了自己那一条，**没碰别人的条目**
  - Skill 已装：`<DSH_HOME>\skills\stop-ladder\SKILL.md`
- **必须重启才有用**：插件本体（工具 / 守门 / 拦截缝）在 DSH 启动时装载；stop-ladder Skill 下次会话即可见
- **重启后的验收三步**（脚本自带清单）：
  1. 日志里找：`[pipeline] dsh-pipeline … 已加载：29 个 pipeline_* 工具已注册；… 多AI 协调开关=开`
  2. 右上角（⋯ 菜单与右侧栏切换按钮之间）出现「**● 多AI 协调 开**」胶囊，点一下应变「关」
  3. 任意对话调一次 `pipeline_selftest`（不带参数）—— 它会当场跑正例全流程 + 反例 + 分档验证，并原样打出每条拒绝理由
- ⚠️ **文档小错（无功能影响）**：`install.ps1` 的提示文本写着"17 个工具"，**实际是 29**（`index.js:312` 用动态计数，实测 29：含 `pipeline_plan` / `pipeline_full_test` / `pipeline_boundaries` / `pipeline_change_audit` 等）。待下一轮顺手改掉那句提示。
- **回滚（复制即用）**：
  `powershell -NoProfile -ExecutionPolicy Bypass -File "<DSH_HOME>\profiles\desktop\node_modules\dsh-pipeline\rollback.ps1" -Stamp 20261011-082157 -Profile desktop`
- **重启会结束当前 Computer Use 会话** —— 重启后请新开会话，按本档 + `pipeline_selftest` 做实测（§5.4 的正例反例清单）。

**仍未做**：`normify-dsh-pipeline` 结构数据未同步第 6 轮新角色（`planner` / 层分工 / 拦截等），待单独跑一轮补模块。
---

## 14. 架构图交付 + **0.6.0 首次生效**（2026-10-11 09:21）

- 产物：`<DSH_HOME>\dsh_orb\dsh-pipeline-arch\dsh-pipeline-architecture.html`（**819,398 B**，sha256 `d6fa2f170115c3e5faf2392a77cecbc1b6a243ad2e2d6c549977d9b0a4640fb2`）
- 收据：`…\dsh-pipeline-arch\.receipts\2026-10-11T01-21-21-459Z.json`（36,098 B）；规格 sha256 `a069eef7b87e99c4cea8b7b3b1c0d79f31c4fd574c6aa464eb2650809fb504d7`
- **收据里 `tool_version: "0.6.0"`** —— **重启生效了**，§11.3 那个"运行时 0.2.0 ⇒ 映射闸门 0/0 假绿"的问题**到此结束**
- 四道闸门：validate / deliver / check / browser-check = **全 pass**，diagnostics **0**；类型 `architecture`
- 规模：**25 节点 / 32 连线**；显式映射表 **25 条**（25 个组件全部对上 normify 模块，如 `c_plugin → dsh-pipeline.plugin`）
- 绕行指标：`routesOverSuggestedBends` **21 / 32**、`routesOverSuggestedStretch` **5 / 32**（对照：留档与继任 v2 是 15/33 与 12/33，说明**架构图这边 bends 偏高**）—— 它自己的中间校验里留下了 `composition/label-route-clearance`（标签压线）与 `proper-crossing`（交叉）的**建议级 warning**，不是 error
- **前置：normify 结构数据 26 → 37 个模块**（新增 11：`plan` · `writer-layers` · `hashgate` · `intercept` · `boundaries` · `testscope` · `full-test` · `baseline` · `stop-ladder` · `tests` · `client-slot`），`validate` **0 error / 18 warning（建议级）**，`build` ok：37 模块 / 71 API / 54 依赖

### 14.1 同期旁证（另一条会话，2026-10-11 09:06）
- 它把 DSH 内部的 `dsh-tools` 从 `app.asar` 抽出来，用**真校验器**跑了 **232 个用例**（29 工具 × 4 模式 × 2 种 schema 形态），**0 失败** —— 验证"每个工具的真实返回值都满足它自己声明的 output schema"
- 我复核：**源码与已安装副本逐文件哈希一致**（`index.js` / `hashgate.js` / `intercept.js` / `roles.js` / `config.js` / `install.ps1`），两边最新改动均 09:05:53 ⇒ 装进去的就是当前源码

### 14.2 仍未做 / 待拍板
- 架构图的路由**还可以再压一轮**（bends 21/32 偏高，属可选优化）
- **P8~P12** 待用户拍板（基线重取权限 / 钩子层运行时状态 / `Stop` 缝 / 自定义测试入口 / 凭据有效期）
- `install.ps1` 里"17 个工具"那句提示文案待顺手改成 29
### 14.3 架构图修订（2026-10-11 09:29）—— **以本版为准**
- 产物：`dsh-pipeline-architecture.html` **813,430 B**，sha256 `3a39a8fc870569e3d62b64c4a13077fd989bee3523dcdcf2bfebb8060a43a2b8`（§14 里 819,398 B / `d6fa2f17…` 那版已被覆盖）
- 收据：`.receipts\2026-10-11T01-29-18-200Z.json`，**`tool_version: "0.6.0"`**；四门全 pass、diagnostics 0、映射 25/25（全部 `via: explicit`）
- **两处印在图上的数字是错的，已改**：① 副标题「33 个结构模块」→ **25**（32 条连线）；② `c_roles` 副标签「写权限**五档**」→ **四档**（`guard.js#writeClassOf` 实际只有 `readonly / own-log / own-dir / workdir`）。**"五档"这个错是本会话主对话先数错、再传到图上的** —— 记一笔。
- 路由：`bends` **21 → 5**、`stretch` **5 → 1**、`maxStretch` 1.879 → 1.366、`labelRouteClearanceIssues` 16 → 3
- **代价（如实记）**：`properCrossings` **18 → 36**（总交叉 64 → **43**，其实少了三分之一）。原因是它给 13 条手写走廊边去掉了交叉消歧光晕（`crossingResolved`）—— 为压折弯付的。
- 旧版 v1 的 HTML **已被流水线删除**（同目录覆盖交付时触发 `viewer/evidence-path-conflict`，browser-check 拒用未归属的旧旁证路径；按提示把旧旁证挪进 `_prev-delivery\` 后重跑即过）；旧版收据与旁证**完整保留**在 `_prev-delivery\`。
---

## 15. **装 → 重启 → 实测：三步全部走完**（2026-10-11 09:3x）

### 15.1 实测方式与结果
在**任意对话里调一次 `pipeline_selftest`**（安装脚本清单第 3 项）—— **内存里跑，不建真实会话、不写工作区外文件、跑完即删**：

```
总计：70 / 70 通过
```

| 组 | 结果 | 关键内容 |
|---|---|---|
| 正例（全流程） | **9/9** | 9 个状态一步不跳：`pending→ready_dev→developing→ready_test→testing→ready_review→reviewing→passed→closed`；交接物逐个落盘；`audit.jsonl` 覆盖每个环节；制品版本化 v1 + `close_report` 留放行依据；**主对话视图脱敏**（看不到补丁正文） |
| 反例①编写直接提交审核 | **6/6** | 编写调 `review_verdict` / `review_ok` / 跳测试 / 冒充测试 / 测试冒充审核 / 审核冒充编写 —— 全被 `guard` 拦 |
| 反例②无 OK 关单 | **5/5** | 未审核关单、NG 后关单 —— `execute` 层 + 状态机第二道闸双拦 |
| 反例③测试/审核改代码 | **6/6** | write/edit/**shell 旁路**改源码全拦；对照：写 `reports/tester/` 放行、写 `reports/`**根下**（旧位置）**拒** |
| 反例④主对话自行增删角色 | **15/15** | 含 **计划 AI 加人却不给边界卡 → 拒**（边界卡必须覆盖每个执行角色）；计划 AI 复核批准后才改写清单，且可追溯 |
| 反例⑤打回次数超限 | **3/3** | 第 3 次打回被拒，**且不死结**（编写仍派得出去、状态停在测试中等人工），可用 `block` 交人工 |
| 反例⑥主对话读代码 | **3/3** | read / shell 读源码都拦；**对照：读任务卡放行** |
| 反例⑦令牌伪造与跨任务 | **7/7** | 伪造令牌、无绑定调用、跨任务令牌、会话绑定优先于令牌、一号两角色 —— 全拦 |
| 反例⑧版本一致性 | **4/4** | 对未走测试的 v2 出结论 → 拒；测试报告写不存在的版本 → 拒 |
| 反例⑨与其它守护共存 | **5/5** | 与 **archigate** 互不翻盘（谁都不能把对方的拒绝改成允许），**注册顺序无关** |
| 反例⑩守门健壮性 | **2/2** | 畸形入参不抛异常、也不把该拒的放行成 `undefined` |
| 分档 | **5/5** | L0→L4 = **4 / 7 / 9 / 10 / 11** 个独立对话；每档给出命中信号与角色清单 |

### 15.2 一条能自证作用域的旁证
反例⑥ 里"主对话读项目源码 → 拦"；而**本次 Computer Use 主会话读插件源码并没被拦** —— 因为它**不是管线席位、没绑定任务**。⇒ 守门的作用域是准的（**不误伤全局**），与 §12 第九条的设计一致。

### 15.3 收尾
- 架构图**定稿收下**（§14.3 那版：813,430 B / `3a39a8fc…` / 四门全过 / 25-25 映射 / bends 5·stretch 1）
- 仍未做的小尾巴：`install.ps1` 提示文案"17 个工具"→ 29；**P8~P12** 待拍板
- `normify-dsh-pipeline` 结构数据**已同步到 37 模块**（§14 做掉了，不再是待办）
---

## 16. 真单 + 两个真缺陷 + 待生效项（2026-10-11 16:0x–16:4x）—— **重启前必读**

### 16.1 唯一真单：`T-20261011-4a2dc7`（停在「需求分析中」）
需求（用户原话）：『真单，但开发内容就是改定该插件的完善，要让每个工具 ai 知道自己要干什么，而是去运行，然后被切断，或者切断后自己能意识到，然后重新输出正确内容。』
- 先开的 `T-20261011-5f31b2`（改 install.ps1 文案）**已 cancel**，内容整体替换为新单
- **注意**：cancel **不会解除**主对话绑定 —— 主对话（Computer Use 会话）至今仍被那张**已取消**的单判据约束

### 16.2 事故 A：席位一派活就被炸死（**已定位 + 已修，待重启生效**）
- 现象：`pipeline_dispatch` 成功建子会话 → **295 ms 后** `turn/end reason=error "Cannot read properties of undefined (reading 'kind')"` → 零交接物、任务静默停在「需求分析中」
- 根因（精确到行）：`lib/intercept.js:248`（改前）手写消息字面量 `{ role:'user', content: seatBriefing(...) }` —— **没有 `source`**，且 `content` 是字符串（宿主期望 block 数组）。宿主 `@deepseek-ai/dsh-session-reference#prepareDirectMessages` 无守卫读 `message.source.kind` ⇒ 崩
- 为什么"流水线上线后才出现"：该注入**只在会话已是管线席位时**执行；开单自动绑定主对话、派活铸牌绑定子会话 ⇒ **绑定后的第一个 `agent/pre-step`** 才第一次走进去
- 修法：收敛到唯一构造器 `lib/hostmsg.js`，5 个注入点全登记（`HOST_INJECTION_SITES`），新增 `tests/liveness-check.mjs` 的**静态扫描**断言（`lib/**` 除 `hostmsg.js` 外不许出现代码形式的裸 `role:'user'`）

### 16.3 事故 B：席位死了没人知道（**已修，待重启生效**）
- `lib/liveness.js`：派活记 `task.dispatched[]`（`{key,role,seat,agent_id,token,at,...}`，只在派活成功后记）→ 静默超 **`config.seatSilenceMs`（默认 5 分钟）** 且**轮到场**且**零活着证据** ⇒ 复用既有 `block` 出口把任务推「已阻塞」，写 `task.liveness.escalations[]` + 审计
- 开关：`config.seatLivenessEscalate`（默认 true）；节流 `LIVENESS_CHECK_THROTTLE_MS = 60_000`（**写死，未提成配置项**）
- 三个触发点：`tools/pre-execute`（任意管道角色含主对话的下一次调用）· **`pipeline_status`（现在也处置了）** · `agent/pre-step`
- 新增 `pipeline_dispatch { reassign: true }`：一键重派同一席位，任务若在 blocked 会**先自动恢复**再派，**不消耗打回预算**
- 版本说明：这是**第二轮**补强 —— 第一版只在"下次有人动手时"才检查，被指出"没有任何人动手就永远不触发"后改的

### 16.4 提问卡片「选项被当 JSON」（**已定位 + 已装插件，待重启生效**）
- 根因（宿主内置客户端，非皮肤插件）：`@deepseek-ai/dsh-client-ui-tool/lib/client.js` 的 `AskQuestionRow` —— `answerable` 为 false 时不给「回答」按钮，退化到通用 `ToolRow`，把 `bodyRaw` 原样打成 JSON
- `answerable` 的来源：`@deepseek-ai/dsh-user-questions` 的投影，写入前置 `fold.timed` —— 它要求**落盘的工具 schema 带 `timeout` 参数**；本 profile 里 `tool-ask-user` 未写 `mode`，吃默认 `legacy` ⇒ 无 `timeout` ⇒ 投影永不写入
- 修法（用户选 **B**，不动 schema）：新客户端插件 **`dsh-askcard-row`**，`tool.call.toolview` / `key=ask_user_question` / `priority:-1`，**整行替换**（keyed slot 无法条件让位 —— 返回 null 是白屏；唯一交还机制 abdicate 是永久的）
- 已安装到 `profiles\desktop\node_modules\dsh-askcard-row`，**未重启**；改动面只有 `running` 那一格的展开体与按钮，其余分支逐字照搬宿主
- 备注：`mode: timed` + `timeout: -1` 是另一条等价修法（只改 schema 不改行为），**用户否了**（不想动全局 schema）

### 16.5 **重启前清单**（用户按一次重启，这三件一起生效）
| # | 待生效项 | 属于 |
|---|---|---|
| 1 | 注入形状修复（`hostmsg.js`）| dsh-pipeline 服务端 |
| 2 | 席位失联检测（`liveness.js` + `reassign`）| dsh-pipeline 服务端 |
| 3 | `dsh-askcard-row` 客户端插件 | 客户端 |
**重启后先看三处**：① 日志 `[pipeline] dsh-pipeline 0.1.0 已加载：29 个 pipeline_* 工具已注册`；② 右上角「● 多AI 协调 开」胶囊；③ 提一个问，看卡片展开是否是**问题+可点选项**（不再是输入框里的 JSON）。
**回滚**：`profiles\desktop\node_modules\dsh-pipeline\rollback.ps1 -Stamp 20261011-082157 -Profile desktop`；askcard 见其 README（撤 insert + 删目录），三件套备份 `*.bak-20261011-164028`。

### 16.6 未决清单
- **`intercept-check` 3 条红**（08:19 全绿 → 16:35 三条红，全在 `skills/stop-ladder/SKILL.md` 的断言）：已要求对质"断言何时加入 / 文件何时被改 / 断言读的是哪个文件"，**结论未回**；**不许删断言掩盖**
- **`dsh-askcard-row` 要不要加进 `dsh.profile.bundles`**：已给反证（本 profile 14 项里每个插件都在 bundles 且在 patch 有条目）⇒ 要求加回并给交叉表，**未回**
- **P8~P12** 仍待用户拍板；`LIVENESS_CHECK_THROTTLE_MS` 是否提成配置项（新）
- **主对话的盲区（重要）**：本会话被绑成主对话后，`tools/pre-execute` 与 post-execute **双网**会拦掉任何含代码正文的读取 ⇒ **Computer Use 主会话无法自行核源码**，验证必须交给未绑定会话
### 16.7 「3 条红」已定案并修绿（2026-10-11 16:5x）
**结论：`intercept-check` 那三条 SKILL.md 断言是 cwd 依赖的假红 —— 文件没坏、断言不是后加的。**
- 三条定案 **全为 (C) 断言读错文件**：断言用 `join(process.cwd(),'skills',…)` 读文件 ⇒ 从**插件目录**跑就过、从**会话工作区**跑就读不到（`存在：false｜大小：0`）。决定性对照：拿原始版从两个 cwd 各跑一次 = `E 4/4` vs `E 1/4`，唯一变量是 cwd
- 红③**另有断言自身缺陷**：证据行是硬编码 `'已确认'`，与判据不同源 ⇒ 判据为假也照打"已确认"
- **`skills/stop-ladder/SKILL.md` 完好**：3838 B / mtime 07:49:21 / sha16 `5E80A0DDD5C64C01`；四份拷贝（源码树 / 安装副本 / `~\.dsh\skills\stop-ladder\` / 另一线快照）**哈希全同**
- 修法：路径基准 `process.cwd()` → `HERE`（包定位）；红③证据行与判据同源。**未删/未放宽/未跳过**
- 结果：`intercept-check` **22/25 → 25/25**；全套件 **720/723 → 751/754 → 754/754 → 764/764（exit 0）**；安装副本 **735/735**
- **教训**：这轮见证「**跑在错的 cwd 下，测试会骗人**」—— 同一份代码、同一份文件，两个 cwd 得出相反结论。以后对比条数前先对齐 cwd 与运行器
### 16.8 bundles 顾虑已销 + **重启前清单（定稿）**（2026-10-11 17:0x）
**结论：同 id 不会双加载，我原先的反证是错的（方法错）。**
- 真相：bundles **15 项**里只有 **7** 项在 patch 有对应，其中 **6 项是 `- id:` 覆盖**（覆盖 bundle 层已插入的那一行 ⇒ 永远只有一行，是**设计配套**）；**真 insert 重复的只有 `dsh-pipeline`**。`maid-atelier` / `normify` / `drawai` / `orb` 的**包名在 patch 里查不到**（patch 用条目 id）
- 销掉顾虑的**源码依据**：`applyEntryPatches` 里 `- id:` 覆盖找不到就 warn 跳过、**不新建行**；`- insert:` 是 `data.push(...)` **不去重**；`EntryGroup.update` 用 `options.id ?? Symbol()` 建 map ⇒ **同 id 塌成一条** ⇒ 不会双加载
- **教训（写给我自己）**：别拿"别人都这么跑"当机制证据 —— 要翻源码

#### ★ 重启前清单（最终版）—— 一次重启，四件一起生效
| # | 待生效项 | 属于 |
|---|---|---|
| 1 | dsh-pipeline **注入形状修复**（`lib/hostmsg.js`，5 个注入点 + 静态扫描守） | 服务端 |
| 2 | dsh-pipeline **席位失联检测**（`lib/liveness.js`；三个触发点：pre-execute / **status 也处置** / pre-step；`pipeline_dispatch { reassign:true }` 一键重派） | 服务端 |
| 3 | **`dsh-askcard-row`**（已进 `node_modules` + 已加 `dsh.profile.bundles`（第 15 项）+ patch insert 条目） | 客户端 |
| 4 | `dsh-pipeline` 的 patch **insert 条目**此前从未被真正加载过（启动早于 insert 写入）⇒ 这次是**第一次**按完整配置加载 | 服务端 |

**重启后先看三处**：① 日志 `[pipeline] dsh-pipeline 0.1.0 已加载：29 个 pipeline_* 工具已注册`；② 右上角「● 多AI 协调 开」胶囊；③ 提一个问 ⇒ 卡片展开应是**问题 + 可点选项**（不再是输入框里的 JSON）。

**真单的恢复动作（照抄即用）**：
```
pipeline_status   { task_id: "T-20261011-4a2dc7" }
pipeline_dispatch { task_id: "T-20261011-4a2dc7", role: "orchestrator", reassign: true }
```

**回滚**：
- askcard：从 `bundles` 删 `dsh-askcard-row` + 删 profile patch 里那条 `- insert:` 块 + 删 `node_modules\dsh-askcard-row`；三件套整份还原用 `profiles\desktop\*.bak-20261011-164028`
- dsh-pipeline：`powershell -NoProfile -ExecutionPolicy Bypass -File "<DSH_HOME>\profiles\desktop\node_modules\dsh-pipeline\rollback.ps1" -Stamp 20261011-082157 -Profile desktop`
---

## 17. 收工状态（2026-10-11 18:3x）—— **下次启动照这页走**

### 17.1 已经生效的（16:46:58 那次重启加载）
- **注入形状修复**（`lib/hostmsg.js`）：席位简报/四问注入**首次活着到达**、不再炸 turn
- **席位失联检测**（`lib/liveness.js`）：派活记台账；三触发点（pre-execute / **status 也处置** / pre-step）；`pipeline_dispatch { reassign: true }` 一键重派
- **`reattach` 认领入口**：重启后身份与令牌全丢时，用它认回老单（唯一入口）

### 17.2 **待下次启动生效（两项，都已改好、都未重启加载）**
| # | 项 | 改动 |
|---|---|---|
| 1 | **提问气泡（A 路线，宿主原生）** | `profiles\desktop\cordis.patch.yml` 里 `tool-ask-user` 加 `config: { mode: timed, timeout: -1 }`（行为等价，只补 schema ⇒ 宿主自己的提问行恢复）；**`dsh-askcard-row` 已整体回滚**（bundles 15→14、patch insert 删除、目录挪到 `.askcard-row-rollback-20261011-181931\`） |
| 2 | **派计划死锁修复** | `lib/tools.js:1457` 引导步白名单由 `ready_plan` 改为 **`ready_plan \|\| planning`**（且只在 `roster === null` 时生效）；新增 `【E 引导步死锁】` 12 条；全套件 **767 → 779 全绿**；源码树与安装副本逐文件 0 差异 |

### 17.3 下次启动后的三步
```
① 认回身份： pipeline_task_open { task_id: "T-20261011-a5fe41", reattach: true }
② 继续推单： pipeline_dispatch { task_id: "T-20261011-a5fe41", role: "planner" }
③ 验收气泡： 让 agent 提一个问 ⇒ 输入框上方应出现提问卡片；转录行是 ❓ 提问 · 等待回答 + 行尾「回答」胶囊；
             ★ 测前先把右下角「DeepSeek 余额」白气泡点掉 —— 它盖住行尾按钮（这就是用户说的"点不了"的真凶嫌疑）
```
- 孤儿单 `T-20261011-4a2dc7` 同样用 `reattach` 认领后收尾（已列入本轮验收第 ⑥ 条）

### 17.4 这一轮新踩出的三个坑（都已写进本轮需求）
1. **重启后身份与令牌全失效**（绑定是进程内存、令牌表也是）⇒ 老单成**孤儿**；唯一入口是 `reattach: true`（我最初漏了这个参数，被"已存在，请换一个 id"挡住）
2. **派计划死锁**：引导步白名单只认 `ready_plan`；而主对话发出的 `dispatch_planner` 边**合法但不铸令牌**，把状态推到 `planning` 后两条出边又只有 planner 能发 ⇒ 单向死锁（已修）
3. **浮层气泡遮挡**：右下角「余额」白气泡压住行尾按钮 ⇒ 用户"点不了"。**它不是提问链路的问题**，是遮挡

### 17.5 还原与备份
- 备份三套：`profiles\desktop\*.bak-20261011-082157`（装插件前）· `*.bak-20261011-164028`（askcard 安装前）· `*.bak-20261011-182142`（气泡 A 前）
- 只撤气泡 A：`Copy-Item "$P\cordis.patch.yml.bak-20261011-182142" "$P\cordis.patch.yml"`
- 回到 16:40 状态：`Copy-Item "$P\cordis.patch.yml.bak-20261011-164028" "$P\cordis.patch.yml"`（**注意：连 timed 配置一起撤**）
- askcard 本体恢复：`Move-Item "$P\.askcard-row-rollback-20261011-181931\dsh-askcard-row" "$P\node_modules\dsh-askcard-row"` + 还原当时的 `package.json`
- dsh-pipeline 回滚：`…\node_modules\dsh-pipeline\rollback.ps1 -Stamp 20261011-082157 -Profile desktop`

### 17.6 仍未决
- **P8~P12** 待拍板；`LIVENESS_CHECK_THROTTLE_MS`（60s，写死）是否提成配置项
- `intercept-check` 3 条红**已定案并修绿**（cwd 依赖的假红，见 §16.7）；bundles 顾虑**已销**（见 §16.8）
- 隐患台账（只列不改）：宿主 8 处 + `repeat-tool-reminder` + `dsh-pause` 的无守卫 `decision.kind` / `message.source.kind` 读取
- **主对话盲区**：被绑成主对话后**读不到代码正文**（pre-execute 与 post-execute 双网），核代码必须交给未绑定会话

---

## 11. archigate 大图容量结论（2026-10-12 凌晨，v0.7.0 保留）

**决定**：**保留 v0.7.0**（几何求解器）。理由：44 节点单图无解**不是 v0.7.0 的缺陷** —— v0.6.0 同样画不出来；而 v0.7.0 带来净增益（19 节点自动过门 / 收据 `geometry` 留痕 / 85 项自测）。

### 硬结论：大图**必须拆图**，不是"再挤挤"
| 项 | 数 |
|---|---|
| **真实可用舞台宽** | **840px**（`assets/template.html:9365 MIN_READER_WIDTH=960` − 正文内边距 64 − 图区 56；由已交付的 `wf19-std` 收据反解，`8 × 840/1120 = 6.000` 逐位吻合） |
| 投影公式 | `投影 = 源字号 × (840 / 画布宽)` |
| 过 6.0px 地板需画布宽 | **≤ 1120** |
| 过 6.5px 目标需画布宽 | **≤ 1033** |
| 本案例（44 节点 / 76 边 / 9 泳道）单图**最小**宽 | **1933** → 投影 **3.476px** ❌ |
| **删光全部 76 条边标签** | 画布宽才到 **1039** → **仍差 6px** ❌ |

> **即使一个边标签都不留，单图也过不了。** 这条路到头了。

### 三条反直觉事实（都实测过，写进插件文档了）
1. **缩节点盒是负收益**：净空变小 → 自动路由更找不到内路 → 画布宽 **1933 → 2441（更宽）**。
   ⚠️ 这条**推翻了我先前"缩小盒子能扩容"的判断**，我撤回。
2. **`via` / `labelAt` / `channelX/Y` 一出现就关掉"逐泳道量高"**：高度 **5622 → 8670**（宽度与高度在这张图上互斥）→ **所以插件"从第 1 轮就 `stripExplicitRoutes`"是有依据的，不是保守**。
3. **画布宽的大头不是节点尺寸，是"自动路由越界走廊"**：原样编译 `viewBox = 3243×5622`，有条线的折点落在 `x=3226.8`，而泳道框右边界只有 **1141**。

### 拆图方案（已逐张实测编译）
44 节点按列拆成 **4 张**：`fig1-col0` / `fig2-col1-2` / `fig3-col3-4` / `fig4-col5`
→ 每张 **error 0**，投影 **7.5 ~ 8.0px**（远超 6px 地板）✓
产物：`dsh-pipeline-flow\archigate-delivery\wf44-width-findings\splits\`

### 一句话给以后的自己
> **archify 能画的不是"多少节点"，是"多少宽度"。** 节点多到一定程度，**唯一的出路是按列/按组拆图** —— 而不是缩盒子、加宽画布、或给边手写路线（前者负收益，后两者互斥）。

---

## 18. 五张单现状 + 地基修复 + 待修清单（2026-10-12）—— **接手先读这页**

> ⚠️ **编号说明**：本档现有的最后一节标题写作「## 11. archigate 大图容量结论」，那是**重复编号**（它时间上排在第 18 位）。本节按顺延写作 **§18**。引用本档时请按**标题文字**定位，不要按编号。
>
> **本节内容一律引自账本**：账本根 = `<DSH_HOME>\profiles\desktop\.pipeline\<task_id>\`（`task.json` + `handoffs\` + `artifacts\` + `audit.jsonl` + `records\` + `reports\`）。凡账本里查不到的，本节明确写「账本内未找到」，不补印象。

### 18.1 五张单：状态与位置（逐单可核）

| # | task_id | state（账本原文） | 承接的需求 | 做到哪一步 | 还剩什么 |
|---|---|---|---|---|---|
| 1 | `T-20261011-214043` | `blocked`（prev `developing`；`updated_at 2026-10-11T16:59:25Z`；`task.json` 17.97 MB） | 插件单：通道（真实会话派活）· 四槽下发 · 模式 · 守门 · 日志 | 通道侧交付**已提交**：`handoffs\032-dev_to_test.json` = `H-b18bb7645aa19a3a`（`writer→tester`，`2026-10-11T16:59:06Z`，绑定制品 `v5`）；同一分钟哈希前置闸门 `pass:true streak:0`（`task.json hash_gate_checks[3]`） | 停在**干净暂停点**（`history` 末条 `transition:block` `16:59:24Z`，备注原文：「冻结于干净暂停点：通道侧已提交 dev_to_test…改动面 6 处全在授权面内、哈希前置闸门通过」）。未跑测试/审核；**制品版本指针不唯一**（见 18.4-①） |
| 2 | `T-20261011-5a871c` | `developing`（prev `blocked`；`updated_at 2026-10-12T12:26:20Z`） | 派活权转交给「需求分析 / 主管 / 计划」链，并用代码锁死（三层：名单权威层 / 守门与状态层 / 通道与派活层） | 计划 + 角色清单已落：`roster.tier=L3`、`ai_count=10`、`writers.count=3`（分区 `roster-authority` / `guard-states` / `dispatch-channel`）。**第一层「名单权威层」已干完**：制品 `v1`（4167 B）/`v2`（3994 B）/`v3`（9288 B）；**7 个文件**；两棵树对应文件**逐一哈希一致（差异 0）**；本层结构化探针 **55/57**（未过 2 条是 writer#2 文件面的跨席依赖） | `writer#1`（名单权威层）**已干完待交**（账本最后一次落笔 12:26:20Z 仍是 `developing`，11 份 `handoffs` 里**没有** `dev_to_test`）；`writer#2`（守门与状态层）· `writer#3`（通道与派活层）**尚未实质开工**（`dispatched` 只有 7 条，`writer#3` 仅 15:32:35Z 派过一次） |
| 3 | `T-20261011-56a37e` | `ready_dev`（＝待开发；prev `planning`；`updated_at 2026-10-11T15:34:54Z`） | 主管枢纽流程：主管发起三方 · 架构图前置 · 计划/架构待机 · 测试提前 brief · 五道硬闸门 | 需求已确认（用户 8 处口径，`15:03:40Z`）＋**计划已落**（`handoffs\004-plan.json` `15:09:20Z`）＋**角色清单已落**（`roster:set`，L3 / ai_count 10）＋改动面追加（`scope:amend` `15:34:54Z`）；`artifacts=0` | 编写席一个都还没派（`dispatched` 为空）。本单与 1、2 号单改**同一批文件**，必须串行 |
| 4 | `T-20261012-7b9408` | `analyzing`（prev `analyzing`；`updated_at 2026-10-11T16:36:34Z`） | 打回必带原因 + 禁止继续（人打回与系统打回一视同仁） | 需求分析结论已出（`handoffs\001-requirement_analysis.json`）；6 处取舍已升级用户且**已答**（`HR-a1b726450f7cfac4`，`16:36:34Z`，用户**手输**） | 口径已答，但**尚未按答复重出结论**：答完后没有新的 `requirement_analysis` 交接物，`roster=null`，仍在 `analyzing`。★ 答复把原始口径否掉了一半，见 18.4-② |
| 5 | `T-20261011-63633e` | `blocked`（prev `planning`；`updated_at 2026-10-11T13:36:32Z`） | 点餐（测试用）：离线 exe 跑通全流程 | 需求确认 ＋ 计划已出（`handoffs\003-plan.json`）；计划位的澄清已被需求分析裁掉（`CQ-44787f0ca93f6263` answered，裁定「取证定位 + 能严则严」） | **已阻塞**：用户指示「点餐单就是用来测试的，不要再推它，优先修插件」。它已交付价值 —— 账本原文列出的**四个真缺陷**：唤醒缺失 · 唤醒报事件/状态不准 · 请求登记漏写 · 分组名取错来源 |

**补充：账本里还有 4 张没被点名的单**（`.pipeline\` 实际是 9 个任务目录，不是 5 个）：

- `T-20261011-207ede` `ready_dev` —— 点餐第一轮（会话分组被用户删掉 ⇒ 只作废了会话，任务档仍在）
- `T-20261011-4a2dc7` `analyzing` —— 同需求老单，重启后主对话绑定与令牌全丢 ⇒ 成**孤儿单**（`handoffs=0`、`records=0`）
- `T-20261011-a5fe41` `blocked` —— 重启后重开的同需求单（「三层 + 重启恢复 + 孤儿单收尾」）
- `T-20261011-5f31b2` `cancelled` —— `install.ps1` 文案小单（写 17 个工具、实际 29 个），已取消

### 18.2 本轮修好的地基（现象 → 根因 → 修法 → 证据）

行号取自**当前生效副本**（`…\node_modules\dsh-pipeline`，与源码树同哈希，实测见 18.4-④）。

| 项 | 现象 | 根因（文件:行） | 修法 | 证据坐标 |
|---|---|---|---|---|
| ① 席位注入缺 `source` | 一派活就**秒死** | 注入消息缺 `source` ⇒ 宿主 `@deepseek-ai/dsh-session-reference#prepareDirectMessages` **无守卫**读 `message.source.kind` ⇒ `TypeError` ⇒ 整个 turn 以 error 收尾。`lib\hostmsg.js:13`、`:17-18`；`lib\wakeup.js:29-37` | 所有注入一律走 `lib\hostmsg.js` 的 `hostMessage()`（唯一出口），`source.kind` 用生产者自有 kind（`plugin:dsh-pipeline` / `runtime-context`），并补 `id`（`lib\hostmsg.js:51`、`:98`、`:161`） | `tests\liveness-check.mjs:8`「A. **注入形状**（2026-10-11 事故：子会话 **277 ms 静默死亡**）」＋`tests\wake-check.mjs:11`；账本后效：各单 audit 里唤醒投递成功写作「已投进会话 … 的下一轮队列（**source 保住 = runtime-context**）」（`T-20261011-63633e\audit.jsonl` 13:28:34Z、`T-20261011-56a37e` 15:34:54Z、`T-20261012-7b9408` 16:33:38Z） |
| ② 席位**失联检测** | 席位闷头干活就被判「死了」 | 判据形态：**静默只看有没有调用流水线工具，不看该会话是否仍在执行动作**（`T-20261011-214043\handoffs\025-clarification_request.json` 原文） | 新增 `lib\liveness.js`：默认静默阈值 5 分钟（`:53`），「没证据 ≠ 它死了」（`:39`），审计写失败也**说出来**（`:416`） | `task.json` 的 `liveness.escalations[]` ＋ audit 的「★ 机制触发（不是人叫停）」条目。**全账本共 6 次**：`a5fe41` 10:58:48Z / `5a871c` 13:47:39Z·16:59:37Z·12:20:45Z（次日）/ `214043` 13:48:10Z·16:51:40Z |
| ③ `reassign` 一键重派 | 失联后没人管，单子卡死 | — | `pipeline_dispatch { reassign: true }`：先解阻塞再派同一席位，**不消耗打回预算** | `T-20261011-5a871c\audit.jsonl` 13:47:54Z 原文「★ 席位失联重派：先解除阻塞（不消耗打回预算）」（`history` H19） |
| ④ **交付即唤醒** | 真实会话干完活，主对话收不到任何信号 | 新的「真实会话」通道只做了三步（建会话 → 投派活单 → 读回），**没有第四步交付回调**；旧的子代理通道自带 `Background subagent … finished`（`lib\wakeup.js` 头部 5–22 行） | 新增 `lib\wakeup.js`：席位交付那一刻往主对话会话注入一条可操作消息；目标会话**只**从 `createMainSessionRegistry` 取（结构上不可能投错），幂等靠确定性 `requestId` + `message.id` | **五张单的 `task.json` 全部带** `contacts.main.why` = 「交付即唤醒：唤醒消息要投到主对话所在会话」；audit 里 `wake:delivered`（214043 = 26 条、5a871c = 32 条、63633e = 9 条、7b9408 = 2 条、56a37e = 1 条） |
| ⑤ 唤醒**自愈 / 失败可见 / 补发** | 唤醒不响时无从查起 | 唤醒通道在主会话未登记时会不可达 | 唤醒修复 + 请求登记兜底 + 读盘自愈 + 唤醒保真 | 基线备注原文（`T-20261011-214043\baseline-BL-64c1eb000b1f10bf.json` 的 `note`）：「① 唤醒修复（`lib/wakeup.js` 新增 + `lib/hostmsg.js`/`lib/intercept.js`/`lib/store.js`/`lib/tools.js` 改动 + `tests/wake-check.mjs` 等）② 请求登记兜底 / 读盘自愈 / 唤醒保真（`lib/store.js`/`lib/wakeup.js`/`lib/intercept.js`）」。**失败可见**的最早形态：`wake:skipped` 带 `reason`+`hint`（`T-20261011-214043\audit.jsonl` 13:48:10Z「reason=no-main-session…不知道唤醒该投到哪」，该单共 **20 条** `wake:skipped`）；修复后同单转为 `wake:delivered` |
| ⑥ 请求登记漏写 + 读前对账 | 席位提了人工请求，主对话**取不出来** | ① 登记表漏写；② 自愈**只挂在读盘分支**上，缓存命中直接 return ⇒ 同一次运行里漏过一次登记，之后**再也不自愈**。`lib\store.js:623-640`（`healHumanRegistry`）、`:713-745`（两条分支都要过对账、缓存命中也要自愈）、`:520-561`（`cacheStamp` 读侧对账：盘比内存新就重载） | 两条分支都自愈 + 读前对账（盘比内存新 ⇒ 重载；且不误伤本进程刚写完的） | 真单现场：`T-20261011-5a871c\history` 15:36:35Z 冻结备注原文「需求分析席位已连续提 4 条人工介入请求，但**全部未进登记表**（收件箱始终 3 条 / 0 待处理）⇒ 主对话取不出来」；`T-20261011-63633e\history` 13:36:32Z 把「请求登记漏写」列为四个真缺陷之一；修复生效痕迹：`T-20261011-214043\audit.jsonl:167`「四项修复已生效（**收件箱登记能写+读得到** · 哈希前置闸门不再背旧计数且真越界仍拒 · 四槽下发可指定工作区档 · 唤醒含自愈）」 |
| ⑦ **哈希前置闸门**（基线 / 连续不通过计数） | 他单足迹被算成本单越界，编写席永远交不上去 | 判据只认两类：清单外的改动、「实际动了却没在改动声明里报」；而基线取于开工时刻，之后同一共享插件目录被他单持续写盘 | `lib\hashgate.js`：基线（`baseline-BL-*.json`）＋ 连续不通过计数（`hash_gate_streak` / 阈值 3）＋ 重取基线（`take`）＋ 旧基线判定自愈 | `T-20261011-214043\task.json`：`hash_gate_checks[]` **4 条** —— 14:46:23Z `pass:false streak:1`（越界 14 · 声明不实 55）→ 16:56:57Z `false streak:1`（越界 1：`node_modules/dsh-drawai/lib/index.js`）→ 16:57:21Z `false streak:2` → 16:59:06Z **`pass:true streak:0`**；audit 的 `gate:hash_reset`（16:45:49Z、16:58:44Z，后者 `prev_streak:2 → now_streak:0`）；该单共 **6 份**基线 |
| ⑧ **守门锚点**（授权面裸路径按插件包根解析） | 授权面内的文件，编写席**第一个字节都写不进去** | 授权面 20 条写的是「插件包内相对路径」，守门按项目根拼接 ⇒ 解析不到同一文件（`T-20261011-214043\handoffs\021-clarification_request.json` 原文：「逐文件备份被守门拦下，定位到「授权面路径解析基准」与插件实际路径不一致 ⇒ 编写席一行都改不了」） | 裁定原文（`CQ-9772fc7aa8cea3e4`）：「授权面的判据是**文件身份**，不是路径字符串…把同一个文件从「包内相对写法」改写成「项目根相对写法」…是**写法更正**，不是扩权」；扩列动作归计划位（`scope:amend`） | 同单 `handoffs\020`～`022` 三份澄清请求 ＋ `handoffs\025` 第四条附带缺口：「前后版本对比工具…**没有应用已落地的锚点解析规则**；同一份规则在守门与交接物校验里都已生效，唯独没落到该工具」 |
| ⑨ **四槽下发**（权限档 / 模式 / 模型 / 推理等级） | 名单声明什么档、会话实际拿到什么档 —— 两者对不上 | 修复前现场：`T-20261011-5a871c\handoffs\008-clarification_request.json`「本席被派出时携带的席位档位是"只读"，而计划给本席的边界卡声明的是"工作区"」（写探针拒绝原文 `file access denied under read-only mode`） | 四槽物理分离下发（`DISPATCH_SLOT_KEYS`），未指定取最小档，完全档默认禁用 + 三段审批闸门 | `T-20261011-5a871c\audit.jsonl` 16:59:37Z 原文：「写权限已放开（四槽下发已落地并实测生效：派活回执出现「**权限档 = workspace-write（计划指定）· 读回核对一致**」）」 |
| ⑩ **本轮三处**（状态账本缺陷） | ① 重复 block 覆盖恢复点 ⇒ unblock 空转；② `persist()` 失败不回滚内存；③ 源码树授权面用绝对路径、校验只认相对路径 ⇒ 怎么写都判越界 | ① `lib\states.js` 的 block 分支无条件覆盖 `previous_state`；② `lib\store.js` 的 `persist()` 落盘失败后内存已改；③ 对比工具的路径归一化缺失 | 三处均已修并实测（`dsh_orb\任务-修-三处-状态账本-缺陷-…\_probe\`：`probe-BEFORE.txt` 记 **9 个 ✗**，`probe-AFTER.txt` 全部转 **✓**，且反例仍被拒） | **真单实测**：`T-20261011-5a871c\audit.jsonl` 12:15:16Z `transition:unblock` 带 `recovery_point {used: developing, previous_state: developing, fallback: true}`，备注原文「重启后验证「重复 block 覆盖恢复点」修复：上一次 unblock 返回「已阻塞 → 已阻塞」为空转」；同一账号本 11:24:28Z 与 11:24:32Z 两次 `unblock` 记录为 `blocked → blocked`（缺陷现场）。第三处的真单原文在 `T-20261011-5a871c\handoffs\011-human_request.json`：「**源码树那两条授权面用的是绝对路径、校验只认相对路径 ⇒ 源码树改动怎么写都判越界**」 |
| ⑪ **DrawAI 会话日志损坏** | 一条会话历史加载失败 | 注入消息缺 `id`（同一根因族） | 插件补 `id: randomUUID(...)`；那条已被写坏的会话数据就地修复 | `T-20261011-214043\audit.jsonl` 16:58:40Z 解除冻结备注原文：「越界项为 `node_modules/dsh-drawai/lib/index.js`，系主对话在用户授权下做的**会话日志修复**（补 `id: randomUUID(`…）」；插件侧同源注释 `lib\hostmsg.js:51`「所以 `data.id` 必须存在。而本模块原先返回 `{ role, content, source }` —— 没有 `id`」；修复留痕目录 `dsh_orb\任务-修-dsh-drawai-缺-id-的注入-a-修复已被它写坏的会话数据\`（`recon.mjs` / `repair-seq4222.mjs` / `verify-all.mjs` / `verify-host.mjs`） |

### 18.3 待修清单（按优先级）

| 优先级 | 待修项 | 证据线索 |
|---|---|---|
| P1 | **失联检测误报** —— 补「会话还在活动」判据 | 账本 6 次自动阻塞里**至少 4 次被明确记为误报**：`5a871c` 13:47:39Z（audit 43 行原文「是静默计时的**误判**（原计划会话 <session-id> 当时活着，随后成功交了计划）」）· `214043` 13:48:10Z（裁定原文「【一、事实认定：**误判成立**，你这一席没有失联】」）· `5a871c` 16:59:37Z（`handoffs\010`「属静默计时误判」）· `5a871c` 12:20:45Z（12:25:26 解除备注「属"纯干活不产证据"被 5 分钟阈值**误杀**」）。判据形态与单内缓解口径见 `214043\handoffs\025`。★ 当时明确挡回「顺手改判据」：「改判据属新增需求，须先过用户、再由计划位补授权与验收」 |
| P1 | **打回必须带原因 + 禁止继续** | 单 `T-20261012-7b9408`（`analyzing`，6 处取舍已答 `16:36:34Z`）。★ 用户答复把第 5 条**否掉**了 —— 见 18.4-② |
| P2 | **跨工作区写要人工批准 + 审批不流转到主对话** | 账本里能核到的只有「**3 笔审批**」这个数：`T-20261011-5a871c\audit.jsonl` 17:13:23Z 解除备注原文「（跨两棵树写盘，期间宿主按操作弹了 **3 次审批**，用户已全部批准）」。**但 `approval:allowed-once` 这个字样在本节搜索范围内一处都没有**（`.pipeline\` 全量 · `.dsh\sessions`（78 MB / 101 个近期文件）· `.dsh\logs`（0 MB））⇒ 这条目前只有「3 笔审批」可信，「审批不流转到主对话」**没有可核证据** |
| P2 | **守门把「任务文本」误判成「代码正文」** | **账本内未找到对应条目**。最接近的是两张同需求老单的需求原文（`T-20261011-4a2dc7` / `T-20261011-a5fe41`）：主对话读 DSH 日志的 shell 被守门拦下，拒绝原文「主对话不得通过 shell 读取项目代码…原因：主对话与代码正文隔离」——那是「**拦截正确、但动手前不知道**」的形态，与「任务文本被误判」不是同一条 |
| P2 | **会话命名 / 分组** | `T-20261011-63633e\task.json` 需求原文：分组名要按**任务的项目名 / 落点目录名**取，不得用插件目录名（`desktop`）；用户上一轮因分组名错删掉了整组。该单 13:36:32Z 冻结备注把「分组名取错来源」列为四个真缺陷之一。**遗留破口仍在**：`T-20261011-214043\handoffs\032-dev_to_test.json` 已知问题 4「历史会话不再同组…同一分组在本单期间由 7 枚缩到 2 枚」 |
| P3 | **没有停会话的通道** | **账本内未找到**（`.pipeline\` 里搜「停会话 / 关闭会话 / 杀会话」无命中）。相关但不同：`pipeline_succession`（换班）与 `transition:block`（冻结单）都**不涉及关闭会话** |
| P3 | **`sync-trees.cjs` 硬编码写区外那棵** | 脚本本体：`T-20261011-5a871c\reports\writer\sync-trees.cjs`（5061 B）—— 第 20–21 行把 `ACTIVE`（生效副本）与 `SOURCE`（`dsh_orb\新任务-为-dsh-…\dsh-pipeline`，**区外**）写死；`--write` 时把生效副本里本单改动的 7 个文件（`FILES` 第 27–35 行）逐个复制进源码树。应改成「只写区内 + 输出待同步清单」 |

### 18.4 逐条核账本后发现的**对不上**（照实写，不顺着口径写）

**① 214043 的制品版本指针不唯一。** `handoffs\032-dev_to_test.json` 的 `artifact_version` 是 **v5**（`sha256 e7189032…`，22875 B），但 `artifacts\` 目录里还有 `v6`（13031 B）、`v7`（20551 B，**文件名与 v6 同名** `channel-side-v6.md`）、`v8`（16055 B，`channel-side-v8-CURRENT.md`，其 `note` 自称「**唯一现行版**…文件名带 CURRENT 以便 tester 分辨」）。⇒ **交测试指向 v5、现行版自称 v8、且 v6/v7 同名**。tester 接手前必须先裁定现行版，否则会测错版本。

**② 7b9408「6 处口径已答」为真，但答复把本单原始口径否掉了一半。** `task.json human_requests[0].answer.decision` 原文：「① **第 5 条不按你的建议** ✗ —— **人发起**的打回（用户 / 审核等）**不必**写"哪条判据 / 缺什么 / 怎么改" ✓；人打回只需留痕「谁、何时、打回了什么」」。而本单需求原文写的是「**任何**打回/拒绝都必须①告知原因②禁止继续 —— 且**人打回与系统自动打回一视同仁**」。⇒ 现在**只有系统打回**要带原因 + 禁止继续；「人打回也要带原因」这条已被用户撤销。另：答完之后**没有**按新口径重出需求分析结论（无新 `requirement_analysis` 交接物、`roster=null`），且答复未回带确认码（请求开了 `HC-3edae2f3`，`answer.confirm_code=null`）。

**③ 「五张单」之外账本里还有 4 张**（见 18.1 补充）。写「五个任务目录」时会与 `.pipeline\` 实际内容对不上 —— 建议写成「**9 个目录：5 张在推 + 4 张历史 / 孤儿 / 已取消**」。

**④ 两棵树「逐文件一致」只对已被点名的关键文件成立。** 实测（本次现算 SHA-256）：`lib\hostmsg.js`、`lib\liveness.js`、`lib\store.js`、`lib\wakeup.js`、`lib\hashgate.js`、`lib\tiers.js`、`lib\roles.js`、`lib\guard.js`、`index.js` 两棵树**相同** ✓；但文件总数不同 —— `lib\`：生效副本 74 / 源码树 82；`tests\`：82 / 83；`.bak-*`：77 / 90。⇒ 说「两棵树一致」必须限定**到文件清单**，不能说「整棵树一致」。

**⑤ 「误杀 4 次」的数对得上，但口径要说清**：账本里失联自动阻塞共 **6 次**（含更早的 `T-20261011-a5fe41` 10:58:48Z 一次），其中**明确记为误报的 4 次**集中在 10-11 傍晚至 10-12 中午 ⇒ 应写成「6 次自动阻塞中的 4 次」。

**⑥ 命名口径**：本次任务描述里写「**四张单**」但列了 **5 张**（214043 / 5a871c / 56a37e / 7b9408 / 63633e）。本节按 5 张写。

### 18.5 恢复步骤（一句话）

在**新对话**里逐单重新认领即可：

```
pipeline_task_open { task_id: "<task_id>", reattach: true }
```

理由（账本自证）：绑定关系与令牌表都是**进程内存态**，DSH 重启后全失效 —— 每次重启后紧跟的都是一条 `main reattach`（`T-20261011-214043` 共 **11 次**、`T-20261011-5a871c` 共 **9 次**、`56a37e` 2 次、`a5fe41` 2 次、`63633e` 1 次）。认回身份后**按 18.1 的状态继续**；老单不认领就成孤儿（账本里的实例：`T-20261011-4a2dc7`）。

### 18.6 关键路径（照抄可用）

- **生效副本**（重启后由它加载）：`<DSH_HOME>\profiles\desktop\node_modules\dsh-pipeline`
- **源码树**：`<DSH_HOME>\dsh_orb\新任务-为-dsh-写一个插件-实现用户要的-多对话-ai-协作开发流水线-主对\dsh-pipeline`
- **账本**：`<DSH_HOME>\profiles\desktop\.pipeline\` —— 五个在推的：`T-20261011-214043`（32 份 handoffs / 8 份制品 / 6 份基线 / 17.97 MB task.json）、`T-20261011-5a871c`（11 份 handoffs / 3 份制品）、`T-20261011-56a37e`、`T-20261012-7b9408`、`T-20261011-63633e`
- **交接档本体**：`<DSH_HOME>\dsh_orb\DSH-多AI流水线-交接档.md`（＋桌面副本 `<HOME>\Desktop\DSH-多AI流水线-交接档.txt`，两侧**逐字节相同**）
- **两个产物目录**：`<DSH_HOME>\dsh_orb\dsh-pipeline-arch\`、`<DSH_HOME>\dsh_orb\dsh-pipeline-flow\`

## 19. 2026-10-12 夜 · 修复档（询问卡 / 插件 14 条缺陷 / 主对话重认领）

> ⚠️ **编号说明**：本档此前还用过一次「## 11.」（**重复编号**，§18 开头已专门说明过）。本节按顺延写作 **§19**。引用本档请按**标题文字**定位，不要按编号。
>
> **本节标注约定**（沿用 §18 的写法）：每条尽量标 **实测**（本次写档时由主对话现读文件 / 现算哈希 / 现查账本得来）或 **转述**（来自当晚修复者或席位的自报，本次**未**复验）。凡账本或文件里查不到的，明写「**账本内未找到**」，不补印象。

### 19.1 五张单的当晚进展 +「重启后必须重认领」的实证

**认领与重启（实测 + 账本双证）**：新对话里逐单 `pipeline_task_open { reattach: true }` 认回 5 张 —— `T-20261011-214043` / `T-20261011-5a871c` / `T-20261011-56a37e` / `T-20261012-7b9408` / `T-20261011-63633e`。当晚期间**又经历 3 次重启**（用户手动），**每重启一次都要重认领一次** —— 与 §18.5 的结论一致，原因不变：绑定关系与令牌表都是**进程内存态**。账本现证（`T-20261011-214043\audit.jsonl`）：

| 行 | at（账本原文） | action | note 原文（节选） |
|---|---|---|---|
| 217 | `2026-10-12T12:38:21Z` | `reattach` | 「★ 重启后重新认领主对话身份（不覆盖任何历史）」 |
| 218 | `2026-10-12T12:51:29Z` | `reattach` | 「★ 重启后重新认领主对话身份（不覆盖任何历史）」 |

同一晚两条 `reattach` 相隔 13 分钟 ⇒ **一次重启一条**，无遗漏、无合并。

**`T-20261011-214043` 当晚关键事件（逐条带时间与 id，全部实测引自 `audit.jsonl`）**

| at | actor | action | 内容 / 原文要点 |
|---|---|---|---|
| `12:51:32Z` | main | `transition:unblock` | 重启后重认领，解除冻结，按 §18.1-① 继续收尾（「本次不做任何技术裁定，只做路由」） |
| `12:53:25.015Z` | channel | `channel:dispatched` | 派 writer#3，真实会话 `<session-id>`，preset `computer-use`，permission **`workspace-write`** |
| `12:58:36Z` | main | `transition:block` | ★ **机制触发**（不是人叫停）：席位失联：编写（writer#3）　静默阈值 5 分 |
| `12:58:58Z` | writer | `artifact:register` | 制品 **v9**（13,146 B；`sha256 90d1f3a5…`）—— 即：**冻结落下 22 秒后席位照旧交件** |
| `12:59:13Z` | writer | `handoff:clarification_request` | 第 **`033`** 条澄清（`H-d917fdc907404429` / `CQ-33c294308dc32000`） |
| `12:59:38Z` | main | `transition:unblock` | 解除的是**一次误报冻结**；现场采集证据：该会话日志 30 秒内 381,679 → 392,396 B（**+10,717 B**）⇒ 席位正在活动 |
| `13:02:48Z` | writer | `handoff:clarification_request` | 第 **`034`** 条澄清（`H-bc5892f191e17a4f` / `CQ-c297e393b0e702de`，`blocking: true`） |
| `13:03:02.221Z` | channel | `channel:dispatched` | 派 orchestrator 席位 `<session-id>`，permission `read-only` |
| `13:05:48Z` / `13:05:54Z` | orchestrator | `handoff:human_request` | 两条人工请求（`HR-97269de32e5d5eeb` / `HR-a72b1cd1650d4794`），各带一条 `clarify:escalate`（澄清梯升级到主对话） |
| `13:09:13Z` / `13:09:14Z` | main | `human:relay` | 两条请求经主对话转告用户（`relay_channel: "chat"`） |
| `13:10:14Z` | main | `human:reply` ×2 | 用户**点选**答复（`reply_channel: "selected"`）：①「由主对话立刻落实（推荐）」②「允许以文档型交付登记（推荐）」（确认码 `HC-469025fc`） |
| `13:10:23Z` | main | `transition:human_reply` | 补做状态恢复：同批第 2 条尚未记录导致首次恢复失败，两条齐后重放 ⇒ 回「开发中」 |
| `13:10:28Z` | main | **`baseline:take`** | 重取改动基线 **`BL-54e64ac83008edc9`**，`file_count: 15995`，清单指纹 `991493b4cbf1aa04442fa3e0ad1f60b1b6cae036e9ff622e2d33da80c72ce808`（实测：基线文件 2,779,759 B，mtime 2026/10/12 21:10:28 本地） |
| `13:10:28Z` | main | `gate:hash_reset` | `prev_streak: 0 → now_streak: 0`；备注原文：「三类越界判定与"声明不实"判定**一个字没放宽**」 |
| `13:11:01.317Z` | channel | `channel:dispatched` | 再派 writer#3，**新会话** `<session-id>`（`workspace-write`） |
| **`13:16:50Z`** | main | `transition:block` | ★ **又一次机制触发失联冻结**（`agent: null`）—— 落在席位正干活中间 |
| `13:17:33Z` | main | `transition:unblock` | 按用户裁定解除该误冻（依据：该会话 21:13:45–21:17:24 由 267,613 B 增至 457,548 B，**+190 KB / 约 3.7 分钟**） |
| `13:18:28Z` / `13:19:53Z` | writer | `handoff:clarification_request` | **`037`**（`H-5f7d8b502f34a0c7` / `CQ-a62975f9f2354fa2`）与 **`038`**（`H-26218d4b6c048096` / `CQ-538b6f28bfadb02e`）—— 与「本单在线的 orchestrator 席位已收工且**不会被唤醒**」有关 |
| `13:20:37Z` | main | `transition:block` | ★ **主对话按用户裁定主动冻结**（备注首句原文：「★ 主对话按用户裁定主动冻结（**不是误报触发的**）」）—— 理由：席位陷入「提问 → 无人能答 → 再问」空转，5 分钟内 267,613 → 601,040 B 持续消耗 |
| `13:25:55Z` | main | `transition:unblock` | 用户裁定走「**先由测试位抓回归**」；备注原文：「以便编写席把**尚未交出**的交付提上去、触发 `dev_submitted` 进入「待测试」，再由测试位抓出「计划校验：**writer 席位未声明四槽**」这条回归」 |
| `13:32:15Z` | writer | `artifact:register` | 制品 **v10**（9,491 B；`sha256 a4f2c25e…`） |
| `13:32:42Z` | writer | `gate:hash` | `pass: true, streak: 0, threshold: 3`；`counts`：`added 1 / modified 0 / removed 0 / unauthorized 0 / undeclared 0` |
| `13:32:42Z` | writer | `handoff:dev_to_test` | **`039-dev_to_test.json`** = `H-33307933afa8d3e9`，`artifact_version: "v10"`；同日 `seat:submit` 记 `writer#3` `done 1/3`、`within_scope: true` |
| `13:37:37.445Z` | channel | `channel:dispatched` | 又派 writer#3（会话 `<session-id>`，preset `standard`，`read-only`） |
| `13:43:26Z` | main | `transition:block` | ★ 又一条**机制触发**失联冻结（`agent: null`）—— 本单末条账本记录 |

★ **上述「21:16:50Z 误冻」与 `039` 的准确关系（照实写，不顺着口径写）**：账本里 `13:16:50Z`（＝本地 21:16:50）那次机制冻结**确凿存在**，而且它落下时席位正在活动（当晚**同形机制误冻两次**：`12:58:36Z` 与 `13:16:50Z`）；但**账本不支持**「这一次误冻直接挡掉了一份**已提交的** `dev_to_test`」这种说法 —— 本单当晚真正走成出口的 `dev_to_test`（`H-33307933afa8d3e9`）发生在 **`13:32:42Z`**，而 `13:25:55Z` 的解冻备注原文写的是「把**尚未交出**的交付提上去」。⇒ 宜写作：「**当晚两次失联机制误冻（`12:58:36Z` / `13:16:50Z`）都落在席位干活中间，打断了本单交测试的节奏；真正的 `dev_to_test` 到 `13:32:42Z` 才走成**」。

**`039` 本体（实测）**：`handoffs\039-dev_to_test.json` = **14,068 B**，58 行，mtime 2026/10/12 **21:32:42**（本地），`artifact_version` = **v10**。形态是**文档型交付**：席位新增的唯一文件是 `node_modules/dsh-pipeline/tests/supervisor-check.mjs`，自测口径原文写「**编译级冒烟 + 只读前提复核**（不跑测试目录脚本、不给通过结论 —— 那是 tester 的判定）」，并明确**未执行** `node tests/supervisor-check.mjs`（「编写不跑测试」，守门边界）。该交付自报的只读前提复核里有一条恰好旁证了下面那条状态机规则：`developing + dev_submitted + writer → ok=true to=ready_test`；同处还记下 `TRANSITIONS = 27`、`by` 白名单 = 15 个角色（含 `writer`、`main`）。

**`dev_submitted` 只允许 writer（实测 · 源码级证实；拒绝原文未找到）**

- 源码：`node_modules\dsh-pipeline\lib\states.js:210` —— `{ from: ST.DEVELOPING, event: 'dev_submitted', to: ST.READY_TEST, by: ['writer'], guard: 'dev_to_test', note: '★ 编写交测试（唯一出口）' }` ⇒ **白名单只有 `writer`，`main` 不在内**。拒绝文案模板见同文件 `:349`：`` `事件「${event}」只允许角色 ${t.by.join('/')} 触发，当前调用方是「${actorRole}」。` ``
- 这与「状态摘要里写的 `(writer)`」**一致**。
- ⚠️ 但**主对话被拒的那句原文**（「事件「dev_submitted」只允许角色 writer 触发，当前调用方是「main」」）**账本内未找到**：对 `.pipeline\` 全量递归搜「只允许角色」，只命中 2 处（`T-20261011-214043\artifacts\v9\supervisor-positioning-v9.md` 第 130–131 行），而那里的上下文是「事件只允许 `main` 触发」的另一条事件，**不是** `dev_submitted`。⇒ **规则可信（源码可证），现场拒绝原文没拿到**。
- ★ **席位曾把这条规则记反，值得记一笔**：本单历史里席位一度按「主对话可代触发 `dev_submitted`」理解并据此规划；而 `13:25:55Z` 的解冻备注与 `039` 的交付形态说明，反过来都依赖「交完触发 `dev_submitted`」由**编写席**自己完成。

**最终状态（实测）**：`T-20261011-214043` 当晚被**人工冻结**（`13:20:37Z` 起，**非误报触发**），停在「已阻塞」，**停手等修完**。

**`T-20261012-6884af`（当晚新开，专修两个缺陷）** —— 实测：目录存在，`task.json` 200,099 B，`audit.jsonl` 12,118 B，`handoffs\` 共 **11 份**（`001-requirement_analysis.json` → `011-human_request.json`，其中 `003`–`010` 是 **8 份连续 `plan.json`**）。当晚走完的流程：`待分配 → 需求分析中 → 待计划 → 计划中`；需求分析结论 `H-d6edcd25b7389aed`；两次人工裁定 `HC-7f84bd40`（①②③ 全按推荐）与 `HC-45e408df`（走「先由测试位抓回归」）；**后被人工冻结等回归修好**。（流程与两个裁定编号为**转述**；本次只实测到目录存在与文件构成。）

**其余 4 张当晚未动（实测）**：`T-20261011-5a871c` / `T-20261011-56a37e` / `T-20261012-7b9408` / `T-20261011-63633e` 原样躺在 `.pipeline\` 下，当晚无新交接物。

**账本目录数更正（实测）**：§18.1 写「`.pipeline\` 实际是 **9** 个任务目录」—— 现在实测是 **10 个**，新增的那个就是 `T-20261012-6884af`。⇒ 现值应读作「**10 个目录：5 张在推 + 1 张当晚新开（`6884af`）+ 4 张历史 / 孤儿 / 已取消**」。

### 19.2 询问卡（`ask_user_question` 渲染）两层缺陷 —— 第一层已修 / 第二层修了一半

今晚把「询问卡不显示、显示成裸 JSON」拆成**两层独立缺陷**，两层都定位到了行号级。

#### 19.2.1 第一层：配置「够不着」（已修 · 已生效）

| 项 | 内容 |
|---|---|
| 现象 | 询问卡掉兜底，正文打出一段裸 JSON；卡头没有「回答」入口 |
| 根因 | `tool-ask-user` 在 effective tree 里是 `preset-computer-use.config.plugins[]` 的**预设子行**，而 profile `cordis.patch.yml` 里那条 `- id: tool-ask-user`（**实测**：`profiles\desktop\cordis.patch.yml` 第 **75–76** 行，**顶层**，`disabled: false`）是**顶层 id 覆盖** ⇒ 宿主 `applyEntryPatches` 的 `buildMap` **只索引顶层条目** ⇒ **永远找不到目标、静默跳过** ⇒ `mode` 保持默认 `legacy` ⇒ 无 `timeout` ⇒ `answerable=false` ⇒ 掉兜底打裸 JSON |
| ★ 关键推论 | **与「重启没重启」无关** —— 结构上够不着，重启多少次都一样。实证：那条配置自 **10-11 23:02** 起就在文件里，而进程 **10-12 20:14:53** 才启动 |
| 修法 | 在生效副本 `node_modules\dsh-orb\cordis.patch.yml` 给 `tool-ask-user` 补 `config: { mode: timed, timeout: -1 }`（**+3 行**） |
| 实测坐标 | 改动落在第 **53–57** 行（`- id: tool-ask-user` 在 53–54，新增 `config:` 在 55–57）。任务描述写作「第 52–56 行」，**差一行**。字节链：`.bak-20261012-204944` = **3,546 B**（改前，73 行）→ `.bak-20261012-214924` = **3,618 B**（+3 行，76 行）→ 现值 **4,428 B**（89 行，已含下一段的 insert 块） |
| 结果 | **已生效** —— 卡头出现 `❓ 提问 · 等待回答` + 「回答」胶囊（**转述**：用户重启后现场确认） |

**同病 no-op 覆盖还有 9 条（实测 · 部分证实）**：任务描述点名的 9 条 —— `tool-bash` / `tool-pwsh` / `tool-web` / `persona` / `compaction` / `compaction-basic` / `command-compact` / `tool-result-pruner` / `tool-computer-use` —— 在 `profiles\desktop\cordis.patch.yml` 里**都能实测到**顶层 `- id:` + `disabled: false`（行号：`persona` 61、`tool-bash` 63、`tool-pwsh` 65、`compaction` 67、`compaction-basic` 69、`command-compact` 71、`tool-result-pruner` 73、`tool-web` 80、`tool-computer-use` 82）。它们与 `tool-ask-user` 同一个病（顶层覆盖指向预设子行），只是**恰好都写成 `disabled: false`**（与默认一致）⇒ 静默跳过也不改变行为，所以**至今没爆**。

★ **两点别读错**：① 本次**未逐条验证**「这 9 条指向的目标是否全在预设子行里」（只抽样看了 orb 侧 `tool-result-pruner` / `tool-web` 等确实带 `config` 的子行）；② 该文件里同形的顶层 `disabled: false` 条目**实测约 25 条**，所以「9 条」是**筛过之后**的数，**不是**该文件全部顶层覆盖。

#### 19.2.2 第二层：正文渲染（已修 · 但**点选项仍无反应**）

| 项 | 内容 |
|---|---|
| 现象 | 卡在 `state === "running"` 时正文走兜底打 `bodyRaw`，不画问题文本与选项 |
| 根因 | `dsh-client-ui-tool\lib\client.js` 的 `AskQuestionRow` 在 **`state === "running"` 分支（第 2238–2240 行）是全文 9 处 `transcript` 赋值中唯一缺失的那一处** ⇒ `askQuestion = null` ⇒ 走兜底；且宿主 `AskQuestionCard`（35 行）**根本不画 `button`** ⇒ **配置层无解** |
| 修法 | 新建客户端插件 `node_modules\dsh-askcard-row\`，**遮蔽同一 keyed 槽位**（`priority: -1`），自绘「问题文本 + 选项按钮」；insert 块写在 `node_modules\dsh-orb\cordis.patch.yml` 第 **79–89** 行 |
| 实测坐标 | 插件目录共 **5 个文件**：`client.js` **32,438 B** / `cordis.patch.yml` 856 B / `index.js` 1,079 B / `package.json` 944 B / `README.md` 10,929 B。orb patch 同时从 3,618 → **4,428 B** |
| 结果 | **已生效**（**转述**：用户重启 + 刷新后，卡片正文变成「问题文本 + 一排可点选项按钮」，无裸 JSON）。截图**实测存在**（1,543,318 B）：`<DSH_HOME>\attachments\v1\objects\97\9753d6f6a83c035d464da74284217bdf61beced9218cc1c5afcc09db8325154f` |
| ⚠️ **剩余未修** | **点选项无反应**（用户原话「有框但是我点不了，无反应」）—— 这比插件 README 预告的「会叫回作答卡、还需再点一下」**更差**，**连那半步都没发生**。已派新会话修（**截至本档写作时仍在跑**） |

**报告与验证脚本（实测坐标）**

- 第二层报告目录：`dsh_orb\修-dsh-web-gui-的-询问卡正文-渲染-第二层缺陷-上一轮已经做过一次\`
  - `报告-第二层-询问卡正文渲染.md` —— **实测 25,240 B / 310 行**（任务描述写「257 行」，**对不上**）
  - `verify-askcard-wiring.cjs` —— 7,821 B / 193 行；只读检查 **6/6 通过**（**转述**）
- 首次诊断报告：`dsh_orb\任务-诊断-dsh-web-gui-的-询问卡无气泡-故障-产出根因-可落地修法\diagnosis.md` —— **实测 37,194 B / 553 行**（任务描述写「37 KB / 453 行」：**字节对得上**（37.2 KB），**行数对不上**）

### 19.3 `dsh-pipeline` 插件 14 条缺陷修复 —— 13 条已修

**规格与变更说明（实测）**

| 文件 | 实测 | 与任务描述 |
|---|---|---|
| `dsh_orb\插件缺陷修复规格-20261012.md` | **12,352 B / 119 行** | ✅ 相符 |
| `dsh_orb\任务-修复-dsh-pipeline-插件的-14-条缺陷-用户已裁定-本次只修\changes.md` | **30,950 B / 270 行** | ✅ 字节相符（另附 `sync-and-hash.cjs` / `sync-report.txt`，**转述**） |

#### 19.3.1 B1（全局瘫痪）已消掉 —— 真根因与我们原先的怀疑**不同**

**同一把「尺子」被算了两遍，而两遍口径不一样。**

- `lib\tiers.js` 的 `buildRosterSlots` 对**有分区的编写角色**只产生 `writer@<席位>` 键、**按设计不产生裸 `writer` 键**（既有夹具**逐字断言过**这一点）；
- 而 `lib\store.js` 的**写入前置判据自己又算了一遍**，并**要求裸 `writer` 键** ⇒ **恒缺 1 个** ⇒ **每次都点名 `writer`** ⇒ 所有任务都出不了计划，即「全局瘫痪」。
- 与插件开关的停用理由**互为印证**（实测）：`.pipeline\switch.json` 的 `reason` 原文写「管道当前无法自修 —— 计划路径被「**writer 席位未声明四槽**」回归卡死（所有单都出不了计划）」。

**时间线更正（实测 · 备份逐版比对）**：该闸门**不是** 2026-10-12 20:10–20:21 那批改动引入的。

| 备份（`…\dsh-pipeline\lib\`） | 实测字节 | B1 写入前置判据 | 判据 |
|---|---|---|---|
| `store.js.bak-20261012-010449`（00:41） | 299,674 B | **不含** | 第 1732–1743 行只有 `buildRoster(...)`，无 `slotRoleNeedsDeclaration` 分支；第 28 行 `./tiers.js` 导入里**没有** `slotRoleNeedsDeclaration` |
| `store.js.bak-t3led-20261012201047`（**20:10 改动之前**的快照） | 302,078 B | **已含** | 第 1744–1748 行出现该分支，注释原文「★ B1 的写入前置判据（名单权威层）」；导入行已加 `slotRoleNeedsDeclaration` |

⇒ 闸门在 **10-12 01:04 前后**就已存在。（「01:04」为**转述**；本次实测只把区间收窄到「`00:41` 版不含、`20:10` 前的快照已含」。）

**修法（实测 · 源码级）**：键集合**只有一个出处** —— 新增 `rosterSlotKeys()` / `rosterSlotTargets()`（`lib\store.js` 与 `lib\tiers.js` **现值都含**这两个符号，两个存档版**都不含**）。★ **判据没删、没放宽**（新夹具有反例）。

**其余条目（转述）**：**12 条已修**；**B14 作为 B5 的同根因一并消除**；**B10 未修成**（宿主审批弹窗不在插件拦截面上 —— **未**拿插件自己的审批链冒充）；顺带修掉 **2 条既有缺陷**（`supervisor` 的 `writes=readonly` 守门认不出；1 条夹具 bug）。

**实测数（主对话亲自跑，`workdir` = 生效副本）**

| 命令 | 结果 |
|---|---|
| `node tests/selftest.mjs --quiet` | **70/70** |
| `node tests/t14-fix-check.mjs` | **38/38** |
| `node tests/run-all.mjs` | 唯一未满分是**既有自相矛盾夹具** **70/72**（**改前也是 70/72**） |
| 残留检查 | 0 泄漏 |

上表四行为**转述**（修复者当晚自报，本次**未**复跑）；复核入口是生效副本 `…\profiles\desktop\node_modules\dsh-pipeline\tests\`。

**B2 离线复算（用户裁定的验收 ② · 转述）** —— 返回体原文：

```json
{"known":true,"grew":true,"delta_bytes":10717,"delta_ms":30000,"reason":"会话日志在活动：30 秒 内 +10717 字节"}
```

⇒ 判为**还在活动**；**反例仍在**：同席位日志不再增长 ⇒ 照旧判失联（**检测没被关掉**）。★ 旁证（**实测**）：这组数字与账本 `12:59:38Z` 解冻备注里现场采集的「30 秒内 381,679 → 392,396 B（**+10,717 B**）」**完全同源**。

**改动面**：改动 **11 个文件**，两棵树已逐文件同步 + sha256 清单（**转述**）。★ **两棵树有既有漂移，未做整体覆盖** —— 与 §18.4-④ 同结论；**但口径对不上**：§18.4-④ 当时实测 `lib\`＝生效副本 **74** / 源码树 **82**，本次任务描述给的是 `lib`＝**70 / 80**。引用前需统一口径。

### 19.4 当晚新发现、且**尚未修掉**的缺陷（待修清单）

| # | 待修项 | 现象 / 根因 | 状态 |
|---|---|---|---|
| ① | **关掉插件开关管不住「结果侧守门」** | 开关为 `on: false`（**实测**：`.pipeline\switch.json`，`revision: 9`，`since: 2026-10-12T13:39:06Z`，`by: "tool"`）时，主对话读**含代码**的工具结果**仍被拦**，拒绝原文：「这次工具结果里有代码正文，你是「主对话」——不看代码」。⇒ 开关管的是**调用侧** `tools/pre-execute`；「结果侧守门」走的是另一条路径。**实测旁证**：`guardMainReadsCode` **仍是 `true`**（`profiles\desktop\cordis.patch.yml:122`） | 未修 |
| ② | **`code_agent` 的「会话续接归属登记」也是进程内存态** | DSH 重启后 `code_agent { session_id }` 报「can continue only a session this Computer Use agent started」⇒ **与管道令牌表同源**。**重启前开的会话，重启后一律续接不了** | 未修 |
| ③ | **唤醒消息的 6 类毛病** | ① 状态快照过期（**6 次**）② 归因错误（1 次）③ 空报交付（2 次）④ 空报人工请求（2 次）⑤ **反复重放** ⑥ 水位自报被播报成「交了一份交接物」（各项计数为**转述**） | 未修 |
| ③-附 | ★ ③⑤ 的**账本现证（实测）** | 重放链 `h215 → h216 → h220 → h228 → h233 → h237` **逐条实测存在**，`at` 依次 `13:00:58Z / 13:01:14Z / 13:02:48Z / 13:05:43Z / 13:05:49Z / 13:05:55Z`，`key` 末段就是递增序号 `h<N>`（形如 `…\|writer#writer#3\|h215`）。★ **注意间隔并不均匀**（16 秒 / 94 秒 / 175 秒 / 6 秒 / 6 秒），「约每分钟一条」是粗描；幂等键**末段确实是递增计数器而非交付身份** ⇒ **支持**该怀疑。这些条目还都带 `duplicate_at_host` 字段 | 未修 |
| ④ | **席位与边界卡错配** | `pipeline_dispatch { seat: "writer#3" }` 回执给的是「席位 **writer#1** · channel」的卡，**连续 3 次稳定复现** ⇒ 已在 §19.3 那轮修（**转述**）；★ **原始字符串现象修复者未复现** | 已修（原始现象未复现） |
| ⑤ | **分组名取错来源** | 新派会话落进标题为 `desktop` 的项目分组（取的是**插件目录名**）。与 §18.3 同一条 | 未修 |
| ⑥ | **`pipeline_help` 不存在却被引用** | 已在 §19.3 那轮修：改为挂在 `pipeline_status` 的 `help=<主题>` 参数上 | 已修 |
| ⑦ | **计划 `role_boundaries` 未覆盖全部执行角色** | 已在 §19.3 那轮修：交计划前会核对，**缺一张就拒** | 已修 |
| ⑧ | **询问卡「点选项无反应」** | 见 §19.2.2「剩余未修」 | 未修（新会话在跑） |
| ⑨ | **B9 只修了一半** | `guard-factory` 冷索引时的 **fail-open 仍在**（修复者自报） | 半修 |
| ⑩ | **`app.asar` 路线未走**（修复者建议不走；主对话与用户**均同意**） | 真正最小的修法是 asar 内 `dsh-client-ui-tool\lib\client.js` 单分支 **3 行补丁**，但：121 MB 归档重打包会遇到「DSH 正在占用」、回退只能靠**整份备份**、且**应用升级即失效**。插件路线**可回退**且失败模式安全（插件崩了会被 `abdicate` **永久让位**） | 定为不走 |

### 19.5 恢复步骤（照这个走）

```
1) 重启 DSH，并把 dsh-pipeline 插件启用回来（当晚它被用户真关以放行修复）
2) 新对话里逐单重新认领（令牌表是进程内存态）：
   pipeline_task_open { task_id: "<19.1 那五张单的 task_id>", reattach: true }
3) 活体验证插件修复：pipeline_selftest（期望正例夹具 70/70）
   + 跑一份真计划（看角色清单能不能出 ⇒ 全局瘫痪是否真解开）
4) 验证询问卡：提一个问题，看卡片是否是「问题文本 + 可点选项按钮」且点一下有反应
5) 回到 T-20261011-214043 的收尾：解冻 → 待测试 → 派 tester → 审核
   ★ 注意 dev_submitted 只允许 writer 角色触发，主对话会被拒
```

★ **第 1 步的实测现状（写档时）：两处开关当前不一致 ——**

- `.pipeline\switch.json`：`"on": false`（`revision: 9`，`since: 2026-10-12T13:39:06Z`）⇒ **管道功能处于用户裁定的暂停态**；
- `profiles\desktop\cordis.patch.yml:112–123`：`dsh-pipeline` 条目 `disabled: false`、`config.enabled: true`（含 `guardEnabled: true`、`guardMainReadsCode: true`）。

⇒ 恢复时**不要只看 profile 的 `disabled`**：真正决定管线跑不跑的是 `.pipeline\switch.json` 的 `on`。

### 19.6 关键路径（照抄可用）

- **询问卡插件（本轮新建）**：`<DSH_HOME>\profiles\desktop\node_modules\dsh-askcard-row\`（`client.js` 32,438 B / `cordis.patch.yml` 856 B / `index.js` 1,079 B / `package.json` 944 B / `README.md` 10,929 B）
- **① 号待修的两个把手**：`profiles\desktop\cordis.patch.yml:122`（`guardMainReadsCode: true`）· `.pipeline\switch.json`（`on`）
- **orb 配置**：`profiles\desktop\node_modules\dsh-orb\cordis.patch.yml`（现值 4,428 B；`tool-ask-user` 的 `config` 在 **53–57** 行；`dsh-askcard-row` 的 insert 块在 **79–89** 行）—— 备份链 `.bak-20261012-204944` 3,546 B → `.bak-20261012-214924` 3,618 B
- **插件缺陷修复材料**：`dsh_orb\插件缺陷修复规格-20261012.md` · `dsh_orb\任务-修复-dsh-pipeline-插件的-14-条缺陷-用户已裁定-本次只修\changes.md`
- **询问卡两层材料**：`dsh_orb\任务-诊断-dsh-web-gui-的-询问卡无气泡-故障-产出根因-可落地修法\diagnosis.md` · `dsh_orb\修-dsh-web-gui-的-询问卡正文-渲染-第二层缺陷-上一轮已经做过一次\{报告-第二层-询问卡正文渲染.md, verify-askcard-wiring.cjs}`
- **B1 时间线取证用的两个备份**：`node_modules\dsh-pipeline\lib\store.js.bak-20261012-010449`（**不含**）· `store.js.bak-t3led-20261012201047`（**已含**）
- **账本**：`<DSH_HOME>\profiles\desktop\.pipeline\` —— 现值 **10 个任务目录**（§18.1 写的 9 个 ＋ 新增 `T-20261012-6884af`）

### 19.7 「§1–§18 一字未动」的自证方法

本节是**只追加**写入的，证明方式是**前缀字节哈希**（不是目测）：

1. 追加**之前**，对整份主档算 SHA-256 并记下长度：**70,718 B** ⇒ `255990bf0c9723c429798f1584d85ba400f17caeaa609cb914ac229744153a3e`。此刻「整份 = §1–§18」，所以这个哈希**就是** §1–§18 的哈希。
2. 追加**之后**，只取**前 70,718 字节**再算一次 SHA-256 —— 仍等于上式 ⇒ **§1–§18 一个字节没变**（长度与哈希双条件）。
3. 追加采用**纯文件末尾追加**（不在文件任何其他位置做写入或截断）；文件**无 BOM**（实测首 6 字节 `23 20 44 53 48 20` ＝ `# DSH `），换行沿用原有的 `LF`（原末字节 `0a`）。
4. 桌面副本 `.txt` 与主档**逐字节相同**（两侧长度与 SHA-256 逐次比对一致）—— 这是本档既有约定。
