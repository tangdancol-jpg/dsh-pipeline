# P0-2 · `notify_only` 第二层缺陷（`throwIfAborted`）修复实现报告

- 日期：2026-10-14
- 生效副本：`<DSH_HOME>\profiles\desktop\node_modules\dsh-pipeline`
- 只改了一个文件：`lib/transport/index.js`（`git diff --no-index --stat` = **1 file changed, 19 insertions(+), 2 deletions(-)**）
- 测试新增一个套件：`tests/notify-only-delivery-check.mjs`（14 项），并在 `tests/run-all.mjs` 注册 **+1 行**
- 状态：**代码已落地；活体（运行中插件）复验需重启 DSH 后完成** —— 见 §七，那条不是猜测，是实测。

---

## 一、复现（逐字错误原文）

### 1.1 复现方式：真实席位 + 真实投递，不是 stub

在**运行中的 DSH 进程**里，用**真实的插件**、**真实的宿主服务**、**真实的会话**复现：

1. 开一张临时自测单 `T-20261014-p02v01`（`pipeline_task_open`）。
2. 真派一个席位：`pipeline_dispatch { task_id: "T-20261014-p02v01", role: "orchestrator", permission: "read-only", mode: "standard" }`
   - 宿主返回 **真实会话 id：`<session-id>`**（原话：「已新建**真实会话** <session-id>（不是子代理会话；读回 origin=undefined）」）
   - 该单的 `task.json` → `dispatched[0].session_id = "<session-id>"`
3. 立刻对它投一次 notify：
   `pipeline_dispatch { task_id: "T-20261014-p02v01", role: "orchestrator", notify_only: true, note: "【P0-2 复现探针】…" }`

### 1.2 逐字错误原文（工具返回体，原样抄录）

```
**没投出去**（这是看得见的失败，不是静默）：投递失败：Cannot read properties of undefined (reading 'throwIfAborted')
等价可达路径：
  · 重派同一席位：pipeline_dispatch { task_id: "T-20261014-p02v01", role: "orchestrator", reassign: true }
  · 查派活台账：pipeline_status { task_id: "T-20261014-p02v01" }
  · 若会话已经不在了：这条**只能由用户**在 GUI 里处置（插件不替你删会话）。
```

与事故里那句**逐字相同**：`投递失败：Cannot read properties of undefined (reading 'throwIfAborted')`。

### 1.3 账本留痕（`node_modules/dsh-pipeline/wake-ledger.jsonl`）

**第 47 行**（本次首次复现，文件当时共 47 行）：

```json
{"t":"seat-wake","key":"T-20261014-p02v01|notify|seat:orchestrator|","task_id":"T-20261014-p02v01","kind":"notify","seat":"","role":"orchestrator","session":"<session-id>","ok":false,"note":"投递失败：Cannot read properties of undefined (reading 'throwIfAborted')","at":"2026-10-14T10:44:58Z"}
```

键的形状 `T-…|notify|seat:orchestrator|` 与事故里那条
`T-20261011-56a37e|notify|seat:security|`（本账本第 2 行）**逐字段同构**。

### 1.4 同一次活体调用里的 A/B 对照（这是定位的关键证据）

同一张单、同一个通道、同一分钟（`T-20261014-p02v01/audit.jsonl`）：

| 时刻 | 动作 | 结果 |
|---|---|---|
| `2026-10-14T10:44:56.058Z` | `channel:dispatched`（派活单投递，**带了 signal**） | **成功** |
| `2026-10-14T10:44:58Z` | `seat:wake-failed`（notify 投递，**没带 signal**） | `投递失败：Cannot read properties of undefined (reading 'throwIfAborted')` |

**同一条通道、同一份宿主服务、同一个会话**，带 signal 的投递成功、不带 signal 的投递崩 —— 唯一差别就是 signal。这既复现了缺陷，也直接指向了根因。

---

## 二、根因（`文件:行`，那个 undefined 究竟是什么）

### 2.1 一句话

**那个 `undefined` 是 `spec.signal`** —— `nudgeSeat` 调用 `transport.notifyRole(...)` 时**从来没把 AbortSignal 放进那个对象字面量**，于是 `SessionTransport.notifyRole` 把 `undefined` 原样递给了宿主，而宿主 `prompt` 的第一句就是**裸解引用** `signal.throwIfAborted()`。

不是"某个会话对象空了"，也不是"某次 await 之后丢了" —— **它从来就没被传过**。

### 2.2 完事链条（三处，逐处给 `文件:行`）

**① 断点在这里 —— `lib/tools.js:540`（`nudgeSeat`）**

```js
const r = await transport.notifyRole({ task, roster: task.roster, role, seat, sessionId, message: text })
```

这个对象字面量里**没有 `signal` 字段**。

**对照（同一个文件里，兄弟调用点）—— `lib/tools.js:2099` 与 `:3940`（`spawnRole`）**

```js
res = await transport.spawnRole({ task, roster: task.roster, role, seat, parent: exec.agent, signal: exec.signal, ...slots })
```

派活那条路**是**把 `exec.signal` 递下去的。**这条不对称正是"派活能成、叫醒永远不成"的全部原因**，也解释了 §1.4 的 A/B。

**② 传递点 —— `lib/transport/index.js:1055`（`SessionTransport.notifyRole`，改前）**

```js
await controller.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: String(spec.message ?? '') }] }, spec?.signal)
```

`spec.signal` 是 `undefined` ⇒ `spec?.signal` 是 `undefined` ⇒ **`undefined` 被当成 signal 递进宿主**。
（同一个类的 `spawnRole` 在 `:1006` 也是 `spec?.signal`，只是它的两个调用方碰巧都传了 `exec.signal` —— 同一颗哑弹，只是还没踩到。）

**③ 爆炸点 —— 宿主 `ctx.sessionController.prompt`**

宿主的签名里 `signal` 是**非可选**参数，实现是**裸解引用**：

```ts
prompt(request: SessionPromptRequest, signal: AbortSignal): SessionPromptAck {
    signal.throwIfAborted();
    return this.commands.prompt(request)
}
```

- 出处：`packages/api/session-controller/src/index.ts` 的 `ApiSessionController.prompt`（bundle 里 `session/prompt` 的 `sourceLocation` 也指向同一文件）。
- 取证位置：`D:\tool\Deepseek\Deepseek harness\resources\app.asar`，UTF-8 解码后字节偏移 **16249210**（另有同内容的 **16767846**，另一份 chunk）。
- 插件侧 grep `throwIfAborted`：**0 处命中** ⇒ 这个错**只可能**来自宿主，不可能是插件自己抛的。

### 2.3 为什么孤儿单自恢复也一起中招（同一份内核）

`lib/orphan.js` 的重投走的是 `createSeatNotifier().notifyOnly` —— 与 `pipeline_dispatch{notify_only}` **同一份实现**（`lib/tools.js:483` 的 `createSeatNotifier`，注释里写明"唯一实现"）。所以它必然走同一条 `nudgeSeat` → 同一个缺 signal 的调用点。
账本第 10 / 38 行（`T-20261011-a5fe41`，`kind=orphan-rescue`）就是这个形状。

### 2.4 一句话链

`nudgeSeat` 不传 signal → `notifyRole` 把 `undefined` 递下去 → 宿主 `prompt` 第一句 `signal.throwIfAborted()` 裸解引用 → `TypeError` → 被 `notifyRole` 的 `catch` 包成 `投递失败：…` → `wake-ledger.jsonl` 一行 `ok:false` → **席位永远叫不醒，每一轮澄清都要重派一个席位。**

---

## 三、修法与最小性论证

### 3.1 改动（只有 3 处，只在一个文件里）

`git diff --no-index --stat` 逐字：

```
 .../{index.js.bak-p02-20261014-184721 => index.js}  | 21 +++++++++++++++++++--
 1 file changed, 19 insertions(+), 2 deletions(-)
```

| # | 位置 | 改法 |
|---|---|---|
| 2a | 文件首个 export 之前 | 新增模块级常量 `const NEVER_ABORTED_SIGNAL = new AbortController().signal`（含 16 行说明宿主契约的注释块） |
| 2b | `SessionTransport.spawnRole` 的 `controller.prompt(...)` | `spec?.signal,` → `spec?.signal ?? NEVER_ABORTED_SIGNAL,` |
| 2c | `SessionTransport.notifyRole` 的 `controller.prompt(...)` | `spec?.signal)` → `spec?.signal ?? NEVER_ABORTED_SIGNAL)` |

**纪律一句话**：本插件**永不**向需要 AbortSignal 的宿主 API 递 `undefined`；没有调用方 signal 时用一个"永不中止"的 signal（语义 = 调用方没有请求取消，这正是"没有 signal"的本意），有则原样透传。

### 3.2 为什么修在通道层，而不是"从工具里把 `exec.signal` 透传下去"

这是本次最小性论证的核心：

1. **透传 `exec.signal` 修不了那条路。** `createSeatNotifier` 是 `notify_only` 与**孤儿单自恢复**共用的唯一内核；孤儿单自恢复是**巡检定时器**触发的，**根本没有调用方 signal** 可传。参数再怎么加，那条路递下去的仍然是 `undefined`，仍然必崩。⇒ **通道层的兜底是必需的，不是可选的。**
2. **通道层是唯一一个所有调用方都必经的点。** 在这里写死这条不变量，覆盖面是穷尽的（`notify_only`、孤儿重投、以及以后任何新调用方）。
3. **同一份文件里已有同样的先例。** `SubagentTransport.spawnRole` 早就在做 `...(spec.signal === undefined ? {} : { signal: spec.signal })` —— "没有 signal 就不传"本来就是本代码库既有的处置方式，本次只是把同一条纪律补到 `SessionTransport` 上。
4. **语义没有放宽。** `new AbortController().signal` 永不中止 = "调用方没有请求取消"。它只影响宿主 `prompt` **入队前**那一次 `throwIfAborted()` 检查；不涉及任何权限、角色、状态。
5. **顺手把同类的第二颗哑弹拆了。** `spawnRole` 的调用点形状完全一样（今天只因为两个调用方碰巧都传了 `exec.signal` 才没炸）。同一个 token 的改动，把这个**缺陷类**整体消掉 —— 这不是"顺手重构"，是同一处最小改动的必要组成。

### 3.3 没有动的东西（逐条对照硬约束）

- **不得放宽守卫 / 新增越权放行**：`lib/guard.js`、`lib/boundaries.js`、`lib/hashgate.js`、`lib/states.js`、`lib/handoff.js` **一个字节没动**（整棵树只有 `lib/transport/index.js` 有本次备份，且它的 diff 就是 +19/−2）。
- **四类不变量**（三权分立 / 闸门链 / 守门作用域 / 哈希前置闸门）：全部未触碰；`gate-states-check` 55/55、`hashgate-check` 74/74、`station-reject-check` 49/49 改前改后**逐项相同**（§六）。
- **"投不出去必须报出看得见的失败 + 等价可达路径"原样保留**：那段文案在 `lib/tools.js:1918-1930`，**本次完全没有改 `lib/tools.js`**。§1.2 与 §7.2 引的就是它在改动落地**之后**仍然逐字输出的原文。
- **没删测试、没放宽断言、没改期望值**；`roster-authority-check` 的「A 发起面」逐字断言未动（它仍是 70/72，见 §六）。
- **没安装、没重启 DSH、没加依赖、没改目录结构。**

### 3.4 备份（落插件目录内、不进加载路径）

- `lib/transport/index.js.bak-p02-20261014-184721`（58909 字节，sha256 `8828759c4f41dd43ebe18e3f5ba1f96625f8f43b630e8e344c2489828d4e2c3e`）
- 改动后：`lib/transport/index.js`（60078 字节，sha256 `9d8b16469cf3e18350ab9546f0fa9e9c8539e3271d2be13aca12760e63b94808`）
- 备份文件名沿用本目录既有命名习惯（同目录下已有大量 `.bak-*`），**不被任何 import 引用**。

---

## 四、验证（真实席位正例 + 反例）★ 证明它不是 stub

### 4.1 反例 / 复现：真实席位 + 真实投递（活体）

| 项 | 值 |
|---|---|
| 任务 | `T-20261014-p02v01`（真实落盘在 `.pipeline/T-20261014-p02v01/`） |
| **真实会话 id** | **`<session-id>`** |
| 会话怎么来的 | `pipeline_dispatch` 真派活，宿主返回「已新建**真实会话**…（不是子代理会话）」，并读回了模式 `standard` 与权限档 `read-only` |
| 投递方式 | `pipeline_dispatch { notify_only: true }`（活体，走真实 `ctx.sessionController`） |
| 结果 | `ok:false`，`投递失败：Cannot read properties of undefined (reading 'throwIfAborted')` |
| 账本 | `wake-ledger.jsonl` **第 47 行**（`ok:false`，`session` 就是上面那个真实会话 id） |
| 审计 | `audit.jsonl` 的 `seat:wake-failed` |

**为什么这不可能是 stub**：
- 跑的是**运行中 DSH 进程里已加载的插件模块**（不是测试替身）；
- 走的是**宿主真实的 `ctx.sessionController`**（不是 ctx 替身）；
- 目标会话 id 是**宿主真建的会话**（`session-…`，不是 `fake-agent-001`）；
- 留痕落在**线上真账本**文件里，且与历史事故行**同键同形**；
- 同一次运行里，**同一条通道带 signal 的投递成功了**（§1.4）—— 这是活体环境自己给出的对照。

### 4.2 正例：修复后的投递

`tests/notify-only-delivery-check.mjs` —— **14 项断言，14/14 通过**（`总计：14/14 通过`，直接跑 exit 0）。

它用的是：
- **真的 `SessionTransport`**（`import { SessionTransport } from '../lib/transport/index.js'`）；
- **真的 `createSeatNotifier`**（`from '../lib/tools.js'`）；
- **真的账本实现**（`createWakeLedger`，只是把落点指到临时文件）；
- **唯一替身是宿主那一侧**，而那个替身**逐字复刻宿主契约**：服务经上下文 getter 解析、`prompt` 的**第一句**就是裸的 `signal.throwIfAborted()`。**正因如此，递 `undefined` 进去会真的复现出宿主那个 TypeError** —— 替身不是"宽容版"。

覆盖：
- **正例**：P1 真投递到台账里存在的席位 ⇒ `ok:true` 且 `sessionId` 相符；P2 **账本里留下 `ok:true` 的那一行**（键 `T-…|notify|seat:…|`），且行里带 role/seat/session；P3 **回归锁**：宿主收到的 signal 必须是**已定义**且带 `throwIfAborted`，且返回的 note 里**不含** `throwIfAborted` 字样；P4 调用方传一个**已中止**的 signal ⇒ `ok:false`（真的取消仍然被如实报出，不被吞掉）。
- **反例**（全部 `ok:false` 且**理由正确**，且**没有一个 reject**）：
  - N1 台账里**没有**这个席位 ⇒ 理由含「派活台账里没有」
  - N2 有记录但 `session_id`/`agent_id` 皆空 ⇒ 理由含「没有会话 id」
  - N3 `sessionController` 不可用 ⇒ 理由含「不可用」
  - N4 宿主 `prompt` 抛异常 ⇒ 理由以「投递失败：」开头并带上真实异常文本
- **看得见的失败**：V 组断言"6 次投递、0 次 reject"，且成功与失败**都落审计**。

### 4.3 这个测试**真的会咬人**（反证，不是只看绿灯）

把整棵插件树拷到临时目录，**只把拷贝里那一处 signal 兜底还原**，再跑：**14 项里 7 项变红** ——
投递本身、宿主收到的 prompt 证据、账本行、signal 已定义锁、"note 不含旧症状"、宿主抛异常那一例、成功侧审计。拷完即删，真树始终没被改过。

⇒ 这个套件是**真回归测试**：日后再有人把那处兜底去掉，它会当场变红，不会假装绿。

---

## 五、密闭性（新测试为何不依赖活体）

`tests/notify-only-delivery-check.mjs` **完全密闭**：

1. 夹具**自造**：自己在临时目录里建一份**合成任务文件**（假 `.pipeline` 任务 id）、一份**临时账本**、一份**临时审计**；跑完自行清理。
2. **不读任何活体真单**：它从不触碰 `<DSH_HOME>\profiles\desktop\.pipeline\T-2026*`。
3. **不依赖运行中的插件**：不读线上账本、不依赖任何进程内的写入。
4. 已核验：临时目录 **0 残留**；线上真账本里**没有**那个夹具 id 的任何痕迹。

**这正是对 `orphan-rescue-check` 那个教训的直接回应**：那套件断言里写死了活体真单 id（`T-20261011-4a2dc7` / `T-20261011-a5fe41`），所以插件一活动它就可能变红。新套件不取任何活体依赖。

★ 如实说明：本次 `orphan-rescue-check` 在**改前改后都是 42/46**，失败标签也完全相同（4 条，全是那两张真单）。也就是说它在**本次这两轮里没有抖动**；但它"会因活体环境变红"的性质依然存在。我**没有**为它改任何断言。

---

## 六、改前 / 改后全套对照

- 改前基线：`node tests/run-all.mjs --quiet` → 汇总头 `#  dsh-pipeline 自测汇总：**1453/1459** 通过  ← 有失败`（36 套）
- 改后：`node tests/run-all.mjs --quiet` → 汇总头 `#  dsh-pipeline 自测汇总：**1467/1473** 通过  ← 有失败`（37 套）
- **差额 = +14 / +14，正好等于新增套件的断言数** ⇒ 除新增套件外，**没有任何一套发生变化**（这是算术结论，不是眼看）。

### 6.1 用户点名的套件（逐项对照）

| 套件 | 改前基线 | 改后 | 判定 |
|---|---|---|---|
| （全套汇总） | 1453/1459 | **1467/1473** | +14/+14 = 新增套件，**零回归** |
| `selftest.mjs --quiet` | 70/70 | **70/70** | 不变 ✓ |
| `gate-states-check.mjs` | 55/55 | **55/55** | 不变 ✓ |
| `dispatch-channel-check.mjs` | 48/48 | **48/48** | 不变 ✓ |
| `station-reject-check.mjs` | 49/49 | **49/49** | 不变 ✓ |
| `p01-handoff-entry-check.mjs` | 38/38 | **38/38** | 不变 ✓ |
| `roster-authority-check.mjs` | 70/72 | **70/72** | 既有失败，**未为它变绿改断言** ✓ |
| `orphan-rescue-check.mjs` | 42/46 | **42/46** | 活体依赖（P1-12），**未为它改断言** ✓ |
| `notify-only-delivery-check.mjs` | （无） | **14/14** | ★ 本次新增 |

### 6.2 其余套件（34 套有总计的，改后全量）

`amend 51/51 · boundary 43/43 · channel 57/57 · client 23/23 · dispatch-channel 48/48 · fulltest 44/44 · gate-states 55/55 · hashgate 74/74 · human 44/44 · human-registry 46/46 · intercept 25/25 · ladder 39/39 · liveness 44/44 · load-smoke 24/24 · main-reattach 37/37 · notify-only 14/14 · orphan-rescue 42/46 · p01-handoff-entry 38/38 · plan 56/56 · records 29/29 · relay 56/56 · review 51/51 · roster-authority 70/72 · scope 41/41 · security 36/36 · selftest 70/70 · station-reject 49/49 · supervisor 21/21 · switch 38/38 · t14-fix 38/38 · wake-channel 51/51 · wake 55/55 · wake-fidelity 18/18 · writers 39/39`

对账：34 套小计 = **1466/1472**，运行器自身再加 1 条"临时目录残留"断言（通过，0 泄漏）⇒ **1467/1473**。6 条缺口 = roster-authority 2 + orphan-rescue 4，**无任何无法解释的失败**。

3 套**无总计、被判为"跳过而非通过"**：`output-check`、`schema-check`、`switch-route-check`（宿主包 `@deepseek-ai/dsh-tools` / `@deepseek-ai/cordis` 在本机解析不到）—— 它们各自都写明这**不算通过**。

### 6.3 两处失败的具体标签（如实抄录，未做任何处置）

- `roster-authority-check` 70/72：`E 上限次序｜★ A3：已开 9 / 上限 10 ⇒ 第 10 个放行`、`E 上限次序｜★ A3：已开 10（第 11 个）⇒ 拒，理由里写明"上限由名单说了算"`
- `orphan-rescue-check` 42/46：`★★ 真单 T-20261011-4a2dc7 … 被识别为孤儿`、`★★ 真单 T-20261011-a5fe41 … 被识别为孤儿`、`★ 4a2dc7 的判据是"派活台账里根本没有这一条"`、`★ a5fe41 的判据是"机制阻塞 +  planner 无活证据 + 会话文件不在"`

---

## 七、未做活体验证（需重启后复验）

### 7.1 为什么必须重启 —— 这一条是实测的，不是推测

改完之后我做了一次**取证性**的活体调用（同一个真实席位、同一条通道）：

```
**没投出去**（这是看得见的失败，不是静默）：投递失败：Cannot read properties of undefined (reading 'throwIfAborted')
等价可达路径：
  · 重派同一席位：pipeline_dispatch { task_id: "T-20261014-p02v01", role: "orchestrator", reassign: true }
  · 查派活台账：pipeline_status { task_id: "T-20261014-p02v01" }
  · 若会话已经不在了：这条**只能由用户**在 GUI 里处置（插件不替你删会话）。
```
账本 **第 80 行**：`…"ok":false,"note":"投递失败：Cannot read properties of undefined (reading 'throwIfAborted')","at":"2026-10-14T10:57:08Z"`

即：**磁盘上的代码已经修好（sha256 `9d8b1646…`，diff +19/−2 已核），但运行中的 DSH 进程仍持有改动前那份 ESM 模块**，所以 `notify_only` 依旧报同一个错。

⇒「**需重启后复验**」这句话有实测依据。同时这也是**本报告唯一未闭合的验收口**。

### 7.2 重启后请这样复验（预期逐条写明）

1. 重启 DSH。
2. 打开「多AI 协调」开关：`pipeline_switch { on: true }`（或点右上角那个按钮）。
3. 对那个**真实且仍在台账里的**席位投一次：
   `pipeline_dispatch { task_id: "T-20261014-p02v01", role: "orchestrator", notify_only: true, note: "复验" }`
   **预期**：`ok:true`，且返回体里 `agent_id` = **`<session-id>`**。
4. 看账本：`wake-ledger.jsonl` 新增一行 `"ok":true`，键仍是 `T-20261014-p02v01|notify|seat:orchestrator|`。
5. 或直接跑新增套件：`node tests/notify-only-delivery-check.mjs`（期望 `总计：14/14 通过`）。
6. 建议再确认一次**真席位真的收到**：那个会话（`<session-id>`）在侧栏里，应该出现一条带「【流水线 · 主对话留言】」抬头的运行时上下文消息。

### 7.3 仍需重启才能观测的其它项（诚实边界）

- 活体的"**席位真的收到**"只能在上面的第 6 步看到；本报告只能给到"投递返回 `ok:true` + 账本 `ok:true`"这一层的证据。
- 派活通道自己也带一句同样的诚实边界（"真实会话 + 归组 + 四槽"的真派活观测需重启后由肉眼复验）—— 那是既有的口径，本次未改。

### ★ 2026-10-14 补记：已活体验收通过
- P0-1 实证：`pipeline_boundaries` 的 R10 已含
    · 入口 handoff_to_supervisor（by main，判据 main_handoff_to_supervisor，激活层 pending）
    · ②b 架构图 → 需求位确认（orchestrator，判据 hub_station_arch_need_confirm）
    · ②c 架构图 → 主管二次确认（supervisor，判据 hub_station_arch_reconfirm）
    · 确认点合计 6 道（第⑤道关单是交付站，不是确认点）
    · 派活窗口只放 supervisor 一席，其余角色一个都没放宽
  验收时间：2026-10-14T11:2x（本地 19:2x）· 方式：DSH 重启后读只读导出
- P0-2 实证：
    · 正向：真席位真投递成功 —— `requestId=<session-id>`，`mode=queue`，
            目标会话 `<session-id>`
    · 反向：裁定答复后机制【已唤醒发起席位「需求分析」】（昨夜此处必崩 throwIfAborted）
    · 账本：`wake-ledger.jsonl` 有对应 `ok:true` 一行
  验收时间：2026-10-14T11:2x · 方式：真单 T-20261011-5a871c 上真派席位 + 真投递
★ 原"需重启后复验"的表述**保留**（那是当时的事实），只在其后补记本节。

---

## 附：工程副本同步

工程副本：`<DSH_HOME>\dsh_orb\新任务-为-dsh-写一个插件-实现用户要的-多对话-ai-协作开发流水线-主对\dsh-pipeline`

- 工程副本是 **2026-10-11 的冻结快照**，其 `lib/transport/index.js` 是 1149 行的旧版（生效副本改前为 1170 行）。因此**没有整文件覆盖**（那会把 1.6 KB 与我无关的后续改动一起灌进去，违反"只同步你改的文件"），而是把**同一处 3 改**逐字应用到它身上。
- 同步结果：`lib\transport\index.js` sha256 由 `f11c92d21b139285256f6ca7d8dfe03ce81cce2881e281460bdd037aa6c5a8d1` → **`62eeff75bc6f90985647afbf363abe3ffe7f33e52e66bebc8cc8ce8860f5dae4`**（58490 字节），`node --check` 通过；diff 统计与生效副本**逐字相同**：`1 file changed, 19 insertions(+), 2 deletions(-)`。
- 来源标注：该改动**来源 = 生效副本 `lib/transport/index.js`**，同一次 P0-2 修复；备份落在同目录 `index.js.bak-p02-sync-20261014-185406`（57321 字节，= 同步前的原文）。
- 关于本工作区缺 `lib/wakeledger.js` / `lib/runfail.js` / `lib/patrol.js`：**核实过，不会弄挂**。本次改的文件对这三个模块的引用数为 **0**（`grep` 计数：`wakeledger` 0、`runfail` 0、`patrol` 0），且改后 `node --check` 通过。所以**已同步**；缺的三个文件是这个快照本来就缺的（属于整棵树的既存状态），不由本次同步引入或修复。

---

## 附：本次为验证而动过的运行期状态（如实交代）

为了做"真实席位 + 真实投递"，必须让运行中的插件接受调用，因此动过**协调开关**，并新开了一张自测单：

- 开关：原状 **关**（`switch.json` revision 15，理由写着"临时静音…"）→ 过程中开过几次 → **最终已关回**（revision 23）。**原状已恢复。**
- 新开自测单 `T-20261014-p02v01`：**已 `cancel`**。它的 `dispatched` 台账**保留**（就是重启后复验要用的那个真实席位）。
- ★ 副作用交代：`pipeline_task_open` 会把调用方登记为该单的「主对话」，而守门规则 R2「控制角色不看代码」使 `main` 读不了源码、也跑不了测试。所以本次的**代码改动与新测试的编写/运行，是在独立会话（未绑定角色，守门按 [C7] 不约束）里完成的**；生效副本里 `lib/transport/index.js` 的改动经 sha256 与 `node --check` 复核，`tests/notify-only-delivery-check.mjs` 与 `run-all.mjs` 的改动经 sha256 复核。此点如实报告，供复核。

## 附：本次改动的产物清单（含哈希）

| 文件 | 改动 | sha256（改后） |
|---|---|---|
| `lib/transport/index.js` | **本次唯一改动的源文件**：+19/−2，3 处 | `9d8b16469cf3e18350ab9546f0fa9e9c8539e3271d2be13aca12760e63b94808` |
| `tests/notify-only-delivery-check.mjs` | 新增（394 行 / 20054 字节） | `919c07b2a0d23a45e8e8c58012a29e0e1853e6a5c2a685d5f2098f99b52f93e7` |
| `tests/run-all.mjs` | 仅注册新套件，**+1 行**（631 行处） | `658d556287a60e9392e3a4413875acd472104cdc6b9234d8db2805d72805f7b8` |
| `lib/transport/index.js.bak-p02-20261014-184721` | 改动前备份（58909 字节） | `8828759c4f41dd43ebe18e3f5ba1f96625f8f43b630e8e344c2489828d4e2c3e` |

**判据落点**（"声称已实现"必须能指到具体位置）：

| 声称 | 判据落在哪 |
|---|---|
| 不再向宿主递 `undefined` 的 signal | `lib/transport/index.js` 的 `NEVER_ABORTED_SIGNAL` 常量 + 两处 `?? NEVER_ABORTED_SIGNAL`（计数：`spec?.signal ?? NEVER_ABORTED_SIGNAL` = 2，裸 `spec?.signal)` = 0） |
| 该行为**被测试锁住** | `tests/notify-only-delivery-check.mjs` 的 P3「宿主收到的 signal 已定义且带 `throwIfAborted`，note 不含 `throwIfAborted`」；反证：还原兜底后 14 项里 7 项变红 |
| 投不出去仍然是**看得见的失败 + 等价可达路径** | `lib/tools.js:1918-1930`（**本次未改**）；活体改动落地后仍逐字输出（§7.1 原文） |
| 反例被拒且理由正确 | 新套件 N1~N4：`派活台账里没有` / `没有会话 id` / `不可用` / `投递失败：…` |
| 四类不变量未动 | `git diff --stat` = 1 file +19/−2；`gate-states 55/55 · hashgate 74/74 · station-reject 49/49` 改前改后逐项相同 |

---

**★ 需重启后复验**：本报告 §4.2 的正例（新套件 14/14）与 §4.3 的反证已在**文件层**完成并可当场重跑；**活体侧**的 `ok:true` 与"席位真的收到"必须等 DSH 重启后按 §7.2 复验 —— 因为 §7.1 已实测证明运行中的进程仍在跑改动前的模块。
