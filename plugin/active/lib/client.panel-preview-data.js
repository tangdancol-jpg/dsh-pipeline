/* client.panel-preview-data.js —— 预览的取数与几何：retain 会话引用读事件窗口（带超时、最多同时留 3 个、读完就放），以及贴着面板左边缘算浮层的落点与尺寸。 */
;(function () {
  'use strict'

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    var resolveSessions = deps.preview.resolveSessions
    var releaseSessionRef = deps.preview.releaseSessionRef
    var previewRowsFromEntries = deps.preview.previewRowsFromEntries
    var PREVIEW_MAX_RETAINED = deps.preview.PREVIEW_MAX_RETAINED
    var PREVIEW_LOAD_TIMEOUT_MS = deps.preview.PREVIEW_LOAD_TIMEOUT_MS
    var PREVIEW_MIN_WIDTH = deps.preview.PREVIEW_MIN_WIDTH
    var PREVIEW_MAX_WIDTH = deps.preview.PREVIEW_MAX_WIDTH
    var PREVIEW_WIDTH_RATIO = deps.preview.PREVIEW_WIDTH_RATIO
    var PREVIEW_MIN_HEIGHT = deps.preview.PREVIEW_MIN_HEIGHT
    var PREVIEW_MAX_HEIGHT = deps.preview.PREVIEW_MAX_HEIGHT
    var PREVIEW_HEIGHT_RATIO = deps.preview.PREVIEW_HEIGHT_RATIO
    var PANEL_WIDTH_MAX = deps.preview.PANEL_WIDTH_MAX
    var PANEL_WIDTH_RATIO = deps.preview.PANEL_WIDTH_RATIO
    var PREVIEW_GAP_X = deps.preview.PREVIEW_GAP_X
    var PREVIEW_GAP_Y = deps.preview.PREVIEW_GAP_Y
    var PREVIEW_VIEWPORT_PAD = deps.preview.PREVIEW_VIEWPORT_PAD

    /**
     * 读一个会话最近的事件窗口 → 预览行。
     *
     * 取数路径（与 `@deepseek-ai/dsh-api-session-controller` 的实现/README 一致）：
     *   ① `sessions.retain(sessionId, { source:'gateway' })` → 引用（同步，可能抛）；
     *   ② 引用上 `ready` 结算成**确切 binding**（`ClientSessionReference.ready` 的定义），
     *      拿不到就退回同步的 `ref.binding`；binding 上是 `binding.eventSource`；
     *   ③ `eventSource.getSnapshot()` 是 `ObservableSnapshot<SessionEventWindow>`，
     *      `.entries` 就是事件窗口；
     *   ④ 读到文本后**立刻释放**引用（预览只要几行字，不需要一直占着历史流）。
     *
     * 任一步失败都 reject —— 调用方把预览层降级成一行灰字（不假装有内容）。
     *
     * @param {object} ctx - 客户端 cordis 上下文（用来 `ctx.get('sessions')`）
     * @param {string} sessionId
     * @param {{rows:object, retained:Array}} cache - 面板实例的缓存（管"最多同时保留几个"）
     * @returns {Promise<Array<{type:string, role:string, color:string, text:string}>>}
     */
    function loadSessionPreviewRows(ctx, sessionId, cache) {
      return new Promise(function (resolve, reject) {
        var sessions = resolveSessions(ctx)
        if (sessions === null) {
          reject(new Error('客户端没有提供 sessions 服务'))
          return
        }
        var ref = null
        try {
          ref = sessions.retain(sessionId, { source: 'gateway' })
        } catch (err) {
          reject(err)
          return
        }
        if (ref === null || typeof ref !== 'object') {
          reject(new Error('sessions.retain 没有返回引用'))
          return
        }
        var retained = cache !== null && cache !== undefined && Array.isArray(cache.retained) ? cache.retained : null
        if (retained !== null) {
          // 最多同时保留 3 个：超了先把最老的放掉
          while (retained.length >= PREVIEW_MAX_RETAINED) releaseSessionRef(retained.shift())
          retained.push(ref)
        }
        var settled = false
        var timer = null
        var finish = function (fn, value) {
          if (settled) return
          settled = true
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          if (retained !== null) {
            var at = retained.indexOf(ref)
            if (at !== -1) retained.splice(at, 1)
          }
          releaseSessionRef(ref)
          fn(value)
        }
        timer = setTimeout(function () {
          finish(reject, new Error('会话历史读取超时'))
        }, PREVIEW_LOAD_TIMEOUT_MS)
        var readyP = null
        try {
          readyP = ref.ready !== null && ref.ready !== undefined && typeof ref.ready.then === 'function' ? ref.ready : null
        } catch (err) {
          readyP = null
        }
        Promise.resolve(readyP).then(
          function (value) {
            var binding = null
            try {
              binding = value !== null && typeof value === 'object' && value.eventSource !== undefined ? value : ref.binding
            } catch (err) {
              finish(reject, err)
              return
            }
            var source = binding !== null && typeof binding === 'object' ? binding.eventSource : undefined
            if (source === null || source === undefined || typeof source.getSnapshot !== 'function') {
              finish(reject, new Error('会话事件流不可用'))
              return
            }
            var rows = []
            try {
              var snapshot = source.getSnapshot()
              rows = previewRowsFromEntries(snapshot !== null && typeof snapshot === 'object' ? snapshot.entries : null)
            } catch (err) {
              finish(reject, err)
              return
            }
            finish(resolve, rows)
          },
          function (err) {
            finish(reject, err)
          },
        )
      })
    }
    /**
     * 预览窗的落点与尺寸：**贴在面板左侧的大聊天窗**（`position:fixed`，不盖住任务卡列表）。
     *
     * 坐标口径（按需求给定，不另造）：
     *   · 面板宽按 `min(440px, 92vw)` 估（弹层实际就是 `width: min(440px, 92vw)`，见面板 style）；
     *   · `panelRight = rootRect.right`、`panelLeft = panelRight - panelWidth`；
     *   · 预览**右边缘 = panelLeft - 12**，左边缘 = 右边缘 - 预览宽；
     *   · `top = rootRect.bottom + 8`；越界在视口内收边（左边不小于 8、太靠下就整体上移）。
     *
     * 尺寸：宽 `min(520px, 42vw)`（下限 360）、高 `min(520px, 64vh)`（下限 300），随视口自适应。
     *
     * @param {Element|null} rootEl - 面板根节点（`rootRef.current`）
     * @returns {{left:number, top:number, width:number, height:number}} 全部是 px 数字
     */
    function previewBoxFor(rootEl) {
      var vw =
        typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth > 0 ? window.innerWidth : 1024
      var vh =
        typeof window !== 'undefined' && typeof window.innerHeight === 'number' && window.innerHeight > 0 ? window.innerHeight : 768
      var rect = null
      try {
        rect =
          rootEl !== null && rootEl !== undefined && typeof rootEl.getBoundingClientRect === 'function'
            ? rootEl.getBoundingClientRect()
            : null
      } catch (err) {
        rect = null
      }
      var width = Math.round(Math.min(PREVIEW_MAX_WIDTH, Math.max(PREVIEW_MIN_WIDTH, vw * PREVIEW_WIDTH_RATIO)))
      var height = Math.round(Math.min(PREVIEW_MAX_HEIGHT, Math.max(PREVIEW_MIN_HEIGHT, vh * PREVIEW_HEIGHT_RATIO)))
      if (width > vw - PREVIEW_VIEWPORT_PAD * 2) width = vw - PREVIEW_VIEWPORT_PAD * 2
      if (height > vh - PREVIEW_VIEWPORT_PAD * 2) height = vh - PREVIEW_VIEWPORT_PAD * 2
      var panelWidth = Math.min(PANEL_WIDTH_MAX, Math.round(vw * PANEL_WIDTH_RATIO))
      var panelRight = rect === null ? vw : rect.right
      var panelBottom = rect === null ? PREVIEW_VIEWPORT_PAD : rect.bottom
      // 取整到 px：避免半像素边框让气泡文字发虚
      var left = Math.round(panelRight - panelWidth - PREVIEW_GAP_X - width)
      if (left < PREVIEW_VIEWPORT_PAD) left = PREVIEW_VIEWPORT_PAD
      var top = Math.round(panelBottom + PREVIEW_GAP_Y)
      if (top + height > vh - PREVIEW_VIEWPORT_PAD) top = vh - PREVIEW_VIEWPORT_PAD - height
      if (top < PREVIEW_VIEWPORT_PAD) top = PREVIEW_VIEWPORT_PAD
      return { left: left, top: top, width: width, height: height }
    }

    return {
      loadSessionPreviewRows: loadSessionPreviewRows,
      previewBoxFor: previewBoxFor,
    }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-preview-data.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
