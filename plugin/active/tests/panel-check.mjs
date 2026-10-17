/**
 * dsh-pipeline · 自建流水线面板的**数据面**（只读快照 + 只读路由）
 * ============================================================================
 *     node tests/panel-check.mjs
 *
 * 钉住的是「面板能显示什么」这件事的**判据**，不是某段文案：
 *   A. 契约字段齐全（`id/state/state_label/requirement_snippet/updated_at/
 *      human_pending/team_board/seats/tier` 一个不少、席位的九个字段也一个不少）；
 *      `tier` 只认 `L0`–`L5`（大小写不敏感、输出大写），认不出就是 `null`；
 *   B. 中文名来自**唯一出处**（`STATE_LABEL` / `roleLabel`），认不出就原样返回、绝不抛；
 *   C. 需求摘要：压缩空白 → 截 80 个码点 → 超出加 `…`，且**绝不含交接物正文**；
 *   D. 坏 JSON / 读不出来 ⇒ **跳过 + 记 warnings**，不许把整张面板打成 500；
 *   E. 席位「声明 vs 已派出」的合并：同 (role, seat) 升级、名单里没有的追加、
 *      通道字段（`via`）决定 `kind`、`member_name` 取不到就是 `null`（不拿 id 冒充名字）；
 *      `session_id` 缺省时从 `agent_id:"session-<id>"` 剥前缀兜底（显式 `session_id` 优先）；
 *   F. `human_pending` 只数**还没答复**的（`answered` / `withdrawn` 不算，`relayed` 还算）；
 *   G. 任务按 `updated_at` **倒序**；
 *   H. 路由：`GET /.dsh-pipeline/panel` 只读、带 `no-store`；`/state` 行为一个字没变。
 *   I. 只读硬约束：跑完之后夹具的 `task.json` 逐字节未改；
 *   J. `allowed_actions`：终态 ⇒ `archive+delete`、`blocked` ⇒ `restore`、
 *      `reviewing` ⇒ `cancel`、`pending` 无 `archive/delete`；顺序固定、判据来自状态机；
 *   K. 面板操作执行器（`createPanelActions`）：白名单 / 开关门 / 删单二次确认 /
 *      底层拒绝原样透出 / 异常归一化（**绝不抛**）；
 *   L. 面板操作路由（`POST /.dsh-pipeline/panel/action`）：405 / 403 / 503 / 400 / 413
 *      各有明确回执，`/panel` 与 `/state` 一个字没变。
 *   M. 归档视图（`lib/panel/archive.js#listArchived`）：只扫 `_trash/* /task.json`、
 *      坏 JSON 只进 warnings、`id` 从目录名右锚剥 stamp、`archived_at` 解析不出退回目录 mtime；
 *   N. 恢复 / 永久删除归档：路径穿越与"目标已存在"两道硬闸、`confirm` 必须严格 `true`、
 *      墓碑写进 `_purge-log.jsonl`（与 `purge.js` 同一个账本）且**先留痕后动手**；
 *   O. 置顶（`lib/panel/pins.js`）：set / unset / 持久化 / 坏文件当空 / 原子写无残留 / 上限 200；
 *   P. 快照的 `pinned` 与**置顶优先、其余按 `updated_at` 倒序**的排序，以及任务行键序契约；
 *   Q. 新动作（`pin` / `unpin` / `unarchive` / `delete_archived`）的参数透传、开关门、
 *      拒绝透出，加上 `GET /panel?view=archived` 的分流（其它 query 仍走主快照）。
 *
 * ★ 全程密闭：夹具自造临时目录，**不读任何活体真单**（不重蹈 P1-12 那条）。
 * ★ 只读：跑完之后临时目录整个删掉，工作区里不留东西。
 * ★ 面板操作那几组用**假 store / 假 pins / 假 archive**（只记录入参），不碰任何真实任务目录；
 *   只有 Q 里那三组"端到端"用的是真实现 + 真临时目录。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  PANEL_ACTION_ORDER,
  PANEL_SNIPPET_MAX,
  PANEL_TASK_KEY_ORDER,
  SEAT_STATUS,
  allowedActionsOf,
  buildPanelSnapshot,
  declaredSeatsOf,
  humanPendingCount,
  seatsOf,
  sessionIdOfAgentId,
  snippetOf,
  stateLabelOf,
  taskTierOf,
} from '../lib/panel/snapshot.js'
import {
  DELETE_CONFIRM_ERROR,
  DELETE_ARCHIVED_MESSAGE,
  PANEL_ACTION_IDS,
  PIN_OFF_MESSAGE,
  PIN_ON_MESSAGE,
  SWITCH_OFF_ERROR,
  UNARCHIVE_MESSAGE,
  createPanelActions,
} from '../lib/panel/actions.js'
import {
  ARCHIVE_DIR_NAME,
  DELETE_ARCHIVED_CONFIRM_ERROR,
  DELETE_ARCHIVED_REASON,
  deleteArchived,
  listArchived,
  restoreArchived,
} from '../lib/panel/archive.js'
import {
  PINS_FILE_NAME,
  PINS_MAX,
  isPinned,
  pinsFileOf,
  readPins,
  setPinned,
} from '../lib/panel/pins.js'
import {
  PANEL_ACTION_PATH,
  PANEL_ARCHIVED_VIEW,
  PANEL_PATH,
  STATE_PATH,
  createSwitchHandler,
} from '../lib/switch-routes.js'
import { PURGE_LOG_NAME, TRASH_DIR_NAME } from '../lib/store/purge.js'
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

/** 带请求体的假 req（`readBody` 走 data/end 事件；这里在挂上 end 监听之后下一拍再灌）。 */
function fakeBodyReq({ method = 'POST', url = '/', headers = {}, body = '' } = {}) {
  const handlers = new Map()
  const emit = (event, arg) => {
    for (const fn of handlers.get(event) ?? []) fn(arg)
  }
  const req = {
    method,
    url,
    headers: { 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      if (event === 'end') {
        queueMicrotask(() => {
          if (body.length > 0) emit('data', Buffer.from(body, 'utf8'))
          emit('end')
        })
      }
      return req
    },
  }
  return req
}

/** 假 store：只记录入参（**不碰任何真实目录**），可注入返回值 / 抛异常。 */
function fakeActionStore({ purgeResult = null, transitionResult = null, throwOn = null } = {}) {
  const calls = []
  return {
    calls,
    async purgeTask(input) {
      calls.push({ method: 'purgeTask', input })
      if (throwOn === 'purgeTask') throw new Error('目录被占用了（夹具故意抛）')
      return purgeResult ?? { ok: true, mode: input?.mode, task_id: input?.taskId, moved_to: null, files: 1, bytes: 2, purged_at: '2026-10-18T00:00:00Z' }
    },
    async transition(input) {
      calls.push({ method: 'transition', input })
      if (throwOn === 'transition') throw new Error('状态机抛了（夹具故意抛）')
      return transitionResult ?? { ok: true, task: null, from: 'blocked', to: input?.event === 'cancel' ? 'cancelled' : 'developing', state_zh: 'x', summary: '...' }
    },
  }
}

/* ------------------------------------------------------------------------- */
/* 归档 / 置顶夹具（全部在临时目录里自造，**不读任何活体真单**）               */
/* ------------------------------------------------------------------------- */

const ARCH_KEEP = 'T-20261015-bb30bc'
const ARCH_OLD = 'T-20261016-cc11aa'
const ARCH_BAD = 'T-20261018-bad'
const ARCH_NOFILE = 'T-20261016-nofile'
/** `_trash` 里的目录名：`<任务id>-<stamp>`（stamp 是 purge 的 `nowIso().replace(/[:]/g,'')`）。 */
const ARCH_DIR_KEEP = `${ARCH_KEEP}-2026-10-18T042252Z`
const ARCH_DIR_OLD = `${ARCH_OLD}-2026-10-17T010203Z`
const ARCH_DIR_BAD = `${ARCH_BAD}-2026-10-18T050000Z`
const ARCH_DIR_NOFILE = `${ARCH_NOFILE}-2026-10-18T051500Z`
/** 老格式：目录名里没有 stamp ⇒ `archived_at` 退回目录 mtime。 */
const ARCH_DIR_NOSTAMP = 'T-20261019-nostamp'
const ARCH_NOSTAMP_MTIME = '2026-10-19T00:00:00Z'

/**
 * 造归档夹具：2 张好单 + 1 张坏 JSON + 1 个没有 task.json + 1 个没有 stamp 的老目录
 * + 1 个不该被当成归档的普通文件。
 */
function makeArchiveFixture(root, dirName = '.pipeline') {
  const base = join(root, dirName, TRASH_DIR_NAME)
  const write = (parts, content) => {
    const file = join(base, ...parts)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf8')
  }
  write([ARCH_DIR_KEEP, 'task.json'], JSON.stringify({ id: ARCH_KEEP, state: 'closed', requirement: '归档单：一句话需求。', updated_at: '2026-10-17T09:00:00Z' }, null, 2))
  write([ARCH_DIR_OLD, 'task.json'], JSON.stringify({ id: ARCH_OLD, state: 'cancelled', requirement: '更早归档的单。' }, null, 2))
  write([ARCH_DIR_BAD, 'task.json'], '{ 这不是 JSON ')
  mkdirSync(join(base, ARCH_DIR_NOFILE), { recursive: true })
  write([ARCH_DIR_NOSTAMP, 'task.json'], JSON.stringify({ id: ARCH_DIR_NOSTAMP, state: 'closed', requirement: '没有 stamp 的老目录。' }))
  // 目录 mtime 钉死 ⇒「解析不出 stamp 就用目录 mtime」这条才是**可断言的**
  const fixed = new Date(ARCH_NOSTAMP_MTIME)
  utimesSync(join(base, ARCH_DIR_NOSTAMP), fixed, fixed)
  // `_trash` 下的普通文件不是归档（跳过，也不该进 warnings）
  writeFileSync(join(base, 'README.txt'), 'not a dir', 'utf8')
  return base
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
  const G_J = 'J · allowed_actions（快照判定）'
  const G_K = 'K · 面板操作执行器（白名单 / 开关 / 确认 / 归一化）'
  const G_L = 'L · 面板操作路由（POST /panel/action）'
  const G_M = 'M · 归档视图（`_trash` 列表）'
  const G_N = 'N · 归档恢复 / 永久删除'
  const G_O = 'O · 置顶（pins.js）'
  const G_P = 'P · 快照的 pinned 与置顶排序'
  const G_Q = 'Q · 新动作与归档路由（pin/unpin/unarchive/delete_archived）'

  /** 每个用例自己的临时项目根（跑完统一删）。 */
  const extraRoots = []
  const newRoot = (tag) => {
    const dir = mkdtempSync(join(tmpdir(), `dsh-pipeline-panel-${tag}-`))
    extraRoots.push(dir)
    return dir
  }

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

    // === J allowed_actions =================================================
    rec.add(G_J, '`allowed_actions` 是字符串数组（每个任务都有，且都来自白名单）', (snap?.tasks ?? []).every((t) => Array.isArray(t.allowed_actions) && t.allowed_actions.every((a) => typeof a === 'string' && PANEL_ACTION_IDS.includes(a))), JSON.stringify((snap?.tasks ?? []).map((t) => `${t.state}:${JSON.stringify(t.allowed_actions)}`)))
    rec.add(G_J, '`reviewing`（非终态）⇒ 只有 `cancel`', JSON.stringify(task?.allowed_actions) === JSON.stringify(['cancel']), JSON.stringify(task?.allowed_actions))
    rec.add(G_J, '快照里的 `allowed_actions` 与纯函数 `allowedActionsOf` **同源**（逐行相等）', (snap?.tasks ?? []).every((t) => JSON.stringify(t.allowed_actions) === JSON.stringify(allowedActionsOf(t.state))), '')
    rec.add(G_J, '`PANEL_ACTION_ORDER` 是执行器白名单的**前缀**（前四个名字，快照与执行器不漂移）', JSON.stringify(PANEL_ACTION_IDS.slice(0, PANEL_ACTION_ORDER.length)) === JSON.stringify(PANEL_ACTION_ORDER) && JSON.stringify(PANEL_ACTION_ORDER) === JSON.stringify(['cancel', 'restore', 'archive', 'delete']), JSON.stringify(PANEL_ACTION_IDS))
    rec.add(G_J, '`allowed_actions` 只报状态驱动的四个（`pin/unpin/unarchive/delete_archived` 不参与状态判定）', (snap?.tasks ?? []).every((t) => t.allowed_actions.every((a) => PANEL_ACTION_ORDER.includes(a))), JSON.stringify((snap?.tasks ?? []).map((t) => t.allowed_actions)))

    // 四种状态的判据各一例（**单独一份夹具**：不动上面那 2 条既有断言）
    const statesRoot = mkdtempSync(join(tmpdir(), 'dsh-pipeline-panel-states-'))
    const STATE_CASES = [
      { state: 'closed', expect: ['archive', 'delete'] },
      { state: 'cancelled', expect: ['archive', 'delete'] },
      { state: 'blocked', expect: ['cancel', 'restore'] },
      { state: 'reviewing', expect: ['cancel'] },
      { state: 'pending', expect: ['cancel'] },
      // ★ 未知状态**不是终态**，而 `cancel` 在状态机里是 `from:'*'`（任意非终态可取消）
      //   ⇒ 这里如实给 `cancel`：这不是"猜"，是查表查出来的（`applyTransition` 也会放行）。
      { state: '没人定义过的状态', expect: ['cancel'] },
    ]
    try {
      for (const [i, c] of STATE_CASES.entries()) {
        const id = `T-20261019-a${i}`
        const dir = join(statesRoot, '.pipeline', id)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'task.json'), JSON.stringify({ id, state: c.state, requirement: `状态 ${c.state} 的单。`, updated_at: '2026-10-18T00:00:00Z' }), 'utf8')
      }
      const statesSnap = buildPanelSnapshot({ projectRoot: statesRoot })
      const rowOfState = (s) => (statesSnap.tasks ?? []).find((t) => t.state === s) ?? null
      for (const c of STATE_CASES) {
        const got = rowOfState(c.state)?.allowed_actions
        rec.add(G_J, `状态「${c.state}」⇒ ${JSON.stringify(c.expect)}`, JSON.stringify(got) === JSON.stringify(c.expect), `实际=${JSON.stringify(got)} 期望=${JSON.stringify(c.expect)}`)
      }
      rec.add(G_J, '`pending`（待分配）明确**没有** `archive` / `delete`', !(rowOfState('pending')?.allowed_actions ?? []).includes('archive') && !(rowOfState('pending')?.allowed_actions ?? []).includes('delete'), JSON.stringify(rowOfState('pending')?.allowed_actions))
      rec.add(G_J, '`blocked` 明确**有** `restore`，终态明确**没有**（终态闸与状态机同源）', (rowOfState('blocked')?.allowed_actions ?? []).includes('restore') && !(rowOfState('closed')?.allowed_actions ?? []).includes('restore') && !(rowOfState('closed')?.allowed_actions ?? []).includes('cancel'), JSON.stringify({ blocked: rowOfState('blocked')?.allowed_actions, closed: rowOfState('closed')?.allowed_actions }))
      rec.add(G_J, '顺序恒定：每个数组都是 `cancel, restore, archive, delete` 的子序列', (statesSnap.tasks ?? []).every((t) => JSON.stringify(t.allowed_actions) === JSON.stringify(PANEL_ACTION_ORDER.filter((a) => t.allowed_actions.includes(a)))), JSON.stringify((statesSnap.tasks ?? []).map((t) => t.allowed_actions)))
      rec.add(G_J, '空 / 缺状态 ⇒ 空数组；未知但非终态 ⇒ 只剩 `cancel`（状态机 `from:"*"` 那条边，不是猜的）', JSON.stringify(allowedActionsOf('')) === '[]' && JSON.stringify(allowedActionsOf(undefined)) === '[]' && JSON.stringify(allowedActionsOf('没人定义过的状态')) === JSON.stringify(['cancel']), JSON.stringify({ empty: allowedActionsOf(''), unknown: allowedActionsOf('没人定义过的状态') }))
    } finally {
      rmSync(statesRoot, { recursive: true, force: true })
    }

    // === K 面板操作执行器 ==================================================
    const ACTION_SW_ON = { isOn: () => true }
    const ACTION_SW_OFF = { isOn: () => false }
    const NOT_TERMINAL_ERROR = '拒绝清理：任务 T-1 现在停在「developing」，**不是终态**。'
    const BAD_TRANSITION_ERROR = '状态迁移被拒（任务 T-1）：状态「developing」不接受事件「cancel」。'
    {
      const store = fakeActionStore()
      const run = createPanelActions({ store, sw: ACTION_SW_ON })
      const out = await run.run({ task_id: 'T-1', action: 'archive' })
      const call = store.calls.at(-1)
      rec.add(G_K, '`archive` ⇒ `purgeTask({mode:"trash", by:"human", reason:"面板·留档"})`', call?.method === 'purgeTask' && JSON.stringify(call.input) === JSON.stringify({ taskId: 'T-1', mode: 'trash', by: 'human', reason: '面板·留档' }), JSON.stringify(call))
      rec.add(G_K, '`archive` 成功 ⇒ `{ok:true, action, task_id, message:"已留档"}`（成功形状只有这 4 个键）', out.ok === true && out.message === '已留档' && out.action === 'archive' && out.task_id === 'T-1' && JSON.stringify(Object.keys(out).sort()) === JSON.stringify(['action', 'message', 'ok', 'task_id']), JSON.stringify(out))
    }
    {
      const store = fakeActionStore()
      const run = createPanelActions({ store, sw: ACTION_SW_ON })
      const noConfirm = await run.run({ task_id: 'T-1', action: 'delete' })
      rec.add(G_K, '`delete` 缺 confirm ⇒ 被拒，且**一次都没调 store**', noConfirm.ok === false && noConfirm.error === DELETE_CONFIRM_ERROR && store.calls.length === 0, JSON.stringify(noConfirm))
      const strConfirm = await run.run({ task_id: 'T-1', action: 'delete', confirm: 'true' })
      rec.add(G_K, '`delete` 的 confirm 必须**严格** `true`（字符串 `"true"` 不算）', strConfirm.ok === false && strConfirm.error === DELETE_CONFIRM_ERROR && store.calls.length === 0, JSON.stringify(strConfirm))
      const confirmed = await run.run({ task_id: 'T-1', action: 'delete', confirm: true })
      const call = store.calls.at(-1)
      rec.add(G_K, '`delete` + confirm ⇒ `purgeTask({mode:"delete", reason:"面板·删单"})`，message 是「已删单」', confirmed.ok === true && confirmed.message === '已删单' && call?.method === 'purgeTask' && JSON.stringify(call.input) === JSON.stringify({ taskId: 'T-1', mode: 'delete', by: 'human', reason: '面板·删单' }), JSON.stringify({ confirmed, call }))
    }
    {
      const store = fakeActionStore()
      const run = createPanelActions({ store, sw: ACTION_SW_ON })
      const cancelled = await run.run({ task_id: 'T-2', action: 'cancel' })
      const cancelCall = store.calls.at(-1)
      rec.add(G_K, '`cancel` ⇒ `transition({event:"cancel", actorRole:"human", note:"面板·终止"})`，message 是「已终止：cancelled」', cancelled.ok === true && cancelled.message === '已终止：cancelled' && cancelCall?.method === 'transition' && JSON.stringify(cancelCall.input) === JSON.stringify({ taskId: 'T-2', event: 'cancel', actorRole: 'human', note: '面板·终止' }), JSON.stringify({ cancelled, call: cancelCall }))
      const restored = await run.run({ task_id: 'T-2', action: 'restore' })
      const restoreCall = store.calls.at(-1)
      rec.add(G_K, '`restore` ⇒ `transition({event:"unblock", actorRole:"human", note:"面板·恢复"})`，message 是「已恢复」', restored.ok === true && restored.message === '已恢复' && restoreCall?.method === 'transition' && JSON.stringify(restoreCall.input) === JSON.stringify({ taskId: 'T-2', event: 'unblock', actorRole: 'human', note: '面板·恢复' }), JSON.stringify({ restored, call: restoreCall }))
    }
    {
      const store = fakeActionStore()
      const run = createPanelActions({ store, sw: ACTION_SW_ON })
      const unknown = await run.run({ task_id: 'T-1', action: 'nuke' })
      rec.add(G_K, '未知操作 ⇒ `未知操作：<action>`，不碰 store', unknown.ok === false && unknown.error === '未知操作：nuke' && unknown.action === 'nuke' && unknown.task_id === 'T-1' && store.calls.length === 0, JSON.stringify(unknown))
      const junk = await run.run(undefined)
      rec.add(G_K, '入参不是对象也不抛（按未知操作拒，形状照旧）', junk.ok === false && junk.error === '未知操作：' && typeof junk.action === 'string' && typeof junk.task_id === 'string', JSON.stringify(junk))
    }
    {
      const store = fakeActionStore()
      const run = createPanelActions({ store, sw: ACTION_SW_OFF })
      const outs = []
      for (const action of PANEL_ACTION_IDS) outs.push(await run.run({ task_id: 'T-1', action, confirm: true }))
      rec.add(G_K, '开关关 ⇒ 四个动作**一律**被拒（store 一次都没调），文案点名「先打开右上角开关」', outs.every((o) => o.ok === false && o.error === SWITCH_OFF_ERROR) && store.calls.length === 0, JSON.stringify(outs.map((o) => o.error)))
      const noSwitch = await createPanelActions({ store }).run({ task_id: 'T-1', action: 'cancel' })
      let threwSwitch = null
      let threwOut = null
      try {
        threwOut = await createPanelActions({ store, sw: { isOn() { throw new Error('boom') } } }).run({ task_id: 'T-1', action: 'cancel' })
      } catch (err) {
        threwSwitch = String(err?.message ?? err)
      }
      rec.add(G_K, '没有开关对象 / `isOn()` 抛异常 ⇒ 按「关」处理（fail-closed，**不抛**）', noSwitch.ok === false && noSwitch.error === SWITCH_OFF_ERROR && threwSwitch === null && threwOut?.error === SWITCH_OFF_ERROR, JSON.stringify({ noSwitch, threwSwitch, threwOut }))
    }
    {
      const store = fakeActionStore({ throwOn: 'purgeTask' })
      const out = await createPanelActions({ store, sw: ACTION_SW_ON }).run({ task_id: 'T-1', action: 'archive' })
      rec.add(G_K, '`store.purgeTask` 抛异常 ⇒ 归一成 `ok:false` + code，**不抛**', out.ok === false && out.code === 'PANEL_ACTION_FAILED' && out.error.includes('目录被占用了') && out.action === 'archive' && out.task_id === 'T-1', JSON.stringify(out))
      const store2 = fakeActionStore({ throwOn: 'transition' })
      const out2 = await createPanelActions({ store: store2, sw: ACTION_SW_ON }).run({ task_id: 'T-1', action: 'restore' })
      rec.add(G_K, '`store.transition` 抛异常 ⇒ 同上（`ok:false` + code，不抛）', out2.ok === false && out2.code === 'PANEL_ACTION_FAILED' && out2.error.includes('状态机抛了'), JSON.stringify(out2))
    }
    {
      const store = fakeActionStore({ purgeResult: { ok: false, code: 'NOT_TERMINAL', error: NOT_TERMINAL_ERROR } })
      const out = await createPanelActions({ store, sw: ACTION_SW_ON }).run({ task_id: 'T-1', action: 'archive' })
      rec.add(G_K, '底层拒绝**原样透出**（`code` + `error` 逐字，不粉饰成成功）', out.ok === false && out.code === 'NOT_TERMINAL' && out.error === NOT_TERMINAL_ERROR, JSON.stringify(out))
      const store2 = fakeActionStore({ transitionResult: { ok: false, code: 'BAD_TRANSITION', error: BAD_TRANSITION_ERROR } })
      const out2 = await createPanelActions({ store: store2, sw: ACTION_SW_ON }).run({ task_id: 'T-1', action: 'cancel' })
      rec.add(G_K, '状态机拒绝也原样透出（`BAD_TRANSITION`）', out2.ok === false && out2.code === 'BAD_TRANSITION' && out2.error === BAD_TRANSITION_ERROR, JSON.stringify(out2))
    }
    {
      const bare = createPanelActions({ store: {}, sw: ACTION_SW_ON })
      const out = await bare.run({ task_id: 'T-1', action: 'archive' })
      const out2 = await bare.run({ task_id: 'T-1', action: 'cancel' })
      rec.add(G_K, 'store 上没有对应方法 ⇒ `STORE_UNAVAILABLE`（不拿 TypeError 当判词）', out.code === 'STORE_UNAVAILABLE' && out2.code === 'STORE_UNAVAILABLE' && out.error.includes('purgeTask') && out2.error.includes('transition'), JSON.stringify({ out, out2 }))
    }

    // === L 面板操作路由 ====================================================
    const fakePanelAction = () => {
      const calls = []
      return {
        calls,
        async run(input) {
          calls.push(input)
          return { ok: true, action: input.action, task_id: input.task_id, message: '已终止：cancelled' }
        },
      }
    }
    rec.add(G_L, '`PANEL_ACTION_PATH` = `/.dsh-pipeline/panel/action`（在 `/panel` 之下）', PANEL_ACTION_PATH === '/.dsh-pipeline/panel/action' && PANEL_ACTION_PATH.startsWith(`${PANEL_PATH}/`), PANEL_ACTION_PATH)
    const pa = fakePanelAction()
    const actionHandler = createSwitchHandler({ sw: fakeSwitch(), version: '9.9.9', panelAction: pa })
    const resOk = fakeRes()
    await actionHandler(fakeBodyReq({ url: PANEL_ACTION_PATH, body: JSON.stringify({ task_id: 'T-1', action: 'cancel' }) }), resOk)
    const okBody = JSON.parse(resOk.body)
    rec.add(G_L, '`POST /panel/action` ⇒ 200 + JSON（`application/json` + `no-store`）', resOk.statusCode === 200 && okBody.ok === true && okBody.message === '已终止：cancelled' && String(resOk.headers?.['content-type'] ?? '').startsWith('application/json') && resOk.headers?.['cache-control'] === 'no-store', `status=${resOk.statusCode} headers=${JSON.stringify(resOk.headers)} body=${resOk.body}`)
    rec.add(G_L, '执行器收到的参数与请求体一致（`confirm` 归一成布尔）', JSON.stringify(pa.calls.at(-1)) === JSON.stringify({ task_id: 'T-1', action: 'cancel', confirm: false }), JSON.stringify(pa.calls))
    const resConfirm = fakeRes()
    await actionHandler(fakeBodyReq({ url: PANEL_ACTION_PATH, body: JSON.stringify({ task_id: 'T-1', action: 'delete', confirm: true }) }), resConfirm)
    rec.add(G_L, '`confirm:true` 原样传给执行器（二次确认不会被路由层吞掉）', JSON.parse(resConfirm.body).ok === true && pa.calls.at(-1)?.confirm === true, JSON.stringify(pa.calls.at(-1)))
    const resGet = fakeRes()
    await actionHandler(fakeReq({ url: PANEL_ACTION_PATH }), resGet)
    rec.add(G_L, '非 POST ⇒ 405（面板操作没有 GET 入口）', resGet.statusCode === 405, `status=${resGet.statusCode} body=${resGet.body}`)
    const resCross = fakeRes()
    await actionHandler(fakeBodyReq({ url: PANEL_ACTION_PATH, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'task_id=T-1&action=delete' }), resCross)
    rec.add(G_L, '免预检的跨站表单（`text/plain` / form）⇒ 403（与 `/state` 写操作同一道闸）', resCross.statusCode === 403 && pa.calls.length === 2, `status=${resCross.statusCode} body=${resCross.body}`)
    const resBadJson = fakeRes()
    await actionHandler(fakeBodyReq({ url: PANEL_ACTION_PATH, body: '{ 这不是 JSON' }), resBadJson)
    rec.add(G_L, '坏 JSON ⇒ 400 + 「请求体不是合法 JSON」', resBadJson.statusCode === 400 && JSON.parse(resBadJson.body).error === '请求体不是合法 JSON', `status=${resBadJson.statusCode} body=${resBadJson.body}`)
    const resArr = fakeRes()
    await actionHandler(fakeBodyReq({ url: PANEL_ACTION_PATH, body: '[1,2]' }), resArr)
    rec.add(G_L, '请求体是数组 ⇒ 400（必须是对象）', resArr.statusCode === 400, `status=${resArr.statusCode} body=${resArr.body}`)
    const resTooBig = fakeRes()
    await actionHandler(fakeBodyReq({ url: PANEL_ACTION_PATH, body: JSON.stringify({ task_id: 'T-1', action: 'cancel', pad: 'x'.repeat(9000) }) }), resTooBig)
    rec.add(G_L, '请求体超过 8 KB ⇒ 413（上限是**路由层**的，不是执行器的）', resTooBig.statusCode === 413, `status=${resTooBig.statusCode}`)
    const resNoAction = fakeRes()
    await createSwitchHandler({ sw: fakeSwitch(), version: '9.9.9' })(fakeBodyReq({ url: PANEL_ACTION_PATH, body: '{}' }), resNoAction)
    rec.add(G_L, '没接线执行器 ⇒ 503（不拿"空操作"冒充成功）', resNoAction.statusCode === 503, `status=${resNoAction.statusCode} body=${resNoAction.body}`)
    const resBiz = fakeRes()
    await createSwitchHandler({
      sw: fakeSwitch(),
      version: '9.9.9',
      panelAction: { async run() { return { ok: false, action: 'archive', task_id: 'T-1', error: NOT_TERMINAL_ERROR, code: 'NOT_TERMINAL' } } },
    })(fakeBodyReq({ url: PANEL_ACTION_PATH, body: JSON.stringify({ task_id: 'T-1', action: 'archive' }) }), resBiz)
    rec.add(G_L, '业务失败照旧 HTTP 200，正文 `{ok:false, error, code}`（客户端读 `ok`，不猜状态码）', resBiz.statusCode === 200 && JSON.parse(resBiz.body).ok === false && JSON.parse(resBiz.body).code === 'NOT_TERMINAL' && JSON.parse(resBiz.body).error === NOT_TERMINAL_ERROR, `status=${resBiz.statusCode} body=${resBiz.body}`)
    const tmpStore = fakeActionStore()
    const resE2E = fakeRes()
    await createSwitchHandler({
      sw: fakeSwitch(),
      version: '9.9.9',
      panelAction: createPanelActions({ store: tmpStore, sw: ACTION_SW_ON }),
    })(fakeBodyReq({ url: PANEL_ACTION_PATH, body: JSON.stringify({ task_id: 'T-9', action: 'archive' }) }), resE2E)
    rec.add(G_L, '真执行器 + 真路由：`archive` 落到 `purgeTask(mode:"trash")`', resE2E.statusCode === 200 && JSON.parse(resE2E.body).message === '已留档' && tmpStore.calls.at(-1)?.input.mode === 'trash' && tmpStore.calls.at(-1)?.input.taskId === 'T-9', resE2E.body)
    const resPanelAgain = fakeRes()
    await handler(fakeReq({ url: PANEL_PATH }), resPanelAgain)
    rec.add(G_L, '★ 新路由没有改变 `/panel`（仍 200、仍是那份只读快照）', resPanelAgain.statusCode === 200 && JSON.parse(resPanelAgain.body).ok === true && Array.isArray(JSON.parse(resPanelAgain.body).tasks), `status=${resPanelAgain.statusCode}`)

    // === M 归档视图 ========================================================
    const archiveRoot = newRoot('archive')
    makeArchiveFixture(archiveRoot)
    const arch = listArchived({ projectRoot: archiveRoot })
    const archByDir = (dir) => (arch.tasks ?? []).find((t) => t.dir === dir) ?? null
    rec.add(G_M, '归档目录名与 `purge.js` 的 `_trash` 是**同一个常量**（不另造字面量）', ARCHIVE_DIR_NAME === TRASH_DIR_NAME && ARCHIVE_DIR_NAME === '_trash', ARCHIVE_DIR_NAME)
    rec.add(G_M, '`listArchived` 不抛、`ok === true`', arch.ok === true, JSON.stringify(arch.warnings))
    rec.add(G_M, '只认 `_trash` 下的目录（普通文件跳过），坏单不进表 ⇒ 3 行', (arch.tasks ?? []).length === 3, JSON.stringify((arch.tasks ?? []).map((t) => t.dir)))
    rec.add(G_M, '坏 JSON / 缺 task.json **只进 warnings**（共 2 条，点名是哪个目录）', (arch.warnings ?? []).length === 2 && arch.warnings.some((w) => w.includes(`${ARCH_DIR_BAD}：task.json 不是合法 JSON`)) && arch.warnings.some((w) => w.includes(`${ARCH_DIR_NOFILE}：task.json 读不出来`)), JSON.stringify(arch.warnings))
    rec.add(G_M, '坏单**不出现**在归档列表里', (arch.tasks ?? []).every((t) => t.dir !== ARCH_DIR_BAD && t.dir !== ARCH_DIR_NOFILE), '')
    rec.add(G_M, '归档行字段与契约**逐个**对齐（6 个，顺序固定）', (arch.tasks ?? []).every((t) => JSON.stringify(Object.keys(t)) === JSON.stringify(['id', 'dir', 'state', 'state_label', 'requirement_snippet', 'archived_at'])), JSON.stringify(Object.keys((arch.tasks ?? [])[0] ?? {})))
    const keepArch = archByDir(ARCH_DIR_KEEP)
    rec.add(G_M, '`id` 从目录名**从右往左**剥掉 stamp（任务 id 自己也带短横线）', keepArch?.id === ARCH_KEEP && keepArch?.dir === ARCH_DIR_KEEP, JSON.stringify(keepArch))
    rec.add(G_M, '`archived_at` 从 stamp 解析（`-2026-10-18T042252Z` ⇒ `2026-10-18T04:22:52Z`）', keepArch?.archived_at === '2026-10-18T04:22:52Z', String(keepArch?.archived_at))
    rec.add(G_M, '`state_label` / `requirement_snippet` 与主视图**同一份判据**（复用快照纯函数）', keepArch?.state === 'closed' && keepArch?.state_label === '已关闭' && keepArch?.requirement_snippet === '归档单：一句话需求。', JSON.stringify(keepArch))
    const nostampArch = archByDir(ARCH_DIR_NOSTAMP)
    rec.add(G_M, '解析不出 stamp ⇒ 退回**目录 mtime**；`id` 退回 `task.json.id`', nostampArch?.archived_at === ARCH_NOSTAMP_MTIME && nostampArch?.id === ARCH_DIR_NOSTAMP, JSON.stringify(nostampArch))
    rec.add(G_M, '最近归档的在前（mtime 10-19 > stamp 10-18 > 10-17）', JSON.stringify((arch.tasks ?? []).map((t) => t.dir)) === JSON.stringify([ARCH_DIR_NOSTAMP, ARCH_DIR_KEEP, ARCH_DIR_OLD]), JSON.stringify((arch.tasks ?? []).map((t) => t.dir)))
    const emptyArchiveRoot = newRoot('archive-empty')
    mkdirSync(join(emptyArchiveRoot, '.pipeline'), { recursive: true })
    const emptyArch = listArchived({ projectRoot: emptyArchiveRoot })
    rec.add(G_M, '没有 `_trash` ⇒ `ok:true` + 空表（新 profile 不算错）', emptyArch.ok === true && emptyArch.tasks.length === 0 && emptyArch.warnings.length === 0, JSON.stringify(emptyArch))
    const badArch = listArchived({})
    rec.add(G_M, '没有 `projectRoot` ⇒ `ok:false` + 中文 error（照样不抛）', badArch.ok === false && CJK.test(String(badArch.error)) && Array.isArray(badArch.tasks), `error=${String(badArch.error)}`)
    const customArchiveRoot = newRoot('archive-custom')
    makeArchiveFixture(customArchiveRoot, '.pipe2')
    const customArch = listArchived({ projectRoot: customArchiveRoot, artifactDirName: '.pipe2' })
    rec.add(G_M, '`artifactDirName` 从入参来（不是硬编码 `.pipeline`）', customArch.ok === true && (customArch.tasks ?? []).some((t) => t.dir === ARCH_DIR_KEEP), JSON.stringify((customArch.tasks ?? []).map((t) => t.dir)))

    // === N 归档恢复 / 永久删除 =============================================
    const restoreRoot = newRoot('restore')
    const restoreBase = makeArchiveFixture(restoreRoot)
    const restoredOne = restoreArchived({ projectRoot: restoreRoot, dir: ARCH_DIR_KEEP })
    const restoredDir = join(restoreRoot, '.pipeline', ARCH_KEEP)
    rec.add(G_N, '`restoreArchived` 成功 ⇒ `{ok:true, task_id, restored_to}`', restoredOne.ok === true && restoredOne.task_id === ARCH_KEEP && restoredOne.restored_to === pathKey(restoredDir), JSON.stringify(restoredOne))
    rec.add(G_N, '恢复 = `renameSync`：盘上真挪回来了，`_trash` 里不再有它', existsSync(restoredDir) && !existsSync(join(restoreBase, ARCH_DIR_KEEP)), JSON.stringify({ restoredDir, inTrash: existsSync(join(restoreBase, ARCH_DIR_KEEP)) }))
    const traversals = ['../evil', '..', '../../etc', 'a/b', 'a\\b', 'C:x', '_trash/../x']
    const traversalOuts = traversals.map((dir) => restoreArchived({ projectRoot: restoreRoot, dir }))
    rec.add(G_N, '路径穿越 / 带分隔符 / `..` ⇒ 一律拒绝（7 种写法，一个都没挪）', traversalOuts.every((o) => o.ok === false && o.error.includes('不合法')) && !existsSync(join(restoreRoot, '.pipeline', 'evil')), JSON.stringify(traversalOuts.map((o) => o.error)))
    const missingArch = restoreArchived({ projectRoot: restoreRoot, dir: 'T-000000-nope-2026-10-18T000000Z' })
    rec.add(G_N, '归档目录不存在 ⇒ `ok:false` + 说清路径', missingArch.ok === false && missingArch.error.includes('找不到归档目录'), String(missingArch.error))
    mkdirSync(join(restoreRoot, '.pipeline', ARCH_OLD), { recursive: true })
    const clashArch = restoreArchived({ projectRoot: restoreRoot, dir: ARCH_DIR_OLD })
    rec.add(G_N, '目标 `<任务id>` 已存在 ⇒ **拒绝覆盖**（在跑的单绝不被覆盖）', clashArch.ok === false && clashArch.error.includes('目标目录已存在'), String(clashArch.error))
    const noConfirmDel = deleteArchived({ projectRoot: restoreRoot, dir: ARCH_DIR_OLD })
    rec.add(G_N, '`deleteArchived` 无 confirm ⇒ 拒绝，目录还在', noConfirmDel.ok === false && noConfirmDel.error === DELETE_ARCHIVED_CONFIRM_ERROR && existsSync(join(restoreBase, ARCH_DIR_OLD)), JSON.stringify(noConfirmDel))
    const strConfirmDel = deleteArchived({ projectRoot: restoreRoot, dir: ARCH_DIR_OLD, confirm: 'true' })
    rec.add(G_N, '确认必须**严格** `true`（字符串 `"true"` 不算）', strConfirmDel.ok === false && strConfirmDel.error === DELETE_ARCHIVED_CONFIRM_ERROR, JSON.stringify(strConfirmDel))
    const traversalDel = deleteArchived({ projectRoot: restoreRoot, dir: '../x', confirm: true })
    rec.add(G_N, '永久删除同样挡穿越（confirm 过了也不许出 `_trash`）', traversalDel.ok === false && traversalDel.error.includes('不合法'), String(traversalDel.error))
    const deletedArch = deleteArchived({ projectRoot: restoreRoot, dir: ARCH_DIR_OLD, confirm: true })
    rec.add(G_N, '确认后真删：`{ok:true, task_id, deleted:true}`，目录没了', deletedArch.ok === true && deletedArch.task_id === ARCH_OLD && deletedArch.deleted === true && !existsSync(join(restoreBase, ARCH_DIR_OLD)), JSON.stringify(deletedArch))
    const purgeLogPath = join(restoreRoot, '.pipeline', PURGE_LOG_NAME)
    let tombstone = null
    try {
      tombstone = JSON.parse(readFileSync(purgeLogPath, 'utf8').trim().split('\n').at(-1))
    } catch {
      tombstone = null
    }
    rec.add(G_N, '墓碑落在 `_purge-log.jsonl`（与 `purge.js` **同一个账本 / 文件名常量**）', tombstone !== null && tombstone.task_id === ARCH_OLD && tombstone.mode === 'delete-archived' && tombstone.by === 'human' && tombstone.reason === DELETE_ARCHIVED_REASON && typeof tombstone.at === 'string', JSON.stringify(tombstone))
    rec.add(G_N, '先留痕后动手：删完账还在一行一条', readFileSync(purgeLogPath, 'utf8').trim().split('\n').length === 1, readFileSync(purgeLogPath, 'utf8').trim())

    // === O 置顶（pins.js）==================================================
    const pinsRoot = newRoot('pins')
    const pinsPath = join(pinsRoot, '.pipeline', PINS_FILE_NAME)
    rec.add(G_O, '没有置顶文件 ⇒ 空表（没置顶过是常态，不是错）', JSON.stringify(readPins(pinsRoot, '.pipeline')) === '[]' && isPinned(pinsRoot, '.pipeline', 'T-1') === false, '')
    const pinOn = setPinned(pinsRoot, '.pipeline', 'T-1', true)
    let pinsDoc = null
    try {
      pinsDoc = JSON.parse(readFileSync(pinsPath, 'utf8'))
    } catch {
      pinsDoc = null
    }
    rec.add(G_O, '`setPinned(true)` ⇒ `{ok:true, pinned:true, ids:["T-1"]}` 并落盘 `{version:1, ids}`', pinOn.ok === true && pinOn.pinned === true && JSON.stringify(pinOn.ids) === JSON.stringify(['T-1']) && pinsDoc?.version === 1 && JSON.stringify(pinsDoc?.ids) === JSON.stringify(['T-1']), JSON.stringify({ pinOn, pinsDoc }))
    rec.add(G_O, '`pinsFileOf` 指的就是 `<项目根>/<artifactDirName>/_panel-pins.json`', pinsFileOf(pinsRoot, '.pipeline') === pinsPath && PINS_FILE_NAME === '_panel-pins.json', pinsPath)
    rec.add(G_O, '持久化：换一次调用仍读得到（不是内存态）', JSON.stringify(readPins(pinsRoot, '.pipeline')) === JSON.stringify(['T-1']) && isPinned(pinsRoot, '.pipeline', 'T-1') === true, '')
    const pinAgain = setPinned(pinsRoot, '.pipeline', 'T-1', true)
    rec.add(G_O, '重复置顶幂等（不产生第二条）', pinAgain.ok === true && JSON.stringify(pinAgain.ids) === JSON.stringify(['T-1']), JSON.stringify(pinAgain))
    rec.add(G_O, '原子写：`tmp + rename` 之后没有残留 `.tmp`', existsSync(`${pinsPath}.tmp`) === false, '')
    const pinOff = setPinned(pinsRoot, '.pipeline', 'T-1', false)
    rec.add(G_O, '`setPinned(false)` ⇒ 取消置顶、落盘为空表', pinOff.ok === true && pinOff.pinned === false && JSON.stringify(readPins(pinsRoot, '.pipeline')) === '[]' && isPinned(pinsRoot, '.pipeline', 'T-1') === false, JSON.stringify(pinOff))
    const badPinsRoot = newRoot('pins-bad')
    mkdirSync(join(badPinsRoot, '.pipeline'), { recursive: true })
    const badPinsPath = join(badPinsRoot, '.pipeline', PINS_FILE_NAME)
    writeFileSync(badPinsPath, '{ 这不是 JSON', 'utf8')
    rec.add(G_O, '坏文件 ⇒ 当空表，**不抛**', JSON.stringify(readPins(badPinsRoot, '.pipeline')) === '[]' && isPinned(badPinsRoot, '.pipeline', 'T-1') === false, '')
    const rewritePins = setPinned(badPinsRoot, '.pipeline', 'T-2', true)
    rec.add(G_O, '坏文件之后仍能正常置顶（覆盖写回合法 JSON）', rewritePins.ok === true && JSON.stringify(readPins(badPinsRoot, '.pipeline')) === JSON.stringify(['T-2']), JSON.stringify(rewritePins))
    writeFileSync(badPinsPath, JSON.stringify({ version: 1, ids: 'T-3' }), 'utf8')
    rec.add(G_O, '`ids` 不是数组 ⇒ 当空表（形状不对不算置顶）', JSON.stringify(readPins(badPinsRoot, '.pipeline')) === '[]', readFileSync(badPinsPath, 'utf8'))
    writeFileSync(badPinsPath, JSON.stringify(['T-4']), 'utf8')
    rec.add(G_O, '裸数组（不是 `{version, ids}` 形状）也当坏文件 ⇒ 空表', JSON.stringify(readPins(badPinsRoot, '.pipeline')) === '[]', readFileSync(badPinsPath, 'utf8'))
    rec.add(G_O, '没有项目根 ⇒ `ok:false` + 中文原因（不写盘、不抛）', setPinned('', '.pipeline', 'T-1', true).ok === false && readPins('', '.pipeline').length === 0, '')
    const capPinsRoot = newRoot('pins-cap')
    mkdirSync(join(capPinsRoot, '.pipeline'), { recursive: true })
    writeFileSync(join(capPinsRoot, '.pipeline', PINS_FILE_NAME), JSON.stringify({ version: 1, ids: Array.from({ length: PINS_MAX + 5 }, (_, i) => `T-${i}`) }), 'utf8')
    const overflow = setPinned(capPinsRoot, '.pipeline', 'T-extra', true)
    rec.add(G_O, `上限 ${PINS_MAX} 条：读时夹住，写满后**明说满了**（不悄悄丢掉刚点的那颗星）`, PINS_MAX === 200 && readPins(capPinsRoot, '.pipeline').length === PINS_MAX && overflow.ok === false && overflow.error.includes('上限'), JSON.stringify(overflow))

    // === P 快照：pinned 字段与置顶排序 ====================================
    rec.add(G_P, '没置顶过的任务 ⇒ `pinned:false`（主夹具里一个置顶都没写）', (snap?.tasks ?? []).length > 0 && (snap?.tasks ?? []).every((t) => t.pinned === false), JSON.stringify((snap?.tasks ?? []).map((t) => `${t.id}:${String(t.pinned)}`)))
    const pinSnapRoot = newRoot('snapshot-pins')
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
    const badPinSnapRoot = newRoot('snapshot-badpins')
    mkdirSync(join(badPinSnapRoot, '.pipeline', 'T-1'), { recursive: true })
    writeFileSync(join(badPinSnapRoot, '.pipeline', 'T-1', 'task.json'), JSON.stringify({ id: 'T-1', state: 'closed' }), 'utf8')
    writeFileSync(join(badPinSnapRoot, '.pipeline', PINS_FILE_NAME), 'not json at all', 'utf8')
    const badPinSnap = buildPanelSnapshot({ projectRoot: badPinSnapRoot })
    rec.add(G_P, '置顶文件坏了 ⇒ 快照照常出（按"没有置顶"降级，不 500）', badPinSnap.ok === true && badPinSnap.tasks.length === 1 && badPinSnap.tasks[0].pinned === false, JSON.stringify(badPinSnap))

    // === Q 新动作（pin/unpin/unarchive/delete_archived）=====================
    {
      const pinCalls = []
      const fakePins = {
        setPinned: (...args) => {
          pinCalls.push(args)
          return { ok: true, pinned: args[3] === true, ids: [args[2]] }
        },
      }
      const run = createPanelActions({ store: fakeActionStore(), sw: ACTION_SW_ON, projectRoot: '/proj/root', pins: fakePins })
      const pinnedOut = await run.run({ task_id: 'T-1', action: 'pin' })
      rec.add(G_Q, '`pin` ⇒ `setPinned(项目根, 工作区目录名, 任务id, true)`，message「已置顶」', pinnedOut.ok === true && pinnedOut.message === PIN_ON_MESSAGE && JSON.stringify(pinCalls.at(-1)) === JSON.stringify(['/proj/root', '.pipeline', 'T-1', true]), JSON.stringify({ pinnedOut, pinCalls }))
      const unpinnedOut = await run.run({ task_id: 'T-1', action: 'unpin' })
      rec.add(G_Q, '`unpin` ⇒ 同一个入口、`on=false`，message「已取消置顶」', unpinnedOut.ok === true && unpinnedOut.message === PIN_OFF_MESSAGE && JSON.stringify(pinCalls.at(-1)) === JSON.stringify(['/proj/root', '.pipeline', 'T-1', false]), JSON.stringify({ unpinnedOut, pinCalls }))
      const callsBeforeNoId = pinCalls.length
      const noIdOut = await run.run({ action: 'pin' })
      rec.add(G_Q, '缺 `task_id` ⇒ 中文拒绝（不写一个空 id、不碰 pins）', noIdOut.ok === false && CJK.test(noIdOut.error) && pinCalls.length === callsBeforeNoId, JSON.stringify(noIdOut))
      const failedPin = await createPanelActions({
        store: fakeActionStore(), sw: ACTION_SW_ON, projectRoot: '/proj',
        pins: { setPinned: () => ({ ok: false, error: '置顶写不进去：EACCES 拒绝访问' }) },
      }).run({ task_id: 'T-1', action: 'pin' })
      rec.add(G_Q, 'pins 拒绝 ⇒ 原样透出（绝不粉饰成"已置顶"）', failedPin.ok === false && failedPin.error === '置顶写不进去：EACCES 拒绝访问' && failedPin.action === 'pin' && failedPin.task_id === 'T-1', JSON.stringify(failedPin))
      const noPinsOut = await createPanelActions({ store: fakeActionStore(), sw: ACTION_SW_ON, projectRoot: '/proj', pins: {} }).run({ task_id: 'T-1', action: 'pin' })
      rec.add(G_Q, 'pins 没这套方法 ⇒ `STORE_UNAVAILABLE`（点名 setPinned）', noPinsOut.code === 'STORE_UNAVAILABLE' && noPinsOut.error.includes('setPinned'), JSON.stringify(noPinsOut))
      const noRootOut = await createPanelActions({ store: fakeActionStore(), sw: ACTION_SW_ON }).run({ task_id: 'T-1', action: 'pin' })
      rec.add(G_Q, '没接线项目根 ⇒ 明说"未接线"（不猜目录、不写盘）', noRootOut.ok === false && noRootOut.code === 'STORE_UNAVAILABLE' && noRootOut.error.includes('项目根'), JSON.stringify(noRootOut))
    }
    {
      const archCalls = []
      const fakeArchive = {
        restoreArchived: (input) => {
          archCalls.push({ method: 'restoreArchived', input })
          return { ok: true, task_id: 'T-x', restored_to: '/p/T-x' }
        },
        deleteArchived: (input) => {
          archCalls.push({ method: 'deleteArchived', input })
          return { ok: true, task_id: 'T-x', deleted: true }
        },
      }
      const run = createPanelActions({ store: fakeActionStore(), sw: ACTION_SW_ON, projectRoot: '/proj', artifactDirName: '.pipe9', archive: fakeArchive })
      const unarchivedOut = await run.run({ task_id: 'T-x-2026-10-18T000000Z', action: 'unarchive' })
      rec.add(G_Q, '`unarchive` ⇒ `restoreArchived({projectRoot, artifactDirName, dir})`，`task_id` 就是归档目录名', unarchivedOut.ok === true && unarchivedOut.message === UNARCHIVE_MESSAGE && JSON.stringify(archCalls.at(-1)) === JSON.stringify({ method: 'restoreArchived', input: { projectRoot: '/proj', artifactDirName: '.pipe9', dir: 'T-x-2026-10-18T000000Z' } }), JSON.stringify({ unarchivedOut, archCalls }))
      const noConfirmOut = await run.run({ task_id: 'T-x-2026-10-18T000000Z', action: 'delete_archived' })
      rec.add(G_Q, '`delete_archived` 缺 confirm ⇒ 被拒，且**一次都没调** archive', noConfirmOut.ok === false && noConfirmOut.error === DELETE_CONFIRM_ERROR && archCalls.length === 1, JSON.stringify(noConfirmOut))
      const deletedOut = await run.run({ task_id: 'T-x-2026-10-18T000000Z', action: 'delete_archived', confirm: true })
      rec.add(G_Q, '`delete_archived` + confirm ⇒ `deleteArchived({..., confirm:true})`，message「已永久删除」', deletedOut.ok === true && deletedOut.message === DELETE_ARCHIVED_MESSAGE && JSON.stringify(archCalls.at(-1)) === JSON.stringify({ method: 'deleteArchived', input: { projectRoot: '/proj', artifactDirName: '.pipe9', dir: 'T-x-2026-10-18T000000Z', confirm: true } }), JSON.stringify({ deletedOut, call: archCalls.at(-1) }))
      const failing = createPanelActions({
        store: fakeActionStore(), sw: ACTION_SW_ON, projectRoot: '/proj',
        archive: {
          restoreArchived: () => ({ ok: false, error: '目标目录已存在，不覆盖：x' }),
          deleteArchived: () => ({ ok: false, error: '墓碑账本写不进去' }),
        },
      })
      const failedUn = await failing.run({ task_id: 'd1', action: 'unarchive' })
      const failedDel = await failing.run({ task_id: 'd2', action: 'delete_archived', confirm: true })
      rec.add(G_Q, '归档两个动作的拒绝也**原样透出**（`code` 有才带）', failedUn.ok === false && failedUn.error === '目标目录已存在，不覆盖：x' && failedDel.ok === false && failedDel.error === '墓碑账本写不进去' && failedUn.code === undefined, JSON.stringify({ failedUn, failedDel }))
      const throwing = createPanelActions({
        store: fakeActionStore(), sw: ACTION_SW_ON, projectRoot: '/proj',
        archive: { restoreArchived: () => { throw new Error('磁盘掉了') } },
      })
      const threwOut = await throwing.run({ task_id: 'd1', action: 'unarchive' })
      rec.add(G_Q, '归档实现抛异常 ⇒ 归一成 `ok:false` + code，**不抛**', threwOut.ok === false && threwOut.code === 'PANEL_ACTION_FAILED' && threwOut.error.includes('磁盘掉了'), JSON.stringify(threwOut))
      const offStore = fakeActionStore()
      const offRun = createPanelActions({
        store: offStore,
        sw: ACTION_SW_OFF,
        projectRoot: '/proj',
        pins: { setPinned: () => { throw new Error('开关关着 ⇒ 不该被调到') } },
        archive: {
          restoreArchived: () => { throw new Error('开关关着 ⇒ 不该被调到') },
          deleteArchived: () => { throw new Error('开关关着 ⇒ 不该被调到') },
        },
      })
      const offOuts = []
      for (const action of ['pin', 'unpin', 'unarchive', 'delete_archived']) offOuts.push(await offRun.run({ task_id: 'T-1', action, confirm: true }))
      rec.add(G_Q, '开关关 ⇒ 四个新动作一律被拒（pins / archive 一次都没被调到）', offOuts.every((o) => o.ok === false && o.error === SWITCH_OFF_ERROR) && offStore.calls.length === 0, JSON.stringify(offOuts))
    }
    {
      // ★ 真执行器 + 真目录：置顶 / 恢复归档 / 永久删除各走一遍完整链路
      const e2eRoot = newRoot('actions-e2e')
      const e2ePipeline = join(e2eRoot, '.pipeline')
      const e2eTaskDir = join(e2ePipeline, 'T-20261023-e2e1')
      mkdirSync(e2eTaskDir, { recursive: true })
      writeFileSync(join(e2eTaskDir, 'task.json'), JSON.stringify({ id: 'T-20261023-e2e1', state: 'closed', requirement: '端到端夹具' }), 'utf8')
      const run = createPanelActions({ store: fakeActionStore(), sw: ACTION_SW_ON, projectRoot: e2eRoot })
      const pinOut = await run.run({ task_id: 'T-20261023-e2e1', action: 'pin' })
      rec.add(G_Q, '★ 真置顶落到 `<项目根>/.pipeline/_panel-pins.json`（不是内存态）', pinOut.ok === true && isPinned(e2eRoot, '.pipeline', 'T-20261023-e2e1') === true, JSON.stringify({ pinOut, pins: readPins(e2eRoot, '.pipeline') }))
      const e2eArchDir = join(e2ePipeline, TRASH_DIR_NAME, 'T-20261024-e2e2-2026-10-18T060000Z')
      mkdirSync(e2eArchDir, { recursive: true })
      writeFileSync(join(e2eArchDir, 'task.json'), JSON.stringify({ id: 'T-20261024-e2e2', state: 'closed' }), 'utf8')
      const unarchiveOut = await run.run({ task_id: 'T-20261024-e2e2-2026-10-18T060000Z', action: 'unarchive' })
      rec.add(G_Q, '★ 真恢复归档：`_trash/<id>-<stamp>` 挪回 `<id>`（面板与盘上一致）', unarchiveOut.ok === true && unarchiveOut.message === UNARCHIVE_MESSAGE && existsSync(join(e2ePipeline, 'T-20261024-e2e2')) && !existsSync(e2eArchDir), JSON.stringify(unarchiveOut))
      const e2eArchDir2 = join(e2ePipeline, TRASH_DIR_NAME, 'T-20261025-e2e3-2026-10-18T070000Z')
      mkdirSync(e2eArchDir2, { recursive: true })
      writeFileSync(join(e2eArchDir2, 'task.json'), JSON.stringify({ id: 'T-20261025-e2e3', state: 'cancelled' }), 'utf8')
      const deleteOut = await run.run({ task_id: 'T-20261025-e2e3-2026-10-18T070000Z', action: 'delete_archived', confirm: true })
      let e2eTombstone = null
      try {
        e2eTombstone = JSON.parse(readFileSync(join(e2ePipeline, PURGE_LOG_NAME), 'utf8').trim().split('\n').at(-1))
      } catch {
        e2eTombstone = null
      }
      rec.add(G_Q, '★ 真永久删除：目录没了、墓碑进 `_purge-log.jsonl`', deleteOut.ok === true && deleteOut.message === DELETE_ARCHIVED_MESSAGE && !existsSync(e2eArchDir2) && e2eTombstone?.mode === 'delete-archived' && e2eTombstone?.task_id === 'T-20261025-e2e3', JSON.stringify({ deleteOut, e2eTombstone }))
    }
    {
      // 路由：`?view=archived` 与其它 query 的分流（含没接线 / 数据源抛异常）
      const archiveHandler = createSwitchHandler({
        sw: fakeSwitch(),
        version: '9.9.9',
        panel: () => buildPanelSnapshot({ projectRoot: archiveRoot }),
        panelArchived: () => listArchived({ projectRoot: archiveRoot }),
      })
      rec.add(G_Q, '`PANEL_ARCHIVED_VIEW` = `archived`（客户端按这个值传 query）', PANEL_ARCHIVED_VIEW === 'archived', PANEL_ARCHIVED_VIEW)
      const resArchived = fakeRes()
      await archiveHandler(fakeReq({ url: `${PANEL_PATH}?view=archived` }), resArchived)
      const archivedBody = JSON.parse(resArchived.body)
      rec.add(G_Q, '`GET /panel?view=archived` ⇒ 200 + 归档视图（`tasks` 来自 `_trash`）', resArchived.statusCode === 200 && archivedBody.ok === true && Array.isArray(archivedBody.tasks) && archivedBody.tasks.some((t) => t.dir === ARCH_DIR_KEEP), `status=${resArchived.statusCode} body=${resArchived.body.slice(0, 120)}`)
      rec.add(G_Q, '归档视图同样 `application/json` + `no-store`', String(resArchived.headers?.['content-type'] ?? '').startsWith('application/json') && resArchived.headers?.['cache-control'] === 'no-store', JSON.stringify(resArchived.headers))
      const resOtherQuery = fakeRes()
      await archiveHandler(fakeReq({ url: `${PANEL_PATH}?view=whatever` }), resOtherQuery)
      const otherQueryBody = JSON.parse(resOtherQuery.body)
      rec.add(G_Q, '其它 query 仍走**主快照**（有 `generated_at`、每行有 `pinned`）', resOtherQuery.statusCode === 200 && typeof otherQueryBody.generated_at === 'string' && Array.isArray(otherQueryBody.tasks) && otherQueryBody.tasks.every((t) => typeof t.pinned === 'boolean'), `status=${resOtherQuery.statusCode} body=${resOtherQuery.body.slice(0, 120)}`)
      const resNoArchProvider = fakeRes()
      await createSwitchHandler({ sw: fakeSwitch(), version: '9.9.9', panel: () => buildPanelSnapshot({ projectRoot: archiveRoot }) })(fakeReq({ url: `${PANEL_PATH}?view=archived` }), resNoArchProvider)
      rec.add(G_Q, '归档视图没接线 ⇒ 503（不拿主快照冒充归档）', resNoArchProvider.statusCode === 503, `status=${resNoArchProvider.statusCode} body=${resNoArchProvider.body}`)
      const resArchThrew = fakeRes()
      await createSwitchHandler({ sw: fakeSwitch(), version: '9.9.9', panelArchived: () => { throw new Error('读盘炸了') } })(fakeReq({ url: `${PANEL_PATH}?view=archived` }), resArchThrew)
      rec.add(G_Q, '归档数据源抛异常 ⇒ 500（不让整个路由层炸）', resArchThrew.statusCode === 500, `status=${resArchThrew.statusCode}`)
      const paNew = fakePanelAction()
      const newActionHandler = createSwitchHandler({ sw: fakeSwitch(), version: '9.9.9', panelAction: paNew })
      const resPinAction = fakeRes()
      await newActionHandler(fakeBodyReq({ url: PANEL_ACTION_PATH, body: JSON.stringify({ task_id: 'T-1', action: 'pin' }) }), resPinAction)
      rec.add(G_Q, '`POST /panel/action` 接受新动作（路由层不判白名单，原样递参）', resPinAction.statusCode === 200 && JSON.stringify(paNew.calls.at(-1)) === JSON.stringify({ task_id: 'T-1', action: 'pin', confirm: false }), JSON.stringify(paNew.calls))
      const resDelAction = fakeRes()
      await newActionHandler(fakeBodyReq({ url: PANEL_ACTION_PATH, body: JSON.stringify({ task_id: 'T-9-2026-10-18T060000Z', action: 'delete_archived', confirm: true }) }), resDelAction)
      rec.add(G_Q, '`delete_archived` 的 `confirm:true` 也照样透传（不被路由层吞掉）', resDelAction.statusCode === 200 && paNew.calls.at(-1)?.confirm === true && paNew.calls.at(-1)?.action === 'delete_archived', JSON.stringify(paNew.calls.at(-1)))
    }

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
    for (const dir of extraRoots) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 同上 */
      }
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
