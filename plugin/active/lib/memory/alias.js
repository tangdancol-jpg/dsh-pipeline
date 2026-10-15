// 实体归一：把同一事物的不同叫法折成**同一个实体键**（`task:` / `path:` / `role:` / `state:` / `tool:`）。
/**
 * dsh-pipeline · 记忆 · 实体归一（别名表）
 * ============================================================================
 * 这是**实体路**（E2）的地基，也是设计 `03-模块拆分.md` §3 说的"实体图在本地
 * 的形态"：不是图数据库，而是**天然主键 + 一张别名表**。
 *
 * ---------------------------------------------------------------------------
 * 为什么要归一（真实痛点）
 * ---------------------------------------------------------------------------
 * 同一个东西在 `.pipeline/` 里有多套写法，不改就会被当成两个实体：
 *   · 任务 id：`T-20261011-214043` / `t-20261011-214043` / 前后带空格；
 *   · 路径：`src/a.js` / `./src/a.js` / `SRC\A.JS` / `src//a.js`；
 *   · 角色：`writer` / `编写` / `writing`（中文与英文混用，见设计 `03` §3 的原话）；
 *   · 状态：`closed` / `已关闭`（一个是 id、一个是人话标签）。
 *
 * ---------------------------------------------------------------------------
 * 两条纪律
 * ---------------------------------------------------------------------------
 *   ① **不误折**（判据 R5）：`T-1` 与 `T-2` 的键必须不等；`a/x.js` 与 `b/x.js`
 *      也必须不等 —— 所以路径**不按 basename** 折。
 *   ② **常量只有一个出处**：角色用 `lib/roles.js` 的 `ROLE`，状态用 `lib/states.js`
 *      的 `STATE_LABEL` 反查，`tool:` 前缀用工具名的**约定前缀** —— 本文件不手抄第二份名单。
 *
 * ★ 纯函数：无 IO、无时间、无随机。
 *
 * @module dsh-pipeline/lib/memory/alias
 */

import { ROLE } from '../roles.js'
import { STATE_LABEL } from '../states.js'

/** 实体键的前缀（写在一处，免得各处手拼字符串）。 */
export const ENTITY_PREFIX = Object.freeze({
  TASK: 'task',
  PATH: 'path',
  ROLE: 'role',
  STATE: 'state',
  HANDOFF: 'handoff',
  ARTIFACT: 'artifact',
  TOOL: 'tool',
})

/**
 * 角色的**中英别名表** —— 值一律是 `lib/roles.js` 的 `ROLE.*`（**不是手抄的字符串**）。
 *
 * 现场证据：需求档 / 交接物 / 提示词里同时出现 `writer`、`编写`、`编写席`、`writing`；
 * 不折到一起，实体路就会把"同一个角色"记成四件事。
 */
export const ROLE_ALIAS = Object.freeze({
  writer: ROLE.WRITER,
  编写: ROLE.WRITER,
  编写席: ROLE.WRITER,
  writing: ROLE.WRITER,
  tester: ROLE.TESTER,
  测试: ROLE.TESTER,
  测试位: ROLE.TESTER,
  testing: ROLE.TESTER,
  reviewer: ROLE.REVIEWER,
  审核: ROLE.REVIEWER,
  审核位: ROLE.REVIEWER,
  评审: ROLE.REVIEWER,
  main: ROLE.MAIN,
  主对话: ROLE.MAIN,
  协调者: ROLE.MAIN,
  orchestrator: ROLE.ORCHESTRATOR,
  需求分析: ROLE.ORCHESTRATOR,
  需求位: ROLE.ORCHESTRATOR,
  planner: ROLE.PLANNER,
  计划: ROLE.PLANNER,
  计划位: ROLE.PLANNER,
  计划ai: ROLE.PLANNER,
  supervisor: ROLE.SUPERVISOR,
  主管: ROLE.SUPERVISOR,
  主管位: ROLE.SUPERVISOR,
  architect: ROLE.ARCHITECT,
  架构: ROLE.ARCHITECT,
  架构位: ROLE.ARCHITECT,
  diagrammer: ROLE.DIAGRAMMER,
  架构图: ROLE.DIAGRAMMER,
  archivist: ROLE.ARCHIVIST,
  留档: ROLE.ARCHIVIST,
  security: ROLE.SECURITY,
  安全: ROLE.SECURITY,
  human: ROLE.HUMAN,
  用户: ROLE.HUMAN,
  人工: ROLE.HUMAN,
})

/** 反向：状态**人话标签 → id**（从 `STATE_LABEL` 现算，不手抄）。 */
const STATE_BY_LABEL = (() => {
  const out = new Map()
  for (const [id, label] of Object.entries(STATE_LABEL)) {
    const key = String(label).trim().toLowerCase()
    if (key.length > 0 && !out.has(key)) out.set(key, id)
  }
  return out
})()

/** 折叠大小写与空白（一切都从这里开始，免得各处各折一次）。 */
const fold = (value) => String(value ?? '').trim().toLowerCase()

/**
 * 路径 → 规范形态：统一分隔符、去掉 `./`、折叠重复分隔符、小写。
 *
 * @param {unknown} value
 * @returns {string} 空串（入参不是路径）时调用方应丢弃
 */
export function canonicalPath(value) {
  const raw = fold(value).replace(/\\/g, '/')
  if (raw.length === 0) return ''
  const segs = []
  for (const seg of raw.split('/')) {
    if (seg.length === 0 || seg === '.') continue
    if (seg === '..' && segs.length > 0 && segs[segs.length - 1] !== '..') {
      segs.pop()
      continue
    }
    segs.push(seg)
  }
  return segs.join('/')
}

/** 角色 → 规范 id（认不出就原样小写返回 —— **不猜**）。 */
export function canonicalRole(value) {
  const key = fold(value)
  if (key.length === 0) return ''
  return ROLE_ALIAS[key] ?? key.replace(/\s+/g, '-')
}

/**
 * ★ 状态**认得出来吗**（认得 ⇒ 规范 id；认不出 ⇒ **空串**）。
 *
 * 为什么要与 {@link canonicalState} 分开：那一条"认不出就原样返回"，所以调用方
 * **分不出**"认出来了"和"没认出来"。实体路要的正是这个分辨力 ——
 * 认不出就不该造键，否则 `fizzbuzz` 会变成 `state:fizzbuzz` 那样的假实体。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function knownState(value) {
  const key = fold(value)
  if (key.length === 0) return ''
  if (Object.hasOwn(STATE_LABEL, key)) return key
  return STATE_BY_LABEL.get(key) ?? ''
}

/** 状态 → 规范 id（人话标签也认；认不出就原样小写返回）。 */
export function canonicalState(value) {
  const key = fold(value)
  if (key.length === 0) return ''
  return knownState(key) || key
}

/** 任务 id → 规范形态（折叠大小写与空白；`T-1` 与 `T-2` 仍然是两个）。 */
export function canonicalTaskId(value) {
  return fold(value).replace(/\s+/g, '')
}

/**
 * ★ **实体归一**的唯一入口：任意一种写法 → 规范实体键（认不出前缀就原样返回）。
 *
 * @param {string} value - 已带前缀（`task:T-1`）或裸值（`T-1`）
 * @param {string} [prefixHint] - 裸值时用什么前缀（缺省 `task`）
 * @returns {string} 空串表示"折不出实体"（调用方应丢弃，而不是塞一个空键）
 */
export function aliasEntity(value, prefixHint = ENTITY_PREFIX.TASK) {
  const raw = String(value ?? '').trim()
  if (raw.length === 0) return ''
  const idx = raw.indexOf(':')
  const hasPrefix = idx > 0 && /^[a-z][a-z0-9-]*$/.test(raw.slice(0, idx))
  const prefix = hasPrefix ? raw.slice(0, idx) : String(prefixHint ?? ENTITY_PREFIX.TASK)
  const body = hasPrefix ? raw.slice(idx + 1) : raw

  switch (prefix) {
    case ENTITY_PREFIX.TASK: {
      const id = canonicalTaskId(body)
      return id.length === 0 ? '' : `${ENTITY_PREFIX.TASK}:${id}`
    }
    case ENTITY_PREFIX.PATH: {
      const p = canonicalPath(body)
      return p.length === 0 ? '' : `${ENTITY_PREFIX.PATH}:${p}`
    }
    case ENTITY_PREFIX.ROLE: {
      const r = canonicalRole(body)
      return r.length === 0 ? '' : `${ENTITY_PREFIX.ROLE}:${r}`
    }
    case ENTITY_PREFIX.STATE: {
      const s = canonicalState(body)
      return s.length === 0 ? '' : `${ENTITY_PREFIX.STATE}:${s}`
    }
    default: {
      // 其余前缀（handoff / artifact / tool…）：只折大小写与空白。
      const b = fold(body).replace(/\s+/g, '')
      return b.length === 0 ? '' : `${prefix}:${b}`
    }
  }
}

/**
 * 归一一组实体键：逐个折、去空、去重、**排序**（确定性）。
 *
 * @param {unknown[]} list - 可以混着"带前缀"与"裸值"，也可以混着多种前缀
 * @param {string} [prefixHint]
 * @returns {string[]}
 */
export function aliasAll(list, prefixHint = ENTITY_PREFIX.TASK) {
  const arr = Array.isArray(list) ? list : []
  return [...new Set(arr.map((x) => aliasEntity(x, prefixHint)).filter((x) => x.length > 0))].sort()
}

/**
 * 两个写法是不是**同一实体**（判据 R4/R5 的直接形态）。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} [prefixHint]
 * @returns {boolean}
 */
export function sameEntity(a, b, prefixHint = ENTITY_PREFIX.TASK) {
  const ka = aliasEntity(a, prefixHint)
  const kb = aliasEntity(b, prefixHint)
  return ka.length > 0 && ka === kb
}
