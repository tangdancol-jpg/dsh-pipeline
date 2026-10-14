/**
 * dsh-pipeline · 逐个工具的「输入 / 输出契约」实测
 * ============================================================================
 * 用**宿主自己的校验函数**（`@deepseek-ai/dsh-tools` 的
 * `assertSupportedJsonSchema` / `validateJsonSchemaValue`，就是
 * `dsh-tools/lib/index.js:3543` 那条 `tool "X" returned invalid output` 的同源实现）
 * 把本插件**每一个** `pipeline_*` 工具的**真实返回值**过一遍。
 *
 * 为什么需要它：工具声明的 `output` 是**全字段必填**（`lib/tools.js` 的
 * `objSchema` / `objSchemaStrict` 把所有顶层字段都标成 required），而
 * `run()` 的早退分支、`tool()` 包装层的开关拒答分支、异常分支都只返回
 * `{ ok, summary }` —— 只要有一条路径少字段，宿主就会把整次工具调用判成
 * `INVALID_TOOL_OUTPUT`。这类错**注册期看不出来**，只有真跑一次才知道。
 *
 * 跑法：`node tests/output-check.mjs`
 * 找宿主实现的顺序：
 *   ① 环境变量 `DSH_TOOLS_DIR`（指向含 `lib/index.js` 的包目录）
 *   ② 插件自己的 `node_modules/@deepseek-ai/dsh-tools`
 *   ③ 逐级向上找 `node_modules/@deepseek-ai/dsh-tools`
 * 找不到就**如实报"没测"并跳过**（不假装通过）。
 *
 * @module dsh-pipeline/tests/output-check
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 插件根目录（本文件在 <插件>/tests/ 下，或由 DSH_PIPELINE_DIR 指定）。 */
function pluginRoot() {
  if (process.env.DSH_PIPELINE_DIR) return resolve(process.env.DSH_PIPELINE_DIR)
  return resolve(HERE, '..')
}

/** 找宿主的 dsh-tools 实现；找不到返回 null。 */
async function loadHost() {
  const candidates = []
  if (process.env.DSH_TOOLS_DIR) {
    const base = resolve(process.env.DSH_TOOLS_DIR)
    candidates.push(join(base, 'lib', 'index.js'), join(base, 'index.js'))
  }
  let dir = pluginRoot()
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
    dir = dirname(dir)
  }
  const tried = []
  for (const c of candidates) {
    if (!existsSync(c)) {
      tried.push(`${c}（不存在）`)
      continue
    }
    try {
      const mod = await import(pathToFileURL(c).href)
      if (typeof mod.validateJsonSchemaValue === 'function' && typeof mod.assertSupportedJsonSchema === 'function' && typeof mod.defineTool === 'function') {
        return { mod, source: c, tried }
      }
      tried.push(`${c}（缺导出：需要 defineTool / assertSupportedJsonSchema / validateJsonSchemaValue）`)
    } catch (err) {
      tried.push(`${c}（import 失败：${String(err?.message ?? err).split('\n')[0]}）`)
    }
  }
  return { mod: null, source: '', tried }
}

/** 造一套最小但**真实**的 deps（store 落在临时目录，不碰用户的 .pipeline）。 */
async function makeDeps({ defineTool, degraded, root, sw, storeOverride }) {
  const { mergeConfig } = await import(pathToFileURL(join(pluginRoot(), 'lib', 'config.js')).href)
  const { createTaskStore } = await import(pathToFileURL(join(pluginRoot(), 'lib', 'store.js')).href)
  const { createTokenStore } = await import(pathToFileURL(join(pluginRoot(), 'lib', 'tokens.js')).href)
  const { createCallCounter } = await import(pathToFileURL(join(pluginRoot(), 'lib', 'context.js')).href)
  const config = mergeConfig({ projectRoot: root, artifactDirName: '.pipeline' })
  const store = storeOverride ?? createTaskStore({
    projectRoot: root,
    artifactDirName: '.pipeline',
    maxReworkPerLeg: config.maxReworkPerLeg,
    hashGateEscalateAfter: config.hashGateEscalateAfter,
    humanRequestTimeoutHours: config.humanRequestTimeoutHours,
    requireHumanConfirmCode: false,
    maxClarifyRounds: config.maxClarifyRounds,
  })
  return {
    defineTool,
    defineToolDegraded: degraded,
    ctx: { logger: { info() {}, warn() {}, debug() {} } },
    config,
    store,
    tokens: createTokenStore({ ttlMs: config.tokenTtlMs }),
    // 不真派子代理：transport 只是个"记录一下"的桩，永远不会真的起会话。
    transport: { kind: 'manual', spawn: () => ({ ok: false, error: '(tests/output-check: transport 是桩)' }) },
    indexTask: () => {},
    sw,
    counter: createCallCounter(),
    retireAgent: () => {},
  }
}

/** 一个"任何方法调用都炸"的 store —— 用来把每个工具逼进 `tool()` 的 catch 分支。 */
function throwingStore(root) {
  return new Proxy({ root, artifactDirName: '.pipeline' }, {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop in target) return target[prop]
      return () => {
        throw new Error('tests/output-check: 注入的 store 故障')
      }
    },
  })
}

/** 从（可能是 oneOf 的）节点上取一个合法的枚举/常量取值。 */
function pickOne(node) {
  if (node !== null && typeof node === 'object') {
    if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0]
    if (Object.hasOwn(node, 'const')) return node.const
    for (const branch of node.oneOf ?? []) {
      const v = pickOne(branch)
      if (v !== undefined) return v
    }
  }
  return undefined
}

/** 按工具的 parameters 声明**自动凑**一组入参（不猜、不硬编码工具名单）。 */
function synthArgs(def, ctx) {
  const props = def?.parameters?.properties ?? {}
  const args = {}
  for (const [key, node] of Object.entries(props)) {
    const type = node?.type ?? (node?.oneOf ?? []).map((b) => b.type).find((t) => t !== 'null')
    if (key === 'task_id') {
      if (ctx.taskId.length > 0) args[key] = ctx.taskId
      continue
    }
    if (key === 'role_token') {
      if (ctx.roleToken.length > 0) args[key] = ctx.roleToken
      continue
    }
    if (key === 'full' || key === 'include_audit' || key === 'toggle') {
      args[key] = true
      continue
    }
    const fixed = pickOne(node)
    if (fixed !== undefined) {
      args[key] = fixed
      continue
    }
    if (type === 'boolean') args[key] = false
    else if (type === 'array') args[key] = []
    else if (type === 'object') args[key] = {}
    else if (type === 'number' || type === 'integer') args[key] = 0
    else if (type === 'string') args[key] = ''
  }
  return args
}

/** 主流程。 */
export async function checkToolOutputs() {
  const host = await loadHost()
  if (host.mod === null) {
    return {
      checked: false,
      ok: true,
      total: 0,
      failures: [],
      text:
        '（跳过）找不到宿主的 @deepseek-ai/dsh-tools —— 本机没有可用的校验器，\n' +
        '所以**没有测**（这不是通过）。想真校验就把 DSH_TOOLS_DIR 指到那包目录（含 lib/index.js）。\n' +
        '试过的路径：\n' + host.tried.map((t) => `  ${t}`).join('\n'),
    }
  }
  const { defineTool, assertSupportedJsonSchema, validateJsonSchemaValue } = host.mod
  const { buildTools } = await import(pathToFileURL(join(pluginRoot(), 'lib', 'tools.js')).href)
  const { createSwitch } = await import(pathToFileURL(join(pluginRoot(), 'lib', 'switch.js')).href)

  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-outcheck-'))
  mkdirSync(root, { recursive: true })
  const failures = []
  const rows = []
  const notes = []

  const makeSw = (initial) => createSwitch({ stateFile: join(root, 'switch.json'), initial, log: () => {} })

  try {
    // ---- 先开一张真任务单：让 task_id / role_token 相关的分支走"任务存在"的那条路 ----
    const sw0 = makeSw(true)
    const deps0 = await makeDeps({ defineTool: (d) => d, degraded: true, root, sw: sw0 })
    const tools0 = buildTools(deps0)
    const byName = (tools, name) => Object.values(tools).find((d) => d.name === name)
    let taskId = ''
    let roleToken = ''
    try {
      const opened = await byName(tools0, 'pipeline_task_open').execute(
        { requirement: 'tests/output-check 的探针任务：只为把各工具真跑一遍（临时目录，跑完即删）。' },
        {},
      )
      if (typeof opened?.task_id === 'string') taskId = opened.task_id
      if (typeof opened?.role_token === 'string') roleToken = opened.role_token
    } catch (err) {
      notes.push(`建探针任务失败（会少覆盖一部分深分支）：${String(err?.message ?? err)}`)
    }
    if (taskId.length === 0) notes.push('探针任务没建起来 —— 深分支覆盖会打折，结论里已经标明。')

    const argsCtx = { taskId, roleToken, skip: new Set(['pipeline_task_open']) }

    // ---- 两种 schema 形态都要过：宿主当前是退化态（严格 JSON Schema），
    //      但 defineTool 一旦能解析就会走 spec DSL —— 两条路的契约必须一致。 ----
    const passes = [
      { id: 'degraded', desc: 'defineTool 退化（宿主当前实际形态）', degraded: true, defineTool: (d) => d },
      { id: 'spec', desc: 'defineTool 正常（spec DSL 归一化路径）', degraded: false, defineTool },
    ]

    // ---- 四种模式，覆盖每个工具**所有**可能的返回路径 ----
    const modes = [
      { id: 'empty', desc: '空入参（早退分支）', swOn: true, store: 'real', synth: false },
      { id: 'synth', desc: '按 parameters 声明的入参', swOn: true, store: 'real', synth: true },
      { id: 'sw-off', desc: '总开关关闭（mutating 工具拒答分支）', swOn: false, store: 'real', synth: true },
      { id: 'store-boom', desc: 'store 注入故障（包装层 catch 分支）', swOn: true, store: 'boom', synth: true },
    ]

    const seen = new Map()
    for (const pass of passes) {
      for (const mode of modes) {
        const tag = `${pass.id}/${mode.id}`
        const sw = makeSw(mode.swOn)
        const deps = await makeDeps({
          defineTool: pass.defineTool,
          degraded: pass.degraded,
          root,
          sw,
          storeOverride: mode.store === 'boom' ? throwingStore(root) : null,
        })
        let tools
        try {
          tools = buildTools(deps)
        } catch (err) {
          failures.push({ tool: '(buildTools)', mode: tag, violations: [`buildTools 抛了：${String(err?.message ?? err)}`] })
          continue
        }
        for (const [key, def] of Object.entries(tools)) {
          const args = mode.synth ? synthArgs(def, argsCtx) : {}
          let value
          try {
            value = await def.execute(args, {})
          } catch (err) {
            failures.push({ tool: def.name, mode: tag, violations: [`execute 抛了（不该：包装层应当吞掉）：${String(err?.message ?? err).split('\n')[0]}`] })
            continue
          }
          const violations = []
          try {
            assertSupportedJsonSchema(def.output.schema)
          } catch (err) {
            violations.push(`output.schema 本身不合法：${String(err?.message ?? err).split('\n').slice(0, 3).join(' / ')}`)
          }
          try {
            assertSupportedJsonSchema(def.parameters)
          } catch (err) {
            violations.push(`parameters 本身不合法：${String(err?.message ?? err).split('\n').slice(0, 3).join(' / ')}`)
          }
          const outViolations = validateJsonSchemaValue(def.output.schema, value, 'value')
          for (const v of outViolations) violations.push(v)
          if (!seen.has(def.name)) seen.set(def.name, { key, declared: Object.keys(def.output.schema?.properties ?? {}) })
          if (violations.length > 0) failures.push({ tool: def.name, mode: tag, args: JSON.stringify(args).slice(0, 120), violations })
          rows.push({ tool: def.name, mode: tag, ok: violations.length === 0, keys: Object.keys(value ?? {}).length })
        }
      }
    }

    const total = rows.length
    const failedRows = rows.filter((r) => r.ok !== true).length
    const byTool = [...seen.keys()].sort()
    const text =
      `校验器：${host.source}\n` +
      `工具数：${byTool.length}　探针任务：${taskId || '(没建起来)'}\n` +
      `用例数：${total}（${byTool.length} 工具 × ${modes.length} 模式 × ${passes.length} 种 schema 形态）　失败：${failedRows}\n` +
      `覆盖：` + passes.map((p) => `${p.id}=${p.desc}`).join('；') + '\n' +
      `模式：` + modes.map((m) => `${m.id}=${m.desc}`).join('；') + '\n' +
      (notes.length > 0 ? notes.map((n) => `注意：${n}`).join('\n') + '\n' : '') +
      '\n' +
      (failures.length === 0
        ? `全部 ${total} 个用例通过：每个工具的**真实返回值**都满足它自己声明的 output schema（两种 schema 形态、四条返回路径都过）。\n`
        : failures
          .map((f) => `✗ ${f.tool} [${f.mode}]${f.args ? ` args=${f.args}` : ''}\n    ${f.violations.join('\n    ')}`)
          .join('\n'))

    return { checked: true, ok: failures.length === 0, total, failed: failedRows, failures, source: host.source, text }
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  }
}

if (process.argv[1] !== undefined && /output-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await checkToolOutputs()
  console.log(r.text)
  process.exit(r.ok ? 0 : 1)
}
