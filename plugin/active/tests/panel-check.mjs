/**
 * dsh-pipeline · 自建流水线面板的**数据面**（只读快照 + 只读路由）
 * ============================================================================
 *     node tests/panel-check.mjs
 *
 * 钉住的是「面板能显示什么」这件事的**判据**，不是某段文案：
 *   A. 契约字段齐全（`id/state/state_label/requirement_snippet/updated_at/
 *      human_pending/team_board/seats` 一个不少、席位的九个字段也一个不少）；
 *   B. 中文名来自**唯一出处**（`STATE_LABEL` / `roleLabel`），认不出就原样返回、绝不抛；
 *   C. 需求摘要：压缩空白 → 截 80 个码点 → 超出加 `…`，且**绝不含交接物正文**；
 *   D. 坏 JSON / 读不出来 ⇒ **跳过 + 记 warnings**，不许把整张面板打成 500；
 *   E. 席位「声明 vs 已派出」的合并：同 (role, seat) 升级、名单里没有的追加、
 *      通道字段（`via`）决定 `kind`、`member_name` 取不到就是 `null`（不拿 id 冒充名字）；
 *   F. `human_pending` 只数**还没答复**的（`answered` / `withdrawn` 不算，`relayed` 还算）；
 *   G. 任务按 `updated_at` **倒序**；
 *   H. 路由：`GET /.dsh-pipeline/panel` 只读、带 `no-store`；`/state` 行为一个字没变。
 *
 * ★ 全程密闭：夹具自造临时目录，**不读任何活体真单**（不重蹈 P1-12 那条）。
 * ★ 只读：跑完之后临时目录整个删掉，工作区里不留东西。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  PANEL_SNIPPET_MAX,
  SEAT_STATUS,
  buildPanelSnapshot,
  declaredSeatsOf,
  humanPendingCount,
  seatsOf,
  snippetOf,
  stateLabelOf,
} from '../lib/panel/snapshot.js'
import { PANEL_PATH, STATE_PATH, createSwitchHandler } from '../lib/switch-routes.js'
import { roleLabel } from '../lib/roles.js'
import { pathKey } from '../lib/util.js'

const CJK = /[\u4e00-\u9fa5]/

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
      const L = ['dsh-pipeline · 自建流水线面板 · 数据面（只读快照 + 只读路由）', '='.repeat(78)]
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

const NEWER = 'T-20261018-aaa'
const OLDER = 'T-20261017-bbb'
const BAD = 'T-20261018-bad'
const NOFILE = 'T-20261016-nofile'
/** 夹具里的"正文"标记：面板输出里**绝不允许**出现它。 */
const HANDOFF_SECRET = '★交接物正文不该出现在面板里★'

const NEWER_REQUIREMENT =
  '实现自建流水线面板的数据面：\n\n 宿主只读 HTTP 路由 + 快照构建 + 单元测试。' +
  '要求面板显示任务列表、席位、当前会话身份与人工待办数；\n  只读取不写任何任务数据；不要包含交接物正文、补丁或代码。'

function newerTask() {
  return {
    id: NEWER,
    state: 'reviewing',
    updated_at: '2026-10-18T02:00:00Z',
    requirement: NEWER_REQUIREMENT,
    roster: {
      tier: 'L3',
      execution_roles: ['architect', 'security', 'writer', 'tester', 'reviewer', 'docs'],
      writers: {
        count: 2,
        layers: ['interface', 'data'],
        partitions: [
          { seat: 'writer#1', role_id: 'writer', index: 1, total: 2, layer: 'interface', scope_paths: ['lib/panel'] },
          { seat: 'writer#2', role_id: 'writer', index: 2, total: 2, layer: 'data', scope_paths: ['tests'] },
        ],
      },
    },
    // 形状照抄盘上的真实台账：{key, role, seat, agent_id, session_id, token, at, at_ms, via}
    dispatched: [
      { key: 'tester', role: 'tester', seat: null, agent_id: 'agent-t', session_id: 'session-tester', token: 'tk1', at: '2026-10-18T01:00:00Z', at_ms: 1, via: 'subagent' },
      { key: 'writer@writer#2', role: 'writer', seat: 'writer#2', agent_id: 'member-2', session_id: 'member-2', token: 'tk2', at: '2026-10-18T01:05:00Z', at_ms: 2, via: 'team', memberName: '编写员乙' },
      { key: 'docs', role: 'docs', seat: null, agent_id: null, session_id: null, token: 'tk3', at: '2026-10-18T01:06:00Z', at_ms: 3, via: 'manual' },
      { key: 'orchestrator', role: 'orchestrator', seat: null, agent_id: 'agent-o', session_id: 'session-orch', token: 'tk4', at: '2026-10-18T01:07:00Z', at_ms: 4, via: 'subagent' },
    ],
    human_requests: [
      { request_id: 'HR-1', status: 'pending' },
      { request_id: 'HR-2', status: 'relayed' },
      { request_id: 'HR-3', status: 'answered', answered_at: '2026-10-18T01:30:00Z' },
      { request_id: 'HR-4', status: 'withdrawn' },
    ],
  }
}

function olderTask() {
  return {
    id: OLDER,
    state: 'closed',
    updated_at: '2026-10-17T10:00:00Z',
    requirement: '旧单：一句话需求。',
    roster: { execution_roles: ['writer'], writers: { count: 1, partitions: [{ seat: 'writer#1', role_id: 'writer', layer: 'all', scope_paths: ['.'] }] } },
  }
}

/** 造夹具：3 个 `T-*` 目录（1 正常新版 / 1 正常旧版 / 1 坏 JSON）+ 1 个没有 task.json + 1 个不该被看的目录。 */
function makeFixture(root) {
  const dir = join(root, '.pipeline')
  const write = (parts, content) => {
    const file = join(dir, ...parts)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf8')
  }
  write([NEWER, 'task.json'], JSON.stringify(newerTask(), null, 2))
  write([NEWER, 'handoffs', '001-dev_to_test.json'], JSON.stringify({ patch: HANDOFF_SECRET }))
  write([OLDER, 'task.json'], JSON.stringify(olderTask(), null, 2))
  write([OLDER, 'team-board.json'], JSON.stringify({ team_task_id: 'task-2', revision: 7, last_action: 'complete', at: '2026-10-17T10:05:00Z' }))
  write([BAD, 'task.json'], '{ "id": "T-20261018-bad", 这不是 JSON ')
  mkdirSync(join(dir, NOFILE), { recursive: true })
  // 不该被看作任务：前缀不对 / 前缀对但是个文件
  write(['_memory', 'task.json'], JSON.stringify({ id: '_memory', state: 'closed' }))
  writeFileSync(join(dir, 'T-20261015-file'), 'not a directory', 'utf8')
  return dir
}

/* ------------------------------------------------------------------------- */
/* 路由夹具（假 req / res，足够喂真 handler）                                  */
/* ------------------------------------------------------------------------- */

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers ?? null
    },
    end(body) {
      res.body = body === undefined ? '' : String(body)
    },
  }
  return res
}

function fakeReq({ method = 'GET', url = '/', headers = {} } = {}) {
  return { method, url, headers, socket: { remoteAddress: '127.0.0.1' } }
}

function fakeSwitch() {
  const snap = { since: '2026-10-18T00:00:00Z', by: 'fixture', revision: 3 }
  return { isOn: () => true, snapshot: () => snap, stateFile: '/tmp/fixture-switch.json' }
}

/* ------------------------------------------------------------------------- */

export async function runPanelCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-panel-'))
  const G_A = 'A · 契约与形状'
  const G_B = 'B · 中文名（唯一出处）'
  const G_C = 'C · 需求摘要（压缩 + 80 码点）'
  const G_D = 'D · 坏输入只进 warnings'
  const G_E = 'E · 席位（声明 vs 已派出）'
  const G_F = 'F · 人工待办计数'
  const G_G = 'G · 排序'
  const G_H = 'H · 只读路由'
  const G_I = 'I · 只读硬约束'

  try {
    const pipelineDir = makeFixture(root)
    let snap = null
    let threw = null
    try {
      snap = buildPanelSnapshot({ projectRoot: root, now: Date.parse('2026-10-18T03:00:00Z') })
    } catch (err) {
      threw = String(err?.message ?? err)
    }

    // === A 契约 ============================================================
    rec.add(G_A, '`buildPanelSnapshot` 不抛异常', threw === null, threw === null ? '' : `抛了：${threw}`)
    rec.add(G_A, '`ok === true`（有坏单也照样出快照）', snap?.ok === true, `ok=${String(snap?.ok)}`)
    rec.add(G_A, '`generated_at` 是注入时刻的 ISO 串', snap?.generated_at === '2026-10-18T03:00:00Z', `generated_at=${String(snap?.generated_at)}`)
    rec.add(G_A, '`project_root` 与插件其它地方**同一套归一化**（`pathKey`）', snap?.project_root === pathKey(root), `project_root=${String(snap?.project_root)} 期望=${pathKey(root)}`)
    rec.add(G_A, '只认 `T-` 前缀的目录（`_memory` / 非目录都不算）', snap?.tasks?.length === 2, `tasks=${JSON.stringify((snap?.tasks ?? []).map((t) => t.id))}`)
    rec.add(G_A, '`warnings` 是字符串数组', Array.isArray(snap?.warnings) && snap.warnings.every((w) => typeof w === 'string'), JSON.stringify(snap?.warnings))

    const task = (snap?.tasks ?? []).find((t) => t.id === NEWER) ?? null
    const TASK_KEYS = ['human_pending', 'id', 'requirement_snippet', 'seats', 'state', 'state_label', 'team_board', 'updated_at']
    rec.add(G_A, '任务行字段与契约**逐个**对齐（8 个）', task !== null && JSON.stringify(Object.keys(task).sort()) === JSON.stringify(TASK_KEYS), `实际键=${JSON.stringify(Object.keys(task ?? {}).sort())}`)
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
    const emptyRoot = mkdtempSync(join(tmpdir(), 'dsh-pipeline-panel-empty-'))
    try {
      const empty = buildPanelSnapshot({ projectRoot: emptyRoot })
      rec.add(G_D, '空目录 ⇒ `ok:true` + 空任务表（新 profile 不算错）', empty.ok === true && empty.tasks.length === 0 && empty.warnings.length === 0, JSON.stringify(empty))
      const noRoot = buildPanelSnapshot({})
      rec.add(G_D, '没有 `projectRoot` ⇒ `ok:false` + 中文 error（照样不抛）', noRoot.ok === false && CJK.test(String(noRoot.error)) && noRoot.tasks.length === 0, `error=${String(noRoot.error)}`)
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }

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
      panel: () => buildPanelSnapshot({ projectRoot: root }),
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

    // 只读硬约束：跑完之后工作区的 task.json 一个字节都没变
    const before = JSON.stringify(newerTask(), null, 2)
    const after = readFileSync(join(pipelineDir, NEWER, 'task.json'), 'utf8')
    rec.add(G_I, '★ 全程只读：task.json 逐字节未被改写', before === after, before === after ? '' : '盘上内容被本模块改过了')
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 8).join('\n'))
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  }

  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runPanelCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
