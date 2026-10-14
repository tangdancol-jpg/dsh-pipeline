/**
 * dsh-pipeline · **E 路自测**：输出投影（②）+ 按可见工具惰性渲染/收紧（③）
 * ============================================================================
 * 本套只测 E 路那两件事，**正例与反例缺一不可**：
 *
 *   ② 输出模式 + 投影（参考 `dsh-ops` 的 `lib/file/contract.js:20,29` 与
 *      `native/src/results.rs:147-169`）
 *      正例①：`pipeline_status` 传 `detail="summary"` ⇒ 明显更小，但仍含
 *             「状态 / 卡点 / 下一步该谁」，且**数已经算好**（不让调用方去数）
 *      反例①：**不传参数 ⇒ 与改前逐字节一致**（本套的 `--snapshot` / `--compare`
 *             两个模式就是为跨"改前 / 改后"两棵树对比而存在的）
 *
 *   ③ 按"实际可见工具"注册/渲染（参考 `dsh-ops` 的 `lib/index.js:128-139` +
 *      `lib/policy.js:26-66`）
 *      正例②：某席位可见工具面确实变小了（列出来），且它**仍能完成本职**
 *      反例②：**该被守门拒的调用仍被拒**（复跑两条既有反例）
 *      反例③：被"少给定义"的角色，若通过别的方式尝试该工具 ⇒ **不许因此被放行**
 *
 * 跑法：
 *   node tests/e-route-check.mjs                                  # 跑全部检查
 *   node tests/e-route-check.mjs --snapshot out.json              # 只取"不传新参数"的
 *                                                                 # 输出快照（哈希 + 原文）
 *   node tests/e-route-check.mjs --compare before.json after.json # 跨树对比（反例①）
 *
 * ★ 本文件**不改**任何既有测试、不注册进 `run-all.mjs`（那是别人的文件面）；
 *   它自带 `--snapshot` / `--compare`，以便把"默认逐字节不变"证成**可复算的对比**，
 *   而不是靠嘴说。
 *
 * @module dsh-pipeline/tests/e-route-check
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { callTool, createHarness, disposeHarness } from './selftest-core.mjs'
import { createBoundaryFixture } from './boundary-check.mjs'
import { buildTools } from '../lib/tools.js'
import { guardDecision } from '../lib/guard.js'
import { createTokenStore } from '../lib/tokens.js'
import { mergeConfig } from '../lib/config.js'
import * as plugin from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * ★ `lib/boundaries.js` 的 E 路导出（`deriveToolFace` / `parseToolAuthority`）
 *   **必须动态 import**：本套要能在**改动前**那一棵树上跑（`--snapshot` 模式），
 *   而那棵树上这两个符号**不存在** —— 静态 import 会让整个文件在加载期就报
 *   `does not provide an export named`，于是"改前"那份快照根本取不到。
 */
let BD = null
async function boundariesModule() {
  if (BD === null) BD = await import('../lib/boundaries.js')
  return BD
}

/** 极简记录器（本套自带，不依赖别人的 test 工具）。 */
function createRecorder() {
  const items = []
  return {
    items,
    add(group, name, pass, detail) {
      items.push({ group, name, pass: pass === true, detail: String(detail ?? '') })
      return pass === true
    },
    text(title) {
      const lines = [title, '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          lines.push('', `【${g}】`)
        }
        lines.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) lines.push(...it.detail.split('\n').map((l) => `      ${l}`))
      }
      const passed = items.filter((i) => i.pass).length
      lines.push('', '='.repeat(78), `总计：${passed}/${items.length} 通过`, '='.repeat(78))
      return lines.join('\n')
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
  }
}

const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex')
const bytes = (s) => Buffer.byteLength(String(s), 'utf8')

/**
 * ★ 跨树对比用的**规范化**：任务 id 每次都是随机的、安全扫描的落盘路径带时间戳，
 *   这两样在"改前 / 改后"两次运行之间本来就不同 —— 不 mask 掉就永远比不出结论，
 *   而 mask 得太多又会把真差异一起抹掉。所以只 mask **这几样**，其余一个字符都不动。
 */
const normalizeForCompare = (t) =>
  String(t)
    // 夹具每次运行都会新生成的标识：任务 id / 交接物 id / 基线 id / 安全扫描的落盘路径与摘要
    .replace(/T-\d{8}-[0-9a-f]{6}/gi, 'T-FIXTURE')
    .replace(/H-[0-9a-f]{16}/gi, 'H-FIXTURE')
    .replace(/BL-[0-9a-f]{16}/gi, 'BL-FIXTURE')
    // 人工介入请求 id 与"交接物内容摘要"（后者的输入里就含随机 handoff_id ⇒ 每次都不一样）
    .replace(/HR-[0-9a-f]{16}/gi, 'HR-FIXTURE')
    .replace(/RC-[0-9a-f]{16}/gi, 'RC-FIXTURE')
    .replace(/"digest":"[0-9a-f]{8,64}"/gi, '"digest":"STAMP"')
    .replace(/security-scan-[0-9TZ:.\-]+\.json/gi, 'security-scan-STAMP.json')
    .replace(/sha256：[0-9a-f]+…/gi, 'sha256：STAMP…')
    .replace(/"[0-9a-f]{64}"/gi, '"STAMP"')
    // 时间戳：两次运行本来就差几秒（审计行 / 基线记录时刻）—— 不通用的对比没意义
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, 'TS')

/**
 * 工具是不是"E 路改过的那一版"（靠新入参判断，**不靠版本号**）。
 * 改前的树上没有 `detail` ⇒ 快照仍然跑，但新特性的断言会**明确跳过**（不是假装通过）。
 *
 * ★ 两种 schema 形态都要认（与 `lib/tools.js` 的 `parametersFor` 同源）：
 *   `defineTool` 正常 ⇒ 已编译成 `{type:'object',properties:{…}}`；
 *   退化（自测夹具就是这一种，`fakeDefineTool` 是恒等函数）⇒ **裸属性表**。
 */
const propsOf = (def) => def?.parameters?.properties ?? def?.parameters ?? {}
const hasEroute = (def) => propsOf(def).detail !== undefined

/**
 * 取"**不传新参数**"那一组输出的哈希（反例①的判据）。
 *
 * ★ 判据是**模型看到的那段文本**（`output.render` 的产物），不是内部对象：
 *   省字节省的就是它。
 *
 * @returns {Promise<object>} `{ <case>: { sha256, bytes, norm_sha256, norm_bytes, text, norm } }`
 */
async function snapshotCases(h, taskId, tokens, agents) {
  const out = {}
  const render = (name, args) => {
    const def = h.byName.get(name)
    return async (execAgent) => {
      const res = await callTool(h, name, args, execAgent)
      // ★ 被守门拒 / 没有返回值时**照原样记**（别拿 render 去覆盖一句拒绝原文 ——
      //   那会把"这条用例其实没跑到"伪装成"输出是空的"）。
      if (res.denied === true || res.value === undefined) return `【未进入工具：${res.layer}】${res.text}`
      let text = String(res.value.summary ?? '')
      try {
        const rendered = def?.output?.render?.(args, res.value)
        if (Array.isArray(rendered) && typeof rendered[0]?.text === 'string') text = rendered[0].text
      } catch {
        /* render 抛了就退回 summary（如实记录，不假装） */
      }
      return text
    }
  }
  const cases = {
    'status/task': render('pipeline_status', { task_id: taskId, role_token: tokens.main }),
    'status/all': render('pipeline_status', {}),
    'status/audit': render('pipeline_status', { task_id: taskId, role_token: tokens.tester, include_audit: true }),
    'status/fullflag': render('pipeline_status', { task_id: taskId, role_token: tokens.main, full: true }),
    change_audit: render('pipeline_change_audit', { task_id: taskId, role_token: tokens.main }),
    security_check: render('pipeline_security_check', { task_id: taskId, role_token: tokens.reviewer }),
  }
  for (const [key, fn] of Object.entries(cases)) {
    const who = key === 'security_check' ? agents.reviewer : key === 'status/audit' ? agents.tester : agents.main
    const text = await fn(who)
    const norm = normalizeForCompare(text)
    out[key] = { sha256: sha(text), bytes: bytes(text), norm_sha256: sha(norm), norm_bytes: bytes(norm), text, norm }
  }
  return out
}

/**
 * 比较两份快照（改前 / 改后）。
 *
 * ★ 判据分两层，缺一不可：
 *   ① **规范化后逐字节相等**（任务 id / 时间戳这类"每次都不一样"的东西已被 mask）；
 *   ② **原始字节数相等** + 规范化后**没有任何一行不同**（逐行 diff 打出来给人看 ——
 *      不靠"哈希一样"一句带过）。
 */
export function compareSnapshots(before, after) {
  const rows = []
  let ok = true
  for (const key of Object.keys(after.cases)) {
    const a = before.cases?.[key]
    const b = after.cases[key]
    if (a === undefined) {
      rows.push({ key, ok: false, note: '改前那份没有这条用例（无法比较）' })
      ok = false
      continue
    }
    const sameNorm = a.norm_sha256 === b.norm_sha256
    const sameBytes = a.bytes === b.bytes
    const diff = []
    if (!sameNorm) {
      const la = String(a.norm).split('\n')
      const lb = String(b.norm).split('\n')
      for (let i = 0; i < Math.max(la.length, lb.length); i++) {
        if (la[i] !== lb[i]) {
          diff.push(`  行 ${i + 1}\n    改前：${String(la[i]).slice(0, 200)}\n    改后：${String(lb[i]).slice(0, 200)}`)
        }
        if (diff.length >= 6) break
      }
    }
    rows.push({
      key,
      ok: sameNorm && sameBytes,
      note:
        `规范化 sha ${a.norm_sha256.slice(0, 12)}… → ${b.norm_sha256.slice(0, 12)}…　` +
        `原始字节 ${a.bytes} → ${b.bytes}${sameBytes ? '（相等）' : '（**不等**）'}` +
        (diff.length > 0 ? `\n  差异：\n${diff.join('\n')}` : '　规范化后**没有任何一行不同**'),
    })
    if (!(sameNorm && sameBytes)) ok = false
  }
  return { ok, rows }
}

/**
 * 跑 E 路自测。
 *
 * @param {{snapshot?:string}} [opts] - 给了 `snapshot` 就**只**写这份快照（供跨树对比）
 */
export async function runERouteCheck(opts = {}) {
  const rec = createRecorder()
  const open = []
  const f = await createBoundaryFixture()
  open.push(f.h)
  const T = f.taskId
  const statusDef = f.h.byName.get('pipeline_status')
  /**
   * ★ 夹具没派 `reviewer` —— 而安全扫描那条用例需要它。
   *   不补的话那次调用会被守门以"身份不明"拒（如实记下来是好事，但那样测到的
   *   是**守门**不是**扫描**，`security_check` 的紧凑档就永远没被跑到）。
   *   补一个：与夹具**同一条**铸令牌路径（`h.tokens.mint`）。
   */
  f.tokens.reviewer = f.h.tokens.mint({ taskId: T, role: 'reviewer', agentId: 'boundary-reviewer', note: 'e-route-check' }).token
  f.agents.reviewer = 'boundary-reviewer'

  try {
    // =======================================================================
    // 0. 快照（反例①的原料）：**不传任何新参数**时的输出哈希
    // =======================================================================
    {
      const snap = await snapshotCases(f.h, T, f.tokens, f.agents)
      const table = Object.entries(snap)
        .map(([k, v]) => `${k.padEnd(16)} ${String(v.bytes).padStart(7)} B  ${v.norm_sha256.slice(0, 16)}…`)
        .join('\n')
      rec.add('0 快照（默认路径）', '★ 取到"不传新参数"那一组输出的字节数与规范化 sha256（跨树对比用）', Object.keys(snap).length === 6, table)
      if (typeof opts.snapshot === 'string' && opts.snapshot.length > 0) {
        writeFileSync(
          resolve(opts.snapshot),
          JSON.stringify({ plugin: resolve(HERE, '..'), at: new Date().toISOString(), cases: snap }, null, 2),
          'utf8',
        )
      }
      if (hasEroute(statusDef) !== true) {
        rec.add(
          '0 快照（默认路径）',
          '⚠ 这一棵树上**没有** E 路改动（`pipeline_status` 没有 `detail` 入参）⇒ 新特性断言全部跳过（快照仍然有效）',
          true,
          '这正是 `--snapshot` 模式要跑的"改前"那一棵树：它只出快照，不跑新断言。',
        )
        return { passed: rec.passed, total: rec.total, text: rec.text('dsh-pipeline E 路自测（输出投影 + 工具面）') }
      }
    }

    // =======================================================================
    // 正例①：status 的紧凑档 —— 更小，但仍含"状态 / 卡点 / 下一步该谁"
    // =======================================================================
    {
      const call = (args) => callTool(f.h, 'pipeline_status', { task_id: T, role_token: f.tokens.main, ...args }, f.agents.main)
      const rendered = (args, value) => {
        const r = statusDef.output.render(args, value)
        return String(r[0]?.text ?? '')
      }
      const aFull = { task_id: T, role_token: f.tokens.main }
      const aSummary = { ...aFull, detail: 'summary' }
      const aCount = { ...aFull, detail: 'count' }
      const aDetailFull = { ...aFull, detail: 'full' }
      const vFull = (await call({})).value
      const vSummary = (await call({ detail: 'summary' })).value
      const vCount = (await call({ detail: 'count' })).value
      const vDetailFull = (await call({ detail: 'full' })).value

      const tFull = rendered(aFull, vFull)
      const tSummary = rendered(aSummary, vSummary)
      const tCount = rendered(aCount, vCount)
      const tDetailFull = rendered(aDetailFull, vDetailFull)

      rec.add(
        '① status 紧凑档',
        '★ `detail="summary"` 明显更小（省 ≥ 50%）',
        bytes(tSummary) < bytes(tFull) * 0.5,
        `全文 ${bytes(tFull)} B → summary ${bytes(tSummary)} B（省 ${bytes(tFull) - bytes(tSummary)} B，` +
          `${(100 - (bytes(tSummary) / bytes(tFull)) * 100).toFixed(1)}%）\ncount ${bytes(tCount)} B`,
      )
      const need = ['卡点', '下一步该谁', '计数：']
      const missing = need.filter((s) => !tSummary.includes(s))
      rec.add(
        '① status 紧凑档',
        '★ summary 仍能看出「**有没有卡、卡在哪、下一步该谁**」',
        missing.length === 0 && /卡点（\d+）/.test(tSummary) && /下一步该谁（主链 \d+ 方）/.test(tSummary),
        missing.length > 0 ? `缺少：${missing.join(' / ')}` : tSummary.split('\n').slice(0, 6).join('\n'),
      )
      rec.add(
        '① status 紧凑档',
        '★ summary 里**不依赖调用方自己去数**：总数与分布已经算好（交接物 / 分布 / 打回 / 待办 / 席位）',
        /计数：交接物 \d+/.test(tSummary) &&
          /打回 编写\d+\/\d+ 测试\d+\/\d+/.test(tSummary) &&
          /席位 \d+（失联 \d+）/.test(tSummary),
        tSummary.split('\n').filter((l) => l.startsWith('计数：')).join('\n'),
      )
      rec.add(
        '① status 紧凑档',
        '★ `detail="count"` 比 summary 还小，且同样带卡点与计数',
        bytes(tCount) < bytes(tSummary) && /卡点 \d+ 个/.test(tCount) && /计数：/.test(tCount),
        tCount,
      )
      rec.add(
        '① status 紧凑档',
        '★ `detail="full"` 与**不传 detail** 逐字节相同（"要全文"没有第二条口径）',
        tDetailFull === tFull && sha(tDetailFull) === sha(tFull),
        `full=${sha(tDetailFull).slice(0, 16)}…  不传=${sha(tFull).slice(0, 16)}…  长度 ${bytes(tDetailFull)} / ${bytes(tFull)}`,
      )
      rec.add(
        '① status 紧凑档',
        '★ 紧凑档**不吞掉结构化字段**（同一份 `hash_gate` / `liveness` / `change_scope`，只是正文变短）',
        JSON.stringify(vSummary.hash_gate ?? null) === JSON.stringify(vFull.hash_gate ?? null) &&
          JSON.stringify(vSummary.change_scope ?? null) === JSON.stringify(vFull.change_scope ?? null) &&
          vSummary.ok === true,
        `hash_gate 一致=${JSON.stringify(vSummary.hash_gate ?? null) === JSON.stringify(vFull.hash_gate ?? null)}　` +
          `change_scope 一致=${JSON.stringify(vSummary.change_scope ?? null) === JSON.stringify(vFull.change_scope ?? null)}`,
      )
      // --- ② 的投影：`fields` 只回点名的字段（模型看到的就是它的产物）---
      const projected = (args, value) => String(statusDef.output.render(args, value)?.[0]?.text ?? '')
      const pick = await call({ fields: ['state', 'hash_gate'] })
      const tPick = projected({ fields: ['state', 'hash_gate'] }, pick.value)
      rec.add(
        '① fields 投影',
        '★ `fields=[…]` 只回点名的字段（`ok` 永远保留；其余一概不发）',
        tPick.startsWith('{') && tPick.includes('"state"') && !tPick.includes('交接物') && bytes(tPick) < bytes(tFull),
        `${bytes(tPick)} B：${tPick.slice(0, 240)}`,
      )
      const badField = await call({ fields: ['state', '不存在的字段'] })
      const tBad = projected({ fields: ['state', '不存在的字段'] }, badField.value)
      rec.add(
        '① fields 投影',
        '★ 点名了不存在的字段 ⇒ **不静默吞掉**（列进 `_unknown_fields`）',
        tBad.includes('_unknown_fields') && tBad.includes('不存在的字段'),
        tBad.slice(0, 240),
      )
    }

    // =======================================================================
    // 反例①（同一棵树内可证的那一半）：不传 / 传 full ⇒ 与"旧口径"逐字节一致
    // =======================================================================
    {
      const v1 = (await callTool(f.h, 'pipeline_status', { task_id: T, role_token: f.tokens.main }, f.agents.main)).value
      const v2 = (await callTool(f.h, 'pipeline_status', { task_id: T, role_token: f.tokens.main }, f.agents.main)).value
      const auditNoPage = (await callTool(f.h, 'pipeline_change_audit', { task_id: T, role_token: f.tokens.main }, f.agents.main)).value
      rec.add(
        '① 默认路径',
        '★ 不传新参数 ⇒ 稳定复现（两次调用逐字节相同：没有"每次都不一样的正文"）',
        sha(v1.summary) === sha(v2.summary),
        `${sha(v1.summary).slice(0, 16)}… == ${sha(v2.summary).slice(0, 16)}…（${bytes(v1.summary)} B）`,
      )
      rec.add(
        '① 默认路径',
        '★ `page` 不传 ⇒ 交接物一节**保持原样**（没有凭空多出分页脚注）',
        !String(v1.summary).includes('交接物本段') && !String(auditNoPage.summary).includes('明细本段'),
        `status 含"交接物本段"=${String(v1.summary).includes('交接物本段')}　` +
          `change_audit 含"明细本段"=${String(auditNoPage.summary).includes('明细本段')}`,
      )
      const many = await callTool(f.h, 'pipeline_change_audit', { task_id: T, role_token: f.tokens.main, detail: 'summary' }, f.agents.main)
      rec.add(
        '① 默认路径',
        '★ 紧凑档截断时**给出 page/total 与"下一段怎么取"**（不靠"看起来像完了"）',
        /本段 \d+\/\d+，共 \d+ 条/.test(String(many.value?.summary ?? '')) ||
          String(many.value?.summary ?? '').includes('（一个文件都没动）'),
        String(many.value?.summary ?? '')
          .split('\n')
          .filter((l) => l.includes('本段') || l.includes('明细'))
          .join('\n'),
      )
      // 显式 page 时才分页：真造一条长清单（25 个新增文件）看看能不能续页。
      // ★ 这一段放在**最后**跑的其他检查之后不影响它们：上面用到的 status / 安全扫描
      //   都已经跑完（快照在第 0 节就取过了），这里只动 `change_audit` 的明细面。
      mkdirSync(join(f.h.projectRoot, 'src', 'gen'), { recursive: true })
      for (let i = 1; i <= 25; i++) writeFileSync(join(f.h.projectRoot, 'src', 'gen', `f${String(i).padStart(2, '0')}.js`), `// ${i}\n`, 'utf8')
      const p1 = await callTool(f.h, 'pipeline_change_audit', { task_id: T, role_token: f.tokens.main, page: 1 }, f.agents.main)
      const p2 = await callTool(f.h, 'pipeline_change_audit', { task_id: T, role_token: f.tokens.main, page: 2 }, f.agents.main)
      const s1 = String(p1.value?.summary ?? '')
      const s2 = String(p2.value?.summary ?? '')
      rec.add(
        '① 默认路径',
        '★ 显式给 `page` ⇒ 长明细分段 + **写明 page/total 与"下一段怎么取"**（`page` 不传时不会出现，见上一条）',
        s1.includes('明细本段 1/2，共 25 条') && s1.includes('page: 2') && s2.includes('  + src/gen/f21.js') && !s2.includes('页脚'),
        `第 1 段脚注：${s1.split('\n').filter((l) => l.includes('明细本段')).join(' ')}\n` +
          `第 2 段首条：${s2.split('\n').filter((l) => l.includes('src/gen/')).slice(0, 2).join(' ')}`,
      )
      // 紧凑档同样要给出续页口径（明细分页，且**结论与计数一个字不少**）
      const c1 = await callTool(f.h, 'pipeline_change_audit', { task_id: T, role_token: f.tokens.main, detail: 'summary' }, f.agents.main)
      const cs = String(c1.value?.summary ?? '')
      const c2 = await callTool(f.h, 'pipeline_change_audit', { task_id: T, role_token: f.tokens.main, detail: 'summary', page: 1 }, f.agents.main)
      const cs2 = String(c2.value?.summary ?? '')
      rec.add(
        '① 默认路径',
        '★ 紧凑档：结论 / 多改 / 少改 / `change_audit` 那行**一条不少**，且明细**给出"共几条、怎么取"**（不展开、不静默截断）',
        cs.includes('结论：') &&
          cs.includes('多改') &&
          cs.includes('少改') &&
          cs.includes('change_audit = {') &&
          cs.includes('明细：共 25 条') &&
          cs.includes('page: 1') &&
          // 显式给 page 时才真分页（两档行为一致）
          cs2.includes('明细（本段 1/2，共 25 条）'),
        `${cs.split('\n').filter((l) => l.includes('明细：')).join(' ')}\n` +
          `（带 page 时）${cs2.split('\n').filter((l) => l.includes('明细（')).join(' ')}`,
      )
    }

    // =======================================================================
    // 正例①（续）：另外两个只读导出的紧凑档同样"更小但不丢关键信息"
    // =======================================================================
    {
      const caFull = await callTool(f.h, 'pipeline_change_audit', { task_id: T, role_token: f.tokens.main }, f.agents.main)
      const caSum = await callTool(f.h, 'pipeline_change_audit', { task_id: T, role_token: f.tokens.main, detail: 'summary' }, f.agents.main)
      const caCnt = await callTool(f.h, 'pipeline_change_audit', { task_id: T, role_token: f.tokens.main, detail: 'count' }, f.agents.main)
      const caFullT = String(caFull.value?.summary ?? '')
      const caSumT = String(caSum.value?.summary ?? '')
      const caCntT = String(caCnt.value?.summary ?? '')
      rec.add(
        '① change_audit 紧凑档',
        '★ `summary` 更小（不重复展开逐文件明细），但**结论 / 多改 / 少改 / change_audit 那行一条不少**',
        bytes(caSumT) < bytes(caFullT) &&
          ['结论：', '多改', '少改', 'change_audit = {', '明细：共 25 条'].every((s) => caSumT.includes(s)) &&
          bytes(caCntT) < bytes(caSumT) &&
          caCntT.includes('change_audit = {'),
        `全文 ${bytes(caFullT)} B → summary ${bytes(caSumT)} B → count ${bytes(caCntT)} B\n` +
          caSumT.split('\n').slice(0, 3).join('\n'),
      )
      // ★ "先用最便宜的投影探路"：只看结论与基线 id —— 这才是 `fields` 的用法
      const caRender = (args, value) => String(f.h.byName.get('pipeline_change_audit').output.render(args, value)?.[0]?.text ?? '')
      const caPickArgs = { task_id: T, role_token: f.tokens.main, fields: ['verdict', 'baseline_id'] }
      const caPick = await callTool(f.h, 'pipeline_change_audit', caPickArgs, f.agents.main)
      const caPickT = caRender(caPickArgs, caPick.value)
      const caPick2Args = { task_id: T, role_token: f.tokens.main, fields: ['verdict', 'unauthorized'] }
      const caPick2 = await callTool(f.h, 'pipeline_change_audit', caPick2Args, f.agents.main)
      const caPick2T = caRender(caPick2Args, caPick2.value)
      rec.add(
        '① change_audit 紧凑档',
        '★ **探路用法**：`fields=["verdict","baseline_id"]` ⇒ 只回这两样（几十字节），确认"有多改"之后再点名要清单',
        caPickT.startsWith('{') &&
          caPickT.includes('"verdict"') &&
          caPickT.includes('"baseline_id"') &&
          bytes(caPickT) < 200 &&
          // 点名要清单时它才变大（"要什么给什么"，不是"永远小"）
          bytes(caPick2T) > bytes(caPickT) &&
          caPick2T.includes('"unauthorized"'),
        `${bytes(caPickT)} B（verdict+baseline_id）：${caPickT}\n` +
          `${bytes(caPick2T)} B（+unauthorized，25 条）：${caPick2T.slice(0, 120)}…`,
      )
      const scFull = await callTool(f.h, 'pipeline_security_check', { task_id: T, role_token: f.tokens.reviewer }, f.agents.reviewer)
      const scSum = await callTool(f.h, 'pipeline_security_check', { task_id: T, role_token: f.tokens.reviewer, detail: 'summary' }, f.agents.reviewer)
      const scCnt = await callTool(f.h, 'pipeline_security_check', { task_id: T, role_token: f.tokens.reviewer, detail: 'count' }, f.agents.reviewer)
      const scFullT = String(scFull.value?.summary ?? '')
      const scSumT = String(scSum.value?.summary ?? '')
      const scCntT = String(scCnt.value?.summary ?? '')
      rec.add(
        '① security_check 紧凑档',
        '★ `count` 只回**算好的计数**与建议结论，但 `checks_ref` / `attestation_hint` / `finding_count` **该在的一个不少**',
        bytes(scCntT) < bytes(scFullT) &&
          /计数（算好的）：合计 \d+ 处/.test(scCntT) &&
          scCntT.includes('★ 建议结论：attestation=') &&
          String(scCnt.value?.checks_ref ?? '').length > 0 &&
          String(scSum.value?.checks_ref ?? '').length > 0 &&
          scCnt.value?.attestation_hint === scFull.value?.attestation_hint &&
          scCnt.value?.finding_count === scFull.value?.finding_count,
        `全文 ${bytes(scFullT)} B → summary ${bytes(scSumT)} B → count ${bytes(scCntT)} B\n` +
          scCntT.split('\n').slice(0, 4).join('\n') +
          `\n★ 三次扫描的 checks_ref 各不相同是**既有行为**（每次扫描落一份带时间戳的报告），不是本次改动。`,
      )
      rec.add(
        '① security_check 紧凑档',
        '★ 紧凑档**不动判据**：扫描范围 / 命中数 / `attestation_hint` 与全文档逐字相同',
        scSum.value?.finding_count === scFull.value?.finding_count &&
          scCnt.value?.finding_count === scFull.value?.finding_count &&
          scSum.value?.attestation_hint === scFull.value?.attestation_hint &&
          String(scSumT).includes('扫描范围：') &&
          String(scCntT).includes('扫描范围：'),
        `finding_count ${scFull.value?.finding_count} / ${scSum.value?.finding_count} / ${scCnt.value?.finding_count}　` +
          `hint=${scCnt.value?.attestation_hint}　三档都带"扫描范围"=${String(scSumT).includes('扫描范围：')}`,
      )
      // 列全部任务的紧凑档（要真看出差别，就得有一张**需求很长的**单）
      const longReq = `给订单系统加导出：${'接口层、数据层、处理层三块并行推进，接口契约先冻结；'.repeat(8)}（完）`
      const opened2 = await callTool(f.h, 'pipeline_task_open', { requirement: longReq }, f.agents.main)
      const allFull = await callTool(f.h, 'pipeline_status', {}, 'e-route-list-agent')
      const allSum = await callTool(f.h, 'pipeline_status', { detail: 'summary' }, 'e-route-list-agent')
      const allCnt = await callTool(f.h, 'pipeline_status', { detail: 'count' }, 'e-route-list-agent')
      const tFullList = String(allFull.value?.summary ?? '')
      const tSumList = String(allSum.value?.summary ?? '')
      const tCntList = String(allCnt.value?.summary ?? '')
      const maxLine = (t) => Math.max(...t.split('\n').map((l) => bytes(l)))
      rec.add(
        '① 列表紧凑档',
        '★ 列全部任务也有紧凑档：**状态分布已经算好**，需求正文被**截断 / 去掉**（那才是这一节的大头）',
        typeof opened2.value?.task_id === 'string' &&
          tSumList.includes('状态分布（算好的）') &&
          // ★ 判据用**最长一行**：全文那一行含整段需求；summary 把它 clamp 到 80 字符；count 干脆不带
          maxLine(tSumList) < maxLine(tFullList) &&
          maxLine(tCntList) < maxLine(tSumList) &&
          !tCntList.includes('订单系统加导出'),
        `最长一行：全文 ${maxLine(tFullList)} B → summary ${maxLine(tSumList)} B → count ${maxLine(tCntList)} B\n` +
          `总数：全文 ${bytes(tFullList)} B → summary ${bytes(tSumList)} B → count ${bytes(tCntList)} B\n` +
          tSumList.split('\n').slice(0, 4).join('\n'),
      )
    }

    // =======================================================================
    // 正例②：某席位可见工具面确实变小了，且它【仍能完成本职】
    // =======================================================================
    {
      const BD = await boundariesModule()
      const { deriveToolFace, parseToolAuthority } = BD
      const judge = (name) => guardDecision({ name, arguments: {} }, { tokens: f.h.tokens })
      const toolNames = Object.values(f.h.tools).map((d) => d.name)
      /**
       * ★★ **事件级工具**（入参里有 `event`，如 `pipeline_transition`）——
       *   从**真实注册定义**推导（`eventLevelToolNames`），不手抄名单。
       *   它的权限是**逐事件**判的（状态机 `TRANSITIONS[].by` + store 的前置条件），
       *   所以工具面这一层**不按角色收紧**它（2026-10-14 回归修复）。
       *   改前那棵树上没有这个导出 ⇒ 取空集（快照模式在更早处就返回了，不受影响）。
       */
      const eventLevelTools = typeof BD.eventLevelToolNames === 'function' ? BD.eventLevelToolNames(Object.values(f.h.tools)) : []
      const faceOf = (names, j) => deriveToolFace({ toolNames: names, judge: j, eventLevel: eventLevelTools })
      const face = faceOf(toolNames, judge)
      const w = face.by_role.writer
      const m = face.by_role.main
      rec.add(
        '② 工具面',
        '★ 工具面**从守门判词里读**（不手抄白名单）—— 判词可解析、覆盖全部工具',
        face.source.startsWith('guard:guardDecision') &&
          face.tool_count === toolNames.length &&
          parseToolAuthority(judge('pipeline_dispatch'))?.includes('main') === true,
        `工具数=${face.tool_count}　writer 可见 ${w.visible_count} / 隐藏 ${w.hidden_count}\n` +
          `writer 被隐藏：${w.denied.join('、')}`,
      )
      rec.add(
        '② 工具面',
        '★ 例子成立：writer **看不到** dispatch / close / supervise（它本来就被守门拒）',
        ['pipeline_dispatch', 'pipeline_close', 'pipeline_supervise'].every((t) => w.denied.includes(t)),
        `denied 里含这三条=${['pipeline_dispatch', 'pipeline_close', 'pipeline_supervise'].every((t) => w.denied.includes(t))}`,
      )
      rec.add(
        '② 工具面',
        '★ 口径：**主对话看到全量**（`main.denied` 为空 —— 它是用户的对话框，也是该知道有哪些工具的那一方）',
        m.denied.length === 0 && face.tightening.applies_to_main === false,
        `main hidden（守门口径）=${m.hidden_count}　实际收紧=${m.denied.length}　why=${m.why}`,
      )
      // --- 本职仍能完成：可见面 ⊇ 守门放行的面（逐个工具跑守门）---
      //
      // ★ 这份清单**按守门白名单核对过**（不是"我觉得它需要"）：
      //   例如 tester 不在 `pipeline_security_check` 的允许角色里
      //   （`lib/guard.js` 的 `PIPELINE_TOOL_ROLES` = reviewer / security / main / human）
      //   —— 那一条安全扫描是**审核**跑的，所以它不在 tester 的本职清单里。
      const essential = {
        writer: ['pipeline_bind_role', 'pipeline_status', 'pipeline_handoff', 'pipeline_artifact', 'pipeline_clarify_request', 'pipeline_record_submit'],
        tester: ['pipeline_bind_role', 'pipeline_status', 'pipeline_handoff', 'pipeline_rework', 'pipeline_full_test', 'pipeline_record_submit'],
        reviewer: ['pipeline_bind_role', 'pipeline_status', 'pipeline_handoff', 'pipeline_rework', 'pipeline_change_audit', 'pipeline_security_check'],
      }
      const losses = []
      for (const [role, tools] of Object.entries(essential)) {
        for (const t of tools) {
          if (!face.by_role[role].visible.includes(t)) losses.push(`${role} 丢了 ${t}`)
        }
      }
      rec.add(
        '② 工具面',
        '★ **不得漏**：每个角色的"本职工具"都在可见面上（writer/tester/reviewer 逐个点名）',
        losses.length === 0,
        losses.length === 0
          ? Object.entries(essential).map(([r, ts]) => `${r}: ${ts.join('、')}`).join('\n')
          : `丢了：${losses.join(' / ')}`,
      )
      // 机械判据：可见 ⇔ 守门放行、隐藏 ⇔ 守门拒（双向不变式）
      //
      // ★★ 2026-10-14 回归修复带来的**唯一**一处判据收窄，写在明处、不静默：
      //   **事件级工具**（入参里有 `event`）不按角色收紧 —— 它的权限是**逐事件**判的
      //   （状态机 `TRANSITIONS[].by` + `store.transition` 的逐事件前置条件），
      //   而守门那一行工具白名单（`pipeline_transition` = `main / human`）比它**粗**
      //   （`dev_submitted` 的 `by` 名单里明明写着 `writer`）。对这一类，判据换成
      //   **另一条同样机械、且更强**的：该角色必须**真是某个事件的 actor**
      //   （出现在 `TRANSITIONS[].by` 里），而且这个工具**必须可见、不得进 deny 面**。
      //   ★ 除这一类以外，双向不变式**一个字没放宽**；被豁免的 (角色 × 工具) 逐对打出来。
      const eventActors = new Set()
      const { TRANSITIONS } = await import('../lib/states.js')
      for (const tr of TRANSITIONS) for (const r of tr.by ?? []) eventActors.add(String(r))
      const wrongHidden = []
      const eventLevelExempt = []
      for (const role of ['writer', 'tester', 'reviewer', 'planner']) {
        const tokenRec = f.h.tokens.mint({ taskId: T, role, agentId: `e-route-${role}`, note: 'e-route-check' })
        for (const t of Object.values(f.h.tools).map((d) => d.name)) {
          const deniedByGuard = guardDecision({ name: t, arguments: { task_id: T, role_token: tokenRec.token } }, { tokens: f.h.tokens }) !== undefined
          const visible = face.by_role[role].visible.includes(t)
          if (eventLevelTools.includes(t)) {
            // 事件级：必须可见 + 不得被收紧 + 该角色必须真是某个事件的 actor（有据可依）
            if (!visible) wrongHidden.push(`${role} 看不见事件级工具：${t}`)
            if (face.by_role[role].denied.includes(t)) wrongHidden.push(`${role} 的事件级工具仍被收紧：${t}`)
            if (!eventActors.has(role)) wrongHidden.push(`${role} 不是任何事件的 actor，却看得到事件级工具：${t}`)
            if (deniedByGuard) eventLevelExempt.push(`${role}×${t}`)
            continue
          }
          // 不变量①：可见的工具，守门不该拒（否则"看见了却用不了"= 误导）
          // 不变量②：隐藏的工具，守门必须拒（否则就是**藏掉了它需要的**）
          if (visible && deniedByGuard) wrongHidden.push(`${role} 看得见但守门拒：${t}`)
          if (!visible && !deniedByGuard) wrongHidden.push(`${role} 被隐藏但守门放行：${t}`)
        }
      }
      rec.add(
        '② 工具面',
        '★★ **不变式**（逐角色 × 逐工具跑真守门）：可见 ⇔ 守门放行、隐藏 ⇔ 守门拒 —— 一条都不许错',
        wrongHidden.length === 0,
        wrongHidden.length === 0
          ? `4 个角色 × ${Object.values(f.h.tools).length} 个工具 = ${4 * Object.values(f.h.tools).length} 组判定，全部满足双向不变式。` +
            (eventLevelExempt.length === 0
              ? ''
              : `\n★ 其中 ${eventLevelExempt.length} 对是**事件级工具**（${eventLevelTools.join('、')}）：守门那一行白名单比状态机的 by 名单粗，` +
                `故按"该角色是不是某个事件的 actor"判 —— 逐对列出：${eventLevelExempt.join('、')}`)
          : wrongHidden.slice(0, 8).join('\n'),
      )
      // --- 真正的收紧动作：给宿主递了什么 deny ---
      f.h.tokens.mint({ taskId: T, role: 'writer', seat: 'writer#1', agentId: 'e-route-tight-writer', note: 'e-route-check' })
      const granted = []
      const tightener = plugin.createSeatFaceTightener({
        tokens: f.h.tokens,
        config: mergeConfig({}),
        sw: { isOn: () => true },
        face: () => face,
        warn: (msg) => granted.push(`warn: ${msg}`),
      })
      const writerAgent = { id: 'e-route-tight-writer', ctx: { tools: { restrict(filter) { granted.push(filter); return () => {} } } } }
      tightener({ agent: writerAgent })
      const first = granted[0]
      tightener({ agent: writerAgent })
      tightener({ agent: { id: 'e-route-tight-writer' } })
      rec.add(
        '② 工具面',
        '★ 收紧**真的**发生了：给宿主的 `restrict({deny})` 逐字等于推导出来的隐藏面，且**幂等**（同一会话只收一次）',
        granted.length === 1 &&
          Array.isArray(first?.deny) &&
          JSON.stringify([...first.deny].sort()) === JSON.stringify([...w.denied].sort()),
        `restrict 调用 ${granted.length} 次（tighten 被调 3 次）\ndeny(${first?.deny?.length} 个)=${(first?.deny ?? []).join('、')}`,
      )
      rec.add(
        '② 工具面',
        '★ 主对话**不收紧**：同一个施加器对 main 一个 `restrict` 都不调',
        (() => {
          f.h.tokens.mint({ taskId: T, role: 'main', agentId: 'e-route-tight-main', note: 'e-route-check' })
          const calls = []
          const t2 = plugin.createSeatFaceTightener({
            tokens: f.h.tokens,
            config: mergeConfig({}),
            sw: { isOn: () => true },
            face: () => face,
            warn: () => {},
          })
          const r = t2({ agent: { id: 'e-route-tight-main', ctx: { tools: { restrict(f2) { calls.push(f2) } } } } })
          return calls.length === 0 && r?.restricted === false
        })(),
        'main 的 deny 面为空 ⇒ 一次 restrict 都没调（口径：主对话看全量）',
      )
      // --- 提示词侧：按可见工具惰性渲染 ---
      const full = plugin.PIPELINE_PROMPT
      const seatText = plugin.renderPromptForContext({ agent: { id: 'e-route-tight-writer' } }, { tokens: f.h.tokens, face: () => face })
      const last = plugin.lastPromptRender() // ★ 紧跟着读（下一次渲染会覆盖它）
      const seatAgain = plugin.renderPromptForContext({ agent: { id: 'e-route-tight-main' } }, { tokens: f.h.tokens, face: () => face })
      const noCtx = plugin.renderPromptForContext(undefined, { tokens: f.h.tokens, face: () => face })
      rec.add(
        '② 提示词',
        '★ 席位那一份**更小**，且**只广告它真能用的工具**（清单 = 可见面，且不含它调不动的）',
        bytes(seatText) < bytes(full) &&
          seatText.includes(`可见**的流水线工具 ${w.visible.length} 个`) &&
          !seatText.includes('pipeline_dispatch'),
        `全文 ${bytes(full)} B → 席位 ${bytes(seatText)} B（省 ${bytes(full) - bytes(seatText)} B）\n` +
          `渲染结论：${JSON.stringify({ mode: last?.mode, role: last?.role, tools: last?.tools })}`,
      )
      rec.add(
        '② 提示词',
        '★ **默认逐字节不变**：主对话 / 拿不到 context ⇒ 原样返回 `PIPELINE_PROMPT`',
        seatAgain === full && noCtx === full,
        `main 相同=${seatAgain === full}（${bytes(seatAgain)} B）　无 context 相同=${noCtx === full}（${bytes(noCtx)} B）`,
      )
      const unbound = plugin.renderPromptForContext({ agent: { id: 'e-route-nobody' } }, { tokens: f.h.tokens, face: () => face })
      rec.add(
        '② 提示词',
        '★ 没认领角色的会话也拿全文（不猜"它可能是谁"），且**理由可查**',
        unbound === full && plugin.lastPromptRender()?.reason?.includes('还没认领角色') === true,
        `相同=${unbound === full}　理由=${plugin.lastPromptRender()?.reason}`,
      )
    }

    // =======================================================================
    // 反例②：该被守门拒的调用**仍被拒**（复跑两条既有反例）
    // =======================================================================
    {
      const close = await callTool(f.h, 'pipeline_close', { task_id: T, role_token: f.tokens['writer#1'] }, f.agents['writer#1'])
      const dispatch = await callTool(f.h, 'pipeline_dispatch', { task_id: T, role: 'writer', role_token: f.tokens.tester }, f.agents.tester)
      rec.add(
        '② 反例：守门不放宽',
        '★ 编写调 `pipeline_close` ⇒ **仍被守门拒**（判据一个字没动）',
        close.denied === true && close.layer === 'guard' && close.text.includes('角色越权被拦下'),
        `${close.layer}: ${close.text.split('\n').slice(0, 4).join(' / ')}`,
      )
      rec.add(
        '② 反例：守门不放宽',
        '★ 测试调 `pipeline_dispatch` ⇒ **仍被守门拒**',
        dispatch.denied === true && dispatch.layer === 'guard' && dispatch.text.includes('允许角色'),
        `${dispatch.layer}: ${dispatch.text.split('\n').slice(0, 4).join(' / ')}`,
      )
    }

    // =======================================================================
    // 反例③：被"少给定义"的角色，若通过别的方式尝试 ⇒ **不许因此被放行**
    // =======================================================================
    {
      const BD3 = await boundariesModule()
      const { deriveToolFace } = BD3
      const judge = (name) => guardDecision({ name, arguments: {} }, { tokens: f.h.tokens })
      /** ★ 与正例②**同一份**推导（事件级工具不按角色收紧）。 */
      const eventLevelTools =
        typeof BD3.eventLevelToolNames === 'function' ? BD3.eventLevelToolNames(Object.values(f.h.tools)) : []
      const face = deriveToolFace({
        toolNames: Object.values(f.h.tools).map((d) => d.name),
        judge,
        eventLevel: eventLevelTools,
      })
      const hidden = face.by_role.writer.denied
      const tok = f.h.tokens.mint({ taskId: T, role: 'writer', seat: 'writer#2', agentId: 'e-route-bypass', note: 'e-route-check' })
      // "别的方式"①：绕过可见面，直接拿令牌 + 工具名问守门（等价于工具仍可被寻址）
      const stillDenied = hidden.filter(
        (t) => guardDecision({ name: t, arguments: { task_id: T, role_token: tok.token } }, { tokens: f.h.tokens }) !== undefined,
      )
      rec.add(
        '③ 反例：少给定义 ≠ 放行',
        '★★ 隐藏的每一个工具，**守门仍逐个拒**（可见面被拿掉 ≠ 判据被拿掉）',
        stillDenied.length === hidden.length && hidden.length > 0,
        `${hidden.length} 个隐藏工具里，守门仍拒 ${stillDenied.length} 个：${stillDenied.slice(0, 6).join('、')}…`,
      )
      // "别的方式"②：不吃 agent 工具面，直接 execute —— 工具层自己也要拒
      const direct = await f.h.byName
        .get('pipeline_close')
        .execute({ task_id: T, role_token: tok.token }, { name: 'pipeline_close', arguments: {}, agent: { id: 'e-route-bypass' } })
      rec.add(
        '③ 反例：少给定义 ≠ 放行',
        '★ 即使**绕过可见面直接调 execute**，结果仍是 `ok:false`（没有"因为没注册所以没人管"的缝）',
        direct?.ok === false,
        `ok=${String(direct?.ok)}　摘要首行：${String(direct?.summary ?? '').split('\n')[0]}`,
      )
      // 反方向：不许**少给**——可见面里不许有"其实守门会拒"的工具
      //
      // ★★ 唯一的例外是**事件级工具**（判据同上面那条不变式：权限逐事件判，
      //   守门那一行白名单比状态机的 `by` 名单粗）。例外**不静默**：
      //   逐对列出来，并且额外要求"这个角色确实是某个事件的 actor"。
      {
        const { TRANSITIONS } = await import('../lib/states.js')
        const actors = new Set()
        for (const tr of TRANSITIONS) for (const r of tr.by ?? []) actors.add(String(r))
        const overHidden = face.by_role.writer.visible.filter(
          (t) =>
            !eventLevelTools.includes(t) &&
            guardDecision({ name: t, arguments: { task_id: T, role_token: tok.token } }, { tokens: f.h.tokens }) !== undefined,
        )
        const exempted = eventLevelTools.filter((t) => face.by_role.writer.visible.includes(t))
        rec.add(
          '③ 反例：少给定义 ≠ 放行',
          '★ 反方向也不许出事：可见面里**没有**一个"其实守门会拒"的工具（否则就是骗它去撞墙）',
          overHidden.length === 0 && exempted.every((t) => actors.has('writer') && !face.by_role.writer.denied.includes(t)),
          overHidden.length === 0
            ? `可见面 ${face.by_role.writer.visible.length} 个里，非事件级工具 100% 可用。` +
              (exempted.length === 0
                ? ''
                : `\n★ 事件级工具 ${exempted.join('、')} 例外（权限逐事件判，不是逐角色）：writer ${actors.has('writer') ? '是' : '不是'}某个事件的 actor，` +
                  `且它不在 writer 的 deny 面里 —— 这类工具**本来就该在可见面上**。`)
            : overHidden.join('、'),
        )
      }
      // 收紧失败时**退回全量**（不是退回"什么都不给"）
      const fallback = []
      const t3 = plugin.createSeatFaceTightener({
        tokens: f.h.tokens,
        config: mergeConfig({}),
        sw: { isOn: () => true },
        face: () => face,
        warn: (m) => fallback.push(m),
      })
      const noScope = t3({ agent: { id: 'e-route-tight-writer' } })
      rec.add(
        '③ 反例：少给定义 ≠ 放行',
        '★ 拿不到 `agent.ctx.tools.restrict` ⇒ **退回全量可见**（= 改前行为）+ 一条 warn，**不静默**',
        noScope?.restricted === false &&
          String(noScope?.note ?? '').includes('退回全量可见') &&
          fallback.length === 1 &&
          fallback[0].includes('收紧不可用'),
        `restricted=${String(noScope?.restricted)}　note=${String(noScope?.note)}\nwarn=${fallback[0] ?? '（无）'}`,
      )
      rec.add(
        '③ 反例：少给定义 ≠ 放行',
        '★ 连角色都认不出（没绑定的会话）⇒ 返回 `null`，一个动作都不做',
        (() => {
          const calls2 = []
          const t4 = plugin.createSeatFaceTightener({
            tokens: f.h.tokens,
            config: mergeConfig({}),
            sw: { isOn: () => true },
            face: () => face,
            warn: () => {},
          })
          const r = t4({ agent: { id: 'e-route-nobody-at-all', ctx: { tools: { restrict(x) { calls2.push(x) } } } } })
          return r === null && calls2.length === 0
        })(),
        '未认领角色的会话：不猜、不动（等它认领）',
      )
      rec.add(
        '③ 反例：少给定义 ≠ 放行',
        '★ 守门被关（`guardEnabled:false`）时**一次都不收紧**（不去"比守门更严"）',
        (() => {
          f.h.tokens.mint({ taskId: T, role: 'writer', seat: 'writer#3', agentId: 'e-route-guardoff', note: 'e-route-check' })
          const calls3 = []
          const t5 = plugin.createSeatFaceTightener({
            tokens: f.h.tokens,
            config: mergeConfig({ guardEnabled: false }),
            sw: { isOn: () => true },
            face: () => face,
            warn: () => {},
          })
          const r = t5({ agent: { id: 'e-route-guardoff', ctx: { tools: { restrict(x) { calls3.push(x) } } } } })
          return r === null && calls3.length === 0
        })(),
        '判据：`guardEnabled !== true` ⇒ 直接返回 null（守门弃权时不制造"更严"的假象）',
      )
    }

    // =======================================================================
    // ③ 只读导出（可追溯）：`pipeline_boundaries` 直接看得出"某角色可见哪些工具"
    // =======================================================================
    {
      const js = await callTool(f.h, 'pipeline_boundaries', { format: 'json' }, 'e-route-boundaries-agent')
      let parsed = null
      try {
        parsed = JSON.parse(String(js.value?.summary ?? ''))
      } catch {
        parsed = null
      }
      const tf = parsed?.tool_face ?? null
      rec.add(
        '③ 只读导出',
        '★ `pipeline_boundaries { format: "json" }` 里带 `tool_face`：`by_role[*].visible/hidden` + 判词出处',
        tf !== null && typeof tf.source === 'string' && Array.isArray(tf.by_role?.writer?.visible) && Array.isArray(tf.judged),
        tf === null
          ? '没有 tool_face（不应该）'
          : `source=${String(tf.source).split('（')[0]}　tool_count=${tf.tool_count}\n` +
            Object.keys(tf.by_role)
              .slice(0, 4)
              .map((r) => `  ${r}: 可见 ${tf.by_role[r].visible_count} / 隐藏 ${tf.by_role[r].hidden_count}`)
              .join('\n'),
      )
      const txt = await callTool(f.h, 'pipeline_boundaries', {}, 'e-route-boundaries-agent')
      rec.add(
        '③ 只读导出',
        '★ 人读版也印出工具面（"给谁减了几个"一眼可见），且既有三样（总原则 / 判据化不了 / 无漂移）一条没少',
        String(txt.value?.summary ?? '').includes('工具面') &&
          ['总原则', '判据化不了', '无漂移'].every((s) => String(txt.value?.summary ?? '').includes(s)),
        String(txt.value?.summary ?? '')
          .split('\n')
          .filter((l) => l.includes('工具面') || l.includes('可见 '))
          .slice(0, 5)
          .join('\n'),
      )
      /**
       * ★★ **生产链路上的那一份**（而不是本套自己传 `eventLevel` 推导的那一份）：
       *   `pipeline_boundaries` 读的是 `lib/tools.js` 的 `pipelineToolFace()` ——
       *   这一条断言才真正证明"**改在生效副本里**"，而不是"测试自己传对了参数"。
       */
      rec.add(
        '⑤ 出口工具',
        '★★ 生产链路（`lib/tools.js` 的 `pipelineToolFace()`）里事件级工具**也已不再被按角色收紧** —— 不是只有测试自己传对了参数',
        tf !== null &&
          Array.isArray(tf.event_level) &&
          tf.event_level.some((x) => x.tool === 'pipeline_transition') &&
          tf.by_role?.writer?.visible.includes('pipeline_transition') === true &&
          tf.by_role?.writer?.denied.includes('pipeline_transition') === false &&
          tf.tightening?.hides_event_level_tool === false,
        tf === null
          ? '没有 tool_face（不应该）'
          : `event_level=${JSON.stringify((tf.event_level ?? []).map((x) => x.tool))}　` +
            `writer 可见 ${tf.by_role.writer.visible_count} / 实际收紧 ${tf.by_role.writer.denied.length}\n` +
            `writer 的 deny 面（不含事件级工具）：${tf.by_role.writer.denied.join('、')}`,
      )
    }

    // =======================================================================
    // ⑤ ★★ **出口工具自检**（防同类回归再犯）——
    //    "每个角色的【出口工具】必须出现在它的可见工具面里"，
    //    而**角色 → 事件的映射从状态机的事件表推导**（`TRANSITIONS[].by`），
    //    事件 → 能发它的工具也全部从真实模块算，**不手工列名单**。
    //
    //    四种发射机制（每一种都是"这个事件是怎么被发出去的"的代码事实）：
    //      ① 交接物自动推进：`planAdvance` / `hubAdvanceFor` 对**真实 kind 表**的实算
    //         ⇒ `pipeline_handoff`；
    //      ② 通用事件执行器：`pipeline_transition`（它的逐事件判据就是 `by` 名单）；
    //      ③ 具名动作工具：守门白名单 **⊆** 该事件的 actor 集合
    //         （如 `pipeline_supervise` 的白名单 `['supervisor']` ⊆ `supervisor_*` 的 by）；
    //      ④ 打回工具：参数表里带 `target ∈ {writer,tester}` 的那个（按**入参**认，不按名字认），
    //         且该事件的 actor 集合 ⊆ 它的白名单。
    //    ★ 候选集是**析取**（任一可达即可）—— 宁可宽，也不许因为推导不全而假红。
    //    ★ 但它有**牙齿**：把 `pipeline_handoff` 从编写席的面里藏掉，这一条立刻红（见下）。
    // =======================================================================
    {
      const { TRANSITIONS } = await import('../lib/states.js')
      const { planAdvance, hubAdvanceFor } = await import('../lib/store.js')
      const { HANDOFF_SCHEMAS } = await import('../lib/handoff.js')
      const { HUB_HANDOFF_CONFIRM_STATIONS } = await import('../lib/states.js')
      const propsOf2 = (d) => d?.parameters?.properties ?? d?.parameters ?? {}
      /** ★ 本段自己算一份（与前两段同一份推导 —— `eventLevelToolNames` 从注册定义认）。 */
      const BD5 = await boundariesModule()
      const judge = (name) => guardDecision({ name, arguments: {} }, { tokens: f.h.tokens })
      const eventLevelTools =
        typeof BD5.eventLevelToolNames === 'function' ? BD5.eventLevelToolNames(Object.values(f.h.tools)) : []
      const face = BD5.deriveToolFace({
        toolNames: Object.values(f.h.tools).map((d) => d.name),
        judge,
        eventLevel: eventLevelTools,
      })
      const { parseToolAuthority } = BD5
      const { deriveToolFace } = BD5

      // --- ① 交接物 → 它自动推进的事件（**实算**：把两种 payload 形态都问一遍）---
      const PAYLOADS = [
        { conclusion: 'OK', blocking: true, self_check: { verdict: 'ok' } },
        { conclusion: 'NG', reject_to: 'tester', blocking: false, self_check: { verdict: 'gaps' } },
        { conclusion: 'NG', reject_to: 'writer', blocking: true },
        { station: HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM, decision: 'ok' },
      ]
      const handoffOf = new Map() // event → Set(kind)
      for (const kind of Object.keys(HANDOFF_SCHEMAS)) {
        for (const p of PAYLOADS) {
          for (const fn of [planAdvance, hubAdvanceFor]) {
            let r = null
            try {
              r = fn(kind, p)
            } catch {
              r = null
            }
            if (r !== null && typeof r?.event === 'string') {
              if (!handoffOf.has(r.event)) handoffOf.set(r.event, new Set())
              handoffOf.get(r.event).add(kind)
            }
          }
        }
      }
      // --- ② 角色 → 事件 / 事件 → actor 集合（**从状态机的事件表推导**，不手抄）---
      const actorsByEvent = new Map()
      const eventsByRole = new Map()
      for (const tr of TRANSITIONS) {
        const actors = (tr.by ?? []).map(String)
        if (!actorsByEvent.has(tr.event)) actorsByEvent.set(tr.event, new Set())
        for (const a of actors) actorsByEvent.get(tr.event).add(a)
        for (const r of actors) {
          if (!eventsByRole.has(r)) eventsByRole.set(r, new Set())
          eventsByRole.get(r).add(tr.event)
        }
      }
      const guardRolesOf = (name) => parseToolAuthority(guardDecision({ name, arguments: {} }, { tokens: f.h.tokens }))
      const subsetOf = (a, b) => a.length > 0 && a.every((x) => b.has(x))
      const candidates = (role, event) => {
        const actors = actorsByEvent.get(event) ?? new Set()
        const out = new Set()
        for (const kind of handoffOf.get(event) ?? []) {
          if ((HANDOFF_SCHEMAS[kind]?.from ?? []).includes(role)) out.add('pipeline_handoff')
        }
        for (const d of Object.values(f.h.tools)) {
          const gr = guardRolesOf(d.name)
          if (Array.isArray(gr) && subsetOf(gr, actors)) out.add(d.name)
          const en = propsOf2(d).target?.enum
          if (Array.isArray(en) && en.includes('writer') && en.includes('tester') && subsetOf([...actors], new Set(gr ?? []))) {
            out.add(d.name)
          }
        }
        if (actors.has(role)) out.add('pipeline_transition')
        return [...out]
      }
      const noCandidate = []
      const noPath = []
      let pairs = 0
      for (const role of Object.keys(face.by_role)) {
        const tokenRec = f.h.tokens.mint({ taskId: T, role, agentId: `e-route-exit-${role}`, note: 'e-route-check' })
        for (const event of eventsByRole.get(role) ?? []) {
          pairs += 1
          const cands = candidates(role, event)
          if (cands.length === 0) {
            noCandidate.push(`${role}×${event}`)
            continue
          }
          const reachable = cands.some(
            (t) =>
              face.by_role[role].visible.includes(t) &&
              guardDecision({ name: t, arguments: { task_id: T, role_token: tokenRec.token } }, { tokens: f.h.tokens }) === undefined,
          )
          if (!reachable) noPath.push(`${role}×${event} → 候选 ${cands.join(' / ')}（全不可达）`)
        }
      }
      rec.add(
        '⑤ 出口工具',
        '★★ **每个角色的出口工具都在它的可见工具面上**（角色→事件从状态机推导；事件→工具从 4 种机制实算 —— 不许手工列名单）',
        noPath.length === 0 && noCandidate.length === 0 && pairs > 0,
        noPath.length === 0 && noCandidate.length === 0
          ? `${pairs} 对（角色 × 它该发的事件）**逐对**核过：每一对都至少有一条"可见 + 守门放行"的出口路径。\n` +
            `  例：writer → dev_submitted 走 ${candidates('writer', 'dev_submitted').join(' / ')}；` +
            `supervisor → supervisor_initiate 走 ${candidates('supervisor', 'supervisor_initiate').join(' / ')}`
          : [...noCandidate.map((x) => `推导不出候选：${x}`), ...noPath].slice(0, 8).join('\n'),
      )
      /**
       * ★★ **这条自检有牙齿**：把编写席的出口（`pipeline_handoff`）从它的面里藏掉，
       *   同一条判据必须**立刻红** —— 否则它就是一句安慰。
       */
      const lyingJudge = (name) =>
        name === 'pipeline_handoff'
          ? '[pipeline] 角色越权被拦下。\n工具：pipeline_handoff\n允许角色：main / human\n当前角色：writer\n'
          : judge(name)
      const brokenFace = deriveToolFace({
        toolNames: Object.values(f.h.tools).map((d) => d.name),
        judge: lyingJudge,
        eventLevel: eventLevelTools,
      })
      const wTok = f.h.tokens.mint({ taskId: T, role: 'writer', agentId: 'e-route-exit-tooth', note: 'e-route-check' })
      const cands = candidates('writer', 'dev_submitted')
      const stillReachable = cands.some(
        (t) =>
          brokenFace.by_role.writer.visible.includes(t) &&
          guardDecision({ name: t, arguments: { task_id: T, role_token: wTok.token } }, { tokens: f.h.tokens }) === undefined,
      )
      rec.add(
        '⑤ 出口工具',
        '★★ **这条自检有牙齿**：把编写席的出口（`pipeline_handoff`）藏掉 ⇒ 同一条判据**当场红**（不是一句安慰）',
        stillReachable === false,
        `被藏掉时 writer→dev_submitted 的候选=${cands.join(' / ')}　可达=${stillReachable}（**必须为 false**）`,
      )
      rec.add(
        '⑤ 出口工具',
        '★ 事件级工具（' + eventLevelTools.join('、') + '）**对所有角色可见、且不在任何角色的 deny 面里**（不按角色收紧）',
        eventLevelTools.length > 0 &&
          Object.keys(face.by_role).every(
            (r) =>
              eventLevelTools.every((t) => face.by_role[r].visible.includes(t)) &&
              eventLevelTools.every((t) => !face.by_role[r].denied.includes(t)),
          ),
        `事件级工具=${eventLevelTools.join('、')}　16 个角色里"可见且未被收紧"的=` +
          String(Object.keys(face.by_role).filter((r) => eventLevelTools.every((t) => face.by_role[r].visible.includes(t) && !face.by_role[r].denied.includes(t))).length) +
          `/${Object.keys(face.by_role).length}`,
      )
    }

    // =======================================================================
    // ④ 可复现：工具名从真实注册对象派生（不手抄一份会漂移的名单）
    // =======================================================================
    {
      const bare = buildTools({
        defineTool: (d) => d,
        defineToolDegraded: true,
        ctx: { logger: { info() {}, warn() {}, debug() {} } },
        config: mergeConfig({}),
        store: {},
        tokens: createTokenStore(),
        transport: {},
        indexTask: () => {},
      })
      const face = typeof bare.__face === 'function' ? bare.__face() : null
      void face
      rec.add(
        '④ 可复现',
        '★ 工具面**从真实注册对象派生**（工具名不需要另抄一份）：31 个工具一个不多一个不少',
        Object.keys(bare).length === 31,
        `buildTools 的键数=${Object.keys(bare).length}`,
      )
    }

    return { passed: rec.passed, total: rec.total, text: rec.text('dsh-pipeline E 路自测（输出投影 ② + 工具面 ③）') }
  } finally {
    for (const h of open) await disposeHarness(h)
  }
}

// ---------------------------------------------------------------------------
// 直接跑
// ---------------------------------------------------------------------------
if (process.argv[1] !== undefined && /e-route-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const ci = process.argv.indexOf('--compare')
  if (ci >= 0) {
    // ── 跨树对比模式：`--compare <改前.json> <改后.json>` ───────────────────
    const before = JSON.parse(readFileSync(resolve(process.argv[ci + 1]), 'utf8'))
    const after = JSON.parse(readFileSync(resolve(process.argv[ci + 2]), 'utf8'))
    const cmp = compareSnapshots(before, after)
    console.log('dsh-pipeline · E 路 反例①：不传参数 ⇒ 与改前逐字节一致（跨树对比）')
    console.log('='.repeat(78))
    console.log(`改前那棵树：${before.plugin}\n改后那棵树：${after.plugin}`)
    for (const r of cmp.rows) console.log(`\n  ${r.ok ? '✓' : '✗'} ${r.key}\n      ${r.note}`)
    console.log('', '='.repeat(78))
    console.log(
      cmp.ok
        ? '结论：全部用例**规范化后逐字节相等 + 原始字节数相等** ⇒ 默认路径一个字节都没变。'
        : '结论：**有差异**（见上）。',
    )
    process.exit(cmp.ok ? 0 : 1)
  }
  const i = process.argv.indexOf('--snapshot')
  const snapshot = i >= 0 ? process.argv[i + 1] : undefined
  const keep = mkdtempSync(join(tmpdir(), 'e-route-check-'))
  try {
    const r = await runERouteCheck({ snapshot })
    console.log(r.text)
    process.exit(r.passed === r.total ? 0 : 1)
  } finally {
    try {
      rmSync(keep, { recursive: true, force: true })
    } catch {
      /* 清不掉不影响结论 */
    }
  }
}
