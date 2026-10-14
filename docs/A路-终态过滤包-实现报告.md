# A 路 · 终态过滤包 —— 实现报告

**包名**：A 路 · 终态过滤包（P0-3 活锁 + P2-11 刷屏 + P2-12 噪音收敛 **＋ 追加：席位交付后停住 ⇒ 补上/播报那一步**）
**改动文件（独占，仅此两个）**：`lib/patrol.js` · `lib/wakeledger.js`
**新增验证**：`tests/terminal-filter-check.mjs`（可独立跑）+ `tests/_a2-ab-probe.mjs`（一次性 A/B 探针，`_` 前缀不参与 `run-all`）
**备份**（改前，落在插件目录内、不进加载路径）：
`lib/patrol.js.bak-a2terminal-20261014-193814` · `lib/wakeledger.js.bak-a2terminal-20261014-193814`
**当前指纹（SHA256 前 16 位）**：`patrol.js = DBDB5523878AE4A1`（40791 字节）　`wakeledger.js = 22CC3FBC0B004EBB`（30578 字节）
（首轮三条修完时是 `patrol.js = C7918DF81BB9189E` / `wakeledger.js = BDE6B85B434A401F`；追加那条之后以本行为准。）
**未改**：`index.js` / `store.js` / `tools.js` / `liveness.js` / `orphan.js` / `handoff.js` / `hashgate.js` / `wakeup.js` / `states.js` / 启动脚本，一个字没动；未装依赖、未重启 DSH。

---

## 一、复现（交付键的嵌套证据）

### 1.1 交付键本身即证据（真实账本 `wake-ledger.jsonl`，逐字抄录）

同一张**已取消**的单 `T-20261014-hello01`，连续收到（键长逐层加深，每一层都是**新键**）：

```
123 字符  T-20261014-hello01|unresolved-wake|mechanism|T-20261014-hello01|unresolved-wake|2026-10-13T18:20:24Z|human|no-stable-identity
175 字符  T-20261014-hello01|escalation|mechanism|T-20261014-hello01|unresolved-wake|mechanism|T-20261014-hello01|unresolved-wake|2026-10-13T18:20:24Z|human|no-stable-identity#escalated
213 字符  T-20261014-hello01|unconsumed-delivery|mechanism|T-20261014-hello01|unconsumed-delivery|T-20261014-hello01|unresolved-wake|mechanism|T-20261014-hello01|unresolved-wake|2026-10-13T18:20:24Z|human|no-stable-identity
263 字符  T-20261014-hello01|unconsumed-delivery|mechanism|T-20261014-hello01|unconsumed-delivery|T-20261014-hello01|escalation|mechanism|T-20261014-hello01|unresolved-wake|mechanism|T-20261014-hello01|unresolved-wake|2026-10-13T18:20:24Z|human|no-stable-identity#escalated
301 字符  T-20261014-hello01|unconsumed-delivery|mechanism|T-20261014-hello01|unconsumed-delivery|T-20261014-hello01|unconsumed-delivery|mechanism|T-20261014-hello01|unconsumed-delivery|T-20261014-hello01|unresolved-wake|mechanism|T-20261014-hello01|unresolved-wake|2026-10-13T18:20:24Z|human|no-stable-identity
```

即交付单里记的那条链：`unresolved-wake` → `escalation(…)#escalated` → `unconsumed-delivery(…)` → `unconsumed-delivery(escalation(…))` → `unconsumed-delivery(unconsumed-delivery(…))` → ……。**每一层都比上一层长一截，且都是新键**。

### 1.2 存量占比（同一份真账本）

| 项 | 数 |
|---|---|
| 账本行数 | 101 |
| `t=wake`（已播报） | 42 |
| 其中**机制通知**（`unresolved-wake` 9 / `unconsumed-delivery` 8 / `escalation` 6 / `task-stall` 3） | **26（62%）** |

### 1.3 为什么无法自愈（P0-3 的要害，也是这次必须修的理由）

目标单已是**终态**（`cancelled`）⇒ `states.js:675` / `states.js:681` 对 `closed` / `cancelled` 明示 **`null`（无合法事件）**
⇒ **主对话没有任何动作能"消费"它** ⇒ 机制自己写下的终止条件「一旦那条投递被消费就不会再有下一条升级」**永远无法满足**。

### 1.4 增量动力学（A/B 探针，隔离两棵树，5 轮生产形状的巡检回放）

同一份探针、同一份夹具，只换 `lib/patrol.js` + `lib/wakeledger.js` 的版本：

| 场景 | 改前（备份版） | 改后（当前） |
|---|---|---|
| 活单（`developing`）每轮新增播报 | `[3,4,6,5,4]` → 累计 **23** 条 | `[2,0,0,0,0]` → 累计 **3** 条 |
| 终态单（`cancelled`）每轮新增播报 | `[3,4,6,5,4]` → 累计 **23** 条 | `[1,0,0,0,0]` → 累计 **2** 条 |
| "播报的播报"（键里套了完整机制通知段） | **20** 条 | **0** 条 |
| 最长交付键 | **351** 字符 | **100**（活单）/ **71**（终态单）字符 |

★ 改前**终态单与活单长得一模一样**（都 23 条、都继续加深）—— 这正是 P2-11 与 P0-3 同源的实证。
（追加那条修完之后**又跑了一遍 A/B**，数字与上表**逐字相同** —— 新判据不改变链的收敛行为。）

### 1.5 ★ 追加的那一条：**席位交付后停住 ⇒ 没人补上/播报那一步**（同族的**反面：漏报**）

**实测（主对话在真单上跑了三次，全部复现）** —— 任务 `T-20261011-5a871c`（L3，3 个编写席位）：

| 次 | 谁 | 干了什么 | 结果 |
|---|---|---|---|
| ① | 原 `writer#1` | 制品 v4 登记 ✓ · `dev_to_test` 交接物 `H-073a6a57aaf0ecc7` ✓ · 自己那份记录 ✓ · 哈希闸门过 ✓ · 改动面在授权面内 ✓ | **没发 `dev_submitted`** ⇒ 停在「开发中」 |
| ② | 主对话 `notify_only` 唤醒原席 | 投递成功（`requestId=<session-id>`，`mode=queue`） | **无反应** |
| ③ | 全新接替席（brief 只写"发这一个事件"、前席每一步都列全） | 交完自己那份记录 | **仍未发** |

**从真单 `task.json` 读出来的形状（决定性）**：
```
state                = developing
最后一条 transition   = 2026-10-14T11:24:43Z（human_reply → developing）
dev_to_test 交接物    = H-073a6a57aaf0ecc7 @ 2026-10-14T11:33:39Z   ← 晚于上面那条
writer_submissions   = {"writer#1": {handoff_id: H-073a6a57aaf0ecc7, artifact_version: v4, at: 11:33:40Z}}
roster.writers       = count=3（writer#1 / writer#2 / writer#3）
```
★ 两个此前**没人读到**的事实：
1. **交付确实已落盘**（`writer_submissions` 就是 store 自己记的"本轮谁交了"）；
2. **本轮只到 1/3** —— 所以 `dev_submitted` 的守卫（`store.js:2471` 要求**全部席位到齐**）
   **根本不会放行** ⇒ 那一刻该叫的是 `writer#2` / `writer#3`，而**机制一条播报都没有**。

★ 与 P0-3 / P2-11 / P2-12 的关系：那三条治的是**噪音与活锁**，这一条治的是**漏报** ——
**收敛噪音时不许把"真正该报的"也一起收掉**。所以本条新增的播报自带去重与冷却（§三.4），
并且**必须**同时登记进 `MECHANISM_NOTICE_KINDS`，否则它自己那条交付下一轮就会被当成
"等待接管的交付"再报一次（P0-3 套娃复发）。

---

## 二、根因（文件:行）

> 行号一律给**改前**（`lib/*.bak-a2terminal-20261014-193814`）；括号里是改后对应位置。

### 根因 1｜终态过滤**只做了一支**（P2-11 与 P0-3① 的直接成因）
`lib/patrol.js:133`（改前）：
```js
if (active && !terminal && stalled !== null && stalled >= stallMs) {   // ← 只有 task-stall 这一支看了 terminal
```
而同一个函数里的另两支 —— `lib/patrol.js:151`（`unconsumed-delivery`）与 `lib/patrol.js:165`（`unresolved-wake`）—— **完全没有终态判据**。终态单的"该叫没叫"与"没人接管"因此照旧每轮出播报。**`terminal` 变量当时就在作用域里，却没被后两支用上。**

### 根因 2｜播报的身份**逐层派生**，于是"播报"变成新交付（P0-3 的套娃引擎）
`lib/patrol.js:153`（改前）：
```js
id: `${String(task.id ?? '')}|unconsumed-delivery|${String(e.key ?? '')}`,   // ← id 里嵌了"上一层那条交付的键"
```
这个 id 被 `index.js:641` 当作 `disc` 直接拼成新的交付键（`wakeKeyOf`：`<任务>|<类别>|<执行者>|<判别子>`）。于是：

```
第 N 层播报的键 = T|unconsumed-delivery|mechanism|<第 N-1 层的键>
```
**每层都是新键 ⇒ 新幂等域 ⇒ `requestId` 幂等永远命中不了**。机制自己写的"同一条只播一次"在这里形式上成立、实质上失效。

### 根因 3｜`pendingUnconsumed` 只认"原键"，不认"派生键"、也没有深度概念（P0-3②③ 的缺口）
`lib/wakeledger.js:398-402`（改前）：
```js
pendingUnconsumed({ now = Date.now(), olderThanMs = 0, limit = 20 } = {}) {
  for (const e of delivered.values()) {
    if (consumed.has(e.key)) continue
    if (escalated.has(e.key)) continue      // ← 只挡"原键已升级"；升级自己那条交付不在 escalated 里
```
升级动作发出的是**另一条交付**（`lib/wakeup.js:1633`：``const escKey = `${p.key}#escalated` ``），它的键是 `<任务>|escalation|mechanism|<原键>#escalated` —— 既不在 `consumed`、也不在 `escalated` 里 ⇒ **下一轮又被当成"等待接管的交付"⇒ 拿它再升一次级**。这个函数是**巡逻与升级链共同的取数口**（`wakeup.pendingDeliveries` 与 `wakeup.escalateUnconsumed` 都走它），所以缺口一处、两条链一起套娃。

### 根因 4｜"该叫没叫"的身份带了**那一次的时刻**（P2-12 必然刷屏）
`lib/patrol.js:167`（改前）：
```js
id: `${String(task.id ?? '')}|unresolved-wake|${String(e.at ?? '')}|${String(e.kind ?? '')}|${String(e.reason ?? '')}`,
```
机制**不能对"人"说话**（主对话是唯一传话人）⇒ 每产生一条人工介入请求，就必然伴生一条 `kind=human / reason=no-stable-identity`；而 id 里的 `e.at` 每次不同 ⇒ **每次都算新的一条**。（真账本里同形播报 3 条 / 同一张单。）

### 根因 5｜★ 追加那条：**根本没有"交付已落盘、出口没人按"这条判据**（漏报）
`lib/patrol.js`（改前）里 `patrolFindings` 只有四种判据：无进展 / 已投递未接管 / 该叫没叫 / 巡检停摆。
**没有任何一条读"交付到底齐没齐、齐了之后那一步出口有没有人按"** —— 而这两个事实**早就在盘上**：
- 本轮谁交了：`task.writer_submissions`（`store.js:4765-4772` 写入，`store.js:1920` 在**进 developing 时清空** ⇒ 天然"本轮"口径）；
- 到齐没有：`store.js:2471` 的 `checkAllSeatsSubmitted`（守卫自己就是这么判的）；
- 该发哪一步：`states.js:595 / 605 / 620`（`dev_submitted` / `test_passed` / `review_ok`）。

**巡检手里有 `task` 全量台账，却一条都没读。**

### 根因 6｜★ 既有那条 `task-stall` **结构上抓不到这种卡法**（为什么必须另立判据）
`lib/patrol.js:78-105`（改前改后一样）的 `lastProgressAtMs` 把**交接物 / 制品 / 记录 / 派活**全算作"有进展"：
```js
for (const h of Array.isArray(task?.handoffs) ? task.handoffs : []) take(h?.created_at)
for (const a of Array.isArray(task?.artifacts) ? task.artifacts : []) take(a?.created_at ?? a?.at)
for (const r of Array.isArray(task?.records) ? task.records : []) take(r?.at)
```
而本条的形态恰恰是"**交付本身很新**"（`T-20261011-5a871c` 最后进展 = 11:42:11 的记录提交）⇒
`task-stall` 要么不触发、要么只会说一句笼统的「该动的角色：writer」——
**判不出"东西齐了、出口没按"这件事，也给不出该发哪个事件**。
所以这一条**必须另立判据**（判据不同源、互不冒充，A24 的同一条纪律）。

### 责任边界（不在本包所有权内的三处，已实测确认）
- `index.js:701`：`await wakeup.escalateUnconsumed(entry.id, …)` —— **不看任务状态**，是"终态单的升级腿"的唯一入口；
- `lib/wakeup.js:1633`：升级键 `${p.key}#escalated` 的**派生规则**本身；
- `lib/states.js:595 / 605-606 / 620-622`：那三跳的 `by` 写死了只有 `writer` / `tester` / `reviewer`（或 `security`）能发
  ⇒ **主对话代发会被状态机拒** ⇒ "让主对话代发"这件事（追加那条的选项 A）是 `states.js` 的授权面变更。

⇒ 这三处一个字没动（不是我的文件）。本包在**取数口**（根因 3 所在）把 ②③ 两道闸做掉，
并**新增第五条判据**（根因 5/6）把漏报补上；需要别人配合的部分写在 §六.3。

---

## 三、修法与最小性

### 3.1 三条修法（与 bug 单的建议一一对应）

| # | 修法 | 落在哪 | 一句话 |
|---|---|---|---|
| ① | **终态单整条退出播报面** | `patrol.js`（新 `325-345`） | 判定照旧做，**一条都不播**；每条落进 `suppressed[]`（原因 `terminal-state`），底账照旧在盘上 |
| ② | **升级链加深度上限** | `wakeledger.js:91`（`DEFAULT_MAX_ESCALATION_DEPTH = 1`）+ `:541` | `#escalated` 到上限的键**不进"等待接管"清单** ⇒ 升级拿不到它 ⇒ 升不出第二层（原事件 + 1 层封顶） |
| ③ | **升级键收敛到根事件** | `wakeledger.js:100/148` + `:543` | **机制自己的通知不是"等待接管的交付"**（`actor=mechanism` + `MECHANISM_NOTICE_KINDS`）⇒ 不再拿"上一层交付"派生新键 |
| P2-12 | **该类别身份收敛** | `patrol.js:79`（`CONVERGED_UNRESOLVED_IDENTITY`）+ `:266-300` | `human / no-stable-identity` 的 id 只印「类别 + 原因」（**不印那一次的时刻**）⇒ 同一张单**至多播一条**；同轮内重复的落 `converged-duplicate` |

### 3.2 ★ 追加那一条的修法：**第五条判据**「交付已落盘、出口没人按」

选的是**选项 B 的"播报"半边**（不是"机制补发"），理由见 §3.3。三腿判据表
（`patrol.js` 的 `UNDELIVERED_TRANSITION_LEGS`，判据一律**与状态机/守卫同源**）：

| 腿 | 状态 | 判据（读的是谁写的账） | 该发的事件（指名道姓） |
|---|---|---|---|
| `dev_submitted` | `developing` | `writer_submissions` 里**已交的席位**（+ 到齐没有，同 `store.js:2471` 口径） | `dev_submitted` |
| `test_verdict` | `testing` | 本轮 `test_to_review` 交接物 + **制品版本对得上**（同 `store.js:2481`） | `test_passed` / `test_failed`（**两个都列** —— 通过与否是测试位的结论，机制不替它选） |
| `review_verdict` | `reviewing` | 本轮 `review_verdict` 交接物 + 版本对得上（同 `store.js:2495`） | 结论 `OK` ⇒ `review_ok`；`NG` ⇒ 按 `reject_to` 给 `review_ng_test` / `review_ng_dev`（**结论从交接物自己身上读**） |

**★ 两种形态分开措辞（这是实测那张卡单教的一件事，也是最容易做错的地方）**：
- **到齐** ⇒ 「**出口没按**」：东西齐了、那一步没人发 ⇒ 建议**叫醒该席位补发**；
- **没到齐**（实测就是这种，1/3）⇒ 「**本轮只交到 m/N**」：那一步**现在根本发不出去**
  ⇒ 建议**先叫醒还差的那几个席位**（`writer#2`、`writer#3`）。
  ★ 措辞混用会给出**错的动作**（叫主对话去发一条会被守卫拒的迁移）。

真单实测输出（`node` 直跑，只读副本；见 §四.4）：
```
expected=dev_submitted complete=false 已交=["writer#1"] 还差=["writer#2","writer#3"]
dwell=16分 evidence=H-073a6a57aaf0ecc7
id=T-20261011-5a871c|missing-transition|developing|dev_submitted|round@2026-10-14T11:24:43Z
```

### 3.3 ★ 为什么**没有**做"机制补发那一步"（选项 B 的前半边）—— 两个理由，任一都够

1. **它违反本文件自己写死的纪律 A22**（`patrol.js` 模块头）：巡检「**只播报，不动作** ——
   不补位、不继任、不冻结、不解冻、**不推进/回退状态**」。让巡检去补发一次状态迁移，
   就是把这行字删掉；而 A22 是用户裁定过的（2026-10-12 方案 4 的第二项新授权）。
2. **它需要一套权限设计，而 pid 手里没有角色令牌**：那三跳的 `by` 写死是 `writer` / `tester` / `reviewer`
   （`states.js:595/605/620`），机制**不是**这些角色。要么给机制造一个"代发"身份（等于
   在授权面上开一个**谁都能冒充**的口子），要么把这活交给主对话 —— 而主对话**现在也没有**这个授权。

⇒ 所以走"**播报 + 明确建议 + 指名该发哪个事件 / 该叫哪个席位**"，
并把"让主对话可代发"作为**建议**交给 `states.js` 的属主（见 §六.3，附具体补丁）。

### 3.4 ★ 去重与冷却（本轮被点名要求，落点在**身份**上）

```
id = <任务>|missing-transition|<状态>|<该发的事件>|round@<进这个状态的那一刻>
```
- **同一轮**跨多次巡检、**甚至跨多次席位提交**（1/3 → 2/3）⇒ **id 一个字不变**
  （交付时刻、已交几个席位**只进正文，不进身份**）⇒
  ① `index.js:622` 的 30 分钟内存窗吃掉重复；② 跨进程由**已播报账本**的 `hasDelivered` 吃掉
  ⇒ **同一轮至多播一次**；
- 打回后**新一轮**（重新进 developing）⇒ `round@…` 变了 ⇒ **新 id** ⇒ 会再报（**不会永久哑掉**）；
- 那一步真发了（状态变了）⇒ 这一腿的状态对不上 ⇒ **一条都不再出**；
- ★ 并且这个新类别**必须**在 `MECHANISM_NOTICE_KINDS` 里（已加）—— 自测里有一条断言
  **专门锁这个"两个文件必须同时改"的约束**，另有一条**端到端**断言证明它自己那条交付
  不会被当成"等待接管的交付"再报一次（E2 组）。

### 3.5 "最小性"体现在哪些**没做**的事上

1. **不删数据**：被收敛的条目**照旧留在账本里**（`delivered` 镜像 + `wake-ledger.jsonl` 原文一个字节没动）。`status()` 新增两个**只读派生**计数 `mechanism_notices` / `derived_escalations`（`wakeledger.js:438/440`），且 `pendingUnconsumed({includeMechanismNotices:true})` 能把它们**要回来**（取证用）—— 收敛 ≠ 静默丢弃。
2. **不静默**：`patrolFindings` 新增 `suppressed[]`（每条带 `reason` + 人读的 `detail`）与 `terminal`，`note` 里写明**按原因分组的条数**（"只记账不播报 N 条（终态 x / 机制通知 y / 到深度上限 z / 同类已有一条 w）"）。压下去多少、为什么，返回值里直接读得到。
3. **不误伤**：`MECHANISM_NOTICE_KINDS` 现在只列**六个通知类别**，刻意**不含** `liveness`（席位失联）/ `abort`（运行中止）/ `transition` / `handoff` / `artifact` / `record` / `human` / `clarify` —— 那些是**真事实**，该报该升，一个字没动。"投不出去 / 该叫没叫必须报出来"这条契约因此**没有被削弱**（反例见 §四.2 B、D⑤、§四.5 F）。
4. **不做死代码**：曾考虑"从账本里的 `transition` 交付推终态"（好让升级腿也吃到 ①），实测**否决** —— 真账本里 `kind=transition` 的唤醒**一条都没有**，且 `rebuild()` 在全插件**从未被调用**（`grep` 证据：只有 `wakeledger.js` 自己定义 + 测试引用）。会永远不触发的判据 = 假装修好了，故**不写**。
5. **不动别人的文件**：`index.js` / `wakeup.js` / `states.js` 等一个字未改；`tests/run-all.mjs` **也未改**（它在 19:39:53 正被别的会话编辑，我这套新验证走独立可跑 + 报告里给出注册补丁，见 §六.4）。
6. **不改既有判据口径**：`patrolFindings` 的返回值里 `findings` / `stalled_ms` / `state` / `note` 语义不变（只**多**了 `suppressed` / `terminal` 两个字段）；A21–A25 的纪律（只播报不动作、同一条只播一次、抛错不停摆）逐条未动。
7. **不越位**：追加那条只在**该按出口**的那三个状态上判（`developing` / `testing` / `reviewing`）——
   `returned_to_dev` 不判（那一步该发的是**主对话的 `dispatch_writer`**，不是编写席位的 `dev_submitted`）；
   版本对不上不判（那条迁移本来就过不去）；提交时间读不到不判（不猜）。反例逐条见 §四.5。

---

## 四、验证（正例 + 反例）

### 4.0 命令

```powershell
cd <DSH_HOME>\profiles\desktop\node_modules\dsh-pipeline
node tests/terminal-filter-check.mjs        # 新增验证：53 条断言（含追加那条的 12 条）
```

### 4.1 结果（A–D 组：终态过滤 / 收敛 / 断链；原样输出，exit=0）

```
【终态过滤包 · terminal-filter-check（P0-3 / P2-11 / P2-12）】

== A 正例｜终态单不再进链（P0-3① / P2-11） ==
  ✅ ① ★★ 终态「cancelled」⇒ `findings` **一条都没有**（交付键本身即证据：这张单的套娃键整批喂进来也不播）
  ✅ ② ★★ 但**判定照旧做**：每条都落进 `suppressed`，原因一律 `terminal-state`（收敛不是静默）
  ✅ ③ ★ note 里**写明了"只记账不播报几条 + 为什么"**（人读的那一句不许是空白）
  ✅ ① ～ ③ 终态「closed」同上
  ✅ ④ ★★ 终态单连 `task-stall` 也**不播**（滤的是**整条播报面**，不是"少报一类"）
  ✅ ⑤ ★ 终态单不接 `patrol-stalled`（停摆那条事实有自己的出口 `onStalled`）

== B 反例｜活的单仍然照播（契约没被削掉） ==
  ✅ ① ★★ 反例：**同一份输入、状态换成活的** ⇒ 三条照旧全出
  ✅ ② ★★ "投不出去/该叫没叫必须报出来"这条契约**一个字没动**
  ✅ ③ ★ 正常的交付（`handoff`，不是机制通知）照旧进"已送达但没人接管"播报
  ✅ ④ ★ 等待态（等用户）仍然不报"任务无进展"
  ✅ ⑤ ★★ P2-12 收敛是**定向**的：human/no-stable-identity 两次**合并成一条**，别的类别仍**一次一条**
  ✅ ⑤c ★ 同轮第 2 条同类落进 `suppressed`（`converged-duplicate`，不白跑一次投递）
  ✅ ⑤b ★ 收敛那一条的正文**自己说明了**为什么收敛

== C 收敛③｜机制通知不再派生新交付 ==
  ✅ ① ★★ 账本侧：**只有根事件**留在"等待接管"清单里
  ✅ ② ★★ 收敛是"**只记账**"不是"删数据"：`includeMechanismNotices:true` 能把它们**要回来**
  ✅ ③ ★★ 收敛掉的那些在 `status()` 里**数得出来**（两个桶互斥）
  ✅ ④ ★ `DEFAULT_MAX_ESCALATION_DEPTH` = 1，且可显式调小到 0 = 一律不升级
  ✅ ⑤ ★★ 巡检侧**第二道闸**：真实那几条套娃键（套了 1~6 层通知）一条都播不出来

== D 端到端｜链在第 1 层封顶，之后只记账 ==
  ✅ ⓪ ★★ **控制项**：第 1 轮**真的**把链起来了 —— 否则后面的"停住"是假通过
  ✅ ① ★★ **第 2 轮起新增 0 条**（链在 1 轮内终止；改前是每轮继续加深一层）
  ✅ ② ★★ **没有任何键是"播报的播报"**
  ✅ ③ ★★ 全部交付键**升级深度 ≤ 1**
  ✅ ④ ★★ 契约保留：**根事件该叫的那一次升级照样发生**
  ✅ ⑤ ★★ 反例：再来一条正常交付 ⇒ 它**也**拿到自己那一次升级
  ✅ ⑥ ★★ 正例（终态单）：同一套循环跑 4 轮 ⇒ **巡逻一条都不播**，且链不加深
  ✅ ⑦ ★★ **已知边界（本包修不到，需 index.js 收口）**：终态单**至多**还会收到 1 条升级播报
  ✅ ⑧ ★ 但"没投出去"这件事**仍然在账上**
```

### 4.2 ★ 追加那条的**正例**（E 组 + E2 组，原样输出）

```
== E 正例｜交付已落盘、出口没按（实测真卡单的形状） ==
  ✅ ① ★★ 实测那张卡单的形状（3 席只到 1 席、交付后 16 分钟）⇒ **报出来了**（这就是原先的漏报）
  ✅ ② ★★ 措辞**如实**：说清"只到 1/3、还差 writer#2 / writer#3"，并**不**叫主对话去发一条会被守卫拒的迁移
  ✅ ③ ★★ 机器可读的动作面齐了（expected_events / complete / missing_seats / evidence_id / delivered_at / actor）
  ✅ ④ ★★ 三席**到齐**⇒ 换成"出口没按、叫席位补发那一步"（两种形态给出**不同的**动作建议）
  ✅ ⑤ ★★ **去重与冷却**：同一轮跨巡检（16 分→90 分）、甚至又交了一席（1/3→2/3）⇒ **id 一个字不变**
  ✅ ⑤b ★ 身份的最后一截钉在"**本轮**"上（round@进 developing 那一刻）
  ✅ ⑥ ★★ 测试腿：`test_to_review` 已落盘、仍停在「测试中」⇒ 报，且**两个候选事件都列**
  ✅ ⑦ ★★ 审核腿：结论是 OK ⇒ 指名 `review_ok`（不是含糊的"该发点什么"）
  ✅ ⑦b ★ 结论 NG + 打回测试 ⇒ 指名 `review_ng_test`（**从交接物自己身上读结论**，不猜）
  ✅ ⑧ ★★ **新增的播报类别必须同时登记进 `MECHANISM_NOTICE_KINDS`**（漏一个 ⇒ 套娃复发）
  ✅ ⑧b ★ 口径可配（默认 10 分钟）—— 不是写死在判据里

== E2 端到端｜新判据不会变成新的刷屏源 ==
  ✅ ① ★★ 第 1 轮播**正好 1 条**（先证明它真的会响 —— 否则后面"停住"是假通过）
  ✅ ② ★★ **第 2 轮起 0 条**：它自己那条交付没有被当成"等待接管的交付"再报一次
  ✅ ③ ★★ 账本里**没有一条"播报的播报"** —— 与 P0-3 的断链成果一致，没被这条新判据破坏
```

### 4.3 ★ 追加那条的**反例**（F 组：**"出口没按"不许误报**，原样输出）

```
== F 反例｜"出口没按"不许误报 ==
  ✅ ① ★★ **正常推进**（`dev_submitted` 发了、状态走到「待测试」）⇒ 一条都不报（最关键的反例）
  ✅ ② ★★ **打回重做·新一轮刚开始**（提交表空、上一轮的 `dev_to_test` 还在册）⇒ **不报**（否则每轮重做都被冤枉一次）
  ✅ ③ ★★ **刚交完 2 分钟**（冷却窗 10 分钟内）⇒ 不报
  ✅ ④ ★★ **终态「cancelled」/「closed」**：交付证据一模一样，也**一条都不播**
        （★ 这一腿的保护是**结构性**的：终态单根本不在那一腿的状态上 —— 不是靠末尾那道闸兜住的）
  ✅ ⑤ ★ **一个席位都还没交**（提交表空、无本轮交接物）⇒ 不报（那只是"还在干活"，该走失联/无进展那两条既有判据）
  ✅ ⑥ ★★ 测试报告针对的是**旧版本**（v4 / 当前 v5）⇒ 不报 —— 与守卫同口径，那条迁移**本来就过不去**
  ✅ ⑦ ★ 等待态（等用户拍板）里不判这一条
  ✅ ⑧ ★ 提交表在、但**提交时间读不到** ⇒ **不猜**（宁可不报，也不凭一个假的时间去催）
  ✅ ⑨ ★ 「打回编写待重派」不判这一条 —— 那一步该发的是**主对话的 `dispatch_writer`**（判据不许越位）
```

### 4.4 真单直跑（只读，**不写任何盘**）

```powershell
node -e "…读 .pipeline/T-20261011-5a871c/task.json → patrolFindings({task, now})…"
```
```
=== 真实卡单 · 交付后 16 分钟（now=2026-10-14T11:50:00Z）===
  expected=dev_submitted complete=false 已交=["writer#1"] 还差=["writer#2","writer#3"]
  dwell=16分 evidence=H-073a6a57aaf0ecc7
  id=T-20261011-5a871c|missing-transition|developing|dev_submitted|round@2026-10-14T11:24:43Z
  detail:
    **编写交测试 这一步没人按**：writer 的交付**已经落盘**，任务却还停在「开发中」—— **本轮交付只到 1/3，`dev_submitted` 现在发不出去**（交付后已过 **16 分钟**；口径 10 分钟）。
    证据：本轮编写交付**只到 1/3**：已交 writer#1（最后一个 writer#1，交接物 H-073a6a57aaf0ecc7），**还差 writer#2、writer#3**；制品版本 v4。
    ★ 这**不是**"没人盯着"，是**交付没齐**：到齐之前 `dev_submitted` 过不去 ⇒ 整条流水线停在这里。
    ★ 建议：**先叫醒还差的那几个席位**（writer#2、writer#3）把他们那份交了 —— `pipeline_transition { event: "dev_submitted" }` 现在**发不出去**（守卫要求全部席位到齐，`store.js:2471`）；到齐之后再让任一编写席位补发那一步。
    ★ 这一条迁移**只允许 writer** 发（`states.js` 的 `by` 写死），**主对话代发会被状态机拒** —— 要放开代发属授权面变更（见实现报告的 A 路建议）。

=== 真实卡单 · 刚交完 2 分钟（冷却窗内）=== 无播报 ✓
=== 真实卡单 · 30 分钟后（同一轮）=== id 与 16 分钟那次**逐字相同** ✓（⇒ 账本幂等吃掉 ⇒ 同一轮至多一条）
```

### 4.5 真账本复算（★ 一条**与预期不符**的发现，如实登记）

把真 `wake-ledger.jsonl` **复制到临时目录**（真账本一个字节没动）后逐档复算：

```
两道闸都开（改后线上口径）= 1 条
只关②深度闸              = 1　⇒ ②独自挡下 0
只关③通知闸              = 1　⇒ ③独自挡下 0
两道都关（= 改前口径）    = 1　⇒ 合计挡下 0
```

**存量账本上两道闸一条都挡不下** —— 因为存量那 26 条机制通知**大多已经被 `consumed`（36 条）或 `escalated`（6 条）吃掉了**，而这两道既有判据在 `pendingUnconsumed` 里排在前面。
⇒ 结论：**光看存量账本看不出这次修了什么**；唯一的有效判据是**增量动力学**（§1.4 的 A/B：改前每轮继续加深，改后第 2 轮起恒为 0）。这条经验也值得写进 bug 单：以后这类"链式放大"的验收必须跑动力学，不能只看存量快照。

---

## 五、测试改前 / 改后

### 5.1 全套（`node tests/run-all.mjs --quiet`）

| | 我开工前的基线 | 改动后 | 说明 |
|---|---|---|---|
| 全套退出码 | 1 | 1 | 两轮都由**同一批已知红**决定 |
| `roster-authority-check` | **70/72** | **70/72** | 同 2 条 `E 上限次序｜★ A3` 断言；**与本包无关**，基线即红 |
| `orphan-rescue-check` | **42/46**（P1-12 活体环境随机红） | **61/61 ✓** | ★ **不是我的功劳**：该套件被**另一个会话**重写（39734 → 56221 字节，19:42:24；此后仍在扩），修掉了 P1-12 |
| 其余各套 | 全绿 | 全绿 | 另有一套新套件 `handoff-seat-check`（27/27）也是别的会话加的 |

★ **收尾时又跑了一次完整全套**（31 套）复核：唯一红就是上表 `roster-authority-check` 那 2 条，其余 30 套全绿；我的新套件因未改 `run-all.mjs` 而**不在全套里**（独立跑，注册补丁见 §六.4）。即：**本包改动（含追加那条）没有引入任何新红**。

### 5.2 本包改动**直接涉及**的套件（逐个单跑，exit 全 0）

| 套件 | 结果 | 覆盖到我改的哪一面 |
|---|---|---|
| `tests/terminal-filter-check.mjs`（**新增**） | **53/53 ✓** | 三条修法 + **追加那条** + 正反例（§4.1–4.3） |
| `wake-channel-check` | **51/51 ✓** | `patrolFindings` ×5（A21–A25 全套）+ `escalateUnconsumed` ④/④b/⑤ + 账本三态/重建 |
| `orphan-rescue-check` | **61/61 ✓** | `patrolFindings` 复用那条 `unresolved-wake` 播报面 + 放弃记账 |
| `selftest-core` | **70/70 ✓** | 核心全流程（含唤醒/交付） |
| `wake-check` | **55/55 ✓** | 交付即唤醒各触发点 |
| `intercept-check` | **25/25 ✓** | 机制侧 `liveness` / `abort` 播报（我刻意没碰那两个类别） |
| `load-smoke` | **24/24 ✓** | **插件能装得上、起得来**（两个文件都被 `index.js` 直接 import） |
| `boundary-check` | **43/43 ✓** | 边界清单（含 `wakeledger` 能力面那一段文档） |
| `gate-states-check` | **55/55 ✓** | 状态机各闸门（含那三跳的 `by` 与守卫） |

**结论：0 条新增红。** 未删任何既有测试、未放宽任何断言、未改任何期望值。

---

## 六、未做活体验证（需重启后复验）

### 6.1 本轮**没有**做的事（如实列出）

1. **没有重启 DSH、没有装任何东西**（遵守硬约束）⇒ 以下行为**本轮无法在活体上观测**，需重启后复验：
   - 重启后第一轮巡检（`config.patrolIntervalMs`，默认 5 分钟）是否**不再出现**同形嵌套播报；
   - 已取消单 `T-20261014-hello01` / `T-20261011-5a871c` / `T-20261012-7b9408` 是否**彻底安静**（终态过滤：**应 0 条**）；
   - 真账本 `wake-ledger.jsonl` 的**新增行**里是否不再出现"套娃键"（判据：新行的键里 `<类别>|mechanism|` 完整通知段 ≤ 1 次）；
   - ★ **追加那条**：`T-20261011-5a871c` 重启后**应当**收到一条 `missing-transition`
     （"本轮交付只到 1/3、还差 writer#2 / writer#3"）—— 且**只一条**（同一轮 id 稳定）。
     验完它再看主对话按建议唤醒缺的那两席之后，任务能否走到「待测试」。
2. **没有做实盘升级链**（无需重启也能做的那部分已做）：A/B 探针用的是 `createWaker` + 真账本文件 + 真 `escalateUnconsumed`，但**宿主投递是假宿主**（沿用既有各套的 `fakeHost` 惯例）。真实宿主的 `sessionController.prompt` 那一段**未验证**。
3. **未做**（也做不了）：终态单升级腿的 0 条（见 6.2）；"主对话代发那三跳"（见 6.3）。

### 6.2 已知边界①：终态单的**升级腿**（本包修不到）

**终态单仍可能收到 至多 1 条 `escalation` 播报**（本轮实测：`cancelled` 单 5 轮里 1 条、之后恒 0）。
原因：升级入口 `index.js:701` 的 `await wakeup.escalateUnconsumed(entry.id, …)` **不看任务状态**。
本包保证的是**它到此为止、不加深**（②③ 两道闸），不是"0 条"。
**收口办法（一行、给 index.js 的属主）**：
```js
// index.js 的 tick 循环内、第 701 行那次升级调用之前（循环里已经有 task 变量）
if (TERMINAL_STATES.includes(task.state)) continue            // ★ 终态单不进升级链（P0-3①）
```
同类地，若要让"被抑制"这件事也进**插件日志**（目前只进 `patrolFindings` 的返回值，`index.js` 的 tick 只消费 `res.findings`）：
```js
if (res.suppressed?.length > 0) ctx.logger?.info?.(`[pipeline] 巡检只记账不播报：${res.note}`)   // ★ 可选
```

### 6.3 ★ 已知边界②：追加那条的**选项 A**（让主对话可代发）—— 需要 `states.js` / `store.js` 属主配合

用户在追加需求里倾向"能两个都做更好"。**B 的播报半边我已做完**；**A（主对话代发）我一个字没改**，
因为它落在 `lib/states.js`（授权面）与 `lib/tools.js`（工具归属）里，不在本包所有权内。
**建议怎么改（给属主，二选一）**：
```js
// 方案 A1（最小、最窄）：只给"编写交测试"这一跳加一个 main 可发的代理事件，不动既有那条边
// lib/states.js 的 TRANSITIONS 里新增：
{ from: ST.DEVELOPING, event: 'main_dev_submitted', to: ST.READY_TEST, by: ['main'],
  guard: 'dev_to_test', note: '★ 主对话代发（编写席位交完最后一个交付物就结束回合、不发这最后一步时用）；守卫与 writer 那条完全同源' }
```
```js
// 方案 A2（更小但要动既有边）：把 'main' 加进那条边的 by —— ★ 不推荐：
//   那等于让主对话随时能替编写位宣布"交活了"，三权分立的边界会被磨掉。
{ from: ST.DEVELOPING, event: 'dev_submitted', to: ST.READY_TEST, by: ['writer', 'main'], ... }
```
★ **不论走哪条**，都请同时确认 `lib/tools.js` 的 `pipeline_transition` 对 `main` 的角色判定与留痕
（`actor` 会记成 `main` ⇒ 事后能区分"席位自己发的"与"主对话代发的"）。
★ 在那之前，**本包的播报已经把"该谁发、该叫谁"说清楚了** —— 主对话拿到这条播报就知道下一步动作，
不必再靠人肉排查（这正是三次复现里最贵的那一段）。

### 6.4 新增验证的注册（`run-all.mjs` 未改，故给出补丁）

`tests/run-all.mjs` 走**显式 import 清单**（不是目录扫描），且正被别的会话编辑 ⇒ 我**没有改它**。新套件**已可独立跑**（`node tests/terminal-filter-check.mjs`，exit 0/1 与其它套件同形）。要并入全套，由 `run-all.mjs` 的属主加两行：

```js
import { runTerminalFilterCheck } from './terminal-filter-check.mjs'   // 与其它 import 同处
...
  await runTerminalFilterCheck()                                       // 与其它 await 同处
```
（套件已按既有各套的注册约定导出 `runTerminalFilterCheck()`，返回 `{passed,total,text,items}` —— 与 `runWakeChannelCheck` 同形状，接进去即可。）

### 6.5 过程留痕：新套件自己先红过 7 条（**全部是用例的期望写错了，不是实现放宽**）

首跑 21/27（第一轮）与 46/49（追加那条之后），逐条纠正记录如下 —— 免得被读成"后来放宽了断言"：

| 红 | 我原先的期望 | 实测 | 判定 |
|---|---|---|---|
| D⓪ | 第 1 轮新增 **2** 条 | **3** 条 | 我把 `escalated` 记账行也算成"播报"了 ⇒ 改成只数 `t=wake` 行（**口径更严**） |
| D②③ | 无嵌套键 / 深度 ≤ 1 | 首层播报的**判别子里**本来就含 `\|unconsumed-delivery\|` | 我的正则没要求 `mechanism\|` 段 ⇒ 改成"完整通知段"计数（**口径更准**） |
| C③ | `derived_escalations === 1` | **2** | 夹具里我放了**两条** depth≥1 的键，实现数得对 ⇒ 改期望为 2 |
| B⑤ | 同类重复 ⇒ 只出 **1** 条 | 出 2 条（同 id） | ★ **真缺陷**（同轮会白跑一次投递）⇒ 改**实现**：同轮同类去重 |
| F④（×2） | 终态单的 finding 会进 `suppressed`（带 `terminal-state`） | `suppressed` 是**空的** | ★ 实测发现**保护更强**：终态单根本不在那一腿的状态上 ⇒ 判据**结构性**不成立。改断言（并把这个更强的性质写进用例名） |
| F⑧ | "history 空 ⇒ 不报" | 照报（提交表本身就是本轮证据，不需要 history） | ★ 我的期望错了 ⇒ 换成真正该"不猜"的形态：**提交时间读不到** |

---

## 附：本包改动清单（可逐条核对）

| 文件 | 改动 |
|---|---|
| `lib/wakeledger.js` | 新增 `DEFAULT_MAX_ESCALATION_DEPTH=1`、`MECHANISM_NOTICE_KINDS`（**六个**类别，含追加的 `missing-transition`）、`parseWakeKey`、`escalationDepthOf`、`isMechanismNotice`；`pendingUnconsumed` 加两道闸 + 两个可选项；`status()` 加两个只读计数 |
| `lib/patrol.js` | 新增 `CONVERGED_UNRESOLVED_IDENTITY`、`SUPPRESS_REASON_LABEL`；`patrolFindings` 改为 `candidates → findings + suppressed` 两段式，加**终态整条闸** + **②③ 两道闸** + **P2-12 身份收敛** + **同轮同类去重**；返回值新增 `suppressed` / `terminal`；模块头补两节（"为什么它不会把自己变成新交付"、"但它不是少报的理由"） |
| `lib/patrol.js`（**追加那条**） | 新增 `DEFAULT_UNDELIVERED_TRANSITION_MS=10min`、`MISSING_TRANSITION_KIND='missing-transition'`、`UNDELIVERED_TRANSITION_LEGS`（三腿）、`writerSeatsOfTask`（与 `store.writerSeatsOf` 同口径）、`enteredStateAtMs`、`undeliveredTransitionOf`（纯判据），并在 `patrolFindings` 里产出候选（⇒ 自动吃到终态闸）；新增 `spec.undeliveredTransitionMs` 口径 |
| `tests/terminal-filter-check.mjs` | **新增**（53 条断言，独立可跑，密闭：套娃键与卡单形状都是**从真账本/真单逐字抄下来的夹具**，不读活体数据） |
| `tests/_a2-ab-probe.mjs` | **新增**（一次性 A/B 探针，`_` 前缀 = 与既有 `_p02-*.txt` 同族的非套件产物；不进 `run-all`） |
| `lib/*.bak-a2terminal-20261014-193814` | **新增**（改前备份，不进加载路径） |
