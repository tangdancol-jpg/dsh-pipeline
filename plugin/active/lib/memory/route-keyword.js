// 记忆取回 · **关键词路**：确定性切词 + 命中计分（无模型、无向量、无索引服务）。
/**
 * dsh-pipeline · 记忆 · 取回 · 关键词路
 * ============================================================================
 * 宿主侧的全文检索**是关着的**（设计 `02-DSH-原生设施.md` §4.4：`session-query-sqlite`
 * 被配成 `{path:':memory:', openAt:never}`）⇒ 这一路**必须自建**，但它是**纯文件 + 内存**，
 * 很轻：一项目几十到几百条记忆，逐条切词足够了。
 *
 * ---------------------------------------------------------------------------
 * 为什么不上向量 / 不上重排模型（用户点名"不抄"）
 * ---------------------------------------------------------------------------
 * 记忆正文里天然有**任务 id、文件路径、状态名、角色名、交接物类型** ——
 * 这些是**精确串**，关键词命中就是最强的信号；再引一个 embedding 只会带来
 * "不可解释 + 多一个模型依赖"（设计 `01` §4.2 的裁决表）。
 *
 * ---------------------------------------------------------------------------
 * 切词规则（写死在这里，测试钉住）
 * ---------------------------------------------------------------------------
 *   · 先整体小写；
 *   · ASCII 字母数字**连成词**（`fizzbuzz`、`t-20261015`、`route-keyword` 各有切法），
 *     连词**同时**产出整词与"按 `.` `_` `-` 切开的段"（整词管精确、分段管召回）；
 *   · CJK 逐字 **+ 二元组**（"记忆"既能被单字"记"命中，也能被二元组"记忆"命中）——
 *     中文没有空格，只做单字会太松、只做整段会太紧；
 *   · 其余字符（标点、`/`、`\`、`:`）一律当**分隔符**（路径因此会被切成段，
 *     `lib/memory/bank.js` 与 `bank` 都能命中）。
 *
 * ★ 计分**只用整数**（命中数），没有任何浮点累加 ⇒ 同一输入必然同一输出（R6 可断言）。
 *
 * @module dsh-pipeline/lib/memory/route-keyword
 */

import { parseTime } from './route-time.js'

/** 关键词路的固定路由名。 */
export const ROUTE_KEYWORD = 'keyword'

/** ASCII 词（字母数字，允许内部连字符/下划线/点 —— 任务 id 与文件名都靠它）。 */
const ASCII_WORD_RE = /[a-z0-9][a-z0-9._-]*/g

/** CJK 统一表意文字（含扩展 A）。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g

/**
 * 切词（确定性；输出**去重后按字典序**，方便断言与比较）。
 *
 * ★ 一个 ASCII 连词会**同时**产出"整词"与"被 `.` `_` `-` 切开的段"：
 *   整词让 `T-20261015-bb30bc` / `bank.js` 能被**精确**命中，
 *   分段让查 `bank` 也能命中写着 `lib/memory/bank.js` 的那条（只留整词会漏掉这一类）。
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const out = new Set()
  for (const m of s.matchAll(ASCII_WORD_RE)) {
    const w = m[0].replace(/[._-]+$/, '')
    if (w.length === 0) continue
    out.add(w)
    for (const part of w.split(/[._-]+/)) {
      // ★ 只收**长度 ≥ 2** 的段：`T-20260101-aaaa` 切出来的 `t` 是纯噪声
      //   （任何含 `T-` 的记录都会被它命中），"多召回"不等于"多命中"。
      if (part.length > 1) out.add(part)
    }
  }
  const cjk = [...s.matchAll(CJK_RE)].map((m) => m[0])
  for (let i = 0; i < cjk.length; i += 1) {
    out.add(cjk[i])
    if (i + 1 < cjk.length) out.add(`${cjk[i]}${cjk[i + 1]}`)
  }
  return [...out].sort()
}

/**
 * 一条记忆里**可被关键词命中**的全部文本（正文 + 主键 + 结构化引用）。
 *
 * 为什么要带上 `entity` 与 `refs`：`T-20261015-bb30bc` 这种 id 在 `text` 里可能被
 * 截断（`TEXT_MAX`），但它在主键里**一定是全的** —— 不带上就等于"截断把可检索性也截了"。
 *
 * @param {object} record
 * @returns {string}
 */
export function searchableText(record) {
  const refs = record?.refs !== null && typeof record.refs === 'object' ? record.refs : {}
  const entity = Array.isArray(record?.entity) ? record.entity : []
  const paths = Array.isArray(refs.paths) ? refs.paths : []
  const roles = Array.isArray(refs.roles) ? refs.roles : []
  return [record?.text, record?.kind, ...entity, refs.task_id, refs.state, refs.handoff, ...paths, ...roles]
    .map((x) => String(x ?? ''))
    .join(' ')
}

/**
 * 一条记忆对一组查询词的命中情况。
 *
 * @param {object} record
 * @param {string[]} queryTokens - `tokenize(query)` 的结果（**调用方切一次，循环里复用**）
 * @returns {{score:number, hits:string[]}}
 */
export function scoreRecord(record, queryTokens) {
  const tokens = Array.isArray(queryTokens) ? queryTokens : []
  if (tokens.length === 0) return { score: 0, hits: [] }
  const hay = new Set(tokenize(searchableText(record)))
  const hits = []
  let score = 0
  for (const t of tokens) {
    if (!hay.has(t)) continue
    hits.push(t)
    // ★ 长词（文件名 / 任务 id / 二元组）比单字更有信息量：单字记 1、其余记 2。
    score += t.length > 1 ? 2 : 1
  }
  return { score, hits }
}

/**
 * ★ **关键词路取回**。
 *
 * @param {object[]} records
 * @param {object} opts
 * @param {string} [opts.query] - 空串 / 没给 ⇒ **这条路返回空**（"空查询"由时间路兜底）
 * @param {number} [opts.limit] - 最多几条
 * @returns {object[]} 命中的条目，**已按 `score` 倒序**（同分：新的在前；再同：id 升序）
 */
export function routeKeyword(records, opts = {}) {
  const list = Array.isArray(records) ? records : []
  const query = String(opts.query ?? '').trim()
  const tokens = tokenize(query)
  if (tokens.length === 0) return []
  const limit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : Infinity

  const scored = []
  for (const r of list) {
    const { score, hits } = scoreRecord(r, tokens)
    if (score > 0) scored.push({ record: r, score, hits })
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const ta = parseTime(a.record?.at)
    const tb = parseTime(b.record?.at)
    if (ta !== tb) return tb - ta
    const ia = String(a.record?.id ?? '')
    const ib = String(b.record?.id ?? '')
    return ia < ib ? -1 : ia > ib ? 1 : 0
  })
  const out = scored.map((s) => ({ ...s.record, score: s.score, hits: s.hits }))
  return Number.isFinite(limit) ? out.slice(0, limit) : out
}
