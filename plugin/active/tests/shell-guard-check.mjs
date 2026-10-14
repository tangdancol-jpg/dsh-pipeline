/**
 * dsh-pipeline · P1-4：shell 守门的误判、绕过与作用域放大
 * ============================================================================
 *     node tests/shell-guard-check.mjs
 *
 * 钉住三件事：
 *   A. 误判：只读命令不再因为 `2>$null` / `2>&1` / 引号里的 `=>` 被当成"改项目文件"；
 *      真写进项目的重定向照旧拒。
 *   B. 绕过：内联解释器里的写文件 API、cmd 复制、git 改工作区、下载到文件 —— 点到项目路径就拒。
 *   C. 作用域：一个会话绑着多张单时，按"还没结束、最近绑定"的那张判（改前总是最老那张）。
 *
 * ★ 全程密闭：项目根是自造的临时目录，不读任何活体真单。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { bindingForAgent, guardDecision, makeTaskIndexEntry, scanShellCommand } from '../lib/guard.js'
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
      const L = ['dsh-pipeline · P1-4：shell 守门的误判、绕过与作用域放大', '='.repeat(78)]
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

export async function runShellGuardCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-shellguard-'))
  try {
    const R = root.replace(/\\/g, '/')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1\n')
    writeFileSync(join(root, 'ledger.json'), '{}\n')
    const task = makeTaskIndexEntry({ taskId: 'T-SG', projectRoot: root, pipelineDir: join(root, '.pipeline') })
    const scan = (cmd, role) => scanShellCommand(cmd, task, role, {})
    const allow = (group, name, cmd, role) => {
      const r = scan(cmd, role)
      rec.add(group, name, r === null, `${role}：${cmd}\n⇒ ${first(r)}`)
    }
    const deny = (group, name, cmd, role, must = '') => {
      const r = scan(cmd, role)
      rec.add(group, name, r !== null && String(r).includes(must), `${role}：${cmd}\n⇒ ${first(r)}`)
    }

    // ---------------------------------------------------------------- A 误判
    const G1 = 'A 只读命令不再被当成改文件'
    allow(G1, '★★ 现场形状：主对话 stat 一个项目里的文件、丢掉错误输出（2>$null）⇒ 放行', `Get-Item ${R}/ledger.json 2>$null`, 'main')
    allow(G1, '★ 2>&1 合并句柄不是写文件', `Get-ChildItem ${R} 2>&1`, 'main')
    allow(G1, '★ 写到空设备（> $null / >/dev/null / > NUL）不是写文件', `git -C ${R} status > $null; ls ${R} >/dev/null; dir > NUL`, 'tester')
    allow(G1, '★ 引号里的 `=>` / `>` 是代码，不是重定向', `node -e "const f = (a) => a > 1; console.log(f(2))"`, 'tester')
    allow(G1, '★ 写到项目外的临时目录 ⇒ 放行', `npm run build > $env:TEMP\\build.log`, 'tester')
    allow(G1, '★ 内联代码只读不写 ⇒ 放行', `node -e "console.log(require('fs').readFileSync('${R}/ledger.json','utf8'))"`, 'tester')
    deny(G1, '★★ 反例：重定向写进项目里的源码 ⇒ 照旧拒', `echo x > ${R}/src/a.js`, 'tester', '不得通过 shell 修改项目文件')
    deny(G1, '★ 反例：重定向到相对路径（工作目录取不准）⇒ 照旧拒', 'echo x > out.txt', 'tester', '不得通过 shell 修改项目文件')
    deny(G1, '★ 反例：管道写文件（Out-File）⇒ 照旧拒', `Get-Content ${R}/ledger.json | Out-File ${R}/copy.json`, 'reviewer', '不得通过 shell 修改项目文件')
    deny(G1, '★ 反例：Set-Content 点到项目路径 ⇒ 照旧拒', `Set-Content ${R}/src/a.js 'x'`, 'main', '不得通过 shell 修改项目文件')

    // ---------------------------------------------------------------- B 绕过
    const G2 = 'B 常见绕过写法补上'
    deny(G2, '★★ node -e 里的 writeFileSync 写项目文件 ⇒ 拒', `node -e "require('fs').writeFileSync('${R}/src/a.js','x')"`, 'tester', '不得通过 shell 修改项目文件')
    deny(G2, '★★ python -c 里的 open(..., "w") ⇒ 拒', `python -c "open(r'${R}/src/a.py','w').write('x')"`, 'reviewer', '不得通过 shell 修改项目文件')
    deny(G2, '★ pwsh -Command 里的 [IO.File]::WriteAllText ⇒ 拒', `pwsh -Command "[IO.File]::WriteAllText('${R}/src/a.js','x')"`, 'tester', '不得通过 shell 修改项目文件')
    deny(G2, '★ cmd 的 copy ⇒ 拒', `copy ${R}\\src\\a.js ${R}\\src\\b.js`, 'tester', '不得通过 shell 修改项目文件')
    deny(G2, '★ git checkout -- 改工作区 ⇒ 拒', `git -C ${R} checkout -- src/a.js`, 'reviewer', '不得通过 shell 修改项目文件')
    deny(G2, '★ curl -o 下载进项目 ⇒ 拒', `curl -o ${R}/src/x.js https://example.invalid/x.js`, 'tester', '不得通过 shell 修改项目文件')
    deny(G2, '★ Invoke-WebRequest -OutFile ⇒ 拒', `Invoke-WebRequest https://example.invalid/x -OutFile ${R}/src/x.js`, 'tester', '不得通过 shell 修改项目文件')
    allow(G2, '★ 编写角色不受这一条约束（它的改动面由授权面判据管）', `node -e "require('fs').writeFileSync('${R}/src/a.js','x')"`, 'writer')

    // ---------------------------------------------------------------- 4c 删除工作区
    const G3 = 'A′ 删除工作区判据不再误认单词里的 rm'
    const P = `${R}/.pipeline`
    allow(G3, '★ 命令里出现 confirm / perform（含 rm 字样）且点到工作区 ⇒ 不再误判成删除', `echo confirm; Get-ChildItem ${P}`, 'main')
    deny(G3, '★ 反例：真的 rm 工作区 ⇒ 照旧拒（编写角色走的是这一条；其它角色在更前面那条就被拦）', `rm -r ${P}/T-SG`, 'writer', '不得删除流水线工作区')
    deny(G3, '★ 反例：主对话 rm 工作区 ⇒ 同样被拒（更前面的"不得改项目文件"那条）', `rm -r ${P}/T-SG`, 'main', '不得通过 shell 修改项目文件')

    // ---------------------------------------------------------------- C 作用域
    const G4 = 'C 一个会话绑着多张单：按哪张判'
    const fakeIndex = new Map([
      ['T-OLD', { terminal: false }],
      ['T-NEW', { terminal: false }],
      ['T-DONE', { terminal: true }],
    ])
    const fakeTokens = (list) => ({ bindingsOfAgent: () => list, roleOfAgent: () => list[0] ?? null })
    const b1 = bindingForAgent(fakeTokens([{ taskId: 'T-OLD', role: 'main', issuedAt: 1 }, { taskId: 'T-NEW', role: 'main', issuedAt: 2 }]), 'S', fakeIndex)
    rec.add(G4, '★★ 两张都没结束 ⇒ 取最近绑定的那张（改前是最老那张）', b1?.taskId === 'T-NEW', JSON.stringify(b1))
    const b2 = bindingForAgent(fakeTokens([{ taskId: 'T-OLD', role: 'main', issuedAt: 1 }, { taskId: 'T-DONE', role: 'main', issuedAt: 2 }]), 'S', fakeIndex)
    rec.add(G4, '★ 最近那张已结束 ⇒ 取还没结束的那张', b2?.taskId === 'T-OLD', JSON.stringify(b2))
    const b3 = bindingForAgent(fakeTokens([{ taskId: 'T-DONE', role: 'main', issuedAt: 5 }]), 'S', fakeIndex)
    rec.add(G4, '★ 只有一张（哪怕已结束）⇒ 就是它', b3?.taskId === 'T-DONE', JSON.stringify(b3))
    const legacy = { roleOfAgent: () => ({ taskId: 'T-LEGACY', role: 'main' }) }
    rec.add(G4, '★ 令牌表没有 bindingsOfAgent（老实现 / 替身）⇒ 行为与改前相同', bindingForAgent(legacy, 'S', fakeIndex)?.taskId === 'T-LEGACY', '')

    // 端到端：真令牌表 + 真守门 —— 拒绝文案点的是新单
    let clock = 1000
    const tokens = createTokenStore({ now: () => clock })
    const rootOld = join(root, 'old-project')
    mkdirSync(rootOld, { recursive: true })
    const old = tokens.mint({ taskId: 'T-OLDTASK', role: 'main', agentId: 'main-session' })
    clock = 2000
    const neu = tokens.mint({ taskId: 'T-NEWTASK', role: 'main', agentId: 'main-session' })
    const index = new Map([
      ['T-OLDTASK', makeTaskIndexEntry({ taskId: 'T-OLDTASK', projectRoot: rootOld, pipelineDir: join(rootOld, '.pipeline') })],
      ['T-NEWTASK', makeTaskIndexEntry({ taskId: 'T-NEWTASK', projectRoot: root, pipelineDir: join(root, '.pipeline') })],
    ])
    rec.add(G4, '夹具：同一个主对话会话持两枚 main 令牌', tokens.bindingsOfAgent('main-session').length === 2 && old.token !== neu.token, JSON.stringify(tokens.bindingsOfAgent('main-session')))
    const r = guardDecision({ name: 'pwsh', arguments: { command: `Set-Content ${R}/src/a.js 'x'` }, agent: { id: 'main-session' } }, { tokens, taskIndex: index, config: {} })
    rec.add(G4, '★★ 端到端：主对话改新单项目里的文件 ⇒ 被拒，且拒绝文案点的是**新单**', String(r ?? '').includes('T-NEWTASK') && !String(r ?? '').includes('T-OLDTASK'), first(r) + '\n' + String(r ?? '').split('\n')[1])
    index.set('T-NEWTASK', makeTaskIndexEntry({ taskId: 'T-NEWTASK', projectRoot: root, pipelineDir: join(root, '.pipeline'), terminal: true }))
    const r2 = guardDecision({ name: 'pwsh', arguments: { command: `Set-Content ${rootOld.replace(/\\/g, '/')}/x.txt 'x'` }, agent: { id: 'main-session' } }, { tokens, taskIndex: index, config: {} })
    rec.add(G4, '★ 新单关单之后 ⇒ 回到还在进行的老单来判', String(r2 ?? '').includes('T-OLDTASK'), first(r2) + '\n' + String(r2 ?? '').split('\n')[1])
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runShellGuardCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
