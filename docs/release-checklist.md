# 推送前检查清单

> 每次 `git push` 之前逐条过。每条都写**怎么查**与**通过标准**；有一条不过就先别推。
> 路径一律可移植写法，命令默认在仓库根目录执行（特别标明的除外）。

---

## 0. 先确认这一版的口径

| 事实 | 期望值 |
|---|---|
| 客户端入口 | `plugin/active/lib/client.js` **375 行** |
| 客户端 chunk | **18 个** `client.panel-*.js`；入口 + chunk 共 **19 个文件、4743 行** |
| 单文件大小 | **无死限、无登记**（大小是信号不是死限）；体检报告只列"超过 400 行的文件"给人看，永远全绿、不判红（`tests/file-size-check.mjs`） |
| 全量自测 | **3950/3950**、**120 套**（设了 `DSH_APP_ASAR`） |
| 面板相关套件 | `client-check` 30 / `panel-ui-check` 14 / `panel-portal-check` 3 / `panel-snapshot-check` 74 / `panel-actions-check` 99 |
| 文件规模提醒 | >150 / >300 / ≥400 由**程序自动发起**询问（`size-reminder-check` 20/20；阈值可配 `sizeReminder.*`） |
| 修复批次回归（2026-10-18） | `f24-browser-profile-guard-check` 33/33 · `f25-hashgate-attribution-check` 25/25 · `f26-liveness-approval-check` 40/40 |
| P2 批次回归（2026-10-18） | `f27-pipeline-wait-check` 43/43 · `f28-p2-polish-check` 27/27；工具总数 36→**37** |
| P1-18 批次回归（2026-10-18） | `f29-artifact-matrix-check` 43/43（矩阵 / 豁免 / 关单） |
| P1-10 批次回归（2026-10-18） | `f30-artifact-snapshot-check` 32/32（快照登记 / verify / L3+ 关单） |

---

## 1. 四语言 README 的结构与数字一致

```powershell
$patterns = [ordered]@{
  '375'       = '375'
  '4743'      = '4743'
  '3950'      = '3950/3950'
  '112'       = '112'
  '18 chunk'  = '18\s*(个|個|chunks?|chunk)'
  '19 files'  = '19\s*(个文件|個のファイル|ファイル|files?|файл)'
  'size-signal' = 'file-size-check'
}
foreach ($f in 'README.md','README.en-US.md','README.ja.md','README.ru.md') {
  foreach ($k in $patterns.Keys) {
    if (-not (Select-String -Path $f -Pattern $patterns[$k] -Quiet)) { "缺少 $k：$f" }
  }
}
```

- 通过标准：四份都出现 `375`、`4743`、`18 chunk`、`19 files`、`3950/3950`、`112` 与
  「大小是信号不是死限（`file-size-check`）」的说明；
  章节编号一致（部署 / 插件源码 / 控制面板 / DSH 插件声明 / 文档 / 校验 / 开源协议与出处 / 文档索引）。
- 同时反查旧说法是否还有残留：

```powershell
Select-String -Path README*.md -Pattern '3676|16 个 chunk|15 个 chunk|正好 400|顶格 400|每个 ≤400'
```

  通过标准：无输出。

---

## 2. 客户端文件数与行数

```powershell
$files = Get-ChildItem plugin/active/lib -Filter 'client*.js'
$rows = foreach ($f in $files) {
  $c = [System.IO.File]::ReadAllText($f.FullName)
  $n = ($c -split "`n").Count; if ($c.EndsWith("`n")) { $n-- }
  [pscustomobject]@{ Name = $f.Name; Lines = $n }
}
$rows | Sort-Object Lines -Descending | Format-Table -AutoSize
"文件数 = $($rows.Count)"
"合计行数 = $(($rows | Measure-Object Lines -Sum).Sum)"
$rows | Where-Object { $_.Lines -gt 400 -or ($_.Lines -ge 390 -and $_.Lines -le 400) }
```

- 通过标准：文件数 **19**、合计 **4743**、入口 375；单文件超过 400 行会在体检报告里列**预警**（不判红）——
  如果有人要拆，按 `CONVENTIONS §4` 的四问判断。
- `client-check.mjs` 的 D7 只把行数**报告**出来（不判红）；`file-size-check.mjs` 的预警名单同理。

---

## 3. 客户端契约没有回归

```powershell
(Select-String -Path plugin/active/lib/client.js -Pattern 'client\.panel-' -AllMatches |
  ForEach-Object { $_.Matches.Count } | Measure-Object -Sum).Sum
Select-String -Path plugin/active/lib/client.js -Pattern 'require\.async'
Select-String -Path plugin/active/lib/client.panel-portal.js -Pattern 'createPortal|document\.body'
```

- 通过标准：`CHUNKS` 表恰好 18 项（上面第一条输出 **18**）；入口用 `require.async` 逐个取；portal 通过
  `createPortal(children, document.body)` + `position: fixed` 渲染，并有 `react-dom` 缺失时的回退。

---

## 4. 临时诊断代码无残留

```powershell
Get-ChildItem plugin/active/lib -Recurse -File -Filter *.js |
  Select-String -Pattern 'data-pipeline-diagnostic|describeTarget|诊断祖先路径'
```

- 通过标准：**无输出**。面板行为只由正式判据承担（悬停 140ms 开 / 800ms 慢关 / 点一下钉住、
  点外面 `target.closest` 复核、portal 落点公式），不靠临时诊断属性或诊断描述器。

---

## 5. LICENSE 与包元数据

```powershell
Get-Content LICENSE -TotalCount 3
node -e "const p=require('./plugin/active/package.json');console.log(JSON.stringify({private:p.private,repository:p.repository,homepage:p.homepage,bugs:p.bugs,manifestVersion:p.dsh&&p.dsh.manifestVersion,engines:p.engines,license:p.license},null,2))"
```

- 通过标准：
  - 根 `LICENSE` 是标准 MIT 正文，版权行 `Copyright (c) 2026 tangdancol-jpg`；
  - `private: false`；`repository.url` 为 `https://github.com/tangdancol-jpg/dsh-pipeline.git`；
  - `homepage` / `bugs.url` 指向仓库与 issues；`dsh.manifestVersion: 1`；
  - `engines.dsh: ">=0.2.1-rc.2"`（`engines.node` 保持原值）；
  - `files` / `exports` / `dsh.bundle` / `dsh.client` / `main` / `scripts` / `peerDependencies` **未被改动**。

---

## 6. 全量自测

```powershell
cd plugin/active
$env:DSH_APP_ASAR = '<DSH 安装>\resources\app.asar'   # 预设 / 宿主 schema 类判据要读宿主安装
node tests\run-all.mjs
```

- 通过标准：`3950/3950 通过（120 套）`，退出码 0；结果落在 `tests/last-run.txt`。
- 不设 `DSH_APP_ASAR` 时会有 3 条预置校验判红（环境面）；这类红要在 PR 里写明，不能当成通过。
- 单套复跑：`node tests\client-check.mjs` / `node tests\panel-ui-check.mjs` /
  `node tests\panel-portal-check.mjs` / `node tests\panel-snapshot-check.mjs` /
  `node tests\panel-actions-check.mjs`，各自应分别 30/30、14/14、3/3、74/74、99/99。
- 文件规模体检（只报告，不是死限）：`node tests\file-size-check.mjs` → **7/7**（永远全绿）。
- 文件规模提醒：`node tests\size-reminder-check.mjs` → **20/20**（三档阈值/文案/去重/注入形状）。
- 修复批次回归（2026-10-18）：`node tests\f24-browser-profile-guard-check.mjs` **33/33** ·
  `node tests\f25-hashgate-attribution-check.mjs` **25/25** ·
  `node tests\f26-liveness-approval-check.mjs` **40/40**。
- P2 批次回归（2026-10-18）：`node tests\f27-pipeline-wait-check.mjs` **43/43** ·
  `node tests\f28-p2-polish-check.mjs` **27/27**。
- P1-18 批次回归（2026-10-18）：`node tests\f29-artifact-matrix-check.mjs` **43/43**。
- P1-10 批次回归（2026-10-18）：`node tests\f30-artifact-snapshot-check.mjs` **32/32**。

---

## 6b. 文件规模体检（只报告，不是死限）

```powershell
cd plugin/active
node tests\file-size-check.mjs
```

- 通过标准：**7/7**、退出码 0；输出里能看到扫描文件数、最大文件、以及"超过预警线 400 行的文件清单"。
- **报告不是失败**：超过 400 行的文件只是被列出来 —— 作者/评审按 `CONVENTIONS §4`
  的四问（单一改动原因 / 一句话命名 / 边界可见 / 并行不撞）判断拆不拆，**机器不替人做这个判断**。
  这套件**不判红、不设基线、不建登记表、不阻塞任何东西**：为拆而拆没有意义。
- 想观察某个文件是不是又变大了：看 `git diff` 与评审，比任何登记表都直接。
- 设计（含为什么从"硬闸/基线"一路改成"只报告"、已知限制）：
  [`plugin/active/design/conventions/01-文件规模体检.md`](../plugin/active/design/conventions/01-文件规模体检.md)。

---
## 7. 安装副本与仓库一致（装过的机器）

回到仓库根目录再执行：

```powershell
node plugin/active/tools/sync-check.mjs --repo plugin/active --installed <DSH 用户目录>/profiles/<profile>/node_modules/dsh-pipeline
```

- 通过标准：退出码 0，输出 `OK: N/N 一致`；有 missing / extra / changed 就先
  `node plugin/active/tools/sync.mjs --repo <同上> --installed <同上>` 同步并重启 DSH。
- 没装过、也不打算在本机验证的，跳过本条并在 PR 里注明"未做安装副本核对"。

---

## 8. MANIFEST 重算并通过

在仓库根目录执行：

```bash
sha256sum -c MANIFEST.sha256
```

- 通过标准：全部 `OK`，无 `FAILED` / 缺文件（Windows 上没有 `sha256sum` 时的替代命令见
  [`docs/manifest.md`](manifest.md)）。
- **顺序**：先把内容全部改完、再按 [`docs/manifest.md`](manifest.md) 的口径重算清单，最后才推 ——
  先算清单再改文件等于白算。清单范围是 `git ls-files` 的全集（排除自身），新增 / 删除文件同样要重算。

---

## 9. 工作区干净

```bash
git status --porcelain
```

- 通过标准：**空输出**（所有改动都已提交；清单重算也包含在内）。顺手确认 `git diff --stat` 里没有
  计划外文件；涉及代码的轮次还要核对 `lib/*.js` 与 `tests/*-check.mjs` 是否都在计划内（文档轮不该动）。

---

## 9.5 ★ 推送前必须得到用户明确同意（2026-10-18 用户口径）

```text
本地 commit 可以做；git push 之前必须问用户，得到明确同意才推。
```

- 为什么：这是**用户自己的公开仓库**，什么时候把本地一批修复放出去、要不要先自己看一遍，
  是用户的决定，不是发布纪律能替代的；
- 本清单第 1–9 步全部通过 = **可推的候选**，不等于"现在推"；
- 用户同意后：推完把 `main` 与 `origin/main` 的 sha 对照发出来（一条消息即可），不要静默推。

---

## 10. 最后一遍

- 根 README 的部署命令能照抄执行（`git clone` → `plugin/active/install.ps1 -DryRun`）；
- 新增文档都进了索引：`docs/README.md` 收录 [`release-checklist.md`](release-checklist.md)；
- 架构图能离线打开：`docs/产出交付文档-v3-20261014/架构图-main-path-v3.html`，客户端层是
  "入口 → require.async → 18 chunk"，并画出 portal → `document.body`。
