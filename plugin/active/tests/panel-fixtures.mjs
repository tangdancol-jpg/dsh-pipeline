// 自建面板两条自测的**共享夹具**（不是测试：没有断言，所以刻意**不登记**进 `tests/registry.mjs`）。
/**
 * dsh-pipeline · 自建面板自测夹具
 * ============================================================================
 * 为什么单独一个文件：原 `tests/panel-check.mjs` 已 962 行，超出 `CONVENTIONS.md`
 * 「单个测试文件 ≤ 400 行」⇒ 按语义拆成两条，各测一件事：
 *   · 快照 / 契约（任务行字段、键序、tier、席位合并、排序、pins 读、坏文件降级、
 *     GET `/panel` 与 `?view=archived` 分流） ⇒ `tests/panel-snapshot-check.mjs`
 *   · 动作 / 执行器 / 归档 / 路由 POST（allowed_actions、参数透传、confirm 闸、
 *     `_trash` 列表/恢复/永久删除、pins 写、`POST /panel/action`） ⇒ `tests/panel-actions-check.mjs`
 * 两条共用的记录器、任务夹具、假 req/res、假 store、归档夹具与临时目录 scope 放这里，
 * 免得各抄一份（抄两份 = 两处会漂移的判据）。
 * 同一形状的先例：`tests/switch-fixtures.mjs`、`tests/wake-no-main-fixtures.mjs`。
 *
 * ★ 本文件**不含任何断言** —— 断言全在上面那两个 `*-check.mjs` 里。
 *
 * @module dsh-pipeline/tests/panel-fixtures
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { TRASH_DIR_NAME } from '../lib/store/purge.js'

/** 中文断言用（"错误文案必须是中文"这类判据）。 */
export const CJK = /[\u4e00-\u9fa5]/

// ---------------------------------------------------------------------------
// 记录器与直接运行入口（两条测试同形）
// ---------------------------------------------------------------------------

export function createRecorder() {
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
  }
}

/** 把一条测试的结论渲染成统一形状（沿用拆分前那套输出格式）。 */
export function renderReport(title, rec) {
  const L = [title, '='.repeat(78)]
  let g = ''
  for (const it of rec.items) {
    if (it.group !== g) {
      g = it.group
      L.push('', `【${g}】`)
    }
    L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
    if (it.detail.length > 0) L.push(`      ${it.detail.split('\n').join('\n      ')}`)
  }
  L.push('', '='.repeat(78), `总计：${rec.passed}/${rec.total} 通过`, '='.repeat(78))
  return { passed: rec.passed, total: rec.total, text: L.join('\n') }
}

/**
 * 直接 `node tests/xxx-check.mjs` 时的收尾（打印报告 + 退出码 = 结论）。
 *
 * ★ `metaUrl` **必须传调用方自己的** `import.meta.url`：本函数住在夹具文件里，
 *   拿夹具文件的 URL 去比 `process.argv[1]` 永远不相等 ⇒ 直接跑会一声不响什么都不做。
 */
export function runDirect(run, metaUrl) {
  if (process.argv[1] === undefined || metaUrl !== pathToFileURL(process.argv[1]).href) return
  run()
    .then((r) => {
      console.log(r.text)
      if (r.passed !== r.total) process.exitCode = 1
    })
    .catch((err) => {
      console.error('[panel] 内部异常（这是用例自身的 bug，请修用例）：', err)
      process.exitCode = 1
    })
}

// ---------------------------------------------------------------------------
// 临时目录 scope：每条测试自己一份，`cleanup()` 只清**本 scope** 建的那些。
// ---------------------------------------------------------------------------

export function makeTempRoots(prefix) {
  const roots = []
  const newRoot = (tag) => {
    const dir = mkdtempSync(join(tmpdir(), `dsh-pipeline-panel-${tag}-`))
    roots.push(dir)
    return dir
  }
  const root = newRoot(prefix)
  return {
    root,
    newRoot,
    cleanup() {
      for (const dir of roots) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* 临时目录清不掉不影响结论 */
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 主夹具：3 个 `T-*` 目录（1 正常新版 / 1 正常旧版 / 1 坏 JSON）+ 1 个没有
// task.json + 1 个不该被看的目录 + 1 个"前缀对但是文件"。
// ---------------------------------------------------------------------------

export const NEWER = 'T-20261018-aaa'
export const OLDER = 'T-20261017-bbb'
export const BAD = 'T-20261018-bad'
export const NOFILE = 'T-20261016-nofile'
/** 夹具里的"正文"标记：面板输出里**绝不允许**出现它。 */
export const HANDOFF_SECRET = '★交接物正文不该出现在面板里★'

export const NEWER_REQUIREMENT =
  '实现自建流水线面板的数据面：\n\n 宿主只读 HTTP 路由 + 快照构建 + 单元测试。' +
  '要求面板显示任务列表、席位、当前会话身份与人工待办数；\n  只读取不写任何任务数据；不要包含交接物正文、补丁或代码。'

export function newerTask() {
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

export function olderTask() {
  return {
    id: OLDER,
    state: 'closed',
    updated_at: '2026-10-17T10:00:00Z',
    requirement: '旧单：一句话需求。',
    roster: { execution_roles: ['writer'], writers: { count: 1, partitions: [{ seat: 'writer#1', role_id: 'writer', layer: 'all', scope_paths: ['.'] }] } },
  }
}

/** 造主夹具（返回 `.pipeline` 目录路径）。 */
export function makeFixture(root) {
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

// ---------------------------------------------------------------------------
// 路由夹具（假 req / res，足够喂真 handler）
// ---------------------------------------------------------------------------

export function fakeRes() {
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

export function fakeReq({ method = 'GET', url = '/', headers = {} } = {}) {
  return { method, url, headers, socket: { remoteAddress: '127.0.0.1' } }
}

export function fakeSwitch() {
  const snap = { since: '2026-10-18T00:00:00Z', by: 'fixture', revision: 3 }
  return { isOn: () => true, snapshot: () => snap, stateFile: '/tmp/fixture-switch.json' }
}

/** 带请求体的假 req（`readBody` 走 data/end 事件；这里在挂上 end 监听之后下一拍再灌）。 */
export function fakeBodyReq({ method = 'POST', url = '/', headers = {}, body = '' } = {}) {
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

/** 假执行器：只记录入参（`POST /panel/action` 的路由层判据用它）。 */
export function fakePanelAction() {
  const calls = []
  return {
    calls,
    async run(input) {
      calls.push(input)
      return { ok: true, action: input.action, task_id: input.task_id, message: '已终止：cancelled' }
    },
  }
}

/** 假 store：只记录入参（**不碰任何真实目录**），可注入返回值 / 抛异常。 */
export function fakeActionStore({ purgeResult = null, transitionResult = null, throwOn = null } = {}) {
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

/** 读一个 JSON 文件（文件不在 / 不是合法 JSON ⇒ `null`，不抛）。 */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** `_purge-log.jsonl` 这类账本的**最后一行 JSON**（读不出来 ⇒ `null`，不抛）。 */
export function lastJsonLine(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 归档 / 置顶夹具（全部在临时目录里自造，**不读任何活体真单**）
// ---------------------------------------------------------------------------

export const ARCH_KEEP = 'T-20261015-bb30bc'
export const ARCH_OLD = 'T-20261016-cc11aa'
export const ARCH_BAD = 'T-20261018-bad'
export const ARCH_NOFILE = 'T-20261016-nofile'
/** `_trash` 里的目录名：`<任务id>-<stamp>`（stamp 是 purge 的 `nowIso().replace(/[:]/g,'')`）。 */
export const ARCH_DIR_KEEP = `${ARCH_KEEP}-2026-10-18T042252Z`
export const ARCH_DIR_OLD = `${ARCH_OLD}-2026-10-17T010203Z`
export const ARCH_DIR_BAD = `${ARCH_BAD}-2026-10-18T050000Z`
export const ARCH_DIR_NOFILE = `${ARCH_NOFILE}-2026-10-18T051500Z`
/** 老格式：目录名里没有 stamp ⇒ `archived_at` 退回目录 mtime。 */
export const ARCH_DIR_NOSTAMP = 'T-20261019-nostamp'
export const ARCH_NOSTAMP_MTIME = '2026-10-19T00:00:00Z'

/**
 * 造归档夹具：2 张好单 + 1 张坏 JSON + 1 个没有 task.json + 1 个没有 stamp 的老目录
 * + 1 个不该被当成归档的普通文件。
 */
export function makeArchiveFixture(root, dirName = '.pipeline') {
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
