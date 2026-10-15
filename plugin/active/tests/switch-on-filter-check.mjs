/**
 * dsh-pipeline · 开关回归 · **on ⇒ 含代码正文的工具结果被过滤**（与今天行为一致）
 * ============================================================================
 *     node tests/switch-on-filter-check.mjs
 *
 * 这是"第二道网"的**本职**：控制角色（主对话 / 需求分析 / 计划）不该看代码正文。
 * 开关**开着**时它必须照旧拦下 —— 本套是 `switch-off-no-filter-check.mjs` 的**正例对照**：
 * 没有它，"off 不过滤"这句话可能只是"这条缝本来就坏了"。
 *
 * 本套只钉**一件事**：开关开着时，那条网照旧把结果换成反馈，且**原来那几句原文不变**。
 *
 * ★ 全程密闭：夹具自造临时目录，不引用活体真单、不监听端口、不动 profile。
 */

import { NO_CODE_READ_ROLES } from '../lib/guard.js'
import { looksLikeCode, resultNetVerdict } from '../lib/guard/hook-post.js'
import { createRecorder, renderReport, runDirect, makeFakeSwitch, newSpies, makeSeatFixture, closeFixtures, probeAllSeams } from './switch-fixtures.mjs'

export async function runSwitchOnFilterCheck() {
  const rec = createRecorder()
  const open = []
  try {
    const f = await makeSeatFixture()
    open.push(f.h)

    const sw = makeFakeSwitch(true) // ★ 开
    const { results, dispose } = await probeAllSeams(f, sw, newSpies())
    dispose()
    const fb = JSON.stringify(results.postResult?.feedback ?? '')

    rec.add(
      'on ⇒ 结果被过滤',
      '★★ 控制角色的结果里带代码正文 ⇒ `{kind:"block"}`（**行为与今天一致**）',
      results.postResult?.kind === 'block' && Array.isArray(results.postResult.feedback),
      `返回：${JSON.stringify(results.postResult)?.slice(0, 220)}`,
    )
    rec.add(
      'on ⇒ 结果被过滤',
      '★ 反馈原文**逐字未改**（"不看代码" + "第二道网" + 替代路径三句都在）',
      fb.includes('不看代码') && fb.includes('第二道网') && fb.includes('pipeline_change_audit'),
      fb.slice(0, 260),
    )
    rec.add(
      'on ⇒ 结果被过滤',
      '★ 判据本身仍是纯函数：`resultNetVerdict` 对控制角色返回 block、对执行角色返回 null（不误伤）',
      resultNetVerdict({ role: 'main' }, { content: 'const a = 1;\n' })?.kind === 'block' &&
        resultNetVerdict({ role: 'writer' }, { content: 'const a = 1;\n' }) === null &&
        NO_CODE_READ_ROLES.includes('main'),
      `main=${resultNetVerdict({ role: 'main' }, { content: 'const a = 1;\n' })?.kind}　writer=${String(resultNetVerdict({ role: 'writer' }, { content: 'const a = 1;\n' }))}`,
    )
    rec.add(
      'on ⇒ 结果被过滤',
      '★ 粗判仍"宁可漏判也不误伤"：普通散文不算代码（强特征三条正则）',
      looksLikeCode('这是一段说明文字，没有任何代码。') === false &&
        looksLikeCode('function add(a, b) { return a + b }') === true,
      `散文=${looksLikeCode('这是一段说明文字，没有任何代码。')}　代码=${looksLikeCode('function add(a, b) { return a + b }')}`,
    )
  } catch (err) {
    rec.add('!! 执行异常', '本套没能跑完', false, String(err?.stack ?? err).split('\n').slice(0, 8).join('\n'))
  }
  await closeFixtures(open)
  return renderReport(
    'dsh-pipeline 开关回归 · on ⇒ 含代码正文的工具结果被过滤',
    '（`switch-off-no-filter-check` 的正例对照：没有它，"off 不过滤"可能只是"这条缝本来就坏了"。）',
    rec,
  )
}

runDirect(runSwitchOnFilterCheck, import.meta.url)
