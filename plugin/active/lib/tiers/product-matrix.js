// 按档位的必需产物矩阵 + `deferred_artifacts` 豁免判据（P1-18 的单一出处）。
/**
 * dsh-pipeline · 按档位的必需产物矩阵
 * ============================================================================
 * 现场（P1-18 · 设计档 `design/conventions/04-demo与制品模型.md` §4）：
 * L5 会强制 10 个角色全交产物 —— 一个 7 文件静态页也要交架构图 / 发布计划 /
 * 性能报告 / 安全审计 / 文档 / 留档，全链路约 2.5 小时里相当一部分是**仪式性产物**。
 *
 * 用户拍板的方案（推荐 A）：
 *   · 给每个档位一张**必需产物矩阵**（本文件 `TIER_PRODUCT_REQUIREMENTS`）；
 *   · 计划可以声明 `deferred_artifacts: [{kind, why, accepted_by}]` **豁免**；
 *   · 关单的 `role_products_delivered` 判据改读矩阵（在册角色 ∧ 未被豁免）。
 *
 * ---------------------------------------------------------------------------
 * 三条边界（写在这里，因为它们是这份矩阵存在的理由）
 * ---------------------------------------------------------------------------
 *   ① **测试 / 审核 / 安全类产物不可豁免**：
 *      它们是"这三权分立到底有没有发生"的判据，不是仪式。允许豁免等于把
 *      三权分立退化成"计划说不用就不用了"。
 *   ② **计划不能自己豁免自己**：`accepted_by` 只能是 `user`（用户）或
 *      `supervisor`（主管，且仅 L4+ 有效）。计划 AI 自己的"我觉得不必"不算批准。
 *   ③ **不可豁免项照旧由既有闸门执法**：`review_ok_exists`（审核 OK）、
 *      `security_not_blocked`（安全独立结论）、`test_to_review` 的状态机边 ——
 *      一个字节都没动，`deferred_artifacts` 绕不过它们。
 *
 * ★ 本文件是**纯函数**：不读盘、不碰状态机、不认识 store。
 *   档位、产物、豁免三件事的取值都只在这里定义（别处不许再手抄一份）。
 * ★ 本文件超 400 行，按 `CONVENTIONS.md` §4 的「必要性 ①」不拆：它是**一张声明表 +
 *   一组纯判据**（矩阵、产物规格、豁免校验、状态派生），切开只会制造跨文件引用与漂移。
 *
 * @module dsh-pipeline/lib/tiers/product-matrix
 */

import { TIER_ORDER, tierAtLeast } from './constants.js'

/**
 * 产物 kind 的完整清单 —— **唯一出处**。
 *
 * 字段：
 *   · `kind`      交接物的类型（`lib/model/handoff-schemas.js` 里的同名 kind）
 *   · `zh`        人话名（拒绝文案 / 状态展示用）
 *   · `role`      产出它的角色（判断"在册角色才要求"时用）
 *   · `cls`       大类（delivery / test / review / security / ritual）
 *   · `exemptible` 能不能被 `deferred_artifacts` 豁免
 *   · `yes/no`    为什么（豁免 / 不能豁免的理由，写进拒绝文案）
 *
 * @type {Readonly<Record<string, {kind:string, zh:string, role:string, cls:string, cls_zh:string, exemptible:boolean, why:string}>>}
 */
export const PRODUCT_KINDS = Object.freeze({
  dev_to_test: Object.freeze({
    kind: 'dev_to_test',
    zh: '交付物本体 + 自测',
    role: 'writer',
    cls: 'delivery',
    cls_zh: '交付类',
    exemptible: false,
    why: '交付物本体与自测是这一单存在的理由 —— 没有它就没有可交付的东西。',
  }),
  test_to_review: Object.freeze({
    kind: 'test_to_review',
    zh: '测试报告',
    role: 'tester',
    cls: 'test',
    cls_zh: '测试类',
    exemptible: false,
    why: '测试类产物不可豁免：它是"编写不跑测试、测试独立判"这条三权分立的证据。',
  }),
  review_verdict: Object.freeze({
    kind: 'review_verdict',
    zh: '审核结论（有效审核 OK）',
    role: 'reviewer',
    cls: 'review',
    cls_zh: '审核类',
    exemptible: false,
    why: '审核类产物不可豁免：有效审核 OK 是关单的前置事实（既有 `review_ok_exists` 判据），豁免它等于让主对话自己给自己关单。',
  }),
  security_review: Object.freeze({
    kind: 'security_review',
    zh: '安全审计',
    role: 'security',
    cls: 'security',
    cls_zh: '安全类',
    exemptible: false,
    why: '安全类产物不可豁免：安全角色是独立的一票，不能被计划声明"这次不用"。',
  }),
  architecture_diagram: Object.freeze({
    kind: 'architecture_diagram',
    zh: '架构图',
    role: 'diagrammer',
    cls: 'ritual',
    cls_zh: '仪式性交付',
    exemptible: true,
    why: '架构图按档位要求；L4/L5 在册架构角色可以用 deferred_artifacts 声明豁免。',
  }),
  release_plan: Object.freeze({
    kind: 'release_plan',
    zh: '发布与回滚计划',
    role: 'release',
    cls: 'ritual',
    cls_zh: '仪式性交付',
    exemptible: true,
    why: '发布计划按档位要求；L4/L5 可以声明豁免（例如本次不真的动生产）。',
  }),
  docs_note: Object.freeze({
    kind: 'docs_note',
    zh: '文档 / 变更日志',
    role: 'docs',
    cls: 'ritual',
    cls_zh: '仪式性交付',
    exemptible: true,
    why: '文档按档位要求；L4/L5 可以声明豁免（例如纯内部脚本、无对外文档面）。',
  }),
  perf_report: Object.freeze({
    kind: 'perf_report',
    zh: '性能基准与回归结论',
    role: 'performance',
    cls: 'ritual',
    cls_zh: '仪式性交付',
    exemptible: true,
    why: '性能报告按档位要求；L4/L5 可以声明豁免（例如本次没有性能硬指标）。',
  }),
})

/** 产物 kind 的展示顺序（状态展示 / 拒绝文案按它排；别按对象键序猜）。 */
export const PRODUCT_ORDER = Object.freeze([
  'dev_to_test',
  'test_to_review',
  'review_verdict',
  'security_review',
  'architecture_diagram',
  'release_plan',
  'docs_note',
  'perf_report',
])

/** 可豁免的产物 kind（全局分类；**不等于**每个档位都能豁免它 —— 见 deferrableProductsOf）。 */
export const EXEMPTIBLE_PRODUCT_KINDS = Object.freeze(PRODUCT_ORDER.filter((k) => PRODUCT_KINDS[k].exemptible))

/** 不可豁免的产物 kind（测试 / 审核 / 安全类 + 交付物本体）。 */
export const NON_EXEMPTIBLE_PRODUCT_KINDS = Object.freeze(PRODUCT_ORDER.filter((k) => PRODUCT_KINDS[k].exemptible !== true))

/**
 * 三个"角色固有产物"（既有 `role_products_delivered` 判据覆盖的那三样）。
 *
 * ★ 为什么矩阵之外还要留这一份：既有判据的口径是"**清单里派了它，就得交它那一份**"，
 *   而低档位的夹具 / 旧单可能手工把 release/docs/performance 写进 `execution_roles`
 *   （矩阵本身在那个档位不要求这三样）。把它并进判据 = 既有行为一个字不变。
 */
export const LEGACY_ROLE_PRODUCT_KINDS = Object.freeze(['release_plan', 'docs_note', 'perf_report'])

/**
 * ★★ **按档位的必需产物矩阵**（P1-18 的核心表）。
 *
 * 映射来自用户拍板（设计档 §4）：
 *   · L0/L1：交付物本体 + 自测（无额外交接物）
 *   · L2  ：+ 测试报告
 *   · L3  ：+ 安全审计（有效审核 OK 仍由既有 `review_ok_exists` 判据管，不进这张表）
 *   · L4  ：+ 架构图 + 发布与回滚计划
 *   · L5  ：+ 文档 / 变更日志 + 性能报告
 *
 * ★ 表里的 kind 都在 `PRODUCT_KINDS` 里定义；**可豁免的是其中 `exemptible=true`** 的那部分。
 *   本档"可豁免的必需产物" = `required ∩ exemptible` —— 见 {@link deferrableProductsOf}。
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const TIER_PRODUCT_REQUIREMENTS = Object.freeze({
  L0: Object.freeze(['dev_to_test']),
  L1: Object.freeze(['dev_to_test']),
  L2: Object.freeze(['dev_to_test', 'test_to_review']),
  L3: Object.freeze(['dev_to_test', 'test_to_review', 'security_review']),
  L4: Object.freeze(['dev_to_test', 'test_to_review', 'security_review', 'architecture_diagram', 'release_plan']),
  L5: Object.freeze(['dev_to_test', 'test_to_review', 'security_review', 'architecture_diagram', 'release_plan', 'docs_note', 'perf_report']),
})

/** 档位是否认得（大小写不敏感、两端空白裁剪；与 `constants.js` 的 TIER_ORDER 同源）。 */
export function normalizeTier(tier) {
  const t = typeof tier === 'string' ? tier.trim().toUpperCase() : ''
  return TIER_ORDER.includes(t) ? t : ''
}

/** 一个产物 kind 的规格（认不出返回 `null`）。 */
export function productSpecOf(kind) {
  const k = typeof kind === 'string' ? kind.trim() : ''
  return Object.hasOwn(PRODUCT_KINDS, k) ? PRODUCT_KINDS[k] : null
}

/**
 * 本档**必需**的产物规格（按展示顺序）。
 * 档位未知 / 非法 ⇒ 空数组（**不猜**：宁可不要求，也不拿错的矩阵误伤）。
 *
 * @param {unknown} tier
 * @returns {ReadonlyArray<object>}
 */
export function requiredProductsOf(tier) {
  const t = normalizeTier(tier)
  if (t.length === 0) return []
  const kinds = TIER_PRODUCT_REQUIREMENTS[t] ?? []
  return Object.freeze(kinds.map((k) => PRODUCT_KINDS[k]))
}

/**
 * 本档**可豁免的必需产物** kind（`required ∩ exemptible`，按展示顺序）。
 *
 *   例：L4 ⇒ ['architecture_diagram', 'release_plan']
 *       L5 ⇒ ['architecture_diagram', 'release_plan', 'docs_note', 'perf_report']
 *       L0~L3 ⇒ []（那几档没有"仪式性产物"可豁免）
 *
 * @param {unknown} tier
 * @returns {ReadonlyArray<string>}
 */
export function deferrableProductsOf(tier) {
  return Object.freeze(requiredProductsOf(tier).filter((p) => p.exemptible === true).map((p) => p.kind))
}

/** 某个 kind 在本档是否属于"可豁免的必需产物"。 */
export function isDeferrableProduct(tier, kind) {
  return deferrableProductsOf(tier).includes(String(kind ?? '').trim())
}

/** 本档**不可豁免**的必需产物 kind（测试 / 审核 / 安全 + 交付物本体）。 */
export function nonExemptibleProductsOf(tier) {
  return Object.freeze(requiredProductsOf(tier).filter((p) => p.exemptible !== true).map((p) => p.kind))
}

/** 一组 kind 的人话名（顿号分隔；认不出的原样带出）。 */
export function productKindsText(kinds) {
  return (Array.isArray(kinds) ? kinds : [])
    .map((k) => productSpecOf(k)?.zh ?? String(k))
    .join('、')
}

/** 一条豁免的人话（`架构图（architecture_diagram）：理由 —— 批准人 user`）。 */
export function deferralLine(entry) {
  const spec = productSpecOf(entry?.kind)
  const zh = spec?.zh ?? String(entry?.kind ?? '(未知)')
  const why = String(entry?.why ?? '').trim()
  const by = String(entry?.accepted_by ?? '').trim()
  return `${zh}（${String(entry?.kind ?? '')}）：${why}${by.length === 0 ? '' : `　—— 批准人：${by}`}`
}

/**
 * ★★ `deferred_artifacts` 的**形状 + 档位**校验（纯函数）。
 *
 * 两条用法：
 *   · 计划工具（`pipeline_plan`）在**交计划之前**带上 `tier` 调 ⇒ 全量校验（拒收计划）；
 *   · 交接物层（`lib/handoff/validate.js`）只有形状、没有档位 ⇒ 不传 `tier`，只查形状。
 *     （档位相关的判据必须知道 tier，而那要到分配那一刻才落地。）
 *
 * 校验项（每条都对应一份可追溯的拒绝理由）：
 *   ① 必须是数组；每项是 `{kind, why, accepted_by}` 对象；
 *   ② `kind` 必须是已知产物；**不能是不可豁免类**（测试 / 审核 / 安全 + 交付物本体）；
 *   ③ `kind` 必须是**本档可豁免的必需产物**（给了 tier 时）；
 *   ④ `why` 必填（"为什么不交"要能复核）；
 *   ⑤ `accepted_by` 只能是 `user` / `supervisor`（计划不能自己豁免自己）；
 *   ⑥ `supervisor` 只在 L4+ 有效；
 *   ⑦ 同一 kind 只能声明一次。
 *
 * @param {unknown} value
 * @param {{tier?: unknown}} [opts]
 * @returns {{ok:boolean, errors:string[], items:Array<{kind:string, why:string, accepted_by:string}>}}
 */
export function validateDeferredArtifacts(value, opts = {}) {
  if (value === undefined || value === null) return { ok: true, errors: [], items: [] }
  if (!Array.isArray(value)) {
    return { ok: false, errors: ['deferred_artifacts 必须是数组 [{ kind, why, accepted_by }]。'], items: [] }
  }

  const tier = normalizeTier(opts.tier)
  const tierKnown = tier.length > 0
  const deferrable = tierKnown ? deferrableProductsOf(tier) : null
  const errors = []
  const items = []
  const seen = new Set()

  value.forEach((raw, i) => {
    const label = `deferred_artifacts[${i}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${label} 必须是对象 { kind, why, accepted_by }。`)
      return
    }
    const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
    const why = typeof raw.why === 'string' ? raw.why.trim() : ''
    const acceptedBy = typeof raw.accepted_by === 'string' ? raw.accepted_by.trim() : ''
    const spec = productSpecOf(kind)

    // ② kind 是否合法 / 是否可豁免
    if (kind.length === 0) {
      errors.push(`${label}.kind 必填 —— 要豁免哪一项产物（例如 architecture_diagram / release_plan / docs_note / perf_report）。`)
    } else if (spec === null) {
      errors.push(`${label}.kind=「${kind}」不是已知产物；合法值：${PRODUCT_ORDER.join(' / ')}。`)
    } else if (spec.exemptible !== true) {
      errors.push(
        `${label}.kind=「${kind}」（${spec.zh}）属于**不可豁免类**（${spec.cls_zh}）。\n` +
          `★ ${spec.why}\n` +
          '  测试 / 审核 / 安全类产物只能照既有闸门交付，`deferred_artifacts` 绕不过它们。',
      )
    }

    // ③ 档位相关：必须是本档可豁免的必需产物
    if (tierKnown && spec !== null && spec.exemptible === true && deferrable !== null && !deferrable.includes(kind)) {
      const allowed = deferrable.length === 0 ? '（无）' : deferrable.join(' / ')
      const req = requiredProductsOf(tier).map((p) => p.kind).join(' / ') || '（无）'
      errors.push(
        `${label}.kind=「${kind}」在本档（${tier}）**不是可豁免的必需产物**。\n` +
          `本档必需：${req}\n本档可豁免：${allowed}\n` +
          '★ 豁免只能针对"本档要求、但这次可以不交"的产物；本档不要求的产物无需声明豁免。',
      )
    }

    // ④ why 必填
    if (why.length === 0) {
      errors.push(`${label}.why 必填 —— 豁免必须写理由（"这次为什么不交、凭什么"要能事后复核）。`)
    }

    // ⑤ / ⑥ 批准人
    if (acceptedBy !== 'user' && acceptedBy !== 'supervisor') {
      errors.push(
        `${label}.accepted_by=「${acceptedBy || '(缺失)'}」非法；只能是 \`user\`（用户）或 \`supervisor\`（主管，仅 L4+ 有效）。\n` +
          '★ 计划不能自己豁免自己 —— "我觉得不必"不是批准。',
      )
    } else if (acceptedBy === 'supervisor' && tierKnown && tierAtLeast(tier, 'L4') !== true) {
      errors.push(
        `${label}.accepted_by=supervisor 只在 **L4+** 有效；本档是 ${tier}。\n` +
          '★ 低档位没有主管席位（L3+ 才有强制主管），所以只能由用户批准。',
      )
    }

    // ⑦ 重复声明
    if (kind.length > 0) {
      if (seen.has(kind)) errors.push(`${label}.kind=「${kind}」重复声明 —— 一项产物只能豁免一次。`)
      seen.add(kind)
    }

    items.push({ kind, why, accepted_by: acceptedBy })
  })

  return { ok: errors.length === 0, errors, items }
}

/**
 * 从任务对象上读**被承认的**豁免项（防御式：盘上数据可能来自旧版本 / 手改 / 直接交的 plan）。
 *
 * 只认同时满足以下全部条件的条目（其余一律**不认**，相当于没豁免 ——
 * 这样"豁免"永远不会变成一条可以随手绕开关单闸的旁路）：
 *   · 在本档可豁免的必需产物里；
 *   · `why` 非空；
 *   · `accepted_by` ∈ user / supervisor，且 supervisor 仅 L4+。
 *
 * @param {object} task
 * @returns {Map<string, {kind:string, why:string, accepted_by:string}>}
 */
export function deferredArtifactsOf(task) {
  const map = new Map()
  const list = Array.isArray(task?.deferred_artifacts) ? task.deferred_artifacts : []
  const tier = typeof task?.roster?.tier === 'string' ? task.roster.tier : ''
  const deferrable = new Set(deferrableProductsOf(tier))
  const knownTier = normalizeTier(tier)
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
    const why = typeof raw.why === 'string' ? raw.why.trim() : ''
    const acceptedBy = typeof raw.accepted_by === 'string' ? raw.accepted_by.trim() : ''
    if (!deferrable.has(kind)) continue
    if (why.length === 0) continue
    if (acceptedBy !== 'user' && acceptedBy !== 'supervisor') continue
    if (acceptedBy === 'supervisor' && knownTier.length > 0 && tierAtLeast(knownTier, 'L4') !== true) continue
    map.set(kind, { kind, why, accepted_by: acceptedBy })
  }
  return map
}

/** 任务里是否确实豁免了某个 kind（给其它既有闸门用的窄接口）。 */
export function isProductDeferred(task, kind) {
  return deferredArtifactsOf(task).has(String(kind ?? '').trim())
}

/**
 * ★★ **产物视图**（`pipeline_status` 与关单闸共用同一份派生逻辑）。
 *
 * 只**派生**，不写任何东西：
 *   · `required`  本档矩阵要求的产物（规格 + 是否已交 / 已豁免 / 缺）
 *   · `delivered` 已交的 kind
 *   · `deferred`  已豁免（理由 / 批准人）
 *   · `missing`   应交付、未交、**且未被豁免**的 kind
 *
 * ★ "已交"按 `task.handoffs` 里的 kind 判（同一 kind 交过任意一份即算 ——
 *   与关单闸 `lastHandoff !== null` 的既有口径一致）。
 *
 * @param {object} task
 * @returns {{tier:string|null, known:boolean, required:Array<object>, delivered:string[], deferred:Array<object>, missing:string[], non_exemptible:string[]}}
 */
export function productStatusFor(task) {
  const rawTier = typeof task?.roster?.tier === 'string' ? task.roster.tier : ''
  const tier = normalizeTier(rawTier)
  const known = tier.length > 0
  const deliveredKinds = new Set(
    (Array.isArray(task?.handoffs) ? task.handoffs : [])
      .map((h) => (h !== null && typeof h === 'object' ? h.kind : null))
      .filter((k) => typeof k === 'string'),
  )
  const deferrals = deferredArtifactsOf(task)
  const required = known
    ? requiredProductsOf(tier).map((spec) => ({
        kind: spec.kind,
        zh: spec.zh,
        role: spec.role,
        cls: spec.cls,
        cls_zh: spec.cls_zh,
        exemptible: spec.exemptible === true,
        delivered: deliveredKinds.has(spec.kind),
        deferred: deliveredKinds.has(spec.kind) ? false : deferrals.has(spec.kind),
      }))
    : []
  const delivered = required.filter((x) => x.delivered).map((x) => x.kind)
  const deferred = required
    .filter((x) => x.deferred)
    .map((x) => ({ kind: x.kind, zh: x.zh, ...deferrals.get(x.kind) }))
  const missing = required.filter((x) => x.delivered !== true && x.deferred !== true).map((x) => x.kind)
  return {
    tier: known ? tier : null,
    known,
    required,
    delivered,
    deferred,
    missing,
    non_exemptible: known ? nonExemptibleProductsOf(tier) : [],
  }
}
