/* client.panel-shell.js —— 面板组件本体：建共享作用域、按依赖序调用各 chunk 的 setup、拼出面板骨架（触发器/头部/提示/列表/批量栏/预览浮层/根节点），并挂上「打开时点外部或 ESC 关闭」的文档监听。 */
;(function () {
  'use strict'

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    /**
     * 造出面板组件本身。
     *
     * 这个 chunk 只做**拼装**：每轮渲染建一个共享作用域 S，按依赖序让各 chunk 的 setup
     * 把状态与回调挂上去，然后把面板骨架（触发器 → 头部 → 提示 → 列表 → 批量栏 →
     * 预览浮层 → 根节点）串起来。渲染细节全在 view / atoms / menu / seats / batch-bar 里。
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
      deps.seats = m.seats.create({})
      deps.menu = m.menu.create({ actions: deps.actions, atoms: deps.atoms })
      deps.view = m.view.create({ actions: deps.actions, atoms: deps.atoms, seats: deps.seats, menu: deps.menu })
      deps.batch = m.batch.create({ actions: deps.actions })
      deps.batchBar = m['batch-bar'].create({ actions: deps.actions, atoms: deps.atoms })
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
      deps.data = m.data.create({ actions: deps.actions, preview: deps.preview })
      deps.cardActions = m['card-actions'].create({ actions: deps.actions })

      /** ★ 诊断用：这个组件包装器的首轮是否已经执行过（同一实例的后续渲染不再计挂载）。 */
      var instanceStarted = false
      /** 右上角的「多AI协调团队」面板：看得到队员（任务 + 席位 + 状态），点名字打开对话。 */
      function PipelinePanel(props) {
        // ★ 重挂载检测（取证用）：只有包装器首次执行才 +1；同一实例的后续渲染不会重复记（StrictMode 亦然）。
        if (!instanceStarted) {
          instanceStarted = true
          deps.data.beginMount()
        }
        // 每轮渲染新建：拆分前它是一个闭包，现在是一个对象 —— 语义一样，都是「这一轮的值」。
        var S = { React: React, ctx: ctx, props: props }
        deps.data.setup(S)
        deps.cardActions.setup(S)
        deps.batch.setup(S)
        deps.batch.setupArchivedView(S)
        deps.previewControl.setup(S)

        // 把共享作用域里的东西取到同名局部变量上 —— 下面从原组件搬来的代码因此一行都不用改。
        var open = S.open, setOpen = S.setOpen, batch = S.batch, actionUi = S.actionUi
        var menuKey = S.menuKey, view = S.view, archived = S.archived, snap = S.snap
        var openError = S.openError, sessionId = S.sessionId, setOpenError = S.setOpenError
        var pinnedRef = S.pinnedRef, rootRef = S.rootRef, menuKeyRef = S.menuKeyRef, setPinned = S.setPinned
        var menuRef = S.menuRef, menuTriggerRef = S.menuTriggerRef
        var cancelHover = S.cancelHover, scheduleOpen = S.scheduleOpen, scheduleClose = S.scheduleClose
        var closePreview = S.closePreview, clearArmTimer = S.clearArmTimer, setMenuKey = S.setMenuKey
        var patchActionUi = S.patchActionUi, closeCardMenu = S.closeCardMenu, exitBatch = S.exitBatch
        var readOnce = S.readOnce, readArchivedOnce = S.readArchivedOnce
        var toggleSelect = S.toggleSelect, onActionClick = S.onActionClick, toggleCardMenu = S.toggleCardMenu
        var onPinClick = S.onPinClick, toggleBatch = S.toggleBatch, onBatchAction = S.onBatchAction
        var schedulePreviewShow = S.schedulePreviewShow, schedulePreviewHide = S.schedulePreviewHide
        var openArchivedView = S.openArchivedView, backToTasks = S.backToTasks, openSeat = S.openSeat
        var stopHostEvent = deps.atoms.stopHostEvent, messageOf = deps.actions.messageOf
        var PANEL_PAD_X = deps.atoms.PANEL_PAD_X, PANEL_PAD_BOTTOM = deps.atoms.PANEL_PAD_BOTTOM
        var renderPanelHeader = deps.view.renderPanelHeader, renderTaskList = deps.view.renderTaskList
        var renderArchivedList = deps.view.renderArchivedList, diagText = S.diagText
        var renderBatchBar = deps.batchBar.renderBatchBar, batchActionsFor = deps.batchBar.batchActionsFor

      // ---- 打开时：立刻刷一次 + 点外部/ESC 关闭；收起时把预览/确认态/提示/批量/菜单一起撤掉 ----
      React.useEffect(function () {
        if (!open) {
          // 面板收起 = 预览层、"删单等二次确认"、上一行提示、批量选择、卡片菜单全部作废
          closePreview()
          clearArmTimer()
          setMenuKey('')
          if (actionUi.armedKey !== '' || actionUi.note !== null) patchActionUi({ armedKey: '', note: null })
          if (batch.on || batch.selected.length > 0) exitBatch()
          return undefined
        }
        readOnce(undefined) // 别让用户等满 5 秒
        readArchivedOnce(undefined) // 头部「归档 N」上的数量靠它（顺带预热归档视图）

        if (typeof document === 'undefined') return undefined
        var onPointerDown = function (ev) {
          var root = rootRef.current
          var target = ev === null || ev === undefined ? null : ev.target
          // ★ 判据不全就**不要关**：root 还没挂上 ref（首帧 / 宿主重挂 / ref 脱手）或事件
          //   没带 target 时，"点在里还是外"根本判不出来。以前这里把"判不出来"当成了
          //   "点在外面"，于是面板里随便一次 pointerdown（比如点「批量」）都可能把它收掉。
          //   宁可漏关一次，也不能误关正在用的面板。
          if (root === null || root === undefined || typeof root.contains !== 'function') return
          if (target === null || target === undefined) return
          if (root.contains(target)) {
            // 面板内部的点击不关面板；但点在卡片菜单 / 那颗「⋯」之外 ⇒ 收起菜单。
            // 菜单自己与触发器要放过，否则 pointerdown 先关、click 又开，等于点不动。
            if (menuKeyRef.current !== '') {
              var menu = menuRef.current
              var trigger = menuTriggerRef.current
              var inMenu = menu !== null && menu !== undefined && typeof menu.contains === 'function' && menu.contains(target)
              var onTrigger =
                trigger !== null && trigger !== undefined && typeof trigger.contains === 'function' && trigger.contains(target)
              if (!inMenu && !onTrigger) closeCardMenu()
            }
            return
          }
          setPinned(false)
          setOpen(false, 'outside')
        }
        var onKeyDown = function (ev) {
          if (ev.key !== 'Escape') return
          // ESC 先关卡片菜单（菜单开着时不该顺手把整个面板也收掉）
          if (menuKeyRef.current !== '') {
            closeCardMenu()
            return
          }
          setPinned(false)
          setOpen(false, 'esc')
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return function () {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])
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
            setOpen(next, next ? 'trigger-open' : 'trigger')
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
      //   每个分区都是本文件里一个独立函数（renderPanelHeader / renderTaskList /
      //   renderArchivedList / renderBatchBar），这里只负责按顺序把它们串起来。
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
      // ★ 临时诊断行（★ 取证用，定位后移除）：只回答"挂载几次 / 上次谁收起的 / 上次点了什么"。
      children.push(
        React.createElement('div', { key: 'diag', 'data-pipeline-diagnostic': 'true', style: { marginTop: '8px', fontSize: '10px', lineHeight: '1.4', color: '#8b949e', wordBreak: 'break-word' } }, diagText),
      )
      var popover = open
        ? React.createElement(
            'div',
            {
              // 外层只负责补上「按钮 ↔ 面板」之间那 6px 的缝：指针经过缝时仍在这个元素里，
              // 所以悬停横移不会被误判成"离开"（这是"没那么容易关"的另一半）。
              'data-pipeline-panel-frame': 'true',
              style: { position: 'absolute', top: '100%', right: 0, paddingTop: '6px', WebkitAppRegion: 'no-drag' },
            },
            React.createElement(
              'div',
              {
                role: 'dialog',
                'aria-label': '多AI协调团队',
                'data-pipeline-panel': 'open',
                'data-pipeline-panel-view': view === 'archived' ? 'archived' : 'tasks',
                'data-pipeline-panel-batch': batch.on ? 'on' : 'off',
                // 面板内部的指针事件一律截在这里（按钮自己的 onClick 先跑，再轮到这三个）：
                // 宿主的会话头部也有自己的 pointerdown / click 语义，冒上去就会被它收走。
                onPointerDown: stopHostEvent,
                onClick: stopHostEvent,
                onDoubleClick: stopHostEvent,
                style: {
                  zIndex: 2147483000,
                  width: 'min(440px, 92vw)',
                  maxHeight: 'min(70vh, 560px)',
                  overflowY: 'auto',
                  overscrollBehavior: 'contain',
                  boxSizing: 'border-box',
                  padding: '10px ' + PANEL_PAD_X + 'px ' + PANEL_PAD_BOTTOM + 'px',
                  background: 'var(--dsw-specific-menu, #ffffff)',
                  color: 'var(--dsw-alias-label-primary, #1f2328)',
                  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
                  borderRadius: '12px',
                  boxShadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,.28))',
                  font: 'inherit',
                  fontSize: '12px',
                  lineHeight: '1.45',
                  textAlign: 'left',
                  // 面板整体也落在头部拖拽区里，同样要显式退出拖拽
                  WebkitAppRegion: 'no-drag',
                },
              },
              children,
            ),
          )
        : null

        // 席位会话预览浮层（贴在面板左侧的大聊天窗）：内容与状态机都在 preview-control / preview-bubble 里
        var previewNode = S.renderPreview()
      return React.createElement(
        'div',
        {
          ref: rootRef,
          'data-pipeline-panel-root': 'true',
          onMouseEnter: cancelHover,
          onMouseLeave: scheduleClose,
          // 面板根节点是"边界"：里面的 pointerdown / click / dblclick 一律不再交给宿主。
          // 宿主的会话头部是窗口拖拽区，也在监听这些事件；不截住的话，点面板顶部那一行
          // 会冒到宿主（表现就是按钮不响应、面板反倒被关掉）。
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
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
