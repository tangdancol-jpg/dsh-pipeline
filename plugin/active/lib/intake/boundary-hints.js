/**
 * dsh-pipeline · 需求面 · **边界条件里那些"没人想到的入参"**（提示，不改行为）
 * ============================================================================
 * -----------------------------------------------------------------------------
 * 这条缺陷的口径（真机端到端 T-20261015-bb30bc 实测，缺陷 ⑧）
 * -----------------------------------------------------------------------------
 * 现场：`fizzbuzz(Infinity)` 抛 `RangeError`。审核席位实测出来了，但**没有打回** ——
 * 因为**需求卡从来没规定过非有限入参**该怎么处理：那不是实现的错，是**需求侧的缺口**。
 *
 * ★ 需求侧已经裁定（用户口径，逐字）：**"仅需在文档 / 任务卡模板里提示
 *   「非有限入参需在 boundaries 里显式规定」，不要改任何实现行为。"**
 *
 * 所以本模块**只做提示**，三条硬边界：
 *   · 不改任何**实现行为**（它连实现都碰不到）；
 *   · 不**替**需求分析往 `boundaries` 里塞条目（那等于伪造它的结论）；
 *   · 判据只做**启发式提示**，认不出就**什么都不说**（宁可漏提示，不许无中生有）。
 *
 * @module dsh-pipeline/lib/intake/boundary-hints
 */

/** 提示原文（一处定义，工具描述、任务卡、编排摘要都引用它）。 */
export const NONFINITE_BOUNDARY_HINT =
  '非有限入参（`Infinity` / `-Infinity` / `NaN`）与空值/超大值的行为要在 boundaries 里**显式规定**' +
  '（抛错？返回空？截断？）—— 需求不写，实现怎么选都不算错，测试也没法判。'

/**
 * 这条需求是不是"**有数值入参**"的形状（启发式）。
 *
 * 为什么用启发式而不是"永远提示"：每条需求都提示 = 提示变成噪音，人就再也不看了。
 *
 * @param {string} requirement
 * @returns {boolean}
 */
export function looksNumeric(requirement) {
  const s = String(requirement ?? '')
  if (s.length === 0) return false
  // ① 出现数值型字眼，或 ② 出现函数调用形状 `name(...)` / `name(n)`
  const numericWord = /(整数|正整数|非负|自然数|数字|数值|number|numeric|integer|int\b|参数\s*n\b|入参|输入.*数)/i
  const callShape = /\b[A-Za-z_$][\w$]*\s*\(\s*[-+]?\d/ 
  return numericWord.test(s) || callShape.test(s)
}

/** 边界条件里**已经**提到过非有限入参吗（提到过就不再提示）。 */
export function mentionsNonFinite(boundaries) {
  const list = Array.isArray(boundaries) ? boundaries : []
  const re = /(Infinity|NaN|非有限|无穷|无限|有限性|finite|非数|非法数值|越界入参)/i
  return list.some((b) => re.test(String(b ?? '')))
}

/**
 * 该不该提示。
 *
 * @param {object} input
 * @param {string} input.requirement
 * @param {string[]} [input.boundaries]
 * @returns {{show:boolean, hint:string, why:string}}
 */
export function boundaryHint({ requirement, boundaries } = {}) {
  if (!looksNumeric(requirement)) {
    return { show: false, hint: '', why: '需求里看不出数值入参的形状 ⇒ 不提示（宁可漏提示，不许无中生有）。' }
  }
  if (mentionsNonFinite(boundaries)) {
    return { show: false, hint: '', why: 'boundaries 里已经写了非有限入参的口径 ⇒ 不再提示。' }
  }
  return { show: true, hint: NONFINITE_BOUNDARY_HINT, why: '需求里有数值入参，而 boundaries 没提非有限入参。' }
}

/**
 * 渲染成编排摘要 / 任务卡里的一行（不显示时返回空串）。
 *
 * @param {object} input - 同 {@link boundaryHint}
 * @returns {string}
 */
export function boundaryHintLine(input) {
  const r = boundaryHint(input)
  return r.show ? `⚠ 边界条件提示（需求面口径，**不改行为**）：${r.hint}` : ''
}
