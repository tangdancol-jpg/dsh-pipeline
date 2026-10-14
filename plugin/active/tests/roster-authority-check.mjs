/**
 * dsh-pipeline · 自测 22：★ **名单权威层**（「谁能开几个、开什么角色、按什么次序、什么权限」）
 * ============================================================================
 *     node tests/roster-authority-check.mjs
 *
 * 这一套只考**名单权威层**（writer#1 的文件面：roles / tiers / store 的那一段 /
 * boundaries / config）。它不建真实会话、不跑别人的层；**只在系统临时目录里开一张假任务单**（只为验"留痕落盘"那一条，跑完即删，不进任何真实任务目录）。
 *
 * 考什么（对应验收标准）：
 *   · A3 开对话人数上限 → `roster.dispatch_quota` + `checkDispatchQuota`
 *   · A4 次序倒置 → `sequence[].order/requires` + `validateDispatchSequence`
 *   · A6 加人减人仍然封闭 → 主管不在 `canRequestRosterChange` 名单里
 *   · B1 四槽缺一即拒 → `buildRosterSlots`（构造期）+ `setRoster`（落盘前，静态判据位）
 *   · B2 请求四槽与名单不一致即拒 → `compareDispatchSlots`（逐字段严格相等）
 *   · B3 未声明权限档 ⇒ 最小档 → `normalizeRosterSlots`（显式落值，不是 undefined 兜底）
 *   · B4 / B5 完全档：无用户判定即拒、有则放行且可追溯
 *   · B6 留痕字段可机读 → `DISPATCH_OPEN_AUDIT_FIELDS` + 只读导出
 *   · C4 / C5 主管那一站：角色表里的三条边界（kind/writes/交接物白名单）
 *   · 不变量回归：三权分立、席位上限、闸门总闸、既有默认档一个没被顺手放宽
 *
 * ★ 诚实边界（本套**不**声明的）：被开出的会话"实际拿到什么档"要靠通道读回，
 *   属通道层（`tests/dispatch-channel-check.mjs`）；"发起方在守门层被拒"属守门层
 *   （`tests/gate-states-check.mjs`）。两处都**不在**本套的判据范围里，本套不冒领。
 *
 * @module dsh-pipeline/tests/roster-authority-check
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ALL_ROLE_IDS, ROLE, ROLES, MAX_WRITER_SEATS, DEFAULT_WRITER_LAYERS, isControlRole, isExecutionRole } from '../lib/roles.js'
import {
  DISPATCH_OPEN_ACTION,
  DISPATCH_OPEN_AUDIT_FIELDS,
  dispatchOpenRecord,
  ROSTER_DEFAULT_MODE,
  ROSTER_ENV_DEFAULT,
  ROSTER_FULL_PERMISSION,
  ROSTER_MIN_PERMISSION,
  ROSTER_PERMISSION_TIERS,
  ROSTER_SLOT_KEYS,
  buildRoster,
  checkDispatchQuota,
  compareDispatchSlots,
  normalizeRosterSlots,
  slotKeyOf,
  slotRoleNeedsDeclaration,
  validateDispatchSequence,
} from '../lib/tiers.js'
import { boundaryManifest } from '../lib/boundaries.js'
import { DEFAULTS } from '../lib/config.js'
import { DISPATCH_SLOT_KEYS, MIN_PERMISSION, FULL_PERMISSION, PERMISSION_TIERS, DEFAULT_SESSION_PRESET } from '../lib/transport/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

function createRecorder() {
  const items = []
  return {
    items,
    /**
     * ★ 记一条断言：`(组名, ★ 判据说明, 是否通过, 实际值)` —— **四个参数**。
     *
     * ⚠️ 上一版这里只收三个参数，于是第二位的「★ 判据说明」被当成"是否通过"用
     *    （字符串 !== true）⇒ **全套断言一律记成未通过**，打印出来的还只剩组名。
     *    这一条是"自测自己也要被测"的活例子：套件没跑过，坏在签名上谁也看不出来。
     */
    add(name, desc, pass, detail) {
      items.push({ name, desc: String(desc ?? ''), pass: pass === true, detail: String(detail ?? '') })
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
  }
}

/** 本套用的清单夹具：L3（安全敏感，10 个独立对话）+ 单编写席位。 */
const SEAT = 'writer#1'
const FIXTURE_WRITERS = {
  count: 1,
  reason: '夹具：单席位（count=1 是同一套机制的退化情形）',
  partitions: [{ seat: SEAT, scope_paths: ['.'], deliverables: ['夹具产物'] }],
}
function fixture(over = {}) {
  return buildRoster({
    tier: 'L3',
    reason: '名单权威层自测夹具（不落盘）',
    judgedBy: 'planner',
    writers: FIXTURE_WRITERS,
    ...over,
  })
}

/** 一份"四槽声明齐全"的夹具（strict 模式下必须齐）。 */
function fullSlots(over = {}) {
  const base = { 'writer@writer#1': { permission: 'workspace-write' } }
  for (const r of ['architect', 'security', 'tester', 'reviewer', 'diagrammer', 'archivist']) {
    base[r] = { permission: 'read-only' }
  }
  return { ...base, ...over }
}

export async function runRosterAuthorityCheck() {
  const rec = createRecorder()

  // =========================================================================
  // A. 角色表：主管那一站（C4 / C5 / A6）
  // =========================================================================
  {
    const sup = ROLES[ROLE.SUPERVISOR]
    rec.add(
      'A 角色表',
      '★ 主管已进角色表，三条边界就是设计的三条（控制角色 / 真只读 / 不打回 / 不能自行改名单）',
      sup !== undefined && sup.kind === 'control' && sup.writes === 'readonly' && sup.canRework === false && sup.canRequestRosterChange === false,
      `supervisor=${JSON.stringify(sup === undefined ? null : { id: sup.id, zh: sup.zh, kind: sup.kind, writes: sup.writes, canRework: sup.canRework, canRequestRosterChange: sup.canRequestRosterChange })}`,
    )
    rec.add(
      'A 角色表',
      '★ C5 第一道判据：主管的交接物白名单里**没有** review_verdict（产不出审核结论）',
      sup !== undefined && !sup.handoffKinds.includes('review_verdict') && !sup.handoffKinds.includes('dev_to_test') && !sup.handoffKinds.includes('test_to_review'),
      `handoffKinds=${JSON.stringify(sup?.handoffKinds)}`,
    )
    rec.add(
      'A 角色表',
      '★ A6：主管不能自行改名单 —— canRequestRosterChange=false 且 canRework=false',
      sup?.canRequestRosterChange === false && sup?.canRework === false,
      `canRequestRosterChange=${sup?.canRequestRosterChange} canRework=${sup?.canRework}`,
    )
    rec.add(
      'A 角色表',
      '主管是控制角色（与主对话 / 需求分析 / 计划同类），不是执行角色',
      isControlRole(ROLE.SUPERVISOR) === true && isExecutionRole(ROLE.SUPERVISOR) === false,
      `isControlRole=${isControlRole(ROLE.SUPERVISOR)} isExecutionRole=${isExecutionRole(ROLE.SUPERVISOR)}`,
    )
    rec.add(
      'A 角色表',
      '既有 15 个角色一个没少、也没改名（新增只加了一个）',
      ['main', 'orchestrator', 'planner', 'architect', 'security', 'writer', 'tester', 'reviewer', 'archivist', 'diagrammer', 'release', 'docs', 'performance', 'arbiter', 'human'].every((x) => ROLES[x] !== undefined) && ALL_ROLE_IDS.length === 16,
      `ALL_ROLE_IDS(${ALL_ROLE_IDS.length})=${ALL_ROLE_IDS.join(',')}`,
    )
  }

  // =========================================================================
  // B. 四槽：与通道同源、四槽平级、最小档、完全档（B1 / B2 / B3 / B4 / B5）
  // =========================================================================
  {
    rec.add(
      'B 四槽',
      '★ 四槽字段名与派活通道**逐字一致**（名单权威层与通道层不许各写一套）',
      JSON.stringify(ROSTER_SLOT_KEYS) === JSON.stringify(DISPATCH_SLOT_KEYS) && ROSTER_SLOT_KEYS.length === 4,
      `名单侧=${JSON.stringify(ROSTER_SLOT_KEYS)}\n通道侧=${JSON.stringify(DISPATCH_SLOT_KEYS)}`,
    )
    rec.add(
      'B 四槽',
      '★ 三档取值 / 最小档 / 完全档 / 默认模式与通道一致',
      JSON.stringify(ROSTER_PERMISSION_TIERS) === JSON.stringify(PERMISSION_TIERS) && ROSTER_MIN_PERMISSION === MIN_PERMISSION && ROSTER_FULL_PERMISSION === FULL_PERMISSION && ROSTER_DEFAULT_MODE === DEFAULT_SESSION_PRESET,
      `tiers=${JSON.stringify(ROSTER_PERMISSION_TIERS)} 通道=${JSON.stringify(PERMISSION_TIERS)}\nmin=${ROSTER_MIN_PERMISSION}/${MIN_PERMISSION} full=${ROSTER_FULL_PERMISSION}/${FULL_PERMISSION} mode=${ROSTER_DEFAULT_MODE}/${DEFAULT_SESSION_PRESET}`,
    )
    rec.add(
      'B 四槽',
      '★ 四槽是四个**平级**字段：没有 options / slots 这类打包键',
      ROSTER_SLOT_KEYS.every((k) => !['options', 'slots', 'bundle', 'slotsObj'].includes(k)),
      JSON.stringify(ROSTER_SLOT_KEYS),
    )

    const min = normalizeRosterSlots({}, { who: '夹具' })
    rec.add(
      'B 四槽',
      '★ B3：未声明权限档 ⇒ **显式落最小档** read-only，且 origin=default（与"声明了最小档"可区分）',
      min.ok === true && min.slots.permission.value === 'read-only' && min.slots.permission.origin === 'default' && min.slots.permission.declared === false && min.slots.mode.value === ROSTER_DEFAULT_MODE && min.slots.model.value === ROSTER_ENV_DEFAULT && min.slots.reasoning.value === ROSTER_ENV_DEFAULT,
      JSON.stringify(min.slots),
    )
    const declared = normalizeRosterSlots({ permission: 'workspace-write', mode: 'standard', model: 'm-x', reasoning: 'high' }, { who: '夹具' })
    rec.add(
      'B 四槽',
      '★ U1 名单侧：声明了四槽 ⇒ 逐字段落值、origin=declared（"名单声明什么档"可判定）',
      declared.ok === true && declared.slots.permission.value === 'workspace-write' && declared.slots.model.value === 'm-x' && declared.slots.reasoning.value === 'high' && declared.slots.permission.declared === true,
      JSON.stringify(declared.slots),
    )
    const badName = normalizeRosterSlots({ permission: 'workspace_write' }, { who: '夹具' })
    rec.add(
      'B 四槽',
      '★ B2 的数据面：档名差一个字符即拒（逐字相等，不做归一）',
      badName.ok === false && String(badName.error).includes('不在三档之内'),
      String(badName.error ?? '').split('\n')[0],
    )
    const fullNo = normalizeRosterSlots({ permission: ROSTER_FULL_PERMISSION }, { who: '夹具' })
    rec.add(
      'B 四槽',
      '★ B4：声明「完全」档但没有用户判定记录 ⇒ 拒',
      fullNo.ok === false && String(fullNo.error).includes('没有可追溯'),
      String(fullNo.error ?? '').split('\n')[0],
    )
    const fullYes = normalizeRosterSlots({ permission: ROSTER_FULL_PERMISSION, permission_approval: { ref: 'HR-abc', at: '2026-10-11T00:00:00Z', seat: SEAT } }, { who: '夹具' })
    rec.add(
      'B 四槽',
      '★ B5：带用户判定记录 ⇒ 放行，且记录原样保留（谁、何时、针对哪个席位都可追溯）',
      fullYes.ok === true && fullYes.slots.permission_approval.value.ref === 'HR-abc' && fullYes.slots.permission_approval.value.seat === SEAT,
      JSON.stringify(fullYes.slots.permission_approval),
    )
    rec.add(
      'B 四槽',
      '★ B3 的适用范围：只读角色（主对话 / 需求分析 / 计划 / 主管）**不落槽位**，写活角色才要声明',
      ['main', 'orchestrator', 'planner', 'supervisor'].every((r) => slotRoleNeedsDeclaration(r) === false) && ['writer', 'tester', 'reviewer', 'architect', 'security', 'archivist', 'diagrammer'].every((r) => slotRoleNeedsDeclaration(r) === true),
      `不声明=${ALL_ROLE_IDS.filter((r) => !slotRoleNeedsDeclaration(r)).join(',')}\n需声明=${ALL_ROLE_IDS.filter((r) => slotRoleNeedsDeclaration(r)).join(',')}`,
    )
  }

  // =========================================================================
  // C. 名单构造：四槽表 / 版本位 / 人数上限 / 次序（B1 / B6 / A3 / A4）
  // =========================================================================
  {
    const built = fixture()
    rec.add('C 名单', 'L3 清单构造成功（10 个独立对话）', built.ok === true && built.roster.ai_count === 10, built.ok === true ? `ai_count=${built.roster.ai_count} conversations=${built.roster.conversations.join(',')}` : String(built.error))
    const R = built.roster

    const seated = new Set((R.writers?.partitions ?? []).map((p) => p.role_id))
    const expect = [
      ...R.execution_roles.filter((r) => slotRoleNeedsDeclaration(r) && !seated.has(r)),
      ...(R.writers?.partitions ?? []).map((p) => `${p.role_id}@${p.seat}`),
    ]
    const keys = Object.keys(R.slots ?? {})
    rec.add(
      'C 名单',
      '★ 四槽表覆盖清单里每一个要落槽位的席位（编写用「角色@席位」键；裸角色级键不多要一个）',
      expect.every((k) => keys.includes(k)) && keys.length === expect.length && !keys.includes('writer'),
      `应覆盖 ${expect.length}：${expect.join(',')}\n实际 ${keys.length}：${keys.join(',')}`,
    )
    rec.add(
      'C 名单',
      '★ 只读角色不落槽位（主对话 / 需求分析 / 计划 / 主管都不在四槽表里）',
      ['main', 'orchestrator', 'planner', 'supervisor'].every((r) => !keys.includes(r)) && !keys.includes('human'),
      `slots 键=${keys.join(',')}`,
    )
    rec.add(
      'C 名单',
      '★ 四槽逐席位齐全：每一槽都有 {value, declared, origin} 三件（缺槽无法判定）',
      keys.every((k) => ROSTER_SLOT_KEYS.every((s) => R.slots[k][s] !== undefined && Object.hasOwn(R.slots[k][s], 'value') && Object.hasOwn(R.slots[k][s], 'declared') && Object.hasOwn(R.slots[k][s], 'origin'))),
      JSON.stringify(R.slots[slotKeyOf('writer', SEAT)]),
    )
    rec.add(
      'C 名单',
      '★ B3：未声明的席位逐条落最小档 read-only（不是 undefined 兜底）',
      keys.every((k) => R.slots[k].permission.value === ROSTER_MIN_PERMISSION && R.slots[k].permission.origin === 'default'),
      keys.map((k) => `${k}=${R.slots[k].permission.value}/${R.slots[k].permission.origin}`).join('  '),
    )
    rec.add(
      'C 名单',
      '★ B6：名单带版本位三件套（slots_version 由 store 递增 / slots_digest 内容指纹 / slots_frozen_at 冻结时刻）',
      typeof R.slots_digest === 'string' && R.slots_digest.length === 64 && typeof R.slots_frozen_at === 'string' && /Z$/.test(R.slots_frozen_at),
      `slots_digest=${String(R.slots_digest).slice(0, 16)}…  slots_frozen_at=${R.slots_frozen_at}`,
    )
    rec.add(
      'C 名单',
      '★ A3：名单带人数上限（缺省 = 独立对话数）',
      R.dispatch_quota === R.conversations.length - 1 && R.dispatch_quota === 9,
      `dispatch_quota=${R.dispatch_quota}  conversations=${R.conversations.length}（含主对话；上限不含它）`,
    )
    rec.add(
      'C 名单',
      '★ A4：sequence 每条都带 order 与 requires（硬性次序的数据面）',
      Array.isArray(R.sequence) && R.sequence.length > 0 && R.sequence.every((x) => Number.isInteger(x.order) && Array.isArray(x.requires)),
      R.sequence.map((x) => `${x.order}:${x.role}${x.requires.length > 0 ? `(需先 ${x.requires.join('+')})` : ''}`).join(' → '),
    )

    const strictOk = fixture({ strictSlots: true, slots: fullSlots() })
    rec.add(
      'C 名单',
      '★ B1：写活席位**全部声明**四槽 ⇒ 构造通过',
      strictOk.ok === true,
      strictOk.ok === true ? `slots 键=${Object.keys(strictOk.roster.slots).join(',')}` : String(strictOk.error),
    )
    const strictShort = fixture({ strictSlots: true, slots: { 'writer@writer#1': { permission: 'workspace-write' } } })
    rec.add(
      'C 名单',
      '★ B1：缺席位声明 ⇒ 构造期就拒，并**逐条点名**缺了谁',
      strictShort.ok === false && String(strictShort.error).includes('缺少') && String(strictShort.error).includes('tester'),
      String(strictShort.error ?? '').split('\n')[0],
    )
    const stray = fixture({ slots: { 'nobody@nowhere': { permission: 'read-only' } } })
    rec.add(
      'C 名单',
      '★ 四槽表里出现榜单外的键 ⇒ 拒（"声明了但没有这个席位"比不声明更危险）',
      stray.ok === false && String(stray.error).includes('对不上'),
      String(stray.error ?? '').split('\n')[0],
    )
    const d1 = fixture().roster.slots_digest
    const d2 = fixture().roster.slots_digest
    const d3 = fixture({ slots: { 'writer@writer#1': { permission: 'workspace-write' } } }).roster.slots_digest
    rec.add(
      'C 名单',
      '★ 四槽表是确定性的：同输入两次同 digest；改一个槽 digest 变（版本位据此 +1）',
      d1 === d2 && d3 !== d1,
      `${String(d1).slice(0, 16)}… == ${String(d2).slice(0, 16)}…  →  ${String(d3).slice(0, 16)}…`,
    )
  }

  // =========================================================================
  // D. B2：请求四槽 vs 名单四槽 —— 逐字段严格相等
  // =========================================================================
  {
    const built = fixture({ slots: fullSlots({ 'writer@writer#1': { permission: 'workspace-write', mode: 'standard', model: 'm1', reasoning: 'high' } }) })
    const R = built.roster
    rec.add('D B2', '夹具：四槽表就是"名单里真的声明过"的那份', R !== undefined && R.slots[slotKeyOf('writer', SEAT)].permission.value === 'workspace-write', `slots 键=${Object.keys(R?.slots ?? {}).join(',')}`)

    const good = compareDispatchSlots(R, { role: 'writer', seat: SEAT, permission: 'workspace-write', mode: 'standard', model: 'm1', reasoning: 'high' })
    rec.add('D B2', '★ 请求四槽与名单逐字段相等 ⇒ 通过', good.ok === true, `mismatches=${JSON.stringify(good.mismatches)}`)
    for (const [slot, got] of [['permission', 'danger-full-access'], ['reasoning', 'medium'], ['mode', 'computer-use'], ['model', 'other-model']]) {
      const req = { role: 'writer', seat: SEAT, permission: 'workspace-write', mode: 'standard', model: 'm1', reasoning: 'high' }
      req[slot] = got
      const bad = compareDispatchSlots(R, req)
      rec.add('D B2', `★ 只差 ${slot} 一个字段 ⇒ 拒，且报出 want / got`, bad.ok === false && bad.mismatches.length === 1 && bad.mismatches[0].slot === slot, JSON.stringify(bad.mismatches))
    }
    const minOk = compareDispatchSlots(R, { role: 'tester', seat: null, permission: 'read-only', mode: ROSTER_DEFAULT_MODE, model: ROSTER_ENV_DEFAULT, reasoning: ROSTER_ENV_DEFAULT })
    rec.add('D B2', '★ 名单里声明为最小档的席位：请求照抄 ⇒ 通过', minOk.ok === true, JSON.stringify(minOk.mismatches))
    const minBad = compareDispatchSlots(R, { role: 'tester', seat: null, permission: 'workspace-write', mode: ROSTER_DEFAULT_MODE, model: ROSTER_ENV_DEFAULT, reasoning: ROSTER_ENV_DEFAULT })
    rec.add('D B2', '★ 未声明档位的席位：请求里塞一个更高档 ⇒ 拒（名单说最小档就是最小档）', minBad.ok === false && minBad.mismatches[0].slot === 'permission', JSON.stringify(minBad.mismatches))
    const noRoster = compareDispatchSlots({}, { role: 'writer', seat: SEAT })
    rec.add('D B2', '没有四槽表的老清单 ⇒ 直接拒（不许"没名单就放行"）', noRoster.ok === false, JSON.stringify(noRoster.mismatches))
  }

  // =========================================================================
  // E. A3 人数上限 / A4 硬性次序
  // =========================================================================
  {
    const R = fixture().roster
    // 缺省上限 = 名单里的席位会话数，**不含主对话**（主对话是用户开的，不是名单派出去的）
    const seatCount = R.conversations.filter((r) => r !== 'main').length
    rec.add('E 上限次序', '★ A3：缺省上限 = 席位会话数（不含主对话）', R.dispatch_quota === seatCount && seatCount === R.conversations.length - 1, `dispatch_quota=${R.dispatch_quota} 会话=${R.conversations.length}（含主对话）`)
    rec.add('E 上限次序', `★ A3：已开 ${seatCount - 1} / 上限 ${seatCount} ⇒ 第 ${seatCount} 个放行`, checkDispatchQuota(R, seatCount - 1).ok === true, JSON.stringify(checkDispatchQuota(R, seatCount - 1)))
    const over = checkDispatchQuota(R, seatCount)
    rec.add('E 上限次序', `★ A3：已开 ${seatCount}（第 ${seatCount + 1} 个）⇒ 拒，理由里写明"上限由名单说了算"`, over.ok === false && String(over.error).includes(`第 ${seatCount + 1} 个`) && String(over.error).includes(`上限是 ${seatCount} 个`), String(over.error ?? '').split('\n')[0])
    const { dispatch_quota: _q, ...legacy } = R
    rec.add('E 上限次序', '★ A3：老名单没有 dispatch_quota ⇒ 兜底同样不含主对话（不会多放行一个）', checkDispatchQuota(legacy, seatCount).ok === false && checkDispatchQuota(legacy, seatCount - 1).ok === true, `兜底上限=${checkDispatchQuota(legacy, 0).max}`)
    const R3 = fixture({ dispatchQuota: 3 }).roster
    rec.add('E 上限次序', '★ A3：名单显式声明上限 3 ⇒ 以它为唯一依据（第 4 个拒、第 3 个放行）', R3.dispatch_quota === 3 && checkDispatchQuota(R3, 3).ok === false && checkDispatchQuota(R3, 2).ok === true, `dispatch_quota=${R3.dispatch_quota}`)

    const first = R.sequence[0].role
    rec.add('E 上限次序', `★ A4：首位角色（${first}）没有前置 ⇒ 放行`, validateDispatchSequence(R, first, []).ok === true, JSON.stringify(validateDispatchSequence(R, first, []).entry))
    const reversed = validateDispatchSequence(R, 'planner', [])
    rec.add('E 上限次序', '★ A4：次序倒置（前置 orchestrator 未完成就开 planner）⇒ 拒，并点名卡在谁身上', reversed.ok === false && reversed.blockedBy.includes('orchestrator'), `blockedBy=${JSON.stringify(reversed.blockedBy)}\n${String(reversed.error ?? '').split('\n')[0]}`)
    rec.add('E 上限次序', '★ A4：前置完成后 ⇒ 放行', validateDispatchSequence(R, 'planner', ['orchestrator']).ok === true, JSON.stringify(validateDispatchSequence(R, 'planner', ['orchestrator'])))
    const outsider = validateDispatchSequence(R, 'not-a-role', [])
    rec.add('E 上限次序', '★ A4：名单外的角色 ⇒ 拒（名单外一律开不出来）', outsider.ok === false && outsider.entry === null, String(outsider.error ?? '').split('\n')[0])
    const partial = validateDispatchSequence(R, 'writer', ['orchestrator', 'planner'])
    rec.add('E 上限次序', '★ A4：前置只完成一半 ⇒ 仍然拒（同层的 architect / security 也要先完成）', partial.ok === false && partial.blockedBy.length > 0, `blockedBy=${JSON.stringify(partial.blockedBy)}`)
    rec.add('E 上限次序', '★ A4：每个角色的 requires 只指向**更早的** order（不许出现循环或自指）', R.sequence.every((x) => x.requires.every((r) => { const t = R.sequence.find((y) => y.role === r); return t !== undefined && t.order < x.order })), R.sequence.map((x) => `${x.order}:${x.role}←${x.requires.join('+') || '(无)'}`).join(' '))
  }

  // =========================================================================
  // F. 只读导出（A5 / B6 的可见性判据面）
  // =========================================================================
  {
    const man = boundaryManifest()
    const rs = man.roster_slots ?? {}
    rec.add('F 只读导出', '★ boundaryManifest 里有 roster_slots（复核方与钩子层不必读源码就能拿到四槽面）', man.roster_slots !== undefined && typeof rs === 'object', Object.keys(rs).join(','))
    rec.add('F 只读导出', '★ 导出的四槽 / 三档 / 最小档 / 完全档与代码常量**逐字一致**（派生，不手抄）', JSON.stringify(rs.slot_keys) === JSON.stringify(ROSTER_SLOT_KEYS) && JSON.stringify(rs.permission_tiers) === JSON.stringify(ROSTER_PERMISSION_TIERS) && rs.min_permission === ROSTER_MIN_PERMISSION && rs.full_permission === ROSTER_FULL_PERMISSION, `slot_keys=${JSON.stringify(rs.slot_keys)} tiers=${JSON.stringify(rs.permission_tiers)} min=${rs.min_permission} full=${rs.full_permission}`)
    rec.add('F 只读导出', '★ B6：留痕的动作名与字段表在导出里可机读（12 个字段，含四个平级槽与 verdict / reason）', rs.dispatch_open_action === DISPATCH_OPEN_ACTION && Array.isArray(rs.dispatch_open_fields) && DISPATCH_OPEN_AUDIT_FIELDS.every((f) => rs.dispatch_open_fields.includes(f)) && rs.dispatch_open_fields.includes('verdict') && rs.dispatch_open_fields.includes('reason'), `action=${rs.dispatch_open_action}\nfields=${JSON.stringify(rs.dispatch_open_fields)}`)
    rec.add('F 只读导出', '★ 留痕字段里四个槽是**平级**的（permission / mode / model / reasoning 各自一个字段）', ['permission', 'mode', 'model', 'reasoning'].every((k) => DISPATCH_OPEN_AUDIT_FIELDS.includes(k)) && !DISPATCH_OPEN_AUDIT_FIELDS.includes('slots') && !DISPATCH_OPEN_AUDIT_FIELDS.includes('options'), JSON.stringify(DISPATCH_OPEN_AUDIT_FIELDS))
    const supMan = (man.roles ?? []).find((r) => r.id === ROLE.SUPERVISOR)
    rec.add('F 只读导出', '主管已进 roles 导出（角色表这一半落地；read_only / 读源码两项由守门名单决定，属守门层）', supMan !== undefined && supMan.kind === 'control' && supMan.writes === 'readonly', JSON.stringify(supMan))
    rec.add('F 只读导出', '★ A5 的判据面仍在：transitions 每条带 by 集合（"谁能推这一站"直接可读）', Array.isArray(man.transitions) && man.transitions.length > 0 && man.transitions.every((t) => Array.isArray(t.by) && t.by.length > 0), `transitions=${man.transitions.length} 条`)
  }

  // =========================================================================
  // G. B1 的判据位（静态判究：拒必须发生在**任何落盘之前**）
  // =========================================================================
  {
    const storeSrc = readFileSync(join(HERE, '..', 'lib', 'store', 'roster.js'), 'utf8')
    const iGate = storeSrc.indexOf("'ROSTER_SLOT_MISSING'")
    const iAssign = storeSrc.indexOf('task.roster = roster')
    const iAudit = storeSrc.indexOf("'roster:set'")
    const iPersist = storeSrc.indexOf('await persist(task)', iAssign === -1 ? 0 : iAssign)
    rec.add(
      'G 判据位',
      '★ B1 的拒发生在 setRoster 里，且在**改 task.roster / 写审计 / persist 之前**（拒了盘上一个字节不动）',
      iGate > 0 && iAssign > iGate && iAudit > iGate && iPersist > iGate,
      `'ROSTER_SLOT_MISSING'@${iGate}  'task.roster = roster'@${iAssign}  "'roster:set'"@${iAudit}  'await persist(task)'@${iPersist}`,
    )
    rec.add(
      'G 判据位',
      '★ B1 的拒绝码与点名文案在同一处（错误码可机读、文案点名缺了谁）',
      storeSrc.includes('ROSTER_SLOT_MISSING') && storeSrc.includes('没有声明四槽') && storeSrc.includes('四个平级字段'),
      '拒绝码 ROSTER_SLOT_MISSING + 点名文案 都在 store/roster.js 的 setRoster 里',
    )
    rec.add(
      'G 判据位',
      '★ 留痕走**既有** audit 入口（没有第二套日志），动作名 roster:set 的 detail 里已带 slots_version / slots_digest / slots',
      storeSrc.includes("'roster:set'") && storeSrc.includes('slots_version: roster.slots_version') && storeSrc.includes('slots_digest: roster.slots_digest') && storeSrc.includes('slots: roster.slots'),
      'store/roster.js 的 roster:set 明细：tier / ai_count / roles / judged_by / slots_version / slots_digest / slots',
    )
  }

  // =========================================================================
  // H. 不变量回归（本次改动不许动到的东西）
  // =========================================================================
  {
    const man = boundaryManifest()
    rec.add('H 回归', '★ 三权分立未动：编写仍无 test_to_review / review_verdict；审核仍是 review_verdict 的唯一产出者', !ROLES[ROLE.WRITER].handoffKinds.includes('review_verdict') && !ROLES[ROLE.WRITER].handoffKinds.includes('test_to_review') && ROLES[ROLE.REVIEWER].handoffKinds.includes('review_verdict'), `writer=${JSON.stringify(ROLES[ROLE.WRITER].handoffKinds)}\nreviewer=${JSON.stringify(ROLES[ROLE.REVIEWER].handoffKinds)}`)
    rec.add('H 回归', '★ 编写席位上限与层清单未动（6 / interface,data,logic）', MAX_WRITER_SEATS === 6 && JSON.stringify(DEFAULT_WRITER_LAYERS) === JSON.stringify(['interface', 'data', 'logic']), `MAX_WRITER_SEATS=${MAX_WRITER_SEATS} layers=${DEFAULT_WRITER_LAYERS.join(',')}`)
    rec.add('H 回归', '★ 闸门总闸一个没关（守门 / 改动面 / 全量测试审批 / 哈希前置闸 / 拦截缝 / 编写不跑测试）', DEFAULTS.guardEnabled === true && DEFAULTS.guardChangeScope === true && DEFAULTS.guardFullTestApproval === true && DEFAULTS.guardHashGate === true && DEFAULTS.intercept === true && DEFAULTS.guardWriterRunsTests === true, `guardEnabled=${DEFAULTS.guardEnabled} guardChangeScope=${DEFAULTS.guardChangeScope} guardFullTestApproval=${DEFAULTS.guardFullTestApproval} guardHashGate=${DEFAULTS.guardHashGate} intercept=${DEFAULTS.intercept} guardWriterRunsTests=${DEFAULTS.guardWriterRunsTests}`)
    rec.add('H 回归', '★ 既有默认档没被顺手放宽（打回预算 2 / 失联阈值 5 分钟 / 澄清轮次 2 / 席位失落自动处置开）', DEFAULTS.maxReworkPerLeg === 2 && DEFAULTS.seatSilenceMs === 300000 && DEFAULTS.maxClarifyRounds === 2 && DEFAULTS.seatLivenessEscalate === true, `maxReworkPerLeg=${DEFAULTS.maxReworkPerLeg} seatSilenceMs=${DEFAULTS.seatSilenceMs} maxClarifyRounds=${DEFAULTS.maxClarifyRounds} seatLivenessEscalate=${DEFAULTS.seatLivenessEscalate}`)
    rec.add('H 回归', '★ 令牌与会话绑定默认已打开（用户裁定 ★6；**生效需重启 + 复验**）', DEFAULTS.requireAgentBinding === true, `requireAgentBinding=${DEFAULTS.requireAgentBinding}`)
    rec.add('H 回归', '★ 漂移告警位仍然可用：unmapped 只报"守门认不出的 writes"（主管要由守门层纳入只读名单）', Array.isArray(man.unmapped), `unmapped=${JSON.stringify(man.unmapped)}\n★ 这一项的闭合在守门层（guard.js 的只读名单与读禁名单），属 writer#2 的文件面。`)
  }

  // =========================================================================
  // =========================================================================
  // I. B6 落盘：一次「开对话」= 一条**只追加**的审计行（接受与被拒都留）
  // =========================================================================
  {
    /**
     * 这一组要**真开一张假任务单**（系统临时目录，跑完即删）—— B6 考的是"落盘"，
     * 纯函数那一半只能证明字段形状。store 用动态 import 取：本套顶部的静态 import 段
     * 是接口面（另两席按约定名发现它），不为一条用例去动它。
     */
    const { createTaskStore } = await import('../lib/store.js')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')

    const rosterV = { ...fixture().roster, slots_version: 7 }
    const AT = '2026-10-12T00:00:00.000Z'
    const REQ = {
      actorRole: 'planner',
      actorSeat: null,
      targetRole: 'writer',
      targetSeat: SEAT,
      permission: 'workspace-write',
      mode: ROSTER_DEFAULT_MODE,
      model: 'env-default',
      reasoning: 'high',
    }

    const acc = dispatchOpenRecord({ ...REQ, verdict: 'accept' }, rosterV, { at: AT })
    rec.add(
      'I 留痕落盘',
      '★ B6 字段面：一条记录**恰好**是冻结表那 12 个字段（键名与顺序都要逐字一致）',
      JSON.stringify(Object.keys(acc.record)) === JSON.stringify(DISPATCH_OPEN_AUDIT_FIELDS),
      Object.keys(acc.record).join('、'),
    )
    rec.add(
      'I 留痕落盘',
      '★ A1：接受那条带齐发起角色/席位、目标角色/席位、四槽、依据名单版本（取自名单本身）、时间、结论',
      acc.record.verdict === 'accept' &&
        acc.record.actor_role === 'planner' &&
        acc.record.target_role === 'writer' &&
        acc.record.target_seat === SEAT &&
        acc.record.permission === 'workspace-write' &&
        acc.record.roster_version === 7 &&
        acc.record.at === AT,
      JSON.stringify(acc.record),
    )
    const rej = dispatchOpenRecord(
      { ...REQ, verdict: 'reject', reason: '次序倒置：前置席位尚未完成' },
      rosterV,
      { at: AT },
    )
    rec.add(
      'I 留痕落盘',
      '★ A2：拒绝那条与接受那条**同一种形状**，只在结论与原因上不同',
      rej.record.verdict === 'reject' &&
        rej.record.reason === '次序倒置：前置席位尚未完成' &&
        rej.defects.length === 0 &&
        JSON.stringify(Object.keys(rej.record)) === JSON.stringify(DISPATCH_OPEN_AUDIT_FIELDS),
      `verdict=${rej.record.verdict} reason=${rej.record.reason} defects=${JSON.stringify(rej.defects)}`,
    )
    const noReason = dispatchOpenRecord({ ...REQ, verdict: 'reject' }, rosterV, { at: AT })
    rec.add(
      'I 留痕落盘',
      '★ 拒绝却没给原因 ⇒ **照样留痕**，但原因里点名这次是调用方违约（不留一条没原因的拒绝记录）',
      noReason.defects.includes('REJECT_REASON_MISSING') &&
        noReason.record.verdict === 'reject' &&
        String(noReason.record.reason).length > 0,
      `defects=${JSON.stringify(noReason.defects)} reason=${noReason.record.reason}`,
    )
    const weird = dispatchOpenRecord({ ...REQ, verdict: 'maybe' }, rosterV, { at: AT })
    rec.add(
      'I 留痕落盘',
      '★ 结论取值认不出 ⇒ 按**未通过**落痕（fail-closed：不许把"没看懂"记成接受）',
      weird.record.verdict === 'reject' && weird.defects.includes('VERDICT_INVALID'),
      `verdict=${weird.record.verdict} defects=${JSON.stringify(weird.defects)}`,
    )
    const rawSlot = dispatchOpenRecord({ ...REQ, verdict: 'accept', permission: 'workspace_write' }, rosterV, { at: AT })
    rec.add(
      'I 留痕落盘',
      '★ 四槽**原样照抄**、不做归一（差一个字符就是另一档；判"与名单是否相等"是 compareDispatchSlots 的活）',
      rawSlot.record.permission === 'workspace_write',
      `记录里存的 permission=${rawSlot.record.permission}`,
    )
    const fnMode = dispatchOpenRecord({ ...REQ, verdict: 'accept', mode: () => 'standard' }, rosterV, { at: AT })
    rec.add(
      'I 留痕落盘',
      '★ 槽位是函数（老调用方传下发函数）也不会让字段消失：序列化后仍是 12 个键',
      Object.keys(JSON.parse(JSON.stringify(fnMode.record))).length === DISPATCH_OPEN_AUDIT_FIELDS.length,
      `mode=${JSON.stringify(fnMode.record.mode)} 序列化后键数=${Object.keys(JSON.parse(JSON.stringify(fnMode.record))).length}`,
    )
    const noVersion = dispatchOpenRecord({ ...REQ, verdict: 'accept' }, null, { at: AT })
    rec.add(
      'I 留痕落盘',
      '★ 老清单没有版本位 ⇒ roster_version 写 null（**不编造**一个版本号冒名"第 0 版"）',
      noVersion.record.roster_version === null,
      `roster_version=${JSON.stringify(noVersion.record.roster_version)}`,
    )

    // ---- 落盘那一半：真写两行，再从盘上读回来核对（临时目录，跑完即删） ----
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-pipeline-roster-'))
    try {
      const st = createTaskStore({ projectRoot: tmp })
      const opened = await st.open({
        actorRole: 'main',
        requirement: 'I 组夹具：只为验「开对话留痕落盘」（系统临时目录，跑完即删）。',
      })
      const id = String(opened?.task?.id ?? '')
      const a1 = await st.recordDispatchOpen({ taskId: id, ...REQ, verdict: 'accept' })
      const a2 = await st.recordDispatchOpen(id, {
        ...REQ,
        verdict: 'reject',
        reason: '名单外角色：该角色不在本次名单的硬性次序里',
      })
      const rows = readFileSync(join(tmp, '.pipeline', id, 'audit.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l))
      const opens = rows.filter((r) => r.action === DISPATCH_OPEN_ACTION)
      rec.add(
        'I 留痕落盘',
        '★ B6：两次请求 ⇒ 盘上**两条** action=dispatch:open 的行（接受与被拒都留）',
        a1.ok === true && a2.ok === true && opens.length === 2,
        `ok=${a1.ok}/${a2.ok}　盘上 dispatch:open 行数=${opens.length}`,
      )
      rec.add(
        'I 留痕落盘',
        '★ 两条都能机读地取出结论：一条 accept、一条 reject（拒绝那条带原因原文）',
        opens.some((r) => r.verdict === 'accept') &&
          opens.some((r) => r.verdict === 'reject' && String(r.reason).includes('名单外角色')),
        opens.map((r) => `${r.verdict}：${r.reason ?? '(无原因)'}`).join(' ｜ '),
      )
      rec.add(
        'I 留痕落盘',
        '★ 每条都带齐 12 个字段（少一个键就不是"可机读的同一种形状"）',
        opens.every((r) => DISPATCH_OPEN_AUDIT_FIELDS.every((f) => Object.hasOwn(r, f))),
        opens.map((r) => `字段数=${Object.keys(r).length}`).join('、'),
      )
      rec.add(
        'I 留痕落盘',
        '★ 留痕**不塞进派活台账**：task.dispatched 仍是空的（台账会被重派覆盖，审计只追加）',
        Array.isArray(opened?.task?.dispatched) && opened.task.dispatched.length === 0,
        `dispatched=${JSON.stringify(opened?.task?.dispatched ?? null)}`,
      )
      const hist = (a2.task?.history ?? []).filter((h) => h.action === DISPATCH_OPEN_ACTION)
      rec.add(
        'I 留痕落盘',
        '★ 同一份记录也进内存历史（audit 行与 task.history 一处写、两处可读）',
        hist.length === 2 && hist.every((h) => DISPATCH_OPEN_AUDIT_FIELDS.every((f) => Object.hasOwn(h, f))),
        `history 里的 dispatch:open 行数=${hist.length}`,
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  // 输出
  // =========================================================================
  const lines = []
  lines.push('='.repeat(78))
  lines.push('22. ★ 名单权威层：四槽 / 版本位 / 人数上限 / 硬性次序 / 留痕字段 / 只读导出')
  lines.push('='.repeat(78))
  let lastGroup = ''
  for (const it of rec.items) {
    const g = it.name.split(' ')[0]
    if (g !== lastGroup) {
      lastGroup = g
      lines.push('')
    }
    /**
     * 打印：组名 + ★ 判据说明 + 实际值 —— 只打组名的话，红了一条根本不知道红的是哪条。
     */
    lines.push(`${it.pass ? '✓' : '✗'} ${it.name}｜${it.desc}`)
    if (it.detail.length > 0) {
      for (const l of it.detail.split('\n')) lines.push(`    ${l}`)
    }
  }
  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`总计：${rec.passed}/${rec.total} 通过`)
  lines.push('='.repeat(78))

  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

if (process.argv[1] !== undefined && /roster-authority-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runRosterAuthorityCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
