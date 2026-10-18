// P2-11 回归：`pipeline_wait`（等到状态/事件再返回的长轮询）—— 自包含、全程临时目录。
/**
 * dsh-pipeline · F27：`pipeline_wait` 长轮询
 * ============================================================================
 *     node tests/f27-pipeline-wait-check.mjs
 *
 * 现场（P2-11）：长单里主对话**没有"等一等"的接口**，只能
 *   `pipeline_status`（一次几万字节）→ `sleep 40s` → 再查；真机实测 sleep 40+ 次。
 * 本套钉住新工具 `pipeline_wait` 的五件事（任务书原文的五条）：
 *   ① 条件已满足 ⇒ **立刻返回**（waited 很短，不睡满 interval）
 *   ② 超时 ⇒ `ok:false` + **当前状态** + 最近事件 + 建议（不静默）
 *   ③ `until_event` 命中 —— 用 `task.history` 里**已有**的动作（含 `transition:` 前缀归一化）
 *   ④ 非法参数被拒（timeout_ms / interval_ms / 拼错的状态 / 没给条件 / 没给 task_id）
 *   ⑤ **不改变任务状态、不写文件**（task.json / audit.jsonl 逐字节不变）
 * 外加三条（同一批语义，不另开测试文件）：⑥ 真实长轮询中途满足；⑦ 工具注册面接入；
 *   ⑧ 调用方中止（`exec.signal` abort）时立刻返回，不挂满 timeout。
 *
 * ★ 全程自包含：`createHarness` 造临时项目根，跑完即删；不引用活体真单。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createHarness, disposeHarness } from './selftest-core.mjs'

/** 与 f18 同一套 recorder 形状（逐组打 ✅/✗，最后总计）。 */
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
      const L = ['dsh-pipeline · F27：`pipeline_wait` 长轮询（P2-11）', '='.repeat(78)]
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

/** 文件 sha256（不存在 ⇒ '(none)'）—— 用来证明本工具**没有写盘**。 */
function shaOf(path) {
  if (!existsSync(path)) return '(none)'
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 任务 history 里最近一条动作名（"最近事件"的期望值；开单还会落 hub:force_on_open）。 */
function lastActionOf(h, id) {
  const history = h.store.peek(id)?.history ?? []
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const action = history[i]?.action
    if (typeof action === 'string' && action.length > 0) return action
  }
  return null
}

/** 开一张夹具单（只走 store 的既有入口，不摆弄内部字段）。 */
async function openFixture(h, id, requirement) {
  const opened = await h.store.open({ actorRole: 'main', requirement, id })
  if (opened.ok !== true) throw new Error(`夹具开单失败（${id}）：${String(opened.error ?? opened.summary)}`)
  return h.store.peek(id)
}

export async function runF27PipelineWaitCheck() {
  const rec = createRecorder()
  const h = await createHarness({})
  /** 直接调工具本体（与宿主 dispatch 之后同一条 run 路径；exec 给个空会话即可）。 */
  const callWait = (args) => h.byName.get('pipeline_wait').execute(args, { agent: { id: 'f27-main' } })
  const taskFileOf = (id) => join(h.store.taskDir(id), 'task.json')
  const auditFileOf = (id) => join(h.store.taskDir(id), 'audit.jsonl')

  try {
    // =====================================================================
    // ⑦ 工具注册面（先钉住"真的接上线了"，否则后面全是假的）
    // =====================================================================
    {
      const G = '⑦ 工具注册面（`lib/tools.js` 接线）'
      const def = h.byName.get('pipeline_wait')
      rec.add(G, '★★ 工具已注册：名字 = pipeline_wait，有 execute / output.render', def?.name === 'pipeline_wait' && typeof def.execute === 'function' && typeof def.output?.render === 'function', def === undefined ? 'byName 里没有 pipeline_wait' : `name=${def.name}`)
      const props = def?.parameters?.properties ?? def?.parameters ?? {}
      rec.add(G, '★ 参数面齐全：task_id 必填 + until_state / until_event / timeout_ms / interval_ms / role_token', Object.keys(props).sort().join(',') === ['interval_ms', 'role_token', 'task_id', 'timeout_ms', 'until_event', 'until_state'].sort().join(','), Object.keys(props).join(', '))
      rec.add(G, '★ task_id 声明为必填（spec DSL 的布尔 required）', props.task_id?.required === true, JSON.stringify(props.task_id))
      rec.add(G, '★ until_state / until_event 都收「字符串或数组」（oneOf 两支）', Array.isArray(props.until_state?.oneOf) && props.until_state.oneOf.length === 2 && Array.isArray(props.until_event?.oneOf) && props.until_event.oneOf.length === 2, JSON.stringify({ until_state: props.until_state?.oneOf, until_event: props.until_event?.oneOf }))
      const outKeys = Object.keys(def?.output?.schema?.properties ?? {}).sort().join(',')
      rec.add(G, '★ 输出契约 = {ok, matched, state, waited_ms, last_event, summary}', outKeys === ['last_event', 'matched', 'ok', 'state', 'summary', 'waited_ms'].sort().join(','), outKeys)
    }

    // =====================================================================
    // ① 条件已满足 ⇒ 立刻返回（wait 很短，不睡满 interval）
    // =====================================================================
    {
      const G = '① 条件已满足 ⇒ 立刻返回'
      const t = await openFixture(h, 'T-F27A', 'F27 夹具：等待工具的立即命中。')
      rec.add(G, '夹具：开单成功且停在 pending', t?.state === 'pending' && Array.isArray(t.history) && t.history.some((e) => e?.action === 'open'), `state=${t?.state}`)
      const started = Date.now()
      const r = await callWait({ task_id: 'T-F27A', until_state: 'pending', timeout_ms: 3000, interval_ms: 3000 })
      const wall = Date.now() - started
      rec.add(G, '★★ 条件已满足 ⇒ ok:true / matched:true', r.ok === true && r.matched === true, JSON.stringify({ ok: r.ok, matched: r.matched, state: r.state, waited_ms: r.waited_ms }))
      rec.add(G, '★★ waited_ms 很短（interval 给了 3000 也没睡；< 1500ms）', r.waited_ms < 1500 && wall < 1500, `waited_ms=${r.waited_ms}　实际墙钟=${wall}ms`)
      rec.add(G, '★ state / last_event 回填正确（last_event = 最近一条历史动作）', r.state === 'pending' && r.last_event === lastActionOf(h, 'T-F27A'), `state=${r.state} last_event=${r.last_event}（期望 ${lastActionOf(h, 'T-F27A')}）`)
      rec.add(G, '★ summary 说清"状态命中"与任务号（不静默）', String(r.summary).includes('状态命中') && String(r.summary).includes('T-F27A'), String(r.summary).split('\n')[0])
      rec.add(G, '★ 返回对象**恰好**是声明的六个字段（没有多余键）', Object.keys(r).sort().join(',') === ['last_event', 'matched', 'ok', 'state', 'summary', 'waited_ms'].sort().join(','), Object.keys(r).join(','))
      const arr = await callWait({ task_id: 'T-F27A', until_state: ['closed', 'pending'] })
      rec.add(G, '★ until_state 也收**数组**（命中任意一个即返回）', arr.ok === true && arr.matched === true && arr.state === 'pending', JSON.stringify({ ok: arr.ok, state: arr.state }))
    }

    // =====================================================================
    // ② 超时 ⇒ ok:false + 当前状态 + 最近事件 + 建议（不静默）
    // =====================================================================
    {
      const G = '② 超时 ⇒ ok:false 且带回当前状态'
      await openFixture(h, 'T-F27B', 'F27 夹具：等待超时。')
      const started = Date.now()
      const r = await callWait({ task_id: 'T-F27B', until_state: 'closed', timeout_ms: 400, interval_ms: 100 })
      const wall = Date.now() - started
      rec.add(G, '★★ 超时 ⇒ ok:false / matched:false', r.ok === false && r.matched === false, JSON.stringify({ ok: r.ok, matched: r.matched }))
      rec.add(G, '★★ **带回当前状态**（state + 中文名都在 summary 里）', r.state === 'pending' && String(r.summary).includes('待分配（pending）'), `state=${r.state}\n${String(r.summary).split('\n')[0]}`)
      rec.add(G, '★★ waited_ms 真的等了（≥ 300ms；墙钟 ≥ 350ms）', r.waited_ms >= 300 && wall >= 350, `waited_ms=${r.waited_ms}　实际墙钟=${wall}ms`)
      rec.add(G, '★★ 最近事件 + 建议都在（超时不许静默）', r.last_event === lastActionOf(h, 'T-F27B') && String(r.summary).includes('最近动作') && String(r.summary).includes('建议') && String(r.summary).includes('超时'), String(r.summary).split('\n').slice(0, 4).join('\n'))
      rec.add(G, '★ 超时也标明"只读"（没改状态、没写文件）', String(r.summary).includes('只读'), '')
    }

    // =====================================================================
    // ③ until_event 命中（用 task.history 里已有的动作）
    // =====================================================================
    {
      const G = '③ until_event 命中（历史里已有的动作）'
      await openFixture(h, 'T-F27C', 'F27 夹具：已存在的 open 动作。')
      const r = await callWait({ task_id: 'T-F27C', until_event: 'open', timeout_ms: 2000, interval_ms: 100 })
      rec.add(G, '★★ 历史里已有 `open` ⇒ 立刻命中（不等 2000）', r.ok === true && r.matched === true && r.waited_ms < 1000, `waited_ms=${r.waited_ms} last_event=${r.last_event}`)
      rec.add(G, '★ 命中事件被回填成 last_event', r.last_event === 'open', `last_event=${r.last_event}`)

      // --- ③-b 真实状态迁移落下 `transition:cancel`，按**事件名**命中 -------------
      await openFixture(h, 'T-F27C2', 'F27 夹具：真实迁移落下 transition:cancel。')
      const tr = await h.store.transition({ taskId: 'T-F27C2', event: 'cancel', actorRole: 'human', actorAgentId: 'f27-human' })
      rec.add(G, '夹具：真实状态迁移 cancel 成功（history 落下 transition:cancel）', tr.ok === true && h.store.peek('T-F27C2').state === 'cancelled', tr.ok === true ? '' : `${tr.code}: ${String(tr.error).split('\n')[0]}`)
      const rPrefix = await callWait({ task_id: 'T-F27C2', until_event: 'cancel' })
      rec.add(G, '★★ 写 `cancel` 命中 `transition:cancel`（**前缀归一化**）', rPrefix.ok === true && rPrefix.matched === true && rPrefix.state === 'cancelled' && rPrefix.last_event === 'transition:cancel', `ok=${rPrefix.ok} state=${rPrefix.state} last_event=${rPrefix.last_event}`)
      const rExact = await callWait({ task_id: 'T-F27C2', until_event: ['transition:cancel'] })
      rec.add(G, '★ 写全名 `transition:cancel` 也命中（精确匹配照旧）', rExact.ok === true && rExact.matched === true, `ok=${rExact.ok}`)

      // --- ③-c `review:ok` 与 `review_ok` 是同一个（规格点名的示例写法）-------------
      //   ★ 夹具说明：`review_ok` 的真实迁移需要整条审核链（L3+ 的交接物 + 状态机路径），
      //     本套只验**匹配归一化**，所以直接把"审核通过那条历史动作"写进 history。
      const t3 = await openFixture(h, 'T-F27C3', 'F27 夹具：review:ok 归一化。')
      t3.history.push({ at: new Date().toISOString(), task_id: 'T-F27C3', actor: 'reviewer', action: 'transition:review_ok', from: 'reviewing', to: 'passed' })
      const rReview = await callWait({ task_id: 'T-F27C3', until_event: 'review:ok', timeout_ms: 1000, interval_ms: 100 })
      rec.add(G, '★★ 写 `review:ok` 命中 `transition:review_ok`（规格点名的写法）', rReview.ok === true && rReview.matched === true && rReview.last_event === 'transition:review_ok', `ok=${rReview.ok} last_event=${rReview.last_event}`)

      // --- ③-d 没出现的事件 ⇒ 超时（反向）---------------------------------------
      await openFixture(h, 'T-F27C4', 'F27 夹具：不存在的事件。')
      const rMiss = await callWait({ task_id: 'T-F27C4', until_event: 'dev_submitted', timeout_ms: 250, interval_ms: 100 })
      rec.add(G, '★ 反向：历史里没有的事件 ⇒ 超时 ok:false', rMiss.ok === false && rMiss.matched === false && rMiss.state === 'pending' && rMiss.last_event === lastActionOf(h, 'T-F27C4'), JSON.stringify({ ok: rMiss.ok, state: rMiss.state, last_event: rMiss.last_event }))
    }

    // =====================================================================
    // ④ 非法参数被拒（不许白等一个 timeout 才发现参数错了）
    // =====================================================================
    {
      const G = '④ 非法参数被拒'
      const cases = [
        ['timeout_ms=120001（超上限）', { task_id: 'T-F27A', until_state: 'pending', timeout_ms: 120001 }, '120000'],
        ['timeout_ms=0（下限之外）', { task_id: 'T-F27A', until_state: 'pending', timeout_ms: 0 }, '超出范围'],
        ['timeout_ms=-1', { task_id: 'T-F27A', until_state: 'pending', timeout_ms: -1 }, '超出范围'],
        ['timeout_ms="abc"（不是整数）', { task_id: 'T-F27A', until_state: 'pending', timeout_ms: 'abc' }, '不是整数'],
        ['timeout_ms=1.5（非整数）', { task_id: 'T-F27A', until_state: 'pending', timeout_ms: 1.5 }, '不是整数'],
        ['interval_ms=99（低于范围）', { task_id: 'T-F27A', until_state: 'pending', interval_ms: 99 }, '超出范围'],
        ['interval_ms=5001（高于范围）', { task_id: 'T-F27A', until_state: 'pending', interval_ms: 5001 }, '超出范围'],
        ['until_state 拼错（会白等）', { task_id: 'T-F27A', until_state: 'closd' }, '不认识的状态'],
        ['两个条件都没给', { task_id: 'T-F27A' }, '至少给'],
        ['缺 task_id', { until_state: 'pending' }, '缺少 task_id'],
        ['任务不存在', { task_id: 'T-F27-NOT-EXIST', until_state: 'pending' }, '找不到任务'],
      ]
      for (const [name, args, must] of cases) {
        const started = Date.now()
        const r = await callWait(args)
        const wall = Date.now() - started
        rec.add(G, `★★ ${name} ⇒ ok:false（阈值内返回，不空等）`, r.ok === false && r.matched === false && String(r.summary).includes(must) && wall < 800, `ok=${r.ok} 墙钟=${wall}ms\n${String(r.summary).split('\n')[0]}`)
      }
    }

    // =====================================================================
    // ⑤ 不改变任务状态、不写文件（逐字节比对）
    // =====================================================================
    {
      const G = '⑤ 只读：不改状态、不写文件'
      await openFixture(h, 'T-F27E', 'F27 夹具：只读性验证。')
      const before = {
        taskJson: shaOf(taskFileOf('T-F27E')),
        auditJsonl: shaOf(auditFileOf('T-F27E')),
        snapshot: JSON.stringify(h.store.peek('T-F27E')),
        historyLen: h.store.peek('T-F27E').history.length,
      }
      const hit = await callWait({ task_id: 'T-F27E', until_state: 'pending' })
      const missed = await callWait({ task_id: 'T-F27E', until_state: 'passed', timeout_ms: 250, interval_ms: 100 })
      rec.add(G, '★ 两次调用本身都返回了（命中 + 超时）', hit.ok === true && missed.ok === false, `hit=${hit.ok} miss=${missed.ok}`)
      const after = {
        taskJson: shaOf(taskFileOf('T-F27E')),
        auditJsonl: shaOf(auditFileOf('T-F27E')),
        snapshot: JSON.stringify(h.store.peek('T-F27E')),
        historyLen: h.store.peek('T-F27E').history.length,
      }
      rec.add(G, '★★ 任务状态没变（仍 pending）', h.store.peek('T-F27E').state === 'pending', h.store.peek('T-F27E').state)
      rec.add(G, '★★ task.json 逐字节不变（没写文件）', before.taskJson === after.taskJson, `${before.taskJson.slice(0, 12)} → ${after.taskJson.slice(0, 12)}`)
      rec.add(G, '★★ audit.jsonl 逐字节不变（没追加审计）', before.auditJsonl === after.auditJsonl, `${before.auditJsonl.slice(0, 12)} → ${after.auditJsonl.slice(0, 12)}`)
      rec.add(G, '★★ 任务对象全文不变（history 长度也不变）', before.snapshot === after.snapshot && before.historyLen === after.historyLen, `history ${before.historyLen} → ${after.historyLen}`)
    }

    // =====================================================================
    // ⑥ 真实长轮询：等待期间状态变化 ⇒ 命中（不是"查一次就返回"）
    // =====================================================================
    {
      const G = '⑥ 真实长轮询：中途满足'
      await openFixture(h, 'T-F27F', 'F27 夹具：等待期间状态变化。')
      // 夹具：150ms 后模拟"另一个动作把任务推到 passed"（同进程写 store 缓存 = 与真实写同一条路）。
      const timer = setTimeout(() => {
        const t = h.store.peek('T-F27F')
        if (t !== null && t !== undefined) t.state = 'passed'
      }, 150)
      try {
        const r = await callWait({ task_id: 'T-F27F', until_state: 'passed', timeout_ms: 3000, interval_ms: 100 })
        rec.add(G, '★★ 轮询真的在"等"：中途变 passed ⇒ 命中（100ms ≤ waited < 2000ms）', r.ok === true && r.matched === true && r.state === 'passed' && r.waited_ms >= 100 && r.waited_ms < 2000, `ok=${r.ok} state=${r.state} waited_ms=${r.waited_ms}`)
      } finally {
        clearTimeout(timer)
      }
    }
    // =====================================================================
    // ⑧ 调用方中止（exec.signal abort）⇒ 立刻返回，不挂满 timeout
    // =====================================================================
    {
      const G = '⑧ 调用方中止 ⇒ 立刻返回'
      await openFixture(h, 'T-F27G', 'F27 夹具：调用方中止。')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120)
      try {
        const started = Date.now()
        const r = await h.byName.get('pipeline_wait').execute(
          { task_id: 'T-F27G', until_state: 'closed', timeout_ms: 5000, interval_ms: 500 },
          { agent: { id: 'f27-main' }, signal: controller.signal },
        )
        const wall = Date.now() - started
        rec.add(G, '★★ 中止信号一来就返回（不必等满 5000ms）', r.ok === false && r.matched === false && wall < 1500 && r.state === 'pending', `ok=${r.ok} 墙钟=${wall}ms state=${r.state}`)
        rec.add(G, '★ summary 说清"这是取消、不是超时"（不静默）', String(r.summary).includes('取消') && String(r.summary).includes('不是超时'), String(r.summary).split('\n')[0])
      } finally {
        clearTimeout(timer)
      }
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF27PipelineWaitCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
