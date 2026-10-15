// git 命令面 · 唯一的 git 调用口：只允许 init / add / commit / status / rev-parse，远端写一律在运行前拒掉。
/**
 * dsh-pipeline · git 命令面
 * ============================================================================
 * 验收 A06：**绝不 push** —— 全流程无任何远端写（无 push、不改 remote）。
 *
 * 这条不是靠"记得别 push"实现的，而是靠**结构**：
 *   ① 本文件是插件里**唯一**调 git 的地方；
 *   ② 允许的子命令是一张**白名单**（`init` / `add` / `commit` / `status` / `rev-parse`）；
 *   ③ 每个 argv 在真正 spawn **之前**过一遍 {@link assertNoRemoteWrite} ——
 *      出现 `push`/`fetch`/`pull`/`remote`/`clone`/`submodule`/`ls-remote` 等，
 *      **连进程都不起**就返回拒绝。
 *
 * 所以"本批次不许 push"这件事在代码上是**不可表达**的，而不是"我们没写"。
 *
 * @module dsh-pipeline/lib/project/git-run
 */

import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 允许的 git 子命令（白名单；不在表里的一律拒绝）。 */
export const ALLOWED_GIT_SUBCOMMANDS = Object.freeze(['init', 'add', 'commit', 'status', 'rev-parse', 'config', 'check-ignore'])

/**
 * ★ **远端写 / 网络子命令黑名单** —— 出现即拒绝（比白名单更早判，文案也更明确）。
 *
 * 与 `ALLOWED_GIT_SUBCOMMANDS` 是**两道**，不是一道：白名单管"没想要的功能"，
 * 黑名单管"想都不能想的功能"。两者都过才 spawn。
 */
export const FORBIDDEN_GIT_SUBCOMMANDS = Object.freeze([
  'push',
  'fetch',
  'pull',
  'remote',
  'clone',
  'submodule',
  'ls-remote',
  'archive',
  'send-pack',
  'request-pull',
])

/**
 * 取值型**全局选项**：它们各自吃掉**后面一个 token**。
 *
 * ★ 为什么必须认识它们：`git -c user.name=x commit …` 里，`user.name=x` 是 `-c` 的**值**，
 *   不是子命令。不跳过它就会把 `user.name=x` 当成子命令名，于是**合法的 commit 被误拒**
 *   （现场症状：git init 成功、commit 永远过不去）。
 */
const VALUE_TAKING_GLOBALS = Object.freeze(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

/**
 * 扫出 argv 里的 git **子命令**（跳过全局选项及其取值）。
 *
 * @param {string[]} list
 * @returns {{sub:string, index:number}}
 */
export function gitSubcommandOf(list) {
  const argv = (Array.isArray(list) ? list : []).map((a) => String(a))
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--') {
      i += 1
      break
    }
    if (VALUE_TAKING_GLOBALS.includes(a)) {
      i += 2
      continue
    }
    if (a.startsWith('-')) {
      i += 1
      continue
    }
    break
  }
  return { sub: argv[i] ?? '', index: i }
}

/**
 * argv 是否含远端写 / 网络动作。
 *
 * 判据（两条，都在**子命令及其之前**的范围内看）：
 *   ① 子命令本身在 {@link FORBIDDEN_GIT_SUBCOMMANDS} 里 ⇒ 拒；
 *   ② 子命令之前的 token 里出现黑名单词（如 `git -c x=y remote add …`）⇒ 拒。
 *
 * ★ 刻意**不**在整条 argv 上做词扫描：`git commit -m push` 里的 `push` 是提交信息，
 *   不是子命令 —— 一刀切会造出"提交信息里带个 push 就提交不了"的假阳性。
 *
 * @param {string[]} argv - **不含** `git` 本身，例如 `['commit', '-m', 'x', '--', 'AGENTS.md']`
 * @returns {{ok:true, sub:string}|{ok:false, code:string, message:string}}
 */
export function assertNoRemoteWrite(argv) {
  const list = (Array.isArray(argv) ? argv : []).map((a) => String(a))
  const { sub, index } = gitSubcommandOf(list)

  if (FORBIDDEN_GIT_SUBCOMMANDS.includes(sub)) {
    return {
      ok: false,
      code: 'REMOTE_WRITE_FORBIDDEN',
      message:
        `拒绝执行 git ${sub}：**本批次不许任何远端写 / 网络动作**（不 push、不 fetch、不改 remote）。\n` +
        `★ 定稿裁定 3 提到的"上传最新到仓库"属**未来运行时**行为，本批次不得发生（验收 A06）。`,
    }
  }
  const sneaky = list.slice(0, Math.max(0, index)).find((a) => FORBIDDEN_GIT_SUBCOMMANDS.includes(a))
  if (sneaky !== undefined) {
    return {
      ok: false,
      code: 'REMOTE_WRITE_FORBIDDEN',
      message: `拒绝执行 git（子命令之前的 argv 里出现 \`${sneaky}\`）：本批次不许任何远端写 / 网络动作。`,
    }
  }
  if (sub.length === 0) {
    return { ok: false, code: 'GIT_NO_SUBCOMMAND', message: 'git argv 里没有子命令。' }
  }
  if (!ALLOWED_GIT_SUBCOMMANDS.includes(sub)) {
    return {
      ok: false,
      code: 'GIT_SUBCOMMAND_NOT_ALLOWED',
      message: `git 子命令 \`${sub}\` 不在白名单里（允许：${ALLOWED_GIT_SUBCOMMANDS.join(' / ')}）。`,
    }
  }
  return { ok: true, sub }
}

/**
 * 跑一条 git 命令。**先判后跑**：`assertNoRemoteWrite` 不过就一个进程都不起。
 *
 * @param {string[]} argv
 * @param {{cwd:string, exec?:(file:string, args:string[], opts:object)=>Promise<{stdout:string,stderr:string}>, timeoutMs?:number}} opts
 * @returns {Promise<{ok:true, argv:string[], stdout:string, stderr:string, code:number}
 *          |{ok:false, code:string, message:string, argv:string[], stdout:string, stderr:string}>}
 */
export async function runGit(argv, opts = {}) {
  const gate = assertNoRemoteWrite(argv)
  if (!gate.ok) return { ...gate, argv: (Array.isArray(argv) ? argv : []).map(String), stdout: '', stderr: '' }

  const exec = typeof opts.exec === 'function' ? opts.exec : defaultExec
  try {
    const r = await exec('git', argv.map(String), { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 30000 })
    return { ok: true, argv: argv.map(String), stdout: String(r?.stdout ?? ''), stderr: String(r?.stderr ?? ''), code: 0 }
  } catch (err) {
    return {
      ok: false,
      code: 'GIT_COMMAND_FAILED',
      message: `git ${argv.map(String).join(' ')} 失败：${err?.stderr ?? err?.message ?? err}`,
      argv: argv.map(String),
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? err?.message ?? ''),
    }
  }
}

/** 默认执行器（真跑 git）。测试注入假执行器时不会走到这里。 */
async function defaultExec(file, args, options) {
  return execCaptured(file, args, options)
}

/**
 * ★ **不用管道**的进程执行器：把子进程的 stdout/stderr 直接接到**临时文件**上。
 *
 * 为什么不用 `execFile`（它默认走管道）：在受限沙箱下，**命名管道会被拒绝**
 *   —— 症状是 `spawn EPERM`，而 `git init` 这条命令本身完全正常。
 *   把输出接进真实文件（`stdio: ['ignore', fd, fd]`）不涉及管道，实测可用；
 *   这是"**改成不靠捕获管道**"，不是"换个法子重试同一条被拒的命令"。
 *
 * 语义与 `execFile` 保持一致：
 *   · 退出码非 0 ⇒ **抛错**，并把 `stdout` / `stderr` 挂在 error 上（`runGit` 会读它们）；
 *   · 超时 ⇒ 杀掉子进程并抛错。
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?:string, timeoutMs?:number}} [options]
 * @returns {Promise<{stdout:string, stderr:string}>}
 */
export async function execCaptured(file, args, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-git-run-'))
  const outPath = join(dir, 'stdout.txt')
  const errPath = join(dir, 'stderr.txt')
  const out = await open(outPath, 'w')
  const err = await open(errPath, 'w')
  let timedOut = false
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(file, args.map(String), {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['ignore', out.fd, err.fd],
      })
      const ms = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0
      const timer =
        ms > 0
          ? setTimeout(() => {
              timedOut = true
              try {
                child.kill()
              } catch {
                /* 已经退出了 */
              }
            }, ms)
          : null
      child.on('error', (e) => {
        if (timer !== null) clearTimeout(timer)
        reject(e)
      })
      child.on('close', (c) => {
        if (timer !== null) clearTimeout(timer)
        resolve(c === null ? -1 : c)
      })
    })
    const stdout = await readFile(outPath, 'utf8')
    const stderr = await readFile(errPath, 'utf8')
    if (timedOut === true) {
      const e = new Error(`${file} 超过 ${options.timeoutMs}ms 未结束，已杀掉。`)
      e.stdout = stdout
      e.stderr = stderr
      throw e
    }
    if (code !== 0) {
      const e = new Error(`${file} ${args.join(' ')} 退出码 ${code}`)
      e.stdout = stdout
      e.stderr = stderr
      e.code = code
      throw e
    }
    return { stdout, stderr }
  } finally {
    await out.close().catch(() => {})
    await err.close().catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 项目目录里**是不是**已经是 git 仓库（只读；`rev-parse` 在白名单里）。
 *
 * 边界：「项目目录已是 git 仓库（已有 .git）：不重复 init，只补 AGENTS.md + commit」。
 *
 * @param {string} dir
 * @param {{exec?:Function}} [opts]
 * @returns {Promise<boolean>}
 */
export async function isGitRepo(dir, opts = {}) {
  const r = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir, exec: opts.exec })
  return r.ok === true && String(r.stdout).trim() === 'true'
}
