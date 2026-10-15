/**
 * m7 · 记忆 · **活文档**：渲染是纯函数（R10）、写盘幂等（R11）、**触发点正确**
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/m7-memory-live-doc-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * ---------------------------------------------------------------------------
 * 本文件只测三件事（`CONVENTIONS.md` §3.2 的"一测试一文件"）
 * ---------------------------------------------------------------------------
 *   ① **R10 渲染纯函数**：同输入 ⇒ 同输出；输入顺序不影响输出；空库有占位。
 *   ② **R11 写盘幂等**：内容不变 ⇒ **一次写盘都不发生**；变了才写。
 *   ③ **触发点正确**（设计 `06-分阶段.md` 的 E3 把这条固化下来）：
 *      · **状态迁移**（`lib/store/lifecycle.js` 的 `transition()` 出口）会落记忆 + 更新活文档；
 *      · **关单**（`lib/store/review.js` 的 `close()`）那条路径**确实接了**（不接则永不更新）；
 *      · **普通工具调用**（`tools/post-execute` 那条 retain 缝）**不会**动活文档；
 *      · 总开关关掉 ⇒ 库与活文档**一个字节都不改**（判据 R13 在第二个写点上的形态）。
 *
 * ★ "没写"这件事**用计数判**（假盘的写次数 / 真盘的 mtime），不靠"看起来一样"。
 * ★ 项目根一律是自造的临时目录：不读、不写任何活体真单。
 *
 * @module dsh-pipeline/tests/m7-memory-live-doc-check
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { liveDocFile, memoryFile } from '../lib/memory/bank.js'
import { createMemoryRetainHook } from '../lib/memory/retain-hook.js'
import { LIVE_DOC_EMPTY, renderLiveDoc, summarizeRecords } from '../lib/memory/live-doc-render.js'
import {
  LIVE_DOC_SURFACE,
  ensureLiveDoc,
  liveDocAllowed,
  refreshLiveDoc,
  refreshLiveDocForTask,
} from '../lib/memory/live-doc-write.js'
import { hostTurnOutline, normalizeOutline } from '../lib/memory/reflect-source.js'
import { surfaceAllowed } from '../lib/switch/gate.js'
import { createTaskStore } from '../lib/store.js'

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

const ROOT = 'C:\\proj'
const DOC = join(ROOT, '.pipeline', '_memory', 'MEMORY.md')

/** 三条记忆（两条同刻、三种 kind —— 专门用来钉"同刻也有固定先后"）。 */
const REC = [
  {
    id: 'task:T-1',
    at: '2026-01-01T00:00:00Z',
    kind: 'task',
    scope: 'project',
    text: '任务 T-1｜已关闭（closed）',
    entity: ['task:t-1', 'state:closed'],
    refs: { task_id: 'T-1', state: 'closed', state_label: '已关闭', paths: [], handoff: '', artifact_version: '', roles: [] },
  },
  {
    id: 'transition:T-1:cancel:2026-01-02T00:00:00Z',
    at: '2026-01-02T00:00:00Z',
    kind: 'transition',
    scope: 'project',
    text: '任务 T-1：待分配 → 已取消（事件 cancel）',
    entity: ['task:t-1', 'state:cancelled'],
    refs: { task_id: 'T-1', state: 'cancelled', state_label: '已取消', paths: [], handoff: '', artifact_version: '', roles: [] },
  },
  {
    id: 'handoff:T-1:001-dev_to_test',
    at: '2026-01-02T00:00:00Z',
    kind: 'dev_to_test',
    scope: 'project',
    text: '交接物 001-dev_to_test（writer → tester）',
    entity: ['task:t-1', 'handoff:001-dev_to_test', 'role:writer'],
    refs: { task_id: 'T-1', state: '', state_label: '', paths: ['src/a.js'], handoff: '001-dev_to_test', artifact_version: 'v1', roles: ['writer'] },
  },
]

/**
 * 文件系统缝：一个**内存里的假盘**（判据要"写了几次"这个整数，真盘的 mtime 会被时钟精度骗）。
 * 返回体上带 `disk` / `writes` —— "没写"就是 `writes` 没长。
 */
function fakeFs(seed = null) {
  const disk = new Map()
  if (seed !== null) disk.set(DOC, seed)
  // ★ 计数用**闭包里的盒子**，不用 `this`：实现侧会把 fs 缝**摊开**成新对象
  //   （`{...默认, ...opts.fs}`），`this` 那时指向的是那个新对象 —— 数就丢了。
  const box = { disk, writes: 0 }
  box.readFile = async (file) => {
    if (!disk.has(file)) {
      const err = new Error(`ENOENT: ${file}`)
      err.code = 'ENOENT'
      throw err
    }
    return disk.get(file)
  }
  box.writeFile = async (file, text) => {
    box.writes += 1
    disk.set(file, text)
  }
  box.mkdir = async () => {}
  box.stat = async (file) => {
    if (!disk.has(file)) throw new Error(`ENOENT: ${file}`)
    return { mtimeMs: 1 }
  }
  return box
}

/** 真盘上的一份快照（"没变"= 内容与 mtime 都一样）。 */
function snap(file) {
  const exists = existsSync(file)
  return { exists, text: exists ? readFileSync(file, 'utf8') : '', ms: exists ? statSync(file).mtimeMs : -1 }
}

async function main() {
  lines.push('='.repeat(78))
  lines.push('m7 · 记忆活文档：渲染纯函数（R10）+ 写盘幂等（R11）+ 触发点正确（E3）')
  lines.push('='.repeat(78))

  // ---- ① 渲染是纯函数（R10）----------------------------------------------
  lines.push('')
  lines.push('【① R10：渲染是纯函数 —— 同输入同输出、顺序无关、空库有占位】')
  const once = renderLiveDoc(REC)
  ok(once === renderLiveDoc(REC), '★ 同输入跑两次 ⇒ **字节级相同**', `长度=${once.length}`)
  ok(renderLiveDoc([...REC].reverse()) === once, '★ 输入顺序打乱 ⇒ 输出**一模一样**（排序键在函数里，不靠入参顺序）', '')
  ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(once), '★ 正文里**没有"生成时间"这类毫秒级字段**（有它就不可能幂等 —— 判据 R11 会当场失效）', '')
  const empty = renderLiveDoc([])
  ok(empty.includes(LIVE_DOC_EMPTY), '★ 空库 ⇒ 渲染出占位（不是空文件）', LIVE_DOC_EMPTY)
  ok(renderLiveDoc(null) === empty && renderLiveDoc(undefined) === empty, '非数组输入不抛（按空库算）', '')
  const st = summarizeRecords(REC)
  ok(
    st.count === 3 && st.kinds.length === 3 && st.first === '2026-01-01T00:00:00Z' && st.last === '2026-01-02T00:00:00Z',
    '★ 统计由同一份数据算出（条数 / 类型 / 时间范围）',
    `count=${st.count} kinds=${JSON.stringify(st.kinds.map((k) => `${k.kind}:${k.count}`))}`,
  )
  ok(once.includes('## 按任务') && once.includes('T-1：3 条'), '★ "按任务"把同一张单的记忆聚成一行（活文档的用处就在这里）', '')
  const withOutline = renderLiveDoc(REC, { outline: normalizeOutline({ turns: [{ turn: 3, prompt: '继续', response: '好的' }] }) })
  ok(withOutline.includes('轮 3') && withOutline.includes('用户：继续'), '★ 有会话投影 ⇒ 写进"最近几轮"那一段（reflect 的输入真的到了文档里）', '')
  ok(
    renderLiveDoc(REC, { outline: normalizeOutline(null), outlineNote: '宿主没有投影' }).includes('宿主没有投影'),
    '★ 没有投影 ⇒ **如实写一句为什么**（不是静默留白）',
    '',
  )

  // ---- ② 写盘幂等（R11）--------------------------------------------------
  lines.push('')
  lines.push('【② R11：写盘幂等 —— 内容不变就**一次写盘都不发生**】')
  const fs1 = fakeFs()
  const first = await refreshLiveDoc(ROOT, { records: REC, fs: fs1 })
  ok(first.written === true && first.reason === 'REBUILT' && fs1.writes === 1, '★ 第一次：写下去（`REBUILT`，写盘 1 次）', `bytes=${first.bytes} writes=${fs1.writes}`)
  ok(!existsSync(ROOT), '假盘写的是**内存**，真实磁盘上这个项目目录根本不存在（本套不碰真目录）', `existsSync(${ROOT})=${existsSync(ROOT)}`)
  const fs2 = fakeFs(fs1.disk.get(DOC))
  const second = await refreshLiveDoc(ROOT, { records: REC, fs: fs2 })
  ok(
    second.written === false && second.reason === 'UNCHANGED' && fs2.writes === 0,
    '★★ 第二次（同内容）⇒ **一次写盘都没发生**（"重写一份一样的"不算幂等）',
    `written=${second.written} reason=${second.reason} writes=${fs2.writes}`,
  )
  const changed = [...REC, { ...REC[0], id: 'task:T-2', text: '任务 T-2｜开发中（developing）', refs: { ...REC[0].refs, task_id: 'T-2', state: 'developing', state_label: '开发中' } }]
  const fs3 = fakeFs(fs1.disk.get(DOC))
  const third = await refreshLiveDoc(ROOT, { records: changed, fs: fs3 })
  ok(third.written === true && third.changed === true && fs3.writes === 1, '★ 内容真变了 ⇒ 照写（幂等不许变成"再也不更新"）', `reason=${third.reason} writes=${fs3.writes}`)
  const fs4 = fakeFs()
  const emptyWrite = await refreshLiveDoc(ROOT, { records: [], fs: fs4 })
  ok(emptyWrite.written === false && emptyWrite.reason === 'EMPTY_BANK' && fs4.writes === 0, '★ 空库 ⇒ **不写空壳**（也不建目录）', `reason=${emptyWrite.reason}`)
  const noDir = await refreshLiveDoc('', { records: REC, fs: fakeFs() })
  ok(noDir.written === false && noDir.reason === 'NO_PROJECT_DIR', '★ 取不到项目目录 ⇒ 不猜落点、不写', `reason=${noDir.reason}`)
  const broken = await refreshLiveDoc(ROOT, { records: REC, fs: { ...fakeFs(), writeFile: async () => { throw new Error('EACCES: 只读') } } })
  ok(broken.ok === false && broken.written === false && String(broken.reason).startsWith('FAILED'), '★ 写失败 ⇒ **绝不抛**，只如实说没写成（与判据 R3 同一条纪律）', `reason=${broken.reason}`)

  // ---- ③ 触发点正确（E3 固化下来的那一条）--------------------------------
  lines.push('')
  lines.push('【③ 触发点：状态迁移**会**更新；普通工具调用**不会**；关单那条路径确实接了】')
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m7-'))
  try {
    const sw = { isOn: () => true }
    const store = createTaskStore({ projectRoot: root, artifactDirName: '.pipeline', maxReworkPerLeg: 2, switchRef: () => sw })
    const doc = liveDocFile(root)
    const bank = memoryFile(root)

    const opened = await store.open({ id: 'T-M7-A', requirement: '夹具：活文档触发点', actorRole: 'main', actorAgentId: 'main-s' })
    ok(opened.ok === true, '夹具：开单成功（pending）', opened.task?.state ?? opened.error)
    ok(!existsSync(doc), '★ 开单**本身不写活文档**（它不是"语义上完整的时刻"）', `docExists=${existsSync(doc)}`)

    // —— ③a 普通工具调用：retain 缝照记，但**活文档一动不动** ——
    const hook = createMemoryRetainHook({
      ask: () => true,
      seatOf: () => ({ role: 'writer', taskId: 'T-M7-A', seat: 'writer#1' }),
      getTask: () => ({ id: 'T-M7-A', project_dir: root }),
      projectDir: root,
      nowIso: () => '2026-03-01T00:00:00Z',
    })
    const beforeHook = snap(doc)
    const passthrough = await hook(
      { name: 'pipeline_handoff', arguments: { task_id: 'T-M7-A' }, agent: { id: 'seat-1' } },
      { ok: true, handoff_id: 'HO-1', summary: '已提交交接物' },
      async () => 'ORIGINAL',
    )
    ok(passthrough === 'ORIGINAL', '★ retain 缝是**观察者**：返回值原样透传', String(passthrough))
    ok(existsSync(bank), '★ retain 缝**真的写了库**（否则下面"没动活文档"就不是判据）', bank)
    const afterHook = snap(doc)
    ok(
      afterHook.exists === beforeHook.exists && afterHook.text === beforeHook.text && afterHook.ms === beforeHook.ms,
      '★★ **普通工具调用不更新活文档**（库长了、`MEMORY.md` 一个字节 + mtime 都没动）—— 这就是"不许挂 post-execute"的可执行形态',
      `doc exists=${afterHook.exists}｜库行数=${readFileSync(bank, 'utf8').split('\n').filter((l) => l.length > 0).length}`,
    )

    // —— ③b 状态迁移：落一条迁移记忆 + 活文档跟着更新 ——
    const tr = await store.transition({ taskId: 'T-M7-A', event: 'cancel', actorRole: 'human', actorAgentId: 'human-s', note: '夹具' })
    ok(tr.ok === true, '夹具：状态迁移成功（cancel）', `${tr.from} → ${tr.to}`)
    const bankLines = readFileSync(bank, 'utf8').split('\n').filter((l) => l.length > 0)
    ok(
      bankLines.some((l) => l.includes('"kind":"transition"')),
      '★ E3：迁移出口**真的落了一条 `kind:transition` 的记忆**（E1 时明写"未接"，这一步补上了）',
      `库行数=${bankLines.length}`,
    )
    const afterTr = snap(doc)
    ok(afterTr.exists && afterTr.text.includes('T-M7-A'), '★★ **状态迁移会更新活文档**（`MEMORY.md` 出现、且带上了这张单）', `bytes=${afterTr.text.length}`)
    ok(
      afterTr.text.includes('已取消') && afterTr.text.includes('会话投影'),
      '★ 文档里读得出"最后停在哪一步"（状态）+ 会话投影那一段如实交代（本套没有宿主 ctx ⇒ 拿不到）',
      afterTr.text.split('\n').filter((l) => l.includes('已取消') || l.includes('会话投影')).slice(0, 2).join(' | '),
    )

    // —— ③c 幂等（真实路径）：同一份库再触发一次 ⇒ 不重写 ——
    const beforeAgain = snap(doc)
    const again = await refreshLiveDocForTask({ project_dir: root }, { swOf: () => sw })
    const afterAgain = snap(doc)
    ok(
      again.written === false && again.reason === 'UNCHANGED' && afterAgain.ms === beforeAgain.ms,
      '★ R11（真盘）：同一份库再触发一次 ⇒ **不重写**（mtime 一个数都没变）',
      `reason=${again.reason}｜mtime ${beforeAgain.ms} → ${afterAgain.ms}`,
    )

    // —— ③d 关单那条路径**确实接了**（源码级判据：调用必须在 close() 体内）——
    const reviewSrc = readFileSync(new URL('../lib/store/review.js', import.meta.url), 'utf8')
    const from = reviewSrc.indexOf('async close(input) {')
    const to = reviewSrc.indexOf('async registerArtifact(input) {')
    const closeBody = from >= 0 && to > from ? reviewSrc.slice(from, to) : ''
    // ★ 判据要的是**真的调了**：`^\s*await refreshLiveDocForTask\(` 排除了注释掉的行
    //   （只查子串的话，把调用注释掉也能骗过这条判据 —— 那种判据等于没有）。
    const closeCalls = closeBody.split('\n').filter((l) => /^\s*await refreshLiveDocForTask\(/.test(l))
    ok(
      closeCalls.length === 1,
      '★★ **关单触发点接上了**（`lib/store/review.js` 的 `close()` 体内**真的 await 了** `refreshLiveDocForTask`）—— 不接则活文档永不更新',
      `close() 体长度=${closeBody.length}｜真的调了=${closeCalls.length} 次`,
    )
    const lifeSrc = readFileSync(new URL('../lib/store/lifecycle.js', import.meta.url), 'utf8')
    ok(
      lifeSrc.includes('appendTransition(') && lifeSrc.includes('refreshLiveDocForTask('),
      '★ 迁移出口同样两件都接了（落记忆 + 更新活文档）',
      `appendTransition=${lifeSrc.includes('appendTransition(')} refreshLiveDoc=${lifeSrc.includes('refreshLiveDocForTask(')}`,
    )

    // —— ③e 总开关关掉 ⇒ 库与活文档一个字节都不改 ——
    const offSw = { isOn: () => false }
    const offStore = createTaskStore({ projectRoot: root, artifactDirName: '.pipeline', maxReworkPerLeg: 2, switchRef: () => offSw })
    await offStore.open({ id: 'T-M7-B', requirement: '夹具：off 下的触发点', actorRole: 'main', actorAgentId: 'main-s' })
    const beforeBank = snap(bank)
    const beforeOffDoc = snap(doc)
    const off1 = await refreshLiveDocForTask({ project_dir: root }, { swOf: () => offSw })
    const tr2 = await offStore.transition({ taskId: 'T-M7-B', event: 'cancel', actorRole: 'human', actorAgentId: 'human-s', note: '夹具' })
    const afterBank = snap(bank)
    const afterOffDoc = snap(doc)
    ok(off1.reason === 'SWITCH_OFF' && off1.written === false, '★ off ⇒ `refreshLiveDocForTask` 直接返回（连读都不读）', `reason=${off1.reason}`)
    ok(tr2.ok === true, '★ off 下**状态迁移本身照旧成功**（记忆是副作用，不许反过来拦住状态机）', `${tr2.from} → ${tr2.to}`)
    ok(
      afterBank.text === beforeBank.text && afterOffDoc.text === beforeOffDoc.text && afterOffDoc.ms === beforeOffDoc.ms,
      '★★ off 下跑一次真实迁移 ⇒ **记忆库与活文档一个字节都没变**（判据 R13 在这一步补上的两个写点上的形态）',
      `库 ${beforeBank.text.length} → ${afterBank.text.length} 字节｜文档 ${beforeOffDoc.text.length} → ${afterOffDoc.text.length}`,
    )
    ok(liveDocAllowed(offSw) === false && liveDocAllowed(sw) === true, `面 \`${LIVE_DOC_SURFACE}\` 开/关分别 true/false`, `开=${liveDocAllowed(sw)} 关=${liveDocAllowed(offSw)}`)
    ok(surfaceAllowed(null, LIVE_DOC_SURFACE) === true, '没给开关（自测替身）⇒ 按"开"（与 `readSwitchState` 的既有口径一致）', '')

    // —— ③f 读时惰性兜底（设计 04 §3.5）——
    const records = readFileSync(bank, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l))
    rmSync(doc, { force: true })
    const lazy = await ensureLiveDoc(root, { records, bankFile: bank, swOf: () => sw })
    ok(lazy.written === true && existsSync(doc), '★★ **读时惰性兜底**：删掉 `MEMORY.md` 之后重建得回来（"漏了一个触发点也不会长期陈旧"）', `reason=${lazy.reason}`)
    const fresh = await ensureLiveDoc(root, { records, bankFile: bank, swOf: () => sw })
    ok(fresh.written === false && fresh.reason === 'FRESH', '★ 文档比库新 ⇒ 跳过（`FRESH`，省一次渲染）', `reason=${fresh.reason}`)

    // —— ③g 会话投影：拿不到就如实降级（不新增服务依赖）——
    const noCtx = await hostTurnOutline({ ctx: null }, 'x')
    ok(noCtx.ok === false && noCtx.via === 'unavailable', '★ 没有 ctx ⇒ `unavailable`（不抛、不猜）', `note=${noCtx.note}`)
    const fakeCtx = {
      agents: { get: () => ({ session: { id: 's1' } }) },
      sessionProjections: { snapshot: async () => ({ values: { turnOutline: { turns: [{ turn: 1, prompt: 'a', response: 'b' }] } } }) },
    }
    const got = await hostTurnOutline({ ctx: fakeCtx }, 'seat-1')
    ok(got.ok === true && got.via === 'sessionProjections.snapshot' && got.outline.turns === 1, '★ 有投影服务 ⇒ 取到（并如实报 `via`）', `via=${got.via}`)
    const cacheCtx = { sessionProjectionCache: { cachedSnapshot: async () => ({ rows: { turnOutline: { turns: [{ turn: 1, prompt: 'a', response: 'b' }] } } }) } }
    ok((await hostTurnOutline({ ctx: cacheCtx }, 'seat-1')).via === 'sessionProjectionCache.cachedSnapshot', '★ 只有冷读缓存那条路时也走得通（`02` §4.1 的第二条）', '')
    const throwing = await hostTurnOutline({ ctx: { agents: { get: () => { throw new Error('boom') } } } }, 'seat-1')
    ok(throwing.ok === false && throwing.via === 'unavailable', '★ 宿主读投影抛错 ⇒ 降级（绝不把触发它的调用带崩）', `note=${throwing.note}`)
    ok(normalizeOutline({ turns: [1, null, { turn: 'x', prompt: 42 }] }).items.length === 3, '投影里单条形状不对 ⇒ **仍然占一行**（丢一条不如留个占位），且不抛', '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`m7 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))
  return { passed, total: passed + failed, text: lines.join('\n') }
}

/**
 * 聚合跑入口（`tests/run-all.mjs` 登记用）。断言、计数与"直接跑"**同一条路径**，
 * 区别只有两条：不 `process.exit`、把原文收进 `text`。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runM7MemoryLiveDocCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ m7 运行失败（异常）：${err?.stack ?? err}`)
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('m7-memory-live-doc-check.mjs')) {
  const r = await runM7MemoryLiveDocCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
