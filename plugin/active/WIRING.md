# WIRING · 接线待办（新模块 → 既有文件的落点）

> **这是给人看的待办清单，不是已经做完的事。**
>
> 本批次（P1–P5）带一条硬约束：**既有文件一个都不许改**。所以所有新模块都只**新增**，
> 一行都没接进既有代码。结果是：**新模块现在全是"死代码"** —— 能被 import、能被测试，
> 但**不会被任何真实流程走到**。
>
> 下面每一项写清五件事：
> ① 要接通什么 → ② 在**哪个既有文件**的**哪一处**加什么（文件 + 行号 + 具体那一行）
> → ③ 为什么必须接线才能生效 → ④ **不接线的后果** → ⑤ 接线的验收点。
>
> ⚠️ 行号是**本批次提交时**（分支 `feat/project-dir-and-demo`，HEAD = P5 提交）的行号。
> 既有文件一旦改动，行号会漂 —— 请按**附近那行代码**定位，不要只信数字。

---

## 0. 总览

| # | 接通什么 | 落点文件 | 不接线的后果（一句话） |
|---|---|---|---|
| W1 | DEMO 两个新状态 + 四条边 | `lib/states.js` | `demo_building` / `demo_confirm` 在真状态机里**不存在**，DEMO 阶段走不了 |
| W2 | DEMO / 强制主管的存储方法 | `lib/store.js` | `store.demoRound` 等**全是 undefined**，工具一调就崩 |
| W3 | 两套闸门挂进 `checkPrecondition` | `lib/store/precondition.js` | ★ **DEMO 闸门不会真的拦人**：未确认也能进 `ready_dev` |
| W4 | 开单时"先强制设主管" | `lib/store/lifecycle.js` | 裁定 1 的"先设"不成立，`L3+` 单子可能一开始就没有主管 |
| W5 | 两个新工具的注册 + 权限白名单 | `lib/tools.js` + `lib/guard/rules.js` | `pipeline_project_init` / `pipeline_demo` **根本不存在** |
| W6 | 需求位派活判据 | `lib/tools/dispatch.js`（`L292` 附近） | `tier ≥ L3` 无主管时需求位**照样能派** |
| W7 | 产品设计交接物字段表 | `lib/handoff/schemas.js` | `product_design` 交接物**交不进去**（未知类型） |
| W8 | p1–p8 登记进聚合跑 | `tests/run-all.mjs` | 8 套新测试**不在** `1874` 那个口径里（独立跑仍然可用） |
| W9 | 开单/派单时建项目目录 | `lib/tools/intake.js`（`L237` 附近） | 项目目录不会自动建（只能靠主对话显式调工具） |
| **W10** | **记忆域 E0**：`pipeline_recall` 的注册 + 工具总数断言 | `lib/tools.js` + `tests/load-smoke.mjs` + `tests/run-all.mjs` | ★ 工具**根本不存在**（`defineTool` 只在 `buildTools` 里被调用）；且 m5/m6 跑不到（假绿） |
| **W11** | **记忆域 E1**：retain 缝 + 注入点登记 + 总开关面 + `meterMessage` | `lib/intercept/registry.js` · `lib/hostmsg.js` · `lib/switch/gate.js` | ★ 记忆库永远是空的（只能靠席位自觉调工具）；★ 且 off 下**仍在写盘/注入** = 复现"开关只关一半" |

> **W10 / W11 已经做了**（本批次解除了"既有文件零修改"约束 —— 用户裁定 2）。
> 逐处改动、行数与覆盖它的测试写在 §W10 / §W11 两节里；`W1`–`W9` 仍是**待办**。

**最小可用接线**：`W1 + W2 + W3 + W5` —— 这四项做完，DEMO 闸门才**真的会拦人**。
`W4 + W6` 是 P5 那条治理规则的落点；`W7 + W9` 是便利性；`W8` 是测试口径。

---

## W1 · 状态机：DEMO 的两个新状态与四条边

**接通什么**：`lib/states/demo-phase.js` 的 `demoPhaseMerge({ ST, ROLE })`
（返回 `{ states, labels, transitions, events }`）

**落点 A** —— `lib/states.js`，**import 区**（`L39` 那行 `import { ROLE } from './roles.js'` 的**下面**一行）：

```js
import { demoPhaseMerge } from './states/demo-phase.js'
```

> ★ 这一行必须放在 `import { ROLE } ...` **之后**读起来才顺，但**位置不影响正确性** ——
> `demo-phase.js` 刻意**不 import `states.js`**（否则成环），它靠参数注入 `ST` / `ROLE`。

**落点 B** —— `lib/states.js`，`ST` 对象收尾的 `}`（**`L137`**）**之前**加两行：

```js
  /**
   * ★★ DEMO 阶段（P4 新增）：复杂任务先出可操作前端 DEMO，**用户确认后**才继续后端。
   * ★ 为什么不直接并进 `ready_dev`：`ready_dev` 是"活得切好了、只等派"，而这里是
   *   "DEMO 还在做 / 等用户点头"——**下一步该催谁**完全不同（催做 DEMO 的人 vs 催用户）。
   */
  DEMO_BUILDING: 'demo_building',
  DEMO_CONFIRM: 'demo_confirm',
```

**落点 C** —— `lib/states.js`，`STATE_LABEL` 收尾的 `}`（**`L198`**）**之前**加两行：

```js
  [ST.DEMO_BUILDING]: 'DEMO 制作中',
  [ST.DEMO_CONFIRM]: 'DEMO 待用户确认',
```

**落点 D** —— `lib/states.js`，`TRANSITIONS` 数组收尾的 `]`（**`L663`**）**之前**加一行：

```js
  // ★★ P4：DEMO 阶段的四条边（定义在 lib/states/demo-phase.js，本表只做合并）
  ...demoPhaseMerge({ ST, ROLE }).transitions,
```

**落点 E** —— `lib/states.js`，`STATE_OWNER` 对象收尾的 `}` **之前**加一行
（2026-10-16 补：这一条**当初漏了** —— 状态 26 个、owner 只有 24 个，而**没有任何测试变红**）：

```js
  ...demoStateOwners({ ROLE }),
```

```js
  [DEMO_ST.BUILDING]: ROLE.WRITER,   // DEMO 还在做 ⇒ 催做 DEMO 的人
  [DEMO_ST.CONFIRM]: ROLE.MAIN,      // DEMO 交上来了、等用户点头 ⇒ 用户只与主对话相连
```

> ★ 这两条**不能**写 `null`：`null` 在 `STATE_OWNER` 里的既有含义是"**终态，没人可催**"
> （`closed` / `cancelled`）。这两个是活跃态且在等人，给 `null` 等于把"该催谁"重新变回答不出来的问题。
> ★ 漏登记这件事**现在有判据了**：`tests/p10-state-owner-check.mjs` 断言
> 「状态全集 ⊆ `STATE_OWNER` 键集合」，漏一个即红并点名；另外还查反向多余键、
> owner 值必须是合法角色 id、`null` 只能出现在终态。

**为什么必须接线**：`applyTransition()` 只认 `TRANSITIONS` 表里登记过的 `(from, event)`。
表里没有 `demo_building`，`planning → demo_building` 这条边就**走不通**，
DEMO 阶段在真机上等于不存在。`p6` 里有一条断言专门把这个事实钉住：
`!Object.values(ST).includes('demo_building')` —— 接线之后那条断言会变红，
**那时应当把它改成"已接线"的断言**（这是预期的红，不是回归）。

**不接线的后果**：DEMO 阶段完全不可达；闸门 `demo_confirmed` 也永远不会被问到
（因为没有人能走到 `demo_confirm`）。**"L3+ 必须出 DEMO"这条裁定落不了地。**

**接线的验收点**：`pipeline_status` 能显示 `demo_building` / `demo_confirm`；
`applyTransition('planning', 'plan_ready_demo', 'planner')` 返回 `demo_building`。

---

## W2 · 存储：DEMO 与强制主管的方法挂上 store

**接通什么**：`lib/store/demo.js` 的 `demoMethods` 与 `lib/store/hub-require.js` 的 `hubRequireMethods`

**落点 A** —— `lib/store.js`，**import 区**（`L60` 那行 `import { purgeMethods } from './store/purge.js'` 的**下面**）：

```js
import { demoMethods } from './store/demo.js'
import { hubRequireMethods } from './store/hub-require.js'
```

**落点 B** —— `lib/store.js`，`...purgeMethods({...})`（**`L302`**）那一行的**下面**：

```js
    // ★★ P4：DEMO 阶段的推进/回退与三条软约束 —— 见 `lib/store/demo.js`
    ...demoMethods({ now, audit, deny, loadTask, persist }),
    // ★★ P5：L3+ 强制主管（先设后撤）—— 见 `lib/store/hub-require.js`
    ...hubRequireMethods({ now, audit, deny, loadTask, persist }),
```

**为什么必须接线**：`lib/store.js` 的 `createTaskStore` 是把各组方法**原位展开**进同一个对象
（`this` 指向那个对象）。不展开，`store.demoRound` / `store.hubForceOnOpen` 就是 `undefined`，
`lib/tools/demo.js` 一调就抛 `TypeError`。

**不接线的后果**：`pipeline_demo` 工具（接线后）一调就崩；即便不接工具，
`checkPrecondition` 里的 `this.checkDemoPrecondition(...)` 也找不到方法。

**接线的验收点**：`typeof store.demoRound === 'function'` 且 `typeof store.hubForceOnOpen === 'function'`。

---

## W3 · ★★ 闸门：两套判据挂进 `checkPrecondition`

> **这是本批次最要紧的一条接线。** 不做这一条，DEMO 闸门**不会真的拦人**。

**接通什么**：`lib/store/demo.js` 的 `checkDemoPrecondition(task, name, input)`

**落点** —— `lib/store/precondition.js`，`checkPrecondition` 里 `switch (name) {` 的收尾 `}`
（**`L835`**，紧接着就是 `return { ok: true }` 那一行）**之前**，加两个 case：

```js
        // ★★ P4：DEMO 闸门（P4 新增）--------------------------------------
        //
        //   `demo_confirm → ready_dev`（`demo_confirmed`）这条边**必须**有用户确认。
        //   判据本体在 `lib/guard/demo-gate.js`，经 `store.checkDemoPrecondition` 转发 ——
        //   工具层与守门层调的是**同一份**实现（与既有各闸门同一条规矩）。
        //
        //   ★ 为什么在这里判、而不是在工具里判：工具能被绕过（直接调 transition），
        //     状态机这一层绕不过去。闸门装在"必经之路"上才算闸门。
        case 'demo_confirmed':
        case 'demo_round_ok': {
          return this.checkDemoPrecondition(task, name, input)
        }
```

**为什么必须接线**：`TRANSITIONS` 表里的 `guard: 'demo_confirmed'` 只是一个**名字**。
`applyTransition` 之后由 `store.checkPrecondition` 按名字找判据；找不到就落到
`switch` 末尾的 `return { ok: true }` —— 也就是**默认放行**。

**不接线的后果**：★ **未获用户确认也能进 `ready_dev`** —— 验收 A17 直接不成立；
W1 接好了也一样（状态能走通，但没人拦）。

**接线的验收点**：在 `demo_confirm` 状态下，没有用户确认时
`pipeline_transition { event: "demo_confirmed" }` 被拒，理由里带
`DEMO_NOT_CONFIRMED` / `DEMO_CONFIRM_NOT_ANSWERED`。

---

## W4 · 开单：pending 阶段"先强制设主管"

**接通什么**：`lib/store/hub-require.js` 的 `hubForceOnOpen(taskId, { by })`

**落点** —— `lib/store/lifecycle.js`，`open()` 里 `cache.set(id, task)` / `await persist(task)`
（**`L174`–`L175`**）那一对**之后**：

```js
      /**
       * ★★ P5：**开单先强制设主管**（裁定 1 / 定稿 §3.5 的 `pending` 那一条）。
       * ★ 刻意**不做试算**：`pending` 时还没有 tier，先猜档位再决定设不设主管，
       *   会在"猜 L1、实际 L4"时留下一个**没有责任人的补救动作**。
       * ★ 幂等：`hubForceOnOpen` 自己判重，重复调用不写盘。
       */
      await this.hubForceOnOpen(id, { by: input.actorRole })
```

**为什么必须接线**：这是"先设后撤"里**先设**的那一半。没有它，
`task.hub_requirement` 永远是空的，`hubSeatPresent()` 只能靠 `roster` —— 而 `pending`
时 `roster` 还是 `null` ⇒ **任何单子一开局都是"没有主管"**。

**不接线的后果**：`L3+` 的单子从开单到派活全程没有主管席位；
`hubCanDispatchOrchestrator` 会一直拒（如果 W6 也接了），流程卡在第一步。

**接线的验收点**：`pipeline_task_open` 之后，
`pipeline_status` 里 `task.hub_requirement.forced === true`。

---

## W5 · 工具面：注册两个新工具 + 加进权限白名单

**接通什么**：`lib/tools/project.js` 的 `buildProjectTools` 与 `lib/tools/demo.js` 的 `buildDemoTools`

**落点 A** —— `lib/tools.js`，**import 区**（`L53` 那行 `import { buildPurgeTools } from './tools/purge.js'` 的**下面**）：

```js
import { buildProjectTools } from './tools/project.js'
import { buildDemoTools } from './tools/demo.js'
```

**落点 B** —— `lib/tools.js`，`buildPurgeTools` 的调用（**`L255`**）**之后**：

```js
  // 项目目录与仓库（pipeline_project_init） —— 见 `lib/tools/project.js`
  const { projectInit } = buildProjectTools({ deps, store, load, dshHome: config.dshHome })
  // DEMO 阶段（pipeline_demo） —— 见 `lib/tools/demo.js`
  const { demo } = buildDemoTools({ deps, store, load })
```

> ★ `dshHome` 在 `config` 上不一定有 —— 没有就传 `undefined`，
> `resolveProjectDir` 会返回 `NO_DSH_HOME`（可读的拒绝），**不会崩**。

**落点 C** —— `lib/tools.js`，`allTools` 对象里 `taskPurge,`（**`L360`**）那一行的**下面**：

```js
    // ★★ P1：项目目录与仓库（幂等建目录 / git 化闸门 / 快照版本目录）
    projectInit,
    // ★★ P4：DEMO 阶段（档位策略 / 交轮次 / 用户确认）
    demo,
```

> `allTools` 下面那个 `for (const def of Object.values(allTools))` 循环会**自动**把新工具
> 收进 `toolNameList` / `toolDefList` —— 所以工具面派生（E 路③）不必再改一行。

**落点 D** —— `lib/guard/rules.js`，`PIPELINE_TOOL_ROLES` 表里
`pipeline_task_purge: ['main'],`（**`L369`**）那一行的**下面**（表的收尾 `}` 在 `L370`）：

```js
  // ★★ P1：项目目录与仓库 —— 与关单同档，只有主对话能开（它决定"在哪干活"）
  pipeline_project_init: ['main'],
  // ★★ P4：DEMO 阶段 —— `plan`/`confirm` 是主对话的决定；`round` 由编写席位交，
  //   但工具面按**动作**分流太细，这里与 `pipeline_transition` 同档放开给 main，
  //   席位侧由 `lib/tools/demo.js` 里的 `resolveActor` 与状态机的 `by` 名单兜住。
  pipeline_demo: ['main'],
```

**为什么必须接线**：`defineTool` 只在 `buildTools` 里被调用；没被调用 = **不注册** =
模型看不到这两个工具（`pipeline_status` 的 `tool_face` 里也没有）。
另外 `lib/guard/decide.js:191` 会按 `PIPELINE_TOOL_ROLES` 判权限；
表里没有这个名字 ⇒ `allowed === undefined`，**判词与工具面都会漂**。

**不接线的后果**：`pipeline_project_init` / `pipeline_demo` 完全不存在 ——
P1/P4 的全部功能**没有任何入口**（测试能过，真机用不上）。

**接线的验收点**：`node tests/schema-check.mjs` 的工具数从 27 变 29；
`pipeline_status` 的工具面里出现这两个名字。

---

## W6 · 需求位派活判据：`tier ≥ L3` 无主管则拒

**接通什么**：`lib/store/hub-require.js` 的 `hubCanDispatchOrchestrator(taskId, {...})`

**落点** —— `lib/tools/dispatch.js`，`const allowedBootstrap = ...` 那一块
**之前**（也就是"决定要不要放开 orchestrator"的那一刻）：

```js
      if (role === ROLE.ORCHESTRATOR) {
        const hubOk = await store.hubCanDispatchOrchestrator(task.id, {
          // ★★ 注意：**不是** `task.state !== ST.PENDING`，见下面"判据修正"。
          requirementConfirmed: !isUnknownTier(task.hub_requirement?.tier),
          by: actor.role,
        })
        if (hubOk.ok !== true) return { ok: false, agent_id: '', role, seat: String(args.seat ?? ''), token: '', summary: hubOk.error }
      }
```

> ### ★★ 判据修正（2026-10-16，**以本节为准**）
>
> **本节原来的示例写的是** `requirementConfirmed: task.state !== ST.PENDING`。那句**过宽**，
> 已按实测证据改为「**档位有没有落地**」= `!isUnknownTier(task.hub_requirement?.tier)`。
>
> **为什么**：`checkOrchestratorDispatch()` 把这条参数定义为「档位是否已经落地
> （`requirement_confirmed` 过了）」，而档位是 `hubSyncOnRequirementConfirmed` 写进
> `hub_requirement.tier` 的。`state !== PENDING` 是个代理判据 ——
> `analyzing` 的单子**档位还没落地**（`tier` 仍是 `null`）却会被算成"已确认" ⇒
> `tierOrdinal(null)` ⇒ **`BAD_TIER` 误拒**。
>
> **偏离依据（可执行的，不是"觉得更准"）**：照原文写，下列测试会红 ——
> · `tests/liveness-check.mjs` §C「端到端处置」三条正例：
>   - `★★ 正例：pipeline_dispatch { reassign: true } ⇒ 从「已阻塞」自动恢复并重派同一席位（一键）`
>   - `★★ 正例：重派刷新派活台账（重新计时 ⇒ 不再被判失联）`
>   - `★ 正例：任务不在阻塞态时 reassign:true 只是普通派活`
>   （实测输出：`档位未知（未编排）—— 需要按"未知 ⇒ 保守"的调用方请先用 isUnknownTier 分流`）
> · `tests/selftest-core.mjs` §反例④「主对话自行增删角色」的
>   `L0 配置下没有独立编排角色 → 角色变更复核路径不可达`（拒绝理由从"不在本角色清单里"变成 `BAD_TIER` 文案）
> · `tests/p9-orchestrator-dispatch-gate-check.mjs` §③ 把这件事**做成了断言**：
>   同一张"档位未落地"的单，喂 `true` ⇒ `BAD_TIER`；喂 `false` ⇒ 放行。
>
> **为什么不"两边都拦"**：`tier` 未知走的是 `checkOrchestratorDispatch` 的"档位还没落地"分支 ——
> 主管是**开单时先强制设上**的那一个（§W4），照旧在册 ⇒ 放行。这正是"先设后撤"要的效果。
> `tier-order.js` 自己的话就是这条纪律：「需要按"未知 ⇒ 保守"的调用方请先用 `isUnknownTier` 分流，不要在这里猜」。
>
> **接线位置也与本节原来的描述略有出入**：不在 `roster === null` 那个分支**里面**，
> 而在它**之前** —— 有清单但清单里没 `supervisor` 正是要拦的形状，放进分支里就漏掉了。
>
> **回执里没有 `code` 字段**：`pipeline_dispatch` 的 `output` 是 `additionalProperties:false`，
> 多一个键过不了宿主输出校验。判据码在 `store.hubCanDispatchOrchestrator()` 的返回值上。

**为什么必须接线**：`hubCanDispatchOrchestrator` 是一个**判据**，判据不会自己跑。
不在这条路上调用它，"L3+ 无主管时需求位被拒"就只是一句注释。

**不接线的后果**：`tier ≥ L3` 的单子在主管席位缺失时**照样能派出需求位** ——
需求位交出结论之后会悬在半空（第①道确认没有人接），验收 A19 不成立。

**接线的验收点**：造一个 `hub_requirement.tier = 'L3'` 且 `roster` 里没有 `supervisor`
的任务，调 `pipeline_dispatch { role: "orchestrator" }` 被拒，
`store.hubCanDispatchOrchestrator()` 返回 `code === 'HUB_REQUIRED_MISSING_SUPERVISOR'`
（工具回执上看到的是它的文案，不是码 —— 见上面的"判据修正"）。
★ 判据化的验收在 `tests/p9-orchestrator-dispatch-gate-check.mjs`（正例/反例/输入→输出表）。

---

## W7 · 交接物：`product_design` 并进字段表

**接通什么**：`lib/handoff/schemas/product-design.js` 的 `PRODUCT_DESIGN_SCHEMA`

**落点** —— `lib/handoff/schemas.js`，`HANDOFF_SCHEMAS` 对象收尾的 `}`（**`L660`**）**之前**：

```js
  // ★★ P3：产品目录 + 产品设计文档（与 DEMO **同批一次确认**，裁定 6 / 验收 A15）
  //   字段表定义在 `lib/handoff/schemas/product-design.js`，本表只做合并。
  [PRODUCT_DESIGN_KIND]: PRODUCT_DESIGN_SCHEMA,
```

并在该文件 import 区（`L11` 那行 `import { F, ... } from './fields.js'` 的**下面**）加：

```js
import { PRODUCT_DESIGN_KIND, PRODUCT_DESIGN_SCHEMA } from './schemas/product-design.js'
```

> ★ 注意 `lib/handoff/schemas.js`（文件）与 `lib/handoff/schemas/`（目录）**同名不同物**，
> 这是本批次新开的目录 —— Node 的解析不会混淆（`./schemas.js` vs `./schemas/x.js`），
> 但读代码的人容易看错，所以在这里点明。

**为什么必须接线**：`submitHandoff` 按 `HANDOFF_SCHEMAS[kind]` 找字段表；
表里没有 `product_design` ⇒ 该类型的交接物**根本交不进去**。

**不接线的后果**：需求 agent 交不出产品目录（只能塞进 `requirement_analysis` 的自由字段里），
P3 的校验（空 MVP 被拒、每条带验收判据）**在真机上不生效**。

**接线的验收点**：`pipeline_handoff { kind: "product_design", ... }` 能提交；
`catalog.mvp = []` 时被拒，理由带 `CATALOG_EMPTY_MVP`。

---

## W8 · 测试：p1–p8 登记进聚合跑

**接通什么**：8 套新测试（本批次**刻意未登记**，理由见 `CONVENTIONS.md` §6）

**落点 A** —— `tests/run-all.mjs`，import 区（`L157` 那行 `import { runMainReattachCheck } ...` 的**下面**）：

```js
// ★★ P1–P5（2026-10-16 批次）：8 套对照测试。本批次带"零修改既有文件"约束，
//    所以当时**刻意没有登记**；解除约束后按本节补上（不登记 = 跑不到 = 假绿）。
import { runP1ProjectDirCheck } from './p1-project-dir-check.mjs'
import { runP2SnapshotVersionCheck } from './p2-snapshot-version-check.mjs'
import { runP3GitInitCheck } from './p3-git-init-check.mjs'
import { runP4AgentsMdCheck } from './p4-agents-md-check.mjs'
import { runP5ProductCatalogCheck } from './p5-product-catalog-check.mjs'
import { runP6DemoPhaseCheck } from './p6-demo-phase-check.mjs'
import { runP7HubRequiredCheck } from './p7-hub-required-check.mjs'
import { runP8ScopeRootCheck } from './p8-scope-root-check.mjs'
```

**落点 B** —— `tests/run-all.mjs`，`process.exit(ok ? 0 : 1)`（**`L747`**）**之前**：
按既有各套同一个累加模式（`passed += r.passed; total += r.total; if (r.passed !== r.total) ok = false`）
各加一个 `{ ... }` 块。

**★ 前置改动（否则登记不进去）**：现有 8 个测试文件是**顶层立即执行 + `process.exit()`** 的写法，
**没有导出运行器**。要登记，每个文件需要像其余各套那样补一个 `runPNXxxCheck()` 导出
（返回 `{passed, total, text}`），把 `main()` 的产物收进 `text` 而不是直接 `process.exit`。
这一步**属于修改新文件**，不违反"零修改既有文件"（p1–p8 是本批次新建的）。

**不接线的后果**：p1–p8 **不在** `1874 + N` 那个口径里。
它们**仍然可以独立跑**（`node tests/pN-xxx-check.mjs`），但 `run-all.mjs` 的全绿
**不能**被读成"新功能也全绿"。

---

## W9 · 项目目录：开单/派单时自动建（可选，但推荐）

**接通什么**：`lib/tools/project.js` 的 `projectInitCore`

**落点** —— `lib/tools/intake.js`，`const res = await store.open({...})`（**`L237`**）
那一块**之后**（开单成功、拿到 `res.task` 之后）：

```js
      /**
       * ★★ P1：**派单后先建项目目录**（幂等、无副作用）。
       * ★ `git` 一律**不传**（= false）：git 化必须由主对话**显式确认**
       *   （裁定 11），自动建目录**绝不能**顺手把仓库也开了。
       */
      if (res.ok === true) {
        const proj = await projectInitCore(
          { taskId: res.task.id, git: false, actorRole: input.actorRole, scopePaths: res.task.change_scope?.map((e) => e.path) },
          { task: res.task, dshHome: config.dshHome, ensureAgentsMd },
        )
        if (proj.ok === true && proj.project_dir.length > 0) {
          await store.recordAudit(res.task.id, input.actorRole, 'project:auto_init', {
            project_id: proj.project_id, project_dir: proj.project_dir, mode: proj.mode,
          })
        }
      }
```

（`projectInitCore` 与 `ensureAgentsMd` 需要在该文件顶部 import —— 见 W5 的落点 A 同款写法。）

**为什么必须接线**：`pipeline_project_init` 是一个**工具** —— 不调它就不会发生。
用户要的是"**派单后先建**"，那是**自动**语义；只给工具等于把这一步变成"主对话要记得做"，
而"要记得做"从来不是机制。

**不接线的后果**：项目目录不会自动建（主对话得手动调一次工具）；
`project_id` / `project_dir` 两字段大部分时候是空的，"一项目多单"复用也就无从谈起。

**接线的验收点**：`pipeline_task_open` 之后，`task.project_dir` 非空且目录真实存在；
再开一张同项目的单，`project_dir` 指向**同一个**目录。

---

## W10 · 记忆域 E0：`pipeline_recall` 的注册 + 两套测试进聚合跑

> ★★ **这一项已经做了**（本批次解除了「既有文件零修改」约束 —— 用户裁定 2）。
> 本节按 §5 的格式**逐处**记下来：文件:行 · 加了什么 · 为什么非加不可 · 哪个测试覆盖它。

**接通什么**：`lib/tools/memory.js` 的 `buildMemoryTools({ deps, store, load })` —— 只读切片工具 `pipeline_recall`。

| # | 落点（文件:行） | 加了什么 | 为什么**非加不可** | 覆盖它的测试 |
|---|---|---|---|---|
| W10.1 | `lib/tools.js:62` | `import { buildMemoryTools } from './tools/memory.js'` | 不 import 就没法调用它 | 全部（`load-smoke` 会因少注册一个工具而红） |
| W10.2 | `lib/tools.js:278` | `const { memoryRecall } = buildMemoryTools({ deps, store, load })` | ★ `defineTool` **只**在 `buildTools` 里被调用 ⇒ 不在这里调用 = **工具不存在** | `load-smoke`（注册数必须精确等于 35） |
| W10.3 | `lib/tools.js:389` | `memoryRecall,`（`allTools` 里一行） | 注册循环遍历的是 `allTools` ⇒ 不收进来就等于没产出 | `load-smoke` · `schema-check` |
| W10.4 | `lib/hostmsg.js:333` | `export function meterMessage(text)`（+ 文档） | ★ `role:'user'` 字面量在全插件**只许出现在 `hostmsg.js`**（`liveness-check` 的 A5 是**机械判据**：扫 `lib/**` 代码行）。计价要向 `ctx.tokenMeter.estimateMessage` 交一条**形状正确**的消息 —— 所以它的唯一合法出处就是这里 | `m6`（计价走宿主 meter）· `liveness-check` A5（0 处违规） |
| W10.5 | `tests/load-smoke.mjs:190` | `EXPECTED_TOOL_COUNT` 34 → **35** | 该断言语义是"**精确相等**"（少一个=能力消失、多一个=悄悄多一条能力，都红）。多了一个具名工具 ⇒ 这个数**必然**跟着变；方向一个字没放宽 | `load-smoke` |
| W10.6 | `tests/run-all.mjs:739-740` | 两条登记：`m5` / `m6` | 不登记 = 聚合跑**跑不到** = **假绿**（本域没有 p1–p8 那条"刻意不登记"的理由了） | `run-all` 汇总行（2592 → 现数） |

**新文件（全部新增，一行既有代码没碰）**：
`lib/memory/bank.js`（落点解析）· `lib/memory/load.js`（读既有档案）·
`lib/memory/route-time.js`（时间路）· `lib/memory/route-keyword.js`（关键词路）·
`lib/memory/merge.js`（合并去重 + 确定性重排）· `lib/memory/budget.js`（★ 硬上限）·
`lib/tools/memory.js`（工具面）· `tests/m5-memory-route-check.mjs` · `tests/m6-memory-budget-check.mjs`。

**不接线的后果**：`pipeline_recall` **根本不存在**（模型看不到它，工具面是全插件唯一给模型的入口）；
`m5`/`m6` 即使全绿也**不在**聚合口径里 —— 那正是本仓反复写过的"跑不到的全绿 = 假绿"。

**接线的验收点**：`node tests/load-smoke.mjs` 断言注册数 == 35；
`node tests/run-all.mjs` 的汇总分母包含 `m5` + `m6` 的用例。

---

## W11 · 记忆域 E1：retain 缝 + 注入缝 + 总开关面 + 计价消息的唯一出处

> ★★ **这一项已经做了**（用户裁定 2）。三处点名的接线：`lib/intercept/registry.js` 的 `HOOKS`、
> `lib/hostmsg.js` 的 `HOST_INJECTION_SITES`、`lib/switch/gate.js` 的 `SWITCH_SURFACES`。

**接通什么**：`lib/memory/retain-hook.js`（`tools/post-execute` → 写库）与
`lib/memory/inject-hook.js`（`agent/pre-step` → 把最近记忆作为运行时上下文交给席位）。

| # | 落点（文件:行） | 加了什么 | 为什么**非加不可** | 覆盖它的测试 |
|---|---|---|---|---|
| W11.1 | `lib/intercept/registry.js:41,42` | 两条 import（记忆域两个 hook 工厂） | 不 import 就挂不上 | `m4` · `m8` · `load-smoke` |
| W11.2 | `lib/intercept/registry.js:63` | `HOOKS` 加 `memory-inject`（排在开场简报之后） | 不加 ⇒ **记忆永远不进席位**（recall 只能靠席位自己想起来调） | `m8`（挂载数 6）· `load-smoke`（pre-step = 2） |
| W11.3 | `lib/intercept/registry.js:67` | `HOOKS` 加 `memory-retain`（**插在 ③ 唤醒与 ④ 结果网之间**） | ★ 不加 ⇒ **库永远是空的**（正是用户要排除的"依赖席位自觉"）；★ 位置错了就记成"被本插件换成 feedback 的结果"（设计 04 §1 的裁决） | `m4` · `m8` · `load-smoke`（post-execute = 3） |
| W11.4 | `lib/intercept/registry.js:194,195` | `svc` 加 `projectDir` / `tokenMeter`（都可能 undefined） | 缝里拿不到项目目录 ⇒ 记忆库落点算不出来（那就只能静默不写） | `m4`（落点取不到 ⇒ 静默不写）· `m8` |
| W11.5 | `index.js:658-664` | `registerInterception` 传 `projectDir` + `tokenMeter` | 同上（取值处；`ctx.tokenMeter` 拿不到就降级，不新增 `inject` 依赖） | `load-smoke`（`inject` 仍然只有 `tools`） |
| W11.6 | `lib/switch/gate.js:136-150` | `SWITCH_SURFACES` 加 **2 行**：`memory-retain`（`kind:intercept`）、`memory-inject`（`kind:inject`），都是 `off:'inert'` | ★ 不登记 ⇒ `pipeline_switch {on:false}` 之后记忆**仍在写盘 / 仍在注入** —— 那正是用户报过的"开关只关一半"。★ `switch-off-text-check` 的文案由这张表生成，登记即文案 | `m8`（R15）· `switch-off-no-hooks-check`（挂 6 → 关 0）· `switch-off-text-check` |
| W11.7 | `lib/hostmsg.js:289-296` | `HOST_INJECTION_SITES` 加 `pre-step-memory-recall` 一行 | ★ 注入点**必须先登记**：一条裸消息就能让整个 turn 以 `reading 'kind'` 收尾（`hook-prompt.js:5-15` 的真实事故）。登记表是"防漏"的判据，自测按它核对 | `m4`（R14：注入形状 + 登记表里那一行逐字一致） |
| W11.8 | `lib/hostmsg.js:333` | `meterMessage()`（E0 已加；W11 起被 `lib/memory/budget.js` 用） | `role:'user'` 字面量全插件只许住这里（`liveness-check` A5 是**机械判据**：扫 `lib/**` 的代码行） | `m6` · `liveness-check` A5（0 处违规） |
| W11.9 | `tests/load-smoke.mjs:241` | 中间件条数：pre-step 1→**2**、post-execute 2→**3** | 本轮**有意**新增两条缝 ⇒ 这个计数必然变；判定方向**没放宽**（仍是精确相等） | `load-smoke` |
| W11.10 | `tests/switch-off-no-hooks-check.mjs:106` | 挂载数 4→**6**（开）/ 0（关） | 同上；"关 ⇒ 0"这条**一个字没动** | `switch-off-no-hooks-check` |
| W11.11 | `tests/switch-off-text-check.mjs:124` | 缝计数正则扩到 `(?:seam\|memory)-`，期望 4→**6** | ★ 不扩就是**判据本身漏了**：新缝不进计数 ⇒ "每条缝都有闸门"这句话不再成立 | `switch-off-text-check` |
| W11.12 | `tests/run-all.mjs:741-747` | 登记 `m1` / `m2` / `m3` / `m4` / `m8` | 不登记 = 跑不到 = **假绿** | `run-all` 汇总行 |

**新文件（全部新增）**：`lib/memory/record.js`（形状与校验）· `alias.js`（实体归一）·
`append.js`（追加写，绝不抛）· `retain-hook.js`（retain 缝）· `retain-transition.js`（迁移 → 记忆）·
`inject-hook.js`（注入缝）；`load.js` 增加 `readBank()`（读记忆库，坏行跳过）。
测试：`tests/m1…m4` · `tests/m8`。

**不接线的后果**：`W11.2/W11.3` 不接 ⇒ 记忆库永远是空的（E0 的 `recall` 只能读既有档案）；
`W11.6` 不接 ⇒ off 之后仍在写盘/注入；`W11.7` 不接 ⇒ 注入出去的是裸消息，**整个 turn 会死**。

**接线的验收点**：`node tests/m8-memory-switch-check.mjs`（off ⇒ `mounted()` 为空 + 库字节不变）；
`node tests/load-smoke.mjs`（挂载条数 1/2/3）；`node tests/switch-off-no-hooks-check.mjs`（4→6→0）。

**★ 本阶段**没有**做的事（如实写在 WIRING 里，免得被读成"已接"）**：
`lib/memory/retain-transition.js` 的 `appendTransition` **还没挂到** `lib/store/lifecycle.js` 的迁移出口
—— 按设计 `06-分阶段.md`，那一步属于 **E3**（与 `lib/store/review.js` 的关单触发一起）。

---

## 附：本批次**没有**做的事（避免误读）

1. **一个既有文件都没改**（`git diff main...HEAD --name-status` 全是 `A`）——
   所以上面 W1–W9 **全部都没做**。
   > ★ 记忆域（`W10`/`W11`）是**例外**：用户裁定 2 批准解除该约束，
   > 限定为"每处只加几行 + 受开关管的面要登记进 `SWITCH_SURFACES` + 有测试覆盖"，
   > 逐处改动见 §W10 / §W11。
2. **没有 push、没有 fetch、没有改 remote**；只在本地分支 `feat/project-dir-and-demo` 上提交。
3. **没有重新生成 `MANIFEST.sha256`**（按用户口径）。
4. **没有把 P6（同项目 agent 团队复用）做进来** —— 另立项。
5. **没有跑 `pnpm install` / `npm install`**，没有动 `node_modules` 结构，没有重启 DSH。
