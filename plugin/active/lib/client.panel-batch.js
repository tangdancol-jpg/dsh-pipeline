/* client.panel-batch.js —— 批量的状态机：进/出批量、整卡选中、删除类两击、串行执行与进度、以及「进归档视图 / 返回任务列表」这两条视图切换。 */
;(function () {
  'use strict'

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    var rowKeyOf = deps.actions.rowKeyOf
    var submitIdOf = deps.actions.submitIdOf
    var canRunAction = deps.actions.canRunAction
    var isConfirmAction = deps.actions.isConfirmAction
    var actionMetaOf = deps.actions.actionMetaOf
    var isArchiveMutation = deps.actions.isArchiveMutation
    var postPanelAction = deps.actions.postPanelAction
    var DELETE_CONFIRM_MS = deps.actions.DELETE_CONFIRM_MS
    var messageOf = deps.actions.messageOf

    /**
     * 批量模式的状态与执行（仿 QQ 多选面板）：串行 POST、进度「处理中 i/N」，
     * 结束时把「成功 N / 跳过 M / 失败 K」写进顶部提示行，然后清空选择、退出批量。
     *
     * @param {object} S 面板的共享作用域（批量状态在 S.batch，用 S.setBatch 改）
     */
    function setup(S) {
      var batch = S.batch
      var setBatch = S.setBatch
      var actionUi = S.actionUi
      var view = S.view
      var aliveRef = S.aliveRef
      var armTimerRef = S.armTimerRef
      var clearArmTimer = S.clearArmTimer
      var setMenuKey = S.setMenuKey
      var patchActionUi = S.patchActionUi
      var dropRows = S.dropRows
      var refreshAfterWrite = S.refreshAfterWrite
      var readOnce = S.readOnce
      var currentRows = S.currentRows

      /** 只改传入的键，其它字段原样保留。 */
      var patchBatch = function (patch) {
        setBatch(function (prev) {
          var next = {
            on: prev.on,
            selected: prev.selected,
            busy: prev.busy,
            done: prev.done,
            total: prev.total,
            armed: prev.armed,
          }
          if (patch.on !== undefined) next.on = patch.on
          if (patch.selected !== undefined) next.selected = patch.selected
          if (patch.busy !== undefined) next.busy = patch.busy
          if (patch.done !== undefined) next.done = patch.done
          if (patch.total !== undefined) next.total = patch.total
          if (patch.armed !== undefined) next.armed = patch.armed
          return next
        })
      }
      /** 退出批量模式：清空选择、清掉进度与确认态（幂等）。 */
      var exitBatch = function () {
        clearArmTimer()
        setMenuKey('')
        patchBatch({ on: false, selected: [], busy: false, done: 0, total: 0, armed: '' })
      }
      /** 头部「批量」：进 / 出批量模式（进去时先清空上一次的选择）。 */
      var toggleBatch = function () {
        // 批量模式下不画「⋯」，残留的菜单状态要先收掉（否则退出批量后它会自己弹回来）
        setMenuKey('')
        if (batch.on) {
          exitBatch()
          return
        }
        clearArmTimer()
        patchBatch({ on: true, selected: [], busy: false, done: 0, total: 0, armed: '' })
      }
      /** 点整张卡 = 切换选中（批量模式外、执行中都忽略）。 */
      var toggleSelect = function (id) {
        if (!batch.on || batch.busy) return
        if (typeof id !== 'string' || id === '') return
        var at = batch.selected.indexOf(id)
        var next = batch.selected.slice()
        if (at === -1) next.push(id)
        else next.splice(at, 1)
        // 选择变了，上膛的"确认删除"就该作废（别让它删到别的单）
        patchBatch({ selected: next, armed: '' })
      }
      /** 批量删除类动作的第一击：只上膛，3 秒后自己复原。 */
      var armBatch = function (action) {
        clearArmTimer()
        // 同上：单卡上膛的那颗先清掉 —— 一次只让一个"第二击"在等。
        if (actionUi.armedKey !== '') patchActionUi({ armedKey: '' })
        patchBatch({ armed: action })
        armTimerRef.current = setTimeout(function () {
          armTimerRef.current = null
          if (aliveRef.current) patchBatch({ armed: '' })
        }, DELETE_CONFIRM_MS)
      }
      /** 批量栏按钮入口：删除类先上膛（第二击才真的发）。 */
      var onBatchAction = function (action) {
        if (batch.busy) return
        if (isConfirmAction(action) && batch.armed !== action) {
          armBatch(action)
          return
        }
        clearArmTimer()
        runBatch(action)
      }
      /**
       * 批量执行：对选中项**串行** POST（一次一个，回包了再发下一个）。
       *
       * 选中的项里**不支持这个动作的跳过**（主视图看 `allowed_actions`；归档视图两项都允许），
       * 结束时把「成功 N / 跳过 M / 失败 K」写进顶部提示，然后清空选择、退出批量、刷新快照。
       */
      var runBatch = function (action) {
        if (batch.busy) return
        var rows = currentRows()
        var picked = []
        var skipped = 0
        for (var i = 0; i < batch.selected.length; i++) {
          var id = batch.selected[i]
          var row = null
          for (var j = 0; j < rows.length; j++) {
            if (rowKeyOf(rows[j], view) === id) {
              row = rows[j]
              break
            }
          }
          if (row === null || !canRunAction(row, action)) {
            skipped += 1
            continue
          }
          var submit = submitIdOf(row, view)
          if (submit === '') {
            skipped += 1
            continue
          }
          picked.push(submit)
        }
        if (picked.length === 0) {
          patchActionUi({ note: { kind: 'err', text: '选中的 ' + batch.selected.length + ' 项都不支持这个操作' } })
          return
        }
        var confirm = isConfirmAction(action)
        var doneLabel = actionMetaOf(action).done
        patchActionUi({ note: null })
        patchBatch({ busy: true, done: 0, total: picked.length, armed: '' })

        var okCount = 0
        var failCount = 0
        var failedIds = []
        var lastError = ''
        var chain = Promise.resolve()
        picked.forEach(function (taskId, index) {
          chain = chain.then(function () {
            if (!aliveRef.current) return
            patchBatch({ done: index })
            return postPanelAction(taskId, action, confirm).then(
              function (body) {
                if (body.ok === true) {
                  okCount += 1
                  return
                }
                failCount += 1
                failedIds.push(taskId)
                if (lastError === '' && typeof body.error === 'string' && body.error !== '') lastError = body.error
              },
              function (err) {
                failCount += 1
                failedIds.push(taskId)
                if (lastError === '') lastError = messageOf(err)
              },
            )
          })
        })
        chain.then(function () {
          if (!aliveRef.current) return
          var okIds = picked.filter(function (taskId) {
            return failedIds.indexOf(taskId) === -1
          })
          if (okIds.length > 0) dropRows(okIds)
          var parts = [doneLabel + ' ' + okCount + ' 项']
          if (skipped > 0) parts.push('跳过 ' + skipped + ' 项（不支持这个操作）')
          if (failCount > 0) parts.push('失败 ' + failCount + ' 项' + (lastError === '' ? '' : '：' + lastError))
          patchActionUi({ note: { kind: failCount > 0 ? 'err' : 'ok', text: parts.join('；') } })
          exitBatch()
          if (isArchiveMutation(action)) refreshAfterWrite()
          else readOnce(undefined)
        })
      }

      S.patchBatch = patchBatch
      S.exitBatch = exitBatch
      S.toggleBatch = toggleBatch
      S.toggleSelect = toggleSelect
      S.armBatch = armBatch
      S.onBatchAction = onBatchAction
      S.runBatch = runBatch
    }

    /** 头部「归档 N」/「← 返回任务」：换视图，顺手把对应那份数据刷一次。 */
    function setupArchivedView(S) {
      var exitBatch = S.exitBatch
      var setView = S.setView
      var readOnce = S.readOnce
      var readArchivedOnce = S.readArchivedOnce

      // =======================================================================
      // 归档视图的开关（分区：归档视图）
      // =======================================================================

      /** 头部「归档 N」：进归档视图（顺手刷一次，保证数量与列表是新的）。 */
      var openArchivedView = function () {
        exitBatch()
        setView('archived')
        readArchivedOnce(undefined)
      }

      /** 头部「← 返回任务」：回主视图（顺手刷一次，刚恢复的单才会立刻出现）。 */
      var backToTasks = function () {
        exitBatch()
        setView('tasks')
        readOnce(undefined)
      }

      S.openArchivedView = openArchivedView
      S.backToTasks = backToTasks
    }

    return { setup: setup, setupArchivedView: setupArchivedView }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-batch.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
