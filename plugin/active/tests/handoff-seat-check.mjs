/**
 * dsh-pipeline · tests/handoff-seat-check.mjs
 * ============================================================================
 * **P2-7：交接物里的「谁交的（席位）」**（bug 待修复单 `P2-7`）
 *
 * 现象（实测，不是推测）：真单 `T-20261012-8cdee0` 的 **22 份 handoffs 一份都没有**
 * `from_seat` 键 —— ★ 注意**不是 `null`，是这个字段压根不存在**（所以按 `=== null`
 * 筛选根本筛不出来）；"哪个席位交的"只能回审计日志反查 `seat:submit`。
 * 根因：`buildHandoffRecord`（`lib/handoff.js`）不写这个字段。
 *
 * 本套要证的四件事：
 *   【A】正例：**多席位交付**（writer#2）**落盘之后**，那份记录里
 *        `from_seat === 'writer#2'` —— 判据是**读盘**（`task.json`），不是读内存对象
 *   【B】反例：**单席位角色**交付（tester），`from_seat` 是**角色名**，
 *        ★ 既不是 `undefined` 也不是 `null`（键必须在）
 *   【C】向后兼容：**旧交接物不迁移、不重写** —— 缺字段的记录读得出来，
 *        而且"读一次"不会往那个对象上补键
 *   【D】取值来源**可追溯**：令牌席位 > 分区席位（`payload.partition.seat`）> 角色名；
 *        且**绝不**误读 `payload.from_seat`（那是 `seat_handover` 的"**旧**席位"）
 *
 * ★ **全程密闭**：夹具自造临时任务目录（`createHarness` 的 `mkdtemp`），
 *   **不引用任何活体真单**、不读任何真单的 mtime —— 插件在隔壁怎么活动都不会把它弄红。
 *   （教训：`orphan-rescue-check` 因为读活体真单 mtime，同一份代码两次跑出 42/46 与 44/46。）
 * ★ **不改既有断言**：本文件是新增；`run-all.mjs` 里只多一条注册。
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * @module dsh-pipeline/tests/handoff-seat-check
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { callTool, disposeHarness, manifestFor } from './selftest-core.mjs'
import { createMultiWriterFixture } from './writers-check.mjs'
import { buildHandoffRecord, resolveHandoffSeat, summarizeHandoff } from '../lib/handoff.js'

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
      const L = []
      L.push('dsh-pipeline · P2-7：交接物里的「谁交的（席位）」')
      L.push('='.repeat(78))
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('')
          L.push(`【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(`      ${it.detail.split('\n').join('\n      ')}`)
      }
      L.push('')
      L.push('='.repeat(78))
      L.push(`总计：${this.passed}/${this.total} 通过`)
      L.push('='.repeat(78))
      return L.join('\n')
    },
  }
}

const indent = (s, n = 4) =>
  String(s ?? '')
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n')

/** 键**在不在** —— bug 单的核心判据（`null` 与"压根没有这个键"是两件事）。 */
const hasSeatKey = (h) => Object.hasOwn(h ?? {}, 'from_seat')

/** 盘上的 `task.json`（"落盘之后"这句话的判据只能从这儿取）。 */
function onDiskTask(fx) {
  const p = join(fx.projectRoot, '.pipeline', fx.taskId, 'task.json')
  return JSON.parse(readFileSync(p, 'utf8'))
}

/** 盘上按 handoff_id 取一份记录；取不到就抛（不许把"没找到"当成"没有这个键"）。 */
function onDiskHandoff(fx, handoffId) {
  const task = onDiskTask(fx)
  const hit = (task.handoffs ?? []).find((h) => h.handoff_id === handoffId)
  if (hit === undefined) throw new Error(`盘上的 task.json 里找不到交接物 ${handoffId}`)
  return hit
}

/** 让某个席位登记一个制品（与 writers-check 同一形状）。 */
async function seatArtifact(fx, seat, content) {
  return callTool(
    fx.h,
    'pipeline_artifact',
    { task_id: fx.taskId, content, file_name: `${seat.replace('#', '-')}.txt`, note: `${seat} 的产物`, role_token: fx.tokens[seat] },
    fx.agents[seat],
  )
}

/** 让某个编写席位交一份带分区元数据的 `dev_to_test`（与 writers-check 同一形状）。 */
async function seatSubmit(fx, seat, version) {
  const idx = fx.seats.indexOf(seat) + 1
  return callTool(
    fx.h,
    'pipeline_handoff',
    {
      task_id: fx.taskId,
      kind: 'dev_to_test',
      role_token: fx.tokens[seat],
      payload: {
        task_id: fx.taskId,
        artifact_version: version,
        patch_or_code: `（${seat} 的改动）`,
        change_note: `${seat} 完成了它那一段`,
        run_commands: [`node tests/${seat.replace('#', '-')}.mjs`],
        selftest_result: 'pass',
        known_issues: [],
        partition: { seat, index: idx, total: fx.seats.length, scope_paths: idx === 1 ? ['src/web'] : ['src/api'] },
        ...manifestFor(fx.h.store, fx.taskId, { index: idx - 1, path: idx === 1 ? 'src/web' : 'src/api' }),
      },
    },
    fx.agents[seat],
  )
}

export async function runHandoffSeatCheck() {
  const rec = createRecorder()
  const open = []
  try {
    await drive(rec, open)
  } catch (err) {
    // 夹具中途抛异常**不许静默**：如实记一条 ✗ 并把原文留住。
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    for (const h of open) await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

async function drive(rec, open) {
  // =========================================================================
  // 夹具：2 个编写席位（各持独立令牌与独立会话），停在「开发中」
  // =========================================================================
  const fx = await createMultiWriterFixture({ writers: 2 })
  open.push(fx.h)
  rec.add(
    '夹具',
    '2 个编写席位各持独立令牌与独立会话（writer#1 / writer#2），全程临时任务目录',
    new Set(fx.seats.map((s) => fx.agents[s])).size === 2 && new Set(fx.seats.map((s) => fx.tokens[s])).size === 2,
    `seats=${fx.seats.join('、')}\nagents=${fx.seats.map((s) => `${s}=${fx.agents[s]}`).join('　')}\n任务=${fx.taskId}　项目根=${fx.projectRoot}`,
  )

  // =========================================================================
  // 【B】反例·单席位角色：夹具自带的交付就是现成样本（orchestrator / planner）
  // =========================================================================
  {
    const disk = onDiskTask(fx)
    const byKind = (k) => (disk.handoffs ?? []).find((h) => h.kind === k) ?? null
    for (const [kind, role] of [
      ['requirement_analysis', 'orchestrator'],
      ['plan', 'planner'],
      ['orchestration', 'planner'],
    ]) {
      const h = byKind(kind)
      rec.add(
        'B 反例·单席位角色',
        `${kind}（单席位角色「${role}」交付）⇒ from_seat 是**角色名**，不是 undefined / null`,
        h !== null && hasSeatKey(h) && h.from_seat === role,
        h === null
          ? `盘上找不到 kind=${kind} 的交接物（夹具形状变了？）`
          : `from_role=${h.from_role}　from_seat=${JSON.stringify(h.from_seat)}　键在不在=${hasSeatKey(h)}（要求 "${role}"）`,
      )
    }
  }

  // =========================================================================
  // 【A】正例·多席位交付：writer#2 交一份，**读盘**核席位
  // =========================================================================
  const versions = {}
  for (const seat of fx.seats) {
    const a = await seatArtifact(fx, seat, `${seat} 的代码\n`)
    rec.add('A 正例·多席位交付', `夹具：${seat} 登记自己的制品`, a.denied !== true, a.denied !== true ? `版本=${a.value?.version}` : indent(a.text))
    versions[seat] = a.value?.version ?? ''
  }

  const r2 = await seatSubmit(fx, 'writer#2', versions['writer#2'])
  rec.add('A 正例·多席位交付', 'writer#2 交一份 dev_to_test（2 席位里的第 2 份）', r2.denied !== true, indent(r2.text))
  const h2 = onDiskHandoff(fx, r2.value?.handoff_id ?? '')
  rec.add(
    'A 正例·多席位交付',
    '★ 盘上那一份**有** `from_seat` 键（bug 单的现象就是"压根不存在" ⇒ 这里读的是键在不在，不是值等不等于 null）',
    hasSeatKey(h2),
    `记录键：${Object.keys(h2).join('、')}\nfrom_seat=${JSON.stringify(h2.from_seat)}`,
  )
  rec.add(
    'A 正例·多席位交付',
    '★★ 正例：多席位交付落盘后 `from_seat === "writer#2"`',
    h2.from_seat === 'writer#2',
    `要求 "writer#2"，实得 ${JSON.stringify(h2.from_seat)}　（from_role=${h2.from_role}）`,
  )

  const r1 = await seatSubmit(fx, 'writer#1', versions['writer#1'])
  rec.add('A 正例·多席位交付', 'writer#1 交另一份（同角色、不同席位）', r1.denied !== true, indent(r1.text))
  const h1 = onDiskHandoff(fx, r1.value?.handoff_id ?? '')
  rec.add(
    'A 正例·多席位交付',
    '★★ 两份**分得开**：writer#1 那份是 "writer#1"、writer#2 那份是 "writer#2" —— 而两份的 `from_role` 都是 "writer"（光靠角色分不开，这正是 bug 单说的影响面）',
    h1.from_seat === 'writer#1' && h2.from_seat === 'writer#2' && h1.from_role === 'writer' && h2.from_role === 'writer',
    `writer#1 那份：from_role=${h1.from_role} from_seat=${JSON.stringify(h1.from_seat)}\nwriter#2 那份：from_role=${h2.from_role} from_seat=${JSON.stringify(h2.from_seat)}`,
  )
  rec.add(
    'A 正例·多席位交付',
    '这份记录里的 `payload.partition.seat` **原样未动**（新字段没有污染载荷；载荷仍是被令牌核对过的那一份）',
    h2.payload?.partition?.seat === 'writer#2' && !Object.hasOwn(h2.payload ?? {}, 'from_seat'),
    `payload.partition.seat=${JSON.stringify(h2.payload?.partition?.seat)}　payload 里有 from_seat 吗=${Object.hasOwn(h2.payload ?? {}, 'from_seat')}`,
  )
  rec.add(
    'A 正例·多席位交付',
    '全单体检：这张单上**每一份**交接物都带非空的 `from_seat`（改前是"22 份全都没有"那个形状）',
    (onDiskTask(fx).handoffs ?? []).length > 0 &&
      (onDiskTask(fx).handoffs ?? []).every((h) => hasSeatKey(h) && typeof h.from_seat === 'string' && h.from_seat.length > 0),
    (onDiskTask(fx).handoffs ?? []).map((h) => `  ${h.kind}｜from_role=${h.from_role}｜from_seat=${JSON.stringify(h.from_seat)}`).join('\n'),
  )

  // --- 只读导出（主对话看的 pipeline_status 面）-----------------------------
  {
    const view = await fx.h.store.status({ taskId: fx.taskId, redactForMain: true })
    const rows = Array.isArray(view.handoffs) ? view.handoffs : []
    const dev = rows.filter((h) => h.kind === 'dev_to_test')
    rec.add(
      'A 只读导出',
      '★ 只读导出的交接物清单里**也看得见席位**（"哪个席位交的"不必再回审计反查）',
      rows.length > 0 && rows.every((h) => typeof h.from_seat === 'string' && h.from_seat.length > 0) && dev.some((h) => h.from_seat === 'writer#2'),
      rows.map((h) => `  ${h.kind}｜${h.from_role}｜from_seat=${JSON.stringify(h.from_seat)}`).join('\n'),
    )
    rec.add(
      'A 只读导出',
      '★ 只增字段：既有字段（handoff_id / kind / kind_zh / from_role / to_role / created_at / artifact_version / summary）一个都不少',
      rows.length > 0 &&
        rows.every(
        (h) =>
          typeof h.handoff_id === 'string' &&
          typeof h.kind === 'string' &&
          typeof h.kind_zh === 'string' &&
          typeof h.from_role === 'string' &&
          typeof h.to_role === 'string' &&
          typeof h.created_at === 'string' &&
          Object.hasOwn(h, 'artifact_version') &&
          typeof h.summary === 'object' &&
          Array.isArray(h.redacted),
      ),
      `字段集合：${JSON.stringify(Object.keys(rows[0] ?? {}))}`,
    )
  }

  // =========================================================================
  // 【B】反例·单席位角色**真交付**：测试位交 test_to_review
  // =========================================================================
  {
    const cur = (await fx.h.store.status({ taskId: fx.taskId })).artifact_version
    const dT = await callTool(fx.h, 'pipeline_dispatch', { task_id: fx.taskId, role: 'tester', spawn: false, role_token: fx.tokens.main }, fx.agents.main)
    rec.add('B 反例·单席位角色', '夹具：派出测试位（任务进入「测试中」）', dT.denied !== true, indent(dT.text))
    const t2r = await callTool(
      fx.h,
      'pipeline_handoff',
      {
        task_id: fx.taskId,
        kind: 'test_to_review',
        role_token: fx.tokens.tester,
        payload: {
          task_id: fx.taskId,
          artifact_version: cur,
          test_cases: ['两个席位各自可用', '接缝处一致'],
          execution_result: '2/2 通过',
          failure_logs: [],
          pass_evidence: ['两个分区的自测都跑了'],
          risk_notes: [],
          verdict: 'pass',
        },
      },
      fx.agents.tester,
    )
    rec.add('B 反例·单席位角色', '测试位交 test_to_review', t2r.denied !== true, indent(t2r.text))
    const ht = onDiskHandoff(fx, t2r.value?.handoff_id ?? '')
    rec.add(
      'B 反例·单席位角色',
      '★★ 反例：单席位角色交付 ⇒ `from_seat` 是**角色名** "tester"（键必须在，且不许是 undefined / null）',
      hasSeatKey(ht) && ht.from_seat === 'tester' && ht.from_seat !== undefined && ht.from_seat !== null,
      `from_role=${ht.from_role}　from_seat=${JSON.stringify(ht.from_seat)}　键在不在=${hasSeatKey(ht)}（要求 "tester"）`,
    )
  }

  // =========================================================================
  // 【C】向后兼容：旧交接物**不迁移、不重写**
  // =========================================================================
  {
    // 改前落的那份形状：**没有** from_seat 键（真单 T-20261012-8cdee0 的 22 份都是它）
    const legacyDev = {
      handoff_id: 'H-legacy-dev',
      task_id: 'T-legacy',
      kind: 'dev_to_test',
      kind_zh: '编写交付给测试',
      from_role: 'writer',
      to_role: 'tester',
      created_at: '2026-10-12T00:00:00Z',
      artifact_version: 'v1',
      payload: { task_id: 'T-legacy', patch_or_code: 'x', partition: { seat: 'writer#1', index: 1, total: 1, scope_paths: ['.'] } },
      content_hash: 'deadbeef',
    }
    const legacyPlan = {
      handoff_id: 'H-legacy-plan',
      task_id: 'T-legacy',
      kind: 'plan',
      kind_zh: '计划',
      from_role: 'planner',
      to_role: 'main',
      created_at: '2026-10-12T00:00:00Z',
      artifact_version: null,
      payload: { task_id: 'T-legacy', plan_steps: ['s'] },
      content_hash: 'deadbeef',
    }
    let devOut = null
    let planOut = null
    let threw = ''
    try {
      devOut = summarizeHandoff(legacyDev)
      planOut = summarizeHandoff(legacyPlan)
    } catch (err) {
      threw = String(err?.message ?? err)
    }
    rec.add(
      'C 向后兼容·旧记录',
      '★ 缺 `from_seat` 键的旧记录**读得出来**（不抛异常 —— "读的时候缺字段要能正常工作"）',
      threw === '' && devOut !== null && planOut !== null,
      threw === '' ? `dev_to_test ⇒ ${JSON.stringify(devOut?.from_seat)}　plan ⇒ ${JSON.stringify(planOut?.from_seat)}` : `读旧记录抛异常：${threw}`,
    )
    rec.add(
      'C 向后兼容·旧记录',
      '旧记录的席位按**同一条口径**推导着显示（dev_to_test 从 partition 推 ⇒ writer#1；其余角色 ⇒ 角色名 planner）',
      devOut?.from_seat === 'writer#1' && planOut?.from_seat === 'planner',
      `dev_to_test=${JSON.stringify(devOut?.from_seat)}（要求 "writer#1"）　plan=${JSON.stringify(planOut?.from_seat)}（要求 "planner"）`,
    )
    rec.add(
      'C 向后兼容·旧记录',
      '★★ **不迁移、不重写**：读完之后那个旧对象上**依然没有** `from_seat` 键（读是只读的，不是"顺手补上"）',
      !hasSeatKey(legacyDev) && !hasSeatKey(legacyPlan) && !Object.hasOwn(legacyDev.payload, 'from_seat'),
      `legacyDev 键：${Object.keys(legacyDev).join('、')}\nlegacyPlan 键：${Object.keys(legacyPlan).join('、')}\npayload 键：${Object.keys(legacyDev.payload).join('、')}`,
    )
    rec.add(
      'C 向后兼容·旧记录',
      '★ **只多一个 `from_seat`**：摘要的字段集合 = 既有 9 个字段 + `from_seat`，其余逐字相等（既有读者照旧）',
      JSON.stringify(Object.keys(devOut ?? {}).sort()) ===
        JSON.stringify(['artifact_version', 'created_at', 'from_role', 'from_seat', 'handoff_id', 'kind', 'kind_zh', 'redacted', 'summary', 'to_role'].sort()) &&
        ['handoff_id', 'kind', 'kind_zh', 'from_role', 'to_role', 'created_at', 'artifact_version'].every((k) => devOut?.[k] === legacyDev[k]),
      `摘要字段：${JSON.stringify(Object.keys(devOut ?? {}))}\n值对照：${JSON.stringify({ handoff_id: devOut?.handoff_id, from_role: devOut?.from_role, to_role: devOut?.to_role, created_at: devOut?.created_at, artifact_version: devOut?.artifact_version })}`,
    )
  }

  // =========================================================================
  // 【D】取值来源可追溯（纯函数层：三级 + 一条"绝不误读"的反例）
  // =========================================================================
  {
    const seatOf = (input) =>
      buildHandoffRecord({ kind: 'dev_to_test', taskId: 'T-src', fromRole: 'writer', toRole: 'tester', payload: { task_id: 'T-src', partition: { seat: 'writer#2' } }, ...input }).from_seat
    rec.add(
      'D 取值来源',
      '① **令牌席位**优先于 `payload.partition.seat`（"谁交的"由凭据决定，不由调用方自报）',
      seatOf({ fromSeat: 'writer#1' }) === 'writer#1' && seatOf({ actorSeat: 'writer#3' }) === 'writer#3',
      `fromSeat=writer#1 ⇒ ${JSON.stringify(seatOf({ fromSeat: 'writer#1' }))}　actorSeat=writer#3 ⇒ ${JSON.stringify(seatOf({ actorSeat: 'writer#3' }))}　不给令牌席位 ⇒ ${JSON.stringify(seatOf({}))}`,
    )
    rec.add(
      'D 取值来源',
      '② 没有令牌席位时取 `payload.partition.seat`（`dev_to_test` 专有；store 层 `checkSeatOwnership` 已用令牌核对过）',
      seatOf({}) === 'writer#2',
      `不给令牌席位 + partition.seat=writer#2 ⇒ ${JSON.stringify(seatOf({}))}`,
    )
    rec.add(
      'D 取值来源',
      '③ 都没有时取**角色名**（单席位角色：席位名就是角色名）',
      buildHandoffRecord({ kind: 'review_verdict', taskId: 'T-src', fromRole: 'reviewer', toRole: 'main', payload: { task_id: 'T-src' } }).from_seat === 'reviewer',
      `reviewer ⇒ ${JSON.stringify(buildHandoffRecord({ kind: 'review_verdict', taskId: 'T-src', fromRole: 'reviewer', toRole: 'main', payload: {} }).from_seat)}`,
    )
    rec.add(
      'D 取值来源',
      '★ 连角色都取不到时**如实给 null**（不编造一个假席位）',
      resolveHandoffSeat({}) === null && resolveHandoffSeat({ fromSeat: '   ', actorSeat: null, payload: {} }) === null,
      `resolveHandoffSeat({}) = ${JSON.stringify(resolveHandoffSeat({}))}`,
    )
    rec.add(
      'D 取值来源',
      '★★ **绝不误读** `payload.from_seat`：那是 `seat_handover` 的"**旧**席位"，同名不同义 —— 没给令牌席位时读出来的是**角色名**，不是那个旧席位',
      buildHandoffRecord({
        kind: 'seat_handover',
        taskId: 'T-src',
        fromRole: 'writer',
        toRole: 'writer',
        payload: { task_id: 'T-src', from_seat: 'writer#1', to_seat: 'writer#2' },
      }).from_seat === 'writer',
      'payload.from_seat="writer#1" 时 ⇒ ' + JSON.stringify(buildHandoffRecord({ kind: 'seat_handover', taskId: 'T-src', fromRole: 'writer', toRole: 'writer', payload: { task_id: 'T-src', from_seat: 'writer#1', to_seat: 'writer#2' } }).from_seat),
    )
  }
}
