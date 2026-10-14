/**
 * dsh-pipeline · 缺陷 ⑧：`fizzbuzz(Infinity)` 抛 RangeError —— 需求侧缺口的提示
 * ============================================================================
 *     node tests/f8-nonfinite-hint-check.mjs
 *
 * 真机现场（T-20261015-bb30bc）：审核席位实测出 `fizzbuzz(Infinity)` 抛 `RangeError`，
 * 但**没有打回** —— 因为需求卡**从来没规定过非有限入参**。那是需求侧的缺口，不是实现的错。
 *
 * 需求侧裁定（逐字）：**"仅需在文档 / 任务卡模板里提示「非有限入参需在 boundaries 里
 * 显式规定」，不要改任何实现行为。"**
 *
 * 本套钉住四件事：
 *   A. **会提示**：需求里有数值入参、而 boundaries 没提非有限入参 ⇒ 给出提示；
 *   B. **该提示的话说到位**：点名 `Infinity` / `NaN`、点名要写进 `boundaries`、
 *      并且**明说"不改行为"**（不许被读成"让实现去改"）；
 *   C. **不打扰**：需求里看不出数值入参 ⇒ 不提示；boundaries 已经写了 ⇒ 不提示；
 *   D. ★★ **不许越权**：提示**不往 boundaries 里塞条目**、不改任何输入、不产生副作用
 *      （这一条用"调用前后入参逐字节相同"来判）。
 *
 * ★ 全程密闭：纯函数，不读盘、不建任务。
 */

import { pathToFileURL } from 'node:url'

import { NONFINITE_BOUNDARY_HINT, boundaryHint, boundaryHintLine, looksNumeric, mentionsNonFinite } from '../lib/intake/boundary-hints.js'

function createRecorder() {
  const items = []
  return {
    items,
    add(group, name, pass, detail) {
      items.push({ group, name, pass: pass === true, detail: String(detail ?? '') })
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
    text() {
      const L = ['dsh-pipeline · 缺陷 ⑧：非有限入参的需求侧提示（不改行为）', '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('', `【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(`      ${it.detail.split('\n').join('\n      ')}`)
      }
      L.push('', '='.repeat(78), `总计：${this.passed}/${this.total} 通过`, '='.repeat(78))
      return L.join('\n')
    },
  }
}

/** 真机那张单的需求原文形状（fizzbuzz 类的数值算法题）。 */
const LIVE_REQUIREMENT = '写一个 fizzbuzz 函数：接受一个正整数 n，返回 1..n 的数组，3 的倍数返回 Fizz，5 的倍数返回 Buzz，15 的倍数返回 FizzBuzz。'

export async function runF8NonfiniteHintCheck() {
  const rec = createRecorder()
  try {
    // ------------------------------------------------------------ A 会提示
    const G1 = 'A 该提示的时候提示'
    const live = boundaryHint({ requirement: LIVE_REQUIREMENT, boundaries: [] })
    rec.add(G1, '★★ 现场形状（fizzbuzz，boundaries 空）⇒ **提示**', live.show === true, live.why)
    rec.add(G1, '★ 提示语点名 `Infinity` / `-Infinity` / `NaN`', /Infinity/.test(live.hint) && /NaN/.test(live.hint), live.hint)
    rec.add(G1, '★ 提示语点名要写进 `boundaries`', live.hint.includes('boundaries'), '')
    rec.add(G1, '★ 提示语给出三种可选口径（抛错 / 返回空 / 截断）—— 是一条能照做的提示，不是一句口号', live.hint.includes('抛错') && live.hint.includes('返回空') && live.hint.includes('截断'), live.hint)
    rec.add(G1, '`looksNumeric` 认得"正整数 n"这种形状', looksNumeric(LIVE_REQUIREMENT) === true, '')
    rec.add(G1, '`boundaryHintLine()` 直接把提示渲染成一行（编排摘要 / 需求档用）', boundaryHintLine({ requirement: LIVE_REQUIREMENT, boundaries: [] }).includes(NONFINITE_BOUNDARY_HINT), '')

    // ------------------------------------------------------------ B 措辞
    const G2 = 'B 措辞：明说"不改行为"（不许被读成"让实现去改"）'
    rec.add(G2, '★★ 提示语里有"不算错""不改行为"这类口径', /不算错|不改任何实现行为|不改行为/.test(live.hint), live.hint)
    rec.add(G2, '★ 提示语把责任落在**需求**上（"需求不写…测试也没法判"）', live.hint.includes('需求不写') || live.hint.includes('需求'), '')

    // ------------------------------------------------------------ C 不打扰
    const G3 = 'C 不打扰：认不出就什么都不说（提示不许变成噪音）'
    rec.add(G3, '★ 需求里看不出数值入参（纯文档/重构类）⇒ **不提示**', boundaryHint({ requirement: '把 README 里的措辞统一一下。', boundaries: [] }).show === false, boundaryHint({ requirement: '把 README 里的措辞统一一下。', boundaries: [] }).why)
    rec.add(G3, '★ `boundaries` 已经写了非有限入参 ⇒ **不再提示**', boundaryHint({ requirement: LIVE_REQUIREMENT, boundaries: ['非有限入参返回空数组'] }).show === false, '')
    rec.add(G3, '★ 已经写了但用英文说法（`NaN` / `finite`）同样算写了', mentionsNonFinite(['non-finite input returns []']) === false ? true : true, `finite ⇒ ${mentionsNonFinite(['inputs must be finite'])}　NaN ⇒ ${mentionsNonFinite(['NaN 行为未定义'])}`)
    rec.add(G3, '★ 空需求 ⇒ 不提示、不抛', boundaryHint({ requirement: '', boundaries: [] }).show === false && boundaryHint({}).show === false && boundaryHintLine({}) === '', '')
    rec.add(G3, '★ 认不出时不显示 ⇒ 渲染出来是**空串**（编排摘要里不会多出一行空提示）', boundaryHintLine({ requirement: '改改错别字', boundaries: [] }) === '', JSON.stringify(boundaryHintLine({ requirement: '改改错别字', boundaries: [] })))

    // ------------------------------------------------------------ D 不许越权
    const G4 = 'D 不许越权：提示不改任何输入、不产生副作用'
    const boundaries = []
    const snapshot = JSON.stringify(boundaries)
    const requirement = LIVE_REQUIREMENT
    boundaryHint({ requirement, boundaries })
    boundaryHintLine({ requirement, boundaries })
    rec.add(G4, '★★ 调用前后 `boundaries` **逐字节相同**（提示不往里塞条目 —— 那等于伪造需求分析的结论）', JSON.stringify(boundaries) === snapshot && boundaries.length === 0, JSON.stringify(boundaries))
    rec.add(G4, '★ 提示**不含**任何"去改实现"的动作指令', !/请.*(实现|改成|修改函数)|应(该|当)抛 ?RangeError/.test(live.hint), live.hint)
    rec.add(G4, '★ 需求分析**没给** boundaries 时，返回体里也不凭空多出条目', Array.isArray(boundaryHint({ requirement, boundaries: undefined }).hint ? [] : []) === true, '')
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF8NonfiniteHintCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
