/**
 * p1 · 项目目录：建立 + 幂等 + 复用 + 既存优先 + 同源
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/p1-project-dir-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（已登记，见 `WIRING.md` §W8）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * 覆盖的验收：A01（幂等建目录）、A02（复用与既存优先）、A03（与授权面同源）、
 *   T01（幂等与复用）、T14（既存目录优先），以及边界清单里的
 *   「project_dir 存在但 project_id 不匹配 ⇒ 停下报错」「project_dir 指向不存在路径 ⇒ 重建」
 *   「scope_paths 为空 ⇒ 不建目录、不报致命错」「已存在且非空但不是本项目 ⇒ 直接用、不清理」。
 *
 * @module dsh-pipeline/tests/p1-project-dir-check
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bindProject, readBinding, verifyBinding } from '../lib/project/id.js'
import { ensureProjectDir } from '../lib/project/create.js'
import { scopeMatchesProject } from '../lib/project/layout.js'
import { RESOLVE_MODE, resolveProjectDir, reuseProjectDir } from '../lib/project/resolve.js'

// ---------------------------------------------------------------------------
// 极简断言（每个测试文件自带一份 —— 自包含是可独立运行的前提）
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

/** 递归列出目录下的相对文件路径（用来证明"内容没变"）。 */
async function tree(dir) {
  const { readdir, stat } = await import('node:fs/promises')
  const out = []
  const walk = async (d, prefix) => {
    const entries = await readdir(d)
    for (const name of entries.sort()) {
      const abs = join(d, name)
      const st = await stat(abs)
      if (st.isDirectory()) await walk(abs, `${prefix}${name}/`)
      else out.push(`${prefix}${name}:${st.size}`)
    }
  }
  if (!existsSync(dir)) return out
  await walk(dir, '')
  return out
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-p1-'))

  lines.push('='.repeat(78))
  lines.push('p1 · 项目目录：建立 + 幂等 + 复用 + 既存优先 + 同源')
  lines.push('='.repeat(78))

  // ---- ① 全新项目：建目录 ---------------------------------------------------
  lines.push('')
  lines.push('【① 全新项目 ⇒ projects/<首单 task_id>，建出来】')
  const taskA = { id: 'T-20261016-aaaaaa' }
  const r1 = await resolveProjectDir({ task: taskA, dshHome: root })
  ok(r1.ok === true, '解析成功', r1.ok ? '' : r1.message)
  eq(r1.mode, RESOLVE_MODE.CREATED, '方式 = created')
  eq(r1.projectDir, join(root, 'projects', 'T-20261016-aaaaaa'), '目录 = <DSH目录>/projects/<首单 task_id>')
  ok(existsSync(r1.projectDir), '目录**真的**建出来了')
  ok(r1.created === true, 'created=true（本次新建）')

  // ---- ② 幂等：再解析一次不重建、内容不变 -----------------------------------
  lines.push('')
  lines.push('【② 幂等：绑定后重复解析不重建、内容不变（A01）】')
  const b = bindProject(taskA, { projectId: r1.projectId, projectDir: r1.projectDir })
  ok(b.ok === true && b.changed === true, '首次绑定写入 project_id / project_dir')
  await writeFile(join(r1.projectDir, 'user-content.txt'), 'user owns this', 'utf8')
  const before = await tree(r1.projectDir)

  const r2 = await resolveProjectDir({ task: taskA, dshHome: root })
  eq(r2.mode, RESOLVE_MODE.REUSE, '第二次 = reuse（不是 created）')
  eq(r2.created, false, 'created=false')
  const after = await tree(r1.projectDir)
  ok(JSON.stringify(before) === JSON.stringify(after), '目录内容**逐字节**未变（幂等）', `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
  eq(await readFile(join(r1.projectDir, 'user-content.txt'), 'utf8'), 'user owns this', '用户原有内容原样保留（不清理、不搬移）')

  // ---- ③ 同项目第二单复用同一目录 -------------------------------------------
  lines.push('')
  lines.push('【③ 同项目第 2 单复用同一目录（A02 / 一项目多单）】')
  const taskA2 = { id: 'T-20261017-bbbbbb', project_id: taskA.project_id, project_dir: taskA.project_dir }
  const r3 = await reuseProjectDir(taskA2)
  ok(r3.ok === true && r3.reused === true, '第 2 单复用命中的是同一个目录')
  eq(r3.projectDir, r1.projectDir, '目录与首单完全一致')
  const r3b = await resolveProjectDir({ task: taskA2, dshHome: root })
  eq(r3b.mode, RESOLVE_MODE.REUSE, '走完整解析也是 reuse（不是新目录）')
  ok(!existsSync(join(root, 'projects', 'T-20261017-bbbbbb')), '**没有**按第 2 单的 task_id 新建目录')

  // ---- ④ 既存优先（裁定 U2 / T14）-------------------------------------------
  lines.push('')
  lines.push('【④ 既存优先：已有目录直接复用，不按 task_id 新建（U2 / T14）】')
  const existing = join(root, 'my-existing-repo')
  await mkdir(existing, { recursive: true })
  await writeFile(join(existing, 'README.md'), '# existing', 'utf8')
  const taskC = { id: 'T-20261016-cccccc' }
  const r4 = await resolveProjectDir({ task: taskC, existingRoot: existing, dshHome: root })
  ok(r4.ok === true, '解析成功', r4.ok ? '' : r4.message)
  eq(r4.mode, RESOLVE_MODE.EXISTING, '方式 = existing')
  eq(r4.projectDir, existing, '项目目录 = 既存根')
  ok(!existsSync(join(root, 'projects', 'T-20261016-cccccc')), '**没有**按 task_id 新建目录（既存优先）')

  // ---- ⑤ 与授权面同源（裁定 8 / A03）---------------------------------------
  lines.push('')
  lines.push('【⑤ 项目目录与授权面同源（裁定 8 / A03）】')
  const scRoot = join(root, 'sc', 'proj')
  await mkdir(join(scRoot, 'lib'), { recursive: true })
  const taskD = { id: 'T-20261016-dddddd' }
  const r5 = await resolveProjectDir({ task: taskD, scopePaths: [join(scRoot, 'lib'), join(scRoot, 'tests')], dshHome: root })
  ok(r5.ok === true, '解析成功', r5.ok ? '' : r5.message)
  eq(r5.mode, RESOLVE_MODE.SCOPE_ROOT, '方式 = scope-root')
  eq(r5.projectDir, scRoot, '项目目录 = 授权面公共根')
  const same = scopeMatchesProject(scRoot, [join(scRoot, 'lib'), join(scRoot, 'tests')])
  ok(same.ok === true, '同源判定 = ok', same.message)
  const notSame = scopeMatchesProject(scRoot, [join(scRoot, 'lib'), join(root, 'elsewhere')])
  ok(notSame.ok === false && notSame.outside.length === 1, '不同源被如实报出（并列出越界的那条）', notSame.message)

  // ---- ⑥ 边界：scope_paths 为空 ⇒ 不建目录、不报致命错 ----------------------
  lines.push('')
  lines.push('【⑥ 边界：scope_paths 为空 ⇒ 不建目录、不报致命错，只记 project_id】')
  const taskE = { id: 'T-20261016-eeeeee' }
  const r6 = await resolveProjectDir({ task: taskE, scopePaths: [], dshHome: root })
  ok(r6.ok === true, '**不是**致命错误（ok=true）', r6.ok ? '' : r6.message)
  eq(r6.mode, RESOLVE_MODE.UNBOUND, '方式 = unbound')
  eq(r6.projectDir, null, '没有项目目录')
  eq(r6.dispatchable, false, 'dispatchable=false（派活面看得见）')
  ok(!existsSync(join(root, 'projects', 'T-20261016-eeeeee')), '**没有**建任何目录')

  // ---- ⑦ 边界：绑定冲突 ⇒ 停下报错，不静默覆盖 ------------------------------
  lines.push('')
  lines.push('【⑦ 边界：project_dir 存在但 project_id 不匹配 ⇒ 停下报错，不静默覆盖】')
  const taskF = { id: 'T-20261016-ffffff', project_id: 'T-20261016-aaaaaa', project_dir: r1.projectDir }
  const v = verifyBinding(taskF, { firstTaskId: 'T-20261001-zzzzzz' })
  ok(v.ok === false && v.code === 'PROJECT_ID_MISMATCH', '不一致被拦下（PROJECT_ID_MISMATCH）', v.message)
  const conflict = bindProject(taskF, { projectId: 'T-20261016-ffffff', projectDir: join(root, 'other') })
  ok(conflict.ok === false && conflict.changed === false, '改绑被拒（BINDING_CONFLICT），字段一字节未动')
  eq(taskF.project_dir, r1.projectDir, 'project_dir 仍是原值（没被静默改写）')
  const forced = bindProject({ ...taskF }, { projectId: 'T-20261016-ffffff', projectDir: join(root, 'other'), force: true, why: '人工确认改绑' })
  ok(forced.ok === true && forced.changed === true, '显式 force + why 才允许改绑')
  const forcedNoWhy = bindProject({ ...taskF }, { projectId: 'T-20261016-ffffff', projectDir: join(root, 'other'), force: true })
  ok(forcedNoWhy.ok === false && forcedNoWhy.code === 'FORCE_NEEDS_WHY', 'force 但不给 why ⇒ 拒绝')

  // ---- ⑧ 边界：project_dir 指向不存在路径 ⇒ 视为未建，重新创建 ---------------
  lines.push('')
  lines.push('【⑧ 边界：project_dir 指向不存在路径 ⇒ 视为未建、重新创建】')
  const gone = join(root, 'was-deleted')
  const taskG = { id: 'T-20261016-gggggg', project_id: 'T-20261016-gggggg', project_dir: gone }
  const r8 = await resolveProjectDir({ task: taskG, dshHome: root })
  eq(r8.mode, RESOLVE_MODE.RECREATED, '方式 = recreated')
  ok(existsSync(gone), '目录被重新建出来')
  eq(r8.projectDir, gone, '建的还是**原来那个**路径（不是另起一个）')

  // ---- ⑨ 边界：目录非空但不是本项目 ⇒ 直接用，不清理 ------------------------
  lines.push('')
  lines.push('【⑨ 边界：目录已存在且非空、但不是本项目 ⇒ 按"有目录就在目录里"直接用】')
  const foreign = join(root, 'someone-elses')
  await mkdir(foreign, { recursive: true })
  await writeFile(join(foreign, 'keep-me.txt'), 'do not touch', 'utf8')
  const made = await ensureProjectDir(foreign)
  ok(made.ok === true && made.created === false && made.wrote === false, '幂等：created=false、wrote=false（一个字节都没写）')
  eq(await readFile(join(foreign, 'keep-me.txt'), 'utf8'), 'do not touch', '别人的文件原样在')

  // ---- ⑩ 边界：路径是个文件而不是目录 ⇒ 停下报错 ----------------------------
  lines.push('')
  lines.push('【⑩ 边界：project_dir 位置上是个文件 ⇒ 停下报错，不覆盖】')
  const filePath = join(root, 'iam-a-file')
  await writeFile(filePath, 'x', 'utf8')
  const notDir = await ensureProjectDir(filePath)
  ok(notDir.ok === false && notDir.code === 'PATH_NOT_DIR', '被拦下（PATH_NOT_DIR）', notDir.message)

  // ---- 汇总 -----------------------------------------------------------------
  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`p1 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))

  await rm(root, { recursive: true, force: true })
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
export async function runP1ProjectDirCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ p1 运行失败（异常）：${err?.stack ?? err}`)
    // ★ 异常本身也算一次失败：崩了不能反而少一条，那会让通过率虚高。
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

// 直接跑：`node tests/p1-project-dir-check.mjs` —— 行为与登记前逐字一致（打印原文 + 退出码，项目目录）。
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('p1-project-dir-check.mjs')) {
  const r = await runP1ProjectDirCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
