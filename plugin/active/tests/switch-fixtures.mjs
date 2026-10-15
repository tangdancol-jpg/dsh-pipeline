/**
 * dsh-pipeline · 开关回归测试的**共享夹具**（不是测试文件本身，`run-all` 不登记它）
 * ============================================================================
 * 为什么单独一个文件：`CONVENTIONS.md` §4「单个测试文件 ≤400 行」+「一测试一文件」——
 * 五条测试各自只测一件事，它们共用的假宿主 / 假开关 / spy 表 / 报告渲染放在这里，
 * 免得每套各抄一份（抄五份就等于五处会漂移的判据）。
 *
 * ★ 它**不含任何断言** —— 断言在各 `*-check.mjs` 里。这里只造夹具与渲染报告。
 *
 * @module dsh-pipeline/tests/switch-fixtures
 */

import { pathToFileURL } from 'node:url'

import { registerInterception } from '../lib/intercept.js'
import { createGuardFor } from '../lib/guard-factory.js'
import { disposeHarness, createGuardFixture } from './selftest-core.mjs'

// ---------------------------------------------------------------------------
// 记录与报告
// ---------------------------------------------------------------------------

export function createRecorder() {
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
  }
}

export const indent = (s, n = 6) =>
  String(s ?? '')
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n')

/** 把一条测试的结论渲染成统一形状（各组分别统计）。 */
export function renderReport(title, note, rec) {
  const groups = {}
  for (const it of rec.items) {
    if (groups[it.group] === undefined) groups[it.group] = []
    groups[it.group].push(it)
  }
  const lines = ['='.repeat(78), title, '='.repeat(78), '']
  if (note) lines.push(note, '')
  for (const [g, items] of Object.entries(groups)) {
    lines.push('')
    lines.push('─'.repeat(78))
    lines.push(`【${g}】${items.filter((i) => i.pass).length}/${items.length} 通过`)
    lines.push('─'.repeat(78))
    for (const it of items) {
      lines.push('')
      lines.push(`${it.pass ? '✓' : '✗'} ${it.name}`)
      lines.push(indent(it.detail))
    }
  }
  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`总计：${rec.passed}/${rec.total} 通过`)
  lines.push('='.repeat(78))
  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

/**
 * 直接 `node tests/xxx-check.mjs` 时的收尾（退出码 = 结论）。
 *
 * @param {Function} run - 测试入口
 * @param {string} metaUrl - **调用方自己的** `import.meta.url`
 *   （★ 必须传进来：本函数住在本文件里，`import.meta.url` 指的是**夹具文件**的 URL，
 *     拿它去比 `process.argv[1]` 永远不相等 ⇒ 直接跑会**一声不响地什么都不做**。
 *     这个坑本套自己踩过一次，写在这里免得下次再踩。）
 */
export function runDirect(run, metaUrl) {
  if (process.argv[1] === undefined || metaUrl !== pathToFileURL(process.argv[1]).href) return
  run().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}

// ---------------------------------------------------------------------------
// 假宿主 / 假开关 / spy
// ---------------------------------------------------------------------------

/** 假宿主：收集 `ctx.on` 挂上来的中间件，并给一个 `emit` 按宿主 waterfall 语义跑它们。 */
export function createFakeHost(nextResult = { kind: 'enter', messages: [] }) {
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {
        const arr = handlers.get(event) ?? []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      }
    },
  }
  async function emit(event, ...args) {
    const arr = handlers.get(event) ?? []
    let idx = 0
    const next = async () => {
      if (idx >= arr.length) {
        // ★ 宿主语义：**没人拦** ⇒ 结果原样交给下游。这里把它带在返回值上，
        //   断言才能区分"原文可见"与"被换成了一段反馈"（否则两者都长得像 `{kind:'enter'}`）。
        return event === 'tools/post-execute' ? { ...nextResult, toolResult: args[1] } : nextResult
      }
      const fn = arr[idx++]
      return fn(...args, next)
    }
    return next()
  }
  return { ctx, emit, events: () => [...handlers.keys()], handlerCount: (e) => (handlers.get(e) ?? []).length }
}

/** 一个可翻转的假开关（`isOn` + `subscribe`，语义与真 `createSwitch` 一致）。 */
export function makeFakeSwitch(initial = true) {
  let on = initial
  const listeners = new Set()
  return {
    isOn: () => on,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    /** ★ 与真 `createSwitch.set()` 同一条语义：**值没变就不通知**（否则会测出假的"重复起停"）。 */
    flip(next) {
      if (next === on) return false
      on = next
      for (const fn of listeners) fn({ on })
      return true
    },
  }
}

/** 空 spy 表（每一个都对应"缝里真的会走到"的一处副作用）。 */
export const newSpies = () => ({
  seatLookups: 0,
  guardCalls: 0,
  getTaskCalls: 0,
  reattachCalls: 0,
  livenessCalls: 0,
  wakeMainCalls: 0,
  markSeatConsumedCalls: 0,
})

export const ZERO_SPIES = newSpies()

export async function makeSeatFixture() {
  const f = await createGuardFixture({ stopAfter: 3 })
  return f
}

export async function closeFixtures(list) {
  for (const h of list) {
    try {
      await disposeHarness(h)
    } catch {
      /* 清不掉不影响结论 */
    }
  }
}

/**
 * 把四条缝都探一遍（挂一次、emit 四次）。
 *
 * @returns {{results:object, ic:object, host:object}}
 */
export async function probeAllSeams(f, sw, spies, opts = {}) {
  const host = createFakeHost()
  const tokens = { roleOfAgent: (a, t) => { spies.seatLookups += 1; return f.h.tokens.roleOfAgent(a, t) } }
  const guard = createGuardFor({
    tokens,
    config: f.h.config,
    taskIndex: f.h.taskIndex,
    sw,
    counter: f.h.counter,
    retired: new Set(),
    warn: () => {},
  })
  const ic = registerInterception(host.ctx, {
    tokens,
    guard: (exec) => { spies.guardCalls += 1; return guard(exec) },
    warn: () => {},
    sw,
    getTask: (taskId) => { spies.getTaskCalls += 1; return f.h.store.peek(taskId) ?? null },
    mainReattach: async () => { spies.reattachCalls += 1; return null },
    checkLiveness: async () => { spies.livenessCalls += 1; return null },
    wakeMain: async () => { spies.wakeMainCalls += 1; return null },
    waker: { markSeatConsumed: () => { spies.markSeatConsumedCalls += 1 } },
    ...opts,
  })

  const M = f.agents.main
  const W = f.agents.writer
  const CODE_RESULT = { content: 'function add(a, b) { return a + b }\nconst x = 1;\n' }
  const results = {
    preExecute: await host.emit('tools/pre-execute', { name: 'pwsh', arguments: { command: 'npm test' }, agent: { id: W } }),
    preStep: await host.emit('agent/pre-step', { agent: { id: M }, messages: [{ role: 'user', content: '读一下 src/a.js 的源码' }], turn: 1 }),
    // ★ 用**唤醒触发点**里的工具名，否则缝 ③ 会合法地直通（那不是本套要测的东西）。
    postWake: await host.emit('tools/post-execute', { name: 'pipeline_handoff', agent: { id: M } }, { ok: true, handoff_id: 'HO-XYZ' }),
    postResult: await host.emit('tools/post-execute', { name: 'read', agent: { id: M } }, CODE_RESULT),
  }
  return { results, ic, host, codeResult: CODE_RESULT, dispose: () => ic.dispose() }
}
