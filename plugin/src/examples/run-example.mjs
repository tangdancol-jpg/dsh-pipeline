/**
 * dsh-pipeline · 生成一份真实的可查看样例
 * ============================================================================
 *     node examples/run-example.mjs
 *
 * 在一个**真实目录**（`examples/demo-project/`）上跑完整流程，把落盘布局与
 * 每一份结构化交接物留成实物，方便直接翻着看 —— 而不是只能读文档想象。
 *
 * ★ 不创建任何真实会话：走 SimulatedTransport（内存假会话）。
 *   产物目录每次重跑先清空，保证样例与当前代码一致。
 *
 * @module dsh-pipeline/examples/run-example
 */

import { rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mergeConfig } from '../lib/config.js'
import { createGuardFor } from '../lib/guard-factory.js'
import { makeTaskIndexEntry } from '../lib/guard.js'
import { createTaskStore } from '../lib/store.js'
import { createTokenStore } from '../lib/tokens.js'
import { buildTools } from '../lib/tools.js'
import { SimulatedTransport } from '../lib/transport/index.js'
import { renderDispatchBrief } from '../lib/transport/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = join(HERE, 'demo-project')

const fakeDefineTool = (d) => d

async function call(h, toolName, args, agentId) {
  const exec = { name: toolName, arguments: args ?? {}, ...(agentId ? { agent: { id: agentId } } : {}) }
  const denial = h.guard(exec)
  if (denial !== undefined) throw new Error(`被守门拦下（样例不该走到这里）：\n${denial}`)
  const out = await h.byName.get(toolName).execute(exec.arguments, exec)
  if (out?.ok !== true) throw new Error(`${toolName} 失败：\n${out?.summary}`)
  return out
}

// ---------------------------------------------------------------------------
// 清空并准备工作目录
// ---------------------------------------------------------------------------
await rm(PROJECT, { recursive: true, force: true })
await mkdir(join(PROJECT, 'src'), { recursive: true })
await writeFile(join(PROJECT, 'src', 'fizzbuzz.js'), '// 编写角色写的代码（样例占位）\nexport function fizzbuzz(n) { /* … */ }\n', 'utf8')

const config = mergeConfig({ transport: 'simulated', spawnRoles: true })
const tokens = createTokenStore()
const store = createTaskStore({ projectRoot: PROJECT, artifactDirName: config.artifactDirName, maxReworkPerLeg: config.maxReworkPerLeg })
const transport = new SimulatedTransport({ tokens })
const taskIndex = new Map()
const indexTask = (taskId, task) => {
  if (!task) return
  taskIndex.set(taskId, makeTaskIndexEntry({ taskId, projectRoot: task.project_root, pipelineDir: join(task.project_root, config.artifactDirName) }))
}
const tools = buildTools({ defineTool: fakeDefineTool, ctx: { logger: {} }, config, store, tokens, transport, indexTask })
const h = { byName: new Map(Object.values(tools).map((t) => [t.name, t])), guard: createGuardFor({ tokens, config, taskIndex }), projectRoot: PROJECT }

const MAIN = 'example-main'
const REQ = '给 fizzbuzz 加一个按步长过滤的查询参数，并补上单元测试。约束：不引入任何第三方依赖。'

const opened = await call(h, 'pipeline_task_open', { requirement: REQ, constraints: ['不引入任何第三方依赖'], deliverable_format: '补丁 + 变更说明 + 可运行命令' }, MAIN)
const taskId = opened.task_id
const mt = opened.role_token

// ★ 这个需求**不能**自批 L0（有约束、且命中"接口/参数/测试"这类不平凡信号），
//   所以主对话自己调 orchestrate 会被拒 —— 必须派出独立的编排判断对话。
//   把这条拒绝先存成实物。
const selfOrchestrate = await h.byName.get('pipeline_orchestrate').execute(
  { task_id: taskId, requirement: REQ, role_token: mt },
  { name: 'pipeline_orchestrate', arguments: {}, agent: { id: MAIN } },
)

// 引导步：清单还没产出时，唯一能派出去的角色就是「编排判断」自己。
const dO = await call(h, 'pipeline_dispatch', { task_id: taskId, role: 'orchestrator', role_token: mt }, MAIN)

// 独立编排对话给出 tier + reason → 产出角色清单 + 任务卡。
const orch = await call(h, 'pipeline_orchestrate', {
  task_id: taskId,
  requirement: REQ,
  tier: 'L1',
  reason:
    '涉及接口参数与单元测试、且声明了"不引入第三方依赖"这条约束；有明确功能边界但不止一处改动。' +
    '不需要架构决策（改动局限在单文件函数内），也没有鉴权/安全面，故 L1（5 个对话）足够，不上 L2。',
  acceptance: ['带 step 参数的查询按步长过滤', 'step 缺省或非法时返回全部而非报错'],
  test_points: ['step=2 过滤正确', 'step=0/负数/非数字的兜底', '不引入第三方依赖（检查 package.json 未变）'],
  boundaries: ['只改 fizzbuzz 一个文件', '不新增运行期依赖'],
  role_token: dO.token,
}, dO.agent_id)

// 把 L1 的派活单渲染出来存成实物（manual 通道下就是要粘贴给人看的那一段）
const brief = renderDispatchBrief({ task: await store.get(taskId), roster: (await store.get(taskId)).roster, role: 'writer', token: '<派发时铸的令牌>' })
await writeFile(join(HERE, 'example-dispatch-brief.md'), `${brief}\n`, 'utf8')

const dW = await call(h, 'pipeline_dispatch', { task_id: taskId, role: 'writer', role_token: mt }, MAIN)
await call(h, 'pipeline_artifact', { task_id: taskId, content: 'export function fizzbuzz(n) {\n  const out = []\n  for (let i = 1; i <= n; i++) out.push(i % 15 === 0 ? "FizzBuzz" : i % 3 === 0 ? "Fizz" : i % 5 === 0 ? "Buzz" : String(i))\n  return out\n}\n', file_name: 'fizzbuzz.js', note: '样例制品', role_token: dW.token }, dW.agent_id)
const v1 = (await store.get(taskId)).artifacts[0].version

await call(h, 'pipeline_handoff', {
  task_id: taskId, kind: 'dev_to_test', role_token: dW.token,
  payload: {
    task_id: taskId, artifact_version: v1,
    patch_or_code: 'diff --git a/src/fizzbuzz.js b/src/fizzbuzz.js\n+export function fizzbuzz(n) { … }\n',
    change_note: '新增 fizzbuzz 函数；纯标准库，无第三方依赖。',
    run_commands: ['node --test tests/fizzbuzz.test.js'],
    selftest_result: '本地 4/4 通过（n=0,1,3,15）',
    known_issues: [],
    acceptance_map: { '返回 1 到 n 的 FizzBuzz 数组': 'src/fizzbuzz.js:fizzbuzz' },
  },
}, dW.agent_id)

const dT = await call(h, 'pipeline_dispatch', { task_id: taskId, role: 'tester', role_token: mt }, MAIN)
await call(h, 'pipeline_handoff', {
  task_id: taskId, kind: 'test_to_review', role_token: dT.token,
  payload: {
    task_id: taskId, artifact_version: v1,
    test_cases: ['n=0 → []', 'n=1 → ["1"]', 'n=3 → ["1","2","Fizz"]', 'n=15 末项为 "FizzBuzz"', 'n=5 → ["1","2","Fizz","4","Buzz"]'],
    execution_result: '5/5 通过',
    failure_logs: [],
    pass_evidence: ['node --test：5 pass / 0 fail', '边界 n=0、n=1 均覆盖', 'n=15 同时命中 3 与 5'],
    risk_notes: ['未做超大 n（>1e6）的性能验证；如需请追加性能压测角色。'],
    verdict: 'pass',
  },
}, dT.agent_id)

const dR = await call(h, 'pipeline_dispatch', { task_id: taskId, role: 'reviewer', role_token: mt }, MAIN)
await call(h, 'pipeline_handoff', {
  task_id: taskId, kind: 'review_verdict', role_token: dR.token,
  payload: {
    task_id: taskId, artifact_version: v1, conclusion: 'OK',
    risk_notes: ['未做超大 n 的性能验证（已由测试标注，且不影响本任务验收标准）'],
    release_approved: true,
    final_delivery_note: `交付 src/fizzbuzz.js 的 fizzbuzz(n)，制品 ${v1}，测试 5/5 通过，无第三方依赖。`,
    acceptance_check: { '返回 1 到 n 的 FizzBuzz 数组': 'pass' },
  },
}, dR.agent_id)

// ---------------------------------------------------------------------------
// 先留三份"被拒"的实物 —— 必须在关单**之前**做。
// 关单会回收本任务的全部角色令牌（tokens.revokeTask），令牌没了会话绑定也就没了，
// 那时再试越权只会得到"令牌无效"，看不到真正的越权拒绝文案。
// （这个坑在自测里也踩过一次，见 tests/selftest-core.mjs 文件头「坑 ②」。）
// ---------------------------------------------------------------------------
const refusalCases = []
{
  const probe1 = { name: 'pipeline_handoff', arguments: { task_id: taskId, kind: 'review_verdict', role_token: dW.token, payload: {} }, agent: { id: dW.agent_id } }
  refusalCases.push(['【反例 ①】编写角色调用 pipeline_handoff(kind=review_verdict) —— 想直接把产物交给审核', h.guard(probe1)])

  const probe3 = { name: 'write', arguments: { path: join(PROJECT, 'src', 'fizzbuzz.js'), content: '// 测试偷偷改' }, agent: { id: dT.agent_id } }
  refusalCases.push(['【反例 ③】测试角色想直接改项目源码（write）', h.guard(probe3)])

  const probe4 = { name: 'read', arguments: { path: join(PROJECT, 'src', 'fizzbuzz.js') }, agent: { id: MAIN } }
  refusalCases.push(['【反例 ④】主对话想读代码正文（read）', h.guard(probe4)])

  // ② 主对话想自己定档定角色：另开一张单来演示（当前这张单的清单已经产出了）。
  const opened2 = await call(h, 'pipeline_task_open', { requirement: REQ, constraints: ['不引入任何第三方依赖'] }, MAIN)
  const r2out = await h.byName.get('pipeline_orchestrate').execute(
    { task_id: opened2.task_id, requirement: REQ, role_token: opened2.role_token },
    { name: 'pipeline_orchestrate', arguments: {}, agent: { id: MAIN } },
  )
  refusalCases.push(['【反例 ②】主对话想自己产出角色清单（绕过独立编排判断）', r2out.summary])
}

const closed = await call(h, 'pipeline_close', { task_id: taskId, role_token: mt, note: '审核 OK，放行' }, MAIN)

await writeFile(
  join(HERE, 'example-refusal.txt'),
  `${refusalCases
    .map(([title, reason]) => `$ ${title}\n\n${reason ?? '（未被拦下 —— 这不该发生）'}\n`)
    .join(`\n${'─'.repeat(78)}\n\n`)}\n`,
  'utf8',
)

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const dir = join(PROJECT, '.pipeline', taskId)
const walk = async (d, prefix = '') => {
  const out = []
  for (const e of await readdir(d, { withFileTypes: true })) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
    if (e.isDirectory()) out.push(...(await walk(join(d, e.name), rel)))
    else out.push(rel)
  }
  return out
}

const files = await walk(join(PROJECT, '.pipeline'))
const task = await store.get(taskId)

console.log('样例已生成。')
console.log('')
console.log(`任务：${taskId}`)
console.log(`档位：${orch.tier}（${orch.ai_count} 个独立对话）`)
console.log(`最终状态：${task.state}`)
console.log(`关单依据：${closed.review_ok}`)
console.log('')
console.log('落盘布局（examples/demo-project/.pipeline/）：')
for (const f of files.sort()) console.log(`  ${f}`)
console.log('')
console.log('另外两份实物：')
console.log('  examples/example-dispatch-brief.md   派活单（manual 通道下要粘贴给人看的那段）')
console.log('  examples/example-refusal.txt         4 条越权动作的拒绝原文（编写跳审核 / 主对话自定档 / 测试改码 / 主对话读码）')
console.log('')
console.log('审计日志（最后 6 条）：')
const log = await store.auditLog(taskId)
for (const e of log.slice(-6)) console.log(`  ${e.at}  ${e.actor.padEnd(12)} ${e.action}`)
void readFile
