/**
 * dsh-pipeline · 守门工厂
 * ============================================================================
 * 把 `lib/guard.js` 的纯判据接到 DSH 的 `ctx.tools.guard` 上。
 *
 * 单独一个文件是因为这里有**四条与宿主实现绑定的约束**，必须集中在一处，
 * 免得散落到判据里去：
 *
 *   ① `ctx.tools.guard(fn)` 是**同步**调用的（`dsh-tools/lib/index.js:2646-2651`
 *      在同步循环里直接 `guard(exec)`）—— 所以判据只能用同步数据源。
 *      这就是为什么任务索引是一张内存 Map、而功能开关也必须同步可读。
 *
 *   ② 判据必须返回 `undefined` 才放行（`:2649` 判的是 `reason !== void 0`）。
 *
 *   ③ 判据**抛异常不是拒绝**（`:3267` 会把它吞成通用 tool error，理由文本丢失）。
 *      所以这里兜一层 try/catch，内部异常按 fail-closed 返回明确理由。
 *
 *   ④ **功能开关关掉时，守门必须"不存在"**（用户语义：关 = 守门不介入）。
 *      开关判定放在最前面、且早于一切其它判据 —— 关掉之后本守卫对任何调用
 *      都返回 `undefined`（弃权）。注意：`undefined` 是**弃权**不是"允许"，
 *      别的守卫（例如 dsh-archigate）照样能拒 —— 这正是我们要的语义：
 *      关掉的是"多 AI 协调"，不是"整个 DSH 的其它保护"。
 *
 * @module dsh-pipeline/lib/guard-factory
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_WRITE_TOOLS, agentIdOf, guardDecision, owningChangeScopeEntry } from './guard.js'
import { WRITE_LEDGER_FILE_NAME, WRITE_LEDGER_KIND, parseWriteLedger } from './hashgate.js'
import { fullHash, isInside, pathKey, resolveAgainstAnchor } from './util.js'

/** 内部异常时的拒绝文案（要能一眼看出是插件 bug，而不是模型操作错）。 */
const INTERNAL_FAILURE_PREFIX = '[pipeline] 守门内部异常，按 fail-closed 拒绝本次调用。这是插件 bug，不是你的操作问题。'

// ===========================================================================
// ★★ 「未申报的写入」拦截（守门作用域 · 2026-10-14 用户授权 C）
// ===========================================================================
//
// 要修的现场（P1-5）：机器产物豁免只按**路径形状**认 —— 编写把一处真实改动
// 命名成 `tests/<随便什么>-last-run.txt` 时，闸门会把它当成"测试台自己写的运行产物"。
// 根因是：**守门放行写入时，从不记下"谁写了哪个路径"**，于是到提交那一刻，
// 谁也说不清"这批字节是谁的"。
//
// 本判据把这件事补在**守门这一层**（写入发生时），而不是等提交时才猜：
//
//   一次**写类工具**调用要动一个**已经存在的文件**，而该文件当前这批字节
//   **没有任何凭据**（见下面四条凭据）⇒ **拒**（"未申报的写入"）。
//
// ---------------------------------------------------------------------------
// 四条**凭据**（有任何一条 ⇒ 放行；一条都没有 ⇒ 这批字节"没主" ⇒ 拒）
// ---------------------------------------------------------------------------
//   ① **开工状态**：内容与本单基线里那份**逐字节一致** ⇒ 自开工以来没人动过它
//      —— 改它就是"干自己的活"。（★ 没有这一条，编写连一个已存在的文件都改不了：
//      见下面「首次修改」那段论证。）
//   ② **有申报的产出**：台账（`.pipeline/*/write-ledger.jsonl`）里有任何一条申报
//      （`dev_to_test.change_manifest` 记下的"某席某次交出的路径 + 内容 sha256"）
//      与**当前内容逐字节一致** ⇒ 这批字节**有主**（谁申报的由台账写明）。
//   ③ **本单写过它**：本单（任一台账行 / 守门观察行）此前**合法写过**这条路径
//      ⇒ 编辑权延续给本单（否则"写一次 → 改个错字"就会被自己的第一次写入挡住）。
//   ④ **首次创建**：路径当前**不存在** ⇒ 放行（见下面「首次创建」那段论证）。
//
// ---------------------------------------------------------------------------
// ★ 首次创建：**放行**（判断与依据）
// ---------------------------------------------------------------------------
//   本判据要防的是"**把一份来历不明的、已存在的字节改成自己的**"。
//   一个**还不存在**的文件没有"前人的字节"可冒名 —— 危害形态在本判据的射程之外；
//   而"文件该不该建在这里"由**既有的范围判据**（授权面 / 分区 / 自有目录）管，
//   本判据不重复也不放宽它。反过来，若这里判拒：编写被派活的正常形态
//   （在授权面内**新增**文件 —— 真单的 `change_scope` 里就有 `action:"create"` 的条目）
//   会被整体挡死 ⇒ 那不是"可能误拦"，是**必然误拦核心工序**。
//   ⇒ 放行，但**记进台账**（`source: 'guard.write-allowed'`）：这样它在提交那一刻
//     仍然是"有记录的一笔"，闸门那一侧随时能按记录对账。
//
// ---------------------------------------------------------------------------
// ★ 首次**修改**一个已存在的文件：靠凭据①（开工状态）
// ---------------------------------------------------------------------------
//   这是**最常见的正常形态**（授权面写的是 `modify`）。没有凭据①，编写会连
//   "改一个既存文件的第一笔"都做不了 —— 而"文件当前内容 == 开工时内容"
//   恰恰就是"没人动过它"的机械证据。★ 这也是本判据与用户字面口径的**唯一**差别：
//   字面口径（"没有任何席位申报过 ⇒ 拒"）会把这一支也判拒 ⇒ 必然误拦。
//   这一支的落点是 `WARRANTS.baseline`，要改成字面口径只需删掉那一条凭据。
//
// ---------------------------------------------------------------------------
// ★ 与另外三条不变量的边界（一个字都不许动，见用户授权范围）
// ---------------------------------------------------------------------------
//   · **不在授权面内**的路径 ⇒ **本判据弃权**（那是既有范围判据的辖区，不是本判据的）；
//   · **`.pipeline/` 之内**（台账 / 审计 / 报告 / 记录 / 制品 / 任务卡）⇒ **豁免**
//     —— 绝不许自我拦截（守门自己就要往台账里追加观察行）；
//   · **项目根之外**（例如两棵树里的源码树）⇒ **弃权**：基线只覆盖项目根，
//     那里"开工状态"无据可依 ⇒ 拿不到凭据就不许拒（宁可少拦，不许误拦）；
//   · **没有台账**（旧任务 / 还没交过东西）⇒ 只靠凭据①/④照常工作；台账读不到 ⇒ 弃权；
//   · **不是流水线参与者**的会话 ⇒ 一条都不管（既有语义，一字不改）。
//
// ---------------------------------------------------------------------------
// ★ 已知拦不住（见交付报告第七节，如实登记）
// ---------------------------------------------------------------------------
//   · **shell 写**（`Set-Content` / `cp` / 重定向 / `node -e` …）：命令行里的路径要
//     重新解析一遍才认得出来，而那是 `lib/guard.js` 的活（本判据不许把那份判据抄一遍
//     —— 抄一遍就是两套口径）。⇒ 本判据只覆盖**写类工具**（write / edit / …）。
//   · **多文件补丁工具**（`apply_patch` 等）：参数里没有惯用的单一路径键 ⇒ 弃权。
//   · **不是流水线席位**的会话（含主对话、别的插件、用户自己的对话）：一律不管。
//   · `mtime` 被保留/回拨的场景（复制粘贴保持时间戳）凭据①可能误命中 —— 见报告。

/** 写类工具参数里的「目标路径」惯用键（与 `lib/guard.js` 的 `PATH_KEYS` 同向、取子集）。 */
const PRIMARY_PATH_KEYS = ['file_path', 'filepath', 'path', 'target_file', 'notebook_path', 'filename', 'file']

/** 台账行的来源标记（本判据写的那两种）。 */
export const GUARD_LEDGER_SOURCES = {
  /** 写入被放行（凭据见 `why`）—— 凭据③"本单写过它"就靠这些行。 */
  allowed: 'guard.write-allowed',
  /** 写入被拒（未申报的写入）—— 拒也要留痕。 */
  blocked: 'guard.write-blocked',
  /** 本判据自己出错的留痕（fail-open，但**不静默**）。 */
  failed: 'guard.write-check-failed',
}

/** 台账读取缓存（file → {stamp, entries}）：判据是**同步**的，缓存是它能跑的前提。 */
const LEDGER_CACHE = new Map()
/** 基线哈希缓存（file → {stamp, map}）。 */
const BASELINE_CACHE = new Map()
/** 内容哈希缓存（file → {stamp, sha256}）—— 同一份字节不重复算。 */
const HASH_CACHE = new Map()

const lk = (p) => pathKey(p).toLowerCase()

/** 取"目标路径"（只认惯用键：宁可漏扫，**绝不**把正文里出现的路径当成目标）。 */
function targetPathsOf(args, cwd) {
  if (args === null || typeof args !== 'object') return []
  const out = []
  const seen = new Set()
  for (const k of PRIMARY_PATH_KEYS) {
    const v = args[k]
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > 4096) continue
    const abs = resolveAgainstAnchor(cwd, v.trim())
    if (abs.length === 0) continue
    const key = lk(abs)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(pathKey(abs))
  }
  return out
}

/** 读一份台账（带 mtime+size 缓存）。`exists:false` = 还没有台账（旧任务/新任务）。 */
function readLedgerFile(dir) {
  const file = join(dir, WRITE_LEDGER_FILE_NAME)
  let st = null
  try {
    st = statSync(file)
  } catch {
    LEDGER_CACHE.delete(file)
    return { file, exists: false, entries: [], unreadable: false }
  }
  const stamp = `${st.size}:${Math.round(st.mtimeMs)}`
  const hit = LEDGER_CACHE.get(file)
  if (hit !== undefined && hit.stamp === stamp) return hit
  let entries = []
  try {
    entries = parseWriteLedger(readFileSync(file, 'utf8')).entries
  } catch {
    // 读不到 ⇒ **不猜**：这一份当空，并把 `unreadable` 如实带出去（调用侧据此弃权）。
    return { file, exists: true, entries: [], unreadable: true, stamp }
  }
  const rec = { file, exists: true, entries, unreadable: false, stamp }
  LEDGER_CACHE.set(file, rec)
  return rec
}

/**
 * 读**全部任务**的台账（本单的 + 别单的）。
 *
 * ★ 为什么要别单的：凭据②问的是"**这批字节有没有主**" —— 另一张单申报过的产物
 *   同样"有主"（真单 P2-13 的形状就是"别的单先改了同一个文件"）。
 *   "你能不能动它"是**范围判据**的事，不是本判据的事。
 */
function readAllLedgers(pipelineDir) {
  const out = []
  let unreadable = false
  let names = []
  try {
    names = readdirSync(pipelineDir, { withFileTypes: true })
  } catch {
    return { entries: out, unreadable: false, dir: pipelineDir }
  }
  for (const e of names) {
    if (e === null || typeof e !== 'object' || e.isDirectory?.() !== true) continue
    const rec = readLedgerFile(join(pipelineDir, e.name))
    if (rec.unreadable === true) unreadable = true
    for (const x of rec.entries) out.push(x)
  }
  return { entries: out, unreadable, dir: pipelineDir }
}

/**
 * 本单基线里"每个文件的开工哈希"（相对项目根的 POSIX 键 → sha256）。
 *
 * 基线是**只追加**的（每次重取多一个 `baseline-*.json`），当前基线就是**最新那一份**
 * ⇒ 按 mtime 取最新。取不到 / 读不动 ⇒ 返回 `null`（调用侧弃权：无据可依就不许拒）。
 */
function baselineHashesOf(pipelineDir, taskId) {
  const dir = join(pipelineDir, taskId)
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  let newest = null
  for (const n of names) {
    if (!/^baseline-.*\.json$/.test(n)) continue
    const f = join(dir, n)
    try {
      const st = statSync(f)
      if (newest === null || st.mtimeMs > newest.mtimeMs) newest = { file: f, mtimeMs: st.mtimeMs, size: st.size }
    } catch {
      /* 单个基线读不到不影响其它 */
    }
  }
  if (newest === null) return null
  const stamp = `${newest.size}:${Math.round(newest.mtimeMs)}`
  const hit = BASELINE_CACHE.get(newest.file)
  if (hit !== undefined && hit.stamp === stamp) return hit.map
  let map = null
  try {
    const rec = JSON.parse(readFileSync(newest.file, 'utf8'))
    const files = rec !== null && typeof rec === 'object' && rec.files !== null && typeof rec.files === 'object' ? rec.files : null
    if (files === null) return null
    map = new Map()
    for (const [rel, info] of Object.entries(files)) {
      const sha = typeof info?.sha256 === 'string' ? info.sha256.toLowerCase() : ''
      if (sha.length > 0) map.set(rel.replace(/\\/g, '/').toLowerCase(), sha)
    }
  } catch {
    return null
  }
  BASELINE_CACHE.set(newest.file, { stamp, map })
  return map
}

/** 文件当前内容的 sha256（与基线/台账同一套算法：`fullHash` 作用在 UTF-8 文本上，带缓存）。 */
function contentHashOf(abs) {
  let st = null
  try {
    st = statSync(abs)
  } catch {
    return null
  }
  if (st.isDirectory() === true) return null
  const stamp = `${st.size}:${Math.round(st.mtimeMs)}`
  const hit = HASH_CACHE.get(abs)
  if (hit !== undefined && hit.stamp === stamp) return hit.sha256
  let sha = null
  try {
    sha = fullHash(readFileSync(abs, 'utf8')).toLowerCase()
  } catch {
    return null
  }
  HASH_CACHE.set(abs, { stamp, sha256: sha })
  return sha
}

/** 台账里有没有"这批字节的申报产出"（凭据②）：任一条 `sha256` 与当前内容**逐字节一致**。 */
function declaredProductOf(entries, key, sha) {
  for (const e of entries) {
    for (const p of Array.isArray(e?.paths) ? e.paths : []) {
      if (lk(p?.key ?? '') !== key) continue
      const h = typeof p?.sha256 === 'string' && p.sha256.length > 0 ? p.sha256.toLowerCase() : null
      if (h !== null && h === sha) return { task_id: String(e.task_id ?? ''), role: String(e.role ?? ''), seat: e.seat ?? null, at: e.at ?? null, source: String(e.source ?? '') }
    }
  }
  return null
}

/** 本单有没有"合法写过它"（凭据③：任一台账行 —— 含守门的观察行）。 */
function observedByTask(entries, taskId, key) {
  for (const e of entries) {
    if (String(e?.task_id ?? '') !== taskId) continue
    for (const p of Array.isArray(e?.paths) ? e.paths : []) {
      if (lk(p?.key ?? '') === key) return true
    }
  }
  return false
}

/** 把一行观察**追加**进本单台账（只追加；失败绝不影响判定本身）。 */
function appendLedgerRow(pipelineDir, row) {
  try {
    appendFileSync(join(pipelineDir, row.task_id, WRITE_LEDGER_FILE_NAME), `${JSON.stringify(row)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 被拒时给编写看的话（**可执行**：说清判据、两条出路，且**不含代码**）。 */
function renderUndeclaredWrite(input) {
  const h8 = (s) => (typeof s === 'string' && s.length >= 8 ? s.slice(0, 8) : '(取不到)')
  const L = []
  L.push('[pipeline] 拒绝：这是一处**未申报的写入**（守门作用域 · 未申报写入拦截）。')
  L.push(`工具：${input.tool}\n路径：${input.path}`)
  L.push(`这批字节的 sha256（前 8 位）：${h8(input.sha256)}`)
  L.push('')
  L.push('判据（三条都不成立 ⇒ 这批字节**没有主**，改它等于把别人的/来历不明的字节算到自己头上）：')
  L.push('  ① 它不是本单**开工时**的内容（与本单基线对不上）；')
  L.push('  ② 台账里**没有任何**席位/单申报过这批字节（没有哪次交付声明的内容 sha256 与它一致）；')
  L.push('  ③ 本单此前也**没有**合法写过这条路径。')
  L.push('')
  L.push('两条出路：')
  L.push('  ① 若这批字节是**别的会话/别的单**改的、而你要接着改 ⇒ 交给计划 AI 处理：')
  L.push('     重取基线（新起点）或把该路径纳入授权面 —— 这两件事都不是编写自己该做的。')
  L.push('  ② 若这是你自己写过的、只是还没申报 ⇒ 先提交一次 dev_to_test 把改动面申报掉，再继续改。')
  L.push('')
  L.push('★ 这条判据**不问"你有没有越界"**（范围由别的判据管，本判据弃权）—— 它只问"这批字节有没有主"。')
  L.push('★ **新建文件不受本判据约束**（还不存在的文件没有"前人的字节"可冒名）。')
  L.push('★ 本判据已记入本单台账（`guard.write-blocked`），可事后复核。')
  return L.join('\n')
}

/**
 * 跑一次「未申报的写入」判定。
 *
 * @param {object} exec - 守门的调用对象（与 `guardDecision` 同一个）
 * @param {object} deps - 工厂依赖
 * @param {{get:(id:string)=>object|null}} index - 同步任务索引
 * @returns {string|undefined} 拒绝理由（`undefined` = 放行）
 */
function undeclaredWriteReason(exec, deps, index) {
  const warn = typeof deps?.warn === 'function' ? deps.warn : () => {}
  try {
    const name = String(exec?.name ?? '')
    const cfg = deps?.config ?? {}
    const writeTools = Array.isArray(cfg.guardFileTools?.write) && cfg.guardFileTools.write.length > 0 ? cfg.guardFileTools.write : DEFAULT_WRITE_TOOLS
    if (!writeTools.includes(name)) return undefined

    const tokens = deps?.tokens
    if (tokens === undefined || tokens === null || typeof tokens.roleOfAgent !== 'function') return undefined
    const agentId = agentIdOf(exec)
    // ★ 只约束**流水线参与者**：别的会话（用户自己的对话、别的插件、别的项目）一律不管。
    const binding = agentId === null ? null : tokens.roleOfAgent(agentId, undefined)
    if (binding === null || typeof binding?.taskId !== 'string') return undefined

    const task = index.get(binding.taskId)
    // 索引未命中 = "还没热身"，既有语义是 fail-open（并且 `onMissingTask` 已留痕）—— 这里照旧。
    if (task === null) return undefined

    const scope = Array.isArray(task.changeScope) ? task.changeScope : []
    // 没有授权面（L0）⇒ 本判据不适用（与既有"没有计划就没有改动面判据"同源）。
    if (scope.length === 0) return undefined

    const projectRoot = pathKey(task.projectRoot ?? '')
    if (projectRoot.length === 0) return undefined
    const pipelineDir = pathKey(task.pipelineDir ?? join(projectRoot, '.pipeline'))
    const taskId = String(task.taskId ?? '')

    /**
     * ★★ **向后兼容（用户硬要求）**：本单**还没有台账**（新任务 / 旧任务目录 /
     * 还没交过任何东西）⇒ **弃权**（照旧放行，也不写观察行）。
     *
     * 为什么必须这样：台账是 2026-10-14 才有的东西 —— 老任务目录里一个字节都没有。
     * 若"没有台账"就当成"没有任何申报"⇒ 所有人第一次写入全被拒 ⇒ 那是必然误拦。
     * 激活点是**本单第一次交付**（`dev_to_test` 会在台账里落下一行申报）：
     * 从那以后这条判据才开始问"这批字节有没有主"。
     */
    const ownLedger = readLedgerFile(join(pipelineDir, taskId))
    if (ownLedger.exists !== true || ownLedger.entries.length === 0) return undefined

    const targets = targetPathsOf(exec?.arguments, projectRoot)
    if (targets.length === 0) return undefined

    const ledgers = readAllLedgers(pipelineDir)
    const baseline = baselineHashesOf(pipelineDir, taskId)
    // ★ 拿不到凭据来源（台账读不动 / 基线读不动）⇒ **弃权**：宁可少拦，不许误拦。
    if (ledgers.unreadable === true || baseline === null) return undefined

    const stamp = new Date().toISOString()
    const allowed = []
    for (const abs of targets) {
      const key = lk(abs)
      // ① `.pipeline/` 之内（台账/审计/报告/记录/制品）：豁免 —— 绝不许自我拦截。
      if (isInside(pipelineDir, abs)) continue
      // ② 项目根之外（两棵树里的源码树…）：基线覆盖不到 ⇒ 无据可依 ⇒ 弃权。
      if (!isInside(projectRoot, abs)) continue
      // ③ 不在本单授权面内：那是**既有范围判据**的辖区，本判据弃权（不重复、也不放宽）。
      if (owningChangeScopeEntry(scope, abs, task.scopeAnchor ?? null) === null) continue
      // ④ 路径还不存在 ⇒ **首次创建** ⇒ 放行（依据见文件头）。但记进台账。
      if (!existsSync(abs)) {
        allowed.push({ abs, key, sha256: null, why: 'create' })
        continue
      }
      const sha = contentHashOf(abs)
      // 读不到内容 ⇒ 不猜（放行 + 记一条 sha256=null 的观察）。
      if (sha === null) {
        allowed.push({ abs, key, sha256: null, why: 'unreadable' })
        continue
      }
      // 凭据①：与本单基线逐字节一致 ⇒ 自开工没人动过它。
      const rel = lk(abs).startsWith(`${lk(projectRoot)}/`) ? lk(abs).slice(lk(projectRoot).length + 1) : null
      const baseSha = rel === null ? undefined : baseline.get(rel)
      if (typeof baseSha === 'string' && baseSha === sha) {
        allowed.push({ abs, key, sha256: sha, why: 'baseline' })
        continue
      }
      // 凭据②：台账里有申报过这批字节 ⇒ 有主。
      const owner = declaredProductOf(ledgers.entries, key, sha)
      if (owner !== null) {
        allowed.push({ abs, key, sha256: sha, why: 'declared' })
        continue
      }
      // 凭据③：本单此前合法写过它 ⇒ 编辑权延续。
      if (observedByTask(ledgers.entries, String(task.taskId ?? ''), key) === true) {
        allowed.push({ abs, key, sha256: sha, why: 'continuation' })
        continue
      }
      // ★ 一条凭据都没有 ⇒ 拒（并且**留痕**）。
      const reason = renderUndeclaredWrite({ tool: name, path: abs, sha256: sha })
      appendLedgerRow(pipelineDir, {
        t: WRITE_LEDGER_KIND,
        at: stamp,
        task_id: String(task.taskId ?? ''),
        role: String(binding.role ?? ''),
        seat: binding.seat ?? null,
        agent_id: agentId,
        baseline_id: null,
        submission_seq: null,
        source: GUARD_LEDGER_SOURCES.blocked,
        paths: [{ path: abs, key, sha256: null, pre_sha256: sha }],
        note: '守门拒绝：未申报的写入（这批字节既不是开工状态、也没有任何申报产出、本单也没写过它）。',
      })
      return reason
    }

    // 放行也要留痕：凭据③（"本单写过它"）就靠这些行；同时它让"谁写了哪个路径"可追溯。
    if (allowed.length > 0) {
      const ok = appendLedgerRow(pipelineDir, {
        t: WRITE_LEDGER_KIND,
        at: stamp,
        task_id: String(task.taskId ?? ''),
        role: String(binding.role ?? ''),
        seat: binding.seat ?? null,
        agent_id: agentId,
        baseline_id: null,
        submission_seq: null,
        source: GUARD_LEDGER_SOURCES.allowed,
        // ⚠️ `sha256` **刻意留空**（写之前的那一刻内容不是这次写入的产物）：
        //    只把 `pre_sha256` 记在行里 ⇒ 这一行**不会**参与哈希闸门那一侧的归属判据
        //    （那三条不变量一个字都不许动）。
        paths: allowed.map((x) => ({ path: x.abs, key: x.key, sha256: null, pre_sha256: x.sha256, why: x.why })),
        note: '守门放行：写入凭据逐条记在 paths[].why（baseline=开工状态 / declared=有申报的产出 / continuation=本单写过它 / create=首次创建 / unreadable=读不到内容）。',
      })
      if (ok !== true) warn(`[pipeline] 未能把守门写入观察写进台账（不影响本次放行）：${join(pipelineDir, String(task.taskId ?? ''), WRITE_LEDGER_FILE_NAME)}`)
    }
    return undefined
  } catch (err) {
    // ★ 本判据自己的异常 ⇒ **fail-open**（放行）+ **留痕**。
    //   理由：它是**附加**判据，一条 bug 若按 fail-closed 处理会把全部写入挡死
    //   （比"少拦一次"严重得多）；但绝不静默 —— 见下面这行 warn 与台账行。
    try {
      const tid = String(deps?.tokens?.roleOfAgent?.(agentIdOf(exec), undefined)?.taskId ?? '')
      const t = index.get(tid)
      if (t !== null && t !== undefined) {
        appendLedgerRow(pathKey(t.pipelineDir ?? join(pathKey(t.projectRoot ?? ''), '.pipeline')), {
          t: WRITE_LEDGER_KIND,
          at: new Date().toISOString(),
          task_id: tid,
          role: '',
          seat: null,
          agent_id: agentIdOf(exec),
          baseline_id: null,
          submission_seq: null,
          source: GUARD_LEDGER_SOURCES.failed,
          paths: [],
          note: `守门「未申报写入」判据内部异常，按 fail-open 放行本次调用（插件 bug）：${String(err?.message ?? err)}`,
        })
      }
    } catch {
      /* 留痕失败绝不该影响调用 */
    }
    warn(`[pipeline] 「未申报写入」判据内部异常，按 fail-open 放行本次调用（插件 bug，请修）：${String(err?.message ?? err)}`)
    return undefined
  }
}

/**
 * 造一个可直接交给 `ctx.tools.guard()` 的函数。
 *
 * @param {object} deps
 * @param {ReturnType<import('./tokens.js').createTokenStore>} deps.tokens
 * @param {object} deps.config
 * @param {Map<string, object>} deps.taskIndex - taskId → {taskId, projectRoot, pipelineDir, reportsDir}
 * @param {{isOn:()=>boolean}} [deps.sw] - 功能开关。**同步** `isOn()`。
 * @returns {(exec:object)=>string|undefined}
 */
export function createGuardFor(deps) {
  /**
   * ★ 索引未命中时的留痕（**只报一次 / 每个任务**，免得刷屏）。
   *
   * 为什么要它：守门要**同步**查任务，而任务在盘上、读取是异步的 ——
   * 索引取不到时，靠 task.projectRoot / taskSelfDir / writers 的那几条判据会
   * **整段跳过**。那是 fail-open，但**不能是静默的**：
   * "这段判据没跑到"必须在日志里看得见，否则就是假绿。
   */
  const alreadyWarned = new Set()
  const onMissingTask = (info) => {
    const key = String(info?.taskId ?? '?')
    if (alreadyWarned.has(key)) return
    alreadyWarned.add(key)
    const sink = typeof deps.warn === 'function' ? deps.warn : (m) => deps.ctx?.logger?.warn?.(m)
    if (typeof sink !== 'function') return
    try {
      sink(
        `[pipeline] 守门提示：任务 ${key} 还没进同步索引，**靠索引的那几条文件判据本次没有生效**` +
          `（工具=${info?.tool ?? '?'}，角色=${info?.role ?? '?'}）。` +
          '\n  这不是拒绝，是"没查到"—— 判据整段跳过（fail-open）。' +
          '\n  为什么会这样：守门必须同步判定，而任务数据在盘上、读取是异步的，索引只是缓存。' +
          '\n  怎么缓解：让该会话先做一次流水线动作（任何 pipeline_* 调用都会把任务登记进索引），' +
          '或在派活之后再做文件写入。本提示每个任务只报一次。',
      )
    } catch {
      /* 留痕失败绝不该影响守门 */
    }
  }
  const { tokens, config, taskIndex, sw, counter } = deps

  /** 同步查表包装：Map 的 get 找不到时返回 undefined，判据里要的是 null。 */
  const index = {
    get: (taskId) => {
      if (typeof taskId !== 'string' || taskId.length === 0) return null
      return taskIndex.get(taskId) ?? null
    },
  }

  return function pipelineGuard(exec) {
    // ④ 功能开关：关掉 = 本守卫弃权（返回 undefined，不是"允许"）。
    //    放在 try 外面、且早于一切判据 —— 关掉之后不应该再有任何本插件的理由文本。
    if (sw !== undefined && sw !== null) {
      let on
      try {
        on = sw.isOn() === true
      } catch (err) {
        // 开关自己坏了：宁可照常守（fail-closed），也不能因为读开关失败就静默放行。
        return `${INTERNAL_FAILURE_PREFIX}\n读功能开关失败：${String(err?.message ?? err)}`
      }
      if (!on) return undefined
    }

    try {
      // ★ 客观观测：每经过一次工具调用就记一笔（按 agent 分桶）。
      //   它不是"上下文占用"的度量 —— 只是"这个席位有多忙"的客观代理指标，
      //   用来给席位自报的水位做交叉印证。放在最前面，开关关掉也照数。
      if (counter !== undefined && counter !== null) {
        try {
          counter.touch(agentIdOf(exec), exec?.name)
        } catch {
          /* 计数失败绝不该拦住调用 */
        }
      }
      // ★★ 顺序是**硬要求**：既有判据**先跑**，只有它放行（`undefined`）之后才轮到
      //    本轮新增的「未申报的写入」判据。这样既有反例的**拒绝原文一个字都不会变**
      //    （否则"未申报"会盖住"越界/分区/越权"这些既有理由，既有断言全部失守）。
      const existing = guardDecision(exec, { tokens, config, taskIndex: index, retired: deps.retired, onMissingTask })
      if (existing !== undefined) return existing
      return undeclaredWriteReason(exec, deps, index)
    } catch (err) {
      return `${INTERNAL_FAILURE_PREFIX}\n工具：${String(exec?.name ?? '(未知)')}\n异常：${String(err?.message ?? err)}`
    }
  }
}
