// 能力面对照 · `pl-main` 不低于 shipped 的 `preset-computer-use`：范本定位 + 逐字比对 + 差集判定。
/**
 * dsh-pipeline · 预设 · **能力面对照**（`pl-main` vs `preset-computer-use`）
 * ============================================================================
 * 要回答的问题只有一个，而且必须**可判定**：
 *
 *     「主对话的能力面，比 Computer Use 模式差吗？」
 *
 * 判据不是"看起来差不多"，是**集合差**：
 *
 *     CU 的 plugin 行名集合  ⊖  (pl-main 的底座行 ∪ 能力追加行 ∪ 显式排除项)
 *     非空 ⇒ 差在哪一行就报哪一行。
 *
 * 三个来源（**一个都不许手抄**）：
 *   · **范本**：`dsh-orb/cordis.patch.yml` 的 `preset-computer-use` 条目里的 `config.plugins`。
 *     ⚠ 该文件**不在本仓库**（它是 dsh-orb 这个插件包自带的 bundle patch），所以只能在本机
 *     profile 的 `node_modules/dsh-orb/` 下取。取到就**逐字比对**（id + name）；
 *     取不到就用 `capability.json` 的 `source.rows`（**冻结快照**）比对，并如实登记
 *     "未与现场范本比对" —— 拿不到范本**不等于**通过。
 *   · **底座行**：`render.js` 的 `BASE_PLUGIN_ROWS` + persona（16 个角色共用）。
 *   · **追加行 / 排除项**：`src/main/capability.json` 的 `capabilities[].rows` / `excluded[]`。
 *
 * ⚠ 排除项**必须逐条带 `why`**：没有理由的排除就是"悄悄少一个能力"，那是本模块要抓的东西。
 *
 * @module dsh-pipeline/presets/computer-use-parity
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 范本的 entry id（`dsh-orb` 的 bundle patch 里那一条）。 */
export const COMPUTER_USE_ENTRY_ID = 'computer-use'

/** 范本里 `- insert:` 那条预设行的 `id`（`preset-<presetId>`）。 */
export const COMPUTER_USE_ROW_ID = `preset-${COMPUTER_USE_ENTRY_ID}`

/** 用户原话点名的 5 项能力 —— **独立于 capability.json 的第二来源**，用来防止"自己漏了自己"。 */
export const REQUIRED_BY_USER = ['desktop-gui', 'web', 'ask-user', 'shell', 'fs-read']

/**
 * 找本机上 dsh-orb 的 bundle patch。**不猜路径**：找不到返回 `null`。
 * @param {{env?:object, home?:string, extra?:string[]}} [opts]
 * @returns {string|null}
 */
export function findOrbPatch(opts = {}) {
  const env = opts.env ?? process.env
  const home = typeof opts.home === 'string' ? opts.home : homedir()
  const cands = []
  if (typeof env.DSH_ORB_PATCH === 'string' && env.DSH_ORB_PATCH.length > 0) cands.push(env.DSH_ORB_PATCH)
  if (typeof env.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR.length > 0) {
    cands.push(join(env.DSH_PROFILE_DIR, 'node_modules', 'dsh-orb', 'cordis.patch.yml'))
  }
  const profiles = join(home, '.dsh', 'profiles')
  try {
    for (const p of readdirSync(profiles)) cands.push(join(profiles, p, 'node_modules', 'dsh-orb', 'cordis.patch.yml'))
  } catch {
    /* 没有 profiles 目录就不看它 */
  }
  cands.push(...(opts.extra ?? []))
  for (const c of cands) {
    try {
      if (existsSync(c)) return c
    } catch {
      /* 下一个 */
    }
  }
  return null
}

/**
 * 从一份 cordis patch YAML 里取出某个 `- insert:` 条目下 `config.plugins` 的
 * `{id, name}` 清单。
 *
 * 为什么自己写一个小扫描器而不是引 YAML 库：本插件是**零依赖**的（`CONVENTIONS.md` 的
 * 拆文件纪律 + `package.json` 没有 dependencies），而这里要读的是一份**格式固定**的
 * 生成物（缩进两格的 `- id:` + `name:`）。扫不出来就返回空数组 —— 调用方据此判"取不到"，
 * **不静默当成通过**。
 *
 * @param {string} text
 * @param {string} rowId `- id:` 那一行的值（如 `preset-computer-use`）
 * @returns {{id:string,name:string}[]}
 */
export function parsePresetPluginRows(text, rowId) {
  const lines = String(text ?? '').split('\n')
  const at = lines.findIndex((l) => new RegExp(`^\\s*-\\s*id:\\s*${rowId}\\s*$`).test(l))
  if (at < 0) return []
  const baseIndent = lines[at].search(/\S/)
  // 只在这条 entry 的缩进范围内找 `plugins:`。
  let pluginsAt = -1
  let pluginsIndent = 0
  for (let i = at + 1; i < lines.length; i += 1) {
    const raw = lines[i]
    if (raw.trim().length === 0) continue
    const ind = raw.search(/\S/)
    if (ind <= baseIndent) break // 下一条同级/更外层的 entry ⇒ 本 entry 结束
    if (/^\s*plugins:\s*$/.test(raw)) {
      pluginsAt = i
      pluginsIndent = ind
      break
    }
  }
  if (pluginsAt < 0) return []
  const rows = []
  let cur = null
  for (let i = pluginsAt + 1; i < lines.length; i += 1) {
    const raw = lines[i]
    if (raw.trim().length === 0) continue
    const ind = raw.search(/\S/)
    if (ind <= pluginsIndent) break // 回到 `plugins:` 同级 ⇒ 列表结束
    const idm = /^\s*-\s*id:\s*(\S+)\s*$/.exec(raw)
    if (idm !== null) {
      if (cur !== null) rows.push(cur)
      cur = { id: idm[1], name: '' }
      continue
    }
    const nm = /^\s*name:\s*'?([^'\s]+)'?\s*$/.exec(raw)
    if (nm !== null && cur !== null && cur.name === '') cur.name = nm[1]
  }
  if (cur !== null) rows.push(cur)
  return rows.filter((r) => r.name.length > 0)
}

/** 范本行的**规格化名字**（对照组只认 `id` + `name` 两张牌）。 */
const keyOf = (r) => `${r.id} | ${r.name}`

/**
 * 跑一遍对照。
 *
 * @param {object} opts
 * @param {object} opts.spec `src/main/capability.json` 的内容
 * @param {{id:string,name:string}[]} opts.baseRows `BASE_PLUGIN_ROWS` + persona
 * @param {string|null} [opts.orbPatch] 范本文件路径（`null` ⇒ 用冻结快照）
 * @returns {{available:boolean, source:string, errors:string[], notes:string[], counts:object}}
 */
export function parityReport(opts) {
  const spec = opts?.spec ?? {}
  const baseRows = Array.isArray(opts?.baseRows) ? opts.baseRows : []
  const errors = []
  const notes = []

  // ---- 范本：现场文件优先，退到 capability.json 的冻结快照 --------------------
  const vendored = Array.isArray(spec?.source?.rows) ? spec.source.rows : []
  let oracle = vendored
  let source = 'vendor-snapshot'
  let available = false
  const patch = opts?.orbPatch ?? null
  if (typeof patch === 'string' && patch.length > 0) {
    let parsed = []
    try {
      parsed = parsePresetPluginRows(readFileSync(patch, 'utf8'), COMPUTER_USE_ROW_ID)
    } catch (err) {
      errors.push(`⑨ 读范本失败：${patch} —— ${String(err?.message ?? err)}`)
    }
    if (parsed.length > 0) {
      available = true
      source = patch
      oracle = parsed
      // ★ 逐字比对：快照与现场范本必须同形（id + name）。漂了就说明范本变了。
      const a = vendored.map(keyOf).sort()
      const b = parsed.map(keyOf).sort()
      const onlyVendor = a.filter((x) => !b.includes(x))
      const onlyLive = b.filter((x) => !a.includes(x))
      if (onlyVendor.length > 0) errors.push(`⑨ 冻结快照里有、现场范本里没有的行：${onlyVendor.join('、')}（快照过期）`)
      if (onlyLive.length > 0) errors.push(`⑨ 现场范本里有、冻结快照里没有的行：${onlyLive.join('、')}（范本变了，同步 capability.json 的 source.rows）`)
    } else {
      notes.push(`⑨ 现场范本 ${patch} 里认不出 ${COMPUTER_USE_ROW_ID} 的 config.plugins ⇒ 退回冻结快照比对`)
    }
  } else {
    notes.push('⑨ 本机没有 dsh-orb 的 bundle patch ⇒ **未与现场范本比对**，本轮用 capability.json 的冻结快照（source.rows）')
  }
  if (oracle.length === 0) errors.push('⑨ 范本与冻结快照都取不到 CU 的 plugin 行 ⇒ 判不了（不当作通过）')

  // ---- 三份集合 --------------------------------------------------------------
  const baseKeys = new Set(baseRows.map(keyOf))
  const capRows = []
  const caps = Array.isArray(spec.capabilities) ? spec.capabilities : []
  for (const cap of caps) for (const row of Array.isArray(cap.rows) ? cap.rows : []) capRows.push(row)
  const flat = (rows) => {
    const out = []
    for (const r of rows) {
      out.push(r)
      if (Array.isArray(r.children)) out.push(...flat(r.children))
    }
    return out
  }
  const capKeys = new Set(flat(capRows).map(keyOf))
  const excluded = Array.isArray(spec.excluded) ? spec.excluded : []
  const exclKeys = new Set(excluded.map(keyOf))

  // ---- 差集：CU 有、pl-main 没有，且没被显式排除 ------------------------------
  const missing = oracle.filter((r) => {
    const k = keyOf(r)
    return !baseKeys.has(k) && !capKeys.has(k) && !exclKeys.has(k)
  })
  for (const m of missing) errors.push(`⑨ pl-main 比 Computer Use 少了这一行：${keyOf(m)}（补进 capabilities，或写进 excluded 并给出 why）`)
  for (const e of excluded) {
    if (typeof e.why !== 'string' || e.why.trim().length === 0) {
      errors.push(`⑨ excluded 里的 ${keyOf(e)} 没写 why —— 没有理由的排除就是"悄悄少一个能力"`)
    }
  }

  // ---- 用户点名的 5 项必须都在 capabilities 里（独立第二来源） ----------------
  const capKeysNamed = new Set(caps.map((c) => String(c.key ?? '')))
  const lack = REQUIRED_BY_USER.filter((k) => !capKeysNamed.has(k))
  if (lack.length > 0) errors.push(`⑨ capability.json 少了用户点名的能力项：${lack.join('、')}`)
  // 底座行已经覆盖的能力（shell / fs-read）允许 rows 为空 —— 但必须在 base 里真的有。
  const baseNames = new Set(baseRows.map((r) => r.name))
  for (const c of caps) {
    if (Array.isArray(c.rows) && c.rows.length > 0) continue
    const covered = (c.key === 'shell' && (baseNames.has('@deepseek-ai/dsh-tool-bash') || baseNames.has('@deepseek-ai/dsh-tool-pwsh'))) ||
      (c.key === 'fs-read' && baseNames.has('@deepseek-ai/dsh-tool-fs'))
    if (!covered) errors.push(`⑨ 能力项 ${c.key}（${c.zh ?? ''}）既没有追加行，底座行里也没有对应实现 ⇒ 这条是空的`)
  }

  if (errors.length === 0) {
    notes.push(`⑨ 能力面对照通过：CU ${oracle.length} 行 ⊖ (底座 ${baseKeys.size} + 追加 ${capKeys.size} + 排除 ${exclKeys.size}) = 0；用户点名的 ${REQUIRED_BY_USER.length} 项都在`)
  }
  return {
    available,
    source,
    errors,
    notes,
    counts: { oracle: oracle.length, base: baseKeys.size, capability: capKeys.size, excluded: exclKeys.size, missing: missing.length },
  }
}
