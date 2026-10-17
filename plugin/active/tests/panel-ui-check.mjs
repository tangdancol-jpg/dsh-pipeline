// 面板**头部按钮与「点外面关闭」**回归（E0–E13）：点「批量」/「归档 N」面板必须还在；判据缺失时不误关。
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
 * 钉住 E0 打开并挂上监听 / E1 回调接上 / E2-E3 批量 on↔off / E4-E5 归档↔返回 / E6 pointerdown 不误关 /
 * ★E7 rootRef 为 null 时**不许**关 / E8 按钮自己 stopPropagation + no-drag /
 * E9 收尾仍开着 / E10 点真外面仍然照旧关（防御是窄的）/
 * ★E11 rootRef 脱手（被替换的节点 / null）时，target 明确在 `[data-pipeline-panel]` 里 ⇒ 不关（真机根因）/
 * ★E12 target 在 `[data-pipeline-panel-root]` 里（触发器）⇒ 不关（DOM 属性那一路判据）/
 * ★E13 `document.body` 这种真外部元素 ⇒ 仍然关。
 *
 * ★ 弹层 portal（挂到 document.body / fixed 落点 / 回退，P1–P3）在
 *   `tests/panel-portal-check.mjs`；共享夹具在 `tests/panel-ui-fixtures.mjs`（**不是测试**，
 *   刻意不登记）。拆文件的理由：`CONVENTIONS.md`「单个测试文件 ≤ 400 行」。
 * ★ 只读仓库里的 `lib/client*.js`，不联网、不建会话、不碰任何活体数据。
 *
 * @module dsh-pipeline/tests/panel-ui-check
 */

import { find, flush, has, makeEnvironment, mountPanel, renderReport, runDirect, textOf } from './panel-ui-fixtures.mjs'

const TITLE = 'dsh-pipeline · 面板头部按钮回归（node:vm + 桩 React/document，无浏览器）'
const LIMITS = ['真实浏览器里的像素级事件顺序 / Electron 窗口拖拽区，需要真机。']

export async function runPanelUiCheck() {
  const items = []
  const add = (name, pass, detail) => items.push({ name, pass: pass === true, detail: String(detail ?? '') })
  const answer = () => renderReport(TITLE, 'E 面板头部按钮', items, LIMITS)

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
  } catch (err) {
    add('!! 执行异常（后面的断言不再可信）', false, err?.stack ?? err)
  }
  return answer()
}

runDirect(runPanelUiCheck, import.meta.url)
