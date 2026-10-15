/**
 * m11 · 水位下调的**装配面**：`inject` 精确集合 + "装得上 / 装不上"两种情形
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/m11-memory-pressure-inject-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（登记点见 `WIRING.md` §W11）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * ---------------------------------------------------------------------------
 * 本文件只钉一件事：缺陷 B（水位下调读不到投影 —— `inject` 少一项）
 * ---------------------------------------------------------------------------
 * 真机现场（`pipeline_recall` 自报，逐字）：
 * ```
 * 水位：读不到（读投影失败：cannot get property "sessionProjections" without inject）—— 不下调
 * ```
 * ⇒ E5 的"按上下文水位下调 recall 上限"**一次都没生效过**：不是逻辑错，是**装配面缺一项**。
 *
 * ★ 本文件的夹具是**宿主行为的模型**，判据来自 Cordis 自己的实现（见
 *   `lib/host-surface.js` 文件头）：
 *     · 直接取属性 `ctx.X`：`X` 不在 `inject` 里 ⇒ 抛
 *       `cannot get property "X" without inject`（真机那一行就是这么来的）；
 *     · `ctx.get(X)`：**不带 inject 要求**（Cordis 原话）—— 拿到就给、没提供就
 *       `undefined`、**不抛**。
 *   ★ 为什么必须建模到这一层：只把 `inject` 加一项、却仍用直接取属性读别的服务，
 *     "装得上"照样读不到水位 —— 那样这条断言就成了**假绿**。
 *
 * @module dsh-pipeline/tests/m11-memory-pressure-inject-check
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_RELAY_POLICY } from '../lib/context.js'
import { PLUGIN_INJECT, PROBED_SERVICES, readHostService } from '../lib/host-surface.js'
import { buildMemoryTools } from '../lib/tools/memory.js'
import * as mod from '../index.js'

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

/** ★ 真机那一行（逐字，用来证明"旧装配面确实会走到这里"）。 */
const REAL_NOTE = '读投影失败：cannot get property "sessionProjections" without inject'

/** 宿主内建：Cordis 给每个上下文都有的东西，不受 `inject` 管。 */
const HOST_BUILTIN = ['logger']

/**
 * ★ 宿主行为的模型（两条路各自的口径见文件头）。
 *
 * @param {string[]} injected - 这一份上下文**声明**要的服务（= 被测的 `inject`）
 * @param {object} provided - 宿主**真的提供了**的服务（装不上 = 这里没有）
 */
function hostLikeCtx(injected, provided) {
  return new Proxy(
    { ...provided },
    {
      get(t, key) {
        if (typeof key !== 'string') return t[key]
        // Cordis：`ctx.get` 是"不带 inject 要求"的读法 —— 拿不到回 undefined，不抛。
        if (key === 'get') return (name) => t[name]
        if (HOST_BUILTIN.includes(key) || injected.includes(key)) return t[key]
        throw new Error(`cannot get property "${key}" without inject`)
      },
    },
  )
}

/** 水位 70%（过 hard 线 65 ⇒ 档位 hard_limit ⇒ 折扣 0.25）。 */
const PRESSURE_70 = { surfaceTokens: 700000, contextWindow: 1000000, pressureTokens: 700000 }

/** 把会话与投影都提供出来（`agents` / `sessionProjectionCache` 都**不**写进 inject）。 */
function fullHost(extra = {}) {
  return {
    logger: { warn: () => {} },
    agents: { get: () => ({ session: { id: 's1', header: { id: 's1' } } }) },
    sessionProjections: { snapshot: async () => ({ values: { contextPressure: PRESSURE_70 } }) },
    ...extra,
  }
}

/** 造一个真的 `pipeline_recall` 工具（`ctx` 是上面那种宿主模型）。 */
function mkRecall(ctx, root) {
  return buildMemoryTools({ deps: { defineTool: (d) => d, ctx }, store: { projectRoot: root }, load: async () => null }).memoryRecall
}

const callRecall = (tool) => tool.execute({ limit: 4096, max_items: 20, project_dir: '' }, {})

async function main() {
  lines.push('='.repeat(78))
  lines.push('m11 · 水位下调的装配面：`inject` 精确集合 + 装得上/装不上两种情形')
  lines.push('='.repeat(78))

  // ---- ① 装配面：`inject` **精确等于**新集合（不是"包含"） -----------------
  lines.push('')
  lines.push('【① 装配面：`inject` 精确等于 `[tools, sessionProjections]`（多一个少一个都红）】')
  ok(
    JSON.stringify(mod.inject) === JSON.stringify(['tools', 'sessionProjections']),
    '★★ `inject` **精确相等**（长度、顺序、每一项都算；"包含"这种松判据过不了这条）',
    `实际=${JSON.stringify(mod.inject)}　期望=["tools","sessionProjections"]`,
  )
  ok(
    JSON.stringify(mod.inject) === JSON.stringify(PLUGIN_INJECT),
    '★ 与**单一出处** `PLUGIN_INJECT` 逐字一致（index.js 只是 re-export，不许再写第二份）',
    `PLUGIN_INJECT=${JSON.stringify(PLUGIN_INJECT)}`,
  )
  ok(
    mod.inject.includes('sessionProjections') && mod.inject.includes('tools'),
    '★ 水位要的那一项真的在（这一条就是缺陷 B 的修法本身）',
    `inject=${JSON.stringify(mod.inject)}`,
  )
  ok(
    PROBED_SERVICES.every((s) => !mod.inject.includes(s)) && PROBED_SERVICES.includes('sessionProjectionCache'),
    '★ 可选服务**不进** inject（`inject` 是装配期依赖：少一个服务的构建上整个插件装不上），走运行期探测',
    `探测面=${JSON.stringify(PROBED_SERVICES)}　inject=${JSON.stringify(mod.inject)}`,
  )

  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m11-'))
  try {
    // ---- ② 情形① 服务装得上 ⇒ 能读到水位，且**真的下调** -------------------
    lines.push('')
    lines.push('【② 情形①（装得上）：服务就绪 ⇒ 读得到水位，且按档下调（这才是"修好了"）】')
    const hot = await callRecall(mkRecall(hostLikeCtx(mod.inject, fullHost()), root))
    ok(
      hot.pressure_band === 'hard_limit' && String(hot.pressure_percent) === '70',
      '★★ **读到了水位**（70% ⇒ 档位 `hard_limit`）—— 改动前这一步恒为 `unknown`',
      `band=${hot.pressure_band} percent=${JSON.stringify(hot.pressure_percent)} limit=${hot.limit}`,
    )
    ok(
      hot.budget_reduced_by === 'context-pressure' && hot.limit === 1024,
      `★★ 下调真的发生（上限 4096 → 1024，折扣 ×${0.25} —— 档位读的是既有阈值）`,
      `reduced_by=${JSON.stringify(hot.budget_reduced_by)} limit=${hot.limit}`,
    )
    ok(
      String(hot.summary).includes('来源 sessionProjections.snapshot'),
      '★ 摘要写明了"从哪读到的"（`via` —— 排障时不用猜）',
      String(hot.summary).split('\n').filter((l) => l.includes('水位')).join(' ｜ '),
    )
    ok(
      String(hot.summary).includes('水位 70%') && !String(hot.summary).includes('读不到'),
      '★ 摘要里不再出现"读不到"（与改动前那行现场文案正好相反）',
      String(hot.summary).split('\n').filter((l) => l.includes('水位')).join(' ｜ '),
    )
    ok(
      hot.tokens <= hot.limit,
      '★ 上限仍然是**硬的**（R8 没被松动：实付 ≤ 本次上限）',
      `tokens=${hot.tokens} ≤ limit=${hot.limit}`,
    )

    // ---- ③ 情形②：服务**装不上** ⇒ 如实降级、不报假数、不下调 -------------
    lines.push('')
    lines.push('【③ 情形②（装不上）：宿主没提供投影 ⇒ 如实降级、**不下调**、不报假档位】')
    const noSvc = await callRecall(mkRecall(hostLikeCtx(['tools'], { logger: { warn: () => {} }, agents: fullHost().agents }), root))
    ok(
      noSvc.pressure_band === 'unknown' && String(noSvc.pressure_percent) === '' && noSvc.budget_reduced_by === '',
      '★★ 读不到 ⇒ `unknown` + 百分比为空 + **不下调**（不猜一个数来砍上限）',
      `band=${noSvc.pressure_band} percent=${JSON.stringify(noSvc.pressure_percent)} reduced_by=${JSON.stringify(noSvc.budget_reduced_by)}`,
    )
    ok(noSvc.limit === 4096 && noSvc.ok === true, '★ 上限原样（4096）；**取回本身照常成功**（降级不是失败）', `limit=${noSvc.limit} ok=${noSvc.ok}`)
    ok(
      String(noSvc.summary).includes('读不到') && String(noSvc.summary).includes('不下调'),
      '★★ 摘要里**如实写出来**（"读不到……不下调"）—— 与今天真机行为一致，只是原因换成了"宿主没提供"',
      String(noSvc.summary).split('\n').filter((l) => l.includes('水位')).join(' ｜ '),
    )

    // ---- ④ 情形③：服务在但**读失败** ⇒ 同样如实降级 ------------------------
    lines.push('')
    lines.push('【④ 情形③（读失败）：投影在、但每次读都抛 ⇒ 仍然如实降级（绝不把异常当水位）】')
    const boom = fullHost({
      sessionProjections: {
        snapshot: async () => {
          throw new Error('projection store is corrupted')
        },
      },
    })
    const crashed = await callRecall(mkRecall(hostLikeCtx(mod.inject, boom), root))
    ok(
      crashed.pressure_band === 'unknown' && crashed.budget_reduced_by === '' && crashed.limit === 4096,
      '★★ 读投影抛异常 ⇒ 不下调、不抛给调用方、上限原样',
      `band=${crashed.pressure_band} limit=${crashed.limit} ok=${crashed.ok}`,
    )
    ok(
      String(crashed.summary).includes('读投影失败') && String(crashed.summary).includes('projection store is corrupted'),
      '★ 失败**原文**照原样写进摘要（不静默、不换成人话盖掉根因）',
      String(crashed.summary).split('\n').filter((l) => l.includes('水位')).join(' ｜ '),
    )

    // ---- ⑤ 判据自检：旧装配面 + 直接取属性 ⇒ 逐字得到真机那一行 ------------
    lines.push('')
    lines.push('【⑤ 判据自检：旧装配面（只有 tools）确实会走到真机那一行 —— 证明 ② 不是恒真】')
    const oldCtx = hostLikeCtx(['tools'], fullHost())
    let directErr = ''
    try {
      void oldCtx.sessionProjections
    } catch (err) {
      directErr = String(err?.message ?? err)
    }
    ok(directErr.includes('without inject'), '★ 直接取属性在旧装配面下**真的抛**（`inject` 之外的属性取不到）', directErr)
    ok(`读投影失败：${directErr}` === REAL_NOTE, '★★ 拼出来的那句话与**真机现场逐字相同**（所以"今天读不到"是可复现的，不是传说）', `拼出=${`读投影失败：${directErr}`}\n      真机=${REAL_NOTE}`)
    ok(
      readHostService(oldCtx, 'sessionProjections') !== undefined,
      '★ 而 `ctx.get`（**不带 inject 要求**）拿得到它 ⇒ 探测路成立，这就是修法的机制',
      `readHostService=${readHostService(oldCtx, 'sessionProjections') === undefined ? 'undefined' : '拿到了'}`,
    )
    ok(readHostService(oldCtx, '没有这个服务') === undefined, '★ 探测一个不存在的服务 ⇒ `undefined`、**不抛**（可选服务缺了也不该把调用带崩）', 'undefined')
    ok(
      DEFAULT_RELAY_POLICY.hardLimitPercent === 65,
      '★ 档位阈值仍然读既有那一条（`DEFAULT_RELAY_POLICY`：hard 65）—— 本文件没有第二套阈值',
      `hard=${DEFAULT_RELAY_POLICY.hardLimitPercent}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`m11 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))
  return { passed, total: passed + failed, text: lines.join('\n') }
}

/**
 * 聚合跑入口（`tests/run-all.mjs` 登记用）。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runM11MemoryPressureInjectCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ m11 运行失败（异常）：${err?.stack ?? err}`)
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('m11-memory-pressure-inject-check.mjs')) {
  const r = await runM11MemoryPressureInjectCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
