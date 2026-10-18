// 文件规模提醒（S1–S4）：150/300/400 三档由**程序自动发起**询问；去重、过滤、注入形状。
/**
 * dsh-pipeline · 文件规模提醒回归
 * ============================================================================
 *     node tests/size-reminder-check.mjs
 *
 * 钉住用户需求（2026-10-18 逐字）：
 *   · >150 行 ⇒ 第 1 次询问：「有必要写这么大吗？是顺手写在一起了还是功能需求？」
 *   · >300 行 ⇒ 第 2 次询问（同一句，并要一句话说明"为什么必须在一起"）
 *   · ≥400 行 ⇒ 第 3 次询问：「一定这个写法吗？有没有更优的写法？」并要求**实际调用**
 *     `web_search` / `web_fetch`（Search / Fetch 接口）查更优写法
 *
 * 以及三条纪律：同文件同档只问一次 / 只对写类工具与代码文件 / 不改工具结果、不抛。
 *
 * @module dsh-pipeline/tests/size-reminder-check
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  createSizeReminder,
  isWatchedTool,
  levelFor,
  messageFor,
  normalizeConfig,
  shouldWatchPath,
  shortPath,
  writtenPathOf,
} from '../lib/size-reminder.js'
import { createSizeAskHook, createSizeWatchHook } from '../lib/guard/hook-size.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TITLE = 'dsh-pipeline · 文件规模提醒（150/300/400 三档 · 程序自动发起询问）'

/** 生成 N 行的临时文件，返回路径。 */
function makeFile(dir, name, lines) {
  const p = join(dir, name)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, Array.from({ length: lines }, (_, i) => `// line ${i + 1}`).join('\n') + '\n', 'utf8')
  return p
}

function renderReport(items) {
  const lines = ['='.repeat(78), TITLE, '='.repeat(78)]
  for (const item of items) {
    lines.push(`  ${item.pass ? '✓' : '✗'} ${item.name}`)
    if (item.detail !== '') lines.push(`      ${item.detail.split('\n').join('\n      ')}`)
  }
  const passed = items.filter((i) => i.pass).length
  lines.push('', '='.repeat(78), `总计：${passed}/${items.length} 通过`, '='.repeat(78))
  return { passed, total: items.length, text: lines.join('\n') }
}

export async function runSizeReminderCheck() {
  const items = []
  const add = (name, pass, detail) => items.push({ name, pass: pass === true, detail: String(detail ?? '') })
  const root = mkdtempSync(join(tmpdir(), 'dsh-size-reminder-'))
  try {
    const f200 = makeFile(root, 'a/mid.js', 200)
    const f350 = makeFile(root, 'a/big.js', 350)
    const f420 = makeFile(root, 'a/huge.js', 420)
    const f90 = makeFile(root, 'a/small.js', 90)

    // ---- A. 阈值 ----
    add(
      'A1 阈值：150 不提醒 / 151 第一次 / 300 第二次 / 301 第二次 / 400 第三次（>150、>300、≥400）',
      levelFor(150) === 0 && levelFor(151) === 1 && levelFor(300) === 1 && levelFor(299) === 1 && levelFor(301) === 2 && levelFor(399) === 2 && levelFor(400) === 3,
      `150→${levelFor(150)} 151→${levelFor(151)} 300→${levelFor(300)} 400→${levelFor(400)}`,
    )
    add(
      'A2 配置可覆盖阈值（firstLines/secondLines/thirdLines）',
      levelFor(120, { firstLines: 100, secondLines: 200, thirdLines: 300 }) === 1 &&
        levelFor(250, { firstLines: 100, secondLines: 200, thirdLines: 300 }) === 2 &&
        levelFor(300, { firstLines: 100, secondLines: 200, thirdLines: 300 }) === 3,
      '100/200/300 的自定义阈值生效',
    )
    add('A3 非法行数（0/负数/NaN）不提醒', levelFor(0) === 0 && levelFor(-5) === 0 && levelFor(Number.NaN) === 0, 'levelFor(0/-5/NaN)=0')

    // ---- B. 文案（用户原话必须出现） ----
    const m1 = messageFor({ file: f200, lines: 200, level: 1 })
    const m2 = messageFor({ file: f350, lines: 350, level: 2 })
    const m3 = messageFor({ file: f420, lines: 420, level: 3 })
    add(
      'B1 第 1 次询问含「有必要写这么大吗」「顺手」「功能需求」',
      m1.includes('有必要写这么大吗') && m1.includes('顺手') && m1.includes('功能需求') && m1.includes('1/3'),
      `含关键词；长度 ${m1.length}`,
    )
    add('B2 第 2 次询问是"再问一次"同一句', m2.includes('2/3') && m2.includes('再问一次') && m2.includes('有必要写这么大吗'), `长度 ${m2.length}`)
    add(
      'B3 第 3 次询问要求「一定这个写法吗」「更优的写法」并点名 web_search / web_fetch',
      m3.includes('3/3') && m3.includes('一定') && m3.includes('更优') && m3.includes('web_search') && m3.includes('web_fetch'),
      `长度 ${m3.length}`,
    )
    add('B4 文案里不出现绝对路径（只给短路径）', !m1.includes(root) && shortPath(f200) === 'a/mid.js', shortPath(f200))

    // ---- C. 过滤（只看写类工具 + 代码文件） ----
    add(
      'C1 只有写类工具被观察（read / grep / bash 不提醒）',
      isWatchedTool('write') && isWatchedTool('edit') && isWatchedTool('apply_patch') && !isWatchedTool('read') && !isWatchedTool('grep') && !isWatchedTool('bash'),
      'write/edit/apply_patch ✓；read/grep/bash ✗',
    )
    add(
      'C2 只提醒代码文件（node_modules / .json / 生成目录跳过）',
      shouldWatchPath('src/a.js') && shouldWatchPath('lib/x.mjs') && !shouldWatchPath('node_modules/p/a.js') && !shouldWatchPath('data.json') && !shouldWatchPath('dist/app.js'),
      'src/a.js ✓；node_modules/… ✗；data.json ✗；dist/… ✗',
    )
    add('C3 相对路径按 cwd 解析成绝对路径', writtenPathOf({ path: 'src/a.js' }, root) === join(root, 'src/a.js') && writtenPathOf({ file_path: f90 }, root) === f90, 'path / file_path 两个键都认')

    // ---- D. 去重 / 升级 / 上限 ----
    const store = createSizeReminder({ enabled: true })
    store.note({ agentId: 'agent-1', files: [f200] })
    store.note({ agentId: 'agent-1', files: [f200] })
    const first = store.take('agent-1')
    add('D1 同一文件同一档只问一次（重复 note 不重复排队）', first.length === 1 && first[0].level === 1, `taken=${first.length}`)
    store.note({ agentId: 'agent-1', files: [f350] })
    const second = store.take('agent-1')
    add('D2 文件长大到下一档会再问一次（1→2 档升级）', second.length === 1 && second[0].level === 2, `level=${second[0]?.level}`)
    store.note({ agentId: 'agent-2', files: [f420, f350, f200] })
    const batch = store.take('agent-2')
    add('D3 每次开步最多投 2 条（maxAsksPerStep），且从高档开始', batch.length === 2 && batch[0].level === 3 && batch[1].level === 2, `levels=${batch.map((x) => x.level).join(',')}`)
    store.note({ agentId: 'agent-3', files: [f90] })
    add('D4 低于阈值不排队', store.take('agent-3').length === 0, 'agent-3 无待问')
    const off = createSizeReminder({ enabled: false })
    off.note({ agentId: 'agent-1', files: [f420] })
    add('D5 配置 enabled:false ⇒ 整条提醒链不做事', off.take('agent-1').length === 0, 'no pending')

    // ---- E. 两条缝的接线（post-execute 记 → pre-step 注入用户消息） ----
    const seamStore = createSizeReminder({ enabled: true })
    const seat = { role: 'writer', taskId: 'T-1', seat: '1' }
    const svc = { ask: () => true, seatOf: () => seat, sizeReminder: seamStore }
    const watch = createSizeWatchHook(svc)
    const askHook = createSizeAskHook(svc)
    const nextResult = { kind: 'enter', messages: [] }
    const watchOut = await watch({ agent: { id: 'agent-1' }, name: 'write', arguments: { path: f200 } }, null, async () => nextResult)
    add('E1 post-execute 观察缝不改结果（原样 next() 返回值）', watchOut === nextResult, 'watch 返回值 = next() 的返回值')
    const entered = await askHook({ agent: { id: 'agent-1' } }, async () => nextResult)
    const injected = Array.isArray(entered?.messages) ? entered.messages : []
    add(
      'E2 pre-step 注入一条用户消息（程序自动发起询问），形状带 id/role/content/source.form',
      injected.length === 1 && injected[0].role === 'user' && injected[0].source?.form === 'file-size-reminder' && typeof injected[0].id === 'string' && injected[0].content?.[0]?.text.includes('有必要写这么大吗'),
      `messages=${injected.length} form=${injected[0]?.source?.form}`,
    )
    const entered2 = await askHook({ agent: { id: 'agent-1' } }, async () => nextResult)
    add('E3 同一档不会每一步都再问（注入后队列清空）', (entered2?.messages ?? []).length === 0, '第二次开步无消息')
    const readOut = await watch({ agent: { id: 'agent-1' }, name: 'read', arguments: { path: f420 } }, null, async () => nextResult)
    add('E4 读类工具不触发提醒', readOut === nextResult && seamStore.size() === 0, `pending=${seamStore.size()}`)
    const noSeatWatch = createSizeWatchHook({ ask: () => true, seatOf: () => null, sizeReminder: seamStore })
    await noSeatWatch({ agent: { id: 'user-agent' }, name: 'write', arguments: { path: f420 } }, null, async () => nextResult)
    add('E5 不是管线席位（seatOf=null）⇒ 直通，不提醒', seamStore.size() === 0, 'user session ignored')

    return renderReport(items)
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响判据 */
    }
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runSizeReminderCheck()
    .then((r) => {
      console.log(r.text)
      if (r.passed !== r.total) process.exitCode = 1
    })
    .catch((err) => {
      console.error('[size-reminder] 内部异常（用例自身的 bug）：', err)
      process.exitCode = 1
    })
}
