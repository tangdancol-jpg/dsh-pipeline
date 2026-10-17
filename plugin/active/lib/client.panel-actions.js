/* client.panel-actions.js —— 面板的「动作契约」：三条路由、动作表与文案、两击确认判据、面板取数/提交写操作，以及行键/提交 id 这些纯助手。 */
;(function () {
  'use strict'

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    // ---- 面板数据面：三条路由（宿主 `lib/switch-routes.js` / `lib/panel/**`） ----

    /**
     * 面板数据路由（宿主半边注册）。
     *
     * 契约：`GET /.dsh-pipeline/panel` → `{ ok, generated_at, project_root, tasks: [...] }`，
     * 每个 task 的 `seats[]` 形如
     * `{ role, role_label, seat, status: 'current|dispatched|declared',
     *    kind: 'session|team|unknown', session_id, parent_session_id, member_name, layer }`。
     */
    var PANEL_PATH = '/.dsh-pipeline/panel'
    /**
     * 归档视图：**同一条路由**，`view=archived` 换的是数据源。
     *
     * 契约：`GET {PANEL_ARCHIVED_PATH}` → `{ ok, tasks: [{ id, dir, state, state_label,
     *        requirement_snippet, archived_at }], warnings[] }`
     * ★ 归档项的写操作 `task_id` 传的是**归档目录名 `dir`**（不是任务 id）—— 后面所有
     *   归档动作都按这条走：`unarchive` / `delete_archived`。
     */
    var PANEL_ARCHIVED_PATH = PANEL_PATH + '?view=archived'
    /**
     * 面板**写操作**路由（宿主半边在 `lib/switch-routes.js` 的 `PANEL_ACTION_PATH`）。
     *
     * 契约（与宿主 `lib/panel/actions.js` 是同一份）：
     *   `POST { task_id, action: 'cancel'|'restore'|'archive'|'delete', confirm?: boolean }`
     *     → `200 { ok:true,  action, task_id, message }`   // message 是给人看的中文
     *     → `200 { ok:false, action?, task_id?, error }`   // 业务失败也是 200：读 ok，不猜状态码
     */
    var PANEL_ACTION_PATH = '/.dsh-pipeline/panel/action'
    /**
     * 四个动作的**可见顺序**（与快照 `allowed_actions` 的契约顺序一致）。
     * 快照给什么名字就只认什么名字：认不出的动作**不渲染按钮**（宁可不显示，
     * 也不给一个点了没反应的按钮）。
     */
    var PANEL_ACTION_ORDER = ['cancel', 'restore', 'archive', 'delete']
    /** 动作 → 按钮文案 / 兜底成功提示 / tooltip。`done` 只在回包没给 `message` 时用。 */
    var PANEL_ACTION_META = {
      cancel: { label: '终止', done: '已终止', tip: '终止这张任务单（进入终态，之后才能归档或删单）' },
      restore: { label: '恢复', done: '已恢复', tip: '解除阻塞，把任务单恢复到阻塞前的状态' },
      archive: { label: '归档', done: '已归档', tip: '把这张终态任务单移进归档区（可恢复）' },
      delete: { label: '删单', done: '已删单', tip: '永久删除这张终态任务单，不可恢复（要点两次）' },
    }
    /**
     * 归档视图里的两个动作（按钮顺序同上，两个都允许）。
     * 它们**不看 `allowed_actions`**：进了归档区就说明已经是终态单了，恢复与永久删除都合法。
     * `task_id` 传归档目录名 `dir`；`delete_archived` 同样要 `confirm: true`。
     */
    var ARCHIVED_ACTION_ORDER = ['unarchive', 'delete_archived']
    var ARCHIVED_ACTION_META = {
      unarchive: { label: '恢复', done: '已恢复', tip: '把这张单移回任务列表（不是解除阻塞，是把它挪出归档区）' },
      delete_archived: { label: '永久删除', done: '已删除', tip: '永久删除这张已归档的单，不可恢复（要点两次）' },
    }
    /**
     * 置顶动作（📌）。宿主负责排序，客户端只负责发请求与画那颗钉子 ——
     * 客户端**不重排**任务卡（排了会跟宿主的顺序打架）。
     */
    var PIN_ACTION_META = {
      pin: { label: '置顶', done: '已置顶', tip: '把这张任务单钉在列表最前面（宿主排序，客户端不重排）' },
      unpin: { label: '取消置顶', done: '已取消置顶', tip: '取消置顶，让它回到原来的位置' },
    }
    /** 删单的两击确认窗口：超时或指针移开就复原 —— 不可恢复的动作不该被误触。 */
    var DELETE_CONFIRM_MS = 3000

    /** 删单按钮进入确认态后的文案（第二次点它才真的删）。 */
    var DELETE_CONFIRM_LABEL = '再点一次确认删单'

    /** 确认态下的 tooltip（把"不可恢复"写死在这里，别指望用户记得住）。 */
    var DELETE_ARMED_TIP = '再点一次就**永久**删除这张任务单（不可恢复）'

    /** 归档视图里「永久删除」的确认文案 / tooltip（措辞更狠一点：真的不可恢复）。 */
    var DELETE_ARCHIVED_CONFIRM_LABEL = '再点一次确认删除'
    var DELETE_ARCHIVED_ARMED_TIP = '再点一次就**永久**删除这张已归档的单（不可恢复）'

    /** 批量操作栏里删除类按钮的确认文案（一次删一批，更要说清）。 */
    var BATCH_DELETE_CONFIRM_LABEL = '再点一次确认删除'

    // ---- 数据取数（失败不抛：面板的规矩是「保留上次数据 + 补一行小字」） ----

    /** 任何异常/东西 → 一句人话（面板里显示「打不开会话：…」时用，不把堆栈糊给用户）。 */
    function messageOf(err) {
      if (err === null || err === undefined) return '未知错误'
      if (typeof err === 'string') return err
      if (typeof err.message === 'string' && err.message !== '') return err.message
      return String(err)
    }
    /**
     * 读面板数据（主视图与归档视图**共用**这一套归一化）。
     *
     * 失败**不抛**：面板的规矩是"保留上次数据 + 底下补一行小字错误"，
     * 抛出去只会把整块面板打成白屏。
     *
     * @param {string} path - `PANEL_PATH` 或 `PANEL_ARCHIVED_PATH`
     * @returns {Promise<{ok:boolean, tasks?:Array, generatedAt?:string, error?:string}>}
     */
    function fetchPanelFrom(path, signal) {
      return fetch(path, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: signal,
      }).then(function (res) {
        return res.json().then(
          function (body) {
            if (body === null || typeof body !== 'object') {
              return { ok: false, error: '返回体不是 JSON 对象（HTTP ' + res.status + '）' }
            }
            if (!res.ok || body.ok !== true) {
              return { ok: false, error: typeof body.error === 'string' && body.error !== '' ? body.error : 'HTTP ' + res.status }
            }
            return {
              ok: true,
              tasks: Array.isArray(body.tasks) ? body.tasks : [],
              generatedAt: typeof body.generated_at === 'string' ? body.generated_at : '',
            }
          },
          function () {
            return { ok: false, error: '返回体不是 JSON（HTTP ' + res.status + '）' }
          },
        )
      })
    }
    /**
     * 读**主视图**快照。
     * @returns {Promise<{ok:boolean, tasks?:Array, generatedAt?:string, error?:string}>}
     */
    function fetchPanel(signal) {
      return fetchPanelFrom(PANEL_PATH, signal)
    }

    /**
     * 读**归档视图**列表（同一套归一化；`archived_at` 留在 task 里原样带回来）。
     * @returns {Promise<{ok:boolean, tasks?:Array, generatedAt?:string, error?:string}>}
     */
    function fetchArchived(signal) {
      return fetchPanelFrom(PANEL_ARCHIVED_PATH, signal)
    }
    /**
     * 发一次面板写操作。
     *
     * 失败**不抛**（与 `fetchPanel` 同一条规矩）：网络异常由调用方补 `.catch`，
     * 这里只把"服务器回了个什么形状"归一成 `{ ok, message?, error? }`。
     *
     * @param {string} taskId
     * @param {string} action - `cancel` / `restore` / `archive` / `delete`
     * @param {boolean} confirm - 只有 `delete` 需要（宿主侧 `confirm !== true` 会明确拒绝）
     * @returns {Promise<{ok:boolean, message?:string, error?:string}>}
     */
    function postPanelAction(taskId, action, confirm) {
      var payload = { task_id: taskId, action: action }
      if (confirm === true) payload.confirm = true
      return fetch(PANEL_ACTION_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(payload),
      }).then(function (res) {
        return res.json().then(
          function (body) {
            if (body === null || typeof body !== 'object') {
              return { ok: false, error: '返回体不是 JSON 对象（HTTP ' + res.status + '）' }
            }
            if (!res.ok || body.ok !== true) {
              return { ok: false, error: typeof body.error === 'string' && body.error !== '' ? body.error : 'HTTP ' + res.status }
            }
            return { ok: true, message: typeof body.message === 'string' ? body.message : '' }
          },
          function () {
            return { ok: false, error: '返回体不是 JSON（HTTP ' + res.status + '）' }
          },
        )
      })
    }

    // ---- 行 → 键 / 提交 id / 动作判据（列表、菜单与批量都靠这几个） ----

    /**
     * 一条列表项（任务 or 归档项）在**界面上的键**。
     * 归档视图用归档目录名 `dir`（同一张单可能既有 id 又有 dir，键必须取 dir）；
     * 主视图就是任务 id。空串表示这一项没法操作（调用方据此跳过）。
     */
    function rowKeyOf(row, view) {
      if (row === null || typeof row !== 'object') return ''
      if (view === 'archived' && typeof row.dir === 'string' && row.dir !== '') return row.dir
      if (typeof row.id === 'string' && row.id !== '') return row.id
      return typeof row.dir === 'string' ? row.dir : ''
    }
    /**
     * 发写操作时 `task_id` 该填什么。
     * ★ 归档视图填 **`dir`**（宿主契约：归档项的 task_id 是归档目录名），其余填任务 id。
     */
    function submitIdOf(row, view) {
      if (row === null || typeof row !== 'object') return ''
      if (view === 'archived' && typeof row.dir === 'string' && row.dir !== '') return row.dir
      return typeof row.id === 'string' ? row.id : ''
    }
    /**
     * 这一项能不能执行某个批量动作。
     *
     * 主视图看 `allowed_actions`（快照是唯一判据，客户端不猜状态）；
     * 归档视图里两项动作恒定允许 —— 归档区里本来就只剩终态单。
     */
    function canRunAction(row, action) {
      if (ARCHIVED_ACTION_META[action] !== undefined) return true
      var allowed = row !== null && typeof row === 'object' && Array.isArray(row.allowed_actions) ? row.allowed_actions : []
      return allowed.indexOf(action) !== -1
    }
    /**
     * 归档时间 → 人能读的一行。
     * 手拼而不是 `toLocaleString`：Electron 各环境 locale 不一致，归档卡的时间不该随机器变样。
     * 解析不了就原样显示（宿主给了什么就显示什么，不吞掉）。
     */
    function archivedAtText(raw) {
      if (typeof raw !== 'string' || raw === '') return ''
      var ms = Date.parse(raw)
      if (!Number.isFinite(ms)) return raw
      var d = new Date(ms)
      var pad = function (n) {
        return n < 10 ? '0' + n : String(n)
      }
      return (
        d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      )
    }
    /** 面板动作的键：`taskId + 动作`（同一张卡上四个按钮各自独立 busy / 确认态）。 */
    function actionKeyOf(taskId, action) {
      return String(taskId) + '\u0000' + String(action)
    }
    /**
     * 需要**两次点击**才执行的动作（删单 / 归档区里的永久删除）：
     * 第一击只"上膛"，3 秒内再点才真的发出去。
     */
    function isConfirmAction(action) {
      return action === 'delete' || action === 'delete_archived'
    }
    /**
     * 这个动作成功后，卡就该从当前视图消失，且**两份数据都要刷新**：
     * 归档把单从任务列表挪进归档区，删除把它从两处都抹掉，恢复归档把它挪回来。
     */
    function isArchiveMutation(action) {
      return action === 'archive' || action === 'delete' || action === 'unarchive' || action === 'delete_archived'
    }
    /** 动作 → 文案/兜底提示（三种动作表合一；认不出也返回一份最保守的兜底，面板不白屏）。 */
    function actionMetaOf(action) {
      if (PANEL_ACTION_META[action] !== undefined) return PANEL_ACTION_META[action]
      if (PIN_ACTION_META[action] !== undefined) return PIN_ACTION_META[action]
      if (ARCHIVED_ACTION_META[action] !== undefined) return ARCHIVED_ACTION_META[action]
      return { label: String(action), done: '已完成', tip: '' }
    }

    return {
      PANEL_PATH: PANEL_PATH,
      PANEL_ARCHIVED_PATH: PANEL_ARCHIVED_PATH,
      PANEL_ACTION_PATH: PANEL_ACTION_PATH,
      PANEL_ACTION_ORDER: PANEL_ACTION_ORDER,
      PANEL_ACTION_META: PANEL_ACTION_META,
      ARCHIVED_ACTION_ORDER: ARCHIVED_ACTION_ORDER,
      ARCHIVED_ACTION_META: ARCHIVED_ACTION_META,
      PIN_ACTION_META: PIN_ACTION_META,
      DELETE_CONFIRM_MS: DELETE_CONFIRM_MS,
      DELETE_CONFIRM_LABEL: DELETE_CONFIRM_LABEL,
      DELETE_ARMED_TIP: DELETE_ARMED_TIP,
      DELETE_ARCHIVED_CONFIRM_LABEL: DELETE_ARCHIVED_CONFIRM_LABEL,
      DELETE_ARCHIVED_ARMED_TIP: DELETE_ARCHIVED_ARMED_TIP,
      BATCH_DELETE_CONFIRM_LABEL: BATCH_DELETE_CONFIRM_LABEL,
      messageOf: messageOf,
      fetchPanel: fetchPanel,
      fetchArchived: fetchArchived,
      postPanelAction: postPanelAction,
      rowKeyOf: rowKeyOf,
      submitIdOf: submitIdOf,
      canRunAction: canRunAction,
      archivedAtText: archivedAtText,
      actionKeyOf: actionKeyOf,
      isConfirmAction: isConfirmAction,
      isArchiveMutation: isArchiveMutation,
      actionMetaOf: actionMetaOf,
    }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-actions.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
