/**
 * p11 · 角色专属 Agent 预设（`presets/`）
 * ============================================================================
 *     node tests/p11-presets-check.mjs
 *
 * 判据（六条，逐条可红）：
 *   ① **角色集合双向相等** —— `presets/_index.json` 的 key 集合 ≡ `lib/roles.js` 的
 *      `ALL_ROLE_IDS`（**import** 它；本文件不另抄一份角色清单）。
 *   ② **每目录文件齐全** —— 三个首尾提示词角色（writer / reviewer / supervisor）
 *      各 **6 件**（多了 prefix.md + suffix.md），其余各 **4 件**；目录数 = 16。
 *   ③ **`meta.id === 'pl-' + role`**，16 个 id 互不重复，且与 5 个既有 shipped
 *      preset id（standard / ptc / minimal / cordis / computer-use）**无交集**。
 *   ④ **权限档取值合法** —— 落在 readonly | own-log | own-dir | workdir 之内，
 *      且与 `lib/guard/rules.js` 的 `writeClassOf()` 的映射**逐角色一致**；
 *      四档的**分布**也断言（从 writeClassOf 现算，不手抄）。
 *   ⑤ **生成物可被 YAML 解析** —— 用运行时自带的 YAML 解析器解析
 *      `generated/pipeline-presets.patch.yml`：顶层是数组、展开后有 16 条 insert、
 *      `config.id` 唯一且逐个正确、`config.plugins` 里**恰有一条** `dsh-persona`
 *      且 prefix/suffix 非空、行 name 全是 `@deepseek-ai/dsh-agent-preset`。
 *      解析器找不到时**如实写"未校验"并判红**（不当作通过）。
 *   ⑥ **负例自证** —— 在**临时副本**上删角色目录 / 删 suffix.md / 改 meta.id，
 *      `validatePresets()` 必须**变红**且点名到具体文件。全程不碰真树。
 *   ⑦ **plugin 行的 config 过该插件自己的 schema**（2026-10-15 真机缺陷）——
 *      宿主拿每个插件的 schemastery schema 校验这一行的 `config`，
 *      `.required()` 的键缺一个 ⇒ **整条预设挂不起来**（现场：16 张卡片全标
 *      「加载失败」，原文 `$.sampleOverCapGlobResults missing required value`）。
 *      本套在**解析出来的产物行**上判，并与 shipped 预设逐字对齐；另加两条反例
 *      （删 config / 自己发明 config）自证"判据真的会红"。
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * @module dsh-pipeline/tests/p11-presets-check
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ALL_ROLE_IDS, ROLES } from '../lib/roles.js'
import { writeClassOf } from '../lib/guard/rules.js'
import { validatePresets, permissionOfWriteClass, LEGAL_PERMISSIONS, ROLES_WITH_TAILS, REQUIRED_FILES } from '../presets/validate.js'
import { renderPatch, PRESET_MODULE, PERSONA_MODULE, BASE_PLUGIN_ROWS, readCapabilityRows } from '../presets/render.js'
import { checkPluginRowGate } from './p11-plugin-rows-check.mjs'
import {
  checkAgainstShipped,
  checkPluginRows,
  findDshAsar,
  listShippedPresetFiles,
  openAsar,
  readPluginSchemas,
  shippedRowFacts,
} from '../presets/plugin-schema.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const PRESETS = join(PKG, 'presets')

/** ★ 既有 shipped preset id —— 只此一处，判据③与负例共用。 */
export const EXISTING_PRESET_IDS = ['standard', 'ptc', 'minimal', 'cordis', 'computer-use']

/**
 * ★ **只有 main 多出来的那几件源文件**（用户第 1 件，2026-10-16）：
 *   · `prefix.md` / `suffix.md` —— persona 的三句话（平常不许用 / 必要时应先申请 / 最好别碰）
 *   · `capability.json` —— 能力追加行（`pl-main` 不低于 `preset-computer-use`）
 *
 * 为什么写成**白名单常量**而不是"多出来的文件就放过"：后者会让"某个角色目录里多出一个
 * 谁也不认识的文件"变成永远绿。多一条就得改这一行 —— 判据仍然会红。
 */
import { EXTRA_FILES_BY_ROLE, MAIN_EXTRA_FILES, UNVERIFIABLE_MODULES } from './preset-package-facts.js'

/**
 * 找运行时自带的 YAML 解析器。
 * ★ 认不出就**如实返回 null**（调用方判红），不静默降级成"通过"。
 */
async function findYamlParser() {
  const tries = []
  tries.push(['yaml', 'yaml'])
  tries.push(['js-yaml', 'js-yaml'])
  const profiles = join(homedir(), '.dsh', 'profiles')
  if (existsSync(profiles)) {
    for (const p of readdirSync(profiles)) {
      tries.push([`profile:${p}/yaml`, join(profiles, p, 'node_modules', 'yaml', 'dist', 'index.js')])
      tries.push([`profile:${p}/js-yaml`, join(profiles, p, 'node_modules', 'js-yaml', 'dist', 'js-yaml.mjs')])
    }
  }
  for (const [label, spec] of tries) {
    try {
      const mod = spec.startsWith('/') || /^[A-Za-z]:/.test(spec) ? await import(pathToFileURL(spec).href) : await import(spec)
      const parse = mod.parse ?? mod.default?.parse ?? mod.load ?? mod.default?.load
      if (typeof parse === 'function') return { label, parse }
    } catch {
      /* 下一个 */
    }
  }
  return null
}

/** 主运行器。@returns {Promise<{passed:number,total:number,text:string}>} */
export async function runPresetsCheck() {
  const lines = []
  let passed = 0
  let total = 0
  const ok = (cond, label, detail = '') => {
    total += 1
    if (cond) {
      passed += 1
      lines.push(`  ✓ ${label}${detail ? ` —— ${detail}` : ''}`)
    } else {
      lines.push(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
    }
    return Boolean(cond)
  }

  lines.push('='.repeat(78))
  lines.push('p11 · 角色专属 Agent 预设（16 条 @deepseek-ai/dsh-agent-preset）')
  lines.push('='.repeat(78))

  const index = JSON.parse(readFileSync(join(PRESETS, '_index.json'), 'utf8'))
  const roles = Object.keys(index.presets)

  // ── ① 角色集合双向相等 ────────────────────────────────────────────────
  const want = [...ALL_ROLE_IDS].sort()
  const got = [...roles].sort()
  ok(
    want.length === got.length && want.every((r, i) => r === got[i]),
    '① 角色集合与 lib/roles.js 的 ALL_ROLE_IDS 双向相等',
    `ALL_ROLE_IDS=${want.length} · _index.json=${got.length}`,
  )
  ok(
    want.filter((r) => !got.includes(r)).length === 0 && got.filter((r) => !want.includes(r)).length === 0,
    '① 双向差集都为空（多一个 / 少一个都算错）',
    `缺=${JSON.stringify(want.filter((r) => !got.includes(r)))} · 多=${JSON.stringify(got.filter((r) => !want.includes(r)))}`,
  )

  // ── ② 每目录文件齐全 ────────────────────────────────────────────────
  const dirCounts = {}
  for (const role of roles) {
    const dir = join(PRESETS, index.presets[role].dir)
    dirCounts[role] = existsSync(dir) ? readdirSync(dir).length : -1
  }
  const tailRoles = roles.filter((r) => ROLES_WITH_TAILS.includes(r))
  const plainRoles = roles.filter((r) => !ROLES_WITH_TAILS.includes(r))
  ok(
    tailRoles.length === 3 && tailRoles.every((r) => dirCounts[r] === REQUIRED_FILES.length + 2),
    `② 三个首尾提示词角色各 ${REQUIRED_FILES.length + 2} 件（${ROLES_WITH_TAILS.join(' / ')}）`,
    tailRoles.map((r) => `${r}=${dirCounts[r]}`).join(' '),
  )
  ok(
    plainRoles.length === roles.length - 3 &&
      plainRoles.every((r) => dirCounts[r] === REQUIRED_FILES.length + (EXTRA_FILES_BY_ROLE[r] ?? []).length),
    `② 其余 ${plainRoles.length} 个角色各 ${REQUIRED_FILES.length} 件（${Object.keys(EXTRA_FILES_BY_ROLE).join(' / ')} 另有 ${MAIN_EXTRA_FILES.join(' / ')}）`,
    `例：${plainRoles.slice(0, 3).map((r) => `${r}=${dirCounts[r]}`).join(' ')}`,
  )
  const missingFiles = []
  for (const role of roles) {
    const dir = join(PRESETS, index.presets[role].dir)
    const need = [...REQUIRED_FILES, ...(ROLES_WITH_TAILS.includes(role) ? ['prefix.md', 'suffix.md'] : [])]
    for (const f of need) if (!existsSync(join(dir, f))) missingFiles.push(`${role}/${f}`)
  }
  ok(missingFiles.length === 0, '② 逐文件点名检查：无缺失', missingFiles.join(', ') || '16 个目录全部齐全')

  // ── ③ meta.id === 'pl-' + role 且不撞车 ─────────────────────────────
  const metas = {}
  for (const role of roles) metas[role] = JSON.parse(readFileSync(join(PRESETS, index.presets[role].dir, 'meta.json'), 'utf8'))
  const badId = roles.filter((r) => metas[r].id !== `${index.presetIdPrefix}${r}`)
  ok(badId.length === 0, `③ meta.id 逐角色等于 '${index.presetIdPrefix}' + role`, badId.map((r) => `${r}:${metas[r].id}`).join(' ') || `${roles.length} 个全对`)
  const ids = roles.map((r) => metas[r].id)
  const dupIds = ids.filter((v, i) => ids.indexOf(v) !== i)
  ok(dupIds.length === 0, '③ 16 个 config.id 互不重复', [...new Set(dupIds)].join(', ') || `${ids.length} 个唯一`)
  const clash = ids.filter((v) => EXISTING_PRESET_IDS.includes(v))
  ok(clash.length === 0, `③ 与既有 ${EXISTING_PRESET_IDS.length} 个 shipped id 无交集`, clash.join(', ') || `既有=${EXISTING_PRESET_IDS.join(' / ')}`)
  ok(
    EXISTING_PRESET_IDS.every((v) => index.reservedPresetIds.includes(v)),
    '③ _index.json 的 reservedPresetIds 覆盖了全部既有 id（撞车判据的取值域与测试同源）',
    index.reservedPresetIds.join(' / '),
  )

  // ── ④ 权限档取值合法 + 与 writeClassOf 一致 ─────────────────────────
  const perms = {}
  for (const role of roles) perms[role] = JSON.parse(readFileSync(join(PRESETS, index.presets[role].dir, 'permission.json'), 'utf8'))
  const illegal = roles.filter((r) => !LEGAL_PERMISSIONS.includes(perms[r].permission))
  ok(illegal.length === 0, `④ 权限档取值全在 ${LEGAL_PERMISSIONS.join(' | ')} 内`, illegal.map((r) => `${r}:${perms[r].permission}`).join(' ') || `${roles.length} 个全合法`)
  const mismatched = roles.filter((r) => perms[r].permission !== permissionOfWriteClass(writeClassOf(r)))
  ok(
    mismatched.length === 0,
    '④ 逐角色与 writeClassOf() 的映射一致（档位不是手抄的）',
    mismatched.map((r) => `${r}: ${perms[r].permission} ≠ ${permissionOfWriteClass(writeClassOf(r))}`).join(' ') || '16/16 一致',
  )
  const dist = {}
  for (const r of roles) dist[perms[r].permission] = (dist[perms[r].permission] ?? 0) + 1
  const wantDist = {}
  for (const r of ALL_ROLE_IDS) {
    const p = permissionOfWriteClass(writeClassOf(r))
    wantDist[p] = (wantDist[p] ?? 0) + 1
  }
  ok(
    JSON.stringify(dist) === JSON.stringify(wantDist),
    '④ 四档分布与 ALL_ROLE_IDS 现算的分布相等',
    `实测=${JSON.stringify(dist)} 期望=${JSON.stringify(wantDist)}`,
  )

  // ── ⑤ 生成物可被 YAML 解析 ──────────────────────────────────────────
  const genPath = join(PRESETS, index.generated)
  ok(existsSync(genPath), `⑤ 产物存在：${index.generated}`, existsSync(genPath) ? `${readFileSync(genPath, 'utf8').length} 字节` : '不存在')
  const parser = await findYamlParser()
  if (parser === null) {
    ok(false, '⑤ YAML 解析', '未校验：找不到 YAML 解析器（如实登记，**不当作通过**）')
  } else {
    let parsed = null
    let err = ''
    try {
      parsed = parser.parse(readFileSync(genPath, 'utf8'))
    } catch (e) {
      err = String(e?.message ?? e)
    }
    ok(parsed !== null, `⑤ 生成物可被 YAML 解析（解析器：${parser.label}）`, err)
    const entries = Array.isArray(parsed) ? parsed.flatMap((e) => e?.insert ?? []) : []
    ok(entresOk(entries), '⑤ 顶层数组展开后 = 16 条 insert，且 name 全是 @deepseek-ai/dsh-agent-preset', `实际 ${entries.length} 条`)
    const cfgIds = entries.map((e) => e?.config?.id)
    const uniq = new Set(cfgIds)
    ok(
      cfgIds.length === roles.length && uniq.size === roles.length && roles.every((r, i) => cfgIds.includes(`${index.presetIdPrefix}${r}`)) ,
      '⑤ config.id 唯一且逐个正确',
      `唯一 ${uniq.size} 个：${[...uniq].slice(0, 4).join(', ')}…`,
    )
    const personaBad = []
    for (const e of entries) {
      const rows = Array.isArray(e?.config?.plugins) ? e.config.plugins : []
      const personas = rows.filter((r) => r?.name === PERSONA_MODULE)
      if (personas.length !== 1) personaBad.push(`${e?.config?.id}: persona×${personas.length}`)
      else if (!personas[0]?.config?.prefix || !personas[0]?.config?.suffix) personaBad.push(`${e?.config?.id}: prefix/suffix 为空`)
    }
    ok(personaBad.length === 0, '⑤ 每条预设里恰有一条 dsh-persona，且 prefix/suffix 均非空', personaBad.join(' ') || '16/16')
    const wsBad = roles.filter((r) => {
      const e = entries.find((x) => x?.config?.id === `${index.presetIdPrefix}${r}`)
      const p = e?.config?.plugins?.find((x) => x?.name === PERSONA_MODULE)?.config?.prefix ?? ''
      return !p.includes(ROLES[r].zh)
    })
    ok(wsBad.length === 0, '⑤ 每条预设的 persona prefix 里含该角色的中文名（提示词真的落到那条上）', wsBad.join(', ') || '16/16')
    const suffixRoles = roles.filter((r) => ROLES_WITH_TAILS.includes(r))
    const tallyBad = []
    for (const r of suffixRoles) {
      const e = entries.find((x) => x?.config?.id === `${index.presetIdPrefix}${r}`)
      const pc = e?.config?.plugins?.find((x) => x?.name === PERSONA_MODULE)?.config
      const tail = readFileSync(join(PRESETS, index.presets[r].dir, 'suffix.md'), 'utf8').trim().split('\n').pop()
      if (!String(pc?.suffix ?? '').includes(tail)) tallyBad.push(r)
      const head = readFileSync(join(PRESETS, index.presets[r].dir, 'prefix.md'), 'utf8').trim().split('\n').pop()
      if (!String(pc?.prefix ?? '').includes(head)) tallyBad.push(`${r}(prefix)`)
    }
    ok(tallyBad.length === 0, '⑤ 三个角色的 prefix.md/suffix.md 末行都出现在 persona 的 prefix/suffix 里', tallyBad.join(', ') || '3/3')
    // ★ 2026-10-16 口径升级（用户原话）：「文件除了行数要求外，应该是按模块能拆就拆，
    //   除非有必要，写入预设和身体提示中（开头结尾的提示）」。
    //   判据：三个角色的**开头与结尾**提示里都必须出现「默认拆 + 四条必要性」的措辞，
    //   而且**产物里**也要有（改了 markdown 不重跑渲染 ⇒ 提示词还是旧口径）。
    const decls = ['能拆就拆', '①', '②', '③', '④', '超 400 行']
    const missingDecl = []
    for (const r of ['writer', 'reviewer', 'supervisor']) {
      for (const f of ['prefix.md', 'suffix.md']) {
        const txt = readFileSync(join(PRESETS, index.presets[r].dir, f), 'utf8')
        for (const d of decls) if (!txt.includes(d)) missingDecl.push(`${r}/${f}:${d}`)
      }
    }
    ok(missingDecl.length === 0, '⑤ ★ 三个角色的首尾提示都写了「默认拆 + 四条必要性 + 超 400 先自证」', missingDecl.join(', ') || '6/6 文件齐')
    const prod = readFileSync(genPath, 'utf8')
    ok(
      (prod.match(/按模块能拆就拆/g) ?? []).length >= 3 && !prod.includes('不得因此打回'),
      '⑤ ★ 产物里也是**新口径**（旧文案「不得因此打回」已消失 —— 改 markdown 必须重跑渲染）',
      `新措辞 ${(prod.match(/按模块能拆就拆/g) ?? []).length} 处 · 旧措辞 ${(prod.match(/不得因此打回/g) ?? []).length} 处`,
    )
    const need = ['reviewer', 'supervisor'].filter((r) => !readFileSync(join(PRESETS, index.presets[r].dir, 'suffix.md'), 'utf8').includes('说不出任一条'))
    ok(need.length === 0, '⑤ ★ 审核 / 主管的收尾提示要求"说不出任一条 ⇒ 视为应该拆"（默认期望是拆开的）', need.join(', ') || 'reviewer + supervisor')
  }
  // 与源一致（在进程内重渲染比对 —— 沙箱下不起子进程）
  ok(readFileSync(genPath, 'utf8') === renderPatch(index), '⑤ 生成物与 src/ 一致（重渲染逐字节相等）', '过期就重跑 node presets/render.js')

  // ── ⑥ 真树全绿 + 负例自证 ───────────────────────────────────────────
  const real = validatePresets()
  ok(real.ok, '⑥ validate.js 在真树上全绿', real.errors.join(' | ') || `${real.counts.roles} 角色 / ${real.counts.files} 源文件`)

  const tmp = join(tmpdir(), `p11-presets-${process.pid}-${Date.now()}`)
  const copy = join(tmp, 'presets')
  try {
    mkdirSync(tmp, { recursive: true })
    cpSync(PRESETS, copy, { recursive: true })

    // 负例 a：删一个角色目录
    const gone = 'arbiter'
    rmSync(join(copy, index.presets[gone].dir), { recursive: true, force: true })
    const rA = validatePresets({ root: copy })
    ok(
      !rA.ok && rA.errors.some((e) => e.includes(gone)),
      `⑥ 负例 a：删掉 src/${gone}/ ⇒ 必须变红且点名 ${gone}`,
      rA.ok ? '**没红**（假绿）' : rA.errors[0],
    )

    // 恢复到副本，再制造负例 b：删一个首尾提示词文件
    cpSync(PRESETS, copy, { recursive: true, force: true })
    rmSync(join(copy, index.presets.writer.dir, 'suffix.md'), { force: true })
    const rB = validatePresets({ root: copy })
    ok(
      !rB.ok && rB.errors.some((e) => e.includes('suffix.md')),
      '⑥ 负例 b：删掉 src/writer/suffix.md ⇒ 必须变红且点名 suffix.md',
      rB.ok ? '**没红**（假绿）' : rB.errors[0],
    )

    // 负例 c：把 meta.id 改成与既有 preset 撞车
    cpSync(PRESETS, copy, { recursive: true, force: true })
    const mp = join(copy, index.presets.main.dir, 'meta.json')
    const m = JSON.parse(readFileSync(mp, 'utf8'))
    m.id = 'cordis'
    writeFileSync(mp, JSON.stringify(m, null, 2) + '\n', 'utf8')
    const rC = validatePresets({ root: copy })
    ok(
      !rC.ok && rC.errors.some((e) => e.includes('cordis')),
      '⑥ 负例 c：把 main 的 config.id 改成既有 shipped id `cordis` ⇒ 必须变红（撞车）',
      rC.ok ? '**没红**（假绿）' : rC.errors[0],
    )

    // 负例 d：把权限档改成非法值
    cpSync(PRESETS, copy, { recursive: true, force: true })
    const pp = join(copy, index.presets.tester.dir, 'permission.json')
    const pj = JSON.parse(readFileSync(pp, 'utf8'))
    pj.permission = 'root'
    writeFileSync(pp, JSON.stringify(pj, null, 2) + '\n', 'utf8')
    const rD = validatePresets({ root: copy })
    ok(
      !rD.ok && rD.errors.some((e) => e.includes('root')),
      '⑥ 负例 d：权限档改成 `root` ⇒ 必须变红（取值域）',
      rD.ok ? '**没红**（假绿）' : rD.errors[0],
    )

    // 负例 e：改一个 tools.json（声明面与守门失联）⇒ 生成物过期必须被发现
    cpSync(PRESETS, copy, { recursive: true, force: true })
    const tp = join(copy, index.presets.docs.dir, 'tools.json')
    const tj = JSON.parse(readFileSync(tp, 'utf8'))
    tj.visible = [...tj.visible, 'pipeline_not_a_real_tool']
    tj.visible_count = tj.visible.length
    writeFileSync(tp, JSON.stringify(tj, null, 2) + '\n', 'utf8')
    const rE = validatePresets({ root: copy })
    ok(
      !rE.ok && rE.errors.some((e) => e.includes('pipeline_not_a_real_tool') || e.includes('过期')),
      '⑥ 负例 e：tools.json 里塞一个不存在的工具名 ⇒ 必须变红（工具名全集 / 产物过期）',
      rE.ok ? '**没红**（假绿）' : rE.errors[0],
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  ok(!existsSync(tmp), '⑥ 临时副本已清理（零残留）', tmp)

  // ⑦ plugin 行的 config 双判（插件自己的 schema + shipped 范本）已抽成
  //   `tests/p11-plugin-rows-check.mjs`（一文件一职责；本文件只负责把上下文递过去）。
  checkPluginRowGate({ ok, roles, parser, genPath, real, index, readCapabilityRows, PRESETS, BASE_PLUGIN_ROWS, schemaApi: { checkAgainstShipped, checkPluginRows, findDshAsar, listShippedPresetFiles, openAsar, readPluginSchemas, shippedRowFacts } })
  lines.push('')
  lines.push(`  ── p11 小结：${passed}/${total} ──`)
  return { passed, total, text: lines.join('\n') }
}

/** 16 条 insert 且 name 全对。 */
function entresOk(entries) {
  return entries.length === 16 && entries.every((e) => e?.name === PRESET_MODULE && typeof e?.id === 'string')
}

// ---------------------------------------------------------------- CLI
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(HERE, 'p11-presets-check.mjs')
if (invokedDirectly) {
  const r = await runPresetsCheck()
  console.log(r.text)
  console.log(`p11: ${r.passed}/${r.total}`)
  process.exit(r.passed === r.total ? 0 : 1)
}
