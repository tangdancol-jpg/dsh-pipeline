/**
 * dsh-pipeline · tests/silent-veto-fixtures.mjs
 * ============================================================================
 * ★★ **判据夹具**（与 `tests/silent-veto-check.mjs` 分开，只为行数纪律
 *    `CONVENTIONS.md` §4：单文件 ≤400 行）。
 *
 * 这里只有**数据**，没有断言：
 *   · `PROMPT_CASES` —— 用户二分表 + 三条补测维度（`old` 列是**实测值**：
 *     拿改前那份代码的 `PROMPT_CODE_READ_RE.exec()` 逐条跑出来的结果）；
 *   · `IO_TABLE`     —— **输入 → 输出表**（判据化的唯一口径）；
 *   · `MAIN_TABLE_ROW` / `MAIN_LIMIT_TABLE` —— 逐字取自 `presets/src/main/prefix.md`；
 *   · `presetFullText()` —— 预设全文，来源是**生成器自己**（`presets/render.js` 的
 *     `composePrefix` / `composeSuffix`），**不另抄一份** —— 抄一份的话预设一改，
 *     那条回归就悄悄失效了。
 *
 * @module dsh-pipeline/tests/silent-veto-fixtures
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { composePrefix, composeSuffix } from '../presets/render.js'
import { registerInterception, seatBriefing } from '../lib/intercept.js'
import { createGuardFor } from '../lib/guard-factory.js'
import { createGuardFixture, disposeHarness } from './selftest-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
// ---------------------------------------------------------------------------
// ★ 判据输入：`pl-main` / `pl-orchestrator` 的**预设全文**（原样，不裁剪）
//
//   来源是**生成器自己**（`presets/render.js` 的 composePrefix / composeSuffix），
//   不是本文件另抄一份 —— 抄一份的话，预设改了这条回归就悄悄失效了。
// ---------------------------------------------------------------------------
export const PRESET_INDEX = JSON.parse(readFileSync(join(PKG, 'presets', '_index.json'), 'utf8'))
export const presetFullText = (role) => {
  const dir = join(PKG, 'presets', PRESET_INDEX.presets[role].dir)
  return `${composePrefix(dir)}\n\n${composeSuffix(dir)}`
}

/** ★ 用户真机粘的那一行（逐字取自 `presets/src/main/prefix.md` 的 markdown 表格行）。 */
export const MAIN_TABLE_ROW = (() => {
  const md = readFileSync(join(PKG, 'presets', 'src', 'main', 'prefix.md'), 'utf8')
  return md.split('\n').find((l) => l.includes('读代码正文（')) ?? ''
})()

/** ★ `pl-main` persona 的**整张限制表**（表头 + 分隔行 + 三条，逐字取自 prefix.md:7-11）。 */
export const MAIN_LIMIT_TABLE = (() => {
  const md = readFileSync(join(PKG, 'presets', 'src', 'main', 'prefix.md'), 'utf8')
  const lines = md.split('\n')
  const i = lines.findIndex((l) => l.startsWith('| 类别 |'))
  return i < 0 ? '' : lines.slice(i, i + 5).join('\n')
})()

/** ★★ 用户**二分**出来的最小复现（逐字，含反引号与空格）：改前它 ⇒ 1 秒结束、被拦。 */
export const MIN_REPRO = '读代码正文（`read` / `grep` 等指向源码树）'

/**
 * ★★ **用户实测语料**（12 条，逐字；`old` 列是**实测值**：拿改前的
 *    `PROMPT_CODE_READ_RE.exec(text)` 逐条跑出来的结果）。
 *
 * 分三组：
 *   A. 改前就通过 ⇒ 改后**必须仍然通过**（不许回退）；
 *   B. 改前**被误伤**（一票否决 + 零留痕）⇒ 改后**必须通过**（本缺陷的验收核心）；
 *   C. 真实**工具调用**（不是散文）⇒ 改后**必须仍被拦**（判据落点收窄到 `tools/pre-execute`）。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么不去精确复刻旧正则（用户裁定，逐字）
 * ---------------------------------------------------------------------------
 * 「`grep 等指向源码树` **通**、`read 源码 src/foo.js` **挂** —— 同为"1 个工具名 +
 *   源码词"却结果相反，说明这条判据内部还有**难以从外部推断的耦合**。⇒
 *   **不要试图精确复刻现正则的行为**。」正解是把判据从"扫 prompt"降级为
 *   "只看**工具调用**"（真去读源码才拦）+ 绝不静默。
 */
export const CORPUS_A = [
  { t: 'read', old: false },
  { t: 'grep', old: false },
  { t: '读代码正文', old: false },
  { t: 'src/foo.js', old: false },
  { t: 'read / grep', old: false },
  { t: 'grep 等指向源码树', old: false },
  { t: '读代码正文（grep 等指向源码树）', old: false },
  { t: 'write / edit 源码树', old: false },
].map((c) => ({ ...c, group: 'A 改前也通过（不许回退）' }))

export const CORPUS_B = [
  { t: 'read / grep 等指向源码树', old: true },
  { t: '读代码正文（read / grep 等指向源码树）', old: true },
  { t: 'read, grep 源码树', old: true },
  { t: 'read grep 源码', old: true },
  { t: 'read 源码 src/foo.js', old: true },
  { t: MAIN_TABLE_ROW, old: true, note: '原始触发件（整行，连表格竖线）' },
].map((c) => ({ ...c, group: 'B 改前误伤（验收核心）' }))

/** ★ 补测维度（分隔方式 / 工具名个数 / 增补形状），与 A·B 组同一判据。 */
export const PROMPT_EXTRA = [
  { t: 'read / grep 等指向源码树', tag: '分隔=斜杠', old: true },
  { t: 'read, grep 等指向源码树', tag: '分隔=逗号', old: true },
  { t: 'read grep 等指向源码树', tag: '分隔=空格', old: true },
  { t: 'read、grep 等指向源码树', tag: '分隔=顿号', old: true },
  // 工具名个数：`grep` 不在旧读动词表里 ⇒ 这是"相关不是成因"的实测证据
  { t: 'read 等指向源码树', tag: '**单个**工具名(read) + 源码词', old: true },
  { t: 'grep 等指向源码树', tag: 'grep 不在旧读动词表里', old: false },
  { t: MIN_REPRO, tag: '最小形状（原文，带反引号）', old: true },
  { t: MAIN_LIMIT_TABLE, tag: 'pl-main persona 的整张限制表', old: true },
  // 用户**真请求**读某文件：用户有权这么说；判据落点在工具缝
  { t: '先读一下 src/a.js 的实现，看看逻辑对不对', tag: '真请求读具体文件', old: true },
  { t: 'read src/a.js', tag: '真请求（命令式）', old: true },
  { t: 'grep -n "x" lib/', tag: '真请求（命令式搜索）', old: false },
]

/** 全部"用户消息层"语料（A + B + 补测），逐条断言放行。 */
export const PROMPT_CASES = [
  ...CORPUS_A.map((c) => ({ t: c.t, tag: c.group, old: c.old })),
  ...CORPUS_B.map((c) => ({ t: c.t, tag: c.group, old: c.old, note: c.note })),
  ...PROMPT_EXTRA.map((c) => ({ t: c.t, tag: `补测：${c.tag}`, old: c.old })),
]

/** C 组：真实**工具调用**（不是散文）—— 逐条断言**仍被拦**。 */
export const CORPUS_C = [
  { tool: 'read', args: { path: 'src/a.js' }, why: '真的去 read 源码文件' },
  { tool: 'grep', args: { pattern: 'fizzbuzz', path: 'src' }, why: '真的去 grep 源码树' },
  { tool: 'pwsh', args: { command: 'grep -n "fizzbuzz" src/fizzbuzz.js' }, why: '命令式等价调用' },
  { tool: 'pwsh', args: { command: 'Select-String -Path src/fizzbuzz.js -Pattern x' }, why: 'PowerShell 等价物' },
  { tool: 'pwsh', args: { command: 'type src/fizzbuzz.js' }, why: 'type/cat 旁路' },
]

/**
 * ★★ **输入 → 输出表**（判据化的唯一口径）。
 *
 * ★ 口径一句话：**判据从「文本里出现了什么字」改成「有没有真的发起读动作」** ——
 *   散文（A/B 组）结构上分不出"叙述规则"与"请求读代码"，一律不判；
 *   真实工具调用（C 组）有身份 + 工具名 + 结构化参数 ⇒ 只在那里拦。
 * ★ 改前那条判据的**实测成因**（三段同现：读动词 + ≤16 非换行字符 + 代码名词）、
 *   以及"为什么不去复刻它"，逐条写在 `lib/intercept/prompt-rules.js` 的文件头
 *   （那里是**唯一出处**，本文件只放表）。
 */
export const IO_TABLE = [
  ['prompt', 'A 组 8 条（`read` · `grep` · `读代码正文` · `src/foo.js` · `read / grep` · `grep 等指向源码树` · `读代码正文（grep 等指向源码树）` · `write / edit 源码树`）', '放行', '改前也放行 ⇒ **不许回退**'],
  ['prompt', 'B 组 6 条（`read / grep 等指向源码树` · `读代码正文（read / grep 等指向源码树）` · `read, grep 源码树` · `read grep 源码` · `read 源码 src/foo.js` · `pl-main` 那一整行）', '放行', '★ 改前**一票否决且零留痕** ⇒ 本缺陷的验收核心'],
  ['prompt', '补测：分隔=斜杠 / 逗号 / 空格 / 顿号', '放行', '旧判据四种分隔**都命中**（实测）⇒ 分隔不是变量'],
  ['prompt', '补测：`read 等指向源码树`（**单个**工具名 + 源码词）', '放行', '★ 旧判据同样命中 ⇒ "≥2 个工具名"是相关不是成因'],
  ['prompt', '补测：`grep 等指向源码树`（grep 不在旧读动词表里）', '放行', '与上一条**同为"1 个工具名 + 源码词"却结果相反** ⇒ 不复刻正则的理由'],
  ['prompt', '补测：`先读一下 src/a.js 的实现` / `read src/a.js`（用户**真请求**读某文件）', '放行', '★ 用户消息层不判 —— 用户有权这么说；真正拦住的是下一行的工具调用'],
  ['prompt', '`pl-main` persona 的整张限制表 / 带表格竖线的整行', '放行', 'markdown 表格 / 引用块里的**规则说明**一律不判'],
  ['tool', 'C 组：`read { path: "src/a.js" }`（★ 真实工具调用）', '**拒** + 可见理由 + `seam:tool-deny` 审计行', '★ 判据的落点：看**有没有真的发起读动作**（散文在那里结构上不可能出现）'],
  ['tool', 'C 组：`grep { pattern, path: "src" }`', '**拒** + 可见理由 + `seam:tool-deny` 审计行', '检索返回的是**匹配到的代码行** = 代码正文'],
  ['tool', 'C 组：`grep -n "x" src/fizzbuzz.js` / `Select-String …` / `type …`（命令式）', '**拒**', '走 shell 旁路翻源码树同样拦；⚠️ 纯目录名/不存在路径按既有的"真实文件身份"判据**不算**'],
  ['tool', '对照：`read { path: "src/a.js" }`（**编写**席位）', '放行', '编写本来就该读代码（不误伤正当角色）'],
]

/** 其余三类（新口径要覆盖的措辞形态）。 */
export const PROMPT_SAMPLES = [
  {
    key: 'markdown 表格 / 引用块里的规则说明',
    text: `| 类别 | 平常 |\n|---|---|\n${MAIN_TABLE_ROW}\n\n> 上面这张表是**规则说明**，不是让你去读源码。`,
    want: false,
  },
  { key: '出现工具名但不是请求', text: '你能用 `read` / `grep` 这两个工具，但**看得见 ≠ 用得上**。', want: false },
  { key: '真请求读某文件', text: '先读一下 src/fizzbuzz.js 的实现，看看逻辑对不对', want: false },
]

// ---------------------------------------------------------------------------
// 断言/宿主小工具（与判据无关的脚手架，放这里只为行数纪律）
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 断言小工具
// ---------------------------------------------------------------------------
export const indent = (s, n = 4) =>
  String(s ?? '')
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n')

export function createRecorder() {
  const items = []
  return {
    items,
    add(group, name, pass, detail) {
      items.push({ group, name, pass: pass === true, detail: String(detail ?? '') })
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
  }
}

export const hit = (text, fragment) =>
  String(fragment)
    .split('|')
    .some((a) => a.length > 0 && String(text).includes(a))

/** 把注入消息的正文摊平（宿主形状是 block 数组）。 */
export const messageText = (m) =>
  Array.isArray(m?.content)
    ? m.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
    : String(m?.content ?? '')

/** 造一个**假的宿主**（与 `intercept-check.mjs` 同语义：中间件是链，`next()` 往下走）。 */
export function createFakeHost(nextResult = { kind: 'enter', messages: [] }) {
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {
        const arr = handlers.get(event) ?? []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      }
    },
  }
  async function emit(event, ...args) {
    const arr = handlers.get(event) ?? []
    let idx = 0
    const next = async () => {
      if (idx >= arr.length) return nextResult
      const fn = arr[idx++]
      return fn(...args, next)
    }
    return next()
  }
  return { ctx, emit, handlers, events: () => [...handlers.keys()] }
}

// ---------------------------------------------------------------------------
// 宿主夹具：造一个"真夹具 + 已挂好拦截缝 + 真的会写审计"的宿主（两套共用）
// ---------------------------------------------------------------------------
/**
 * @param {object} [opts]
 * @param {number} [opts.stopAfter]
 * @param {object} [opts.sw]
 * @returns {Promise<{f:object, host:object, ic:object, guard:Function}>}
 */
export async function setupInterceptHost(opts = {}) {
  const f = await createGuardFixture({ stopAfter: opts.stopAfter ?? 5 })
  const host = createFakeHost()
  const guard = createGuardFor({
    tokens: f.h.tokens,
    config: f.h.config,
    taskIndex: f.h.taskIndex,
    sw: opts.sw ?? { isOn: () => true },
    counter: f.h.counter,
    retired: new Set(),
    warn: () => {},
  })
  const ic = registerInterception(host.ctx, {
    tokens: f.h.tokens,
    guard,
    warn: () => {},
    getTask: (taskId) => f.h.store.peek(taskId) ?? null,
    // ★★ 拦截缝的审计出口（`.pipeline/<任务>/audit.jsonl`，只追加、**不碰 task.json**）
    auditFileOf: (id) => f.h.store.auditFile(id),
  })
  return { f, host, ic, guard }
}

/** 读某个夹具任务的 `audit.jsonl`（一行一个 JSON）。 */
export function auditLinesOf(f) {
  const file = f.h.store.auditFile(f.taskId)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return { raw: l }
      }
    })
}

/** 跑完一套后的公共收尾（报告 + 逐条明细）。 */
export function renderSuite(title, subtitle, rec) {
  const groups = {}
  for (const it of rec.items) {
    if (groups[it.group] === undefined) groups[it.group] = []
    groups[it.group].push(it)
  }
  const lines = ['='.repeat(78), title, '='.repeat(78), '']
  if (subtitle) lines.push(subtitle, '')
  for (const [g, items] of Object.entries(groups)) {
    lines.push('', '─'.repeat(78), `【${g}】${items.filter((i) => i.pass).length}/${items.length} 通过`, '─'.repeat(78))
    for (const it of items) {
      lines.push('', `${it.pass ? '✓' : '✗'} ${it.name}`, indent(it.detail))
    }
  }
  lines.push('', '='.repeat(78), `总计：${rec.passed}/${rec.total} 通过`, '='.repeat(78))
  return lines.join('\n')
}

/** 关掉夹具（清临时目录）。 */
export async function closeFixtures(open) {
  for (const h of open) {
    try {
      await disposeHarness(h)
    } catch {
      /* 清不掉不影响结论 */
    }
  }
}