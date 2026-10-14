# E 路 · 输出投影（②）+ 按可见工具惰性渲染/收紧（③）—— 实现报告

> **对象**：`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-pipeline`（**生效副本**，未装、未重启、未加依赖）
> **依据**：`dsh-ops-可参考清单.md` §2 结论一 第 2 名（输出模式 + 投影，`lib/file/contract.js:20,29` + `native/src/results.rs:147-169`）与
> 第 3 名（按"实际可见工具"惰性渲染，`lib/index.js:128-139` + `lib/policy.js:26-66`）
> **改动文件**：`lib/tools.js` · `lib/boundaries.js` · `index.js` —— **一个字节都没碰** `guard-factory.js` / `lib/hashgate.js` / `lib/store.js` / `lib/patrol.js` / `lib/wakeledger.js` / `lib/liveness.js` / `lib/orphan.js` / `lib/handoff.js` / `lib/wakeup.js` / `lib/states.js` / `lib/guard.js`
> **备份**：`lib/tools.js.bak-E2E-20261014-195726` · `lib/boundaries.js.bak-E2E-20261014-195726` · `index.js.bak-E2E-20261014-195726`（带时间戳，落插件目录内、不在加载路径上）
> **自测**：`tests/e-route-check.mjs`（**40/40 通过**）+ 全套 `node tests/run-all.mjs --quiet`（**与基线逐套相同**）

---

## 一、现状（贴一次真实 status 的字节数作证）

现场探针（**只读**：直调工具、显式关掉失联处置、不写盘）：

```
node tests/_e-real-size-probe.mjs %USERPROFILE%\.dsh\profiles\desktop
```

真实工作区 8 张单（本机 `.pipeline/`）：

| 任务 | 状态 | 现状 `status` | `detail:"summary"` | `detail:"count"` | 现状 + `include_audit` |
|---|---|---:|---:|---:|---:|
| T-20261011-4a2dc7 | analyzing | 2 127 B | 917 B | 626 B | 9 240 B |
| T-20261011-a5fe41 | blocked | 2 327 B | 884 B | 678 B | 15 559 B |
| **T-20261011-214043** | blocked | **8 578 B** | 1 683 B | 753 B | **98 732 B** |
| T-20261011-5a871c | blocked | 5 964 B | 1 000 B | 749 B | 64 501 B |
| T-20261011-56a37e | blocked | 9 735 B | 1 346 B | 751 B | 33 419 B |
| T-20261012-7b9408 | blocked | 2 102 B | 884 B | 678 B | 8 331 B |
| T-20261012-6884af | blocked | 5 504 B | 1 078 B | 755 B | 36 395 B |
| T-20261012-8cdee0 | closed | 6 094 B | 866 B | 679 B | 45 327 B |
| **合计** | | **42 431 B** | **8 658 B** | **5 669 B** | **311 504 B** |

**这就是痛点**：主对话"看一眼状态"最省的一次也是 2 KB 起，最大的一张单是 **8.6 KB**；
一旦要连审计一起看（`include_audit:true`），**单次 98.7 KB**、八张单合计 **311 KB** ——
而它换来的信息里，真正决定"下一步干什么"的只有几十个字节。

> ★ 诚实边界：`pipeline_security_check` 的真实字节数**没有**用真单量 —— 它会往
> `.pipeline/<任务>/reports/` **落一份报告**，探针坚持"一个字节都不写"。它的两档对比用夹具量
> （见 §四 正例①：842 B → 634 B → 632 B）。

---

## 二、② 输出模式 + 投影（设计与实现，文件:行）

参考 `dsh-ops` 的 `lib/file/contract.js:20,29`（glob 的 `paths|details`、grep 的
`files_with_matches|content|count|summary`）与 `native/src/results.rs:147-169`（`fields` 投影 +
分页信封）：**让模型先用最便宜的投影探路，确认有货再取正文**。

| 落点 | 文件:行 | 做什么 |
|---|---|---|
| `fields` 投影（模型侧） | `lib/tools.js:219` `renderProjected` | 给了 `fields` ⇒ 只回点名的字段（紧凑 JSON），`ok` 永远保留；**拒绝路径不受投影影响**（拒绝原文永远原样给）；点名了不存在的字段进 `_unknown_fields`（不静默吞） |
| 投影只在声明了 `fields` 的工具上生效 | `lib/tools.js:251` `renderFor` | 否则**改前逐字节不变**（防"手抖带了个同名字段 ⇒ 莫名少回内容"） |
| 分页 / 分布 / 页脚话术 | `lib/tools.js:3201` `BRIEF_PAGE_SIZE` · `:3208` `paginate` · `:3219` `pageHint` · `:3225` `distribution` | 按**段**切清单，截断**必须**给 `page/total` 与"下一段怎么取" |
| 卡点判据（"有没有卡、卡在哪"） | `lib/tools.js:3238` `statusBlockers` | 全部**派生自 `store.status()` 已经算好的字段**（哈希闸门 / 失联 / 待办人工 / 待裁澄清 / 待复核申请 / 打回预算 / 主管枢纽站点 / 审核 OK），不重算判据、不读盘 |
| "下一步该谁" | `lib/tools.js:3283` `SIDE_EVENT_NAMES` · `:3287` `statusNextOwners` | 判据 = 状态机的 `next_events[].by`；**主链与侧路分开**（侧路谁都能提，逐条列出来会把紧凑档撑回全文那么大） |
| 计数与分布（**算好再给**） | `lib/tools.js:3308` `statusCounts` | 交接物总数 + **按类型分布** / 打回 / 待办 / 席位(失联) / 授权面 vs 实际改动 |
| 紧凑档正文 | `lib/tools.js:3335` `renderStatusBrief` | `summary` / `count` 两档共用一份计数 |
| `pipeline_status` 参数 | `lib/tools.js:3420-3422` | `detail` / `fields` / `page` |
| `pipeline_status` 列全部任务档 | `lib/tools.js:3547-3553` | **状态分布算好 + 需求不再整段贴**（最长一行 420 B → 300 B → 87 B） |
| `pipeline_status` 主档分叉 | `lib/tools.js:3690-3695` | `isBrief` 为真才走紧凑档；`:3778`/`:3783`/`:3785` 三处把"审计 / 完整交接物 / 脱敏说明"在紧凑档里**不追加** |
| `pipeline_change_audit` | `lib/tools.js:1633-1635`（参数）· `:1695-1742`（紧凑档）· `:1754-1774`（显式分页） | 省掉**逐文件明细**（几百个文件就是几万字节），**不省**结论 / 多改 / 少改 / 那一行可直接填 `review_verdict` 的 `change_audit` |
| `pipeline_security_check` | `lib/tools.js:4504-4506` · `:4555-4588` | 只压正文；扫描范围 / 命中数 / `checks_ref` / `attestation_hint` / 落盘 / 审计留痕**一个字节没动** |

### 三条铁律怎么落在代码里

1. **不传参数 ⇒ 与改前逐字节相同**：`detail` 缺省或 `"full"` ⇒ `isBrief === false` ⇒ 走原路；
   `page` 只有在**显式给了**时才分页（`lib/tools.js:3693` / `:1754`）。
   ★ 实测抓到过一次真回归：`change_audit` 的 summary 走的是 `lines.join('\n')`（**不过滤空串**），
   我第一版用 `? '' : …` 塞了个空串 ⇒ **多一个空行（+1 字节）**。跨树对比把它抓出来了，已改成展开
   `...(cond ? [] : [x])`（`lib/tools.js:1773`）。**这就是"逐字节"这条纪律的价值。**
2. **不许少报关键信息**：紧凑档必须回答「有没有卡 / 卡在哪 / 下一步该谁」，
   而且**总数与分布由插件算好**（`statusCounts` / `distribution`），不把"你自个儿数去"甩给调用方。
3. **截断必须给续页口径**：`明细：共 25 条 —— 本档不展开；要看得 page: 1，或一次看全 detail:"full"`
   （`lib/tools.js:1733`）；真分页时给 `本段 1/2，共 25 条；下一段：pipeline_change_audit { …, page: 2 }`。

---

## 三、③ 按"实际可见工具"惰性渲染 / 收紧（设计与实现）

### 3.1 权威只有一个：**守门自己的判词**（不手抄白名单）

`lib/boundaries.js:322 export function deriveToolFace({ toolNames, judge })`：

* 对每个工具拿**匿名调用方**问一次守门的公开判据 `guardDecision()`（`lib/guard.js:578`，导出符号）；
* 按角色白名单管着的工具会吐那句 `允许角色：main / human`（`lib/guard.js:729` / `:738`），
  `lib/boundaries.js:422 parseToolAuthority` 把它读出来 —— **白名单从判词里读，不存第二份表**；
* **认不出 ⇒ 不收紧**（判词没这句话 / 抛错 / 没注入探针 ⇒ `roles: null` ⇒ 全角色可见）。
  方向是**安全方向**：宁可少省字节，绝不因为"读不懂"而藏掉一个角色需要的工具。
* 产物（纯数据，进 `pipeline_boundaries` 的只读导出，`lib/tools.js:1829` + `lib/boundaries.js:840`）：
  `by_role[role].visible / hidden / denied`、每个工具的判词结论 `judged`、判词出处 `source`、
  以及一份**诚实边界** `not_role_gated`（守门不按角色管的那些，工具面这一层不隐藏它们）。

实测（31 个工具）：

| 角色 | 可见 | 隐藏（守门口径） | **实际收紧** |
|---|---:|---:|---:|
| `main` | 24 | 7 | **0**（口径：主对话看全量） |
| `orchestrator` | 19 | 12 | 12 |
| `planner` | 20 | 11 | 11 |
| `supervisor` | 18 | 13 | 13 |
| `writer` | 18 | 13 | 13 |
| `tester` | 18 | 13 | 13 |
| `reviewer` | 19 | 12 | 12 |
| `architect` / `docs` / `release` / `performance` / `arbiter` / `diagrammer` / `archivist` | 17 | 14 | 14 |
| `security` | 19 | 12 | 12 |
| `human` | 21 | 10 | 10 |

`writer` 被隐藏的 13 个：`pipeline_orchestrate`、`pipeline_plan`、`pipeline_scope_amend`、
`pipeline_dispatch`、`pipeline_transition`、`pipeline_supervise`、`pipeline_rework`、`pipeline_close`、
`pipeline_roster_review`、`pipeline_human_relay`、`pipeline_human_reply`、`pipeline_clarify_reply`、
`pipeline_security_check`。

**17 个"不按角色收紧"的工具**（判据在 `execute` / 状态机里，工具面这一层**不动**它们）：
`pipeline_task_open`、`pipeline_bind_role`、`pipeline_handoff`、`pipeline_status`、
`pipeline_change_audit`、`pipeline_boundaries`、`pipeline_full_test`、`pipeline_roster_request`、
`pipeline_selftest`、`pipeline_switch`、`pipeline_human_request`、`pipeline_clarify_request`、
`pipeline_context_report`、`pipeline_succession`、`pipeline_record_submit`、
`pipeline_compile_requirement`、`pipeline_contacts`。
★ 如实说明：像 `pipeline_succession`（文档写着"只有主对话"）**不在**守门的角色白名单里，
所以它**留在每个角色的工具面上** —— 本路的纪律是"**只隐藏守门真的会拒的**"，
宁可少省一点，也不越过守门去自己发明一条边界。

### 3.2 收紧的施加点（`restrict({deny})`，而不是"不注册"）

| 落点 | 文件:行 | 说明 |
|---|---|---|
| 工具面推导（**从真实注册对象派生**工具名） | `lib/tools.js:677 pipelineToolFace` + 末尾 `for (const def of Object.values(allTools))` | 不另抄一份会漂移的名单 |
| 唯一出口上的惰性收紧 | `lib/tools.js:440 deps.tightenSeatFace?.(exec)` | 挂在 `tool()` 的**唯一出口**上（与 `rememberMainCaller` 同一条理由） |
| 施加器（可独立复现/断言） | `index.js:1151 createSeatFaceTightener` | 只调 `agent.ctx.tools.restrict({ deny })`；幂等；失败即放弃 + 一条 warn |
| 装配 | `index.js:539-550` | `guardEnabled !== true` 或总开关为关 ⇒ 一次都不收紧 |

**为什么不挂 `ctx.on('agent/created')`**（如实写出代价）：
`tests/load-smoke.mjs` 把「本插件挂在 `ctx.on` 上的事件**恰好是那三个**」写成了**既有断言**，
加一条新缝就红（第一版就是这么红的 —— 见 §六）。而少挂一条缝**本身也是对的**：
收紧的唯一触发点是"这个会话动了流水线工具"（那也是它**角色被确定**的那一刻）。
**代价**：席位**首次**工具调用那一轮仍会看到全量 schema，从第二轮起才是收窄后的面
（"惰性"的本义）。拿不到 `agent.ctx.tools.restrict` ⇒ 退回全量可见（= 改前行为）+ 一条 warn，**不静默**。

### 3.3 提示词按可见工具惰性渲染

参考 `dsh-ops` 的 `lib/index.js:128-139`（那个 `text` 回调收**本次会话的 context**）。

| 落点 | 文件:行 |
|---|---|
| 唯一渲染入口 | `index.js:1244 renderPromptForContext` |
| 席位版渲染 | `index.js:1087 seatPrompt` + `:1062 PROMPT_BLOCK_MARKS`（段落按**标记行**算，不写死行号） |
| 接进 prompt 段 | `index.js:871 text: (context) => renderPromptForContext(context, { tokens, face: pipelineFace })` |
| 只读面（判决可查） | `index.js:lastPromptRender()` / `lastSeatFaceTighten()`（与既有的 `lastChannelProbe` / `lastMainReattach` 同一种做法） |

四条纪律：① 拿不到 context / 拿不到 agent id / 角色是 `main` ⇒ **原样返回 `PIPELINE_PROMPT`**（逐字节）；
② 只对**已认领角色的非主对话席位**收缩，且**只丢别的角色的段落**（六条规则、开工顺序、收尾一律保留）；
③ 末尾那行"你可见的工具"取自**与收紧同一份**工具面 ⇒ "提示词说的"与"它真能调到的"不可能漂移；
④ **不广告不存在的东西**：席位版明文写"其余 pipeline_* 工具不在你的工具面上"。

实测（夹具的 writer，可见 18 个工具）：`PIPELINE_PROMPT` **4 694 B → 席位版 4 612 B**。
★ 老实说：提示词这一档省得**不多**（只有 82 B），因为席位版的"工具清单"本身有长度；
真正的省在**工具 schema**（13 个工具的定义不再进这个会话的请求）。

---

## 四、验证（正例 ×2 + 反例 ×3）

全部来自 `node tests/e-route-check.mjs`（40/40）。原始输出：`tests/_e-route-check-last-run.txt`。

### 正例①：`pipeline_status` 传 `summary` ⇒ 明显更小，但仍含「状态 / 卡点 / 下一步」

```
✓ ★ `detail="summary"` 明显更小（省 ≥ 50%）
    全文 2148 B → summary 920 B（省 1228 B，57.2%）　count 681 B
✓ ★ summary 仍能看出「有没有卡、卡在哪、下一步该谁」
    任务 T-…：开发中(developing)　档位 L2 · 角色 6 个　制品 （尚无）　审核 OK **尚无**
    卡点（1）：
      · 尚无审核 OK（还没到审核站，属正常）
    下一步该谁（主链 1 方）：writer（dev_submitted → 待测试）
      侧路（不推进主链，谁都能提）：clarification_request / human_request / block / cancel —— 共 4 种去向 / 5 条合法事件
    计数：交接物 4（human_request 1 / orchestration 1 / plan 1 / requirement_analysis 1） · 被拒收 0 · 制品 0 版 ·
          打回 编写0/2 测试0/2 · 待办人工 0 · 待裁澄清 0 · 待复核申请 0 · 席位 2（失联 0） · 授权面 3 条 / 实际改动 0 处
✓ ★ summary 里不依赖调用方自己去数：总数与分布已经算好
✓ ★ detail="count" 比 summary 还小，且同样带卡点与计数（681 B）
✓ ★ detail="full" 与不传 detail 逐字节相同（"要全文"没有第二条口径）
✓ ★ 紧凑档不吞掉结构化字段（同一份 hash_gate / liveness / change_scope）
✓ ★ fields=[…] 只回点名的字段（15 B：{"ok":true,"state":"developing","hash_gate":{…}}）
✓ ★ 点名了不存在的字段 ⇒ 不静默吞掉（列进 _unknown_fields）
```

另外两档（同一套夹具）：

```
change_audit：全文 6371 B → summary 6189 B → count 4784 B
  ✓ summary 不重复展开逐文件明细，但结论 / 多改 / 少改 / change_audit 那行一条不少
  ✓ 探路用法：fields=["verdict","baseline_id"] ⇒ 72 B（确认"有多改"之后再点名要清单；点名 unauthorized 时 4078 B）
security_check：全文 842 B → summary 634 B → count 632 B
  ✓ 紧凑档不动判据：扫描范围 / 命中数 / attestation_hint 与全文档逐字相同
列表档：最长一行 全文 420 B → summary 300 B → count 87 B（需求正文被 clamp / 去掉）
```

> ★ 诚实边界：`change_audit` 的 `summary` 在**大多数文件都是"多改"**时省得很少
> （那份清单**就是**答案，不能省）；它的省法在"授权面内改动很多、多改很少"的真实形状里。

### 正例②：某席位可见工具面确实变小了，且它**仍能完成本职**

```
✓ ★ 工具面从守门判词里读：工具数=31　writer 可见 18 / 隐藏 13
✓ ★ 例子成立：writer 看不到 pipeline_dispatch / pipeline_close / pipeline_supervise
✓ ★ 口径：主对话看到全量（main.denied 为空）
✓ ★ 不得漏：writer / tester / reviewer 的"本职工具"逐个点名都在可见面上
✓ ★★ 不变式（逐角色 × 逐工具跑真守门）：可见 ⇔ 守门放行、隐藏 ⇔ 守门拒
    4 个角色 × 31 个工具 = 124 组判定，全部满足双向不变式。
✓ ★ 收紧真的发生了：restrict({deny}) 逐字等于推导出来的隐藏面，且幂等（tighten 被调 3 次、restrict 只调 1 次）
    deny(13 个)=pipeline_orchestrate、pipeline_plan、…、pipeline_security_check
✓ ★ 主对话不收紧：同一个施加器对 main 一个 restrict 都不调
✓ ★ 席位那份提示词更小，且清单 = 可见面、不含它调不动的（4694 B → 4612 B）
✓ ★ 默认逐字节不变：主对话 / 拿不到 context ⇒ 原样返回 PIPELINE_PROMPT
✓ ★ 没认领角色的会话也拿全文（不猜"它可能是谁"），且理由可查
```

### 反例①：**不传参数 ⇒ 与现在逐字节一致**（哈希对比，跨树）

做法：把**改前**那三个文件放回一棵临时树，用它跑**同一份**自测取快照，再与生效副本的快照比：

```
改前那棵树：%USERPROFILE%\AppData\Local\Temp\dsh-BrnrF3\e-route-before-20261014-200829
改后那棵树：…\node_modules\dsh-pipeline
node tests/e-route-check.mjs --compare tests/_e-snapshot-before.json tests/_e-snapshot-after.json

✓ status/task       规范化 sha a0f2817625e2… → a0f2817625e2…　原始字节 2148 → 2148（相等）　规范化后没有任何一行不同
✓ status/all        816b4bf24423… → 816b4bf24423…　144 → 144（相等）
✓ status/audit      49ab9ac9e7fc… → 49ab9ac9e7fc…　5809 → 5809（相等）
✓ status/fullflag   ba1d9bf469d6… → ba1d9bf469d6…　851 → 851（相等）
✓ change_audit      d06005cf1ea0… → d06005cf1ea0…　843 → 843（相等）
✓ security_check    b99f8e8d9ed5… → b99f8e8d9ed5…　842 → 842（相等）
结论：全部用例规范化后逐字节相等 + 原始字节数相等 ⇒ 默认路径一个字节都没变。
```

★ **规范化只 mask 了"两次运行本来就不同"的东西**：任务 id `T-…`、交接物 id `H-…`、
基线 id `BL-…`、人工请求 id `HR-…`、记录 id `RC-…`、ISO 时间戳、安全扫描的落盘路径与内容摘要。
其余**一个字符都没动**，且逐行 diff 是"没有任何一行不同"（不是"哈希一样"一句带过）。
★ 同一棵树内还有一条**严格**的等式：`detail:"full"` 与**不传 detail** 的输出 `sha256` 完全相同（上面正例①）。

### 反例②：该被守门拒的调用**仍被拒**（复跑两条既有反例）

```
✓ ★ 编写调 pipeline_close ⇒ 仍被守门拒
    guard: [pipeline] 角色越权被拦下。 / 工具：pipeline_close / 允许角色：main / 当前角色：writer
✓ ★ 测试调 pipeline_dispatch ⇒ 仍被守门拒
    guard: [pipeline] 角色越权被拦下。 / 工具：pipeline_dispatch / 允许角色：main / 当前角色：tester
```
（判据本体一个字没动：`lib/guard.js` 的 `PIPELINE_TOOL_ROLES` 与 `guard.js` 全文**零改动**。）

### 反例③：被"少给定义"的角色，通过别的方式尝试 ⇒ **不许因此被放行**

```
✓ ★★ 隐藏的每一个工具，守门仍逐个拒（13 个隐藏工具里，守门仍拒 13 个）
✓ ★ 即使绕过可见面直接调 execute，结果仍是 ok:false
    「只有主对话能关单，当前调用方是「编写」。」（工具层自己那道判据仍在）
✓ ★ 反方向也不许出事：可见面里没有一个"其实守门会拒"的工具
✓ ★ 拿不到 agent.ctx.tools.restrict ⇒ 退回全量可见（= 改前行为）+ 一条 warn，不静默
✓ ★ 连角色都认不出（没绑定的会话）⇒ 返回 null，一个动作都不做
✓ ★ 守门被关（guardEnabled:false）时一次都不收紧（不去"比守门更严"）
```

---

## 五、默认行为不变的证明（汇总）

| 判据 | 结论 | 证据 |
|---|---|---|
| 三个只读导出的**默认路径** | **逐字节相同** | §四 反例① 的跨树对比（6 条用例：字节数相等 + 规范化后零行差异） |
| `detail:"full"` 与不传 `detail` | **同一份输出**（同进程 sha256 相等） | §四 正例① |
| `page` 不传 | 交接物 / 明细一节**没有**分页脚注 | §四「`page` 不传 ⇒ 保持原样」 |
| 提示词段（未知角色 / 主对话 / 无 context） | **原样返回 `PIPELINE_PROMPT`** | §四 正例② 的提示词三条 |
| 工具注册数 | **31 个，一个不多一个不少** | `tests/load-smoke.mjs` 24/24（既有断言 `EXPECTED_TOOL_COUNT=31`） |
| `ctx.on` 缝条数 | **仍是 3 条**（pre-execute / pre-step / post-execute 各 1·1·2） | `tests/load-smoke.mjs` 24/24（既有断言） |
| 守门注册数 | **仍是 1 个** | 同上 |
| 自测夹具 | `deps.tightenSeatFace` 未注入 ⇒ 收紧**一次都不发生**；`judge` 未注入 ⇒ 工具面**不收紧任何角色** | `tests/e-route-check.mjs` 全程在夹具上跑却零副作用 |

---

## 六、测试改前 / 改后

```
改前（基线）：node tests/run-all.mjs --quiet → tests/_E-baseline-run-all.txt
改后（本轮）：                                → tests/_E-after3-run-all.txt
```

* **31 套用例的"总计"逐套相同**（`SUITE RESULTS IDENTICAL TO BASELINE ✓`）：
  `selftest 70/70 · load-smoke 24/24 · output-check 38/38 · handoff-seat 27/27 ·
   orphan-rescue 61/61 · wake-channel 14/14 · roster-authority **70/72**（既有红）…`
* **唯一的红仍是既有红**：`roster-authority-check` 70/72（那两条 `E 上限次序｜A3` 在基线里就是红的）。
* **没有新的红**：`orphan-rescue-check` 61/61 ✓ · `wake-channel-check` 14/14 ✓ · `load-smoke` 24/24 ✓。

★ 本轮**真的红过一次，也真的修了回去**（如实记录）：
第一版把收紧挂在 `ctx.on('agent/created')` 上 ⇒ `load-smoke` 的既有断言
「挂的事件恰好 3 个」当场变 5 个 ⇒ `23/24`。**没有改断言、没有改期望值**，
而是改设计（撤掉那两条缝，只留工具出口那一个触发点），随后 `24/24`。

本轮新增自测：`tests/e-route-check.mjs`（**40/40**，含正例 ×2 + 反例 ×3）。
它**不注册进** `run-all.mjs`（那是别人的文件面），自带 `--snapshot` / `--compare` 两个模式：
**跨"改前 / 改后"两棵树**取同一份快照再比，这就是反例①的判据来源。
辅助件：`tests/_e-snapshot-{before,after}.json` · `tests/_e-route-check-last-run.txt` ·
`tests/_e-real-size-probe.mjs`（只读探针）· `tests/_e-before-tree-path.txt`（改前那棵树在哪）。
本轮**没有删改任何既有测试、没有放宽任何断言、没有改任何期望值**。

---

## 七、未做活体验证（需重启复验）

**本机没有装、没有重启 DSH**，所以下面这些**只做到了静态 + 夹具级**验证，重启后请按点复验：

| # | 未验证的点 | 现状（怎么保证不炸） | 重启后怎么验 |
|---|---|---|---|
| 1 | `agent.ctx.tools.restrict({ deny })` 在本宿主版本上真的可用 | 施加器包在 try 里；拿不到 / 抛错 ⇒ **退回全量可见**（= 改前行为）+ 一条 warn（每进程一次），**不影响任何一次工具调用** | 日志里搜 `席位工具面收紧不可用`；没有这条 warn 就说明收紧生效了；再调 `lastSeatFaceTighten()` 看 `restricted` / `last.denied` |
| 2 | 宿主的 `systemPrompt.section({ text })` 回调是否传 `context`（以及 `context.agent.id` 是不是那个形状） | 拿不到 / 形状不同 ⇒ **原样返回全文**（安全方向），并把"为什么退回"记进 `lastPromptRender()` | 起一个席位会话，读 `lastPromptRender()`：`mode==='seat'` 说明生效；`mode==='full'` 会带 `reason` |
| 3 | 收紧发生在**首次工具调用之后**（首轮仍是全量） | 设计如此（见 §三 3.2）；代价已写进代码注释 | 席位第二轮起才收窄 —— 看 §正例② 的 `restrict` 时机 |
| 4 | 总开关「多AI 协调」**关闭**时：隐藏面是**静态**的，而守门是**运行时弃权**的 | 收紧只在 `guardEnabled===true` **且** 开关为开时才发生；开关关掉后 mutating 工具本就被工具层拒，实际差异只落在 `pipeline_security_check` 这类**只读**工具上 —— 那是**更严**，不是放宽 | 关掉开关，确认没有任何"原本能用的动作"变成不能用（只读动作一条不该少） |
| 5 | 宿主渲染工具面时**是否会重算**（`restrict` 之后 schema 立即消失） | 每次 `tightenSeatFace` 只调一次 `restrict`，disposer 由宿主管理 | 席位会话第二轮请求里确认那 13 个工具的 schema 已不在 |
| 6 | 真单上的字节数（§一 的表是**只读探针**跑出来的，不是会话里跑的） | 探针直调工具、显式关掉失联处置 | 会话里 `pipeline_status { detail: "summary" }` 与不传参数各跑一次，比字节 |

★ 另外两条**必须一起看**的既有事项（不属本路，但会影响观感）：
① 关掉「多AI 协调」开关时**不注销守门、不注销工具**是**刻意**的（`index.js` 文件头有理由）；
② 席位**首次**工具调用那一轮仍会看到全量工具 schema —— 这是"惰性"的定义，不是漏做。

---

## 简报（≤200 字）

* **省字节**：真单 `pipeline_status` 现状 8 578 B → `summary` 1 683 B（−80%）；八张单合计 **42 431 → 8 658 B**；
  带审计时单次 **98 732 B → summary**（合计 311 504 → 8 658 B，−97%）。另给 `count` 档与 `fields` 探路（72 B 拿到 verdict）。
* **工具面**：31 个工具按守门判词推导；**writer 减 13 个**（dispatch/close/supervise…），tester/reviewer 各减 13/12，
  **主对话 0**（看全量）；提示词席位版另减 82 B。
* **默认不变**：跨"改前/改后"两棵树同源快照对比 —— 6/6 用例**规范化后零行差异 + 原始字节数相等**（抓到并修掉过一次 +1 字节的回归）。
* **三条反例**：守门仍拒（writer→close、tester→dispatch）；隐藏的 13 个工具守门仍逐个拒、绕过可见面直调 `execute` 也 `ok:false`。
* **测试**：`e-route-check 40/40`；全套 31 套与基线**逐套相同**，唯一红仍是既有 `roster-authority 70/72`。

---

## 八、回归修复：出口工具被隐藏（2026-10-14 重启后复验发现）

> **对象**：同一棵生效副本 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-pipeline`（**未装、未重启、未加依赖**）
> **改动文件**：`lib/boundaries.js` · `lib/tools.js` · `tests/e-route-check.mjs`（★ `index.js` **一个字节没动** —— 不需要动：收紧器读的是 `by_role[*].denied`，那一份已经跟着改了）
> **备份**：`lib/boundaries.js.bak-exit-20261014-202928` · `lib/tools.js.bak-exit-20261014-202928` · `index.js.bak-exit-20261014-202928` · `tests/e-route-check.mjs.bak-exit-20261014-202928`（带时间戳，落插件目录内、不在加载路径上）
> **改前指纹 → 改后指纹**（本机可复算）：
> `lib/boundaries.js` 54 315 B → **61 286 B**（sha256 `a0befc6bd4af…` → `553e7b6e1e6f…`，+101/−4 行）·
> `lib/tools.js` 315 909 B → **316 976 B**（`3ebdec9cd440…` → `dc68965100eb…`，+16/−5 行）·
> `tests/e-route-check.mjs` 49 552 B → **64 362 B**（`03ac5b781c0f…` → `f237cdbd7b91…`，+227/−11 行）·
> `index.js` 74 586 B **未变**（`d5964649ba65…` 前后相同 —— 这条哈希本身就是"没碰它"的证据）

### ① 判据级结论：被隐藏的工具**调用时会被拒**（不是"只是不渲染"）

分两层，各贴代码行：

| 层 | 落点 | 行为 |
|---|---|---|
| **宿主** | `dsh-tools/lib/index.js:2988`（"a restricted-away global reads as **absent**"）→ `:2970-2974`（`view().visible` 逐层 `admits()` 过滤）→ `:3011-3016` `resolveExecution()` 取 `get()`，取不到 `return undefined` → `:3004`（"Denial surfaces as `UNKNOWN_TOOL` through the executor, **matching an absent definition**"） | `restrict({deny})` 之后该工具**不在该 agent 的可见面里**；就算模型报出这个名字，执行器也按"**没有这个工具**"拒（`UNKNOWN_TOOL`）。**= 调用会被拒，不是仅不渲染。** |
| **本插件守门** | `lib/guard.js:926` `pipeline_transition: ['main', 'human']` → `:1149-1150`（命中白名单则在此判）→ `:1169-1179`（不在名单里 ⇒ 拒） | 即使**绕过**工具面直接寻址，守门也会拒：`[pipeline] 角色越权被拦下。工具：pipeline_transition 允许角色：main / human 当前角色：writer` |

**⇒ 对这个工具、对这一批角色，"隐藏"与"守门会拒"当时是一致的** —— 它不是"藏掉了守门会放行的那一类"（E 路自己那条机械判据没被违反）。

**但真正的缺陷在另一层，而且成立**：`pipeline_transition` 的权限是**逐事件**判的 ——
`lib/states.js` 的 `TRANSITIONS[].by`（`:595` `dev_submitted: by ['writer']`、`:620` `review_ok: by ['reviewer']`、`:633` `clarification_reply: by ['orchestrator']` …）
加上 `store.transition` 的逐事件前置条件。**同一行工具白名单**对 `dev_submitted` 与 `cancel` 是**两个不同的答案**，
而"按角色隐藏"只能表达一个 —— 那等于**工具面替状态机做了逐事件判断** ✗。实测（直调 `execute`，绕开守门）：

```
dev_submitted as writer ⇒ ok=false「要从「开发中」进入「待测试」，必须先由编写角色产出 dev_to_test 交接物。」
dev_submitted as main   ⇒ ok=false「事件「dev_submitted」只允许角色 writer 触发，当前调用方是「main」。」
cancel        as writer ⇒ ok=false「事件「cancel」只允许角色 main/human 触发，当前调用方是「writer」。」
block         as main   ⇒ ok=true 「开发中 → 已阻塞。」
```

### ② 逐角色审计表（**用代码逐条验**：角色→事件从状态机推导、事件→工具从 4 种机制实算）

★ **先说结论（与会话里那条口径不同，如实写）**：
**改前没有任何一个角色丢掉它的出口工具** —— "`pipeline_transition` 是编写席的唯一出口"是**误读**：
编写席的出口是 **`pipeline_handoff { kind: "dev_to_test" }`**（`lib/store.js:158-161` 的 `planAdvance` 把它**自动推进**成 `dev_submitted`，`:4671-4703` 先预检再迁移），
而 `pipeline_handoff` 在改前**就在**每个角色的可见面上（它的守门判词没有角色白名单 ⇒ 不收紧）。
**所以"出口被堵死"这个后果不成立；"逐事件判据的工具不该在工具面这一层按角色隐藏"这个做法不成立 ⇒ 修的是做法，不是后果。**

| 角色 | 出口（状态机里它该发的事件） | 出口工具（机械推导） | 在不在可见面 | 依据（文件:行 / 实测） |
|---|---|---|---|---|
| `writer` | `dev_submitted` | **`pipeline_handoff`**（`dev_to_test` 自动推进）+ `pipeline_artifact` | **在**（19 个里含它） | `store.js:158-161` · `:4671-4703`；实测 writer 交 `dev_to_test` ⇒ 状态推进 |
| `tester` | `test_passed` / `test_failed` | **`pipeline_handoff`**（`test_to_review` / `test_to_dev`）+ `pipeline_rework` | **在** | `store.js:162-169` · `guard.js:928` |
| `reviewer` | `review_ok` / `review_ng_dev` / `review_ng_test` | **`pipeline_handoff`**（`review_verdict`，结论在 `payload.conclusion`）+ `pipeline_rework` | **在** | `store.js:164-167` · `guard.js:928` |
| `orchestrator` | `need_to_supervisor` / `need_confirm_diagram` / `clarification_reply` | **`pipeline_handoff`**（`requirement_analysis` / `station_confirm`）+ **`pipeline_clarify_reply`** | **在** | `store.js:207` · `:222-228` · `guard.js:944` |
| `planner` | `planned` / `orchestrated` / `plan_gap` | **`pipeline_plan`**（`store.setRoster` 里发 `planned`/`orchestrated`，`store.js:3483-3485`）+ `pipeline_handoff`（`plan` 带 `self_check.verdict=gaps` ⇒ `plan_gap`） | **在** | `store.js:3476-3485` · `:175-176` · `guard.js:906` |
| `supervisor` | 9 个 `supervisor_*` 事件 | **`pipeline_supervise`**（具名动作，`lib/tools.js:2787-2794` 的 `EVENT_OF`） | **在** | `guard.js:925`（main 代发被两道拒）· `lib/tools.js:2727-2794` |
| `archivist` | **（状态机里没有它的事件）** | **`pipeline_record_submit`** / **`pipeline_compile_requirement`** | **在** | `guard.js:900-948` 两张表里都是 `null`（不按角色管）⇒ 全角色可见；实测 archivist 可见面含这两条 |
| `diagrammer` | `diagram_submitted` | **`pipeline_handoff`**（`architecture_diagram`） | **在** | `store.js:209` · `handoff.js:888-890`（`from: ['diagrammer']`） |
| `security` | `review_ng_dev` | **`pipeline_rework`** + `pipeline_handoff` | **在** | `guard.js:928` · `store.js:5226` |
| `main` | 13 个路由事件（`dispatch_*` / `close` / `block` / …） | **`pipeline_dispatch`** / **`pipeline_close`** / `pipeline_transition` | **在**（看全量，0 收紧） | `guard.js:911/927` |
| `human` | `block` / `unblock` / `cancel` | **`pipeline_transition`** | **在** | `guard.js:926` 白名单含 `human` |
| **每个角色** | 交付入口 | **`pipeline_handoff`** | **在**（16/16 角色） | 判词无角色白名单 ⇒ 不收紧（`deriveToolFace` 的判据①） |

机械核对：**62 对（角色 × 它该发的事件）逐对**核过 —— 每一对都至少有一条"**可见 + 守门放行**"的出口路径，**0 遗漏**（这条现在是 `e-route-check` 的常驻断言，见 ⑤）。

### ③ 改了什么（`lib/boundaries.js` + `lib/tools.js`）

**一句话**：把**事件级判据的工具**（入参里有 `event` 的，当前就是 `pipeline_transition`）从"按角色收紧"里**移出去** —— 它的工具面归属不再由守门那一行角色白名单决定，而由状态机的 `by` 名单 + `store` 的逐事件前置条件决定（**判据一个字没动、没有放宽任何拒绝**）。

| 落点 | 文件:行 | 做什么 |
|---|---|---|
| 事件级工具的**识别** | `lib/boundaries.js` 新增 `eventLevelToolNames(defs)` | 从**注册定义**的参数表里认（`parameters.event`）—— **不写死工具名**；两种 schema 形态都认（已编译 / 退化裸属性表）。以后再有"以事件为入参"的工具，**自动**进这一类 |
| 推导时**排除** | `lib/boundaries.js` `deriveToolFace({ …, eventLevel })` | 事件级工具 ⇒ `roles: null`（对所有角色可见、不进 `hidden`、**不进 `denied`**）；判词照旧读一次留证（`guard_roles`），但结论不受它支配 |
| 诚实边界（新） | `lib/boundaries.js` 返回值 `event_level: [{ tool, guard_roles, transition_actors, why }]` | `transition_actors` = `TRANSITIONS[].by` 的并集（状态机自己说"哪些角色能发事件"）—— 与 `guard_roles`（`main / human`）不一致，正是"这一类不能按角色收紧"的证据 |
| 机械判据（第 4 条） | `lib/boundaries.js` `tightening.hides_event_level_tool = false`；人读版多一行"事件级工具"节 | 只读导出（`pipeline_boundaries`）里**看得见**这件事 |
| 名单来源接到真实注册对象 | `lib/tools.js:673-696` `toolDefList` + `pipelineToolFace()` | 工具**定义**与工具**名**同源到齐（`buildTools` 末尾一起收，缓存作废重算）—— "导出说的"与"实际注册的"不可能漂移 |

**收紧面的实际变化**（16 个角色，`denied` 个数，改前 → 改后）：

```
main 0→0（口径不变：主对话看全量）　human 10→10（它本来就在白名单里）
orchestrator 12→11　planner 11→10　supervisor 13→12　security 12→11
writer 13→12　tester 13→12　reviewer 12→11
architect / archivist / diagrammer / release / docs / performance / arbiter 14→13
```

唯一被移出隐藏面的就是 `pipeline_transition`（每个角色各 1 个）；**没有第二个工具被放开**。
编写席的可见面 **18 → 19**，`deny` 面 **13 → 12**：

```
改前 deny(13)：pipeline_orchestrate、pipeline_plan、pipeline_scope_amend、pipeline_dispatch、**pipeline_transition**、
              pipeline_supervise、pipeline_rework、pipeline_close、pipeline_roster_review、
              pipeline_human_relay、pipeline_human_reply、pipeline_clarify_reply、pipeline_security_check
改后 deny(12)：同上，**去掉 pipeline_transition**
```

★ **两处既有断言的收窄，写在明处（这是本轮唯一"动了既有测试"的地方，不是静默放宽）**：
`e-route-check` 里那两条"**可见 ⇔ 守门放行 / 不许骗它去撞墙**"的不变式，对**事件级工具**换成了**另一条同样机械、且额外加了举证义务**的判据：
① 它必须**可见**且**不在 deny 面里**；② 这个角色**必须真是某个事件的 actor**（出现在 `TRANSITIONS[].by` 里，否则也算错）；
③ 被豁免的 (角色 × 工具) **逐对打印出来**（本次 4 对：`writer/tester/reviewer/planner × pipeline_transition`），**不许静默**。
除这一类以外，双向不变式与其余断言**一个字没改、一条没删**（改前 40 条 → 改后 44 条，见 ⑤）。

### ④ 反例（修完**不许**把该隐藏的又放开；既有守门反例一条没破）

```
✓ ★ 编写席仍然看不到 pipeline_dispatch / pipeline_close / pipeline_supervise（3/3 在它的 deny 面里）
✓ ★ 12 个隐藏工具，守门仍然 12 个逐个拒（隐藏面被拿掉 ≠ 判据被拿掉）
✓ ★ 绕过可见面直接调 pipeline_close.execute ⇒ 仍然 ok:false（"只有主对话能关单"）
✓ ★ 编写调 pipeline_close / 测试调 pipeline_dispatch ⇒ 仍然被守门拒（原文一字未变）
✓ ★ 主对话仍然一次 restrict 都不调（口径：主对话看全量）
✓ ★ 拿不到 agent.ctx.tools.restrict / 守门被关 / 角色认不出 ⇒ 仍然退回全量可见或什么都不做
✓ ★ 可见面上除事件级工具外，没有一个是"其实守门会拒"的
```

既有大套（逐套**与基线逐套相同**）：`selftest 70/70` · `gate-states 55/55` · `dispatch-channel 48/48` · `station-reject 49/49` ·
`roster-authority 70/72`（**唯一红，既有红，改前改后一模一样**）。

### ⑤ 新增自检：`tests/e-route-check.mjs` 的「⑤ 出口工具」一节（4 条）

**角色→出口工具的映射从状态机的事件表推导**（`TRANSITIONS[].by`），**事件→工具**从 4 种机制实算，**全都不手工列名单**：

| 机制 | 判据 | 覆盖的例子 |
|---|---|---|
| ① 交接物自动推进 | 对**真实 kind 表**逐个调 `planAdvance` / `hubAdvanceFor`（两种 payload 形态都问一遍） | `dev_submitted ← dev_to_test`、`review_ok ← review_verdict(OK)`、`need_to_supervisor ← requirement_analysis`…（实测 13 条） |
| ② 通用事件执行器 | `pipeline_transition`，条件 = 该角色在该事件的 `by` 名单里 | `block` / `cancel` / `handoff_to_supervisor`… |
| ③ 具名动作工具 | 守门白名单 **⊆** 该事件的 actor 集合 | `pipeline_supervise`(`['supervisor']`) · `pipeline_plan`(`['planner']`) · `pipeline_close`(`['main']`) |
| ④ 打回工具 | 参数表里带 `target ∈ {writer,tester}` 的那个（**按入参认，不按名字认**） | `pipeline_rework` ⇒ `test_failed` / `review_ng_*` |

四条断言（`40/40 → 44/44`）：

```
✓ ★★ 生产链路（lib/tools.js 的 pipelineToolFace()）里事件级工具也已不再被按角色收紧 —— 不是只有测试自己传对了参数
      event_level=["pipeline_transition"]　writer 可见 19 / 实际收紧 12
✓ ★★ 每个角色的出口工具都在它的可见工具面上（角色→事件从状态机推导；事件→工具从 4 种机制实算 —— 不许手工列名单）
      62 对（角色 × 它该发的事件）逐对核过：每一对都至少有一条"可见 + 守门放行"的出口路径
✓ ★★ 这条自检有牙齿：把编写席的出口（pipeline_handoff）藏掉 ⇒ 同一条判据当场红（不是一句安慰）
      被藏掉时 writer→dev_submitted 的候选=pipeline_handoff / pipeline_transition　可达=false（必须为 false）
✓ ★ 事件级工具（pipeline_transition）对所有角色可见、且不在任何角色的 deny 面里　16/16
```

★ 第 1 条是**专门防"测试自己传对了参数、生产却没接上"**这一类假绿：它读的是 `pipeline_boundaries { format:"json" }` 里那份**生产**工具面。

### ⑥ 测试改前 / 改后

| 口径 | 改前 | 改后 | 判据 |
|---|---|---|---|
| `tests/e-route-check.mjs`（本路自测） | **40/40** | **44/44** | 只加 4 条，**没删一条**（断言名逐条比对：改前 40 条**全部仍在**）；原始输出 `tests/_e-route-check-last-run.txt`（旧的那份另存 `.bak-exit-20261014-202928`） |
| 全套 `node tests/run-all.mjs --quiet` | **1522/1524**（`tests/_E-after3-run-all.txt`） | **1535/1537**（`tests/_E-exitfix-run-all.txt`） | **31 套逐套相同**；差额 +13/+13 全部来自**本轮之外**：另一个会话在 20:28:50 新增了 `tests/wake-identity-carry-check.mjs`（13/13）并把它注册进 `run-all.mjs`（20:29:14）—— 与本次改动无关，已逐套核对 |
| 唯一红 | `roster-authority 70/72` | `roster-authority 70/72` | 既有红，未变 |
| 默认路径**逐字节**（跨"改前/改后"两棵树同源快照对比） | — | **6/6 全部逐字节相等** | `--snapshot` 两棵树各跑一次再 `--compare`：`status/task 2148→2148` · `status/all 144→144` · `status/audit 5809→5809` · `status/fullflag 851→851` · `change_audit 843→843` · `security_check 842→842`，**规范化后没有任何一行不同** |

### ⑦ 未做 / 已知边界（诚实清单）

1. **守门那一行白名单没动**（`guard.js:926` 仍是 `['main','human']`）：所以改后席位**看得见** `pipeline_transition`，但真去调**仍会拿到守门那句**"角色越权被拦下 / 允许角色：main / human"（**不是**逐事件的解释）。
   要让拒绝文案也变成逐事件口径，得改守门（`lib/guard.js`，本轮明确不许碰），或让守门对事件级工具**弃权**、交给 `store.transition` 判 —— 那是**另一条改动**，本轮没做。
   ★ 本轮保证的只有一件事：**工具面这一层不再替状态机做逐事件判断**，且**盘上没有第二份手抄名单**（识别是 schema 派生的）。
2. **`lib/patrol.js:487-491` 那条建议实测"谁也执行不了"**（不属本路文件面，本轮只记录不修）：
   它建议"叫醒该席位补发 `pipeline_transition { event: "dev_submitted" }`"——
   席位调会被守门拒（白名单 `main / human`）；主对话代发会被**状态机**拒（`dev_submitted` 的 `by` 只有 `writer`）；
   而编写席自己又**必须先交 `dev_to_test` 交接物**（交了状态就走了，`transition` 那一步根本用不上）。
   正确措辞应是"叫醒该席位**补交 `dev_to_test` 交接物**"。修它属于 `lib/patrol.js` 的文件面。
3. **没装、没重启 DSH**：以上全部是**静态 + 夹具级**验证。重启后请按 §七 那 6 点复验，并额外看一条：
   `pipeline_boundaries` 的「工具面」节应出现 **`★★ 事件级工具 1 个（pipeline_transition）…`**，且每个角色的"可见"数比改前 **+1**（main / human 不变）。
4. **并发提醒**：本轮作业期间**另一个会话**在改同一棵树（新增 `tests/wake-identity-carry-check.mjs`、改 `tests/run-all.mjs`、建 `_backup-batch2-20261014-202608`）。
   本轮要改的 4 个文件**动手前逐个重读**（哈希见文件头），改后指纹与"全套逐套相同"的结论都以**改后实测**为准。

### ★ 2026-10-14 20:53 补记：重启已发生；本路两条实测通过

**先说 §七 / §八⑦.3 与 §八 标题那三处口径张力（本报告没有自解的那处）**：
**实测结论 = DSH 确已重启** —— 进程 **PID 6556 起于 20:21:30**，晚于各路修复落盘（19:30–20:08）；判据 = 只读导出里出现了**只可能在重启后出现**的 ②b/②c、「工具面（E 路 ③）」整节、以及边界通知里逐字的 F 路 shell 指引。
⇒ **§八 标题那句「2026-10-14 重启后复验发现」是对的**；§七 / §八 ⑦.3 的"没重启"是它们**写作时点**的事实（写在前，重启在后）。**三处原文一律保留，只补结论。**

**本路的实测结果（主对话 20:53，只读观测）**：

1. **E 路 ③ 工具面 —— 已验**：只读导出里出现了**整节「工具面（E 路 ③）」**：判词出处 `guard:guardDecision` · **工具数 31** · **writer 可见 18 / 隐藏 13（实际收紧 13）** · **main 隐藏 7（实际收紧 0）** · 三条机械判据（不动守门判据 / 不隐藏守门放行的工具 / 主对话不收紧）齐全；另有「**不按角色收紧的 17 个**」清单。
   ★ **口径边界**：上面记的是该节的**现值**；本报告 §⑤ 那条断言里的"改前 40/40 → 改后 44/44""writer 可见 19 / 实际收紧 12"是**那一次**的读数，与本次现值不同 ⇒ **两处各自成立、不互相取代**。
2. **E 路 ② 输出投影 —— 已验**：会话里跑 `pipeline_status { detail: "summary" }` **实测生效** —— 返回「**共 8 个任务（紧凑档 summary）**」，★ **状态分布直接算好**（**已阻塞 6 · 需求分析中 1 · 已关闭 1**），**每条 131 字符截断**，并明示「**要正文用 `detail=full`（不传 = 与改前一致）**」。
3. ★ **§七 那 4 条仍为【待验】**（宿主 `restrict()` 真的可用 · `systemPrompt.section({text})` 回调是否传 `context` · 关开关后只读动作一条不少 · 宿主渲染工具面时是否重算）—— 它们要的是**真席位会话里**的证据，**只读导出替代不了**。

---

### 八节简报（≤180 字）

* **真回归还是误读**：**是误读，但做法确实错** —— 编写席的出口是 `pipeline_handoff{dev_to_test}`（自动推进 `dev_submitted`），改前就在可见面上；`pipeline_transition` 在守门（`['main','human']`）**与** `store` 两层都轮不到席位用。审计：**0 个角色丢掉出口**。
* **修了什么**：事件级工具（入参带 `event`，schema 派生、不手抄）从"按角色收紧"移出 ⇒ 16 个角色各少隐藏 1 个（`pipeline_transition`）；`index.js` 未动。
* **反例**：writer 仍藏 dispatch/close/supervise（3/3）、12 个隐藏工具守门仍逐个拒、直调 `execute` 仍 `ok:false`。
* **新自检**：出口工具 4 条断言（62 对逐对核 + 有牙齿：藏掉 handoff 当场红），**44/44**（改前 40/40，一条未删）。
* **测试对照**：全套 **31 套逐套相同**；1522/1524 → 1535/1537（+13 是别的会话新加的套）；唯一红仍是 `roster-authority 70/72`；跨树快照 **6/6 逐字节相等**。
