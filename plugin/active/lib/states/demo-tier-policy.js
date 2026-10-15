// DEMO 档位策略 · 三档：L0–L1 可跳 / L2 询问 / L3+ 必须出；tier 未知按 L2 保守，非法 tier 直接拒。
/**
 * dsh-pipeline · DEMO 阶段 · 档位策略
 * ============================================================================
 * 裁定 5（= 裁定 7）：「DEMO：**L0–L1 可跳**；**L2 询问**；**L3+ 必须出**」。
 *
 * ---------------------------------------------------------------------------
 * 两条入参边界（需求分析写死的，别放宽）
 * ---------------------------------------------------------------------------
 *   · **tier 未知 / 未编排** ⇒ 按**最保守**处理 = 等同 `L2`（发人工请求询问），
 *     **不得静默跳过 DEMO**。"我不知道这活多复杂"的正确反应是**问**，不是"那就不出了"。
 *   · **tier 非法或非有限值**（`'L9'` / `'x'` / `NaN` / `Infinity` / `-1`）⇒ **拒绝并给可读原因**，
 *     **不得降级成"跳过 DEMO"**。认不出来就说认不出来，不要拿默认值把错误吞掉。
 *
 * ★ 本文件是**纯函数**：不读盘、不碰状态机、不认识任务对象。
 *   它只回答"这个 tier 该怎么处理 DEMO"。
 *
 * @module dsh-pipeline/lib/states/demo-tier-policy
 */

/** 合法档位（顺序即复杂度顺序）。 */
export const TIERS = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'])

/** 不知道 tier 时按哪一档保守处理（边界条件原文：等同 L2）。 */
export const CONSERVATIVE_TIER = 'L2'

/** 三种处置。 */
export const DEMO_ACTION = Object.freeze({
  /** 可以跳过（但"跳过"仍要显式写下来）。 */
  SKIP: 'skip',
  /** 发人工请求**询问**用户要不要出。 */
  ASK: 'ask',
  /** **必须**出 DEMO，未获确认不得进 `ready_dev`。 */
  REQUIRE: 'require',
})

/** 档位 → 处置（唯一出处；别处不许再写一遍 `tier >= 'L3'`）。 */
export const DEMO_TIER_POLICY = Object.freeze({
  L0: DEMO_ACTION.SKIP,
  L1: DEMO_ACTION.SKIP,
  L2: DEMO_ACTION.ASK,
  L3: DEMO_ACTION.REQUIRE,
  L4: DEMO_ACTION.REQUIRE,
  L5: DEMO_ACTION.REQUIRE,
})

/** 必须出 DEMO 的最低档位（裁定 5 的"L3+"）。 */
export const DEMO_REQUIRED_FROM = 'L3'

/** tier 是不是一个**认得出**的合法档位。 */
export function isKnownTier(tier) {
  return typeof tier === 'string' && TIERS.includes(tier.trim().toUpperCase())
}

/**
 * tier 是否"未知"（没编排 / 没给）—— 与"非法"是两件事。
 *
 * 未知 = `undefined` / `null` / 空串；
 * 非法 = 给了个东西，但它不是 `L0`…`L5`。
 *
 * @param {unknown} tier
 * @returns {boolean}
 */
export function isUnknownTier(tier) {
  if (tier === undefined || tier === null) return true
  if (typeof tier === 'string' && tier.trim().length === 0) return true
  return false
}

/**
 * ★ 一个档位该怎么处理 DEMO。
 *
 * @param {unknown} tier
 * @returns {{ok:true, tier:string, action:'skip'|'ask'|'require', assumed:boolean, reason:string}
 *          |{ok:false, code:string, message:string}}
 */
export function demoPlanFor(tier) {
  if (isUnknownTier(tier)) {
    return {
      ok: true,
      tier: CONSERVATIVE_TIER,
      action: DEMO_TIER_POLICY[CONSERVATIVE_TIER],
      assumed: true,
      reason:
        `档位未知 / 未编排 ⇒ **按最保守处理：等同 ${CONSERVATIVE_TIER}**（发人工请求询问）。\n` +
        '★ 边界条件原文：「tier 未知 / 未编排：按最保守处理 —— 等同 L2（发人工请求询问），**不得静默跳过 DEMO**」。',
    }
  }

  // 非有限值（NaN / Infinity）与数字一律不算合法档位 —— 它们是"非法"，不是"未知"。
  if (typeof tier === 'number' || typeof tier === 'bigint' || typeof tier === 'boolean') {
    return {
      ok: false,
      code: 'BAD_TIER',
      message:
        `拒绝：档位 \`${String(tier)}\` **非法**（档位必须是字符串 \`L0\`…\`L5\`）。\n` +
        '★ 边界条件原文：「tier 为非法或非有限值：拒绝并给出可读原因，**不得降级成"跳过 DEMO"**」。',
    }
  }

  const t = String(tier).trim().toUpperCase()
  if (!TIERS.includes(t)) {
    return {
      ok: false,
      code: 'BAD_TIER',
      message:
        `拒绝：档位 \`${String(tier)}\` **认不出来**（合法取值：${TIERS.join(' / ')}）。\n` +
        '★ 认不出来就说认不出来 —— **不得降级成"跳过 DEMO"**，也不许拿默认值把错误吞掉（边界条件原文）。',
    }
  }

  const action = DEMO_TIER_POLICY[t]
  return { ok: true, tier: t, action, assumed: false, reason: reasonFor(t, action) }
}

/** 处置 → 人话理由。 */
function reasonFor(tier, action) {
  if (action === DEMO_ACTION.SKIP) {
    return `档位 ${tier}：L0–L1 **可以跳过** DEMO（裁定 5）。★ 但"跳过"仍是一个**结论**，要显式写下来（\`demo: null\`）。`
  }
  if (action === DEMO_ACTION.ASK) {
    return `档位 ${tier}：**发人工请求询问**用户要不要出 DEMO（裁定 5）。用户说不必出 ⇒ 记成 \`demo: null\` 并继续；说要看 ⇒ 出。`
  }
  return `档位 ${tier}（≥ ${DEMO_REQUIRED_FROM}）：**必须出** DEMO，且**未获用户确认不得进 \`ready_dev\`**（裁定 5 + 验收 A17）。`
}

/**
 * 这个档位是否**必须**出 DEMO（供闸门直接调用，语义比 `action === 'require'` 更直白）。
 *
 * @param {unknown} tier
 * @returns {boolean}
 */
export function demoRequiredForTier(tier) {
  const p = demoPlanFor(tier)
  return p.ok === true && p.action === DEMO_ACTION.REQUIRE
}
