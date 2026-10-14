# `tests/_retired/` —— 已退役的测试套件

这个目录里的文件**不属于全量测试**，`tests/run-all.mjs` 用的是**显式 import 注册表**，
不会扫到这个子目录，所以放在这里既不会被跑到，也不会被误当成"通过的用例"。

保留而不硬删，是为了留证据、可复审、可复活。

---

## `seat-liveness-wake-check.mjs`（2026-10-15 退役）

**原用途**：两条缺陷的验收夹具 —— ① 席位失联误报（"正在写交付"被判死并冻结）；
② 澄清裁定之后**发起席位没有被唤醒**。需求档 `H-d6cdcd25b7389aed` 的 A1~A7 + 测试要点 P1~P8，
共 56 条断言。

**退役前的实测状态（本机 node v24.19.0 / win32）**：

```
node tests/seat-liveness-wake-check.mjs
总计：38/56 通过          （exit 1）
```

### 为什么是"退役"而不是"改期望值"

★ **不是数字过期，是观测点没了。**

这套夹具把投递**全部**记在 `fx.h.transport.notifyRole` 上，
判据写成 `fx.h.transport.calls.filter(c => c.kind === 'notify')`（见原文件 P7 / A6 / A7 三组）。

而 C 路改造之后，生产侧的唤醒投递走的是 `lib/wakeup/deliver.js` 的 `deliverWake()`，
它**根本不经过 `transport.notifyRole`**：

```
deliverWake(ctx, spec)
  (a) ctx.agents.get(sessionId).followup(message)        ← 宿主服务
  (b) ctx.sessionController.prompt({requestId,sessionId,mode:'queue',content})   ← 退路，也是宿主服务
```

⇒ 那个替身**永远拦不到**投递。18 条红里凡是"投递目标 / 投递次数 / 投递正文"类的断言，
**结构上不可观测**，不是期望值差一个数。

要"更新"它 = 把观测面整个重写成 `ctx.agents` / `ctx.sessionController` 的替身，
并且逐条重新校准期望 —— 那是**重写**，不是改数字；且必须反复实跑才算数。

### 为什么不值得现在就重写

| 理由 | 说明 |
| --- | --- |
| 它本来就没进全量 | `run-all.mjs` 里从来没有 `runSeatLivenessWakeCheck`（显式注册表，非目录扫描）⇒ 对全量通过率贡献 **0** |
| 同类覆盖已在全量里 | A1/A2/A3（失联判定口径、真阳性保留、离线复算）由已注册的 `liveness-check` **44/44** 覆盖；唤醒面由 `wake-check` / `wake-channel-check` / `wake-identity-carry-check` 覆盖 |
| 留红比留空更坏 | 一套"永远红、又不在全量里"的夹具，每轮复核都要重新裁定一次它算不算数 —— 这正是它从 10-14 挂到 10-15 的原因 |

### 要复活它，照这三步

1. 把观测面从 `transport.notifyRole` 换成 `ctx.agents` / `ctx.sessionController` 的替身
   （照 `tests/wake-channel-check.mjs` 与 `tests/notify-only-delivery-check.mjs` 的现有写法）；
2. 逐组重新校准期望值到**当前**判据口径（`lib/wakeup/deliver.js` + `lib/liveness.js`）；
3. 在 `tests/run-all.mjs` 里加 import 注册 —— **否则复活了也还是不计入全量**。

### 它当年是为什么没注册（如实留存，原文口径）

不是遗漏，是**权限面**：当时的任务授权只给了 `tests/` 的 `create`，
没有给 `run-all.mjs` 的 `modify` ⇒ 改它会被守门按"命中的授权是 create、但路径已存在"直接拒。
