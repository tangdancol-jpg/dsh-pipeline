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
 * 怎么和宿主说话：同端口相对 fetch
 * ---------------------------------------------------------------------------
 * 宿主半边注册了 `/.dsh-pipeline/state`（`lib/switch-routes.js`）。
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

  /** 本条目的 id（list 槽里唯一）与排序权重（越大越靠右）。 */
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
      '关 = 关闭该功能，回到普通 DSH 行为：守门不介入，流水线的写入动作会被拒绝（查询仍可用）。\n\n' +
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
          return ctx.slots.register(
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
        })
      },
      'dsh-pipeline: 多AI 协调开关',
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
        buildFactory: buildFactory,
        fetchState: fetchState,
        postState: postState,
        SLOT: SLOT,
        ENTRY_ID: ENTRY_ID,
        ENTRY_ORDER: ENTRY_ORDER,
        STATE_PATH: STATE_PATH,
        POLL_MS: POLL_MS,
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
