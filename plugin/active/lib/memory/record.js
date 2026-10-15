// 一条记忆的**规范形状**与纯校验（`id/at/kind/scope/text/entity/refs`）—— 不读盘、不写盘。
/**
 * dsh-pipeline · 记忆 · 记录形状（唯一出处）
 * ============================================================================
 * 记忆库是 **JSONL**（一行一条）。一行写坏了，那一行就永远读不回来 ——
 * 所以"一条记忆长什么样"必须有**一处**说了算，并且**写之前就能判**（`validateRecord`）。
 *
 * ---------------------------------------------------------------------------
 * 形状（每一个字段都有存在的理由，不是凑数）
 * ---------------------------------------------------------------------------
 *   · `id`      稳定唯一（`<kind>:<主键>`）—— **合并去重就靠它**（`merge.js` 按 id 去重）
 *   · `at`      ISO 时刻 —— 时间路的依据；解析不出来就不算一条合法记忆
 *   · `kind`    这条记的是哪一类事实（`task` / 交接物类型 / `transition` / `tool`…）
 *   · `scope`   作用域（当前只有 `project`）
 *   · `text`    一行摘要（**有上限**）—— 关键词路的依据；正文不进记忆库
 *   · `entity[]` 天然主键（`task:` / `path:` / `role:` / `state:` …）—— 实体路的依据
 *   · `refs`    结构化引用（任务 / 状态 / 路径 / 交接物 / 制品 / 角色），给程序化调用方
 *
 * ★ 本文件是**纯函数**：没有 `fs`、没有 `Date.now()`、没有随机数
 *   （时刻一律由调用方传进来 —— 否则"同输入同输出"这条判据就不成立）。
 *
 * @module dsh-pipeline/lib/memory/record
 */

/** 单条记忆正文的上限（与 `load.js` 的 `TEXT_MAX` 同口径：摘要**不许**长成正文）。 */
export const TEXT_MAX = 240

/** 记忆的作用域（当前只有项目库；跨项目的用户裁定库不走这里，见设计 `04` §6）。 */
export const SCOPE_PROJECT = 'project'

/** 本插件自己产出的 `kind` 取值（交接物类型是**开放集**，由既有 `handoffs/*.json` 决定）。 */
export const KIND = Object.freeze({
  TASK: 'task',
  HANDOFF: 'handoff',
  TRANSITION: 'transition',
  TOOL: 'tool',
})

/** `kind` 的形状：小写字母开头，允许 `-`/`_`/数字（交接物类型如 `dev_to_test` 也在这个形状里）。 */
const KIND_RE = /^[a-z][a-z0-9_-]{0,39}$/

/** 实体键的形状：`<前缀>:<值>`（前缀小写）。 */
const ENTITY_RE = /^[a-z][a-z0-9-]*:.+$/

/** `refs` 的固定字段（**全部必须存在**；缺一个就是"半条记忆"，读的人得自己猜）。 */
export const REF_FIELDS = Object.freeze([
  'task_id',
  'state',
  'state_label',
  'paths',
  'handoff',
  'artifact_version',
  'roles',
])

/** 按字符截断（幂等；换行折成空格 —— 一行 JSONL 里不许出现裸换行）。 */
export function clip(value, max = TEXT_MAX) {
  const s = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1))}…`
}

/** 空的 `refs`（省得每个调用方各写一份默认值）。 */
export function emptyRefs(patch = {}) {
  return {
    task_id: '',
    state: '',
    state_label: '',
    paths: [],
    handoff: '',
    artifact_version: '',
    roles: [],
    ...patch,
  }
}

/** 字符串数组归一：去空、去重、**排序**（排序是为了确定性 —— 顺序不同不该算两条）。 */
function normList(value) {
  const arr = Array.isArray(value) ? value : []
  return [...new Set(arr.map((x) => String(x ?? '').trim()).filter((x) => x.length > 0))].sort()
}

/**
 * ★ 造一条记忆（**唯一入口** —— 别处不许手拼对象，否则形状会漂）。
 *
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.at - ISO 时刻（调用方给；本文件不取当前时间）
 * @param {string} input.kind
 * @param {string} input.text
 * @param {string} [input.scope]
 * @param {string[]} [input.entity]
 * @param {object} [input.refs]
 * @returns {{ok:true, record:object} | {ok:false, errors:string[]}}
 */
export function makeRecord(input = {}) {
  const record = {
    id: String(input.id ?? '').trim(),
    at: String(input.at ?? '').trim(),
    kind: String(input.kind ?? '').trim(),
    scope: String(input.scope ?? SCOPE_PROJECT).trim(),
    text: clip(input.text),
    entity: normList(input.entity),
    refs: emptyRefs({
      ...(input.refs ?? {}),
      paths: normList(input.refs?.paths),
      roles: normList(input.refs?.roles),
    }),
  }
  const v = validateRecord(record)
  return v.ok ? { ok: true, record } : { ok: false, errors: v.errors }
}

/**
 * ★ 校验一条记忆（**写之前**判；坏数据不许进库）。
 *
 * @param {unknown} record
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateRecord(record) {
  const errors = []
  const r = record !== null && typeof record === 'object' ? record : null
  if (r === null) return { ok: false, errors: ['不是对象'] }

  if (typeof r.id !== 'string' || r.id.trim().length === 0) errors.push('id 必须是非空字符串')
  else if (r.id.length > 200) errors.push(`id 太长（${r.id.length} > 200）`)

  if (typeof r.at !== 'string' || r.at.trim().length === 0) errors.push('at 必须是非空字符串（ISO 时刻）')
  else if (!Number.isFinite(Date.parse(r.at))) errors.push(`at 解析不出时刻：${JSON.stringify(r.at)}`)

  if (typeof r.kind !== 'string' || !KIND_RE.test(r.kind)) errors.push(`kind 形状不合法：${JSON.stringify(r.kind)}`)
  if (r.scope !== SCOPE_PROJECT) errors.push(`scope 只认 ${JSON.stringify(SCOPE_PROJECT)}，收到 ${JSON.stringify(r.scope)}`)

  if (typeof r.text !== 'string' || r.text.trim().length === 0) errors.push('text 必须是非空字符串（一行摘要）')
  else if (r.text.length > TEXT_MAX) errors.push(`text 超上限（${r.text.length} > ${TEXT_MAX}）`)
  else if (/[\r\n]/.test(r.text)) errors.push('text 里不许有裸换行（JSONL 一行一条）')

  if (!Array.isArray(r.entity)) errors.push('entity 必须是数组')
  else if (r.entity.some((e) => typeof e !== 'string' || !ENTITY_RE.test(e))) {
    errors.push('entity 每一项必须是 `<前缀>:<值>`（前缀小写）')
  }

  const refs = r.refs !== null && typeof r.refs === 'object' ? r.refs : null
  if (refs === null) errors.push('refs 必须是对象（字段见 REF_FIELDS）')
  else {
    for (const f of REF_FIELDS) if (!Object.hasOwn(refs, f)) errors.push(`refs 缺字段 ${f}`)
    for (const f of ['task_id', 'state', 'state_label', 'handoff', 'artifact_version']) {
      if (Object.hasOwn(refs, f) && typeof refs[f] !== 'string') errors.push(`refs.${f} 必须是字符串`)
    }
    for (const f of ['paths', 'roles']) {
      if (Object.hasOwn(refs, f) && !Array.isArray(refs[f])) errors.push(`refs.${f} 必须是数组`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 把一条记忆序列化成**一行** JSONL（结尾带 `\n`）。
 *
 * @param {object} record - 必须先过 {@link validateRecord}
 * @returns {string}
 */
export function toJsonlLine(record) {
  return `${JSON.stringify(record)}\n`
}
