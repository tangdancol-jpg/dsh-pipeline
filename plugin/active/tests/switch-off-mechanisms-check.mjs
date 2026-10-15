/**
 * dsh-pipeline · 开关回归 · **off ⇒ 两条周期机制停表**
 * ============================================================================
 *     node tests/switch-off-mechanisms-check.mjs
 *
 * 缺陷里的"**半挂面**"就是这半边：巡检兜底与孤儿单自恢复是两条 `setInterval`。
 * 改前它们的定时器与开关**毫无关系** —— 关掉功能之后照跑照写：
 *   · 巡检每轮 `wakeup.wake` + `wakeup.escalateUnconsumed`（注入 + 写账本）；
 *   · 孤儿单自恢复**主动往席位会话重新投递** + 写账本与审计。
 *
 * 本套只钉**一件事**：关掉时两条周期**停表**（不是"跑着但空转"），开回来能自动起表。
 *   A 停表 / 起表 / 幂等（重复翻转不叠出第二个定时器）
 *   B 起停失败只留痕、**不外抛**（它们是"能更好"，不是判据）
 *   C 未启用的机制不进来（`null` 不进条目表）
 *
 * ★ 全程密闭：用**假机制**（只记 start/stop 计数），不起真定时器、不碰任何真单。
 */

import { createMechanismItems, createSwitchDrivenMechanisms } from '../lib/switch/mechanisms.js'
import { createRecorder, renderReport, runDirect, makeFakeSwitch } from './switch-fixtures.mjs'

/** 造一个只记数的假机制。 */
function makeFakeMechanism(id) {
  const c = { start: 0, stop: 0, running: false }
  return {
    id,
    counters: c,
    item: {
      id,
      start: () => { c.start += 1; const was = c.running; c.running = true; return !was },
      stop: () => { c.stop += 1; const was = c.running; c.running = false; return was },
    },
  }
}

export async function runSwitchOffMechanismsCheck() {
  const rec = createRecorder()
  try {
    // =======================================================================
    // A. 停表 / 起表 / 幂等
    // =======================================================================
    {
      const sw = makeFakeSwitch(true)
      const p = makeFakeMechanism('patrol')
      const o = makeFakeMechanism('orphan-rescue')
      const mech = createSwitchDrivenMechanisms({ sw, items: [p.item, o.item], warn: () => {} })
      const started = p.counters.running === true && o.counters.running === true
      sw.flip(false)
      const offSnap = mech.snapshot()
      const stopped = p.counters.running === false && o.counters.running === false
      sw.flip(false) // ★ 幂等：重复置关不许再停一次（真开关"值没变就不通知"）
      const idempotent = p.counters.stop === 1 && o.counters.stop === 1
      sw.flip(true)
      const resumed = p.counters.running === true && o.counters.running === true
      rec.add(
        'A 停表 / 起表',
        '★★ 关 ⇒ 两条周期**停表**（不是"跑着但空转"）；开 ⇒ 起表；重复翻转幂等',
        started && stopped && idempotent && resumed,
        `patrol：${JSON.stringify(p.counters)}　orphan：${JSON.stringify(o.counters)}\n结论：${JSON.stringify(mech.snapshot().applied)}`,
      )
      rec.add(
        'A 停表 / 起表',
        '★ 关掉那一刻的快照是**结构化**的：`off === true`，两条各自 `changed:true`（不靠读日志）',
        offSnap.off === true && offSnap.applied.length === 2 && offSnap.applied.every((a) => a.off === true && a.changed === true),
        `关掉时 snapshot=${JSON.stringify(offSnap)}`,
      )
      mech.dispose()
      rec.add(
        'A 停表 / 起表',
        '★ `dispose()` 退订：之后再翻转开关，机制**不再**被起停（HMR / 卸载路径可用）',
        (() => {
          const before = JSON.stringify(p.counters)
          sw.flip(false)
          return before === JSON.stringify(p.counters)
        })(),
        `退订后再翻转：patrol=${JSON.stringify(p.counters)}`,
      )
    }

    // =======================================================================
    // B. 抛错只留痕、不外抛
    // =======================================================================
    {
      const boom = createSwitchDrivenMechanisms({
        sw: makeFakeSwitch(true),
        items: [{ id: 'boom', start: () => { throw new Error('start 炸了') }, stop: () => false }],
        warn: () => {},
      })
      rec.add(
        'B 抛错只留痕',
        '★ 机制起停抛错 ⇒ 只留痕（`error` 非空、`warned` 为真）、**不外抛**、不拖垮插件装配',
        boom.snapshot().applied[0]?.error === 'start 炸了' && boom.snapshot().warned === true,
        JSON.stringify(boom.snapshot().applied),
      )
      boom.dispose()
    }

    // =======================================================================
    // C. 条目工厂：未启用的机制不进表
    // =======================================================================
    {
      const both = createMechanismItems({ patrol: { start: () => false, stop: () => false }, orphanRescue: { start: () => false, stop: () => false }, config: {}, log: () => {} })
      const onlyPatrol = createMechanismItems({ patrol: { start: () => false, stop: () => false }, orphanRescue: null, config: {}, log: () => {} })
      const none = createMechanismItems({ patrol: null, orphanRescue: null, config: {}, log: () => {} })
      rec.add(
        'C 条目工厂',
        '★ `null` 的机制不进条目表（`config.patrolEnabled=false` / `orphanRescueEnabled=false` 时不硬凑）',
        both.length === 2 && onlyPatrol.length === 1 && onlyPatrol[0].id === 'patrol' && none.length === 0,
        `都启用=${both.map((i) => i.id).join(',')}　只有巡检=${onlyPatrol.map((i) => i.id).join(',')}　都不启用=${none.length}`,
      )
      const lines = []
      const withLog = createMechanismItems({ patrol: { start: () => true, stop: () => true }, orphanRescue: null, config: { patrolIntervalMs: 300000, patrolStallMs: 1800000, wakeUnconsumedMs: 3600000 }, log: (m) => lines.push(m) })
      // ★ 只有 `start()` 真的返回 true 才配说"已启动"（改前那句是无条件的）。
      withLog[0].start()
      const saidStarted = lines.some((m) => m.includes('巡检兜底已启动'))
      lines.length = 0
      createMechanismItems({ patrol: { start: () => false, stop: () => false }, orphanRescue: null, config: {}, log: (m) => lines.push(m) })[0].start()
      rec.add(
        'C 条目工厂',
        '★ 播报**如实**：`start()` 返回 false（没能起表）时**不说**"已启动"（改前那句是无条件的）',
        saidStarted && lines.length === 0,
        `真的起了 ⇒ 说了"已启动"：${saidStarted}　没能起 ⇒ 说了几句：${lines.length}`,
      )
    }
  } catch (err) {
    rec.add('!! 执行异常', '本套没能跑完', false, String(err?.stack ?? err).split('\n').slice(0, 8).join('\n'))
  }
  return renderReport(
    'dsh-pipeline 开关回归 · off ⇒ 两条周期机制停表',
    '（巡检与孤儿单自恢复是缺陷里"半挂"的那一半：关掉功能后它们照跑照写，磁盘上、别的会话里都看得见。）',
    rec,
  )
}

runDirect(runSwitchOffMechanismsCheck, import.meta.url)
