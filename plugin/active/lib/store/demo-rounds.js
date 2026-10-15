// DEMO 轮次 · 三条软约束的账本：每轮新交付物 / 每轮一条人工请求 / 无轮次硬上限（全部纯函数）。
/**
 * dsh-pipeline · DEMO 轮次账本
 * ============================================================================
 * 裁定 13：「DEMO **不设轮次硬上限**（用户满意为止）」；软约束三条（验收 A18）：
 *   ① **每轮必须产出新交付物**（**原地重交被拒**）；
 *   ② **每轮发一次人工请求**（可追溯）；
 *   ③ 保留 **`cancel` 出口**。
 *
 * ---------------------------------------------------------------------------
 * 为什么"不设上限"反而要一个小账本
 * ---------------------------------------------------------------------------
 * 去掉轮次上限之后，"再来一轮"变成**永远合法**的动作 —— 那就必须回答
 * 「这一轮**和上一轮有什么不同**」，否则 DEMO 会退化成"反复交同一个东西"，
 * 而没有任何机制会喊停（上限已经没了）。所以上限换成了**一条更强的约束**：
 * **每轮都得是新的**。
 *
 * ★ 本文件**全是纯函数**：只读任务对象上的 `demo` 字段，不落盘、不改状态。
 *   真正的写点在 `demo.js`。
 *
 * @module dsh-pipeline/lib/store/demo-rounds
 */

import { fullHash } from '../util.js'

/** 三条软约束的原文（给状态展示与拒绝文案引用，避免各处手抄）。 */
export const DEMO_SOFT_RULES = Object.freeze([
  '每轮必须产出**新交付物**（原地重交会被拒）',
  '每轮必须挂上**一条人工请求**（可追溯）',
  '**不设轮次硬上限**；`cancel` 出口始终可用',
])

/** 拒绝码。 */
export const DEMO_CODES = Object.freeze({
  DUPLICATE: 'DEMO_DUPLICATE_DELIVERABLE',
  NO_DELIVERABLE: 'DEMO_NO_DELIVERABLE',
  NO_HUMAN_REQUEST: 'DEMO_NO_HUMAN_REQUEST',
  NO_ROUND: 'DEMO_NO_ROUND',
})

/**
 * 任务上的 `demo` 账本（**只读**；没建过就给空账本，不写回）。
 *
 * 形状：
 * ```
 * task.demo = {
 *   plan: { tier, action, assumed, at },        // 档位策略的结论
 *   rounds: [ { index, digest, ref, human_request_id, at, by } ],
 *   confirmed_at, confirm_request_id, confirm_answer, confirmed_by,
 * }
 * ```
 *
 * @param {object} task
 * @returns {{plan:object|null, rounds:object[], confirmed_at:string|null,
 *            confirm_request_id:string|null, confirm_answer:string|null, confirmed_by:string|null}}
 */
export function demoStateOf(task) {
  const d = task?.demo ?? {}
  return {
    plan: d.plan ?? null,
    rounds: Array.isArray(d.rounds) ? d.rounds : [],
    confirmed_at: typeof d.confirmed_at === 'string' ? d.confirmed_at : null,
    confirm_request_id: typeof d.confirm_request_id === 'string' ? d.confirm_request_id : null,
    confirm_answer: typeof d.confirm_answer === 'string' ? d.confirm_answer : null,
    confirmed_by: typeof d.confirmed_by === 'string' ? d.confirmed_by : null,
  }
}

/**
 * 交付物的指纹（用来判"是不是同一个东西又交了一遍"）。
 *
 * 判据取 `ref + 正文` 的 sha256：**只看正文**不够（两次交同一个文件路径、
 * 内容却变了，那是新交付物）；**只看 ref** 也不够（同一路径重新交一遍是原地重交）。
 *
 * @param {{ref?:string, content?:string}} deliverable
 * @returns {string}
 */
export function digestOf(deliverable) {
  const ref = String(deliverable?.ref ?? '').trim()
  const content = String(deliverable?.content ?? '')
  return fullHash(`${ref}\u0000${content}`)
}

/**
 * 这一轮的序号（第几轮）。
 *
 * @param {object} task
 * @returns {number} 下一轮的序号（从 1 起）
 */
export function nextRoundIndex(task) {
  return demoStateOf(task).rounds.length + 1
}

/**
 * ★ 软约束①：这一轮是不是**原地重交**。
 *
 * @param {object} task
 * @param {string} digest
 * @returns {{duplicate:boolean, firstRound:number|null}}
 */
export function findDuplicateRound(task, digest) {
  const rounds = demoStateOf(task).rounds
  const hit = rounds.find((r) => r.digest === digest)
  return { duplicate: hit !== undefined, firstRound: hit === undefined ? null : hit.index }
}

/**
 * ★ 三条软约束的检查（**纯判据**，不改任务）。
 *
 * @param {object} task
 * @param {object} round - `{deliverable:{ref,content}, human_request_id}`
 * @returns {{ok:true, index:number, digest:string, cap:null, roundsBefore:number, note:string}
 *          |{ok:false, code:string, error:string}}
 */
export function checkDemoRound(task, round = {}) {
  const ref = String(round?.deliverable?.ref ?? '').trim()
  const content = String(round?.deliverable?.content ?? '')
  if (ref.length === 0 && content.trim().length === 0) {
    return {
      ok: false,
      code: DEMO_CODES.NO_DELIVERABLE,
      error:
        '拒绝：这一轮**没有交付物**（`ref` 与正文都是空的）。\n' +
        `★ 软约束①：${DEMO_SOFT_RULES[0]} —— 而"什么都没交"连"新"都谈不上。`,
    }
  }

  const digest = digestOf(round.deliverable)
  const dup = findDuplicateRound(task, digest)
  if (dup.duplicate) {
    return {
      ok: false,
      code: DEMO_CODES.DUPLICATE,
      error:
        `拒绝：这一轮的交付物与**第 ${dup.firstRound} 轮完全相同**（指纹 ${digest.slice(0, 12)}…）—— 原地重交不算一轮。\n` +
        `★ 软约束①：${DEMO_SOFT_RULES[0]}。\n` +
        '★ 为什么这条比"轮次上限"更要紧：裁定 13 去掉了轮次上限（用户满意为止），' +
        '所以"再来一轮"永远合法 —— 那就必须由"每轮都是新的"来保证它**在往前走**。',
    }
  }

  const rid = String(round?.human_request_id ?? '').trim()
  if (rid.length === 0) {
    return {
      ok: false,
      code: DEMO_CODES.NO_HUMAN_REQUEST,
      error:
        '拒绝：这一轮**没有挂上人工请求**。\n' +
        `★ 软约束②：${DEMO_SOFT_RULES[1]} —— 没有请求记录，事后无法回答"用户到底看过哪几版"。`,
    }
  }

  return {
    ok: true,
    index: nextRoundIndex(task),
    digest,
    cap: null,
    roundsBefore: demoStateOf(task).rounds.length,
    note: `第 ${nextRoundIndex(task)} 轮：新交付物（指纹 ${digest.slice(0, 12)}…）+ 人工请求 ${rid}。`,
  }
}

/**
 * ★ **确认**的判据（纯函数；验收 A17 的另一半）。
 *
 * 三个条件缺一不可：
 *   ① 至少有一轮 DEMO 交付（**没交过东西就"确认"是假的**）；
 *   ② 确认答复**认的是某一轮**（`round_index` 必须存在于账本里）；
 *   ③ 答复**来自用户**（`answer_source === 'user'` 或 `'timeout'` 且带原话）。
 *
 * @param {object} task
 * @param {object} confirm - `{round_index, answer, answer_source, request_id}`
 * @returns {{ok:true, round_index:number, request_id:string}|{ok:false, code:string, error:string}}
 */
export function checkDemoConfirm(task, confirm = {}) {
  const st = demoStateOf(task)
  if (st.rounds.length === 0) {
    return {
      ok: false,
      code: DEMO_CODES.NO_ROUND,
      error:
        '拒绝确认：**这个任务一轮 DEMO 都没交过**。\n' +
        '★ "确认"必须确认**某个具体的东西** —— 没有交付物的确认是空头支票，闸门会照旧拦着。',
    }
  }
  const idx = Number(confirm.round_index)
  const hit = st.rounds.find((r) => r.index === idx)
  if (!Number.isInteger(idx) || hit === undefined) {
    return {
      ok: false,
      code: 'DEMO_CONFIRM_BAD_ROUND',
      error: `拒绝确认：要确认的是第 ${confirm.round_index} 轮，但账本里没有这一轮（现有：${st.rounds.map((r) => r.index).join('、') || '无'}）。`,
    }
  }
  const rid = String(confirm.request_id ?? '').trim()
  if (rid.length === 0) {
    return {
      ok: false,
      code: DEMO_CODES.NO_HUMAN_REQUEST,
      error: '拒绝确认：没给人工请求 id —— 确认必须有**可追溯的那一条请求**（谁问的、问到哪一版）。',
    }
  }
  if (rid !== String(hit.human_request_id ?? '')) {
    return {
      ok: false,
      code: 'DEMO_CONFIRM_REQUEST_MISMATCH',
      error: `拒绝确认：请求 ${rid} 不是第 ${idx} 轮挂的那一条（那一轮挂的是 ${hit.human_request_id}）—— 确认要认准是哪一版。`,
    }
  }
  const src = String(confirm.answer_source ?? 'user')
  if (src !== 'user' && src !== 'timeout') {
    return {
      ok: false,
      code: 'DEMO_CONFIRM_BAD_SOURCE',
      error: `拒绝确认：答复来源 \`${src}\` 不合法（只认 \`user\` / \`timeout\`）。`,
    }
  }
  return { ok: true, round_index: idx, request_id: rid }
}

/**
 * 账本摘要（给状态展示用）。
 *
 * @param {object} task
 * @returns {string}
 */
export function summarizeDemo(task) {
  const st = demoStateOf(task)
  const head = st.plan === null ? '档位策略：**还没算过**' : `档位策略：${st.plan.tier} ⇒ ${st.plan.action}${st.plan.assumed ? '（tier 未知，按保守处理）' : ''}`
  const rounds = st.rounds.length === 0 ? '还没交过 DEMO' : `已交 ${st.rounds.length} 轮（无轮次上限）`
  const ok = st.confirmed_at === null ? '**未确认**' : `已确认（${st.confirmed_at}）`
  return `${head}；${rounds}；${ok}`
}
