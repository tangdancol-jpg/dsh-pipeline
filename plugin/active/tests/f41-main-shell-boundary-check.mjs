// P0-3 回归：主对话的 shell 边界（环境级放行 / 交付面与源码树拒绝）。
/**
 * dsh-pipeline · F41：主对话 shell 边界判据（P0-3）
 * ============================================================================
 *     node tests/f41-main-shell-boundary-check.mjs
 *
 * 口径（`design/conventions/03-shell边界.md`，2026-10-19 用户拍板落判据）：
 * **主对话可以动"环境"，不可以动"交付物"与"源码"**。
 *
 *   放行：
 *     · 环境级只读 / 探活（`Get-ChildItem` / `Test-Path` / `Get-Process` / `Test-NetConnection` /
 *       `Invoke-WebRequest` 无 `-OutFile` / `curl` 无 `-o` / 只读 `git status|log|diff`）；
 *     · **清理本单临时残留**：`Remove-Item` 只许落在本单报告目录 `<任务>/reports/**`
 *       或系统临时目录（`$env:TEMP` / `%TEMP%` / `/tmp/`）。
 *   拒绝：
 *     · shell 写 / 删 / 改交付根与源码树（`Set-Content` / `Out-File` / `New-Item` /
 *       `Remove-Item` …；**相对路径 / 取不准的目标**也拒 —— 既有 4a 的 `mentionsProtectedPath` 有缝）；
 *     · `Start-Process`（及 `start-job` 等）启动任意程序；只放行"路径完全落在临时目录"的形态；
 *     · `git` 写操作（checkout / reset / clean / add / commit / push …）；只读 git 照旧放行；
 *     · 删流水线台账（task.json / handoffs / audit.jsonl）—— 清残留不等于删证据。
 *   拒绝文案必须给"允许的替代形态"（write/edit 工具、只读命令、清理边界、pipeline_task_purge）。
 *
 * ★ 三条钉住：
 *   ① **不放宽非 main 席位**：tester / reviewer / supervisor 照旧被 4a 拒；writer 照旧按授权面走；
 *   ② **不抢既有文案**：目标点在项目根里的写/删仍由 4a / 4c 用**原文**拒（既有测试钉着）；
 *   ③ **默认启用**：不传 `guardMainShellBoundary` 就是开；显式 `false` 才关（不改 lib/config.js）。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { guardDecision, judgeMainShellBoundary, makeTaskIndexEntry, scanShellCommand } from '../lib/guard.js'
import { createTokenStore } from '../lib/tokens.js'

function createRecorder() {
  const items = []
  return {
    items,
    add(group, name, pass, detail) {
      items.push({ group, name, pass: pass === true, detail: String(detail ?? '') })
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
    text() {
      const L = ['dsh-pipeline · F41：主对话 shell 边界（P0-3）', '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('', `【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(`      ${it.detail.split('\n').join('\n      ')}`)
      }
      L.push('', '='.repeat(78), `总计：${this.passed}/${this.total} 通过`, '='.repeat(78))
      return L.join('\n')
    },
  }
}

const first = (s) => String(s ?? '(放行)').split('\n')[0]
const hit = (text, fragment) => String(fragment).split('|').some((a) => a.length > 0 && String(text).includes(a))

export function runF41MainShellBoundaryCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f41-'))
  try {
    const R = root.replace(/\\/g, '/')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, '.pipeline', 't-f41', 'reports'), { recursive: true })
    mkdirSync(join(root, '.pipeline', 't-f41', 'handoffs'), { recursive: true })
    mkdirSync(join(root, '.pipeline', 't-other', 'reports'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1\n')
    writeFileSync(join(root, 'ledger.json'), '{}\n')
    writeFileSync(join(root, 'cordis.patch.yml'), 'plugins: []\n')

    const task = makeTaskIndexEntry({ taskId: 'T-F41', projectRoot: root, pipelineDir: join(root, '.pipeline') })
    const reports = String(task.reportsDir ?? '').replace(/\\/g, '/')
    const tempAbs = join(tmpdir(), 'dsh-f41-residue').replace(/\\/g, '/')

    const scan = (cmd, role = 'main', cfg = {}) => scanShellCommand(cmd, task, role, cfg)
    const allow = (group, name, cmd, role = 'main') => {
      const r = scan(cmd, role)
      rec.add(group, name, r === null, `${role}：${cmd}\n⇒ ${first(r)}`)
    }
    const deny = (group, name, cmd, must, role = 'main') => {
      const r = scan(cmd, role)
      const text = String(r ?? '')
      rec.add(group, name, r !== null && hit(text, must), `${role}：${cmd}\n⇒ ${first(r)}`)
      return text
    }

    // =====================================================================
    // A 放行：环境级只读 / 探活（"只读分类"照旧）
    // =====================================================================
    {
      const G = 'A 放行：环境级只读 / 探活'
      allow(G, '★ `Get-ChildItem` 列目录 ⇒ 放行', `Get-ChildItem "${R}"`)
      allow(G, '★ `Get-Content` 读**非源码**文件（配置 / 台账）⇒ 放行', `Get-Content "${R}/cordis.patch.yml"; Get-Content "${R}/ledger.json"`)
      allow(G, '★ `Test-Path` 探路 ⇒ 放行', `Test-Path "${R}/src"`)
      allow(G, '★ `Select-String` 搜非源码文件 ⇒ 放行', `Select-String -Path "${R}/ledger.json" -Pattern "{"`)
      allow(G, '★ `Get-Process` / `tasklist` 探活 ⇒ 放行', `Get-Process | Select-Object -First 3; tasklist | Select-Object -First 3`)
      allow(G, '★ `Test-NetConnection` 探端口 ⇒ 放行', 'Test-NetConnection 127.0.0.1 -Port 56898')
      allow(G, '★ `Invoke-WebRequest` **无 -OutFile**（纯 GET 探活）⇒ 放行', 'Invoke-WebRequest "http://127.0.0.1:56898" -UseBasicParsing | Select-Object -ExpandProperty StatusCode')
      allow(G, '★ `curl` 无 `-o` ⇒ 放行', 'curl "http://127.0.0.1:56898/health"')
      allow(G, '★ 只读 git（status / log / diff）⇒ 放行', `git -C "${R}" status; git log --oneline -3; git diff --stat`)
      allow(G, '★ 只读 git 查询（`stash list` / `show`）⇒ 放行（不因 stash 在写操作名单里误伤）', 'git stash list; git show --stat HEAD')
      allow(G, '★ 版本/路径查询 ⇒ 放行', 'node --version; npm --version; where.exe node')
      allow(G, '★ `pwsh -Command` 里**只有只读 cmdlet** ⇒ 放行（内联写 API 那一支不受影响）', 'pwsh -NoProfile -Command "Get-Date; Get-Location"')
      // 没放宽的既有判据：主对话读源码正文照旧拒
      deny(G, '★★ 没放宽：主对话 `Get-Content` 读 **.js 源码正文** ⇒ 照旧拒', `Get-Content "${R}/src/a.js"`, '不得通过 shell 读取项目代码')
    }

    // =====================================================================
    // B 放行：清理**本单**临时残留（本单 reports + 系统临时目录）
    // =====================================================================
    {
      const G = 'B 放行：清理本单临时残留'
      allow(G, '★★ 删**本单报告目录**里的残留（绝对路径）⇒ 放行', `Remove-Item -Recurse -Force "${reports}/edge-profile-2026"`)
      allow(G, '★★ 删本单报告残留（**相对路径** .pipeline/<本单>/reports/…）⇒ 放行', 'Remove-Item -Recurse -Force ".pipeline/t-f41/reports/edge-*"')
      allow(G, '★ 一次清多条（都在本单 reports 内）⇒ 放行', `Remove-Item "${reports}/a.log"; Remove-Item "${reports}/b.log"`)
      allow(G, '★ 删系统临时目录里的本单残留（$env:TEMP）⇒ 放行', 'Remove-Item -Recurse -Force "$env:TEMP\\dsh-pipeline-f41-residue"')
      allow(G, '★ 删系统临时目录里的本单残留（绝对路径）⇒ 放行', `Remove-Item -Recurse -Force "${tempAbs}"`)
      deny(
        G,
        '★★ 用 `$env:TEMP\\..\\…` **逃出临时目录** ⇒ 拒（前缀像临时目录不算数，要展开后仍在里面）',
        'Remove-Item -Recurse -Force "$env:TEMP\\..\\f41-escape"',
        '只允许删本单临时残留',
      )
      /**
       * ★ 清理命令**夹带别的动作**时不整体放行（否则会连 4b「主对话不得读代码」一起跳过）——
       *   这类命令仍走既有判据，由 4a 用原文拒。
       */
      deny(
        G,
        '★★ 清理命令夹带其它动作 ⇒ **不整体放行**（保守；既有 4a 原文）',
        `Remove-Item "${reports}/x.tmp"; Get-ChildItem "${reports}"`,
        '不得通过 shell 修改项目文件',
      )
    }

    // =====================================================================
    // C 拒绝：写 / 删 / 改交付根与源码树
    // =====================================================================
    {
      const G = 'C 拒绝：写 / 删 / 改交付面'
      deny(G, '★★ `Set-Content` 写项目源码（绝对路径）⇒ 拒（既有 4a 原文不变）', `Set-Content "${R}/src/a.js" 'x'`, '不得通过 shell 修改项目文件')
      deny(G, '★★ `Out-File` 写项目文件 ⇒ 拒', `Get-Content "${R}/ledger.json" | Out-File "${R}/src/copy.json"`, '不得通过 shell 修改项目文件')
      deny(G, '★★ `New-Item` 在项目里建文件 ⇒ 拒', `New-Item -ItemType File -Path "${R}/src/b.js"`, '不得通过 shell 修改项目文件')
      const relWrite = deny(G, '★★ **相对路径**的写（既有 4a 的缝）⇒ 由本判据拒，且给替代形态', `Set-Content src/a.js 'x'`, '主对话不得用 shell 写')
      rec.add(
        G,
        '★★ 拒绝文案给"允许的替代形态"（write / edit 工具 + 只读命令 + 清理边界）',
        relWrite.includes('write / edit') && relWrite.includes('只读命令') && relWrite.includes('清理本单残留'),
        relWrite.split('\n').slice(0, 8).join('\n'),
      )
      deny(G, '★ 相对路径建目录 ⇒ 拒', 'New-Item -ItemType Directory out-dir', '主对话不得用 shell 写')
      deny(G, '★ 相对路径重定向写文件 ⇒ 拒（取不准目标）', 'echo x > out.txt', '主对话不得用 shell 写')
      deny(G, '★★ `Remove-Item` 删项目源码（绝对路径）⇒ 拒（既有 4a 原文不变）', `Remove-Item -Recurse -Force "${R}/src"`, '不得通过 shell 修改项目文件')
      deny(G, '★★ 删**整单工作区**（.pipeline/<本单>，含台账）⇒ 拒（清残留 ≠ 删证据）', `Remove-Item -Recurse -Force "${R}/.pipeline/t-f41"`, '不得通过 shell 修改项目文件|不得删除流水线工作区')
      deny(G, '★★ 删**别的单**的 reports（相对路径）⇒ 拒，文案限定"只许本单残留"', 'Remove-Item -Recurse -Force ".pipeline/t-other/reports/x"', '只允许删本单临时残留|本单报告目录')
      deny(G, '★ 删相对路径的未知目标 ⇒ 拒', 'Remove-Item foo.txt', '只允许删本单临时残留')
      deny(G, '★ 写**本单台账目录**（不是 reports）⇒ 拒', `Set-Content "${R}/.pipeline/t-f41/handoffs/x.json" 'x'`, '不得通过 shell 修改项目文件')
    }

    // =====================================================================
    // D 拒绝：Start-Process / git 写操作（P0-3 点名的两条口子）
    // =====================================================================
    {
      const G = 'D 拒绝：起进程 / git 写操作'
      const sp = deny(G, '★★ `Start-Process python -m http.server` ⇒ 拒（任意程序）', "Start-Process python -ArgumentList '-m','http.server','8000'", '不得用 shell 启动任意程序')
      rec.add(
        G,
        '★★ 起进程的拒绝文案给替代形态（探活只读命令 / 让用户或执行席位做 / 临时目录例外）',
        sp.includes('Test-NetConnection') && sp.includes('探活') && sp.includes('临时目录'),
        sp.split('\n').slice(0, 8).join('\n'),
      )
      deny(G, '★★ `Start-Process` 指向项目里的可执行文件 ⇒ 拒', `Start-Process -FilePath "${R}/src/a.exe"`, '不得用 shell 启动任意程序')
      deny(G, '★ `start-job`（同样是起进程）⇒ 拒', "start-job -ScriptBlock { Get-Date }", '不得用 shell 启动任意程序')
      allow(G, '★ 例外：`Start-Process` 的路径**完全落在临时目录** ⇒ 放行（本单临时目录例外）', 'Start-Process -FilePath "$env:TEMP\\dsh-f41-helper.exe"')
      deny(G, '★★ `git checkout -- <项目文件>` ⇒ 拒（git 写操作）', `git -C "${R}" checkout -- src/a.js`, 'git 写操作')
      deny(G, '★★ `git reset --hard` ⇒ 拒', 'git reset --hard', 'git 写操作')
      deny(G, '★★ `git commit -m x` ⇒ 拒', 'git commit -m "x"', 'git 写操作')
      deny(G, '★ `git clean -fd` ⇒ 拒', 'git clean -fd', 'git 写操作')
    }

    // =====================================================================
    // E 没有放宽非 main 席位（判据只对 main 新增）
    // =====================================================================
    {
      const G = 'E 不放宽非 main 席位'
      deny(G, '★★ tester 写项目源码 ⇒ 照旧拒（4a 原文）', `Set-Content "${R}/src/a.js" 'x'`, '不得通过 shell 修改项目文件', 'tester')
      deny(G, '★★ reviewer 写项目文件 ⇒ 照旧拒', `Out-File "${R}/copy.json"`, '不得通过 shell 修改项目文件', 'reviewer')
      deny(G, '★★ supervisor 删东西 ⇒ 照旧拒（清理例外只给 main）', `Remove-Item -Recurse -Force "${reports}/x.log"`, '不得通过 shell 修改项目文件', 'supervisor')
      allow(G, '★ writer 写项目源码 ⇒ 照旧（由授权面/改动面判据管，不受本判据影响）', `Set-Content "${R}/src/a.js" 'x'`, 'writer')
      deny(G, '★ orchestrator / planner 用 shell 写 ⇒ 照旧拒', `Set-Content "${R}/src/a.js" 'x'`, '不得通过 shell 修改项目文件', 'orchestrator')
    }

    // =====================================================================
    // F 默认启用 / 可显式关闭（不改 lib/config.js）
    // =====================================================================
    {
      const G = 'F 默认启用 + 可显式关闭'
      const onDefault = scan('Set-Content src/a.js \'x\'')
      rec.add(G, '★★ 不传 `guardMainShellBoundary` ⇒ **默认启用**（相对路径写被拒）', onDefault !== null, first(onDefault))
      const off = scan('Set-Content src/a.js \'x\'', 'main', { guardMainShellBoundary: false })
      rec.add(G, '★ 显式传 `guardMainShellBoundary:false` ⇒ 该层关闭（行为回到改前）', off === null, first(off))
    }

    // =====================================================================
    // G 判据是**单一出处**的三态函数（allow / deny / pass）
    // =====================================================================
    {
      const G = 'G 单一出处：judgeMainShellBoundary 的三态'
      const allowV = judgeMainShellBoundary('Remove-Item -Recurse -Force "' + reports + '/x"', task)
      const denyV = judgeMainShellBoundary('Set-Content src/a.js "x"', task)
      const passV = judgeMainShellBoundary('Set-Content "' + R + '/src/a.js" "x"', task)
      rec.add(
        G,
        '★★ 三态各就各位：本单残留清理=allow / 相对路径写=deny / 项目根写=pass（交给既有 4a 原文）',
        allowV.action === 'allow' && denyV.action === 'deny' && passV.action === 'pass',
        JSON.stringify({ allow: allowV.action, deny: denyV.action, pass: passV.action }),
      )
      const readV = judgeMainShellBoundary('Get-ChildItem "' + R + '"', task)
      rec.add(G, '★ 只读命令不表态（pass）—— 只读分类仍由既有判据管', readV.action === 'pass', readV.action)
    }

    // =====================================================================
    // H 端到端：guardDecision 用 main 令牌走同一条判据
    // =====================================================================
    {
      const G = 'H 端到端：guardDecision（main 令牌）'
      const tokens = createTokenStore()
      tokens.mint({ taskId: 'T-F41', role: 'main', agentId: 'f41-main' })
      const index = new Map([['T-F41', task]])
      const decision = (cmd) => guardDecision({ name: 'pwsh', arguments: { command: cmd }, agent: { id: 'f41-main' } }, { tokens, taskIndex: index, config: {} })
      rec.add(G, '★★ 端到端：相对路径写 ⇒ 被拒，且理由归到 main 自己（不串到 tester/reviewer）', String(decision("Set-Content src/a.js 'x'") ?? '').includes('主对话') && !String(decision("Set-Content src/a.js 'x'") ?? '').includes('测试/审核不得替编写改代码'), first(decision("Set-Content src/a.js 'x'")))
      rec.add(G, '★★ 端到端：本单 reports 清理 ⇒ 放行', decision(`Remove-Item -Recurse -Force "${reports}/edge-1"`) === undefined, first(decision(`Remove-Item -Recurse -Force "${reports}/edge-1"`)))
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 8).join('\n'))
  }
  return { passed: rec.passed, total: rec.total, text: rec.text(), items: rec.items }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const r = runF41MainShellBoundaryCheck()
  console.log(r.text)
  process.exitCode = r.passed === r.total ? 0 : 1
}
