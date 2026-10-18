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
 * 这一轮的序号（第几轮）。**只数已定稿的轮次**（草稿不占号，避免"定稿前先交过一份"导致号跳）。
 *
 * @param {object} task
 * @returns {number} 下一轮的序号（从 1 起）
 */
export function nextRoundIndex(task) {
  return recordedRoundsOf(task).length + 1
}

/**
 * ★ 软约束①：这一轮是不是**原地重交**。
 *
 * @param {object} task
 * @param {string} digest
 * @returns {{duplicate:boolean, firstRound:number|null}}
 */
export function findDuplicateRound(task, digest) {
  const rounds = recordedRoundsOf(task)
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
 * ★ **已经定稿的轮次**（P1-7/P1-8）。
 *
 * `rounds[]` 里会同时住两种条目：
 *   · **草稿**（`status:'submitted'`）—— `pipeline_demo_submit` 由交付席位挂上来的本轮交付物，
 *     还没被主对话的 `pipeline_demo round` 定稿；
 *   · **已定稿**（`status:'recorded'`，P4 旧数据没有 status）—— 挂了人工请求、可被确认/重做。
 *
 * 为什么草稿也放 `rounds[]` 而不是另开数组：任务书要求"挂到 `task.demo.rounds[i]`"，
 * 且主对话的 `round` 就是按 `round_index` 引用它 —— 同一张表才不会出现"两个账本"。
 * 判据侧（重复检测 / 闸门 / 确认）一律只看**已定稿**的那些。
 *
 * @param {object} task
 * @returns {object[]}
 */
export function recordedRoundsOf(task) {
  return demoStateOf(task).rounds.filter((r) => r !== null && typeof r === 'object' && r.status !== 'submitted')
}

/**
 * 找某一轮的**草稿**（`status:'submitted'`）；没有就是 `null`。
 *
 * @param {object} task
 * @param {number} index
 * @returns {object|null}
 */
export function draftRoundOf(task, index) {
  const list = demoStateOf(task).rounds
  return (
    list.find((r) => r !== null && typeof r === 'object' && r.index === index && r.status === 'submitted') ?? null
  )
}

/**
 * 把一组交付物压成一个**轮次指纹**（草稿定稿时用）。
 *
 * 与 {@link digestOf} 的分工：单份交付物用 `digestOf`；一轮里多席位各交一份时，
 * 按提交顺序把 `ref + 内容哈希` 拼起来再哈希 —— **同样的一组交付物得到同样的指纹**
 * （重复检测仍然成立），顺序不同则是不同的一轮（不同席位换了内容）。
 *
 * @param {Array<{ref?:string, content_hash?:string}>} deliverables
 * @returns {string}
 */
export function combineDeliverablesDigest(deliverables) {
  const list = Array.isArray(deliverables) ? deliverables : []
  return fullHash(list.map((d) => `${String(d?.ref ?? '').trim()}\u0000${String(d?.content_hash ?? '')}`).join('\n'))
}

/**
 * ★ **本轮创建的起点**（P1-7 的"请求必须是本轮创建的"判据）。
 *
 * 取"最近一个已定稿轮次的 `at` ＞ 档位结论的 `at` ＞ 任务创建时间"里**最晚**的那个：
 * 在这之后创建的人工请求才算"这一轮新起的"，不会拿上一轮的旧请求冒充。
 *
 * @param {object} task
 * @returns {string} ISO 时间（取不到就是空串 = 无法判定）
 */
export function demoPhaseAnchorOf(task) {
  const st = demoStateOf(task)
  const rec = recordedRoundsOf(task)
  const last = rec.length === 0 ? null : rec[rec.length - 1]
  if (last !== null && typeof last.at === 'string' && last.at.length > 0) return last.at
  if (st.plan !== null && typeof st.plan.at === 'string' && st.plan.at.length > 0) return st.plan.at
  return typeof task?.created_at === 'string' ? task.created_at : ''
}

/**
 * ★★ **`round` 挂的人工请求是否合法**（P1-7 用户拍板的新判据）。
 *
 * 三条（设计档 §1）：
 *   · **本轮创建**：请求的 `created_at` 必须晚于 {@link demoPhaseAnchorOf}（不是复用旧请求）；
 *   · **已 answered**：转告 ≠ 答复 —— 只有 `answered` 才证明人回了；
 *   · **未被别的轮消费**：一条请求只能用一次（`human_requests[].consumed_by_round`）。
 *
 * ★ **旧数据豁免**（P4 落盘的请求没有 `created_at` / `consumed` 这些字段）：
 *   没有 `created_at` ⇒ 视为 legacy，只做"存在 + 未被消费"的弱判据 ——
 *   否则升级会把旧单直接判死（任务书要求旧单不因改名/加判据而红）。
 *
 * @param {object} task
 * @param {{human_request_id?:string, round_index?:number}} input
 * @returns {{ok:true, request:object, strict:boolean, request_created_at:string}
 *          |{ok:false, code:string, error:string}}
 */
export function checkDemoRoundRequest(task, input = {}) {
  const rid = String(input?.human_request_id ?? '').trim()
  if (rid.length === 0) {
    return {
      ok: false,
      code: DEMO_CODES.NO_HUMAN_REQUEST,
      error:
        '拒绝：这一轮**没有挂上人工请求**。\n' +
        `★ 软约束②：${DEMO_SOFT_RULES[1]} —— 没有请求记录，事后无法回答"用户到底看过哪几版"。\n` +
        '下一步：让交付席位用 `pipeline_human_request` 发起"请看这轮 DEMO"的请求，主对话转告并把用户答复记回来，' +
        '再把那条 `human_request_id` 交给 `pipeline_demo { action: "round" }`。',
    }
  }
  const list = Array.isArray(task?.human_requests) ? task.human_requests : []
  const req = list.find((r) => r !== null && typeof r === 'object' && r.request_id === rid)
  if (req === undefined) {
    return {
      ok: false,
      code: 'DEMO_REQUEST_NOT_FOUND',
      error:
        `拒绝：这一轮挂的人工请求 \`${rid}\` 在任务上**不存在**。\n` +
        '★ 判据要求"请求是本轮真发起的那一条" —— 凭空写一个 id 不是请求。\n' +
        '下一步：先由交付席位 `pipeline_human_request` 发起请求（它会落进 task.human_requests），再挂到轮次上。',
    }
  }

  /** 新记录（有 created_at）走**严判据**；P4 旧记录（没有 created_at）走弱判据。 */
  const strict = typeof req.created_at === 'string' && req.created_at.length > 0
  if (strict) {
    const anchor = demoPhaseAnchorOf(task)
    if (anchor.length > 0 && req.created_at < anchor) {
      return {
        ok: false,
        code: 'DEMO_REQUEST_STALE',
        error:
          `拒绝：这一轮挂的请求 \`${rid}\` 是**更早以前创建的**（${req.created_at} 早于本轮起点 ${anchor}）—— ` +
          '不能拿旧请求冒充"本轮询问过用户"。\n' +
          '★ 判据：`round` 的 `human_request_id` 必须**本轮创建**（一条请求只能服务一轮）。\n' +
          '下一步：为本轮新起一条 `pipeline_human_request`，主对话转告、记回用户答复，再改挂新请求 id。',
      }
    }
    if (req.status !== 'answered') {
      return {
        ok: false,
        code: 'DEMO_REQUEST_NOT_ANSWERED',
        error:
          `拒绝：本轮请求 \`${rid}\` 当前状态是 \`${req.status}\`，**还不是已答复**。\n` +
          '★ 转告 ≠ 答复：请求发出去了只证明"话带到了"，只有 `answered` 才证明"人回了"。\n' +
          '下一步：pipeline_human_relay 转告用户 → 拿到答复后 pipeline_human_reply（带用户原话）。',
      }
    }
    if (req.consumed === true) {
      const sameRound = Number.isInteger(input?.round_index) && req.consumed_by_round === input.round_index
      if (!sameRound) {
        const by = Number.isInteger(req.consumed_by_round) ? `第 ${req.consumed_by_round} 轮` : '别的轮次'
        return {
          ok: false,
          code: 'DEMO_REQUEST_CONSUMED',
          error:
            `拒绝：本轮请求 \`${rid}\` **已经被${by}消费过** —— 一条请求只能用一次。\n` +
            '★ 为什么：请求记录是"用户看过**哪一版**"的唯一凭据；复用会让"确认的是哪一轮"说不清。\n' +
            '下一步：为本轮新起一条请求（并重新拿到用户答复），再定稿这一轮。',
        }
      }
      // ★ 同一轮自己消费的 —— 这是状态机推进时的防御复核（不是复用），放行。
    }
    // 同一条请求不许挂在**两个**已定稿轮次上（防御：旧数据可能没有 consumed 标记）。
    // ★ 排除"本轮自己"：状态机推进时会拿刚定稿的同一轮来复核。
    const reuser = recordedRoundsOf(task).find(
      (r) =>
        r?.human_request_id === rid &&
        !(Number.isInteger(input?.round_index) && r.index === input.round_index),
    )
    if (reuser !== undefined) {
      return {
        ok: false,
        code: 'DEMO_REQUEST_REUSED',
        error:
          `拒绝：请求 \`${rid}\` **已经挂在第 ${reuser.index} 轮上**（同一轮才能共用那一条请求）。\n` +
          '下一步：为本轮新起一条请求，再定稿。',
      }
    }
  } else if (req.consumed === true) {
    return {
      ok: false,
      code: 'DEMO_REQUEST_CONSUMED',
      error: `拒绝：本轮请求 \`${rid}\` **已经被别的轮消费过**（legacy 记录）—— 一条请求只能用一次。`,
    }
  }

  return {
    ok: true,
    request: req,
    strict,
    request_created_at: strict ? String(req.created_at) : '',
  }
}

/**
 * ★ **确认**的判据（纯函数；验收 A17 的另一半；P1-7 起要求"确认落在某一轮上"）。
 *
 * 三个条件缺一不可：
 *   ① 至少有一轮 DEMO 交付（**没交过东西就"确认"是假的**）；
 *   ② 确认答复**认的是某一轮**（`round_index` 必须存在于**已定稿**的轮次里）；
 *   ③ 请求 id 与那一轮挂的对得上。
 *
 * @param {object} task
 * @param {object} confirm - `{round_index, answer, answer_source, request_id}`
 * @returns {{ok:true, round_index:number, request_id:string}|{ok:false, code:string, error:string}}
 */
export function checkDemoConfirm(task, confirm = {}) {
  const recorded = recordedRoundsOf(task)
  if (recorded.length === 0) {
    return {
      ok: false,
      code: DEMO_CODES.NO_ROUND,
      error:
        '拒绝确认：**这个任务还没有任何已定稿的 DEMO 轮次**。\n' +
        '★ "确认"必须确认**某个具体的东西** —— 没有定稿轮次的确认是空头支票，闸门会照旧拦着。\n' +
        '下一步：交付席位 `pipeline_demo_submit` 交内容 → 主对话 `pipeline_demo { action: "round", round_index }` 定稿一轮。',
    }
  }
  const idx = Number(confirm.round_index)
  const hit = recorded.find((r) => r.index === idx)
  if (!Number.isInteger(idx) || hit === undefined) {
    return {
      ok: false,
      code: 'DEMO_CONFIRM_BAD_ROUND',
      error: `拒绝确认：要确认的是第 ${confirm.round_index} 轮，但账本里没有这一轮（现有：${recorded.map((r) => r.index).join('、') || '无'}）。`,
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
  // ★ 一条请求只能服务一轮：它被别的轮消费过 ⇒ 这次确认不成立。
  if (typeof hit.request_created_at === 'string' && hit.request_created_at.length > 0) {
    const other = recorded.find((r) => r.index !== idx && r.human_request_id === rid)
    if (other !== undefined) {
      return {
        ok: false,
        code: 'DEMO_REQUEST_REUSED',
        error: `拒绝确认：请求 ${rid} 同时挂在第 ${other.index} 轮上 —— 一条请求只能服务一轮。`,
      }
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
  return { ok: true, round_index: idx, request_id: rid, round: hit }
}

/**
 * 账本摘要（给状态展示用）。
 *
 * @param {object} task
 * @returns {string}
 */
export function summarizeDemo(task) {
  const st = demoStateOf(task)
  const recorded = recordedRoundsOf(task)
  const drafts = st.rounds.length - recorded.length
  const head = st.plan === null ? '档位策略：**还没算过**' : `档位策略：${st.plan.tier} ⇒ ${st.plan.action}${st.plan.assumed ? '（tier 未知，按保守处理）' : ''}`
  const rounds =
    recorded.length === 0
      ? `还没交过已定稿的 DEMO 轮次${drafts > 0 ? `（有 ${drafts} 轮草稿待主对话定稿）` : ''}`
      : `已定稿 ${recorded.length} 轮（无轮次上限）${drafts > 0 ? `，另有 ${drafts} 轮草稿待定稿` : ''}`
  const ok = st.confirmed_at === null ? '**未确认**' : `已确认（${st.confirmed_at}）`
  return `${head}；${rounds}；${ok}`
}
