/**
 * dsh-pipeline · 自测：**team 通道**（官方 Agent Teams）
 * ============================================================================
 * 跑法：由 `tests/run-all.mjs`（自测总入口，经 `tests/registry.mjs` 注册）统一调用；
 * 也可单跑本文件：`node tests/team-transport-check.mjs`。
 *
 * 这套盯的是 WP-T 的判据（设计：`design/agent-teams/01-目标与边界.md` §4、
 * `02-接线点与任务拆分.md` §1.1 / §5）：
 *   ① `spawn:false` ⇒ 宿主**零调用**；② 正常 spawn ⇒ 名字合法 / 正文含令牌与角色人格 /
 *   `member.id` 绑定令牌；③ 同名已存在 ⇒ **复用**（不重复 spawn，走 sendMessage）；
 *   ④ `reassign` ⇒ 新名字 `-r2`；⑤ 无 `agentTeams` ⇒ 可读失败、**不降级**；
 *   ⑥ 无活 caller ⇒ `TEAM_NO_LIVE_CALLER`；⑦ 容量错误翻译成人话；
 *   ⑧ `sendMessage` 超长按字节截断；⑨ `stop:true` ⇒ interrupt；
 *   ⑩ 四槽：`mode` 记 `UNAVAILABLE` / permission 读回 / `teamStrictSlots` 拒绝。
 *
 * ★ 全程零副作用：**一个真实 teammate 都不建**，宿主服务全部是本地替身
 *   （照 `tests/channel-check.mjs:42-104` 的 `fakeHost` 加一层 `agentTeams` 桩）。
 *
 * @module dsh-pipeline/tests/team-transport-check
 */

import { mergeConfig } from '../lib/config.js'
import { createTokenStore } from '../lib/tokens.js'
import { createTransport } from '../lib/transport/index.js'
import { TEAM_KIND, TeamTransport } from '../lib/transport/team.js'
import { describeTeamError, probeTeamChannel, truncateUtf8 } from '../lib/team/preflight.js'
import { nextNameForReassign, normalizeSeatKey, parseTeamName, teamNameOf } from '../lib/team/naming.js'
import { composeTeamBrief, rolePersona } from '../lib/team/brief.js'
import { MODE_SLOT_UNAVAILABLE } from '../lib/team/slots.js'

/** 宿主替身：记录每一次宿主调用（断言"零调用"靠它）。 */
function fakeHost(opts = {}) {
  const calls = { spawn: [], send: [], list: [], interrupt: [], permSet: [], permNow: [], selectModel: [] }
  const agents = new Map()
  const perm = new Map()
  const members = new Map()
  let seq = 0
  const services = {
    agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
    permissionPresets: {
      async set(session, tier) {
        calls.permSet.push(tier)
        if (opts.permissionThrows === true) throw new Error('unknown permission preset (fake)')
        perm.set(session, opts.permissionReadback ?? tier)
      },
      current: (session) => perm.get(session) ?? null,
    },
    sessionController: { async selectModel(input) { calls.selectModel.push(input) } },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
      async saveSelection() {},
    },
  }
  if (opts.noTeams !== true) {
    services.agentTeams = {
      async spawnTeammate(caller, req) {
        calls.spawn.push({ caller, req })
        if (typeof opts.spawnThrows === 'string') {
          const err = new Error(`fake spawn failure ${opts.spawnThrows}`)
          err.code = opts.spawnThrows
          throw err
        }
        seq += 1
        const id = `sess-team-${String(seq).padStart(2, '0')}`
        agents.set(id, { id, status: 'inactive' })
        const member = { id, name: req.name, role: 'teammate', status: 'inactive', description: req.description }
        members.set(req.name, member)
        return { member }
      },
      async sendMessage(caller, req) {
        calls.send.push({ caller, req })
        if (typeof opts.sendThrows === 'string') {
          const err = new Error(`fake send failure ${opts.sendThrows}`)
          err.code = opts.sendThrows
          throw err
        }
        return { messageId: `msg-${calls.send.length}` }
      },
      async listMembers(caller) {
        calls.list.push(caller)
        return [{ id: caller.id, name: TEAM_LEAD, role: 'lead', status: 'running' }, ...members.values()]
      },
      async interrupt(caller, name) {
        calls.interrupt.push({ caller, name })
        return { previousStatus: 'running' }
      },
    }
    // ★ 可选能力：官方 `interrupt` 可以被 profile 关掉 —— 缺了不算故障，但必须如实降级。
    if (opts.noInterrupt === true) delete services.agentTeams.interrupt
  }
  const ctx = { get: (name) => services[name] }
  return { ctx, calls, agents, members }
}

const TEAM_LEAD = 'lead'
/** 一个"活着的 Lead Agent"：必须就是 agents 表里那个对象（官方判据是 `===`）。 */
function makeCaller(host, id = 'lead-sess-1') {
  const agent = { id, status: 'running' }
  host.agents.set(id, agent)
  return agent
}

const TASK = { id: 'T-20261018-teamchk', requirement: '（自测替身需求）' }
const ROSTER = { tier: 'L3', conversations: ['writer'], sequence: [{ role: 'writer' }] }
const CONFIG = { projectRoot: 'C:/proj/demo', transport: 'team', teamBoard: 'off' }

function specOf(extra = {}) {
  return {
    task: TASK,
    roster: ROSTER,
    role: 'writer',
    seat: 'writer#1',
    spawn: true,
    permission: { value: 'read-only', origin: 'plan', isDefault: false },
    mode: { value: 'pl-writer', origin: 'plan', isDefault: false },
    model: { value: null, origin: 'default', isDefault: true },
    reasoning: { value: null, origin: 'default', isDefault: true },
    ...extra,
  }
}

function fresh(host, config = {}) {
  const tokens = createTokenStore({})
  const auditLog = []
  const transport = new TeamTransport({ ctx: host.ctx, config: mergeConfig({ ...CONFIG, ...config }), tokens, audit: (e) => auditLog.push(e) })
  return { transport, tokens, auditLog }
}

/**
 * 跑一整套。
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runTeamTransportCheck() {
  const lines = []
  let passed = 0
  let total = 0
  const add = (label, cond, detail = '') => {
    total += 1
    if (cond === true) {
      passed += 1
      lines.push(`  ✓ ${label}`)
    } else lines.push(`  ✗ ${label}${detail === '' ? '' : `\n      ${String(detail).slice(0, 400)}`}`)
  }
  const head = (t) => {
    lines.push('')
    lines.push(t)
  }
  lines.push('='.repeat(78))
  lines.push('team 通道自测：命名 / 派活 / 复用 / 四槽 / 投递截断 / 错误翻译 / 选择点')
  lines.push('='.repeat(78))

  // ---- 【一】命名（纯字符串）------------------------------------------------
  head('【一】teammate 命名（官方 kebab / ≤64 / 永不重用）')
  const n1 = teamNameOf({ taskId: 'T-20261018-teamchk', role: 'writer', seat: 'writer#1' })
  add('名字是合法 kebab 且 ≤64、≠lead', /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n1) && n1.length <= 64 && n1 !== TEAM_LEAD, n1)
  add('任务编进名字里（多张单不会撞名）', n1.startsWith('p-t-20261018-teamchk-writer'), n1)
  add('`writer#1` 的席位序号进名字（# 归一成 -）', /-writer-1$/.test(n1), n1)
  add('单席位角色 `tester`+`tester` 视作无席位（与 wakeup 的口径一致）', normalizeSeatKey('tester', 'tester') === '' && teamNameOf({ taskId: 'T-1', role: 'tester', seat: 'tester' }) === 'p-t-1-tester', normalizeSeatKey('tester', 'tester'))
  add('重派换名字：已占 ⇒ -r2，再占 ⇒ -r3', nextNameForReassign([n1], n1) === `${n1}-r2` && nextNameForReassign([n1, `${n1}-r2`], n1) === `${n1}-r3`, `${nextNameForReassign([n1], n1)} / ${nextNameForReassign([n1, `${n1}-r2`], n1)}`)
  const p1 = parseTeamName(n1)
  add('名字可尽力反解回 (role, seat)', p1.ok === true && p1.role === 'writer' && p1.seat === '1' && p1.taskPart === 't-20261018-teamchk', JSON.stringify(p1))
  add('超长任务 id 截断后仍然合法（不靠宿主拒绝）', /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(teamNameOf({ taskId: 'T-'.concat('x'.repeat(200)) })), String(teamNameOf({ taskId: 'x'.repeat(200) }).length))

  // ---- 【二】角色人格（复用预设生成器，不抄提示词）--------------------------
  head('【二】角色人格：拼进派活单正文（官方没有 agentPreset 参数）')
  const persona = rolePersona('writer')
  add('读得到 writer 的固定提示词（来源 = presets/src/writer/）', persona.ok === true && persona.prefix.length > 0 && persona.suffix.length > 0, persona.note)
  const briefText = composeTeamBrief({ brief: '【派活单正文】', persona })
  add('拼装结果同时含人格与派活单', briefText.includes(persona.prefix.slice(0, 20)) && briefText.includes('【派活单正文】'), briefText.slice(0, 120))
  const badPersona = rolePersona('no-such-role-xyz')
  add('人格读不到 ⇒ 如实标注（不静默当没有）', badPersona.ok === false && composeTeamBrief({ brief: 'b', persona: badPersona }).includes('未能带上'), badPersona.note)

  // ---- 【三】探测与选择点 ---------------------------------------------------
  head('【三】探测与选择点（auto 的既有优先级不变）')
  const full = fakeHost()
  add('服务齐全 ⇒ probe ok / kind=team', probeTeamChannel(full.ctx).ok === true && probeTeamChannel(full.ctx).kind === 'team')
  const noTeams = fakeHost({ noTeams: true })
  const pNo = probeTeamChannel(noTeams.ctx)
  add('无 agentTeams ⇒ ok=false 且点名缺什么、明确"不降级"', pNo.ok === false && pNo.missing.length > 0 && pNo.note.includes('不静默降级'), pNo.note)
  add('显式 transport:"team" ⇒ 选到 team 通道', createTransport(full.ctx, mergeConfig({ transport: 'team' }), { tokens: createTokenStore({}) }).kind === TEAM_KIND)
  add('auto + teamAuto=false ⇒ **不**选 team（既有生产行为不变）', createTransport(full.ctx, mergeConfig({}), { tokens: createTokenStore({}) }).kind !== TEAM_KIND)
  add('auto + teamAuto=true ⇒ 先试 team', createTransport(full.ctx, mergeConfig({ teamAuto: true }), { tokens: createTokenStore({}) }).kind === TEAM_KIND)
  add('配置白名单认 team / session（显式值不再被静默改回 auto）', mergeConfig({ transport: 'team' }).transport === 'team' && mergeConfig({ transport: 'session' }).transport === 'session')
  add('teamNamePrefix 写坏 ⇒ 回落默认（不发出非法名字）', mergeConfig({ teamNamePrefix: 'BAD X' }).teamNamePrefix === 'p')

  // ---- 【四】spawn:false ⇒ 宿主零调用 --------------------------------------
  head('【四】`spawn:false` ⇒ 宿主**一次都没被调用**')
  {
    const h = fakeHost()
    const caller = makeCaller(h)
    const { transport, tokens } = fresh(h)
    const res = await transport.spawnRole(specOf({ spawn: false, parent: caller }))
    const hostCalls = h.calls.spawn.length + h.calls.send.length + h.calls.list.length + h.calls.permSet.length + h.calls.selectModel.length
    add('宿主调用总数为 0（spawn/send/list/perm/setModel 全 0）', hostCalls === 0, `calls=${hostCalls}`)
    add('返回机器可读判据 spawned===false、agentId===null', res.spawned === false && res.agentId === null && res.sessionId === null)
    add('still ok=true + 有令牌 + 有可粘贴派活单', res.ok === true && typeof res.token === 'string' && res.brief.includes('pipeline_bind_role'))
    add('via 标 manual（不冒充 team）', res.via === 'manual', res.via)
    add('令牌没绑任何会话（绑定语义没被破坏）', tokens.resolve(res.token, {}).rec.agentId === null)
  }

  // ---- 【五】正常 spawn -----------------------------------------------------
  head('【五】正常 spawn：合法名字 / 正文含令牌与人格 / member.id 绑定令牌')
  const h5 = fakeHost()
  const caller5 = makeCaller(h5)
  const t5 = fresh(h5)
  const r5 = await t5.transport.spawnRole(specOf({ parent: caller5 }))
  const spawnCall = h5.calls.spawn[0]
  add('spawnTeammate 被调用一次，caller 就是传进来的那个活 Agent', h5.calls.spawn.length === 1 && spawnCall.caller === caller5)
  add('请求体只有官方那 5 个字段（不塞 preset/permission/model）', JSON.stringify(Object.keys(spawnCall.req).sort()) === JSON.stringify(['context', 'description', 'name', 'prompt', 'provider', 'signal']), JSON.stringify(Object.keys(spawnCall.req)))
  add('name 合法 kebab、≤64、≠lead', /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(spawnCall.req.name) && spawnCall.req.name.length <= 64 && spawnCall.req.name !== TEAM_LEAD, spawnCall.req.name)
  add('prompt 是 ContentBlock[]，正文含**令牌**', Array.isArray(spawnCall.req.prompt) && spawnCall.req.prompt[0]?.type === 'text' && spawnCall.req.prompt[0].text.includes(r5.token))
  add('正文含**角色固定提示词**（人格随派活单投递）', r5.persona.ok === true && spawnCall.req.prompt[0].text.includes(persona.prefix.slice(0, 20)))
  add('description 非空且 ≤200（官方 requiredText）', typeof spawnCall.req.description === 'string' && spawnCall.req.description.length > 0 && spawnCall.req.description.length <= 200)
  add('context=fresh / provider=spawn（配置默认）', spawnCall.req.context === 'fresh' && spawnCall.req.provider === 'spawn')
  add('返回 ok / via=team / agentId=member.id', r5.ok === true && r5.via === TEAM_KIND && r5.agentId === 'sess-team-01', JSON.stringify({ ok: r5.ok, via: r5.via, agentId: r5.agentId }))
  add('令牌真的绑到了 member.id（转手即失效的既有判据）', t5.tokens.resolve(r5.token, { agentId: 'sess-team-01' }).ok === true && t5.tokens.resolve(r5.token, { agentId: 'someone-else' }).ok === false)
  add('via 进审计（channel:dispatched）', t5.auditLog.some((e) => e.action === 'channel:dispatched' && e.detail.via === TEAM_KIND))

  // ---- 【六】同名复用 / reassign -------------------------------------------
  head('【六】同名已存在 ⇒ 复用（不重复 spawn）；reassign ⇒ 新名 -r2')
  const h6 = fakeHost()
  const caller6 = makeCaller(h6)
  const t6 = fresh(h6)
  const first6 = await t6.transport.spawnRole(specOf({ parent: caller6 }))
  const r6b = await t6.transport.spawnRole(specOf({ parent: caller6 }))
  add('第二次派活**没有**再 spawn（名字已存在 ⇒ 复用）', h6.calls.spawn.length === 1, `spawn=${h6.calls.spawn.length}`)
  add('复用走官方 sendMessage（target = 那个名字）', h6.calls.send.length === 1 && h6.calls.send[0].req.target === h6.calls.spawn[0].req.name, JSON.stringify(h6.calls.send.map((c) => c.req.target)))
  add('返回 reused=true、agentId 仍是同一个 member', r6b.ok === true && r6b.reused === true && r6b.agentId === 'sess-team-01', JSON.stringify({ ok: r6b.ok, reused: r6b.reused, agentId: r6b.agentId }))
  add('复用交回**原来那枚令牌**（不新铸未绑定令牌 —— 否则该席位每个动作都会被拒）', typeof first6.token === 'string' && first6.token === r6b.token, `${first6.token} / ${r6b.token}`)
  const r6c = await t6.transport.spawnRole(specOf({ parent: caller6, reassign: true }))
  add('reassign ⇒ 换新名字 `-r2`（官方名字永不重用）', h6.calls.spawn.length === 2 && h6.calls.spawn[1].req.name === `${h6.calls.spawn[0].req.name}-r2`, h6.calls.spawn[1]?.req.name)

  // ---- 【七】失败面：无服务 / 无活 caller / 容量 ---------------------------
  head('【七】失败面：可读失败，**不静默降级**')
  {
    const h = fakeHost({ noTeams: true })
    const caller = makeCaller(h)
    const { transport } = fresh(h)
    const res = await transport.spawnRole(specOf({ parent: caller }))
    add('无 agentTeams ⇒ ok=false + unreachable=true + via=team', res.ok === false && res.unreachable === true && res.via === TEAM_KIND, JSON.stringify({ ok: res.ok, unreachable: res.unreachable }))
    add('报告是人话（点名缺 agentTeams、提替代通道）', res.report.includes('agentTeams') && res.report.includes("transport:'session'"), res.report.slice(0, 160))
  }
  {
    const h = fakeHost()
    makeCaller(h)
    const { transport } = fresh(h)
    const ghost = { id: 'sess-does-not-exist' }
    const res = await transport.spawnRole(specOf({ parent: ghost }))
    add('无活 caller ⇒ code=TEAM_NO_LIVE_CALLER', res.ok === false && res.code === 'TEAM_NO_LIVE_CALLER', res.code)
    add('无活 caller ⇒ 宿主 spawn 一次都没调', h.calls.spawn.length === 0)
    add('报告写明"机制派活走不通 + 两条出路"', res.report.includes('活着的 Lead Agent') && res.report.includes("transport:\"session\""), res.report.slice(0, 200))
  }
  {
    const h = fakeHost({ spawnThrows: 'TEAM_MEMBER_LIMIT' })
    const caller = makeCaller(h)
    const { transport } = fresh(h)
    const res = await transport.spawnRole(specOf({ parent: caller }))
    add('容量到顶 ⇒ 可读失败 + 保留失败码', res.ok === false && res.code === 'TEAM_MEMBER_LIMIT', res.code)
    add('报告写明 maxMembers / 已用人数 / 两条出路', res.report.includes('maxMembers') && res.report.includes('名单') && res.report.includes('新开一个主对话会话'), res.report.slice(0, 260))
    add('`TEAM_MEMBER_NAME_TAKEN` 也翻译成人话（点 reassign）', describeTeamError(Object.assign(new Error('taken'), { code: 'TEAM_MEMBER_NAME_TAKEN' })).report.includes('reassign'))
  }

  // ---- 【八】notifyRole：投递 / 截断 / interrupt ----------------------------
  head('【八】notifyRole：官方 sendMessage / 超长按字节截断 / stop ⇒ interrupt')
  {
    const h = fakeHost()
    const caller = makeCaller(h)
    const { transport } = fresh(h)
    const r = await transport.spawnRole(specOf({ parent: caller }))
    const n1r = await transport.notifyRole({ sessionId: r.agentId, sender: caller, message: '催办' })
    add('按 sessionId 反查名单拿到名字并投递', n1r.ok === true && h.calls.send.length === 1 && h.calls.send[0].req.target === h.calls.spawn[0].req.name, n1r.note)
    add('消息走官方 content block 形状', Array.isArray(h.calls.send[0].req.content) && h.calls.send[0].req.content[0].type === 'text')
    const huge = '字'.repeat(40000) // 3 字节/字 ⇒ 120000 字节，必然超 64KB
    const n2 = await transport.notifyRole({ sessionId: r.agentId, sender: caller, message: huge })
    const sent = h.calls.send[1].req.content[0].text
    add('超长正文被截断且总字节 ≤ 预算', n2.ok === true && Buffer.byteLength(sent, 'utf8') <= 65536 - 1024, `bytes=${Buffer.byteLength(sent, 'utf8')}`)
    add('截断**不静默**：正文尾部有标注、note 里也写明', sent.includes('已截断') && n2.note.includes('截断'))
    add('truncateUtf8 不切开代理对（emoji 不被截成半个）', (() => { const c = truncateUtf8('😀'.repeat(200), 300); return c.truncated === true && c.text.startsWith('😀') && !c.text.includes('\uFFFD') })())
    const n3 = await transport.notifyRole({ sessionId: r.agentId, sender: caller, stop: true, message: '停手' })
    add('stop:true ⇒ 走官方 interrupt（不是发句话当打断）', h.calls.interrupt.length === 1 && h.calls.interrupt[0].name === h.calls.spawn[0].req.name && n3.ok === true)
    const n4 = await transport.notifyRole({ sessionId: 'sess-nobody', sender: caller, message: 'x' })
    add('目标不在名单且无退路 ⇒ 如实失败（不假装已投）', n4.ok === false && n4.note.includes('找不到'), n4.note)
    // ★ `nudgeSeat` 那条路的真实形状：**没有 sender**（只给 sessionId）——
    //   必须能自己从活 Agent 里找到同一个 Team 的 Lead（否则"派得出去、叫不回来"复现）。
    const n5 = await transport.notifyRole({ sessionId: r.agentId, message: '催办（nudgeSeat 形状）' })
    add('没有 sender 也能投（nudgeSeat 形状：从活 Agent 里找 Lead）', n5.ok === true && h.calls.send.length === 3, n5.note)
  }
  {
    // ★ 可选能力缺失：`interrupt` 被关掉 ⇒ **退化成投"停手"消息**，且如实写"没有打断"。
    const h = fakeHost({ noInterrupt: true })
    const caller = makeCaller(h)
    const { transport } = fresh(h)
    const r = await transport.spawnRole(specOf({ parent: caller }))
    const n = await transport.notifyRole({ sessionId: r.agentId, sender: caller, stop: true, message: '停手' })
    add('interrupt 缺失 ⇒ 退化投递，且明说"这**不等于**已打断"', n.ok === true && h.calls.send.length === 1 && n.note.includes('不等于') && n.note.includes('没有打断'), n.note.slice(0, 160))
  }

  // ---- 【九】四槽 -----------------------------------------------------------
  head('【九】四槽：mode 恒 UNAVAILABLE / permission 读回 / teamStrictSlots 拒绝')
  add('`slotEvidence.mode` 记 UNAVAILABLE（01 §D3 的字面值）', r5.slotEvidence.mode === MODE_SLOT_UNAVAILABLE, r5.slotEvidence.mode)
  add('权限档钉上并**读回**（evidence=readback、值一致）', r5.slots.permission.ok === true && r5.slots.permission.readback === 'read-only' && r5.slotEvidence.permission === 'readback', JSON.stringify(r5.slots.permission))
  add('四槽行如实写"mode 确定没生效 + F1 原因"', r5.note.includes('UNAVAILABLE') && r5.note.includes('agentPreset'))
  add('模型未指定 ⇒ 不调用 selectModel、证据=未指定', h5.calls.selectModel.length === 0 && r5.slotEvidence.model === 'not_specified', String(r5.slotEvidence.model))
  {
    const h = fakeHost()
    const caller = makeCaller(h)
    const { transport } = fresh(h)
    const res = await transport.spawnRole(specOf({ parent: caller, model: { value: 'deepseek-official/deepseek-flash', origin: 'plan', isDefault: false } }))
    add('模型指定 ⇒ 按 member.id 下发，证据=已请求·未回读', h.calls.selectModel.length === 1 && h.calls.selectModel[0].sessionId === res.agentId && res.slotEvidence.model === 'requested', JSON.stringify(h.calls.selectModel))
  }
  {
    const h = fakeHost({ permissionReadback: 'workspace-write' })
    const caller = makeCaller(h)
    const { transport } = fresh(h)
    const res = await transport.spawnRole(specOf({ parent: caller }))
    add('权限读回不符 ⇒ 拒绝派活（不把"没钉上"当"钉上了"）', res.ok === false && res.code === 'TEAM_SLOT_UNPINNED' && res.report.includes('读回不符'), res.code)
  }
  {
    const h = fakeHost()
    const caller = makeCaller(h)
    const { transport } = fresh(h, { teamStrictSlots: true })
    const res = await transport.spawnRole(specOf({ parent: caller }))
    add('teamStrictSlots:true + 显式 mode ⇒ 拒绝派活（mode 恒钉不上）', res.ok === false && res.code === 'TEAM_SLOT_UNPINNED' && res.report.includes('teamStrictSlots'), res.code)
    add('拒绝报告写明 teammate 已建出、要求人工处置', res.report.includes('已经建出来了'))
  }

  // ---- 【十】任务板镜像：best-effort（不阻断派活）---------------------------
  head('【十】任务板镜像 best-effort（WP-B 未交付 / 失败 ⇒ skipped，不改变派活结果）')
  {
    const h = fakeHost()
    const caller = makeCaller(h)
    const { transport } = fresh(h, { teamBoard: 'auto' })
    const res = await transport.spawnRole(specOf({ parent: caller }))
    add('teamBoard:auto ⇒ 镜像缺失或失败都不改变派活结果（ok 仍为 true）', res.ok === true && res.board !== undefined && typeof res.board.note === 'string', JSON.stringify(res.board))
    add('镜像结论在 note 里如实写出（不静默略过）', res.note.includes('任务板镜像：'), res.note.slice(-200))
  }

  return { passed, total, text: lines.join('\n') }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (invokedDirectly) {
  runTeamTransportCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
