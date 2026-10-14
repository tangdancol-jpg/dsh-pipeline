/**
 * dsh-pipeline · 缺陷 ④：测试席位的"允许扩展名"里没有可执行脚本
 * ============================================================================
 *     node tests/f4-tester-exts-check.mjs
 *
 * 真机现场（T-20261015-bb30bc）：测试席位要写一份**可运行的用例/探针**
 * （`tester-cases.mjs`）被守门拒 —— `own-dir` 的允许面只有 `log/jsonl/md/json/txt`，
 * 可执行扩展名一个都不在，它只能退回"把用例塞进 stdin 管道"这条别扭的路。
 *
 * 本套钉住四件事：
 *   A. 允许面**确实补上了** `mjs` / `cjs` / `js`（且旧的那五个一个没丢）；
 *   B. 端到端：测试席位写 `reports/tester/tester-cases.mjs` ⇒ **放行**；
 *   C. **没有放宽**：写出自己那一格（别的角色目录 / 项目源码 / 别的扩展名）⇒ 照旧拒；
 *   D. 拒绝文案给出**可行替代**（缺陷口径的第二半："要么扩充允许面，要么给替代路径"——
 *      两条都做了：既扩充了，也在文案里写清换哪个扩展名 / 走哪条路）。
 *
 * ★ 全程密闭：项目根是自造的临时目录，不读任何活体真单。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { guardDecision, makeTaskIndexEntry, OWN_DIR_EXTS, OWN_LOG_EXTS } from '../lib/guard.js'
import { EXECUTABLE_EXTS, ownPathHint } from '../lib/guard/page-exts.js'
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
      const L = ['dsh-pipeline · 缺陷 ④：测试席位的允许扩展名缺可执行脚本', '='.repeat(78)]
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

export async function runF4TesterExtsCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f4-'))
  try {
    // ------------------------------------------------------------ A 允许面
    const G1 = 'A 允许面：可执行扩展名补进来了，旧的没丢'
    rec.add(G1, '★★ `mjs` / `cjs` / `js` 都在 `own-dir` 允许面里', EXECUTABLE_EXTS.every((e) => OWN_DIR_EXTS.includes(e)), OWN_DIR_EXTS.join(' | '))
    rec.add(G1, '★ 旧的五个（log / jsonl / md / json / txt）一个没丢', ['log', 'jsonl', 'md', 'json', 'txt'].every((e) => OWN_DIR_EXTS.includes(e)), OWN_DIR_EXTS.join(' | '))
    rec.add(G1, '★ 审核（`own-log`）**仍然只有日志** —— 这一档没被顺手放宽', OWN_LOG_EXTS.length === 2 && OWN_LOG_EXTS.includes('log') && OWN_LOG_EXTS.includes('jsonl') && !OWN_LOG_EXTS.includes('mjs'), OWN_LOG_EXTS.join(' | '))

    // ------------------------------------------------------------ B/C 端到端
    const testerDir = join(root, '.pipeline', 'T-F4', 'reports', 'tester')
    const reviewerDir = join(root, '.pipeline', 'T-F4', 'reports', 'reviewer')
    mkdirSync(testerDir, { recursive: true })
    mkdirSync(reviewerDir, { recursive: true })
    mkdirSync(join(root, 'src'), { recursive: true })

    let clock = 1000
    const tokens = createTokenStore({ now: () => clock })
    tokens.mint({ taskId: 'T-F4', role: 'tester', agentId: 'tester-session' })
    tokens.mint({ taskId: 'T-F4', role: 'reviewer', agentId: 'reviewer-session' })
    const index = new Map([
      ['T-F4', makeTaskIndexEntry({ taskId: 'T-F4', projectRoot: root, pipelineDir: join(root, '.pipeline') })],
    ])
    const decide = (agent, args, name = 'write') =>
      guardDecision({ name, arguments: args, agent: { id: agent } }, { tokens, taskIndex: index, config: {} })

    const G2 = 'B 端到端：测试席位写可执行用例 ⇒ 放行'
    const okMjs = decide('tester-session', { file_path: join(testerDir, 'tester-cases.mjs'), content: 'export const cases = []\n' })
    rec.add(G2, '★★ 现场形状：`reports/tester/tester-cases.mjs` ⇒ **放行**', okMjs === undefined, first(okMjs))
    for (const ext of ['cjs', 'js']) {
      const r = decide('tester-session', { file_path: join(testerDir, `tester-probe.${ext}`), content: 'module.exports = {}\n' })
      rec.add(G2, `★ \`.${ext}\` 同样放行`, r === undefined, first(r))
    }
    rec.add(G2, '★ 旧的产物形状照旧放行（回归对照）', decide('tester-session', { file_path: join(testerDir, 'tester-report.md'), content: '# 报告\n' }) === undefined, '')
    rec.add(G2, '★ 审核席位写自己的日志照旧放行（回归对照）', decide('reviewer-session', { file_path: join(reviewerDir, 'reviewer-verify.log'), content: 'ok\n' }) === undefined, '')

    const G3 = 'C 没有放宽：出自己那一格 / 别的扩展名，照旧拒'
    const outDir = decide('tester-session', { file_path: join(reviewerDir, 'tester-x.mjs'), content: 'x\n' })
    rec.add(G3, '★ 反例：测试席位写**别人的**目录 ⇒ 照旧拒', typeof outDir === 'string' && outDir.includes('只能写'), first(outDir))
    const src = decide('tester-session', { file_path: join(root, 'src', 'a.mjs'), content: 'x\n' })
    rec.add(G3, '★ 反例：测试席位写**项目源码** ⇒ 照旧拒（三权分立一个字没动）', typeof src === 'string', first(src))
    const badExt = decide('tester-session', { file_path: join(testerDir, 'tester-cases.exe'), content: 'x\n' })
    rec.add(G3, '★ 反例：`own-dir` 之外的新扩展名（`.exe`）仍然拒 —— 扩充不是"什么都行"', typeof badExt === 'string' && badExt.includes('只能写'), first(badExt))
    const logMjs = decide('reviewer-session', { file_path: join(reviewerDir, 'reviewer-cases.mjs'), content: 'x\n' })
    rec.add(G3, '★ 反例：审核（`own-log`）写 `.mjs` 仍然拒 —— 只给测试那一档扩了', typeof logMjs === 'string' && logMjs.includes('只能写'), first(logMjs))

    // ------------------------------------------------------------ D 替代路径
    const G4 = 'D 拒绝文案给出**可行替代**（缺陷口径的第二半）'
    rec.add(G4, '★★ 拒 `.exe` 时文案直接写出"可以换哪些扩展名"', typeof badExt === 'string' && badExt.includes('mjs / cjs / js'), String(badExt).split('\n').filter((l) => l.includes('换个扩展名')).join('\n'))
    rec.add(G4, '★ 文案还给出"不想落文件就走 stdin 管道"这条路', typeof badExt === 'string' && badExt.includes('stdin'), '')
    rec.add(G4, '★ `own-log` 的文案额外说明"你只能写日志，要交结论用 pipeline_handoff"', typeof logMjs === 'string' && logMjs.includes('pipeline_handoff'), '')
    rec.add(G4, '`ownPathHint()` 对未知扩展名会给两条出路；对合法扩展名只回允许面', ownPathHint({ role: 'tester', cls: 'own-dir', dir: 'X/', base: 'tester-a.mjs' }).includes('换') === false && ownPathHint({ role: 'tester', cls: 'own-dir', dir: 'X/', base: 'tester-a.exe' }).includes('换个扩展名'), '')
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF4TesterExtsCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
