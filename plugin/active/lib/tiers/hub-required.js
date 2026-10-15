// 强制主管 · 档位规则：L3+ 主管必须存在；pending 先设、requirement_confirmed 后按档位留下或撤销。
/**
 * dsh-pipeline · 强制主管 · 档位规则
 * ============================================================================
 * 裁定 1：「开单**先强制设主管**；分析确认后 **tier < L3 则撤销主管**」。
 * 定稿 §3.5：
 *   · `pending`：**先强制设主管**（★ **不做试算**，避免时序矛盾）；
 *   · `requirement_confirmed`：**tier < L3 ⇒ 撤销主管席位**；
 *   · `tier ≥ L3`：**主管必须存在**，否则需求位不可派。
 *
 * ---------------------------------------------------------------------------
 * 为什么 pending 阶段"不做试算"（这条最容易被"优化"掉，所以写死在这）
 * ---------------------------------------------------------------------------
 * `pending` 时**还不知道 tier** —— tier 是计划 AI 的产物，那时候计划还没跑。
 * 于是有两条路：
 *   · **试算**：先猜一个档位，据此决定要不要设主管；
 *   · **先设后撤**：先无条件设上，等需求确认、档位落地了再按档位留或撤。
 *
 * 选后者，因为试算会造出一个**说不清的中间态**：如果先按"大概是 L1"不设主管，
 * 而最后档位是 L4，那么"谁来当主管"这件事就变成了一个**事后补救**的动作；
 * 而补救动作**没有天然的责任人**（主对话会以为机制会自动补）。
 * 先设后撤则任何时候都答得出"主管是谁"。
 *
 * ★ 本文件是**纯策略**：不读盘、不碰任务对象。写盘在 `lib/store/hub-require.js`。
 *
 * @module dsh-pipeline/lib/tiers/hub-required
 */

import { tierAtLeast, tierOrdinal } from './tier-order.js'

/** 必须存在主管的最低档位（裁定 1 / 定稿 §3.5 的"L3+"）。 */
export const HUB_REQUIRED_FROM = 'L3'

/** 主管席位在角色清单里的角色 id（与 `lib/roles.js` 的 `ROLE.SUPERVISOR` 同值）。 */
export const SUPERVISOR_ROLE = 'supervisor'

/** 档位未知时按哪一档保守处理（与 DEMO 同一条口径：L2）。 */
export const CONSERVATIVE_TIER = 'L2'

/** 三种动作。 */
export const HUB_ACTION = Object.freeze({
  /** pending：无条件先设主管。 */
  FORCE: 'force',
  /** 档位 < L3：撤销主管席位。 */
  REVOKE: 'revoke',
  /** 档位 ≥ L3：主管必须存在。 */
  REQUIRE: 'require',
  /** 已经是想要的样子，什么都不用做。 */
  KEEP: 'keep',
})

/**
 * ★ **pending 阶段**：先强制设主管（**不做试算**）。
 *
 * @param {object} [input]
 * @param {string} [input.by]
 * @returns {{action:'force', requiredNow:boolean, reason:string}}
 */
export function hubPlanOnOpen(input = {}) {
  return {
    action: HUB_ACTION.FORCE,
    requiredNow: true,
    reason:
      '开单（`pending`）⇒ **先强制设主管**（裁定 1）。\n' +
      '★ 这里**刻意不做试算**：`pending` 时还没有 tier（tier 是计划 AI 的产物），' +
      '先猜一个档位再决定设不设主管，会在"猜 L1、实际 L4"时留下一个**没有责任人的补救动作**。\n' +
      '★ 档位落地之后由 `requirement_confirmed` 一步决定：`tier < L3` 撤销、`tier ≥ L3` 留下。',
    by: String(input.by ?? ''),
  }
}

/**
 * ★ **`requirement_confirmed`**：按档位决定主管留下还是撤销。
 *
 * @param {object} input
 * @param {unknown} input.tier - 本单档位
 * @param {boolean} [input.hasHubSeat] - 当前**是否已有**主管席位
 * @returns {{ok:true, tier:string, ordinal:number, assumed:boolean, required:boolean,
 *            action:'revoke'|'require'|'keep', reason:string}
 *          |{ok:false, code:string, message:string}}
 */
export function hubPlanOnRequirementConfirmed(input = {}) {
  const raw = input.tier
  const unknown = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim().length === 0)
  const tier = unknown ? CONSERVATIVE_TIER : raw
  const ord = tierOrdinal(tier)
  if (ord.ok !== true) {
    return {
      ok: false,
      code: ord.code,
      message:
        `${ord.message}\n` +
        '★ 档位非法时**不许**降级成"那就不要主管了" —— 认不出来就说认不出来（与 DEMO 档位同一条口径）。',
    }
  }

  const required = tierAtLeast(ord.tier, HUB_REQUIRED_FROM)
  const has = input.hasHubSeat === true

  if (required) {
    return {
      ok: true,
      tier: ord.tier,
      ordinal: ord.ordinal,
      assumed: unknown,
      required: true,
      action: has ? HUB_ACTION.KEEP : HUB_ACTION.REQUIRE,
      reason:
        `档位 ${ord.tier}（≥ ${HUB_REQUIRED_FROM}）⇒ **主管必须存在**${has ? '（已在册）' : '（**当前不在册**）'}。\n` +
        (has
          ? '★ 主管席位保留；需求位可以派。'
          : '★ **需求位不可派** —— 先补上主管席位，否则这一单没有第①道确认的人。') +
        (unknown ? `\n★ tier 未知 / 未编排 ⇒ 按最保守处理（等同 ${CONSERVATIVE_TIER}）。` : ''),
    }
  }

  return {
    ok: true,
    tier: ord.tier,
    ordinal: ord.ordinal,
    assumed: unknown,
    required: false,
    action: has ? HUB_ACTION.REVOKE : HUB_ACTION.KEEP,
    reason:
      `档位 ${ord.tier}（< ${HUB_REQUIRED_FROM}）⇒ **撤销主管席位**（裁定 1）。\n` +
      (has
        ? '★ 为什么要撤：低档位单子走的是"主对话直接调度"那条链，多一个主管只是多一道空转的确认 —— ' +
          '先设为的是"任何时候都答得出主管是谁"，不是为了留住它。'
        : '★ 本来就没有主管席位，无需撤销。') +
      (unknown ? `\n★ tier 未知 / 未编排 ⇒ 按最保守处理（等同 ${CONSERVATIVE_TIER}）。` : ''),
  }
}

/**
 * ★ **需求位能不能派**（`tier ≥ L3` 且无主管 ⇒ 拒）。
 *
 * @param {object} input
 * @param {unknown} input.tier
 * @param {boolean} input.hasHubSeat
 * @param {boolean} [input.requirementConfirmed] - 档位是否已经落地（`requirement_confirmed` 过了）
 * @returns {{ok:true, required:boolean}|{ok:false, code:string, error:string}}
 */
export function checkOrchestratorDispatch(input = {}) {
  const has = input.hasHubSeat === true
  const confirmed = input.requirementConfirmed === true

  // 档位还没落地：主管是 pending 时**先强制设上**的那个，照旧在册 ⇒ 放行。
  if (!confirmed) {
    if (has) return { ok: true, required: false }
    return {
      ok: false,
      code: 'HUB_REQUIRED_MISSING_SUPERVISOR',
      error:
        '拒绝派需求位：**本单还没有主管席位**。\n' +
        '★ 裁定 1：开单**先强制设主管** —— 需求位是这一单的第①道确认之前的那一步，' +
        '没有主管就没有人接它的结论。\n' +
        '下一步：主对话先把主管席位设上（`pipeline_supervise { action: "initiate", ... }`）。',
    }
  }

  const ord = tierOrdinal(input.tier)
  if (ord.ok !== true) {
    return { ok: false, code: ord.code, error: `${ord.message}\n★ 档位认不出来时不许"那就当低档处理、不设主管"。` }
  }
  const required = tierAtLeast(ord.tier, HUB_REQUIRED_FROM)
  if (!required) return { ok: true, required: false }
  if (has) return { ok: true, required: true }
  return {
    ok: false,
    code: 'HUB_REQUIRED_MISSING_SUPERVISOR',
    error:
      `拒绝派需求位：本单档位是 **${ord.tier}**（≥ ${HUB_REQUIRED_FROM}），但**主管席位不存在**（裁定 1 / 定稿 §3.5）。\n` +
      '★ 为什么这条是硬的：`L3+` 的必经之路是「需求结论 → **主管同意**（第①道）→ 架构位」——' +
      '主管不在册，那条路**根本没有入口**，需求位交出结论之后会悬在半空。\n' +
      '下一步（二选一）：\n' +
      '  · 补上主管席位，然后照常派需求位；\n' +
      '  · 或把档位改到 L2 以下（那会**撤销**主管席位，走主对话直接调度那条链）。',
  }
}

/**
 * 档位落地的**记录形状**（`task.hub_requirement` 的字段表；给调用方与测试对齐用）。
 *
 * @param {object} input
 * @returns {object}
 */
export function hubRequirementRecord(input = {}) {
  return {
    forced: input.forced === true,
    forced_at: input.forced_at ?? null,
    forced_by: String(input.forced_by ?? ''),
    tier: typeof input.tier === 'string' && input.tier.length > 0 ? input.tier : null,
    ordinal: Number.isInteger(input.ordinal) ? input.ordinal : null,
    assumed: input.assumed === true,
    required: input.required === true,
    action: String(input.action ?? ''),
    revoked_at: input.revoked_at ?? null,
    revoked_reason: String(input.revoked_reason ?? ''),
    history: Array.isArray(input.history) ? input.history : [],
  }
}

/** 档位为什么必须配主管（给文案引用，一处定义）。 */
export const HUB_REQUIRED_RATIONALE =
  `档位 ≥ ${HUB_REQUIRED_FROM} 的必经之路是「需求结论 → 主管同意（第①道）→ 架构位 → 计划」；` +
  '没有主管，那条路没有入口。'
