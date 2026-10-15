// 活文档**渲染**：记忆数组 → `MEMORY.md` 正文（**纯函数**：不读盘、不写盘、不取时钟）。
/**
 * dsh-pipeline · 记忆 · 活文档渲染（纯函数）
 * ============================================================================
 * 设计 `06-分阶段.md` 的 E3：`MEMORY.md` 随记忆增长**自动更新**，且**随时可读**。
 * 本文件只回答"这份文档长什么样" —— **谁写、什么时候写、写不写**都在
 * `live-doc-write.js`（那样才谈得上"唯一写点"）。
 *
 * ---------------------------------------------------------------------------
 * ★ 判据 R10：**同输入 ⇒ 同输出**（所以这里不许出现时间戳 / 随机数 / Map 迭代序）
 * ---------------------------------------------------------------------------
 * 三条具体做法：
 *   ① 排序键全部**显式**给出（`at` 倒序 → `id` 升序），不依赖 `Array.sort` 的稳定性；
 *   ② "生成时间"这种字段**一个都不写** —— 文档的"新鲜度"由文件 mtime 回答，
 *      写进正文就等于"每次渲染都不一样"⇒ 幂等（R11）当场失效；
 *   ③ 计数一律由入参算出来，不从别处读。
 *
 * ★ 渲染里**不截断到"看不完"**：概览 + 最近 N 条 + 按任务 —— 想读全文用
 *   `pipeline_recall`（那一路才有硬 token 上限）。
 *
 * @module dsh-pipeline/lib/memory/live-doc-render
 */

import { parseTime } from './route-time.js'

/** 文档标题（一处定义）。 */
export const LIVE_DOC_TITLE = '# 项目记忆 · 活文档'

/** 库里一条记忆都没有时的占位（设计 `05` §3 的边界规定）。 */
export const LIVE_DOC_EMPTY = '（还没有记忆）'

/** "最近 N 条"写几条。 */
export const MAX_RECENT_LINES = 20

/** "按任务"最多列几行。 */
export const MAX_TASK_ROWS = 20

/** 会话投影那一段最多写几轮。 */
export const MAX_OUTLINE_ROWS = 6

/** 跨项目"用户裁定"库的 skill 名（kebab；目录名 = `~/.dsh/skills/<这个名字>/`）。 */
export const RULINGS_SKILL_NAME = 'pipeline-user-rulings'

/**
 * ★ `description` 里**写清触发条件**（设计 `04-§6.3`：`whenToUse` 不进目录）。
 * 这句是模型"什么时候该读这份文件"的**唯一**线索，所以它必须说人话、说场景。
 */
export const RULINGS_DESCRIPTION =
  '用户反复强调、**跨项目适用**的裁定清单（例：记忆库落在哪、既有文件能不能改、' +
  '报告要不要判据、提交要不要留痕）。**当你在流水线里做决定、写文件、改既有代码、' +
  '写报告或准备提交时先读它** —— 里面每一条都是用户拍过板的边界，照它做可以少走一轮返工。'

/** "这份文件是本插件生成的"判据（**没有它就不许覆盖** —— 见 E4 的硬要求②）。 */
export const RULINGS_MARKER = '<!-- generated-by: dsh-pipeline user-rulings -->'

/** 受管区块的起止标记（区块内由本插件重建，区块外**原样保留**）。 */
export const RULINGS_BEGIN = '<!-- dsh-pipeline:user-rulings:begin -->'
export const RULINGS_END = '<!-- dsh-pipeline:user-rulings:end -->'

/**
 * ★ 只取**受管部分**（frontmatter + 受管区块，到 `END_MARK` 为止）。
 *
 * 用途：判"要不要写"。用户在区块外的增删**不该**触发重建 —— 那一段我们本来就
 * 原样保留，为它重写一次文件只会平白改动 mtime（幂等就名存实亡了）。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function managedPartOf(text) {
  const src = String(text ?? '')
  const end = src.indexOf(RULINGS_END)
  return end >= 0 ? src.slice(0, end + RULINGS_END.length) : src
}

/** `at` 倒序 → `id` 升序（确定性：同刻的两条也有固定先后）。 */
function byRecencyThenId(a, b) {
  const ta = parseTime(a?.at)
  const tb = parseTime(b?.at)
  if (ta !== tb) return tb - ta
  const ia = String(a?.id ?? '')
  const ib = String(b?.id ?? '')
  return ia < ib ? -1 : ia > ib ? 1 : 0
}

/**
 * ★ **纯统计**（同一份数据喂给渲染与自测，两处**不各算一遍**）。
 *
 * @param {object[]} records
 * @returns {{count:number, kinds:Array<{kind:string,count:number}>, first:string, last:string}}
 */
export function summarizeRecords(records) {
  const list = Array.isArray(records) ? records : []
  const kinds = new Map()
  let first = ''
  let last = ''
  let firstMs = Infinity
  let lastMs = -Infinity
  for (const r of list) {
    const k = String(r?.kind ?? '?')
    kinds.set(k, (kinds.get(k) ?? 0) + 1)
    const t = parseTime(r?.at)
    if (t === -Infinity) continue
    if (t < firstMs) {
      firstMs = t
      first = String(r?.at ?? '')
    }
    if (t > lastMs) {
      lastMs = t
      last = String(r?.at ?? '')
    }
  }
  return {
    count: list.length,
    kinds: [...kinds.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)),
    first,
    last,
  }
}

/** 一行记忆摘要：`- <at> 〔kind〕(task) text`（与 `budget.wireLine` 同款观感，但**不带分数**）。 */
function recordLine(r) {
  const at = String(r?.at ?? '?')
  const kind = String(r?.kind ?? '?')
  const task = String(r?.refs?.task_id ?? '')
  return `- ${at} 〔${kind}〕${task.length > 0 ? `(${task}) ` : ''}${String(r?.text ?? '')}`
}

/**
 * ★★ **渲染"用户裁定"skill 的正文**（纯函数；E4，设计 `04-§6.3`）。
 *
 * 形态：`SKILL.md` 的 frontmatter（`dsh-skill-filesystem` 要求第 0 字节起就是 `---`，
 * 且 `name` 是 kebab、`description` 必填 —— `02` §2.3）+ 一段**受管区块**。
 *
 *   · **受管区块**（`BEGIN_MARK` … `END_MARK` 之间）由本函数生成：同一份裁定集
 *     必然渲染出同一段文字 ⇒ 幂等（判据 R11 的同一条纪律）；
 *   · **区块之外**（`opts.tail`）**原样保留** —— 用户手写的东西不会被重建吃掉，
 *     这正是用户裁定"库要**可见、可编辑**"的落点。
 *
 * ★ `description` 里**必须写触发条件**：`whenToUse` 不进 `<available_skills>` 目录
 *   （`dsh-tool-skill/README.md:243`），写错位置模型就永远不知道该调它（设计 `04-§6.3`）。
 *
 * @param {Array<{id:string, text:string, at:string, source:string}>} rulings
 * @param {object} [opts]
 * @param {string} [opts.tail] - 区块之外要原样保留的正文（默认空）
 * @param {string} [opts.name] - skill 名（kebab；默认 {@link RULINGS_SKILL_NAME}）
 * @returns {string}
 */
export function renderRulingsSkill(rulings, opts = {}) {
  const list = Array.isArray(rulings) ? rulings : []
  const name = String(opts.name ?? RULINGS_SKILL_NAME)
  const tail = String(opts.tail ?? '').replace(/\s+$/, '')
  const L = []
  L.push('---')
  L.push(`name: ${name}`)
  L.push(`description: ${RULINGS_DESCRIPTION}`)
  L.push('---')
  L.push('')
  L.push(RULINGS_MARKER)
  L.push('# 用户裁定（跨项目）')
  L.push('')
  L.push('> 这份文件由 `lib/memory/user-rulings.js` **幂等维护**：受管区块内按裁定 id 去重合并，')
  L.push('> **区块之外你写的东西原样保留**（可见、可编辑）。要加一条裁定，写在下面"我补充的"那一段里。')
  L.push('')
  L.push('## 裁定')
  L.push('')
  L.push(RULINGS_BEGIN)
  for (const r of list) {
    L.push(`- [${r.id}] ${r.text}${r.at.length > 0 ? `（记于 ${r.at}${r.source.length > 0 ? `，来源 ${r.source}` : ''}）` : ''}`)
  }
  L.push(RULINGS_END)
  if (tail.length > 0) {
    L.push('')
    L.push(tail)
  }
  return `${L.join('\n')}\n`
}

/**
 * ★★ **渲染活文档**（纯函数，判据 R10）。
 *
 * @param {object[]} records - 记忆库里的条目（顺序不影响输出 —— 内部自己排）
 * @param {object} [opts]
 * @param {object|null} [opts.outline] - {@link import('./reflect-source.js').normalizeOutline} 的产物（可缺）
 * @param {number} [opts.skipped] - 读库时跳过的坏行数（如实写进概览）
 * @param {string} [opts.outlineNote] - 没有投影时那句"为什么没有"（人话，来自 reflect-source）
 * @returns {string} `MEMORY.md` 的完整正文（以 `\n` 收尾）
 */
export function renderLiveDoc(records, opts = {}) {
  const list = Array.isArray(records) ? records : []
  const stats = summarizeRecords(list)
  const L = []

  L.push(LIVE_DOC_TITLE)
  L.push('')
  L.push('> 本文件由 `lib/memory/live-doc-write.js` **按记忆库幂等重建**（内容不变就不重写）。')
  L.push('> 手工改动会在下一次重建时被覆盖 —— 要改就改记忆库本体 `.pipeline/_memory/memory.jsonl`。')
  L.push('')

  // ---- 概览 ---------------------------------------------------------------
  L.push('## 概览')
  if (stats.count === 0) {
    L.push(`- ${LIVE_DOC_EMPTY}`)
  } else {
    L.push(`- 记忆条数：${stats.count}`)
    L.push(`- 时间范围：${stats.first.length > 0 ? stats.first : '?'} → ${stats.last.length > 0 ? stats.last : '?'}`)
    L.push(`- 按类型：${stats.kinds.map((k) => `${k.kind} ${k.count}`).join('｜')}`)
  }
  if (Number.isInteger(opts.skipped) && opts.skipped > 0) L.push(`- 读库时跳过的坏行：${opts.skipped}（坏行只丢它自己，不整库丢弃）`)
  L.push('')

  // ---- 最近 N 条 -----------------------------------------------------------
  L.push(`## 最近 ${MAX_RECENT_LINES} 条`)
  if (stats.count === 0) {
    L.push(LIVE_DOC_EMPTY)
  } else {
    for (const r of [...list].sort(byRecencyThenId).slice(0, MAX_RECENT_LINES)) L.push(recordLine(r))
    if (stats.count > MAX_RECENT_LINES) L.push(`- …（还有 ${stats.count - MAX_RECENT_LINES} 条；要按相关性取回用 \`pipeline_recall\`）`)
  }
  L.push('')

  // ---- 按任务 -------------------------------------------------------------
  const tasks = new Map()
  for (const r of list) {
    const id = String(r?.refs?.task_id ?? '').trim()
    if (id.length === 0) continue
    const cur = tasks.get(id) ?? { id, count: 0, state: '', latest: '' }
    cur.count += 1
    const at = String(r?.at ?? '')
    if (at >= cur.latest) {
      cur.latest = at
      const label = String(r?.refs?.state_label ?? '')
      const state = String(r?.refs?.state ?? '')
      if (label.length > 0 || state.length > 0) cur.state = label.length > 0 ? `${label}（${state || '?'}）` : state
    }
    tasks.set(id, cur)
  }
  const taskRows = [...tasks.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  L.push('## 按任务')
  if (taskRows.length === 0) {
    L.push('（还没有带任务主键的记忆）')
  } else {
    for (const t of taskRows.slice(0, MAX_TASK_ROWS)) {
      L.push(`- ${t.id}：${t.count} 条${t.state.length > 0 ? `｜最近状态：${t.state}` : ''}`)
    }
    if (taskRows.length > MAX_TASK_ROWS) L.push(`- …（还有 ${taskRows.length - MAX_TASK_ROWS} 张单）`)
  }
  L.push('')

  // ---- 会话投影（reflect 的输入）------------------------------------------
  const outline = opts.outline !== null && typeof opts.outline === 'object' ? opts.outline : null
  L.push('## 会话投影（最近几轮）')
  const items = Array.isArray(outline?.items) ? outline.items : []
  if (outline?.available !== true || items.length === 0) {
    const note = String(opts.outlineNote ?? '').trim()
    L.push(`- ${note.length > 0 ? `本次触发读不到会话投影：${note}` : '本次触发没有可读的会话投影（这不是错误）'}`)
  } else {
    for (const it of items.slice(-MAX_OUTLINE_ROWS)) {
      L.push(`- 轮 ${it.turn === null ? '?' : it.turn}｜用户：${it.prompt.length > 0 ? it.prompt : '(空)'}｜助手：${it.response.length > 0 ? it.response : '(空)'}`)
    }
    L.push(`- （投影里共 ${outline.turns} 轮，这里只写最近 ${Math.min(items.length, MAX_OUTLINE_ROWS)} 轮）`)
  }
  L.push('')

  return `${L.join('\n')}\n`
}
