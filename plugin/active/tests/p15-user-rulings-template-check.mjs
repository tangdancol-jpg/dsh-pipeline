/**
 * p15 · 跨项目「用户裁定」库的**模板随插件发布**（用户追加要求：例外一）
 * ============================================================================
 *     node tests/p15-user-rulings-template-check.mjs
 *
 * 背景：裁定库运行时落在 `<dsh-home>/skills/pipeline-user-rulings/SKILL.md` ——
 * **用户主目录，不在插件里**。别人部署**不该**拿到别人的裁定内容（那是对的）。
 * 但**形状**必须随插件走，否则每个部署方长出来的文件各不一样、也没人知道怎么写。
 *
 * 判据（每条都能红）：
 *   ① **模板在随插件发布的位置上**（`plugin/active/skills/…template.md`）；
 *   ② 模板里的 **marker / begin / end 三个标记逐字等于** `lib/memory/live-doc-render.js`
 *      的常量（漂了就红 —— 不许手抄第二份）；
 *   ③ `parseSkillFile(模板)` 认它是**我们的**文件（`ours === true`）⇒ 部署方照它抄出来的
 *      文件是**合法产物**，不是"外来文件"；
 *   ④ **模板不在运行时会写的那个路径上**（否则 `publishRulings` 会永远判
 *      `FOREIGN_SKILL_EXISTS`，一个字节都写不出去）；
 *   ⑤ 负例自证：把 marker 从模板里删掉 ⇒ `parseSkillFile` 立刻判 `ours === false`。
 *
 * 退出码：0 = 全绿；1 = 有失败。
 * @module dsh-pipeline/tests/p15-user-rulings-template-check
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RULINGS_BEGIN, RULINGS_END, RULINGS_MARKER, RULINGS_SKILL_NAME } from '../lib/memory/live-doc-render.js'
import { parseSkillFile } from '../lib/memory/user-rulings.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const TEMPLATE = join(PKG, 'skills', 'pipeline-user-rulings.template.md')

/** 主运行器。@returns {Promise<{passed:number,total:number,text:string}>} */
export async function runP15UserRulingsTemplateCheck() {
  const lines = []
  let passed = 0
  let total = 0
  const ok = (cond, label, detail = '') => {
    total += 1
    if (cond) passed += 1
    lines.push(`  ${cond ? '✓' : '✗'} ${label}${detail ? `　—— ${detail}` : ''}`)
    return Boolean(cond)
  }

  lines.push('='.repeat(78))
  lines.push('p15 · 跨项目裁定库的模板随插件发布（形状可复制、内容不越界）')
  lines.push('='.repeat(78))

  // ---- ① 位置 --------------------------------------------------------------
  ok(existsSync(TEMPLATE), '① 模板在插件包里（`skills/<名字>.template.md`）', TEMPLATE.replace(PKG, '<插件>'))
  const text = existsSync(TEMPLATE) ? readFileSync(TEMPLATE, 'utf8') : ''

  // ---- ④ 不在运行时会写的那个路径上 ----------------------------------------
  ok(
    !TEMPLATE.endsWith(join(RULINGS_SKILL_NAME, 'SKILL.md')),
    '④ 模板**不在**运行时会写的路径上（否则 `publishRulings` 永远判 FOREIGN_SKILL_EXISTS）',
    `运行时落点：<dsh-home>/skills/${RULINGS_SKILL_NAME}/SKILL.md`,
  )

  // ---- ② 三个标记逐字同源 ---------------------------------------------------
  ok(text.includes(RULINGS_MARKER), '② marker 逐字等于 `live-doc-render.js` 的常量（不许手抄）', RULINGS_MARKER)
  ok(text.includes(RULINGS_BEGIN), '② 受管区块起点逐字同源', RULINGS_BEGIN)
  ok(text.includes(RULINGS_END), '② 受管区块终点逐字同源', RULINGS_END)
  ok(text.includes(`name: ${RULINGS_SKILL_NAME}`), '② frontmatter 的 `name` 与运行时常量同源', `name: ${RULINGS_SKILL_NAME}`)

  // ---- ③ 模板是"合法产物形状" ----------------------------------------------
  const parsed = parseSkillFile(text)
  ok(parsed.ours === true, '③ `parseSkillFile(模板)` 认它是我们的文件（ours === true）', `ours=${parsed.ours}`)
  ok(parsed.rulings.length === 0, '③ 模板里**一条裁定都没有**（不冒充别人的裁定内容）', `${parsed.rulings.length} 条`)

  // ---- ⑤ 负例自证 -----------------------------------------------------------
  const tmp = mkdtempSync(join(tmpdir(), 'p15-'))
  try {
    const p = join(tmp, 'SKILL.md')
    writeFileSync(p, text.split(RULINGS_MARKER).join('<!-- 谁把这行删了 -->'), 'utf8')
    ok(parseSkillFile(readFileSync(p, 'utf8')).ours === false, '⑤ 负例：删掉 marker ⇒ `ours` 立刻变 false（判据真的在判东西）', 'marker 是唯一的身份依据')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  lines.push('')
  lines.push(`p15 总计：${passed}/${total} 通过`)
  return { passed, total, text: lines.join('\n') }
}

// 直接运行
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const r = await runP15UserRulingsTemplateCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
