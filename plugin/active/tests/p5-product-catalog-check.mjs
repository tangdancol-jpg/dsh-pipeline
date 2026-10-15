/**
 * p5 · 产品目录：分组 + 每条判据 + **空 MVP 被拒** + 留档落盘
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/p5-product-catalog-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（已登记，见 `WIRING.md` §W8）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * 覆盖的验收：A13（两组、每条带验收判据、空 MVP 被 schema 拒）、A14（由**留档**落
 *   `docs/product-design.md`，需求 agent 的 readonly 不被破）、A15（与 DEMO 同批、**一次**确认）。
 *
 * @module dsh-pipeline/tests/p5-product-catalog-check
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GROUP_LABELS, GROUP_LATER, GROUP_MVP, catalogStats, groupOf } from '../lib/design/catalog-groups.js'
import { CATALOG_CODES, acceptCatalog, normalizeCatalog, validateCatalog } from '../lib/design/catalog-schema.js'
import { inspectProductDesignDoc, renderProductDesignDoc, writeProductDesignDoc } from '../lib/design/doc.js'
import {
  PRODUCT_DESIGN_KIND,
  PRODUCT_DESIGN_SCHEMA,
  summarizeProductDesign,
  validateProductDesignPayload,
} from '../lib/handoff/schemas/product-design.js'

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

/** 一份合用的产品目录（照需求分析里那份的形状写）。 */
function goodCatalog() {
  return {
    mvp: [
      {
        id: 'M1',
        title: '项目目录自动建立 + 幂等 + 复用',
        description: '派单后建目录；重复派单不重建。',
        acceptance: ['同一 project_id 重复派单，目录内容前后一致', '同项目第二单复用同一目录'],
      },
      {
        id: 'M2',
        title: '项目目录与授权面同源',
        description: '',
        acceptance: ['项目目录 = scope_paths 的公共根'],
      },
    ],
    later: [
      { id: 'N1', title: '同项目 agent 团队复用', description: '另立项', acceptance: ['本批次不预埋接口'] },
    ],
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-p5-'))

  lines.push('='.repeat(78))
  lines.push('p5 · 产品目录：分组 + 每条判据 + 空 MVP 被拒 + 留档落盘')
  lines.push('='.repeat(78))

  // ---- ① 分组 ----------------------------------------------------------------
  lines.push('')
  lines.push('【① 两组：MVP 必须 / 后续再说】')
  eq(GROUP_MVP, 'mvp', 'MVP 组的键 = mvp')
  eq(GROUP_LATER, 'later', '后续组的键 = later')
  eq(GROUP_LABELS.mvp, 'MVP 必须', 'MVP 组的中文名 = MVP 必须')
  eq(GROUP_LABELS.later, '后续再说', '后续组的中文名 = 后续再说')
  const g = groupOf(goodCatalog())
  eq(g.mvp.length, 2, '切成两组后 MVP 有 2 条')
  eq(g.later.length, 1, '后续有 1 条')
  const stats = catalogStats(goodCatalog())
  eq(stats.mvp, 2, '统计：MVP 2')
  eq(stats.later, 1, '统计：后续 1')
  eq(stats.withAcceptance, 3, '统计：3 条都有验收判据')

  // ---- ② 合规目录通过 --------------------------------------------------------
  lines.push('')
  lines.push('【② 合规目录：校验通过 + 归一化】')
  const v1 = validateCatalog(goodCatalog())
  ok(v1.ok === true, '合规目录通过校验', v1.ok ? '' : JSON.stringify(v1.issues))
  eq(v1.stats.mvp, 2, '校验结果带 MVP 条数')
  const accepted = acceptCatalog(goodCatalog())
  ok(accepted.ok === true, 'acceptCatalog 通过')
  const norm = normalizeCatalog({ mvp: [{ id: ' M1 ', title: ' 标题 ', acceptance: [' 判据 ', '  '] }], later: [] })
  eq(norm.mvp[0].id, 'M1', '归一化剪掉 id 两端空白')
  eq(norm.mvp[0].acceptance.length, 1, '归一化丢掉空判据')

  // ---- ③ ★ 空 MVP 被拒（A13 点名的那条）------------------------------------
  lines.push('')
  lines.push('【③ ★ 空 MVP 被拒】')
  const emptyMvp = validateCatalog({ mvp: [], later: [{ id: 'N1', title: '以后做', acceptance: ['以后再说'] }] })
  ok(emptyMvp.ok === false, '只有 later、mvp 为空 ⇒ **拒绝**')
  const codes = emptyMvp.issues.map((i) => i.code)
  ok(codes.includes(CATALOG_CODES.EMPTY_MVP), '报出的码里有 CATALOG_EMPTY_MVP', codes.join(','))
  const emptyMsg = emptyMvp.issues.find((i) => i.code === CATALOG_CODES.EMPTY_MVP).message
  ok(emptyMsg.includes('MVP 至少 1 条'), '拒绝文案写明了判据（MVP 至少 1 条）', emptyMsg.split('\n')[0])
  ok(emptyMsg.includes('下一步'), '拒绝文案给了**下一步**（不是干巴巴一句"不行"）')
  ok(validateCatalog({ mvp: [], later: [] }).ok === false, '两组都空 ⇒ 拒绝')
  const emptyAccepted = acceptCatalog({ mvp: [], later: [] })
  ok(emptyAccepted.ok === false && emptyAccepted.message.includes('CATALOG_EMPTY_MVP'), 'acceptCatalog 也拦得住，并把码带出来')

  // ---- ④ 每条必须带验收判据 --------------------------------------------------
  lines.push('')
  lines.push('【④ 每条必须带验收判据】')
  const noAcc = validateCatalog({ mvp: [{ id: 'M1', title: '没判据的条目' }], later: [] })
  ok(noAcc.ok === false && noAcc.issues.some((i) => i.code === CATALOG_CODES.MISSING_ACCEPTANCE), '缺 acceptance ⇒ 拒绝')
  const emptyAcc = validateCatalog({ mvp: [{ id: 'M1', title: 't', acceptance: [] }], later: [] })
  ok(emptyAcc.ok === false && emptyAcc.issues.some((i) => i.code === CATALOG_CODES.MISSING_ACCEPTANCE), 'acceptance 是空数组 ⇒ 也拒绝')
  const blankAcc = validateCatalog({ mvp: [{ id: 'M1', title: 't', acceptance: ['   ', ''] }], later: [] })
  ok(blankAcc.ok === false, 'acceptance 里全是空白 ⇒ 也拒绝（"写了但等于没写"不算）')
  const okAcc = validateCatalog({ mvp: [{ id: 'M1', title: 't', acceptance: ['一条真判据'] }], later: [] })
  ok(okAcc.ok === true, '至少 1 条真判据 ⇒ 通过')

  // ---- ⑤ 其它结构问题 --------------------------------------------------------
  lines.push('')
  lines.push('【⑤ 其它结构问题：缺 id / 缺标题 / 重复 id / 不认识的分组】')
  ok(validateCatalog(null).issues[0].code === CATALOG_CODES.NOT_AN_OBJECT, '不是对象 ⇒ CATALOG_NOT_OBJECT')
  ok(validateCatalog([]).issues[0].code === CATALOG_CODES.NOT_AN_OBJECT, '是数组 ⇒ 也算 NOT_AN_OBJECT')
  ok(validateCatalog({ mvp: [{ title: 't', acceptance: ['a'] }], later: [] }).issues.some((i) => i.code === CATALOG_CODES.MISSING_ID), '缺 id ⇒ 拒绝')
  ok(validateCatalog({ mvp: [{ id: 'M1', acceptance: ['a'] }], later: [] }).issues.some((i) => i.code === CATALOG_CODES.MISSING_TITLE), '缺标题 ⇒ 拒绝')
  ok(validateCatalog({ mvp: [{ id: 'M1', title: 'a', acceptance: ['x'] }, { id: 'M1', title: 'b', acceptance: ['y'] }], later: [] })
    .issues.some((i) => i.code === CATALOG_CODES.DUPLICATE_ID), 'id 重复 ⇒ 拒绝')
  ok(validateCatalog({ mvp: [{ id: 'M1', title: 'a', acceptance: ['x'] }], later: [], later2: [] })
    .issues.some((i) => i.code === CATALOG_CODES.BAD_GROUP), '多写了别的分组 ⇒ 报出来（不静默忽略）')
  ok(validateCatalog({ mvp: 'not-an-array', later: [] }).issues.some((i) => i.code === CATALOG_CODES.NOT_AN_ARRAY), '分组不是数组 ⇒ 拒绝')

  // ---- ⑥ 渲染 + 由留档落盘（A14）--------------------------------------------
  lines.push('')
  lines.push('【⑥ 渲染与落盘：由**留档**落 docs/product-design.md（A14）】')
  const rendered = renderProductDesignDoc({ catalog: goodCatalog(), taskId: 'T-1', projectId: 'T-1', now: new Date(Date.UTC(2026, 9, 15, 12, 0, 0)) })
  ok(rendered.ok === true, '渲染成功', rendered.ok ? '' : rendered.message)
  const md = rendered.markdown
  ok(md.includes('# 产品设计文档'), '有标题')
  ok(md.includes('## MVP 必须（2 条）'), '★ MVP 那一组带条数', '## MVP 必须（2 条）')
  ok(md.includes('## 后续再说（1 条）'), '★ 后续那一组带条数')
  ok(md.includes('### M1 · 项目目录自动建立 + 幂等 + 复用'), '条目按 id + 标题成小节')
  ok(md.includes('- 同一 project_id 重复派单，目录内容前后一致'), '★ 验收判据逐条列出（每条都看得见）')
  ok(md.includes('MVP 必须 2 条，后续再说 1 条，共 3 条'), '末尾有统计')
  const badRender = renderProductDesignDoc({ catalog: { mvp: [], later: [] } })
  ok(badRender.ok === false && String(badRender.message).includes('CATALOG_EMPTY_MVP'), '空 MVP **渲染阶段就**被拒（不是写出空文档）')

  const proj = join(root, 'proj')
  const writeByArchivist = await writeProductDesignDoc({
    projectDir: proj,
    catalog: goodCatalog(),
    actorRole: 'archivist',
    taskId: 'T-1',
    projectId: 'T-1',
    now: new Date(Date.UTC(2026, 9, 15, 12, 0, 0)),
  })
  ok(writeByArchivist.ok === true, '★ 留档角色落盘成功', writeByArchivist.ok ? '' : writeByArchivist.message)
  eq(writeByArchivist.path, join(proj, 'docs', 'product-design.md'), '落点是 docs/product-design.md')
  ok(existsSync(join(proj, 'docs', 'product-design.md')), '文件真的在盘上')
  ok(writeByArchivist.bytes > 0, '写出了非零字节', `${writeByArchivist.bytes} bytes`)
  const onDisk = await readFile(join(proj, 'docs', 'product-design.md'), 'utf8')
  eq(onDisk, md, '盘上内容与渲染结果一致')
  const inspected = inspectProductDesignDoc(proj)
  ok(inspected.exists === true && inspected.rel === 'docs/product-design.md', '体检：存在且相对路径对')

  // ---- ⑦ ★ 需求 agent（readonly）不许落盘（A14）-----------------------------
  lines.push('')
  lines.push('【⑦ ★ 需求 agent（readonly）不许落盘 —— readonly 纪律不被破（A14）】')
  const projRo = join(root, 'proj-ro')
  const byOrchestrator = await writeProductDesignDoc({ projectDir: projRo, catalog: goodCatalog(), actorRole: 'orchestrator' })
  ok(byOrchestrator.ok === false && byOrchestrator.code === 'READONLY_ROLE_CANNOT_WRITE', '需求分析角色被拒（READONLY_ROLE_CANNOT_WRITE）')
  ok(String(byOrchestrator.message).includes('留档'), '拒绝文案给出**正确路径**（交留档）', byOrchestrator.message.split('\n')[0])
  ok(!existsSync(join(projRo, 'docs', 'product-design.md')), '★ 盘上**没有**写出任何文件')
  const byNobody = await writeProductDesignDoc({ projectDir: projRo, catalog: goodCatalog() })
  ok(byNobody.ok === false && byNobody.code === 'NO_ACTOR_ROLE', '不报角色 ⇒ 拒绝')
  const byWriter = await writeProductDesignDoc({ projectDir: projRo, catalog: goodCatalog(), actorRole: 'writer' })
  ok(byWriter.ok === false && byWriter.code === 'ROLE_NOT_DOC_WRITER', '非留档/文档角色 ⇒ 拒绝')
  const byDocs = await writeProductDesignDoc({ projectDir: projRo, catalog: goodCatalog(), actorRole: 'docs' })
  ok(byDocs.ok === true, 'docs 角色可以落盘（留档同族）')

  // ---- ⑧ 交接物 schema（A15：同批一次确认）-----------------------------------
  lines.push('')
  lines.push('【⑧ 交接物 schema：product_design 与 DEMO 同批、**一次**确认（A15）】')
  eq(PRODUCT_DESIGN_KIND, 'product_design', '交接物类型名 = product_design')
  eq(PRODUCT_DESIGN_SCHEMA.from.join(','), 'orchestrator', '只有需求分析产出它（readonly 只"交"，不"写文件"）')
  ok(PRODUCT_DESIGN_SCHEMA.required.includes('catalog'), 'catalog 是必填')
  ok(PRODUCT_DESIGN_SCHEMA.required.includes('confirm_request_id'), 'confirm_request_id 是必填')
  ok(!PRODUCT_DESIGN_SCHEMA.required.includes('demo'), 'demo **不在** required 里（L0–L1 可跳过）')
  ok(Object.prototype.hasOwnProperty.call(PRODUCT_DESIGN_SCHEMA.fields, 'demo'), '但 demo **在字段表里**（必须显式写，可为 null）')

  const goodPayload = { task_id: 'T-1', catalog: goodCatalog(), demo: null, confirm_request_id: 'HR-abc' }
  const vp = validateProductDesignPayload(goodPayload)
  ok(vp.ok === true, '合规 payload 通过', vp.ok ? '' : JSON.stringify(vp.issues))
  eq(vp.stats.mvp, 2, 'payload 校验带出 MVP 条数')

  const noRid = validateProductDesignPayload({ task_id: 'T-1', catalog: goodCatalog(), demo: null })
  ok(noRid.ok === false && noRid.issues.some((i) => i.code === 'MISSING_CONFIRM_REQUEST'), '缺 confirm_request_id ⇒ 拒绝（"一次确认"落不成事实）')
  const noDemoField = validateProductDesignPayload({ task_id: 'T-1', catalog: goodCatalog(), confirm_request_id: 'HR-abc' })
  ok(noDemoField.ok === false && noDemoField.issues.some((i) => i.code === 'DEMO_FIELD_ABSENT'),
    '★ `demo` 字段**整个不写** ⇒ 拒绝（`null`="这次跳过"是结论；缺字段="我没提这件事"）')
  const nullDemo = validateProductDesignPayload({ task_id: 'T-1', catalog: goodCatalog(), demo: null, confirm_request_id: 'HR-abc' })
  ok(nullDemo.ok === true, '显式 `demo: null`（L0–L1 跳过）⇒ 通过')
  const emptyMvpPayload = validateProductDesignPayload({ task_id: 'T-1', catalog: { mvp: [], later: [] }, demo: null, confirm_request_id: 'HR-abc' })
  ok(emptyMvpPayload.ok === false && emptyMvpPayload.issues.some((i) => i.code === CATALOG_CODES.EMPTY_MVP), 'payload 里的空 MVP 也被拒（复用同一份校验器）')

  const s1 = summarizeProductDesign(goodPayload)
  ok(s1.includes('MVP 必须 2 条') && s1.includes('跳过'), '摘要写清了条数与"跳过 DEMO"', s1)
  const s2 = summarizeProductDesign({ catalog: goodCatalog(), demo: { kind: 'html' }, confirm_request_id: 'HR-abc' })
  ok(s2.includes('**含** DEMO'), '摘要如实说"本批含 DEMO"', s2)

  await rm(root, { recursive: true, force: true })

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`p5 总计：${passed}/${passed + failed} 通过`)
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
export async function runP5ProductCatalogCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ p5 运行失败（异常）：${err?.stack ?? err}`)
    // ★ 异常本身也算一次失败：崩了不能反而少一条，那会让通过率虚高。
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

// 直接跑：`node tests/p5-product-catalog-check.mjs` —— 行为与登记前逐字一致（打印原文 + 退出码，产品目录）。
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('p5-product-catalog-check.mjs')) {
  const r = await runP5ProductCatalogCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
