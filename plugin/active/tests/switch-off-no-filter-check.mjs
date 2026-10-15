/**
 * dsh-pipeline · 开关回归 · **off ⇒ 含代码正文的工具结果不被过滤**
 * ============================================================================
 *     node tests/switch-off-no-filter-check.mjs
 *
 * 这是用户亲自遇到的**缺陷现场**（逐字）：
 *   ① 调用 `pipeline_switch { on: false }` ⇒ 返回「守门已弃权（**任何调用都不再
 *      本插件拦**）……」（revision 27，来源 client-ui，已落盘）；
 *   ② **紧接着**调用另一个工具 ⇒ 它的**结果被替换**成
 *      `[pipeline] 这次工具结果里有代码正文，你是「主对话」——不看代码。★ 这是第二道网…`
 *
 * 本套只钉**一件事**：开关关掉时，那条"第二道网"**不许再动结果**。
 * （开关开着时的行为在 `switch-on-filter-check.mjs`；"有没有 hook 生效"在
 * `switch-off-no-hooks-check.mjs`。）
 *
 * ★ 全程密闭：夹具自造临时目录，不引用活体真单、不监听端口、不动 profile。
 */

import { createRecorder, renderReport, runDirect, makeFakeSwitch, newSpies, makeSeatFixture, closeFixtures, probeAllSeams } from './switch-fixtures.mjs'

export async function runSwitchOffNoFilterCheck() {
  const rec = createRecorder()
  const open = []
  try {
    const f = await makeSeatFixture()
    open.push(f.h)

    const sw = makeFakeSwitch(false) // ★ 关
    const { results, dispose } = await probeAllSeams(f, sw, newSpies())
    dispose()
    const body = JSON.stringify(results.postResult)

    rec.add(
      'off ⇒ 结果不被过滤',
      '★★ 含代码正文的工具结果**原样交给下游**（`kind` 仍是 `enter`，正文一个字没少）',
      results.postResult?.kind === 'enter' && body.includes('function add(a, b)'),
      `返回：${body.slice(0, 260)}`,
    )
    rec.add(
      'off ⇒ 结果不被过滤',
      '★★ 那段"第二道网"的反馈**一个字都没有出现**（缺陷现场的那句原文）',
      !body.includes('不看代码') && !body.includes('第二道网'),
      `正文里出现「不看代码」：${body.includes('不看代码')}　出现「第二道网」：${body.includes('第二道网')}`,
    )
    rec.add(
      'off ⇒ 结果不被过滤',
      '★ 返回值与"这条缝从来没挂过"**逐字相同**（`{kind:"enter",messages:[]}` + 原结果）',
      results.postResult?.kind === 'enter' && (results.postResult.messages ?? []).length === 0,
      JSON.stringify(results.postResult).slice(0, 200),
    )
  } catch (err) {
    rec.add('!! 执行异常', '本套没能跑完', false, String(err?.stack ?? err).split('\n').slice(0, 8).join('\n'))
  }
  await closeFixtures(open)
  return renderReport(
    'dsh-pipeline 开关回归 · off ⇒ 含代码正文的工具结果不被过滤',
    '用户原话：pipeline_switch 关掉后，插件仍在拦截 —— 开关只关一半。',
    rec,
  )
}

runDirect(runSwitchOffNoFilterCheck, import.meta.url)
