# FIXES.md — 真机端到端测试确认的缺陷修复（10 条 + F11 + F12）

**批次**：2026-10-15
**权威源**：`repo/plugin/active/`（本仓库；分支 `fix/e2e-10-defects`，基线 `main` @ `c465dd1`）
**缺陷来源**：真机端到端测试 `T-20261015-bb30bc`（L0 完整链路：开单 → 规则引擎自批 → 派编写/测试/审核三个**真会话** → 审核 OK → 关单）+ 同轮真机操作中暴露的工具面/文案面缺陷；**F11 / F12** 由用户在旧代码上的真机探针 `T-20261015-slotprobe` 追加确认
**全套自测**：`node tests/run-all.mjs` ⇒ **1874/1874 通过，exit=0**（改前基线 **1588/1588，0 红**）
（演进：1588 → 1829（10 条缺陷 + 11 套回归）→ 1858（+F11）→ **1874**（+F12））

> ★ 若你在中途读过 `fix\plugin\tests\*-last-run.txt` 并看到 **5 条不是全绿**（02:09:24 那批快照），
> 逐条交代见 **§七**：那 5 条全部是**中途态**、全部由本次改动引入、**全部已修**，
> 没有任何一条是既有失败（改前 `main` 上这 4 套全绿）。

---

## 〇、结论段（简报点名要的四件事 + 两项）

### 1) 权威源判定 ⇒ `repo/plugin/active/`，已独立复核

按仓库 `README.md` 的口径：`plugin/active/` 是要维护的那一份，`plugin/src/` 是运行期文件的落后副本。
**我没有改 `plugin/src/`**（一个字节都没动）。

我另外做了一次独立复核（不是照抄简报）：把 `repo/plugin/active` 与运行时加载的
`profiles/desktop/node_modules/dsh-pipeline` **逐文件、LF 归一化后**比对：

| 结果 | 条数 | 说明 |
| --- | --- | --- |
| 两边相同 | **107** | 未被我改动的文件 —— 与"逐字节相同（归一换行后）"一致 |
| 只在安装副本 | 26 | 恰好是**我的 24 个新文件** + `FIXES.md` + `tests/seat-liveness-wake-check.mjs`（该文件在 repo 里不存在） |
| 两边都有但不同 | 22 | 恰好是**我的 21 个待改文件** + `tests/last-run.txt`（运行产物） |

⇒ 简报说的"active 与安装副本内容相同"**成立**，且我的改动面与预期**完全吻合**。

> ⚠️ **一处与简报不完全一致的地方（如实登记）**：简报说 `lib/store.js` 两边 sha256 完全相同 ——
> 实测两边都带 UTF-8 BOM 但**提交进 git 的 blob 不带**（HEAD 里只有 4 个 `.ps1` 带 BOM）。
> 也就是："工作区(CRLF+BOM) vs 安装副本(LF+BOM)"归一后相同，但"git blob(LF,无BOM) vs 安装副本"不同。
> 本次一律以 **git 的 blob** 为准（理由见第 4 点）。

### 2) 改前基线 ⇒ 我在仓库里**真跑了一遍**

```
$ cd repo/plugin/active && node tests/run-all.mjs
#  dsh-pipeline 自测汇总：1588/1588 通过      （exit=0，与 README 写的 1588/1588 一致）
```
改后：**1874/1874，exit=0**（+286 = 13 套新增回归：11 套缺陷 + F11 + F12）。
⇒ 改前**零红**，所以我跑出来的任何红都只可能是我引入的 —— 本次确实抓到 3 处（逐条见下文"★ 自查抓到"）。

`tests/` 下的入口形态：**30 套**经 `run-all.mjs` 注册/发现；另 2 套刻意不注册
（`quickfix-20261013-check` 带日期的一次性定点验证 + 无导出运行器；`seat-liveness-wake-check`
已裁定退役、且 repo 里本就没有该文件）。两者的既有处置**一个字没动**。

### 3) active 与安装副本的同步方式

```
备份：<profile>/node_modules/dsh-pipeline  →  <profile>/node_modules/dsh-pipeline.bak-<时间戳>/
同步：repo/plugin/active/  →  <profile>/node_modules/dsh-pipeline/   （LF，逐文件哈希校验）
```
**部署后在该权威副本上重跑全套 ⇒ 1874/1874、exit=0**（不是只在仓库里跑过）。
同步时**显式排除** `wake-ledger.jsonl`（活体运行时状态）与 `tests/*-last-run.txt`（运行产物）。

### 4) 生效是否需要重载 ⇒ **需要**（重启 DSH 或重载插件）

Node 的 ESM 模块在**首次 import 时缓存**；正在跑的 DSH 进程在启动那一刻就把
`index.js` / `lib/**` 读进内存了 ⇒ **磁盘上的新代码对当前进程不生效**。
按边界要求**我没有重启 DSH**，所以：

> ★ 本报告的一切结论都是"**改完 + 离线实测通过**"，**不是**"活体已生效"。
> 让它们生效 = 重启 DSH（或触发插件重载）。**本次没有做这一步。**

### 5) MANIFEST.sha256 ⇒ **已重新生成并逐条校验**

`MANIFEST.sha256`：333 条 → **357 条**（+24 个新文件；自身不计）。

**哈希规则不是我猜的，是实测反推的**。拿旧清单 333 条做四规则对照：

| 规则 | 命中 |
| --- | --- |
| R1 工作区原始字节 | 3 / 333 |
| R2 工作区 LF 归一 | 310 / 333 |
| **R3 已提交 blob 的原始字节** | **312 / 333** ← 就是它 |
| R4 blob LF 归一 | 310 / 333 |

R3 唯一不命中的 **21 条正是我改动的 21 个文件**（旧清单记的是改前内容）。
两条旁证：① `tests/supervisor-check.mjs` 里带着一个**已提交的孤立 CRLF**，R2/R4 会把它归掉从而对不上，
只有 R3 对得上；② 工作区是 CRLF（`core.autocrlf=true`）⇒ 拿工作区字节哈希几乎全错。

重新生成后的**逐条校验**（`_recon/verify-manifest.mjs`）：

```
A 未改动文件哈希不变 : 312 条
B 改动文件哈希变了   :  21 条
C 新增条目           :  24 条
D 顺序一致           : true
不该变却变了（应为空）: 0
该变却没变（应为空）  : 0
```

### 6) 换行符处理 ⇒ **改动的 45 个文件一律写成 CRLF；`.gitattributes` 我判断为"值得加，但本次不加"**

**实测到的事实**：
- 仓库 `core.autocrlf=true`，**没有 `.gitattributes`**；检出是 CRLF，安装副本是 LF。
- 我第一版直接把 LF 文件拷进工作区 ⇒ `git status` 把 **153 个文件**都标成 modified，
  但 `git diff --numstat` 对未改动文件是**空的** —— 这就是简报警告的"整文件差异"的成因。
- 处理方式：**只写显式清单里的 45 个文件**，并统一转成 **CRLF**（与其余检出保持一致）。
  结果：`git status` 恰好 **45 条**（21 M + 24 ??），`git diff --stat` = **21 files changed, 430 insertions(+), 166 deletions(-)**
  —— 每个文件的增删行数都是个位到几十行，**没有一处整文件重排**。
- 另外剥掉了 **UTF-8 BOM**：本仓库 HEAD 里只有 4 个 `.ps1` 带 BOM，**没有任何 `.js/.mjs` 带**；
  而安装副本里 `lib/store.js`、`lib/tools/plan.js` 是带 BOM 的（部署时加上的）。
  不剥的话 diff 里会凭空多出"BOM 被加上"这种与 10 条缺陷无关的字节改动。

**关于 `.gitattributes`（我的判断）**：**值得加，但我不在本次加**。理由是它虽然能一举消除
"仓库 CRLF vs 安装 LF"这类摩擦，但加了之后本机现有工作区会整体处于"待重新检出"的状态
（等价于一次全仓库 333 个文件的工作区重写），而工作区重写本身会产生整片的假 modified，
必须再配一次 `git checkout -- .` 才收敛。那是一次**与这 10 条缺陷无关的全仓动作**，
不应该混在这批修复里默默做掉。**建议**单独一个提交做：
```
printf '* text=auto eol=lf\n' > .gitattributes
git add .gitattributes && git commit -m "统一换行符：加 .gitattributes（eol=lf）"
git rm --cached -r . >/dev/null && git reset --hard     # 让工作区收敛到 LF（会重写工作区）
```
顺带一提：加了它之后 `sha256sum -c MANIFEST.sha256`（在 LF 工作区上）才**真的能跑通** ——
当前这个 CRLF 工作区里，`sha256sum -c` 对**所有**文本文件都会失败（因为清单是 blob/LF 口径）。
这是本仓库一个**既有的、与本次修复无关**的坑，我把它写在这里而不是顺手改掉。

### 7) 本地提交列表（分支与 commit）

分支：**`fix/e2e-10-defects`**（基线 `main` @ `c465dd1`）。**只提交到本地分支，没有 push。**

| # | commit | 文件 | 标题 |
| --- | --- | --- | --- |
| 1 | `4649752` | 4 | 修复缺陷③：write 工具的目标判定（正文被当成路径 ⇒ 假路径误拒） |
| 2 | `54a77fa` | 3 | 修复缺陷④：测试位允许面补上可执行扩展名（.mjs/.cjs/.js） |
| 3 | `a0f8a72` | 4 | 修复缺陷⑧/⑦b：shell 守门（引号里的英文单词不再当命令 + 拒绝理由按角色归因） |
| 4 | `d1110f9` | 6 | 修复缺陷②：roster.slots 是声明表，不是「席位实际拿到了什么」 |
| 5 | `1cc18ff` | 7 | 修复缺陷⑦：新增受控收尾清理 pipeline_task_purge |
| 6 | `a9e6014` | 7 | 修复缺陷⑤：L0 自批也记一次改动基线 |
| 7 | `b1227b9` | 5 | 修复缺陷⑩：非有限入参的需求侧提示（不改行为） |
| 8 | `a53444a` | 4 | 修复缺陷⑥：巡检播报按判据本身写（不再一律自称「长时间无进展」） |
| 9 | `1cb19aa` | 3 | 修复缺陷⑨：不改状态的迁移必须交代「记了什么」 |
| 10 | `8531496` | 10 | 修复缺陷①：授权面锚点 —— `.` 解析为整棵项目根 |
| 11 | `e6a19a4` | 1 | 注册 11 套缺陷回归到全套 |
| 12 | 分支末两条 | 1 | 新增本报告（`FIXES.md`） |
| 13 | 分支末两条 | 1 | 重新生成 `MANIFEST.sha256`（357 条） |

> 第 12/13 条是"本报告 + 清单重生成"，**故意不在本文件里写死它们自己的哈希**
> （写了就会自指：文件内容一变、清单就得再重生成一次）。取法：
> `git log --oneline main..HEAD` 的最后两条。

### 8) 对远端仓库：**本次修复未对远端仓库做任何写操作**

**未 push、未改动 remote、未用 gh、未 fetch/pull、未删改远端任何东西。**
所有改动只落在本地：`repo\` 的本地分支与提交，以及 `fix\` 工作区。
要不要推到云端**由你决定**；在你明确说"推"之前，任何对远端的写操作都算越界。

可复核的证据（在 `repo\` 下逐条可跑）：

| 证据 | 命令 | 实测结果 |
| --- | --- | --- |
| remote 只有 recon 时那一条，URL 未变 | `git remote -v` | `origin  https://github.com/tangdancol-jpg/dsh-pipeline`（fetch/push 同一个 URL，无 pushurl、无第二个 remote） |
| `.git/config` 的 remote 段未被动过 | `type .git\config` | `[remote "origin"]` 只有 `url` 与 `fetch` 两行；本次唯一写入 `.git/config` 的是 `[user]`（仓库本地提交身份，与远端无关） |
| **从未 fetch 过** | `Test-Path .git\FETCH_HEAD` | **文件不存在**（存在即代表曾 fetch） |
| 远端跟踪引用没有移动 | `git for-each-ref refs/remotes` | `origin/main` = `c465dd1`、`origin/HEAD` = `c465dd1`、`origin/refactor/…` = `a3ff124`，提交时间分别是 **2026-10-15 01:39:26 / 2026-10-14 23:33:48** —— 全部**早于本次会话**；`.git/refs/remotes/` 下文件 mtime 也停在仓库克隆时刻 `2026/10/15 1:56:40` |
| 远端引用 reflog 为空 | `git reflog show origin/main` | **无任何条目** ⇒ 该引用自克隆以来一次都没被写过 |
| 本地只有两条分支 | `git branch -vv` | `main`（跟踪 `origin/main`，停在 `c465dd1`，未动）与 `fix/e2e-10-defects`（本地） |
| 未用 gh | `Get-Command gh` | **gh 未安装** ⇒ 结构上不可能用它做任何写操作 |

> ⚠️ 一处**需要你知情但不算远端写操作**的本地动作：为了让提交能成功，我设了**仓库本地**身份
> （`git config --local user.name/user.email`，见第 7 点）。它只写进 `repo\.git\config`，
> **不碰远端**，也不改全局配置。不要时删掉即可：`git config --local --unset user.name && git config --local --unset user.email`。

**提交顺序与缺陷编号不一致，原因如实说明**：③④ 排在最前是**技术依赖**——
③ 引入 `lib/guard/targets.js` 并改写 `collectPaths`，而 ① 对 `decide.js` 的改动落在**同一批行**上
（`目标：${p}` → `${targetLine(t)}`）；先 ③ 后 ① 才能保证每个中间提交都是**可加载**的。
⑧ 排在 ② 前面是因为 `shell.js` 的写动词判据与归因文案同属一个改动面。
每个提交都做过 `node --check` 全量自检（改动到的每个 `.js/.mjs`）。

**⚠️ 一处需要你知情的配置改动**：本仓库**原本没有配置 git 身份**（local/global 都是空），
提交时会 `Author identity unknown` 直接失败。为了能提交，我设了**仓库本地**身份（不是全局）：

```
git config --local user.name  "dsh-pipeline fix agent"
git config --local user.email "fix-agent@localhost"
```

所以这 12 个提交的 author 是上面这个**明确的代理身份**，不是你的身份
（HEAD `c465dd1` 的 author 是 `tangdancol-jpg <340973861+tangdancol-jpg@users.noreply.github.com>`）。
要把它们改成你自己的身份：
```
git rebase --exec 'git commit --amend --no-edit --reset-author' main
```

---

## 一、逐条修复

> 下面所有"根因(文件:行)"的行号都是 **`main` @ `c465dd1`（改前）** 的行号，可核。

### 缺陷 ①【严重·机制】分区解析把 `.` 解到了插件包根

| 项 | 内容 |
| --- | --- |
| **缺陷** | L0 自批产出的编写分区写 `scope_paths: ['.']`，项目根下**任何**路径都判越界 ⇒ 编写席**写不进项目源码树**，交付物只能落在 `.pipeline/<任务>/artifacts/v1/` |
| **复现** | L0 单派编写席 → 写 `<项目根>/src/x.mjs` ⇒ 拒（"写入位置不在任何编写席位的分区里"）。判据两处：guard 分区解析 + `store:checkManifestAgainstScope` |
| **根因(文件:行)** | `lib/util.js:94` `resolveAgainstAnchor()` 的 `.` 分支返回**锚点**；`lib/guard/seats.js:49` `normScopePath()` 直接吃它；`lib/store/base.js:98` `scopeAbsKey()` 同样（这就是 `checkManifestAgainstScope` 那条判据的坐标）。而渲染侧 `lib/guard/seats.js:82/88`、`lib/context.js:82`、`lib/tools/intake.js:502`、`lib/tools/dispatch.js:368` **一律把它读作「整棵项目根」** |
| **改法** | 新增 `lib/scope/root-marker.js`：**根标记 `.` 单独认，解析成本任务的 `project_root`**；其它裸相对路径的基准**一个字没动**（仍是锚点 —— 那有真单 T-20261011-214043 的实测撑着）。守门 / 授权面 / 改动面审计 / 四处渲染**全部收敛到这一个解析器** |
| **新增** | `lib/scope/root-marker.js` |
| **改动** | `lib/guard/seats.js`、`lib/guard/decide.js`、`lib/guard/shell.js`、`lib/guard-factory.js`、`lib/store/base.js`、`lib/context.js`、`lib/tools/intake.js`、`lib/tools/dispatch.js` |
| **验证** | `node tests/f1-scope-root-marker-check.mjs` ⇒ **18/18，exit=0** |
| **为什么不是放宽** | `.` 在**所有**渲染里都读作「整棵项目根」，那它就必须真的是；且守门本来就用 `isInside(task.projectRoot, p)` 当前置闸 ⇒ `.` = 项目根与既有闸门**同一边界** |
| **兼容** | 不给 `projectRoot` 的老调用退回改前行为 ⇒ `tests/scope-check.mjs` 的三参数调用逐字不变（实测在案） |
| **未解决/存疑** | 无 |

### 缺陷 ②【严重·机制】`roster.slots.permission` 是惰性 / 误导字段

| 项 | 内容 |
| --- | --- |
| **缺陷** | writer/tester/reviewer 三槽回读全是 `read-only(origin: default)`，可三席**全都写成功了**；主对话显式传 `workspace-write` 时插件回读称"一致" |
| **复现** | L0 单派活时传 `permission: "workspace-write"` ⇒ 会话确实拿到工作区档，而 `task.roster.slots[*].permission` 仍是 `read-only` |
| **根因(文件:行)** | `lib/tools/dispatch.js:66` `dispatchSlots()` 的优先级是「请求 > 名单 `declared` > 通道兜底」，而 `task.roster.slots` 是**声明表**；改前**没有任何地方**记下"实际生效值"。`lib/tiers.js` 的注释自承 `compareDispatchSlots`（B2 判据）**没有任何调用点** |
| **改法** | ① **接线**：`origin==='declared'` 的槽**冻结**，请求与它不符 ⇒ **拒绝派活**（正是 B2 判据）；② **如实登记**：每次派活把 `effective` / `provenance` / `divergences` 追加到 `task.dispatch_slots[]`（只追加、上限 24、**永不改写名单**）；③ 派活摘要 + `pipeline_status` 的 `slots` 速查都写明"名单是声明表、实际值看 `dispatch_slots`" |
| **新增** | `lib/roster/slot-truth.js`、`lib/store/dispatch-slots.js` |
| **改动** | `lib/tools/dispatch.js`、`lib/store.js`、`lib/tools/status.js` |
| **验证** | `node tests/f2-slot-truth-check.mjs` ⇒ **22/22，exit=0** |
| **取舍** | **没有**把 `declared` 也放开（那会让"声明什么档"彻底失效）；**也没有**让占位值否决请求（L0 名单里全是占位值 ⇒ 那样会把 L0 全挡死） |
| **未解决/存疑** | `transport.applyPermissionSlot` 的读回逻辑**未改**（只在真实会话通道下跑得到）；本次只把"实际生效值"记到盘上。活体上要在重启后才能观测 |

### 缺陷 ③【严重·工具面】write 工具的目标判定缺陷且间歇

| 项 | 内容 |
| --- | --- |
| **缺陷** | 拒绝文案里的"目标"是「工作区目录 + 正文首行」拼出的**假路径**，与传入 `file_path` 无关；同一目录同后缀，`reviewer-report.log` 被拒、`reviewer-verify.log` 两次一次通过；文案自称"按路径判" |
| **复现** | 审核席位写自己的报告，`content` 多行且含斜杠 ⇒ 拒；`content` 不含斜杠 ⇒ 过（间歇性的**全部**来源） |
| **根因(文件:行)** | `lib/guard/rules.js:153` `collectPaths()` 把参数对象里**所有字符串叶子**都当候选路径（正文也在内），而 `lib/guard/rules.js:186` `resolvePath()` 的"像不像路径"只判**含不含斜杠** ⇒ 整段多行正文被 `resolveJoin(cwd, 正文)` 拼成横跨换行的怪路径；它落在项目根里 ⇒ 命中越界判据 ⇒ **误拒** |
| **改法** | 提取逻辑收敛到 `lib/guard/targets.js`：**显式路径键优先**（取首行）；**补充扫描**只收**单行**、长度合理、且**不在正文类键名**（`content`/`new_string`/`patch`…）下的字符串。判定结果带**来源**，文案改成 `目标：<真实路径>（来自参数 file_path）` |
| **新增** | `lib/guard/targets.js` |
| **改动** | `lib/guard/rules.js`、`lib/guard/decide.js`（`collectPaths` 的名字与签名**一个字没变**） |
| **验证** | `node tests/f3-path-targets-check.mjs` ⇒ **20/20，exit=0**（含"正文里藏着的项目源码路径**不构成越界**"与"越界写入照旧拒"两条反例） |
| **为什么不是放宽** | 假路径**从来不是**真目标（真目标一直在显式键里，两条都会收集）；它唯一的作用就是制造误拒 |
| **未解决/存疑** | 无 |

### 缺陷 ④【工具面】`.mjs` 等可执行扩展名不在测试位允许面内

| 项 | 内容 |
| --- | --- |
| **缺陷** | 测试席位写可运行用例 `tester-cases.mjs` 被拒，只能退回"把用例塞进 stdin 管道" |
| **复现** | 测试席位写 `reports/tester/tester-cases.mjs` ⇒ 拒 |
| **根因(文件:行)** | `lib/guard/rules.js:64` `OWN_DIR_EXTS = ['log','jsonl','md','json','txt']`（无任何可执行扩展名）+ 同文件 `checkOwnPath` 的名字正则按它判 |
| **改法** | 简报口径是"要么扩充允许面，**要么**在拒绝文案里给可行替代"—— **两条都做**：① 允许面补 `mjs`/`cjs`/`js`；② 拒绝文案直接写出"换哪个扩展名 / 不想落文件就走 stdin 管道" |
| **新增** | `lib/guard/page-exts.js`（允许面与文案的唯一出处） |
| **改动** | `lib/guard/rules.js` |
| **验证** | `node tests/f4-tester-exts-check.mjs` ⇒ **16/16，exit=0** |
| **为什么安全** | `own-dir` 落点唯一：`<项目根>/.pipeline/<任务id>/reports/<角色>/<角色>[-后缀].<ext>` —— 报告目录，不是源码树；"测试不得改项目源码"那条判据**一个字没动**（反例在测）。审核的 `own-log` 档**没有**跟着放宽 |
| **未解决/存疑** | 无 |

### 缺陷 ⑤【机制】L0 档没有改动基线

| 项 | 内容 |
| --- | --- |
| **缺陷** | 审核要按 R6 出 `change_audit`，`pipeline_change_audit` 直接报"没有基线" ⇒ 只能手工清点，或拒绝编造 |
| **复现** | L0 单跑到审核 ⇒ `pipeline_change_audit` 返回 `NO_BASELINE` |
| **根因(文件:行)** | 基线**只在计划那一站**记（`lib/tools/plan.js:289` 是**唯一**的 `takeBaseline` 调用点），而 L0 没有计划站（规则引擎自批，`change_scope` 置 null） |
| **改法** | ① 新增 `lib/store/l0-baseline.js`：L0 自批写完角色清单那一刻补一次基线（**时机的口径与计划路径逐字相同**："清单定稿、即将派活"），**幂等、不覆盖已有、记不上不拦流程**；② **连带的两处判据更正**（见下表） |
| **新增** | `lib/store/l0-baseline.js` |
| **改动** | `lib/tools/intake.js`、`lib/store/baseline.js`、`lib/store/submit.js` |
| **验证** | `node tests/f5-l0-baseline-check.mjs` ⇒ **23/23，exit=0**（含"**不补基线**的对照单仍报没有基线"——证明这条红是被这条修复消掉的） |

**★ L0 一有基线，所有"看有没有基线"的判据都会跟着武装起来。逐条处置（只留该生效的那一条）：**

| 判据 | 位置(改前) | 处置 | 理由 |
| --- | --- | --- | --- |
| 审核必须交 `change_audit` | `lib/store/submit.js:124` | ✅ **对 L0 生效**（这正是缺陷 ⑤ 的目的） | 用户口径："审核 ai 确认没有干不该干的事（**前后版本对比**）" |
| 哈希前置闸门（`dev_to_test`） | `lib/store/submit.js:336` | ⛔ **仍然弃权** —— 判据由「有没有**基线**」改为「有没有**授权面**」 | 它判的是「改动面 vs **授权面**」，而 L0 **刻意没有**授权面。按"有基线就执法"会让**每张 L0 单**都因"没申报"被打回 —— 那是**改了另一件事**（P4 是用户待拍板项） |
| `changeAudit` 的结论 | `lib/store/baseline.js` | ✅ 新增**第三个结论 `no_scope`** | 改前判据是 `inScope(rel)===null ⇒ unauthorized`，授权面为空时**每条改动都命中** ⇒ L0 上任何写入都成"多改"。"没有授权面" ≠ "违反了授权面"：`no_scope` 时 `unauthorized`/`missing` 都为空、**前后差异照给**；有授权面的任务照旧走原来两档（对照断言在测） |

| **未解决/存疑** | L0 的 `change_audit` 现在是**必填** ⇒ 现有 L0 夹具都补了 `auditFor(...)`（见 §二）。活体上第一次跑到审核时会看到这条新要求 —— 这是**有意的行为变更** |

### 缺陷 ⑥【机制】巡检 patrol 播报时机与自身口径不符

| 项 | 内容 |
| --- | --- |
| **缺陷** | 默认"无进展 20 分钟"才播、间隔 5 分钟；实测在状态变化后 **1 分 49 秒**就播（且 52 秒前刚有 `security:scan` 流水）。怀疑时钟没被交接物/状态推进/流水刷新，或用 A23 幂等键会把真正到点的播报当重复吃掉 |
| **复现** | `tests/f6b-patrol-clock-check.mjs` 的 B 段：喂进真机那串时刻，复算 `stalled` |
| **根因(文件:行)** | **分两半，都查清了**：<br>**(甲) 时钟没错。** `lib/patrol.js:379` `lastProgressAtMs()` 的输入面含 `history[最后一条].at`，而流水（`security:scan`）经 `lib/tools/security.js:143` 的 `store.recordAudit()` ⇒ 进 `task.history` ⇒ **会**推进时钟。真机复算：算上流水 **52 秒**、不算流水也才 **109 秒** —— 两种算法都远小于 20 分钟 ⇒ 那条播报**不可能**是 `task-stall`<br>**(乙) 错的是标签。** `index.js:693` 把播报的 `what` **写死**成「巡检发现长时间无进展」，而 `patrolFindings()` 会出**五种**判据 ⇒ 真机那条 `unresolved-wake`（"该叫没叫"）被报成了"无进展"，把主对话引去查失联 |
| **改法** | 新增 `lib/patrol/notice-text.js`：判据**自带**它自己那句话（按 `finding.kind` 取标签），认不出的类别**如实照抄 `kind`**（不冒名）；`index.js` 只做"把 finding 交给它"，不存第二份文案；正文另加一行**判据类别** |
| **新增** | `lib/patrol/notice-text.js` |
| **改动** | `index.js` |
| **验证** | `node tests/f6b-patrol-clock-check.mjs` ⇒ **26/26，exit=0**（时钟判据）<br>`node tests/f6-patrol-notice-check.mjs` ⇒ **15/15，exit=0**（文案判据） |
| **可复现判据** | ① 输入面逐条实测：状态推进 / **流水** / 派活 / 制品 **会**推进；交接物 / 记录 / 上下文水位 / 人工请求 / 澄清 由纯函数覆盖 —— **一条不漏**；② **现场时刻复算**：`stalled=52000ms`（算流水）与 `109000ms`（不算流水），双双 `< 1200000ms` ⇒ 判据**不产生** `task-stall`；③ A23 幂等键：同一段无进展 ⇒ 同一个 id，有新进展后再卡住 ⇒ **新 id**（不会被吃掉、也不会永久哑掉）；④ 阈值可配置（调 30 秒该报就报） |
| **有意排除（不是漏路）** | `task.updated_at` **不算进展** —— 机制自己每次落盘都刷新它，算进去等于**巡检自喂自**（A22/A23 当场失效）。判据里明写并在测 |
| **未解决/存疑** | 部署配置**没有**覆盖阈值（`profiles/desktop/cordis.patch.yml` 未设 `patrolStallMs`，取默认 20 分钟）—— 这条**已核实**，所以"阈值被改短"这支被排除 |

### 缺陷 ⑦【工具面】没有任何"删除任务"工具（+ ⑦b 归因串角色）

| 项 | 内容 |
| --- | --- |
| **缺陷** | 唯一出口是 `cancel`（只改状态、文件全留）；外部删除又被守门挡住，实测 `Remove-Item` 被拒，**且拒绝理由错引了"测试/审核不得替编写改代码"这段 tester/reviewer 文案** |
| **复现** | 主对话跑 `Remove-Item -Recurse -Force <项目根>/.pipeline/<任务id>` ⇒ 拒，理由段说的是测试/审核的边界 |
| **根因(文件:行)** | ① 工具面：插件工具清单里没有任何收尾清理入口；② 归因：`lib/guard/shell.js:276` 把理由段**写死**成一句话，而 `lib/guard/shell.js:265` 的适用条件是 `role !== 'writer' && role !== 'human'` —— **它包含 main**（小节注释 `:261` 也还写着"测试/审核/咨询角色"，同样过时） |
| **改法** | ① 受控入口 `pipeline_task_purge`（与关单同档：**只有主对话**）：**只认终态单** / **先留痕后动手**（墓碑落 `.pipeline/_purge-log.jsonl`，在被删目录**之外**）/ **默认进回收站**（`.pipeline/_trash/<任务id>-<时刻>/`，可恢复），永久删要 `mode:"delete"` **且** `confirm:true` / **删不动如实报错**；② 理由段收敛到 `lib/guard/attribution.js`，**按角色**给（main 不再被告知测试/审核的边界），并给出**正路**（写代码派编写席位；清旧单用 `pipeline_task_purge`） |
| **新增** | `lib/store/purge.js`、`lib/tools/purge.js`、`lib/guard/attribution.js` |
| **改动** | `lib/tools.js`（注册）、`lib/guard/rules.js`（`pipeline_task_purge: ['main']`）、`lib/store.js`（装配）、`lib/guard/shell.js`（理由段） |
| **验证** | `node tests/f7-task-purge-check.mjs` ⇒ **32/32，exit=0**；归因部分见 `tests/f8b-shell-attribution-check.mjs` ⇒ **32/32，exit=0** |
| **★ 自查抓到的真 bug** | 第一版在 `rename` **之后**调 `store.audit()` —— 那个入口会往 `<任务目录>/audit.jsonl` 追加，**把刚移走的目录又建出来**（清理完冒出空壳目录）；测试当场抓住，改成"往**归档副本**里补一行；`delete` 时那一行就是墓碑" |
| **副作用** | 工具总数 31 → 32 ⇒ `tests/load-smoke.mjs` 的 `EXPECTED_TOOL_COUNT` 跟着 +1（**方向没放宽**：仍然精确相等） |
| **未解决/存疑** | `trash` 用 `renameSync`（同盘必然成功）。**跨盘符 / 目录被占**时如实报错、**不删一半**，但**没有**做"跨盘回退成 copy+rm"（那会引入"复制了一半"的新失败面） |

### 缺陷 ⑧【判据/文案不一致】`Get-Content` 读配置被判成"修改项目文件"

| 项 | 内容 |
| --- | --- |
| **缺陷** | 主对话跑一条**纯读**的多行命令（`Get-Content` 读 `cordis.yml` + `.pipeline-update-last-stamp.txt`）被判成"修改项目文件"；同一文件用 `Select-String` 搜符号却放行；理由同样错引 tester/reviewer 文案 |
| **复现** | 见下（**二分定位**，不是猜的） |
| **根因(文件:行)** | **二分到具体一行**：命令里有一行**回显用的横幅** `"== 两份插件里有 patch 配置的痕迹吗 =="`，而 `lib/guard/shell.js:26` 的 `SHELL_WRITE_RE` 里有 `patch` 这个词、`lib/guard/shell.js:267` 是 `SHELL_WRITE_RE.test(text)` —— **在整段原文上就地匹配** ⇒ 引号里、只是要打印出来的那个英文单词被当成 `patch` 命令；同一段脚本里又出现了项目根路径 ⇒ 两个条件一起成立 ⇒ **纯读命令被判定成写** |
| **★ 关于"搜索 vs 读全文是不是有意区分"** | **不是**。用户看到的那个不对称就是**这一条误判**造成的：`Select-String` 那条命令里**恰好没有** `patch` 这个词。真正有意设计的区分在 `lib/guard/shell.js:284-315`：控制角色**读代码文件**一律拦；非 main 角色的**检索命令**还得把范围限定在 `.pipeline/` 下。本次把这条区分**写进文档**了（见"文档对齐"） |
| **改法** | ① 写动词的匹配对象从"整段原文"改成"**去掉引号内容之后的文本**"（新模块 `lib/guard/shell-text.js` 的 `hasWriteVerbOutsideQuotes()`）；② 理由段按角色归因（同 ⑦b） |
| **新增** | `lib/guard/shell-text.js`、`lib/guard/attribution.js` |
| **改动** | `lib/guard/shell.js`、`lib/guard/rules.js`（文案对齐） |
| **验证** | `node tests/f8b-shell-attribution-check.mjs` ⇒ **32/32，exit=0**；回归对照 `node tests/shell-guard-check.mjs` ⇒ **28/28，exit=0** |
| **★★ 为什么不是放宽（两条硬论证）** | ① **内联解释器那一支一个字没动**：`pwsh -Command "Set-Content x"` / `node -e "writeFileSync(…)"` 这类"把写操作藏进引号交给解释器执行"的写法走的是 `INLINE_WRITE_API_RE`（对**原文**匹配，名单里就有 `Set-Content|Out-File|Remove-Item|…`）⇒ **照旧拒**（反例在测）；② **重定向那一支也没动**。收掉的只有"引号里恰好有个英文单词"这类**从来没有被执行过**的假动词 |
| **文档对齐** | 在 `lib/guard/shell.js` 的 4a/4b 小节头与 `lib/guard/attribution.js` 的模块头里，把"读 / 写 / 检索"三条**各自拦什么、为什么**写清楚了 |
| **未解决/存疑** | shell 侧仍是**字符串匹配的 best-effort**（插件 README 早就写明，本次没变）。刻意混淆的写法仍可能绕过 —— 如实保留在拒绝文案里，不假装是形式化保证 |

### 缺陷 ⑨【返回值可观测性】`handoff_to_supervisor` 的返回看不出台账已改

| 项 | 内容 |
| --- | --- |
| **缺陷** | 主对话递单给主管，返回是「任务 T-…：**待分配 → 待分配**」—— 看不出台账改了没有，无法据此判断递单成没成 |
| **复现** | `pipeline_transition { task_id, event: "handoff_to_supervisor" }` ⇒ 摘要只有 `A → A` |
| **根因(文件:行)** | `lib/store/lifecycle.js:382` 的 `summary` **只有**「任务 X：from → to。」，而这条事件在状态机里是 `pending → pending`（它**不改状态**，只登记"谁递的"）⇒ 摘要没有任何可观测内容 |
| **改法** | 新增 `lib/store/transition-record.js`：**`from === to` 的迁移必须自己交代"记了什么"** —— 台账名 / 值 / 下一步谁动。只对 `from === to` 生效，**真有状态变化的迁移一个字没改** |
| **新增** | `lib/store/transition-record.js` |
| **改动** | `lib/store/lifecycle.js` |
| **验证** | `node tests/f9-transition-record-check.mjs` ⇒ **21/21，exit=0** |
| **★ 修这条时抓到的第二个真 bug（如实登记）** | 第一版文案里写的台账名是 `task.handoff_to_supervisor` —— 而**那个字段不存在**：`lib/store/precondition.js:329` 返回的 `{ ok:true, handoff_to_supervisor:{…} }` **不会落到任务上**（`lib/store/lifecycle.js:321` 只看 `check.ok`）。真正的写点在 `lib/store/hub.js:362` 的 `applyHubSideEffects()` ⇒ **`task.hub.entry = { by, at, via, note }`**。若不改，这条"修复"就是把"看不出台账"换成"指着一个查不到的台账"——测试当场抓住 |
| **未解决/存疑** | 无 |

### 缺陷 ⑩【需求面·可不改代码】`fizzbuzz(Infinity)` 抛 `RangeError`

| 项 | 内容 |
| --- | --- |
| **缺陷** | 审核位实测出 `fizzbuzz(Infinity)` 抛 `RangeError`，但**没有打回** —— 需求卡从没规定过非有限入参。那是**需求侧**的缺口，不是实现的错 |
| **需求侧裁定（逐字照办）** | 「仅需在文档 / 任务卡模板里提示「非有限入参需在 boundaries 里显式规定」，**不要改任何实现行为**」 |
| **根因(文件:行)** | 不是代码缺陷：`lib/tools/intake.js:288` 与 `lib/tools/plan.js:74` 的 `boundaries` 参数描述里**没有任何**关于非有限入参的提示；`lib/context.js:101-104` 渲染"边界与不做的事"时同样不提 |
| **改法** | 新增 `lib/intake/boundary-hints.js`（**纯提示，认不出就什么都不说**）：需求里有数值入参、而 `boundaries` 没提非有限入参 ⇒ 编排摘要给一行提示，并**印进 `requirement.md`**；`boundaries` 参数描述里也带上这句 |
| **三条硬边界** | ① **不改任何实现行为**（它连实现都碰不到）；② **不替**需求分析往 `boundaries` 里塞条目（那等于伪造它的结论）；③ 判据只做**启发式**，认不出就**什么都不说** |
| **新增** | `lib/intake/boundary-hints.js` |
| **改动** | `lib/tools/intake.js`、`lib/tools/plan.js`、`lib/context.js` |
| **验证** | `node tests/f8-nonfinite-hint-check.mjs` ⇒ **16/16，exit=0**（含"调用前后 `boundaries` 逐字节相同"这条不许越权的判据） |
| **未解决/存疑** | 无（本条按裁定本就不改行为） |

---

## 二、既有测试的改动（5 处，逐条给理由）

**没有一条断言被删、被弱化或改期望值**；下列改动全部是"缺陷 ⑤ 的**行为变更**所必需的夹具适配"或"事实同步"：

| 文件 | 改动 | 理由 | 方向 |
| --- | --- | --- | --- |
| `tests/selftest-core.mjs` | 正例第 8 步 `review_verdict` 补 `...(await auditFor(h, taskId))` | L0 现在有基线 ⇒「有基线就必须交前后对比结论」对 L0 生效。该 helper **本来就存在**，返回的是**真去问一次工具**的结论（不是手编） | **变严** |
| `tests/selftest-core.mjs` | 反例⑧的 `review_verdict` 同样补 `auditFor` | 先把该交的证据交齐，这条反例才测得到它要测的那件事（版本不一致），而不是被"缺证据"先盖住 | **变严** |
| `tests/selftest-core.mjs` | "审核发 NG" 夹具的 `review_verdict` 补 `auditFor` | 同上（NG 同样要交前后对比结论） | **变严** |
| `tests/load-smoke.mjs` | `EXPECTED_TOOL_COUNT` 31 → **32** | 缺陷 ⑦ 的修法就是**多一个具名工具**（与 `pipeline_supervise` 那次同形）。**方向没放宽**：仍然精确相等 | 中性（事实同步） |
| `tests/hashgate-check.mjs` | L0 弃权那条断言的判据由「**没有基线**」改为「**没有授权面**」 | 缺陷 ⑤ 之后 L0 **有了**基线，原判据不再等于"有没有授权面"。新判据与 `submit.js` **同源**，并把新事实一起钉住（`currentBaseline !== null`） | **变严** |

**我自己的实跑抓到并修掉的 3 处**（都是本次引入的，逐条在 §一 的"★ 自查抓到"里）：
① 缺陷 ⑦ 的 `audit()` 复活被删目录；② 缺陷 ⑨ 指向不存在的台账字段；③ 缺陷 ⑤ 会让 L0 每张单都判 `out_of_scope`（已加 `no_scope`）。

---

## 三、结构要求（"分文件、能细分就拆开、禁止堆叠大文件"）

**24 个新文件**，每个一个关注点；**没有任何一处往既有大文件里堆逻辑**（只在必要处各改了几行接线）。

| 新文件 | 行数 | 关注点 |
| --- | --- | --- |
| `lib/scope/root-marker.js` | 84 | `.` 这个根标记解析成谁（①） |
| `lib/roster/slot-truth.js` | 175 | 四槽"声明值 vs 实际生效值"（②） |
| `lib/store/dispatch-slots.js` | 110 | 四槽实际值落盘（②） |
| `lib/guard/targets.js` | 205 | 目标路径提取 + 来源（③） |
| `lib/guard/page-exts.js` | 76 | `own-dir`/`own-log` 允许面与替代路径文案（④） |
| `lib/store/l0-baseline.js` | 100 | L0 补基线（⑤） |
| `lib/patrol/notice-text.js` | 96 | 巡检播报按判据写（⑥） |
| `lib/store/purge.js` | 190 | 收尾清理（⑦） |
| `lib/tools/purge.js` | 145 | `pipeline_task_purge` 工具定义（⑦） |
| `lib/guard/shell-text.js` | 88 | 写动词只在**命令位置**匹配（⑧） |
| `lib/guard/attribution.js` | 92 | 拒绝理由**按角色归因**（⑦b/⑧） |
| `lib/store/transition-record.js` | 76 | 不改状态的迁移交代"记了什么"（⑨） |
| `lib/intake/boundary-hints.js` | 88 | 非有限入参提示（⑩） |
| `tests/f1…f9-*.mjs` | 11 个文件 | **一条修复一个独立小套** |

**没有把逻辑搬进这些巨物**（各只改了几行接线）：`lib/tiers.js`、`lib/boundaries.js`、
`lib/transport/index.js`、`lib/liveness.js`、`lib/states.js`、`lib/hashgate.js`、
`lib/store/precondition.js`、`lib/store/submit.js`、`lib/patrol.js`、`lib/intercept.js`、
`lib/tools/dispatch.js`、`lib/tools/flow.js`。按职责切、不为拆而拆；只拆真正碰到的部分。

---

## 四、验证命令与结果（全部实跑，原始输出已落盘）

```
$ cd repo/plugin/active && node tests/run-all.mjs
##############################################################################
#  dsh-pipeline 自测汇总：1829/1829 通过
#  跑法：node tests/run-all.mjs   （node 版本 v24.19.0，平台 win32）
##############################################################################
$ echo $?
0
```

改前基线 **1588/1588（0 红）** ⇒ 改后 **1829/1829**。每一套的独立跑法与结果：

| 套 | 覆盖 | 结果 |
| --- | --- | --- |
| `f1-scope-root-marker-check` | ① | **18/18** |
| `f2-slot-truth-check` | ② | **22/22** |
| `f3-path-targets-check` | ③ | **20/20** |
| `f4-tester-exts-check` | ④ | **16/16** |
| `f5-l0-baseline-check` | ⑤ | **23/23** |
| `f6-patrol-notice-check` | ⑥（文案） | **15/15** |
| `f6b-patrol-clock-check` | ⑥（时钟判据） | **26/26** |
| `f7-task-purge-check` | ⑦ | **32/32** |
| `f8-nonfinite-hint-check` | ⑩ | **16/16** |
| `f8b-shell-attribution-check` | ⑦b/⑧ | **32/32** |
| `f9-transition-record-check` | ⑨ | **21/21** |

原始输出：`plugin/active/tests/last-run.txt` + 每套的 `plugin/active/tests/<suite>-last-run.txt`。
**回归对照（既有套，逐条实跑）**：`shell-guard-check` 28/28、`review-check` 51/51、
`hashgate-check` 79/79、`writers-check` 44/44、`selftest` 70/70、`load-smoke` 24/24。

---

## 五、边界遵守（逐条对照）

| 约束 | 实际 |
| --- | --- |
| 不要重启 DSH | ✅ 全程没重启（⇒ 本报告一切结论都是**离线实测**，不是活体生效） |
| 不要改 `profiles\desktop` 下的全局配置 | ✅ `cordis.yml` / `cordis.patch.yml` **一个字节都没动**。可核：`cordis.patch.yml` 的 sha256 与它自己的 `bak-20261015-011911` **完全相同**（`EE94B57F1F465DD9…`）。**因此没有需要回滚的配置**（`rollback.ps1` 未使用） |
| 不要动 `.pipeline` 任务数据 | ✅ 全部测试用 `mkdtempSync` 自造临时项目根；`<profile>/.pipeline` 只读 |
| 不要 push | ✅ 只提交到本地分支 `fix/e2e-10-defects`，**没有 push**（`git status` 显示 `main` 与 `origin/main` 均未推进） |
| 不要动 `dashboard/` | ✅ 未触碰 |
| 不要改 `plugin/src/` | ✅ 未触碰（改动全部在 `plugin/active/`） |
| 改前先备份（复制而非覆盖） | ✅ ① 仓库侧：全部改动以 `git` 提交留存，任何一步可 `git checkout` 回退；② 安装副本侧：同步前整目录备份 |

---

## 六、遗留与存疑（如实登记）**已实测（可复核）**：仓库内全套 1829/1829、exit=0；11 套新回归逐条实跑；缺陷 ⑧ 的根因用**二分**定位到具体一行并可复现；缺陷 ⑥ 的时钟用**两种算法**复算并给出可复现判据；缺陷 ⑤ 的三条连带判据**逐条对照实测**；缺陷 ⑦ 的墓碑账本在**永久删之后仍可读**；MANIFEST 的哈希规则用**四规则对照**反推并逐条校验（312/21/24/0/0）。

**未实测 / 存疑**：

1. **活体验收没有做**（按边界要求没重启 DSH）。⇒ **所有修复对当前进程都还没生效**，需要在重启后观测，尤其是：② 的 `dispatch_slots` 落盘、⑦ 在真 `.pipeline` 上的归档、⑤ 的 L0 审核新要求、⑧ 的守门文案。
2. **上游没有比对**：本次以本地克隆的 `main` @ `c465dd1` 为基线，**没有**与 `origin/main` 比对是否领先/落后（`git fetch` 未执行）。
3. 缺陷 ⑦ 的 `trash` 在**跨盘符 / 目录被占**时只如实报错，**没有**做 copy+rm 回退。
4. 缺陷 ② 里"派活输出回读**核对一致**"那半句来自 `transport.applyPermissionSlot`（只在**真实会话通道**下跑得到）⇒ **没有**动它，只在盘上补了"实际生效值"。
5. 缺陷 ⑧ 的 shell 判据仍是 **best-effort 字符串匹配**（刻意混淆仍可能绕过）—— 既有口径，本次**没有**假装提升它。
6. **`.gitattributes` 没有加**（判断与建议见 §〇.6）；因此**当前 CRLF 工作区里 `sha256sum -c MANIFEST.sha256` 对所有文本文件都会失败** —— 这是既有的、与本次修复无关的坑，已在报告里写明而没有顺手改掉。
7. **BOM**：安装副本里 `lib/store.js` / `lib/tools/plan.js` 带 UTF-8 BOM，而仓库 blob 不带；本次以仓库为准（写回时剥掉 BOM）。⇒ 同步到安装副本后，那两个文件的 BOM 会**消失**（内容与行为无影响，但字节变了）。

**没做的事**：没有改 `plugin/src/`；没有改 `dashboard/`；没有改 `.pipeline` 任务数据；没有改 profile 全局配置；没有改 DSH 本体 checkout；没有为了变绿改任何既有断言；没有 push。

---

## 七、进度核对：`fix\plugin\tests\` 里 5 条非全绿的逐条交代

**先说结论**：那 5 条是**我中途态的快照**，不是收工态 —— 你读到的是我的开发镜像
`fix\plugin\tests\` 在 **02:09:24** 的落盘；同一批文件已在 **02:36:55** 由一次全绿运行刷新
（51 个 `*-last-run.txt` 全部更新）。三条硬证据：

| 证据 | 内容 |
| --- | --- |
| **时机** | 那 5 条所在目录的 mtime 是 `02:09:24`；我的全部修复提交都在这之后 |
| **改前基线**（你要的"既有失败"证据） | 从 `main`（`c465dd1`）导出 `plugin/active` 单跑这 5 套：<br>`selftest` **70/70** · `switch-check` **45/45** · `load-smoke` **24/24** · `hashgate-check` **79/79** · `switch-route-check` 无 cordis 如实跳过<br>⇒ **它们一条都不是既有失败**，全部是本次改动**中途态**引入的 |
| **收工态** | 仓库 `plugin/active` 与部署副本各跑一遍全套：**1829/1829，exit=0**；5 条现分别为 70/70 · 45/45 · 24/24 · 79/79 · 23/23 |

### 逐条

#### ① `f5-l0-baseline-check` 18/19 → **我引入的（且它抓的是真问题）** → 已修

- **失败断言**：`✗ ★ 刚记完 ⇒ 结论 = 全在授权面内（0 处改动，没有假红）`
- **根因**：这是我**自己那条测试的第一版**断言写的是 `verdict === 'within_scope'`；而当时
  `changeAudit` 在"**没有授权面**"（L0 的 `change_scope` 是 null）时会给 `out_of_scope`
  —— 它把**每一条改动都当成越界**。
- **它其实抓到了真问题**：缺陷 ⑤ 一让 L0 有基线，naive 实现就会把**每一张 L0 单**都判成"多改"，
  那比原缺陷更坏。所以这条红**不该被抹掉**，该被修的是实现。
- **处理**：`lib/store/baseline.js` 新增第三个结论 **`no_scope`**（"没有授权面" ≠ "违反了授权面"：
  `unauthorized` / `missing` 都为空，**前后差异照给**，并附一句为什么这两条判据不适用）；
  该断言随之改写成「结论必须是 `no_scope`」+「`unauthorized`/`missing` 为空」+「前后差异照给」。
- **复现证据**：在 HEAD 上把 `baseline.js` 的 `hasScope` 分支去掉 ⇒ `f5-l0-baseline-check` 变 **21/23**，
  失败断言正是那条 `no_scope` 断言。
- **计数说明（不糊弄）**：你看到的 **18/19** 是**更早一版**的 f5（当时 19 条断言）；这个测试文件后来
  扩到 23 条，所以**计数不同、机制同一条**。我没法拿现在的文件复现出 18/19，只能复现出"删掉 `no_scope`
  就红"这个**同一机制**。
- **结果**：现 **23/23**。

#### ② `selftest` 68/70 → **我引入的** → 已修（**没有改任何断言**）

- **根因**：缺陷 ⑤ 让 L0 也有基线 ⇒「有基线就必须交 `change_audit`（前后版本对比结论）」
  这条**对 L0 同样生效**；而正例 / 反例⑧ / 审核发 NG 三处夹具没交 ⇒ 正例第 8 步被拒 ⇒
  `runHappyPath` 抛错。**抛错会让该套的项目总数从 70 掉到 65**（happy path 后面的组没跑到）——
  这也解释了为什么我按同样的方式撤回时复现出的是 **62/65** 而不是 68/70：
  两者是**同一条失败曲线上的不同点**，我无法逐字复现 68/70（那个中间态的文件已被后续运行覆盖）。
- **是不是我改了断言的判据（这是你要的硬指标，给可核的证明）**：

  | 检查 | main（改前） | HEAD（改后） |
  | --- | --- | --- |
  | `expectOk(` 调用数 | **13** | **13** |
  | `expectDenied(` 调用数 | **32** | **32** |
  | `rec.add(` 调用数 | **23** | **23** |
  | 本套结果 | 70/70 | 70/70 |

  断言**一个没加、没删、没弱化**。`git diff --numstat main..HEAD -- plugin/active/tests/selftest-core.mjs`
  = **22 增 / 3 删**，那 3 删是**注释行**；全部改动就是给三处夹具补上
  `...(await auditFor(h, …))`（**真去问一次工具**拿结论，不是手编）+ 配套注释。
- **方向**：这三处是**变严**（多交一份本该交的证据），不是放松。
- **结果**：现 **70/70**（与改前一致）。

#### ③ `load-smoke` 18/24 → **我引入的** → 已修

- **根因**：缺陷 ⑦ 的修法是**多一个具名工具** `pipeline_task_purge` ⇒ 注册数 31→32，
  而 `EXPECTED_TOOL_COUNT` 还是 31 ⇒ **用同一个常量的 6 处断言一起红**（24−18=6，正好对上）。
- **复现证据**：把 `EXPECTED_TOOL_COUNT` 改回 31 ⇒ **18/24**，**精确一致**。
- **处理**：常量同步 31→32，并在旁边写明理由。**判据方向没放宽**：仍然是「注册数必须精确等于这个数」，
  少注册一个（能力悄悄消失）或多注册一个（悄悄多一条能力）都照样红。
- **结果**：现 **24/24**。

#### ④ `hashgate` 78/79 → **我引入的** → 已修

- **根因**：那条断言原本写的是「L0 没有计划站 ⇒ **没有基线** ⇒ 这道闸不适用」；
  缺陷 ⑤ 之后 **L0 有基线了**，旧断言的前提不成立。
- **复现证据**：把该断言改回 `currentBaseline(t) === null` ⇒ **78/79**，**精确一致**。
- **处理**：判据改成与 `lib/store/submit.js` **同源**的那一条 ——「**没有授权面** ⇒ 弃权」
  （这道闸判的是"改动面 vs **授权面**"，L0 刻意没有授权面），并把新事实
  （`currentBaseline(t) !== null`）一起钉住。**比原来更严**：不再靠"没有基线"这种间接特征。
- **结果**：现 **79/79**。

#### ⑤ `switch`（同一文件两条汇总 44/45 与 68/70）→ **我引入的，且与第 ② 条同源** → 已修

- **澄清**：那个文件是 **`switch-check-last-run.txt`**（不是 `switch-route-check`）。
  它的 `T6` 断言就是「**`pipeline_selftest` 仍然可用**」—— 会**嵌套跑一次自检**，
  于是自检的红**原样透到这条上**，一个文件里因此出现**两条汇总**：
  `44/45` 是套件自己、`68/70` 是它嵌套跑出来的那次自检。
- **复现证据**：撤回三处 `auditFor` 后单跑 `switch-check` ⇒ **44/45**，
  失败断言原文 `✗ T6 关：pipeline_selftest（只读、跑在临时目录）仍然可用` —— **精确一致**。
- **处理**：随第 ② 条一起转绿。
- **结果**：现 **45/45**，嵌套自检 **70/70**。
- **另**：`switch-route-check` 是**另一套**，本机没有 `@deepseek-ai/cordis` ⇒ 它按仓库 README 的口径
  **如实跳过**（原文：「另有 3 套需要宿主包…本机找不到时会跳过并如实标注，不计入通过率」），
  文件里只有跳过说明、没有汇总行。**这不是失败，也不计入通过率。**

### 小结

| # | 套 | 你看到的 | 根因 | 本次引入？ | 处理 | 现在 |
| --- | --- | --- | --- | --- | --- | --- |
| ① | `f5-l0-baseline-check` | 18/19 | 我的测试第一版断言写死 `within_scope`；实现当时会把每张 L0 单判成越界 | ✅ 是（且是**测试抓实现**） | 实现加 `no_scope`；断言改写成对应形状 | **23/23** |
| ② | `selftest` | 68/70 | 缺陷⑤ 让「必交 `change_audit`」对 L0 生效，3 处夹具没交 | ✅ 是 | 3 处夹具补 `auditFor`（**断言零改动**） | **70/70** |
| ③ | `load-smoke` | 18/24 | 新增工具 ⇒ 注册数 31→32，常量没同步（6 处共用一个常量） | ✅ 是 | 常量同步 31→32（方向未放宽） | **24/24** |
| ④ | `hashgate` | 78/79 | 旧断言前提是"L0 没有基线"，缺陷⑤ 之后不成立 | ✅ 是 | 判据改为"没有授权面"（**更严**） | **79/79** |
| ⑤ | `switch-check`（含嵌套自检） | 44/45 与 68/70 | 与 ② 同源：T6 嵌套跑自检，自检的红透上来 | ✅ 是 | 随 ② 转绿 | **45/45** + 嵌套 **70/70** |

**"既有失败"的结论**：**一条都没有**。改前 `main` 上这 4 套（f5 当时还不存在）全绿，
且改前全套 `1588/1588` 零红 —— 所以上面每一条都只能是我引入的。

**复现脚本**（本次为核对而写，放在工作区 `_recon\`，不属于交付物）：
`repro-all.ps1`（一次性撤回全部中途适配并复现 5 条）、`repro-5b.ps1`（逐条撤回+还原）、
`rule-probe.mjs` / `verify-manifest.mjs` / `check-manifest.mjs`（清单口径与校验）。

**刷新的产物**：`fix\plugin\tests\` 下 **51 个 `*-last-run.txt`** 已在 **02:36:55** 由一次
**1829/1829、exit=0** 的运行整体刷新 —— 你之前读到的 02:09:24 那批已被覆盖。

---

## 八、F11：四槽接线不一致（同一份数据两个真相）

### 8.1 先把现场那句话复现出来（不是推测）

我在**本机**用假宿主复现了改前的派遣输出，逐字如下（`_recon/oldactive` = `main` 的证据树）：

```
权限档：权限档 = workspace-write（计划指定）；读回核对一致（workspace-write）
```

**你引的「权限档 = 权限档 = …」是真的，来源也查清了**：`spawnRole` 的行模板是
`权限档：${permission.note}`，而 `permission.note` 自己又以 `权限档 = ` 开头 ⇒ 拼出来就是
**同一个标签连写两遍**。（我上一轮曾说"在代码里找不到字面重复"，那是我只搜了带等号的
`权限档 = ` 而没看**拼接后的结果** —— 这里更正：它确实存在，是嵌套所致。）

### 8.2 那个尖锐的问题：『读回核对一致』到底是不是真的在读会话头？

**逐槽的答案不一样 —— 而改前的文案把它们说成了同一件事。** 这是 F11 的核心。

| 槽 | 改前**实际**做了什么 | 是不是读回 | 我做的证伪实验（本机可跑） |
| --- | --- | --- | --- |
| `mode` | `create({agentPreset})` 后读 `inspect().meta.agentPreset` 并**比对**，不符 ⇒ **拒绝派活** | ✅ **真读回** | 让假宿主的会话头返回 `standard`、而请求 `computer-use` ⇒ 命令**被拒**（`✗ B1`）。**回显的话这里会通过** |
| `permission` | `permissionPresets.set()` 后读 `permissionPresets.current(session)` 并**比对**，不符 ⇒ **拒绝派活** | ✅ **真读回** | 让假宿主回读成 `read-only`、而请求 `workspace-write` ⇒ **被拒**（`✗ C1`）。同样，回显会通过 |
| `model` | **只调 `selectModel`，从不回读**；"成功"的唯一证据是**它没抛错** | ❌ **回显入参** | 宿主形状即证据：`sessionController` 需要 `create/prompt/inspect`（**没有模型读回**）；`agentDefaultModel` 只有 `currentSelection/saveSelection`，读的是**全局默认**、**不是某个会话** |
| `reasoning` | 同 `model`（塞在同一次 `selectModel` 调用里） | ❌ **回显入参** | 同上 |

⇒ **结论：`mode` / `permission` 是真读回（且有"不符就拒绝"的执法）；`model` / `reasoning` 是回显。**
改前的文案把四种情况写成同一句"读回核对一致"，**对后两槽没有依据**。

**`permissionPresets.current` 不可用时**（宿主形态差异）：改前写"读回不可用（如实登记）"——
这半句是诚实的；但它与"核对一致"共用同一个句式，读者分不出来。现在三态分开：
`readback` / `readback_unavailable`（想读但没接口）/ `requested`（只请求，本就不打算读回）。

### 8.3 修法（三件事，都不动冻结的声明表）

1. **逐槽证据等级（结构化，不再散在文案里）** —— 新增 `lib/transport/slot-evidence.js`。
   每条证据是 `{kind, requested, effective, detail}`，并有**结构闸**：
   `kind !== readback` 时 `effective` **恒为 null** ⇒ *"没有读回来的值"在结构上就写不出"一致"*。
   派活返回值新增 `slotEvidence` 字段，落盘时一并写进 `roster.slots_effective[key].evidence`。
2. **声明与生效同键可查** —— `lib/store/dispatch-slots.js` 现在维护
   `task.roster.slots_effective[<键>]`（键与声明表**同一套规则** `slotKeyOf`），
   一个对象里同时看得到两边；另有只追加的流水 `task.dispatch_slots[]`。
   ★ **为什么不去改写 `roster.slots` 本身**：那张表带 **`slots_digest` 摘要冻结**
   （`lib/tiers.js:451`），而 `compareDispatchSlots`（`tiers.js:1265`）**拿它当比对基准** ——
   基准改成现实之后比对永远通过，"冻结"就成了废纸。所以走**同键平行表**，声明表与摘要一个字节不动
   （测试 `F6/F7` 钉住这一点）。
3. **模板不再连写两遍标签、也不再让四槽共用一种说法** —— `spawnRole` 的返回改成
   「## 四槽」四条 bullet，每槽一行、一行一个结论：
   `权限档：workspace-write · 会话读回**workspace-write** ⇒ 核对一致`（真读回）
   `模型：deepseek/chat · 已请求·**未回读** —— 宿主没有"读回某会话当前模型"的接口…`（回显）
   并且**名单与本次派活不一致时会明说**（E1），一致时才说一致（E3）。

### 8.4 你的第 4 问：DSH 侧到底有哪些 preset、插件该怎么校验

**查到了可枚举的接口**（来源：DSH 的 `app.asar` 里 `AgentPresetRegistry` 的实际代码，不是猜的）：

- 它是 Cordis 服务，服务名 **`agentPresets`**（构造函数的 `super(ctx, "agentPresets")`）。
- 对外方法：**`async list()`**（枚举全部已注册 preset）、**`async resolve(id)`**
  （认不出时抛的错里带 `available: [...this.definitions.keys()]`）、`readDocument(agentPreset)`、
  `select(...)`、`get defaultId()`（`= selectedDefault ?? default`）。
- 它的 `Config = { default: string（必填）, selectedDefault: string }`；本机 profile 里落的是
  `default: standard`、`selectedDefault: computer-use` —— **这就是你只见过 `standard` 与
  Computer Use 两种的原因**：preset 是**各插件在运行时注册**的，静态读不出全集。

**插件现在的做法**（新增 `lib/transport/presets.js`）：派活**建会话之前**先 `list()` 校验模式槽 ——
名字不在名单里就**拒绝派活**并把**合法取值**一并交回；宿主没暴露这个服务时**不拦**，
但如实标注"未校验"（探测不到 ≠ 名字是错的）。这比改前强：改前要么靠 `create` 抛一句看不懂的话，
要么宿主**静默回落到默认档**、等会话建出来再靠读回发现。

**要枚举你部署里的全量 preset**：故意派一次不存在的模式，报告里就会列出合法取值（**不建会话**，
因为在 `create` 之前就拦住了）：
`pipeline_dispatch { task_id, role: "writer", mode: "__probe_presets__" }`

### 8.5 测试：同一份文件在旧代码上红、在新代码上绿

新增 **`tests/f11-slot-truth-check.mjs`**（29 条）。它**刻意只 import 旧代码里就有的
`SessionTransport`**，断言**只打在可观测契约上**（派活返回值 + 落盘后的 task JSON），
所以拿到旧代码上是**行为性红**，不是"模块不存在"那种假红：

```
$ cd <改前树 main> && node tests/f11-slot-truth-check.mjs
总计：5/22 通过          ← 红

$ cd repo/plugin/active && node tests/f11-slot-truth-check.mjs
总计：29/29 通过         ← 绿
```

改前那 22 条里红的包括：`slotEvidence` 不存在（A1–A5）、模型行不说"未回读"（A6–A8）、
不存在的 preset **照样建会话**（D2）、名单与派活背离却**不说**不一致（E1）、
没有 `slots_effective`（F2）。

全套：**1829 → 1874**（+29 F11、+16 F12），`node tests/run-all.mjs` ⇒ **1874/1874，exit=0**。
★ 顺带修掉一个我自己引入的回归：改写模型槽文案时把"全局默认已还原（残余窗口…）"那句
从派遣输出里弄丢了，被既有 `channel-check.mjs` 的断言当场抓住（`残余窗口如实写进返回`），
已把那句并进证据的 detail —— 这正是"既有断言一条都不许弱化"的用处。

### 8.6 ★ 真机基线证据（用户提供，跑在**旧代码**上，本单的"修前红"）

用户在运行时插件（旧代码）上做了真机探针，单号 `T-20261015-slotprobe`：
`pipeline_orchestrate` 判 L0（roster = writer / tester / reviewer）；派 `writer` 时**故意传**
`mode="__no_such_preset__"`、`model="__no_such_model__"`、`reasoning="__no_such_reasoning__"`、
`permission="workspace-write"`，且 **`spawn=false`**；返回：

```
# 拒绝派活：会话建不出来
任务 T-20261015-slotprobe · 角色 writer
宿主 sessionController.create 失败：Unknown agent preset: __no_such_preset__
（已指定 agentPreset=__no_such_preset__、workspaceId=104ee6fa-e2c7-4b49-94ee-a10caecd6e97）
★ 不做静默降级。
```

**它确认了两件事，我据此收窄了 F11 的重点：**

| 结论 | 对本单的意义 |
| --- | --- |
| **`mode` 确实接通了宿主**：`agentPreset` 真的进了 `sessionController.create`，宿主不认识就**硬失败**、**不静默降级** | `mode` **不是惰性字段、也不是空口回显** ⇒ 它是**已证明接通**的参照物。F11 的重点因此收窄到 **`permission` 的"记录值 vs 实际值"背离**，以及"读回核对一致"这句话对 **`permission` / `model` / `reasoning`** 是否也成立。（§8.2 的逐槽结论与它一致：`mode`/`permission` 真读回，`model`/`reasoning` 只是回显入参） |
| **失败是干净的**：任务仍停 `ready_dev`、**席位 0**、无台账残留 | 失败路径**没有留下"半派"状态** —— 我在 F11/F12 里**都没有动**这条路径；F12 的测试另加了两条"不许留半派"的判据（E1/E2）把它看住 |

> ⚠️ **同一次探针暴露了 F12**：用户明确传了 `spawn=false`，而宿主 `create` **照样被调用**
> （失败信息自己就在说"我试过了"）。见 §九。

### 8.7 真机验证清单（你跑；我没有主对话身份，**没有**做过端到端验证）

> 前提：**重启 DSH（或重载插件）** —— 磁盘上的新代码对当前进程不生效。

**0. 先枚举你部署里的合法 preset（安全，不建会话）**
```
pipeline_dispatch { task_id: "<本单>", role: "writer", mode: "__probe_presets__" }
```
期望：`ok:false`、`code:PRESET_UNKNOWN`，报告里有 `合法取值：…` 一行；**不产生任何会话**。
把列出的名字填进下面第 1 步的 A / B。

**1. 开单并声明两个不同的 mode**
```
pipeline_task_open {
  task_id: "T-F11-verify",
  requirement: "F11 实机核对：四槽的声明值与生效值是否同源（验证专用单，跑完即取消）",
  deliverable_format: "无（验证单）"
}
```
走到「待开发」（L0 自批即可）。若要**显式**声明两种模式，在 `pipeline_plan` 里给：
```
slots: { "writer":   { permission: "read-only", mode: "<A，例如 standard>" },
         "reviewer": { permission: "read-only", mode: "<B，例如 computer-use>" } }
```

**2. 派活（显式覆盖权限档，制造"声明 read-only vs 生效 workspace-write"的背离）**
```
pipeline_dispatch {
  task_id: "T-F11-verify", role: "writer",
  permission: "workspace-write",
  mode: "<A>",
  model: "<你部署里真有的 provider/model>",   // 不确定就先省略，省略=不下发
  reasoning: "high"
}
```

**3. 要比对的四个点**

| # | 看哪儿 | 怎么取 |
| --- | --- | --- |
| ① | **派活返回文本** | 上面那条 `pipeline_dispatch` 的 `summary`。要找的是「## 四槽」四行 |
| ② | **`roster.slots` 记录** | `pipeline_status { task_id, detail: "full" }` → `task.roster.slots`（**声明**）与 `task.roster.slots_effective`（**生效**） |
| ③ | **派活台账字段** | 同一次 `pipeline_status` 里的 `task.dispatched[]`（席位台账，键是 `角色@席位`）；流水看 `task.history` 里 `action="dispatch:slots"` 的那条 |
| ④ | **该会话的会话头** | 侧栏点开那个新会话看它的模式/模型；或在下发的那个会话里问它自己 |

**4. 判定标准**

| 判据 | 算**一致** | 算**不一致**（要报给我） |
| --- | --- | --- |
| ① 的四槽行 | 每行一个结论；`model` / `reasoning` 两行明写**未回读**；没有「权限档：权限档 =」这种连写 | 任一行出现"核对一致"而它本该是"未回读"；或标签连写两遍 |
| ② 声明 vs 生效 | `slots_effective[<键>].effective.permission === "workspace-write"`，而 `slots.<键>.permission` **仍是** `"read-only"`，且 `slots_digest` **没变** | `slots_effective` 不存在；或 `slots` 被就地改写、摘要变了 |
| ② 的证据等级 | `slots_effective[<键>].evidence` = `{permission:"readback", mode:"readback", model:"requested", reasoning:"requested"}` | `model` 被记成 `readback`（那就是在撒谎） |
| ①③④ 三处取值 | 派活文本里的模式/模型 == `slots_effective` 里的 == 会话头里的 | 三处里任意两处对不上 |
| 名单背离 | 文本里出现「名单（roster.slots）与本次派活**不一致**：…」并点名是哪一槽 | 名单明明是 read-only、文本却说"一致" |

**5. 清理**
```
pipeline_transition { task_id: "T-F11-verify", event: "cancel" }      // 终态出口
pipeline_task_purge { task_id: "T-F11-verify", mode: "trash" }        // 归档到 .pipeline/_trash/（可恢复）
```
`pipeline_task_purge` 只认终态单（所以先 cancel）；默认进回收站；墓碑落在
`.pipeline/_purge-log.jsonl`，删完仍可追溯。

**6. ★ 补充项一：用 `mode` 的合法值跑一次，确认不同席位能带不同 preset**（用户点名要的）

用第 0 步枚举出来的**合法**名字（例如 `<A>=standard`、`<B>=computer-use`），
在第 1 步的 `slots` 里给两个席位**不同**的模式，然后**分别派活**：

```
pipeline_dispatch { task_id: "T-F11-verify", role: "writer",   mode: "<A>", permission: "read-only" }
pipeline_dispatch { task_id: "T-F11-verify", role: "reviewer", mode: "<B>", permission: "read-only" }
```

| 判据 | 算**通过** | 算**不通过**（报给我） |
| --- | --- | --- |
| 两个会话的模式 | `writer` 那个会话头是 `<A>`、`reviewer` 那个是 `<B>`；**两个不一样** | 两个都是同一个（说明 `mode` 没按席位走，或被谁统一覆盖了） |
| ① 的模式行 | 各自 `模式（会话头 agentPreset）：<A> · 会话读回**<A>** ⇒ 核对一致`，且 `mode` 的证据等级是 `readback` | 出现 `readback_unavailable`（会话头读不到 agentPreset）或"核对不一致" |
| ③ 的 `slots_effective` | `writer` 与 `reviewer` 两个键下的 `effective.mode` 分别等于 `<A>` / `<B>` | 两个键的值相同、或键不对（串了席位） |

> 为什么要"两个席位不同"才算验到：只派一个席位时，"按席位取模式"和"取全局默认"**结果一样**，
> 分辨不出来。差异化的取值才让这条判据有区分力。

**7. ★ 补充项二：`spawn=false` 跑一次，断言**没有**产生新会话（F12 的验收）**

```
pipeline_dispatch { task_id: "T-F11-verify", role: "writer", spawn: false }
```

| 判据 | 算**通过** | 算**不通过**（报给我） |
| --- | --- | --- |
| 侧栏 | **没有**多出任何会话 | 多出一个新会话（= F12 没修好） |
| 返回文本 | 写明「本插件**没有创建任何会话**」+ 一段 ```` ``` ```` 包起来的可粘贴派活单 | 出现 `# 拒绝派活：会话建不出来`（那说明**它去建了**） |
| 令牌 | 仍然拿得到令牌，但**没有绑定任何会话** | 令牌绑到了一个会话 id |
| 流水 | `task.history` 里有一条 `channel:spawn_false` | 出现 `channel:dispatched`（那意味着它真派了） |

---

## 九、F12：`spawn=false` 没有生效（显式传了，宿主 create 照样被调用）

### 9.1 根因（一行就看完）

`lib/tools/dispatch.js` 改前是：

```js
if (!spawn || !isSpawnableRole(role)) {
  res = await transport.spawnRole({ task, roster, role, seat, agentId: null, ...slots })
} else {
  res = await transport.spawnRole({ task, roster, role, seat, parent: exec.agent, signal: exec.signal, ...slots })
}
```

**两个分支调的是同一个方法**，只有 `agentId` / `parent` 两个字段不同 ——
而 `SessionTransport.spawnRole` **根本不看 `agentId`**，无条件 `controller.create`。
⇒ `spawn=false` 从来没有"不建会话"的效果，它只是换了个字段。
文档（工具描述与参数说明）写的是「transport=manual（或 spawn_roles=false）时**只返回一段可粘贴的派活单**」
与「是否真的创建会话」—— **代码与文档不符**。按你给的两个选项，我选**第一个：让代码兑现文档**。

### 9.2 改法

1. 新增 `manualSpawnResult(deps, spec, why)`（`lib/transport/index.js` 导出）——
   "不建会话"的**唯一**出口：铸一枚**未绑定**的令牌 + 渲染派活单，
   返回 **`spawned: false` / `agentId: null` / `sessionId: null` / `via: 'manual'`**。
   `spawned` 是**机器可读判据**，调用方与测试都不必去读文案。
2. **真的会建东西的那两条通道**在 `spawnRole` 的**最前面**守住这条线：
   `SessionTransport`（`spec.spawn === false` ⇒ 直接返回，**一个字节都不碰宿主**）与
   `SubagentTransport`（不许 `subagents.start*`）。判断必须在最前面 ——
   放在 `ensureProjectGroup` / `create` 之后就晚了。
3. `lib/tools/dispatch.js` 把**有效**的 spawn 意图带进 spec：
   `const effectiveSpawn = spawn && isSpawnableRole(role)`，两个分支各自传 `spawn: true/false`。

**★ 为什么不让工具这一层直接换成 `ManualTransport`（我考虑过并否掉了）**：
`spawn: false` 是**自测里普遍使用的**调用形态（约 40 处），而自测跑的是 `SimulatedTransport` ——
它**本来就不建任何真实会话**，还靠假会话 id 驱动状态机。把那些调用一律改道，
等于为了修一条真机路径把整套自测的夹具语义换掉。所以判据下沉到**真的会建东西的那两条通道**，
它们才是"不许碰宿主"这条线的责任方。（`SimulatedTransport` 不建任何真东西 ⇒ 它天然满足这条契约。）

### 9.3 测试：同一份文件在旧代码上红、在新代码上绿

新增 **`tests/f12-spawn-false-check.mjs`**（16 条）。它只 import 旧代码里就有的
`SessionTransport` / `SubagentTransport`，用**会数 `create` 次数的假宿主**驱动：

```
$ cd <改前树 main> && node tests/f12-spawn-false-check.mjs
✗ A1 宿主的 sessionController.create 一次都没被调用
✗ A2 返回值带机器可读判据 spawned === false
✗ D1 spawn=false ⇒ subagents.start* 一次都没被调用   …（共 11 红）

$ cd repo/plugin/active && node tests/f12-spawn-false-check.mjs
总计：16/16 通过
```

判据覆盖：`create` 调用次数 = 0、`prompt` 也没被调、`agentId`/`sessionId` 为 null、
**仍然可用**（拿到令牌 + 带代码块的可粘贴派活单）、`spawn` 不给时**照旧建会话**
（没有把正常路径一起关掉）、子代理通道同样守线、以及"没建会话就不许假装绑定了会话"
（`group` / `binding` 这类会话侧产物不许出现）。

全套：**1858 → 1874**（+16），`node tests/run-all.mjs` ⇒ **1874/1874，exit=0**。
