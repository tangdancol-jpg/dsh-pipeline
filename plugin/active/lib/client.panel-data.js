/* client.panel-data.js —— 面板的数据与状态：5s 轮询任务/归档快照、失败时保留上次数据、卡片菜单与悬停开合、以及「打开某个席位的对话」那条路。另含跨重挂载存活的诊断寄存器（★ 取证用，定位后移除）。 */
;(function () {
  'use strict'

  // ---- 诊断寄存器（★ 取证用，定位后移除）----
  // 放 module 作用域：组件重挂载会重新初始化 useState，只有这里跨重挂载活下来。
  var DIAG = { mounts: 0, lastReason: '', lastAt: 0, lastAction: '' }
  /** 跨重挂载持久化的开合 / 钉住状态。 */
  var OPEN = { open: false, pinned: false }
  /** 模块级实例计数：只数"组件包装器首次执行"，同一实例的后续渲染不算。 */
  var INSTANCE = { count: 0 }

  /** 记一次头部动作（取证用）：'batch' | 'archive' | 'back'。 */
  function noteAction(action) {
    DIAG.lastAction = action
    DIAG.lastAt = Date.now()
  }
  /** 组件包装函数首次执行（= 这个面板实例开始初始化 useState）时调一次；StrictMode 双调不会重复记。 */
  function beginMount() {
    INSTANCE.count += 1
    DIAG.mounts += 1
    // 重挂载时上一实例把面板留着（OPEN.open === true）⇒ 这次恢复显示，并留下原因。
    if (OPEN.open === true) {
      DIAG.lastReason = 'remount'
      DIAG.lastAt = Date.now()
    }
  }

  /** open 的统一出口：React state 与模块级 OPEN 一起写；收起时留原因与时间。 */
  function applyOpenState(v, reason) {
    var next = v === true
    OPEN.open = next
    if (!next) {
      DIAG.lastReason = reason || 'unknown'
      DIAG.lastAt = Date.now()
    }
    return next
  }

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    var fetchPanel = deps.actions.fetchPanel
    var fetchArchived = deps.actions.fetchArchived
    var messageOf = deps.actions.messageOf
    var rowKeyOf = deps.actions.rowKeyOf
    var resolveUiWorkspace = deps.preview.resolveUiWorkspace

    /** 面板轮询周期。席位状态变得比开关勤，所以比开关的 8s 快。 */
    var PANEL_POLL_MS = 5000

    /**
     * 从槽 props 里取**当前会话 id**（官方面板 `TeamAction({ sessionId })` 就是直接吃槽 props）。
     * 三档兜底：`props.sessionId` → `props.session.id` → `props.context.sessionId`；都没有就 null。
     */
    function currentSessionIdOf(props) {
      if (props === null || props === undefined) return null
      if (typeof props.sessionId === 'string' && props.sessionId !== '') return props.sessionId
      if (
        props.session !== null &&
        typeof props.session === 'object' &&
        typeof props.session.id === 'string' &&
        props.session.id !== ''
      ) {
        return props.session.id
      }
      if (
        props.context !== null &&
        typeof props.context === 'object' &&
        typeof props.context.sessionId === 'string' &&
        props.context.sessionId !== ''
      ) {
        return props.context.sessionId
      }
      return null
    }

    /**
     * 面板的**数据与状态**：轮询快照/归档、批量与动作的状态槽、卡片菜单、悬停开合，
     * 再加上「打开某个席位的对话」这条路。
     *
     * 所有状态与回调都挂到共享作用域 S 上 —— 拆分前它们本来就在同一个闭包里，
     * 挂上去之后各 chunk 看到的仍是同一份、同一轮渲染的值。
     *
     * @param {object} S 面板的共享作用域
     */
    function setup(S) {
      var React = S.React
      var ctx = S.ctx
      var props = S.props

      var snapHook = React.useState(null) // { tasks: [...] | null, error: string, generatedAt: string }
      var snap = snapHook[0]
      var setSnap = snapHook[1]

      // 用模块级 OPEN.open 初始化：若上一实例把面板留着，重挂载后会立刻恢复显示。
      var openHook = React.useState(OPEN.open)
      var open = openHook[0]
      var rawSetOpen = openHook[1]
      /** 所有 open 变更的**唯一出口**：同步模块级 OPEN，收起时记原因（取证用）。 */
      var setOpen = function (v, reason) {
        rawSetOpen(applyOpenState(v, reason))
      }

      var openErrHook = React.useState('')
      var openError = openErrHook[0]
      var setOpenError = openErrHook[1]

      // ---- 视图与归档列表（分区：归档视图）----
      //   view     'tasks'（主视图）| 'archived'（归档视图）
      //   archived { tasks: [...] | null, error: string } —— **另一份数据**，与主快照互不影响
      var viewHook = React.useState('tasks')
      var view = viewHook[0]
      var setView = viewHook[1]

      var archHook = React.useState(null)
      var archived = archHook[0]
      var setArchived = archHook[1]

      // ---- 批量模式（分区：批量管理）----
      //   on       是否在批量模式
      //   selected 选中的键：主视图 = 任务 id；归档视图 = **归档目录名 dir**
      //   busy/done/total  串行执行进度（批量栏显示「处理中 i/N」）
      //   armed    删除类批量动作是否已经"上膛"（两击确认）
      var batchHook = React.useState({ on: false, selected: [], busy: false, done: 0, total: 0, armed: '' })
      var batch = batchHook[0]
      var setBatch = batchHook[1]

      var aliveRef = React.useRef(true)
      var pinnedRef = React.useRef(OPEN.pinned) // 点击钉住后面板不因移开而收起（跨重挂载持久化到 OPEN.pinned）
      /** 钉住状态同样跨重挂载：ref 给定时器/回调读，OPEN.pinned 给下一个实例读。 */
      var setPinned = function (v) {
        pinnedRef.current = v === true
        OPEN.pinned = pinnedRef.current
      }
      var hoverTimerRef = React.useRef(null)
      var rootRef = React.useRef(null)

      // ---- 任务卡操作按钮的状态（四张卡共用一格：键是 `taskId + action`）----
      //   busyKey  正在等回话的那个按钮（一次只让一个动作在飞，免得绿色提示互相覆盖）
      //   armedKey 「删单」已经点过一次、正等第二次确认的按钮
      //   note     面板顶部那一行结果提示（成功绿 / 失败红）
      var actionHook = React.useState({ busyKey: '', armedKey: '', note: null })
      var actionUi = actionHook[0]
      var setActionUi = actionHook[1]
      var armTimerRef = React.useRef(null)

      // ---- 卡片「⋯」菜单（分区：卡片操作菜单）----
      //   menuKey 当前打开的菜单键（'' = 全关）；menuKeyRef 给 document 级处理器读最新值；
      //   menuRef / menuTriggerRef 判断点击是否落在菜单 / 「⋯」自己身上
      var menuHook = React.useState('')
      var menuKey = menuHook[0]
      var setMenuKey = menuHook[1]
      var menuKeyRef = React.useRef('')
      var menuRef = React.useRef(null)
      var menuTriggerRef = React.useRef(null)

      // 菜单开关同步到 ref：document 上的关闭处理器不跟着每次 render 重注册，只能靠它拿最新值。
      React.useEffect(function () {
        menuKeyRef.current = menuKey
      }, [menuKey])

      // ---- 席位会话预览：状态只给渲染用；"开没开 / key / 缓存 / 在途序号"都放 ref（旧闭包要读最新值）----
      var previewHook = React.useState(null)
      var preview = previewHook[0]
      var setPreview = previewHook[1]
      var previewRef = React.useRef({ open: false, key: '', seq: 0 })
      var previewTimerRef = React.useRef(null)
      // 缓存用无原型对象：会话 id 是外部字符串，不该有机会命中 Object.prototype 上的键
      var previewCacheRef = React.useRef({ rows: Object.create(null), retained: [] })
      var previewBoxRef = React.useRef(null)

      var sessionId = currentSessionIdOf(props)
      /** 拉一次。失败**保留上次数据**（tasks 不动），只更新错误文案。 */
      var readOnce = function (signal) {
        fetchPanel(signal)
          .then(function (body) {
            if (!aliveRef.current) return
            if (body.ok === true) {
              setSnap({ tasks: body.tasks, error: '', generatedAt: body.generatedAt })
              return
            }
            setSnap(function (prev) {
              return {
                tasks: prev === null ? null : prev.tasks,
                error: body.error || '读取失败',
                generatedAt: prev === null ? '' : prev.generatedAt,
              }
            })
          })
          .catch(function (err) {
            if (!aliveRef.current) return
            if (err && err.name === 'AbortError') return
            setSnap(function (prev) {
              return {
                tasks: prev === null ? null : prev.tasks,
                error: messageOf(err),
                generatedAt: prev === null ? '' : prev.generatedAt,
              }
            })
          })
      }
      /** 拉一次归档列表（与 `readOnce` 同一套规矩：失败保留上次数据 + 只更新错误文案）。 */
      var readArchivedOnce = function (signal) {
        fetchArchived(signal)
          .then(function (body) {
            if (!aliveRef.current) return
            if (body.ok === true) {
              setArchived({ tasks: body.tasks, error: '' })
              return
            }
            setArchived(function (prev) {
              return { tasks: prev === null ? null : prev.tasks, error: body.error || '读取失败' }
            })
          })
          .catch(function (err) {
            if (!aliveRef.current) return
            if (err && err.name === 'AbortError') return
            setArchived(function (prev) {
              return { tasks: prev === null ? null : prev.tasks, error: messageOf(err) }
            })
          })
      }
      /**
       * 写成功之后**立刻**把这几张卡从界面上撤掉 —— 归档 / 删单这类"点完就该消失"的动作
       * 不能留着旧卡让人以为没生效。两份列表都按各自的键清一遍（两边的键不会撞车）。
       */
      var dropRows = function (ids) {
        if (!Array.isArray(ids) || ids.length === 0) return
        var keep = function (list, viewName) {
          if (!Array.isArray(list)) return list
          return list.filter(function (row) {
            return ids.indexOf(rowKeyOf(row, viewName)) === -1
          })
        }
        setSnap(function (prev) {
          if (prev === null) return prev
          return { tasks: keep(prev.tasks, 'tasks'), error: prev.error, generatedAt: prev.generatedAt }
        })
        setArchived(function (prev) {
          if (prev === null) return prev
          return { tasks: keep(prev.tasks, 'archived'), error: prev.error }
        })
      }
      /** 归档相关动作会同时改动两份数据（任务列表 + 归档列表），两边都刷一次。 */
      var refreshAfterWrite = function () {
        readOnce(undefined)
        readArchivedOnce(undefined)
      }
      /** 当前视图的列表（批量操作的选中判定只看这一份）。 */
      var currentRows = function () {
        if (view === 'archived') return archived !== null && Array.isArray(archived.tasks) ? archived.tasks : []
        return snap !== null && Array.isArray(snap.tasks) ? snap.tasks : []
      }
      // ---- 轮询：5s 一轮；页面在后台时跳过这一轮 ----
      React.useEffect(function () {
        aliveRef.current = true
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        var signal = controller === null ? undefined : controller.signal
        readOnce(signal)
        var timer = setInterval(function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          readOnce(signal)
        }, PANEL_POLL_MS)
        return function () {
          aliveRef.current = false
          clearInterval(timer)
          if (controller !== null) controller.abort()
        }
        // 只挂一次：轮询句柄与 abort 都在闭包里
      }, [])
      // ---- 悬停（参考官方）：移上去就开，移开**慢一点**才关；点过（钉住）就永不自动关 ----
      var cancelHover = function () {
        if (hoverTimerRef.current !== null) {
          clearTimeout(hoverTimerRef.current)
          hoverTimerRef.current = null
        }
      }

      var scheduleOpen = function () {
        cancelHover()
        if (open) return
        hoverTimerRef.current = setTimeout(function () {
          hoverTimerRef.current = null
          setOpen(true, 'hover-open')
        }, 140)
      }

      var scheduleClose = function () {
        cancelHover()
        if (!open || pinnedRef.current) return
        // ★ 预览层开着时先不关面板：指针从 chip 移到 `position:fixed` 的预览层可能经过面板外的间隙。
        //   预览收掉之后 `schedulePreviewHide` 会把这条"慢关"接回去。
        if (previewRef.current.open) return
        // ★ 800ms 才关：从按钮移到面板要经过一小段间隙；官方也是"慢关"，太快就像"碰一下就关"。
        hoverTimerRef.current = setTimeout(function () {
          hoverTimerRef.current = null
          setOpen(false, 'hover')
        }, 800)
      }

      // ---- 打开某个席位的对话（点 chip 名字那条路） ----

      /**
       * 打开某个席位的对话。
       * `kind === 'team'` ⇒ 以**当前会话**为父、席位会话为子（continuable）；
       * 其余一律按普通会话打开。服务缺失/抛错/异步拒绝都变成面板里的一句人话。
       */
      var openSeat = function (seat) {
        var target = typeof seat.session_id === 'string' ? seat.session_id : ''
        if (target === '') {
          setOpenError('打不开会话：这个席位还没有会话 id')
          return
        }
        var workspace = resolveUiWorkspace(ctx)
        if (workspace === null) {
          setOpenError('打不开会话：客户端没有提供 uiWorkspace 服务')
          return
        }
        var out = null
        try {
          if (seat.kind === 'team' && sessionId !== null) {
            out = workspace.openSession({ parentSessionId: sessionId, childSessionId: target, mode: 'continuable' })
          } else {
            out = workspace.openSession(target)
          }
        } catch (err) {
          setOpenError('打不开会话：' + messageOf(err))
          return
        }
        setOpenError('')
        if (out !== null && out !== undefined && typeof out.then === 'function') {
          out.then(
            function () {},
            function (err) {
              if (aliveRef.current) setOpenError('打不开会话：' + messageOf(err))
            },
          )
        }
      }

      S.props = props
      S.snap = snap
      S.setSnap = setSnap
      S.open = open
      S.setOpen = setOpen
      S.setPinned = setPinned
      S.noteAction = noteAction
      // ★ 临时诊断行（取证用，定位后移除）。
      S.diagText = '调试 · 挂载 ' + DIAG.mounts + ' 次 · 上次收起：' + (DIAG.lastReason || '—') + ' · 上次动作：' + (DIAG.lastAction || '—')
      S.openError = openError
      S.setOpenError = setOpenError
      S.view = view
      S.setView = setView
      S.archived = archived
      S.setArchived = setArchived
      S.batch = batch
      S.setBatch = setBatch
      S.actionUi = actionUi
      S.setActionUi = setActionUi
      S.menuKey = menuKey
      S.setMenuKey = setMenuKey
      S.preview = preview
      S.setPreview = setPreview
      S.sessionId = sessionId
      S.aliveRef = aliveRef
      S.pinnedRef = pinnedRef
      S.hoverTimerRef = hoverTimerRef
      S.rootRef = rootRef
      S.armTimerRef = armTimerRef
      S.menuKeyRef = menuKeyRef
      S.menuRef = menuRef
      S.menuTriggerRef = menuTriggerRef
      S.previewRef = previewRef
      S.previewTimerRef = previewTimerRef
      S.previewCacheRef = previewCacheRef
      S.previewBoxRef = previewBoxRef
      S.readOnce = readOnce
      S.readArchivedOnce = readArchivedOnce
      S.dropRows = dropRows
      S.refreshAfterWrite = refreshAfterWrite
      S.currentRows = currentRows
      S.cancelHover = cancelHover
      S.scheduleOpen = scheduleOpen
      S.scheduleClose = scheduleClose
      S.openSeat = openSeat
    }

    return { setup: setup, beginMount: beginMount }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-data.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
