/**
 * m5 · 记忆取回 · **三路各自命中 + 合并去重且结果确定**（E0 两路 → E2 三路）
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：直接跑 `node tests/m5-memory-route-check.mjs`；
 * 聚合跑 `node tests/run-all.mjs`。退出码：0 = 全绿；1 = 有失败。
 *
 * 只测一件事（`CONVENTIONS.md` §3.2）：**取回的"取"这一步对不对** —— 判据 R6
 * （跑两次字节级相同）与 R7（每路单独能命中、合并无重复）。★ R4/R5（实体归一本身）
 * 在 `m2-memory-alias-check.mjs`（`05` §1 的登记）；R8/R9（上限是硬的）在 `m6`。
 *
 * @module dsh-pipeline/tests/m5-memory-route-check
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { memoryDir, memoryFile, resolveBank } from '../lib/memory/bank.js'
import { mergeRoutes, dedupeById } from '../lib/memory/merge.js'
import { readArchive } from '../lib/memory/load.js'
import { recordEntityKeys, routeEntity } from '../lib/memory/route-entity.js'
import { routeKeyword, tokenize } from '../lib/memory/route-keyword.js'
import { routeTime } from '../lib/memory/route-time.js'
import { buildMemoryTools } from '../lib/tools/memory.js'

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

const ids = (list) => list.map((x) => x.id)

/** 两条构造出来的记忆（时间与关键词都能分辨它们）。 */
const REC_A = {
  id: 'task:T-20260101-aaaa',
  at: '2026-01-01T00:00:00Z',
  kind: 'task',
  scope: 'project',
  text: '任务 T-20260101-aaaa｜已关闭（closed）｜需求：写一个 fizzbuzz 函数',
  entity: ['task:T-20260101-aaaa', 'state:closed'],
  refs: { task_id: 'T-20260101-aaaa', state: 'closed', state_label: '已关闭', paths: [], handoff: '', artifact_version: '', roles: [] },
}
const REC_B = {
  id: 'task:T-20260202-bbbb',
  at: '2026-02-02T00:00:00Z',
  kind: 'task',
  scope: 'project',
  text: '任务 T-20260202-bbbb｜开发中（developing）｜需求：给订单接口加幂等键',
  entity: ['task:T-20260202-bbbb', 'state:developing'],
  refs: { task_id: 'T-20260202-bbbb', state: 'developing', state_label: '开发中', paths: ['src/order.js'], handoff: '', artifact_version: '', roles: [] },
}

/** 一条**故意用另一套写法**记录同一件事的记忆（E2 的实体路靠它证明"折叠"）。 */
const REC_C = {
  id: 'handoff:T-20260202-bbbb:001-dev_to_test',
  at: '2026-02-03T00:00:00Z',
  kind: 'dev_to_test',
  scope: 'project',
  text: '交接物 001-dev_to_test（writer → tester）｜v1｜change_note=加了幂等键',
  // ★ 大小写与 `./` 都是"同一事物的另一种写法"（前缀**必须**小写 —— 那是 `record.js` 的形状契约）：
  entity: ['task:T-20260202-BBBB', 'path:./SRC/Order.JS', 'role:编写', 'handoff:H-073A6A57AAF0ECC7'],
  refs: { task_id: 't-20260202-bbbb', state: 'developing', state_label: '开发中', paths: ['SRC\\order.js'], handoff: 'H-073a6a57aaf0ecc7', artifact_version: 'v1', roles: ['编写'] },
}

async function main() {
  lines.push('='.repeat(78))
  lines.push('m5 · 记忆取回：两路各自命中 + 合并去重 + 结果确定（E0）')
  lines.push('='.repeat(78))

  // ---- ① 关键词路：命中该命中的 -------------------------------------------
  lines.push('')
  lines.push('【① 关键词路：只有真的提到它的那条才命中】')
  const kw = routeKeyword([REC_A, REC_B], { query: 'fizzbuzz' })
  ok(kw.length === 1 && kw[0].id === REC_A.id, '`fizzbuzz` 只命中写着 fizzbuzz 的那条', `命中=${JSON.stringify(ids(kw))}`)
  ok(kw[0].score > 0, '命中带正整数分数（可解释，不是"相似度"）', `score=${kw[0].score} hits=${JSON.stringify(kw[0].hits)}`)
  const kwTask = routeKeyword([REC_A, REC_B], { query: 'T-20260202-bbbb' })
  ok(kwTask.length === 1 && kwTask[0].id === REC_B.id, '★ 任务 id 精确命中（正文被截断时靠 `entity`/`refs` 仍然命中）', `命中=${JSON.stringify(ids(kwTask))}`)
  ok(routeKeyword([REC_A, REC_B], { query: 'zzz-not-there' }).length === 0, '查不到就是空（不硬凑）')
  ok(routeKeyword([REC_A, REC_B], { query: '' }).length === 0, '空查询 ⇒ 关键词路**返回空**（"最近 N 条"由时间路兜底，不是这里猜）')

  // ---- ② 切词规则（写死并被钉住）-----------------------------------------
  lines.push('')
  lines.push('【② 切词规则：ASCII 连词、中文单字 + 二元组（路径被切开）】')
  const tk = tokenize('FizzBuzz 记忆 lib/memory/bank.js')
  ok(tk.includes('fizzbuzz'), '整体小写 + ASCII 连词', `tokens=${JSON.stringify(tk)}`)
  ok(tk.includes('记') && tk.includes('记忆'), '中文既出单字也出二元组（单字太松、整段太紧）', `含"记"=${tk.includes('记')} 含"记忆"=${tk.includes('记忆')}`)
  ok(
    tk.includes('bank.js') && tk.includes('bank') && tk.includes('memory'),
    '路径**整词与分段都出**（`lib/memory/bank.js` ⇒ lib / memory / bank.js / bank / js）：整词管精确、分段管召回',
    `tokens=${JSON.stringify(tk)}`,
  )
  ok(JSON.stringify(tokenize('a b')) === JSON.stringify(tokenize('a b')), '切词是确定性的（同输入同输出）')

  // ---- ③ 时间路：窗口 / 任务 / recency ------------------------------------
  lines.push('')
  lines.push('【③ 时间路：时间窗 + 某张单 + recency 排序】')
  const tAll = routeTime([REC_A, REC_B])
  ok(JSON.stringify(ids(tAll)) === JSON.stringify([REC_B.id, REC_A.id]), '不给条件 ⇒ 新的在前（recency）', `顺序=${JSON.stringify(ids(tAll))}`)
  const tWin = routeTime([REC_A, REC_B], { since: '2026-01-15T00:00:00Z' })
  ok(JSON.stringify(ids(tWin)) === JSON.stringify([REC_B.id]), '时间窗 `since` 把更早的那条挡在外面', `命中=${JSON.stringify(ids(tWin))}`)
  const tUntil = routeTime([REC_A, REC_B], { until: '2026-01-15T00:00:00Z' })
  ok(JSON.stringify(ids(tUntil)) === JSON.stringify([REC_A.id]), '时间窗 `until` 同理（两端都是**含**）', `命中=${JSON.stringify(ids(tUntil))}`)
  const tTask = routeTime([REC_A, REC_B], { taskId: 'T-20260101-aaaa' })
  ok(JSON.stringify(ids(tTask)) === JSON.stringify([REC_A.id]), '按任务过滤只看那一张单', `命中=${JSON.stringify(ids(tTask))}`)
  const tieA = { ...REC_A, id: 'task:same-time-a' }
  const tieB = { ...REC_A, id: 'task:same-time-b' }
  ok(
    JSON.stringify(ids(routeTime([tieB, tieA]))) === JSON.stringify(ids(routeTime([tieA, tieB]))),
    '★ 同一时刻 ⇒ 用 id 兜底排序（**没有它就有"并列不定"，同一输入可能给出不同顺序**）',
    `两种入参顺序都得到 ${JSON.stringify(ids(routeTime([tieB, tieA])))}`,
  )

  // ---- ④ 实体路（R4/R5 的**规则**在 m2；这里只问"这一路取回取对了没有"）----
  lines.push('')
  lines.push('【④ 实体路：按主键精确命中（折叠规则本身的断言在 `m2-memory-alias-check.mjs`）】')
  const entTask = routeEntity([REC_B, REC_C], { query: 'T-20260202-bbbb' })
  ok(
    entTask.length === 2 && entTask.every((x) => x.routes === undefined),
    '★ 实体路按主键精确命中：同一张单的**任务条与交接物条都被捞到**',
    `命中=${JSON.stringify(ids(entTask))}`,
  )
  ok(
    JSON.stringify(ids(routeEntity([REC_B, REC_C], { query: '编写' }))) === JSON.stringify([REC_C.id]),
    '★ 用**中文别名**查询也能命中（`编写` 折成 `role:writer` ⇒ 命中写着 `role:编写` 的那条）',
    `命中=${JSON.stringify(ids(routeEntity([REC_B, REC_C], { query: '编写' })))}`,
  )
  ok(
    JSON.stringify(ids(routeEntity([REC_B, REC_C], { query: 'SRC\\ORDER.JS' }))) ===
      JSON.stringify([REC_C.id, REC_B.id]) &&
      routeEntity([REC_B, REC_C], { query: 'src/other.js' }).length === 0,
    '★ 路径实体：同一路径的另一种写法命中**两条**（同分按新的在前）；**别的路径一条都不命中**',
    `命中=${JSON.stringify(ids(routeEntity([REC_B, REC_C], { query: 'SRC\\ORDER.JS' })))}｜别的路径=${routeEntity([REC_B, REC_C], { query: 'src/other.js' }).length}`,
  )
  ok(
    routeEntity([REC_B, REC_C], { query: 'zzz-not-there' }).length === 0 &&
      routeEntity([REC_B, REC_C], { query: '' }).length === 0,
    '认不出实体 / 空查询 ⇒ 本路**返回空**（不做模糊召回，那是关键词路的活）',
  )
  ok(
    routeEntity([REC_B, REC_C], { query: 'zzz-not-there' }).length === 0 &&
      routeEntity([REC_B, REC_C], { query: '' }).length === 0,
    '认不出实体 / 空查询 ⇒ 返回空（不做模糊召回，那是关键词路的活）',
  )
  ok(
    JSON.stringify([...recordEntityKeys(REC_C)].sort()).includes('path:src/order.js') &&
      [...recordEntityKeys(REC_C)].length === 5,
    '★ 一条记忆的实体键集合：`entity[]` 与 `refs` 的同一批主键**折完只剩 5 个**（两处写法不重复计分）',
    `keys=${JSON.stringify([...recordEntityKeys(REC_C)].sort())}`,
  )

  // ---- ⑤ 合并：三路无重复 + 确定性 + 排序（R6/R7）-------------------------
  lines.push('')
  lines.push('【⑤ 合并：三路按 id 去重、确定性重排（R6/R7）】')
  const time = routeTime([REC_A, REC_B, REC_C])
  const keyword = routeKeyword([REC_A, REC_B, REC_C], { query: '订单幂等' })
  const entity = routeEntity([REC_A, REC_B, REC_C], { query: 'T-20260202-bbbb 编写' })
  ok(
    time.length === 3 && keyword.length >= 1 && entity.length === 2,
    '★ R7：三路**各自单独跑都能命中**（不是"合并了才有结果"）',
    `时间=${time.length} 关键词=${keyword.length} 实体=${entity.length}`,
  )
  const merged = mergeRoutes({ time, keyword, entity })
  const uniq = new Set(ids(merged))
  ok(uniq.size === merged.length, '★ R7：三路合并后**无重复 id**（同一张单被三路同时捞到也只出一条）', `条数=${merged.length} 唯一=${uniq.size}`)
  const triple = merged.find((m) => m.id === REC_C.id)
  ok(
    triple.routes.length === 3,
    '★ 三路都命中的那条**记下三条来路**（可解释：为什么它在前面）',
    `routes=${JSON.stringify(triple?.routes)} hits=${JSON.stringify(triple?.hits)}`,
  )
  ok(
    triple.hits.includes('task:t-20260202-bbbb') && triple.hits.includes('role:writer'),
    '★ `hits` 带上**命中的实体键**（实体路的可解释性：不是"相似度"，是哪个键命中了）',
    `hits=${JSON.stringify(triple.hits)}`,
  )
  ok(
    merged[0].id === REC_B.id && merged.find((m) => m.id === REC_A.id).id === REC_A.id,
    '★ 实体命中的排在**只被时间路**捞到的前面（实体 > 关键词 > 时间；REC_A 只有时间路）',
    `顺序=${JSON.stringify(ids(merged))}`,
  )
  const run1 = JSON.stringify(mergeRoutes({ time, keyword, entity }))
  const run2 = JSON.stringify(mergeRoutes({ time, keyword, entity }))
  ok(run1 === run2, '★ R6：同一查询跑两次 ⇒ **字节级相同**（确定性）', `长度=${run1.length} 两次相等=${run1 === run2}`)
  ok(
    JSON.stringify(mergeRoutes({ time, keyword, entity: [] })) === JSON.stringify(mergeRoutes({ time, keyword })) &&
      JSON.stringify(mergeRoutes({ entity })) === JSON.stringify(mergeRoutes({ entity, keyword: [], time: [] })),
    '某一路为空 / 缺席 ⇒ 合并规则不变（合并器不假设路数）',
  )
  ok(dedupeById([REC_A, REC_A, REC_B]).length === 2, '`dedupeById` 保序去重（同 id 只留先出现的）')

  // ---- ⑥ 真实档案端到端：临时 `.pipeline`（含坏行） ------------------------
  lines.push('')
  lines.push('【⑥ 端到端：真读 `.pipeline/` 档案（含一条坏行）⇒ 能答"这张单最后停在哪一步"】')
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m5-'))
  try {
    const pipe = join(root, '.pipeline')
    const tA = join(pipe, 'T-20260101-aaaa')
    const tB = join(pipe, 'T-20260202-bbbb')
    mkdirSync(join(tA, 'handoffs'), { recursive: true })
    mkdirSync(join(tB, 'handoffs'), { recursive: true })
    writeFileSync(
      join(tA, 'task.json'),
      JSON.stringify({
        id: 'T-20260101-aaaa',
        state: 'closed',
        updated_at: '2026-01-01T10:00:00Z',
        requirement: '写一个 fizzbuzz 函数',
        acceptance_from_user: ['3 的倍数返回 Fizz'],
        change_scope: [{ id: 's1', path: 'src/fizzbuzz.mjs' }],
        history: [{ event: 'close', at: '2026-01-01T10:00:00Z', by: 'main' }],
      }),
      'utf8',
    )
    writeFileSync(
      join(tA, 'handoffs', '001-dev_to_test.json'),
      JSON.stringify({
        handoff_id: '001-dev_to_test',
        task_id: 'T-20260101-aaaa',
        kind: 'dev_to_test',
        kind_zh: '编写→测试',
        from_role: 'writer',
        to_role: 'tester',
        created_at: '2026-01-01T09:00:00Z',
        artifact_version: 'v1',
        payload: { change_note: '实现 fizzbuzz，顺序敏感：先判 15', run_commands: ['node t.mjs'] },
      }),
      'utf8',
    )
    writeFileSync(join(tB, 'task.json'), '{ 这不是合法 JSON', 'utf8')

    const deps = { defineTool: (d) => d }
    const store = { projectRoot: root }
    const { memoryRecall } = buildMemoryTools({ deps, store, load: async () => null })

    const r = await memoryRecall.execute({ query: 'fizzbuzz', task_id: 'T-20260101-aaaa' }, {})
    ok(r.ok === true, '工具返回 ok:true', `ok=${r.ok}`)
    ok(r.count >= 2, '★ 该单的任务摘要 + 交接物摘要都被取回（**取回命中**）', `count=${r.count}\n${r.summary.split('\n').slice(-3).join('\n')}`)
    ok(r.summary.includes('已关闭') && r.summary.includes('最近动作：close'), '★★ 答得出"这张单最后停在哪一步"（状态 + 最近动作）', r.summary.split('\n').filter((l) => l.includes('最近动作')).join(' | '))
    ok(r.items.every((it) => it.text.length > 0 && it.id.length > 0), '返回的每条都带 id 与摘要正文（不是半条）')

    const empty = await memoryRecall.execute({ query: '不存在的词' }, {})
    ok(empty.ok === true && empty.count === 0, '★ 给了 query 但查不到 ⇒ 空切片 + ok:true（**不报错、也不拿最近若干条来凑数**）', `count=${empty.count}`)
    const recent = await memoryRecall.execute({}, {})
    ok(recent.ok === true && recent.count >= 1, '不传 query ⇒ 时间路兜底（"最近 N 条"），不报错', `count=${recent.count}`)
    ok(
      recent.source === 'archive' && recent.bank_records === 0,
      '★ 库不存在 ⇒ `source=archive`、库计数 0（**读库这条路只有 `readFile`**，库是长出来的不是建出来的）',
      `source=${recent.source} 库=${recent.bank_records}`,
    )
    ok(
      recent.skipped === 1 && recent.candidates === 2,
      '★ 坏 `task.json`（半份 JSON）**只跳过它自己并计数**，不整库丢弃（不传 task_id ⇒ 扫到它）',
      `skipped=${recent.skipped} 候选=${recent.candidates}（只给 task_id 时**根本不扫**别的目录 —— 所以那时 skipped=0，两种口径都对）`,
    )
    ok(!existsSync(memoryDir(root)), '★ E0 **不建记忆库**：整轮调用之后 `_memory/` 目录仍然不存在', `memoryDir=${memoryDir(root)} 存在=${existsSync(memoryDir(root))}`)
    ok(resolveBank(root).archiveDir === pipe, '库落点由 `bank.js` 一处给出（`<project_dir>/.pipeline`）', `archiveDir=${resolveBank(root).archiveDir}`)

    // 直接读库：坏行不丢别人
    const arch = await readArchive({ archiveDir: pipe })
    ok(arch.records.length === 2 && arch.skipped === 1, '`readArchive` 自己也是"跳过坏行并计数"的口径', `records=${arch.records.length} skipped=${arch.skipped}`)
    ok(arch.records.some((x) => x.kind === 'dev_to_test'), '交接物摘要进了候选（kind 就是交接物类型）', `kinds=${JSON.stringify(arch.records.map((x) => x.kind))}`)

    const { memoryRecall: stranded } = buildMemoryTools({
      deps,
      store: { projectRoot: '' },
      load: async () => null,
    })
    const noDir = await stranded.execute({}, {})
    ok(noDir.count === 0 && noDir.reason === 'NO_PROJECT_DIR', '取不到项目目录（工作区也为空）⇒ 空 + `reason`（不猜落点）', `reason=${noDir.reason}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  // ---- ⑦ 记忆库也是数据源（E2）：库 + 档案一起取，实体路跨两处都能折 --------
  lines.push('')
  lines.push('【⑦ E2：数据源 = 记忆库 + 既有档案（库不存在也不报错、实体路照样折叠）】')
  const root2 = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m5b-'))
  try {
    const pipe2 = join(root2, '.pipeline')
    mkdirSync(join(pipe2, 'T-20260101-aaaa'), { recursive: true })
    mkdirSync(join(pipe2, '_memory'), { recursive: true })
    writeFileSync(
      join(pipe2, 'T-20260101-aaaa', 'task.json'),
      JSON.stringify({
        id: 'T-20260101-aaaa',
        state: 'closed',
        updated_at: '2026-01-01T10:00:00Z',
        requirement: '写一个 fizzbuzz 函数',
        history: [{ event: 'close', at: '2026-01-01T10:00:00Z', by: 'main' }],
      }),
      'utf8',
    )
    // ★ 库里的一条：**故意用另一套写法**记同一个任务（大写 id + `./` 路径 + 中文角色）。
    writeFileSync(
      join(pipe2, '_memory', 'memory.jsonl'),
      `${JSON.stringify({
        id: 'tool:pipeline_close|T-20260101-AAAA|closed',
        at: '2026-01-02T00:00:00Z',
        kind: 'tool',
        scope: 'project',
        text: '工具 pipeline_close 完成（任务 T-20260101-AAAA）：已关闭，放行依据 001-review_verdict',
        entity: ['task:T-20260101-AAAA', 'path:./SRC/FizzBuzz.MJS', 'role:主对话', 'state:closed'],
        refs: {
          task_id: 'T-20260101-AAAA',
          state: 'closed',
          state_label: '已关闭',
          paths: ['SRC\\fizzbuzz.mjs'],
          handoff: '001-review_verdict',
          artifact_version: 'v1',
          roles: ['主对话'],
        },
      })}\n{ 这半行是坏的\n`,
      'utf8',
    )

    const deps = { defineTool: (d) => d }
    const { memoryRecall } = buildMemoryTools({ deps, store: { projectRoot: root2 }, load: async () => null })

    const small = await memoryRecall.execute({ query: 'SRC\\FIZZBUZZ.MJS' }, {})
    ok(
      small.source === 'bank+archive' && small.bank_records === 1 && small.bank_skipped === 1,
      '★★ E2：数据源 = **记忆库 + 档案**（`source=bank+archive`），库里的**坏行**跳过并计数',
      `source=${small.source} 库=${small.bank_records} 坏行=${small.bank_skipped} 候选=${small.candidates}`,
    )
    ok(
      small.items.some((it) => it.id.includes('pipeline_close') && it.routes.includes('entity')),
      '★★ 实体路**跨库与档案都能折**：用 `SRC\\FIZZBUZZ.MJS` 查，命中库里写着 `./SRC/FizzBuzz.MJS` 的那条',
      `命中=${JSON.stringify(small.items.map((x) => x.id))} routes=${JSON.stringify(small.items.map((x) => x.routes))}`,
    )
    const byTaskSpelling = await memoryRecall.execute({ query: 'T-20260101-AAAA' }, {})
    ok(
      byTaskSpelling.count === 2,
      '★ 同一个任务 id 的**大小写两种写法**都要捞到（库里那条 + 档案里那条）—— 折叠在取回路径上真的生效',
      `count=${byTaskSpelling.count} ids=${JSON.stringify(byTaskSpelling.items.map((x) => x.id))}`,
    )
    const before = readFileSync(memoryFile(root2), 'utf8')
    await memoryRecall.execute({ query: 'fizzbuzz' }, {})
    ok(
      readFileSync(memoryFile(root2), 'utf8') === before,
      '★ 取回是**只读**的：跑完一轮 `recall`，库文件**一个字节都没变**（E0 的"零写盘"在 E2 一点没变）',
      `库文件=${memoryFile(root2)}｜${before.length} 字节`,
    )
  } finally {
    rmSync(root2, { recursive: true, force: true })
  }

  // ---- ⑧ 判据自检：这套断言**真的会红** -----------------------------------
  lines.push('')
  lines.push('【⑧ 判据自检：把它们打到"故意做坏"的输入上，必须变红】')
  const brokenKw = routeKeyword([{ ...REC_A, text: '与查询无关的正文', entity: [], refs: { ...REC_A.refs, task_id: '', paths: [], roles: [] } }], { query: 'fizzbuzz' })
  ok(brokenKw.length === 0, '★ 把正文与主键里的关键词抹掉 ⇒ 关键词路判它不命中（证明 ① 不是恒真）', `命中=${brokenKw.length}`)
  const stripEntity = routeEntity([{ ...REC_C, entity: [], refs: { ...REC_C.refs, task_id: '', paths: [], roles: [], handoff: '' } }], { query: 'T-20260202-bbbb 编写' })
  ok(stripEntity.length === 0, '★ 把 `entity[]` 与 `refs` 里的主键抹掉 ⇒ 实体路判它不命中（证明 ④ 不是恒真）', `命中=${stripEntity.length}`)
  const brokenMerge = mergeRoutes({ time, keyword: [...keyword, { ...REC_B }], entity })
  ok(new Set(ids(brokenMerge)).size === brokenMerge.length, '★ 故意把同一条喂两遍 ⇒ 去重仍然只出一条（证明 ⑤ 不是恒真）', `条数=${brokenMerge.length}`)
  const shuffled = [...time].reverse()
  const m1 = JSON.stringify(mergeRoutes({ time: shuffled, keyword: [] }))
  const m2 = JSON.stringify(mergeRoutes({ time: [...shuffled], keyword: [] }))
  ok(m1 === m2, '★ 打乱入参顺序后两次仍然相同（确定性来自**排序键**，不是来自输入顺序）', `相等=${m1 === m2}`)

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`m5 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))
  return { passed, total: passed + failed, text: lines.join('\n') }
}

/**
 * 聚合跑入口（`tests/run-all.mjs` 登记用）。断言、计数与"直接跑"**同一条路径**，
 * 区别只有两条：不 `process.exit`、把原文收进 `text`。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runM5MemoryRouteCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ m5 运行失败（异常）：${err?.stack ?? err}`)
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('m5-memory-route-check.mjs')) {
  const r = await runM5MemoryRouteCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
