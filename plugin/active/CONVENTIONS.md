# dsh-pipeline · 目录与文件规范（CONVENTIONS）

> 本文件是**新增代码的规矩**，不是"建议"。
> 它的存在理由只有一个：**文件拆分是刚需** —— 拆分方式决定了这活能不能多人并行写
> （用户裁定 9：「文件按域/职责拆分是**项目管理刚需**，且决定**编写能否并行**」）。

- 适用范围：`plugin/active/lib/**` 与 `plugin/active/tests/**` 下的**新增**文件
- 生效时间：本批次（P1–P5）起
- 本批次的一条**临时**附加约束（见 §6）：**既有文件一个都不许改**

---

## 1. 目录树

```
plugin/active/
├── CONVENTIONS.md                  ← 本文件：目录与文件规范
├── WIRING.md                       ← 接线待办（新模块 → 既有文件的落点）
├── lib/
│   ├── project/                    P1·P2 — 项目目录 / 仓库 / 快照 / AGENTS.md
│   │   ├── id.js                   project_id ↔ project_dir 绑定
│   │   ├── layout.js               目录布局 + 授权面公共根 + 同源判定
│   │   ├── create.js               幂等建目录
│   │   ├── resolve.js              解析顺序（已绑定 > 既存根 > 授权面 > 全新）
│   │   ├── policy.js               git 优先 / 快照保留策略
│   │   ├── git-run.js              git 唯一调用口（白名单 + 远端写黑名单）
│   │   ├── git-init.js             git 化闸门 + init + 首次 commit
│   │   ├── snapshot-parse.js       快照版本号解析 + 段→序数
│   │   ├── snapshot-next.js        段进位（01…99 → A-01…）
│   │   ├── snapshot-compare.js     序数比较（禁止字符串排序）
│   │   ├── snapshot-dir.js         快照目录命名与幂等创建
│   │   ├── agents-md.js            AGENTS.md 渲染 + 幂等落盘
│   │   └── agents-md.template.md   AGENTS.md 模板（**独立成文件**）
│   ├── design/                     P3 — 产品目录与产品设计文档
│   │   ├── catalog-groups.js       MVP 必须 / 后续再说 两组
│   │   ├── catalog-schema.js       结构校验（空 MVP 被拒）
│   │   └── doc.js                  渲染 + 落 docs/product-design.md
│   ├── states/                     P4 — 新增状态（demo 阶段）★ 不往 states.js 堆
│   │   ├── demo-phase.js           两个新状态 + 四条边 + 合并器
│   │   └── demo-tier-policy.js     档位策略（L0–L1 跳 / L2 问 / L3+ 必出）
│   ├── store/                      P4·P5 — 状态推进判据（新增文件）
│   │   ├── demo.js                 DEMO 唯一写点
│   │   ├── demo-rounds.js          轮次账本与三条软约束（纯函数）
│   │   └── hub-require.js          强制主管唯一写点（先设后撤）
│   ├── guard/                      P4 — 闸门
│   │   └── demo-gate.js            未获确认不得进 ready_dev
│   ├── tiers/                      P5 — 档位规则
│   │   ├── tier-order.js           档位→序数（禁止字符串比较档位）
│   │   └── hub-required.js         L3+ 强制主管的纯策略
│   ├── tools/                      P1·P4 — 工具面
│   │   ├── project.js              pipeline_project_init
│   │   └── demo.js                 pipeline_demo
│   └── handoff/schemas/            P3 — 交接物字段表（一类型一文件）
│       └── product-design.js       product_design
└── tests/                          一测试一文件：pN-<slug>-check.mjs
    ├── p1-project-dir-check.mjs
    ├── p2-snapshot-version-check.mjs
    ├── p3-git-init-check.mjs
    ├── p4-agents-md-check.mjs
    ├── p5-product-catalog-check.mjs
    ├── p6-demo-phase-check.mjs
    ├── p7-hub-required-check.mjs
    └── p8-scope-root-check.mjs
```

> ⚠️ 上面这份是 **P1–P5 批次的历史切片**（只列当批新增的目录）。**当前结构以这条为准**：
>
> - 每个域都已拆成子模块：`lib/<域>/<职责>.js`；原 `lib/<域>.js` 只作 **barrel**（只 re-export，不写实现）
> - **两个集中层**：`lib/model/`（领域对象：task / baseline / artifact / close-report / human-request / handoff-*）、
>   `lib/errors/`（错误码 `codes.js` + 拒绝/提示文案 `text.js`）
> - 已拆包的 7 个大文件：`boundaries/`、`orphan/`、`liveness/`、`states/`、`hashgate/`、`tiers/`、`patrol/`（原文件均为 barrel）
> - 其余域：`guard/` `store/` `handoff/` `team/` `transport/` `memory/` `project/` `switch/` `intercept/` `wakeup/` `tools/` `panel/` `design/` `roster/` `scope/` `intake/`

## 2. 每个目录的职责（一句话，判归属时照这句问自己）

| 目录 | 负责什么 | **不**负责什么 |
|---|---|---|
| `lib/project/` | 项目目录 / 仓库 / 快照 / AGENTS.md —— "这一单落在哪个目录、怎么留版本点" | 状态机、闸门、角色权限 |
| `lib/design/` | 产品目录的**结构**与产品设计文档的**渲染** | 交接物的字段表（那在 `handoff/`）、落盘角色权限（那在 `guard/`） |
| `lib/states/` | **新增**状态与其迁移 | 既有状态机本体（`lib/states.js`）；状态里发生的副作用 |
| `lib/store/` | **状态推进的判据**与落盘（"能不能往前走" + "写哪几个字段"） | 判据本身（纯函数放域目录，如 `tiers/`、`design/`） |
| `lib/guard/` | **闸门**：拦下不该发生的推进 | 状态迁移表（那在 `states/`）、存储写入 |
| `lib/tiers/` | **档位规则**（纯策略，不读盘） | 档位存在哪、谁写它 |
| `lib/tools/` | **工具面**：参数表、输出契约、人话摘要 | 判定与写盘（都委托出去） |
| `lib/handoff/schemas/` | 交接物**字段表**，一类型一文件 | 校验实现（委托给域目录） |
| `lib/model/` | **领域对象**：task / handoff / baseline 等对象的**结构、默认值、字段清单、对象级纯函数**（"数据长什么样"） | 状态推进判据（`store/`）、校验实现（`handoff/`）、I/O |
| `lib/errors/` | **错误码与拒绝/提示文案的唯一出处**（"怎么说不行"） | 判据本身（`guard/`）、状态迁移（`states/`）、工具参数表 |
| `lib/panel/` | **自建面板**：只读快照（`/.dsh-pipeline/panel`）+ 受控写动作（`/panel/action`：终止 / 恢复 / 归档 / 删单 / 置顶 / 恢复归档 / 永久删除）+ 归档视图与置顶落盘 | 状态机判据（复用 `states/`）、UI 渲染（在 `lib/client.panel-*.js`） |
| `tests/` | 一测试一文件，**可直接 `node` 跑** | 测试框架、共享夹具库 |

## 3. 命名规则

### 3.1 实现文件：`lib/<域>/<职责>.js`

- **域**是上面那张表里的一级目录名（`project` / `design` / `states` / `store` / `guard` / `tiers` / `tools` / `handoff` / `model` / `errors`）
- **职责**是**小写连字符**的名词短语，回答"这个文件负责哪一件事"：`snapshot-parse`、`catalog-schema`、`hub-required`
- 一个文件**只放一件事**。判断标准：**它的改动原因是不是只有一个？**
  - 反例：`snapshot.js` 同时管"解析""进位""比大小""建目录" —— 四种改动原因，拆成四个文件
  - 正例：`snapshot-parse.js` 只在"版本号形态变了"时才改
- **禁止**：`utils.js` / `helpers.js` / `misc.js` / `common.js` 这类**说不出职责**的名字
- **禁止**：`xxx-v2.js` / `xxx-new.js` 这类版本后缀 —— 要改就改原文件，要么换一个说得出职责的名字

### 3.2 测试文件：`tests/<编号>-<slug>-check.mjs`

- **编号**：`pN`（本批次的阶段号），保证阅读顺序 = 依赖顺序
- **slug**：被测对象的**短名**，小写连字符（`project-dir`、`snapshot-version`、`git-init`）
- **后缀**：固定 `-check`，后缀之后固定 `.mjs`
- 例：`tests/p2-snapshot-version-check.mjs`
- 一个测试文件**只测一件事**（与实现文件同一条纪律）

### 3.3 文档文件

- 顶层规范与待办用**全大写**：`CONVENTIONS.md`、`WIRING.md`
- 模板类文件加 `.template` 中缀：`agents-md.template.md`

## 4. 拆分口径：**按模块能拆就拆**（默认拆），行数是兜底触发线

> **口径升级（2026-10-16）**：旧表述是"行数是信号、内聚为准"—— 那等于把举证责任放在
> **"要拆"** 那一方。新口径反过来：**默认拆**，**不拆的人举证**。

**默认：按模块能拆就拆 —— 一个模块一个文件。**
不拆必须能指出它属于下面哪一条"必要性"：

| # | 必要性 | 说明 |
|---|---|---|
| ① | 该文件本身就是**单一职责的声明/表** | 状态表、schema、常量表 —— 切开只会制造跨文件引用 |
| ② | 切开后会引入**共享可变状态** | 多处读写同一份数据，反而更脆 |
| ③ | **物理上无法切** | 宿主强制的单入口文件、生成物、按约定必须单文件的位置 |
| ④ | 有其它**可验证**的约束使之不可切 | 须写出该约束**与查验方式**；给不出查验方式 = 没给理由 |

**凡写不出上述任一条 ⇒ 视为"应该拆"，就拆。**
行数不是判据，但**超 400 行时必须先自证属于哪一条**，否则先拆再改。

| 对象 | 触发线 | 超了怎么办 |
|---|---|---|
| **任何新增文件** | **≤ 400 行** | 先自证属于上表哪一条；写不出 ⇒ **按模块继续拆** |
| 单个测试文件 | ≤ 400 行 | 拆成两个测试文件（各测一件事），不要写"综合大测试" |

- 超过 400 行且**自证不出来** = **本批次失败**（不是"下次注意"）
- 需要更多行时，**按模块拆**。示意（不限于此）：
  - `snapshot.js` 超限 → `snapshot-parse.js`（解析与序数换算）/ `snapshot-next.js`（进位）/ `snapshot-dir.js`（目录命名与创建）
  - `catalog.js` 超限 → `catalog-schema.js`（结构校验）/ `catalog-groups.js`（MVP/后续 分组）
- **反方向同样要守**：不许为凑行数把同一件事切碎（那会把"能拆就拆"读歪）。
  判据仍是"**一个文件只有一个改动原因**"，只是**举证责任在"不拆"那一方**。
- 每个文件**顶部第一行**必须有一行注释，写清"**这个文件负责什么**"：
  ```js
  // 快照版本号 · 解析与序数换算：把 `b.2026.10.15.A-01` 拆开并换成可比较的整数序数。
  ```
- **实例（是"必要性"的实例，不是"长文件豁免"）**：`lib/model/handoff-schemas.js`（25 类交接物字段表）
  与 `lib/roles.js`（角色表）属于 ①（单一声明表），经评估不再切。★ 这一条**不得**被读成"长文件一律豁免"：
  长文件照样要逐条自证，自证不出来就该拆。
- **客户端半边（按"装载边界"拆，不是"长文件豁免"）**：`lib/client.js` 是宿主按
  `/plugins/<包>/client.js` 发布的**入口** —— ≤400 行（当前正好 400），只做三件事：注册模块、
  「多AI 协调」开关、面板的 lazy wrapper；面板实现拆在 `lib/client.panel-<职责>.js` 共 14 个
  （每个 ≤400 行）：`shell` / `view` / `atoms` / `data` / `seats` / `menu` / `batch` /
  `batch-bar` / `card-actions` / `actions` / `preview` / `preview-data` / `preview-control` /
  `preview-bubble`。
- **宿主原生支持包内 chunk**，所以客户端拆得开：入口用 `require.async("./client.<name>.js")`
  取同级 chunk，宿主按 `/plugins/<id>/client.<name>.js?rev=<入口 rev>` 提供并按 **immutable**
  缓存（`rev` 变了才重取）；chunk 是**经典脚本**，用
  `window.__ModuleLoader__.load({ id, chunk, factory })` 注册。协议只支持**自包含 chunk**
  （入口与 chunk 不能同步 `require` 另一个相对 `client*.js` 产物），所以**组合只在入口做**。
  因为协议就是"入口 + 同级文件"，手工 JS **不需要 tsdown、也不需要改 `package.json`** ——
  文件放进去就能被取到（`tests/client-check.mjs` 钉住：入口列出的 chunk 与磁盘**一一对应**、
  每个都匹配宿主的 chunk 名规则、每个都走 `load({ id, chunk, factory })`）。
- **客户端侧的约束**：
  - 入口已**顶格 400 行** —— 新增客户端逻辑**一律新开 chunk**，不要再往 `lib/client.js` 里塞；
  - chunk 之间通过 shell 的**共享作用域**（`createPanel` 里的 `S`）或 `create(deps)` 的依赖组合，
    **不要**互相同步 `require`（协议不支持，运行时也拿不到）；
  - chunk 必须与入口**同目录**，文件名要匹配宿主的 chunk 名规则，否则宿主 404 / 拒收；
  - 每个 chunk 仍受本节 ≤400 行的约束：`client-check.mjs` 会逐文件数行，超限当场红。
- **证据出处**（可复核）：`@deepseek-ai/dsh-client-modules` 的 `README.zh.md`「浏览器加载什么」
  与「惰性 CJS 模型」两段（本机在 `<DSH 安装>/resources/app.asar` 内的
  `dsh/node_modules/@deepseek-ai/dsh-client-modules/README.zh.md`）。

## 5. 禁止往既有大文件堆叠

**这条是本规范的核心。**

- **禁止**把新功能追加进既有的大文件（曾经踩过的坑：`lib/states.js` 930 行、`lib/tiers.js` 990 行、
  `lib/boundaries.js` 1064 行、`lib/orphan.js` 1163 行 —— 它们已按本条拆成 `states/`、`tiers/`、
  `boundaries/`、`orphan/` 子目录，原文件只剩 barrel；今天再往 barrel 里堆就是违反本条）
- 新状态、新闸门、新工具、新判据一律**新开文件**，既有文件只允许**接线**（import + 一行调用/展开）
- 接线的那几行写进 `WIRING.md`（**落点、行号、具体那一行、为什么必须接、不接的后果**）
- 改到既有 **> 500 行**的文件时，**先抽取再改**：把要动的那一块先搬进新文件、行为不变，
  再在最小面积上做真正的改动

**判断"这算不算堆叠"的一句话判据**：
> 如果这次改动让一个既有文件**多出 30 行以上**，那多半应该是一个新文件。

**与 §4 的关系**：§4 是**默认拆**（不拆要举证），本节是它在"既有文件"上的具体化 ——
既有文件只允许**接线**；接线超过 30 行就该新开文件，而不是"反正它本来就大"。

## 6. 新文件必须登记进 `tests/run-all.mjs`

- 新测试**默认**要登记进 `plugin/active/tests/run-all.mjs`（否则聚合跑跑不到它，
  而"跑不到"的全绿是**假绿** —— 那条理由原样写在 `run-all.mjs` 的注释里）
- 登记点：文件顶部的 import 区 + `process.exit(ok ? 0 : 1)` 之前的运行块（当前在 `:747`）

> ### ⚠️ 本批次的**唯一例外**（必须写在这里，否则后人会以为漏登记了）
>
> 本批次（P1–P5）带一条**更硬**的附加约束：**既有文件一个都不许改**（用户裁定）。
> `tests/run-all.mjs` 是既有文件，所以 **p1–p8 这 8 套测试本批次刻意没有登记**。
>
> 这不是"忘了"，是**有意为之**，代价也说清楚：
> - p1–p8 **必须能独立运行**：`node tests/pN-<slug>-check.mjs`，自带断言与退出码，**不依赖** run-all；
> - 在**解除"零修改"约束的那一次提交**里，它们要按本节规则补登记 —— 具体落点见 `WIRING.md` §8；
> - 在那之前，**不要**把"run-all 全绿"当成"p1–p8 也全绿"。

## 7. 其它几条落到实处的纪律

- **纯函数放域目录，副作用放 `store/`/`tools/`**：判定（`tiers/hub-required.js`、`design/catalog-schema.js`）
  与写盘（`store/hub-require.js`、`design/doc.js`）分开，测试才不必造一个 store
- **一个常量只有一个出处**：角色 id 从 `lib/roles.js` 取、状态 id 从对应的 `states/*.js` 取，
  不许手抄字符串（手抄一份就是漂移的入口）
- **领域对象只从 `lib/model/` 取**：task / handoff / baseline 等对象的结构、默认值、字段清单
  不许在 `store/` / `handoff/` / `tools/` 里另写一份；新增领域对象先落 `lib/model/`
- **错误码与拒绝文案只从 `lib/errors/` 取**：错误码常量与拒绝/提示模板不许在调用点硬编码；
  同一个码只出现一次（`lib/errors/codes.js`），文案字面值**不许改写**（测试按字面断言）
- **拒绝要给"下一步"**：所有拒绝文案必须写清**为什么**与**怎么办** —— 只写"不行"的判词
  会让模型原地重试
- **测试先红后绿**：每条新测试都要有"旧代码红 → 新代码绿"的运行记录，否则无法证明它测的是真东西

## 8. ★★ 长入参**走文件**，不要内联（`spec_path` / `payload_path`）

### 8.1 规则一句话

**凡是"长中文段落"的入参，一律先写进一个 JSON 文件，再把路径传给工具。**

| 工具 | 字段 | 说明 |
| --- | --- | --- |
| `pipeline_plan` | `spec_path` | 计划规格（`plan_steps` / `role_scope` / `role_boundaries` / `change_scope`…） |
| `pipeline_orchestrate` | `spec_path` | 需求分析结论（`acceptance` / `test_points` / `boundaries` / `analysis_reason`…） |
| `pipeline_handoff` | `payload_path` | 交接物正文（`kind` 仍内联） |

语义：**从文件读整份入参 → 与内联字段合并 → 同名内联优先**。
`task_id` 必须内联（判据要先知道任务才判得了路径）；只支持 **JSON**（不带 YAML 解析器）。
于是"只给 `task_id` + 路径"与"全部内联"是**同一件事**，产物逐字节相同。

### 8.2 为什么（这不是风格偏好，是一条缺陷）

现场（用户截图为证）：席位调 `pipeline_plan` 时把 `reason` / `plan_steps` /
`role_scope` / `role_boundaries` / `change_scope` **全部内联**，模型侧写坏了参数 JSON ⇒
宿主判 `tool input is invalid JSON` ⇒ **`MALFORMED_RESPONSE` ⇒ 整轮作废（含此前全部上下文）**。

- 参数**越长、中文越多，写坏的概率越高** —— 这不是"模型不听话"，是**通道选错了**；
- 代价是**整轮上下文**，不是一次调用 ⇒ 重试的成本极高，值得为它单开一条通道；
- 成熟做法是 `diagram_deliver` 的 `spec_path`：大规格先落文件、传路径、工具内部读，
  大段内容**根本不经过工具参数**。

### 8.3 ★ 安全：这条通道**不许成为"不读代码"的后门**

读参数文件走的是**与 `read` 工具同一个函数**（`lib/guard/rules.js` 的 `codeReadRefusal`）——
**不是抄一份**（抄一份就一定漂移，而漂移的方向是放宽）：

- 控制角色（`main` / `orchestrator` / `planner` / `supervisor`）**只许读 `.pipeline/**`**，
  与它们用 `read` 时**一模一样**；
- **任何角色**都不许把参数文件放进**实现源码树**（`plugin/**` `lib/**` `src/**` `node_modules/**`）——
  参数文件是**数据**，不是代码（判据 `ARGS_FILE_DENY_TOP`）；
- 判不出角色时按**最严**那一档处理（fail-closed），不是放行；
- 判据顺序是**先判路径、后读盘** ⇒ 所有拒绝理由都在打开文件之前给出。

### 8.4 错误形状（**禁静默**）

文件不存在 / 不是普通文件 / 超过上限（256 KiB，文案里给上限）/ YAML /
JSON 语法错 / 顶层不是对象 / 字段拼错 —— **各有各的明确文案**，且都点名字段、
判据与被拒路径。坏 JSON **只让这一次调用失败**，不会作废整轮上下文（这正是本条通道的意义）。

### 8.5 怎么加到一个新工具上

一条接线，落在 `lib/tools/kit.js` 的**唯一出口**上（不散在各工具里）：

```js
const myTool = tool(deps, {
  name: 'pipeline_xxx',
  mutating: true,
  argsFile: { field: 'spec_path' },        // 可选 wrap: 'payload'（整份包进这个键）
  parameters: {
    task_id: S('string', '任务 ID'),
    spec_path: S('string', ARGS_FILE_DOC.spec_path),   // ★ 说明从 args-file.js 取，别另抄
    // …
  },
})
```

**没写 `argsFile` 的工具行为一个字节都不变**（连一次 `stat` 都不会发生）。
回归锚点：`tests/p16-args-file-check.mjs`（六条逐条钉，含等价性与向后兼容）。
