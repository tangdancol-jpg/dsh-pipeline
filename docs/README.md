# `docs/` —— 面向开发者的项目文档

一份文件讲一件事，都短。想加内容时**新开一份**，不要往这里堆。

| 文件 | 讲什么 |
|---|---|
| [install.md](install.md) | 安装、参数、脚本改了什么、回滚 |
| [directory-settings.md](directory-settings.md) | 安装目录 / 工作目录从哪来，怎么覆盖 |
| [encoding-conventions.md](encoding-conventions.md) | `.ps1` 要 BOM、其它不要、行尾一律 LF |
| [sandbox-temp-root.md](sandbox-temp-root.md) | `%TEMP%` 落在 workspace 内导致 shell 全挂：判据与修法 |
| [manifest.md](manifest.md) | `MANIFEST.sha256` 的校验、生成口径、何时重算 |
| [release-checklist.md](release-checklist.md) | 推送前检查清单：四语言 README 数字、套件与断言数、客户端文件数与行数、MANIFEST、安装副本、LICENSE / 元数据、诊断代码残留、`git status`、全量自测 |
| [agent-teams.md](agent-teams.md) | `transport: 'team'`：官方 Agent Teams 原语整合、能力边界、守门新名单、任务板镜像、排障 |

## 写文档时的两条约定

- **路径一律可移植**：用 `%USERPROFILE%` / `$HOME` / `<path\to\thing>` / 相对路径，
  不写具体的用户名或盘符。仓库要能直接开源。
- **不写汇报口吻**：写"这东西怎么用、为什么这样"，不写"我做了什么、结果如何"。

## 其它文档在哪

- 插件自身的架构与接线：`plugin/active/ARCHITECTURE.md`、`WIRING.md`、`CONVENTIONS.md`、`README.md`
- 仓库总览：根目录 [`README.md`](../README.md)
- 本地只读控制面板：[`dashboard/README.md`](../dashboard/README.md)
