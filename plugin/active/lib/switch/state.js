// 功能开关的**状态本身**：落盘文件 ↔ 内存的那根线，以及"现在到底是开还是关"的唯一读法。
/**
 * dsh-pipeline · 功能开关 · 状态（唯一权威源）
 * ============================================================================
 * 「多 AI 协调功能」的开 / 关。**开** = 编排 + 守门 + 状态机全管；
 * **关** = 本插件不再拦任何调用、不再往任何会话注入消息（回到普通 DSH 行为），
 * 只剩"流水线的写操作被拒"这一条**故意**保留。逐条面清单见 `lib/switch/gate.js`。
 *
 * ---------------------------------------------------------------------------
 * 本文件负责什么（只此一件事）
 * ---------------------------------------------------------------------------
 *   · 状态**从哪来**：`<项目根>/.pipeline/switch.json`（构造期同步读一次）；
 *   · 状态**存在哪**：内存里的一个 `{on, since, by, reason, revision}`；
 *   · 状态**怎么改**：`set()` / `toggle()` —— 落盘（原子替换）+ 通知订阅者；
 *   · 状态**怎么读**：{@link readSwitchState} —— **全插件唯一的读法**。
 *
 * ★ 它**不做判断**："关掉时哪些面该停"是**策略**，在 `lib/switch/gate.js` 里。
 *   两者分开的理由：策略会随"又想起一个拦截面"而改，而状态存储不该跟着改；
 *   混在一起就会长出"每个拦截面自己读一遍开关"——那正是缺陷"开关只关一半"的成因。
 *
 * ---------------------------------------------------------------------------
 * 为什么是"开关位 + 读取者"而不是"卸载插件"
 * ---------------------------------------------------------------------------
 * 关掉时**不注销工具、不注销守卫**：
 *   · `ctx.tools.guard()` 注销再重注册会改变守卫在 `ToolLayer.guards` 里的**顺序**，
 *     而守卫链是"取第一个非 undefined"（`dsh-tools:2646-2651`）。顺序一变，
 *     与 dsh-archigate 同时命中时的**拒绝文案**就会跟着变 —— 那是对用户可见的行为抖动。
 *   · 工具注销再注册会让模型看到的工具表在会话中途改变，容易触发"工具消失"的困惑。
 *   ★ 但**拦截缝**（`ctx.on`）不在此列：缝的顺序对用户不可见，所以它可以按开关
 *     真挂真摘 —— 见 `lib/intercept/registry.js`。
 *
 * ★ 同步性是硬要求：`guardReason` 是**同步**遍历（`dsh-tools:2928`），
 *   所以判据必须是同步的内存读，不能 await、不能读盘。
 *   落盘是**写路径**上的副作用，失败也不影响内存里的真相。
 *
 * @module dsh-pipeline/lib/switch/state
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 开关状态的版本号（状态文件格式变了就 +1，便于将来迁移）。 */
export const SWITCH_STATE_VERSION = 1

/**
 * 建一个功能开关。
 *
 * @param {object} opts
 * @param {string} opts.stateFile - 状态文件绝对路径（父目录不存在会自动建）
 * @param {boolean} [opts.initial] - 首次启动（没有状态文件时）的初值，默认 true
 * @param {() => Date} [opts.now]
 * @param {(m:string)=>void} [opts.log]
 */
export function createSwitch(opts) {
  const stateFile = opts.stateFile
  const now = typeof opts.now === 'function' ? opts.now : () => new Date()
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const isoTimestamp = () => now().toISOString().replace(/\.\d{3}Z$/, 'Z')

  /** @type {{on:boolean, since:string, by:string, reason:string, revision:number}} */
  let state = {
    on: opts.initial !== false,
    since: isoTimestamp(),
    by: 'startup',
    reason: '首次启动的默认值（还没有状态文件）',
    revision: 0,
  }

  // --- 读盘恢复（同步：构造期做一次，之后内存为准）-------------------------
  let restored = false
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (raw !== null && typeof raw === 'object' && typeof raw.on === 'boolean') {
      state = {
        on: raw.on,
        since: typeof raw.since === 'string' ? raw.since : isoTimestamp(),
        by: typeof raw.by === 'string' ? raw.by : 'state-file',
        reason: typeof raw.reason === 'string' ? raw.reason : '',
        revision: Number.isInteger(raw.revision) ? raw.revision : 0,
      }
      restored = true
    }
  } catch (err) {
    // 文件不存在 = 首次启动，正常路径。解析失败要说出来，不能静默当成"开"。
    if (err?.code !== 'ENOENT') log(`状态文件读取失败，按默认值启动：${String(err?.message ?? err)}`)
  }

  /** 订阅者（客户端长轮询 / 日志 / **拦截缝的挂载编排**用；判据不走这里）。 */
  const listeners = new Set()

  const persist = () => {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const tmp = `${stateFile}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ version: SWITCH_STATE_VERSION, ...state }, null, 2)}\n`, 'utf8')
      renameSync(tmp, stateFile)
      return true
    } catch (err) {
      // 落盘失败不影响内存里的真相；但要说出来，否则"重启后自己变回去了"会很难查。
      log(`状态落盘失败（内存态仍然生效，重启会丢）：${String(err?.message ?? err)}`)
      return false
    }
  }

  const api = {
    /** ★ 同步读。**只读事实**；"关掉该怎样"是 `lib/switch/gate.js` 的事。 */
    isOn() {
      return state.on === true
    },

    /** 完整快照（给 UI / 工具 / 审计用）。 */
    snapshot() {
      return { ...state, stateFile, restored }
    },

    /**
     * 翻转或设定。
     *
     * @param {boolean} on
     * @param {object} [meta] - `{ by, reason }`
     * @returns {{changed:boolean, state:object, persisted:boolean}}
     */
    set(on, meta = {}) {
      const next = on === true
      if (next === state.on) {
        return { changed: false, state: api.snapshot(), persisted: true }
      }
      state = {
        on: next,
        since: isoTimestamp(),
        by: typeof meta.by === 'string' && meta.by.length > 0 ? meta.by : 'unknown',
        reason: typeof meta.reason === 'string' ? meta.reason : '',
        revision: state.revision + 1,
      }
      const persisted = persist()
      for (const fn of listeners) {
        try {
          fn(api.snapshot())
        } catch (err) {
          log(`订阅者抛错（已忽略）：${String(err?.message ?? err)}`)
        }
      }
      return { changed: true, state: api.snapshot(), persisted }
    },

    /** 翻转。 */
    toggle(meta = {}) {
      return api.set(!state.on, meta)
    },

    /** 订阅变更。返回取消订阅的函数。 */
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {}
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    /** 状态文件路径（文档与排障用）。 */
    stateFile,
  }

  return api
}

/** 默认状态文件位置：`<项目根>/.pipeline/switch.json`。 */
export function defaultSwitchStateFile(projectRoot, artifactDirName = '.pipeline') {
  return join(projectRoot, artifactDirName, 'switch.json')
}

/**
 * ★★ **全插件唯一一次读开关**（同步、纯读、不抛）。
 *
 * 纪律：**任何地方都不许直接写 `sw.isOn()`** —— "每个面各自读一遍"正是缺陷
 * "开关只关一半"的结构性成因（守门读了、四条拦截缝一条没读）。
 * 判据只有一个出口，才能保证"关 = 彻底摘干净"这句话在同一次改动里对所有面成立。
 *
 * ★ 失败时偏向哪一边（刻意与守门同向，别改）：
 *   · `sw` 没给（自测替身 / 装配不全）⇒ **按"开"**：这些面是插件的本体，
 *     "没装开关"不等于"用户关了它"；本仓库既有自测大量走这条默认。
 *   · `sw.isOn()` 抛错 ⇒ **按"开"**，与 `lib/guard-factory.js` 的 fail-closed 一致
 *     （读开关失败就一律弃权，等于给出一条"弄坏开关文件即可绕过"的路）。
 *     需要**区分**"关"与"读不出来"的调用方（守门）用 `error` 字段自己决定。
 *
 * @param {{isOn?:()=>boolean}|null|undefined} sw - `createSwitch` 的产物
 * @returns {{on:boolean, error:string|null}} `on` = 事实上的开/关；`error` 非 null = 读取抛错
 */
export function readSwitchState(sw) {
  if (sw === null || sw === undefined) return { on: true, error: null }
  if (typeof sw.isOn !== 'function') return { on: true, error: null }
  try {
    return { on: sw.isOn() === true, error: null }
  } catch (err) {
    return { on: true, error: String(err?.message ?? err) }
  }
}
