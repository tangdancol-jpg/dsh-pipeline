/**
 * dsh-pipeline · WP-B 自测：**pipeline 任务 ↔ 官方 Team 任务板镜像**
 * ============================================================================
 * 跑法：`node tests/team-board-check.mjs`（单跑）或由 `tests/run-all.mjs` 统一调用。
 *
 * 这套盯的是 01 §D10 / 02 §4 的**镜像面**，判据逐条对应验收第 8 条：
 *   ① 开单 → `createTask`；② 派活 → `updateTask(action:'reassign')`（revision CAS）；
 *   ③ 关单/取消 → `updateTask(action:'complete')`；④ CAS 冲突**重读一次、重试一次**；
 *   ⑤ 服务缺失 / `teamBoard:'off'` ⇒ `skipped` 且**不抛**；⑥ 失败只 audit、**绝不改
 *   流水线主流程的 ok**。
 *
 * ★ 全程零副作用：不建会话、不连服务；官方 TeamService 用本地替身（按源码核对过的
 *   状态机实现：claim 任何成员可领、reassign 仅 lead、complete 只从 in_progress）。
 *
 * @module dsh-pipeline/tests/team-board-check
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BOARD_FILE_NAME,
  boardEnvFromStore,
  installBoardHost,
  installedBoardHost,
  mirrorClose,
  mirrorDispatch,
  mirrorOpen,
  readBoardState,
  teamBoardPath,
  writeScopesOf,
} from '../lib/team/board.js'
import { createTaskStore } from '../lib/store.js'

/** 造一个官方 TeamService 替身（行为按 `teamservice.txt` 的状态机核对过）。 */
function fakeTeamHost(opts = {}) {
  const calls = { createTask: [], updateTask: [], getTask: [] }
  const tasks = new Map()
  const lead = { id: 'agent-lead' }
  let seq = 0

  const viewOf = (task) => ({
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    writeScopes: [...task.writeScopes],
    ...(task.ownerName === undefined ? {} : { ownerName: task.ownerName }),
  })
  const teamError = (message, code) => Object.assign(new Error(message), { code })

  const service = {
    async createTask(caller, request) {
      calls.createTask.push({ caller, request: { ...request } })
      if (opts.createThrows === true) throw teamError('createTask denied (fake)', 'TEAM_TEST_DENIED')
      seq += 1
      const task = { id: `task-${seq}`, revision: 1, subject: request.subject, description: request.description, writeScopes: [...(request.writeScopes ?? [])], status: 'pending', ownerId: undefined, ownerName: undefined }
      tasks.set(task.id, task)
      return viewOf(task)
    },
    async updateTask(caller, request) {
      calls.updateTask.push({ caller, request: { ...request } })
      if (opts.updateThrows === true) throw teamError('updateTask denied (fake)', 'TEAM_TEST_DENIED')
      const task = tasks.get(request.taskId)
      if (task === undefined) throw teamError(`team task "${request.taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
      // 模拟"别处先推了一版"：第一次调用直接判 stale（官方文案照抄）。
      if (opts.staleFirst === true && calls.updateTask.length === 1) {
        task.revision += 1
        throw teamError(`stale team task "${task.id}" revision ${request.expectedRevision}; current revision is ${task.revision}`, 'TEAM_TASK_STALE_REVISION')
      }
      if (request.expectedRevision !== task.revision) {
        throw teamError(`stale team task "${task.id}" revision ${request.expectedRevision}; current revision is ${task.revision}`, 'TEAM_TASK_STALE_REVISION')
      }
      if (request.action === 'claim') {
        if (task.ownerId !== undefined && task.ownerId !== caller.id) throw teamError(`team task "${task.id}" is owned by another member`, 'TEAM_TASK_ALREADY_CLAIMED')
        if (task.status !== 'pending') throw teamError(`team task "${task.id}" is not ready to claim`, 'TEAM_TASK_BLOCKED')
        task.status = 'in_progress'
        task.ownerId = caller.id
        task.ownerName = 'lead'
      } else if (request.action === 'reassign') {
        if (task.status !== 'pending' && task.status !== 'in_progress') throw teamError(`only a pending or in-progress task can be reassigned`, 'TEAM_TASK_INVALID_TRANSITION')
        task.status = 'in_progress'
        task.ownerName = request.owner
      } else if (request.action === 'complete') {
        // ★ 官方事实：complete 只接受 in_progress（不是"任意非终态"）。
        if (task.status !== 'in_progress') throw teamError('only an in-progress task can complete', 'TEAM_TASK_INVALID_TRANSITION')
        task.status = 'completed'
      } else {
        throw teamError(`unsupported task action ${String(request.action)}`, 'TEAM_INVALID_ARGUMENT')
      }
      task.revision += 1
      return viewOf(task)
    },
  }
  // 默认提供 getTask（CAS 冲突后的权威重读）；opts.getTask===false 用来验"只能读错误原文"的兜底。
  if (opts.getTask !== false) {
    service.getTask = (caller, id) => {
      calls.getTask.push({ caller, id })
      const task = tasks.get(id)
      if (task === undefined) throw teamError(`team task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
      return viewOf(task)
    }
  }
  const services = { agentTeams: service }
  if (opts.withAgents !== false) services.agents = { get: (id) => (id === lead.id ? lead : undefined) }
  const ctx = { get: (name) => services[name] }
  return { ctx, calls, tasks, service, lead, services }
}

/** 组一个 board env（显式入参优先，模拟 transport/store 两处的调用形态）。 */
function envOf(host, pipelineRoot, overrides = {}) {
  const auditLog = []
  const env = {
    ctx: host.ctx,
    config: { teamBoard: 'auto' },
    dirs: { pipelineRoot },
    audit: (action, detail) => {
      auditLog.push({ action, detail })
    },
    callerAgent: host.lead,
    ...overrides,
  }
  return { env, auditLog }
}

/** 跑一整套。@returns {Promise<{passed:number,total:number,text:string}>} */
export async function runTeamBoardCheck() {
  const lines = []
  const results = []
  const add = (name, ok, detail = '') => results.push({ name, ok: ok === true, detail: String(detail ?? '') })
  const tmpRoots = []
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pipeline-team-board-'))
    tmpRoots.push(dir)
    return dir
  }
  let lastHost = null
  try {
    lines.push('='.repeat(78))
    lines.push('WP-B 任务板镜像自测（pipeline 任务 ↔ 官方 Team 任务板）')
    lines.push('='.repeat(78))

    // ── 一、开单镜像 ────────────────────────────────────────────────────────
    lines.push('')
    lines.push('【一】开单 → createTask（subject / description / writeScopes + 落盘）')
    const root1 = tmp()
    const host1 = fakeTeamHost()
    lastHost = host1
    const { env: env1, auditLog: audit1 } = envOf(host1, root1)
    const task1 = {
      id: 'T-20261018-board',
      requirement: '把任务板镜像接上（自测替身需求）',
      // 混入两条官方不接受的授权面条目：绝对路径 / `..` —— 必须被静默过滤。
      change_scope: [{ id: 'CS1', path: 'src/a.js', action: 'modify', why: 'x' }, { id: 'CS2', path: 'docs\\guide\\', action: 'create', why: 'y' }, { id: 'CS3', path: 'C:/abs/x.js' }, { id: 'CS4', path: '../up.js' }],
    }
    const open1 = await mirrorOpen(env1, task1)
    add('mirrorOpen → ok:true、action=create', open1.ok === true && open1.action === 'create', JSON.stringify(open1))
    add('createTask 恰好一次，caller 是**活会话对象**（不是 id 字符串）', host1.calls.createTask.length === 1 && host1.calls.createTask[0].caller === host1.lead, JSON.stringify(host1.calls.createTask.length))
    add('subject 形如 `[pipeline] <taskId>`', host1.calls.createTask[0]?.request?.subject === '[pipeline] T-20261018-board', host1.calls.createTask[0]?.request?.subject)
    add('description = requirement 原文', host1.calls.createTask[0]?.request?.description === task1.requirement)
    add('writeScopes 只留合法 workspace-relative 条目（绝对路径 / `..` 被丢弃、`\\` 归一成 `/`）',
      JSON.stringify(host1.calls.createTask[0]?.request?.writeScopes) === JSON.stringify(['src/a.js', 'docs/guide']),
      JSON.stringify(host1.calls.createTask[0]?.request?.writeScopes))
    const state1 = await readBoardState(env1, task1.id)
    add('落盘 team-board.json 四字段齐全（team_task_id / revision / last_action / at）',
      state1 !== null && state1.team_task_id === 'task-1' && state1.revision === 1 && state1.last_action === 'create' && /^\d{4}-\d\d-\d\dT/.test(state1.at),
      JSON.stringify(state1))
    add('落盘路径 = `<pipelineRoot>/<taskId>/team-board.json`', teamBoardPath(env1, task1.id) === join(root1, task1.id, BOARD_FILE_NAME) && existsSync(teamBoardPath(env1, task1.id)))
    const again = await mirrorOpen(env1, task1)
    add('重复开单镜像 ⇒ skipped（不建第二条官方任务）', again.skipped === true && host1.calls.createTask.length === 1, JSON.stringify(again))

    // ── 二、派活镜像 ────────────────────────────────────────────────────────
    lines.push('')
    lines.push('【二】派活 → updateTask(action:"reassign")（只有 lead 能调，revision CAS）')
    const dispatch1 = await mirrorDispatch(env1, task1, { role: 'writer', seat: 'writer#1', memberName: 'p-writer-1' })
    add('mirrorDispatch → ok:true', dispatch1.ok === true && dispatch1.action === 'reassign', JSON.stringify(dispatch1))
    const dReq = host1.calls.updateTask[0]?.request ?? {}
    add('官方侧收到 action=reassign / owner=成员名 / expectedRevision=1', dReq.action === 'reassign' && dReq.owner === 'p-writer-1' && dReq.expectedRevision === 1, JSON.stringify(dReq))
    add('官方任务真的进了 in_progress 且 owner 是那个 teammate', host1.tasks.get('task-1')?.status === 'in_progress' && host1.tasks.get('task-1')?.ownerName === 'p-writer-1', JSON.stringify({ status: host1.tasks.get('task-1')?.status, owner: host1.tasks.get('task-1')?.ownerName }))
    add('本地镜像状态跟进（revision=2 / last_action=reassign）', (await readBoardState(env1, task1.id))?.revision === 2 && (await readBoardState(env1, task1.id))?.last_action === 'reassign')
    const beforeMissing = host1.calls.updateTask.length
    const missingName = await mirrorDispatch(env1, task1, { role: 'writer' })
    add('没有 memberName ⇒ skipped 且**零**宿主调用（不猜名字）', missingName.skipped === true && host1.calls.updateTask.length === beforeMissing, JSON.stringify(missingName))
    const noMirror = await mirrorDispatch(env1, { id: 'T-no-board' }, { memberName: 'p-writer-1' })
    add('任务没有镜像 ⇒ skipped（不凭空建）', noMirror.skipped === true && host1.calls.createTask.length === 1, JSON.stringify(noMirror))

    // ── 三、关单镜像 ────────────────────────────────────────────────────────
    lines.push('')
    lines.push('【三】关单 / 取消 → updateTask(action:"complete")')
    const close1 = await mirrorClose(env1, task1, { reason: '验收通过' })
    add('mirrorClose → ok:true', close1.ok === true && close1.action === 'complete', JSON.stringify(close1))
    const cReq = host1.calls.updateTask.at(-1)?.request ?? {}
    add('官方侧收到 action=complete / expectedRevision=2', cReq.action === 'complete' && cReq.expectedRevision === 2, JSON.stringify(cReq))
    add('官方任务真的 completed、本地镜像 revision=3 / last_action=complete',
      host1.tasks.get('task-1')?.status === 'completed' && (await readBoardState(env1, task1.id))?.revision === 3 && (await readBoardState(env1, task1.id))?.last_action === 'complete',
      JSON.stringify(host1.tasks.get('task-1')))
    add('全程零审计错误（正例不许凭空报错）', audit1.length === 0, JSON.stringify(audit1))

    // ── 四、CAS 冲突：重读一次、重试一次 ──────────────────────────────────────
    lines.push('')
    lines.push('【四】revision CAS 冲突 ⇒ 重读一次 + 重试一次')
    const root2 = tmp()
    const host2 = fakeTeamHost({ staleFirst: true })
    const { env: env2 } = envOf(host2, root2)
    const task2 = { id: 'T-cas' }
    await mirrorOpen(env2, task2)
    const dispat2 = await mirrorDispatch(env2, task2, { memberName: 'p-writer-2' })
    add('stale 后**重试成功**（ok:true）', dispat2.ok === true, JSON.stringify(dispat2))
    add('updateTask 调用 2 次：第二次的 expectedRevision 是重读到的 2',
      host2.calls.updateTask.length === 2 && host2.calls.updateTask[0].request.expectedRevision === 1 && host2.calls.updateTask[1].request.expectedRevision === 2,
      JSON.stringify(host2.calls.updateTask.map((c) => c.request.expectedRevision)))
    add('重试用官方 getTask 读权威 revision（不是猜 +1）', host2.calls.getTask.length === 1, JSON.stringify(host2.calls.getTask.length))
    add('本地镜像状态 = 重试成功后的 revision 3', (await readBoardState(env2, task2.id))?.revision === 3)

    const root3 = tmp()
    const host3 = fakeTeamHost({ staleFirst: true, getTask: false })
    const { env: env3 } = envOf(host3, root3)
    const task3 = { id: 'T-cas-2' }
    await mirrorOpen(env3, task3)
    const dispat3 = await mirrorDispatch(env3, task3, { memberName: 'p-writer-3' })
    add('服务没有 getTask 时退回**错误原文**里的 current revision 也能重试成功',
      dispat3.ok === true && host3.calls.updateTask.length === 2 && host3.calls.updateTask[1].request.expectedRevision === 2,
      JSON.stringify(host3.calls.updateTask.map((c) => c.request.expectedRevision)))

    // ── 五、关单兜底：官方侧仍 pending（开单后没派活就取消）──────────────────
    lines.push('')
    lines.push('【五】关单兜底：官方侧还是 pending（没派过活）⇒ claim 再 complete')
    const root4 = tmp()
    const host4 = fakeTeamHost()
    const { env: env4 } = envOf(host4, root4)
    const task4 = { id: 'T-cancel-early' }
    await mirrorOpen(env4, task4)
    const close4 = await mirrorClose(env4, task4, { reason: '开单后直接取消' })
    const actions4 = host4.calls.updateTask.map((c) => c.request.action)
    add('先 complete 被拒（只接受 in_progress）⇒ claim ⇒ complete 走通', close4.ok === true && JSON.stringify(actions4) === JSON.stringify(['complete', 'claim', 'complete']), JSON.stringify(actions4))
    add('claim 的 expectedRevision 对得上（1），complete 用 claim 之后的 2', host4.calls.updateTask[1]?.request?.expectedRevision === 1 && host4.calls.updateTask[2]?.request?.expectedRevision === 2, JSON.stringify(host4.calls.updateTask.map((c) => c.request.expectedRevision)))
    add('官方任务最终 completed、本地镜像 revision=3 / last_action=complete', host4.tasks.get('task-1')?.status === 'completed' && (await readBoardState(env4, task4.id))?.last_action === 'complete')

    // ── 六、best-effort：跳过 / 失败只审计 ───────────────────────────────────
    lines.push('')
    lines.push('【六】best-effort：服务缺失 / teamBoard=off / 无活 caller / 异常 ⇒ 不抛、不碰主流程')
    const root5 = tmp()
    const noServicectx = { get: () => undefined }
    const envNoSvc = { ctx: noServicectx, config: { teamBoard: 'auto' }, dirs: { pipelineRoot: root5 }, callerAgent: { id: 'a' } }
    const noSvc = await mirrorOpen(envNoSvc, { id: 'T-x' })
    add('没有 agentTeams 服务 ⇒ skipped:true、不抛、note 说明原因', noSvc.skipped === true && /agentTeams/.test(noSvc.note), JSON.stringify(noSvc))
    const hostOff = fakeTeamHost()
    const { env: envOff, auditLog: auditOff } = envOf(hostOff, tmp(), { config: { teamBoard: 'off' } })
    const offRes = await mirrorOpen(envOff, { id: 'T-off' })
    add("config.teamBoard='off' ⇒ skipped 且**零宿主调用**", offRes.skipped === true && hostOff.calls.createTask.length === 0 && hostOff.calls.updateTask.length === 0, JSON.stringify(offRes))
    add("off 不是错误 ⇒ **不写** team:board-error 审计", auditOff.length === 0, JSON.stringify(auditOff))
    const hostNoCaller = fakeTeamHost({ withAgents: false })
    const { env: envNoCaller } = envOf(hostNoCaller, tmp(), { callerAgent: null })
    const noCaller = await mirrorOpen(envNoCaller, { id: 'T-no-caller' })
    add('拿不到活会话对象（既无 callerAgent、agents 服务也缺失）⇒ skipped、零调用', noCaller.skipped === true && hostNoCaller.calls.createTask.length === 0, JSON.stringify(noCaller))
    const root6 = tmp()
    const hostErr = fakeTeamHost({ createThrows: true })
    const { env: envErr, auditLog: auditErr } = envOf(hostErr, root6)
    const errRes = await mirrorOpen(envErr, { id: 'T-err', requirement: 'x' })
    add('createTask 抛错 ⇒ 返回 ok:false（不抛），note 如实说"只记审计"', errRes.ok === false && errRes.skipped !== true && /只记审计/.test(errRes.note), JSON.stringify(errRes))
    add('失败写 audit(team:board-error) 且带 phase/task_id', auditErr.length === 1 && auditErr[0].action === 'team:board-error' && auditErr[0].detail.phase === 'create' && auditErr[0].detail.task_id === 'T-err', JSON.stringify(auditErr))
    add('失败时**不落** team-board.json（没镜像过就是没镜像过）', (await readBoardState(envErr, 'T-err')) === null)

    // ── 七、生命周期接线（store.open / store.transition）─────────────────────
    lines.push('')
    lines.push('【七】生命周期接线：开单 / 取消两个 hook（模块级宿主登记）')
    const proj7 = tmp()
    const host7 = fakeTeamHost()
    installBoardHost({ ctx: host7.ctx, config: { teamBoard: 'auto' }, dirs: { projectRoot: proj7 } })
    add('installBoardHost 后 installedBoardHost() 可读回', installedBoardHost() !== null)
    const merged = boardEnvFromStore({ callerAgentId: 'agent-lead' })
    add('boardEnvFromStore 合并出 ctx/config + callerAgentId（caller 由 board 内部反查）',
      merged.ctx === host7.ctx && merged.config.teamBoard === 'auto' && merged.callerAgentId === 'agent-lead',
      JSON.stringify({ ctx: merged.ctx !== null, config: merged.config, callerAgentId: merged.callerAgentId }))
    const hostMerge = fakeTeamHost()
    installBoardHost({ ctx: hostMerge.ctx, config: { teamBoard: 'auto' }, dirs: { projectRoot: tmp() } })
    const mergeEnv = boardEnvFromStore({ callerAgentId: 'agent-lead' })
    mergeEnv.dirs = { pipelineRoot: tmp() }
    const mergeOpen = await mirrorOpen(mergeEnv, { id: 'T-merge', requirement: '合并自测' })
    add('…callerAgentId 经 ctx.agents 反查到活 caller ⇒ 镜像成功（store hook 依赖的正是这条）',
      mergeOpen.ok === true && hostMerge.calls.createTask.length === 1 && hostMerge.calls.createTask[0].caller === hostMerge.lead,
      JSON.stringify({ ok: mergeOpen.ok, calls: hostMerge.calls.createTask.length }))
    installBoardHost({ ctx: host7.ctx, config: { teamBoard: 'auto' }, dirs: { projectRoot: proj7 } })
    const store7 = createTaskStore({ projectRoot: proj7, artifactDirName: '.pipeline', maxReworkPerLeg: 2 })
    const open7 = await store7.open({ requirement: '接线自测需求', actorRole: 'main', actorAgentId: 'agent-lead' })
    add('store.open 成功（主流程 ok 不受镜像影响）', open7.ok === true, JSON.stringify(open7.ok))
    add('store.open ⇒ 官方 createTask 被调用一次', host7.calls.createTask.length === 1, JSON.stringify(host7.calls.createTask.length))
    const state7 = await readBoardState({ dirs: { pipelineRoot: join(proj7, '.pipeline') } }, open7.task.id)
    add('store.open ⇒ team-board.json 落在任务目录（store 侧传的是 .pipeline 根）', state7 !== null && state7.last_action === 'create', JSON.stringify(state7))
    const cancel7 = await store7.transition({ taskId: open7.task.id, event: 'cancel', actorRole: 'main', actorAgentId: 'agent-lead' })
    add('store.transition(cancel) 成功', cancel7.ok === true && cancel7.to === 'cancelled', JSON.stringify({ ok: cancel7.ok, to: cancel7.to }))
    add('取消成功 ⇒ 官方 updateTask(complete) 被调用', host7.calls.updateTask.at(-1)?.request?.action === 'complete', JSON.stringify(host7.calls.updateTask.at(-1)?.request))
    add('取消后镜像 last_action=complete', (await readBoardState({ dirs: { pipelineRoot: join(proj7, '.pipeline') } }, open7.task.id))?.last_action === 'complete')

    // 反例：镜像**全失败**时主流程仍然 ok（这是 D10 的硬约束）。
    const proj8 = tmp()
    const host8 = fakeTeamHost({ createThrows: true, updateThrows: true })
    installBoardHost({ ctx: host8.ctx, config: { teamBoard: 'auto' }, dirs: { projectRoot: proj8 } })
    const store8 = createTaskStore({ projectRoot: proj8, artifactDirName: '.pipeline', maxReworkPerLeg: 2 })
    const open8 = await store8.open({ requirement: '镜像失败也不许挡开单', actorRole: 'main', actorAgentId: 'agent-lead' })
    add('★ createTask 抛错时 store.open 仍然 ok:true（失败只进审计）', open8.ok === true, JSON.stringify(open8.ok))
    // 手工造一份镜像状态（模拟"开单时镜像成功、之后官方侧开始报错"），再取消。
    writeFileSync(join(proj8, '.pipeline', open8.task.id, BOARD_FILE_NAME), JSON.stringify({ team_task_id: 'task-9', revision: 1, last_action: 'create', at: '2026-10-18T00:00:00Z' }), 'utf8')
    const cancel8 = await store8.transition({ taskId: open8.task.id, event: 'cancel', actorRole: 'main', actorAgentId: 'agent-lead' })
    add('★ updateTask 抛错时 store.transition 仍然 ok:true、状态真的变了', cancel8.ok === true && cancel8.to === 'cancelled', JSON.stringify({ ok: cancel8.ok, to: cancel8.to }))
    const auditText8 = readFileSync(join(proj8, '.pipeline', open8.task.id, 'audit.jsonl'), 'utf8')
    const boardErrors8 = auditText8.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.action === 'team:board-error')
    add('两次镜像失败都落进 audit.jsonl（team:board-error，关单那条 phase=complete）',
      boardErrors8.length >= 2 && boardErrors8.some((e) => e.phase === 'create') && boardErrors8.some((e) => e.phase === 'complete'),
      JSON.stringify(boardErrors8.map((e) => e.phase)))
    add('失败不影响状态机：任务卡落盘 state=cancelled', JSON.parse(readFileSync(join(proj8, '.pipeline', open8.task.id, 'task.json'), 'utf8')).state === 'cancelled')

    // ── 八、辅助判据 ────────────────────────────────────────────────────────
    lines.push('')
    lines.push('【八】辅助判据（writeScopesOf / 读坏文件 / 无目录）')
    add('writeScopesOf：去重 + 过滤绝对路径/盘符/`.`/`..`/空段',
      JSON.stringify(writeScopesOf({ change_scope: [{ path: 'a/b' }, { path: 'a/b' }, { path: '/root/x' }, { path: 'D:\\win\\x' }, { path: './c' }, { path: 'd/../e' }, { path: '' }] })) === JSON.stringify(['a/b', 'c']),
      JSON.stringify(writeScopesOf({ change_scope: [{ path: 'a/b' }, { path: 'a/b' }, { path: '/root/x' }, { path: 'D:\\win\\x' }, { path: './c' }, { path: 'd/../e' }, { path: '' }] })))
    add('writeScopesOf：计划层分区 scope_paths 也算授权面，且容忍缺字段',
      JSON.stringify(writeScopesOf({ roster: { writers: { partitions: [{ scope_paths: ['lib/'] }, {}] } } })) === JSON.stringify(['lib']) &&
        JSON.stringify(writeScopesOf(undefined)) === JSON.stringify([]))
    const root9 = tmp()
    mkdirSync(join(root9, 'bad'), { recursive: true })
    writeFileSync(join(root9, 'bad', BOARD_FILE_NAME), '{ not json', { encoding: 'utf8', flag: 'w' })
    add('team-board.json 读坏 ⇒ 当"没镜像过"（null），不抛', (await readBoardState({ dirs: { pipelineRoot: root9 } }, 'bad')) === null)
    add('拿不到 .pipeline 根 / 空 taskId ⇒ 路径为空串（调用方按 skipped 处理）',
      teamBoardPath({ dirs: {} }, 'T') === '' && teamBoardPath({ dirs: { pipelineRoot: root9 } }, '') === '')

    // ★ 与 WP-T（transport/team.js）的真实调用形态对齐：`dirs` 是 `resolveDirs()` 的
    //   产物（只有 projectRoot，没有 pipelineRoot），`audit` 是既有
    //   `createChannelAudit().record` 的**单对象参**形态。这两种都必须能吃下。
    const projT = tmp()
    const hostT = fakeTeamHost({ createThrows: true })
    const channelEntries = []
    const envTransport = {
      ctx: hostT.ctx,
      config: { teamBoard: 'auto' },
      dirs: { projectRoot: projT, dshHome: projT },
      audit: (entry) => channelEntries.push(entry),
      callerAgent: hostT.lead,
    }
    add('transport 形态 env（dirs 只有 projectRoot）能算出 `<projectRoot>/.pipeline/<task>/…`',
      teamBoardPath(envTransport, 'T-transport') === join(projT, '.pipeline', 'T-transport', BOARD_FILE_NAME), teamBoardPath(envTransport, 'T-transport'))
    const transportOpen = await mirrorOpen(envTransport, { id: 'T-transport', requirement: 'x' })
    add('audit 是 channel 的单对象参形态 ⇒ 也落成 team:board-error（带 taskId/phase）',
      transportOpen.ok === false && channelEntries.length === 1 && channelEntries[0].action === 'team:board-error' && channelEntries[0].taskId === 'T-transport' && channelEntries[0].detail.phase === 'create',
      JSON.stringify(channelEntries))
    add('config.artifactDirName 参与 .pipeline 根回落（自定义目录名不会镜像到错的路径）',
      teamBoardPath({ config: { artifactDirName: '.artifacts' }, dirs: { projectRoot: projT } }, 'T') === join(projT, '.artifacts', 'T', BOARD_FILE_NAME))
    installBoardHost(null)
    add('installBoardHost(null) 可清空登记（测试隔离）', installedBoardHost() === null)
  } finally {
    installBoardHost(null)
    for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
    void lastHost
  }

  const passed = results.filter((r) => r.ok).length
  for (const r of results) lines.push(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok || r.detail.length === 0 ? '' : `  ← ${r.detail.slice(0, 240)}`}`)
  lines.push('')
  lines.push('─'.repeat(78))
  lines.push(`任务板镜像自测：${passed}/${results.length} 通过${passed === results.length ? '' : '  ← 有失败'}`)
  lines.push('─'.repeat(78))
  return { passed, total: results.length, text: lines.join('\n') }
}

/** 单跑本文件（由总入口调用时不走这里）。 */
if (process.argv[1] !== undefined && process.argv[1].endsWith('team-board-check.mjs')) {
  const r = await runTeamBoardCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
