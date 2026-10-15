// 提示词层的那两条硬约束 + 席位开场简报（拦截缝 ② 的判据与文案）。
/**
 * dsh-pipeline · 拦截缝 · 提示词判据与席位简报
 * ============================================================================
 * 用户原话（Stop Ladder 四问）：
 *   「用户让你做了吗？结果需要它吗？有证据吗？没它会失败吗？」
 *
 * ★ 这四问是**引导**，不是判据 —— 真正的拦截在 `lib/guard/hook-pre.js`（代码层）。
 *   四问随 `agent/pre-step` 注入，让席位在"想多干一点"的时候自己停一下。
 *
 * ★ {@link judgePrompt} 刻意**只判两条硬约束**（其余一律放行）——
 *   提示词层面的误伤比漏判更贵：
 *     · 编写席位 + 提示词里出现测试命令 ⇒ 拒（判据复用 `scanTestRunnerCommand`）
 *     · 控制角色 + 提示词里出现"读代码"的同现 ⇒ 拒（动词 + 代码名词）
 *
 * @module dsh-pipeline/lib/intercept/prompt-rules
 */

import { NO_CODE_READ_ROLES, scanTestRunnerCommand } from '../guard.js'
import { roleLabel } from '../roles.js'

/** ★ Stop Ladder 四问 —— **拦截时注入的上下文**。 */
export const STOP_LADDER_FOUR = [
  '① **用户让你做了吗？** —— 这处改动/这个文件/这件事，在授权面（change_scope）或需求里出现过吗？',
  '② **结果需要它吗？** —— 不做它，本次验收标准会因为哪一条失败？说不出具体那一条 ⇒ 不需要。',
  '③ **有证据吗？** —— 是你实测/实读得到的，还是"顺手觉得应该"？拿不出证据的改动不许提。',
  '④ **没它会失败吗？** —— 如果答案是"也不会失败"，那它就是过度工程化，不做。',
]

/** 控制角色的"读代码"提示词判据：**动词 + 代码名词**同现才算（避免误伤正常话术）。 */
export const PROMPT_CODE_READ_RE =
  /(读一下|读读|看一下|看看|打开|检查|审阅|review|read)\s*[^。\n]{0,16}(源码|代码|实现|\.js\b|\.ts\b|\.py\b|\.go\b|\.java\b|\.rs\b|\.cs\b|\.sql\b|src[\\/])/i

/** 从 `agent/pre-step` 的载荷里把提示词文本拼出来（形状不稳，尽力而为）。 */
export function collectPromptText(payload) {
  const msgs = Array.isArray(payload?.messages) ? payload.messages : []
  const parts = []
  for (const m of msgs) {
    const c = m?.content
    if (typeof c === 'string') parts.push(c)
    else if (Array.isArray(c)) for (const x of c) if (typeof x?.text === 'string') parts.push(x.text)
  }
  return parts.join('\n')
}

/**
 * ★ 判"这段提示词是不是在让一个席位干它不能干的事"。
 *
 * @param {object} seat
 * @param {string} text
 * @returns {string|null} 拒绝理由；null = 放行
 */
export function judgePrompt(seat, text) {
  if (seat === null || typeof text !== 'string' || text.length === 0) return null
  if (seat.role === 'writer') {
    const hitTest = scanTestRunnerCommand(text)
    if (hitTest !== null) {
      // ⚠️ `scanTestRunnerCommand` 的返回值形状随实现变过（字符串 / {what, snippet}）——
      //    这里两种都接住，别把 `[object Object]` 递给用户看。
      const what =
        typeof hitTest === 'string'
          ? hitTest
          : String(hitTest?.what ?? hitTest?.label ?? hitTest?.kind ?? JSON.stringify(hitTest))
      return (
        `你是**编写**席位，提示词里出现了测试命令（命中：${what}）。\n` +
        '★ 编写不跑测试 —— 这是**能力边界**（守门在 `tools/pre-execute` 那一层直接拦），不是提醒。\n' +
        '要让测试跑起来：把产物交给测试角色（pipeline_handoff kind=dev_to_test）。'
      )
    }
  }
  if (NO_CODE_READ_ROLES.includes(seat.role)) {
    const m = PROMPT_CODE_READ_RE.exec(text)
    if (m !== null) {
      return (
        `你是「${roleLabel(seat.role)}」，**不看代码** —— 这条提示词在让你读实现（命中：${m[0]}）。\n` +
        '★ 你的判据是需求档 + 脱敏摘要 + 只给路径的目录结构。要看"改了什么"，用 ' +
        'pipeline_status / pipeline_change_audit（给的是路径与哈希，不是代码正文）。'
      )
    }
  }
  return null
}

/**
 * 席位开场注入的上下文（边界卡 + 四问）。
 *
 * @param {object} seat
 * @param {object|null} task - 任务对象（取 role_boundaries / plan_forbidden）
 * @returns {string}
 */
export function seatBriefing(seat, task) {
  const cards = Array.isArray(task?.role_boundaries) ? task.role_boundaries : []
  const card = cards.find((b) => String(b?.role ?? '') === seat.role) ?? null
  const forbidden = Array.isArray(task?.plan_forbidden) ? task.plan_forbidden : []
  const L = []
  L.push(`【多 AI 协同流水线 · 你的边界（代码层执法，不是提醒）】任务 ${seat.taskId}｜你是「${roleLabel(seat.role)}」`)
  if (card !== null) {
    L.push(`只做：${(card.only ?? []).join('；')}`)
    L.push(`不做：${(card.not ?? []).join('；')}`)
  } else {
    L.push('（计划里没给你的边界卡 —— 按你的角色定义行事，并让计划 AI 补上）')
  }
  if (forbidden.length > 0) L.push(`本次越界清单：${forbidden.join('；')}`)
  L.push('')
  L.push('★ 停下之前先过四问（**答不上来就别做**）：')
  for (const q of STOP_LADDER_FOUR) L.push(`  ${q}`)
  L.push('')
  L.push('★ 这些不是建议：越界的能力在守门层**直接不给**（工具会被拒），你省下的只有一次往返。')
  // ★★ 跑 shell 的写法（与 index.js 的 PIPELINE_PROMPT 同一口径，不另说一套话）。
  //
  //   为什么写进席位开场简报：这是唯一**必然**到达每个席位的一条注入（系统提示词段
  //   受 `config.registerPromptSection` 控制，而这条缝只对管线席位生效、一次注入）。
  //   它治的是"整轮作废"：多行 / 带引号 / 带中文的命令直接塞进 shell 参数时，
  //   多层转义会把**工具调用的 JSON** 写坏 ⇒ MALFORMED_RESPONSE ⇒ 整轮（含此前全部上下文）作废。
  //   ⚠️ 措辞里刻意**不许**出现任何测试类命令样例：本段文本会进席位上下文，
  //      而 `judgePrompt` 对编写席位扫的就是"提示词里有没有测试命令"（别自己把自己判红）。
  L.push('')
  L.push('★ 要跑 shell 时：多行 / 带引号 / 带中文 / 带反斜杠的命令，**先落盘成脚本文件再执行那个文件**')
  L.push('  （`pwsh -File x.ps1` / `bash x.sh`），不要整段塞进 command 参数。')
  L.push('  为什么：多层转义会把**工具调用的 JSON** 写坏 ⇒ MALFORMED_RESPONSE ⇒ **整轮作废**（含此前全部上下文）—— 最贵的一种失败。')
  L.push('  它是写法不是后门：脚本与命令受**同一套判据**管，落在你的授权面之外照样被拒。')
  return L.join('\n')
}
