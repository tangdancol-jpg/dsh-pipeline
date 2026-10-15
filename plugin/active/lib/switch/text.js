// 关掉时的**文案唯一出处**：说给人/模型听的每一句都由这里生成，杜绝"文案说 A、行为是 B"。
/**
 * dsh-pipeline · 功能开关 · 文案（唯一出处）
 * ============================================================================
 * 为什么单独一个文件：本次缺陷的**措辞侧现场**就是"文案在一处写、行为在另一处改" ——
 * `lib/tools/admin.js` 写着「守门已弃权（**任何调用都不再被本插件拦**）」，
 * 而 `lib/intercept.js` 的第二道网根本不知道有开关这回事。
 *
 * 所以：**一份文案一个出处**，而且它**引用** `lib/switch/gate.js` 的 `SWITCH_SURFACES`
 * 生成 ⇒ "清单里加了面、文案忘了改"在结构上不可能发生。
 *
 * 本文件**只拼字符串**，不读开关、不做判断（事实从参数进来）。
 *
 * @module dsh-pipeline/lib/switch/text
 */

import { SWITCH_SURFACES } from './gate.js'

/** 按 `off` 行为分组（清单永远是唯一来源）。 */
const byOff = (off) => SWITCH_SURFACES.filter((s) => s.off === off)

/**
 * ★★ **关掉时如实要说的话**（工具返回、启动日志、UI tooltip 共用这一份）。
 *
 * @param {object} [snap] - `sw.snapshot()`（用于报告状态文件位置；可省）
 * @returns {string[]} 行数组（调用方自己 join）
 */
export function offModeCopy(snap = {}) {
  const inert = byOff('inert')
  const stopped = byOff('stopped')
  const refuse = byOff('refuse')
  const allowed = byOff('allowed')
  const L = []
  L.push('关闭后**本插件不再拦任何东西、不再往任何会话注入任何消息**。已停掉的面（逐条）：')
  for (const s of inert) L.push(`  · 【不生效】${s.label}`)
  for (const s of stopped) L.push(`  · 【停表】${s.label}`)
  L.push(`  · 合计 ${inert.length + stopped.length} 个拦截面/注入面/周期机制 —— 判据只有一处：lib/switch/gate.js 的 isEnabled() / shouldFire()`)
  L.push('')
  L.push('关掉后**故意**仍然生效的两类（不是"没关干净"，是语义本身）：')
  L.push(`  · 【仍然拒绝】${refuse.map((s) => s.label).join('、')} —— 关掉功能的语义就是"不干活"，放行写操作等于在没有守门的情况下继续推进状态机。`)
  L.push(`  · 【允许照常】${allowed.map((s) => s.label).join('、')} —— 无害只读；其中开关端点**必须**留着，否则关一次就再也开不回来。`)
  if (typeof snap.stateFile === 'string' && snap.stateFile.length > 0) {
    L.push('')
    L.push(`开关自己的状态文件：${snap.stateFile}（关掉状态下**项目目录里**唯一还会被本插件写入的文件，且只在切换那一刻写）。`)
  }
  return L
}

/**
 * 关掉时的**面清单**（结构化，给自测与排障用；给人看的话走 {@link offModeCopy}）。
 *
 * @returns {{inert:string[], stopped:string[], refuse:string[], allowed:string[]}}
 */
export function offModeReport() {
  const pick = (off) => byOff(off).map((s) => s.id)
  return { inert: pick('inert'), stopped: pick('stopped'), refuse: pick('refuse'), allowed: pick('allowed') }
}

/**
 * 关掉时**启动日志**要说的话（`index.js` 装配末尾用；与工具返回同一份出处）。
 *
 * @param {object} snap - `sw.snapshot()`
 * @param {string} statePath - 开关 HTTP 端点路径
 * @returns {string[]}
 */
export function offModeStartupLines(snap, statePath) {
  if (snap !== null && snap !== undefined && snap.on === true) return []
  return [
    `\n[pipeline] ⚠ 当前开关是**关**：不再拦任何调用、不再往任何会话注入消息；` +
      `周期机制（巡检 / 孤儿单自恢复）**未启动**。仍然生效的只有两类：写操作被拒、只读面照常。`,
    `\n[pipeline] 关掉状态下面清单（与 pipeline_switch 的返回文案同一份出处）：\n  ${offModeCopy(snap).join('\n  ')}`,
    `（开关端点 ${statePath} 仍然可用 —— 关掉它 = 关一次就再也开不回来。）`,
  ]
}

/** 写操作在关掉状态下的统一拒答文案（`lib/tools/kit.js` 用；也在这里，理由同文件头）。 */
export function mutatingOffRefusal(toolName) {
  return (
    '[pipeline] 多 AI 协调功能当前是**关闭**状态，本动作不会执行。\n' +
    `工具：${String(toolName ?? '(未知)')}\n` +
    '怎么恢复：把 DSH 窗口右上角头部那一排里的「多AI 协调」开关点成「开」，' +
    '或者让主对话调用 pipeline_switch { on: true }，或者调用 pipeline_switch 不带参数直接翻转。\n' +
    '关闭状态下仍然可用的是只读动作：pipeline_status（查历史任务）、pipeline_switch（看/改开关）、pipeline_selftest（自检）。'
  )
}
