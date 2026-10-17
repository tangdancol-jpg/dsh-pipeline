/**
 * dsh-pipeline · 开关的 HTTP 面（客户端 UI 与宿主之间的唯一通道）
 * ============================================================================
 * 客户端半边渲染在浏览器里，它要读 / 写宿主进程里的开关位。通道是
 * **同一个 web 端口上的相对 fetch**（登录 cookie 已经带着，不需要额外握手）。
 *
 * API 形状照抄已装的 dsh-orb（`dist/host/index.js:596-602`）：
 *
 *     ctx.webServer.register({ kind: "prefix", path: "/.dsh-pipeline", handler })
 *
 * 依据（`dsh-host-webserver/lib/index.js`）：
 *   · `register(route)` 把 `kind:"prefix"` 的路由放进 prefixes 表（第 177-184 行）；
 *   · 匹配是**最长前缀优先**，且要求 `pathname === prefix || pathname.startsWith(prefix + "/")`（第 327-329 行）；
 *   · **重复的 (kind, path) 会抛**（第 179 行）—— 所以注册必须幂等，见下面的 guard。
 *
 * ---------------------------------------------------------------------------
 * 安全边界（如实写清楚）
 * ---------------------------------------------------------------------------
 * 这个路由只做两件事：读一个布尔、写一个布尔。但仍然**只服务环回地址**：
 * 非环回的 remoteAddress 一律 403。理由：开关能整体关掉守门，
 * 那是一个安全相关的状态位，不该被局域网里的别人翻。
 *
 * 环回校验挡不住**浏览器跨站请求**：用户自己浏览器里打开的任意网页向本端口发请求，
 * 来源地址同样是环回。所以写操作（POST）另有一道跨站闸（{@link crossSiteReason}）：
 *   · 只收 `content-type: application/json` —— 跨站发 JSON 必须先过预检（OPTIONS），
 *     而本路由对 OPTIONS 回 405，预检过不去；表单 / text/plain 这类免预检的写法直接拒；
 *   · 带了 `Origin` 就必须与 `Host` 同源（`Origin: null` 也拒）；
 *   · 带了 `Sec-Fetch-Site` 就只认 `same-origin` / `none`。
 * 客户端 UI 走同源相对 fetch、本来就发 JSON，不受影响；不带 Origin 的本机脚本照常可用。
 *
 * 没有做的事（不要误以为有）：没有鉴权挑战。
 * 它依赖的是"这个端口本来就只绑定环回"这个前提（`webServer` 的默认 host）。
 * 如果你的 profile 把 webServer 配成对外监听，请把本路由关掉
 * （配置 `switchRoute: false`）。
 *
 * @module dsh-pipeline/lib/switch-routes
 */

/** 路由前缀。改它必须同步改 `lib/client.js` 里的 CLIENT_PATH。 */
export const ROUTE_PREFIX = '/.dsh-pipeline'

/** 状态路由的完整路径。 */
export const STATE_PATH = `${ROUTE_PREFIX}/state`

/**
 * 面板路由的完整路径（**只读**）。
 *
 * 与 `STATE_PATH` 的区别刻意写清楚：
 *   · `/state` 是开关位，**能写**（POST 改布尔）；
 *   · `/panel` 是**自建流水线面板的数据面**，只有 GET：返回
 *     `lib/panel/snapshot.js` 的 `buildPanelSnapshot()` 快照（任务 / 席位 / 待办数），
 *     **不写任何任务数据**，也不含交接物正文 / 补丁 / 代码。
 * 数据来源不在这里猜目录：由 `mountSwitchRoute` 的 `panel` 入参注入（见 `index.js` 的接线）。
 */
export const PANEL_PATH = `${ROUTE_PREFIX}/panel`

/**
 * 面板**写操作**路由的完整路径（`POST`；动作执行在 `lib/panel/actions.js`）。
 *
 * 与 `/panel` 的关系：`/panel` 只读快照，`/panel/action` 才是用户点按钮的出口。
 * 两条都是**精确匹配**（`path === …`），所以加这一条**不改** `/panel` 的任何行为。
 * 数据/执行来源不在这里猜：由 `mountSwitchRoute` 的 `panelAction` 入参注入
 * （见 `index.js` 的 `createPanelActions(...)` 接线）。
 */
export const PANEL_ACTION_PATH = `${ROUTE_PREFIX}/panel/action`

/** 请求体上限（就一个布尔，给 4 KB 已经很宽容了）。 */
const MAX_BODY_BYTES = 4096

/** 面板操作的请求体上限：`{task_id, action, confirm}` 三格，8 KB 绰绰有余。 */
const MAX_PANEL_ACTION_BODY_BYTES = 8192

/** 环回判定（IPv4 / IPv6 / IPv4-mapped IPv6）。 */
export function isLoopback(addr) {
  const a = String(addr ?? '')
  if (a.length === 0) return false
  if (a === '::1' || a === 'localhost') return true
  if (a.startsWith('127.')) return true
  // Node 在 IPv6 socket 上报 IPv4 会带 ::ffff: 前缀
  if (a.startsWith('::ffff:')) return isLoopback(a.slice('::ffff:'.length))
  return false
}

/** 发 JSON（统一带上 no-store：开关状态不该被任何层缓存）。 */
export function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 写操作的跨站闸：返回拒绝理由，放行返回 null。
 * @param {{ headers?: Record<string, string|string[]|undefined> }} req
 */
export function crossSiteReason(req) {
  const h = req.headers ?? {}
  const ct = String(h['content-type'] ?? '').toLowerCase()
  if (!ct.startsWith('application/json')) {
    return '写操作只接受 content-type: application/json（挡掉浏览器免预检就能跨站发出的表单 / text/plain 请求）。'
  }
  const site = h['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return `拒绝跨站写操作（sec-fetch-site: ${String(site)}）。`
  }
  const origin = h.origin
  if (origin !== undefined) {
    let originHost = null
    try { originHost = new URL(String(origin)).host.toLowerCase() } catch { /* "null" 或非法 ⇒ 视为跨站 */ }
    if (originHost === null || originHost !== String(h.host ?? '').toLowerCase()) {
      return `拒绝跨站写操作（origin ${String(origin)} 与 host ${String(h.host ?? '')} 不同源）。`
    }
  }
  return null
}

/** 收请求体（带上限，超了就拒）。 */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let aborted = false
    req.on('data', (c) => {
      if (aborted) return
      size += c.length
      if (size > limit) {
        aborted = true
        resolve({ ok: false, error: `请求体超过 ${limit} 字节` })
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return
      resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') })
    })
    req.on('error', (err) => {
      if (aborted) return
      aborted = true
      resolve({ ok: false, error: String(err?.message ?? err) })
    })
  })
}

/**
 * 造一个路由处理器（纯函数式，方便单测直接喂假 req/res）。
 *
 * @param {object} deps
 * @param {ReturnType<import('./switch.js').createSwitch>} deps.sw
 * @param {string} deps.version - 插件版本，回给 UI 用于展示
 * @param {(m:string)=>void} [deps.log]
 * @param {() => object} [deps.panel] - 面板快照数据源（只读；缺省 ⇒ `/panel` 回 503）。
 *   **本文件不猜 projectRoot** —— 目录从哪来是接线方（`index.js`）的事。
 * @param {{ run: (input:object) => Promise<object> }} [deps.panelAction] - 面板写操作执行器
 *   （`lib/panel/actions.js` 的 `createPanelActions()`；缺省 ⇒ `/panel/action` 回 503）。
 *   本文件**不判**动作白名单 / 开关 / 二次确认 —— 那些全在执行器里，只有一份。
 * @returns {(req:any, res:any)=>Promise<void>}
 */
export function createSwitchHandler(deps) {
  const { sw, version } = deps
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  /** 面板数据源：没有就如实说"没接线"，不拿空对象冒充一份快照。 */
  const panel = typeof deps.panel === 'function' ? deps.panel : null
  /** 面板写操作执行器：同上，没接线就 503（**不**拿"空操作"冒充一次成功）。 */
  const panelAction = deps.panelAction !== null && typeof deps.panelAction?.run === 'function' ? deps.panelAction : null

  return async function handleSwitchRoute(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const method = (req.method ?? 'GET').toUpperCase()

      // --- 只服务环回 -------------------------------------------------------
      const remote = req.socket?.remoteAddress ?? req.connection?.remoteAddress
      if (!isLoopback(remote)) {
        sendJson(res, 403, { ok: false, error: '多 AI 协调开关只对环回地址开放。' })
        return
      }

      // --- 面板（★ 只读）---------------------------------------------------
      //   刻意放在 `path !== STATE_PATH` 之前，且**不碰**下面任何一行 `/state` 的行为。
      if (path === PANEL_PATH) {
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: `面板是只读的，不支持 ${method}。` })
          return
        }
        if (panel === null) {
          sendJson(res, 503, { ok: false, error: '面板数据源未接线（mountSwitchRoute 没收到 panel 数据源）。' })
          return
        }
        let snapshot = null
        try {
          snapshot = panel()
        } catch (err) {
          // 快照自己承诺不抛；真抛了也不让整个路由层炸，如实回一句。
          log(`面板快照抛异常：${String(err?.stack ?? err)}`)
          sendJson(res, 500, { ok: false, error: '面板快照构建失败。' })
          return
        }
        sendJson(res, 200, snapshot)
        return
      }

      // --- 面板写操作（★ 与 `/panel` 精确匹配、互不影响）------------------
      //   `/panel/action` 走 POST；`/panel` 的 GET/405/503 行为一个字都没动。
      if (path === PANEL_ACTION_PATH) {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: `面板操作只支持 POST，不支持 ${method}。` })
          return
        }
        // ★ 与 `/state` 的写操作**同一道跨站闸**（本路由能删任务，比开关更该挡）：
        //   跨站发 JSON 必须先过预检，而本路由对 OPTIONS 回 405 ⇒ 预检过不去；
        //   免预检的表单 / text/plain 在这里直接拒。同源客户端照常发 JSON，不受影响。
        const crossSite = crossSiteReason(req)
        if (crossSite !== null) {
          log(`拒绝了一次面板操作请求：${crossSite}`)
          sendJson(res, 403, { ok: false, error: crossSite })
          return
        }
        if (panelAction === null) {
          sendJson(res, 503, { ok: false, error: '面板操作未接线（mountSwitchRoute 没收到 panelAction 执行器）。' })
          return
        }
        const raw = await readBody(req, MAX_PANEL_ACTION_BODY_BYTES)
        if (raw.ok !== true) {
          sendJson(res, 413, { ok: false, error: raw.error })
          return
        }
        let parsed = null
        try {
          parsed = raw.text.trim().length === 0 ? {} : JSON.parse(raw.text)
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendJson(res, 400, { ok: false, error: '请求体必须是对象。' })
          return
        }
        // ★ 判据（白名单 / 开关门 / 二次确认 / 状态机）**全在执行器里**，这里只递参。
        //   业务失败照旧 HTTP 200：客户端读 `ok`，不必在状态码与正文之间做二次推断。
        let result = null
        try {
          result = await panelAction.run({
            task_id: parsed.task_id,
            action: parsed.action,
            confirm: parsed.confirm === true,
          })
        } catch (err) {
          // 执行器承诺绝不抛；真抛了也不让路由层炸，如实回一句。
          log(`面板操作执行器抛异常：${String(err?.stack ?? err)}`)
          sendJson(res, 500, { ok: false, action: typeof parsed.action === 'string' ? parsed.action : '', task_id: typeof parsed.task_id === 'string' ? parsed.task_id : '', error: '面板操作执行失败。' })
          return
        }
        sendJson(res, 200, result)
        return
      }

      if (path !== STATE_PATH) {
        sendJson(res, 404, { ok: false, error: `未知路径 ${path}` })
        return
      }

      // --- 读 ---------------------------------------------------------------
      if (method === 'GET' || method === 'HEAD') {
        sendJson(res, 200, {
          ok: true,
          on: sw.isOn(),
          since: sw.snapshot().since,
          by: sw.snapshot().by,
          revision: sw.snapshot().revision,
          version,
          stateFile: sw.stateFile,
        })
        return
      }

      // --- 写 ---------------------------------------------------------------
      if (method === 'POST') {
        const crossSite = crossSiteReason(req)
        if (crossSite !== null) {
          log(`拒绝了一次开关写请求：${crossSite}`)
          sendJson(res, 403, { ok: false, error: crossSite })
          return
        }
        const raw = await readBody(req)
        if (raw.ok !== true) {
          sendJson(res, 413, { ok: false, error: raw.error })
          return
        }
        let parsed = null
        try {
          parsed = raw.text.trim().length === 0 ? {} : JSON.parse(raw.text)
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON。' })
          return
        }
        if (parsed === null || typeof parsed !== 'object') {
          sendJson(res, 400, { ok: false, error: '请求体必须是对象。' })
          return
        }

        // 两种写法都收：{on: true|false} 显式设定；{} 或 {toggle:true} 翻转。
        const explicit = typeof parsed.on === 'boolean'
        const meta = { by: 'client-ui', reason: typeof parsed.reason === 'string' ? parsed.reason : '' }
        const result = explicit ? sw.set(parsed.on, meta) : sw.toggle(meta)

        log(`开关被客户端 UI 置为 ${result.state.on ? '开' : '关'}（revision ${result.state.revision}，落盘=${result.persisted}）`)
        sendJson(res, 200, {
          ok: true,
          on: result.state.on,
          changed: result.changed,
          since: result.state.since,
          by: result.state.by,
          revision: result.state.revision,
          persisted: result.persisted,
          version,
          stateFile: sw.stateFile,
        })
        return
      }

      sendJson(res, 405, { ok: false, error: `不支持的方法 ${method}` })
    } catch (err) {
      log(`路由处理异常：${String(err?.stack ?? err)}`)
      try {
        sendJson(res, 500, { ok: false, error: '开关路由内部错误。' })
      } catch {
        /* 头已经发出去了，没法再回；忽略 */
      }
    }
  }
}

/**
 * 把路由挂到 `ctx.webServer` 上（**幂等**：重复调用只挂一次）。
 *
 * 刻意用 `typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer`
 * 这种**运行期探测**，而不是把 `webServer` 写进 `inject`：
 * 写进 inject 的话，没有 webServer 的形态（headless）下整个插件都不会激活 ——
 * 而守门与工具在 headless 下照样有用。拿不到 webServer 时本函数返回 null，
 * 调用方应当据此降级（开关仍然能用 `pipeline_switch` 工具翻）。
 *
 * ★ 面板数据面：`deps.panel` 原样递给 `createSwitchHandler`（本函数不看内容、不猜目录）。
 *   同一个前缀下于是有两条路：`/state` 可读写开关位，`/panel` 只读快照。
 * ★ 面板**写操作**：`deps.panelAction` 原样递给 `createSwitchHandler` ——
 *   动作白名单 / 开关门 / 二次确认 / 状态机全在 `lib/panel/actions.js`，
 *   本文件只负责 HTTP 形状（方法、跨站闸、8KB 上限、坏 JSON）。
 *
 * @returns {{ dispose:()=>void, handler:Function } | null}
 */
export function mountSwitchRoute(ctx, deps) {
  const webServer = typeof ctx?.get === 'function' ? ctx.get('webServer') : ctx?.webServer
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    return null
  }
  const handler = createSwitchHandler(deps)
  const dispose = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
  return { dispose, handler }
}
