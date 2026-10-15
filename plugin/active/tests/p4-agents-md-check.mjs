/**
 * p4 · AGENTS.md：内容合规 + 模板独立成文件 + **幂等四情形**
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/p4-agents-md-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（已登记，见 `WIRING.md` §W8）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * 覆盖的验收：A11（含用户给的两条纪律原文；模板来自独立模板文件，不硬编码进实现文件）、
 *   A12（幂等：已存在整体不覆盖；仅可补齐缺失段落；已有自定义行原样保留），
 *   以及边界「AGENTS.md 存在但为空文件 ⇒ 视为缺全部段落，补齐」。
 *
 * @module dsh-pipeline/tests/p4-agents-md-check
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

import {
  REQUIRED_SECTIONS,
  TEMPLATE_FILE,
  ensureAgentsMd,
  inspectAgentsMd,
  renderTemplate,
  sectionIdsOf,
  splitSections,
  templatePath,
} from '../lib/project/agents-md.js'

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

/** 用户给的两条纪律的**原文**（逐字，不许改）。 */
const DISCIPLINE_COMMIT = '每次改动后建 commit / 版本'
const DISCIPLINE_TEST = '每次改动写测试、全绿再交付'

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-p4-'))

  lines.push('='.repeat(78))
  lines.push('p4 · AGENTS.md：内容 + 独立模板 + 幂等四情形')
  lines.push('='.repeat(78))

  // ---- ① 模板是**独立文件**（A11）-------------------------------------------
  lines.push('')
  lines.push('【① 模板独立成文件，不硬编码进实现（A11）】')
  const tplFile = templatePath()
  ok(existsSync(tplFile), '模板文件真的存在', tplFile)
  eq(tplFile.split(/[\\/]/).pop(), TEMPLATE_FILE, '模板文件名 = agents-md.template.md')
  const implSrc = readFileSync(new URL('../lib/project/agents-md.js', import.meta.url), 'utf8')
  ok(!implSrc.includes(DISCIPLINE_COMMIT) && !implSrc.includes(DISCIPLINE_TEST),
    '★ 两条纪律的**原文不在实现文件里**（改措辞只改模板）',
    `实现文件里搜不到 "${DISCIPLINE_COMMIT}" / "${DISCIPLINE_TEST}"`)
  const tplText = readFileSync(tplFile, 'utf8')
  ok(tplText.includes(DISCIPLINE_COMMIT), '模板里有纪律一原文')
  ok(tplText.includes(DISCIPLINE_TEST), '模板里有纪律二原文')
  for (const id of REQUIRED_SECTIONS) {
    ok(tplText.includes(`pipeline:section:${id}`), `模板里有段落标记 ${id}`)
  }

  // ★★ 最强的一条：换一份模板，输出就跟着变 —— 证明内容**真的**来自模板文件，不是实现里藏着。
  lines.push('')
  lines.push('【①b ★★ 模板驱动：换模板 ⇒ 输出跟着换（"没有硬编码"的实证）】')
  const sentinel = '哨兵纪律·唯一串-ZZ9'
  const altTpl = join(root, 'alt.template.md')
  const altBody = [`# 换过的模板`, '']
  for (const id of REQUIRED_SECTIONS) altBody.push(`<!-- pipeline:section:${id} -->`, `## ${id}`, '', id === 'discipline-commit' ? sentinel : `${id} 的正文`, '')
  await writeFile(altTpl, altBody.join('\n'), 'utf8')
  const projSentinel = join(root, 'proj-sentinel')
  await mkdir(projSentinel, { recursive: true })
  const cs = await ensureAgentsMd({ projectDir: projSentinel, mode: 'git', templateFile: altTpl })
  ok(cs.ok === true, '用另一份模板落盘成功', cs.ok ? '' : cs.message)
  const docS = await readFile(join(projSentinel, 'AGENTS.md'), 'utf8')
  ok(docS.includes(sentinel), '★ 输出里出现了**只有新模板才有**的哨兵串', sentinel)
  ok(!docS.includes(DISCIPLINE_COMMIT) && !docS.includes(DISCIPLINE_TEST),
    '★ 输出里**不再有**原模板的纪律原文 —— 内容确实由模板决定，实现里没有藏一份')

  // ---- ② 渲染：variant 取舍 + 占位符 ----------------------------------------
  lines.push('')
  lines.push('【② 渲染：git / snapshot 两种 variant】')
  const renderGit = renderTemplate(tplText, 'git', { PROJECT_ID: 'T-1', TASK_ID: 'T-1', GENERATED_AT: '2026-10-15T12:00:00Z' })
  const renderSnap = renderTemplate(tplText, 'snapshot', { PROJECT_ID: 'T-1', TASK_ID: 'T-1', GENERATED_AT: '2026-10-15T12:00:00Z' })
  ok(renderGit.includes('**是 git 仓库**'), 'git 模式保留了 git 那一段')
  ok(!renderGit.includes('**还不是 git 仓库**'), 'git 模式丢掉了 snapshot 那一段')
  ok(renderSnap.includes('**还不是 git 仓库**'), 'snapshot 模式保留了 snapshot 那一段')
  ok(!renderSnap.includes('**是 git 仓库**'), 'snapshot 模式丢掉了 git 那一段')
  ok(!renderGit.includes('pipeline:variant'), 'variant 包裹标记在输出里被清掉了')
  ok(renderGit.includes('T-1') && renderGit.includes('2026-10-15T12:00:00Z'), '占位符被替换')
  const secs = splitSections(renderGit)
  eq(secs.length, REQUIRED_SECTIONS.length, `渲染结果恰好切成 ${REQUIRED_SECTIONS.length} 段`)

  // ---- ③ 幂等情形 ①：不存在 ⇒ created --------------------------------------
  lines.push('')
  lines.push('【③ 幂等情形 ①：文件不存在 ⇒ created，写全文】')
  const proj = join(root, 'proj')
  await mkdir(proj, { recursive: true })
  const c1 = await ensureAgentsMd({ projectDir: proj, mode: 'git', projectId: 'T-1', taskId: 'T-1', now: new Date(Date.UTC(2026, 9, 15, 12, 0, 0)) })
  ok(c1.ok === true, '落盘成功', c1.ok ? '' : c1.message)
  eq(c1.action, 'created', 'action = created')
  eq(c1.written, true, 'written = true')
  ok(existsSync(join(proj, 'AGENTS.md')), 'AGENTS.md 落在**项目目录根**')
  const doc1 = await readFile(join(proj, 'AGENTS.md'), 'utf8')
  ok(doc1.includes(DISCIPLINE_COMMIT), '★ 落盘内容含纪律一原文')
  ok(doc1.includes(DISCIPLINE_TEST), '★ 落盘内容含纪律二原文')
  const insp1 = await inspectAgentsMd(proj)
  ok(insp1.missing.length === 0, '三段齐全')

  // ---- ④ 幂等情形 ②：齐全 ⇒ 一个字节都不写 ----------------------------------
  lines.push('')
  lines.push('【④ 幂等情形 ②：已齐全 ⇒ unchanged，一个字节都不写】')
  const before = await readFile(join(proj, 'AGENTS.md'), 'utf8')
  const c2 = await ensureAgentsMd({ projectDir: proj, mode: 'snapshot', projectId: 'DIFFERENT', taskId: 'DIFFERENT' })
  eq(c2.action, 'unchanged', 'action = unchanged')
  eq(c2.written, false, 'written = false')
  eq(await readFile(join(proj, 'AGENTS.md'), 'utf8'), before, '★ 内容**逐字节**未变（连 mode 变了都不重写）')

  // ---- ⑤ 幂等情形 ③：空文件 ⇒ completed ------------------------------------
  lines.push('')
  lines.push('【⑤ 幂等情形 ③：空文件 ⇒ completed（视为缺全部段落）】')
  const projEmpty = join(root, 'proj-empty')
  await mkdir(projEmpty, { recursive: true })
  await writeFile(join(projEmpty, 'AGENTS.md'), '', 'utf8')
  const c3 = await ensureAgentsMd({ projectDir: projEmpty, mode: 'snapshot' })
  eq(c3.action, 'completed', 'action = completed（不是 unchanged、也不是 appended）')
  eq(c3.written, true, 'written = true')
  const doc3 = await readFile(join(projEmpty, 'AGENTS.md'), 'utf8')
  ok(doc3.includes(DISCIPLINE_COMMIT) && doc3.includes(DISCIPLINE_TEST), '补齐后两条纪律都在')

  const projBlank = join(root, 'proj-blank')
  await mkdir(projBlank, { recursive: true })
  await writeFile(join(projBlank, 'AGENTS.md'), '   \n\n  \t\n', 'utf8')
  const c3b = await ensureAgentsMd({ projectDir: projBlank, mode: 'git' })
  eq(c3b.action, 'completed', '只有空白字符也算空文件 ⇒ completed')

  // ---- ⑥ 幂等情形 ④：缺段 + 自定义行 ⇒ appended，自定义行逐字保留 -----------
  lines.push('')
  lines.push('【⑥ 幂等情形 ④：缺段 ⇒ appended，已有自定义行**逐字保留**】')
  const projCustom = join(root, 'proj-custom')
  await mkdir(projCustom, { recursive: true })
  const custom = [
    '# 我自己写的规矩',
    '',
    '这行是我加的，谁都不许动。',
    '',
    '<!-- pipeline:section:discipline-commit -->',
    '## 纪律一（我自己改过标题）',
    '',
    '只留这一段，另外两段被我不小心删了。',
    '',
  ].join('\n')
  await writeFile(join(projCustom, 'AGENTS.md'), custom, 'utf8')
  const c4 = await ensureAgentsMd({ projectDir: projCustom, mode: 'git' })
  eq(c4.action, 'appended', 'action = appended')
  eq(c4.written, true, 'written = true')
  eq(JSON.stringify(c4.added), JSON.stringify(['discipline-test', 'version-mode']), '只补了缺的两段（已有的 discipline-commit 不重写）')
  const doc4 = await readFile(join(projCustom, 'AGENTS.md'), 'utf8')
  ok(doc4.startsWith('# 我自己写的规矩'), '★ 用户自己的标题还在文件最前面')
  ok(doc4.includes('这行是我加的，谁都不许动。'), '★ 用户自定义行**逐字保留**')
  ok(doc4.includes('## 纪律一（我自己改过标题）'), '★ 用户改过的标题**没有被覆盖**成模板标题')
  ok(doc4.includes('只留这一段，另外两段被我不小心删了。'), '★ 用户那一段的正文没被动')
  ok(doc4.includes(DISCIPLINE_TEST), '缺的纪律二被补上了')
  ok(sectionIdsOf(doc4).includes('discipline-commit'), '★ 用户那段的主导标记仍在（没被当成"缺段"重写）')
  eq(sectionIdsOf(doc4).filter((s) => s === 'discipline-commit').length, 1, '补完之后 discipline-commit **没有出现两份**')

  // ---- ⑦ 缺的是第一段也能补对 ------------------------------------------------
  lines.push('')
  lines.push('【⑦ 缺中间/第一段也能补对】')
  const projMid = join(root, 'proj-mid')
  await mkdir(projMid, { recursive: true })
  await writeFile(join(projMid, 'AGENTS.md'), '# t\n\n<!-- pipeline:section:discipline-commit -->\n只有第一段。\n', 'utf8')
  const c5 = await ensureAgentsMd({ projectDir: projMid, mode: 'snapshot' })
  eq(c5.action, 'appended', 'action = appended')
  eq(JSON.stringify(c5.added), JSON.stringify(['discipline-test', 'version-mode']), '补的是后两段')

  // ---- ⑧ dryRun 不落盘 -------------------------------------------------------
  lines.push('')
  lines.push('【⑧ dryRun：只算计划不落盘】')
  const projDry = join(root, 'proj-dry')
  await mkdir(projDry, { recursive: true })
  const c6 = await ensureAgentsMd({ projectDir: projDry, mode: 'git', dryRun: true })
  eq(c6.action, 'created', '预演说会 created')
  eq(c6.written, false, 'written = false')
  ok(!existsSync(join(projDry, 'AGENTS.md')), '★ 盘上**没有** AGENTS.md')

  // ---- ⑨ 模板坏掉 ⇒ 报错，不写出残缺文件 ------------------------------------
  lines.push('')
  lines.push('【⑨ 模板缺段落 ⇒ 报错，不写出残缺的纪律文件】')
  const brokenTpl = join(root, 'broken.template.md')
  await writeFile(brokenTpl, '# 只剩一段\n\n<!-- pipeline:section:discipline-commit -->\n内容\n', 'utf8')
  const projBroken = join(root, 'proj-broken')
  await mkdir(projBroken, { recursive: true })
  const c7 = await ensureAgentsMd({ projectDir: projBroken, mode: 'git', templateFile: brokenTpl })
  ok(c7.ok === false && c7.code === 'TEMPLATE_MISSING_SECTION', '被拦下（TEMPLATE_MISSING_SECTION）', c7.message)
  ok(!existsSync(join(projBroken, 'AGENTS.md')), '★ 没有写出残缺的 AGENTS.md')
  const c8 = await ensureAgentsMd({ projectDir: projBroken, mode: 'git', templateFile: join(root, 'nope.md') })
  ok(c8.ok === false && c8.code === 'TEMPLATE_MISSING', '模板文件不存在 ⇒ TEMPLATE_MISSING')

  await rm(root, { recursive: true, force: true })

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`p4 总计：${passed}/${passed + failed} 通过`)
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
export async function runP4AgentsMdCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ p4 运行失败（异常）：${err?.stack ?? err}`)
    // ★ 异常本身也算一次失败：崩了不能反而少一条，那会让通过率虚高。
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

// 直接跑：`node tests/p4-agents-md-check.mjs` —— 行为与登记前逐字一致（打印原文 + 退出码，AGENTS.md）。
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('p4-agents-md-check.mjs')) {
  const r = await runP4AgentsMdCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
