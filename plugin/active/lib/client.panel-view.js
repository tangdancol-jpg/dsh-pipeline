/* client.panel-view.js —— 纯渲染：任务卡、归档卡、两个列表（含空态）、[pipeline] 标签与面板头部标题行；这里不取数、不持状态。 */
;(function () {
  'use strict'

  /** @param {object} deps 依赖（入口按依赖序传进来；chunk 之间不能同步 require 彼此） */
  function create(deps) {
    // 整块的卡片与列表：只画，不取数。依赖 atoms / seats / menu / actions。
    var stopHostEvent = deps.atoms.stopHostEvent
    var tierIdOf = deps.atoms.tierIdOf
    var renderTierBadge = deps.atoms.renderTierBadge
    var renderTeamSize = deps.atoms.renderTeamSize
    var renderStateBadge = deps.atoms.renderStateBadge
    var renderIdLabel = deps.atoms.renderIdLabel
    var renderSnippet = deps.atoms.renderSnippet
    var renderSelectableCard = deps.atoms.renderSelectableCard
    var renderPinMark = deps.atoms.renderPinMark
    var renderHeaderButton = deps.atoms.renderHeaderButton
    var renderSeatChip = deps.seats.renderSeatChip
    var renderBatchCheckbox = deps.atoms.renderBatchCheckbox
    var renderPinButton = deps.menu.renderPinButton
    var renderCardMenuTrigger = deps.menu.renderCardMenuTrigger
    var renderCardMenu = deps.menu.renderCardMenu
    var buildTaskMenuItems = deps.menu.buildTaskMenuItems
    var buildArchivedMenuItems = deps.menu.buildArchivedMenuItems
    var archivedAtText = deps.actions.archivedAtText
    var rowKeyOf = deps.actions.rowKeyOf

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
    /**
     * 一张任务卡：标题行左侧 `等级徽标 · 团队规模` + `[pipeline]` + 任务 id + 📌置顶，
     * 右侧状态徽标 + 「⋯」，下面是需求摘要（两行截断）与席位 chips。
     *
     * 两种模式：
     *   · 普通模式：动作全收进右上角「⋯」菜单（卡片底部不再有一排按钮）；
     *   · **批量模式**（`opts.batch`）：左侧多一个圆勾、点整卡 = 切换选中，
     *     置顶钉子和「⋯」一起让位（那时两种点击不该打架）。
     *
     * ★ 等级徽标（`L0`–`L5`）与团队规模（`N 个 AI`）**只在任务卡**上出现：
     *   归档视图没有 roster / tier，见 {@link renderArchivedCard}（那里保持原样）。
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

      // 菜单项只跟这张卡的 `allowed_actions` 有关；批量模式下构建器直接返回空（连「⋯」都不画）
      var menuItems = buildTaskMenuItems(task, opts)
      var menuOpen = menuItems.length > 0 && opts.menuKey === taskId

      // 标题行：左侧一串（等级 + 人数 / 徽标 / id / 📌 / 置顶），再由 spacer 把状态徽标与「⋯」推到最右
      var head = []
      if (batch) head.push(renderBatchCheckbox(React, selected))
      // ★ 等级徽标 + 团队规模放**最前**（用户说的"原来那个红点"的位置）：一眼看清这张单多重、
      //   几个人在干。批量模式的圆勾属于"选择态"而不是卡面内容，所以仍留在它们前面 ——
      //   点哪儿都是选中，顺序不打架。
      var tier = tierIdOf(task)
      var tierBadge = renderTierBadge(React, tier)
      if (tierBadge !== null) head.push(tierBadge)
      var teamSize = renderTeamSize(React, task, tier)
      if (teamSize !== null) head.push(teamSize)
      head.push(renderPipelineTag(React))
      head.push(renderIdLabel(React, taskId))
      head.push(renderPinMark(React, task))
      head.push(renderPinButton(React, task, opts)) // 批量模式下它自己返回 null
      // 左侧一串到置顶为止；spacer 吃掉多余宽度，把状态徽标与「⋯」留在最右
      head.push(React.createElement('span', { key: 'spacer', style: { flex: '1 1 auto', minWidth: 0 } }))
      head.push(renderStateBadge(React, task.state, stateLabel))
      if (menuItems.length > 0) {
        head.push(
          renderCardMenuTrigger(React, {
            cardKey: taskId,
            open: menuOpen,
            onToggle: opts.onMenuToggle,
            // 只有"当前打开菜单的那颗"才登记 ref：document 上的点外判断靠它认得自己
            ref: menuOpen ? opts.menuTriggerRef : undefined,
          }),
        )
      }

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
      // 「⋯」的下拉菜单（绝对定位在卡片右上；没开 / 没动作时整块不占位）
      if (menuOpen) body.push(renderCardMenu(React, { cardKey: taskId, items: menuItems, ref: opts.menuRef }))

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
     * 一张**归档卡**：标题行 `[pipeline]` + 任务 id + 状态徽标 + 右上角「⋯」，
     * 下面需求摘要 + 归档时间。动作（恢复 / 永久删除）全在「⋯」菜单里。
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

      // 归档卡的菜单项恒定两条（恢复 / 永久删除）；批量模式下构建器返回空 ⇒ 不画「⋯」
      var menuItems = buildArchivedMenuItems(key, opts)
      var menuOpen = menuItems.length > 0 && opts.menuKey === key

      var head = []
      if (batch) head.push(renderBatchCheckbox(React, selected))
      head.push(renderPipelineTag(React))
      head.push(renderIdLabel(React, shown, dir !== '' && dir !== shown ? shown + '\n归档目录：' + dir : shown))
      // spacer 吃掉多余宽度：归档卡的状态徽标与「⋯」也要留在标题行最右
      head.push(React.createElement('span', { key: 'spacer', style: { flex: '1 1 auto', minWidth: 0 } }))
      head.push(renderStateBadge(React, task.state, stateLabel))
      if (menuItems.length > 0) {
        head.push(
          renderCardMenuTrigger(React, {
            cardKey: key,
            open: menuOpen,
            onToggle: opts.onMenuToggle,
            title: '更多操作（恢复 / 永久删除）',
            ref: menuOpen ? opts.menuTriggerRef : undefined,
          }),
        )
      }

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
      // 「⋯」的下拉菜单（与任务卡同一套长相；永久删除同样两击确认）
      if (menuOpen) body.push(renderCardMenu(React, { cardKey: key, items: menuItems, ref: opts.menuRef }))

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
        {
          'data-pipeline-panel-head': 'true',
          // 顶行（标题 / 批量 / 归档 N）整行截住宿主事件：按钮自身的 onClick 先跑，再轮到这三个
          onPointerDown: stopHostEvent,
          onClick: stopHostEvent,
          onDoubleClick: stopHostEvent,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            minWidth: 0,
            // 顶行也在会话头部的窗口拖拽区里：整行显式 no-drag（按钮自身还有一层）
            WebkitAppRegion: 'no-drag',
          },
        },
        children,
      )
    }

    return {
      renderTaskCard: renderTaskCard,
      renderArchivedCard: renderArchivedCard,
      renderTaskList: renderTaskList,
      renderArchivedList: renderArchivedList,
      renderPanelHeader: renderPanelHeader,
    }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-view.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
