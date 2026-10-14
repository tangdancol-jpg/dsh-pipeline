/**
 * dsh-pipeline · **主对话侧的重启自动认领**（D1 第 1 件的最小可跑验证）
 * ============================================================================
 *
 * 跑法：`node tests/main-reattach-check.mjs`（也由 `tests/run-all.mjs` 注册进聚合跑）
 * 期望：最后一行 `主对话自动认领判据：N/N 通过`，退出码 0。
 *
 * ----------------------------------------------------------------------------
 * 这一套要回答的问题是**一个**（其余全是围着它的正例/反例）：
 *     「模拟重启后的空令牌表 ⇒ 主对话**自动**重新绑定成功了吗？」
 * ----------------------------------------------------------------------------
 *
 * 判据（凭什么认定这个会话是某任务的主对话）**只落在一个地方**：
 *     `lib/reattach.js` 的 `judgeMainClaim(task, sessionId)` —— 纯函数、只读。
 * 认定的充要条件：盘上 `.pipeline/<任务>/task.json` 的 `contacts.main.agent_id`
 * 与本次调用方的会话 id **逐字相等**（外加 记录存在 / `role === 'main'` / 非空）。
 *
 * 反例（**必须一条都绑不上**）：
 *   · 记录属于**另一个会话**的会话 ⇒ 不认（这就是"不该绑的会话不得被绑上"）；
 *   · 记录缺 `contacts.main` ⇒ 不认（**不猜**，也不报噪音）；
 *   · 记录在但 `agent_id` 空 / `role` 不是 main ⇒ **认领不了**（要留痕、要报警）。
 *
 * ★ 纪律顺带验掉（它们是这套的机械判据，不靠自述）：
 *   · **不放宽身份校验**：本机制不碰 `tokens.resolve`；重启前的旧令牌重启后
 *     **仍然用不了**（"令牌不可转手"那条判据一个字没动）；
 *   · **不补位 / 不建会话 / 不改状态**：`created_sessions`/`created_seats` 恒 0、
 *     `task.json` 的 `state` / `history.length` / `contacts.main.generation` 一个字节不变；
 *   · 留痕只落**只追加**的 `audit.jsonl`，**不**进 `task.history`
 *     （进了就会把 `lib/patrol.js` 的"最后一次进展时刻"推前 = 机制自己制造进展）。
 *
 * @module dsh-pipeline/tests/main-reattach-check
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CLAIM_REASONS,
  autoReattachMain,
  formatMainReattachReport,
  judgeMainClaim,
  mainRecordOf,
  planMainReattach,
} from '../lib/reattach.js'
import { ROLE } from '../lib/roles.js'
import { registerInterception } from '../lib/intercept.js'
import { callTool, createHarness, disposeHarness } from './selftest-core.mjs'
import { lastMainReattach } from '../index.js'

/** 主对话会话 id（正例）。 */
const MAIN = 'session-main-A'
/** 另一个会话（反例：不该被绑上）。 */
const OTHER = 'session-other-B'
/** main-only 的事件（守门照旧拒非主对话）。 */
const MAIN_ONLY_EVENT = 'requirement_confirmed'

export async function runMainReattachCheck() {
  const lines = []
  const log = (s = '') => lines.push(s)
  let passed = 0
  let total = 0
  /** 断言：`what` 一句话说清判据，`detail` 是可复算的证据。 */
  const add = (what, ok, detail = '') => {
    total += 1
    if (ok === true) passed += 1
    lines.push(`  ${ok === true ? '✓' : '✗'} ${what}`)
    if (String(detail).length > 0) lines.push(`      ${String(detail).split('\n').join('\n      ')}`)
  }
  const open = []

  log('='.repeat(78))
  log('主对话侧的重启自动认领：判据本体 / 空令牌表自动重绑 / 反例 / 认领不了 / 机械判据')
  log('='.repeat(78))

  try {
    // =======================================================================
    // 【一】判据本体 —— 纯函数、只读、四种"不认"各有独立的理由码
    // =======================================================================
    log('')
    log('【一】判据本体（`lib/reattach.js` 的 `judgeMainClaim`：纯函数、只读、不抛）')

    const goodTask = {
      id: 'T-demo-0001',
      state: 'analyzing',
      contacts: { main: { role: ROLE.MAIN, agent_id: MAIN, generation: 3, since: '2026-10-11T00:00:00.000Z', previous_agent: null } },
    }
    const frozen = JSON.stringify(goodTask)

    const v1 = judgeMainClaim(goodTask, MAIN)
    add(
      '① 记录存在 + `role === main` + `agent_id` 非空 + **与本会话逐字相等** ⇒ 认领',
      v1.claim === true && v1.reason === CLAIM_REASONS.CLAIMED,
      `claim=${v1.claim} reason=${v1.reason}　证据=${JSON.stringify(v1.evidence)}`,
    )

    const v2 = judgeMainClaim(goodTask, OTHER)
    add(
      '★★ 反例：**另一个会话**来问同一张单 ⇒ 不认（"逐字相等"是唯一授权步，差一个字符都不行）',
      v2.claim === false && v2.reason === CLAIM_REASONS.OTHER_SESSION,
      `claim=${v2.claim} reason=${v2.reason}`,
    )

    const v3 = judgeMainClaim({ id: 'T-demo-0002', state: 'analyzing' }, MAIN)
    add(
      '★ 反例：盘上**没有** `contacts.main` ⇒ 不认、也不报噪音（**不猜**）',
      v3.claim === false && v3.reason === CLAIM_REASONS.NO_RECORD,
      `claim=${v3.claim} reason=${v3.reason}`,
    )

    const v4 = judgeMainClaim({ id: 'T-demo-0003', contacts: { main: { role: ROLE.MAIN, agent_id: '' } } }, MAIN)
    add(
      '★★ 反例：`contacts.main` 在、但 `agent_id` 是空的（**记录坏了**）⇒ 认领不了（要报出来）',
      v4.claim === false && v4.reason === CLAIM_REASONS.EMPTY_SESSION,
      `claim=${v4.claim} reason=${v4.reason}　${v4.detail.split('\n')[0]}`,
    )

    const v5 = judgeMainClaim({ id: 'T-demo-0004', contacts: { main: { role: ROLE.WRITER, agent_id: MAIN } } }, MAIN)
    add(
      '★★ 反例：`contacts.main.role` 不是 main ⇒ 认领不了（要报出来）',
      v5.claim === false && v5.reason === CLAIM_REASONS.ROLE_NOT_MAIN,
      `claim=${v5.claim} reason=${v5.reason}`,
    )

    const v6 = judgeMainClaim(goodTask, '')
    add(
      '★ 反例：调用方**没有会话 id**（`exec.agent` 为空）⇒ 无从比对 ⇒ 认领不了',
      v6.claim === false && v6.reason === CLAIM_REASONS.NO_CALLER_SESSION,
      `claim=${v6.claim} reason=${v6.reason}`,
    )

    add(
      '★ 判据是**纯函数**：连判两次结论一致，且入参对象**一个字节都没被改**（前后 JSON 相等）',
      judgeMainClaim(goodTask, MAIN).reason === v1.reason && JSON.stringify(goodTask) === frozen,
      `入参哈希前后一致：${JSON.stringify(goodTask) === frozen}；第二次 reason=${judgeMainClaim(goodTask, MAIN).reason}`,
    )

    const plan = planMainReattach({
      tasks: [goodTask, { id: 'T-demo-0002' }, { id: 'T-demo-0005', contacts: { main: { role: ROLE.MAIN, agent_id: '' } } }],
      sessionId: MAIN,
      isBound: () => false,
    })
    add(
      '★ 逐单过一遍的**计划**：认领 1 张 / 认领不了 1 张（坏记录，reportable）/ 跳过 1 张（无记录，不报噪音）',
      plan.claims.length === 1 && plan.refused.length === 1 && plan.skipped.length === 1 && plan.refused[0].reportable === true,
      `claims=${plan.claims.length} refused=${plan.refused.length}(${plan.refused.map((r) => r.reason).join(',')}) skipped=${plan.skipped.length}`,
    )

    add(
      '★ 只读导出真的存在：`index.js` 导出 `lastMainReattach()`（判决可被程序读到，不必翻日志）',
      typeof lastMainReattach === 'function',
      `typeof lastMainReattach = ${typeof lastMainReattach}；本进程当前取值 = ${lastMainReattach() === null ? 'null（还没有工具调用触发过）' : '已有一条报告'}`,
    )

    // =======================================================================
    // 【二】★ 主验证：模拟「重启后」的空令牌表 ⇒ 主对话**自动**重新绑定
    // =======================================================================
    log('')
    log('【二】★★★ 主验证：模拟"重启后"的空令牌表 ⇒ 主对话**自动**重新绑定')

    const h = await createHarness()
    open.push(h)

    const opened = await callTool(h, 'pipeline_task_open', { requirement: 'D1 第 1 件：主对话侧重启后的自动认领。' }, MAIN)
    const taskId = String(opened.value?.task_id ?? '')
    add(
      '夹具：主对话 `session-main-A` 开了一张单（此时它手上有 main 令牌）',
      opened.value?.ok === true && taskId.length > 0 && h.tokens.roleOfAgent(MAIN, taskId)?.role === ROLE.MAIN,
      `task_id=${taskId}　内存令牌=${JSON.stringify(h.tokens.roleOfAgent(MAIN, taskId)?.role ?? null)}`,
    )

    /**
     * ★ 种下**跨进程活着的那一条**记录。
     *
     * 真装配里它由 `lib/tools.js` 的唯一工具出口（`rememberMainCaller` →
     * `store.rememberMainContact`）落盘；这里直接调 store 的同一个入口，
     * 保证夹具与真装配**同源**（不自己另写一份 task.json）。
     */
    const remembered = await h.store.rememberMainContact(taskId, MAIN)
    const persistedMain = h.store.peek(taskId)?.contacts?.main ?? null
    add(
      '★ 种下判据：`task.json` 的 `contacts.main.agent_id` = 主对话会话 id（盘上那份，跨进程活着）',
      remembered.ok === true && persistedMain?.agent_id === MAIN && persistedMain?.role === ROLE.MAIN,
      `contacts.main = ${JSON.stringify(persistedMain)}`,
    )

    const oldToken = h.tokens.tasksOfAgent(MAIN, ROLE.MAIN).length > 0
      ? h.tokens.list().find((t) => t.role === ROLE.MAIN && t.restored !== true)?.token ?? ''
      : ''
    const beforeRestart = JSON.stringify({
      state: h.store.peek(taskId)?.state,
      history: (h.store.peek(taskId)?.history ?? []).length,
      generation: persistedMain?.generation,
    })

    // ---- 模拟 DSH 重启：令牌表是**进程内存态**，重启即全空 -------------------
    h.tokens.clear()
    add(
      '★★ 模拟重启：`tokens.clear()` ⇒ 主对话**认不出来**了（这就是要消灭的那一步）',
      h.tokens.roleOfAgent(MAIN, taskId) === null && h.tokens.size() === 0,
      `清空后 roleOfAgent(${MAIN}, ${taskId}) = ${JSON.stringify(h.tokens.roleOfAgent(MAIN, taskId))}，令牌表大小 = ${h.tokens.size()}`,
    )

    const warnMsgs = []
    const report = await autoReattachMain({
      store: h.store,
      tokens: h.tokens,
      sessionId: MAIN,
      log: () => {},
      warn: (m) => warnMsgs.push(String(m)),
    })
    const afterRole = h.tokens.roleOfAgent(MAIN, taskId)
    add(
      '★★★ **本命**：不做任何手动 `reattach`，主对话**自动**重新绑定成功（会话 ↔ 任务重新对上）',
      report.claims.length === 1 &&
        report.claims[0].task_id === taskId &&
        report.claims[0].restored === true &&
        afterRole?.role === ROLE.MAIN &&
        afterRole?.taskId === taskId,
      `claims=${JSON.stringify(report.claims.map((c) => ({ task_id: c.task_id, role: c.role, restored: c.restored })))}\n` +
        `认领后 roleOfAgent(${MAIN}, ${taskId}) = ${JSON.stringify(afterRole)}\n` +
        `结论码 reason=${report.reason}；` +
        formatMainReattachReport(report).split('\n').join('\n      '),
    )

    add(
      '★ 认领后**身份真的能用**（不只是表里有个字段）：`pipeline_status` 拿得到本单状态、`pipeline_contacts` 读得出主对话是谁',
      (await callTool(h, 'pipeline_status', { task_id: taskId }, MAIN)).value?.ok === true &&
        (await callTool(h, 'pipeline_contacts', { task_id: taskId }, MAIN)).value?.ok === true,
      `pipeline_status.ok=${(await callTool(h, 'pipeline_status', { task_id: taskId }, MAIN)).value?.ok}`,
    )

    const again = await autoReattachMain({ store: h.store, tokens: h.tokens, sessionId: MAIN, warn: () => {} })
    add(
      '★ 幂等：再扫一次 ⇒ 直接走"手上已有令牌"快路径（`swept:false` / 不再认领 / 连盘都不扫）',
      again.swept === false && again.claims.length === 0 && again.reason === CLAIM_REASONS.ALREADY_BOUND,
      `swept=${again.swept} claims=${again.claims.length} reason=${again.reason}`,
    )

    // =======================================================================
    // 【三】★★ 反例：**不该绑的会话不得被绑上**
    // =======================================================================
    log('')
    log('【三】★★ 反例：不该绑的会话不得被绑上（判据收紧，不是放宽）')

    h.tokens.clear()
    const otherWarn = []
    const rOther = await autoReattachMain({
      store: h.store,
      tokens: h.tokens,
      sessionId: OTHER,
      warn: (m) => otherWarn.push(String(m)),
    })
    add(
      '★★★ 反例（本命）：**另一个会话**在同一个空令牌表下扫盘 ⇒ 一张都没认到、`roleOfAgent` 仍是 null',
      rOther.claims.length === 0 && h.tokens.roleOfAgent(OTHER, taskId) === null && h.tokens.size() === 0,
      `claims=${rOther.claims.length}　roleOfAgent(${OTHER}, ${taskId}) = ${JSON.stringify(h.tokens.roleOfAgent(OTHER, taskId))}　令牌表大小=${h.tokens.size()}`,
    )
    add(
      '★ 反例的**理由码**是"属于另一个会话"（而不是"认领失败"）—— 这一格**不报噪音**（也不泄露别人的会话 id）',
      rOther.refused.length === 0 && rOther.reason === CLAIM_REASONS.NO_RECORD,
      `refused=${rOther.refused.length} reason=${rOther.reason}　warn 条数=${otherWarn.length}`,
    )

    const rOther2 = await autoReattachMain({
      store: h.store,
      tokens: h.tokens,
      sessionId: OTHER,
      warn: () => {},
    })
    add(
      '★ 另一个会话**走真工具**照样被守门拒（`requirement_confirmed` 是 main-only）—— 认领机制没有替它开门',
      (await callTool(h, 'pipeline_transition', { task_id: taskId, event: MAIN_ONLY_EVENT }, OTHER)).denied === true,
      `拒绝层=${(await callTool(h, 'pipeline_transition', { task_id: taskId, event: MAIN_ONLY_EVENT }, OTHER)).layer}`,
    )

    add(
      '★★ 不放宽任何令牌校验：**重启前那枚旧令牌**重启后仍然用不了（"重启丢失"与"TTL 过期"照旧分得开）',
      oldToken.length > 0 ? h.tokens.resolve(oldToken).ok === false : true,
      `旧令牌=${oldToken.slice(0, 8)}…　resolve=${oldToken.length > 0 ? JSON.stringify(h.tokens.resolve(oldToken).ok) : '(夹具没取到，跳过这一格的强度)'}`,
    )

    // =======================================================================
    // 【四】★ 认领不了 ⇒ **必须报出来**（不许静默、不许用近似物冒名）
    // =======================================================================
    log('')
    log('【四】★★ 认领不了就报"认领不了"（留痕 + 报警；不补位、不冒名）')

    const h2 = await createHarness()
    open.push(h2)
    const opened2 = await callTool(h2, 'pipeline_task_open', { requirement: 'D1：坏记录那一格。' }, MAIN)
    const taskId2 = String(opened2.value?.task_id ?? '')
    await h2.store.rememberMainContact(taskId2, MAIN)
    /** ★ 直接改**盘上**的 `task.json`（真实现场里记录就是被写坏的）—— 读前对账会把它读进来。 */
    const file2 = join(h2.projectRoot, h2.config.artifactDirName, taskId2, 'task.json')
    const raw2 = JSON.parse(readFileSync(file2, 'utf8'))
    raw2.contacts.main.agent_id = ''
    raw2.contacts.main.why = '(夹具：把记录写坏)'
    writeFileSync(file2, `${JSON.stringify(raw2, null, 2)}\n`, 'utf8')

    h2.tokens.clear()
    const warned = []
    const rBad = await autoReattachMain({
      store: h2.store,
      tokens: h2.tokens,
      sessionId: MAIN,
      log: () => {},
      warn: (m) => warned.push(String(m)),
    })
    add(
      '★★ 依据坏了（`contacts.main.agent_id` 空）⇒ **认领不了**：报告里进 `refused`、给出理由码与原文证据',
      rBad.claims.length === 0 &&
        rBad.refused.length === 1 &&
        rBad.refused[0].reason === CLAIM_REASONS.EMPTY_SESSION &&
        rBad.refused[0].evidence?.recorded_agent_id === '',
      `refused=${JSON.stringify(rBad.refused.map((r) => ({ task_id: r.evidence?.task_id, reason: r.reason, reportable: r.reportable })))}`,
    )
    add(
      '★★ 认领不了**是看得见的**（不是静默跳过）：`warn` 喊出"认领不了"并指路手动通道',
      warned.length >= 1 && warned.some((m) => m.includes('认领不了') && m.includes('reattach')),
      `warn 条数=${warned.length}　首条=${String(warned[0] ?? '').split('\n')[0]}`,
    )

    const auditLines = readFileSync(join(h2.projectRoot, h2.config.artifactDirName, taskId2, 'audit.jsonl'), 'utf8')
      .split('\n')
      .filter((x) => x.trim().length > 0)
      .map((x) => JSON.parse(x))
    add(
      '★ 认领不了也**留痕**（`main:reattach-refused` 一行，只追加的 `audit.jsonl`）',
      auditLines.some((e) => e.action === 'main:reattach-refused' && e.reason === CLAIM_REASONS.EMPTY_SESSION),
      auditLines.filter((e) => String(e.action).startsWith('main:reattach')).map((e) => `${e.action}:${e.reason ?? '(成功)'}`).join('、') || '(无)',
    )
    add(
      '★ 依据坏了**不许"用近似物冒名"**：没有把别的东西绑上去（令牌表仍是空的、`roleOfAgent` 仍是 null）',
      h2.tokens.size() === 0 && h2.tokens.roleOfAgent(MAIN, taskId2) === null,
      `令牌表大小=${h2.tokens.size()}　roleOfAgent=${JSON.stringify(h2.tokens.roleOfAgent(MAIN, taskId2))}`,
    )

    // ---- restore 不可用那一格（宿主热替换半途 / 旧版 tokens）------------------
    /**
     * ★ 这一格必须打在**记录是好的**那张单上（`h` 的 `taskId`）：否则走的是
     *   "记录坏了"那一支，测不到"有认领意图、但令牌表没有 `restore()`"这一格。
     */
    const fakeTokens = {
      tasksOfAgent: () => [],
      roleOfAgent: () => null,
      // 刻意**没有** restore
    }
    const warned2 = []
    const rNoRestore = await autoReattachMain({
      store: h.store,
      tokens: fakeTokens,
      sessionId: MAIN,
      log: () => {},
      warn: (m) => warned2.push(String(m)),
    })
    add(
      '★ 反例：令牌表**没有 `restore()`**（热替换半途）⇒ 认领不了 + 报警 + 留痕（不静默、不假装认上了）',
      rNoRestore.claims.length === 0 &&
        rNoRestore.refused.some((r) => r.reason === CLAIM_REASONS.RESTORE_UNAVAILABLE) &&
        warned2.some((m) => m.includes('认领不了')),
      `claims=${rNoRestore.claims.length} refused=${rNoRestore.refused.map((r) => r.reason).join(',')} warn=${warned2.length}`,
    )

    // =======================================================================
    // 【五】★ 不补位 / 不建会话 / 不改状态 —— 机械判据，不靠自述
    // =======================================================================
    log('')
    log('【五】★ 不补位、不建会话、不改状态（机械判据）')

    add(
      '★ 报告自带的机械判据：新建会话 0 / 新建席位 0 / 没碰 `task.json`',
      report.created_sessions === 0 && report.created_seats === 0 && report.touched_task_json === false,
      `created_sessions=${report.created_sessions} created_seats=${report.created_seats} touched_task_json=${report.touched_task_json}`,
    )

    const afterRestart = JSON.stringify({
      state: h.store.peek(taskId)?.state,
      history: (h.store.peek(taskId)?.history ?? []).length,
      generation: h.store.peek(taskId)?.contacts?.main?.generation,
    })
    add(
      '★★ 认领**没有改状态**：`state` / `history.length` / `contacts.main.generation` 与认领前逐字相同',
      afterRestart === beforeRestart,
      `认领前=${beforeRestart}\n认领后=${afterRestart}`,
    )

    const auditLines1 = readFileSync(join(h.projectRoot, h.config.artifactDirName, taskId, 'audit.jsonl'), 'utf8')
      .split('\n')
      .filter((x) => x.trim().length > 0)
      .map((x) => JSON.parse(x))
    add(
      '★★ 留痕落在**只追加**的 `audit.jsonl`（`main:reattach-auto`），**没有**进 `task.history` —— 否则会推前巡检的"最后一次进展时刻" = 机制自己制造进展',
      auditLines1.some((e) => e.action === 'main:reattach-auto' && e.created_session === false && e.created_seat === false) &&
        (h.store.peek(taskId)?.history ?? []).every((x) => x.action !== 'main:reattach-auto'),
      `audit.jsonl 里的认领行=${auditLines1.filter((e) => e.action === 'main:reattach-auto').length}；history 里的=${(h.store.peek(taskId)?.history ?? []).filter((x) => x.action === 'main:reattach-auto').length}`,
    )

    /**
     * ★【三】把令牌表又清空过一次（反例那一轮）—— 这里**再重启一次**并重新认领，
     *   顺手把"重启 ⇒ 自动认领"这条链在**同一张单上跑第二遍**（跨轮次仍成立）。
     */
    h.tokens.clear()
    const second = await autoReattachMain({ store: h.store, tokens: h.tokens, sessionId: MAIN, warn: () => {} })
    const mainTokens = h.tokens.list().filter((t) => t.role === ROLE.MAIN)
    add(
      '★ 第二次重启后再认领：**只**让这一枚 main 令牌回来（没有凭空多出席位 / 别的角色 / 别的单）',
      second.claims.length === 1 &&
        mainTokens.length === 1 &&
        h.tokens.list().every((t) => t.taskId === taskId),
      `claims=${second.claims.length}　令牌表 = ${JSON.stringify(h.tokens.list().map((t) => ({ role: t.role, taskId: t.taskId, restored: t.restored === true })))}`,
    )

    add(
      '★ `mainRecordOf()` 是**只读**取记录的口子（认领判据的证据字段由它给，不散在别处）',
      mainRecordOf(h.store.peek(taskId)).agentId === MAIN,
      `mainRecordOf → agentId=${mainRecordOf(h.store.peek(taskId)).agentId} role=${mainRecordOf(h.store.peek(taskId)).role}`,
    )

    add(
      '★ 负缓存只对"一张都没认到、也没有认领不了"的会话生效 —— 依据坏掉的单**每次都还会再报一遍**',
      rBad.swept === true,
      `坏记录那一轮 swept=${rBad.swept}（true = 真的扫了盘并报了，不是被缓存吃掉）`,
    )

    // =======================================================================
    // 【六】★ **接线**：认领真的挂在既有那条 `tools/pre-execute` 缝上了吗
    // =======================================================================
    //
    //   为什么这一段不能省：上面【二】验的是**判据本体**（`autoReattachMain`），
    //   而"它到底有没有被宿主的那条缝调到"是**另一件事** ——
    //   机制挂不上、而判据自己全绿，正是本项目反复踩过的"假绿"形状。
    //   所以这里用**真的** `registerInterception()` 造一条缝，按宿主的调用形状
    //   （`(exec, next)`）走一遍。
    //
    //   ★ 另外两条纪律也在这里被**机械**验掉：
    //     · 认领发生在**席位作用域判定之前**（重启后的主对话不在令牌表里，
    //       `seatOf` 会给 `null` —— 放在判定之后就永远轮不到它）；
    //     · 它**不改变**这条缝的决议（非席位照样 `next()` 直通；守门说拒就还是拒）。
    log('')
    log('【六】★ 接线：认领挂在**既有** `tools/pre-execute` 缝上（且在作用域判定之前）')

    const handlers = new Map()
    const fakeCtx = {
      on: (ev, fn) => {
        if (!handlers.has(ev)) handlers.set(ev, [])
        handlers.get(ev).push(fn)
        return () => {}
      },
      logger: { info() {}, warn() {}, debug() {} },
    }
    const seenSessions = []
    const seams = registerInterception(fakeCtx, {
      tokens: h.tokens,
      guard: () => undefined,
      warn: () => {},
      getTask: () => null,
      mainReattach: async (sid) => {
        seenSessions.push(sid)
        return { at: new Date().toISOString(), session_id: sid, claims: [], refused: [], skipped: 0 }
      },
    })
    const preExecute = (handlers.get('tools/pre-execute') ?? [])[0]
    add(
      '★ 缝挂上了、且 `tools/pre-execute` **仍然只有 1 条中间件**（认领**搭**在既有那条里，没有新挂第二条）',
      seams.seams.includes('tools/pre-execute') && (handlers.get('tools/pre-execute') ?? []).length === 1,
      `已挂事件=${seams.seams.join(' / ')}；pre-execute 条数=${(handlers.get('tools/pre-execute') ?? []).length}`,
    )

    const passedThrough = await preExecute({ name: 'read', arguments: {}, agent: { id: MAIN } }, async () => ({ kind: 'enter' }))
    add(
      '★★ 认领在**席位作用域判定之前**被调用（重启后的主对话不是"席位"，放在判定之后就永远轮不到它）',
      seenSessions.includes(MAIN),
      `被调用到的会话=${JSON.stringify(seenSessions)}；返回=${JSON.stringify(passedThrough)}`,
    )
    add(
      '★★ 认领**不改变**这条缝的决议：非管线会话照样直通（`{kind:enter}` 原样返回）',
      passedThrough?.kind === 'enter',
      `返回=${JSON.stringify(passedThrough)}`,
    )

    // ---- 真接线：把**真的**认领函数接上去，走一次"重启后"的完整路径 ----------
    const handlers2 = new Map()
    const fakeCtx2 = {
      on: (ev, fn) => {
        if (!handlers2.has(ev)) handlers2.set(ev, [])
        handlers2.get(ev).push(fn)
        return () => {}
      },
      logger: { info() {}, warn() {}, debug() {} },
    }
    registerInterception(fakeCtx2, {
      tokens: h.tokens,
      guard: () => undefined,
      warn: () => {},
      getTask: () => null,
      mainReattach: (sid) => autoReattachMain({ store: h.store, tokens: h.tokens, sessionId: sid, warn: () => {} }),
    })
    const preExecute2 = (handlers2.get('tools/pre-execute') ?? [])[0]
    h.tokens.clear()
    add(
      '★ 真接线夹具：令牌表又清空一次（模拟第二次重启）',
      h.tokens.roleOfAgent(MAIN, taskId) === null,
      `roleOfAgent(${MAIN}, ${taskId}) = ${JSON.stringify(h.tokens.roleOfAgent(MAIN, taskId))}`,
    )
    await preExecute2({ name: 'pipeline_status', arguments: {}, agent: { id: MAIN } }, async () => ({ kind: 'enter' }))
    add(
      '★★★ **端到端本命**：主对话**调一次工具** ⇒ 身份在守门之前就自动回来了（无需手动 `reattach`）',
      h.tokens.roleOfAgent(MAIN, taskId)?.role === ROLE.MAIN,
      `调用后 roleOfAgent(${MAIN}, ${taskId}) = ${JSON.stringify(h.tokens.roleOfAgent(MAIN, taskId))}`,
    )

    // ---- 守门照旧：认领没有把"拒"吞掉 --------------------------------------
    const handlers3 = new Map()
    const fakeCtx3 = {
      on: (ev, fn) => {
        if (!handlers3.has(ev)) handlers3.set(ev, [])
        handlers3.get(ev).push(fn)
        return () => {}
      },
      logger: { info() {}, warn() {}, debug() {} },
    }
    registerInterception(fakeCtx3, {
      tokens: h.tokens,
      guard: () => '【拒绝原文·夹具】没有身份，不许动。',
      warn: () => {},
      getTask: () => null,
      mainReattach: async () => ({ claims: [], refused: [] }),
    })
    const preExecute3 = (handlers3.get('tools/pre-execute') ?? [])[0]
    const denied = await preExecute3({ name: 'read', arguments: {}, agent: { id: MAIN } }, async () => ({ kind: 'enter' }))
    add(
      '★★ 认领**没有**把守门的"拒"吞掉：守门返回理由 ⇒ 这条缝照旧 `{kind:deny, reason}`',
      denied?.kind === 'deny' && String(denied.reason).includes('【拒绝原文·夹具】'),
      `返回=${JSON.stringify(denied)}`,
    )

    // ---- 认领自己抛异常也不许把这次调用带崩 --------------------------------
    const handlers4 = new Map()
    const fakeCtx4 = {
      on: (ev, fn) => {
        if (!handlers4.has(ev)) handlers4.set(ev, [])
        handlers4.get(ev).push(fn)
        return () => {}
      },
      logger: { info() {}, warn() {}, debug() {} },
    }
    registerInterception(fakeCtx4, {
      tokens: h.tokens,
      guard: () => undefined,
      warn: () => {},
      getTask: () => null,
      mainReattach: async () => {
        throw new Error('夹具：认领炸了')
      },
    })
    const preExecute4 = (handlers4.get('tools/pre-execute') ?? [])[0]
    let threw = null
    let out4 = null
    try {
      out4 = await preExecute4({ name: 'read', arguments: {}, agent: { id: 'unrelated' } }, async () => ({ kind: 'enter' }))
    } catch (err) {
      threw = String(err?.message ?? err)
    }
    add(
      '★ 认领**抛异常也不带崩**这次调用（吞掉 + 留痕；决议不受影响）',
      threw === null && out4?.kind === 'enter',
      `threw=${threw ?? 'null'} 返回=${JSON.stringify(out4)}`,
    )
  } catch (err) {
    add(`本套自测自身抛异常（这是测试台的问题，不是判据的结论）：${String(err?.message ?? err)}`, false, String(err?.stack ?? ''))
  } finally {
    for (const h of open) {
      try {
        await disposeHarness(h)
      } catch {
        void 0
      }
    }
  }

  log('')
  log('─'.repeat(78))
  log(`主对话自动认领判据：${passed}/${total} 通过${passed === total ? '' : '  ← 有失败'}`)
  log('─'.repeat(78))
  return { passed, total, text: lines.join('\n') }
}

/** 单跑本文件（由总入口调用时不走这里）。 */
if (process.argv[1] !== undefined && process.argv[1].endsWith('main-reattach-check.mjs')) {
  const r = await runMainReattachCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
