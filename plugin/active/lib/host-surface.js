// 本插件对宿主的**装配面**：声明（`inject`）与读取（`ctx.get`，不带 inject 要求）。
/**
 * dsh-pipeline · 宿主装配面（inject 声明 + 服务读取）
 * ============================================================================
 * ★★ 缺陷 B 的现场（真机，`pipeline_recall` 自报，逐字）：
 * ```
 * 水位：读不到（读投影失败：cannot get property "sessionProjections" without inject）—— 不下调
 * ```
 * ⇒ E5 的"按上下文水位下调 recall 上限"**一次都没生效过**。
 * 这不是逻辑错（`lib/memory/budget.js` 的纯函数与 m6 的表都对），是**装配面缺一项**：
 * 服务没写进 `inject` ⇒ 直接取属性就抛。
 *
 * ---------------------------------------------------------------------------
 * 为什么是这两项（判据，不是"多注入一点更保险"）
 * ---------------------------------------------------------------------------
 *   · `tools` —— 全部工具面都靠 `ctx.tools.register()` 注册（`apply` 的第一件事）。
 *   · `sessionProjections` —— 会话投影注册表（**核心服务**；DSH 自己也多处
 *     `static inject = ['tools','sessionProjections']`，例如 PlanModeController）。
 *     水位（`contextPressure`，E5）与逐轮大纲（`turnOutline`，E3）都只能从这里读。
 *
 * ★ 为什么**不**把 `agents` / `sessionProjectionCache` 也写进 `inject`：
 *   `inject` 是**装配期依赖** —— 少一个服务的构建上，插件**根本装不上**（一条缝都不挂）。
 *   `sessionProjectionCache` 由可选包 `@deepseek-ai/dsh-session-projection-cache` 提供；
 *   写进 inject = 在没有那个包的构建上**整个插件起不来**，而它只是一条兜底路径。
 *   ⇒ 这两项走 {@link readHostService}（运行期探测：拿到就用、拿不到就降级）。
 *   这条口径与 `index.js` 那句"少一个服务依赖就少一种装不上的方式"是**同一条**。
 *
 * ---------------------------------------------------------------------------
 * `ctx.get` 为什么是"不带 inject 要求"的读法（判据在宿主自己那里，不是我们的推断）
 * ---------------------------------------------------------------------------
 *   · Cordis 的 `ReflectService.get` 逐字写着：
 *       "Read a service from the store **without the inject requirement**."
 *       `@returns the service value, or `undefined` when not (yet) provided`
 *     ——拿到就给、没提供就 `undefined`、**不抛**。
 *   · `ctx.X` 这种**直接取属性**走的是另一个 proxy trap（`ReflectService.handler.get`）：
 *     属性不在当前上下文时，它 new 一个
 *       `cannot get property "X" without inject`
 *     当**错误载体**，再由 `internal/get` 那条 waterfall 决定给还是抛 —— 真机上抛了
 *     （就是上面那行现场）。所以"运行期探测"**不能**写成直接取属性。
 *   ⇒ 可选服务一律 `ctx.get`；只有**装载前就必须在**的服务才写进 `inject`。
 *   本仓库另外两处（`lib/wakeup/deliver.js` / `lib/transport/presets.js`）已是同一写法。
 *
 * ★ `inject` 是**装配期**依赖：改它要**重启 DSH** 才生效（热重载不会重新装配注入面）。
 *
 * @module dsh-pipeline/lib/host-surface
 */

/**
 * ★★ 本插件的装配期依赖（**精确集合**：顺序即声明顺序）。
 *
 * ★ `index.js` 的 `inject` 直接 re-export 它 —— 别处**不许**再写第二份。
 *   `tests/load-smoke.mjs` 有一条"精确相等"的哨兵盯着这个面（改动必红）。
 */
export const PLUGIN_INJECT = Object.freeze(['tools', 'sessionProjections'])

/** 每一项**为什么在**这里（测试与报告都读它，免得理由只活在注释里）。 */
export const INJECT_RATIONALE = Object.freeze({
  tools: '全部工具面都靠 ctx.tools.register() 注册（apply 的第一件事）',
  sessionProjections: '会话投影注册表：水位 contextPressure（E5）与逐轮大纲 turnOutline（E3）的唯一来源',
})

/** ★ **运行期探测**的服务（不写进 inject：拿不到就降级，绝不让插件装不上）。 */
export const PROBED_SERVICES = Object.freeze(['agents', 'sessionProjectionCache', 'tokenMeter'])

/**
 * ★ 读一个宿主服务：**不抛**、拿不到回 `undefined`。
 *
 * 与 `lib/wakeup/deliver.js` / `lib/transport/presets.js` 同一条口径（`ctx.get` 优先，
 * 退到直接取属性仍然包在 try 里）—— 差别只在这里是**共享**的那一份。
 *
 * @param {object} ctx - Cordis 上下文（可以是自测替身）
 * @param {string} name - 服务名
 * @returns {*} 服务实例，拿不到 ⇒ `undefined`
 */
export function readHostService(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined
  if (typeof ctx.get === 'function') {
    try {
      const got = ctx.get(name)
      if (got !== undefined && got !== null) return got
    } catch {
      /* Cordis 的 get 理论上不抛；真抛了也不许把它带给调用方 */
    }
  }
  try {
    return ctx[name]
  } catch {
    // ★ 直接取属性在"没 inject"时会抛 —— 那正是本文件存在的理由：如实回 undefined。
    return undefined
  }
}
