# dsh-pipeline — 插件源码、交付文档与控制面板

`dsh-pipeline` 是 DSH 的多 AI 协作流水线插件：主对话只调度不干活，编写 / 测试 / 审核三权分立，
越权、跳步、无 OK 关单在工具执行前由代码拦下。本仓库包含插件源码、各轮实现报告与交付文档，以及一个本地只读控制面板。

---

## 目录

```
.
├── README.md                  ← 本文件
├── .gitignore
├── MANIFEST.sha256            ← 逐文件 sha256（不含自身）
├── plugin/
│   ├── active/                ← 插件源码（维护这一份）
│   └── src/                   ← 运行期文件的副本，不维护
├── dashboard/                 ← 本地只读控制面板（见 dashboard/README.md）
└── docs/                      ← 实现报告、交付文档、架构图
```

---

## 一、插件源码：`plugin/active/`

`plugin/active/` 是要维护的那一份，对应安装后 `profiles/desktop/node_modules/dsh-pipeline/` 下的文件。
`plugin/src/` 只是插件运行期需要的文件复制出来的副本，内容落后于 `active`，不要在那里改。

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
按 [`docs/拆分前后对照.md`](docs/拆分前后对照.md) 查现在的位置。

### 测试

```bash
cd plugin/active
node tests/run-all.mjs            # 全套；结果写到 tests/last-run.txt
node tests/<套件>.mjs             # 单跑一套
```

- 全套当前 **1588/1588** 通过（39 套）。
- 另有 3 套需要宿主包（`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`），本机找不到时会跳过并如实标注，不计入通过率。
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

- **当前状态**：`需求清单与进度-20261014/`、`bug待修复单-20261014.md`、`变动日志.md`（面板读的就是这三份）。
- **汇总**：`产出交付文档-v3-20261014/`（需求、进度、架构图、派单流程、复验清单）。
- **机制说明**：`机制原理与运行手册/`、`提交与打回机制总表/`、`机制对比文档-文档说的vs现在实际的/`。
- **各轮实现报告**：顶层的 `*-实现报告.md` 等，是写报告当时的记录。
- **架构图**：`架构图-*/`。其中 `.receipts/`、`*.finalize.json`、`*.browser-check.json` 是各次出图的收据。

文档里的本机路径统一写作 `%USERPROFILE%\.dsh\…`，面板地址写作 `127.0.0.1:18240`；
会话 id 等原值没有保留，写作 `session-…`。

---

## 四、校验

`MANIFEST.sha256` 是除自身以外每个文件的 sha256。在仓库根目录运行：

```bash
sha256sum -c MANIFEST.sha256
```

改动文件后要重新生成它。

---

## 五、许可与出处

`plugin/` 下代码的作者、许可与出处以 `plugin/active/package.json` / `README.md` / `ARCHITECTURE.md` 为准。
`plugin/active/skills/stop-ladder/SKILL.md` 是随插件分发的技能文件，出处见文件自身。
