// 拦截缝的「绝不静默」：任何一次否决都必须①说给用户听 ②写进审计（谁/何时/哪条判据/命中在哪）。
/**
 * dsh-pipeline · 拦截缝 · **绝不静默**（可见文案 + 审计留痕）
 * ============================================================================
 * 判据是用户裁定的（逐字）：
 *   「一票否决时**必须给用户可见的说明**」　「**只有"拒绝"没有"说明" = 失败**」
 *
 * ---------------------------------------------------------------------------
 * 现场：为什么必须有这个模块（2026-10-16 真机）
 * ---------------------------------------------------------------------------
 * 把 `pl-main` 预设全文粘进主对话会话 ⇒「**这一轮 1 秒结束、消息像没发出去**」。
 * 会话事件里 `turn/end {"reason":{"kind":"blocked"}}` 的**前面没有 `step/start`**，
 * 而且**插件侧零留痕** —— 用户既没提示、也无处可查。
 * 那是最贵的一种失败：它看起来像"消息丢了"，于是人只会一遍遍重发。
 *
 * `agent/pre-step` 的 `{kind:'reject'}` 是宿主的**一票否决**：turn 根本不开始，
 * 所以拒绝理由**没有任何出口**。「给拒绝补一段说明」在那条路上做不到 ⇒ 两条纪律：
 *
 *   ① **有可见文案** —— 提示词缝**不再一票否决**（见 `prompt-rules.js` 的口径表），
 *      改成**注入一条用户看得见的说明**；工具缝的拒绝理由本身就是可见文案
 *      （宿主的工具结果），由 `hook-pre.js` 再补一行"留痕在哪"。
 *   ② **有审计行** —— 一行 JSON 落 `.pipeline/<任务>/audit.jsonl`：
 *      **谁**（角色 / 席位 / 会话 id）· **何时**（`at`）· **命中哪条判据**（`criterion`）·
 *      **命中片段的位置**（`hit: {line, column, snippet}` / `tool` + `target`）。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么不走 `store.recordAudit()`
 * ---------------------------------------------------------------------------
 * 那一个会 push `task.history` 并**重写 `task.json`** —— 而**"拒绝"不是进展**：
 * `lib/patrol.js` 的"最后一次进展时刻"读的正是 `history` 的末条，
 * 写了它等于**机制自己制造了进展**（同一条理由已写在 `lib/reattach.js:498-505`
 * 与 `lib/orphan.js:1139-1145`）。
 * ⇒ 落点与行格式与那两处**同一份**：只追加 `.pipeline/<任务>/audit.jsonl`，
 *   并显式带上 `touched_task_json: false`（自测拿它当**可机读**断言）。
 *
 * @module dsh-pipeline/lib/intercept/seam-voice
 */

// ★ 复用既有件：`lib/orphan.js` 的 `createOrphanAudit` 文件头自己就写着
//   「只追加审计的**默认出口**」（同落点、同行格式、同"写失败也说出来"的纪律）。
//   这里**不重造第三份**追加器（同一纪律见 `CONVENTIONS.md` §7）。
import { createOrphanAudit as createAppendOnlyAudit } from '../orphan.js'

/** 拦截缝留下的审计动作名（`audit.jsonl` 的 `action` 字段）。 */
export const SEAM_VOICE_ACTIONS = {
  /** 提示词缝：命中 ⇒ **不拦**，注入一条用户看得见的说明。 */
  PROMPT_ADVICE: 'seam:prompt-advice',
  /** 工具缝：命中 ⇒ **拦**（判据的落点），并留痕。 */
  TOOL_DENY: 'seam:tool-deny',
}

/** 审计里 `criterion` 字段的长度上限（一行审计不该被一整段拒绝原文撑爆）。 */
export const CRITERION_MAX = 80

/**
 * ★ 命中片段在原文里的**位置**：第几行、第几列（都从 1 起）+ 一小段上下文。
 *
 * 为什么要有它：用户要能拿着审计行**回到那条消息里**核对 ——
 * 只说"命中了"而说不出"命中在哪"，等于把举证责任推回给用户。
 *
 * @param {string} text 原文
 * @param {number} index 命中起点（`String#match` 的 `index`）
 * @param {number} [length] 命中长度（0 ⇒ 取 40 字符上下文）
 * @returns {{line:number, column:number, snippet:string}}
 */
export function locateHit(text, index, length = 0) {
  const s = String(text ?? '')
  const raw = Number.isInteger(index) && index >= 0 ? index : 0
  const i = raw > s.length ? s.length : raw
  const n = Number.isInteger(length) && length > 0 ? length : 40
  const before = s.slice(0, i)
  const nl = before.lastIndexOf('\n')
  return {
    line: before.split('\n').length,
    column: i - (nl + 1) + 1,
    // 片段**按行裁断**：跨行命中在审计里只会读成一段乱码（一行审计读不出结构就没用）
    snippet: s.slice(i, i + n).split('\n')[0].slice(0, 120),
  }
}

/** 拒绝原文的首行 = 「命中哪条判据」的人话名字（去掉 `[pipeline] 拒绝：` 那层包装）。 */
export function criterionOf(reason) {
  const first = String(reason ?? '').split('\n')[0]
  return first.replace(/^\s*\[pipeline\]\s*拒绝：\s*/, '').trim().slice(0, CRITERION_MAX)
}

/**
 * 造一行审计的**正文**（纯函数：自测可以直接断言它，不必读盘）。
 *
 * @param {object} spec
 * @param {string} [spec.role] - 角色（`main` / `writer` / …）
 * @param {string|null} [spec.seat] - 编写席位（`writer#2`）
 * @param {string|null} [spec.agentId] - 会话 id
 * @param {string} spec.criterion - 命中的判据
 * @param {string|null} [spec.tool] - 工具缝：工具名
 * @param {string|null} [spec.target] - 工具缝：目标（路径 / 模式）
 * @param {{line:number,column:number,snippet:string}|null} [spec.hit] - 提示词缝：命中位置
 * @param {string|null} [spec.note]
 * @returns {object}
 */
export function seamVoiceEntry(spec) {
  const s = spec !== null && typeof spec === 'object' ? spec : {}
  const str = (v) => (v === null || v === undefined ? null : String(v))
  return {
    role: str(s.role),
    seat: str(s.seat),
    agent_id: str(s.agentId),
    criterion: str(s.criterion) ?? '',
    tool: str(s.tool),
    target: str(s.target),
    hit: s.hit !== null && typeof s.hit === 'object' ? s.hit : null,
    // ★ 可机读断言：**拒绝不是进展** —— 这一行一个字节都没碰 `task.json` / `task.history`
    touched_task_json: false,
    note: str(s.note),
  }
}

/**
 * 造一个"缝说话了"的记录器（**永不抛** —— 它在工具调用的关键路径上）。
 *
 * @param {(taskId:string)=>string} auditFileOf - 通常就是 `store.auditFile`
 * @param {(m:string)=>void} [log] - 写盘失败时说出来的出口（不静默）
 * @returns {(spec:object)=>Promise<object|null>} 落盘的那一行（无任务落点时为 null）
 */
export function createSeamVoiceRecorder(auditFileOf, log = null) {
  const append = createAppendOnlyAudit(auditFileOf, log)
  return async function recordSeamVoice(spec) {
    const s = spec !== null && typeof spec === 'object' ? spec : null
    if (s === null) return null
    const taskId = String(s.taskId ?? '')
    if (taskId.length === 0) return null // 没有任务就没有落点（席位尚未绑定任务时不猜路径）
    const entry = seamVoiceEntry(s)
    try {
      // `actor` 写在 `detail` 里 ⇒ 覆盖追加器的缺省 `'mechanism'`（谁干的必须记准）。
      await append(taskId, String(s.action ?? SEAM_VOICE_ACTIONS.TOOL_DENY), {
        actor: String(s.role ?? 'mechanism'),
        ...entry,
      })
    } catch (err) {
      if (typeof log === 'function') log(`[pipeline] 拦截缝留痕失败（判决本身不受影响）：${String(err?.message ?? err)}`)
      return null
    }
    return entry
  }
}
