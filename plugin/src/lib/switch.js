/**
 * dsh-pipeline · 功能开关（客户端 UI ↔ 宿主机制之间的那根线）
 * ============================================================================
 * 「多 AI 协调功能」的开 / 关。**开** = 编排 + 守门 + 状态机全管；
 * **关** = 守门不介入、流水线的写操作被拒，回到普通 DSH 行为。
 *
 * ---------------------------------------------------------------------------
 * 为什么是"开关位 + 读取者"而不是"卸载插件"
 * ---------------------------------------------------------------------------
 * 关掉时**不注销工具、不注销守卫**：
 *   · `ctx.tools.guard()` 注销再重注册会改变守卫在 `ToolLayer.guards` 里的**顺序**，
 *     而守卫链是"取第一个非 undefined"（`dsh-tools:2646-2651`）。顺序一变，
 *     与 dsh-archigate 同时命中时的**拒绝文案**就会跟着变 —— 那是对用户可见的行为抖动。
 *   · 工具注销再注册会让模型看到的工具表在会话中途改变，容易触发"工具消失"的困惑。
 *
 * 所以：**结构恒常，行为可变**。守门第一句就是 `if (!sw.isOn()) return undefined`。
 *
 * ★ 同步性是硬要求：`guardReason` 是**同步**遍历（`dsh-tools:2928`），
 *   所以 `isOn()` 必须是同步的内存读，不能 await、不能读盘。
 *   落盘是**写路径**上的副作用，失败也不影响内存里的真相。
 *
 * @module dsh-pipeline/lib/switch
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

  /** 订阅者（客户端长轮询 / 日志用；守门不走这里，它直接读 isOn()）。 */
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
    /** ★ 同步读。守门与工具都走这里。 */
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
