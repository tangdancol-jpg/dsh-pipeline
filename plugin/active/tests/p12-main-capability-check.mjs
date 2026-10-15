/**
 * p12 · 主对话的能力面（`pl-main` 不低于 Computer Use 模式）+「可见但不给」
 * ============================================================================
 *     node tests/p12-main-capability-check.mjs
 *
 * 用户原话（2026-10-16，第 1 件）：
 *   「补全主对话的能力，**不能比 Computer Use 模式能力差**，且主对话的限制应该是
 *     平常禁止读代码、写面、工具面按角色收紧等，但是**必要时能向用户申请**，
 *     主对话**能知道工具**，但是被告知**必要申请**，且**最好别碰**。」
 *
 * 判据（每条都能红，且有具体落点）：
 *   ① **能力面**：CU 的 plugin 行名集合 ⊖ (底座 ∪ 追加 ∪ 显式排除) = 0 ——
 *      判据本体在 `presets/computer-use-parity.js`，本套只断言它真的判过（⑨ 那条 note 在）。
 *   ② **用户点名的 5 项**（桌面 GUI / 网页检索与抓取 / 向用户提问 / Shell / 文件读取）
 *      逐项在 `capability.json` 里有落点，且**非空落点**的项真的渲染进了产物。
 *   ③ **可见 ≠ 隐藏**：`deriveToolFace` 给 `main` 的 `denied` 必须是空集 ——
 *      受限工具**不从清单里摘掉**（这正是"能知道工具"的判据）。
 *   ④ **persona 三句话**：平常不许用 / 必要时应先申请 / 最好别碰 —— 三句都在 prefix/suffix 里。
 *   ⑤ **负例自证**（在**临时副本**上跑，全程不碰真树）：
 *      a) 删掉 `capability.json`            ⇒ `validatePresets()` 必须变红并点名它；
 *      b) 清空某条 `excluded[].why`          ⇒ 必须变红并点名"没写 why"；
 *      c) 把 `desktop-gui` 的 rows 清空      ⇒ 必须变红并点名 `tool-computer-use`。
 *
 * 退出码：0 = 全绿；1 = 有失败。
 * @module dsh-pipeline/tests/p12-main-capability-check
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { guardDecision } from '../lib/guard.js'
import { deriveToolFace, eventLevelToolNames } from '../lib/boundaries.js'
import { buildTools } from '../lib/tools.js'
import { renderPatch, readCapabilityRows } from '../presets/render.js'
import { validatePresets } from '../presets/validate.js'
import { REQUIRED_BY_USER, findOrbPatch, parityReport } from '../presets/computer-use-parity.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const PRESETS = join(PKG, 'presets')
const CAP_JSON = join(PRESETS, 'src', 'main', 'capability.json')

/** 跑一遍真工具面（匿名调用方 ⇒ 判词里带 `允许角色：…`）——与 `lib/tools.js` 同一份判据。 */
function realFace() {
  const noop = () => {}
  const deps = {
    defineTool: (d) => d,
    config: { artifactDirName: '.pipeline' },
    store: { projectRoot: '', get: async () => null },
    tokens: { roleOfAgent: () => null },
    transport: {},
    indexTask: noop,
    sw: { isOn: () => true },
    counter: { add: noop },
    retireAgent: noop,
    wakeup: {},
    dshHome: '',
  }
  const defs = Object.values(buildTools(deps)).filter((d) => typeof d?.name === 'string')
  const names = [...new Set(defs.map((d) => d.name))]
  return deriveToolFace({
    toolNames: names,
    judge: (n) => guardDecision({ name: n, arguments: {} }, { tokens: deps.tokens }),
    eventLevel: eventLevelToolNames(defs),
  })
}

/** 主运行器。@returns {Promise<{passed:number,total:number,text:string}>} */
export async function runP12MainCapabilityCheck() {
  const lines = []
  let passed = 0
  let total = 0
  const ok = (cond, label, detail = '') => {
    total += 1
    if (cond) passed += 1
    lines.push(`  ${cond ? '✓' : '✗'} ${label}${detail ? `　—— ${detail}` : ''}`)
    return Boolean(cond)
  }

  lines.push('='.repeat(78))
  lines.push('p12 · 主对话能力面（不低于 computer-use）+「可见但不给」')
  lines.push('='.repeat(78))

  // ---- ① validate ⑨ 真的判过 -------------------------------------------------
  const v = validatePresets()
  const capNote = v.notes.find((n) => n.includes('⑨ 能力面对照通过'))
  ok(v.ok === true, '① presets/validate.js 全绿（含 ⑨ 能力面对照）', v.errors.slice(0, 3).join(' ｜ ') || '无 error')
  ok(capNote !== undefined, '① ⑨ 判据真的跑过（不是"没报错=通过"）', capNote ?? '（没找到 ⑨ 的 note）')

  // ---- ② 用户点名的 5 项 ------------------------------------------------------
  //   ★ 读不到就**如实判红**，不抛 —— 一条崩掉的测试和一条红的测试，后者才说得清是哪件事。
  let spec = null
  try {
    spec = JSON.parse(readFileSync(CAP_JSON, 'utf8'))
  } catch (err) {
    ok(false, '② capability.json 可读且是合法 JSON', `${CAP_JSON} —— ${String(err?.message ?? err)}`)
  }
  const keys = new Set((spec?.capabilities ?? []).map((c) => String(c.key)))
  const lack = REQUIRED_BY_USER.filter((k) => !keys.has(k))
  ok(lack.length === 0, `② 用户点名的 ${REQUIRED_BY_USER.length} 项能力都在 capability.json 里`, lack.length > 0 ? `缺：${lack.join('、')}` : REQUIRED_BY_USER.join(' / '))

  const rows = readCapabilityRows(join(PRESETS, 'src', 'main'))
  const out = renderPatch()
  const missingRows = rows.filter((r) => !out.includes(`- id: ${r.id}`))
  ok(missingRows.length === 0, '② 追加行真的渲染进了产物（声明了但没渲染 = 假绿）', missingRows.map((r) => r.id).join('、') || `已渲染 ${rows.length} 条：${rows.map((r) => r.id).join(' / ')}`)
  const wantIds = ['tool-computer-use', 'tool-web', 'tool-ask-user', 'compaction']
  const missWant = wantIds.filter((id) => !out.includes(`- id: ${id}`))
  ok(missWant.length === 0, '② 桌面 GUI / 网页 / 提问 / 压缩 四类行都在 pl-main 的产物里', missWant.join('、') || wantIds.join(' / '))

  // ---- ③ 可见但不隐藏 ---------------------------------------------------------
  const face = realFace()
  const mainFace = face.by_role?.main ?? {}
  ok(Array.isArray(mainFace.denied) && mainFace.denied.length === 0 && mainFace.hidden_count > 0, '③ ★ 主对话的工具面**不隐藏**任何工具（判出 7 个"会被拒的"，实际藏 0 个 = "能知道工具"）', `denied=${JSON.stringify(mainFace.denied ?? null)}　判出=${mainFace.hidden_count}`)
  const others = Object.entries(face.by_role ?? {}).filter(([r, f]) => r !== 'main' && (f.denied ?? []).length > 0)
  ok(others.length > 0, '③ 对照：别的角色的工具面**确实**在收紧（否则上面那条可能只是"机制没跑"）', `${others.length} 个角色有隐藏面`)

  // ---- ④ persona 三句话 -------------------------------------------------------
  const persona = rows.length >= 0 ? `${readFileSync(join(PRESETS, 'src', 'main', 'prefix.md'), 'utf8')}\n${readFileSync(join(PRESETS, 'src', 'main', 'suffix.md'), 'utf8')}` : ''
  ok(/平常(一律)?不许/.test(persona), '④ persona 写了「平常不许用」', 'prefix.md')
  ok(/申请/.test(persona) && /申请路径/.test(persona), '④ persona 写了「必要时应先向用户申请」（含路径）', 'prefix.md')
  ok(/最好别碰/.test(persona), '④ persona 写了「最好别碰」', 'prefix.md + suffix.md')

  // ---- ⑤ 负例（临时副本，不碰真树） -------------------------------------------
  const tmp = mkdtempSync(join(tmpdir(), 'p12-presets-'))
  try {
    cpSync(PRESETS, join(tmp, 'presets'), { recursive: true })
    const run = () => validatePresets({ root: join(tmp, 'presets'), libDir: join(PKG, 'lib') })

    // a) 删掉 capability.json
    rmSync(join(tmp, 'presets', 'src', 'main', 'capability.json'))
    const ra = run()
    ok(ra.ok === false && ra.errors.some((e) => e.includes('capability.json')), '⑤a 删掉 capability.json ⇒ 变红且点名它', ra.errors.find((e) => e.includes('capability.json')) ?? '（没红）')

    // 恢复，改 excluded[].why
    cpSync(CAP_JSON, join(tmp, 'presets', 'src', 'main', 'capability.json'))
    const bad = JSON.parse(readFileSync(CAP_JSON, 'utf8'))
    bad.excluded[0].why = '   '
    writeFileSync(join(tmp, 'presets', 'src', 'main', 'capability.json'), JSON.stringify(bad, null, 2), 'utf8')
    const rb = run()
    ok(rb.ok === false && rb.errors.some((e) => e.includes('没写 why')), '⑤b 清空 excluded[].why ⇒ 变红且点名"没写 why"', rb.errors.find((e) => e.includes('why')) ?? '（没红）')

    // 改 desktop-gui 的 rows
    const bad2 = JSON.parse(readFileSync(CAP_JSON, 'utf8'))
    for (const c of bad2.capabilities) if (c.key === 'desktop-gui') c.rows = []
    writeFileSync(join(tmp, 'presets', 'src', 'main', 'capability.json'), JSON.stringify(bad2, null, 2), 'utf8')
    const rc = run()
    ok(rc.ok === false && rc.errors.some((e) => e.includes('tool-computer-use')), '⑤c 抽掉 desktop-gui 的行 ⇒ 变红且点名 `tool-computer-use`', rc.errors.find((e) => e.includes('tool-computer-use')) ?? '（没红）')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  // ---- ⑥ 范本来源如实登记 -----------------------------------------------------
  const patch = findOrbPatch()
  const rep = parityReport({ spec: spec ?? {}, baseRows: [], orbPatch: patch })
  if (patch !== null) {
    ok(rep.available === true, '⑥ 现场范本（dsh-orb 的 preset-computer-use）找得到并**逐字比对**通过', patch)
  } else {
    ok(rep.notes.some((n) => n.includes('未与现场范本比对')), '⑥ 本机没有范本 ⇒ 如实登记"未与现场范本比对"（不当成通过）', rep.notes.join(' ｜ '))
  }
  ok(rep.counts.oracle > 0, '⑥ 范本行清单非空（否则整条对照是空的）', `oracle=${rep.counts.oracle} 行`)

  lines.push('')
  lines.push(`p12 总计：${passed}/${total} 通过`)
  return { passed, total, text: lines.join('\n') }
}

// 直接运行
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const r = await runP12MainCapabilityCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
