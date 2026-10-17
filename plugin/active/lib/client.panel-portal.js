/* client.panel-portal.js —— 弹层的“出口”：挂到 document.body 的 portal（fixed 定位）+ 落点计算 + 滚动/改尺寸重算。宿主头部是窗口拖拽区、也有自己的层叠与命中区，弹层只要还长在它的 DOM 里，点击就可能被它吃掉；取不到 react-dom（自测桩 / 老环境）时一律回退成原样渲染。 */
;(function () {
  'use strict'

  /** 弹层最宽 / 最高（再按视口收）—— 与原来 `min(440px, 92vw)` / `min(70vh, 560px)` 同口径。 */
  var PANEL_MAX_W = 440
  var PANEL_MAX_H = 560
  var PANEL_WIDTH_RATIO = 0.92
  var PANEL_HEIGHT_RATIO = 0.7
  /** 视口边距：收边时至少留这么多，别贴着屏幕边。 */
  var EDGE = 8
  /** 弹层与触发按钮之间那道缝（原来由外层 `paddingTop: 6px` 撑开，portal 之后要算进 top）。 */
  var GAP = 6
  /** 滚动 / 改尺寸后重算落点的节流窗口（毫秒）。 */
  var REPOSITION_MS = 100

  function isObj(v) {
    return v !== null && v !== undefined && typeof v === 'object'
  }

  /**
   * 取 react-dom。取不到就 **null**：自测的 require 替身没有这个模块（调用会抛）、老宿主也可能不提供 ——
   * 这两种情况都必须回退成原样渲染，而不是把面板整个弄挂。
   *
   * @param {Function|null} requireFn shell 从自己 factory 里存下来的那个 require
   * @returns {object|null}
   */
  function resolveReactDOM(requireFn) {
    try {
      return requireFn('react-dom')
    } catch (err) {
      void err
      return null
    }
  }

  /** portal 得有地方挂：document.body 必须在。 */
  function hasDocument() {
    return typeof document !== 'undefined' && document !== null && isObj(document.body)
  }

  /** 一个真能用的 ReactDOM：必须真有 createPortal（只有个空对象不算）。 */
  function portalCapable(reactDom) {
    return isObj(reactDom) && typeof reactDom.createPortal === 'function'
  }

  /** 视口尺寸；拿不到 window（纯 Node / 自测）就按常见桌面尺寸兜底，只为了不让计算炸。 */
  function viewport() {
    if (typeof window === 'undefined' || window === null) return { w: 1280, h: 800 }
    var w = typeof window.innerWidth === 'number' && window.innerWidth > 0 ? window.innerWidth : 1280
    var h = typeof window.innerHeight === 'number' && window.innerHeight > 0 ? window.innerHeight : 800
    return { w: w, h: h }
  }

  /** 元素的 rect；还没挂上 / 不是元素 / 抛错 ⇒ null（落点退回贴视口右上角的兜底值）。 */
  function rectOf(el) {
    try {
      return isObj(el) && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
    } catch (err) {
      void err
      return null
    }
  }

  /**
   * 弹层的 fixed 落点：贴在**触发的那个按钮**（面板根节点）正下方、右边缘与它对齐。
   *
   * 口径（不另造，沿用原来 absolute 版那套）：
   *   · `right = 视口宽 - rect.right` —— 与触发按钮右边对齐；收边不小于 8，也别把弹层推出左边缘；
   *   · `top = rect.bottom + 6` —— 那 6px 就是原来外层 `paddingTop` 撑出来的缝；
   *   · `width = min(440, 92vw)`、`maxHeight = min(560, 70vh)` —— 与原来的 min() 同口径，只是换成 px；
   *   · `top` 再按视口底部收一次：贴底 / 窗口被压小的按钮不会把弹层顶出屏幕。
   *
   * @param {Element|null} rootEl - 面板根节点（`rootRef.current`，可能还没挂上）
   * @returns {{right:number, top:number, width:number, maxHeight:number}} 全部是 px 数字
   */
  function panelBoxFor(rootEl) {
    var vp = viewport()
    var rect = rectOf(rootEl)
    var width = Math.min(PANEL_MAX_W, Math.round(vp.w * PANEL_WIDTH_RATIO))
    var maxHeight = Math.min(PANEL_MAX_H, Math.round(vp.h * PANEL_HEIGHT_RATIO))
    var right = rect === null ? EDGE : Math.round(vp.w - rect.right)
    var floor = vp.w - width - EDGE // 右边界的上限：再往右就压出左边缘了
    if (floor < EDGE) floor = EDGE // 视口比弹层还窄：先保左边距
    if (!(right >= EDGE)) right = EDGE // NaN / 负数 / 太靠右 ⇒ 收边
    if (right > floor) right = floor
    var top = rect === null ? EDGE : Math.round(rect.bottom + GAP)
    if (!(top >= EDGE)) top = EDGE
    if (top > vp.h - EDGE) top = vp.h - EDGE // 视口底部收边
    return { right: right, top: top, width: width, maxHeight: maxHeight }
  }

  /** @param {object} deps 依赖：`require` 是 shell 从它自己的 factory 里存下来转交的那个 */
  function create(deps) {
    var requireFn = isObj(deps) && typeof deps.require === 'function' ? deps.require : null
    var reactDom = resolveReactDOM(requireFn)

    /** portal 真的能用吗：有 createPortal + 有 document.body。缺一条就一路回退成原样渲染。 */
    function usable() {
      return portalCapable(reactDom) && hasDocument()
    }

    /**
     * 弹层挂到 `document.body`；用不了 portal ⇒ **原样返回 children**（自测桩 / 老环境 / 非 Electron 都走这条）。
     *
     * @param {object} node 锚点（面板根节点）—— 只给排障时对位用，portal 的目标固定是 document.body
     * @param {*} children 弹层节点
     */
    function renderPortal(node, children) {
      void node
      if (!usable()) return children
      return reactDom.createPortal(children, document.body)
    }

    /**
     * 面板每轮渲染调一次（与其它 chunk 的 `setup(S)` 同形）：算出「挂哪 / 落在哪」，
     * 并在 portal 模式 + 面板开着时挂上「窗口滚动（capture）/ 改尺寸 ⇒ 100ms 节流重算」。
     *
     * 为什么要重算：portal 之后弹层不跟着根节点走，而宿主的会话区自己会滚、窗口也会变 ——
     * 不重算它就会留在原地，和触发按钮错位。
     *
     * @param {object} S 面板的共享作用域（open / rootRef / React 在里面）
     */
    function setup(S) {
      var portalOn = usable()
      var bump = S.React.useState(0)[1] // 只为「重算一次」触发重渲染，值本身没人读
      S.React.useEffect(
        function () {
          if (!portalOn || S.open !== true) return undefined
          if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
          // 首帧算落点时根节点可能还没挂上（ref 是 null）⇒ 补算一次，别让弹层停在兜底位置
          bump(function (n) {
            return n + 1
          })
          var timer = null
          var onMove = function () {
            if (timer !== null) return // 100ms 内只算最后那一下
            timer = setTimeout(function () {
              timer = null
              bump(function (n) {
                return n + 1
              })
            }, REPOSITION_MS)
          }
          window.addEventListener('scroll', onMove, true) // capture：会话区自己的滚动不冒泡
          window.addEventListener('resize', onMove)
          return function () {
            if (timer !== null) clearTimeout(timer)
            window.removeEventListener('scroll', onMove, true)
            window.removeEventListener('resize', onMove)
          }
        },
        [portalOn, S.open],
      )
      S.portalOn = portalOn
      S.renderPortal = renderPortal
      // 根节点的 ref 由 data chunk 建（它在 portal 之前 setup），这里只防一手"还没挂上"。
      var rootEl = S.rootRef === undefined || S.rootRef === null ? null : S.rootRef.current
      // 非 portal 模式不算落点：弹层还是 absolute 挂在根节点里，跟着它走就行
      S.popoverBox = portalOn ? panelBoxFor(rootEl) : null
    }

    return {
      resolveReactDOM: resolveReactDOM,
      usable: usable,
      renderPortal: renderPortal,
      panelBoxFor: panelBoxFor,
      setup: setup,
    }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-portal.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
