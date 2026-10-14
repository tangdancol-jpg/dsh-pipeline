#!/usr/bin/env node
/**
 * dsh-pipeline · **两棵树同步器（只写区内 + 输出待同步清单）**
 * ============================================================================
 * 现场（2026-10-12，B11）：任务 `T-20261011-5a871c` 的编写席有一份脚本
 * `reports/writer/sync-trees.cjs`，第 20–21 行把两棵树**写死**：
 *
 *   · `ACTIVE` = 生效副本  `<profile>/node_modules/dsh-pipeline`
 *   · `SOURCE` = 源码树    `~\.dsh\dsh_orb\新任务-…\dsh-pipeline`  ← **区外**
 *
 * 而 `--write` 会把生效副本里本单改动的 7 个文件**逐个复制进源码树** ——
 * 也就是"本单只被授权改区内（profile 内）的文件，脚本却替它写到了区外"。
 *
 * 本脚本改成两条硬纪律：
 *   ① **只写区内**：目标路径必须落在"允许写根"（默认 = profile 目录）之内；
 *      任何区外目标**一律不写**，只进"待同步清单"，由人拍板后再手动处理；
 *   ② **输出待同步清单**：`--plan`（默认）只打印"哪棵树里的哪个文件相对另一棵
 *      是新的/内容不同的"，附两边 sha256 与大小 —— 人能照着核，脚本不替人做决定。
 *
 * 用法：
 *   node tools/sync-trees.cjs --plan                     # 只看清单（默认，零写入）
 *   node tools/sync-trees.cjs --plan --files a.js,b.js   # 只看这几个文件的差异
 *   node tools/sync-trees.cjs --write --to active        # 把**源码树**里更新的文件写进生效副本
 *   node tools/sync-trees.cjs --write --to source        # 会被拒（源码树在区外）—— 打印待同步清单
 *
 * 退出码：0 = 成功（含"被纪律挡下，只输出了清单"）；1 = 参数/环境错误。
 *
 * @module dsh-pipeline/tools/sync-trees
 */

const { createHash } = require('node:crypto')
const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')

const HERE = __dirname
/** 本插件的包根（= 生效副本本身）。**不再写死**：由脚本自身位置推出来。 */
const ACTIVE = resolve(HERE, '..')
/**
 * ★ 允许写的根（区内）：默认 = 插件所在 profile 目录。
 * 可用 `--within <绝对路径>` 覆盖；**区外一律不写**。
 */
const PROFILE_DIR = process.env.DSH_PROFILE_DIR && process.env.DSH_PROFILE_DIR.length > 0
  ? resolve(process.env.DSH_PROFILE_DIR)
  : resolve(ACTIVE, '..', '..')

function parseArgs(argv) {
  const out = { mode: 'plan', to: 'active', files: [], within: PROFILE_DIR, source: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--plan') out.mode = 'plan'
    else if (a === '--write') out.mode = 'write'
    else if (a === '--to') out.to = String(argv[++i] ?? '')
    else if (a === '--files') out.files = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    else if (a === '--within') out.within = resolve(String(argv[++i] ?? ''))
    else if (a === '--source') out.source = resolve(String(argv[++i] ?? ''))
    else if (a === '--help' || a === '-h') out.help = true
    else {
      console.error(`未知参数：${a}`)
      process.exit(1)
    }
  }
  return out
}

const hashOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const insideOf = (root, p) => {
  const rel = relative(root, p)
  return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel))
}
/** 列出包内"真实源码文件"（跳过备份/临时件）。 */
function listFiles(root, skipRe = /(\.bak|\.wip|\.tmp|\.log)[-.]/i) {
  const out = []
  const walk = (d) => {
    let ents = []
    try {
      ents = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        walk(p)
      } else if (!skipRe.test(e.name)) out.push(p)
    }
  }
  walk(root)
  return out
}

function planOne(fromRoot, toRoot, files) {
  const rows = []
  const rels = files !== null && files.length > 0 ? files.map((f) => f.replace(/\//g, sep)) : null
  const candidates = rels !== null ? rels : listFiles(fromRoot).map((p) => relative(fromRoot, p))
  for (const rel of candidates) {
    const a = join(fromRoot, rel)
    const b = join(toRoot, rel)
    const ha = existsSync(a) ? hashOf(a) : null
    const hb = existsSync(b) ? hashOf(b) : null
    if (ha === hb) continue
    rows.push({
      rel: rel.replace(/\\/g, '/'),
      from_sha256: ha,
      to_sha256: hb,
      from_size: ha === null ? null : statSync(a).size,
      to_size: hb === null ? null : statSync(b).size,
      verdict: hb === null ? '目标缺这一份' : ha === null ? '来源缺这一份' : '两边内容不同',
    })
  }
  return rows
}

function main() {
  const args = parseArgs(process.argv)
  if (args.help === true) {
    console.log('用法：node tools/sync-trees.cjs --plan [--files a.js,b.js] [--source <源码树>] [--within <允许写根>]')
    console.log('      node tools/sync-trees.cjs --write --to active|source')
    return 0
  }
  const source = args.source ?? process.env.DSH_PIPELINE_SOURCE ?? null
  console.log(`生效副本（区内）：${ACTIVE}`)
  console.log(`允许写根（区内）：${args.within}`)
  console.log(`源码树          ：${source ?? '（未给 --source / DSH_PIPELINE_SOURCE：只做区内检查）'}`)
  console.log('')

  if (source === null) {
    console.log('★ 没有给出源码树 ⇒ 只输出"区内自检"：本脚本**不会**写任何区外路径。')
    const files = args.files.length > 0 ? args.files : null
    const rows = planOne(ACTIVE, ACTIVE, files)
    console.log(`区内文件数（跳过备份件）：${listFiles(ACTIVE).length}　差异行：${rows.length}`)
    return 0
  }

  // ★ 纪律①：`--to source` = 往区外写 ⇒ **直接拒**，只给待同步清单。
  if (args.mode === 'write' && args.to === 'source') {
    console.log('★ **拒绝写入**：目标（源码树）在允许写根之外。')
    console.log(`  允许写根：${args.within}`)
    console.log(`  目标    ：${source}`)
    console.log('')
    console.log('★ 为什么不写：本单只被授权改**区内**的文件；"顺手把区外也同步了"正是 B11 的现场。')
    console.log('  下面给出**待同步清单** —— 要同步请由人拍板后手动处理，或显式放宽 --within。')
    console.log('')
    const rows = planOne(ACTIVE, source, args.files)
    printRows(rows, ACTIVE, source)
    return 0
  }

  const target = args.to === 'source' ? source : ACTIVE
  const from = args.to === 'source' ? ACTIVE : source
  if (!insideOf(args.within, target)) {
    console.log(`★ **拒绝写入**：目标 ${target} 不在允许写根 ${args.within} 之内。`)
    console.log('  下面是待同步清单（只列不改）：')
    printRows(planOne(from, target, args.files), from, target)
    return 0
  }

  const rows = planOne(from, target, args.files)
  if (args.mode === 'plan') {
    console.log('★ --plan：**零写入**，只列差异。')
    printRows(rows, from, target)
    return 0
  }
  console.log(`★ --write：来源 ${from} → 目标 ${target}（区内）`)
  printRows(rows, from, target)
  for (const r of rows) {
    if (r.from_sha256 === null) continue
    const dst = join(target, r.rel)
    writeFileSync(dst, readFileSync(join(from, r.rel)))
    console.log(`  已写：${r.rel}  sha256=${hashOf(dst).slice(0, 16)}…`)
  }
  return 0
}

function printRows(rows, from, to) {
  if (rows.length === 0) {
    console.log('  （无差异）')
    return
  }
  console.log(`  待同步清单（${rows.length} 条）　来源=${from}`)
  console.log(`                        目标=${to}`)
  for (const r of rows) {
    console.log(
      `  · ${r.rel}\n` +
        `      来源 sha256=${String(r.from_sha256).slice(0, 16)}…　${r.from_size ?? '-'} B\n` +
        `      目标 sha256=${String(r.to_sha256).slice(0, 16)}…　${r.to_size ?? '-'} B\n` +
        `      判定：${r.verdict}`,
    )
  }
}

process.exit(main())
