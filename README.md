# dsh-pipeline — 多 AI 流水线插件 + 自建控制面板
**中文** | [English (US)](README.en-US.md) | [日本語](README.ja.md) | [Русский](README.ru.md)

`dsh-pipeline` 是 DSH 的多 AI 协作流水线插件：主对话只调度不干活，编写 / 测试 / 审核三权分立，
越权、跳步、无 OK 关单在工具执行前由代码拦下。插件自带一个**自建控制面板** —— 客户端入口
`lib/client.js` 在面板第一次被渲染时按需取回 15 个 `lib/client.panel-*.js` chunk，在会话头部显示
流水线状态、席位与会话预览。本仓库 = 插件源码 + 开发者文档 + 交付报告与架构图（都在 `docs/`）
+ 一个独立的本地只读页面（`dashboard/`）。

---

## 目录结构

```
.
├── README.md / README.en-US.md / README.ja.md / README.ru.md   ← 四语言同步的仓库说明
├── .gitattributes / .gitignore
├── MANIFEST.sha256            ← 逐文件 sha256（不含自身），口径见 docs/manifest.md
├── plugin/
│   └── active/                ← 插件源码（唯一一份），安装时复制进 profile
│       ├── index.js           ← 宿主侧入口：apply / 工具 / 守门 / HTTP 路由 / 客户端注册
│       ├── lib/               ← 实现：按域拆子目录（含 panel/ 与客户端 chunk）
│       ├── presets/           ← 16 个角色预设（src/ 是源，generated/ 是产物）
│       ├── tests/             ← 自测：110 套，一文件一套
│       ├── tools/             ← 仓库工具；install-items.json 是复制范围的唯一出处
│       ├── design/            ← 开放设计记录（agent-teams / memory / panel）
│       ├── locale/ skills/
│       ├── install.ps1 / rollback.ps1
│       ├── package.json / cordis.patch.yml
│       └── README.md / ARCHITECTURE.md / WIRING.md / CONVENTIONS.md
├── docs/                      ← 开发者文档 + 交付报告与架构图
│   ├── README.md / install.md / …（一份文件讲一件事）
│   └── 产出交付文档-v3-20261014/   ← 本轮报告 + 架构图 v3（v2 保留作历史）
└── dashboard/                 ← 独立的本地只读页面（见 dashboard/README.md）
```

---

## 一、部署：clone → 安装

```powershell
git clone <仓库地址> dsh-pipeline
cd dsh-pipeline
powershell -NoProfile -ExecutionPolicy Bypass -File .\plugin\active\install.ps1 -DryRun   # 先预演
powershell -NoProfile -ExecutionPolicy Bypass -File .\plugin\active\install.ps1            # 正式安装
```

安装只做复制与登记：把运行期文件复制进
`<DSH 用户目录>\profiles\<profile>\node_modules\dsh-pipeline\`，再往该 profile 的
`package.json` / `cordis.patch.yml` 追加插件登记（改之前先备份），并把自带的
stop-ladder Skill 落到 `<DSH 用户目录>\skills\stop-ladder\`。

| 阶段 | 拿到什么 |
|---|---|
| **clone 之后** | 整个仓库：`plugin/active/`（源码 + `tests/` + `presets/` + `design/`）、`docs/`、`dashboard/`、`MANIFEST.sha256`。 |
| **install 装进 profile 的** | 只有**运行期文件**：`index.js`、`lib/`、`locale/`、`skills/`、`presets/`、`icon.svg`、`package.json`、`cordis.patch.yml`、`README.md`、`ARCHITECTURE.md`、两个 `.ps1`，以及 `tests/`（`pipeline_selftest` 要读它）。 |
| **默认不装的** | 仓库根的 `docs/` 与 `dashboard/`（安装脚本只从 `plugin/active/` 复制），以及插件目录里的 `design/`、`examples/`、`REPORT.md`、`tools/`。这些随 clone 一起下载，只是不进 profile。 |
| **`-WithDocs` 才带的** | `examples/`、`REPORT.md`、`tools/`（仍在 `plugin/active/` 内）。 |

复制范围的唯一出处是 `plugin/active/tools/install-items.json`：`install.ps1` 与
`tools/sync*.mjs` 都读这一份，改它等于同时改三处。

| 常用参数 | 说明 |
|---|---|
| `-DryRun` | 只打印将要做什么，不改任何文件。 |
| `-Profile <名字>` | 装进哪个 profile，默认 `desktop`。 |
| `-WithDocs` | 额外装上 `examples/`、`REPORT.md`、`tools/`。 |
| `-NoSpawnRoles` | 只发令牌、不创建角色会话（零 token 的试跑模式）。 |

完整参数（`-ProjectRoot` / `-Transport` / `-GuardMainReadsCode` / `-MaxReworkPerLeg` /
`-L0OrchestratorSeparate` …）、脚本改了哪些文件、怎么回滚（`rollback.ps1`）见
[`docs/install.md`](docs/install.md)。装完要**重启 DSH**（或重载插件），运行中的进程才会用上新代码。

---

## 二、插件源码：`plugin/active/`

### 模块布局

入口是 `index.js`，实现都在 `lib/`。五个上千行的原文件已按主题拆到子目录，原文件保留为门面
（对外导出名不变，调用方不用改 import）：

| 门面 | 子目录 | 内容 |
|---|---|---|
| `lib/store.js` | `lib/store/` | 任务存储：读写落盘、主管枢纽判据、状态迁移前置条件、交接物提交、人工介入… |
| `lib/tools.js` | `lib/tools/` | `pipeline_*` 工具定义，按工具分组 |
| `lib/guard.js` | `lib/guard/` | 守门：角色读写分类、席位与授权面、shell 判据、脚本展开、主判定 |
| `lib/handoff.js` | `lib/handoff/` | 交接物：字段表、校验、内容扫描、记录 |
| `lib/wakeup.js` | `lib/wakeup/` | 唤醒：唤醒键、账本身份、投递、唤醒器 |

按功能拆开的其它域：

| 目录 | 内容 |
|---|---|
| `lib/panel/` | 自建面板：`snapshot.js`（只读快照）/ `seats.js`（席位三层合并）/ `task-fields.js`（字段与键序契约）/ `actions.js`（8 个写动作）/ `archive.js`（`_trash` 归档视图）/ `pins.js`（`_panel-pins.json` 置顶） |
| `lib/model/` | 领域对象：`task` / `baseline` / `artifact` / `close-report` / `human-request` / `handoff-*`（结构、默认值、字段清单） |
| `lib/errors/` | 错误码（`codes.js`）与拒绝 / 提示文案（`text.js`）的唯一出处 |
| `lib/transport/` | 通道接口与实现：`session` / `team` / `subagent` / `manual` / `simulated`；`createTransport()` 是唯一选择点 |
| `lib/team/` | 官方 Agent Teams 适配：命名、通道探测、人格注入、四槽补钉、投递、任务板镜像 |
| `lib/states/` `lib/tiers/` `lib/guard/` 等 | 状态机、档位规则、闸门…都按「一个文件一个改动原因」拆（见 `CONVENTIONS.md` §4） |

`docs/` 里报告写的 `lib/store.js:2471` 这类行号指的是拆分前的单文件；现在的位置请按函数名
到当前源码树的 `lib/` 下查。

### 客户端：入口 + 16 个 chunk

浏览器半边不是一个大文件：入口只有 400 行（正好顶格），面板实现拆成 16 个 chunk。

| 文件 | 行数 | 职责 |
|---|---|---|
| `lib/client.js` | 400（上限 400） | 入口：模块注册、「多AI 协调」开关（order 100）、面板 lazy wrapper（order 110，第一次渲染才去取 chunk） |
| `lib/client.panel-*.js` ×14 | 每个 ≤ 400 | 面板实现：`shell` / `view` / `atoms` / `data` / `seats` / `menu` / `batch` / `batch-bar` / `card-actions` / `actions` / `preview` / `preview-data` / `preview-control` / `preview-bubble` |

装载方式（三段；chunk 协议由宿主 `@deepseek-ai/dsh-client-modules` 原生提供）：

1. **入口**：宿主按 `/plugins/dsh-pipeline/client.js?rev=<入口 rev>` 当**经典脚本**加载（无 `import` /
   `export` / 顶层 `await`），入口自己调 `window.__ModuleLoader__.load({ id, factory })` 注册。
2. **按需取 chunk**：面板**第一次被渲染**时，入口用 `Promise.all(require.async('./client.panel-*.js'))`
   并行取回 16 个 chunk，交给 `shell` 按依赖序 `create(deps)` 组装 —— 没打开过面板就不下载。
3. **宿主怎么发**：chunk 走 `/plugins/dsh-pipeline/<chunk>?rev=<入口 rev>`，宿主按需异步读文件并
   **immutable 缓存**（`rev` 变了才重取）；chunk 必须与入口**同目录**、也是经典脚本，用
   `window.__ModuleLoader__.load({ id, chunk, factory })` 注册。chunk 之间**不能**同步 `require`，
   组合只在入口做。

因为协议是「入口 + 同级文件」，手工 JS 直接放进去就行：**不需要 tsdown，也不需要改 `package.json`**。
新增客户端逻辑一律新开 chunk（入口已顶格 400 行），理由与边界见
[`plugin/active/CONVENTIONS.md`](plugin/active/CONVENTIONS.md) §4。

### 测试

```powershell
cd plugin/active
node tests\run-all.mjs            # 全套；结果写到 tests\last-run.txt
node tests\<套件>.mjs             # 单跑一套
```

- 全套当前 **3676/3676** 通过（**110 套**）。面板相关的是 `panel-snapshot-check.mjs`（快照契约）、
  `panel-actions-check.mjs`（写动作 / 归档 / 置顶）与 `client-check.mjs`（入口与 16 个 chunk 的
  装载契约、渲染与点击，30 项）。
- 有少数套件依赖**宿主安装**：`DSH_APP_ASAR` 指向 `<DSH 安装>\resources\app.asar`，
  预置与宿主 schema 类判据要从里面读宿主包。拿不到判据时如实标注「跳过、不计入通过率」；
  本机口径：设了 `DSH_APP_ASAR` 后 3676/3676，不设时 3 条预置校验会红（环境面，不是代码面）。
- `tests/seat-liveness-wake-check.mjs` 没有注册进全套，内容已落后于现在的失联判据，单跑会失败。

---

## 三、控制面板

### 插件内面板（会话头部右侧）

挂在 `conversation.session.header.utilities`（list 槽），与「多AI 协调」开关并排：

- **等级徽标**：每张任务卡最左是 `L0`–`L5` 档位徽标 + 团队人数（`N 个 AI`），一眼看清这单多重。
- **⋯ 菜单**：按状态列出「终止 / 恢复 / 归档 / 删单」；删单要连点两次确认。
- **置顶**：📌 置顶 / 取消置顶，置顶的单排最前，其余按 `updated_at` 倒序。
- **批量**：头部「批量」→ 圆勾多选 → 底部批量栏「归档所选 / 删除所选」，串行执行并显示进度。
- **归档视图**：头部「归档 N」列已归档单，行内可「恢复」或「永久删除」（后者两击确认），
  「← 返回任务」切回。
- **悬停会话预览**：鼠标停在席位 chip 上，面板左侧浮出约 520×520 的预览窗（最多 12 条，可滚动）。
  只显示**真实用户 / AI 对话**（过滤注入的系统上下文与工具行）；AI 还没吐正文时显示
  「正在思考…」；**点任意气泡打开该会话**（`openSession`）。

数据与写动作是两条道：

| 用途 | 路由 | 口径 |
|---|---|---|
| 读 | `GET /.dsh-pipeline/panel` | 只读快照，5 秒轮询、页面隐藏时跳过；只读 `task.json` 的结构化字段（id / 状态 / 需求摘要 / 席位 / 待办数 / 任务板编号 / 档位 / 置顶 / `allowed_actions`），**不含**交接物正文、补丁、代码 |
| 读（归档） | `GET /.dsh-pipeline/panel?view=archived` | 只读 `<项目根>/.pipeline/_trash/` 下的已归档单 |
| 写 | `POST /.dsh-pipeline/panel/action` | 8 个动作：`cancel` / `restore` / `archive` / `delete` / `pin` / `unpin` / `unarchive` / `delete_archived`；开关关着时一律拒；`delete` / `delete_archived` 要 `confirm: true`；只收同源 JSON |

落盘位置（都在工作区 `.pipeline/` 下，跟着 profile 走）：置顶 `_panel-pins.json`、归档
`_trash/<任务id>-<时刻>/`、永久删除的墓碑 `_purge-log.jsonl`。设计取舍与字段契约见
[`plugin/active/design/panel/01-面板设计.md`](plugin/active/design/panel/01-面板设计.md)。

### 独立的只读页面 `dashboard/`

给控制角色（主对话 / 需求分析 / 主管 / 归档）看的本地单页，每次请求现读 `docs/` 下的
需求清单、bug 单与变动日志。只监听 `127.0.0.1`，带钥匙才能看；`dashboard\start.cmd` /
`dashboard\stop.cmd` 启停，细节见 [`dashboard/README.md`](dashboard/README.md)。

---

## 四、文档：`docs/`

面向开发者、一份文件讲一件事的文档在 [`docs/`](docs/README.md)：

- [`docs/install.md`](docs/install.md) —— 安装、参数、脚本改了什么、回滚
- [`docs/directory-settings.md`](docs/directory-settings.md) —— 安装目录 / 工作目录从哪来，怎么覆盖
- [`docs/encoding-conventions.md`](docs/encoding-conventions.md) —— `.ps1` 要 UTF-8 BOM、其它不要、行尾 LF
- [`docs/sandbox-temp-root.md`](docs/sandbox-temp-root.md) —— `%TEMP%` 落在 workspace 内导致受限 shell 全挂
- [`docs/manifest.md`](docs/manifest.md) —— `MANIFEST.sha256` 的校验与生成口径
- [`docs/agent-teams.md`](docs/agent-teams.md) —— 官方 Agent Teams 整合（`transport: 'team'`）

交付期产物在 `产出交付文档-v3-20261014/`：本轮报告
[`2026-10-18-面板与客户端分块.md`](docs/产出交付文档-v3-20261014/2026-10-18-面板与客户端分块.md)、
架构图 [`架构图-main-path-v3.html`](docs/产出交付文档-v3-20261014/架构图-main-path-v3.html)；上一轮的
[`架构图-main-path-v2.html`](docs/产出交付文档-v3-20261014/架构图-main-path-v2.html) 保留作历史，不再改动。

**文档里一律不写本机路径**：用 `%USERPROFILE%\.dsh\…`、`$HOME`、`<path\to\thing>` 或相对路径；
面板地址写作 `127.0.0.1:<端口>`；会话 id 等原值不保留，写作 `session-…`。

---

## 五、校验

`MANIFEST.sha256` 是除自身以外每个被跟踪文件的 sha256。在仓库根目录运行：

```bash
sha256sum -c MANIFEST.sha256
```

改动文件后要重新生成它（口径与 Windows 上的替代命令见 [`docs/manifest.md`](docs/manifest.md)）。

---

## 六、许可与出处

`plugin/` 下代码的作者、许可与出处以 `plugin/active/package.json` / `README.md` / `ARCHITECTURE.md` 为准。
`plugin/active/skills/stop-ladder/SKILL.md` 是随插件分发的技能文件，出处见文件自身。

---

## 七、文档索引

- [`docs/README.md`](docs/README.md) —— 开发者文档目录
- [`docs/install.md`](docs/install.md) —— 安装、参数、回滚
- [`dashboard/README.md`](dashboard/README.md) —— 独立的本地只读页面
- [`plugin/active/README.md`](plugin/active/README.md) —— 插件完整说明（设计目的、角色、状态机、工具面、判据）
