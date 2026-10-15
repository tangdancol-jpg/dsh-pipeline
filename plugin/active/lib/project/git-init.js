// 项目仓库 · git 化闸门：**未显式确认绝不开仓库**；确认后 init + AGENTS.md + 首次 commit，且绝不 push。
/**
 * dsh-pipeline · 项目仓库 · git 化闸门与首次提交
 * ============================================================================
 * 裁定 11：「**一个项目一个仓库**；**主对话先行确认**是否开仓库。」
 * 裁定 D3：「建目录随开单幂等自动完成（无副作用）；**git 化必须显式确认**。」
 *
 * ---------------------------------------------------------------------------
 * 本文件是那条"必须显式确认"的**唯一落点**
 * ---------------------------------------------------------------------------
 *   · `confirmed !== true` ⇒ **返回拒绝，且一个 git 进程都不起**（`.git` 不会出现）；
 *   · `confirmed === true` ⇒ `git init`（已是仓库则跳过）+ 只把**本次动作产生的文件**
 *     加进首次 commit（边界：「首次 commit 只含本次动作产生的文件，不吞并既有改动」）；
 *   · 任何一步都不会走到 push/fetch/remote —— 那在 `git-run.js` 里**根本不可表达**。
 *
 * @module dsh-pipeline/lib/project/git-init
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { AGENTS_MD } from './layout.js'
import { isGitRepo, runGit } from './git-run.js'

/** 默认提交信息（非空是硬要求 —— 验收 A05 要求「提交信息非空」）。 */
export const DEFAULT_COMMIT_MESSAGE = 'chore(project): init project repo with AGENTS.md'

/**
 * 自动化提交用的身份（**只对本次命令生效**，不写进仓库 config —— `git -c` 是进程级配置）。
 *
 * 为什么要给：`.git` 刚 init 出来时全局 `user.name` / `user.email` 常常没配，
 * 那时 `git commit` 会直接失败 —— 于是"确认后首次 commit 成功"（A05）就变成看运气。
 */
export const COMMIT_IDENTITY = Object.freeze({ name: 'dsh-pipeline', email: 'dsh-pipeline@localhost' })

/**
 * ★ **闸门**：没有显式确认，就绝不开仓库。
 *
 * @param {object} input
 * @param {boolean} input.confirmed - 主对话**显式**给的值（`pipeline_project_init { git: true }`）
 * @returns {{ok:true, confirmed:true}|{ok:false, code:string, message:string}}
 */
export function checkGitConfirmation(input = {}) {
  if (input.confirmed === true) return { ok: true, confirmed: true }
  return {
    ok: false,
    code: 'GIT_NOT_CONFIRMED',
    message:
      '拒绝开仓库：**没有拿到主对话的显式确认**（需要 `pipeline_project_init { git: true }`）。\n' +
      '★ 裁定 11：一个项目一个仓库，**主对话先行确认**是否开仓库；裁定 D3：git 化必须显式确认。\n' +
      '★ 本次调用**没有产生 `.git`**，也没有起任何 git 进程 —— 项目照旧走快照版本目录（裁定 3）。\n' +
      '下一步（二选一）：① 主对话先问用户"要不要给这个项目开仓库"，拿到答复后再带 git:true 调一次；' +
      '② 不开仓库，继续用快照目录。',
  }
}

/**
 * 开仓库 + 落 AGENTS.md + 首次 commit（**一步做完**，验收 A05）。
 *
 * @param {object} input
 * @param {string} input.dir - 项目目录
 * @param {boolean} input.confirmed - 显式确认
 * @param {string} [input.agentsMdFile] - 要一起提交的文件（默认项目根下的 AGENTS.md）
 * @param {string[]} [input.files] - 本次动作产生的文件清单（**只提交这些**）
 * @param {string} [input.message] - 提交信息（默认 {@link DEFAULT_COMMIT_MESSAGE}）
 * @param {Function} [input.exec] - 注入的 git 执行器（测试用）
 * @param {boolean} [input.dryRun] - 只算计划，不起进程
 * @returns {Promise<{ok:true, dir:string, inited:boolean, alreadyRepo:boolean, committed:boolean,
 *                    commitMessage:string, files:string[], argv:string[][], remoteUntouched:true, note:string}
 *          |{ok:false, code:string, message:string, dir?:string, inited?:boolean, committed?:false}>}
 */
export async function gitInitProject(input = {}) {
  const gate = checkGitConfirmation(input)
  if (!gate.ok) return { ...gate, dir: String(input.dir ?? ''), inited: false, committed: false }

  const dir = resolve(String(input.dir ?? ''))
  if (dir.length === 0 || !existsSync(dir)) {
    return { ok: false, code: 'NO_PROJECT_DIR', message: `项目目录 ${dir} 不存在 —— 先用 create.js 建目录，再开仓库。`, inited: false, committed: false }
  }

  const agentsMd = input.agentsMdFile ?? resolve(dir, AGENTS_MD)
  const files = (Array.isArray(input.files) && input.files.length > 0 ? input.files : [agentsMd]).map((f) => String(f))
  const message = String(input.message ?? DEFAULT_COMMIT_MESSAGE).trim()
  if (message.length === 0) {
    return { ok: false, code: 'EMPTY_COMMIT_MESSAGE', message: '首次 commit 的提交信息不能为空（验收 A05）。', inited: false, committed: false }
  }

  const exec = input.exec
  const alreadyRepo = await isGitRepo(dir, { exec })
  const argv = []
  let inited = false

  if (alreadyRepo !== true) {
    // 边界：项目目录已是 git 仓库 ⇒ 不重复 init。
    const init = await runGit(['init'], { cwd: dir, exec })
    argv.push(init.argv)
    if (!init.ok) return { ok: false, code: init.code, message: init.message, dir, inited: false, committed: false }
    inited = true
  }

  if (input.dryRun === true) {
    return {
      ok: true,
      dir,
      inited,
      alreadyRepo: alreadyRepo === true,
      committed: false,
      commitMessage: message,
      files,
      argv,
      remoteUntouched: true,
      note: 'dryRun：只算计划，未 init、未 commit。',
    }
  }

  // ★ 只提交**本次动作产生的文件**：先 add 这些路径，再按 pathspec commit。
  //   按 pathspec commit（`git commit -- <paths>`）会**忽略索引里别人的改动** ——
  //   这正是边界「首次 commit 只含本次动作产生的文件，不吞并既有改动」所要求的。
  const add = await runGit(['add', '--', ...files], { cwd: dir, exec })
  argv.push(add.argv)
  if (!add.ok) return { ok: false, code: add.code, message: add.message, dir, inited, committed: false }

  const commit = await runGit(
    [
      '-c',
      `user.name=${COMMIT_IDENTITY.name}`,
      '-c',
      `user.email=${COMMIT_IDENTITY.email}`,
      'commit',
      '-m',
      message,
      '--',
      ...files,
    ],
    { cwd: dir, exec },
  )
  argv.push(commit.argv)
  if (!commit.ok) return { ok: false, code: commit.code, message: commit.message, dir, inited, committed: false }

  return {
    ok: true,
    dir,
    inited,
    alreadyRepo: alreadyRepo === true,
    committed: true,
    commitMessage: message,
    files,
    argv,
    remoteUntouched: true,
    note:
      'commit 只含本次动作产生的文件（按 pathspec 提交，不吞并既有改动）。' +
      '★ 全程没有 push / fetch / remote —— 远端未被触碰（验收 A06）。',
  }
}

/**
 * 把"要不要开仓库"这件事的**确认动作**记成一条可查的台账行（验收 A04：确认动作留痕）。
 *
 * ★ 本函数**只造记录**，不落盘 —— 落盘由调用方（工具层 / 存储层）决定，
 *   这样"留痕"与"存储实现"解耦，测试也不必造一个 store。
 *
 * @param {object} input
 * @param {string} input.taskId
 * @param {string} input.actorRole
 * @param {string} [input.actorAgentId]
 * @param {boolean} input.confirmed
 * @param {string} [input.reason]
 * @param {Date} [input.at]
 * @returns {object} 一条台账记录
 */
export function gitConfirmationRecord(input = {}) {
  const at = input.at instanceof Date ? input.at : new Date()
  return {
    kind: 'project_git_confirm',
    task_id: String(input.taskId ?? ''),
    actor_role: String(input.actorRole ?? ''),
    actor_agent_id: typeof input.actorAgentId === 'string' ? input.actorAgentId : null,
    confirmed: input.confirmed === true,
    reason: String(input.reason ?? '').trim(),
    at: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    note:
      input.confirmed === true
        ? '主对话显式确认**开**仓库（裁定 11）。'
        : '主对话显式确认**不开**仓库 ⇒ 项目走快照版本目录（裁定 3）。',
  }
}
