// 提示词缝的**提示**判据（不再是一票否决）+ 席位开场简报（拦截缝 ② 的判据与文案）。
/**
 * dsh-pipeline · 拦截缝 · 提示词判据与席位简报
 * ============================================================================
 * 用户原话（Stop Ladder 四问）：
 *   「用户让你做了吗？结果需要它吗？有证据吗？没它会失败吗？」
 *
 * ★ 这四问是**引导**，不是判据 —— 真正的拦截在 `lib/guard/hook-pre.js`（代码层）。
 *   四问随 `agent/pre-step` 注入，让席位在"想多干一点"的时候自己停一下。
 *
 * ---------------------------------------------------------------------------
 * ★★ 口径修正（2026-10-16 真机缺陷）：提示词缝**不再有一票否决**
 * ---------------------------------------------------------------------------
 * 现场：把 `pl-main` 预设全文粘进主对话会话 ⇒「**这一轮 1 秒结束、消息像没发出去**」。
 * 原因是本文件原来把进来的文本**拼起来直接跑一条正则**，命中的却是**叙述规则的散文**
 * （markdown 表格里的 `` | 读代码正文（`read` / `grep` 等指向源码树） | **不许** | ``），
 * 于是 `hook-prompt.js` 把整个 turn `{kind:'reject'}` 掉 —— 而那条路**没有出口**：
 * turn 不开始 ⇒ 拒绝理由没人看得到、插件侧零留痕。分成两段发照样被拦（与长度无关）。
 *
 * ★ **这条规则的本意是拦「Agent 自己去看实现」，不是拦用户叙述规则或粘贴人设文本。**
 *   **用户有权粘贴任何东西** —— 用户消息里出现 `read` / `grep` / `src/…` 的字样，
 *   既不是"要去读代码"的证据，也不是任何人的越权。
 *
 * 新口径（判据化的，逐条可判）：
 *
 *   | 文本 | 旧口径 | 新口径 |
 *   | --- | --- | --- |
 *   | markdown 表格 / 引用块里的**规则说明** | ✗ 命中 ⇒ 否决 | **不判**（叙述规则 ≠ 请求） |
 *   | 出现**工具名**但不是请求（"看得见 ≠ 用得上"） | 视上下文偶尔命中 | **不判** |
 *   | 用户**真请求**读某文件（"先读一下 src/a.js"） | ✗ 命中 ⇒ 否决 | **不判**（用户消息层不判；判据落点在工具缝） |
 *   | Agent **真的去** `read` / `grep` 源码树 | （提示词缝先拦，常常拦错） | ★ **拒**：`tools/pre-execute`（`hook-pre.js`） |
 *
 *   ⇒ 判据从「**文本里出现了什么字**」改成「**有没有真的发起读动作**」。
 *     这不是漏判：真去读源码的那一次调用**照样被拒**，而且那里的拒绝理由
 *     用户看得见、`hook-pre.js` 还留审计行（见 `seam-voice.js`）。
 *
 * ★ 因此 {@link judgePrompt} 的返回值**不是"拒绝理由"而是"提示"**：
 *   `{criterion, text, hit}` | null —— **没有任何 `kind:"reject"` 这一档可以返回**。
 *   剩下的一条提示判据：**编写席位 + 提示词里出现测试命令**（复用 `scanTestRunnerCommand`）。
 *   ⚠️ 连它也不否决（"绝不静默"是硬要求：只有拒绝没有说明 = 失败）——
 *   真正的拦截同样在工具缝：编写真去跑测试时被 `tools/pre-execute` 当场拒。
 *
 * @module dsh-pipeline/lib/intercept/prompt-rules
 */

import { scanTestRunnerCommand } from '../guard.js'
import { roleLabel } from '../roles.js'
import { locateHit, SEAM_VOICE_ACTIONS } from './seam-voice.js'

/** ★ Stop Ladder 四问 —— **拦截时注入的上下文**。 */
export const STOP_LADDER_FOUR = [
  '① **用户让你做了吗？** —— 这处改动/这个文件/这件事，在授权面（change_scope）或需求里出现过吗？',
  '② **结果需要它吗？** —— 不做它，本次验收标准会因为哪一条失败？说不出具体那一条 ⇒ 不需要。',
  '③ **有证据吗？** —— 是你实测/实读得到的，还是"顺手觉得应该"？拿不出证据的改动不许提。',
  '④ **没它会失败吗？** —— 如果答案是"也不会失败"，那它就是过度工程化，不做。',
]

/**
 * ★ 提示词缝判据的**稳定名字**（写进审计的 `criterion` 字段）。
 *
 * ⚠️ 这里**只有"提示"这一档** —— 一票否决那一档连同它的正则一起删掉了
 *   （`PROMPT_CODE_READ_RE` 已不复存在：见文件头的口径表）。
 */
export const PROMPT_CRITERIA = {
  /** 编写席位 + 提示词里出现测试命令。 */
  WRITER_TEST_COMMAND: 'prompt:writer-test-command',
}

/** 提示的正文前缀（用户可见文案的落款，便于一眼认出是机制在说话）。 */
export const PROMPT_ADVICE_FORM = 'prompt-advice'

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
 * ★ 判"这段提示词有没有在让一个席位干它不能干的事"。
 *
 * ★★ **返回值是"提示"，不是"拒绝"**（口径修正，见文件头）：
 *    `{criterion, text, hit, action}` | null —— 调用方把它**注入成一条用户看得见的说明**，
 *    **绝不**拿它去 `{kind:'reject'}` 掉整轮（那正是"消息像没发出去"的成因）。
 *
 * @param {object} seat
 * @param {string} text
 * @returns {{criterion:string, text:string, hit:object, action:string}|null} 提示；null = 无事
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
      // 命中位置：`scanTestRunnerCommand` 不吐 index ⇒ 拿命中的那个词在原文里定位一次。
      // 定位不到（0）也比不写强：`criterion` + `what` 已经足够让人回到那条消息核对。
      const idx = typeof hitTest?.index === 'number' ? hitTest.index : text.indexOf(what.split('（')[0])
      return {
        criterion: PROMPT_CRITERIA.WRITER_TEST_COMMAND,
        action: SEAM_VOICE_ACTIONS.PROMPT_ADVICE,
        hit: locateHit(text, idx >= 0 ? idx : 0),
        text:
          `【提示·不是拒绝】你是**编写**席位，这条消息里出现了测试命令（命中：${what}）。\n` +
          '★ 编写不跑测试 —— 这是**能力边界**，不是提醒：你**真的**去跑的话，' +
          '`tools/pre-execute` 会当场把那次调用拒掉。\n' +
          '要让它跑起来：把产物交给测试角色（pipeline_handoff kind=dev_to_test）。\n' +
          '★ 这一轮**照常进行**（你的消息没有被丢掉）；这条说明也已写进审计。',
      }
    }
  }
  // ★★ 控制角色（`NO_CODE_READ_ROLES`）的那条"读代码"判据**已删除**，不再作为提示存在：
  //    它在用户消息层**必然**误伤（真机：`pl-main` 预设全文命中 2 处 ⇒ 整轮被否决）。
  //    用户消息层一律不判；真去读源码的那一次在工具缝被拒并留痕。
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
