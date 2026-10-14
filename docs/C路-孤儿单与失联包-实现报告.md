# C 路 · 孤儿单与失联包 —— 实现报告

**口径**：只改生效副本 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-pipeline`；
本路独占的三个文件 —— `lib/orphan.js` · `lib/liveness.js` · `tests/orphan-rescue-check.mjs`。
**未装、未重启 DSH、未加依赖**；同一棵树上另有最多 3 个会话在改别的文件，本路一个字节都没碰。
**改前备份**（带时间戳、落插件目录内、不进加载路径）：
`lib/orphan.js.bak-croute-20261014-193728` · `lib/liveness.js.bak-croute-20261014-193728` ·
`tests/orphan-rescue-check.mjs.bak-croute-20261014-193728`

**一句话结论**：P1-12 已修（测试改成密闭夹具，恒定全绿）；P1-6 已复现、已修（`lib/liveness.js`）；
**P2-8 实测出一个与预期不符的真缺陷**（"最多重投 3 次"在生产形状下**从未生效**：
活体真单 `T-20261011-4a2dc7` 已投 4 次、4 条 unresolved 全是 `attempt=1/3`、0 条 `escalated`），
**已按批准修掉**（`lib/orphan.js` 的剔除表补五个名字），正例 + 两条反例全部实测通过。
最终：`orphan-rescue-check` **61/61 ×3 一致**；全量 **1513/1515**，只剩既有红 `roster-authority` 70/72。

> **本轮（第二次）追加**：用户批准执行 P2-8 的修法 ⇒ 改动 `lib/orphan.js`（本路独占文件），
> 并补齐**正例 + 反例① + 反例②**的成对验证。P1-12 / P1-6 两节的结论不变。

---

# 一、P1-12 `orphan-rescue-check` 不是密闭测试

## 1.1 现象与实测

**改前基线（本会话实测）**：`node tests/orphan-rescue-check.mjs` ⇒ **42/46**，4 条红**全部**落在 A 段。

失败原文（逐字）：

```
✗ ★★ 真单 T-20261011-4a2dc7（state=analyzing，handoffs=0，dispatched=null）被识别为**孤儿**
    未识别：不判：within-grace —— 距最后一次进展只有 4 分 2 秒（判定窗 15 分）—— 还在窗口内，不判。
✗ ★★ 真单 T-20261011-a5fe41（state=blocked，handoffs=6，dispatched=2）被识别为**孤儿**
    未识别：不判：within-grace —— 距最后一次进展只有 4 分 2 秒（判定窗 15 分）—— 还在窗口内，不判。
✗ ★ 4a2dc7 的判据是"**派活台账里根本没有这一条**"（连它在哪个会话都不知道）
✗ ★ a5fe41 的判据是"**机制阻塞 + planner 无活证据 + 会话文件不在**"（不是"人工阻塞"）
```

**"这个数字会自己变"就是它不密闭的直接证据** —— 同一份**未改动**的测试代码，三次观测到的
"距最后一次进展"分别是：

| 观测 | 数值 | 出处 |
| --- | --- | --- |
| bug 单登记时 | **26 秒** | `bug待修复单-20261014.md` P1-12 |
| 本会话基线跑 | **4 分 2 秒** | 上面那段失败原文 |
| 本会话复跑改前副本 | **11 分 54 秒** | `_cprobe/orphan-rescue-check.before.mjs` |

⇒ 断言的真值**取决于插件此刻活动到哪一步**：窗口内 ⇒ 红；窗口外 ⇒ 绿。**假红与假绿是同一台机器。**

**证据链（只读实测，未改动真单一个字节）**：

1. 两张真单的 `task.json` 落盘时刻是 **同一毫秒级批次**：
   `T-20261011-4a2dc7` = `2026-10-14T19:31:20.4483986+08:00`、
   `T-20261011-a5fe41` = `2026-10-14T19:31:20.4503981+08:00`（相差 1.6 ms）
   —— 这是**机制自己的批量写**，不是人。
2. 两张单的 `history` 末行逐字相同：
   `{"at":"2026-10-14T11:31:20Z","actor":"main","action":"wake:skipped","reason":"no-main-session",…}`
3. 把这一行剔掉之后（= 判据视图），它们的"最后一次进展"分别退回到 10-11 / 10-13，
   **远超 15 分钟判定窗** ⇒ 本来**应该**判得出来。

## 1.2 根因（文件:行）

**三个环节串成一条链，缺一个都不成立：**

| # | 环节 | 落点 |
| --- | --- | --- |
| ① | **测试**把活体真单当夹具 | `tests/orphan-rescue-check.mjs`（改前 L57-59 `REAL_PIPELINE_DIR` / `REAL_TICKETS`，L157-166 `readRealTicket`）|
| ② | "最后一次进展"取 `history` **末行** | `lib/patrol.js:96-100`（`lastProgressAtMs`：`for i from end … take(hist[i].at); break`）→ `lib/orphan.js:352-360`（`lastEvidenceAtMs`）|
| ③ | 唤醒层每轮往 `history` 写一行 `wake:skipped` | `lib/wakeup.js:101-104`（`WAKE_AUDIT.skipped = 'wake:skipped'`）+ `lib/wakeup.js:1134`（`note(taskId, WAKE_AUDIT.skipped, {reason})`）|
| ④ | ★ **判据没把这行剔掉** | `lib/orphan.js:171-179` 的 `MECHANISM_BOOKKEEPING_ACTIONS`（改后是 `:207`）；剔除动作在 `judgeView`（改后 `:230`）|

**④ 是这条链的要害**：那张剔除表里已经写着 `seat:wake-delivered` / `seat:wake-failed`
（席位侧那一半），**独独漏了 `wake:skipped`（主对话侧那一半）** —— 而它们**是同一次投递的两端**，
写的是同一件事。于是：

- 机制每唤醒一轮，"最后一次进展"就被**自己**顶到现在一次 ⇒ 15 分钟判定窗永远走不完；
- ⇒ 测试假红（本条 P1-12）；
- ⇒ **真孤儿也判不出来**（下面 P2-8 会看到更重的后果）。
- ★ ④ **已在 P2-8 那一步修掉**（用户批准；剔除表补五个名字，`lib/orphan.js:212-216`，见 §2.3）。
  P1-12 本条自己**只改测试**（把 A 段改成密闭夹具）—— 两件事互不依赖，各自都能独立站住。

## 1.3 修法与验证（正例反例）

**改法（只动测试，判据侧一个字没改 —— 见 §四"没做的"）**：A 段改成**夹具自造临时任务目录**，
照 `station-reject-check.mjs` 的做法。

- 新增两个夹具原语：`tests/orphan-rescue-check.mjs:181`（`patchTaskFile`：把**本测试自己那张临时单**的
  `task.json` 改成现场形状，再让 store 按"盘比内存新 ⇒ 重载"读回来）、
  `:190`（`readTaskFile`：**从盘上**读回来 —— 不是内存里捏对象）。
- 形状①（= `4a2dc7`）：`state='analyzing'`、**`delete t.dispatched`**（真单的关键特征是
  "这个字段压根不存在"，不是"它是 null"）、全零、`history` 只剩一行 40 分钟前的 `main` 流水。
- 形状②（= `a5fe41`）：`state='blocked'` + `liveness.escalations=[{to_state:'blocked', seats:['planner']}]`
  （**机制自己触发的阻塞**）、planner 的会话 id 是**裸 UUID**（`session-…-…`，故意不是 `session-…` 形状）、
  6 份交接物**全归 orchestrator**（⇒ planner 自证零证据）。
- ★ **断言条数与语义都没动**：A 段仍是 6 条，正例断言（判词 `orphan-seat-gone`、
  detail 里"派活台账里根本没有这一条"、`evidence.seats[0].session_present === false`、
  "不是 `seat-turn-aborted`"）逐字保留。

**正例**：两个夹具都被判孤儿，判词与判据原文与改前**完全一致**。
**反例**：D 段那 10 条反例（正常闲置 / 等澄清 / 终态 / 刚唤醒过 / 会话还在长 / 有活证据 /
人工阻塞 / 窗口内 / 机制记账行不算活证据 / 判据是纯函数）**一条没删、一条没放宽**，全部仍绿。
**另外那一条更严了**：第 3 条断言现在真的去核对"从盘上读回来的那份文档**是不是真形状**"
（`dispatched` 字段不存在、②有 6 份交接物、planner 的 id 不是 `session-` 形状）——
这比改前那句"文件读得到"**更严**，不是更松。

## 1.4 测试改前 / 改后（含跑三次一致）

| | 改前副本（`_cprobe/orphan-rescue-check.before.mjs`） | 改后（`tests/orphan-rescue-check.mjs`） |
| --- | --- | --- |
| 第 1 次 | **42/46** | **53/53** |
| 第 2 次 | **42/46** | **53/53** |
| 第 3 次 | **42/46** | **53/53** |
| 退出码 | 1 | 0 |

⇒ **改后跑三次完全一致（53/53，exit=0）**，且与插件是否在活动、真单处于什么状态**无关**。

`run-all` 全量对照：

| | 总计 | 未满的套件 |
| --- | --- | --- |
| 改前 | 1467/1473 | `roster-authority-check` 70/72（**既有已知红**）+ `orphan-rescue-check` 42/46 |
| 改后 | **1505/1507** | **只有** `roster-authority-check` 70/72（既有已知红）|

⇒ **没有出现任何新的红**。（全量总数里还含着同一棵树上另外几个会话并行改动的增量，
本路只对自己那三个文件负责。）

## 1.5 未做活体验证

- **没有**在活体单上验证"插件不再写 `wake:skipped` 之后真孤儿能不能被判出来" ——
  剔除表本身**已在本轮 P2-8 那一步修掉**（`lib/orphan.js:207`，见 §2.3），
  而那一步的验证面是**同形夹具，不是活体**（插件没重启，线上仍是旧代码在跑）。
- 本条的验收（恒定全绿、跑三次一致）**已达成**。

---

# 二、P2-8 孤儿单 attempt 用尽（3 次）之后的行为

## 2.1 现象与实测

探针：`_cprobe/p28-probe.mjs`（真 store / 真 `createOrphanRescue` / 真 `createSeatNotifier` /
真账本，只有目标是替身通道）。**三个实测，两个结论。**

### 实测①：单元形状 —— **三问的答案都是"是"**（`maxAttempts=3` = **线上默认**，`backoffMs=0`）

```
第 1 轮：动作=failed   身份=…|orphan-seat-gone|analyzing|11:00:06Z   notify=1  unresolved=1  播报=0
第 2 轮：动作=failed   身份=（同一个）                                  notify=2  unresolved=2  播报=0
第 3 轮：动作=failed   身份=（同一个）                                  notify=3  unresolved=3  播报=0
第 4 轮：动作=abandon  身份=（同一个）                                  notify=3  unresolved=3  播报=1
第 5 轮：动作=skip     理由=这一条孤儿身份**已经放弃**（连续投不出去到上限）—— 不再骚扰。
第 6 轮：动作=skip     （同上）
审计动作序列：orphan:detected → orphan:redeliver-failed → …（×3）→ orphan:redeliver-abandoned
```

- **① 落 `orphan:redeliver-abandoned`：是。** 原文
  `{"orphan_id":"…|orphan-seat-gone|analyzing|…","kind":"orphan-seat-gone","attempts":3,"reason":"已经投失败 3 次（上限 3）"}`
- **② 停手：是。** 账本 `markEscalated` 落到
  `{"t":"escalated","key":"…","escalation_key":"…|abandoned|3","reason":"已经投失败 3 次（上限 3）"}`；
  之后每轮都是 `skip`，`notify` 恒 3、`unresolved` 恒 3、播报恒 1。
- **③ 播报：是。** `{"kind":"orphan-abandoned","disc":"…|orphan-seat-gone|analyzing|…","what":"**孤儿单自恢复：投不出去（已放弃）**"}`

⇒ **这三条＝"已验证"。**（注意：既有测试 `C 段` 用的是 `maxAttempts:2`，本轮补了**线上默认 3** 的那一档，
落在新加的 `C2` 段。）

### 实测②：生产形状 —— ★ **限次不生效，永不 abandon**

把**唤醒层真的会写的那一行** `wake:skipped` 在两次重投之间记进 `task.history`
（本机两张真单的 history 末行逐字就是它），并让每轮隔开 1.1 秒（生产里两次重投至少隔 30 分退避，
留痕必然落在不同的秒上）：

```
── 对照组：**不写** wake:skipped ──
   身份时刻序列 = [11:00:42Z, 11:00:42Z, 11:00:42Z, 11:00:42Z, 11:00:42Z]   ⇒ 身份换了 0 次
   第 4 轮 abandon ⇒ 落到 orphan:redeliver-abandoned：**是**；notify 总次数=3

── 生产形状：**每轮都写** wake:skipped ──
   身份时刻序列 = [11:00:42Z, 11:40:42Z, 11:40:43Z, 11:40:44Z, 11:40:45Z, 11:40:46Z]  ⇒ 身份换了 5 次
   6 轮全部 failed ⇒ 落到 orphan:redeliver-abandoned：**否 —— 6 轮都没到上限**；notify 总次数=6
```

两组**只差"写不写那一行"**（`graceMs=0` / `backoffMs=0` 让判定窗与退避都不是变量）。
⇒ 那一行每写一次，孤儿身份就换一个；身份一换，`attemptsOf(taskId, id)` 就从 0 重新数 ⇒ **永远到不了 3**。

### 实测③：活体真单只读回放（`T-20261011-4a2dc7`，一个字节都没写）

它的 `wake-ledger.jsonl` 里 **4 条 unresolved，`attempt` 全是 `1/3`**，`id` 四个全不同：

```
at=2026-10-13T18:13:42Z  attempt=1/3  id=…|analyzing|2026-10-11T10:00:40Z
at=2026-10-14T10:36:20Z  attempt=1/3  id=…|analyzing|2026-10-13T18:18:42Z
at=2026-10-14T10:56:20Z  attempt=1/3  id=…|analyzing|2026-10-14T10:41:20Z
at=2026-10-14T11:26:20Z  attempt=1/3  id=…|analyzing|2026-10-14T11:11:20Z
escalated 行数 = 0
```

四次尝试能看到的"判据视图末行"分别是 `reattach` / `wake:skipped` / `wake:skipped` / `wake:skipped`
⇒ **四次身份全不同**，每次都是"第 1 次"。

## 2.2 根因（文件:行）

**与 P1-12 是同一个缺陷**（同一张剔除表），只是后果重得多：

- `lib/orphan.js:566` —— 孤儿身份的构成：
  `` const id = (kind) => `${taskId}|orphan|${kind}|${state}|${isoAt(cand.last.atMs)}` ``
  ⇒ 身份里**嵌了"最后一次进展时刻"**；
- `lib/orphan.js:352-360`（`lastEvidenceAtMs`）→ `lib/patrol.js:96-100` —— 那个时刻取的是
  `judgeView(task).history` 的**末行**；
- `lib/orphan.js:171-179` —— `MECHANISM_BOOKKEEPING_ACTIONS` 里有 `seat:wake-*`、`orphan:*`，
  **没有 `wake:skipped`（也没有 `wake:delivered` / `wake:failed` / `wake:dedup` / `wake:escalated`）**；
- `lib/orphan.js:818`（`attemptsOf`）—— 失败次数**按身份 id 从账本里数**
  （`if (String(e?.detail?.id ?? '') !== id) continue`）；
- `lib/orphan.js:832`（`gateFor`）—— `attempts >= maxAttempts` 才 `abandon`。

⇒ **链**：重投失败 → 落 `unresolved` → **既有巡检**把它当"该叫没叫"播报 → 唤醒层投不出去
（本机就是 `no-main-session`）→ 写一行 `wake:skipped` → 下一轮"最后一次进展"变成这一行 →
**身份换新** → `attemptsOf` 归零 → 再投一次 …… **闭环，无出口。**

**这条链的严重性（本路实测到的量级）**：它同时解释了
① 活体真单被**无限重投**（每 20–30 分钟一次，已 4 次、仍在继续）；
② **`orphan:redeliver-abandoned` 与那条"放弃"播报永远不会发生** ⇒
   **"看得见的失败"这一层实际上是缺失的**（用户永远等不到"这条投不出去了，请人来处置"）。

## 2.3 修法与验证（★ 已修 + 正反例结果）

> **状态更新（本轮）**：用户已批准执行，**已修**。下面 2.3.1 是补的名字，2.3.2 是正反例实测结果。

### 2.3.1 补的五个名字（逐条：名字 + 依据）

改的是 `lib/orphan.js:207` 的 `MECHANISM_BOOKKEEPING_ACTIONS`（**本路独占的文件**，
不是别人的 —— `lib/wakeup.js` / `lib/patrol.js` 只被**引用**，一个字节没动）。
新增位置：`lib/orphan.js:212-216`。

| # | 补的名字 | 依据（谁写的 / 哪一行） | 为什么**必须**剔 |
| --- | --- | --- | --- |
| 1 | `wake:skipped` | `lib/wakeup.js:103` 定义；`lib/wakeup.js:1134` 的 `skip()` 写出 | ★ **主犯**：本机两张真单 `history` 的**末行**就是它，把"最后一次进展"顶到当下 |
| 2 | `wake:delivered` | `lib/wakeup.js:102` 定义；`lib/wakeup.js:1459` 写出 | 投成功也是**机制在说话**，不是任务在进展 |
| 3 | `wake:failed` | `lib/wakeup.js:104` 定义；`lib/wakeup.js:1408` / `:1435` 写出 | 同上 |
| 4 | `wake:dedup` | `lib/wakeup.js:112` 定义；`lib/wakeup.js:1281` / `:1351` / `:1370` 写出 | "被幂等吃掉"同样是机制自己的记账 |
| 5 | `wake:escalated` | `lib/wakeup.js:116` 定义（R1 的升级叫醒） | 同上；而且它**会因为"上一条没人接管"而再写一条**，正是最容易把窗口顶走的那种 |

它们与**已经在表里**的 `seat:wake-delivered` / `seat:wake-failed` 是**同一次投递的两端**
（`lib/wakeup.js:118-119`）—— 补这五个是把表**补齐**，不是新增一类口径。
写入路径也是同一条：`note()`（`lib/wakeup.js:1101-1108`）→ `store.recordAudit`
（`lib/store.js:7794`，里面 `task.history.push(entry)`）。

★ **刻意不剔的三类**（剔了会**削弱**判据）：

- `wake:consumed`（`lib/wakeup.js:114`）—— 它由 `markConsumed`（`lib/wakeup.js:1594`）
  写进**账本**，**根本不进 `task.history`**；而且语义是"主对话**真的**带着这条投递动了"。
  ⇒ 既不需要剔，也不该剔。
- `seat:wake-consumed`（`lib/wakeup.js:121`）—— 席位**接管**留痕（A28：送达 ≠ 接管），
  "有人真的动了手"正是活证据。
- 任何**人工 / 席位真的做过**的动作（`transition:*` / `reattach` / 交接物 …）——
  一个字都不剔，判定窗照样被它们重新起算（下面反例②有专门一条断言钉这一点）。

### 2.3.2 正例与两条反例（实测结果）

全部落在 `tests/orphan-rescue-check.mjs` 的 **`C3` 段**（`:632` 起，8 条断言）。
★ 下面那条 `wake:skipped` 是**同形夹具，不是活体**：它复刻真单那一行的**形状与写入路径**
（`lib/wakeup.js:1134` → `store.recordAudit` → `history.push`），数据全落在本测试自己的
**临时任务目录**里，不读任何真单、不碰任何真单。

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| **正例**（生产同形） | 每轮失败之后**真的写一行** `wake:skipped` ⇒ 身份**不再被换掉**，第 3 次失败之后（第 4 轮）落 `orphan:redeliver-abandoned` | ✅ **是** —— 前四轮动作 = `failed/failed/failed/abandon`，**身份去重数 = 1** |
| **正例**（续） | 放弃那一刻落审计 `orphan:redeliver-abandoned`（`attempts:3`）+ 账本 `markEscalated` + **播报一次** `orphan-abandoned` | ✅ **全部为真**（"看得见的失败"这一层恢复了）|
| **正例**（续） | 放弃之后**彻底停手**：再扫两轮 `skip`，notify 恒 3 / unresolved 恒 3 / 播报恒 1 | ✅ 不再无限重投 |
| **反例①** | **不同任务不许被合并**：两张单各失败 2 次 ⇒ **各自**是 2（不是 4），每条 unresolved 的 `detail.id` 只属于自己那张单 | ✅ 2 / 2，`detail.id` 无一条跨单 |
| **反例①**（续） | **两边都还没被放弃**（各 2 < 上限 3）—— 证明是"每个身份一本账"，不是"整单一个计数器" | ✅ notify 合计 = 4 = 2+2 |
| **反例①**（续） | **同一张单、身份变了 ⇒ 新身份从 0 起算**（真实进展之后重新卡住 = 新的一条，不把旧账接着算） | ✅ 三轮全 `failed`（**没有**误判成 abandon），身份数 = 2，新身份只记 1 次 |
| **反例②** | **正常推进的单**（刚交过一份真实交接物）⇒ **不判孤儿**，且 **一个 attempt 都不消耗**（notify / unresolved 均为 0） | ✅ |
| **反例②**（续） | **判定窗没有被关掉**：真实动作 `transition:dev_submitted` 仍在表外、仍能让窗口**重新起算**（`within-grace`）；`wake:consumed` / `seat:wake-consumed` **不在**剔除表里 | ✅ 判据视图仍留 2 行真实动作 |

★ **回归锁是真的**（不是假绿）—— 把 `lib/orphan.js` 临时换回**改前那一份**再跑同一套测试：

```
改前那份 orphan.js ⇒ 总计：57/61 通过（exit=1），4 条干净判红（不是崩溃）
  ✗ 正例·生产同形 … 前四轮动作=failed/(未判)/(未判)/(未判)（应 failed/failed/failed/abandon）
                     身份去重数=2（应恒为 1）
  ✗ 放弃那一刻落审计 + 账本 markEscalated + 播报一次
  ✗ 放弃之后彻底停手
  ✗ 判定窗没有被关掉 / 五个名字在表里
恢复改后那份 ⇒ sha256 与改动前逐字节一致（5BF5BE0D…）
```

⇒ 这四条在**没有这个修复时确实会红**，而且红得**干净**（断言级，不是异常）。
★ 为了让"改前会红"测得出来，夹具里每轮之间**真等 1.1 秒**：留痕是**秒级**的，
同一秒内写多少次都只算同一个身份 —— 不隔开的话这条用例就会变成假绿。

## 2.4 测试改前 / 改后

| | 改前 | 改后 |
| --- | --- | --- |
| `orphan-rescue-check` | 42/46 | **61/61**（×3 一致，exit=0）|
| 其中 P2-8 覆盖 | `maxAttempts=2` 一档（C 段） | 追加 **`maxAttempts=3`（线上默认）** 一档（`C2` 段，3 条）＋ **`C3` 段 8 条**（正例 3 + 反例① 3 + 反例② 2）|
| 既有 53 条断言 | — | **一条没删、一条没放宽**，53 → 61 是**纯新增** |
| `run-all` 全量 | 1505/1507（只剩既有红 `roster-authority` 70/72）| **1513/1515**（`+8` = 新增的 8 条；**仍然只剩** `roster-authority` 70/72）|

## 2.5 未做活体验证

- **没有**在活体单上观测"修完之后它真的会放弃" —— 原因很实在：
  **插件没有重启**（本次纪律禁止），所以**线上跑的还是旧代码**，活体真单不构成验证面。
  本条的验证面是**同形夹具**（形状与写入路径都复刻，见 2.3.2 的免责声明），**不是活体**。
- **没有**验证 `wake:delivered` / `wake:failed` / `wake:dedup` / `wake:escalated` 这四条
  各自的"顶走身份"效果 —— 探针与用例只跑了 `wake:skipped` 这一支（最常发的那一支）。
  它们是**同一次投递的同一族留痕、写入路径逐字相同**，所以按同一判据剔除；
  但**逐条实测没有做**，如实标"仍未验证"。
- **没有**动 `lib/patrol.js`（别人分到的文件）：`patrolFindings` 的 `task-stall`
  用的是**未经 `judgeView`** 的 `lastProgressAtMs`，所以"机制自己的 `wake:skipped`
  会不会也把巡检的无进展口径顶走"这件事**不在本修复范围内**，本路也没碰它。

---

# 三、P1-6 「正在写交付」的席位仍可能被判失联并冻结

## 3.1 现象与实测

**探针**：`_cprobe/p16-probe.mjs`。**真的 store + 真的 `store.checkLiveness(escalate:true)` +
盘上真的 `session.v4.jsonl.zstd`**（只有"会话根"是临时目录，用 `DSH_SESSIONS_DIR` 指过去）。

**构造的形状**（= 报告里点名的那一个）：任务停在 `developing`；`writer#1` 派活于 **40 分钟前**；
台账里 **0 交接物**（它正要交的那一份**还没落盘**）；会话日志存在，`mtime` = **8 秒前**
（它此刻正在写）。行话：**"席位写完报告、正要交交接物的那几十秒"。**

**改前实测 —— 仍然会被判死（复现成功）**：

| 变体 | 上次采样 | 这段增量 | 会话日志 mtime | 改前结果 |
| --- | --- | --- | --- | --- |
| **V1** | 60 秒前 | **+300 B** | **8 秒前** | ★ **冻结**（`state=blocked`）|
| **V5** | 25 秒前 | **+300 B** | **8 秒前** | ★ **冻结** |
| **V6** | 59 秒前 | **+1023 B** | **8 秒前** | ★ **冻结** |
| V2 | 60 秒前 | +5 KB | 8 秒前 | 安全 |
| V3 | 5 分前（跨窗）| +0 B | 8 秒前 | 安全 |
| V4 | 从没采样过 | — | 8 秒前 | 安全 |
| V7 | 59 秒前 | +1024 B | 8 秒前 | 安全 |

判据原文（V1）：`会话日志没长（1 分 内 +300 字节 < 阈值 1024）`，且 `conclusive=t`。

⇒ **"写完报告、正要交交接物的那几十秒"这个形态，改前仍会被【一次观察】判失联并冻结** ——
交接物交不上去，正是 `T-20261012-6884af` 丢掉那份 `test_to_review` 的形状。

**改后实测**：V1 / V5 / V6 **全部 `state=developing`（不冻）**；V2/V3/V4/V7 不变；
V8/V9（真死）**仍然冻结**；V12/V13（`mtime` 刚过 60 秒）**仍然冻结**。

## 3.2 根因（文件:行）

**两处，缺一不可：**

| # | 落点 | 问题 |
| --- | --- | --- |
| ① | `lib/liveness.js:185` `activityOfSamples` —— **"两次采样落在同一活动窗口内"那一格**（改前 L235-245）| `fresh`（`mtime` 新鲜度）在上面三条分支里**都被认**（首次采样 / 跨窗），**只有这一格把它丢掉了**，而且回的是 `conclusive: true` |
| ② | `lib/liveness.js:592`（改前 L563）`seatLiveness` 的 `silentHere = timedOut && isExpected && evidence === null && !alive` | `alive = act.grew === true`（只看 1024 B 字节增量）；`conclusive:true` 又**绕过确认门**（`:578`，改前 `:549`）⇒ **一次观察即冻结** |

也就是说：**同一次观察里，"字节增量说它没长"与"mtime 说它 8 秒前刚被写过"同时成立，
而判死那一侧只听了前一句。**

实时序（真实时间线）：席位用 `write` 交报告 → 那次工具调用触发一次失联检测（采样 S1）→
几十秒后席位调 `pipeline_handoff` → 预执行缝（`lib/intercept.js:449`）**先**跑一次失联检测
→ 采样 S2 与 S1 相隔 < 2 分、增量 < 1024 B ⇒ `grew:false, conclusive:true` ⇒
**在交付调用发出之前**把任务推成「已阻塞」⇒ 那份交付被拒。

## 3.3 修法与验证（正例反例）

**改法（`lib/liveness.js`，+73 行 / -6 行）**：

1. `activityOfSamples` 把 `fresh` / `fresh_age_ms` 作为**独立字段**报出去（四个 return 都带），
   并写明"`fresh:true` 与 `grew:false` **可以同时为真**，那种组合不许被读成'它死了'"。
   ★ **`grew` 的语义一个字没改** —— 这是刻意的：
   `quickfix-20261013-check.mjs:226-236`（"同窗内只长了 100 字节 ⇒ grew=false，既有断言不回退"）
   与 `t14-fix-check.mjs:207-212`（"活动阈值是实数 1024 B"）**钉着它**，
   所以正确做法是**拆成两个互不冒充的结论**，而不是把 `grew` 改松。
2. `seatLiveness`（`:591-592`）：
   ```js
   const freshWrite = act.fresh === true
   let silentHere = timedOut && isExpected && evidence === null && !alive && !freshWrite
   ```
   并且这一次观察**不累计**"连续安静"计数（`quiet_streak` 归零）——
   席位刚回来动了一下，不该把它之前那段安静接着数下去。
3. 座位记录里多两个可审计字段：`fresh_write` / `quiet_evidence`，
   `activity` 里多 `fresh` / `fresh_age_ms`。

**正例（改后实测）**：V1 / V5 / V6 三种"正要交交付物"的形状**全部不判失联**（见 3.1）。
**反例（不许放宽 —— 逐条实测）**：

| 反例 | 结果 |
| --- | --- |
| 同一形状，`mtime` 推到 **70 秒**前 | ★ **照旧判失联**（`fresh=false`）|
| 同一形状，`mtime` **60.5 秒**前 | ★ **照旧判失联** |
| 真死：跨窗 +0 字节 + `mtime` 40 分钟前 | ★ **照旧一次判死** |
| 真死：同窗 +0 字节 + `mtime` 40 分钟前 | ★ **照旧一次判死** |
| 真死 + `quiet` 已累计 1 | ★ **立刻冻结** |
| 日志采不到（`known:false`）| 照旧走确认门（pending）—— 没被改成"活着" |
| 边界：`mtime` 正好 60.0 秒 | 算"刚刚被写过"（**窗口是闭合的**，与 `<= freshMs` 的实现一致）|

**铁律核对**：

- **静默阈值（5 分钟）一个字没动** —— `lib/liveness.js:62` `DEFAULT_SEAT_SILENCE_MS = 5*60*1000`，
  本路没碰；新增断言 `E2` 第 3 条**把这个数钉住**（`=== 5*MIN` 且新鲜窗 `=== 60*1000`）。
- **既有反例不许放宽** —— 上表真死反例全部照旧判死；`t14-fix-check`、`liveness-check`、
  `quickfix-20261013-check` 全绿（全量跑无新红）。
- 60 秒这条线本来就在注释里写着"**必须远小于静默阈值，否则等于把检测关掉**"
  （`lib/liveness.js:131-136`）—— 本修复把这个界守住了，没有把它放宽成"多久都算活"。

## 3.4 测试改前 / 改后（含跑三次一致）

新增 `E2` 段（`tests/orphan-rescue-check.mjs:783`，4 条断言），把 P1-6 的形态钉成回归：

1. ★★ 正例：台账 0 证据 + 日志 **8 秒前刚被写过** + 这段增量 < 1024 B ⇒ **不判失联、不冻结**，
   且同时断言 `activity.grew === false`（**证明修的是判死口径，不是把字节阈值改松**）；
2. ★★ 反例：同形状但 `mtime` 过新鲜窗（70 秒）⇒ 判失联；真死（跨窗 +0 B + mtime 陈旧）⇒ 也判失联；
3. ★★ 阈值未动：静默 5 分、新鲜窗 60 秒；
4. ★ 边界闭合：60.0 秒不判死、60.5 秒判死。

`orphan-rescue-check` 在本条与 P1-12 那一步之后是 **53/53，连跑三次完全一致**；
P2-8 修复那一步又**纯新增**了 8 条（`C3` 段），最终 **61/61，仍连跑三次一致**（见 §2.4）。

## 3.5 未做活体验证

- **没有在活体会话上跑**（需要真席位 + 真会话日志）。探针用的是真 store、真
  `checkLiveness(escalate:true)`、盘上真日志文件，**只有会话根是临时目录**。
  "席位在真实 GUI 里点下 `pipeline_handoff` 那一刻不再被冻"这句话，
  本路**没有**在活体上观测到，标**仍未验证**。
- ⚠️ **同一根因的第二处落点，本次未改**：`lib/orphan.js:489`
  `const sessionStatic = act.known === true && act.conclusive === true && act.grew === false`
  —— 它同样**不看 `fresh`**。后果：一个"日志刚被写过、但这段增量小于 1024 B"的席位，
  在**孤儿判据**里仍可能被读成"会话日志经实测**不再变化**"，进而在 15 分钟判定窗后被判孤儿
  并发一条重投（不冻、不改状态，噪音级）。本路把它留在这里没动，
  因为它超出 P1-6"在 `liveness.js` 里修"的口径。

---

# 四、做了什么 / 没做什么（边界自陈）

**改了的（只有这三份，都在本路独占名单里）**

| 文件 | 改动 |
| --- | --- |
| `tests/orphan-rescue-check.mjs` | A 段改成自造临时任务目录（P1-12）；新增 `C2`（P2-8 实测，3 条）、`C3`（P2-8 修复的正例+两反例，8 条）、`E2`（P1-6，4 条）三段 |
| `lib/liveness.js` | +73 行 / -6 行：`activityOfSamples` 报出 `fresh`；`seatLiveness` 用它挡住"正在写交付"的一次判死（P1-6）|
| `lib/orphan.js` | 只改一处：`MECHANISM_BOOKKEEPING_ACTIONS`（`:207`）补上主对话侧那五个名字（`:212-216`）+ 配套注释（P2-8 修复）|

**★ 边界核对（用户点名的那几份，本路一个字节都没碰）**

`lib/patrol.js` · `lib/wakeledger.js` · `lib/handoff.js` · `lib/hashgate.js` · `lib/store.js`
—— 全部**只被引用**（读行号、读调用点），没有写入。
本修复所在的 `MECHANISM_BOOKKEEPING_ACTIONS` 在 **`lib/orphan.js`**，属于**本路独占**的三个文件之一
⇒ **没有越界，不需要"停手转交"**。核实方式：这三个文件的 sha256 与备份对照，
`lib/orphan.js` 的改动**有且只有**那一处表格 + 注释。

**没做的（有意，逐条给理由）**

1. **没改 `sessionStatic`**（`lib/orphan.js:489`，§3.5）—— 它是同一根因的第二处落点，
   但 P1-6 的口径指名"在 `liveness.js` 里修"，且动它会**改变孤儿判定**，本路不越界。
2. **没改 `lib/patrol.js`** —— `patrolFindings` 的 `task-stall` 用的是**未经 `judgeView`**
   的 `lastProgressAtMs`，所以"机制的 `wake:skipped` 会不会也顶走巡检的无进展口径"
   **不在本修复范围内**（该文件也不在本路名单里）。
3. **没加依赖、没装、没重启**；没有给别的会话的文件做过任何写入
   （全量跑确实会刷新 `tests/*-last-run.txt` 与 `tests/last-run.txt`，那是测试台**自己**的产物）。
4. 探针与对照副本落在 `_cprobe/`（**不进加载路径**）：
   `p16-probe.mjs`（P1-6，19 个变体）、`p28-probe.mjs`（P2-8，三组）、
   `orphan-rescue-check.before.mjs` + `selftest-core.mjs`（改前副本，用来重跑对照）、
   `orphan.js.postfix`（改后副本，用来做"换回改前 ⇒ 判红"的双向验证）、
   `full-run-1.txt` / `full-run-2.txt` / `pre-fix-c3.txt`（全量原始输出与改前对照）。

**恢复方式**：三份备份都在原位旁（`*.bak-croute-20261014-193728`），
直接 `Copy-Item` 覆盖回去即可（`lib/orphan.js` 覆盖回去 = 退回"限次不生效"的旧行为）；
改前副本另有一份在 `_cprobe/` 可直接独立运行。

---

# 五、简报（≤150 字）

**补了哪五个**：`wake:skipped` · `wake:delivered` · `wake:failed` · `wake:dedup` · `wake:escalated`
（逐条对应 `lib/wakeup.js:102/103/104/112/116` 的 `WAKE_AUDIT`，与表里已有的 `seat:wake-*` 是同一次投递的两端）。
`wake:consumed` 只进账本、不进 `history`，**刻意不补**。

**正例**：生产同形夹具（每轮真写一行 `wake:skipped`）**真到 abandoned 了** ——
`failed/failed/failed/abandon`，身份去重数 1，账本 `markEscalated` + 播报一次 + 之后彻底 skip。
（同形夹具，**不是活体**：插件没重启。）

**反例①**（不串台）：两单各失败 2 次 ⇒ 各自 2 不是 4，`detail.id` 不跨单；身份换了从 0 起算。✅
**反例②**（正常推进）：刚交交接物的单不判孤儿、**0 attempt**；真实动作仍能重新起算判定窗。✅

**测试对照**：53 → **61/61**（纯新增 8 条，×3 一致）；全量 1505/1507 → **1513/1515**，仍只剩既有红
`roster-authority` 70/72。换回改前那份 ⇒ **57/61 干净判红**，回归锁是真的。

**越界**：无。改的 `MECHANISM_BOOKKEEPING_ACTIONS` 在 `lib/orphan.js`（本路独占）；
`patrol/wakeledger/handoff/hashgate/store` 一个字节没碰。
