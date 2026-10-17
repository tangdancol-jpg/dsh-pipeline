/**
 * dsh-pipeline · 客户端半边（Web GUI 右上角的多 AI 协调开关）
 * ============================================================================
 * ⚠️ 这个文件**不是 ES 模块**。宿主按 `dsh-client-modules` 的约定，用
 *    `<script async src="/plugins/dsh-pipeline/client.js?rev=…">` 把它当
 *    **经典脚本**加载（`dsh-client-modules/lib/client.js:450-464`
 *    `defaultLoadBundle`：`el.async = true; el.src = url`，**没有** `type="module"`），
 *    然后它自己调 `window.__ModuleLoader__.load({ id, factory })` 注册。
 *
 *    所以：不许出现 `import` / `export` / 顶层 `await`。要什么就 `require(...)`。
 *    可用的是 loader 的内建 —— 实测已装插件用的是 `require('react')` 与
 *    `require('react/jsx-runtime')`（`dsh-drawai/lib/client.js:7-8`）。
 *
 * ---------------------------------------------------------------------------
 * 挂在哪：`conversation.session.header.utilities`
 * ---------------------------------------------------------------------------
 * 这是**会话头部那一排的右侧区域**，紧挨着最右边的 `…header.corner`
 * （右侧栏切换按钮就在 corner 里）。用户红框标的就是这一带。
 *
 * 选它的三条依据（都来自源码，不是猜）：
 *   ① 它是 **list 槽**（`dsh-client-ui-conversation/lib/client.js:18272-18275`
 *      `{ kind: "list", scope: "session" }`）—— 允许多个条目共存，
 *      注册时给 `id` + `order` 即可，不会顶掉别人。已装的 `dsh-client-ui-open-in-app`
 *      就是往这里注册的（`id: "open-in-app", order: -10`）。
 *   ② 它的渲染**不受 `hideChrome` 影响**（`…/client.js:16463` 的 `!hideChrome &&`
 *      只圈住了标题面包屑与 headerActions；utilities 在 16504-16506 是平级），
 *      所以空会话时也看得见。
 *   ③ 它就在 `conversation.session.header.corner`（右侧栏切换按钮）**左边一格** ——
 *      与用户指的位置是同一带。corner 是 **single 槽**（`:18276-18279`），
 *      已经被 `dsh-client-ui-sidebar-right` 占着（`…/sidebar-right/lib/client.js:9187`），
 *      往那儿注册会被 "single slot already has a registration" 直接顶掉。
 *
 * ⚠️ **没有**"窗口级头部/顶栏"槽位。全树扫描（177 个客户端 bundle）里
 *    `shell.*` 只有两个：`shell.overlay`（覆盖层）与 `shell.leading`。
 *    而 `shell.leading` 在布局里是 `const leadingMounted = darwin && sidebarCollapsed`
 *    （`dsh-client-ui-layout/lib/client.js:313-314`、`:348-352`）—— **只有 macOS
 *    且侧栏收起时才挂载**，Windows 上根本不渲染。详见 README「UI 开关」一节。
 *
 * ---------------------------------------------------------------------------
 * 这个文件现在挂**两个**条目（同槽位，互不顶替）
 * ---------------------------------------------------------------------------
 *   ① `pipeline-coordination-toggle`（order 100）—— 「多AI 协调」功能总开关。
 *   ② `pipeline-panel`（order 110）—— 「多AI协调团队」面板：列任务 + 席位（角色中文名 + 席位号
 *      + 状态），点席位名字用 `uiWorkspace.openSession(...)` 打开那个对话，当前对话的席位
 *      带 ring 高亮与「当前对话」标签。数据来自 `GET /.dsh-pipeline/panel`（5s 轮询）。
 *
 * 面板里还有这几处交互（宿主侧只需要契约，代码全在本文件）：
 *   · 任务卡右下角的**操作按钮**（终止 / 恢复 / 归档 / 删单）：按钮来源是快照的
 *     `task.allowed_actions`，点击发 `POST /.dsh-pipeline/panel/action`。
 *     「删单」用**两次点击**确认（3 秒内再点），**不弹** `window.confirm`（Electron 里体验差
 *     且可能被拦）。
 *   · **置顶**（任务卡标题行右侧那颗钉子）：`pin` / `unpin`。宿主已经把置顶任务排在快照前面，
 *     客户端**不重排**，只在卡上显示 📌。
 *   · **批量模式**（头部左侧「批量」）：每张卡左侧出现圆勾、**点整卡切换选中**，底部浮出批量
 *     操作栏；对选中项**串行** POST（一次一个，显示「处理中 i/N」），完成后清空选择并退出批量。
 *   · **归档视图**（头部右侧「归档 N」）：`GET /.dsh-pipeline/panel?view=archived`，每张归档卡
 *     可「恢复」/「永久删除」（后者同样两击确认）。★ 归档视图的 `task_id` 传的是**归档目录名
 *     `dir`**，不是任务 id。
 *   · 席位 chip **悬停 400ms** 弹一个会话预览浮层（最近 12 条，`overflowY:auto` 可滚轮翻）：
 *     取数走客户端 `sessions` 服务（`ctx.get('sessions')` → `retain(...)` →
 *     `binding.eventSource`），不是从面板快照里拿的。
 *
 * ---------------------------------------------------------------------------
 * 怎么和宿主说话：同端口相对 fetch
 * ---------------------------------------------------------------------------
 * 宿主半边注册了 `/.dsh-pipeline/state`（`lib/switch-routes.js`）与
 * `/.dsh-pipeline/panel`（面板数据）。
 * 客户端用**相对路径** fetch —— 登录 cookie 自动带上，不需要额外握手。
 * 这个做法来自已装的 `dsh-orb`（`client.js` 里 `request('/.dsh-orb/jump', …)`）。
 *
 * @module dsh-pipeline/lib/client
 */

;(function () {
  'use strict'

  /** 模块 id。**必须等于包名** —— 宿主的 boot manifest 用它拼 `/plugins/<id>/client.js`。 */
  var MODULE_ID = 'dsh-pipeline'

  /** 状态路由。改它必须同步改 `lib/switch-routes.js` 的 STATE_PATH。 */
  var STATE_PATH = '/.dsh-pipeline/state'

  /** 挂载的槽位名。 */
  var SLOT = 'conversation.session.header.utilities'

  /** 「多AI 协调」开关的条目 id 与排序权重（越大越靠右）。面板用下面的 PANEL_*，两者并排。 */
  var ENTRY_ID = 'pipeline-coordination-toggle'
  var ENTRY_ORDER = 100

  /** 状态轮询周期（毫秒）。宿主那边的开关也可能被 `pipeline_switch` 工具翻，所以要轮询。 */
  var POLL_MS = 8000

  // =========================================================================
  // 状态存取
  // =========================================================================

  /**
   * 读宿主开关状态。
   * @returns {Promise<{ok:boolean, on?:boolean, version?:string, error?:string}>}
   */
  function fetchState(signal) {
    return fetch(STATE_PATH, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: signal,
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok || body === null || typeof body !== 'object') {
          return { ok: false, error: 'HTTP ' + res.status }
        }
        return body
      })
    })
  }

  /**
   * 写宿主开关状态。
   * @param {boolean|null} on - true/false 显式设定；null = 翻转
   */
  function postState(on) {
    var payload = on === null || on === undefined ? {} : { on: on === true }
    return fetch(STATE_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok || body === null || typeof body !== 'object') {
          return { ok: false, error: 'HTTP ' + res.status }
        }
        return body
      })
    })
  }

  // =========================================================================
  // 组件
  // =========================================================================

  /** 三种视觉状态：开 / 关 / 未知。颜色用的是语义色，不跟随主题变量，避免依赖内部 CSS。 */
  var PALETTE = {
    on: { dot: '#2ea043', border: 'rgba(46,160,67,.55)', bg: 'rgba(46,160,67,.12)', fg: 'inherit' },
    off: { dot: '#8b949e', border: 'rgba(139,148,158,.45)', bg: 'transparent', fg: 'inherit' },
    unknown: { dot: '#d29922', border: 'rgba(210,153,34,.5)', bg: 'rgba(210,153,34,.12)', fg: 'inherit' },
  }

  function paletteFor(mode) {
    return mode === 'on' ? PALETTE.on : mode === 'off' ? PALETTE.off : PALETTE.unknown
  }

  /**
   * 右上角的多 AI 协调开关。
   *
   * 纯内联样式：**不注入任何 CSS**，所以不可能污染或依赖宿主的样式表，
   * 也不可能因为宿主改了 CSS module 的类名而失效。
   */
  function CoordinationToggle(props) {
    var React = props.React

    var stateHook = React.useState({ mode: 'unknown', version: '', error: '' })
    var state = stateHook[0]
    var setState = stateHook[1]

    var busyHook = React.useState(false)
    var busy = busyHook[0]
    var setBusy = busyHook[1]

    var aliveRef = React.useRef(true)

    React.useEffect(function () {
      aliveRef.current = true
      var controller = typeof AbortController === 'function' ? new AbortController() : null

      var pull = function () {
        fetchState(controller === null ? undefined : controller.signal)
          .then(function (body) {
            if (!aliveRef.current) return
            if (body.ok === true) {
              setState({ mode: body.on === true ? 'on' : 'off', version: body.version || '', error: '' })
            } else {
              setState(function (prev) {
                return { mode: 'unknown', version: prev.version, error: body.error || '读取失败' }
              })
            }
          })
          .catch(function (err) {
            if (!aliveRef.current) return
            if (err && err.name === 'AbortError') return
            setState({ mode: 'unknown', version: '', error: String((err && err.message) || err) })
          })
      }

      pull()
      var timer = setInterval(function () {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        pull()
      }, POLL_MS)

      return function () {
        aliveRef.current = false
        clearInterval(timer)
        if (controller !== null) controller.abort()
      }
      // 只挂一次：轮询句柄与 abort 都在闭包里
    }, [])

    var onClick = React.useCallback(
      function () {
        if (busy) return
        setBusy(true)
        // 乐观切换：先按"反面"显示，回包再校正。失败会落到 unknown。
        var wanted = state.mode === 'on' ? false : true
        postState(wanted)
          .then(function (body) {
            if (!aliveRef.current) return
            if (body.ok === true) setState({ mode: body.on === true ? 'on' : 'off', version: body.version || '', error: '' })
            else setState({ mode: 'unknown', version: '', error: body.error || '写入失败' })
          })
          .catch(function (err) {
            if (!aliveRef.current) return
            setState({ mode: 'unknown', version: '', error: String((err && err.message) || err) })
          })
          .then(function () {
            if (aliveRef.current) setBusy(false)
          })
      },
      [busy, state.mode],
    )

    var pal = paletteFor(state.mode)
    var label = state.mode === 'on' ? '开' : state.mode === 'off' ? '关' : '?'
    var title =
      '多 AI 协调功能：' +
      (state.mode === 'on' ? '已开启' : state.mode === 'off' ? '已关闭' : '状态未知') +
      '\n\n' +
      '开 = 多对话协作流水线生效：编排（角色清单 / 调用顺序）+ 守门（越权拦截）+ 状态机全都管。\n' +
      '关 = 关闭该功能，回到普通 DSH 行为：本插件不再拦任何调用、不再往任何会话注入消息\n' +
      '（拦截缝四条全直通、唤醒不投递、巡检与孤儿单自恢复停表），\n' +
      '但流水线的写入动作仍会被拒绝（查询仍可用）。\n\n' +
      '点一下切换，立即生效，不需要重启。' +
      (state.error ? '\n\n最近一次通信失败：' + state.error : '')

    return React.createElement(
      'button',
      {
        type: 'button',
        onClick: onClick,
        disabled: busy,
        title: title,
        'aria-label': '多 AI 协调功能：' + (state.mode === 'on' ? '开' : state.mode === 'off' ? '关' : '未知'),
        'aria-pressed': state.mode === 'on',
        'data-pipeline-toggle': state.mode,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          height: '26px',
          padding: '0 10px',
          margin: '0 2px',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '1',
          color: pal.fg,
          background: pal.bg,
          border: '1px solid ' + pal.border,
          borderRadius: '999px',
          cursor: busy ? 'progress' : 'pointer',
          opacity: busy ? 0.6 : 1,
          whiteSpace: 'nowrap',
          userSelect: 'none',
          // 头部是 Electron 的窗口拖拽区（ConversationHeader 上有 data-window-drag）。
          // 不写这一行，按钮上的点击会被当成拖窗口。
          WebkitAppRegion: 'no-drag',
        },
      },
      React.createElement('span', {
        'aria-hidden': 'true',
        style: {
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          background: pal.dot,
          flex: '0 0 auto',
        },
      }),
      React.createElement('span', null, '多AI 协调'),
      React.createElement('span', { style: { opacity: 0.75 } }, label),
    )
  }

  // =========================================================================
  // 多AI协调团队面板（与上面的开关**并排**，不替换它）
  // =========================================================================

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
   * 面板条目的 id 与排序权重。
   * 开关是 100，这里给 110 ⇒ 排在它**右边一格**（order 越大越靠右），谁也不顶掉谁。
   */
  var PANEL_ENTRY_ID = 'pipeline-panel'
  var PANEL_ENTRY_ORDER = 110

  /** 面板轮询周期。席位状态变得比开关勤，所以比开关的 8s 快。 */
  var PANEL_POLL_MS = 5000

  // =========================================================================
  // 面板的两个交互面：任务卡操作按钮 + 席位会话预览
  // =========================================================================

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

  /** 悬停多久才弹会话预览 —— 太短会在扫过一排 chip 时闪出一堆浮层。 */
  var PREVIEW_SHOW_MS = 400

  /** 指针离开后多久收起 —— 留出"移进预览层"的时间（移入会取消这个计时）。 */
  var PREVIEW_HIDE_MS = 250

  /** 预览里最多显示几条消息（取最后这么多条）。 */
  var PREVIEW_MAX_ROWS = 12

  /** 单条消息最多截多少字（空白先压成一个空格；超出加省略号）。 */
  var PREVIEW_MAX_CHARS = 120

  /** 同一会话的预览快照缓存多久：30 秒内不重复 `retain`。 */
  var PREVIEW_CACHE_MS = 30000

  /** 最多同时保留几个会话引用（超了释放最老的 —— 连点一排 chip 也不会把引用堆满）。 */
  var PREVIEW_MAX_RETAINED = 3

  /** 会话历史读取的兜底超时：`ready` 迟迟不结算时不让预览层永远转圈。 */
  var PREVIEW_LOAD_TIMEOUT_MS = 6000

  /** 预览层尺寸：小窗口看聊天（宽度自适应视口，宽一点才像聊天窗；高度上限 280px）。 */
  var PREVIEW_MIN_WIDTH = 300
  var PREVIEW_MAX_WIDTH = 420
  var PREVIEW_MAX_HEIGHT = 280

  /** 三种消息在预览里的标签与颜色（用户 / AI / 工具）。 */
  var PREVIEW_ROLE = {
    'user/message': { label: '用户', color: '#2f81f7' },
    'assistant/message': { label: 'AI', color: '#2ea043' },
    'tool/result': { label: '工具', color: '#d29922' },
  }

  /**
   * 角色 id → 中文名（**只在 `role_label` 缺失时兜底**）。
   * 叫法与 `lib/roles.js` 里那份 `zh` 一致，不另造词。
   */
  var ROLE_LABELS = {
    main: '主对话',
    orchestrator: '需求分析',
    planner: '计划',
    supervisor: '主管',
    architect: '架构',
    security: '安全',
    writer: '编写',
    tester: '测试',
    reviewer: '审核',
    archivist: '留档',
    diagrammer: '架构图',
    release: '发布',
    docs: '文档',
    performance: '性能',
    arbiter: '仲裁',
    human: '人工',
  }

  /** 席位状态 → 圆点色 + 中文短文案（面板只认契约里这三档）。 */
  var SEAT_STATUS = {
    current: { dot: '#2f81f7', label: '当前' },
    dispatched: { dot: '#2ea043', label: '进行中' },
    declared: { dot: '#8b949e', label: '待机' },
  }

  /** 认不出的状态时的兜底色（宁可显示"未知"，也不假装正常）。 */
  var SEAT_STATUS_UNKNOWN = { dot: '#d29922', label: '未知' }

  /** 任务状态徽标的色调：完成=绿、阻塞/取消=黄、其余=蓝。认不出就当蓝。 */
  function stateTone(state) {
    var key = typeof state === 'string' ? state : ''
    if (key === 'done' || key === 'closed' || key === 'completed' || key === 'verified') {
      return { fg: '#2ea043', border: 'rgba(46,160,67,.5)', bg: 'rgba(46,160,67,.12)' }
    }
    if (key === 'blocked' || key === 'cancelled' || key === 'canceled') {
      return { fg: '#d29922', border: 'rgba(210,153,34,.5)', bg: 'rgba(210,153,34,.12)' }
    }
    return { fg: '#2f81f7', border: 'rgba(47,129,247,.5)', bg: 'rgba(47,129,247,.12)' }
  }

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

  /**
   * 取客户端 `sessions` 服务（拿不到返回 null，预览层降级成一行灰字）。
   *
   * 为什么用 `ctx.get('sessions')` 而不是把 `sessions` 写进模块的 `inject` 导出：
   *   ① `tests/client-check.mjs` 的 B2 对 `inject` 做了硬断言（只有 `['slots']`）—— 加一项就红；
   *   ② 写进 inject 的语义是"服务不到就不启动插件"，那会连右上角那个开关一起消失；
   *   ③ 与 `resolveUiWorkspace` **完全同一套写法**（已装的 `dsh-orb` 也是这么取服务的）。
   */
  function resolveSessions(ctx) {
    if (ctx === null || ctx === undefined) return null
    if (typeof ctx.get === 'function') {
      try {
        var viaGet = ctx.get('sessions')
        if (viaGet !== null && viaGet !== undefined && typeof viaGet.retain === 'function') return viaGet
      } catch (err) {
        // 没装 / 还没就绪不算错误，走下一档
      }
    }
    var direct = ctx.sessions
    if (direct !== null && direct !== undefined && typeof direct.retain === 'function') return direct
    return null
  }

  /**
   * 释放一个会话引用：`release()` 与 `[Symbol.dispose]` 两档都认。
   * 释放失败**不抛** —— 一个预览的清理失败不该让面板炸。
   */
  function releaseSessionRef(ref) {
    if (ref === null || ref === undefined) return
    try {
      if (typeof ref.release === 'function') {
        ref.release()
        return
      }
    } catch (err) {
      return
    }
    try {
      if (typeof Symbol !== 'undefined' && Symbol.dispose !== undefined) {
        var dispose = ref[Symbol.dispose]
        if (typeof dispose === 'function') dispose.call(ref)
      }
    } catch (err) {
      // 忽略：引用是幂等释放的，这里只是兜底
    }
  }

  /**
   * 一个 content 块（或块数组）→ 纯文本。
   *
   * 只认 `type === 'text'` 的块：思考块、工具调用块都不该出现在预览里。
   * 工具结果的正文常常裹在 `{ type:'tool_result', content:[…] }` 里，所以往下钻一层
   * （深度上限 2，避免异常数据把这里变成递归地雷）。
   */
  function textOfContent(content, depth) {
    if (typeof content === 'string') return content
    if (!Array.isArray(content) || depth > 2) return ''
    var parts = []
    for (var i = 0; i < content.length; i++) {
      var block = content[i]
      if (typeof block === 'string') {
        parts.push(block)
        continue
      }
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
        continue
      }
      if (typeof block.text === 'string' && block.type !== 'thinking') {
        parts.push(block.text)
        continue
      }
      var inner = textOfContent(block.content, depth + 1)
      if (inner !== '') parts.push(inner)
    }
    return parts.join(' ')
  }

  /** 压空白 + 截断：预览里一条消息只占一行，太长的正文只留开头。 */
  function previewText(raw) {
    if (typeof raw !== 'string') return ''
    var flat = raw.replace(/\s+/g, ' ').trim()
    if (flat === '') return ''
    if (flat.length <= PREVIEW_MAX_CHARS) return flat
    return flat.slice(0, PREVIEW_MAX_CHARS) + '…'
  }

  /**
   * 事件窗口 → 预览行（取最后 {@link PREVIEW_MAX_ROWS} 条）。
   *
   * 只认 `entry.type === 'event'`（`transient` 是流式过程中的临时行，不代表已入档内容），
   * 事件类型限于 `user/message` / `assistant/message` / `tool/result`。
   *
   * ★ 正文在 `event.data` 里的位置**两种都有**（照真实 API 写，不靠猜：
   *   `@deepseek-ai/dsh-session/lib/types/surface.js` 的 `deriveEventMessage`）：
   *   · `user/message` 的 message 就是 `data` 本身（那里 `case 'user/message': return event.data`）；
   *   · `assistant/message` / `tool/result` 是 `data.message`。
   *   所以先取 `data.message`，没有就退回 `data` —— 两种都能取到正文。
   */
  function previewRowsFromEntries(entries) {
    var rows = []
    if (!Array.isArray(entries)) return rows
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      if (entry === null || typeof entry !== 'object' || entry.type !== 'event') continue
      var event = entry.event
      if (event === null || typeof event !== 'object') continue
      var role = PREVIEW_ROLE[event.type]
      if (role === undefined) continue
      var data = event.data
      if (data === null || typeof data !== 'object') continue
      var message = data.message !== null && typeof data.message === 'object' ? data.message : data
      var text = previewText(textOfContent(message.content, 0))
      if (text === '') {
        // 工具结果没正文也照样占一行（用户要看到"这里跑过一次工具"）；
        // assistant 的空文本（max-tokens 截断那种）直接跳过。
        if (event.type !== 'tool/result') continue
        text = '[工具结果]'
      }
      rows.push({ type: event.type, role: role.label, color: role.color, text: text })
    }
    return rows.length > PREVIEW_MAX_ROWS ? rows.slice(rows.length - PREVIEW_MAX_ROWS) : rows
  }

  /**
   * 读一个会话最近的事件窗口 → 预览行。
   *
   * 取数路径（与 `@deepseek-ai/dsh-api-session-controller` 的实现/README 一致）：
   *   ① `sessions.retain(sessionId, { source:'gateway' })` → 引用（同步，可能抛）；
   *   ② 引用上 `ready` 结算成**确切 binding**（`ClientSessionReference.ready` 的定义），
   *      拿不到就退回同步的 `ref.binding`；binding 上是 `binding.eventSource`；
   *   ③ `eventSource.getSnapshot()` 是 `ObservableSnapshot<SessionEventWindow>`，
   *      `.entries` 就是事件窗口；
   *   ④ 读到文本后**立刻释放**引用（预览只要几行字，不需要一直占着历史流）。
   *
   * 任一步失败都 reject —— 调用方把预览层降级成一行灰字（不假装有内容）。
   *
   * @param {object} ctx - 客户端 cordis 上下文（用来 `ctx.get('sessions')`）
   * @param {string} sessionId
   * @param {{rows:object, retained:Array}} cache - 面板实例的缓存（管"最多同时保留几个"）
   * @returns {Promise<Array<{type:string, role:string, color:string, text:string}>>}
   */
  function loadSessionPreviewRows(ctx, sessionId, cache) {
    return new Promise(function (resolve, reject) {
      var sessions = resolveSessions(ctx)
      if (sessions === null) {
        reject(new Error('客户端没有提供 sessions 服务'))
        return
      }
      var ref = null
      try {
        ref = sessions.retain(sessionId, { source: 'gateway' })
      } catch (err) {
        reject(err)
        return
      }
      if (ref === null || typeof ref !== 'object') {
        reject(new Error('sessions.retain 没有返回引用'))
        return
      }
      var retained = cache !== null && cache !== undefined && Array.isArray(cache.retained) ? cache.retained : null
      if (retained !== null) {
        // 最多同时保留 3 个：超了先把最老的放掉
        while (retained.length >= PREVIEW_MAX_RETAINED) releaseSessionRef(retained.shift())
        retained.push(ref)
      }
      var settled = false
      var timer = null
      var finish = function (fn, value) {
        if (settled) return
        settled = true
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (retained !== null) {
          var at = retained.indexOf(ref)
          if (at !== -1) retained.splice(at, 1)
        }
        releaseSessionRef(ref)
        fn(value)
      }
      timer = setTimeout(function () {
        finish(reject, new Error('会话历史读取超时'))
      }, PREVIEW_LOAD_TIMEOUT_MS)
      var readyP = null
      try {
        readyP = ref.ready !== null && ref.ready !== undefined && typeof ref.ready.then === 'function' ? ref.ready : null
      } catch (err) {
        readyP = null
      }
      Promise.resolve(readyP).then(
        function (value) {
          var binding = null
          try {
            binding = value !== null && typeof value === 'object' && value.eventSource !== undefined ? value : ref.binding
          } catch (err) {
            finish(reject, err)
            return
          }
          var source = binding !== null && typeof binding === 'object' ? binding.eventSource : undefined
          if (source === null || source === undefined || typeof source.getSnapshot !== 'function') {
            finish(reject, new Error('会话事件流不可用'))
            return
          }
          var rows = []
          try {
            var snapshot = source.getSnapshot()
            rows = previewRowsFromEntries(snapshot !== null && typeof snapshot === 'object' ? snapshot.entries : null)
          } catch (err) {
            finish(reject, err)
            return
          }
          finish(resolve, rows)
        },
        function (err) {
          finish(reject, err)
        },
      )
    })
  }

  /**
   * 预览浮层的落点：按 chip 的 `getBoundingClientRect()` 算，视口内自动左右/上下收边。
   *
   * 返回 `{ left, width, top? , bottom? }`：给 `top` 就是挂在 chip 下面，
   * 给 `bottom` 就是翻到上面去（用 `bottom` 定位不必先知道自身高度）。
   */
  function previewBoxFor(el) {
    var vw =
      typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth > 0 ? window.innerWidth : 1024
    var vh =
      typeof window !== 'undefined' && typeof window.innerHeight === 'number' && window.innerHeight > 0 ? window.innerHeight : 768
    var rect = null
    try {
      rect = el !== null && el !== undefined && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
    } catch (err) {
      rect = null
    }
    var anchorLeft = rect === null ? vw / 2 : rect.left + rect.width / 2
    var anchorTop = rect === null ? vh / 2 : rect.top
    var anchorBottom = rect === null ? vh / 2 : rect.bottom
    var width = Math.max(PREVIEW_MIN_WIDTH, Math.min(PREVIEW_MAX_WIDTH, vw - 16))
    var left = Math.round(anchorLeft - width / 2)
    if (left + width > vw - 8) left = vw - 8 - width
    if (left < 8) left = 8
    var below = Math.round(anchorBottom + 6)
    // 只用来判断"下面还放不放得下"：标题 + 内边距 + 内容上限。
    var estimate = PREVIEW_MAX_HEIGHT + 46
    var above = below + estimate > vh - 8 && anchorTop - 6 - estimate > 8
    if (above) return { left: left, width: width, bottom: Math.round(vh - anchorTop + 6) }
    return { left: left, width: width, top: below }
  }

  /**
   * 从槽 props 里取**当前会话 id**。
   *
   * 依据（读源码得来，不是猜）：官方面板 `TeamAction({ sessionId })` 直接吃槽 props 的
   * `sessionId`（`dsh-experimental-client-ui-agent-team/lib/client.js:223`，注册处 `:491-497`），
   * 本槽与它同为会话作用域；已装的 `dsh-drawai`（`lib/client.js:6097`）与
   * `better-dsh-session-deletetool`（`client.js:312`）同样在槽组件里读 `props.sessionId`。
   * 后面两档只是兜底；一个都取不到就返回 null，面板会把它变成人话错误，而不是崩。
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
   * 取 `uiWorkspace` 服务（拿不到就返回 null，面板显示人话错误）。
   *
   * 为什么用 `ctx.get` 而不是把 `uiWorkspace` 写进模块的 `inject` 导出：
   *   ① 本插件现有的 `inject` 只有 `slots`，而 `tests/client-check.mjs` 的 B2 对它做了
   *      硬断言（`inject.length === 1 && inject[0] === 'slots'`）—— 加一项就红；
   *   ② 写进 inject 的语义是"服务不到就不启动插件"，那会连现在这个开关一起消失；
   *   ③ 已装的 `dsh-orb`（`client.js:893`）与 `better-dsh-session-deletetool` 都是这个套路：
   *      `package.json` 的 `dsh.client.inject` 保证模块被加载，运行时用 `ctx.get` 取服务。
   *      （`dsh.client.inject` 已经加了 `@deepseek-ai/dsh-client-ui-workspace`。）
   */
  function resolveUiWorkspace(ctx) {
    if (ctx === null || ctx === undefined) return null
    if (typeof ctx.get === 'function') {
      try {
        var viaGet = ctx.get('uiWorkspace')
        if (viaGet !== null && viaGet !== undefined && typeof viaGet.openSession === 'function') return viaGet
      } catch (err) {
        // 没装/没就绪不算错误，走下一档
      }
    }
    var direct = ctx.uiWorkspace
    if (direct !== null && direct !== undefined && typeof direct.openSession === 'function') return direct
    return null
  }

  /**
   * 从 `seat.seat` 取席位号。
   * 契约里是数字（main 为 null）；也认 `writer#2` / `p-xxx-writer-2` 这类写法 ——
   * 只取**末尾数字**，原始 id 一律不显示（用户要看的是「2号席」，不是 `p-xxx-writer-2`）。
   */
  function seatNumberOf(seat) {
    var raw = seat === null || seat === undefined ? null : seat.seat
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string') {
      var hit = /(\d+)\s*$/.exec(raw)
      if (hit !== null) return Number(hit[1])
    }
    return null
  }

  /** 席位的中文名：先 `role_label`，再兜底表；有席位号就拼成「编写 · 1号席」。 */
  function seatName(seat) {
    var label = '席位'
    if (typeof seat.role_label === 'string' && seat.role_label !== '') label = seat.role_label
    else if (typeof seat.role === 'string' && ROLE_LABELS[seat.role] !== undefined) label = ROLE_LABELS[seat.role]
    var n = seatNumberOf(seat)
    return n === null ? label : label + ' · ' + n + '号席'
  }

  /**
   * 一条席位 chip 的完整判断（渲染与自检共用同一份 —— 免得"看起来禁用其实能点"）。
   * 原始 id 只进 tooltip，不进可见文字。
   */
  function seatChipInfo(seat, currentSessionId) {
    var status =
      typeof seat.status === 'string' && SEAT_STATUS[seat.status] !== undefined ? SEAT_STATUS[seat.status] : SEAT_STATUS_UNKNOWN
    var isCurrent = seat.status === 'current'
    var sessionId = typeof seat.session_id === 'string' ? seat.session_id : ''
    var openable = !isCurrent && sessionId !== ''
    var name = seatName(seat)
    var tips = []
    if (isCurrent) tips.push('这是你当前所在的对话，不需要再打开')
    else if (sessionId === '') tips.push('这个席位还没有会话 id，暂时打不开')
    if (openable) tips.push('点击打开「' + name + '」的对话')
    if (sessionId !== '') {
      tips.push((currentSessionId !== null && sessionId === currentSessionId ? '当前会话 id：' : '会话 id：') + sessionId)
    }
    if (typeof seat.role === 'string' && seat.role !== '') {
      tips.push('角色 id：' + seat.role + '（kind：' + (typeof seat.kind === 'string' ? seat.kind : '未知') + '）')
    }
    return { status: status, isCurrent: isCurrent, sessionId: sessionId, openable: openable, name: name, tip: tips.join('\n') }
  }

  /** 一个席位 chip：状态圆点 + 中文名（+ 状态/「当前对话」）。禁用态用不动点手势 + tooltip 说明。 */
  function renderSeatChip(React, seat, opts) {
    var info = seatChipInfo(seat, opts.currentSessionId)
    var parts = [
      React.createElement('span', {
        key: 'dot',
        'aria-hidden': 'true',
        style: { width: '7px', height: '7px', borderRadius: '50%', background: info.status.dot, flex: '0 0 auto' },
      }),
      React.createElement('span', { key: 'name', style: { whiteSpace: 'nowrap' } }, info.name),
    ]
    if (info.isCurrent) {
      parts.push(
        React.createElement(
          'span',
          {
            key: 'tag',
            style: {
              flex: '0 0 auto',
              fontSize: '9.5px',
              lineHeight: '14px',
              padding: '0 5px',
              borderRadius: '999px',
              color: 'var(--dsw-alias-brand-primary, #1f6feb)',
              background: 'rgba(47,129,247,.16)',
              border: '1px solid rgba(47,129,247,.45)',
              whiteSpace: 'nowrap',
            },
          },
          '当前对话',
        ),
      )
    } else {
      parts.push(React.createElement('span', { key: 'st', style: { fontSize: '10px', opacity: 0.72, whiteSpace: 'nowrap' } }, info.status.label))
    }
    // 外面这层 span 只为把 title 挂在**禁用按钮之外**：<button disabled> 在多数浏览器里
    // 不派发鼠标事件，直接挂 title 用户看不到提示。悬停预览挂在这里也是同一个理由 ——
    // 「当前对话」那一格按钮是禁用的，可它恰恰是最想看历史的一格。
    var outerProps = { key: opts.key, title: info.tip, style: { display: 'inline-flex', maxWidth: '100%' } }
    if (typeof opts.onPreviewEnter === 'function') {
      outerProps.onMouseEnter = function (ev) {
        var el = ev !== null && ev !== undefined ? ev.currentTarget : null
        opts.onPreviewEnter(seat, el)
      }
      outerProps.onMouseLeave = function () {
        opts.onPreviewLeave(seat)
      }
    }
    return React.createElement(
      'span',
      outerProps,
      React.createElement(
        'button',
        {
          type: 'button',
          disabled: !info.openable,
          'aria-disabled': !info.openable,
          'data-pipeline-seat': (typeof seat.role === 'string' ? seat.role : '') + (info.isCurrent ? ':current' : ''),
          onClick: function () {
            if (!info.openable) return
            opts.onOpen(seat)
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            height: '22px',
            maxWidth: '100%',
            padding: '0 8px',
            font: 'inherit',
            fontSize: '11.5px',
            lineHeight: '1',
            color: info.isCurrent ? 'var(--dsw-alias-brand-primary, #1f6feb)' : 'inherit',
            background: info.isCurrent ? 'rgba(47,129,247,.12)' : 'transparent',
            border: '1px solid ' + (info.isCurrent ? 'rgba(47,129,247,.55)' : 'var(--dsw-alias-border-l2, rgba(127,127,127,.35))'),
            borderRadius: '999px',
            // 「周围一圈」= ring。官方面板用的是 elevation 描边 + 淡底；这里同样只用阴影，
            // 不占布局（border 会挤内容、outline 会跟焦点环打架）。
            boxShadow: info.isCurrent ? '0 0 0 2px rgba(47,129,247,.32)' : 'none',
            cursor: info.openable ? 'pointer' : 'not-allowed',
            opacity: info.isCurrent || info.openable ? 1 : 0.65,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            userSelect: 'none',
            WebkitAppRegion: 'no-drag',
          },
        },
        parts,
      ),
    )
  }

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

  /**
   * 一个操作按钮（任务卡与归档卡**共用**）。
   *
   * busy / 确认态 / 危险红一律由调用方算好传进来 —— 这里只负责长相与点击，
   * 所以可以被自测当成纯函数调用。
   */
  function renderActionButton(React, spec) {
    var busy = spec.busy === true
    var armed = spec.armed === true
    var danger = spec.danger === true
    return React.createElement(
      'button',
      {
        key: spec.action,
        type: 'button',
        disabled: busy,
        'aria-busy': busy,
        'data-pipeline-action': spec.action,
        'data-pipeline-action-state': busy ? 'busy' : armed ? 'armed' : 'idle',
        title: busy ? '正在等宿主回话…' : armed ? spec.armedTip : spec.tip,
        onClick: spec.onClick,
        // 移开就连确认态一起复原（不必等满 3 秒）
        onMouseLeave: armed && typeof spec.onBlur === 'function' ? spec.onBlur : undefined,
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
          cursor: busy ? 'progress' : 'pointer',
          opacity: busy ? 0.6 : 1,
          whiteSpace: 'nowrap',
          userSelect: 'none',
          // 卡片也在头部拖拽区里（与 chip 同理）
          WebkitAppRegion: 'no-drag',
        },
      },
      busy ? '处理中…' : armed ? spec.armedLabel : spec.label,
    )
  }

  /**
   * 任务卡底部那一行**操作按钮**（右对齐）。
   *
   * 按钮完全由 `task.allowed_actions` 决定（快照是唯一判据，这里不猜状态）：
   *   · 字段缺失 / 不是数组 / 空数组 ⇒ 一行都不渲染（老版本宿主没有这个字段）；
   *   · 认不出的动作 ⇒ 跳过（宁可少一个按钮，也不给一个点了没反应的）；
   *   · 可见顺序固定 `cancel → restore → archive → delete`；
   *   · **批量模式下整行让位**（那时点整张卡 = 选中，两种点击不该打架）。
   *
   * busy / 删单确认态由面板统一持有后经 `opts` 传进来 —— 这里**不碰状态**，
   * 所以可以被自测当成纯函数调用。
   */
  function renderTaskActions(React, task, opts) {
    if (opts.batch === true) return null
    var taskId = typeof task.id === 'string' ? task.id : ''
    if (taskId === '') return null
    var allowed = Array.isArray(task.allowed_actions) ? task.allowed_actions : []
    if (allowed.length === 0) return null
    var onAction = typeof opts.onAction === 'function' ? opts.onAction : null
    if (onAction === null) return null
    var onActionBlur = typeof opts.onActionBlur === 'function' ? opts.onActionBlur : function () {}
    var clickOf = function (actionId) {
      return function () {
        onAction(taskId, actionId)
      }
    }
    // 参数化再返回闭包（别让循环变量 `action` 被闭包按引用捕走）
    var blurOf = function (actionId) {
      return function () {
        onActionBlur(taskId, actionId)
      }
    }
    var buttons = []
    for (var i = 0; i < PANEL_ACTION_ORDER.length; i++) {
      var action = PANEL_ACTION_ORDER[i]
      if (allowed.indexOf(action) === -1) continue
      var meta = PANEL_ACTION_META[action]
      var key = actionKeyOf(taskId, action)
      buttons.push(
        renderActionButton(React, {
          action: action,
          label: meta.label,
          tip: meta.tip,
          armedLabel: DELETE_CONFIRM_LABEL,
          armedTip: DELETE_ARMED_TIP,
          danger: action === 'delete',
          busy: opts.busyKey === key,
          armed: opts.armedKey === key,
          onClick: clickOf(action),
          onBlur: blurOf(action),
        }),
      )
    }
    if (buttons.length === 0) return null
    return React.createElement(
      'div',
      {
        'data-pipeline-actions': taskId,
        style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '5px', marginTop: '7px', minWidth: 0 },
      },
      buttons,
    )
  }

  // =========================================================================
  // 分区 · 置顶（📌）
  // =========================================================================

  /**
   * 标题行右侧那颗**钉子**：点一下钉住 / 再点取消。
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
          // 批量模式下整卡是"选中"，这里虽然不渲染，仍然挡住冒泡（防御性）
          if (ev !== null && ev !== undefined && typeof ev.stopPropagation === 'function') ev.stopPropagation()
          onPin(taskId, pinned)
        },
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

  // =========================================================================
  // 分区 · 批量管理（仿 QQ 多选面板）
  // =========================================================================

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

  /**
   * 面板内边距（px）。**批量栏的负边距靠这两个数把它抵掉**，所以面板本体与
   * `renderBatchBar` 必须用同一对常量 —— 否则那条底栏会缩在 padding 里，看着不像通栏。
   */
  var PANEL_PAD_X = 12
  var PANEL_PAD_BOTTOM = 12

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

  // -------------------------------------------------------------------------
  // 卡片里的小零件（任务卡与归档卡共用，免得两处各画一遍）
  // -------------------------------------------------------------------------

  /** `[pipeline]` 那个小标签。 */
  function renderPipelineTag(React) {
    return React.createElement(
      'span',
      {
        key: 'pipelineTag',
        style: {
          flex: '0 0 auto',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: '9.5px',
          lineHeight: '15px',
          padding: '0 4px',
          borderRadius: '4px',
          color: 'var(--dsw-alias-label-caption, rgba(127,127,127,.95))',
          background: 'rgba(127,127,127,.16)',
        },
      },
      '[pipeline]',
    )
  }

  /** 状态徽标（颜色由 `stateTone` 定）。 */
  function renderStateBadge(React, state, label) {
    var tone = stateTone(state)
    return React.createElement(
      'span',
      {
        key: 'state',
        style: {
          flex: '0 0 auto',
          fontSize: '10.5px',
          lineHeight: '16px',
          padding: '0 6px',
          borderRadius: '999px',
          color: tone.fg,
          border: '1px solid ' + tone.border,
          background: tone.bg,
          whiteSpace: 'nowrap',
        },
      },
      label,
    )
  }

  /** 任务 id / 归档目录名那一格（等宽、超长省略；全文与目录名都进 title）。 */
  function renderIdLabel(React, text, title) {
    var tip = typeof title === 'string' && title !== '' ? title : text
    return React.createElement(
      'span',
      {
        key: 'id',
        title: tip,
        style: {
          flex: '1 1 auto',
          minWidth: 0,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: '11.5px',
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
      },
      text,
    )
  }

  /** 需求摘要（两行截断，title 里看全文）。 */
  function renderSnippet(React, snippet) {
    if (typeof snippet !== 'string' || snippet === '') return null
    return React.createElement(
      'p',
      {
        key: 'snippet',
        title: snippet,
        style: {
          margin: '5px 0 0',
          fontSize: '11.5px',
          lineHeight: '1.5',
          color: 'var(--dsw-alias-label-secondary, rgba(110,118,129,1))',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        },
      },
      snippet,
    )
  }

  /**
   * **可选中卡壳**（任务卡 / 归档卡共用同一个外壳）。
   *
   * 批量模式下：整卡 `role=checkbox`、点击（或空格/回车）= 切换选中、选中时整卡淡蓝高亮；
   * 卡内正文统一 `pointerEvents:none` —— 点 chip / 按钮不会"穿透"成打开会话或单个操作，
   * 点哪儿都是"选中"。普通模式下这些一样都不加，两张卡各自保持原来那套点击行为。
   */
  function renderSelectableCard(React, opts) {
    var batch = opts.batch === true
    var selected = batch && opts.selected === true
    var toggle = function () {
      if (typeof opts.onToggleSelect === 'function') opts.onToggleSelect(opts.id)
    }
    var props = {
      key: opts.key,
      style: {
        marginTop: '8px',
        padding: '8px 10px 9px',
        border: '1px solid ' + (selected ? 'rgba(47,129,247,.55)' : 'var(--dsw-alias-border-l1, rgba(127,127,127,.26))'),
        borderRadius: '10px',
        background: selected ? 'rgba(47,129,247,.10)' : 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06))',
        cursor: batch ? 'pointer' : 'default',
        transition: 'background .12s ease, border-color .12s ease',
      },
    }
    // 调用方给的 data-* 钩子（`data-pipeline-task` / `data-pipeline-archive-card` …）
    var attrs = opts.attrs
    if (attrs !== null && attrs !== undefined) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) props[k] = attrs[k]
      }
    }
    if (batch) {
      props.role = 'checkbox'
      props.tabIndex = 0
      props['aria-checked'] = selected
      props.onClick = toggle
      props.onKeyDown = function (ev) {
        if (ev === null || ev === undefined) return
        if (ev.key !== ' ' && ev.key !== 'Enter') return
        if (typeof ev.preventDefault === 'function') ev.preventDefault()
        toggle()
      }
    }
    return React.createElement(
      'article',
      props,
      React.createElement('div', { key: 'inner', style: { pointerEvents: batch ? 'none' : undefined } }, opts.children),
    )
  }

  /**
   * 一张任务卡：`[pipeline]` + 任务 id（置顶时挂 📌）+ 状态徽标 + 需求摘要（两行截断）+ 席位 chips。
   *
   * 两种模式：
   *   · 普通模式：标题行右侧是**置顶**按钮，右下角是单卡操作按钮；
   *   · **批量模式**（`opts.batch`）：左侧多一个圆勾、点整卡 = 切换选中、单卡按钮全部让位。
   */
  function renderTaskCard(React, task, opts) {
    var taskId = typeof task.id === 'string' && task.id !== '' ? task.id : '(无 id)'
    var batch = opts.batch === true
    var selected = batch && opts.selected === true
    var stateLabel =
      typeof task.state_label === 'string' && task.state_label !== ''
        ? task.state_label
        : typeof task.state === 'string' && task.state !== ''
          ? task.state
          : '未知状态'
    var snippet = typeof task.requirement_snippet === 'string' ? task.requirement_snippet : ''
    var seats = Array.isArray(task.seats) ? task.seats : []

    var head = []
    if (batch) head.push(renderBatchCheckbox(React, selected))
    head.push(renderPipelineTag(React))
    head.push(renderIdLabel(React, taskId))
    head.push(renderPinMark(React, task))
    head.push(renderStateBadge(React, task.state, stateLabel))
    head.push(renderPinButton(React, task, opts)) // 批量模式下它自己返回 null

    var body = []
    body.push(React.createElement('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } }, head))
    body.push(renderSnippet(React, snippet))
    body.push(
      React.createElement(
        'div',
        { key: 'seats', style: { display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '7px', minWidth: 0 } },
        seats.length === 0
          ? React.createElement('span', { style: { fontSize: '11px', opacity: 0.7 } }, '这个任务还没有席位')
          : seats.map(function (seat, i) {
              var safe = seat !== null && typeof seat === 'object' ? seat : {}
              return renderSeatChip(React, safe, {
                key: (typeof safe.role === 'string' ? safe.role : 'seat') + '#' + i,
                currentSessionId: opts.currentSessionId,
                onOpen: opts.onOpen,
                onPreviewEnter: opts.onPreviewEnter,
                onPreviewLeave: opts.onPreviewLeave,
              })
            }),
      ),
    )
    // 右下角那行小按钮（`allowed_actions` 为空/缺失、或批量模式下返回 null，这一行整体不占位）
    if (!batch) body.push(renderTaskActions(React, task, opts))

    var attrs = { 'data-pipeline-task': taskId, 'data-pipeline-pinned': task.pinned === true ? 'true' : 'false' }
    if (batch) attrs['data-pipeline-batch-selected'] = selected ? 'true' : 'false'
    return renderSelectableCard(React, {
      key: opts.key,
      id: taskId,
      batch: batch,
      selected: selected,
      onToggleSelect: opts.onToggleSelect,
      attrs: attrs,
      children: body,
    })
  }

  // =========================================================================
  // 分区 · 归档视图（查看 / 恢复 / 永久删除已归档的单）
  // =========================================================================

  /**
   * 归档卡底部那行按钮：**恢复** / **永久删除**。
   * 不看 `allowed_actions`：进了归档区就只剩终态单，两个动作都允许（与宿主契约一致）。
   * `dir` 是归档目录名 —— 归档动作的 `task_id` 就是它。
   */
  function renderArchivedActions(React, dir, opts) {
    if (opts.batch === true) return null
    if (dir === '') return null
    var onAction = typeof opts.onAction === 'function' ? opts.onAction : null
    if (onAction === null) return null
    var onActionBlur = typeof opts.onActionBlur === 'function' ? opts.onActionBlur : function () {}
    var buttons = []
    for (var i = 0; i < ARCHIVED_ACTION_ORDER.length; i++) {
      var action = ARCHIVED_ACTION_ORDER[i]
      var meta = ARCHIVED_ACTION_META[action]
      var key = actionKeyOf(dir, action)
      buttons.push(
        renderActionButton(React, {
          action: action,
          label: meta.label,
          tip: meta.tip,
          armedLabel: DELETE_ARCHIVED_CONFIRM_LABEL,
          armedTip: DELETE_ARCHIVED_ARMED_TIP,
          danger: action === 'delete_archived',
          busy: opts.busyKey === key,
          armed: opts.armedKey === key,
          // 参数化再返回闭包（别让循环变量 `action` 被闭包按引用捕走）
          onClick: (function (a) {
            return function () {
              onAction(dir, a)
            }
          })(action),
          onBlur: (function (a) {
            return function () {
              onActionBlur(dir, a)
            }
          })(action),
        }),
      )
    }
    return React.createElement(
      'div',
      {
        'data-pipeline-archive-actions': dir,
        style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '5px', marginTop: '7px', minWidth: 0 },
      },
      buttons,
    )
  }

  /**
   * 一张**归档卡**：`[pipeline]` + 任务 id + 状态徽标 + 需求摘要 + 归档时间 + 「恢复 / 永久删除」。
   *
   * ★ 归档区里的写操作 `task_id` 传的是**归档目录名 `dir`**（宿主契约），不是任务 id ——
   *   所以这张卡上所有回调拿到的都是 `dir`。
   */
  function renderArchivedCard(React, task, opts) {
    var dir = typeof task.dir === 'string' && task.dir !== '' ? task.dir : ''
    var taskId = typeof task.id === 'string' && task.id !== '' ? task.id : ''
    var key = dir !== '' ? dir : taskId !== '' ? taskId : '(无 id)'
    var shown = taskId !== '' ? taskId : key
    var batch = opts.batch === true
    var selected = batch && opts.selected === true
    var stateLabel =
      typeof task.state_label === 'string' && task.state_label !== ''
        ? task.state_label
        : typeof task.state === 'string' && task.state !== ''
          ? task.state
          : '未知状态'
    var snippet = typeof task.requirement_snippet === 'string' ? task.requirement_snippet : ''
    var when = archivedAtText(task.archived_at)

    var head = []
    if (batch) head.push(renderBatchCheckbox(React, selected))
    head.push(renderPipelineTag(React))
    head.push(renderIdLabel(React, shown, dir !== '' && dir !== shown ? shown + '\n归档目录：' + dir : shown))
    head.push(renderStateBadge(React, task.state, stateLabel))

    var body = []
    body.push(React.createElement('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } }, head))
    body.push(renderSnippet(React, snippet))
    if (when !== '') {
      body.push(
        React.createElement(
          'div',
          {
            key: 'when',
            'data-pipeline-archived-at': when,
            title: typeof task.archived_at === 'string' ? '归档原始时间：' + task.archived_at : when,
            style: { marginTop: '5px', fontSize: '10.5px', lineHeight: '1.5', color: 'rgba(127,127,127,.95)' },
          },
          '归档时间：' + when,
        ),
      )
    }
    if (!batch) body.push(renderArchivedActions(React, key, opts))

    var attrs = { 'data-pipeline-archive-card': key }
    if (batch) attrs['data-pipeline-batch-selected'] = selected ? 'true' : 'false'
    return renderSelectableCard(React, {
      key: opts.key,
      id: key,
      batch: batch,
      selected: selected,
      onToggleSelect: opts.onToggleSelect,
      attrs: attrs,
      children: body,
    })
  }

  // =========================================================================
  // 分区 · 列表与头部（面板骨架，别把这些都塞进 PipelinePanel 的 return 里）
  // =========================================================================

  /** 主视图的任务列表（含"读不到 / 暂无任务"两档空态）。 */
  function renderTaskList(React, opts) {
    var tasks = opts.tasks
    if (tasks === null) {
      return React.createElement(
        'div',
        { key: 'loading', style: { marginTop: '8px', fontSize: '11.5px', opacity: 0.75 } },
        opts.error === '' ? '正在读取多AI协调团队…' : '读不到多AI协调团队数据：' + opts.error,
      )
    }
    if (tasks.length === 0) {
      return React.createElement('div', { key: 'empty', style: { marginTop: '8px', fontSize: '11.5px', opacity: 0.75 } }, '暂无任务')
    }
    var selectedIds = Array.isArray(opts.selectedIds) ? opts.selectedIds : []
    return React.createElement(
      'div',
      { key: 'tasks' },
      tasks.map(function (task, i) {
        var safe = task !== null && typeof task === 'object' ? task : {}
        var id = rowKeyOf(safe, 'tasks')
        var cardKey = (typeof safe.id === 'string' && safe.id !== '' ? safe.id : 'task') + '#' + i
        return renderTaskCard(React, safe, Object.assign({}, opts, { key: cardKey, selected: id !== '' && selectedIds.indexOf(id) !== -1 }))
      }),
    )
  }

  /** 归档视图的列表（读不到时只写一行灰字 —— 归档是附加视图，失败不该把主面板拖下水）。 */
  function renderArchivedList(React, opts) {
    var archived = opts.archived
    var rows = archived !== null && archived !== undefined && Array.isArray(archived.tasks) ? archived.tasks : null
    if (rows === null) {
      var err = archived !== null && archived !== undefined && typeof archived.error === 'string' ? archived.error : ''
      return React.createElement(
        'div',
        { key: 'archLoading', style: { marginTop: '8px', fontSize: '11.5px', opacity: 0.75 } },
        err === '' ? '正在读取已归档的任务…' : '读不到归档列表：' + err,
      )
    }
    if (rows.length === 0) {
      return React.createElement('div', { key: 'archEmpty', style: { marginTop: '8px', fontSize: '11.5px', opacity: 0.75 } }, '归档区是空的')
    }
    var selectedIds = Array.isArray(opts.selectedIds) ? opts.selectedIds : []
    return React.createElement(
      'div',
      { key: 'archived' },
      rows.map(function (task, i) {
        var safe = task !== null && typeof task === 'object' ? task : {}
        var id = rowKeyOf(safe, 'archived')
        var cardKey = (id !== '' ? id : 'archived') + '#' + i
        return renderArchivedCard(
          React,
          safe,
          Object.assign({}, opts, { key: cardKey, selected: id !== '' && selectedIds.indexOf(id) !== -1 }),
        )
      }),
    )
  }

  /** 头部小按钮（「批量」「归档 N」「← 返回任务」共用一套长相）。 */
  function renderHeaderButton(React, spec) {
    var active = spec.active === true
    var props = {
      key: spec.key,
      type: 'button',
      title: spec.title,
      onClick: spec.onClick,
      style: {
        flex: '0 0 auto',
        height: '22px',
        padding: '0 8px',
        font: 'inherit',
        fontSize: '11px',
        lineHeight: '1',
        color: active ? 'var(--dsw-alias-brand-primary, #1f6feb)' : 'inherit',
        background: active ? 'rgba(47,129,247,.14)' : 'transparent',
        border: '1px solid ' + (active ? 'rgba(47,129,247,.55)' : 'var(--dsw-alias-border-l2, rgba(127,127,127,.35))'),
        borderRadius: '999px',
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
   * 面板头部：标题 + 「批量」（靠左）+ 「归档 N」/「← 返回任务」（靠右）。
   * 归档数量来自归档列表长度（还没读到就只写「归档」两个字，不编一个 0）。
   */
  function renderPanelHeader(React, opts) {
    var view = opts.view === 'archived' ? 'archived' : 'tasks'
    var batch = opts.batch === true
    var count = opts.archivedCount
    var title =
      view === 'archived'
        ? '已归档' + (count === null ? '' : ' · ' + count + ' 张')
        : opts.tasksCount === null
          ? '多AI协调团队'
          : '多AI协调团队 · ' + opts.tasksCount + ' 个任务'
    var children = [
      React.createElement(
        'strong',
        {
          key: 'title',
          style: {
            fontSize: '12.5px',
            fontWeight: 600,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        },
        title,
      ),
      renderHeaderButton(React, {
        key: 'batch',
        label: batch ? '批量中' : '批量',
        active: batch,
        title: batch ? '退出批量模式（已选中的会清空）' : '进入批量模式：点整张卡选中，底部会出现批量操作栏',
        hooks: { 'data-pipeline-batch-toggle': batch ? 'on' : 'off' },
        onClick: opts.onToggleBatch,
      }),
      React.createElement('span', { key: 'spacer', style: { flex: '1 1 auto', minWidth: 0 } }),
    ]
    if (view === 'archived') {
      children.push(
        renderHeaderButton(React, {
          key: 'back',
          label: '← 返回任务',
          title: '切回任务列表',
          hooks: { 'data-pipeline-archive-back': 'true' },
          onClick: opts.onBackToTasks,
        }),
      )
    } else {
      children.push(
        renderHeaderButton(React, {
          key: 'archive',
          label: '归档' + (count === null ? '' : ' ' + count),
          title: '查看已归档的任务（可以恢复或永久删除）',
          hooks: {
            'data-pipeline-archive-toggle': 'true',
            'data-pipeline-archived-count': count === null ? '' : String(count),
          },
          onClick: opts.onOpenArchive,
        }),
      )
    }
    return React.createElement(
      'div',
      { 'data-pipeline-panel-head': 'true', style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
      children,
    )
  }

  /**
   * 右上角的「多AI协调团队」面板：看得到队员（任务 + 席位 + 状态），点名字打开对话。
   *
   * 与上面的「多AI 协调」开关**并排**，不替换它：开关管功能总开关，这个面板只管导航。
   * 纯内联样式（不注入 CSS）：不污染宿主样式表，也不怕宿主改 CSS Module 类名。
   */
  function PipelinePanel(props) {
    var React = props.React
    var ctx = props.ctx

    var snapHook = React.useState(null) // { tasks: [...] | null, error: string, generatedAt: string }
    var snap = snapHook[0]
    var setSnap = snapHook[1]

    var openHook = React.useState(false)
    var open = openHook[0]
    var setOpen = openHook[1]

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
    var pinnedRef = React.useRef(false) // 点击钉住后面板不因移开而收起
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

    // ---- 席位会话预览 ----
    //   状态只给渲染用；"开没开 / 是哪个 key / 缓存 / 在途序号"都放 ref 里，
    //   因为定时器与异步回包拿到的都是**旧渲染的闭包**，读 state 会读到过期值。
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
     * 写成功之后**立刻**把这几张卡从界面上撤掉。
     *
     * 宿主把目录挪走之后快照自然会少一张，但那要等下一次回包 —— 归档 / 删单这类
     * "点完就该消失"的动作不能留着旧卡让人以为没生效。两份列表都按各自的键清一遍
     * （任务 id 与归档目录名不会撞车，所以清两张表是安全的）。
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
        setOpen(true)
      }, 140)
    }

    var scheduleClose = function () {
      cancelHover()
      if (!open || pinnedRef.current) return
      // ★ 预览层开着时先不关面板：预览是 `position:fixed` 的独立浮层，指针从 chip 移到它
      //   上面可能经过面板之外的一小段间隙 —— 那一下不该把面板连同预览一起收掉。
      //   预览收掉之后 `schedulePreviewHide` 会把这条"慢关"接回去。
      if (previewRef.current.open) return
      // ★ 800ms 才关：从按钮移到面板要经过一小段间隙；官方也是"慢关"，
      //   太快就会像"碰一下就关"。
      hoverTimerRef.current = setTimeout(function () {
        hoverTimerRef.current = null
        setOpen(false)
      }, 800)
    }

    // =======================================================================
    // 任务卡操作按钮：终止 / 恢复 / 归档 / 删单（+ 归档视图的 恢复 / 永久删除）
    // =======================================================================

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

    /** 删单第一击：只进入确认态，3 秒后自己复原（超过就不认第二击）。 */
    var armDelete = function (key) {
      clearArmTimer()
      // 同一时刻只允许**一处**"上膛"：单卡刚上膛过、又去点批量删除时，
      // 别让单卡那颗按钮一直红着（它等的那次确认已经不可能来了）。
      if (batch.armed !== '') patchBatch({ armed: '' })
      patchActionUi({ armedKey: key })
      armTimerRef.current = setTimeout(function () {
        armTimerRef.current = null
        if (aliveRef.current) patchActionUi({ armedKey: '' })
      }, DELETE_CONFIRM_MS)
    }

    /**
     * 发一次动作：按钮转 busy → POST → 绿字/红字。
     * 成功时**立刻**把卡从界面撤掉（归档 / 删单 / 恢复归档 / 永久删除）并刷新快照：
     * 按钮该消失还是该换，下一帧就看得见，不用等 5 秒轮询。
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

    /** 按钮点击入口：删单 / 永久删除的两次点击判据就在这里（第一次只"上膛"）。 */
    var onActionClick = function (taskId, action) {
      if (actionUi.busyKey !== '') return // 一次只让一个动作在飞
      if (isConfirmAction(action) && actionUi.armedKey !== actionKeyOf(taskId, action)) {
        armDelete(actionKeyOf(taskId, action))
        return
      }
      clearArmTimer()
      runAction(taskId, action)
    }

    /** 指针离开删单 / 永久删除按钮 ⇒ 立刻复原（不必等满 3 秒）。 */
    var onActionBlur = function (taskId, action) {
      if (!isConfirmAction(action)) return
      if (actionUi.armedKey !== actionKeyOf(taskId, action)) return
      clearArmTimer()
      patchActionUi({ armedKey: '' })
    }

    /**
     * 置顶 / 取消置顶。
     * 只发请求 + 刷快照：**不重排**任务卡（宿主已经把置顶的排在前面，客户端再排会打架）。
     */
    var onPinClick = function (taskId, pinned) {
      if (actionUi.busyKey !== '') return
      runAction(taskId, pinned === true ? 'unpin' : 'pin')
    }

    // =======================================================================
    // 批量管理（仿 QQ 多选面板）：串行执行 + 底部操作栏
    // =======================================================================

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
      patchBatch({ on: false, selected: [], busy: false, done: 0, total: 0, armed: '' })
    }

    /** 头部「批量」：进 / 出批量模式（进去时先清空上一次的选择）。 */
    var toggleBatch = function () {
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

    // =======================================================================
    // 席位会话预览（悬停 400ms 弹出，可移入、可用滚轮翻）
    // =======================================================================

    var clearPreviewTimer = function () {
      if (previewTimerRef.current === null) return
      clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }

    /** 关掉预览（幂等；顺带把在途读取的结果作废）。 */
    var closePreview = function () {
      clearPreviewTimer()
      if (!previewRef.current.open) {
        if (aliveRef.current) setPreview(null)
        return
      }
      previewRef.current.open = false
      previewRef.current.key = ''
      previewRef.current.seq += 1
      previewBoxRef.current = null
      if (aliveRef.current) setPreview(null)
    }

    /** 把读到的行落到预览层 —— 只有"还是同一条预览"时才落（防止晚到的回包串台）。 */
    var applyPreviewRows = function (key, rows) {
      setPreview(function (prev) {
        if (prev === null || prev.key !== key) return prev
        var hasRows = Array.isArray(rows) && rows.length > 0
        return {
          key: prev.key,
          name: prev.name,
          sessionId: prev.sessionId,
          box: prev.box,
          phase: hasRows ? 'ready' : 'none',
          rows: hasRows ? rows : null,
        }
      })
    }

    /** 取数：先看缓存（30 秒内同一会话不重复 retain），没有才走 `sessions` 服务。 */
    var loadPreview = function (key, sessionIdToRead) {
      var cache = previewCacheRef.current
      var hit = cache.rows[sessionIdToRead]
      if (hit !== undefined && Date.now() - hit.at < PREVIEW_CACHE_MS) {
        applyPreviewRows(key, hit.rows)
        return
      }
      var seq = previewRef.current.seq + 1
      previewRef.current.seq = seq
      loadSessionPreviewRows(ctx, sessionIdToRead, cache).then(
        function (rows) {
          cache.rows[sessionIdToRead] = { at: Date.now(), rows: Array.isArray(rows) ? rows : [] }
          if (!aliveRef.current || previewRef.current.seq !== seq || previewRef.current.key !== key) return
          applyPreviewRows(key, rows)
        },
        function () {
          // 失败也缓存（同一条 30 秒口径）：不会因为鼠标扫过一排 chip 就狂打历史流。
          cache.rows[sessionIdToRead] = { at: Date.now(), rows: [] }
          if (!aliveRef.current || previewRef.current.seq !== seq || previewRef.current.key !== key) return
          applyPreviewRows(key, null)
        },
      )
    }

    /** 悬停 400ms → 弹预览；换到另一格先撤掉上一个。 */
    var schedulePreviewShow = function (seat, el) {
      var safe = seat !== null && typeof seat === 'object' ? seat : {}
      var target = typeof safe.session_id === 'string' ? safe.session_id : ''
      if (target === '') return // 没有会话 id 的席位没得预览
      var name = seatName(safe)
      var key = target + '|' + name
      clearPreviewTimer()
      if (previewRef.current.key === key && previewRef.current.open) return
      if (previewRef.current.open) closePreview()
      previewTimerRef.current = setTimeout(function () {
        previewTimerRef.current = null
        if (!aliveRef.current) return
        previewRef.current.open = true
        previewRef.current.key = key
        previewRef.current.seq += 1
        setPreview({ key: key, name: name, sessionId: target, phase: 'loading', rows: null, box: previewBoxFor(el) })
        loadPreview(key, target)
      }, PREVIEW_SHOW_MS)
    }

    /** 指针离开 chip：先取消待弹出的计时；已经弹出的等 250ms（移进预览层会取消）。 */
    var schedulePreviewHide = function () {
      clearPreviewTimer()
      if (!previewRef.current.open) return
      previewTimerRef.current = setTimeout(function () {
        previewTimerRef.current = null
        closePreview()
        // 预览收掉之后，把"面板该不该收起"交还给原来的悬停规则
        scheduleClose()
      }, PREVIEW_HIDE_MS)
    }

    /** 指针移进预览层（或滚轮翻消息）时不关它。 */
    var keepPreview = function () {
      clearPreviewTimer()
    }

    // 卸载时清掉所有定时器，并把还留着的会话引用一并释放（避免卸载后还 setState / 占着历史流）
    React.useEffect(function () {
      return function () {
        if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current)
        if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current)
        if (armTimerRef.current !== null) clearTimeout(armTimerRef.current)
        var retained = previewCacheRef.current.retained
        while (retained.length > 0) releaseSessionRef(retained.pop())
      }
    }, [])

    // 会话切换时收起面板并清掉上一条错误 —— 别让「打不开会话：…」跟着用户跑到新会话里。
    var lastSessionRef = React.useRef(sessionId)
    React.useEffect(function () {
      if (lastSessionRef.current === sessionId) return
      lastSessionRef.current = sessionId
      cancelHover()
      pinnedRef.current = false
      setOpen(false)
      setOpenError('')
      // 预览 / 删单确认态 / 操作提示 / 批量选择都是**上一个会话**那一屏的东西，一起撤掉。
      closePreview()
      clearArmTimer()
      if (actionUi.armedKey !== '' || actionUi.note !== null) patchActionUi({ armedKey: '', note: null })
      if (batch.on || batch.selected.length > 0) exitBatch()
    }, [sessionId])

    // ---- 打开时：立刻刷一次 + 点外部/ESC 关闭；收起时把预览/确认态/提示/批量一起撤掉 ----
    React.useEffect(function () {
      if (!open) {
        // 面板收起 = 预览层、"删单等二次确认"、上一行提示、批量选择全部作废（滚出 / 卸载也走这条）
        closePreview()
        clearArmTimer()
        if (actionUi.armedKey !== '' || actionUi.note !== null) patchActionUi({ armedKey: '', note: null })
        if (batch.on || batch.selected.length > 0) exitBatch()
        return undefined
      }
      readOnce(undefined) // 别让用户等满 5 秒
      readArchivedOnce(undefined) // 头部「归档 N」上的数量靠它（顺带预热归档视图）

      if (typeof document === 'undefined') return undefined
      var onPointerDown = function (ev) {
        var root = rootRef.current
        if (root !== null && typeof root.contains === 'function' && ev.target !== null && root.contains(ev.target)) return
        pinnedRef.current = false
        setOpen(false)
      }
      var onKeyDown = function (ev) {
        if (ev.key !== 'Escape') return
        pinnedRef.current = false
        setOpen(false)
      }
      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('keydown', onKeyDown)
      return function () {
        document.removeEventListener('pointerdown', onPointerDown, true)
        document.removeEventListener('keydown', onKeyDown)
      }
    }, [open])

    // ---- 预览层开着时：滚出（面板滚动/页面滚动）或窗口尺寸变化就收掉 ----
    //   `position:fixed` 的浮层不会跟着面板一起滚，留到滚动之后只会变成一个飘着的旧框。
    React.useEffect(function () {
      if (preview === null) return undefined
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
      var onScroll = function (ev) {
        // 预览层**自己**的滚轮（翻那 12 条消息）不算"滚出去"：
        // scroll 不冒泡，但 window 的捕获阶段照样收得到，所以要看一眼 target 在不在预览层里。
        var box = previewBoxRef.current
        if (
          box !== null &&
          ev !== null &&
          ev !== undefined &&
          ev.target !== null &&
          typeof box.contains === 'function' &&
          box.contains(ev.target)
        ) {
          return
        }
        closePreview()
      }
      var onResize = function () {
        closePreview()
      }
      window.addEventListener('scroll', onScroll, true)
      window.addEventListener('resize', onResize)
      return function () {
        window.removeEventListener('scroll', onScroll, true)
        window.removeEventListener('resize', onResize)
      }
    }, [preview !== null])

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

    var tasks = snap === null ? null : Array.isArray(snap.tasks) ? snap.tasks : null
    var errorText = snap !== null && typeof snap.error === 'string' ? snap.error : ''
    var countText = tasks === null ? (errorText === '' ? '…' : '—') : String(tasks.length)

    var trigger = React.createElement(
      'button',
      {
        type: 'button',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-label': '多AI协调团队面板' + (tasks === null ? '' : '：' + tasks.length + ' 个任务'),
        'data-pipeline-panel-trigger': open ? 'open' : 'closed',
        onMouseEnter: scheduleOpen,
        onClick: function () {
          // 点击 = 钉住 / 取消钉住。悬停打开的算是"没钉住"，点一下才钉住；
          // 钉住后鼠标移开不会收起，再点一下面板才收。
          cancelHover()
          var next = !(open && pinnedRef.current)
          pinnedRef.current = next
          setOpen(next)
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          height: '26px',
          padding: '0 10px',
          margin: '0 2px',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '1',
          color: 'inherit',
          background: open ? 'rgba(127,127,127,.14)' : 'transparent',
          border: '1px solid rgba(139,148,158,.45)',
          borderRadius: '999px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          userSelect: 'none',
          // 会话头部是 Electron 的窗口拖拽区：不写这一行，点击会被当成拖窗口。
          WebkitAppRegion: 'no-drag',
        },
      },
      React.createElement('span', null, '多AI协调团队'),
      React.createElement('span', { style: { opacity: 0.7, fontVariantNumeric: 'tabular-nums' } }, countText),
    )

    // ---- 面板骨架（分区拼装）：头部 → 提示 → 列表 → 批量栏 ----
    //   每个分区都是本文件里一个独立函数（renderPanelHeader / renderTaskList /
    //   renderArchivedList / renderBatchBar），这里只负责按顺序把它们串起来。
    var archivedCount = archived !== null && Array.isArray(archived.tasks) ? archived.tasks.length : null
    var selectedIds = batch.on ? batch.selected : []

    var children = []
    children.push(
      renderPanelHeader(React, {
        view: view,
        tasksCount: tasks === null ? null : tasks.length,
        archivedCount: archivedCount,
        batch: batch.on,
        onToggleBatch: toggleBatch,
        onOpenArchive: openArchivedView,
        onBackToTasks: backToTasks,
      }),
    )

    // 面板顶部那一行操作结果：成功绿色、失败红色（失败时按钮保持可点，直接重试）
    if (actionUi.note !== null && typeof actionUi.note.text === 'string' && actionUi.note.text !== '') {
      var noteIsErr = actionUi.note.kind === 'err'
      children.push(
        React.createElement(
          'div',
          {
            key: 'actionNote',
            role: noteIsErr ? 'alert' : 'status',
            'data-pipeline-action-note': noteIsErr ? 'error' : 'ok',
            style: {
              marginTop: '6px',
              fontSize: '11px',
              lineHeight: '1.5',
              color: noteIsErr ? '#d9534f' : '#2ea043',
              wordBreak: 'break-word',
            },
          },
          actionUi.note.text,
        ),
      )
    }

    if (openError !== '') {
      children.push(
        React.createElement(
          'div',
          {
            key: 'openErr',
            role: 'alert',
            style: { marginTop: '6px', fontSize: '11px', lineHeight: '1.5', color: '#d9534f', wordBreak: 'break-word' },
          },
          openError,
        ),
      )
    }

    // 卡片级回调（任务卡与归档卡共用同一套 opts）
    var cardOpts = {
      batch: batch.on,
      selectedIds: selectedIds,
      onToggleSelect: toggleSelect,
      currentSessionId: sessionId,
      onOpen: openSeat,
      // 单卡操作按钮（来源 = `allowed_actions`；归档卡固定 恢复 / 永久删除）
      busyKey: actionUi.busyKey,
      armedKey: actionUi.armedKey,
      onAction: onActionClick,
      onActionBlur: onActionBlur,
      // 置顶（📌）
      onPin: onPinClick,
      // 悬停预览
      onPreviewEnter: schedulePreviewShow,
      onPreviewLeave: schedulePreviewHide,
    }

    if (view === 'archived') {
      children.push(renderArchivedList(React, Object.assign({}, cardOpts, { archived: archived })))
    } else {
      children.push(renderTaskList(React, Object.assign({}, cardOpts, { tasks: tasks, error: errorText })))
    }

    if (view === 'tasks' && tasks !== null && errorText !== '') {
      children.push(
        React.createElement(
          'div',
          {
            key: 'netErr',
            role: 'status',
            style: { marginTop: '8px', fontSize: '10.5px', lineHeight: '1.5', color: '#d29922', wordBreak: 'break-word' },
          },
          '读取失败（显示的是上一次的数据）：' + errorText,
        ),
      )
    }

    // 归档列表"读到的是上一次的数据"提示（与主视图同一套规矩）
    if (view === 'archived' && archived !== null && archived.error !== '' && archived.tasks !== null) {
      children.push(
        React.createElement(
          'div',
          {
            key: 'archErr',
            role: 'status',
            style: { marginTop: '8px', fontSize: '10.5px', lineHeight: '1.5', color: '#d29922', wordBreak: 'break-word' },
          },
          '归档列表读取失败（显示的是上一次的数据）：' + archived.error,
        ),
      )
    }

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
    children.push(
      renderBatchBar(React, {
        visible: batch.on,
        count: batch.selected.length,
        busy: batch.busy,
        done: batch.done,
        total: batch.total,
        actions: batchActions,
        onAction: onBatchAction,
        onCancel: exitBatch,
      }),
    )

    var popover = open
      ? React.createElement(
          'div',
          {
            // 外层只负责补上「按钮 ↔ 面板」之间那 6px 的缝：指针经过缝时仍在这个元素里，
            // 所以悬停横移不会被误判成"离开"（这是"没那么容易关"的另一半）。
            'data-pipeline-panel-frame': 'true',
            style: { position: 'absolute', top: '100%', right: 0, paddingTop: '6px', WebkitAppRegion: 'no-drag' },
          },
          React.createElement(
            'div',
            {
              role: 'dialog',
              'aria-label': '多AI协调团队',
              'data-pipeline-panel': 'open',
              'data-pipeline-panel-view': view === 'archived' ? 'archived' : 'tasks',
              'data-pipeline-panel-batch': batch.on ? 'on' : 'off',
              style: {
                zIndex: 2147483000,
                width: 'min(440px, 92vw)',
                maxHeight: 'min(70vh, 560px)',
                overflowY: 'auto',
                overscrollBehavior: 'contain',
                boxSizing: 'border-box',
                padding: '10px ' + PANEL_PAD_X + 'px ' + PANEL_PAD_BOTTOM + 'px',
                background: 'var(--dsw-specific-menu, #ffffff)',
                color: 'var(--dsw-alias-label-primary, #1f2328)',
                border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
                borderRadius: '12px',
                boxShadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,.28))',
                font: 'inherit',
                fontSize: '12px',
                lineHeight: '1.45',
                textAlign: 'left',
                // 面板整体也落在头部拖拽区里，同样要显式退出拖拽
                WebkitAppRegion: 'no-drag',
              },
            },
            children,
          ),
        )
      : null

    // ---- 席位会话预览浮层 ----
    //   `position:fixed` + 按 chip 的 `getBoundingClientRect()` 落点（`previewBoxFor` 收边），
    //   zIndex 比面板更高。挂在面板根节点里（DOM 上是子节点）有三个好处：
    //   ① 面板一收起它就跟着消失，不会留下孤儿浮层；
    //   ② 从 chip 移到它上面不会被判成"离开面板"；
    //   ③ 点它不会被面板的"点外部关闭"误伤。
    var previewNode = null
    if (open && preview !== null) {
      var boxStyle = {
        position: 'fixed',
        left: preview.box.left + 'px',
        width: preview.box.width + 'px',
        // 面板是 2147483000，预览要在它上面
        zIndex: 2147483600,
        boxSizing: 'border-box',
        padding: '8px 10px 9px',
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
      if (typeof preview.box.bottom === 'number') boxStyle.bottom = preview.box.bottom + 'px'
      else boxStyle.top = preview.box.top + 'px'

      var previewBody = null
      if (preview.phase === 'loading') {
        previewBody = React.createElement('div', { style: { marginTop: '5px', fontSize: '11px', opacity: 0.75 } }, '正在读取会话…')
      } else if (preview.phase !== 'ready' || !Array.isArray(preview.rows) || preview.rows.length === 0) {
        // 失败 / 没权限 / 还没上线：一行灰字，不假装有内容
        previewBody = React.createElement(
          'div',
          { style: { marginTop: '5px', fontSize: '11px', color: 'rgba(127,127,127,.95)' } },
          '该会话暂无预览（未在线或不可读）',
        )
      } else {
        previewBody = React.createElement(
          'div',
          {
            // ★ 最多 260px 高 + overflowY:auto ⇒ 原生滚轮就能往下翻
            'data-pipeline-preview-list': 'true',
            style: { marginTop: '5px', maxHeight: PREVIEW_MAX_HEIGHT + 'px', overflowY: 'auto', overscrollBehavior: 'contain' },
          },
          preview.rows.map(function (row, i) {
            // 工具结果：窄灰条居中，不占气泡（和聊天界面的工具行观感一致）
            if (row.role === '工具') {
              return React.createElement(
                'div',
                {
                  key: 'row' + i,
                  title: row.text,
                  style: {
                    marginTop: i === 0 ? 0 : '4px',
                    textAlign: 'center',
                    fontSize: '10.5px',
                    color: 'rgba(127,127,127,.95)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                '工具结果：' + row.text,
              )
            }
            // 用户靠右、AI 靠左 —— “缩小视窗的聊天界面”：字体不缩放，只是窗口小、可滚轮翻。
            var isUser = row.role === '用户'
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
              React.createElement(
                'div',
                {
                  title: row.text,
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
                    color: 'var(--dsw-alias-label-primary, #1f2328)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    overflowWrap: 'anywhere',
                  },
                },
                row.text,
              ),
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
          // 鼠标移进来就取消"离开即关"的计时（要能滚轮翻那 12 条）
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
            style: { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11.5px', fontWeight: 600, minWidth: 0 },
          },
          React.createElement(
            'span',
            { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            '会话预览 · ' + preview.name,
          ),
        ),
        previewBody,
      )
    }

    return React.createElement(
      'div',
      {
        ref: rootRef,
        'data-pipeline-panel-root': 'true',
        onMouseEnter: cancelHover,
        onMouseLeave: scheduleClose,
        style: { position: 'relative', display: 'inline-flex', alignItems: 'center', WebkitAppRegion: 'no-drag' },
      },
      trigger,
      popover,
      previewNode,
    )
  }

  // =========================================================================
  // 插件入口（宿主客户端半边按 cordis 插件调用 apply / inject）
  // =========================================================================

  /**
   * @param {object} ctx - 客户端 cordis 上下文。
   */
  function apply(ctx) {
    var React = ctx.__react
    // 正常路径下 React 已经在工厂闭包里；这里只是给"被测试直接调用"留个后门。
    if (React === undefined) {
      throw new Error('dsh-pipeline client: React 未就绪（应当由工厂闭包提供）')
    }

    ctx.effect(
      function () {
        return ctx.slots.inject(SLOT, function () {
          // 两个条目共用**一次** slots.inject：同一个 list 槽、同一份订阅生命周期。
          // （顺序有讲究：开关先注册 —— 它是既有条目，排序与卸载都不受影响。）
          var disposeToggle = ctx.slots.register(
            {
              name: SLOT,
              id: ENTRY_ID,
              order: ENTRY_ORDER,
              label: '多AI 协调',
            },
            function CoordinationToggleBound(props) {
              return CoordinationToggle(Object.assign({}, props, { React: React }))
            },
          )

          // 「多AI协调团队」面板：**并排**新增，不替换上面的开关（order 110 = 开关右边一格）。
          var disposePanel = ctx.slots.register(
            {
              name: SLOT,
              id: PANEL_ENTRY_ID,
              order: PANEL_ENTRY_ORDER,
              label: '多AI协调团队',
            },
            function PipelinePanelBound(props) {
              return PipelinePanel(Object.assign({}, props, { React: React, ctx: ctx }))
            },
          )

          return function () {
            if (typeof disposePanel === 'function') disposePanel()
            if (typeof disposeToggle === 'function') disposeToggle()
          }
        })
      },
      'dsh-pipeline: 多AI 协调开关 + 多AI协调团队面板',
    )
  }

  /** cordis 服务名（不是包名）。`slots` 由 `@deepseek-ai/dsh-client-ui-renderer` 注册。 */
  var inject = ['slots']

  // =========================================================================
  // 注册进宿主的模块加载器
  // =========================================================================

  /**
   * 组装模块工厂。
   *
   * 刻意做成"给定 require 就能跑"的纯形态：自测可以用一个假 require
   * （只提供 react 替身）把它整个跑起来，不需要浏览器。
   */
  function buildFactory(require) {
    return function factory(requireFn) {
      var req = typeof requireFn === 'function' ? requireFn : require
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      var React = req('react')

      // 把 React 交给 apply；同时保留标准的两项导出。
      var boundApply = function (ctx) {
        ctx.__react = React
        apply(ctx)
      }
      // 不留可枚举的额外属性（宿主只读 apply / inject）
      Object.defineProperty(boundApply, 'name', { value: 'apply', configurable: true })

      exports.apply = boundApply
      exports.inject = inject
      // 自测用：把组件与内部工具暴露出来，生产路径不会有人读它们。
      exports.__internals = {
        CoordinationToggle: CoordinationToggle,
        PipelinePanel: PipelinePanel,
        buildFactory: buildFactory,
        fetchState: fetchState,
        postState: postState,
        fetchPanel: fetchPanel,
        currentSessionIdOf: currentSessionIdOf,
        resolveUiWorkspace: resolveUiWorkspace,
        seatName: seatName,
        seatChipInfo: seatChipInfo,
        seatNumberOf: seatNumberOf,
        renderTaskCard: renderTaskCard,
        renderSeatChip: renderSeatChip,
        renderTaskActions: renderTaskActions,
        // 归档视图 / 批量管理（自测可以直接拿它们验"列表项 → 该发哪个 id"）
        renderArchivedCard: renderArchivedCard,
        renderArchivedActions: renderArchivedActions,
        renderArchivedList: renderArchivedList,
        renderTaskList: renderTaskList,
        renderPanelHeader: renderPanelHeader,
        renderBatchBar: renderBatchBar,
        renderBatchCheckbox: renderBatchCheckbox,
        renderPinButton: renderPinButton,
        fetchArchived: fetchArchived,
        rowKeyOf: rowKeyOf,
        submitIdOf: submitIdOf,
        canRunAction: canRunAction,
        archivedAtText: archivedAtText,
        actionMetaOf: actionMetaOf,
        isConfirmAction: isConfirmAction,
        isArchiveMutation: isArchiveMutation,
        postPanelAction: postPanelAction,
        actionKeyOf: actionKeyOf,
        // 预览取数（自测可以直接拿它们验"事件窗口 → 预览行"的转换）
        resolveSessions: resolveSessions,
        releaseSessionRef: releaseSessionRef,
        previewRowsFromEntries: previewRowsFromEntries,
        previewText: previewText,
        previewBoxFor: previewBoxFor,
        loadSessionPreviewRows: loadSessionPreviewRows,
        SLOT: SLOT,
        ENTRY_ID: ENTRY_ID,
        ENTRY_ORDER: ENTRY_ORDER,
        PANEL_ENTRY_ID: PANEL_ENTRY_ID,
        PANEL_ENTRY_ORDER: PANEL_ENTRY_ORDER,
        STATE_PATH: STATE_PATH,
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
        DELETE_ARCHIVED_CONFIRM_LABEL: DELETE_ARCHIVED_CONFIRM_LABEL,
        BATCH_DELETE_CONFIRM_LABEL: BATCH_DELETE_CONFIRM_LABEL,
        PREVIEW_SHOW_MS: PREVIEW_SHOW_MS,
        PREVIEW_HIDE_MS: PREVIEW_HIDE_MS,
        PREVIEW_MAX_ROWS: PREVIEW_MAX_ROWS,
        PREVIEW_MAX_CHARS: PREVIEW_MAX_CHARS,
        PREVIEW_CACHE_MS: PREVIEW_CACHE_MS,
        PREVIEW_MAX_RETAINED: PREVIEW_MAX_RETAINED,
        PREVIEW_MAX_HEIGHT: PREVIEW_MAX_HEIGHT,
        POLL_MS: POLL_MS,
        PANEL_POLL_MS: PANEL_POLL_MS,
        MODULE_ID: MODULE_ID,
      }
      return module.exports
    }
  }

  var descriptor = { id: MODULE_ID, factory: buildFactory(null) }

  // 浏览器路径：交给宿主的模块加载器。
  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load(descriptor)
    return
  }

  // Node / 自测路径：把 descriptor 挂到一个已知位置，让 tests 能取到。
  // （生产里永远不会走到这里 —— 客户端只在浏览器里跑。）
  var g = typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : null
  if (g !== null) {
    if (!Array.isArray(g.__DSH_PIPELINE_CLIENT__)) g.__DSH_PIPELINE_CLIENT__ = []
    g.__DSH_PIPELINE_CLIENT__.push(descriptor)
  }
})()
