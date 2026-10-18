/**
 * dsh-pipeline · 角色预设渲染器
 * ============================================================================
 *     node presets/render.js            # 写 generated/pipeline-presets.patch.yml
 *     node presets/render.js --check    # 只比对，不写；过期则 exit 1
 *
 * 输入（全部是**文件**，没有第二份内联清单）：
 *   · `_index.json`      —— 派生索引（role → preset id → 目录）+ 生成参数
 *   · `src/<role>/*`     —— meta.json / prompt.md / [prefix.md] / [suffix.md] /
 *                           tools.json / permission.json
 *
 * 输出：`generated/pipeline-presets.patch.yml`（**唯一被 DSH 读取的产物**）。
 *
 * 判据（为什么长这样而不是别的样子）见 `_schema.md` §2 / §4 / §6：
 *   · 预设声明行只有 id / name / config.{id,plugins,name,description,order}，
 *     多写的键会被**静默丢弃** ⇒ 权限档与工具面一律走**注释块**，不塞进 config。
 *   · 提示词走 `config.plugins` 里的一条 `@deepseek-ai/dsh-persona`（prefix / suffix）。
 *   · 行 `id` 与 `config.id` 都在 `_index.json` 里参数化，不在本文件里手抄。
 *
 * @module dsh-pipeline/presets/render
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** ★ 常量：DSH 认的模块名（多一个字符就整行不激活）。 */
export const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'
export const PERSONA_MODULE = '@deepseek-ai/dsh-persona'

/**
 * ★ 不再往 persona 里塞任何运行时**变量**模板（2026-10-18 真机缺陷的修复）。
 *
 * 旧版在每条预设的 suffix 末尾固定追加 `你的工作目录是 {{cwd}}。`，理由是"与 shipped
 * 预设同形"。但 DSH 0.2.1-rc.2 的 `deployment:persona-suffix` 段只注册了
 * `provider` / `model` 两个变量 —— `cwd` 不再是合法变量，用这些预设发起一轮会
 * 直接失败（`unknown prompt variable "{{cwd}}"`）。
 *
 * 现在 suffix 只拼 `src/<role>/suffix.md`（纯文本，无占位符）；工作目录由宿主的
 * 运行时上下文/系统提示提供，不需要预设层再重复一遍。
 */

/**
 * ★ 底座工具行 —— **16 个角色完全一致**。
 *
 * 为什么一致（判据，不是偷懒）：`pipeline_*` 的工具面由**守门**按已绑定角色逐会话
 * 收紧（`ctx.tools.restrict({ deny })`），预设层没有"只挂其中几个"的粒度。
 * 在这里按角色删行只会造出第二份更粗的名单，与守门**冲突或漂移**。
 * 详见 `_schema.md` §6。
 *
 * ⚠ **每行的 `config` 不是可选项，是宿主 schema 的硬要求**（2026-10-15 真机缺陷）：
 *   `tool-fs-search` 一行原来**没给 config**，宿主拿该插件自己的 schemastery schema
 *   校验 `{}` ⇒ `$.sampleOverCapGlobResults missing required value` ⇒ **16 条预设
 *   全部「加载失败」**（底座行 16 个角色一致，所以一起挂）。
 *   取值 `false` 逐字取自 shipped 预设（`dsh-web-app/presets/{standard,cordis}.patch.yml`）
 *   —— 本仓库**不自己发明 config**。
 *
 * 为什么是"补 config"而不是"删掉这一行"（逐角色都判过，结论一致）：
 *   · 行是**原子**的 —— `dsh-tool-fs-search` 同时提供 `glob` 与 `grep`。守门
 *     （`lib/guard/decide.js` §3b）按"返回值里有没有代码正文"画线：`grep` 拦、
 *     `glob` **不拦**，因为"只给路径不给正文的目录结构"正是控制角色（main /
 *     orchestrator / planner / supervisor）**该看**的东西 —— 计划位的 persona
 *     原文就把它列为出计划的三个依据之一。
 *   · 删行会连 `glob` 一起删掉 ⇒ 那不是"工具面更小"，是**拿掉设计明确要给的能力**。
 *     工具面的大小由守门逐会话裁，不由预设删行裁（`_schema.md` §6）。
 *   · 其余 5 行同理各有一条不可替代的能力：`agent-instructions` 让 AGENTS.md 进上下文；
 *     `tool-fs` 的 `read` 是控制角色读 `.pipeline/` 需求档与交接物的唯一入口；
 *     `tool-bash`/`tool-pwsh` 是编写/测试/性能位跑构建与测试的执行面（守门按内容拦，
 *     不按"有没有这个工具"拦）；`tool-jobs` 是后台任务面。
 */
export const BASE_PLUGIN_ROWS = [
  { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabledOnWin32: true },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabledOffWin32: true },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
  { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
]

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : null)

/**
 * ★★ **能力追加行的文件名**（放在 `src/<role>/` 下，可选）。
 *
 * 为什么要有它：`BASE_PLUGIN_ROWS` 是**16 个角色共用**的底座，而"主对话的能力面
 * 不低于 Computer Use 模式"是**主对话专属**的要求（`_schema.md` §9）。把追加行做成
 * 一个**按角色可选**的文件，是为了不把 15 个别的角色一起改宽 —— 那正是"顺手放宽"。
 *
 * 它的**范本**是 shipped 的 `preset-computer-use`（`dsh-orb/cordis.patch.yml`），
 * 逐字取 `id` / `name` / `config`，**本仓库不自己发明 config 键**。
 */
export const CAPABILITY_FILE = 'capability.json'

/** YAML 单引号标量（内容里的 `'` 翻倍）。选它是因为它**不解释**任何转义。 */
export function yamlScalar(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

/**
 * YAML 块标量（`|-`：保留内部换行、去掉末尾换行）。
 * 块标量的内容是**字面**的，所以提示词里的 `:` / `#` / 引号都不需要转义。
 */
export function yamlBlock(text, indent) {
  const pad = ' '.repeat(indent)
  const body = String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '')
  return body.split('\n').map((l) => (l.length === 0 ? '' : pad + l)).join('\n')
}

/** 组装 persona 的 prefix：`[prefix.md] + prompt.md`。 */
export function composePrefix(dir) {
  const out = []
  const pre = readText(join(dir, 'prefix.md'))
  if (pre !== null && pre.trim().length > 0) out.push(pre.trim())
  out.push(readText(join(dir, 'prompt.md')).trim())
  return out.join('\n\n')
}

/** 组装 persona 的 suffix：只拼 `src/<role>/suffix.md`（**不追加任何变量模板**，见上方注释）。 */
export function composeSuffix(dir) {
  const suf = readText(join(dir, 'suffix.md'))
  return suf !== null && suf.trim().length > 0 ? suf.trim() : ''
}

/** 把一串名字折成注释行（每行 ≤ 76 列）。 */
function wrapNames(names, firstPrefix, contPrefix) {
  const lines = []
  let cur = firstPrefix
  let started = false
  for (const n of names) {
    const piece = started ? `, ${n}` : n
    if (cur.length + piece.length > 76 && started) {
      lines.push(cur)
      cur = contPrefix + n
    } else {
      cur += piece
    }
    started = true
  }
  lines.push(cur)
  return lines
}

/**
 * 渲染一个角色预设。
 * @param {string} role 角色 id（来自 `_index.json` 的 key）
 * @param {object} entry `{ id, dir }`
 * @param {object} index `_index.json`
 * @param {string} [root] 预设根目录（默认本文件所在目录；p11 会拿临时副本跑）
 * @returns {string} 该预设的 YAML 片段（含上方注释块）
 */
export function renderPreset(role, entry, index, root = HERE) {
  const dir = join(root, entry.dir)
  const meta = readJson(join(dir, 'meta.json'))
  const perm = readJson(join(dir, 'permission.json'))
  const tools = readJson(join(dir, 'tools.json'))

  const L = []
  L.push('# ' + '─'.repeat(74))
  L.push(`# ${meta.id} · ${meta.name}`)
  L.push(`#   角色 role=${role} · 权限档 permission=${perm.permission} · write_class=${perm.write_class}`)
  L.push(`#   写入面：${perm.write_scope || '（无）'}`)
  L.push(`#   工具面：本角色可见的 pipeline_* 共 ${tools.visible_count} 个`)
  L.push(...wrapNames(tools.visible, '#     ', '#     '))
  L.push('#   ⚠ 工具面由守门按已绑定角色逐会话收紧（ctx.tools.restrict），')
  L.push('#     本注释块只是**声明面**，执法不在预设里 —— 见 _schema.md §6。')
  L.push('- insert:')
  L.push(`    - id: ${index.rowIdPrefix}${meta.id}`)
  L.push(`      name: '${PRESET_MODULE}'`)
  L.push('      config:')
  L.push(`        id: ${meta.id}`)
  L.push(`        name: ${yamlScalar(meta.name)}`)
  L.push(`        description: ${yamlScalar(meta.description)}`)
  L.push(`        order: ${meta.order}`)
  L.push('        plugins:')
  // ① persona —— 提示词的唯一落点（`suffix` 只有存在 suffix.md 的角色才写；空串会让宿主的
  //    模板渲染拿到一个没有内容的块，没必要。
  L.push('          - id: persona')
  L.push(`            name: '${PERSONA_MODULE}'`)
  L.push('            config:')
  L.push('              prefix: |-')
  L.push(yamlBlock(composePrefix(dir), 16))
  const suffixText = composeSuffix(dir)
  if (suffixText !== '') {
    L.push('              suffix: |-')
    L.push(yamlBlock(suffixText, 16))
  }
  // ② 底座工具行（角色无关）
  for (const row of BASE_PLUGIN_ROWS) {
    L.push(`          - id: ${row.id}`)
    L.push(`            name: '${row.name}'`)
    if (row.disabledOnWin32) L.push("            disabled: !!js process.platform === 'win32'")
    if (row.disabledOffWin32) L.push("            disabled: !!js process.platform !== 'win32'")
    if (row.config) {
      L.push('            config:')
      for (const [k, v] of Object.entries(row.config)) L.push(`              ${k}: ${v}`)
    }
  }
  // ③ ★★ **能力追加行**（`src/<role>/capability.json`；目前只有 main 有）——
  //    逐字取自 shipped 的 `preset-computer-use`，见 `_schema.md` §9。
  for (const row of readCapabilityRows(dir)) emitPluginRow(L, row, 10)
  return L.join('\n') + '\n'
}

/**
 * 把一个 plugin 行渲染成 YAML（**能力追加行专用**；底座行仍走原来的循环，逐字节不变）。
 *
 * 支持两种形状，两种都**逐字取自** shipped 的 `preset-computer-use`：
 *   · 普通行 `{id, name, config?}`；
 *   · `cordis:group` 行 `{id:'compaction', name:'cordis:group', group:true, isolate:{…},
 *     children:[…]}` —— 它的 `config` 是一个**子行数组**（shipped 就是这么写的）。
 *
 * @param {string[]} L 输出行缓冲
 * @param {object} row
 * @param {number} indent `- id:` 那一行的缩进
 */
function emitPluginRow(L, row, indent) {
  const pad = ' '.repeat(indent)
  L.push(`${pad}- id: ${row.id}`)
  L.push(`${pad}  name: '${row.name}'`)
  if (row.group === true) L.push(`${pad}  group: true`)
  if (row.isolate !== undefined && row.isolate !== null) {
    L.push(`${pad}  isolate:`)
    for (const [k, v] of Object.entries(row.isolate)) L.push(`${pad}    ${k}: ${v}`)
  }
  if (Array.isArray(row.children)) {
    L.push(`${pad}  config:`)
    for (const c of row.children) emitPluginRow(L, c, indent + 4)
  } else if (row.config !== undefined && row.config !== null) {
    L.push(`${pad}  config:`)
    for (const [k, v] of Object.entries(row.config)) L.push(`${pad}    ${k}: ${v}`)
  }
}

/**
 * 读一个角色的**能力追加行**（`src/<role>/capability.json`；没有 ⇒ 空数组）。
 *
 * 返回**扁平后的行清单**（`capabilities[].rows` 按声明顺序拼接）—— 调用方只关心
 * "这个角色额外挂哪些行"，不关心它们在 JSON 里怎么分组。
 * @param {string} dir 角色目录
 * @returns {object[]}
 */
export function readCapabilityRows(dir) {
  const p = join(dir, CAPABILITY_FILE)
  if (!existsSync(p)) return []
  const spec = readJson(p)
  const out = []
  for (const cap of Array.isArray(spec.capabilities) ? spec.capabilities : []) {
    for (const row of Array.isArray(cap.rows) ? cap.rows : []) out.push({ ...row, capability: cap.key })
  }
  return out
}

/** 渲染整份产物。`root` 缺省为本目录；p11 会拿临时副本跑负例。 */
export function renderPatch(index = readJson(join(HERE, '_index.json')), root = HERE) {
  const head = [
    '# ============================================================================',
    '# dsh-pipeline —— 16 个角色专属 Agent 预设（**生成物，不要手改**）',
    '# ============================================================================',
    `# 生成器：presets/render.js ← presets/src/**（源）+ presets/_index.json（索引）`,
    '# 结构说明：presets/_schema.md      校验：presets/validate.js / tests/p11-presets-check.mjs',
    '#',
    '# ⚠ 提示词走 config.plugins 里的一条 @deepseek-ai/dsh-persona（prefix / suffix）；',
    '#   工具面就是 config.plugins 列表本身；预设声明行**没有** permission / model /',
    '#   reasoning / systemPrompt 字段（多写的键会被静默丢弃）⇒ 权限档与声明面只出现在',
    '#   下面的注释块里。',
    '#',
    '# ⚠ 本文件在 **bundle 内**，改它需要重启 DSH 才生效。',
    '# ============================================================================',
    '',
  ]
  const roles = Object.keys(index.presets)
  return head.join('\n') + roles.map((r) => renderPreset(r, index.presets[r], index, root)).join('\n')
}

// ---------------------------------------------------------------- CLI
// 只在**直接运行**本文件时执行（被 import 时不产生副作用 —— p11 会 import 它）。
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(HERE, 'render.js')
if (invokedDirectly) {
  const index = readJson(join(HERE, '_index.json'))
  const text = renderPatch(index)
  const outPath = join(HERE, index.generated)
  const check = process.argv.includes('--check')
  if (check) {
    const old = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null
    if (old === text) {
      console.log(`[presets] generated 与 src/ 一致（${Object.keys(index.presets).length} 条）`)
    } else {
      console.error(`[presets] generated 已过期：${index.generated}\n  重跑：node presets/render.js`)
      process.exit(1)
    }
  } else {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, text, 'utf8')
    console.log(`[presets] 写出 ${index.generated}：${Object.keys(index.presets).length} 条预设、${text.length} 字节`)
  }
}
