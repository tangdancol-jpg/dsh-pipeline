/**
 * dsh-pipeline · 人工介入请求「登记表」自测（现场修复 #5）
 * ============================================================================
 *     node tests/human-registry-check.mjs
 *
 * -----------------------------------------------------------------------------
 * 现场（2026-10-11，真单 T-20261011-63633e 永久卡死）
 * -----------------------------------------------------------------------------
 *   · `pipeline_status` 里明明白白列着
 *       `[人工介入请求] orchestrator→main - H-e12407f0aeb5afc0`
 *   · 状态机也停在「等待人工答复(awaiting_human)」
 *   · 但 `pipeline_human_relay`（收件箱）回「没有任何人工介入请求」
 *   ⇒ 主对话**取不出问题**、**也记不回答复** ⇒ 任务永久卡死。
 *
 * 根因是**两份数据源各写各的**：
 *   · `task.handoffs[]`       —— `pipeline_status` 那行读的是这里（由 `appendHandoff` 写）；
 *   · `task.human_requests[]` —— relay / reply 读的是这里（由 `createHumanRequestEntry` 写）。
 *   顺序上先落前者、后落后者 ⇒ 中间一中断就留下「交接物在盘上、登记表空的」半截现场。
 *
 * -----------------------------------------------------------------------------
 * 这一套验什么
 * -----------------------------------------------------------------------------
 *   正例 ①：**两条提交路径都登记** —— `pipeline_human_request`（摊平参数）
 *           与 `pipeline_handoff{kind:"human_request"}`（结构化）。
 *   正例 ②：**兜底可救回已卡死的单** —— 登记表被清空、交接物还在 ⇒
 *           重组登记、收件箱列得出、答复记得回。
 *   反例 ③：**既有反例不许回退** —— 主对话不能自行把请求标记为已解决。
 *   反例 ④：兜底**不覆盖已有记录** —— 答复过的请求绝不被"修复"回 pending。
 *   正例 ⑤：★ **兜底要覆盖「非阻塞」请求**（本轮补）——
 *           `blocking=false` 不进等待态，旧判据（要求 awaiting_human）对它一条都盖不住；
 *           真单里点名"取不出来"的三条交接物**全是 blocking=false**。
 *   正例 ⑥：★ **兜底要覆盖「热缓存」路径**（本轮补）——
 *           `cache` 在进程里从不失效，旧实现只在"读盘那一次"自愈 ⇒
 *           同一次运行里漏过一次登记就再也不会自愈，**只有重启才修得好**。
 *   反例 ⑦：判据放宽之后，③④ 两条反例**一条都没回退**。
 *   正例 ⑧：★★ **写读并发**（本轮补）——「**写入后立刻读**」必须拿得到，
 *           且写事务期间**不出现**「交接物可见、登记不可见」的半截状态。
 *   正例 ⑨：★★ **读前对账**（本轮补）—— 盘上已有登记、内存实例没有
 *           （"写进去了、读不到"）⇒ 重载后收件箱列得出、按 id 也转告得通。
 *   反例 ⑩：对账**不误伤** —— 本进程刚写完的不重载（不制造双对象）、
 *           内存比盘新（写还在途）时不回退。
 *
 * 全程零副作用（临时目录 + 假会话，跑完即删）。
 *
 * @module dsh-pipeline/tests/human-registry-check
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { callTool, createGuardFixture } from './selftest-core.mjs'

// ---------------------------------------------------------------------------
// 断言小工具
// ---------------------------------------------------------------------------

const indent = (s, n = 4) =>
  String(s ?? '')
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n')

function createRecorder() {
  const items = []
  return {
    items,
    add(name, pass, detail) {
      items.push({ name, pass: pass === true, detail: String(detail ?? '') })
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
  }
}

/** 片段里带 `|` 表示任一即可。 */
function hit(text, fragment) {
  return String(fragment)
    .split('|')
    .some((a) => a.length > 0 && String(text).includes(a))
}

function expectOk(rec, name, res, mustContain = []) {
  const missing = mustContain.filter((s) => !hit(res.text, s))
  const pass = res.denied !== true && missing.length === 0
  rec.add(
    name,
    pass,
    pass
      ? `结果摘要：\n${indent(res.text)}`
      : `期望成功但被拒了（layer=${res.layer}）${missing.length > 0 ? `，或缺少关键片段：${missing.join(' / ')}` : ''}\n原文：\n${indent(res.text)}`,
  )
  return pass
}

function expectDenied(rec, name, res, mustContain = []) {
  const ok = res.denied === true && res.layer !== 'missing'
  const missing = mustContain.filter((s) => !hit(res.text, s))
  const pass = ok && missing.length === 0
  rec.add(
    name,
    pass,
    pass
      ? `拦截层：${res.layer}\n拒绝原文：\n${indent(res.text)}`
      : `期望被拒但结果是 denied=${res.denied} layer=${res.layer}` +
        (missing.length > 0 ? `\n拒绝原文缺少关键片段：${missing.join(' ｜ ')}` : '') +
        `\n实际原文：\n${indent(res.text)}`,
  )
  return pass
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 一份合法的选择题请求体（走**摊平**路径 `pipeline_human_request`）。 */
function makeRequest(over = {}) {
  return {
    reason_kind: 'requirement_confirmation',
    question_for_human: '这一步的授权口径你给到哪一步？先查、必要时就改，还是只查不改？这条得你定，我不替你拍板。',
    context_for_human: '两种口径会做出不一样的东西，角色之间定不了。',
    options: [
      { label: '先查，必要时就改', consequence: '先花很小成本查清；确实必须改就原地改掉这一处，等你重启后确认生效。' },
      { label: '只查不改，查完报告', consequence: '只查可行性并报给你，绝不改码；若必须改码就停下等你另行决定。' },
    ],
    recommended: '先查，必要时就改',
    blocking: true,
    blocked_stage: '需求确认：等待用户给出授权口径',
    urgency: 'normal',
    decision_kind: 'choose_option',
    timeout_behavior: 'stay_blocked',
    ...over,
  }
}

/** 同一份请求，但走**结构化**路径 `pipeline_handoff{kind:"human_request"}`。 */
function makeStructuredPayload(taskId, over = {}) {
  const r = makeRequest(over)
  return {
    task_id: taskId,
    from_role: 'tester',
    reason_kind: r.reason_kind,
    question_for_human: r.question_for_human,
    context_for_human: r.context_for_human,
    options: r.options,
    recommended: r.recommended,
    blocking: r.blocking,
    blocked_stage: r.blocked_stage,
    urgency: r.urgency,
    decision_kind: r.decision_kind,
    timeout_behavior: r.timeout_behavior,
  }
}

/**
 * ★ 造出「登记表被清空、交接物还在」的卡死现场。
 *
 * 怎么造才**真的**像现场：直接在**盘上**的 task.json 里把登记表清掉
 * （这正是当初漏登记留下的形状），然后把内存缓存丢掉 —— 让插件下一次读盘时
 * 面对一个"和线上卡死单长得一模一样"的任务。
 *
 * 刻意**不用** `store` 的写接口（那会把交接物一起改掉）：这里要留的就是那种
 * 半截形状 —— 交接物好好的，只是登记表空了。
 *
 * @returns {{before:number, handoffId:string|null, file:string}} 清空前的条数 + 仍在盘上的交接物
 */
async function breakRegistry(h, taskId) {
  const t = await h.store.get(taskId)
  const handoffs = t.handoffs.filter((x) => x.kind === 'human_request')
  const before = t.human_requests.length
  const file = join(h.projectRoot, '.pipeline', taskId, 'task.json')
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  onDisk.human_requests = []
  await writeFile(file, JSON.stringify(onDisk, null, 2), 'utf8')
  h.store.dropCache(taskId)
  return { before, handoffId: handoffs.at(-1)?.handoff_id ?? null, file }
}

/** 直接读盘看登记表 —— 绕开内存缓存（也不触发读盘兜底）。 */
async function registryOnDisk(file) {
  return JSON.parse(await readFile(file, 'utf8')).human_requests ?? []
}

/** 单条断言：登记表里到底有没有这条交接物对应的登记。 */
function registryHas(task, handoffId) {
  return (task.human_requests ?? []).find((r) => r.handoff_id === handoffId) ?? null
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runHumanRegistryCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // 正例 ①：两条提交路径**都必须登记**
  // =========================================================================
  {
    const f = await createGuardFixture({ stopAfter: 5 }) // 停在 testing
    open.push(f.h)
    const h = f.h

    rec.add(
      '正例① 夹具就绪：任务停在「测试中」，主/编写/测试三个角色都已派出',
      f.state === 'testing',
      `taskId=${f.taskId} state=${f.state} agents=${JSON.stringify(f.agents)}`,
    )

    // --- 路径 A：pipeline_human_request（摊平参数） -------------------------
    const raisedA = await callTool(h, 'pipeline_human_request', { task_id: f.taskId, ...makeRequest(), role_token: f.tokens.tester }, f.agents.tester)
    expectOk(rec, '正例①A pipeline_human_request：发起并登记', raisedA, ['请求已登记', '等待人工答复'])
    const ridA = raisedA.value?.request_id ?? ''

    const tA = await h.store.get(f.taskId)
    const hA = tA.handoffs.filter((x) => x.kind === 'human_request').at(-1) ?? null
    const eA = registryHas(tA, hA?.handoff_id)
    rec.add(
      '正例①A 两条数据源**同时**有了：交接物在 task.handoffs，登记在 task.human_requests',
      hA !== null && eA !== null && eA.request_id === ridA && eA.status === 'pending',
      `handoff=$(handoff_id=${hA?.handoff_id})\n登记=$(request_id=${eA?.request_id} handoff_id=${eA?.handoff_id} status=${eA?.status})`,
    )

    // 原件落盘 + 与登记表用 handoff_id 对上
    const dirA = join(h.projectRoot, '.pipeline', f.taskId, 'handoffs')
    let filesA = []
    try { filesA = await readdir(dirA) } catch { filesA = [] }
    const fileA = filesA.find((n) => n.includes('human_request'))
    const originalA = fileA === undefined ? null : JSON.parse(await readFile(join(dirA, fileA), 'utf8'))
    rec.add(
      '正例①A 请求**原件**落盘，且与登记表用同一个 handoff_id 对上',
      originalA !== null && originalA.kind === 'human_request' && originalA.handoff_id === eA?.handoff_id,
      `文件：${filesA.join(', ')}\n原件 handoff_id=${originalA?.handoff_id}　登记 handoff_id=${eA?.handoff_id}`,
    )

    // 收件箱立刻列得出（这是当初列不出的那一步）
    const inboxA = await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, role_token: f.tokens.main }, f.agents.main)
    expectOk(rec, '正例①A 收件箱当场列得出这条请求（不再"没有任何人工介入请求"）', inboxA, ['人工介入请求', ridA, '待转告'])

    // --- 路径 B：pipeline_handoff{kind:"human_request"}（结构化） -----------
    const raisedB = await callTool(
      h,
      'pipeline_handoff',
      { task_id: f.taskId, kind: 'human_request', role_token: f.tokens.tester, payload: makeStructuredPayload(f.taskId) },
      f.agents.tester,
    )
    expectOk(rec, '正例①B pipeline_handoff{kind:"human_request"}：发起并登记', raisedB, ['交接物已提交', 'human_request'])

    const tB = await h.store.get(f.taskId)
    const humanHandoffs = tB.handoffs.filter((x) => x.kind === 'human_request')
    const hB = humanHandoffs.at(-1) ?? null
    const eB = registryHas(tB, hB?.handoff_id)
    rec.add(
      '正例①B 结构化路径**也**登记上了（两条路径都不漏）',
      humanHandoffs.length === 2 && hB !== null && eB !== null && eB.handoff_id === hB.handoff_id,
      `human_request 交接物 ${humanHandoffs.length} 份：${humanHandoffs.map((x) => x.handoff_id).join(', ')}\n` +
        `最后一份的登记：${eB === null ? '（没有！）' : `request_id=${eB.request_id} status=${eB.status}`}`,
    )

    const inboxB = await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, role_token: f.tokens.main }, f.agents.main)
    expectOk(rec, '正例①B 收件箱列出**两条**待转告请求', inboxB, ['共 2 条', '待处理 2 条'])

    // 同一个 handoff_id 不会被重复登记（幂等）
    const before = (await h.store.get(f.taskId)).human_requests.length
    const again = await h.store.submitHandoff({
      taskId: f.taskId,
      kind: 'human_request',
      actorRole: 'tester',
      actorAgentId: f.agents.tester,
      payload: makeStructuredPayload(f.taskId),
    })
    const after = (await h.store.get(f.taskId)).human_requests.length
    rec.add(
      '正例①C 登记是幂等的：同一份交接物再提交一次，登记表不会长出重复条目',
      again.ok === true && after === before + (again.ok === true ? 1 : 0),
      `提交前 ${before} 条 → 提交后 ${after} 条（这次是新交接物 ⇒ 应当 +1；关键是没有为**同一个** handoff_id 重复登记）`,
    )
    rec.add(
      '正例①C 登记表里每条 handoff_id 都唯一（没有重复登记）',
      new Set((await h.store.get(f.taskId)).human_requests.map((r) => r.handoff_id)).size ===
        (await h.store.get(f.taskId)).human_requests.length,
      `登记表：${(await h.store.get(f.taskId)).human_requests.map((r) => `${r.request_id}←${r.handoff_id}`).join('\n           ')}`,
    )
  }

  // =========================================================================
  // 正例 ②：兜底 —— 登记表被清空但交接物在 ⇒ 收件箱列得出、答复记得回
  // =========================================================================
  {
    const f = await createGuardFixture({ stopAfter: 5 })
    open.push(f.h)
    const h = f.h

    const raised = await callTool(h, 'pipeline_human_request', { task_id: f.taskId, ...makeRequest(), role_token: f.tokens.tester }, f.agents.tester)
    const rid = raised.value?.request_id ?? ''
    const question = makeRequest().question_for_human

    const broken = await breakRegistry(h, f.taskId)
    // ① 盘上确实就是那个半截现场：登记表 []，交接物还好好地在 handoffs 里。
    const diskReg = await registryOnDisk(broken.file)
    const diskTask = JSON.parse(await readFile(broken.file, 'utf8'))
    const diskHandoffs = (diskTask.handoffs ?? []).filter((x) => x.kind === 'human_request')
    rec.add(
      '正例② 现场已复现（①盘上）：登记表是空的，但 human_request 交接物还在 —— 这就是卡死单的形状',
      broken.before === 1 && diskReg.length === 0 && diskHandoffs.length === 1 && diskTask.state === 'awaiting_human',
      `清空前登记 ${broken.before} 条\n` +
        `盘上 human_requests = ${JSON.stringify(diskReg)}\n` +
        `盘上 human_request 交接物 = ${diskHandoffs.map((x) => x.handoff_id).join(', ')}\n` +
        `盘上 state = ${diskTask.state}（状态机认了它，所以任务推不动）`,
    )

    // ② 读盘兜底**自动**把它补回来（这一条就是"已卡死的单也能救回来"的判据）。
    const t0 = await h.store.get(f.taskId)
    rec.add(
      '正例② 现场已复现（②读盘即自愈）：插件一读盘就把登记补回来了 —— 不需要人工干预',
      (t0.human_requests ?? []).length === 1 && t0.human_requests[0].handoff_id === broken.handoffId,
      `读盘后 human_requests = ${(t0.human_requests ?? []).length} 条\n` +
        `补回的那条 handoff_id = ${t0.human_requests?.[0]?.handoff_id}（期望 ${broken.handoffId}）\n` +
        `recovered_from_handoff = ${t0.human_requests?.[0]?.recovered_from_handoff}`,
    )

    // --- 兜底：收件箱列得出的那一步 -----------------------------------------
    const inbox = await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, role_token: f.tokens.main }, f.agents.main)
    expectOk(
      rec,
      '正例②兜底 收件箱**列得出**了（修复前：这里回"没有任何人工介入请求"）',
      inbox,
      ['人工介入请求', '待转告'],
    )

    const t2 = await h.store.get(f.taskId)
    const e2 = registryHas(t2, broken.handoffId)
    rec.add(
      '正例②兜底 登记已按「交接物 + awaiting_human 状态」重建',
      e2 !== null && e2.request_id === rid && e2.status === 'pending' && e2.recovered_from_handoff === true,
      `重建的登记：request_id=${e2?.request_id}（原 ${rid}）status=${e2?.status} recovered_from_handoff=${e2?.recovered_from_handoff}`,
    )
    rec.add(
      '正例②兜底 重建出来的**问题原文**与原件一字不差（没有凭空造）',
      e2 !== null && e2.question_for_human === question,
      `登记里的问题：\n${indent(e2?.question_for_human ?? '(空)')}\n原件里的问题：\n${indent(question)}`,
    )

    // 状态**没被**兜底动作改动（它本来就在等待态，兜底只补登记）
    rec.add(
      '正例②兜底 兜底动作**不改任务状态**（仍在「等待人工答复」）',
      t2.state === 'awaiting_human' && t2.previous_state === 'testing',
      `state=${t2.state} previous_state=${t2.previous_state}`,
    )

    // --- 兜底：答复记得回的那一步 -------------------------------------------
    const relayed = await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, request_id: rid, role_token: f.tokens.main }, f.agents.main)
    expectOk(rec, '正例②兜底 转告成功（拿到"照抄给用户看"的原文块 + 确认码）', relayed, ['照抄这段', '确认码'])

    const replied = await callTool(
      h,
      'pipeline_human_reply',
      {
        task_id: f.taskId,
        request_id: rid,
        user_quote: '先查吧，确实必须改的话就改这一处，重启我自己来。',
        reply_channel: 'chat',
        attribution: '用户在当前会话里直接回复',
        chosen_option: '先查，必要时就改',
        role_token: f.tokens.main,
      },
      f.agents.main,
    )
    expectOk(rec, '正例②兜底 答复**记得回**了，并据答复恢复状态', replied, ['已记录答复并推进', '测试中'])

    const t3 = await h.store.get(f.taskId)
    const e3 = registryHas(t3, broken.handoffId)
    rec.add(
      '正例②兜底 答复 + 恢复四步在**重建的那条登记**上走完，状态回到被打断前',
      t3.state === 'testing' && e3?.status === 'answered' && e3?.resumed_from === 'awaiting_human' && e3?.resumed_to === 'testing',
      `state=${t3.state}（期望 testing）\nstatus=${e3?.status}（期望 answered）\nresumed ${e3?.resumed_from} → ${e3?.resumed_to}`,
    )

    // 留痕：兜底本身也要在 audit 里看得见（不然一次静默修复就把根因盖住了）
    const audit = await h.store.auditLog(f.taskId)
    const recLine = audit.find((a) => a.action === 'human:recovered')
    rec.add(
      '正例②兜底 兜底动作**留痕**（audit.jsonl 有 human:recovered，含原因）',
      recLine !== undefined && typeof recLine.reason === 'string' && recLine.reason.includes('反推补登记'),
      `human:recovered 审计行：\n${indent(JSON.stringify(recLine ?? null, null, 2))}`,
    )

    // 幂等：兜底跑第二遍不该再补一条
    const sizeBefore = t3.human_requests.length
    const t4 = await h.store.get(f.taskId)
    const again = h.store.reconcileHumanRequests(t4)
    rec.add(
      '正例②兜底 兜底**幂等**：再跑一遍补 0 条（不会越长越多）',
      again === 0 && (await h.store.get(f.taskId)).human_requests.length === sizeBefore,
      `第二次兜底返回值=${again}（期望 0）；登记条数 ${sizeBefore} → ${(await h.store.get(f.taskId)).human_requests.length}`,
    )
  }

  // =========================================================================
  // 反例 ③：既有反例不许回退 —— 主对话不能自行把请求标记为已解决
  // =========================================================================
  {
    const f = await createGuardFixture({ stopAfter: 5 })
    open.push(f.h)
    const h = f.h

    const raised = await callTool(h, 'pipeline_human_request', { task_id: f.taskId, ...makeRequest(), role_token: f.tokens.tester }, f.agents.tester)
    const rid = raised.value?.request_id ?? ''

    // ★ 先把请求**正常转告**给用户 —— 这样才轮得到"记录用户答复"那道闸。
    //   不转告的话，先撞上的是"还没转告怎么可能有答复"，测不到要测的那一条。
    await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, request_id: rid, role_token: f.tokens.main }, f.agents.main)

    // (a) 直接推事件（没有答复记录）
    const direct = await callTool(h, 'pipeline_transition', { task_id: f.taskId, event: 'human_reply', role_token: f.tokens.main }, f.agents.main)
    expectDenied(
      rec,
      '反例③a 主对话直接推 human_reply（已转告、但没有答复记录）—— 兜底没有把这道闸放宽',
      direct,
      ['还没有记录用户答复', '不能自行把请求标记为已解决'],
    )

    // (b) 答复形状不对：选择题却给了布尔（转告过 ⇒ 撞的是形状那道闸）
    const wrongShape = await callTool(
      h,
      'pipeline_human_reply',
      { task_id: f.taskId, request_id: rid, user_quote: '我觉得可以放行', attribution: '用户', answer: true, role_token: f.tokens.main },
      f.agents.main,
    )
    expectDenied(rec, '反例③b 请求问的是"选哪个"，主对话回了个布尔（形状对不上）', wrongShape, ['choose_option', '必须给 chosen_option'])

    // (c) 兜底**不能**被当成"替用户拍板"的通道：清空登记表后
    //     主对话仍然不能留下一条"已解决"的记录。
    //     ★ 重建出来的登记 `relayed_at` 是空的（转告痕迹随登记一起没了，这是**有意保守**：
    //       宁可让主对话重新转告一次，也不许凭兜底伪造一条"已经答复"的记录）。
    const broken = await breakRegistry(h, f.taskId)
    const forged = await callTool(
      h,
      'pipeline_human_reply',
      { task_id: f.taskId, request_id: rid, user_quote: '用户说可以，直接过', attribution: '用户', chosen_option: '先查，必要时就改', role_token: f.tokens.main },
      f.agents.main,
    )
    expectDenied(
      rec,
      '反例③c 登记表被清空后，主对话仍不能凭"兜底"伪造用户答复（兜底也没放宽转告闸）',
      forged,
      ['还没有转告给用户', '不可能有用户答复'],
    )

    const st = await h.store.get(f.taskId)
    rec.add(
      '反例③ 三次尝试之后：任务仍停在「等待人工答复」，登记是 pending（没有被标记为已解决）',
      st.state === 'awaiting_human' && registryHas(st, broken.handoffId)?.status === 'pending',
      `state=${st.state}　登记 status=${registryHas(st, broken.handoffId)?.status}　answered_at=${registryHas(st, broken.handoffId)?.answered_at}`,
    )

    // (d) 越权：非 main 也不能借兜底把请求标成已解决
    const byTester = await callTool(
      h,
      'pipeline_human_reply',
      { task_id: f.taskId, request_id: rid, user_quote: '用户说行', attribution: '用户', chosen_option: '先查，必要时就改', role_token: f.tokens.tester },
      f.agents.tester,
    )
    expectDenied(rec, '反例③d 测试角色不能自己记"用户答复"（越权仍然被拦）', byTester, ['角色越权', '允许角色：main'])
  }

  // =========================================================================
  // 反例 ④：兜底**不覆盖已有记录** —— 答复过的不许被"修复"回 pending
  // =========================================================================
  {
    const f = await createGuardFixture({ stopAfter: 5 })
    open.push(f.h)
    const h = f.h

    const raised = await callTool(h, 'pipeline_human_request', { task_id: f.taskId, ...makeRequest(), role_token: f.tokens.tester }, f.agents.tester)
    const rid = raised.value?.request_id ?? ''
    await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, request_id: rid, role_token: f.tokens.main }, f.agents.main)
    await callTool(
      h,
      'pipeline_human_reply',
      {
        task_id: f.taskId,
        request_id: rid,
        user_quote: '就按第一条来，先查再说。',
        reply_channel: 'chat',
        attribution: '用户在当前会话里直接回复',
        chosen_option: '先查，必要时就改',
        role_token: f.tokens.main,
      },
      f.agents.main,
    )

    const t = await h.store.get(f.taskId)
    const entry = t.human_requests.find((r) => r.request_id === rid)
    const before = JSON.stringify(entry)

    // 兜底跑一遍（此时登记是完整的、已答复）
    const recovered = h.store.reconcileHumanRequests(t)
    const after = JSON.stringify((await h.store.get(f.taskId)).human_requests.find((r) => r.request_id === rid))

    rec.add(
      '反例④ 已答复（answered）的登记：兜底补 0 条，且整条记录**一个字节都没变**',
      recovered === 0 && before === after && entry.status === 'answered',
      `兜底返回值=${recovered}（期望 0）\n记录未变：${before === after}\nstatus=${entry.status} answered_at=${entry.answered_at} 恢复目标=${entry.resumed_to}`,
    )

    // 再答复一次必须仍被拒（不能借兜底重放）
    const againReply = await callTool(
      h,
      'pipeline_human_reply',
      {
        task_id: f.taskId,
        request_id: rid,
        user_quote: '我再改一次主意，换成第二条。',
        reply_channel: 'chat',
        attribution: '用户在当前会话里直接回复',
        chosen_option: '只查不改，查完报告',
        role_token: f.tokens.main,
      },
      f.agents.main,
    )
    expectDenied(rec, '反例④ 已答复的请求不能再答复一次（不能借兜底重放）', againReply, ['已经答复过了', '不能重复答复'])

    // 兜底也不能把 resolved/answered 的记录重新变成待办
    const pending = (await h.store.get(f.taskId)).human_requests.filter((r) => r.status !== 'answered' && r.status !== 'withdrawn')
    rec.add(
      '反例④ 兜底之后，待办列表里**没有**这条已答复的请求（没有被"修复"回 pending）',
      pending.every((r) => r.request_id !== rid),
      `待办：${pending.length === 0 ? '（空）' : pending.map((r) => `${r.request_id}[${r.status}]`).join(', ')}`,
    )
  }

  // =========================================================================
  // 正例 ⑤：★ 兜底要覆盖**非阻塞**的请求（本轮修的那条漏路之一）
  // =========================================================================
  //
  //  现场：真单 T-20261011-214043 里点名"取不出来"的三条交接物
  //  （H-8411d229ed7e1ae7 / H-4b0ec20e3bc9c52e / H-b7f6a9c75eb23ae6）
  //  **payload.blocking 全是 false**。而旧兜底要求"任务停在 awaiting_human" ——
  //  非阻塞请求压根不进等待态（`planAdvance`：不打断流程），
  //  于是这条判据对它们**一条都盖不住** ⇒ 漏了就永远救不回来。
  {
    const f = await createGuardFixture({ stopAfter: 5 })
    open.push(f.h)
    const h = f.h

    const raised = await callTool(
      h,
      'pipeline_human_request',
      {
        task_id: f.taskId,
        ...makeRequest({
          blocking: false,
          blocked_stage: undefined,
          decision_kind: 'free_text',
          timeout_behavior: 'stay_blocked',
        }),
        role_token: f.tokens.tester,
      },
      f.agents.tester,
    )
    const rid = raised.value?.request_id ?? ''
    const t1 = await h.store.get(f.taskId)
    rec.add(
      '正例⑤ 非阻塞请求（blocking=false）也登记，且**不打断流程**（不进等待态）',
      raised.denied !== true && t1.state === 'testing' && (t1.human_requests ?? []).some((r) => r.request_id === rid),
      `发起 denied=${raised.denied}　state=${t1.state}（期望 testing —— 非阻塞不打断流程）\n` +
        `登记条数=${(t1.human_requests ?? []).length}　request_id=${rid}`,
    )

    const broken = await breakRegistry(h, f.taskId)
    const t2 = await h.store.get(f.taskId) // 读盘 ⇒ 自愈
    rec.add(
      '正例⑤ 登记表被清空 + **非阻塞**请求 ⇒ 兜底照样反推出这条登记（旧判据在这里一条都盖不住）',
      (t2.human_requests ?? []).length === 1 &&
        t2.human_requests[0].handoff_id === broken.handoffId &&
        t2.human_requests[0].recovered_from_handoff === true &&
        t2.state !== 'awaiting_human',
      `state=${t2.state}（非等待态也要能反推）\n` +
        `反推回来的登记：handoff_id=${t2.human_requests?.[0]?.handoff_id}（期望 ${broken.handoffId}）` +
        `　status=${t2.human_requests?.[0]?.status}　recovered_from_handoff=${t2.human_requests?.[0]?.recovered_from_handoff}`,
    )

    const inbox = await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, role_token: f.tokens.main }, f.agents.main)
    expectOk(rec, '正例⑤ 收件箱**列得出**这条非阻塞请求（修复前：这里回"目前没有人工介入请求"）', inbox, ['人工介入请求', '共 1 条', '待处理 1 条'])

    // 答复照样记得回：非阻塞请求不进等待态 ⇒ 答复**不动状态**（这是它本来的语义）
    await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, request_id: rid, role_token: f.tokens.main }, f.agents.main)
    const replied = await callTool(
      h,
      'pipeline_human_reply',
      {
        task_id: f.taskId,
        request_id: rid,
        user_quote: '这件事先按你说的办，不用等我。',
        reply_channel: 'chat',
        attribution: '用户在当前会话里直接回复',
        answer_text: '先按你说的办，不用等我',
        role_token: f.tokens.main,
      },
      f.agents.main,
    )
    const t3 = await h.store.get(f.taskId)
    const e3 = (t3.human_requests ?? []).find((r) => r.request_id === rid) ?? null
    rec.add(
      '正例⑤ 答复**记得回**：反推出来的那条也能走完转告→答复（非阻塞 ⇒ 状态不动）',
      replied.denied !== true && e3?.status === 'answered' && t3.state === 'testing',
      `答复 denied=${replied.denied}　登记 status=${e3?.status}　state=${t3.state}（期望 testing：非阻塞请求不推状态）`,
    )
  }

  // =========================================================================
  // 正例 ⑥：★ 兜底不能只在"读盘那一次"生效（本轮修的那条漏路之二）
  // =========================================================================
  //
  //  现场：`cache` 是模块级 Map，**在插件进程里从不失效**（`dropCache` 只有测试在用）。
  //  早先自愈只挂在 `loadTask` 的**读盘分支**上（缓存命中直接 return）⇒
  //  **同一次运行里漏过一次登记，就再也不会自愈**，只有重启才修得好。
  {
    const f = await createGuardFixture({ stopAfter: 5 })
    open.push(f.h)
    const h = f.h

    const raised = await callTool(h, 'pipeline_human_request', { task_id: f.taskId, ...makeRequest(), role_token: f.tokens.tester }, f.agents.tester)
    const rid = raised.value?.request_id ?? ''
    const handoffId = (await h.store.get(f.taskId)).handoffs.filter((x) => x.kind === 'human_request').at(-1)?.handoff_id ?? null

    // 造"半截现场"：内存对象与盘上同时少这条登记（appendHandoff 之后、登记之前被打断的形状），
    // ★ 关键是**不清缓存** —— 真实运行里缓存就是这么一直热着的。
    const live = h.store.peek(f.taskId)
    live.human_requests = []
    await breakRegistry(h, f.taskId)

    const inbox = await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, role_token: f.tokens.main }, f.agents.main)
    expectOk(
      rec,
      '正例⑥ 缓存**热着**的时候也自愈（修复前：缓存命中直接 return ⇒ 这条永远自愈不了，只能重启）',
      inbox,
      ['人工介入请求', '共 1 条', '待处理 1 条'],
    )

    const t = await h.store.get(f.taskId)
    rec.add(
      '正例⑥ 缓存路径上补回来的登记与交接物对得上，且带 recovered_from_handoff 留痕',
      (t.human_requests ?? []).length === 1 &&
        t.human_requests[0].handoff_id === handoffId &&
        t.human_requests[0].request_id === rid &&
        t.human_requests[0].recovered_from_handoff === true,
      `反推回来的登记：request_id=${t.human_requests?.[0]?.request_id}（原 ${rid}）\n` +
        `handoff_id=${t.human_requests?.[0]?.handoff_id}（期望 ${handoffId}）\n` +
        `recovered_from_handoff=${t.human_requests?.[0]?.recovered_from_handoff}`,
    )

    const relay = await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, request_id: rid, role_token: f.tokens.main }, f.agents.main)
    expectOk(rec, '正例⑥ 按 id 也能转告（修复前：这条回"没有任何人工介入请求"）', relay, ['照抄这段', '确认码'])
  }

  // =========================================================================
  // 反例 ⑦：本轮放宽判据（去掉 awaiting_human 限定）**没有**放宽任何反例
  // =========================================================================
  {
    const f = await createGuardFixture({ stopAfter: 5 })
    open.push(f.h)
    const h = f.h

    const raised = await callTool(h, 'pipeline_human_request', { task_id: f.taskId, ...makeRequest(), role_token: f.tokens.tester }, f.agents.tester)
    const rid = raised.value?.request_id ?? ''
    await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, request_id: rid, role_token: f.tokens.main }, f.agents.main)

    // ① 还**没有**答复记录时：主对话不能自己推 human_reply（兜底没有把这道闸放宽）
    const direct = await callTool(h, 'pipeline_transition', { task_id: f.taskId, event: 'human_reply', role_token: f.tokens.main }, f.agents.main)
    expectDenied(
      rec,
      '反例⑦ 判据放宽之后：主对话仍然**不能**自行推 human_reply（没有答复记录就走不动）',
      direct,
      ['不能自行把请求标记为已解决', '还没有记录用户答复'],
    )

    // ② 正常答复一次，再让兜底跑一遍：已答复的记录必须逐字节不变
    await callTool(
      h,
      'pipeline_human_reply',
      {
        task_id: f.taskId,
        request_id: rid,
        user_quote: '就按第一条来，先查再说。',
        reply_channel: 'chat',
        attribution: '用户在当前会话里直接回复',
        chosen_option: '先查，必要时就改',
        role_token: f.tokens.main,
      },
      f.agents.main,
    )
    const answeredBefore = JSON.stringify((await h.store.get(f.taskId)).human_requests.find((r) => r.request_id === rid))
    const recovered = h.store.reconcileHumanRequests(await h.store.get(f.taskId))
    const answeredAfter = JSON.stringify((await h.store.get(f.taskId)).human_requests.find((r) => r.request_id === rid))
    rec.add(
      '反例⑦ 判据放宽之后：**已答复**的记录仍然一个字节都不许变、兜底补 0 条',
      recovered === 0 && answeredBefore === answeredAfter,
      `兜底返回值=${recovered}（期望 0）　记录未变=${answeredBefore === answeredAfter}`,
    )

    // ③ 已答复的请求再答复一次仍被拒（不能借兜底重放）
    const again = await callTool(
      h,
      'pipeline_human_reply',
      {
        task_id: f.taskId,
        request_id: rid,
        user_quote: '我再改一次主意，换成第二条。',
        reply_channel: 'chat',
        attribution: '用户在当前会话里直接回复',
        chosen_option: '只查不改，查完报告',
        role_token: f.tokens.main,
      },
      f.agents.main,
    )
    expectDenied(rec, '反例⑦ 判据放宽之后：已答复的请求再答复一次仍被拒（不能借兜底重放）', again, ['已经答复过了', '不能重复答复'])
  }

  // =========================================================================
  // 正例 ⑧：★★ **写读并发下不出现「交接物可见、登记不可见」的半截状态**
  // =========================================================================
  //
  //  现场（真单 T-20261012-7b9408，2026-10-11T16:33–16:34）：盘上 `human_requests[]`
  //  里明明有一条 pending，主对话调收件箱却是「目前没有人工介入请求」。
  //  读侧路径：`lib/tools/human.js` → `store.listHumanRequests` → `loadTask` 的
  //  `cache.get` 命中分支（内存实例优先、不对账）。
  //  成因：`appendHandoff` 先 `task.handoffs.push`、再 `await writeJsonAtomic` ——
  //  那个 await 就是让出点；而旧代码把"建登记"排在它**之后几百行**，中间还夹着
  //  `audit` + 整份 task.json 的 `persist`。于是读者能长时间看到：
  //  **handoffs 里已经有了这份 human_request，human_requests 里还没有**。
  //
  //  这一条就是把那个窗口钉死的判据：写事务期间高频采样，
  //  **不允许出现 `交接物≥1 且 登记=0`** 的样本。
  {
    const f = await createGuardFixture({ stopAfter: 5 })
    open.push(f.h)
    const h = f.h
    const tick = () => new Promise((r) => setImmediate(r))

    const n0 = h.store.peek(f.taskId).handoffs.filter((x) => x.kind === 'human_request').length
    const p = callTool(h, 'pipeline_human_request', { task_id: f.taskId, ...makeRequest(), role_token: f.tokens.tester }, f.agents.tester)
    let done = false
    p.then(() => { done = true }, () => { done = true })
    const torn = []
    let samples = 0
    for (let i = 0; i < 500 && !done; i++) {
      await tick()
      const t = h.store.peek(f.taskId)
      const hh = t.handoffs.filter((x) => x.kind === 'human_request').length - n0
      const hr = (t.human_requests ?? []).length
      samples += 1
      if (hh >= 1 && hr === 0) torn.push(`交接物=${hh} 登记=${hr}`)
    }
    const raised = await p
    const t1 = h.store.peek(f.taskId)
    rec.add(
      '正例⑧ ★写读并发：不出现「交接物可见、登记不可见」的半截状态',
      raised.denied !== true && samples > 0 && torn.length === 0 &&
        t1.handoffs.filter((x) => x.kind === 'human_request').length === n0 + 1 &&
        t1.human_requests.length === 1,
      `写事务期间采样 ${samples} 次\n` +
        `半截状态（交接物≥1 且 登记=0）出现次数：${torn.length}${torn.length > 0 ? `　例：${torn[0]}` : '（一次都没有 ✓）'}\n` +
        `最终：交接物 ${t1.handoffs.filter((x) => x.kind === 'human_request').length} 份 · 登记 ${t1.human_requests.length} 条\n` +
        '★ 判据：`handoffs` 与 `human_requests` 必须在**同一个同步块**里各自就位 —— ' +
        '两者之间不许有 await 让出点（旧代码在 500 次采样里中了近 400 次）。',
    )

    // ★★ 「**写入后立刻读**」—— 不 sleep、不重试、不等一拍：写事务一返回，下一次工具
    //    调用就是收件箱。这一条是用户点名要的时序正例（今晚复发多次的就是它）。
    const immediate = await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, role_token: f.tokens.main }, f.agents.main)
    expectOk(
      rec,
      '正例⑧ ★「写入后立刻读」：提交一返回就调收件箱 ⇒ 立刻列得出这条 pending',
      immediate,
      ['人工介入请求', '共 1 条', '待处理 1 条'],
    )
  }

  // =========================================================================
  // 正例 ⑨：★★ **读前对账** —— 盘比内存新 ⇒ 重载（"写进去了、读不到"）
  // =========================================================================
  //
  //  这条复刻的就是现场：**盘上那份 task.json 已有登记，而内存里那份实例没有**
  //  （另一个实例写的 / 更早读进来的旧实例）。旧 `loadTask` 缓存命中直接 return，
  //  一个字节都不看盘 ⇒ 收件箱答「目前没有」、按 id 转告也被拒。
  {
    const f = await createGuardFixture({ stopAfter: 5 })
    open.push(f.h)
    const h = f.h

    const raised = await callTool(h, 'pipeline_human_request', { task_id: f.taskId, ...makeRequest(), role_token: f.tokens.tester }, f.agents.tester)
    const rid = raised.value?.request_id ?? ''
    const file = join(h.projectRoot, '.pipeline', f.taskId, 'task.json')
    const diskBefore = JSON.parse(await readFile(file, 'utf8'))
    const onDisk = (diskBefore.human_requests ?? []).find((r) => r.request_id === rid) ?? null

    // ★ 造"内存那份不是最新的"：内存实例丢掉这条登记，盘上原样保留
    //   （不 dropCache —— 真实运行里没人会去丢缓存）
    h.store.peek(f.taskId).human_requests = []

    const inbox = await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, role_token: f.tokens.main }, f.agents.main)
    expectOk(
      rec,
      '正例⑨ ★读前对账：盘上已有登记、内存实例没有 ⇒ 收件箱仍列得出（修复前：回"目前没有人工介入请求"）',
      inbox,
      ['人工介入请求', '共 1 条', '待处理 1 条'],
    )
    rec.add(
      '正例⑨ ★读前对账：重载之后内存实例与盘上一致（不是只把答案糊过去）',
      onDisk !== null &&
        (h.store.peek(f.taskId).human_requests ?? []).some((r) => r.request_id === rid),
      `盘上那条：request_id=${onDisk?.request_id} status=${onDisk?.status}\n` +
        `对账后内存里：${(h.store.peek(f.taskId).human_requests ?? []).map((r) => `${r.request_id}[${r.status}]`).join(', ')}`,
    )
    const relay = await callTool(h, 'pipeline_human_relay', { task_id: f.taskId, request_id: rid, role_token: f.tokens.main }, f.agents.main)
    expectOk(rec, '正例⑨ ★读前对账：按 id 转告也走得通（修复前：被拒 NOT_FOUND）', relay, ['照抄这段', '确认码'])
  }

  // =========================================================================
  // 反例 ⑩：对账**不误伤** —— 本进程刚写完的那份就是盘上那份 ⇒ 不重载、不白读
  // =========================================================================
  //
  //  为什么必须有这条：对账要是把"自己刚写的"也判成"盘更新"，就会在每次写完的
  //  下一次读里白重载一遍 —— 更糟的是，在途的调用方正握着旧对象，重载会让
  //  **同一个任务在进程里同时存在两个对象**（那才是真正的漂移源）。
  {
    const f = await createGuardFixture({ stopAfter: 5 })
    open.push(f.h)
    const h = f.h

    const raised = await callTool(h, 'pipeline_human_request', { task_id: f.taskId, ...makeRequest(), role_token: f.tokens.tester }, f.agents.tester)
    const before = h.store.peek(f.taskId)
    const same = (await h.store.get(f.taskId)) === before
    const again = (await h.store.get(f.taskId)) === before
    rec.add(
      '反例⑩ 对账不误伤：本进程刚写完 ⇒ 读回来的还是**同一个实例**（不白重载、不制造双对象）',
      raised.denied !== true && same && again,
      `写完之后读两次：同一实例 = ${same} / ${again}（期望 true/true）\n` +
        '★ 手段：`persist()` 落盘后立刻把指纹对齐成盘上的实际值 ⇒ 自己写的不会判成"盘更新"。',
    )

    // 反向：内存里那份**比盘上新**（写还在途）时，读侧不许把内存往回退
    const live = h.store.peek(f.taskId)
    const nMem = live.human_requests.length
    live.human_requests.push({ ...live.human_requests[0], request_id: 'HR-INFLIGHT-ONLY', status: 'pending' })
    const after = await h.store.get(f.taskId)
    rec.add(
      '反例⑩ 内存比盘新（写还在途）时，读侧**不许把内存往回退**成盘上的旧值',
      after === live && after.human_requests.length === nMem + 1,
      `内存里多一条"在途"登记后读回来：同一实例=${after === live}　登记条数=${after.human_requests.length}（期望 ${nMem + 1}）`,
    )
  }

  // =========================================================================
  // 出报告
  // =========================================================================
  const groupOf = (name) => {
    if (name.startsWith('正例①A')) return '正例① 两条提交路径都登记 · 路径 A：pipeline_human_request（摊平）'
    if (name.startsWith('正例①B')) return '正例① 两条提交路径都登记 · 路径 B：pipeline_handoff{kind:"human_request"}（结构化）'
    if (name.startsWith('正例①C')) return '正例① 兜底之外的正常性质：登记幂等、handoff_id 唯一'
    if (name.startsWith('正例①')) return '正例① 夹具'
    if (name.startsWith('正例②')) return '正例② 兜底：登记表被清空但交接物在 ⇒ 收件箱列得出、答复记得回'
    if (name.startsWith('反例③')) return '反例③ 既有反例不许回退：主对话不能自行把请求标记为已解决'
    if (name.startsWith('反例④')) return '反例④ 兜底不覆盖已有记录：答复过的不许被"修复"回 pending'
    if (name.startsWith('正例⑤')) return '正例⑤ ★兜底覆盖**非阻塞**请求：blocking=false 不进等待态，也要能反推'
    if (name.startsWith('正例⑥')) return '正例⑥ ★兜底覆盖**热缓存**路径：不能只在"读盘那一次"生效'
    if (name.startsWith('反例⑦')) return '反例⑦ 判据放宽后既有反例不许回退（已答复不许变 / 主对话不许自行标记已解决）'
    if (name.startsWith('正例⑧')) return '正例⑧ ★写读并发：不出现「交接物可见、登记不可见」的半截状态'
    if (name.startsWith('正例⑨')) return '正例⑨ ★读前对账：盘比内存新 ⇒ 重载（"写进去了、读不到"）'
    if (name.startsWith('反例⑩')) return '反例⑩ 对账不误伤：本进程刚写完的不重载 / 内存比盘新时不回退'
    return '其他'
  }

  const groups = {}
  for (const it of rec.items) {
    const g = groupOf(it.name)
    if (groups[g] === undefined) groups[g] = []
    groups[g].push(it)
  }

  const lines = []
  lines.push('='.repeat(78))
  lines.push('dsh-pipeline 人工介入请求「登记表」自测（现场修复 #5）')
  lines.push('两条数据源：task.handoffs[]（状态里那行读它）vs task.human_requests[]（收件箱读它）')
  lines.push('='.repeat(78))
  for (const [g, items] of Object.entries(groups)) {
    lines.push('')
    lines.push('─'.repeat(78))
    lines.push(`【${g}】${items.filter((i) => i.pass).length}/${items.length} 通过`)
    lines.push('─'.repeat(78))
    for (const it of items) {
      lines.push('')
      lines.push(`${it.pass ? '✓' : '✗'} ${it.name}`)
      for (const l of String(it.detail).split('\n')) lines.push(`    ${l}`)
    }
  }
  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`总计：${rec.passed}/${rec.total} 通过`)
  lines.push('='.repeat(78))

  for (const hh of open) await hh.store.dropCache()
  for (const hh of open) {
    try {
      const { rm } = await import('node:fs/promises')
      await rm(hh.projectRoot, { recursive: true, force: true })
    } catch { /* 清不掉不影响结论 */ }
  }

  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

if (process.argv[1] !== undefined && /human-registry-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runHumanRegistryCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
