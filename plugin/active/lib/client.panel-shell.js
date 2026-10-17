/* client.panel-shell.js —— 面板**组件本体**：建共享作用域 S、按依赖序调各 chunk 的 create / setup，再把骨架串起来（触发器 → 头部 → 提示 → 列表 → 批量栏 → 弹层 → 预览浮层 → 根节点）。渲染细节在 view / atoms / controls / menu / seats / batch-bar，document 监听在 outside 的 setup 里。 */
;(function () {
  'use strict'

  /** 本 chunk 的 require（由文件末尾的 factory 注入）：弹层要取 react-dom 的 createPortal，只能从这里转交给 portal chunk。 */
  var CHUNK_REQUIRE = null

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    /**
     * 造出面板组件本身。
     *
     * 这个 chunk 只做**拼装**：每轮渲染建一个共享作用域 S，按依赖序让各 chunk 的 setup
     * 把状态与回调挂上去，然后把面板骨架（触发器 → 头部 → 提示 → 列表 → 批量栏 →
     * 弹层 → 预览浮层 → 根节点）串起来。渲染细节全在 view / atoms / controls /
     * menu / seats / batch-bar 里。
     *
     * @param {object} opts - { React, ctx, mods }（mods 是各 chunk 的 exports）
     */
    function createPanel(opts) {
      var React = opts.React
      var ctx = opts.ctx
      var m = opts.mods

      // 各 chunk 按依赖序 create：每个只拿到它自己用到的模块，且都在它前面建好。
      var deps = {}
      deps.actions = m.actions.create({})
      deps.atoms = m.atoms.create({ actions: deps.actions })
      // 可点控件（头按钮 / 批量圆勾 / 📌 / 内边距常量）用内容原子的事件截断
      deps.controls = m.controls.create({ atoms: deps.atoms })
      deps.seats = m.seats.create({})
      deps.menu = m.menu.create({ actions: deps.actions, atoms: deps.atoms })
      deps.view = m.view.create({
        actions: deps.actions,
        atoms: deps.atoms,
        controls: deps.controls,
        seats: deps.seats,
        menu: deps.menu,
      })
      deps.batch = m.batch.create({ actions: deps.actions })
      deps.batchBar = m['batch-bar'].create({ actions: deps.actions, controls: deps.controls })
      deps.preview = m.preview.create({})
      deps.previewData = m['preview-data'].create({ preview: deps.preview })
      deps.previewBubble = m['preview-bubble'].create({ preview: deps.preview })
      deps.previewControl = m['preview-control'].create({
        preview: deps.preview,
        previewData: deps.previewData,
        previewBubble: deps.previewBubble,
        seats: deps.seats,
        actions: deps.actions,
      })
      // 数据面（轮询 / 两份取数 / 失败保留旧数据）与交互状态（开合 / 菜单 / 批量 / 预览槽 / openSeat）
      deps.poll = m.poll.create({ actions: deps.actions })
      deps.interact = m.interact.create({ actions: deps.actions, preview: deps.preview })
      deps.cardActions = m['card-actions'].create({ actions: deps.actions })
      // 弹层的出口：挂到 document.body 的 portal（宿主头部会把弹层上的点击吃掉 —— 真机根因）；
      // 拿不到 react-dom（自测桩 / 老环境）时 portal chunk 自己回退成原样渲染。
      deps.portal = m.portal.create({ require: CHUNK_REQUIRE })
      // 「点外面关闭 / ESC」的判据、处理器与**监听挂载点**都在这一块（它的 setup 必须最后调）
      deps.outside = m.outside.create({})

      /** 右上角的「多AI协调团队」面板：看得到队员（任务 + 席位 + 状态），点名字打开对话。 */
      function PipelinePanel(props) {
        // 每轮渲染新建：拆分前它是一个闭包，现在是一个对象 —— 语义一样，都是「这一轮的值」。
        var S = { React: React, ctx: ctx, props: props }
        // 顺序即依赖：数据面 → 交互状态 → 卡片动作 → 批量 → 归档视图 → 预览状态机 → 弹层落点 → 「点外面」
        deps.poll.setup(S)
        deps.interact.setup(S)
        deps.cardActions.setup(S)
        deps.batch.setup(S)
        deps.batch.setupArchivedView(S)
        deps.previewControl.setup(S)
        deps.portal.setup(S)
        deps.outside.setup(S)

        // 把共享作用域里的东西取到同名局部变量上 —— 下面从原组件搬来的代码因此一行都不用改。
        var open = S.open, setOpen = S.setOpen, batch = S.batch, actionUi = S.actionUi
        var menuKey = S.menuKey, view = S.view, archived = S.archived, snap = S.snap
        var openError = S.openError, sessionId = S.sessionId
        var pinnedRef = S.pinnedRef, rootRef = S.rootRef, setPinned = S.setPinned
        var menuRef = S.menuRef, menuTriggerRef = S.menuTriggerRef
        var cancelHover = S.cancelHover, scheduleOpen = S.scheduleOpen, scheduleClose = S.scheduleClose
        var exitBatch = S.exitBatch
        var toggleSelect = S.toggleSelect, onActionClick = S.onActionClick, toggleCardMenu = S.toggleCardMenu
        var onPinClick = S.onPinClick, toggleBatch = S.toggleBatch, onBatchAction = S.onBatchAction
        var schedulePreviewShow = S.schedulePreviewShow, schedulePreviewHide = S.schedulePreviewHide
        var openArchivedView = S.openArchivedView, backToTasks = S.backToTasks, openSeat = S.openSeat
        var stopHostEvent = deps.atoms.stopHostEvent
        var PANEL_PAD_X = deps.controls.PANEL_PAD_X, PANEL_PAD_BOTTOM = deps.controls.PANEL_PAD_BOTTOM
        var renderPanelHeader = deps.view.renderPanelHeader, renderTaskList = deps.view.renderTaskList
        var renderArchivedList = deps.view.renderArchivedList
        // portal：弹层挂到 document.body 上（portalOn）+ 现算的落点；非 portal 模式两者都不用
        var portalOn = S.portalOn, popoverBox = S.popoverBox, renderPortal = S.renderPortal
        var renderBatchBar = deps.batchBar.renderBatchBar, batchActionsFor = deps.batchBar.batchActionsFor

        var tasks = snap === null ? null : Array.isArray(snap.tasks) ? snap.tasks : null
        var errorText = snap !== null && typeof snap.error === 'string' ? snap.error : ''
        var countText = tasks === null ? (errorText === '' ? '…' : '—') : String(tasks.length)
        var trigger = React.createElement(
          'button',
          {
            type: 'button',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': '多AI协调团队面板' + (tasks === null ? '' : '：' + tasks.length + ' 个任务'),
            'data-pipeline-panel-trigger': open ? 'open' : 'closed',
            onMouseEnter: scheduleOpen,
            onClick: function (ev) {
              // 先截住宿主的头部处理器（否则这一下点击会冒到宿主那儿，把面板连带收掉），再 toggle
              stopHostEvent(ev)
              // 点击 = 钉住 / 取消钉住。悬停打开的算是"没钉住"，点一下才钉住；
              // 钉住后鼠标移开不会收起，再点一下面板才收。
              cancelHover()
              var next = !(open && pinnedRef.current)
              setPinned(next)
              setOpen(next)
            },
            onPointerDown: stopHostEvent,
            onDoubleClick: stopHostEvent,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              height: '26px',
              padding: '0 10px',
              margin: '0 2px',
              font: 'inherit',
              fontSize: '12px',
              lineHeight: '1',
              color: 'inherit',
              background: open ? 'rgba(127,127,127,.14)' : 'transparent',
              border: '1px solid rgba(139,148,158,.45)',
              borderRadius: '999px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              userSelect: 'none',
              // 会话头部是 Electron 的窗口拖拽区：不写这一行，点击会被当成拖窗口。
              WebkitAppRegion: 'no-drag',
            },
          },
          React.createElement('span', null, '多AI协调团队'),
          React.createElement('span', { style: { opacity: 0.7, fontVariantNumeric: 'tabular-nums' } }, countText),
        )
        // ---- 面板骨架（分区拼装）：头部 → 提示 → 列表 → 批量栏 ----
        //   每个分区都是 view / batch-bar chunk 里的一个独立函数，这里只负责按顺序把它们串起来。
        var archivedCount = archived !== null && Array.isArray(archived.tasks) ? archived.tasks.length : null
        var selectedIds = batch.on ? batch.selected : []

        var children = []
        children.push(
          renderPanelHeader(React, {
            view: view,
            tasksCount: tasks === null ? null : tasks.length,
            archivedCount: archivedCount,
            batch: batch.on,
            onToggleBatch: toggleBatch,
            onOpenArchive: openArchivedView,
            onBackToTasks: backToTasks,
          }),
        )
        // 面板顶部那一行操作结果：成功绿色、失败红色（失败时按钮保持可点，直接重试）
        if (actionUi.note !== null && typeof actionUi.note.text === 'string' && actionUi.note.text !== '') {
          var noteIsErr = actionUi.note.kind === 'err'
          children.push(
            React.createElement(
              'div',
              {
                key: 'actionNote',
                role: noteIsErr ? 'alert' : 'status',
                'data-pipeline-action-note': noteIsErr ? 'error' : 'ok',
                style: {
                  marginTop: '6px',
                  fontSize: '11px',
                  lineHeight: '1.5',
                  color: noteIsErr ? '#d9534f' : '#2ea043',
                  wordBreak: 'break-word',
                },
              },
              actionUi.note.text,
            ),
          )
        }
        if (openError !== '') {
          children.push(
            React.createElement(
              'div',
              {
                key: 'openErr',
                role: 'alert',
                style: { marginTop: '6px', fontSize: '11px', lineHeight: '1.5', color: '#d9534f', wordBreak: 'break-word' },
              },
              openError,
            ),
          )
        }
        // 卡片级回调（任务卡与归档卡共用同一套 opts）
        var cardOpts = {
          batch: batch.on,
          selectedIds: selectedIds,
          onToggleSelect: toggleSelect,
          currentSessionId: sessionId,
          onOpen: openSeat,
          // 卡片右上角「⋯」菜单（来源 = `allowed_actions`；归档卡固定 恢复 / 永久删除）
          busyKey: actionUi.busyKey,
          armedKey: actionUi.armedKey,
          actionBusy: actionUi.busyKey !== '',
          onAction: onActionClick,
          // 菜单开关（一次只开一个；'' = 都关）
          menuKey: menuKey,
          onMenuToggle: toggleCardMenu,
          // "点菜单外 / ESC 关闭"要用：当前打开的那个菜单容器与「⋯」触发器
          menuRef: menuRef,
          menuTriggerRef: menuTriggerRef,
          // 置顶（📌）
          onPin: onPinClick,
          // 悬停预览
          onPreviewEnter: schedulePreviewShow,
          onPreviewLeave: schedulePreviewHide,
        }
        if (view === 'archived') {
          children.push(renderArchivedList(React, Object.assign({}, cardOpts, { archived: archived })))
        } else {
          children.push(renderTaskList(React, Object.assign({}, cardOpts, { tasks: tasks, error: errorText })))
        }
        if (view === 'tasks' && tasks !== null && errorText !== '') {
          children.push(
            React.createElement(
              'div',
              {
                key: 'netErr',
                role: 'status',
                style: { marginTop: '8px', fontSize: '10.5px', lineHeight: '1.5', color: '#d29922', wordBreak: 'break-word' },
              },
              '读取失败（显示的是上一次的数据）：' + errorText,
            ),
          )
        }
        // 归档列表"读到的是上一次的数据"提示（与主视图同一套规矩）
        if (view === 'archived' && archived !== null && archived.error !== '' && archived.tasks !== null) {
          children.push(
            React.createElement(
              'div',
              {
                key: 'archErr',
                role: 'status',
                style: { marginTop: '8px', fontSize: '10.5px', lineHeight: '1.5', color: '#d29922', wordBreak: 'break-word' },
              },
              '归档列表读取失败（显示的是上一次的数据）：' + archived.error,
            ),
          )
        }
        // 底部的批量操作栏：只放「对当前视图有意义」的动作（删除类要两击）
        var batchActions = batchActionsFor(S)
        children.push(
          renderBatchBar(React, {
            visible: batch.on,
            count: batch.selected.length,
            busy: batch.busy,
            done: batch.done,
            total: batch.total,
            actions: batchActions,
            onAction: onBatchAction,
            onCancel: exitBatch,
          }),
        )
        // 弹层容器与它的出口（portal / 非 portal 那层「缝」）都在 portal chunk：这里只递 children 与落点
        var popover = deps.portal.renderPopover(React, {
          open: open,
          children: children,
          view: view,
          batchOn: batch.on,
          portalOn: portalOn,
          popoverBox: popoverBox,
          stopHostEvent: stopHostEvent,
          cancelHover: cancelHover,
          scheduleClose: scheduleClose,
          padX: PANEL_PAD_X,
          padBottom: PANEL_PAD_BOTTOM,
        })

        // 席位会话预览浮层（贴在面板左侧的大聊天窗）：内容与状态机都在 preview-control / preview-bubble 里；
        // 它本来就是 position:fixed，portal 之后同样挂到 body（不再受根节点所在的层叠 / 裁剪影响）
        var previewNode = renderPortal(rootRef.current, S.renderPreview())
        return React.createElement(
          'div',
          {
            ref: rootRef,
            'data-pipeline-panel-root': 'true',
            onMouseEnter: cancelHover,
            onMouseLeave: scheduleClose,
            // 面板根节点是"边界"：里面的 pointerdown / click / dblclick 一律不再交给宿主（会话头部是
            // 窗口拖拽区，也在监听这些事件；不截住的话点面板顶部那一行会冒到宿主 ⇒ 按钮不响应、面板反被关）
            onPointerDown: stopHostEvent,
            onClick: stopHostEvent,
            onDoubleClick: stopHostEvent,
            style: { position: 'relative', display: 'inline-flex', alignItems: 'center', WebkitAppRegion: 'no-drag' },
          },
          trigger,
          popover,
          previewNode,
        )
      }

      return PipelinePanel
    }

    return { createPanel: createPanel }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-shell.js',
    factory: function (require) {
      CHUNK_REQUIRE = typeof require === 'function' ? require : null
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
