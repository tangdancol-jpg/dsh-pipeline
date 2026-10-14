/**
 * dsh-pipeline · 分权落档 + 留档 AI 自测（更正 A）
 * ============================================================================
 *     node tests/records-check.mjs
 *
 * 验的是**分权写 + 专人汇总**：
 *   · 各角色 / 席位在 `records/` 下写**自己那份**（互不覆盖）
 *   · 提交必须**带席位令牌** —— 留档 AI 校验来路，拒绝匿名 / 冒名
 *   · 留档 AI 汇总成**唯一**的 `requirement.md`，每条内容**有来源**、可逐条追溯
 *   · 记录之间**矛盾**时它**不得自己拍板**
 *   · `requirement.md` 的**唯一写者**是留档 AI（上一轮"编排独占"已作废）
 *
 * @module dsh-pipeline/tests/records-check
 */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { callTool } from './selftest-core.mjs'
import { createMultiWriterFixture } from './writers-check.mjs'

const indent = (s, n = 4) =>
  String(s ?? '')
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n')

function createRecorder() {
  const items = []
  return {
    items,
    add(name, pass, detail) {
      items.push({ name, pass: pass === true, detail: String(detail ?? '') })
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
  }
}

const hit = (text, fragment) =>
  String(fragment)
    .split('|')
    .some((a) => a.length > 0 && String(text).includes(a))

function expectDenied(rec, name, res, mustContain = []) {
  const ok = res.denied === true && res.layer !== 'missing'
  const missing = mustContain.filter((s) => !hit(res.text, s))
  const pass = ok && missing.length === 0
  rec.add(name, pass, pass
    ? `拦截层：${res.layer}\n拒绝原文：\n${indent(res.text)}`
    : `期望被拒但 denied=${res.denied} layer=${res.layer}` +
      (missing.length > 0 ? `\n缺少关键片段：${missing.join(' ｜ ')}` : '') +
      `\n实际原文：\n${indent(res.text)}`)
  return pass
}

function expectOk(rec, name, res, mustContain = []) {
  const missing = mustContain.filter((s) => !hit(res.text, s))
  const pass = res.denied !== true && missing.length === 0
  rec.add(name, pass, pass
    ? `结果摘要：\n${indent(res.text)}`
    : `期望成功但被拒（layer=${res.layer}）${missing.length > 0 ? `，缺少：${missing.join(' / ')}` : ''}\n原文：\n${indent(res.text)}`)
  return pass
}

/** ★ 约定路径。 */
const reqMd = (root, id) => join(root, '.pipeline', id, 'requirement.md')
const recDir = (root, id) => join(root, '.pipeline', id, 'records')

// ---------------------------------------------------------------------------

export async function runRecordsCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // 正例①：各角色独立落档 + 带密钥提交 → 留档 AI 汇总
  // =========================================================================
  let fx = null
  try {
    fx = await createMultiWriterFixture({ writers: 1 })
    open.push(fx.h)
    const T = fx.taskId

    // ★ 自包含：显式把任务预热进**同步索引**（守门的文件判据靠它）。
    //
    //   为什么必须显式做：守门要同步判定，而任务数据在盘上、读取是异步的，
    //   索引只是缓存。**索引里没有这个任务 → 靠索引的那几条文件判据整段跳过**。
    //   生产里由工具调用顺带登记；自测不该依赖"哪个用例先跑过"。
    await callTool(fx.h, 'pipeline_status', { task_id: T, role_token: fx.tokens.main }, fx.agents.main)
    rec.add('★ 自包含：用例开头显式把任务预热进同步索引（不依赖别的用例顺带登记）',
      fx.h.taskIndex.get(T) !== undefined,
      `taskIndex.has(${T}) = ${fx.h.taskIndex.get(T) !== undefined}`)


    rec.add('★ 角色清单里多了「留档」角色（archivist）',
      (fx.h.store.peek(T).roster.execution_roles ?? []).includes('archivist'),
      `execution_roles = ${(fx.h.store.peek(T).roster.execution_roles ?? []).join(' / ')}`)

    // --- 各方各写各的 ------------------------------------------------------
    const w = await callTool(
      fx.h, 'pipeline_record_submit',
      {
        task_id: T, role_token: fx.tokens['writer#1'],
        sections: ['实现要点', '测试要点'],
        source: '代码事实：读了现有 src/api 下的三个文件',
        markdown: '## 实现要点\n\n- 导出走流式写，避免大表 OOM\n- 字段命名跟现有代码一致（snake_case）\n\n## 测试要点\n\n- 10 万行导出不 OOM\n- 空表导出要产出只有表头的文件',
      },
      fx.agents['writer#1'],
    )
    expectOk(rec, '正例① 编写席位提交**自己那份**记录（带令牌）', w, ['记录已收下', '来路已校验', 'records/'])

    const t1 = await callTool(
      fx.h, 'pipeline_record_submit',
      {
        task_id: T, role_token: fx.tokens.tester,
        sections: ['验收标准'],
        source: '与用户确认：导出格式要带 BOM',
        markdown: '## 验收标准\n\n1. 导出 CSV 带 BOM（Excel 打开不乱码）\n2. 10 万行不 OOM\n3. 空表产出只有表头的文件',
      },
      fx.agents.tester,
    )
    expectOk(rec, '正例① 测试席位提交**自己那份**记录', t1, ['记录已收下'])

    const a1 = await callTool(
      fx.h, 'pipeline_record_submit',
      {
        task_id: T, role_token: fx.tokens.architect,
        sections: ['边界与不做的事'],
        source: '架构判断：本次不改导入路径',
        markdown: '## 边界与不做的事\n\n- 不做导入\n- 不改数据库 schema',
      },
      fx.agents.architect,
    )
    expectOk(rec, '正例① 架构席位提交**自己那份**记录', a1, ['记录已收下'])

    // 三份记录各自落盘、互不覆盖
    const dir = recDir(fx.h.projectRoot, T)
    const names = (await readFile(join(dir, 'writer-writer1.md'), 'utf8')).length > 0 &&
      (await readFile(join(dir, 'tester.md'), 'utf8')).length > 0 &&
      (await readFile(join(dir, 'architect.md'), 'utf8')).length > 0
    rec.add('正例① ★ 三份记录**互不覆盖**（各写各的，路径按角色/席位区分）',
      names,
      `records/ 下：writer-writer1.md / tester.md / architect.md（三份都在）`)

    const recs = (fx.h.store.peek(T).records ?? [])
    rec.add('正例① 每条提交都登记了**来源**（record_id / 谁提交 / 何时 / sha256）',
      recs.length >= 3 && recs.every((r) => r.record_id.startsWith('RC-') && typeof r.sha256 === 'string' && typeof r.at === 'string' && typeof r.role === 'string'),
      `已收下的记录：\n${indent(recs.map((r) => `${r.record_id}  ${r.role}${r.seat ? `/${r.seat}` : ''}  ${r.at}  sha256=${r.sha256.slice(0, 12)}…`).join('\n'))}`)

    // --- 留档 AI 汇总 ------------------------------------------------------
    const byId = new Map(recs.map((r) => [r.rel_path, r.record_id]))
    const srcWriter = recs.find((r) => r.role === 'writer').record_id
    const srcTester = recs.find((r) => r.role === 'tester').record_id
    const srcArch = recs.find((r) => r.role === 'architect').record_id
    void byId

    const comp = await callTool(
      fx.h, 'pipeline_compile_requirement',
      {
        task_id: T, role_token: fx.tokens.archivist,
        entries: [
          { section: '实现要点', text: '- 导出走流式写，避免大表 OOM\n- 字段命名 snake_case', source_record: srcWriter },
          { section: '测试要点', text: '- 10 万行不 OOM\n- 空表产出只有表头', source_record: srcWriter },
          { section: '验收标准', text: '1. 导出 CSV 带 BOM\n2. 10 万行不 OOM\n3. 空表只有表头', source_record: srcTester },
          { section: '边界与不做的事', text: '- 不做导入\n- 不改 schema', source_record: srcArch },
        ],
      },
      fx.agents.archivist,
    )
    expectOk(rec, '正例① ★ 留档 AI 把四方记录汇总成唯一的需求档', comp, ['需求档已汇总', '来源', '目录约定'])

    const md = await readFile(reqMd(fx.h.projectRoot, T), 'utf8')
    expectOk(rec, '正例① ★ 汇总出的 requirement.md 逐条标注来源（可追溯）',
      { ok: true, text: md.slice(0, 2500) },
      ['# 需求档', '实现要点', '验收标准', '来源：RC-', '留档 AI'])

    rec.add('正例① ★ 每条内容都能追溯到「哪份记录、谁提交的、何时」',
      md.includes('writer') && md.includes('tester') && md.includes('architect') && md.includes('第 1 版'),
      `来源标注样例：\n${indent((md.match(/<sub>来源：.*<\/sub>/g) ?? []).join('\n'))}`)

    const idx = JSON.parse(await readFile(join(fx.h.projectRoot, '.pipeline', T, 'requirement.index.json'), 'utf8'))
    rec.add('正例① 版本与差异照旧维护（v1/v2… 可追溯）',
      idx.versions.length >= 1 && idx.versions.at(-1).amended_by === 'archivist' && idx.versions.at(-1).version.startsWith('r'),
      `版本索引：\n${indent(JSON.stringify(idx.versions, null, 2))}`)

    // --- 反例①：非留档 AI 直接写 requirement.md ---------------------------
    const direct = await callTool(
      fx.h, 'write',
      { file_path: reqMd(fx.h.projectRoot, T), content: '# 需求档（我自己改的）' },
      fx.agents['writer#1'],
    )
    expectDenied(rec, '反例① ★ 非留档 AI 直接写 requirement.md → 拒', direct,
      ['需求档只有留档 AI', '分权写 + 专人汇总', 'pipeline_record_submit'])

    // --- 反例②：无密钥 / 冒名提交 -----------------------------------------
    const anon = await callTool(
      fx.h, 'pipeline_record_submit',
      { task_id: T, markdown: '## 我偷偷加的\n\n- 我要求支持 xlsx' },
      'some-unknown-agent',
    )
    expectDenied(rec, '反例②a ★ 来路不明（没有令牌）的提交 → 拒', anon,
      ['无法确定调用方角色', '你是谁', 'pipeline_dispatch|pipeline_bind_role'])

    // 冒名：拿 writer#1 的令牌，冒充 tester 的一份记录
    const wTok = { taskId: T, role: 'writer', seat: 'writer#1', token: fx.tokens['writer#1'] }
    const impRes = await fx.h.store.submitRecord({
      taskId: T,
      role: 'tester',
      seat: null,
      markdown: '## 冒充测试说的\n\n- 其实这条不是测试写的',
      token: wTok,
      actorAgentId: fx.agents['writer#1'],
    })
    expectDenied(rec, '反例②b ★ 冒名（拿别人的令牌冒充别的角色）→ 拒', {
      denied: impRes.ok !== true,
      layer: 'execute',
      text: String(impRes.error ?? ''),
    }, ['冒名', '不符', '这是谁说的'])

    // 同位次但席位不符
    const seatImp = await fx.h.store.submitRecord({
      taskId: T,
      role: 'writer',
      seat: 'writer#2',
      markdown: '## 我替 2 号席位写的\n\n- 内容',
      token: wTok,
      actorAgentId: fx.agents['writer#1'],
    })
    expectDenied(rec, '反例②c ★ 席位不符（拿 1 号的令牌认 2 号的名）→ 拒', {
      denied: seatImp.ok !== true,
      layer: 'execute',
      text: String(seatImp.error ?? ''),
    }, ['席位', '只能提交**自己那份**'])

    // --- 反例③：留档 AI 写入无来源内容 ------------------------------------
    const unsourced = await callTool(
      fx.h, 'pipeline_compile_requirement',
      {
        task_id: T, role_token: fx.tokens.archivist,
        entries: [
          { section: '我自己加的', text: '- 我觉得还应该支持 xlsx 导出', source_record: '' },
          { section: '验收标准', text: '1. 导出 CSV 带 BOM', source_record: 'RC-不存在的记录' },
        ],
      },
      fx.agents.archivist,
    )
    expectDenied(rec, '反例③ ★ 留档 AI 写入**无来源内容** → 拒（不得凭空写入）', unsourced,
      ['没有可追溯的来源', '不得凭空写入', 'source_record'])

    // --- 反例③b：记录互相矛盾 → 不得自己拍板 ------------------------------
    const conflict = await callTool(
      fx.h, 'pipeline_compile_requirement',
      {
        task_id: T, role_token: fx.tokens.archivist,
        entries: [{ section: '验收标准', text: '1. 导出 CSV 带 BOM', source_record: srcTester }],
        conflicts: [{ about: '导出格式要不要带 BOM', between: [srcWriter, srcTester] }],
      },
      fx.agents.archivist,
    )
    expectDenied(rec, '反例③b ★ 记录**互相矛盾**时留档 AI 不得自己拍板 → 拒并指路提问/升级', conflict,
      ['互相矛盾', '不得自己拍板', 'pipeline_clarify_request', 'pipeline_human_request'])

    // --- 反例③c：非留档 AI 调汇总工具 --------------------------------------
    const notMine = await callTool(
      fx.h, 'pipeline_compile_requirement',
      { task_id: T, role_token: fx.tokens.tester, entries: [{ section: 'x', text: 'y', source_record: srcTester }] },
      fx.agents.tester,
    )
    expectDenied(rec, '反例③c 非留档 AI 调汇总工具 → 拒', notMine,
      ['只有留档 AI 能汇总', '分权写 + 专人汇总'])

    // --- 反例③d：留档 AI 给自己提交记录 ------------------------------------
    const selfSubmit = await callTool(
      fx.h, 'pipeline_record_submit',
      { task_id: T, role_token: fx.tokens.archivist, markdown: '## 我的判断\n\n- 我认为……' },
      fx.agents.archivist,
    )
    expectDenied(rec, '反例③d 留档 AI 给自己提交记录 → 拒（它不该把自己写进来源里）', selfSubmit,
      ['不需要给自己提交记录', '汇总', '写进来源里'])

    // --- 反例③e：写别人的记录文件 ------------------------------------------
    const othersRec = await callTool(
      fx.h, 'write',
      { file_path: join(recDir(fx.h.projectRoot, T), 'tester.md'), content: '## 测试说的\n\n- 我替他写了' },
      fx.agents['writer#1'],
    )
    expectDenied(rec, '反例③e ★ 写**别人那份**记录 → 拒（等于伪造来源）', othersRec,
      ['只能写自己那份记录', '伪造来源', 'writer-writer1.md'])

    // --- 对照：读不受限制 ---------------------------------------------------
    const readOk = await callTool(fx.h, 'read', { file_path: reqMd(fx.h.projectRoot, T) }, fx.agents['writer#1'])
    rec.add('对照：任何角色**读**需求档不受限制',
      readOk.denied !== true,
      `layer=${readOk.layer} —— "每个 AI 只干自己的事"的前提是它自己能读到需求`)

    const ownOk = await callTool(
      fx.h, 'write',
      { file_path: join(recDir(fx.h.projectRoot, T), 'writer-writer1.md'), content: '## 我更新了自己那份\n\n- 补充了一条' },
      fx.agents['writer#1'],
    )
    rec.add('对照：写**自己那份**记录是允许的（守门不挡）',
      ownOk.denied !== true,
      `layer=${ownOk.layer}\n标题：${ownOk.title ?? '(无)'}\n原文：\n${indent(ownOk.text)}`)

    // =====================================================================
    // ★★ 已知限制：守门的**索引空窗期**（显式覆盖，不假装它生效）
    // =====================================================================
    //
    //   守门必须**同步**判定，而任务数据在盘上、读取是异步的 —— 索引只是缓存。
    //   索引里没有这个任务时，靠 `task.projectRoot / taskSelfDir / writers` 的那几条
    //   文件判据会**整段跳过**（fail-open）。
    //
    //   这条用例**如实断言现状**：此时守门**不误拦**（放行），但必须**留下提示**。
    //   把"没查到"假装成"查过了没问题"就是假绿 —— 所以下面几条都要成立。
    {
      const before = fx.h.guardWarnings.length
      fx.h.taskIndex.delete(T)

      // (1) 空窗期里"写别人的记录"这条判据**没有生效** —— 会被放行。如实断言。
      const missRecord = await callTool(
        fx.h, 'write',
        { file_path: join(recDir(fx.h.projectRoot, T), 'tester.md'), content: '空窗期里我替测试写了' },
        fx.agents['writer#1'],
      )
      rec.add('空窗期 ★ 索引里没有该任务时，靠索引的文件判据**整段跳过**（如实断言：此时放行）',
        missRecord.denied !== true,
        `denied=${missRecord.denied} layer=${missRecord.layer}\n` +
          '★ 这不是"判据说没问题"，是"判据没跑到"（fail-open）。\n' +
          '  所以下一条断言"必须有提示"才是关键。')

      // (2) ★ 关键：它**不能是静默的** —— 必须留痕。
      const fresh = fx.h.guardWarnings.slice(before)
      rec.add('空窗期 ★★ **必须留痕**（不许静默放行）：守门报出该判据没生效',
        fresh.length > 0 && fresh.some((m) => m.includes('还没进同步索引')) && fresh.some((m) => m.includes('fail-open')),
        `收到的提示（${fresh.length} 条）：\n${indent(fresh.join('\n---\n'))}`)

      // (3) 提示里要写清"影响范围 / 原因 / 怎么缓解"，而不是只说一句"没生效"
      rec.add('空窗期 提示里写清了**影响范围 / 原因 / 怎么缓解**',
        fresh.some((m) => m.includes('整段跳过')) && fresh.some((m) => m.includes('读取是异步的')) && fresh.some((m) => m.includes('先做一次流水线动作')),
        `提示全文：\n${indent(fresh[0] ?? '(没有提示)')}`)

      // (4) 只报一次（不刷屏）
      const againMiss = await callTool(
        fx.h, 'write',
        { file_path: join(recDir(fx.h.projectRoot, T), 'tester.md'), content: '再来一次' },
        fx.agents['writer#1'],
      )
      void againMiss
      rec.add('空窗期 同一个任务**只报一次**（不刷屏）',
        fx.h.guardWarnings.length === before + fresh.length,
        `两次未命中，提示总数 ${fx.h.guardWarnings.length - before} 条`)

      // (5) 预热回来之后判据**立刻恢复**：同一次调用这回会被拒
      await callTool(fx.h, 'pipeline_status', { task_id: T, role_token: fx.tokens.main }, fx.agents.main)
      const warmAgain = await callTool(
        fx.h, 'write',
        { file_path: join(recDir(fx.h.projectRoot, T), 'tester.md'), content: '预热回来后应该被拒' },
        fx.agents['writer#1'],
      )
      rec.add('空窗期 预热回来后判据**立刻恢复**（同一次调用这回被拒）',
        warmAgain.denied === true,
        `denied=${warmAgain.denied}\n${indent(warmAgain.text)}`)
    }

  } catch (e) {
    rec.add('正例① 夹具/流程', false, `抛错：${e?.message ?? e}`)
  }

  // =========================================================================
  // 分档：L0 不纳入留档 AI（规则引擎直接生成单一需求档）
  // =========================================================================
  {
    const { createGuardFixture } = await import('./selftest-core.mjs')
    const g = await createGuardFixture({ stopAfter: 5 })
    open.push(g.h)
    const roles = g.h.store.peek(g.taskId).roster.execution_roles ?? []
    rec.add('分档 ★ L0 **不纳入**留档 AI（由规则引擎直接生成单一需求档）',
      !roles.includes('archivist'),
      `L0 execution_roles = ${roles.join(' / ')}`)
  }
  {
    const { buildRoster } = await import('../lib/tiers.js')
    const rows = []
    for (const tier of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']) {
      const r = buildRoster({ tier, reason: '分档自测', judgedBy: 'orchestrator', l0OrchestratorSeparate: true })
      rows.push(`${tier}　${(r.roster?.execution_roles ?? []).join(' / ')}　（共 ${r.roster?.total ?? '?'} 个对话）`)
    }
    const l1 = buildRoster({ tier: 'L1', reason: 'x', judgedBy: 'orchestrator' })
    rec.add('分档 ★ L1+ **纳入**留档 AI，L0 **不纳入**（L0 由规则引擎直接生成单一需求档）',
      (l1.roster?.execution_roles ?? []).includes('archivist'),
      `分档一览：\n${indent(rows.join('\n'))}\n\n★ L0 不纳入的理由：单文件/单函数级改动，需求本就一句话；\n  而且 L0 的编排由**规则引擎**承担，没有独立编排对话来派留档 AI —— 由规则引擎直接生成单一需求档更省。`)
  }

  // =========================================================================
  // 出报告
  // =========================================================================
  const groupOf = (name) => {
    if (name.startsWith('正例①')) return '正例① 各角色独立落档 + 带密钥提交 → 留档 AI 汇总成 requirement.md'
    if (name.startsWith('反例①')) return '反例① 非留档 AI 直接写 requirement.md'
    if (name.startsWith('反例②')) return '反例② 无密钥 / 冒名提交'
    if (name.startsWith('反例③')) return '反例③ 无来源内容 / 互相矛盾 / 越权汇总 / 伪造来源'
    if (name.startsWith('空窗期')) return '★ 已知限制：守门的索引空窗期（fail-open，但有留痕）'
    if (name.startsWith('对照')) return '对照：读不受限 / 写自己那份不受限'
    if (name.startsWith('分档')) return '分档：L0 不纳入留档 AI，L1+ 纳入'
    if (name.startsWith('★')) return '角色清单'
    return '其它'
  }
  const groups = {}
  for (const it of rec.items) {
    const g = groupOf(it.name)
    if (groups[g] === undefined) groups[g] = []
    groups[g].push(it)
  }

  const lines = []
  lines.push('='.repeat(78))
  lines.push('dsh-pipeline 分权落档 + 留档 AI 自测（更正 A）')
  lines.push('='.repeat(78))
  for (const [g, items] of Object.entries(groups)) {
    lines.push('')
    lines.push('─'.repeat(78))
    lines.push(`【${g}】${items.filter((i) => i.pass).length}/${items.length} 通过`)
    lines.push('─'.repeat(78))
    for (const it of items) {
      lines.push('')
      lines.push(`${it.pass ? '✓' : '✗'} ${it.name}`)
      for (const l of String(it.detail).split('\n')) lines.push(`    ${l}`)
    }
  }
  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`总计：${rec.passed}/${rec.total} 通过`)
  lines.push('='.repeat(78))

  for (const hh of open) await hh.store.dropCache()
  for (const hh of open) {
    try { await rm(hh.projectRoot, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
  }

  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

if (process.argv[1] !== undefined && /records-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runRecordsCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
