/**
 * dsh-pipeline · tests/heal-perm-check.mjs
 * ============================================================================
 * **A 自愈身份 + B 权限档推导**（真机 `T-20261016-fullai`，2026-10-16 实测）
 * ────────────────────────────────────────────────────────────────────────────
 * A · 传话（唤醒 / 投递 / 身份）的**身份那一半**：
 *   ① 自愈 / 唤醒点补派原来把**调用方的 exec** 递进派活通道 ⇒ 判据变成"谁在查状态"，
 *      而重启后主对话自己也没身份（`tokens` 是进程内存态）⇒ 补派**必然**失败
 *      （现场原文：「无法确定调用方角色：既没有绑定会话，也没有携带 role_token。」）。
 *      修法：机制**自己铸一枚身份**（`tokens.mint({ mechanism })`），授权来源仍是
 *      `task.hub` 账本（`hubAuthorizedRoles`）—— 复用既有来源，不新造概念。
 *   ② 重启后**主对话身份也丢**：`pipeline_status` 必须明确说出"未绑定 + 下一步那条命令"，
 *      而不是让主对话撞上「本会话既没有绑定任何角色」那堵墙才知道。
 *   ③ 唤醒投递失败（`unresolved-wake` / `pending_wakes`）的**下一步**要写在正文里。
 *
 * B · 权限申请（人工审批弹窗）：
 *   ④ 会产生落盘产物的角色（`writeClassOf` ∈ own-dir / own-log / workdir）默认拿到
 *      `workspace-write`；纯只读角色（readonly / none）**仍然是** `read-only`；
 *      显式给的档照旧优先；留痕里 `origin` 记 `role-need`（不是 `request`，也不是 `default`）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 判据纪律
 * ────────────────────────────────────────────────────────────────────────────
 *   · 全程**真工具 + 真守门 + 真状态机**（`createHarness`，模拟通道，零真实会话）；
 *   · "机制身份真的起作用了"不靠字段存在与否判，而靠**一个没有身份的调用方**
 *     查一次状态、席位**真的被补回来**；
 *   · 借调用方身份那条老路**在同一套里当场复现为红**（下面【A0】那一格）——
 *     它是"先红"的**常驻判据**，不是一次性的截图。
 * 退出码：0 = 全绿；1 = 有失败。
 * @module dsh-pipeline/tests/heal-perm-check
 */

import { writeFile, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { createHarness, disposeHarness, callTool } from './selftest-core.mjs'
import { pendingWakesNextSteps } from '../lib/wakeup/pending.js'
import { createHubSeatRespawner, mintMechanismIdentity, HUB_SEAT_MECHANISM } from '../lib/tools/hub-seats.js'
import { dispatchSlotPlan, dispatchSlots } from '../lib/tools/dispatch-slots.js'
import { permissionNeedOf, ROLE_NEED_ORIGIN } from '../lib/roster/permission-need.js'
import { writeClassOf } from '../lib/guard.js'
import { judgeMainBinding, MAIN_BINDING_REASONS, MAIN_REATTACH_HINT } from '../lib/wakeup/main-identity.js'
import { ALL_ROLE_IDS, ROLE } from '../lib/roles.js'

function createRecorder() {
  const items = []
  return {
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
      const L = ['dsh-pipeline · A 自愈身份 + B 权限档推导', '='.repeat(78)]
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

const says = (r, ...needles) => needles.every((n) => String(r.text).includes(n))
const seatOf = (task, role) => (Array.isArray(task?.dispatched) ? task.dispatched : []).find((x) => String(x?.role) === role) ?? null
const spawnsOf = (h, role) => h.transport.calls.filter((c) => c.kind === 'spawn' && c.role === role).length

export async function runHealPermCheck() {
  const rec = createRecorder()
  const h = await createHarness()
  try {
    await drive(h, rec)
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

async function drive(h, rec) {
  // =========================================================================
  // 【A1】机制身份：自愈**不借调用方身份**
  // =========================================================================
  const open = await callTool(h, 'pipeline_task_open', { requirement: '自愈必须有自己的身份（夹具）' }, 'sess-main')
  const taskId = String(open.value?.task_id ?? '')
  rec.add('A1 机制身份', '夹具：真开一张单', taskId.length > 0, taskId)
  h.tokens.mint({ taskId, role: ROLE.MAIN, agentId: 'sess-main' })
  const sup = h.tokens.mint({ taskId, role: ROLE.SUPERVISOR, agentId: 'sess-sup' })
  const init = await callTool(h, 'pipeline_supervise', { task_id: taskId, action: 'initiate', reason: '夹具：发起枢纽', role_token: sup.token }, 'sess-sup')
  rec.add('A1 机制身份', '主管 `initiate` ⇒ 需求位真的被创建（`dispatched` 台账里有它）', init.denied !== true && seatOf(await h.store.get(taskId), ROLE.ORCHESTRATOR) !== null, init.text.split('\n')[0])

  // 造出"状态到了、人没到"的现场：把需求位从派活台账里摘掉（席位**不存在**了）。
  const wiped = await h.store.get(taskId)
  wiped.dispatched = (Array.isArray(wiped.dispatched) ? wiped.dispatched : []).filter((x) => String(x?.role) !== ROLE.ORCHESTRATOR)
  await writeFile(`${h.projectRoot}/.pipeline/${taskId}/task.json`, JSON.stringify(wiped, null, 2), 'utf8')
  h.indexTask(taskId, wiped)
  rec.add('A1 机制身份', '现场：`dispatched` 里需求位缺位（状态到了、人没到）', seatOf(await h.store.get(taskId), ROLE.ORCHESTRATOR) === null, JSON.stringify(seatOf(await h.store.get(taskId), ROLE.ORCHESTRATOR)))

  /**
   * ★★ **【A0】先红：借调用方身份那条老路，当场复现为失败。**
   *
   * 这里刻意**按改前的装配**造一个补派器（**不交 `tokens`** —— 改前 `lib/tools.js`
   * 就是 `createHubSeatRespawner({ store, dispatch, load })`）—— 它只能拿调用方的
   * exec 去认人。而调用方**没有身份**（`{}`，与重启后的主对话同形）⇒ 必然失败，
   * 失败原文就是现场那两句。它是"先红"的**常驻判据**：修法一旦被回退，它会红。
   */
  const legacy = createHubSeatRespawner({ store: h.store, dispatch: h.byName.get('pipeline_dispatch'), load: (id) => h.store.get(id) })
  const red = await legacy.ensureHubSeats(await h.store.get(taskId), {}, { by: 'mechanism', via: 'red-proof' })
  rec.add(
    'A0 先红（借调用方身份）',
    '★★ **无身份调用方 + 旧装配（不交 `tokens`）⇒ 补派必失败**，原文就是现场那句',
    red.ok === false && red.failed.length > 0 && red.failed.some((f) => /无法确定调用方角色/.test(f.reason)),
    red.lines.join('\n') || '(没有缺口 —— 夹具前提不成立)',
  )
  rec.add('A0 先红（借调用方身份）', '★ 而且它**一个席位都没补上**（席位仍缺位）', seatOf(await h.store.get(taskId), ROLE.ORCHESTRATOR) === null, '')

  const spawnsBefore = spawnsOf(h, ROLE.ORCHESTRATOR)
  /**
   * ★★ **本套的核心判据**：调用方是 `sess-ghost` —— **令牌表里没有它**（等价于
   * 重启后的主对话：没有绑定、也没带 `role_token`）。查一次状态 ⇒ 机制补派。
   */
  const heal = await callTool(h, 'pipeline_status', { task_id: taskId }, 'sess-ghost')
  const afterHeal = await h.store.get(taskId)
  rec.add('A1 机制身份', '★★ 无身份调用方查一次状态 ⇒ **补派成功**（席位回到台账里）', seatOf(afterHeal, ROLE.ORCHESTRATOR) !== null, JSON.stringify(seatOf(afterHeal, ROLE.ORCHESTRATOR)))
  rec.add('A1 机制身份', '★ 真的建了会话（`spawnRole` 次数 +1）', spawnsOf(h, ROLE.ORCHESTRATOR) === spawnsBefore + 1, `${spawnsBefore} → ${spawnsOf(h, ROLE.ORCHESTRATOR)}`)
  rec.add('A1 机制身份', '★ 补派结论印在正文里（补了谁 / 成没成）', says(heal, '补派'), heal.text.split('\n').filter((l) => l.includes('补派')).join(' / '))
  rec.add('A1 机制身份', '★★ **不再出现**「无法确定调用方角色」（判据不再是"谁在查状态"）', !heal.text.includes('无法确定调用方角色'), '')
  rec.add(
    'A1 机制身份',
    '★ 留痕记的是**机制身份**，不是调用方：`identity=mechanism` + `identity_source=task.hub`',
    (afterHeal.history ?? []).some((x) => x.action === 'hub:seat-respawn' && x.identity === 'mechanism' && x.identity_source === 'task.hub' && x.mechanism === HUB_SEAT_MECHANISM),
    JSON.stringify((afterHeal.history ?? []).filter((x) => x.action === 'hub:seat-respawn').slice(-1)),
  )

  // 机制身份是**用完即撤**的：它不在令牌表里留痕，也不会被绑到任何会话上。
  const minted = mintMechanismIdentity(h.tokens, afterHeal)
  rec.add('A1 机制身份', '★ 机制身份能被铸出来（`tokens.mint({ mechanism })` 那条唯一入口）', minted.token !== null && minted.why.includes(HUB_SEAT_MECHANISM), minted.why)
  const bindTry = h.tokens.bindAgent(minted.token, 'sess-ghost')
  rec.add('A1 机制身份', '★ 机制令牌**绑不到任何会话上**（它不是席位身份）', bindTry.ok !== true && /机制身份/.test(bindTry.error ?? ''), String(bindTry.error ?? '').split('\n')[0])
  minted.revoke()
  rec.add('A1 机制身份', '★ 撤销之后令牌表里查不到它（用完即撤，不留后门）', h.tokens.bySession('sess-ghost') === null, '')

  // =========================================================================
  // 【A2】幂等：重复触发不重复派 / 不重复改档
  // =========================================================================
  const slotsBefore = (await h.store.get(taskId)).dispatch_slots?.length ?? 0
  const spawnsBefore2 = spawnsOf(h, ROLE.ORCHESTRATOR)
  const again = await callTool(h, 'pipeline_status', { task_id: taskId }, 'sess-ghost')
  const after2 = await h.store.get(taskId)
  rec.add('A2 幂等', '★★ 再查一次 ⇒ **不重复派**（台账里需求位仍只有一条）', (after2.dispatched ?? []).filter((x) => String(x?.role) === ROLE.ORCHESTRATOR).length === 1, JSON.stringify((after2.dispatched ?? []).map((x) => x.role)))
  rec.add('A2 幂等', '★ 也不重复建会话（`spawnRole` 次数不变）', spawnsOf(h, ROLE.ORCHESTRATOR) === spawnsBefore2, `${spawnsBefore2} → ${spawnsOf(h, ROLE.ORCHESTRATOR)}`)
  rec.add('A2 幂等', '★★ **不重复改档**（`dispatch_slots` 一条都不新增）', ((await h.store.get(taskId)).dispatch_slots?.length ?? 0) === slotsBefore, `${slotsBefore} → ${(await h.store.get(taskId)).dispatch_slots?.length ?? 0}`)
  rec.add('A2 幂等', '★ 第二次正文里没有"补派"（幂等 ⇒ 无事可做就闭嘴）', !again.text.includes('✓ 补派'), '')

  // =========================================================================
  // 【A3】重启后主对话身份：**明确提示 + 下一步那条命令**
  // =========================================================================
  const contact = (await h.store.get(taskId))?.contacts?.main?.agent_id ?? ''
  /**
   * 夹具自己把"主对话会话"落盘 —— **走 store 的真写入路径**（`rememberMainContact`），
   * 不手改 task.json：生产里这一格由 `lib/wakeup/main-contact.js` 写，判据读的是同一格。
   * （自测替身没装配 `deps.wakeup` ⇒ 工具出口那条自动登记在夹具里不会发生。）
   */
  if (contact !== 'sess-main') await h.store.rememberMainContact(taskId, 'sess-main')
  rec.add('A3 主对话身份', '夹具前提：盘上记着主对话会话 = `sess-main`', ((await h.store.get(taskId))?.contacts?.main?.agent_id ?? '') === 'sess-main', (await h.store.get(taskId))?.contacts?.main?.agent_id ?? '(空)')
  h.tokens.clear() // ★ 模拟 DSH 重启：令牌表是进程内存态，重启即全空
  rec.add('A3 主对话身份', '★ 模拟重启：令牌表清空后 `sess-main` 不再有任何绑定', h.tokens.tasksOfAgent('sess-main', ROLE.MAIN).length === 0, '')
  const lost = await callTool(h, 'pipeline_status', { task_id: taskId }, 'sess-main')
  rec.add('A3 主对话身份', `★★ 状态正文里**明确说出**「${MAIN_REATTACH_HINT}」`, lost.text.includes(MAIN_REATTACH_HINT), '')
  rec.add('A3 主对话身份', '★★ 并给出**下一步那条命令**（含本任务 id 的 `reattach: true`）', lost.text.includes(`pipeline_task_open { task_id: "${taskId}", reattach: true }`), '')
  rec.add('A3 主对话身份', '★ 还说清**为什么会这样**（令牌表是进程内存态 / 重启与 TTL 是两回事）', lost.text.includes('进程内存态') && lost.text.includes('重启'), '')
  rec.add('A3 主对话身份', '★ 查到"未绑定"不影响这次查询本身（照旧返回状态正文）', lost.denied !== true && lost.text.includes(taskId), lost.text.split('\n')[0])

  const re = await callTool(h, 'pipeline_task_open', { task_id: taskId, reattach: true }, 'sess-main')
  rec.add('A3 主对话身份', '★ 按提示重认领 ⇒ 成功', re.denied !== true && h.tokens.tasksOfAgent('sess-main', ROLE.MAIN).includes(taskId), re.text.split('\n')[0])
  const back = await callTool(h, 'pipeline_status', { task_id: taskId }, 'sess-main')
  rec.add('A3 主对话身份', '★★ 重认领之后提示**消失**（不刷屏、不自相矛盾）', !back.text.includes(MAIN_REATTACH_HINT), '')

  // =========================================================================
  // 【A4】唤醒投递失败的**下一步**（`pending_wakes` 那条出口）
  // =========================================================================
  /**
   * ★ 为什么这里不端到端查一次状态：**自测替身没有装配 `deps.wakeup`**
   *   （`createHarness` 的 `deps` 里没有它 ⇒ 账本恒空 ⇒ `pending_wakes` 恒为 `[]`），
   *   而端到端那条路已经由 `tests/wake-pending-check.mjs` 钉着（真账本 + 真 status）。
   *   本格钉的是**改动的判据本身**：
   *     ① 下一步的文案有**唯一出处**（`pendingWakesNextSteps`）且内容可判；
   *     ② `pipeline_status` **真的铺开了它**（读源码核对接线，不是靠"我记得接了"）。
   */
  const steps = pendingWakesNextSteps(taskId).join('\n')
  rec.add('A4 待领事件', '★★ 下一步**逐条可判**：认回身份 → 重登记 → 积压的不会自动重投', says({ text: steps }, '下一步（按顺序做', `pipeline_task_open { task_id: "${taskId}", reattach: true }`, '不会自动重投'), '')
  const statusSrc = await readFile(new URL('../lib/tools/status.js', import.meta.url), 'utf8')
  rec.add('A4 待领事件', '★ `pipeline_status` 的正文里**真的铺开了**它（接线核对，不是口头承诺）', statusSrc.includes('pendingWakesNextSteps(taskId)') && statusSrc.includes('没人领的事件'), '')
  rec.add('A4 待领事件', '★ 文案里不含编造的任务 id（空 id 时给占位符，不假装知道）', pendingWakesNextSteps('').join('\n').includes('<任务id>') && !pendingWakesNextSteps('').join('\n').includes('"undefined"'), '')

  // =========================================================================
  // 【B1】权限档推导：**唯一的判据**（纯函数，逐角色）
  // =========================================================================
  const WRITE = ['own-dir', 'own-log', 'workdir']
  const produces = ALL_ROLE_IDS.filter((r) => WRITE.includes(writeClassOf(r)))
  const readonly = ALL_ROLE_IDS.filter((r) => {
    const c = writeClassOf(r)
    return c === 'readonly' || c === 'none'
  })
  rec.add('B1 权限档推导', `★ 会落盘的角色一个不少（${produces.length} 个：${produces.join(' / ')}）`, produces.length >= 10, produces.join(' / '))
  rec.add('B1 权限档推导', `★ 纯只读角色（${readonly.join(' / ')}）一个不多`, readonly.includes(ROLE.MAIN) && readonly.includes(ROLE.ORCHESTRATOR) && readonly.includes(ROLE.PLANNER) && readonly.includes(ROLE.SUPERVISOR), readonly.join(' / '))
  const badWrite = produces.filter((r) => permissionNeedOf(r).value !== 'workspace-write')
  const badRead = readonly.filter((r) => permissionNeedOf(r).value !== 'read-only')
  rec.add('B1 权限档推导', '★★ **会落盘的角色 ⇒ workspace-write**（至少，不是"最小档"）', badWrite.length === 0, badWrite.join(' / ') || produces.map((r) => `${r}=${permissionNeedOf(r).value}`).join(' '))
  rec.add('B1 权限档推导', '★★ **纯只读角色 ⇒ read-only**（**没有**放宽成"所有角色都给写权限"）', badRead.length === 0, badRead.join(' / ') || readonly.map((r) => `${r}=${permissionNeedOf(r).value}`).join(' '))
  rec.add('B1 权限档推导', '★ 推导出来的那一格：`origin=role-need`（与 `default` / `declared` / `request` 分得开）', permissionNeedOf(ROLE.ARCHITECT).origin === ROLE_NEED_ORIGIN && permissionNeedOf(ROLE.SUPERVISOR).origin === ROLE_NEED_ORIGIN, `${permissionNeedOf(ROLE.ARCHITECT).origin}`)
  rec.add('B1 权限档推导', '★ 认不出的角色 ⇒ **不猜**，按最保守的 read-only（origin=default）', (() => { const x = permissionNeedOf('not-a-role'); return x.value === 'read-only' && x.origin === 'default' && x.known === false })(), JSON.stringify(permissionNeedOf('not-a-role')))

  // =========================================================================
  // 【B2】派活那一刻的取值：三层优先级 + 显式给的不许被覆盖
  // =========================================================================
  const p1 = dispatchSlotPlan(null, ROLE.ARCHITECT, null, {})
  rec.add('B2 派活取值', '★★ 名单没有 + 请求没给 ⇒ 架构位拿到 `workspace-write`（现场那个弹窗的根因）', p1.slots.permission === 'workspace-write' && p1.origins.permission === ROLE_NEED_ORIGIN, JSON.stringify(p1))
  const p2 = dispatchSlotPlan(null, ROLE.SUPERVISOR, null, {})
  rec.add('B2 派活取值', '★ 同一路径下主管仍是 `read-only`（最小权限不放宽）', p2.slots.permission === 'read-only' && p2.origins.permission === ROLE_NEED_ORIGIN, JSON.stringify(p2))
  const p3 = dispatchSlotPlan(null, ROLE.ARCHITECT, null, { permission: 'read-only' })
  rec.add('B2 派活取值', '★★ **调用方显式给的档照旧优先**（机制推导只是兜底，不是覆盖）', p3.slots.permission === 'read-only' && Object.keys(p3.origins).length === 0, JSON.stringify(p3))
  const declaredRoster = { roster: { slots: { [ROLE.TESTER]: { permission: { value: 'workspace-write', origin: 'declared' } } } } }
  const p4 = dispatchSlotPlan(declaredRoster, ROLE.TESTER, null, {})
  rec.add('B2 派活取值', '★ 名单**显式声明**的值压过推导（声明表仍是权威）', p4.slots.permission === 'workspace-write' && Object.keys(p4.origins).length === 0, JSON.stringify(p4))
  rec.add('B2 派活取值', '★ `dispatchSlots` 的返回值与 `dispatchSlotPlan().slots` **逐字节相同**（旧调用方零影响）', JSON.stringify(dispatchSlots(null, ROLE.ARCHITECT, null, {})) === JSON.stringify(p1.slots), '')

  // =========================================================================
  // 【B3】留痕：`dispatch:slots` 里记清**权限档的来源**
  // =========================================================================
  const slots = (afterHeal.dispatch_slots ?? [])
  const cell = slots.find((s) => String(s?.role) === ROLE.ORCHESTRATOR) ?? null
  rec.add('B3 落盘留痕', '★ 自愈那次派活的四槽流水里有需求位这一条', cell !== null, JSON.stringify(slots.map((s) => s.role)))
  rec.add('B3 落盘留痕', '★★ 权限档的来源记的是 **`role-need`（推导值）** —— 不是 `request`，也不是 `default`', cell?.provenance?.permission?.origin === ROLE_NEED_ORIGIN, JSON.stringify(cell?.provenance?.permission ?? null))
  rec.add('B3 落盘留痕', '★ 实际生效值一并落盘（`effective.permission` 就是下发给会话的那一档）', cell?.effective?.permission === permissionNeedOf(ROLE.ORCHESTRATOR).value, JSON.stringify(cell?.effective ?? null))
  rec.add('B3 落盘留痕', '★ 审计里也有 `dispatch:slots` 那一行（与任务一起落盘，可追溯）', (afterHeal.history ?? []).some((x) => x.action === 'dispatch:slots'), JSON.stringify((afterHeal.history ?? []).filter((x) => x.action === 'dispatch:slots').slice(-1)))

  // =========================================================================
  // 【A5】纯判据：`judgeMainBinding` 的四种结论（不依赖夹具）
  // =========================================================================
  const t = { id: 'T-X', contacts: { main: { role: 'main', agent_id: 's-main', generation: 1 } } }
  const jB = judgeMainBinding({ task: t, taskId: 'T-X', sessionId: 's-main', actor: { ok: true, role: ROLE.MAIN } })
  const jU = judgeMainBinding({ task: t, taskId: 'T-X', sessionId: 's-main', actor: { ok: false } })
  const jN = judgeMainBinding({ task: t, taskId: 'T-X', sessionId: '', actor: { ok: false } })
  const jO = judgeMainBinding({ task: t, taskId: 'T-X', sessionId: 's-x', actor: { ok: true, role: ROLE.WRITER } })
  rec.add('A5 纯判据', '★ 绑上了 ⇒ `bound`、**零输出**（不制造噪音）', jB.bound === true && jB.reason === MAIN_BINDING_REASONS.BOUND && jB.hint === '', jB.reason)
  rec.add('A5 纯判据', '★ 有会话身份但没绑 ⇒ `unbound` + 要动作（本件主现场）', jU.bound === false && jU.reason === MAIN_BINDING_REASONS.UNBOUND && jU.should_act === true, jU.reason)
  rec.add('A5 纯判据', '★ 没有会话身份 ⇒ **不叫"没绑定"**（那是"没法绑"，两回事）', jN.reason === MAIN_BINDING_REASONS.NO_SESSION && jN.should_act === false, jN.reason)
  rec.add('A5 纯判据', '★ 绑了别的角色 ⇒ 逐字点出是哪个角色（出路不同）', jO.reason === MAIN_BINDING_REASONS.OTHER_ROLE && jO.hint.includes(ROLE.WRITER), jO.reason)
  rec.add('A5 纯判据', '★ 证据可复算：盘上记的会话 id / 兜底解析的会话 id 都在 `evidence` 里', jU.evidence.recorded_main_session === 's-main' && jU.evidence.caller_session === 's-main', JSON.stringify(jU.evidence))
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runHealPermCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
