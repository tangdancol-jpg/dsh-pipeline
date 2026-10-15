// 记忆取回 · **实体路**：把查询里的天然主键（任务 / 路径 / 角色 / 状态 / 交接物）折成实体键后精确命中。
/**
 * dsh-pipeline · 记忆 · 取回 · 实体路
 * ============================================================================
 * 设计 `03-模块拆分.md` §3 把这一路列为**付费意愿最高**的一路：
 * `task_id`、`change_scope[].path`、`role`、`state`、`handoff_id` 就是现成的主键，
 * 而"同一事物不同叫法"（`writing` / `编写` / `writer`，`T-1` / `t-1`，`SRC\A.JS` / `src/a.js`）
 * 必须归到一起。归一的实现**不在这里** —— 复用 E1 的 `alias.js`（`CONVENTIONS.md` §7：
 * 一个常量只有一个出处）。
 *
 * ---------------------------------------------------------------------------
 * 三条纪律（每条都有断言钉）
 * ---------------------------------------------------------------------------
 *   ① **折叠**（判据 R4）：`T-1` / `t-1` / ` t-1 `、`编写` / `writer`、`SRC\A.JS` / `./src/a.js`
 *      折成**同一个键** ⇒ 命中同一条记忆。
 *   ② **不误折**（判据 R5）：`T-1` 与 `T-2`、`src/a.js` 与 `b/src/a.js` 的键必须不等
 *      —— 所以路径**不按 basename** 折，任务 id 也不做前缀/模糊匹配。
 *   ③ **认不出就不造键**：查询里那些普通词（`fizzbuzz`、"这个任务之前怎么处理的"）
 *      **一个键都不产生** ⇒ 本路返回空，把活留给关键词路。
 *      ★ 这条是"实体路"与"什么都往 `task:` 里塞"的分界线：`aliasEntity()` 的缺省前缀是
 *        `task`，若拿它去折任意词，`fizzbuzz` 就会变成 `task:fizzbuzz` —— 那是误折。
 *
 * ★ 纯函数：不读盘、不认识 `fs`、不取时钟。同一输入必然同一输出（判据 R6）。
 *
 * @module dsh-pipeline/lib/memory/route-entity
 */

import {
  ENTITY_PREFIX,
  ROLE_ALIAS,
  aliasEntity,
  knownState,
} from './alias.js'
import { parseTime } from './route-time.js'

/** 实体路的固定路由名（合并时用它做权重与来源标记）。 */
export const ROUTE_ENTITY = 'entity'

/**
 * 查询里**允许用显式前缀**写出来的实体种类。
 *
 * 为什么要有这张表：`aliasEntity('foo:bar')` 对任意前缀都会产出一个键，
 * 于是一句普通的英文（`注意：foo` 里的 `注意` 不算，但 `chapter:2` 算）就会造出假实体。
 * 只认表里的前缀 ⇒ 显式写法仍然可用，误折不会发生。
 */
export const QUERY_PREFIXES = Object.freeze([
  ENTITY_PREFIX.TASK,
  ENTITY_PREFIX.PATH,
  ENTITY_PREFIX.ROLE,
  ENTITY_PREFIX.STATE,
  ENTITY_PREFIX.HANDOFF,
  ENTITY_PREFIX.ARTIFACT,
  ENTITY_PREFIX.TOOL,
])

/** 任务 id 的形状（`T-1` / `T-20261011-214043` / `T-20261015-bb30bc`）。 */
const TASK_ID_RE = /^t-\d+(-[0-9a-z]+)*$/i

/** 交接物 id 的形状（现场两种写法：`001-dev_to_test` 与 `H-073a6a57aaf0ecc7`）。 */
const HANDOFF_ID_RE = /^(h-[0-9a-f]{6,}|\d{3}-[a-z][a-z0-9_]*)$/i

/** 显式前缀写法：`path:src/a.js` / `role:writer`。 */
const EXPLICIT_RE = /^([a-z][a-z0-9-]*):(.+)$/i

/** 带分隔符 ⇒ 当路径看（`src/a.js`、`lib\\memory`）。 */
const PATHISH_RE = /[\\/]/

/** 单个文件名也算路径（`bank.js`）——**精确**匹配用，不按 basename 折。 */
const FILENAME_RE = /^[a-z0-9_.-]+\.[a-z][a-z0-9]{0,5}$/i

/**
 * 片段分隔符：空白 + 中英标点。
 *
 * ★ 刻意**不切** `._:/\-` 这五个字符 —— 任务 id（`-`）、路径（`/` `\`）、
 *   文件名（`.`）、显式前缀（`:`）都靠它们保持完整。切了就等于把实体切碎。
 */
const SPLIT_RE = /[\s，。、；！？"'“”‘’（）()\[\]【】{}<>|,;!?*+@#$%^&~`]+/u

/**
 * 把查询切成"可能是一个实体"的片段。
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function queryTokens(text) {
  return String(text ?? '')
    .split(SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * ★ 一个片段 → 规范实体键（**认不出 ⇒ 空串**）。
 *
 * 判定顺序即优先级（写死在这里，测试钉住）：
 *   显式前缀 → 任务 id → 路径/文件名 → 交接物 id → 角色别名 → 状态名。
 *
 * @param {unknown} token
 * @returns {string}
 */
export function entityKeyOfToken(token) {
  const raw = String(token ?? '').trim()
  if (raw.length === 0) return ''

  const explicit = EXPLICIT_RE.exec(raw)
  if (explicit !== null) {
    const prefix = explicit[1].toLowerCase()
    if (QUERY_PREFIXES.includes(prefix)) return aliasEntity(`${prefix}:${explicit[2]}`, prefix)
  }
  if (TASK_ID_RE.test(raw)) return aliasEntity(raw, ENTITY_PREFIX.TASK)
  if (PATHISH_RE.test(raw) || FILENAME_RE.test(raw)) return aliasEntity(raw, ENTITY_PREFIX.PATH)
  if (HANDOFF_ID_RE.test(raw)) return aliasEntity(raw, ENTITY_PREFIX.HANDOFF)

  const folded = raw.toLowerCase()
  // ★ 先用 `ROLE_ALIAS` / `knownState` **判断认得出来**，再折 —— 顺序反了就会把
  //   `fizzbuzz` 折成 `role:fizzbuzz`（`canonicalRole` 认不出时原样返回）。
  if (Object.hasOwn(ROLE_ALIAS, folded)) return aliasEntity(raw, ENTITY_PREFIX.ROLE)
  if (knownState(folded).length > 0) return aliasEntity(raw, ENTITY_PREFIX.STATE)
  return ''
}

/**
 * 自由文本 → 实体键集合（去重 + **排序** ⇒ 确定性）。
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function entityKeysOf(text) {
  const out = new Set()
  for (const t of queryTokens(text)) {
    const k = entityKeyOfToken(t)
    if (k.length > 0) out.add(k)
  }
  return [...out].sort()
}

/** 非空字符串（`refs` 里的字段可能是 null / undefined）。 */
const str = (v) => String(v ?? '').trim()

/** 数组字段（非数组 ⇒ 空）。 */
const arr = (v) => (Array.isArray(v) ? v : [])

/**
 * ★ 一条记忆的实体键集合：`entity[]` **加上** `refs` 里的同一批主键。
 *
 * 为什么要两边都取：`entity[]` 是写库时折过一遍的，但**既有档案**（`load.js` 的产物）
 * 与 `refs` 是另一处写法（`refs.paths[]` 里的路径可能带 `./`）。两处合起来再过一次
 * {@link aliasEntity} ⇒ "同物多名"在这一层被折叠（判据 R4），并且用 Set 去重
 * （`entity:['task:T-1']` 与 `refs.task_id:'t-1'` 只算**一个**键，不会重复计分）。
 *
 * @param {object} record
 * @returns {Set<string>}
 */
export function recordEntityKeys(record) {
  const r = record !== null && typeof record === 'object' ? record : {}
  const refs = r.refs !== null && typeof r.refs === 'object' ? r.refs : {}
  const raw = [
    ...arr(r.entity),
    ...(str(refs.task_id).length > 0 ? [`${ENTITY_PREFIX.TASK}:${str(refs.task_id)}`] : []),
    ...(str(refs.state).length > 0 ? [`${ENTITY_PREFIX.STATE}:${str(refs.state)}`] : []),
    ...(str(refs.handoff).length > 0 ? [`${ENTITY_PREFIX.HANDOFF}:${str(refs.handoff)}`] : []),
    ...arr(refs.paths).map((p) => `${ENTITY_PREFIX.PATH}:${str(p)}`),
    ...arr(refs.roles).map((x) => `${ENTITY_PREFIX.ROLE}:${str(x)}`),
  ]
  const out = new Set()
  for (const x of raw) {
    const k = aliasEntity(x, ENTITY_PREFIX.TASK)
    if (k.length > 0) out.add(k)
  }
  return out
}

/**
 * ★ **实体路取回**。
 *
 * 打分 = **命中的实体键个数**（整数；`merge.js` 再给它乘上 `ROUTE_WEIGHT.entity`）。
 * 命中 0 个键的条目**不进结果** —— 这一路只回答"是不是同一个东西"，不做模糊召回。
 *
 * @param {object[]} records - 全部候选（`load.js` 的产物）
 * @param {object} [opts]
 * @param {string} [opts.query] - 自由文本（认不出任何实体键 ⇒ 返回空）
 * @param {unknown[]} [opts.entities] - 显式给的实体（`task:T-1` 或裸值，按 `task` 折）
 * @param {number} [opts.limit] - 最多几条
 * @returns {object[]} 命中的条目：`{...record, score, hits}`（**已按分数 / 时间 / id 定序**）
 */
export function routeEntity(records, opts = {}) {
  const list = Array.isArray(records) ? records : []
  const explicit = arr(opts.entities)
    .map((x) => aliasEntity(x, ENTITY_PREFIX.TASK))
    .filter((x) => x.length > 0)
  const wanted = new Set([...entityKeysOf(opts.query), ...explicit])
  if (wanted.size === 0) return []

  const limit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : Infinity
  const scored = []
  for (const record of list) {
    const keys = recordEntityKeys(record)
    const hits = [...wanted].filter((k) => keys.has(k)).sort()
    if (hits.length === 0) continue
    scored.push({ record, score: hits.length, hits })
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const ta = parseTime(a.record?.at)
    const tb = parseTime(b.record?.at)
    if (ta !== tb) return tb - ta
    const ia = String(a.record?.id ?? '')
    const ib = String(b.record?.id ?? '')
    return ia < ib ? -1 : ia > ib ? 1 : 0
  })
  const out = scored.map((s) => ({ ...s.record, score: s.score, hits: s.hits }))
  return Number.isFinite(limit) ? out.slice(0, limit) : out
}
