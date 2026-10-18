// 文件规模闸 · 把 `CONVENTIONS.md §4/§5` 的「不写大文件」从文档变成**可执行判据**。
/**
 * dsh-pipeline · 文件规模闸（机器闸）
 * ============================================================================
 *     node tests/file-size-check.mjs
 *
 * 为什么要有这个文件：`CONVENTIONS.md §4` 写的是"新增文件 ≤400 行、超了要自证"，
 * 但它此前只是**文档**——文档不会红，模型会反复把同一件事堆回大文件里。
 * 本套件把它变成可执行的闸：扫描 + 登记表 + 只降不升，任何"又写大了"当场判红。
 *
 * 判据唯一来源（不要在本文件里另抄一份规则）：
 *   · `tests/file-size-exceptions.json` —— 登记表（limit / paddingBand / 扫描范围 / 例外 + maxLines）
 *   · 设计说明：`design/conventions/01-文件规模闸.md`
 *
 * 四条判据：
 *   ① 未登记的文件必须 ≤ limit（超限 = 红）；
 *   ② 未登记的文件不得落在 paddingBand（390–400，那多半是"删到最后刚好不超"的顶格凑数）；
 *   ③ 登记文件不得增长（当前行数 ≤ 登记的 maxLines；maxLines 只允许下调）；
 *   ④ 登记项指向的文件必须存在（否则是过期条目 = 红）。
 *
 * @module dsh-pipeline/tests/file-size-check
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const EXC_FILE = join(HERE, 'file-size-exceptions.json')

/** 扫描时必须跳过的目录名（运行期数据/第三方/生成物）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.pipeline', 'generated', 'design', 'docs', 'locale', 'skills', 'examples', 'types'])

/** 只认这些扩展名（规则针对源码/测试，不针对数据文件）。 */
const CODE_EXT = /\.(js|mjs|cjs)$/

/** 递归收集待扫描文件（相对路径用 `/`，跨平台一致）。 */
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

/** 文件行数（与 `wc -l` 同口径：最后一行没有换行符也算一行）。 */
export function countLines(relPath) {
  const text = readFileSync(join(ROOT, relPath), 'utf8')
  if (text.length === 0) return 0
  const parts = text.split('\n')
  return text.endsWith('\n') ? parts.length - 1 : parts.length
}

/**
 * 纯函数：拿"文件行数表 + 登记表"判红（便于单测，不碰盘）。
 *
 * @param {object} input
 * @param {number} input.limit
 * @param {number[]} input.paddingBand
 * @param {Array<{path:string,maxLines:number,allowPadding?:boolean}>} input.exceptions
 * @param {Array<{path:string,lines:number}>} input.files
 * @returns {{offenders:Array<{path:string,code:string,detail:string}>, summary:{files:number,exceptions:number,maxFile:string}}}
 */
export function evaluate({ limit, paddingBand, exceptions, files }) {
  const byPath = new Map()
  for (const e of Array.isArray(exceptions) ? exceptions : []) byPath.set(String(e.path ?? ''), e)
  const offenders = []
  let maxFile = ''
  let maxLines = -1
  for (const f of Array.isArray(files) ? files : []) {
    const path = String(f.path ?? '')
    const lines = Number(f.lines ?? 0)
    if (!(lines > maxLines)) continue
    maxLines = lines
    maxFile = path
  }
  for (const f of Array.isArray(files) ? files : []) {
    const path = String(f.path ?? '')
    const lines = Number(f.lines ?? 0)
    const reg = byPath.get(path)
    const inBand = lines >= Number(paddingBand[0]) && lines <= Number(paddingBand[1])
    if (reg === undefined) {
      if (lines > limit) offenders.push({ path, code: 'OVERSIZE_UNREGISTERED', detail: `${lines} 行 > ${limit}，且未在 exceptions 登记` })
      else if (inBand) offenders.push({ path, code: 'PADDING_UNREGISTERED', detail: `${lines} 行落在 ${paddingBand[0]}–${paddingBand[1]} 顶格带` })
      continue
    }
    const max = Number(reg.maxLines ?? 0)
    if (!(lines <= max)) offenders.push({ path, code: 'GROWTH', detail: `${lines} 行 > 登记的 maxLines=${max}（大文件只降不升）` })
    if (inBand && reg.allowPadding !== true) offenders.push({ path, code: 'PADDING_NOT_ALLOWED', detail: `${lines} 行落在顶格带，但登记项没有 allowPadding` })
  }
  for (const [path] of byPath) {
    if (!files.some((f) => String(f.path ?? '') === path)) offenders.push({ path, code: 'STALE', detail: '登记项指向的文件不存在（过期条目，删掉它）' })
  }
  return { offenders, summary: { files: (files ?? []).length, exceptions: byPath.size, maxFile: maxFile === '' ? '—' : `${maxFile}（${maxLines} 行）` } }
}

/** 跑整套（导出给 registry；单独运行也行）。 */
export async function runFileSizeCheck() {
  const items = []
  const add = (name, pass, detail) => items.push({ name, pass: pass === true, detail: String(detail ?? '') })

  // ---- A. 登记表自身 ----
  let doc = null
  try {
    doc = JSON.parse(readFileSync(EXC_FILE, 'utf8'))
  } catch (err) {
    add('A1 exceptions.json 可解析', false, String(err?.message ?? err))
  }
  if (doc !== null) {
    add('A1 exceptions.json 可解析', true, EXC_FILE.replace(ROOT, '.'))
    add(
      'A2 登记表字段齐全（version/limit/paddingBand/scan/exceptions）',
      doc.version === 1 && Number.isFinite(doc.limit) && Array.isArray(doc.paddingBand) && doc.paddingBand.length === 2 && Array.isArray(doc.scan) && Array.isArray(doc.exceptions),
      `limit=${doc.limit} band=${JSON.stringify(doc.paddingBand)} scan=${JSON.stringify(doc.scan)} 例外=${doc.exceptions?.length ?? '?'}`,
    )
    const badEntry = (doc.exceptions ?? []).filter((e) => typeof e?.path !== 'string' || !Number.isFinite(e?.maxLines) || typeof e?.why !== 'string' || e.why.trim().length === 0)
    add('A3 每个登记项都有 path/maxLines/why（why 是自证，不许空）', badEntry.length === 0, badEntry.map((e) => e?.path).join(', ') || `${doc.exceptions.length} 项`)
  } else {
    add('A2 登记表字段齐全（version/limit/paddingBand/scan/exceptions）', false, '登记表解析失败，跳过')
    add('A3 每个登记项都有 path/maxLines/why（why 是自证，不许空）', false, '登记表解析失败，跳过')
  }

  // ---- B. 扫描 + 判据 ----
  const files = []
  for (const entry of doc?.scan ?? ['index.js', 'lib']) walk(entry, files)
  const rows = files.map((path) => ({ path, lines: countLines(path) }))
  const result = evaluate({ limit: doc.limit, paddingBand: doc.paddingBand, exceptions: doc.exceptions, files: rows })
  const offenders = result.offenders

  add('B1 扫描到源码/测试文件', rows.length > 100, `扫描 ${rows.length} 个文件，最大 ${result.summary.maxFile}`)
  add(
    'B2 未登记的超限文件 = 0（超限必须拆，或按 §4 必要性登记并写 why）',
    offenders.filter((o) => o.code === 'OVERSIZE_UNREGISTERED').length === 0,
    offenders.filter((o) => o.code === 'OVERSIZE_UNREGISTERED').map((o) => `${o.path}: ${o.detail}`).join('；') || `limit=${doc.limit}`,
  )
  add(
    'B3 未登记的顶格文件（390–400）= 0（禁止"删到最后刚好不超"的凑数）',
    offenders.filter((o) => o.code === 'PADDING_UNREGISTERED').length === 0,
    offenders.filter((o) => o.code === 'PADDING_UNREGISTERED').map((o) => `${o.path}: ${o.detail}`).join('；') || '无',
  )
  add(
    'B4 已登记的大文件没有增长（只降不升）',
    offenders.filter((o) => o.code === 'GROWTH').length === 0,
    offenders.filter((o) => o.code === 'GROWTH').map((o) => `${o.path}: ${o.detail}`).join('；') || `${doc.exceptions.length} 项登记均未增长`,
  )
  add(
    'B5 登记项没有过期条目（指向的文件都存在）',
    offenders.filter((o) => o.code === 'STALE').length === 0,
    offenders.filter((o) => o.code === 'STALE').map((o) => `${o.path}: ${o.detail}`).join('；') || '无',
  )
  add(
    'B6 顶格带内只允许登记过的旧文件（allowPadding）',
    offenders.filter((o) => o.code === 'PADDING_NOT_ALLOWED').length === 0,
    offenders.filter((o) => o.code === 'PADDING_NOT_ALLOWED').map((o) => `${o.path}: ${o.detail}`).join('；') || '无',
  )

  // ---- C. 判据自证（合成输入，证明闸真的有牙） ----
  const fake = evaluate({
    limit: 400,
    paddingBand: [390, 400],
    exceptions: [
      { path: 'lib/big.js', maxLines: 450, why: '测试' },
      { path: 'lib/old.js', maxLines: 398, allowPadding: true, why: '测试' },
      { path: 'lib/grown.js', maxLines: 450, why: '测试：登记后仍增长 ⇒ GROWTH' },
      { path: 'lib/gone.js', maxLines: 500, why: '测试：文件不存在 ⇒ 过期登记' },
    ],
    files: [
      { path: 'lib/ok.js', lines: 120 },
      { path: 'lib/big.js', lines: 450 },
      { path: 'lib/old.js', lines: 398 },
      { path: 'lib/new-big.js', lines: 401 },
      { path: 'lib/new-band.js', lines: 395 },
      { path: 'lib/grown.js', lines: 460 },
    ],
  })
  const codes = new Set(fake.offenders.map((o) => `${o.code}:${o.path}`))
  add('C1 合成输入：未登记超限必红', codes.has('OVERSIZE_UNREGISTERED:lib/new-big.js'), [...codes].join(' '))
  add('C2 合成输入：未登记顶格必红', codes.has('PADDING_UNREGISTERED:lib/new-band.js'), 'lib/new-band.js 395 行')
  add('C3 合成输入：登记文件增长必红', codes.has('GROWTH:lib/grown.js'), 'lib/grown.js 460 > 登记 maxLines=450')
  add('C4 合成输入：过期登记必红', codes.has('STALE:lib/gone.js'), 'lib/gone.js 登记了但文件不存在')
  add('C5 合成输入：合法登记 + 未超限文件不误伤', !codes.has('OVERSIZE_UNREGISTERED:lib/big.js') && !codes.has('PADDING_NOT_ALLOWED:lib/old.js'), [...codes].join(' '))

  const passed = items.filter((i) => i.pass).length
  const lines = []
  lines.push('# 文件规模闸（CONVENTIONS §4/§5 的机器执行）')
  lines.push('')
  for (const i of items) lines.push(`${i.pass ? '✓' : '✗'} ${i.name}${i.detail === '' ? '' : `　｜ ${i.detail}`}`)
  lines.push('')
  lines.push(`扫描 ${rows.length} 个文件；登记 ${doc?.exceptions?.length ?? 0} 项；最大 ${result.summary.maxFile}`)
  if (offenders.length > 0) {
    lines.push('')
    lines.push('## 红项（怎么修）')
    for (const o of offenders) {
      const fix = o.code === 'GROWTH' ? '把新逻辑拆到新文件，或把登记 maxLines 下调' : o.code === 'STALE' ? '删掉这条过期登记' : '按职责拆文件；确有 §4 ①②③④ 必要性 ⇒ 在 exceptions 登记并写 why'
      lines.push(`- [${o.code}] ${o.path}：${o.detail} ⇒ ${fix}`)
    }
  }
  lines.push('')
  lines.push(`总计：${passed}/${items.length} 通过`)
  return { passed, total: items.length, text: lines.join('\n') }
}

// ---------------------------------------------------------------- CLI
const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('file-size-check.mjs')
if (invokedDirectly) {
  const result = await runFileSizeCheck()
  console.log(result.text)
  process.exit(result.passed === result.total ? 0 : 1)
}
