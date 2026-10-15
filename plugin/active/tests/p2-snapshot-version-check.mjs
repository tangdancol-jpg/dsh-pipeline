/**
 * p2 · 快照版本号：形态 + 进位 + **序数比较**（含"字符串排序会判错"的反例）
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/p2-snapshot-version-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（已登记，见 `WIRING.md` §W8）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * 覆盖的验收：A07（形态）、A08（进位 99→A-01、A-99→B-01）、A09（**序数比较 + 反例**）、
 *   A23 里与版本序数有关的部分，以及边界「段达 Z-99 报错并建议改用 git」「段格式非法 ⇒ 拒绝」。
 *
 * @module dsh-pipeline/tests/p2-snapshot-version-check
 */

import {
  MAX_SEGMENT_ORDINAL,
  datePartsOf,
  ordinalOfSegment,
  parseSnapshotVersion,
  segmentOfOrdinal,
} from '../lib/project/snapshot-parse.js'
import { SEGMENT_EXHAUSTED_ADVICE, nextSegment, nextSnapshotVersion } from '../lib/project/snapshot-next.js'
import {
  compareSnapshotVersions,
  latestSnapshot,
  latestSnapshotByStringSort,
  sortSnapshotVersions,
} from '../lib/project/snapshot-compare.js'
import { createSnapshotDir, listSnapshotVersions } from '../lib/project/snapshot-dir.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// 极简断言（自包含是可独立运行的前提）
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

/** 2026-10-15（定稿里用的那个日期）。 */
const OCT15 = new Date(2026, 9, 15, 12, 0, 0)

async function main() {
  lines.push('='.repeat(78))
  lines.push('p2 · 快照版本号：形态 + 进位 + 序数比较（含字符串排序反例）')
  lines.push('='.repeat(78))

  // ---- ① 形态：b.<年>.<月>.<日>.<段> ---------------------------------------
  lines.push('')
  lines.push('【① 形态 b.2026.10.15.01（A07）】')
  const first = nextSnapshotVersion({ now: OCT15 })
  ok(first.ok === true, '算得出第一个快照版本号', first.ok ? '' : first.message)
  eq(first.version, 'b.2026.10.15.01', '形态 = b.<年>.<月>.<日>.01')
  eq(first.segment, '01', '段 = 01（当天无快照则从 01 起）')
  const parts = datePartsOf(OCT15)
  ok(parts.year === 2026 && parts.month === 10 && parts.day === 15, '日期取建快照当日本机日期')

  // ---- ② 进位：99 → A-01、A-99 → B-01（A08）--------------------------------
  lines.push('')
  lines.push('【② 段进位 01…99 → A-01…A-99 → B-01（A08）】')
  const carries = [
    ['01', '02'],
    ['09', '10'],
    ['98', '99'],
    ['99', 'A-01'],
    ['A-01', 'A-02'],
    ['A-98', 'A-99'],
    ['A-99', 'B-01'],
    ['B-01', 'B-02'],
    ['Y-99', 'Z-01'],
    ['Z-98', 'Z-99'],
  ]
  for (const [from, to] of carries) {
    const r = nextSegment(from)
    ok(r.ok === true && r.segment === to, `${from} 的下一个是 ${to}`, r.ok ? `实际=${r.segment}` : r.message)
  }
  const carried = nextSegment('99')
  ok(carried.ok === true && carried.carried === true, '99 → A-01 被标成"进位"（carried=true）')
  const notCarried = nextSegment('01')
  ok(notCarried.ok === true && notCarried.carried === false, '01 → 02 不算进位')

  const fromExisting = nextSnapshotVersion({ segments: ['01', '02', '03'], now: OCT15 })
  eq(fromExisting.version, 'b.2026.10.15.04', '当天已有 01/02/03 ⇒ 下一个是 04')
  const after99 = nextSnapshotVersion({ segments: Array.from({ length: 99 }, (_, i) => String(i + 1).padStart(2, '0')), now: OCT15 })
  eq(after99.version, 'b.2026.10.15.A-01', '当天已满 99 个 ⇒ 下一个进位到 A-01')
  const afterA99 = nextSnapshotVersion({ segments: ['99', 'A-01', 'A-99'], now: OCT15 })
  eq(afterA99.version, 'b.2026.10.15.B-01', 'A-99 之后 ⇒ B-01')

  // 跨天：别的天的快照不影响今天的段（边界：跨天）
  const otherDay = nextSnapshotVersion({ existing: ['b.2026.10.14.99'], now: OCT15 })
  eq(otherDay.version, 'b.2026.10.15.01', '昨天已到 99，今天仍从 01 起（跨天）')

  // ---- ③ 序数换算 ----------------------------------------------------------
  lines.push('')
  lines.push('【③ 段 → 序数：01–99→1–99；A-01–A-99→101–199；B-01→201】')
  eq(ordinalOfSegment('01').ordinal, 1, '01 ⇒ 1')
  eq(ordinalOfSegment('99').ordinal, 99, '99 ⇒ 99')
  eq(ordinalOfSegment('A-01').ordinal, 101, 'A-01 ⇒ 101')
  eq(ordinalOfSegment('A-99').ordinal, 199, 'A-99 ⇒ 199')
  eq(ordinalOfSegment('B-01').ordinal, 201, 'B-01 ⇒ 201')
  eq(MAX_SEGMENT_ORDINAL, 2699, 'Z-99 ⇒ 2699（上界）')
  eq(segmentOfOrdinal(101).segment, 'A-01', '101 ⇒ A-01（反算一致）')
  eq(segmentOfOrdinal(201).segment, 'B-01', '201 ⇒ B-01（反算一致）')
  ok(ordinalOfSegment('A-01').ok === true && Number.isNaN(Number.parseInt('A-01', 10)),
    '★ 为什么不能拿 parseInt 当序数：parseInt("A-01") = NaN（NaN 与谁比都是 false ⇒ "最新"静默随机化）',
    `parseInt("A-01") = ${Number.parseInt('A-01', 10)}`)

  // ---- ④ ★★ 反例：字符串排序会判错"最新快照"（A09 的核心）------------------
  lines.push('')
  lines.push('【④ ★★ 反例：字符串排序会判错最新快照（A09）】')
  const mixed = ['b.2026.10.9.01', 'b.2026.10.15.01']
  const right = latestSnapshot(mixed)
  const wrong = latestSnapshotByStringSort(mixed)
  ok(right.ok === true && right.latest === 'b.2026.10.15.01', '正确实现（序数）判出最新 = 10 月 15 日', `实际=${right.latest}`)
  eq(wrong.latest, 'b.2026.10.9.01', '字符串排序判出的"最新" = 10 月 9 日（**这就是错的**）')
  ok(right.latest !== wrong.latest,
    '★ 两者结论**确实不同** —— 反例成立（字符串排序会把 10 月 9 日当成更新的那个）',
    `序数=${right.latest} 字符串=${wrong.latest}\n      原因：比较到第 9 个字符时 '1' < '9'，于是 "…10.15.01" 被排到 "…10.9.01" 前面`)

  const sameDay = ['b.2026.10.15.99', 'b.2026.10.15.A-01']
  const sameDayRight = latestSnapshot(sameDay)
  const sameDayWrong = latestSnapshotByStringSort(sameDay)
  ok(sameDayRight.latest === 'b.2026.10.15.A-01', '同一天内：A-01 比 99 新（序数）', `实际=${sameDayRight.latest}`)
  eq(sameDayWrong.latest, 'b.2026.10.15.A-01',
    '同一天内字符串序**恰好**与序数一致（' + "'9'<'A'" + '）—— 所以单看同一天，字符串排序的错**看不出来**；一到跨天就露馅')
  ok(sameDayRight.latest === sameDayWrong.latest,
    '★ 如实记录：设计定稿 §3.1 写的字面例子 `"A-01" < "01"` 在 JS 里**不成立**（实际是 "01" < "A-01"）；' +
      '但"字符串排序会判错最新"这个风险是真的 —— 分歧出在**日期段**（10.9 vs 10.15），上面那条已证')

  const cmpDir = compareSnapshotVersions('b.2026.10.15.01', 'b.2026.10.9.01')
  eq(cmpDir, 1, 'compare(10.15.01, 10.9.01) = 1（前者更新）')
  eq(compareSnapshotVersions('b.2026.10.15.01', 'b.2026.10.15.01'), 0, '同一个版本号 = 0')
  eq(compareSnapshotVersions('b.2026.10.15.99', 'b.2026.10.15.A-01'), -1, '99 早于 A-01')
  eq(compareSnapshotVersions('b.2026.10.15.A-99', 'b.2026.10.15.B-01'), -1, 'A-99 早于 B-01')
  eq(compareSnapshotVersions('b.2026.10.16.01', 'b.2026.10.15.Z-99'), 1, '★ 日期压过段：10.16.01 比 10.15.Z-99 新')

  const sorted = sortSnapshotVersions(['b.2026.10.15.A-01', 'b.2026.10.9.01', 'b.2026.10.15.01', 'b.2026.10.15.99'])
  ok(sorted.ok === true, '排序成功', sorted.ok ? '' : sorted.message)
  eq(JSON.stringify(sorted.sorted), JSON.stringify(['b.2026.10.9.01', 'b.2026.10.15.01', 'b.2026.10.15.99', 'b.2026.10.15.A-01']),
    '按序数升序：10.9 → 10.15.01 → 10.15.99 → 10.15.A-01')

  // ---- ⑤ 边界：Z-99 用尽 ⇒ 报错并建议改用 git（不静默回绕）-----------------
  lines.push('')
  lines.push('【⑤ 边界：段达 Z-99 ⇒ 报错 + 建议改用 git，不得静默回绕】')
  const exhausted = nextSegment('Z-99')
  ok(exhausted.ok === false && exhausted.code === 'SEGMENT_EXHAUSTED', 'Z-99 没有下一个段（SEGMENT_EXHAUSTED）')
  ok(String(exhausted.message).includes(SEGMENT_EXHAUSTED_ADVICE), '报错文案里**带上了**"改用 git"的建议')
  ok(!String(exhausted.message).includes('01 →') && !/回绕/.test(exhausted.segment ?? ''), '没有回绕成 01')
  const dayFull = nextSnapshotVersion({ segments: ['Z-99'], now: OCT15 })
  ok(dayFull.ok === false && dayFull.code === 'SEGMENT_EXHAUSTED', '当天已到 Z-99 ⇒ 拒绝新建（不覆盖 Z-99）')

  // ---- ⑥ 边界：段格式非法 ⇒ 拒绝（不靠猜测补位）-----------------------------
  lines.push('')
  lines.push('【⑥ 边界：段格式非法 ⇒ 拒绝并给可读原因】')
  for (const bad of ['', '0', '1', '0001', 'a-01', 'A-1', 'A-001', 'AA-01', '00', 'A-00', '  ', 'A_01']) {
    const r = ordinalOfSegment(bad)
    ok(r.ok === false, `非法段 ${JSON.stringify(bad)} 被拒（${r.code}）`, r.message)
  }
  ok(ordinalOfSegment('99').ok === true && ordinalOfSegment('A-01').ok === true, '合法段仍然通过（没有一刀切拒掉）')

  const badVersion = parseSnapshotVersion('b.2026.13.01.01')
  ok(badVersion.ok === false && badVersion.code === 'VERSION_BAD_DATE', '月份 13 被拒')
  const badPrefix = parseSnapshotVersion('v.2026.10.15.01')
  ok(badPrefix.ok === false && badPrefix.code === 'VERSION_BAD_PREFIX', '前缀不是 b 被拒')
  const badShape = parseSnapshotVersion('b.2026.10.15')
  ok(badShape.ok === false && badShape.code === 'VERSION_MALFORMED', '段数不对被拒')

  // ---- ⑦ 快照目录：命名 + 幂等（不覆盖）-------------------------------------
  lines.push('')
  lines.push('【⑦ 快照目录命名与幂等（同版本号已存在 ⇒ 不覆盖）】')
  const root = await mkdtemp(join(tmpdir(), 'dsh-p2-'))
  const made = await createSnapshotDir({ projectDir: root, version: 'b.2026.10.15.01' })
  ok(made.ok === true && made.created === true, '第一次建出来（created=true）', made.dir ?? made.message)
  eq(made.dir, join(root, 'b.2026.10.15.01'), '目录名 = 快照版本号本身')
  await writeFile(join(made.dir, 'keep.txt'), 'user data', 'utf8')
  const again = await createSnapshotDir({ projectDir: root, version: 'b.2026.10.15.01' })
  ok(again.ok === true && again.created === false && again.wrote === false, '第二次幂等：created=false、wrote=false（一个字节都没写）')
  ok(existsSync(join(made.dir, 'keep.txt')), '既有内容没被覆盖')
  const listed = await listSnapshotVersions(root)
  ok(listed.ok === true && listed.versions.length === 1 && listed.versions[0] === 'b.2026.10.15.01', '列目录能认出快照版本号')
  const escape = await createSnapshotDir({ projectDir: join(root, 'b.2026.10.15.01'), version: 'b.2026.10.15.02' })
  ok(escape.ok === true, '正常情况不误报逃逸', escape.ok ? '' : escape.message)

  await rm(root, { recursive: true, force: true })

  // ---- 汇总 -----------------------------------------------------------------
  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`p2 总计：${passed}/${passed + failed} 通过`)
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
export async function runP2SnapshotVersionCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ p2 运行失败（异常）：${err?.stack ?? err}`)
    // ★ 异常本身也算一次失败：崩了不能反而少一条，那会让通过率虚高。
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

// 直接跑：`node tests/p2-snapshot-version-check.mjs` —— 行为与登记前逐字一致（打印原文 + 退出码，快照版本号）。
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('p2-snapshot-version-check.mjs')) {
  const r = await runP2SnapshotVersionCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
