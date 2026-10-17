/**
 * dsh-pipeline · preset 里 **plugin 行的 config** · 宿主判据
 * ============================================================================
 * 现场（2026-10-15 真机）：重启 DSH 后「Agent 预设」设置页 16 张 `pl-*` 卡片
 * **全部**标红「加载失败」。悬停 `pl-main` 的原文：
 *
 *     tool-fs-search (@deepseek-ai/dsh-tool-fs-search): invalid config:
 *     - $.sampleOverCapGlobResults missing required value (at sampleOverCapGlobResults)
 *
 * 根因不是提示词、不是 id，而是**行给了、`config` 没给**：`render.js` 的底座工具行
 * 直接写 `- id: tool-fs-search / name: …`，宿主拿**该插件自己的** schemastery schema
 * 校验 `{}` ⇒ 缺必填键 ⇒ **整条预设挂不起来**。底座工具行 16 个角色一致，
 * 所以 16 张卡片一起红。
 *
 * 本模块把那件事变成**可执行**的判据：**用插件自己的 schema 校验它那份 config**。
 *
 * 三条纪律（为什么这么做，而不是别的做法）：
 *   ① **只读**：`readSync` / `readFileSync`，不写盘、不改任何东西；
 *   ② **不 import 宿主插件**：装载一个 dsh 插件要 cordis 与一串 peerDeps，而且会把
 *      插件**真的跑起来** —— 校验器不该有副作用。schema 是**声明**，从插件自己发布的
 *      `lib/index.js` 里读那段声明就够了（`Config = z.object({…})`）；
 *   ③ **判不了就说判不了**：读不到 schema / 找不到宿主安装 ⇒ 如实返回 `null` 或
 *      `undefined`，由调用方退回「与 shipped 预设逐字对齐」并**如实登记未校验** ——
 *      静默降级成「通过」是这里最坏的一种写法。
 *
 * ★ 判据的**权威范本**是 shipped 预设（`@deepseek-ai/dsh-web-app/presets/*.patch.yml`）：
 *   本模块只负责把它们的 plugin 行形状取出来（`shippedRowFacts`），怎么比由调用方定。
 *
 * @module dsh-pipeline/presets/plugin-schema
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------- ① 定位宿主安装

export const DEFAULT_ASAR_CANDIDATES = []

/**
 * ★★ **本机私有提示**（`presets/.local.json`，**已 gitignore**）。
 *
 * 为什么需要它（脱敏与可判定两条都要满足）：
 *   · 这个文件原来写死了作者机器上的安装路径（`D:\tool\...`）—— 那是**真实机器路径**，
 *     既泄露信息，对别的部署方又毫无意义；
 *   · 删掉它之后，**非标准安装位**的机器就枚举不到宿主安装 ⇒ `validate.js` 判据⑧
 *     会如实判红（"拿不到宿主安装 ⇒ 不当作通过"）—— 那是设计如此，但作者本机就成了红的。
 *   ⇒ 折中：**仓库里一个机器路径都不留**，把"本机在哪"放进一个**不入库**的
 *     `presets/.local.json`（键 `asar` / `dest`）。别的部署方要么用标准安装位
 *     （`LOCALAPPDATA/Programs/*` 那条通用推导本来就覆盖），要么自己写这份文件，
 *     要么直接设 `DSH_APP_ASAR`。
 *
 * @returns {{asar:string, dest:string}} 缺项一律空串（**不猜**）
 */
export function readLocalHints() {
  const out = { asar: '', dest: '' }
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), '.local.json')
    if (!existsSync(p)) return out
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (typeof j?.asar === 'string') out.asar = j.asar
    if (typeof j?.dest === 'string') out.dest = j.dest
  } catch {
    /* 读不动就当没有 —— 不许因为一份可选的本机提示把校验带崩 */
  }
  return out
}

/** shipped 预设的 asar 虚拟目录（**尾段**：asar 里真正的根可能是 `/dsh`，不写死）。 */
export const SHIPPED_PRESET_DIR_TAIL = '/node_modules/@deepseek-ai/dsh-web-app/presets'

/**
 * 找出宿主安装里的 `app.asar`。找不到返回 `null` —— **不猜路径**。
 * @param {{env?:object, resourcesPath?:string, execPath?:string, candidates?:string[]}} [opts]
 * @returns {string|null}
 */
export function findDshAsar(opts = {}) {
  const env = opts.env ?? process.env
  const cands = []
  if (typeof env.DSH_APP_ASAR === 'string' && env.DSH_APP_ASAR.length > 0) cands.push(env.DSH_APP_ASAR)
  const res = opts.resourcesPath ?? process.resourcesPath
  if (typeof res === 'string' && res.length > 0) cands.push(join(res, 'app.asar'))
  const exe = opts.execPath ?? process.execPath
  if (typeof exe === 'string' && exe.length > 0) cands.push(join(dirname(exe), 'resources', 'app.asar'))
  if (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.length > 0) {
    const programs = join(env.LOCALAPPDATA, 'Programs')
    try {
      for (const e of readdirSync(programs)) cands.push(join(programs, e, 'resources', 'app.asar'))
    } catch {
      /* 没有这个目录就不看它 */
    }
  }
  // ★ 本机私有提示（`presets/.local.json`，**不入库**）放在通用推导**之后**：
  //   它只补"这台机器把宿主装在了非标准位置"这一种情形，别的部署方根本不需要它。
  const localAsar = readLocalHints().asar
  if (localAsar.length > 0) cands.push(localAsar)
  cands.push(...(opts.candidates ?? DEFAULT_ASAR_CANDIDATES))
  for (const c of cands) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c
    } catch {
      /* 下一个 */
    }
  }
  return null
}

// ---------------------------------------------------------------- ② 只读打开 asar

/**
 * 只读打开 asar（Electron 的归档格式：8 字节 pickle + 头 JSON + 拼接的文件内容）。
 * 只读索引与**按需**读单个文件，不把 100+MB 整个读进内存。
 *
 * ⚠ 头 JSON 的**起点不写死在 4/8**（那两个 pickle 的长度字段里有对齐填充，
 *   靠猜偏移会切出半截 JSON —— 第一版就是这么错的）。这里按**内容定界**：
 *   取首 `{` 到末 `}`。判据是解析成功，不是偏移算对了。
 * @param {string} asarPath
 */
export function openAsar(asarPath) {
  const fd = openSync(asarPath, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(12)
  const hb = Buffer.alloc(headerSize)
  readSync(fd, hb, 0, headerSize, 16)
  const raw = hb.toString('utf8')
  const header = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
  const base = 16 + headerSize
  const unpackedRoot = `${asarPath}.unpacked`

  /** 展开成 `虚拟路径 → {offset,size,unpacked}`。 */
  const index = new Map()
  const walk = (node, prefix) => {
    for (const [name, v] of Object.entries(node.files ?? {})) {
      const p = `${prefix}/${name}`
      if (v.files !== undefined) walk(v, p)
      else index.set(p, v)
    }
  }
  walk(header, '')

  return {
    path: asarPath,
    /** 全部文件虚拟路径（`/` 分隔，以 `/` 开头）。 */
    list: () => [...index.keys()],
    /** 以 `suffix` 结尾的那些虚拟路径（**不猜根前缀** —— asar 里的根可能是 `/dsh`）。 */
    find: (suffix) => [...index.keys()].filter((p) => p.endsWith(suffix)),
    /** 读成 utf8 文本；不存在返回 `null`。 */
    readText: (vpath) => {
      const rec = index.get(vpath)
      if (rec === undefined) return null
      if (rec.unpacked === true) return readFileSync(join(unpackedRoot, vpath.split('/').join('\\')), 'utf8')
      const b = Buffer.alloc(rec.size)
      readSync(fd, b, 0, rec.size, base + Number(rec.offset))
      return b.toString('utf8')
    },
    close: () => closeSync(fd),
  }
}

/** shipped 预设的 patch 文件（`@deepseek-ai/dsh-web-app/presets/*.patch.yml`）—— 权威范本。 */
export function listShippedPresetFiles(asar) {
  return asar
    .list()
    .filter((p) => p.slice(0, p.lastIndexOf('/')).endsWith(SHIPPED_PRESET_DIR_TAIL) && p.endsWith('.patch.yml'))
    .sort()
}

// ---------------------------------------------------------------- ③ 读 schema 声明

/** 从 `{` 起把配平的那一段括号内容切出来（跳过字符串字面量）。 */
function sliceBraces(src, openAt) {
  let depth = 0
  let quote = ''
  for (let i = openAt; i < src.length; i += 1) {
    const c = src[i]
    if (quote !== '') {
      if (c === '\\') i += 1
      else if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(openAt + 1, i)
    }
  }
  return null
}

/** 按顶层逗号切分对象体（括号 / 字符串都不算分隔符）。 */
function splitTopLevel(body) {
  const out = []
  let depth = 0
  let quote = ''
  let cur = ''
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]
    if (quote !== '') {
      cur += c
      if (c === '\\') {
        cur += body[i + 1] ?? ''
        i += 1
      } else if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      cur += c
      continue
    }
    if ('{[('.includes(c)) depth += 1
    else if ('}])'.includes(c)) depth -= 1
    if (c === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim().length > 0) out.push(cur)
  return out
}

/** 值表达式的类型名（认不出返回 `null` —— 调用方跳过类型判据，不当成错）。 */
function schemaTypeOf(expr) {
  const m = /(?:^|\.)\s*(boolean|number|string|array|union|object|dict|tuple|const)\s*\(/.exec(expr.replace(/^z\./, ''))
  return m === null ? null : m[1]
}

/**
 * ★ **核心**：从插件自己的 `lib/index.js` 里读出它的 `Config = z.object({…})` 声明。
 *
 * 只认三件事：**必填**（`.required()`）、**有默认值**（`.default(…)`）、**类型**。
 * schemastery 的语义是「两者都没有 ⇒ 可选」，与本仓库 `_schema.md` §2 的说法一致。
 * @param {string} src
 * @returns {{key:string,required:boolean,hasDefault:boolean,type:(string|null)}[]|null}
 */
export function parsePluginConfigSchema(src) {
  if (typeof src !== 'string' || src.length === 0) return null
  const at = src.search(/(?:const|let|var)\s+Config\s*=\s*z\.object\s*\(\s*\{/)
  if (at < 0) return null
  const braceAt = src.indexOf('{', src.indexOf('z.object', at))
  if (braceAt < 0) return null
  const body = sliceBraces(src, braceAt)
  if (body === null) return null
  const fields = []
  for (const entry of splitTopLevel(body)) {
    const m = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+?)\s*$/.exec(entry)
    if (m === null) continue
    const expr = m[4]
    fields.push({
      key: m[1] ?? m[2] ?? m[3],
      required: /\.required\s*\(/.test(expr),
      hasDefault: /\.default\s*\(/.test(expr),
      type: schemaTypeOf(expr),
    })
  }
  return fields.length > 0 ? fields : null
}

/** 值是否符合该类型（类型未知 / 值为 undefined 时不判）。 */
function typeOk(type, value) {
  if (type === null || value === undefined) return true
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'number') return typeof value === 'number'
  if (type === 'string') return typeof value === 'string'
  if (type === 'array' || type === 'tuple') return Array.isArray(value)
  if (type === 'object' || type === 'dict') return value !== null && typeof value === 'object' && !Array.isArray(value)
  return true // union / const / 其它：不臆断
}

/** 包名 → asar 里 `lib/index.js` 的虚拟路径（asar 根前缀不写死，按尾段找）。 */
function entryOf(asar, moduleName) {
  const hit = asar.find(`/node_modules/${moduleName}/lib/index.js`)
  return hit.length > 0 ? hit[0] : null
}

/**
 * 读一个插件的 schema 事实。
 * @returns {{module:string, entry:(string|null), fields:(Array|null), reason:string}}
 */
export function readPluginSchema(asar, moduleName) {
  const entry = entryOf(asar, moduleName)
  if (entry === null) return { module: moduleName, entry: null, fields: null, reason: `宿主安装里没有 ${moduleName}/lib/index.js` }
  const fields = parsePluginConfigSchema(asar.readText(entry) ?? '')
  if (fields === null) return { module: moduleName, entry, fields: null, reason: `${entry} 里认不出 Config = z.object({…}) 声明` }
  return { module: moduleName, entry, fields, reason: '' }
}

/** 认识一批插件的 schema（同一份 asar 只开一次、每个模块只读一次）。 */
export function readPluginSchemas(asar, moduleNames) {
  const out = new Map()
  for (const n of moduleNames) out.set(n, readPluginSchema(asar, n))
  return out
}

// ---------------------------------------------------------------- ④ 校验 plugin 行

/**
 * ★ 断言「每个 plugin 行的 config 都通过该插件自己的 schema」。
 *
 * @param {{presetId:string, rowId:string, module:string, config:unknown}[]} rows
 * @param {Map<string,{fields:Array|null,reason:string}>} schemas
 * @returns {{problems:Array, checked:number, unparsed:Array}}
 */
export function checkPluginRows(rows, schemas) {
  const problems = []
  const unparsed = []
  let checked = 0
  for (const row of rows) {
    const s = schemas.get(row.module)
    const at = `${row.presetId} · ${row.rowId} (${row.module})`
    if (s === undefined || s.fields === null) {
      unparsed.push(`${at}：${s?.reason ?? '没有这个插件的 schema'}`)
      continue
    }
    checked += 1
    const cfg = row.config
    if (cfg !== undefined && cfg !== null && (typeof cfg !== 'object' || Array.isArray(cfg))) {
      problems.push({ ...row, kind: 'shape', key: '', detail: `${at}：config 不是对象（${JSON.stringify(cfg)}）` })
      continue
    }
    const have = cfg ?? {}
    for (const f of s.fields) {
      if (f.required && !(f.key in have)) {
        problems.push({ ...row, kind: 'missing', key: f.key, detail: `${at}：缺必填键 config.${f.key}（该插件 schema 里它是 .required()）` })
      } else if (f.key in have && !typeOk(f.type, have[f.key])) {
        problems.push({ ...row, kind: 'type', key: f.key, detail: `${at}：config.${f.key} 类型不符（期望 ${f.type}，实得 ${Array.isArray(have[f.key]) ? 'array' : typeof have[f.key]}）` })
      }
    }
  }
  return { problems, checked, unparsed }
}

// ---------------------------------------------------------------- ⑤ shipped 范本

/**
 * 从 shipped 预设里取出**同一插件行的 config 形状**（权威范本）。
 *
 * 为什么要它：schema 只能证明「不缺必填键」，证不了「没自己发明 config」。
 * shipped 预设是 DSH 自己发的，它怎么写就怎么跟 —— 这是本仓库 `_schema.md`
 * 与本次修复共同采信的范本口径。
 *
 * @param {ReturnType<openAsar>} asar
 * @param {string[]} yamlFiles 该目录下的文件名（由调用方列）
 * @param {(text:string)=>unknown} parse 调用方提供的 YAML 解析器（宿主运行时自带）
 * @returns {Map<string,{keys:string[], alwaysConfig:boolean, presets:string[]}>}
 */
export function shippedRowFacts(asar, yamlFiles, parse) {
  const facts = new Map()
  for (const f of yamlFiles) {
    const text = asar.readText(f)
    if (text === null) continue
    let parsed = null
    try {
      parsed = parse(text)
    } catch {
      continue
    }
    for (const entry of Array.isArray(parsed) ? parsed : []) {
      const cfg = entry?.insert?.[0]?.config ?? entry?.config
      for (const row of Array.isArray(cfg?.plugins) ? cfg.plugins : []) {
        if (typeof row?.name !== 'string') continue
        const cur = facts.get(row.name) ?? { keys: new Set(), withConfig: 0, total: 0, presets: [] }
        cur.total += 1
        const keys = row.config !== undefined && row.config !== null && typeof row.config === 'object' ? Object.keys(row.config) : []
        if (keys.length > 0) cur.withConfig += 1
        for (const k of keys) cur.keys.add(k)
        if (!cur.presets.includes(f)) cur.presets.push(f)
        facts.set(row.name, cur)
      }
    }
  }
  return new Map(
    [...facts].map(([name, v]) => [name, { keys: [...v.keys].sort(), alwaysConfig: v.total > 0 && v.withConfig === v.total, presets: v.presets }]),
  )
}

/**
 * ★ 官方**文档化但 shipped 范本没用到**的 config 键（按模块）。
 *
 * 为什么需要这张表：判据⑦原来把"shipped 预设没写过的键"一律当"自己发明 config"。
 * 但 DSH 0.2.1-rc.2 的 shipped 预设换成了「persona 只写 prefix（+可选 complete /
 * includeRuntimeContext）」，`suffix` 从范本里消失 —— 而它**仍是** `@deepseek-ai/dsh-persona`
 * 的合法配置字段（官方 README「Configuration」表：`suffix` 默认 `''`，含义是
 * `deployment:persona-suffix` 的模板）。本插件的角色预设正是用 `suffix` 装尾部提示
 * （prefix.md/suffix.md 成对），删掉会改变 persona 语义。
 *
 * 所以这里不是放宽判据，而是把判据改成"**文档化字段就不算发明**"：
 *   · 只收**有官方文档出处**的键（注释里写清出处）；
 *   · 没列出的键照旧判红 —— "自己发明 config"这条仍然会红。
 *
 * 新增条目的门槛：官方 README / Config schema 里能指到那一行。不要为了消红加。
 */
export const DOCUMENTED_EXTRA_CONFIG_KEYS = Object.freeze({
  // @deepseek-ai/dsh-persona 的 README「Configuration」表：prefix(required) / suffix('') /
  // complete(false) / includeRuntimeContext(true)。shipped 预设 0.2.1-rc.2 只写 prefix 等三项。
  '@deepseek-ai/dsh-persona': Object.freeze(['suffix']),
})

/** 与 shipped 范本比对（调用方只在拿得到 shipped 事实时用）。 */
export function checkAgainstShipped(rows, shipped) {
  const problems = []
  for (const row of rows) {
    const ref = shipped.get(row.module)
    if (ref === undefined) continue
    const keys = row.config !== undefined && row.config !== null && typeof row.config === 'object' ? Object.keys(row.config) : []
    if (ref.alwaysConfig && keys.length === 0) {
      problems.push({ ...row, kind: 'shipped-missing', key: '', detail: `${row.presetId} · ${row.module}：shipped 预设给了 config（${ref.keys.join(', ')}），本行没给 —— 以 shipped 为准` })
      continue
    }
    const documented = Array.isArray(DOCUMENTED_EXTRA_CONFIG_KEYS[row.module]) ? DOCUMENTED_EXTRA_CONFIG_KEYS[row.module] : []
    const invented = keys.filter((k) => !ref.keys.includes(k) && !documented.includes(k))
    if (invented.length > 0) {
      problems.push({ ...row, kind: 'shipped-invented', key: invented[0], detail: `${row.presetId} · ${row.module}：config.${invented.join(' / ')} 在 shipped 预设里没有（shipped 只写 ${ref.keys.join(', ') || '（无）'}）—— 不要自己发明 config` })
    }
  }
  return problems
}
