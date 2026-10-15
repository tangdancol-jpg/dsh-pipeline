// p11 ⑦ · plugin 行的 config：**插件自己的 schema** + shipped 范本，双判。
//
// 从 `tests/p11-presets-check.mjs` 抽出来（2026-10-16 · 行数纪律：那一份要加行，先拆再改）。
// 判据本体**一个字节没改** —— 真机事故（2026-10-15 十六张卡片全标「加载失败」）与它抓的
// `.required()` 缺键，仍由这一块钉着；`ok()` 由调用方传进来，计数仍归 p11 统一做。
//
// @module dsh-pipeline/tests/p11-plugin-rows-check

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { UNVERIFIABLE_MODULES } from './preset-package-facts.js'

/**
 * 从**解析出来的产物**里摊平出 plugin 行（判据⑦的输入）。
 *
 * 为什么取产物而不是取 `BASE_PLUGIN_ROWS`：宿主读的是产物。取源码常量只能证明
 * "常量写对了"，证不了"产物里真的带着 config" —— 而这次的事故正是产物那一层。
 */
function pluginRowsOf(entries) {
  const out = []
  for (const e of Array.isArray(entries) ? entries : []) {
    // 两种形状都收：`[{insert:[{config}]}]`（产物原文）与 `[{config}]`（已展开）。
    const cfg = e?.insert?.[0]?.config ?? e?.config
    if (typeof cfg?.id !== 'string') continue
    for (const r of Array.isArray(cfg.plugins) ? cfg.plugins : []) {
      out.push({ presetId: cfg.id, rowId: r?.id, module: r?.name, config: r?.config })
    }
  }
  return out
}

export function checkPluginRowGate(ctx) {
  const { roles, parser, genPath, real, index, readCapabilityRows } = ctx
  const ok = ctx.ok
  const PRESETS = ctx.PRESETS
  const { BASE_PLUGIN_ROWS } = ctx
  const {
    checkAgainstShipped,
  checkPluginRows,
  findDshAsar,
  listShippedPresetFiles,
  openAsar,
  readPluginSchemas,
  shippedRowFacts,
  } = ctx.schemaApi

  // ── ⑦ plugin 行的 config：**插件自己的 schema** + shipped 范本，双判 ──
  //   输入取**产物**（宿主读的就是它），不取 `BASE_PLUGIN_ROWS` —— 取源码常量只能
  //   证明"常量写对了"，证不了"产物里真的带着 config"，而事故正是产物那一层。
  //   ★ main 的**能力追加行**（用户第 1 件）从 `src/main/capability.json` 现读，
  //     不从产物里反推 —— 否则"源里声明了但没渲染"会两边一起少，永远对得上。
  const capRows = readCapabilityRows(join(PRESETS, index.presets.main.dir))
  /** `cordis:group` 行的**子行**也是一行要挂上去的插件 —— 校验器（validate ⑧）按平铺算。 */
  const flatCapRows = (rows) => rows.flatMap((r) => [r, ...(Array.isArray(r.children) ? flatCapRows(r.children) : [])])
  const mainExtraRows = capRows.length
  const mainExtraRowsFlat = flatCapRows(capRows).length
  const wantRows = roles.length * (1 + BASE_PLUGIN_ROWS.length) + mainExtraRows
  const artRows = parser === null ? [] : pluginRowsOf(parser.parse(readFileSync(genPath, 'utf8')))
  ok(parser !== null, '⑦ 产物可被 YAML 解析（判据⑦的输入）', parser === null ? '未校验：找不到 YAML 解析器（**不当作通过**）' : `解析器：${parser.label}`)
  ok(artRows.length === wantRows, `⑦ 产物里解析出 ${roles.length}×(1 persona + ${BASE_PLUGIN_ROWS.length} 底座) + main 追加 ${mainExtraRows} = ${wantRows} 行`, `实际 ${artRows.length} 行`)

  const asarPath = findDshAsar()
  if (asarPath === null || artRows.length === 0) {
    ok(false, '⑦ 用插件自己的 schema 校验每一行', asarPath === null
      ? '未校验：找不到宿主安装的 app.asar（设 DSH_APP_ASAR=<安装>/resources/app.asar）—— **不当作通过**'
      : '未校验：产物里一行都没解析出来 ⇒ 校验没有输入（**不当作通过**）')
  } else {
    const asar = openAsar(asarPath)
    // ★ main 的**能力追加行**（含 group 的子行）也要进这份模块清单 ——
    //   只统计顶层行的话，那三个压缩插件的 schema 有没有读到**永远不会被问**。
    const modules = [...new Set([...artRows.map((r) => r.module), ...flatCapRows(capRows).map((r) => r.name)])]
    const schemas = readPluginSchemas(asar, modules)
    const unread = modules.filter((m) => schemas.get(m).fields === null)
    const unexpected = unread.filter((m) => !UNVERIFIABLE_MODULES.includes(m))
    ok(
      unexpected.length === 0 && unread.length === UNVERIFIABLE_MODULES.length,
      `⑦ 读不到 Config 声明的模块恰好是那 ${UNVERIFIABLE_MODULES.length} 个（多一个即红）`,
      unread.join(', ') || `（一个都没有 —— 与本文件的预期不符，说明宿主安装变了）`,
    )
    const gate = checkPluginRows(artRows, schemas)
    ok(gate.problems.length === 0, `⑦ ${gate.checked} 个 plugin 行的 config 全部通过该插件的 schema`, gate.problems.map((p) => p.detail).slice(0, 3).join(' | ') || '0 个问题')
    const shipped = shippedRowFacts(asar, listShippedPresetFiles(asar), parser.parse)
    const ref = shipped.get('@deepseek-ai/dsh-tool-fs-search')
    ok(ref !== undefined && ref.alwaysConfig && ref.keys.includes('sampleOverCapGlobResults'),
      '⑦ shipped 预设里 tool-fs-search 行确实给了 config.sampleOverCapGlobResults（范本口径与判据同源）',
      ref === undefined ? '**shipped 里没有这一行**（范本变了，判据要跟着改）' : `keys=[${ref.keys.join(', ')}] alwaysConfig=${ref.alwaysConfig}`)
    const against = checkAgainstShipped(artRows, shipped)
    ok(against.length === 0, '⑦ 每一行的 config 与 shipped 预设逐字同形（不许自己发明 config）', against.map((p) => p.detail).slice(0, 3).join(' | ') || '0 个问题')

    // 反例自证：判据**真的会红**（不是"永远绿"的摆设）
    const broken = artRows.map((r) => (r.module === '@deepseek-ai/dsh-tool-fs-search' ? { ...r, config: undefined } : r))
    const g1 = checkPluginRows(broken, schemas)
    ok(g1.problems.some((p) => p.key === 'sampleOverCapGlobResults'), '⑦ 反例 a：删掉 tool-fs-search 的 config ⇒ 必须点名缺 sampleOverCapGlobResults（真机缺陷现场）', g1.problems.length === 0 ? '**没红**（假绿）' : g1.problems[0].detail)
    const invented = artRows.map((r) => (r.module === '@deepseek-ai/dsh-tool-fs' ? { ...r, config: { readLimit: 2000, totallyMadeUp: 1 } } : r))
    const inv = checkAgainstShipped(invented, shipped)
    ok(inv.some((p) => p.kind === 'shipped-invented'), '⑦ 反例 b：给一个 shipped 没有的键 ⇒ 必须点名"自己发明 config"', inv.length === 0 ? '**没红**（假绿）' : inv[0].detail)
    asar.close()
  }
  /** 校验器（`validate.js` ⑧）按**平铺**收行 —— `cordis:group` 的子行也算行，所以是另一个数。 */
  const wantRowsFlat = roles.length * (1 + BASE_PLUGIN_ROWS.length) + mainExtraRowsFlat
  ok(real.counts.pluginRows === wantRowsFlat, `⑦ validate.js 的判据⑧覆盖到全部 ${wantRowsFlat} 行（含 group 子行；真树上已随 ⑥ 判红/判绿）`, `counts.pluginRows=${real.counts.pluginRows}`)
}
