// 产品目录 · 结构校验：两组、每条必须带验收判据、**空 MVP 被拒**（验收 A13）。
/**
 * dsh-pipeline · 产品目录 · 结构校验
 * ============================================================================
 * 验收 A13：需求 agent 产出结构化产品目录，分 `MVP 必须` / `后续再说` 两组，
 * **每条带验收判据**；schema 校验通过（**MVP 至少 1 条，空 MVP 被拒**）。
 *
 * ---------------------------------------------------------------------------
 * 为什么这几条是硬校验而不是"最好写一下"
 * ---------------------------------------------------------------------------
 *   · **空 MVP 被拒** —— "MVP 里什么都没有"意味着这张单**没有必做项**，
 *     那就不该开成一张开发单（它要么是纯调研，要么需求还没想清楚）。
 *     放它过去，后面"测试测什么、审核判什么"全都没有依据。
 *   · **每条带验收判据** —— 没有判据的条目在验收时只能靠"看起来做了"，
 *     而那正是本流水线要消灭的东西。
 *
 * @module dsh-pipeline/lib/design/catalog-schema
 */

import { GROUP_KEYS, GROUP_LATER, GROUP_LABELS, GROUP_MVP, groupLabel, groupOf } from './catalog-groups.js'

/** 条目标题长度上限（目录是"清单"，不是"说明书"）。 */
export const TITLE_MAX = 120

/** 单条验收判据的长度上限。 */
export const ACCEPTANCE_MAX = 300

/** 校验码（唯一出处，别处不许再手抄字符串）。 */
export const CATALOG_CODES = Object.freeze({
  NOT_AN_OBJECT: 'CATALOG_NOT_OBJECT',
  BAD_GROUP: 'CATALOG_BAD_GROUP',
  EMPTY_MVP: 'CATALOG_EMPTY_MVP',
  NOT_AN_ARRAY: 'CATALOG_ENTRY_NOT_ARRAY',
  ENTRY_NOT_OBJECT: 'CATALOG_ENTRY_NOT_OBJECT',
  MISSING_ID: 'CATALOG_ENTRY_MISSING_ID',
  MISSING_TITLE: 'CATALOG_ENTRY_MISSING_TITLE',
  TITLE_TOO_LONG: 'CATALOG_ENTRY_TITLE_TOO_LONG',
  MISSING_ACCEPTANCE: 'CATALOG_ENTRY_MISSING_ACCEPTANCE',
  ACCEPTANCE_TOO_LONG: 'CATALOG_ENTRY_ACCEPTANCE_TOO_LONG',
  DUPLICATE_ID: 'CATALOG_DUPLICATE_ID',
})

/** 一条 issue。 */
function issue(code, path, message) {
  return { code, path, message }
}

/**
 * 校验一份产品目录。
 *
 * @param {object} catalog
 * @returns {{ok:boolean, issues:Array<{code:string,path:string,message:string}>,
 *            stats:{mvp:number,later:number,total:number}, catalog:object}}
 */
export function validateCatalog(catalog) {
  const issues = []

  if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return {
      ok: false,
      issues: [issue(CATALOG_CODES.NOT_AN_OBJECT, '', '产品目录必须是一个对象，形如 { mvp: [...], later: [...] }。')],
      stats: { mvp: 0, later: 0, total: 0 },
      catalog: null,
    }
  }

  // ① 分组键本身要对（多写了别的组 ⇒ 报出来，不静默忽略）
  for (const key of Object.keys(catalog)) {
    if (!GROUP_KEYS.includes(key)) {
      issues.push(
        issue(
          CATALOG_CODES.BAD_GROUP,
          key,
          `产品目录里出现了不认识的分组 \`${key}\` —— 只允许 ${GROUP_KEYS.map((k) => `\`${k}\`（${GROUP_LABELS[k]}）`).join(' 与 ')}。`,
        ),
      )
    }
  }

  const g = groupOf(catalog)
  const seen = new Map()

  for (const key of GROUP_KEYS) {
    const raw = catalog[key]
    if (raw !== undefined && !Array.isArray(raw)) {
      issues.push(issue(CATALOG_CODES.NOT_AN_ARRAY, key, `分组 \`${groupLabel(key)}\` 必须是数组。`))
      continue
    }
    const list = g[key]
    for (let i = 0; i < list.length; i += 1) {
      const path = `${key}[${i}]`
      const entry = list[i]
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        issues.push(issue(CATALOG_CODES.ENTRY_NOT_OBJECT, path, `\`${groupLabel(key)}\` 的第 ${i + 1} 条不是对象。`))
        continue
      }

      const id = String(entry.id ?? '').trim()
      if (id.length === 0) {
        issues.push(issue(CATALOG_CODES.MISSING_ID, `${path}.id`, `\`${groupLabel(key)}\` 的第 ${i + 1} 条缺 id。`))
      } else if (seen.has(id)) {
        issues.push(issue(CATALOG_CODES.DUPLICATE_ID, `${path}.id`, `id \`${id}\` 与 ${seen.get(id)} 重复 —— 目录条目要能一条条对上验收。`))
      } else {
        seen.set(id, path)
      }

      const title = String(entry.title ?? '').trim()
      if (title.length === 0) {
        issues.push(issue(CATALOG_CODES.MISSING_TITLE, `${path}.title`, `条目 \`${id || i + 1}\` 缺标题（一句话说清这条要做什么）。`))
      } else if (title.length > TITLE_MAX) {
        issues.push(issue(CATALOG_CODES.TITLE_TOO_LONG, `${path}.title`, `标题超过 ${TITLE_MAX} 字（${title.length}）—— 目录是清单，不是说明书。`))
      }

      const acc = Array.isArray(entry.acceptance) ? entry.acceptance : []
      const clean = acc.map((a) => String(a ?? '').trim()).filter((a) => a.length > 0)
      if (clean.length === 0) {
        issues.push(
          issue(
            CATALOG_CODES.MISSING_ACCEPTANCE,
            `${path}.acceptance`,
            `条目 \`${id || title || i + 1}\`（${groupLabel(key)}）**没有验收判据** —— 没有判据的条目验收时只能靠"看起来做了"，那正是本流水线要消灭的东西。`,
          ),
        )
      }
      for (let j = 0; j < clean.length; j += 1) {
        if (clean[j].length > ACCEPTANCE_MAX) {
          issues.push(issue(CATALOG_CODES.ACCEPTANCE_TOO_LONG, `${path}.acceptance[${j}]`, `验收判据超过 ${ACCEPTANCE_MAX} 字（${clean[j].length}）。`))
        }
      }
    }
  }

  // ② ★ 空 MVP 被拒（A13 里点名的那一条）
  if (g[GROUP_MVP].length === 0) {
    issues.push(
      issue(
        CATALOG_CODES.EMPTY_MVP,
        GROUP_MVP,
        '拒绝：**MVP 必须** 这一组是空的。\n' +
          '★ 判据：MVP 至少 1 条 —— "MVP 里什么都没有"意味着这张单没有必做项，' +
          '那它不该开成一张开发单（要么是纯调研，要么需求还没想清楚）。\n' +
          '下一步：把"这次一定要交付的"至少写出一条（带验收判据），其余挪进 `later`。',
      ),
    )
  }

  return {
    ok: issues.length === 0,
    issues,
    stats: { mvp: g[GROUP_MVP].length, later: g[GROUP_LATER].length, total: g[GROUP_MVP].length + g[GROUP_LATER].length },
    catalog,
  }
}

/**
 * 归一化：去掉空条目、去掉空判据、把标题/判据两端的空白剪掉（**不改内容措辞**）。
 *
 * @param {object} catalog
 * @returns {{mvp:object[], later:object[]}}
 */
export function normalizeCatalog(catalog) {
  const g = groupOf(catalog)
  const clean = (list) =>
    list
      .filter((e) => e !== null && typeof e === 'object' && !Array.isArray(e))
      .map((e) => ({
        id: String(e.id ?? '').trim(),
        title: String(e.title ?? '').trim(),
        description: String(e.description ?? '').trim(),
        acceptance: (Array.isArray(e.acceptance) ? e.acceptance : [])
          .map((a) => String(a ?? '').trim())
          .filter((a) => a.length > 0),
        ...(e.group === undefined ? {} : { group: e.group }),
      }))
  return { [GROUP_MVP]: clean(g[GROUP_MVP]), later: clean(g.later) }
}

/**
 * 校验 + 归一化一步到位。
 *
 * @param {object} catalog
 * @returns {{ok:true, catalog:object, stats:object}|{ok:false, issues:Array<object>, message:string}}
 */
export function acceptCatalog(catalog) {
  const v = validateCatalog(catalog)
  if (!v.ok) {
    return {
      ok: false,
      issues: v.issues,
      message:
        `产品目录没过校验（${v.issues.length} 条问题）：\n` + v.issues.map((i) => `  · [${i.code}] ${i.path}：${i.message}`).join('\n'),
    }
  }
  return { ok: true, catalog: normalizeCatalog(catalog), stats: v.stats }
}
