/**
 * dsh-pipeline · 通道侧自测：**真实会话派活**
 * ============================================================================
 * 跑法：由 `tests/run-all.mjs`（自测总入口）统一调用；也可单跑本文件。
 *
 * 这一套盯的是本次改造的通道侧（席位 writer#1 · 层 channel）：
 *   1. 能力探测：缺件要报「不可达 + 证据 + 降级方案」，不许硬编码兜底；
 *   2. 派活 = **新建真实会话**（agentPreset 显式给、workspaceId 显式给）；
 *   3. 项目分组：**派活那一刻**就落对（ensure），建不起来就拒，不静默落「未分组」；
 *   4. 四槽（权限 / 模式 / 模型 / 推理等级）**物理分离**，未指定取最小档 / 默认档并留痕；
 *   5. 「完全」档**默认禁用**：三段齐（需求分析 → 主对话 → 用户判定）才放行；
 *   6. **不许拿子代理冒名**：读回 origin=subagent 一律判失败；
 *   7. 不可达时**只上报、不静默降级**（不自动退回 subagent 通道）。
 *
 * ★ 全程零副作用：不建任何真实会话、不连任何服务 —— 宿主服务全部是本地替身。
 *
 * @module dsh-pipeline/tests/channel-check
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTokenStore } from '../lib/tokens.js'
import { createChannelAudit } from '../lib/liveness.js'
import {
  CHANNEL_SERVICES,
  DISPATCH_SLOT_KEYS,
  FULL_PERMISSION,
  MIN_PERMISSION,
  SessionTransport,
  UnreachableTransport,
  createTransport,
  fullPermissionGate,
  normalizeSlots,
  probeSessionChannel,
  readSessionBinding,
  sessionAlive,
} from '../lib/transport/index.js'

/** 造一个宿主替身（假 ctx + 可断言的服务调用记录）。 */
function fakeHost(opts = {}) {
  const calls = { create: [], prompt: [], set: [], selectModel: [], saveSelection: [], wsCreate: [] }
  const sessions = new Map()
  const agents = new Map()
  const perm = new Map()
  let seq = 0

  const services = {
    sessionController: {
      async create(input) {
        calls.create.push(input)
        if (opts.createThrows === true) throw new Error('create denied (fake)')
        seq += 1
        const id = `sess-${String(seq).padStart(2, '0')}`
        sessions.set(id, { origin: opts.origin, agentPreset: opts.sessionPreset ?? input.agentPreset })
        agents.set(id, { id, status: 'idle' })
        return { sessionId: id, agentPreset: opts.sessionPreset ?? input.agentPreset }
      },
      async prompt(input) {
        calls.prompt.push(input)
        if (opts.promptThrows === true) throw new Error('prompt denied (fake)')
        return { accepted: true }
      },
      async inspect(id) {
        if (opts.inspectThrows === true) throw new Error('inspect denied (fake)')
        const s = sessions.get(id)
        if (s === undefined) throw new Error(`no such session ${id}`)
        return { meta: { id, origin: s.origin, agentPreset: s.agentPreset } }
      },
      async selectModel(input) {
        calls.selectModel.push(input)
        if (opts.selectThrows === true) throw new Error('unknown model (fake)')
      },
    },
    workspaceRegistry: {
      async create(a, b) {
        calls.wsCreate.push([a, b])
        if (opts.wsThrows === true) throw new Error('path is not a directory (fake)')
        return { id: opts.wsId ?? 'ws-1', created: true }
      },
    },
    permissionPresets: {
      async set(session, tier) {
        calls.set.push(tier)
        if (opts.permissionThrows === true) throw new Error(`unknown permission preset (fake): ${tier}`)
        perm.set(session, opts.permissionReadback ?? tier)
      },
      current(session) {
        return perm.get(session) ?? null
      },
    },
    agents: { get: (id) => agents.get(id) },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }),
      async saveSelection(s) {
        calls.saveSelection.push(s)
      },
    },
  }
  if (typeof opts.drop === 'string' && opts.drop.length > 0) delete services[opts.drop]
  const ctx = { get: (name) => services[name] }
  return { ctx, calls, services, sessions, agents }
}

const CONFIG = { projectRoot: 'C:/proj/demo', transport: 'auto' }

function specOf(extra = {}) {
  return {
    task: { id: 'T-CH-0001', project_root: 'C:/proj/demo', requirement: '（自测替身需求）' },
    roster: { tier: 'L3', conversations: ['writer'], sequence: [{ role: 'writer' }] },
    role: 'writer',
    seat: 'writer#1',
    ...extra,
  }
}

function freshTransport(host, opts = {}) {
  const tokens = createTokenStore({})
  const auditLog = []
  const transport = new SessionTransport({
    ctx: host.ctx,
    config: { ...CONFIG, ...(opts.config ?? {}) },
    tokens,
    audit: (e) => auditLog.push(e),
  })
  return { transport, tokens, auditLog }
}

const APPROVED = {
  requirement: { at: '2026-10-11T00:00:00Z', by: 'orchestrator' },
  main: { at: '2026-10-11T00:01:00Z', by: 'main' },
  user: { at: '2026-10-11T00:02:00Z', decision: 'approved', scope: { taskId: 'T-CH-0001', role: 'writer', seat: 'writer#1' } },
}

/**
 * 跑一整套。
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runChannelCheck() {
  const lines = []
  let passed = 0
  let total = 0
  const add = (label, cond, detail = '') => {
    total += 1
    if (cond === true) {
      passed += 1
      lines.push(`  ✓ ${label}`)
    } else {
      lines.push(`  ✗ ${label}${detail === '' ? '' : `\n      ${String(detail).slice(0, 500)}`}`)
    }
  }

  lines.push('='.repeat(78))
  lines.push('通道侧自测：真实会话派活 / 项目分组 / 四槽 / 完全档闸门 / 不可达纪律')
  lines.push('='.repeat(78))
  lines.push('')

  lines.push('【一】能力探测（缺件要报「不可达 + 证据 + 降级方案」）')
  const full = fakeHost()
  const p1 = probeSessionChannel(full.ctx)
  add('服务齐全 → ok=true、missing 为空', p1.ok === true && p1.missing.length === 0, JSON.stringify(p1.missing))
  add('探测清单覆盖 5 项服务（3 项必需 + 2 项可选）', CHANNEL_SERVICES.length === 5 && CHANNEL_SERVICES.filter((s) => s.required).length === 3, `len=${CHANNEL_SERVICES.length}`)
  add('证据逐项可读（每项一条 ctx.get 结论）', p1.evidence.length === 5 && p1.evidence.every((e) => e.includes('ctx.get(')), p1.evidence.join(' | '))

  const noCtrl = fakeHost({ drop: 'sessionController' })
  const p2 = probeSessionChannel(noCtrl.ctx)
  add('缺 sessionController → ok=false 且 missing 点名它', p2.ok === false && p2.missing.includes('sessionController'), JSON.stringify(p2.missing))
  add('不可达时给 3 条降级方案（含「不许冒名」那条）', p2.degradations.length === 3 && p2.degradations.some((x) => x.includes('冒名')), p2.degradations.join(' | '))
  add('不可达时结论里点名"先上报、不静默降级"', p2.note.includes('先上报') && p2.note.includes('不可达'), p2.note)

  const noRegistry = fakeHost({ drop: 'workspaceRegistry' })
  add('缺 workspaceRegistry → 不可达（归组能力是必需的）', probeSessionChannel(noRegistry.ctx).ok === false)
  const noPresets = fakeHost({ drop: 'permissionPresets' })
  add('缺 permissionPresets → 不可达（保证不了最小档就不放行）', probeSessionChannel(noPresets.ctx).ok === false)
  lines.push('')

  lines.push('【二】选通道（session 优先；拿不到就只上报，不静默降级）')
  const tAuto = createTransport(full.ctx, { ...CONFIG }, { tokens: createTokenStore({}) })
  add('auto + 服务齐全 → 通道 kind = session', tAuto.kind === 'session', tAuto.kind)
  const tUnreach = createTransport({ get: () => undefined }, { ...CONFIG }, { tokens: createTokenStore({}) })
  add('auto + 什么服务都没有 → kind = unreachable（**没有**自动退回 subagent）', tUnreach instanceof UnreachableTransport && tUnreach.kind === 'unreachable', tUnreach.kind)
  const tManual = createTransport({ get: () => undefined }, { transport: 'manual' }, { tokens: createTokenStore({}) })
  add('显式 manual 仍然可用', tManual.kind === 'manual', tManual.kind)
  const tSub = createTransport({ get: () => undefined }, { transport: 'subagent' }, { tokens: createTokenStore({}) })
  add('显式 subagent 仍然可用（旧通道保留，但必须显式选）', tSub.kind === 'subagent', tSub.kind)

  const auditUnreach = []
  const tU2 = new UnreachableTransport({ ctx: { get: () => undefined }, config: CONFIG, audit: (e) => auditUnreach.push(e) })
  const rU = await tU2.spawnRole(specOf())
  add('不可达通道派活 → ok=false + unreachable=true', rU.ok === false && rU.unreachable === true)
  add('返回的报告是给用户看的人话（含「不可达」「降级方案」「冒名」）',
    rU.report.includes('不可达') && rU.report.includes('降级方案') && rU.report.includes('冒名'), rU.report.slice(0, 200))
  add('不可达时**留痕**（审计收到 channel:unreachable）', auditUnreach.some((e) => e.action === 'channel:unreachable'), JSON.stringify(auditUnreach))
  lines.push('')

  lines.push('【三】派活 = 新建真实会话 + 派活那一刻落对项目分组')
  const h3 = fakeHost()
  const t3 = freshTransport(h3)
  const r3 = await t3.transport.spawnRole(specOf())
  add('派活成功（ok=true）', r3.ok === true, r3.note)
  add('拿到 sessionId（不是 null / 不是子代理 id）', typeof r3.sessionId === 'string' && r3.sessionId.length > 0, String(r3.sessionId))
  add('via = session（派活记录靠它区分新旧通道）', r3.via === 'session', String(r3.via))
  add('建会话时**显式**给了 agentPreset（不传会落到宿主推断的 computer-use）',
    h3.calls.create.length === 1 && h3.calls.create[0].agentPreset === 'standard', JSON.stringify(h3.calls.create))
  add('建会话时**显式**给了 workspaceId（归组在派活那一刻完成）',
    h3.calls.create[0].workspaceId === 'ws-1', JSON.stringify(h3.calls.create[0]))
  const wsArg = h3.calls.wsCreate.length === 1 ? h3.calls.wsCreate[0][0] : null
  const wsRoot = typeof wsArg === 'string' ? wsArg : wsArg !== null && typeof wsArg === 'object' ? wsArg.path ?? null : null
  const wsTitle = wsArg !== null && typeof wsArg === 'object' ? wsArg.title ?? null : null
  add('先 ensure 项目分组（workspaceRegistry.create 收到项目根 + 分组标题）',
    wsRoot === 'C:/proj/demo' && (wsTitle === null || wsTitle === 'demo'), JSON.stringify(h3.calls.wsCreate))
  add('派活单已投递（prompt 走 queue 模式，1 次）',
    h3.calls.prompt.length === 1 && h3.calls.prompt[0].mode === 'queue', JSON.stringify(h3.calls.prompt))
  add('派活单里带令牌（角色靠它认领身份）', h3.calls.prompt[0].content[0].text.includes('pipeline_bind_role') && r3.token.startsWith('PT-'), r3.token)
  const bound = t3.tokens.bySession(r3.sessionId)
  add('令牌与会话**绑定**（bySession 反查得到，角色/席位对得上）',
    bound !== null && bound.role === 'writer' && bound.seat === 'writer#1', JSON.stringify(bound))
  add('读回核对：会话头 origin 不是 subagent', r3.binding.origin === undefined || r3.binding.origin === null, String(r3.binding.origin))
  add('读回核对：模式落到了会话上', r3.binding.agentPreset === 'standard', String(r3.binding.agentPreset))
  add('诚实边界写进返回（真派活观测需重启后复验）', r3.note.includes('真派活观测') && r3.note.includes('复验'), r3.note.slice(0, 300))
  lines.push('')

  lines.push('【四】四槽：物理分离 + 未指定取最小档 / 默认档 + 留痕')
  add('四槽就是四个独立字段（不打包）', DISPATCH_SLOT_KEYS.length === 4 && DISPATCH_SLOT_KEYS.join(',') === 'permission,mode,model,reasoning', DISPATCH_SLOT_KEYS.join(','))
  const slotsDefault = normalizeSlots({}, {
    permission: { value: MIN_PERMISSION, reason: '未指定 ⇒ 最小档' },
    mode: { value: 'standard', reason: '未指定 ⇒ 角色默认模式' },
    model: { value: null, reason: '未指定' },
    reasoning: { value: null, reason: '未指定' },
  })
  add('未指定 → 权限取最小档 read-only，且 origin=default 留痕',
    slotsDefault.permission.value === 'read-only' && slotsDefault.permission.origin === 'default' && slotsDefault.permission.isDefault === true,
    JSON.stringify(slotsDefault.permission))
  add('未指定 → 模式取默认档，且四槽各自独立（没有互相覆盖）',
    slotsDefault.mode.value === 'standard' && slotsDefault.mode.value !== slotsDefault.permission.value, JSON.stringify(slotsDefault.mode))
  add('权限槽实际钉到会话上（permissionPresets.set 收到 read-only）',
    h3.calls.set.length === 1 && h3.calls.set[0] === 'read-only', JSON.stringify(h3.calls.set))
  add('未指定模型 → **不调用** selectModel（不写全局默认）',
    h3.calls.selectModel.length === 0 && h3.calls.saveSelection.length === 0, JSON.stringify(h3.calls.selectModel))
  add('四槽逐条带 reason（缺省也要写理由）', Object.values(slotsDefault).every((s) => typeof s.reason === 'string'), JSON.stringify(slotsDefault))
  lines.push('')

  lines.push('【五】「完全」档默认禁用：三段齐才放行')
  const h5 = fakeHost()
  const t5 = freshTransport(h5)
  const r5 = await t5.transport.spawnRole(specOf({ permission: { value: FULL_PERMISSION, reason: '计划想开完全' } }))
  add('无审批 → 拒绝派活（code=FULL_TIER_NOT_APPROVED）', r5.ok === false && r5.code === 'FULL_TIER_NOT_APPROVED', JSON.stringify(r5.code))
  add('无审批 → **一个会话都没建**（在派活那一刻就拦住）', h5.calls.create.length === 0, JSON.stringify(h5.calls.create))
  add('拒绝报告写清缺哪几段 + 下一步归用户', r5.report.includes('需求分析') && r5.report.includes('用户判定') && r5.report.includes('下一步'), r5.report.slice(0, 240))

  const gatePartial = fullPermissionGate({ value: FULL_PERMISSION, approval: { requirement: {}, main: {} } }, specOf())
  add('缺用户那一段 → 拒（missing 点名 user）', gatePartial.ok === false && gatePartial.missing.includes('user'), JSON.stringify(gatePartial.missing))
  const gateScoped = fullPermissionGate({ value: FULL_PERMISSION, approval: APPROVED }, specOf())
  add('三段齐 + 范围匹配 → 放行', gateScoped.ok === true, JSON.stringify(gateScoped.scopeMismatch))
  const wrongScope = { ...APPROVED, user: { ...APPROVED.user, scope: { taskId: 'T-CH-0001', role: 'reviewer', seat: null } } }
  const gateWrong = fullPermissionGate({ value: FULL_PERMISSION, approval: wrongScope }, specOf())
  add('三段齐但**范围不符**（批的是别的角色）→ 拒', gateWrong.ok === false && gateWrong.scopeMismatch.length === 1, JSON.stringify(gateWrong.scopeMismatch))

  const h5b = fakeHost()
  const t5b = freshTransport(h5b)
  const r5b = await t5b.transport.spawnRole(specOf({ permission: { value: FULL_PERMISSION, approval: APPROVED } }))
  add('三段齐 + 范围匹配 → 真的放行（会话以完全档建出来）',
    r5b.ok === true && h5b.calls.set[0] === FULL_PERMISSION, `${String(r5b.ok)} ${JSON.stringify(h5b.calls.set)}`)
  lines.push('')

  lines.push('【六】硬失败一律拒：子代理冒名 / 模式没落下 / 归组失败 / 权限钉不上 / 模型不存在')
  const hSub = fakeHost({ origin: 'subagent' })
  const tSub2 = freshTransport(hSub)
  const rSub = await tSub2.transport.spawnRole(specOf())
  add('★ 读回 origin=subagent → **判失败**，不当作真实会话', rSub.ok === false && rSub.report.includes('子代理'), rSub.report.slice(0, 160))

  const hPreset = fakeHost({ sessionPreset: 'computer-use' })
  const tPreset = freshTransport(hPreset)
  const rPreset = await tPreset.transport.spawnRole(specOf())
  add('模式没落到会话上（要 standard 得到 computer-use）→ 拒', rPreset.ok === false && rPreset.report.includes('模式'), rPreset.report.slice(0, 160))

  const hWs = fakeHost({ wsThrows: true })
  const tWs = freshTransport(hWs)
  const rWs = await tWs.transport.spawnRole(specOf())
  add('归组建不起来 → 拒（不许静默落「未分组」）', rWs.ok === false && hWs.calls.create.length === 0, JSON.stringify(hWs.calls.create))
  add('归组失败的报告点名"未分组"与"不静默降级"', rWs.report.includes('未分组') && rWs.report.includes('静默降级'), rWs.report.slice(0, 200))

  const hPerm = fakeHost({ permissionThrows: true })
  const tPerm = freshTransport(hPerm)
  const rPerm = await tPerm.transport.spawnRole(specOf())
  add('权限档钉不上 → 拒（不把"没钉上"当"钉上了"）', rPerm.ok === false && rPerm.report.includes('权限档'), rPerm.report.slice(0, 160))

  const hModel = fakeHost({ selectThrows: true })
  const tModel = freshTransport(hModel)
  const rModel = await tModel.transport.spawnRole(specOf({ model: { value: 'deepseek-official/no-such-model', reason: '计划指定' } }))
  add('模型指定了部署里不存在的项 → 拒 + 不回退', rModel.ok === false && rModel.report.includes('模型'), rModel.report.slice(0, 160))

  const hInspect = fakeHost({ inspectThrows: true })
  const tInspect = freshTransport(hInspect)
  const rInspect = await tInspect.transport.spawnRole(specOf())
  add('读不回会话头（证明不了它不是子代理）→ 拒', rInspect.ok === false && rInspect.report.includes('证明不了'), rInspect.report.slice(0, 160))
  lines.push('')

  lines.push('【七】模型与推理等级：下发到会话 + 还原全局默认')
  const h7 = fakeHost()
  const t7 = freshTransport(h7)
  const r7 = await t7.transport.spawnRole(specOf({
    model: { value: 'deepseek-official/deepseek-flash', reason: '环境枚举默认档' },
    reasoning: { value: 'high', reason: '计划指定' },
  }))
  add('模型 / 等级下发到该会话', r7.ok === true && h7.calls.selectModel.length === 1 && h7.calls.selectModel[0].model === 'deepseek-flash' && h7.calls.selectModel[0].reasoningEffort === 'high', JSON.stringify(h7.calls.selectModel))
  add('全局默认被还原（saveSelection 调用 1 次）', h7.calls.saveSelection.length === 1, JSON.stringify(h7.calls.saveSelection))
  add('残余窗口如实写进返回（不声称已消除）', r7.note.includes('残余窗口'), r7.note.slice(0, 260))
  lines.push('')

  lines.push('【八】会话↔席位读回 + 存活探测')
  const h8 = fakeHost()
  const t8 = freshTransport(h8)
  const r8 = await t8.transport.spawnRole(specOf())
  const bind8 = await readSessionBinding(h8.ctx, r8.sessionId)
  add('读回形状齐全（origin / agentPreset / permission）',
    bind8.ok === true && bind8.agentPreset === 'standard' && bind8.permission === 'read-only', JSON.stringify(bind8))
  const alive1 = sessionAlive(h8.ctx, r8.sessionId)
  add('存活探测：会话在 → alive=true', alive1.known === true && alive1.alive === true, JSON.stringify(alive1))
  h8.agents.delete(r8.sessionId)
  const alive2 = sessionAlive(h8.ctx, r8.sessionId)
  add('存活探测：会话没了 → alive=false（不假装"它还活着"）', alive2.known === true && alive2.alive === false, JSON.stringify(alive2))
  const alive3 = sessionAlive({ get: () => undefined }, 'sess-x')
  add('探测服务不可用时 → known=false 且说明原因', alive3.known === false && alive3.note.includes('不可用'), JSON.stringify(alive3))
  lines.push('')

  lines.push('【九】通道审计：判决要落进只追加流水')
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-pipeline-channel-'))
  try {
    const file = join(tmp, 'audit.jsonl')
    const audit = createChannelAudit({ auditFile: () => file })
    audit.record({ taskId: 'T-CH-0001', action: 'channel:unreachable', detail: { missing: ['sessionController'] } })
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    add('审计落盘（一行一个 JSON，含 action 与 detail）',
      text.trim().length > 0 && JSON.parse(text.trim().split('\n')[0]).action === 'channel:unreachable', text.slice(0, 200))
    add('内存镜像可读（落盘失败也不吞判决）', audit.entries().length === 1, JSON.stringify(audit.entries()))
    const noFile = createChannelAudit({})
    noFile.record({ taskId: '', action: 'x' })
    add('没有落盘出口时不抛异常（判决仍在内存镜像里）', noFile.entries().length === 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  lines.push('')

  lines.push('─'.repeat(78))
  lines.push(`通道侧自测：${passed}/${total} 通过${passed === total ? '' : '  ← 有失败'}`)
  lines.push('─'.repeat(78))
  return { passed, total, text: lines.join('\n') }
}

/** 单跑本文件（由总入口调用时不走这里）。 */
if (process.argv[1] !== undefined && process.argv[1].endsWith('channel-check.mjs')) {
  const r = await runChannelCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}