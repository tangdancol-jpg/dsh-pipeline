// 周期机制（巡检 / 孤儿单自恢复）⇄ 总开关：关 ⇒ 停表、开 ⇒ 起表，并且**如实**播报。
/**
 * dsh-pipeline · 功能开关 · 周期机制起停
 * ============================================================================
 * 缺陷里的"半挂面"就是本文件管的这半边。改前两者的定时器与开关**毫无关系**：
 *   · **巡检兜底**（`lib/patrol.js`）每轮都会 `wakeup.wake` + `wakeup.escalateUnconsumed`
 *     ⇒ 往会话注入 + 写 `.pipeline` 账本；
 *   · **孤儿单自恢复**（`lib/orphan.js`）会**主动往席位会话重新投递** + 写账本与审计。
 * 关掉功能之后它们照跑照写 —— 磁盘上、别的会话里都能看见本插件还在动。
 *
 * ---------------------------------------------------------------------------
 * 为什么是"停表"而不是"跑着但空转"
 * ---------------------------------------------------------------------------
 *   · 空转仍然会留下痕迹（账本/审计），"关掉"这句话在磁盘上就不成立；
 *   · `running()` 是**程序化可核对**的（`patrol.running()` / `orphanRescue.running()`），
 *     空转只能靠读代码相信 —— 本项目刚吃过一次"文案说弃权、实际还在跑"。
 *
 * ---------------------------------------------------------------------------
 * 为什么是**导出的工厂**（而不是埋在 `index.js` 的 `apply()` 里）
 * ---------------------------------------------------------------------------
 * 与 `index.js` 的 `createSeatFaceTightener` 同一条理由：它是一次**会真的起停定时器、
 * 真的影响磁盘写入**的动作，所以必须能被**独立复现与断言** —— 自测要能拿两个假机制
 * 把它跑一遍，看它到底有没有在关掉时停手。埋在 `apply()` 里就只能靠读代码相信。
 *
 * ★ 纪律四条（都写在判据里，不是写在善意里）：
 *   ① 起停**幂等**：`start()/stop()` 各自在"已经在那个状态"时返回 false，
 *      重复翻转不会叠出第二个定时器；
 *   ② 任一机制抛错**只留痕、不外抛**：它们是"能更好"，不是判据；
 *   ③ 判据**只有一处**：`lib/switch/gate.js` 的 `isEnabled()`，本文件不另读开关；
 *   ④ 播报**必须如实**：只有 `start()` 真的返回 true 才配说"已启动"（改前那句
 *      "巡检兜底已启动"是**无条件**打的，开关关着时它就是假的）。
 *
 * @module dsh-pipeline/lib/switch/mechanisms
 */

import { isEnabled } from './gate.js'

/**
 * 造一个"跟着开关起停"的驱动。
 *
 * @param {object} opts
 * @param {{isOn?:()=>boolean, subscribe?:(fn:Function)=>()=>void}} opts.sw - 总开关
 * @param {Array<{id:string, start?:()=>boolean, stop?:()=>boolean}>} opts.items - 受管的周期机制
 * @param {(m:string)=>void} [opts.warn]
 * @returns {{apply:()=>Array<object>, snapshot:()=>object, dispose:()=>void}}
 */
export function createSwitchDrivenMechanisms(opts = {}) {
  const sw = opts.sw ?? null
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {}
  const items = (Array.isArray(opts.items) ? opts.items : []).filter((x) => x !== null && x !== undefined && typeof x.id === 'string')

  /** 最近一次结论（只读导出 / 排障用；形状与 `lastSeatFaceTighten` 同一种做法）。 */
  let last = { at: null, off: false, applied: [], warned: false }
  let disposed = false

  /**
   * 按开关的当前状态**起或停**每一个机制。返回逐条结论（结构化，供自测断言）。
   *
   * @returns {Array<{id:string, off:boolean, changed:boolean, error:string|null}>}
   */
  const apply = () => {
    const off = !isEnabled(sw)
    const applied = []
    for (const it of items) {
      try {
        const fn = off ? it.stop : it.start
        // ★ 机制没提供那一半（自测替身）⇒ 记 changed:false，不编造一个结论。
        const changed = typeof fn === 'function' ? fn() === true : false
        applied.push({ id: it.id, off, changed, error: null })
      } catch (err) {
        // ★ 不许外抛：机制起不来不影响插件本体，但**必须留下痕迹**。
        applied.push({ id: it.id, off, changed: false, error: String(err?.message ?? err) })
        warn(`[pipeline] 按总开关${off ? '停' : '起'}周期机制「${it.id}」失败（不影响插件本体）：${String(err?.message ?? err)}`)
      }
    }
    last = { at: new Date().toISOString(), off, applied, warned: applied.some((a) => a.error !== null) }
    return applied
  }

  // ★ 先按装载时的真相跑一次，再订阅后续翻转 —— 开关是**即时**生效的。
  apply()
  let unsubscribe = null
  if (typeof sw?.subscribe === 'function') {
    try {
      unsubscribe = sw.subscribe(apply)
    } catch (err) {
      warn(`[pipeline] 订阅总开关失败（周期机制不会跟随开关翻转）：${String(err?.message ?? err)}`)
    }
  }

  return {
    apply,
    snapshot: () => ({ ...last, item_ids: items.map((i) => i.id), unsubscribed: unsubscribe === null }),
    dispose: () => {
      if (disposed) return
      disposed = true
      if (typeof unsubscribe === 'function') {
        try {
          unsubscribe()
        } catch {
          /* 退订失败不影响结论 */
        }
      }
    },
  }
}

/** 把毫秒说成"每 N 分钟"（播报用；两边口径一致）。 */
const mins = (ms) => Math.round(Number(ms ?? 0) / 60000)

/**
 * ★ 造本插件**已知的两条周期机制**的条目（真起 / 真停 / 如实播报）。
 *
 * @param {object} opts
 * @param {object|null} [opts.patrol] - `createPatrol()` 的产物（未启用则 null）
 * @param {object|null} [opts.orphanRescue] - `createOrphanRescue()` 的产物（未启用则 null）
 * @param {object} opts.config - 插件配置（只读几个时长/次数）
 * @param {(m:string)=>void} [opts.log] - 播报（`ctx.logger.info`）
 * @returns {Array<{id:string, start:()=>boolean, stop:()=>boolean}>}
 */
export function createMechanismItems({ patrol = null, orphanRescue = null, config = {}, log = () => {} } = {}) {
  const items = []

  if (patrol !== null && patrol !== undefined) {
    items.push({
      id: 'patrol',
      start: () => {
        const ok = patrol.start() === true
        // ★ 只有真的起了表才配说"已启动"（改前那句是无条件的 ⇒ 开关关着时是假的）。
        if (ok) {
          log(
            `[pipeline] 巡检兜底已启动：每 ${mins(config.patrolIntervalMs)} 分钟一轮，` +
              `无进展口径 ${mins(config.patrolStallMs)} 分钟，未接管升级口径 ${mins(config.wakeUnconsumedMs)} 分钟（**只播报，不动作**）。`,
          )
        }
        return ok
      },
      stop: () => {
        const ok = patrol.stop() === true
        if (ok) log('[pipeline] 巡检兜底**已停表**（多AI 协调开关=关）—— 开关打开时会自动起表。')
        return ok
      },
    })
  }

  if (orphanRescue !== null && orphanRescue !== undefined) {
    items.push({
      id: 'orphan-rescue',
      start: () => {
        const ok = orphanRescue.start() === true
        if (ok) {
          log(
            `[pipeline] 孤儿单自恢复已启动：每 ${mins(config.orphanIntervalMs)} 分钟一轮，` +
              `判定窗 ${mins(config.orphanGraceMs)} 分钟，失败退避 ${mins(config.orphanRedeliverBackoffMs)} 分钟，` +
              `同一身份最多重投 ${config.orphanMaxRedeliverAttempts} 次（**不建会话、不派新席位、不改状态**）。`,
          )
        }
        return ok
      },
      stop: () => {
        const ok = orphanRescue.stop() === true
        if (ok) log('[pipeline] 孤儿单自恢复**已停表**（多AI 协调开关=关）—— 开关打开时会自动起表。')
        return ok
      },
    })
  }

  return items
}
