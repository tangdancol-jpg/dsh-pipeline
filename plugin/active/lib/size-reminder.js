// 文件规模提醒 · 三个阈值（150/300/400）：程序自动发起"有没有必要写这么大"的对话。
/**
 * dsh-pipeline · 文件规模提醒
 * ============================================================================
 * 用户原话（逐字，2026-10-18）：
 *   「文件行数大于 150 就开始提醒 ai，自动发起对话询问：**有必要写这么大吗？
 *     是因为顺手写一起了还是功能需求**；大于 300，二次询问同样的；
 *     400 时要求三次提问：**一定这个写法吗？有没有更优的写法？你能不能上网调用
 *     Search 接口和 Fetch 接口查询有没有更优质的写法。**」
 *
 * 本模块只做**判据与文案**（纯函数 + 一份有界状态），**不碰宿主**：
 *   · `levelFor(lines)`：150/300/400 三档（>150 / >300 / ≥400）；
 *   · `messageFor(...)`：三档各自的问句（第三档要求实际调用 web_search / web_fetch）；
 *   · `shouldWatchPath` / `isWatchedTool`：只看代码文件与写类工具（读文件不提醒）；
 *   · `createSizeReminder(cfg)`：跨调用去重（同一文件同一档只问一次）+ 待投递队列。
 *
 * 接线在 `lib/guard/hook-size.js`：
 *   `tools/post-execute` 记下"刚写的文件 + 行数"；
 *   `agent/pre-step` 把待问的问题作为**宿主消息**注入（= 程序自动发起的对话）。
 *
 * ★ 纪律：提醒只是**提醒**（`CONVENTIONS §4.2`）—— 不判红、不阻塞、不否决。
 *   搞错时最坏结果是多问了一句；绝不因此吞掉工具结果或停掉会话。
 *
 * @module dsh-pipeline/lib/size-reminder
 */

import { readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'

/** 注入形状的 `source.form`（登记在 `lib/hostmsg.js` 的 `HOST_INJECTION_SITES`）。 */
export const SIZE_REMINDER_FORM = 'file-size-reminder'

/** 缺省阈值（配置项 `sizeReminder` 覆盖；顺序 = 从低到高）。 */
export const DEFAULT_THRESHOLDS = Object.freeze({ firstLines: 150, secondLines: 300, thirdLines: 400 })

/** 缺省的写类工具名（大小写不敏感；命中即认为是"写了文件"）。 */
export const DEFAULT_WRITE_TOOLS = Object.freeze([
  'write',
  'write_file',
  'create_file',
  'edit',
  'multi_edit',
  'str_replace_editor',
  'apply_patch',
  'append_file',
  'notebook_edit',
])

/** 缺省只提醒这些扩展名（其余视为数据/生成物，不参与行数判断）。 */
export const DEFAULT_EXTENSIONS = Object.freeze([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.vue',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '.rb',
  '.php',
  '.sh',
  '.ps1',
])

/** 缺省跳过的目录段（路径里出现即不提醒）。 */
export const DEFAULT_IGNORE_DIRS = Object.freeze([
  'node_modules',
  '.git',
  '.pipeline',
  'dist',
  'build',
  'coverage',
  'generated',
  '__pycache__',
  'vendor',
])

/** 单文件读取上限：超过就不数行（多半是生成物，提醒没有意义）。 */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/** 把配置补成完整形状（非法值回落到缺省；不抛）。 */
export function normalizeConfig(raw) {
  const c = raw !== null && typeof raw === 'object' ? raw : {}
  const pos = (v, d) => (Number.isFinite(v) && Number(v) > 0 ? Number(v) : d)
  const list = (v, d) => (Array.isArray(v) && v.length > 0 ? v.map((x) => String(x)) : [...d])
  return {
    enabled: c.enabled !== false,
    firstLines: pos(c.firstLines, DEFAULT_THRESHOLDS.firstLines),
    secondLines: pos(c.secondLines, DEFAULT_THRESHOLDS.secondLines),
    thirdLines: pos(c.thirdLines, DEFAULT_THRESHOLDS.thirdLines),
    tools: list(c.tools, DEFAULT_WRITE_TOOLS).map((s) => s.toLowerCase()),
    extensions: list(c.extensions, DEFAULT_EXTENSIONS).map((s) => s.toLowerCase()),
    ignoreDirs: list(c.ignoreDirs, DEFAULT_IGNORE_DIRS).map((s) => s.toLowerCase()),
    maxBytes: pos(c.maxBytes, DEFAULT_MAX_BYTES),
    maxAsksPerStep: pos(c.maxAsksPerStep, 2),
  }
}

/**
 * 行数落在哪一档：0 = 不提醒；1/2/3 = 第一次/第二次/第三次询问。
 *
 * @param {number} lines
 * @param {object} [cfg] `normalizeConfig` 的产物
 * @returns {0|1|2|3}
 */
export function levelFor(lines, cfg) {
  const c = normalizeConfig(cfg)
  const n = Number(lines)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n >= c.thirdLines) return 3
  if (n > c.secondLines) return 2
  if (n > c.firstLines) return 1
  return 0
}

/** 这个工具是不是"写文件"（读/搜/跑命令都不算）。 */
export function isWatchedTool(tool, cfg) {
  const c = normalizeConfig(cfg)
  const name = String(tool ?? '').toLowerCase()
  if (name.length === 0) return false
  return c.tools.includes(name)
}

/** 这个路径要不要看行数（扩展名白名单 + 目录黑名单 + 必须是绝对/可解析路径）。 */
export function shouldWatchPath(filePath, cfg) {
  const c = normalizeConfig(cfg)
  const p = String(filePath ?? '')
  if (p.length === 0) return false
  const lower = p.toLowerCase()
  // 目录黑名单按**路径段**判（'src/dist/a.js' 与 'dist/a.js' 都算命中 dist），不做字符串前缀。
  const segments = lower.split(/[\\/]+/).filter((s) => s.length > 0)
  if (segments.some((s) => c.ignoreDirs.includes(s))) return false
  const ext = extname(lower)
  return c.extensions.includes(ext)
}

/** 从工具参数里取"这次写了哪个文件"（单文件；取不到就返回 null）。 */
export function writtenPathOf(toolArgs, cwd) {
  const a = toolArgs !== null && typeof toolArgs === 'object' ? toolArgs : {}
  for (const key of ['path', 'file_path', 'filepath', 'filename', 'file']) {
    const v = a[key]
    if (typeof v !== 'string' || v.length === 0) continue
    return isAbsolute(v) ? v : resolve(String(cwd ?? process.cwd()), v)
  }
  return null
}

/** 数一个文件的行数；读不到/太大/不是正常文件 ⇒ null（提醒失败不许影响调用）。 */
export function countFileLines(filePath, cfg) {
  const c = normalizeConfig(cfg)
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size > c.maxBytes) return null
    const text = readFileSync(filePath, 'utf8')
    if (text.length === 0) return 0
    const parts = text.split('\n')
    return text.endsWith('\n') ? parts.length - 1 : parts.length
  } catch {
    return null
  }
}

/** 人类可读的短路径（提醒里只给文件名/相对尾段，避免把绝对路径塞进上下文）。 */
export function shortPath(filePath) {
  const p = String(filePath ?? '')
  const parts = p.split(/[\\/]+/).filter((s) => s.length > 0)
  return parts.slice(-2).join('/')
}

/**
 * 三档提醒的**唯一文案出处**。
 *
 * @param {{file:string, lines:number, level:0|1|2|3}} input
 * @returns {string}
 */
export function messageFor({ file, lines, level }) {
  const name = `\`${shortPath(file)}\``
  if (level === 1) {
    return (
      `【文件规模提醒 1/3】你刚写完 ${name}，它已经 **${lines} 行**（超过 150 行）。\n` +
      '问自己一句：**有必要写这么大吗？是因为顺手把几件事写在一起了，还是这里确实是一个功能需求？**\n' +
      '· 只是顺手凑在一起 ⇒ 按职责拆开（拆是为了"一个文件只有一个改动原因"，不是为了凑行数）；\n' +
      '· 确实是功能需求 ⇒ 继续写，不用停。\n' +
      '（这是插件按阈值自动发起的提醒，不是用户在打断你。）'
    )
  }
  if (level === 2) {
    return (
      `【文件规模提醒 2/3】${name} 现在 **${lines} 行**（超过 300 行），还没拆、也还在长。\n` +
      '**再问一次：有必要写这么大吗？是顺手写在一起了，还是功能需求？**\n' +
      '· 如果答案仍是"功能需求" ⇒ 请在回复里用一句话说明"为什么必须放在同一个文件里"；\n' +
      '· 如果说不出来 ⇒ 先按职责拆，再继续。\n' +
      '（插件按阈值自动发起的第二次询问。）'
    )
  }
  if (level === 3) {
    return (
      `【文件规模提醒 3/3】${name} 已经 **${lines} 行**（到达 400 行阈值）。\n` +
      '在继续堆之前，请先回答两个问题：\n' +
      '1. **一定要用现在这个写法吗？**\n' +
      '2. **有没有更优的写法？**\n' +
      '★ 请**实际调用** `web_search`（Search 接口）和 `web_fetch`（Fetch 接口）查一查同类问题/官方文档里\n' +
      '更优的写法与拆分方式，再决定是否重构或拆分；回复里写清查了什么、结论是什么。\n' +
      '（插件按阈值自动发起的第三次询问 —— 记住：为拆而拆没有意义，判断标准是职责是否单一。）'
    )
  }
  return ''
}

/**
 * 造一份有界状态：跨调用去重（同文件同档只问一次）+ 待投递队列（每次开步最多 2 条）。
 *
 * @param {object} [rawCfg] 配置项 `sizeReminder`
 * @returns {{note:(spec:object)=>void, take:(agentId:string)=>Array<object>, size:()=>number, reset:()=>void, cfg:()=>object}}
 */
export function createSizeReminder(rawCfg) {
  const cfgOf = () => normalizeConfig(rawCfg)
  /** agentId → Map(file → 已问到的档位) */
  const asked = new Map()
  /** agentId → Map(file → {file, lines, level}) 待问 */
  const pending = new Map()
  const MAX_AGENTS = 512

  const askedOf = (agentId) => {
    if (!asked.has(agentId)) {
      if (asked.size >= MAX_AGENTS) asked.clear()
      asked.set(agentId, new Map())
    }
    return asked.get(agentId)
  }
  const pendingOf = (agentId) => {
    if (!pending.has(agentId)) pending.set(agentId, new Map())
    return pending.get(agentId)
  }

  /**
   * 记下"这个 agent 刚写了这些文件"。
   *
   * @param {{agentId:string, files:string[]}} spec
   */
  const note = (spec) => {
    const agentId = String(spec?.agentId ?? '')
    if (agentId.length === 0) return
    const c = cfgOf()
    if (!c.enabled) return
    for (const file of Array.isArray(spec?.files) ? spec.files : []) {
      if (!shouldWatchPath(file, c)) continue
      const lines = countFileLines(file, c)
      if (lines === null) continue
      const level = levelFor(lines, c)
      if (level === 0) continue
      const done = askedOf(agentId)
      if ((done.get(file) ?? 0) >= level) continue
      done.set(file, level)
      pendingOf(agentId).set(file, { file, lines, level })
    }
  }

  /** 取走待问（按档位从高到低、每次最多 `maxAsksPerStep` 条）。 */
  const take = (agentId) => {
    const id = String(agentId ?? '')
    const q = pending.get(id)
    if (q === undefined || q.size === 0) return []
    const c = cfgOf()
    const out = [...q.values()]
      .sort((a, b) => b.level - a.level || a.file.localeCompare(b.file))
      .slice(0, c.maxAsksPerStep)
    for (const item of out) q.delete(item.file)
    if (q.size === 0) pending.delete(id)
    return out.map((item) => ({ ...item, text: messageFor(item) }))
  }

  return {
    note,
    take,
    size: () => [...pending.values()].reduce((a, m) => a + m.size, 0),
    reset: () => {
      asked.clear()
      pending.clear()
    },
    cfg: cfgOf,
  }
}
