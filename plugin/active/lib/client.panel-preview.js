/* client.panel-preview.js —— 预览的底料：尺寸/时机/过滤常量、uiWorkspace 与 sessions 两个服务、以及「事件窗口 → 预览行」（跳过注入与工具行、超长截断）。 */
;(function () {
  'use strict'

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    // ---- 预览的常量：尺寸、时机、过滤规则 ----

    /** 悬停多久才弹会话预览 —— 太短会在扫过一排 chip 时闪出一堆浮层。 */
    var PREVIEW_SHOW_MS = 400

    /**
     * 指针离开后多久收起 —— 留出"从 chip 横移到左侧大预览窗"的时间
     * （预览窗在面板左侧，中间要跨过一段间隙；移入预览会取消这个计时）。
     */
    var PREVIEW_HIDE_MS = 600

    /** 预览里最多显示几条消息（**过滤掉注入/工具行之后**再取最后这么多条）。 */
    var PREVIEW_MAX_ROWS = 12

    /** 单条消息最多截多少字（空白先压成一个空格；超出加省略号）。 */
    var PREVIEW_MAX_CHARS = 200

    /** AI 回答正文为空时气泡里显示的文案（不渲染空气泡）。 */
    var PREVIEW_THINKING_TEXT = '正在思考…'

    /**
     * 注入/系统类 user 消息的判据 —— 这些不是"真对话"，预览里一律跳过。
     *
     * 前三条是宿主注入的运行时上下文 / 采样时间 / 快照说明（正文以它们开头），
     * `<system-reminder>` 与 `Your parent agent id is` 是**任意位置**命中即跳过，
     * `【流水线` 是本插件自己注入给席位的提示词。全部按**压缩空白之后的正文**判断。
     */
    var PREVIEW_SKIP_PREFIXES = ['Current runtime context', 'Time sampled', 'This snapshot supersedes', '【流水线']
    var PREVIEW_SKIP_PARTS = ['<system-reminder>', 'Your parent agent id is']

    /** 同一会话的预览快照缓存多久：30 秒内不重复 `retain`。 */
    var PREVIEW_CACHE_MS = 30000

    /** 最多同时保留几个会话引用（超了释放最老的 —— 连点一排 chip 也不会把引用堆满）。 */
    var PREVIEW_MAX_RETAINED = 3

    /** 会话历史读取的兜底超时：`ready` 迟迟不结算时不让预览层永远转圈。 */
    var PREVIEW_LOAD_TIMEOUT_MS = 6000

    /**
     * 会话预览窗尺寸：**面板左侧的大聊天窗**，随视口自适应。
     *   宽 = `min(520px, 42vw)`（下限 360）、高 = `min(520px, 64vh)`（下限 300）。
     * 具体落点由 {@link previewBoxFor} 按面板根节点的 `getBoundingClientRect()` 算。
     */
    var PREVIEW_MIN_WIDTH = 360
    var PREVIEW_MAX_WIDTH = 520
    var PREVIEW_WIDTH_RATIO = 0.42
    var PREVIEW_MIN_HEIGHT = 300
    var PREVIEW_MAX_HEIGHT = 520
    var PREVIEW_HEIGHT_RATIO = 0.64

    /** 面板本体的估算宽度：弹层实际就是 `width: min(440px, 92vw)`（见下面面板 style）。 */
    var PANEL_WIDTH_MAX = 440
    var PANEL_WIDTH_RATIO = 0.92

    /** 预览窗与面板左边缘的水平间隙 / 与面板底边的垂直间隙。 */
    var PREVIEW_GAP_X = 12
    var PREVIEW_GAP_Y = 8

    /** 视口收边时至少留出的边距。 */
    var PREVIEW_VIEWPORT_PAD = 8

    /** 两种消息在预览里的标签与颜色（**只留真对话**：用户 / AI）。 */
    var PREVIEW_ROLE = {
      'user/message': { label: '用户', color: '#2f81f7' },
      'assistant/message': { label: 'AI', color: '#2ea043' },
    }

    // ---- 服务与文本：uiWorkspace / sessions / 事件窗口 → 预览行 ----

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
    /** 正文压空白（换行/多空格一律并成一个空格，首尾去掉）—— 过滤与截断共用这一步。 */
    function flatPreviewText(raw) {
      return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
    }
    /** 压空白 + 截断：预览里一条消息压成一段，太长的正文只留开头（末尾加省略号）。 */
    function previewText(raw) {
      var flat = flatPreviewText(raw)
      if (flat === '') return ''
      if (flat.length <= PREVIEW_MAX_CHARS) return flat
      return flat.slice(0, PREVIEW_MAX_CHARS) + '…'
    }
    /**
     * 这条 user 正文是不是**注入/系统类**消息（不是用户真说的话）。
     *
     * 任一命中即跳过：以 `Current runtime context` / `Time sampled` / `This snapshot supersedes`
     * / `【流水线` 开头，或任意位置含 `<system-reminder>` / `Your parent agent id is`。
     * 判断前先压空白 —— 注入正文常带换行，直接拿原文比前缀会漏。
     */
    function isInjectedPreviewText(raw) {
      var flat = flatPreviewText(raw)
      if (flat === '') return false
      var i = 0
      for (i = 0; i < PREVIEW_SKIP_PREFIXES.length; i++) {
        if (flat.indexOf(PREVIEW_SKIP_PREFIXES[i]) === 0) return true
      }
      for (i = 0; i < PREVIEW_SKIP_PARTS.length; i++) {
        if (flat.indexOf(PREVIEW_SKIP_PARTS[i]) !== -1) return true
      }
      return false
    }
    /**
     * 事件窗口 → 预览行（**过滤之后**取最后 {@link PREVIEW_MAX_ROWS} 条）。
     *
     * 只认 `entry.type === 'event'`（`transient` 是流式过程中的临时行，不代表已入档内容），
     * 事件类型**只留** `user/message` / `assistant/message` —— 工具行、其它消息类型一律不进预览
     * （那是"缩小视窗的聊天界面"，不是调试日志）。
     *
     * 过滤规则：
     *   · user 侧的注入/系统消息（运行时上下文、system-reminder、`【流水线…` 等）不是真对话，
     *     按正文判断命中即跳过（见 {@link isInjectedPreviewText}）；
     *   · assistant 正文为空 / 只有空白 / 只有 thinking 块（`textOfContent` 只认 text 块）⇒
     *     保留一行"正在思考"（`thinking: true`），由渲染侧显示斜体灰字，不渲染空气泡。
     *
     * ★ 正文在 `event.data` 里的位置**两种都有**（照真实 API 写，不靠猜：
     *   `@deepseek-ai/dsh-session/lib/types/surface.js` 的 `deriveEventMessage`）：
     *   · `user/message` 的 message 就是 `data` 本身（那里 `case 'user/message': return event.data`）；
     *   · `assistant/message` 是 `data.message`。
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
        var raw = textOfContent(message.content, 0)
        if (event.type === 'user/message') {
          if (isInjectedPreviewText(raw)) continue
          var userText = previewText(raw)
          // 压完空白就什么都不剩的 user 消息也不占一行（否则是个空气泡）
          if (userText === '') continue
          rows.push({ type: event.type, role: role.label, color: role.color, text: userText, thinking: false })
          continue
        }
        var aiText = previewText(raw)
        rows.push({ type: event.type, role: role.label, color: role.color, text: aiText, thinking: aiText === '' })
      }
      return rows.length > PREVIEW_MAX_ROWS ? rows.slice(rows.length - PREVIEW_MAX_ROWS) : rows
    }

    return {
      PREVIEW_SHOW_MS: PREVIEW_SHOW_MS,
      PREVIEW_HIDE_MS: PREVIEW_HIDE_MS,
      PREVIEW_MAX_ROWS: PREVIEW_MAX_ROWS,
      PREVIEW_MAX_CHARS: PREVIEW_MAX_CHARS,
      PREVIEW_THINKING_TEXT: PREVIEW_THINKING_TEXT,
      PREVIEW_CACHE_MS: PREVIEW_CACHE_MS,
      PREVIEW_MAX_RETAINED: PREVIEW_MAX_RETAINED,
      PREVIEW_LOAD_TIMEOUT_MS: PREVIEW_LOAD_TIMEOUT_MS,
      PREVIEW_MIN_WIDTH: PREVIEW_MIN_WIDTH,
      PREVIEW_MAX_WIDTH: PREVIEW_MAX_WIDTH,
      PREVIEW_WIDTH_RATIO: PREVIEW_WIDTH_RATIO,
      PREVIEW_MIN_HEIGHT: PREVIEW_MIN_HEIGHT,
      PREVIEW_MAX_HEIGHT: PREVIEW_MAX_HEIGHT,
      PREVIEW_HEIGHT_RATIO: PREVIEW_HEIGHT_RATIO,
      PANEL_WIDTH_MAX: PANEL_WIDTH_MAX,
      PANEL_WIDTH_RATIO: PANEL_WIDTH_RATIO,
      PREVIEW_GAP_X: PREVIEW_GAP_X,
      PREVIEW_GAP_Y: PREVIEW_GAP_Y,
      PREVIEW_VIEWPORT_PAD: PREVIEW_VIEWPORT_PAD,
      PREVIEW_ROLE: PREVIEW_ROLE,
      resolveSessions: resolveSessions,
      releaseSessionRef: releaseSessionRef,
      resolveUiWorkspace: resolveUiWorkspace,
      textOfContent: textOfContent,
      flatPreviewText: flatPreviewText,
      previewText: previewText,
      isInjectedPreviewText: isInjectedPreviewText,
      previewRowsFromEntries: previewRowsFromEntries,
    }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-preview.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
