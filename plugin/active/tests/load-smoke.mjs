/**
 * dsh-pipeline · 装载冒烟测试
 * ============================================================================
 * 「插件能被 cordis 装载」是交付物里的一句硬承诺，本脚本把它变成可执行的断言：
 *
 *   · `apply(ctx, config)` 在一个**假 ctx** 上真的跑起来了；
 *   · 全部 `pipeline_*` 工具注册进了 `ctx.tools.register`，且注册用的是 `ctx.effect`
 *     （宿主里取消注册的唯一正确姿势 —— `register` 返回精确 disposer）；
 *   · 守门注册进了 `ctx.tools.guard`，且**真的会拒**一条越权调用；
 *   · `enabled:false` 时什么也不注册；`guardEnabled:false` 时只注册工具不注册守门；
 *   · system prompt 段注册失败不会拖垮工具与守门（宿主上 systemPrompt 段名冲突
 *     是会抛的，所以这条容错是必需的）。
 *
 * 假 ctx 只实现本插件真正用到的那几个成员：tools.register / tools.guard /
 * effect / logger / systemPrompt.section。**宿主里的一切实现在 app.asar 里**，
 * 这里不重复实现它 —— 只验证"本插件用对了接口形状"。
 *
 * @module dsh-pipeline/tests/load-smoke
 */

import { createHarness } from './selftest-core.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 造一个只实现本插件所需成员的假 Cordis 上下文。 */
export function createFakeCtx(opts = {}) {
  const registered = []
  const guards = []
  const effects = []
  const sections = []
  const logs = []
  const disposers = []
  const routes = []
  /** ★ 拦截缝：event → 中间件数组（见下面 ctx.on 的实现） */
  const interceptors = new Map()

  /** 假的 webServer（只实现 register；开关的 HTTP 端点靠它挂载）。 */
  const webServer = {
    register(route) {
      routes.push(route)
      const dispose = () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
      disposers.push(dispose)
      return dispose
    },
  }

  const ctx = {
    logger: {
      info: (m) => logs.push(['info', String(m)]),
      warn: (m) => logs.push(['warn', String(m)]),
      debug: (m) => logs.push(['debug', String(m)]),
    },
    /** 宿主里 `ctx.effect(fn, label)` 会立刻执行 fn 并把返回的 disposer 挂到宿主生命周期上。 */
    effect(fn, label) {
      const d = fn()
      effects.push(label)
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    /**
     * 宿主里服务的读取方式。本插件刻意**不把 webServer 写进 inject**
     * （headless 形态下没有 webServer，写进 inject 整个插件就不激活了），
     * 所以这里是运行期探测 —— 假 ctx 也照这个形状来。
     */
    get(name) {
      return name === 'webServer' && opts.noWebServer !== true ? webServer : undefined
    },
    tools: {
      register(def) {
        registered.push(def)
        const dispose = () => {
          const i = registered.indexOf(def)
          if (i >= 0) registered.splice(i, 1)
        }
        disposers.push(dispose)
        return dispose
      },
      guard(fn) {
        guards.push(fn)
        const dispose = () => {
          const i = guards.indexOf(fn)
          if (i >= 0) guards.splice(i, 1)
        }
        disposers.push(dispose)
        return dispose
      },
    },
    systemPrompt: opts.systemPromptThrows === true
      ? {
          section() {
            throw new Error('prompt section "pipeline:roles" is already registered in this layer')
          },
        }
      : {
          section(s) {
            sections.push(s)
            return () => {}
          },
        },
    /**
     * ★ 宿主的**拦截扩展点**（`ctx.on`）。
     *
     * 用户要求：拦截必须做进插件自己，而且**真的挂得上**。
     * 这里用假 ctx 收下 `ctx.on(event, fn)`，于是"插件到底挂了几条缝、挂在哪几个事件上"
     * 是**可以断言**的 —— 而不是只能靠读代码相信它。
     */
    on(event, fn) {
      if (!interceptors.has(event)) interceptors.set(event, [])
      interceptors.get(event).push(fn)
      return () => {
        const arr = interceptors.get(event) ?? []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      }
    },
  }

  return {
    ctx,
    registered,
    guards,
    effects,
    sections,
    logs,
    disposers,
    routes,
    /** 拦截缝：event → 中间件数组 */
    interceptors,
    /** 复刻宿主的守门语义：取第一个非 undefined 即拒绝。 */
    runGuard(exec) {
      for (const g of guards) {
        const reason = g(exec)
        if (reason !== undefined) return reason
      }
      return undefined
    },
  }
}

/**
 * 跑装载冒烟测试。
 *
 * @returns {Promise<{passed:number,total:number,text:string,items:object[]}>}
 */
/**
 * ★ 工具总数（T-20261011-56a37e 起从 30 → 31）。
 *
 * 为什么改这一条：本单按用户要求新增了一个**具名动作工具** `pipeline_supervise`
 *   （主管枢纽的发起 / 两步唤醒 / 站点确认 / 重画 / 升级人工）。
 *   安全预审阻断项 B2 明确**不许**靠放宽 main 的 `pipeline_dispatch` 名单来实现，
 *   所以只能是「多一个工具」，工具总数这条断言必然跟着变。
 *
 * 改前判定：`f.registered.length === 30`；改后判定：`=== EXPECTED_TOOL_COUNT`（= 31）。
 * **判定的方向一个字没放宽** —— 仍然是「注册数必须精确等于这个数」：
 *   少注册一个（能力悄悄消失）或多注册一个（悄悄多一条能力）都照样红。
 *
 * ---------------------------------------------------------------------------
 * ★ 2026-10-15 由 31 改为 **32**（真机端到端缺陷 ⑦）
 * ---------------------------------------------------------------------------
 * 缺陷 ⑦「没有任何'删除任务'的工具」的修法就是**多一个具名工具**
 * `pipeline_task_purge`（归主对话、只认终态单、先留痕后动手、默认进回收站）。
 * 与上面 `pipeline_supervise` 那次是同一个形状：**能力只能靠"多一条具名通道"加，
 * 不靠放宽既有工具的名单** —— 所以工具总数这条断言必然跟着 +1。
 *
 * ★ 方向仍然一个字没放宽：精确相等。少一个（能力消失）或多一个（悄悄多一条能力）都红。
 *
 * ---------------------------------------------------------------------------
 * ★ 2026-10-16 由 32 改为 **34**（P1–P5 接线，`WIRING.md` §W5）
 * ---------------------------------------------------------------------------
 * 本批次（P1–P5）新写了两个工具面，但当时带"既有文件一个都不许改"的约束，
 * **一行都没注册**（`defineTool` 只在 `buildTools` 里被调用 —— 没被调用就等于不存在）。
 * 解除约束这一次把两个都接上，所以工具总数 **+2**：
 *   · `pipeline_project_init`（P1：项目目录与仓库，`lib/tools/project.js`）
 *   · `pipeline_demo`        （P4：DEMO 阶段，`lib/tools/demo.js`）
 * 仍然是"能力只能靠多一条具名通道加"那个形状 —— 没有放宽任何既有工具的名单。
 *
 * ★ 方向仍然一个字没放宽：精确相等。
 *
 * ---------------------------------------------------------------------------
 * ★ 2026-10-16 由 34 → 35 → **36**（同一天两次 +1，形状完全相同）：
 *   · 35 = 记忆域 E0 的 `pipeline_recall`（只读切片）；
 *   · 36 = 用户第 1 件的 `pipeline_capability_request`（能力申请通道）。
 *   两次都是「能力只能靠多一条具名通道加，不放宽既有工具的名单」—— 判定方向一个字没放宽：精确相等。 */
export const EXPECTED_TOOL_COUNT = 36

export async function runLoadSmoke() {
  const items = []
  const add = (name, pass, detail) => items.push({ name, pass: pass === true, detail: String(detail ?? '') })
  const lines = []

  const mod = await import('../index.js')
  add('index.js 导出 name / inject / apply', mod.name === 'dsh-pipeline' && Array.isArray(mod.inject) && typeof mod.apply === 'function',
    `name=${mod.name}  inject=${JSON.stringify(mod.inject)}  apply=${typeof mod.apply}`)
  // ★★ 2026-10-15（缺陷 B）由"只有一个 tools"改为**精确等于新集合**。
  //    为什么加 `sessionProjections`：水位（`contextPressure`）与逐轮大纲（`turnOutline`）
  //    只能从会话投影里读；不声明它 ⇒ 直接取属性就是
  //    `cannot get property "sessionProjections" without inject`，E5 的水位下调**一次都没生效过**。
  //    ★ 方向**一个字没放宽**：仍然是精确相等（长度 + 顺序 + 每一项），
  //      不是"包含" —— 它继续当"装配面被改动"的哨兵。
  //    ★ 单一出处是 `lib/host-surface.js` 的 `PLUGIN_INJECT`（index.js 只 re-export）。
  add('inject 精确等于 [tools, sessionProjections]（装配面被改动 ⇒ 这条必红）', mod.inject.length === 2 && mod.inject[0] === 'tools' && mod.inject[1] === 'sessionProjections', `inject=${JSON.stringify(mod.inject)}`)

  // --- 正常装载 -----------------------------------------------------------
  {
    const f = createFakeCtx()
    mod.apply(f.ctx, {})
    const names = f.registered.map((d) => d.name).sort()
    add('apply() 不抛，且注册了 ${EXPECTED_TOOL_COUNT} 个 pipeline_* 工具', f.registered.length === EXPECTED_TOOL_COUNT && names.every((n) => n.startsWith('pipeline_')),
      `注册数=${f.registered.length}\n${names.join('\n')}`)
    add('每个注册都走 ctx.effect（宿主里取消注册的唯一正确姿势）', f.effects.length >= 23,
      `effect 调用：${f.effects.length} 次\n${f.effects.join(' | ')}`)
    add('每个工具定义都有 output.schema + output.render（宿主 defineTool 的硬要求）',
      f.registered.every((d) => d.output !== undefined && typeof d.output.render === 'function' && typeof d.execute === 'function'),
      f.registered.filter((d) => d.output === undefined || typeof d.output.render !== 'function').map((d) => d.name).join(', ') || '全部合规')
    add('守门注册了正好 1 个（不注册 post-execute，少一条会被带坏的链路）', f.guards.length === 1, `guards=${f.guards.length}`)
    add('system prompt 段注册了 1 段', f.sections.length === 1 && f.sections[0].name === 'pipeline:roles',
      `sections=${JSON.stringify(f.sections.map((s) => ({ name: s.name, order: s.order })))}`)
    add('prompt 段的 order 是有限数字（宿主里非有限数会直接抛）', Number.isFinite(f.sections[0]?.order),
      `order=${f.sections[0]?.order}`)
    add('装载时打了日志（便于排查"到底装上没有"）', f.logs.some(([lvl, m]) => lvl === 'info' && m.includes('dsh-pipeline')),
      f.logs.map(([l, m]) => `${l}: ${m}`).join('\n'))

    // --- 守门真的会拒 -----------------------------------------------------
    const denied = f.runGuard({ name: 'pipeline_close', arguments: { task_id: 'T-x' }, agent: { id: 'someone' } })
    add('守门对无身份调用确实返回拒绝字符串', typeof denied === 'string' && denied.includes('[pipeline]'), `守门返回：\n${denied}`)
    const passed = f.runGuard({ name: 'read', arguments: { path: 'C:/unrelated/x.md' }, agent: { id: 'someone' } })
    add('守门对无关调用返回 undefined（宿主里 undefined 才是放行）', passed === undefined, `返回：${String(passed)}`)

    // --- ★ 拦截缝：真的挂上了吗 ------------------------------------------
    //   用户要求：拦截必须做进插件自己，而且**真的挂得上**（不是写在文档里）。
    //   这里断言"挂了几条缝、挂在哪几个事件上"。
    const seamEvents = [...f.interceptors.keys()].sort()
    add(
      '★ 拦截缝挂上了（tools/pre-execute · agent/pre-step · tools/post-execute）',
      seamEvents.length === 3 &&
        seamEvents.includes('tools/pre-execute') &&
        seamEvents.includes('agent/pre-step') &&
        seamEvents.includes('tools/post-execute'),
      `已挂事件：${seamEvents.join(' / ') || '（一条都没挂）'}`,
    )
    add(
      '★ 中间件条数：pre-execute 1 条 · pre-step **2 条**（简报 + 记忆注入）· post-execute **3 条**（唤醒 + 记忆 retain + 代码拦截）',
      (f.interceptors.get('tools/pre-execute') ?? []).length === 1 &&
        (f.interceptors.get('agent/pre-step') ?? []).length === 2 &&
        (f.interceptors.get('tools/post-execute') ?? []).length === 3,
      [...f.interceptors.entries()].map(([e, a]) => `${e}: ${a.length}`).join(' · ') +
        '\n    ★ 判定方向**一个字没放宽**，仍然是"精确相等"：少一条（能力悄悄消失）或多一条（悄悄多一面）都红。' +
        '\n      本轮 +2 条是**记忆域 E1**（用户裁定 2 解除了"既有文件零修改"约束）：' +
        '\n      · `memory-inject`（agent/pre-step）：每席位一次注入最近记忆（可被总开关摘掉）；' +
        '\n      · `memory-retain`（tools/post-execute，排在 ③ 与 ④ 之间）：把 `pipeline_*` 的结果记进记忆库。' +
        '\n      仍然复用**既有三个事件名**（`seamEvents.length === 3` 那条断言没变）。' +
        '\n      ★ post-execute 三条的顺序是**有意**的：唤醒（③）→ **记忆记原始结果** → 结果网（④）；' +
        '\n        记忆排在结果网之前，才不会记下"被本插件自己换成 feedback 的结果"（设计 04 §1 的裁决）。',
    )
    // ★ 作用域：非管线会话必须直通（这条不成立就是事故）
    {
      const fn = (f.interceptors.get('tools/pre-execute') ?? [])[0]
      const out = await fn({ name: 'pwsh', arguments: { command: 'npm test' }, agent: { id: 'unrelated-session' } }, async () => ({ kind: 'enter' }))
      add(
        '★★ 作用域：非管线会话 ⇒ 直通放行（别的项目/别的会话不被这套边界管）',
        out?.kind === 'enter',
        `返回：${JSON.stringify(out)}`,
      )
    }

    // --- 取消注册 ---------------------------------------------------------
    for (const d of f.disposers.slice()) d()
    add('全部 disposer 调完之后注册表清空（HMR / 卸载路径可用）', f.registered.length === 0 && f.guards.length === 0,
      `剩余 tools=${f.registered.length} guards=${f.guards.length}`)
  }

  // --- enabled:false ------------------------------------------------------
  {
    const f = createFakeCtx()
    mod.apply(f.ctx, { enabled: false })
    add('enabled:false → 什么也不注册（工具 0 / 守门 0 / prompt 0）',
      f.registered.length === 0 && f.guards.length === 0 && f.sections.length === 0,
      `tools=${f.registered.length} guards=${f.guards.length} sections=${f.sections.length}`)
  }

  // --- guardEnabled:false -------------------------------------------------
  {
    const f = createFakeCtx()
    mod.apply(f.ctx, { guardEnabled: false })
    add('guardEnabled:false → 工具照注册、守门不注册（**明确降级**，不是静默失败）',
      f.registered.length === EXPECTED_TOOL_COUNT && f.guards.length === 0,
      `tools=${f.registered.length} guards=${f.guards.length}`)
    add('guardEnabled:false 时日志里明确写了"没有硬拦截"',
      f.logs.some(([, m]) => m.includes('没有硬拦截') || m.includes('guardEnabled=false')),
      f.logs.map(([l, m]) => `${l}: ${m}`).join('\n'))
  }

  // --- systemPrompt 抛异常不该拖垮工具与守门 -------------------------------
  {
    const f = createFakeCtx({ systemPromptThrows: true })
    let threw = null
    try {
      mod.apply(f.ctx, {})
    } catch (err) {
      threw = String(err?.message ?? err)
    }
    add('systemPrompt 段注册失败不会拖垮插件（工具与守门照常）',
      threw === null && f.registered.length === EXPECTED_TOOL_COUNT && f.guards.length === 1,
      `threw=${threw}  tools=${f.registered.length}  guards=${f.guards.length}\n` +
        f.logs.filter(([l]) => l === 'warn').map(([l, m]) => `${l}: ${m}`).join('\n'))
  }

  // --- 与真实 store 打通一次（不是纯形状检查）-----------------------------
  {
    const mod2 = await import('../index.js')
    const h = await createHarness()
    const f = createFakeCtx()
    // 用自测台的 projectRoot 装一遍：确认 apply 会真的建出 .pipeline 根。
    mod2.apply(f.ctx, { projectRoot: h.projectRoot, transport: 'manual', spawnRoles: false })
    add('apply 在真实目录上跑通（manual 通道、不建会话）',
      f.registered.length === EXPECTED_TOOL_COUNT && f.guards.length === 1,
      `tools=${f.registered.length} guards=${f.guards.length}\n` + f.logs.map(([l, m]) => `${l}: ${m}`).join('\n'))
    const { rm } = await import('node:fs/promises')
    await rm(h.projectRoot, { recursive: true, force: true })
  }

  // --- UI 开关：路由挂载 / 降级 --------------------------------------------
  {
    const f = createFakeCtx() // 有 webServer
    mod.apply(f.ctx, { switchStateFile: join(tmpdir(), `dsh-pipeline-smoke-${Date.now()}.json`) })
    add(
      '有 webServer 时挂载开关端点 /.dsh-pipeline（kind=prefix）—— 右上角按钮靠它读写宿主开关',
      f.routes.length === 1 && f.routes[0].kind === 'prefix' && f.routes[0].path === '/.dsh-pipeline' && typeof f.routes[0].handler === 'function',
      `路由：${JSON.stringify(f.routes.map((r) => ({ kind: r.kind, path: r.path })))}`,
    )
    add(
      '装载日志里报了开关端点已挂载',
      f.logs.some(([, m]) => m.includes('开关 UI 端点已挂载')),
      f.logs.filter(([l]) => l !== 'debug').map(([l, m]) => `${l}: ${m}`).join('\n'),
    )
  }
  {
    const f = createFakeCtx({ noWebServer: true })
    let threw = null
    try {
      mod.apply(f.ctx, {})
    } catch (err) {
      threw = String(err?.message ?? err)
    }
    add(
      '拿不到 webServer 时安静降级：工具与守门照常，只是没有 UI 端点（headless 友好）',
      threw === null && f.registered.length === EXPECTED_TOOL_COUNT && f.guards.length === 1 && f.routes.length === 0 &&
        f.logs.some(([, m]) => m.includes('未挂载开关 UI 端点')),
      `threw=${threw} tools=${f.registered.length} guards=${f.guards.length} routes=${f.routes.length}\n` +
        f.logs.filter(([l]) => l === 'warn').map(([l, m]) => `${l}: ${m}`).join('\n'),
    )
  }
  {
    const f = createFakeCtx()
    mod.apply(f.ctx, { switchRoute: false })
    add(
      '配置 switchRoute:false 时不挂路由（webServer 对外监听时该这么配）',
      f.routes.length === 0 && f.registered.length === EXPECTED_TOOL_COUNT,
      `routes=${f.routes.length} tools=${f.registered.length}`,
    )
  }

  lines.push('='.repeat(78))
  lines.push('dsh-pipeline 装载冒烟测试（假 ctx，不触碰真实宿主）')
  lines.push('='.repeat(78))
  for (const it of items) {
    lines.push('')
    lines.push(`${it.pass ? '✓' : '✗'} ${it.name}`)
    for (const l of it.detail.split('\n')) lines.push(`    ${l}`)
  }
  const passed = items.filter((i) => i.pass).length
  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`总计：${passed}/${items.length} 通过`)
  lines.push('='.repeat(78))

  return { passed, total: items.length, text: lines.join('\n'), items }
}

if (process.argv[1] !== undefined && /load-smoke\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runLoadSmoke()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
