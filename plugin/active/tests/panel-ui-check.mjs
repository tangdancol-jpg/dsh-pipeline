/**
 * dsh-pipeline · 面板头部按钮回归（点「批量」/「归档 N」后面板必须还在）
 * ============================================================================
 *     node tests/panel-ui-check.mjs
 *
 * 用户报的（真机）：「批量」`data-pipeline-batch-toggle` 与「归档 N」
 * `data-pipeline-archive-toggle` 一点，整个面板（会话头部那块 UI）直接消失。
 *
 * 为什么不塞进 `tests/client-check.mjs`：那一套的桩 React 只够验入口与 chunk 契约
 * （没有 ref、`useEffect` 不跟依赖重跑、没有 `document`），装不下整块面板。这里补一套
 * 够把点击走完的桩（每个组件实例一份 hook 槽 / ref 挂到带 contains 的元素代理 /
 * `useEffect` 按依赖重跑 / document 能收 pointerdown），于是整条链是走通的：
 *   按钮 onClick → renderPanelHeader 的 opts → shell 从共享作用域 S 取的
 *   toggleBatch / openArchivedView / backToTasks → setBatch / setView → 重渲染 → 面板还在不在。
 * 钉住 E1 回调接上 / E2-E3 批量 on↔off / E4-E5 归档↔返回 / E6 pointerdown 不误关 /
 * ★E7 rootRef 为 null 时**不许**关 / E8 按钮自己 stopPropagation + no-drag /
 * E9 收尾仍开着 / E10 点真外面仍然照旧关（防御是窄的）/
 * ★E11 rootRef 脱手（被替换的节点 / null）时，target 明确在 `[data-pipeline-panel]` 里 ⇒ 不关（真机根因）/
 * ★E12 target 在 `[data-pipeline-panel-root]` 里（触发器）⇒ 不关（DOM 属性那一路判据）/
 * ★E13 `document.body` 这种真外部元素 ⇒ 仍然关 / ★E14 诊断行里能看到「上次点击：BUTTON[...]」/
 * ★E15 有 react-dom ⇒ 弹层走 `createPortal(children, document.body)`（真机根因的修法：弹层不再长在
 * 宿主头部那份 DOM 里，点击不会再被宿主的命中区吃掉）/ ★E16 `panelBoxFor` 的 fixed 落点与收边 /
 * ★E17 拿不到 createPortal（自测桩 / 老环境）⇒ 回退成原样渲染 / ★E18 诊断目标描述升级成祖先路径。
 *
 * ★ 只读仓库里的 `lib/client*.js`，不联网、不建会话、不碰任何活体数据。
 *
 * @module dsh-pipeline/tests/panel-ui-check
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

function createStubReact() {
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
function find(node, pred) {
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
const has = (node, key) => node !== null && node !== undefined && node.props !== undefined && Object.prototype.hasOwnProperty.call(node.props, key)
const textOf = (node) => (node === null || node === undefined || node === false ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'object' && node.props !== undefined ? textOf(node.props.children) : '')

// ---------------------------------------------------------------------------
// 环境：入口 + 16 个真 chunk（按宿主同款 require.async 取）+ 桩 document/fetch/定时器
// ---------------------------------------------------------------------------

const TASKS = [{ id: 'T-1', state: 'running', state_label: '开发中', requirement_snippet: '把客户端拆成多个 chunk', seats: [], allowed_actions: ['cancel', 'archive'] }]
const ARCHIVED = [{ id: 'T-0', dir: 'T-0-2026-10-18T042252Z', state: 'closed', state_label: '已关闭', requirement_snippet: '老单', archived_at: '2026-10-01T10:20:00Z' }]

function makeEnvironment() {
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
function mountPanel(env) {
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

const flush = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function runPanelUiCheck() {
  const items = []
  const add = (name, pass, detail) => items.push({ name, pass: pass === true, detail: String(detail ?? '') })
  const answer = (result) => ({ passed: items.filter((item) => item.pass).length, total: items.length, text: renderText(items), items })

  const env = makeEnvironment()
  const React = env.React
  const Lazy = mountPanel(env)
  let wrapper = React.render(Lazy, { sessionId: 's-main' }) // 首轮 null：正在 require.async 取 chunk
  await flush(6)
  wrapper = React.render(Lazy, { sessionId: 's-main' })
  if (wrapper === null || typeof wrapper.type !== 'function') {
    add('!! lazy wrapper 没有渲染出面板组件', false, `拿到 ${wrapper === null ? 'null' : typeof wrapper?.type}`)
    return answer()
  }
  const Panel = wrapper.type
  const panelProps = wrapper.props
  let tree = React.render(Panel, panelProps)
  await flush(4) // 首轮 GET /panel 回包 → snap.tasks
  tree = React.render(Panel, panelProps)

  /** 真实浏览器顺序：pointerdown 打到某个元素上 → 再 click。元素没画出来就不点（让断言报"没了"）。 */
  const pointerDownOn = (element) => {
    if (element === null || element === undefined) return
    const proxy = React.proxyOf(element)
    for (const fn of env.doc.listeners.pointerdown.slice()) fn({ target: proxy })
  }
  const clickOn = (element) => {
    if (element === null || element === undefined || typeof element.props?.onClick !== 'function') return 0
    pointerDownOn(element)
    let stopped = 0
    element.props.onClick({ stopPropagation() { stopped += 1 } })
    return stopped
  }
  /** 直接派一次 pointerdown（target 是"像真 DOM"的元素 / document.body，不走桩 proxy）。 */
  const pointerDownAt = (target) => {
    for (const fn of env.doc.listeners.pointerdown.slice()) fn({ target })
  }
  /**
   * 造一个"像真 DOM"的元素：tagName + data-pipeline-* 属性 + closest() 沿祖先链找。
   * 桩 React 的节点代理只有 contains、没有 closest —— 而 closest 正是真机上的事实来源。
   */
  const domElement = (tagName, attrs, ancestors, connected = true) => {
    const chain = [...attrs.map((a) => `[${a}]`), ...ancestors]
    return {
      tagName,
      attrs,
      isConnected: connected,
      closest(sel) {
        return chain.includes(sel) ? { tagName: 'DIV' } : null
      },
    }
  }
  /** 弹层 header 上那颗「批量」按钮的样子（在 [data-pipeline-panel] 里）。 */
  const inPanelTarget = () =>
    domElement('BUTTON', ['data-pipeline-batch-toggle'], ['[data-pipeline-panel]', '[data-pipeline-panel-frame]', '[data-pipeline-panel-root]'])
  /** 面板根里的触发器（比弹层更外层，只在 [data-pipeline-panel-root] 里）。 */
  const inRootTarget = () => domElement('BUTTON', ['data-pipeline-panel-trigger'], ['[data-pipeline-panel-root]'])
  /** 重新打开面板（E10 把它关了；走的是用户那条路：点触发器）。 */
  const reopenPanel = async () => {
    const hit = find(tree, (n) => has(n, 'data-pipeline-panel-trigger'))
    if (hit !== null) hit.props.onClick({ stopPropagation() {} })
    tree = React.render(Panel, panelProps)
    await flush(3)
    tree = React.render(Panel, panelProps)
  }
  const batchButton = () => find(tree, (n) => has(n, 'data-pipeline-batch-toggle'))
  const archiveButton = () => find(tree, (n) => has(n, 'data-pipeline-archive-toggle'))
  const backButton = () => find(tree, (n) => has(n, 'data-pipeline-archive-back'))
  const panelOpen = () => find(tree, (n) => n.props?.['data-pipeline-panel'] === 'open')
  const viewNow = () => find(tree, (n) => n.props?.['data-pipeline-panel-view'] !== undefined)?.props?.['data-pipeline-panel-view'] ?? '(none)'

  try {
    // --- 打开面板（点触发器；这条路径会跑 [open] effect，挂上 document 的 pointerdown 监听）---
    const trigger = find(tree, (n) => has(n, 'data-pipeline-panel-trigger'))
    if (trigger === null) throw new Error('触发器没渲染出来')
    trigger.props.onClick({ stopPropagation() {} })
    tree = React.render(Panel, panelProps)
    await flush(4)
    tree = React.render(Panel, panelProps)
    add('E0 面板能打开，且 [open] effect 真的挂上了 document 的 pointerdown 捕获监听', panelOpen() !== null && env.doc.listeners.pointerdown.length === 1, `panel=${panelOpen() === null ? '(none)' : 'open'}　pointerdown 监听器 ${env.doc.listeners.pointerdown.length} 个`)

    // --- E1 回调真的接上了（不是 undefined）---
    const batch0 = batchButton()
    const archive0 = archiveButton()
    add('E1 头部按钮的 onClick 都真的接上了：批量 / 归档（返回在归档视图里验）', batch0 !== null && typeof batch0.props.onClick === 'function' && archive0 !== null && typeof archive0.props.onClick === 'function', `批量.onClick=${typeof batch0?.props?.onClick}　归档.onClick=${typeof archive0?.props?.onClick}`)

    // --- E2 点「批量」：不抛、面板仍在、off → on ---
    clickOn(batch0)
    tree = React.render(Panel, panelProps)
    await flush(3)
    tree = React.render(Panel, panelProps)
    const batch1 = batchButton()
    add('E2 点「批量」：不抛错、**面板仍在**、data-pipeline-batch-toggle 由 off→on', panelOpen() !== null && batch1 !== null && batch1.props['data-pipeline-batch-toggle'] === 'on', `panel=${panelOpen() === null ? '(被关掉了)' : 'open'}　batch-toggle=${batch1?.props?.['data-pipeline-batch-toggle'] ?? '(none)'}　批量栏=${find(tree, (n) => has(n, 'data-pipeline-batch-bar')) !== null ? '在' : '不在'}`)

    // --- E3 再点「批量」：回到 off（进/出两条边都验）---
    clickOn(batch1)
    tree = React.render(Panel, panelProps)
    await flush(3)
    tree = React.render(Panel, panelProps)
    const batch2 = batchButton()
    add('E3 再点「批量」：回到 off，面板仍在（进/出两条边都不许把面板带走）', panelOpen() !== null && batch2 !== null && batch2.props['data-pipeline-batch-toggle'] === 'off', `panel=${panelOpen() === null ? '(被关掉了)' : 'open'}　batch-toggle=${batch2?.props?.['data-pipeline-batch-toggle'] ?? '(none)'}`)

    // --- E4 点「归档 N」：面板仍在、view=archived、出现「← 返回任务」---
    clickOn(archiveButton())
    tree = React.render(Panel, panelProps)
    await flush(4)
    tree = React.render(Panel, panelProps)
    const back1 = backButton()
    add('E4 点「归档 N」：不抛错、**面板仍在**、view=archived、出现「← 返回任务」', panelOpen() !== null && viewNow() === 'archived' && back1 !== null && textOf(back1.props.children).indexOf('返回任务') !== -1, `panel=${panelOpen() === null ? '(被关掉了)' : 'open'}　view=${viewNow()}　返回按钮=${back1 === null ? '(none)' : textOf(back1.props.children)}`)

    // --- E5 点「← 返回任务」：回主视图、面板仍在 ---
    clickOn(back1)
    tree = React.render(Panel, panelProps)
    await flush(4)
    tree = React.render(Panel, panelProps)
    add('E5 点「← 返回任务」：回主视图、面板仍在，归档按钮重新出现', panelOpen() !== null && viewNow() === 'tasks' && archiveButton() !== null, `panel=${panelOpen() === null ? '(被关掉了)' : 'open'}　view=${viewNow()}`)

    // --- E6 只派 pointerdown（click 还没来）不许关面板 ---
    pointerDownOn(batchButton())
    tree = React.render(Panel, panelProps)
    add('E6 只派发 pointerdown（click 还没来）也不会把面板关掉 —— 面板里的按下不算"点外面"', panelOpen() !== null, panelOpen() === null ? 'pointerdown 一到就被判成"点外面"，面板被关' : '面板仍在')

    // --- E7 ★ rootRef 为 null（判据拿不到）时不许关面板 ---
    const rootEl = find(tree, (n) => n.props?.['data-pipeline-panel-root'] === 'true')
    const rootRef = rootEl?.props?.ref
    const canNullTheRef = rootRef !== null && rootRef !== undefined && typeof rootRef === 'object'
    if (canNullTheRef) rootRef.current = null
    for (const fn of env.doc.listeners.pointerdown.slice()) fn({ target: { tag: 'OUTSIDE' } }) // 一个不在面板里的"节点"：真外面
    tree = React.render(Panel, panelProps) // 重渲染会把 ref 挂回去，状态保留
    add('★ E7 rootRef 为 null（判据拿不到）时 pointerdown **不关面板**：宁可漏关一次，不许误关', canNullTheRef && panelOpen() !== null, canNullTheRef ? `rootRef 已置 null 后派 pointerdown → panel=${panelOpen() === null ? '(被关掉了)' : 'open'}` : '找不到根节点的 ref，这条断言不成立')

    // --- E8 按钮自己截住宿主事件 + Electron 拖拽区豁免 ---
    const stopped = clickOn(batchButton())
    tree = React.render(Panel, panelProps)
    const btn = batchButton()
    add('E8 头部按钮自己 stopPropagation（pointerdown / click）且 WebkitAppRegion=no-drag', stopped >= 1 && typeof btn?.props?.onPointerDown === 'function' && btn.props.style?.WebkitAppRegion === 'no-drag', `click 里 stopPropagation 次数=${stopped}　onPointerDown=${typeof btn?.props?.onPointerDown}　WebkitAppRegion=${JSON.stringify(btn?.props?.style?.WebkitAppRegion)}`)

    // --- E9 收尾：走完一整轮点击后面板仍开着（没有遗留的"自己关掉"路径）---
    add('E9 收尾：走完一整轮点击后，面板仍然开着', panelOpen() !== null, panelOpen() === null ? '(被关掉了)' : 'open')

    // --- E10 防御是窄的：判据齐全时，点**真外面**仍然照旧关面板（别把正常关闭一起关掉）---
    for (const fn of env.doc.listeners.pointerdown.slice()) fn({ target: { tag: 'OUTSIDE' } })
    tree = React.render(Panel, panelProps)
    add('E10 判据齐全时点真外面仍然关面板（防御没有把正常关闭一起关掉）', panelOpen() === null, panelOpen() === null ? '已关闭 ✓' : '还在开着 ✗（"点外面关闭"被改坏了）')

    // --- E11 ★ 真机根因：rootRef 脱手（指向被替换的节点 / 干脆是 null），但 target 明确在
    //     [data-pipeline-panel] 里 ⇒ 不许关。真机上"点「批量」弹层就消失"就是这个判据失真的结果。 ---
    await reopenPanel()
    const rootElNow = find(tree, (n) => n.props?.['data-pipeline-panel-root'] === 'true')
    const rootRefNow = rootElNow?.props?.ref
    const canPuppet = rootRefNow !== null && rootRefNow !== undefined && typeof rootRefNow === 'object'
    // ① ref 指向一个被替换/已脱手的节点：它的 contains 永远 false —— 这正是真机上的样子
    if (canPuppet) rootRefNow.current = { contains: () => false }
    pointerDownAt(inPanelTarget())
    tree = React.render(Panel, panelProps)
    const survivedDetached = panelOpen() !== null
    // ② ref 干脆还没挂上（null）
    if (canPuppet) rootRefNow.current = null
    pointerDownAt(inPanelTarget())
    tree = React.render(Panel, panelProps)
    const survivedNull = panelOpen() !== null
    add(
      '★ E11 rootRef 脱手（被替换的节点 contains 恒 false / null）时 target 明确在 [data-pipeline-panel] 里 ⇒ **不关面板**（真机根因）',
      canPuppet && survivedDetached && survivedNull,
      canPuppet
        ? `ref.contains(target)=false（脱手节点）→ panel=${survivedDetached ? 'open' : '(被关掉了)'}　ref=null → panel=${survivedNull ? 'open' : '(被关掉了)'}`
        : '找不到根节点的 ref，这条断言不成立',
    )

    // --- E12 DOM 属性那一路：target 在 [data-pipeline-panel-root] 里（触发器）⇒ 不关（ref 这里说 false）---
    const refNow = rootRefNow?.current ?? null
    const triggerish = inRootTarget()
    const refSaysInside = refNow !== null && typeof refNow.contains === 'function' ? refNow.contains(triggerish) : null
    pointerDownAt(triggerish)
    tree = React.render(Panel, panelProps)
    add(
      '★ E12 target 在 [data-pipeline-panel-root] 里（触发器）⇒ 不关面板；证的正是 DOM 属性那一路（ref 的 contains 说 false）',
      refSaysInside === false && panelOpen() !== null,
      `ref.contains(target)=${refSaysInside}（只靠 ref 就会误关）　closest('[data-pipeline-panel-root]')≠null　→ panel=${panelOpen() === null ? '(被关掉了)' : 'open'}`,
    )

    // --- E13 防御是窄的：连在文档上的真外部元素（document.body）⇒ 仍然关（别把正常关闭改坏）---
    pointerDownAt(env.doc.body)
    tree = React.render(Panel, panelProps)
    add(
      '★ E13 target 是真实文档里的外部元素（document.body）⇒ 仍然关面板（"点外面关闭"没被修坏）',
      panelOpen() === null,
      panelOpen() === null ? '已关闭 ✓' : '还在开着 ✗（该关的关不掉了）',
    )

    // --- E14 诊断行：记下"上次点击打在谁身上"，真机排障不用再猜 ---
    await reopenPanel()
    pointerDownAt(inPanelTarget()) // 点面板里那颗「批量」
    tree = React.render(Panel, panelProps)
    const diagLine = textOf(find(tree, (n) => has(n, 'data-pipeline-diagnostic')))
    const clickAt = diagLine.indexOf('上次点击：')
    const desc = clickAt === -1 ? '' : diagLine.slice(clickAt + '上次点击：'.length)
    add(
      '★ E14 诊断行里出现「上次点击：BUTTON[data-pipeline-batch-toggle]」（超长截断到 ~80 字符），面板仍在',
      diagLine.includes('上次点击：BUTTON[data-pipeline-batch-toggle]') && desc.length <= 81 && panelOpen() !== null,
      `诊断行：${diagLine}　（描述 ${desc.length} 字符）`,
    )

    // --- 弹层 portal（真机根因的修法：弹层挂到 document.body，不再长在宿主头部那份 DOM 里）---
    const portalChunk = env.chunkExports['./client.panel-portal.js']
    const outsideChunk = env.chunkExports['./client.panel-outside.js']

    // ★ E15 有 react-dom ⇒ 弹层走 createPortal(children, document.body)
    const portalCalls = []
    const fakeReactDom = {
      createPortal(children, container) {
        const node = { portal: true, children, container }
        portalCalls.push({ children, container, node })
        return node
      },
    }
    const portalWithDom = portalChunk.create({ require: (name) => (name === 'react-dom' ? fakeReactDom : null) })
    const cardNode = React.createElement('div', { 'data-pipeline-panel': 'open' }, React.createElement('span', null, '批量'))
    const portaled = portalWithDom.renderPortal(null, cardNode)
    add(
      '★ E15 拿到 react-dom 时弹层经 createPortal(children, document.body) 渲染 —— 弹层不再长在宿主头部那份 DOM 里',
      portalWithDom.usable() === true && portalCalls.length === 1 && portalCalls[0].children === cardNode && portalCalls[0].container === env.doc.body && portaled === portalCalls[0].node,
      `usable=${portalWithDom.usable()}　createPortal 调用 ${portalCalls.length} 次　container=${portalCalls[0]?.container === env.doc.body ? 'document.body ✓' : String(portalCalls[0]?.container)}　返回值=${portaled === portalCalls[0]?.node ? '就是 createPortal 的返回值' : '(对不上)'}`,
    )

    // ★ E16 落点：right = 视口宽 - rect.right、top = rect.bottom + 6、width = min(440, 92vw)，越界收边
    env.window.innerWidth = 1280
    env.window.innerHeight = 800
    const boxChunk = portalChunk.create({ require: () => null })
    const box = boxChunk.panelBoxFor({ getBoundingClientRect: () => ({ right: 1180, bottom: 30 }) })
    const boxEdge = boxChunk.panelBoxFor({ getBoundingClientRect: () => ({ right: 1276, bottom: 795 }) })
    const boxNoRect = boxChunk.panelBoxFor(null)
    add(
      '★ E16 panelBoxFor 按触发按钮的 rect 算出 fixed 落点（right/top/width，含右边与屏幕底部收边）',
      box.right === 100 && box.top === 36 && box.width === 440 && box.maxHeight === 560 && boxEdge.right === 8 && boxEdge.top === 792 && boxNoRect.right === 8 && boxNoRect.top === 8,
      `rect{right:1180,bottom:30} ⇒ ${JSON.stringify(box)}　贴边{right:1276,bottom:795} ⇒ ${JSON.stringify(boxEdge)}　还没挂上(null) ⇒ ${JSON.stringify(boxNoRect)}`,
    )

    // ★ E17 没有 createPortal（自测桩 / 老环境）⇒ 回退成原样渲染：不抛、返回原节点
    const noDom = portalChunk.create({ require: () => ({}) })
    const bare = portalChunk.create({})
    const plainNode = React.createElement('div', { 'data-pipeline-panel': 'open' })
    let fallbackThrew = ''
    let fallbackNode = null
    try {
      fallbackNode = noDom.renderPortal(null, plainNode)
      bare.renderPortal(null, plainNode) // 连 require 都没有也不许抛
    } catch (err) {
      fallbackThrew = String((err && err.message) || err)
    }
    add(
      '★ E17 拿不到 createPortal（自测桩 / 无 react-dom 环境）时回退成原样渲染：不抛、原节点直接返回',
      fallbackThrew === '' && noDom.usable() === false && fallbackNode === plainNode && bare.usable() === false,
      `usable=${noDom.usable()}　返回=${fallbackNode === plainNode ? '原节点 ✓' : '(不是原节点)'}　无 require 也 usable=${bare.usable()}${fallbackThrew === '' ? '' : '　抛：' + fallbackThrew}`,
    )

    // ★ E18 诊断行的目标描述升级为「祖先路径」（最多 3 层、总长 ≤80）
    const outsideMod = outsideChunk.create({})
    const deepTarget = {
      tagName: 'SPAN',
      attributes: [],
      parentElement: {
        tagName: 'BUTTON',
        attributes: [{ name: 'data-pipeline-panel-trigger' }],
        parentElement: { tagName: 'DIV', attributes: [{ name: 'data-pipeline-panel-root' }], parentElement: null },
      },
    }
    const deepDesc = outsideMod.describeTarget(deepTarget)
    const wantDesc = 'DIV[data-pipeline-panel-root] > BUTTON[data-pipeline-panel-trigger] > SPAN'
    add(
      '★ E18 诊断行里的目标描述带祖先路径（最多 3 层、总长 ≤80）：SPAN > BUTTON[data-pipeline-panel-trigger]',
      deepDesc === wantDesc && deepDesc.length <= 80 && outsideMod.describeTarget({ tagName: 'SPAN', attributes: [], parentElement: null }) === 'SPAN',
      `描述：${deepDesc}　（${deepDesc.length} 字符；单层目标 ⇒ ${outsideMod.describeTarget({ tagName: 'SPAN', attributes: [], parentElement: null })}）`,
    )
  } catch (err) {
    add('!! 执行异常（后面的断言不再可信）', false, err?.stack ?? err)
  }
  return answer()
}

function renderText(items) {
  const lines = ['='.repeat(78), 'dsh-pipeline · 面板头部按钮回归（node:vm + 桩 React/document，无浏览器）', '='.repeat(78), '', '【E 面板头部按钮】']
  for (const item of items) {
    lines.push(`  ${item.pass ? '✓' : '✗'} ${item.name}`)
    if (item.detail !== '') lines.push(`      ${item.detail.split('\n').join('\n      ')}`)
  }
  const passed = items.filter((item) => item.pass).length
  lines.push('', '='.repeat(78), `总计：${passed}/${items.length} 通过`, '='.repeat(78))
  lines.push('', '★ 没验到的（如实列出）：真实浏览器里的像素级事件顺序 / Electron 窗口拖拽区，需要真机。')
  return lines.join('\n')
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runPanelUiCheck().then((result) => {
    console.log(result.text)
    if (result.passed !== result.total) process.exitCode = 1
  })
}
