/**
 * dsh-pipeline · 角色分档常量（TIERS / TIER_ORDER / L5 扩展池）
 * ============================================================================
 * 自 `lib/tiers.js` 拆分出来的子模块（纯机械拆分，行为与原文件逐字一致）。
 *
 * @module dsh-pipeline/lib/tiers/constants
 */

import { ROLE } from '../roles.js'

/**
 * 分档表。`execution` 是**执行角色**（不含主对话、需求分析、计划）。
 * `total` 是含主对话 + 需求分析 + 计划（若独立）的独立对话总数。
 *
 * ★ 本轮改动：
 *   · L1+ 的独立对话多了一个 —— 需求分析与**计划**现在是两个角色（原先挤在一个
 *     名为「需求分析/编排判断」的角色里）。所以 L1 6→7、L2 8→9、L3 9→10、
 *     L4 10→11、L5 12→13。L0 不变（两个角色都由规则引擎承担，仍是 4 个对话）。
 *   · `maxWriters`：3 → **6**（用户拍板的上槛），且 L1/…/L5 都能用到上限，
 *     因为**席位数由层数决定** —— 层多的项目就该多派席位（见 buildWriters）。
 *     L0 仍是 1：极简脚本没有分层的余地。
 *
 * @type {Record<string, {tier:string, zh:string, execution:string[], orchestrator:'rule-engine'|'separate', total:number, trigger:string}>}
 */
export const TIERS = {
  L0: {
    tier: 'L0',
    zh: '极简脚本',
    execution: [ROLE.WRITER, ROLE.TESTER, ROLE.REVIEWER],
    maxWriters: 1,
    orchestrator: 'rule-engine',
    total: 4,
    trigger: '单文件 / 单函数级改动，无外部依赖、无安全面、无持久化、无并发。',
  },
  L1: {
    tier: 'L1',
    zh: '普通功能',
    execution: [ROLE.WRITER, ROLE.TESTER, ROLE.REVIEWER, ROLE.ARCHIVIST],
    maxWriters: 3,
    orchestrator: 'separate',
    total: 7,
    trigger: '有明确功能边界，但涉及多文件、外部依赖、配置、接口变更中的任意一项。',
  },
  L2: {
    tier: 'L2',
    zh: '中大型',
    execution: [ROLE.ARCHITECT, ROLE.WRITER, ROLE.TESTER, ROLE.REVIEWER, ROLE.DIAGRAMMER, ROLE.ARCHIVIST],
    maxWriters: 6,
    orchestrator: 'separate',
    total: 9,
    trigger: '跨模块/跨服务、需要架构决策、接口契约要冻结、迁移或兼容性要求。',
  },
  L3: {
    tier: 'L3',
    zh: '安全敏感',
    execution: [ROLE.ARCHITECT, ROLE.SECURITY, ROLE.WRITER, ROLE.TESTER, ROLE.REVIEWER, ROLE.DIAGRAMMER, ROLE.ARCHIVIST],
    maxWriters: 6,
    orchestrator: 'separate',
    total: 10,
    trigger: '碰鉴权/凭证/权限/加密/外部输入边界/合规要求。',
  },
  L4: {
    tier: 'L4',
    zh: '生产上线',
    execution: [ROLE.ARCHITECT, ROLE.SECURITY, ROLE.WRITER, ROLE.TESTER, ROLE.REVIEWER, ROLE.DIAGRAMMER, ROLE.RELEASE, ROLE.ARCHIVIST],
    maxWriters: 6,
    orchestrator: 'separate',
    total: 11,
    trigger: '要真的动生产环境：上线、灰度、数据迁移、运维变更。',
  },
  L5: {
    tier: 'L5',
    zh: '特殊要求',
    execution: [
      ROLE.ARCHITECT,
      ROLE.SECURITY,
      ROLE.WRITER,
      ROLE.TESTER,
      ROLE.REVIEWER,
      ROLE.DIAGRAMMER,
      ROLE.ARCHIVIST,
      ROLE.RELEASE,
      ROLE.DOCS,
      ROLE.PERFORMANCE,
    ],
    maxWriters: 6,
    orchestrator: 'separate',
    total: 13,
    trigger: '对外交付/有文档与性能硬指标；或出现争议需要仲裁角色。按需从扩展池里挑，不必全上。',
  },
}

/** 分档从低到高，用于"只能往上调"的比较。 */
export const TIER_ORDER = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']

/** L5 的扩展池：需要哪个加哪个，加了要在 reason 里说明为什么。 */
export const L5_EXTENSION_POOL = [ROLE.DOCS, ROLE.PERFORMANCE, ROLE.ARBITER, ROLE.SECURITY, ROLE.RELEASE, ROLE.ARCHITECT]

/** 档位数值比较：a 是否 >= b。 */
export function tierAtLeast(a, b) {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b)
}

/** 两档里更高的那个（用于"只能往上调"）。 */
export function maxTier(a, b) {
  return tierAtLeast(a, b) ? a : b
}
