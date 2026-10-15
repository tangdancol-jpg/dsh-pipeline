/**
 * dsh-pipeline · 开关回归 · **off ⇒ 没有任何 hook 生效**（计数为 0，不是看文案）
 * ============================================================================
 *     node tests/switch-off-no-hooks-check.mjs
 *
 * 为什么这条必须存在：本次缺陷能溜过去，正是因为**没有被观测的行为**。
 * 原有自测只看 `tools/pre-execute` 的**返回值**是否变成 `enter` ——
 * 而"关了但仍在拦"的那条缝（`post-execute` 第二道网）根本不在观测面里，
 * 于是"全绿"是**假绿**。
 *
 * 所以判据是**计数**，两把尺子：
 *   A **挂载面**：关掉时 `interception.mounted()` 为空、观测台账里 `registered` 为空；
 *   B **触发面**：四条缝全探一遍，7 个 spy 计数必须全 0（缝**根本没进来**，不是"进来后放行"）。
 *   C **对照**：开着时同一批 spy 必须全都响 —— 否则 B 的"全 0"毫无意义（探针没接上）。
 *   D **即时性**：同一次会话中途翻转，立刻跟随（不需要重启）。
 *
 * ★ 全程密闭：夹具自造临时目录，不引用活体真单、不监听端口、不动 profile。
 */

import { createRecorder, renderReport, runDirect, makeFakeSwitch, newSpies, makeSeatFixture, closeFixtures, probeAllSeams } from './switch-fixtures.mjs'

const SPY_KEYS = ['seatLookups', 'guardCalls', 'livenessCalls', 'reattachCalls', 'markSeatConsumedCalls', 'wakeMainCalls']

export async function runSwitchOffNoHooksCheck() {
  const rec = createRecorder()
  const open = []
  try {
    const f = await makeSeatFixture()
    open.push(f.h)

    // =======================================================================
    // C（先跑开着的对照：证明探针真的接上了）
    // =======================================================================
    const sw = makeFakeSwitch(true)
    const spyOn = newSpies()
    const onRun = await probeAllSeams(f, sw, spyOn)
    const fired = SPY_KEYS.filter((k) => spyOn[k] > 0)
    rec.add(
      'C 对照：on 时探针确实会响',
      '★★ 开关**开**时这 6 个探针全部被触发（证明下面 B 的"全 0"是真 0，不是探针根本没接上）',
      fired.length === SPY_KEYS.length && onRun.results.preExecute?.kind === 'deny',
      `spy：${JSON.stringify(spyOn)}\n被触发的：${fired.join(' / ') || '(一个都没响 —— 探针接错了)'}`,
    )
    onRun.dispose()

    // =======================================================================
    // A/B：关掉之后（同一批夹具、同一批探针）
    // =======================================================================
    sw.flip(false)
    const spyOff = newSpies()
    const offRun = await probeAllSeams(f, sw, spyOff)
    const noisy = Object.entries(spyOff).filter(([, v]) => v !== 0)

    rec.add(
      'A 挂载面：挂着的缝 = 0',
      '★★ 关掉时 `interception.mounted()` 为空数组（**缝根本没挂**，不是"挂了但放行"）',
      Array.isArray(offRun.ic.mounted()) && offRun.ic.mounted().length === 0,
      `mounted() = ${JSON.stringify(offRun.ic.mounted())}\n本插件管的缝：${JSON.stringify(offRun.ic.seams)}`,
    )
    rec.add(
      'A 挂载面：挂着的缝 = 0',
      '★★ 观测台账里 `registered` 也是空（摘缝记了账：`history` 里有 unmount）',
      offRun.ic.audit.snapshot().registered.length === 0,
      `registered=${JSON.stringify(offRun.ic.audit.snapshot().registered)}\nhistory=${JSON.stringify(offRun.ic.audit.snapshot().history)}`,
    )
    rec.add(
      'B 触发面：7 个 spy 全 0',
      '★★ 四条缝全探一遍 ⇒ 7 个 spy 计数全 0（**根本没进来**，不是"进来后放行"）',
      noisy.length === 0,
      `spy：${JSON.stringify(spyOff)}\n非 0 的：${noisy.map(([k, v]) => `${k}=${v}`).join(', ') || '(无)'}`,
    )
    rec.add(
      'B 触发面：7 个 spy 全 0',
      '★ 闸门**一次都没被问**（`asked` 为空）—— 因为缝已经摘了，不是"问了之后拒绝"',
      Object.keys(offRun.ic.audit.snapshot().asked).length === 0,
      `asked=${JSON.stringify(offRun.ic.audit.snapshot().asked)}`,
    )
    rec.add(
      'B 触发面：7 个 spy 全 0',
      '★ 四条缝的返回值与"没人挂过"逐字相同（`{kind:"enter",messages:[]}`）',
      [offRun.results.preExecute, offRun.results.preStep, offRun.results.postWake, offRun.results.postResult].every(
        (x) => x?.kind === 'enter' && (x.messages ?? []).length === 0,
      ),
      JSON.stringify(offRun.results).slice(0, 240),
    )
    offRun.dispose()

    // =======================================================================
    // D：**中途翻转**（同一次会话、不重启）—— 订阅式挂/摘必须立刻跟随
    // =======================================================================
    const sw2 = makeFakeSwitch(true)
    const live = await probeAllSeams(f, sw2, newSpies())
    const mountedBefore = live.ic.mounted().length
    sw2.flip(false)
    const mountedAfterOff = live.ic.mounted().length
    const spyLive = newSpies()
    // 同一个 ic 再探一次：这一次应当全直通
    const midBody = JSON.stringify(
      await live.host.emit('tools/post-execute', { name: 'read', agent: { id: f.agents.main } }, { content: 'function add(a, b) { return a + b }\n' }),
    )
    void spyLive
    sw2.flip(true)
    const mountedBack = live.ic.mounted().length
    rec.add(
      'D 中途翻转即时跟随',
      '★★ 开 ⇒ 挂 4 条；中途关 ⇒ **立刻摘成 0 条**、结果立刻不再被过滤；再开 ⇒ 挂回 4 条（不重启）',
      mountedBefore === 4 && mountedAfterOff === 0 && mountedBack === 4 && midBody.includes('function add(a, b)') && !midBody.includes('不看代码'),
      `挂载数：开=${mountedBefore} → 关=${mountedAfterOff} → 再开=${mountedBack}\n关掉时那次调用返回：${midBody.slice(0, 200)}`,
    )
    live.dispose()
  } catch (err) {
    rec.add('!! 执行异常', '本套没能跑完', false, String(err?.stack ?? err).split('\n').slice(0, 8).join('\n'))
  }
  await closeFixtures(open)
  return renderReport(
    'dsh-pipeline 开关回归 · off ⇒ 没有任何 hook 生效（计数为 0）',
    '（判据是计数，不是文案 —— 缺陷能溜过去正是因为"关了但仍在拦"的那条缝不在观测面里。）',
    rec,
  )
}

runDirect(runSwitchOffNoHooksCheck, import.meta.url)
