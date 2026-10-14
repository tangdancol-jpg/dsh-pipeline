/**
 * dsh-pipeline · 守门 · 脚本展开
 * ============================================================================
 * 从 `lib/guard.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/guard.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/guard/scripts
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE_ROOT, pathKey, resolveAgainstAnchor } from '../util.js'
import { TAG } from './rules.js'
import { scanShellCommand } from './shell.js'

// ---------------------------------------------------------------------------
// ★★ C3（2026-10-14）：脚本正文展开 —— 让守门能"读脚本正文再判"
//
// 盲区怎么来的：F 路把「多行 / 带引号 / 带中文的命令 ⇒ 先落盘成脚本文件，再执行」
//   写进了 system prompt 与席位简报（理由：多层转义 ⇒ MALFORMED_RESPONSE ⇒ 整轮作废，
//   那是最贵的一种 token 浪费）。这条指引把**正经用法**变成"命令 = 一个脚本文件路径"，
//   而上面 `collectCommandStrings` 只收**命令行字符串** ⇒ **看不到脚本正文**
//   ⇒ 把违禁内容写进脚本再执行，既有全部 shell 判据一起失效（守门睁眼瞎）。
//
// 补法：**只加展开，不动任何既有判据**（阈值 / 名单 / 语义一个字节都没改）。
//   把「命令里确实被执行的那个脚本」的正文读出来，喂回**同一个**
//   {@link scanShellCommand}。唯一调用点在本文件 shell 旁路那一处
//   （{@link scanCommandWithScripts}），别处照旧直接调 `scanShellCommand`。
//
// ★ 四条自我设限（免得补丁自己变成新的洞）：
//
//   ① **只读"确实被执行的脚本"**：字符串不是路径（带引号残渣 / 括号 / `=` / `$`
//      这类表达式字符）/ 文件不存在 / 不是普通文件 / 扩展名不在 `SCRIPT_EXTS` 里
//      ⇒ 一律不读。读出来的正文**只用于匹配、从不回显**（拒绝文案里只有命令片段，
//      没有正文）⇒ 守门不会被当成"读任意文件"的通道。
//
//   ② **深度上限 1 层**（`SCRIPT_EXPAND_MAX_DEPTH`）：命令行 → 脚本（depth=1）。
//      脚本**内部**再出现脚本执行形态就**不再展开**，但记进 `capped` 痕迹
//      （"展开了但到顶"），由 {@link lastScriptExpansion} 取出来看。
//      为什么封顶：展开是**树的遍历**，不封顶等于让一次工具调用触发无界的文件读取
//      —— 守门自己就成了开销源。1 层正好覆盖本次盲区的实际形态（F 路的指引是把
//      **一条命令**落盘成**一个**脚本）。
//
//   ③ **读不到 ≠ 放行**（fail-closed），但不许误拦正常脚本 —— 三条口径分开：
//      · 文件**不存在** ⇒ 没有可执行的正文、也就没东西可藏 ⇒ 跳过（记 `missing`）。
//        这一条与下一条的分界就是"能不能藏东西"：藏东西的前提是文件真的在。
//      · 文件**存在却读不出**（权限 / 句柄被占 / 打开失败）⇒ **拒**。
//        能藏却读不到，就是既有口径里的"扫描不到 ⇒ 不放过"。
//      · **太大** ⇒ **不拒**，只读头部 `SCRIPT_EXPAND_MAX_BYTES` 再扫，痕迹里标
//        `truncated`。按体积拒会误拦正常的大脚本；按体积跳过会开一个"把违禁命令
//        放在 64KB 之后"的洞 —— 读头部是唯一两边都不吃亏的处置。
//
//   ④ **不许自我递归**：候选路径若正是守门自己这一族文件（`guard.js` /
//      `guard-factory.js` / `hashgate.js`）⇒ 跳过（记 `self`）；展开期间置重入标志，
//      重入调用直接返回空痕迹 —— 与深度上限构成双保险。
//
// ⚠️ 诚实边界：展开器**自己**抛异常时，降级为"改前行为"（既有判据已经先跑过并给过
//   答案，不会被展开器改写），并在痕迹里记 `threw`。这与第 ③ 条不矛盾 —— 那条说的是
//   "脚本文件读不出来"（可判定、且能藏东西），这条说的是"展开器自身出错"（不可判定，
//   一律拒会让整个 shell 通道全红）。见 README「哪些是约定」。
// ---------------------------------------------------------------------------

/** 脚本展开：单条命令最多读几个脚本文件。 */
const SCRIPT_EXPAND_MAX_FILES = 4
/** 脚本展开：每个文件最多读多少字节（**只读头部**；体积本身不是拒绝理由）。 */
const SCRIPT_EXPAND_MAX_BYTES = 64 * 1024
/** 脚本展开：深度上限（1 = 只展开命令行直接点名的那一层）。 */
const SCRIPT_EXPAND_MAX_DEPTH = 1
/** 脚本展开：每类痕迹最多记几条。 */
const SCRIPT_EXPAND_MAX_TRACE = 8

/** 会被读进来扫描的脚本扩展名（不在名单里的一律不读 —— 防止变成"读任意文件"）。 */
const SCRIPT_EXTS = Object.freeze([
  'sh', 'bash', 'zsh', 'ksh', 'dash', 'fish', 'nu',
  'ps1', 'psm1', 'bat', 'cmd',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  'py', 'rb', 'pl', 'pm', 'php', 'lua', 'r', 'groovy', 'exs',
])

/** 认得出来的解释器名（先定位它，再到**同一个命令段**里挑脚本 token）。 */
const SCRIPT_INTERPRETERS = Object.freeze([
  'node', 'nodejs', 'deno', 'bun', 'ts-node', 'tsx',
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'nu',
  'pwsh', 'powershell', 'cmd',
])

/** POSIX shell 那一族的词（只为在文案里把形态说清）。 */
const POSIX_SHELL_WORDS = Object.freeze(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'nu'])

/**
 * 解释器位置：前面是命令分隔符/空白/引号（引号那一支是为了认
 * `bash -c "node x.mjs"` 这种内嵌形态），后面必须是空白（免得认到 `nodes`）。
 */
const RE_SCRIPT_INTERP = /(?:^|[\s;&|(/\\"'])([A-Za-z][\w.-]*?)(?:\.exe)?(?=\s)/g

/**
 * 直接执行形态：`./x.sh` `.\x.ps1`。
 * ★ 边界刻意**不含引号与 `(`**：`require("./x.js")` 里的字符串字面量不是"被执行"。
 */
const RE_SCRIPT_DIRECT = /(?:^|[\s;&|])((?:\.{1,2}[\\/])[^\s;&|()<>"']+)/g

/** 命令段里的 token（成对引号优先，其次是裸 token）。 */
const RE_SCRIPT_TOKEN = /("[^"]*"|'[^']*'|\S+)/g

/** 去过引号之后还带这些字符 ⇒ 它不是路径，是表达式 / 代码片段。 */
const SCRIPT_REF_BAD_CHARS = /['"`()=$!]/

/**
 * 守门自己这一族文件（**绝不展开**）：从本模块的位置推出来。
 * 推不出来（`import.meta.url` 不可用）就退化成空集 —— 不因为推不出而放宽别的判据。
 */
/** `lib/guard/` 下的子模块（守门本体拆成这几份，同属"自己这一族"）。 */
const GUARD_SUBMODULES = ['rules.js', 'seats.js', 'shell.js', 'scripts.js', 'decide.js']
const GUARD_SELF_FILES = (() => {
  const set = new Set()
  try {
    const here = pathKey(fileURLToPath(import.meta.url))
    // 本文件在 lib/guard/ 下 ⇒ 比拆分前（lib/guard.js）多上一级才是 lib/
    const cut = here.lastIndexOf('/')
    const guardDir = cut > 0 ? here.slice(0, cut) : ''
    const cut2 = guardDir.lastIndexOf('/')
    const dir = cut2 > 0 ? guardDir.slice(0, cut2) : ''
    const own = ['guard.js', 'guard-factory.js', 'hashgate.js', ...GUARD_SUBMODULES.map((m) => `guard/${m}`)]
    for (const f of own) set.add(dir.length > 0 ? `${dir}/${f}` : f)
  } catch {
    /* 推不出自身位置 ⇒ 空集（上面那条退化口径） */
  }
  return set
})()

/** 去掉成对或残余的引号。 */
function stripScriptQuotes(v) {
  const s = String(v ?? '').trim()
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) return s.slice(1, -1)
  return s.replace(/^["']+|["']+$/g, '')
}

/** 取扩展名（小写；无扩展名或只有隐藏名前缀时返回空串）。 */
function scriptExtOf(p) {
  const base = stripScriptQuotes(p).replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** 这个 token 像不像"一个脚本文件"（不含存在性判断 —— 那是后面的事）。 */
function looksLikeScriptRef(raw) {
  const s = stripScriptQuotes(raw)
  if (s.length === 0 || s.length > 400) return false
  if (s.startsWith('-')) return false
  if (SCRIPT_REF_BAD_CHARS.test(s)) return false
  if (s.includes('/') || s.includes('\\')) return true
  const ext = scriptExtOf(s)
  return ext.length > 0 && SCRIPT_EXTS.includes(ext)
}

/** 命令段 = 到下一个 `;` `&` `|` 或换行为止（`&&`/`||` 自然也在内）。 */
function scriptSegmentOf(text, from) {
  const rest = String(text).slice(from)
  const cut = rest.search(/[;&|\n]/)
  return cut < 0 ? rest : rest.slice(0, cut)
}

/** 按"成对引号优先"切 token。 */
function scriptTokensOf(seg) {
  const out = []
  const re = new RegExp(RE_SCRIPT_TOKEN.source, 'g')
  let m = re.exec(seg)
  while (m !== null) {
    out.push(m[1])
    m = re.exec(seg)
  }
  return out
}

/**
 * 从一条命令里挑出"被执行到的脚本文件"（**纯字符串工作，一次 I/O 都不做**）。
 *
 * 形态刻意只挑本机**实际会出现**的那几种（F 路的指引 + 本仓库自测里真在用的写法）：
 *   `node x.mjs` · `pwsh -File x.ps1` · `bash x.sh` · `sh ./x` · `cmd /c x.bat` · `./x.sh`
 * ★ `-c` / `-Command` / `-e` 那几种**不是脚本文件**（命令正文本来就在命令行字符串里，
 *   既有扫描器照旧看得到），这里不碰。
 *
 * @param {string} text
 * @param {number} limit
 * @returns {{raw:string, ext:string, how:string}[]}
 */
export function findScriptRefs(text, limit = SCRIPT_EXPAND_MAX_FILES) {
  const out = []
  const seen = new Set()
  const add = (raw, how) => {
    if (out.length >= limit) return
    const key = stripScriptQuotes(raw)
    if (key.length === 0 || seen.has(key)) return
    if (!looksLikeScriptRef(key)) return
    seen.add(key)
    out.push({ raw: key, ext: scriptExtOf(key), how })
  }
  if (typeof text !== 'string' || text.length === 0) return out

  // ① 直接执行：./x.sh  .\x.ps1
  {
    const re = new RegExp(RE_SCRIPT_DIRECT.source, 'g')
    let m = re.exec(text)
    while (m !== null) {
      add(m[1], '直接执行（./x.sh）')
      m = re.exec(text)
    }
  }

  // ② 解释器：先定位解释器，再到同一个命令段里挑脚本 token
  {
    const re = new RegExp(RE_SCRIPT_INTERP.source, 'g')
    let m = re.exec(text)
    while (m !== null) {
      const word = String(m[1]).toLowerCase()
      const after = m.index + m[0].length
      m = re.exec(text)
      if (!SCRIPT_INTERPRETERS.includes(word)) continue
      const toks = scriptTokensOf(scriptSegmentOf(text, after))
      if (word === 'pwsh' || word === 'powershell' || word === 'cmd') {
        // 这两个只认显式的脚本开关；没有开关（`-Command` / 位置参数）才退回通用挑法
        const anchor = toks.findIndex((t) => /^(-file|\/c)$/i.test(stripScriptQuotes(t)))
        if (anchor >= 0) {
          if (anchor + 1 < toks.length) add(toks[anchor + 1], word === 'cmd' ? 'cmd /c' : 'PowerShell -File')
          continue
        }
      }
      const how = POSIX_SHELL_WORDS.includes(word) ? 'POSIX shell（bash / sh / zsh …）' : 'js 运行时（node / deno / bun / tsx）'
      for (const t of toks) add(t, how)
    }
  }
  return out
}

/**
 * 把候选路径解析成绝对路径（**先绝对化，再看存不存在**）。
 * 相对路径按锚点解析：任务根优先（与 `collectPaths` 同一条口径），其次改动面锚点。
 */
function resolveScriptCandidate(raw, roots) {
  const s = stripScriptQuotes(raw)
  if (s.length === 0) return ''
  if (isAbsolute(s) || /^[a-z]:[\\/]/i.test(s)) return pathKey(s)
  let first = ''
  for (const r of roots) {
    const cand = resolveAgainstAnchor(r, s)
    if (cand.length === 0) continue
    if (first.length === 0) first = cand
    try {
      if (existsSync(cand)) return cand
    } catch {
      /* 探测失败当作不存在，继续试下一个锚点 */
    }
  }
  return first
}

/**
 * 只读文件**头部**：先按上限分配缓冲，再 `readSync`。
 * ★ 为什么不用 `readFileSync`：那会把整个文件读进内存 —— 一个 2GB 的脚本
 *   就足以让守门自己变成资源消耗点，而它本来只是一个判据。
 */
function readScriptHead(abs, maxBytes) {
  const fd = openSync(abs, 'r')
  try {
    const buf = Buffer.allocUnsafe(maxBytes)
    const n = readSync(fd, buf, 0, maxBytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* 关不上不影响结论（读已经读完了） */
    }
  }
}

function pushTrace(list, item) {
  if (list.length < SCRIPT_EXPAND_MAX_TRACE) list.push(item)
}

let LAST_SCRIPT_EXPANSION = null
let SCRIPT_EXPAND_BUSY = false

/**
 * 最近一次脚本展开的痕迹（**只读**）。
 *
 * 用途：`capped` 那一条 —— "脚本里还引用了脚本，但到了深度上限、没再展开"。
 * 这件事**不改判据**（不因为到顶就拒），所以只能靠这份痕迹"报出来"，
 * 让"展开了但到顶"看得见，而不是静默。
 */
export function lastScriptExpansion() {
  return LAST_SCRIPT_EXPANSION
}

/**
 * 展开一条命令里"被执行到的脚本"的正文。
 *
 * @param {string} cmd - 命令行字符串
 * @param {{projectRoot?:string, anchor?:string}} [opts] - 相对路径的解析锚点
 * @returns {{command:string, bodies:{text:string,path:string,how:string,depth:number,readBytes:number,truncated:boolean}[],
 *   capped:object[], truncated:object[], unreadable:object[], skipped:object[]}}
 *   `unreadable` 非空 ⇒ 调用方按 fail-closed 处理（**不许放行**）。
 */
export function expandScriptCommands(cmd, opts = {}) {
  const report = { command: String(cmd ?? ''), bodies: [], capped: [], truncated: [], unreadable: [], skipped: [] }
  const text = report.command
  const roots = []
  for (const r of [opts.projectRoot, opts.anchor]) {
    if (typeof r === 'string' && r.length > 0 && !roots.includes(r)) roots.push(r)
  }
  if (text.length === 0) {
    LAST_SCRIPT_EXPANSION = report
    return report
  }
  if (SCRIPT_EXPAND_BUSY) {
    // ★ 自我递归护栏（第 ④ 条）：展开期间的重入直接返回空痕迹
    pushTrace(report.skipped, { path: '', why: 'reentrant' })
    LAST_SCRIPT_EXPANSION = report
    return report
  }
  SCRIPT_EXPAND_BUSY = true
  try {
    for (const ref of findScriptRefs(text, SCRIPT_EXPAND_MAX_FILES)) {
      const abs = resolveScriptCandidate(ref.raw, roots)
      if (abs.length === 0) {
        pushTrace(report.skipped, { path: ref.raw, why: 'unresolvable' })
        continue
      }
      // ★ 第 ④ 条：守门自己这一族文件绝不展开
      if (GUARD_SELF_FILES.has(abs)) {
        pushTrace(report.skipped, { path: abs, why: 'self' })
        continue
      }
      let st = null
      try {
        st = statSync(abs)
      } catch {
        st = null
      }
      if (st === null) {
        pushTrace(report.skipped, { path: abs, why: 'missing' })
        continue
      }
      if (st.isFile() !== true) {
        pushTrace(report.skipped, { path: abs, why: 'not-a-file' })
        continue
      }
      const ext = scriptExtOf(abs)
      if (ext.length > 0 && !SCRIPT_EXTS.includes(ext)) {
        pushTrace(report.skipped, { path: abs, why: 'ext' })
        continue
      }
      let body = null
      try {
        body = readScriptHead(abs, SCRIPT_EXPAND_MAX_BYTES)
      } catch (err) {
        // ★ 第 ③ 条：存在却读不出 ⇒ 记进 unreadable，由调用方 fail-closed
        pushTrace(report.unreadable, { path: abs, error: String(err?.code ?? err?.message ?? err) })
        continue
      }
      if (typeof body !== 'string' || body.length === 0) {
        pushTrace(report.skipped, { path: abs, why: 'empty' })
        continue
      }
      const fileBytes = Number(st.size ?? 0)
      const truncated = fileBytes > SCRIPT_EXPAND_MAX_BYTES
      if (truncated) pushTrace(report.truncated, { path: abs, readBytes: body.length, fileBytes })
      report.bodies.push({ text: body, path: abs, how: ref.how, depth: SCRIPT_EXPAND_MAX_DEPTH, readBytes: body.length, truncated })

      // ★ 第 ② 条：脚本内部**再**出现脚本执行形态 ⇒ 到此为止，但留痕（"展开了但到顶"）
      for (const inner of findScriptRefs(body, SCRIPT_EXPAND_MAX_TRACE)) {
        const innerAbs = resolveScriptCandidate(inner.raw, roots)
        let exists = false
        try {
          exists = innerAbs.length > 0 && statSync(innerAbs).isFile() === true
        } catch {
          exists = false
        }
        pushTrace(report.capped, {
          raw: inner.raw,
          path: innerAbs.length > 0 ? innerAbs : inner.raw,
          from: abs,
          depth: SCRIPT_EXPAND_MAX_DEPTH + 1,
          limit: SCRIPT_EXPAND_MAX_DEPTH,
          exists,
        })
      }
    }
  } catch (err) {
    // ⚠️ 展开器自身出错 ⇒ 降级为"改前行为"（既有判据已先跑过），只留痕
    pushTrace(report.skipped, { path: '', why: 'threw', error: String(err?.message ?? err) })
  } finally {
    SCRIPT_EXPAND_BUSY = false
    LAST_SCRIPT_EXPANSION = report
  }
  return report
}

/** 脚本正文触发的拒绝文案（**原样透传**内层既有判据的原文，证明确实是它抓到的）。 */
function scriptBodyRejection(cmd, task, b, inner) {
  return (
    `${TAG} 拒绝：命令执行的**脚本正文**里有被禁止的内容。\n` +
    `任务：${task.taskId}\n命令：${String(cmd).slice(0, 200)}\n` +
    `脚本：${b.path}\n` +
    `识别形态：${b.how}（展开深度 ${b.depth}/${SCRIPT_EXPAND_MAX_DEPTH}；已读 ${b.readBytes} 字节` +
    `${b.truncated ? '，**文件更大、只扫了头部**' : ''}）\n` +
    '★ 这一条是**把脚本正文读出来、喂回同一个扫描器**之后抓到的 —— 改前脚本正文不参与扫描，这种写法是盲区。\n' +
    '── 以下是脚本正文触发的既有判据原文 ──\n' +
    inner
  )
}

/** 脚本读不出来的拒绝文案（fail-closed）。 */
function scriptUnreadableRejection(cmd, task, item) {
  return (
    `${TAG} 拒绝：命令要执行的脚本**读不出来**，无法核实内容。\n` +
    `任务：${task.taskId}\n命令：${String(cmd).slice(0, 200)}\n` +
    `脚本：${item.path}（${item.error}）\n` +
    '原因：守门要读脚本正文才判得动，**存在却读不出**就是"扫描不到" —— 按 fail-closed 不放行。\n' +
    '出路：把脚本改成可读（去掉独占占用 / 换权限），或者把命令直接写在命令行上（那种形态本来就在扫描范围内）。'
  )
}

/**
 * ★★ C3 的**唯一**入口：既有判据先跑，判不出来才展开脚本正文再跑同一个扫描器。
 *
 * 顺序刻意如此 —— 这是"改前逐字节一致"的保证：老判据认得出来的命令，返回的还是
 * **同一条**拒绝理由（文案一个字节都没动）；只有老判据**放行**的命令才多走一步。
 *
 * @param {string} cmd
 * @param {object} task
 * @param {string} role
 * @param {object} [cfg]
 * @returns {string|null|undefined} 拒绝理由；`null` = 放行
 */
export function scanCommandWithScripts(cmd, task, role, cfg = {}) {
  const direct = scanShellCommand(cmd, task, role, cfg)
  if (direct !== null) return direct
  if (cfg.guardScriptBodies === false) return null
  if (task === null || task === undefined) return null
  const exp = expandScriptCommands(cmd, {
    projectRoot: typeof task.projectRoot === 'string' ? task.projectRoot : '',
    anchor: typeof task.scopeAnchor === 'string' ? task.scopeAnchor : PACKAGE_ROOT,
  })
  // 正文先扫（有命中就报最具体的那条），再判"读不出来"
  for (const b of exp.bodies) {
    const hit = scanShellCommand(b.text, task, role, cfg)
    if (hit !== null) return scriptBodyRejection(cmd, task, b, hit)
  }
  if (exp.unreadable.length > 0) return scriptUnreadableRejection(cmd, task, exp.unreadable[0])
  return null
}
