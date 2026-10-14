/**
 * dsh-pipeline · F12：`spawn=false` 必须**真的**不建会话
 * ============================================================================
 *     node tests/f12-spawn-false-check.mjs
 *
 * 真机现场（T-20261015-slotprobe，用户报的）：
 *   用户**显式传了 `spawn=false`**，工具文档的原话是「是否真的创建会话」、
 *   工具描述也写着「transport=manual（或 spawn_roles=false）时**只返回一段可粘贴的派活单**」，
 *   但返回是：
 *     `# 拒绝派活：会话建不出来 … 宿主 sessionController.create 失败：Unknown agent preset: …`
 *   ⇒ **宿主 create 被调用了**。失败信息本身就在说"我试过了"。
 *
 * 根因：`pipeline_dispatch` 里
 *     `if (!spawn || !isSpawnableRole(role)) spawnRole({… agentId: null})
 *      else                                  spawnRole({… parent})`
 *   —— **两个分支调的是同一个方法**，只有两个字段不同；而 `SessionTransport.spawnRole`
 *   根本不看 `agentId`，无条件 `controller.create`。
 *
 * 本套钉住：
 *   A `spawn=false` ⇒ 宿主的 `create` **一次都没被调用**（机器可读判据 `spawned === false`）
 *   B `spawn=false` ⇒ 仍然可用：拿到令牌 + 可粘贴的派活单（不是"什么都不干"）
 *   C 不给 / `spawn=true` ⇒ 照旧建会话（**没有把正常路径一起关掉**）
 *   D 子代理通道同样守这条线（`subagents.start*` 一次都不许调）
 *   E 没建会话时**不留半派**：`agentId` 为 null，不假装绑定了会话
 *
 * ★ 用假宿主（自己搭的 ctx），不建真会话、不碰任何活体真单。
 */

import { pathToFileURL } from 'node:url'

import { SessionTransport, SubagentTransport } from '../lib/transport/index.js'

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
      const L = ['dsh-pipeline · F12：spawn=false 必须真的不建会话', '='.repeat(78)]
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

/** 假宿主：**数** `sessionController.create` 被调用了几次。 */
function makeHost() {
  const calls = { create: [], prompt: [], subagentStart: [] }
  const sessions = new Map()
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async create(args) {
            calls.create.push(args)
            const id = `sess-${sessions.size + 1}`
            sessions.set(id, { id, agentPreset: args?.agentPreset })
            return { sessionId: id }
          },
          async prompt(a) {
            calls.prompt.push(a)
            return { accepted: true }
          },
          async inspect(id) {
            return { meta: { origin: 'user', agentPreset: sessions.get(id)?.agentPreset ?? null, workspaceId: 'ws-1', cwd: null } }
          },
          async selectModel() {},
        }
      }
      if (name === 'workspaceRegistry') return { async create() { return { id: 'ws-1' } } }
      if (name === 'permissionPresets') {
        return { async set(obj, want) { sessions.get(obj?.id).permission = want }, current: (obj) => sessions.get(obj?.id)?.permission ?? null }
      }
      if (name === 'agents') return { get: (id) => sessions.get(id) ?? { id } }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }), async saveSelection() {} }
      if (name === 'agentPresets') return { defaultId: 'standard', async list() { return [{ id: 'standard' }] } }
      if (name === 'subagents') {
        return {
          async startContinuable() {
            calls.subagentStart.push('continuable')
            return { childId: 'child-1' }
          },
          async start() {
            calls.subagentStart.push('start')
            return { id: 'child-2' }
          },
        }
      }
      return null
    },
  }
  return { ctx, calls, sessions }
}

const tokens = {
  mint: () => ({ token: 'tok-f12' }),
  bindAgent: () => {},
}

const TASK = Object.freeze({ id: 'T-F12-test', project_root: process.cwd() })
const ROSTER = Object.freeze({ slots: { writer: { permission: 'read-only', mode: 'standard', model: null, reasoning: null, origin: 'default' } } })

export async function runF12SpawnFalseCheck() {
  const rec = createRecorder()
  const specOf = (extra) => ({ task: TASK, roster: ROSTER, role: 'writer', seat: null, permission: 'workspace-write', mode: 'standard', ...extra })

  // ---- A / B / C：真实会话通道 ---------------------------------------------
  {
    const G = 'A 真实会话通道：spawn=false 不许碰宿主 create'
    try {
      const h = makeHost()
      const t = new SessionTransport({ ctx: h.ctx, config: { projectRoot: process.cwd() }, audit: () => {}, tokens })
      const res = await t.spawnRole(specOf({ spawn: false }))
      rec.add(G, '★★ A1 宿主的 sessionController.create **一次都没被调用**', h.calls.create.length === 0, `create 调用次数=${h.calls.create.length}`)
      rec.add(G, '★★ A2 返回值带机器可读判据 spawned === false（不靠读文案）', res.spawned === false, `spawned=${JSON.stringify(res.spawned)}`)
      rec.add(G, '★ A3 没有会话被建出来（宿主那边也查不到）', h.sessions.size === 0, `sessions=${h.sessions.size}`)
      rec.add(G, '★ A4 也不许投派活单（prompt 同样一次都不该调）', h.calls.prompt.length === 0, `prompt=${h.calls.prompt.length}`)
      rec.add(G, '★ A5 agentId / sessionId 都是 null（没建就是没建）', res.agentId === null && res.sessionId === null, `agentId=${res.agentId} sessionId=${res.sessionId}`)
      rec.add(G, '★★ B1 仍然可用：ok=true + 拿到令牌', res.ok === true && typeof res.token === 'string' && res.token.length > 0, `ok=${res.ok} token=${res.token}`)
      rec.add(G, '★★ B2 产出了**可粘贴的派活单**（brief 非空，且文案里带 ``` 代码块）', typeof res.brief === 'string' && res.brief.length > 0 && String(res.note).includes('```'), `brief 长度=${res.brief?.length}`)
      rec.add(G, '★ B3 文案如实说"没有创建任何会话"', /没有创建任何会话/.test(String(res.note)), String(res.note).split('\n')[0])
      rec.add(G, '★ B4 via 标成 manual（不是冒充 session/subagent）', res.via === 'manual', `via=${res.via}`)
    } catch (err) {
      rec.add(G, '!! 执行异常', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
    try {
      const h = makeHost()
      const t = new SessionTransport({ ctx: h.ctx, config: { projectRoot: process.cwd() }, audit: () => {}, tokens })
      const res = await t.spawnRole(specOf({ spawn: true }))
      rec.add(G, '★★ C1 不给 spawn=false 时**照旧**建会话（没有把正常路径一起关掉）', h.calls.create.length === 1 && res.ok === true, `create=${h.calls.create.length} ok=${res.ok}`)
      rec.add(G, '★ C2 正常路径的返回值**不带** spawned:false', res.spawned !== false, `spawned=${JSON.stringify(res.spawned)}`)
    } catch (err) {
      rec.add(G, '!! 执行异常(2)', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
  }

  // ---- D：子代理通道 -------------------------------------------------------
  {
    const G = 'D 子代理通道同样守这条线'
    try {
      const h = makeHost()
      const t = new SubagentTransport({ ctx: h.ctx, config: { subagentProvider: 'spawn' }, audit: () => {}, tokens })
      const res = await t.spawnRole(specOf({ spawn: false, parent: { id: 'p' } }))
      rec.add(G, '★★ D1 spawn=false ⇒ subagents.start* 一次都没被调用', h.calls.subagentStart.length === 0, `start 调用=${JSON.stringify(h.calls.subagentStart)}`)
      rec.add(G, '★ D2 带 spawned === false', res.spawned === false, `spawned=${JSON.stringify(res.spawned)}`)
      rec.add(G, '★ D3 仍然产出可粘贴的派活单', typeof res.brief === 'string' && res.brief.length > 0 && /没有创建任何会话/.test(String(res.note)), `brief 长度=${res.brief?.length}`)
    } catch (err) {
      rec.add(G, '!! 执行异常', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
  }

  // ---- E：不留半派 ---------------------------------------------------------
  {
    const G = 'E 没建会话就不许假装绑定了会话'
    try {
      const h = makeHost()
      const t = new SessionTransport({ ctx: h.ctx, config: { projectRoot: process.cwd() }, audit: () => {}, tokens })
      const res = await t.spawnRole(specOf({ spawn: false }))
      rec.add(G, '★ E1 权威判据只有一处：spawned===false 且 agentId===null 且 sessionId===null', res.spawned === false && res.agentId === null && res.sessionId === null, JSON.stringify({ spawned: res.spawned, agentId: res.agentId, sessionId: res.sessionId }))
      rec.add(G, '★ E2 group / binding 这类"会话侧产物"不许出现（它们只对真会话有意义）', res.group === undefined && res.binding === undefined, `group=${typeof res.group} binding=${typeof res.binding}`)
    } catch (err) {
      rec.add(G, '!! 执行异常', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
  }

  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF12SpawnFalseCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
