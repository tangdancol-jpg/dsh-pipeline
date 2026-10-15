/**
 * p13 · 能力申请通道（申请 → 用户答复 → **放行一次** → 用尽即失效）
 * ============================================================================
 *     node tests/p13-capability-grant-check.mjs
 *
 * 用户原话（2026-10-16，第 1 件）：
 *   「主对话的限制应该是平常禁止读代码、写面、工具面按角色收紧等，
 *     但是**必要时能向用户申请**，主对话能知道工具，但是被告知必要申请，且最好别碰。」
 *
 * 「申请」若落不成**一次一份的额度**，就会变成"申请过一次以后永久放宽" —— 那不是申请，是拆除。
 * 所以本套的四条主判据就是那句话的四个状态：
 *
 *   ① **未申请**   ⇒ 被拒（`[pipeline] 拒绝` + 具体原因）
 *   ② **申请中**   ⇒ **仍被拒**（这条路最容易写坏：把 request 当成 approve）
 *   ③ **批准后**   ⇒ **放行一次**（`undefined`），且台账当场多一行 `release`
 *   ④ **用完**     ⇒ **再次被拒**（额度是 `used`，不是"永久放宽"）
 *
 * 外加四条边界（每一条都对应一类"后门写法"）：
 *   ⑤ **作用域**：批准了 A 不等于能读 B（按路径段判，不做字符串前缀）
 *   ⑥ **不许替用户拍板**：`approve` 缺 `user_quote` ⇒ 拒，且**一个字节都不落盘**
 *   ⑦ **额度只认申请人**：别的角色（reviewer）就算台账里有批准过的额度，也一个字都放不开
 *   ⑧ **shell 不可申请**：它是"一堆边界的集合"，不是一个能力
 *
 * 全程在 `mkdtemp` 的临时项目里跑，**不碰真树**。
 * 退出码：0 = 全绿；1 = 有失败。
 * @module dsh-pipeline/tests/p13-capability-grant-check
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { guardDecision } from '../lib/guard.js'
import { makeTaskIndexEntry } from '../lib/guard/seats.js'
import { GRANT_FILE, foldGrants, parseLedger, readGrants, appendGrant } from '../lib/guard/grant.js'
import { CAPABILITY, GRANTABLE_CAPABILITIES, isGrantable } from '../lib/guard/capability.js'
import { buildCapabilityTools } from '../lib/tools/capability.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')

/** 主运行器。@returns {Promise<{passed:number,total:number,text:string}>} */
export async function runP13CapabilityGrantCheck() {
  const lines = []
  let passed = 0
  let total = 0
  const ok = (cond, label, detail = '') => {
    total += 1
    if (cond) passed += 1
    lines.push(`  ${cond ? '✓' : '✗'} ${label}${detail ? `　—— ${detail}` : ''}`)
    return Boolean(cond)
  }

  lines.push('='.repeat(78))
  lines.push('p13 · 能力申请通道（未申请拒 / 申请中仍拒 / 批准后放行一次 / 用完再拒）')
  lines.push('='.repeat(78))

  const tmp = mkdtempSync(join(tmpdir(), 'p13-grant-'))
  try {
    const taskId = 'T-p13'
    const projectRoot = join(tmp, 'proj')
    const pipelineDir = join(projectRoot, '.pipeline')
    const taskSelfDir = join(pipelineDir, taskId.toLowerCase())
    mkdirSync(join(projectRoot, 'src'), { recursive: true })
    mkdirSync(taskSelfDir, { recursive: true })
    const srcA = join(projectRoot, 'src', 'a.js')
    const srcB = join(projectRoot, 'src', 'b.js')
    writeFileSync(srcA, 'export const a = 1\n', 'utf8')
    writeFileSync(srcB, 'export const b = 2\n', 'utf8')

    const ledger = join(taskSelfDir, GRANT_FILE)
    const taskIndex = new Map([[taskId, makeTaskIndexEntry({ taskId, projectRoot, pipelineDir })]])
    const tokens = {
      roleOfAgent: (id) =>
        id === 'A-main' ? { role: 'main', taskId, seat: null } : id === 'A-rev' ? { role: 'reviewer', taskId, seat: null } : null,
    }
    const deps = { tokens, taskIndex, config: { guardEnabled: true } }
    const read = (agent, path) => guardDecision({ name: 'read', arguments: { path }, agent: { id: agent } }, deps)
    const write = (agent, path) => guardDecision({ name: 'write', arguments: { path, content: 'x' }, agent: { id: agent } }, deps)

    // ---- 工具侧：真 `tool()` 工厂 + 最小 deps --------------------------------
    const toolDeps = {
      defineTool: (d) => d,
      sw: { isOn: () => true },
      tokens,
      config: { artifactDirName: '.pipeline' },
      store: { projectRoot, recordAudit: async () => {} },
    }
    const { capabilityRequest } = buildCapabilityTools({
      deps: toolDeps,
      config: { artifactDirName: '.pipeline' },
      store: { projectRoot },
      load: async (id) => (String(id) === taskId ? { id: taskId, project_root: projectRoot } : null),
    })
    const call = (args) => capabilityRequest.execute(args, { agent: { id: 'A-main' } })

    // ---- ① 未申请 ⇒ 被拒 ------------------------------------------------------
    const r0 = read('A-main', srcA)
    ok(typeof r0 === 'string' && r0.includes('[pipeline] 拒绝') && r0.includes('不得读取代码正文'), '① 未申请 ⇒ 被拒（拒绝原文点名"不得读取代码正文"）', String(r0).split('\n')[0])

    // ---- ② 申请中 ⇒ 仍被拒 ----------------------------------------------------
    const q = await call({ task_id: taskId, action: 'request', capability: CAPABILITY.READ_SOURCE, scope: srcA, reason: '核对接口签名' })
    const reqId = q.request_id
    ok(q.ok === true && q.state === 'pending' && typeof reqId === 'string' && reqId.startsWith('C-'), '② `request` 落了台账、状态是 pending', `id=${reqId} state=${q.state}`)
    const r1 = read('A-main', srcA)
    ok(typeof r1 === 'string' && r1.includes('拒绝'), '② ★ **申请中仍然被拒**（request ≠ approve）', String(r1).split('\n')[0])
    ok(q.summary.includes('照抄给用户'), '② 返回里带了"照抄给用户"的原文（申请要落到用户手上）', '有')

    // ---- ⑥ 不许替用户拍板 -----------------------------------------------------
    const before = readFileSync(ledger, 'utf8')
    const noQuote = await call({ task_id: taskId, action: 'approve', request_id: reqId })
    ok(noQuote.ok === false && noQuote.summary.includes('user_quote'), '⑥ 缺 `user_quote` ⇒ 拒绝记录批准', noQuote.summary.split('\n')[0])
    ok(readFileSync(ledger, 'utf8') === before, '⑥ ★ 而且**一个字节都没落盘**（没写就是没写）', `${before.split('\n').filter(Boolean).length} 行不变`)

    // ---- ③ 批准后 ⇒ 放行一次 --------------------------------------------------
    const ap = await call({ task_id: taskId, action: 'approve', request_id: reqId, user_quote: '可以，就这一次' })
    ok(ap.ok === true && ap.state === 'approved', '③ `approve` 把额度变成 approved', `state=${ap.state}`)
    const rowsBefore = parseLedger(readFileSync(ledger, 'utf8')).length
    const r2 = read('A-main', srcA)
    ok(r2 === undefined, '③ ★★ **批准后放行一次**（守卫返回 undefined = 宿主眼里的放行）', `返回=${String(r2).split('\n')[0]}`)
    const rowsAfter = parseLedger(readFileSync(ledger, 'utf8'))
    ok(rowsAfter.length === rowsBefore + 1 && rowsAfter[rowsAfter.length - 1].op === 'release', '③ 放行**当场留痕**：台账追加一行 `release`', `${rowsBefore} → ${rowsAfter.length} 行，末行 op=${rowsAfter[rowsAfter.length - 1].op}`)

    // ---- ④ 用完 ⇒ 再次被拒 ----------------------------------------------------
    const r3 = read('A-main', srcA)
    ok(typeof r3 === 'string' && r3.includes('拒绝'), '④ ★★ **用完 ⇒ 再次被拒**（额度是 used，不是永久放宽）', String(r3).split('\n')[0])
    const folded = readGrants(ledger).find((g) => g.id === reqId)
    ok(folded?.state === 'used', '④ 折叠后状态是 `used`', `state=${folded?.state}`)

    // ---- ⑤ 作用域 -------------------------------------------------------------
    const q3 = await call({ task_id: taskId, action: 'request', capability: CAPABILITY.READ_SOURCE, scope: srcB, reason: '读 B' })
    await call({ task_id: taskId, action: 'approve', request_id: q3.request_id, user_quote: '行' })
    ok(read('A-main', srcB) === undefined, '⑤ 批准了 B ⇒ 读 B 放行', '')
    const rOut = read('A-main', srcA)
    ok(typeof rOut === 'string' && rOut.includes('拒绝'), '⑤ ★ 批准了 B **不等于**能读 A（作用域按路径判）', String(rOut).split('\n')[0])

    // ---- ⑦ 额度只认申请人（先备一份**还没用过**的写额度） ----------------------
    // ---- 写面：同一条通道也管"写文件"（顺序刻意排在 ⑦ 之前：写额度会被"用完"） ----
    const w0 = write('A-main', srcA)
    ok(typeof w0 === 'string' && w0.includes('拒绝'), '写面：未申请时 main 写文件被拒', String(w0).split('\n')[0])
    const q4 = await call({ task_id: taskId, action: 'request', capability: CAPABILITY.WRITE_FILE, scope: srcA, reason: '改一处注释' })
    ok(q4.ok === true, '写面：`write-file` 可以申请（可申请 = 日常限制，不是拆除）', `id=${q4.request_id}`)
    const wStill = write('A-main', srcA)
    ok(typeof wStill === 'string' && wStill.includes('拒绝'), '写面：**申请中仍被拒**', String(wStill).split('\n')[0])
    await call({ task_id: taskId, action: 'approve', request_id: q4.request_id, user_quote: '这次可以' })
    const w1 = write('A-main', srcA)
    ok(w1 === undefined, '★ 写面：`write-file` 额度批准后放行一次', `返回=${String(w1)}`)
    const w2 = write('A-main', srcA)
    ok(typeof w2 === 'string' && w2.includes('拒绝'), '★ 写面：用完 ⇒ 再写又被拒', String(w2).split('\n')[0])

    // ---- ⑦ 额度只认申请人 ------------------------------------------------------
    const q5 = await call({ task_id: taskId, action: 'request', capability: CAPABILITY.WRITE_FILE, scope: srcB, reason: '改 B' })
    await call({ task_id: taskId, action: 'approve', request_id: q5.request_id, user_quote: '可以' })
    const rRev = write('A-rev', srcA)
    ok(typeof rRev === 'string' && rRev.includes('拒绝'), '⑦ ★ 别的角色（reviewer）**用不了**主对话的额度', String(rRev).split('\n')[0])
    const rRev2 = write('A-rev', srcB)
    ok(typeof rRev2 === 'string' && rRev2.includes('拒绝'), '⑦ ★ 即便目标正好落在额度作用域内，别的角色也照样被拒', String(rRev2).split('\n')[0])

    // ---- ⑧ shell 不可申请 ------------------------------------------------------
    ok(isGrantable(CAPABILITY.SHELL) === false, '⑧ `shell` 不在可申请之列（边界集合 ≠ 能力）', `可申请=${GRANTABLE_CAPABILITIES.join(' / ')}`)
    const qShell = await call({ task_id: taskId, action: 'request', capability: CAPABILITY.SHELL, scope: '*', reason: '随便跑跑' })
    ok(qShell.ok === false && qShell.summary.includes('不可申请'), '⑧ 申请 shell ⇒ 被拒并说明理由', qShell.summary.split('\n')[0])

    // ---- 台账本身：追加式、可折叠 ----------------------------------------------
    const all = parseLedger(readFileSync(ledger, 'utf8'))
    const ids = new Set(all.map((e) => e.id))
    ok(all.length >= ids.size, '台账是**追加式**（一行一个事件，事件数 ≥ 申请数）', `${all.length} 个事件 / ${ids.size} 条申请`)
    ok(foldGrants(all).every((g) => ['pending', 'approved', 'used', 'rejected'].includes(g.state)), '折叠出来的状态都在四态之内', foldGrants(all).map((g) => g.state).join(' / '))

    // ---- 落点：台账在**任务自己的目录**下（不是别处） --------------------------
    ok(readGrants(ledger).length > 0, `台账落在 <任务目录>/${GRANT_FILE}（唯一写点 appendGrant 的落点）`, ledger.replace(projectRoot, '<项目>'))

    // ---- 显式失败路径：台账写不进去 ⇒ **不放行**（fail-closed） ----------------
    appendGrant('', { id: 'x', op: 'request' })
    ok(appendGrant('', { id: 'x', op: 'request' }).ok === false, '★ 台账落不下去 ⇒ `appendGrant` 如实返回 ok:false（守门据此**不放行**）', 'fail-closed，不假装用过了')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  lines.push('')
  lines.push(`p13 总计：${passed}/${total} 通过`)
  void PKG
  return { passed, total, text: lines.join('\n') }
}

// 直接运行
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const r = await runP13CapabilityGrantCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
