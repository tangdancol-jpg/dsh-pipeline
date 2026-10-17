/* client.panel-poll.js —— 面板的数据面：5s 轮询任务快照与归档列表（页面在后台时跳过）、失败**保留上次数据**只补错误文案、写成功后把该消失的那几行当场撤掉并重拉；这里不碰任何「谁开着 / 选中了什么」的交互状态。 */
;(function () {
  'use strict'

  /** 面板轮询周期。席位状态变得比开关勤，所以比开关的 8s 快。 */
  var PANEL_POLL_MS = 5000

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    var fetchPanel = deps.actions.fetchPanel
    var fetchArchived = deps.actions.fetchArchived
    var messageOf = deps.actions.messageOf
    var rowKeyOf = deps.actions.rowKeyOf

    /**
     * 面板的**数据面**：两份数据（主快照 / 归档列表）的轮询与取数、失败时保留上次数据、
     * 写成功后的行剔除与重拉。
     *
     * 所有状态与回调都挂到共享作用域 S 上 —— 拆分前它们本来就在同一个闭包里，
     * 挂上去之后各 chunk 看到的仍是同一份、同一轮渲染的值。
     *
     * @param {object} S 面板的共享作用域
     */
    function setup(S) {
      var React = S.React

      var snapHook = React.useState(null) // { tasks: [...] | null, error: string, generatedAt: string }
      var snap = snapHook[0]
      var setSnap = snapHook[1]

      // ---- 视图与归档列表（分区：归档视图）----
      //   view     'tasks'（主视图）| 'archived'（归档视图）
      //   archived { tasks: [...] | null, error: string } —— **另一份数据**，与主快照互不影响
      var viewHook = React.useState('tasks')
      var view = viewHook[0]
      var setView = viewHook[1]

      var archHook = React.useState(null)
      var archived = archHook[0]
      var setArchived = archHook[1]

      var aliveRef = React.useRef(true)
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

      S.snap = snap
      S.setSnap = setSnap
      S.view = view
      S.setView = setView
      S.archived = archived
      S.setArchived = setArchived
      S.aliveRef = aliveRef
      S.readOnce = readOnce
      S.readArchivedOnce = readArchivedOnce
      S.dropRows = dropRows
      S.refreshAfterWrite = refreshAfterWrite
      S.currentRows = currentRows
    }

    return { setup: setup }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-poll.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
