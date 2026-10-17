/**
 * dsh-pipeline · 客户端半边自测（没有浏览器也能验）
 * ============================================================================
 *     node tests/client-check.mjs
 *
 * 本机没有浏览器截图能力，所以把"右上角那个按钮"拆成**可断言的三层**：
 *
 *   A. 装载契约 —— 文件是宿主能吃的**经典脚本**（不是 ES 模块）、
 *      在 `window.__ModuleLoader__.load({id, factory})` 上注册、id 等于包名。
 *   B. 挂载契约 —— `apply(ctx)` 用 `ctx.effect(() => ctx.slots.inject(...))` 注册，
 *      槽位名 / 条目 id / 排序权重都对；且目标槽位是 **list** 槽
 *      （所以带 id+order 是**必需**的，不带会被核心直接抛）。
 *   C. 行为 —— 用一个**桩 React**真的把组件渲染一遍：
 *      读状态 → 显示"开"；点一下 → POST 出 `{on:false}` → 显示"关"。
 *
 * ★ 用的是 `node:vm` + 桩 React/fetch，不依赖浏览器、不联网、零副作用。
 *   凡是没验到的（真实排版、真实点击、真实主题）在报告里**明说没验**。
 *
 * @module dsh-pipeline/tests/client-check
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = join(HERE, '..', 'lib', 'client.js')
const PKG_FILE = join(HERE, '..', 'package.json')

// ---------------------------------------------------------------------------
// 桩 React：只实现本组件用到的那几个 hook，语义尽量贴近真实
// ---------------------------------------------------------------------------

/**
 * 造一个"可重复渲染"的桩 React。
 *
 * - `useState` 把值存进 `slots`（按调用序），所以**再次渲染同一个组件**时
 *   能读到上一次的更新 —— 这正是"点一下按钮文字变了"要验的东西。
 * - `useEffect` **只在首次渲染时执行**（贴近真实语义），清理函数被记下来。
 * - `createElement` 产出一棵普通对象树，便于断言文字与属性。
 */
function createStubReact() {
  const slots = []
  const effects = []
  let cursor = 0
  let mounted = false

  const api = {
    /** 渲染一轮：重置游标，返回元素树。 */
    render(Component, props) {
      cursor = 0
      mounted = true
      return Component(props)
    },
    /** 重置挂载状态（模拟重新挂载）。 */
    reset() {
      slots.length = 0
      effects.length = 0
      cursor = 0
      mounted = false
    },
    useState(initial) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      const setter = (next) => {
        slots[i] = typeof next === 'function' ? next(slots[i]) : next
      }
      return [slots[i], setter]
    },
    useEffect(fn, deps) {
      const i = cursor++
      void deps
      if (!mounted || !(i in effects)) {
        effects[i] = fn() ?? null
      }
    },
    useRef(initial) {
      const i = cursor++
      if (!(i in slots)) slots[i] = { current: initial }
      return slots[i]
    },
    useCallback(fn, deps) {
      cursor++
      void deps
      return fn
    },
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
    },
  }
  return api
}

/** 把元素树里的文字全抠出来（用于断言按钮上写了什么）。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node.props !== undefined) return textOf(node.props.children)
  return ''
}

/** 在元素树里找第一个满足条件的节点。 */
function find(node, pred) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const c of node) {
      const hit = find(c, pred)
      if (hit !== null) return hit
    }
    return null
  }
  if (pred(node)) return node
  return find(node.props?.children, pred)
}

// ---------------------------------------------------------------------------
// 沙箱里跑客户端脚本
// ---------------------------------------------------------------------------

/**
 * 在 `node:vm` 里把 `lib/client.js` 当**经典脚本**跑一遍。
 *
 * @param {object} opts
 * @param {boolean} [opts.browser] - true = 提供 `window.__ModuleLoader__`（模拟浏览器）；
 *                                  false = 不提供（走 Node 分支，挂到 globalThis）
 * @param {Function} [opts.fetchImpl]
 */
function runClientScript(opts = {}) {
  const loads = []
  const sandbox = {
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    fetch: opts.fetchImpl ?? (() => Promise.reject(new Error('no fetch'))),
    AbortController,
    URL,
    JSON,
  }
  if (opts.browser === true) {
    sandbox.window = {
      __ModuleLoader__: {
        load(descriptor) {
          loads.push(descriptor)
        },
      },
    }
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  vm.runInContext(readFileSync(CLIENT_FILE, 'utf8'), context, { filename: 'dsh-pipeline/lib/client.js' })
  return { sandbox, context, loads }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function runClientCheck() {
  const items = []
  const add = (name, pass, detail) => items.push({ name, pass: pass === true, detail: String(detail ?? '') })
  const src = readFileSync(CLIENT_FILE, 'utf8')
  const pkg = JSON.parse(readFileSync(PKG_FILE, 'utf8'))

  // =========================================================================
  // A. 装载契约
  // =========================================================================
  add(
    'A1 文件是经典脚本：没有 import / export / 顶层 await（宿主用 <script async src> 加载）',
    !/^\s*import\s/m.test(src) && !/^\s*export\s/m.test(src) && !/^\s*await\s/m.test(src),
    `import 命中：${/^\s*import\s/m.test(src)}\nexport 命中：${/^\s*export\s/m.test(src)}\n顶层 await 命中：/^\\s*await\\s/m.test(src)`,
  )
  add(
    'A2 调了 window.__ModuleLoader__.load({ id, factory })',
    /window\.__ModuleLoader__\.load\(/.test(src),
    '源码里有 window.__ModuleLoader__.load(...) 调用',
  )

  const browserRun = runClientScript({ browser: true })
  add(
    'A3 浏览器路径下真的注册了一个模块描述符',
    browserRun.loads.length === 1 && typeof browserRun.loads[0].factory === 'function',
    `load() 调用次数：${browserRun.loads.length}\n描述符：${JSON.stringify(Object.keys(browserRun.loads[0] ?? {}))}`,
  )
  const descriptor = browserRun.loads[0] ?? { id: '(无)', factory: null }
  add(
    'A4 模块 id 等于包名（宿主用它拼 /plugins/<id>/client.js）',
    descriptor.id === pkg.name,
    `描述符 id = ${JSON.stringify(descriptor.id)}　package.json name = ${JSON.stringify(pkg.name)}`,
  )
  add(
    'A5 package.json 声明了 exports["./client"] 与 dsh.client.platform="web"',
    pkg.exports?.['./client'] === './lib/client.js' && pkg.dsh?.client?.platform === 'web',
    `exports["./client"] = ${JSON.stringify(pkg.exports?.['./client'])}\ndsh.client = ${JSON.stringify(pkg.dsh?.client)}`,
  )

  // Node 分支（自测路径）也要能拿到描述符
  const nodeRun = runClientScript({ browser: false })
  const nodeDescriptors = nodeRun.sandbox.__DSH_PIPELINE_CLIENT__ ?? []
  add(
    'A6 没有 __ModuleLoader__ 时（Node 分支）把描述符挂到 globalThis，供自测取用',
    nodeDescriptors.length === 1 && nodeDescriptors[0].id === pkg.name,
    `globalThis.__DSH_PIPELINE_CLIENT__.length = ${nodeDescriptors.length}`,
  )

  // =========================================================================
  // B. 挂载契约
  // =========================================================================
  const StubReact = createStubReact()
  const requireStub = (name) => {
    if (name === 'react') return StubReact
    throw new Error(`dsh-pipeline client 不该 require("${name}")`)
  }

  /** 造一个假的客户端 ctx（只实现本插件用到的那几个成员）。 */
  function makeFakeCtx() {
    const effects = []
    const injections = []
    const registrations = []
    return {
      ctx: {
        effect(fn, label) {
          const d = fn()
          effects.push(label ?? '(未命名)')
          return typeof d === 'function' ? d : () => {}
        },
        slots: {
          inject(key, cb) {
            injections.push(key)
            return cb()
          },
          register(spec, component) {
            registrations.push({ spec, component })
            return () => {}
          },
        },
      },
      effects,
      injections,
      registrations,
    }
  }

  const exportsObj = descriptor.factory(requireStub)
  add(
    'B1 工厂返回 { apply, inject }（宿主客户端半边认这两个导出）',
    typeof exportsObj.apply === 'function' && Array.isArray(exportsObj.inject),
    `typeof apply = ${typeof exportsObj.apply}　inject = ${JSON.stringify(exportsObj.inject)}`,
  )
  add(
    'B2 inject 声明的是**服务名** slots（不是包名）',
    exportsObj.inject.length === 1 && exportsObj.inject[0] === 'slots',
    `inject = ${JSON.stringify(exportsObj.inject)}`,
  )

  const fake = makeFakeCtx()
  let applyThrew = null
  try {
    exportsObj.apply(fake.ctx)
  } catch (err) {
    applyThrew = String(err?.stack ?? err)
  }
  add('B3 apply(ctx) 不抛', applyThrew === null, applyThrew ?? '未抛异常')
  add(
    'B4 挂载走 ctx.effect（卸载时能干净摘掉）',
    fake.effects.length === 1 && fake.effects[0].includes('dsh-pipeline'),
    `effect：${JSON.stringify(fake.effects)}`,
  )
  add(
    'B5 注册进 conversation.session.header.utilities（会话头部右侧、右侧栏切换按钮左边一格）',
    fake.injections.length === 1 && fake.injections[0] === 'conversation.session.header.utilities',
    `slots.inject 的 key：${JSON.stringify(fake.injections)}`,
  )

  const reg = fake.registrations[0]
  add(
    'B6 该槽位是 list 槽 → 注册必须带 id（不带会被 SlotCore 直接抛）',
    reg !== undefined && typeof reg.spec.id === 'string' && reg.spec.id.length > 0,
    `注册 spec：${JSON.stringify(reg?.spec)}`,
  )
  add(
    'B7 注册的 name 与 inject 的 key 一致，且给了 order 让它排在最右',
    reg !== undefined && reg.spec.name === 'conversation.session.header.utilities' && Number.isFinite(reg.spec.order),
    `name=${reg?.spec?.name}　order=${reg?.spec?.order}`,
  )
  add(
    'B8 注册的是 React 组件（函数）',
    reg !== undefined && typeof reg.component === 'function',
    `typeof component = ${typeof reg?.component}`,
  )

  // =========================================================================
  // C. 行为：读状态 → 显示；点一下 → 写状态 → 显示变了
  // =========================================================================
  const calls = []
  let currentOn = true
  const fetchImpl = (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ?? null })
    if ((init?.method ?? 'GET') === 'POST') {
      const parsed = init?.body ? JSON.parse(String(init.body)) : {}
      if (typeof parsed.on === 'boolean') currentOn = parsed.on
      else currentOn = !currentOn
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, on: currentOn, version: '0.1.0', revision: 1 }),
    })
  }

  StubReact.reset()
  const run2 = runClientScript({ browser: true, fetchImpl })
  const d2 = run2.loads[0]
  const ex2 = d2.factory(requireStub)
  const fake2 = makeFakeCtx()
  ex2.apply(fake2.ctx)
  const Component = fake2.registrations[0].component

  // --- 第一轮渲染：effect 里发 GET，等一个微任务队列排空 ---
  let tree = StubReact.render(Component, {})
  await new Promise((r) => setTimeout(r, 0))
  tree = StubReact.render(Component, {})

  const firstText = textOf(tree)
  const firstGet = calls.filter((c) => c.method === 'GET')
  add(
    'C1 挂载后向宿主的开关端点发 GET（相对路径，带 same-origin 凭据）',
    firstGet.length >= 1 && firstGet[0].url === '/.dsh-pipeline/state',
    `fetch 调用：${JSON.stringify(calls.map((c) => `${c.method} ${c.url}`))}`,
  )
  add(
    'C2 状态为开时，按钮文字包含「多AI 协调」与「开」',
    firstText.includes('多AI 协调') && firstText.includes('开'),
    `渲染出的文字：「${firstText}」`,
  )
  const btn = find(tree, (n) => n.type === 'button')
  add(
    'C3 渲染出一个真正的 <button>，带可访问名与 aria-pressed',
    btn !== null && btn.props.type === 'button' && typeof btn.props['aria-label'] === 'string' && btn.props['aria-pressed'] === true,
    `button props：${JSON.stringify({ type: btn?.props?.type, 'aria-label': btn?.props?.['aria-label'], 'aria-pressed': btn?.props?.['aria-pressed'] })}`,
  )
  add(
    'C4 按钮在 Electron 拖拽区里可点（显式 WebkitAppRegion: no-drag）',
    btn !== null && btn.props.style?.WebkitAppRegion === 'no-drag',
    `style.WebkitAppRegion = ${JSON.stringify(btn?.props?.style?.WebkitAppRegion)}`,
  )

  // --- 点击 → POST ---
  currentOn = true
  await btn.props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  tree = StubReact.render(Component, {})

  const posts = calls.filter((c) => c.method === 'POST')
  add(
    'C5 点一下会向宿主的开关端点发 POST，body 是 { on: false }',
    posts.length === 1 && posts[0].url === '/.dsh-pipeline/state' && posts[0].body === JSON.stringify({ on: false }),
    `POST 调用：${JSON.stringify(posts.map((p) => p.body))}`,
  )
  const afterText = textOf(tree)
  add(
    'C6 点击后按钮文字变成「关」（说明回包被正确吸收）',
    afterText.includes('关') && !afterText.includes('开'),
    `点击后文字：「${afterText}」`,
  )
  add(
    'C7 按钮带 data-pipeline-toggle 便于人工/自动化核对当前状态',
    find(tree, (n) => n.type === 'button')?.props['data-pipeline-toggle'] === 'off',
    `data-pipeline-toggle = ${JSON.stringify(find(tree, (n) => n.type === 'button')?.props['data-pipeline-toggle'])}`,
  )
  add(
    'C8 title 提示里写清了开/关各自的语义（用户不必翻文档）',
    typeof btn.props.title === 'string' && btn.props.title.includes('开 =') && btn.props.title.includes('关 ='),
    `title：「${String(btn.props.title).split('\n')[0]}…」`,
  )

  // --- 通信失败 → 不假装是开 ---
  {
    StubReact.reset()
    const run3 = runClientScript({ browser: true, fetchImpl: () => Promise.reject(new Error('boom')) })
    const ex3 = run3.loads[0].factory(requireStub)
    const fake3 = makeFakeCtx()
    ex3.apply(fake3.ctx)
    const C3 = fake3.registrations[0].component
    StubReact.render(C3, {})
    await new Promise((r) => setTimeout(r, 0))
    const t3 = StubReact.render(C3, {})
    const txt = textOf(t3)
    add(
      'C9 读不到宿主状态时显示未知（?），**不会**假装是"开"',
      txt.includes('多AI 协调') && txt.includes('?') && !txt.includes('开'),
      `渲染出的文字：「${txt}」\n（拿不到状态时既不能说开也不能说关 —— 说错会误导用户）`,
    )
  }

  // =========================================================================
  // D. 拆分后的 package-local chunk 契约（入口 + 同目录 client.<name>.js）
  // =========================================================================
  //
  // 依据（宿主源码，不是猜）：
  //   · `dsh-client-modules/lib/index.js:170`  CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
  //   · `:934-976` chunkRequest/chunkResponse：只认 `/plugins/<id>/client.<name>.js?rev=<入口 rev>`，
  //     文件读自 `join(dirname(entry.clientPath), fileName)` —— 必须和 lib/client.js **同目录**
  //   · `:843-878` require.async('./client.<name>.js') → importChunk → chunkId = ownerId + '/' + chunk
  //   · `:703-715` register() 用 `registration.chunk` 认这个 chunk 属于哪个包
  const LIB_DIR = join(HERE, '..', 'lib')
  const CHUNK_RE = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
  const chunkFiles = readdirSync(LIB_DIR)
    .filter((f) => f !== 'client.js' && CHUNK_RE.test(f))
    .sort()
  const entryChunks = [...new Set([...src.matchAll(/'(client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js)'/g)].map((m) => m[1]))].sort()

  add(
    'D1 入口里**字面**调了 require.async(（包内 chunk 协议，不是自己拼 script）',
    src.includes('require.async(') && /\.\/'\s*\+\s*CHUNKS\[/.test(src),
    `require.async( 命中：${src.includes('require.async(')}\n拼 spec 的写法命中：${/\.\/'\s*\+\s*CHUNKS\[/.test(src)}`,
  )
  add(
    'D2 入口列出的 chunk 与磁盘上的 chunk **一一对应**（不多不少，都真实存在）',
    entryChunks.length > 0 &&
      entryChunks.length === chunkFiles.length &&
      entryChunks.every((f) => chunkFiles.includes(f)),
    `入口列出 ${entryChunks.length} 个：${entryChunks.join(', ')}\n磁盘上 ${chunkFiles.length} 个：${chunkFiles.join(', ')}`,
  )
  add(
    'D3 每个 chunk 文件名都匹配宿主的 CLIENT_CHUNK 正则（不匹配 = 宿主直接 404 或拒收）',
    chunkFiles.length > 0 && chunkFiles.every((f) => CHUNK_RE.test(f)),
    chunkFiles.map((f) => `${f} → ${CHUNK_RE.test(f)}`).join('\n'),
  )

  // 每个 chunk 当**经典脚本**跑一遍：必须走 window.__ModuleLoader__.load({ id, chunk, factory })
  const chunkRuns = []
  for (const file of chunkFiles) {
    const chunkSrc = readFileSync(join(LIB_DIR, file), 'utf8')
    const loads = []
    const sandbox = {
      console,
      Symbol,
      Object,
      JSON,
      window: { __ModuleLoader__: { load(d) { loads.push(d) } } },
    }
    sandbox.globalThis = sandbox
    let threw = null
    try {
      vm.runInContext(chunkSrc, vm.createContext(sandbox), { filename: 'dsh-pipeline/lib/' + file })
    } catch (err) {
      threw = String(err && err.message ? err.message : err)
    }
    chunkRuns.push({ file, chunkSrc, loads, threw })
  }

  const classicOk = chunkRuns.filter(
    (r) => !/^\s*import\s/m.test(r.chunkSrc) && !/^\s*export\s/m.test(r.chunkSrc) && !/^\s*await\s/m.test(r.chunkSrc),
  )
  add(
    'D4 每个 chunk 也是**经典脚本**（无 import / export / 顶层 await）',
    classicOk.length === chunkRuns.length,
    chunkRuns
      .filter((r) => !classicOk.includes(r))
      .map((r) => `${r.file}：import=${/^\s*import\s/m.test(r.chunkSrc)} export=${/^\s*export\s/m.test(r.chunkSrc)} await=${/^\s*await\s/m.test(r.chunkSrc)}`)
      .join('\n') || `${chunkRuns.length} 个 chunk 全部干净`,
  )
  const regOk = chunkRuns.every(
    (r) =>
      r.threw === null &&
      r.loads.length === 1 &&
      r.loads[0].id === pkg.name &&
      r.loads[0].chunk === r.file &&
      typeof r.loads[0].factory === 'function',
  )
  add(
    'D5 每个 chunk 都在 window.__ModuleLoader__.load({ id, chunk, factory }) 里注册，且 chunk 与文件名逐字一致',
    regOk,
    chunkRuns
      .map((r) => `${r.file}：load=${r.loads.length} id=${r.loads[0]?.id} chunk=${r.loads[0]?.chunk} factory=${typeof r.loads[0]?.factory}${r.threw ? ' 抛：' + r.threw : ''}`)
      .join('\n'),
  )

  // factory 真的能跑：给出 react 替身，导出里必须有 create()
  const factoryRuns = chunkRuns.map((r) => {
    if (r.loads.length !== 1) return { file: r.file, ok: false, why: '没注册' }
    try {
      const exported = r.loads[0].factory(requireStub)
      return { file: r.file, ok: typeof exported.create === 'function', why: `create=${typeof exported.create}` }
    } catch (err) {
      return { file: r.file, ok: false, why: String(err && err.message ? err.message : err) }
    }
  })
  add(
    'D6 每个 chunk 的 factory 跑得起来，并且导出 create()（入口就是靠它建模块实例）',
    factoryRuns.every((r) => r.ok),
    factoryRuns.map((r) => `${r.file}：${r.ok ? 'ok' : '✗ ' + r.why}`).join('\n'),
  )

  // 行数上限：拆分的意义就是每块都读得完
  const lineCounts = [
    { file: 'client.js', n: src.split('\n').length - 1 },
    ...chunkRuns.map((r) => ({ file: r.file, n: r.chunkSrc.split('\n').length - 1 })),
  ]
  add(
    'D7 入口与每个 chunk 都 ≤ 400 行（拆分的目的就是「每块读得完」）',
    lineCounts.every((x) => x.n <= 400),
    lineCounts.map((x) => `${String(x.n).padStart(4)}  ${x.file}`).join('\n') + `\n合计 ${lineCounts.reduce((a, b) => a + b.n, 0)} 行 / ${lineCounts.length} 个文件`,
  )

  // =========================================================================
  const lines = []
  lines.push('='.repeat(78))
  lines.push('dsh-pipeline 客户端半边自测（node:vm + 桩 React/fetch，无浏览器）')
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
  lines.push('')
  lines.push('★ 没验到的（如实列出，别当成验过了）：')
  lines.push('  · 真实排版与像素位置 —— 需要浏览器；本机没有截图能力。')
  lines.push('  · 真实点击与真实宿主插槽渲染 —— 需要装上去并跑起 DSH。')
  lines.push('  · 与宿主主题/字体的协调 —— 组件用纯内联样式，不读宿主 CSS 变量。')

  return { passed, total: items.length, text: lines.join('\n'), items }
}

if (process.argv[1] !== undefined && /client-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runClientCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
