/* client.panel-card-actions.js —— 卡片动作的执行：⋯菜单开合、删单/永久删除的两击确认、置顶，以及「发一次动作 → busy/绿字或红字 → 该刷新哪份数据」。 */
;(function () {
  'use strict'

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    var postPanelAction = deps.actions.postPanelAction
    var actionMetaOf = deps.actions.actionMetaOf
    var actionKeyOf = deps.actions.actionKeyOf
    var isConfirmAction = deps.actions.isConfirmAction
    var isArchiveMutation = deps.actions.isArchiveMutation
    var DELETE_CONFIRM_MS = deps.actions.DELETE_CONFIRM_MS
    var messageOf = deps.actions.messageOf

    /**
     * 卡片动作的**执行面**：⋯菜单项 / 置顶 / 两击确认。
     *
     * 状态（busy / armed / 顶部提示行）归面板，这里只负责「按当前状态算下一步该干什么」：
     * 第一次点删单只上膛，3 秒内再点才真的发出去；发出去之后按「要不要动归档区」
     * 决定是重拉快照还是连归档一起重拉。
     *
     * @param {object} S 面板的共享作用域（状态、ref、以及别的模块挂上来的回调）
     */
    function setup(S) {
      var setActionUi = S.setActionUi
      var actionUi = S.actionUi
      var menuKey = S.menuKey
      var setMenuKey = S.setMenuKey
      var armTimerRef = S.armTimerRef
      var batch = S.batch
      var aliveRef = S.aliveRef
      var dropRows = S.dropRows
      var refreshAfterWrite = S.refreshAfterWrite
      var readOnce = S.readOnce

      /** 只改传入的键，其它字段原样保留（busy / 确认态 / 提示互不覆盖）。 */
      var patchActionUi = function (patch) {
        setActionUi(function (prev) {
          var next = { busyKey: prev.busyKey, armedKey: prev.armedKey, note: prev.note }
          if (patch.busyKey !== undefined) next.busyKey = patch.busyKey
          if (patch.armedKey !== undefined) next.armedKey = patch.armedKey
          if (patch.note !== undefined) next.note = patch.note
          return next
        })
      }
      var clearArmTimer = function () {
        if (armTimerRef.current === null) return
        clearTimeout(armTimerRef.current)
        armTimerRef.current = null
      }
      /**
       * 收起「⋯」菜单（幂等）。
       * 菜单一关，"删单第二击"就不可能再来了 ⇒ 顺手把上膛态与计时器一起作废。
       * 这里用**函数式**更新（不读 actionUi），所以旧闭包里调用也安全 ——
       * document 上的"点外面 / ESC"处理器拿到的正是面板打开那一刻的闭包。
       */
      var closeCardMenu = function () {
        setMenuKey('')
        clearArmTimer()
        patchActionUi({ armedKey: '' })
      }
      /** 「⋯」点击入口：开 / 合某张卡的菜单（一次只开一个；换菜单时把删单确认作废）。 */
      var toggleCardMenu = function (cardKey) {
        if (typeof cardKey !== 'string' || cardKey === '') return
        if (menuKey === cardKey) {
          closeCardMenu()
          return
        }
        clearArmTimer()
        if (actionUi.armedKey !== '') patchActionUi({ armedKey: '' })
        setMenuKey(cardKey)
      }
      /**
       * 发一次动作：菜单项转 busy → POST → 绿字/红字。
       * 成功时**立刻**把卡从界面撤掉（归档 / 删单 / 恢复归档 / 永久删除）并刷新快照：
       * 按钮该消失还是该换，下一帧就看得见，不用等 5 秒轮询。
       * 成功也顺手收起菜单；失败则留着（红字在上、菜单还开着，直接再点一次重试）。
       */
      var runAction = function (taskId, action) {
        var key = actionKeyOf(taskId, action)
        var fallback = actionMetaOf(action).done
        patchActionUi({ busyKey: key, armedKey: '', note: null })
        postPanelAction(taskId, action, isConfirmAction(action)).then(
          function (body) {
            if (!aliveRef.current) return
            if (body.ok === true) {
              patchActionUi({
                busyKey: '',
                note: {
                  kind: 'ok',
                  text: typeof body.message === 'string' && body.message !== '' ? body.message : fallback,
                },
              })
              setMenuKey('')
              if (isArchiveMutation(action)) {
                dropRows([taskId])
                refreshAfterWrite()
              } else {
                readOnce(undefined)
              }
              return
            }
            patchActionUi({
              busyKey: '',
              note: { kind: 'err', text: typeof body.error === 'string' && body.error !== '' ? body.error : '操作失败' },
            })
          },
          function (err) {
            if (!aliveRef.current) return
            patchActionUi({ busyKey: '', note: { kind: 'err', text: '操作失败：' + messageOf(err) } })
          },
        )
      }
      /** 菜单项点击入口：删单 / 永久删除的两次点击判据就在这里（第一次只"上膛"）。 */
      var onActionClick = function (taskId, action) {
        if (actionUi.busyKey !== '') return // 一次只让一个动作在飞
        if (isConfirmAction(action) && actionUi.armedKey !== actionKeyOf(taskId, action)) {
          armDelete(actionKeyOf(taskId, action))
          return
        }
        clearArmTimer()
        runAction(taskId, action)
      }
      /**
       * 置顶 / 取消置顶。
       * 只发请求 + 刷快照：**不重排**任务卡（宿主已经把置顶的排在前面，客户端再排会打架）。
       */
      var onPinClick = function (taskId, pinned) {
        if (actionUi.busyKey !== '') return
        runAction(taskId, pinned === true ? 'unpin' : 'pin')
      }
      /** 删单第一击：只进入确认态，3 秒后自己复原（超过就不认第二击）。 */
      var armDelete = function (key) {
        clearArmTimer()
        // 同一时刻只允许**一处**"上膛"：单卡刚上膛过、又去点批量删除时，
        // 别让单卡那颗按钮一直红着（它等的那次确认已经不可能来了）。
        if (batch.armed !== '') S.patchBatch({ armed: '' })
        patchActionUi({ armedKey: key })
        armTimerRef.current = setTimeout(function () {
          armTimerRef.current = null
          if (aliveRef.current) patchActionUi({ armedKey: '' })
        }, DELETE_CONFIRM_MS)
      }

      S.patchActionUi = patchActionUi
      S.clearArmTimer = clearArmTimer
      S.closeCardMenu = closeCardMenu
      S.toggleCardMenu = toggleCardMenu
      S.armDelete = armDelete
      S.runAction = runAction
      S.onActionClick = onActionClick
      S.onPinClick = onPinClick
    }

    return { setup: setup }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-card-actions.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
