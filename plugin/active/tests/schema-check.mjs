/**
 * dsh-pipeline · 工具定义的真编译器校验
 * ============================================================================
 * 「插件能被 cordis 装载、工具能注册进去」这件事不该靠"我看起来很对"。
 * `defineTool` 对 schema 有一串硬约束（写错就当场抛），本脚本用**真编译器**
 * 把本插件的全部工具定义过一遍。
 *
 * 编译器从哪来：把 `app.asar` 里的 `@deepseek-ai/dsh-tools/lib/types/schema.js`
 * 原样拷到工作区根的 `node_modules/` 下（连同它唯一的外部依赖
 * `@deepseek-ai/dsh-llm` 的一个最小替身）。于是自测校验的是**真实的 DSL 实现**，
 * 而不是我按文档复刻的一份（复刻件会漂移，而且漂移了还是绿的）。
 *
 * 校验的约束（读源码得到，见 README「侦察结论」）：
 *   · `output` 必填，且 `output.render` 必须是函数 —— `defineTool` 无条件读它
 *   · `output.schema` 的对象根必须显式写 `additionalProperties: false`
 *   · `parameters` 必须是「属性名 → 值 schema」的映射，不能写成 `{type:'object'}`
 *   · `required` 只能写在**属性**上、且值必须是 `true`
 *
 * 拷不到编译器时（比如插件被单独拷走），本脚本会**跳过并明确说明**，不会假装通过。
 *
 * @module dsh-pipeline/tests/schema-check
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 最近一次 `loadRealDefineTool()` 尝试过的路径与失败原因。
 *
 * ★ 必须是**模块级**：`checkToolSchemas()` 在"拷不到编译器"那条路上要把它
 *   原样报给调用方（那是"没测"而非"通过"的证据）。放在 `loadRealDefineTool()`
 *   函数体里的话，那边读到的是未声明标识符 —— 直接 ReferenceError 崩掉，
 *   于是这个 schema 闸门**从来没真正跑过**。
 */
const loadErrors = []

/** 试着把真 `defineTool` 找出来。找不到就返回 null（调用方据此跳过）。 */
export async function loadRealDefineTool() {
  loadErrors.length = 0
  const candidates = []
  // ① 工作区根下的 vendored 拷贝（本机自测就有）
  let dir = HERE
  for (let i = 0; i < 5; i++) {
    candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'types', 'schema.js'))
    dir = dirname(dir)
  }
  // ② 直接 import 包名（如果将来 dsh-tools 变成可解析依赖）
  for (const c of candidates) {
    if (!existsSync(c)) continue
    try {
      const mod = await import(pathToFileURL(c).href)
      if (typeof mod.defineTool === 'function') {
        return { defineTool: mod.defineTool, source: c }
      }
      loadErrors.push(`${c}: 模块里没有导出 defineTool`)
    } catch (err) {
      // ⚠️ 这里的 catch 很容易把"没测"伪装成"通过"。所以错误一定要带出去。
      loadErrors.push(`${c}: ${String(err?.message ?? err).split('\n')[0]}`)
    }
  }
  try {
    const req = createRequire(import.meta.url)
    const p = req.resolve('@deepseek-ai/dsh-tools/lib/types/schema.js')
    const mod = await import(pathToFileURL(p).href)
    if (typeof mod.defineTool === 'function') return { defineTool: mod.defineTool, source: p }
  } catch (err) {
    loadErrors.push(`包解析: ${String(err?.message ?? err).split('\n')[0]}`)
  }
  return null
}

/**
 * 用真 `defineTool` 跑一遍全部工具定义。
 *
 * @returns {{checked:boolean, ok:boolean, total:number, failures:Array<{name:string,error:string}>, source:string, text:string}}
 */
export async function checkToolSchemas() {
  const real = await loadRealDefineTool()
  if (real === null) {
    const detail =
      loadErrors.length > 0 ? `尝试过的路径与失败原因：\n${loadErrors.map((e) => `    ${e}`).join('\n')}\n` : ''
    return {
      checked: false,
      ok: true,
      total: 0,
      failures: [],
      source: '',
      loadErrors,
      text:
        '（跳过）找不到 @deepseek-ai/dsh-tools 的 schema 编译器 —— 本机没有 vendored 拷贝。\n' +
        detail +
        '  这不是通过，是**没测**。要真校验请把\n' +
        '  dsh-tools/lib/types/schema.js 与 json-schema.js 放到 <工作区根>/node_modules/@deepseek-ai/dsh-tools/lib/types/ 下。',
    }
  }

  const { buildTools } = await import('../lib/tools.js')
  const { mergeConfig } = await import('../lib/config.js')
  const { createTokenStore } = await import('../lib/tokens.js')

  // 只借用 buildTools 的"定义形状"：给它一套最小的假依赖，注册表不会真的跑。
  const tools = buildTools({
    defineTool: real.defineTool,
    ctx: { logger: { info() {}, warn() {}, debug() {} } },
    config: mergeConfig({}),
    store: {},
    tokens: createTokenStore(),
    transport: {},
    indexTask: () => {},
  })

  const failures = []
  const names = []
  for (const def of Object.values(tools)) {
    names.push(def.name)
    // defineTool 在**构造时**就会编译 schema —— 能走到这里说明已经过了一遍。
    // 这里再显式复查几条硬约束，把"为什么过/为什么不过"说清楚。
    try {
      if (typeof def.output?.render !== 'function') throw new Error('output.render 不是函数')
      if (def.output?.schema?.type !== 'object') throw new Error('output.schema 根不是 object')
      if (def.output?.schema?.additionalProperties !== false) throw new Error('output.schema 根缺 additionalProperties:false')
      if (def.parameters?.type !== 'object' || typeof def.parameters?.properties !== 'object') {
        throw new Error('parameters 没有被编译成 {type:"object", properties:{...}}')
      }
      if (def.parameters.additionalProperties === false) throw new Error('parameters 根不该有 additionalProperties:false（宿主不自带，多余的键本就不会被拒）')
      if (typeof def.execute !== 'function') throw new Error('execute 不是函数')
      if (typeof def.name !== 'string' || def.name.length === 0) throw new Error('name 为空')
      if (typeof def.description !== 'string' || def.description.length < 20) throw new Error('description 太短（模型看不到有用的说明）')
    } catch (err) {
      failures.push({ name: def.name ?? '(无名)', error: String(err?.message ?? err) })
    }
  }

  const text =
    `编译器：${real.source}\n` +
    `工具数：${names.length}\n` +
    names.map((n) => `  · ${n}`).join('\n') +
    '\n' +
    (failures.length === 0 ? `全部 ${names.length} 个定义通过真编译器的 schema 编译与硬约束复查。` : failures.map((f) => `✗ ${f.name}：${f.error}`).join('\n'))

  return { checked: true, ok: failures.length === 0, total: names.length, failures, source: real.source, text }
}

// 直接跑：`node tests/schema-check.mjs`
if (process.argv[1] !== undefined && /schema-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await checkToolSchemas()
  console.log(r.text)
  process.exit(r.ok ? 0 : 1)
}
