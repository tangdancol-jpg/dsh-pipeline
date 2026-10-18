// P1-9 回归：哈希闸门区分「别的编写席位先写进工作区」与「本次新增且未声明」；foreign_paths_ack 一次显式确认归属。
/**
 * dsh-pipeline · F25：哈希闸门的**归属**判据（P1-9）
 * ============================================================================
 *     node tests/f25-hashgate-attribution-check.mjs
 *
 * 现场（`内部复盘（2026-10-18，不公开）` P1-9）：
 *   多个编写席位并行时，writer#2 交 `dev_to_test` 的那一刻，writer#1 **先写进工作区**的
 *   文件也在「基线以来的变化」里 —— 它不是 writer#2 改的，却会被算成 writer#2 的
 *   `undeclared_change`；连续误报 3 次还会触发「机制自动交人工」，把任务推到「已阻塞」。
 *
 * 修法（最小安全修复）：
 *   `dev_to_test` 可以带一次**显式确认**：
 *     `foreign_paths_ack: [{ path, reason }]`
 *   判据本体 `lib/hashgate/foreign-ack.js`（五条硬判据）；本套钉住四件事：
 *
 *   A. **基线里已存在、本次未动**的他人文件 ⇒ 不参与声明对账（不报 undeclared_change）；
 *   B. **本次新增且未声明** ⇒ **仍然报**（核心判据一个字没放宽），且 ack **不能**把
 *      **本席自己分区**的改动洗成别人的（判据②；单席位/重叠分区也走不到）；
 *   C. **foreign_paths_ack 显式确认**别的编写席位分区内的变化 ⇒ 不再误报，闸门 pass，
 *      且确认**不静默**（`counts.foreign_paths_acked` + `gate:hash` 审计逐条留档）；
 *   D. **ack 只对点名的路径生效**：同一次提交里没点名的外来路径照旧报 undeclared；
 *      ack **不能给越界改动背书**（授权面之外的改动照旧拒）。
 *   E. **单席位任务**没有"别的编写席位"可归属 ⇒ ack 一律被拒（不会退化成一句通配赦免）。
 *
 * ★ 每条断言在修复前都跑过对照（见交付报告）：C 的正例就是当时那条 `HASH_GATE_FAILED`。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { callTool, createHarness, disposeHarness, runAnalysisThenPlan } from './selftest-core.mjs'

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
      const L = ['dsh-pipeline · F25：哈希闸门归属判据（P1-9：别的编写席位的产物不算本席未申报）', '='.repeat(78)]
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

const put = async (root, rel, text) => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), text, 'utf8')
}

// ---------------------------------------------------------------------------
// 夹具：两个编写席位（路径互不重叠 —— 编排层本就要求分区不重叠），停在「开发中」
// ---------------------------------------------------------------------------

const PARTITIONS = [
  { seat: 'writer#1', layer: 'interface', scope_paths: ['src/web'], deliverables: ['前端页面'] },
  { seat: 'writer#2', layer: 'data', scope_paths: ['src/api'], deliverables: ['后端接口'] },
]
const SCOPE = [
  { id: 'CS1', path: 'src/web', action: 'modify', why: '前端改动在这里' },
  { id: 'CS2', path: 'src/api', action: 'modify', why: '后端改动在这里' },
]

/**
 * 建一个「两个编写席位、已经有基线、停在开发中」的任务。
 * 基线由计划那一刻取好（`pipeline_plan` 自动记）⇒ 之后写的一切都算「动过」。
 */
async function fixture(tag, { partitions = PARTITIONS, scope = SCOPE } = {}) {
  const h = await createHarness({})
  const root = h.projectRoot
  // 基线里**已经存在**的文件（组 A 用它证明"基线已有的他人文件"不参与声明对账）
  await put(root, 'src/web/base.js', 'export const web = 0\n')
  await put(root, 'src/api/base.js', 'export const api = 0\n')
  const MAIN = `f25-${tag}-main`
  const opened = await callTool(h, 'pipeline_task_open', { requirement: `F25 夹具（${tag}）：给订单系统加导出功能（前端页面 + 后端接口）。`, deliverable_format: '补丁 + 变更说明' }, MAIN)
  if (opened.denied) throw new Error(`开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id
  const tokens = { main: opened.value.role_token }
  const agents = { main: MAIN }
  await runAnalysisThenPlan(h, {
    taskId,
    tokens,
    agents,
    tier: 'L2',
    reason: 'F25 夹具：两个编写席位、路径互不重叠，可并行推进',
    layers: partitions.map((p) => ({ layer: p.layer, scope_paths: p.scope_paths, deliverables: p.deliverables })),
    writers: {
      layers: partitions.map((p) => p.layer),
      partitions,
      reason: '两块路径互不重叠（编排层要求），可以并行',
    },
    changeScope: scope,
  })
  const tr = await h.store.transition({ taskId, event: 'dispatch_writer', actorRole: 'main' })
  if (tr.ok !== true) throw new Error(`推进到开发中失败：${tr.error}`)
  return {
    h,
    root,
    taskId,
    partitionOf: (seat) => partitions.find((p) => p.seat === seat) ?? partitions[0],
    seats: partitions.map((p) => p.seat),
  }
}

/** 让某个席位居交一份 dev_to_test（走真 store 的闸门判定路径）。 */
function submitDev(f, seat, manifest, over = {}) {
  const p = f.partitionOf(seat)
  const idx = f.seats.indexOf(seat) + 1
  return f.h.store.submitHandoff({
    taskId: f.taskId,
    kind: 'dev_to_test',
    actorRole: 'writer',
    actorSeat: seat,
    actorAgentId: `f25-${seat}`,
    payload: {
      task_id: f.taskId,
      artifact_version: 'v1',
      patch_or_code: `（${seat} 的改动）`,
      change_note: `${seat} 完成了自己那一段`,
      run_commands: [`node tests/${seat.replace('#', '-')}.mjs`],
      selftest_result: '本地跑通',
      known_issues: [],
      partition: { seat, index: idx, total: f.seats.length, scope_paths: p.scope_paths, layer: p.layer },
      change_manifest: manifest,
      ...over,
    },
  })
}

const lastGate = (f) => [...(f.h.store.peek(f.taskId).history ?? [])].reverse().find((e) => e.action === 'gate:hash') ?? null
const lastCheck = (f) => (f.h.store.peek(f.taskId).hash_gate_checks ?? []).at(-1) ?? null
const shapes = (v) => `${JSON.stringify(v)}`

export async function runF25HashgateAttributionCheck() {
  const rec = createRecorder()
  const open = []
  try {
    // =======================================================================
    // A. 基线里已存在、本次未动的他人文件 ⇒ 不报 undeclared_change
    // =======================================================================
    {
      const G = '① 基线已存在、本次未动的他人文件'
      const f = await fixture('a')
      open.push(f.h)
      // 基线里 src/web/base.js 属于 writer#1 的授权路径，但本次谁都没动它
      await put(f.root, 'src/api/new.js', 'export const n = 1\n')
      const r = await submitDev(f, 'writer#2', [{ path: 'src/api/new.js', action: 'create', scope_id: 'CS2' }])
      const g = lastGate(f)
      const audit = await f.h.store.changeAudit({ taskId: f.taskId })
      rec.add(G, '★★ 只交了本席自己那份（基线里的他人文件没动）⇒ 闸门 pass', r.ok === true && g?.pass === true, r.ok === true ? `counts=${shapes(g?.counts)}` : `${r.code}\n${String(r.error).split('\n').slice(0, 6).join('\n')}`)
      rec.add(G, '★ `undeclared_change` = 0（"基线已存在"不是本席的账）', (g?.counts?.undeclared ?? -1) === 0, shapes(g?.counts))
      rec.add(G, '★ 基线里那份他人文件根本不在改动审计里（没变化 ⇒ 不参与声明对账）', !audit.added.some((x) => x.path === 'src/web/base.js') && !audit.modified.some((x) => x.path === 'src/web/base.js'), shapes({ added: audit.added.map((x) => x.path), modified: audit.modified.map((x) => x.path) }))
    }

    // =======================================================================
    // B. 本次新增且未声明 ⇒ 仍然报；ack 不能把本席自己分区的改动洗白
    // =======================================================================
    {
      const G = '② 本次新增且未声明（核心判据不许放宽）'
      const f = await fixture('b')
      open.push(f.h)
      await put(f.root, 'src/api/declared.js', 'export const d = 1\n')
      await put(f.root, 'src/api/secret.js', 'export const s = 1\n') // ★ 本席自己的分区，但没申报
      const r = await submitDev(f, 'writer#2', [{ path: 'src/api/declared.js', action: 'create', scope_id: 'CS2' }])
      const g = lastGate(f)
      rec.add(G, '★★ 本席自己分区里新增了没申报的文件 ⇒ **照样 HASH_GATE_FAILED**', r.ok !== true && r.code === 'HASH_GATE_FAILED', String(r.code ?? ''))
      rec.add(G, '★★ violations 里正是那条没申报的 `src/api/secret.js`', (g?.violations ?? []).some((v) => String(v) === 'undeclared_change:src/api/secret.js'), shapes(g?.violations))
      rec.add(G, '★ 已申报的那条不算 undeclared（undeclared=1）', (g?.counts?.undeclared ?? -1) === 1, shapes(g?.counts))
      rec.add(G, '★ 连续不过计数 +1（修复没有把闸门的计数逻辑弄丢）', f.h.store.peek(f.taskId).hash_gate_streak === 1, `streak=${f.h.store.peek(f.taskId).hash_gate_streak}`)

      // 反例：想用 ack 把自己的改动"洗"成别人的 ⇒ 判据②当场拒
      const wash = await submitDev(
        f,
        'writer#2',
        [{ path: 'src/api/declared.js', action: 'create', scope_id: 'CS2' }],
        { foreign_paths_ack: [{ path: 'src/api/secret.js', reason: '想把它确认成别人的' }] },
      )
      rec.add(
        G,
        '★★ **ack 不能洗自己的改动**：点名本席分区内的路径 ⇒ 拒绝（FOREIGN_PATH_ACK_OWN_PARTITION）',
        wash.ok !== true && wash.code === 'FOREIGN_PATH_ACK_OWN_PARTITION' && /本席(自己)?的分区/.test(String(wash.error)),
        `${wash.code}\n${String(wash.error).split('\n').slice(0, 8).join('\n')}`,
      )
      rec.add(G, '★ 这条拒绝**不进**"连续不过"计数（是用法错误，不是改动面对不上）', f.h.store.peek(f.taskId).hash_gate_streak === 1, `streak=${f.h.store.peek(f.taskId).hash_gate_streak}`)

      // 反例：把"没变化的路径"提前确认 ⇒ 判据①拒（ack 不是提前买保险）
      const unchanged = await submitDev(
        f,
        'writer#2',
        [{ path: 'src/api/declared.js', action: 'create', scope_id: 'CS2' }],
        { foreign_paths_ack: [{ path: 'src/web/base.js', reason: '它不属于我' }] },
      )
      rec.add(
        G,
        '★★ **ack 不是提前买保险**：点名的路径本次没有变化 ⇒ 拒绝（FOREIGN_PATH_ACK_UNCHANGED）',
        unchanged.ok !== true && unchanged.code === 'FOREIGN_PATH_ACK_UNCHANGED' && /没有变化/.test(String(unchanged.error)),
        `${unchanged.code}\n${String(unchanged.error).split('\n').slice(0, 8).join('\n')}`,
      )
    }

    // =======================================================================
    // C. foreign_paths_ack 显式确认 ⇒ 不再误报（P1-9 的修复点）
    // =======================================================================
    {
      const G = '③ foreign_paths_ack 显式确认（修复点：修复前这单必被误报）'
      const f = await fixture('c')
      open.push(f.h)
      // writer#1 先写完并交（他的产物在 writer#2 交的时候仍是"基线以来的变化"）
      await put(f.root, 'src/web/index.js', 'export const w = 2\n')
      const r1 = await submitDev(f, 'writer#1', [{ path: 'src/web/index.js', action: 'modify', scope_id: 'CS1' }])
      rec.add(G, '前置：writer#1 交自己那份 ⇒ pass（1/2，状态不动）', r1.ok === true && f.h.store.peek(f.taskId).state === 'developing', r1.ok === true ? `state=${f.h.store.peek(f.taskId).state}` : `${r1.code}\n${String(r1.error).split('\n').slice(0, 6).join('\n')}`)

      await put(f.root, 'src/api/routes.js', 'export const r = 2\n')
      const r2 = await submitDev(
        f,
        'writer#2',
        [{ path: 'src/api/routes.js', action: 'modify', scope_id: 'CS2' }],
        { foreign_paths_ack: [{ path: 'src/web/index.js', reason: '属于 writer#1 的分区，本席未改动' }] },
      )
      const g = lastGate(f)
      rec.add(G, '★★ writer#2 交自己那份 + 显式确认 writer#1 的产物 ⇒ **pass**（修复前：HASH_GATE_FAILED/undeclared_change:src/web/index.js）', r2.ok === true && g?.pass === true, r2.ok === true ? `counts=${shapes(g?.counts)}` : `${r2.code}\n${String(r2.error).split('\n').slice(0, 10).join('\n')}`)
      rec.add(G, '★ 确认被**计数**且不静默：`counts.foreign_paths_acked=1`', (g?.counts?.foreign_paths_acked ?? -1) === 1, shapes(g?.counts))
      rec.add(G, '★ 逐条留档：`gate:hash` 审计里写着 `路径→归属席位`', (g?.acknowledged_foreign ?? []).some((x) => String(x) === 'src/web/index.js→writer#1'), shapes(g?.acknowledged_foreign))
      const chk = lastCheck(f)
      rec.add(G, '★ `hash_gate_checks` 里带理由与归属席位（事后可核）', (chk?.acknowledged_foreign ?? []).some((x) => x.path === 'src/web/index.js' && x.owner_seat === 'writer#1' && String(x.reason).includes('writer#1')), shapes(chk?.acknowledged_foreign))
      {
        // ★ 确认只调整**归属**，不删改动：改动审计（changeAudit）照旧列出这条变化
        const audit = await f.h.store.changeAudit({ taskId: f.taskId })
        const listed = audit.added.some((x) => x.path === 'src/web/index.js') || audit.modified.some((x) => x.path === 'src/web/index.js')
        rec.add(G, '★ 原始改动**没有被藏掉**：changeAudit 仍列出 src/web/index.js（只是不计入本席）', listed, shapes([...audit.added, ...audit.modified].map((x) => x.path)))
      }
      const st = f.h.store.peek(f.taskId)
      rec.add(G, '★ 两席都交齐 ⇒ 状态推进到「待测试」', st.state === 'ready_test' && Object.keys(st.writer_submissions ?? {}).length === 2, `state=${st.state} writer_submissions=${shapes(Object.keys(st.writer_submissions ?? {}))}`)
    }

    // =======================================================================
    // D. ack 只对点名的路径生效（没点名的外来路径照旧报）
    // =======================================================================
    {
      const G = '④ ack 只对点名的路径生效'
      const f = await fixture('d')
      open.push(f.h)
      await put(f.root, 'src/web/a.js', 'export const a = 1\n')
      await put(f.root, 'src/web/b.js', 'export const b = 1\n')
      const r1 = await submitDev(f, 'writer#1', [
        { path: 'src/web/a.js', action: 'create', scope_id: 'CS1' },
        { path: 'src/web/b.js', action: 'create', scope_id: 'CS1' },
      ])
      rec.add(G, '前置：writer#1 交两条产物 ⇒ pass', r1.ok === true, r1.ok === true ? '' : `${r1.code}\n${String(r1.error).split('\n').slice(0, 6).join('\n')}`)

      await put(f.root, 'src/api/c.js', 'export const c = 1\n')
      const partial = await submitDev(
        f,
        'writer#2',
        [{ path: 'src/api/c.js', action: 'create', scope_id: 'CS2' }],
        { foreign_paths_ack: [{ path: 'src/web/a.js', reason: '属于 writer#1 的分区' }] },
      )
      const g = lastGate(f)
      rec.add(G, '★★ 只点名 a.js ⇒ b.js **照旧**报 undeclared（部分确认不等于全免）', partial.ok !== true && (g?.violations ?? []).some((v) => String(v) === 'undeclared_change:src/web/b.js'), `${partial.code}\nviolations=${shapes(g?.violations)}`)
      rec.add(G, '★ 已点名的那条**不再**出现在 violations 里', !(g?.violations ?? []).some((v) => String(v).includes('src/web/a.js')), shapes(g?.violations))
      rec.add(G, '★ 这一轮仍按"已确认 1 处"记账（计数与 violations 不同源，不互相污染）', (g?.counts?.foreign_paths_acked ?? -1) === 1 && (g?.counts?.undeclared ?? -1) === 1, shapes(g?.counts))

      // 补齐两条确认 ⇒ pass
      const full = await submitDev(
        f,
        'writer#2',
        [{ path: 'src/api/c.js', action: 'create', scope_id: 'CS2' }],
        {
          foreign_paths_ack: [
            { path: 'src/web/a.js', reason: '属于 writer#1 的分区' },
            { path: 'src/web/b.js', reason: '属于 writer#1 的分区' },
          ],
        },
      )
      rec.add(G, '★ 补齐两条确认 ⇒ pass（确认数量与"别的席位产物"对得上）', full.ok === true, full.ok === true ? '' : `${full.code}\n${String(full.error).split('\n').slice(0, 8).join('\n')}`)
    }

    // =======================================================================
    // E. ack 不能给越界改动背书（风险边界：授权面之外的改动照旧拒）
    // =======================================================================
    {
      const G = '⑤ ack 不能给越界改动背书'
      // writer#1 的分区比授权面宽（`src/other` 在分区里、但不在 change_scope 里）
      const f = await fixture('e', {
        partitions: [
          { seat: 'writer#1', layer: 'interface', scope_paths: ['src/web', 'src/other'], deliverables: ['前端 + 其它'] },
          { seat: 'writer#2', layer: 'data', scope_paths: ['src/api'], deliverables: ['后端接口'] },
        ],
      })
      open.push(f.h)
      await put(f.root, 'src/other/evil.js', 'export const e = 1\n') // 授权面之外（越界）
      await put(f.root, 'src/api/routes.js', 'export const r = 3\n')
      const r = await submitDev(
        f,
        'writer#2',
        [{ path: 'src/api/routes.js', action: 'modify', scope_id: 'CS2' }],
        { foreign_paths_ack: [{ path: 'src/other/evil.js', reason: '属于 writer#1 的分区' }] },
      )
      rec.add(
        G,
        '★★ 确认一条**越界**改动 ⇒ 拒绝（FOREIGN_PATH_ACK_OUT_OF_SCOPE）',
        r.ok !== true && r.code === 'FOREIGN_PATH_ACK_OUT_OF_SCOPE' && /越界|授权面之外/.test(String(r.error)),
        `${r.code}\n${String(r.error).split('\n').slice(0, 10).join('\n')}`,
      )
      // 同一处越界改动，不带 ack 再交一次 ⇒ 闸门照旧把它判成越界（证明 ack 从来没在判定层"吞掉"它）
      const plain = await submitDev(f, 'writer#2', [{ path: 'src/api/routes.js', action: 'modify', scope_id: 'CS2' }])
      const g = lastGate(f)
      rec.add(
        G,
        '★★ 不带 ack 再交 ⇒ 越界那条照旧进 violations（ack 不能把越界改动从判据里"吞掉"）',
        plain.ok !== true && (g?.violations ?? []).some((v) => String(v).includes('src/other/evil.js')),
        `${plain.code}\nviolations=${shapes(g?.violations)}`,
      )
    }

    // =======================================================================
    // F. 单席位任务：ack 没有可归属的对象 ⇒ 一律拒（不许退化成通配赦免）
    // =======================================================================
    {
      const G = '⑥ 单席位任务没有"别的编写席位"'
      const f = await fixture('f', { partitions: [PARTITIONS[0]], scope: [SCOPE[0]] })
      open.push(f.h)
      await put(f.root, 'src/web/own.js', 'export const o = 1\n')
      const r = await submitDev(
        f,
        'writer#1',
        [{ path: 'src/web/own.js', action: 'create', scope_id: 'CS1' }],
        { foreign_paths_ack: [{ path: 'src/web/own.js', reason: '不是我的（单席位）' }] },
      )
      rec.add(
        G,
        '★★ 单席位任务带 ack ⇒ 拒绝（FOREIGN_PATH_ACK_NO_OTHER_SEAT；没有"别的编写席位"可归属）',
        r.ok !== true && r.code === 'FOREIGN_PATH_ACK_NO_OTHER_SEAT' && /没有.*别的编写席位/.test(String(r.error)),
        `${r.code}\n${String(r.error).split('\n').slice(0, 6).join('\n')}`,
      )
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    for (const h of open) await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF25HashgateAttributionCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
