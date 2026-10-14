/**
 * dsh-pipeline · tests/supervisor-check.mjs
 * ============================================================================
 * 交付单元④「主管站」的验收判据
 * 本单 T-20261011-214043 · 席位 writer#3（layer=supervisor）· 制品 v10
 *
 * 本文件是 `artifacts/v10/supervisor-delivery-v10.md` 的**可执行版**：
 * 上半部是定位稿与最小落地轮簿（给人读），下半部是同一批判据的可执行断言（给机器判）。
 *
 * 它**不接线任何一跳、不改状态机、不产任何写盘足迹**，只钉三件事：
 *   ① 主管站若接跳，必须同时登记「有权发确认的席位」，否则**接跳即死锁**；
 *   ② 现行链与越权硬拒（本单四类不变量中的闸门链与守门作用域）不受影响；
 *   ③ 轮簿的两条判据（五元组 / 两次确认顺序）**可判定**，供后续单接线时直接复用。
 *
 * ── 定位稿 ──────────────────────────────────────────────────────────────────
 * 【定性】主管站＝**有权的编排站**；不是只提建议的咨询站，也不是第二个派活出口。
 * 【主链】需求分析在「需求已确认」之后把结论**递交主管** → **主管 2 次确认** → 才**下放执行**。
 *         第 1 次确认＝范围与验收可执行；第 2 次确认＝资源与顺序可行；
 *         两次均须留痕，且**顺序不可颠倒**（第 2 次以第 1 次已留痕为前置）。
 * 【决策权】简单判断由主管自行决定，不必回问需求分析或用户。
 * 【视界约束】主管**不看全代码**。
 * 【下游递问题的唯一形状】五元组：截取的小片段＋修改点＋原因＋理由＋是否有必要；
 *         不带全量代码、不带全量日志；片段按行数与字节双限。
 * 【三条边界】不接管用户批准（完全档批准与需求确认仍只在用户手里）／
 *         不接管三权分立（编写/测试/审核分席不变）／不成为第二个派活出口（派活仍走既有状态机与守门）。
 *
 * ── 最小落地轮簿（最小轮次表）──────────────────────────────────────────────
 *   #   轮次                            from               event                      actor        to
 *   R0  需求确认（现有链，不改）          analyzing          requirement_confirmed      main         ready_plan
 *   R1  递交主管                        ready_plan         to_supervisor              main         ready_supervisor（新状态）
 *   R2  主管第 1 次确认（范围与验收可执行） ready_supervisor   supervisor_confirm_scope   supervisor   ready_supervisor（留痕不推进）
 *   R3  主管第 2 次确认（资源与顺序可行）   ready_supervisor   supervisor_confirm_budget  supervisor   ready_plan（回到既有链）
 *   R4  下放执行（复用既有出口）           ready_plan         dispatch_planner           main         planning
 *
 *   五元组字段与拒收条件：见下方 judgeQuestionPacket（规格的可判定化）。
 *   两次确认的留痕结构：{ round: 1|2, by: 'supervisor', at, verdict: 'ok'|'ng', reason, next }。
 *   两个硬前置（缺一即不许开这一跳）：
 *     ① 角色池与档位表登记 `supervisor` 角色及席位（并铸令牌）；
 *     ② 交接物方向表登记 supervisor 的 from/to。
 *   缺一则 R2/R3 **没有任何持令牌席位能发出** ⇒ 任务永久停在 ready_supervisor（只有 block/cancel 能救）。
 *
 * 零副作用声明：本文件不建目录、不写文件、不建会话、不监听端口、不改任何插件包文件。
 *
 * 退出码：0 = 全绿；1 = 有失败。
 */

import { TRANSITIONS, applyTransition, findTransition } from '../lib/states.js'

const lines = []
let passed = 0
let total = 0
const add = (name, cond, detail = '') => {
  total += 1
  if (cond) passed += 1
  lines.push(`${cond ? '✓' : '✗'} ${name}`)
  if (!cond && detail !== '') lines.push(`      ↳ ${detail}`)
}
const note = (text) => lines.push(text)

/** 轮簿 R1~R3 的三个事件名（本单规格名；本文件只判其登记是否自洽，不登记任何一跳）。 */
const SUPERVISOR_EVENTS = ['to_supervisor', 'supervisor_confirm_scope', 'supervisor_confirm_budget']
const SUPERVISOR_STATES = ['ready_plan', 'ready_supervisor']

/**
 * 五元组上递包的判据（规格的可判定化；模块内定义，不接入状态机与工具面）。
 * 拒收条件：缺字段、片段超行数/字节上限、necessity 不是可判定的「是 / 否」、片段夹带代码围栏。
 */
const PACKET_FIELDS = ['snippet', 'change_point', 'cause', 'rationale', 'necessity']
const SNIPPET_MAX_LINES = 40
const SNIPPET_MAX_BYTES = 4096

function judgeQuestionPacket(packet) {
  const errors = []
  const p = packet !== null && typeof packet === 'object' && !Array.isArray(packet) ? packet : {}
  for (const f of PACKET_FIELDS) {
    if (typeof p[f] !== 'string' || p[f].trim().length === 0) errors.push(`缺字段或为空：${f}`)
  }
  if (typeof p.snippet === 'string') {
    const lineCount = p.snippet.split('\n').length
    const byteCount = Buffer.byteLength(p.snippet, 'utf8')
    if (lineCount > SNIPPET_MAX_LINES) errors.push(`片段超行限：${lineCount} > ${SNIPPET_MAX_LINES}`)
    if (byteCount > SNIPPET_MAX_BYTES) errors.push(`片段超字节限：${byteCount} > ${SNIPPET_MAX_BYTES}`)
    if (p.snippet.includes('```')) errors.push('片段夹带代码围栏（只许截取小片段）')
  }
  const n = String(p.necessity ?? '').trim()
  if (n.length > 0 && !['是', '否'].includes(n)) errors.push(`necessity 必须是可判定的「是 / 否」：${n}`)
  return { ok: errors.length === 0, errors }
}

/**
 * 主管两次确认的判据（规格的可判定化）。
 * 放行条件：round=1 与 round=2 都留痕且 verdict=ok，且第 2 次不早于第 1 次。
 */
function judgeSupervisorConfirms(records) {
  const list = Array.isArray(records) ? records : []
  const r1 = list.find((r) => r?.round === 1)
  const r2 = list.find((r) => r?.round === 2)
  if (r1?.verdict !== 'ok') return { ok: false, reason: '第 1 次确认未留痕或未通过' }
  if (r2?.verdict !== 'ok') return { ok: false, reason: '第 2 次确认未留痕或未通过' }
  if (typeof r1.at === 'string' && typeof r2.at === 'string' && r2.at < r1.at) {
    return { ok: false, reason: `两次确认顺序颠倒（第 2 次 ${r2.at} 早于第 1 次 ${r1.at}）` }
  }
  return { ok: true, reason: '两次确认齐备且顺序正确' }
}

export async function runSupervisorCheck() {
  const byRoles = new Set()
  for (const t of TRANSITIONS) for (const r of (t.by ?? [])) byRoles.add(r)
  const found = []
  for (const ev of SUPERVISOR_EVENTS) {
    for (const from of SUPERVISOR_STATES) {
      const t = findTransition(from, ev)
      if (t !== null && t !== undefined) found.push({ ev, from, by: t.by ?? [] })
    }
  }

  lines.push('【一】死锁判据：主管站若接跳，必须同时有权发确认的席位')
  add(
    '存在主管站迁移时，其 by 白名单必须含 supervisor（否则任务会永久停在 ready_supervisor）',
    found.every((x) => x.by.includes('supervisor')),
    found.map((x) => `${x.from}+${x.ev}: by=${x.by.join('|')}`).join('；'),
  )
  add(
    '主管站迁移的起点与终点必须成对出现（只有 R1 没有 R2/R3 ⇒ 也进不去下放）',
    found.length === 0 || found.some((x) => x.ev === 'supervisor_confirm_scope' && x.from === 'ready_supervisor'),
    found.map((x) => `${x.from}+${x.ev}`).join('；'),
  )
  note(`  现状（非断言）：本轮登记的迁移条数＝${TRANSITIONS.length}；by 白名单角色＝${[...byRoles].sort().join(', ')}`)
  note(`  现状（非断言）：主管站事件当前登记数＝${found.length}（0 = 本轮未接跳，与定位稿「实现与否另定」一致）`)

  lines.push('')
  lines.push('【二】现行链不受影响（四类不变量之一：闸门链）')
  const chain = [
    ['analyzing', 'requirement_confirmed', 'main', 'ready_plan'],
    ['developing', 'dev_submitted', 'writer', 'ready_test'],
    ['testing', 'test_passed', 'tester', 'ready_review'],
  ]
  for (const [from, ev, role, to] of chain) {
    const r = applyTransition(from, ev, role)
    add(`${from} + ${ev} + ${role} → ${to}`, r.ok === true && r.to === to, JSON.stringify(r).slice(0, 180))
  }

  lines.push('')
  lines.push('【三】越权仍被硬拒（四类不变量之一：守门作用域）')
  for (const role of ['supervisor', 'writer']) {
    const r = applyTransition('analyzing', 'requirement_confirmed', role)
    add(`${role} 触发 main-only 事件（requirement_confirmed）被拒`, r.ok === false, String(r.error ?? '').slice(0, 160))
  }

  lines.push('')
  lines.push('【四】五元组判据（下游递问题的唯一形状）—— 规格可判定')
  const okPacket = {
    snippet: '- if (!ctx.sessionController) return unreachable()\n- 缺 sessionController 时直接上报',
    change_point: '通道不可用时改为先上报再等用户定，不静默降级',
    cause: '宿主侧会话控制器缺失时，旧实现会退回子代理通道',
    rationale: '用户原话要求不可达时必须先上报，且不许拿近似物冒名',
    necessity: '是',
  }
  add('齐全且合规的五元组 ⇒ 收下', judgeQuestionPacket(okPacket).ok === true, JSON.stringify(judgeQuestionPacket(okPacket).errors))
  add('缺 change_point ⇒ 拒收', judgeQuestionPacket({ ...okPacket, change_point: '' }).ok === false)
  add(
    `片段超行限（> ${SNIPPET_MAX_LINES} 行）⇒ 拒收`,
    judgeQuestionPacket({ ...okPacket, snippet: 'x\n'.repeat(SNIPPET_MAX_LINES + 1) }).ok === false,
  )
  add(
    `片段超字节限（> ${SNIPPET_MAX_BYTES} 字节）⇒ 拒收`,
    judgeQuestionPacket({ ...okPacket, snippet: '好'.repeat(SNIPPET_MAX_BYTES / 3 + 10) }).ok === false,
  )
  add('necessity 不是「是 / 否」⇒ 拒收', judgeQuestionPacket({ ...okPacket, necessity: '也许' }).ok === false)
  add('片段夹带代码围栏 ⇒ 拒收', judgeQuestionPacket({ ...okPacket, snippet: '```js\nconst a = 1\n```' }).ok === false)
  add(
    '拒收原因可读（逐条列出缺什么、超哪条限）',
    judgeQuestionPacket({ ...okPacket, change_point: '', necessity: '也许' }).errors.length === 2,
    JSON.stringify(judgeQuestionPacket({ ...okPacket, change_point: '', necessity: '也许' }).errors),
  )

  lines.push('')
  lines.push('【五】两次确认判据（顺序不可颠倒）—— 规格可判定')
  const c1 = { round: 1, by: 'supervisor', at: '2026-10-12T00:00:01Z', verdict: 'ok', reason: '范围与验收可执行' }
  const c2 = { round: 2, by: 'supervisor', at: '2026-10-12T00:00:02Z', verdict: 'ok', reason: '资源与顺序可行' }
  add('两次确认齐备且顺序正确 ⇒ 放行', judgeSupervisorConfirms([c1, c2]).ok === true)
  add('一条都没留痕 ⇒ 不放行', judgeSupervisorConfirms([]).ok === false)
  add('只有第 1 次确认 ⇒ 不放行', judgeSupervisorConfirms([c1]).ok === false)
  add('只有第 2 次确认 ⇒ 不放行', judgeSupervisorConfirms([c2]).ok === false)
  add('第 1 次为 ng ⇒ 不放行', judgeSupervisorConfirms([{ ...c1, verdict: 'ng' }, c2]).ok === false)
  add(
    '顺序颠倒（第 2 次时间早于第 1 次）⇒ 不放行',
    judgeSupervisorConfirms([c1, { ...c2, at: '2026-10-11T23:59:59Z' }]).ok === false,
  )
  add('留痕结构字段齐（round/by/at/verdict/reason）', [c1, c2].every((r) => ['round', 'by', 'at', 'verdict', 'reason'].every((k) => r[k] !== undefined)))

  lines.push('')
  lines.push('【六】两个硬前置（接跳前必须同时到位；本轮如实记录为未到位）')
  note('  · 前置①：角色池与档位表登记 supervisor 角色及席位（并铸令牌）')
  note(`     现状：by 白名单含 supervisor＝${byRoles.has('supervisor')}`)
  note('  · 前置②：交接物方向表登记 supervisor 的 from/to')
  note('     现状：本文件不读交接物方向表（避免与它单并发写盘互相干扰），该前置由后续单在接线时逐条核对')
  note('  ★ 两条前置缺一，R2/R3 就没有任何持令牌席位能发出 —— 这正是本轮判定「零接线」的根因。')

  lines.push('')
  lines.push('─'.repeat(78))
  lines.push(`主管站单元判据：${passed}/${total} 通过${passed === total ? '' : '  ← 有失败'}`)
  lines.push('─'.repeat(78))
  return { passed, total, text: lines.join('\n') }
}

/** 单跑本文件（由总入口调用时不走这里）。 */
if (process.argv[1] !== undefined && process.argv[1].endsWith('supervisor-check.mjs')) {
  const r = await runSupervisorCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
