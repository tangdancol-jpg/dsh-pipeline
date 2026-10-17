// 缺陷 ③ 回归：名单里"未声明"的 model / reasoning 槽是占位哨兵，不许当模型名下发给宿主。
/**
 * dsh-pipeline · F14：model 槽哨兵 `environment-default` 不下发
 * ============================================================================
 *     node tests/f14-model-sentinel-check.mjs
 *
 * 现场（T-20261016-ff9ba7）：计划没声明 model ⇒ 名单落 `{value:'environment-default', origin:'default'}`
 *   ⇒ `resolveEffectiveSlots` 只要 `declared !== null` 就照抄 ⇒ 通道拿哨兵去 `selectModel`
 *   ⇒ 宿主拒「Select an available model before sending a message.」⇒ 任何默认档派活必然失败。
 *
 * 钉住四件事：
 *   ③-A 端到端：默认档派活**成功**，宿主一次 selectModel 都没收到，审计里没有 `channel:model_failed`
 *   ③-B 单元：`origin=default` 的哨兵**不进** `slots`，但 `provenance` 仍记得出"这一槽是占位"
 *   ③-C 反向：显式声明的 model 照旧下发（别把声明也挡掉）
 *   ③-D 反向：权限 / 模式的默认档**照旧下发**（只挡哨兵，不顺手放宽别的槽）
 *
 * ★ 全程用假宿主，不建真会话、不碰活体真单。
 */

import { pathToFileURL } from 'node:url'

import { SLOT_ENV_DEFAULT_SENTINEL, resolveEffectiveSlots } from '../lib/roster/slot-truth.js'
import { ROSTER_ENV_DEFAULT } from '../lib/tiers/roster-slots.js'
import { dispatchSlotPlan } from '../lib/tools/dispatch-slots.js'
import { buildRoster } from '../lib/tiers.js'
import { SessionTransport } from '../lib/transport/index.js'

const SENTINEL = 'environment-default'
const HOST_REJECT = 'Select an available model before sending a message.'

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
      const L = ['dsh-pipeline · F14：model 槽哨兵不下发（缺陷 ③）', '='.repeat(78)]
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

/** 假宿主：认得 `deepseek/deepseek-chat`；收到哨兵这种"部署里不存在的模型"就照真机原文拒。 */
function makeHost() {
  const calls = { selectModel: [] }
  const sessions = new Map()
  const sessionOf = (id) => sessions.get(id) ?? { id }
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async create(args) {
            const id = `sess-${sessions.size + 1}`
            sessions.set(id, { id, agentPreset: args?.agentPreset })
            return { sessionId: id }
          },
          async prompt() {
            return { accepted: true }
          },
          async selectModel(args) {
            calls.selectModel.push(args)
            if (args?.model !== 'deepseek-chat') throw new Error(HOST_REJECT)
          },
          async inspect(id) {
            const s = sessionOf(id)
            return { meta: { origin: 'user', agentPreset: s.agentPreset ?? null, workspaceId: 'ws-1', cwd: null } }
          },
        }
      }
      if (name === 'workspaceRegistry') return { async create() { return { id: 'ws-1' } } }
      if (name === 'permissionPresets') {
        return {
          async set(obj, want) { sessionOf(obj?.id).permission = want },
          current(obj) { return sessionOf(obj?.id).permission ?? null },
        }
      }
      if (name === 'agents') return { get: (id) => sessionOf(id) }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }), async saveSelection() {} }
      if (name === 'agentPresets') {
        return {
          defaultId: 'standard',
          async list() { return [{ id: 'standard' }, { id: 'pl-writer' }] },
          async resolve(id) { return { id } },
        }
      }
      return null
    },
  }
  return { ctx, calls }
}

/** 照 `lib/tools/dispatch.js` 的取槽链路组装一次派活：名单 ⇒ dispatchSlotPlan ⇒ resolveEffectiveSlots ⇒ 通道。 */
async function dispatchLikeTool(roster, role, seat, args = {}) {
  const task = { id: 'T-F14', project_root: process.cwd(), roster }
  const plan = dispatchSlotPlan(task, role, seat, args)
  const truth = resolveEffectiveSlots({ roster, role, seat, requested: plan.slots, origins: plan.origins })
  const { ctx, calls } = makeHost()
  const audits = []
  const transport = new SessionTransport({
    ctx,
    config: { projectRoot: process.cwd() },
    audit: (rec) => audits.push(rec),
    tokens: { mint: () => ({ token: 'tok-f14' }) },
  })
  const res = await transport.spawnRole({ task, roster, role, seat, ...truth.slots })
  return { res, truth, calls, audits }
}

export async function runF14ModelSentinelCheck() {
  const rec = createRecorder()
  const built = buildRoster({ tier: 'L1', reason: 'F14 夹具：计划没写 model / reasoning', judgedBy: 'planner' })
  const roster = built.roster

  {
    const G = '③-A 端到端：默认档派活不再撞 model_failed'
    try {
      const cell = roster?.slots?.['writer@writer#1']?.model
      rec.add(G, '夹具：名单里 writer#1 的 model 槽确实是哨兵占位（origin=default）', cell?.value === SENTINEL && cell?.origin === 'default', JSON.stringify(cell))
      const { res, calls, audits } = await dispatchLikeTool(roster, 'writer', 'writer#1')
      rec.add(G, '★★ 派活成功', res.ok === true, `ok=${res.ok}\n${String(res.note ?? '').split('\n').slice(0, 3).join('\n')}`)
      rec.add(G, '★★ 宿主一次 selectModel 都没收到（会话沿用环境默认档）', calls.selectModel.length === 0, JSON.stringify(calls.selectModel))
      rec.add(G, '★ 审计里没有 channel:model_failed', !audits.some((a) => a.action === 'channel:model_failed'), audits.map((a) => a.action).join(' / '))
    } catch (err) {
      rec.add(G, '!! 执行异常', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
  }

  {
    const G = '③-B 单元：origin=default 的哨兵不进 slots，来源照记'
    const r = {
      slots: {
        writer: {
          model: { value: SENTINEL, declared: false, origin: 'default' },
          reasoning: { value: SENTINEL, declared: false, origin: 'default' },
          permission: { value: 'workspace-write', declared: true, origin: 'declared' },
        },
      },
    }
    const out = resolveEffectiveSlots({ roster: r, role: 'writer', seat: null, requested: {} })
    rec.add(G, '★★ slots 里没有 model 这个键', !('model' in out.slots), JSON.stringify(out.slots))
    rec.add(G, '★★ slots 里没有 reasoning 这个键', !('reasoning' in out.slots), JSON.stringify(out.slots))
    rec.add(G, '★ 显式声明的 permission 照旧下发', out.slots.permission === 'workspace-write', JSON.stringify(out.slots))
    rec.add(G, '★ provenance 仍记得出 model 是占位（origin=default）', out.provenance.model?.origin === 'default', JSON.stringify(out.provenance.model))
    rec.add(G, '★ 闸门认的哨兵值与名单落的占位值是同一个（两处字面量不许漂移）', SLOT_ENV_DEFAULT_SENTINEL === ROSTER_ENV_DEFAULT, `${SLOT_ENV_DEFAULT_SENTINEL} vs ${ROSTER_ENV_DEFAULT}`)
  }

  {
    const G = '③-C 反向：显式声明的 model 照旧下发'
    const declared = buildRoster({ tier: 'L1', reason: 'F14 夹具：显式声明 model', judgedBy: 'planner', slots: { 'writer@writer#1': { model: 'deepseek/deepseek-chat', reasoning: 'high' } } })
    const r2 = declared.ok === true ? declared.roster : null
    rec.add(G, '夹具：名单接受了显式声明', r2?.slots?.['writer@writer#1']?.model?.origin === 'declared', declared.ok === true ? JSON.stringify(r2?.slots?.['writer@writer#1']?.model) : String(declared.error))
    const out = resolveEffectiveSlots({ roster: r2, role: 'writer', seat: 'writer#1', requested: {} })
    rec.add(G, '★★ slots.model 等于声明值', out.slots.model === 'deepseek/deepseek-chat', JSON.stringify(out.slots))
    rec.add(G, '★ slots.reasoning 等于声明值', out.slots.reasoning === 'high', JSON.stringify(out.slots))
    try {
      const { res, calls } = await dispatchLikeTool(r2, 'writer', 'writer#1')
      rec.add(G, '★ 端到端：宿主收到的就是声明的那个模型', res.ok === true && calls.selectModel.length === 1 && calls.selectModel[0].model === 'deepseek-chat', JSON.stringify(calls.selectModel))
    } catch (err) {
      rec.add(G, '!! 执行异常', false, String(err?.stack ?? err).split('\n').slice(0, 6).join('\n'))
    }
  }

  {
    const G = '③-D 反向：只挡哨兵，别的槽的默认档照旧'
    const r = {
      slots: {
        tester: {
          permission: { value: 'read-only', declared: false, origin: 'default' },
          mode: { value: 'standard', declared: false, origin: 'default' },
          model: { value: SENTINEL, declared: false, origin: 'default' },
        },
      },
    }
    const out = resolveEffectiveSlots({ roster: r, role: 'tester', seat: null, requested: {} })
    rec.add(G, '★ 权限的默认档（最小档）照旧下发 —— 不能因为修 ③ 把权限放宽成"交给环境"', out.slots.permission === 'read-only', JSON.stringify(out.slots))
    rec.add(G, '★ 模式的默认档照旧下发', out.slots.mode === 'standard', JSON.stringify(out.slots))
    const asked = resolveEffectiveSlots({ roster: r, role: 'tester', seat: null, requested: { model: 'deepseek/deepseek-chat' } })
    rec.add(G, '★ 本次请求显式给了 model ⇒ 照旧用请求值', asked.slots.model === 'deepseek/deepseek-chat', JSON.stringify(asked.slots))
  }

  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF14ModelSentinelCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
