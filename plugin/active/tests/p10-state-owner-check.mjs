/**
 * p10 · `STATE_OWNER` 完整性：状态全集 ⊆ owner 键集合（漏一个即红）
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/p10-state-owner-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（已登记，见 `WIRING.md` §W8）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * ---------------------------------------------------------------------------
 * 这个文件为什么存在
 * ---------------------------------------------------------------------------
 * `STATE_OWNER` 是"**这一步该催谁**"的唯一出处（`deliver.js` 直接按状态取它）。
 * 它是一张**手工维护的表** —— 新增状态时忘了登记，代码不会报错，只会静默答不出
 * "催谁"（取到 `undefined`）。真事：P4 加的 `demo_building` / `demo_confirm`
 * 就漏了整整一批（状态 26 个、owner 24 个），而**没有任何测试因此变红**。
 *
 * 所以本文件把"漏登记"变成一条**会红的断言** —— 以后加状态忘登记由测试拦，
 * 不靠人记得。
 *
 * ★ 判据四条（都不是"看起来对"，每条都有对照）：
 *   ① 状态全集 ⊆ `STATE_OWNER` 键集合 —— 漏一个即红，并把漏的那个**点名**；
 *   ② 反向也查：`STATE_OWNER` 不许有 ST 里不存在的键（改名的残留会在这里露出来）；
 *   ③ owner 值必须是**合法角色 id 或 `null`** —— 打字错（`'wirter'`）会在这里露出来；
 *   ④ `null` 的既有含义是"**终态，没人可催**" —— 所以 `null` 只能出现在终态上，
 *      活跃态给 `null` 即红（这正是 DEMO 两个状态**不能**用 `null` 搪塞的判据）。
 *
 * @module dsh-pipeline/tests/p10-state-owner-check
 */

import { ROLE } from '../lib/roles.js'
import { ST, STATE_OWNER, TERMINAL_STATES } from '../lib/states.js'
import { DEMO_ST, demoStateOwners } from '../lib/states/demo-phase.js'

// ---------------------------------------------------------------------------
// 极简断言（每个测试文件自带一份 —— 自包含是可独立运行的前提）
// ---------------------------------------------------------------------------
let passed = 0
let failed = 0
const lines = []

function ok(cond, title, detail = '') {
  if (cond) {
    passed += 1
    lines.push(`  ✓ ${title}`)
    if (detail.length > 0) lines.push(`      ${detail}`)
  } else {
    failed += 1
    lines.push(`  ✗ ${title}`)
    if (detail.length > 0) lines.push(`      ${detail}`)
  }
}

function eq(actual, expected, title) {
  ok(actual === expected, title, `期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`)
}

async function main() {
  lines.push('='.repeat(78))
  lines.push('p10 · STATE_OWNER 完整性：状态全集 ⊆ owner 键集合')
  lines.push('='.repeat(78))

  const allStates = Object.values(ST)
  const ownerKeys = Object.keys(STATE_OWNER)
  const roleIds = Object.values(ROLE)

  // ---- ① 状态全集 ⊆ STATE_OWNER 键集合（漏一个即红）-------------------------
  lines.push('')
  lines.push('【① 漏登记即红：每一个状态都必须答得出"该催谁"】')
  const missing = allStates.filter((s) => !Object.hasOwn(STATE_OWNER, s))
  ok(
    missing.length === 0,
    '★ 状态全集 ⊆ `STATE_OWNER` 键集合（漏一个即红）',
    missing.length === 0
      ? `状态 ${allStates.length} 个，owner 键 ${ownerKeys.length} 个，无遗漏`
      : `**漏登记 ${missing.length} 个**：${missing.join(' / ')} —— 这些状态下"该催谁"取到 undefined`,
  )
  eq(ownerKeys.length, allStates.length, '两个集合大小相等（配合上一条 ⇒ 恰好一一对应）')

  // ---- ② 反向：不许有 ST 里不存在的键 ---------------------------------------
  lines.push('')
  lines.push('【② 反向也查：owner 表里不许留 ST 里不存在的键（改名的残留）】')
  const stale = ownerKeys.filter((k) => !allStates.includes(k))
  ok(stale.length === 0, '`STATE_OWNER` 没有多余键', stale.length === 0 ? `键 ${ownerKeys.length} 个，全部对得上 ST` : `多余：${stale.join(' / ')}`)

  // ---- ③ owner 值必须是合法角色 id 或 null ----------------------------------
  lines.push('')
  lines.push('【③ owner 值必须是合法角色 id 或 `null`（打字错会在这里露出来）】')
  const badOwners = Object.entries(STATE_OWNER).filter(([, v]) => v !== null && !roleIds.includes(v))
  ok(
    badOwners.length === 0,
    '★ 每个 owner 都是 `roles.js` 里真有的角色 id（或显式 `null`）',
    badOwners.length === 0 ? `合法角色 id ${roleIds.length} 个，取值全部命中` : `非法：${badOwners.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' / ')}`,
  )

  // ---- ④ `null` 只能出现在终态 ----------------------------------------------
  lines.push('')
  lines.push('【④ `null` 的既有含义是"终态，没人可催" ⇒ 活跃态给 `null` 即红】')
  const nullStates = ownerKeys.filter((k) => STATE_OWNER[k] === null)
  const activeButNull = nullStates.filter((s) => !TERMINAL_STATES.includes(s))
  ok(
    activeButNull.length === 0,
    '★ 给 `null` 的状态**全都在** `TERMINAL_STATES` 里（活跃态不许用 `null` 搪塞）',
    activeButNull.length === 0 ? `null owner 的状态：${nullStates.join(' / ')}（都是终态）` : `活跃态却给了 null：${activeButNull.join(' / ')}`,
  )
  const terminalWithoutNull = TERMINAL_STATES.filter((s) => STATE_OWNER[s] !== null)
  ok(terminalWithoutNull.length === 0, '反向：终态一律是 `null`（不做"终态还催谁"这种自相矛盾）', terminalWithoutNull.length === 0 ? `终态 ${TERMINAL_STATES.join(' / ')} 都是 null` : `终态却有 owner：${terminalWithoutNull.join(' / ')}`)

  // ---- ⑤ DEMO 两个状态：有 owner、不是 null、且与 demo-phase.js 同源 ---------
  lines.push('')
  lines.push('【⑤ 本次补的那两条（P4 漏登记的两个 DEMO 状态）】')
  for (const [label, state] of [['demo_building', DEMO_ST.BUILDING], ['demo_confirm', DEMO_ST.CONFIRM]]) {
    ok(Object.hasOwn(STATE_OWNER, state), `\`${label}\` 在 \`STATE_OWNER\` 里有条目`, `owner=${JSON.stringify(STATE_OWNER[state])}`)
    ok(STATE_OWNER[state] !== null, `★ \`${label}\` **不是** \`null\`（它是活跃态、且在等人）`, `owner=${JSON.stringify(STATE_OWNER[state])}`)
  }
  const owners = demoStateOwners({ ROLE })
  eq(STATE_OWNER[DEMO_ST.BUILDING], owners[DEMO_ST.BUILDING], '`demo_building` 的 owner 与 `demo-phase.js` 同源（不是第二份手抄）')
  eq(STATE_OWNER[DEMO_ST.CONFIRM], owners[DEMO_ST.CONFIRM], '`demo_confirm` 的 owner 与 `demo-phase.js` 同源')
  eq(owners[DEMO_ST.BUILDING], ROLE.WRITER, '`demo_building` 轮到**编写席**（DEMO 还在做）')
  eq(owners[DEMO_ST.CONFIRM], ROLE.MAIN, '`demo_confirm` 轮到**主对话**（只有它能与用户对话）')
  let threw = false
  try {
    demoStateOwners({})
  } catch {
    threw = true
  }
  ok(threw, '不注入 ROLE 时抛错（与 `demoTransitions` 同一条纪律，避免两份角色 id 漂移）')

  // ---- ⑥ 判据自检：这套断言**真的会红** -------------------------------------
  //
  //   ★ 为什么在这里再验一次：本文件的 ① 是"漏一个即红"。如果它写错了
  //     （比如把"缺键"写成恒真），它会在**任何时候**都绿 —— 那就等于没有。
  //     所以拿两张**构造出来的坏表**打给它看：坏表必须被同一条判据判红。
  lines.push('')
  lines.push('【⑥ 判据自检：把同一套判据打到"故意做坏的表"上，必须变红】')
  const brokenMissing = { ...STATE_OWNER }
  delete brokenMissing[DEMO_ST.BUILDING]
  const miss = Object.values(ST).filter((s) => !Object.hasOwn(brokenMissing, s))
  ok(miss.length === 1 && miss[0] === DEMO_ST.BUILDING, '★ 删掉一条 ⇒ 同一条判据点名报出被删的那个（证明 ① 不是恒真）', `报出：${JSON.stringify(miss)}`)

  const brokenNull = { ...STATE_OWNER, [DEMO_ST.CONFIRM]: null }
  const activeNull = Object.keys(brokenNull).filter((k) => brokenNull[k] === null && !TERMINAL_STATES.includes(k))
  ok(activeNull.length === 1 && activeNull[0] === DEMO_ST.CONFIRM, '★ 把活跃态改成 `null` ⇒ 判据 ④ 报出它（证明"不许用 null 搪塞"是判据不是散文）', `报出：${JSON.stringify(activeNull)}`)

  const brokenTypo = { ...STATE_OWNER, [DEMO_ST.BUILDING]: 'wirter' }
  const typo = Object.entries(brokenTypo).filter(([, v]) => v !== null && !roleIds.includes(v))
  ok(typo.length === 1, '★ owner 打字错 ⇒ 判据 ③ 报出它', `报出：${typo.map(([k, v]) => `${k}=${v}`).join(', ')}`)

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`p10 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))

  return { passed, total: passed + failed, text: lines.join('\n') }
}

/**
 * ★ 聚合跑入口（`tests/run-all.mjs` 登记用 —— `WIRING.md` §W8 的"前置改动"）。
 *
 * 与"直接跑"的区别只有两条：**不 `process.exit`**、把原始输出**收进 `text`** ——
 * 断言、计数走的**完全是同一条路径**（所以登记不会改变被测行为）。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runP10StateOwnerCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ p10 运行失败（异常）：${err?.stack ?? err}`)
    // ★ 异常本身也算一次失败：崩了不能反而少一条，那会让通过率虚高。
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

// 直接跑：`node tests/p10-state-owner-check.mjs` —— 打印原文 + 退出码。
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('p10-state-owner-check.mjs')) {
  const r = await runP10StateOwnerCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
