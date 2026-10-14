/**
 * dsh-pipeline · F11：四槽「声明 vs 生效」必须同源，且文案不许自称读过没读过的东西
 * ============================================================================
 *     node tests/f11-slot-truth-check.mjs
 *
 * 真机现场（T-20261015-bb30bc，用户报的）：
 *   ① 主对话派 writer / tester / reviewer 时**显式传了 `permission=workspace-write`**；
 *   ② 派活返回写着「权限档 = workspace-write（计划指定）；读回核对一致（workspace-write）」；
 *   ③ 审核位回查 `roster.slots` 却是 **三席全 `read-only`（origin: default）**。
 *   ⇒ 同一份数据两个真相，而文案让读者以为两边一致。
 *
 * ★★ 本文件**刻意只 import 旧代码里就有的东西**（`SessionTransport`），
 *   断言**只打在可观测契约上**（派活返回值 + 落盘后的 task JSON）——
 *   这样同一份测试拿到改前的代码上会**因为行为不符而红**（实测 3/11），
 *   而不是"模块不存在"那种假红。
 *
 * 它钉住六件事：
 *   A 四槽各自带**证据等级**，且 model / reasoning **不许**被说成"读回一致"
 *   B `mode` 是真读回：宿主回读成**别的值**时必须拒绝派活（证伪"回显入参"）
 *   C `permission` 是真读回：同样用"回读成别的值"来证伪"回显"
 *   D `mode` **事前**校验：宿主上不存在的 preset 在**建会话之前**就被拦住，并交回合法取值
 *   E 名单声明与本次派活不一致时，文案必须**明说**不一致
 *   F 落盘：同键的 `roster.slots_effective` 可查实际生效值，且**冻结的声明表一个字节不动**
 *
 * ★ 全程用**假宿主**（自己搭的 ctx）：不建真会话、不碰任何活体真单。
 */

import { pathToFileURL } from 'node:url'

import { SessionTransport } from '../lib/transport/index.js'

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
      const L = ['dsh-pipeline · F11：四槽「声明 vs 生效」同源 + 证据等级', '='.repeat(78)]
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

// ---------------------------------------------------------------------------
// 假的宿主：一个"有会话头、有权限档、有 preset 注册表"的最小 ctx
// ---------------------------------------------------------------------------
function makeHost(opts = {}) {
  const calls = { create: [], set: [], selectModel: [], resolve: [] }
  /** 宿主上真实存在的 preset（`agentPresets.list()` 的返回面）。 */
  const presetIds = opts.presetIds ?? ['standard', 'computer-use']
  /** 会话头读回来的 agentPreset —— 默认**如实**等于创建时请求的那个。 */
  const headerPreset = (requested) => (opts.headerEcho === false ? (opts.headerValue ?? 'standard') : requested)
  /** `permissionPresets.current()` 读回来的档 —— 默认**如实**等于 set 进去的那个。 */
  const readbackPermission = (want) => (opts.permissionEcho === false ? (opts.permissionValue ?? 'read-only') : want)

  const sessions = new Map()
  const sessionOf = (id) => sessions.get(id) ?? { id }

  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async create(args) {
            calls.create.push(args)
            if (opts.createThrows === true) throw new Error('宿主拒绝了 create')
            const id = `sess-${sessions.size + 1}`
            // ★ 关键：读回的值由 headerPreset 决定 —— 传 false 就能模拟"宿主静默回落"
            sessions.set(id, { agentPreset: headerPreset(args?.agentPreset), id })
            return { sessionId: id }
          },
          async prompt() {
            return { accepted: true }
          },
          /**
           * ★ 模型槽：宿主**只收请求、不给读回**接口 —— 这正是真机上的形状，
           *   也是"model / reasoning 从来没被回读过"这条结论的来源。
           */
          async selectModel(args) {
            calls.selectModel.push(args)
            if (opts.selectModelThrows === true) throw new Error('宿主拒绝了 selectModel')
          },
          async inspect(id) {
            const s = sessionOf(id)
            return { meta: { origin: 'user', agentPreset: s.agentPreset ?? null, workspaceId: s.workspaceId ?? 'ws-1', cwd: null } }
          },
        }
      }
      if (name === 'workspaceRegistry') {
        return { async create() { return { id: 'ws-1' } } }
      }
      if (name === 'permissionPresets') {
        return {
          async set(obj, want) {
            calls.set.push({ id: obj?.id ?? null, want })
            if (opts.setThrows === true) throw new Error('档名不在宿主档表里')
            sessionOf(obj?.id).permission = want
          },
          current(obj) {
            if (opts.noPermissionCurrent === true) return undefined
            const cur = sessionOf(obj?.id).permission ?? null
            return cur === null ? null : readbackPermission(cur)
          },
        }
      }
      if (name === 'agents') return { get: (id) => sessionOf(id) }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }), async saveSelection() {} }
      }
      if (name === 'agentPresets') {
        if (opts.noPresetService === true) return null
        return {
          defaultId: 'standard',
          async list() { return presetIds.map((id) => ({ id })) },
          async resolve(id) {
            calls.resolve.push(id)
            if (presetIds.includes(id)) return { id }
            const err = new Error(`Unknown agent preset: ${id}`)
            err.available = presetIds
            throw err
          },
        }
      }
      return null
    },
  }
  return { ctx, calls }
}

const makeTransport = (ctx) =>
  new SessionTransport({
    ctx,
    config: { projectRoot: process.cwd() },
    audit: () => {},
    tokens: { mint: () => ({ token: 'tok-test' }) },
  })

/** 真机那台单子上的名单形状：三席全是 `read-only` + `origin: default` 的**占位值**。 */
const buildRoster = () => ({
  slots_version: 1,
  slots_digest: 'deadbeef',
  slots: {
    writer: { permission: 'read-only', mode: 'standard', model: null, reasoning: null, origin: 'default' },
    tester: { permission: 'read-only', mode: 'standard', model: null, reasoning: null, origin: 'default' },
    'reviewer@1': { permission: 'read-only', mode: 'standard', model: null, reasoning: null, origin: 'default' },
  },
})

const TASK = Object.freeze({ id: 'T-F11-test', project_root: process.cwd() })

export async function runF11SlotTruthCheck() {
  const rec = createRecorder()
  const spawn = async (ctx, spec, roster) =>
    makeTransport(ctx).spawnRole({ task: { ...TASK, roster }, roster, role: 'writer', seat: null, ...spec })

  // ---- A -------------------------------------------------------------------
  {
    const G = 'A 四槽逐槽给证据等级（用户那个尖锐问题的正面回答）'
    try {
      const { ctx } = makeHost()
      const res = await spawn(ctx, { permission: 'workspace-write', mode: 'standard', model: 'deepseek/chat', reasoning: 'high' }, buildRoster())
      rec.add(G, 'A1 派活成功，且返回值带**结构化**四槽证据（不是散在文案里）', res.ok === true && res.slotEvidence !== null && res.slotEvidence !== undefined, `ok=${res.ok} slotEvidence=${JSON.stringify(res.slotEvidence ?? null)}`)
      rec.add(G, '★ A2 permission 是真读回（readback）', res.slotEvidence?.permission === 'readback', `实际 ${res.slotEvidence?.permission}`)
      rec.add(G, '★ A3 mode 是真读回（readback，会话头）', res.slotEvidence?.mode === 'readback', `实际 ${res.slotEvidence?.mode}`)
      rec.add(G, '★★ A4 model 只是"已请求"，**没有回读**', res.slotEvidence?.model === 'requested', `实际 ${res.slotEvidence?.model}`)
      rec.add(G, '★★ A5 reasoning 只是"已请求"，**没有回读**', res.slotEvidence?.reasoning === 'requested', `实际 ${res.slotEvidence?.reasoning}`)
      const note = String(res.note)
      const modelLine = note.split('\n').find((l) => l.includes('模型')) ?? ''
      const reasonLine = note.split('\n').find((l) => l.includes('推理等级')) ?? ''
      rec.add(G, '★★ A6 模型那一行必须写明"未回读"', modelLine.includes('未回读'), modelLine)
      rec.add(G, '★★ A7 模型那一行**不许**出现"核对一致"（从来没读过，凭什么一致）', !modelLine.includes('核对一致'), modelLine)
      rec.add(G, '★ A8 推理等级那一行必须写明"未回读"', reasonLine.includes('未回读'), reasonLine)
    } catch (err) {
      rec.add(G, '!! 执行异常', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
  }

  // ---- B -------------------------------------------------------------------
  {
    const G = 'B mode 是"真读回"还是"回显"—— 用"回读成别的值"来证伪'
    try {
      const { ctx } = makeHost({ headerEcho: false, headerValue: 'standard' })
      const res = await spawn(ctx, { permission: 'read-only', mode: 'computer-use' }, buildRoster())
      rec.add(G, '★ B1 宿主把模式**回落**成别的档 ⇒ 必须拒绝派活（这就是"真读回"的判据）', res.ok === false, `ok=${res.ok}`)
      rec.add(G, '★ B2 理由里点名请求值与读回值', /computer-use/.test(String(res.note)), String(res.note).split('\n')[0])
    } catch (err) {
      rec.add(G, '!! 执行异常', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
    try {
      const { ctx } = makeHost()
      const res = await spawn(ctx, { permission: 'read-only', mode: 'computer-use' }, buildRoster())
      const modeLine = String(res.note).split('\n').find((l) => l.includes('模式')) ?? ''
      rec.add(G, 'B3 宿主如实回读时，模式行带上读回来的值', res.ok === true && modeLine.includes('computer-use'), modeLine)
    } catch (err) {
      rec.add(G, '!! 执行异常(2)', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
  }

  // ---- C -------------------------------------------------------------------
  {
    const G = 'C permission 同样是真读回'
    try {
      const { ctx } = makeHost({ permissionEcho: false, permissionValue: 'read-only' })
      const res = await spawn(ctx, { permission: 'workspace-write', mode: 'standard' }, buildRoster())
      rec.add(G, '★ C1 宿主回读成别的档 ⇒ 拒绝派活（同样证伪"回显"）', res.ok === false && /读回不符/.test(String(res.note)), `ok=${res.ok} ${String(res.note).split('\n')[0]}`)
    } catch (err) {
      rec.add(G, '!! 执行异常', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
    try {
      const { ctx } = makeHost({ noPermissionCurrent: true })
      const res = await spawn(ctx, { permission: 'workspace-write', mode: 'standard' }, buildRoster())
      const permLine = String(res.note).split('\n').find((l) => l.includes('权限档')) ?? ''
      rec.add(G, '★ C2 宿主没有 current() ⇒ 如实说"未读回"，**不许**说"一致"', res.ok === true && res.slotEvidence?.permission === 'readback_unavailable' && permLine.includes('未读回') && !permLine.includes('核对一致'), permLine)
    } catch (err) {
      rec.add(G, '!! 执行异常(2)', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
  }

  // ---- D -------------------------------------------------------------------
  {
    const G = 'D 不存在的 preset：必须**在建会话之前**拦住，并交回合法取值'
    try {
      const { ctx, calls } = makeHost()
      const res = await spawn(ctx, { permission: 'read-only', mode: '__no_such_preset__' }, buildRoster())
      const text = String(res.note)
      rec.add(G, '★ D1 请求宿主上不存在的 preset ⇒ 拒绝派活', res.ok === false, `ok=${res.ok}`)
      rec.add(G, '★★ D2 必须在**建会话之前**就拦住（create 一次都没被调用）', calls.create.length === 0, `create 调用次数=${calls.create.length}`)
      rec.add(G, '★ D3 说清"校验过了"（不是"没校验成"）', res.presetCheck?.checked === true, JSON.stringify(res.presetCheck ?? null))
      rec.add(G, '★ D4 把**合法取值**交回给调用方', text.includes('standard') && text.includes('computer-use'), text.split('\n').slice(0, 4).join(' / '))
    } catch (err) {
      rec.add(G, '!! 执行异常', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
    try {
      const { ctx, calls } = makeHost({ noPresetService: true })
      const res = await spawn(ctx, { permission: 'read-only', mode: 'standard' }, buildRoster())
      rec.add(G, '★ D5 宿主没暴露 agentPresets ⇒ 如实标注"未校验"，**不拦**派活（探测不到 ≠ 名字是错的）', res.ok === true && res.presetCheck?.checked === false && calls.create.length === 1 && /未校验/.test(String(res.note)), `ok=${res.ok} checked=${res.presetCheck?.checked} create=${calls.create.length}`)
    } catch (err) {
      rec.add(G, '!! 执行异常(2)', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
  }

  // ---- E -------------------------------------------------------------------
  {
    const G = 'E 名单声明与本次派活背离时必须明说（改前只说"核对一致"）'
    try {
      const { ctx } = makeHost()
      const res = await spawn(ctx, { permission: 'workspace-write', mode: 'standard' }, buildRoster())
      const text = String(res.note)
      rec.add(G, '★★ E1 名单写 read-only、实际 workspace-write ⇒ 文案必须说"不一致"', text.includes('不一致'), text.split('\n').filter((l) => l.includes('名单')).join(' / ').slice(0, 200))
      rec.add(G, '★ E2 要点明"名单是声明表"', text.includes('声明表'), '')
    } catch (err) {
      rec.add(G, '!! 执行异常', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
    try {
      const { ctx } = makeHost()
      const res = await spawn(ctx, { permission: 'read-only', mode: 'standard' }, buildRoster())
      rec.add(G, '★ E3 名单与派活一致时，才可以说"一致"', String(res.note).includes('名单（roster.slots）与本次派活一致'), '')
    } catch (err) {
      rec.add(G, '!! 执行异常(2)', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
  }

  // ---- F -------------------------------------------------------------------
  {
    const G = 'F 落盘：同键"实际生效值"表 + 冻结的声明表一个字节不动'
    try {
      const mod = await import('../lib/store/dispatch-slots.js')
      const roster = buildRoster()
      const before = JSON.parse(JSON.stringify(roster))
      const task = { id: TASK.id, roster, dispatch_slots: [], history: [], project_root: process.cwd() }
      const store = mod.dispatchSlotMethods({
        now: () => new Date('2026-10-15T02:00:00Z'),
        audit: async () => ({ at: '2026-10-15T02:00:00Z', action: 'dispatch:slots', detail: {} }),
        deny: (code, msg) => ({ ok: false, code, error: msg }),
        loadTask: async () => task,
        persist: async () => {},
      })
      const res = await store.recordDispatchSlots({
        taskId: task.id,
        role: 'writer',
        seat: null,
        slots: { permission: 'workspace-write', mode: 'standard', model: 'deepseek/chat', reasoning: 'high' },
        provenance: {
          permission: { value: 'workspace-write', origin: 'request' },
          mode: { value: 'standard', origin: 'declared' },
          model: { value: 'deepseek/chat', origin: 'request' },
          reasoning: { value: 'high', origin: 'request' },
        },
        divergences: [{ slot: 'permission', declared: 'read-only', declared_origin: 'default', resolved: 'workspace-write' }],
        evidence: { permission: 'readback', mode: 'readback', model: 'requested', reasoning: 'requested' },
        actorRole: 'main',
      })
      const cell = task.roster.slots_effective?.writer
      rec.add(G, '★ F1 落盘成功', res.ok === true, JSON.stringify(res).slice(0, 160))
      rec.add(G, '★★ F2 有**同键**的 slots_effective 表（一次查找两个真相都看得到）', cell !== undefined && cell !== null, `keys=${Object.keys(task.roster.slots_effective ?? {}).join(',')}`)
      rec.add(G, '★ F3 表里记的是**实际生效值**', cell?.effective?.permission === 'workspace-write', JSON.stringify(cell?.effective ?? null))
      rec.add(G, '★★ F4 证据等级一起落盘（model 是 requested，不许被读成"已确认")', cell?.evidence?.model === 'requested' && cell?.evidence?.permission === 'readback', JSON.stringify(cell?.evidence ?? null))
      rec.add(G, '★ F5 标明这个席位在声明表里**有没有**条目', cell?.declared_present === true, `declared_present=${cell?.declared_present}`)
      rec.add(G, '★★ F6 冻结的声明表 roster.slots **一个字节不动**', JSON.stringify(task.roster.slots) === JSON.stringify(before.slots), '')
      rec.add(G, '★★ F7 摘要与版本号不许变（否则"冻结"成废纸）', task.roster.slots_digest === before.slots_digest && task.roster.slots_version === before.slots_version, `digest=${task.roster.slots_digest} version=${task.roster.slots_version}`)
      rec.add(G, '★ F8 流水照旧只追加（dispatch_slots 里有一条完整记录）', Array.isArray(task.dispatch_slots) && task.dispatch_slots.length === 1 && task.dispatch_slots[0].divergences.length === 1, `len=${task.dispatch_slots?.length}`)
    } catch (err) {
      rec.add(G, '!! 执行异常', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
  }

  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF11SlotTruthCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
