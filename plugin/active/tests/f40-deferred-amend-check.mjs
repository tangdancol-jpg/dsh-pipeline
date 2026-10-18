// P1-18 残余回归：分配后经 `pipeline_scope_amend` **追加** deferred_artifacts（只追加不覆盖）。
/**
 * dsh-pipeline · F40：分配后补产物豁免（P1-18 残余）
 * ============================================================================
 *     node tests/f40-deferred-amend-check.mjs
 *
 * 现场（设计档 `design/conventions/04-demo与制品模型.md` §4；P1-18 残余）：
 * `deferred_artifacts` 只能在「计划中」随计划交上去；任务进「待开发」之后，
 * 用户才想清楚"这次这仪式性产物确实不用交" —— 又变成**裁定有了、动作做不了**。
 *
 * 修法（本单）：给窄通道 `pipeline_scope_amend`（planner-only、ready_dev）加一个字段
 * `deferred_artifacts`，**只追加不覆盖**，形状/判据与计划同源：
 *   · why 必填；accepted_by 只能是 user / supervisor（supervisor 仅 L4+）；
 *   · 只能豁免本档"可豁免"的必需产物；
 *   · 测试 / 审核 / 安全类**不可豁免**；
 *   · 已有 kind 重复追加 ⇒ 拒（只追加，不覆盖计划里那份理由/批准人）。
 * 留痕：task.deferred_artifacts（补登项带 `via:'amendment'` + amendment_id）、
 *       task.amendments[].deferred_added、audit.jsonl 的 scope:amend。
 * 展示：`pipeline_status` / 关单摘要把这些豁免标注「分配后经 amendment 补登」；其它字段照旧拒绝。
 *
 * 钉住：
 *   A 正例：L4 ready_dev + planner 追加一条 ⇒ 成功；计划原有的那条**原样保留**；补登项带来源标记
 *   B 留痕与展示：amendment.deferred_added / audit / status（紧凑档 & 结构化 products 都标 via amendment）
 *   C 负例：重复 kind / 不可豁免类 / 缺 why / 非法批准人 / supervisor 在 L3 / 本档不可豁免 / L2 无豁免面 ⇒ 全拒且不改任务
 *   D 其它字段照旧拒绝（借 amendment 改档位/角色清单等）；空 deferred 数组 ⇒ 至少动一处
 *   E 与 add/forbidden 组合在同一次 amendment 里 ⇒ 两类变更都落盘、都留痕
 */

import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'

import { createHarness, disposeHarness, callTool, runAnalysisThenPlan } from './selftest-core.mjs'
import { deferralLine, deferredArtifactsOf } from '../lib/tiers.js'

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
    text() {
      const L = ['dsh-pipeline · F40：分配后补产物豁免（P1-18 残余）', '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('', `【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(`      ${it.detail.split('\n').join('\n      ')}`)
      }
      L.push('', '='.repeat(78), `总计：${this.passed}/${this.total} 通过`, '='.repeat(78))
      return L.join('\n')
    },
  }
}

let seq = 0
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * 造一个「待开发」的任务（走真实链路：开单 → 需求 → 用户确认 → 计划），再把档位摆成目标档。
 *
 * ★ 为什么用 L2 出计划再改 roster.tier：P1-7 起 L3+ 计划会先落 `demo_building`（DEMO 阶段），
 *   而本套测的是**分配后的授权面/豁免窄通道**（只在 ready_dev 生效）—— 用 L2 走通、
 *   再摆成 L3/L4 来验本档的豁免矩阵，不把 DEMO 阶段扯进来（DEMO 路由由 f31 覆盖）。
 *
 * @param {object} opts
 * @param {string} [opts.tier] - 摆成哪个档（默认 L4）
 * @param {boolean} [opts.stopBeforePlan] - true ⇒ 停在「计划中」（验其它状态一律拒）
 */
async function amendFixture(h, opts = {}) {
  const tier = typeof opts.tier === 'string' ? opts.tier : 'L4'
  const MAIN = `f40-main-${++seq}`
  const opened = await callTool(h, 'pipeline_task_open', { requirement: `F40 夹具：${tier} 档分配后补豁免。` }, MAIN)
  if (opened.denied) throw new Error(`开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id
  const tokens = { main: opened.value.role_token }
  const agents = { main: MAIN }
  const res = await runAnalysisThenPlan(h, {
    taskId,
    tokens,
    agents,
    tier: 'L2',
    reason: 'F40 夹具：L2 出计划（随后把档位摆到目标档）',
    stopBeforePlan: opts.stopBeforePlan === true,
  })
  if (opts.stopBeforePlan === true) {
    return { h, taskId, tokens: res.tokens ?? tokens, agents: res.agents ?? agents, state: h.store.peek(taskId).state }
  }
  // 把档位摆到目标档（只改 roster.tier；本套不验 DEMO 阶段）
  const task = await h.store.get(taskId)
  task.roster = { ...(task.roster ?? {}), tier }
  task.deferred_artifacts = []
  await h.store.recordAudit(taskId, 'planner', 'fixture:set_tier', { tier })
  h.indexTask(taskId, await h.store.get(taskId))
  return { h, taskId, tokens: res.tokens, agents: res.agents, state: h.store.peek(taskId).state }
}

/** 调一次 `pipeline_scope_amend`（planner 身份）。 */
async function amend(f, args) {
  return callTool(
    f.h,
    'pipeline_scope_amend',
    { task_id: f.taskId, why: 'F40 夹具：用户已裁定这次可以豁免（需求层裁定，补登动作归 planner）。', role_token: f.tokens.planner, ...args },
    f.agents.planner,
  )
}

async function auditRows(taskId, h) {
  const text = await readFile(h.store.auditFile(taskId), 'utf8')
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runF40DeferredAmendCheck() {
  const rec = createRecorder()
  const h = await createHarness({})
  try {
    // =====================================================================
    // A 正例：追加一条（计划原有的那条原样保留；新条目带来源标记）
    // =====================================================================
    const planDeferred = { kind: 'architecture_diagram', why: '计划声明：本次是 7 文件静态页，没有架构面', accepted_by: 'user' }
    const newDeferred = { kind: 'release_plan', why: '本次不真的动生产，发布与回滚计划可豁免', accepted_by: 'supervisor' }
    let f = null
    {
      const G = 'A 正例：只追加不覆盖'
      f = await amendFixture(h, { tier: 'L4' })
      rec.add(G, '（前置）任务在 ready_dev、档位 L4、planner 有令牌', f.state === 'ready_dev' && f.h.store.peek(f.taskId).roster.tier === 'L4' && typeof f.tokens.planner === 'string', `state=${f.state} tier=${f.h.store.peek(f.taskId).roster.tier}`)

      // 计划已经声明过一条豁免（直接摆到任务卡上：只追加不覆盖的对照组）
      const t0 = f.h.store.peek(f.taskId)
      t0.deferred_artifacts = [planDeferred]
      await f.h.store.recordAudit(f.taskId, 'planner', 'fixture:plan_deferred', { kinds: [planDeferred.kind] })

      const out = await amend(f, { deferred_artifacts: [newDeferred] })
      const t = f.h.store.peek(f.taskId)
      const list = Array.isArray(t.deferred_artifacts) ? t.deferred_artifacts : []
      const added = list.find((x) => x.kind === 'release_plan')
      const kept = list.find((x) => x.kind === 'architecture_diagram')
      rec.add(G, '★★ ready_dev + planner + L4：追加一条 `release_plan`（supervisor 批准）⇒ 成功', out.denied !== true, String(out.text).split('\n').slice(0, 6).join('\n'))
      rec.add(
        G,
        '★★ **只追加、不覆盖**：计划原有的 architecture_diagram **逐字段原样**保留',
        list.length === 2 && eq(kept, planDeferred),
        `list=${JSON.stringify(list)}`,
      )
      rec.add(
        G,
        '★★ 补登项带**来源标记**：`via:"amendment"` + amendment_id + at（关单/status 靠它标注）',
        added?.via === 'amendment' && typeof added?.amendment_id === 'string' && added.amendment_id.startsWith('AM-') && typeof added?.at === 'string',
        JSON.stringify(added ?? null),
      )
      const am = (t.amendments ?? [])[t.amendments.length - 1]
      rec.add(
        G,
        '★ task.amendments[] 记下本次补登 `deferred_added`（含理由/批准人/来源），before/after 的 deferred 清单也对得上',
        Array.isArray(am?.deferred_added) && am.deferred_added.length === 1 && am.deferred_added[0].kind === 'release_plan' && eq(am.before?.deferred_artifacts, ['architecture_diagram']) && eq(am.after?.deferred_artifacts, ['architecture_diagram', 'release_plan']),
        JSON.stringify({ deferred_added: am?.deferred_added ?? null, before: am?.before ?? null, after: am?.after ?? null }),
      )
      const rows = (await auditRows(f.taskId, f.h)).filter((r) => r.action === 'scope:amend')
      rec.add(G, '★ audit.jsonl 的 scope:amend 也记了 deferred_added（只追加）', rows.length === 1 && eq(rows[0].deferred_added, ['release_plan']), JSON.stringify(rows[0]?.deferred_added ?? null))
      const deferredMap = deferredArtifactsOf(t)
      rec.add(
        G,
        '★ `deferredArtifactsOf` 同时认计划那条与补登那条，并把 via 透传出来',
        deferredMap.size === 2 && deferredMap.get('release_plan')?.via === 'amendment' && deferredMap.get('architecture_diagram')?.via === undefined,
        JSON.stringify([...deferredMap.values()]),
      )
      rec.add(
        G,
        '★★ `deferralLine`（关单摘要用的那一行）标注「分配后经 amendment 补登」',
        deferralLine(deferredMap.get('release_plan')).includes('分配后经 amendment 补登') && !deferralLine(deferredMap.get('architecture_diagram')).includes('amendment'),
        deferralLine(deferredMap.get('release_plan')),
      )
    }

    // =====================================================================
    // B 展示：pipeline_status 标注 via amendment（紧凑档 + 结构化 products）
    // =====================================================================
    {
      const G = 'B status 标注'
      const st = await callTool(f.h, 'pipeline_status', { task_id: f.taskId, detail: 'summary', role_token: f.tokens.main }, f.agents.main)
      const products = st.value?.products ?? null
      const deferred = Array.isArray(products?.deferred) ? products.deferred : []
      rec.add(
        G,
        '★★ `pipeline_status` 紧凑档：产物行把补登的豁免标成 `via amendment`',
        st.denied !== true && String(st.text).includes('via amendment') && deferred.some((d) => d.kind === 'release_plan' && d.via === 'amendment'),
        String(st.text).split('\n').filter((l) => l.includes('产物（L4')).join('\n'),
      )
      rec.add(
        G,
        '★★ 授权面变更那一行写明「产物豁免补登」（补登不是计划原文，要一眼看得出）',
        String(st.text).includes('产物豁免补登') && String(st.text).includes('release_plan'),
        String(st.text).split('\n').filter((l) => l.includes('授权面变更')).join('\n'),
      )
      const stStore = await f.h.store.status({ taskId: f.taskId })
      rec.add(
        G,
        '★ 结构化 `last_amendment.deferred_added` 可机器读（status 字段不是只写在摘要里）',
        Array.isArray(stStore.last_amendment?.deferred_added) && stStore.last_amendment.deferred_added.length === 1 && stStore.last_amendment.deferred_added[0].kind === 'release_plan',
        JSON.stringify(stStore.last_amendment?.deferred_added ?? null),
      )
      const full = await callTool(f.h, 'pipeline_status', { task_id: f.taskId, detail: 'full', role_token: f.tokens.main }, f.agents.main)
      rec.add(G, '★ 全文档的「补登产物豁免」一行带上理由与批准人（deferralLine）', String(full.text).includes('补登产物豁免') && String(full.text).includes('分配后经 amendment 补登') && String(full.text).includes('release_plan'), '')
    }

    // =====================================================================
    // C 负例：形状 / 档位 / 批准人 / 重复 —— 全拒且**一个字节不改**
    // =====================================================================
    {
      const G = 'C 负例：判据与计划同源'
      const snapshot = () => JSON.stringify({
        deferred: f.h.store.peek(f.taskId).deferred_artifacts,
        amendments: (f.h.store.peek(f.taskId).amendments ?? []).length,
      })
      const before = snapshot()

      const dup = await amend(f, { deferred_artifacts: [planDeferred] })
      rec.add(G, '★★ 重复追加**已在计划里豁免的** kind ⇒ 拒（只追加不覆盖；DUPLICATE_DEFERRED_ARTIFACT）', dup.denied === true && String(dup.text).includes('已经豁免过') && String(dup.text).includes('只追加'), String(dup.text).split('\n').slice(0, 3).join('\n'))

      const nonExempt = await amend(f, { deferred_artifacts: [{ kind: 'security_review', why: '这次先不审安全', accepted_by: 'user' }] })
      rec.add(G, '★★ 测试/审核/安全类**不可豁免**（security_review ⇒ 拒，文案说明不可豁免类）', nonExempt.denied === true && String(nonExempt.text).includes('不可豁免'), String(nonExempt.text).split('\n').slice(0, 4).join('\n'))

      const noWhy = await amend(f, { deferred_artifacts: [{ kind: 'docs_note', why: '', accepted_by: 'user' }] })
      rec.add(G, '★ why 必填 ⇒ 拒（豁免必须写理由）', noWhy.denied === true && String(noWhy.text).includes('why 必填'), String(noWhy.text).split('\n')[1] ?? '')

      const badBy = await amend(f, { deferred_artifacts: [{ kind: 'docs_note', why: '内部脚本，无对外文档面', accepted_by: 'planner' }] })
      rec.add(G, '★★ accepted_by 只能是 user / supervisor ⇒ planner 自己批自己，拒', badBy.denied === true && String(badBy.text).includes('accepted_by'), String(badBy.text).split('\n')[1] ?? '')

      const wrongTierKind = await amend(f, { deferred_artifacts: [{ kind: 'docs_note', why: '本次没有对外文档面', accepted_by: 'user' }] })
      rec.add(G, '★★ 只能豁免**本档**可豁免的产物：L4 不要求 docs_note ⇒ 拒（不是可豁免的必需产物）', wrongTierKind.denied === true && String(wrongTierKind.text).includes('不是可豁免的必需产物'), String(wrongTierKind.text).split('\n').slice(0, 4).join('\n'))

      // supervisor 只在 L4+ 有效：L3 夹具上同样一条 ⇒ 拒
      const f3 = await amendFixture(h, { tier: 'L3' })
      const supOnL3 = await amend(f3, { deferred_artifacts: [{ kind: 'architecture_diagram', why: '本次没有架构面', accepted_by: 'supervisor' }] })
      rec.add(G, '★★ `accepted_by:"supervisor"` 在 L3 **无效**（只 L4+）⇒ 拒', supOnL3.denied === true && /supervisor|L4/.test(String(supOnL3.text)), String(supOnL3.text).split('\n').slice(0, 4).join('\n'))

      // L2 没有可豁免的必需产物矩阵 ⇒ 任何 deferred 都拒
      const f2 = await amendFixture(h, { tier: 'L2' })
      const onL2 = await amend(f2, { deferred_artifacts: [{ kind: 'architecture_diagram', why: '本次没有架构面', accepted_by: 'user' }] })
      rec.add(G, '★★ L2 没有可豁免的必需产物 ⇒ 拒', onL2.denied === true && String(onL2.text).includes('不是可豁免的必需产物'), String(onL2.text).split('\n').slice(0, 4).join('\n'))

      rec.add(G, '★★ 以上全被拒之后：任务卡上的豁免与 amendments **一个字节没变**', snapshot() === before, `before=${before}\nafter=${snapshot()}`)
    }

    // =====================================================================
    // D 其它字段照旧拒绝 / 空数组
    // =====================================================================
    {
      const G = 'D 只许动授权面（含豁免）'
      const t = f.h.store.peek(f.taskId)
      const beforeTier = t.roster?.tier
      const beforeDeferred = JSON.stringify(t.deferred_artifacts)
      const alien = await amend(f, { tier: 'L5', deferred_artifacts: [{ kind: 'docs_note', why: '顺手也豁免文档', accepted_by: 'user' }] })
      rec.add(
        G,
        '★★ 借 amendment 改档位（tier）⇒ **白名单 fail-closed 拒**（即便同时带了合法的 deferred 也不放行）',
        alien.denied === true && String(alien.text).includes('只许动授权面') && String(alien.text).includes('tier'),
        String(alien.text).split('\n').slice(0, 4).join('\n'),
      )
      rec.add(G, '★★ 被拒后档位与豁免都没变（先在副本上算、全部通过才落盘）', f.h.store.peek(f.taskId).roster?.tier === beforeTier && JSON.stringify(f.h.store.peek(f.taskId).deferred_artifacts) === beforeDeferred, `tier=${f.h.store.peek(f.taskId).roster?.tier}`)

      const empty = await amend(f, { deferred_artifacts: [] })
      rec.add(G, '★ `deferred_artifacts: []`（什么都没动）⇒ 拒（"至少要动一处"）', empty.denied === true && String(empty.text).includes('至少要动一处'), String(empty.text).split('\n')[0])

      const nonPlanner = await callTool(
        f.h,
        'pipeline_scope_amend',
        { task_id: f.taskId, why: '主对话想替计划 AI 补一条豁免。', deferred_artifacts: [{ kind: 'docs_note', why: 'x', accepted_by: 'user' }], role_token: f.tokens.main },
        f.agents.main,
      )
      rec.add(G, '★★ 非 planner（主对话）带 deferred ⇒ 拒（这条窄门只有计划 AI 能走）', nonPlanner.denied === true && /角色越权|planner/.test(String(nonPlanner.text)), nonPlanner.layer)

      // 非 ready_dev（计划中）⇒ 拒
      const plan = await amendFixture(h, { stopBeforePlan: true })
      const inPlanning = await callTool(
        plan.h,
        'pipeline_scope_amend',
        { task_id: plan.taskId, why: '计划中直接补豁免。', deferred_artifacts: [{ kind: 'architecture_diagram', why: 'x', accepted_by: 'user' }], role_token: plan.tokens.planner },
        plan.agents.planner,
      )
      rec.add(G, '★★ 其它状态（计划中）⇒ 拒（这条通道只在 ready_dev 生效）', inPlanning.denied === true && String(inPlanning.text).includes('只在'), String(inPlanning.text).split('\n')[0])
    }

    // =====================================================================
    // E 组合：同一次 amendment 里 add + deferred_artifacts ⇒ 两类都落盘、都留痕
    // =====================================================================
    {
      const G = 'E 组合变更'
      const fx = await amendFixture(h, { tier: 'L5' })
      const out = await amend(fx, {
        add: [{ id: 'CS-f40-combo', path: 'src/combo', action: 'modify', why: 'F40 夹具：组合变更的授权条目' }],
        deferred_artifacts: [{ kind: 'perf_report', why: '本次没有性能硬指标，性能报告可豁免', accepted_by: 'user' }],
      })
      const t = fx.h.store.peek(fx.taskId)
      const am = (t.amendments ?? [])[t.amendments.length - 1]
      rec.add(
        G,
        '★★ 同一次 amendment 里「补授权 + 补豁免」⇒ 两类都落盘、同一条 amendment 留痕',
        out.denied !== true &&
          (t.change_scope ?? []).some((e) => e.id === 'CS-f40-combo') &&
          (t.deferred_artifacts ?? []).some((d) => d.kind === 'perf_report' && d.via === 'amendment') &&
          (am?.added ?? []).some((e) => e.id === 'CS-f40-combo') &&
          (am?.deferred_added ?? []).some((d) => d.kind === 'perf_report'),
        JSON.stringify({ scope: (t.change_scope ?? []).map((e) => e.id), deferred: (t.deferred_artifacts ?? []).map((d) => `${d.kind}:${d.via ?? 'plan'}`) }),
      )
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 8).join('\n'))
  } finally {
    await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF40DeferredAmendCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
