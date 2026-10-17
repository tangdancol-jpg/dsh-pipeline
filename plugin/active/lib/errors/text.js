/**
 * dsh-pipeline · **拒绝/提示文案模板（唯一出处）**
 * ============================================================================
 * 这个文件收的是**固定文案**（以及只差一个参数的模板）—— 判断仍在各自的原处，
 * 这里**只拼字符串、不做判断**（事实从参数进来）。
 *
 * ---------------------------------------------------------------------------
 * 为什么值得集中：文案是**调用方唯一的行动依据**
 * ---------------------------------------------------------------------------
 * 本插件的大量自测是**按字面断言**的（`text.includes('找不到任务')`、
 * `assert(code === '…')` 那种）。同一句话在 13 个文件里各写一遍时，
 * 只要有一处被"顺手润色"一个字，要么测试红、要么**用户看到的拒绝理由变了**
 * 而没人发现。所以：**一份文案一个出处**，值逐字相同（这次重构不改任何字面值）。
 *
 * ---------------------------------------------------------------------------
 * 收录判据（宁缺毋滥）
 * ---------------------------------------------------------------------------
 *   ① 同一个**字面量**在范围内出现 ≥2 次（跨文件优先）；
 *   ② 替换后**逐字节等价**（参数原样插值，不加不删任何字符）。
 * 两条都满足才收。拿不准的**一律不动**，宁可留一份重复也不冒改文案的风险。
 *
 * ---------------------------------------------------------------------------
 * 与 `lib/switch/text.js` 的关系
 * ---------------------------------------------------------------------------
 * 关掉功能时的那套文案原本住在 `lib/switch/text.js`（它自成一体、有完整的设计
 * 说明），本次把它**整段搬到这里**，再由 `lib/switch/text.js` **原样再导出**：
 * 原有导出名一个不改、字符串一个字不改，调用方（`tools/admin.js` / `tools/kit.js`
 * / `index.js`）不需要动。
 *
 * @module dsh-pipeline/lib/errors/text
 */

import { SWITCH_SURFACES } from '../switch/gate.js'

// ---------------------------------------------------------------------------
// 一、通用拒绝 / 提示模板
// ---------------------------------------------------------------------------

/**
 * 「找不到任务 <id>。」—— 全插件最高频的那一句（17 处 / 13 个文件）。
 *
 * ★ 调用方传什么就原样插什么（`undefined` 会渲染成 `undefined`），与改动前
 *   `` `找不到任务 ${x}。` `` 逐字节相同 —— 包括那个全角句号。
 *
 * @param {unknown} taskId
 * @returns {string}
 */
export function taskNotFound(taskId) {
  return `找不到任务 ${taskId}。`
}

/** 「必须给 task_id。」（参数缺 `task_id` 时的统一拒答）。 */
export const TASK_ID_REQUIRED = '必须给 task_id。'

/**
 * 长入参通道的「被拒路径：…」行（`tools/args-file.js` 的每一次拒收都带它）。
 *
 * ★ 用户的要求是"越界必须给明确文案（点明判据 + 被拒路径）"，
 *   所以这一行是**判据的一部分**，不是装饰 —— 集中它才不会有人少写一处。
 *
 * @param {unknown} path
 * @returns {string}
 */
export function rejectedPath(path) {
  return `被拒路径：${path}`
}

/**
 * 「允许写的位置（唯一）：<dir><角色>[-后缀].<扩展名>」那一行。
 *
 * ★ 出处有两处：`guard/page-exts.js` 的 `ownPathHint()`（缺陷 ④ 的"可行替代"）
 *   与 `guard/decide.js` 的"只能写自己那一片"拒绝文案。两处**说的必须是同一句话**
 *   —— 否则被拒的人会看着两份不同的"允许范围"猜。
 *
 * @param {string} dir - 允许写的目录（绝对路径，以 `/` 结尾）
 * @param {string} role - 角色名
 * @param {string} extsCsv - 扩展名，`|` 分隔
 * @returns {string}
 */
export function ownPathLine(dir, role, extsCsv) {
  return `允许写的位置（唯一）：${dir}${role}[-后缀].${extsCsv}`
}

// ---------------------------------------------------------------------------
// 二、功能开关：关掉时的文案（原 `lib/switch/text.js`，逐字搬入）
// ---------------------------------------------------------------------------
//
// 为什么单独一个文件：本次缺陷的**措辞侧现场**就是"文案在一处写、行为在另一处改" ——
// `lib/tools/admin.js` 写着「守门已弃权（**任何调用都不再被本插件拦**）」，
// 而 `lib/intercept.js` 的第二道网根本不知道有开关这回事。
//
// 所以：**一份文案一个出处**，而且它**引用** `lib/switch/gate.js` 的 `SWITCH_SURFACES`
// 生成 ⇒ "清单里加了面、文案忘了改"在结构上不可能发生。

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
    '或者让主对话调用 pipeline_switch { on: true }，或者调用 pipeline_switch 不带参数直接翻转。' +
    '关闭状态下仍然可用的是只读动作：pipeline_status（查历史任务）、pipeline_switch（看/改开关）、pipeline_selftest（自检）。'
  )
}
