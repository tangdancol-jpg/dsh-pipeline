/* client.panel-interact.js —— 面板的**交互状态 glue**：开合 / 钉住与悬停慢关、卡片菜单（一次只开一个）、动作 UI 那一格（busy / 两击确认 / 顶部提示）、批量与预览的状态槽，以及「打开某个席位的对话」这条路（含当前会话 id 的三档兜底）。 */
;(function () {
  'use strict'

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

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    var resolveUiWorkspace = deps.preview.resolveUiWorkspace
    var messageOf = deps.actions.messageOf

    /**
     * 面板的**交互状态**：开合与钉住、卡片菜单、动作 UI、批量与预览的状态槽，
     * 再加上「打开某个席位的对话」这条路。
     *
     * @param {object} S 面板的共享作用域
     */
    function setup(S) {
      var React = S.React
      var ctx = S.ctx
      var props = S.props
      var aliveRef = S.aliveRef // 由 poll chunk 的 setup 建好（它在前面）

      var openHook = React.useState(false)
      var open = openHook[0]
      var setOpen = openHook[1]

      var openErrHook = React.useState('')
      var openError = openErrHook[0]
      var setOpenError = openErrHook[1]

      // ---- 批量模式（分区：批量管理）----
      //   on       是否在批量模式
      //   selected 选中的键：主视图 = 任务 id；归档视图 = **归档目录名 dir**
      //   busy/done/total  串行执行进度（批量栏显示「处理中 i/N」）
      //   armed    删除类批量动作是否已经"上膛"（两击确认）
      var batchHook = React.useState({ on: false, selected: [], busy: false, done: 0, total: 0, armed: '' })
      var batch = batchHook[0]
      var setBatch = batchHook[1]

      var pinnedRef = React.useRef(false) // 点击钉住后面板不因移开而收起
      /** 钉住状态：ref 给定时器 / 回调读最新值。 */
      var setPinned = function (v) {
        pinnedRef.current = v === true
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
          setOpen(true)
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
          setOpen(false)
        }, 800)
      }

      // ---- 打开某个席位的对话（点 chip 名字那条路）----

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
      S.open = open
      S.setOpen = setOpen
      S.setPinned = setPinned
      S.openError = openError
      S.setOpenError = setOpenError
      S.batch = batch
      S.setBatch = setBatch
      S.actionUi = actionUi
      S.setActionUi = setActionUi
      S.menuKey = menuKey
      S.setMenuKey = setMenuKey
      S.preview = preview
      S.setPreview = setPreview
      S.sessionId = sessionId
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
      S.cancelHover = cancelHover
      S.scheduleOpen = scheduleOpen
      S.scheduleClose = scheduleClose
      S.openSeat = openSeat
    }

    return { setup: setup }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-interact.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
