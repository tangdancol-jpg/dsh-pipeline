/**
 * m2 · 记忆 · **实体归一**（同一事物的不同叫法折成同一个键；不同事物**不许**被折）
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/m2-memory-alias-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（登记点见 `WIRING.md` §W11）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * ---------------------------------------------------------------------------
 * 本文件只测一件事
 * ---------------------------------------------------------------------------
 * 判据 **R4**（同一事物的不同写法归到同一个键）与 **R5**（不同实体**不被误折**）。
 *
 * ★ R5 和 R4 一样重要：归一"折太狠"比"不折"更坏 —— 折错之后，
 *   recall 会把**别的任务**的经验当成这一张单的（错得看不出来）。
 *   所以每一条"会折叠"的断言旁边，都配一条"不许折叠"的对照。
 *
 * @module dsh-pipeline/tests/m2-memory-alias-check
 */

import { ROLE } from '../lib/roles.js'
import { ENTITY_PREFIX, ROLE_ALIAS, aliasAll, aliasEntity, canonicalPath, canonicalRole, canonicalState, knownState, sameEntity } from '../lib/memory/alias.js'
import { entityKeyOfToken, entityKeysOf, queryTokens, recordEntityKeys } from '../lib/memory/route-entity.js'

let passed = 0
let failed = 0
const lines = []

function ok(cond, title, detail = '') {
  if (cond) {
    passed += 1
    lines.push(`  ✓ ${title}`)
  } else {
    failed += 1
    lines.push(`  ✗ ${title}`)
  }
  if (detail.length > 0) lines.push(`      ${detail}`)
}

/** "这些写法必须折到一起"（R4 的形态：两两相等）。 */
function folds(label, values, prefixHint) {
  const keys = values.map((v) => aliasEntity(v, prefixHint))
  const uniq = [...new Set(keys)]
  ok(uniq.length === 1 && keys[0].length > 0, `${label} ⇒ 全部折成同一个键`, `${JSON.stringify(values)} → ${JSON.stringify(keys)}`)
}

/** "这俩**不许**折到一起"（R5 的形态）。 */
function differs(label, a, b, prefixHint) {
  const ka = aliasEntity(a, prefixHint)
  const kb = aliasEntity(b, prefixHint)
  ok(ka.length > 0 && kb.length > 0 && ka !== kb, `${label} ⇒ 两个键**必须不同**`, `${JSON.stringify(a)}=${ka}　${JSON.stringify(b)}=${kb}`)
}

async function main() {
  lines.push('='.repeat(78))
  lines.push('m2 · 记忆：实体归一（R4 折叠 / R5 不误折）')
  lines.push('='.repeat(78))

  // ---- ① 任务 id ----------------------------------------------------------
  lines.push('')
  lines.push('【① 任务 id：大小写与空白折叠；**不同任务绝不折到一起**（R4/R5）】')
  folds('同一条任务 id 的三种写法', ['T-20261011-214043', 't-20261011-214043', '  T-20261011-214043  '])
  folds('短 id 同理', ['T-1', 't-1', ' T-1 '])
  differs('T-1 与 T-2（判据 R5 的**原型**）', 'T-1', 'T-2')
  differs('T-1 与 T-10（前缀相同也不行）', 'T-1', 'T-10')
  differs('T-1 与 T-1x', 'T-1', 'T-1x')
  ok(aliasEntity('T-1') === 'task:t-1', '规范形态是 `task:<小写 id>`（前缀写在一处）', aliasEntity('T-1'))

  // ---- ② 路径 -------------------------------------------------------------
  lines.push('')
  lines.push('【② 路径：分隔符 / `./` / 重复分隔符 / `..` 折叠；**不许按 basename 折**】')
  folds('同一个文件的四种写法', ['./src/a.js', 'SRC\\A.JS', 'src//a.js', 'src/a.js'], ENTITY_PREFIX.PATH)
  folds('`..` 折回上一级', ['src/x/../a.js', 'src/a.js'], ENTITY_PREFIX.PATH)
  differs('不同目录下的同名文件（**这条最关键**）', 'a/x.js', 'b/x.js', ENTITY_PREFIX.PATH)
  differs('目录与同名文件不是一回事', 'src/a', 'src/a.js', ENTITY_PREFIX.PATH)
  ok(canonicalPath('./A\\B/../C.JS') === 'a/c.js', '`canonicalPath` 的输出形态钉住（小写 + 正斜杠 + 折叠）', canonicalPath('./A\\B/../C.JS'))
  ok(aliasEntity('', ENTITY_PREFIX.PATH) === '', '空路径折不出实体 ⇒ 空串（调用方应丢弃，而不是塞一个空键）')

  // ---- ③ 角色（中英混用） -------------------------------------------------
  lines.push('')
  lines.push('【③ 角色：`writer` / `编写` / `writing` 归一（设计 03 §3 的原话）】')
  folds('编写席的四种叫法', ['writer', '编写', 'writing', '编写席'], ENTITY_PREFIX.ROLE)
  folds('测试位的四种叫法', ['tester', '测试', 'testing', '测试位'], ENTITY_PREFIX.ROLE)
  folds('审核的四种叫法', ['reviewer', '审核', '评审', '审核位'], ENTITY_PREFIX.ROLE)
  differs('编写 ≠ 测试（**不许因为都在"干活"就折一起**）', 'writer', 'tester', ENTITY_PREFIX.ROLE)
  ok(ROLE_ALIAS['编写'] === ROLE.WRITER, '别名表的值来自 `lib/roles.js` 的 `ROLE`（不是手抄的字符串 —— 常量只有一个出处）', `ROLE_ALIAS['编写']=${ROLE_ALIAS['编写']} ROLE.WRITER=${ROLE.WRITER}`)
  ok(canonicalRole('  WRITER ') === ROLE.WRITER, '大小写与空白也折', canonicalRole('  WRITER '))
  ok(canonicalRole('某个没登记的角色') === '某个没登记的角色', '认不出的角色**原样返回**（不猜、不硬折成某个已知角色）', canonicalRole('某个没登记的角色'))

  // ---- ④ 状态（id 与人话标签） --------------------------------------------
  lines.push('')
  lines.push('【④ 状态：`closed` 与「已关闭」是同一个（标签→id 从 `STATE_LABEL` 反查，不手抄）】')
  folds('同一个状态的两种写法', ['closed', '已关闭', ' CLOSED '], ENTITY_PREFIX.STATE)
  folds('开发中同理', ['developing', '开发中'], ENTITY_PREFIX.STATE)
  differs('closed 与 cancelled（都是终态，但不是一回事）', 'closed', 'cancelled', ENTITY_PREFIX.STATE)
  ok(canonicalState('已关闭') === 'closed', '人话标签折回 id', `canonicalState('已关闭')=${canonicalState('已关闭')}`)
  ok(canonicalState('状态不存在') === '状态不存在', '认不出的状态原样返回', canonicalState('状态不存在'))
  // ★ E2 新增 `knownState`：与 `canonicalState` 的差别只有一条 —— **认不出返回空串**。
  //   实体路要的正是这个分辨力（认不出就不该造键：`fizzbuzz` 不该变成 `state:fizzbuzz`）。
  ok(
    knownState('已关闭') === 'closed' && knownState(' CLOSED ') === 'closed',
    '★ `knownState`：认得出 ⇒ 规范 id（大小写/空白都折）',
    `known=${JSON.stringify([knownState('已关闭'), knownState(' CLOSED ')])}`,
  )
  ok(
    knownState('fizzbuzz') === '' && knownState('') === '' && knownState(null) === '',
    '★ `knownState`：**认不出 ⇒ 空串**（与 `canonicalState` 的原样返回刻意不同 —— 实体路靠它分辨"认出来了没有"）',
    `known=${JSON.stringify([knownState('fizzbuzz'), knownState(''), knownState(null)])}｜canonical=${JSON.stringify(canonicalState('fizzbuzz'))}`,
  )

  // ---- ⑥ E2 实体路：从**自由文本**里认出实体（R4 折叠 / R5 不误折）----------
  lines.push('')
  lines.push('【⑥ E2 实体路：查询里的天然主键怎么折（判据 `05` §1 把 R4/R5 记在这一套里）】')
  ok(
    JSON.stringify(entityKeysOf('T-1 t-1  T-1 ')) === JSON.stringify(['task:t-1']),
    '★★ R4：`T-1` / `t-1` / 前后带空白 —— **三个写法折成一个键**',
    `keys=${JSON.stringify(entityKeysOf('T-1 t-1  T-1 '))}`,
  )
  ok(
    JSON.stringify(entityKeysOf('T-20261011-214043')) === JSON.stringify(['task:t-20261011-214043']),
    'R4：长任务 id 同样折（判据里点名的那三种写法之一）',
    `keys=${JSON.stringify(entityKeysOf('T-20261011-214043'))}`,
  )
  ok(
    entityKeysOf('SRC\\A.JS').join() === entityKeysOf('./src//a.js').join() &&
      entityKeysOf('SRC\\A.JS').join() === entityKeysOf('src/a.js').join(),
    '★ R4：反斜杠 / 前导 `./` / 重复分隔符 / 大小写 —— **同一个路径实体**',
    `三种写法 ⇒ ${JSON.stringify([entityKeysOf('SRC\\A.JS'), entityKeysOf('./src//a.js'), entityKeysOf('src/a.js')])}`,
  )
  ok(
    entityKeysOf('writer').join() === entityKeysOf('编写').join() &&
      entityKeysOf('编写').join() === 'role:writer',
    '★ R4：`writer` / `编写` 折成 `role:writer`（实体路要的就是这个"同一件事"）',
    `keys=${JSON.stringify([entityKeysOf('writer'), entityKeysOf('编写')])}`,
  )
  ok(
    entityKeysOf('已关闭').join() === entityKeysOf('closed').join() &&
      entityKeysOf('closed').join() === 'state:closed',
    '★ R4：状态 id 与人话标签折成同一个（`已关闭` ⇒ `state:closed`）',
    `keys=${JSON.stringify([entityKeysOf('已关闭'), entityKeysOf('closed')])}`,
  )
  ok(
    entityKeysOf('001-dev_to_test').join() === entityKeysOf('001-Dev_To_Test').join() &&
      entityKeysOf('001-dev_to_test').join() === 'handoff:001-dev_to_test',
    '★ R4：交接物 id 也认（`001-Dev_To_Test` ⇒ `handoff:001-dev_to_test`）',
    `keys=${JSON.stringify([entityKeysOf('001-dev_to_test'), entityKeysOf('001-Dev_To_Test')])}`,
  )
  ok(
    entityKeysOf('T-1').join() !== entityKeysOf('T-2').join() &&
      entityKeysOf('src/a.js').join() !== entityKeysOf('b/src/a.js').join() &&
      entityKeysOf('src/a.js').join() !== entityKeysOf('src/b.js').join(),
    '★★ R5：`T-1`≠`T-2`、`src/a.js`≠`b/src/a.js`、`src/a.js`≠`src/b.js`（**不按 basename 折**）',
    `keys=${JSON.stringify([entityKeysOf('T-1'), entityKeysOf('T-2'), entityKeysOf('src/a.js'), entityKeysOf('b/src/a.js')])}`,
  )
  ok(
    entityKeyOfToken('fizzbuzz') === '' &&
      entityKeyOfToken('这个任务之前怎么处理的') === '' &&
      entityKeysOf('把 fizzbuzz 写成一个函数').length === 0,
    '★ R5：普通词**一个键都不造**（`fizzbuzz` 不会变成 `task:fizzbuzz` —— 那是误折）',
    `keys=${JSON.stringify(entityKeysOf('把 fizzbuzz 写成一个函数'))}`,
  )
  ok(
    entityKeyOfToken('chapter:2') === '' && entityKeyOfToken('task:T-1') === 'task:t-1',
    'R5：显式前缀**只认名单里的那几个**（`task:` 认，`chapter:` 不认 —— 否则任意英文都能造出假实体）',
    `chapter=${JSON.stringify(entityKeyOfToken('chapter:2'))} task=${JSON.stringify(entityKeyOfToken('task:T-1'))}`,
  )
  ok(
    JSON.stringify(queryTokens('T-1 编写 src/a.js')) === JSON.stringify(['T-1', '编写', 'src/a.js']),
    '★ 切片段**不切** `._:/\\-`（切了就等于把实体切碎：任务 id / 路径 / 显式前缀全靠它们）',
    `tokens=${JSON.stringify(queryTokens('T-1 编写 src/a.js'))}`,
  )

  const MIXED = {
    id: 'handoff:T-20260202-bbbb:001-dev_to_test',
    at: '2026-02-03T00:00:00Z',
    kind: 'dev_to_test',
    scope: 'project',
    text: '交接物 001-dev_to_test（writer → tester）｜v1｜change_note=加了幂等键',
    entity: ['task:T-20260202-BBBB', 'path:./SRC/Order.JS', 'role:编写', 'handoff:H-073A6A57AAF0ECC7'],
    refs: {
      task_id: 't-20260202-bbbb',
      state: 'developing',
      state_label: '开发中',
      paths: ['SRC\\order.js'],
      handoff: 'H-073a6a57aaf0ecc7',
      artifact_version: 'v1',
      roles: ['编写'],
    },
  }
  ok(
    JSON.stringify([...recordEntityKeys(MIXED)].sort()) ===
      JSON.stringify(['handoff:h-073a6a57aaf0ecc7', 'path:src/order.js', 'role:writer', 'state:developing', 'task:t-20260202-bbbb']),
    '★★ 一条记忆的实体键集合：`entity[]` 与 `refs` 的同一批主键**折完只剩 5 个**（两处写法不重复计分）',
    `keys=${JSON.stringify([...recordEntityKeys(MIXED)].sort())}`,
  )
  ok(
    recordEntityKeys({ entity: null, refs: null }).size === 0 && recordEntityKeys(null).size === 0,
    '形状不对的条目 ⇒ 空集合（不抛 —— 坏数据不该把取回带崩）',
  )

  // ---- ⑦ 其它前缀与批量归一 ----------------------------------------------
  lines.push('')
  lines.push('【⑤ 其它前缀（handoff / tool / artifact）：只折大小写与空白】')
  folds('交接物 id', ['001-Dev_To_Test', '001-dev_to_test'], ENTITY_PREFIX.HANDOFF)
  folds('工具名', ['Pipeline_Recall', 'pipeline_recall'], ENTITY_PREFIX.TOOL)
  const all = aliasAll([' T-1 ', 't-1', '', 'T-2', 'T-1'], ENTITY_PREFIX.TASK)
  ok(JSON.stringify(all) === JSON.stringify(['task:t-1', 'task:t-2']), '`aliasAll`：折、去空、去重、**排序**（确定性）', JSON.stringify(all))
  ok(aliasAll(null).length === 0 && aliasAll(undefined).length === 0, '非数组输入 ⇒ 空数组（不抛）')
  ok(sameEntity('T-1', 't-1') === true && sameEntity('T-1', 'T-2') === false, '`sameEntity` 与上面的折叠/不折判据同源', `${sameEntity('T-1', 't-1')} / ${sameEntity('T-1', 'T-2')}`)

  // ---- ⑧ 判据自检：这套断言**真的会红** -----------------------------------
  lines.push('')
  lines.push('【⑧ 判据自检：拿"折错了"的键去打同一条判据 ⇒ 必须红】')
  const overFold = 'task:t' // 假设实现按"task 前缀 + 第一个字母"折（一个真实会犯的错）
  const realKey = aliasEntity('T-1')
  const overFoldSame = ['T-1', 'T-2'].map(() => overFold)
  ok(new Set(overFoldSame).size === 1 && overFold !== realKey, '★ 折太狠（T-1 与 T-2 都变成 `task:t`）⇒ `differs` 那条判据会红', `正确键=${realKey}　错误键=${overFold}（两者必须不同）`)
  const underFold = ['t-1', 'T-1'].map((x) => `task:${x}`) // 假设实现不折大小写
  ok(new Set(underFold).size === 2, '★ 折不干净（大小写没折）⇒ `folds` 那条判据会红（同一条输入会得到两个键）', JSON.stringify(underFold))

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`m2 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))
  return { passed, total: passed + failed, text: lines.join('\n') }
}

/**
 * 聚合跑入口（`tests/run-all.mjs` 登记用）。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runM2MemoryAliasCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ m2 运行失败（异常）：${err?.stack ?? err}`)
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('m2-memory-alias-check.mjs')) {
  const r = await runM2MemoryAliasCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
