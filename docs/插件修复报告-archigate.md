# dsh-archigate 两处缺陷修复报告

- 日期：2026-10-13
- 被修副本（生效副本）：`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-archigate`
- 验证脚本与原始日志留档：`%USERPROFILE%\.dsh\dsh_orb\archigate-fix-verify\`（修复前三份原文在 `pristine\`）
- ★ **未做活体验证**：改的是生效副本，插件模块是在 DSH 进程启动时加载的，**必须重载才生效**。本次所有验证都走 CLI / 直接 import 磁盘上的新代码，**没有**经过本会话已注册的 `diagram_deliver` 工具。

> ★ **口径声明（2026-10-14 校正）**：本文件里「次数 / 条数 / 字节数」等一切可核对数字，**一律以账本为准**，且**必须标明是【哪一张单】的数字**。
> **账本位置**：`%USERPROFILE%\.dsh\profiles\desktop\.pipeline\<单号>\task.json`（席位失联冻结次数 = `liveness.escalations` 数组长度）与 `<单号>\audit.jsonl`（全部阻塞事件 = `transition:block` 行数；`note` 含「机制触发」的才是失联冻结）。
> 凡**未标明单号**、或**未与账本逐条对齐**的计数，**视为不可信**。逐处对照见 `%USERPROFILE%\.dsh\dsh_orb\文档数字校正报告.md`。
> **说明**：本文**不含**「误报冻结 / 失联次数」类计数（其 85 项自检、哈希等数字都是本文件自身的离线实测），故无可校正之处。

改动文件哈希（SHA-256，前 16 位）：

| 文件 | 改前 | 改后 |
| --- | --- | --- |
| `index.js` | `43E77206F0B03BE1` | `6A53B2C1DA171881` |
| `bin/archigate.mjs` | `596D26E979143D43` | `6620FEFF9DBE14A4` |
| `lib/geometry-solver.js` | `D75E8A2A210BDFEE` | `457F6379B621EF6D` |

本目录**没有** `tests/` 目录，`package.json` 里**没有** `scripts` 段；现有自检入口是 `node bin/archigate.mjs selftest`（离线，不碰磁盘、不跑 archify）。改动前后各跑一次，**均 85 项全过**。

---

## 一、缺陷 (a)：不传 `auto_geometry` 时崩 `g.rounds is not iterable`

### 现象

`diagram_deliver` 不传 `auto_geometry`（默认关）时，**交付已经成功、HTML 已经落盘**，随后在拼摘要那一步抛 `TypeError: g.rounds is not iterable`。

复现（活体，CLI 同路径）：

```
node bin/archigate.mjs deliver --spec <spec> --out-dir <out> --project dsh-archigate --root-dir <ws> --repo-root <plugin>
[6/6] archify finalize：architecture → …\out-old-nogeo\dsh-archigate-architecture.html（证据模式 metadata-only）
[archigate] 未捕获错误：
TypeError: g.rounds is not iterable
    at doDeliver (…\archigate-old\bin\archigate.mjs:183:23)
OLD_EXIT=1
```

### 根因

`lib/pipeline.js:1359` 在 `auto_geometry` 关着时返回的是

```js
geometry: { requested: false, note: 'auto_geometry 未开启（默认关），本次未走几何求解器。' }
```

它**没有** `rounds` 字段。而摘要代码用的是宽判据 `if (result.geometry)` —— 这个对象为真，于是走到 `for (const r of g.rounds)`，`undefined` 不可迭代 ⇒ 崩。**默认路径（不开几何）必踩**。

同一个过宽判据在**本目录里有两处落点**（都在同一语义位置）：

- `index.js:423`（工具摘要，用户点名的那处）
- `bin/archigate.mjs:175`（CLI `deliver` 摘要，一模一样，`deliver` 不带 `--auto-geometry` 必踩）
- 外加 `index.js:465` 附近把同一判据用在**返回值**上：`...(result.geometry ? { geometry_rounds: g.rounds_used, geometry_feasible: g.ok === true } : {})` —— 不崩，但会让调用方看到 `geometry_feasible: false` / `geometry_rounds: undefined`，把"没开几何"误读成"几何求解失败"。

### 改动（外科手术式）

| 文件:行（改后） | 改动 |
| --- | --- |
| `index.js:427` | `if (result.geometry)` → `if (result.geometry && Array.isArray(result.geometry.rounds))`（+4 行注释说明为什么判据必须是"真的有 rounds"） |
| `index.js:467` | 同一判据的第二个落点，同样收紧（+2 行注释） |
| `bin/archigate.mjs:178` | 同 index.js，`if (result.geometry && Array.isArray(result.geometry.rounds))`（+3 行注释） |

`bin/archigate.mjs` 与 `index.js:467` 这两处**不在用户给的清单里**（用户只点名 `index.js:423/429`），但它们是同一个判据的同一处语义、同一个崩溃/同一类误报，所以一并收紧并在此明示。**没有**做任何重构、没动周边代码。

### 验证

**① 确定性最小验证（不经 archify/normify/浏览器）** —— 跑**真的** index.js handler，只把 `lib/pipeline.js` 换成 stub（loader hook），喂给它一个"交付成功但 `geometry={requested:false}`"的返回值：

```powershell
node "%USERPROFILE%\.dsh\dsh_orb\archigate-fix-verify\harness-a.mjs" "%USERPROFILE%\.dsh\dsh_orb\archigate-fix-verify\pristine\index.js.orig"
node "%USERPROFILE%\.dsh\dsh_orb\archigate-fix-verify\harness-a.mjs" "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-archigate\index.js"
```

修复前（pristine 副本）实收：

```
FAIL  用例 1：不传 auto_geometry 时 execute() 不抛错，且 summary 不含"几何自调" —— TypeError: g.rounds is not iterable
PASS  用例 2（回归）：有 rounds 时照旧打印逐轮记录 —— geometry_rounds=1，viewBox=1042x568
=== 用例 1（不传 auto_geometry）的 summary 原文 ===
(未产出：execute 抛错了 —— 这就是修复前的现象)
结果：1 个用例 FAIL
EXIT_OLD=1
```

修复后实收：

```
PASS  用例 1：不传 auto_geometry 时 execute() 不抛错，且 summary 不含"几何自调" —— summary 8 行，ok=true
PASS  用例 2（回归）：有 rounds 时照旧打印逐轮记录 —— geometry_rounds=1，viewBox=1042x568

=== 用例 1（不传 auto_geometry）的 summary 原文 ===
[archigate] 交付完成。
HTML：C:/tmp/out/x.html
字节数：123
sha256：aaaa…
收据：C:/tmp/out/.receipts/t.json
normify 校验：0 error / 0 warning，结构树 31 个模块
映射闸门：8/8 个组件有归属，引用模块 5 个
证据模式：metadata-only

结果：两个用例都 PASS
EXIT_NEW=0
```

**② 活体端到端（真跑 normify + archify + Edge browser-check）**，同一份规格、同一个结构数据副本（全部写在 `%TEMP%` 复本里，未碰任何工程副本）：

```powershell
# 修复前的完整副本（bin/archigate.mjs 用 pristine 原文）
cd …\archigate-old
node bin/archigate.mjs deliver --spec …\spec-archigate.json --out-dir …\out-old-nogeo --project dsh-archigate --root-dir …\ws --repo-root …\dsh-archigate
# 修复后的生效副本
cd "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-archigate"
node bin/archigate.mjs deliver --spec …\spec-archigate.json --out-dir …\out-nogeo --project dsh-archigate --root-dir …\ws --repo-root .
```

| | 修复前 | 修复后 |
| --- | --- | --- |
| 结果 | HTML 已产出，摘要阶段 `TypeError: g.rounds is not iterable`，**退出码 1** | `[archigate] 交付完成。`，摘要 8 行齐全，**退出码 0** |

原始日志：`archigate-fix-verify\run-修复前-CLI-无auto-geometry.log`、`run-修复后-CLI-无auto-geometry.log`。

---

## 二、缺陷 (b)：`geometry_target_px > 8` 一律误判「无解」

### 现象

`diagram_deliver { auto_geometry: true, geometry_target_px: 10 / 11 }` 被拒「无解」。与工具自己文档写的「可调范围 6~12」（`index.js:269`）直接矛盾。

### 根因

`lib/geometry-solver.js:276`（改前）：

```js
if (sourceFontPx < targetProjectedPx) {
  return { ok: false, maxViewBoxW: 0, reason: `源码最小字号 ${sourceFontPx}px 低于目标投影 ${targetProjectedPx}px —— 无论怎么缩放都达不到（缩放只会让它更小）。…` }
}
```

这条早退的前提是 `projected = font × min(1, stageW / W)`（clamp 到 1 ⇒ 投影永远 ≤ 源字号 8px）。但：

1. **同一个函数下一行的公式就是按"未 clamp"写的**：`maxViewBoxW = floor(stageW × font / target)`，解的是 `font × stageW / W ≥ target` —— 只有允许 `scale > 1`（画布比舞台窄 ⇒ 浏览器放大渲染）才成立。**判据与它自己的公式互相矛盾**。
2. 于是任何 `target > 8` 必然在到达公式前就被判死，`workflow` 路径更是把这条直接写成 `blockedBy: 'font-below-target'`（改前 `lib/geometry-solver.js:1148`）——与用户观测到的拒绝文本逐字一致。

### 改动

| 文件:行（改后） | 改动 |
| --- | --- |
| `lib/geometry-solver.js:283-288` | 删掉 `sourceFontPx < targetProjectedPx ⇒ ok:false` 早退；保留参数非正数校验；`maxViewBoxW = floor(stageW × font / target)` 不变。注释重写为「按实际投影字号 = 源字号 × 缩放比，缩放比可 > 1」并写明本口径是**乐观**口径、只用于定宽度预算。 |
| `bin/archigate.mjs:599-609` | 自检里那条把 bug 当规格的断言 `字号低于目标 → 明确判无解`（原 `:596-599`）**改写**为核对收紧后的具体预算：`target 8.5 → 1266`、`target 12 → 897`（比原来只查 `ok === false` 更严，不是放宽）。 |

★ **`projectedTextPx` 里的 `min(1, …)` clamp 一个字没动**。理由（可复核）：archify 侧同一 clamp 出现在 `renderers/shared/***.mjs:16`、`bin/visual-check.mjs:1643`、`scripts/check-render-output.mjs:1113-1119`；而 archify **真正强制**的是 6px 硬地板（`check-render-output.mjs:1125-1126` 的 `hardFloorMet`，`:1149` 的 `issue: worst && hardFloorMet === false ? worst : null`），`requestedTargetMet` **只报不判**。我无法证明放宽 clamp 不会放松那道闸门 ⇒ 按约束**只改比较口径，不动 clamp**。

### 验证

**① 判据层（离线、确定性）**

```powershell
node "%USERPROFILE%\.dsh\dsh_orb\archigate-fix-verify\probe-b-before.mjs"
node "%USERPROFILE%\.dsh\dsh_orb\archigate-fix-verify\probe-b-after.mjs"
node "%USERPROFILE%\.dsh\dsh_orb\archigate-fix-verify\probe-wf-before.mjs"
node "%USERPROFILE%\.dsh\dsh_orb\archigate-fix-verify\probe-wf-after.mjs"
```

修复前：

```
target=7    ok=true  maxViewBoxW=1538
target=8    ok=true  maxViewBoxW=1346
target=8.5  ok=false maxViewBoxW=0  reason=源码最小字号 8px 低于目标投影 8.5px —— 无论怎么缩放都达不到…
target=10   ok=false maxViewBoxW=0  reason=源码最小字号 8px 低于目标投影 10px —— 无论怎么缩放都达不到…
target=11   ok=false maxViewBoxW=0  （同上）
target=12   ok=false maxViewBoxW=0  （同上）
workflow 42 节点 target=10 → infeasible blockedBy=font-below-target :: 源码最小字号 8px 低于目标投影 10px …
```

修复后：

```
target=6    ok=true  maxViewBoxW=1794
target=7    ok=true  maxViewBoxW=1538
target=8    ok=true  maxViewBoxW=1346
target=8.5  ok=true  maxViewBoxW=1266
target=10   ok=true  maxViewBoxW=1076
target=11   ok=true  maxViewBoxW=978
target=12   ok=true  maxViewBoxW=897
architecture 6/12/26 节点：target 7 / 10 / 11 全部 feasible=true
workflow 42 节点 target=10 → infeasible blockedBy=width-budget（画布宽 764 > 预算 676）  ← 换了判据，不再是 font-below-target
```

即：**`>8` 不再被一律判「无解」；architecture 在 10/11 下真的解得出几何**。workflow 因为画布宽被 6 列 + `laneW ≥ 640` 钉死在 764，target 10 时预算 676 确实不够 —— 现在给的是**如实的 width-budget**，不再是一句错误的字号结论。

**② 活体端到端（Edge browser-check 真跑）**

| 跑法 | 结果 |
| --- | --- |
| 不带 `--auto-geometry` | 退出码 0，交付完成（同时验证了缺陷 a） |
| `--auto-geometry --geometry-target-px 7`（对照） | 退出码 0，`几何自调：1 轮，最终 达成；viewBox 774x368`，browser-check `status=pass`，`minimumProjectedNodeTextPx=7.255` |
| `--auto-geometry --geometry-target-px 10` | **仍不过**，退出码 1（见下） |
| `--auto-geometry --geometry-target-px 11` | **仍不过**，退出码 1（同 10，5 轮同样的诊断） |

target 10 的拒绝原文（节选，全文见 `run-修复后-CLI-auto-geometry-target10.log`）：

```
[archigate] 拒绝交付：`auto_geometry` 在约束内**无解**，未产出任何 HTML。
几何：盒子 199×60，列距 48，行距 40，3 列 × 3 行
  OK   [stage-width] 要求 viewBox 宽 ≤ 1076px（= stage 1346 × 8 / 10） / 实际 774px
  FAIL [target-projected-text] 要求 ≥ 10px（本次目标，留边际） / 实际 8.000px
  第 1 轮：目标 10px / 摘显式路由=false / 列修复=0 处 → 几何 774x368（投影 8px）
      validate exit=1 ok=false 诊断计数={"error:composition/label-route-clearance":2,"error:composition/label-gap":3}
        error [composition/label-gap] Label "调 normify refresh/validate/build" has only 48px between "pipeline-layer" and "bridge-layer"; it needs at least 185px …
```

**卡在哪条判据（如实）**：不是字号判据，而是 archify `validate` 的 `composition/label-gap`（×3）与 `composition/label-route-clearance`（×2）——求解器为满足收紧后的宽度预算（1076 < 作者原稿的 ~1380）把 8 个组件压成 3 列 × 3 行、**列距只有 48px**，而这几条长边标签要 146~185px 净空才放得下。5 轮（含摘显式路由重试）全卡在同一组诊断上，所以工具如实报"没调出来"。

对照证据说明这不是"因为 target 大所以字号不行"：target 7 那次**沿用了作者原稿的位置**（`out-geo7\*.candidate.json` 与作者稿的 pos/size 相同，交付 HTML 的 sha256 与不开几何那次完全相同：`578e8775…`），所以一次就过；target 10 的预算容不下原稿宽度，求解器被迫重排 ⇒ 才撞上标签净空。**换句话说：>8 的目标现在能"进到求解"，但在这个规格上被布局/标签净空挡住，仍未交付成功。**

★ **仍未验证的一点**：工具自己的 `projected_px` 报告走的是 clamp 口径，所以 target 10/11 时它照旧打印 `投影 8.000px`（上面那条 `FAIL [target-projected-text] … 实际 8.000px` 就是这么来的），而"真实屏幕上是否真的到 10px"取决于浏览器是否把 SVG 放大渲染 —— **这一条本次没有在真实浏览器里量过，属于未验证**。

---

## 三、未做与原因

1. **未做活体验证**（经本会话已注册的 `diagram_deliver` 工具发起调用）：改的是生效副本，插件模块是 DSH 进程启动时加载的，**需重载才生效**；在旧进程里调工具跑的还是旧代码，验证没有意义。本次全部验证走 CLI / 直接 import 磁盘新代码。
2. **未验证 >8px 目标在真实浏览器里的达成**：需要放宽/去掉 clamp 才能让 archify 的口径承认 >8px；而按约束，**我无法证明放宽 clamp 不会放松 archify 那道 6px 可读性闸门**，所以 clamp 一字未动（见第二部分）。
3. **未改** `evaluateArchCandidate` 里的 `scale = Math.min(1, …)`（`lib/geometry-solver.js` 候选评估处，仅用于报告 `projectedPx` 与挑选候选）——同一个 clamp 口径，同一条理由：不动。
4. **未安装、未重启 DSH、未新增/升级依赖**；未改 `dsh-pipeline`、`dsh_orb` 下的任何工程副本、工作区根配置五件。除本报告与 `archigate-fix-verify\`（报告留档）外，所有验证产物只写在 `%TEMP%\dsh-slkdIT\archigate-verify\` 的复本里。
5. **沙箱限制（如实记录）**：confined 模式下，本插件的 `lib/pipeline.js` 用 `spawnSync` + 管道调 archify，必然 `EPERM`（"programs cannot open named pipes"）——这是环境边界，不是代码缺陷。端到端四跑是经批准放宽沙箱后执行的；只读的判据层探针与 stub harness **不需要**放宽，任何环境都能跑。
6. `index.js:467` 与 `bin/archigate.mjs:178` 两处是同一判据的额外落点（不在用户清单内），已按同一语义收紧并在本报告明示；如认为超出范围，回退这两处不影响 (a) 的主修复。

---

## 四、复现清单（脚本都在 `dsh_orb\archigate-fix-verify\`）

| 用途 | 命令 |
| --- | --- |
| 现状自检（改动前后均 85 项全过） | `cd <plugin>; node bin/archigate.mjs selftest` |
| (a) before/after（真 index.js + stub pipeline） | `node harness-a.mjs pristine\index.js.orig` / `node harness-a.mjs <plugin>\index.js` |
| (b) 判据 before/after | `node probe-b-before.mjs` / `node probe-b-after.mjs` |
| (b) workflow 判据 before/after | `node probe-wf-before.mjs` / `node probe-wf-after.mjs` |
| 端到端原始输出 | `run-修复前-CLI-无auto-geometry.log`、`run-修复后-CLI-无auto-geometry.log`、`run-修复后-CLI-auto-geometry-target7.log`、`…-target10.log`、`…-target11.log` |
| 修复前三份原文（可复核 baseline） | `pristine\index.js.orig`、`pristine\archigate.mjs.orig`、`pristine\geometry-solver.js.orig` |
