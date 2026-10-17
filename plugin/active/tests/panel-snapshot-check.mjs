// 面板快照 / 契约自测：任务行字段与键序、tier、席位合并、排序与置顶、坏文件降级、GET 路由（含 ?view=archived）。
/**
 * dsh-pipeline · 自建流水线面板 · **快照 / 契约**自测
 * ============================================================================
 *     node tests/panel-snapshot-check.mjs
 *
 * 钉住「面板能显示什么」的判据（拆分前的 A–I / P 组 + 归档视图分流）：
 *   A. 契约字段齐全（任务行 11 键逐字对齐：`tier` 插在 `pinned` 之前、`allowed_actions` 垫底）；
 *      席位行 9 个字段一个不少；`tier` 只认 `L0`–`L5`；
 *   B. 中文名来自**唯一出处**（`STATE_LABEL` / `roleLabel`），认不出原样返回、绝不抛；
 *   C. 需求摘要：压缩空白 → 截 80 个码点 → 超出加 `…`，且**绝不含交接物正文**；
 *   D. 坏 JSON / 读不出来 ⇒ **跳过 + 记 warnings**，不许把整张面板打成 500；
 *   E. 席位「声明 vs 已派出」的合并 + `session_id` 缺省时从 `agent_id` 剥前缀兜底；
 *   F. `human_pending` 只数**还没答复**的（`relayed` 仍然算）；G. 排序 + `team_board`；
 *   H. 路由：`GET /panel` 只读带 `no-store`、`?view=archived` 走归档视图、`/state` 一个字没变；
 *   I. 只读硬约束：跑完之后夹具的 `task.json` 逐字节未改；
 *   P. 快照的 `pinned` 与「置顶优先、其余按 `updated_at` 倒序」的排序。
 *
 * ★ 动作 / 执行器 / 归档 / 路由 POST 那半边在 `tests/panel-actions-check.mjs`；
 *   共享夹具在 `tests/panel-fixtures.mjs`（**不是测试**，刻意不登记）。
 *   拆文件的理由：`CONVENTIONS.md`「单个测试文件 ≤ 400 行」。
 * ★ 全程密闭：夹具自造临时目录，**不读任何活体真单**；跑完整个删掉。
 *
 * @module dsh-pipeline/tests/panel-snapshot-check
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  PANEL_SNIPPET_MAX,
  PANEL_TASK_KEY_ORDER,
  SEAT_STATUS,
  buildPanelSnapshot,
  declaredSeatsOf,
  humanPendingCount,
  seatsOf,
  sessionIdOfAgentId,
  snippetOf,
  stateLabelOf,
  taskTierOf,
} from '../lib/panel/snapshot.js'
import { PINS_FILE_NAME, setPinned } from '../lib/panel/pins.js'
import { listArchived } from '../lib/panel/archive.js'
import { PANEL_ARCHIVED_VIEW, PANEL_PATH, STATE_PATH, createSwitchHandler } from '../lib/switch-routes.js'
import { roleLabel } from '../lib/roles.js'
import { pathKey } from '../lib/util.js'
import {
  ARCH_DIR_KEEP,
  BAD,
  CJK,
  HANDOFF_SECRET,
  NEWER,
  NEWER_REQUIREMENT,
  NOFILE,
  OLDER,
  createRecorder,
  fakeReq,
  fakeRes,
  fakeSwitch,
  makeArchiveFixture,
  makeFixture,
  makeTempRoots,
  newerTask,
  renderReport,
  runDirect,
} from './panel-fixtures.mjs'

export async function runPanelSnapshotCheck() {
  const rec = createRecorder()
  const roots = makeTempRoots('snapshot')
  const G_A = 'A · 契约与形状'
  const G_B = 'B · 中文名（唯一出处）'
  const G_C = 'C · 需求摘要（压缩 + 80 码点）'
  const G_D = 'D · 坏输入只进 warnings'
  const G_E = 'E · 席位（声明 vs 已派出）'
  const G_F = 'F · 人工待办计数'
  const G_G = 'G · 排序'
  const G_H = 'H · 只读路由'
  const G_I = 'I · 只读硬约束'
  const G_P = 'P · 快照的 pinned 与置顶排序'
  const G_QV = 'Q · 归档视图路由（?view=archived 分流）'

  try {
    const pipelineDir = makeFixture(roots.root)
    let snap = null
    let threw = null
    try {
      snap = buildPanelSnapshot({ projectRoot: roots.root, now: Date.parse('2026-10-18T03:00:00Z') })
    } catch (err) {
      threw = String(err?.message ?? err)
    }

    // === A 契约 ============================================================
    rec.add(G_A, '`buildPanelSnapshot` 不抛异常', threw === null, threw === null ? '' : `抛了：${threw}`)
    rec.add(G_A, '`ok === true`（有坏单也照样出快照）', snap?.ok === true, `ok=${String(snap?.ok)}`)
    rec.add(G_A, '`generated_at` 是注入时刻的 ISO 串', snap?.generated_at === '2026-10-18T03:00:00Z', `generated_at=${String(snap?.generated_at)}`)
    rec.add(G_A, '`project_root` 与插件其它地方**同一套归一化**（`pathKey`）', snap?.project_root === pathKey(roots.root), `project_root=${String(snap?.project_root)} 期望=${pathKey(roots.root)}`)
    rec.add(G_A, '只认 `T-` 前缀的目录（`_memory` / 非目录都不算）', snap?.tasks?.length === 2, `tasks=${JSON.stringify((snap?.tasks ?? []).map((t) => t.id))}`)
    rec.add(G_A, '`warnings` 是字符串数组', Array.isArray(snap?.warnings) && snap.warnings.every((w) => typeof w === 'string'), JSON.stringify(snap?.warnings))

    const task = (snap?.tasks ?? []).find((t) => t.id === NEWER) ?? null
    const TASK_KEYS = ['id', 'state', 'state_label', 'requirement_snippet', 'updated_at', 'human_pending', 'team_board', 'seats', 'tier', 'pinned', 'allowed_actions']
    rec.add(G_A, '任务行字段与契约**逐个**对齐（11 个，`tier` 插在 `pinned` 之前）', task !== null && JSON.stringify(Object.keys(task)) === JSON.stringify(PANEL_TASK_KEY_ORDER) && JSON.stringify(PANEL_TASK_KEY_ORDER) === JSON.stringify(TASK_KEYS), `实际键=${JSON.stringify(Object.keys(task ?? {}))}`)
    rec.add(G_A, '`allowed_actions` 仍是任务行**最后一个键**，原 8 个键的位置一个没动', task !== null && Object.keys(task).at(-1) === 'allowed_actions' && Object.keys(task).slice(0, 8).join(',') === 'id,state,state_label,requirement_snippet,updated_at,human_pending,team_board,seats' && Object.keys(task)[8] === 'tier' && Object.keys(task)[9] === 'pinned', `键序=${JSON.stringify(Object.keys(task ?? {}))}`)
    rec.add(G_A, '`tier` 接进任务行：主夹具 `roster.tier:"L3"` ⇒ `tier:"L3"`', task?.tier === 'L3', `tier=${String(task?.tier)}`)
    rec.add(G_A, '`taskTierOf`：`roster.tier:"L5"` ⇒ `"L5"`；`"l2"` ⇒ `"L2"`（大小写不敏感，输出统一大写）', taskTierOf({ roster: { tier: 'L5' } }) === 'L5' && taskTierOf({ roster: { tier: 'l2' } }) === 'L2', JSON.stringify([taskTierOf({ roster: { tier: 'L5' } }), taskTierOf({ roster: { tier: 'l2' } })]))
    rec.add(G_A, '`taskTierOf`：没有 tier ⇒ `null`（无 task / 空 roster / 空白都不抛）', taskTierOf(undefined) === null && taskTierOf({}) === null && taskTierOf({ roster: {} }) === null && taskTierOf({ roster: { tier: '   ' } }) === null, JSON.stringify([taskTierOf(undefined), taskTierOf({}), taskTierOf({ roster: { tier: '   ' } })]))
    rec.add(G_A, '`taskTierOf`：认不出（`X9` / `L6` / 非字符串）⇒ `null`，**绝不**从需求文本里猜', taskTierOf({ roster: { tier: 'X9' }, requirement: '这是 L3 的单' }) === null && taskTierOf({ roster: { tier: 'L6' } }) === null && taskTierOf({ roster: { tier: 3 } }) === null, JSON.stringify([taskTierOf({ roster: { tier: 'X9' } }), taskTierOf({ roster: { tier: 'L6' } }), taskTierOf({ roster: { tier: 3 } })]))
    rec.add(G_A, '`taskTierOf` 取值顺序：缺 `roster.tier` ⇒ 退回 `task.tier`；`roster.tier` 写了却认不出 ⇒ `null`（不拿旧字段悄悄顶上）', taskTierOf({ tier: 'L4' }) === 'L4' && taskTierOf({ roster: { tier: null }, tier: 'l0' }) === 'L0' && taskTierOf({ roster: { tier: 'X9' }, tier: 'L4' }) === null, JSON.stringify([taskTierOf({ tier: 'L4' }), taskTierOf({ roster: { tier: null }, tier: 'l0' }), taskTierOf({ roster: { tier: 'X9' }, tier: 'L4' })]))
    const SEAT_KEYS = ['kind', 'layer', 'member_name', 'parent_session_id', 'role', 'role_label', 'seat', 'session_id', 'status']
    const seatKeysOk = (task?.seats ?? []).every((s) => JSON.stringify(Object.keys(s).sort()) === JSON.stringify(SEAT_KEYS))
    rec.add(G_A, '席位行字段与契约**逐个**对齐（9 个）', seatKeysOk && (task?.seats ?? []).length > 0, `首个席位=${JSON.stringify(task?.seats?.[0] ?? null)}`)
    rec.add(G_A, '★ 输出里**不含交接物正文**（夹具里种了标记串）', !JSON.stringify(snap).includes(HANDOFF_SECRET), JSON.stringify(snap).includes(HANDOFF_SECRET) ? '标记串出现在快照里了' : '')
    rec.add(G_A, '席位状态取值与契约逐字一致（current / dispatched / declared）', SEAT_STATUS.CURRENT === 'current' && SEAT_STATUS.DISPATCHED === 'dispatched' && SEAT_STATUS.DECLARED === 'declared', JSON.stringify(SEAT_STATUS))

    // === B 中文名 ==========================================================
    rec.add(G_B, '`state_label` 是中文（reviewing ⇒ 审核中）', task?.state_label === '审核中' && CJK.test(String(task?.state_label)), `state_label=${String(task?.state_label)}`)
    rec.add(G_B, '认不出的状态原样返回 id（不抛、不吞）', stateLabelOf('没人定义过的状态') === '没人定义过的状态' && stateLabelOf('') === '', `fallback=${JSON.stringify(stateLabelOf('没人定义过的状态'))}`)
    const mainSeat = (task?.seats ?? [])[0] ?? null
    rec.add(G_B, '`role_label` 来自 `roles.js`（main ⇒ 主对话）', mainSeat?.role_label === roleLabel('main') && mainSeat?.role_label === '主对话', `role_label=${String(mainSeat?.role_label)}`)
    rec.add(G_B, '每个席位的 `role_label` 都非空且与 `roleLabel()` 同源', (task?.seats ?? []).every((s) => s.role_label === roleLabel(s.role) && s.role_label.length > 0), JSON.stringify((task?.seats ?? []).map((s) => `${s.role}:${s.role_label}`)))

    // === C 摘要 ============================================================
    const collapsed = NEWER_REQUIREMENT.replace(/\s+/g, ' ').trim()
    const expectedSnippet = `${Array.from(collapsed).slice(0, PANEL_SNIPPET_MAX).join('')}…`
    rec.add(G_C, '空白压缩成单个空格（无换行、无双空格）', typeof task?.requirement_snippet === 'string' && !/[\n\r]/.test(task.requirement_snippet) && !task.requirement_snippet.includes('  '), JSON.stringify(task?.requirement_snippet))
    rec.add(G_C, `截到 ${PANEL_SNIPPET_MAX} 个码点 + \`…\`（共 81）`, task?.requirement_snippet === expectedSnippet && Array.from(task?.requirement_snippet ?? '').length === PANEL_SNIPPET_MAX + 1, `len=${Array.from(task?.requirement_snippet ?? '').length}`)
    rec.add(G_C, '短需求不截断、不加 `…`', snippetOf('一句话需求。') === '一句话需求。' && !snippetOf('一句话需求。').includes('…'), JSON.stringify(snippetOf('一句话需求。')))
    rec.add(G_C, '正好 80 码点不截断', snippetOf('甲'.repeat(PANEL_SNIPPET_MAX)) === '甲'.repeat(PANEL_SNIPPET_MAX), '')
    rec.add(G_C, '空需求 ⇒ 空串（不写「null」这种噪声）', snippetOf(undefined) === '' && snippetOf(null) === '' && snippetOf('   ') === '', '')

    // === D 坏输入 ==========================================================
    rec.add(G_D, '坏 JSON 与缺 task.json 各记一条 warning（共 2 条）', (snap?.warnings ?? []).length === 2, JSON.stringify(snap?.warnings))
    rec.add(G_D, 'warning 点名了是哪个任务，人一眼能定位', (snap?.warnings ?? []).some((w) => w.includes(`${BAD}：task.json 不是合法 JSON`)) && (snap?.warnings ?? []).some((w) => w.includes(`${NOFILE}：task.json 读不出来`)), JSON.stringify(snap?.warnings))
    rec.add(G_D, '坏单**不出现**在任务列表里', (snap?.tasks ?? []).every((t) => t.id !== BAD && t.id !== NOFILE), JSON.stringify((snap?.tasks ?? []).map((t) => t.id)))
    const emptyRoot = roots.newRoot('empty')
    const empty = buildPanelSnapshot({ projectRoot: emptyRoot })
    rec.add(G_D, '空目录 ⇒ `ok:true` + 空任务表（新 profile 不算错）', empty.ok === true && empty.tasks.length === 0 && empty.warnings.length === 0, JSON.stringify(empty))
    const noRoot = buildPanelSnapshot({})
    rec.add(G_D, '没有 `projectRoot` ⇒ `ok:false` + 中文 error（照样不抛）', noRoot.ok === false && CJK.test(String(noRoot.error)) && noRoot.tasks.length === 0, `error=${String(noRoot.error)}`)

    // === E 席位 ============================================================
    const pick = (role, seat = null) => (task?.seats ?? []).find((s) => s.role === role && s.seat === seat) ?? null
    rec.add(G_E, '① main 恒一条：`status:"current"` / `kind:"session"` / `seat:null`', (snap?.tasks ?? []).every((t) => t.seats[0]?.role === 'main' && t.seats[0]?.status === 'current' && t.seats[0]?.kind === 'session' && t.seats[0]?.seat === null && t.seats[0]?.session_id === null), JSON.stringify(mainSeat))
    rec.add(G_E, '② 只声明、没派活 ⇒ `status:"declared"` + `kind:"unknown"` + 无会话 id', pick('reviewer')?.status === 'declared' && pick('reviewer')?.kind === 'unknown' && pick('reviewer')?.session_id === null, JSON.stringify(pick('reviewer')))
    rec.add(G_E, '② writer 按分区展开成两席（writer#1 / writer#2，各带层）', pick('writer', 'writer#1')?.layer === 'interface' && pick('writer', 'writer#2')?.layer === 'data' && pick('writer', 'writer#1')?.status === 'declared', `${JSON.stringify(pick('writer', 'writer#1'))} / ${JSON.stringify(pick('writer', 'writer#2'))}`)
    rec.add(G_E, '③ 声明过 + 真派出去过 ⇒ **升级**成 `dispatched` 并填会话 id', pick('tester')?.status === 'dispatched' && pick('tester')?.kind === 'session' && pick('tester')?.session_id === 'session-tester', JSON.stringify(pick('tester')))
    rec.add(G_E, '③ team 通道 ⇒ `kind:"team"`，`member_name` 取记录里的 `memberName`', pick('writer', 'writer#2')?.status === 'dispatched' && pick('writer', 'writer#2')?.kind === 'team' && pick('writer', 'writer#2')?.member_name === '编写员乙' && pick('writer', 'writer#2')?.session_id === 'member-2', JSON.stringify(pick('writer', 'writer#2')))
    rec.add(G_E, '③ `via:"manual"`（只出可粘贴派活单）⇒ `kind:"unknown"`（没建会话，不冒充 session）', pick('docs')?.status === 'dispatched' && pick('docs')?.kind === 'unknown' && pick('docs')?.session_id === null, JSON.stringify(pick('docs')))
    rec.add(G_E, '③ 名单里没声明的已派席位（需求位）也出现，追加在后面', pick('orchestrator')?.status === 'dispatched' && (task?.seats ?? []).at(-1)?.role === 'orchestrator', JSON.stringify((task?.seats ?? []).map((s) => `${s.role}${s.seat === null ? '' : `@${s.seat}`}`)))
    rec.add(G_E, '同 (role, seat) 不出现两行（合并，不是叠加）', new Set((task?.seats ?? []).map((s) => `${s.role}@${s.seat ?? ''}`)).size === (task?.seats ?? []).length, `seats=${(task?.seats ?? []).length}`)
    rec.add(G_E, '没有 `memberName` 的记录 ⇒ `member_name: null`（不拿 agent_id 冒充名字）', pick('tester')?.member_name === null && pick('orchestrator')?.member_name === null, '')
    const decl = declaredSeatsOf({ execution_roles: ['writer', 'tester'], writers: { partitions: [{ seat: 'writer#1', role_id: 'writer', layer: 'interface' }, { seat: 'writer#2', role_id: 'writer', layer: 'data' }, { seat: 'writer#1', role_id: 'writer', layer: 'interface' }] } })
    rec.add(G_E, '`declaredSeatsOf`：writer 展开 + 重复分区去重 + 其它角色一位', JSON.stringify(decl) === JSON.stringify([
      { role: 'writer', seat: 'writer#1', layer: 'interface' },
      { role: 'writer', seat: 'writer#2', layer: 'data' },
      { role: 'tester', seat: null, layer: null },
    ]), JSON.stringify(decl))
    rec.add(G_E, '`seatsOf` 对空任务也安全（只剩 main）', seatsOf(undefined)?.length === 1 && seatsOf({ roster: null })?.length === 1, '')
    const fallbackSeats = seatsOf({
      dispatched: [
        { role: 'tester', seat: null, agent_id: 'session-abc-123', session_id: null, via: 'subagent' },
        { role: 'reviewer', seat: null, agent_id: 'session-ffff', session_id: 'xyz', via: 'subagent' },
        { role: 'docs', seat: null, agent_id: 'member-9', session_id: null, via: 'team' },
      ],
    })
    const fbPick = (role) => fallbackSeats.find((s) => s.role === role) ?? null
    rec.add(G_E, '③ `session_id:null` + `agent_id:"session-<id>"` ⇒ 席位 `session_id` 剥前缀兜底', fbPick('tester')?.session_id === 'abc-123', JSON.stringify(fbPick('tester')))
    rec.add(G_E, '③ 显式 `session_id` **优先**于 `agent_id`（兜底不覆盖事实）', fbPick('reviewer')?.session_id === 'xyz', JSON.stringify(fbPick('reviewer')))
    rec.add(G_E, '③ `agent_id` 不带 `session-` 前缀 ⇒ `session_id:null`（不拿 member/agent id 冒充会话）', fbPick('docs')?.session_id === null && fbPick('docs')?.member_name === null, JSON.stringify(fbPick('docs')))
    rec.add(G_E, '`sessionIdOfAgentId`：仅 `session-` + 非空才返回，其余一律 `null` 且不抛', sessionIdOfAgentId('session-abc-123') === 'abc-123' && sessionIdOfAgentId('session-') === null && sessionIdOfAgentId('session-   ') === null && sessionIdOfAgentId('agent-x') === null && sessionIdOfAgentId(null) === null && sessionIdOfAgentId(undefined) === null, JSON.stringify([sessionIdOfAgentId('session-abc-123'), sessionIdOfAgentId('session-'), sessionIdOfAgentId('agent-x'), sessionIdOfAgentId(null)]))

    // === F 人工待办 ========================================================
    rec.add(G_F, '`human_pending` = 未答复数（pending + relayed = 2；answered / withdrawn 不算）', task?.human_pending === 2, `human_pending=${String(task?.human_pending)}`)
    rec.add(G_F, '没有 `human_requests` ⇒ 0（旧单不炸）', humanPendingCount({}) === 0 && humanPendingCount(undefined) === 0, '')
    rec.add(G_F, '非对象条目跳过（坏数据不参与计数、也不抛）', humanPendingCount({ human_requests: [null, 'x', { status: 'pending' }] }) === 1, '')
    rec.add(G_F, '缺 `status` 的记录按"还没答复"算（宁可多提醒，不许漏）', humanPendingCount({ human_requests: [{ request_id: 'HR-X' }] }) === 1, '')

    // === G 排序 + team_board ===============================================
    rec.add(G_G, '任务按 `updated_at` 倒序（新版在前）', (snap?.tasks ?? [])[0]?.id === NEWER && snap?.tasks?.[1]?.id === OLDER, JSON.stringify((snap?.tasks ?? []).map((t) => `${t.id}@${t.updated_at}`)))
    rec.add(G_G, '没有 `team-board.json` ⇒ `team_board: null`', task?.team_board === null, JSON.stringify(task?.team_board))
    const older = (snap?.tasks ?? []).find((t) => t.id === OLDER) ?? null
    rec.add(G_G, '有 `team-board.json` ⇒ 只读 `team_task_id` / `last_action` 两个字段', JSON.stringify(older?.team_board) === JSON.stringify({ team_task_id: 'task-2', last_action: 'complete' }), JSON.stringify(older?.team_board))
    rec.add(G_G, '旧单：`human_pending` 0 + 摘要不截断 + 状态中文', older?.human_pending === 0 && older?.requirement_snippet === '旧单：一句话需求。' && older?.state_label === '已关闭', JSON.stringify(older))

    // === H 路由 ============================================================
    rec.add(G_H, '`PANEL_PATH` = `/.dsh-pipeline/panel`', PANEL_PATH === '/.dsh-pipeline/panel' && PANEL_PATH.startsWith('/.dsh-pipeline/'), PANEL_PATH)
    const handler = createSwitchHandler({
      sw: fakeSwitch(),
      version: '9.9.9',
      panel: () => buildPanelSnapshot({ projectRoot: roots.root }),
    })
    const resPanel = fakeRes()
    await handler(fakeReq({ url: PANEL_PATH }), resPanel)
    let panelBody = null
    try {
      panelBody = JSON.parse(resPanel.body)
    } catch {
      panelBody = null
    }
    rec.add(G_H, '`GET /panel` ⇒ 200 + JSON 快照本身', resPanel.statusCode === 200 && panelBody?.ok === true && Array.isArray(panelBody?.tasks) && panelBody.tasks.length === 2, `status=${resPanel.statusCode} body=${resPanel.body.slice(0, 80)}`)
    rec.add(G_H, '`GET /panel` 带 `application/json` + `cache-control: no-store`', String(resPanel.headers?.['content-type'] ?? '').startsWith('application/json') && resPanel.headers?.['cache-control'] === 'no-store', JSON.stringify(resPanel.headers))
    const resPost = fakeRes()
    await handler(fakeReq({ method: 'POST', url: PANEL_PATH }), resPost)
    rec.add(G_H, '`POST /panel` ⇒ 405（面板是只读的，没有写入口）', resPost.statusCode === 405, `status=${resPost.statusCode}`)
    const resNoProvider = fakeRes()
    await createSwitchHandler({ sw: fakeSwitch(), version: '9.9.9' })(fakeReq({ url: PANEL_PATH }), resNoProvider)
    rec.add(G_H, '没接线数据源 ⇒ 503（不拿空对象冒充一份快照）', resNoProvider.statusCode === 503, `status=${resNoProvider.statusCode}`)
    const resState = fakeRes()
    await handler(fakeReq({ url: STATE_PATH }), resState)
    const stateBody = JSON.parse(resState.body)
    rec.add(G_H, '★ `/state` 的 GET 行为一个字没变（ok/on/since/by/revision/version/stateFile）', resState.statusCode === 200 && stateBody.ok === true && stateBody.on === true && stateBody.version === '9.9.9' && stateBody.revision === 3 && stateBody.stateFile === '/tmp/fixture-switch.json', resState.body)
    const resUnknown = fakeRes()
    await handler(fakeReq({ url: '/.dsh-pipeline/nope' }), resUnknown)
    rec.add(G_H, '其它路径仍然 404（没有因为加面板而放宽前缀）', resUnknown.statusCode === 404, `status=${resUnknown.statusCode}`)

    // === P 快照：pinned 字段与置顶排序 ====================================
    rec.add(G_P, '没置顶过的任务 ⇒ `pinned:false`（主夹具里一个置顶都没写）', (snap?.tasks ?? []).length > 0 && (snap?.tasks ?? []).every((t) => t.pinned === false), JSON.stringify((snap?.tasks ?? []).map((t) => `${t.id}:${String(t.pinned)}`)))
    const pinSnapRoot = roots.newRoot('snapshot-pins')
    const writePinTask = (id, updatedAt) => {
      const dir = join(pinSnapRoot, '.pipeline', id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'task.json'), JSON.stringify({ id, state: 'reviewing', requirement: `置顶夹具 ${id}`, updated_at: updatedAt }), 'utf8')
    }
    writePinTask('T-20261020-oldpinned', '2026-10-16T00:00:00Z')
    writePinTask('T-20261021-newplain', '2026-10-18T00:00:00Z')
    writePinTask('T-20261022-midplain', '2026-10-17T00:00:00Z')
    setPinned(pinSnapRoot, '.pipeline', 'T-20261020-oldpinned', true)
    const pinSnap = buildPanelSnapshot({ projectRoot: pinSnapRoot })
    rec.add(G_P, '每个任务都有 `pinned: boolean`', (pinSnap.tasks ?? []).length === 3 && (pinSnap.tasks ?? []).every((t) => typeof t.pinned === 'boolean'), JSON.stringify((pinSnap.tasks ?? []).map((t) => `${t.id}:${String(t.pinned)}`)))
    rec.add(G_P, '**置顶优先**：置顶的旧单排到最新单前面', (pinSnap.tasks ?? [])[0]?.id === 'T-20261020-oldpinned' && pinSnap.tasks[0].pinned === true, JSON.stringify((pinSnap.tasks ?? []).map((t) => t.id)))
    rec.add(G_P, '置顶组内部仍按 `updated_at` 倒序；未置顶组同理', JSON.stringify((pinSnap.tasks ?? []).map((t) => t.id)) === JSON.stringify(['T-20261020-oldpinned', 'T-20261021-newplain', 'T-20261022-midplain']), JSON.stringify((pinSnap.tasks ?? []).map((t) => `${t.id}@${t.updated_at}`)))
    rec.add(G_P, '任务行键序仍是契约那 11 个（`tier` 倒数第三、`pinned` 倒数第二）', (pinSnap.tasks ?? []).every((t) => JSON.stringify(Object.keys(t)) === JSON.stringify(PANEL_TASK_KEY_ORDER)), JSON.stringify(Object.keys((pinSnap.tasks ?? [])[0] ?? {})))
    setPinned(pinSnapRoot, '.pipeline', 'T-20261020-oldpinned', false)
    const unpinnedSnap = buildPanelSnapshot({ projectRoot: pinSnapRoot })
    rec.add(G_P, '取消置顶后排序回到纯 `updated_at` 倒序', JSON.stringify((unpinnedSnap.tasks ?? []).map((t) => t.id)) === JSON.stringify(['T-20261021-newplain', 'T-20261022-midplain', 'T-20261020-oldpinned']), JSON.stringify((unpinnedSnap.tasks ?? []).map((t) => t.id)))
    const badPinSnapRoot = roots.newRoot('snapshot-badpins')
    mkdirSync(join(badPinSnapRoot, '.pipeline', 'T-1'), { recursive: true })
    writeFileSync(join(badPinSnapRoot, '.pipeline', 'T-1', 'task.json'), JSON.stringify({ id: 'T-1', state: 'closed' }), 'utf8')
    writeFileSync(join(badPinSnapRoot, '.pipeline', PINS_FILE_NAME), 'not json at all', 'utf8')
    const badPinSnap = buildPanelSnapshot({ projectRoot: badPinSnapRoot })
    rec.add(G_P, '置顶文件坏了 ⇒ 快照照常出（按"没有置顶"降级，不 500）', badPinSnap.ok === true && badPinSnap.tasks.length === 1 && badPinSnap.tasks[0].pinned === false, JSON.stringify(badPinSnap))

    // === Q 归档视图路由（GET `?view=archived` 分流）========================
    const archiveRoot = roots.newRoot('archive')
    makeArchiveFixture(archiveRoot)
    const archiveHandler = createSwitchHandler({
      sw: fakeSwitch(),
      version: '9.9.9',
      panel: () => buildPanelSnapshot({ projectRoot: archiveRoot }),
      panelArchived: () => listArchived({ projectRoot: archiveRoot }),
    })
    rec.add(G_QV, '`PANEL_ARCHIVED_VIEW` = `archived`（客户端按这个值传 query）', PANEL_ARCHIVED_VIEW === 'archived', PANEL_ARCHIVED_VIEW)
    const resArchived = fakeRes()
    await archiveHandler(fakeReq({ url: `${PANEL_PATH}?view=archived` }), resArchived)
    const archivedBody = JSON.parse(resArchived.body)
    rec.add(G_QV, '`GET /panel?view=archived` ⇒ 200 + 归档视图（`tasks` 来自 `_trash`）', resArchived.statusCode === 200 && archivedBody.ok === true && Array.isArray(archivedBody.tasks) && archivedBody.tasks.some((t) => t.dir === ARCH_DIR_KEEP), `status=${resArchived.statusCode} body=${resArchived.body.slice(0, 120)}`)
    rec.add(G_QV, '归档视图同样 `application/json` + `no-store`', String(resArchived.headers?.['content-type'] ?? '').startsWith('application/json') && resArchived.headers?.['cache-control'] === 'no-store', JSON.stringify(resArchived.headers))
    const resOtherQuery = fakeRes()
    await archiveHandler(fakeReq({ url: `${PANEL_PATH}?view=whatever` }), resOtherQuery)
    const otherQueryBody = JSON.parse(resOtherQuery.body)
    rec.add(G_QV, '其它 query 仍走**主快照**（有 `generated_at`、每行有 `pinned`）', resOtherQuery.statusCode === 200 && typeof otherQueryBody.generated_at === 'string' && Array.isArray(otherQueryBody.tasks) && otherQueryBody.tasks.every((t) => typeof t.pinned === 'boolean'), `status=${resOtherQuery.statusCode} body=${resOtherQuery.body.slice(0, 120)}`)
    const resNoArchProvider = fakeRes()
    await createSwitchHandler({ sw: fakeSwitch(), version: '9.9.9', panel: () => buildPanelSnapshot({ projectRoot: archiveRoot }) })(fakeReq({ url: `${PANEL_PATH}?view=archived` }), resNoArchProvider)
    rec.add(G_QV, '归档视图没接线 ⇒ 503（不拿主快照冒充归档）', resNoArchProvider.statusCode === 503, `status=${resNoArchProvider.statusCode} body=${resNoArchProvider.body}`)
    const resArchThrew = fakeRes()
    await createSwitchHandler({ sw: fakeSwitch(), version: '9.9.9', panelArchived: () => { throw new Error('读盘炸了') } })(fakeReq({ url: `${PANEL_PATH}?view=archived` }), resArchThrew)
    rec.add(G_QV, '归档数据源抛异常 ⇒ 500（不让整个路由层炸）', resArchThrew.statusCode === 500, `status=${resArchThrew.statusCode}`)

    // 只读硬约束：跑完之后工作区的 task.json 一个字节都没变
    const before = JSON.stringify(newerTask(), null, 2)
    const after = readFileSync(join(pipelineDir, NEWER, 'task.json'), 'utf8')
    rec.add(G_I, '★ 全程只读：task.json 逐字节未被改写', before === after, before === after ? '' : '盘上内容被本模块改过了')
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 8).join('\n'))
  } finally {
    roots.cleanup()
  }

  return renderReport('dsh-pipeline · 自建流水线面板 · 快照 / 契约（只读快照 + GET 路由）', rec)
}

runDirect(runPanelSnapshotCheck, import.meta.url)
