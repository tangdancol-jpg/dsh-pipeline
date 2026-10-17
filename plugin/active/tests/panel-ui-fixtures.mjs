// 面板客户端两套自测的**共享夹具**（不是测试：没有断言，所以刻意**不登记**进 `tests/registry.mjs`）。
/**
 * dsh-pipeline · 面板客户端自测夹具（桩 React / 桩 document / chunk 装载环境）
 * ============================================================================
 * 为什么单独一个文件：`tests/panel-ui-check.mjs` 加了弹层 portal 那 4 条之后到了 553 行，
 * 超出 `CONVENTIONS.md`「单个测试文件 ≤ 400 行 ⇒ 拆成两个测试文件（各测一件事）」——
 * 于是按语义拆成两条，判据一条不丢：
 *   · 面板头部按钮与「点外面关闭」判据（E0–E13） ⇒ `tests/panel-ui-check.mjs`
 *   · 弹层 portal：挂到 document.body / fixed 落点 / 无 react-dom 回退（P1–P3）
 *     ⇒ `tests/panel-portal-check.mjs`
 * 两条共用的**桩 React**（每个组件实例一份 hook 槽、ref 挂到带 contains 的节点代理、
 * `useEffect` 按依赖重跑）、元素树查找、chunk 装载环境与挂载入口放这里，免得各抄一份
 * （抄两份 = 两处会漂移的判据）。
 * 同一形状的先例：`tests/panel-fixtures.mjs`、`tests/switch-fixtures.mjs`、`tests/wake-no-main-fixtures.mjs`。
 *
 * ★ 本文件**不含任何断言** —— 断言全在上面那两个 `*-check.mjs` 里。
 *
 * @module dsh-pipeline/tests/panel-ui-fixtures
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')
const ENTRY = join(LIB, 'client.js')

// ---------------------------------------------------------------------------
// 桩 React：每个组件实例一份 hook 槽 + 真 ref + 按依赖重跑的 useEffect
// ---------------------------------------------------------------------------

export function createStubReact() {
  const stores = new Map()
  const proxies = new WeakMap()
  let store = null
  let cursor = 0
  const storeOf = (component) => {
    let hit = stores.get(component)
    if (hit === undefined) {
      hit = { cells: [], effects: [] }
      stores.set(component, hit)
    }
    return hit
  }
  const sameDeps = (a, b) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
    return true
  }
  /** 把元素树的 ref 挂到「节点代理」上；代理的 contains() 就是面板判"里面/外面"的那把尺。 */
  function attach(tree) {
    const walk = (el) => {
      if (el === null || el === undefined || typeof el !== 'object' || Array.isArray(el) || el.props === undefined) return null
      const children = []
      const kids = el.props.children
      for (const kid of Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]) {
        const child = walk(kid)
        if (child !== null) children.push(child)
      }
      const node = {
        contains(target) {
          if (target === node) return true
          for (const child of children) if (child.contains(target)) return true
          return false
        },
      }
      proxies.set(el, node)
      const ref = el.props.ref
      if (typeof ref === 'function') ref(node)
      else if (ref !== null && ref !== undefined && typeof ref === 'object') ref.current = node
      return node
    }
    walk(tree)
  }
  return {
    render(Component, props) {
      store = storeOf(Component)
      cursor = 0
      const tree = Component(props)
      attach(tree)
      return tree
    },
    useState(initial) {
      const i = cursor++
      const cells = store.cells
      if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial
      return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next }]
    },
    useEffect(fn, deps) {
      const i = cursor++
      const prev = store.effects[i]
      if (prev !== undefined && deps !== undefined && sameDeps(prev.deps, deps)) return
      if (prev !== undefined && typeof prev.cleanup === 'function') prev.cleanup()
      const cleanup = fn()
      store.effects[i] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : null }
    },
    useRef(initial) {
      const i = cursor++
      if (!(i in store.cells)) store.cells[i] = { current: initial }
      return store.cells[i]
    },
    useCallback(fn) {
      cursor++
      return fn
    },
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
    },
    proxyOf(el) {
      return proxies.get(el) ?? null
    },
  }
}

/** 在元素树里找第一个满足条件的节点。 */
export function find(node, pred) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, pred)
      if (hit !== null) return hit
    }
    return null
  }
  if (pred(node)) return node
  return find(node.props?.children, pred)
}
export const has = (node, key) => node !== null && node !== undefined && node.props !== undefined && Object.prototype.hasOwnProperty.call(node.props, key)
export const textOf = (node) => (node === null || node === undefined || node === false ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'object' && node.props !== undefined ? textOf(node.props.children) : '')

// ---------------------------------------------------------------------------
// 环境：入口 + 18 个真 chunk（按宿主同款 require.async 取）+ 桩 document/fetch/定时器
// ---------------------------------------------------------------------------

export const TASKS = [{ id: 'T-1', state: 'running', state_label: '开发中', requirement_snippet: '把客户端拆成多个 chunk', seats: [], allowed_actions: ['cancel', 'archive'] }]
export const ARCHIVED = [{ id: 'T-0', dir: 'T-0-2026-10-18T042252Z', state: 'closed', state_label: '已关闭', requirement_snippet: '老单', archived_at: '2026-10-01T10:20:00Z' }]

export function makeEnvironment() {
  const doc = {
    visibilityState: 'visible',
    listeners: { pointerdown: [], keydown: [] },
    // 真外部元素的替身：E13 用它验「点外面仍然能关」（连在文档上、closest 谁都不命中）
    body: { tagName: 'BODY', isConnected: true, attributes: [], closest: () => null },
    addEventListener(type, fn) {
      ;(this.listeners[type] ??= []).push(fn)
    },
    removeEventListener(type, fn) {
      const list = this.listeners[type] ?? []
      const at = list.indexOf(fn)
      if (at !== -1) list.splice(at, 1)
    },
  }
  const loads = []
  const React = createStubReact()
  const timers = { timeouts: [], intervals: [] }
  const timer = (bucket) => (fn, ms) => {
    const id = { fn, ms }
    bucket.push(id)
    return id
  }
  const clearTimer = (bucket) => (id) => {
    const at = bucket.indexOf(id)
    if (at !== -1) bucket.splice(at, 1)
  }
  const fetchCalls = []
  const fetchStub = (url) => {
    const target = String(url)
    fetchCalls.push(target)
    const body = target.indexOf('view=archived') !== -1 ? { ok: true, tasks: ARCHIVED } : { ok: true, generated_at: '2026-10-18T05:00:00.000Z', tasks: TASKS }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  }
  const windowStub = { __ModuleLoader__: { load(descriptor) { loads.push(descriptor) } } }
  const sandbox = {
    console,
    window: windowStub,
    document: doc,
    fetch: fetchStub,
    setTimeout: timer(timers.timeouts),
    clearTimeout: clearTimer(timers.timeouts),
    setInterval: timer(timers.intervals),
    clearInterval: clearTimer(timers.intervals),
    AbortController,
    URL,
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  const runScript = (file) => vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file })

  runScript(ENTRY)
  const entry = loads.find((descriptor) => descriptor.chunk === undefined)
  if (entry === undefined) throw new Error('入口没有调 window.__ModuleLoader__.load({ id, factory })')
  const chunkExports = {}
  for (const file of readdirSync(LIB).filter((f) => f.startsWith('client.') && f !== 'client.js').sort()) {
    runScript(join(LIB, file))
    const registered = loads.find((descriptor) => descriptor.chunk === file)
    if (registered === undefined) throw new Error(`${file} 没有注册到 __ModuleLoader__`)
    // ★ 单测里 chunk 的 require 一律抛（chunk 之间不许互相同步 require）——portal chunk 正是靠
    //   `try { require('react-dom') } catch { null }` 落回"原样渲染"这条路的，这里就是那种环境。
    chunkExports['./' + file] = registered.factory(() => {
      throw new Error(`${file} 不该 require 别的模块`)
    })
  }
  const requireStub = (name) => {
    if (name === 'react') return React
    throw new Error(`client 不该 require("${name}")`)
  }
  requireStub.async = (spec) => (chunkExports[spec] === undefined ? Promise.reject(new Error('取不到 chunk ' + spec)) : Promise.resolve(chunkExports[spec]))
  return { React, doc, window: windowStub, timers, fetchCalls, entry, requireStub, chunkExports }
}

/** 假客户端 ctx（只实现本插件用到的成员）；apply 后取回注册的「多AI协调团队」面板组件。 */
export function mountPanel(env) {
  const registrations = []
  const ctx = {
    __react: env.React,
    __require: env.requireStub,
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: {
      inject(key, cb) {
        return cb()
      },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
  }
  env.entry.factory(env.requireStub).apply(ctx)
  const hit = registrations.find((item) => item.spec.id === 'pipeline-panel')
  if (hit === undefined) throw new Error('没有注册 pipeline-panel 条目')
  return hit.component
}

/** 让挂起的 Promise 链跑几轮（`require.async` / fetch 回包都要靠它）。 */
export async function flush(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// 报告与直接运行入口（两条测试同形）
// ---------------------------------------------------------------------------

/**
 * 把一条测试的结论渲染成统一形状（沿用拆分前那套输出格式）。
 *
 * @param {string} title 报告首行
 * @param {string} group 分组名（`【…】`）
 * @param {Array<{name:string,pass:boolean,detail:string}>} items
 * @param {string[]} limits 没验到的（如实列出，每条一句）
 */
export function renderReport(title, group, items, limits) {
  const lines = ['='.repeat(78), title, '='.repeat(78), '', `【${group}】`]
  for (const item of items) {
    lines.push(`  ${item.pass ? '✓' : '✗'} ${item.name}`)
    if (item.detail !== '') lines.push(`      ${item.detail.split('\n').join('\n      ')}`)
  }
  const passed = items.filter((item) => item.pass).length
  lines.push('', '='.repeat(78), `总计：${passed}/${items.length} 通过`, '='.repeat(78))
  if (Array.isArray(limits) && limits.length > 0) lines.push('', '★ 没验到的（如实列出）：' + limits.join(' / '))
  return { passed, total: items.length, text: lines.join('\n') }
}

/**
 * 直接 `node tests/xxx-check.mjs` 时的收尾（打印报告 + 退出码 = 结论）。
 *
 * ★ `metaUrl` **必须传调用方自己的** `import.meta.url`：本函数住在夹具文件里，
 *   拿夹具文件的 URL 去比 `process.argv[1]` 永远不相等 ⇒ 直接跑会一声不响什么都不做。
 */
export function runDirect(run, metaUrl) {
  if (process.argv[1] === undefined || metaUrl !== pathToFileURL(process.argv[1]).href) return
  run()
    .then((r) => {
      console.log(r.text)
      if (r.passed !== r.total) process.exitCode = 1
    })
    .catch((err) => {
      console.error('[panel-ui] 内部异常（这是用例自身的 bug，请修用例）：', err)
      process.exitCode = 1
    })
}
