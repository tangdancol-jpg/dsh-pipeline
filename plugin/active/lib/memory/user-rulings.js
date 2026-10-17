// 跨项目"用户裁定"库：把记忆里 `kind:'ruling'` 的条目**幂等**地维护成 `~/.dsh/skills/<name>/SKILL.md`。
/**
 * dsh-pipeline · 记忆 · 跨项目用户裁定库（E4）
 * ============================================================================
 * 痛点 C（设计 `01`）：用户反复强调的原则**散在各次会话里** —— 换个项目再从零讲一遍。
 * 这一层把它们收进一个**跨项目**、**可见可编辑**的文件：`<dsh-home>/skills/<name>/SKILL.md`。
 * 那份文件由宿主自己的 skill 文件系统扫进 `<available_skills>`（`02` §2.3/§2.4），
 * 所以**不需要运行时注册**（用户裁定 1：不用 `ctx.skills.register()`）。
 *
 * ---------------------------------------------------------------------------
 * ★ 四条硬要求（用户裁定，逐条落在下面，每条都有测试钉）
 * ---------------------------------------------------------------------------
 *   ① **幂等**：同一批裁定重复发布 ⇒ **一次写盘都不发生**。
 *      靠两件事：裁定 id 由**正文哈希**算出（同名同物必然同 id）⇒ 合并是集合语义；
 *      渲染是纯函数 ⇒ 同集合必然同文本（比文本就知道要不要写）。
 *   ② **绝不覆盖既有的 skill 文件**：目标存在但**没有本插件的 marker**
 *      ⇒ 停下报告（`FOREIGN_SKILL_EXISTS`），**一个字节都不动**。
 *   ③ **写之前先备份**：目标存在（且是我们的）⇒ 先留一份 `<file>.bak-<时刻>`。
 *   ④ **只在确有用例时写**：一条裁定都没有 ⇒ 连目录都不建（`NO_RULINGS`，不写空壳）。
 *
 * ★ 受管区块之外**原样保留**（用户手写的东西不被重建吃掉）—— "可见、可编辑"的落点。
 * ★ 总开关：off ⇒ 直接返回 `SWITCH_OFF`（`SWITCH_SURFACES` 的 `user-rulings` 那一行）。
 *   ⚠️ off **不删**已经发出去的那份文件（它是给人看的文件，删它 = 毁掉用户的手改）。
 *
 * @module dsh-pipeline/lib/memory/user-rulings
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { fullHash } from '../util.js'
import { surfaceAllowed } from '../switch/gate.js'
import { memoryFile } from './bank.js'
import { readBank } from './load.js'
import {
  RULINGS_BEGIN,
  RULINGS_END,
  RULINGS_MARKER,
  RULINGS_SKILL_NAME,
  managedPartOf,
  renderRulingsSkill,
} from './live-doc-render.js'

/**
 * 本写点在 `SWITCH_SURFACES` 里的 id（**一处定义**）。
 *
 * 为什么要单独一行而不是搭 `memory-live-doc` 的车：这一条写的是**项目目录之外**的文件，
 * 是"本插件会往家目录写东西"的唯一一处 —— 关掉功能之后它必须停（判据：off ⇒ 不写盘）。
 */
export const RULINGS_SURFACE = 'user-rulings'

/** 记忆域里"一条裁定"的 `kind`（与 `record.js` 的 `KIND` 同一形状规则，开放集）。 */
export const RULING_KIND = 'ruling'

/** 单条裁定正文的上限（裁定是**一句话的边界**，不是备忘录）。 */
export const RULING_TEXT_MAX = 200

/**
 * ★ **候选 skills 根目录**（照 `lib/liveness/activity.js` 的 `sessionsRootCandidates` 同一套写法：越具体越先试）。
 *
 * 优先级与 `dsh-skill-filesystem` 的发现根一致（`02` §2.3 的 `user-dsh` 400 那一档）：
 * `DSH_SKILLS_DIR` → `$DSH_HOME/skills` → `<profile 的上两级>/skills` → `~/.dsh/skills`。
 *
 * @param {object} [env] - 默认 `process.env`
 * @param {string} [home] - 默认 `os.homedir()`（自测可固定）
 * @returns {string[]} 去重后的候选（可能为空数组）
 */
export function skillsRootCandidates(env = process.env, home = homedir()) {
  const out = []
  const push = (p) => {
    if (typeof p === 'string' && p.length > 0 && !out.includes(p)) out.push(p)
  }
  push(env?.DSH_SKILLS_DIR)
  if (typeof env?.DSH_HOME === 'string' && env.DSH_HOME.length > 0) push(join(env.DSH_HOME, 'skills'))
  if (typeof env?.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR.length > 0) {
    push(join(dirname(dirname(env.DSH_PROFILE_DIR)), 'skills'))
  }
  if (typeof home === 'string' && home.length > 0) push(join(home, '.dsh', 'skills'))
  return out
}

/** 默认 skills 根（第一个候选；取不到 ⇒ 空串 —— 调用方据此**不猜落点**）。 */
export function defaultSkillsRoot(env = process.env, home = homedir()) {
  const list = skillsRootCandidates(env, home)
  return list.length > 0 ? list[0] : ''
}

/** 折一条裁定的正文（空白折叠 + 去首尾）：**id 就是它的哈希** ⇒ 同一句话跨项目同 id。 */
export function normalizeRulingText(value) {
  const s = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length <= RULING_TEXT_MAX ? s : `${s.slice(0, RULING_TEXT_MAX - 1)}…`
}

/** 裁定 id：`R-<正文哈希前 8 位>`（**同物同名**：换项目、换时间、换来源都还是同一条）。 */
export function rulingId(text) {
  const body = normalizeRulingText(text)
  return body.length === 0 ? '' : `R-${fullHash(body).slice(0, 8)}`
}

/**
 * 一条记忆 → 一条裁定（**纯函数**）。不是 `kind:'ruling'` / 正文为空 ⇒ `null`。
 *
 * @param {object} record
 * @returns {{id:string, text:string, at:string, source:string}|null}
 */
export function rulingOf(record) {
  const r = record !== null && typeof record === 'object' ? record : {}
  if (String(r.kind ?? '') !== RULING_KIND) return null
  const text = normalizeRulingText(r.text)
  const id = rulingId(text)
  if (id.length === 0) return null
  return { id, text, at: String(r.at ?? ''), source: String(r.refs?.task_id ?? '') }
}

/**
 * ★ **收集裁定**（纯函数）：只留 `kind:'ruling'`，按 id 去重，**排序**输出。
 *
 * 同 id 的取舍写死：留 `at` **字典序最小**的那条（即最早记下的那次），
 * `at` 相同再比 `source` —— 全程无随机、无"看谁后到"。
 *
 * @param {object[]} records
 * @returns {Array<{id:string, text:string, at:string, source:string}>}
 */
export function collectRulings(records) {
  const list = Array.isArray(records) ? records : []
  const byId = new Map()
  for (const rec of list) {
    const r = rulingOf(rec)
    if (r === null) continue
    const cur = byId.get(r.id)
    if (cur === undefined || r.at < cur.at || (r.at === cur.at && r.source < cur.source)) byId.set(r.id, r)
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * ★ **解析既有文件**（纯函数）。
 *
 * @param {unknown} text - 已存在文件的正文
 * @returns {{ours:boolean, rulings:Array, tail:string}}
 *   `ours:false` = **不是本插件生成的**（调用方据此"停下报告，不覆盖"）
 */
export function parseSkillFile(text) {
  const src = String(text ?? '')
  if (!src.includes(RULINGS_MARKER)) return { ours: false, rulings: [], tail: '' }
  const begin = src.indexOf(RULINGS_BEGIN)
  const end = src.indexOf(RULINGS_END)
  const body = begin >= 0 && end > begin ? src.slice(begin + RULINGS_BEGIN.length, end) : ''
  const rulings = []
  for (const line of body.split('\n')) {
    const m = /^- \[(R-[0-9a-f]{8})\] (.*)$/.exec(line.trim())
    if (m === null) continue
    rulings.push({ id: m[1], text: normalizeRulingText(m[2]), at: '', source: '' })
  }
  // 区块之外（含用户手写段）原样保留。
  const tail = end >= 0 ? src.slice(end + RULINGS_END.length) : ''
  return { ours: true, rulings, tail }
}

/**
 * ★★ **发布**（唯一写点；幂等、不覆盖外来文件、写前备份、绝不抛）。
 *
 * @param {object} opts
 * @param {string} opts.skillsRoot - skills 根目录（空串 ⇒ `NO_SKILLS_ROOT`）
 * @param {Array} [opts.rulings] - 已收集好的裁定（不给就按空集合算）
 * @param {(()=>object|null)|object|null} [opts.swOf]
 * @param {object} [opts.fs] - `{readFile, writeFile, mkdir}`
 * @param {()=>Date} [opts.now] - 备份文件名里的时刻
 * @param {(m:string)=>void} [opts.warn]
 * @param {string} [opts.name]
 * @returns {Promise<{ok:boolean, wrote:boolean, reason:string, path:string, count:number, backup:string}>}
 */
export async function publishRulings(opts = {}) {
  const fs = { readFile, writeFile, mkdir, ...(opts.fs ?? {}) }
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {}
  const now = typeof opts.now === 'function' ? opts.now : () => new Date()
  const name = String(opts.name ?? RULINGS_SKILL_NAME)
  const out = { ok: false, wrote: false, reason: '', path: '', count: 0, backup: '' }

  try {
    // ★ 总开关（判据：off ⇒ 不写盘）。
    if (!surfaceAllowed(opts.swOf ?? null, RULINGS_SURFACE)) return { ...out, reason: 'SWITCH_OFF' }

    const root = String(opts.skillsRoot ?? '').trim()
    if (root.length === 0) return { ...out, reason: 'NO_SKILLS_ROOT' }
    const dir = join(root, name)
    const file = join(dir, 'SKILL.md')
    out.path = file

    let existing = null
    try {
      existing = await fs.readFile(file, 'utf8')
    } catch {
      existing = null // 不存在 ⇒ 这是第一次发布
    }

    let fromFile = []
    let tail = ''
    if (existing !== null) {
      const parsed = parseSkillFile(existing)
      // ★★ 硬要求②：同名已存在但**不是我们写的** ⇒ 停下报告，一个字节都不动。
      if (parsed.ours !== true) return { ...out, reason: 'FOREIGN_SKILL_EXISTS' }
      fromFile = parsed.rulings
      tail = parsed.tail
    }

    // ★ 硬要求①：合并是**集合语义**（按 id 去重）—— 重复运行不会重复追加。
    const byId = new Map()
    for (const r of [...fromFile, ...(Array.isArray(opts.rulings) ? opts.rulings : [])]) {
      if (r === null || typeof r !== 'object') continue
      const id = String(r.id ?? '')
      if (id.length === 0 || byId.has(id)) continue
      byId.set(id, { id, text: normalizeRulingText(r.text), at: String(r.at ?? ''), source: String(r.source ?? '') })
    }
    const merged = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    out.count = merged.length
    // ★ 硬要求④：一条都没有 ⇒ 不写空壳（连目录都不建）。
    if (merged.length === 0) return { ...out, ok: true, reason: 'NO_RULINGS' }

    const text = renderRulingsSkill(merged, { name, tail })
    // ★ 比较**受管部分**：区块外的手改不触发重建（那一段本来就原样保留，
    //   为它重写一次只会平白改 mtime —— 幂等就名存实亡了）。
    if (existing !== null && managedPartOf(existing) === managedPartOf(text)) {
      return { ...out, ok: true, reason: 'UNCHANGED' }
    }

    if (existing !== null && opts.backup !== false) {
      // ★ 硬要求③：写之前先备份（带时刻，便于回退）。
      const stamp = now().toISOString().replace(/[:.]/g, '-')
      const bak = `${file}.bak-${stamp}`
      await fs.writeFile(bak, existing, 'utf8')
      out.backup = bak
    }
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, text, 'utf8')
    return { ...out, ok: true, wrote: true, reason: existing === null ? 'CREATED' : 'UPDATED' }
  } catch (err) {
    // ★ 绝不抛：这是装配期的副作用，失败的后果只是"这次没发布"。
    try {
      warn(`[pipeline] 用户裁定库发布失败（不影响本插件其它功能）：${String(err?.message ?? err)}`)
    } catch {
      /* warn 坏了也不许抛 */
    }
    return { ...out, reason: `FAILED: ${String(err?.message ?? err)}` }
  }
}

/**
 * ★ 装配期入口：**读本项目记忆库 → 收集裁定 → 发布**。
 *
 * @param {object} opts
 * @param {string} opts.projectDir - 项目目录（读它的 `.pipeline/_memory/memory.jsonl`）
 * @param {string} [opts.skillsRoot] - 默认按 {@link defaultSkillsRoot}
 * @param {object[]} [opts.records] - 已读好的记忆（省一次读盘）
 * @returns {Promise<object>} 同 {@link publishRulings}
 */
export async function publishRulingsForProject(opts = {}) {
  const out = { ok: false, wrote: false, reason: '', path: '', count: 0, backup: '' }
  try {
    if (!surfaceAllowed(opts.swOf ?? null, RULINGS_SURFACE)) return { ...out, reason: 'SWITCH_OFF' }
    const projectDir = String(opts.projectDir ?? '').trim()
    const file = memoryFile(projectDir)
    const records = Array.isArray(opts.records) ? opts.records : file.length === 0 ? [] : (await readBank(file, { fs: opts.fs })).records
    const rulings = collectRulings(records)
    // ★ 硬要求④：没有用例 ⇒ **连 skills 根都不碰**。
    if (rulings.length === 0) return { ...out, ok: true, reason: 'NO_RULINGS' }
    const skillsRoot = String(opts.skillsRoot ?? '').trim() || defaultSkillsRoot(opts.env, opts.home)
    return await publishRulings({ ...opts, rulings, skillsRoot })
  } catch (err) {
    return { ...out, reason: `FAILED: ${String(err?.message ?? err)}` }
  }
}
