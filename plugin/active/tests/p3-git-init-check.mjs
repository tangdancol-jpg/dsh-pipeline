/**
 * p3 · git 化闸门：未确认不开仓库 / 确认后 init+commit / **绝不 push**
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/p3-git-init-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（已登记，见 `WIRING.md` §W8）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * 覆盖的验收：A04（未确认不产生 .git、确认动作留痕）、A05（确认后 init + AGENTS.md + commit 成功）、
 *   A06（**绝不 push / 无远端写**），以及边界「已是 git 仓库 ⇒ 不重复 init」
 *   「工作区有他人未提交改动 ⇒ 首次 commit 只含本次动作产生的文件」。
 *
 * @module dsh-pipeline/tests/p3-git-init-check
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ALLOWED_GIT_SUBCOMMANDS,
  FORBIDDEN_GIT_SUBCOMMANDS,
  assertNoRemoteWrite,
  execCaptured,
  runGit,
} from '../lib/project/git-run.js'
import { checkGitConfirmation, gitConfirmationRecord, gitInitProject } from '../lib/project/git-init.js'

// ---------------------------------------------------------------------------
// 极简断言
// ---------------------------------------------------------------------------
let passed = 0
let failed = 0
const lines = []

function ok(cond, title, detail = '') {
  if (cond) {
    passed += 1
    lines.push(`  ✓ ${title}`)
    if (detail.length > 0) lines.push(`      ${detail}`)
  } else {
    failed += 1
    lines.push(`  ✗ ${title}`)
    if (detail.length > 0) lines.push(`      ${detail}`)
  }
}

function eq(actual, expected, title) {
  ok(actual === expected, title, `期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`)
}

/**
 * ★ 测试**自己**直接跑 git（**故意绕过**模块白名单）—— 用来"取证"而非"使用"。
 *
 * 走 `execCaptured`（文件承载输出，不用管道）：受限沙箱下管道会被拒（`spawn EPERM`），
 * 而这里要的是"真的去仓库里看一眼有没有 remote"，不是复用被测代码的判断。
 */
async function rawGit(dir, args) {
  try {
    const { stdout } = await execCaptured('git', args, { cwd: dir, timeoutMs: 20000 })
    return stdout.trim()
  } catch (err) {
    return `__FAIL__ ${err?.stderr ?? err?.message ?? err}`
  }
}

/** 假执行器：只记录，不起进程。 */
function spyExec() {
  const calls = []
  const exec = async (file, args) => {
    calls.push([file, ...args])
    return { stdout: '', stderr: '' }
  }
  return { exec, calls }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-p3-'))

  lines.push('='.repeat(78))
  lines.push('p3 · git 化闸门：未确认不开仓库 / 确认后 init+commit / 绝不 push')
  lines.push('='.repeat(78))

  // ---- ① 白名单 / 黑名单本身 -------------------------------------------------
  lines.push('')
  lines.push('【① 结构上不可表达：远端写子命令连进程都起不来（A06）】')
  for (const sub of FORBIDDEN_GIT_SUBCOMMANDS) {
    const r = assertNoRemoteWrite([sub])
    ok(r.ok === false && r.code === 'REMOTE_WRITE_FORBIDDEN', `git ${sub} 在运行前就被拒`, r.ok ? '' : r.code)
  }
  ok(ALLOWED_GIT_SUBCOMMANDS.includes('init') && ALLOWED_GIT_SUBCOMMANDS.includes('commit'), '白名单里有 init / commit')
  ok(!ALLOWED_GIT_SUBCOMMANDS.includes('push') && !ALLOWED_GIT_SUBCOMMANDS.includes('remote'), '白名单里**没有** push / remote')
  const notAllowed = assertNoRemoteWrite(['rebase'])
  ok(notAllowed.ok === false && notAllowed.code === 'GIT_SUBCOMMAND_NOT_ALLOWED', '白名单外的子命令也被拒（rebase）')
  const sneaky = assertNoRemoteWrite(['-c', 'x=y', 'remote', 'add', 'origin', 'http://x'])
  ok(sneaky.ok === false, '★ 藏在 `-c` 后面的 remote 也拦得住', sneaky.code)

  const spy0 = spyExec()
  const refused = await runGit(['push', 'origin', 'main'], { cwd: root, exec: spy0.exec })
  ok(refused.ok === false && refused.code === 'REMOTE_WRITE_FORBIDDEN', 'runGit(["push"]) 被拒')
  eq(spy0.calls.length, 0, '★ **一次进程都没起**（假执行器零调用）')

  // ---- ② 未确认 ⇒ 不开仓库、不产生 .git、一个进程都不起 ----------------------
  lines.push('')
  lines.push('【② 未确认 ⇒ 拒绝，且**没有产生 .git**（A04）】')
  const dirA = join(root, 'proj-a')
  await mkdir(dirA, { recursive: true })
  const gate = checkGitConfirmation({ confirmed: false })
  ok(gate.ok === false && gate.code === 'GIT_NOT_CONFIRMED', '闸门拒绝（GIT_NOT_CONFIRMED）', gate.message.split('\n')[0])
  const spyA = spyExec()
  const noConfirm = await gitInitProject({ dir: dirA, confirmed: false, exec: spyA.exec })
  ok(noConfirm.ok === false && noConfirm.code === 'GIT_NOT_CONFIRMED', 'gitInitProject 未确认被拒')
  eq(noConfirm.inited, false, 'inited=false')
  eq(noConfirm.committed, false, 'committed=false')
  eq(spyA.calls.length, 0, '★ **一次 git 进程都没起**')
  ok(!existsSync(join(dirA, '.git')), '★ 目录里**没有** .git')
  const noConfirmDefault = await gitInitProject({ dir: dirA })
  ok(noConfirmDefault.ok === false && noConfirmDefault.code === 'GIT_NOT_CONFIRMED', '连 git 参数都不给也拒（默认不开）')

  // ---- ③ 确认后 ⇒ init + AGENTS.md + 首次 commit（真 git）--------------------
  lines.push('')
  lines.push('【③ 确认后 ⇒ git init + AGENTS.md + 首次 commit（A05，真 git）】')
  const dirB = join(root, 'proj-b')
  await mkdir(dirB, { recursive: true })
  const agentsMd = join(dirB, 'AGENTS.md')
  await writeFile(agentsMd, '# AGENTS\n\n两条纪律……\n', 'utf8')
  const confirmed = await gitInitProject({ dir: dirB, confirmed: true, agentsMdFile: agentsMd, message: 'chore: init repo' })
  ok(confirmed.ok === true, '确认后成功', confirmed.ok ? '' : confirmed.message)
  eq(confirmed.inited, true, 'inited=true')
  eq(confirmed.committed, true, 'committed=true')
  ok(existsSync(join(dirB, '.git')), '★ .git 真的出现了')
  ok(typeof confirmed.commitMessage === 'string' && confirmed.commitMessage.trim().length > 0, '提交信息非空', confirmed.commitMessage)
  const log = await rawGit(dirB, ['log', '--oneline'])
  ok(log.split('\n').filter((l) => l.trim().length > 0).length === 1, '恰好 1 个 commit', log)
  const filesInCommit = await rawGit(dirB, ['show', '--name-only', '--pretty=format:', 'HEAD'])
  ok(filesInCommit.split('\n').map((s) => s.trim()).filter((s) => s.length > 0).includes('AGENTS.md'), 'commit 里含 AGENTS.md', filesInCommit)
  eq(confirmed.remoteUntouched, true, 'remote_untouched=true')

  // ---- ④ 断言无远端写（A06）-------------------------------------------------
  lines.push('')
  lines.push('【④ ★ 断言无远端写：没有 remote、没有 push（A06）】')
  const remotes = await rawGit(dirB, ['remote', '-v'])
  eq(remotes, '', '★ `git remote -v` **输出为空**（一个远端都没配）')
  const cfgRemote = await rawGit(dirB, ['config', '--get-regexp', '^remote\\.'])
  ok(cfgRemote.startsWith('__FAIL__') || cfgRemote === '', '★ 仓库 config 里**没有任何 remote.* 配置**', cfgRemote)
  const reflog = await rawGit(dirB, ['reflog'])
  ok(!/push|fetch/i.test(reflog), '★ reflog 里**没有** push / fetch 痕迹')
  const allArgv = confirmed.argv ?? []
  ok(allArgv.length > 0, '模块实际用过的 argv 都被记下来了', JSON.stringify(allArgv))
  const everyArgvClean = allArgv.every((a) => assertNoRemoteWrite(a).ok === true)
  ok(everyArgvClean, '★ 模块用过的**每一条 argv** 都过得了 `assertNoRemoteWrite`')

  // ---- ⑤ 边界：已是仓库 ⇒ 不重复 init，只补 commit ---------------------------
  lines.push('')
  lines.push('【⑤ 边界：已是 git 仓库 ⇒ 不重复 init】')
  const headBefore = await rawGit(dirB, ['rev-parse', 'HEAD'])
  await writeFile(agentsMd, '# AGENTS\n\n两条纪律……（补一段）\n', 'utf8')
  const again = await gitInitProject({ dir: dirB, confirmed: true, agentsMdFile: agentsMd, message: 'chore: complete AGENTS.md' })
  ok(again.ok === true, '第二次成功', again.ok ? '' : again.message)
  eq(again.inited, false, 'inited=false（**没有**重复 init）')
  eq(again.alreadyRepo, true, 'alreadyRepo=true')
  eq(again.committed, true, '仍然补上了 commit')
  const headAfter = await rawGit(dirB, ['rev-parse', 'HEAD'])
  ok(headAfter !== headBefore, 'HEAD 前进了（新 commit 确实落了）')

  // ---- ⑥ 边界：不吞并他人未提交改动 ------------------------------------------
  lines.push('')
  lines.push('【⑥ 边界：工作区有他人未提交改动 ⇒ 首次 commit 只含本次动作产生的文件】')
  const dirC = join(root, 'proj-c')
  await mkdir(dirC, { recursive: true })
  const mdC = join(dirC, 'AGENTS.md')
  await writeFile(mdC, '# AGENTS\n', 'utf8')
  await writeFile(join(dirC, 'someone-else.txt'), 'not mine', 'utf8')
  await writeFile(join(dirC, 'existing.txt'), 'v1', 'utf8')
  const firstC = await gitInitProject({ dir: dirC, confirmed: true, agentsMdFile: mdC, message: 'chore: init with agents.md' })
  ok(firstC.ok === true, '建仓 + 首次 commit 成功', firstC.ok ? '' : firstC.message)
  const cFiles = (await rawGit(dirC, ['show', '--name-only', '--pretty=format:', 'HEAD'])).split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
  ok(cFiles.includes('AGENTS.md'), 'commit 里有 AGENTS.md', JSON.stringify(cFiles))
  ok(!cFiles.includes('someone-else.txt'), '★ commit 里**没有**别人的未跟踪文件')
  ok(!cFiles.includes('existing.txt'), '★ commit 里**没有**别的既有文件')
  const statusC = await rawGit(dirC, ['status', '--porcelain'])
  ok(statusC.includes('?? someone-else.txt'), '★ 别人的文件仍是"未跟踪"（没被顺手提交掉）', statusC)

  // ---- ⑦ 提交信息不能为空 ----------------------------------------------------
  lines.push('')
  lines.push('【⑦ 提交信息为空 ⇒ 拒绝】')
  const dirD = join(root, 'proj-d')
  await mkdir(dirD, { recursive: true })
  const emptyMsg = await gitInitProject({ dir: dirD, confirmed: true, message: '   ' })
  ok(emptyMsg.ok === false && emptyMsg.code === 'EMPTY_COMMIT_MESSAGE', '空提交信息被拒')

  // ---- ⑧ 确认动作留痕（A04）-------------------------------------------------
  lines.push('')
  lines.push('【⑧ 确认动作留痕（A04）】')
  const rec = gitConfirmationRecord({
    taskId: 'T-20261016-aaaaaa',
    actorRole: 'main',
    actorAgentId: 'agent-1',
    confirmed: true,
    reason: '用户同意给这个项目开仓库',
    at: new Date(Date.UTC(2026, 9, 15, 12, 0, 0)),
  })
  eq(rec.kind, 'project_git_confirm', '记录类型 = project_git_confirm')
  eq(rec.confirmed, true, '记下了"确认开"')
  eq(rec.task_id, 'T-20261016-aaaaaa', '记下了是哪张单')
  eq(rec.actor_role, 'main', '记下了是谁确认的')
  eq(rec.at, '2026-10-15T12:00:00Z', '记下了时刻')
  ok(rec.reason.length > 0, '记下了理由')
  const recNo = gitConfirmationRecord({ taskId: 'T-1', actorRole: 'main', confirmed: false })
  ok(recNo.confirmed === false && /不开/.test(recNo.note), '"确认不开"也留痕（不是只有开才记）')

  await rm(root, { recursive: true, force: true })

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`p3 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))

  return { passed, total: passed + failed, text: lines.join('\n') }
}

/**
 * ★ 聚合跑入口（`tests/run-all.mjs` 登记用 —— `WIRING.md` §W8 的"前置改动"）。
 *
 * 与"直接跑"的区别只有两条：**不 `process.exit`**、把原始输出**收进 `text`** ——
 * 断言、计数、清理临时目录走的**完全是同一条路径**（所以登记不会改变被测行为）。
 *
 * ★ 每次调用先把三份模块级状态清零：聚合跑里同一模块只 import 一次，
 *   但清零是"重复调用不累加"的硬保证 —— 累加出来的通过率就是假绿。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runP3GitInitCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ p3 运行失败（异常）：${err?.stack ?? err}`)
    // ★ 异常本身也算一次失败：崩了不能反而少一条，那会让通过率虚高。
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

// 直接跑：`node tests/p3-git-init-check.mjs` —— 行为与登记前逐字一致（打印原文 + 退出码，git 化）。
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('p3-git-init-check.mjs')) {
  const r = await runP3GitInitCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
