# 02 · DSH 原生设施（查证结果）

> **第一步的交付**：DSH 到底白送了我们什么。每条都给 `文件:行`；查不到的如实写「**未证实**」。
> 格式约定：`/dsh/node_modules/...` = asar 包内路径（`D:\tool\Deepseek\Deepseek harness\resources\app.asar`）；
> 其余路径相对本仓库 `plugin/active/`。
>
> ★ 本文件的结论直接决定 `03-模块拆分.md` 里"复用还是自建"。

---

## 0. 一句话总览

| 我们要的能力 | DSH 原生有没有 | 结论 |
|---|---|---|
| 会话/工具钩子 | **有**，就是 cordis 事件总线（78 个事件） | **直接复用** |
| skill 注册表 | **有**（`ctx.skills`，可运行时注册） | **直接复用** |
| 插件持久化位置 | **有**（`DSH_HOME` + `ctx.storageDomain`） | 复用 `DSH_HOME`；**不用** storageDomain（见 §3.3） |
| 会话元数据可读 | **有**（投影服务 + 投影缓存，零日志读） | **直接复用** ← 活文档挂这里 |
| token 上限的度量 | **有**（`ctx.tokenMeter`） | **直接复用** |
| 项目目录当记忆库根 | **有**（`projectLayout().pipelineDir`） | **直接复用** |

**没有一样的**：语义检索（无 embedding 设施，且用户点名不抄）。

---

## 1. 钩子面

### 1.1 结论：**没有单独的"钩子 API"，宿主扩展面就是 cordis 事件总线**

`dsh-hook-protocol` / `dsh-hooks-claude-code` / `dsh-hooks-codex` **不是**钩子机制本身 ——
它们是**桥接插件**：订阅同一批事件，去跑外部的 `hooks.json` shell 命令。
**普通 cordis 插件订阅的是同一批扩展点，不需要桥。**

- 注册：`ctx.on(name, listener, options?)` → `cordis/src/events.ts:288-302`；
  `options: {prepend?: boolean, global?: boolean}` → `events.ts:112-117`。
- 注册是**调用方 fiber 拥有的 effect**，插件卸载即自动摘除 → `events.ts:254-260`。
- 五种派发模式（`events.ts:32`：`emit | parallel | serial | bail | waterfall`）：
  - `waterfall`（`events.ts:234-243`）：监听器围绕最后的 `next` 组合，最外层优先；
    **不调 `next()` 就否决**后续与内建行为；最外层返回值即判定。
  - `serial`（`:204-209`）：按序 await，直到有人返回 bail 值。
  - `emit`（`:194-196`）：同步，忽略返回值，**rejection 记日志而不抛**。
- 事件总表：**78 个**，`EVENT_API` → `dsh-tool-cordis/lib/types/api-catalog.js:3690-4339`
  （每条含 `name`/`mode`/`signature`/`parameters`）。

### 1.2 与本设计相关的事件（含触发点）

| 事件 | 模式 | 触发点 `文件:行` | 语义 |
|---|---|---|---|
| `agent/created` | serial | `dsh-agent/lib/index.js:579` | 会话建立（`SessionStart`）；抛异常会**让创建失败** |
| **`agent/pre-step`** | waterfall | `dsh-agent-loop/lib/index.js:911` | 每步开步前（`UserPromptSubmit`）——**注入上下文的唯一正门** |
| **`tools/pre-execute`** | waterfall | `dsh-tools/lib/index.js:3225` | 工具派发前（`PreToolUse`） |
| **`tools/post-execute`** | waterfall | `dsh-tools/lib/index.js:3504` | 工具结果回来、交付模型前（`PostToolUse`） |
| `agent/turn-stopping` | serial | `dsh-agent-loop/lib/index.js:999` | 轮次将停（`Stop`） |
| `subagent/start` / `subagent/end` | emit | `dsh-subagent/lib/index.js:279,306` / `:268,274,319` | 子代理起停（**只读观测**） |
| `session/event` | emit | 见 `dsh-agent-instructions/lib/index.js:1264` | 每条已提交会话事件 |
| `tools/result` | emit | 见 `dsh-agent-instructions/lib/index.js:1290` | 最终结果（观测） |

### 1.3 契约（照抄会给模型看，别自己发明形状）

- **`agent/pre-step`**：入 `{agent, messages, turn, step, signal}`，
  `next: () => Promise<PreStepDecision>`；出 `{kind:'reject'} | {kind:'enter', messages}`。
  ★ 要"保留现有消息并追加"就是 `return {...decision, messages:[...decision.messages, extra]}`。
- **`tools/pre-execute`**：入 `(exec, next)`；出 `{kind:'allow'|'deny'|'cancel'|'ask'}`。
  ★ **不能改 `exec.arguments`**（`dsh-tools/README.zh.md:230`）。
- **`tools/post-execute`**：入 `(exec, result, next)`；
  出 `{kind:'accept', content?|value?, additionalContexts?} | {kind:'block', feedback, additionalContexts?}`。
  ★ `accept` 不能同时给 `value` 与 `content`；**失败结果的 value 不可替换**（`dsh-tools/lib/index.js:3515-3518`）。
- **`agent/turn-stopping`**：**不能直接 block**；要 `agent.steer(createUserMessage(...))` 让状态机重读收件箱
  （`api-catalog.js:3800`）。
- **顺序/超时**：监听器**无超时机制**（grep 不到 → **未证实**存在）；桥接的**命令**超时是 600 s
  （`dsh-hook-protocol/lib/index.js:175`）。作用域上**未打标签的监听器会被纳入每一次带作用域的派发**
  （`dsh-scope/lib/index.js:327-338`）—— 对本插件是好事（能看见所有 agent）。

### 1.4 ★ 本插件**已经在用**这套面（所以它不是"新引入的依赖"）

- 缝的清单一处定义：`lib/intercept/registry.js:42` `INTERCEPT_EVENTS = ['tools/pre-execute','agent/pre-step','tools/post-execute']`。
- 真挂真摘：`lib/intercept/registry.js:201` `const dispose = ctx.on(hook.event, handler)`。
- 缝的登记表：`lib/intercept/registry.js:54-59`（`HOOKS`，顺序 = 挂载顺序）。
- 实测的返回值形状：`lib/guard/hook-prompt.js:64`（`{kind:'reject', reason}`）、
  `:117-120`（`{...downstream, messages:[...]}`）；`lib/guard/hook-post.js:59-71`（`{kind:'block', feedback}`）。

★ **注入形状是硬契约**（`lib/guard/hook-prompt.js:5-15` 记着一次真实事故）：
塞进 `messages` 的**消息**必须 `content` 是 block 数组、`source` 是带 `kind` 的对象，
否则**整个 turn** 会以 `Cannot read properties of undefined (reading 'kind')` 收尾。
⇒ 记忆域的注入**必须走 `lib/hostmsg.js` 的 `hostMessage()`**，且在 `HOST_INJECTION_SITES`
（`lib/hostmsg.js:247`）里**先加一行**。

---

## 2. skill 注册表

### 2.1 有。服务是 `ctx.skills`

- 定义：`dsh-skill/lib/index.js:132` → `super(ctx, "skills")`。
- 插件用 `inject` 声明依赖：`dsh-skill-filesystem/lib/index.js:30` `const inject = ["skills"]`。
- API：`register(skill): () => void`（`api-catalog.js:2565`）、`get/list/snapshot`、`registerProvider`。
- 唯一变更事件：`skills/change` → `dsh-skill/lib/index.js:404`。

### 2.2 ★ 运行时注册（我们要用的那条）

`ctx.skills.register(skill)` → disposer，**`dsh-skill/lib/index.js:193-215`**：

```js
register(skill) {
  validateRuntimeSkill(skill);
  ...
  return this.layers.effect(this.ctx, (layer) => {
    layer.runtime.set(definition.name, definition);
    return () => { layer.runtime.delete(definition.name); };
  }, { label: "skills.register()" });
}
```

- `RUNTIME_PROVIDER = "runtime"` (`:20`)、`RUNTIME_RANK = 250` (`:21`)
  ⇒ 运行时条目**压过 user 根（400），输给 project 根（100/200）**，同层内比 rank。
- 校验只查三样：kebab-case `name`、非空 `description`、`invocation` 形状（`:465-469`）。
- **纯代码注册的完整范例**：`dsh-skill-badge/lib/index.js:16-43`（≈50 行，零文件系统）。

★ **这条让"用户裁定库"不必写 `~/.dsh/skills/`** —— 不落盘、不越工作区、插件卸载即消失。

### 2.3 磁盘形态（若要落盘才用得上）

- 目录包 `<root>/<name>/SKILL.md`，或平铺 `<root>/<name>.md` → `dsh-skill-filesystem/lib/index.js:586-592`。
- frontmatter **必须第 0 字节起就是 `---`**（`:783`）；必填 `name`(kebab) + `description`（`:679-685`）。
- 发现根与优先级（`:21-25` + `:150-188`）：`project-dsh` 100 `<projectRoot>/.dsh/skills` ／
  `project-agents` 200 ／ `custom` 300 ／ `user-dsh` 400 `<dshHome>/skills` ／ `user-agents` 500 ／ `bundled` 600。

### 2.4 怎么进模型（**两条路都原生**）

1. **目录常驻**：`dsh-tool-skill/lib/index.js:203-236` 订阅 `agent/pre-step`，
   注入 `<available_skills>`（`:246/:248`），每行 **只有 `name` + `description`**（`:293-295`），
   description 空白归一化并截到 500 字符（`:40`）。
   ⚠️ **`whenToUse` 不进目录**（`dsh-tool-skill/README.md:243`）—— 触发条件要写进 `description`。
2. **按需取全文**：`skill` 工具，参数只有 `name`（`:62-66`），返回包在 `<skill_content>` 里（`dsh-skill/lib/index.js:57-70`）。

### 2.5 本插件的既有实践（复用，不新造）

- 插件自带 `skills/stop-ladder/SKILL.md`；`install.ps1:74-77` 与 `:292-296` 把它落到 `<dsh-home>/skills/`。
- 用户原话（写在 `install.ps1:295`）：「**Skill 由插件带，不许手工另建**」。

---

## 3. 存储面

### 3.1 家目录

- `@deepseek-ai/dsh-home-paths` 是**库**，不是插件（`README.zh.md:12`：「作为库依赖直接使用，不要通过 `cordis.yml` 加载」）。
- 解析优先级：**显式配置 > `$DSH_HOME` > `~/.dsh`**
  → `dsh-home-paths/lib/index.js:73-76` `resolveDshHome`；`dshHomePath(...)` 在 `:82-84`。
- 只有 `cache/` 是包内预定义的（`dshCachePath` `:91-93`）；其余子目录是各插件自己拼的：
  `<home>/sessions`（`dsh-base/cordis.patch.yml:130-133`）、`<home>/storages`（`:168-171`）。
- **本插件已经在读这些**：`lib/liveness.js:156-169` 的 `sessionsRootCandidates`
  依次试 `DSH_SESSIONS_DIR` → `$DSH_HOME/sessions` → `dirname(dirname($DSH_PROFILE_DIR))/sessions` → `~/.dsh/sessions`。

### 3.2 会话文件

- 路径：`<home>/sessions/<projectKey(cwd)>/<sessionId>/session.v4.jsonl.zstd`
  → `dsh-session-persistence-jsonl/lib/index.js:880-894`（`projectKey`）、`:902-905`（`projectDir`）、`:914-916`（`sessionDir`）。
- 本插件自己的常量：`lib/liveness.js:90` `SESSION_LOG_NAME = 'session.v4.jsonl.zstd'`；
  注释里也画出了同一个路径形状（`lib/liveness.js:826`）。
- **头记录**（第一帧）实测（本机真实会话）：
  ```json
  {"type":"session","version":4,"id":"ad5d7cd5-…","createdAt":1792078441814,
   "cwd":"<仓库根>",
   "parentSession":"session-28048def-…","isSeeded":false,
   "origin":"subagent","delegationDepth":1,"agentPreset":"standard"}
  ```
  字段校验：`dsh-session/lib/types/index.js:26-69`；`agentPreset` 在 `:65-67`，`origin` 只许 `"subagent"`（`:58`）。
  ★ 头里**没有 `title`**（title 是投影，见 §4.2）。

### 3.3 ⚠️ 一个必须写下来的坑：会话日志是**多帧 zstd**

实测（本机 `…/ad5d7cd5-…/session.v4.jsonl.zstd`，157,054 字节）：
- 文件里出现 **66 个** zstd 帧魔数 `28 B5 2F FD`；
- `zlib.zstdDecompressSync(buf)` **只解出第一帧** = 298 字节 = **只有那条头记录**；
- 流式 `zlib.createZstdDecompress()` 同样只出第一帧。

⇒ **要读全文必须逐帧解码**。这条决定了设计：**不要去解析会话日志正文**
（那是 rediscovery 一个已经有人做过的活）。

### 3.4 通用持久化服务：有，但**本设计不用**

- `ctx.storageDomain.open(defineDomain({name,version,tables}))`
  → `dsh-storage-domain/lib/index.js:355`；`table(name)` `:187-191`；`get` 同步（`:241`）、`put` 持久（`:257-262`）。
- 落盘：`dsh-storage-json/lib/index.js:551`（`root`）、`:570`（`mkdir`），
  路径 `<home>/storages/<unit>.json` 或 `<home>/storages/<unit>/<table>/<key>.json`。
- **已知限制（README.zh.md 原话）**：「没有跨表事务、二级索引或多段键」；**没有迁移**（版本不符直接拒）。
- **为什么不用它**：记忆库要吃**项目作用域**（一项目一库、跟项目目录走），
  而 `storageDomain` 的根固定在 `<home>/storages`（全局）。
  强行用要么失去项目隔离，要么在 key 里手写项目前缀 —— 那不如直接用文件。
  **这一条是"优先复用"的例外，理由在这里。**

### 3.5 ★ 项目面：`project_dir` 直接当记忆库根

- `pipeline_project_init` 建的项目目录，其约定路径一处定义在 `lib/project/layout.js:50-58`：
  ```js
  projectLayout(projectDir) → { root, agentsMd, docsDir, productDesign, pipelineDir }
  // pipelineDir = join(root, '.pipeline')            // layout.js:57
  ```
- 实测的 `.pipeline` 布局（本机 `profiles/desktop/.pipeline/`，**13 个任务目录**）：
  ```
  .pipeline/switch.json
  .pipeline/<taskId>/{ task.json, audit.jsonl, requirement.md|.json,
                       handoffs/NNN-<kind>.json, artifacts/vN/, records/, reports/ }
  ```
- **守门已经放行读 `.pipeline/`**：`lib/guard/decide.js:521`（「任务卡 / 需求档 / 交接物是它们该看的」）；
  `lib/guard/shell.js:171` 的 `NON_CODE_DIR_SEGMENTS` 也把 `.pipeline` 列进了非源码目录。
- ⇒ **记忆库 = `<project_dir>/.pipeline/_memory/`**：复用既有根、复用既有的放行判据、
  用 `_` 前缀与 `T-*` 任务目录**不冲突**。

---

## 4. 会话面（活文档能不能挂在会话上）

### 4.1 能。而且**不用自己读日志**

- **投影服务**：`ctx.sessionProjections`
  - `snapshot(session, keys)` → `{asOfSeq, values}`，**同步、一致的切面** → `dsh-session-projection/lib/index.js:142-156`
  - `stateOf(session, key)` → `:127`；`cachedSnapshot(session, keys)` → `:165-181`
  - 插件用法：Cordis `inject: ["sessionProjections"]`（`README.zh.md:69-71`：「必须使用投影状态的领域把 `sessionProjections` 声明为 Cordis 服务依赖」）
- **冷读（零日志读）**：`ctx.sessionProjectionCache.cachedSnapshot(header, keys)`
  → `dsh-session-projection-cache/lib/index.js:193-198` —— **只要一个会话头**，不 `locate`、不读日志。
  落盘位置就是 §3 里那个 `<home>/storages/session_projcache/sessions/<sid>.json`。

### 4.2 实测：投影里有什么（本机 `<sid>.json`，`version: 7`）

`record.identity` = `{formatVersion, createdAt, cwd, isSeeded, inheritedEventCount}`

`record.rows` 共 **25 个键**：
`title`、`titleInput`、`llmRetry`、`sandboxMode`、`goal`、`tokenUsage`、`contextPressure`、
`contextBreakdown`、`turnBoundary`、`inbox`、`sessionStats`、`turnOutline`、`agentPreset`、
`userQuestions`、`subagentCatalog`、`subagentTiming`、`subagent`、`permissions`、`todos`、
`computerUseCoordinateMode`、`plan`、`subagentModelSelectionPolicy`、`modelSelection`、
`sessionListMetadata`、`imageLimits`

其中三条对本设计是**决定性**的（都是实测值，不是推测）：

| 键 | 实测形状 | 我们拿它干什么 |
|---|---|---|
| `turnOutline` | `{turns: [{turn, seq, prompt, response}], draft}`，实测 **373 条** | **reflect 的输入**（痛点 D：宿主已经替我们逐轮物化好了） |
| `contextPressure` | `{surfaceTokens: 205328, contextWindow: 1000000, pressureTokens: 425473, sampledSurfaceTokens: 204536}` | **防撑爆**：给 recall 算还能给多少 |
| `agentPreset` | 字符串（实测 `"standard"` / `"computer-use"`） | 认"这是哪个预设的会话" |

★ `agentPreset` 的**权威读法**是投影，不是头：`dsh-agent-preset-registry/lib/types/session.js:12-13`
原话「Reconstruction reads the `agentPreset` Session projection, **never the header alone**」。

### 4.3 枚举会话

- 冷：`await ctx.sessionPersistence.list()` → `{header, revision, sizeBytes}[]`
  （`dsh-session-persistence-jsonl/lib/index.js:2569-2597`；**不分页不过滤**，`README.zh.md:153`）。
- 更全：`ctx.sessionQuery.listSessions()` / `readTitleSnapshots()` → `dsh-session-query/lib/index.js:1070-1072` / `:1127`。
- 热：`ctx.sessions.list()` → `dsh-session/lib/index.js:1868-1869`。

### 4.4 ⚠️ 全文检索**是关着的**

`dsh-base/cordis.patch.yml:149-153` 把 `session-query-sqlite` 配成
`{path: ':memory:', openAt: never}` ⇒ `searchSessions`/`searchEvents` 直接返回
`SESSION_QUERY_SEARCH_DISABLED`，SQLite 根本不打开。

⇒ **不能指望宿主提供全文检索。** recall 的关键词路**必须自建**（但它是纯文件 + 内存，很轻）。

---

## 5. token 上限的度量（原生）

`ctx.tokenMeter` → `dsh-tool-cordis/lib/types/api-catalog.js:3147-3162`：

| 方法 | 签名 | 用途 |
|---|---|---|
| `measure` | `measure(session, requestHeader?) → TokenMeasurement` | 当前请求压力与 surface；**回放持久日志，确定性，不调模型** |
| `estimateMessage` | `estimateMessage(message) → number` | **给一条模型可见消息计价** ← recall 截断就靠它 |

`dsh-token-meter/README.zh.md` 原话：「使用 `ctx.tokenMeter` 估算会话当前的请求与上下文压力，
或**为单条消息计价**……测量会回放持久会话日志，结果确定且**不进行模型调用**」。
并且「会话投影可用时，消费方可以读取 `tokenUsage`、`contextPressure` 与 `contextBreakdown`」。

★ 这直接满足 Hindsight 的"取回有显式 token 上限"约束，且**不需要我们自己写 estimator**。

---

## 6. 复用 / 自建 裁决表

| 能力 | 决定 | 依据 |
|---|---|---|
| 钩子（retain / recall 注入） | **复用** `ctx.on` | §1；本插件已在用（`lib/intercept/registry.js:201`） |
| 注入形状 | **复用** `hostMessage()` | `lib/guard/hook-prompt.js:5-15` 的事故教训 |
| 跨项目用户裁定库 | **复用** `ctx.skills.register()` | §2.2；不落盘、不越工作区 |
| 项目记忆库根 | **复用** `.pipeline/` | §3.5；`lib/project/layout.js:57` |
| 会话元数据 / 活文档数据源 | **复用** 投影缓存 | §4.1-4.2；零日志读 |
| reflect 的输入 | **复用** `turnOutline` | §4.2；宿主已物化 373 轮 |
| token 上限 | **复用** `ctx.tokenMeter` | §5 |
| 总开关 | **复用** `lib/switch/gate.js` | `lib/switch/gate.js:94-198` 的 `SWITCH_SURFACES`（新增面必须登记） |
| **记忆的追加写** | **自建** | 没有"追加一行 JSONL 且绝不抛"的原生件 |
| **关键词索引** | **自建** | 全文检索宿主侧是关的（§4.4） |
| **实体归一/别名** | **自建** | 宿主不认识 `task_id`/`change_scope[].path` 的等价类 |
| **三路合并与截断** | **自建** | 没有原生 rerank（也不抄） |
| **活文档渲染** | **自建** | 只是文本渲染，纯函数 |
| 通用 KV 存储 | **不用** `ctx.storageDomain` | §3.4：根固定在 `<home>/storages`，与"每项目一库"冲突 |

---

## 7. 未证实（查过但没结论，如实列出）

1. **监听器级超时**：grep `listener timeout|waterfall.*timeout|LISTENER_TIMEOUT` 无命中
   → 认为**不存在**，但这是"没找到"而非"确认没有"。
2. **`DSH_BUNDLED_SKILL_DIR` 的写入方**：全 asar 只有读方（`dsh-skill-filesystem/lib/index.js:84`），**没有写方**。
3. **`~/.dsh/.dshw-{size,turn,usage}.json` 的写入方**：全 asar grep 零命中 → 是本机**未随包分发**的插件写的。
4. **`docs/subsystems/*.zh.md`**：多个 README 引用，但**不在 asar 里**（`list "/dsh/docs"` 为空）。
5. **asar 里只有编译后的 `lib/*.js`，没有 `src/*.ts`** → 所有行号都是编译产物的行号，
   与上游源码行号**不保证一致**。
6. **SQLite 存储后端**：`dsh-storage-sqlite` 只被 README 提及，**包里不存在**；除 `json` 外没有第二个后端。
7. **不落根的判断**：`ctx.sessionProjections` 是否允许第三方插件 `register` 新投影键 —— 接口在
   （`dsh-session-projection/lib/index.js:68`），但**没验证过本插件这个 scope 能不能注册**。
   ⇒ 设计上**不依赖**这条（我们只**读**别人的投影，不注册自己的）。
