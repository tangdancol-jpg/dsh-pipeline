// 文件规模体检 · 只报告"谁大、大到什么程度"，把"拆不拆"留给人和评审判断。
/**
 * dsh-pipeline · 文件规模体检（报告，不是闸）
 * ============================================================================
 *     node tests/file-size-check.mjs
 *
 * ★ 设计哲学（`CONVENTIONS.md §4/§4.1`）：
 *   **为拆而拆没有意义。** 拆分的目的是"一个文件只有一个改动原因、读得完、评审看得出边界"；
 *   行数只是这个目的的一个**信号**。所以本套件：
 *     · 只**报告**：扫一遍源码/测试，列出超过预警线（400 行）的文件、总数、最大文件；
 *     · **不判红、不设基线、不登记** —— 它跑完永远是绿的，报告是给人看判断提示；
 *     · "该不该拆"由作者按 §4 四问自问、评审复核，机器不替人做这个判断。
 *
 * 唯一权衡（明确写下来，防止以后又长成官僚机器）：
 *   不建"基线/例外登记表"——那套会催生"为登记而登记"和"为不超线而删注释"的反向激励；
 *   想观察某个文件有没有变大，看 git diff 与评审就够了。
 *
 * @module dsh-pipeline/tests/file-size-check
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** 预警线：超过就列进报告，**不是**上限。 */
export const WARN_LINES = 400

/** 扫描范围（源码 + 测试；不扫文档/生成物/第三方）。 */
const SCAN_ROOTS = ['index.js', 'lib', 'presets', 'tools', 'tests']
const SKIP_DIRS = new Set(['node_modules', '.git', '.pipeline', 'generated', 'design', 'docs', 'locale', 'skills', 'examples', 'types'])
const CODE_EXT = /\.(js|mjs|cjs)$/

/** 递归收集文件（相对路径用 `/`）。 */
function walk(relPath, out) {
  const full = join(ROOT, relPath)
  let st
  try {
    st = statSync(full)
  } catch {
    return
  }
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(full.split(sep).pop())) return
    for (const name of readdirSync(full)) walk(`${relPath}/${name}`, out)
    return
  }
  if (CODE_EXT.test(relPath)) out.push(relPath)
}

/** 文件行数（与 `wc -l` 同口径）。 */
export function countLines(relPath) {
  const text = readFileSync(join(ROOT, relPath), 'utf8')
  if (text.length === 0) return 0
  const parts = text.split('\n')
  return text.endsWith('\n') ? parts.length - 1 : parts.length
}

/**
 * 纯函数：把 `[{path, lines}]` 变成一份**报告**（排序 + 统计），不产生任何失败。
 *
 * @param {Array<{path:string, lines:number}>} files
 * @returns {{rows:Array<{path:string,lines:number}>, over:Array<{path:string,lines:number}>, total:number, totalLines:number, max:object|null}}
 */
export function report(files) {
  const rows = (Array.isArray(files) ? files : [])
    .map((f) => ({ path: String(f.path ?? ''), lines: Number(f.lines ?? 0) }))
    .filter((f) => f.path !== '')
    .sort((a, b) => (b.lines - a.lines || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
  return {
    rows,
    over: rows.filter((r) => r.lines > WARN_LINES),
    total: rows.length,
    totalLines: rows.reduce((a, r) => a + r.lines, 0),
    max: rows.length > 0 ? rows[0] : null,
  }
}

/** 跑整套（导出给 registry；单独运行也行）。**永远全绿**，报告是给人看的。 */
export async function runFileSizeCheck() {
  const items = []
  const add = (name, pass, detail) => items.push({ name, pass: pass === true, detail: String(detail ?? '') })

  const files = []
  for (const root of SCAN_ROOTS) walk(root, files)
  const rows = files.map((path) => ({ path, lines: countLines(path) }))
  const rep = report(rows)

  add('A1 扫描到源码/测试文件', rep.total > 100, `${rep.total} 个文件，合计 ${rep.totalLines} 行`)
  add('A2 最大文件已知（只报告）', rep.max !== null, rep.max === null ? '—' : `${rep.max.path}（${rep.max.lines} 行）`)
  add(
    'A3 超过预警线（400 行）的文件已列出（**只报告，不判红**）',
    Array.isArray(rep.over),
    rep.over.length === 0 ? '无' : `${rep.over.length} 个：${rep.over.slice(0, 8).map((r) => r.path).join(', ')}${rep.over.length > 8 ? '…' : ''}`,
  )

  // ---- C. 判据自证：报告函数本身的正确性（排序 / 过滤 / 统计） ----
  const fake = report([
    { path: 'lib/a.js', lines: 120 },
    { path: 'lib/b.js', lines: 650 },
    { path: 'lib/c.js', lines: 401 },
    { path: 'lib/d.js', lines: 400 },
  ])
  const orderOk = fake.rows.map((r) => r.path).join(',') === 'lib/b.js,lib/c.js,lib/d.js,lib/a.js'
  add('C1 合成输入：按行数降序排列', orderOk, fake.rows.map((r) => `${r.path}:${r.lines}`).join(' '))
  add('C2 合成输入：超过 400 才进报告（400 不算超）', fake.over.length === 2 && fake.over.every((r) => r.lines > 400), fake.over.map((r) => `${r.path}:${r.lines}`).join(' '))
  add('C3 合成输入：统计正确（文件数 / 总行数）', fake.total === 4 && fake.totalLines === 1571, `total=${fake.total} lines=${fake.totalLines}`)
  add('C4 合成输入：空输入不崩、不误报', report([]).total === 0 && report([]).max === null, 'report([])')

  const passed = items.filter((i) => i.pass).length
  const lines = []
  lines.push('# 文件规模体检（报告：大小是信号，不是死限）')
  lines.push('')
  for (const i of items) lines.push(`${i.pass ? '✓' : '✗'} ${i.name}${i.detail === '' ? '' : `　｜ ${i.detail}`}`)
  lines.push('')
  lines.push(`扫描 ${rep.total} 个文件（${rep.totalLines} 行）；最大 ${rep.max === null ? '—' : `${rep.max.path}（${rep.max.lines} 行）`}`)
  if (rep.over.length > 0) {
    lines.push('')
    lines.push(`## 超过预警线 ${WARN_LINES} 行的文件（${rep.over.length} 个 —— 看一眼要不要拆；为拆而拆没有意义）`)
    for (const r of rep.over.slice(0, 25)) lines.push(`- ${r.path}：${r.lines} 行`)
    if (rep.over.length > 25) lines.push(`- …… 其余 ${rep.over.length - 25} 个省略`)
    lines.push('')
    lines.push('判断依据是 `CONVENTIONS §4` 四问：改动原因是否单一 / 能否一句话命名 / 评审能否看出边界 / 并行改动是否撞车。')
  }
  lines.push('')
  lines.push(`总计：${passed}/${items.length} 通过（本套件只报告，不判红）`)
  return { passed, total: items.length, text: lines.join('\n') }
}

// ---------------------------------------------------------------- CLI
const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('file-size-check.mjs')
if (invokedDirectly) {
  const result = await runFileSizeCheck()
  console.log(result.text)
  process.exit(result.passed === result.total ? 0 : 1)
}
