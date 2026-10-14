/**
 * dsh-pipeline · 缺陷 ⑦b / ⑧：shell 守门的**纯读误判**与**归因串角色**
 * ============================================================================
 *     node tests/f8b-shell-attribution-check.mjs
 *
 * 真机现场（T-20261015-bb30bc，2026-10-15）：
 *   ① 主对话跑一条**纯读**的多行命令（`Get-Content` 读 `cordis.yml` +
 *      `.pipeline-update-last-stamp.txt`，顺手比对两份插件的 `package.json`）被拒：
 *      「角色「main」不得通过 shell 修改项目文件」；
 *   ② 理由写的是「**原因：测试/审核不得替编写改代码**」—— 而 main 既不是测试也不是审核
 *      （**归因串角色**）；同样的话术也出现在"用 shell 删 `.pipeline` 旧单"那次。
 *
 * 二分定位到的真凶：命令里有一行**回显用的横幅**
 *   `"== 两份插件里有 patch 配置的痕迹吗 =="`
 * —— `SHELL_WRITE_RE` 里的 `patch` 在**整段原文**上被就地匹配到了。
 *
 * 本套钉住五件事：
 *   A. **现场原文** ⇒ 放行（引号里的英文单词不是命令）；
 *   B. 真写动词**照旧拒**（`Set-Content` / `copy` / `patch -p1` / `Remove-Item` / 重定向 / 管道）；
 *   C. **藏进引号交给解释器执行**的写法**照旧拒**（内联那一支没被放宽）；
 *   D. **归因不串角色**：main / 需求分析 / 计划 / 主管 / 测试 / 审核 各自的理由说**各自的**边界；
 *   E. 拒绝文案给出**可行正路**（写代码派编写席位；清旧单用 pipeline_task_purge）。
 *
 * ★ 全程密闭：项目根是自造的临时目录，不读任何活体真单。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { guardDecision, makeTaskIndexEntry, scanShellCommand } from '../lib/guard.js'
import { hasWriteVerbOutsideQuotes } from '../lib/guard/shell-text.js'
import { reasonIsAboutOwnRole, whyShellWriteRefused } from '../lib/guard/attribution.js'
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
      const L = ['dsh-pipeline · 缺陷 ⑦b/⑧：shell 守门（纯读误判 + 归因串角色）', '='.repeat(78)]
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

export async function runF8bShellAttributionCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f8b-'))
  try {
    const R = root.replace(/\\/g, '/')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, '.pipeline', 'T-OLD'), { recursive: true })
    writeFileSync(join(root, 'cordis.yml'), 'plugins: []\n')
    writeFileSync(join(root, '.pipeline-update-last-stamp.txt'), 'stamp\n')
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1\n')

    let clock = 1000
    const tokens = createTokenStore({ now: () => clock })
    for (const role of ['main', 'orchestrator', 'planner', 'supervisor', 'tester', 'reviewer', 'writer']) {
      tokens.mint({ taskId: 'T-F8B', role, agentId: `${role}-s` })
    }
    const index = new Map([
      ['T-F8B', makeTaskIndexEntry({ taskId: 'T-F8B', projectRoot: root, pipelineDir: join(root, '.pipeline') })],
    ])
    const task = index.get('T-F8B')
    const scan = (cmd, role) => scanShellCommand(cmd, task, role, {})
    const decide = (role, cmd) =>
      guardDecision({ name: 'pwsh', arguments: { command: cmd }, agent: { id: `${role}-s` } }, { tokens, taskIndex: index, config: {} })
    const allow = (g, name, cmd, role) => {
      const r = scan(cmd, role)
      rec.add(g, name, r === null, `${role} ⇒ ${first(r)}`)
    }
    const deny = (g, name, cmd, role, must = '') => {
      const r = scan(cmd, role)
      rec.add(g, name, r !== null && String(r).includes(must), `${role} ⇒ ${first(r)}`)
    }

    /**
     * ★★ **A 现场原文** —— 逐字复刻真机上那条被拒的多行命令（只把路径换成夹具的）。
     */
    const LIVE = [
      '"== profile 的插件注册（cordis.yml，223 字节）=="',
      `Get-Content "${root}\\cordis.yml"`,
      '""',
      '"== .pipeline-update-last-stamp.txt =="',
      `Get-Content "${root}\\.pipeline-update-last-stamp.txt"`,
      '""',
      '"== 两份插件里有 patch 配置的痕迹吗 =="',
      'foreach ($p in @("C:/a","C:/b")) {',
      '  $f = Join-Path $p "package.json"',
      '  $v = if (Test-Path $f) { (Get-Content $f -Raw | ConvertFrom-Json).version } else { "（无 package.json）" }',
      '  "$p  version=$v  顶层条目："',
      '  (Get-ChildItem $p -ErrorAction SilentlyContinue | Select-Object -First 12 -ExpandProperty Name) -join ", "',
      '  ""',
      '}',
    ].join('\n')

    const G1 = 'A 现场形状：纯读命令不再被当成"改项目文件"'
    rec.add(G1, '★★ 真机那条**原文**（横幅里带 `patch` 这个词）⇒ **放行**', scan(LIVE, 'main') === null, `main ⇒ ${first(scan(LIVE, 'main'))}`)
    rec.add(G1, '★ 二分结论可核：`Set-Content` 那种**命令位置**上的写动词仍然命中', hasWriteVerbOutsideQuotes(`Set-Content "${R}/src/a.js" 'x'`) === true, '')
    rec.add(G1, '★★ 而**引号里**的 `patch` 不算写动词（缺陷 ⑧ 的根因就在这一条）', hasWriteVerbOutsideQuotes('"== 有 patch 配置的痕迹吗 =="') === false, '')
    allow(G1, '★ 对照：`Get-Content` 读单个配置文件 ⇒ 放行', `Get-Content "${R}/cordis.yml"`, 'main')
    allow(G1, '★ 对照：`Select-String` 搜同一个文件 ⇒ 同样放行（不再是"一个过一个拒"）', `Select-String -Path "${R}/cordis.yml" -Pattern "id"`, 'main')
    allow(G1, '★ 对照：`Get-Item` / `Get-ChildItem` 这类纯读 ⇒ 放行', `Get-Item "${R}/cordis.yml"; Get-ChildItem "${R}"`, 'main')
    allow(G1, '★ 反例（不受影响）：引号里的 `=>` 是代码不是重定向', `node -e "const f = (a) => a > 1; console.log(f(2))"`, 'main')

    // ---------------------------------------------------------------- B 真写照旧拒
    const G2 = 'B 真写动词**照旧拒**（修的是假动词，不是放宽）'
    deny(G2, '★★ `Set-Content` 写项目源码 ⇒ 拒', `Set-Content "${R}/src/a.js" 'x'`, 'main', '不得通过 shell 修改项目文件')
    deny(G2, '★★ cmd 的 `copy` ⇒ 拒', `copy ${root}\\src\\a.js ${root}\\src\\b.js`, 'main', '不得通过 shell 修改项目文件')
    deny(G2, '★★ 未加引号的 `patch -p1` ⇒ 拒（真·patch 命令不许因为本次修复漏掉）', `patch -p1 < ${R}/x.diff`, 'main', '不得通过 shell 修改项目文件')
    deny(G2, '★ `Remove-Item` 删项目里的东西 ⇒ 拒', `Remove-Item -Recurse -Force "${R}/.pipeline/T-OLD"`, 'main', '不得通过 shell 修改项目文件')
    deny(G2, '★ 重定向写进项目 ⇒ 拒', `echo x > ${R}/src/a.js`, 'main', '不得通过 shell 修改项目文件')
    deny(G2, '★ 管道写文件（Out-File）⇒ 拒', `Get-Content "${R}/cordis.yml" | Out-File ${R}/copy.json`, 'main', '不得通过 shell 修改项目文件')

    // ---------------------------------------------------------------- C 内联那一支没放宽
    const G3 = 'C 藏进引号交给解释器执行 ⇒ **照旧拒**（内联那一支一个字没动）'
    deny(G3, '★★ `pwsh -Command "Set-Content …"`（写动词在引号里）⇒ 拒', `pwsh -Command "Set-Content '${R}/src/a.js' 'x'"`, 'main', '不得通过 shell 修改项目文件')
    deny(G3, '★★ `node -e "writeFileSync(…)"` ⇒ 拒', `node -e "require('fs').writeFileSync('${R}/src/a.js','x')"`, 'main', '不得通过 shell 修改项目文件')
    deny(G3, '★ `python -c "open(...,\'w\')"` ⇒ 拒', `python -c "open(r'${R}/src/a.py','w').write('x')"`, 'main', '不得通过 shell 修改项目文件')
    allow(G3, '★ 对照：内联代码**只读** ⇒ 放行', `node -e "console.log(require('fs').readFileSync('${R}/cordis.yml','utf8'))"`, 'main')

    // ---------------------------------------------------------------- D 归因
    const G4 = 'D 归因不串角色：每个角色拿到的理由说的是**它自己**那条边界'
    const roles = ['main', 'orchestrator', 'planner', 'supervisor', 'tester', 'reviewer']
    for (const role of roles) {
      const msg = String(decide(role, `Set-Content "${R}/src/a.js" 'x'`) ?? '')
      rec.add(
        G4,
        `★★ 「${role}」的拒绝理由说的是它自己（不是 tester/reviewer 的那段）`,
        msg.length > 0 && reasonIsAboutOwnRole(role, msg),
        String(msg).split('\n').slice(3, 5).join('\n'),
      )
    }
    const mainMsg = String(decide('main', `Set-Content "${R}/src/a.js" 'x'`) ?? '')
    rec.add(G4, '★★ main 的理由**不再**出现"测试/审核不得替编写改代码"', !mainMsg.includes('测试/审核不得替编写改代码'), '')
    rec.add(G4, '★ main 的理由点明它自己的四件事（接需求/派活/跟踪/关单）', mainMsg.includes('接需求') && mainMsg.includes('关单'), '')
    const testerMsg = String(decide('tester', `Set-Content "${R}/src/a.js" 'x'`) ?? '')
    rec.add(G4, '★ 反过来：tester 的理由**照旧**是"测试不得替编写改代码"（没被改错）', testerMsg.includes('测试不得替编写改代码'), '')
    const reviewerMsg = String(decide('reviewer', `Set-Content "${R}/src/a.js" 'x'`) ?? '')
    rec.add(G4, '★ reviewer 的理由照旧是"审核不得替编写改代码"', reviewerMsg.includes('审核不得替编写改代码'), '')

    // ---------------------------------------------------------------- E 给正路
    const G5 = 'E 拒绝文案必须给出**可行正路**（不许把人堵在墙前面）'
    rec.add(G5, '★★ main 被拒时告诉它：改代码走 pipeline_dispatch 派编写席位', mainMsg.includes('pipeline_dispatch'), '')
    rec.add(G5, '★★ main 被拒时告诉它：清旧单走 **pipeline_task_purge**（缺陷 ⑦b 的连带）', mainMsg.includes('pipeline_task_purge'), '')
    rec.add(G5, '★ tester 被拒时告诉它：打回编写（test_to_dev / pipeline_rework）', testerMsg.includes('pipeline_rework') || testerMsg.includes('test_to_dev'), '')
    rec.add(G5, '★ reviewer 被拒时告诉它：意见写自己的日志 / 交 review_verdict', reviewerMsg.includes('review_verdict') || reviewerMsg.includes('日志'), '')
    rec.add(G5, '★ 认不出的角色 ⇒ 如实说"这一档没有写项目文件的权限"，不硬套别人的身份', whyShellWriteRefused('brand-new-role').includes('没有写项目文件的权限') && !whyShellWriteRefused('brand-new-role').includes('测试/审核'), '')
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF8bShellAttributionCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
