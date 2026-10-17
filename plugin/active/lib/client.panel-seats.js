/* client.panel-seats.js —— 席位这一格：角色中文名、席位号、状态圆点，以及那颗 chip 的渲染与「能不能点/tooltip 说什么」的判据。 */
;(function () {
  'use strict'

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    // ---- 席位：中文名、状态圆点、chip（点名字打开那个对话；悬停弹预览） ----

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

    return {
      ROLE_LABELS: ROLE_LABELS,
      SEAT_STATUS: SEAT_STATUS,
      SEAT_STATUS_UNKNOWN: SEAT_STATUS_UNKNOWN,
      seatNumberOf: seatNumberOf,
      seatName: seatName,
      seatChipInfo: seatChipInfo,
      renderSeatChip: renderSeatChip,
    }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-seats.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
