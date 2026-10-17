/* client.panel-atoms.js —— 通用原子：停止冒泡的边界函数、状态/档位色板，以及等级徽标、团队人数、状态徽标、id、摘要、可选卡壳、批量圆勾、📌 标记、头按钮这些最小可视零件。 */
;(function () {
  'use strict'

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    // ---- 通用原子：小标签、徽标、可选卡壳、头按钮（卡片与列表共用，免得几处各画一遍） ----

    /**
     * 面板内部的**指针事件不要冒泡回宿主**。
     *
     * 面板挂在 `conversation.session.header.utilities`（会话头部里），宿主的头部自己也有
     * pointerdown / click 语义（展开、收起、切侧栏）。面板里的点击一旦冒上去，用户看到的
     * 就是「点面板顶部那一行，按钮不响应，面板反倒被关了」。
     *
     * 只 stop，不 preventDefault：按钮的默认行为（focus / 键盘可达性）照旧。
     */
    function stopHostEvent(ev) {
      if (ev !== null && ev !== undefined && typeof ev.stopPropagation === 'function') ev.stopPropagation()
    }
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
    /**
     * 任务档位（`L0`–`L5`）的**本地展示表**：中文档位名 + 徽标配色。
     *
     * ★ 映射**不塞进快照数据**：宿主只回答"这张单几级"（`task.tier` = `'L0'`…`'L5'` / `null`），
     *   档位叫法与颜色是**展示**，跟着 UI 走 —— 客户端这份表就是唯一来源。
     * ★ 配色按"越往上越重"：灰 → 蓝 → 青 → 橙 → 紫 → 红。`fg` 是文字色，`bg` / `border`
     *   用半透明色，深浅主题下都还读得出来（与 `stateTone` 同一套用法）。
     */
    var TIER_META = {
      L0: { name: '极简脚本', fg: '#6e7781', border: 'rgba(110,119,129,.55)', bg: 'rgba(110,119,129,.16)' },
      L1: { name: '普通功能', fg: '#2f81f7', border: 'rgba(47,129,247,.55)', bg: 'rgba(47,129,247,.14)' },
      L2: { name: '中大型', fg: '#1b7c83', border: 'rgba(27,124,131,.55)', bg: 'rgba(27,124,131,.14)' },
      L3: { name: '安全敏感', fg: '#bc4c00', border: 'rgba(188,76,0,.55)', bg: 'rgba(188,76,0,.14)' },
      L4: { name: '生产上线', fg: '#8250df', border: 'rgba(130,80,223,.55)', bg: 'rgba(130,80,223,.14)' },
      L5: { name: '特殊要求', fg: '#cf222e', border: 'rgba(207,34,46,.55)', bg: 'rgba(207,34,46,.14)' },
    }
    /**
     * 认任务档位：只认 `'L0'`…`'L5'`（大小写不敏感），其余一律 `null`。
     *
     * ★ 老宿主没有 `task.tier` 这个字段 ⇒ `null`（**不画徽标**），也**不**从需求文本里猜档位。
     *   判据与宿主 `lib/panel/snapshot.js` 的 `taskTierOf()` 对齐：非字符串 / 空白 /
     *   认不出（`X9` / `L6` / 数字）都是 `null`。
     *
     * @param {object} task
     * @returns {string|null} `'L0'`…`'L5'` 或 `null`
     */
    function tierIdOf(task) {
      var raw = task !== null && typeof task === 'object' ? task.tier : null
      if (typeof raw !== 'string') return null
      var key = raw.trim().toUpperCase()
      return Object.prototype.hasOwnProperty.call(TIER_META, key) ? key : null
    }
    /**
     * 等级徽标：小圆角 pill，文字就是 `L0`…`L5`（不加前缀）。
     *
     * `title` 写「L5 · 特殊要求」—— 档位名来自本地 {@link TIER_META}，悬停就能知道
     * 这一级意味着什么，不用翻文档。
     * `data-pipeline-tier='L5'` 是给自动化核对的钩子（**只放档位 id，不放中文名**）。
     *
     * @param {string|null} tier - 已经 {@link tierIdOf} 归一过的档位
     */
    function renderTierBadge(React, tier) {
      if (tier === null || !Object.prototype.hasOwnProperty.call(TIER_META, tier)) return null
      var meta = TIER_META[tier]
      return React.createElement(
        'span',
        {
          key: 'tier',
          'data-pipeline-tier': tier,
          title: tier + ' · ' + meta.name,
          'aria-label': '档位 ' + tier + '：' + meta.name,
          style: {
            flex: '0 0 auto',
            fontSize: '9.5px',
            lineHeight: '15px',
            padding: '0 6px',
            borderRadius: '999px',
            fontWeight: 700,
            letterSpacing: '0.02em',
            fontVariantNumeric: 'tabular-nums',
            color: meta.fg,
            border: '1px solid ' + meta.border,
            background: meta.bg,
            whiteSpace: 'nowrap',
            userSelect: 'none',
          },
        },
        tier,
      )
    }
    /**
     * 团队规模：紧跟等级徽标，小号灰字「N 个 AI」（`N` = 席位表长度，**主对话也算一个**）。
     *
     * ★ 只数 `task.seats`（宿主已经按 roster 展开好的席位表），客户端**不**按档位推算
     *   "应该有几个人"：实际派了几个才作数，没派的档位不该显示成已就位。
     * ★ `seats` 缺失 / 空数组 ⇒ 返回 `null`（老宿主 / 还没派活的单，不显示「0 个 AI」）。
     * ★ 有等级徽标时前缀一个 `· `，视觉上连成「L5 · 13 个 AI」；没有徽标时不留孤零零的点。
     * `data-pipeline-team-size='13'` 是给自动化核对的钩子。
     *
     * @param {object} task
     * @param {string|null} tier - 已经归一过的档位（决定要不要那个间隔号）
     */
    function renderTeamSize(React, task, tier) {
      var seats = task !== null && typeof task === 'object' && Array.isArray(task.seats) ? task.seats : []
      var count = seats.length
      if (count === 0) return null
      return React.createElement(
        'span',
        {
          key: 'teamSize',
          'data-pipeline-team-size': String(count),
          title: '团队规模：' + count + ' 个 AI（主对话也算一个）',
          style: {
            flex: '0 0 auto',
            fontSize: '10px',
            lineHeight: '15px',
            color: 'var(--dsw-alias-label-caption, rgba(127,127,127,.95))',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
            userSelect: 'none',
          },
        },
        (tier === null ? '' : '· ') + count + ' 个 AI',
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
            // ★ 不抢多余宽度：任务 id 必须**紧挨**在 [pipeline] 徽标与置顶钉子旁边，
            //   多余空间留给标题行里的 spacer，把状态徽标与「⋯」顶到右侧。
            flex: '0 1 auto',
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
          // 卡片右上角的「⋯」菜单要**相对这张卡**绝对定位，所以卡片自己得是定位祖先
          position: 'relative',
          marginTop: '8px',
          padding: '8px 10px 9px',
          border: '1px solid ' + (selected ? 'rgba(47,129,247,.55)' : 'var(--dsw-alias-border-l1, rgba(127,127,127,.26))'),
          borderRadius: '10px',
          background: selected ? 'rgba(47,129,247,.10)' : 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06))',
          cursor: batch ? 'pointer' : 'default',
          transition: 'background .12s ease, border-color .12s ease',
          // 卡片整块落在会话头部的窗口拖拽区里：显式 no-drag，卡里的小按钮/菜单才点得动
          WebkitAppRegion: 'no-drag',
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
        props.onClick = function (ev) {
          // 先截住宿主，再切选中（别让"点卡选中"顺手关掉宿主头部）
          stopHostEvent(ev)
          toggle()
        }
        props.onKeyDown = function (ev) {
          if (ev === null || ev === undefined) return
          if (ev.key !== ' ' && ev.key !== 'Enter') return
          if (typeof ev.preventDefault === 'function') ev.preventDefault()
          toggle()
        }
      } else {
        // 普通模式里卡上的点击（chip / 钉子 / ⋯）各自处理；卡本身不把事件漏给宿主
        props.onClick = stopHostEvent
        props.onPointerDown = stopHostEvent
        props.onDoubleClick = stopHostEvent
      }
      return React.createElement(
        'article',
        props,
        React.createElement('div', { key: 'inner', style: { pointerEvents: batch ? 'none' : undefined } }, opts.children),
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
     * 头部小按钮（「批量」「归档 N」「← 返回任务」共用一套长相）。
     * ★ 按钮**自己**截住宿主事件（pointerdown / click / dblclick），不全押在外层那一行上：
     *   行级 stop 一旦漏挂（chunk 重组 / 外层换节点），这次点击就会冒到宿主 —— 用户看到的
     *   是"按钮不响，面板反倒被关掉"。`onClick` 只转发、**不吞**：回调没接上就该当场炸。
     */
    function renderHeaderButton(React, spec) {
      var active = spec.active === true
      var props = {
        key: spec.key,
        type: 'button',
        title: spec.title,
        onPointerDown: stopHostEvent,
        onDoubleClick: stopHostEvent,
        onClick: function (ev) {
          stopHostEvent(ev)
          spec.onClick(ev)
        },
        style: {
          flex: '0 0 auto',
          height: '22px',
          padding: '0 8px',
          font: 'inherit',
          fontSize: '11px',
          lineHeight: '1',
          color: active ? 'var(--dsw-alias-brand-primary, #1f6feb)' : 'var(--dsw-alias-label-primary, inherit)',
          // 和任务卡一样给个深色小底面：透明底的按钮在会话头部里既不好认、也不像"能点的东西"。
          background: active ? 'rgba(47,129,247,.20)' : 'rgba(127,127,127,.16)',
          border: '1px solid ' + (active ? 'rgba(47,129,247,.55)' : 'rgba(139,148,158,.45)'),
          borderRadius: '8px',
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

    return {
      stopHostEvent: stopHostEvent,
      stateTone: stateTone,
      TIER_META: TIER_META,
      tierIdOf: tierIdOf,
      renderTierBadge: renderTierBadge,
      renderTeamSize: renderTeamSize,
      renderStateBadge: renderStateBadge,
      renderIdLabel: renderIdLabel,
      renderSnippet: renderSnippet,
      renderSelectableCard: renderSelectableCard,
      renderPinMark: renderPinMark,
      renderBatchCheckbox: renderBatchCheckbox,
      renderHeaderButton: renderHeaderButton,
      PANEL_PAD_X: PANEL_PAD_X,
      PANEL_PAD_BOTTOM: PANEL_PAD_BOTTOM,
    }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-atoms.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
