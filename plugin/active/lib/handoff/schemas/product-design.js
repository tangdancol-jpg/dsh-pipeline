// 交接物 schema · product_design：实现已搬到 `lib/model/handoff-product-design.js`，本文件只做转出（导出面逐字不变）。
/**
 * dsh-pipeline · 交接物 schema · `product_design`（转出）
 * ============================================================================
 * 领域对象的定义（字段表 / 类型名 / 两条对象级纯函数）集中在 `lib/model/handoff-product-design.js`；
 * 本文件只把它的导出原样转出 —— **对外导出面与搬迁前逐字相同**（`tests/p5-product-catalog-check.mjs`
 * 按这个路径 import，所以路径必须留着）。
 *
 * @module dsh-pipeline/lib/handoff/schemas/product-design
 */

export {
  PRODUCT_DESIGN_KIND,
  CATALOG_ENTRY_FIELDS,
  PRODUCT_DESIGN_SCHEMA,
  validateProductDesignPayload,
  summarizeProductDesign,
} from '../../model/handoff-product-design.js'
