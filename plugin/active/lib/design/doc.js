// 产品设计文档 · 渲染与落盘：把产品目录渲染成 docs/product-design.md，且**只许留档角色落盘**。
/**
 * dsh-pipeline · 产品设计文档 · 渲染与落盘
 * ============================================================================
 * 定稿 §3.3 / 验收 A14：
 *   · 需求 agent（**readonly**）产出**结构化产品目录**；
 *   · 文本交**留档**（有 own-dir）落 `docs/product-design.md`；
 *   · **需求 agent 的 readonly 不被破** —— 它自己不写文件。
 *
 * ---------------------------------------------------------------------------
 * 落盘为什么要卡角色（本文件唯一的"闸"）
 * ---------------------------------------------------------------------------
 * A14 的原话是"由留档（**非需求 agent**）落盘"。这句话如果只写在文档里，
 * 实现上就退化成"谁调都行"，而那正好把 readonly 纪律捅穿：
 * 需求 agent 完全可以顺手调一下本模块，把"我没写文件"变成"我只是调了个工具"。
 *
 * 所以 `writeProductDesignDoc` **要求调用方报出角色**，并且拒绝需求分析角色落盘。
 * 拒绝文案里给出**正确路径**（交留档），不是干巴巴一句"不行"。
 *
 * @module dsh-pipeline/lib/design/doc
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { PRODUCT_DESIGN_REL } from '../project/layout.js'
import { GROUP_LABELS, GROUP_MVP, groupOf } from './catalog-groups.js'
import { acceptCatalog } from './catalog-schema.js'

/** 需求分析角色 id —— **不许**由它落盘（它与 `lib/roles.js` 的 `ROLE.ORCHESTRATOR` 同值）。 */
export const READONLY_CATALOG_AUTHOR = 'orchestrator'

/** 允许落盘的角色（留档是正主；docs 角色是同族）。 */
export const DOC_WRITER_ROLES = Object.freeze(['archivist', 'docs'])

/** 文档标题（唯一出处）。 */
export const DOC_TITLE = '产品设计文档'

/**
 * 把产品目录渲染成 Markdown。
 *
 * @param {object} input
 * @param {object} input.catalog - 产品目录（会先过校验；不过就不渲染）
 * @param {string} [input.taskId]
 * @param {string} [input.projectId]
 * @param {Date} [input.now]
 * @returns {{ok:true, markdown:string, stats:object}|{ok:false, issues:Array<object>, message:string}}
 */
export function renderProductDesignDoc(input = {}) {
  const accepted = acceptCatalog(input.catalog)
  if (!accepted.ok) return accepted
  const catalog = accepted.catalog
  const at = input.now instanceof Date ? input.now : new Date()
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, 'Z')

  const lines = []
  lines.push(`# ${DOC_TITLE}`)
  lines.push('')
  lines.push('> 由**留档**角色落盘（需求 agent 只产出结构化产品目录，不写文件 —— 验收 A14）。')
  lines.push(`> 任务 \`${input.taskId ?? '(未知)'}\`；项目 \`${input.projectId ?? '(未知)'}\`；生成于 ${stamp}。`)
  lines.push('')
  lines.push('★ 读法：先看「MVP 必须」那一组 —— **这次一定要交付的就是它**；')
  lines.push('  「后续再说」是明确**这次不做**的，写下来是为了防止它悄悄混进本次范围。')
  lines.push('')

  const g = groupOf(catalog)
  for (const key of [GROUP_MVP, 'later']) {
    const list = g[key] ?? []
    lines.push(`## ${GROUP_LABELS[key]}（${list.length} 条）`)
    lines.push('')
    if (list.length === 0) {
      lines.push(key === GROUP_MVP ? '_（空 —— 这一组不允许为空）_' : '_（本次没有"后续再说"的条目）_')
      lines.push('')
      continue
    }
    for (const e of list) {
      lines.push(`### ${e.id} · ${e.title}`)
      lines.push('')
      if (e.description.length > 0) {
        lines.push(e.description)
        lines.push('')
      }
      lines.push('验收判据：')
      lines.push('')
      for (const a of e.acceptance) lines.push(`- ${a}`)
      lines.push('')
    }
  }

  lines.push('---')
  lines.push('')
  lines.push(`统计：MVP 必须 ${accepted.stats.mvp} 条，后续再说 ${accepted.stats.later} 条，共 ${accepted.stats.total} 条。`)
  lines.push('')
  return { ok: true, markdown: lines.join('\n'), stats: accepted.stats }
}

/**
 * ★ **落盘** `docs/product-design.md`。
 *
 * @param {object} input
 * @param {string} input.projectDir - 项目目录（文档落在它下面的 `docs/`）
 * @param {object} input.catalog
 * @param {string} input.actorRole - ★ 调用方角色（**必须报**；需求分析角色会被拒）
 * @param {string} [input.taskId]
 * @param {string} [input.projectId]
 * @param {Date} [input.now]
 * @param {boolean} [input.dryRun]
 * @returns {Promise<{ok:true, path:string, bytes:number, written:boolean, stats:object}
 *          |{ok:false, code:string, message:string, issues?:Array<object>}>}
 */
export async function writeProductDesignDoc(input = {}) {
  const actor = String(input.actorRole ?? '').trim()
  if (actor.length === 0) {
    return {
      ok: false,
      code: 'NO_ACTOR_ROLE',
      message: '落盘产品设计文档必须报出调用方角色（留档 / docs）—— 不报角色就落盘，等于把 readonly 纪律捅穿。',
    }
  }
  if (actor === READONLY_CATALOG_AUTHOR) {
    return {
      ok: false,
      code: 'READONLY_ROLE_CANNOT_WRITE',
      message:
        `拒绝：需求分析角色（\`${actor}\`）**不落盘文件** —— 它只产出结构化产品目录（验收 A14：需求 agent 的 readonly 不被破）。\n` +
        '★ 正确路径：需求 agent 把产品目录放进 requirement_analysis 交接物 → 由**留档**角色落 `docs/product-design.md`。',
    }
  }
  if (!DOC_WRITER_ROLES.includes(actor)) {
    return {
      ok: false,
      code: 'ROLE_NOT_DOC_WRITER',
      message: `落盘产品设计文档的角色必须是 ${DOC_WRITER_ROLES.join(' / ')}（当前是 \`${actor}\`）。`,
    }
  }

  const projectDir = String(input.projectDir ?? '').trim()
  if (projectDir.length === 0) return { ok: false, code: 'NO_PROJECT_DIR', message: '落盘产品设计文档需要项目目录。' }

  const rendered = renderProductDesignDoc(input)
  if (!rendered.ok) {
    return { ok: false, code: 'CATALOG_INVALID', message: rendered.message, issues: rendered.issues }
  }

  const path = join(resolve(projectDir), PRODUCT_DESIGN_REL)
  if (input.dryRun === true) {
    return { ok: true, path, bytes: Buffer.byteLength(rendered.markdown, 'utf8'), written: false, stats: rendered.stats }
  }
  const dir = dirname(path)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(path, rendered.markdown, 'utf8')
  return { ok: true, path, bytes: Buffer.byteLength(rendered.markdown, 'utf8'), written: true, stats: rendered.stats }
}

/**
 * 读回文档的"体检结果"（给测试与状态展示用）。
 *
 * @param {string} projectDir
 * @returns {{path:string, exists:boolean, rel:string}}
 */
export function inspectProductDesignDoc(projectDir) {
  const path = join(resolve(String(projectDir ?? '')), PRODUCT_DESIGN_REL)
  return { path, exists: existsSync(path), rel: PRODUCT_DESIGN_REL }
}
