/**
 * m6 · 记忆取回 · ★ **上限是硬的**（超了必须截断、且保留高分那一段）
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/m6-memory-budget-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（登记点见 `WIRING.md` §W9）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * ---------------------------------------------------------------------------
 * 这一套只测一件事
 * ---------------------------------------------------------------------------
 * 判据 R8（任何输入下返回内容的计价 token ≤ 上限）与 R9（**截断的是尾部**、
 * 保留的是分数最高的那一段）。设计 `05-判据与测试.md` §1 写着：
 * **R8 是整份设计里最该先立起来的一条** —— 没有它，"防上下文被记忆撑爆"就只是愿望。
 *
 * ★ 计价用的是**测试自己带的 meter**（`t => String(t).length`），与实现里的任何
 *   估算都不同源 —— 否则就是"用被测对象的尺子量它自己"。
 *
 * @module dsh-pipeline/tests/m6-memory-budget-check
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PRESSURE_DISCOUNT,
  applyBudget,
  clampLimit,
  estimateTokens,
  lastRecallUsage,
  meterFrom,
  pressureOf,
  reduceBudgetForPressure,
  wireLine,
} from '../lib/memory/budget.js'
import { DEFAULT_RELAY_POLICY } from '../lib/context.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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

/** ★ 独立计价器（**不是**被测实现里那一个）：一个字符算一个 token。 */
const charMeter = (text) => String(text ?? '').length

/** 返回内容的实际计价（独立重算：逐行 `wireLine` 再交给 meter）。 */
const recompute = (items, meter = charMeter) => items.reduce((n, it) => n + meter(wireLine(it)), 0)

/**
 * ★ 判据本体（**能红的判据**）：上限真的被守住 + 返回集合就是"排序后前 k 条"。
 *
 * 抽出来是为了第 ⑦ 段能拿**没截断的输入**打给它看 —— 证明它不是恒真。
 */
function capHolds(result, candidates, limit, meter = charMeter) {
  const used = recompute(result.items, meter)
  const prefix = candidates.slice(0, result.items.length)
  return (
    used === result.tokens &&
    used <= limit &&
    result.items.length <= candidates.length &&
    result.items.every((it, i) => it.id === prefix[i].id)
  )
}

/** 造 n 条候选：分数递减、正文长度递增（保证"前 k 条"与"最短的 k 条"不是同一批）。 */
function makeItems(n) {
  const at = (i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`
  return Array.from({ length: n }, (_, i) => ({
    id: `mem-${String(i).padStart(3, '0')}`,
    at: at(i),
    kind: 'task',
    scope: 'project',
    text: `第 ${i} 条记忆：${'正文'.repeat(i + 1)}`,
    score: n - i,
    routes: ['keyword'],
    entity: [`task:mem-${i}`],
    refs: { task_id: `T-x-${i}`, state: 'closed', state_label: '已关闭', paths: [], handoff: '', artifact_version: '', roles: [] },
  }))
}

async function main() {
  lines.push('='.repeat(78))
  lines.push('m6 · 记忆取回：★ 上限是硬的（R8/R9）')
  lines.push('='.repeat(78))

  const candidates = makeItems(40)

  // ---- ① 上限是硬的 -------------------------------------------------------
  lines.push('')
  lines.push('【① R8：任何输入下，返回内容的计价 token ≤ 上限】')
  for (const limit of [1, 5, 37, 200, DEFAULT_LIMIT]) {
    const r = applyBudget(candidates, { limit, meter: charMeter, metered_by: 'test-char-meter' })
    ok(
      r.tokens <= limit && recompute(r.items, charMeter) <= limit,
      `上限 ${limit} ⇒ 实际用量 ≤ 上限（**硬**）`,
      `返回 ${r.items.length} 条｜实现自报 tokens=${r.tokens}｜独立重算=${recompute(r.items, charMeter)}｜丢 ${r.dropped} 条`,
    )
  }
  const big = applyBudget(candidates, { limit: 4096, meter: charMeter, metered_by: 'test-char-meter' })
  ok(
    big.tokens > 0 && big.items.length === candidates.length && big.dropped === 0,
    '上限富余时**一条都不丢**（截断是"超了才发生"，不是常态）',
    `返回 ${big.items.length} 条 / 候选 ${candidates.length} 条｜用量 ${big.tokens}`,
  )

  // ---- ② 截断的是尾部（保留高分那一段） -----------------------------------
  lines.push('')
  lines.push('【② R9：超限时截断的是**尾部**（保留分数最高的），不是随机丢】')
  const cut = applyBudget(candidates, { limit: 120, meter: charMeter, metered_by: 'test-char-meter' })
  const keptIds = cut.items.map((x) => x.id)
  const prefixIds = candidates.slice(0, cut.items.length).map((x) => x.id)
  ok(JSON.stringify(keptIds) === JSON.stringify(prefixIds), '★ 返回集合 == 排序后**前 k 条**', `k=${keptIds.length}｜${JSON.stringify(keptIds)}`)
  ok(
    cut.items.every((x, i) => i === 0 || cut.items[i - 1].score >= x.score),
    '★ 分数单调不增（留下的确实是分数最高的那一段，尾部被丢）',
    `分数序列=${JSON.stringify(cut.items.map((x) => x.score))}`,
  )
  ok(cut.dropped === candidates.length - cut.items.length, '`dropped` 如实等于被丢掉的尾部长度', `dropped=${cut.dropped}`)

  // ---- ③ 边界：0 / 天花板 / 负数 ------------------------------------------
  lines.push('')
  lines.push('【③ 边界：limit=0（只要计数）· 超天花板（夹住）· 负数】')
  const zero = applyBudget(candidates, { limit: 0, meter: charMeter })
  ok(zero.items.length === 0 && zero.tokens === 0 && zero.dropped === candidates.length, '`limit=0` ⇒ 空内容（合法用法：只要计数），且如实报丢了多少', `dropped=${zero.dropped}`)
  const huge = applyBudget(candidates, { limit: 999999, meter: charMeter })
  ok(huge.limit === MAX_LIMIT && huge.clamped === true, `★ 超天花板 ⇒ 夹到 ${MAX_LIMIT} 并如实报 \`clamped:true\``, `limit=${huge.limit} clamped=${huge.clamped}`)
  ok(clampLimit(undefined).limit === DEFAULT_LIMIT, `没给上限 ⇒ 用默认 ${DEFAULT_LIMIT}`, `limit=${clampLimit(undefined).limit}`)
  const neg = clampLimit(-5)
  ok(neg.limit === 0 && neg.clamped === true, '负数 ⇒ 夹到 0（不变成"无上限"这种危险解释）', `limit=${neg.limit}`)

  // ---- ④ 单条就超上限 ⇒ 截断它自己并标注 ----------------------------------
  lines.push('')
  lines.push('【④ 单条就超上限：截断**这一条**并标注 truncated（不返回半条把整批顶超）】')
  //   ★ 上限的取法：**比"整条"小、比"最短形式"（元数据 + 省略号）大** ——
  //     只有这样才落在"单条截断"这条边界上（见下面那条"连元数据都放不下"的对照）。
  const ONE_LIMIT = 52
  const fullLine = wireLine(candidates[0]).length
  const minLine = wireLine({ ...candidates[0], text: '…' }).length
  const one = applyBudget([candidates[0]], { limit: ONE_LIMIT, meter: charMeter, metered_by: 'test-char-meter' })
  ok(
    one.items.length === 1,
    '★ 单条超上限时**仍然给出一条**（不是给空）',
    `整条=${fullLine} 字符 > 上限 ${ONE_LIMIT} > 最短形式=${minLine} 字符`,
  )
  ok(one.truncated === 1 && one.items[0].truncated === true, '★ 被截断的那条**标注** `truncated:true`（读者知道它少了尾巴）', `truncated=${one.truncated}`)
  ok(recompute(one.items, charMeter) <= ONE_LIMIT, '截断之后**仍在限内**（这是"硬"的含义）', `用量=${recompute(one.items, charMeter)} ≤ ${ONE_LIMIT}`)
  ok(one.items[0].text.endsWith('…'), '截断留下的是**前缀 + 省略号**（不是随机片段）', `尾部=${JSON.stringify(one.items[0].text.slice(-12))}`)
  const tooTiny = applyBudget([candidates[0]], { limit: 1, meter: charMeter })
  ok(tooTiny.items.length === 0 && tooTiny.tokens === 0, '连"最短形式"都放不下（上限 1 字符）⇒ 空内容，**不硬塞**', `条数=${tooTiny.items.length}`)
  const metaTooBig = applyBudget([candidates[0]], { limit: minLine - 1, meter: charMeter })
  ok(
    metaTooBig.items.length === 0,
    '★ 上限小到**连一行元数据都放不下**（< 最短形式）⇒ 空内容：**上限优先于"总要给点什么"**',
    `最短形式=${minLine} 字符，上限=${minLine - 1} ⇒ 返回 ${metaTooBig.items.length} 条`,
  )

  // ---- ⑤ 计价器：宿主 meter 优先，坏了就降级（都不抛） --------------------
  lines.push('')
  lines.push('【⑤ 计价：宿主 `ctx.tokenMeter.estimateMessage` 优先；坏了/没有 ⇒ 降级并如实报】')
  const host = meterFrom({ estimateMessage: (m) => m.content[0].text.length })
  ok(host.metered_by === 'tokenMeter.estimateMessage' && host.meter('abcd') === 4, '★ 有宿主 meter ⇒ 用它，且 `metered_by` 报出来路', `metered_by=${host.metered_by} meter('abcd')=${host.meter('abcd')}`)
  const broken = meterFrom({ estimateMessage: () => { throw new Error('boom') } })
  let threw = false
  let val = null
  try {
    val = broken.meter('中文abcd')
  } catch {
    threw = true
  }
  ok(threw === false && Number.isFinite(val), '★ 宿主 meter **抛错也不抛给调用方**（取回是只读动作，不该因计价器失败而失败）', `抛=${threw} 值=${val}`)
  const junk = meterFrom({ estimateMessage: () => Number.NaN })
  ok(Number.isFinite(junk.meter('x')), '宿主 meter 返回非有限数 ⇒ 降级（不是 NaN 传染给上限判定）', `值=${junk.meter('x')}`)
  ok(meterFrom(null).metered_by === 'estimate-fallback', '没有 meter ⇒ 用确定性降级估算，并如实报 `estimate-fallback`', `metered_by=${meterFrom(null).metered_by}`)
  ok(estimateTokens('') === 0 && estimateTokens('abcd') >= 1 && estimateTokens('中文') === 2, '降级估算口径：空 0、非空 ≥1、CJK 每字 1', `''=${estimateTokens('')} 'abcd'=${estimateTokens('abcd')} '中文'=${estimateTokens('中文')}`)

  // ---- ⑥ 工具端到端：返回体自报的用量 = 独立重算的用量 --------------------
  lines.push('')
  lines.push('【⑥ 端到端：工具自报的 `tokens` 必须等于"独立重算返回内容"的用量】')
  {
    const { buildMemoryTools } = await import('../lib/tools/memory.js')
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m6-'))
    try {
      const t = join(root, '.pipeline', 'T-20260101-aaaa')
      mkdirSync(t, { recursive: true })
      writeFileSync(
        join(t, 'task.json'),
        JSON.stringify({
          id: 'T-20260101-aaaa',
          state: 'closed',
          updated_at: '2026-01-01T10:00:00Z',
          requirement: '一条足够长的需求，用来把上限逼到真的发生截断：'.repeat(3),
        }),
        'utf8',
      )
      const { memoryRecall } = buildMemoryTools({
        deps: { defineTool: (d) => d, ctx: { tokenMeter: { estimateMessage: (m) => m.content[0].text.length } } },
        store: { projectRoot: root },
        load: async () => null,
      })
      const small = await memoryRecall.execute({ limit: 90, max_items: 10 }, {})
      ok(
        small.ok === true && small.tokens <= 90 && small.count >= 1,
        '★ 工具返回的 `tokens` ≤ 调用方给的上限（限 90），且**真的给了内容**（不是空切片蒙混）',
        `tokens=${small.tokens} limit=${small.limit} count=${small.count} truncated=${small.truncated}`,
      )
      ok(small.truncated >= 1 && small.items[0].truncated === true, '★ 单条超上限时工具路径也截断并标注（`truncated:true`）', `truncated=${small.truncated} text 尾部=${JSON.stringify(small.items[0].text.slice(-10))}`)
      ok(small.metered_by === 'tokenMeter.estimateMessage', '工具真的用了宿主 meter（不是悄悄降级）', `metered_by=${small.metered_by}`)
      const itemLines = small.summary.split('\n').filter((l) => l.startsWith('[')).length
      ok(itemLines === small.count, '★ 摘要里被计价的行数 == 返回条数（**计价对象 = 返回对象**，不多不少）', `摘要行=${itemLines} count=${small.count}`)
      const wide = await memoryRecall.execute({ limit: 999999 }, {})
      ok(wide.clamped === true && wide.limit === MAX_LIMIT, '工具也遵守天花板（超了夹住并如实报）', `limit=${wide.limit} clamped=${wide.clamped}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // ---- ⑦ ★ E5：水位联动 —— 档位读既有阈值、按档下调、读不到就不下调 -------
  lines.push('')
  lines.push('【⑦ E5 水位联动：`contextPressure` → 档位（读 `lib/context.js` 的阈值）→ 上限折扣】')
  const atPressure = (percent) => pressureOf({ pressureTokens: percent, contextWindow: 100, surfaceTokens: 1 })
  ok(
    DEFAULT_RELAY_POLICY.triggerContextPercent === 55 && DEFAULT_RELAY_POLICY.hardLimitPercent === 65,
    '★ 阈值**读既有那一条**（`lib/context.js` 的 `DEFAULT_RELAY_POLICY`：warn 45 / trigger 55 / hard 65）—— 没有第二套',
    `warn=${DEFAULT_RELAY_POLICY.warnPercent} trigger=${DEFAULT_RELAY_POLICY.triggerContextPercent} hard=${DEFAULT_RELAY_POLICY.hardLimitPercent}`,
  )
  const table = [10, 44, 45, 54, 55, 64, 65, 90].map((p) => {
    const r = reduceBudgetForPressure(4096, atPressure(p), DEFAULT_RELAY_POLICY)
    return `${p}%→${r.band}:${r.limit}`
  })
  ok(
    JSON.stringify(table) === JSON.stringify(['10%→ok:4096', '44%→ok:4096', '45%→warn:3072', '54%→warn:3072', '55%→succession:2048', '64%→succession:2048', '65%→hard_limit:1024', '90%→hard_limit:1024']),
    '★★ 输入→输出表（8 格逐格钉住）：ok 不下调；warn ×0.75；**过 trigger ×0.5**；过 hard ×0.25',
    table.join('  '),
  )
  ok(
    reduceBudgetForPressure(4096, null, DEFAULT_RELAY_POLICY).reduced === false &&
      reduceBudgetForPressure(4096, pressureOf({ surfaceTokens: 3 }), DEFAULT_RELAY_POLICY).band === 'unknown',
    '★ **读不到水位 ⇒ 不下调**（`band:unknown`）—— 不猜一个数来砍上限',
    `分母缺失时 band=${reduceBudgetForPressure(4096, pressureOf({ surfaceTokens: 3 }), DEFAULT_RELAY_POLICY).band}`,
  )
  ok(
    reduceBudgetForPressure(0, atPressure(90), DEFAULT_RELAY_POLICY).limit === 0 &&
      reduceBudgetForPressure(1, atPressure(90), DEFAULT_RELAY_POLICY).limit === 1,
    '★ 边界：`limit=0`（只要计数）仍是 0；下调后**至少 1**（水位再高也不把切片变成永远空）',
    `0→${reduceBudgetForPressure(0, atPressure(90), DEFAULT_RELAY_POLICY).limit}　1→${reduceBudgetForPressure(1, atPressure(90), DEFAULT_RELAY_POLICY).limit}`,
  )
  ok(Object.keys(PRESSURE_DISCOUNT).join() === 'ok,warn,succession,hard_limit', '折扣表覆盖 `levelOf()` 的四个档（键名与它同源，不是另起一套名字）', JSON.stringify(PRESSURE_DISCOUNT))

  // ---- ⑧ 端到端：水位过 trigger ⇒ 实际用量下降，且 R8 仍然绿 ---------------
  lines.push('')
  lines.push('【⑧ E5 端到端：水位过 trigger ⇒ `budget_reduced_by` 出现且**实付更少**（R8 仍绿）】')
  {
    const { buildMemoryTools } = await import('../lib/tools/memory.js')
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m6e5-'))
    try {
      const t = join(root, '.pipeline', 'T-20260101-aaaa')
      mkdirSync(join(t, 'handoffs'), { recursive: true })
      // 造 6 条足够长的记忆：水位高时应当**只放得下前面几条**。
      writeFileSync(
        join(t, 'task.json'),
        JSON.stringify({ id: 'T-20260101-aaaa', state: 'closed', updated_at: '2026-01-01T10:00:00Z', requirement: '水位联动夹具：'.repeat(4) }),
        'utf8',
      )
      for (let i = 0; i < 6; i += 1) {
        writeFileSync(
          join(t, 'handoffs', `00${i}-dev_to_test.json`),
          JSON.stringify({
            handoff_id: `00${i}-dev_to_test`,
            task_id: 'T-20260101-aaaa',
            kind: 'dev_to_test',
            kind_zh: '编写→测试',
            from_role: 'writer',
            to_role: 'tester',
            created_at: `2026-01-0${i + 1}T00:00:00Z`,
            payload: { change_note: `第 ${i} 份改动说明：${'正文'.repeat(40)}` },
          }),
          'utf8',
        )
      }
      const sessions = (pressure) => ({
        agents: { get: () => ({ session: { id: 's1' } }) },
        sessionProjections: { snapshot: async () => ({ values: { contextPressure: pressure } }) },
      })
      const mk = (ctx) => buildMemoryTools({ deps: { defineTool: (d) => d, ctx }, store: { projectRoot: root }, load: async () => null }).memoryRecall
      const big = { surfaceTokens: 700000, contextWindow: 1000000, pressureTokens: 700000 }

      const calm = await mk({ tokenMeter: { estimateMessage: (m) => m.content[0].text.length }, ...sessions({ surfaceTokens: 100000, contextWindow: 1000000, pressureTokens: 100000 }) }).execute({ limit: 4096, max_items: 20 }, {})
      ok(calm.budget_reduced_by === '' && calm.pressure_band === 'ok' && calm.limit === 4096, '★ 水位 10%（ok 档）⇒ **不下调**（`budget_reduced_by` 空）—— 证明下调不是恒真', `band=${calm.pressure_band} limit=${calm.limit} reduced_by=${JSON.stringify(calm.budget_reduced_by)}`)

      const hot = await mk({ tokenMeter: { estimateMessage: (m) => m.content[0].text.length }, ...sessions(big) }).execute({ limit: 4096, max_items: 20 }, {})
      ok(
        hot.budget_reduced_by === 'context-pressure' && hot.pressure_band === 'hard_limit' && hot.limit === 1024,
        '★★ **水位 70% ⇒ `budget_reduced_by:\'context-pressure\'`**、档位 hard_limit、上限 4096→1024（判据 R8 的验收原话）',
        `reduced_by=${hot.budget_reduced_by} band=${hot.pressure_band} limit=${hot.limit} pressure=${hot.pressure_percent}%`,
      )
      ok(
        hot.tokens <= hot.limit && hot.tokens < calm.tokens,
        '★★ **实际用量真的下降**（水位高时付得更少），且**上限仍然是硬的**（`tokens ≤ limit`，R8 未松动）',
        `水位高：${hot.tokens}/${hot.limit} token｜水位低：${calm.tokens}/${calm.limit} token`,
      )
      const usageHot = lastRecallUsage()
      ok(
        usageHot !== null && usageHot.limit === hot.limit && usageHot.tokens === hot.tokens && usageHot.reduced_by === 'context-pressure',
        '★ E5（04 §7.4）：最近一次 recall 的用量被记下（给 `pipeline_context_report` 读），数字与返回逐字一致',
        `lastRecallUsage=${JSON.stringify(usageHot)}`,
      )
      const noProj = await mk({ tokenMeter: { estimateMessage: (m) => m.content[0].text.length } }).execute({ limit: 4096, max_items: 20 }, {})
      ok(noProj.budget_reduced_by === '' && noProj.limit === 4096 && noProj.pressure_band === 'unknown', '★ 宿主**没有**会话投影 ⇒ 按未知处理：不下调、不报假档位', `band=${noProj.pressure_band} limit=${noProj.limit}`)
      ok(String(hot.summary).includes('水位') && String(hot.summary).includes('context-pressure'), '★ 摘要里把"为什么被下调"写出来了（可解释：哪一档、降到多少、被谁下调）', String(hot.summary).split('\n').filter((l) => l.includes('水位') || l.includes('上限：')).join(' ｜ '))
      const usageLast = lastRecallUsage()
      ok(
        usageLast !== null && usageLast.limit === noProj.limit && usageLast.reduced_by === '',
        '★ 它是"**最近一次**"而不是"第一次"：后一次调用把记录刷新成它自己的数字',
        `最近一次=${JSON.stringify(usageLast)}｜noProj: limit=${noProj.limit} tokens=${noProj.tokens}`,
      )
      const recSrc = readFileSync(join(ROOT, 'lib', 'tools', 'records.js'), 'utf8')
      ok(recSrc.includes('lastRecallUsage') && recSrc.includes('recall_usage'), '★ 7.4 接线：`pipeline_context_report` 的源码里读了它，并把 `recall_usage` 声明进输出', '')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // ---- ⑨ 判据自检：这套断言**真的会红** -----------------------------------
  lines.push('')
  lines.push('【⑨ 判据自检：把"没截断"的输入喂给同一条判据 ⇒ 必须红（证明 ①② 不是恒真）】')
  const noTruncate = { items: candidates, tokens: recompute(candidates, charMeter), limit: 120, clamped: false, truncated: 0, dropped: 0 }
  ok(
    noTruncate.tokens > 120 && capHolds(noTruncate, candidates, 120, charMeter) === false,
    '★ 假设实现"忘了截断"（返回全部 40 条）⇒ 同一条判据判红（它抓得住）',
    `没截断时用量=${noTruncate.tokens} > 上限 120 ⇒ capHolds=${capHolds(noTruncate, candidates, 120, charMeter)}`,
  )
  ok(capHolds(cut, candidates, 120, charMeter) === true, '★ 对照：真实现（截断过）⇒ 同一条判据判绿（不是"谁都红"）', `capHolds=${capHolds(cut, candidates, 120, charMeter)}`)
  const shuffled = { ...cut, items: [...cut.items].reverse() }
  ok(capHolds(shuffled, candidates, 120, charMeter) === false, '★ 把返回顺序倒过来（"随机丢"的形状）⇒ 同一条判据也判红（尾部语义被抓得住）', `capHolds=${capHolds(shuffled, candidates, 120, charMeter)}`)

  // ---- ⑧ 溯源：计价与返回必须是**同一个函数**（防"两把尺子"） -------------
  lines.push('')
  lines.push('【⑧ 防漂移：`wireLine` 是唯一渲染口径（形如 `[分数]{路由} 时刻 〔类型〕(任务) 正文`）】')
  const sample = wireLine({ score: 7, routes: ['keyword', 'time'], at: '2026-01-01T00:00:00Z', kind: 'task', text: '正文', refs: { task_id: 'T-1' } })
  ok(sample === '[7]{keyword+time} 2026-01-01T00:00:00Z 〔task〕(T-1) 正文', '`wireLine` 形状钉住（分数 + 来路 + 时刻 + 类型 + 任务 + 正文）', sample)
  const src = readFileSync(join(ROOT, 'lib', 'memory', 'budget.js'), 'utf8')
  ok(src.includes('wireLine') && src.includes('MAX_LIMIT'), '`budget.js` 里既有上限常量也有唯一渲染口径（防止渲染被挪走后没人计价）')

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`m6 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))
  return { passed, total: passed + failed, text: lines.join('\n') }
}

/**
 * 聚合跑入口（`tests/run-all.mjs` 登记用）。断言、计数与"直接跑"**同一条路径**。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runM6MemoryBudgetCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ m6 运行失败（异常）：${err?.stack ?? err}`)
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('m6-memory-budget-check.mjs')) {
  const r = await runM6MemoryBudgetCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
