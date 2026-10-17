/**
 * dsh-pipeline · 确定性规则引擎（proposeTier）
 * ============================================================================
 * 自 `lib/tiers.js` 拆分出来的子模块（纯机械拆分，行为与原文件逐字一致）。
 *
 * @module dsh-pipeline/lib/tiers/propose
 */

import { TIER_ORDER, maxTier } from './constants.js'

// ---------------------------------------------------------------------------
// 确定性规则引擎
// ---------------------------------------------------------------------------

/**
 * 平凡性判据（L0 的必要条件）。**宁严勿松** —— 这是"复杂需求不漏配"的第一道闸。
 *
 * 判据全部是否定式的：只要命中任意一条「不平凡信号」，就不许自批 L0。
 * 反过来，只有**全部**平凡性条件成立才返回 L0。
 *
 * 设计意图：漏配（复杂任务只上 4 个对话）的代价远高于超配。所以这里刻意
 * 偏向"不给 L0"。
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 这里踩过一个真坑，写下来免得再犯：
 *   最初把 ASCII 与中文关键词写在同一个正则里，形如
 *   `/\b(api|http|接口|服务端)\b/i`。结果**中文关键词一条都匹配不上** ——
 *   JS 的 `\b` 是 `\w`(=[A-Za-z0-9_]) 与 `\W` 之间的边界，而中文字符属于 `\W`，
 *   「单」和「接」之间根本没有边界可谈，`\b接口\b` 永远是 false。
 *   于是"给订单**接口**加参数"被判成了 L0 极简脚本 —— 正是需求原文最担心的
 *   **复杂需求漏配**。
 *
 *   现在拆成两段：`ascii` 带 `\b`（避免 `api` 命中 `rapid`），`cjk` 不带边界
 *   （中文本来就没有词边界，多认一点是安全的方向）。自测里"普通功能→L1"这条
 *   就是给这个坑留的回归用例。
 */
const COMPLEXITY_SIGNALS = [
  {
    ascii: /\b(auth|oauth|jwt|token|credential|secret|password|apikey|api[-_ ]?key)\b/i,
    cjk: /(加密|鉴权|认证|授权|口令|密钥|凭证|权限)/,
    tier: 'L3',
    why: '涉及鉴权/凭证/权限面',
  },
  {
    ascii: /\b(security|compliance|gdpr|hipaa|injection|xss|csrf)\b/i,
    cjk: /(审计|合规|安全|注入|越权|脱敏)/,
    tier: 'L3',
    why: '涉及安全/合规',
  },
  {
    ascii: /\b(prod|production|deploy|release|rollout|canary|launch)\b/i,
    cjk: /(上线|发布|灰度|生产环境|生产|回滚|运维)/,
    tier: 'L4',
    why: '涉及生产上线/发布',
  },
  {
    ascii: /\b(migrat\w*|schema[- ]change|breaking[- ]change)\b/i,
    cjk: /(迁移|兼容性|向下兼容|破坏性变更)/,
    tier: 'L2',
    why: '涉及迁移/兼容性',
  },
  {
    ascii: /\b(architect\w*|refactor\w*|microservice\w*|distributed)\b/i,
    cjk: /(重构|架构|模块划分|接口契约|多服务|微服务|分布式|分层)/,
    tier: 'L2',
    why: '涉及架构决策',
  },
  {
    ascii: /\b(concurren\w*|parallel\w*|race[- ]condition|deadlock|mutex|transaction\w*)\b/i,
    cjk: /(并发|并行|竞态|死锁|加锁|事务)/,
    tier: 'L2',
    why: '涉及并发/事务',
  },
  {
    ascii: /\b(database|sql|postgres\w*|mysql|sqlite|redis|kafka|rabbitmq|mongo\w*)\b/i,
    cjk: /(数据库|消息队列|持久化|存储层|建表|索引)/,
    tier: 'L2',
    why: '涉及持久化/外部存储',
  },
  {
    ascii: /\b(performance|benchmark\w*|throughput|latency|profil\w*)\b/i,
    cjk: /(压测|性能|吞吐|延迟|耗时|优化)/,
    tier: 'L2',
    why: '涉及性能指标',
  },
  {
    ascii: /\b(api|http|https|grpc|webhook|rest|graphql|endpoint|server|client|frontend|backend)\b/i,
    cjk: /(接口|服务端|客户端|前端|后端|路由|中间件|请求|响应)/,
    tier: 'L1',
    why: '涉及接口/网络边界',
  },
  {
    ascii: /\b(dependenc\w*|library|libraries|package|npm|pnpm|yarn|third[- ]party|vendor)\b/i,
    cjk: /(第三方|依赖|引入|安装包|SDK)/i,
    tier: 'L1',
    why: '涉及外部依赖',
  },
  {
    ascii: /\b(multi[- ]?file|system[- ]wide|platform|framework|end[- ]to[- ]end|pipeline)\b/i,
    cjk: /(多个文件|多个模块|整套|系统级|平台|框架|全流程|端到端)/,
    tier: 'L1',
    why: '涉及多文件/系统级改动',
  },
  {
    ascii: /\b(config\w*|env\w*|dotenv|settings)\b/i,
    cjk: /(配置文件|配置项|环境变量|部署脚本|参数化)/,
    tier: 'L1',
    why: '涉及配置/环境',
  },
  {
    ascii: /\b(docs?|documentation|manual|readme|changelog)\b/i,
    cjk: /(文档|说明书|手册|使用说明)/,
    tier: 'L1',
    why: '涉及对外文档',
  },
]

/**
 * 平凡性上限：需求文本不得长过这个长度才允许 L0。
 * 写得越长 = 约束越多 = 越不平凡。这是最粗但很有效的一道。
 */
const L0_MAX_REQUIREMENT_CHARS = 240

/** 声明的验收标准条数上限（L0 才允许）。 */
const L0_MAX_ACCEPTANCE = 4

/**
 * 规则引擎：给出一档**建议**与被拒理由。
 *
 * @param {object} input
 * @param {string} input.requirement - 原始需求文本
 * @param {string[]} [input.acceptance] - 已知验收标准（可为空）
 * @param {string[]} [input.constraints] - 已知约束
 * @param {number} [input.expectedFiles] - 预期涉及文件数（不知道就别给）
 * @param {string} [input.defaultTier] - 拿不准时的兜底档（默认 L1）
 * @returns {{proposedTier:string, signals:Array<{tier:string,why:string,matched:string}>, l0Rejected:string|null, notes:string[]}}
 */
export function proposeTier(input = {}) {
  const requirement = String(input.requirement ?? '')
  const acceptance = Array.isArray(input.acceptance) ? input.acceptance.filter((s) => typeof s === 'string' && s.trim()) : []
  const constraints = Array.isArray(input.constraints) ? input.constraints.filter((s) => typeof s === 'string' && s.trim()) : []
  const defaultTier = TIER_ORDER.includes(input.defaultTier) ? input.defaultTier : 'L1'

  const haystack = [requirement, ...acceptance, ...constraints].join('\n')

  /** @type {Array<{tier:string,why:string,matched:string}>} */
  const signals = []
  for (const s of COMPLEXITY_SIGNALS) {
    const m = s.ascii.exec(haystack) ?? s.cjk.exec(haystack)
    if (m !== null) signals.push({ tier: s.tier, why: s.why, matched: String(m[0]).slice(0, 40) })
  }

  const notes = []
  let l0Rejected = null

  // --- L0 平凡性闸门（任一不满足就否掉 L0）---------------------------------
  if (requirement.trim().length > L0_MAX_REQUIREMENT_CHARS) {
    l0Rejected = `需求文本 ${requirement.trim().length} 字符 > L0 上限 ${L0_MAX_REQUIREMENT_CHARS} 字符（写得越长说明约束越多）`
  } else if (acceptance.length > L0_MAX_ACCEPTANCE) {
    l0Rejected = `验收标准 ${acceptance.length} 条 > L0 上限 ${L0_MAX_ACCEPTANCE} 条`
  } else if (constraints.length > 0) {
    l0Rejected = `声明了 ${constraints.length} 条约束条件（有约束就不是"极简脚本"）`
  } else if (signals.length > 0) {
    l0Rejected = `命中不平凡信号：${signals.map((s) => s.why).join('；')}`
  } else if (typeof input.expectedFiles === 'number' && input.expectedFiles > 1) {
    l0Rejected = `预期涉及 ${input.expectedFiles} 个文件 > 1`
  }

  let proposedTier
  if (l0Rejected === null) {
    proposedTier = 'L0'
    notes.push('未命中任何不平凡信号，允许自批 L0（4 个独立对话：主/编写/测试/审核）。')
  } else {
    notes.push(`L0 被否：${l0Rejected}`)
    // 取最严的那一条信号；没有信号就落到兜底档。
    let best = defaultTier
    for (const s of signals) best = maxTier(best, s.tier)
    proposedTier = best
    if (signals.length === 0) notes.push(`没有明确信号，落到兜底档 ${defaultTier}（宁高不低）。`)
  }

  return { proposedTier, signals, l0Rejected, notes }
}
