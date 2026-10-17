# 官方 Agent Teams 整合（`transport: 'team'`）

一份文件讲一件事：**把流水线的派活/唤醒接到 DSH 官方 Agent Teams 原语上**，以及这条通道
能做什么、不能做什么、失败了怎么读。

设计依据（官方事实与取舍）在 [`plugin/active/design/agent-teams/01-目标与边界.md`](../plugin/active/design/agent-teams/01-目标与边界.md)，
落点在 [`02-接线点与任务拆分.md`](../plugin/active/design/agent-teams/02-接线点与任务拆分.md)。

---

## 1. 它是什么

DSH 0.2.1 起官方带 **Agent Teams**（实验性插件「智能体团队」）：一个根会话是 Lead，
它可以 `spawn_teammate` 出**具名、持久、可续接**的 teammate，用 `send_message` 投消息、
`wait_agent` 等变化、`team_task_*` 维护共享任务板、`interrupt_agent` 打断。

dsh-pipeline 新增一条通道 `transport: 'team'`：

| pipeline 动作 | 走的官方原语 |
|---|---|
| `pipeline_dispatch` 派一个角色 | `spawnTeammate`（角色人格写进派活单正文） |
| `notify_only` / 孤儿重投 / 失联唤醒 | `sendMessage` |
| `{ stop: true }` 打断席位 | `interrupt` |
| 开会话的名单/反查 | `listMembers` |
| 任务板镜像（可选） | `createTask` / `updateTask` |

既有 `session` / `subagent` / `manual` 通道**原样保留**；`auto` 的优先级不变。

---

## 2. 怎么开

```yaml
# profile 的 cordis.patch.yml 里 dsh-pipeline 那一行
- id: dsh-pipeline
  config:
    transport: team          # 显式选通道；'auto' 时仍优先 session
    # 或者：transport: auto
    #       teamAuto: true     # auto 下把 team 排在 session 前面
    teamProvider: spawn      # 官方 spawnTeammate 的 provider（实测 spawn / fork）
    teamNamePrefix: p        # teammate 名字前缀
    teamStrictSlots: false   # true = 显式指定的 permission/model 钉不上就拒绝派活
    teamBoard: auto          # auto = team 通道且服务可用时镜像任务板；off = 关
```

前置：DSH 的 profile 里要装并启用官方 Agent Teams 插件集
（`@deepseek-ai/dsh-experimental-agent-team` + `-tool-agent-team` + `-agent-team-profile`）。
缺任何一个 ⇒ team 通道 `available() === false`，派活返回可读失败，**不静默降级**。

---

## 3. 能力边界（官方 API 的硬事实，不是本插件的选择）

| 事实 | 后果 |
|---|---|
| `spawnTeammate` **没有** `agentPreset` / `permission` / `model` 参数 | 角色会话**继承 Lead 的 preset**。所以：① 角色人格由派活单正文补（`presets/src/<role>/` 的 prefix+prompt+suffix）；② 四槽里的 `mode` 记 `UNAVAILABLE`；③ `permission`/`model` spawn 后补钉并读回，钉不上就 `ok:false` |
| teammate 是 **subagent 延续子会话** | 它出现在官方 Team 名单里、可点开，但**不是**侧栏里那种独立会话；旧验收词「侧栏多出会话」对这条通道不成立 |
| 名字 `lower-kebab`、同 Team **永不重用**、成员**只增不减** | 名字里编码 `(task, role, seat)`；同席位重派**复用**同一 member；`reassign` 追加 `-r2`。成员的 `maxMembers`（本机 profile 默认 8，官方默认 16）**到顶就派不出去** |
| 只有 Lead 能 spawn / interrupt | 角色会话即使继承了 team 工具也派不了人；机制发起的补派没有活 Lead Agent 当作 caller ⇒ 明确失败，请改用 `session` 通道或人工复制 |
| `sendMessage` 上限 65536 字节 | 超长正文截断并注明，不静默丢 |
| `wait_agent` 阻塞调用方（10s–1h） | 不是宿主轮询器。主对话收到 team 派活回执后，可用 `wait_agent` 等变化，不必轮询 `pipeline_status` |

容量到顶的可读失败长这样（`TeamError` 被翻译过）：

```
TEAM_MEMBER_LIMIT：Team 成员上限 8 已达（已用 8）。
出路：① 调大 profile 里 agent-team 的 maxMembers 后重启；② 新开一个会话当 Lead 再开工。
```

---

## 4. 守门：新工具面必须被分类

官方新插件给会话带来一大批新工具。pipeline 的守门因此扩展（名单唯一出处
`lib/guard/official-tools.js`）：

| 类别 | 工具 | 绑定角色（非 main） | main |
|---|---|---|---|
| team 协作 | `spawn_teammate` `send_message` `wait_agent` `list_agents` `interrupt_agent` `team_task_*` | **拒**（绕过结构化交接） | 放行（它是 Lead） |
| 委派 | `subagent` `subagent_fork` `subagent_codex` `subagent_claude_code` `workflow` `ralph` | **拒**（等于让别人替它改代码） | 保持既有 |
| 插件管理 | `plugin_manager` `plugin_market` | **拒**（装个插件就能读代码/改代码） | 拒 |
| 会话搜索 | `session_search` `session_event_*` `session_trace` | **拒**（跨会话读别的席位） | 放行 |
| shell 旁路 | 持久终端的 `terminal_send` 等 | 正文里的命令**按 shell 命令检查**（`text` 参数补扫） | 同既有规则 |

`deriveToolFace()` 会把这些并进角色的 `denied` 列表：席位**看不见**它们，而不只是调用时被拒。

---

## 5. 任务板镜像（`teamBoard`）

`teamBoard: auto`（默认）且走 team 通道时：

- 开单 → 官方任务板 `createTask`（subject=`[pipeline] <task id>`，description=需求原文，writeScopes=授权面）；
- 派活成功 → `updateTask`（`reassign` 到该 teammate，revision CAS，冲突重读重试一次）；
- 关单/取消 → `updateTask`（`complete`）。

落点：`.pipeline/<任务>/team-board.json`（`{team_task_id, revision, last_action, at}`）。
**镜像失败不阻断流水线**：错误写进 `audit.jsonl` 的 `team:board-*`，并在回执 `note` 里注明。
任务板是辅助面，流水线的权威状态永远在 `.pipeline/<任务>/task.json`。

---

## 6. 排障

| 现象 / 错误码 | 含义与处理 |
|---|---|
| `TEAM_NO_LIVE_CALLER` | 派活时拿不到活着的 Lead Agent（机制发起的补派）。改用 `transport: 'session'` 或人工复制 |
| `TEAM_MEMBER_LIMIT` | 名额到顶。调大 `agent-team` 的 `maxMembers` 后重启，或新开会话 |
| `TEAM_MEMBER_NAME_TAKEN` | 同名 teammate 已存在。正常路径会自动复用；手工重派若撞名，用 `reassign` 走 `-rN` |
| `TEAM_LEAD_REQUIRED` | 目标会话不是 Lead（角色会话被要求去 spawn）。守门本应先拒；出现即说明有人绕过了守门，按缺陷报 |
| `PRESET_UNKNOWN` / slot 报告 | 只在 session 通道出现；team 通道不下发 `mode` |
| 席位「看不见」常用工具 | `deriveToolFace` 的 denied 列表生效了。查该角色的 `officialDenyForRole(role)` |

自测：

```bash
cd plugin/active
node tests/team-transport-check.mjs    # 通道契约
node tests/team-guard-check.mjs        # 守门覆盖
node tests/team-board-check.mjs        # 任务板镜像
node tests/run-all.mjs                 # 全量（含上面三套）
```
