// P0-2 回归：浏览器 Profile / 凭证数据不得进入流水线工作区（守门 + security_check 分类）。
/**
 * dsh-pipeline · F24：P0-2 浏览器 Profile / 凭证数据卫生
 * ============================================================================
 *     node tests/f24-browser-profile-guard-check.mjs
 *
 * 现场（2026-10-18 内部复盘第 2 条）：**测试席位把用户真实浏览器
 * Profile 复制进流水线工作区**（报告实测 374.6 MB）—— `reports/tester/edge-profile-*`
 * 下面躺着 Cookies / Login Data / Web Data / Local State / History / Bookmarks /
 * Vpn Tokens / `*.sqlite`。
 *
 * 这套钉住四件事（三层判据 + 一条不误伤）：
 *   ① 分类器：什么算"浏览器 profile / 凭证路径"（唯一出处 `lib/guard/credential-paths.js`）；
 *   ② 守门·写文件：写 Cookies / Login Data / `*.sqlite` 到工作区 ⇒ **拒**，且文案可操作
 *      （给"脱敏夹具 / 临时空 profile"的下一步，不是只说"不行"）；
 *   ③ 守门·shell：复制 `edge-profile` / `User Data` 进工作区 ⇒ **拒**
 *      （含现场形状：相对目标 + 非 writer 角色 —— 这正是既有 4a 判据漏掉的那条缝）；
 *   ④ `pipeline_security_check`：把上述文件列为一等「凭证落盘」命中
 *      （不是 URL / 外联假阳性），摘要仍不回显命中原文。
 *
 * ★ 不误伤：普通项目文件（`src/a.js` / `reports/test.md` / `reports/tester/tester-report.md`）
 *   照旧放行 —— 判据只认**精确文件名 / profile 目录段 / `*.sqlite` 扩展名**。
 *
 * ★ 全程密闭：项目根是自造的临时目录，不读任何活体真单、不碰用户真实 profile。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  browserProfileWriteRefusal,
  classifyCredentialPath,
  guardDecision,
  makeTaskIndexEntry,
  scanShellCommand,
} from '../lib/guard.js'
import { renderScanSummary, runSecurityScan } from '../lib/security.js'
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
      const L = ['dsh-pipeline · F24：P0-2 浏览器 Profile / 凭证数据卫生（守门 + security_check）', '='.repeat(78)]
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

/** 期望**被拒**：`text` 是拒绝原文（undefined = 放行），`must` 是要在原文里找到的关键片段。 */
function expectRefused(rec, group, name, text, must = []) {
  const s = String(text ?? '')
  const missing = must.filter((m) => !s.includes(m))
  const ok = typeof text === 'string' && text.length > 0 && missing.length === 0
  rec.add(
    group,
    name,
    ok,
    ok
      ? `拒绝原文首行：${first(s)}`
      : `期望被拒但${typeof text === 'string' ? '原文缺关键片段' : '放行了'}${missing.length > 0 ? `：${missing.join(' ｜ ')}` : ''}\n实际首行：${first(s)}`,
  )
  return ok
}

/** 期望**放行**：`res` 为 null / undefined。 */
function expectAllowed(rec, group, name, res, note = '') {
  const ok = res === null || res === undefined
  rec.add(group, name, ok, ok ? note || '放行（返回 null / undefined）' : `期望放行但被拒：${first(res)}`)
  return ok
}

export async function runF24BrowserProfileGuardCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f24-'))
  try {
    const R = root.replace(/\\/g, '/')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, '.pipeline'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1\n')
    writeFileSync(join(root, 'reports-test.md'), '# 普通报告（不是凭证）\n')

    const task = makeTaskIndexEntry({ taskId: 'T-F24G', projectRoot: root, pipelineDir: join(root, '.pipeline') })
    const index = new Map([['T-F24G', task]])
    const tokens = createTokenStore()
    const writer = tokens.mint({ taskId: 'T-F24G', role: 'writer', agentId: 'f24-writer' })
    const tester = tokens.mint({ taskId: 'T-F24G', role: 'tester', agentId: 'f24-tester' })
    void writer
    void tester
    const guard = (tool, args, agentId) =>
      guardDecision({ name: tool, arguments: args, agent: { id: agentId } }, { tokens, taskIndex: index, config: {} })
    const shell = (cmd, role) => scanShellCommand(cmd, task, role, {})
    const at = (...parts) => join(root, ...parts)

    // =========================================================================
    // ① 分类器：什么算浏览器 profile / 凭证路径（唯一出处）
    // =========================================================================
    {
      const G = '① 分类器：浏览器 profile / 凭证路径的唯一出处'
      const edgeCookies = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cookies'
      const hit1 = classifyCredentialPath(edgeCookies)
      rec.add(G, '★★ 真实 Edge 路径（User Data/Default/Cookies）⇒ 命中凭证文件', hit1?.kind === 'credential_file' && hit1.matched === 'cookies', JSON.stringify(hit1))
      const hit2 = classifyCredentialPath('reports/tester/edge-profile-2026')
      rec.add(G, '★★ 现场残留目录名（edge-profile*）⇒ 命中 profile 目录', hit2?.kind === 'browser_profile_dir', JSON.stringify(hit2))
      const hit3 = classifyCredentialPath('reports/tester/edge-profile-2026/Default/Local Storage/leveldb/000003.log')
      rec.add(G, '★ profile 目录**里面的任意文件**也算（目录段判据）', hit3?.kind === 'browser_profile_dir', JSON.stringify(hit3))
      const hit4 = classifyCredentialPath('reports/tester/Login Data')
      rec.add(G, '★ Login Data（精确文件名）⇒ 命中', hit4?.kind === 'credential_file' && hit4.matched === 'login data', JSON.stringify(hit4))
      const hit5 = classifyCredentialPath('reports/tester/cache.sqlite')
      rec.add(G, '★ *.sqlite（浏览器凭证库格式）⇒ 命中', hit5?.kind === 'credential_file', JSON.stringify(hit5))
      rec.add(G, '★ src/a.js 不被误判', classifyCredentialPath('src/a.js') === null, '')
      rec.add(G, '★ reports/test.md 不被误判', classifyCredentialPath('reports/test.md') === null, '')
      rec.add(G, '★ reports/tester/history.md 不被误判（精确文件名，不是模糊匹配）', classifyCredentialPath('reports/tester/history.md') === null, '')
    }

    // =========================================================================
    // ② 守门·写文件：写 Cookies / Login Data / *.sqlite 到工作区 ⇒ 拒
    // =========================================================================
    {
      const G = '② 守门·写文件：凭证文件不得写进工作区'
      const r1 = guard('write', { path: at('src', 'Cookies'), content: 'fake-cookie-db' }, 'f24-writer')
      expectRefused(rec, G, '★★ 编写写 <工作区>/src/Cookies ⇒ 拒（判据 BROWSER_PROFILE_NO_DATA）', r1, [
        'BROWSER_PROFILE_NO_DATA',
        '浏览器 Profile',
        'Cookies',
        // 文案必须**可操作**：给出脱敏夹具 / 临时空 profile 两条出路
        '脱敏夹具',
        '临时空 profile',
      ])
      const r2 = guard('write', { path: at('src', 'Login Data'), content: 'fake-login-db' }, 'f24-writer')
      expectRefused(rec, G, '★ 写 Login Data ⇒ 拒', r2, ['BROWSER_PROFILE_NO_DATA', 'Login Data'.toLowerCase()])
      const r3 = guard('write', { path: at('src', 'db.sqlite'), content: 'SQLite format 3' }, 'f24-writer')
      expectRefused(rec, G, '★ 写 *.sqlite ⇒ 拒', r3, ['BROWSER_PROFILE_NO_DATA', 'sqlite'])
      const r4 = guard('write', { path: at('src', 'edge-profile-1', 'Default', 'Local State'), content: '{}' }, 'f24-writer')
      expectRefused(rec, G, '★ 写进 edge-profile* 目录里的任意文件 ⇒ 拒', r4, ['BROWSER_PROFILE_NO_DATA'])
    }

    // =========================================================================
    // ③ 守门·shell：复制 edge-profile / User Data 进工作区 ⇒ 拒（现场形状）
    // =========================================================================
    {
      const G = '③ 守门·shell：复制浏览器 Profile 进工作区'
      const live = 'Copy-Item -Recurse "$env:LOCALAPPDATA\\Microsoft\\Edge\\User Data" "reports/tester/edge-profile-2026"'
      expectRefused(rec, G, '★★ 现场形状：复制 User Data ⇒ 目录 reports/tester/edge-profile-2026（相对目标）⇒ 拒', shell(live, 'tester'), [
        'BROWSER_PROFILE_NO_DATA',
        '浏览器 Profile',
        '临时空 profile',
      ])
      // ★ 端到端：走守门主判定（不是直接调 scanShellCommand）
      const e2e = guard('pwsh', { command: live }, 'f24-tester')
      expectRefused(rec, G, '★★ 端到端（guardDecision + 测试席位令牌）⇒ 同一份拒绝文案', e2e, ['BROWSER_PROFILE_NO_DATA'])

      expectRefused(
        rec,
        G,
        '★ cp -r 从 Edge profile 复制到 .pipeline 报告目录 ⇒ 拒',
        shell('cp -r "C:/Users/someone/AppData/Local/Microsoft/Edge/User Data" ".pipeline/T-F24G/reports/tester/edge-profile-copy"', 'tester'),
        ['BROWSER_PROFILE_NO_DATA'],
      )
      expectRefused(
        rec,
        G,
        '★ robocopy Chrome User Data ⇒ 改名的目标（profile-backup）也拦得住（源还在路径里）',
        shell('robocopy "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data" "reports\\tester\\profile-backup" /E', 'writer'),
        ['BROWSER_PROFILE_NO_DATA'],
      )
      expectRefused(
        rec,
        G,
        '★ node 内联 cpSync（既有 shell 判据看不出的形态）⇒ 拒',
        shell(
          `node -e "require('fs').cpSync('C:/Users/u/AppData/Local/Microsoft/Edge/User Data/Default/Cookies','reports/tester/data')"`,
          'tester',
        ),
        ['BROWSER_PROFILE_NO_DATA'],
      )
      expectRefused(
        rec,
        G,
        '★ 直接写工作区里的 Cookies（重定向形态；用 writer 是为了绕开 4a 的"非编写不得改项目文件"）⇒ 拒',
        shell('echo x > reports/tester/Cookies', 'writer'),
        ['BROWSER_PROFILE_NO_DATA'],
      )
    }

    // =========================================================================
    // ④ 不误伤：普通项目文件 / 普通复制照旧放行
    // =========================================================================
    {
      const G = '④ 不误伤：普通项目文件照旧放行'
      expectAllowed(rec, G, '★ 编写写 <工作区>/src/a.js ⇒ 放行', guard('write', { path: at('src', 'a.js'), content: '// 正常源码' }, 'f24-writer'))
      expectAllowed(rec, G, '★ 编写写 <工作区>/reports/test.md ⇒ 放行', guard('write', { path: at('reports', 'test.md'), content: '# 报告' }, 'f24-writer'))
      expectAllowed(
        rec,
        G,
        '★ 测试写自己那一片 reports/tester/tester-report.md ⇒ 放行',
        guard('write', { path: at('.pipeline', 'T-F24G', 'reports', 'tester', 'tester-report.md'), content: '# 测试报告' }, 'f24-tester'),
      )
      expectAllowed(rec, G, '★ shell 普通复制（src/a.js → src/b.js）⇒ 放行', shell(`Copy-Item ${R}/src/a.js ${R}/src/b.js`, 'writer'))
      expectAllowed(rec, G, '★ shell 普通读取报告 ⇒ 放行', shell(`Get-Content ${R}/reports-test.md`, 'writer'))
      // ★ 边界：写到项目根**之外**不归本插件管（与其它路径判据同一条边界）
      const outside = join(tmpdir(), 'f24-outside', 'Cookies')
      expectAllowed(
        rec,
        G,
        '★ 边界：目标在项目根之外（本插件不越界管）⇒ 放行',
        browserProfileWriteRefusal({ tool: 'write', role: 'writer', task, targets: [outside] }),
      )
    }

    // =========================================================================
    // ⑤ security_check：凭证落盘列为一等命中（不是 URL / 外联假阳性）
    // =========================================================================
    {
      const G = '⑤ security_check：凭证落盘一等命中'
      const taskDir = at('.pipeline', 'T-F24S')
      const rep = join(taskDir, 'reports', 'tester')
      mkdirSync(rep, { recursive: true })
      writeFileSync(join(rep, 'tester-report.md'), '# 测试报告\n\n（普通文本，不是凭证）\n')
      // 注意：这些是**假数据**（内容只是标记串），但仍按真实文件名摆位 —— 判据看的是路径。
      writeFileSync(join(rep, 'Cookies'), 'FAKE-COOKIE-CONTENT-9f3a\n')
      writeFileSync(join(rep, 'Local State'), '{"os_crypt":{"encrypted_key":"FAKE-LOCAL-STATE"}}\n')
      writeFileSync(join(rep, 'cache.sqlite'), 'SQLite format 3\u0000FAKE-SQLITE\n')
      mkdirSync(join(rep, 'edge-profile-2026', 'Default'), { recursive: true })
      writeFileSync(join(rep, 'edge-profile-2026', 'Default', 'Login Data'), 'FAKE-LOGIN-DB\n')

      const fakeTask = { id: 'T-F24S', requirement: 'F24 夹具：凭证落盘', roster: { acceptance: [] } }
      const scan = await runSecurityScan({ task: fakeTask, projectRoot: root, pipelineDir: join(root, '.pipeline') })
      const cred = scan.credential_store?.findings ?? []
      const types = new Set(cred.map((f) => f.type))
      rec.add(
        G,
        '★★ Cookies / Local State / *.sqlite / edge-profile* ⇒ 4 处「凭证落盘」命中',
        cred.length === 4,
        `命中 ${cred.length} 处：${cred.map((f) => `${f.file}(${f.type})`).join(' ｜ ')}`,
      )
      rec.add(
        G,
        '★★ 全部归入 category=credential_store（一等命中，不是 URL / 外联假阳性）',
        cred.every((f) => f.category === 'credential_store' && f.severity === 'high') &&
          types.has('credential_file') &&
          types.has('browser_profile_dir'),
        JSON.stringify({ categories: [...new Set(cred.map((f) => f.category))], types: [...types] }),
      )
      rec.add(
        G,
        '★★ finding_count 把它算进去（所以 attestation 不可能再是 clean）',
        scan.finding_count === 4 && scan.finding_count === scan.local_leak.findings.length + scan.network.findings.length + cred.length,
        `finding_count=${scan.finding_count}　local=${scan.local_leak.findings.length}　network=${scan.network.findings.length}　cred=${cred.length}`,
      )
      rec.add(
        G,
        '★ 对照：同一批文件在旧的两面（本地泄密 / 网络）里**一个都不报** —— 它确实是新增的第三面',
        scan.local_leak.findings.length === 0 && scan.network.findings.length === 0,
        `local=${scan.local_leak.findings.length} network=${scan.network.findings.length}`,
      )
      rec.add(
        G,
        '★ 普通报告 tester-report.md 不在命中里（只认路径，不误伤普通文件）',
        !cred.some((f) => String(f.file).includes('tester-report.md')),
        cred.map((f) => f.file).join('、'),
      )
      rec.add(
        G,
        '★ profile 目录命中后**不再向下遍历**（files_scanned 只有普通文本那 1 个）',
        scan.scope.files_scanned === 1,
        `files_scanned=${scan.scope.files_scanned}　bytes=${scan.scope.bytes_scanned}`,
      )
      rec.add(
        G,
        '★ 结果里写明边界：凭证库按路径认、不读内容',
        String(scan.credential_store?.boundary ?? '').includes('不读内容'),
        String(scan.credential_store?.boundary ?? '(缺)'),
      )

      const summary = renderScanSummary(scan)
      rec.add(
        G,
        '★★ 摘要出现【凭证落盘】段（不再是"未发现"）',
        summary.includes('【凭证落盘】') && summary.includes('Cookies') && summary.includes('edge-profile-2026'),
        String(summary).split('\n').filter((l) => l.includes('凭证落盘') || l.includes('Cookies') || l.includes('edge-profile')).slice(0, 8).join('\n'),
      )
      rec.add(
        G,
        '★★ 摘要**不回显命中原文**（工具自身不得成为泄密渠道）',
        !summary.includes('FAKE-COOKIE-CONTENT') && !summary.includes('FAKE-LOGIN-DB') && !summary.includes('FAKE-SQLITE'),
        summary.includes('FAKE-') ? '✗✗ 摘要里回显了假凭证原文！' : '摘要里搜不到任何 FAKE- 标记串（只给路径与类型）',
      )
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 8).join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF24BrowserProfileGuardCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
