/**
 * dsh-pipeline · 长入参通道（`spec_path` / `payload_path`）自测
 * ============================================================================
 *     node tests/p16-args-file-check.mjs
 *
 * 修的是哪条缺陷（用户截图为证）：席位调 `pipeline_plan` 时入参**全是长中文段落**
 * ⇒ 模型侧把参数 JSON 写坏 ⇒ 宿主判 `tool input is invalid JSON` ⇒
 * `MALFORMED_RESPONSE` ⇒ **整轮作废（含此前全部上下文）**。
 * 根因是这几个工具**没有"从文件读入参"的通道** ⇒ 只能内联。
 *
 * 六条逐条钉（用户点名的六条）：
 *   ① 文件通道成功（与内联等价）　② 合并语义（**同名内联优先**）
 *   ③ ★ 越界被拒（与 `read` **同一套判据**）　④ 坏文件各有明确文案
 *   ⑤ 向后兼容（不传字段 ⇒ 行为完全不变）　⑥ 等价性（走文件 vs 走内联 ⇒ 逐字节相同）
 *
 * ★ 判据复用是重点：`spec_path` 的读取走**与 `read` 工具同一个** `codeReadRefusal`
 *   （`lib/guard/rules.js`），不是抄一份 —— 否则这条通道就成了"不读代码"的后门。
 *
 * @module dsh-pipeline/tests/p16-args-file-check
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ARGS_FILE_MAX_BYTES, resolveArgsFile } from '../lib/tools/args-file.js'
import { callTool, createHarness, disposeHarness, runHappyPath } from './selftest-core.mjs'

// ---------------------------------------------------------------------------
// 断言小工具（与其它套同形）
// ---------------------------------------------------------------------------

const indent = (s, n = 4) =>
  String(s ?? '')
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n')

/** `|` = 或（同一条违规在别的路径上措辞可能不同）。 */
const hit = (text, fragment) =>
  String(fragment)
    .split('|')
    .some((a) => a.length > 0 && String(text).includes(a))

function createRecorder() {
  const items = []
  return {
    items,
    add(group, name, pass, detail) {
      items.push({ group, name, pass: pass === true, detail: String(detail ?? '') })
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
  }
}

/** 期望"文本里出现这些片段"。 */
function expectText(rec, group, name, text, must = []) {
  const missing = must.filter((s) => !hit(text, s))
  rec.add(group, name, missing.length === 0, missing.length === 0 ? `实际文本：\n${indent(text)}` : `缺少片段：${missing.join(' ｜ ')}\n实际文本：\n${indent(text)}`)
}

/** 期望"这次调用被拒"，且拒绝原文里有这些片段。`layer==='missing'` 是"工具没注册"，不算拒。 */
function expectDenied(rec, group, name, res, must = []) {
  const missing = must.filter((s) => !hit(res.text, s))
  const pass = res.denied === true && res.layer !== 'missing' && missing.length === 0
  rec.add(group, name, pass, pass ? `拦截层：${res.layer}\n拒绝原文：\n${indent(res.text)}` : `denied=${res.denied} layer=${res.layer}${missing.length > 0 ? ` 缺少：${missing.join(' ｜ ')}` : ''}\n原文：\n${indent(res.text)}`)
}

/** 期望"这次调用成功"，且结果里有这些片段。 */
function expectOk(rec, group, name, res, must = []) {
  const missing = must.filter((s) => !hit(res.text, s))
  const pass = res.denied !== true && missing.length === 0
  rec.add(group, name, pass, pass ? `结果摘要：\n${indent(res.text)}` : `期望成功但被拒（layer=${res.layer}）${missing.length > 0 ? ` 缺少：${missing.join(' / ')}` : ''}\n原文：\n${indent(res.text)}`)
}

// ---------------------------------------------------------------------------
// 单元夹具：`resolveArgsFile` 只依赖 `deps.store` / `deps.config` 与磁盘
// ---------------------------------------------------------------------------

/** 一次性临时项目根（本套自己建、自己删）。 */
const makeRoot = () => mkdtempSync(join(tmpdir(), 'dsh-pipeline-p16-'))

/** 假 deps：`store.get` 只答一个任务。 */
const fakeDeps = (projectRoot) => ({
  store: { get: async () => ({ id: 'T-P16', project_root: projectRoot }) },
  config: { artifactDirName: '.pipeline' },
})

/** 往项目根里写一个文件（自动建目录），返回绝对路径。 */
function put(root, rel, content) {
  const abs = join(root, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

/**
 * ★ 本套单元用例默认走**控制角色（planner）**，所以规格必须放在 `.pipeline/` 下面 ——
 *   放项目根会被 `NO_CODE_READ_ROLES` 正确拒掉（那正是 ③ 要证明的事，不是夹具该踩的坑）。
 */
const specArgs = (extra = {}) => ({ task_id: 'T-P16', spec_path: '.pipeline/T-P16/spec.json', ...extra })

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 跑本套自测。
 * @returns {Promise<{passed:number, total:number, text:string, items:object[]}>}
 */
export async function runArgsFileCheck() {
  const rec = createRecorder()
  const roots = []
  const MAIN = 'p16-main'
  const root = makeRoot()
  roots.push(root)
  const deps = fakeDeps(root)

  /** 一调 `resolveArgsFile` 的便捷壳（默认给 `spec_path` + 控制角色）。 */
  const load = (over = {}) =>
    resolveArgsFile({
      field: 'spec_path',
      args: specArgs(),
      exec: null,
      deps,
      role: 'planner',
      allowedKeys: ['task_id', 'spec_path', 'tier', 'reason', 'plan_steps', 'nested'],
      ...over,
    })

  // ======================================================================
  // ① 文件通道成功 + ② 合并语义 + ⑤ 向后兼容（单元层，精确断言）
  // ======================================================================
  put(root, '.pipeline/T-P16/spec.json', JSON.stringify({ tier: 'L2', reason: '来自文件', plan_steps: ['a'] }))
  const first = await load()
  rec.add('① 文件通道成功', '读得到文件、并落到 args 里', first.ok === true && first.args.tier === 'L2' && first.args.plan_steps[0] === 'a', `ok=${first.ok}\n${indent(first.ok === true ? JSON.stringify(first.args) : first.summary)}`)
  rec.add('① 文件通道成功', '`from` 回报实际读的那个绝对路径', first.ok === true && String(first.from).endsWith('spec.json'), `from=${first.ok === true ? first.from : '(失败)'}`)

  const overridden = await load({ args: specArgs({ tier: 'L1', reason: '内联的' }) })
  rec.add('② 合并语义', '★ 同名键：**内联优先**（内联的 L1 覆盖文件里的 L2）', overridden.ok === true && overridden.args.tier === 'L1' && overridden.args.plan_steps[0] === 'a', `tier=${overridden.args?.tier}（期望 L1） plan_steps=${JSON.stringify(overridden.args?.plan_steps)}（文件里的必须留着）`)

  const undefInline = await load({ args: specArgs({ tier: undefined }) })
  rec.add('② 合并语义', '★ 内联给 `undefined` **不算给过** —— 不许把文件里的值覆盖没', undefInline.ok === true && undefInline.args.tier === 'L2', `tier=${undefInline.args?.tier}（期望 L2：内联没写就该留文件里的）`)

  // ⑤ 不传字段 ⇒ 原样返回**同一个对象引用**（证明一次 stat 都没发生）
  const inlineOnly = { task_id: 'T-P16', tier: 'L3' }
  const pass = await resolveArgsFile({ field: 'spec_path', args: inlineOnly, exec: null, deps, role: 'planner', allowedKeys: ['task_id', 'spec_path', 'tier'] })
  rec.add('⑤ 向后兼容', '不传 `spec_path` ⇒ 原样透传（**同一个对象引用**，连一次 stat 都没有）', pass.ok === true && pass.args === inlineOnly && pass.from === null, `ok=${pass.ok} from=${pass.from} 同一个引用=${pass.args === inlineOnly}`)

  // ======================================================================
  // ③ ★ 越界被拒（两个入口各一条）
  // ======================================================================
  const SRC = 'plugin/active/lib/guard/decide.js'
  const control = await load({ args: specArgs({ spec_path: SRC }), role: 'planner' })
  rec.add('③ 越界被拒', '★ 控制角色（计划）指向实现源码 ⇒ 拒 + 点明判据 `NO_CODE_READ_ROLES`', control.ok !== true && hit(control.summary, 'NO_CODE_READ_ROLES') && hit(control.summary, SRC) && hit(control.summary, 'read'), `ok=${control.ok}\n拒绝原文：\n${indent(control.summary)}`)

  const noRole = await load({ args: specArgs({ spec_path: SRC }), role: null })
  rec.add('③ 越界被拒', '★ 判不出角色 ⇒ 按**最严**那一档处理（不是放行）', noRole.ok !== true && hit(noRole.summary, 'NO_CODE_READ_ROLES'), `ok=${noRole.ok}\n拒绝原文：\n${indent(noRole.summary)}`)

  const writerEscape = await load({ args: specArgs({ spec_path: SRC }), role: 'writer' })
  rec.add('③ 越界被拒', '★ 有写权限的角色也不能把参数文件塞进实现源码树', writerEscape.ok !== true && hit(writerEscape.summary, 'ARGS_FILE_DENY_TOP') && hit(writerEscape.summary, 'plugin/'), `ok=${writerEscape.ok}\n拒绝原文：\n${indent(writerEscape.summary)}`)

  const outside = await load({ args: specArgs({ spec_path: '../../etc/passwd' }) })
  rec.add('③ 越界被拒', '项目根之外的路径 ⇒ 拒（点明项目根）', outside.ok !== true && hit(outside.summary, '项目根'), `ok=${outside.ok}\n拒绝原文：\n${indent(outside.summary)}`)

  put(root, '.pipeline/T-P16/allowed.json', JSON.stringify({ tier: 'L4' }))
  const inPipeline = await load({ args: specArgs({ spec_path: '.pipeline/T-P16/allowed.json' }) })
  rec.add('③ 越界被拒', '反面：控制角色指向 `.pipeline/**` ⇒ **放行**（判据真的在判东西）', inPipeline.ok === true && inPipeline.args.tier === 'L4', `ok=${inPipeline.ok}\n${indent(inPipeline.ok === true ? JSON.stringify(inPipeline.args) : inPipeline.summary)}`)

  // ======================================================================
  // ④ 坏文件：各有明确文案（禁静默）
  // ======================================================================
  const p16 = (name) => `.pipeline/T-P16/${name}`
  const missing = await load({ args: specArgs({ spec_path: p16('nope.json') }) })
  expectText(rec, '④ 坏文件', '不存在 ⇒ 明确说"不存在" + 给出被拒路径', missing.summary, ['不存在', 'nope.json'])
  rec.add('④ 坏文件', '不存在 ⇒ ok=false（不是静默放过）', missing.ok === false, `ok=${missing.ok}`)

  put(root, '.pipeline/T-P16/bad.json', '{ "tier": "L2", }')
  expectText(rec, '④ 坏文件', '语法错 ⇒ 明确说"不是合法 JSON" + 解析错误', (await load({ args: specArgs({ spec_path: p16('bad.json') }) })).summary, ['不是合法 JSON', '解析错误'])

  put(root, '.pipeline/T-P16/huge.json', `{"tier":"${'x'.repeat(ARGS_FILE_MAX_BYTES + 64)}"}`)
  expectText(rec, '④ 坏文件', `超大 ⇒ 明确说"过大" + **给出上限**（${ARGS_FILE_MAX_BYTES} B）`, (await load({ args: specArgs({ spec_path: p16('huge.json') }) })).summary, ['过大', String(ARGS_FILE_MAX_BYTES)])

  put(root, '.pipeline/T-P16/spec.yaml', 'tier: L2\n')
  expectText(rec, '④ 坏文件', 'YAML ⇒ 明确报"只支持 JSON"', (await load({ args: specArgs({ spec_path: p16('spec.yaml') }) })).summary, ['YAML', '只支持'])

  put(root, '.pipeline/T-P16/arr.json', '[1,2,3]')
  expectText(rec, '④ 坏文件', '顶层不是对象 ⇒ 明确拒绝', (await load({ args: specArgs({ spec_path: p16('arr.json') }) })).summary, ['JSON 对象'])

  put(root, '.pipeline/T-P16/typo.json', JSON.stringify({ tier: 'L2', plna_steps: ['a'] }))
  expectText(rec, '④ 坏文件', '★ 拼错的字段 ⇒ **不静默忽略**（点名它）', (await load({ args: specArgs({ spec_path: p16('typo.json') }) })).summary, ['plna_steps', '不认识'])

  const noTask = await resolveArgsFile({ field: 'spec_path', args: { spec_path: p16('spec.json') }, exec: null, deps, role: 'planner', allowedKeys: ['task_id', 'spec_path', 'tier'] })
  expectText(rec, '④ 坏文件', '★ 没内联 `task_id` ⇒ 拒（判据要先知道任务才判得了路径）', noTask.summary, ['task_id'])

  // ======================================================================
  // ⑥ 等价性（单元层，精确）
  // ======================================================================
  const fileArgs = { tier: 'L5', reason: '逐字节相同', plan_steps: ['x', 'y'], nested: { a: [1, 2] } }
  put(root, '.pipeline/T-P16/eq.json', JSON.stringify(fileArgs))
  const viaFile = await load({ args: specArgs({ spec_path: p16('eq.json') }) })
  const inlineEq = { task_id: 'T-P16', ...fileArgs }
  const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'spec_path').sort()))
  rec.add('⑥ 等价性', '★ 走文件 vs 走内联 ⇒ 合并后的入参**逐字节相同**', viaFile.ok === true && sorted(viaFile.args) === sorted(inlineEq), `走文件：${sorted(viaFile.ok === true ? viaFile.args : {})}\n走内联：${sorted(inlineEq)}`)

  // ======================================================================
  // E2E：真工具 + 真守门（`pipeline_orchestrate` 走 spec_path）
  //
  // ★ 这里**自己开单**而不复用 `runHappyPath({stopAfter:1})`：那个夹具在
  //   `stopAfter < 2` 时 `orch` 还是 null，`finish()` 会踩空（夹具自身的 bug，
  //   与本套要测的东西无关）。自己开单反而更直接：主对话 + 一张全新待处理单。
  // ======================================================================
  const h = await createHarness()
  const opened = await callTool(h, 'pipeline_task_open', { requirement: '给订单系统加导出功能：接口层、数据层、处理层三块并行推进。', deliverable_format: '补丁 + 变更说明 + 可运行命令' }, MAIN)
  if (opened.denied) throw new Error(`E2E 夹具：开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id

  const goodPath = join(h.projectRoot, '.pipeline', taskId, 'orch-spec.json')
  mkdirSync(join(goodPath, '..'), { recursive: true })
  writeFileSync(
    goodPath,
    JSON.stringify({
      acceptance: ['功能按需求实现', '有独立测试且通过'],
      test_points: ['正常路径', '边界值'],
      boundaries: ['不改动既有公开接口'],
      unclear_points: [],
      analysis_reason: '按用户原话拆解；验收标准逐条可判定。',
      requirement: '给订单系统加导出功能。',
      role_token: opened.value.role_token,
    }),
  )
  expectOk(rec, '① 文件通道成功', '★ E2E：`pipeline_orchestrate` 只给 `task_id` + `spec_path` 就成功', await callTool(h, 'pipeline_orchestrate', { task_id: taskId, spec_path: goodPath }, MAIN), [taskId])

  expectDenied(rec, '③ 越界被拒', '★ E2E：主对话（控制角色）指向实现源码 ⇒ 拒 + 点明 NO_CODE_READ_ROLES', await callTool(h, 'pipeline_orchestrate', { task_id: taskId, spec_path: SRC }, MAIN), ['NO_CODE_READ_ROLES', SRC])

  const badPath = join(h.projectRoot, '.pipeline', taskId, 'bad-orch.json')
  writeFileSync(badPath, '{ "acceptance": ["a"], }')
  expectDenied(rec, '④ 坏文件', '★ E2E：坏 JSON ⇒ 这一次调用失败（**不是** MALFORMED_RESPONSE）', await callTool(h, 'pipeline_orchestrate', { task_id: taskId, spec_path: badPath }, MAIN), ['不是合法 JSON'])

  const legacy = await callTool(h, 'pipeline_human_relay', { task_id: taskId }, MAIN)
  rec.add('⑤ 向后兼容', '★ E2E：不碰新字段的既有工具调用照旧（收件箱可读）', legacy.layer !== 'missing', `layer=${legacy.layer}\n${indent(legacy.text)}`)

  // ======================================================================
  // E2E：`pipeline_handoff` 的 `payload_path`
  // ======================================================================
  const g = await runHappyPath({ stopAfter: 3 })
  const h2 = g.harness
  // 字段照 `lib/handoff/schemas.js` 的 dev_to_test 逐条对齐（required 七项）。
  const payload = {
    task_id: g.taskId,
    artifact_version: 'v1',
    patch_or_code: 'export function fizzbuzz(n){ /* … */ }',
    change_note: '新增 fizzbuzz 实现',
    run_commands: ['node -e "console.log(1)"'],
    selftest_result: '本地跑通，1..15 输出正确',
    known_issues: [],
  }
  const pPath = join(h2.projectRoot, '.pipeline', g.taskId, 'handoff.json')
  mkdirSync(join(pPath, '..'), { recursive: true })
  writeFileSync(pPath, JSON.stringify(payload))

  expectOk(rec, '① 文件通道成功', '★ E2E：`pipeline_handoff` 走 `payload_path`（文件直接写 payload 的字段）', await callTool(h2, 'pipeline_handoff', { task_id: g.taskId, kind: 'dev_to_test', payload_path: pPath, role_token: g.tokens.writer }, g.agents.writer), ['dev_to_test'])

  const stored = (h2.store.peek(g.taskId)?.handoffs ?? []).find((x) => x.kind === 'dev_to_test')
  rec.add('① 文件通道成功', '★ 落盘的 payload 与文件内容一致（文件真的被当成了 payload）', stored !== undefined && stored.payload?.patch_or_code === payload.patch_or_code && stored.payload?.selftest_result === payload.selftest_result, `落盘 payload：${indent(JSON.stringify(stored?.payload ?? null))}`)

  // ② E2E 合并：内联 `payload` 覆盖文件（同名内联优先）
  const g2 = await runHappyPath({ stopAfter: 3 })
  const h3 = g2.harness
  const pPath2 = join(h3.projectRoot, '.pipeline', g2.taskId, 'handoff2.json')
  mkdirSync(join(pPath2, '..'), { recursive: true })
  writeFileSync(pPath2, JSON.stringify(payload))
  const inlineWins = await callTool(h3, 'pipeline_handoff', { task_id: g2.taskId, kind: 'dev_to_test', payload_path: pPath2, payload: { ...payload, patch_or_code: '内联的这一份赢' }, role_token: g2.tokens.writer }, g2.agents.writer)
  const stored2 = (h3.store.peek(g2.taskId)?.handoffs ?? []).find((x) => x.kind === 'dev_to_test')
  rec.add('② 合并语义', '★ E2E：同名键（`payload`）内联优先', inlineWins.denied !== true && stored2?.payload?.patch_or_code === '内联的这一份赢', `patch_or_code=${stored2?.payload?.patch_or_code}（期望「内联的这一份赢」）`)

  expectDenied(rec, '③ 越界被拒', '★ E2E：writer 指向实现源码 ⇒ 拒（ARGS_FILE_DENY_TOP）', await callTool(h3, 'pipeline_handoff', { task_id: g2.taskId, kind: 'dev_to_test', payload_path: SRC, role_token: g2.tokens.writer }, g2.agents.writer), ['ARGS_FILE_DENY_TOP'])

  // ======================================================================
  // 清理（run-all 会因为临时目录泄漏判红）
  // ======================================================================
  for (const x of [h, h2, h3]) {
    try {
      await disposeHarness(x)
    } catch {
      /* 清不掉不影响结论 */
    }
  }
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true })
    } catch {
      /* 同上 */
    }
  }

  // ---------------------------------------------------------------------
  // 渲染报告
  // ---------------------------------------------------------------------
  const lines = []
  for (const grp of [...new Set(rec.items.map((i) => i.group))]) {
    const mine = rec.items.filter((i) => i.group === grp)
    lines.push(`【${grp}】${mine.filter((i) => i.pass).length}/${mine.length} 通过`)
    for (const it of mine) {
      lines.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
      if (it.detail !== '') lines.push(indent(it.detail, 6))
    }
    lines.push('')
  }
  lines.push('─'.repeat(78))
  lines.push(`总共：${rec.passed}/${rec.total} 通过`)
  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

// 直接跑：`node tests/p16-args-file-check.mjs`
if (process.argv[1] !== undefined && /p16-args-file-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runArgsFileCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
