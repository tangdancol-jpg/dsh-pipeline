// 面板动作 / 执行器 / 归档 / 路由 POST 自测：allowed_actions、参数透传与 confirm 闸、`_trash` 列表/恢复/删除、pins 写。
/**
 * dsh-pipeline · 自建流水线面板 · **动作 / 执行器 / 归档 / 路由 POST**自测
 * ============================================================================
 *     node tests/panel-actions-check.mjs
 *
 * 钉住「面板能对一张单做什么」以及「做完之后盘上发生什么」（拆分前的 J–O / Q 组）：
 *   J. `allowed_actions`：终态 ⇒ `archive+delete`、`blocked` ⇒ `restore`、`reviewing`/`pending`
 *      ⇒ `cancel`；顺序固定、判据来自状态机；K. 执行器：白名单 / 开关门 / 删单二次确认 /
 *      底层拒绝原样透出 / 异常归一化（**绝不抛**）；L. 路由 `POST /panel/action`：
 *      405 / 403 / 503 / 400 / 413 各有明确回执，`/panel` 一个字没变；
 *   M. 归档视图：只扫 `_trash/<归档目录>/task.json`、坏 JSON 只进 warnings、`id` 右锚剥 stamp、
 *      `archived_at` 解析不出退回 mtime；N. 恢复 / 永久删除：路径穿越与"目标已存在"两道硬闸、
 *      `confirm` 必须严格 `true`、墓碑进 `_purge-log.jsonl` 且**先留痕后动手**；
 *   O. 置顶：set / unset / 持久化 / 坏文件当空 / 原子写无残留 / 上限 200；
 *   Q. 新动作（`pin` / `unpin` / `unarchive` / `delete_archived`）的参数透传、开关门、
 *      拒绝透出 + 真实现端到端 + `POST /panel/action` 对新动作照样透传。
 *
 * ★ 快照 / 契约那半边在 `tests/panel-snapshot-check.mjs`；共享夹具在 `tests/panel-fixtures.mjs`
 *   （**不是测试**，刻意不登记）。拆文件的理由：`CONVENTIONS.md`「单个测试文件 ≤ 400 行」。
 * ★ 执行器那几组用假 store / 假 pins / 假 archive（只记录入参），不碰真实任务目录；
 *   只有 Q 的端到端用真实现 + 真临时目录。全程密闭、跑完即删。
 *
 * @module dsh-pipeline/tests/panel-actions-check
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PANEL_ACTION_ORDER, allowedActionsOf, buildPanelSnapshot } from '../lib/panel/snapshot.js'
import { DELETE_CONFIRM_ERROR, DELETE_ARCHIVED_MESSAGE, PANEL_ACTION_IDS, PIN_OFF_MESSAGE, PIN_ON_MESSAGE, SWITCH_OFF_ERROR, UNARCHIVE_MESSAGE, createPanelActions } from '../lib/panel/actions.js'
import { ARCHIVE_DIR_NAME, DELETE_ARCHIVED_CONFIRM_ERROR, DELETE_ARCHIVED_REASON, deleteArchived, listArchived, restoreArchived } from '../lib/panel/archive.js'
import { PINS_FILE_NAME, PINS_MAX, isPinned, pinsFileOf, readPins, setPinned } from '../lib/panel/pins.js'
import { PANEL_ACTION_PATH, PANEL_PATH, createSwitchHandler } from '../lib/switch-routes.js'
import { PURGE_LOG_NAME, TRASH_DIR_NAME } from '../lib/store/purge.js'
import { pathKey } from '../lib/util.js'
import { ARCH_DIR_BAD, ARCH_DIR_KEEP, ARCH_DIR_NOFILE, ARCH_DIR_NOSTAMP, ARCH_DIR_OLD, ARCH_KEEP, ARCH_NOSTAMP_MTIME, ARCH_OLD, CJK, NEWER, createRecorder, fakeActionStore, fakeBodyReq, fakePanelAction, fakeReq, fakeRes, fakeSwitch, lastJsonLine, makeArchiveFixture, makeFixture, makeTempRoots, readJson, renderReport, runDirect } from './panel-fixtures.mjs'

export async function runPanelActionsCheck() {
  const rec = createRecorder()
  const roots = makeTempRoots('actions')
  const G_J = 'J · allowed_actions（快照判定）'
  const G_K = 'K · 面板操作执行器（白名单 / 开关 / 确认 / 归一化）'
  const G_L = 'L · 面板操作路由（POST /panel/action）'
  const G_M = 'M · 归档视图（`_trash` 列表）'
  const G_N = 'N · 归档恢复 / 永久删除'
  const G_O = 'O · 置顶（pins.js）'
  const G_Q = 'Q · 新动作与归档路由（pin/unpin/unarchive/delete_archived）'

  try {
    makeFixture(roots.root)
    const snap = buildPanelSnapshot({ projectRoot: roots.root, now: Date.parse('2026-10-18T03:00:00Z') })
    const task = (snap?.tasks ?? []).find((t) => t.id === NEWER) ?? null

    // === J allowed_actions =================================================
    rec.add(G_J, '`allowed_actions` 是字符串数组（每个任务都有，且都来自白名单）', (snap?.tasks ?? []).every((t) => Array.isArray(t.allowed_actions) && t.allowed_actions.every((a) => typeof a === 'string' && PANEL_ACTION_IDS.includes(a))), JSON.stringify((snap?.tasks ?? []).map((t) => `${t.state}:${JSON.stringify(t.allowed_actions)}`)))
    rec.add(G_J, '`reviewing`（非终态）⇒ 只有 `cancel`', JSON.stringify(task?.allowed_actions) === JSON.stringify(['cancel']), JSON.stringify(task?.allowed_actions))
    rec.add(G_J, '快照里的 `allowed_actions` 与纯函数 `allowedActionsOf` **同源**（逐行相等）', (snap?.tasks ?? []).every((t) => JSON.stringify(t.allowed_actions) === JSON.stringify(allowedActionsOf(t.state))), '')
    rec.add(G_J, '`PANEL_ACTION_ORDER` 是执行器白名单的**前缀**（前四个名字，快照与执行器不漂移）', JSON.stringify(PANEL_ACTION_IDS.slice(0, PANEL_ACTION_ORDER.length)) === JSON.stringify(PANEL_ACTION_ORDER) && JSON.stringify(PANEL_ACTION_ORDER) === JSON.stringify(['cancel', 'restore', 'archive', 'delete']), JSON.stringify(PANEL_ACTION_IDS))
    rec.add(G_J, '`allowed_actions` 只报状态驱动的四个（`pin/unpin/unarchive/delete_archived` 不参与状态判定）', (snap?.tasks ?? []).every((t) => t.allowed_actions.every((a) => PANEL_ACTION_ORDER.includes(a))), JSON.stringify((snap?.tasks ?? []).map((t) => t.allowed_actions)))

    // 四种状态的判据各一例（**单独一份夹具**：不动上面那 2 条既有断言）
    const statesRoot = roots.newRoot('states')
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
    const bizHandler = createSwitchHandler({ sw: fakeSwitch(), version: '9.9.9', panelAction: { async run() { return { ok: false, action: 'archive', task_id: 'T-1', error: NOT_TERMINAL_ERROR, code: 'NOT_TERMINAL' } } } })
    const resBiz = fakeRes()
    await bizHandler(fakeBodyReq({ url: PANEL_ACTION_PATH, body: JSON.stringify({ task_id: 'T-1', action: 'archive' }) }), resBiz)
    rec.add(G_L, '业务失败照旧 HTTP 200，正文 `{ok:false, error, code}`（客户端读 `ok`，不猜状态码）', resBiz.statusCode === 200 && JSON.parse(resBiz.body).ok === false && JSON.parse(resBiz.body).code === 'NOT_TERMINAL' && JSON.parse(resBiz.body).error === NOT_TERMINAL_ERROR, `status=${resBiz.statusCode} body=${resBiz.body}`)
    const tmpStore = fakeActionStore()
    const realHandler = createSwitchHandler({ sw: fakeSwitch(), version: '9.9.9', panelAction: createPanelActions({ store: tmpStore, sw: ACTION_SW_ON }) })
    const resE2E = fakeRes()
    await realHandler(fakeBodyReq({ url: PANEL_ACTION_PATH, body: JSON.stringify({ task_id: 'T-9', action: 'archive' }) }), resE2E)
    rec.add(G_L, '真执行器 + 真路由：`archive` 落到 `purgeTask(mode:"trash")`', resE2E.statusCode === 200 && JSON.parse(resE2E.body).message === '已留档' && tmpStore.calls.at(-1)?.input.mode === 'trash' && tmpStore.calls.at(-1)?.input.taskId === 'T-9', resE2E.body)
    const resPanelAgain = fakeRes()
    await createSwitchHandler({ sw: fakeSwitch(), version: '9.9.9', panel: () => buildPanelSnapshot({ projectRoot: roots.root }) })(fakeReq({ url: PANEL_PATH }), resPanelAgain)
    rec.add(G_L, '★ 新路由没有改变 `/panel`（仍 200、仍是那份只读快照）', resPanelAgain.statusCode === 200 && JSON.parse(resPanelAgain.body).ok === true && Array.isArray(JSON.parse(resPanelAgain.body).tasks), `status=${resPanelAgain.statusCode}`)

    // === M 归档视图 ========================================================
    const archiveRoot = roots.newRoot('archive')
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
    const emptyArchiveRoot = roots.newRoot('archive-empty')
    mkdirSync(join(emptyArchiveRoot, '.pipeline'), { recursive: true })
    const emptyArch = listArchived({ projectRoot: emptyArchiveRoot })
    rec.add(G_M, '没有 `_trash` ⇒ `ok:true` + 空表（新 profile 不算错）', emptyArch.ok === true && emptyArch.tasks.length === 0 && emptyArch.warnings.length === 0, JSON.stringify(emptyArch))
    const badArch = listArchived({})
    rec.add(G_M, '没有 `projectRoot` ⇒ `ok:false` + 中文 error（照样不抛）', badArch.ok === false && CJK.test(String(badArch.error)) && Array.isArray(badArch.tasks), `error=${String(badArch.error)}`)
    const customArchiveRoot = roots.newRoot('archive-custom')
    makeArchiveFixture(customArchiveRoot, '.pipe2')
    const customArch = listArchived({ projectRoot: customArchiveRoot, artifactDirName: '.pipe2' })
    rec.add(G_M, '`artifactDirName` 从入参来（不是硬编码 `.pipeline`）', customArch.ok === true && (customArch.tasks ?? []).some((t) => t.dir === ARCH_DIR_KEEP), JSON.stringify((customArch.tasks ?? []).map((t) => t.dir)))

    // === N 归档恢复 / 永久删除 =============================================
    const restoreRoot = roots.newRoot('restore')
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
    const tombstone = lastJsonLine(purgeLogPath)
    rec.add(G_N, '墓碑落在 `_purge-log.jsonl`（与 `purge.js` **同一个账本 / 文件名常量**）', tombstone !== null && tombstone.task_id === ARCH_OLD && tombstone.mode === 'delete-archived' && tombstone.by === 'human' && tombstone.reason === DELETE_ARCHIVED_REASON && typeof tombstone.at === 'string', JSON.stringify(tombstone))
    rec.add(G_N, '先留痕后动手：删完账还在一行一条', readFileSync(purgeLogPath, 'utf8').trim().split('\n').length === 1, readFileSync(purgeLogPath, 'utf8').trim())

    // === O 置顶（pins.js）==================================================
    const pinsRoot = roots.newRoot('pins')
    const pinsPath = join(pinsRoot, '.pipeline', PINS_FILE_NAME)
    rec.add(G_O, '没有置顶文件 ⇒ 空表（没置顶过是常态，不是错）', JSON.stringify(readPins(pinsRoot, '.pipeline')) === '[]' && isPinned(pinsRoot, '.pipeline', 'T-1') === false, '')
    const pinOn = setPinned(pinsRoot, '.pipeline', 'T-1', true)
    const pinsDoc = readJson(pinsPath)
    rec.add(G_O, '`setPinned(true)` ⇒ `{ok:true, pinned:true, ids:["T-1"]}` 并落盘 `{version:1, ids}`', pinOn.ok === true && pinOn.pinned === true && JSON.stringify(pinOn.ids) === JSON.stringify(['T-1']) && pinsDoc?.version === 1 && JSON.stringify(pinsDoc?.ids) === JSON.stringify(['T-1']), JSON.stringify({ pinOn, pinsDoc }))
    rec.add(G_O, '`pinsFileOf` 指的就是 `<项目根>/<artifactDirName>/_panel-pins.json`', pinsFileOf(pinsRoot, '.pipeline') === pinsPath && PINS_FILE_NAME === '_panel-pins.json', pinsPath)
    rec.add(G_O, '持久化：换一次调用仍读得到（不是内存态）', JSON.stringify(readPins(pinsRoot, '.pipeline')) === JSON.stringify(['T-1']) && isPinned(pinsRoot, '.pipeline', 'T-1') === true, '')
    const pinAgain = setPinned(pinsRoot, '.pipeline', 'T-1', true)
    rec.add(G_O, '重复置顶幂等（不产生第二条）', pinAgain.ok === true && JSON.stringify(pinAgain.ids) === JSON.stringify(['T-1']), JSON.stringify(pinAgain))
    rec.add(G_O, '原子写：`tmp + rename` 之后没有残留 `.tmp`', existsSync(`${pinsPath}.tmp`) === false, '')
    const pinOff = setPinned(pinsRoot, '.pipeline', 'T-1', false)
    rec.add(G_O, '`setPinned(false)` ⇒ 取消置顶、落盘为空表', pinOff.ok === true && pinOff.pinned === false && JSON.stringify(readPins(pinsRoot, '.pipeline')) === '[]' && isPinned(pinsRoot, '.pipeline', 'T-1') === false, JSON.stringify(pinOff))
    const badPinsRoot = roots.newRoot('pins-bad')
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
    const capPinsRoot = roots.newRoot('pins-cap')
    mkdirSync(join(capPinsRoot, '.pipeline'), { recursive: true })
    writeFileSync(join(capPinsRoot, '.pipeline', PINS_FILE_NAME), JSON.stringify({ version: 1, ids: Array.from({ length: PINS_MAX + 5 }, (_, i) => `T-${i}`) }), 'utf8')
    const overflow = setPinned(capPinsRoot, '.pipeline', 'T-extra', true)
    rec.add(G_O, `上限 ${PINS_MAX} 条：读时夹住，写满后**明说满了**（不悄悄丢掉刚点的那颗星）`, PINS_MAX === 200 && readPins(capPinsRoot, '.pipeline').length === PINS_MAX && overflow.ok === false && overflow.error.includes('上限'), JSON.stringify(overflow))

    // === Q 新动作（pin/unpin/unarchive/delete_archived）=====================
    {
      const pinCalls = []
      const fakePins = { setPinned: (...args) => { pinCalls.push(args); return { ok: true, pinned: args[3] === true, ids: [args[2]] } } }
      const run = createPanelActions({ store: fakeActionStore(), sw: ACTION_SW_ON, projectRoot: '/proj/root', pins: fakePins })
      const pinnedOut = await run.run({ task_id: 'T-1', action: 'pin' })
      rec.add(G_Q, '`pin` ⇒ `setPinned(项目根, 工作区目录名, 任务id, true)`，message「已置顶」', pinnedOut.ok === true && pinnedOut.message === PIN_ON_MESSAGE && JSON.stringify(pinCalls.at(-1)) === JSON.stringify(['/proj/root', '.pipeline', 'T-1', true]), JSON.stringify({ pinnedOut, pinCalls }))
      const unpinnedOut = await run.run({ task_id: 'T-1', action: 'unpin' })
      rec.add(G_Q, '`unpin` ⇒ 同一个入口、`on=false`，message「已取消置顶」', unpinnedOut.ok === true && unpinnedOut.message === PIN_OFF_MESSAGE && JSON.stringify(pinCalls.at(-1)) === JSON.stringify(['/proj/root', '.pipeline', 'T-1', false]), JSON.stringify({ unpinnedOut, pinCalls }))
      const callsBeforeNoId = pinCalls.length
      const noIdOut = await run.run({ action: 'pin' })
      rec.add(G_Q, '缺 `task_id` ⇒ 中文拒绝（不写一个空 id、不碰 pins）', noIdOut.ok === false && CJK.test(noIdOut.error) && pinCalls.length === callsBeforeNoId, JSON.stringify(noIdOut))
      const failedPin = await createPanelActions({ store: fakeActionStore(), sw: ACTION_SW_ON, projectRoot: '/proj', pins: { setPinned: () => ({ ok: false, error: '置顶写不进去：EACCES 拒绝访问' }) } }).run({ task_id: 'T-1', action: 'pin' })
      rec.add(G_Q, 'pins 拒绝 ⇒ 原样透出（绝不粉饰成"已置顶"）', failedPin.ok === false && failedPin.error === '置顶写不进去：EACCES 拒绝访问' && failedPin.action === 'pin' && failedPin.task_id === 'T-1', JSON.stringify(failedPin))
      const noPinsOut = await createPanelActions({ store: fakeActionStore(), sw: ACTION_SW_ON, projectRoot: '/proj', pins: {} }).run({ task_id: 'T-1', action: 'pin' })
      rec.add(G_Q, 'pins 没这套方法 ⇒ `STORE_UNAVAILABLE`（点名 setPinned）', noPinsOut.code === 'STORE_UNAVAILABLE' && noPinsOut.error.includes('setPinned'), JSON.stringify(noPinsOut))
      const noRootOut = await createPanelActions({ store: fakeActionStore(), sw: ACTION_SW_ON }).run({ task_id: 'T-1', action: 'pin' })
      rec.add(G_Q, '没接线项目根 ⇒ 明说"未接线"（不猜目录、不写盘）', noRootOut.ok === false && noRootOut.code === 'STORE_UNAVAILABLE' && noRootOut.error.includes('项目根'), JSON.stringify(noRootOut))
    }
    {
      const archCalls = []
      const fakeArchive = {
        restoreArchived: (input) => { archCalls.push({ method: 'restoreArchived', input }); return { ok: true, task_id: 'T-x', restored_to: '/p/T-x' } },
        deleteArchived: (input) => { archCalls.push({ method: 'deleteArchived', input }); return { ok: true, task_id: 'T-x', deleted: true } },
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
        archive: { restoreArchived: () => ({ ok: false, error: '目标目录已存在，不覆盖：x' }), deleteArchived: () => ({ ok: false, error: '墓碑账本写不进去' }) },
      })
      const failedUn = await failing.run({ task_id: 'd1', action: 'unarchive' })
      const failedDel = await failing.run({ task_id: 'd2', action: 'delete_archived', confirm: true })
      rec.add(G_Q, '归档两个动作的拒绝也**原样透出**（`code` 有才带）', failedUn.ok === false && failedUn.error === '目标目录已存在，不覆盖：x' && failedDel.ok === false && failedDel.error === '墓碑账本写不进去' && failedUn.code === undefined, JSON.stringify({ failedUn, failedDel }))
      const throwing = createPanelActions({ store: fakeActionStore(), sw: ACTION_SW_ON, projectRoot: '/proj', archive: { restoreArchived: () => { throw new Error('磁盘掉了') } } })
      const threwOut = await throwing.run({ task_id: 'd1', action: 'unarchive' })
      rec.add(G_Q, '归档实现抛异常 ⇒ 归一成 `ok:false` + code，**不抛**', threwOut.ok === false && threwOut.code === 'PANEL_ACTION_FAILED' && threwOut.error.includes('磁盘掉了'), JSON.stringify(threwOut))
      const offStore = fakeActionStore()
      const offRun = createPanelActions({
        store: offStore, sw: ACTION_SW_OFF, projectRoot: '/proj',
        pins: { setPinned: () => { throw new Error('开关关着 ⇒ 不该被调到') } },
        archive: { restoreArchived: () => { throw new Error('开关关着 ⇒ 不该被调到') }, deleteArchived: () => { throw new Error('开关关着 ⇒ 不该被调到') } },
      })
      const offOuts = []
      for (const action of ['pin', 'unpin', 'unarchive', 'delete_archived']) offOuts.push(await offRun.run({ task_id: 'T-1', action, confirm: true }))
      rec.add(G_Q, '开关关 ⇒ 四个新动作一律被拒（pins / archive 一次都没被调到）', offOuts.every((o) => o.ok === false && o.error === SWITCH_OFF_ERROR) && offStore.calls.length === 0, JSON.stringify(offOuts))
    }
    {
      // ★ 真执行器 + 真目录：置顶 / 恢复归档 / 永久删除各走一遍完整链路
      const e2eRoot = roots.newRoot('actions-e2e')
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
      const e2eTombstone = lastJsonLine(join(e2ePipeline, PURGE_LOG_NAME))
      rec.add(G_Q, '★ 真永久删除：目录没了、墓碑进 `_purge-log.jsonl`', deleteOut.ok === true && deleteOut.message === DELETE_ARCHIVED_MESSAGE && !existsSync(e2eArchDir2) && e2eTombstone?.mode === 'delete-archived' && e2eTombstone?.task_id === 'T-20261025-e2e3', JSON.stringify({ deleteOut, e2eTombstone }))
    }
    {
      // 路由：新动作在 POST 上照样原样递参（白名单由执行器判，路由层不判）
      const paNew = fakePanelAction()
      const newActionHandler = createSwitchHandler({ sw: fakeSwitch(), version: '9.9.9', panelAction: paNew })
      const resPinAction = fakeRes()
      await newActionHandler(fakeBodyReq({ url: PANEL_ACTION_PATH, body: JSON.stringify({ task_id: 'T-1', action: 'pin' }) }), resPinAction)
      rec.add(G_Q, '`POST /panel/action` 接受新动作（路由层不判白名单，原样递参）', resPinAction.statusCode === 200 && JSON.stringify(paNew.calls.at(-1)) === JSON.stringify({ task_id: 'T-1', action: 'pin', confirm: false }), JSON.stringify(paNew.calls))
      const resDelAction = fakeRes()
      await newActionHandler(fakeBodyReq({ url: PANEL_ACTION_PATH, body: JSON.stringify({ task_id: 'T-9-2026-10-18T060000Z', action: 'delete_archived', confirm: true }) }), resDelAction)
      rec.add(G_Q, '`delete_archived` 的 `confirm:true` 也照样透传（不被路由层吞掉）', resDelAction.statusCode === 200 && paNew.calls.at(-1)?.confirm === true && paNew.calls.at(-1)?.action === 'delete_archived', JSON.stringify(paNew.calls.at(-1)))
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 8).join('\n'))
  } finally {
    roots.cleanup()
  }

  return renderReport('dsh-pipeline · 自建流水线面板 · 动作 / 执行器 / 归档 / 路由 POST', rec)
}

runDirect(runPanelActionsCheck, import.meta.url)
