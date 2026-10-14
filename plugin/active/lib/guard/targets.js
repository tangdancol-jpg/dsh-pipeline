/**
 * dsh-pipeline · 守门 · **目标路径的提取**（"这次到底在写哪个文件"）
 * ============================================================================
 * -----------------------------------------------------------------------------
 * 修的是哪条缺陷（真机端到端 T-20261015-bb30bc 实测，缺陷 ③）
 * -----------------------------------------------------------------------------
 * 现场（审核席位写自己的报告）：
 *
 *   · `reports/reviewer/reviewer-report.log` 被拒，而**同一个目录、同一个后缀**的
 *     `reviewer-verify.log` 两次都通过 —— 间歇发生；
 *   · 拒绝文案里那行「目标：…」打出来的是**工作区目录 + 正文首行拼出来的假路径**，
 *     跟调用方真正给的 `file_path` **没有关系**；
 *   · 而该文案自己还写着「★ 这条按**路径**判，不按角色卡里的措辞判」——
 *     **文案与判据自相矛盾**。
 *
 * -----------------------------------------------------------------------------
 * 根因（一行）
 * -----------------------------------------------------------------------------
 * 改前的 `collectPaths()` 把参数对象里**所有字符串叶子**（深度 ≤ 3）都当成候选路径，
 * 正文（`content` / `new_string` / `old_string` / `patch` …）也在内。而"像不像路径"
 * 的判据只是"**含 `/` 或 `\`**"—— 于是**正文里只要出现一个斜杠**，整段多行正文就被
 * 拿去 `resolveJoin(cwd, 正文)` 拼成一个横跨换行的怪路径：
 *
 *     正文首行…/第二行…/第三行        ⇒   <工作区>/正文首行…/第二行…
 *
 * 它落在项目根里 ⇒ 命中"越界写入"判据 ⇒ **误拒**；正文里没有斜杠时又不会发生
 * ⇒ 这就是"同目录同后缀，一个拒一个过"的**全部原因**。
 *
 * -----------------------------------------------------------------------------
 * 修法（三条，都不放宽）
 * -----------------------------------------------------------------------------
 *   ① **显式路径键优先**（`path` / `file_path` / `filepath` / `target` …）：
 *      有就用它当**权威目标**，并在拒绝文案里**点名它是从哪个参数来的**
 *      —— 文案与判据从此对得上；
 *   ② **补充扫描**（"宁可多扫不可漏扫"的伏笔扫描）只收**单行**、长度合理的字符串，
 *      且跳过一批**正文类键名**（`content` / `new_string` / `patch` …）。
 *      **路径不跨行** —— 这一条就足以杀掉那个假路径；
 *   ③ 判定结果**带来源**：`{ path, from, explicit }`。拒绝文案用 `targetLine()` 渲染，
 *      调用方一眼看得出"守门到底在说哪个参数"。
 *
 * ★ 这不是放宽：假路径**从来不是**真目标（真目标一直在显式键里，两条都会被收集），
 *   它唯一的作用就是制造误拒。真目标一个都没少扫 —— 反例见
 *   `tests/f3-path-targets-check.mjs`（正文里藏路径、显式键照旧拒）。
 *
 * @module dsh-pipeline/lib/guard/targets
 */

import { pathKey } from '../util.js'

/** 单个字符串参数最多扫描多少字符（防止拿 1MB 内容跑正则）。 */
export const MAX_SCANNED = 200_000

/** 补充扫描时，**单行**候选的最大长度（真实路径远短于此；超出的一律不是路径）。 */
export const MAX_PATH_CHARS = 512

/** 惯用路径键：有就用它们当**权威目标**。 */
export const PATH_KEYS = ['path', 'file_path', 'filepath', 'target', 'filename', 'file', 'dir', 'directory', 'cwd', 'notebook_path']

/**
 * ★ **正文类键名**：这些键的值是**内容**，不是路径。
 *
 * 为什么按**键名**再排一道（多行判据已经是通用网）：内容里恰好是**单行**、
 * 又恰好含斜杠的情形（一行注释 `// 见 lib/store.js`、一行 URL、一行 `a/b`）同样会
 * 拼出假路径 —— 键名这一道把最常见的几种正文参数直接摘出去。
 */
export const CONTENT_ARG_KEYS = Object.freeze([
  'content', 'contents', 'text', 'body', 'markdown', 'data', 'patch', 'diff',
  'new_string', 'old_string', 'new_str', 'old_str', 'replacement', 'code', 'source',
  'snippet', 'prompt', 'message', 'answer', 'question', 'description', 'reason', 'why',
  'note', 'notes', 'summary', 'label', 'title', 'comment', 'instructions', 'detail',
  'details', 'transcript',
])

const CONTENT_KEY_SET = new Set(CONTENT_ARG_KEYS)

/** 值里出现换行 ⇒ 它不是一条路径（路径不跨行）。 */
export function isSingleLine(v) {
  const s = String(v ?? '')
  return !s.includes('\n') && !s.includes('\r')
}

/** 显式路径值：只取**首行**（畸形入参不许借换行躲开判定）。 */
export function firstLine(v) {
  const s = String(v ?? '')
  const i = s.search(/[\r\n]/)
  return i < 0 ? s : s.slice(0, i)
}

/**
 * 把可能是相对路径的字符串绝对化；不像路径的字符串返回 `''`（交由 `isInside` 判定）。
 *
 * 「像路径」＝ 绝对路径形态，或 **含分隔符** 或以 `./` `../` 开头。
 * 一句普通的话（`"utf8"`、`"hello world"`）在这里被丢掉 —— 这是改前就有的口径。
 */
export function resolvePath(p, cwd) {
  const s = String(p ?? '')
  if (s.length === 0) return ''
  const cleaned = s.replace(/^file:\/{2,3}/i, '').replace(/^["']|["']$/g, '')
  if (/^[a-z]:[\\/]/i.test(cleaned) || cleaned.startsWith('/') || cleaned.startsWith('\\\\')) return pathKey(cleaned)
  if (/^\.{0,2}[\\/]/.test(cleaned) || cleaned.includes('/') || cleaned.includes('\\')) return pathKey(resolveJoin(cwd, cleaned))
  return ''
}

/** 把 `base` 与可能相对的 `rel` 拼成归一化绝对路径（不依赖 node:path，保持纯函数）。 */
export function resolveJoin(base, rel) {
  const b = String(base ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const r = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  const parts = (b + '/' + r).split('/')
  const out = []
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  return out.length > 0 && out[0].endsWith(':') ? joined : '/' + joined
}

/**
 * 从工具参数里收集目标路径 —— **带来源**。
 *
 * 两道：
 *   · **显式**：`PATH_KEYS` 里的字符串（取首行）；`explicit: true`；
 *   · **补充扫描**：其余字符串叶子（深度 ≤ 3），只收**单行**、长度 ≤ {@link MAX_PATH_CHARS}、
 *     且**不落在正文类键名**下的。
 *
 * @param {any} args
 * @param {string} cwd
 * @returns {Array<{path:string, from:string, explicit:boolean}>}
 */
export function collectTargets(args, cwd) {
  const found = []
  const seen = new Set()
  const push = (rawValue, from, explicit) => {
    if (typeof rawValue !== 'string' || rawValue.length === 0) return
    const value = explicit ? firstLine(rawValue) : rawValue
    const s = value.trim()
    if (s.length === 0 || s.length > MAX_SCANNED) return
    const key = `${explicit ? 'E' : 'S'}|${s}`
    if (seen.has(key)) return
    seen.add(key)
    const abs = resolvePath(s, cwd)
    if (abs.length === 0) return
    // ★ 同一绝对路径由显式键给出过就以显式那条为准（文案要点名最可信的那个来源）。
    if (!explicit) {
      const dup = found.find((t) => t.path === abs)
      if (dup !== undefined) return
    }
    found.push({ path: abs, from, explicit })
  }

  if (args === null || typeof args !== 'object') return []
  for (const k of PATH_KEYS) push(args[k], k, true)

  const walk = (value, depth, keyPath) => {
    if (depth > 3) return
    if (typeof value === 'string') {
      const leafKey = keyPath.length > 0 ? keyPath[keyPath.length - 1] : ''
      if (CONTENT_KEY_SET.has(leafKey)) return
      if (!isSingleLine(value)) return
      if (value.length > MAX_PATH_CHARS) return
      push(value, keyPath.join('.') || '(根)', false)
      return
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1, keyPath)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, depth + 1, [...keyPath, k])
    }
  }
  for (const [k, v] of Object.entries(args)) {
    if (PATH_KEYS.includes(k)) continue
    walk(v, 0, [k])
  }

  return found
}

/**
 * 只要路径字符串（**兼容改前的 `collectPaths(args, cwd)`**）。
 *
 * @param {any} args
 * @param {string} cwd
 * @returns {string[]}
 */
export function collectPaths(args, cwd) {
  return collectTargets(args, cwd).map((t) => t.path)
}

/**
 * 拒绝文案里那一行「目标：…」——**带上来源**。
 *
 * 为什么必须带：缺陷 ③ 的现场就是文案打了一个**跟调用方给的 `file_path` 无关**的
 * 假路径，还自称"按路径判"。写上来源之后，"守门在说哪个参数"是可核对的。
 */
export function targetLine(target) {
  const p = typeof target === 'string' ? target : String(target?.path ?? '')
  const from = typeof target === 'string' ? '' : String(target?.from ?? '')
  return from.length > 0 ? `目标：${p}（来自参数 \`${from}\`）` : `目标：${p}`
}
