/* client.panel-preview-control.js —— 预览层的状态机与三种收尾：悬停计时、30 秒缓存、在途序号防串台、点气泡开真实会话，以及卸载 / 会话切换 / 滚动或尺寸变化时收掉浮层。 */
;(function () {
  'use strict'

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    var seatName = deps.seats.seatName
    var messageOf = deps.actions.messageOf
    var loadSessionPreviewRows = deps.previewData.loadSessionPreviewRows
    var previewBoxFor = deps.previewData.previewBoxFor
    var releaseSessionRef = deps.preview.releaseSessionRef
    var resolveUiWorkspace = deps.preview.resolveUiWorkspace
    var PREVIEW_CACHE_MS = deps.preview.PREVIEW_CACHE_MS
    var PREVIEW_SHOW_MS = deps.preview.PREVIEW_SHOW_MS
    var PREVIEW_HIDE_MS = deps.preview.PREVIEW_HIDE_MS

    /**
     * 预览层的**状态机**：悬停 400ms 弹出、移开 600ms 收起、30 秒缓存、在途序号防串台，
     * 以及「点气泡打开真实会话」。收尾副作用（卸载 / 会话切换 / 滚动与尺寸变化）也在这里。
     *
     * @param {object} S 面板的共享作用域（preview 状态与那几个 ref 都在里面）
     */
    function setup(S) {
      var React = S.React
      var ctx = S.ctx
      var preview = S.preview
      var setPreview = S.setPreview
      var previewRef = S.previewRef
      var previewTimerRef = S.previewTimerRef
      var previewCacheRef = S.previewCacheRef
      var previewBoxRef = S.previewBoxRef
      var rootRef = S.rootRef
      var aliveRef = S.aliveRef
      var setOpenError = S.setOpenError
      var scheduleClose = S.scheduleClose
      var sessionId = S.sessionId
      var hoverTimerRef = S.hoverTimerRef
      var armTimerRef = S.armTimerRef
      var cancelHover = S.cancelHover
      var setPinned = S.setPinned
      var setOpen = S.setOpen
      var clearArmTimer = S.clearArmTimer
      var setMenuKey = S.setMenuKey
      var patchActionUi = S.patchActionUi
      var actionUi = S.actionUi
      var batch = S.batch
      var exitBatch = S.exitBatch

      // =======================================================================
      // 席位会话预览（悬停 400ms 弹出，可移入、可用滚轮翻）
      // =======================================================================

      var clearPreviewTimer = function () {
        if (previewTimerRef.current === null) return
        clearTimeout(previewTimerRef.current)
        previewTimerRef.current = null
      }
      /** 关掉预览（幂等；顺带把在途读取的结果作废）。 */
      var closePreview = function () {
        clearPreviewTimer()
        if (!previewRef.current.open) {
          if (aliveRef.current) setPreview(null)
          return
        }
        previewRef.current.open = false
        previewRef.current.key = ''
        previewRef.current.seq += 1
        previewBoxRef.current = null
        if (aliveRef.current) setPreview(null)
      }
      /** 把读到的行落到预览层 —— 只有"还是同一条预览"时才落（防止晚到的回包串台）。 */
      var applyPreviewRows = function (key, rows) {
        setPreview(function (prev) {
          if (prev === null || prev.key !== key) return prev
          var hasRows = Array.isArray(rows) && rows.length > 0
          return {
            key: prev.key,
            name: prev.name,
            sessionId: prev.sessionId,
            box: prev.box,
            phase: hasRows ? 'ready' : 'none',
            rows: hasRows ? rows : null,
          }
        })
      }
      /** 取数：先看缓存（30 秒内同一会话不重复 retain），没有才走 `sessions` 服务。 */
      var loadPreview = function (key, sessionIdToRead) {
        var cache = previewCacheRef.current
        var hit = cache.rows[sessionIdToRead]
        if (hit !== undefined && Date.now() - hit.at < PREVIEW_CACHE_MS) {
          applyPreviewRows(key, hit.rows)
          return
        }
        var seq = previewRef.current.seq + 1
        previewRef.current.seq = seq
        loadSessionPreviewRows(ctx, sessionIdToRead, cache).then(
          function (rows) {
            cache.rows[sessionIdToRead] = { at: Date.now(), rows: Array.isArray(rows) ? rows : [] }
            if (!aliveRef.current || previewRef.current.seq !== seq || previewRef.current.key !== key) return
            applyPreviewRows(key, rows)
          },
          function () {
            // 失败也缓存（同一条 30 秒口径）：不会因为鼠标扫过一排 chip 就狂打历史流。
            cache.rows[sessionIdToRead] = { at: Date.now(), rows: [] }
            if (!aliveRef.current || previewRef.current.seq !== seq || previewRef.current.key !== key) return
            applyPreviewRows(key, null)
          },
        )
      }
      /**
       * 悬停 400ms → 弹预览；换到另一格先撤掉上一个。
       * 落点按**面板根节点**算（贴面板左侧），不跟 chip 走 —— chip 只负责触发。
       */
      var schedulePreviewShow = function (seat) {
        var safe = seat !== null && typeof seat === 'object' ? seat : {}
        var target = typeof safe.session_id === 'string' ? safe.session_id : ''
        if (target === '') return // 没有会话 id 的席位没得预览
        var name = seatName(safe)
        var key = target + '|' + name
        clearPreviewTimer()
        if (previewRef.current.key === key && previewRef.current.open) return
        if (previewRef.current.open) closePreview()
        previewTimerRef.current = setTimeout(function () {
          previewTimerRef.current = null
          if (!aliveRef.current) return
          previewRef.current.open = true
          previewRef.current.key = key
          previewRef.current.seq += 1
          // 左贴面板的大窗：宽高随视口，位置按面板根节点的 rect 推面板左边缘
          setPreview({
            key: key,
            name: name,
            sessionId: target,
            phase: 'loading',
            rows: null,
            box: previewBoxFor(rootRef.current),
          })
          loadPreview(key, target)
        }, PREVIEW_SHOW_MS)
      }
      /** 指针离开 chip：先取消待弹出的计时；已经弹出的等 600ms（移进左侧预览窗会取消）。 */
      var schedulePreviewHide = function () {
        clearPreviewTimer()
        if (!previewRef.current.open) return
        previewTimerRef.current = setTimeout(function () {
          previewTimerRef.current = null
          closePreview()
          // 预览收掉之后，把"面板该不该收起"交还给原来的悬停规则
          scheduleClose()
        }, PREVIEW_HIDE_MS)
      }
      /** 指针移进预览层（或滚轮翻消息）时不关它。 */
      var keepPreview = function () {
        clearPreviewTimer()
      }
      /**
       * 点预览里的**任意气泡**（或底部那行「点击气泡打开会话 →」）⇒ 打开真实会话。
       *
       * 与面板里点席位名字同一条路径：`resolveUiWorkspace(ctx)` + `openSession(sessionId)`。
       * 预览只会是普通 session 会话，不走 team 的 continuable 形态。
       * 没会话 id / 没有 uiWorkspace 服务 ⇒ 不动作、保持现状（不弹错误）。
       * 点击先 `stopPropagation`：不冒到面板的"点外面关闭"，也不触发宿主头部的语义。
       */
      var openSessionFromPreview = function (ev) {
        if (ev !== null && ev !== undefined && typeof ev.stopPropagation === 'function') ev.stopPropagation()
        var target = preview !== null && typeof preview.sessionId === 'string' ? preview.sessionId : ''
        if (target === '') return
        var workspace = resolveUiWorkspace(ctx)
        if (workspace === null) return
        var out = null
        try {
          out = workspace.openSession(target)
        } catch (err) {
          if (aliveRef.current) setOpenError('打不开会话：' + messageOf(err))
          return
        }
        // 打开后收起预览（先不管异步回包；失败再在面板里报一句人话）
        if (aliveRef.current) setOpenError('')
        closePreview()
        if (out !== null && out !== undefined && typeof out.then === 'function') {
          out.then(
            function () {},
            function (err) {
              if (aliveRef.current) setOpenError('打不开会话：' + messageOf(err))
            },
          )
        }
      }

      // ---- 收尾副作用：卸载 / 会话切换 / 滚动与尺寸变化 ----

      // 卸载时清掉所有定时器，并把还留着的会话引用一并释放（避免卸载后还 setState / 占着历史流）
      React.useEffect(function () {
        return function () {
          if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current)
          if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current)
          if (armTimerRef.current !== null) clearTimeout(armTimerRef.current)
          var retained = previewCacheRef.current.retained
          while (retained.length > 0) releaseSessionRef(retained.pop())
        }
      }, [])
      // 会话切换时收起面板并清掉上一条错误 —— 别让「打不开会话：…」跟着用户跑到新会话里。
      var lastSessionRef = React.useRef(sessionId)
      React.useEffect(function () {
        if (lastSessionRef.current === sessionId) return
        lastSessionRef.current = sessionId
        cancelHover()
        setPinned(false)
        setOpen(false)
        setOpenError('')
        // 预览 / 删单确认态 / 操作提示 / 批量选择 / 卡片菜单都是**上一个会话**那一屏的东西，一起撤掉。
        closePreview()
        clearArmTimer()
        setMenuKey('')
        if (actionUi.armedKey !== '' || actionUi.note !== null) patchActionUi({ armedKey: '', note: null })
        if (batch.on || batch.selected.length > 0) exitBatch()
      }, [sessionId])
      // ---- 预览层开着时：滚出（面板滚动/页面滚动）或窗口尺寸变化就收掉 ----
      //   `position:fixed` 的浮层不会跟着面板一起滚，留到滚动之后只会变成一个飘着的旧框。
      React.useEffect(function () {
        if (preview === null) return undefined
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        var onScroll = function (ev) {
          // 预览层**自己**的滚轮（翻那 12 条消息）不算"滚出去"：
          // scroll 不冒泡，但 window 的捕获阶段照样收得到，所以要看一眼 target 在不在预览层里。
          var box = previewBoxRef.current
          if (
            box !== null &&
            ev !== null &&
            ev !== undefined &&
            ev.target !== null &&
            typeof box.contains === 'function' &&
            box.contains(ev.target)
          ) {
            return
          }
          closePreview()
        }
        var onResize = function () {
          closePreview()
        }
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onResize)
        return function () {
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onResize)
        }
      }, [preview !== null])

      /** 浮层本体在 preview-bubble 里；这里只把它的三个回调接上（都是本文件的状态机）。 */
      S.renderPreview = function () {
        return deps.previewBubble.renderPreview(S, {
          keepPreview: keepPreview,
          schedulePreviewHide: schedulePreviewHide,
          openSessionFromPreview: openSessionFromPreview,
        })
      }

      S.clearPreviewTimer = clearPreviewTimer
      S.closePreview = closePreview
      S.applyPreviewRows = applyPreviewRows
      S.loadPreview = loadPreview
      S.schedulePreviewShow = schedulePreviewShow
      S.schedulePreviewHide = schedulePreviewHide
      S.keepPreview = keepPreview
      S.openSessionFromPreview = openSessionFromPreview
    }

    return { setup: setup }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-preview-control.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
