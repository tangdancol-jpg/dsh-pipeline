/**
 * m10 · 记忆 · retain 缝的**结果摘要必须是"人话"**（宿主信封 → 可读摘要）
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/m10-memory-digest-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`（登记点见 `WIRING.md` §W11）
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * ---------------------------------------------------------------------------
 * 本文件只钉一件事：缺陷 A（记忆摘要变成 `[object Object]`）
 * ---------------------------------------------------------------------------
 * 真机现场（2026-10-15，重启后的 DSH 实测）—— 记忆缝自动攒下的**那两条**正文：
 * ```
 * 【流水线 · 记忆切片】本项目已攒下 2 条记忆，这里是其中最近 2 条（计价 52/600 token）
 * 2026-10-15T16:36:57.504Z 〔tool〕工具 pipeline_status 完成：[object Object]
 * 2026-10-15T16:36:57.499Z 〔tool〕(T-20261015-bb30bc) 工具 pipeline_recall 完成（任务 T-20261015-bb30bc）：[object Object]
 * ```
 * ⇒ 记忆**攒下来了**，但那一行谁也读不懂（关键词路检索不到任何东西）= 白攒。
 *
 * ★ 为什么原来那套测试没抓住它：既有夹具直接喂**工具的返回值**
 *   （`{ ok:true, handoff_id:'HO-1', summary:'…' }`），而宿主交来的是**信封**
 *   （`{ isError, value, content }`）。夹具形状不对 ⇒ 判据再对也照绿。
 *   所以本文件的夹具**一律用宿主信封**，并且用**真机那两条的真实结果**。
 *
 * 判据、摘要形状与截断默认值的**唯一出处**是 `lib/memory/digest.js` 的文件头。
 *
 * @module dsh-pipeline/tests/m10-memory-digest-check
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { memoryFile } from '../lib/memory/bank.js'
import { readBank } from '../lib/memory/load.js'
import { TEXT_MAX, validateRecord } from '../lib/memory/record.js'
import { createMemoryRetainHook, retainDisc } from '../lib/memory/retain-hook.js'

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

const FIXED_AT = '2026-10-15T16:36:57.499Z'
const SEAT = { taskId: 'T-20261015-bb30bc', role: 'writer', seat: 'writer#1' }

/** 造一条 retain 缝（真 fs；时钟写死 ⇒ 判据确定性）。 */
function makeSeam(projectDir, extra = {}) {
  const warns = []
  const svc = {
    ask: () => true,
    seatOf: () => SEAT,
    getTask: () => null,
    warn: (m) => warns.push(m),
    projectDir,
    nowIso: () => FIXED_AT,
    ...extra,
  }
  return { hook: createMemoryRetainHook(svc), warns }
}

/** 跑一次缝：`next` 的原样值是什么、返回值是不是同它一致。 */
async function runSeam(hook, exec, result, nextValue = { ok: true, toolResult: result }) {
  let called = 0
  const out = await hook(exec, result, async () => {
    called += 1
    return nextValue
  })
  return { out, called, nextValue }
}

/**
 * ★ 宿主信封（形状**照抄** DSH 自己的类型声明，不是猜的）：
 *   `ToolExecutionSuccess { isError:false, value:JsonValue, content:ContentBlock[] }`
 *   `ToolExecutionFailure { isError:true,  error:ToolFailure, content:ContentBlock[] }`
 * 而 `tools/post-execute` 的签名逐字是 `(exec, result: Readonly<ToolExecutionResult>, next)`。
 */
const envelope = (value, text) => ({ isError: false, value, content: [{ type: 'text', text }] })

/** 真机第一条：`pipeline_status`（无 task_id 参数）。 */
const REAL_STATUS = envelope(
  {
    ok: true,
    summary: '任务 T-20261015-bb30bc：状态 developing（开发中），下一步该 writer 提交制品。',
    task_id: 'T-20261015-bb30bc',
    state: 'developing',
    next_actor: 'writer',
  },
  '任务 T-20261015-bb30bc：状态 developing（开发中）…',
)

/** 真机第二条：`pipeline_recall`。 */
const REAL_RECALL = envelope(
  {
    ok: true,
    summary: '【流水线 · 记忆切片】本项目已攒下 2 条记忆（计价 52/600 token）',
    task_id: 'T-20261015-bb30bc',
    count: 2,
    tokens: 52,
    limit: 600,
  },
  '【流水线 · 记忆切片】…',
)

/** 失败信封（宿主自己的失败形状）。 */
const REAL_FAIL = {
  isError: true,
  error: { message: 'EACCES: 只读文件系统' },
  content: [{ type: 'text', text: 'Error: EACCES: 只读文件系统' }],
}

async function main() {
  lines.push('='.repeat(78))
  lines.push('m10 · 记忆 retain 缝：结果摘要是"人话"（宿主信封 ⇒ 不许 [object Object]）')
  lines.push('='.repeat(78))

  // ★ 判据的纯函数出处：新模块。**动态**读它，好让"模块还没落地"这一条自己成为一条红。
  let digest = null
  let digestErr = ''
  try {
    digest = await import('../lib/memory/digest.js')
  } catch (err) {
    digestErr = String(err?.message ?? err).split('\n')[0]
  }

  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m10-'))
  try {
    // ---- ① 真机现场：正文与 id 都不许是 `[object Object]` --------------------
    lines.push('')
    lines.push('【① 真机那两条（信封 + 真实结果）⇒ 正文与 `id` 都不许出现 `[object Object]`】')
    const seam = makeSeam(root)
    await runSeam(seam.hook, { name: 'pipeline_status', arguments: {} }, REAL_STATUS)
    await runSeam(seam.hook, { name: 'pipeline_recall', arguments: { task_id: 'T-20261015-bb30bc' } }, REAL_RECALL)
    const bank = await readBank(memoryFile(root))
    const texts = bank.records.map((r) => r.text)
    const ids = bank.records.map((r) => r.id)
    ok(bank.records.length === 2, '两次调用 ⇒ 库里恰好两条（信封不妨碍记录）', `条数=${bank.records.length}`)
    ok(
      texts.length === 2 && texts.every((t) => !t.includes('[object Object]')),
      '★★ **正文里不得出现 `[object Object]`**（真机那两行就是它 ⇒ 记忆白攒）',
      texts.join('\n      '),
    )
    ok(
      ids.length === 2 && ids.every((i) => !i.includes('[object Object]')),
      '★ 去重键（记录 `id`）里同样不得出现 `[object Object]`',
      ids.join('\n      '),
    )
    ok(
      texts.some((t) => t.includes('developing')) && texts.some((t) => t.includes('记忆切片')),
      '★ 正文读得出**真内容**（工具自己的 `summary`），不是形状指纹',
      texts.join('\n      '),
    )
    ok(bank.records.every((r) => validateRecord(r).ok === true), '两条都过校验器（形状没被改坏）', '')
    ok(
      bank.records.every((r) => typeof r.text === 'string' && r.text.length <= TEXT_MAX),
      `正文不超上限（\`TEXT_MAX\`=${TEXT_MAX}）`,
      bank.records.map((r) => r.text.length).join(' / '),
    )
    ok(
      texts.every((t) => t.includes('pipeline_status') || t.includes('pipeline_recall')),
      '★ 正文带**工具名**（"这是哪一类事实"的判据）',
      texts.join(' ｜ '),
    )

    // ---- ② 结构化字段从**信封里的 value** 取 ---------------------------------
    lines.push('')
    lines.push('【② `refs` 从信封里的 `value` 取（改动前 `r.state`/`r.handoff_id` 恒为空）】')
    ok(
      bank.records.filter((r) => r.refs.task_id === 'T-20261015-bb30bc').length === 2,
      '★ `refs.task_id` 取到了（参数里没有就退到 `value.task_id`）',
      JSON.stringify(bank.records.map((r) => r.refs.task_id)),
    )
    ok(
      bank.records.some((r) => r.refs.state === 'developing'),
      '★ `refs.state` 取到了（信封里 `r.state` 是 undefined ⇒ 改动前它是空串）',
      JSON.stringify(bank.records.map((r) => r.refs.state)),
    )
    ok(
      bank.records.every((r) => r.text.includes('T-20261015-bb30bc')),
      '★ 正文与 `refs` 说的是同一张单（同一份事实，不是两处各取一半）',
      bank.records.map((r) => `${r.text.slice(0, 42)}… / refs=${r.refs.task_id}`).join('\n      '),
    )

    // ---- ③ 去重键：真的会判别 -------------------------------------------------
    lines.push('')
    lines.push('【③ 去重键：不同结果 ⇒ 不同键；同输入 ⇒ 同键（改动前所有调用共用一把键）】')
    const discA = retainDisc({ name: 'pipeline_status', arguments: {} }, REAL_STATUS)
    const discB = retainDisc(
      { name: 'pipeline_status', arguments: {} },
      envelope({ ok: true, summary: '任务 T-20261015-bb30bc：状态 closed（已关闭）。', state: 'closed' }, '…'),
    )
    ok(
      discA !== discB,
      '★★ 两次**不同**结果 ⇒ 去重键**不同**（改前两者都是 `…|content,isError,value|[object Object]`）',
      `${discA}\n      ${discB}`,
    )
    ok(retainDisc({ name: 'pipeline_status', arguments: {} }, REAL_STATUS) === discA, '同一输入 ⇒ 同一把键（"确定性"没被破坏）', discA)
    ok(
      !discA.includes('[object Object]') && !discB.includes('[object Object]'),
      '★ 键里也没有 `[object Object]`（键会进 `id`，也会进排查时的输出）',
      discA,
    )
    await runSeam(seam.hook, { name: 'pipeline_status', arguments: {} }, REAL_STATUS)
    await runSeam(seam.hook, { name: 'pipeline_status', arguments: {} }, REAL_STATUS)
    await runSeam(
      seam.hook,
      { name: 'pipeline_status', arguments: {} },
      envelope({ ok: true, summary: '任务 T-20261015-bb30bc：状态 closed（已关闭）。', state: 'closed' }, '…'),
    )
    ok(
      (await readBank(memoryFile(root))).records.length === 3,
      '★ 同一次事件重放两次 ⇒ 只多 0 条；**换了状态** ⇒ 真的多 1 条（既不去重过头，也不把重复当事实）',
      `条数=${(await readBank(memoryFile(root))).records.length}`,
    )

    // ---- ④ 失败信封：取 `error.message` ---------------------------------------
    lines.push('')
    lines.push('【④ 失败信封（`isError:true`）⇒ 正文取 `error.message`，并写明"失败"】')
    await runSeam(seam.hook, { name: 'pipeline_close', arguments: { task_id: 'T-20261015-bb30bc' } }, REAL_FAIL)
    const fBank = await readBank(memoryFile(root))
    const failRec = fBank.records[fBank.records.length - 1]
    ok(
      typeof failRec?.text === 'string' && failRec.text.includes('失败') && failRec.text.includes('EACCES'),
      '★ 失败信封 ⇒ 正文含 `失败` + `error.message`（改前是 `[object Object]`）',
      String(failRec?.text),
    )
    ok(
      !String(failRec?.text).includes('[object Object]') && !String(failRec?.id).includes('[object Object]'),
      '失败信封的正文与 `id` 都没有 `[object Object]`',
      String(failRec?.id),
    )

    // ---- ⑤ 对象 / 数组 ⇒ 稳定序列化 -------------------------------------------
    lines.push('')
    lines.push('【⑤ 对象 / 数组一律走**稳定序列化**（不是 `String()`、也不是 `[object Array]`）】')
    const objDisc = retainDisc(
      { name: 'pipeline_status', arguments: {} },
      envelope({ ok: true, summary: { zh: '中文摘要', en: 'english summary' }, items: [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }, { e: 5 }] }, ''),
    )
    ok(
      !objDisc.includes('[object Object]') && !objDisc.includes('object Array') && !objDisc.includes('object Object'),
      '★ `summary` 是对象时也不退化成 `[object Object]`',
      objDisc,
    )
    ok(objDisc.includes('中文摘要'), '对象摘要里的**值**读得出来（不是"有个对象"而已）', objDisc)
    if (digest !== null) {
      const a = digest.stableJson({ b: 1, a: 2, c: { z: 1, y: 2 } })
      const b = digest.stableJson({ c: { y: 2, z: 1 }, a: 2, b: 1 })
      ok(a === b && a.length > 0, '★ 键序不同的**同一个对象** ⇒ 序列化逐字相同（键序不影响去重键）', `${a}\n      ${b}`)
      const deep = digest.stableJson({ x: { y: { z: { w: 1 } } } })
      ok(deep.length > 0 && !deep.includes('[object Object]'), '★ 深对象不抛、也不退化成 `[object Object]`（深度有限）', deep)
    } else {
      ok(false, '★ `lib/memory/digest.js` 尚未落地（摘要形状的唯一出处）', digestErr)
    }

    // ---- ⑥ 截断策略：默认值明写 + 真的生效 -----------------------------------
    lines.push('')
    lines.push('【⑥ 截断策略：默认值**明写**在模块里，且上限真的生效（短内容一个字节都不补）】')
    if (digest !== null) {
      const caps = [
        ['DIGEST_TEXT_MAX', 160],
        ['DIGEST_JSON_MAX', 120],
        ['DIGEST_STR_MAX', 40],
        ['DIGEST_DEPTH_MAX', 2],
        ['DIGEST_ITEM_MAX', 4],
        ['DIGEST_KEY_MAX', 120],
        ['DIGEST_DISC_BODY_MAX', 80],
      ]
      const actual = caps.map(([k]) => `${k}=${String(digest[k])}`)
      ok(caps.every(([k, v]) => digest[k] === v), '★★ 七个默认值**逐格钉住**（改一个数就得改这条断言——防悄悄漂移）', actual.join('  '))
      ok(digest.DIGEST_TEXT_MAX === 160, '★ 正文上限**沿用改动前那个 160**（不缩不放：这次只修"不可读"，不顺手改口径）', `DIGEST_TEXT_MAX=${digest.DIGEST_TEXT_MAX}`)

      const longBody = `很长的摘要：${'正文'.repeat(400)}`
      const longText = digest.toolDigest({ name: 'pipeline_status', arguments: {} }, envelope({ ok: true, summary: longBody }, '')).text
      ok(
        longText.length <= TEXT_MAX,
        `★ 2000+ 字的 \`summary\` ⇒ 正文被截断（≤ \`TEXT_MAX\`=${TEXT_MAX}）且带省略号`,
        `实际=${longText.length} 字：…${longText.slice(-12)}`,
      )
      const shortText = digest.toolDigest({ name: 'pipeline_status', arguments: {} }, envelope({ ok: true, summary: '短摘要' }, '')).text
      ok(shortText.endsWith('短摘要') && !shortText.includes('…'), '★ 短内容**不补齐、不加省略号**（上限不是目标长度）', shortText)
      const capped = digest.stableJson({ a: 'x'.repeat(500), b: 2 })
      ok(capped.length <= digest.DIGEST_JSON_MAX, '★ 兜底 JSON 的上限是硬的', `实际=${capped.length} ≤ ${digest.DIGEST_JSON_MAX}`)
      ok(digest.unwrapResult({ isError: false, value: { ok: true }, content: [] }).value?.ok === true, '★ 信封被拆开（`value` 拿得到）', JSON.stringify(digest.unwrapResult(REAL_STATUS).value).slice(0, 60))
      ok(digest.unwrapResult({ ok: true, summary: '裸值' }).envelope === false, '★ **不是信封**的输入按裸值处理（既有夹具与别处调用方不受影响）', `envelope=${digest.unwrapResult({ ok: true }).envelope}`)
    } else {
      ok(false, '★ `lib/memory/digest.js` 尚未落地 ⇒ 六个默认值无从钉起', digestErr)
    }

    // ---- ⑦ 判据自检：把"旧写法"喂给同一条判据 ⇒ 必须红 ------------------------
    lines.push('')
    lines.push('【⑦ 判据自检：这条断言抓得住 `[object Object]`（不是恒绿）】')
    // 旧写法的语义就是 `clip(r.summary ?? r.value ?? '', 160)` —— `String(对象)`。
    const oldWay = String(REAL_STATUS.summary ?? REAL_STATUS.value ?? '')
    ok(oldWay.includes('[object Object]'), '★ 旧写法（`String(信封.value)`）**确实**产出 `[object Object]` —— 这正是真机那两行', oldWay)
    ok(
      !digestTextOrEmpty(digest, REAL_STATUS).includes('[object Object]') && oldWay.includes('[object Object]'),
      '★★ 同一份输入：旧写法红、新写法绿（同一条判据在两种实现上给出不同结论）',
      `旧=${oldWay}\n      新=${digestTextOrEmpty(digest, REAL_STATUS)}`,
    )
    ok(
      String(undefined ?? '') === '' && !String(REAL_RECALL.value).includes('记忆切片'),
      '★ 也证明"信封不是返回值"：`String(信封.value)` 里一个字的信息都没有（所以夹具必须用信封）',
      `String(value)=${String(REAL_RECALL.value).slice(0, 40)}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`m10 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))
  return { passed, total: passed + failed, text: lines.join('\n') }
}

/** 拿 digest 产出的那一行正文；模块没落地时给空串（那条自有断言去红）。 */
function digestTextOrEmpty(digest, result) {
  if (digest === null) return ''
  try {
    return String(digest.toolDigest({ name: 'pipeline_status', arguments: {} }, result).text ?? '')
  } catch {
    return ''
  }
}

/**
 * 聚合跑入口（`tests/run-all.mjs` 登记用）。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runM10MemoryDigestCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ m10 运行失败（异常）：${err?.stack ?? err}`)
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('m10-memory-digest-check.mjs')) {
  const r = await runM10MemoryDigestCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
