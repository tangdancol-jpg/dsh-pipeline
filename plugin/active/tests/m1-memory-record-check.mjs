/**
 * m1 · 记忆 · **一条记忆的规范形状与校验**（+ 记忆库落点、迁移记忆的形状）
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/m1-memory-record-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（登记点见 `WIRING.md` §W11）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * ---------------------------------------------------------------------------
 * 本文件只测一件事
 * ---------------------------------------------------------------------------
 * **"一条记忆长什么样"** —— 合法形状被接受、畸形被**点名拒绝**，
 * 外加判据 R16（库落在 `<project_dir>/.pipeline/_memory/`，不落别处）。
 *
 * ★ 为什么"拒绝"要单独测：记忆库是 JSONL，**一行写坏了那行就永远读不回来** ——
 *   校验如果松（比如放过了裸换行），坏数据是**写进去之后**才发现的。
 *
 * @module dsh-pipeline/tests/m1-memory-record-check
 */

import { join } from 'node:path'

import { MEMORY_DIR_NAME, MEMORY_FILE_NAME, memoryDir, memoryFile, resolveBank } from '../lib/memory/bank.js'
import { projectLayout } from '../lib/project/layout.js'
import { KIND, REF_FIELDS, TEXT_MAX, emptyRefs, makeRecord, toJsonlLine, validateRecord } from '../lib/memory/record.js'
import { transitionRecord } from '../lib/memory/retain-transition.js'

let passed = 0
let failed = 0
const lines = []

function ok(cond, title, detail = '') {
  if (cond) {
    passed += 1
    lines.push(`  ✓ ${title}`)
  } else {
    failed += 1
    lines.push(`  ✗ ${title}`)
  }
  if (detail.length > 0) lines.push(`      ${detail}`)
}

/** 一条**合法**的记忆（下面所有非法用例都是从它出发改一处）。 */
const good = () =>
  makeRecord({
    id: 'task:T-20260101-aaaa',
    at: '2026-01-01T10:00:00Z',
    kind: KIND.TASK,
    text: '任务 T-20260101-aaaa｜已关闭（closed）',
    entity: ['task:T-20260101-aaaa', 'state:closed', 'task:T-20260101-aaaa'],
    refs: emptyRefs({ task_id: 'T-20260101-aaaa', state: 'closed', state_label: '已关闭' }),
  })

async function main() {
  lines.push('='.repeat(78))
  lines.push('m1 · 记忆：规范形状与校验（+ 库落点 R16）')
  lines.push('='.repeat(78))

  // ---- ① 合法形状 ---------------------------------------------------------
  lines.push('')
  lines.push('【① 合法形状被接受，且字段归一（去重 + 排序）】')
  const made = good()
  ok(made.ok === true, '完整字段 ⇒ 造得出来', made.ok === true ? `id=${made.record.id}` : JSON.stringify(made.errors))
  const rec = made.record
  ok(rec.entity.length === 2, '`entity` 去重（同一条喂两遍只留一个）', JSON.stringify(rec.entity))
  ok(JSON.stringify(rec.entity) === JSON.stringify([...rec.entity].sort()), '`entity` 排序（顺序不同不该算两条 ⇒ 确定性）')
  for (const f of REF_FIELDS) ok(Object.hasOwn(rec.refs, f), `\`refs.${f}\` 一定存在（缺一个就是"半条记忆"）`)
  ok(toJsonlLine(rec).endsWith('\n') && toJsonlLine(rec).split('\n').length === 2, '序列化成**恰好一行** JSONL（结尾一个换行）', toJsonlLine(rec).slice(0, 80))

  // ---- ② 畸形被拒绝（逐条点名） -------------------------------------------
  lines.push('')
  lines.push('【② 畸形**逐条点名拒绝**（不是"静默丢弃"）】')
  const cases = [
    ['缺 id', { ...rec, id: '' }],
    ['id 类型错', { ...rec, id: 123 }],
    ['at 解析不出时刻', { ...rec, at: '昨天' }],
    ['kind 形状不合法', { ...rec, kind: 'Task Kind!' }],
    ['scope 不是 project', { ...rec, scope: 'global' }],
    ['text 为空', { ...rec, text: '   ' }],
    ['text 超上限', { ...rec, text: 'x'.repeat(TEXT_MAX + 50) }],
    ['text 里有裸换行', { ...rec, text: '第一行\n第二行' }],
    ['entity 不是数组', { ...rec, entity: 'task:x' }],
    ['entity 项没有前缀', { ...rec, entity: ['T-1'] }],
    ['refs 缺字段', { ...rec, refs: { task_id: 'T-1' } }],
    ['refs.paths 不是数组', { ...rec, refs: { ...rec.refs, paths: 'a.js' } }],
    ['不是对象', null],
  ]
  for (const [label, bad] of cases) {
    const v = validateRecord(bad)
    ok(v.ok === false, `${label} ⇒ 被拒`, v.ok === false ? v.errors[0] : '（竟然放过了）')
  }
  const clipped = makeRecord({ id: 'tool:x', at: '2026-01-01T00:00:00Z', kind: KIND.TOOL, text: 'y'.repeat(TEXT_MAX + 50) })
  ok(clipped.ok === true && clipped.record.text.length <= TEXT_MAX, '`makeRecord` 把超长正文截到上限（摘要在构造期就定形）', `长度=${clipped.ok ? clipped.record.text.length : '（没造出来）'} ≤ ${TEXT_MAX}`)
  const newline = makeRecord({ id: 'tool:x', at: '2026-01-01T00:00:00Z', kind: KIND.TOOL, text: '第一行\n第二行' })
  ok(newline.ok === true && !/[\r\n]/.test(newline.record.text), '构造器把换行折成空格（JSONL 一行一条的硬要求）', JSON.stringify(newline.record.text))

  // ---- ③ 落点（R16） ------------------------------------------------------
  lines.push('')
  lines.push('【③ R16：库落在 `<project_dir>/.pipeline/_memory/`，不落别处】')
  const projectDir = join('C:', 'proj', 'demo')
  const layout = projectLayout(projectDir)
  ok(memoryDir(projectDir) === join(layout.pipelineDir, MEMORY_DIR_NAME), '`memoryDir` = `projectLayout().pipelineDir` + `_memory`（复用既有布局，不手拼）', memoryDir(projectDir))
  ok(memoryFile(projectDir) === join(memoryDir(projectDir), MEMORY_FILE_NAME), '`memoryFile` = 库目录 + `memory.jsonl`', memoryFile(projectDir))
  ok(memoryDir(projectDir).includes(`${'.pipeline'}`) && MEMORY_DIR_NAME.startsWith('_'), '下划线前缀 + 落在 `.pipeline` 内（与 `T-*` 任务目录不冲突，设计 04 §8.4）', MEMORY_DIR_NAME)
  const noDir = resolveBank('')
  ok(noDir.ok === false && noDir.reason.length > 0 && noDir.memoryDir === '', '取不到项目目录 ⇒ `ok:false` + `reason`（**不猜落点、不建目录**）', `reason=${noDir.reason}`)

  // ---- ④ 迁移记忆的形状（retain-transition） ------------------------------
  lines.push('')
  lines.push('【④ 状态迁移 → 记忆：形状合法，且复用既有措辞（不写第二份）】')
  const moved = transitionRecord({
    task: { id: 'T-1', state: 'developing', history: [{ event: 'dev_submitted', at: '2026-01-01T10:00:00Z' }] },
    from: 'ready_dev',
    to: 'developing',
    event: 'dev_submitted',
    at: '2026-01-01T10:00:00Z',
    by: 'writer',
  })
  ok(moved.ok === true, '迁移 ⇒ 造得出一条合法记忆', moved.ok === true ? `kind=${moved.record.kind}` : JSON.stringify(moved.errors))
  ok(moved.ok === true && moved.record.kind === KIND.TRANSITION, '`kind = transition`（recall 才答得出"上次怎么走到这一步的"）', moved.ok === true ? moved.record.kind : '')
  ok(moved.ok === true && moved.record.text.includes('→') && moved.record.text.includes('开发中'), '正文含"从哪到哪"（状态标签走 `STATE_LABEL`，不是手抄）', moved.ok === true ? moved.record.text : '')
  ok(moved.ok === true && moved.record.refs.roles.includes('role:writer'), '`refs.roles` 记下"谁推的"，且**归一**成 `role:writer`', moved.ok === true ? JSON.stringify(moved.record.refs.roles) : '')
  const same = transitionRecord({
    task: { id: 'T-1', state: 'pending', hub: { entry: { by: 'main', at: '2026-01-01T11:00:00Z' } }, history: [] },
    from: 'pending',
    to: 'pending',
    event: 'handoff_to_supervisor',
    at: '2026-01-01T11:00:00Z',
    by: 'main',
  })
  ok(same.ok === true && same.record.text.includes('状态未变'), '`from === to` 的迁移也进得来，并如实写"状态未变"', same.ok === true ? same.record.text.slice(0, 90) : '')
  ok(
    same.ok === true && same.record.text.includes('已记录'),
    '★ 复用了 `lib/store/transition-record.js` 的产物（"已记录 + 台账在哪"那句）—— 不另写一份措辞',
    same.ok === true ? same.record.text.slice(-60) : '',
  )
  const badMove = transitionRecord({ task: { id: 'T-1' }, from: 'ready_dev', to: 'developing', event: 'x', at: '不是时刻' })
  ok(badMove.ok === false && badMove.errors.length > 0, '时刻不合法 ⇒ 拒绝（迁移记忆同样过校验器）', JSON.stringify(badMove.errors))

  // ---- ⑤ 判据自检：这套断言**真的会红** -----------------------------------
  lines.push('')
  lines.push('【⑤ 判据自检：把"放过畸形"的输入打给同一条判据 ⇒ 必须红】')
  const loose = { ...rec, refs: { ...rec.refs, paths: 'not-an-array' } }
  ok(validateRecord(loose).ok === false, '★ 把 `refs.paths` 改成字符串 ⇒ 判据 ② 判红（证明它不是恒真）', (validateRecord(loose).errors[0] ?? ''))
  ok(validateRecord({ ...rec, kind: 'Ok' }).ok === false, '★ 大写开头的 kind ⇒ 判红（形状是写死的，不是"看起来像就行"）', (validateRecord({ ...rec, kind: 'Ok' }).errors[0] ?? ''))

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`m1 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))
  return { passed, total: passed + failed, text: lines.join('\n') }
}

/**
 * 聚合跑入口（`tests/run-all.mjs` 登记用）。断言、计数与"直接跑"**同一条路径**。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runM1MemoryRecordCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ m1 运行失败（异常）：${err?.stack ?? err}`)
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('m1-memory-record-check.mjs')) {
  const r = await runM1MemoryRecordCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
