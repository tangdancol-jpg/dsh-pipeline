/**
 * dsh-pipeline · 任务存储 · 配置、缓存与读写落盘
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/base
 */

import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { ROLE } from '../roles.js'
import { isInside, nowIso, PACKAGE_ROOT, pathKey, resolveAgainstAnchor } from '../util.js'
import { resetHashGateOrigin } from '../hashgate.js'
import { DEFAULT_SEAT_SILENCE_MS } from '../liveness.js'
import { writeJsonAtomic, appendJsonl, readJson, buildHumanRequestEntry } from './shared.js'

/**
 * 任务存储 · 配置、缓存与读写落盘
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function createStoreBase(ctx) {
  const { opts } = ctx

  const projectRoot = resolve(opts.projectRoot)
  const dirName = opts.artifactDirName ?? '.pipeline'
  const root = join(projectRoot, dirName)
  const maxRework = Number.isInteger(opts.maxReworkPerLeg) ? opts.maxReworkPerLeg : 2
  /**
   * ★ 失联静默阈值（毫秒）。见 `lib/liveness.js`：默认 5 分钟。
   * 由 `config.seatSilenceMs` 传进来。
   */
  const seatSilence =
    Number.isInteger(opts.seatSilenceMs) && opts.seatSilenceMs > 0 ? opts.seatSilenceMs : DEFAULT_SEAT_SILENCE_MS
  /**
   * ★ 哈希闸门**连续不通过**多少次 ⇒ 自动交人工（0 = 关掉自动升级）。
   *
   * 用户拍板（P13）：不扣打回预算（保持现状），但连续 N 次不过就自动交人工。
   * 语义与理由写在 `lib/config.js` 的 `hashGateEscalateAfter` 与 `lib/hashgate.js`。
   */
  const hashGateEscalateAfter = Number.isInteger(opts.hashGateEscalateAfter) ? opts.hashGateEscalateAfter : 3
  /**
   * ★ **授权面锚点**：`change_scope[].path` 里的**裸相对路径**按它解析。
   *
   * 由 `config.changeScopeAnchor` 传进来（装配处见 `index.js`）；留空 = **插件包根**
   * （`PACKAGE_ROOT`）。**必须与守门用同一个锚点** —— 否则同一份授权面
   * 在「改动面审计」与「守门」两处会得出不同结论（一个说在授权面内、一个说越界）。
   *
   * 为什么不能拿 `project_root` 拼：见 `lib/config.js` 的 `changeScopeAnchor`（真单实测）。
   */
  const scopeAnchor =
    typeof opts.scopeAnchor === 'string' && opts.scopeAnchor.trim().length > 0
      ? pathKey(resolveAgainstAnchor(PACKAGE_ROOT, opts.scopeAnchor))
      : PACKAGE_ROOT
  /**
   * ★ **某个任务的授权面锚点**：`task.scope_anchor`（元数据里显式写的包根，若有）
   *   > 配置/包根默认（`scopeAnchor`）。
   *
   * 按**任务**取而不是按进程取：一个任务的锚点不该影响另一个任务的判定
   * （守门那一侧同理，见 `lib/guard.js` 的 `makeTaskIndexEntry`）。
   */
  const anchorOf = (task) => {
    const raw = typeof task?.scope_anchor === 'string' ? task.scope_anchor.trim() : ''
    return raw.length > 0 ? pathKey(resolveAgainstAnchor(scopeAnchor, raw)) : scopeAnchor
  }

  /**
   * ★ **路径归一化**（唯一一套坐标系；**复用既有 `changeScopeAnchor`，不新造第二套锚点**）。
   *
   * -----------------------------------------------------------------------------
   * 修的是哪条漏路（本轮 ③）
   * -----------------------------------------------------------------------------
   * 问题的形状是**两边不在同一个坐标系里**：
   *   · **基线**的键是「**相对项目根**」的 POSIX 路径（`takeBaselineSnapshot`
   *     从 `task.project_root` 往下扫出来的）；
   *   · **授权面**的条目却可能是**任意一棵树**的**绝对路径** —— 真单
   *     T-20261011-5a871c 的 5 条授权里，源码树那两条写的就是
   *     `C:\…\dsh_orb\…\dsh-pipeline\lib\` 这样的绝对路径。
   *
   * 早先这里拿 `isInside(projectRoot, abs)` 把"落在项目根之外"的条目判成
   * "解析不出"（返回 `null`）⇒ 那两条授权**整条作废**：授权面与校验面对不上，
   * 编写席在源码树里**怎么写都对不上**（怎么写都判越界）。
   *
   * 修法：**两边先落到同一个坐标系（规范绝对键）再比** ——
   *   · 授权条目 / 改动声明里的路径：按**既有锚点**解析（绝对路径原样归一化；
   *     裸相对路径拼到锚点下 —— 与守门 `normScopePath` 用的是同一个
   *     `resolveAgainstAnchor`，所以两侧结论不会打架）；
   *   · 基线的键：拼回项目根，得到同一个坐标系里的绝对键。
   *
   * ⚠️ **这不是放宽**：
   *   · 基线的键**只**覆盖项目根之内的文件；项目根之外的树压根不在基线里
   *     ⇒ 那里"授权得到"也不会凭空放行任何基线内的文件；
   *   · 项目根之内的判定与改动前**逐条等价**（同一个全小写化、同一个 `isInside`，
   *     原来的 `r === p || r.startsWith(p + '/')` 正是 `isInside` 的同一件事）。
   */
  const cmpKey = (p) => pathKey(p).toLowerCase()
  /** 授权条目 / 改动声明里的路径 → 规范绝对比较键（按既有锚点解析；`''` = 解析不出）。 */
  const scopeAbsKey = (raw, task) => {
    const abs = resolveAgainstAnchor(anchorOf(task), raw)
    return abs.length === 0 ? '' : cmpKey(abs)
  }
  /** 基线的键（相对项目根）→ 同一个坐标系里的绝对比较键。 */
  const baselineAbsKey = (rel) => cmpKey(`${projectRoot}/${String(rel ?? '').replace(/\\/g, '/')}`)

  /**
   * 把一条授权面条目解析成**相对项目根**的 POSIX 路径（基线的键就是这个形状）。
   *
   * 例：锚点 = `<profile>/node_modules/dsh-pipeline`、`project_root` = `<profile>`、
   *     条目写 `index.js` ⇒ `node_modules/dsh-pipeline/index.js` —— 这才对得上基线。
   *
   * ★ 修 ③：落在 `project_root` **之外**的条目**不再返回 `null`**（那等于把这条
   *   授权悄悄作废），改为返回它的**规范绝对键** —— 与 `baselineAbsKey()` 出来的
   *   绝对键同一坐标系，于是"绝对路径 vs 相对路径"的错位不再存在。
   *   仍然是 `null` 的只有一种：**空串**（压根没写路径）。
   */
  const scopeRelOf = (raw, task) => {
    const abs = scopeAbsKey(raw, task)
    if (abs.length === 0) return null
    return isInside(projectRoot, abs) ? relKey(projectRoot, abs).replace(/\/+$/, '') : abs
  }
  /** 人工介入请求的默认截止时长（小时）。0 = 不设截止（那时不允许按超时放行）。 */
  const timeoutHours = Number.isFinite(opts.humanRequestTimeoutHours) && opts.humanRequestTimeoutHours > 0
    ? opts.humanRequestTimeoutHours
    : 0
  /** 是否强制答复回带转告时给出的确认码（更防伪、但更啰嗦）。 */
  const requireHumanConfirmCode = opts.requireHumanConfirmCode === true
  /** ★ 同一个澄清问题最多问几次（防踢皮球；默认 2）。 */
  const maxClarifyRounds = Number.isInteger(opts.maxClarifyRounds) ? opts.maxClarifyRounds : 2
  const now = typeof opts.now === 'function' ? opts.now : () => new Date()

  /**
   * ★ 被拒收交付的留档上限（字符）：超长只留前一段并标注。
   *   取值理由：任务文件已经 MB 级，单条留档不该成为新的大头；同时"它交过什么"
   *   这段够读（判据要的是**可查回**，不是"逐字节留全"）。
   */
  const MAX_REJECTED_PAYLOAD_CHARS = 20000

  /** 内存缓存：taskId → task 对象。写操作先更新缓存再落盘。 */
  const cache = new Map()

  /**
   * ★★ **读侧对账用的盘上指纹**：taskId → `"<size>:<mtimeMs>"`（**本进程最后一次
   * 与盘同步那一刻**盘上的样子）。`persist()` 写完刷新它，`loadTask()` 读之前拿它
   * 与**当前**盘上指纹比。
   *
   * -----------------------------------------------------------------------------
   * 为什么必须要有这一条（现场：真单 T-20261012-7b9408，2026-10-11T16:33–16:34）
   * -----------------------------------------------------------------------------
   * 症状是「**写进去了、读不到**」：盘上的 `task.json` 里 `human_requests[]` 有那条
   * `pending`（`request_id=HR-a1b726450f7ac4`），而主对话调
   * `pipeline_human_relay { task_id }`（收件箱模式）得到的是
   * 「任务 … 目前没有人工介入请求。」—— 过一会儿再调又正常了。
   *
   * 读侧的路径查清了（这是上一轮**没覆盖**的那半边）：
   *   · `lib/tools/human.js` 收件箱 → `store.listHumanRequests({ taskId })`
   *   · `lib/store.js` 的 `listHumanRequests` → `task.human_requests`
   *   · `lib/store.js` 的 `loadTask`：`const cached = cache.get(taskId); if (cached !== undefined) return cached`
   *     ⇒ **内存实例优先、且从不与盘对账**。
   *
   * 上一轮给 `loadTask` 加的"读盘即自愈"只挂在**读盘分支**上；缓存命中那条路
   * 一个字节都不看盘 ⇒ 只要内存里那份实例不是最新的（写事务还在途、或这份实例
   * 与真正落盘的那份不是同一个对象），收件箱就会拿旧实例回答 —— 而且**不会自愈**，
   * 因为缓存从不失效。
   *
   * 判据是**盘说了算**：内存实例只在"它确实就是盘上那一份"时才可信。
   * `(size, mtimeMs)` 是**便宜的启发式**（一次 `stat`，微秒级），不是密码学保证 ——
   * 真正的保证来自下面两条一起：
   *   · **根治**：复合写里"交接物可见"与"登记可见"之间**不再有 await 点**
   *     （见 `submitHandoff` 里的 ★★），进程内再也观察不到半截状态；
   *   · **兜底**：本对账 —— 盘比内存新（别的实例 / 外部改动 / 跨上下文）就重载。
   */
  const cacheStamp = new Map()

  /**
   * ★ **最后一份"确实落盘成功"的内存快照**：taskId → 深拷贝。
   *
   * 为什么必须有它（本轮修 ②：`persist()` 落盘失败**不回滚内存**）：
   *   调用方（`transition` / `submitHandoff` / …）一律是**先改内存对象、再落盘**。
   *   而 `persist()` 早先只管写盘、不管回滚 ⇒ 写盘一失败（真单 T-20261011-214043
   *   的一次 `unblock`：`writeJsonAtomic → fs.rename` 抛 **EPERM**，
   *   调用链 `store/base.js 的 persist → store/lifecycle.js 的 transition → tools/dispatch.js`），
   *   形状就是「**内存已经改了、盘上没改**」——
   *   而且**不会自愈**：`cache` 从不失效，下一次 `loadTask` 命中缓存拿到的正是
   *   那份没落盘的内存 ⇒ 同一个 `unblock` 第二次回的是「已是开发中，不接受 unblock」。
   *
   *   有了这份快照，`persist()` 就能在写盘失败时把内存**回滚到改动前**：
   *   按定义，快照 == 盘上那一份（它就是上一次写成功的内容）。
   */
  const lastGood = new Map()

  /** 有限重试之间的等待（毫秒）。 */
  const PERSIST_RETRY_DELAY_MS = 40
  /**
   * 落盘重试次数。
   *
   * 为什么先重试再回滚：Windows 上 `rename` 抛 EPERM/EACCES/EBUSY 多半是**瞬时**的
   * （杀软 / 索引器 / 编辑器正握着 `task.json` 的句柄），隔几十毫秒再来一次常常就过了。
   * 重试仍然失败才认输 —— 认输时**一定**把内存退回去，绝不留下"内存改了、盘上没改"。
   */
  const PERSIST_RETRIES = 3

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 盘上 `task.json` 的指纹；读不到就 null（该任务可能还没落盘）。 */
  async function diskStampOf(taskId) {
    try {
      const { stat } = await import('node:fs/promises')
      const st = await stat(taskFile(taskId))
      return `${st.size}:${Math.round(st.mtimeMs)}`
    } catch {
      return null
    }
  }

  const taskDir = (id) => join(root, id)
  const taskFile = (id) => join(taskDir(id), 'task.json')
  const handoffDir = (id) => join(taskDir(id), 'handoffs')

/** 相对项目根的 POSIX 路径（写进记录，避免泄露绝对路径）。 */
const relKey = (root, abs) => relative(root, abs).replace(/\\/g, '/')
  const auditFile = (id) => join(taskDir(id), 'audit.jsonl')
  const artifactDir = (id, version) => join(taskDir(id), 'artifacts', version)

  /** 审计：一行一个动作，永不删除。 */
  async function audit(taskId, actor, action, detail) {
    const entry = { at: nowIso(now()), task_id: taskId, actor, action, ...detail }
    try {
      await appendJsonl(auditFile(taskId), entry)
    } catch {
      /* 审计写失败不该让主流程失败；内存里的 task.history 仍然有记录 */
    }
    return entry
  }

  /** 统一拒绝返回。 */
  const deny = (code, message, extra = {}) => ({ ok: false, code, error: message, ...extra })

  function requireTask(taskId) {
    const t = cache.get(taskId)
    if (t === undefined) return null
    return t
  }

  /**
   * ★ **登记自愈**：把「有交接物、没登记」的人工介入请求补回登记表。
   *
   * 为什么挂在 `loadTask` 这个**唯一公共入口**（而不是在收件箱 / 转告 / 答复
   * 各自入口各写一遍）：`loadTask` 是收件箱、转告、答复、状态查询、以及
   * `submitHandoff` 自己拿任务对象的**共同必经之路**。挂在别处就得在 N 个入口
   * 重复同一段判据，而"漏一处"正是这次事故的形状。
   *
   * -----------------------------------------------------------------------------
   * ★ 本轮修的那条漏路（真单 T-20261011-214043 / T-20261011-5a871c 现场）
   * -----------------------------------------------------------------------------
   * 上一轮把自愈**只挂在"读盘分支"**上（缓存命中直接 return，压根不走到这里）。
   * 但 `cache`（模块级 Map）在插件进程里**从不失效** —— `dropCache` 只有测试在用。
   * 于是形状是：**同一次运行里漏过一次登记 ⇒ 之后再也不会自愈**，
   * 收件箱永远「没有人工介入请求」、答复永远记不回，**只有重启才修得好**。
   * 而漏登记的真实成因就摆在那条路径上：交接物落盘（`appendHandoff`）与登记
   * 之间夹着好几段可抛异常/可提前 return 的代码，一中断就是"半截现场"。
   *
   * 所以：**两条分支都自愈**。没毛病时是纯读（`reconcileHumanRequests` 返回 0
   * ⇒ 不落盘、不写审计），"没毛病就不落盘"这条性质一个字没动。
   */
  async function healHumanRegistry(t) {
    if (t === null || typeof t !== 'object') return 0
    const recovered = reconcileHumanRequests(t)
    if (recovered === 0) return 0
    const aentry = await audit(t.id, ROLE.ORCHESTRATOR, 'human:recovered', {
      recovered,
      state: t.state,
      reason: '读任务时发现 human_request 交接物在盘上但登记表缺 —— 已按交接物反推补登记',
    })
    t.history.push(aentry)
    await persist(t)
    return recovered
  }

  /**
   * ★ **旧基线遗留判定的自愈**：把"拿旧基线算出来、却还挂在任务上"的闸门判定清掉。
   *
   * 为什么需要它（与"登记自愈"同源，都是**已在盘上的卡死单也要能救回来**）：
   *   `takeBaseline` 现在会按"重取基线 = 新起点"清零计数并作废旧判定 ——
   *   但**本次修复之前**重取过的单（真单 T-20261011-214043：14:46 判不过、
   *   14:50 重取基线 BL-64c1eb000b1f10bf，计数与 blocked 却留在了旧基线 BL-8f0ae2… 上）
   *   盘上就是这个形状，等不到下一次重取。
   *
   * 判据是**不可辩驳**的那一条、不靠猜：
   *   **`task.hash_gate.baseline_id !== task.baseline_current` ⇒ 这份判定属于一份
   *   已经不存在的基线** ⇒ 它既不能证明当前状态越界，也没有理由再拦"跑测试"。
   *   而计数与它同源（同一次判定写下的），一并按新起点归零。
   *
   * ⚠️ **一个字都没放宽**：清掉的只是"过期结论"。下一次 `dev_to_test` 会拿**当前**
   *    基线重新算一遍三类越界与"声明不实"，越界照拒、照计数、照在连续 N 次后交人工。
   * ⚠️ **不碰 `hash_gate_escalation`**：已经交到用户手上的单不会因为这条被悄悄撤回。
   *
   * 没毛病时**纯读**（不动、不落盘、不写审计）。
   *
   * @returns {boolean} 是否清了
   */
  async function healStaleHashGate(t) {
    if (t === null || typeof t !== 'object') return false
    const gate = t.hash_gate ?? null
    if (gate === null || typeof gate !== 'object') return false
    const gateBaseline = typeof gate.baseline_id === 'string' ? gate.baseline_id : null
    const cur = typeof t.baseline_current === 'string' ? t.baseline_current : null
    // 没有基线、或判定就是按当前基线算的 ⇒ 什么都不做（**纯读**）。
    if (gateBaseline === null || cur === null || gateBaseline === cur) return false

    const origin = resetHashGateOrigin(t, cur)
    if (origin.changed !== true) return false
    t.history.push(
      await audit(t.id, ROLE.PLANNER, 'gate:hash_reset', {
        // ⚠️ actor 记为**计划角色**：这是机制在读任务时自愈，不是谁下的命令
        //    （与 `human:recovered` 记 orchestrator 同源：都写真实来由，不冒名某个会话）。
        baseline_id: cur,
        stale_gate_baseline_id: gateBaseline,
        prev_streak: origin.prev_streak,
        now_streak: 0,
        prev_gate_blocked: origin.prev_gate_blocked,
        recovered_on_load: true,
        why:
          '读任务时发现闸门判定指向一份**已经不是当前**的基线（重取基线 = 新起点）——' +
          '该判定与它带来的连续计数按新基线重新起算；三类越界判定与"声明不实"一个字没放宽。',
      }),
    )
    await persist(t)
    return true
  }

  /**
   * ★★ **读任务（唯一公共入口）** —— 收件箱、转告、答复、状态查询、以及
   * `submitHandoff` 自己全都经它拿任务对象。
   *
   * 两条分支，**两条都要过对账**：
   *   · 缓存命中：先比 `cacheStamp` 与**当前**盘上指纹。不一致（盘比内存新）⇒
   *     **重载并替换缓存** —— 这就是「写进去了、读不到」那条漏路的堵法
   *     （读侧对账；详见 `cacheStamp` 的注释）；
   *   · 读盘：读完记下指纹。
   *
   * 两条分支读完都跑一次自愈（登记缺 ⇒ 补；闸门判定指向旧基线 ⇒ 清）。
   */
  async function loadTask(taskId) {
    const cached = cache.get(taskId)
    if (cached !== undefined) {
      // ★ **读前对账**：内存实例只在"它确实就是盘上那一份"时才可信。
      //   盘上更"新"（指纹变了）⇒ 丢掉内存那份、从盘重载。
      //   ⚠️ 这里**不会**误伤"本进程刚写完还没被读"的情形：`persist()` 落盘后
      //      立刻把指纹刷成盘上的实际值（见下），所以自己写的不会判成"盘更新"。
      const nowStamp = await diskStampOf(taskId)
      const known = cacheStamp.get(taskId)
      if (nowStamp !== null && known !== undefined && known !== nowStamp) {
        try {
          const fresh = await readJson(taskFile(taskId))
          cache.set(taskId, fresh)
          cacheStamp.set(taskId, nowStamp)
          await healHumanRegistry(fresh)
          await healStaleHashGate(fresh)
          // ★ 从盘上拿到的这份 = 盘上的内容 ⇒ 它天然就是"最后一份好的快照"
          //   （修 ② 的回滚点）。记在自愈之后：自愈可能已经落过盘。
          lastGood.set(taskId, structuredClone(fresh))
          return fresh
        } catch {
          /* 盘上那份读不动（正被替换中）⇒ 退回用内存这份，下一次读再对账 */
        }
      }
      // ★ 缓存命中也要自愈：缓存从不失效，漏过的那次不会再被"读盘"带上岸。
      await healHumanRegistry(cached)
      await healStaleHashGate(cached)
      return cached
    }
    const file = taskFile(taskId)
    if (!existsSync(file)) return null
    try {
      const t = await readJson(file)
      cache.set(taskId, t)
      /**
       * ★ 读盘时自愈一次（见上方 `healHumanRegistry` 的说明）。
       * 顺带解决"已经卡死的单"：兜底见下方 `reconcileHumanRequests`
       * （只补缺，绝不碰 answered / withdrawn）。
       */
      await healHumanRegistry(t)
      await healStaleHashGate(t)
      // ⚠️ 指纹记在**自愈之后** —— 自愈本身可能落盘（改了盘上的内容），
      //    先记会把"刚被自己改过的盘"当成别人的改动，下一次读白重载一遍。
      cacheStamp.set(taskId, await diskStampOf(taskId))
      // ★ 同上一处：盘上读来的这份就是"最后一份好的快照"（修 ② 的回滚点）。
      lastGood.set(taskId, structuredClone(t))
      return t
    } catch {
      return null
    }
  }

  /**
   * ★ **落盘**：写盘成功才算数；**写盘失败就把内存回滚到改动前**。
   *
   * 三条性质（本轮修 ② 的正反例就是照这三条判的）：
   *   ① 写成功 ⇒ 刷新盘上指纹 + 更新"最后一份好的快照"（正常路径，与改动前一致）；
   *   ② 写失败（重试 `PERSIST_RETRIES` 次仍失败）⇒ **内存 == 盘**：
   *      · 有快照 ⇒ 就地把**同一个对象**改回快照的样子（在途调用方正握着这个引用，
   *        换对象会让它和后续 `loadTask` 拿到两个实例，反而制造漂移）；
   *      · 没有快照（例如开单那一次就失败）⇒ 盘上不该有这个任务 ⇒ 从缓存里摘掉，
   *        下次读盘拿到的就是真相（`loadTask` 返回 null）；
   *   ③ 失败**明确报给调用方**：抛出的错误里写清"已重试几次 / 内存已回滚 / 没生效"。
   *
   * ⚠️ 这里**不吞**错误：调用方（`transition` / `submitHandoff` / …）本来就把异常
   *    往上抛，工具层如实报错 —— 这一点改动前是对的，一个字没改。
   */
  async function persist(task) {
    task.updated_at = nowIso(now())
    const rollback = lastGood.get(task.id) ?? null
    let lastErr = null
    for (let attempt = 1; attempt <= PERSIST_RETRIES; attempt++) {
      try {
        await writeJsonAtomic(taskFile(task.id), task)
        // ★ **写后刷新指纹**（"写后主动让缓存失效"的等价物）：内存这份就是我们刚写下去的
        //   那份 ⇒ 把指纹对齐，读前对账才不会把自己刚写的判成"盘更新"而白重载一次。
        //   （这里**不** `cache.delete`：在途的调用方正握着同一个对象，
        //     删缓存会让它和后续 `loadTask` 拿到两个对象，反而制造漂移。）
        cacheStamp.set(task.id, await diskStampOf(task.id))
        lastGood.set(task.id, structuredClone(task))
        return task
      } catch (err) {
        lastErr = err
        if (attempt < PERSIST_RETRIES) await sleep(PERSIST_RETRY_DELAY_MS)
      }
    }

    // --- 重试用尽 ⇒ **回滚内存**，绝不留"内存改了、盘上没改"的半截现场 ----------
    if (rollback === null) {
      cache.delete(task.id)
      cacheStamp.delete(task.id)
    } else {
      for (const k of Object.keys(task)) if (!Object.prototype.hasOwnProperty.call(rollback, k)) delete task[k]
      Object.assign(task, rollback)
      cacheStamp.set(task.id, await diskStampOf(task.id))
    }

    const code = lastErr?.code ?? 'PERSIST_FAILED'
    const e = new Error(
      `任务 ${task.id} 落盘失败（已重试 ${PERSIST_RETRIES} 次）：${code} ${lastErr?.message ?? lastErr}\n` +
        '★ **内存已回滚到改动前**（与盘上一致）—— 这次改动**没有生效**，不会留下"内存改了、盘上没改"的半截状态。\n' +
        '  常见成因：`task.json` 正被别的进程握着（杀软 / 索引器 / 编辑器）⇒ 关掉它再重试；' +
        '磁盘满或只读也会是这个形状。',
    )
    e.code = code
    e.persist_failed = true
    e.memory_rolled_back = true
    e.attempts = PERSIST_RETRIES
    throw e
  }

  /**
   * ★ **兜底（事后补）**：从「交接物 + 状态」反推出缺的那条人工介入登记。
   *
   * 现场：`pipeline_status` 列得出那份 `human_request` 交接物、状态也停在
   * `awaiting_human`，但登记表是空的 ⇒ 收件箱列不出、答复记不回 ⇒ 永久卡死。
   * 这个方法就是那把"把已卡死的单救回来"的钥匙。
   *
   * 刻意的三条约束：
   *   · **只补缺** —— 有完整登记的一律原样保留；
   *   · **不碰 answered / withdrawn** —— 那是"主对话不能自行把请求标记为已解决"
   *     这条反例的落点（有记录说明那条链走完了，不该被"修复"回 pending）；
   *   · **没毛病就是纯读** —— 这个函数会被 `loadTask` 每次都调一次，
   *     没问题时**不落盘**（返回 0，调用方什么都不做）。
   *
   * -----------------------------------------------------------------------------
   * ★ 本轮修的那条漏路：第 ② 步**不再**限定 `task.state === awaiting_human`
   * -----------------------------------------------------------------------------
   * 早先的判据是「**完全没有登记** **且** 任务停在 `awaiting_human`」才反推。
   * 但 `awaiting_human` 只有 **blocking=true** 的请求才进得去（见 `planAdvance`：
   * 「非阻塞请求照样进待办、照样要主对话转告，但不打断流程」）。
   * 于是 **blocking=false 的 human_request 一旦漏登记，就永远救不回来**：
   * 状态不在等待态 ⇒ 判据不成立 ⇒ 收件箱照旧列不出、答复照旧记不回。
   *
   * 这不是假想的角落 —— 真单里点名"取不出来"的三条交接物
   * （`H-8411d229ed7e1ae7` / `H-4b0ec20e3bc9c52e` / `H-b7f6a9c75eb23ae6`）
   * **payload.blocking 全是 false**，而旧判据对它们**一条都盖不住**。
   *
   * 新的判据只留一条、而且是不可辩驳的那一条：
   *   **「盘上有一份 human_request 交接物，登记表里却没有对应条目」= 一次没写完的登记。**
   * 它与任务当时在什么状态无关（阻塞、非阻塞、已经恢复过，都一样是漏写）。
   * 交接待物是**不可变原件**，所以按它重建不会引入任何新信息；
   * 而"答复过的 / 撤回过的"本来就**有**条目（`answered` / `withdrawn`），
   * 压根落不进"完全没有登记"这一档 ⇒ 不会被"修复"回 pending。
   *
   * ⚠️ 这不是放宽：`awaiting_human` 那句从来没起过"防伪"作用 —— 它只是漏掉了
   *    非阻塞请求。反例（不许覆盖已有记录 / 主对话不能自行标记已解决）一个字没动。
   *
   * @returns {number} 本次补了几条（0 = 什么都没干，也没落盘）
   */
  function reconcileHumanRequests(task) {
    if (task === null || typeof task !== 'object') return 0
    const handoffs = Array.isArray(task.handoffs) ? task.handoffs : []
    const requests = handoffs.filter((h) => h !== null && typeof h === 'object' && h.kind === 'human_request')
    if (requests.length === 0) return 0
    // ⚠️ 这个函数会被 `loadTask` **每次都调一次**（含缓存命中的纯读路径）——
    //    所以"确认真要补之前"**一个字节都不许动**（连 `task.human_requests = []`
    //    这种兜底赋值都不做），"没毛病就是纯读"才是真的。
    const list = Array.isArray(task.human_requests) ? task.human_requests : []

    // 先看一眼有没有活要干 —— 没问题时必须纯读、不落盘。
    const orphans = requests.filter((h) => !list.some((r) => r.handoff_id === h.handoff_id))
    const partial = requests.some((h) => {
      const found = list.find((r) => r.handoff_id === h.handoff_id)
      return found !== undefined && found.question_for_human === undefined
    })
    if (orphans.length === 0 && !partial) return 0
    // 真要补了才把容器补齐（老任务可能压根没有这个字段）。
    if (!Array.isArray(task.human_requests)) task.human_requests = list

    let recovered = 0

    // --- ① 有登记但缺本体（`question_for_human` 是这条请求的本体）-----------
    for (const record of requests) {
      const found = list.find((r) => r.handoff_id === record.handoff_id)
      if (found === undefined || found.question_for_human !== undefined) continue
      const rebuilt = buildHumanRequestEntry(task, record, record.payload ?? {}, timeoutHours)
      // ★ 只补**缺**的字段：已经走过的生命周期（转告/答复/恢复）原样保留。
      const kept = {}
      for (const k of Object.keys(rebuilt)) {
        if (found[k] !== undefined && found[k] !== null && found[k] !== '') kept[k] = found[k]
      }
      list[list.indexOf(found)] = { ...rebuilt, ...kept, recovered_from_handoff: true }
      recovered += 1
    }

    // --- ② 完全没有登记的那些（卡死现场就是这一种；阻塞与非阻塞都在内）-------
    for (const record of orphans) {
      // 双保险：上面 ① 刚补过的那几条已经进了 list，别再建第二条。
      if (list.some((r) => r.handoff_id === record.handoff_id)) continue
      const entry = buildHumanRequestEntry(task, record, record.payload ?? {}, timeoutHours)
      entry.recovered_from_handoff = true
      list.push(entry)
      recovered += 1
    }

    return recovered
  }

  /**
   * 取任务里"当前有效制品版本"。
   * 规则：最近一次 `dev_to_test` 交接物的 artifact_version。
   */
  function currentArtifactVersion(task) {
    for (let i = task.handoffs.length - 1; i >= 0; i--) {
      const h = task.handoffs[i]
      if (h.kind === 'dev_to_test' && typeof h.artifact_version === 'string') return h.artifact_version
    }
    return null
  }

  /** 最近一次某 kind 的交接物。 */
  function lastHandoff(task, kind) {
    for (let i = task.handoffs.length - 1; i >= 0; i--) {
      if (task.handoffs[i].kind === kind) return task.handoffs[i]
    }
    return null
  }

  return {
    projectRoot,
    dirName,
    root,
    maxRework,
    seatSilence,
    hashGateEscalateAfter,
    anchorOf,
    cmpKey,
    scopeAbsKey,
    baselineAbsKey,
    scopeRelOf,
    timeoutHours,
    requireHumanConfirmCode,
    maxClarifyRounds,
    now,
    MAX_REJECTED_PAYLOAD_CHARS,
    cache,
    cacheStamp,
    taskDir,
    taskFile,
    handoffDir,
    relKey,
    auditFile,
    artifactDir,
    audit,
    deny,
    requireTask,
    loadTask,
    persist,
    reconcileHumanRequests,
    currentArtifactVersion,
    lastHandoff,
  }
}
