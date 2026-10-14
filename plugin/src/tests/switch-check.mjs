/**
 * dsh-pipeline · 功能开关自测（宿主侧）
 * ============================================================================
 *     node tests/switch-check.mjs
 *
 * 验四组东西：
 *   S. 开关本身 —— 默认值、翻转、落盘、重启后恢复、订阅
 *   G. 守门 —— **关掉之后守门必须完全弃权**（但只是弃权，不是"允许"）
 *   T. 工具 —— 关掉之后写操作被拒、只读操作照常
 *   R. 路由 —— 客户端 UI 走的那条 HTTP 通道（含各种错误分支与非环回拒绝）
 *
 * 全程零副作用：临时目录 + 假 req/res，不监听任何端口。
 *
 * @module dsh-pipeline/tests/switch-check
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { join } from 'node:path'

import { mergeConfig } from '../lib/config.js'
import { createGuardFor } from '../lib/guard-factory.js'
import { composeGuards, makeTaskIndexEntry } from '../lib/guard.js'
import { createTaskStore } from '../lib/store.js'
import { createSwitch, defaultSwitchStateFile } from '../lib/switch.js'
import { createSwitchHandler, isLoopback, mountSwitchRoute, STATE_PATH } from '../lib/switch-routes.js'
import { createTokenStore } from '../lib/tokens.js'
import { buildTools } from '../lib/tools.js'
import { SimulatedTransport } from '../lib/transport/index.js'

// ---------------------------------------------------------------------------
// 假 req / res
// ---------------------------------------------------------------------------

/** 造一个假请求。`body` 给字符串或对象（对象会被 JSON 序列化）。 */
function makeReq({ method = 'GET', url = STATE_PATH, body = null, remoteAddress = '127.0.0.1' } = {}) {
  const text = body === null ? null : typeof body === 'string' ? body : JSON.stringify(body)
  const base = Readable.from(text === null ? [] : [Buffer.from(text, 'utf8')])
  return Object.assign(base, {
    method,
    url,
    headers: {},
    socket: { remoteAddress },
    connection: { remoteAddress },
  })
}

/** 造一个假响应，把结果收集起来。 */
function makeRes() {
  const chunks = []
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      this.headersSent = true
    },
    end(buf) {
      if (buf !== undefined && buf !== null) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)))
      this.body = Buffer.concat(chunks).toString('utf8')
    },
    json() {
      return JSON.parse(this.body)
    },
  }
  return res
}

/** 调一次路由。 */
async function callRoute(handler, reqOpts) {
  const res = makeRes()
  await handler(makeReq(reqOpts), res)
  return res
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function runSwitchCheck() {
  const items = []
  const add = (name, pass, detail) => items.push({ name, pass: pass === true, detail: String(detail ?? '') })
  const projectRoot = await mkdtemp(join(tmpdir(), 'dsh-pipeline-switch-'))
  const stateFile = defaultSwitchStateFile(projectRoot)

  try {
    // =======================================================================
    // S. 开关本身
    // =======================================================================
    let sw = createSwitch({ stateFile, initial: true, log: () => {} })
    add('S1 首次启动（无状态文件）默认是开', sw.isOn() === true && sw.snapshot().restored === false, `isOn=${sw.isOn()} restored=${sw.snapshot().restored}`)

    const r1 = sw.set(false, { by: 'test', reason: '自测' })
    add('S2 翻转生效且 revision +1', r1.changed === true && sw.isOn() === false && r1.state.revision === 1, JSON.stringify(r1.state))
    add('S3 状态文件真的写出来了', existsSync(stateFile), `路径：${stateFile}`)
    const fileText = await readFile(stateFile, 'utf8')
    add('S4 状态文件是合法 JSON 且含 version/on', (() => { try { const j = JSON.parse(fileText); return j.version === 1 && j.on === false } catch { return false } })(), fileText.trim())

    const seen = []
    const off = sw.subscribe((s) => seen.push(s.on))
    sw.set(true, { by: 'test' })
    add('S5 订阅者收到变更通知', seen.length === 1 && seen[0] === true, `收到：${JSON.stringify(seen)}`)
    off()
    sw.set(false, { by: 'test' })
    add('S6 取消订阅后不再收到', seen.length === 1, `收到：${JSON.stringify(seen)}`)

    const same = sw.set(false, { by: 'test' })
    add('S7 设成同一个值不算变更（revision 不动）', same.changed === false, JSON.stringify(same.state))

    // 模拟重启：新建一个 switch 读同一个文件
    const sw2 = createSwitch({ stateFile, initial: true, log: () => {} })
    add('S8 重启后从状态文件恢复上次的选择（现在是关）', sw2.isOn() === false && sw2.snapshot().restored === true, `isOn=${sw2.isOn()} restored=${sw2.snapshot().restored}`)

    // 坏文件：不能静默当成"开"
    {
      const bad = join(projectRoot, 'bad.json')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(bad, '{ this is not json', 'utf8')
      const logs = []
      const swBad = createSwitch({ stateFile: bad, initial: false, log: (m) => logs.push(m) })
      add(
        'S9 状态文件损坏时回落到 initial，并把原因说出来（不静默）',
        swBad.isOn() === false && logs.some((l) => l.includes('读取失败')),
        `isOn=${swBad.isOn()}　日志：${JSON.stringify(logs)}`,
      )
    }

    // 落盘失败要说出来
    {
      const logs = []
      const swX = createSwitch({ stateFile: join(projectRoot, 'no-such-drive-\u0000', 'x.json'), initial: true, log: (m) => logs.push(m) })
      const rr = swX.set(false, { by: 'test' })
      add(
        'S10 落盘失败时内存态仍生效，且明确报告 persisted=false',
        swX.isOn() === false && rr.persisted === false && logs.some((l) => l.includes('落盘失败')),
        `isOn=${swX.isOn()} persisted=${rr.persisted}　日志：${JSON.stringify(logs)}`,
      )
    }

    sw = sw2

    // =======================================================================
    // G. 守门：关掉之后必须完全弃权
    // =======================================================================
    {
      const tokens = createTokenStore()
      const config = mergeConfig({})
      const taskIndex = new Map()
      taskIndex.set('T-1', makeTaskIndexEntry({ taskId: 'T-1', projectRoot, pipelineDir: join(projectRoot, '.pipeline') }))

      // 一个有身份的会话（否则守门本来就放行，测不出开关的作用）
      const tok = tokens.mint({ taskId: 'T-1', role: 'tester', agentId: 'a-tester' })
      void tok

      const guard = createGuardFor({ tokens, config, taskIndex, sw })
      const probe = { name: 'write', arguments: { path: join(projectRoot, 'src', 'x.js'), content: 'x' }, agent: { id: 'a-tester' } }

      sw.set(true, { by: 'test' })
      const whenOn = guard(probe)
      add('G1 开：测试改项目源码被守门拦下', typeof whenOn === 'string' && whenOn.includes('只能写**自己那一片**'), String(whenOn).split('\n').slice(0, 3).join(' / '))

      sw.set(false, { by: 'test' })
      const whenOff = guard(probe)
      add(
        'G2 关：同一次调用守门**完全弃权**（返回 undefined）',
        whenOff === undefined,
        `返回：${String(whenOff)}（undefined = 弃权；注意它不等于"允许"，别的守卫照样能拒）`,
      )

      // 关掉之后，别的守卫仍然能拒 —— 这是"弃权"与"允许"的区别
      const otherGuard = () => '[archigate] 别人的拒绝'
      const combined = composeGuards(guard, otherGuard)
      const combinedResult = combined(probe)
      add(
        'G3 关掉本守门后，其它插件的守卫**仍然能拒**（弃权 ≠ 允许）',
        typeof combinedResult === 'string' && combinedResult.includes('[archigate]'),
        `组合结果：${combinedResult}`,
      )

      sw.set(true, { by: 'test' })
      const resumed = guard(probe)
      add('G4 再打开：守门立刻恢复（不需要重启）', typeof resumed === 'string' && resumed.includes('只能写**自己那一片**'), String(resumed).split('\n')[0])
    }

    // =======================================================================
    // T. 工具：关掉之后写操作被拒、只读照常
    // =======================================================================
    {
      const tokens = createTokenStore()
      const config = mergeConfig({ transport: 'simulated', spawnRoles: true })
      const store = createTaskStore({ projectRoot, artifactDirName: config.artifactDirName, maxReworkPerLeg: 2 })
      const transport = new SimulatedTransport({ tokens })
      const taskIndex = new Map()
      const indexTask = (taskId, task) => {
        if (!task) return
        taskIndex.set(taskId, makeTaskIndexEntry({ taskId, projectRoot: task.project_root, pipelineDir: join(task.project_root, config.artifactDirName) }))
      }
      const tools = buildTools({
        defineTool: (d) => d,
        ctx: { logger: {} },
        config,
        store,
        tokens,
        transport,
        indexTask,
        sw,
      })
      const byName = new Map(Object.values(tools).map((t) => [t.name, t]))
      const call = (name, args, agentId) => byName.get(name).execute(args ?? {}, { name, arguments: args ?? {}, ...(agentId ? { agent: { id: agentId } } : {}) })

      add('T0 开关工具本身已注册（pipeline_switch）', byName.has('pipeline_switch'), `工具数=${byName.size}`)

      sw.set(false, { by: 'test' })
      const closed = await call('pipeline_task_open', { requirement: 'x' }, 'some-agent')
      add(
        'T1 关：pipeline_task_open（写）被拒，且说清怎么恢复',
        closed.ok !== true && closed.summary.includes('关闭') && closed.summary.includes('右上角'),
        String(closed.summary).split('\n').slice(0, 4).join(' / '),
      )
      const statusOff = await call('pipeline_status', {}, 'some-agent')
      add('T2 关：pipeline_status（只读）照常可用', statusOff.ok === true, String(statusOff.summary).split('\n')[0])

      const flipped = await call('pipeline_switch', { on: true, reason: '自测' })
      add(
        'T3 用工具把开关打开（这是没有 Web UI 时的入口）',
        flipped.ok === true && flipped.on === true && flipped.changed === true,
        String(flipped.summary).split('\n').slice(0, 4).join(' / '),
      )

      const opened = await call('pipeline_task_open', { requirement: '写一个函数 add(a,b) 返回两数之和。' }, 'main-agent')
      add('T4 开：写操作恢复正常', opened.ok === true && typeof opened.value?.task_id === 'string' || typeof opened.task_id === 'string', String(opened.summary).split('\n')[0])

      const offAgain = await call('pipeline_switch', {})
      add(
        'T5 不带参数 = 翻转（从开翻到关）',
        offAgain.ok === true && offAgain.on === false && offAgain.changed === true,
        String(offAgain.summary).split('\n')[0],
      )
      const selftest = await call('pipeline_selftest', { verbose: false })
      add(
        'T6 关：pipeline_selftest（只读、跑在临时目录）仍然可用',
        selftest.ok === true && String(selftest.summary).includes('总计'),
        String(selftest.summary).split('\n').slice(-3).join(' / '),
      )
      await sw.set(true, { by: 'test' })
    }

    // =======================================================================
    // R. 路由
    // =======================================================================
    {
      const swR = createSwitch({ stateFile: join(projectRoot, 'route-state.json'), initial: true, log: () => {} })
      const handler = createSwitchHandler({ sw: swR, version: '0.1.0-test', log: () => {} })

      const g1 = await callRoute(handler, { method: 'GET' })
      add('R1 GET 返回 200 与当前状态', g1.statusCode === 200 && g1.json().on === true, `status=${g1.statusCode} body=${g1.body}`)
      add('R2 响应带 no-store（开关状态不该被缓存）', String(g1.headers?.['cache-control'] ?? '').includes('no-store'), JSON.stringify(g1.headers))

      const p1 = await callRoute(handler, { method: 'POST', body: { on: false } })
      add('R3 POST {on:false} 把开关关掉', p1.statusCode === 200 && p1.json().on === false && p1.json().changed === true, p1.body)
      add('R4 关掉之后 GET 也反映出来（UI 轮询会看到）', (await callRoute(handler, { method: 'GET' })).json().on === false, '')

      const p2 = await callRoute(handler, { method: 'POST', body: {} })
      add('R5 POST {} = 翻转，回到开', p2.statusCode === 200 && p2.json().on === true, p2.body)

      const p3 = await callRoute(handler, { method: 'POST', body: null })
      add('R6 POST 空体也当翻转处理（不炸）', p3.statusCode === 200 && typeof p3.json().on === 'boolean', p3.body)

      const bad = await callRoute(handler, { method: 'POST', body: '{ 不是 json' })
      add('R7 非法 JSON → 400', bad.statusCode === 400, `status=${bad.statusCode} body=${bad.body}`)

      const notObj = await callRoute(handler, { method: 'POST', body: '"just a string"' })
      add('R8 JSON 不是对象 → 400', notObj.statusCode === 400, `status=${notObj.statusCode} body=${notObj.body}`)

      const big = await callRoute(handler, { method: 'POST', body: `{"on":true,"pad":"${'x'.repeat(5000)}"}` })
      add('R9 请求体超限 → 413', big.statusCode === 413, `status=${big.statusCode} body=${big.body}`)

      const remote = await callRoute(handler, { method: 'POST', body: { on: false }, remoteAddress: '192.168.1.50' })
      add('R10 非环回来源 → 403（开关是安全相关状态位，不该被局域网翻）', remote.statusCode === 403, `status=${remote.statusCode} body=${remote.body}`)

      const remote6 = await callRoute(handler, { method: 'GET', remoteAddress: '::ffff:127.0.0.1' })
      add('R11 IPv4-mapped IPv6 的环回地址被正确识别', remote6.statusCode === 200, `status=${remote6.statusCode}`)

      const unknown = await callRoute(handler, { method: 'GET', url: '/.dsh-pipeline/nope' })
      add('R12 未知路径 → 404', unknown.statusCode === 404, `status=${unknown.statusCode} body=${unknown.body}`)

      const put = await callRoute(handler, { method: 'PUT', body: {} })
      add('R13 不支持的方法 → 405', put.statusCode === 405, `status=${put.statusCode} body=${put.body}`)

      add('R14 isLoopback 判定表', [
        isLoopback('127.0.0.1') === true,
        isLoopback('::1') === true,
        isLoopback('::ffff:127.0.0.1') === true,
        isLoopback('10.0.0.1') === false,
        isLoopback('') === false,
        isLoopback(undefined) === false,
      ].every(Boolean), '逐项已验')
    }

    // --- 挂载：没有 webServer 时应当安静降级，而不是抛 ---------------------
    {
      const calls = []
      const fakeCtx = {
        get(name) {
          calls.push(name)
          return undefined // 拿不到 webServer
        },
      }
      let mounted = null
      let threw = null
      try {
        mounted = mountSwitchRoute(fakeCtx, { sw, version: '0.1.0-test' })
      } catch (err) {
        threw = String(err?.message ?? err)
      }
      add(
        'R15 拿不到 ctx.webServer 时返回 null（安静降级，不抛）—— headless 下插件照常激活',
        threw === null && mounted === null,
        `threw=${threw} mounted=${mounted}　探测的服务名：${JSON.stringify(calls)}`,
      )
    }
    {
      const registered = []
      const fakeCtx = {
        get: () => ({
          register(route) {
            registered.push(route)
            return () => {}
          },
        }),
      }
      const mounted = mountSwitchRoute(fakeCtx, { sw, version: '0.1.0-test' })
      add(
        'R16 有 webServer 时按 kind:"prefix" + path:"/.dsh-pipeline" 注册',
        mounted !== null && registered.length === 1 && registered[0].kind === 'prefix' && registered[0].path === '/.dsh-pipeline' && typeof registered[0].handler === 'function',
        `注册：${JSON.stringify(registered.map((r) => ({ kind: r.kind, path: r.path })))}`,
      )
      add('R17 返回 dispose 供插件卸载时摘掉路由', typeof mounted.dispose === 'function', `typeof dispose = ${typeof mounted.dispose}`)
    }

    const lines = []
    lines.push('='.repeat(78))
    lines.push('dsh-pipeline 功能开关自测（开关 / 守门弃权 / 工具拒绝 / HTTP 路由）')
    lines.push('='.repeat(78))
    for (const it of items) {
      lines.push('')
      lines.push(`${it.pass ? '✓' : '✗'} ${it.name}`)
      for (const l of String(it.detail).split('\n')) lines.push(`    ${l}`)
    }
    const passed = items.filter((i) => i.pass).length
    lines.push('')
    lines.push('='.repeat(78))
    lines.push(`总计：${passed}/${items.length} 通过`)
    lines.push('='.repeat(78))

    return { passed, total: items.length, text: lines.join('\n'), items }
  } finally {
    try {
      await rm(projectRoot, { recursive: true, force: true })
    } catch {
      /* 清不掉不影响结论 */
    }
  }
}

if (process.argv[1] !== undefined && /switch-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runSwitchCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
