// 交接物 schema · product_design：产品目录与产品设计文档那一次交付的字段表（整份从 lib/handoff/schemas/product-design.js 搬来，行为未改）。
/**
 * dsh-pipeline · 交接物 schema · `product_design`
 * ============================================================================
 * 裁定 6：「需求 3 与 4 **合并为一次交付**（文档 + 可操作 DEMO 同批交，用户一次确认）」。
 * 验收 A15：产品目录 / 文档与 DEMO 属**同一次**交付，只发**一次**人工请求、用户**一次**确认。
 *
 * 所以本 schema **同时**承载两侧的指针：
 *   · `catalog`       —— 结构化产品目录（需求 agent 产出，readonly 不破）；
 *   · `demo`          —— 同批交付的 DEMO 引用（**可以为 null**：L0–L1 可跳过 DEMO）。
 *
 * ★ 形状刻意与 `lib/model/handoff-schemas.js` 的 `HANDOFF_SCHEMAS[<kind>]` 一致
 *   （`{zh, from, to, fields, required}`），这样接线时可以直接并进那张表，
 *   不必为它单开一套判定。**本文件不修改 `schemas.js`** —— 接线写进 `WIRING.md`。
 *
 * @module dsh-pipeline/lib/model/handoff-product-design
 */

import { F } from './handoff-fields.js'
import { GROUP_KEYS, GROUP_LABELS, GROUP_MVP, groupOf } from '../design/catalog-groups.js'
import { validateCatalog } from '../design/catalog-schema.js'

/** 交接物类型名（唯一出处）。 */
export const PRODUCT_DESIGN_KIND = 'product_design'

/**
 * 产品目录里**一条**的字段表。
 *
 * @type {Record<string,object>}
 */
export const CATALOG_ENTRY_FIELDS = Object.freeze({
  id: F('string', '条目 id（组内唯一，便于逐条对验收）'),
  title: F('string', '一句话说清这条要做什么'),
  description: F('text', '补充说明（可空）'),
  acceptance: F('string[]', '★ 这条的**验收判据**（至少 1 条 —— 没有判据的条目不许进目录）'),
})

/**
 * `product_design` 交接物的完整 schema。
 *
 * @type {{zh:string, from:string[], to:string, fields:Record<string,object>, required:string[]}}
 */
export const PRODUCT_DESIGN_SCHEMA = Object.freeze({
  zh: '产品目录 + 产品设计文档（与 DEMO 同批一次交付）',
  /** ★ 只有需求分析产出它（readonly 角色只"交"，不"写文件"）。 */
  from: ['orchestrator'],
  /** ★ 交留档落盘、交主对话转告用户（一次确认）。 */
  to: 'archivist|main|human',
  fields: {
    task_id: F('string', '任务ID'),
    /**
     * ★ 结构化产品目录：两组（`mvp` = MVP 必须 / `later` = 后续再说），每条带验收判据。
     *   校验规则（含"空 MVP 被拒"）落在 `lib/design/catalog-schema.js`，不在这里重写一遍。
     */
    catalog: F('object', `产品目录，形如 { ${GROUP_KEYS.map((k) => `${k}: [...]`).join(', ')} }（${GROUP_KEYS.map((k) => `\`${k}\` = ${GROUP_LABELS[k]}`).join('；')}）`),
    /**
     * ★ 同批交付的 DEMO 引用。
     *   **允许为 null** —— 裁定 5：L0–L1 可跳 DEMO；那时这里就是 null，
     *   但"跳过"必须是**显式写下来的结论**，不是漏填。
     */
    demo: F('object', '★ 同批交付的 DEMO 引用（L0–L1 可跳过 ⇒ 显式写 null，不是漏填）'),
    /** ★ 一次确认：本交接物只对应**一次**人工请求。 */
    confirm_request_id: F('string', '本批交付对应的人工请求 id（**只能有一条** —— 裁定 6：一次确认）'),
    doc_path: F('string', '产品设计文档落盘路径（由留档写，通常 docs/product-design.md）'),
  },
  required: ['task_id', 'catalog', 'confirm_request_id'],
})

/**
 * 校验一份 `product_design` 交接物的 payload。
 *
 * 判据（三条，逐条对应裁定 6 / 验收 A13 / A15）：
 *   ① `catalog` 结构合规（复用 `catalog-schema.js`，**不在本文件重写一遍**）；
 *   ② `confirm_request_id` **只有一个**（数组或带分隔符的串都会被拒）；
 *   ③ `demo` 字段**必须在场**（可以是 `null`，但不能 `undefined` —— 见下）。
 *
 * @param {object} payload
 * @returns {{ok:boolean, issues:Array<{code:string,path:string,message:string}>, stats:object|null}}
 */
export function validateProductDesignPayload(payload) {
  const issues = []
  const p = payload ?? {}

  const v = validateCatalog(p.catalog)
  if (!v.ok) issues.push(...v.issues)

  const rid = p.confirm_request_id
  if (typeof rid !== 'string' || rid.trim().length === 0) {
    issues.push({
      code: 'MISSING_CONFIRM_REQUEST',
      path: 'confirm_request_id',
      message:
        '本批交付必须挂上**那条**人工请求 id。\n' +
        '★ 裁定 6 / 验收 A15：产品文档与 DEMO 是**同一次交付、只发一次人工请求、用户一次确认** —— ' +
        '挂不上请求 id，就说明"一次确认"没有落成可查的事实。',
    })
  }

  /**
   * ★ `demo` 必须**在场**（`undefined` 与 `null` 是两件事）。
   *
   * `null`   = "这次跳过 DEMO"（L0–L1 的**结论**）；
   * `undefined` = "我没提这件事" —— 那可能是漏填，也可能是想蒙混过关。
   * 两者都用同一个字段表示的话，"跳过"就变成了默认值，而默认值不需要任何人负责。
   */
  if (!Object.prototype.hasOwnProperty.call(p, 'demo')) {
    issues.push({
      code: 'DEMO_FIELD_ABSENT',
      path: 'demo',
      message:
        '`demo` 字段必须在场：L0–L1 跳过 DEMO 时**显式写 `null`**，不能整个字段不写。\n' +
        '★ 为什么：`null` = "这次跳过"是一个**结论**；字段缺失 = "我没提这件事"，两者不是一回事。',
    })
  }

  return { ok: issues.length === 0, issues, stats: v.ok ? v.stats : null }
}

/**
 * 摘要（给人看的一行；给人工请求的正文用）。
 *
 * @param {object} payload
 * @returns {string}
 */
export function summarizeProductDesign(payload) {
  const g = groupOf(payload?.catalog)
  const mvp = g[GROUP_MVP].length
  const later = g.later.length
  const demo = payload?.demo === null ? '本批**跳过** DEMO（L0–L1）' : payload?.demo === undefined ? '⚠ demo 字段缺失' : '本批**含** DEMO'
  return `产品目录：${GROUP_LABELS[GROUP_MVP]} ${mvp} 条 / ${GROUP_LABELS.later} ${later} 条；${demo}；一次确认（请求 ${payload?.confirm_request_id ?? '(缺)'}）。`
}
