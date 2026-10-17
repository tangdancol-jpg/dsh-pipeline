/**
 * dsh-pipeline · 守门 · 席位分区与改动面
 * ============================================================================
 * 从 `lib/guard.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/guard.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/guard/seats
 */

import { isInside, PACKAGE_ROOT, pathKey, resolveAgainstAnchor, toStringArray } from '../util.js'
import { describeScopePaths, resolveScopePath } from '../scope/root-marker.js'

/** 从 exec 里取调用方的 agent id（`agent.id === agent.session.id`，见 dsh-agent:511）。 */
export function agentIdOf(exec) {
  const a = exec?.agent
  if (a === null || a === undefined) return null
  if (typeof a === 'string') return a
  const id = a.id ?? a.session?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

// ---------------------------------------------------------------------------
// ★编写席位的分区判定（守门用，必须同步）
// ---------------------------------------------------------------------------

/**
 * ★ **授权面锚点**：`scope_paths` / `change_scope[].path` 里写的**裸相对路径**按谁解析。
 *
 * 为什么要有这个概念（真单 T-20261011-214043 实测）：
 *   计划的授权面写的是**插件包内相对路径**（`index.js`、`lib/tools.js`、`tests/`），
 *   而真正要改的文件在 `<工作区根>/node_modules/dsh-pipeline/` 之下。
 *   早先这里拿 `task.projectRoot`（工作区根）当基准 ⇒ 20 条授权**条条落空**，
 *   三个编写席全被挡死（本单交付面 = 0）；反过来，工作区根下**恰好同名**的
 *   `package.json` / `cordis.patch.yml` 又会被**误放行**（越界清单点名禁改的那两份）。
 *
 * 取值优先级（**都是显式的，绝不从授权面自身推断**）：
 *   ① 显式锚点：`task.scope_anchor`，其次 `config.changeScopeAnchor`（调用方按这个顺序挑一个传进来）；
 *      相对写法按**项目根**解析；
 *   ② 没配锚点 ⇒ **本任务的项目根**（缺陷 ①，2026-10-17）；
 *   ③ 连项目根都拿不到 ⇒ 才退回 {@link PACKAGE_ROOT}（最后手段）。
 *
 * ★ 缺陷 ① 之前，②③ 是反的：没配锚点就落到插件包根。现场 T-20261016-ff9ba7 的
 *   `scope_anchor = ""`、计划写 `hello-dsh-pipeline/` ⇒ 被解析成插件包里的路径 ⇒ 编写三连拒。
 *   "计划里写相对路径"是最自然的写法，每个新项目都会再踩一次；而"用流水线改插件自己"
 *   （T-20261011-214043 那种）现在要**显式**配锚点（或把路径写全 `node_modules/dsh-pipeline/…`）。
 *
 * @param {string} raw - 显式给的锚点（可为空）
 * @param {{projectRoot?:string|null}} [opts]
 * @returns {string} pathKey 形式的绝对锚点
 */
export function resolveScopeAnchor(raw, { projectRoot = null } = {}) {
  const s = String(raw ?? '').trim()
  const root = typeof projectRoot === 'string' && projectRoot.trim().length > 0 ? pathKey(projectRoot) : null
  if (s.length > 0) return pathKey(resolveAgainstAnchor(root ?? PACKAGE_ROOT, s))
  return root ?? PACKAGE_ROOT
}

/**
 * 把一条 scope_path 归一化成可与绝对路径比较的形式。
 *
 * ★ 两条基准（见 `lib/scope/root-marker.js`）：
 *   · 根标记 `'.'` ⇒ **本任务的 `project_root`**（所有渲染口径都把它读作"整棵项目根"）；
 *   · 其它裸相对路径 ⇒ **锚点**（改前行为，一个字没动）。
 *   ★ 调用方没给 `projectRoot` 时退回改前行为（`'.'` → 锚点）—— 既有三参数调用逐字不变。
 */
function normScopePath(raw, anchor, projectRoot) {
  const a = typeof anchor === 'string' && anchor.length > 0 ? anchor : PACKAGE_ROOT
  return resolveScopePath(raw, { anchor: a, projectRoot })
}

/**
 * 找出某个绝对路径归属于哪个席位。
 *
 * @param {Array} parts - `roster.writers.partitions`
 * @param {string} absPath
 * @param {string} anchor - 授权面锚点（分区里的裸相对路径按它解析）
 * @param {string} [projectRoot] - ★ 本任务的项目根（`'.'` 这个根标记的落点）
 * @returns {{seat:string, matched:string, overlaps:string[]} | null}
 */
export function owningSeat(parts, absPath, anchor, projectRoot) {
  const hits = []
  for (const p of parts) {
    for (const raw of p.scope_paths ?? []) {
      const abs = normScopePath(raw, anchor, projectRoot)
      if (pathKey(abs) === pathKey(absPath) || isInside(abs, absPath)) {
        hits.push({ seat: p.seat, matched: raw })
        break
      }
    }
  }
  if (hits.length === 0) return null
  // 多条命中 = 分区表有重叠（编排层本应拦下）；兜底时取第一条并回报其余。
  return { seat: hits[0].seat, matched: hits[0].matched, overlaps: hits.slice(1).map((h) => h.seat) }
}

/** 把某个席位的范围渲染成人话（拒绝文案里用）。 */
export function describeSeat(parts, seat, projectRoot) {
  void projectRoot
  const p = parts.find((x) => x.seat === seat)
  if (p === undefined) return '(不在册)'
  return describeScopePaths(p.scope_paths)
}

/** 把全部分区渲染成多行（拒绝文案里用）。 */
export function describePartitions(parts, projectRoot) {
  void projectRoot
  return parts.map((p) => `  · ${p.seat}：${describeScopePaths(p.scope_paths)}`).join('\n')
}

/**
 * 把授权改动面渲染成多行（拒绝文案里用）。
 *
 * ★ 裸相对路径要**连解析结果一起打出来**：授权面写的是 `index.js` 这种包内相对路径，
 *   光看它没人知道守门到底拿它跟哪个绝对路径比 —— 真单 T-20261011-214043 上
 *   就是"看着授权了、实际条条落空"，而拒绝文案里看不出这一点。
 */
export function describeChangeScope(scope, anchor, projectRoot) {
  return (Array.isArray(scope) ? scope : [])
    .map((e) => {
      const raw = String(e?.path ?? '?')
      const abs = resolveScopePath(raw, { anchor, projectRoot })
      const shown = abs.length > 0 && abs !== raw ? ` → ${abs}` : ''
      return `  · ${e?.id ?? '?'}　${e?.action ?? '?'}　${raw}${shown}${e?.why ? `（${e.why}）` : ''}`
    })
    .join('\n')
}

/**
 * 组合两个守卫，用于自测验证"单调语义不会被互相翻转"。
 *
 * 语义与 `ToolLayer.guardReason`（`dsh-tools/lib/index.js:2646`）一致：
 * 取**第一个非 undefined** 的返回值；谁都不能把别人的拒绝改回允许。
 *
 * @param {...((exec:object)=>string|undefined)} guards
 * @returns {(exec:object)=>string|undefined}
 */
export function composeGuards(...guards) {
  return (exec) => {
    for (const g of guards) {
      if (typeof g !== 'function') continue
      const reason = g(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }
}

/** 供测试与文档引用：受保护路径的判定逻辑（与 store 保持一致）。 */
export function isProtectedPath(task, absPath) {
  if (task === null || typeof task !== 'object') return false
  const p = pathKey(absPath)
  if (p.length === 0) return false
  if (!isInside(task.projectRoot, p)) return false
  return !isInside(task.pipelineDir, p)
}

/**
 * 构造一条同步任务索引记录。
 *
 * `reportsDir` **必须带 taskId**：非编写角色唯一被允许写的位置是
 * `<项目>/.pipeline/<任务id>/reports/`，而不是整个 `.pipeline/`。
 * 少了这一段，测试就能往别人的任务目录里写 —— 多任务隔离就破了。
 *
 * `writers` 是角色清单里的编写席位方案。守门要靠它判"这个席位有没有越界写别人的分区"，
 * 而守门是**同步**的（`guardReason` 同步遍历），所以必须放在这份内存索引里。
 *
 * @param {object} input
 * @param {string} input.taskId
 * @param {string} input.projectRoot
 * @param {string} input.pipelineDir
 * @param {object|null} [input.writers] - `roster.writers`
 * @param {object[]|null} [input.changeScope] - `task.change_scope`（计划的授权改动面）
 * @param {string|null} [input.scopeAnchor] - ★ 授权面锚点（裸相对路径按它解析，见 {@link resolveScopeAnchor}）
 */
/**
 * ★ **任务自己的目录** = `<项目>/.pipeline` 与任务 id 的拼接（**唯一一处公式**）。
 *
 * 为什么单独导出一个函数：能力额度台账（`lib/guard/grant.js`）与工具层
 * （`lib/tools/capability.js`）都要落在这个目录下。公式手抄第二份就是漂移的入口 ——
 * 而这里漂移的后果是"台账落到了另一个地方"，也就是**额度查不到**（fail-closed 会拒，
 * 但用户会看到"申请了却放行不了"）。
 *
 * @param {string} pipelineDir
 * @param {string} taskId
 * @returns {string}
 */
/**
 * ★ **从同步索引里取任务**（原来写在 `decide.js` 里；2026-10-16 因**行数纪律**搬到这儿）。
 *
 * 守门必须同步判定，而任务数据在盘上、读取是异步的 —— 所以索引是"缓存"，
 * **取不到就是取不到**。取不到时靠 `task.projectRoot / taskSelfDir / writers` 的判据
 * 都会**静默跳过**（fail-open）。这里刻意**不改成 fail-closed**：索引为空是"还没热身"，
 * 不是"调用方可疑"；一次误拦会打断正当工作。但**绝不能静默** —— 所以回调
 * `onMissingTask` 留痕，让"这段判据没跑到"这件事在日志里看得见。
 *
 * @param {{deps:object, tool:string, bindingOf:()=>object|null}} opts
 * @returns {(taskId:string)=>object|null}
 */
export function makeTaskOf({ deps, tool, bindingOf }) {
  return (taskId) => {
    const t = deps?.taskIndex?.get(taskId) ?? null
    if (t === null && typeof deps?.onMissingTask === 'function') {
      try {
        const binding = typeof bindingOf === 'function' ? bindingOf() : null
        deps.onMissingTask({ taskId, tool, role: binding?.role ?? null, seat: binding?.seat ?? null })
      } catch {
        /* 留痕失败绝不该影响判定 */
      }
    }
    return t
  }
}
export function taskSelfDirOf(pipelineDir, taskId) {
  return `${pathKey(pipelineDir)}/${String(taskId).toLowerCase()}`
}

export function makeTaskIndexEntry({ taskId, projectRoot, pipelineDir, scopeAnchor = null, writers = null, changeScope = null, fullTest = null, hashGateBlocked = false, hashGate = null, hashGateEscalated = false, hubEnabled = false, hubStandby = null, devDelivered = false, terminal = false }) {
  const pipeline = pathKey(pipelineDir)
  const self = taskSelfDirOf(pipeline, taskId)
  return {
    taskId,
    projectRoot: pathKey(projectRoot),
    pipelineDir: pipeline,
    reportsDir: `${self}/reports`,
    /**
     * ★ 任务自己的目录 —— 流水线台账（task.json / handoffs / artifacts / reports / records）
     * 都在这儿。它**不是项目源码**，所以不属于任何编写席位的"那一段"。
     */
    taskSelfDir: self,
    /** ★ 分权落档的记录目录（各写各的，留档 AI 汇总）。 */
    recordsDir: `${self}/records`,
    /**
     * ★ **授权面锚点**（设计目的：最小改动）。
     *
     * `writers.partitions[].scope_paths` 与 `change_scope[].path` 里的**裸相对路径**
     * 一律按它解析 —— 默认是**插件包根**，不是 `projectRoot`（工作区根）。
     * 理由与真单实测见 {@link resolveScopeAnchor}。
     *
     * 它必须进这张同步索引：守门在 `guardReason` 里**同步**判"这次写入有没有超出授权"，
     * 运行时读不到盘。**按任务各存一份**，所以一个任务的锚点不会影响另一个任务的判定。
     */
    scopeAnchor: resolveScopeAnchor(scopeAnchor, { projectRoot }),
    writers: writers ?? null,
    /**
     * ★ 授权改动面（设计目的：最小改动）。
     *
     * 守门要**同步**判"这次写入有没有超出计划给的授权"，所以它和 `writers` 一样
     * 必须放在这张内存索引里。`null` = 本任务没有授权面（L0 没有计划这一站）⇒ 该判据弃权。
     */
    changeScope: Array.isArray(changeScope) && changeScope.length > 0 ? changeScope : null,
    /**
     * ★ **全量测试的放行凭据**（设计目的：别把整套测试当家常便饭）。
     *
     * 形状见 `lib/testscope.js` 的 `fullTestCredential()`：
     * `{ approval_id, round, command, scope, what_will_run }` 或 `null`。
     * 与 `changeScope` 同样必须进这张内存索引 —— 守门是**同步**的，运行时读不到盘。
     */
    fullTest: fullTest !== null && typeof fullTest === 'object' ? fullTest : null,
    /**
     * ★ **哈希前置闸门**是否正卡着（设计目的：哈希不过 ⇒ 直接打回，测试不跑）。
     *
     * 守门要在 shell 那一层**同步**判"这一刻许不许跑测试"，所以它必须进索引。
     * hashGate 只带 violations（拒绝文案要列出来），不带全量明细 —— 那在审计里。
     */
    hashGateBlocked: hashGateBlocked === true,
    hashGate: hashGate !== null && typeof hashGate === 'object' ? hashGate : null,
    /**
     * ★ 这道闸是不是**已经连续不过到阈值、交人工了**（用户拍板 P13）。
     *
     * 它只改**拒绝文案**（是"你回去改"还是"已经交人工了，等人回话"），
     * 不改放行/拦截的结论 —— 拦截仍然由 `hashGateBlocked` 决定。
     * 与其它字段一样必须进索引：守门是同步的，运行时读不到盘。
     */
    hashGateEscalated: hashGateEscalated === true,
    /**
     * ★★ **主管枢纽面**（T-20261011-56a37e）。
     *
     * 守门要在**文件工具**与**shell 测试命令**两层同步判"这个席位是不是还在待机"、
     * "编写交付了没有"，所以这两件事必须进这张内存索引（运行时读不到盘）。
     *
     * `hubStandby`：`[{role, wake_point, status:'standby'|'woken'}]`；
     * `devDelivered`：本任务是否已有编写交付（`dev_to_test`）——
     *   它是"测试位在编写交付之前不许开跑"这条判据的唯一输入。
     */
    hubEnabled: hubEnabled === true,
    hubStandby: Array.isArray(hubStandby) ? hubStandby : [],
    devDelivered: devDelivered === true,
    /** ★ 任务已到终态（关单 / 取消）—— 一个会话同时绑着多张单时，守门据此不再拿它的规则去判新命令。 */
    terminal: terminal === true,
  }
}

/**
 * ★ 一个会话**此刻**该按哪张单的规则判（守门用）。
 *
 * 主对话会话为它开过 / 认领过的每一张单各持一枚 `main` 令牌，而 `tokens.roleOfAgent(agentId)`
 * 按令牌表的插入顺序返回**第一条** ⇒ 守门拿**最老的那张单**（项目根、授权面、单号）去判新命令，
 * 拒绝文案里点的也是那张早就没在动的单（P1-4 的"作用域放大"）。
 *
 * 取法：先排除已到终态的单；剩下的取**最近绑定**的那一张。全是终态单时退回最近绑定的那张。
 * 令牌表不提供 `bindingsOfAgent`（测试替身 / 老实现）时，行为与改前相同。
 *
 * @param {{roleOfAgent:Function, bindingsOfAgent?:Function}} tokens
 * @param {string|null} agentId
 * @param {{get:(id:string)=>any}|null} [taskIndex]
 * @returns {{taskId:string, role:string, seat:string|null, token:string}|null}
 */
export function bindingForAgent(tokens, agentId, taskIndex = null) {
  if (agentId === null || agentId === undefined) return null
  if (typeof tokens?.bindingsOfAgent !== 'function') return tokens.roleOfAgent(agentId, undefined)
  const all = tokens.bindingsOfAgent(agentId)
  if (all.length <= 1) return all[0] ?? null
  const live = all.filter((b) => taskIndex?.get?.(b.taskId)?.terminal !== true)
  const pool = live.length > 0 ? live : all
  return pool.reduce((a, b) => (b.issuedAt >= a.issuedAt ? b : a))
}

/**
 * ★★ 待机席位此刻**允不允许产出**（守门侧的纯判据；T-20261011-56a37e）。
 *
 * 与 `store.js` 里交接物面那道判据**同一份数据**（`task.hub.standby`），
 * 只是执法点不同：那边拦的是"交产物"，这边拦的是"写自己目录的报告"。
 * 两道都落才叫"纳入既有判据面"（安全预审阻断项 B3 的原话）。
 *
 * @param {object|null} task - 同步索引条目
 * @param {string} role
 * @returns {{blocked:false} | {blocked:true, entry:object, wake_point:string}}
 */
export function hubStandbyBlocksWrite(task, role) {
  if (task === null || task.hubEnabled !== true) return { blocked: false }
  const list = Array.isArray(task.hubStandby) ? task.hubStandby : []
  const e = list.find((s) => s !== null && typeof s === 'object' && s.role === role) ?? null
  if (e === null) return { blocked: false }
  if (e.status === 'woken') return { blocked: false }
  return { blocked: true, entry: e, wake_point: String(e.wake_point ?? '') }
}

/**
 * ★ 找出某个绝对路径落在**哪一条授权改动面**里。
 *
 * 判据：绝对路径等于授权路径，或位于它之下（授权一个目录 = 授权它底下所有文件）。
 * 归一化后比较（Windows 上大小写与反斜杠都要先抹平）。
 *
 * ★ 授权面里的**裸相对路径按 `anchor` 解析**（不是按工作区根）—— 见 {@link resolveScopeAnchor}。
 *   拿工作区根拼裸相对路径会让 20 条授权条条落空（真单 T-20261011-214043 实测），
 *   而工作区根下恰好同名的 `package.json` / `cordis.patch.yml` 又会被误放行。
 *
 * @param {object[]} scope - `task.change_scope`
 * @param {string} absPath
 * @param {string} anchor - 授权面锚点
 * @param {string} [projectRoot] - ★ 本任务的项目根（`'.'` 这个根标记的落点，同 {@link owningSeat}）
 * @returns {{id:string, path:string, action:string} | null}
 */
export function owningChangeScopeEntry(scope, absPath, anchor, projectRoot) {
  const target = pathKey(absPath)
  for (const e of Array.isArray(scope) ? scope : []) {
    const raw = String(e?.path ?? '').trim()
    if (raw.length === 0) continue
    const abs = normScopePath(raw, anchor, projectRoot)
    if (abs === target || isInside(abs, target)) {
      return { id: String(e?.id ?? ''), path: raw, action: String(e?.action ?? '') }
    }
  }
  return null
}

/** 把 字符串/字符串数组 归一化（配置里允许两种写法）。 */
export function normalizeToolList(v) {
  return toStringArray(v)
}
