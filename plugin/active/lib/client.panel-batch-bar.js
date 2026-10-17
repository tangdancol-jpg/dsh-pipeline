/* client.panel-batch-bar.js —— 底部那条批量操作栏：sticky 通栏、按钮表（按当前视图给「归档/删除」或「恢复/删除」）、进度与两击确认态。 */
;(function () {
  'use strict'

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    var PANEL_PAD_X = deps.atoms.PANEL_PAD_X
    var PANEL_PAD_BOTTOM = deps.atoms.PANEL_PAD_BOTTOM
    var BATCH_DELETE_CONFIRM_LABEL = deps.actions.BATCH_DELETE_CONFIRM_LABEL


    /**
     * 底部的**批量操作栏**（sticky 在列表底部；面板本身是可滚动容器）。
     *
     * 只显示"对这些选中项有意义"的按钮：主视图 = 归档所选 / 删除所选，
     * 归档视图 = 恢复所选 / 删除所选。删除类需要两击（`armed`），执行中显示「处理中 i/N」。
     */
    function renderBatchBar(React, opts) {
      if (opts.visible !== true) return null
      var count = Number.isFinite(opts.count) ? Number(opts.count) : 0
      var busy = opts.busy === true
      var total = Number.isFinite(opts.total) ? Number(opts.total) : 0
      var done = Number.isFinite(opts.done) ? Number(opts.done) : 0
      var progress = busy && total > 0 ? '处理中 ' + done + '/' + total : ''
      var actions = Array.isArray(opts.actions) ? opts.actions : []
      var buttons = []
      for (var i = 0; i < actions.length; i++) {
        var item = actions[i]
        var armed = item.armed === true
        var danger = item.danger === true
        buttons.push(
          React.createElement(
            'button',
            {
              key: 'batch-' + item.id,
              type: 'button',
              disabled: busy || count === 0,
              'data-pipeline-batch-action': item.id,
              'data-pipeline-batch-state': busy ? 'busy' : armed ? 'armed' : 'idle',
              title: busy ? '正在逐个等宿主回话…' : armed ? item.armedTip : item.tip,
              onClick: (function (id) {
                return function () {
                  opts.onAction(id)
                }
              })(item.id),
              style: {
                height: '22px',
                padding: '0 9px',
                font: 'inherit',
                fontSize: '11px',
                lineHeight: '1',
                color: armed ? '#ffffff' : danger ? '#d9534f' : 'inherit',
                background: armed ? '#d9534f' : 'transparent',
                border:
                  '1px solid ' +
                  (danger
                    ? armed
                      ? '#d9534f'
                      : 'rgba(217,83,79,.45)'
                    : 'var(--dsw-alias-border-l2, rgba(127,127,127,.35))'),
                borderRadius: '999px',
                cursor: busy ? 'progress' : count === 0 ? 'not-allowed' : 'pointer',
                opacity: busy ? 0.6 : count === 0 ? 0.55 : 1,
                whiteSpace: 'nowrap',
                userSelect: 'none',
                WebkitAppRegion: 'no-drag',
              },
            },
            armed ? item.armedLabel : item.label,
          ),
        )
      }
      buttons.push(
        React.createElement(
          'button',
          {
            key: 'batch-cancel',
            type: 'button',
            disabled: busy,
            'data-pipeline-batch-action': 'cancel',
            title: '退出批量模式并清空选择',
            onClick: function () {
              opts.onCancel()
            },
            style: {
              height: '22px',
              padding: '0 9px',
              font: 'inherit',
              fontSize: '11px',
              lineHeight: '1',
              color: 'inherit',
              background: 'transparent',
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
              borderRadius: '999px',
              cursor: busy ? 'progress' : 'pointer',
              opacity: busy ? 0.6 : 1,
              whiteSpace: 'nowrap',
              userSelect: 'none',
              WebkitAppRegion: 'no-drag',
            },
          },
          '取消',
        ),
      )
      return React.createElement(
        'div',
        {
          'data-pipeline-batch-bar': 'true',
          'data-pipeline-batch-progress': progress,
          style: {
            // sticky：面板是 overflowY:auto 的滚动容器，这一条贴在它的下边缘。
            // 负的左右 / 下边距把面板 padding 抵掉，看起来才像一条通栏。
            position: 'sticky',
            bottom: 0,
            zIndex: 5,
            margin: '8px -' + PANEL_PAD_X + 'px -' + PANEL_PAD_BOTTOM + 'px',
            padding: '8px ' + PANEL_PAD_X + 'px 9px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
            gap: '5px',
            minWidth: 0,
            background: 'var(--dsw-specific-menu, #ffffff)',
            borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.26))',
            boxShadow: '0 -6px 12px -10px rgba(0,0,0,.35)',
            // 批量栏整体也在会话头部的窗口拖拽区里（按钮自身已有，容器补上）
            WebkitAppRegion: 'no-drag',
          },
        },
        React.createElement(
          'span',
          {
            'data-pipeline-batch-count': String(count),
            style: { flex: '1 1 auto', fontSize: '11.5px', fontWeight: 600, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
          },
          progress !== '' ? progress : '已选 ' + count + ' 项',
        ),
        buttons,
      )
    }

    /**
     * 批量操作栏该有哪几个按钮：主视图「归档所选 / 删除所选」，归档视图「恢复所选 / 删除所选」。
     * 删除类要两击（`armed`），文案与 tooltip 写死在下面，别让用户猜。
     */
    function batchActionsFor(S) {
      var view = S.view
      var batch = S.batch
      // 底部的批量操作栏：只放"对当前视图有意义"的动作（删除类要两击）
      var batchActions = []
      if (view === 'archived') {
        batchActions.push({
          id: 'unarchive',
          label: '恢复所选',
          danger: false,
          armed: false,
          armedLabel: '',
          armedTip: '',
          tip: '把选中的单移回任务列表',
        })
        batchActions.push({
          id: 'delete_archived',
          label: '删除所选',
          danger: true,
          armed: batch.armed === 'delete_archived',
          armedLabel: BATCH_DELETE_CONFIRM_LABEL,
          armedTip: '再点一次就**永久**删除选中的这些已归档单（不可恢复）',
          tip: '永久删除选中的单，不可恢复（要点两次）',
        })
      } else {
        batchActions.push({
          id: 'archive',
          label: '归档所选',
          danger: false,
          armed: false,
          armedLabel: '',
          armedTip: '',
          tip: '把选中的终态单移进归档区（可恢复）',
        })
        batchActions.push({
          id: 'delete',
          label: '删除所选',
          danger: true,
          armed: batch.armed === 'delete',
          armedLabel: BATCH_DELETE_CONFIRM_LABEL,
          armedTip: '再点一次就**永久**删除选中的这些单（不可恢复）',
          tip: '永久删除选中的单，不可恢复（要点两次）',
        })
      }
      return batchActions
    }

    return { renderBatchBar: renderBatchBar, batchActionsFor: batchActionsFor }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-batch-bar.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
