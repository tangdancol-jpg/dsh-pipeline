/* client.panel-outside.js —— 「点面板外面就收起」的判据与 document 级 pointerdown 处理器：ref 的 contains 会失真（真机），所以再按 DOM 属性 closest 复核，判不出来就不关；另记「上次点击打在谁身上」给诊断行。 */
;(function () {
  'use strict'

  // ---- 诊断寄存器（★ 取证用，定位后移除）----
  // 放 module 作用域：组件重挂载会重新初始化 useState，只有这里跨重挂载活下来。
  var LAST = { click: '' }

  /** 说明「这个元素长在面板里」的 DOM 属性判据（祖先链上任一命中即算里面）。 */
  var PANEL_SELECTORS = ['[data-pipeline-panel-root]', '[data-pipeline-panel]']
  /** 描述里优先显示面板自己打的标记（`data-pipeline-*`）。 */
  var ATTR_PREFIX = 'data-pipeline-'
  /** 描述最多这么长 —— 它要挤进诊断行那一行里（超长就截断）。 */
  var DESC_MAX = 80

  function isObj(v) {
    return v !== null && v !== undefined && typeof v === 'object'
  }

  /** `node.contains(target)`；node 不可用或抛错 ⇒ null（= 判不出来，交给下一路判据）。 */
  function contains(node, target) {
    if (!isObj(node) || typeof node.contains !== 'function') return null
    try {
      return node.contains(target) === true
    } catch (err) {
      void err
      return null
    }
  }

  /** 沿祖先链找选择器；没有 closest（老环境 / 不是元素）或抛错 ⇒ null（= 这条判据用不了）。 */
  function closestOf(target, sel) {
    if (!isObj(target) || typeof target.closest !== 'function') return null
    try {
      var hit = target.closest(sel)
      return hit === undefined ? null : hit
    } catch (err) {
      void err
      return null
    }
  }

  /**
   * ★ 判 target 在不在面板里 —— `true` 里面 / `false` 明确在外面 / `null` 判不出来。
   *
   * 两路判据：① ref 的 `contains`（快，但真机上 ref 会脱手 / 指向被替换的节点，只靠它会把
   * 面板内部的点击判成"外面"）；② target 自己的 DOM 属性祖先链（不依赖 ref，才是事实来源）。
   * 返回 `null` 的意思是**不许**据此关面板：宁可漏关一次，也不能误关正在用的面板。
   *
   * @param {object} target 事件目标（`ev.target`）
   * @param {object} root 面板根节点的 ref 当前值（可能还没挂上 / 已脱手）
   */
  function targetInsidePanel(target, root) {
    if (!isObj(target)) return null
    if (contains(root, target) === true) return true
    if (typeof target.closest === 'function') {
      for (var i = 0; i < PANEL_SELECTORS.length; i += 1) {
        if (closestOf(target, PANEL_SELECTORS[i]) !== null) return true
      }
      return false
    }
    return false
  }

  /** root 这把判据能不能用（ref 还没挂 / 脱手 / 被换成非元素 ⇒ 判据不全）。 */
  function rootUsable(root) {
    return isObj(root) && typeof root.contains === 'function'
  }

  /** 元素上第一个 `data-pipeline-*` 属性名（没有就空串）。真 DOM 走 attributes，自测替身走 attrs。 */
  function pipelineAttrOf(el) {
    var attrs = el.attributes
    if (isObj(attrs) && typeof attrs.length === 'number') {
      for (var i = 0; i < attrs.length; i += 1) {
        var node = attrs[i]
        var name = node === null || node === undefined ? '' : String(node.name || '')
        if (name.indexOf(ATTR_PREFIX) === 0) return name
      }
      return ''
    }
    var list = el.attrs
    if (Array.isArray(list)) {
      for (var j = 0; j < list.length; j += 1) {
        if (String(list[j]).indexOf(ATTR_PREFIX) === 0) return String(list[j])
      }
    }
    return ''
  }

  /** 把一次点击的目标压成一小段人话：`BUTTON[data-pipeline-batch-toggle]` / `BODY` / `(空)`。 */
  function describeTarget(target) {
    if (target === null || target === undefined) return '(空)'
    if (!isObj(target)) return '(' + typeof target + ')'
    var tag = typeof target.tagName === 'string' ? target.tagName : typeof target.tag === 'string' ? target.tag : ''
    var attr = pipelineAttrOf(target)
    var out = tag === '' ? (attr === '' ? '(元素)' : attr) : attr === '' ? tag : tag + '[' + attr + ']'
    return out.length > DESC_MAX ? out.slice(0, DESC_MAX) + '…' : out
  }

  /** 记下这一次 pointerdown 打在谁身上（诊断行读它）；即使这一击最后什么都没做也记。 */
  function notePointer(target) {
    LAST.click = describeTarget(target)
    return LAST.click
  }

  /** 诊断行里那一段：`上次点击：BUTTON[...]`（还没点过就是 `—`）。 */
  function lastPointerText() {
    return '上次点击：' + (LAST.click === '' ? '—' : LAST.click)
  }

  /**
   * 造 document 捕获阶段的 pointerdown 处理器：**点面板外面就收起面板**。
   *
   * 三种结论分开处理（这是真机那个 bug 的修法）：
   *   · 里面（`true`）⇒ 不关，只把没被点到的卡片菜单收起来；
   *   · 判不出来（`null` / ref 脱手 / 老环境拿不到 closest）⇒ **不关**；
   *   · 明确在外面（`false` 且 target 真的是连在文档上的元素）⇒ 才 `setOpen(false,'outside')`。
   *
   * @param {object} spec - { rootRef, menuKeyRef, menuRef, menuTriggerRef, closeCardMenu, setPinned, setOpen }
   */
  function makePointerDown(spec) {
    return function onPointerDown(ev) {
      var target = ev === null || ev === undefined ? null : ev.target
      notePointer(target) // 诊断：先记下来，哪怕这一击最后什么都不做
      var rootRef = spec.rootRef
      var root = rootRef === null || rootRef === undefined ? null : rootRef.current
      var inside = targetInsidePanel(target, root)
      if (inside === true) {
        // 面板内部的点击不关面板；但点在卡片菜单 / 那颗「⋯」之外 ⇒ 收起菜单。
        // 菜单自己与触发器要放过，否则 pointerdown 先关、click 又开，等于点不动。
        var menuKeyRef = spec.menuKeyRef
        if (menuKeyRef !== null && menuKeyRef !== undefined && menuKeyRef.current !== '') {
          var menu = spec.menuRef === null || spec.menuRef === undefined ? null : spec.menuRef.current
          var trigger = spec.menuTriggerRef === null || spec.menuTriggerRef === undefined ? null : spec.menuTriggerRef.current
          if (contains(menu, target) !== true && contains(trigger, target) !== true) spec.closeCardMenu()
        }
        return
      }
      if (inside === null) return // 判不出来 ⇒ 不关（以前这里把它当成了"点在外面"）
      // 走到这里 = 判据说"外面"，但还要**明确**：ref 脱手（判据不全）或老环境拿不到 closest ⇒ 不关。
      if (!rootUsable(root)) return
      if (isObj(target) && target.isConnected === true && typeof target.closest !== 'function') return
      spec.setPinned(false)
      spec.setOpen(false, 'outside')
    }
  }

  /** @param {object} deps 依赖（这一块没有依赖，入参只为与其它 chunk 同形） */
  function create(deps) {
    void deps
    return {
      targetInsidePanel: targetInsidePanel,
      describeTarget: describeTarget,
      notePointer: notePointer,
      lastPointerText: lastPointerText,
      makePointerDown: makePointerDown,
    }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-pipeline',
    chunk: 'client.panel-outside.js',
    factory: function (require) {
      var module = { exports: {} }
      module.exports.create = create
      return module.exports
    },
  })
})()
