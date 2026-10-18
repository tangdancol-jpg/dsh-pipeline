// P1-9 删除类残留：foreign_paths_ack 允许确认"别的编写席位删掉的文件"（无哈希证据、强度弱，但护栏一条不少）。
/**
 * dsh-pipeline · F38：外来路径确认的**删除类**支持（P1-9 残余）
 * ============================================================================
 *     node tests/f38-ack-delete-check.mjs
 *
 * 现场（P1-9 的第二半）：多编写席位并行时，**别的席位删掉它分区里的文件**，
 * 本席交 `dev_to_test` 时那条删除同样是"基线以来的变化" —— 修复前它**不能**被
 * `foreign_paths_ack` 确认（判据写了"删除类不适用"）⇒ 照样被判 `undeclared_change`，
 * 连续几次又把任务推到「已阻塞」。
 *
 * 修法（最小安全修复的第二半）：
 *   · 删除类**允许**确认，但删除拿不到"当前内容哈希" ⇒ 这类确认**没有哈希证据**
 *     （`evidence:'deleted_no_hash'`，强度弱于新增/修改的 `changed_hash`）；
 *   · 计数**单列**：`counts.foreign_paths_acked_deleted`（不混进 `foreign_paths_acked`）；
 *   · 护栏一条不少：本次真有变化 / 不是本席分区 / 是别的编写席位分区 / 不是越界。
 *
 * 本套钉住：
 *   A **修复点**：writer#1 改一份 + 删一份；writer#2 只交自己的 —— 不带 ack 时两条都误报
 *     （其中一条是删除类）；带 ack 后 **pass**，计数分开记，`acknowledged_foreign` 逐条带证据标记；
 *   B **删除类护栏**：本席分区的删除不能洗（OWN）、没变化的路径不能提前确认（UNCHANGED）、
 *     越界的删除不能背书（OUT_OF_SCOPE）；
 *   C **只对点名路径生效**：两条删除只点名一条 ⇒ 另一条照旧报 undeclared；
 *   D 纯函数：`audit.deleted` 兼容别名也认（`removed` 之外）。
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { callTool, createHarness, disposeHarness, runAnalysisThenPlan } from './selftest-core.mjs'
import { vetForeignPathsAck } from '../lib/hashgate.js'

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
      const L = ['dsh-pipeline · F38：外来路径确认的删除类支持（P1-9 残余）', '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('', `【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(...it.detail.split('\n').map((l) => `      ${l}`))
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
const drop = async (root, rel) => rm(join(root, rel), { force: true })

const PARTITIONS = [
  { seat: 'writer#1', layer: 'interface', scope_paths: ['src/web'], deliverables: ['前端页面'] },
  { seat: 'writer#2', layer: 'data', scope_paths: ['src/api'], deliverables: ['后端接口'] },
]
const SCOPE = [
  { id: 'CS1', path: 'src/web', action: 'modify', why: '前端改动在这里' },
  { id: 'CS2', path: 'src/api', action: 'modify', why: '后端改动在这里' },
]

/** 两个编写席位、基线里已有若干文件、停在「开发中」。 */
async function fixture(tag, { partitions = PARTITIONS, scope = SCOPE, extraFiles = [] } = {}) {
  const h = await createHarness({})
  const root = h.projectRoot
  await put(root, 'src/web/base.js', 'export const web = 0\n')
  await put(root, 'src/web/dead1.js', 'export const dead1 = 0\n')
  await put(root, 'src/web/dead2.js', 'export const dead2 = 0\n')
  await put(root, 'src/api/base.js', 'export const api = 0\n')
  for (const [rel, text] of extraFiles) await put(root, rel, text)
  const MAIN = `f38-${tag}-main`
  const opened = await callTool(h, 'pipeline_task_open', { requirement: `F38 夹具（${tag}）：给订单系统加导出功能（前端页面 + 后端接口）。`, deliverable_format: '补丁 + 变更说明' }, MAIN)
  if (opened.denied) throw new Error(`开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id
  const tokens = { main: opened.value.role_token }
  const agents = { main: MAIN }
  await runAnalysisThenPlan(h, {
    taskId,
    tokens,
    agents,
    tier: 'L2',
    reason: 'F38 夹具：两个编写席位、路径互不重叠，可并行推进',
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
    tokens,
    agents,
    partitionOf: (seat) => partitions.find((p) => p.seat === seat) ?? partitions[0],
    seats: partitions.map((p) => p.seat),
  }
}

function submitDev(f, seat, manifest, over = {}) {
  const p = f.partitionOf(seat)
  const idx = f.seats.indexOf(seat) + 1
  return f.h.store.submitHandoff({
    taskId: f.taskId,
    kind: 'dev_to_test',
    actorRole: 'writer',
    actorSeat: seat,
    actorAgentId: `f38-${seat}`,
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
/** ★ 结构化记录在 `hash_gate_checks`（`gate:hash` 审计行里是压成字符串的那份，别混用）。 */
const lastCheck = (f) => (f.h.store.peek(f.taskId).hash_gate_checks ?? []).at(-1) ?? null
const shapes = (v) => JSON.stringify(v)

export async function runF38AckDeleteCheck() {
  const rec = createRecorder()
  const open = []
  try {
    // =======================================================================
    // A. 修复点：删除类也能 ack；修复前新增+删除两条都误报
    // =======================================================================
    {
      const G = 'A 删除类 ack 生效（修复点）'
      const f = await fixture('a')
      open.push(f.h)
      // writer#1：改一份 + 删一份（都在它自己的分区里、也在授权面内）
      await put(f.root, 'src/web/base.js', 'export const web = 2\n')
      await drop(f.root, 'src/web/dead1.js')
      const r1 = await submitDev(f, 'writer#1', [
        { path: 'src/web/base.js', action: 'modify', scope_id: 'CS1' },
        { path: 'src/web/dead1.js', action: 'delete', scope_id: 'CS1' },
      ])
      rec.add(G, '前置：writer#1 交「改一份 + 删一份」并如实申报 ⇒ pass（1/2）', r1.ok === true && f.h.store.peek(f.taskId).state === 'developing', r1.ok === true ? `state=${f.h.store.peek(f.taskId).state}` : `${r1.code}\n${String(r1.error).split('\n').slice(0, 6).join('\n')}`)

      // writer#2：只交自己那一份（不申报别人的两份）
      await put(f.root, 'src/api/new.js', 'export const n = 1\n')
      const mine = [{ path: 'src/api/new.js', action: 'create', scope_id: 'CS2' }]

      const bad = await submitDev(f, 'writer#2', mine)
      const gBad = lastGate(f)
      rec.add(
        G,
        '★★ **修复前的形状**：不带 ack ⇒ 照样 HASH_GATE_FAILED（而且误报里**有一条是删除类**）',
        bad.ok !== true && bad.code === 'HASH_GATE_FAILED' && (gBad?.violations ?? []).some((v) => String(v) === 'undeclared_change:src/web/dead1.js'),
        `${bad.code}\nviolations=${shapes(gBad?.violations)}`,
      )
      rec.add(G, '★ 非删除的那条也一起误报（对照，证明不是只修删除）', (gBad?.violations ?? []).some((v) => String(v) === 'undeclared_change:src/web/base.js'), shapes(gBad?.violations))

      const good = await submitDev(f, 'writer#2', mine, {
        foreign_paths_ack: [
          { path: 'src/web/base.js', reason: '属于 writer#1 的分区，本席未改动' },
          { path: 'src/web/dead1.js', reason: '属于 writer#1 的分区，本席未删除' },
        ],
      })
      const g = lastGate(f)
      rec.add(G, '★★ 带 ack（含一条删除类）⇒ **pass**（修复点）', good.ok === true && g?.pass === true, good.ok === true ? `counts=${shapes(g?.counts)}` : `${good.code}\n${String(good.error).split('\n').slice(0, 10).join('\n')}`)
      rec.add(
        G,
        '★★ **计数分开记**：新增/修改 1 处（`foreign_paths_acked`）+ 删除 1 处（`foreign_paths_acked_deleted`）',
        (g?.counts?.foreign_paths_acked ?? -1) === 1 && (g?.counts?.foreign_paths_acked_deleted ?? -1) === 1,
        shapes(g?.counts),
      )
      const acked = lastCheck(f)?.acknowledged_foreign ?? []
      rec.add(
        G,
        '★★ `acknowledged_foreign` 逐条带 **evidence 标记**（changed_hash / deleted_no_hash）',
        acked.some((x) => x.path === 'src/web/base.js' && x.evidence === 'changed_hash') &&
          acked.some((x) => x.path === 'src/web/dead1.js' && x.evidence === 'deleted_no_hash' && x.kind === 'deleted'),
        shapes(acked),
      )
      rec.add(
        G,
        '★ 删除类那条如实带"无哈希证据"的说明（不装成有证据）',
        acked.some((x) => x.path === 'src/web/dead1.js' && x.evidence === 'deleted_no_hash' && /删除类拿不到/.test(String(x.why ?? '')) && /哈希证据/.test(String(x.why ?? ''))),
        shapes(acked.find((x) => x.path === 'src/web/dead1.js') ?? null),
      )
      rec.add(
        G,
        '★ 审计留痕：`gate:hash` 里删除类明确标了「删除类·无哈希证据」',
        (g?.acknowledged_foreign ?? []).some((x) => String(x).includes('src/web/dead1.js') && String(x).includes('删除类·无哈希证据')),
        shapes(g?.acknowledged_foreign),
      )
      const st = f.h.store.peek(f.taskId)
      rec.add(G, '★ 两席都交齐 ⇒ 状态推进到「待测试」', st.state === 'ready_test' && Object.keys(st.writer_submissions ?? {}).length === 2, `state=${st.state} seats=${shapes(Object.keys(st.writer_submissions ?? {}))}`)
    }

    // =======================================================================
    // B. 删除类护栏：OWN / UNCHANGED / OUT_OF_SCOPE
    // =======================================================================
    {
      const G = 'B 删除类护栏'
      // B1 本席分区的删除不能洗
      {
        const f = await fixture('b1')
        open.push(f.h)
        await drop(f.root, 'src/api/base.js') // writer#2 自己删的
        const r = await submitDev(
          f,
          'writer#2',
          [{ path: 'src/api/new.js', action: 'create', scope_id: 'CS2' }],
          { foreign_paths_ack: [{ path: 'src/api/base.js', reason: '想把自己删的确认成别人的' }] },
        )
        rec.add(
          G,
          '★★ 点名**本席分区**里的删除 ⇒ 拒绝（FOREIGN_PATH_ACK_OWN_PARTITION；删除类不能洗自己）',
          r.ok !== true && r.code === 'FOREIGN_PATH_ACK_OWN_PARTITION' && /本席(自己)?的分区/.test(String(r.error)),
          `${r.code}\n${String(r.error).split('\n').slice(0, 6).join('\n')}`,
        )
        rec.add(G, '★ 拒绝原文的规则里写明"删除类允许但无哈希证据"（不是一句"不适用"）', /删除类允许/.test(String(r.error)) && /无哈希证据|没有哈希证据/.test(String(r.error)), String(r.error).split('\n').filter((l) => l.includes('删除类')).join('\n'))
      }
      // B2 没变化的路径不能提前确认
      {
        const f = await fixture('b2')
        open.push(f.h)
        const r = await submitDev(
          f,
          'writer#2',
          [{ path: 'src/api/new.js', action: 'create', scope_id: 'CS2' }],
          { foreign_paths_ack: [{ path: 'src/web/dead2.js', reason: '它本次没被删' }] },
        )
        rec.add(G, '★★ 确认一条**本次没变化**的路径（没被删）⇒ 拒绝（FOREIGN_PATH_ACK_UNCHANGED）', r.ok !== true && r.code === 'FOREIGN_PATH_ACK_UNCHANGED', `${r.code}\n${String(r.error).split('\n').slice(0, 5).join('\n')}`)
      }
      // B3 越界的删除不能背书
      {
        const f = await fixture('b3', {
          partitions: [
            { seat: 'writer#1', layer: 'interface', scope_paths: ['src/web', 'src/other'], deliverables: ['前端 + 其它'] },
            { seat: 'writer#2', layer: 'data', scope_paths: ['src/api'], deliverables: ['后端接口'] },
          ],
          extraFiles: [['src/other/gone.js', 'export const gone = 1\n']],
        })
        open.push(f.h)
        await drop(f.root, 'src/other/gone.js') // writer#1 的分区里、但授权面之外
        const r = await submitDev(
          f,
          'writer#2',
          [{ path: 'src/api/new.js', action: 'create', scope_id: 'CS2' }],
          { foreign_paths_ack: [{ path: 'src/other/gone.js', reason: '属于 writer#1 的分区' }] },
        )
        rec.add(
          G,
          '★★ 确认一条**越界**的删除 ⇒ 拒绝（FOREIGN_PATH_ACK_OUT_OF_SCOPE；ack 不碰越界判据）',
          r.ok !== true && r.code === 'FOREIGN_PATH_ACK_OUT_OF_SCOPE' && /越界|授权面之外/.test(String(r.error)),
          `${r.code}\n${String(r.error).split('\n').slice(0, 6).join('\n')}`,
        )
      }
    }

    // =======================================================================
    // C. 只对点名路径生效（没点名的删除照旧报 undeclared）
    // =======================================================================
    {
      const G = 'C 只对点名路径生效'
      const f = await fixture('c')
      open.push(f.h)
      await drop(f.root, 'src/web/dead1.js')
      await drop(f.root, 'src/web/dead2.js')
      const r1 = await submitDev(f, 'writer#1', [
        { path: 'src/web/dead1.js', action: 'delete', scope_id: 'CS1' },
        { path: 'src/web/dead2.js', action: 'delete', scope_id: 'CS1' },
      ])
      rec.add(G, '前置：writer#1 删两份并如实申报 ⇒ pass', r1.ok === true, r1.ok === true ? '' : `${r1.code}\n${String(r1.error).split('\n').slice(0, 6).join('\n')}`)

      await put(f.root, 'src/api/new.js', 'export const n = 2\n')
      const mine = [{ path: 'src/api/new.js', action: 'create', scope_id: 'CS2' }]
      const partial = await submitDev(f, 'writer#2', mine, {
        foreign_paths_ack: [{ path: 'src/web/dead1.js', reason: 'writer#1 删的' }],
      })
      const g = lastGate(f)
      rec.add(
        G,
        '★★ 两条删除只点名一条 ⇒ 另一条**照旧**报 undeclared（部分确认 ≠ 全免）',
        partial.ok !== true && (g?.violations ?? []).some((v) => String(v) === 'undeclared_change:src/web/dead2.js'),
        `${partial.code}\nviolations=${shapes(g?.violations)}`,
      )
      rec.add(G, '★ 已点名那一条不在 violations 里', !(g?.violations ?? []).some((v) => String(v).includes('src/web/dead1.js')), shapes(g?.violations))
      rec.add(G, '★ 这一轮已确认删除 1 处、未申报 1 处（计数与 violations 不同源）', (g?.counts?.foreign_paths_acked_deleted ?? -1) === 1 && (g?.counts?.undeclared ?? -1) === 1, shapes(g?.counts))

      const full = await submitDev(f, 'writer#2', mine, {
        foreign_paths_ack: [
          { path: 'src/web/dead1.js', reason: 'writer#1 删的' },
          { path: 'src/web/dead2.js', reason: 'writer#1 删的' },
        ],
      })
      rec.add(G, '★ 补齐两条删除确认 ⇒ pass（删除计数 = 2）', full.ok === true && (lastGate(f)?.counts?.foreign_paths_acked_deleted ?? -1) === 2, full.ok === true ? shapes(lastGate(f)?.counts) : `${full.code}\n${String(full.error).split('\n').slice(0, 8).join('\n')}`)
    }

    // =======================================================================
    // D. 纯函数：`audit.deleted` 兼容别名也认
    // =======================================================================
    {
      const G = 'D audit.deleted 兼容'
      const key = (p) => `/proj/${String(p)}`.toLowerCase()
      const isInside = (root, child) => child === root || child.startsWith(`${root}/`)
      const partitions = { 'writer#1': ['src/web'], 'writer#2': ['src/api'] }
      const run = (audit) =>
        vetForeignPathsAck({
          ack: [{ path: 'src/web/dead.js', reason: 'writer#1 删的' }],
          seat: 'writer#2',
          seats: ['writer#1', 'writer#2'],
          partitionOf: (seat) => ({ seat, scope_paths: partitions[seat] ?? [] }),
          audit,
          absOfDeclared: key,
          absOfTouched: key,
          isInside,
        })
      const viaDeleted = run({ added: [], modified: [], deleted: [{ path: 'src/web/dead.js' }], unauthorized: [] })
      rec.add(G, '★★ `audit.deleted`（兼容别名）里的删除也能被确认', viaDeleted.ok === true && viaDeleted.deletedKeys.length === 1 && viaDeleted.entries[0]?.evidence === 'deleted_no_hash', JSON.stringify(viaDeleted))
      const viaRemoved = run({ added: [], modified: [], removed: [{ path: 'src/web/dead.js' }], unauthorized: [] })
      rec.add(G, '★★ `audit.removed`（store 实际字段名）同样生效', viaRemoved.ok === true && viaRemoved.deletedKeys.length === 1, JSON.stringify(viaRemoved))
      const hashBacked = run({ added: [{ path: 'src/web/dead.js', sha256: 'a'.repeat(64) }], modified: [], removed: [], unauthorized: [] })
      rec.add(G, '★ 同名路径是"新增/修改"时走**有哈希**那一集（不是删除集）', hashBacked.ok === true && hashBacked.keys.length === 1 && hashBacked.deletedKeys.length === 0 && hashBacked.entries[0]?.evidence === 'changed_hash', JSON.stringify(hashBacked))
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    for (const h of open) await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

/**
 * 别名（与任务单里的 `runF38` 叫法对齐；主名 `runF38AckDeleteCheck` 与其余 F 套一致）。
 */
export const runF38 = runF38AckDeleteCheck

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF38AckDeleteCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
