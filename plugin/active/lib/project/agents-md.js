// AGENTS.md · 渲染与幂等落盘：模板独立成文件，已存在则**不覆盖**、缺哪段补哪段。
/**
 * dsh-pipeline · AGENTS.md · 渲染与幂等落盘
 * ============================================================================
 * 定稿 §3.2：
 *   · 位置：**项目目录根**；
 *   · 内容：**两条纪律**（纪律一的原文与纪律二的原文都在模板文件里，本文件一个字都不复述）；
 *   · **幂等**：已存在则**不覆盖**（缺段落可补）；
 *   · 模板**独立成文件**（不硬编码进 js）；
 *   · 落盘后提交一个 commit（那一步归 `git-init.js` / 工具面，不在本文件）。
 *
 * ---------------------------------------------------------------------------
 * 幂等的四种情形（验收 A12 / T04，逐条可判定）
 * ---------------------------------------------------------------------------
 *   ① 文件**不存在**            ⇒ `action:'created'`，写全文；
 *   ② 文件存在、段落**齐全**    ⇒ `action:'unchanged'`，**一个字节都不写**；
 *   ③ 文件存在但是**空文件**    ⇒ `action:'completed'`，写全文（边界：「视为缺全部段落，补齐，不计为覆盖」）；
 *   ④ 文件存在、缺**部分**段落  ⇒ `action:'appended'`，**只追加缺的段落**，已有行逐字保留。
 *
 * ★ 判定靠模板里的段落标记（`<!-- pipeline:section:<id> -->`），不靠标题文字匹配 ——
 *   标题是给人改的（用户完全可能把"纪律一"改成"规矩一"），标记不是。
 *
 * @module dsh-pipeline/lib/project/agents-md
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AGENTS_MD } from './layout.js'

/** 模板文件就在本模块旁边（同目录）。 */
export const TEMPLATE_FILE = 'agents-md.template.md'

/** 模板里**必须**有的段落标记（缺一个就说明模板被改坏了 —— 那时宁可报错，不要静默少写一段）。 */
export const REQUIRED_SECTIONS = Object.freeze(['discipline-commit', 'discipline-test', 'version-mode'])

/** 段落标记的正则（唯一出处）。 */
export const SECTION_RE = /<!--\s*pipeline:section:([a-z0-9-]+)\s*-->/g

/**
 * 模板文件路径。
 *
 * @param {string} [base] - 覆盖用（测试可指到别处）
 * @returns {string}
 */
export function templatePath(base) {
  if (typeof base === 'string' && base.length > 0) return resolve(base)
  return join(dirname(fileURLToPath(import.meta.url)), TEMPLATE_FILE)
}

/** 读模板（读不到就报可读原因，不返回空串 —— 空模板会写出一个空 AGENTS.md）。 */
export async function readTemplate(path) {
  const file = templatePath(path)
  if (!existsSync(file)) {
    return { ok: false, code: 'TEMPLATE_MISSING', message: `AGENTS.md 模板找不到：${file}` }
  }
  const raw = await readFile(file, 'utf8')
  if (raw.trim().length === 0) {
    return { ok: false, code: 'TEMPLATE_EMPTY', message: `AGENTS.md 模板是空文件：${file}` }
  }
  return { ok: true, text: raw, file }
}

/**
 * 按 `mode` 取舍 variant 块，并替换占位符。
 *
 * 处理顺序（**不能换**）：
 *   ① **丢掉模板自己的文件头**（`<!-- pipeline:template -->` + 紧跟的那段 HTML 注释）——
 *      那是写给**改模板的人**看的（语法说明、为什么模板独立成文件），
 *      它一旦进了 `AGENTS.md`，就等于在每个项目里都贴一份"这是模板"的说明，
 *      而且里面的语法示例（`pipeline:variant:…`）还会被后续步骤误当成真标记。
 *   ② variant 块：匹配 `mode` 的块**保留内容、去掉包裹标记**；不匹配的块**整块丢掉**；
 *   ③ 占位符替换。
 *
 * @param {string} template
 * @param {'git'|'snapshot'} mode
 * @param {Record<string,string>} tokens
 * @returns {string}
 */
export function renderTemplate(template, mode, tokens = {}) {
  let out = stripTemplateHeader(template)
  const blockRe = /<!--\s*pipeline:variant:([a-z0-9-]+)\s*-->([\s\S]*?)<!--\s*pipeline:endvariant\s*-->/g
  out = out.replace(blockRe, (_all, name, body) => (name === mode ? body.replace(/^\n/, '').replace(/\n$/, '') : ''))
  out = out.replace(/\{\{([A-Z0-9_]+)\}\}/g, (all, key) => (tokens[key] === undefined ? all : String(tokens[key])))
  // 折叠替换后可能出现的连续空行（variant 被丢掉时会留下空档）
  out = out.replace(/\n{3,}/g, '\n\n')
  return out
}

/**
 * 丢掉模板文件**自己的头注释**（`<!-- pipeline:template -->` + 紧跟的一段注释）。
 *
 * @param {string} template
 * @returns {string}
 */
export function stripTemplateHeader(template) {
  let out = String(template ?? '')
  out = out.replace(/^\s*<!--\s*pipeline:template\s*-->\s*/, '')
  out = out.replace(/^<!--[\s\S]*?-->\s*/, '')
  return out.replace(/^\s+/, '')
}

/**
 * 把渲染结果切成"段落"：`[{id, text}]`，`text` 含段落标记本身。
 *
 * 段落 = 从它的标记开始，到**下一个标记**（或文末）为止。
 *
 * @param {string} text
 * @returns {Array<{id:string, text:string}>}
 */
export function splitSections(text) {
  const src = String(text ?? '')
  const marks = []
  const re = new RegExp(SECTION_RE.source, 'g')
  let m
  while ((m = re.exec(src)) !== null) marks.push({ id: m[1], index: m.index })
  const out = []
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length
    out.push({ id: marks[i].id, text: src.slice(marks[i].index, end).replace(/\s+$/, '') })
  }
  return out
}

/** 一份 AGENTS.md 里已有的段落 id。 */
export function sectionIdsOf(text) {
  const ids = []
  const re = new RegExp(SECTION_RE.source, 'g')
  let m
  while ((m = re.exec(String(text ?? ''))) !== null) ids.push(m[1])
  return ids
}

/**
 * ★ **幂等落盘**（四种情形见文件头）。
 *
 * @param {object} input
 * @param {string} input.projectDir - 项目目录（AGENTS.md 落在它**根**下）
 * @param {'git'|'snapshot'} [input.mode] - 版本方式（决定 variant 块）
 * @param {string} [input.projectId]
 * @param {string} [input.taskId]
 * @param {Date} [input.now]
 * @param {string} [input.templateFile] - 覆盖模板路径（测试用）
 * @param {boolean} [input.dryRun]
 * @returns {Promise<{ok:true, path:string, action:'created'|'unchanged'|'completed'|'appended',
 *                    written:boolean, added:string[], kept:string[]}
 *          |{ok:false, code:string, message:string}>}
 */
export async function ensureAgentsMd(input = {}) {
  const projectDir = String(input.projectDir ?? '').trim()
  if (projectDir.length === 0) {
    return { ok: false, code: 'NO_PROJECT_DIR', message: '要落 AGENTS.md 却没给项目目录。' }
  }
  const path = join(resolve(projectDir), AGENTS_MD)

  const tpl = await readTemplate(input.templateFile)
  if (!tpl.ok) return tpl

  // 模板自身完整性：三个段落标记一个都不能少（少了就报错，别静默少写一段）。
  const tplIds = sectionIdsOf(tpl.text)
  const missingInTpl = REQUIRED_SECTIONS.filter((id) => !tplIds.includes(id))
  if (missingInTpl.length > 0) {
    return {
      ok: false,
      code: 'TEMPLATE_MISSING_SECTION',
      message: `AGENTS.md 模板缺段落标记：${missingInTpl.join('、')}（模板 ${tpl.file}）—— 模板被改坏了，宁可不写也不要写出残缺的纪律文件。`,
    }
  }

  const mode = input.mode === 'snapshot' ? 'snapshot' : 'git'
  const at = input.now instanceof Date ? input.now : new Date()
  const rendered = renderTemplate(tpl.text, mode, {
    PROJECT_ID: String(input.projectId ?? '(未命名项目)'),
    TASK_ID: String(input.taskId ?? '(未知)'),
    GENERATED_AT: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  })
  const renderedSections = splitSections(rendered)
  const byId = new Map(renderedSections.map((s) => [s.id, s.text]))

  // ---- ① 不存在 ⇒ 写全文 ----------------------------------------------------
  if (!existsSync(path)) {
    if (input.dryRun === true) {
      return { ok: true, path, action: 'created', written: false, added: [...REQUIRED_SECTIONS], kept: [] }
    }
    await writeFile(path, rendered, 'utf8')
    return { ok: true, path, action: 'created', written: true, added: [...REQUIRED_SECTIONS], kept: [] }
  }

  const existing = await readFile(path, 'utf8')

  // ---- ③ 空文件 ⇒ 视为缺全部段落，补齐 --------------------------------------
  if (existing.trim().length === 0) {
    if (input.dryRun === true) {
      return { ok: true, path, action: 'completed', written: false, added: [...REQUIRED_SECTIONS], kept: [] }
    }
    await writeFile(path, rendered, 'utf8')
    return { ok: true, path, action: 'completed', written: true, added: [...REQUIRED_SECTIONS], kept: [] }
  }

  const have = sectionIdsOf(existing)
  const missing = REQUIRED_SECTIONS.filter((id) => !have.includes(id))

  // ---- ② 齐全 ⇒ 一个字节都不写 ---------------------------------------------
  if (missing.length === 0) {
    return { ok: true, path, action: 'unchanged', written: false, added: [], kept: have }
  }

  // ---- ④ 缺部分 ⇒ **只追加**缺的段落，已有行逐字保留 ------------------------
  const blocks = missing.map((id) => byId.get(id)).filter((t) => typeof t === 'string' && t.length > 0)
  if (blocks.length !== missing.length) {
    return {
      ok: false,
      code: 'RENDER_MISSING_SECTION',
      message: `要补的段落 ${missing.join('、')} 在渲染结果里找不到 —— 模板与段落表对不上，不写。`,
    }
  }
  // 保证拼接处有且只有一个空行；**不改写** existing 里的任何一个字符。
  const head = existing.replace(/\s+$/, '')
  const merged = `${head}\n\n${blocks.join('\n\n')}\n`
  if (input.dryRun === true) {
    return { ok: true, path, action: 'appended', written: false, added: missing, kept: have }
  }
  await writeFile(path, merged, 'utf8')
  return { ok: true, path, action: 'appended', written: true, added: missing, kept: have }
}

/**
 * 读回一份 AGENTS.md 的"体检结果"（给测试与状态展示用）。
 *
 * @param {string} projectDir
 * @returns {Promise<{ok:true, exists:boolean, path:string, sections:string[],
 *                    missing:string[], hasCommitDiscipline:boolean, hasTestDiscipline:boolean}>}
 */
export async function inspectAgentsMd(projectDir) {
  const path = join(resolve(String(projectDir ?? '')), AGENTS_MD)
  if (!existsSync(path)) {
    return { ok: true, exists: false, path, sections: [], missing: [...REQUIRED_SECTIONS], hasCommitDiscipline: false, hasTestDiscipline: false }
  }
  const text = await readFile(path, 'utf8')
  const sections = sectionIdsOf(text)
  return {
    ok: true,
    exists: true,
    path,
    sections,
    missing: REQUIRED_SECTIONS.filter((id) => !sections.includes(id)),
    hasCommitDiscipline: sections.includes('discipline-commit'),
    hasTestDiscipline: sections.includes('discipline-test'),
  }
}
