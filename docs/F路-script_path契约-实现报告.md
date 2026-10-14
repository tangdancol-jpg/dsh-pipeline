# F 路 · `script_path` 契约（★ 只做文案那一半）—— 实现报告

> **任务**：把 dsh-ops 可参考清单 §2 结论一**第 1 名**（§1.6 `script_path` 契约）里"文案与指引"那一半做进 dsh-pipeline。
> **依据**：`%USERPROFILE%\.dsh\dsh_orb\dsh-ops-可参考清单.md` §2 结论一第 1 名 + §1.6 + §4.8/4.9。
> **参考实现**：`_ref-dsh-ops\lib\shells.js:933-942`（工具描述）+ `lib\policy.js:62`（提示词）。
> **本轮范围**：✅ 文案与指引；❌ **守门那一半（C3 盲区）一个字都没动**（`lib/guard-factory.js` 有会话正在改它，见第四节"不实施"）。
> **产物日期**：2026-10-14　**执行者**：F 路（文案半）

---

## 一、查清：我们的「角色卡 / 技能 / 提示词」到底落在哪些文件

**先说结论（一句话）**：真正**进模型上下文**的只有 **3 个地方**（① system prompt 段 ② 席位开场简报 ③ 派活单）；
`lib/roles.js` / `lib/boundaries.js` / `lib/tiers.js` 是**事实来源（数据）**，它们**自己不会被投进会话**，要靠上面三条通道渲染才进上下文。
把这个分清很重要 —— 改"数据"不会改变任何模型看到的东西。

### 1) 提示词（system prompt 段）——**每个会话都带**

| 文件:行 | 是什么 | 证据 |
|---|---|---|
| `index.js:933-969` | `PIPELINE_PROMPT` —— 注册进 system prompt 的那段说明（六条规则 + 各角色叮嘱） | 导出名与注释：`:927-932`「注册进 system prompt 的说明」 |
| `index.js:800-810` | 注册点：`ctx.systemPrompt?.section?.({ name:'pipeline:roles', order: PROMPT_ORDER, text: () => PIPELINE_PROMPT })` | `PROMPT_ORDER = 2650`（`index.js:117-118`） |
| `lib/config.js:225` | 开关 `registerPromptSection: true`（**默认开**） | 改前实测装载日志：`system prompt 段注册了 1 段 sections=[{"name":"pipeline:roles","order":2650}]` |
| `tests/load-smoke.mjs:185,187` | 自测断言：**只有 1 段**、名字 `pipeline:roles`、order 是有限数 | 断言原文 `f.sections.length === 1 && f.sections[0].name === 'pipeline:roles'` |

### 2) 角色卡（"事实来源"层 · 是**数据**，不直接进上下文）

| 文件:行 | 是什么 |
|---|---|
| `lib/roles.js:30-87` / `:126-433` | `ROLE` 常量 + `ROLES[...]`：每个角色的 `zh/en/kind/writes/handoffKinds/canRework/summary`。**`summary` 就是"角色职责"那段文案** |
| `lib/roles.js:89-125` | `writes` 五种取值的语义（注释即契约：`readonly`/`workdir`/`own-dir`/`own-log`/`none`） |
| `lib/roles.js:473-503` | 编写席位 / 层清单（`MAX_WRITER_SEATS` / `WRITER_LAYERS` / `DEFAULT_WRITER_LAYERS`） |
| `lib/boundaries.js:80-222` | `RULES`（R1~R12 六条设计目的 → **判据函数名**） |
| `lib/boundaries.js:230-283` | `ADVISORY_LIMITS`（C1~C8，"判据化不了的"诚实清单）★ **C6 就是"先写脚本再跑"**（`:264-270`） |
| `lib/boundaries.js:290-682` / `:687-756` | `boundaryManifest()` 只读导出 + 人读文本渲染 |
| `lib/tiers.js:62-128` | `TIERS` 档位表（L0~L5 的独立对话数、`maxWriters`） |
| `lib/tiers.js:824-1035` | 四槽（permission/mode/model/reasoning）的字段名与落值规则 |
| `lib/tools.js`（31 个 `pipeline_*`） | **工具描述与参数描述 —— 它们也是给模型看的提示词**（例：`:1730`、`:2292`、`:4600`、`:4620`）。本轮**未改** |

### 3) 角色卡 → 席位的三条**投递通道**（真正进上下文的地方）

| # | 文件:行 | 通道 | 内容 |
|---|---|---|---|
| ① | `lib/intercept.js:228-260`（`seatBriefing()`）<br>投递点 `lib/intercept.js:487-516` | **席位开场注入**（`agent/pre-step`，每个席位**只注入一次**，键 `taskId|role|seat`） | 边界卡 `只做：`/`不做：` + 本次越界清单 + **Stop Ladder 四问** |
| ② | `lib/transport/index.js:72-103`（`renderDispatchBrief()`） | **派活单**（子代理的**初始 prompt**；`transport=subagent` 时投递点 `:1017-1028`） | 任务 ID / 档位 / 原始需求 / 验收标准 / 约束 / **你的角色职责（= `ROLES[role].summary`）** / 接入方式 |
| ③ | `lib/tools.js:2221-2227` | **派活回执里的边界卡**（贴在 `pipeline_dispatch` 的返回值上） | `【你的边界卡（计划里写死的）】…只做 / 不做` |
| — | `lib/intercept.js:143-148` | Stop Ladder 四问的**定义处** | `STOP_LADDER_FOUR`（被 ① 与技能文件共同引用） |

### 4) 技能（`skills/`）

| 文件:行 | 是什么 |
|---|---|
| `skills/stop-ladder/SKILL.md`（共 78 行） | **`skills/` 下唯一的技能**：四问的"引导"版。它的四问与代码注入**必须一致**，由 `tests/intercept-check.mjs:444-482` 守着（比四问核心问句 + `怎么判` / `答不上来就是不做` / `停` / `引导` / `代码`） |

### 5) 还有一处**必须知道**的：拦截缝自带的"提示词判据"

| 文件:行 | 是什么 |
|---|---|
| `lib/intercept.js:150-152` / `:190-219` | `PROMPT_CODE_READ_RE` + `judgePrompt()` —— 它会**拒绝**"让这个席位干它干不了的事"的提示词（编写席位 + 提示词里出现**测试命令** ⇒ 拒；控制角色 + "读代码"同现 ⇒ 拒） |
| `lib/intercept.js:724-734` | `collectPromptText()` —— 只拼 `payload.messages` 的文本，**不含 system prompt 段** |

⚠️ 这一条决定了改文案的**风险面**：写进**席位简报**的文本会进编写席位的上下文，**必须自己先过 `scanTestRunnerCommand`**，否则等于自己把自己判红。本轮已自查（见第五节）。

---

## 二、改了哪些文件、加了什么指引

**只改了 2 个文件、2 个函数**，全部是**纯文案**（新增字符串行；零逻辑分支、零新依赖、零新函数、零新键）。

### 改动 1：`index.js` —— `PIPELINE_PROMPT`（system prompt 段）

- 插入点：`index.js:951-958`（原文 `:951` 是一个空行；插在第⑥条规则之后、"如果你是被开单的主对话"之前）
- 为什么插在这里：这样**不动"六条规则"的条数**（原文写的就是"六条规则"）。**没有**把它编成第⑦条。

**新增原文（逐字）**：

```
★ **跑 shell 的写法（省的是最贵的一种失败）**：多行命令，或命令里带引号 / 反斜杠 / 中文 / 换行时，
  **不要**整段塞进 shell 的 command 参数 —— 先把脚本落到**你有权写的位置**，再执行那个文件
  （`pwsh -File x.ps1` / `bash x.sh`）。为什么：Windows + PowerShell 下**多层转义**（引号/中文/路径/换行叠在一起）
  会把**工具调用本身的 JSON** 写坏 ⇒ MALFORMED_RESPONSE —— 它作废的不是一次调用，而是**整轮**
  （连此前积累的全部上下文一起丢），是 token 消耗里最贵的一种形态。多花一次 write，换整轮不炸。
  ★ 它是**写法**，不是后门：落盘的脚本与直接写在 command 里的命令，受**同一套判据**管，
    脚本落在授权面之外照样被拒（新增文件也要在授权面里）。
```

### 改动 2：`lib/intercept.js` —— `seatBriefing()`（席位开场简报）

- 插入点：`lib/intercept.js:246-258`（加在"★ 这些不是建议…"之后，`return L.join('\n')` 之前）
- 为什么插在这里：**这是唯一"必然到达每个席位"的一条注入**（system prompt 段受 `config.registerPromptSection` 控制，而这条缝只对管线席位生效、一次注入、直达它自己的轮次）。
- 同处还补了 **8 行注释**（`:246-253`），写清三件事：为什么放这条缝、它治的是什么、以及**措辞纪律**（不许出现测试类命令样例）。

**新增原文（逐字）**：

```
★ 要跑 shell 时：多行 / 带引号 / 带中文 / 带反斜杠的命令，**先落盘成脚本文件再执行那个文件**
  （`pwsh -File x.ps1` / `bash x.sh`），不要整段塞进 command 参数。
  为什么：多层转义会把**工具调用的 JSON** 写坏 ⇒ MALFORMED_RESPONSE ⇒ **整轮作废**（含此前全部上下文）—— 最贵的一种失败。
  它是写法不是后门：脚本与命令受**同一套判据**管，落在你的授权面之外照样被拒。
```

### 明确的**不改**清单（连同理由，免得被当成漏做）

| 没改 | 为什么 |
|---|---|
| `skills/stop-ladder/SKILL.md` | 它是"**别顺手加戏**"的技能，触发场景是"准备做一件计划/需求里没有的事"。**shell 写法不属于它的触发面** —— 硬塞进去是拿一次"顺手扩范围"去治"顺手扩范围"。若将来要单独开一个"shell 写法"技能，那是**新增文件**，属另一轮授权 |
| `lib/transport/index.js` 的派活单 | 派活单的正文已经含 `ROLES[role].summary`；而 system prompt 段 + 席位简报**已经把这条指引带到每个会话与每个席位**。再加一遍是**每条派活单都多付一次 token** 的冗余 |
| `lib/roles.js` / `lib/boundaries.js` / `lib/tiers.js` | 它们是**数据/只读导出**，**不进上下文**。改它们不改变任何模型看到的东西（见第一节的结论） |
| `README.md` | 它是给人看的文档，不是提示词。本轮"只改文案与指引"，不顺手扩到文档体系 |
| `lib/guard-factory.js` | ★★ **有会话正在改它** —— 绝对不碰（见第四节） |

### 改前备份（落插件目录内、**不在加载路径**）

```
%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-pipeline\_backup-f-script-path-20261014-195601\
  ├─ index.js
  ├─ lib\intercept.js
  └─ STAMP.txt
```
（目录名以 `_` 开头、不在 `main`/`exports`/任何扫描路径里；自测 `liveness-check` 只扫 `lib/**`，故备份不落 `lib/`。）

| 文件 | 改前 sha256 | 改后 sha256 |
|---|---|---|
| `index.js` | `9AEBDCA58949D1F8032A783193F3FD3AB3030F3EE341E2E2C25896F65E6B9FD0` | `4F1DF00F2579FAB29A665140E5CB924AA0A3CA5FF45962004AA995C33475E7E4` |
| `lib/intercept.js` | `5CF0F4C7B9F2B187252BD2C90F4DC74ACDBDBB18F2D671F8BAD220B85A5C0D07` | `AB77B12D1FB4C1DDB8C6031A595D047014DE43D7B3267A1F6A93D6A95B7379C8` |

**回滚方式**：把备份目录里那两个文件按原位拷回即可（无其它改动、无依赖变更、无配置变更）。

---

## 三、为什么这么写（"整轮作废"的证据）

### 3.1 参考实现的原话（我们抄的是它的**措辞意图**，不是代码）

`_ref-dsh-ops\lib\shells.js:934-938`（工具描述）：

> "…For scripts longer than about 1 KB or containing heredocs, **quotes, backslashes or non-ASCII text**,
> **write the script to a file first and pass `script_path`** instead of embedding it in `command`.
> Use `command` for short commands and pipelines."

`_ref-dsh-ops\lib\policy.js:62`（提示词段）：

> "- Use `command` only for short commands and pipelines. For scripts longer than about 1 KB or containing
> heredocs, quotes, backslashes or non-ASCII text, **write the script to a file first and pass `script_path`**."

可参考清单 §1.6 对它的判定原话：

> **"这是它最有价值的一条，也最贴我们的痛点"**……作者明说目的是"减少模型在工具调用 JSON 中进行多层转义的负担，
> **降低整轮因 `MALFORMED_RESPONSE` 作废的概率**"。**一次 `MALFORMED_RESPONSE` 作废的是整轮（含此前所有上下文），是最贵的失败**。

### 3.2 我们**自己的代码里**就有这个事故的现场记录（不是外来的说法）

- `lib/intercept.js:343-346`：
  > **A9 / A10 / A11：崩了 ≠ 闲着，而且崩了也必须叫**
  > 现场：席位因模型输出层故障中止（`[MALFORMED_RESPONSE]`），机制 5 分钟后的判词却是「静默阈值 5 分」
  > 并**把任务冻掉** —— **同一张单因此被冻 4 次**，其中一次直接挡掉了一份**已提交**的交付。
- `lib/runfail.js:5`（判据认的就是这行原文）：
  > `🔴 本轮运行失败  DeepSeek Messages stream: tool input is invalid JSON  [MALFORMED_RESPONSE]`
- `lib/runfail.js:54-78`：`RUN_FAILURE_MARKERS` / `matchRunFailureLine()` —— 已经有专门的模块在**兜**这种失败。

**⇒ 也就是说：这条指引治的病，在我们仓库里已经是"有案底"的病**，不是理论风险。

### 3.3 为什么这件事"最贵"（写这条指引的取舍依据）

| 形态 | 代价 |
|---|---|
| 一次普通的工具报错（例如判据拒了一次写） | 1 次往返（几 K token） |
| **一次 `MALFORMED_RESPONSE`** | **整轮作废** —— 该轮之前积累的全部上下文一起重付（含已有的工具输出、文件正文、报告） |
| 我们这轮的**三处成本叠加** | ① 整轮作废；② 席位被判"失联"或按静默阈值**冻任务**；③ 重派席位要把上下文**再喂一遍** |

而我们这条指引的**成本**只有：多一次 `write`（几百 token，且那一次 write 走的是**文件工具**、有硬判据兜着，比 shell 命令串可靠得多）。

### 3.4 为什么措辞里要写"**它是写法，不是后门**"

因为在我们这**恰好**有一条相反方向的既有事实，必须同时说清、否则这段文案会变成教人绕判据：

- `lib/guard.js:49-52`（文件头自述）：
  > shell 旁路的**写**：只能靠命令串的字符串匹配，混淆写法（变量拼接、**编码后解码、写一个脚本再跑**）可以绕过。所以 shell 侧是 best-effort。
- `lib/boundaries.js:264-270`（**C6**，判据化不了的诚实清单）：
  > 「不得用 shell 的刻意混淆绕过判据（**变量拼接 / 编码后执行 / 先写脚本再跑**）」
  > —— 判据化不了：shell 侧本来就是字符串匹配的 best-effort。…要真封死只能靠环境侧。

**取舍**：这条指引的收益（少整轮作废）是**确定性**的，而它的副作用（"先写脚本再跑"同时也是绕过 shell 判据的手法之一）是**真实存在**的 —— 所以文案里两半都写：
① 落盘再执行 ✓；② **脚本与命令受同一套判据管，落在授权面之外照样被拒**（新增文件也要在授权面里）。
**这不是免责声明，是把口径钉死**：别让"少炸一次"变成"多一条绕过通道"。

### 3.5 为什么**不**照抄 `script_path` 这个参数名

我们**没有** `script_path` 这个参数 —— 宿主 `pwsh` / `bash` 只有 `command`（`lib/guard.js:409-421` 收集的就是 `command/cmd/script/input/code/shell_command`）。
所以"契约"落地成**行为等价物**：**把脚本落到盘上，再用 `pwsh -File x.ps1` / `bash x.sh` 执行那个文件**。
（清单 §1.6 也把我们的落地写成"写进我们的角色卡/技能：给 writer/tester 的 shell 指引加这条"，而不是"加一个 `script_path` 参数"。）

### 3.6 为什么文案里写"**你有权写的位置**"而不是"写到临时目录"

因为管线席位**并不是哪里都能写**（这是硬判据，不是提醒）：
- `writer` ⇒ `writes: 'workdir'`，但**受 `scope_paths` + `change_scope` 双重约束**；`R3` 明文「**新增文件也算越界**」（`lib/boundaries.js:100-107`，`index.js:941-943`）。
- `tester` ⇒ `writes: 'own-dir'`，只有 `<任务>/reports/tester/tester[-后缀].<log|jsonl|md|json|txt>` —— **`.ps1` 不在允许的扩展名里**。
- `reviewer` ⇒ `writes: 'own-log'`，只有 `.log|.jsonl`。

**⇒ 所以文案不能写成"随便写个脚本跑"**。写成"落到**你有权写的位置**"，配合同一句里的"落在授权面之外照样被拒"，才是**与判据一致**的说法。
（★ 这也正是第四节 C3 补丁要处理的那条缝：**当席位确实没有可写位置时，它能做的只有"把长命令拆短"** —— 这一点在报告里如实标出，不假装它被解决了。）

---

## 四、★ C3 守门盲区的补丁建议（改哪、加什么、为什么）—— **不实施**

> ★★ **本节全部是建议文本，零实施。**
> `lib/guard-factory.js` **有会话正在改它** —— 本轮**一个字节都没碰**；`lib/guard.js` 同样**未改**。
> 本节只为把"改哪里、加什么判据、为什么"写清楚，交给主对话在 **D 路收工后**接。

### 4.1 盲区是什么（可核查的事实，不是推测）

| 事实 | 位置 |
|---|---|
| 守门收到的"命令串"= 六个键的字面值 + 对象 3 层内的字符串 | `lib/guard.js:412-436` `collectCommandStrings()`（键表在 `:421`） |
| 唯一调用点：逐条喂给 `scanShellCommand` | `lib/guard.js:1097-1099` |
| 三条主要 shell 判据**全是内容正则** | `SHELL_WRITE_RE`(`:273`)、`SHELL_READ_RE`(`:275`)、`SHELL_CONTENT_SEARCH_RE`(`:277`)、`SHELL_REDIRECT_RE`(`:279`) |
| "直接跑测试目录下的脚本"也是内容正则 | `lib/guard.js:392-393` |
| **写脚本再跑** 被自认为绕不过的盲区 | `lib/guard.js:49-52` + `lib/boundaries.js:264-270`（**C6**）；参考清单把它叫 **C3**（§4.8） |

**⇒ 今天 `pwsh -File x.ps1` 收上来的是"**一个文件名**"，`x.ps1` 里写的是什么，守门**一个字都看不到**。**

### 4.2 为什么本轮**必须**成对处理（不能只做文案）

可参考清单 §2 结论一第 1 名写得直接：

> ⚠️ 唯一代价：它会打开我们守门的 C3 盲区（4.8），**必须成对处理**。

§4.8 的原话更重：

> **它恰恰在教模型把长命令放进 `script_path`** ⇒ 装它会把命令正文**系统性地移出**我们守门的视野。

**⇒ 本轮这条文案（第二节那两处）单独上线，等于把"命令正文离开判据面"从"偶发手法"升级成"官方推荐手法"。这就是为什么它必须和下面的补丁一起看。**

### 4.3 建议改哪（3 个点，全部在 `lib/guard.js`；`guard-factory.js` 可以不动）

| # | 位置 | 改什么 |
|---|---|---|
| **P1** | `lib/guard.js:412-436`（`collectCommandStrings` 之后**新增**一个纯函数） | 新增 `expandScriptInvocations(commands, projectRoot)`：**不改** `collectCommandStrings` 的既有行为（它的返回值与顺序被既有自检依赖），**另起**一个"把脚本正文展开成追加命令串"的函数 |
| **P2** | `lib/guard.js:1097-1099`（唯一调用点） | 在 `const commands = collectCommandStrings(args)` 之后插一行：`const extra = expandScriptInvocations(commands, task.projectRoot)`，然后**把 `extra` 与 `commands` 一起**逐条喂给**同一个** `scanShellCommand`（**不许**抄第二套判据 —— 抄一遍就是两套口径） |
| **P3** | `lib/guard.js:392-393` 附近（测试目录脚本正则组） | 保持**不动**。它已经是"内容正则"，只要 P1/P2 把正文喂进来，它**自动**就生效 —— 这正是选"展开成命令串"而不是"新写一条判据"的理由 |

### 4.4 建议加什么（判据形状，可直接照写）

**① 识别"这条命令就是在调用一个本地脚本文件"**（窄，宁可漏判也不误伤）：

```
// PowerShell 调用运算符 / 显式解释器 + 脚本文件
/&?\s*(?:pwsh|powershell|bash|sh|node|deno|bun|python[0-9.]*)\s+(?:-\S+\s+)*["']?([^\s;&|"']+\.(?:ps1|psm1|sh|bash|cmd|bat|mjs|cjs|js|py))["']?/i
```

**② 展开正文并复用同一套判据**：

```
for (const p of hitPaths) {
  const abs = isAbsolute(p) ? p : join(projectRoot, p)
  if (!existsSync(abs) || !statSync(abs).isFile()) continue      // 弃权（今天的行为）
  if (statSync(abs).size > SCRIPT_SCAN_MAX) { blocked.push({ p, why: 'too-big' }); continue }
  out.push(readFileSync(abs, 'utf8'))                            // ★ 正文当成追加命令串
}
```
- `SCRIPT_SCAN_MAX` 建议与既有 `MAX_SCANNED` 同量级（`collectCommandStrings` 已经用它给单条命令封顶，见 `:416`）。
- **深度 1**：脚本里再调脚本不再展开（并**如实写出"没有展开"**，别让它看起来像已经覆盖了）。
- 编码：`utf8` 读失败 ⇒ 走下面 ③。

**③ 读不到时的姿态（建议，供拍板）——分两类，别一刀切**：

| 情形 | 建议 | 理由 |
|---|---|---|
| 路径解析不出 / 文件不存在 | **弃权**（= 今天的放行），但**记一条观察**（`hashgate` 台账已有先例） | 大部分 `x.ps1` 根本不在项目里（系统脚本、随包工具）；一律拒会必然误拦正常工序 |
| 文件存在但**读失败 / 超限 / 编码坏** | 对**两条最贵的判据**（`writer` 的"跑测试"、控制角色的"读代码"）**fail-closed 拒**；其余弃权 | 这两条正是它要守的东西，且"写个脚本绕过去"是**已知**手法（C6）；其余判据误拦的代价 > 收益 |
| 命中 `too-big` | 拒，并在理由里**点名**"脚本 N KB 超出扫描上限" | 超限本身就是可疑形态；静默跳过等于给了一条"把命令写长就看不见"的路 |

**④ 理由文案要与判据同源**（本仓库的既有纪律）：拒绝原文里要点出 **命中的是脚本文件里的哪一行/哪条正则**，而不是只说"你越权了"（照抄 `lib/guard.js:1251-1255` 那种"给原因 + 给出口 + 标明这是 best-effort"的形状）。

### 4.5 为什么这么改（四条理由，按重要性）

1. **不抄第二套判据**。把脚本正文**喂回同一个 `scanShellCommand`**，于是 `SHELL_WRITE_RE` / `SHELL_CONTENT_SEARCH_RE` / 测试目录正则 / 授权面与分区判据 **全部自动生效**，没有"两套口径漂移"的可能 —— 这是本仓库最反复强调的一条纪律（见 `lib/boundaries.js:13-15`「派生，不手抄」）。
2. **同步可行性已具备**。`ctx.tools.guard` 是**同步**调用的（`lib/guard-factory.js:9-11`），而 `readFileSync` / `existsSync` / `statSync` 都是同步的；`lib/guard.js` **本身已经在用**它们（`:1236-1238`），不是新引入的依赖形态。
3. **不动 `guard-factory.js`**。本补丁全部落在 `lib/guard.js` 的**纯函数**里 —— 与"有会话正在改 `guard-factory.js`"**不冲突**，两边的改动面不重叠。
4. **它把 C6 从"判据化不了"往"判据化得了"挪一格**。C6 目前列在诚实清单里（`:264-270`）。补上 P1/P2 之后，"先写脚本再跑"这条路径**至少对项目内的脚本文件**看得见了 —— 那时 `ADVISORY_LIMITS` 里 C6 的措辞应当同步收窄（**只保留"变量拼接 / 编码后执行"这类真绕不过的**），别让清单与代码漂移。

### 4.6 建议补的**自检**（漂移检查，成本低、回报高）

- `tests/` 加一条断言：**守门的 shell 工具名单**（`DEFAULT_SHELL_TOOLS` + `DEFAULT_SHELL_TOOL_PATTERN`，`lib/guard.js:74,77`）与**本机实际发布的 shell 工具名**一致 —— 这是参考清单 §4 冲突处置第 3 条建议的那种"漂移检查"，本仓库已有同族先例（`tests/review-check.mjs` 做"角色 writes ↔ 守门逐字节对齐"）。
- 再加一条**正例/反例对**：`pwsh -File x.ps1`（x.ps1 里写 `Set-Content` 到源码树）**必须被拒**；`pwsh -File y.ps1`（y.ps1 里只有 `Get-Date`）**必须放行**。反例与正例成对，才不会"为了绿而放宽"。

### 4.7 ★ 本轮**没做**的事（如实登记）

- **没有**改 `lib/guard.js`、**没有**改 `lib/guard-factory.js`、**没有**加 P1/P2/P3 的任何一行代码、**没有**加测试。
- **没有**验证 P1/P2 的可行性（我**没有**跑过原型）—— 上面的"建议"是**读代码得出的**（`collectCommandStrings` 的键表、`scanShellCommand` 的调用点、`readFileSync` 的既有用法），**不是实测结论**。真要落地请先写正例/反例对再改。
- **没有**处理 3.6 里那条"席位可能**没有**可写位置"的现实：那种情形下席位只能"把长命令拆短"，本轮的文案**没有**给出更好的出路。要真解决得给它一个**授权内的 scratch 位置**（那是新能力，属另一轮授权，不是文案能办的）。

---

## 五、测试改前 / 改后

**跑法**（两次都是同一条命令，同一个 node）：

```powershell
cd %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-pipeline
node tests/run-all.mjs --quiet          # 汇总写进 tests/last-run.txt
```

### 5.1 总账

| | 总计 | 红 |
|---|---|---|
| **改前（基线）** | **1522 / 1524** | `roster-authority-check` 70/72（**既有红**，E 上限次序 A3 两条） |
| **改后** | **1522 / 1524** | **同样是那两条**（逐字相同，行号与文案都没变） |

**⇒ 一条都没弄红，也没有任何"意外转绿"。**

### 5.2 逐套逐项对比（31 套，**逐项相同**）

改前与改后 `tests/last-run.txt` 里"`总计：N/M 通过`"的行，**顺序与数值逐项相同**：

```
70/70 · 24/24 · 70/70 · 38/38 · 23/23 · 44/44 · 46/46 · 39/39 · 39/39 · 36/36 ·
56/56 · 29/29 · 56/56 · 51/51 · 43/43 · 41/41 · 51/51 · 25/25 · 44/44 · 74/74 ·
55/55 · 18/18 · 38/38 · 70/72 · 61/61 · 55/55 · 48/48 · 49/49 · 38/38 · 14/14 · 27/27
```

唯一两行 `✗`（改前改后各一次，同一位置）：

```
✗ E 上限次序｜★ A3：已开 9 / 上限 10 ⇒ 第 10 个放行
✗ E 上限次序｜★ A3：已开 10（第 11 个）⇒ 拒，理由里写明"上限由名单说了算"
```

### 5.3 ★ 与本次改动**直接相关**的那几套（点名核对）

| 套 | 结果 | 它守的是什么（为什么与本轮相关） |
|---|---|---|
| `intercept-check` | **25/25** ✓ | ★ 它直接 import `seatBriefing` 并断言 `只做：`/`不做：`/`用户让你做了吗`；同时比 `skills/stop-ladder/SKILL.md` 的四问与代码注入**一致**（`:444-482`）。**本轮改了 `seatBriefing`，它全绿** |
| `liveness-check` | **25/25** ✓ | ★ 它**静态扫 `lib/**` 全部 `.js`**（`:216-247`）断言"除 `hostmsg.js` 外不存在裸 `role:'user'` 字面量"。**本轮改了 `lib/intercept.js`，它全绿** |
| `load-smoke` | **24/24** ✓ | ★ 它断言 system prompt **只有 1 段**、名 `pipeline:roles`、order 是有限数。**本轮改了 `PIPELINE_PROMPT`，它全绿** |
| `boundary-check` | **43/43** ✓ | 六条设计目的 ↔ 判据的对应（`lib/boundaries.js` 未改，做回归确认） |
| `schema-check` | **43/43** ✓ | 工具定义与 schema（本轮未动工具，做回归确认） |
| `orphan-rescue-check` | **61/61** ✓ | 任务点名不许弄回去的那几套之一 |
| `wake-channel-check` | **61/61** ✓ | 同上（★ 实测本机是 61/61，与任务里记的 60/60 差 1 —— **改前就是这个数**，不是本轮造成的） |
| `station-reject-check` | **49/49** ✓ | 同上 |
| `p01-handoff-entry-check` | **38/38** ✓ | 同上 |

### 5.4 我另外自查的两条（不在自测集里，但**必须**查）

因为 `judgePrompt()`（`lib/intercept.js:190-219`）会对**编写席位**扫"提示词里有没有测试命令"，而席位简报正文**会进编写席位的上下文** —— 新增文案若含测试类命令样例，等于**自己把自己判红**。实测（`node --input-type=module`）：

| 查什么 | 结果 |
|---|---|
| `scanTestRunnerCommand(seatBriefing(writer, …))` | **`null`** ✓（新增简报文本**不含**任何测试命令形态） |
| `judgePrompt(writer, seatBriefing(writer, …))` | **`null`** ✓（不会被自己拒绝） |
| `node --check index.js` / `node --check lib/intercept.js` | 都过 ✓ |
| `scanTestRunnerCommand(PIPELINE_PROMPT)` | ⚠️ **非 null**（命中 `pytest`）—— **但这是改前就有的**：原文 `index.js:937` 自己就写着"npm test / pytest / node --test / node tests/xxx"。它不进那条判据，因为 `collectPromptText`（`lib/intercept.js:724-734`）只拼 `payload.messages`、**不含 system prompt 段**；且改前改后 31 套逐项相同，佐证它与本轮改动无关 |

### 5.5 纪律自查

- 未删任何既有测试 ✓　未放宽任何断言 ✓　未改任何期望值 ✓　未新增测试 ✓
- 未加依赖 ✓　未装 ✓　未重启 DSH ✓　未改 `lib/guard-factory.js` ✓　未碰 `lib/guard.js` ✓
- 未顺手重构 ✓（改动是"两处新增字符串行 + 一处新增注释"，没有移动/重命名/格式化任何既有代码）

---

## 六、未做活体验证（需重启复验）

**本轮是纯静态改动 + 跑既有自测。以下都**没有**做过（如实列，别当成已验）：**

1. **没重启 DSH**、没重载插件、没新开会话 —— 所以**没有任何一条模型侧的证据**证明模型真的会照着新文案去"落盘再执行"。
2. `PIPELINE_PROMPT` 的生效时机**未验证**：它是在 `apply()` 里以 `text: () => PIPELINE_PROMPT`（惰性函数）注册的（`index.js:800-810`），按说是**每次装配 prompt 时取最新值** ⇒ 已运行会话"**可能**"下一轮就看到；**但我没验**。
3. ★ `seatBriefing` 的注入**有去重**（`lib/intercept.js:498-516`，键 `taskId|role|seat`，`injected` 是内存 Set）：**已经在跑的席位不会再收到这份简报**。⇒ 要看到新文案，**必须新派一个席位**，或重启 DSH 后重派。
4. **没验**"整轮作废"的收益：本轮**没有任何 token 度量**（也**不引用** dsh-ops 的 97%/65% —— 见可参考清单 §5：那组数字无方法、无数据，它自己的文档 5 处否认）。
5. **没验**第四节补丁的可行性（没写原型、没跑正例/反例对）—— 那是一份**读代码得出的建议**。

### 重启后的复验清单（建议逐条勾）

| # | 怎么验 | 期望 |
|---|---|---|
| V1 | 重启 DSH → 新开一个会话，让它复述"跑 shell 时要注意什么" | 能说出"多行/带引号/带中文 ⇒ 先落盘成脚本文件再执行"，并能说出理由是**整轮作废** |
| V2 | 在一个带管线角色的会话里，看 system prompt 段（`pipeline:roles`）是否含「跑 shell 的写法（省的是最贵的一种失败）」 | 含，且**只有一处**（`load-smoke` 的"只 1 段"断言仍绿） |
| V3 | **新派**一个席位（旧席位看不到），看它开场简报的最后 4 行 | 出现「★ 要跑 shell 时：…」那 4 行 |
| V4 | 端到端：让一个席位跑一条**多行 + 带中文 + 带引号**的命令 | 它**先落盘再执行**，而不是把多行原样塞进 `command`；且该轮**没有** `MALFORMED_RESPONSE` |
| V5 | 反例：让一个席位写一个**在授权面之外**的脚本再跑 | **被拒**（证明"不是后门"那半句是真的） |
| V6 | D 路收工后接第四节补丁：跑 `pwsh -File x.ps1`（x.ps1 里 `Set-Content` 到源码树） | **被拒**（改前是放行 —— 那就是 C3） |

### ★ 2026-10-14 20:53 补记（主对话只读实测）

- ★ **"DSH 有没有重启"这个存疑项现已结案**：进程 **PID 6556 起于 20:21:30**，晚于各路修复落盘（19:30–20:08）⇒ §六 那句"**没重启 DSH**"与 §5.5 那句"**未重启 DSH ✓**"是**当时**的事实（**保留**），现在已不成立。
- **本轮拿到的证据**：**边界通知里逐字出现了那几行** —— 「多行 / 带引号 / 带中文 / 带反斜杠的命令，先落盘成脚本文件再执行那个文件（`pwsh -File x.ps1` / `bash x.sh`）…… ★ 它是写法不是后门」⇒ **文案确已随重启后的进程生效**。
- ★ **V2 只算【部分已验（主对话实测）】**：它的"**文案确在生效面上**"这半已验；"**只有一处**"那半要 `load-smoke` 的断言，**本轮没有复跑**。
- ★ **V1 / V3 / V4 / V5 / V6 全部保持【待验】** —— 它们要的是**模型侧行为**（新会话能复述 / **新派**席位看开场简报末 4 行 / 席位真去"落盘再执行" / 反例被拒），**本次只读观测不构成这些证据**。

---

## 附：本轮交付的**简报**（≤200 字）

> 提示词在三处：system prompt 段（`index.js` 的 `PIPELINE_PROMPT`）、席位开场简报（`lib/intercept.js` 的 `seatBriefing`）、派活单（`lib/transport/index.js`）；`lib/roles.js`/`boundaries.js`/`tiers.js` 只是数据源、不进上下文。本轮改了前两处：新增"多行/带引号/带中文的 shell 命令先落盘成脚本文件再执行"的指引，理由写明多层转义 ⇒ `MALFORMED_RESPONSE` ⇒ **整轮作废**，并注明"是写法不是后门"。自测改前改后同为 1522/1524，红的两条与基线逐字相同，**没有测试因它变红**。★ C3 补丁建议一句话：在 `lib/guard.js` 的 `collectCommandStrings` 旁新增"把 `pwsh -File x.ps1` 的**脚本正文读出来、喂回同一个 `scanShellCommand`**"的展开函数（唯一调用点在 `:1097-1099`），不动 `guard-factory.js` —— **未实施**。

---

### 一句话总结

**这轮只做了一件小事：把"别把多层转义的命令塞进 shell 参数，先落盘再执行"写进两个真正进上下文的地方（system prompt 段 + 席位开场简报），并同时写明"这不是后门"。**
**原因是这条治的病在我们仓库里已经有案底（`lib/intercept.js:345-346`：同一张单被 `MALFORMED_RESPONSE` 冻过 4 次）。**
**守门那一半（C3）一个字都没动 —— 第四节是替 D 路写好的补丁说明，不是补丁。**
