/**
 * dsh-pipeline · tests/gate-states-check.mjs
 * ============================================================================
 * **守门与状态层**（T-20261011-56a37e · 主管枢纽）
 *   —— 开对话权的发起方 / 主管两站 / 两次确认
 *
 * 本套是**拓扑权威面与守门面的判据集**：它只读表、只算纯函数，
 * 不建会话、不监听端口、不写任何插件文件（临时目录跑完即删）。
 *
 * 为什么这一套必须存在（而不是靠那几套端到端）：
 *   端到端全绿只证明"这条路走得通"；**表上有没有多余的路**（例如 `analyzing → planning`
 *   那条近路）只能靠直接读表来判。用户要的「架构图前置是硬的」最终就是
 *   "**那条边在表上不存在**"这一条断言。
 *
 * 判据分组：
 *   【A】发起面：主管枢纽的发起方集合只含 supervisor（main 代发两道都过不去）
 *   【B】架构图前置：表上不存在 analyzing→planning 的近路；两站之间只有枢纽那条链
 *   【C】两个唤醒点：待机名单 ↔ 唤醒点一一对应，且唤醒只由主管那一跳触发
 *   【D】五道确认站点：③④ 是**双**确认（两个不同角色），①② 只认主管
 *   【E】方向表一致：guard.HANDOFF_DIRECTION ↔ handoff.HANDOFF_SCHEMAS[].from 逐字相同
 *   【F】只读导出：boundaryManifest().supervisor_hub 直接可见（发起方/唤醒点/站点/双确认）
 *   【G】控制角色不看代码：NO_CODE_READ_ROLES 含主管 ⇒ pipeline_status 的 full 对它关闭
 *   【H】站点确认的形状判据：证据标识 / 脱敏证据正文（代码形态即拒）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * @module dsh-pipeline/tests/gate-states-check
 */

import {
  HUB_DIAGRAM_REDRAW_BUDGET,
  HUB_DUAL_STATIONS,
  HUB_STANDBY_SEATS,
  HUB_STATION_CONFIRMERS,
  HUB_STATIONS,
  HUB_WAKE_POINTS,
  ST,
  TRANSITIONS,
  hubConfirmersOf,
  hubIsDualStation,
  hubWakePointOf,
} from '../lib/states.js'
import { HANDOFF_SCHEMAS, hubEvidenceDigestHit, validateHandoff } from '../lib/handoff.js'
import { NO_CODE_READ_ROLES } from '../lib/guard.js'
import { ROLES } from '../lib/roles.js'
import { boundaryManifest } from '../lib/boundaries.js'

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
      L.push('dsh-pipeline · 守门与状态层（主管枢纽：发起方 / 主管两站 / 两次确认）')
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

/** 取一条转移（找不到返回 null）。 */
function tr(from, event) {
  return TRANSITIONS.find((t) => t.from === from && t.event === event) ?? null
}

export async function runGateStatesCheck() {
  const rec = createRecorder()

  // =========================================================================
  // 【A】发起面：主管枢纽的发起方集合只含 supervisor
  // =========================================================================
  {
    const t = tr(ST.PENDING, 'supervisor_initiate')
    rec.add('A 发起面', '★ 表上有「主管发起」这条具名边（pending → analyzing）', t !== null, t === null ? '表里找不到 supervisor_initiate' : `by=${JSON.stringify(t.by)} guard=${t.guard}`)
    rec.add(
      'A 发起面',
      '★★ **发起方只有 supervisor** —— main 不在 by 名单里（"主对话代发"第一道就过不去）',
      t !== null && JSON.stringify(t.by) === JSON.stringify(['supervisor']),
      `实际 by=${JSON.stringify(t?.by)}`,
    )
    const legacy = tr(ST.PENDING, 'dispatch_orchestrator')
    rec.add(
      'A 发起面',
      '★ 既有的 `dispatch_orchestrator` 挂了 `hub_initiate_required`（名单里有主管席位时它被拒）',
      legacy !== null && legacy.guard === 'hub_initiate_required',
      `实际 guard=${legacy?.guard}`,
    )
    rec.add(
      'A 发起面',
      '★ 主管的具名动作**不是** main 的工具：`pipeline_dispatch` 的 by 名单里没有 supervisor',
      !TRANSITIONS.some((x) => x.event === 'supervisor_initiate' && (x.by ?? []).includes('main')),
      '',
    )
  }

  // =========================================================================
  // 【B】架构图前置：表上不存在 analyzing→planning 的近路
  // =========================================================================
  {
    const direct = TRANSITIONS.filter((t) => t.from === ST.ANALYZING && t.to === ST.PLANNING)
    rec.add(
      'B 架构图前置',
      '★★ **表上不存在 `analyzing → planning` 的边** —— 「先出计划、后出架构图」无路可走',
      direct.length === 0,
      direct.length === 0 ? '' : `找到了 ${direct.length} 条：${direct.map((x) => x.event).join('、')}`,
    )
    const need = tr(ST.ANALYZING, 'need_to_supervisor')
    rec.add('B 架构图前置', '★ 需求结论交主管的边只允许**需求位**触发', need !== null && JSON.stringify(need.by) === JSON.stringify(['orchestrator']), `by=${JSON.stringify(need?.by)}`)
    const agree = tr(ST.SUPERVISING, 'supervisor_agree_need')
    rec.add('B 架构图前置', '★ 第①道（主管同意需求结论）只允许 supervisor 触发', agree !== null && JSON.stringify(agree.by) === JSON.stringify(['supervisor']), `by=${JSON.stringify(agree?.by)}`)
    const draw = tr(ST.ARCH_DRAWING, 'diagram_submitted')
    rec.add('B 架构图前置', '★ 架构图产出（架构位出图中 → 架构图待主管确认）由 diagrammer 触发', draw !== null && (draw.by ?? []).includes('diagrammer'), `by=${JSON.stringify(draw?.by)}`)
    const cd = tr(ST.ARCH_CONFIRM, 'supervisor_confirm_diagram')
    rec.add('B 架构图前置', '★ 第②道（主管确认架构图满足要求）只允许 supervisor 触发', cd !== null && JSON.stringify(cd.by) === JSON.stringify(['supervisor']), `by=${JSON.stringify(cd?.by)}`)
    const rj = tr(ST.ARCH_CONFIRM, 'supervisor_reject_diagram')
    rec.add('B 架构图前置', '★ 架构图不满足 ⇒ 重画边存在且挂预算判据，且只允许 supervisor', rj !== null && rj.guard === 'hub_diagram_rework_budget' && JSON.stringify(rj.by) === JSON.stringify(['supervisor']), `by=${JSON.stringify(rj?.by)} guard=${rj?.guard}`)
    rec.add('B 架构图前置', '★ 重画预算 = 1（用户口径④：**限 1 次**）', HUB_DIAGRAM_REDRAW_BUDGET === 1, `实际 ${HUB_DIAGRAM_REDRAW_BUDGET}`)
    const dp = tr(ST.STANDBY_PLAN, 'dispatch_planner')
    rec.add('B 架构图前置', '★ 计划位派活的边**只从「计划位已唤醒待派」出发**（从 ready_plan 出发的那条是既有链，两者并存不冲突）', dp !== null && dp.guard === 'hub_plan_woken', `guard=${dp?.guard}`)
  }

  // =========================================================================
  // 【C】两个唤醒点：待机名单 ↔ 唤醒点一一对应
  // =========================================================================
  {
    const wps = Object.values(HUB_WAKE_POINTS)
    rec.add('C 唤醒点', '★ 恰好两个唤醒点（主管同意需求结论 / 主管确认架构图满足要求）', wps.length === 2, `实际 ${wps.join('、')}`)
    const arch = HUB_STANDBY_SEATS.filter((s) => s.wake_point === HUB_WAKE_POINTS.NEED_AGREE).map((s) => s.role)
    const plan = HUB_STANDBY_SEATS.filter((s) => s.wake_point === HUB_WAKE_POINTS.DIAGRAM_CONFIRM).map((s) => s.role)
    rec.add('C 唤醒点', '★ 唤醒点 A（主管同意需求结论）唤醒的是**架构位**', arch.includes('architect') && arch.includes('diagrammer'), `实际 ${arch.join('、')}`)
    rec.add('C 唤醒点', '★ 唤醒点 B（主管确认架构图）唤醒的是**计划位**', JSON.stringify(plan) === JSON.stringify(['planner']), `实际 ${plan.join('、')}`)
    rec.add('C 唤醒点', '★ 待机名单里**没有** main / 编写 / 测试 / 审核（名单方向是白名单，不误伤既有角色）', !HUB_STANDBY_SEATS.some((s) => ['main', 'writer', 'tester', 'reviewer'].includes(s.role)), '')
    rec.add('C 唤醒点', '★ `hubWakePointOf` 与表一致（不在名单里返回 null ⇒ 弃权而不是误拦）', hubWakePointOf('writer') === null && hubWakePointOf('planner') === HUB_WAKE_POINTS.DIAGRAM_CONFIRM, `writer=${hubWakePointOf('writer')} planner=${hubWakePointOf('planner')}`)
  }

  // =========================================================================
  // 【D】五道确认站点
  // =========================================================================
  {
    const all = Object.values(HUB_STATIONS)
    rec.add('D 五道站点', '★ 五道站点齐备（①②③④⑤）', all.length === 5, `实际 ${all.length}：${all.join('、')}`)
    rec.add('D 五道站点', '★ 第①道只认主管（单确认）', JSON.stringify(hubConfirmersOf(HUB_STATIONS.NEED_AGREE)) === JSON.stringify(['supervisor']), JSON.stringify(hubConfirmersOf(HUB_STATIONS.NEED_AGREE)))
    rec.add('D 五道站点', '★ 第②道只认主管（单确认）', JSON.stringify(hubConfirmersOf(HUB_STATIONS.DIAGRAM_CONFIRM)) === JSON.stringify(['supervisor']), JSON.stringify(hubConfirmersOf(HUB_STATIONS.DIAGRAM_CONFIRM)))
    rec.add(
      'D 五道站点',
      '★★ 第③道是**双确认**：主管 + 需求位（两个**不同**角色）',
      JSON.stringify(hubConfirmersOf(HUB_STATIONS.TEST_CONFIRM)) === JSON.stringify(['supervisor', 'orchestrator']) && hubIsDualStation(HUB_STATIONS.TEST_CONFIRM),
      JSON.stringify(hubConfirmersOf(HUB_STATIONS.TEST_CONFIRM)),
    )
    rec.add(
      'D 五道站点',
      '★★ 第④道是**双确认**：主管 + 需求位',
      JSON.stringify(hubConfirmersOf(HUB_STATIONS.REVIEW_CONFIRM)) === JSON.stringify(['supervisor', 'orchestrator']) && hubIsDualStation(HUB_STATIONS.REVIEW_CONFIRM),
      JSON.stringify(hubConfirmersOf(HUB_STATIONS.REVIEW_CONFIRM)),
    )
    rec.add('D 五道站点', '★ 双确认站点集合 = 派生（③④），不是手抄的第二份清单', JSON.stringify([...HUB_DUAL_STATIONS]) === JSON.stringify([HUB_STATIONS.TEST_CONFIRM, HUB_STATIONS.REVIEW_CONFIRM]), JSON.stringify([...HUB_DUAL_STATIONS]))
    rec.add(
      'D 五道站点',
      '★ 第③道挂在**既有** `dispatch_reviewer` 边上（不新开状态、不新开机制）',
      tr(ST.READY_REVIEW, 'dispatch_reviewer')?.guard === 'dispatch_reviewer_gate',
      `guard=${tr(ST.READY_REVIEW, 'dispatch_reviewer')?.guard}`,
    )
    rec.add(
      'D 五道站点',
      '★ 第④道挂在**既有** `close` 的组合闸里（`close_gates` 一个字没删，只多一条子判据）',
      tr(ST.PASSED, 'close')?.guard === 'close_gates',
      `guard=${tr(ST.PASSED, 'close')?.guard}`,
    )
    // 双确认必须由两份**各自角色**的交接物构成：两个确认角色都必须能产出 station_confirm
    const producers = HANDOFF_SCHEMAS.station_confirm.from
    rec.add(
      'D 五道站点',
      '★★ 双确认的两个确认方**都能产出** station_confirm（两份各自令牌产出的记录，不是一份里写两个布尔字段）',
      producers.includes('supervisor') && producers.includes('orchestrator'),
      `from=${JSON.stringify(producers)}`,
    )
    rec.add(
      'D 五道站点',
      '★ `station` 是**枚举**字段 ⇒ 第③道与第④道的确认记录**不可能互相复用**',
      Array.isArray(HANDOFF_SCHEMAS.station_confirm.fields.station.values) &&
        !HANDOFF_SCHEMAS.station_confirm.fields.station.values.includes(HUB_STATIONS.CLOSEOUT),
      JSON.stringify(HANDOFF_SCHEMAS.station_confirm.fields.station.values),
    )
  }

  // =========================================================================
  // 【E】方向表一致（既有自测抓的那条：两张表必须逐字相同）
  // =========================================================================
  {
    const m = boundaryManifest()
    const dirOf = (kind) => (m.handoff_directions.find((x) => x.kind === kind)?.from ?? []).slice().sort().join(',')
    for (const kind of ['station_confirm', 'prebrief', 'diagram_rework']) {
      const schema = (HANDOFF_SCHEMAS[kind]?.from ?? []).slice().sort().join(',')
      rec.add('E 方向表一致', `★ 新类型「${kind}」的 from 两处一致（handoff 方向表 ↔ 只读导出）`, dirOf(kind) === schema, `导出=${dirOf(kind)}　schema=${schema}`)
    }
    rec.add(
      'E 方向表一致',
      '★ 三个新类型都进了 `roles.js` 的 handoffKinds 白名单（忘了加 = 少一条能力，会被明确拒绝）',
      ROLES.supervisor.handoffKinds.includes('station_confirm') &&
        ROLES.supervisor.handoffKinds.includes('diagram_rework') &&
        ROLES.orchestrator.handoffKinds.includes('station_confirm') &&
        ROLES.planner.handoffKinds.includes('prebrief'),
      `supervisor=${JSON.stringify(ROLES.supervisor.handoffKinds)}`,
    )
    rec.add(
      'E 方向表一致',
      '★ 主管的 handoffKinds 里**没有** review_verdict / dev_to_test / test_to_review（不替别人交活、不判通过）',
      !['review_verdict', 'dev_to_test', 'test_to_review'].some((k) => ROLES.supervisor.handoffKinds.includes(k)),
      '',
    )
  }

  // =========================================================================
  // 【F】只读导出：新站点与发起方集合直接可见
  // =========================================================================
  {
    const hub = boundaryManifest().supervisor_hub
    rec.add('F 只读导出', '★ 导出里有 supervisor_hub 面（不是只存在于拒绝原文里）', hub !== undefined && hub !== null, '')
    rec.add('F 只读导出', '★ 发起方集合 = [' + "'supervisor'" + ']', JSON.stringify(hub.initiator_roles) === JSON.stringify(['supervisor']), JSON.stringify(hub.initiator_roles))
    rec.add('F 只读导出', '★ 两个唤醒点各自唤醒谁，逐条可查', Array.isArray(hub.wake_points) && hub.wake_points.length === 2, JSON.stringify(hub.wake_points))
    rec.add('F 只读导出', '★ 五道站点逐条给出「谁确认 / 走哪条判据 / 放行哪一跳」', Array.isArray(hub.stations) && hub.stations.length === 5 && hub.stations.every((s) => typeof s.gate === 'string' && s.gate.length > 0), '')
    rec.add('F 只读导出', '★ 双确认站点在导出里显式列出', JSON.stringify(hub.dual_stations) === JSON.stringify([HUB_STATIONS.TEST_CONFIRM, HUB_STATIONS.REVIEW_CONFIRM]), JSON.stringify(hub.dual_stations))
    rec.add('F 只读导出', '★ 「架构图前置」导出为**表上不存在的边**（可机械复核）', hub.diagram_first.forbidden_edge === 'analyzing → planning', hub.diagram_first.forbidden_edge)
    rec.add('F 只读导出', '★ 待机产物面三条判据在导出里列出（交接物 / 文件 / 测试）', Array.isArray(hub.standby_product_gates) && hub.standby_product_gates.length === 3, JSON.stringify(hub.standby_product_gates))
    const rules = boundaryManifest().rules.filter((r) => ['R9', 'R10', 'R11'].includes(r.id))
    rec.add('F 只读导出', '★ 枢纽的三条规则都进 RULES 且**全部是 class=a（已判据化）**', rules.length === 3 && rules.every((r) => r.class === 'a'), rules.map((r) => `${r.id}:${r.class}`).join(' '))
    rec.add('F 只读导出', '★ 规则里没有出现"只有说明、没有判据"的枢纽条目（enforce 非空）', rules.every((r) => typeof r.enforce === 'string' && r.enforce.length > 0), '')
  }

  // =========================================================================
  // 【G】控制角色不看代码（B1：full 必须按角色受限）
  // =========================================================================
  {
    rec.add(
      'G 控制角色不看代码',
      '★★ `NO_CODE_READ_ROLES` 含主管（roles.js 早就这么声明，这里是让代码与声明对上）',
      NO_CODE_READ_ROLES.includes('supervisor'),
      JSON.stringify(NO_CODE_READ_ROLES),
    )
    rec.add(
      'G 控制角色不看代码',
      '★ 四个人都在：main / orchestrator / planner / supervisor',
      ['main', 'orchestrator', 'planner', 'supervisor'].every((r) => NO_CODE_READ_ROLES.includes(r)),
      JSON.stringify(NO_CODE_READ_ROLES),
    )
    rec.add(
      'G 控制角色不看代码',
      '★ 执行角色（测试 / 审核 / 编写）**不在**名单里 ⇒ 它们的 full=true 不被误伤',
      !['tester', 'reviewer', 'writer'].some((r) => NO_CODE_READ_ROLES.includes(r)),
      JSON.stringify(NO_CODE_READ_ROLES),
    )
  }

  // =========================================================================
  // 【H】站点确认的形状判据（证据标识 / 脱敏证据正文）
  // =========================================================================
  {
    const base = {
      task_id: 'T-x',
      station: HUB_STATIONS.TEST_CONFIRM,
      artifact_version: 'v1',
      decision: 'ok',
      basis_refs: ['HO-abc123@v1#deadbeef'],
      basis_kind: 'evidence_digest',
      basis_digest: '测试 12 例全过；失败 0；依据见交接物 HO-abc123。',
      reason: '无问题',
    }
    rec.add('H 站点确认判据', '★ 正例：证据标识 + 脱敏证据正文 ⇒ 通过', validateHandoff('station_confirm', base).ok === true, JSON.stringify(validateHandoff('station_confirm', base).errors))
    const noRef = validateHandoff('station_confirm', { ...base, basis_refs: [] })
    rec.add('H 站点确认判据', '★ 反例：没有证据标识 ⇒ 拒（确认必须带可查的依据）', noRef.ok === false, '')
    const codeDigest = validateHandoff('station_confirm', { ...base, basis_digest: 'const x = 1;' })
    rec.add('H 站点确认判据', '★★ 反例：证据正文里出现**代码形态** ⇒ 拒（"证据 ≠ 代码正文"）', codeDigest.ok === false && codeDigest.errors.join('').includes('代码正文'), codeDigest.errors.join(' | ').slice(0, 200))
    rec.add('H 站点确认判据', '★ `hubEvidenceDigestHit` 对干净文本返回 null、对代码形态返回原因', hubEvidenceDigestHit('失败 0 例；路径 a/b/c') === null && hubEvidenceDigestHit('const x = 1;') !== null, '')
    const smuggle = validateHandoff('station_confirm', { ...base, patch_or_code: 'xxx' })
    rec.add('H 站点确认判据', '★ 反例：确认记录里夹带产物正文 ⇒ 拒', smuggle.ok === false, '')
    const badStation = validateHandoff('station_confirm', { ...base, station: 'not_a_station' })
    rec.add('H 站点确认判据', '★ 反例：station 不在五道表里 ⇒ 拒', badStation.ok === false, '')
    // prebrief（测试提前知情）
    const pb = {
      task_id: 'T-x',
      plan_handoff_id: 'HO-plan',
      assigned_scope: ['跑验收 1 与 2'],
      acceptance_refs: ['验收 1', '验收 2'],
      artifact_under_test: 'v1（编写交付前为占位）',
      not_yet_available: ['编写产物尚未交付'],
      must_not_start_before: 'dev_submitted',
    }
    rec.add('H 站点确认判据', '★ 正例：预登记（测试提前知情）⇒ 通过', validateHandoff('prebrief', pb).ok === true, JSON.stringify(validateHandoff('prebrief', pb).errors))
    rec.add('H 站点确认判据', '★ 反例：预登记里夹带**编写产物**字段 ⇒ 拒（不许看编写的产物）', validateHandoff('prebrief', { ...pb, patch_or_code: 'xxx' }).ok === false, '')
    rec.add('H 站点确认判据', '★ 反例：预登记里夹带**测试结论**字段 ⇒ 拒', validateHandoff('prebrief', { ...pb, verdict: 'pass' }).ok === false, '')
    rec.add('H 站点确认判据', '★ 反例：`not_yet_available` 空数组 ⇒ 拒（"还缺什么"必须显式回答）', validateHandoff('prebrief', { ...pb, not_yet_available: [] }).ok === false, '')
    rec.add(
      'H 站点确认判据',
      '★ 反例：重画指令 round≠1 ⇒ 拒（预算 = 1 落在**交接物**层，不只落在计数上）',
      validateHandoff('diagram_rework', { task_id: 'T-x', reason: 'r', round: 2, escalate_after: true }).ok === false,
      '',
    )
  }

  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

// ---------------------------------------------------------------------------
// 直接跑：`node tests/gate-states-check.mjs`
//
// ★ 2026-10-14 补：本文件此前**没有自跑入口** —— 直接跑会输出 0 字节、退出码 0，
//   即"看起来通过、实际一个用例都没跑"（实测：`node tests/gate-states-check.mjs`
//   → stdout+stderr = 0 B，exit = 0）。真实基线（55/55）当时只能经 `run-all.mjs`
//   （它按约定名 `runGateStatesCheck` 发现本文件）或让别的脚本 import 才拿得到。
//
//   形状照抄同目录**已经能直接跑**的兄弟（`human-check.mjs` / `fulltest-check.mjs` /
//   `schema-check.mjs` / `wake-check.mjs` 等 30 余份用的都是同一段）：
//     · 只在**本文件被直接执行**时跑一遍、打印与 run-all 同源的汇总、并给出退出码；
//     · 被 `run-all.mjs` import 时**不产生任何副作用**（它的发现机制一个字没变）。
//
//   ★ 只补入口：断言 / 期望值 / 用例一个字节没动。
// ---------------------------------------------------------------------------
if (process.argv[1] !== undefined && /gate-states-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runGateStatesCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
