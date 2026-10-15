// 把宿主交来的工具结果折成**一行人话** —— `[object Object]` 这类"摘要"的唯一修法就在这里。
/**
 * dsh-pipeline · 记忆 · 结果摘要（宿主信封 → 人话）
 * ============================================================================
 * ★★ 缺陷现场（真机，2026-10-15，重启后的 DSH 实测）：
 * ```
 * 2026-10-15T16:36:57.504Z 〔tool〕工具 pipeline_status 完成：[object Object]
 * 2026-10-15T16:36:57.499Z 〔tool〕(T-…bb30bc) 工具 pipeline_recall 完成（任务 T-…bb30bc）：[object Object]
 * ```
 * 记忆**攒下来了**，但那一行谁也读不懂：关键词路检索不到任何东西 ⇒ **等于白攒**。
 *
 * ---------------------------------------------------------------------------
 * 根因：`tools/post-execute` 交来的**不是工具的返回值**，是宿主的信封
 * ---------------------------------------------------------------------------
 * 三条判据（互相独立，任一条就够定案）：
 *   ① 宿主自己的类型声明（`app.asar` 里）：`ToolExecutionResult = Success | Failure`，
 *        `Success { isError:false, value:JsonValue, content:ContentBlock[] }`
 *        `Failure { isError:true,  error:ToolFailure, content:ContentBlock[] }`
 *      而 `tools/post-execute` 的签名逐字是 `(exec, result: Readonly<ToolExecutionResult>, next)`
 *      —— 所以 `result` 是信封，工具的返回值在 `result.value` 上。
 *   ② 真机记忆库那两行的**形状指纹**：`content,isError,value`
 *      （`Object.keys(result).sort()`）—— 信封的三个键，一个不多一个不少。
 *   ③ 于是 `result.summary` **永远**是 undefined，`String(result.value)` 就是
 *      `[object Object]` —— 现场那两行正文与 `id` 都长这个样子。
 *      ★ 连带后果：去重键的兜底也退化成 `…|content,isError,value|[object Object]`，
 *        于是**所有** `pipeline_status` 调用共用一把键 —— 第二次起全被当重复丢掉。
 *
 * ---------------------------------------------------------------------------
 * 摘要的确定形状（每个字段都给了判据，不是"我觉得"）
 * ---------------------------------------------------------------------------
 *   正文一行：`工具 <名> <完成|失败>（任务 <id>）：<body>`
 *     · `<名>` —— 工具名：它是"这是哪一类事实"的判据（`shouldRetain` 用的也是它）
 *     · `<id>` —— 任务 id：记忆是**按任务**取回的（`task:<id>` 是天然主键，`refs` 也存它）
 *     · `<body>` —— 见下面的固定优先级
 *   `refs`（任务 / 状态 / 交接物 / 制品）走**结构化字段**，不塞进正文当装饰 ——
 *   `record.js` 文件头的形状规定就是这么划的："一行摘要给关键词路，结构化引用给程序化调用方"。
 *
 *   `<body>` 的取值优先级（**固定顺序**，判据 ="离人话有多近"）：
 *     ① `value.summary` 非空字符串 —— 本插件每个工具面的**统一**可读摘要
 *        （`kit.js` 的 `renderSummary` 读的就是它；`output.schema` 里 `summary: S('string', …)`）
 *     ② `value.summary` 是对象/数组 ⇒ {@link stableJson} —— 双语摘要之类的确会这样长
 *     ③ `value.value` 非空字符串 —— 少数只回一个字符串的工具
 *     ④ 失败信封的 `error.message` —— 失败时唯一有内容的字段
 *     ⑤ `content[]` 里的 text —— 宿主**已经渲染好、模型实际看到**的那一段
 *     ⑥ {@link stableJson}（兜底）—— 绝不再落到 `String(对象)`
 *   ★ **绝不用 `String(对象)`**：对象/数组一律走 {@link stableJson}（键序固定 ⇒
 *     同输入同输出 ⇒ 去重键才是确定性的）。这是本文件存在的全部理由。
 *
 * ---------------------------------------------------------------------------
 * 截断策略（默认值**明写**在这里；调用方不许各写一份）
 * ---------------------------------------------------------------------------
 *   · {@link DIGEST_TEXT_MAX}      = 160 —— 正文上限（**沿用改动前那个 160**：不缩不放）
 *   · {@link DIGEST_JSON_MAX}      = 120 —— 兜底 JSON 的上限（比正文短：它是"读不出人话"时的兜底）
 *   · {@link DIGEST_STR_MAX}       =  40 —— 兜底 JSON 里**单个字符串值**的上限
 *   · {@link DIGEST_DEPTH_MAX}     =   2 —— 递归深度（更深只留 `{…}` / `[…N]`）
 *   · {@link DIGEST_ITEM_MAX}      =   4 —— 对象/数组每层最多列几项，其余折成 `…+N`
 *   · {@link DIGEST_KEY_MAX}       = 120 —— 去重键的上限（沿用改动前的 `clip(…,120)`）
 *   · {@link DIGEST_DISC_BODY_MAX} =  80 —— 去重键里那一截正文（沿用改动前的 80）
 *   ★ 全部是**上限**：短内容一个字节都不补（不补齐、不加省略号）。
 *   ★ 截断一律过 `clip()`：换行折空格（JSONL 一行一条）、超长补 `…`。
 *
 * ★ 本文件是**纯函数**：没有 `fs`、没有 `Date.now()`、没有随机数。
 *
 * @module dsh-pipeline/lib/memory/digest
 */

import { clip } from './record.js'

/** 正文（`工具 …：<body>` 那一行）的上限。 */
export const DIGEST_TEXT_MAX = 160

/** 兜底 JSON 的上限。 */
export const DIGEST_JSON_MAX = 120

/** 兜底 JSON 里单个字符串值的上限。 */
export const DIGEST_STR_MAX = 40

/** 兜底 JSON 的递归深度上限。 */
export const DIGEST_DEPTH_MAX = 2

/** 兜底 JSON 每层最多列几项（其余折成 `…+N`）。 */
export const DIGEST_ITEM_MAX = 4

/** 去重键的整体上限。 */
export const DIGEST_KEY_MAX = 120

/** 去重键里那一截正文的上限。 */
export const DIGEST_DISC_BODY_MAX = 80

/**
 * 兜底 JSON 里**排在前面**的关键字段（固定顺序）；其余键按字典序。
 *
 * 为什么是这些：它们正是 `refs` 与取回时要用到的判别子（任务 / 状态 / 交接物 / 制品 /
 * 条数 / token / 原因 / 结论）。放在前面 = 超长截断时先保住它们。
 */
export const DIGEST_KEY_FIELDS = Object.freeze([
  'ok',
  'task_id',
  'state',
  'handoff_id',
  'artifact_version',
  'count',
  'tokens',
  'limit',
  'reason',
  'verdict',
  'summary',
])

/** 去重键里取哪些字段（**沿用改动前那一份清单**，一个都没少 —— 别在这里放宽判别力）。 */
export const DIGEST_DISC_FIELDS = Object.freeze([
  'handoff_id',
  'event',
  'artifact_version',
  'state',
  'from',
  'to',
  'change_id',
  'moved_to',
])

/** 是"普通对象"（不是 null、不是数组）。 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * ★ 这一个是**宿主信封**吗（判据见文件头：`isError` / `value` / `content` 三者有其一）。
 *
 * 为什么用"有其一"而不是"三缺一不可"：信封在演进（`meta` / `additionalContexts`
 * 是可选的），而**裸值**恰好相反 —— 本插件的工具返回值里不会有 `isError`，
 * 也很少直接带 `content`。这个判据宁可把裸值当信封（那时会退到 `content`/兜底 JSON），
 * 也不要把信封当裸值（那正是 `[object Object]` 的来源）。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEnvelope(value) {
  return isPlainObject(value) && (Object.hasOwn(value, 'isError') || Object.hasOwn(value, 'value') || Object.hasOwn(value, 'content'))
}

/**
 * ★ 把信封拆开；**不是信封就按裸值处理**（既有夹具与别处调用方照旧）。
 *
 * @param {unknown} result
 * @returns {{envelope:boolean, failed:boolean, value:*, error:string, content:string[]}}
 */
export function unwrapResult(result) {
  if (!isEnvelope(result)) {
    return { envelope: false, failed: false, value: result ?? null, error: '', content: [] }
  }
  const blocks = Array.isArray(result.content) ? result.content : []
  const content = blocks
    .map((b) => (isPlainObject(b) && b.type === 'text' ? String(b.text ?? '') : ''))
    .filter((s) => s.length > 0)
  return {
    envelope: true,
    failed: result.isError === true,
    value: result.value ?? null,
    error: String(result.error?.message ?? result.error?.info?.message ?? ''),
    content,
  }
}

/**
 * ★ **绝不出 `[object Object]`** 的取值：标量直取，对象/数组走稳定序列化。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function scalarText(value) {
  if (value === null || value === undefined) return ''
  const t = typeof value
  if (t === 'string') return value
  if (t === 'number') return Number.isFinite(value) ? String(value) : ''
  if (t === 'boolean' || t === 'bigint') return String(value)
  return stableJson(value)
}

/** 关键字段在前、其余按字典序 —— 一个**全序**，所以同输入必同输出。 */
function orderedKeys(value, first) {
  const rank = new Map(first.map((k, i) => [k, i]))
  return Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort((a, b) => {
      const ra = rank.has(a) ? rank.get(a) : Number.MAX_SAFE_INTEGER
      const rb = rank.has(b) ? rank.get(b) : Number.MAX_SAFE_INTEGER
      if (ra !== rb) return ra - rb
      return a < b ? -1 : a > b ? 1 : 0
    })
}

function posInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function render(value, depth, o) {
  if (value === null || value === undefined) return 'null'
  const t = typeof value
  if (t === 'string') return JSON.stringify(clip(value, o.strMax))
  if (t === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'bigint') return String(value)
  if (t !== 'object') return 'null' // function / symbol
  if (depth >= o.depthMax) return Array.isArray(value) ? `[…${value.length}]` : '{…}'
  if (Array.isArray(value)) {
    const head = value.slice(0, o.itemMax).map((x) => render(x, depth + 1, o))
    const rest = value.length - head.length
    return `[${head.join(',')}${rest > 0 ? `,…+${rest}` : ''}]`
  }
  const keys = orderedKeys(value, o.first)
  const head = keys.slice(0, o.itemMax).map((k) => `${JSON.stringify(String(k))}:${render(value[k], depth + 1, o)}`)
  const rest = keys.length - head.length
  return `{${head.join(',')}${rest > 0 ? `,…+${rest}` : ''}}`
}

/**
 * ★ **稳定序列化**：键序固定（关键字段在前 + 其余字典序）、深度/条数/字符串长度都有上限。
 *
 * 为什么不用 `JSON.stringify`：① 它跟着**插入顺序**走 ⇒ 同一个对象、键序不同 ⇒ 不同字符串
 * ⇒ 去重键不稳定；② 它没有深度/长度上限 ⇒ 一行能把记忆库撑爆。
 *
 * @param {unknown} value
 * @param {{max?:number, strMax?:number, depthMax?:number, itemMax?:number, first?:string[]}} [opts]
 * @returns {string}
 */
export function stableJson(value, opts = {}) {
  const o = {
    max: posInt(opts.max, DIGEST_JSON_MAX),
    strMax: posInt(opts.strMax, DIGEST_STR_MAX),
    depthMax: posInt(opts.depthMax, DIGEST_DEPTH_MAX),
    itemMax: posInt(opts.itemMax, DIGEST_ITEM_MAX),
    first: Array.isArray(opts.first) ? opts.first : DIGEST_KEY_FIELDS,
  }
  return clip(render(value, 0, o), o.max)
}

/** `<body>` 的固定优先级（顺序即判据，见文件头）。 */
function pickBody(u) {
  const v = u?.value
  if (isPlainObject(v)) {
    const s = v.summary
    if (typeof s === 'string' && s.trim().length > 0) return s
    if (isPlainObject(s) || Array.isArray(s)) return stableJson(s)
    const inner = v.value
    if (typeof inner === 'string' && inner.trim().length > 0) return inner
  } else if (typeof v === 'string' && v.trim().length > 0) {
    return v
  }
  if (u?.failed === true && String(u.error ?? '').trim().length > 0) return u.error
  if (Array.isArray(u?.content) && u.content.length > 0) {
    const joined = u.content.join(' ').trim()
    if (joined.length > 0) return joined
  }
  if (v === null || v === undefined) return ''
  return isPlainObject(v) || Array.isArray(v) ? stableJson(v) : scalarText(v)
}

/**
 * ★ **正文**（`：` 后面那一段）—— 已按 {@link DIGEST_TEXT_MAX} 截断。
 *
 * @param {{envelope:boolean, failed:boolean, value:*, error:string, content:string[]}} u - `unwrapResult` 的产物
 * @param {{max?:number}} [opts]
 * @returns {string}
 */
export function digestBody(u, opts = {}) {
  return clip(pickBody(u), posInt(opts.max, DIGEST_TEXT_MAX))
}

/**
 * ★★ **把一次工具调用折成一行人话**（纯函数；写不写由调用方定）。
 *
 * @param {object} exec
 * @param {*} result - 宿主交来的**信封**（也接受裸值）
 * @param {{textMax?:number, bodyMax?:number}} [opts]
 * @returns {{name:string, failed:boolean, taskId:string, state:string, handoffId:string,
 *   artifactVersion:string, body:string, text:string, envelope:boolean}}
 */
export function toolDigest(exec, result, opts = {}) {
  const name = String(exec?.name ?? '')
  const args = isPlainObject(exec?.arguments) ? exec.arguments : {}
  const u = unwrapResult(result)
  const v = isPlainObject(u.value) ? u.value : {}
  const taskId = clip(scalarText(args.task_id ?? v.task_id ?? ''), DIGEST_KEY_MAX).trim()
  const state = clip(scalarText(v.state ?? v.to ?? ''), DIGEST_KEY_MAX).trim()
  const handoffId = clip(scalarText(v.handoff_id ?? ''), DIGEST_KEY_MAX).trim()
  const artifactVersion = clip(scalarText(v.artifact_version ?? ''), DIGEST_KEY_MAX).trim()
  // ★ "失败"的判据有两条：宿主说这次**没跑成**（`isError`），或工具自己回了 `ok:false`
  //   （本插件的拒绝路径就是这个形状：`{ok:false, summary:'拒绝…'}`）。
  const failed = u.failed === true || v.ok === false
  const body = digestBody(u, opts)
  const textMax = posInt(opts.textMax, DIGEST_TEXT_MAX)
  const head = `工具 ${name} ${failed ? '失败' : '完成'}${taskId.length > 0 ? `（任务 ${taskId}）` : ''}`
  return {
    name,
    failed,
    taskId,
    state,
    handoffId,
    artifactVersion,
    body,
    text: clip(`${head}${body.length > 0 ? `：${body}` : ''}`, textMax),
    envelope: u.envelope,
  }
}
