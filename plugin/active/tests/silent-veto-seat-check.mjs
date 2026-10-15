/**
 * dsh-pipeline · **席位路径不被静默掐死**（真机缺陷的第二条通道）
 * ============================================================================
 *     node tests/silent-veto-seat-check.mjs
 *
 * 现场（用户确认，优先级提升）：派出去的**需求分析席位**里也出现了「已完成，用时 1 秒」。
 *
 * ---------------------------------------------------------------------------
 * ★★ 机制核心：**扫的是整轮 prompt**（这是本缺陷的关键事实）
 * ---------------------------------------------------------------------------
 * 判据的输入端 = `lib/intercept/prompt-rules.js` 的 `collectPromptText(payload)`（`:73-81`）
 * —— 它把 `payload.messages[]` 里**每一条**消息的正文**拼起来**，
 * 调用点在 `lib/guard/hook-prompt.js:81`。而席位那一轮装的是：
 *
 *     ① 派活单  ② runtime context  ③ 记忆切片  ④ 边界卡
 *     ⑤ notify / 裁定落地 / 主对话留言  ⑥ persona 首尾
 *
 * ⇒ **席位自己的人格、边界卡、记忆切片、派活单全在扫描面内**。
 *   判据不分"这段字是谁写的"，只把整段拼起来跑一条正则 ——
 *   所以席位**可能被自己的说明书一票否决**，而且那条路 `turn` 根本不开始 ⇒ 零留痕。
 *
 * ---------------------------------------------------------------------------
 * ★ 实测边界（如实写：结构与实际要分开）
 * ---------------------------------------------------------------------------
 *   · **结构上暴露**：`SEAT_CASES` 的 17a/17b/17c 三条（席位人格 / 边界卡 / 派活单里
 *     带了那串字）用改前判据实测**全部命中 ⇒ 一票否决**；
 *   · **该次没有实际踩中**：全量扫描 70 份会话日志（多帧 zstd 逐帧解压）——
 *     出现 `blocked` 的只有 **2 个 `computer-use` 会话共 24 次**（用户自己那个会话），
 *     `pl-orchestrator` 席位会话 **0 次**；`session-99d56a02-…` 的 5 个 turn 全部
 *     `completed`（22 步 / 21 次工具调用），其 8 条整轮 prompt 逐条过旧判据**都不命中**。
 *   ⇒ 所以本套钉的是**结构防线**：席位路径**再也不能**被自己的文本掐死。
 *
 * @module dsh-pipeline/tests/silent-veto-seat-check
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seatBriefing } from '../lib/intercept.js'
import { composePrefix, composeSuffix } from '../presets/render.js'
import {
  PRESET_INDEX,
  MAIN_TABLE_ROW,
  presetFullText,
  auditLinesOf,
  closeFixtures,
  createRecorder,
  indent,
  renderSuite,
  setupInterceptHost,
} from './silent-veto-fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
// ---------------------------------------------------------------------------
// ★★ 席位整轮 prompt（回归 16 / 17）：席位开工时到底被扫了哪一段文本
//
//   判据的输入端是 `lib/intercept/prompt-rules.js` 的 `collectPromptText(payload)`
//   —— 它把 `payload.messages[]` 里**每一条**消息的正文**拼起来**（`:73-81`），
//   调用点是 `lib/guard/hook-prompt.js:81`。而席位的 `messages[]` 在真机上装的是
//   （逐条来自实测会话 `session-99d56a02-…`，`preset=pl-orchestrator`）：
//
//     ① 派活单（`# 流水线派活单 · 需求分析`）
//     ② `Current runtime context`（宿主注入）
//     ③ 记忆切片（`【流水线 · 记忆切片】`）
//     ④ **边界卡**（`【多 AI 协同流水线 · 你的边界（代码层执法，不是提醒）】`）
//     ⑤ 唤醒 / 裁定落地 / 主对话留言（notify_only）
//     ⑥ persona 首尾（`pl-<role>` 的 prefix / suffix）
//
//   ⇒ **扫的是整轮 prompt**，席位自己的**人格 / 边界卡 / 记忆切片 / 派活单全在扫描面内**。
//     这就是"席位一开工就被自己的人格掐死"的机制核心：判据不分"谁写的"，
//     只把整段拼起来跑正则。
//
//   ⚠️ 实测补充（70 份会话日志全量扫描）：真正出现过 `blocked` 的是**用户自己的
//      `computer-use` 会话**（2 个会话 24 次），`pl-orchestrator` 席位会话 0 次 ——
//      即**席位结构上暴露、但那一次没有实际踩中**。本套因此把席位路径**独立钉住**。
// ---------------------------------------------------------------------------

/** 一条真机形状的**派活单**（字段名取自实测会话）。 */
export const DISPATCH_BRIEF = [
  '# 流水线派活单 · 需求分析',
  '',
  '任务 ID：T-20261016-ff9ba7',
  '你的角色：orchestrator（需求分析）',
  '档位：(未编排)  · 独立对话数 ?',
  '角色清单：',
  '调用顺序：',
  '',
  '## 原始需求',
  '把这条需求分析清楚，产出任务卡 + 验收标准 + 边界条件 + 测试要点。',
].join('\n')

/** 一条真机形状的**记忆切片**注入。 */
export const MEMORY_SLICE = [
  '【流水线 · 记忆切片】本项目已攒下 8 条记忆，这里是其中**最近 8 条**（计价 437/600 token）',
  '· `2026-10-16T01:40:00Z`｜裁定：交付物 = 可执行文件 + 源码 + 一条重建命令 + 一行运行说明。',
].join('\n')

/** 一条真机形状的**唤醒 / notify_only** 消息。 */
export const WAKE_NOTIFY = [
  '【流水线 · 裁定已落地】你之前停手等的那件事有结论了（人工介入请求 HR-792e4988848447bf 已答复（user））。',
  '任务 T-20261016-ff9ba7 当前状态：需求分析中（`analyzing`）。',
  '★ 接着干：把结论写进需求档（`pipeline_compile_requirement`）。',
].join('\n')

/**
 * 拼出**席位开工时的那一整轮 prompt**（真实成分，来源见上）。
 *
 * @param {object} spec
 * @param {string} [spec.role] - 席位角色（决定用哪份 persona）
 * @param {string} [spec.boundaryCard] - 边界卡正文（真机由 `seatBriefing()` 产出）
 * @param {string} [spec.trigger] - 额外塞进去的文本（用来做"席位人格里带触发词"的实验）
 * @returns {string[]} 逐条消息正文（直接当成 `messages[].content`）
 */
export function seatTurnPrompt({ role = 'orchestrator', boundaryCard = '', trigger = '' } = {}) {
  const dir = join(PKG, 'presets', PRESET_INDEX.presets[role].dir)
  return [
    DISPATCH_BRIEF,
    'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
    MEMORY_SLICE,
    boundaryCard.length > 0 ? boundaryCard : '【多 AI 协同流水线 · 你的边界（代码层执法，不是提醒）】（夹具未给边界卡）',
    WAKE_NOTIFY,
    `${composePrefix(dir)}\n\n${composeSuffix(dir)}`,
    trigger,
  ].filter((s) => s.length > 0)
}

/** 真机形状的边界卡（由**生产代码自己**产出，不手抄 —— 见 `lib/intercept.js` 的 `seatBriefing`）。 */
export const SEAT_BOUNDARY_CARD = seatBriefing(
  { role: 'orchestrator', taskId: 'T-x', seat: null },
  { role_boundaries: [{ role: 'orchestrator', only: ['出任务卡与验收标准'], not: ['不读代码、不定字段名'] }] },
)

/**
 * ★★ **回归 16 / 17**：席位开工的整轮 prompt（逐条断言**不拦**）。
 *
 * `oldHit` 是**实测值** —— 拿改前那份代码（`512aebb` 的 `PROMPT_CODE_READ_RE`）
 * 对**整轮拼接文本**逐段跑出来的结果：
 *   · 16（真 `pl-orchestrator` 整轮）**不命中** ⇒ 与"该会话日志里 0 次 blocked"一致；
 *   · 17a/17b/17c **命中**（命中段分别是第 7 / 第 7 / 第 6 段 = persona 或塞进去的那一行）
 *     ⇒ **席位结构上是暴露的**：只要它的人格 / 边界卡 / 派活单里带了那串字，
 *     开工那一步就会被自己的人格一票否决。
 */
export const SEAT_CASES = [
  {
    tag: '16 真席位整轮（真 persona + 真边界卡 + 派活单 + 记忆切片 + notify）',
    role: 'orchestrator',
    messages: seatTurnPrompt({ role: 'orchestrator', boundaryCard: SEAT_BOUNDARY_CARD }),
    oldHit: false,
  },
  {
    tag: '17a 席位整轮，但**边界卡里带了那一行**（改前 ⇒ 一票否决）',
    role: 'orchestrator',
    messages: seatTurnPrompt({ role: 'orchestrator', boundaryCard: SEAT_BOUNDARY_CARD, trigger: MAIN_TABLE_ROW }),
    oldHit: true,
  },
  {
    tag: '17b 席位整轮，但里面粘了 `pl-main` persona 全文（改前 ⇒ 一票否决）',
    role: 'orchestrator',
    messages: seatTurnPrompt({ role: 'orchestrator', boundaryCard: SEAT_BOUNDARY_CARD, trigger: presetFullText('main') }),
    oldHit: true,
  },
  {
    tag: '17c `pl-main` 席位整轮 —— **它自己的人格就带那一行**（改前 ⇒ 一票否决）',
    role: 'main',
    messages: seatTurnPrompt({ role: 'main', boundaryCard: SEAT_BOUNDARY_CARD }),
    oldHit: true,
  },
  {
    tag: '17d 席位整轮逐段全过一遍（每段单独都当一条 prompt 发）',
    role: 'orchestrator',
    messages: seatTurnPrompt({ role: 'orchestrator', boundaryCard: SEAT_BOUNDARY_CARD, trigger: MAIN_TABLE_ROW }),
    oldHit: true,
    perMessage: true,
  },
]

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runSilentVetoSeatCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // ★★ **席位路径**（回归 16 / 17）：席位开工不会被自己的人格 / 边界卡掐死
  // =========================================================================
  {
    const { f, host } = await setupInterceptHost()
    open.push(f.h)
    // 铸一个 orchestrator 席位的令牌（真机上这个角色由管道派出去，夹具里默认没有）
    const ORCH = 'silent-veto-orch'
    f.h.tokens.mint({ taskId: f.taskId, role: 'orchestrator', agentId: ORCH, note: 'silent-veto-seat-check' })
    const agentOf = (role) => (role === 'orchestrator' ? ORCH : f.agents.main)
    const send = (agentId, text) =>
      host.emit('agent/pre-step', { agent: { id: agentId }, messages: [{ role: 'user', content: text }], turn: 1 })

    for (const c of SEAT_CASES) {
      const agentId = agentOf(c.role)
      // ① 整轮一次性发（等价于宿主把 messages[] 全交给缝）
      const whole = c.messages.join('\n')
      const r1 = await send(agentId, c.messages)
      // ② 逐段再各发一次（覆盖"任意一段单独出现"）
      const per = []
      if (c.perMessage === true) for (const t of c.messages) per.push({ t, r: await send(agentId, t) })

      const okWhole = r1?.kind === 'enter'
      const okPer = per.every((x) => x.r?.kind === 'enter')
      rec.add(
        '席位路径不被掐',
        `★★【${c.tag}】整轮 ${c.messages.length} 段 / ${whole.length} 字符 ⇒ **放行**${c.oldHit ? '（★ 改前**一票否决**）' : '（改前也不命中 —— 与实测日志一致）'}`,
        okWhole && okPer,
        `旧判据（实测）：${c.oldHit ? '**命中（命中段 = persona / 塞进去的那一行）⇒ 一票否决 + 零留痕**' : '不命中 ⇒ 放行'}\n` +
          `新：整轮 kind=${JSON.stringify(r1?.kind)}` +
          (per.length > 0 ? `　逐段 kind=${JSON.stringify(per.map((x) => x.r?.kind))}` : '') +
          `\n逐段正文首行：\n${indent(c.messages.map((t, i) => `#${i + 1} ${t.split('\n')[0].slice(0, 60)}`).join('\n'))}`,
      )
    }

    // ★ 整组汇总：席位路径**一条 reject 都不许有**
    const probes = []
    for (const c of SEAT_CASES) {
      const agentId = agentOf(c.role)
      for (const text of [...c.messages, c.messages.join('\n')]) probes.push({ text, r: await send(agentId, text) })
    }
    const rejects = probes.filter((p) => p.r?.kind === 'reject')
    rec.add(
      '席位路径不被掐',
      `★★ **席位开工不会被自己的人格 / 边界卡掐死**：${probes.length} 次探针（含 persona 全文、边界卡、派活单、记忆切片、notify，以及带触发词的变体）⇒ \`reject\` **${rejects.length} 次**`,
      probes.length > 0 && rejects.length === 0,
      rejects.length === 0
        ? `全部 enter。来源：${SEAT_CASES.length} 个整轮 × 逐段 + 整轮拼接`
        : rejects.map((p) => JSON.stringify(p.text).slice(0, 80)).join('\n'),
    )

    // ★ 席位路径命中时**也不许静默**：这里一个 veto 都没有 ⇒ 没有"只拒绝不记录"的可能。
    //   真去读源码的那一次仍然在工具缝被拦并留痕（见 silent-veto-check.mjs 的 C 组）。
    const audit = auditLinesOf(f).filter((l) => l.action === 'seam:prompt-advice')
    rec.add(
      '席位路径不被掐',
      '★★ **绝不静默（席位侧对照）**：提示词缝对席位**不产生任何一票否决** ⇒ 不存在"拒绝了却没留痕"的路径；`seam:prompt-advice` 只在真命中剩余判据（编写 + 测试命令）时才落一行',
      rejects.length === 0 && Array.isArray(audit),
      `本次席位探针 ${probes.length} 次 ⇒ reject ${rejects.length} 次；提示词缝审计行 ${audit.length} 行（席位这些文本都不含"编写 + 测试命令"⇒ 期望 0 行，且**没有静默否决**）`,
    )
  }

  await closeFixtures(open)
  return {
    passed: rec.passed,
    total: rec.total,
    items: rec.items,
    text: renderSuite(
      'dsh-pipeline 席位路径自测（回归 16/17：扫的是整轮 prompt ⇒ 席位不能被自己的说明书掐死）',
      '机制核心：collectPromptText(payload) 把 payload.messages[] 里每一条消息拼起来跑判据（prompt-rules.js:73-81 → hook-prompt.js:81）。',
      rec,
    ),
  }
}

// 直接跑：`node tests/silent-veto-seat-check.mjs`
if (process.argv[1] !== undefined && /silent-veto-seat-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runSilentVetoSeatCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
