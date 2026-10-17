// 弹层 **portal** 回归（P1–P4）：挂到 document.body、fixed 落点与收边、拿不到 react-dom 时回退、诊断目标路径。
/**
 * dsh-pipeline · 弹层 portal 回归（真机根因的修法：弹层不再长在宿主头部那份 DOM 里）
 * ============================================================================
 *     node tests/panel-portal-check.mjs
 *
 * 真机现场（已用诊断行取证，不是猜）：弹层当时是 `position:absolute` 挂在会话头部的 slot DOM 里，
 * 用户点面板头部的「批量 / 归档 N」时，事件落到**宿主头部那颗按钮的 SPAN** 上
 * （诊断：`上次收起：trigger` / `上次点击：SPAN`）—— 视觉在下面，命中却被宿主那层吃掉。
 * 修法：弹层用 `createPortal` 挂到 `document.body` 并改 `position:fixed`，落点按触发按钮的
 * `getBoundingClientRect()` 现算。这一套钉住修法的四件事：
 *   P1 有 react-dom ⇒ 弹层经 `createPortal(children, document.body)` 渲染（断言调用参数）
 *   P2 `panelBoxFor`：right = 视口宽 - rect.right、top = rect.bottom + 6、width = min(440, 92vw)，
 *      以及右边 / 视口底部的收边；根节点还没挂上时给兜底落点
 *   P3 拿不到 createPortal（自测桩 / 老环境 / 连 require 都没有）⇒ 回退成原样渲染：不抛、原节点直接返回
 *   P4 诊断行里的目标描述带祖先路径（最多 3 层、总长 ≤80）—— 下一次排障不用再猜
 *
 * ★ 面板交互那半边（头部按钮 / 点外面关闭）在 `tests/panel-ui-check.mjs`；共享夹具在
 *   `tests/panel-ui-fixtures.mjs`（**不是测试**，刻意不登记）。拆文件的理由：
 *   `CONVENTIONS.md`「单个测试文件 ≤ 400 行」—— 这四条原先挂在 panel-ui-check 的 E15–E18，
 *   判据一个字没改，只换了编号。
 * ★ 只读仓库里的 `lib/client*.js`，不联网、不建会话、不碰任何活体数据。
 *
 * @module dsh-pipeline/tests/panel-portal-check
 */

import { makeEnvironment, renderReport, runDirect } from './panel-ui-fixtures.mjs'

const TITLE = 'dsh-pipeline · 弹层 portal 回归（node:vm + 桩 React/document，无浏览器）'
const LIMITS = ['真实 Electron 里的层叠与命中顺序 / 像素落点，需要真机。']

export async function runPanelPortalCheck() {
  const items = []
  const add = (name, pass, detail) => items.push({ name, pass: pass === true, detail: String(detail ?? '') })
  const answer = () => renderReport(TITLE, 'P 弹层 portal', items, LIMITS)

  const env = makeEnvironment()
  const React = env.React
  const portalChunk = env.chunkExports['./client.panel-portal.js']
  const outsideChunk = env.chunkExports['./client.panel-outside.js']

  try {
    // ★ P1 有 react-dom ⇒ 弹层走 createPortal(children, document.body)
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
      '★ P1 拿到 react-dom 时弹层经 createPortal(children, document.body) 渲染 —— 弹层不再长在宿主头部那份 DOM 里',
      portalWithDom.usable() === true && portalCalls.length === 1 && portalCalls[0].children === cardNode && portalCalls[0].container === env.doc.body && portaled === portalCalls[0].node,
      `usable=${portalWithDom.usable()}　createPortal 调用 ${portalCalls.length} 次　container=${portalCalls[0]?.container === env.doc.body ? 'document.body ✓' : String(portalCalls[0]?.container)}　返回值=${portaled === portalCalls[0]?.node ? '就是 createPortal 的返回值' : '(对不上)'}`,
    )

    // ★ P2 落点：right = 视口宽 - rect.right、top = rect.bottom + 6、width = min(440, 92vw)，越界收边
    env.window.innerWidth = 1280
    env.window.innerHeight = 800
    const boxChunk = portalChunk.create({ require: () => null })
    const box = boxChunk.panelBoxFor({ getBoundingClientRect: () => ({ right: 1180, bottom: 30 }) })
    const boxEdge = boxChunk.panelBoxFor({ getBoundingClientRect: () => ({ right: 1276, bottom: 795 }) })
    const boxNoRect = boxChunk.panelBoxFor(null)
    add(
      '★ P2 panelBoxFor 按触发按钮的 rect 算出 fixed 落点（right/top/width，含右边与屏幕底部收边）',
      box.right === 100 && box.top === 36 && box.width === 440 && box.maxHeight === 560 && boxEdge.right === 8 && boxEdge.top === 792 && boxNoRect.right === 8 && boxNoRect.top === 8,
      `rect{right:1180,bottom:30} ⇒ ${JSON.stringify(box)}　贴边{right:1276,bottom:795} ⇒ ${JSON.stringify(boxEdge)}　还没挂上(null) ⇒ ${JSON.stringify(boxNoRect)}`,
    )

    // ★ P3 没有 createPortal（自测桩 / 老环境）⇒ 回退成原样渲染：不抛、返回原节点
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
      '★ P3 拿不到 createPortal（自测桩 / 无 react-dom 环境）时回退成原样渲染：不抛、原节点直接返回',
      fallbackThrew === '' && noDom.usable() === false && fallbackNode === plainNode && bare.usable() === false,
      `usable=${noDom.usable()}　返回=${fallbackNode === plainNode ? '原节点 ✓' : '(不是原节点)'}　无 require 也 usable=${bare.usable()}${fallbackThrew === '' ? '' : '　抛：' + fallbackThrew}`,
    )

    // ★ P4 诊断行的目标描述升级为「祖先路径」（最多 3 层、总长 ≤80）
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
      '★ P4 诊断行里的目标描述带祖先路径（最多 3 层、总长 ≤80）：SPAN > BUTTON[data-pipeline-panel-trigger]',
      deepDesc === wantDesc && deepDesc.length <= 80 && outsideMod.describeTarget({ tagName: 'SPAN', attributes: [], parentElement: null }) === 'SPAN',
      `描述：${deepDesc}　（${deepDesc.length} 字符；单层目标 ⇒ ${outsideMod.describeTarget({ tagName: 'SPAN', attributes: [], parentElement: null })}）`,
    )
  } catch (err) {
    add('!! 执行异常（后面的断言不再可信）', false, err?.stack ?? err)
  }
  return answer()
}

runDirect(runPanelPortalCheck, import.meta.url)
