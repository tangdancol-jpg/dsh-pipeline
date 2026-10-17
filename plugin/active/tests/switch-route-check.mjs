/**
 * dsh-pipeline · 开关路由的**可选注入**验证（离线最小宿主 + 真实 cordis）
 * ============================================================================
 * 盯的是这条：**有 webServer 时路由真的挂上去了吗？没有 webServer 时 apply 还跑得完吗？**
 *
 * 为什么要专门测：这个 bug 的形状很阴 —— 工具注册全对（说明 apply 跑过了），
 * 可 `/.dsh-pipeline/state` 就是 404。根因是"在 apply 里探测一次 ctx.get('webServer')"，
 * 而探测结果取决于**激活顺序**：本插件只 inject `tools`，tools 一就绪它就先激活；
 * webServer 是后一层插件提供的 —— 一前一后时那次探测必然拿到 undefined。
 *
 * 这个脚本用**真实的 @deepseek-ai/cordis** 起一个最小宿主：
 *   ① 假装提供 `tools` / `systemPrompt` 服务；
 *   ② 用**真实的 webServer stub**（形状照抄 dsh-host-webserver 的 register()）记录每一次注册；
 *   ③ 跑**真实的 `index.js` 的 apply**（用它自己 export 的 inject）；
 *   ④ 分别验三种排布：webServer 先 / webServer 后 / 完全没有 webServer。
 *
 * 跑法：`node tests/switch-route-check.mjs`
 * 找 cordis 的顺序：① 环境变量 `DSH_CORDIS_DIR`（指向含 lib/index.js 的包目录）
 *                  ② 插件自己的 node_modules ③ 逐级向上找。找不到就**如实报"没测"并跳过**。
 *
 * @module dsh-pipeline/tests/switch-route-check
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { EXPECTED_TOOL_COUNT } from './load-smoke.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function pluginRoot() {
  if (process.env.DSH_PIPELINE_DIR) return resolve(process.env.DSH_PIPELINE_DIR)
  return resolve(HERE, '..')
}

/** 找真实的 cordis；找不到返回 null。 */
async function loadCordis() {
  const candidates = []
  if (process.env.DSH_CORDIS_DIR) {
    const base = resolve(process.env.DSH_CORDIS_DIR)
    candidates.push(join(base, 'lib', 'index.js'), join(base, 'index.js'))
  }
  let dir = pluginRoot()
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'))
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
      if (typeof mod.Context === 'function') return { Context: mod.Context, source: c, tried }
      tried.push(`${c}（没有导出 Context）`)
    } catch (err) {
      tried.push(`${c}（import 失败：${String(err?.message ?? err).split('\n')[0]}）`)
    }
  }
  try {
    const mod = await import('@deepseek-ai/cordis')
    if (typeof mod.Context === 'function') return { Context: mod.Context, source: '@deepseek-ai/cordis', tried }
  } catch (err) {
    tried.push(`@deepseek-ai/cordis（包解析失败：${String(err?.message ?? err).split('\n')[0]}）`)
  }
  return { Context: null, source: '', tried }
}

/** webServer stub —— 形状照抄 `dsh-host-webserver/lib/index.js` 的 register()。 */
function makeWebServer(log) {
  const exact = new Map()
  const prefixes = new Map()
  return {
    port: 19387,
    host: '127.0.0.1',
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      log.push(`${route.kind} ${route.path}`)
      return () => table.delete(route.path)
    },
    unregister(path) {
      prefixes.delete(path)
      exact.delete(path)
    },
    get routes() {
      return [...prefixes.keys(), ...exact.keys()]
    },
  }
}

/**
 * 跑一次最小宿主。
 * @param {object} ctx0
 * @param {'web-first'|'web-last'|'no-web'} order
 */
async function scenario({ Context, apply, inject, order, root }) {
  const routeLog = []
  const toolLog = []
  const guardLog = []
  const warned = []
  const app = new Context()
  const webServer = makeWebServer(routeLog)

  app.plugin({
    name: 'host-tools',
    apply(ctx) {
      ctx.provide('tools', {
        register(def) {
          toolLog.push(def.name)
          return () => {}
        },
        guard(fn) {
          guardLog.push(fn)
          return () => {}
        },
      })
      ctx.provide('systemPrompt', { section() {} })
    },
  })

  const webPlugin = { name: 'host-webserver', apply(ctx) { ctx.provide('webServer', webServer) } }
  const pipelinePlugin = { name: 'dsh-pipeline', inject, apply }

  const config = {
    enabled: true,
    guardEnabled: true,
    intercept: false, // 拦截缝另有自测；这里不引入无关依赖
    projectRoot: root,
    switchStateFile: join(root, 'switch.json'),
    switchRoute: true,
  }

  let threw = null
  if (order === 'web-first') {
    await app.plugin(webPlugin)
    try {
      await app.plugin(pipelinePlugin, config)
    } catch (err) {
      threw = err
    }
  } else if (order === 'web-last') {
    try {
      await app.plugin(pipelinePlugin, config)
    } catch (err) {
      threw = err
    }
    await app.plugin(webPlugin)
  } else {
    try {
      await app.plugin(pipelinePlugin, config)
    } catch (err) {
      threw = err
    }
  }
  // 可选注入的回调至少晚一个微任务（cordis `fiber.ts:650`），等一拍再看结果。
  await new Promise((r) => setTimeout(r, 60))
  // 再等一拍：容器形态里 webServer 也可能是在 apply 之后才注册的
  await new Promise((r) => setTimeout(r, 60))

  return { threw, routeLog, toolLog, guardLog, warned, webServer }
}

export async function checkSwitchRoute() {
  const cordis = await loadCordis()
  if (cordis.Context === null) {
    return {
      checked: false,
      ok: true,
      total: 0,
      failures: [],
      text:
        '（跳过）找不到真实的 @deepseek-ai/cordis —— 本机没有可用的 cordis，\n' +
        '所以**没有测**（这不是通过）。想真校验就把 DSH_CORDIS_DIR 指到那包目录（含 lib/index.js）。\n' +
        '试过的路径：\n' + cordis.tried.map((t) => `  ${t}`).join('\n'),
    }
  }

  const mod = await import(pathToFileURL(join(pluginRoot(), 'index.js')).href)
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-switch-'))
  const failures = []
  const lines = []
  let expectedTools = null

  const F = (name, order, msg) => failures.push(`${name} [${order}] ${msg}`)

  try {
    for (const order of ['web-first', 'web-last', 'no-web']) {
      const r = await scenario({ Context: cordis.Context, apply: mod.apply, inject: mod.inject, order, root })
      const mounted = r.routeLog.filter((x) => x.includes('/.dsh-pipeline'))
      lines.push(
        `--- ${order} ---\n` +
          `  apply 抛了吗：${r.threw === null ? '没抛 ✓' : `抛了 ✗ ${String(r.threw?.message ?? r.threw)}`}\n` +
          `  注册的工具数：${r.toolLog.length}\n` +
          `  webServer.register 调用记录：${JSON.stringify(r.routeLog)}\n` +
          `  守门注册数：${r.guardLog.length}`,
      )
      if (r.threw !== null) F('apply', order, `不应抛异常：${String(r.threw?.message ?? r.threw)}`)
      if (r.toolLog.length !== EXPECTED_TOOL_COUNT) F('tools', order, `应当注册 ${EXPECTED_TOOL_COUNT} 个工具，实际 ${r.toolLog.length}`)
      if (expectedTools === null) expectedTools = [...r.toolLog].sort()
      else if (JSON.stringify([...r.toolLog].sort()) !== JSON.stringify(expectedTools)) {
        F('tools', order, '工具清单与其它排布不一致')
      }

      if (order === 'no-web') {
        if (mounted.length !== 0) F('route', order, `没有 webServer 却挂了路由：${JSON.stringify(mounted)}`)
        if (r.routeLog.length !== 0) F('route', order, `不该调用 register：${JSON.stringify(r.routeLog)}`)
      } else {
        if (mounted.length !== 1) F('route', order, `应当恰好挂 1 条 /.dsh-pipeline 路由，实际 ${mounted.length} 条：${JSON.stringify(r.routeLog)}`)
        if (!mounted.some((x) => x === 'prefix /.dsh-pipeline')) {
          F('route', order, `路由形状不对（期望 "prefix /.dsh-pipeline"）：${JSON.stringify(mounted)}`)
        }
      }
    }

    const text =
      `cordis：${cordis.source}\n` +
      `插件：${join(pluginRoot(), 'index.js')}\n\n` +
      lines.join('\n\n') +
      '\n\n' +
      (failures.length === 0
        ? '全部通过：webServer 先/后两种顺序都真的挂上了 /.dsh-pipeline（register 被调用到），\n' +
          `而**完全没有 webServer** 时 apply 不抛、${EXPECTED_TOOL_COUNT} 个工具照常注册、不碰 register。\n`
        : failures.map((f) => `✗ ${f}`).join('\n'))

    return { checked: true, ok: failures.length === 0, total: 3, failed: failures.length, failures, source: cordis.source, text }
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  }
}

if (process.argv[1] !== undefined && /switch-route-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await checkSwitchRoute()
  console.log(r.text)
  process.exit(r.ok ? 0 : 1)
}
