# dsh-pipeline — 插件源码、交付文档与控制面板
**中文** | [English (US)](README.en-US.md) | [日本語](README.ja.md) | [Русский](README.ru.md)

`dsh-pipeline` 是 DSH 的多 AI 协作流水线插件：主对话只调度不干活，编写 / 测试 / 审核三权分立，
越权、跳步、无 OK 关单在工具执行前由代码拦下。本仓库包含插件源码、各轮实现报告与交付文档，以及一个本地只读控制面板。

---

## 目录

```
.
├── README.md                  ← 本文件
├── .gitignore
├── .gitattributes             ← 行尾统一：文本一律 LF
├── MANIFEST.sha256            ← 逐文件 sha256（不含自身）
├── plugin/
│   └── active/                ← 插件源码（唯一一份）
├── dashboard/                 ← 本地只读控制面板（见 dashboard/README.md）
└── docs/                      ← 开发者文档（含 Agent Teams 整合）+ 交付文档、架构图
```

---

## 一、插件源码：`plugin/active/`

`plugin/active/` 是唯一一份，对应安装后 `profiles/desktop/node_modules/dsh-pipeline/` 下的文件。
（原先还并存一份重构前的单体旧版 `plugin/src/`，内容落后且无任何引用，已删除；历史里仍保留。）

### 模块布局

入口是 `index.js`，实现都在 `lib/`。原先五个上千行的大文件已按主题拆到子目录，
原文件保留为门面（对外导出名不变，调用方不用改 import）：

| 门面 | 子目录 | 内容 |
|---|---|---|
| `lib/store.js` | `lib/store/` | 任务存储：读写落盘、主管枢纽判据、状态迁移前置条件、交接物提交、人工介入… |
| `lib/tools.js` | `lib/tools/` | `pipeline_*` 工具定义，按工具分组 |
| `lib/guard.js` | `lib/guard/` | 守门：角色读写分类、席位与授权面、shell 判据、脚本展开、主判定 |
| `lib/handoff.js` | `lib/handoff/` | 交接物：字段表、校验、内容扫描、记录 |
| `lib/wakeup.js` | `lib/wakeup/` | 唤醒：唤醒键、账本身份、投递、唤醒器 |

`docs/` 里报告写的 `lib/store.js:2471` 这类行号指的是拆分前的单文件，
拆分前后对照文档已移除（见 git 历史）；现在的位置请按函数名到当前源码树的 `lib/` 下查。

此后新增的两个子系统同样按功能拆（不是单文件）：

| 目录 | 内容 |
|---|---|
| `lib/transport/` | 通道接口与实现：`session`（一等公民会话）/ `team`（官方 Agent Teams）/ `subagent` / `manual` / `simulated`；`createTransport()` 是唯一选择点 |
| `lib/team/` | 官方 Agent Teams 适配：命名、通道探测、角色人格注入、四槽补钉、投递、任务板镜像 |

### 测试

```bash
cd plugin/active
node tests/run-all.mjs            # 全套；结果写到 tests/last-run.txt
node tests/<套件>.mjs             # 单跑一套
```

- 全套当前 **3650/3650** 通过（108 套）。
- 有少数套件依赖**宿主安装**（`DSH_APP_ASAR=<DSH 安装>/resources/app.asar`）或宿主包（`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`）；拿不到时如实标注、**不计入通过率**。本机口径：设了 `DSH_APP_ASAR` 后 3650/3650；不设时 3 条预置校验会红（环境面，不是代码面）。
- `tests/seat-liveness-wake-check.mjs` 没有注册进全套，内容已落后于现在的失联判据，单跑会有失败。

### 安装

`plugin/active/install.ps1` 把运行期文件复制进 DSH profile 并登记插件，`rollback.ps1` 回滚。
改完代码要重启 DSH（或重载插件）才会在运行中的进程里生效。

---

## 二、控制面板：`dashboard/`

给控制角色（主对话 / 需求分析 / 主管 / 归档）看的本地只读单页面板，每次请求现读
`docs/` 下的需求单、bug 单与变动日志。只监听 `127.0.0.1`，带钥匙才能看。
启停：`dashboard\start.cmd` / `dashboard\stop.cmd`，细节见 [`dashboard/README.md`](dashboard/README.md)。

---

## 三、文档：`docs/`

面向开发者、一份文件讲一件事的文档在 [`docs/`](docs/README.md)：

- [`docs/install.md`](docs/install.md) —— 安装、参数、脚本改了什么、回滚
- [`docs/directory-settings.md`](docs/directory-settings.md) —— 安装目录 / 工作目录从哪来，怎么覆盖
- [`docs/encoding-conventions.md`](docs/encoding-conventions.md) —— `.ps1` 要 UTF-8 BOM、其它不要、行尾 LF
- [`docs/sandbox-temp-root.md`](docs/sandbox-temp-root.md) —— `%TEMP%` 落在 workspace 内导致受限 shell 全挂
- [`docs/manifest.md`](docs/manifest.md) —— `MANIFEST.sha256` 的校验与生成口径
- [`docs/agent-teams.md`](docs/agent-teams.md) —— 官方 Agent Teams 整合（`transport: 'team'`）：能力边界、配置、守门新名单、任务板镜像与排障

此外还有交付期留下的产物：`产出交付文档-v3-20261014/`（含架构图 `架构图-main-path-v2.html`）。

**文档里一律不写本机路径**：用 `%USERPROFILE%\.dsh\…`、`$HOME`、`<path\to\thing>` 或相对路径；
面板地址写作 `127.0.0.1:18240`；会话 id 等原值不保留，写作 `session-…`。

---

## 四、校验

`MANIFEST.sha256` 是除自身以外每个文件的 sha256。在仓库根目录运行：

```bash
sha256sum -c MANIFEST.sha256
```

改动文件后要重新生成它（口径与 Windows 上的替代命令见 [`docs/manifest.md`](docs/manifest.md)）。

---

## 五、许可与出处

`plugin/` 下代码的作者、许可与出处以 `plugin/active/package.json` / `README.md` / `ARCHITECTURE.md` 为准。
`plugin/active/skills/stop-ladder/SKILL.md` 是随插件分发的技能文件，出处见文件自身。
