/**
 * dsh-pipeline · 角色预设校验器
 * ============================================================================
 *     node presets/validate.js
 *
 * 判据（每条都能红，且红得有具体落点）：
 *   ① **角色集合双向相等** —— `_index.json` 的 key 集合 ≡ `lib/roles.js` 的
 *      `ALL_ROLE_IDS`（**import** 它，不在这里另抄一份角色清单）。多一个 / 少一个都报。
 *   ② **每目录文件齐全** —— 16 个目录各有 meta/prompt/tools/permission；
 *      writer / reviewer / supervisor 三个**另需** prefix.md + suffix.md。
 *   ③ **id 合法且不撞车** —— `meta.id === 'pl-' + role`（前缀取自 `_index.json`）、
 *      16 个 `config.id` 互不重复、`config.id` 与行 id 都不落在 5 个 shipped id 上。
 *   ④ **显示名合法** —— `meta.name === displayNamePrefix + ROLES[role].zh`。
 *   ⑤ **权限档合法** —— 取值在四档之内，且与 `ROLES[role].write_class` 的映射一致。
 *   ⑥ **工具面是本插件的真工具** —— `tools.json.visible` 非空、无重复、
 *      每个名字都必须在 `lib/**` 里出现（扫源码得到全集，不手抄工具清单）。
 *   ⑦ **产物与源一致** —— `generated/*.patch.yml` 存在，且 `render.js --check` 说它没过期。
 *   ⑧ **每个 plugin 行的 config 通过该插件自己的 schema** —— 宿主安装（asar）里
 *      每个插件的 `lib/index.js` 都有 `Config = z.object({…})`；`.required()` 的键
 *      在这一行里**必须给值**。缺一个键，**整条预设挂不起来**（真机 2026-10-15：
 *      16 张卡片全标「加载失败」，原文是 `$.sampleOverCapGlobResults missing required
 *      value`）。判据本体在 `plugin-schema.js`；拿不到宿主安装时**如实判红**，
 *      不静默当成通过。
 *
 * 退出码：0 = 全绿；1 = 有 error。
 *
 * @module dsh-pipeline/presets/validate
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ALL_ROLE_IDS, ROLES } from '../lib/roles.js'
// ★ `write_class` 不是 `ROLES[role].writes`（主管的 writes=readonly 而 writeClassOf=none）
//   —— 所以档位映射必须读**守门自己**的那个函数，不许在这里二次推断。
import { writeClassOf } from '../lib/guard/rules.js'
import { BASE_PLUGIN_ROWS, CAPABILITY_FILE, PERSONA_MODULE, composePrefix, composeSuffix, readCapabilityRows, renderPatch } from './render.js'
import { findOrbPatch, parityReport } from './computer-use-parity.js'
import { checkPluginRows, findDshAsar, openAsar, readPluginSchemas } from './plugin-schema.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')

/** ★ 四个合法权限档（与 `_schema.md` §2 同一份取值域）。 */
export const LEGAL_PERMISSIONS = ['readonly', 'own-log', 'own-dir', 'workdir']

/** 必须先有 prefix.md + suffix.md 的三个角色（首尾提示词）。 */
export const ROLES_WITH_TAILS = ['writer', 'reviewer', 'supervisor']

/** 每个角色目录**必备**的文件。 */
export const REQUIRED_FILES = ['meta.json', 'prompt.md', 'tools.json', 'permission.json']

/**
 * `write_class`（守门判据）→ 预设权限档。
 * 这是**唯一的映射**，`render.js` 之外的任何地方都不许再写一份。
 */
export function permissionOfWriteClass(writeClass) {
  if (writeClass === 'readonly' || writeClass === 'none') return 'readonly'
  if (writeClass === 'own-log') return 'own-log'
  if (writeClass === 'own-dir') return 'own-dir'
  if (writeClass === 'workdir') return 'workdir'
  return null
}

/** 扫 `lib/**` 收集真工具名全集（含以常量形式导出的那两个，见 `PROJECT_INIT_TOOL_NAME`）。 */
export function scanToolNames(libDir = join(PKG, 'lib')) {
  const names = new Set()
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (e.endsWith('.js')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/['"](pipeline_[a-z0-9_]+)['"]/g)) names.add(m[1])
      }
    }
  }
  walk(libDir)
  return names
}

/**
 * 跑一遍校验。
 * @param {object} [opts]
 * @param {string} [opts.root] 预设根（默认本目录）。p11 会拿**临时副本**跑负例，
 *                             所以这里不许有任何写盘动作。
 * @param {string} [opts.libDir] 扫工具名的源码目录（默认本插件的 `lib/`）
 * @returns {{ok:boolean, errors:string[], notes:string[], counts:object}}
 */
export function validatePresets(opts = {}) {
  const root = opts.root ?? HERE
  const errors = []
  const notes = []
  const index = JSON.parse(readFileSync(join(root, '_index.json'), 'utf8'))
  const roles = Object.keys(index.presets)

  // ① 角色集合双向相等
  const want = [...ALL_ROLE_IDS].sort()
  const got = [...roles].sort()
  const missing = want.filter((r) => !got.includes(r))
  const extra = got.filter((r) => !want.includes(r))
  if (missing.length > 0) errors.push(`① _index.json 少了角色：${missing.join(', ')}`)
  if (extra.length > 0) errors.push(`① _index.json 多了角色：${extra.join(', ')}（lib/roles.js 的 ALL_ROLE_IDS 里没有）`)
  if (missing.length === 0 && extra.length === 0) notes.push(`① 角色集合双向相等：${got.length} 个（= ALL_ROLE_IDS）`)

  // 扫一次工具名全集（判据⑥）
  const knownTools = scanToolNames(opts.libDir ?? join(PKG, 'lib'))

  const seenIds = new Map()
  const seenOrders = new Map()
  let fileCount = 0
  /** 判据⑧的行清单：`{presetId, rowId, module, config}` —— 与产物里的行逐条同源。 */
  const pluginRows = []

  for (const role of roles) {
    const entry = index.presets[role]
    const dir = join(root, entry.dir)
    const where = `src/${role}`
    if (!existsSync(dir)) {
      errors.push(`② ${where}/ 不存在`)
      continue
    }
    // ② 文件齐全
    const need = [...REQUIRED_FILES]
    if (ROLES_WITH_TAILS.includes(role)) need.push('prefix.md', 'suffix.md')
    const have = readdirSync(dir)
    for (const f of need) {
      if (!have.includes(f)) errors.push(`② ${where}/${f} 缺失（该角色必备）`)
      else fileCount += 1
    }
    if (!have.includes('prefix.md') && ROLES_WITH_TAILS.includes(role)) {
      errors.push(`② ${where} 属于首尾提示词角色，却没有 prefix.md`)
    }
    if (!existsSync(join(dir, 'meta.json'))) continue

    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    const perm = JSON.parse(readFileSync(join(dir, 'permission.json'), 'utf8'))
    const tools = JSON.parse(readFileSync(join(dir, 'tools.json'), 'utf8'))
    const spec = ROLES[role]
    if (spec === undefined) continue // ① 已经报过了

    // ③ id
    const wantId = `${index.presetIdPrefix}${role}`
    if (meta.id !== wantId) errors.push(`③ ${where}/meta.json 的 id=${meta.id}，应为 ${wantId}`)
    if (seenIds.has(meta.id)) errors.push(`③ config.id 重复：${meta.id}（${seenIds.get(meta.id)} 与 ${where}）`)
    else seenIds.set(meta.id, where)
    if (index.reservedPresetIds.includes(meta.id)) {
      errors.push(`③ ${meta.id} 与既有 shipped preset id 撞车：${index.reservedPresetIds.join(' / ')}`)
    }
    if (!Number.isInteger(meta.order)) errors.push(`③ ${where}/meta.json 的 order 不是整数：${meta.order}`)
    else if (seenOrders.has(meta.order)) errors.push(`③ order 重复：${meta.order}（${seenOrders.get(meta.order)} 与 ${where}）`)
    else seenOrders.set(meta.order, where)

    // ④ 显示名
    const wantName = `${index.displayNamePrefix}${spec.zh}`
    if (meta.name !== wantName) errors.push(`④ ${where}/meta.json 的 name=${meta.name}，应为 ${wantName}`)
    if (typeof meta.description !== 'string' || meta.description.trim().length === 0) {
      errors.push(`④ ${where}/meta.json 的 description 为空`)
    }

    // ⑤ 权限档
    if (!LEGAL_PERMISSIONS.includes(perm.permission)) {
      errors.push(`⑤ ${where}/permission.json 的 permission=${perm.permission} 不在 ${LEGAL_PERMISSIONS.join(' / ')} 内`)
    }
    const cls = writeClassOf(role)
    const wantPerm = permissionOfWriteClass(cls)
    if (wantPerm === null) errors.push(`⑤ lib/guard/rules.js 的 writeClassOf('${role}')=${cls} 没有对应的权限档`)
    else if (perm.permission !== wantPerm) {
      errors.push(`⑤ ${where}/permission.json 的 permission=${perm.permission}，但 writeClassOf('${role}')=${cls} 应映射到 ${wantPerm}`)
    }

    // ⑥ 工具面
    const vis = tools.visible
    if (!Array.isArray(vis) || vis.length === 0) errors.push(`⑥ ${where}/tools.json 的 visible 为空`)
    else {
      const dup = vis.filter((n, i) => vis.indexOf(n) !== i)
      if (dup.length > 0) errors.push(`⑥ ${where}/tools.json 的 visible 有重复：${[...new Set(dup)].join(', ')}`)
      const unknown = vis.filter((n) => !knownTools.has(n))
      if (unknown.length > 0) errors.push(`⑥ ${where}/tools.json 出现本插件没有的工具名：${unknown.join(', ')}`)
      if (tools.visible_count !== vis.length) {
        errors.push(`⑥ ${where}/tools.json 的 visible_count=${tools.visible_count} 与实际 ${vis.length} 不符`)
      }
    }

    // ⑧ 收行：`persona`（提示词）+ 底座工具行 —— 与 `renderPreset` 的拼法逐条对齐。
    //    `persona` 的 config 用**真值**（真 compose，不是占位串），否则这条判据
    //    就变成"只查有没有 config 这个键"了。
    pluginRows.push({
      presetId: meta.id,
      rowId: 'persona',
      module: PERSONA_MODULE,
      config: { prefix: composePrefix(dir), suffix: composeSuffix(dir) },
    })
    for (const r of BASE_PLUGIN_ROWS) pluginRows.push({ presetId: meta.id, rowId: r.id, module: r.name, config: r.config })
    // ★★ 用户第 1 件：**能力追加行也要过同一道 schema 闸**。
    //    改前这一段只收 persona + 底座行 ⇒ `pl-main` 新挂的四行**根本没被校验过**
    //    （"声明了但没进校验" = 假绿）。含 group 行的**子行** —— 它们同样是真挂上去的插件。
    const flattenCap = (rows) => {
      const out = []
      for (const r of rows) {
        out.push(r)
        if (Array.isArray(r.children)) out.push(...flattenCap(r.children))
      }
      return out
    }
    for (const r of flattenCap(readCapabilityRows(dir))) {
      pluginRows.push({ presetId: meta.id, rowId: r.id, module: r.name, config: r.config })
    }
  }

  // ⑦ 产物与源一致（**在进程内**重渲染比对 —— 不起子进程：
  //    DSH 沙箱下 `child_process` 的管道 stdio 会 EPERM，那是环境边界不是缺陷）
  const outPath = join(root, index.generated)
  if (!existsSync(outPath)) errors.push(`⑦ 产物不存在：${index.generated}（跑 node presets/render.js）`)
  else {
    let fresh = null
    try {
      fresh = renderPatch(index, root)
    } catch (err) {
      errors.push(`⑦ 重渲染失败：${String(err?.message ?? err)}`)
    }
    if (fresh !== null) {
      const onDisk = readFileSync(outPath, 'utf8')
      if (onDisk === fresh) notes.push(`⑦ ${index.generated} 与 src/ 一致（${roles.length} 条）`)
      else {
        const at = [...onDisk].findIndex((c, i) => c !== fresh[i])
        errors.push(`⑦ ${index.generated} 已过期（第 ${at < 0 ? '（长度不同）' : at + 1} 字节起不同）—— 跑 node presets/render.js`)
      }
    }
  }

  // ⑧ 每个 plugin 行的 config 都要过**该插件自己的 schema**（真机缺陷的判据化）
  const gate = pluginRowGate(pluginRows)
  if (!gate.available) {
    // 拿不到宿主安装 ⇒ **如实判红**（没测 ≠ 通过），并写清怎么让它可测。
    errors.push(`⑧ 未校验：${gate.reason}（设 DSH_APP_ASAR=<安装>/resources/app.asar 后重跑）`)
  } else if (gate.problems.length > 0) {
    for (const p of gate.problems) errors.push(`⑧ ${p.detail}`)
  } else {
    // ★ **读不到 schema 的行如实登记，不当作通过**（"没测 ≠ 通过"）。
    //   本机读不到的两个模块见 `tests/p11-presets-check.mjs` 的 `UNVERIFIABLE_MODULES`：
    //   `dsh-orb/computer-use`（不在宿主 asar 里，是 dsh-orb 那个独立插件包的入口）
    //   与 `cordis:group`（loader 的分组指令，不是插件模块）。
    if (gate.unparsed.length > 0) {
      notes.push(`⑧ ⚠ ${gate.unparsed.length} 个行**未能校验**（该模块不在宿主安装里 / 不是插件模块）：${gate.unparsed.join('；')} —— **不当作通过**`)
    }
    notes.push(`⑧ ${gate.checked}/${pluginRows.length} 个 plugin 行的 config 通过了该插件自己的 schema（宿主 ${gate.asar}）`)
  }

  // ⑨ ★ 能力面对面：`pl-main` 不低于 shipped 的 `preset-computer-use`（用户原话第 1 件）。
  //    判据本体在 `computer-use-parity.js`（集合差，不是"看起来差不多"）。
  const capPath = join(root, index.presets.main?.dir ?? 'src/main', CAPABILITY_FILE)
  if (!existsSync(capPath)) {
    errors.push(`⑨ ${index.presets.main?.dir ?? 'src/main'}/${CAPABILITY_FILE} 不存在 —— 主对话的能力面就没有第二来源可判（用户点名要求它不低于 computer-use）`)
  } else {
    let spec = null
    try {
      spec = JSON.parse(readFileSync(capPath, 'utf8'))
    } catch (err) {
      errors.push(`⑨ ${CAPABILITY_FILE} 读不动：${String(err?.message ?? err)}`)
    }
    if (spec !== null) {
      const orbPatch = findOrbPatch()
      const rep = parityReport({
        spec,
        baseRows: [...BASE_PLUGIN_ROWS, { id: 'persona', name: PERSONA_MODULE }],
        orbPatch,
      })
      for (const e of rep.errors) errors.push(e)
      for (const n of rep.notes) notes.push(n)
      // 追加行必须真的出现在**渲染产物**里（否则"声明了但没渲染"就是假绿）。
      if (rep.errors.length === 0) {
        const want = readCapabilityRows(join(root, index.presets.main.dir))
        const out = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''
        const absent = want.filter((r) => !out.includes(`- id: ${r.id}`))
        if (absent.length > 0) errors.push(`⑨ 能力追加行没进产物：${absent.map((r) => r.id).join('、')}（跑 node presets/render.js）`)
        else notes.push(`⑨ 能力追加行 ${want.length} 条已进产物（${want.map((r) => r.id).join(' / ')}）；范本来源：${rep.source}`)
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    notes,
    counts: { roles: roles.length, files: fileCount, toolNames: knownTools.size, pluginRows: pluginRows.length },
  }
}

/** 宿主 schema 事实的**进程内缓存**（p11 会反复调 `validatePresets`，别每次重开 asar）。 */
let schemaCache = null

/**
 * 判据⑧的执行体：定位宿主安装 → 读每个插件自己发布的 `Config` 声明 → 逐行校验。
 * @param {{presetId:string,rowId:string,module:string,config:unknown}[]} rows
 * @returns {{available:boolean, reason:string, asar:string, problems:Array}}
 */
export function pluginRowGate(rows) {
  const asarPath = findDshAsar()
  if (asarPath === null) {
    return { available: false, reason: '找不到宿主安装的 app.asar —— 无法用插件自己的 schema 校验', asar: '', problems: [], checked: 0, unparsed: [] }
  }
  try {
    if (schemaCache === null || schemaCache.asar !== asarPath) {
      const asar = openAsar(asarPath)
      const modules = [...new Set(rows.map((r) => r.module))]
      schemaCache = { asar: asarPath, schemas: readPluginSchemas(asar, modules) }
      asar.close()
    }
    const { problems, checked, unparsed } = checkPluginRows(rows, schemaCache.schemas)
    return { available: true, reason: '', asar: asarPath, problems, checked, unparsed }
  } catch (err) {
    return { available: false, reason: `读宿主安装失败：${String(err?.message ?? err)}`, asar: asarPath, problems: [] }
  }
}

// ---------------------------------------------------------------- CLI
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(HERE, 'validate.js')
if (invokedDirectly) {
  const r = validatePresets()
  for (const n of r.notes) console.log(`  ✓ ${n}`)
  for (const e of r.errors) console.error(`  ✗ ${e}`)
  console.log(`[presets] 校验：${r.counts.roles} 个角色 / ${r.counts.files} 个源文件 / 工具名全集 ${r.counts.toolNames} / plugin 行 ${r.counts.pluginRows}`)
  console.log(r.ok ? '[presets] 全绿' : `[presets] ${r.errors.length} 个 error`)
  process.exit(r.ok ? 0 : 1)
}
