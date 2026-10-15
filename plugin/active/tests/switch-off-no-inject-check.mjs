/**
 * dsh-pipeline · 开关回归 · **off ⇒ 不注入、不写项目目录**
 * ============================================================================
 *     node tests/switch-off-no-inject-check.mjs
 *
 * "拦"之外的另一半是"**说**"：本插件会往会话里注入消息（唤醒）、往项目目录里记账
 * （`task.contacts.main`）。这两件事在关掉时都必须停 —— 否则"回到普通 DSH 行为"
 * 这句话在**别的会话里**和**磁盘上**都不成立，而磁盘上的痕迹恰恰是用户唯一能自己核对的东西。
 *
 * 本套只钉**一件事**：关掉时，本插件的两个"出口"（注入 / 记账）一个字节都不产生。
 *   A 唤醒咽喉：`wake()` 早退，且**不写 audit**、**不查落盘联系人**
 *   B 主对话记账：`rememberMainCaller` 直接返回 false，`rememberMain` 一次都没被调
 *   ★ 两组的**正例对照**都在同一套里：开着时必须照常往下走（证明关的那一支不是"本来就坏了"）
 *
 * ★ 全程密闭：不建任务、不碰任何活体真单、不动 profile。
 */

import { createWaker } from '../lib/wakeup.js'
import { rememberMainCaller } from '../lib/wakeup/main-contact.js'
import { createRecorder, renderReport, runDirect, makeFakeSwitch } from './switch-fixtures.mjs'

export async function runSwitchOffNoInjectCheck() {
  const rec = createRecorder()
  try {
    // =======================================================================
    // A. 唤醒咽喉：`wake()` 是"本插件往会话里说话"的唯一出口
    // =======================================================================
    {
      const calls = { contact: 0, audit: 0, delivered: 0 }
      const sw = makeFakeSwitch(false)
      const waker = createWaker({
        ctx: { agents: { get: () => { calls.delivered += 1; return null } } },
        registry: { sessionOf: () => null, remember: () => {} },
        ledger: null,
        getTask: () => null,
        mainContactOf: async () => { calls.contact += 1; return '' },
        audit: async () => { calls.audit += 1 },
        warn: () => {},
      })
      // ★ 包一层闸门（生产里就是这么装的：`index.js` 的 withSwitchGate）。
      const { withSwitchGate } = await import('../lib/switch/waker-gate.js')
      const gated = withSwitchGate(waker, sw)

      const offRes = await gated.wake({ taskId: 'T-x', actorRole: 'mechanism', kind: 'liveness', what: 'x' })
      rec.add(
        'A 唤醒咽喉',
        '★★ 关：`wake()` 早退（`reason="switch-off"`）且**一个字节都不写盘**（审计 0 次、联系人查询 0 次）',
        offRes.reason === 'switch-off' && offRes.injected === false && calls.audit === 0 && calls.contact === 0,
        `返回：${JSON.stringify(offRes)}\n计数器：${JSON.stringify(calls)}`,
      )
      const esc = await gated.escalateUnconsumed('T-x', {})
      rec.add(
        'A 唤醒咽喉',
        '★★ 关：`escalateUnconsumed` 也不升级（它写账本 —— off 下必须一个字节都不写）',
        esc.escalated === 0 && calls.audit === 0,
        `返回：${JSON.stringify(esc)}`,
      )

      sw.flip(true)
      const onRes = await gated.wake({ taskId: 'T-x', actorRole: 'mechanism', kind: 'liveness', what: 'x' })
      rec.add(
        'A 唤醒咽喉',
        '★ 开：同一次调用照常往下走（走到"没登记主对话会话"才停）—— 证明关的那一支不是"本来就投不出去"',
        onRes.reason === 'no-main-session' && calls.contact === 1 && calls.audit >= 1,
        `返回：${JSON.stringify(onRes)}\n计数器：${JSON.stringify(calls)}`,
      )
    }

    // =======================================================================
    // B. 记账面：`task.contacts.main` 是**唯一一处"只读工具也会写项目目录"**的路径
    // =======================================================================
    {
      const called = []
      const mkDeps = (sw) => ({
        sw,
        wakeup: { rememberMain: (taskId, agentId, via) => { called.push([taskId, agentId, via]); return true } },
        tokens: { tasksOfAgent: () => ['T-1'] },
      })
      const exec = { agent: { id: 'main-agent' } }
      const offCalled = rememberMainCaller(mkDeps(makeFakeSwitch(false)), exec)
      const afterOff = called.length
      rec.add(
        'B 记账面',
        '★★ 关 ⇒ `rememberMainCaller` 直接返回 false、`rememberMain` **一次都没被调**（只读工具也不许写项目目录）',
        offCalled === false && afterOff === 0,
        `关：返回 ${offCalled}，rememberMain 被调 ${afterOff} 次`,
      )
      const onCalled = rememberMainCaller(mkDeps(makeFakeSwitch(true)), exec)
      rec.add(
        'B 记账面',
        '★ 开 ⇒ 照常登记（证明关的那一支不是"本来就记不上"）',
        onCalled === true && called.length === 1 && called[0][0] === 'T-1',
        `开：返回 ${onCalled}，rememberMain 调用=${JSON.stringify(called)}`,
      )
    }
  } catch (err) {
    rec.add('!! 执行异常', '本套没能跑完', false, String(err?.stack ?? err).split('\n').slice(0, 8).join('\n'))
  }
  return renderReport(
    'dsh-pipeline 开关回归 · off ⇒ 不注入会话、不写项目目录',
    '（"拦"之外的另一半是"说"：注入与记账在关掉时也必须停，否则"回到普通 DSH 行为"在别的会话与磁盘上都不成立。）',
    rec,
  )
}

runDirect(runSwitchOffNoInjectCheck, import.meta.url)
