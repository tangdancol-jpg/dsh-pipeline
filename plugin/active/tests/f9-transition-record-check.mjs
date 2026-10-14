/**
 * dsh-pipeline · 缺陷 ⑨：`handoff_to_supervisor` 的返回看不出台账改没改
 * ============================================================================
 *     node tests/f9-transition-record-check.mjs
 *
 * 真机现场（T-20261015-bb30bc）：主对话把任务递给主管，返回是
 * 「任务 T-20261015-f49c2b：**待分配 → 待分配**。」—— 那条事件在状态机里就是
 * `pending → pending`（它**不改状态**，只登记"谁递的"），于是**看不出递单成没成**。
 *
 * 本套钉住四件事：
 *   A. **`from === to` 的迁移必须自己交代"记了什么"**（台账名 / 值 / 下一步谁动）；
 *   B. 现场那条事件（`handoff_to_supervisor`）的返回里**给出 `by` 与 `at`**，
 *      能据此判断递单成功；
 *   C. **真有状态变化的迁移一个字没改**（不许多出一段）；
 *   D. 其它"不改状态"的事件也至少说清"留痕落在哪"，不许只回一句 `A → A`。
 *
 * ★ 项目根是自造的临时目录：不读、不写任何活体真单。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createTaskStore } from '../lib/store.js'
import { describeTransitionRecord } from '../lib/store/transition-record.js'

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
      const L = ['dsh-pipeline · 缺陷 ⑨：不改状态的迁移必须交代"记了什么"', '='.repeat(78)]
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

export async function runF9TransitionRecordCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f9-'))
  try {
    const store = createTaskStore({ projectRoot: root, artifactDirName: '.pipeline', maxReworkPerLeg: 2 })
    const open = (id) => store.open({ id, requirement: '夹具：递给主管', actorRole: 'main', actorAgentId: 'main-s' })

    // ------------------------------------------------------------ A/B 现场形状
    const G1 = 'A/B 现场形状：`handoff_to_supervisor`（pending → pending）'
    const a = await open('T-F9-A')
    rec.add(G1, '夹具：开单成功（pending）', a.ok === true && a.task.state === 'pending', a.task?.state ?? a.error)
    const tr = await store.transition({ taskId: 'T-F9-A', event: 'handoff_to_supervisor', actorRole: 'main', actorAgentId: 'main-s', note: '' })
    rec.add(G1, '★ 迁移本身成功', tr.ok === true, tr.error ?? '')
    rec.add(G1, '★★ 状态确实**没变**（这就是缺陷的由来：`from === to`）', tr.from === 'pending' && tr.to === 'pending', `${tr.from} → ${tr.to}`)
    rec.add(G1, '★★ 返回里**不再只有** `A → A`：多出一段"已记录"的说明', String(tr.summary).includes('已记录'), String(tr.summary).split('\n')[1] ?? '(没有第二行)')
    rec.add(G1, '★★ 说明里给出**真实存在的**台账名（`task.hub.entry` —— 写点在 `store/hub.js` 的 `applyHubSideEffects`）', String(tr.summary).includes('task.hub.entry'), '')
    rec.add(G1, '★★ 说明里给出**谁递的**与**什么时候**（`by: "main"` / `at: <ISO>`）', String(tr.summary).includes('by: "main"') && /\bat: "\d{4}-\d{2}-\d{2}T/.test(String(tr.summary)), String(tr.summary).split('\n')[1] ?? '')
    rec.add(G1, '★ 说明里点明"这条事件不改状态"（免得读者以为状态机坏了）', String(tr.summary).includes('不改状态'), '')
    rec.add(G1, '★ 说明里给出**下一步谁动**（主管发起）', String(tr.summary).includes('pipeline_supervise'), '')
    const after = await store.get('T-F9-A')
    rec.add(G1, '★★ 台账**真的落盘了**（返回里那句话不是文案，是可核的事实）：`task.hub.entry.by === "main"`', after?.hub?.entry?.by === 'main' && typeof after?.hub?.entry?.at === 'string', JSON.stringify(after?.hub?.entry ?? null))
    rec.add(G1, '★★ 反例（本套**抓过我自己一次**）：`task.handoff_to_supervisor` 这个字段**不存在** —— 文案不许指着一个查不到的台账', !Object.hasOwn(after ?? {}, 'handoff_to_supervisor'), `字段清单里有 handoff_to_supervisor 吗：${Object.hasOwn(after ?? {}, 'handoff_to_supervisor')}`)
    rec.add(G1, '★ 留痕进了 `task.history`（`transition:handoff_to_supervisor`）', (after?.history ?? []).some((h) => h.action === 'transition:handoff_to_supervisor'), '')

    // ------------------------------------------------------------ C 有状态变化的不许多话
    const G2 = 'C 真有状态变化的迁移**一个字没改**'
    const b = await open('T-F9-B')
    rec.add(G2, '夹具：另一张单', b.ok === true, '')
    const cancel = await store.transition({ taskId: 'T-F9-B', event: 'cancel', actorRole: 'human', actorAgentId: 'human-s', note: '夹具' })
    rec.add(G2, '★ `cancel`（pending → cancelled）成功且**状态真的变了**', cancel.ok === true && cancel.from !== cancel.to, `${cancel.from} → ${cancel.to}`)
    rec.add(G2, '★★ 它的返回**照旧只有那一行**（没有多出"已记录"段）', !String(cancel.summary).includes('已记录'), String(cancel.summary))
    rec.add(G2, '★ 逐字对照：格式仍是「任务 <id>：<中文态> → <中文态>。」', /^任务 T-F9-B：.+ → .+。$/.test(String(cancel.summary)), JSON.stringify(String(cancel.summary)))
    rec.add(G2, '`describeTransitionRecord()` 对 `from !== to` 返回**空串**（判据本身也是这么写的）', describeTransitionRecord({ event: 'cancel', task: {}, from: 'pending', to: 'cancelled' }) === '', '')

    // ------------------------------------------------------------ D 其它不改状态的事件
    const G3 = 'D 其它"不改状态"的事件也至少说清"留痕落在哪"'
    const d = await open('T-F9-C')
    rec.add(G3, '夹具：第三张单', d.ok === true, '')
    const line = describeTransitionRecord({
      event: 'some_annotation_event',
      task: { history: [{ at: '2026-10-15T00:00:00Z', action: 'transition:some_annotation_event' }], updated_at: '2026-10-15T00:00:00Z' },
      from: 'pending',
      to: 'pending',
    })
    rec.add(G3, '★★ 认不出的事件也**不许只回一句 `A → A`** —— 要写清 `task.history` + `audit.jsonl`', line.includes('task.history') && line.includes('audit.jsonl'), line.split('\n')[0])
    rec.add(G3, '★ 并带上事件名与时刻（可追溯）', line.includes('some_annotation_event') && line.includes('2026-10-15T00:00:00Z'), '')
    rec.add(G3, '★ 仍然明说"状态未变、这条事件不改状态"', line.includes('状态**未变**') || line.includes('未变'), '')
    rec.add(G3, '★ 空输入不抛（守门那条纪律：判据不许把主流程带崩）', describeTransitionRecord({}) === '' && describeTransitionRecord({ event: 'x', from: '', to: 'pending' }) === '', '')
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF9TransitionRecordCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
