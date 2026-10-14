/**
 * dsh-pipeline · 巡检 · **播报正文按判据本身写**（不许一律说"长时间无进展"）
 * ============================================================================
 * -----------------------------------------------------------------------------
 * 修的是哪条缺陷（真机端到端 T-20261015-bb30bc 实测，缺陷 ⑥）
 * -----------------------------------------------------------------------------
 * 现场（2026-10-14T17:51:39Z，`T-20261015-bb30bc`）：主对话收到一条
 * **「巡检发现长时间无进展」**，于是照机制要求去查失联 —— 结果：
 *
 *   · 任务进 `reviewing` 才 **1 分 49 秒**（口径写的是 **20 分钟**）；
 *   · 审核席位 **52 秒前**刚产出 `security:scan` 流水，`silent: []`、没有任何席位失联；
 *   · 而那条唤醒在账本里的键是
 *     `…|unresolved-wake|…|handoff|no-stable-identity`
 *     ⇒ 它**根本就不是**"长时间无进展"，是一条**"该叫没叫"**的通知。
 *
 * 根因（一行）：`index.js` 的 `reportFinding()` 把 `what` **写死**成
 * `'**巡检发现长时间无进展**（只播报，不动作）'`，而 `patrolFindings()` 一年能出
 * **五种**判据（`task-stall` / `unconsumed-delivery` / `unresolved-wake` /
 * `missing-transition` / `patrol-stalled`）——
 * **五种判据共用一句话**，其中四种都在说谎。
 *
 * ★ 为什么这条值得修（不是文案洁癖）：正文是主对话**唯一**的行动依据。
 *   把它引去查"谁不动了"，它就会漏掉真正该处理的那件事（此处是"有一条唤醒没投出去"）；
 *   而"巡检的时机对不上自己的口径"这个看起来像时钟 bug 的现象，
 *   其实是**标签错**——时钟一直是准的（那次 `stalled` 根本没到阈值）。
 *
 * -----------------------------------------------------------------------------
 * 修法
 * -----------------------------------------------------------------------------
 * 判据**自带**它自己那句话：`patrolNotice(finding)` 按 `finding.kind` 取标签，
 * 认不出的类别**如实照抄 `kind`**（不编一个像模像样的中文名去冒名）。
 * `index.js` 只做"把 finding 交给它"，不再存第二份文案。
 *
 * @module dsh-pipeline/lib/patrol/notice-text
 */

/**
 * 判据类别 → 一句话。
 *
 * ★ 每一条都与 `lib/patrol.js` 里那条判据**同源**（key 就是 `finding.kind`）：
 *   加新判据时必须同时登记进来 —— 没登记也不会撒谎，只是退回"照抄 kind"。
 */
export const PATROL_KIND_LABEL = Object.freeze({
  'task-stall': '任务长时间无进展',
  'unconsumed-delivery': '一条投递已送达但没人接管',
  'unresolved-wake': '一条唤醒没有投出去',
  'missing-transition': '交付已落盘、该发的那一步没人发',
  'patrol-stalled': '巡检自身已停摆',
})

/** 巡检播报**一律**带上的纪律后缀（A22：只播报、不动作）。 */
export const PATROL_DISCIPLINE = '（只播报，不动作）'

/**
 * 这一条判据叫什么（认不出就照抄 kind，**不冒名**）。
 *
 * @param {object|string} finding - `patrolFindings()` 产出的一条，或一个 kind 字符串
 * @returns {string}
 */
export function patrolKindLabel(finding) {
  const kind = String((typeof finding === 'string' ? finding : finding?.kind) ?? '').trim()
  if (kind.length === 0) return '巡检发现一条待处理事项'
  return PATROL_KIND_LABEL[kind] ?? `巡检发现一条待处理事项（类别 \`${kind}\`）`
}

/**
 * 播报的 `what` 一行 —— **按判据写**。
 *
 * @param {object|string} finding
 * @returns {string}
 */
export function patrolHeadline(finding) {
  return `**${patrolKindLabel(finding)}**${PATROL_DISCIPLINE}`
}

/**
 * 播报正文：一行"这是什么判据" + 判据自己给的明细。
 *
 * ★ 明细**一个字不改**（`finding.detail` 是判据算出来的），只在前面补一行归属，
 *   这样"谁在说、说的是哪一类"一眼可核 —— 缺陷 ⑥ 现场缺的正是这一行。
 *
 * @param {object} finding
 * @returns {{what:string, note:string, kind:string, id:string}}
 */
export function patrolNotice(finding) {
  const kind = String(finding?.kind ?? 'patrol')
  const detail = String(finding?.detail ?? '')
  const head = `判据类别：\`${kind}\`（${patrolKindLabel(finding)}）`
  return {
    what: patrolHeadline(finding),
    note: detail.length > 0 ? `${head}\n${detail}` : head,
    kind,
    id: String(finding?.id ?? ''),
  }
}
