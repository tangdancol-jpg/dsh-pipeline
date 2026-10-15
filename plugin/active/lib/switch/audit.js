// 闸门的**观测**：把"哪条缝挂了 / 被问了几次 / 放行了几次 / 拦了几次"记成可断言的计数。
/**
 * dsh-pipeline · 功能开关 · 观测（拦截计数）
 * ============================================================================
 * 为什么必须有它：本次缺陷能溜过去，正是因为**没有被观测的行为**。
 * 原有的自测只看 `tools/pre-execute` 的**返回值**是否变成 `enter` ——
 * 而"关了但仍在拦"的那条缝（`post-execute` 第二道网）根本不在观测面里，
 * 于是"全绿"是**假绿**。
 *
 * 所以关掉时的判据不能只看返回值，要看**计数**：
 *   · `registered`  —— 此刻真的挂着的缝（关掉 ⇒ 空集）
 *   · `asked[hook]` —— 闸门被问了几次（关掉 ⇒ 一次都不问，因为缝根本没挂）
 *   · `fired[hook]` —— 真的动手拦了几次（关掉 ⇒ 0）
 *
 * ★ 纪律：**计数只在内存里**，绝不落盘 —— 观测本身不能变成"关掉之后还在写盘"的东西。
 * ★ 不抛：记数失败绝不能影响任何一次工具调用。
 *
 * @module dsh-pipeline/lib/switch/audit
 */

/**
 * 造一个观测台账。
 *
 * @param {(m:string)=>void} [opts.warn]
 * @returns {object} 见下方各方法
 */
export function createHookAudit(opts = {}) {
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {}
  /** 当前挂着的缝：hookId → 挂载次数 */
  const registered = new Map()
  /** 闸门被问的次数 */
  const asked = new Map()
  /** 真的动手拦下的次数 */
  const fired = new Map()
  /** 放行次数 */
  const passed = new Map()
  /** 挂/摘的历史（有界；排障用） */
  const history = []

  const bump = (map, key) => {
    if (typeof key !== 'string' || key.length === 0) return
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  const push = (entry) => {
    history.push(entry)
    if (history.length > 128) history.shift()
  }

  return {
    /** 记一次"这条缝挂上了"。 */
    noteMount(hookId) {
      try {
        bump(registered, hookId)
        push({ at: new Date().toISOString(), what: 'mount', hook: hookId })
      } catch (err) {
        warn(`[pipeline] 拦截观测记数失败（不影响任何调用）：${String(err?.message ?? err)}`)
      }
    },

    /** 记一次"这条缝摘掉了"。 */
    noteUnmount(hookId) {
      try {
        if (registered.has(hookId)) registered.set(hookId, registered.get(hookId) - 1)
        if (registered.get(hookId) === 0) registered.delete(hookId)
        push({ at: new Date().toISOString(), what: 'unmount', hook: hookId })
      } catch (err) {
        warn(`[pipeline] 拦截观测记数失败（不影响任何调用）：${String(err?.message ?? err)}`)
      }
    },

    /** 记一次"闸门被问"。 */
    noteAsked(hookId, allowed) {
      try {
        bump(asked, hookId)
        if (allowed === true) bump(passed, hookId)
        else bump(fired, hookId)
      } catch (err) {
        warn(`[pipeline] 拦截观测记数失败（不影响任何调用）：${String(err?.message ?? err)}`)
      }
    },

    /**
     * ★ 只读快照（自测/排障/`pipeline_status` 都能读）。
     *
     * @returns {{registered:string[], asked:object, fired:object, passed:object, history:object[]}}
     */
    snapshot() {
      const obj = (m) => Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
      return {
        registered: [...registered.keys()].sort(),
        asked: obj(asked),
        fired: obj(fired),
        passed: obj(passed),
        history: [...history],
      }
    },
  }
}

/**
 * 包一层：把"问闸门 + 记数"合成一句，缝里只写这一行。
 *
 * @param {object} deps
 * @param {ReturnType<typeof createHookAudit>} deps.audit
 * @param {(hookId:string)=>boolean} deps.shouldFire - 闸门（`lib/switch/gate.js` 的 `shouldFire` 偏函数）
 * @param {string} deps.hookId
 * @returns {() => boolean} true = 这条缝该动手
 */
export function createSeamGate({ audit, shouldFire, hookId }) {
  return function seamGate() {
    let allowed = false
    try {
      allowed = shouldFire(hookId) === true
    } catch {
      // 闸门自己炸了 ⇒ 不动手（fail-safe：宁可不拦，也不要在开关关掉时乱拦）。
      allowed = false
    }
    audit?.noteAsked?.(hookId, allowed)
    return allowed
  }
}
