# dsh-pipeline「重启后恢复链」诊断与修复方案

| 项 | 值 |
| --- | --- |
| 诊断对象 | `dsh-pipeline` 0.1.0（DSH 插件，Host 半边） |
| 安装副本（宿主实际加载） | `<DSH_HOME>\profiles\desktop\node_modules\dsh-pipeline` |
| 源码副本 | `<DSH_HOME>\dsh_orb\新任务-为-dsh-写一个插件-实现用户要的-多对话-ai-协作开发流水线-主对\dsh-pipeline` |
| DSH 本体 | `D:\tool\Deepseek\Deepseek harness\resources\app.asar`（121MB 单文件） |
| 排查方式 | **只读**。未修改任何文件、未重启 DSH、未打开「多AI 协调」开关、未跑任何流水线任务 |
| 副本一致性 | 两份副本 `lib/**`、`index.js`、`package.json`、`cordis.patch.yml` 逐文件 SHA-256 比对：**完全一致**，无差异 |

> 说明：本文件是诊断结论的落盘版本，用于避免长回复被截断。所有结论都带 `文件:行号`。
> 会话现场记录（用户实测现象）：
> 1. 重启后原会话调 pipeline 工具 → `[pipeline] 拒绝：流水线工具的调用方身份无法确定。本会话既没有绑定任何角色，也没有携带 role_token。`
> 2. 拿开单时铸的主对话令牌去认领 → `role_token 无效或已过期：PT-b2b2fb76…请让主对话重新 pipeline_dispatch 铸造。`
> 3. 想用同一个 `task_id` 重新开单自救 → `任务 T-… 已存在，请换一个 id。`
> 4. 该会话随后反复失败，最后「处理失败」，报错原文 `format v4 message requires a producer-owned source kind`

---

## 摘要（先看这段）

四条现象是**两个互相独立的病因**，不是一个 bug 的四种表现：

| # | 现象 | 病因 | 定性 |
| --- | --- | --- | --- |
| 1 / 2 / 3 | 身份丢失 → 令牌无效 → 老单成孤儿 | **身份（绑定 + 令牌）只存在进程内存里**，且唯一的重认领入口也依赖内存令牌 ⇒ 死锁 | 内存化本身**有意为之**；由此产生的"孤儿单无出路"是**无意遗漏 + 状态机死角** |
| 4 | `format v4 message requires a producer-owned source kind` | **`lib/hostmsg.js:43` 把 `source.kind` 写成已退役的裸 `'plugin'`**，被 DSH 的 v4 会话格式准入在**编码落盘前**拒收 | **真缺陷**，插件自己写错了一个字段值 |

**优先级**：现象 4 最紧急（它让整个会话「处理失败」，且每次恢复会话都会再炸一次）；现象 1/2/3 才是用户当初拍板的「被切断后要能恢复」那条需求没做到。

一个关键澄清：**现象 1/2/3 不是"重启把落盘的东西弄丢了"，而是"这两样东西从来没落过盘"。** 落盘的任务台账完好无损（见 A 节）。

---

## A. 状态存放位置对照表

| 东西 | 存哪 | 证据（文件:行号） |
| --- | --- | --- |
| **会话 ↔ 角色绑定** | **纯内存** | `lib/tokens.js:41` 是一个 `Map`；绑定动作就是往这条记录上写 `rec.agentId`（`tokens.js:151`）；反查用 `roleOfAgent` 遍历同一个 Map（`tokens.js:156-165`）；装配处 `index.js:135` 只调 `createTokenStore`，全项目**没有任何一处**把它写盘 |
| **role_token 令牌表** | **纯内存** | `tokens.js:28-35` 注释原文：「令牌表。内存态 —— 进程重启即失效，**这正是想要的语义**："上一次会话拿过令牌"不构成这一次的通行证。」表本体在 `tokens.js:41`，过期清扫在 `tokens.js:44-47` |
| **任务台账（task）** | **纯落盘** | `store.js:512` 定义 `dispatched: []`；`store.js:618-627` `recordDispatch()` → `persist(task)`；落点 `.pipeline/<taskId>/task.json` + `audit.jsonl`。实测盘上存在 3 张单：`T-20261011-4a2dc7` / `T-20261011-5f31b2` / `T-20261011-a5fe41` |
| **席位（seat）** | **混合** | 角色清单与席位数在 `task.json`（落盘，随 `task.roster`）；**席位令牌与 agent 绑定在内存 Map**（同一份 `tokens.js:41`） |

### A.1 「落盘了却被判无效的东西」：没有

这是本次排查里最需要先钉死的一条结论：**不存在"东西在盘上、却被判无效"的情况。**

落盘的任务台账是完好的——实测读取 `<DSH_HOME>\profiles\desktop\.pipeline\T-20261011-4a2dc7\task.json`，`state: "analyzing"`、`history` 两条、`acceptance_from_user` 五条全在。它没有被损坏、没有被判无效，只是**没有任何身份能走到它面前去操作它**。

真正没落盘的是**绑定**和**令牌表**这两样，它们从来就不在盘上。

### A.2 令牌那条：不是 TTL，不是验签密钥，就是内存 Map

用户原始怀疑有三个方向（TTL 到期 / 进程内密钥变化导致验签失败 / 根本就是内存 Map）。**答案是第三个。**

排除 TTL 与验签的两条硬证据：

1. **没有签名，没有密钥。** 令牌就是一个随机串：`tokens.js:59` `token: \`PT-${randomId(12)}\``。校验方式是**查表命中即有效**（`tokens.js:93` `const rec = tokens.get(token)`），全程不涉及任何密钥、HMAC 或验签。所以"密钥变化导致验签失败"这条在代码层就不成立。
2. **TTL 是相对时间，且实测时间线远没到期。**
   - `tokens.js:26` `DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000`（2 小时）
   - `tokens.js:68-69`：`issuedAt: t, expiresAt: t + ttlMs` —— **相对**于铸造时刻，不是绝对到期时间。所以不存在"用绝对时间导致重启即过期"这个经典坑。
   - 实测时间线：孤儿单 `T-20261011-4a2dc7` 于 **08:15:50** 开单（`task.json` 的 `created_at` 与 `audit.jsonl` 第一条一致），DSH 于 **08:46:58** 左右重启，令牌只活了约 **31 分钟**。默认 TTL 是 2 小时（`config.js:169` `tokenTtlMs: 2 * 60 * 60 * 1000`），**远未到期**。
   - ⇒ 那次"无效或已过期"**必定**是"表没了"（进程内存被清空），而不是"过期了"。

### A.3 报错文案缺陷：把两件事合并成一句

`tokens.js:94-96`：

```js
const rec = tokens.get(token)
if (rec === undefined) {
  return { ok: false, error: `role_token 无效或已过期：${token}。请让主对话重新 pipeline_dispatch 铸造。` }
}
```

「表里根本没有这枚令牌」和「令牌真的超过了 TTL」是**两件处置方式完全不同**的事：

- 前者是**进程重启**（内存态丢失），重试无用，必须重新认领；
- 后者是**真的超时**（默认 2 小时），重派一次即可。

但代码只给同一句文案。现场截图里的 AI 只能靠猜，说出了"过期/失效"这种含糊结论——**这是纯粹的诊断信息缺陷**，不是机制缺陷。修它零风险（见 D-2）。

### A.4 附带发现：`task.dispatched[].token` 是只写不读的

`store.js:507` 记录了派活台账的形状：

```
形状：`{ key, role, seat, agent_id, token, at, at_ms, via }`。
```

**令牌明文确实被写进了 `task.json`**。但全项目 grep `.dispatched` 只有 5 处命中，**没有任何一处把 `token` 读回来**：

- `liveness.js:117`（JSDoc 注释）
- `liveness.js:234` `const list = Array.isArray(task?.dispatched) ? task.dispatched : []`
- `tools.js:1864` `if (!Array.isArray(t.dispatched) || t.dispatched.length === 0) continue`
- `store.js:622-623` `upsertDispatch(...)` / `task.dispatched = next`（写）

⇒ 它是**只写审计数据**，不是可恢复的数据源。**不能**指望"重启后从 `task.json` 里把令牌读回来重新灌进令牌表"——没有这段代码，而且：

**孤儿单 `T-20261011-4a2dc7/task.json` 连 `dispatched` 字段都没有。** 该单写盘于 `08:15:56`，早于 `dispatched` 字段引入；它的 `task.json` 里根本没有这个键（对照：晚开的 `T-20261011-a5fe41` 有 `"dispatched": []`）。所以对这张单，连"只写台账"都不存在。

---

## B. 逐条定性

### 现象 1 —— 重启后「调用方身份无法确定」

**定性：绑定内存化是「有意为之」；但它导致的守门整体失效是「无意的副作用」。**

**依据（有意为之的部分）**：`tokens.js:28-35` 的注释把设计意图写得非常明确——内存态、"重启即失效"、"这正是想要的语义"。这不是忘了落盘，是刻意选的。

**依据（无意副作用的部分）**：`lib/guard.js:580-584`：

```js
const binding = agentId === null ? null : tokens.roleOfAgent(agentId, undefined)

// 非流水线工具、且调用方没有绑定任何角色 → 与流水线无关，直接放行。
// （守门只约束流水线参与者，绝不去管无关会话 —— 这是与其它插件共存的前提。）
if (!isPipelineTool && binding === null) return undefined
```

`guard.js:704` 的**整个写权限判据**都挂在 `binding !== null` 上：

```js
if (writeTools.includes(name) && binding !== null) {
  const cls = writeClassOf(binding.role)
  if (cls === 'readonly' || cls === 'own-dir' || cls === 'own-log') { ... }
```

⇒ **重启后，之前派出去的席位（writer / tester / reviewer）在文件工具与 shell 层面全部脱离守门。** 具体包括但不限于：

- 「测试不得改代码」（编写才动代码）
- 「审核只读」（`own-log`：只允许写自己的日志）
- 「主对话 / 需求分析 / 计划不看源码正文」
- 「编写只能写自己的 `scope_paths` 分区」

这些在重启后**全部静默失效**（fail-open），直到主对话重新 `pipeline_dispatch` 派活为止。**这不是"不方便"，这是一个事故面**——它意味着"越界会被拦"这句话在重启后是假的。用户当初的核心诉求恰恰是"行为靠代码层拦截，不靠自然语言"，所以这条必须单独列出来。

### 现象 2 —— 令牌被判「无效或已过期」

**定性：同一决策的必然结果，属「有意为之」；但报错文案是缺陷。**

令牌表与绑定的存储位置是同一个对象（`tokens.js:41`），所以"绑定失忆"和"令牌失效"**必然同时发生**，它们是同一个原因的两个面，不是两个 bug。

文案缺陷见 A.3。

### 现象 3 —— 老单成孤儿：不能推进、不能取消、也不能同 id 重开

**定性：「无意遗漏 + 状态机死角」。**

先把因果理清，这里有一个容易被误判的点：

> **「不能取消」不是状态机的错。** `lib/states.js:259` 明确登记了：
> ```js
> { from: '*', event: 'cancel', to: ST.CANCELLED, by: ['main', 'human'], note: '任意非终态可取消' },
> ```
> 取消这条边**一直存在**。之所以取消不了，是因为**身份先没了，根本走不到那一步**——`guard.js:664-673` 在身份为 `null` 时就拒绝了，压根到不了状态机。

真正的问题在三处：

1. **`task_id` 是硬唯一，没有认领已有单的分支。** `store.js:413-416`：
   ```js
   const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : newTaskId(now())
   if (cache.has(id) || existsSync(taskFile(id))) {
     return deny('TASK_EXISTS', `任务 ${id} 已存在，请换一个 id。`)
   }
   ```
   而 `pipeline_task_open`（`tools.js:493-508`）直接调 `store.open`，**没有"这单已存在、你要不要认领它"这条路**。

2. **全项目没有任何 resume / rebind 入口。** grep `resume` 得到 123 处命中，**全部**是"澄清请求 / 人工答复后状态回退"（`clarify:resume`、`human:resume`、`resumed_to`），与身份重认领无关。没有为"重启后重新认领席位/主对话"设计的工具。

3. **唯一的重认领入口自己也需要令牌 ⇒ 死锁。** `tools.js:1611-1614`：
   ```js
   const declared = String(args.role_token ?? '')
   const r = tokens.resolve(declared, {})
   if (r.ok !== true) return { ok: false, role: '', task_id: '', agent_id: agentId, summary: r.error }
   const b = tokens.bindAgent(declared, agentId)
   ```
   `pipeline_bind_role` 是**先 `resolve` 再 `bindAgent`**——令牌表空了，它必然失败。于是形成闭环死锁：

   > 要认领 → 需要令牌 → 令牌要主对话 `pipeline_dispatch` 铸 → 主对话要身份 → 身份要认领 → …

   现场现象 2 正是卡在这个环上的第二次尝试（第一次是直接调工具，第二次是拿旧令牌认领）。

**为什么说是「无意遗漏」而不是「有意设计」**：README 里有一节专门回答"重启后还在吗"——`README.md:510`「### 状态存在哪 / 重启后还在吗」，但**整节只讲了开关**（`switch.json`，"重启后保持上次的选择"）。令牌、绑定、孤儿单**一次都没提**。⇒ 设计时没有把"身份跨重启"当成一个需要回答的问题，属遗漏，不是取舍。

### 现象 4 —— `format v4 message requires a producer-owned source kind`

**定性：真缺陷，且是插件自己写错了一个字段值。** 详见 C 节。

---

## C. `format v4 message requires a producer-owned source kind` 精确来源与触发链

> **本节是最优先项**：它让整个会话「处理失败」，且每次恢复该会话都会再炸。

### C.1 报错字符串在哪个包 —— DSH 本体，不在插件

先在插件两份副本里全文搜索 `producer-owned source kind`：**0 命中**（只在 `tests/*.txt` 的历史测试输出里作为"待查线索"出现）。⇒ 这个错**不是插件抛的**。

到 DSH 本体 `app.asar` 里做二进制搜索（该 asar 未压缩，JS 源码原样存放，可直接按字节定位），命中 2 处，解析 asar 头部 JSON 后映射回文件：

| asar 绝对字节偏移 | 归属文件 | 文件内偏移 |
| --- | --- | --- |
| 55619882 | `@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js` | 5306 |
| 56447627 | `@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs` | 439418 |

即 asar 内路径：

```
/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js
/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs
```

第二个是把同一份校验**打包进**了持久化 worker（源码区域注释为 `../session-format-v3-to-v4/src/message-sources.ts`）。真正的源头是前者。

**抛出点源码**（`dsh-session-format-v3-to-v4`，region `lib/types/message-sources.js`）：

```js
/** Native source admission preserves unknown attribution and refuses retired plugin wrappers. */
function source(message) {
	const value = message["source"];
	if (!isSessionFormatJsonObject(value) || typeof value["kind"] !== "string" || value["kind"].length === 0 || value["kind"] === "plugin") throw new SessionFormatError("format v4 message requires a producer-owned source kind");
}
```

### C.2 触发条件

一条消息进**持久槽位**时，其 `source` 满足以下**任一**即抛：

| 条件 | 含义 |
| --- | --- |
| `!isSessionFormatJsonObject(value)` | `source` 缺失 / 为 `null` / 不是对象（例如是字符串） |
| `typeof value["kind"] !== "string"` | `kind` 不是字符串 |
| `value["kind"].length === 0` | `kind` 是空串 |
| **`value["kind"] === "plugin"`** | **`kind` 是已退役的裸 `'plugin'`（本次命中的就是这条）** |

被检查的"持久槽位"由 `mapEventMessages` 定义：`user/message`（消息就是 `data` 本身）、`developer/message` / `system/message` / `assistant/message` / `tool/result`（取 `data.message`）、`agent/inbox/spliced`（取 `data.inserted[]`）、`session/title-llm-request`（取 `data.messages[]`）。

### C.3 触发链：两条路径，本次走的是写路径

**路径一 —— 写路径（本次命中的就是这条）**

在 `dsh-session-persistence-jsonl/lib/worker.cjs` 里，v4 编解码器对象 `releasedV4SessionFormatCodec` 的 `encodeEvent`：

```js
encodeEvent(event) {
	if (event.type === "developer/message" && event["ignorable"] === true) {
		assertV4DeveloperData(event);
		assertV4RetiredSyntax(event);
	}
	assertV4RowAdmission(event);
	return releasedV2SessionFormatCodec.encodeEvent(event);
}
```

调用链：

```
releasedV4SessionFormatCodec.encodeEvent(event)
  └─ assertV4RowAdmission(row, knownEventTypes)
       └─ assertV4SourceRowAdmission(row)
            ├─ row.type === 'user/message'  ⇒  messages = [row.data]
            ├─ const value = message["source"]
            └─ if (isSessionFormatJsonObject(value) && value["kind"] === "plugin") source(message)   ← 抛
```

`assertV4SourceRowAdmission` 原文：

```js
function assertV4SourceRowAdmission(row) {
	if (!isSessionFormatJsonObject(row) || !isSessionFormatJsonObject(row["data"])) return;
	const data = row["data"];
	const messages = row["type"] === "user/message" ? [data] : row["type"] === "system/message" || row["type"] === "assistant/message" || row["type"] === "tool/result" ? [data["message"]] : row["type"] === "agent/inbox/spliced" ? data["inserted"] : row["type"] === "session/title-llm-request" ? data["messages"] : [];
	if (!Array.isArray(messages)) return;
	for (const message of messages) {
		if (!isSessionFormatJsonObject(message)) continue;
		const value = message["source"];
		if (isSessionFormatJsonObject(value) && value["kind"] === "plugin") source(message);
	}
}
```

注意这条路径的判据比较窄——它**只在 `kind === 'plugin'` 时才调 `source()`**，所以"完全没有 `source`"能过这一关（但过不了路径二）。

**路径二 —— 读路径（本次没走，但要知道它存在）**

`worker.cjs` 里扫描/恢复会话日志时：

```
finish()
  └─ assertReleasedV4Relationships(artifact, KNOWN_SESSION_EVENT_TYPES)
       └─ for (const event of artifact.events) { ...; assertV4MessageSources(event); ... }
            └─ mapEventMessages(event, (message) => { source(message); return message; })   ← 无条件判
```

```js
try {
	assertV4RowAdmission(decoded, KNOWN_SESSION_EVENT_TYPES);
} catch (error) {
	if (error instanceof SessionFormatUnsupportedMigrationError) throw new SessionFormatUnsupportedError(error.message);
	throw error;
}
```

**两条路径的关键区别**：写路径只在 `kind === 'plugin'` 时拒；读路径**无条件**调 `source()`，所以"消息根本没有 `source` 字段"也会在读路径上炸。这是同一个文案下的两个不同入口。

### C.4 pipeline 插件是不是触发方 —— 是

**它传错的字段是 `source.kind`。**

`lib/hostmsg.js:43`：

```js
/** 本插件在宿主消息 `source` 上的分类值。 */
export const HOST_SOURCE_KIND = 'plugin'

/** 本插件名（写进 `source.plugin`，便于宿主/别的插件分流）。 */
export const HOST_PLUGIN_NAME = 'dsh-pipeline'
```

`lib/hostmsg.js:116-133` 用它构造消息：

```js
export function hostMessage(spec) {
  const s = spec !== null && typeof spec === 'object' ? spec : {}
  const source = {
    kind: HOST_SOURCE_KIND,        // ← 'plugin'，正是 v4 明确拒收的那个值
    plugin: HOST_PLUGIN_NAME,      // ← 'dsh-pipeline'
    form: typeof s.form === 'string' && s.form.length > 0 ? s.form : 'note',
  }
  if (typeof s.taskId === 'string' && s.taskId.length > 0) source.task_id = s.taskId
  if (typeof s.role === 'string' && s.role.length > 0) source.role = s.role
  if (typeof s.seat === 'string' && s.seat.length > 0) source.seat = s.seat
  if (s.extra !== null && s.extra !== undefined && typeof s.extra === 'object') source.extra = s.extra

  return {
    role: 'user',
    content: [{ type: 'text', text: String(s.text ?? '') }],
    source,
  }
}
```

**注入点**（`hostmsg.js:61-102` 的 `HOST_INJECTION_SITES` 表里 `via: 'hostMessage'` 的两处，都在 `agent/pre-step` 缝上）：

- `lib/intercept.js:342` —— 席位开场简报（边界卡 + 四问，`form: 'seat-briefing'`）
- `lib/intercept.js:364` —— 失联席位提示（`form: 'stale-seat-notice'`）

两处都塞进 `decision.messages`（`intercept.js:376-380`）：

```js
if (extra.length === 0) return downstream
return {
  ...downstream,
  messages: [...(downstream.messages ?? []), ...extra],
}
```

该缝的开关确认是**开着**的：`config.js:87` `intercept: true`（默认值），且 `cordis.patch.yml` 未覆盖它；`config.js:19` `guardEnabled: true`；`config.js:176` `registerPromptSection: true`。

### C.5 正确形态应该是什么

**`source.kind` 必须是"生产者自有的 kind"，即 `plugin:<插件名>`。**

依据在 DSH 自己的 v3→v4 迁移代码里（`dsh-session-format-v3-to-v4/lib/index.js`）：

```js
/** Resolve the current producer kind for one released V3 plugin string. */
function producerKind(plugin, role) {
	if (plugin === "@deepseek-ai/dsh-system-prompt" && role === "system") return "system-prompt";
	const renamed = Object.hasOwn(RENAMED_PRODUCERS, plugin) ? RENAMED_PRODUCERS[plugin] : void 0;
	if (renamed !== void 0) return renamed;
	if (RELEASED_SAME_NAME_PRODUCERS.has(plugin)) return plugin;
	return `plugin:${plugin}`;
}
```

对**不在已知名单里的第三方插件**，规范推导就是 `` `plugin:${plugin}` ``。`dsh-pipeline` 不在 `RELEASED_SAME_NAME_PRODUCERS`、也不在 `RENAMED_PRODUCERS` 里，所以：

> **正确值：`kind: 'plugin:dsh-pipeline'`**，并**删掉并列的 `plugin` 字段**（v4 把生产者身份放进 `kind` 里，`rewritePluginSource` 的迁移动作就是删掉 `plugin` 键）。

**同机对照实验（决定性证据）**：这台机器的 profile 里有两个插件在产出 `kind: 'plugin'`。另一个是 `dsh-better-sidebar`，而它**已经修对了**。它的源码注释原文（`node_modules/dsh-better-sidebar/lib/index.js`）：

> The plugin's producer-owned source kind, stamped on the source of context-injection messages (boundary prompt + parked snapshot) so the transcript recognizes them structurally — not by text prefix. **Session format v4 retired the bare `kind: 'plugin'` + `plugin` pair; a plugin is now identified by its own `plugin:<name>` kind**, which is exactly what DSH's own v3→v4 migration derives for rows this plugin wrote earlier, so both generations read back under one shape.

以及常量定义：

```js
const SIDE_INJECTION_SOURCE_KIND = "plugin:dsh-better-sidebar";
```

另一段注释更直白：

> The injection source carries the plugin's producer-owned kind (`plugin:dsh-better-sidebar` — **session format v4 refuses the retired bare `kind: 'plugin'`**)

⇒ 同一个 profile、同一个 DSH build 下，邻居插件踩过同一个坑并留下了正确写法。这条可以直接当修复范本。

### C.6 判断依据汇总（源码位置 / 解包路径 / 复现方式）

**（1）DSH 本体定位方式**（app.asar 是 121MB 单文件，未压缩；旁边有 `app.asar.unpacked` 目录）：

asar 头部结构（用 Node 直接读，无需第三方工具）：

- 偏移 0..3：`uint32 = 4`
- 偏移 4..7：pickle 大小
- 偏移 8..11：`headerSize + 4`
- 偏移 12..15：**JSON 头部长度**（本机实测 `3392048`）
- 偏移 16 起：JSON 头（记录 12967 个条目，其中 11470 个 `unpacked: false`）
- 数据段起点 `dataStart = 16 + jsonLen = 3392064`
- 每个文件的**真实字节位置 = `dataStart + entry.offset`**（`offset` 是相对数据段起点的）
- 校验：打包文件最后一个 `offset + size` 恰好等于 121348951（asar 总长）⇒ 偏移约定正确
- ⚠️ 必须跳过 `unpacked: true` 的条目，它们的 `offset` 无意义（本机第一个打包文件是 `/dsh/<redacted>.json`，offset=0）

**（2）插件侧证据**：`lib/hostmsg.js:43`、`:118-122`；`lib/intercept.js:342`、`:364`；`config.js:87`（`intercept` 默认 true）。

**（3）磁盘取证 —— 反证"不是读盘时炸的"**

我把本机**全部 49 个会话文件**（`<DSH_HOME>\sessions`，另有 `storages/session_projcache/sessions`、`_session-backups`）全部解压并逐行校验：

- 会话文件是**多帧 zstd**（每追加一次就是一个新 frame）。`zlib.zstdDecompressSync` 和 `createZstdDecompress()` **都只解第一帧**，会严重漏读（我第一次就中招：某文件 3041 字节只解出 291 字节、1 行）。正确做法是按 zstd 魔数 `28 B5 2F FD` 切帧、逐帧解压再拼接。
- 结果：**49455 行，0 行无法解析**（说明解码完整无误）。
- 结果：**没有任何一行含 `"kind":"plugin"`；也没有任何一行缺 `source`。**

这个"查无此物"恰恰是**关键证据**：如果失败发生在**编码落盘前**，那么盘上就不可能有坏行——而行根本没写进去，也正好解释了为什么"反复失败"却没有留下 `turn/end` 错误记录（我遍历过全部会话的 `turn/end`，只有 `tool input is invalid JSON` 4 次和 `Cannot read properties of undefined (reading 'kind')` 2 次，**没有** `producer-owned source kind`）。

**（4）DSH 会把这些注入消息当持久 `user/message` 事件处理 —— 这一环的证据**

`dsh-session-reference/lib/index.js` 的投影函数遍历**已落盘**的事件并读 `event.data.source.kind`：

```js
function projectSessionConversation(snapshot) {
	const conversation = [];
	for (const event of snapshot.events) switch (event.type) {
		case "user/message": {
			const checkpoint = isCompactCheckpointSource(event.data.source);
			if (!checkpoint && event.data.source.kind !== "user") break;
			...
```

以及同包的 `agent/pre-step` 监听器（`{ prepend: true }`，即在下游监听器——包括 pipeline——都追加完之后才跑）：

```js
ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
	const decision = await next();
	if (decision.kind === "reject") return decision;
	return {
		...decision,
		messages: await this.prepareDirectMessages(agent, decision.messages, signal)
	};
}, { prepend: true });
```

⇒ `agent/pre-step` 的 `decision.messages` 就是这一步的消息列表，会被当 `user/message` 事件处理（落盘的 `user/message` 行都带 `surfaceOp: "append"`，实测）。pipeline 塞进去的裸消息因此会走到 v4 编码准入。

**（5）"这台机器上只有 pipeline 传错"的穷尽性检查**

- 扫描 profile `node_modules`（3 层深，排除 `node_modules` 子目录与 `.bak-*`）：只有 `dsh-pipeline/lib/hostmsg.js` 与 `dsh-better-sidebar/lib/index.js` 命中 `kind: 'plugin'`，而后者已改成 `plugin:dsh-better-sidebar`（命中只是注释里在讲这件事）。
- 扫描 DSH 本体全部 `.js/.cjs/.mjs`（7512 个）：`kind: "plugin"` 只出现在**迁移包**里（`dsh-session-format-v1-to-v2`、`dsh-session-format-v2-to-v3`、以及 `worker.cjs` 的打包副本）——那些是**读旧格式时构造 V3 中间形态**用的，不是给新消息用的。⇒ **宿主自身不为新消息产出裸 `kind:'plugin'`。**
- 实测本机会话里出现的 `source.kind` 取值（DSH 自己用的）：`user`、`system-prompt`、`runtime-context`、`computer-use`、`fallback`、`dsh-session-title-llm`、`provider`、`model`、`tool`、`tool-registry`、`subagent-settled`。**`plugin` 不在其中** —— 佐证它是被淘汰的形态。

### C.7 一个重要因果修正：上一个修复把失败点往后推了一步

`lib/hostmsg.js` **本身就是为了修上一个 bug 才写的**。它的文件头注释（`hostmsg.js:8-24`）记录了 2026-10-11 的事故链：原来在 `agent/pre-step` 里塞的是**裸对象** `{ role:'user', content: seatBriefing(...) }`——**没有 `source`**，且 `content` 是字符串。宿主 `dsh-session-reference#prepareDirectMessages` 无守卫地读 `message.source.kind`（`if (message.source.kind !== "user") return [message];`）⇒ `TypeError: Cannot read properties of undefined (reading 'kind')` ⇒ 整个 turn 以 error 收尾。

**我在磁盘上抓到了这次事故的现场**（会话 `<uuid>`）：

```
{"type":"turn/start","seq":5,"time":1791706560157,"data":{"turn":1}}
...
{"type":"turn/end","seq":7,"time":1791706560434,"data":{"turn":1,"reason":{"kind":"error","error":{"message":"Cannot read properties of undefined (reading 'kind')","code":"UNKNOWN"}}}}
```

`turn/start` 到 `turn/end` 相隔 **277 ms**，与 `hostmsg.js:22-23` 注释里写的"277 ms 就死"完全吻合。

**所以**：`hostmsg.js` 的修复消除了 TypeError，但**换来的形状 `kind:'plugin'` 仍然被 v4 准入拒收**——只是判据换到了下一站。这解释了为什么这个报错看起来是**新出现的**：它不是新 bug，而是**同一个形状的失败点后移**。两次失败都在同一个字段（`source`）上：

| 阶段 | 注入的消息形状 | 后果 |
| --- | --- | --- |
| 修复前 | `{ role:'user', content:'…' }`（无 `source`） | `session-reference` 读 `message.source.kind` ⇒ TypeError ⇒ turn 以 error 收尾（277ms 秒死） |
| 修复后（现状） | `{ role:'user', content:[…], source:{ kind:'plugin', … } }` | v4 编码准入 `kind === 'plugin'` ⇒ `SessionFormatError` ⇒ 落盘被拒 ⇒ 「本轮运行失败」/「处理失败」 |

**正确的形状是第三种**：`source: { kind:'plugin:dsh-pipeline', form:'…', … }`，同时满足双方——有 `source`（session-reference 不炸）、`kind` 是生产者自有值（v4 准入放行）。

---

## D. 分级修复方案

按**改动量从小到大**排列。每条给出：改哪个文件 / 改成什么 / 影响面 / 风险 / 是否需重启 DSH / 能否离线验证。

> **是否需重启 DSH 的通用答案**：本插件是 Host 半边，**所有改动都要重启 DSH 才生效**（`README.md:401`「安装 / 卸载 / 改配置需要重启 DSH。Host 半边插件在启动时装载，热更不覆盖」）。唯一例外是右上角那个运行期开关（`README.md:402`）。所以下面每条单列该字段，但除注明外都是"要"。

---

### 【必修 P0-1】修掉 format v4 —— 改一个常量值

| 项 | 内容 |
| --- | --- |
| **改哪个文件** | `lib/hostmsg.js`（两份副本都要改；它们当前完全一致） |
| **改成什么** | 第 43 行：`export const HOST_SOURCE_KIND = 'plugin'` → `export const HOST_SOURCE_KIND = 'plugin:dsh-pipeline'`。同时建议删除 `hostmsg.js:120` 的 `plugin: HOST_PLUGIN_NAME,` 一行（v4 把生产者身份放进 `kind`，不再有并列的 `plugin` 字段；DSH 的 v3→v4 迁移 `rewritePluginSource` 就是把这个键删掉）。`HOST_PLUGIN_NAME` 常量可保留供别处使用，但不要再写进 `source` |
| **影响面** | `hostmsg.js` 是设计上的"唯一出口"（`hostmsg.js:32-37` 明确要求所有注入点都走它），所以两个 `via:'hostMessage'` 的注入点**自动跟随**：`intercept.js:342`（席位简报）、`intercept.js:364`（失联席位提示）。`HOST_INJECTION_SITES` 里另外三处 `via:'content-blocks'`（`lib/transport/index.js` 的 `startContinuable`/`sendMessage`、`intercept.js` 的 `tools/post-execute` feedback）**不受影响**——它们只交内容块，消息由宿主自己包、宿主自己补 `source`。无状态机改动、无守门判据改动、无落盘格式改动 |
| **风险** | **极低**。纯取值修正，且改后的值正是 DSH 迁移代码对第三方插件的规范推导（`` `plugin:${plugin}` ``），也是同机邻居插件 `dsh-better-sidebar` 已经在用的形态。唯一要留意的是：这会**立即解除**当前"会话一开会话就炸"的状态，所以它是一个**行为可见的变化**（从"炸"变成"不炸"），不是静默修复 |
| **是否需重启** | **要**（Host 半边不热更） |
| **能否离线验证** | **能，而且不需要跑流水线**。三级验证：<br>① 形状断言：直接对 `hostMessage({ text:'x', form:'y' })` 的返回值断言 `source.kind === 'plugin:dsh-pipeline'`，且 `source.kind !== 'plugin'`；<br>② 判据级：把返回值喂给 DSH 的校验函数（`assertV4MessageSources` / `assertV4RowAdmission` 都是**纯函数、零副作用**，可从 `app.asar` 里的 `dsh-session-format-v3-to-v4` 取用），断言不抛；<br>③ 反例：把 `kind:'plugin'` 的老形状喂进去，断言**必须抛** —— 这样才证明测试真的在看这件事 |

**⚠️ 这一条必须配一个防回归动作，否则下次照样回归。**

原因：现有的自测**守不住这个值**。`hostmsg.js:185-187` 的校验只查 `kind` 是不是非空字符串：

```js
} else if (typeof src.kind !== 'string' || src.kind.length === 0) {
  v.push(`${path}.source.kind 缺失或非字符串 —— 宿主靠它分流`)
}
```

`'plugin'` 是合法非空字符串 ⇒ **能通过**。而 `hostmsg.js:35-37` 说"自测按这张表逐一核对形状（见 `tests/liveness-check.mjs` 的「注入形状」用例组）"——那组用例显然只核对了"有 source、kind 非空"，没核对**取值**。所以：

> **配套改动**：把 `assertHostMessage`（`hostmsg.js:185` 附近）收紧为"`kind` 必须以 `plugin:` 开头"或"必须属于已知 producer 名单"，并在 `tests/liveness-check.mjs` 的「注入形状」用例组里加一条断言。否则这个 bug 会以同样的方式再来一次。

---

### 【必修 P0-2】拆开误导性的令牌报错文案

| 项 | 内容 |
| --- | --- |
| **改哪个文件** | `lib/tokens.js` |
| **改成什么** | 第 94-96 行把一个分支拆成两个语义明确的分支。现状只查 `rec === undefined` 就报"无效或已过期"。建议：<br>· **表里没有**（`rec === undefined`）→ 文案改为「本进程的令牌表里没有这枚令牌（`PT-…`）。★ 令牌表是**内存态**：若 DSH 刚重启，所有令牌——包括主对话开单时铸的那枚——**必定全部丢失**，这不是过期。恢复方式：重新认领（见 D-4）。」<br>· **真过期**：`sweep()`（`tokens.js:44-47`）是**静默删除**过期项的，所以要做到这一点，`sweep` 需要把被删的记录留下来（例如保留一个最近过期的小环形缓存），才能在 `resolve` 时区分"被清扫掉的"和"从来没有的"。若不想动 `sweep`，则**至少**把"内存态、重启必丢"这句写进现有文案 —— 这是零成本的一半 |
| **影响面** | 纯文案。`resolve` 的返回值形状不变，守门（`guard.js:661`）与工具层（`tools.js:284`）都只是把 `error` 原样透出 |
| **风险** | **无**（若只改文案）。若动 `sweep` 增加"过期留痕"，则多一份内存状态，需要确认不会与 `sweep` 的"无需定时器"设计冲突 |
| **是否需重启** | 要 |
| **能否离线验证** | 能。单测：清空令牌表后 `resolve` 任意串 → 断言文案含"重启"字样且**不含**"过期"；铸造一枚短 TTL 令牌、跨过 TTL 后 `resolve` → 断言文案指向"过期" |

---

### 【必修 P1-1】给主对话一个"重启后可用的重新认领入口"（这是"被切断后要能恢复"的本体）

> 用户当初拍板的原话是**「被切断后要能恢复」**。`P0-1` 修的是"别再炸"，这一条才是"恢复能力"本身。

| 项 | 内容 |
| --- | --- |
| **改哪个文件** | `lib/store.js`（`open()` 的 `TASK_EXISTS` 分支）+ `lib/tools.js`（`pipeline_task_open`） |
| **改成什么** | ① `store.js:413-416`：`TASK_EXISTS` 不再是无条件 `deny`，拆出一个**认领分支** `store.reattach(taskId)`：任务已存在时，加载它、把它登记进同步索引、返回 `{ ok:true, task, reattached:true }`，而不是报错。<br>② `tools.js:493-508`：`pipeline_task_open` 增加一个显式参数 `reattach: true`（`parameters` 里加一项 `reattach: S('boolean', '★ 认领一张已存在的任务单（重启后恢复用）')`）。`reattach === true` 且任务已存在时走 ①，否则维持现有 `TASK_EXISTS` 行为。<br>③ 在 `reattach` 的返回值里**铸一枚新的 main 令牌**（复用 `tools.js:508` 的 `tokens.mint({ taskId, role: ROLE.MAIN, agentId, note: 'reattach' })`）——这一步是让死锁解开的关键，它同时把本会话绑定为该任务的 main（`mint` 带 `agentId`，`tokens.js:67`）。<br>④ 回复里**显式列出**这张单当前的合法动作，特别是「可以 `cancel`」——避免只暗示"继续跑" |
| **影响面** | 新增一条入口，**不改状态机**（`states.js` 一行不动）、**不改守门判据**、不改任何落盘格式。受影响的只有 `task_open` 一个工具的行为，且只在新参数为 `true` 时改变 |
| **风险** | **低-中**。语义上变成"谁先 reattach 谁就是这张单的主对话"（先到先得）。在多会话并发下这是一个真实的宽松化。<br>**但必须说清：它没有降低任何安全等级。** `pipeline_task_open` 本来就不校验身份——`guard.js:434` 是 `pipeline_task_open: null`，而 `guard.js:655` 对 `null` 的处理是 `return undefined`（放行，交给 execute 内部判），而 `task_open` 的 `execute` 里**完全没有** `resolveActor` 调用（对照 `tools.js:502` 直接硬编码 `actorRole: ROLE.MAIN`）。⇒ **现状是"任何人都能开一张新单并成为它的主对话"**，所以"任何人都能认领一张已存在的单"处于**同一个信任级别**。真正值得保留的不变量是"一个任务同时只认一个主对话会话"，那可以靠覆盖绑定（旧会话的令牌本来就已失效）或检查 `task.history[0].agent` 来保证。<br>另一个可选的收紧：只允许"历史里没有别的活跃 main 绑定"或"任务处于非终态"时 reattach |
| **是否需重启** | 要 |
| **能否离线验证** | **能，纯 store/tools 层单测，不需要跑流水线**。正例：`open(id)` → 清空令牌表（模拟重启）→ `open({ id, reattach:true })` 断言 `ok:true` + 拿到新 main 令牌 + 该令牌能驱动 `pipeline_transition`。反例：不带 `reattach` 的同 id 调用**必须仍然**返回 `TASK_EXISTS`（证明没有悄悄放宽原有语义） |

---

### 【必修 P1-2】老单的自救入口（resume / rebind / 取消 / 同 id 重开）

| 项 | 内容 |
| --- | --- |
| **改哪个文件** | 无新增文件；能力由 `P1-1` 覆盖。可选再加一处工具文案 |
| **改成什么** | 关键是**先纠正一个误判**：`states.js:259` 的 `{ from:'*', event:'cancel', to: ST.CANCELLED, by:['main','human'] }` **一直存在**，「不能取消」不是状态机缺边，而是**身份先没了、走不到状态机**（`guard.js:664-673` 在 `role === null` 时就拒了）。所以 `P1-1` 做完，**取消能力自动恢复**，不需要新增 cancel 路径。<br>建议额外做一件小事：在 `pipeline_task_open` 的 `reattach` 回复里，明确写出三选一——「继续推进 / `pipeline_transition event="cancel"` 取消 / 放着不管」。<br>若还想给"孤儿单"一条**完全继承**的路（连历史一起续上），那也需要 `P1-1`：同一 `task_id` 认领后，`task.json` 里 `state`、`history`、`handoffs` 全都还在（实测孤儿单 `T-20261011-4a2dc7` 的 `state: "analyzing"` 完好），所以**认领即完全恢复**，不会丢任何进度 |
| **影响面** | 无独立影响面（复用 `P1-1`）。仅文案/引导 |
| **风险** | 无 |
| **是否需重启** | 要 |
| **能否离线验证** | 能。用真实的孤儿单 `T-20261011-4a2dc7` 做样例：认领 → `pipeline_transition event=cancel` → 断言 `state === 'cancelled'` 且 `task.json` 落盘 |

**为什么"允许同 task_id 重开"不该做成"直接覆盖"**：`store.js:414` 的 `TASK_EXISTS` 是一条**正确**的保护——静默覆盖会丢掉 `history` / `handoffs` / `artifacts` 全流程审计链，而"可追溯"是这个插件的核心卖点之一。所以正确做法是**认领**（保留全部历史、只换身份），不是**覆盖**。

---

### 【可选 P2-1】堵住重启后的守门 fail-open

| 项 | 内容 |
| --- | --- |
| **改哪个文件** | `lib/guard.js`（判据侧）+ 一处同步索引回填（`index.js`） |
| **改成什么** | 问题的根源是 `guard.js:580-584`：`binding === null` ⇒ 非流水线工具**无条件放行**。而 `binding` 来自内存令牌表（`guard.js:580`）。<br>修法与 `index.js:179` 的 `taskIndex` **完全同构**——那已经是本项目成熟的"落盘 → 内存同步索引"模式（`index.js:168-179` 的注释还诚实写明了"进程重启后、任务被再次加载之前，索引是空的"）。所以：任务被加载时，顺带用 `task.dispatched[].agent_id` **回填**一张 `agentId → { taskId, role, seat }` 的同步映射，供 `guard.js` 在 `tokens.roleOfAgent` 返回 `null` 时回退查询。这样重启后即使令牌表空了，守门仍认得"这个会话曾经是 writer#1" |
| **影响面** | 中等。会影响守门对**所有**会话的判定路径（多一次回退查询）。好处是顺带把"重启后席位脱离守门"这个事故面关掉 |
| **风险** | **中**。① 回填只在任务被加载后发生，所以仍然有一个窗口期（与 `taskIndex` 的既有行为一致，属于已知边界，不是新问题）；② 回填数据来自 `task.dispatched`，而**老任务没有这个字段**（见 `P2-2`），所以对老单无效；③ 语义变化："曾经是席位"变成了"现在仍是席位"——需要明确这是**保守方向**（多拦不少拦），不能反过来削弱现有判据 |
| **是否需重启** | 要 |
| **能否离线验证** | 能。正例：构造一份 `dispatched` 有记录的 task.json → 清空令牌表 → 断言 `writer` 会话的写操作**仍被拦**。反例：无关会话（不在任何 `dispatched` 里）**必须仍然直通**，不得误拦（`guard.js:583` 的原意是"守门只约束流水线参与者"，这条不能破） |

---

### 【可选 P2-2】让失联检测覆盖"派活发生在台账字段之前"的老任务

| 项 | 内容 |
| --- | --- |
| **改哪个文件** | `lib/liveness.js`（`:234`）+ `lib/tools.js`（`:1864`） |
| **改成什么** | 现状是**静默 fail-open**：<br>`liveness.js:234` `const list = Array.isArray(task?.dispatched) ? task.dispatched : []` —— 字段缺失时静默当成"没派过人"。<br>`tools.js:1864` `if (!Array.isArray(t.dispatched) || t.dispatched.length === 0) continue` —— 显式跳过。<br>孤儿单 `T-20261011-4a2dc7` 正是这种：它的 `task.json` **连 `dispatched` 键都没有**（写盘早于该字段）。<br>两种改法（按用户新单验收标准第 6 条"要么补记一次派活时间，要么明确写'这类任务不适用'并给出恢复动作"）：<br>· **补记**：加载任务时，若 `dispatched` 缺失/为空但 `history` 里有 `transition:dispatch_*` 记录，用那条记录的时间补一条台账；<br>· **诚实降级**：不改判据，只在 `pipeline_status` 输出里明确写「本单无派活台账（早于台账字段）⇒ 失联检测不适用」，并给出恢复动作 |
| **影响面** | 小。只影响 "席位失联" 这一个视图与它的自动升级 |
| **风险** | **低**（诚实降级路线风险为零）。若选"补记"，要注意补记出来的 `at_ms` 可能非常旧（老单），会立刻触发失联升级把任务推到 `blocked` —— 这未必是想要的，需要加一个"补记不参与自动升级"的标记 |
| **是否需重启** | 要 |
| **能否离线验证** | 能。用孤儿单样例断言 `pipeline_status` 输出包含"台账不适用"或补记后的席位视图 |

---

### 【不推荐 P3】把令牌表落盘 —— 建议**不要**做

| 项 | 内容 |
| --- | --- |
| **改哪个文件** | `lib/tokens.js`（换实现或加 `createFileBackedTokenStore`）+ `index.js:135`（接线） |
| **为什么列出** | 用户明确问到了"绑定与令牌的持久化，或可重新认领的机制"，所以这条必须正面回答，而不是回避 |
| **为什么不推荐** | 三个理由：<br>① **它会推翻一个明写的安全不变量。** `tokens.js:28-35` 的原文是"内存态 —— 进程重启即失效，**这正是想要的语义**："上一次会话拿过令牌"不构成这一次的通行证。" 落盘等于把这条改成"上次拿过就永久是通行证"。<br>② **`resolve` 是同步的。** 守门 `guardReason` 是同步遍历（`index.js:168-177` 的注释解释了为什么 `taskIndex` 必须是同步的），而 `resolve` 也被同步调用（`guard.js:661`、`tools.js:279`）。落盘只有两条路：每次 `resolve` 都同步碰盘（性能与一致性风险），或内存为主 + 异步写回（**重启后仍有一个窗口丢数据**，等于没彻底解决）。<br>③ **它解决的是错误的问题。** 真正的需求是"用户/主对话在被切断后能重新拿到身份"，而不是"旧令牌必须继续有效"。后者还会带来新问题：令牌永不过期、越积越多、无法安全撤销 |
| **推荐的替代** | **`P1-1`（可重新认领）**。两者都达成"被切断后要能恢复"，但 `P1-1` 不动那个安全不变量，也不需要改同步性假设。**用"身份可重新认领"替代"令牌跨重启存活"** 是这一条的核心建议 |
| **风险（若坚持做）** | 高。安全语义变化 + 同步性假设变化 + 令牌生命周期管理 |
| **是否需重启** | 要 |
| **能否离线验证** | 能（单测），但**验证不了**"这样做是否可接受"——那是一个需要用户拍板的语义取舍，不是技术判据 |

---

### 修复顺序建议

```
P0-1  改 hostmsg.js:43 → 'plugin:dsh-pipeline'          ← 先止血，让会话别再炸
      + 收紧 assertHostMessage + 加自测断言              ← 防回归，必须同时做
P0-2  拆 tokens.js:94-96 的报错文案                      ← 让下一次诊断不用猜
P1-1  store.reattach + pipeline_task_open{reattach:true} ← 真正实现"被切断后要能恢复"
P1-2  reattach 回复里显式给出 cancel 选项                ← 顺手，零风险
───────────────────────────────────────────────────── 以上做完，用户四条现象全部消失
P2-1  guard.js fail-open 回填                            ← 关掉一个事故面（重启后守门失效）
P2-2  liveness 老任务台账处理                            ← 诚实降级即可
P3    令牌表落盘                                          ← 不做，用 P1-1 替代
```

四条现象的闭环对照：

| 现象 | 由哪条修掉 |
| --- | --- |
| 1 身份无法确定 | **P1-1**（可重新认领；**不是** P3） |
| 2 令牌无效或已过期 | **P1-1**（新令牌）+ **P0-2**（文案不再误导） |
| 3 老单成孤儿 | **P1-1**（认领 = 完全恢复，历史进度全在）+ **P1-2**（取消入口可见） |
| 4 format v4 处理失败 | **P0-1**（含防回归配套） |
| （附带）重启后守门失效 | **P2-1** |

---

## E. 没能查清的部分

以下都是**我没能查清**的，如实列出，不编。

1. **`hostmsg.js` 注释里引用的 asar 偏移已经过期。** `hostmsg.js:180` 声称 `@deepseek-ai/dsh-session-reference#prepareDirectMessages` 在 "app.asar @55346974"。我按当前 asar 的偏移约定解析，**55346974 落在 `/dsh/node_modules/@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js` 的文件内偏移 48310**，不是 session-reference。函数 `prepareDirectMessages` 本身**确实存在**于 `dsh-session-reference/lib/index.js`（我按函数名找到了，并且它确实无守卫地读 `message.source.kind`），所以结论不受影响 —— 但那个偏移是**针对另一个 build 记的**，我没能确定它对应哪个版本。

2. **我没有跑过任何一次复现。** 全部结论建立在三样东西上：静态源码阅读、磁盘取证（49 个会话文件全解压校验 + 3 份 `task.json` + `switch.json` + `audit.jsonl`）、以及一个跨插件对照（`dsh-better-sidebar` 的注释与常量）。因此"C.4 里 pipeline 注入的消息确实被 encode 成 `user/message`"这一环，我拿到的证据是**间接的**（`dsh-session-reference` 的投影函数读**已落盘** `user/message` 的 `source.kind`；实测落盘的 `user/message` 行都带 `surfaceOp:"append"`；`agent/pre-step` 的 `decision.messages` 就是这一步的消息列表）。**我没有抓到一次真实的 `encodeEvent` 调用栈。**

3. **我指认不出具体是哪个会话炸的。** 49 个会话里**没有任何一条**持久化了这个错误（这与"encode 阶段就抛、坏行根本没写进去"是自洽的），但也因此我**无法 100% 排除存在第二种触发路径**。我能确定的是：本机 49455 行已落盘数据里，既没有 `"kind":"plugin"`，也没有缺 `source` 的消息。

4. **`app.asar.unpacked` 目录我没有细看。** 只确认了 `libreoffice-kit.exe` 在里面（这也是我一开始偏移映射出错的原因——`unpacked: true` 的条目 `offset` 无意义）。如果那里面还有会影响会话格式的补丁文件，我没查。

5. **我的插件穷尽性扫描只到 3 层深。** 扫的是 `<DSH_HOME>\profiles\desktop\node_modules`（排除 `node_modules` 子目录与 `.bak-*`），命中 `kind: 'plugin'` 的只有 `dsh-pipeline` 与 `dsh-better-sidebar`（后者已修）。如果还有别处（其它 profile、全局安装位置、`app.asar.unpacked` 里的插件）在注入消息，我没有覆盖。

6. **`format v4` 我只看了两个包。** `dsh-session-format-v3-to-v4` 与 `dsh-session-persistence-jsonl`（`lib/index.js` + `lib/worker.cjs`）。基座包 `@deepseek-ai/dsh-session-format` 我**没有展开**——理论上它可能还有一份同语义的校验，我没验证。

7. **我没有验证修复后的实际效果。** 所有"能否离线验证"写的是**可行的验证手段**，不是我**已经跑过**的验证（本轮是只读排查，不许改文件）。特别是 `P0-1` 的第 ② 级验证（把消息喂给 `assertV4MessageSources` 断言不抛）我**没有实际执行**——我确认了它是纯函数、可从 asar 取用，但没有真的 require 它跑一遍。

8. **`sweep()` 静默删除导致"过期"与"从来没有"无法区分这一条，我没找到现成的留痕机制。** `P0-2` 里我给出了两条路（拆 `sweep` 留痕 / 只改文案），但**没有确认**拆 `sweep` 会不会碰到别的假设（比如 `size()`、`list()` 的行为，或自测里对 `sweep` 的断言）。需要动手前再核一遍。

9. **我没有检查 `dsh-session-format-v0-to-v1` / `v1-to-v2` / `v2-to-v3` 这几个迁移链上的包对 `kind` 的处理是否与 v3→v4 一致。** 我只在搜索 `kind: "plugin"` 时顺带看到它们会构造 V3 形态的 `plugin` 包装。如果本机存在更老的会话文件（v0~v2），它们的迁移路径我没有走查。

---

## 附录：本次排查用到的取证命令与关键位置

### A. 读 asar 的正确姿势（无需第三方工具）

```js
const fs = require('fs');
const p = 'D:/tool/Deepseek/Deepseek harness/resources/app.asar';
const fd = fs.openSync(p, 'r');
const pre = Buffer.alloc(16); fs.readSync(fd, pre, 0, 16, 0);
const jsonLen = pre.readUInt32LE(12);            // 本机实测 3392048
const hb = Buffer.alloc(jsonLen); fs.readSync(fd, hb, 0, jsonLen, 16);
const header = JSON.parse(hb.toString('utf8'));
const dataStart = 16 + jsonLen;                  // 本机实测 3392064
const files = [];
(function walk(node, pp) {
  for (const [k, v] of Object.entries(node.files || {})) {
    if (v.files) walk(v, pp + '/' + k);
    else files.push({ path: pp + '/' + k, offset: Number(v.offset || 0), size: v.size, unpacked: !!v.unpacked });
  }
})(header, '');
// ⚠️ 必须过滤 unpacked：它们的 offset 无意义
const packed = files.filter((f) => !f.unpacked).sort((a, b) => a.offset - b.offset);
function read(path) {
  const f = packed.find((x) => x.path === path);
  const b = Buffer.alloc(f.size);
  fs.readSync(fd, b, 0, f.size, dataStart + f.offset);
  return b.toString('utf8');
}
```

偏移校验：最后一个打包文件 `offset + size` 恰好等于 asar 文件总长（本机 121348951）⇒ 偏移约定正确。

### B. 解多帧 zstd 会话文件的正确姿势

会话 `.jsonl.zstd` 是**多帧**的（每追加一次一个新 frame）。`zlib.zstdDecompressSync` 与 `zlib.createZstdDecompress()` **都只解第一帧** —— 我第一次就中招（某文件 3041 字节只解出 291 字节、1 行，误判成"会话是空的"）。

```js
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
function decodeAll(buf) {
  const st = []; let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { st.push(i); i += 4; }
  const parts = [];
  for (let k = 0; k < st.length; k++) {
    const seg = buf.subarray(st[k], k + 1 < st.length ? st[k + 1] : buf.length);
    try { parts.push(zlib.zstdDecompressSync(seg)); } catch (e) { /* 跳过错帧 */ }
  }
  return Buffer.concat(parts).toString('utf8');
}
```

完整性自检：解出后逐行 `JSON.parse`，**0 行失败**才算解全（本机 49 文件 / 49455 行 / 0 失败）。

### C. 关键位置速查表

| 位置 | 说明了什么 |
| --- | --- |
| `lib/hostmsg.js:43` | **`HOST_SOURCE_KIND = 'plugin'` —— 本次 format v4 的根因** |
| `lib/hostmsg.js:116-133` | `hostMessage()` 构造 `source`（`:119` 写入 kind，`:120` 写入 plugin） |
| `lib/hostmsg.js:185-187` | 校验只查 `kind` 非空、**不查取值** ⇒ 现有自测守不住这个 bug |
| `lib/hostmsg.js:8-24` | 上一个事故（无 `source` ⇒ TypeError ⇒ 277ms 秒死）的现场记录 |
| `lib/intercept.js:342` / `:364` | 两个注入点，塞进 `decision.messages` |
| `lib/intercept.js:376-380` | 注入实现（`messages: [...downstream.messages, ...extra]`） |
| `lib/tokens.js:28-35` | "内存态…这正是想要的语义"（绑定/令牌不落盘的出处） |
| `lib/tokens.js:41` | 令牌表本体（`new Map()`） |
| `lib/tokens.js:44-47` | `sweep()` 静默删除过期项 ⇒ 无法区分"过期"与"从来没有" |
| `lib/tokens.js:59` | 令牌是随机串，**无签名无密钥** |
| `lib/tokens.js:68-69` | TTL 是**相对**时间（`expiresAt = t + ttlMs`） |
| `lib/tokens.js:94-96` | 把"表里没有"与"已过期"合并的误导文案 |
| `lib/tokens.js:151` | 绑定的实现（`rec.agentId = agentId`，写在内存记录上） |
| `lib/tokens.js:156-165` | `roleOfAgent()` 遍历内存 Map |
| `lib/store.js:413-416` | `TASK_EXISTS` 硬唯一，无认领分支 |
| `lib/store.js:507` | `dispatched[].token` 记录了令牌明文（但只写不读） |
| `lib/store.js:512` | `dispatched: []` 字段定义 |
| `lib/store.js:618-627` | `recordDispatch()` → `persist()` |
| `lib/states.js:259` | `cancel` 边**一直存在**（"不能取消"不是状态机的错） |
| `lib/guard.js:434` | `pipeline_task_open: null` ⇒ 开单**不校验身份** |
| `lib/guard.js:580-584` | `binding === null` ⇒ 非流水线工具无条件放行（fail-open 事故面） |
| `lib/guard.js:704` | 整个写权限判据挂在 `binding !== null` 上 |
| `lib/guard.js:655` | `null` ⇒ `return undefined`（放行） |
| `lib/guard.js:664-673` | 身份为 null 时的拒绝文案（现象 1 的原文出处） |
| `lib/tools.js:273-305` | `resolveActor()`：绑定优先于令牌；都无 ⇒ 报"身份无法确定" |
| `lib/tools.js:508` | 开单时铸 main 令牌 |
| `lib/tools.js:1611-1614` | `pipeline_bind_role` **先 resolve 再 bind** ⇒ 死锁所在 |
| `lib/tools.js:1864` | 失联检测显式跳过无台账的任务 |
| `lib/liveness.js:234` | `dispatched` 缺失静默当空 ⇒ fail-open |
| `lib/config.js:19` / `:87` / `:169` / `:176` | `guardEnabled: true` / `intercept: true` / `tokenTtlMs: 2h` / `registerPromptSection: true` |
| `index.js:135` | `createTokenStore` 装配处（无持久化） |
| `index.js:168-179` | `taskIndex` 的"落盘 → 内存同步索引"模式（P2-1 的范本） |
| `README.md:510` | 「状态存在哪 / 重启后还在吗」—— **只讲了开关**，没讲令牌/绑定/孤儿单 |
| `README.md:401` | "安装 / 卸载 / 改配置需要重启 DSH" |

| DSH 本体位置（asar 内路径） | 说明了什么 |
| --- | --- |
| `/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js` | 报错字符串源头（文件内偏移 ~5306，`source()` 函数） |
| `/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs` | 同份校验的打包副本 + `releasedV4SessionFormatCodec.encodeEvent`（写路径） |
| `/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` | `consumeEventLine` / `finish()`（读路径） |
| `/dsh/node_modules/@deepseek-ai/dsh-session-reference/lib/index.js` | `prepareDirectMessages`（无守卫读 `source.kind`）+ `projectSessionConversation` |
| `/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js` | `preStep()`：`agent/pre-step` waterfall 的发起处 |
| `node_modules/dsh-better-sidebar/lib/index.js` | **同机对照：正确的 `plugin:<name>` 形态与踩坑注释** |

---

*本文档为只读诊断产物。除本文件外，未修改任何文件；未重启 DSH；未打开「多AI 协调」开关；未运行任何流水线任务。*
