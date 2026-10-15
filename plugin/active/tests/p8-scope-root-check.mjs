/**
 * p8 · 授权面同源：项目目录 = scope 的根
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/p8-scope-root-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（已登记，见 `WIRING.md` §W8）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * 裁定 8：「项目目录与**授权面同源**（项目目录 = scope_paths 的根）」。
 * 覆盖验收 A03，以及边界「scope_paths 为空 ⇒ 不建目录、不报致命错，只记 project_id」。
 *
 * ★ 本套里最关键的一条是**按段比而不是按字符比**：按字符比会把
 *   `C:\x\abc` 错算成 `C:\x\ab` 的子路径 —— 那是"授权面看起来同源、实际越界"，
 *   是本裁定最危险的失效方式，所以必须有一个真会判错的反例把钉住。
 *
 * @module dsh-pipeline/tests/p8-scope-root-check
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { commonScopeRoot, isUnderProject, scopeMatchesProject } from '../lib/project/layout.js'
import { RESOLVE_MODE, resolveProjectDir } from '../lib/project/resolve.js'
import { pathKey } from '../lib/util.js'

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

/** 「按字符比」的错误实现 —— 只为让反例能真的跑出来（产品代码里不许用）。 */
function charWiseCommonRoot(paths) {
  const list = (Array.isArray(paths) ? paths : []).map((p) => pathKey(p))
  if (list.length === 0) return ''
  let acc = list[0]
  for (const p of list.slice(1)) {
    let i = 0
    while (i < acc.length && i < p.length && acc[i] === p[i]) i += 1
    acc = acc.slice(0, i)
  }
  return acc
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-p8-'))

  lines.push('='.repeat(78))
  lines.push('p8 · 授权面同源：项目目录 = scope 的根（裁定 8 / A03）')
  lines.push('='.repeat(78))

  // ---- ① 公共根：按段比 ------------------------------------------------------
  lines.push('')
  lines.push('【① 公共根按**路径段**求（不是按字符）】')
  const proj = join(root, 'proj')
  const libDir = join(proj, 'lib')
  const testsDir = join(proj, 'tests')
  const r1 = commonScopeRoot([libDir, testsDir])
  ok(r1.ok === true, '求得出公共根', r1.reason)
  eq(pathKey(r1.root), pathKey(proj), '公共根 = 两者的父目录')
  eq(r1.root, proj, '★ 返回的是**真实路径**（不是 pathKey 那种小写正斜杠形式）')

  const single = commonScopeRoot([libDir])
  ok(single.ok === true, '只有一条也能求', single.reason)
  eq(pathKey(single.root), pathKey(libDir), '只有一条 ⇒ 公共根就是它自己')

  const deep = commonScopeRoot([join(proj, 'a', 'b', 'c'), join(proj, 'a', 'b', 'd')])
  eq(pathKey(deep.root), pathKey(join(proj, 'a', 'b')), '深层公共前缀取到分叉点为止')

  const empty = commonScopeRoot([])
  ok(empty.ok === false && empty.reason === 'EMPTY_SCOPE', '空清单 ⇒ EMPTY_SCOPE（不是"根 = 空串"那种假通过）')

  // ---- ② ★ 反例：按字符比会把兄弟目录算成子目录 ------------------------------
  lines.push('')
  lines.push('【② ★ 反例：按**字符**比会把兄弟目录错算成父子关系】')
  const ab = join(root, 'x', 'ab')
  const abc = join(root, 'x', 'abc')
  const rightRoot = commonScopeRoot([ab, abc])
  const wrongRoot = charWiseCommonRoot([ab, abc])
  eq(pathKey(rightRoot.root), pathKey(join(root, 'x')), '按段比 ⇒ 公共根 = <root>/x（正确）')
  eq(wrongRoot, pathKey(ab), '★ 按字符比 ⇒ 公共根 = <root>/x/ab（**错的**）')
  ok(pathKey(rightRoot.root) !== wrongRoot, '★ 两种算法结论**确实不同** —— 反例成立')
  ok(isUnderProject(ab, abc) === false,
    '★ 而 abc **并不在** ab 之下 —— 所以按字符比会得出"授权面同源"的假结论',
    `isUnderProject("${ab}", "${abc}") = false`)

  // ---- ③ 同源判定 ------------------------------------------------------------
  lines.push('')
  lines.push('【③ 同源判定 scopeMatchesProject（A03）】')
  const same = scopeMatchesProject(proj, [libDir, testsDir])
  ok(same.ok === true && same.code === 'OK', '项目目录 = 授权面公共根 ⇒ 同源', same.message)
  eq(pathKey(same.commonRoot), pathKey(proj), '报出的公共根与项目目录一致')

  const outsideOne = scopeMatchesProject(proj, [libDir, join(root, 'elsewhere')])
  ok(outsideOne.ok === false && outsideOne.code === 'SCOPE_NOT_UNDER_PROJECT', '有一条在项目目录外 ⇒ 不同源')
  eq(outsideOne.outside.length, 1, '如实列出越界的那一条')
  ok(outsideOne.message.includes('不静默改写'), '★ 文案里点明"不静默改写既有 project_dir 字段"')

  const parentScope = scopeMatchesProject(proj, [root])
  ok(parentScope.ok === false, '授权面比项目目录**更宽**（在父目录上）⇒ 不同源（不许悄悄放大）')

  const emptyScope = scopeMatchesProject(proj, [])
  ok(emptyScope.ok === false && emptyScope.code === 'EMPTY_SCOPE', '空授权面单独报 EMPTY_SCOPE（可分辨的失败）')

  // ---- ④ isUnderProject 的边界 ----------------------------------------------
  lines.push('')
  lines.push('【④ isUnderProject：含自身、不误判兄弟目录】')
  ok(isUnderProject(proj, proj) === true, '项目目录"在"项目目录之内（含自身）')
  ok(isUnderProject(proj, libDir) === true, '子目录在内')
  ok(isUnderProject(libDir, proj) === false, '父目录**不在**子目录之内（方向不反）')
  ok(isUnderProject(proj, join(root, 'proj2')) === false, '★ 兄弟目录 proj2 不算在 proj 之内（按段比，不按字符比）')
  ok(isUnderProject(proj, '') === false, '空路径不算在内')

  // ---- ⑤ 项目目录由授权面决定（resolveProjectDir）----------------------------
  lines.push('')
  lines.push('【⑤ 项目目录 = 授权面公共根（裁定 8 落到解析上）】')
  await mkdir(libDir, { recursive: true })
  await mkdir(testsDir, { recursive: true })
  const task = { id: 'T-20261016-scope1' }
  const r5 = await resolveProjectDir({ task, scopePaths: [libDir, testsDir], dshHome: root })
  ok(r5.ok === true, '解析成功', r5.ok ? '' : r5.message)
  eq(r5.mode, RESOLVE_MODE.SCOPE_ROOT, '方式 = scope-root')
  eq(r5.projectDir, proj, '项目目录 = 授权面公共根')
  const after = scopeMatchesProject(r5.projectDir, [libDir, testsDir])
  ok(after.ok === true, '★ 解析出来的项目目录**回头**过得了同源判定（闭环，不是自说自话）')

  // ---- ⑥ 边界：scope_paths 为空 ⇒ 不建目录、不报致命错 ----------------------
  lines.push('')
  lines.push('【⑥ 边界：scope_paths 为空 ⇒ 不建目录、不报致命错，只记 project_id】')
  const taskEmpty = { id: 'T-20261016-scope2' }
  const r6 = await resolveProjectDir({ task: taskEmpty, scopePaths: [], dshHome: root })
  ok(r6.ok === true, '**不是**致命错误（ok=true）', r6.ok ? '' : r6.message)
  eq(r6.mode, RESOLVE_MODE.UNBOUND, '方式 = unbound')
  eq(r6.projectDir, null, '没有项目目录')
  eq(r6.dispatchable, false, 'dispatchable=false（派活面可见该状态）')
  eq(r6.projectId, taskEmpty.id, '只记了 project_id')
  ok(!existsSync(join(root, 'projects', taskEmpty.id)), '**没有**建任何目录')

  // ---- ⑦ 已有目录 + 授权面：既存优先仍然压过 scope 根？ ----------------------
  lines.push('')
  lines.push('【⑦ 顺序：已绑定 > 既存根 > 授权面 > 全新项目】')
  const taskBound = { id: 'T-20261016-scope3', project_id: 'T-20261016-scope1', project_dir: proj }
  const r7 = await resolveProjectDir({ task: taskBound, scopePaths: [libDir], existingRoot: root, dshHome: root })
  eq(r7.mode, RESOLVE_MODE.REUSE, '已绑定 ⇒ 直接复用（既存根与授权面都不参与）')
  eq(r7.projectDir, proj, '复用的就是绑定的那个目录')
  const taskExisting = { id: 'T-20261016-scope4' }
  const r7b = await resolveProjectDir({ task: taskExisting, scopePaths: [libDir], existingRoot: root, dshHome: root })
  eq(r7b.mode, RESOLVE_MODE.EXISTING, '★ 既存根**压过**授权面（裁定 U2：已有仓库直接复用）')
  eq(r7b.projectDir, root, '项目目录 = 既存根，而不是授权面公共根')

  await rm(root, { recursive: true, force: true })

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`p8 总计：${passed}/${passed + failed} 通过`)
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
export async function runP8ScopeRootCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ p8 运行失败（异常）：${err?.stack ?? err}`)
    // ★ 异常本身也算一次失败：崩了不能反而少一条，那会让通过率虚高。
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

// 直接跑：`node tests/p8-scope-root-check.mjs` —— 行为与登记前逐字一致（打印原文 + 退出码，授权面锚点）。
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('p8-scope-root-check.mjs')) {
  const r = await runP8ScopeRootCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
