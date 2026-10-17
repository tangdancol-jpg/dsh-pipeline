/* client.panel-menu.js —— 卡片右上角那颗「⋯」：触发器、菜单项（含两击确认的文案）、卡片内下拉菜单，以及置顶那颗钉子；外加「这张卡 → 该有哪几个动作」的两个构建器。 */
;(function () {
  'use strict'

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    // 依赖：atoms（停止冒泡）+ actions（动作表 / 文案 / 键）。
    var stopHostEvent = deps.atoms.stopHostEvent
    var PANEL_ACTION_ORDER = deps.actions.PANEL_ACTION_ORDER
    var PANEL_ACTION_META = deps.actions.PANEL_ACTION_META
    var ARCHIVED_ACTION_ORDER = deps.actions.ARCHIVED_ACTION_ORDER
    var ARCHIVED_ACTION_META = deps.actions.ARCHIVED_ACTION_META
    var PIN_ACTION_META = deps.actions.PIN_ACTION_META
    var DELETE_CONFIRM_LABEL = deps.actions.DELETE_CONFIRM_LABEL
    var DELETE_ARMED_TIP = deps.actions.DELETE_ARMED_TIP
    var DELETE_ARCHIVED_CONFIRM_LABEL = deps.actions.DELETE_ARCHIVED_CONFIRM_LABEL
    var DELETE_ARCHIVED_ARMED_TIP = deps.actions.DELETE_ARCHIVED_ARMED_TIP
    var actionKeyOf = deps.actions.actionKeyOf

    /**
     * 卡片右上角那颗「⋯」（22px 圆形小按钮）。
     *
     * data 钩子（自动化核对用）：
     *   · `data-pipeline-card-menu-trigger` = `open` / `closed`
     *   · `data-pipeline-card-menu-for`     = 这张卡的键（任务 id / 归档目录名）
     */
    function renderCardMenuTrigger(React, spec) {
      if (typeof spec.onToggle !== 'function') return null
      var open = spec.open === true
      return React.createElement(
        'button',
        {
          ref: spec.ref,
          type: 'button',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-label': '这张任务单的更多操作',
          title:
            typeof spec.title === 'string' && spec.title !== ''
              ? spec.title
              : '更多操作（终止 / 恢复 / 归档 / 删单）',
          'data-pipeline-card-menu-trigger': open ? 'open' : 'closed',
          'data-pipeline-card-menu-for': spec.cardKey,
          onClick: function (ev) {
            // 先把这次点击留在面板里，再开合菜单（宿主的头部处理器不该看见它）
            stopHostEvent(ev)
            spec.onToggle(spec.cardKey)
          },
          onPointerDown: stopHostEvent,
          onDoubleClick: stopHostEvent,
          style: {
            flex: '0 0 auto',
            width: '22px',
            height: '22px',
            padding: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            font: 'inherit',
            fontSize: '14px',
            lineHeight: '1',
            color: 'inherit',
            background: open ? 'rgba(127,127,127,.16)' : 'transparent',
            border:
              '1px solid ' + (open ? 'rgba(127,127,127,.55)' : 'var(--dsw-alias-border-l2, rgba(127,127,127,.35))'),
            borderRadius: '50%',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            // 卡片落在会话头部的窗口拖拽区里：显式退出拖拽，否则点击被当成拖窗口
            WebkitAppRegion: 'no-drag',
          },
        },
        '⋯',
      )
    }
    /**
     * 菜单里的一行（任务卡与归档卡共用）。
     *
     * data 钩子：
     *   · `data-pipeline-card-menu-item`       = 动作 id（cancel / restore / archive / delete / …）
     *   · `data-pipeline-card-menu-item-state` = `idle` / `armed`（等第二击）/ `busy`（等宿主回话）
     */
    function renderCardMenuItem(React, spec) {
      var busy = spec.busy === true
      var armed = spec.armed === true
      var danger = spec.danger === true
      var disabled = busy || spec.disabled === true
      return React.createElement(
        'button',
        {
          key: spec.action,
          type: 'button',
          role: 'menuitem',
          disabled: disabled,
          'aria-busy': busy,
          'data-pipeline-card-menu-item': spec.action,
          'data-pipeline-card-menu-item-state': busy ? 'busy' : armed ? 'armed' : 'idle',
          title: busy ? '正在等宿主回话…' : armed ? spec.armedTip : spec.tip,
          onClick: function (ev) {
            stopHostEvent(ev)
            if (disabled) return
            if (typeof spec.onClick === 'function') spec.onClick()
          },
          onPointerDown: stopHostEvent,
          onDoubleClick: stopHostEvent,
          // 内联样式做不到 :hover，只能在这两个事件里改底色（armed / busy 时不改）
          onMouseEnter: function (ev) {
            if (armed || busy) return
            if (ev !== null && ev !== undefined && ev.currentTarget !== null && ev.currentTarget !== undefined) {
              ev.currentTarget.style.background = 'rgba(127,127,127,.14)'
            }
          },
          onMouseLeave: function (ev) {
            if (ev !== null && ev !== undefined && ev.currentTarget !== null && ev.currentTarget !== undefined) {
              ev.currentTarget.style.background = armed ? '#d9534f' : 'transparent'
            }
          },
          style: {
            display: 'block',
            width: '100%',
            boxSizing: 'border-box',
            padding: '6px 10px',
            font: 'inherit',
            fontSize: '11.5px',
            lineHeight: '1.5',
            textAlign: 'left',
            color: armed ? '#ffffff' : danger ? '#d9534f' : 'inherit',
            background: armed ? '#d9534f' : 'transparent',
            border: 0,
            borderRadius: '6px',
            cursor: disabled ? 'progress' : 'pointer',
            opacity: busy ? 0.6 : 1,
            whiteSpace: 'nowrap',
            userSelect: 'none',
            WebkitAppRegion: 'no-drag',
          },
        },
        busy ? '处理中…' : armed ? spec.armedLabel : spec.label,
      )
    }
    /**
     * 卡片内的下拉菜单：绝对定位在卡片右上（「⋯」下面），zIndex 高于卡片。
     *
     * data 钩子：
     *   · `data-pipeline-card-menu` = 这张卡的键（任务 id / 归档目录名）
     */
    function renderCardMenu(React, spec) {
      var items = Array.isArray(spec.items) ? spec.items : []
      if (items.length === 0) return null
      return React.createElement(
        'div',
        {
          ref: spec.ref,
          role: 'menu',
          'data-pipeline-card-menu': spec.cardKey,
          // 绝对定位：相对卡片（卡片自己 position:relative），落在标题行下面、与「⋯」右对齐
          style: {
            position: 'absolute',
            top: '30px',
            right: '6px',
            zIndex: 40,
            minWidth: '132px',
            padding: '4px',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: '1px',
            background: 'var(--dsw-specific-menu, #ffffff)',
            color: 'var(--dsw-alias-label-primary, #1f2328)',
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
            borderRadius: '8px',
            boxShadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,.28))',
            // 菜单也落在会话头部的拖拽区里，同样要显式退出拖拽
            WebkitAppRegion: 'no-drag',
          },
          // 菜单里的点击更不能冒出去（点菜单 = 只执行菜单里那件事）
          onPointerDown: stopHostEvent,
          onClick: stopHostEvent,
          onDoubleClick: stopHostEvent,
        },
        items.map(function (item) {
          return renderCardMenuItem(React, item)
        }),
      )
    }
    /**
     * 任务卡的菜单项（顺序 = `PANEL_ACTION_ORDER`；只保留 `allowed_actions` 里的）。
     *
     *   · 字段缺失 / 不是数组 / 空数组 ⇒ 空数组（卡上连「⋯」都不画，老版本宿主没有这个字段）；
     *   · 认不出的动作 ⇒ 跳过（宁可少一项，也不给一个点了没反应的）；
     *   · 批量模式下返回空数组（整张卡让位给"选中"）。
     */
    function buildTaskMenuItems(task, opts) {
      if (opts.batch === true) return []
      var taskId = typeof task.id === 'string' ? task.id : ''
      if (taskId === '') return []
      var allowed = Array.isArray(task.allowed_actions) ? task.allowed_actions : []
      if (allowed.length === 0) return []
      var onAction = typeof opts.onAction === 'function' ? opts.onAction : null
      if (onAction === null) return []
      var items = []
      for (var i = 0; i < PANEL_ACTION_ORDER.length; i++) {
        var action = PANEL_ACTION_ORDER[i]
        if (allowed.indexOf(action) === -1) continue
        var meta = PANEL_ACTION_META[action]
        var key = actionKeyOf(taskId, action)
        items.push({
          action: action,
          label: meta.label,
          tip: meta.tip,
          armedLabel: DELETE_CONFIRM_LABEL,
          armedTip: DELETE_ARMED_TIP,
          danger: action === 'delete',
          busy: opts.busyKey === key,
          armed: opts.armedKey === key,
          // 一次只让一个动作在飞：别的项在执行期间也置灰（点了也只是被 onActionClick 忽略）
          disabled: opts.actionBusy === true,
          // 参数化再返回闭包（别让循环变量 `action` 被闭包按引用捕走）
          onClick: (function (id) {
            return function () {
              onAction(taskId, id)
            }
          })(action),
        })
      }
      return items
    }
    /**
     * 归档卡的菜单项（恢复 / 永久删除）。
     * 不看 `allowed_actions`：进了归档区就只剩终态单，两个动作都允许（与宿主契约一致）。
     * `dir` 是归档目录名 —— 归档动作的 `task_id` 就是它。
     */
    function buildArchivedMenuItems(dir, opts) {
      if (opts.batch === true) return []
      if (typeof dir !== 'string' || dir === '') return []
      var onAction = typeof opts.onAction === 'function' ? opts.onAction : null
      if (onAction === null) return []
      var items = []
      for (var i = 0; i < ARCHIVED_ACTION_ORDER.length; i++) {
        var action = ARCHIVED_ACTION_ORDER[i]
        var meta = ARCHIVED_ACTION_META[action]
        var key = actionKeyOf(dir, action)
        items.push({
          action: action,
          label: meta.label,
          tip: meta.tip,
          armedLabel: DELETE_ARCHIVED_CONFIRM_LABEL,
          armedTip: DELETE_ARCHIVED_ARMED_TIP,
          danger: action === 'delete_archived',
          busy: opts.busyKey === key,
          armed: opts.armedKey === key,
          disabled: opts.actionBusy === true,
          onClick: (function (a) {
            return function () {
              onAction(dir, a)
            }
          })(action),
        })
      }
      return items
    }
    /**
     * 标题行**左侧**那颗**钉子**（紧挨任务 id）：点一下钉住 / 再点取消。
     * `task.pinned` 是宿主给的字段（缺失 / 非 true 一律当没置顶 —— 老版本宿主没有它）。
     * 批量模式下不渲染：那时点整卡是选中，钉子和勾选框会抢同一个点击。
     */
    function renderPinButton(React, task, opts) {
      if (opts.batch === true) return null
      var taskId = typeof task.id === 'string' ? task.id : ''
      if (taskId === '') return null
      var onPin = typeof opts.onPin === 'function' ? opts.onPin : null
      if (onPin === null) return null
      var pinned = task.pinned === true
      var action = pinned ? 'unpin' : 'pin'
      var meta = PIN_ACTION_META[action]
      var busy = opts.busyKey === actionKeyOf(taskId, action)
      return React.createElement(
        'button',
        {
          type: 'button',
          disabled: busy,
          'aria-pressed': pinned,
          'aria-label': pinned ? '取消置顶这张任务单' : '置顶这张任务单',
          'data-pipeline-pin': pinned ? 'pinned' : 'unpinned',
          title: busy ? '正在等宿主回话…' : meta.tip,
          onClick: function (ev) {
            // 卡片上的点击不冒给宿主（也挡住批量模式下的"整卡选中"）
            stopHostEvent(ev)
            onPin(taskId, pinned)
          },
          onPointerDown: stopHostEvent,
          onDoubleClick: stopHostEvent,
          style: {
            flex: '0 0 auto',
            height: '20px',
            padding: '0 7px',
            font: 'inherit',
            fontSize: '10.5px',
            lineHeight: '1',
            color: pinned ? 'var(--dsw-alias-brand-primary, #1f6feb)' : 'inherit',
            background: pinned ? 'rgba(47,129,247,.14)' : 'transparent',
            border: '1px solid ' + (pinned ? 'rgba(47,129,247,.55)' : 'var(--dsw-alias-border-l2, rgba(127,127,127,.35))'),
            borderRadius: '999px',
            cursor: busy ? 'progress' : 'pointer',
            opacity: busy ? 0.6 : 1,
            whiteSpace: 'nowrap',
            userSelect: 'none',
            WebkitAppRegion: 'no-drag',
          },
        },
        busy ? '…' : pinned ? '取消置顶' : '置顶',
      )
    }

    return {
      renderCardMenuTrigger: renderCardMenuTrigger,
      renderCardMenuItem: renderCardMenuItem,
      renderCardMenu: renderCardMenu,
      buildTaskMenuItems: buildTaskMenuItems,
      buildArchivedMenuItems: buildArchivedMenuItems,
      renderPinButton: renderPinButton,
    }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-menu.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
