/**
 * dsh-pipeline · 需求留档（目录约定）+ 上下文水位 + 席位继任 自测
 * ============================================================================
 *     node tests/relay-check.mjs
 *
 * ★ 这一套按**三处更正**写（第七轮）：
 *   A. 需求档**靠目录约定**定位，**不登记进任务卡**；只有编排能写，其他角色只读；
 *      守门查"存在 + **版本可追溯**"。
 *   B. 三级水位 = **45 / 55 / 65**。
 *   C. **分配 AI = 编排 AI**（`orchestrator`），与主对话是两个角色；
 *      继任由编排决策与指派，主对话只跟踪状态。
 *
 * @module dsh-pipeline/tests/relay-check
 */

import { readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { callTool, createGuardFixture, manifestFor } from './selftest-core.mjs'
import { createMultiWriterFixture } from './writers-check.mjs'

// ---------------------------------------------------------------------------
// 断言小工具
// ---------------------------------------------------------------------------

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
  rec.add(
    name,
    pass,
    pass
      ? `拦截层：${res.layer}\n拒绝原文：\n${indent(res.text)}`
      : `期望被拒但 denied=${res.denied} layer=${res.layer}` +
        (missing.length > 0 ? `\n缺少关键片段：${missing.join(' ｜ ')}` : '') +
        `\n实际原文：\n${indent(res.text)}`,
  )
  return pass
}

function expectOk(rec, name, res, mustContain = []) {
  const missing = mustContain.filter((s) => !hit(res.text, s))
  const pass = res.denied !== true && missing.length === 0
  rec.add(
    name,
    pass,
    pass
      ? `结果摘要：\n${indent(res.text)}`
      : `期望成功但被拒（layer=${res.layer}）${missing.length > 0 ? `，缺少：${missing.join(' / ')}` : ''}\n原文：\n${indent(res.text)}`,
  )
  return pass
}

/** ★ 需求档的**约定路径**（不依赖任务卡、不依赖任何人告知）。 */
function reqPaths(projectRoot, taskId) {
  const dir = join(projectRoot, '.pipeline', taskId)
  return { dir, md: join(dir, 'requirement.md'), json: join(dir, 'requirement.json'), index: join(dir, 'requirement.index.json') }
}

/** 一份合法的席位交接物。 */
function handover(over = {}) {
  return {
    from_seat: 'writer#1',
    to_seat: 'writer#1',
    reason: '上下文水位 55%：已读 12 个文件、跑了 30 轮，上下文里压着 3 份大报告',
    context_percent: 55,
    progress_done: ['接口定义完成', '前端页面完成 80%'],
    progress_todo: ['后端接口', '联调'],
    must_read_files: ['.pipeline/<taskId>/requirement.md'],
    key_decisions: ['字段命名用 snake_case（跟现有代码一致）'],
    open_questions: ['导出格式要不要带 BOM？'],
    next_step: '接着写后端接口，先看 requirement.md 的验收标准第 2 条',
    do_not_repeat: ['别再试 xlsx 库 —— 它不支持流式写'],
    ...over,
  }
}

/** ★ 编排的交接物：额外要带**待处理的请求队列**（更正 B）。 */
function orchHandover(over = {}) {
  return handover({
    from_seat: 'planner',
    to_seat: 'planner',
    reason: '编排自己到 58%',
    context_percent: 58,
    // ★ 编排特有：谁在等答复
    pending_requests: [
      { from: 'writer#1', about: '导出格式要不要带 BOM？', waiting_since: '10 分钟前' },
      { from: 'tester', about: '测试环境的数据库怎么连？', waiting_since: '3 分钟前' },
    ],
    ...over,
  })
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runRelayCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // 更正 A：需求留档靠目录约定
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    open.push(fx.h)
    const T = fx.taskId
    const P = reqPaths(fx.h.projectRoot, T)
    const task = fx.h.store.peek(T)

    rec.add('A ★ 任务卡里**没有**需求档路径（更正 A：不登记在一起）',
      task.requirement_doc === undefined || task.requirement_doc === null,
      `task.requirement_doc = ${JSON.stringify(task.requirement_doc ?? null)}\n任务卡里跟 require 有关的键：${Object.keys(task).filter((k) => /require/i.test(k)).join(' / ') || '（一个都没有）'}`)

    const md = await readFile(P.md, 'utf8')
    rec.add('A ★ 按**目录约定**就能找到 requirement.md（不需要谁告知；由留档 AI 汇总产生）',
      md.length > 0,
      `约定路径：.pipeline/${T}/requirement.md（${md.length} 字符）`)
    expectOk(rec, 'A 它是人可读的 markdown（需求原文 / 验收标准 / 安全面 / 以本文件为准）',
      { ok: true, text: md.slice(0, 1500) },
      ['# 需求档', '需求原文', '验收标准', '安全面', '以本文件为准'])

    const js = JSON.parse(await readFile(P.json, 'utf8'))
    rec.add('A 结构化 JSON 也在约定目录里（记了汇总者与用到的记录）',
      js.task_id === T && js.compiled_by === 'archivist' && Array.isArray(js.records_used),
      `requirement.json：task_id=${js.task_id} compiled_by=${js.compiled_by} records_used=${(js.records_used ?? []).length} 份`)

    const idx = JSON.parse(await readFile(P.index, 'utf8'))
    rec.add('A ★ 版本索引存在，记了 sha256 / 时间 / 谁改的（这就是"可追溯"）',
      Array.isArray(idx.versions) && idx.versions.length === 1 && typeof idx.versions[0].sha256 === 'string' && idx.versions[0].version === 'r1',
      `requirement.index.json：\n${indent(JSON.stringify(idx.versions, null, 2))}`)

    // ★ 变更走"再汇总一次"：留档 AI 重新编一版，历史不覆盖
    const srcOrch2 = (fx.h.store.peek(T).records ?? []).find((r) => r.role === 'planner')
    const again = await callTool(
      fx.h, 'pipeline_compile_requirement',
      {
        task_id: T, role_token: fx.tokens.archivist,
        entries: [
          { section: '需求原文', text: '给订单系统加导出功能：前端页面、后端接口、使用文档。', source_record: srcOrch2.record_id },
          { section: '验收标准', text: '1. 导出 CSV **带 BOM**（Excel 不乱码）\n2. 前后端联通', source_record: srcOrch2.record_id },
        ],
        notes: ['需求微调：导出格式要带 BOM'],
      },
      fx.agents.archivist,
    )
    expectOk(rec, 'A 需求变更可以再汇总一次（落新版本）', again, ['需求档已汇总'])
    const idx2 = JSON.parse(await readFile(P.index, 'utf8'))
    rec.add('A ★ 版本化可追溯：新版本 + supersedes + 差异摘要，历史**不覆盖**',
      idx2.versions.length >= 2 &&
        idx2.versions.at(-1).supersedes === idx2.versions.at(-2).version &&
        typeof idx2.versions.at(-1).diff_summary === 'string' &&
        idx2.versions[0].sha256 !== idx2.versions.at(-1).sha256,
      `版本链：\n${indent(idx2.versions.map((v) => `${v.version}  sha256=${String(v.sha256).slice(0, 16)}…  supersedes=${v.supersedes ?? '(无)'}  diff=${v.diff_summary}`).join('\n'))}`)

    const hist = await readFile(join(P.dir, 'requirement.r1.md'), 'utf8')
    rec.add('A 历史版本文件留在盘上（r1 还能读到）', hist.length > 0, `requirement.r1.md ${hist.length} 字符`)

    // ★ 写权独占：非编排角色写需求档被拒
    const sneaky = await callTool(
      fx.h, 'write',
      { file_path: P.md, content: '# 需求档（我改了）\n\n其实验收标准应该是我说的那样。' },
      fx.agents['writer#1'],
    )
    expectDenied(rec, 'A ★ **写权独占**：编写角色想改需求档 → 拒（只有**留档 AI**能写）', sneaky,
      ['需求档只有留档 AI', '权威需求快照', 'pipeline_record_submit'])

    // 只读不受限制（对照）
    const readOk = await callTool(fx.h, 'read', { file_path: P.md }, fx.agents['writer#1'])
    rec.add('A 对照：**读**需求档不受限制（任何角色都能自己读）',
      readOk.denied !== true,
      `layer=${readOk.layer}（读是允许的 —— "每个 AI 只干自己的事"的前提是它自己能读到需求）`)
  }

  // =========================================================================
  // 正例①：执行席位 55% → 上报**编排** → 编排指派继任 → 交接 → 新席位接管
  // =========================================================================
  let fx = null
  try {
    fx = await createMultiWriterFixture({ writers: 1 })
    open.push(fx.h)
    const T = fx.taskId
    const stateBefore = fx.h.store.peek(T).state

    const rep = await callTool(
      fx.h, 'pipeline_context_report',
      { task_id: T, percent: 55, basis: '已读 12 个文件、跑了 30 轮，上下文里压着 3 份大报告', requested_succession: true, role_token: fx.tokens['writer#1'] },
      fx.agents['writer#1'],
    )
    expectOk(rec, '正例① 席位上报 55%（达触发线）', rep, ['水位已上报', '55%', '触发继任'])
    rec.add('正例① ★ 到线时**通知的是分配 AI（计划 AI）**，不是主对话',
      hit(rep.text, '已通知**分配 AI（计划 AI）**') || hit(rep.text, '没能通知分配 AI'),
      `通知结果：\n${indent(String(rep.text).split('\n').slice(-3).join('\n'))}`)
    rec.add('正例① 上报里带插件侧客观观测（工具调用次数，不是模型说的）',
      typeof rep.value?.observed_tool_calls === 'number' && rep.value.observed_tool_calls > 0,
      `observed_tool_calls=${rep.value?.observed_tool_calls}`)

    const ho = await callTool(
      fx.h, 'pipeline_handoff',
      { task_id: T, kind: 'seat_handover', role_token: fx.tokens['writer#1'], payload: { task_id: T, ...handover() } },
      fx.agents['writer#1'],
    )
    expectOk(rec, '正例① 旧席位产出 seat_handover（四个必填清单都在）', ho, ['席位交接'])

    const suc = await callTool(
      fx.h, 'pipeline_succession',
      { task_id: T, seat: 'writer#1', role: 'writer', spawn: false, role_token: fx.tokens.planner },
      fx.agents.planner,
    )
    expectOk(rec, '正例① ★ **编排**（分配 AI）指派继任者', suc, ['席位继任完成', '第 2 代', '令牌已撤销'])
    const newToken = suc.value?.token ?? ''

    const after = fx.h.store.peek(T)
    rec.add('正例① ★ 任务**状态没有变**（继任是换班，不是重开）',
      after.state === stateBefore, `状态：${stateBefore} → ${after.state}`)
    rec.add('正例① 继任关系落档（世代 / from / to / 依据 / 交接物 id）',
      after.successions.length === 1 && after.successions[0].handoff_id === ho.value?.handoff_id,
      `successions = ${indent(JSON.stringify(after.successions, null, 2))}`)

    const acts = (await fx.h.store.auditLog(T)).map((a) => a.action)
    rec.add('正例① 全程留痕：水位 → 交接 → 继任',
      ['context:report', 'handoff:seat_handover', 'seat:succession'].every((a) => acts.includes(a)),
      `相关动作：${acts.filter((a) => /context:|seat:/.test(a)).join(' → ')}`)

    // --- 正例②：模拟上下文丢失（只按目录约定找档） ------------------------
    const P = reqPaths(fx.h.projectRoot, T)
    const md = await readFile(P.md, 'utf8')
    rec.add('正例② ★ 全新会话**只按目录约定**找到 requirement.md（不依赖任务卡、不依赖主对话告知）',
      md.includes('# 需求档') && md.includes('## 需求原文'),
      `读的是：.pipeline/${T}/requirement.md（约定路径）`)
    rec.add('正例② ★ 能说清"要做什么"',
      md.includes(String(after.requirement).slice(0, 20)),
      `需求原文段：\n${indent(String(md.split('## 需求原文')[1] ?? '').slice(0, 160))}`)
    rec.add('正例② ★ 能说清"验收标准是什么"',
      md.includes('## 验收标准'),
      `验收标准段：\n${indent(String(md.split('## 验收标准')[1] ?? '').split('##')[0].slice(0, 200))}`)

    const cont = await callTool(
      fx.h, 'pipeline_handoff',
      {
        task_id: T, kind: 'dev_to_test', role_token: newToken,
        payload: {
          task_id: T, artifact_version: 'v1', patch_or_code: 'x', change_note: '继任席位接着写',
          run_commands: ['node t.mjs'], selftest_result: 'pass', known_issues: [],
          partition: { seat: 'writer#1', index: 1, total: 1, scope_paths: ['.'] },
          ...manifestFor(fx.h.store, T),
        },
      },
      suc.value?.agent_id ?? 'new-agent',
    )
    expectOk(rec, '正例② ★ 新席位的全新会话能直接继续推进（编写交测试）', cont, ['编写交付给测试'])

    // --- 反例③：旧席位继任后继续写 ---------------------------------------
    const oldWrite = await callTool(
      fx.h, 'pipeline_handoff',
      { task_id: T, kind: 'seat_handover', role_token: fx.tokens['writer#1'], payload: { task_id: T, ...handover({ next_step: '我还想再交一份' }) } },
      fx.agents['writer#1'],
    )
    expectDenied(rec, '反例③ ★ 旧席位在继任后继续写 → 拒（令牌已撤 + 已登记退休）', oldWrite,
      ['继任换班', '令牌已撤销', '不得再写'])
  } catch (e) {
    rec.add('正例①② 夹具/流程', false, `抛错：${e?.message ?? e}`)
  }

  // =========================================================================
  // 正例③：★ 编排自己到 55% —— 谁来指派它的继任者？
  // =========================================================================
  {
    const g = await createMultiWriterFixture({ writers: 1 })
    open.push(g.h)
    const T = g.taskId
    const stateBefore = g.h.store.peek(T).state
    const rolesBefore = g.h.store.peek(T).roster.execution_roles.join('/')

    const rep = await callTool(
      g.h, 'pipeline_context_report',
      { task_id: T, percent: 58, basis: '编排过程读了 20 个文件、写了很长的清单，上下文压得很满', role_token: g.tokens.planner },
      g.agents.planner,
    )
    expectOk(rec, '正例③ ★ 编排自己上报水位 58%', rep, ['水位已上报', '58%'])

    const ho = await callTool(
      g.h, 'pipeline_handoff',
      {
        task_id: T, kind: 'seat_handover', role_token: g.tokens.planner,
        payload: { task_id: T, ...orchHandover() },
      },
      g.agents.planner,
    )
    expectOk(rec, '正例③ 编排产出自己的交接物（**含待处理请求队列**）', ho, ['席位交接'])

    // ★ 缺 pending_requests 会被拒 —— 先验这一条
    const noQueue = await callTool(
      g.h, 'pipeline_handoff',
      {
        task_id: T, kind: 'seat_handover', role_token: g.tokens.planner,
        payload: { task_id: T, ...orchHandover({ pending_requests: undefined }) },
      },
      g.agents.planner,
    )
    expectDenied(rec, '正例③ ★ 编排的交接物**缺待处理请求队列** → 拒（别人还在等他答复）', noQueue,
      ['pending_requests', '待处理的请求队列', '永远悬着'])

    // ★ 更正 B：**编排自己给自己换班**（用户明确要求"编排 AI 在慢上下文时也就新建编排 AI"）
    const selfSuc = await callTool(
      g.h, 'pipeline_succession',
      { task_id: T, seat: '', role: 'planner', spawn: false, role_token: g.tokens.planner },
      g.agents.planner,
    )
    const byMain = await callTool(
      g.h, 'pipeline_succession',
      { task_id: T, seat: '', role: 'planner', spawn: false, role_token: g.tokens.main },
      g.agents.main,
    )
    expectOk(rec, '正例③ ★ **计划 AI 自己**给自己换班（分配 AI 就近新建计划席位）', selfSuc,
      ['席位继任完成', 'planner'])
    rec.add('正例③ ★ **广播了新联系人**给所有已绑定席位',
      hit(selfSuc.text, '新联系人广播'),
      `广播结果：\n${indent(String(selfSuc.text).split('\n').filter((l) => /广播|联系人/.test(l)).join('\n'))}`)
    const newOrchToken = selfSuc.value?.token ?? ''
    const newOrchAgent = selfSuc.value?.agent_id ?? ''

    const after = g.h.store.peek(T)
    const s0 = (after.successions ?? [])[0]
    rec.add('正例③ 任务状态仍然**不变**', after.state === stateBefore, `状态：${stateBefore} → ${after.state}`)
    rec.add('正例③ ★ 继任**没有改变角色清单**（清单原封不动）',
      s0 !== undefined && after.roster.execution_roles.join('/') === rolesBefore && s0.role === 'planner',
      s0 === undefined
        ? `✗ 没有产生继任记录；succession 返回：\n${selfSuc.text}`
        : `execution_roles：${rolesBefore} → ${after.roster.execution_roles.join('/')}（不变）\n继任记录 role=${s0.role} generation=${s0.generation}`)

    // ★ 旧席位继任后不得再写 —— 拿"计划"这条链来验（分配权在计划 AI 手里）。
    const oldOrch = await callTool(
      g.h, 'pipeline_plan',
      { task_id: T, plan_steps: ['还想再计划一次'], self_check_verdict: 'ok', self_check_checked: ['x'], plan_reason: '我还想再计划一次', tier: 'L2', reason: '我还想再来一次', role_token: g.tokens.planner },
      g.agents.planner,
    )
    expectDenied(rec, '正例③ 旧计划席位继任后不得再写', oldOrch, ['继任换班', '不得再写'])

    // 新计划 AI 能接着干活：批准一条角色变更申请（这是分配权范围内的事）。
    const dW2 = await callTool(g.h, 'pipeline_dispatch', { task_id: T, role: 'writer', seat: 'writer#1', spawn: false, role_token: g.tokens.main }, g.agents.main)
    expectOk(rec, '正例③ （前置）派出编写席位', dW2, ['已派出'])
    const need = await callTool(
      g.h, 'pipeline_roster_request',
      { task_id: T, add: ['architect'], reason: '需求里出现了跨模块接口，建议加架构角色。', role_token: dW2.value.token },
      dW2.value.agent_id,
    )
    expectOk(rec, '正例③ （前置）编写提出角色变更申请', need, ['角色变更申请已登记'])
    const reOrch = await callTool(
      g.h, 'pipeline_roster_review',
      { task_id: T, request_id: need.value.request_id, approve: true, note: '跨模块接口确实需要先定契约，同意加。', role_token: newOrchToken },
      newOrchAgent,
    )
    expectOk(rec, '正例③ ★ 新计划 AI 席位能接着干活（行使分配权：复核角色变更）', reOrch, ['新清单'])

    // ★★ 更正 B：广播之后，**每个席位都能查到"当前分配 AI 是谁"**
    const who = await callTool(g.h, 'pipeline_contacts', { task_id: T, role_token: newOrchToken }, newOrchAgent)
    expectOk(rec, '正例③ ★ 任何席位都能查到**当前联系人**（当前分配 AI 是谁）', who, ['当前联系人', '计划 AI', '第 2 代'])
    rec.add('正例③ 联系人查询给出了**新计划 AI**的会话 id（不是旧的那个）',
      who.value?.planner_agent === newOrchAgent && who.value.planner_agent !== g.agents.planner &&
        who.value?.orchestrator_agent === who.value?.planner_agent,
      `当前分配 AI：planner_agent=${who.value?.planner_agent}（旧的是 ${g.agents.planner}）；旧字段名别名 orchestrator_agent=${who.value?.orchestrator_agent}`)

    // --- 反例⑥：上报发给"已退场的分配 AI" --------------------------------
    const stale = await callTool(
      g.h, 'pipeline_context_report',
      {
        task_id: T, percent: 56, basis: '我又读了几个文件，上下文到 56% 了',
        to_planner_agent: g.agents.planner,
        role_token: g.tokens['writer#1'],
      },
      g.agents['writer#1'],
    )
    expectDenied(rec, '反例⑥ ★ 上报发给**已退场的分配 AI** → 拒并指出当前联系人', stale,
      ['不是当前联系人', '已经退场', 'pipeline_contacts', newOrchAgent])

    // 对照：发给**当前**分配 AI，正常（这里顺手验旧字段名 to_orchestrator_agent 仍然被接受）
    const fresh = await callTool(
      g.h, 'pipeline_context_report',
      {
        task_id: T, percent: 56, basis: '我又读了几个文件，上下文到 56% 了',
        to_orchestrator_agent: newOrchAgent,
        role_token: g.tokens['writer#1'],
      },
      g.agents['writer#1'],
    )
    expectOk(rec, '反例⑥ 对照：发给**当前**分配 AI，正常放行', fresh, ['水位已上报'])
  }

  // =========================================================================
  // 反例①：未上报水位就请求继任
  // =========================================================================
  {
    const g = await createMultiWriterFixture({ writers: 1 })
    open.push(g.h)
    const res = await callTool(
      g.h, 'pipeline_succession',
      { task_id: g.taskId, seat: 'writer#1', role: 'writer', spawn: false, role_token: g.tokens.planner },
      g.agents.planner,
    )
    expectDenied(rec, '反例① 没上报水位就请求继任', res,
      ['从未上报过上下文水位', '继任必须有依据', 'pipeline_context_report'])
  }

  // =========================================================================
  // 反例②：★ 主对话试图参与继任指派（非编排席位）
  // =========================================================================
  {
    const g = await createMultiWriterFixture({ writers: 1 })
    open.push(g.h)
    await callTool(g.h, 'pipeline_context_report', { task_id: g.taskId, percent: 60, basis: '读了 10 个文件，压了 2 份报告', role_token: g.tokens['writer#1'] }, g.agents['writer#1'])
    await callTool(
      g.h, 'pipeline_handoff',
      { task_id: g.taskId, kind: 'seat_handover', role_token: g.tokens['writer#1'], payload: { task_id: g.taskId, ...handover() } },
      g.agents['writer#1'],
    )
    const byMain = await callTool(
      g.h, 'pipeline_succession',
      { task_id: g.taskId, seat: 'writer#1', role: 'writer', spawn: false, role_token: g.tokens.main },
      g.agents.main,
    )
    expectDenied(rec, '反例② ★ 主对话试图给**执行席位**指派继任 → 拒（它只该收状态）', byMain,
      ['主对话**不参与继任指派**', '分配 AI 是**计划 AI**', '更新状态、跟踪、最终关单'])

    rec.add('反例② 没有产生任何继任记录', (g.h.store.peek(g.taskId).successions ?? []).length === 0,
      `successions=${(g.h.store.peek(g.taskId).successions ?? []).length}`)
  }

  // =========================================================================
  // 反例④：继任次数超上限
  // =========================================================================
  {
    const g = await createMultiWriterFixture({ writers: 1, relayPolicy: { maxSuccessionsPerSeat: 1 } })
    open.push(g.h)
    await callTool(g.h, 'pipeline_context_report', { task_id: g.taskId, percent: 60, basis: '读了 10 个文件，压了 2 份报告', role_token: g.tokens['writer#1'] }, g.agents['writer#1'])
    await callTool(
      g.h, 'pipeline_handoff',
      { task_id: g.taskId, kind: 'seat_handover', role_token: g.tokens['writer#1'], payload: { task_id: g.taskId, ...handover() } },
      g.agents['writer#1'],
    )
    const first = await callTool(g.h, 'pipeline_succession', { task_id: g.taskId, seat: 'writer#1', role: 'writer', spawn: false, role_token: g.tokens.planner }, g.agents.planner)
    expectOk(rec, '反例④ 前提：第 1 次继任成功', first, ['席位继任完成'])
    const tok2 = first.value?.token ?? ''
    const agent2 = first.value?.agent_id ?? 'a2'

    await callTool(g.h, 'pipeline_context_report', { task_id: g.taskId, percent: 58, basis: '新席位也读了 8 个文件了', role_token: tok2 }, agent2)
    await callTool(
      g.h, 'pipeline_handoff',
      { task_id: g.taskId, kind: 'seat_handover', role_token: tok2, payload: { task_id: g.taskId, ...handover({ reason: '又到 58% 了', context_percent: 58 }) } },
      agent2,
    )
    const second = await callTool(g.h, 'pipeline_succession', { task_id: g.taskId, seat: 'writer#1', role: 'writer', spawn: false, role_token: g.tokens.planner }, g.agents.planner)
    expectDenied(rec, '反例④ ★ 继任次数超 maxSuccessionsPerSeat → 拒', second,
      ['已经继任 1 次', '达到上限 1 次', '回编排复核', 'pipeline_roster_request'])
  }

  // =========================================================================
  // 反例⑤：交接物缺 must_read_files / open_questions / do_not_repeat
  // =========================================================================
  {
    const g = await createMultiWriterFixture({ writers: 1 })
    open.push(g.h)
    const noFiles = await callTool(
      g.h, 'pipeline_handoff',
      { task_id: g.taskId, kind: 'seat_handover', role_token: g.tokens['writer#1'], payload: { task_id: g.taskId, ...handover({ must_read_files: [] }) } },
      g.agents['writer#1'],
    )
    expectDenied(rec, '反例⑤a 交接物 must_read_files 空 → 拒', noFiles, ['must_read_files', '至少要有 1 条|至少要读需求档'])

    const noQ = await callTool(
      g.h, 'pipeline_handoff',
      { task_id: g.taskId, kind: 'seat_handover', role_token: g.tokens['writer#1'], payload: { task_id: g.taskId, ...handover({ open_questions: undefined }) } },
      g.agents['writer#1'],
    )
    expectDenied(rec, '反例⑤b 交接物缺 open_questions → 拒', noQ, ['open_questions', '必须显式给', '没问题', '没写'])

    const noDnr = await callTool(
      g.h, 'pipeline_handoff',
      { task_id: g.taskId, kind: 'seat_handover', role_token: g.tokens['writer#1'], payload: { task_id: g.taskId, ...handover({ do_not_repeat: undefined }) } },
      g.agents['writer#1'],
    )
    expectDenied(rec, '反例⑤c 交接物缺 do_not_repeat → 拒', noDnr, ['do_not_repeat', '弯路', '再发现一次'])
  }

  // =========================================================================
  // 反例⑥：需求档缺失 / 版本不可追溯 → 不许开工
  // =========================================================================
  {
    const g = await createMultiWriterFixture({ writers: 1 })
    open.push(g.h)
    const P = reqPaths(g.h.projectRoot, g.taskId)

    const idxBackup = await readFile(P.index, 'utf8')
    const mdBackup = await readFile(P.md, 'utf8')

    // (a) 版本索引被删 → 不可追溯
    await unlink(P.index)
    const noIdx = await callTool(g.h, 'pipeline_dispatch', { task_id: g.taskId, role: 'tester', spawn: false, role_token: g.tokens.main }, g.agents.main)
    expectDenied(rec, '反例⑥a ★ 版本索引不在 → 不可追溯 → 拒', noIdx, ['没有版本索引', '可追溯', '第几版'])

    await writeFile(P.index, idxBackup, 'utf8')

    // (b) 需求档本体被删
    await unlink(P.md)
    const noMd = await callTool(g.h, 'pipeline_dispatch', { task_id: g.taskId, role: 'tester', spawn: false, role_token: g.tokens.main }, g.agents.main)
    expectDenied(rec, '反例⑥b ★ 约定目录下没有 requirement.md → 拒', noMd, ['没有需求档', '没有留档就不许开工', '目录约定'])

    // (c) 有人绕过编排直接改了 → sha256 对不上
    await writeFile(P.md, `${mdBackup}\n\n（有人偷偷加了一行）`, 'utf8')
    const tampered = await callTool(g.h, 'pipeline_dispatch', { task_id: g.taskId, role: 'tester', spawn: false, role_token: g.tokens.main }, g.agents.main)
    expectDenied(rec, '反例⑥c ★ 需求档被绕过编排直接改过（sha256 对不上）→ 拒', tampered,
      ['对不上', '只有编排能写它', '记成新版本'])

    // (d) 历史文件被删 → 追溯链断了
    await writeFile(P.md, mdBackup, 'utf8')
    await unlink(join(P.dir, 'requirement.r1.md'))
    const noHist = await callTool(g.h, 'pipeline_dispatch', { task_id: g.taskId, role: 'tester', spawn: false, role_token: g.tokens.main }, g.agents.main)
    expectDenied(rec, '反例⑥d ★ 历史版本文件被删 → 追溯链断了 → 拒', noHist,
      ['历史文件不在盘上', '追溯链断了', '宁可重建也不要删历史'])
  }

  // =========================================================================
  // 补充：阈值 45/55/65、依据闸、硬限档、L0 不启用
  // =========================================================================
  {
    const g = await createMultiWriterFixture({ writers: 1 })
    open.push(g.h)
    const policy = g.h.store.peek(g.taskId).roster.relay_policy
    rec.add('补充 ★ 三级阈值默认是 **45 / 55 / 65**（更正 B）',
      policy.warnPercent === 45 && policy.triggerContextPercent === 55 && policy.hardLimitPercent === 65,
      `relay_policy = ${JSON.stringify(policy)}`)

    const noBasis = await callTool(
      g.h, 'pipeline_context_report',
      { task_id: g.taskId, percent: 55, basis: '   ', role_token: g.tokens['writer#1'] },
      g.agents['writer#1'],
    )
    expectDenied(rec, '补充a ★ 上报水位却不给依据 → 拒', noBasis, ['缺 basis', '必须给依据', '没有面向插件的上下文用量接口'])

    const nope = await callTool(
      g.h, 'pipeline_context_report',
      { task_id: g.taskId, percent: 999, basis: '我猜的但我写得很长很长很长', role_token: g.tokens['writer#1'] },
      g.agents['writer#1'],
    )
    expectDenied(rec, '补充b percent 越界 → 拒', nope, ['0~100'])

    const hard = await callTool(
      g.h, 'pipeline_context_report',
      { task_id: g.taskId, percent: 66, basis: '已经读了 30 个文件，上下文几乎满了', role_token: g.tokens['writer#1'] },
      g.agents['writer#1'],
    )
    expectOk(rec, '补充c ★ 66% 落在**硬限**档（硬限 65）', hard, ['硬限', '只允许交接与收尾'])
  }
  {
    const g = await createMultiWriterFixture({ writers: 1 })
    open.push(g.h)
    await callTool(g.h, 'pipeline_context_report', { task_id: g.taskId, percent: 30, basis: '才读了 3 个文件，还很空', role_token: g.tokens['writer#1'] }, g.agents['writer#1'])
    await callTool(
      g.h, 'pipeline_handoff',
      { task_id: g.taskId, kind: 'seat_handover', role_token: g.tokens['writer#1'], payload: { task_id: g.taskId, ...handover({ context_percent: 30 }) } },
      g.agents['writer#1'],
    )
    const early = await callTool(g.h, 'pipeline_succession', { task_id: g.taskId, seat: 'writer#1', role: 'writer', spawn: false, role_token: g.tokens.planner }, g.agents.planner)
    expectDenied(rec, '补充d ★ 水位没到触发线就换班 → 拒', early, ['低于触发线', '30%', '55%', '白白丢掉'])
  }
  {
    const g = await createGuardFixture({ stopAfter: 5 })
    open.push(g.h)
    const res = await callTool(
      g.h, 'pipeline_succession',
      { task_id: g.taskId, seat: '', role: 'planner', spawn: false, role_token: g.tokens.main },
      g.agents.main,
    )
    expectDenied(rec, '补充e ★ L0 **故意不启用**继任（档位不在 enabledTiers）→ 拒并说明理由', res,
      ['不启用继任', 'enabledTiers', 'L0', '规则引擎'])
  }

  // =========================================================================
  // 出报告
  // =========================================================================
  const groupOf = (name) => {
    if (name.startsWith('A ')) return 'A 需求留档（目录约定 + 版本可追溯）'
    if (name.startsWith('正例①')) return '正例① 席位 55% → 上报**编排** → 编排指派 → 交接 → 新席位接管'
    if (name.startsWith('正例②')) return '正例② ★ 模拟上下文丢失：只按目录约定找档就能接上'
    if (name.startsWith('正例③')) return '正例③ ★ 编排自己到 55%：主对话按"清单不变"兜底'
    if (name.startsWith('反例①')) return '反例① 未上报水位就继任'
    if (name.startsWith('反例②')) return '反例② ★ 主对话试图参与继任指派'
    if (name.startsWith('反例③')) return '反例③ 旧席位继任后继续写'
    if (name.startsWith('反例④')) return '反例④ 继任次数超上限'
    if (name.startsWith('反例⑤')) return '反例⑤ 交接物缺 must_read_files / open_questions / do_not_repeat'
    if (name.startsWith('反例⑥')) return '反例⑥ 需求档缺失 / 版本不可追溯 → 不许开工'
    if (name.startsWith('补充')) return '补充：阈值 45/55/65 / 依据闸 / 硬限档 / L0 不启用'
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
  lines.push('dsh-pipeline 需求留档（目录约定）+ 上下文水位 + 席位继任 自测')
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

if (process.argv[1] !== undefined && /relay-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runRelayCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
