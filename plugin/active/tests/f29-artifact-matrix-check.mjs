// P1-18 回归：按档位的必需产物矩阵 + `deferred_artifacts` 豁免。
/**
 * dsh-pipeline · F29：产物矩阵与豁免（P1-18）
 * ============================================================================
 *     node tests/f29-artifact-matrix-check.mjs
 *
 * 现场（设计档 `design/conventions/04-demo与制品模型.md` §4，用户拍板「推荐 A」）：
 * L5 强制 10 个角色全交产物 —— 一个 7 文件静态页也要交架构图 / 发布计划 / 性能报告 /
 * 安全审计 / 文档 / 留档，全链路约 2.5 小时里相当一部分是**仪式性产物**。
 *
 * 修法（本单）：按档位给一张**必需产物矩阵**；计划可以声明 `deferred_artifacts`
 * 豁免"仪式性产物"；关单闸 `role_products_delivered` 改读矩阵。三条硬边界：
 *   · 测试 / 审核 / 安全类产物**不可豁免**（既有闸门照旧执法，deferred 绕不过去）；
 *   · `accepted_by` 只能是 `user` 或 `supervisor`（**supervisor 仅 L4+ 有效**）——
 *     计划不能自己豁免自己；
 *   · `why` 必填；kind 必须是**本档可豁免的必需产物**。
 *
 * 钉住：
 *   A 矩阵取值（L0/L1 交付物+自测；L2 +test_to_review；L3 +security_review；
 *     L4 +架构图+发布计划；L5 +文档+性能；可豁免集合的档位映射）
 *   B deferred 形状 / 批准人校验（user 可、supervisor 需 L4+、非法 kind / 空 why 拒）
 *   C 关单闸「缺产物拒 → 豁免后过」（含"已豁免项/理由/批准人"的文案）
 *   D 不可豁免项 **不能** 被 deferred 绕过（security_review / test_to_review / dev_to_test）
 *   E L0–L3 不被高阶产物误伤
 *   F pipeline_plan 接线：非法 ⇒ 拒收计划（在分配前，不落 plan 交接物）；
 *     合法 ⇒ 落 `task.deferred_artifacts` + plan payload + 状态进「待开发」；
 *     `pipeline_status` 显示"必需 / 已交 / 已豁免（理由）"
 */

import { pathToFileURL } from 'node:url'

import { createHarness, disposeHarness } from './selftest-core.mjs'
import {
  PRODUCT_KINDS,
  PRODUCT_ORDER,
  TIERS,
  TIER_PRODUCT_REQUIREMENTS,
  deferrableProductsOf,
  deferredArtifactsOf,
  nonExemptibleProductsOf,
  productStatusFor,
  requiredProductsOf,
  validateDeferredArtifacts,
} from '../lib/tiers.js'

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
      const L = ['dsh-pipeline · F29：按档位的必需产物矩阵 + deferred_artifacts 豁免（P1-18）', '='.repeat(78)]
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

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const kindsOf = (list) => list.map((p) => p.kind)

/** 一张停在某档位、某个状态的任务（判据单测用：直接摆状态/Roster，不验前面怎么走到这里）。 */
async function taskAt(h, id, tier, execRoles, state = 'passed') {
  const opened = await h.store.open({ actorRole: 'main', requirement: `F29 夹具：${tier} 任务（产物矩阵）。`, id })
  if (opened.ok !== true) throw new Error(`开单失败：${opened.error}`)
  const t = h.store.peek(id)
  t.state = state
  t.roster = { ...(t.roster ?? {}), tier, execution_roles: execRoles.slice(), conversations: ['main', ...execRoles], sequence: [] }
  t.handoffs = []
  t.deferred_artifacts = []
  return t
}

/** `pipeline_plan` 的一次合法入参（按层分工退化到单席位；档位/边界卡按本档给齐）。 */
function planArgs(taskId, tier, deferredArtifacts, token) {
  const execRoles = TIERS[tier].execution
  return {
    task_id: taskId,
    plan_steps: ['冻结接口契约', '按层实现', '自测后交测试'],
    layers: [],
    self_check_verdict: 'ok',
    self_check_checked: ['需求覆盖（验收标准逐条有落点）', '层边界（路径互不重叠）', '依赖顺序（接口先冻结）'],
    self_check_gaps: [],
    plan_reason: 'F29 夹具：按档位出计划；本档的仪式性产物按计划声明豁免。',
    change_scope: [{ id: 'CS1', path: '.', action: 'modify', why: 'F29 夹具：单席位，范围是整棵项目根' }],
    forbidden: ['不许顺手重构（改动面必须与授权面相等）', '不许改测试', '不许扩范围'],
    role_boundaries: execRoles.map((r) => ({ role: r, only: [`只干「${r}」这一份活`], not: ['不干别人的活', '不扩大改动面'] })),
    role_scope: { will_do: ['出计划、自检、分配 AI'], will_not_do: ['不写实现、不读代码、不跑测试'] },
    tier,
    reason: `F29 夹具：${tier} 档，产物矩阵按档位算`,
    acceptance: ['按需求实现'],
    test_points: ['正常路径'],
    boundaries: ['不改公开接口'],
    ...(deferredArtifacts === undefined ? {} : { deferred_artifacts: deferredArtifacts }),
    role_token: token,
  }
}

export async function runF29ArtifactMatrixCheck() {
  const rec = createRecorder()
  const h = await createHarness({})
  try {
    // =====================================================================
    // A 矩阵取值（纯函数；单一出处）
    // =====================================================================
    {
      const G = 'A 档位矩阵取值'
      const expected = {
        // L0/L1 的必需产物就是"交付物本体 + 自测"（由 dev_to_test 携带），没有额外交接物。
        L0: ['dev_to_test'],
        L1: ['dev_to_test'],
        L2: ['dev_to_test', 'test_to_review'],
        L3: ['dev_to_test', 'test_to_review', 'security_review'],
        L4: ['dev_to_test', 'test_to_review', 'security_review', 'architecture_diagram', 'release_plan'],
        L5: ['dev_to_test', 'test_to_review', 'security_review', 'architecture_diagram', 'release_plan', 'docs_note', 'perf_report'],
      }
      const actual = Object.fromEntries(Object.keys(expected).map((t) => [t, kindsOf(requiredProductsOf(t))]))
      rec.add(G, '★★ 每档 required 与用户拍板的映射**逐项相等**（L0/L1 交付物+自测 → L5 全量）', eq(actual, expected), JSON.stringify(actual))

      const deferrable = Object.fromEntries(Object.keys(expected).map((t) => [t, deferrableProductsOf(t)]))
      rec.add(
        G,
        '★★ "可豁免的必需产物"：L0~L3 无、L4 = 架构图+发布计划、L5 = 再加文档+性能',
        eq(deferrable, { L0: [], L1: [], L2: [], L3: [], L4: ['architecture_diagram', 'release_plan'], L5: ['architecture_diagram', 'release_plan', 'docs_note', 'perf_report'] }),
        JSON.stringify(deferrable),
      )
      rec.add(
        G,
        '★★ 测试 / 审核 / 安全类 + 交付物本体**不可豁免**（分类是全局的，与档位无关）',
        nonExemptibleProductsOf('L5').join(',') === 'dev_to_test,test_to_review,security_review' &&
          PRODUCT_KINDS.security_review.exemptible === false &&
          PRODUCT_KINDS.test_to_review.exemptible === false &&
          PRODUCT_KINDS.dev_to_test.exemptible === false,
        `non_exemptible=${nonExemptibleProductsOf('L5').join(',')}`,
      )
      rec.add(
        G,
        '★ 矩阵里每个 kind 都在 `PRODUCT_KINDS` 里有定义（单一出处，不手抄第二份）',
        Object.values(TIER_PRODUCT_REQUIREMENTS).every((kinds) => kinds.every((k) => PRODUCT_KINDS[k] !== undefined)) &&
          PRODUCT_ORDER.every((k) => PRODUCT_KINDS[k] !== undefined),
        `kinds=${PRODUCT_ORDER.join('/')}`,
      )
      rec.add(
        G,
        '★ 档位未知 / 非法 ⇒ 矩阵**弃权**（空数组，不猜一个档位去误伤）',
        requiredProductsOf('').length === 0 &&
          requiredProductsOf('X9').length === 0 &&
          requiredProductsOf(null).length === 0 &&
          productStatusFor({ roster: { tier: 'X9' }, handoffs: [] }).known === false,
        JSON.stringify({ bad: requiredProductsOf('X9'), statusKnown: productStatusFor({ roster: { tier: 'X9' }, handoffs: [] }).known }),
      )
    }

    // =====================================================================
    // B deferred_artifacts 的形状 / 批准人校验（纯函数）
    // =====================================================================
    {
      const G = 'B deferred 形状与批准人'
      const v = (list, tier) => validateDeferredArtifacts(list, { tier })

      const userL4 = v([{ kind: 'architecture_diagram', why: '本次是内部脚本，不需要架构图', accepted_by: 'user' }], 'L4')
      rec.add(G, '★★ user 批准 + L4 可豁免产物 ⇒ **通过**', userL4.ok === true, userL4.errors.join('\n'))

      const supL4 = v([{ kind: 'release_plan', why: '本次不真的动生产', accepted_by: 'supervisor' }], 'L4')
      rec.add(G, '★★ supervisor 批准 + L4 ⇒ **通过**', supL4.ok === true, supL4.errors.join('\n'))

      const supL5 = v([{ kind: 'docs_note', why: '纯内部脚本，无对外文档面', accepted_by: 'supervisor' }], 'L5')
      rec.add(G, '★ supervisor 批准 + L5 ⇒ 通过', supL5.ok === true, supL5.errors.join('\n'))

      const supL3 = v([{ kind: 'architecture_diagram', why: '想跳过架构图', accepted_by: 'supervisor' }], 'L3')
      rec.add(
        G,
        '★★ **supervisor 仅 L4+ 有效**：L3 用 supervisor 批准 ⇒ 拒（低档没有主管席位）',
        supL3.ok !== true && supL3.errors.some((e) => e.includes('L4+') && e.includes('supervisor')),
        supL3.errors.join('\n'),
      )

      const emptyWhy = v([{ kind: 'architecture_diagram', why: '   ', accepted_by: 'user' }], 'L4')
      rec.add(G, '★★ `why` 必填（空 / 空白 ⇒ 拒）', emptyWhy.ok !== true && emptyWhy.errors.some((e) => e.includes('why')), emptyWhy.errors.join('\n'))

      const badKind = v([{ kind: 'mystery_product', why: 'x', accepted_by: 'user' }], 'L4')
      rec.add(G, '★★ 未知 kind ⇒ 拒（并列出合法值）', badKind.ok !== true && badKind.errors.some((e) => e.includes('不是已知产物')), badKind.errors.join('\n'))

      const plannerAccepted = v([{ kind: 'architecture_diagram', why: 'x', accepted_by: 'planner' }], 'L4')
      rec.add(
        G,
        '★★ `accepted_by=planner` ⇒ 拒（**计划不能自己豁免自己**）',
        plannerAccepted.ok !== true && plannerAccepted.errors.some((e) => e.includes('计划不能自己豁免自己')),
        plannerAccepted.errors.join('\n'),
      )

      const notRequiredAtTier = v([{ kind: 'docs_note', why: 'L4 没要求文档', accepted_by: 'user' }], 'L4')
      rec.add(
        G,
        '★★ 本档**不要求**的产物不许声明豁免（L4 的 docs_note ⇒ 拒，文案给出本档可豁免清单）',
        notRequiredAtTier.ok !== true && notRequiredAtTier.errors.some((e) => e.includes('不是可豁免的必需产物') && e.includes('architecture_diagram')),
        notRequiredAtTier.errors.join('\n'),
      )

      const duplicate = v(
        [
          { kind: 'architecture_diagram', why: 'a', accepted_by: 'user' },
          { kind: 'architecture_diagram', why: 'b', accepted_by: 'user' },
        ],
        'L4',
      )
      rec.add(G, '★ 同一 kind 重复声明 ⇒ 拒', duplicate.ok !== true && duplicate.errors.some((e) => e.includes('重复')), duplicate.errors.join('\n'))

      rec.add(
        G,
        '★ 不传 / null ⇒ 通过且归一化为空数组（旧计划没有这个字段，不该被误伤）',
        v(undefined, 'L4').ok === true && v(null, 'L4').items.length === 0,
        JSON.stringify(v(undefined, 'L4')),
      )
    }

    // =====================================================================
    // C 关单闸：缺产物拒 → 豁免后过
    // =====================================================================
    {
      const G = 'C 关单闸读矩阵 + 豁免'
      const EXEC_L4 = ['writer', 'tester', 'reviewer', 'diagrammer', 'release']
      const t = await taskAt(h, 'T-F29C', 'L4', EXEC_L4)

      const before = await h.store.checkPrecondition(t, 'role_products_delivered')
      rec.add(
        G,
        '★★ 缺"架构图 + 发布计划" ⇒ **拒绝关单**（MISSING_ROLE_PRODUCT，文案点名缺失项）',
        before.ok !== true &&
          before.code === 'MISSING_ROLE_PRODUCT' &&
          before.error.includes('架构图') &&
          before.error.includes('发布与回滚计划'),
        String(before.error ?? '').split('\n').slice(0, 6).join('\n'),
      )
      // 关单组合闸：既有 diagram_delivered 与矩阵闸会**同时**点名缺架构图（缺口一次列全）。
      const closeGapsBefore = await h.store.closeGaps(t)
      rec.add(
        G,
        '★ 未豁免时，关单组合闸同时点名 MISSING_DIAGRAM 与 MISSING_ROLE_PRODUCT（缺口不早退）',
        closeGapsBefore.some((g) => g.code === 'MISSING_DIAGRAM') && closeGapsBefore.some((g) => g.code === 'MISSING_ROLE_PRODUCT'),
        closeGapsBefore.map((g) => `[${g.code}]`).join(' '),
      )

      t.deferred_artifacts = [
        { kind: 'architecture_diagram', why: '本次是 7 文件静态页，没有架构面', accepted_by: 'user' },
        { kind: 'release_plan', why: '本次不真的动生产', accepted_by: 'supervisor' },
      ]
      const after = await h.store.checkPrecondition(t, 'role_products_delivered')
      rec.add(
        G,
        '★★ 同一条闸：两份都被 `deferred_artifacts` **合法豁免** ⇒ **放行**',
        after.ok === true,
        String(after.error ?? `ok=${after.ok}`),
      )
      /**
       * ★★ 一致性：架构图还有**另一道**既有闸门 `diagram_delivered`（清单里有架构角色就要求交图）。
       * 计划显式豁免架构图之后，那道闸必须跟着放行 —— 否则"已豁免不拒"就是空话
       * （role_products 认了豁免、diagram_delivered 照旧拒，两个闸门互相打脸）。
       */
      const closeGapsWithDefer = await h.store.closeGaps(t)
      rec.add(
        G,
        '★★ 架构图被豁免后：关单组合闸里**没有** MISSING_DIAGRAM，也没有 MISSING_ROLE_PRODUCT（两道闸口径一致）',
        !closeGapsWithDefer.some((g) => g.code === 'MISSING_DIAGRAM') && !closeGapsWithDefer.some((g) => g.code === 'MISSING_ROLE_PRODUCT'),
        closeGapsWithDefer.map((g) => `[${g.code}]`).join(' '),
      )
      rec.add(
        G,
        '★★ 放行时的结果**写清豁免**（kind / 理由 / 批准人；"已豁免不拒但摘要要写清豁免"）',
        after.ok === true &&
          Array.isArray(after.deferred) &&
          after.deferred.length === 2 &&
          after.deferred.some((d) => d.kind === 'architecture_diagram' && d.accepted_by === 'user' && d.why.includes('静态页')) &&
          after.deferred.some((d) => d.kind === 'release_plan' && d.accepted_by === 'supervisor') &&
          String(after.summary ?? '').includes('已豁免') &&
          String(after.summary ?? '').includes('批准人'),
        JSON.stringify({ deferred: after.deferred ?? null, summary: after.summary ?? null }),
      )

      // 部分豁免：已豁免的要列出来，缺的照旧拒
      const EXEC_L5 = ['writer', 'tester', 'reviewer', 'diagrammer', 'release', 'docs', 'performance']
      const t2 = await taskAt(h, 'T-F29C2', 'L5', EXEC_L5)
      t2.deferred_artifacts = [{ kind: 'docs_note', why: '纯内部脚本，无对外文档面', accepted_by: 'user' }]
      const partial = await h.store.checkPrecondition(t2, 'role_products_delivered')
      rec.add(
        G,
        '★★ 只豁免一项、其余仍缺 ⇒ 拒；**拒绝文案同时列出"缺的"与"已豁免（理由/批准人）"**',
        partial.ok !== true &&
          partial.code === 'MISSING_ROLE_PRODUCT' &&
          partial.error.includes('架构图') &&
          partial.error.includes('已豁免') &&
          partial.error.includes('文档 / 变更日志') &&
          partial.error.includes('纯内部脚本'),
        String(partial.error ?? '').split('\n').slice(0, 10).join('\n'),
      )
    }

    // =====================================================================
    // D 不可豁免项不能被 deferred 绕过
    // =====================================================================
    {
      const G = 'D 不可豁免项不许绕过'
      const bad = validateDeferredArtifacts(
        [
          { kind: 'security_review', why: '计划想跳过安全审计', accepted_by: 'user' },
          { kind: 'test_to_review', why: '计划想跳过测试报告', accepted_by: 'user' },
          { kind: 'review_verdict', why: '计划想跳过审核结论', accepted_by: 'user' },
          { kind: 'dev_to_test', why: '计划想连交付物都不交', accepted_by: 'user' },
        ],
        { tier: 'L5' },
      )
      rec.add(
        G,
        '★★ 纯校验：安全 / 测试 / 审核类 + 交付物本体一律**不可豁免**（四条都拒）',
        bad.ok !== true && bad.errors.filter((e) => e.includes('不可豁免')).length === 4,
        bad.errors.join('\n'),
      )

      // 防御面：即使任务卡上被人塞了非法豁免（旧数据 / 直接 handoff / 手改），也不认。
      const EXEC_L3 = ['writer', 'tester', 'reviewer', 'security']
      const t = await taskAt(h, 'T-F29D', 'L3', EXEC_L3)
      t.deferred_artifacts = [{ kind: 'security_review', why: '计划想跳过安全审计', accepted_by: 'user' }]
      rec.add(G, '★★ 任务卡上的非法豁免**不被承认**（`deferredArtifactsOf` 只认合法条目）', deferredArtifactsOf(t).size === 0, JSON.stringify([...deferredArtifactsOf(t)]))

      const sec = await h.store.checkPrecondition(t, 'security_not_blocked')
      rec.add(
        G,
        '★★ L3+ 的安全独立结论照旧被既有闸门拦（MISSING_SECURITY_REVIEW）—— deferred 绕不过去',
        sec.ok !== true && sec.code === 'MISSING_SECURITY_REVIEW',
        JSON.stringify({ ok: sec.ok, code: sec.code ?? null }),
      )
      const gaps = await h.store.closeGaps(t)
      rec.add(
        G,
        '★★ `closeGaps`（关单组合闸）里**仍然**有 MISSING_SECURITY_REVIEW —— 关单逃不掉',
        gaps.some((g) => g.code === 'MISSING_SECURITY_REVIEW'),
        gaps.map((g) => `[${g.code}]`).join(' '),
      )
    }

    // =====================================================================
    // E L0–L3 不被高阶产物误伤
    // =====================================================================
    {
      const G = 'E 低档不被矩阵误伤'
      for (const tier of ['L0', 'L1', 'L2', 'L3']) {
        const t = await taskAt(h, `T-F29E-${tier}`, tier, TIERS[tier].execution)
        const r = await h.store.checkPrecondition(t, 'role_products_delivered')
        rec.add(
          G,
          `★ ${tier}：在册角色交齐前，这一条闸**不要求**任何仪式性产物（放行）`,
          r.ok === true && (r.required ?? []).length === 0,
          `ok=${r.ok} required=${JSON.stringify(r.required ?? [])}`,
        )
        const ps = productStatusFor(t)
        rec.add(
          G,
          `★ ${tier}：矩阵照常列出必需产物（${ps.required.length} 项），但**可豁免集合为空**`,
          ps.known === true && deferrableProductsOf(tier).length === 0 && ps.required.length === TIER_PRODUCT_REQUIREMENTS[tier].length,
          `required=${ps.required.map((p) => p.kind).join(',')} deferrable=${JSON.stringify(deferrableProductsOf(tier))}`,
        )
      }
    }

    // =====================================================================
    // F pipeline_plan 接线（拒收 / 落盘 / 状态 / status 展示）
    // =====================================================================
    {
      const G = 'F pipeline_plan 接线（落盘 + 拒收 + status）'
      const mkPlanTask = async (id) => {
        const opened = await h.store.open({ actorRole: 'main', requirement: `F29 夹具：${id} 计划接线（L4）。`, id })
        if (opened.ok !== true) throw new Error(`开单失败：${opened.error}`)
        const t = h.store.peek(id)
        t.state = 'planning'
        return t
      }
      const plannerTok = (id) => h.tokens.mint({ taskId: id, role: 'planner', agentId: `f29-planner-${id}`, note: 'f29' }).token
      const planTool = h.byName.get('pipeline_plan')

      // F-a 非法（不可豁免类）⇒ 拒收计划，**在分配前**（不留 plan 交接物、状态不变）
      {
        const id = 'T-F29F-A'
        await mkPlanTask(id)
        const tok = plannerTok(id)
        const out = await planTool.execute(
          planArgs(id, 'L4', [{ kind: 'security_review', why: '计划想跳过安全审计', accepted_by: 'user' }], tok),
          { agent: { id: `f29-planner-${id}` } },
        )
        const t = h.store.peek(id)
        rec.add(
          G,
          '★★ 非法豁免（security_review）⇒ **拒收计划**（ok=false，文案说清不可豁免）',
          out?.ok !== true && String(out?.summary ?? '').includes('不可豁免'),
          String(out?.summary ?? '').split('\n').slice(0, 4).join('\n'),
        )
        rec.add(
          G,
          '★★ 拒收发生在**分配前**：plan 交接物没落盘、状态仍在「计划中」、角色清单仍是空',
          t.state === 'planning' && (t.handoffs ?? []).filter((x) => x.kind === 'plan').length === 0 && t.roster === null,
          JSON.stringify({ state: t.state, plans: (t.handoffs ?? []).filter((x) => x.kind === 'plan').length, roster: t.roster ?? null }),
        )
      }

      // F-b 空 why ⇒ 拒收
      {
        const id = 'T-F29F-B'
        await mkPlanTask(id)
        const tok = plannerTok(id)
        const out = await planTool.execute(
          planArgs(id, 'L4', [{ kind: 'architecture_diagram', why: '', accepted_by: 'user' }], tok),
          { agent: { id: `f29-planner-${id}` } },
        )
        const t = h.store.peek(id)
        rec.add(
          G,
          '★★ 空 why ⇒ 拒收计划（且没有落 plan 交接物）',
          out?.ok !== true && String(out?.summary ?? '').includes('why') && (t.handoffs ?? []).filter((x) => x.kind === 'plan').length === 0,
          String(out?.summary ?? '').split('\n').slice(0, 4).join('\n'),
        )
      }

      // F-c 合法 ⇒ 落 task.deferred_artifacts + plan payload + 状态进「待开发」
      {
        const id = 'T-F29F-C'
        await mkPlanTask(id)
        const tok = plannerTok(id)
        const deferred = [
          { kind: 'architecture_diagram', why: '本次是 7 文件静态页，没有架构面', accepted_by: 'user' },
          { kind: 'release_plan', why: '本次不真的动生产', accepted_by: 'supervisor' },
        ]
        const out = await planTool.execute(planArgs(id, 'L4', deferred, tok), { agent: { id: `f29-planner-${id}` } })
        const t = h.store.peek(id)
        const planHandoff = (t.handoffs ?? []).find((x) => x.kind === 'plan')
        rec.add(G, '★★ 合法豁免 ⇒ 计划提交并分配成功（ok=true，摘要写清豁免）', out?.ok === true && String(out?.summary ?? '').includes('已声明产物豁免'), String(out?.summary ?? '').slice(0, 400))
        rec.add(
          G,
          '★★ **落盘进 task**：`task.deferred_artifacts` 与声明的两项逐项一致（含 why / accepted_by）',
          eq(t.deferred_artifacts, deferred),
          JSON.stringify(t.deferred_artifacts ?? null),
        )
        rec.add(
          G,
          '★★ plan 交接物 payload 里也登记了同一份形状（历史可追溯）',
          planHandoff !== undefined && eq(planHandoff.payload?.deferred_artifacts, deferred),
          JSON.stringify(planHandoff?.payload?.deferred_artifacts ?? null),
        )
        rec.add(G, '★ 计划工具输出里回带 deferred_artifacts', eq(out?.deferred_artifacts, deferred), JSON.stringify(out?.deferred_artifacts ?? null))
        rec.add(G, '★ 分配完成 ⇒ L4 进入 DEMO 阶段（demo_building，P1-7 后 L3+ 必经）', t.state === 'demo_building', t.state)

        // status：紧凑档一行显示"必需 / 已交 / 已豁免（理由）"
        const st = h.byName.get('pipeline_status')
        const stOut = await st.execute({ task_id: id, detail: 'summary' }, { agent: { id: `f29-main-${id}` } })
        rec.add(
          G,
          '★★ `pipeline_status` 紧凑档**一行**显示：必需 / 已交 / 已豁免（理由、批准人）/ 缺',
          stOut?.ok === true &&
            stOut?.products?.known === true &&
            stOut.products.tier === 'L4' &&
            stOut.products.deferred.length === 2 &&
            String(stOut.summary).includes('产物（L4）') &&
            String(stOut.summary).includes('已豁免 2') &&
            String(stOut.summary).includes('架构图') &&
            String(stOut.summary).includes('静态页'),
          String(stOut?.summary ?? '').split('\n').filter((l) => l.includes('产物')).join('\n'),
        )
        rec.add(
          G,
          '★ status 的结构化 `products` 与关单闸同源：deferred / missing 都能机器读',
          stOut?.products?.known === true &&
            Array.isArray(stOut.products.missing) &&
            stOut.products.missing.includes('test_to_review') &&
            !stOut.products.missing.includes('architecture_diagram') &&
            !stOut.products.missing.includes('release_plan'),
          JSON.stringify({ deferred: stOut?.products?.deferred ?? null, missing: stOut?.products?.missing ?? null }),
        )
      }
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
  runF29ArtifactMatrixCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
