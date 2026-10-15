// 档位序数 · 把 `L0`…`L5` 换算成可比较的整数（**禁止字符串比较档位**）。
/**
 * dsh-pipeline · 档位序数
 * ============================================================================
 * 本文件回答一件事：**`L2` 和 `L10` 谁大** —— 以及更现实的那个：`L2` 和 `L3` 谁大。
 *
 * ★ 为什么不能拿档位字符串直接比：`'L10' < 'L2'`（字符串序）而 `L10 > L2`（档位序）。
 *   今天只有 `L0`…`L5`，字符串序**碰巧**与档位序一致；但"碰巧对"不是判据 ——
 *   只要哪天多出一档 `L10`，所有 `tier >= 'L3'` 的判断会**静默**开始出错。
 *   （这与 P1 的快照版本号是同一条教训，`snapshot-compare.js` 里有完整叙述。）
 *
 * @module dsh-pipeline/lib/tiers/tier-order
 */

/** 合法档位（顺序即复杂度顺序）。 */
export const TIER_ORDER = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'])

/** 档位字符串的形态（`L` + 十进制数字，**允许 L10 这种将来可能出现的档**）。 */
export const TIER_RE = /^L(\d{1,3})$/

/** 认不出的档位码。 */
export const BAD_TIER = 'BAD_TIER'

/**
 * 档位 → 序数。
 *
 * 判据（三条）：
 *   ① 形态必须匹配 `L<数字>`（大小写不敏感、两端空白裁剪）；
 *   ② 数字必须**有限**（`NaN` / `Infinity` 一律拒 —— 它们是"非法"，不是"未知"）；
 *   ③ **表里的档位**按表中下标；表外的（如将来的 `L10`）按其数字 —— 这样"多一档"时
 *      旧代码不会静默判错，而是**照样给出正确的相对次序**。
 *
 * @param {unknown} tier
 * @returns {{ok:true, tier:string, ordinal:number, known:boolean}|{ok:false, code:string, message:string}}
 */
export function tierOrdinal(tier) {
  if (tier === undefined || tier === null || (typeof tier === 'string' && tier.trim().length === 0)) {
    return {
      ok: false,
      code: BAD_TIER,
      message: '档位未知（未编排）—— 需要按"未知 ⇒ 保守"的调用方请先用 isUnknownTier 分流，不要在这里猜。',
    }
  }
  if (typeof tier === 'number' || typeof tier === 'bigint' || typeof tier === 'boolean') {
    return { ok: false, code: BAD_TIER, message: `档位 \`${String(tier)}\` 非法：档位必须是字符串 \`L0\`…\`L5\`。` }
  }
  const t = String(tier).trim().toUpperCase()
  const m = TIER_RE.exec(t)
  if (m === null) {
    return {
      ok: false,
      code: BAD_TIER,
      message: `档位 \`${String(tier)}\` 认不出来（形态必须是 \`L\` + 数字，如 \`L3\`）。`,
    }
  }
  const n = Number(m[1])
  if (!Number.isFinite(n)) {
    return { ok: false, code: BAD_TIER, message: `档位 \`${String(tier)}\` 里的数字不是有限值。` }
  }
  const known = TIER_ORDER.includes(t)
  return { ok: true, tier: t, ordinal: known ? TIER_ORDER.indexOf(t) : n, known }
}

/** 是不是一个**认得出且在表里**的档位。 */
export function isValidTier(tier) {
  const r = tierOrdinal(tier)
  return r.ok === true && r.known === true
}

/** 档位是否"未知 / 未编排"（与"非法"是两件事）。 */
export function isUnknownTier(tier) {
  if (tier === undefined || tier === null) return true
  if (typeof tier === 'string' && tier.trim().length === 0) return true
  return false
}

/**
 * 比较两个档位（**按序数**，不是按字符串）。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {{ok:true, cmp:number}|{ok:false, code:string, message:string}}
 */
export function compareTier(a, b) {
  const ra = tierOrdinal(a)
  if (ra.ok !== true) return ra
  const rb = tierOrdinal(b)
  if (rb.ok !== true) return rb
  if (ra.ordinal === rb.ordinal) return { ok: true, cmp: 0 }
  return { ok: true, cmp: ra.ordinal < rb.ordinal ? -1 : 1 }
}

/**
 * `tier` 是否 **≥** 某个基准档（按序数）。
 *
 * @param {unknown} tier
 * @param {string} base
 * @returns {boolean} tier 未知或非法时返回 `false`（调用方须自行决定要不要保守处理）
 */
export function tierAtLeast(tier, base) {
  const c = compareTier(tier, base)
  return c.ok === true && c.cmp >= 0
}
