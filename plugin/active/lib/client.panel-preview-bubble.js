/* client.panel-preview-bubble.js —— 预览浮层的长相：定高圆角窗、标题行、可滚动的 12 条气泡（用户靠右 / AI 靠左、空正文显示「正在思考…」）、底部「点击气泡打开会话」。 */
;(function () {
  'use strict'

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    var PREVIEW_THINKING_TEXT = deps.preview.PREVIEW_THINKING_TEXT

    /**
     * 预览浮层（贴在面板**左侧**的大聊天窗）：`position:fixed` + 按面板根节点的 rect 推落点，
     * zIndex 比面板更高。挂在面板根节点里（DOM 上是子节点）有三个好处：面板一收起它就跟着消失、
     * 从 chip 横移过来不会被判成「离开面板」、点它不会被「点外部关闭」误伤。
     *
     * @param {object} S 面板的共享作用域（open / preview / previewBoxRef 在里面）
     * @param {object} h 状态机给的三件回调：keepPreview / schedulePreviewHide / openSessionFromPreview
     */
    function renderPreview(S, h) {
      var React = S.React
      var open = S.open
      var preview = S.preview
      var previewBoxRef = S.previewBoxRef
      var keepPreview = h.keepPreview
      var schedulePreviewHide = h.schedulePreviewHide
      var openSessionFromPreview = h.openSessionFromPreview

      // ---- 席位会话预览浮层：贴在面板**左侧**的大聊天窗 ----
      //   `position:fixed` + 按**面板根节点**的 `getBoundingClientRect()` 推面板左边缘落点
      //   （`previewBoxFor` 收边），zIndex 比面板更高。挂在面板根节点里（DOM 上是子节点）有三个好处：
      //   ① 面板一收起它就跟着消失，不会留下孤儿浮层；
      //   ② 从 chip 横移到左侧预览窗时不会被判成"离开面板"；
      //   ③ 点它不会被面板的"点外部关闭"误伤。
      var previewNode = null
      if (open && preview !== null) {
        var boxStyle = {
          position: 'fixed',
          left: preview.box.left + 'px',
          top: preview.box.top + 'px',
          width: preview.box.width + 'px',
          height: preview.box.height + 'px',
          // 面板是 2147483000，预览要在它上面
          zIndex: 2147483600,
          // 标题 / 列表 / 底部提示三段纵向排；窗口定高，只有列表滚动
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
          padding: '8px 10px 9px',
          overflow: 'hidden',
          background: 'var(--dsw-specific-menu, #ffffff)',
          color: 'var(--dsw-alias-label-primary, #1f2328)',
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
          borderRadius: '10px',
          boxShadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,.28))',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '1.45',
          textAlign: 'left',
          // 头部是 Electron 的窗口拖拽区：浮层里要能选中/滚动，同样显式退出拖拽
          WebkitAppRegion: 'no-drag',
        }

        var previewBody = null
        if (preview.phase === 'loading') {
          previewBody = React.createElement(
            'div',
            { style: { marginTop: '5px', flex: '1 1 auto', fontSize: '11px', opacity: 0.75 } },
            '正在读取会话…',
          )
        } else if (preview.phase !== 'ready' || !Array.isArray(preview.rows) || preview.rows.length === 0) {
          // 失败 / 没权限 / 还没上线：一行灰字，不假装有内容
          previewBody = React.createElement(
            'div',
            { style: { marginTop: '5px', flex: '1 1 auto', fontSize: '11px', color: 'rgba(127,127,127,.95)' } },
            '该会话暂无预览（未在线或不可读）',
          )
        } else {
          previewBody = React.createElement(
            'div',
            {
              // 窗口定高：列表吃掉剩余高度 + overflowY:auto ⇒ 原生滚轮就能翻
              'data-pipeline-preview-list': 'true',
              style: { marginTop: '5px', flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' },
            },
            preview.rows.map(function (row, i) {
              // 用户靠右、AI 靠左 —— “缩小视窗的聊天界面”：字体不缩放，只是窗口大、可滚轮翻。
              var isUser = row.type === 'user/message'
              var thinking = row.thinking === true
              var bubbleProps = {
                // 点气泡 = 打开真实会话（处理器里先 stopPropagation，不触发面板的"点外面关闭"）
                title: '打开会话',
                onClick: openSessionFromPreview,
                style: {
                  maxWidth: '86%',
                  boxSizing: 'border-box',
                  padding: '5px 9px',
                  borderRadius: isUser ? '10px 10px 2px 10px' : '10px 10px 10px 2px',
                  fontSize: '12px',
                  lineHeight: '1.45',
                  background: isUser
                    ? 'var(--dsw-alias-bubble-user, rgba(47,129,247,.16))'
                    : 'var(--dsw-alias-bubble-assistant, rgba(127,127,127,.14))',
                  // AI 还没吐正文：斜体灰字"正在思考…"，不渲染空气泡
                  color: thinking ? 'rgba(127,127,127,.95)' : 'var(--dsw-alias-label-primary, #1f2328)',
                  fontStyle: thinking ? 'italic' : 'normal',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  overflowWrap: 'anywhere',
                  cursor: 'pointer',
                },
              }
              if (thinking) bubbleProps['data-pipeline-preview-thinking'] = 'true'
              return React.createElement(
                'div',
                {
                  key: 'row' + i,
                  style: {
                    display: 'flex',
                    justifyContent: isUser ? 'flex-end' : 'flex-start',
                    marginTop: i === 0 ? 0 : '6px',
                  },
                },
                React.createElement('div', bubbleProps, thinking ? PREVIEW_THINKING_TEXT : row.text),
              )
            }),
          )
        }

        previewNode = React.createElement(
          'div',
          {
            key: 'seatPreview',
            ref: previewBoxRef,
            role: 'dialog',
            'aria-label': '会话预览 · ' + preview.name,
            'data-pipeline-seat-preview': preview.key,
            // 鼠标移进来就取消"离开即关"的计时（要能从 chip 横移进来、滚轮翻那 12 条）
            onMouseEnter: keepPreview,
            onMouseLeave: schedulePreviewHide,
            // 预览层自己的点击不要冒泡出去（chip 的"打开对话"只认 chip 上的点击）
            onClick: function (ev) {
              if (ev !== null && ev !== undefined && typeof ev.stopPropagation === 'function') ev.stopPropagation()
            },
            style: boxStyle,
          },
          React.createElement(
            'div',
            {
              title: preview.sessionId !== '' ? '会话 id：' + preview.sessionId : '',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                flex: '0 0 auto',
                fontSize: '11.5px',
                fontWeight: 600,
                minWidth: 0,
              },
            },
            React.createElement(
              'span',
              { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              '会话预览 · ' + preview.name,
            ),
          ),
          previewBody,
          // 底部那一行也是"打开会话"的入口（与点气泡同一条路径）
          React.createElement(
            'div',
            {
              'data-pipeline-preview-open': 'true',
              title: '打开会话',
              onClick: openSessionFromPreview,
              style: {
                flex: '0 0 auto',
                marginTop: '6px',
                fontSize: '10.5px',
                color: 'rgba(127,127,127,.95)',
                textAlign: 'right',
                cursor: 'pointer',
                userSelect: 'none',
              },
            },
            '点击气泡打开会话 →',
          ),
        )
      }
      return previewNode
    }

    return { renderPreview: renderPreview }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-preview-bubble.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
