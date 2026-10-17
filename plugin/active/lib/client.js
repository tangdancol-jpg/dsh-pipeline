/*
 * dsh-pipeline · 客户端半边（入口）—— Web GUI 右上角的多 AI 协调开关 + 多AI协调团队面板。
 *
 * ⚠️ 这**不是 ES 模块**：宿主按 `dsh-client-modules` 的约定用
 *    `<script async src="/plugins/dsh-pipeline/client.js?rev=…">` 当**经典脚本**加载
 *    （`dsh-client-modules/lib/client.js:582-595`，没有 `type="module"`），再由本文件自己
 *    调 `window.__ModuleLoader__.load({ id, factory })` 注册。所以：没有 `import` /
 *    `export` / 顶层 `await`，要什么就 `require(...)`。
 *
 * 入口只管三件事：① 「多AI 协调」开关（order 100）；② 面板的 lazy wrapper（order 110，
 * **首次被渲染**时才去取 chunk）；③ 模块工厂与注册（apply / inject / buildFactory / descriptor）。
 * 面板那 ~3000 行在同目录的 `lib/client.<name>.js` 里（见 CHUNKS）。挂载点是
 * `conversation.session.header.utilities`（list 槽，带 id+order 就不会顶掉别人；
 * `corner` 是 single 槽、已被 sidebar-right 占着）。
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

  /** 三种视觉状态：开 / 关 / 未知。颜色用的是语义色，不跟随主题变量，避免依赖内部 CSS。 */
  var PALETTE = {
    on: { dot: '#2ea043', border: 'rgba(46,160,67,.55)', bg: 'rgba(46,160,67,.12)', fg: 'inherit' },
    off: { dot: '#8b949e', border: 'rgba(139,148,158,.45)', bg: 'transparent', fg: 'inherit' },
    unknown: { dot: '#d29922', border: 'rgba(210,153,34,.5)', bg: 'rgba(210,153,34,.12)', fg: 'inherit' },
  }

  function paletteFor(mode) {
    return mode === 'on' ? PALETTE.on : mode === 'off' ? PALETTE.off : PALETTE.unknown
  }

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

  // ---- 面板 chunk：入口只决定「什么时候去取」，不决定「怎么画」 ----
  //
  // 宿主按 `/plugins/dsh-pipeline/client.<name>.js?rev=<入口 rev>` 提供它们（rev 由入口 mtime/size 算，只改 chunk 时改一行入口注释即可让 immutable 缓存失效）
  // （`dsh-client-modules/lib/index.js:934-976`：文件读自 `join(dirname(entry.clientPath),
  // fileName)` —— 也就是**必须和本文件同目录**；响应 immutable；不存在就是 404）。
  //
  // ★ chunk 之间**不能**同步 require 彼此（没 materialize 的不在模块表里），所以组合只在
  //   这里做：首次渲染面板时 `Promise.all(require.async(...))` 并行取回 → 交给 shell
  //   按依赖序 `create(deps)` 组装。spec 只认 `./client.<name>.js`
  //   （宿主 CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/）。
  /** 面板 chunk：键名决定依赖顺序（见下方 shell 的 createPanel）。 */
  var CHUNKS = {
    actions: 'client.panel-actions.js',
    atoms: 'client.panel-atoms.js',
    seats: 'client.panel-seats.js',
    menu: 'client.panel-menu.js',
    view: 'client.panel-view.js',
    batch: 'client.panel-batch.js',
    'batch-bar': 'client.panel-batch-bar.js',
    preview: 'client.panel-preview.js',
    'preview-data': 'client.panel-preview-data.js',
    'preview-control': 'client.panel-preview-control.js',
    'preview-bubble': 'client.panel-preview-bubble.js',
    data: 'client.panel-data.js',
    'card-actions': 'client.panel-card-actions.js',
    outside: 'client.panel-outside.js',
    shell: 'client.panel-shell.js',
  }

  /**
   * 并行取回全部 chunk（`require.async`），再交给 shell 组装成面板组件。
   * 失败一律 reject —— lazy wrapper 会把它变成一行可读错误，不白屏。
   */
  function composePanel(require, React, ctx) {
    if (require === null || require === undefined || typeof require.async !== "function") {
      return Promise.reject(new Error('宿主没有提供 require.async，面板 chunk 取不回来'))
    }
    var keys = Object.keys(CHUNKS)
    var loads = keys.map(function (key) {
      return Promise.resolve().then(function () { return require.async('./' + CHUNKS[key]) })
    })
    return Promise.all(loads).then(function (mods) {
      var m = {}
      for (var i = 0; i < keys.length; i++) m[keys[i]] = mods[i]
      return m.shell.create({}).createPanel({ React: React, ctx: ctx, mods: m })
    })
  }

  /**
   * 面板的 **lazy wrapper**：平时什么都不做，**第一次被渲染**时才去取 chunk。
   * 为什么不在 apply 阶段加载：自测的 require 替身没有 `.async`（一碰就把整个插件弄挂），
   * 而且用户没打开过面板时不该为它下载那 3000 行。加载中渲染 null，失败渲染一行可读错误。
   */
  function createLazyPanel(React, ctx, require) {
    return function PipelinePanelLazy(props) {
      var hook = React.useState(null) // { phase: 'loading' | 'ready' | 'error', Panel, error }
      var load = hook[0]
      var setLoad = hook[1]
      var startedRef = React.useRef(false)
      React.useEffect(function () {
        if (startedRef.current) return undefined // 只加载一次（兜住 StrictMode 二次挂载）
        startedRef.current = true
        var alive = true
        setLoad({ phase: 'loading', Panel: null, error: '' })
        composePanel(require, React, ctx).then(
          function (Panel) { if (alive) setLoad({ phase: 'ready', Panel: Panel, error: '' }) },
          function (err) {
            if (alive) setLoad({ phase: 'error', Panel: null, error: String((err && err.message) || err) })
          },
        )
        return function () { alive = false }
      }, [])
      if (load === null || load.phase === 'loading') return null
      if (load.phase === 'error') {
        return React.createElement(
          'span',
          {
            title: '多AI协调团队面板加载失败：' + load.error,
            'data-pipeline-panel-error': 'true',
            style: { fontSize: '11px', color: '#d9534f', whiteSpace: 'nowrap', WebkitAppRegion: 'no-drag' },
          },
          '多AI协调团队加载失败',
        )
      }
      return React.createElement(load.Panel, Object.assign({}, props, { React: React, ctx: ctx }))
    }
  }

  // 面板条目（与开关同槽位、并排在它右边一格）。
  var PANEL_ENTRY_ID = 'pipeline-panel'
  var PANEL_ENTRY_ORDER = 110
  /** @param {object} ctx - 客户端 cordis 上下文。 */
  function apply(ctx) {
    var React = ctx.__react
    if (React === undefined) throw new Error('dsh-pipeline client: React 未就绪（应当由工厂闭包提供）')
    // 这个 require 只用来 `.async` 取 chunk —— apply 阶段一根手指都不碰它（见 createLazyPanel）
    var req = ctx.__require
    ctx.effect(
      function () {
        return ctx.slots.inject(SLOT, function () {
          // 两个条目共用**一次** slots.inject：同一个 list 槽、同一份订阅生命周期（开关先注册）。
          var disposeToggle = ctx.slots.register(
            { name: SLOT, id: ENTRY_ID, order: ENTRY_ORDER, label: '多AI 协调' },
            function CoordinationToggleBound(props) {
              return CoordinationToggle(Object.assign({}, props, { React: React }))
            },
          )
          // 「多AI协调团队」面板：并排新增，不替换开关（order 110 = 开关右边一格）；注册的是 lazy wrapper。
          var disposePanel = ctx.slots.register(
            { name: SLOT, id: PANEL_ENTRY_ID, order: PANEL_ENTRY_ORDER, label: '多AI协调团队' },
            createLazyPanel(React, ctx, req),
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
  // cordis 服务名（不是包名）。`slots` 由 `@deepseek-ai/dsh-client-ui-renderer` 注册。
  var inject = ['slots']

  // ---- 注册进宿主的模块加载器 ----

  /**
   * 组装模块工厂：给定 require 就能跑（自测用假 require 把它整个跑起来，不需要浏览器）。
   * `ctx.__react` / `ctx.__require` 是给 apply 的两个后门：React 与**本模块自己的 require**
   * （lazy wrapper 要靠它的 `.async` 去取 chunk）。
   */
  function buildFactory(require) {
    return function factory(requireFn) {
      var req = typeof requireFn === 'function' ? requireFn : require
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
      var React = req('react')
      var boundApply = function (ctx) {
        ctx.__react = React
        ctx.__require = req
        apply(ctx)
      }
      // 不留可枚举的额外属性（宿主只读 apply / inject）
      Object.defineProperty(boundApply, 'name', { value: 'apply', configurable: true })
      exports.apply = boundApply
      exports.inject = inject
      // 自测用：只留入口这一层真有的键（面板内部那些现在都在各 chunk 里）。
      exports.__internals = {
        buildFactory: buildFactory, createLazyPanel: createLazyPanel, composePanel: composePanel,
        CoordinationToggle: CoordinationToggle, fetchState: fetchState, postState: postState,
        CHUNKS: CHUNKS, MODULE_ID: MODULE_ID, STATE_PATH: STATE_PATH, SLOT: SLOT,
        ENTRY_ID: ENTRY_ID, ENTRY_ORDER: ENTRY_ORDER, POLL_MS: POLL_MS,
        PANEL_ENTRY_ID: PANEL_ENTRY_ID, PANEL_ENTRY_ORDER: PANEL_ENTRY_ORDER,
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
