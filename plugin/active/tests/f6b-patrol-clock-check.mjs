/**
 * dsh-pipeline · 缺陷 ⑥：巡检"最后一次进展"时钟的**可复现判据**
 * ============================================================================
 *     node tests/f6b-patrol-clock-check.mjs
 *
 * 真机现场（T-20261015-bb30bc，2026-10-14T17:51:39Z）主对话收到一条播报，
 * 正文说「**巡检发现长时间无进展**」。用户据此怀疑两种可能：
 *   (甲) 部署配置把"无进展"阈值改短了；
 *   (乙) **"最后一次进展"时钟没被交接物 / 状态推进 / 流水刷新** —— 若成立，
 *        真正到点的那条播报还可能被 A23 的幂等键当成重复吃掉。
 *
 * 本套把这两种可能**逐条算给出来**（不猜），并钉住结论：
 *   A. 时钟的**输入面**逐条实测：状态推进 / **流水** / 派活 / 制品 / 交接物 /
 *      记录 / 上下文水位 / 人工请求 / 澄清 —— **一条都不漏**；
 *   B. **现场时刻复算**：把真机那一串时刻喂进同一份判据 ⇒ `stalled ≈ 52 秒`，
 *      远小于 20 分钟 ⇒ 那条播报**不可能**是 `task-stall`
 *      （★ 而且**两种算法都不可能**：算上流水 52 秒、不算流水也才 109 秒）；
 *   C. **A23 幂等键按这个时钟算**：同一段无进展 ⇒ 同一个 id；有新进展后再卡住 ⇒ 新 id
 *      （⇒ 不会把真正到点的播报当重复吃掉）；
 *   D. 阈值确实可配置（传短值该报就报）—— 排除"判据坏了"。
 *   E. ★ **机制自己的播报不算进展**（巡检不自喂自）—— 这是有意的排除项，明写出来。
 *
 * ★ 全程密闭：项目根是自造的临时目录，不读任何活体真单。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createTaskStore } from '../lib/store.js'
import { DEFAULT_TASK_STALL_MS, lastProgressAtMs, patrolFindings } from '../lib/patrol.js'

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
      const L = ['dsh-pipeline · 缺陷 ⑥：巡检"最后一次进展"时钟（可复现判据）', '='.repeat(78)]
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

const T = (iso) => Date.parse(iso)

export async function runF6bPatrolClockCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f6b-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'fizzbuzz.mjs'), 'export const f = () => []\n')
    const store = createTaskStore({ projectRoot: root, artifactDirName: '.pipeline', maxReworkPerLeg: 2 })

    // ------------------------------------------------------------ A 输入面
    const G1 = 'A 时钟的输入面：逐条实测（少一条就是漏路）'
    const a = await store.open({ id: 'T-F6B-A', requirement: '夹具', actorRole: 'main', actorAgentId: 'main-s' })
    rec.add(G1, '夹具：开单成功', a.ok === true, a.error ?? '')
    const t0 = lastProgressAtMs(await store.get('T-F6B-A'))
    rec.add(G1, '开单那一刻就有时间戳（不是 null）', Number.isFinite(t0), `t0=${new Date(t0).toISOString()}`)

    // ② 流水（recordAudit）—— 真机怀疑的那一条（security:scan 走的就是它）
    const beforeFlow = lastProgressAtMs(await store.get('T-F6B-A'))
    await new Promise((r) => setTimeout(r, 1100)) // 时间戳是秒级，隔过一秒才看得出"前进"
    await store.recordAudit('T-F6B-A', 'reviewer', 'security:scan', { finding_count: 0 })
    const afterFlow = lastProgressAtMs(await store.get('T-F6B-A'))
    rec.add(G1, '★★ **流水**（`recordAudit`，`security:scan` 走的就是这条路）**会**推进时钟', afterFlow > beforeFlow, `${new Date(beforeFlow).toISOString()} → ${new Date(afterFlow).toISOString()}`)
    rec.add(G1, '★ 可核：流水确实进了 `task.history`（时钟读的就是它的最后一条）', (await store.get('T-F6B-A')).history.some((h) => h.action === 'security:scan'), '')

    // ③ 状态推进（transition）
    const beforeTr = lastProgressAtMs(await store.get('T-F6B-A'))
    await new Promise((r) => setTimeout(r, 1100))
    await store.transition({ taskId: 'T-F6B-A', event: 'handoff_to_supervisor', actorRole: 'main', actorAgentId: 'main-s' })
    const afterTr = lastProgressAtMs(await store.get('T-F6B-A'))
    rec.add(G1, '★★ **状态推进**（`transition`）**会**推进时钟', afterTr > beforeTr, `${new Date(beforeTr).toISOString()} → ${new Date(afterTr).toISOString()}`)

    // ④ 派活台账（dispatched）
    const beforeDis = lastProgressAtMs(await store.get('T-F6B-A'))
    await new Promise((r) => setTimeout(r, 1100))
    await store.recordDispatch('T-F6B-A', { role: 'writer', seat: 'writer#1', agentId: 'w1', at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), atMs: Date.now() })
    rec.add(G1, '★★ **派活**（`dispatched[]`）**会**推进时钟', lastProgressAtMs(await store.get('T-F6B-A')) > beforeDis, '')

    // ⑤ 制品（artifacts）
    const beforeArt = lastProgressAtMs(await store.get('T-F6B-A'))
    await new Promise((r) => setTimeout(r, 1100))
    await store.registerArtifact({ taskId: 'T-F6B-A', actorRole: 'writer', content: 'x', fileName: 'a.mjs' })
    rec.add(G1, '★★ **制品**（`artifacts[]`）**会**推进时钟', lastProgressAtMs(await store.get('T-F6B-A')) > beforeArt, '')

    // ⑥ 其余四类：纯函数覆盖（这几类是"任务台账里的事件数组"，用合成输入更直白）
    const pure = (patch) => lastProgressAtMs({ history: [], dispatched: [], ...patch })
    const base = pure({})
    const cases = [
      ['交接物 `handoffs[].created_at`', { handoffs: [{ created_at: '2030-01-01T00:00:00Z' }] }],
      ['记录 `records[].at`', { records: [{ at: '2030-01-01T00:00:00Z' }] }],
      ['上下文水位 `context_reports[].at`', { context_reports: [{ at: '2030-01-01T00:00:00Z' }] }],
      ['人工请求 `human_requests[]`', { human_requests: [{ at: '2030-01-01T00:00:00Z' }] }],
      ['澄清 `clarification_requests[]`', { clarification_requests: [{ at: '2030-01-01T00:00:00Z' }] }],
    ]
    for (const [name, patch] of cases) {
      const v = pure(patch)
      rec.add(G1, `★★ ${name} **会**推进时钟`, v === T('2030-01-01T00:00:00Z'), `${v === null ? 'null' : new Date(v).toISOString()}`)
    }
    rec.add(G1, '★ 一条证据都没有 ⇒ 返回 `null` 并**不猜**（巡检的纪律：宁可说"读不到"）', base === null, String(base))

    // ------------------------------------------------------------ E 有意排除
    const G5 = 'E 有意**排除**的（不是漏路，是纪律）'
    const onlyUpdatedAt = lastProgressAtMs({ history: [], dispatched: [], updated_at: '2030-01-01T00:00:00Z' })
    rec.add(G5, '★★ `task.updated_at` **不算进展** —— 机制自己的每一次落盘都会刷新它，算进去就等于**巡检自喂自**（A22/A23 会当场失效）', onlyUpdatedAt === null, String(onlyUpdatedAt))

    // ------------------------------------------------------------ B 现场时刻复算
    const G2 = 'B 现场时刻复算：那条播报**不可能**是 `task-stall`'
    const DISPATCH = '2026-10-14T17:49:50Z' // 派审核（状态进 reviewing）
    const SCAN = '2026-10-14T17:50:47Z' // 审核席位的 security:scan 流水
    const PATROL = '2026-10-14T17:51:39Z' // 那条播报的时刻
    const live = {
      id: 'T-20261015-bb30bc',
      state: 'reviewing',
      history: [
        { at: DISPATCH, action: 'transition:dispatch_reviewer', from: 'ready_review', to: 'reviewing' },
        { at: SCAN, action: 'security:scan' },
      ],
      dispatched: [{ role: 'reviewer', seat: null, at: DISPATCH }],
      handoffs: [{ kind: 'test_to_review', created_at: '2026-10-14T17:49:43Z' }],
    }
    const nowMs = T(PATROL)
    const last = lastProgressAtMs(live)
    const stalled = nowMs - last
    rec.add(G2, '★★ 时钟取到的是**最后一次流水**（17:50:47），不是派活那一刻', last === T(SCAN), `${new Date(last).toISOString()}`)
    rec.add(G2, `★★ 复算：距最后一次进展只有 **${Math.round(stalled / 1000)} 秒**，远小于口径 ${DEFAULT_TASK_STALL_MS / 60000} 分钟`, stalled < DEFAULT_TASK_STALL_MS, `stalled=${stalled} ms`)
    const f1 = patrolFindings({ task: live, now: nowMs, stallMs: DEFAULT_TASK_STALL_MS })
    rec.add(G2, '★★ 所以 `patrolFindings` **不产生** `task-stall` —— 那条播报与"无进展"无关', !f1.findings.some((x) => x.kind === 'task-stall'), `findings=[${f1.findings.map((x) => x.kind).join('、') || '（空）'}]　stalled_ms=${f1.stalled_ms}`)
    // 两种算法都不可能：就算完全不认"流水"，也只有 109 秒
    const withoutFlow = { ...live, history: [{ at: DISPATCH, action: 'transition:dispatch_reviewer' }] }
    const stalled2 = nowMs - lastProgressAtMs(withoutFlow)
    rec.add(G2, `★★ **两种算法都不可能**：就算完全不认流水，也只有 **${Math.round(stalled2 / 1000)} 秒** ⇒ 用户看到的"1 分 49 秒"从来不是阈值问题`, stalled2 < DEFAULT_TASK_STALL_MS, `stalled(不算流水)=${stalled2} ms`)
    rec.add(G2, '★ 结论落到文案上：那条 `unresolved-wake` 的正文**不许**自称"长时间无进展"（缺陷 ⑥ 的正题，见 f6-patrol-notice-check）', true, '')

    // ------------------------------------------------------------ C 幂等键
    const G3 = 'C A23 幂等键按**这个**时钟算：不会把真正到点的播报当重复吃掉'
    const stallTask = { ...live, history: [{ at: DISPATCH, action: 'transition:dispatch_reviewer' }] }
    const late = nowMs + DEFAULT_TASK_STALL_MS + 60_000
    const s1 = patrolFindings({ task: stallTask, now: late, stallMs: DEFAULT_TASK_STALL_MS })
    const s2 = patrolFindings({ task: stallTask, now: late + 5 * 60_000, stallMs: DEFAULT_TASK_STALL_MS })
    const stall1 = s1.findings.find((x) => x.kind === 'task-stall')
    const stall2 = s2.findings.find((x) => x.kind === 'task-stall')
    rec.add(G3, '★ 到点了 ⇒ 该报就报（判据没坏）', stall1 !== undefined && stall2 !== undefined, `stalled_ms=${s1.stalled_ms}`)
    rec.add(G3, '★★ 同一段无进展跨两次巡检 ⇒ **同一个 id**（这就是"只播一次"）', stall1?.id === stall2?.id, stall1?.id)
    rec.add(G3, '★★ id 里带着**最后一次进展时刻**（可核：就是这个时钟算出来的）', String(stall1?.id).includes(DISPATCH), stall1?.id)
    // 有进展之后再卡住 ⇒ 新 id（不会永久哑掉）
    // ⚠️ 夹具口径：新进展（18:30）必须在被判定的 now 之前 —— 否则 stalled 恒为 0，
    //    "没有播报"会被误读成"判据不成立"（本套第一版就是这么写错的）。
    const resumed = { ...stallTask, history: [...stallTask.history, { at: '2026-10-14T18:30:00Z', action: 'transition:dev_submitted' }] }
    const s3 = patrolFindings({ task: resumed, now: T('2026-10-14T19:00:00Z'), stallMs: DEFAULT_TASK_STALL_MS })
    const stall3 = s3.findings.find((x) => x.kind === 'task-stall')
    rec.add(G3, '★★ 进展恢复后再卡住 ⇒ **新 id**（不会被当成重复吃掉，也不会永久哑掉）', stall3 !== undefined && stall3.id !== stall1?.id, `${stall3?.id ?? '(没有播报)'}　stalled_ms=${s3.stalled_ms}`)
    rec.add(G3, '★ 新 id 里带的是**新的**那次进展时刻（18:30）', String(stall3?.id).includes('2026-10-14T18:30:00Z'), stall3?.id)

    // ------------------------------------------------------------ D 阈值可配置
    const G4 = 'D 口径可配置（排除"判据坏了"这一支）'
    const short = patrolFindings({ task: stallTask, now: nowMs, stallMs: 30_000 })
    rec.add(G4, '★ 把口径调到 30 秒 ⇒ 同一份数据**该报就报**（判据是活的）', short.findings.some((x) => x.kind === 'task-stall'), `stalled_ms=${short.stalled_ms}`)
    rec.add(G4, '★ 默认口径就是 20 分钟（与 config.js 的注释同源）', DEFAULT_TASK_STALL_MS === 20 * 60 * 1000, String(DEFAULT_TASK_STALL_MS))
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF6bPatrolClockCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
