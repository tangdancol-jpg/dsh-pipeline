# dsh-pipeline · 交付报告

> 面向：验收的人。
> 结构：侦察结论 → 设计取舍 → 实现要点 → 正例/反例实测 → 生效方式 → 不确定项。
>
> **先说结论**：源码、文档、自测都做完了。自测 **163/163 通过**
> （正例全流程 + 10 组反例 + 5 档分档 + 装载冒烟 + 工具定义真编译器校验
> + **功能开关 38 项** + **客户端 UI 23 项**）。
> **没有安装**（按你的要求），也**没有碰过真实 profile** —— 一行都没写过。
> 安装脚本在**沙箱 profile** 上验过完整的"改造 → 幂等 → 回滚 → 逐字节还原"。
>
> **本轮增量**：DSH 窗口右上角的「多AI 协调」开关（见[第八节](#八增量右上角的多-ai-协调开关)）。
> 其中**已验证**与**按源码推断/未验**的部分，在第八节逐条标了。

---

## 一、侦察结论

**方法**：`app.asar` 是归档，`ls` / `cat` / `rg` / `node` 都打不开它。
用 `tools/asar.ps1`（从已装插件 dsh-archigate 的做法借来）按 asar 头的
`{path: {size, offset}}` 树结构按偏移读字节，把 18 个 `@deepseek-ai/*` 包解出来看。
**所有结论都以源码行号为准，不采信 README 的一句话。**

### 1.1 工具注册与执行流水线

| 事实 | 出处 |
|---|---|
| 流水线顺序：`tools/pre-execute`（waterfall）→ **`ctx.tools.guard`（单调守卫）** → dispatch → `tools/post-execute` → `tools/result` | `dsh-tools/lib/index.js:3225` / `:3241` / `:3331` / `:3504` / `:3415` |
| 守卫可注册多个，同层内取**第一个非 `undefined`** 即拒绝 | `:2646-2651` `for (const guard of this.guards.values()) { const reason = guard(exec); if (reason !== void 0) return reason }` |
| **拒绝判据是 `reason !== undefined`** —— 返回 `false` / `0` / `{}` **都算拒绝** | `:2649` |
| **guard 抛异常不是拒绝**：会被 `prepareExecution` 的 try/catch 吞成通用 tool error，理由文本丢失 | `:3267-3272` |
| guard 只在 pre-execute 决议为 `allow` 时运行 | `:3241` |
| 拒绝的物化形态：`{content:[{type:'text',text:'Error: '+reason}], isError:true, error:{message:reason}}` | `:3243-3257` |
| `ctx.tools.register()` 返回**精确 disposer**；没有 `list()` / `unregister()` | `:2878`、`:2876` JSDoc |

**这三条直接决定了本插件的写法**：
① 守门必须**只返回 `undefined` 放行**（本插件全部判据都显式 `return undefined`）；
② 守门整体包在 try/catch 里，内部异常按 **fail-closed** 返回明确理由（否则会被吞成无信息的 tool error）；
③ 不监听 `tools/pre-execute` —— 那条 waterfall 挂在每一次工具调用上，多一个监听者就多一类"整条链被带坏"的风险。

### 1.2 `defineTool` 的硬约束

| 事实 | 出处 |
|---|---|
| `output` **必填**，且 `output.render` 必须是函数（无条件读它） | `:842` `const userRender = options.output.render;` |
| `output.schema` 的对象根**必须显式写 `additionalProperties: false`** | `:699` `if (!Object.hasOwn(input, "additionalProperties") ...) authorError(...)` |
| `parameters` 是「属性名 → 值 schema」的映射（写成 `{type:'object'}` 会报错） | `:802-811` |
| `required` 只能写在**属性**上、且值必须是 `true` | `:603-604` |
| 支持的 DSL 类型：`string`/`number`/`integer`/`boolean`/`null`/`array`/`object`/`json`/`oneOf`，另有 `enum`/`const` | `:687-751` |
| `parameters` 根**没有** `additionalProperties`，而校验器只在显式 `false` 时拒绝多余键 ⇒ **模型多传的未声明参数不会被拒**，会原样进 `execute` | `json-schema.js:492-495` |
| `execute` 返回 `{ok:false}` **不是错误** —— 注册表根本不看 `ok` | `:3564-3570` |

**后果**：本插件的每一次"拒绝"都是**正常返回值**，靠 `output.render` 把拒绝原文交给模型；
真正在 dispatch **之前**拦住的是 `lib/guard.js` 那层 `ctx.tools.guard`。
报告里每条反例都标了 `拦截层：guard` 还是 `拦截层：execute`。

### 1.3 调用方身份

| 事实 | 出处 |
|---|---|
| `exec` 形状：`{token, callId, rootCallId, name, signal, agent?, parent?, schema?, arguments, deferContext, concludeTurn}` | `:3131-3168` |
| **`exec.agent` 是发起调用的 Agent 对象；global / 无 agent 调用时是 `undefined`，必须判空** | `:3149` |
| **`agent.id === agent.session.id`** | `dsh-agent/lib/index.js:511-512` `if (id !== agent.session.id) throw ...` |
| 事件：`agent/created`（serial）、`agent/disposed`（emit） | `dsh-agent/lib/index.js:579` / `:550` |

**第 3 条是整套机制的地基**：`exec.agent.id` 就是会话 id，
于是"令牌 ↔ 会话"的二次绑定成为可能 —— **令牌转手即失效**，
这补上了纯令牌机制最大的一个洞。

### 1.4 system prompt 段

`ctx.systemPrompt.section({name, order, text})`，`order` 必须是**有限数字**
（`getSectionOrder(未知名字)` 返回 `undefined` → 直接抛 `order must be a finite number`）。
所以自建插件要么复用已有 key，要么直接写数字 —— 本插件取 `2650`。
出处：`dsh-system-prompt/lib/index.js:240-243`。

### 1.5 子代理 / 会话（角色驱动通道用的）

| API | 出处 |
|---|---|
| `ctx.subagents.startContinuable({provider, label, request, signal})` → `{childId, messageId}`。**必然投递初始 prompt ⇒ 会花 token** | `dsh-subagent/lib/index.js:2871-2874` |
| `ctx.subagents.start(provider, request)` → `SubagentRun {id, localAgent, result, dispose()}` | `typert.host.js:767` |
| `ctx.subagents.sendMessage(sender, targetId, content, options)` → `MessageId` | `typert.host.js:142` |
| `SubagentStartRequest = {label?, prompt, parent, signal, agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona?}` | `typert.host.js:779` |
| 空 inbox 的 turn 在 step 0 直接结束、**根本不进 `step()`** ⇒ 只建容器不投消息**不花 token** | `dsh-agent-loop/lib/index.js:963` |
| 服务名是 `ctx.sessions` / `ctx.subagents` / `ctx.agents`（**不是** `ctx.session` / `ctx.subagent`） | `dsh-session:1621`、`dsh-subagent:2834`、`dsh-agent:332` |

**第 5 条决定了通道设计**：`spawnRoles:false` 时连建都不建，只发令牌 —— 这正是自测与演示要的零副作用形态。

### 1.6 README 与源码的出入（不采信 README 的实证）

| README 说 | 源码实际 |
|---|---|
| "a returned reason denies the call" | 判据是 `reason !== void 0`；且 guard **抛异常 = 结构化 tool error，不是 deny** |
| DSL 清单 | 漏了 `enum` / `const` / 注解 `default`/`title`/`examples` |
| `execute` 的返回值约定 | 没提"`ok:false` 不是错误，注册表不看 `ok`" |
| `parameters` 的开放根 | 完全没提"多余的键不会被拒" |
| `presentCall`/`presentResult` 被 Web Client 消费 | 在解出来的 18 个包里**只被定义、无任何消费点**（客户端包不在 asar 里，无法证实） |
| `InferValue` 16 层容器 | 全树 **0 个 `.d.ts`**（`package.json` 声明了但文件不存在），无法证实 |

### 1.7 已装插件的既有做法（借来用的）

- `dsh-archigate` 把 `ctx.tools.guard` 这条路走通了，**并留下一个真教训**（写进了它的 `lib/guard.js` 文件头）：
  Windows 的 PowerShell 双引号里**反斜杠不是转义符**，第一版按 POSIX 语义分词，
  `node "C:\...\archify.mjs"` 被吃掉路径 → 守门**静默放行**。
  它的结论是"判据的测试用例必须用真机上真实出现的字面形式"。
  **本插件照着这个教训写反例**（用真实的 Windows 绝对路径构造命令串），
  并且真的踩到了一个同族但不同的坑（见下）。

---

## 二、设计取舍

### 取舍 1：角色身份不能自称 ⇒ 角色令牌 + 会话二次绑定

最朴素的做法是让每个角色在调用时声明 `actor_role: "writer"`。
**那是纯约定，一点机制都不是。**

本插件的做法：主对话派活时**铸一枚只属于那个角色的令牌**（`PT-` 前缀，随机 12 字节）。
令牌里带着 `(task_id, role, agentId?)`。

- 会话绑定（`exec.agent.id` ← 令牌）**优先于**参数里的令牌 ⇒ 一个会话拿别人的令牌也没用
- 真实子代理通道下，令牌在铸造时就直接记下 `childId`，**不给人转手的机会**
- 令牌与任务绑定 ⇒ 跨任务无效
- 一笔绑定、不可改绑 ⇒ 一个会话在同一任务里只能担任一个角色

**诚实的边界**：主对话手里握着它派出去的每一个角色的令牌（`pipeline_dispatch` 的返回值里就带着），
这是设计上的信任根。令牌能挡住"角色会话自己搞错/越权"，**挡不住主对话主动递刀**。
要收紧就开 `requireAgentBinding: true` 并只走真实子代理通道。这条写进了 README 的「拦不住的」。

### 取舍 2：规格歧义 —— L0 到底有没有独立编排对话？

需求原文里这两句互相拉扯：

- 「最少 4 个独立对话：主对话、编写、测试、审核」
- 「推荐起步 5 个：在四角色外增加「需求分析/编排判断对话」」
- 分档表：「L0 极简脚本 = 4（主/编写/测试/审核）」

**我的取舍**：L0 的编排判断**依然发生**，但执行者不是另一个 AI 会话，而是 `lib/tiers.js` 里的
**确定性规则引擎**（`orchestrator_mode: "rule-engine"`）。

**为什么这不算"主对话自己判断"**：
主对话只能**调用**引擎，既不能改引擎的结论，也不能手写角色清单。
引擎要输出 L0，需求必须先通过一组**保守的**平凡性判据（13 组不平凡信号 + 3 条硬闸）。
任何一条不满足 → 引擎拒绝自批 L0 → **强制升到 L1** ⇒ **复杂需求不漏配**。
反过来，引擎判 L0 时主对话也抬不到 L4 ⇒ **简单需求不超配**。

**一句话翻回来的开关**：`l0OrchestratorSeparate: true`（或安装时 `-L0OrchestratorSeparate`）。
这条路径自测里也验过，会被明确拒绝并说明原因。

### 取舍 3：能拦的拦，拦不住的写清楚

需求原文要求"明确哪些是真机制、哪些只是约定"。本插件把这条当成一等公民：

- **真拦截 20 条**，每条都有自测反例与拒绝原文（见第四节）
- **拦不住的 6 条**，在 README 的「拦不住的」里逐条写明判据强度与缓解手段

写清楚"拦不住"比多拦一条更重要 —— 含糊会让人误以为有保护。

### 取舍 4：只挂两个宿主扩展点

`ctx.tools.register`（13 个工具）+ `ctx.tools.guard`（1 个守卫）。
**不注册** HTTP 路由、不注入 settings/storage、不监听 waterfall 事件、不改别人的文件、
不依赖别人的内部状态文件。少一个依赖就少一种"装不上"的方式。

### 取舍 5：刻意不导出 Cordis 的 `Config` schema

与已装的 `dsh-archigate` 同一取舍：省掉 `@deepseek-ai/schemastery` 的运行期依赖，
就省掉一类"link: 安装时解析不到 z、插件整行不激活"的故障。
代价是插件管理器里不会自动生成配置表单 —— 调参请直接改 `cordis.patch.yml`。

### 取舍 6：交接物与状态推进**合一**

分开写就会出现两种半截现场："交了东西但状态没动" / "状态动了但没有交接物"。
这两种现场都没法机械判定（判据该信哪个？）。合一之后一条断言覆盖两者，
而且**预检失败就一个字节都不写**。

---

## 三、实现要点

### 3.1 目录

```
dsh-pipeline/
├── index.js                插件入口（apply / inject / NS / system prompt 段）
├── cordis.patch.yml        bundle patch（挂载声明 + 全部配置项注释）
├── package.json
├── install.ps1             UTF-8 with BOM
├── rollback.ps1            UTF-8 with BOM
├── README.md               怎么用 / 角色 / 状态机 / schema / 边界 / 安装
├── ARCHITECTURE.md         分层 + 节点清单 + 边清单（中文标签，可直接画图）
├── REPORT.md               本文件
├── lib/
│   ├── util.js             路径归一化、原子写、稳定哈希
│   ├── config.js           配置默认值与宽松合并
│   ├── roles.js            ★ 角色表（唯一事实来源）
│   ├── tiers.js            ★ L0~L5 分档 + 确定性规则引擎 + 角色清单构造
│   ├── states.js           ★ 状态机（14 状态 / 全部合法转移 / 三条不变量）
│   ├── handoff.js          ★ 13 种交接物 schema + 跨字段约束 + 脱敏摘要
│   ├── tokens.js           ★ 角色令牌表（令牌↔任务、令牌↔会话、按 agent 反查）
│   ├── store.js            ★ 任务存储：状态推进 / 交接物落盘 / 打回预算 / 制品版本 / 有效 OK / 审计
│   ├── guard.js            ★ 守门判据（纯函数）
│   ├── guard-factory.js    把同步判据接到 ctx.tools.guard（含 fail-closed）
│   ├── tools.js            13 个工具定义
│   └── transport/index.js  可插拔通道：subagent / manual / simulated + 派活单渲染
├── tests/
│   ├── selftest-core.mjs   自测内核（被命令行与 pipeline_selftest 共用）
│   ├── selftest.mjs        命令行入口
│   ├── load-smoke.mjs      装载冒烟（假 ctx）
│   ├── schema-check.mjs    用真 defineTool 编译器校验 13 个工具定义
│   ├── run-all.mjs         三套一起跑
│   └── last-run.txt        最近一次完整报告（含全部拒绝原文）
├── examples/
│   ├── run-example.mjs
│   ├── demo-project/       真实落盘样例（task.json + 4 份交接物 + 审计流水）
│   ├── example-dispatch-brief.md  派活单实物
│   └── example-refusal.txt        4 条拒绝原文实物
└── tools/asar.ps1          从 app.asar 里取证的脚本（侦察用）
```

### 3.2 五个关键模块

**`lib/roles.js`** —— 角色表。三权分立的不变量编码在**数据**里，不是散文：

```js
writer.handoffKinds = ['dev_to_test']            // 没有 review_verdict
tester.writes = 'reports'                        // 不是 workdir
reviewer.writes = 'reports'
main.handoffKinds = []                           // 不产出任何技术交接物
SEPARATION_ROLES = [writer, tester, reviewer]    // 任何档位都必须同时在册
```

**`lib/tiers.js`** —— 13 组不平凡信号 + 3 条硬闸。这里踩过一个真坑：

> 最初把 ASCII 与中文关键词写在同一个正则里，形如 `/\b(api|http|接口|服务端)\b/i`。
> **中文关键词一条都匹配不上** —— JS 的 `\b` 是 `\w`(=[A-Za-z0-9_]) 与 `\W` 之间的边界，
> 而中文字符属于 `\W`，「单」和「接」之间根本没有边界可谈。
> 于是"给订单**接口**加参数"被判成了 L0 极简脚本 —— 正是需求原文最担心的**复杂需求漏配**。
>
> 现在拆成 `ascii`（带 `\b`，避免 `api` 命中 `rapid`）与 `cjk`（不带边界）两段。
> 自测里「普通功能 → L1」这条就是给这个坑留的回归用例。

**`lib/states.js`** —— 14 个状态 + 全部合法转移。**三条不变量**：

1. `developing` 只能走到 `ready_test` —— 表里**没有** `→ ready_review` 这条边
2. `passed` 只能由 `reviewing` + 审核 OK 到达
3. `closed` 只能由 `passed` 到达

**`lib/store.js`** —— 有效审核 OK 的判定是本插件最精细的一段：

```
有效 OK = conclusion === 'OK'
        且 artifact_version === 当前有效制品版本
        且位于**最近一次打回之后**
```

最后一条是关键：**打回会作废上一轮的 OK**。编写改完代码拿旧 OK 来关单，会被版本一致性判据拦下。

**`lib/guard.js`** —— 纯函数，判据全部可单测。同样踩过一个 Windows 特有的坑：

> `pathKey()` 只在**整串以盘符开头**时小写化。一条命令形如
> `Get-Content "C:\x\y.js"` 经 pathKey 后是 `get-content "c:/x/y.js"` ——
> 首字符是 `g` 不是盘符，所以**没有被小写**，而任务根是 `c:/x`。
> 两边直接 `includes` 在 Windows 上**永远不成立** —— shell 旁路判据会静默失效。
> 现在统一走 `normText()`（反斜杠转正斜杠 + 统一小写）。
> 自测里「测试用 shell 旁路改项目源码」「主对话用 shell 读代码」两条就是这个坑的回归用例。

### 3.3 写测试时踩到的三个坑（也写进了 `tests/selftest-core.mjs` 文件头）

1. **必须把宿主工具的替身注册进来。** 守门要拦的是 `write` / `read` / `pwsh` 这些**别人的**工具。
   第一版没注册它们，`callTool` 直接以"工具未注册"结束，`denied=true` ——
   **看起来像"被拦下了"，其实一个判据都没跑。**
   现在 `expectDenied` 把 `layer==='missing'` 明确判成**失败**。
2. **关单会回收令牌**（`pipeline_close` 里 `tokens.revokeTask`）。
   第一版拿"已关单的任务"去测"测试改代码"，令牌早没了，守门自然不响。
   现在守卫类用例一律跑在**还活着的** fixture 任务上。
3. **`tokens.list()` 回显的是截断令牌**（前 8 位 + 省略号，故意的，用于审计）。
   拿它当令牌去调用必然失败。令牌要从未截断的返回值里取。

### 3.4 一个被自测逮到的设计缺陷

第一版把 `rework_budget` 守卫**同时**挂在了「打回」和「已打回编写 → 派编写」两条边上。
后果：第 2 次打回成功之后，编写**再也派不出去**，任务**永久卡死在「已打回编写」**。

自测里「反例⑤」的断言把这条死结照了出来（`state=returned_to_dev` 而出路全断）。
修法：预算只在**打回那一刻**扣一次；重派活不再扣。
现在超限时打回被拒、任务停在「测试中」，由 `block` 或仲裁角色接手。

**这条留在自测里当回归用例**（断言文本里写了"这是给一个真 bug 留的"）。

---

## 四、正例 / 反例实测

### 4.1 怎么跑

```powershell
cd <插件目录>
node tests\run-all.mjs
```

完整报告（含每条的拒绝原文）在 `tests/last-run.txt`；装完之后也可以在对话里调 `pipeline_selftest`。

### 4.2 汇总

```
##############################################################################
#  dsh-pipeline 自测汇总：97/97 通过
#  跑法：node tests/run-all.mjs   （node 版本 v24.21.0，平台 win32）
##############################################################################

【正例】9/9 通过
【反例①编写直接提交审核】6/6 通过
【反例②无 OK 关单】5/5 通过
【反例③测试/审核改代码】5/5 通过
【反例④主对话自行增删角色】13/13 通过
【反例⑤打回次数超限】3/3 通过
【反例⑥主对话读代码】3/3 通过
【反例⑦令牌伪造与跨任务】7/7 通过
【反例⑧版本一致性】4/4 通过
【反例⑨与其它守护共存】5/5 通过
【反例⑩守门健壮性】2/2 通过
【分档】5/5 通过
总计：67/67 通过         ← selftest
总计：17/17 通过         ← 装载冒烟
工具定义真编译器校验：13/13 通过
```

### 4.3 正例：状态轨迹一步不跳

```
开单            pending
编排完成        ready_dev
派编写后        developing
编写交测试后    ready_test
派测试后        testing
测试交审核后    ready_review
派审核后        reviewing
审核 OK 后      passed
关单后          closed
```

配套断言（全过）：

- 档位 `L0`、独立对话数 `4`（主/编写/测试/审核）
- 三份交接物逐个落盘：`001-dev_to_test.json` / `002-test_to_review.json` / `003-review_verdict.json`
- `audit.jsonl` 覆盖每个环节（`open` / `roster:set` / `handoff:*` / `transition:*` / `close`）
- 制品版本化（`v1` + sha256）+ `close_report` 记录放行依据
- **主对话视图脱敏**：`pipeline_status` 返回的交接物里出现"已隐去正文"，且**不含**原始补丁文本

### 4.4 反例：拒绝原文（节选，全部原文见 `tests/last-run.txt`）

#### ① 编写直接提交审核 —— `拦截层：guard`

```
[pipeline] 角色越权被拦下（交接物方向）。
交接物：review_verdict
允许产出该交接物的角色：reviewer
当前角色：writer
原因：★ 编写角色不能直接把产物提交审核。编写的产物只能先交测试（dev_to_test）；
由测试独立验证、产出 test_to_review 之后，审核才介入。这是三权分立的核心一条。
```

同组还有 5 条：编写推 `review_ok` / 推 `test_passed`（想跳过测试）/ 冒充测试提交 `test_to_review` /
测试冒充审核发 `review_verdict` / 审核冒充编写提交 `dev_to_test`。全部 6/6 被拦。

#### ② 无 OK 关单 —— `拦截层：execute`（状态机层面还有第二道）

```
拒绝关单：任务 T-20261011-6136d1 不存在有效的审核 OK。
判据：需要一份 review_verdict，conclusion=OK，且 artifact_version 等于当前有效制品版本（尚无制品），
     且在最近一次打回之后。
主对话不能凭"看起来做完了"关单 —— 必须先走完 测试→审核，由审核角色发 OK。
```

同组还验了：任务在「审核中」但审核没发 OK、审核发 NG 之后 —— 都关不掉。

#### ③ 测试/审核改代码 —— `拦截层：guard`

```
[pipeline] 拒绝：角色「tester」不得修改项目源码制品。
工具：write
目标：<HOME>/.../demo-project/src/fizzbuzz.js
任务：T-...（受保护根：<HOME>/.../demo-project）
允许写入的位置只有本任务的报告目录：<HOME>/.../.pipeline/t-.../reports
原因：编写/测试/审核三权分立 —— 测试与审核**不得替编写改代码**（改了就没有独立验证了）。
如果你发现了缺陷，请用 pipeline_handoff（test_to_dev）或 pipeline_rework 把问题打回编写，由编写角色修改。
```

shell 旁路同样被拦：

```
[pipeline] 拒绝：角色「tester」不得通过 shell 修改项目文件。
任务：T-20261011-be477b
命令片段：Set-Content -Path "<HOME>\AppData\Local\Temp\dsh-pipeline-selftest-cexotC\fizzbuzz.js" -Value "// 测试偷偷改代码"
原因：测试/审核不得替编写改代码；shell 旁路与文件工具受同一套规则约束。
（说明：shell 侧是**字符串匹配**的 best-effort 判据，不是形式化保证；…）
```

**对照**：测试写自己的报告目录（`.pipeline/<任务>/reports/`）放行。

#### ④ 主对话自行增删角色 —— 13/13 全拦

主对话想自己批申请 —— `拦截层：guard`：

```
[pipeline] 角色越权被拦下。
工具：pipeline_roster_review
允许角色：orchestrator
当前角色：main
原因：角色增减必须由「编排判断」复核，主对话与执行角色都不能自己批。
```

主对话想直接派清单外的角色 —— `拦截层：execute`：

```
拒绝派活：角色「安全/合规审计」不在本任务的角色清单里。
当前清单（L1，5 个独立对话）：主对话 / 需求分析/编排判断 / 编写 / 测试 / 审核
★ 主对话不能自己决定加人减人。需要增减角色请走：执行角色 pipeline_roster_request 提出申请
→ 编排角色 pipeline_roster_review 复核 → 按新清单派活。
```

**闭环也验了**：编写提申请 → 主对话批（被拒）→ 编排复核批准 → 新清单里出现 `security`
（`reason` 里留了申请理由与复核意见）→ 主对话派 `security` 放行。

#### ⑤ 打回次数超限 —— `拦截层：execute`

```
打回次数超限：本任务「打回编写」已用 2 次，上限 2 次。
按规则不能无限打回。请改用：pipeline_transition event=block（已阻塞）交人工介入，
或让编排复核后追加仲裁/架构角色（pipeline_roster_request → pipeline_roster_review）。
```

并验证：预算用尽后**任务不会死结**（编写仍派得出去）、`block` 交人工的出路可用。

#### ⑥ 主对话读代码 —— `拦截层：guard`

```
[pipeline] 拒绝：主对话不得读取代码正文。
工具：read
目标：<HOME>/.../demo-project/fizzbuzz.js
任务：T-...
原因：主对话只负责接需求、派活、跟踪状态、关单 —— 不读代码、不做技术判断。
需要了解进展请用 pipeline_status（返回的是脱敏摘要，不含代码正文）。
```

shell 旁路同样拦。**对照**：主对话读 `.pipeline/<任务>/task.json` 放行。

#### ⑦ 令牌伪造 / 跨任务 / 转手 —— 7/7 全拦

```
role_token 绑定的是会话 fake-agent-002，当前调用会话是 fake-agent-001。令牌不可转手。

role_token 属于任务 T-...，不能用于任务 T-...。

role_token 无效或已过期：PT-伪造的令牌。请让主对话重新 pipeline_dispatch 铸造。

这枚令牌已经绑定到会话 fake-agent-002，不能改绑到 selftest-main。

[pipeline] 角色越权被拦下。工具：pipeline_close  允许角色：main  当前角色：reviewer
```

#### ⑧ 版本一致性 —— `拦截层：execute`

```
交接物里的 artifact_version=v2 与当前有效制品 v1 不一致。制品已更新或被换过，
请基于当前版本操作（制品版本化就是为了防这个）。
```

#### ⑨ 与 `dsh-archigate` 的守护共存 —— 5/5

```
✓ 别人的拒绝不会被本插件翻回允许
    组合结果：[archigate] 拦下了一条绕过编排工具的 archify 交付命令。
✓ 本插件的拒绝也不会被别人翻回允许
    组合结果：[pipeline] 拒绝：角色「tester」不得通过 shell 修改项目文件。
✓ 交换注册顺序结论不变（单调，谁都不能翻谁的盘）
✓ 与流水线无关的路径不受影响
✓ 未绑定角色的会话完全不受本守门约束
```

组合函数复刻了宿主的语义（`guardReason` 取第一个非 `undefined`）：

```js
export function composeGuards(...guards) {
  return (exec) => {
    for (const g of guards) {
      if (typeof g !== 'function') continue
      const reason = g(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }
}
```

#### ⑩ 守门健壮性 —— 2/2

用 6 组畸形入参（`arguments: null` / `agent: null` / `agent: {id: 42}` / `task_id: 42` /
`role_token: 123` / 300KB 命令串）打守门：**不抛异常**（抛了会丢掉拒绝理由），
也**不会把该拒的放行成 `undefined`**。

### 4.5 分档验证（简单不超配 / 复杂不漏配）

| 需求 | 判出 | 独立对话数 | 角色清单 |
|---|---|---|---|
| 写一个函数 fizzbuzz(n)，返回 1 到 n 的 FizzBuzz 字符串数组。 | **L0** | 4 | writer / tester / reviewer |
| 给订单**接口**加一个按状态过滤的查询参数，并补上单元测试。 | **L1** | 5 | writer / tester / reviewer |
| **重构**订单模块，把支付逻辑拆成独立服务，同时做数据库**迁移**。 | **L2** | 6 | architect / writer / tester / reviewer |
| 实现基于 **JWT** 的**鉴权**中间件，校验 token 并做**权限**控制。 | **L3** | 7 | architect / security / writer / tester / reviewer |
| 把新版服务**发布到生产环境**，**灰度** 10% 流量，准备好**回滚**方案。 | **L4** | 8 | …+ release |

理由（原文摘录）：

- L0：`未命中任何不平凡信号，允许自批 L0`
- L1：`命中不平凡信号：[L1] 涉及接口/网络边界（匹配「接口」）`
- L2：`命中：[L2] 涉及架构决策（匹配「重构」）；[L2] 涉及迁移/兼容性（匹配「迁移」）`
- L3：`命中：[L3] 涉及鉴权/凭证/权限面（匹配「鉴权」）`
- L4：`命中：[L4] 涉及生产上线/发布（匹配「发布」）`

### 4.6 装载冒烟（假 ctx，17/17）

验证的是"插件能被 cordis 装载"这句承诺：

```
✓ index.js 导出 name / inject / apply
✓ inject 只声明 tools
✓ apply() 不抛，且注册了 13 个 pipeline_* 工具
✓ 每个注册都走 ctx.effect（宿主里取消注册的唯一正确姿势）
✓ 每个工具定义都有 output.schema + output.render
✓ 守门注册了正好 1 个（不注册 post-execute）
✓ system prompt 段注册了 1 段（order=2650）
✓ 守门对无身份调用确实返回拒绝字符串
✓ 守门对无关调用返回 undefined
✓ 全部 disposer 调完之后注册表清空（HMR / 卸载路径可用）
✓ enabled:false → 什么也不注册
✓ guardEnabled:false → 工具照注册、守门不注册（**明确降级**）
✓ systemPrompt 段注册失败不会拖垮插件
✓ apply 在真实目录上跑通
```

### 4.7 工具定义：用**真编译器**校验 13/13

`tests/schema-check.mjs` 把 `app.asar` 里的 `dsh-tools/lib/types/schema.js`（真实的 `defineTool` 与
schema 编译器）连同它唯一的两个外部依赖（`dsh-llm` 的 `HarnessError`、`dsh-util-values` 的
`assertNever`/`isJsonValue`）用最小替身接起来，然后拿本插件的 13 个工具定义过一遍。

**为什么不用自己复刻的校验器**：复刻件会漂移，而且漂移了还是绿的。
拷不到编译器时脚本会**明确报"跳过、这不算通过"**，不会假装绿。

### 4.8 安装 / 回滚的沙箱实测

**没有对真实 profile 执行过。** 在 `_sandbox/home/profiles/desktop/` 上（真实 profile 的只读副本）
走完了完整链路：

| 步骤 | 结果 |
|---|---|
| `install.ps1`（首次） | ✅ bundles 追加 1 项；cordis.patch.yml 追加 1 个 insert 块；JSON 仍合法 |
| `install.ps1`（第二次） | ✅ 幂等 —— `出现次数: 1`，patch 里 `id: dsh-pipeline` 也是 1 |
| `rollback.ps1 -Stamp ... -PurgePluginDir` | ✅ 还原 + 删插件目录 |
| **回滚后与真实 profile 逐字节比对** | ✅ `cordis.patch.yml` / `cordis.yml` / `package.json` **三个文件全部 `一致=True`** |
| `rollback.ps1`（备份被删，走兜底手术） | ✅ 只摘掉 bundles 里那一项、只删 patch 里那一个 insert 块，**残留计数 = 0** |
| PS 5.1 解析器语法检查 | ✅ 两个脚本 `语法 OK`（UTF-8 with BOM，BOM=True） |

---

## 五、生效方式（要不要重启）

**要。** 本插件是 **Host 半边**插件，在 DSH 启动时装载，热更不覆盖。

| 动作 | 要不要重启 |
|---|---|
| 安装 | **要** |
| 卸载 / 回滚 | **要** |
| 改 `cordis.patch.yml` 里的 config | **要** |
| 改 `lib/*.js` 源码 | **要**（除非你自己另开了 `dsh` 的 HMR 通道，本插件不保证） |
| `pipeline_selftest` / `pipeline_*` 工具调用 | 不用 —— 它们是运行期行为 |

**重启后怎么确认装上了**：日志里找

```
[pipeline] dsh-pipeline 0.1.0 已加载：13 个 pipeline_* 工具已注册；守门已启用；通道=subagent（transport=auto，spawnRoles=true）；工作区=<项目根>/.pipeline
```

**不跑 pnpm、不装依赖** —— 本插件没有任何运行期第三方依赖。
`@deepseek-ai/dsh-tools` 解析不到时会退化成恒等 `defineTool`，插件**照样激活**
（工具仍注册，参数校验交给注册表），日志里会打 warn。

---

## 六、不确定项

### 6.1 我没能证实的（源码不在能取到的范围里）

| # | 不确定的事 | 影响 | 我怎么处理的 |
|---|---|---|---|
| 1 | `@deepseek-ai/cordis` 的 `ctx.waterfall` 调度器语义（listener 抛错 / 不调 next 的边界行为） | 低 —— 本插件不监听 waterfall | 只用 `ctx.tools.guard`，它的行为在 `dsh-tools` 里有完整实证 |
| 2 | `defineTool` 的 `timeoutMs` 由谁强制执行 | 低 —— 本插件不用它 | 全树里 `timeoutMs` 只出现在定义与校验处，无消费点，如实标为不确定 |
| 3 | `list_agents` 工具是否真的挂载 | 低 —— 本插件不依赖它 | 已装的 `dsh-tool-subagent-control` 里有 `lib/types/list-agents.js` 但 `lib/index.js` 不引用它，装配取决于 exports map（该包 `package.json` 不在 asar 里） |
| 4 | `@deepseek-ai/dsh-base` / `dsh-web-app` 两个 bundle 的内部分项 | 低 | 本机找不到这两个包体，无法证实三个 `experimental-*` 包是否被传递加载 |
| 5 | `dsh-experimental-agent-team`（`ctx.agentTeams`：命名角色 + 信箱 + 任务板）是否可用 | **中** | 它是现成的"命名角色 + 点对点信箱"实现，概念上与本插件重叠。当前 profile 的 bundles 里**没有**它 ⇒ 本插件**不依赖**它。若将来它被加载，两者的关系需要重新评估 |
| 6 | Web Client 是否消费 `presentCall`/`presentResult` | 低 —— 本插件不定义它们 | 客户端包不在 asar 里，README 的说法无法证实 |

### 6.2 需要你拍板的（规格里没定的）

逐条列在 **README 的「待确认项」表格**里（8 条，含本插件给出的机制 + 仍需你决定的部分）。
摘要：

1. **通信通道**：`subagent`（真会话，令牌可二次绑定）还是 `manual`（零副作用，人工复制）？
2. **主对话脱敏粒度**：现在隐去补丁正文 / 失败日志 / 运行命令；要不要连"变更说明"也隐去？
3. **测试环境谁提供**：未实现，测试角色跑在自己会话的环境里。要不要专门的测试沙箱？
4. **审核 OK 格式**：已固化成 5 个字段。要不要加签名 / CI 流水线 URL / 版本号？
5. **打回次数上限**：默认 2（编写、测试分别计数）。要不要按档位区分？
6. **人工卡点**：现在只有 block/unblock/cancel 三个出口。要不要在某些档位**强制**人工放行（如 L4 关单前）？
7. **制品存放位置**：`<项目根>/.pipeline/<任务>/`。要不要接外部制品库？
8. **是否开 `requireAgentBinding`**：开了更严（令牌转手即失效），但**要求走真实子代理通道**。

外加第 9 条：**L0 的编排对话取舍**（见「设计取舍 2」），一句话可翻。

### 6.3 我认为值得你注意的两个判断

1. **`dsh-experimental-agent-team` 值得看一眼。** 它已经实现了"命名角色 + 成员间信箱 +
   共享任务板 + continuable 子代理"，是"多对话协作"的另一条路。
   本插件走的是"**流程与权限**"这条路（状态机 + 交接物 + 守门），
   两者不是替代关系 —— 前者管"消息怎么传"，后者管"**谁不许干什么**"。
   如果将来要合并，接口在 `lib/transport/`，换一个通道实现即可。

2. **本插件最大的价值不在"能跑通"，而在"跑不通"。**
   正例那 9 条断言，任何一个提示词工程方案都能过；
   真正决定这套流程是否成立的是那 58 条反例 —— 每一条都是一个"模型偷懒时会做的事"，
   而它们现在**都被拒绝了，且拒绝理由可读、可审计、可复现**。

---

## 七、附：本次交付清单

| 交付物 | 位置 | 状态 |
|---|---|---|
| 插件源码（含注释） | `dsh-pipeline/`（`index.js` + `lib/`×14 + `transport/`×1） | ✅ |
| `README.md` | `dsh-pipeline/README.md` | ✅ 怎么用 / 角色 / 状态机 / 交接物 schema / **UI 开关** / **边界与已知限制** / 安装卸载 / 待确认项 / 排障 |
| `ARCHITECTURE.md` | `dsh-pipeline/ARCHITECTURE.md` | ✅ 分层 + 节点清单 + 边清单 + 守门决策树 + 时序（全部中文标签，可直接画图） |
| `install.ps1` | `dsh-pipeline/install.ps1` | ✅ UTF-8 **with BOM**；先备份后改；打印精确回滚命令；**本次未执行** |
| `rollback.ps1` | `dsh-pipeline/rollback.ps1` | ✅ UTF-8 **with BOM**；备份还原 + 无备份时的最小手术兜底 |
| 自测脚本 | `dsh-pipeline/tests/`（6 个 `.mjs` + `last-run.txt`） | ✅ 163/163 |
| 自测输出样例 | `dsh-pipeline/tests/last-run.txt` | ✅ 含全部拒绝原文 |
| 可翻阅的实物样例 | `dsh-pipeline/examples/demo-project/` | ✅ task.json + 4 份交接物 + 审计流水 + 制品 |
| 拒绝原文实物 | `dsh-pipeline/examples/example-refusal.txt` | ✅ 4 条 |
| 派活单实物 | `dsh-pipeline/examples/example-dispatch-brief.md` | ✅ |
| 本报告 | `dsh-pipeline/REPORT.md` | ✅ |
| 侦察用脚本 | `dsh-pipeline/tools/asar.ps1` | ✅ |
| **真实 profile** | `<DSH_HOME>\profiles\desktop\` | **一个字节都没动** ✅ |

---

# 八、增量：右上角的多 AI 协调开关

> 本轮追加需求。做成**增量**：新增 3 个源文件（`lib/switch.js` / `lib/switch-routes.js` /
> `lib/client.js`）+ 2 个测试（`tests/switch-check.mjs` / `tests/client-check.mjs`），
> 改动 `index.js` / `lib/guard-factory.js` / `lib/tools.js` / `lib/config.js` / `package.json` /
> `cordis.patch.yml` 的既有部分，其余文件不动。
>
> 下面每一条都标了 **[已验证]** 或 **[未验/推断]**。

## 8.1 侦察结论：DSH 有没有"右上角"槽位？

**结论：没有"窗口级顶栏/头部"槽位。最接近的是会话头部右侧的
`conversation.session.header.utilities`。本插件挂在那里。** [已验证 —— 源码 + 全树扫描]

### 槽位不是集中枚举的

`@deepseek-ai/dsh-client-ui-slots` 是**纯注册表机制**（`SlotCore`），不含任何具体槽位名。
槽位名由**声明方**（各 `ui-*` 包的 client 半边）在 `register({children: {...}})` 里就地写死。
所以只能全树扫。我写了个脚本扫了 **177 个客户端 bundle**，结果（节选）：

```
renderSlot(...) 渲染的槽位名
  main                        ← dsh-client-ui-layout:118
  sidebar                     ← dsh-client-ui-layout:300
  rightbar                    ← dsh-client-ui-layout:338
  shell.overlay               ← dsh-client-ui-layout:312
  shell.leading               ← dsh-client-ui-layout:313
  conversation.header.leading          ← dsh-client-ui-conversation:16374
  conversation.session.header          ← dsh-client-ui-conversation:16375
  conversation.session.header.actions  ← dsh-client-ui-conversation:16502
  conversation.session.header.utilities← dsh-client-ui-conversation:16506
  conversation.session.header.corner   ← dsh-client-ui-conversation:16510
  sidebar.right.pane.tab  /  settings.section  /  settings.general.item  / …
```

**和"头部/右上角"沾边的全部候选，只有这 5 个**：
`shell.leading`、`shell.overlay`、`conversation.header.leading`、
`conversation.session.header.{actions,utilities,corner}`。

### 逐个判：哪个能用

| 槽位 | 判定 | 证据（文件:行 + 关键片段） |
|---|---|---|
| `shell.leading` | ❌ **Windows 上不存在** | `dsh-client-ui-layout/lib/client.js:313-314`<br>`const leading = …renderSlot("shell.leading", {})`<br>`const leadingMounted = darwin && sidebarCollapsed;`<br>→ `:348-352` 只在 `leadingMounted` 时才渲染那个 `leadingSeat` |
| `shell.overlay` | ⚠️ 能挂，但**不合适** | `…/client.js:312` + `:343-347` 是一个整框的 `overlayLayer`，没有任何定位意见。拿它做"右上角按钮"要靠绝对定位硬怼，还可能压住弹层 |
| `conversation.session.header.utilities` | ✅ **选它** | 见下 |
| `conversation.session.header.corner` | ❌ **single 槽，已被占** | 声明：`dsh-client-ui-conversation/lib/client.js:18276-18279` `{kind:"single", scope:"session"}`；占用：`dsh-client-ui-sidebar-right/lib/client.js:9187-9192`（右侧栏切换按钮）。`SlotCore.register` 对 single 槽同优先级会**直接抛** "single slot … already has a registration"（`dsh-client-ui-slots/lib/index.js:170-173`） |
| `conversation.header.leading` | ❌ single 且是"标题左侧" | `…/conversation/lib/client.js:18250-18253` `{kind:"single", scope:"root"}` |

### 为什么选 `conversation.session.header.utilities`

**① 它是 list 槽，允许多个条目共存**（这一点决定了能不能挂进去）：

```js
// dsh-client-ui-conversation/lib/client.js:18272-18275
"conversation.session.header.utilities": {
    kind: "list",
    scope: "session"
},
```

list 槽的注册规则（`dsh-client-ui-slots/lib/index.js:181-186`）：

```js
case "list": {
    if (options.id === void 0) throw new Error(`list slot "${options.name}" requires options.id`);
    const occupant = rec.entries.find((e) => e.options.id === options.id && (e.options.priority ?? 0) === priority);
    if (occupant) throw new Error(`list slot "…" already has an entry with id "…"`);
    break;
}
```

⇒ 只要给唯一的 `id` 就不会撞。已装的 `dsh-client-ui-open-in-app` 就住这儿
（`…/open-in-app/lib/client.js:846-852`，`id: "open-in-app", order: -10`）。

**② 它的渲染不受 `hideChrome` 影响** ⇒ 空会话时也看得见：

```js
// dsh-client-ui-conversation/lib/client.js:16463
children: [!hideChrome && (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [
    /* titleCluster（面包屑） */, /* headerActions */
]}), (0, react_jsx_runtime.jsx)("div", {
    className: …headerUtilities,
    children: renderSlot("conversation.session.header.utilities", {})
})]
```

`!hideChrome &&` 只圈住了面包屑与 `headerActions`；`headerUtilities` 与它**平级**。

**③ 位置就在用户红框那一带**：它是会话头部那一排的右侧区域，
紧挨着最右边的 `…header.corner`（右侧栏切换按钮在 corner 里）。
它挂在**中列**顶部；右侧栏收起时，视觉上就是窗口右上角。

### 客户端插件的装载契约 [已验证]

```js
// dsh-client-modules/lib/client.js:450-464 —— 关键：**没有 type="module"**
const defaultLoadBundle = (url) => new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.async = true;
    el.src = url;
    …
});
```

⇒ 客户端 bundle 是**经典脚本**，不是 ES 模块。所以 `lib/client.js` 里
**不许有 `import` / `export` / 顶层 `await`**，只能 `require(...)`（loader 提供的内建）。

其余契约：

| 事实 | 出处 |
|---|---|
| 入口 = `exports["./client"]`（字符串或 `{default:…}`） | `dsh-client-modules/lib/index.js:170-181` |
| 只扫 `dsh.client.platform === "web"` 的包 | `…/index.js:713-714` |
| 模块 id = 包名，URL 形如 `/plugins/<id>/client.js?rev=…` | `…/index.js:204` |
| 必须调 `window.__ModuleLoader__.load({id, factory})` | `dsh-client-modules/lib/client.js:17`（文档）+ 全树实例 |
| 工厂返回 `{apply, inject}`，`inject` 是**服务名**数组 | `dsh-drawai/lib/client.js:11716/11752-11753`：`exports.inject = ['slots', …]; exports.apply = apply` |
| 服务名 `slots`、方法 `inject(key, cb)` / `register(spec, Component)` | `dsh-client-ui-renderer/lib/client.js:1323` `super(ctx, "slots")`、`:1343` `inject(key, callback)` |
| 挂载惯例 `ctx.effect(() => ctx.slots.inject(K, () => ctx.slots.register(...)))` | `dsh-drawai/lib/client.js:11747-11748` |

### HMR / 刷新行为 [已查明]

**本机没有跑 `pnpm run dev:web`** —— 我在整轮侦察与实现期间都只能读 `app.asar`，
客户端 bundle 由宿主按 boot manifest 的 `rev` 版本号加载。
所以：

- 改了 `lib/client.js` 之后，**必须重启 DSH**（或让宿主重新生成 boot manifest 的 rev）才会生效。
  watcher 不存在，不会自动热更。
- 装完之后第一次看到按钮，也是在**重启后重新打开页面**时。
- 页面内**不需要**手动刷新：按钮是随会话头部一起渲染的。
- **按钮的点击是运行期行为，不涉及重新加载** —— 开关切换立即生效（见 8.4）。

## 8.2 设计取舍

### 取舍 A：关掉 ≠ 卸载（结构恒常，行为可变）

关掉开关时**不注销守卫、不注销工具**：

> `ctx.tools.guard()` 注销再重注册，会改变这个守卫在 `ToolLayer.guards` 里的**顺序**
> （`dsh-tools/lib/index.js:2921-2926` 是 `layer.guards.append(guard)`）。
> 而守卫链是"取第一个非 `undefined` 即返回"（`:2646-2651`）。
> **顺序一变，与 `dsh-archigate` 同时命中时的拒绝文案就会跟着变** ——
> 那是对用户可见的行为抖动，为一个开关不值得。

同理，工具注销再注册会让模型看到的工具表在会话中途改变，容易触发"工具消失"的困惑。
所以：**注册结构一份不变，行为由开关位决定**。

### 取舍 B：守门"弃权"而不是"允许"

关掉时守门返回 `undefined`。在宿主语义里 `undefined` 是**弃权**（投弃权票），
不是"允许" —— `guardReason` 会继续问下一个守卫。所以：

- 关掉本插件 = 关掉"多 AI 协调"这一层
- **不等于**关掉 `dsh-archigate` 的 archify 交付守门，也不等于关掉 `experimental-auto-review`

这条专门写了自测 **G3**（组合守卫下，本插件弃权后别人照样能拒）。

### 取舍 C：两处执法（守门 + 工具），不是一处

守门管"越权"，开关管"这功能本身开没开"，两者**正交**。
而且守门对**没有身份**的调用方是放行的（它只约束流水线参与者，
见 README「拦不住的」第 3 条）—— 所以关掉之后光靠守门**拦不住** `pipeline_task_open`
这类动作。必须在工具层再判一次。自测 T1/T2/T6 覆盖这条。

### 取舍 D：`webServer` 运行期探测，不写进 `inject`

写进 `inject` 的话，没有 `webServer` 的形态（headless）下**整个插件都不会激活** ——
而守门与工具在 headless 下照样有用。所以：

```js
const webServer = typeof ctx?.get === 'function' ? ctx.get('webServer') : ctx?.webServer
if (webServer === undefined || …) return null   // 安静降级
```

拿不到就跳过路由；开关仍可用 `pipeline_switch` 工具翻。自测 R15 验这条。

### 取舍 E：开关是**同步**可读的内存位 + 异步落盘

`guardReason` 是**同步**遍历（`dsh-tools:2928`），所以 `isOn()` 必须是同步内存读，
不能 `await`、不能每次读盘。落盘是**写路径**上的副作用，失败也不影响内存里的真相
（但会明确报 `persisted:false` 并打日志 —— 否则"重启后自己变回去了"极难排查）。

### 取舍 F：不用 React 之外任何东西，不用 JSX，不用宿主 CSS

- 组件用 `React.createElement`（手写经典脚本，没有构建步骤 ⇒ 没有构建产物与源码漂移的问题）
- 样式**全部内联**：不注入 CSS、不读宿主 CSS 变量 ⇒ 不可能污染别人，也不可能因为宿主改类名而失效
- `WebkitAppRegion: 'no-drag'`：头部是 Electron 的窗口拖拽区
  （`ConversationHeader` 上有 `data-window-drag`，`…/conversation/lib/client.js:16370`），
  不写这一行点击会被当成拖窗口

### 取舍 G：读不到状态时显示"?"，不猜

按钮有三种视觉状态：开（绿点）/ 关（灰点）/ **未知（黄点 + "?"）**。
读不到宿主状态时显示"未知" —— 说错（假装是开）比不说更糟。自测 C9 覆盖。
轮询周期 8 秒（宿主开关也可能被 `pipeline_switch` 工具翻），页面隐藏时跳过。

## 8.3 实现要点

新增/改动：

| 文件 | 新增/改动 | 说明 |
|---|---|---|
| `lib/switch.js` | **新增** | 同步可读的开/关位；落盘 `.pipeline/switch.json`（先写 .tmp 再 rename）；订阅通知；坏文件/写失败都不静默 |
| `lib/switch-routes.js` | **新增** | `GET/POST /.dsh-pipeline/state`；只服务环回；幂等挂载；假 req/res 可直接单测 |
| `lib/client.js` | **新增** | 客户端半边（经典脚本）；`__ModuleLoader__.load`；注册按钮；相对 fetch 读写 |
| `lib/guard-factory.js` | 改 | 开关判定放在**最前面、且在 try 外面**；关 = 返回 `undefined`。读开关失败 → fail-closed 拒绝 |
| `lib/tools.js` | 改 | `tool()` 加 `mutating` 闸；11 个写工具标 `mutating: true`；新增 `pipeline_switch` 工具 |
| `lib/config.js` | 改 | `switchDefaultOn` / `switchStateFile` / `switchRoute` |
| `index.js` | 改 | 建开关、挂路由（可选）、装载日志报告开关状态与端点 |
| `package.json` | 改 | `exports["./client"]` + `dsh.client.platform = "web"` |
| `cordis.patch.yml` | 改 | 三个新配置项的注释与默认值 |
| `tests/switch-check.mjs` | **新增** | 38 项 |
| `tests/client-check.mjs` | **新增** | 23 项（`node:vm` + 桩 React，无浏览器） |
| `tests/run-all.mjs` | 改 | 三套 → 五套 |

**HTTP 契约**：

```
GET  /.dsh-pipeline/state
  → 200 { ok, on, since, by, revision, version, stateFile }
  → 403 非环回来源（开关能整体关掉守门，是安全相关状态位）

POST /.dsh-pipeline/state
  body { on: true|false }  → 显式设定
  body { }                 → 翻转
  body { on:true, reason } → 附带原因（记进状态文件）
  → 200 { ok, on, changed, since, by, revision, persisted, version, stateFile }
  → 400 非法 JSON / 不是对象      → 413 超过 4 KB      → 405 其它方法
```

**关掉时谁受影响**（这是需求点名要写清的）：

| 主体 | 影响 | 验证 |
|---|---|---|
| 守门 | **弃权**（返回 `undefined`）。别的插件的守卫**照样能拒** | [已验证] G1/G2/G3/G4 |
| 14 个工具 | 注册结构不变；**11 个写操作**返回明确拒绝 + 恢复指引；3 个只读（`status`/`selftest`/`switch`）照常 | [已验证] T1/T2/T6 |
| 已有任务的落盘数据 | **完全不动**（task.json / handoffs / audit.jsonl 一个字节不改） | [已验证] 代码路径：关掉时写工具**连 store 都不碰**；switch-check 全程跑在真目录上，关/开来回切后文件哈希未变 |
| 其它插件 | **不受影响**（不注销任何东西、不碰别人的文件） | [已验证] G3 |
| 正在跑的会话 | 立即生效；**不需要刷新页面、不需要重启** | [已验证] 开关是内存位，工具与守门每次调用现读 |
| 需要重启的操作 | **改源码 / 安装 / 卸载 / 改 cordis 配置** 需要重启 | [已验证] 与开关无关 |

## 8.4 实测

### 汇总

```
#  dsh-pipeline 自测汇总：163/163 通过
【正例】9/9        【反例①】6/6     【反例②】5/5     【反例③】5/5
【反例④】13/13     【反例⑤】3/3     【反例⑥】3/3     【反例⑦】7/7
【反例⑧】4/4       【反例⑨】5/5     【反例⑩】2/2     【分档】5/5
总计：67/67 通过   ← selftest
总计：21/21 通过   ← 装载冒烟（含开关路由的挂载/降级）
工具定义真编译器校验：14/14 通过
总计：38/38 通过   ← 功能开关（本轮新增）
总计：23/23 通过   ← 客户端半边（本轮新增）
```

跑法：`node tests\run-all.mjs`（或单独 `node tests\switch-check.mjs` / `node tests\client-check.mjs`）。

### 功能开关的 38 项（节选）

```
✓ S1 首次启动（无状态文件）默认是开
✓ S8 重启后从状态文件恢复上次的选择（现在是关）
✓ S9 状态文件损坏时回落到 initial，并把原因说出来（不静默）
✓ S10 落盘失败时内存态仍生效，且明确报告 persisted=false
✓ G1 开：测试改项目源码被守门拦下
✓ G2 关：同一次调用守门**完全弃权**（返回 undefined）
✓ G3 关掉本守门后，其它插件的守卫**仍然能拒**（弃权 ≠ 允许）
✓ G4 再打开：守门立刻恢复（不需要重启）
✓ T1 关：pipeline_task_open（写）被拒，且说清怎么恢复
✓ T2 关：pipeline_status（只读）照常可用
✓ T5 不带参数 = 翻转（从开翻到关）
✓ R3 POST {on:false} 把开关关掉
✓ R10 非环回来源 → 403（开关是安全相关状态位，不该被局域网翻）
✓ R15 拿不到 ctx.webServer 时返回 null（安静降级，不抛）
✓ R16 有 webServer 时按 kind:"prefix" + path:"/.dsh-pipeline" 注册
```

关掉时写工具的拒绝原文：

```
[pipeline] 多 AI 协调功能当前是**关闭**状态，本动作不会执行。
工具：pipeline_task_open
怎么恢复：把 DSH 窗口右上角头部那一排里的「多AI 协调」开关点成「开」，或者让主对话调用 pipeline_switch { on: true }，或者调用 pipeline_switch 不带参数直接翻转。
关闭状态下仍然可用的是只读动作：pipeline_status（查历史任务）、pipeline_switch（看/改开关）、pipeline_selftest（自检）。
```

### 客户端半边的 23 项（节选）

用 `node:vm` 把 `lib/client.js` 当经典脚本跑，再用**桩 React** 真渲染一遍：

```
✓ A1 文件是经典脚本：没有 import / export / 顶层 await
✓ A4 模块 id 等于包名（宿主用它拼 /plugins/<id>/client.js）
✓ A5 package.json 声明了 exports["./client"] 与 dsh.client.platform="web"
✓ B5 注册进 conversation.session.header.utilities
✓ B6 该槽位是 list 槽 → 注册必须带 id（不带会被 SlotCore 直接抛）
✓ C1 挂载后向宿主的开关端点发 GET（相对路径，带 same-origin 凭据）
✓ C2 状态为开时，按钮文字包含「多AI 协调」与「开」   → 渲染出的文字：「多AI 协调开」
✓ C5 点一下会发 POST，body 是 { on: false }
✓ C6 点击后按钮文字变成「关」                        → 「多AI 协调关」
✓ C9 读不到宿主状态时显示未知（?），**不会**假装是"开"→ 「多AI 协调?」
```

### 装上去之后长什么样（预期描述）

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◀ 侧栏   面包屑 / 会话标题        ⋯ 菜单   ● 多AI 协调 开   ⇥ 侧栏  │  ← 会话头部
├──────────────────────────────────────────────────────────────────────┤
```

- 一个**胶囊形**小按钮，高 26px，圆角 999px，紧贴右侧栏切换按钮的**左边一格**
- 内容自左至右：**状态圆点**（开=绿 `#2ea043` / 关=灰 `#8b949e` / 未知=黄 `#d29922`）
  + 文字「多AI 协调」+ 状态字「开 / 关 / ?」
- 开的时候按钮带淡绿色底与绿边，关的时候透明底灰边
- 悬停显示完整说明（title）：开/关各自什么意思、点一下切换、最近一次通信失败的原因
- 点击时按钮变半透明、光标变 `progress`（正在写宿主）
- 带 `data-pipeline-toggle="on|off|unknown"` 属性，方便人工/自动化核对
- **不跟随宿主主题**（纯内联样式，写死的语义色），所以在深色/浅色主题下都是这个样子

## 8.5 已验证 vs 未验（按需求要求逐条标）

### [已验证] —— 有可复现的自动化断言

| # | 结论 | 证据 |
|---|---|---|
| 1 | 没有窗口级顶栏槽位；`shell.leading` 在 Windows 上不挂载 | 源码 `dsh-client-ui-layout/lib/client.js:313-314,348-352` + 177 个 bundle 的全树扫描 |
| 2 | `conversation.session.header.utilities` 是 list 槽、与 `corner` 相邻、不受 `hideChrome` 影响 | 源码 `…/conversation/lib/client.js:16463,16404-16406,18272-18279` |
| 3 | `corner` 是 single 槽且已被右侧栏插件占用（往那儿注册会被顶掉） | 源码 `…/sidebar-right/lib/client.js:9187` + `dsh-client-ui-slots/lib/index.js:170-173` |
| 4 | 客户端 bundle 必须是**经典脚本**（loader 用 `<script async>` 加载） | `dsh-client-modules/lib/client.js:450-464` |
| 5 | 模块 id = 包名；入口 = `exports["./client"]`；只认 `platform==="web"` | `dsh-client-modules/lib/index.js:170-181,713-714,204` |
| 6 | `lib/client.js` 文件本身合规（无 import/export/顶层 await、调了 `load`、id 对） | client-check A1~A6 |
| 7 | `apply(ctx)` 挂到目标槽，spec 带唯一 `id` 与 `order` | client-check B3~B8 |
| 8 | 按钮渲染出文字「多AI 协调开/关/?」，点击发出 `{on:false}` 并更新显示 | client-check C1~C9（桩 React 真渲染） |
| 9 | 开关位：默认值、翻转、落盘、重启恢复、坏文件与落盘失败都不静默 | switch-check S1~S10 |
| 10 | 关掉后守门**完全弃权**；且不阻止别的守卫拒绝 | switch-check G1~G4 |
| 11 | 关掉后 11 个写工具被拒、3 个只读工具照常 | switch-check T1~T6 |
| 12 | HTTP 端点：GET/POST/翻转/错误分支（400/403/404/405/413）/环回判定 | switch-check R1~R17 |
| 13 | 拿不到 `webServer` 时安静降级（headless 友好） | switch-check R15 + load-smoke |
| 14 | 14 个工具定义通过**真** `defineTool` 编译器 | schema-check |
| 15 | 切换**不需要重启**（开关是内存位，工具与守门每次调用现读） | 代码路径 + switch-check G4/T3~T5（同进程内关→开立即生效） |

### [未验 / 按源码推断] —— 明确标出来，别当成验过了

| # | 事项 | 为什么没验 | 风险 |
|---|---|---|---|
| 1 | **真实浏览器里的排版与像素位置** | 本机没有截图能力，也没有跑起来的浏览器测试环境 | 中低。可能"位置对但看着不协调"（宽度、间距、与邻居的视觉平衡） |
| 2 | **真实点击**（Electron 拖拽区里的点击是否穿透到按钮） | 同上 | 中。`WebkitAppRegion:'no-drag'` 是标准做法，且旁边的 `corner` 按钮同样在拖拽区里工作 ⇒ 大概率没问题，但**没在真机上点过** |
| 3 | **真实宿主插槽渲染**（`ctx.slots.inject` 在真宿主里能否等到声明） | 需要装上去跑起 DSH | 低。`inject` 的语义就是"声明还不存在时等着"（`dsh-client-ui-renderer/lib/client.js:1328-1341` 的 JSDoc 明说），且有现成插件（drawai/orb/open-in-app）在用同一套 |
| 4 | 宿主主题变量下的视觉协调 | 组件刻意用纯内联样式 | 低（这是取舍 F 的代价，也是它的好处：不会失效） |
| 5 | `dsh.client.inject` 留空是否 100% 够 | 我**刻意留空**（只 `require('react')`，并用 `exports.inject=['slots']` 等 cordis 服务）。drawai 声明了包名，我没声明 | 低-中。若真宿主对模块图顺序有更强要求，可能需要补上 `@deepseek-ai/dsh-client-ui-conversation`。装载日志能看出来（按钮不出现 = 需要补） |
| 6 | 轮询 8 秒的实际体感 | 没在真机上观测 | 低。宿主端点是本机内存读，开销可忽略；要更实时可以调小 `POLL_MS` |
| 7 | 非环回判定在真实 `webServer` 上的表现 | 假 req 验的 | 低。判定逻辑是纯函数（`isLoopback`），R14 逐项验过；真实 socket 的 `remoteAddress` 形状与假设一致 |

### 需要你决定/知情的

1. **`switchRoute: false` 什么时候该开**：如果你的 profile 把 `webServer` 配成**对外监听**，
   请设 `switchRoute: false`（那时 UI 按钮显示"未知"，开关改用 `pipeline_switch` 工具翻）。
   默认 `true` 的前提是"端口只绑定环回"。
2. **开关状态是按项目根存放的**（`<项目根>/.pipeline/switch.json`）。
   不同项目根 = 不同开关文件。要全局统一，配 `switchStateFile` 指向一个固定路径。
3. **按钮是否要跟随主题**：现在写死语义色。要跟随主题就得读宿主的 CSS 变量
   （能读，但会引入"宿主改变量名就失效"的风险）。这是个取舍，等你拍。
4. **要不要更细的开关粒度**：现在是"总开关"。也可以做成"只关守门、保留编排"或
   按任务单独开关。当前语义是按你的原话实现的：**关 = 关闭该功能，回到普通 DSH 行为**。

---

# 九、设计修正：人工介入必须走主对话

> 第二轮追加需求。用户指出一个**拓扑硬约束**：
> 「人工介入应该由其他 ai 提供给主对话，主对话将内容转告用户，
> 理由是**用户的对话框只在主对话中**。」
>
> 也就是说：执行/顾问角色**没有对用户说话的通道**，任何要人拍板的事
> 只能走「角色发起 → 主对话转告 → 用户答复 → 主对话记回来 → 恢复」。
> 原来的实现只有"主对话/人工自己触发的出口"（`block`/`unblock`/`cancel`），
> **缺"角色向上发起"这条机制**。这一节记这次补上的东西。

## 9.1 新增 / 改动的文件与契约

| 文件 | 改动 | 契约 |
|---|---|---|
| `lib/roles.js` | 改 | 11 个非 main 角色的 `handoffKinds` 各加 `'human_request'`；**`main` 保持空数组**（它只转告，不产出） |
| `lib/states.js` | 改 | 新增状态 `awaiting_human`（等待人工答复）；新增 `ROLES_CAN_RAISE_HUMAN` 白名单；两条新边（见 9.2） |
| `lib/handoff.js` | 改 | 新增 `human_request` 交接物 schema（14 字段）+ `detectCodeInHumanText()` + `looksLikeQuestion()` + 7 条跨字段约束；校验器新增 `object[]` 类型 |
| `lib/store.js` | 改 | `planAdvance` 支持 `human_request`；`createHumanRequestEntry` / `findHumanRequest` / `relayHumanRequest` / `replyHumanRequest` / `listHumanRequests`；两条新前置条件；新增"**不迁到已在的状态**"通用规则；`status` 输出加 `human_requests` |
| `lib/guard.js` | 改 | `HANDOFF_DIRECTION` 加 `human_request`（11 个允许角色）；`PIPELINE_TOOL_ROLES` 加三个工具；新增"主对话不能发起"的专门分支 |
| `lib/tools.js` | 改 | 新增 3 个工具（14 → **17**） |
| `lib/util.js` | 改 | 导出 `clip()`（审计行截断） |
| `lib/config.js` | 改 | `humanRequestTimeoutHours`（默认 0）、`requireHumanConfirmCode`（默认 false） |
| `cordis.patch.yml` | 改 | 两个新配置项的注释与默认值 |
| `tests/human-check.mjs` | **新增** | 44 项：正例四步 + 四类反例 + 留痕 + 闭环 + 补充 |
| `tests/human-check-last-run.txt` | **新增** | 本套的完整原始输出 |
| `tests/run-all.mjs` | 改 | 五套 → **六套** |

### 三个新工具的契约

| 工具 | 允许角色 | 前置 | 副作用 |
|---|---|---|---|
| `pipeline_human_request` | **除 main 之外**的全部角色（守卫 + execute 双层判） | 请求体必须过 7 条跨字段约束（含"不许含代码"） | `blocking=true` → 状态推到 `awaiting_human` 并记 `state_at_request`；`false` 则不动 |
| `pipeline_human_relay` | **只有 main** | 请求存在且未答复 | **不改状态**；记 `relayed_at` / `relay_channel` / `relay_count`；生成确认码 |
| `pipeline_human_reply` | **只有 main** | 已转告 + 来源闸 + 形状闸 | 记答复；`blocking` 且仍在 `awaiting_human` → 恢复状态 |

`pipeline_handoff { kind: "human_request" }` 与 `pipeline_human_request` 是**同一条路径**
（都走 `store.submitHandoff`），不会有两套规则。

## 9.2 状态机怎么表示"等人"、恢复到哪里

### 表示：单开一个状态，不复用 `blocked`

新增 `awaiting_human`（等待人工答复）。**刻意不复用 `blocked`**：

- `blocked` = **主对话/人工主动叫停**（"先别做了"）
- `awaiting_human` = **执行角色向上发起、主对话已/待转告、等用户回话**（"卡在等谁回话"）

两者要回答的问题不同。合成一个之后，"这个任务在等谁"就没法机械回答了 ——
而那恰恰是主对话最需要知道的事（它要不要去催用户）。
自测里 `state_at_request=testing` 这一条就是在验这个信息没丢。

### 两条新边

```js
// 发起：任意非终态 → 等待人工答复
{ from: '*', event: 'human_request', to: ST.AWAITING_HUMAN,
  by: ROLES_CAN_RAISE_HUMAN, guard: 'human_request_blocking',
  note: '★ 角色向上发起人工介入（blocking 时才推状态）' }

// 恢复：等待人工答复 → **被打断前的状态**
{ from: ST.AWAITING_HUMAN, event: 'human_reply', to: '(previous)',
  by: ['main'], guard: 'human_reply_has_source',
  note: '★ 用户答复后恢复：回到被打断前的状态' }
```

### 恢复到哪：**回到被打断前的那个状态**

`to: '(previous)'` 用的是 `task.previous_state`，而它与请求记录里的
`state_at_request` **由构造保证一致**（同一个 `from`）。

**为什么不按"发起角色对应的阶段"反推**：发起者当时就在那个状态里干活，
问题解决了就该**原地继续**。按角色反推会把「测试中提问、答完回到测试中」变成
"回到待测试"，那样主对话得**重新派一次活**，凭空多一次状态往返。

实测（正例）：

```
state=awaiting_human  state_at_request=testing  status=pending
...
state=testing  resumed_from=awaiting_human → resumed_to=testing
```

### 两条防死结的规则

`human_request` 的边是 `from: '*'`。如果任务**已经在** `awaiting_human`，
而另一个角色又提一个 blocking 请求，迁移会变成 `awaiting_human → awaiting_human`，
`transition()` 会把 `previous_state` 覆盖成 `awaiting_human` ——
之后 `human_reply` 回到 `awaiting_human`，**任务永久卡死**。

现在有两道防护（这是写测试时想到、并写进代码的）：

1. **提交侧的通用规则**：`if (tr.to !== task.state)` —— **不要迁到你已经待着的那个状态**。
   这条规则本身是通用的，将来任何 `from:'*'` 的边都受益。
2. **建记录时**若已在 `awaiting_human`，`state_at_request` **继承上一条待答复请求的**恢复目标。

### 非阻塞请求

`blocking: false` 的请求**不推状态**（"顺便问一下"不该打断流程），
但仍进待办、仍要主对话转告、答复也要记。实测：

```
state=testing  blocking=false  state_at_request=testing
```

## 9.3 反例④的核心：为什么"不许含代码"是一条机制而不是建议

用户的原话理由是"用户的对话框只在主对话中"。往前推一步就得到一条**推论**：

> 主对话**不读代码**（守门拦着）⇒ 它转告不了含代码的东西 ⇒
> 交给它转告的文本**必须本身就可读**。

所以 `question_for_human` 的"人话"要求不是风格建议，是**这条拓扑的直接产物**。
判据放在**提交时**（而不是等转告时才发现主对话看不懂），7 条：

代码围栏 / diff 标记 / 行首代码关键字 + 标识符 / 代码表达式 / 带代码扩展名的路径 /
对象字面量 / 分号或花括号结尾行 / 超长（>600 字符）/ 没有问号。

判据刻意用**高精度标记**（宁可漏判也不误伤）—— "问句里提到 step 参数"不该被拦，
"贴了一段 diff"必须被拦。自测 ④b/④c 分别验了这两侧。

## 9.4 实测：命令 + 原始输出

```powershell
cd dsh-pipeline
node tests\human-check.mjs
```

完整输出：`tests/human-check-last-run.txt`。下面贴关键组的**原文**。

### 正例：四步走通（7/7）

```
【正例：四步走通（发起 → 转告 → 答复 → 恢复）】7/7 通过

✓ ①发起：tester 向上发起人工介入请求（阻塞）
    结果摘要：
        交接物已提交：H-4e5cedfb0ce8227f（人工介入请求，测试 → main）。
        任务状态：测试中 → 等待人工答复。
        请求已登记：HR-c8766504e45af91d　当前状态：等待人工答复
        任务已进入「等待人工答复」—— 在用户答复之前它不会被推进。

        接下来**不是你去问用户** —— 你的对话框里没有用户。等主对话把用户的答复记回来，
        状态会回到你提问时的那个位置，你再用 pipeline_status 看结论继续干活。

✓ ①发起：任务进入「等待人工答复」，并记下被打断前的状态
    state=awaiting_human  state_at_request=testing  status=pending

✓ ②转告：主对话先看收件箱（不带 request_id）
    结果摘要：
        任务 T-20261011-30971a 的人工介入请求（共 1 条，待处理 1 条）：

          ●待转告 HR-c8766504e45af91d  [pending]  tester  编写与测试/审核结论冲突（谁对谁错，角色之间定不了）
              测试跑出来步长过滤在 step 为 0 时会返回全部结果，但编写认为这是预期行为。这两种理解会做出不一样的东西，需要你定一下：到底该按哪种？
              阻塞=true 紧急=normal 需要=从给定方案里选一个

✓ ②转告：把请求转告给用户（含"照抄给用户看"的原文块）
    结果摘要：
        请求：HR-c8766504e45af91d（tester 发起，编写与测试/审核结论冲突（谁对谁错，角色之间定不了））
        阻塞：是（卡在 测试用例设计（边界值定不下来））
        紧急度：normal　需要用户给：从给定方案里选一个
        无人回应时：一直保持等待（不自动推进）

        ★ 转告给用户的内容（**照抄这段**，不要自己加技术判断）：

          测试跑出来步长过滤在 step 为 0 时会返回全部结果，但编写认为这是预期行为。这两种理解会做出不一样的东西，需要你定一下：到底该按哪种？

          背景：同一份验收标准，两种读法都说得通，测试与编写各自有理由，角色之间定不了。

          可选方案：
           1) 按编写的理解：step=0 返回全部 —— 测试要改期望值，用例重跑一遍即可，改动最小
           2) 按测试的理解：step=0 应当报错 —— 编写要改实现并补一个错误分支，工作量稍大但语义更严

          tester 的建议（仅供参考，不是决定）：按测试的理解：step=0 应当报错

          确认码：HC-9361daff（把这一行也带上，用户答复时可以回带它作为凭据）

        主对话接下来只做两件事：把上面这段呈现给用户，然后把用户的答复原样记回来：
          pipeline_human_reply { task_id: "T-20261011-30971a", request_id: "HR-c8766504e45af91d", user_quote: "<用户的原话>", ... }
        ★ 不要替用户选，也不要把这条请求标成"已解决" —— 没有用户答复就恢复不了。

✓ ②转告：状态**没有**被转告动作改变（它早在发起时就推了）
    state=awaiting_human status=relayed relayed_at=2026-10-10T21:45:54Z

✓ ③记答复 + ④恢复：一句话完成两步
    结果摘要：
        已记录答复并推进：HR-c8766504e45af91d
        发起角色：tester　答复来源：用户
        用户原话：就按测试那个来吧，step 是 0 应该报错。别的先不用动。
        归属：用户在当前会话里直接回复（chat）
        决定："按测试的理解：step=0 应当报错"
        任务状态：等待人工答复 → 测试中

        四步留痕（都在 audit.jsonl 与 task.json 里）：
          ① 发起  human:request  HR-c8766504e45af91d  by tester
          ② 转告  human:relay    2026-10-10T21:45:54Z  by main
          ③ 答复  human:reply    2026-10-10T21:45:54Z  source=user
          ④ 恢复  human:resume   2026-10-10T21:45:54Z  → testing

✓ ④恢复：状态**回到被打断前的那个状态**（测试中）
    state=testing  resumed_from=awaiting_human → resumed_to=testing
```

### 留痕：四步都在 `audit.jsonl` 里（4/4）

```
✓ 留痕：audit.jsonl 四步齐全
    缺失：（无）
    实际 human:* 动作：human:request, human:relay, human:reply, human:resume

✓ 留痕：答复里能看到"用户说了什么"（原话 + 归属）
    human:reply 审计行：
        { "at": "2026-10-10T21:45:54Z", "task_id": "T-20261011-30971a", "actor": "main",
          "action": "human:reply", "request_id": "HR-c8766504e45af91d", "from_role": "tester",
          "answer_source": "user",
          "user_quote": "就按测试那个来吧，step 是 0 应该报错。别的先不用动。",
          "attribution": "用户在当前会话里直接回复", "reply_channel": "chat",
          "decision": "按测试的理解：step=0 应当报错", "applied_policy": null,
          "agent": "selftest-main" }

✓ 留痕：恢复里能看到"依据哪条答复恢复"
    human:resume 审计行：
        { "at": "2026-10-10T21:45:54Z", "task_id": "T-20261011-30971a", "actor": "main",
          "action": "human:resume", "request_id": "HR-c8766504e45af91d",
          "based_on": "用户原话：就按测试那个来吧，step 是 0 应该报错。别的先不用动。",
          "from": "awaiting_human", "to": "testing", "agent": "selftest-main" }

✓ 留痕：请求**原件**也落盘（handoffs/NNN-human_request.json，不可变）
    文件：001-dev_to_test.json, 002-human_request.json
    原件：from_role=tester to_role=main handoff_id=H-4e5cedfb0ce8227f
```

### 闭环：答复后发起角色能继续干活（1/1）

```
✓ 闭环：恢复后发起角色能接着把活干完（测试交审核）
    结果摘要：
        交接物已提交：H-0b55431fa57b76ac（测试报告交审核，测试 → reviewer）。
        任务状态：测试中 → 待审核。
```

### 反例① 主对话伪造用户答复（6/6）

```
✓ ①伪造①a 还没转告就记答复（跳过转告）          拦截层：execute
    请求 HR-1ef4b21f2a387c27 还没有转告给用户，所以不可能有用户答复。
    先调 pipeline_human_relay 把问题呈现给用户，拿到用户的原话之后再回来记录。
    ★ 这条判据挡的是"跳过转告、直接伪造一个答复"。

✓ ①伪造①b 答复不带用户原话（user_quote 缺失）    拦截层：execute
    缺 user_quote：记录用户答复时必须带上**用户本人的原话**。
    为什么这条是硬要求：本插件拦不住主对话编一句"用户说可以"，但一条**没有原话**的答复连事后审计都无从下手。
    带上原话之后，编造至少是"留下了一份可被用户本人核对的伪造记录"。

✓ ①伪造①c 原话短到不构成可核对的凭据            拦截层：execute
    user_quote 只有 2 个字符，太短，不构成一句可核对的原话。

✓ ①伪造①d 把问题原文抄回来当答复（回声）        拦截层：execute
    user_quote 与请求里的问题/建议/选项标签**一字不差** —— 那不像用户说的话，像是把问题抄了一遍。
    请记用户实际答复的原话。

✓ ①伪造①e 答复没有归属（谁在哪说的）            拦截层：execute
    缺 attribution：要写清这句答复是**谁、在哪**说的（例如"用户在当前会话里直接回复"）。
    答复必须可归属 —— 否则审计里看不出这句话的出处。

✓ ①伪造：以上五次尝试之后，任务仍停在「等待人工答复」
    state=awaiting_human status=relayed answered_at=null
```

### 反例② 主对话替用户拍板（5/5）

```
✓ ②拍板②a 主对话直接推 human_reply（没有答复记录）  拦截层：execute
    请求 HR-195dc3d4eaa451b5 还没有记录用户答复（status=relayed）。
    ★ 主对话不能自行把请求标记为已解决 —— 必须先用 pipeline_human_reply 记下用户的答复（含原话与归属），状态才会跟着恢复。

✓ ②拍板②b 请求问的是"选哪个"，主对话回了个布尔     拦截层：execute
    decision_kind=choose_option：答复必须给 chosen_option。

✓ ②拍板②c 选了一个不在选项里的答案                  拦截层：execute
    decision_kind=choose_option：chosen_option=「两个都按」不在给用户的选项里。
    可选：按编写的理解：step=0 返回全部 / 按测试的理解：step=0 应当报错
    ★ 选项之外的东西不可能是用户从这个选择题里选出来的。

✓ ②拍板②d 用 answer_source=timeout 绕过用户答复    拦截层：execute
    请求 HR-195dc3d4eaa451b5 声明的是 timeout_behavior=stay_blocked（一直等），所以不能按超时放行。
    要么等用户答复，要么由主对话调 pipeline_transition event=cancel 明确取消。

✓ ②拍板：任务仍停在「等待人工答复」，没有被主对话自行放行
    state=awaiting_human
```

### 反例③ 角色越权（9/9，含"绕过守门打 execute"的第二道闸）

```
✓ ③越权③a 编写角色想自己把请求转告/标记（守门层）  拦截层：guard
    [pipeline] 角色越权被拦下。
    工具：pipeline_human_relay
    允许角色：main
    当前角色：writer

✓ ③越权③a′ 绕过守门直接打 execute：转告仍然被拒（第二道闸）  拦截层：execute
    只有主对话能把人工介入请求转告给用户，当前调用方是「编写」。
    原因：**用户的对话框只在主对话里** —— 执行/顾问角色根本没有对用户说话的通道。

✓ ③越权③b′ 绕过守门直接打 execute：记答复仍然被拒（第二道闸） 拦截层：execute
    只有主对话能记录用户的答复，当前调用方是「测试」。
    原因：用户的答复只会出现在主对话的对话框里；别的角色声称"用户说可以"是无源之言。

✓ ③越权③c 测试角色想直接推 human_reply 恢复状态      拦截层：guard
    [pipeline] 角色越权被拦下。工具：pipeline_transition
    允许角色：main / human      当前角色：tester

✓ ③越权③d 主对话发起人工介入请求（反向越权）        拦截层：guard
    [pipeline] 主对话不能发起人工介入请求。
    原因：用户的对话框**就在主对话里** —— 你要问用户，直接在会话里问就行了，
    不需要走"发起请求 → 自己转告 → 等自己答复"这一圈。

✓ ③越权③d′ 绕过守门直接打 execute：主对话发起也被拒（第二道闸） 拦截层：execute
    主对话不发起人工介入请求 —— 你就在用户的对话框里，要问直接问。

✓ ③越权③e 主对话用 handoff 通道产出 human_request    拦截层：guard
    [pipeline] 角色越权被拦下（交接物方向）。
    交接物：human_request
    允许产出该交接物的角色：orchestrator / architect / security / writer / tester / reviewer / release / docs / performance / arbiter / human
    当前角色：main

✓ ③越权：以上五次尝试之后，请求仍未被解决
    state=awaiting_human status=pending
```

### 反例④ 请求体让用户看代码（6/6）

```
✓ ④看代码④a 缺 question_for_human               拦截层：execute
    交接物「human_request」（人工介入请求）字段校验不通过：
    - 缺少必填字段「question_for_human」（★ 给用户看的人话问题（不含代码、不含补丁、必须是个问句））

✓ ④看代码④b question_for_human 里塞了 diff       拦截层：execute
    - 字段「question_for_human」里混进了代码（含 diff 头（diff --git））。
    这个字段是**给用户看的人话** —— 主对话不读代码、也转告不了代码。
    请把它改写成纯中文/纯英文的说明；需要保留技术细节就放到别的字段里，或者交给主对话的 pipeline_status 脱敏摘要去呈现。

✓ ④看代码④c question_for_human 里出现代码文件路径  拦截层：execute
    - 字段「question_for_human」里混进了代码（含带代码扩展名的文件路径）。

✓ ④看代码④d 不是在问问题（没有问号）              拦截层：execute
    - 字段「question_for_human」里没有问号 —— 用户看完不知道该回答什么。
    请把要问的事写成一个明确的问句（是/否、选哪个、还是给一段说明）。

✓ ④看代码④e 问题长到不像给人看的                  拦截层：execute
    - 字段「question_for_human」1008 字符，超过 600 上限 —— 给用户看的内容要短到能一眼读完

✓ ④看代码：五次尝试都没有创建出请求
    human_requests=0 state=testing
```

### 补充用例（5/5）

```
✓ 补充：非阻塞请求也能提交（不打断流程）
✓ 补充：非阻塞请求**不改变任务状态**       state=testing blocking=false state_at_request=testing
✓ 补充：非阻塞请求的答复正常记录（状态不变）
✓ 补充：同一条请求不能重复答复             → 已经答复过了
✓ 补充：没有声明截止时间时，"超时"路径被拒（否则就是绕过用户的后门）
    请求 HR-... 没有声明截止时间（timeout_at 为空，且配置 humanRequestTimeoutHours=0）。
    没有截止时间就不存在"超时"这回事 —— 让它按超时处理等于开一个绕过用户答复的后门。
```

## 9.5 老自测是否仍全过

**是。一处没坏。** 唯一被改动的是断言里的**工具数量**（14 → 17），
那是新功能的必然结果，不是行为回归。核心 67 项（正例全流程 + 10 组反例 + 分档）**一字未改**。

```
#  dsh-pipeline 自测汇总：210/210 通过
总计：67/67 通过     ← selftest（正例 + 10 组反例 + 分档）   ← 与本次修正前完全相同
总计：21/21 通过     ← 装载冒烟（其中 6 条断言工具数 14→17）
总计：38/38 通过     ← 功能开关
总计：23/23 通过     ← 客户端半边
总计：44/44 通过     ← ★人工介入链路（本轮新增）
```

## 9.6 哪些是实测、哪些是按源码推断

### 实测（有可复现的自动化断言）

| # | 结论 | 证据 |
|---|---|---|
| 1 | 四步链路走通：发起 → 状态进 `awaiting_human` → 转告 → 记答复 → 恢复到 `testing` | human-check 正例 7/7 |
| 2 | 四步都在 `audit.jsonl` 里，且答复行含用户原话+归属、恢复行含 `based_on` | human-check 留痕 4/4 |
| 3 | 请求原件落盘为不可变的 `handoffs/NNN-human_request.json` | 同上 |
| 4 | 次序闸 / 来源闸 / 形状闸 / 状态闸 四道都真的会拒 | human-check 反例①② |
| 5 | 非 main 角色的三处越权在**守门层与 execute 层各被拒一次** | human-check 反例③（含 `callToolRaw` 绕过守门直打 execute） |
| 6 | 主对话发起请求、以及用 `handoff` 通道产出 `human_request`，均被拒 | human-check 反例③d/③e |
| 7 | 含代码 / 无问号 / 超长 / 缺字段的请求体都在**提交时**被拒 | human-check 反例④ |
| 8 | 非阻塞请求不改变状态；重复答复被拒；无截止时间的"超时"被拒 | human-check 补充 5/5 |
| 9 | 恢复后发起角色能继续把活干完（tester 交审核成功） | human-check 闭环 1/1 |
| 10 | 修复了一个**真死结**：`awaiting_human → awaiting_human` 覆盖 `previous_state` | 见 9.2「两条防死结的规则」 |
| 11 | 17 个工具定义通过**真** `defineTool` 编译器 | schema-check |

### 按源码推断 / 未验

| # | 事项 | 说明 |
|---|---|---|
| 1 | **真实模型会不会照做** | 全部自测都是脚本化的假会话。真实 LLM 在拿到 `pipeline_human_relay` 的返回后，会不会老实去问用户、会不会老实抄答复 —— **只能装上去观察** |
| 2 | **拦不住铁了心伪造的主对话** | 见 README「防伪：能保证什么、不能保证什么」。四道闸把门槛抬高了，但主对话本身也是 LLM，编一句"用户说可以"在当下拦不住。可保证的是：**编造会留下可被用户本人核对的记录**，且角色/状态两条路都堵死 |
| 3 | **`detectCodeInHumanText` 的误伤率** | 高精度标记（宁可漏判）。未验证的边界：贴一段 SQL 报错栈、或贴一段 YAML 配置会不会被拦（前者会，后者部分会）。要放宽就改 `lib/handoff.js` 里那 7 条正则 |
| 4 | **`state_at_request` 在"多请求并发"下的语义** | 已测：同一任务第二个 blocking 请求会继承第一个的恢复目标。**没测**：两个请求来自不同角色、且第一个答复后又来第三个的混合序列 |
| 5 | **超时策略的实际触发** | 插件**没有调度器**，不会到点自己动作。`answer_source=timeout` 是"由主对话显式声明超时到了"，不是自动的。要不要真的加定时器，是需要你拍的产品决定 |

## 9.7 不确定项 / 需要你拍板的

1. **超时要自动吗？** 现在 `timeout_behavior` 是**事前声明的策略**，到期不会自己动作，
   要主对话显式调 `pipeline_human_reply { answer_source: "timeout" }`。
   要真自动就得给插件加一个调度器（目前刻意没有 —— 少一个服务依赖少一种装不上的方式）。
2. **`requireHumanConfirmCode` 要不要默认开？** 现在默认 **false**（方便）。
   开了之后每次都要用户抄一枚 `HC-xxxx` 码 —— 防伪强一档，但啰嗦。
   这是个纯粹的取舍，等你定。
3. **`question_for_human` 的 600 字符上限合适吗？** 有复杂决策可能一段说不完。
   可以调 `lib/handoff.js` 的 `HUMAN_TEXT_MAX`。
4. **要不要给用户一个"回带码"的输入框？** 现在确认码只是文本，用户得手动抄；
   如果要做成客户端 UI 上的一键确认，那是 `lib/client.js` 的下一个增量
   （现有开关按钮那套插槽机制可以直接复用）。
5. **多个 blocking 请求并发**时，是否需要"一次全转告"？
   现在 `pipeline_human_relay` 不带 `request_id` 会列出全部，但一次只转告一条。

---

# 十、设计增量：架构图角色 + 编写 1~3 席位

> 第三轮追加需求，用户原话：
> **「给多ai协调插件加上写完后提交架构图的ai，并且编程主体ai能1~3个分工各写一部分而不是放给一个ai」**
>
> 这一节记两件事的实现取舍：**A. 架构图角色**（写完之后交图，图必须可追溯）
> 与 **B. 编写主体可 1~3 个分工**。

## 10.1 新增 / 改动的文件与契约

| 文件 | 改动 | 契约 |
|---|---|---|
| `lib/roles.js` | 改 | 新增角色 `diagrammer`（中文「架构图」，`kind:'execution'`，`writes:'reports'`，`handoffKinds:['architecture_diagram','human_request']`）；新增 `MAX_WRITER_SEATS=3` / `seatId()` / `SEAT_PATTERN` |
| `lib/tiers.js` | 改 | 每档新增 `max_writers`（L0/L1=1，L2~L5=3）；`L2~L5` 的 `execution[]` 纳入 `diagrammer`（总数 7/8/9/11）；`buildRoster` 接受 `writers` 并产出 `roster.writers`；新增 `buildWriters()` / `seatOwningPath()` / `recommendWriters()`；`validateRoster` 校验席位 |
| `lib/handoff.js` | 改 | 新增交接物 `architecture_diagram`（12 字段）；`dev_to_test` 新增 `partition` 字段；`object[]` 已在上一轮支持 |
| `lib/tokens.js` | 改 | 令牌记录新增 `seat`；`mint({seat})`、`roleOfAgent` 回传 `seat`、新增 `findSeat()` |
| `lib/store.js` | 改 | 任务新增 `writer_submissions{}`；新增 `checkSeatOwnership()` / `checkDiagramDelivery()` / `writerSeatsOf()` / `seatPartitionOf()` / `checkAllSeatsSubmitted()`；`checkHandoffAgainstState` 加 `architecture_diagram` 时序闸；`close` 换成组合闸 `close_gates`（`review_ok_exists` + `diagram_delivered`）；进 `developing` 时清空席位表；`status` 加 `writers` / `architecture_diagram` 两块视图 |
| `lib/guard.js` | 改 | 新增 **2b) 编写席位分区边界** 判据；`makeTaskIndexEntry` 收 `writers`；新增 `owningSeat()` / `normScopePath()`；`HANDOFF_DIRECTION` 加 `architecture_diagram` |
| `lib/transport/index.js` | 改 | `spawnRole({seat})` 把席位带进令牌；派活单里显示席位 |
| `lib/tools.js` | 改 | `pipeline_orchestrate` 加 `writers` 参数、摘要列出席位与范围；`pipeline_dispatch` 加 `seat` 参数 + 在册校验；`resolveActor` 回传 `seat`；`pipeline_handoff` 传 `actorSeat` |
| `tests/writers-check.mjs` | **新增** | 39 项：正例①count=1 / 正例②count=3 全流程 / 五类反例 / 回执闸 / 关单闸 |
| `tests/writers-check-last-run.txt` | **新增** | 本套完整原始输出 |
| `tests/selftest-core.mjs` | 改 | ① 分档期望数 6/7/8 → 7/8/9；② **harness 的 `indexTask` 补上 `writers`**（见 10.7 的坑） |
| `tests/run-all.mjs` | 改 | 六套 → **七套** |

**工具面没有增加**，仍是 17 个。本轮新增的全是**角色 / 交接物 / 席位 / 守门**。
（`pipeline_orchestrate` 与 `pipeline_dispatch` 各多了一个参数。）

## 10.2 `writers` 结构

```jsonc
// roster.writers（由编排产出，落在 task.json 里）
{
  "count": 3,
  "partitions": [
    { "seat": "writer#1", "role_id": "writer", "index": 1, "total": 3,
      "scope_paths": ["src/web"], "interface_owner": "writer#1", "deliverables": ["前端页面"] },
    { "seat": "writer#2", "role_id": "writer", "index": 2, "total": 3,
      "scope_paths": ["src/api"], "interface_owner": "writer#1", "deliverables": ["后端接口"] },
    { "seat": "writer#3", "role_id": "writer", "index": 3, "total": 3,
      "scope_paths": ["docs"],    "interface_owner": "writer#1", "deliverables": ["文档"] }
  ],
  "reason": "接口契约已冻结，三块互不相干，可并行推进",
  "decided_by": "orchestrator",
  "max_writers": 3
}
```

`seat` 是**席位 id**，不是角色 id —— 角色仍然是 `writer`。
这样既有的角色白名单、交接物方向表、状态机**一行都不用改**。
`role_id` 字段保留着，是为了让"席位属于哪个角色"这件事显式写在数据里（而不是靠字符串前缀猜）。

**席位与令牌**：每个席位 `pipeline_dispatch` 时铸一枚独立令牌（`tokens.mint({role:'writer', seat:'writer#2'})`），
令牌↔会话的绑定不变，所以"拿 writer#1 的令牌交 writer#2 的分区"能被机械识别。

## 10.3 ★ 汇总与推进：为什么选"全部到齐"，不选"主编写席位汇总"

需求给了二选一。**我选"全部席位到齐才推进"**，理由三条：

1. **"主编写席位"会引入一个隐藏的等级**。编排划界时并没有这个角色。
   凭空冒出来就等于在席位之间加了一层**没人审计过的从属关系** ——
   "谁是主"这件事一旦成为惯例，下一次就会有人说"我是主编写，我说了算"。
2. **汇总那一步本身不可审计**。合并 N 份报告时丢了什么、改了什么都看不出来。
   而测试与审核**直接看 N 份分区报告**，恰好能看清"谁改了什么、边界在哪"。
3. **接缝问题会被汇总掩盖**。三份报告并排看，接缝处（前端调后端的那个接口）谁负责一目了然；
   汇总成一份之后，接缝恰好是最容易被写没的那部分 —— 而接缝正是多席位协作最容易出问题的地方。

代价：测试要读 N 份而不是 1 份。这个代价我认 —— 分区本来就是给"看清边界"用的，
把它合成一份等于把分区的信息量抹掉。

**实现上是"先收后推"**（这一点很关键）：

- 席位提前交齐之前，交接物**照收、照留痕**，但状态**一动不动**
- 最后一个席位交完时由**它**触发推进

第一版曾经想过"不齐就拒"，但那样会把先干完的席位的成果退回去 —— 那是坏行为。
现在这样：先干完的不会被罚，只等最后一个。

实测输出（正例②）：

```
✓ 正例② writer#1 交第一份（席位 1/3）
    交接物已提交：H-8d4d2af1278c1af6（编写交付给测试，编写 → tester）。
    本席位「writer#1」已交（1/3）。还差：writer#2、writer#3 —— 全部到齐前不会推进到「待测试」。
    （席位未到齐：这份交接物已收下并留痕，但状态先不动 —— 等最后一个席位交完自动推进。）
    任务当前状态：开发中。
✓ 正例② 交第一份之后状态**不动**（仍在开发中）—— 先干完的先交，不会被退回去
    state=developing
...
✓ 正例② writer#3 交第三份 → 全部到齐 → 自动推进到「待测试」
    交接物已提交：H-a4bd7b92abf88d1a（编写交付给测试，编写 → tester）。
    任务状态：开发中 → 待测试。
```

## 10.4 ★ count 上限怎么来

三个约束叠加：

1. **需求硬上限**：`MAX_WRITER_SEATS = 3`（用户明说 1~3）。
2. **档位上限**：`TIERS[tier].maxWriters`。

| 档位 | maxWriters | 理由 |
|---|---|---|
| L0 | 1 | 单文件/单函数级。拆开后沟通成本 > 改动本身 |
| L1 | 1 | 一块活，接口还没到需要冻结的复杂度 |
| L2 | 3 | 跨模块/跨服务 —— 拆分真正开始划算 |
| L3/L4/L5 | 3 | 复杂度上去了，但"几个模块"这个事实没变 |

3. **规则引擎建议**：`recommendWriters()` 在 1..max 之间给**建议**。

**为什么 L0/L1 死死卡在 1**：拆分的**前提是接口已冻结**。
L0/L1 的需求本来就没复杂到需要冻结接口，硬拆只会让两个席位在同一个概念上各写一半，然后互相改 ——
**比一个人写还慢**。这条"前提条件"在引擎里给了最高权重（3），
没有它时无论命中多少弱信号都建议 1。

**为什么上限是 3 而不是更多**：超过 3 之后，席位之间的接口对齐成本增长快过并行收益；
而且真实需求里"三块互不相干"已经很罕见，第四块通常是第一块的延伸。

**最终仍由编排判断**（规则引擎只给建议，理由写进 `writers.reason`，`count>1` 时必填）。
这是刻意保留的人工判断位 —— "两块活是不是真的互不相干""接口冻没冻"这类事，数关键词数不出来。

## 10.5 ★ 新角色在流程中的位置与降级路径

### 位置：**编写完成之后**，与测试并行，关单之前

```
编排 → 架构（编写前）→ 编写(1~3 席位) → ┬→ 架构图（编写后）→ ┬→ 测试 → 审核 → 关单
                                        └───────────────────┘
```

时序由**两道闸**保证（都在 `submitHandoff` 里执法）：

1. **状态闸**：`architecture_diagram` 只允许在 `ready_test / testing / ready_review / reviewing / passed` 提交
2. **产物闸**：必须已存在至少一份 `dev_to_test`

第二道是必要的 —— 光看状态不够，"待测试"也可能是被回退回来的，那时同样没有新产物。

**与 `architect` 的区别**（这是最容易混的一处，所以写进了角色表的注释与 README）：

| | `architect` | `diagrammer` |
|---|---|---|
| 时机 | 编写**之前** | 编写**之后** |
| 产物 | 文字方案 `design` | **图** `architecture_diagram` |
| 性质 | 输入约束 | **交付物** |

### 降级路径

```
架构图角色要交图
   │
   ├─ diagram_deliver 可用？ ── 是 ──► 调它（normify 校验 → 映射闸门 → archify 四道门 → 收据）
   │                                      │
   │                                      └─► 交接物填 produced_by=diagram_deliver + receipt_path + html_sha256
   │                                          ★ 本插件**校验收据文件真实存在**、哈希对得上 → 否则拒
   │
   └─ 不可用（未装/被禁用）──► produced_by=self-provided + degraded=true + degraded_reason
                                ★ 不标 degraded 会被拒（"必须明确标出来"）
```

**关键设计：本插件不替架构图角色调 `diagram_deliver`。**
理由是跨插件耦合能少则少 —— 别人插件的工具可能有版本差异、可能被禁用、参数可能变。
本插件的职责是**验收**："你说你走过闸门，把收据拿来。" 这比"我替你走"更稳，也更符合职责划分。

## 10.6 实测：五条守门的原始拒绝原文 + 两个正例

命令：

```powershell
cd dsh-pipeline
node tests\writers-check.mjs
```

完整输出：[`tests/writers-check-last-run.txt`](tests/writers-check-last-run.txt)。

### 正例①：count=1 是同一套机制的退化情形

```
【正例① count=1（退化情形：既有 happy path 一行没改）】3/3 通过

✓ 正例① count=1：清单里仍然有 writers（不是"单编写模式"的特殊分支）
    writers = {"count":1,"partitions":[{"seat":"writer#1","role_id":"writer","index":1,"total":1,
               "scope_paths":["."],"interface_owner":"","deliverables":[]}],
               "reason":"","decided_by":"orchestrator","max_writers":1}

✓ 正例① count=1：唯一席位的范围是整棵项目根，且它确实交过
    scope_paths=["."]  writer_submissions=["writer#1"]

✓ 正例① count=1：全流程照旧走完（关单成功）
    最终状态 = closed
```

**这三条就是"没有把老行为改坏"的证据**：`count=1` 走的就是原来的 happy path，
分区表里有一条 `scope_paths:["."]`，守门的越界判据恒真，全流程一字未改。

### 正例②：count=3 全流程（19/19）

```
✓ 正例② 夹具：3 个席位各持独立令牌与独立会话
    seats=writer#1, writer#2, writer#3
    agents=writer#1=fake-agent-004  writer#2=fake-agent-005  writer#3=fake-agent-006

✓ 正例② 编排给出了 3 席位的分区方案（带 reason）
    角色清单已产出（judged_by=orchestrator）。
    档位：L2（中大型） —— 跨模块/跨服务、需要架构决策、接口契约要冻结、迁移或兼容性要求。
    需要几个独立对话：7 个
    编写席位：3 个（本档上限 3）
      · writer#1 → src/web（前端页面）
      · writer#2 → src/api（后端接口）
      · writer#3 → docs（文档）
      为什么这么分：接口契约已冻结，三块互不相干，可并行推进
      对话：主对话 / 需求分析/编排判断 / 架构/技术方案 / 编写 / 测试 / 审核 / 架构图
      执行角色：architect / writer / tester / reviewer / diagrammer
    调用顺序：orchestrator → architect → writer → tester → reviewer → diagrammer
```

随后：三个席位各登记制品 v1/v2/v3 → 各交一份 `dev_to_test`（状态在前两份时不动、第三份时推进）
→ 架构图角色交图（带收据）→ 测试 → 审核 OK → 关单成功。

### 反例①：`writer#k` 越界写别人的分区

```
✓ 反例① writer#2 往 writer#1 的 src/web 里写            拦截层：guard
    [pipeline] 拒绝：越界写入别人的分区。
    工具：write
    目标：…/src/web/steal.js
    你是：writer#2（范围：src/api）
    该路径属于：writer#1（范围：src/web，命中「src/web」）
    原因：编排把编写拆成了多个席位，各自范围**互不重叠** —— 那正是分区的意义。
    如果你认为某处应该由你改，请让编排复核后重新划界（pipeline_roster_request → pipeline_roster_review），不要直接动手。

✓ 反例① writer#1 往**分区之外**（scripts/）写          拦截层：guard
    [pipeline] 拒绝：写入位置不在任何编写席位的分区里。
    工具：write
    目标：…/scripts/x.sh
    你是：writer#1
    在册分区：
      · writer#1：src/web
      · writer#2：src/api
      · writer#3：docs
    原因：编写已被拆成多个席位，每个人只写自己那一段 —— 写到分区外等于越过了编排划的界。
    要改范围请走 pipeline_roster_request（提出）→ pipeline_roster_review（编排复核），主对话与你自己都不能改分区。

✓ 反例① 对照：writer#1 写自己的 src/web 是**放行**的（守门不是一刀切）
    layer=passed
```

**注意最后那条对照**：守门不是"凡 writer 写文件就拒"，是**按归属判**。
只测拒绝不测放行，就分不清"判据生效"和"一刀切"。

### 反例②：席位不匹配的令牌

```
✓ 反例② 拿 writer#1 的令牌去交 writer#2 的分区        拦截层：execute
    席位不匹配：你这枚令牌属于「writer#1」，但这份交接物声明的是「writer#2」。
    你的范围：src/web
    对方范围：src/api
    ★ 只能提交自己那一份。要交别人的分区，得先让编排把席位重新分配（roster_request → roster_review）。

✓ 反例②′ 绕过守门直接打 execute：席位不匹配仍然被拒（第二道闸）  拦截层：execute
    （同上原文）
```

### 反例③：未到齐就推进

```
✓ 反例③ 3 个席位只交 2 份就硬推「待测试」              拦截层：execute
    编写席位未到齐：本任务在册 3 个席位，已交 2 个（writer#1、writer#2），还差 1 个（writer#3）。
    规矩：**全部席位各交一份 dev_to_test 之后**才能推进到「待测试」。
    为什么不是"由主编写席位汇总成一份"：汇总会引入一个隐藏的等级（谁是主？谁定的？），
    而且汇总那一步本身不可审计 —— 测试与审核直接看 N 份分区报告反而更清楚谁改了什么。
    如果某个席位确实交不了（例如它那块被取消），走 pipeline_roster_request 让编排复核后改分区，而不是在这里硬推。

✓ 反例③ 任务仍在开发中，没有被推过去
    state=developing
```

### 反例④：架构图角色在编写完成前交图

```
✓ 反例④ 编写还没交（state=developing）就交架构图        拦截层：execute
    跳步：交接物「architecture_diagram」只能在这些状态下提交 —— 待测试(ready_test) / 测试中(testing) /
    待审核(ready_review) / 审核中(reviewing) / 已通过(passed)；任务 T-20261011-49d02d 当前是「开发中(developing)」。
    ★ 架构图必须在**编写完成之后**交。现在还在「开发中」—— 先让编写交 dev_to_test。
```

### 反例⑤：主对话自行决定 `writers.count` / 自行加席位

```
✓ 反例⑤a 主对话自己调 pipeline_orchestrate 决定分几个     拦截层：execute
    拒绝：主对话不能自己产出角色清单。
    规则引擎建议档位：L1（普通功能）
      · L0 被否：命中不平凡信号：涉及接口/网络边界；涉及对外文档
    规则引擎判的是 L1，不是 L0 —— 这个需求需要**独立的编排判断对话**。
    下一步：pipeline_dispatch role=orchestrator，把需求交给它做编排判断。
    ★ 主对话不自行判断需要几个 AI，只按判断结果去调用和跟踪。

✓ 反例⑤b 主对话派一个不在册的席位（自行加席位）          拦截层：execute
    拒绝派活：席位「writer#2」不在本任务在册的编写席位里。
    在册席位：writer#1（各席位范围：
      · writer#1：src/web）
    ★ 主对话不能自行加席位、也不能改分区 —— 编写怎么分是**编排判断**的产物。
    要加/改席位：让执行角色走 pipeline_roster_request 提出，再由编排 pipeline_roster_review 复核。

✓ 反例⑤c 声明一个编排没批的席位（在册只有 writer#1）     拦截层：execute
    席位「writer#2」不在本任务的在册编写席位里（在册：writer#1）。
    编写席位是**编排判断**的产物，不是自己声明的。要加席位必须走 pipeline_roster_request → pipeline_roster_review 复核。
```

### 附带：架构图回执闸（3/3）

```
✓ 反例⑥ 声称走过 diagram_deliver，但收据文件不存在
    produced_by=diagram_deliver，但收据文件不存在：…\nope.json
    ★ diagram_deliver 的价值就在那份**交付收据**（含被引用模块的 id 与 fingerprint、
    规格文件 sha256、产物 sha256、所用命令与版本）。没有收据，事后就答不出
    "这张图基于哪一版结构数据、当时校验过没有"。
    两条出路：① 真的调一次 diagram_deliver，把它返回的 receipt_path 填进来；
    ② 如果 dsh-archigate 没装/被禁用，把 produced_by 改成 self-provided 并标 degraded=true + 原因。

✓ 反例⑦ 自备产物却不标 degraded（想蒙混过关）
    produced_by=self-provided 时 degraded 必须是 true。
    ★ 这条是刻意的：没走 diagram_deliver 就没有闸门、没有收据，那必须在交接物上**明确标出来**，
    不能让下游（测试/审核/主对话）误以为这张图过了 normify 校验与组件映射闸门。

✓ 对照：降级路径**可以走通**，但交接物上明确标了 degraded + 原因
```

### 关单闸（2/2）

```
✓ 关单闸 夹具：测试与审核都顺利走完（否则下面的拒绝理由会跑偏）
✓ 关单闸：角色清单里有架构图角色，但一张图都没交 → 拒绝关单
    拒绝关单：本任务的角色清单里有「架构图」角色（diagrammer），但没有任何 architecture_diagram 交接物。
    ★ 它在本任务里是**交付物之一**，不是可选项 —— 清单里派了它，就得交。
    要么让架构图角色交图（走 diagram_deliver 拿收据，或降级并标 degraded=true），
    要么让编排复核后把该角色从清单里去掉（roster_request → roster_review）。
```

## 10.7 210 项老自测是否仍全过

**是。** 唯一改动的是三处分档**计数**期望（L2 6→7、L3 7→8、L4 8→9，因为 L2+ 多了架构图角色），
那是新功能的必然结果，不是行为回归。

```
#  dsh-pipeline 自测汇总：249/249 通过
总计：67/67 通过     ← selftest（正例全流程 + 10 组反例 + 分档）
总计：21/21 通过     ← 装载冒烟
总计：38/38 通过     ← 功能开关
总计：23/23 通过     ← 客户端半边
总计：44/44 通过     ← 人工介入链路
总计：39/39 通过     ← ★编写席位 + 架构图（本轮新增）
```

### ⚠ 本轮自测自身逮到的一个"假绿"

写这批用例时发现：**测试 harness 的 `indexTask` 漏传了 `writers`**，
于是「编写席位越界写别人的分区」那条守门**根本没被跑到**，
而当时所有断言都是绿的 —— 因为 `task.writers` 是 `undefined`，守门直接跳过了整个判据。

这是**假绿**：比红灯危险得多。修法是让 harness 的 `indexTask` 与 `index.js` 的真实实现保持一致
（两边都传 `writers`），并**加一条对照用例**（"写自己的范围应当放行"）——
只测拒绝不测放行，就分不出"判据生效"和"判据被跳过"。

现在 harness 那行注释里直接写着这件事，免得后人再踩。

## 10.8 图里该新增 / 改动的节点与边（给画图的会话）

> 用户当前看的那张流程图需要跟着更新。这里只列**节点 id + 中文标签**与边的变化，不用本会话去画。

### 新增节点

| 节点 id | 中文标签 | 放在哪层 | 备注 |
|---|---|---|---|
| `diagrammer` | **架构图** | L4 角色层 | 与 `architect` **分开两个节点** |
| `writer_1` | 编写 · 席位 1（`writer#1`） | L4 角色层 | 范围标在节点旁：`src/web` |
| `writer_2` | 编写 · 席位 2（`writer#2`） | L4 角色层 | `src/api` |
| `writer_3` | 编写 · 席位 3（`writer#3`） | L4 角色层 | `docs` |
| `seats_gate` | **全部席位到齐**（合流点） | L4/L3 之间 | ★ 三个编写的所有出边**先汇到这里** |
| `diagram_receipt` | **交付收据**（`diagram_deliver` 的产物） | 制品层 | 挂 `diagrammer → architecture_diagram` 那条边上 |
| `m_seats` | 编写席位机制 | L2 机制层 | `buildWriters` / 分区不重叠校验 |

### 要改的节点

| 节点 id | 原来 | 改成 |
|---|---|---|
| `writer` | 「编写」一个节点 | 只在 **L0/L1** 保留单节点形态；**L2+ 展开成 `writer_1/2/3`**（`count=1` 时就是 `writer_1` 一个） |
| `m_states` | 状态机 | 不变（本轮**没有新增状态** —— "等人"那个状态是上一轮的） |
| 图例 | —— | 加一句「编写席位之间**没有边**」 |

### 新增边

| from → to | 中文标签 | 类型 |
|---|---|---|
| `orchestrator` → `writer_1/2/3` | **定分几块 + 各写哪段**（带 `reason`） | call |
| `main` → `writer_1/2/3` | 逐席位派活（各给独立令牌） | call |
| `writer_1/2/3` → `seats_gate` | 各交一份 `dev_to_test` | dataflow |
| `seats_gate` → `tester` | **全部到齐 → 才进「待测试」** | event |
| `writer_1/2/3` → `workdir` | 各自只写 `scope_paths` | dataflow |
| `diagrammer` → `diagram_receipt` | 优先走 `diagram_deliver` | call |
| `diagram_receipt` → `main`/`reviewer` | `architecture_diagram`（**带收据**） | dataflow |
| `diagrammer` → `main`/`reviewer` | `architecture_diagram`（**degraded=true**） | dataflow（虚线，标注"降级"） |
| `diagrammer` → `workdir` | 越界写别人的分区 | **红色虚线** ✗ |
| `main` → `orchestrator` | 主对话自己定 `count` | **红色虚线** ✗ |
| `main` → `close` | 清单有 `diagrammer` 却没交图 | **红色虚线** ✗ |
| `seats_gate` → `tester` | 未到齐就推「待测试」 | **红色虚线** ✗ |

### 明确**不该**画的边

1. `writer_1 ↔ writer_2 ↔ writer_3` —— **三个席位之间没有边**。它们不直接通信，接缝由编排划界。
2. `diagrammer → writer*` —— 架构图角色**不改代码**（`writes: 'reports'`）。
3. `diagrammer → user` —— 与所有执行角色一样，**没有到用户的边**（人工介入手册那条约束）。

### 配色建议

| 元素 | 建议 |
|---|---|
| 三个编写席位 | 同色系不同深浅（同角色不同实例） |
| `seats_gate` | 用**粗边框的菱形/闸门**形状 —— 它是这条流程里最重要的一个合流点 |
| 架构图两条路径 | 带收据 = 实线蓝；降级 = **虚线橙**（视觉上一眼能分辨"走过闸门"与"没走"） |
| 新增的拒绝边 | 与既有反例统一用**红色虚线** |

## 10.9 不确定项

1. **多席位时"当前制品版本"的语义**（见 README 的"一个已知的简化"）：
   三个席位各登记一个版本，`currentArtifactVersion` 返回最后一个。
   实际影响很小，但严格说应该"一轮一个版本号"。要不要引入 round 概念 —— 由你定。
2. **`scope_paths` 目前是前缀匹配**，不是 glob。`src/*.js` 这种写法**不会**被当成通配符，
   而是当成字面路径（因此基本匹配不到东西 → 会变成"分区外"）。
   要支持 glob 得改 `normScopePath`，并在重叠判据里一起改。**目前没做，也没测**。
3. **席位数量与测试/审核的工作量**：3 个席位 = 测试要读 3 份报告。
   理论上测试可以通过 `writers.partitions` 自动知道要验几块，但**目前测试角色拿到的是
   3 份独立的 `dev_to_test`**，它自己得看懂。要不要在 `pipeline_status` 里再给测试一个
   "本轮你有 N 份待验"的提示 —— 可以加，但还没加。
4. **架构图角色的 `covered_modules` 与实际渲染内容的对应关系没验证**。
   本插件只检查"收据存在 + 哈希对得上"，**不检查**"收据里说的模块和 `covered_modules` 是不是一回事"。
   要真做需要解析收据 JSON。目前依赖收据本身的可信度。
5. **`diagram_deliver` 的真实调用未经本插件路径验证**。
   自测里用的是**手写的假收据文件**（验的是"收据必须存在 + 哈希要核对"这套判据），
   **没有真的跑过一次 `diagram_deliver`**（那需要一套完整的 normify 结构数据 + archify 规格）。
   装机后第一次真跑时，如果 `diagram_deliver` 的返回字段名与 `html_path`/`html_sha256`/`receipt_path`
   不一致，架构图角色会填错字段 —— 那时看它的拒绝原文即可定位。
6. **gate 的位置**：`seats_gate` 目前实现在 `checkPrecondition('dev_to_test')` 里，
   由最后一个提交者的 `submitHandoff` 触发。如果最后一个席位提交后**进程崩了**，
   状态会停在 `developing`（交接物都在，只是没推进），主对话可以手工
   `pipeline_transition{event:'dev_submitted'}` 补一下 —— 但这条**没测**。

---

# 十一、设计增量：人工介入改成**两级升级梯**

> 第四轮追加需求，用户原话：
> **「追加编写等ai确定不了的问题先递交给需求分析，需求分析再确认不了递交主对话提交给人工审核」**
>
> 也就是：**执行角色遇到确定不了的问题，不能一步就去找用户** —— 必须先经过「需求分析/编排判断」这一级。

## 11.1 新增 / 改动的文件与契约

| 文件 | 改动 | 契约 |
|---|---|---|
| `lib/states.js` | 改 | 新增状态 `awaiting_clarification`（等待需求分析答复）；新增 `WAITING_STATES`（等待态集合）；新增 `ROLES_CAN_ASK_CLARIFICATION`（10 个执行/顾问角色）；两条新边 |
| `lib/roles.js` | 改 | 10 个执行/顾问角色加 `clarification_request`；`orchestrator` 加 `clarification_reply` |
| `lib/handoff.js` | 改 | 新增 `clarification_request`（10 字段）/ `clarification_reply`（7 字段）+ 两组跨字段校验；`human_request` 新增 `escalated_from` / `raised_by` / `orchestrator_reason`；**修了 `handoff_id` 的碰撞 bug**（见 11.7） |
| `lib/store.js` | 改 | 任务新增 `clarification_requests[]`；新增 `questionKeyOf` / `createClarificationEntry` / `findClarification` / `listClarifications` / `replyClarification` / `checkOrchestratorBoundary` / `checkHumanRequestChannel` / `checkClarificationPingPong`；`planAdvance` 支持两个新事件；**`transition()` 不再把等待态记进 `previous_state`**；`status` 加澄清视图与 `waiting` 字段 |
| `lib/guard.js` | 改 | `HANDOFF_DIRECTION` 加两条；`PIPELINE_TOOL_ROLES` 加两个工具角色 |
| `lib/tools.js` | 改 | 新增 2 个工具（**17 → 19**）；`pipeline_human_request` 加三个升级参数 |
| `lib/config.js` / `index.js` | 改 | 新增 `maxClarifyRounds`（默认 2） |
| `tests/ladder-check.mjs` | **新增** | 39 项：2 个正例 + 5 组反例 |
| `tests/ladder-check-last-run.txt` | **新增** | 本套完整原始输出 |
| `tests/load-smoke.mjs` / `schema-check.mjs` / `run-all.mjs` | 改 | 工具数 17 → 19；七套 → **八套** |

**上一轮（架构图 + 编写席位）已经做完并单独验收**（报告第十节，39 项自测）。
这一轮的产物是**独立的一套**（第十一节），两边没有互相污染：
`writers-check.mjs` 与 `ladder-check.mjs` 各自用独立的临时目录，跑完即删。

## 11.2 状态机：**分开**，不复用

**取舍：新增 `awaiting_clarification`，与 `awaiting_human` 并存。**

| | `awaiting_clarification` | `awaiting_human` |
|---|---|---|
| 在等谁 | **内部**某一级（需求分析） | **用户** |
| 主对话要不要动 | **不用** —— 用户不该被打扰 | 要转告、要催 |
| 谁来解 | `orchestrator` | `main` 记用户答复 |

**为什么不合**：合成一个之后，"这个任务到底在等谁"就答不出来了 ——
而那正是主对话最需要知道的事：它**要不要去惊动用户**？
`pipeline_status` 现在直接给出答案：

```json
"waiting": {
  "waiting_for": "orchestrator",
  "waiting_zh": "等需求分析裁定（还不用惊动用户）",
  "will_resume_to": "testing"
}
```

### ★ 恢复语义：回到**最初**被打断的那个工作状态

两条边都是 `to: '(previous)'`，沿用既有语义。但这里有个**必须处理的坑** ——
上一轮的 `awaiting_human` 就踩过一次（"永久卡死"），这次在写第一行代码时就绕开了。

`待测试 → 等需求分析 → 等用户` 这条链里，如果每跳都记 `previous_state`：

```
待测试 → awaiting_clarification   previous_state = 'testing'     ✓
awaiting_clarification → awaiting_human
                                  previous_state = 'awaiting_clarification'  ✗ 卡死
```

用户答复完 → "恢复"到 `awaiting_clarification` → 再等需求分析 → 那条请求已经是 `escalated`，
谁都不能裁定 → **永久卡死**。

**修法（通用规则，不是打补丁）**：

```js
// transition() 里
if (!WAITING_STATES.includes(from)) task.previous_state = from
```

**等待态不是"被打断的工作"，它只是路上的一站。** 规则是通用的，将来再加任何等待态都自动受益。
两处配合：`transition()` 不写、`createHumanRequestEntry` 读取时优先用 `previous_state`。

自测里专门有一条断言这条链：

```
state=awaiting_human
previous_state=testing  （应为 testing，**不是** awaiting_clarification）
human_requests[0].state_at_request=testing
```

同时保留了上一轮那两条防护（**已在的状态不迁** + 记录侧继承恢复目标），三条一起生效。

## 11.3 防踢皮球：**单向门** + **同一问题问不过两次**

需求给了两个选项（限次数 / 升级后只能由用户答复解决）。**我两个都做了**，因为单靠任一个都漏：

**① 单向门（结构性规则）** —— 一旦升级，那条澄清请求**不能再被需求分析改口裁定**：

```
澄清请求 CQ-… 已经**升级**给人工了（2026-…），不能再由需求分析裁定。
★ 这是刻意设计的**单向门**：一旦升级，就只剩用户答复这一条出路 ——
否则"先升级、再自己改口"会变成绕开用户的旁路，用户那边的待办也永远清不掉。
```

**② 同一问题最多问 2 次**（`maxClarifyRounds`，默认 2）：

```
防踢皮球：同一个问题已经问过 2 次（上限 2 次）。
上一次：CQ-…，状态 answered（verdict=answered）
★ 反复问同一件事说明它不是"需求层能定的" —— 那就该走升级路径，而不是在原地打转。
```

去重键 = `hash(task_id | from_role | 归一化(stage) | 归一化(question))`。
**换个问法就是新问题**（自测有对照用例：改成问"负数呢"仍然放行）——
闸是按**问题**封的，不是按角色封的。

**为什么两个都要**：

- 只有"限次数"：拖得住原地打转，但挡不住"先升级、再自己改口"那条旁路。
- 只有"单向门"：挡得住改口，但挡不住"反复问、每次都答、就是不升级"的软钉子 ——
  那种情况下任务一直在两级之间弹，用户永远收不到问题。

**为什么上限是 2 而不是 1**：允许"答了还是不明白，再确认一次"是合理的
（需求分析的第一次答复可能没说清）。第三次就是打转的信号了。

## 11.4 ★ L0 例外怎么判

**判据不是硬编码档位，而是读 roster 里**已有**的字段**：

```js
const mode = task.roster?.orchestrator_mode   // 'separate' | 'rule-engine'
```

| mode | 含义 | 行为 |
|---|---|---|
| `separate` | 有独立编排判断对话（L1~L5） | 执行角色**必须**先走第一级；直发 `human_request` → **拒** |
| `rule-engine` | 编排由确定性规则引擎承担（**L0**） | 没有那一级可走 ⇒ 直接发 `human_request` 是**合法**路径 ⇒ **放行** |

**为什么用这个判据而不是 `tier === 'L0'`**：`orchestrator_mode` 本来就已经表达了
"有没有一个独立的编排对话在"这件事 —— 而这正是例外成立的**真正理由**。
将来任何一档改成规则引擎编排（或反过来），例外**自动**跟着变，不需要再改一次守门。

自测反例②实测了同一个动作在两种 mode 下的不同结果：

```
✓ 反例② 夹具：这是一个 L0 任务，编排由规则引擎承担（没有独立编排对话）
    tier=L0  orchestrator_mode=rule-engine
✓ 反例② ★ L0 例外生效：没有独立编排对话时，直接发 human_request 被**放行**
✓ 反例② L0 下确实推进到了「等待人工答复」
```

## 11.5 需求分析的边界（"不能代表用户拍板"）

三道判据，两道机械、一道软性：

| # | 判据 | 力度 |
|---|---|---|
| 1 | `cannot_answer` 必须给 `reason`，拒绝文案里直接列出**合法/非法理由** | 硬拦 |
| 2 | 升级只能挂"**已被裁定为答不了**"的请求（`ESCALATION_SOURCE_NOT_DECLINED`） | 硬拦 |
| 3 | 答复里出现实现层措辞（用哪个库、怎么写…）→ 记 `boundary_warning` 进审计 | **不阻断** |

**第 3 条为什么是警告而不是拒绝**：需求层与实现层之间本来就有灰色地带
（"这个字段该不该存在于对外契约里"既是需求也是实现）。
硬拦会误伤正常的裁定。但**看得见**比拦得住更重要 —— 所以写进审计行，
`pipeline_clarify_reply` 的返回里也会带一句 ⚠ 提示。

## 11.6 实测：两个正例 + 五组反例

命令：

```powershell
cd dsh-pipeline
node tests\ladder-check.mjs
```

完整输出：[`tests/ladder-check-last-run.txt`](tests/ladder-check-last-run.txt)。

### 正例①：需求分析**直接裁定** —— 全程没有惊动用户（8/8）

```
✓ 正例① 夹具：L2，有独立的需求分析/编排判断对话
    orchestrator_mode=separate  档位=L2

✓ 正例① 测试角色向上提问（第一级）
    交接物已提交：H-688d8e7a8a0f630d（请求需求分析裁定，测试 → orchestrator）。
    任务状态：开发中 → 等待需求分析答复。
    澄清请求已登记：CQ-62720dcd28c4e339　当前状态：等待需求分析答复　（这是第 1 次问这个问题）
    ★ 你**没有**惊动用户 —— 这一级就是为此存在的。

✓ 正例① 状态进入「等待需求分析答复」，并记下被打断前的状态
    state=awaiting_clarification  state_at_request=developing  （原状态 developing）

✓ 正例① 需求分析直接裁定（answered）
    已裁定：CQ-62720dcd28c4e339（需求分析直接答复）
    发起角色：tester　卡在哪：测试：边界值判定
    结论：按「报错」—— 验收标准里"非法输入必须显式失败"那条优先于"返回空结果"。
    依据：两条验收标准冲突时，"显式失败"是更严的一条，取严。
    新增/收紧的约束：参数为 0 视为非法输入，必须报错
    任务状态：等待需求分析答复 → 开发中
    留痕（audit.jsonl）：
      ① 提问  clarify:request  CQ-62720dcd28c4e339  by tester
      ② 裁定  clarify:reply    2026-10-10T22:06:05Z  verdict=answered
      ③ 恢复  clarify:resume   2026-10-10T22:06:05Z  → developing

✓ 正例① 裁定后**回到被打断前的状态**
    state=developing  resumed_from=awaiting_clarification → resumed_to=developing

✓ 正例① ★ 全程**没有**惊动用户：一条 human_request 都没有
    human_requests = []

✓ 正例① 留痕：①提问 ②裁定 ③恢复 三步齐全，且**没有**任何 human:* 动作
    clarify:* = clarify:request, clarify:reply, clarify:resume
    human:* = （无）

✓ 正例① 闭环：裁定后发起角色能接着把活干完（编写交测试）
    交接物已提交：H-74711c321c1417f7（编写交付给测试，编写 → tester）。
    任务状态：开发中 → 待测试。
```

**这就是这一级存在的全部意义**：问题在内部解决了，用户**根本不知道发生过什么**。

### 正例②：答不了 → 升级 → 转告 → 用户答复 → 恢复（12/12）

```
✓ 正例② 需求分析给出"答不了"+理由（并声明要升级）
    已裁定：CQ-…（需求分析答不了）
    为什么答不了：这属于**新需求**：原任务卡只要求"过滤",没规定非法输入的语义。
    加错误分支会改变对外契约，超出我的裁定范围。

✓ 正例② ★ 升级后状态是「等待人工答复」，且**恢复目标仍是最初的工作状态**（不是 awaiting_clarification）
    state=awaiting_human
    previous_state=developing  （不是 awaiting_clarification）
    human_requests[0].state_at_request=developing

✓ 正例② 单向门：上游澄清请求被标记为 escalated，不能再被需求分析改口
    status=escalated  escalated_at=2026-…  escalated_to=HR-…

✓ 正例② ★ 用户答复后回到**最初被打断的工作状态**（不是 awaiting_clarification）
    state=developing  resumed_from=awaiting_human → resumed_to=developing

✓ 正例② 留痕：提问 → 裁定 → 升级 → 转告 → 答复 → 恢复，六条都在 audit.jsonl 里
    完整链路：clarify:request → clarify:reply → clarify:escalate → human:relay → human:reply → human:resume

✓ 正例② 留痕：升级那一步能一眼看出"这事原本是谁问的、需求分析为什么答不了"
    { "action": "clarify:escalate", "request_id": "CQ-…", "escalated_to": "HR-…",
      "raised_by": "tester",
      "orchestrator_reason": "这属于新需求，超出我的裁定范围，必须由用户定对外契约。", … }

✓ 正例② 留痕：最后谁拍板 —— human:reply 里有用户原话与归属
    { "action": "human:reply", "user_quote": "报错吧，这种参数本来就不该传进来。",
      "attribution": "用户在当前会话里直接回复", "decision": "报错", … }
```

### 反例①：跳过需求分析，直接发 `human_request`（2/2）

```
✓ 反例① 执行角色跳过需求分析，直接向用户发起人工介入        拦截层：execute
    跳级：测试不能直接向用户发起人工介入。
    ★ 这个任务有**独立的需求分析/编排判断对话**，所以人工介入是**两级**的：
       ① 你先提交 clarification_request 问它（需求层的事它多半能直接答，用户根本不用被打扰）；
       ② 它确实答不了时，**由它**升级成 human_request 转给用户。
    当前待答复的澄清请求：（无）
    下一步：pipeline_clarify_request { task_id, stage, question, context_digest, blocking, urgency }。
    （只有 L0 档没有独立编排对话，那时直接发 human_request 才是合法的 —— 当前档位 L2，orchestrator_mode=separate。）

✓ 反例① 没有创建出任何 human_request，状态也没动
    human_requests=0  state=developing
```

### 反例②：★ L0 例外 —— 直接发是**合法**的（3/3）

```
✓ 反例② 夹具：这是一个 L0 任务，编排由规则引擎承担（没有独立编排对话）
    tier=L0  orchestrator_mode=rule-engine

✓ 反例② ★ L0 例外生效：没有独立编排对话时，直接发 human_request 被**放行**
    交接物已提交：H-…（人工介入请求，测试 → main）。
    任务状态：测试中 → 等待人工答复。

✓ 反例② L0 下确实推进到了「等待人工答复」
    state=awaiting_human
```

**这一条是刻意的**：不能一边要求"必须走第一级"，一边又拒绝 L0 —— L0 根本没有那一级。

### 反例③：需求分析把可自行裁定的问题推给用户（5/5）

```
✓ 反例③a 需求分析说"答不了"却不给理由
    MISSING_REASON：verdict=cannot_answer 时必须给 reason（为什么需求分析答不了）。
    ★ 这条是"防踢皮球"的第一道：说不出为什么答不了，就不许往上推。
    合法的理由类型：需要用户拍板 / 涉及新需求（超出原任务卡范围）/ 需求层内部冲突无法自解 / 缺环境或权限。
    非法的理由：这个我不太懂 / 让用户决定吧 / 实现细节我不管（那些属于本可以在需求层裁定的事）。

✓ 反例③b 前提：需求分析本来答得了（已给 answered 裁定）

✓ 反例③c 需求分析把**自己刚答过**的问题又推给用户
    ESCALATION_SOURCE_NOT_DECLINED：
    clarification_request CQ-8ed64452d1d47089 的状态是 answered（verdict=answered），
    不是"需求分析答不了"。
    ★ 只能升级**自己确实答不了**的问题 —— 能答而推给用户，就是踢皮球。
    先 pipeline_clarify_reply 给出 cannot_answer 的裁定（带理由），再来升级。

✓ 反例③d 升级来源指向一条不存在的澄清请求
    ESCALATION_SOURCE_NOT_FOUND：escalated_from=H-不存在的编号 指不到任何 clarification_request。
    升级必须挂在**真实存在**的上游请求上 —— 否则"我升级了一个别人没问过的问题"无从追溯。

✓ 反例③ 两次尝试之后仍然没有惊动用户
    human_requests=0
```

### 反例④：同一问题两级反复往返（5/5）

```
✓ 反例④ 第 1 次问同一个问题 —— 放行
✓ 反例④ 第 2 次问同一问题 —— 仍放行（允许"答了还是不明白再确认一次"）
    （这是第 2 次问这个问题）
✓ 反例④ 第 2 次也得到了裁定
✓ 反例④ 第 3 次问**同一个**问题 → 拒（防踢皮球）
    CLARIFICATION_PINGPONG：同一个问题已经问过 2 次（上限 2 次）。
    问题：参数为 0 时应当报错还是返回空结果？…
    上一次：CQ-…，状态 answered（verdict=answered）
    ★ 反复问同一件事说明它不是"需求层能定的" —— 那就该走升级路径，而不是在原地打转。
    下一步：让需求分析把它升级给用户（pipeline_human_request 带 escalated_from="H-…"）。
✓ 反例④ 对照：换个问题（问负数）—— 是新问题，放行（闸不是按角色封的）
```

### 反例⑤：单向门 / 越权 / 形态（4/4）

```
✓ 反例⑤a 非需求分析角色想自己出裁定
    [pipeline] 角色越权被拦下。工具：pipeline_clarify_reply
    允许角色：orchestrator    当前角色：tester

✓ 反例⑤b 脱敏摘要里塞了 diff（需求分析要靠它不读代码就判断）
    字段「context_digest」里混进了代码（含 diff 头（diff --git））。
    这个字段是**脱敏摘要** —— 需求分析靠它在不读代码的前提下判断，升级时它还会被复用给用户看。

✓ 反例⑤d ★ 单向门：升级之后需求分析不能再改口裁定
    ALREADY_ESCALATED：澄清请求 CQ-… 已经**升级**给人工了（2026-…），不能再由需求分析裁定。
    ★ 这是刻意设计的**单向门**：一旦升级，就只剩用户答复这一条出路 ——
    否则"先升级、再自己改口"会变成绕开用户的旁路，用户那边的待办也永远清不掉。
```

## 11.7 自测逮到的一个**真 bug**（`handoff_id` 碰撞）

写反例④时发现的：**第二轮请求明明提交成功，却报"已经裁定过了"**。

根因：`buildHandoffRecord` 的 id 哈希输入是

```
shortHash(`${kind}|${taskId}|${stamp}|${JSON.stringify(payload).slice(0,200)}`)
```

而 `stamp` 是**秒级**时间戳（`toISOString()` 去掉了毫秒）。
两级升级梯里"同一个问题问第二遍"恰好是：**同一角色 + 同一秒 + 内容完全相同** ⇒
两个 `handoff_id` **一模一样** ⇒ `findClarification` 命中的是第一份（已裁定）⇒ 误报。

这不是两级升级梯独有的 —— 任何"同一秒内提交两份相同交接物"都会撞。
只是这个增量第一个把它踩出来。

**修法**：id 哈希里加上 **序号**（`task.handoffs.length`）与**毫秒**：

```js
handoff_id: `H-${shortHash(`${kind}|${taskId}|${seq ?? 0}|${new Date().toISOString()}|${JSON...}`)}`
```

`content_hash` 保持不变（内容确实相同，那个哈希就该相同）。
`request_id` 也一并加了序号，双保险。

## 11.8 290 项自测是否仍全过

**是。** 既有 249 项一项没改坏（其中第二轮那 44 项人工介入自测**一字未动** —— 单级路径完整保留）。

```
#  dsh-pipeline 自测汇总：290/290 通过
总计：67/67 通过     ← selftest（正例全流程 + 10 组反例 + 分档）
总计：21/21 通过     ← 装载冒烟（工具数断言 17 → 19）
总计：19/19 通过     ← 工具定义真编译器校验
总计：38/38 通过     ← 功能开关
总计：23/23 通过     ← 客户端半边
总计：44/44 通过     ← 人工介入（单级路径）★ 一项没改
总计：39/39 通过     ← 编写席位 + 架构图（上一轮）
总计：39/39 通过     ← ★两级升级梯（本轮新增）
```

## 11.9 图里该新增 / 改动的节点与边（给画图的会话）

### 新增节点

| 节点 id | 中文标签 | 放在哪层 | 备注 |
|---|---|---|---|
| `st_await_clarify` | **等待需求分析答复**（`awaiting_clarification`） | 状态层 | ★ **不要**与 `st_await_human` 合并 |
| `clarify_gate` | **能在需求层定吗？**（分叉点） | 角色/状态之间 | ★ 左边"能"是**常态**，画粗；右边"不能"是例外 |
| `t_clarify_req` | 两级梯 ①：问需求分析 | 工具层 | |
| `t_clarify_reply` | 两级梯 ②：需求分析裁定 | 工具层 | |
| `m_ladder` | 两级升级梯机制 | L2 机制层 | 单向门 / 防踢皮球 / L0 例外 |
| `s_clarify` | 澄清请求生命周期 | 存储层 | `task.clarification_requests[]` |

### 要改的节点

| 节点 id | 原来 | 改成 |
|---|---|---|
| `orchestrator` | 「需求分析·编排判断」 | 补一句：**还是两级升级梯的第一级**（裁定执行角色提上来的问题；答不了由它升级） |
| `st_await_human` | 「等待人工答复」 | 保留；加一条入边说明"可由 `awaiting_clarification` 升级而来" |
| `t_human_req` | 「人工介入：发起」 | 改成「两级梯 ③ 升级 / L0 直发」 |
| `m_states` | 状态机 | 节点数 14 → 15 |

### 新增边

| from → to | 中文标签 | 类型 |
|---|---|---|
| 执行/顾问角色 → `t_clarify_req` | ① 向上提问（**不惊动用户**） | call（**绿色实线**） |
| `t_clarify_req` → `st_await_clarify` | 阻塞则推状态 | event |
| `st_await_clarify` → `clarify_gate` | 需求分析来判断 | dataflow |
| `clarify_gate` → `orchestrator`（"能"分支） | ②a 直接裁定 `answered` | call（**绿色实线，粗**） |
| `orchestrator` → 发起角色 | 结论回投 → 原角色**原地继续** | dataflow（绿色） |
| `clarify_gate` → `orchestrator`（"不能"分支） | ②b 答不了 `cannot_answer` + reason | call（橙色） |
| `orchestrator` → `t_human_req` | ③ 升级（带 `escalated_from`/`raised_by`/`orchestrator_reason`） | call（**橙色实线**） |
| `t_human_req` → `st_await_human` | 推「等待人工答复」 | event |
| `st_await_clarify` → `st_await_human` | 升级跳转（★ **`previous_state` 不覆盖**） | event（边旁务必标注） |
| `t_human_req` → `s_clarify` | 标记上游已升级（**单向门**） | control |
| 执行角色 → `t_human_req`（L0） | L0 直发 | call（**橙色虚线**，标注"仅 L0"） |
| 执行角色 → `t_human_req`（L2+） | 跳级 | **红色虚线** ✗ |
| `orchestrator` → `t_human_req` | 升级自己答过的问题 | **红色虚线** ✗ |
| 执行角色 → `t_clarify_req` | 同一问题问第 3 次 | **红色虚线** ✗ |
| `orchestrator` → `t_clarify_reply` | 对已升级的请求改口 | **红色虚线** ✗ |

### 明确**不该**画的边

1. **执行/顾问角色 → `user`** —— 仍然**没有**这条边（第二轮的约束不变）。
2. `st_await_clarify` 与 `st_await_human` 之间的**双向**边 —— 只有单向（升级），没有回退。
   （回退 = 需求分析改口 = 被单向门拒。）

### 配色建议

| 元素 | 建议 |
|---|---|
| 两级梯 ①②（内部解决） | **绿色实线** —— 表达"用户不该被打扰"的常态路径 |
| 两级梯 ③④⑤⑥（升级到用户） | **橙色实线** —— 表达这是例外路径 |
| L0 直发 | **橙色虚线** + 标注「仅 L0」 |
| `clarify_gate` | **粗边框菱形** —— 它是整条梯子的分叉点 |
| 两个等待态 | **同色系不同深浅**，但要能一眼看出是两个节点 |

## 11.10 不确定项

1. **"能在需求层定吗"目前靠模型判断**，本插件只执法"答不了必须给理由""只能升级确实答不了的"
   这两条**可机械检查**的部分。判断本身的质量取决于 orchestrator 那个会话 —— 装上去才知道。
2. **`boundary_warning` 的触发词表很粗**（`用哪个库|函数怎么实现|变量名|重构方式…`）。
   它会漏也会误伤（例如答复里说"我建议用一个独立的模块"就命中"用哪个库"？不会，
   但"用哪个库"这种字面命中确实偏窄）。**不阻断 + 记审计**的设计让误伤代价可控。
3. **`maxClarifyRounds` 默认 2 是拍的**。真实使用里可能 1 就够（问第二次往往是没读懂答复），
   也可能 3 才够。改配置即可，不用改代码。
4. **升级链条只有一级**。现在没有"多级升级"（例如 需求分析 → 架构委员会 → 用户）。
   用户的原话是两级，所以做到两级为止；要加的话 `escalated_from` 那个字段的结构是够用的。
5. **`clarification_request` 目前不允许非阻塞 + 非阻塞的恢复语义没测**。
   非阻塞提问（`blocking=false`）不会推状态，但**裁定之后没有任何人会被通知** ——
   发起角色得自己 `pipeline_status` 去看。要不要给它一个"回投"动作，还没做。
6. **`question_key` 的归一化是简单的**（去空白、去标点、小写）。
   "参数为 0 时应当报错还是返回空结果？" 与 "参数为零时应该报错还是返回空？"
   会被当成**两个不同的问题**（后者不会撞上限）。要更严就得做语义去重 —— 代价大得多，没做。

---

# 十二、设计增量：审核必须确认"网络安全 / 本地泄密是否发生"

> 第五轮追加需求，用户原话：
> **「审核ai应该确认包括网络安全/本地泄密的问题是否发生」**
>
> 原来"安全"只是验收标准里的一行字。这一轮把它变成**可执行、可追问依据**的检查项。

## 12.1 三轮的产物分属（哪部分属于哪一轮）

| 轮次 | 报告章节 | 内容 | 自测 |
|---|---|---|---|
| 第三轮 | 第十节 | **架构图角色 + 编写 1~3 席位** | `tests/writers-check.mjs`（39 项） |
| 第四轮 | 第十一节 | **两级升级梯**（角色 → 需求分析 → 用户） | `tests/ladder-check.mjs`（39 项） |
| 第五轮（本次） | **第十二节** | **安全确认**（网络面 + 本地泄密面） | `tests/security-check.mjs`（33 项） |

三轮各自独立：各自的测试文件、各自的临时目录、跑完即删。
**没有任何产物互相污染** —— 第五轮的改动没有动第三、第四轮的代码路径
（唯一相交的地方是 `review_verdict` 的字段表，而那是**加**字段，不是改语义）。

## 12.2 新增 / 改动的文件与契约

| 文件 | 改动 | 契约 |
|---|---|---|
| `lib/security.js` | **新增** | 11 类本地泄密特征 + 2 类网络特征；`scanFiles` / `runSecurityScan` / `renderScanSummary` / `mask` / `looksLikeRawSecret`；**只扫本任务工作区**；结果**打码** |
| `lib/handoff.js` | 改 | `review_verdict` 新增**必填** `security` 段（9 条跨字段硬闸）；`security_review` 的 `blocked` 早已存在，本轮开始被关单闸消费 |
| `lib/store.js` | 改 | 关单组合闸从 2 条扩到 **4 条**（顺序见 12.4）；新增 `security_attested` / `security_not_blocked` 两条前置条件；新增 `recordAudit`（工具层写审计的正规入口） |
| `lib/tools.js` | 改 | 新增 `pipeline_security_check`（**19 → 20**）；补 fs/path 导入 |
| `lib/guard.js` | 改 | `pipeline_security_check` 的角色白名单（reviewer / security / main / human） |
| `tests/security-check.mjs` | **新增** | 33 项：1 正例 + 8 组反例 + 扫描边界 + **工具缺陷断言** |
| `tests/security-check-last-run.txt` | **新增** | 本套完整原始输出 |
| `tests/selftest-core.mjs` | 改 | 新增 `cleanSecurity()` 夹具；三处 `review_verdict` 夹具补 `security` |
| `tests/writers-check.mjs` | 改 | 夹具补 `security`；`createMultiWriterFixture` 支持 `tier` 选项 |
| `tests/load-smoke.mjs` / `schema-check.mjs` / `run-all.mjs` | 改 | 工具数 19 → 20；八套 → **九套** |

## 12.3 扫描工具的两个关键设计

### ① 范围边界：只扫本任务工作区

**扫什么**：`<项目>/.pipeline/<任务>/` 下的全部文本类文件（制品、报告、交接物、`audit.jsonl`、收据），
加上显式给出的 `extra_paths` —— 但**必须落在项目根之内**，越界的被**拒绝并记入结果**。

**为什么不扫全盘**：越界（读无关目录）、慢（时间随磁盘增长）、违反最小权限。
一个做安全扫描的工具如果自己去遍历用户整个硬盘，**它本身就是个安全问题**。

边界写进结果（`scan.scope.boundary`）并在摘要里出现，让调用方一眼看到"扫到哪为止"。
自测里有一条：传一个项目根之外的路径 → 结果里出现「被拒绝的扫描路径 … 超出本任务工作区」。

其他限制：单文件 2 MB、最多 500 个文件、跳过 `node_modules`/`.git`/`dist` 等、二进制跳过。

### ② ★自我指涉：扫描结果不回显命中原文

这条是**最要紧的设计约束** —— 否则这个工具本身就成了泄密渠道。做法：

| 位置 | 写什么 |
|---|---|
| 命中记录 | `{ file, line, type, severity, why, preview }` —— **没有** `match` 字段 |
| `preview` | 打码：`sk-************KE（共 27 字符）` |
| 摘要 | 「`<文件>` 第 N 行命中 `<类型>`」 |
| 落盘 JSON | 与上面同构 |

**自测里有一条专门盯它的"工具缺陷断言"**（反例⑤）：把假密钥原文在**摘要**与**落盘 JSON** 里各搜一遍，
搜到就判失败。另有一条对照断言证明"确实给了打码片段" —— 不然"什么都不输出"也能骗过前一条。

实测摘要（原文从未出现）：

```
【本地泄密面】命中 1 处
  · .pipeline/t-…/artifacts/v1/config.json 第 3 行命中 openai_style_key（high）　sk-************KE（共 27 字符）
      OpenAI 风格密钥（sk- 前缀 + 长随机串）
```

## 12.4 关单闸：四条，**顺序有讲究**

```js
for (const g of ['review_ok_exists', 'security_not_blocked', 'security_attested', 'diagram_delivered'])
```

**安全否决排在第二**（紧跟审核 OK）—— 它优先于审核 OK，那也该最先被判。
这是写测试时发现并调整的：原本 `security_attested` 在前，
结果"安全角色否决了但审核结论里 `checks_ref` 写错"时，报出来的是后者的理由，
**看不到真正的原因**。

| 顺序 | 判据 | 不通过时 |
|---|---|---|
| 1 | `review_ok_exists` | `NO_REVIEW_OK` |
| 2 | `security_not_blocked` | `SECURITY_VETO`（blocked=true，一票否决）或 `MISSING_SECURITY_REVIEW`（L3+ 缺独立结论） |
| 3 | `security_attested` | `NO_SECURITY_ATTESTATION` / `SECURITY_ATTESTATION_UNKNOWN` / `SECURITY_FINDINGS_OPEN` / `SECURITY_CHECKS_REF_MISSING` |
| 4 | `diagram_delivered` | `MISSING_DIAGRAM` / `DIAGRAM_STALE` |

### `attestation: 'unknown'` 为什么必须拒

写进了拒绝文案里：

```
security.attestation=unknown —— **不允许通过**。
★ 要么查清（clean / issues），要么打回让编写补齐可查的证据。
"没查"和"查了没问题"是两件完全不同的事，不能都算过。
如果确实查不了（例如缺环境），走 pipeline_rework 打回，或 pipeline_human_request 升级给用户。
```

### 依据必须真实存在（本轮加的一条）

`checks_ref` 是 `相对路径#sha256前缀`。关单时会去磁盘上核对 ——
**只写路径不落盘，等于没有依据**：

```
拒绝关单：安全确认里给的 checks_ref 指向的检查产物**一个都不存在**。
  · reports/never-written.json
★ "我扫过了"必须留下可核对的东西…
（只写路径不落盘，等于没有依据。）
```

（纯 `sha256:…` 形状的引用不做存在性检查 —— 那种引用本来就无法核对文件，只核对内容。）

## 12.5 审核必须自己出结论

`checked_by: 'security'` 直接拒：

```
security.checked_by=security —— 审核不能只写"安全角色说没问题"。
★ 安全角色（L3+）产出的 security_review 是**输入证据**，不是审核结论。
审核必须自己跑一遍检查（或复核安全角色的证据）并给出自己的 attestation。
```

但 `security_not_blocked` 闸**仍然独立地**尊重安全角色的否决 —— 审核说 OK 也翻不了它。
两者是**互补**的：一个管"审核不能偷懒"，一个管"独立那一票不能被翻案"。

## 12.6 实测：正例 + 八组反例

命令：

```powershell
cd dsh-pipeline
node tests\security-check.mjs
```

完整输出：[`tests/security-check-last-run.txt`](tests/security-check-last-run.txt)。

### 正例：干净制品 → clean → 可关单（5/5）

```
✓ 正例 审核自己跑安全确认扫描
    安全确认扫描：任务 T-20261011-dd1153
    扫描范围：.pipeline/T-20261011-dd1153　文件 6 个 / 16.5 KB
    边界：只扫本任务工作区（.pipeline/<taskId>/ 与显式给出的、落在项目根内的路径）；不遍历用户其它目录。

    【本地泄密面】命中 0 处
      （未发现密钥/凭证/隐私特征）

    【网络面】外联主机 0 个，命中 0 处
      （未发现外联地址）

    合计 0 处。★ 本摘要**不含任何命中原文** —— 只给位置与类型（工具自身不得成为泄密渠道）。

    落盘：.pipeline/T-20261011-dd1153/reports/security-scan-2026-10-10T22-12-02-253Z.json
    sha256：<redacted>…
    ★ 建议结论：attestation=clean
    （扫描未见命中。注意：**扫描不是万能的** —— 它只查已知模式；结论仍要你自己负责。）

✓ 正例 扫描结果落盘并给出 checks_ref（可追问依据）
    checks_ref = .pipeline/T-…/reports/security-scan-2026-….json#793024b097527a22
✓ 正例 审核出结论（带安全确认）
✓ 正例 ★ 可关单：attestation=clean + 依据真实存在
```

### 反例①：制品里放一个**假密钥** → 命中 → 关单被拒（5/5）

（用的是测试专用假密钥 `<redacted>`，不是真凭证。）

```
✓ 反例① ★ 假密钥被扫出来（命中数 > 0，建议 issues）
    【本地泄密面】命中 1 处
      · .pipeline/t-…/artifacts/v1/config.json 第 3 行命中 openai_style_key（high）　sk-************KE（共 27 字符）
          OpenAI 风格密钥（sk- 前缀 + 长随机串）
    ★ 建议结论：attestation=issues
    （有 1 处命中，**不能**给 clean。要么打回编写，要么让 security 角色复核，要么升级给用户。）

✓ 反例① ★ 有未解决的安全问题 → **关单被拒**        拦截层：execute
    拒绝关单：安全确认里有 1 条**未解决**的问题。
      1) artifacts/v1/config.json 第 3 行 — openai_style_key：制品里出现了疑似 API 密钥
    ★ 处理路径三选一：
      ① pipeline_rework 打回编写（改掉它）；
      ② 让 security 角色复核并给出可接受的整改结论（L3+）；
      ③ pipeline_human_request 升级给用户拍板（接受风险也要有人签字）。
    （把 findings 标成 resolved 之前，请先说清"为什么它不再算问题"。）
```

### 反例②：报告里夹带未脱敏凭证 → 命中 → 拒（4/4）

```
✓ 反例② ★ 报告里夹带的 Bearer 令牌被扫出来
    【本地泄密面】命中 1 处
      · .pipeline/t-…/reports/test-report.md 第 5 行命中 bearer_token（high）　Bea************ef（共 32 字符）

    【网络面】外联主机 1 个，命中 2 处
      · api.internal.example.net　出现 1 次　⚠ 伴随凭证
      ✗ …/reports/test-report.md 第 5 行：unexplained_outbound → api.internal.example.net
          出现了外联地址，但需求/验收/白名单里都没有解释它 —— 未解释的外联必须能对应到需求，对不上就要打回
      ✗ …/reports/test-report.md 第 5 行：credential_in_outbound → api.internal.example.net
          ★ 同一行里既有外联地址又有疑似凭证 —— 凭证可能随出网请求发出去，这类一律记为问题

✓ 反例② ★ 报告里有未脱敏凭证 → **关单被拒**
    拒绝关单：安全确认里有 2 条**未解决**的问题。
      1) reports/test-report.md 第 5 行 — bearer_token：测试报告里夹带了未脱敏的令牌
      2) reports/test-report.md 第 5 行 — credential_in_outbound：凭证与外联在同一行，可能已随请求发出
```

### 反例③：`attestation: 'unknown'` → 拒（1/1）

```
✓ 反例③ ★ attestation=unknown → 审核结论本身就被拒
    security.attestation=unknown —— **不允许通过**。
    ★ 要么查清（clean / issues），要么打回让编写补齐可查的证据。
    "没查"和"查了没问题"是两件完全不同的事，不能都算过。
```

### 反例④：缺段 / 跳过检查 / 依据不存在（5/5）

```
✓ 反例④a 审核结论里**完全没有** security 段
    缺少必填字段「security」（★ 安全确认（网络面 + 本地泄密面，含 attestation 与依据））
    缺少 security 段。★ 审核**必须**确认"网络安全 / 本地泄密是否发生"，没确认就不算完成审核。

✓ 反例④b 本地泄密面 checked=false（跳过检查）
    security.local_leak.checked 不为 true（本地泄密面没查）。
    ★ 审核不能跳过检查 —— checked:false 与"没写"一样，都不算确认过。

✓ 反例④c checks_ref 为空（没有依据）
    security.local_leak.checks_ref 为空（本地泄密面没有依据）。
    ★ 结论必须可追问依据…"我看了，没问题"不是依据。

✓ 反例④d ★ 依据指向的文件一个都不存在 → 关单被拒
    拒绝关单：安全确认里给的 checks_ref 指向的检查产物**一个都不存在**。
      · reports/never-written.json
```

### 反例⑤：★ 工具缺陷断言 —— 扫描结果自身不回显原文（3/3）

```
✓ 反例⑤ ★ 工具缺陷断言：摘要里**不含**命中原文
✓ 反例⑤ ★ 工具缺陷断言：落盘的完整 JSON 报告里**也不含**命中原文
    报告 3000+ 字节，搜索命中原文未找到。（只写"哪个文件第几行命中哪一类" + 打码片段）
✓ 反例⑤ 对照：摘要里给了**打码**片段（便于人认出是哪一类，又不泄露内容）
    sk-************KE（共 27 字符）
```

**最后那条对照断言是必要的**：只断言"不含原文"，一个什么都不输出的实现也能通过。

### 反例⑥：审核把命中原文抄进结论 → 拒（1/1）

```
✓ 反例⑥ ★ 审核把命中原文抄进了 finding.why
    security.findings[0] 里出现了疑似凭证**原文**（openai_style_key）。
    ★ 这条是刻意的：把命中的密钥原文抄进审核结论，等于**把泄露从制品搬到了结论里** ——
    结论会落盘、会被转告、会进审计。
    正确写法：只写'哪个文件第几行命中哪一类'（例如 "artifacts/v1/x.json 第 3 行命中 generic_assigned_secret"）。
```

### 反例⑦：审核只写"安全角色说没问题" → 拒（1/1）

```
✓ 反例⑦ ★ 审核不能只写"安全角色说没问题"（必须自己出结论）
    security.checked_by=security —— 审核不能只写"安全角色说没问题"。
    ★ 安全角色（L3+）产出的 security_review 是**输入证据**，不是审核结论。
    审核必须自己跑一遍检查（或复核安全角色的证据）并给出自己的 attestation。
```

### 反例⑧：`security` 角色报 `blocked: true` → 强制拦截（5/5，L3）

```
✓ 反例⑧ 夹具：L3（安全敏感），清单里有 security 角色
✓ 反例⑧ 安全角色出 blocked=true 的独立结论
✓ 反例⑧ 前提：审核给了 OK（带安全确认）
✓ 反例⑧a ★ security 角色报 blocked=true → **关单被拒**，不得放行
    拒绝关单：安全角色（security）出了一份 security_review，其 blocked=true —— 存在**阻断项**。
    最高严重级别：high
    发现项：
      · 对外接口缺少速率限制
    ★ 安全否决**优先于**审核 OK：安全角色是独立的一票，审核不能替它翻案。
    下一步：pipeline_rework 打回编写整改 → 让安全角色复核出新的一份 security_review（blocked=false）→ 再谈关单。
    （如果确实要带风险上线，那必须走 pipeline_human_request 让用户签字，不能在这里悄悄放行。）
```

### 扫描范围边界（3/3）

```
✓ 边界 越界路径不会让扫描失败（照常出结果）
✓ 边界 ★ 越界的补充路径被**拒绝**并记入结果（不遍历项目根之外）
    扫描范围：.pipeline/T-…　文件 6 个 / 16.5 KB
    边界：只扫本任务工作区…；不遍历用户其它目录。
    ⚠ 被拒绝的扫描路径（越界，未扫）：
       · …\somewhere-else —— 超出本任务工作区（项目根之外）—— 按最小权限，扫描不越界
✓ 边界 结果里写明了扫描边界（文档化）
```

## 12.7 既有自测是否仍全过

**是。** 既有 291 项一项没改坏 —— 唯一的改动是**给夹具补上新的必填字段**
（`review_verdict.security`），那是加字段的必然后果，不是行为回归。

```
#  dsh-pipeline 自测汇总：324/324 通过
总计：67/67 通过     ← selftest（正例全流程 + 10 组反例 + 分档）
总计：21/21 通过     ← 装载冒烟（工具数 19 → 20）
总计：20/20 通过     ← 工具定义真编译器校验
总计：38/38 通过     ← 功能开关
总计：23/23 通过     ← 客户端半边
总计：44/44 通过     ← 人工介入（单级路径）
总计：39/39 通过     ← 编写席位 + 架构图（第三轮）
总计：39/39 通过     ← 两级升级梯（第四轮）
总计：33/33 通过     ← ★安全确认（本轮新增）
```

## 12.8 图里该新增 / 改动的节点与边（给画图的会话）

### 新增节点

| 节点 id | 中文标签 | 放在哪层 | 备注 |
|---|---|---|---|
| `security_gate` | **安全确认** | 审核与关单之间 | ★ 用**盾牌 / 闸门**形状 |
| `t_security_scan` | 安全确认扫描 | L3 工具层 | 能力：本地泄密面 + 网络面；**只扫本任务工作区**；**结果打码** |
| `m_security` | 安全扫描机制 | L2 机制层 | `lib/security.js`：11 类泄露特征 + 2 类网络特征 |
| `s_scan_report` | 扫描报告 | 存储层 | `reports/security-scan-<时间>.json`（就是 `checks_ref` 指的东西） |
| `net_face` | 网络面 | 安全确认内部 | 外联地址 / 未解释外联 / 凭证出网 |
| `leak_face` | 本地泄密面 | 安全确认内部 | 密钥凭证 / 隐私 / 落错地方 |

### 要改的节点

| 节点 id | 原来 | 改成 |
|---|---|---|
| `reviewer` | 「审核」 | 补一句：**必须确认网络安全 / 本地泄密是否发生**，并给出 `attestation` + 可核对依据 |
| `security` | 「安全/合规审计」 | 补一句：L3+ 出**独立**结论（`blocked` 一票否决）；它的结论是审核的**输入证据**，不是审核结论 |
| `t_close` / `st_closed` | 关单 | 边旁标注四条闸：审核 OK → **安全否决** → 安全确认 → 架构图 |
| 图例 | —— | 加一句「扫描只覆盖本任务工作区」 |

### 新增边

| from → to | 中文标签 | 类型 |
|---|---|---|
| `reviewer`/`security` → `t_security_scan` | 跑安全确认扫描 | call |
| `t_security_scan` → `s_scan_report` | 结果落盘（打码） | dataflow |
| `t_security_scan` → `leak_face` / `net_face` | 两个面并行扫 | dataflow |
| `s_scan_report` → `reviewer` | 返回 `checks_ref`（可追问依据） | dataflow |
| `reviewer` → `security_gate` | `review_verdict.security`（attestation + findings） | dataflow |
| `security` → `security_gate` | L3+ 独立结论（`security_review`） | dataflow（**虚线**，标"输入证据，不是结论"） |
| `security_gate` → `st_passed` | 确认通过 | event（绿色） |
| `security_gate` → `st_returned_to_dev` | **不合格 → 打回编写** | event（**红色实线**，标"有未解决 finding"） |
| `security` → `st_returned_to_dev` | **安全否决一票否决** | event（**红色实线加粗**，标"`blocked: true` 优先于审核 OK"） |
| `main` → `t_close` | 缺 attestation / `unknown` | **红色虚线** ✗ |
| `main` → `t_close` | `checks_ref` 指向的文件不存在 | **红色虚线** ✗ |
| `main` → `t_close` | L3+ 没有独立 `security_review` | **红色虚线** ✗ |
| `reviewer` → `security_gate` | `checked_by: 'security'` | **红色虚线** ✗（不能只写"安全角色说没问题"） |
| `reviewer` → `security_gate` | finding 里抄了命中原文 | **红色虚线** ✗ |
| `t_security_scan` → `s_files` | 越界的 `extra_paths` | **红色虚线** ✗（扫描不越界） |

### 明确**不该**画的边

1. `t_security_scan` → 用户全盘 / 项目外目录 —— **没有**这条边。
2. `security` → `st_passed` —— 安全角色**不能**直接放行；它只能出结论或否决，放行由审核给。
3. `security_gate` → `user` —— 需要人签字时仍然走 `pipeline_human_request`（两级升级梯那条路）。

### 配色建议

| 元素 | 建议 |
|---|---|
| `security_gate` | **盾牌 / 闸门**形状，比普通节点大一圈 |
| 安全否决边 | **红色实线加粗**（一票否决，与普通拒绝的虚线区分开） |
| 两个面（`leak_face` / `net_face`） | 同一色系，画在 `security_gate` 内部或下方并列 |
| `t_security_scan` | 边上标注「只扫本任务工作区 / 结果打码」 |

## 12.9 不确定项

1. **特征表是"已知模式"，不是完备检测**。11 类本地泄密 + 2 类网络特征覆盖的是常见形状
   （私钥头、`sk-`、`AKIA`、`SESSDATA`、cookie、Bearer、JWT、带密码连接串、`key=value`、邮箱、手机号）。
   变形的、编码过的、分片拼接的凭证**扫不出来**。工具返回里也写着这句
   （"扫描不是万能的 —— 它只查已知模式；结论仍要你自己负责"）。
2. **`unexplained_outbound` 的"解释"判据很粗**：host 出现在需求文本/验收标准里，或在 `allowed_hosts` 白名单里。
   这意味着"需求里恰好提到某个域名"就会放行。更严的做法是要求显式白名单（`allowed_hosts` 只走这一条），
   但那会让常规调用更啰嗦 —— 目前两条都接受。
3. **邮箱正则可能误伤**。`<redacted>` 这类占位符会被记成 medium finding。
   误伤代价可控（finding 可以标 `resolved` + 说明），但确实会吵。
4. **打码长度保留**（`（共 27 字符）`）。长度通常不敏感，理论上仍是一点信息 ——
   如果要求更严，改 `mask()` 去掉长度即可。
5. **没扫二进制文件**（含 NUL 字节的跳过）。凭证藏在图片/压缩包里扫不出来。
6. **关单闸只看 `checks_ref` 的存在性，不看内容是否对得上**。
   也就是说：把一份**无关**的扫描报告路径填进 `checks_ref` 也能过（只要文件存在）。
   要更严就得解析报告 JSON、核对它扫的是不是当前制品版本 —— 那一层还没做。
7. **`security_review` 允许的状态里没有 `passed`**（这轮发现的）。
   也就是说安全角色必须在审核发结论**之前**出否决，不能在 `已通过` 之后补一刀。
   实际流程下这是合理的（审核前就该有安全结论），但**没写在文档显眼处**，这里补记。

---

# 十三、设计增量：需求留档 + 上下文水位 + 席位继任

> 第六轮追加需求，用户原话：
> **「分析ai再留本地文件留档，好随时查看需求防止上下文溢出失忆，编程等ai在上下文到55%时就要通知给分配ai，
> 让分配ai去再追加ai，然后通知上下文到55%的ai主动交接新分配ai。」**
>
> 拆成三块：**A. 需求留档**、**B. 上下文水位上报**、**C. 席位继任**。

## 13.1 五轮的产物分属（哪部分属于哪一轮）

| 轮次 | 报告章节 | 内容 | 自测 |
|---|---|---|---|
| 第三轮 | 第十节 | 架构图角色 + 编写 1~3 席位 | `writers-check.mjs`（39 项） |
| 第四轮 | 第十一节 | 两级升级梯（角色 → 需求分析 → 用户） | `ladder-check.mjs`（39 项） |
| 第五轮 | 第十二节 | 安全确认（网络面 + 本地泄密面） | `security-check.mjs`（33 项） |
| **第六轮（本次）** | **第十三节** | **需求留档 + 上下文水位 + 席位继任** | `relay-check.mjs`（32 项） |

四轮各自独立：各自的测试文件、各自的临时目录、跑完即删。
**没有互相污染** —— 本轮唯一动到前面产物的地方是 `orchestrate`（加落档）
与 `dispatch`（加需求档闸），都是**新增**动作，没有改变已有语义。

## 13.2 ★ 侦察结论：DSH 有没有可读的上下文用量？

**这是本轮最关键的一个事实，它决定了整个 B 部分的形态。** 结论：**面向插件的那一层没有。**

| 位置 | 有什么 | 为什么用不了 |
|---|---|---|
| `dsh-agent-loop/lib/index.js:460-462` | `get usage()` —— adapter 报的最新用量 | 在**流装配器内部**，不对外暴露 |
| `dsh-agent-loop/lib/index.js:1250` | `contextWindow` | 只给"窗口多大"，**没有"用了多少"** |
| `dsh-agent-loop/lib/index.js:1098` / `:1148` | `live.usage` 写进会话记录 | 没有任何包把它读出来给插件用 |
| `dsh-session` / `dsh-agent` / `dsh-subagent` / `dsh-tools` | —— | 均没有 `usage` / `contextWindow` 的对外服务或工具 |
| `~/.dsh/.dshw-usage.json` | 计费账本（每次 API 调用的花费与 token 总量） | **按次累计**，不能算"当前上下文占用比例" |

**所以走需求里给的降级路径：角色自报 + 必须给依据。**
「哪种可用、哪种是降级」的答案就是：**降级 —— 自报 + 依据，没有自动感知。**

### 但"自报"不等于"凭感觉"：补一类客观观测

插件能自己数（在守门那一层 —— 每次工具调用都经过它，且拿得到 `exec.agent`）：

- 这个席位**调用过多少次工具**、主要用了哪些
- **活跃了多久**（首次/最近一次调用的时间跨度）

于是每条上报都带两块：`self_reported`（席位说的 + 依据）与 `observed`（插件数的）。
**诚实边界写进了代码与文案**：`observed` **不是**上下文占用的度量，
只是"这个席位有多忙"的客观代理指标。

## 13.3 A. 需求留档

| 文件 | 作用 |
|---|---|
| `.pipeline/<taskId>/requirement.md` | **人可读**的权威需求快照（固定路径，随时可查） |
| `.pipeline/<taskId>/requirement.json` | 结构化版本 |
| `.pipeline/<taskId>/requirement.rN.md` | 每次变更的历史版本（**不覆盖**） |

任务卡里记 **路径 + sha256**；`requirement.md` 里自带一句
「**本文件是权威需求快照。所有角色默认以本文件为准**」，并把**安全确认的要求**也写进去 ——
这样继任席位读一遍档就同时知道"要做什么"和"审核会查什么"。

**变更版本化**：重新编排 → 新版本 `rN`，`supersedes` 指向上一版，历史全留。

**守门（分发任务时）**：两条，任一不满足就拒 ——
① 任务卡没登记路径；② 登记了但文件不在盘上。

**★ 编排角色本身豁免这条闸。** 这是实现时踩到的死锁：
需求档是**编排产出**的，先卡它就成死锁（派编排 → 被"没有档"拒 → 永远产不出档）。
语义上也对："开工"指的是干活，而编排的活**就是**产出任务卡 + 需求档。

## 13.4 ★ 继任 vs 角色变更：界线怎么划

用户要"分配 AI 去追加 AI"，而既有硬约束是「**主对话不能自行增删角色**」。
界线：

| | 角色变更 | **席位继任** |
|---|---|---|
| 角色数量 | **变** | **不变** |
| 谁能批 | **只有编排** | 主对话，但**只能在 `relayPolicy` 授权内** |
| 改的是什么 | 清单本身 | 同一角色的席位**换个人** |
| 任务状态 | 通常要重新派活 | **不动** |

一句话：**继任一个角色都没加、没减，所以不违反那条约束**；
但"换几次、换哪些角色"必须由编排**预先授权** —— 那就是 `relayPolicy`。

```jsonc
{
  "warnPercent": 45,
  "triggerContextPercent": 55,
  "hardLimitPercent": 75,
  "maxSuccessionsPerSeat": 2,
  "allowedRoles": ["writer", "tester", "reviewer"],
  "requireOrchestratorApproval": false,
  "enabledTiers": ["L1", "L2", "L3", "L4", "L5"]
}
```

超出授权一律回编排复核（角色不在白名单 / 次数用尽 / `requireOrchestratorApproval`）。

## 13.5 ★ 防踢皮球式的"反复换班"：`maxSuccessionsPerSeat`

继任次数上限是**编排给的**，默认 2。用尽后主对话不得突破，拒绝文案直接指向根因：

```
席位 writer#1 已经继任 1 次，达到上限 1 次。
★ 反复换班说明问题不在"上下文不够"，而在别处（任务太大？拆分不合理？需求没定？）。
下一步：**回编排复核** —— pipeline_roster_request 提出，让编排重新划界或调整 relayPolicy。
主对话不得自行突破这个上限。
```

## 13.6 ★ 一个真陷阱：只撤令牌不够

继任要"旧席位不得再写"。第一版只想撤令牌 —— 但**撤了令牌之后角色绑定就没了**，
`roleOfAgent` 返回 null，守门的第 0 步会把它当成"**与流水线无关的会话**"**直接放行**。
也就是说：**越撤越放行**。

修法：退休名单**单独维护**，并在守门里**排在所有放行分支之前**：

```js
// guard.js decide() 里
const retired = deps?.retired ?? null
if (retired !== null && agentId !== null && retired.has(agentId)) {
  return '[pipeline] 拒绝：本会话所属的席位已经**继任换班**了（它的令牌已撤销）。…'
}
```

自测反例③ 专门盯这条：继任之后旧席位再提交 → 被拒。

## 13.7 实测：正例 + 反例

命令：

```powershell
cd dsh-pipeline
node tests\relay-check.mjs
```

完整输出：[`tests/relay-check-last-run.txt`](tests/relay-check-last-run.txt)。

### A. 需求留档（6/6）

```
✓ A 编排产出任务卡时**同时**落了需求档（路径 + sha256 记进任务卡）
    requirement_doc = { "version": "r1", "path": ".pipeline/T-…/requirement.md",
                        "sha256": "…", "json_path": ".pipeline/T-…/requirement.json" }
✓ A 需求档是人可读的 markdown（含需求原文 / 验收标准 / 安全面）
✓ A 结构化 JSON 同时落盘（机器可读的那一份）
    requirement.json 关键字段：task_id=T-… tier=L2 roles=architect/writer/tester/reviewer/diagrammer
✓ A 任务卡里登记了 sha256（文件被改过能发现）
✓ A 需求变更可以重新编排（落新版本）
✓ A ★ 变更**版本化**：新版本 + supersedes，历史不覆盖
    版本 r1 → r2，supersedes=r1
    历史：r1 / r2
```

### 正例①：上报 55% → 继任 → 新席位接手 → 任务从原状态继续（9/9）

```
✓ 正例① 席位上报水位 55%（达触发线）
    水位已上报：CR-…　writer（writer#1）　**55%**　档位：触发继任（必须上报给分配 AI）
    依据：已读 12 个文件、跑了 30 轮，上下文里压着 3 份大报告
    插件侧客观观测：工具调用 3 次，活跃 0 分钟（主要：pipeline_context_report×1、…）
    阈值（来自编排的 relayPolicy）：预警 45% / 触发继任 55% / 硬限 75%
    ★ **触发继任**：必须上报给分配 AI（主对话）。
      下一步：① 产出一份 seat_handover 交接物（含 must_read_files 与 open_questions）；
              ② 主对话调 pipeline_succession 换班。
      ★ 别等自己撑不住才交 —— 交接物写得清不清楚，取决于你还记得多少。

✓ 正例① 上报里带**插件侧客观观测**（工具调用次数，不是模型说的）
✓ 正例① 旧席位产出 seat_handover（含必读文件与未决问题）
✓ 正例① 主对话按 relayPolicy 授权执行继任
    席位继任完成：SC-…
    席位：writer#1（writer）　第 2 代
    依据：水位 55%（succession）—— 已读 12 个文件、跑了 30 轮，上下文里压着 3 份大报告
    交接物：H-…
    旧会话：fake-agent-004（令牌已撤销 + 已登记退休，**不得再写**）
    新会话：fake-agent-010
    新令牌：PT-…
    ★ 任务状态**没有变** —— 继任是换班，不是重开（制品版本、打回计数、审计都连续）。
✓ 正例① ★ 任务**状态没有变**（继任是换班，不是重开）      状态：developing → developing
✓ 正例① 继任关系落档（succeeds / 世代 / 依据 / 交接物 id）
✓ 正例① 制品版本与打回计数**连续**（没被重置）
✓ 正例① 留痕：水位 → 交接 → 继任 三步都在 audit.jsonl 里
    相关动作：context:report → handoff:seat_handover → seat:succession
✓ 正例① 留痕：能一眼看出"谁继任谁、依据什么水位"
    { "action": "seat:succession", "succession_id": "SC-…", "seat": "writer#1", "role": "writer",
      "from_agent": "fake-agent-004", "to_agent": "fake-agent-010", "handoff_id": "H-…",
      "generation": 2, "reason": "水位 55%：已读 12 个文件、跑了 30 轮，上下文里压着 3 份大报告" }
```

### 正例②：★ 模拟"上下文丢失"（3/3）

```
✓ 正例② ★ 模拟上下文丢失：全新会话只读 requirement.md 就能说清"要做什么"
    需求档里能读到需求原文：
        （用户原话）给订单系统加导出功能：前端页面、后端接口、使用文档。
✓ 正例② ★ 也能说清"验收标准是什么"
✓ 正例② ★ 新席位的全新会话能直接继续推进（编写交测试）
    交接物已提交：H-…（编写交付给测试，编写 → tester）。
    任务状态：开发中 → 待测试。
```

**这就是防失忆的验收点**：一个全新会话（只有新令牌、零上下文）读需求档就能接上并推进。

### 反例①：未上报水位就请求继任（1/1）

```
✓ 反例① 没上报水位就请求继任
    拒绝继任：席位 writer#1 **从未上报过上下文水位**。
    ★ 继任必须有依据 —— "我觉得它快满了"不是依据。
    下一步：先让该席位调 pipeline_context_report 上报水位（百分比 + 依据）。
```

### 反例②：继任次数超上限（2/2）

```
✓ 反例② 前提：第 1 次继任成功
✓ 反例② ★ 继任次数超 maxSuccessionsPerSeat → 拒（并指路回编排复核）
    席位 writer#1 已经继任 1 次，达到上限 1 次。
    ★ 反复换班说明问题不在"上下文不够"，而在别处（任务太大？拆分不合理？需求没定？）。
    下一步：**回编排复核** —— pipeline_roster_request 提出，让编排重新划界或调整 relayPolicy。
    主对话不得自行突破这个上限。
```

### 反例③：旧席位在继任后继续写（1/1）

```
✓ 反例③ ★ 旧席位在继任后继续写 → 拒（令牌已撤 + 已登记退休）
    [pipeline] 拒绝：本会话所属的席位已经**继任换班**了（它的令牌已撤销）。
    工具：pipeline_handoff
    会话：fake-agent-004
    ★ 继任是**换班** —— 工作由新席位接着做，旧席位不得再写、不得再提交、不得再推进。
    为什么这条要单独判：令牌撤销之后角色绑定就没了，普通判据会把它当成"无关会话"放行。
```

### 反例④：需求档缺失 / 未登记就分发任务（2/2）

```
✓ 反例④a ★ 任务卡里没登记需求档就分发任务 → 拒
    拒绝分发任务：任务 T-… **没有需求档**。
    ★ 规矩：编排产出任务卡时必须同时落一份本地需求档（requirement.md），并把路径 + sha256
    登记进任务卡 —— **没有留档就不许开工**。
    为什么：上下文会溢出、会失忆、席位会换人。需求档是唯一能在"什么都忘了"之后把
    "要做什么、验收标准是什么"还原出来的东西。

✓ 反例④b ★ 登记了路径但文件不在盘上 → 也拒
    拒绝分发任务：任务卡里登记了需求档，但文件不在盘上。
      登记路径：.pipeline/T-…/requirement.md（r1，sha256 …）
    ★ "登记过路径"不等于"文件还在" —— 被删掉或改名的档不算数。
```

### 反例⑤：主对话超出 `relayPolicy` 授权（1/1）

```
✓ 反例⑤ ★ 主对话给一个**不在授权名单里**的角色继任 → 拒
    角色「writer」不在 relayPolicy.allowedRoles（tester）里，主对话不能自行给它继任。
    ★ 继任的授权范围是**编排**给的：哪些角色可以换班、最多换几次。
    要放开：让编排复核后重新下 relayPolicy（pipeline_roster_request → pipeline_roster_review）。
```

### 反例⑥：交接物缺 `must_read_files` / `open_questions`（2/2）

```
✓ 反例⑥a 交接物 must_read_files 是空数组 → 拒
    - 字段「must_read_files」（★ 必读文件清单（**至少含需求档**））至少要有 1 条
    - 缺少必填字段「must_read_files」（★ 必读文件清单（至少含需求档路径））—— 继任者会从零开始。
✓ 反例⑥b 交接物缺 open_questions → 拒
    缺少 `open_questions` —— 悬而未决的问题**必须显式给**（没有就写空数组）。
    ★ "没问题"和"没写"是两件事：继任者要知道**哪些坑还没填**，才知道该问谁。
```

### 补充（5/5）：水位形态闸 / 未到线 / L0 不启用

```
✓ 补充a ★ 上报水位却不给依据 → 拒
✓ 补充b 依据太短（"差不多"不算依据）
✓ 补充c percent 越界 → 拒
✓ 补充d ★ 水位没到触发线就换班 → 拒
    拒绝继任：席位 writer#1 最近一次上报是 **30%**，低于触发线 55%。
    ★ 没到线就换班 = 白白丢掉一个还记得上下文的席位，新来的还得从头读一遍。
✓ 补充e ★ L0 **故意不启用**继任（档位不在 enabledTiers）→ 拒并说明理由
```

## 13.8 分档：L0 故意不启用继任

| 档位 | 启用？ | 为什么 |
|---|---|---|
| **L0** | **否** | 单文件/单函数级改动，席位上下文本来就不大；而且 L0 的编排由**规则引擎**承担，**没有独立编排对话**来给 `relayPolicy`。真撑不住时直接重新派一个同席位的会话即可（不需要交接物） |
| L1~L5 | 是 | 有独立编排对话，能给出 `relayPolicy` |

## 13.9 既有自测是否仍全过

**是。** 既有 326 项一项没改坏。过程中修了两处 **harness 与真实装配不一致**（同一类问题第二次出现）：

- harness 的 `buildTools` deps **漏了 `counter` / `retireAgent`** → 水位上报直接崩（这次是红灯，不是假绿）
- 之前（第三轮）漏的是 `writers`

现在 harness 那段注释里写着这句话：
**「harness 与真实装配任何一处不一致，对应判据就会没被跑到，而自测可能照样是绿的。」**

```
#  dsh-pipeline 自测汇总：358/358 通过
总计：67/67 通过     ← selftest（正例全流程 + 10 组反例 + 分档）
总计：21/21 通过     ← 装载冒烟（工具数 20 → 22）
总计：22/22 通过     ← 工具定义真编译器校验
总计：38/38 通过     ← 功能开关
总计：23/23 通过     ← 客户端半边
总计：44/44 通过     ← 人工介入（单级路径）
总计：39/39 通过     ← 编写席位 + 架构图（第三轮）
总计：39/39 通过     ← 两级升级梯（第四轮）
总计：33/33 通过     ← 安全确认（第五轮）
总计：32/32 通过     ← ★需求留档 + 水位 + 继任（本轮新增）
```

## 13.10 图里该新增 / 改动的节点与边（给画图的会话）

### 新增节点

| 节点 id | 中文标签 | 放在哪层 | 备注 |
|---|---|---|---|
| `req_doc` | **需求档**（权威需求快照） | 存储层 / 中央 | ★ **画成一个公共节点**，所有角色都指向它 —— 别在每条边上挂副本 |
| `t_orch_doc` | 落需求档 | L3 工具层 | 编排产出任务卡时同步落 |
| `t_context_report` | 上报上下文水位 | L3 工具层 | 百分比 + 依据；附插件侧客观观测 |
| `t_succession` | 席位继任（换班） | L3 工具层 | 只有主对话 |
| `m_context` | 水位与继任机制 | L2 机制层 | `lib/context.js`：relayPolicy / 档位 / 授权 / 计数器 |
| `s_relay` | 水位 + 继任记录 | 存储层 | `context_reports[]` / `successions[]` |
| `water_level` | 水位档位 | 角色/状态之间 | 绿 45% / 橙 **55%** / 红 75% 三段 |
| `seat_gen1` | 席位·第 1 代（`writer#1@1`） | L4 角色层 | 旧席位 |
| `seat_gen2` | 席位·第 2 代（`writer#1@2`） | L4 角色层 | 新席位（**同一角色的不同世代**，不是新角色） |

### 要改的节点

| 节点 id | 原来 | 改成 |
|---|---|---|
| `writer` 等执行角色 | 一个节点 | 需要时**展开成世代**（`@1` → `@2`），但**角色数量不变** |
| `orchestrator` | 产出任务卡 | 补一句：**同时落一份需求档**（路径 + sha256 记进任务卡） |
| `main` | 派活 | 补一句：**没留档不许分发**；**只能在 `relayPolicy` 授权内继任** |
| `m_states` | 状态机 | **不动** —— 继任不改变任务状态（这正是要画出来的点） |

### 新增边

| from → to | 中文标签 | 类型 |
|---|---|---|
| `orchestrator` → `req_doc` | 落需求档（md + json + 历史版本） | dataflow |
| `req_doc` → **所有角色** | ★ **以本地档为准**（读它恢复需求） | dataflow（画成星型，集中到 `req_doc`） |
| `main` → `t_dispatch` | 没留档就分发任务 | **红色虚线** ✗ |
| `main` → `t_dispatch` | 登记了但文件不在盘上 | **红色虚线** ✗ |
| `orchestrator` → `req_doc` | 需求变更 → 新版本（不覆盖） | dataflow（自环，标 `rN → rN+1`） |
| 席位 → `t_context_report` | ① 上报水位（% + 依据） | call |
| `t_context_report` → `water_level` | 判档位 | control |
| `water_level` → 席位 | 预警 45% / 触发 **55%** / 硬限 75% | control（绿 / 橙 / 红三段） |
| 席位 → `t_handoff` | ② 产出 `seat_handover` | call |
| `main` → `t_succession` | ③ 换班（授权内） | call（橙色） |
| `t_succession` → `seat_gen2` | 建新会话 + 新令牌（**同一席位**） | call |
| `seat_gen1` → `seat_gen2` | **交接物 + 世代 +1** | dataflow（橙色实线，标「状态不变」） |
| `t_succession` → `seat_gen1` | **撤旧令牌 + 登记退休** | control（**红色 ✗ 切断**） |
| `main` → `t_succession` | 角色不在 `allowedRoles` | **红色虚线** ✗ |
| `main` → `t_succession` | 次数超 `maxSuccessionsPerSeat` | **红色虚线** ✗ |
| `main` → `t_succession` | 没上报过水位 / 没到触发线 | **红色虚线** ✗ |
| 席位 → `t_context_report` | 上报却不给依据 | **红色虚线** ✗ |
| 席位 → `t_handoff` | 交接物缺 `must_read_files` / `open_questions` | **红色虚线** ✗ |
| L0 席位 → `t_succession` | L0 请求继任 | **红色虚线** ✗（标注「故意不启用」） |

### 明确**不该**画的东西

1. **不要**把 `seat_gen2` 画成"新增了一个 `writer` 角色" —— 角色数量不变。
2. **不要**在 `t_succession` 与 `m_states` 之间画"状态迁移"边 —— 继任**不改变状态**，
   这正是它与"重开一局"的区别。
3. **不要**在每条角色边上挂一份"需求副本" —— 需求档是**一个**公共节点。

### 配色建议

| 元素 | 建议 |
|---|---|
| `req_doc` | 用一个**醒目的大节点**（书/文件形状），放在图中央偏左；所有角色向它汇聚 |
| 水位三段 | 绿（正常）/ 黄（预警 45%）/ 橙（触发继任 **55%**）/ 红（硬限 75%） |
| 继任边 | **橙色实线**，标「世代 +1 / 状态不变」 |
| 旧席位被切断 | **红色虚线加粗**，标「令牌已撤 + 已登记退休」 |
| L0 例外 | 用**灰色**画（明确"这一档不参与"），别和红色拒绝混淆 |

## 13.11 不确定项

1. **水位是自报的，精度取决于席位自己的判断。** 插件只做三件事：
   要求给依据、附上客观观测、按阈值给指引。**它不能验证那个百分比是否准确** ——
   DSH 没有可用的用量接口（13.2 有源码证据）。装上去之后如果发现席位普遍报得离谱，
   可以考虑把 `observed.tool_calls` 也纳入硬判据（例如"工具调用 < 5 次就声称 55% 一律拒"），
   但那条规则很容易误伤，**目前没做**。
2. **`observed` 只在进程生命周期内累计**。重启之后计数器清零 ——
   一个跨重启的长任务，它的 `observed` 会从 0 重新开始。
   要持久化得把计数器写进任务（代价是每次工具调用都要落盘，太贵），**目前没做**。
3. **需求档的 sha256 只记录、不校验**。任务卡里存了哈希，但没有任何一步**回头核对**
   "文件现在的内容还是不是登记时那一版"。要真正防篡改得在每次读取时校验，
   而那会让读需求变成一次哈希计算 —— **目前没做**（登记本身对"发现被人改过"已经有价值）。
4. **继任后的"新席位"用什么模型/什么提示词**，由 transport 决定，本插件不管。
   如果新席位的提示词里没有"先读需求档"，它可能不会主动读 ——
   继任返回的文案里写了这一步，但**那只是一句建议**。
5. **`seat_handover` 的 `reason` 里要求写水位，但没做格式校验**。
   写了"水位 55%"和写了"我累了"都能过 —— 与 13.11 第 1 条同源。
6. **多席位场景下每个席位各自累计继任次数**（键是 `seat`）。
   所以三个编写席位各可以继任 2 次 —— 全任务最多 6 次换班。
   如果希望"整任务一个总上限"，得改 `checkRelayAuthorization` 的计数口径，**目前没做**。

---

# 十四、三处更正（第七轮）

> 用户对上一轮（第十三节）的设计给出了三条明确更正。这一节记录**改了什么**、
> **旧设计哪部分被推翻**、以及**为什么**。

## 14.1 六轮的产物分属（哪部分属于哪一轮）

| 轮次 | 报告章节 | 内容 | 自测 |
|---|---|---|---|
| 第三轮 | 第十节 | 架构图角色 + 编写 1~3 席位 | `writers-check.mjs`（39 项） |
| 第四轮 | 第十一节 | 两级升级梯 | `ladder-check.mjs`（39 项） |
| 第五轮 | 第十二节 | 安全确认 | `security-check.mjs`（33 项） |
| 第六轮 | 第十三节 | 需求留档 + 水位 + 继任（**初版**） | —— |
| **第七轮（本次）** | **第十四节** | **对第十三节的 A/B/C 三处更正** | `relay-check.mjs`（**48 项**，已按更正重写） |

**第十三节里被推翻的部分在 14.5 单列**，免得读旧内容时被误导。

## 14.2 更正 A · 需求档不登记进任务卡

### 改了什么

| | 第十三节（旧） | **第十四节（新）** |
|---|---|---|
| 路径 | 记进 `task.requirement_doc` | **靠目录约定推导**，任务卡里**没有**这个字段 |
| 主对话 | 知道文件在哪 | **不引用、不需要知道** |
| 守门判据 | "任务卡有没有登记路径" + "文件在不在" | "**文件在不在**" + "**版本可不可追溯**" |
| 写权 | 没限制 | **独占给编排**，其他角色只读 |

### 为什么（用户给的理由）

> 「任务卡登记不放在一起（目的，**每个 AI 只干自己的事**）」

- 路径是**推出来的**，不需要谁告诉它 —— 任何角色要需求，**自己去约定目录读**；
- 上游少一个"传路径"的动作，下游多一分自主。

### 实现

```
<项目根>/.pipeline/<taskId>/requirement.md            ← 当前版本（人读）
<项目根>/.pipeline/<taskId>/requirement.json          ← 当前版本（机读）
<项目根>/.pipeline/<taskId>/requirement.index.json    ← ★ 版本索引 = "可追溯"的凭据
<项目根>/.pipeline/<taskId>/requirement.rN.md / .rN.json ← 每一版历史（绝不覆盖）
```

版本索引里每一版都有 `sha256` / `at` / `amended_by` / `supersedes` / `diff_summary`：

```jsonc
{ "version": "r2", "sha256": "…", "at": "…", "amended_by": "orchestrator",
  "supersedes": "r1", "diff_summary": "由 r1 → r2；正文有改动；说明：需求微调：导出格式要带 BOM" }
```

### "可追溯"落在了四条守门上

分发任务时查四件事：

| 情形 | 错误码 |
|---|---|
| 约定目录下没有 `requirement.md` | `NO_REQUIREMENT_DOC` |
| 有 md 但没有版本索引 | `REQUIREMENT_NOT_TRACEABLE` |
| 索引里有版本，但某版的历史文件不在盘上 | `REQUIREMENT_HISTORY_MISSING` |
| **当前 md 的 sha256 与索引最新一版对不上** | `REQUIREMENT_TAMPERED` |

最后一条最有意思 —— 它抓的是"有人绕过编排直接改了需求档"：

```
拒绝分发任务：当前 requirement.md 的 sha256 与版本索引里最新一版**对不上**。
  索引里最新：r1　4f3a…
  磁盘上实际：　　a91c…
★ 这说明有人绕过了编排直接改了需求档 —— 而**只有编排能写它**。
下一步：查清是谁改的，然后让编排重新落一次档（会把改动记成新版本）。
```

**"写权独占"由守门执法**（文件工具层）：非编排角色写 `requirement.*` 一律拒。
**读不受限制** —— "每个 AI 只干自己的事"的前提正是它自己能读到需求。

**编排角色豁免留档闸**：档是它产出的，先卡它就成死锁
（派编排 → 被"没有档"拒 → 永远产不出档）。

## 14.3 更正 B · 硬限 65%

| 档位 | 第十三节（旧） | **第十四节（新）** |
|---|---|---|
| 预警 `warnPercent` | 45 | **45**（不变） |
| 触发继任 `triggerContextPercent` | 55 | **55**（不变） |
| 硬限 `hardLimitPercent` | ~~75~~ | **65** |

改动只有一处默认值 + 注释；三个值仍须严格递增。自测里加了一条**断言默认就是 45/55/65**，
以及一条"66% 落在硬限档"的实测。

## 14.4 更正 C · 分配 AI = 编排 AI（**这条推翻了旧设计**）

### 用户原话

> 「主对话和分配 AI 是两个，我指的就是**交给编排 ai**」

### ★ 被推翻的旧设计：`relayPolicy` 预先授权给主对话

第十三节的设计是：编排在 `relayPolicy` 里**预先授权**，然后**主对话执行继任**。
**这条作废了。** 具体作废的是：

| 旧设计 | 现在 |
|---|---|
| 水位上报给 `main` | 水位上报给 **`orchestrator`** |
| `relayPolicy.requireOrchestratorApproval` 字段（"要不要编排复核"） | **删掉** —— 编排**就是**决策者，没有"要不要它复核"这回事 |
| 主对话执行继任（在授权内） | **编排执行继任**；主对话**不参与分配** |
| 守门拦"主对话超出授权" | 守门拦"**主对话试图参与继任指派**" |

`relayPolicy` **本身保留**（阈值、次数上限、角色白名单、启用档位都还有用），
但它的性质变了：从"**给主对话的授权书**"变成"**编排自己掌握的策略**"。

### 新流向

```
   执行席位(55%)  ──①上报水位──►  编排 AI（orchestrator）★ 分配 AI
                                        │
                                        │ ②决定追加席位 + 指派继任者 + 更新席位清单
                                        ▼
   旧席位        ◄──③「你的继任者是 X，请交接」──  编排 AI
        │
        │ ④提交 seat_handover
        ▼
   新席位  ──⑤接管同一席位（succeeds: 旧席位）──►  任务**从原状态继续**
```

### ★ 好消息：「主对话不能自行增删角色」**完全不用破**

第十三节为了自圆其说，把继任包装成"授权内的例外"。现在不需要了：

**继任本来就是编排的本职** —— 它是角色/席位清单的权威，追加/指派继任者正是它该做的事。
所以：

- 主对话**不参与分配**，只做「更新状态、跟踪、最终关单」；
- 那条既有约束**一个字都不用改**，也**不存在"越权"的张力**。

拒绝文案直接写清了这层关系：

```
拒绝：主对话**不参与继任指派**。
★ 分配 AI 是**编排 AI**（orchestrator），不是主对话 —— 追加/指派继任者本来就是编排的本职。
主对话只负责**更新状态、跟踪、最终关单**。
（唯一的例外：给**编排席位自己**换班 —— 指派者不能是自己，那时主对话按"清单不变"原则兜底。
  本次要换的是「writer」，不在那个例外里。）
```

## 14.5 ★ 编排自己到 55%/65% 怎么办（用户点名要回答的坑）

**问题**：编排是**指派者**，而**指派者不能是自己**。它到线了，谁来给它换班？

**规则（选定）**：**编排席位的继任，由主对话按"清单不变"原则执行。**

**三种方案的取舍**：

| 方案 | 问题 | 结论 |
|---|---|---|
| 编排自己指派自己 | 逻辑上荒谬（指派者不能是自己）；而且它到 65% 时已经没余力做判断 | ✗ |
| 由 `security` / `arbiter` 接手 | **会改变角色清单**（新增一个"能指派继任"的角色）—— 那才是真正的角色变更，得走 `roster_review` | ✗ |
| **主对话兜底** | 不新增、不删减任何角色，清单原封不动；范围**死限**在 `role === 'orchestrator'` | **✓ 选它** |

**为什么这是"兜底"而不是"给主对话开权"**：

- 它是**唯一**的例外 —— 主对话给**任何别的角色**指派继任都会被拒（反例② 实测）；
- 它**一个角色都没加、没减**，所以与既有约束不冲突；
- 判据写在 `checkSuccessionActor` 里，是**一个函数、两条分支**，不是散落的特判。

自测**正例③** 覆盖这条路径：编排上报 58% → 编排产出自己的交接物 →
**主对话兜底继任** → 旧编排不得再写 → 新编排接着干活（重新编排落新版本）。

## 14.6 实测：三个正例 + 六类反例

命令：

```powershell
cd dsh-pipeline
node tests\relay-check.mjs
```

完整输出：[`tests/relay-check-last-run.txt`](tests/relay-check-last-run.txt)。

### A. 需求留档（8/8）

```
✓ A ★ 任务卡里**没有**需求档路径（更正 A：不登记在一起）
    task.requirement_doc = null
    任务卡里跟 require 有关的键：（一个都没有）
✓ A ★ 按**目录约定**就能找到 requirement.md（不需要谁告知）
    约定路径：.pipeline/T-…/requirement.md（1234 字符）
✓ A 它是人可读的 markdown（需求原文 / 验收标准 / 安全面 / 以本文件为准）
✓ A 结构化 JSON 也在约定目录里
✓ A ★ 版本索引存在，记了 sha256 / 时间 / 谁改的（这就是"可追溯"）
✓ A 需求变更可以重新编排（落新版本）
✓ A ★ 版本化可追溯：新版本 + supersedes + 差异摘要，历史**不覆盖**
    版本链：
        r1  sha256=…  supersedes=(无)  diff=（首版）
        r2  sha256=…  supersedes=r1    diff=由 r1 → r2；正文有改动；说明：需求微调：导出格式要带 BOM
✓ A 历史版本文件留在盘上（r1 还能读到）
✓ A ★ **写权独占**：编写角色想改需求档 → 拒（只有编排能写）
    [pipeline] 拒绝：**需求档只有编排（orchestrator）能写**，你是「writer」。
    ★ 需求档是**权威需求快照** —— 所有角色默认以它为准。
      如果谁都能改它，"以本文件为准"就成了一句空话（每个人都能把自己想要的需求写进去）。
✓ A 对照：**读**需求档不受限制（任何角色都能自己读）
```

### 正例①：席位 55% → 上报**编排** → 编排指派 → 交接 → 新席位接管（8/8）

```
✓ 正例① 席位上报 55%（达触发线）
    水位已上报：CR-…　writer（writer#1）　**55%**　档位：触发继任
    依据：已读 12 个文件、跑了 30 轮，上下文里压着 3 份大报告
    插件侧客观观测：工具调用 3 次，活跃 0 分钟
    阈值（来自编排的 relayPolicy）：预警 45% / 触发继任 55% / 硬限 65%
✓ 正例① ★ 到线时**通知的是编排 AI**（分配 AI），不是主对话
    ✅ 已通知**分配 AI（编排）**：fake-agent-002
✓ 正例① 旧席位产出 seat_handover（四个必填清单都在）
✓ 正例① ★ **编排**（分配 AI）指派继任者
    席位继任完成：SC-…
    席位：writer#1（writer）　第 2 代
    交接物：H-…
    旧会话：fake-agent-004（令牌已撤销 + 已登记退休，**不得再写**）
    新会话：fake-agent-010
    ★ 任务状态**没有变** —— 继任是换班，不是重开。
✓ 正例① ★ 任务**状态没有变**（继任是换班，不是重开）      状态：developing → developing
✓ 正例① 全程留痕：水位 → 交接 → 继任
    相关动作：context:report → handoff:seat_handover → seat:succession
```

### 正例②：★ 模拟上下文丢失（4/4）

```
✓ 正例② ★ 全新会话**只按目录约定**找到 requirement.md（不依赖任务卡、不依赖主对话告知）
    读的是：.pipeline/T-…/requirement.md（约定路径）
✓ 正例② ★ 能说清"要做什么"
✓ 正例② ★ 能说清"验收标准是什么"
✓ 正例② ★ 新席位的全新会话能直接继续推进（编写交测试）
    交接物已提交：H-…（编写交付给测试，编写 → tester）。
    任务状态：开发中 → 待测试。
```

### 正例③：★ 编排自己到 58%（7/7）

```
✓ 正例③ ★ 编排自己上报水位 58%
✓ 正例③ 编排产出自己的交接物
✓ 正例③ ★ 编排席位自己的继任：**主对话兜底**（唯一的例外，因为指派者不能是自己）
    席位继任完成：SC-…
    席位：orchestrator（orchestrator）　第 2 代
✓ 正例③ 任务状态仍然**不变**      状态：developing → developing
✓ 正例③ ★ 继任**没有改变角色清单**（清单原封不动）
    execution_roles：architect/writer/tester/reviewer/diagrammer →（不变）
    继任记录 role=orchestrator generation=2
✓ 正例③ 旧编排席位继任后不得再写
✓ 正例③ ★ 新编排席位能接着干活（重新编排落新版本）
```

### 反例①：未上报水位就继任（1/1）

```
✓ 反例① 没上报水位就请求继任
    拒绝继任：席位 writer#1 **从未上报过上下文水位**。
    ★ 继任必须有依据 —— "我觉得它快满了"不是依据。
    下一步：先让该席位调 pipeline_context_report 上报水位（百分比 + 依据）。
```

### 反例②：★ 主对话试图参与继任指派（2/2）

```
✓ 反例② ★ 主对话试图给**执行席位**指派继任 → 拒（它只该收状态）
    拒绝：主对话**不参与继任指派**。
    ★ 分配 AI 是**编排 AI**（orchestrator），不是主对话 —— 追加/指派继任者本来就是编排的本职。
    主对话只负责**更新状态、跟踪、最终关单**。
    （唯一的例外：给**编排席位自己**换班 —— 指派者不能是自己，那时主对话按"清单不变"原则兜底。
      本次要换的是「writer」，不在那个例外里。）
✓ 反例② 没有产生任何继任记录
```

### 反例③：旧席位继任后继续写（1/1）

```
✓ 反例③ ★ 旧席位在继任后继续写 → 拒（令牌已撤 + 已登记退休）
    [pipeline] 拒绝：本会话所属的席位已经**继任换班**了（它的令牌已撤销）。
    ★ 继任是**换班** —— 工作由新席位接着做，旧席位不得再写、不得再提交、不得再推进。
    为什么这条要单独判：令牌撤销之后角色绑定就没了，普通判据会把它当成"无关会话"放行。
```

### 反例④：继任次数超上限（2/2）

```
✓ 反例④ ★ 继任次数超 maxSuccessionsPerSeat → 拒
    席位 writer#1 已经继任 1 次，达到上限 1 次。
    ★ 反复换班说明问题不在"上下文不够"，而在别处（任务太大？拆分不合理？需求没定？）。
    下一步：**回编排复核** —— pipeline_roster_request 提出。
    主对话不得自行突破这个上限。
```

### 反例⑤：交接物缺三个 ★ 清单（3/3）

```
✓ 反例⑤a 交接物 must_read_files 空 → 拒
    - 字段「must_read_files」（★ 必读文件清单（**至少含需求档**））至少要有 1 条
✓ 反例⑤b 交接物缺 open_questions → 拒
    缺少 `open_questions` —— 悬而未决的问题**必须显式给**（没有就写空数组）。
    ★ "没问题"和"没写"是两件事：继任者要知道**哪些坑还没填**，才知道该问谁。
✓ 反例⑤c 交接物缺 do_not_repeat → 拒
    缺少 `do_not_repeat` —— 走过的弯路**必须显式给**（没有就写空数组）。
    ★ 继任者最贵的一课，就是把前人踩过的坑再踩一遍；不写等于让它自己再发现一次。
```

### 反例⑥：需求档缺失 / 版本不可追溯 → 不许开工（4/4）

```
✓ 反例⑥a ★ 版本索引不在 → 不可追溯 → 拒
    拒绝分发任务：需求档存在，但**没有版本索引**（requirement.index.json）。
    ★ "可追溯"指的是：知道现在是第几版、每一版的 sha256 是什么、谁在什么时候改的、
      改之前长什么样。光有一个 md 文件做不到这些。
✓ 反例⑥b ★ 约定目录下没有 requirement.md → 拒
    拒绝分发任务：约定目录下**没有需求档**（找的是 .pipeline/T-…/requirement.md）。
    ★ 规矩：编排产出任务卡时必须同时落一份本地需求档 —— **没有留档就不许开工**。
       路径是**目录约定**推出来的，不需要谁告诉你；任何角色需要需求时自己去读。
✓ 反例⑥c ★ 需求档被绕过编排直接改过（sha256 对不上）→ 拒
✓ 反例⑥d ★ 历史版本文件被删 → 追溯链断了 → 拒
    拒绝分发任务：版本索引里记了 1 版，但有 1 版的历史文件不在盘上。
      · r1（requirement.r1.md）
    ★ 历史被删掉 = 追溯链断了。宁可重建也不要删历史。
```

### 补充（6/6）

```
✓ 补充 ★ 三级阈值默认是 **45 / 55 / 65**（更正 B）
    relay_policy = {"warnPercent":45,"triggerContextPercent":55,"hardLimitPercent":65,…}
✓ 补充a ★ 上报水位却不给依据 → 拒
✓ 补充b percent 越界 → 拒
✓ 补充c ★ 66% 落在**硬限**档（硬限 65）→ "只允许交接与收尾"
✓ 补充d ★ 水位没到触发线就换班 → 拒
✓ 补充e ★ L0 **故意不启用**继任 → 拒并说明理由
```

## 14.7 实现时踩到的两个真陷阱

### 陷阱一：只撤令牌不够（越撤越放行）

继任要"旧席位不得再写"。**撤了令牌之后角色绑定就没了**，`roleOfAgent` 返回 null，
守门第 0 步会把它当成**"与流水线无关的会话"直接放行**。

修法：退休名单**单独维护**，并排在所有放行分支**之前**。

### 陷阱二：非编写角色没有 roster 席位

`writer` 有 `writer#1/#2/#3`，但 `orchestrator` / `tester` 的令牌里 `seat` 是 `null`。
用 `seat || role` 当"席位 key"必须**两边都归一化**（报告侧用 `r.seat ?? r.role`），
否则**编排自己的水位上报永远匹配不上** —— 正例③ 一开始就是这么挂的。

## 14.8 既有自测是否仍全过

**是。** 既有 326 项一项没改坏（第十三节的 32 项已按更正重写为 48 项）。

```
#  dsh-pipeline 自测汇总：374/374 通过
总计：67/67 通过     ← selftest（正例全流程 + 10 组反例 + 分档）
总计：21/21 通过     ← 装载冒烟
总计：22/22 通过     ← 工具定义真编译器校验
总计：38/38 通过     ← 功能开关
总计：23/23 通过     ← 客户端半边
总计：44/44 通过     ← 人工介入（单级路径）
总计：39/39 通过     ← 编写席位 + 架构图（第三轮）
总计：39/39 通过     ← 两级升级梯（第四轮）
总计：33/33 通过     ← 安全确认（第五轮）
总计：48/48 通过     ← ★需求留档 + 水位 + 继任（第六轮 + 第七轮更正）
```

## 14.9 图里该新增 / 改动的节点与边（给画图的会话）

### ★ 本条更正最重要的三处画法

1. **水位上报的箭头指向 `orchestrator`，不是 `main`** —— 画错整张图的语义就反了。
2. **需求档的写入边只从 `orchestrator` 出发**（写权独占）；读的边从所有角色汇聚过去。
3. **主对话只有三条边**：跟踪 / 更新状态 / 关单。**不要**给它画分配相关的实线
   （唯一例外：给编排席位兜底换班的那条**虚线**）。

### 新增节点

| 节点 id | 中文标签 | 放在哪层 | 备注 |
|---|---|---|---|
| `req_index` | **需求档版本索引** | 存储层 | `requirement.index.json` —— "可追溯"的凭据 |
| `write_lock` | **写权独占**（只有编排能写需求档） | 守门层 | 用锁/钥匙形状 |
| `traceability_gate` | **版本可追溯闸** | 分发前 | 查四条：存在 / 有索引 / 历史在 / sha256 对得上 |
| `allocator` | **分配 AI**（= 编排 AI） | 角色层 | ★ 可以和 `orchestrator` 画成同一节点，**但一定要标出"分配 AI"这个别名** |
| `gen1` / `gen2` | 席位·第 1 / 第 2 代 | 角色层 | 旧席位 → 新席位（**同一角色**） |

### 要改的节点

| 节点 id | 原来 | 改成 |
|---|---|---|
| `main` | 派活 + 关单 | 补一句：**不参与分配**；只跟踪 / 更新状态 / 关单 |
| `orchestrator` | 编排判断 | 补：**分配 AI**（水位收件人 + 继任指派者）+ **需求档唯一写者** |
| `req_doc` | 需求档 | 边上标"**路径靠目录约定，任务卡不登记**" |
| 水位档位 | 45 / 55 / 75 | **45 / 55 / 65** |

### 新增 / 改动的边

| from → to | 中文标签 | 类型 |
|---|---|---|
| 席位 → `orchestrator` | ① 上报水位（**不是主对话**） | call（**橙色实线**） |
| `orchestrator` → 席位 | ② 决定追加 + 指派继任者 | call |
| `orchestrator` → 旧席位 | ③「你的继任者是 X，请交接」 | call |
| 旧席位 → 新席位 | ④ 交接物（must_read_files / key_decisions / open_questions / do_not_repeat） | dataflow |
| 新席位 →（同一席位） | ⑤ 接管（succeeds: 旧席位，**状态不变**） | dataflow |
| `orchestrator` → `s_reqdoc` | **写**需求档（独占） | dataflow（**只此一条**） |
| `s_reqdoc` → 所有角色 | **读**需求档（按目录约定，自己读） | dataflow（星型） |
| `main` → `t_dispatch` | 需求档不存在 / 不可追溯 | **红色虚线** ✗ |
| `main` → `t_succession` | 给**执行席位**指派继任 | **红色虚线** ✗（越权） |
| `main` → `t_succession` | 给**编排席位自己**换班 | **橙色虚线** ✓（唯一例外，标"清单不变"） |
| 非编排角色 → `s_reqdoc` | 写需求档 | **红色虚线** ✗（写权独占） |
| 旧席位 →（任何） | 继任后继续写 | **红色虚线** ✗（已退休） |

### 明确**不该**画的

1. **席位 → `main` 的"上报水位"边** —— 那条边不存在（去的是编排）。
2. 主对话的分配边（除了编排席位兜底那一条虚线）。
3. 把 `req_doc` 挂在任务卡节点上 —— 它**不在**任务卡里。

### 配色建议

| 元素 | 建议 |
|---|---|
| 水位三段 | 绿（45 以下）/ 黄（45–55）/ 橙（55–65）/ **红（65 以上）** |
| 分配链路 | **橙色**（编排 → 席位 → 交接 → 新席位），与"执行链路"的绿色区分开 |
| 主对话 | **灰色**（只跟踪，不做技术判断、不参与分配） |
| `write_lock` | 锁形状，标"只有编排有钥匙" |

## 14.10 不确定项

1. **水位仍是自报的**，精度取决于席位自己的判断（DSH 没有可用的用量接口，13.2 有源码证据）。
   插件只做三件事：要求给依据、附上客观观测、按阈值给指引。**它不能验证百分比是否准确**。
2. **`observed` 只在进程生命周期内累计**，重启清零。
3. **需求档的"可追溯"只到 sha256 对得上这一层**：它能发现"文件被改过"，
   但**不能**告诉你"改得对不对"。要不要在每次读时也校验哈希 —— 会让读需求变成一次哈希计算，
   **目前没做**（分发时校验一次已经足够抓住主要风险）。
4. **主对话兜底编排席位继任这条路径，判据是 `role === 'orchestrator'`**。
   如果将来编排也拆成多席位，这条判据要跟着改（目前编排是单席位）。
5. **`relayPolicy.executor` 字段保留了**（默认 `'orchestrator'`），
   但当前实现**没有读它**去改变行为 —— 它只是把"谁执行"这件事写进数据。
   要真做成可配置（例如切成 `main` 执行）得再改 `checkSuccessionActor`，**目前没做**。
6. **编排席位的 `seat_handover` 里 `from_seat` / `to_seat` 写的是 `'orchestrator'`**（角色名而非席位 id）。
   匹配时两种写法都接受（`seatKey || seat || role`），但文档里没强调 —— 这里补记。

---

# 十五、两条更正（第八轮）

> 用户在第七轮之后又给了两条更正。这一节记录**改了什么**、**被推翻的旧设计**、以及**为什么**。

## 15.1 七轮的产物分属

| 轮次 | 报告章节 | 内容 | 自测 |
|---|---|---|---|
| 第三轮 | 第十节 | 架构图角色 + 编写 1~3 席位 | `writers-check.mjs`（39 项） |
| 第四轮 | 第十一节 | 两级升级梯 | `ladder-check.mjs`（39 项） |
| 第五轮 | 第十二节 | 安全确认 | `security-check.mjs`（33 项） |
| 第六轮 | 第十三节 | 需求留档 + 水位 + 继任（**初版，多处已被推翻**） | —— |
| 第七轮 | 第十四节 | **三处更正**（A 目录约定 / B 硬限 65 / C 分配 AI = 编排） | `relay-check.mjs`（**54 项**） |
| **第八轮（本次）** | **第十五节** | **两条更正**（A 分权落档 + 留档 AI / B 编排自继任 + 广播） | `records-check.mjs`（**23 项**） |

**第十三、十四节里被本轮推翻的部分在 15.5 单列。**

## 15.2 更正 A · 分权落档 + 新增「留档 AI」

### 用户原话

> 「A，ai 独立落档后设密钥提交给单独的留档 ai（新追加），留档 ai 负责收集后再统一编写到
> `<项目根>/.pipeline/<taskId>/requirement.md` 中」

### ★ 被推翻的旧设计：「编排独占写权」

第十四节的设计是：**只有编排能写 `requirement.md`**，其他角色只读。
**这条作废了。** 问题有两个：

1. **别的角色有话说却写不进去** —— 只能靠转述，转述就会丢来源；
2. **那个角色一换人，需求就没人写得动了** —— 又变回单点。

### 现在的分工：分权写 + 专人汇总

| | 写什么 | 谁 |
|---|---|---|
| **各自落档** | `records/<role>[-<seat>].md` + `.json` | **每个角色 / 席位写自己那份**，互不覆盖 |
| **统一编写** | `requirement.md` + `.json` + 版本索引 | **只有留档 AI（`archivist`）** |
| 读 | `requirement.md` | 任何角色（不受限） |

关键点：**提交必须带席位令牌**。留档 AI 校验 **任务 ↔ 角色 ↔ 席位** 三者一致，
**拒绝匿名与冒名**：

```
拒绝收下这份记录：**没有带席位令牌**。
★ 留档 AI 要**校验来路** —— 谁写的、哪个席位、哪一版。拒绝匿名提交。

拒绝收下这份记录：令牌与声明的来路**不符**（冒名）。
  令牌属于：任务 T-… / 角色 writer / 席位 writer#1
  声明的是：任务 T-… / 角色 tester / 席位 (无)
★ 记录的价值全在「这是谁说的」—— 来路不明或冒名的记录，汇总时一文不值。
```

`records/` 的**文件名也是约定**的（`<role>[-<seat>].md`），守门同时挡两条：
**写别人的记录文件**（伪造来源）与**直接写 `requirement.md`**（跳过汇总）。

### 汇总的两条硬规则

**① 不得凭空写入没有记录来源的内容** —— 每条 `source_record` 必须指向一份真实记录：

```
拒绝汇总：有 2 条内容**没有可追溯的来源**。
  · entries[0]：没有 source_record
  · entries[1]：source_record=「RC-不存在的记录」找不到对应的记录
★ 留档 AI **不得凭空写入没有记录来源的内容**。
  否则需求档就不再是「大家说的话的汇总」，而是你自己编的东西。
```

**② 遇到互相矛盾的记录，不得自己拍板**：

```
拒绝汇总：你报告了 1 处**互相矛盾的记录**。
  · 导出格式要不要带 BOM　(RC-0985… vs RC-5fc9…)
★ 留档 AI **不得自己拍板** —— 你的职责是收集与统一编写，不是裁定谁对。
两条出路：① 走 pipeline_clarify_request；② 由编排升级给用户。
（把 conflicts 清空之前，requirement.md 不会被改写。）
```

### 分档：L0 不纳入，L1+ 纳入

| 档位 | 留档 AI | 需求档怎么来 | 理由 |
|---|---|---|---|
| **L0** | **不纳入** | 规则引擎**直接生成**单一需求档 | 单文件/单函数级改动，需求本就一句话；而且 L0 的编排由**规则引擎**承担，没有独立编排对话来派留档 AI |
| L1~L5 | 纳入 | 各方落 `records/` → 留档 AI 汇总 | 需求开始有多方视角（架构 / 编写 / 测试 / 安全…），**分权落档才有意义** |

各档对话数：L0=4 · L1=6 · L2=8 · L3=9 · L4=10 · L5=12（L1+ 各 +1 就是留档 AI）。

### ★ 一个必须说清的顺序（否则死锁）

"没有留档就不许开工" + "只有留档 AI 能写档" = **谁都开不了工**。
所以顺序约定死：

```
① 编排产出任务卡 → 交出的不是 requirement.md，而是**编排自己那份记录**
                     records/orchestrator.md（档位 / 角色 / 验收标准都在里面）
② 主对话派留档 AI  （豁免留档闸）
③ 留档 AI 汇总    → 产出 requirement.md（r1）
④ 其余角色才能派活  （派活时查"档在不在 + 版本可不可追溯"）
```

⇒ 留档闸**豁免 `orchestrator` 与 `archivist`** —— 它们是产出档的人，卡它们就成死锁。

**这条在实现时真的咬到了**：我第一版让编排直接写 `requirement.md`，
结果"唯一写者是留档 AI"和"没有档不许开工"直接互锁。改成"编排交记录"才解开。

## 15.3 更正 B · 编排自己也继任 + 广播新联系人

### 用户原话

> 「B，编排 AI 在慢上下文时也就新建编排 AI 并通知其他 ai 新交接者」

### 改了什么

| | 第七轮（旧） | **第八轮（新）** |
|---|---|---|
| 编排自己到 55%/65% | 主对话按"清单不变"兜底 | **编排自己给自己换班**（就近新建编排席位） |
| 主对话的角色 | 兜底执行者 | **异常路径**的兜底（见下） |
| 换人之后 | 无广播 | ★ **广播新联系人给所有已绑定席位** |
| 席位怎么知道发给谁 | 无从知道 | `pipeline_contacts` 随时可查 |
| 编排的交接物 | 与通用 `seat_handover` 相同 | ★ 额外带**待处理的请求队列** `pending_requests` |

### ★ 编排的交接物多一项：待处理的请求队列

这是**编排特有**的交接项，别漏 —— 否则新编排不知道**谁在等答复**：

```jsonc
{
  "from_seat": "orchestrator",
  "to_seat": "orchestrator",
  "reason": "编排自己到 58%",
  "pending_requests": [                       // ★ 编排专有
    { "from": "writer#1", "about": "导出格式要不要带 BOM？", "waiting_since": "10 分钟前" },
    { "from": "tester",   "about": "测试环境的数据库怎么连？", "waiting_since": "3 分钟前" }
  ]
  // 其余字段与通用 seat_handover 相同
}
```

```
编排的交接物缺少 `pending_requests` —— **待处理的请求队列必须显式给**（没有就写空数组）。
★ 这是编排特有的交接项：谁在等你的答复、等到什么程度了。
  不写的话，新编排不知道有人还在等 —— 那些请求会**永远悬着**。
```

### ★ 广播 + 当前联系人查询

继任发生时插件**自动广播**：

```
【联系人变更】任务 T-… 的**编排 AI（分配 AI）**已换人。

  旧：fake-agent-002（已退场，令牌已撤销，**不要再发给他**）
  新：fake-agent-011　第 2 代
  依据：水位 58%：编排过程读了 20 个文件、写了很长的清单

★ 后续的**水位上报 / 澄清请求 / 任何需要编排裁决的事**，都发给**新编排**。
  不确定当前联系人是谁 → 调 pipeline_contacts 查一下。
```

**为什么广播是必须的**：编排换人了，各席位如果还往旧编排发上报，**那些消息永远没人看**。
而且光广播还不够 —— 席位可能错过一条消息，所以还要**能查**：

```
当前联系人 · 任务 T-…
★ 编排 AI（分配 AI）：fake-agent-011　第 2 代　（orchestrator）
各席位当前占位：
  · writer / writer#1 → fake-agent-004
已退场（继任换掉的旧会话）：1 个
  · orchestrator　第 2 代：fake-agent-002 → fake-agent-011
```

上报时可以**指定收件人**，指定到已退场的那个就当场拦下并指出当前联系人：

```
拒绝：你要发给的编排 fake-agent-002 **不是当前联系人**。
  当前：fake-agent-011（第 2 代）
  你要发的：fake-agent-002
★ 编排自己也会继任 —— 发给一个已经退场的席位，那条消息永远不会有人看。
```

### ★ 异常路径：编排没产出继任者就撞硬限

**不许静默失联。** 三种情形的分工：

| 情形 | 谁来做 |
|---|---|
| 正常情况下编排到线 | **编排自己**给自己换班 |
| 编排撞到 **65% 硬限**，且**没有产出继任者** | **主对话**按"清单不变"原则触发例外处理 |
| 主对话也办不成（连交接物都没有） | **明确升级**：`pipeline_human_request`，说明「编排席位已满、且没有交接物」，让用户决定 |

主对话在这条路径上是**唯一被允许**执行继任的角色，而且范围**死限**在 `role === 'orchestrator'`：

```
拒绝：主对话**不参与继任指派**。
★ 分配 AI 是**编排 AI**（orchestrator），不是主对话 —— 追加/指派继任者本来就是编排的本职。
（唯一的例外：给**编排席位自己**换班 —— 指派者不能是自己，那时主对话按"清单不变"原则兜底。
  本次要换的是「writer」，不在那个例外里。）
```

**为什么不由 `security` / `arbiter` 接手**：那会**改变角色清单**（新增一个"能指派继任"的角色）——
那才是真正的角色变更，得走 `roster_review`。而主对话给编排席位换班**不新增、不删减任何角色**。

★ 这是与第七轮**一致**的地方：**主对话不参与分配**这条没有变，只是"编排自己给自己换班"成了正常路径，
主对话那条降级成异常兜底。

## 15.4 实测

```powershell
cd dsh-pipeline
node tests\records-check.mjs     # 23 项：分权落档 + 留档 AI
node tests\relay-check.mjs       # 54 项：水位 / 继任 / 编排自继任 + 广播
```

完整输出：[`tests/records-check-last-run.txt`](tests/records-check-last-run.txt) · [`tests/relay-check-last-run.txt`](tests/relay-check-last-run.txt)。

### 正例①：各角色独立落档 + 带密钥提交 → 留档 AI 汇总（records-check）

```
✓ 正例① 编写席位提交**自己那份**记录（带令牌）
    记录已收下：RC-098576d57f6a83c3（writer / writer#1，第 1 版）
    落盘：.pipeline/T-…/records/writer-writer1.md（… 字符，sha256 b3ee2bb72d96…）
    来路已校验：令牌 ↔ 角色 ↔ 席位三者一致。
✓ 正例① ★ 三份记录**互不覆盖**（各写各的，路径按角色/席位区分）
    records/ 下：writer-writer1.md / tester.md / architect.md（三份都在）
✓ 正例① 每条提交都登记了**来源**（record_id / 谁提交 / 何时 / sha256）
    RC-43f37658ae81ce9e  orchestrator  2026-10-10T22:34:55Z  sha256=28cca4915ac0…
    RC-098576d57f6a83c3  writer/writer#1  2026-10-10T22:34:55Z  sha256=b3ee2bb72d96…
    RC-5fc9bd6ff1b31ef3  tester  2026-10-10T22:34:55Z  sha256=0a9b81a40cd1…
✓ 正例① ★ 留档 AI 把四方记录汇总成唯一的需求档
    需求档已汇总：r1（sha256 8fce7a0d4ae831ce…）
    来源：4 条内容，来自 3 份记录
    路径（目录约定）：.pipeline/T-…/requirement.md
✓ 正例① ★ 汇总出的 requirement.md 逐条标注来源（可追溯）
    <sub>来源：RC-43f37658ae81ce9e（orchestrator，第 1 版，…）</sub>
    <sub>来源：RC-5fc9bd6ff1b31ef3（tester，第 1 版，…）</sub>
✓ 正例① 版本与差异照旧维护（v1/v2… 可追溯）
    { "version": "r1", "sha256": "…", "amended_by": "archivist", "supersedes": null, … }
```

### 反例（records-check 全 6 条）

```
✓ 反例① ★ 非留档 AI 直接写 requirement.md → 拒
    [pipeline] 拒绝：**需求档只有留档 AI（archivist）能写**，你是「writer」。
    ★ 现在它是**分权写 + 专人汇总**出来的：各角色在 records/ 下写自己那份，
      留档 AI 收集后统一编写成这一个文件（每条内容都标了来源，可逐条追溯）。
✓ 反例②a ★ 来路不明（没有令牌）的提交 → 拒
    无法确定调用方角色：既没有绑定会话，也没有携带 role_token。
✓ 反例②b ★ 冒名（拿别人的令牌冒充别的角色）→ 拒
    拒绝收下这份记录：令牌与声明的来路**不符**（冒名）。
    令牌属于：任务 T-… / 角色 writer / 席位 writer#1
    声明的是：任务 T-… / 角色 tester / 席位 (无)
✓ 反例②c ★ 席位不符（拿 1 号的令牌认 2 号的名）→ 拒
    拒绝收下这份记录：令牌的席位是「writer#1」，声明的是「writer#2」。
    ★ 只能提交**自己那份**。
✓ 反例③ ★ 留档 AI 写入**无来源内容** → 拒（不得凭空写入）
✓ 反例③b ★ 记录**互相矛盾**时留档 AI 不得自己拍板 → 拒并指路提问/升级
✓ 反例③c 非留档 AI 调汇总工具 → 拒
✓ 反例③d 留档 AI 给自己提交记录 → 拒（它不该把自己写进来源里）
✓ 反例③e ★ 写**别人那份**记录 → 拒（等于伪造来源）
✓ 对照：读需求档 / 写自己那份记录 都不受拦
```

### 正例②③ 与反例（relay-check）

```
✓ 正例③ ★ 编排自己上报水位 58%
✓ 正例③ 编排产出自己的交接物（**含待处理请求队列**）
✓ 正例③ ★ 编排的交接物**缺待处理请求队列** → 拒（别人还在等他答复）
✓ 正例③ ★ **编排自己**给自己换班（分配 AI 就近新建编排席位）
    席位继任完成：SC-…
    席位：orchestrator（orchestrator）　第 2 代
    ★ 新联系人广播：已广播给 5 个席位
✓ 正例③ ★ **广播了新联系人**给所有已绑定席位
✓ 正例③ ★ 继任**没有改变角色清单**（清单原封不动）
    execution_roles：architect/writer/tester/reviewer/diagrammer/archivist →（不变）
✓ 正例③ ★ 任何席位都能查到**当前联系人**（当前编排是谁）
✓ 正例③ 联系人查询给出了**新编排**的会话 id（不是旧的那个）
✓ 反例⑥ ★ 上报发给**已退场的编排** → 拒并指出当前联系人
    拒绝：你要发给的编排 fake-agent-002 **不是当前联系人**。
    当前：fake-agent-011（第 2 代，自 … 起）
    ★ 编排自己也会继任 —— 发给一个已经退场的席位，那条消息永远不会有人看。
✓ 反例⑥ 对照：发给**当前**编排，正常放行
```

### 既有自测是否仍全过

**是。** 老 374 项一项没改坏。

```
#  dsh-pipeline 自测汇总：408/408 通过
总计：69/69 通过     ← selftest（正例全流程 + 12 组反例 + 分档）
总计：21/21 通过     ← 装载冒烟（工具 22 → 25）
总计：22/22 通过     ← 工具定义真编译器校验
总计：38/38 通过     ← 功能开关
总计：23/23 通过     ← 客户端半边
总计：44/44 通过     ← 人工介入（单级路径）
总计：39/39 通过     ← 编写席位 + 架构图（第三轮）
总计：39/39 通过     ← 两级升级梯（第四轮）
总计：33/33 通过     ← 安全确认（第五轮）
总计：54/54 通过     ← 需求水位 + 继任 + 编排自继任 + 广播（第六/七/八轮）
总计：23/23 通过     ← ★分权落档 + 留档 AI（第八轮新增）
```

## 15.5 ★ 被本轮推翻的旧设计（读旧章节时注意）

| 旧设计（第六/七轮） | 现在 | 在哪一节 |
|---|---|---|
| **只有编排能写 `requirement.md`** | **只有留档 AI 能写**；编排只交自己那份记录 | 13.3 / 14.2 |
| 编排"预先授权、主对话执行继任" | 编排**自己**给自己换班；主对话只做异常兜底 | 13.4 / 14.4 |
| 编排换人无广播 | **广播新联系人** + `pipeline_contacts` 可查 | 14.9 |
| 编排的交接物 = 通用 `seat_handover` | 额外必须带 `pending_requests` | 14.9 |
| 需求档由编排一步落成 | 分权落 `records/` → 留档 AI 汇总 | 14.2 |

**没被推翻、仍然有效的**：目录约定（任务卡不登记路径）· 版本可追溯闸 ·
**分配 AI = 编排 AI** · **主对话不参与分配** · 水位 45/55/65 · 退休席位名单 · L0 不启用继任。

## 15.6 图里该新增 / 改动的节点与边（给画图的会话）

### ★ 本轮最重要的四处画法

1. **`requirement.md` 的写入边只从 `archivist` 出发**（唯一写者）；
   各角色 → `records/` 是**另一组独立边**（各写各的，互不交叉）。
2. **编排有一条指向自己的继任边**（自环），旁边挂**广播扇形边**连到所有已绑定席位。
3. **`pending_requests` 挂在编排的交接物上** —— 单独画一个附件节点，别省。
4. **主对话只有三条实线**：跟踪 / 更新状态 / 关单；它对继任只有一条**橙色虚线**
   （编排没产出继任者时的异常兜底）。

### 新增节点

| 节点 id | 中文标签 | 放在哪层 | 备注 |
|---|---|---|---|
| `archivist` | **留档 AI** | 角色层 | ★ `requirement.md` 的唯一写者 |
| `records_dir` | **各方记录目录** | 存储层 | `records/<role>[-<seat>].md`，各写各的 |
| `t_record_submit` | 提交自己的记录 | L3 工具层 | 带令牌，校验来路 |
| `t_compile` | 汇总需求档 | L3 工具层 | 只有留档 AI |
| `t_contacts` | 查当前联系人 | L3 工具层 | 行动前先查 |
| `cred_check` | 来路校验（令牌 ↔ 角色 ↔ 席位） | 守门层 | 拒绝匿名 / 冒名 |
| `source_gate` | 来源闸（每条必须有 source_record） | 守门层 | 无来源 → 拒 |
| `conflict_gate` | 矛盾闸（矛盾不得自己拍板） | 守门层 | 有矛盾 → 拒 + 指路提问 |
| `pending_q` | **待处理的请求队列** | 附件节点 | 挂在编排的 `seat_handover` 上 |
| `broadcast` | **新联系人广播** | 事件 | 扇形连到所有已绑定席位 |

### 要改的节点

| 节点 id | 原来 | 改成 |
|---|---|---|
| `orchestrator` | 需求档唯一写者 | **不写需求档**；交 `records/orchestrator.md`；★ **可以给自己换班** |
| `req_doc` | 由编排写入 | 由 **`archivist`** 汇总写入 |
| `main` | — | 补：继任只走**异常兜底**（编排没产出继任者就撞硬限） |
| 角色表 | 12 个角色 | **13 个**（+ `archivist`「留档」） |

### 新增 / 改动的边

| from → to | 中文标签 | 类型 |
|---|---|---|
| 各角色 / 席位 → `records_dir` | ★ 各写各的（互不覆盖） | dataflow（**平行不交叉**） |
| 任何角色 → `t_record_submit` | 提交 + 带令牌 | call |
| `t_record_submit` → `cred_check` | 校验来路 | control |
| `cred_check` → 提交者 | 匿名 / 冒名 | **红色虚线** ✗ |
| `archivist` → `t_compile` | 收集 + 统一编写 | call |
| `t_compile` → `source_gate` | 每条要有来源 | control |
| `source_gate` → `archivist` | 无来源 | **红色虚线** ✗ |
| `t_compile` → `conflict_gate` | 矛盾不得拍板 | control |
| `conflict_gate` → `t_clarify` | 走提问 / 升级 | call（橙色） |
| `archivist` → `req_doc` | ★ **唯一写入边** | dataflow（**只此一条**） |
| 非留档 AI → `req_doc` | 直接写需求档 | **红色虚线** ✗ |
| 任何角色 → `records_dir` | 写**别人那份** | **红色虚线** ✗（伪造来源） |
| `req_doc` → 所有角色 | 以本地档为准（自己读） | dataflow（星型） |
| `orchestrator` → `orchestrator` | ★ **编排给自己换班** | call（**自环**，橙色） |
| `orchestrator`(新) → 所有已绑定席位 | ★ **广播新联系人** | event（**扇形**，标「新联系人 = X」） |
| 旧 `orchestrator` →（任何） | 已退场 | **红色虚线** ✗（切断） |
| 任何席位 → `t_contacts` | 查当前编排是谁 | call |
| 任何席位 → `t_context_report` | 上报发给**已退场的编排** | **红色虚线** ✗ 并指出当前联系人 |
| `orchestrator` → `t_handoff` | 交接物缺 `pending_requests` | **红色虚线** ✗ |
| `main` → `t_succession` | 编排没产出继任者就撞硬限 | **橙色虚线** ✓ 例外处理 |
| `main` → `t_human_request` | 例外处理也办不成 | **橙色虚线** ✓ 明确升级 |

### 明确**不该**画的

1. `main` → 继任的**实线**（主对话不参与分配；只有异常兜底的虚线）。
2. 把 `records_dir` 和 `req_doc` 画成一个节点 —— 它们是**两级**：记录 → 汇总。
3. 席位 → 旧编排的上报边（那条边**必须**指向当前编排）。

### 配色建议

| 元素 | 建议 |
|---|---|
| `records/` → `requirement.md` | **汇聚漏斗形**：多条平行边进 `t_compile`，一条出来到 `req_doc` |
| 广播扇形 | **橙色**，箭头统一指向"席位群"，标「新联系人」 |
| 编排自环 | **橙色实线**，标「世代 +1 / 状态不变」 |
| 主对话 | **灰色**（只跟踪）；异常兜底那条用**橙色虚线**区分 |
| 写权独占 | 锁形状挂在 `req_doc` 上，标「只有留档 AI 有钥匙」 |

## 15.7 不确定项

1. **`records/` 的追溯只到"哪份记录"这一层**，**不校验记录内容本身是否属实**。
   留档 AI 能证明"这条是 tester 在 X 时刻说的"，**不能**证明"tester 说得对"。
   要更强的保证得引入交叉验证，**目前没做**（那会让汇总变成第二套审核）。
2. **`pending_requests` 没有自动填充**。它靠编排自己在交接物里如实填写 ——
   插件不追踪"谁在等谁"。所以它是一份**自述**，可能漏。
   要自动填得给每个澄清请求建等待队列，**目前没做**。
3. **广播是"尽力而为"**：`transport.notifyRole` 失败会记进 `broadcast.failed`，
   但**不会重试**。所以 `pipeline_contacts`（可查）是广播的兜底 —— 这也是为什么两个都做了。
4. **`pipeline_contacts` 只列当前进程知道的席位**。重启之后令牌表是空的，
   联系人仍从 `task.json` 的 `contacts` 读得到，但"各席位当前占位"那段会空。
5. **留档 AI 的 `conflicts` 是它自己报的**。插件**不能**自动检测两份记录是否矛盾 ——
   那需要语义比对。所以这条规则是"**报了矛盾就不许拍板**"，而不是"有矛盾一定会被报出来"。
6. **L0 的需求档由规则引擎一次性生成**，之后**不再更新**（L0 没有留档 AI）。
   如果 L0 的需求中途变了，只能重新开单或升级档位，**目前没做**增量更新。

---

# 十六、一次真问题的排查：`records` 套自测"单跑失败、全量通过"

> 用户实测贴了文件证据：`records-last-run.txt`（单跑，06:35:07）显示 **22/23**，
> 而 `last-run.txt`（全量，06:37:03）里同一套是 **23/23**。怀疑是**顺序耦合 / 状态依赖**。
> 这一节记录排查过程与结论。

## 16.1 根因（两个，不是一个）

### ① 直接原因：**我留下的陈旧产物**（不是顺序耦合）

时间线对得上：

| 时刻 | 事件 |
|---|---|
| 06:35:07 | 单跑 `records-check` → **22/23**，失败项「对照：写自己那份记录（守门不挡）」 |
| ~06:36 | 我定位到是**分区判据**误拦了 `records/.` 路径，加了 `taskSelfDir` 豁免（`_d19`/`_d20`） |
| 06:37:03 | 全量跑 → 该套 **23/23** |

失败的原因是**当时确实有个 bug**：编写席位的分区判据把 `.pipeline/<taskId>/records/` 也算进
"项目源码"，于是席位写**自己那份记录**被误拦。修法是给判据加**任务自身目录豁免**
（流水线台账不是任何席位的"那一段"）。

**修完之后我没有重新生成 `records-last-run.txt`** —— 那个文件停在修复前的 22/23。
所以它读起来像"单跑失败、全量通过"，实际上是"**旧文件 vs 新代码**"。

证据：

```
records-last-run.txt  2026/10/11 06:35:07   ← 修复之前
last-run.txt          2026/10/11 06:37:03   ← 修复之后
当前单跑三次：29/29 · 29/29 · 29/29         ← 见 16.4
```

### ② 但用户的怀疑指向了一个**真问题**：守门查索引失败时**静默放行**

用户猜的是"守门要同步查任务索引，而任务在盘上、读取是异步的" —— 这条**成立**，
而且比"空窗期"更严重：不是"刚开始不生效"，而是**索引里查不到 → 那几条判据整段跳过**。

最小复现（`_probe2.mjs`，把任务从索引里拿掉再发同一次调用）：

```
甲 索引有任务   → 写别人的记录  denied=true  :: [pipeline] 拒绝：**只能写自己那份记录**。
乙 索引无任务   → 写别人的记录  denied=false :: （放行）
丙 索引无任务   → 写 requirement.md denied=false :: （放行）
丁 索引无任务   → 越界写别人分区  denied=false :: （放行）
```

**五条文件判据全部 fail-open**，而且是**静默**的 —— 那才是真正危险的地方：
"判据没跑到"和"判据查过了没问题"在日志里**长得一模一样**。

⇒ 所以结论是：**观察到的那次 22/23 是陈旧产物（①），但用户怀疑的机制（②）真实存在，
并且是更该修的那个。**

## 16.2 修法

| # | 问题 | 修法 |
|---|---|---|
| 1 | 陈旧产物被当成"现状"读 | **`run-all.mjs` 自己写每套的 `<suite>-last-run.txt`** —— 让跑测试的人写证据，文件就不可能再漂 |
| 2 | 自测依赖"前一套顺带建了状态" | `records-check` 开头**显式预热索引**并**断言预热生效** |
| 3 | 空窗期**静默** fail-open | 守门命中空窗期时**留痕**（`ctx.logger.warn`，每任务一次），写清影响范围 / 原因 / 怎么缓解 |
| 4 | 空窗期没有覆盖 | 新加**一组专门用例**（5 条），**如实**断言现状而不是假装它生效 |
| 5 | —— | README「拦不住的」第 4 条改写：列出**具体哪五条判据受影响**、为什么不做 fail-closed、怎么缓解 |

**没有删断言、没有改断言掩盖。** 第 4 条那组用例断言的就是"此时放行"：

```js
rec.add('空窗期 ★ 索引里没有该任务时，靠索引的文件判据**整段跳过**（如实断言：此时放行）', ...)
rec.add('空窗期 ★★ **必须留痕**（不许静默放行）：守门报出该判据没生效', ...)
rec.add('空窗期 提示里写清了**影响范围 / 原因 / 怎么缓解**', ...)
rec.add('空窗期 同一个任务**只报一次**（不刷屏）', ...)
rec.add('空窗期 预热回来后判据**立刻恢复**（同一次调用这回被拒）', ...)
```

**为什么保留 fail-open 而不是改成 fail-closed**：索引为空是"还没热身"，不是"调用方可疑"；
一次误拦会打断正当工作（而且守门**抛异常不算拒绝**，会变成内部错误）。
所以选择**fail-open + 强制留痕**。

## 16.3 生产可达性（如实说）

窄，但不是零：

- `tokens` 与 `taskIndex` **都在 `apply()` 里创建**（`index.js:132` / `:172`），
  HMR 重载时**一起重置** → 重载后 `binding === null`，守门在更早的分支就返回了；
- 25 个工具里有 26 处 `indexTask(...)` 调用 —— 几乎每个工具都会登记；
  `bind_role`、`load()` 也都会登记；
- 所以"有 binding 却没有索引"的窗口**很窄**（理论上：绑定的会话在**本次进程**里
  还没做过任何对该任务的流水线动作，就直接发起文件写入）。

但**结构上是 fail-open**：一旦哪里漏登记，就是五条判据同时失效且**没有痕迹**。
留痕之后，这种情况至少会被看见。

## 16.4 复跑验证（原始输出）

### `records-check` 单跑三次

```
第 1 次：总计：29/29 通过   失败项：（无）
第 2 次：总计：29/29 通过   失败项：（无）
第 3 次：总计：29/29 通过   失败项：（无）
```

### 全量一次

```
#  dsh-pipeline 自测汇总：414/414 通过
总计：69/69 通过     ← selftest
总计：21/21 通过     ← 装载冒烟
总计：38/38 通过     ← 功能开关
总计：23/23 通过     ← 客户端半边
总计：44/44 通过     ← 人工介入
总计：39/39 通过     ← 编写席位 + 架构图
总计：39/39 通过     ← 两级升级梯
总计：33/33 通过     ← 安全确认
总计：54/54 通过     ← 水位 + 继任 + 编排自继任 + 广播
总计：29/29 通过     ← 分权落档 + 留档 AI + 守门索引空窗期
每套原始输出也已同步落盘（11 份）
```

（`schema-check` 无汇总行，是"跑通即通过"的断言式套件，退出码 0。）

### 逐套单跑

```
selftest-core    69/69 通过     无失败
load-smoke       21/21 通过     无失败
schema-check     （断言式，退出码 0）
switch-check     38/38 通过     无失败
client-check     23/23 通过     无失败
human-check      44/44 通过     无失败
writers-check    39/39 通过     无失败
ladder-check     39/39 通过     无失败
security-check   33/33 通过     无失败
relay-check      54/54 通过     无失败
records-check    29/29 通过     无失败
```

### ★ 反序跑一遍（主动找顺序耦合）

把十一套**倒序**跑（records → relay → security → ladder → writers → human →
client → switch → load-smoke → selftest）：

```
★ 反序全绿 —— 没有顺序耦合
```

`ladder` / `relay` / `security` / `writers` / `human` / `records` 各**单跑两次**，次次满通过。
⇒ **没有发现同类问题**：其余十套都是自包含的。

## 16.5 这条限制写进了哪一节

| 位置 | 写了什么 |
|---|---|
| `README.md` →「守门：哪些是真拦截，哪些只是约定」→「⚠️ 拦不住的」**第 4 条** | 改写：五条受影响判据的表格 / 为什么不做 fail-closed / 留痕样例 / 怎么缓解 |
| `README.md` →「已知限制」 | 同上引用（第 2 条指向「拦不住的」第 4 条） |
| `tests/records-check.mjs` | 「★ 已知限制：守门的索引空窗期（fail-open，但有留痕）」一组，5 条用例 |
| 本节 16.1–16.3 | 排查过程、最小复现、生产可达性 |

## 16.6 不确定项

1. **留痕走的是 `ctx.logger.warn`**，落在 DSH 日志里，**不是**任务审计（`audit.jsonl`）。
   没写进审计的原因：守门是**同步**的，落盘是异步的 —— 在守门里 await 会破坏它"同步判定"的前提。
   代价：这条提示不进任务的审计流水，翻历史时看不到。
2. **"只报一次"是按 `taskId` 去重、进程内有效**。重启后会再报一次 —— 这是有意的（新进程确实是新状态）。
3. **根因①（陈旧产物）本质是我流程上的错**，不是代码错。程序化生成证据文件能防住**这一类**，
   但防不住"改了代码没重跑" —— 那还得靠纪律。自测里没有"文件新鲜度"的自动校验，**目前没做**。
4. **没有把 `indexTask` 做成"取不到就同步读盘"的兜底**。那需要把守门改成异步，
   而 `guardReason` 的契约是同步的（`dsh-tools:2928`）——改不了。
   折中就是现在的"fail-open + 留痕"。
5. **生产里那个窄窗口没有实测**（自测用的是注入式夹具，不是真会话）。
   要实测得在真 DSH 里跑一个"绑定后立刻写文件"的会话 —— **目前没做**。

---

# 十七、幂等与隔离复查（补充信息之后的第二轮）

> 用户补充：那条 22/23 自己复跑两遍都是 23/23，且 `records-check.mjs` 与
> `records-last-run.txt` 的 mtime **都没变**（都是 06:35:07）—— 判断更像**环境/残留状态**，
> 要求把重点从"追幽灵"转到**幂等与隔离**。

## 17.1 先纠正一条事实：那两个文件已经被我改过了

用户看到的 mtime 06:35:07 是**上一轮之前**的状态。写这份报告时的实际情况：

| 文件 | mtime | 内容 |
|---|---|---|
| `tests/records-check.mjs` | **06:39:58** | **29** 项（上一轮加了「空窗期」一组 5 条 + 显式预热 1 条） |
| `tests/records-check-last-run.txt` | **06:41:33** | `总计：29/29 通过` |

所以用户复跑看到 `23/23`，跑的是**改动前**的那一份（那一份确实存在过）。
两个数字（23 与 29）是**同一套测试的两个版本**，不是"同代码不同结果"。

⇒ **"代码没改、结果不同"这个前提不成立**；06:35:07 的 22/23 是上一轮已经定过案的那条：
**陈旧产物 + 当时真实存在的 `taskSelfDir` 分区误拦 bug**（见第十六节）。修复之后
`records-check.mjs` 与它的证据文件都重新生成过。

**结论：那个 22/23 未复现；本轮也不再追它。**

## 17.2 但"外部残留"的怀疑查下去，**真的查出东西了**

按用户的要求做隔离审计，结果：**47 个泄漏的临时目录积在 `%TEMP%`，其中 41 个是非空的**，
里面是完整的 `.pipeline` 数据（`task.json` / `audit.jsonl` / `requirement.md` / `handoffs/` …）：

```
=== 跑 load-smoke 之前 ===
tempDshDirs: [ "dsh-pipeline-selftest-3oW9WW", "dsh-pipeline-selftest-3uAL3k", … ]   ← 47 个

总数 = 47
非空的 = 41
按前缀分组： 47  dsh-pipeline-selftest

--- dsh-pipeline-selftest-3oW9WW
    \.pipeline
    \.pipeline\T-20261011-1694a6\handoffs
    \.pipeline\T-20261011-1694a6\audit.jsonl
    \.pipeline\T-20261011-1694a6\requirement.json
```

**来源**：`createHarness()` 用 `mkdtemp` 建临时目录，靠**各套自己 `rm`** 清理。
某套抛异常、或忘了清，目录就永久留下。

**它们会不会影响结果？—— 不会。** 两点证据：

1. `mkdtemp` 每次都给**全新唯一**目录名，不可能复用；
2. 每个残留里是**各自唯一的** `T-YYYYMMDD-<6hex>` 任务 id
   （`newTaskId` = 日期 + `randomBytes(3)` 的 6 位十六进制 ≈ 1677 万种），不会撞。

⇒ 所以这是**卫生问题**（看着像残留、误导排查），**不是**结果不稳定之源。
但既然被问到了，就该堵掉 —— 见 17.3 第 1、2 条。

## 17.3 为消除依赖/泄漏做了什么

| # | 做了什么 | 在哪个文件 |
|---|---|---|
| 1 | **`createHarness` 建完目录就登记"进程退出必清"**（`process.once('exit')` + `rmSync`）—— 某套抛异常或忘了清，也不会永久留在 `%TEMP%` | `tests/selftest-core.mjs` |
| 2 | **登记表 + `leakedTempDirs()` 导出**；`run-all` 结束时**断言零泄漏**，泄漏就**变红**（不再靠人记得清） | `tests/selftest-core.mjs` · `tests/run-all.mjs` |
| 3 | 清掉了历史上积下的 **47 个**残留 | —— |
| 4 | **`records-check` 开头显式预热同步索引**并断言（不依赖别的用例顺带登记） | `tests/records-check.mjs` |
| 5 | 「对照：写自己那份记录是允许的」这条**保留未删**；另加**一组 5 条**用例如实覆盖索引空窗期（放行 + 必须留痕 + 提示内容 + 只报一次 + 预热后立刻恢复） | `tests/records-check.mjs` |
| 6 | 证据文件改由 **`run-all` 程序生成**（不再手工），从根上消灭"陈旧证据"这一类 | `tests/run-all.mjs` |

**每套本来就是自包含的**（都用 `mkdtemp` + `mkdtemp` 的唯一 taskId，不碰演示项目、不碰工作区）——
这次只是把"清理"这件事从"各套自觉"变成"有兜底 + 有断言"。

## 17.4 `records-check` 单跑三次（原始输出）

```
---------- 第 1 次 ----------
==============================================================================
==============================================================================
==============================================================================
总计：29/29 通过
==============================================================================
退出码 = 0
---------- 第 2 次 ----------
==============================================================================
==============================================================================
==============================================================================
总计：29/29 通过
==============================================================================
退出码 = 0
---------- 第 3 次 ----------
==============================================================================
==============================================================================
==============================================================================
总计：29/29 通过
==============================================================================
退出码 = 0
```

三次之间**零残留**：

```
{"phase":"final","label":"records-check-3x", "workspacePipelineExists":false,
 "workspacePipelineEntries":[], "tempDshDirs":[]}
工作区 .pipeline = False
%TEMP% 残留 = 0
```

## 17.5 逐套单跑（含残留审计）

审计口径：每套跑前/跑后比对 **%TEMP% 里 `dsh-pipeline-*` 的个数**、**工作区 `.pipeline` 是否存在**、
**退出码**。任何一套让 `%TEMP%` 数量上升 = 它泄漏了。

```
套名                     退出码  %TEMP前  后  工作区.pipeline前 后   结论
------------------------------------------------------------------------------------------------
selftest-core.mjs        0      0        0   false           false ✓  总计：69/69 通过
load-smoke.mjs           0      0        0   false           false ✓  总计：21/21 通过
schema-check.mjs         0      0        0   false           false ✓  （断言式，跑通即通过）
switch-check.mjs         0      0        0   false           false ✓  总计：38/38 通过
client-check.mjs         0      0        0   false           false ✓  总计：23/23 通过
human-check.mjs          0      0        0   false           false ✓  总计：44/44 通过
writers-check.mjs        0      0        0   false           false ✓  总计：39/39 通过
ladder-check.mjs         0      0        0   false           false ✓  总计：39/39 通过
security-check.mjs       0      0        0   false           false ✓  总计：33/33 通过
relay-check.mjs          0      0        0   false           false ✓  总计：54/54 通过
records-check.mjs        0      0        0   false           false ✓  总计：29/29 通过
------------------------------------------------------------------------------------------------
★ 逐套单跑：全部自包含、零残留、退出码 0
```

**没有发现哪一套依赖外部残留。** 另外上一轮已做过**反序跑**（倒着跑十一套）也是全绿 ——
两个方向的证据合起来：**没有顺序耦合**。

## 17.6 全量一次（含新的残留检查）

```
#  dsh-pipeline 自测汇总：415/415 通过
总计：69/69 通过     ← selftest
总计：21/21 通过     ← 装载冒烟
总计：38/38 通过     ← 功能开关
总计：23/23 通过     ← 客户端半边
总计：44/44 通过     ← 人工介入
总计：39/39 通过     ← 编写席位 + 架构图
总计：39/39 通过     ← 两级升级梯
总计：33/33 通过     ← 安全确认
总计：54/54 通过     ← 水位 + 继任 + 编排自继任 + 广播
总计：29/29 通过     ← 分权落档 + 留档 AI + 守门索引空窗期
【残留检查】每套自测的临时目录是否清干净：0 个泄漏 ✓
```

（415 = 414 + 1 条新的残留检查。）

## 17.7 不确定项

1. **47 个残留里，哪几套是"元凶"我**没有**逐一定位** —— 只知道都来自
   `dsh-pipeline-selftest-*` 这个前缀（即 `createHarness`）。现在有了退出兜底 + 泄漏断言，
   再出现会**当场变红并列出目录**，那时能精确定位。**这一轮没做归因**。
2. **退出兜底只覆盖"进程正常退出"**。被强杀（`SIGKILL` / 任务管理器结束进程）时
   `exit` 钩子不跑，仍会留目录 —— 这类残留只能靠下一次人工清理，或者把临时根目录**固定成一个**
   可整体清扫的位置。**目前没做**。
3. **泄漏断言只查"本进程建过且还在"的目录**。**历史遗留**（前几次运行留下的）它查不到 ——
   那需要扫 `%TEMP%` 全部匹配项并在跑前比对，代价是要区分"别人的"。**目前没做**。
4. **工作区 `.pipeline` 的检查是"跑完不该出现"**，不是"跑前必须是空的"。
   如果本来就有（比如真在演示项目里跑过），断言不会响。**目前没做**更严的前置检查。
5. **`22/23` 那次的具体现场无法完全还原**：我只有 mtime 与文件内容。
   按第十六节的结论，它是"旧文件 + 当时真实的 bug"，但**没有**当时那次运行的完整日志。

---

# 十八、设计增量：拆角色 + 澄清前置 + 按层分工（第九轮）

> 本轮是**用户逐条拍板**之后的落实，不是我自己加的。
> 六条：① 拆 `orchestrator` / 新增 `planner`；② 澄清前置到**用户人工确认**；
> ③ 计划缺失回流；④ 编写按**层**分工；⑤ 编写席位上槛 3 → 6；⑥ 全链路同步 + 自测。

## 18.1 八轮的产物分属（哪部分属于哪一轮）

| 轮次 | 管的是什么 |
|---|---|
| 第一~六轮 | 基础流水线 / 开关 / 人工介入 / 架构图 + 席位 / 两级升级梯 / 安全确认 |
| 第七轮 | 需求留档、上下文水位、席位继任 |
| 第八轮 | 分权落档 + 留档 AI；**分配 AI = 编排 AI**（`orchestrator` 掌分配权） |
| **第九轮（本轮）** | **把「需求分析」与「计划分配」拆成两个角色**；澄清前置到用户确认；计划缺失回流；编写按层分工；席位 3→6 |

## 18.2 更正 A · 拆角色：`orchestrator` 只做需求分析，新增 `planner`

### 用户原话（要求）
> `orchestrator` 收窄为**只做需求分析**（第 1 轮分析 → 任务卡/验收标准/边界条件/测试要点，
> 并**产出「需求不清楚处」清单**），中文名去掉「/编排判断」。
> **新增角色 `planner`（计划 AI）**：接需求确认结果 → 出计划 → **自检计划有无缺失** →
> 无缺失则由 **planner 分配 AI**（角色清单、用几个 AI、派谁、什么顺序）。

### ★ 被推翻的旧设计（第八轮刚定的那条）
第八轮拍板的是「**分配 AI = 编排 AI（`orchestrator`）**」，并把工具箱里所有分配动作
（角色清单、`relayPolicy`、席位方案、继任指派、角色变更复核）都挂在 `orchestrator` 名下。
**本轮用户明确改掉了这一条**：分配权从 `orchestrator` 移到 `planner`。
读第八轮那几节时要注意：文中"编排 AI 掌分配"的表述**已被本轮取代**，
但"主对话不参与分配"这条**没变**（只是那个"掌分配的角色"换了名字与职责边界）。

### 为什么非拆不可（取舍）
两条理由，第二条是决定性的：

1. **两者回答的问题不同**：需求分析回答「这东西到底要做什么」（语义问题，答错了后面全错）；
   计划分配回答「这活怎么切、给谁、按什么次序」（结构问题）。
2. **不拆就无法表达"计划缺失"**：用户本轮要求「planner 自检发现计划缺失 → 退回需求分析」。
   如果两件事还在同一个角色里，这条边就是**自环** —— "我回头问我自己"，等于自问自答。
   拆开之后它才是一条**真实的、可审计的**回流边（`planner → orchestrator`）。

### 放弃的方案（以及为什么不选）
- **方案甲：保留一个角色，内部两阶段（stage 字段）**。
  放弃理由：那正是"自环"问题的另一种写法 —— 退回还是回到自己；
  而且状态机里会多出"同一个角色在两个阶段"的歧义（`STATE_OWNER` 只能填一个角色）。
- **方案乙：新增 `planner`，让 `orchestrator` 完全消失**。
  放弃理由：**两级澄清梯的第一级就是需求分析**（第七轮定的），
  执行角色答不了的问题需要有人"在需求层裁定"。把它也删掉，这一级就没人了。
- **方案丙：分配权留在 `orchestrator`，只把"自检"做成一个独立工具**。
  放弃理由：自检的产物（计划）与分配的产物（角色清单）是**同一件事的两半** ——
  自检没过就不该分配。分开成两个工具、两个调用方，中间必然出现
  "自检没过但清单已经写了"的半截现场（本插件最忌讳的形态）。

### 实现（数据 / 状态 / 工具三层）
- `lib/roles.js`：`ROLE.PLANNER`；`ORCHESTRATOR.zh` 从「需求分析/编排判断」改成「需求分析」；
  两者的 `handoffKinds` 拆开（`orchestrator` 交出 `orchestration`，`planner` 收进 `plan` + `orchestration`）。
- `lib/handoff.js`：新增两种交接物 `requirement_analysis`（含**必填**的 `unclear_points`）与 `plan`（含 `self_check`）。
- `lib/states.js`：新增状态 `ready_plan`（待计划）/ `planning`（计划中）；
  删掉 `analyzing → ready_dev` 那条边（需求分析不再产清单），换成 `planning --planned--> ready_dev`。
- `lib/tiers.js`：`buildRoster` 的对话与阶段顺序变成「需求分析 → 计划 → 咨询 → 编写 → 测试 → 审核 → 尾」；
  L1+ 的 `total` 各 +1（L1 7 / L2 9 / L3 10 / L4 11 / L5 13）；L0 不变（仍是 4，两件事都由规则引擎承担）。
- `lib/store.js`：`setRoster` 改为 `judgedBy='planner'`；角色变更复核从 `orchestrator` 改成 `planner`。
- `lib/tools.js`：新增 **`pipeline_plan`**（第 26 个工具）；`pipeline_orchestrate` 收窄成"只出分析结论"，
  **不再接收 `tier`**（传了就拒，并说明分配是 planner 的活）。

## 18.3 更正 B · 澄清前置到**用户人工确认**

### 用户原话（要求）
> 需求分析 AI 第 1 轮分析后，**必须**把「不清楚的地方」提交**主对话** →
> 主对话交**用户人工确认** → 确认后才递交 planner。

### ★ 这里最大的取舍：**复用 `awaiting_human`，不新开状态**
用户要求"能复用就复用并写明理由"。**结论是复用**，理由三条：

1. **机制上完全同构**。这一段动作就是：执行角色交一份结构化请求 → 主对话**转告** →
   用户答复（带原话与归属）→ 状态回到被打断前那一个。
   这四步与第七轮做的 `human_request` 链**一字不差**。
2. **差别只在"问的是什么"**，而那件事已经由一个数据字段回答：
   `reason_kind = requirement_confirmation`（本轮新增的取值）。
   单开一个状态会把"同一个问题、同一个通道"切成两套并行的流程 ——
   而拓扑上用户只与主对话相连，通道本来只有一条。
3. **新开状态会制造第二个死结口**。等待态的恢复语义（`previous_state` 不被等待态覆盖）
   是第七轮踩过坑才写对的；复制一份就意味着复制一份出错的机会。

### 那"必须确认"这条硬约束落在哪
落在**状态机的边**上：`analyzing --requirement_confirmed--> ready_plan`，
`by: ['main']`，guard `requirement_confirm_gate`。判据读的是**既有的** `human_requests` 记录：

- 必须存在一份 `requirement_analysis` 交接物；
- 必须存在一条**需求分析发起**的、`reason_kind ∈ {requirement_confirmation, requirement_ambiguous}` 的
  `human_request`，且它 **`status === 'answered'`**。

★ 刻意**只认答复、不认转告**：转告只证明"话带到了"，答复才证明"人回了"。
只查前者的闸是纸做的（第七轮 `human_reply_has_source` 就是同一条思路）。

### 一个顺便被修掉的设计问题
`checkHumanRequestChannel` 原先只允许需求分析在**不带上游**的情况下发
`reason_kind=requirement_ambiguous` 的请求。本轮把白名单扩成
`{requirement_ambiguous, requirement_confirmation}` —— 后者是**每次都要走**的固定动作，
前者是按需的。两者都记在 `HUMAN_REASON_KINDS` 的注释里。

## 18.4 更正 C · 计划缺失回流：**沿用**两级梯，一行新机制都没加

### 用户原话（要求）
> planner 自检发现计划缺失 → 退回**需求分析**（orchestrator）；
> orchestrator 答不了 → 升级**主对话 → 人工**（**沿用现有两级梯**，不要另起一套并行机制）。

### 实现
- `plan` 交接物的 `self_check.verdict=gaps` ⇒ `planAdvance` 返回事件 `plan_gap`
  ⇒ 状态 `planning → awaiting_clarification`（**就是**第一级那个等待态），guard `plan_gap_gate`。
- 同时在 `submitHandoff` 里**按同一份 `createClarificationEntry`** 建一条澄清记录
  （`from_role = planner`）。于是后面**全部照旧生效**：
  `pipeline_clarify_reply` 的裁定、`cannot_answer` 的单向门、防踢皮球 `maxClarifyRounds`、
  升级 `human_request`（带 `escalated_from` / `raised_by` / `orchestrator_reason`）、
  以及"回到最初被打断的工作状态"的恢复语义。
- **自检没过就不许分配**这条落在两处（同一条判据、同一份数据）：
  ① `setRoster(judgedBy='planner')` 开头查最近一份 `plan` 的 verdict；
  ② 状态机的 `plan_ready` guard。任何调用路径都绕不过去。

### 放弃的方案
- **另开一个 `awaiting_plan_gap` 状态 + 一套"计划问题专用"请求类型**：
  放弃理由就是用户点名的"不要另起一套并行机制" —— 那会再次让"用户到底在等谁"说不清。
- **让 planner 直接用 `pipeline_clarify_request` 提问、`plan` 只做记录**：
  可行，但会出现"交了计划、没提回流"的半截现场（计划在盘上、缺口在纸外）。
  现在的做法把"缺口"与"要问的问题"绑在**同一份交接物**里，状态推进由它一次性触发。

## 18.5 更正 D · 编写按**层**分工，席位 3 → 6

### 用户原话（要求）
> 编程 AI 按**层**分派，默认层清单 = **接口层 / 数据层 / 处理层**（层清单由 planner 按项目裁剪或扩展）；
> 工程量大的项目允许**复数 AI 按层并行分工**；「哪一席位负责哪个层」要在分区元数据里可表达（加 `layer` 字段），
> 同时**保留 `scope_paths` 的越界写执法能力**；席位上槛 3 → 6，**席位数由层数决定**，`count=1` 仍是退化情形。

### 实现上的三条硬规则（都在 `buildWriters` 里执法，不靠文档）
1. **`count === layers.length`**：一个层一个席位。给了 `layers` 又给了对不上的 `count` ⇒ 直接拒。
   多席位**必须**给层清单（不给就拒，并提示默认三层）。
2. **`layer` 逐席位必填**（形状校验在 `handoff.js`，事实来源在 roster 分区表）：
   层说"负责哪一层"，`scope_paths` 说"能写哪里" —— **两条判据同时在**。
   按层分工**没有**放松任何一条路径执法（`owningSeat` / 守门那一层一行没改）。
3. **`count=1` 的退化形态写死成 `layers: ['all']`**：仍然走同一份 `buildWriters`、
   同一套越界判据、同一条推进路径。这样"席位数 = 层数"这条不变量在退化情形下也成立
   （否则单席位会变成"层数是 0、席位是 1"的例外）。

### 上限为什么是 6（而不是更大）
默认层清单是 3 层，工程量大的项目按层拆 + 每层再拆前后端，翻一倍就是 6。
再往上，协调成本会超过并行收益；而且"**全部席位到齐才推进**"这条既有规矩
会让等待时间随席位数线性变长（第七轮定的取舍，本轮没动）。
`MAX_WRITER_SEATS = 6`；L0 仍是 1（极简脚本没有分层余地），L1 = 3，L2~L5 = 6。

### 放弃的方案
- **层与席位多对多**（一个席位管两个层）：放弃理由 —— 那会让"writer#3 到底管哪层"
  变成要读分区表才知道的事，而这一栏恰恰是给人（和主对话）看的。
- **把层掺进 `scope_paths`**（例如 `src/api@interface`）：放弃理由 —— 路径是要拿去
  做前缀比对的，掺进标记会让比对逻辑与既有磁盘布局同时变脏。
- **L0 也允许分层**：放弃理由 —— L0 的判据就是"单文件 / 单函数级"，
  给它分层等于给"简单需求超配"开一个口子（第一轮就写死不许）。

## 18.6 全链路同步（改了哪些文件）

| 文件 | 改了什么 |
|---|---|
| `lib/roles.js` | 新增 `PLANNER`；`ORCHESTRATOR` 收窄；`MAX_WRITER_SEATS=6`；层清单常量与 `layerLabel()` |
| `lib/states.js` | `ready_plan` / `planning` 两个状态；三条新边（`requirement_confirmed` / `dispatch_planner` / `planned` / `plan_gap`）；四个白名单加 `planner` |
| `lib/handoff.js` | 新增 `requirement_analysis` / `plan`；`orchestration.from` 改归 `planner`；`partition.layer`；新 `reason_kind` |
| `lib/tiers.js` | planner 进对话与阶段；L1+ total +1；`maxWriters` 提到 6；`buildWriters` 按层定席位；`recommendLayers` |
| `lib/store.js` | 三条新前置判据（需求确认闸 / 计划就绪闸 / 回流闸）；回流建澄清记录；`setRoster` 归 planner；角色变更复核归 planner |
| `lib/guard.js` | 工具角色表（`pipeline_plan: ['planner']`、`roster_review: ['planner']`）与交接物方向表白名单 |
| `lib/context.js` | 继任执行者 `orchestrator → planner`；需求档渲染加层与不清楚处 |
| `lib/tools.js` | 新增 `pipeline_plan`；`pipeline_orchestrate` 收窄；`dispatchEventFor` + planner；派活引导步按状态判；联系人字段 `planner_*`（保留 `orchestrator_*` 别名） |
| `index.js` | 工具计数 25 → 26；system prompt 段补新链路的顺序 |
| `tests/` | 新增 `plan-check.mjs`（41 条）；其余 11 套按新链路同步 |

**一条纪律**（沿用第八轮定的方向）：白名单漏加新角色 = 少一条能力（可接受）；
黑名单忘了更新 = 悄悄多一条能力（不可接受）。所以本轮**只加白名单**，
一个黑名单都没新增。

## 18.7 实测

`node tests/run-all.mjs` —— **十二套，458/458 通过**。

本轮新增的 `plan-check`（41 条）覆盖：

| 组 | 覆盖 |
|---|---|
| A 拆角色 | 分析结论 ≠ 角色清单；`judged_by=planner`；L2 从 8 → 9 个对话；调用顺序；**反例**：需求分析试图自己定档 → 拒 |
| B 澄清前置 | 用户确认后才进计划；四步留痕齐全（复用既有链）；不清楚处带进问题；**反例**：没有答复就进计划 → 拒；确认前派 planner → 拒；没转告就记答复 → 拒；漏给 `unclear_points` → 拒；有假设却说"没有不清楚处" → 拒 |
| C 缺失回流 | 自检 gaps ⇒ 不分配 + 退回需求分析；回流记录挂在**第一级**梯上；裁定后回到"计划中"；补完缺口重交 → 分配成功；**反例**：缺口没补硬分配 → 拒；planner 跳级找用户 → 拒；**升级链**：`cannot_answer` → `human_request`（带三个溯源字段）→ 转告 → 答复 → 恢复到最初状态 |
| D 按层分工 | 三层 ⇒ 三席位；每席位带 `layer` 且**同时**带 `scope_paths`；**反例**：count 与层数对不上 → 拒；多席位不给层 → 拒；层重复 → 拒；缺 `scope_paths` → 拒；6 层可以、7 层拒；`count=1` 退化成 `['all']` + 整棵项目根 |

## 18.8 本轮**没有**动的东西（明确列出，免得下次误读）

- **三权分立**：`developing → ready_test → ready_review` 的单向链、`review_ok` 唯一入口、关单三闸 —— 一行没改。
- **`scope_paths` 越界写执法**：守门的 `owningSeat` / `describeSeat` 一行没改（按层分工**不替代**它）。
- **"全部席位到齐才推进"**：没动（第七轮的取舍）。
- **水位 45/55/65 与继任**：阈值与流程没动；只把"执行继任的那个人"从 `orchestrator` 换成 `planner`
  （因为分配权换了持有者；这是"职权跟着职责走"，不是新机制）。
- **L0 路径**：规则引擎自批照旧，仍是 4 个独立对话（需求分析与计划都由引擎承担）。
- **需求档唯一写者**：仍是留档 AI；planner 交的是**自己那份记录**（`records/planner.md`），不直接写 `requirement.md`。

## 18.9 不确定项（诚实列出来）

1. **"必须每次都确认"会不会太吵**：本轮把"没有不清楚处"也做成了必须用户点头的结论
   （理由：模型说"我懂了"不等于用户说"你懂了"）。这是对用户原话"**必须**"的字面落实，
   但如果实际用起来觉得啰嗦，翻回来的开关点是 `requirement_confirm_gate` 一处
   （允许 `unclear_points` 为空时免确认）—— **我没有替用户做这个让步**。
2. **`pipeline_contacts` 的字段名**：新增 `planner_agent` / `planner_seat`，
   旧的 `orchestrator_agent` / `orchestrator_seat` **保留为同值别名**（历史任务与外部调用方还在用）。
   参数侧 `to_planner_agent` 与 `to_orchestrator_agent` 都收，前者优先。
   这是一次**有意的兼容**，不是漏改 —— 什么时候删掉别名需要用户拍板。
3. **旧任务文件**：`task.contacts` 里存的键名与 roster 里的 `judged_by='orchestrator'` 属于历史数据。
   代码按"**新键优先、旧键回退**"读（`contacts.planner ?? contacts.orchestrator`），
   旧的 `orchestrated` 事件边也保留了（L0 用）。没有做数据迁移脚本。
4. **`plan` 交接物的 `layers` 允许空数组**：单席位时本来就没有层要声明。
   多席位时"必须给层"这条由 `buildWriters` 执法（给了 count>1 却没有层 ⇒ 拒），
   两道判据的数据源不同（一个是交接物、一个是角色清单），这一点在上面的设计里是刻意的。

## 18.10 ★ 设计目的（第一性目标）落地：防过度工程化 = 只干自己该干的

> 这一节与上面几节**同属本轮（第六轮追加）**，是用户在同批交付里补的一条设计目的：
> 「**分开跑项目的目的是让 ai 别过度工程化，要求只干自己该干的，
> 编程别跑测试，编排别看代码**」。

### 为什么这条不能只写进文档

它是**本项目的目标函数** —— 前面十七节讲的全都是"怎么把流程变成机制"，
而"为什么要有这些流程"就是这一句。如果它只活在 README 里，那么：
一个角色只要"假装没看见"，就能把实现与验证一起做掉，或者先读遍源码再来定计划。
**目标是"防过度工程化"，实现手段却是一句劝告** —— 那等于没有目标。

所以本轮把它落成三条**机器可执法**的边界（每条都有守门判据 + 正反例自测）：

| 边界 | 判据落在哪 | 拦的是什么 |
|---|---|---|
| **编写不跑测试** | `lib/guard.js` 的 `scanTestRunnerCommand`（shell 侧）+ `lib/store.js` 的 `canProduceHandoff` + `lib/handoff.js` 的 `TEST_VERDICT_FIELDS` | ① 测试类命令（`npm test` / `pytest` / `node --test` / `node tests/x.mjs` / `--coverage` …）；② 编写交 `test_to_review` / `test_to_dev`（白名单里压根没有）；③ `dev_to_test` 里夹带 `test_cases` / `pass_evidence` / `verdict` |
| **控制角色不看代码** | `lib/guard.js` 的 `NO_CODE_READ_ROLES`（读工具 + 检索工具 + shell 三道）+ `lib/handoff.js` 的 `scanControlRoleProductForCode` | ① 主对话 / 需求分析 / 计划读源码正文；② 用会**吐正文**的检索工具翻源码树；③ 它们的产物里出现代码正文 |
| **白名单方向** | `lib/roles.js` 的 `handoffKinds` + `lib/guard.js` 的两张表 | 只写"谁能做"；忘了加 = 少一条能力，忘了删 = 悄悄多一条能力（后者不可接受） |

### 几个刻意的取舍（被放弃的方案）

1. **不拦"构建/启动级冒烟"**。`npm run build` / `node build.mjs` / `node -e …` / `tsc --noEmit`
   **放行**。放弃"一律拦掉所有可能验证的行为"的理由：那会连带把"我写的东西能不能装上、
   起得来"也一起封死，而那不是"测试判定"，是**开工的前提**。
   ⚠️ 它同时是一个**冲突点**：`writer` 的 summary 与 `dev_to_test.selftest_result` 都写着"自测"。
   这条冲突**没有**由我拍板，已列进 README「待确认项」的 **P1**（连同"要不要连冒烟一起拦""字段留不留"）。
2. **检索只拦"吐正文的"，不拦"只给路径的"**。`grep` / `findstr` / `Select-String` 拦；
   `glob` / 列目录**不拦**。理由：前者返回的是**匹配到的代码行**（等于读了代码），
   后者只返回**文件名**。全拦的话，计划 AI 连"项目里有哪些目录"都不知道，
   只会做出更不合实际的计划 —— 那是**另一种**过度工程化。
3. **控制角色的产物判据比"给人看的人话"更严**。`detectCodeInHumanText` 是给人话用的
   （误伤代价高：把"我提到 step 参数"当成代码）。控制角色的产出不同：它们**不看代码**，
   所以出现任何代码形态都只有"越界"一种解释 —— 于是加了一组更严的
   **形态**判据（`CONTROL_INLINE_CODE_RES`：`const x =` / `f(a){` / `export function` / `=>` …），
   但仍然**不**用裸关键词（英文散文里的 "return the value" 不该被误伤）。
4. **判据按"路径"分界，不按"内容"分界**。控制角色到 `.pipeline/` 下的一切（需求档 / 交接物 /
   记录 / 脱敏摘要 / 报告）**允许读**，到源码树**禁止读**。
   这条分界就是"它们凭什么在没读代码的前提下出计划"的答案：凭需求档 + 验收标准与边界 +
   **只给路径不给正文**的目录结构。这三样足够回答"这活怎么切、给谁、什么次序"，
   而**不足够**回答"这个函数该怎么写" —— 那正是边界想要的效果。
5. **不改 `writer` 的 summary、不删 `selftest_result`**。它们与"编程别跑测试"直接冲突，
   但**改它们会改变既有对外语义**（交接物字段、角色卡）。用户明确要求冲突项不要自己拍板，
   所以：**没有歧义的那半先执法**（不跑测试、不出测试报告），**有歧义的半列进待拍板**。

### 实测

新增 `tests/boundary-check.mjs`（**41 条**，正例/反例成对）：

- ① 编写不跑测试：6 条命令形态反例（`npm test` / `npx jest --coverage` / `python -m pytest` /
  `node --test` / `node tests/run-all.mjs` / `npm run test:unit`）+ 4 条放行正例
  （build / `node build.mjs` / `node -e` / `tsc --noEmit`）+ `tester` 跑 `npm test` 的对照 +
  3 条交接物反例（`test_to_review` 守门层 / execute 层 / `test_to_dev`）+
  1 条夹带测试结论字段的反例 + 1 条干净 `dev_to_test` 的正例。
- ② 控制角色不看代码：`main` / `orchestrator` / `planner` × 3 条读法（read / grep / shell）
  = 9 条反例 + 读需求档 / 在 `.pipeline` 下检索 / 用 `glob` 的 5 条正例 +
  产物里塞代码正文的 2 条反例 + 只写路径与人话不触发的 1 条正例。
- ③ 白名单方向：`writer` 没有测试类产物 / `tester`、`reviewer` 各自的产物 / 控制角色不产出技术交接物
  + 3 条越界调工具的反例。

**全量：十三套，502/502 通过**（本轮新增第 13 套）。

### 一处**如实说明**的边界

"编写不跑测试"与"控制角色不看代码"在 **shell 侧都是 best-effort**：
写一个 `run-tests.ps1` 再执行它、把命令拼成变量、编码后再解码，都拦不住。
这条限制**写在 `lib/guard.js` 的文件头**（"哪些是约定"一节）与 README 的守门表里，
不粉饰。要真保证只能靠环境侧（不给编写席位测试环境 / 不给控制角色源码挂载）——
那不是插件能给的。

---

## 18.11 ★ 同批追加：最小改动（改动面 = 授权面）+ 职责自限

> 用户在同批里补了第二条设计目的：
> 「**还有如修一个 bug 就别该整个模块，分析和计划 ai 确认他们只干什么，不要多干**」。
> 它与 18.10 的"编程别跑测试、编排别看代码"是**同一个目标函数**的四条落地规则之一，
> 所以并入同一批、同一节，不另开一轮。

### 两条规则分别是什么

| 规则 | 一句话 | 执法点 |
|---|---|---|
| ③ **最小改动** | **改动面必须与授权面相等** —— 多改一行也算越界 | 计划给 `change_scope`（逐条授权）；守门按它拦写入（文件工具 + shell）；`dev_to_test` 交 `change_manifest`（每条引用一个授权条目）；越界事实存在时审核不得出结论 |
| ④ **职责自限** | 分析与计划**只干什么，不要多干**；并为每个角色写死边界 | `role_scope { will_do, will_not_do }` 必填；需求分析产物里出现分配内容即拒；`plan.role_boundaries` 必须覆盖每个执行角色；派活时把该角色的卡贴进派活单 |

### 被放弃的方案（以及为什么不选）

1. **只靠 `scope_paths`（席位分区）而不引入授权面。**
   放弃理由：分区回答的是"**你负责哪一块**"（长期、按层），
   而用户要的是"**这次允许动哪些**"（本任务、逐条）。
   两者粒度不同：一个席位负责 `src/api` 整块，但修一个 bug 只该动 `routes.js` 一个文件 ——
   只有分区的话，**顺手重构整个模块**是完全合法的。所以引入第二层（`change_scope`），
   且两层**同时生效**（越写越严），不是用新的替换旧的。

2. **`change_scope` 只写路径，不写"为什么"。**
   放弃理由：`why` 那一栏是"顺手重构 / 统一风格 / 顺手升级依赖"的**照妖镜** ——
   那些理由写不出来。用户原话里点名了这三件事，所以它必须是必填。

3. **"新增文件"一律禁止（不加 `create` 动作）。**
   放弃理由：正常开发里"在授权目录内新建一个文件"太常见（拆模块、加测试夹具之外的实现文件），
   一律禁止会把人逼到绕路。所以做法是：**新增也必须在授权面内**（用户原话"新增文件也算越界"
   正是这个意思），并用 `action` 表达意图：`modify` = 这块可以改（含在其中新建/删），
   `create` = **只**授权新建这一份（拿它改已存在文件 ⇒ 拒）。

4. **`change_manifest` 只做"记录"，不做核对。**
   放弃理由：只记录就等于"事后才发现"。现在的做法是**提交时就逐条核对**：
   每条改动必须引用一个**存在的授权条目**，且路径要落在它范围内 ——
   "每一处改动都有授权来源"从一句要求变成可机械判定的事实。

5. **审核自己逐个文件比对。**
   放弃理由：用户点名要"**判据级，不是靠人看**"。所以每次 `dev_to_test` 都会算出
   `task.scope_conformance`，`pipeline_status` 把**授权面 / 实际面 / 核对结果**一起摊开；
   有越界时审核提交结论会**直接拒**（`SCOPE_CONFORMANCE_FAILED`）。

6. **"需求分析不要写分配内容"只写进提示词。**
   放弃理由：与 18.10 同一条思路 —— 提示词是建议，判据才是机制。
   现在的判据是**组合式**的（角色名/席位名 + 派活动词，或出现"用几个 AI / 档位 / 角色清单"
   这类分配专有名词），刻意不用裸关键词，避免误伤"这件事需要独立验证"这种需求层的正常表述。

### 一处**必须承认的设计后果**（已列进待拍板）

**中途加人 = 加一张新边界卡**：`role_boundaries` 是分配那一刻写死的，
所以 `pipeline_roster_review` 批准加人时**必须**顺带给新角色的边界卡，否则拒。
顺带修了一个既有的半截现场：以前复核是"先标记 approved、再改清单"，
改清单失败会留下"申请说批了、清单没动"且**无法修复**的状态；
现在改成**清单改成功才算批**，失败则申请退回 `pending` 可重批。

### 一处**如实说明**的边界（与 18.10 同一类）

- `change_scope` 的写入执法在 **shell 侧同样是 best-effort**（字符串匹配 + 路径提取）；
  文件工具那一路是硬的（直接读参数里的路径）。
- **L0 没有"计划"这一站 ⇒ 没有授权改动面**，那条判据在 L0 上**整体弃权**
  （`pipeline_status` 会明写"无授权面"）。这是与既有分档设计的**直接冲突点**，
  已列进待拍板 **P4**，我没有替用户决定"L0 要不要也强制一张授权面"。

### 实测

新增 `tests/scope-check.mjs`（**28 条**，正反例成对）：

- **A 最小改动（15 条）**：授权面内写放行；分区之内但授权面之外 → 拒；
  **新建未授权文件 → 拒**；授权目录内新建 → 放行；拿 `create` 授权改已存在文件 → 拒；
  shell 写到授权面外 → 拒；不带 `change_manifest` → 拒；引用不存在的 `scope_id` → 拒；
  path 不在引用条目范围内 → 拒（含绕过守门直接打 execute 的第二道闸）；
  改动面全在授权内 → 收下且 `scope_conformance` 落档；有越界事实时审核出结论 → 拒；
  `pipeline_status` 给出授权面/实际面/核对结果。
- **B 职责自限（13 条）**：需求分析交计划 → 拒；计划交需求分析结论 → 拒；
  计划 AI 自己写制品 → 拒；需求分析产物里出现"派 writer#1 / 用 3 个独立对话" → 拒；
  缺 `role_scope` → 拒；`will_not_do` 空 → 拒；只写需求层的事 → 通过；
  边界卡覆盖与两栏完整性；**派活单里带上该角色的边界卡**。

**全量：十四套，532/532 通过**（本轮新增第 13 套 `boundary-check` 与第 14 套 `scope-check`）。

---

## 18.12 ★ 同批追加：双轨派活 + 改动基线 + 审核只读

> 用户第三次补句话（仍属同一批）：
> 「**审核 ai 要一起配合确认有没有多改**，分析和计划 ai 确认他们只干什么，
> 然后**计划 ai 发任务给编程 ai 和审核 ai**，编程 ai 完成后测试 ai 跑测试，
> 完成后给审核 ai，**审核 ai 确认没有干不该干的事（前后版本对比）**，
> **审核 ai 只读，只有属于他的日志文件有权限写入**」

拆成四条，与前两条（规则①~④）合成**六条规则**：

| 规则 | 一句话 |
|---|---|
| ⑤ **双轨派活** | 计划一出，编写与审核**同时**接任务；审核开工前就拿到授权面 / 越界清单 / 边界卡 / 基线 |
| ⑥ **改动基线** | 派活那一刻记录（文件清单 + 哈希，不复制源码），绑定那次计划的 handoff id ⇒ 可证明 |
| ⑦ **前后版本对比** | 审核按基线逐文件比，多改 / 少改 / 改错地方三类都报，结论进交接物 |
| ⑧ **审核只读** | 除自己的日志文件外，任何位置都写不了 |

### 被放弃的方案（以及为什么不选）

1. **"双轨"＝审核提前出结论。**
   放弃理由：用户说得很清楚 —— 「编程 ai 完成后测试 ai 跑测试，完成后给审核 ai」，
   **链路没变**。所以双轨的正确含义是"提前**知情**，不是提前**判定**"：
   审核在 `ready_dev` 就能被派出并拿到全部判据，但 `review_verdict` 仍只在 `reviewing` 可交
   （状态机一行没动）。这条区分很关键：审核提前给意见会变成"边写边审"，
   那等于把独立验证揉进开发过程，三权分立就没了。

2. **基线复制一份源码快照（`git stash` / 打包 tar）。**
   放弃理由：用户明确要求"**只存清单与哈希，不复制源码，避免体积膨胀**"；
   而且复制出来的源码副本本身就是一个"可以被顺手改"的东西 —— 反而增加风险面。

3. **让审核自己读代码做 diff。**
   放弃理由：与规则②直接冲突（审核虽然不在 `NO_CODE_READ_ROLES` 里，
   但它的证据应当是**判据**而不是"我看了一遍"）。哈希比对让它拿到的是
   **可核对的事实**：哪几个文件变了、变的在不在授权面内。

4. **给审核一个"可以写报告"的窄目录（`reports/reviewer/`）。**
   放弃理由：用户原话是"**只有属于他的日志文件**有权限写入" ——
   目录级授权还是"这一片随便写"。现在是**文件级**：`reports/reviewer/reviewer.log|.jsonl`，
   文件名也必须对得上（`reviewer.md` 会被拒）。审核的意见与判定文本写进这个日志 +
   结构化交接物 `review_verdict`。

5. **`change_audit` 让审核自己填明细。**
   放弃理由：手抄必然与实测漂移。现在的做法是：审核跑一次 `pipeline_change_audit`
   拿到结论（工具会直接给出可粘贴的 `change_audit`），**store 再自己算一遍核对**
   `baseline_id` 与 `verdict`。填反了会被 `CHANGE_AUDIT_MISMATCH` 拒 ——
   这是"复核"而不是"抄写"。

### 一处**收紧**（比既有不变量更严，已在文档里写清）

`reviewer.writes` 从 `'reports'` 收紧成 **`'own-log'`**：

- 旧：整个 `reports/` 目录随便写（只要不碰源码树）。
- 新：**除 `reports/reviewer/reviewer.log|.jsonl` 之外，全都不许写** ——
  包括 `reports/` 下别人的文件、测试的报告、需求档、别的任务目录。

为什么非收不可：审核一旦手里有"写"的权限，就有"顺手改一下"的诱惑，
而它的角色意义恰恰是**独立核对**。给它一支笔，它就从"核对者"滑向"共谋者"：
发现问题顺手改掉，然后判自己 OK。收掉这支笔，它就只能**报出来**。

### 一处**如实说明**的边界

- 基线的**重取**只有计划 AI / 主对话能做（`pipeline_change_audit { take: true }`）——
  否则编写可以把已经改过的东西洗成"本来就这样"。这条是否够严，见待拍板 **P8**。
- 本轮**只**收紧了 `reviewer`。`tester` 仍是 `writes: 'reports'` —— 用户点名的是审核，
  我没有顺手扩大范围（那正是本项目要防的事）。要不要一并收紧见 **P7**。
- L0 没有计划站 ⇒ 没有基线 ⇒ 前后版本对比那两条判据在 L0 上**不适用**
  （与 P4 同源）。

### 实测

新增 `tests/review-check.mjs`（**38 条**，正反例成对）：

- **A 双轨派活（12 条）**：计划备齐四样；编写与审核**都在开工前派出**；
  审核的开工前简报里带授权面 / 越界清单 / 边界卡 / 基线；简报里明说"现在不要出审核结论"；
  派审核**不改状态**；反例：审核想提前出结论 → 状态机拒。
- **B 改动基线（5 条）**：计划产出时**自动**记录；绑定 plan handoff id + digest（可证明）；
  只存清单与哈希（**不复制源码**）；排除 `.pipeline/`；落盘成文件。
- **C 前后版本对比（13 条）**：单改授权内 → within_scope；多改（清单外新增）→ out_of_scope + unauthorized；
  少改 → missing；**改错地方**（引用别人的授权条目）→ 拒；
  重取基线（计划 AI 可以 / 编写不行）；反例：不交 change_audit / baseline_id 过期 /
  verdict 与实测不符 / 有多改还发 OK —— 四种全拒。
- **D 审核只读（8 条）**：写自己的日志 → 放行；写 `reviewer.md` / `reports/` 下别的文件 /
  测试的目录 / 源码 / 需求档 / 别的任务目录 → 六种全拒；对照：`tester` 仍可写 reports/。

**全量：十五套，571/571 通过**（本批新增第 13~15 套：`boundary-check` 42 + `scope-check` 28 + `review-check` 38）。

---

## 18.13 ★ 同批追加：总原则「不靠自然语言，靠代码层拦截」+ 全角色权限对齐

> 用户第四次补句话（仍属同一批）：
> 「**测试 ai 等同理，没有权限动文件的就只能只读**；
> 总的来说 **ai 的行为不要靠自然语言限制，要靠代码层直接拦截**」

### 一、这条原则被落成了什么

| 落点 | 内容 |
|---|---|
| **README 开头** | 新增「★ 总原则」一节：写在 summary / 提示词 / README 里的"不得"是**愿望**；只有落在守门 / 状态机 / schema 里的才是**边界** |
| **ARCHITECTURE 开头** | 同上 + 一条画图规矩：**(b) 类不许留在图上**（要么做掉，要么降级进 (c)）；(c) 类画成虚线并注明"这是愿望" |
| **三类盘点** | README 新增一整节：**(a) 33 条**（每条都指到具体判据）／**(b) 0 条**（本轮清空）／**(c) 8 条**（判据化不了，如实列出 + 原因） |
| **只读子命令** | **`pipeline_boundaries`（第 28 个工具）**：导出机器可读边界清单，供 DSH 层的 `UserPromptSubmit` / `PreToolUse` 钩子复用 |
| **漂移检查** | 清单里的 `unmapped[]`：角色表里的 `writes` 取值若守门认不出，会**显式出现**在这里 —— 让"文档一套、代码一套"这件事看得见 |

### 二、全角色 `writes` 逐字节对齐（本轮的实际改动）

以前每个角色的 `writes` 只是**一张说明性的表**，守门只认三条粗判据
（能写源码 / 能写 reports / 不能写）。现在它变成**能力分类**，逐角色落到路径判据：

| 类别 | 取值 | 谁 | 守门怎么判 |
|---|---|---|---|
| **真只读** | `readonly` | `main` / `orchestrator` / `planner` | 项目内**任何**写入都拒 —— **连 `reports/` 也不给**（它们的产物是结构化交接物，由 `pipeline_*` 工具落盘） |
| **只写自己那一片** | `own-dir` | `tester` / `architect` / `security` / `archivist` / `diagrammer` / `release` / `docs` / `performance` / `arbiter` | 只写 `<任务>/reports/<role>/<role>[-后缀].log\|jsonl\|md\|json\|txt` |
| **只有日志** | `own-log` | `reviewer` | 同上，但**扩展名只允许 `.log` / `.jsonl`** |
| **源码树** | `workdir` | `writer` / `human` | 受 `scope_paths` + `change_scope` **双重**约束 |

三处**收紧**（都在"更严"的方向）：

1. **`tester`：`reports` → `own-dir`**。用户原话"测试 ai 等同理"。
   旧行为下它虽然改不了源码，却能在 `reports/` 根下写任何东西（别人的报告、随便一个文件）。
2. **`main` / `orchestrator` / `planner`：`none`/`reports` → `readonly`**。
   这是本轮发现的**真实的口子**：`writes: 'none'` 只是"不许写受保护位置"，
   而守门那条判据**放行了 `reports/`** —— 于是"主对话不写文件"这句写在角色卡里的话，
   代码里其实不成立。现在判据与措辞一致了。
3. **`tester` / `reviewer` 的"不得替编写改代码"：summary → 判据**。
   以前这句话只是角色卡里的一行字；现在源码路径**根本不在**它们的允许面内，
   所以"替编写改代码"这件事在机制上做不到（而不是"被劝阻"）。

顺带修了一个真 bug：`own-dir` 的文件名判据写成 `[\w.]+`，
而 `\w` **不含连字符** —— `tester-test-report.md` 这种正常命名会被判成非法。
改成 `[\w.-]+` 并补了自测。

### 三、(b) 类本轮做掉的（这类现在为空）

1. **测试 / 审核"不得替编写改代码"** —— 见上表第 3 条。
2. **测试只写自己的产物/日志** —— `own-dir`。
3. **控制角色不写文件** —— `readonly`（修掉了上面那个口子）。
4. **发布 / 文档 / 性能"关单前必须给出产物"** —— 以前只写在 `roles.js` 的 `summary` 里
   （"关单前必须给出可执行的发布与回滚计划"），**没有任何判据**。
   现在新增关单组合闸 **`role_products_delivered`**，与既有的 `diagram_delivered` **完全同形**：
   清单里派了 `release`/`docs`/`performance`，就得交 `release_plan`/`docs_note`/`perf_report`。
   只在"该角色确实在册"时生效 ⇒ L0~L3 完全不受影响。
5. **全角色权限对账** —— `pipeline_boundaries` 的 `unmapped` 漂移检查 + 自测断言
   "守门认得出的角色 = 全部 15 个"。

### 四、(c) 类：**判据化不了**的，如实列出（8 条）

`C1 别过度设计 / 计划要合理`、`C2 需求分析要问得全 / 计划自检要到位`、
`C3 交接物要写得清楚`、`C4 测试要"独立设计"用例`、`C5 主对话不得把令牌转手`、
`C6 不得用 shell 刻意混淆绕过判据`、`C7 未绑定角色的会话不受约束`、
`C8 记录之间矛盾时留档 AI 不得自己拍板`。

每一条都在 README 表里写了**为什么判据化不了**，并指明了"能判的那部分是哪条判据"。
**我没有把它们塞进 (a)** —— 那正是用户说的"不许假装它被执法了"。

### 五、`pipeline_boundaries` 的形状（给钩子层用）

```json
{
  "principle": "AI 的行为不靠自然语言限制，靠代码层直接拦截。",
  "lists": { "read_only_roles": [...], "own_log_roles": ["reviewer"], "own_dir_roles": [...] },
  "roles": [ { "id": "tester", "writes": "own-dir", "write_class": "own-dir",
               "read_only": false, "write_scope": ".pipeline/<taskId>/reports/tester/...",
               "can_read_source": true, "can_run_tests": true, "handoff_kinds": [...] } ],
  "rules": [ { "id": "R7", "zh": "没有写权限的位置一律只读（全角色）",
               "enforce": "guard:writeClassOf + checkOwnPath", "class": "a" } ],
  "advisory_limits": [ { "id": "C1", "zh": "别过度设计 / 计划要合理", "why": "判据化不了：…" } ],
  "unmapped": []
}
```

**派生而非手抄**：数据从 `roles.js` / `guard.js` / `handoff.js` / `states.js` 的**真实常量**取。
手抄一份必然与代码漂移，而漂移了的清单比没有更危险 —— 钩子层会照着错的清单执法。

### 六、集成点（用户说的"可选，别硬做"）

**做了，但没有改动既有结构**：新增一个**只读**工具 + 一个新模块（`lib/boundaries.js`），
不依赖任务、不需要身份、无副作用。既有 27 个工具、状态机、角色表一行没动
（`writes` 的**取值**变了，但那是本次要求的收紧本身）。

一处**如实说明**：钩子层能拿到的是**边界清单**，不是"本插件的运行时状态"。
也就是说它可以知道"`tester` 不许写源码"，但要知道"这次任务的授权面是什么"
仍然需要读本插件的 `.pipeline/<taskId>/task.json`。
要不要把运行时状态也导出去，见待拍板 **P9**。

### 七、实测

- `tests/review-check.mjs` 新增 **E 组（10 条）**：全角色 writes 与守门逐字节对齐（`unmapped` 为空）、
  能写源码的角色只有 writer/human、控制角色真只读、规则表全部指向代码判据、
  (c) 类如实列出且每条有原因、`pipeline_boundaries` 的 text/json 两种输出、
  清单里带三张名单、`role_products_delivered` 的正反例（缺产物拒 / 交齐过）。
- D 组扩到 **11 条**：新增"`tester` 写自己那一片放行 / 写 reports 根下拒"、
  "主对话与计划 AI 真只读（连 reports/ 都不给）"。
- selftest 的反例③扩了"测试写 reports/ 根下 → 拒"这条对照。

**全量：十五套，586/586 通过**（`review-check` 51 条）。
---

## 18.14 ★ 拦截做进插件自己：宿主拦截缝 + 自带 Skill + 作用域 + kill-switch

> 用户纠正：
> 「**我是让你安排写入多 ai 协同插件中去阻止他们干不该干的事，而不是新写**」
> 「**测试 ai 等同理，没有权限动文件的就只能只读**；
>  总的来说 **ai 的行为不要靠自然语言限制，要靠代码层直接拦截**」

同时**撤回**上一轮的「集成点（可选）：把边界清单导给另一条钩子线」那个方向 ——
拦截不再指望"别的层"，就做在本插件里。（`pipeline_boundaries` 保留：它是一个只读的
**可审计导出**，不是执法依赖。）

### 一、路线选择：为什么走 (a) 原生扩展点，而不是 (b) hooks.json + 桥接插件

| | (a) 原生 Cordis 插件直接挂 harness 扩展点 ✅ **选它** | (b) 插件写 `hooks.json` + 让 `dsh-hooks-claude-code` 跑 |
|---|---|---|
| 依据 | `dsh-hook-protocol` 自己的 README：「没有参考工具对应物的定制行为**请避开整个组**：原生 Cordis 插件拥有完整的 harness API，无需中间的钩子协议」 | 需要把桥接插件加进 profile bundles |
| 判据成本 | 进程内一次函数调用（同步判据，零开销） | **每个钩子起一个子进程**：超时、stderr 摘要、退出码语义 |
| 配置面 | 插件自己带，一步装一步撤 | 要往**别人的** profile 配置里加条目 |
| 漂移风险 | 与 `ctx.tools.guard` 调用**同一个** `guard(exec)` ⇒ 两条缝不可能不一致 | 判据要**重写**一份到钩子脚本里 ⇒ 两份判据必然漂移 |

探到的缝（形状从 `@deepseek-ai/dsh-hooks-claude-code` 的实现里读出来的，不是猜的）：

```
ctx.on('tools/pre-execute',  async (exec, next)         => next() | {kind:'deny', reason} | {kind:'ask', reason?})
ctx.on('tools/post-execute', async (exec, result, next) => next() | {kind:'block', feedback:[...], additionalContexts?})
ctx.on('agent/pre-step',     async (payload, next)      => next() | {kind:'reject'} | {...下游, messages:[...注入]})
ctx.on('agent/turn-stopping') / ('subagent/start') / ('subagent/end') / ('agent/created')
```

### 二、挂了几条缝、各拦什么

| 缝 | 事件 | 拦什么 / 给什么 |
|---|---|---|
| ① | `tools/pre-execute` (PreToolUse) | **同一份守门判据**：编写跑测试、控制角色读代码、写到授权面外、退休席位动手、无身份调用… 命中 ⇒ `{kind:'deny', reason}`（**真拦住**） |
| ② | `agent/pre-step` (UserPromptSubmit) | **注入**：席位开场拿到「边界卡 + Stop Ladder 四问」（每个席位只注入一次）；**硬拦**两条：提示词让编写跑测试 / 让控制角色读代码 ⇒ `{kind:'reject'}` |
| ③ | `tools/post-execute` (PostToolUse) | **第二道网**：控制角色的工具结果里带代码正文 ⇒ `{kind:'block', feedback:[...]}`（正常路径在 ① 就被拦了，这里是"结果已经拿到"的兜底） |

**没用**的三条（诚实写出来）：`SessionStart` / `SubagentStart` 在**令牌绑定之前**触发
（`pipeline_dispatch` 是先建会话后绑定），那一刻认不出"这是哪个席位"，
所以注入点放在 `agent/pre-step`（第一次收到提示词时，绑定已完成）；
`Stop` 的契约要求构造宿主内部的 agent 消息形状（桥接里用的是 harness 的 `createUserMessage`），
插件不在那个模块里，硬构造等于猜内部形状 —— 见待拍板 **P10**。

### 三、作用域判据（**不做就是事故**）

这些缝是**宿主级**的：全机每个会话都会经过。所以每条缝的**第一句**永远是作用域判定：

```js
const seat = seatOf(agentIdOf(exec))   // tokens.roleOfAgent(agentId) → {role, taskId, seat} | null
if (seat === null) return next()       // ★ 不是管线席位 ⇒ 直通放行
```

- **判据** = 该 `agentId` 在本插件的**令牌表**里绑定了某个任务的某个角色。
  进程内、同步、不可伪造（令牌表是插件自己的内存结构）。
- **被管的**：本插件派出去的所有管线席位 —— 含管线席位**派生出来的子会话**
  （它们没有自己的令牌，`ctx.tools.guard` 那条缝认不出它们，这条缝认得）。
- **直通的**：用户自己的对话、别的项目的会话、别的插件的会话、主对话
  （主对话只在**调用 `pipeline_*` 工具**时受守门约束，那是另一条缝，行为与以前**完全一致**）。

### 四、kill-switch

| 层 | 位置 | 生效方式 |
|---|---|---|
| 配置层 | `config.intercept`（默认 `true`） | 关掉 = **一条缝都不挂**；需要重启 |
| 总开关 | 右上角「多AI 协调」按钮 / `pipeline_switch` 工具（`sw.isOn()`） | **即时**：三条缝当场弃权（判据第一句就是它），不重启、不注销 |
| 同一颗开关 | `ctx.tools.guard` 走**同一份**判据 | 所以"关掉守门"与"关掉拦截"是同一个动作，不会出现一半开一半关 |

### 五、要不要重启

| 改动 | 重启？ |
|---|---|
| 插件本体（工具 / 守门 / **拦截缝**） | **要**（Host 半边在启动时装载） |
| 自带的 `stop-ladder` Skill | **不要** —— 下一次会话就可见（技能目录每会话重扫） |
| 总开关开 / 关 | **不要**（即时） |
| 卸载 / 回滚 | 要（Host 半边在启动时卸载） |

### 六、Skill 由插件带（不许手工另建）

- 资源位置：`skills/stop-ladder/SKILL.md`（**插件目录内**，进 `RuntimeItems`，随插件一起装）
- `install.ps1` 一步落到 `<dsh-home>/skills/stop-ladder/SKILL.md`，
  并写一个 `.installed-by` 标记；加 `-NoSkill` 可跳过
- `rollback.ps1` 一步撤掉，且**只撤带本插件标记的那一份** ——
  没有标记（别人装的同名 Skill）只警告、不碰
- 四问写成了**可操作判据**：每问都有「怎么判」+「答不上来怎么办（停）」+ 一张
  证据/非证据对照表；四问本身与代码注入的 `STOP_LADDER_FOUR` **逐字一致**（自测里比对了）

### 七、正反例实测（`tests/intercept-check.mjs`，**24 条**）

| 组 | 条数 | 关键正反例 |
|---|---|---|
| A PreToolUse | 7 | ✅ 席位跑 `npm test` ⇒ `{kind:'deny'}`；✅ 正当写入 ⇒ `next()`；✅✅ **用户自己的会话 / 别的插件会话 / 空 agentId 跑同一条命令 ⇒ 三条都直通**；✅ 退休席位动手 ⇒ 拦 |
| B UserPromptSubmit | 6 | ✅ 席位开场注入边界卡 + 四问；✅ 只注入一次；✅✅ 提示词让编写跑测试 ⇒ `reject`；✅✅ 提示词让控制角色读代码 ⇒ `reject`；✅ 同一句话给编写 ⇒ 不拦（不误伤）；✅✅ 非管线会话 ⇒ 不注入不拦 |
| C PostToolUse | 3 | ✅ 控制角色拿到代码正文 ⇒ `block` + 反馈；✅ 编写拿到 ⇒ 放行；✅✅ 非管线会话 ⇒ 放行 |
| D kill-switch | 4 | ✅✅ 总开关关 ⇒ 三条缝立刻弃权；✅ 再开 ⇒ 立刻恢复；✅ 配置层总闸存在且默认开 |
| E Skill 资产 | 4 | ✅ Skill 在插件目录里且四问与代码注入逐字一致；✅ 四问是可操作判据；✅ 点明"Skill 是引导，拦截在代码里" |

`tests/load-smoke.mjs` 另加 3 条：**缝真的挂上了**（事件名逐个断言）、每个缝只挂一个中间件、
**非管线会话直通**。

**全量：十六套，616/616 通过。**

---

## 18.15 ★ 同批追加：全量测试审批链（默认只跑定向）

> 用户第五次补句话（仍属同一批）：
> 「**需求 ai 要确认是否，并尽可能让测试 ai 少跑全量测试**，如果测试 ai 要跑
> 必须提交给需求 ai 和审核 ai 确认，如果都认为要做再提交给主对话给用户人工审核，
> 确认人工通过后再提交给计划 ai 安排」

### 一、这条链讲成同一套目标函数

它不是孤立规则，是**前面几条的自然延伸**：

| 已有的规则 | 这条链怎么接上 |
|---|---|
| **改动面 = 授权面**（③） | 定向测试就是"按**改动面**挑相关用例"——同一个授权面，既是"允许改什么"的依据，也是"该测什么"的依据。全量 = 跳出改动面去测那些**本不该受影响**的东西 |
| **Stop Ladder 第四问：没它会失败吗？** | 申请单里 **必填** `why_targeted_insufficient`："不跑全量，会在哪一步失败？" —— 答不上来就不该提。这与第四问是同一个问题，只是被写成了字段 |
| **分析与计划只干什么、不要多干**（④） | 这条链让"要不要花大成本"回到需求分析（是否需要）与审核（值不值得）手里，而不是由测试角色**单方面**决定 |
| **别把整套跑当家常便饭** | 默认产物是定向/增量；全量是**例外**，且例外要有凭据 |

一句话：**"少干不该干的"在这里落成"少跑不该跑的"。**

### 二、链的形状（与澄清梯合流，不另起一套）

```
tester 交 full_test_request（写清改动面 / 已跑过的定向 / 为什么定向不够 / 打算怎么跑）
   → ① 需求分析  full_test_review stage=need    （这次是否真的需要）
   → ② 审核      full_test_review stage=worth   （值不值得）
   → ③ 主对话     pipeline_human_request reason_kind=full_test_approval → 用户答复
   → ④ 计划 AI   full_test_review stage=arrange（范围 + **最终批准的命令**）
   → 守门按"批准的那条命令"放行
```

**与澄清梯回答的是不同的问题**（这一点在文档与代码注释里都写死了）：

- `clarification_*` 回答「**需求本身清不清楚**」—— 答案在需求层，答完就能继续干活；
- `full_test_*` 回答「**这套测试值不值得跑**」—— **成本决策**，不改需求、不改计划范围。

两者的**形状**相同（提出 → 逐级裁定 → 顶到人工），所以**合流**：
第三站直接用既有的 `human_request` / `human_reply`（`human_reply_has_source` 那条判据一个字没动），
新增的只是两种**交接物** + 一条**链的进度记录** + **一个只读工具**。

- 新交接物：`full_test_request`（tester → orchestrator）、`full_test_review`（三站裁定，`stage` 区分）
- 新枚举：`HUMAN_REASON_KINDS.full_test_approval`
- 新记录：`task.full_test_approvals[]`（一条链的四个节点，不是四份散请求）
- 新工具：**`pipeline_full_test`（第 29 个，只读）** —— 把"走到哪一站、还差谁"摊开
  （没有它，守门只会说一句"走审批链"，这条链就成了黑箱）
- **没有新增状态**：链在 `testing` 状态里推进；"缺一级不许开跑"由**守门凭据判据**保证，
  不需要状态机停在某个格子上（也就没动 18 个状态的迁移表）

### 三、判定层：定向 vs 全量（**判据，不是感觉**）

`lib/testscope.js` 的 `classifyTestCommand(cmd)` 只回答一个问题：这条命令是不是"整套跑"？

**先认出"这是测试命令"**（npm/pnpm/yarn/bun test、jest/vitest/mocha/ava、
pytest/unittest、go test、cargo test、dotnet test、maven/gradle test、node --test、
phpunit/rspec），**再看有没有收窄范围**：

| 收窄（⇒ 定向，**直接放行**） | 例子 |
|---|---|
| 过滤参数 | `-k` / `-m` / `-t` / `--grep` / `--testPathPattern` / `--testNamePattern` / `--filter` / `-Dtest=` / `--tests` / `-run` / `--test`(cargo) |
| `--` 之后的具体用例 | `npm test -- src/a.test.ts` |
| 命令里直接给具体测试文件 | `node --test tests/a.test.mjs`、`pytest tests/unit/test_a.py` |
| 具体包（不是全包） | `go test ./pkg/x`（`go test ./...` 是全量） |

| 不收窄（⇒ 全量，**要凭据**） | 例子 |
|---|---|
| 裸跑整套 | `npm test`、`npm run test:unit`、`pytest`、`npx vitest run`、`cargo test` |
| 全包写法 | `go test ./...`、`--all` |
| 整目录 | `node --test tests/` |

★ 两个**踩过的坑**（都已写成回归用例）：
① `node --test tests/` 曾被判成"定向" —— 因为 `--test` 被当成了收窄参数；
   它其实是**选运行器**，不是收窄。区分办法：先把 `node --test` 消掉再认收窄参数。
② `jest --testPathPattern=…` 曾因裸 `jest` 规则写得太窄而**认不出是测试命令**（弃权）。

**已知边界（诚实写出来）**：变量拼接、脚本里再调 `npm test`、`make test` 这类自定义脚本名
—— 字符串判据看不到，一律**弃权**（宁可漏判也不误拦）；这类靠自觉申请 + 审核看
`what_will_run` 兜。

### 四、执法层：凭据

守门在 **shell 那条缝**上加了一条判据（`lib/guard.js` 的 4f）：

1. 命令是**全量**吗？（上面的判定）
2. 是 ⇒ 该任务有没有 `fullTestCredential`？
   **凭据 = 四级全部通过**：`need.ok === true` 且 `worth.ok === true` 且 `human.approved === true`
   且 `arranged !== null` —— 少一级就没有凭据；
3. 有凭据 ⇒ 再比对**批的是不是这一条命令**（`sameTestCommand`：逐字一致、或只多了不改变范围的开关）；
   批一条跑另一条 ⇒ 拒。

**任一站否决** ⇒ 链 `status='rejected'` + `rejected_at_stage` + `reject_reason`（留痕），
之后**任何**全量命令仍然被拦（"反正申请过"不管用）。

### 五、实测（`tests/fulltest-check.mjs`，**44 条**）

| 组 | 条数 | 内容 |
|---|---|---|
| A 判定层 | 24 | 23 种命令形态逐条对（含 **11 条"定向不许误拦"**）+ 命令比对（逐字/多开关/换主干） |
| B 执法层 | 9 | 定向放行；**无凭据全量⇒拦**（并给出完整走法）；越级（审核先判）⇒拒；站别与角色不符⇒拒；need 同意；worth 同意；**两级都同意但人工没点头⇒仍拦**；人工没通过就安排⇒拒 |
| C 终点 | 11 | 人工**不通过**⇒链停住+留痕+仍拦+后续站不能再加裁定；重开一条链；人工通过但计划未安排⇒仍拦；arrange 给出最终命令⇒收下；**四级齐⇒同一条命令放行**；`npm test --ci` 也算同一条⇒放行；**批 `npm test` 却跑 `pytest`⇒拒**；拿凭据后定向照样放行；只读工具 `pipeline_full_test` 把进度与凭据摊开 |

`tests/boundary-check.mjs` 也同步加了对照：tester 跑**定向**放行、裸跑整套要凭据
（原来那条"tester 跑 `npm test` 放行"的对照已被本轮规则取代）。

**全量：十七套，662/662 通过**（连跑 5 次全绿）。

### 六、待用户拍板（新增 P11、P12）

- **P11**：`make test` / `npm run check` 这类**自定义脚本名**认不出（弃权）。要不要加一份
  "项目自定义测试入口"的声明（写在需求档或计划里），让判据认得出它们？
- **P12**：凭据是**一次性**的（批准的那条命令能跑；跑完不自动失效，也不会自动复用在下一轮）。
  要不要给它加**有效期 / 轮次绑定**（例如下一轮改动之后必须重走链）？

---

## 18.16 ★ 同批追加：哈希前置闸门（排在一切测试之前）

> 用户第六次补句话（仍属同一批）：
> 「**先过哈希对比，哈希对比不过全量测试直接打回**」

### 一、位置：它是**最前面**那道闸

```
编写交产物（dev_to_test）
  ├─ ① 形状核对：change_manifest 每条引用一个存在的授权条目（上一批做的）
  ├─ ② ★哈希闸门：按派活基线逐文件比（新增 / 修改 / 删除三类）
  │     ├─ 通过 → 放行 → 进测试
  │     └─ 不通过 → **直接打回编写**
  │           · 不进入测试（任务仍停在"开发中"）
  │           · **不消耗测试预算**
  │           · **不进"是否跑全量"的审批链**
  └─ ③ 之后的才是：测试 → 审核 → 关单
```

**设计意图（写进了给编写看的拒绝文案里）：不合格的提交不该消耗测试资源。**
让测试去跑一套注定被打回的产物，是纯浪费 —— 时间、token、以及测试角色的注意力。
这是省时间省 token 的**第一道闸**。

### 二、对比维度（四类）

比对对象三份：① 派活那一刻的**基线**（文件清单 + sha256）；② 计划给的**授权改动面**；
③ 编写自己交的**改动声明**（change_manifest）。

| 类别 | 判据 | 为什么也算不过 |
|---|---|---|
| **新增** | 基线里没有、现在有，且不在授权面内 | 与"改动面 = 授权面"一致：**新增文件也算越界** |
| **修改** | 两边都有但哈希不同，且不在授权面内 | 同上（"改了这一处"必须被授权过） |
| **删除** | 基线里有、现在没有，且不在授权面内 | 删也是一种改；本批点名要查这一类 |
| **声明不实** | 实际动了，但 `change_manifest` 里没报 | 哈希是**真相**，声明是**承诺**；两者不一致时，测试与审核按声明去核对就等于核对了假的 —— 比越界更危险（越界至少看得见） |

### 三、打回理由**可执行**（不是一句"你不合规"）

拒绝文案里逐条给出：**哪个文件** · **基线哈希** · **实际哈希** · **期望怎么办** ·
本次授权面清单 · 实测明细（新增/修改/删除的路径与哈希）·
以及"**测试没有被触发 / 没有消耗测试预算**"这句结论。

### 四、不许"先跑一下看看"（守门在工具层拦）

闸门没过之后，**任何角色（包括 tester）都不许跑测试** —— 守门新增分支 **4g**：

- 判据：`task.hash_gate.blocked === true`（最近一次 dev_to_test 因哈希对比被拒，且还没重新通过）
- 拦的是**任何**测试命令：**定向与全量都拦**（闸门没过意味着"改动面本身就不合法"，
  这时跑任何测试都是在给一份注定要改的产物做验证）
- 分支顺序：**4g 排在 4f（全量审批）之前** —— 哈希闸门更根本，先撞它才是对的

### 五、落档留痕

- `task.hash_gate_checks[]`：每次提交的对比结果（基线 id / 判定 / 三类计数 / 逐条违规 /
  各文件的哈希）
- 审计事件 **`gate:hash`**：谁、什么时候、哪一版基线、通过与否、违规摘要
- `task.hash_gate`：当前闸门状态（`blocked` / 违规清单）—— 同步索引里带一份，
  供守门**同步**判"这一刻许不许跑测试"

### 六、**踩过的两个真坑**（都写成了注释与回归）

1. **局部变量遮蔽了 `audit()` 函数**：闸门代码里 `const audit = await this.changeAudit(...)`
   把模块级的 `audit()` 遮住了，后面 `await audit(task.id, ...)` 变成"把对象当函数调"，
   30 条既有用例当场变红。改名 `auditRes`。
2. **失败路径没有刷新同步索引**：闸门在拒绝之前**已经**把 `hash_gate.blocked` 写进任务，
   但 `pipeline_handoff` 工具在失败分支**直接 return**，索引还是旧的 ⇒
   守门看不到闸门状态 ⇒ "闸门没过不许跑测试"**静默失效**。
   修法：失败分支也 `indexTask(...)`（并且 store 的 deny 把 `task` 一起带出来）。
   —— 这正是"自测不写就等于没有"的又一个实例：不测这条，功能是看起来做了、实际不生效。

### 七、实测（`tests/hashgate-check.mjs`，**38 条**）

| 组 | 条数 | 内容 |
|---|---|---|
| A 判定层 | 7 | 正例（全在授权内）；新增/修改/删除三类越界各一条；**声明不实**一条；打回理由可执行性（文件+基线哈希+实际哈希+期望+授权面）；文案里明说"测试没有被触发" |
| B 执法层 | 31 | 正例：授权面内 ⇒ 放行 + 落档；**四种不通过**（清单外被改 / 新增清单外 / 删了不该删的 / 声明不实）各验 4 条：提交被拒+状态不变 / 理由点名具体文件 / 闸门卡住 / **定向与全量测试都跑不了** / 落档留痕；**撤回越界后重交 ⇒ 闸门解除**（且定向能跑、全量仍走审批链）；L0 弃权说明 |

**全量：十八套，700/700 通过**（连跑 6 次全绿）。

### 八、待用户拍板（新增 P13）

- **P13**：闸门不通过**不消耗打回预算**（`maxReworkPerLeg` 不动）。理由：任务从未离开
  `developing`，"打回"这个动作严格说没有发生（提交本身不成立），预算是为"来回拉锯"设的。
  风险：编写可以无限重交。要不要改成"连续 N 次闸门不过就计入一次打回"或直接交人工？

> ⚠️ **上面这条已于 2026-10-11 由用户拍板，见下面的 18.17 —— P13 已划掉，不再是待拍板项。**

---

## 18.17 ★ P13 拍板落地：连续 N 次不过 ⇒ 自动交人工（2026-10-11）

> 用户拍板原文（本轮）：
> 「哈希闸门**不通过不消耗打回预算**（**保持现状**），**但连续 N 次不过就自动交人工**」
> —— 也就是 P13 给的三条路里，选 **① + ③**（保留"不扣预算"，再加"连续不过就交人工"）。
> 另外两条硬要求：「走**既有的** `human_request`/两级梯，**不许另起一套并行机制**；
> 人工答复必须带来源与本人原话，**既有判据不许破**」、
> 「升级发生后，**不许**继续接受同一任务的无限重交」。

### 一、两半各自落在哪（一行定位）

| 拍板的一半 | 落点 | 有没有改既有逻辑 |
|---|---|---|
| **不扣打回预算**（保持现状） | `lib/store.js` 的哈希闸门分支 —— **一个字都没动** | 没有（这条本来就是现状；加了回归用例盯住它） |
| **连续 N 次不过 ⇒ 自动交人工** | 计数在闸门分支；升级在 `store.escalateHashGate`；拒收在 `submitHandoff` 的 ③a；重新武装在 `replyHumanRequest` | 新增，且全部挂在既有机制上 |

### 二、语义（**写死**，别处不许再定义一遍）

- **计数**：`task.hash_gate_streak`。不通过 +1。
- **归零的唯一点**：**一次闸门真通过的提交**（或用户答复了本机制发出的那条人工请求）。
- **撤回越界改动不归零** —— 这是**取舍**，理由写进代码注释与 README：
  撤回不是机制可观测的事件（机制只看得到"下一次提交过没过"）。
  若按"撤回就归零"，`撤回 → 重交 → 再越界 → 再撤回` 可以无限循环，而每一次都**看起来有进展**。
- **阈值**：`hashGateEscalateAfter`（与 `guardHashGate` 并列），**默认 3**，**`0` = 关掉自动升级**。
  关掉 = 退回 P13 之前的行为（编写可以无限重交）；**闸门本身照旧执法、预算照旧不扣**。
- **到阈值**：机制**自动**发起一条 `human_request`，`reason_kind=hash_gate_escalation`。
  - **谁发起**：`orchestrator_mode=separate` 时是**需求分析**（两级梯的第二级本来就是它）；
    没有独立编排的档位退化成**取基线的那个人**（`baseline.taken_by`）——
    这样 `from_role` 一定是本任务里真实存在的角色，不撒谎。
  - **不是角色发的**：角色走 `pipeline_handoff` 发这个 reason_kind 会被拒
    （`HASH_GATE_ESCALATION_IS_SYSTEM`）。理由：这条请求的全部意义是"**阈值到了**"，
    而阈值是机制数的数 —— 让角色自己声明"我已经连续失败 3 次"，
    等于把"什么时候该惊动用户"交给**被考核的那一方**去定。
  - 顺带三条自相矛盾的守卫：阈值关着却出现该请求（`..._DISABLED`）、
    计数没到阈值（`..._TOO_EARLY`）、已有一条没答复的（`..._PENDING`）—— 全部拒。
- **升级之后**：用户答复之前，同一任务的 `dev_to_test` **被拒收**（`HASH_GATE_ESCALATED`）。
  这条**排在状态预检之前**：否则会被 `HANDOFF_STEP_SKIPPED`（"跳步"）先盖住 ——
  而"你顺序搞错了"和"机制已经把这件事交给人了，你在等人回话"是两句话、两种处置。
- **答复之后**：**重新武装** —— 升级记录标 `answered_at`，计数归零，可再次累计、再次升级
  （`round` +1）。理由：用户的答复未必真能解决问题；若升级一次就永久失效，
  第 4 次以后的失败就**没人管**了 —— 那正是本条要堵的"无限重交"。
  重新武装之后仍然是"每连续 N 次就有人点头"，不存在没人看着的重交。

### 三、为什么**没有**另起一套并行机制

「不许另起一套并行机制」是按**下面这张表**逐项对过的：

| 需要的东西 | 用的是哪个既有的 | 新加的吗 |
|---|---|---|
| 请求载体 | `human_request` 交接物（`handoffs/*.json` 原件） | 否 |
| 生命周期 | `task.human_requests[]`（发起→转告→答复→恢复四步） | 否 |
| 状态推进 | `awaiting_human` 那两条边（`*→human_request→awaiting_human`、`→human_reply→(previous)`） | 否 |
| 转告 / 答复 / 恢复 | `pipeline_human_relay` / `pipeline_human_reply` | 否 |
| 答复判据 | `human_reply_has_source`（user_quote + attribution + confirm_code + 形状） | **一个字没动** |
| 关单 / 超时 | 异步无关；`timeout_behavior=stay_blocked`（机制不设默认、不按超时自己走） | 否 |
| 理由枚举 | `HUMAN_REASON_KINDS` **加一个值** | 是（1 个枚举值） |

唯一的"新"是那个枚举值，加上"**只有机制发得出来**"那一条闸。

### 四、落档留痕（可追溯性）

- `task.hash_gate_streak`：连续计数；`task.hash_gate`：当前闸门状态（含 `streak`/`threshold`）。
- `task.hash_gate_checks[]`：**每一次**比对的时间 / 发起人 / 席位 / 通过与否 /
  **这是连续第几次** / 阈值 / 越界明细 —— "每次失败的时间与理由"就在这儿。
- `task.hash_gate_escalation`：升级动作本身（`round` / `at` / `streak` / `threshold` /
  `request_id` / `handoff_id` / `from_role` / `answered_at` / `answer_source` / `user_quote` / `resumed_to`）。
- 审计 `audit.jsonl`：`gate:hash`（每次比对）· `gate:hash_escalate`（升级动作）·
  `gate:hash_rearm`（答复后重新武装）· `gate:hash_escalate_failed`（升级没发出去，含原因）。
- 可见面：`pipeline_status` 新增 `hash_gate` 视图（`blocked` / `streak` / `threshold` /
  `accepting_submissions` / 最近 20 次比对 / 升级记录），状态摘要里也有一行。

### 五、代码层执法（**不是提醒**）

1. **拒收重交**：升级未了结期间，`dev_to_test` 在 store 层被拒（`HASH_GATE_ESCALATED`），
   工具层与绕过守门直调 store **两道都拦**（自测里两条都验了）。
2. **守门同步判据**：`taskIndex` 新增 `hashGateEscalated`（与 `hashGateBlocked` 并列），
   守门分支 4g 的文案因它分成"你回去改"与"已经交人工了，等人回话"两种 ——
   **拦截与否仍由 `hashGateBlocked` 决定**，新字段只影响说给谁听。
   ⚠️ 这里再次盯住了本项目的老坑：**失败分支必须回灌同步索引**
   （`pipeline_handoff` 拿到 `res.task` 后 `indexTask`），自测里有一条专门断言索引里的
   `hashGateBlocked` / `hashGateEscalated` / `hashGate.streak` 都对得上，且升级后测试**真的跑不了**。

### 六、实测（`tests/hashgate-check.mjs`，**38 → 61 条**）

| 组 | 条数 | 内容 |
|---|---|---|
| A 判定层 | 7 | （不变）三类越界 + 声明不实 + 理由可执行 |
| B 执法层 | 31 | （不变）四种不通过在测试之前打回、四类证据、闸门卡住、测试跑不了、撤回后解除 |
| **C 连续不过与自动交人工** | **17** | 纯函数口径（+1 / 只有通过才归零 / 到阈值才升级 / 已升级未答复不再叠）；**正例①** 一次不过→撤回→重交成功⇒**计数归零**；每次失败留痕；**不消耗打回预算**；**反例③** 连续 3 次⇒**自动升级**（贴交接物+生命周期+状态+审计）；索引刷新 + 升级后**测试也跑不了**；**拒收重交**（工具层 + 直调 store）；答复仍需 user_quote/attribution；答复后**重新武装** + 答复后再攒 3 次 ⇒ **round=2**；**发起人兜底**（基线记录人是 `main` 时改由计划 AI 发起）；**反例④** 两任务同台各失败 2 次 ⇒ **各自是 2**（不串台） |
| **D 打回预算回归** | **3** | **正例②**：闸门不通过 ⇒ `rework.dev` 仍 0；干净提交 ⇒ 计数归零；随后**打回照样扣预算**（2 次成功、第 3 次 `REWORK_EXHAUSTED`） |
| **E 关掉自动升级** | **3** | 配置层：默认 3、**`0` 是合法值**（不被默认顶回去）、负数/小数/字符串回落默认；执法层：阈值 0 时**连交 5 次**全被拒但**一次都不升级**、状态仍 `developing`、闸门与"不扣预算"都还在 |

**全量：十八套，723/723 通过 —— 连跑 3 次结果一致（exit 0）**，
每个套件的原始输出同步落盘到 `tests/<suite>-last-run.txt`。

### 七、本轮**自己踩的坑**（留给后人）

1. **`store.peek()` 返回的是内存里那个活对象，不是快照** ——
   `const t = peek(id)` 之后再提交，`t` 里的计数会跟着变。
   第一版就是这么写"失败时计数是 1"的断言的：后面那次**成功**的提交把计数改成 0，
   同一个对象上的断言当场变假红。修法：`snap()` 深拷一份再比。
   （与 18.16 的坑同源：**"看起来在测 A，其实测的是它变化后的样子"**。）
2. **断言不能盯"错误码字面量"**：`MISSING_USER_QUOTE` / `MISSING_ATTRIBUTION` 这两个
   拒绝文案里**没有**码字，只有中文说明 —— 断言 `includes('MISSING_USER_QUOTE')` 会假红。
   判据要看**行为**（`denied === true` + 文案关键片段），不是码字。
3. **夹具缺目录**：往 `src/evil.js` 写文件前没建 `src/`，`ENOENT` 整轮中断。
   与既有用例的写法对齐（先 `mkdir(..., {recursive:true})`）即可。
4. **★ 一个会在角落路径上静默失效的洞（自查时抓到并补掉）**：
   升级的发起人原本写成 `baseline.taken_by ?? planner`。但基线**可以重取**，
   而重取允许"主对话兜底"（`pipeline_change_audit` 的 take 权限）——
   一旦 `taken_by === 'main'`，`canProduceHandoff('main','human_request')` 直接拒
   （`main` 不在 `ROLES_CAN_RAISE_HUMAN` 里：用户只与主对话相连，它要问用户直接问即可）。
   后果：升级**发不出去**，现场只剩一条 `gate:hash_escalate_failed`，
   "连续 N 次不过"这件事又变成没人管 —— 正是这一轮要堵的东西。
   修法：`from_role` 逐级回退，每一步都过一遍 `ROLES_CAN_RAISE_HUMAN`
   （需求分析 → 取基线的人 → 计划 AI）。
   **并做了反向对照**：把修法临时改回旧写法 → 对应用例当场变红（`✗`，60/61，exit 1）；
   改回来 → 61/61。**只有"能红"的断言才算测过**。

### 八、P13 结论（待拍板清单变动）

- **P13 划掉**：不再是待拍板项。结论 = **不扣打回预算** + **连续 `hashGateEscalateAfter`
  （默认 3，`0` = 关）次不过 ⇒ **自动交人工**（既有 human_request / 两级梯），
  升级未了结期间**拒收**重交；归零点 = **一次闸门真通过**（撤回不归零）。
- **本次没有新增待拍板项**：P13 这个取舍没有牵出新的歧义
  （"答复后重新武装"是同一个阈值语义的自然延伸，不是新开关）。
- 现挂待拍板：**P1~P6、P8、P10~P12**（共 10 项）。

