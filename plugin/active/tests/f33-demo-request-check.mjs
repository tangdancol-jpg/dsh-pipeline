// P1-7 遗留缺口回归：`pipeline_demo round` 的**生产创建通道** —— 定稿一轮时自己登记 DEMO 审阅请求。
/**
 * dsh-pipeline · F33：DEMO 审阅请求的生产通道
 * ============================================================================
 *     node tests/f33-demo-request-check.mjs
 *
 * 现场（P1-7 遗留 · 2026-10-19）：`pipeline_demo round`（main）要求本轮挂一条
 * 「本轮创建 + 已 answered + 未被别的轮消费」的人工请求，但**工具自己不创建它**；
 * 而执行角色直接发 `pipeline_human_request` 会被**两级梯跳级闸**拦
 * （roster 有独立 orchestrator 时不许跳级）⇒ 生产链根本跑不通，
 * 只有测试夹具手工注入。
 *
 * 本套钉住：
 *   A **生产通道全链**：交付席位 submit → main `round`（**不给** human_request_id）
 *     ⇒ 自动登记一条 `reason_kind=demo_review` 的 blocking 请求（pending）并挂到本轮
 *     ⇒ 状态推进到 `demo_review`（不会被"answered"判据死锁）
 *     ⇒ 既有 `pipeline_human_relay` 转告 → `pipeline_human_reply` 记答复
 *     ⇒ `pipeline_demo confirm` 记确认 ⇒ `demo_passed` 到 `ready_dev`。
 *   B 兼容：**显式给** `human_request_id` ⇒ 沿用旧路径（不再自动创建）；
 *     旧判据仍然生效（relayed 未答复 ⇒ round 被拒）。
 */

import { pathToFileURL } from 'node:url'

import { createHarness, disposeHarness, callTool, runAnalysisThenPlan } from './selftest-core.mjs'
import { HUMAN_REASON_KINDS } from '../lib/model/handoff-fields.js'
import { DEMO_ST } from '../lib/states/demo-phase.js'
import { ST } from '../lib/states.js'
import { DEMO_ACTIONS } from '../lib/store/demo.js'

function createRecorder() {
  const items = []
  return {
    items,
    add(group, name, pass, detail) {
      items.push({ group, name, pass: pass === true, detail: String(detail ?? '') })
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
    text() {
      const L = ['dsh-pipeline · F33：DEMO 审阅请求的生产创建通道（P1-7 遗留）', '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('', `【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(`      ${it.detail.split('\n').join('\n      ')}`)
      }
      L.push('', '='.repeat(78), `总计：${this.passed}/${this.total} 通过`, '='.repeat(78))
      return L.join('\n')
    },
  }
}

/** 秒级 ISO（与 `nowIso` 同精度，避免"跨秒"造成的假 stale）。 */
const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

let seq = 0
const uid = (p) => `${p}-${++seq}`

/** 走完「需求 → 用户确认 → 计划」，拿到停在 `demo_building` 的 L3 任务。 */
async function plannedTask(h) {
  const MAIN = `f33-main-${++seq}`
  const opened = await callTool(h, 'pipeline_task_open', { requirement: 'F33 夹具：L3 任务走 DEMO 生产链。' }, MAIN)
  if (opened.denied) throw new Error(`夹具：开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id
  const tokens = { main: opened.value.role_token }
  const agents = { main: MAIN }
  await runAnalysisThenPlan(h, { taskId, tokens, agents, tier: 'L3', reason: 'F33 夹具' })
  return { h, taskId, tokens, agents, task: h.store.peek(taskId) }
}

/** 交付席位令牌（工具按令牌认角色；本套不依赖真实 dispatch）。 */
function seatToken(h, taskId, role, seat = null) {
  const agentId = `f33-${role}-${++seq}`
  return { token: h.tokens.mint({ taskId, role, seat, agentId }).token, agentId }
}

/** 交付席位交一份本轮 DEMO 内容。 */
async function submit(h, taskId, role, { ref = 'demo/main.html', content = '<h1>v1</h1>', roundIndex } = {}) {
  const { token, agentId } = seatToken(h, taskId, role, role === 'writer' ? 'writer#1' : null)
  return callTool(
    h,
    'pipeline_demo_submit',
    {
      task_id: taskId,
      deliverable_ref: ref,
      deliverable_content: content,
      ...(roundIndex === undefined ? {} : { round_index: roundIndex }),
      role_token: token,
    },
    agentId,
  )
}

/** main 定稿一轮（不给 human_request_id ⇒ 生产通道）。 */
async function roundAuto(h, taskId, tokens, agent, roundIndex = 1) {
  return callTool(
    h,
    'pipeline_demo',
    { action: 'round', task_id: taskId, round_index: roundIndex, role_token: tokens.main },
    agent,
  )
}

/** main 定稿一轮（显式给 human_request_id ⇒ 兼容旧路径）。 */
async function roundExplicit(h, taskId, tokens, agent, humanRequestId, roundIndex = 1) {
  return callTool(
    h,
    'pipeline_demo',
    { action: 'round', task_id: taskId, round_index: roundIndex, human_request_id: humanRequestId, role_token: tokens.main },
    agent,
  )
}

/** 往任务上登记一条"已答复"的旧式请求（兼容路径的夹具；与 f31 同一做法）。 */
function pushAnsweredRequest(h, taskId, requestId) {
  const task = h.store.peek(taskId)
  if (!Array.isArray(task.human_requests)) task.human_requests = []
  const at = iso()
  task.human_requests.push({
    request_id: requestId,
    handoff_id: `H-F33-${requestId}`,
    status: 'answered',
    from_role: 'writer',
    reason_kind: 'approval_needed',
    created_at: at,
    answered_at: at,
    answer_text: '可以',
    answer: '可以',
    answer_source: 'user',
  })
  return requestId
}

const findDemoReview = (task) =>
  (Array.isArray(task?.human_requests) ? task.human_requests : []).find((r) => r?.reason_kind === 'demo_review') ?? null

/**
 * 跑 F33 自测。
 *
 * @returns {Promise<{passed:number,total:number,text:string,items:object[]}>}
 */
export async function runF33DemoRequestCheck() {
  const rec = createRecorder()
  const h = await createHarness({})
  try {
    // =====================================================================
    // A 生产通道全链（不给 human_request_id）
    // =====================================================================
    {
      const G = 'A 生产通道：round 自动建请求 → relay → reply → confirm → demo_passed'
      rec.add(
        G,
        '`reason_kind=demo_review` 已进入合法枚举与文案',
        typeof HUMAN_REASON_KINDS.demo_review === 'string' && HUMAN_REASON_KINDS.demo_review.includes('DEMO'),
        HUMAN_REASON_KINDS.demo_review ?? '（缺）',
      )

      const fx = await plannedTask(h)
      const { taskId, tokens, agents } = fx
      rec.add(G, '（前置）任务停在 `demo_building`', fx.task.state === DEMO_ST.BUILDING, fx.task.state)

      const sub = await submit(h, taskId, 'writer')
      rec.add(
        G,
        '（前置）交付席位 `pipeline_demo_submit` 交内容成功（草稿轮，不推进状态）',
        sub.denied !== true && h.store.peek(taskId).state === DEMO_ST.BUILDING,
        String(sub.text).split('\n')[0],
      )

      const beforeCount = h.store.peek(taskId).human_requests.length
      const rnd = await roundAuto(h, taskId, tokens, agents.main, 1)
      rec.add(
        G,
        '★★ **不给 `human_request_id` ⇒ round 成功**（生产链不再要求夹具手工注入请求）',
        rnd.denied !== true,
        String(rnd.text).split('\n').slice(0, 6).join('\n'),
      )

      const t1 = h.store.peek(taskId)
      const autoReq = findDemoReview(t1)
      rec.add(
        G,
        '★★ round 自动登记了一条 `demo_review` 人工请求（blocking / pending / 机制代发）',
        autoReq !== null &&
          autoReq.blocking === true &&
          autoReq.status === 'pending' &&
          autoReq.auto_created === true &&
          autoReq.created_by === 'pipeline_demo.round' &&
          String(autoReq.request_id).startsWith('HR-'),
        autoReq === null
          ? '（没找到 demo_review 请求）'
          : JSON.stringify({ id: autoReq.request_id, reason_kind: autoReq.reason_kind, blocking: autoReq.blocking, status: autoReq.status, auto_created: autoReq.auto_created }),
      )
      rec.add(
        G,
        '★★ 请求正文说明**这一轮交付物 + 请用户确认**（问句、带轮次与交付物引用）',
        autoReq !== null &&
          typeof autoReq.question_for_human === 'string' &&
          autoReq.question_for_human.includes('第 1 轮') &&
          autoReq.question_for_human.includes('demo/main.html') &&
          /？/.test(autoReq.question_for_human) &&
          autoReq.decision_kind === 'approve_reject',
        autoReq?.question_for_human ?? '（缺）',
      )
      rec.add(
        G,
        '★ 请求只登记、**不推状态**：state_at_request 记的是 `demo_building`',
        autoReq?.state_at_request === DEMO_ST.BUILDING,
        String(autoReq?.state_at_request),
      )
      rec.add(
        G,
        '★★ 本轮记账：`human_request_id` 指向自动请求，且该请求被本轮消费标记',
        autoReq !== null &&
          t1.demo?.rounds?.[0]?.human_request_id === autoReq.request_id &&
          t1.demo?.rounds?.[0]?.auto_request === true &&
          autoReq.consumed === true &&
          autoReq.consumed_by_round === 1,
        JSON.stringify({
          round_request: t1.demo?.rounds?.[0]?.human_request_id,
          auto_request: t1.demo?.rounds?.[0]?.auto_request,
          consumed: autoReq?.consumed,
          consumed_by_round: autoReq?.consumed_by_round,
        }),
      )
      rec.add(
        G,
        '★★ 状态推进到 `demo_review`（`demo_submitted` 的 `demo_round_ok` 没有被"必须已 answered"死锁）',
        t1.state === DEMO_ST.REVIEW,
        `${t1.state}（改前这里会因为请求是 pending 而被拒）`,
      )
      rec.add(
        G,
        '★ 多登记了**恰好一条**请求（原有数量 +1，不是凭空刷一堆）',
        t1.human_requests.length === beforeCount + 1,
        `before=${beforeCount} after=${t1.human_requests.length}`,
      )
      const auditRows = await h.store.auditLog(taskId)
      rec.add(
        G,
        '★ 自动登记留痕：audit 里有 `demo:request`（记了 round_index / request_id / auto_created）',
        auditRows.some((e) => e.action === DEMO_ACTIONS.REQUEST && e.auto_created === true && e.request_id === autoReq?.request_id),
        auditRows.filter((e) => String(e.action).startsWith('demo:')).map((e) => e.action).join(' / '),
      )

      // --- 既有 relay：转告这条自动请求 -------------------------------------
      const rid = autoReq?.request_id ?? ''
      const relay = await callTool(
        h,
        'pipeline_human_relay',
        { task_id: taskId, request_id: rid, role_token: tokens.main },
        agents.main,
      )
      rec.add(
        G,
        '★★ 既有 `pipeline_human_relay` 能转告这条自动请求（照抄块带 reason_zh 与确认码）',
        relay.denied !== true && String(relay.text).includes('DEMO 审阅') && String(relay.text).includes('确认码'),
        String(relay.text).split('\n').slice(0, 4).join('\n'),
      )
      rec.add(G, '★ 转告后请求状态 = relayed', findDemoReview(h.store.peek(taskId))?.status === 'relayed', findDemoReview(h.store.peek(taskId))?.status ?? '(缺)')

      // --- 既有 reply：记答复 ----------------------------------------------
      const reply = await callTool(
        h,
        'pipeline_human_reply',
        {
          task_id: taskId,
          request_id: rid,
          user_quote: '可以，这版就这样。',
          reply_channel: 'chat',
          attribution: '用户在当前会话里直接回复',
          answer: true,
          role_token: tokens.main,
        },
        agents.main,
      )
      rec.add(
        G,
        '★★ 既有 `pipeline_human_reply` 能记答复（机制代发的请求**不产生"叫不醒席位"的假失败**）',
        reply.denied !== true && String(reply.text).includes('已记录答复') && !String(reply.text).includes('叫不醒'),
        String(reply.text).split('\n').slice(0, 6).join('\n'),
      )
      const answered = findDemoReview(h.store.peek(taskId))
      rec.add(
        G,
        '★ 答复后请求状态 = answered（`demo_review` 状态**没有**被改成别的——它本来就是等用户点头的态）',
        answered?.status === 'answered' && h.store.peek(taskId).state === DEMO_ST.REVIEW,
        `status=${answered?.status} state=${h.store.peek(taskId).state}`,
      )

      // --- confirm：确认落在第 1 轮 -----------------------------------------
      const conf = await callTool(
        h,
        'pipeline_demo',
        { action: 'confirm', task_id: taskId, round_index: 1, human_request_id: rid, answer: '可以', answer_source: 'user', role_token: tokens.main },
        agents.main,
      )
      rec.add(
        G,
        '★★ `pipeline_demo confirm` 认这一轮 + 这一条请求 ⇒ 确认落在第 1 轮上',
        conf.denied !== true && typeof h.store.peek(taskId).demo?.rounds?.[0]?.confirmed_at === 'string',
        String(conf.text).split('\n').slice(0, 3).join('\n'),
      )

      // --- demo_passed：整条生产链闭环 ---------------------------------------
      const pass = await callTool(
        h,
        'pipeline_transition',
        { task_id: taskId, event: 'demo_passed', role_token: tokens.main },
        agents.main,
      )
      rec.add(
        G,
        '★★ `demo_passed` ⇒ `ready_dev`（生产链闭环：不再有任何一步需要夹具注入）',
        pass.denied !== true && h.store.peek(taskId).state === ST.READY_DEV,
        `state=${h.store.peek(taskId).state}\n${String(pass.text).split('\n')[0]}`,
      )
    }

    // =====================================================================
    // B 兼容：显式给 human_request_id ⇒ 沿用旧路径
    // =====================================================================
    {
      const G = 'B 兼容：显式 human_request_id 时沿用'
      const fx = await plannedTask(h)
      const { taskId, tokens, agents } = fx
      await submit(h, taskId, 'writer', { ref: 'demo/explicit.html', content: '<h1>explicit</h1>' })

      const rid = `HR-f33-explicit-${++seq}`
      pushAnsweredRequest(h, taskId, rid)
      const countBefore = h.store.peek(taskId).human_requests.length
      const rnd = await roundExplicit(h, taskId, tokens, agents.main, rid, 1)
      rec.add(
        G,
        '★★ 显式给 id ⇒ round 成功、本轮挂的就是那一条',
        rnd.denied !== true && h.store.peek(taskId).demo?.rounds?.[0]?.human_request_id === rid,
        String(rnd.text).split('\n').slice(0, 4).join('\n'),
      )
      rec.add(
        G,
        '★★ 显式路径**不再自动创建**第二条请求（旧行为逐字保留）',
        h.store.peek(taskId).human_requests.length === countBefore && findDemoReview(h.store.peek(taskId)) === null,
        `requests=${h.store.peek(taskId).human_requests.length}（before=${countBefore}）`,
      )
      rec.add(
        G,
        '★ 显式路径照旧推进到 `demo_review`、且请求被消费',
        h.store.peek(taskId).state === DEMO_ST.REVIEW &&
          h.store.peek(taskId).human_requests.find((r) => r.request_id === rid)?.consumed_by_round === 1,
        `state=${h.store.peek(taskId).state}`,
      )

      // --- 反向：显式给"只是 relayed"的请求 ⇒ 旧判据仍然生效 ---------------
      const fx2 = await plannedTask(h)
      await submit(fx2.h, fx2.taskId, 'writer', { ref: 'demo/relayed.html', content: '<h1>relayed</h1>' })
      const ridRelayed = `HR-f33-relayed-${++seq}`
      const task2 = fx2.h.store.peek(fx2.taskId)
      task2.human_requests.push({
        request_id: ridRelayed,
        status: 'relayed',
        from_role: 'writer',
        reason_kind: 'approval_needed',
        created_at: iso(),
      })
      const bad = await roundExplicit(fx2.h, fx2.taskId, fx2.tokens, fx2.agents.main, ridRelayed, 1)
      rec.add(
        G,
        '★★ 显式给的请求只是 relayed（未答复）⇒ round 照旧被拒（兼容路径的旧判据没放宽）',
        bad.denied === true && String(bad.text).includes('还不是已答复') && fx2.h.store.peek(fx2.taskId).state === DEMO_ST.BUILDING,
        String(bad.text).split('\n').slice(0, 3).join('\n'),
      )
    }
    // =====================================================================
    // C 多轮：重做一轮后，第二轮**新起一条**请求（不复用）
    // =====================================================================
    {
      const G = 'C 多轮：重做后第二轮自动新起请求'
      const fx = await plannedTask(h)
      const { taskId, tokens, agents } = fx
      await submit(h, taskId, 'writer', { ref: 'demo/r1.html', content: '<h1>r1</h1>' })
      const r1 = await roundAuto(h, taskId, tokens, agents.main, 1)
      const rid1 = h.store.peek(taskId).demo?.rounds?.[0]?.human_request_id ?? ''
      await callTool(h, 'pipeline_human_relay', { task_id: taskId, request_id: rid1, role_token: tokens.main }, agents.main)
      const rep1 = await callTool(
        h,
        'pipeline_human_reply',
        {
          task_id: taskId,
          request_id: rid1,
          user_quote: '这版要改：按钮太小，重新做一版。',
          reply_channel: 'chat',
          attribution: '用户在当前会话里直接回复',
          answer: false,
          role_token: tokens.main,
        },
        agents.main,
      )
      const rework = await callTool(h, 'pipeline_transition', { task_id: taskId, event: 'demo_rework', role_token: tokens.main }, agents.main)
      await submit(h, taskId, 'writer', { ref: 'demo/r2.html', content: '<h1>r2</h1>' })
      const r2 = await roundAuto(h, taskId, tokens, agents.main, 2)
      const reviews = h.store.peek(taskId).human_requests.filter((x) => x.reason_kind === 'demo_review')
      rec.add(
        G,
        '★★ 用户要求重做 ⇒ 第二轮自动**新起**一条请求（不复用第一轮那条）',
        r1.denied !== true && rep1.denied !== true && rework.denied !== true && r2.denied !== true &&
          reviews.length === 2 &&
          reviews[0].request_id !== reviews[1].request_id &&
          reviews[1].status === 'pending' &&
          reviews[1].consumed_by_round === 2,
        JSON.stringify(reviews.map((x) => ({ id: x.request_id, status: x.status, round: x.consumed_by_round }))),
      )
      rec.add(
        G,
        '★ 第二条请求仍指向第 2 轮、状态回到 `demo_review`',
        h.store.peek(taskId).state === DEMO_ST.REVIEW && h.store.peek(taskId).demo?.rounds?.[1]?.human_request_id === reviews[1]?.request_id,
        `state=${h.store.peek(taskId).state} round2_req=${h.store.peek(taskId).demo?.rounds?.[1]?.human_request_id}`,
      )
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text(), items: rec.items }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF33DemoRequestCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
