/* client.panel-controls.js —— 面板里的**可点小控件**：头部按钮（批量 / 归档 N / ← 返回任务）、批量模式那颗圆形勾、置顶的 📌 标记，以及「批量栏负边距要抵掉」的那对内边距常量；全都自带 no-drag 与宿主事件截断。 */
;(function () {
  'use strict'

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    // 控件都落在会话头部那块 Electron 拖拽区里：事件截断与 no-drag 在这里一次做对。
    var stopHostEvent = deps.atoms.stopHostEvent

    /**
     * 面板内边距（px）。**批量栏的负边距靠这两个数把它抵掉**，所以面板本体与
     * `renderBatchBar` 必须用同一对常量 —— 否则那条底栏会缩在 padding 里，看着不像通栏。
     */
    var PANEL_PAD_X = 12
    var PANEL_PAD_BOTTOM = 12

    /**
     * 头部小按钮（「批量」「归档 N」「← 返回任务」共用一套长相）。
     * ★ 按钮**自己**截住宿主事件（pointerdown / click / dblclick），不全押在外层那一行上：
     *   行级 stop 一旦漏挂（chunk 重组 / 外层换节点），这次点击就会冒到宿主 —— 用户看到的
     *   是"按钮不响，面板反倒被关掉"。`onClick` 只转发、**不吞**：回调没接上就该当场炸。
     */
    function renderHeaderButton(React, spec) {
      var active = spec.active === true
      var props = {
        key: spec.key,
        type: 'button',
        title: spec.title,
        onPointerDown: stopHostEvent,
        onDoubleClick: stopHostEvent,
        onClick: function (ev) {
          stopHostEvent(ev)
          spec.onClick(ev)
        },
        style: {
          flex: '0 0 auto',
          height: '22px',
          padding: '0 8px',
          font: 'inherit',
          fontSize: '11px',
          lineHeight: '1',
          color: active ? 'var(--dsw-alias-brand-primary, #1f6feb)' : 'var(--dsw-alias-label-primary, inherit)',
          // 和任务卡一样给个深色小底面：透明底的按钮在会话头部里既不好认、也不像"能点的东西"。
          background: active ? 'rgba(47,129,247,.20)' : 'rgba(127,127,127,.16)',
          border: '1px solid ' + (active ? 'rgba(47,129,247,.55)' : 'rgba(139,148,158,.45)'),
          borderRadius: '8px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          userSelect: 'none',
          WebkitAppRegion: 'no-drag',
        },
      }
      var hooks = spec.hooks
      if (hooks !== null && hooks !== undefined) {
        for (var k in hooks) {
          if (Object.prototype.hasOwnProperty.call(hooks, k)) props[k] = hooks[k]
        }
      }
      return React.createElement('button', props, spec.label)
    }

    /**
     * 批量模式下的**圆形勾选框**（16px）。
     * 纯装饰：真正的点击落在整张卡上（`data-pipeline-batch-check` 只给自动化核对用），
     * 所以它自己**不带 onClick** —— 带了就会和卡的点击一起触发，等于点一下切两次。
     */
    function renderBatchCheckbox(React, checked) {
      return React.createElement(
        'span',
        {
          key: 'check',
          'aria-hidden': 'true',
          'data-pipeline-batch-check': checked ? 'checked' : 'empty',
          style: {
            flex: '0 0 auto',
            width: '16px',
            height: '16px',
            boxSizing: 'border-box',
            borderRadius: '50%',
            border: '1px solid ' + (checked ? '#2f81f7' : 'rgba(127,127,127,.6)'),
            background: checked ? '#2f81f7' : 'transparent',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#ffffff',
            fontSize: '10px',
            lineHeight: '1',
            userSelect: 'none',
          },
        },
        checked ? '✓' : '',
      )
    }

    /** 置顶标记 📌（宿主已经排好序，这里只是让"它被钉住了"看得出来）。 */
    function renderPinMark(React, task) {
      if (task === null || typeof task !== 'object' || task.pinned !== true) return null
      return React.createElement(
        'span',
        {
          key: 'pinMark',
          title: '已置顶（宿主会把置顶的任务排在最前面）',
          'aria-label': '已置顶',
          'data-pipeline-pinned': 'true',
          style: { flex: '0 0 auto', fontSize: '11px', lineHeight: '15px', userSelect: 'none' },
        },
        '📌',
      )
    }

    return {
      renderHeaderButton: renderHeaderButton,
      renderBatchCheckbox: renderBatchCheckbox,
      renderPinMark: renderPinMark,
      PANEL_PAD_X: PANEL_PAD_X,
      PANEL_PAD_BOTTOM: PANEL_PAD_BOTTOM,
    }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-controls.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
