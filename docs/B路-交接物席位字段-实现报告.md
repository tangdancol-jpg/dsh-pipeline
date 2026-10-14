# B 路 · 交接物补席位信息（bug 单 P2-7 `from_seat`）实现报告

- **改动文件（独占，只此一个）**：`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-pipeline\lib\handoff.js`
- **新增验证文件**：`...\dsh-pipeline\tests\handoff-seat-check.mjs`（新增，未改任何既有断言）
- **另加一行注册**：`...\dsh-pipeline\tests\run-all.mjs` 的「按约定名发现」注册表（纯追加 1 条 + 注释）
- **改前备份**：`...\dsh-pipeline\lib\handoff.js.bak-p27-20261014-193811`（113,706 B，SHA-256 `6D0F2D15…57CA4F`，与改前正式件逐字节相同）
- **纪律**：未安装、未重启 DSH、未加依赖、未改别的文件、未删任何既有测试、未放宽任何断言
- **时间**：2026-10-14

---

## 1. 根因核实（已核实，与 bug 单一致）

**bug 单原文**：`T-20261012-8cdee0` 的 22 份 handoffs 全部没有 `from_seat` 键（不是 `null`，是压根不存在）；根因定位在 `buildHandoffRecord`（`lib/handoff.js:1989-2008`）。

**核实方式 ①（读码）**：改前 `buildHandoffRecord` 的返回体字段只有
`handoff_id / task_id / kind / kind_zh / from_role / to_role / created_at / artifact_version / payload / content_hash`
—— **确实没有任何席位字段**。行号与 bug 单基本吻合（改前实际落在 `1996-2015`，bug 单写 `1989-2008`，差的是上面那段 JSDoc）。

**核实方式 ②（读真单，只读）**：直接读 `%USERPROFILE%\.dsh\profiles\desktop\.pipeline\T-20261012-8cdee0\task.json`：

```
handoffs = 22
带 from_seat 键的条数 = 0          ← 与 bug 单逐字一致
记录字段集合 = ["handoff_id","task_id","kind","kind_zh","from_role","to_role",
               "created_at","artifact_version","payload","content_hash","file"]
各 kind 分布 = requirement_analysis×7, human_request×4, plan×3, orchestration×1,
              clarification_request×1, dev_to_test×2, test_to_dev×1,
              test_to_review×1, review_verdict×1, architecture_diagram×1
from_role 取值 = orchestrator, planner, writer, tester, reviewer, diagrammer
```

⇒ **根因成立**：字段压根不写，所以按 `=== null` 筛选不出来，"哪个席位交的"只能回审计日志反查 `seat:submit`。

**核实中额外发现的一件事（bug 单没写，但它决定了修法）**：
真单里那两份 `dev_to_test` 的 **`payload.partition.seat` = `"writer#1"`** —— 席位信息**其实早就落在载荷里了**，只是从来没有被提到记录层。这解释了为什么"补字段"可以不猜、不硬编码。

---

## 2. 数据来源（★ 不猜、不硬编码）

新增一个纯函数 `resolveHandoffSeat(input)`，**三级来源、按权威性降序**：

| 级别 | 来源 | 为什么它是可信的 |
|---|---|---|
| ① | **令牌席位**：`input.fromSeat` / `input.actorSeat` | 唯一凭据来源。口径与 `store.submitHandoff` 里澄清请求那条**逐字一致**：「席位只从令牌来，不让调用方在 payload 里自报 —— 那是第二个真相源，而"谁问的"必须由凭据决定」 |
| ② | **`payload.partition.seat`**（只有 `dev_to_test` 有这个字段） | ★ **它不是自报值**：store 层 `checkSeatOwnership` 会拿**令牌席位**与它逐字核对，不一致直接 `SEAT_MISMATCH` 拒收；调用方没给时，它由**角色清单的分区表**（`roster.writers.partitions[].seat`）回填。⇒ 能走到这里，它已经是"令牌核对过的在册席位" |
| ③ | **角色名**（`fromRole`） | 单席位角色（`tester` / `reviewer` / `planner` …）本来就只有**一个**席位，那个席位的名字就是角色名。与项目既有口径同源（`liveness.seatKey(role, seat) = seat || role`，注释见 `lib/liveness.js:331-334`） |

**★ 为什么调用方没传令牌席位也能立刻生效（这一点必须写清，否则会被误读成"绕过了凭据"）**：
本次只被授权改 `lib/handoff.js`，而 `store.js` 的两处调用点（`submitHandoff` 与计划分配）**没有**把 `input.actorSeat` 传进 `buildHandoffRecord`。所以：
- **今天**：由 ② 兜住 —— 而 ② 在 `dev_to_test` 上**已经被令牌核对过**（见上表），不是第二个真相源；
- **接线之后**：store 只要把 `actorSeat` 传进来，① 自动优先，**`handoff.js` 一个字都不用再改**（参数口子已经留好，且优先级就是按凭据优先排的）。

**一条硬边界（写进代码注释，并有反例钉住）**：只读 `payload.partition.seat`，**绝不读 `payload.from_seat`** —— 后者在 `seat_handover`（席位继任）里是「**旧**席位」的意思，同名不同义，混用会把"交的人"写成"被接班的那个人"。

**落在记录上的形状**：`from_seat` 与 `from_role` 成对，取值 `writer#2` / `writer#1` / `tester` / `planner` …；连角色都取不到时**如实给 `null`**（不编造假席位）。

---

## 3. 向后兼容说明

1. **旧交接物不迁移、不重写**：本次改动只作用于**新写**的记录；盘上已有的 22 份（以及任何历史单）**一个字节都没动**，也不会在读取时被回写。
2. **读的时候缺字段能正常工作**：`summarizeHandoff` 内部对"没有这个键"的记录按**同一条口径**推导着显示（`dev_to_test` ⇒ 从 `payload.partition.seat` 推；其余角色 ⇒ 角色名），所以旧的 dev_to_test 读出来是 `writer#1`。**推导只发生在返回值里，不落盘**（有断言钉住：读完之后那个旧对象上仍然没有 `from_seat` 键）。
3. **只增字段，既有字段一个不动**：只读导出的摘要字段集合 = 既有 9 个 + `from_seat`（有断言逐字段比对）：

```
改前：handoff_id, kind, kind_zh, from_role, to_role, created_at, artifact_version, summary, redacted
改后：handoff_id, kind, kind_zh, from_role, from_seat, to_role, created_at, artifact_version, summary, redacted
```

4. **载荷零污染**：`payload` 原样（`partition.seat` 不变、也没有往 payload 里塞 `from_seat`）。
5. **纯新增，零删除**：与备份逐行对比 —— **删除 0 行、新增 74 行**（全部是注释与三处新代码：常量 + 解析函数 + 两处 `from_seat:`）。

---

## 4. 正例 / 反例（可跑）

新增 `tests/handoff-seat-check.mjs`，并在 `tests/run-all.mjs` 的「按约定名发现」注册表加 1 条（该注册表本就是给"约定名放好即被跑到"用的，纯追加，不改既有项）。
**27/27 通过**（独立跑法：`node -e "import('./tests/handoff-seat-check.mjs').then(async m=>{const r=await m.runHandoffSeatCheck();console.log(r.text)})"`）。

| 组 | 用例 | 判据 |
|---|---|---|
| **A 正例 · 多席位** | writer#2 交 `dev_to_test` | ★ **读盘**（`task.json`）核：该记录**有** `from_seat` 键，且 `from_seat === "writer#2"` |
| A | writer#1 那份 | `from_seat === "writer#1"`，而两份的 `from_role` **都是 `writer`** ⇒ 证明"光靠角色分不开"这个影响面确实被修掉 |
| A | 全单体检 | 该单**每一份**交接物都带非空 `from_seat`（改前是"22 份全都没有"那个形状） |
| A | 只读导出 | `pipeline_status` 走的那个面（`store.status({redactForMain:true})`）里也看得见席位；且既有字段一个不少 |
| **B 反例 · 单席位角色** | 测试位交 `test_to_review` | ★ 键**必须在**，且 `from_seat === "tester"`（**不是 `undefined`、不是 `null`**） |
| B | 需求位 / 计划位 | `requirement_analysis ⇒ orchestrator`、`plan ⇒ planner`、`orchestration ⇒ planner`（后者走的是 `buildHandoffRecord` 的**另一处调用点**） |
| **C 向后兼容** | 旧记录（无该键） | 读得出来（不抛）；按同口径推导；**读后对象上仍无该键**（不迁移不重写）；摘要字段集合逐条比对 |
| **D 取值来源** | 纯函数层 | ① 令牌席位优先 ② 分区席位 ③ 角色名；都没有 ⇒ `null`（不编造）；**不误读** `payload.from_seat` |

★ **测试密闭性**：夹具用 `createHarness()` 的 `mkdtemp` **自造临时任务目录**，全程不引用任何活体真单、不读任何真单的 mtime（教训：`orphan-rescue-check` 因读活体真单 mtime，同一份代码两次跑出 42/46 与 44/46）。

---

## 5. 测试对照（改前基线 vs 改后）

跑法：`node tests/run-all.mjs --quiet`（两次同一条命令）。

| | 基线（改前） | 改后 |
|---|---|---|
| 套数 | 30 套 | **31 套**（+ `handoff-seat-check`） |
| 逐套数字 | —— | **30 套逐条与基线完全相同** |
| 新增套 | —— | `handoff-seat-check` **27/27** |
| 红项 | `roster-authority-check` 70/72（2 条：`E 上限次序｜A3` 第 10 / 第 11 个） · `orphan-rescue-check` 42/46（4 条：两张活体真单的识别判据） | **同样这 2 套、同样这 6 条**（失败断言名逐条相同） |
| 汇总 | 等价 1467/1473（= 改后 1494/1500 − 27/27，逐套数字未变故可直接相减） | **1494/1500**，exit code 1（与基线同因） |

⇒ **没有出现新的红**；两条既有的红正是任务书里点名的 `roster-authority-check`（70/72）与 `orphan-rescue-check`（活体环境随机红）。

---

## 6. 需重启复验

本次**只改了生效副本文件**，未安装、未重启（按纪律）。DSH 重启（或插件重载）后建议按序复验：

1. `node tests/run-all.mjs --quiet` ⇒ 期望仍是 **1494/1500**、新增套 `handoff-seat-check` 27/27、红项仍只有那两套；
2. **新单实测**（真跑一次多席位交付）：开单 → 计划给 2 个编写席位 → 让 `writer#2` 交 `dev_to_test` → 查 `task.json`：
   `handoffs[].from_seat` 应为 `"writer#2"`，且同单里 `tester` 交的那份应为 `"tester"`；
3. **旧单回归**（只读，确认零迁移）：读 `T-20261012-8cdee0` 的 `task.json`，那 22 份**仍应没有** `from_seat` 键（一个字节都不该变），但 `pipeline_status` 的交接物清单里**已经看得见**席位（读侧推导）。

---

## 7. 残留风险（如实登记，未越界修）

**① `actorKeyOf` 的席位口径漂移（★ 唯一一条真风险，不在本文件）**

- `lib/wakeup.js:436` 的 `actorKeyOf(role, seat)` 对**非空** seat 一律拼成 `${role}#${seat}`（其注释假设"非编写角色的 seat 为空"）。于是当 `from_seat = "tester"` 时它算出的是 **`tester#tester`**，而**实时路径**用的 `actor` 来自**令牌**（非编写角色的令牌席位是 `null`）⇒ `tester`。
- 影响面**只有两处**（均已定位，且都**不经过正常交付路径**）：
  - `wakeup.js:609` 的「作者对齐」（`ledgerIdentityScoped`）：只在**拿不到工具返回值判别子**时才走候选回退；`pipeline_handoff` 正常返回 `handoff_id` ⇒ `eventIdentityFor` 在 `wakeup.js:682` 就短路了，**不经过它**。走到时的表现是"候选被过滤 ⇒ `disc:null` ⇒ 看得见的失败"，**不会**把别人的交接物认成自己的（比改前更保守）。
  - `lib/wakeledger.js:201-208` 的**账本重建**（`rebuildEntriesFromTask`）与 `wakeup.js:532` 的候选表：重建算出的键会是 `…|handoff|tester#tester|H-x`，而实时落账的键是 `…|handoff|tester|H-x` ⇒ **重建后这两类键对不上**（只影响**非编写角色**的 handoff；编写席位 `writer#N` 两边一致，因为它本身就是全限定的）。后果是"延迟重放"去重可能漏一次。
- **为什么没顺手改**：`lib/wakeup.js` / `lib/wakeledger.js` **不在本席位的文件面**（本次只被授权 `lib/handoff.js`），越界改就是"顺手多干"。
- **建议的一行硬化**（任一文件的属主来做）：在 `actorKeyOf` 与 `rebuildEntriesFromTask` 的 `actorOf` 里各加一句 —— **`seat === role ⇒ 视作无席位`**（返回 `role`），两处同源改完，漂移即消失且不影响既有断言。另一条等价修法是让 `buildHandoffRecord` 的非编写角色写 `null`（但那就**违背本单明确的反例要求**："`from_seat` 是角色名，不是 undefined、不是 null"，故未采用）。

**② 可选、未做（属 `lib/tools.js` 的文件面）**：`pipeline_status` 的**人类可读**交接物那一行（`tools.js:3294`：`[kind_zh] from_role→to_role …`）目前还没印席位；**结构化/摘要面已经带上**（本次在 `summarizeHandoff` 里加的就是它）。要不要在正文行里也显示，由 `tools.js` 的属主决定。
