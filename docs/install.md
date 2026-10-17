# 安装与回滚

`plugin/active/install.ps1` 把插件装进 DSH profile，`rollback.ps1` 按同一批备份还原。

## 前提

| 项 | 要求 |
|---|---|
| Shell | Windows PowerShell 5.1 **或** PowerShell 7（两者行为一致） |
| Node | `>=20`（只用于跑插件与自测；安装脚本本身不调 node） |
| 依赖 | **无需** `pnpm install` —— 插件没有运行期第三方依赖 |

## 用法

在**普通**（非管理员）PowerShell 里跑：

```powershell
# 预演：只打印将要做什么，不改任何文件
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DryRun

# 正式安装
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

# 连 examples / REPORT.md / tools 一起装
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -WithDocs
```

常用参数：

| 参数 | 默认 | 作用 |
|---|---|---|
| `-Profile` | `desktop` | 装进哪个 profile |
| `-DshHome` | 见 [directory-settings.md](directory-settings.md) | DSH 用户目录 |
| `-ProjectRoot` | 见 [directory-settings.md](directory-settings.md) | 流水线工作区根 |
| `-DryRun` | 关 | 只预演 |
| `-NoSpawnRoles` | 关 | 只发角色令牌，不建子代理会话 |
| `-GuardMainReadsCode` | `$true` | 是否拦截主对话读代码正文 |
| `-NoSkill` | 关 | 不装自带的 `stop-ladder` 技能 |
| `-WithDocs` | 关 | 连文档一起装 |

## 脚本改了什么

改任何文件之前先备份（带时间戳，与目标同目录）。随后只做两处 **append**：

1. `<profile>\package.json` → `dsh.profile.bundles` 末尾追加 `"dsh-pipeline"`；
2. `<profile>\cordis.patch.yml` → 末尾追加本插件的一条 `- insert:`（含 `config`）。

再把运行期文件复制到 `<profile>\node_modules\dsh-pipeline`，并把自带技能装到
`<DSH 用户目录>\skills\stop-ladder\SKILL.md`。

**不动的东西**：`cordis.yml`（只读它）、其它插件的任何条目、profile 下的其它文件。
脚本是幂等的 —— 已经登记过就跳过，重复跑不会追加第二份。

## 生效方式

- 插件本体（工具 / 守门 / 拦截缝）：**需要重启 DSH**（Host 半边在启动时装载）。
- 自带技能：下一次会话就能看到（技能目录每次会话扫描）。

## 回滚

安装完脚本会打印**精确的回滚命令**，直接复制即可。它长这样：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<DSH 用户目录>\profiles\desktop\node_modules\dsh-pipeline\rollback.ps1" -Stamp <时间戳> -Profile desktop
```

也可以直接用仓库里的那份（不要求先用 `install.ps1` 装过）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\rollback.ps1 -Stamp <时间戳> -Profile desktop
```

## 改完代码之后：同步与一致性校验

DSH 加载的是安装副本（`profiles/<名字>/node_modules/dsh-pipeline`），不是仓库。改完 `plugin/active/**`
不同步就重启，跑的仍是旧代码。复制范围只有一个出处：`plugin/active/tools/install-items.json`。

```powershell
# 只拷有差异的文件（字节原样、保 LF）；同步两次第二次零改动
node plugin/active/tools/sync.mjs --repo plugin/active --installed <profile>\node_modules\dsh-pipeline

# 只读校验：一致 ⇒ exit 0「OK: N/N 一致」；不一致 ⇒ 非零退出，逐条列出 missing / extra / changed
node plugin/active/tools/sync-check.mjs --repo plugin/active --installed <profile>\node_modules\dsh-pipeline
```

永不拷贝、永不删除：`.bak*`、`*-last-run.txt`、运行期 `*.jsonl`。安装副本根目录上范围外的文件只报不删，加 `--prune` 才删。
`install.ps1` 收尾会自动跑一次 `sync-check`；它自己写的时间戳备份每个文件只保留最新 3 份。

## 装完先做三件事

1. 重启 DSH，在日志里找 `[pipeline] dsh-pipeline <版本> 已加载…`；
2. 看窗口右上角有没有出现「● 多AI 协调 开」胶囊按钮（看不到也不影响使用，`pipeline_switch` 工具同样能切）；
3. 在任意对话里调一次 `pipeline_selftest`，它会当场跑完正例全流程 + 反例 + 分档验证。

## 相关

- 目录从哪来：[directory-settings.md](directory-settings.md)
- `.ps1` 的编码要求：[encoding-conventions.md](encoding-conventions.md)
- 受限 shell 全部失败的排查：[sandbox-temp-root.md](sandbox-temp-root.md)
