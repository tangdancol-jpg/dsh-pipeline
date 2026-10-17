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
   * 面板条目的 id 与排序权重。
   * 开关是 100，这里给 110 ⇒ 排在它**右边一格**（order 越大越靠右），谁也不顶掉谁。
   */
  var PANEL_ENTRY_ID = 'pipeline-panel'
  var PANEL_ENTRY_ORDER = 110

  /** 面板轮询周期。席位状态变得比开关勤，所以比开关的 8s 快。 */
  var PANEL_POLL_MS = 5000

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
   * 读面板数据。
   *
   * 失败**不抛**：面板的规矩是"保留上次数据 + 底下补一行小字错误"，
   * 抛出去只会把整块面板打成白屏。
   *
   * @returns {Promise<{ok:boolean, tasks?:Array, generatedAt?:string, error?:string}>}
   */
  function fetchPanel(signal) {
    return fetch(PANEL_PATH, {
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
    return React.createElement(
      // 外面这层 span 只为把 title 挂在**禁用按钮之外**：<button disabled> 在多数浏览器里
      // 不派发鼠标事件，直接挂 title 用户看不到提示。
      'span',
      { key: opts.key, title: info.tip, style: { display: 'inline-flex', maxWidth: '100%' } },
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

  /** 一张任务卡：`[pipeline]` + 任务 id + 状态徽标 + 需求摘要（两行截断）+ 席位 chips。 */
  function renderTaskCard(React, task, opts) {
    var taskId = typeof task.id === 'string' && task.id !== '' ? task.id : '(无 id)'
    var stateLabel =
      typeof task.state_label === 'string' && task.state_label !== ''
        ? task.state_label
        : typeof task.state === 'string' && task.state !== ''
          ? task.state
          : '未知状态'
    var tone = stateTone(task.state)
    var snippet = typeof task.requirement_snippet === 'string' ? task.requirement_snippet : ''
    var seats = Array.isArray(task.seats) ? task.seats : []
    return React.createElement(
      'article',
      {
        key: opts.key,
        'data-pipeline-task': taskId,
        style: {
          marginTop: '8px',
          padding: '8px 10px 9px',
          border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.26))',
          borderRadius: '10px',
          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06))',
        },
      },
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
        React.createElement(
          'span',
          {
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
        ),
        React.createElement(
          'span',
          {
            title: taskId,
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
          taskId,
        ),
        React.createElement(
          'span',
          {
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
          stateLabel,
        ),
      ),
      snippet === ''
        ? null
        : React.createElement(
            'p',
            {
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
          ),
      React.createElement(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '7px', minWidth: 0 } },
        seats.length === 0
          ? React.createElement('span', { style: { fontSize: '11px', opacity: 0.7 } }, '这个任务还没有席位')
          : seats.map(function (seat, i) {
              var safe = seat !== null && typeof seat === 'object' ? seat : {}
              return renderSeatChip(React, safe, {
                key: (typeof safe.role === 'string' ? safe.role : 'seat') + '#' + i,
                currentSessionId: opts.currentSessionId,
                onOpen: opts.onOpen,
              })
            }),
      ),
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

    var aliveRef = React.useRef(true)
    var pinnedRef = React.useRef(false) // 点击钉住后面板不因移开而收起
    var hoverTimerRef = React.useRef(null)
    var rootRef = React.useRef(null)

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
      // ★ 800ms 才关：从按钮移到面板要经过一小段间隙；官方也是"慢关"，
      //   太快就会像"碰一下就关"。
      hoverTimerRef.current = setTimeout(function () {
        hoverTimerRef.current = null
        setOpen(false)
      }, 800)
    }

    // 卸载时清掉悬停定时器（避免卸载后还 setState）
    React.useEffect(function () {
      return function () {
        if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current)
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
    }, [sessionId])

    // ---- 打开时：立刻刷一次 + 点外部/ESC 关闭 ----
    React.useEffect(function () {
      if (!open) return undefined
      readOnce(undefined) // 别让用户等满 5 秒
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

    var children = []
    children.push(
      React.createElement(
        'div',
        { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        React.createElement(
          'strong',
          { style: { fontSize: '12.5px', fontWeight: 600 } },
          tasks === null ? '多AI协调团队' : '多AI协调团队 · ' + tasks.length + ' 个任务',
        ),
      ),
    )

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

    if (tasks === null) {
      children.push(
        React.createElement(
          'div',
          { key: 'loading', style: { marginTop: '8px', fontSize: '11.5px', opacity: 0.75 } },
          errorText === '' ? '正在读取多AI协调团队…' : '读不到多AI协调团队数据：' + errorText,
        ),
      )
    } else if (tasks.length === 0) {
      children.push(
        React.createElement('div', { key: 'empty', style: { marginTop: '8px', fontSize: '11.5px', opacity: 0.75 } }, '暂无任务'),
      )
    } else {
      children.push(
        React.createElement(
          'div',
          { key: 'tasks' },
          tasks.map(function (task, i) {
            var safe = task !== null && typeof task === 'object' ? task : {}
            return renderTaskCard(React, safe, {
              key: (typeof safe.id === 'string' && safe.id !== '' ? safe.id : 'task') + '#' + i,
              currentSessionId: sessionId,
              onOpen: openSeat,
            })
          }),
        ),
      )
    }

    if (tasks !== null && errorText !== '') {
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
              style: {
                zIndex: 2147483000,
                width: 'min(440px, 92vw)',
                maxHeight: 'min(70vh, 560px)',
                overflowY: 'auto',
                overscrollBehavior: 'contain',
                boxSizing: 'border-box',
                padding: '10px 12px 12px',
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
        SLOT: SLOT,
        ENTRY_ID: ENTRY_ID,
        ENTRY_ORDER: ENTRY_ORDER,
        PANEL_ENTRY_ID: PANEL_ENTRY_ID,
        PANEL_ENTRY_ORDER: PANEL_ENTRY_ORDER,
        STATE_PATH: STATE_PATH,
        PANEL_PATH: PANEL_PATH,
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
