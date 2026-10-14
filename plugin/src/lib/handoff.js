/**
 * dsh-pipeline · 结构化交接物（schema + 校验）
 * ============================================================================
 * 每个交接环节都必须交一份**固定字段**的记录。字段名固定是有原因的：
 * 下游角色与守门判据都要按字段名读，一旦允许"自由发挥"，越权与跳步就没法
 * 机械判定，整条流水线就退回成"靠自觉"。
 *
 * 四份核心交接物（需求原文的固定字段，一个不多一个不少）：
 *   · dispatch        主 → 编写/测试   任务ID、原始需求、验收标准、约束条件、交付格式、截止要求
 *   · dev_to_test     编写 → 测试      代码或补丁、变更说明、运行命令、自测结果、已知问题
 *   · test_to_review  测试 → 审核      测试用例、执行结果、失败日志、通过证据、风险说明
 *   · review_verdict  审核 → 主/用户   审核结论(OK/NG)、风险说明、是否放行、最终交付说明
 *
 * ★ 本轮新增两份「控制角色」的交接物（把需求分析与计划拆开之后各自要交的东西）：
 *   · requirement_analysis  需求分析 → 主/计划  任务卡、验收标准、边界、测试要点、**不清楚处清单**
 *   · plan                  计划 → 主         计划步骤、层清单、**自检结果**、（有缺失时）回流问题
 *
 * 其余 kind 是打回、分配、咨询角色（架构/安全/发布/文档/性能/仲裁）用的补充类型。
 *
 * @module dsh-pipeline/lib/handoff
 */

import { clamp, isInside, newTaskId, shortHash, toStringArray } from './util.js'
import { looksLikeRawSecret } from './security.js'
import { validateSeatHandover } from './context.js'
// ★ T-20261011-56a37e：五道站点的确认方清单**只有一个出处**（states.js）。
//   依赖方向单向（states.js → roles.js），不成环。
// ★ P0-1：新增的两个**交接确认点**（②b / ②c）也读同一处 —— `hubConfirmersOf`
//   与 `HUB_STATION_NAMES` 都由 states.js 派生，枚举不手抄。
import { HUB_STATION_NAMES, hubConfirmersOf } from './states.js'

/** 字段类型 DSL：'string' | 'text' | 'string[]' | 'object[]' | 'number' | 'boolean' | 'object' | 'enum'。 */
const F = (type, zh, opts = {}) => ({ type, zh, ...opts })

/**
 * ★ 「人工介入请求」里允许出现的枚举值。
 * 这些取值不是装饰 —— `reason_kind` 决定了主对话怎么转告、以及用户在界面上看到什么。
 */
export const HUMAN_REASON_KINDS = {
  rework_budget_exhausted: '打回次数用尽（编写与测试/审核来回拉锯，机制已不许再打回）',
  conclusion_conflict: '编写与测试/审核结论冲突（谁对谁错，角色之间定不了）',
  approval_needed: '需要人审批（上线放行、破坏性操作、动生产数据等）',
  environment_missing: '环境或权限缺失（缺凭证、缺测试环境、缺访问权）',
  security_veto: '安全否决（安全审计发现阻断项，需要人拍板是否接受风险）',
  requirement_ambiguous: '需求本身有歧义（不同理解会做出不同的东西，必须先定死）',
  /**
   * ★ 本轮新增：**需求确认**（澄清前置到人工那一步用的就是它）。
   *
   * 与 `requirement_ambiguous` 的区别要写清，否则以后必然混：
   *   · `requirement_ambiguous`   = 需求分析自己**发现**有歧义，问用户"这处按哪个理解"；
   *   · `requirement_confirmation`= 需求分析已经出完结论（含"没有不清楚处"这种结论），
   *     请用户**确认这份分析**，然后才允许进计划。
   * 两者都可能由需求分析发起，但后者是**固定动作**（每次都要走），前者是按需的。
   */
  requirement_confirmation: '需求确认（需求分析已出结论，请用户确认后才能进计划）',
  scope_change: '范围变更（发现要做的事超出了原任务卡）',
  /**
   * ★ 本轮新增：**全量测试审批**（测试要跑整套测试，需求分析与审核都认为需要，请人拍板）。
   *
   * 与 `approval_needed` 的区别（不写清必然混）：
   *   · `approval_needed`   = 泛化的"需要人放行"（上线、破坏性操作、动生产数据）；
   *   · `full_test_approval`= 专门为「**跑一整套测试太贵、值不值得**」这一个成本决策。
   * 它固定出现在全量测试审批链的**第三站**（前两站是需求分析与审核的裁定）。
   */
  full_test_approval: '全量测试审批（跑整套测试成本高，前两站已同意，请人拍板）',
  /**
   * ★ 本轮新增：**哈希闸门连续不通过**（机制自动交人工，P13 的结论）。
   *
   * 与 `rework_budget_exhausted` 的区别要写清（不写清以后必然混）：
   *   · `rework_budget_exhausted` = **打回**次数用尽（审核/测试已经把产物打回过 N 次，
   *      任务真的来回拉锯过）；那是"角色"拉锯出来的。
   *   · `hash_gate_escalation`    = 提交**根本没成立**（哈希对比没过，任务从没离开
   *      "开发中"，连测试都没进），同一个任务**连续** N 次交上来的东西都没过这道闸。
   *
   * ⚠️ 这一条**不是角色能自己发的**：`pipeline_handoff` 走这条路会被拒
   *    （`HASH_GATE_ESCALATION_IS_SYSTEM`）—— 它只由机制在阈值到达时发出，
   *    并记进 `task.hash_gate_escalation` 与审计 `gate:hash_escalate`。
   */
  hash_gate_escalation: '哈希前置闸门连续不通过（同一任务连续 N 次提交都没过这道闸，机制自动交人工）',
  other: '其它（必须在 question_for_human 里说清楚）',
}

/** 需要用户给什么形式的答复。 */
export const HUMAN_DECISION_KINDS = {
  yes_no: '是 / 否',
  approve_reject: '批准 / 驳回',
  choose_option: '从给定方案里选一个',
  free_text: '给一段说明',
}

/** 没人回应时怎么办。 */
export const HUMAN_TIMEOUT_BEHAVIORS = {
  stay_blocked: '一直保持等待（不自动推进）',
  proceed_with_default: '按默认选项继续（必须在请求里写清默认选项是什么）',
  cancel: '取消任务',
}

/** 紧急度。 */
export const HUMAN_URGENCIES = ['low', 'normal', 'high', 'blocking']

/**
 * ★ 判定一段"给用户看的人话"里是不是混进了代码。
 *
 * 为什么需要这条：本插件的拓扑是「用户只与主对话相连」，而主对话
 * **不读代码**（有守门拦着）。所以执行角色交给主对话转告的文本，
 * 必须**本身就可读** —— 否则主对话要么转告不了，要么被迫去读代码。
 * 这条判据把"请求体里塞了代码"变成**提交时就被拒**，
 * 而不是等到主对话转告时才发现自己看不懂。
 *
 * 判据刻意用**高精度标记**（宁可漏判也不误伤）：
 *   · 代码围栏 / diff 头 / 补丁标记
 *   · 行首的代码关键字 + 标识符
 *   · 带代码扩展名的路径
 *   · 一小撮只在代码里出现的符号组合
 * 反过来，"问句里提到了 step 参数""提到 npm"这类**不该**被误伤。
 *
 * @param {string} text
 * @returns {string|null} 命中时返回人话理由，否则 null
 */
export function detectCodeInHumanText(text) {
  const s = String(text ?? '')
  if (s.length === 0) return null

  if (/```/.test(s)) return '含 Markdown 代码围栏（```）'
  if (/^diff --git/m.test(s)) return '含 diff 头（diff --git）'
  if (/^@@\s/m.test(s)) return '含补丁块标记（@@）'
  if (/^(\+\+\+|---)\s/m.test(s)) return '含补丁文件标记（+++/---）'
  if (/^\s*(function|class|const|let|var|def|import|export|return|public|private|async)\s+[A-Za-z_$]/m.test(s)) {
    return '含行首代码关键字 + 标识符'
  }
  if (/=>|->\s|\breturn\s*\(|\bconsole\.|\bprintf\(|\brequire\(|\bimport\s+from\b/.test(s)) return '含代码表达式片段'
  if (/[\w./\\-]+\.(js|mjs|cjs|tsx?|jsx|py|go|rs|java|c|cpp|hpp|cs|rb|php|sh|ps1|sql|ya?ml|toml|json)\b/i.test(s)) {
    return '含带代码扩展名的文件路径'
  }
  if (/\{\s*["'`]?\w+["'`]?\s*:/.test(s)) return '含对象字面量片段'
  if (/[;{}]\s*$/m.test(s)) return '含以分号/花括号结尾的代码行'
  return null
}

/**
 * 判定一段文本是不是"真的在问一个问题"。
 * 人类要向另一个人类要答复，最少得有个问号 —— 这条挡掉
 * "把一段陈述当请求发上来，让用户自己猜要回答什么"。
 */
export function looksLikeQuestion(text) {
  return /？|\?/.test(String(text ?? ''))
}

/** 给用户看的两段文本共同的长度上限（太长就不是"人话"了）。 */
const HUMAN_TEXT_MAX = 600

/**
 * ★ 改动动作的取值。
 *   · `modify` 改已存在的文件
 *   · `create` 新建（**新增文件也算越界**，所以要新建就必须显式授权）
 *   · `delete` 删除
 */
export const CHANGE_ACTIONS = ['modify', 'create', 'delete']

/** 授权条目 id 的合法形状（编写在改动清单里要逐条引用它）。 */
export const SCOPE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/

/**
 * ★ 一条授权**实际覆盖**哪些动作。
 *
 *   · `modify` = "这个路径可以改" —— 含在其中**新建/删除**文件。
 *     为什么：计划里授权"改 src/api"时，它的自然含义就是"这轮在这一块动"，
 *     而不是"只准改已经存在的那几个文件"（那样每条都得逐文件列举，计划会变成台账）。
 *   · `create` = **只**授权"新建这一份"；拿它去改已存在的文件不算授权。
 *   · `delete` = 只授权删除。
 *
 * @param {{action?:string}} entry
 * @returns {string[]}
 */
export function allowedActionsForEntry(entry) {
  const a = String(entry?.action ?? '')
  if (a === 'modify') return ['modify', 'create', 'delete']
  if (a === 'create') return ['create']
  if (a === 'delete') return ['delete']
  return []
}

/**
 * ★ 职责自限声明：`{ will_do, will_not_do }` 两栏都要有内容。
 *
 * 为什么两栏都必填：「只做什么」是可以含糊过去的（"我负责需求分析"），
 * 而「**不做什么**」含糊不过去 —— 它必须点名那些最容易顺手多干的事。
 */
export function validateRoleScope(raw, label) {
  const errors = []
  const s = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (s === null) return [`字段「${label}」（职责自限声明）必须是对象 { will_do: string[], will_not_do: string[] }`]
  const will = toStringArray(s.will_do)
  const not = toStringArray(s.will_not_do)
  if (will.length === 0) errors.push(`「${label}.will_do」至少要有一条 —— "我这次只做什么"必须写出来。`)
  if (not.length === 0) {
    errors.push(
      `「${label}.will_not_do」至少要有一条 —— **"我不做什么"这一栏才是重点**。\n` +
        '★ 最容易顺手多干的事要在这里点名（需求分析：不定档、不分配、不读代码；' +
        '计划：不改需求、不写实现、不自己执行任务）。\n' +
        '  含糊的"我只做我该做的"不算 —— 它挡不住任何越界。',
    )
  }
  return errors
}

/**
 * ★ 校验**授权改动面**（计划里的 `change_scope`）。
 *
 * 「改动面必须与授权面相等」—— 这份清单就是授权面本身，所以它必须：
 *   · 至少有一条（"不用改任何文件"的任务不存在；真没有就说明计划是错的）
 *   · 每条有唯一 id、有路径、有动作、有**为什么非动它不可**
 */
export function validateChangeScope(raw) {
  const errors = []
  if (!Array.isArray(raw) || raw.length === 0) {
    return [
      '`change_scope` 至少要有一条 —— ' +
        '**没有授权面，编写就没有可动的范围**（"改动面必须与授权面相等"）。\n' +
        '★ 如果这次真的不用改任何文件，那说明任务本身不需要编写 —— 请把结论写进 plan_reason 并让用户确认。',
    ]
  }
  const ids = []
  raw.forEach((e, i) => {
    const id = typeof e?.id === 'string' ? e.id.trim() : ''
    const path = typeof e?.path === 'string' ? e.path.trim() : ''
    const action = typeof e?.action === 'string' ? e.action : ''
    const why = typeof e?.why === 'string' ? e.why.trim() : ''
    if (!SCOPE_ID_PATTERN.test(id)) errors.push(`change_scope[${i}].id=「${id || '(缺失)'}」不合法（形如 CS1 / CS-api）`)
    if (path.length === 0) errors.push(`change_scope[${i}].path 必填（允许改哪个文件/哪个目录）`)
    if (!CHANGE_ACTIONS.includes(action)) {
      errors.push(`change_scope[${i}].action=「${action || '(缺失)'}」非法；必须是 ${CHANGE_ACTIONS.join(' / ')} 之一（**新增文件也要显式写 create**）`)
    }
    if (why.length === 0) {
      errors.push(
        `change_scope[${i}].why 必填 —— 说明**为什么非动它不可**。\n` +
          '★ 这一栏是"顺手重构 / 统一风格 / 顺手升级依赖"的照妖镜：那些理由写不出来。',
      )
    }
    if (id.length > 0) ids.push(id)
  })
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i)
  if (dup.length > 0) errors.push(`change_scope 里有重复的 id：${[...new Set(dup)].join('、')}`)
  return errors
}

/**
 * ★ 校验**角色边界卡**（计划里的 `role_boundaries`）。
 *
 * 它回答的是「分析与计划 AI 确认**别的角色**只干什么」：
 * 每个执行角色一张卡（only / not），派活时按卡派。
 * ⚠️ "覆盖了清单里每一个执行角色"这条**不在这里判** —— 它要读角色清单，
 *    放在 `store.setRoster` 里判（写清单那一刻两边数据才齐）。
 */
export function validateRoleBoundaries(raw) {
  const errors = []
  if (!Array.isArray(raw) || raw.length === 0) {
    return [
      '`role_boundaries` 至少要有一条 —— ' +
        '★ 计划必须为**每个执行角色**写死边界（这个角色只干什么、不干什么），派活时按它派。\n' +
        '  没有边界卡，派活就只能靠"你懂的"，而**顺手多干**正是从那里开始的。',
    ]
  }
  raw.forEach((b, i) => {
    const role = typeof b?.role === 'string' ? b.role.trim() : ''
    const only = toStringArray(b?.only)
    const not = toStringArray(b?.not)
    if (role.length === 0) errors.push(`role_boundaries[${i}].role 必填（角色 id）`)
    if (only.length === 0) errors.push(`role_boundaries[${i}]（${role || '?'}）的 only 至少要有一条`)
    if (not.length === 0) {
      errors.push(
        `role_boundaries[${i}]（${role || '?'}）的 not 至少要有一条 —— ` +
          '**"它不干什么"才是防多干的那一栏**。',
      )
    }
  })
  return errors
}

/**
 * ★ 校验**实际改动面**（编写的 `change_manifest`）**是否落在授权面内**。
 *
 * 这就是「改动面必须与授权面相等」的执法点，逐条对应：
 *   · 每条改动必须引用一个**存在的授权条目 id**（`scope_id`）；
 *   · 声明的 `path` / `action` 必须与那条授权一致；
 *   · 授权面里有**没被任何改动引用**的条目 ⇒ 不算错（可能计划时多授权了），
 *     但会被记进 `unused` 供审核看（"授权了却没动"是计划的偏差，不是编写的越界）。
 *
 * @param {object[]} manifest
 * @param {object[]} changeScope - 计划里的授权面
 * @param {object} [opts]
 * @param {(p:string)=>string|null} [opts.scopeRel] - ★ **授权面锚点解析器**：把授权条目里的
 *   路径换算成与 `manifest[].path` **同一坐标系**（相对项目根）。
 *
 *   为什么需要：授权面写的是**包内相对路径**（`index.js`、`tests/`），而实际改动面
 *   （基线 / 审计 / `manifest[].path`）报的是**相对项目根**的路径
 *   （`node_modules/dsh-pipeline/index.js`）。不换算就永远对不上 ——
 *   真单 T-20261011-214043 上这正是"授权了也交不上去"的一半原因。
 *   缺省（不传）= 保持历史行为（授权路径原样比对）。
 * @param {(p:string)=>string} [opts.absOf] - ★★ **路径归一化器**（本轮修 ③）：把任意写法
 *   （绝对路径 / 裸相对路径 / `.`）映射成**规范绝对比较键**（小写化的 pathKey）。
 *
 *   为什么还要一条：上面 `scopeRel` 出来的是「相对项目根」，那对**落在项目根之外**的
 *   授权条目（真单 T-20261011-5a871c 的源码树那两条写的就是绝对路径）**根本不存在** ——
 *   于是那条授权只剩"逐字节写对绝对路径"一种交法，写成别的任何形式都被判越界。
 *   补上这条之后，**同一个文件身份**只要能用当归一化规则落到同一个绝对键上，就算对得上；
 *   这条判据是**附加**的（下面 `within(ePath) || within(ePathAlt)` 原样保留），
 *   只会让"本来合法、只是写法不同"的提交通过 —— **不会**让任何越界改动通过。
 * @returns {{ok:boolean, errors:string[], outOfScope:string[], unused:string[], matched:string[]}}
 */
export function checkManifestAgainstScope(manifest, changeScope, opts = {}) {
  const errors = []
  const outOfScope = []
  const matched = []
  const list = Array.isArray(manifest) ? manifest : []
  const scope = Array.isArray(changeScope) ? changeScope : []
  const byId = new Map()
  for (const e of scope) {
    const id = typeof e?.id === 'string' ? e.id.trim() : ''
    if (id.length > 0) byId.set(id, e)
  }
  const norm = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  /**
   * ★ 该授权条目的路径在"相对项目根"坐标系里的写法（按锚点解析）。
   *   返回 `null` = 解析不出（例如锚点在项目根之外）⇒ 退回原样比对，不改变既有结论。
   */
  const relOfEntry = (entry) => {
    if (typeof opts.scopeRel !== 'function') return null
    try {
      return opts.scopeRel(entry?.path)
    } catch {
      return null
    }
  }

  if (list.length === 0) {
    return {
      ok: false,
      errors: [
        '`change_manifest` 不能为空 —— 这次任务**有授权改动面**，所以必须交出"实际动了哪些文件"。\n' +
          '★ 测试与审核要按这个面核对（"只改了这三行"必须是可验证的声明，不是形容词）。',
      ],
      outOfScope: [], unused: [], matched: [],
    }
  }

  list.forEach((m, i) => {
    const path = typeof m?.path === 'string' ? m.path.trim() : ''
    const action = typeof m?.action === 'string' ? m.action : ''
    const sid = typeof m?.scope_id === 'string' ? m.scope_id.trim() : ''
    if (path.length === 0) {
      errors.push(`change_manifest[${i}].path 必填`)
      return
    }
    if (sid.length === 0) {
      errors.push(
        `change_manifest[${i}]（${path}）缺少 scope_id —— **每一处改动都必须指向一个授权条目**。\n` +
          '★ 没有授权来源的改动 = 自作主张扩范围，那正是"改动面必须与授权面相等"要挡的。',
      )
      return
    }
    const entry = byId.get(sid)
    if (entry === undefined) {
      errors.push(`change_manifest[${i}]（${path}）引用的 scope_id=「${sid}」在计划的 change_scope 里不存在。`)
      outOfScope.push(path)
      return
    }
    const ePath = norm(entry.path)
    const mPath = norm(path)
    // ★ 三种写法都认：① 授权面原样（`index.js`）；② **按锚点解析后再相对项目根**
    //   （`node_modules/dsh-pipeline/index.js`）。后者才是实际改动面 / 审计的坐标系，
    //   不认它就会出现"授权了也交不上去"。
    //   ③（本轮修 ③）**两边都归一到规范绝对键**再比 —— 这一条把"授权面写绝对路径"
    //   的情形补齐：条目与声明只要落到同一个**文件身份**上就算对得上，
    //   不再要求逐字节写对那串绝对路径。三种都不匹配才是真越界。
    const ePathRel = relOfEntry(entry)
    const ePathAlt = ePathRel === null ? '' : norm(ePathRel)
    const within = (base) => base.length > 0 && (mPath === base || mPath.startsWith(`${base}/`))
    const absOf = typeof opts.absOf === 'function' ? opts.absOf : null
    let withinAbs = false
    if (absOf !== null) {
      try {
        const eAbs = String(absOf(entry.path) ?? '')
        const mAbs = String(absOf(path) ?? '')
        if (eAbs.length > 0 && mAbs.length > 0) withinAbs = mAbs === eAbs || isInside(eAbs, mAbs)
      } catch {
        withinAbs = false
      }
    }
    if (!within(ePath) && !within(ePathAlt) && !withinAbs) {
      errors.push(
        `change_manifest[${i}] 的 path=「${path}」不在它引用的授权条目「${sid}」（${entry.path}）范围内。\n` +
          '★ 改动面必须与授权面相等 —— 授权的是哪一个，动的就得是哪一个。' +
          (ePathAlt.length > 0 ? `\n  （该授权条目按锚点解析后相当于：${ePathRel}）` : ''),
      )
      outOfScope.push(path)
      return
    }
    if (action.length > 0 && !allowedActionsForEntry(entry).includes(action)) {
      errors.push(
        `change_manifest[${i}]（${path}）声明的 action=「${action}」超出了授权条目「${sid}」（action=${entry.action}）的范围。\n` +
          '★ 授权是有**意图**的：`modify` = 这个路径可以改（含在其中新建/删文件）；' +
          '`create` = **只**授权新建这一份；`delete` = 只授权删除。',
      )
      outOfScope.push(path)
      return
    }
    matched.push(sid)
  })

  const unused = [...byId.keys()].filter((id) => !matched.includes(id))
  return { ok: errors.length === 0, errors, outOfScope, unused, matched }
}

/**
 * ★ 「需求分析的产物里出现**分配内容**」的判据。
 *
 * 用户要求：「分析与计划 AI 确认他们只干什么，不要多干」+「需求分析的产物里出现
 * "派谁 / 用几个 AI"这类分配内容 → 拒」。
 *
 * 判据刻意**组合**（角色名/席位名 **加上** 派活动词，或出现分配专有名词），
 * 避免误伤正常表述（"这件事需要独立验证"是需求层的话，"派 tester 去验证"是分配）。
 */
const ROLE_WORDS = '(writer|tester|reviewer|architect|security|archivist|diagrammer|release|docs|performance|arbiter|planner|orchestrator|编写|测试|审核|架构|安全|留档|架构图|发布|文档|性能|仲裁|计划)'
const ASSIGNMENT_RES = [
  { re: new RegExp(`(派|分派|指派|安排|交给|分配给|调用)\\s*[「"']?${ROLE_WORDS}`, 'i'), why: '出现"派谁去做"的分配表述' },
  { re: new RegExp(`${ROLE_WORDS}\\s*(角色)?\\s*(负责哪|负责第|席位|#\\d)`, 'i'), why: '出现席位/分工安排' },
  { re: /writer#\d|tester#\d|reviewer#\d/i, why: '出现编写席位 id' },
  { re: /(用|需要|调用|开)\s*\d+\s*个\s*(独立)?\s*(对话|AI|ai|智能体|agent)/, why: '出现"用几个 AI"' },
  { re: /(角色清单|调用顺序|并发几个|ai_count|最大席位|max_writers)/i, why: '出现角色清单/调用顺序这类分配术语' },
  { re: /(档位|tier)\s*(应|该|定|取|设)?\s*[是为：:]?\s*L[0-5]\b/i, why: '出现档位判定（那是计划的活）' },
]

/**
 * 扫描"需求分析的结论"里有没有混进**分配内容**。
 *
 * @param {object} normalized - 已经过 schema 归一化的 requirement_analysis payload
 * @returns {string[]}
 */
export function scanRequirementAnalysisForAllocation(normalized) {
  const errors = []
  const texts = []
  const push = (label, v) => {
    if (typeof v === 'string' && v.trim().length > 0) texts.push([label, v])
  }
  push('analysis_reason', normalized.analysis_reason)
  for (const [i, x] of toStringArray(normalized.unclear_points).entries()) push(`unclear_points[${i}]`, x)
  for (const [i, x] of toStringArray(normalized.open_assumptions).entries()) push(`open_assumptions[${i}]`, x)
  const tc = normalized.task_card
  if (tc !== null && typeof tc === 'object' && !Array.isArray(tc)) {
    for (const [k, v] of Object.entries(tc)) push(`task_card.${k}`, v)
  }
  for (const [label, text] of texts) {
    const hit = ASSIGNMENT_RES.find((r) => r.re.test(text))
    if (hit !== undefined) {
      errors.push(
        `字段「${label}」里出现了**分配内容**（${hit.why}）。\n` +
          '★ 需求分析的职责边界是「**这东西到底要做什么**」；' +
          '"派谁 / 用几个 AI / 什么顺序 / 什么档位"是**计划 AI** 的活。\n' +
          '  一句话：**分析与计划 AI 只干自己那一段** —— 你把分配也定了，计划就只能照抄，' +
          '那等于这一站不存在。\n' +
          '  请把它写进「需求不清楚处」，或在结论里只写需求层的事（做什么 / 验收标准 / 边界 / 测试要点）。',
      )
    }
  }
  return errors
}

/**
 * ★ 设计目的（第一性目标）：**防过度工程化** —— 每个 AI 只干自己该干的。
 *
 * 用户原话：「分开跑项目的目的是让 ai 别过度工程化，要求只干自己该干的，
 *            编程别跑测试，编排别看代码」
 *
 * 交接物这一层负责其中的两条**产物边界**（能力边界在 `lib/guard.js`）：
 *
 *   ① **控制角色（需求分析 / 计划）的产物里不许出现代码正文**。
 *      它们不看代码（守门拦读），所以它们的结论里**本来就不该有**代码 ——
 *      出现代码正文只有两种可能：绕过守门读了，或者从别处抄来的。
 *      判据用高精度标记（`detectCodeInHumanText`），只查**解释性文本字段**，
 *      不查 `scope_paths` / `deliverables`（那些是结构描述，本来就该写路径）。
 *
 *   ② **编写不得产出测试结论**。
 *      `test_to_review` / `test_to_dev` / `review_verdict` 的方向表里没有 writer
 *      （白名单方向：忘了加只是少一条能力）；此外 `dev_to_test` 的 payload 里
 *      也**不许夹带**测试结论字段（`test_cases` / `pass_evidence` / `verdict` …）——
 *      那等于把测试结论换个信封寄出来。
 */
export const CONTROL_ROLES_NO_CODE = ['orchestrator', 'planner']

/** 测试结论类的字段名（出现在非测试角色的交接物里就是越界）。 */
export const TEST_VERDICT_FIELDS = ['test_cases', 'execution_result', 'pass_evidence', 'failure_logs', 'verdict', 'test_report']

/**
 * ★ 控制角色专用的**更严**代码正文判据。
 *
 * 为什么比 `detectCodeInHumanText` 更严：那个函数的读者是**人**（用户的问句、
 * 主对话转告的话），误伤代价高（把"我提到 step 参数"当成代码），所以它只用
 * 高精度标记。而这里判的是**控制角色自己的产出** —— 它们**不看代码**，
 * 所以结论里出现任何代码形态都只有"越界"一种解释，可以更严。
 *
 * 仍然刻意**不**用裸关键词（`return` / `const` 单独出现不判），
 * 因为英文散文里 "return the value" 是正常表达：
 *   · 要带**代码形态**才算：`f(x){`、`const x =`、`export function`、`=>`、围栏、diff…
 */
const CONTROL_INLINE_CODE_RES = [
  { re: /\b(export|import)\s+(default\s+)?(function|const|let|var|class|async|\{|\*)/, why: '含 import/export 语句' },
  { re: /\b(const|let|var)\s+[A-Za-z_$][\w$]*\s*=[^=]/, why: '含变量声明（const/let/var … = …）' },
  { re: /\b[A-Za-z_$][\w$]*\s*\([^()\n]{0,40}\)\s*\{/, why: '含函数形态（名字(参数){）' },
  { re: /\b(function|def|class|interface|struct|fn)\s+[A-Za-z_$][\w$]*\s*[({<:]/, why: '含函数/类型定义' },
  { re: /=>\s*[{(]?[A-Za-z_$0-9]/, why: '含箭头函数' },
  { re: /\b(public|private|protected|static|final|override)\s+[A-Za-z_$][\w$]*\s*\(/, why: '含修饰符 + 方法签名' },
  { re: /\b(require|import)\s*\(\s*['"`]/, why: '含模块加载调用' },
]

/**
 * 对"控制角色的产出"做一次**代码正文**扫描。
 *
 * @param {string} kind
 * @param {object} normalized
 * @returns {string[]} 错误列表（空 = 通过）
 */
export function scanControlRoleProductForCode(kind, normalized) {
  const errors = []
  /** 只查**解释性文本**：结构字段（scope_paths / deliverables / layers[].layer）不查。 */
  const texts = []
  const push = (label, v) => {
    if (typeof v === 'string' && v.trim().length > 0) texts.push([label, v])
  }
  if (kind === 'requirement_analysis') {
    push('analysis_reason', normalized.analysis_reason)
    for (const [i, x] of toStringArray(normalized.unclear_points).entries()) push(`unclear_points[${i}]`, x)
    for (const [i, x] of toStringArray(normalized.open_assumptions).entries()) push(`open_assumptions[${i}]`, x)
    const tc = normalized.task_card
    if (tc !== null && typeof tc === 'object' && !Array.isArray(tc)) {
      for (const [k, v] of Object.entries(tc)) push(`task_card.${k}`, v)
    }
  }
  if (kind === 'plan') {
    push('plan_reason', normalized.plan_reason)
    push('gap_question', normalized.gap_question)
    push('gap_context', normalized.gap_context)
    push('gap_stage', normalized.gap_stage)
    for (const [i, x] of toStringArray(normalized.plan_steps).entries()) push(`plan_steps[${i}]`, x)
    for (const [i, x] of toStringArray(normalized.risks).entries()) push(`risks[${i}]`, x)
    const sc = normalized.self_check
    if (sc !== null && typeof sc === 'object' && !Array.isArray(sc)) {
      for (const [i, x] of toStringArray(sc.checked).entries()) push(`self_check.checked[${i}]`, x)
      for (const [i, x] of toStringArray(sc.gaps).entries()) push(`self_check.gaps[${i}]`, x)
    }
  }
  for (const [label, text] of texts) {
    const hit = detectCodeInHumanText(text)
    // 控制角色再加一道**更严**的形态判据（见 CONTROL_INLINE_CODE_RES 的注释）
    const strict = hit === null ? CONTROL_INLINE_CODE_RES.find((r) => r.re.test(text)) : null
    if (hit !== null || strict !== undefined) {
      errors.push(
        `字段「${label}」里出现了代码正文（${hit ?? strict.why}）。\n` +
          '★ 需求分析与计划**不看代码**（守门拦着读），所以它们的结论里**本来就不该有**代码。\n' +
          '  出现代码正文只有两种可能：绕过守门读了，或者从别处抄来的 —— 两种都不可接受。\n' +
          '  要写清结构请用**路径**（.pipeline 下的需求档、目录名）与**人话**描述；\n' +
          '  需要技术细节就让对应的执行角色去写（它有真凭据）。',
      )
    }
  }
  return errors
}

/**
 * ★★ **脱敏证据正文的形态判据**（T-20261011-56a37e）。
 *
 * 用户口径⑤：需求位在测试后、审核后的两次确认看**脱敏后的证据正文**
 *   —— 而「**证据 ≠ 代码正文**」，守住"控制角色不看代码正文"的红线。
 *
 * 安全预审（H-35ab8749a1f6f103）的实测判据 R2 说得很直白：
 *   默认脱敏面是**三个字段名的黑名单**，其余自由文本字段按字符数截断后**原样**给出
 *   ⇒ 证据正文通道若复用默认脱敏面，代码仍可能经自由文本进来。
 *   正解是**按站点的正向白名单投影**。
 *
 * 这里落的是那条红线的**可执行半**：证据正文里出现**代码形态**即拒。
 * 用的是与"控制角色产出"同一套更严的形态判据（`CONTROL_INLINE_CODE_RES` +
 * `detectCodeInHumanText`）—— **不新造第二套扫描器**（越界清单第 4 条）。
 *
 * @param {string} text
 * @returns {string|null} 命中原因；`null` = 干净
 */
export function hubEvidenceDigestHit(text) {
  const s = typeof text === 'string' ? text : ''
  if (s.trim().length === 0) return null
  const hit = detectCodeInHumanText(s)
  if (hit !== null) return hit
  const strict = CONTROL_INLINE_CODE_RES.find((r) => r.re.test(s))
  return strict === undefined ? null : strict.why
}

/** 预登记里**不许出现**的字段名（编写产物 + 测试结论两类，来源是既有常量）。 */
export const PREBRIEF_FORBIDDEN_FIELDS = [
  // 编写产物的字段名（dev_to_test 的字段表里那几个 —— 提前知情不许看编写的产物）
  'patch_or_code',
  'change_note',
  'selftest_result',
  'change_manifest',
  'run_commands',
  // 测试结论类（复用既有常量，不手抄）
  ...TEST_VERDICT_FIELDS,
]

/**
 * 站点确认的形状判据（主管枢纽）。
 *
 * @param {object} normalized
 * @param {object} payload - **原始** payload（查夹带字段必须查原始的，见上面那段注释）
 * @returns {string[]}
 */
export function validateStationConfirm(normalized, payload) {
  const errors = []
  const station = String(normalized.station ?? '')
  const confirmers = hubConfirmersOf(station)
  if (confirmers.length === 0) {
    errors.push(`station=「${station || '(缺失)'}」不在站点表里（五道站点里那四道 + ②b/②c 两个交接确认点）。`)
    return errors
  }
  if (!Array.isArray(normalized.basis_refs) || normalized.basis_refs.length === 0) {
    errors.push(
      'basis_refs 至少要有 1 条 —— 确认必须带**可查的证据标识**（哪份交接物 id / 制品版本 / 内容哈希 / 计数或结论字段）。\n' +
        '★ 安全预审阻断项 B1：控制角色引用的材料必须是**证据标识**，不是正文搬运。',
    )
  } else {
    // 证据标识的形状：必须含"可定位"的字符（id 形态 / 版本号 / 哈希 / 冒号分隔的字段）。
    normalized.basis_refs.forEach((r, i) => {
      const s = String(r ?? '').trim()
      if (s.length < 3 || !/[A-Za-z0-9]/.test(s)) {
        errors.push(`basis_refs[${i}]=「${s}」不像可查的证据标识（太短或没有可定位的字符）。`)
      }
    })
  }
  const hit = hubEvidenceDigestHit(normalized.basis_digest)
  if (hit !== null) {
    errors.push(
      `basis_digest（脱敏证据正文）里出现了**代码正文**形态（${hit}）。\n` +
        '★ 用户口径⑤：控制角色看的是**脱敏后的证据正文** —— 「证据 ≠ 代码正文」。\n' +
        '  这条是"控制角色不看代码"（守门 NO_CODE_READ_ROLES）在**新站点**上的纳入，不是新规矩。\n' +
        '  要写清依据请用：交接物 id + 制品版本 + 内容哈希 + 计数/结论字段 + 只给路径的定位。',
    )
  }
  // 夹带判据：站点确认里不许出现代码正文/测试结论类的**自由字段**。
  const src = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const smuggled = PREBRIEF_FORBIDDEN_FIELDS.filter((f) => src[f] !== undefined && src[f] !== null)
  if (smuggled.length > 0) {
    errors.push(
      `字段「${smuggled.join('」「')}」不属于 station_confirm。\n` +
        '★ 站点确认的载体是**证据标识 + 脱敏证据正文**，不是产物搬运：' +
        '把补丁正文、变更说明、测试结论塞进确认记录，等于绕开"控制角色不看代码"这条边界。',
    )
  }
  return errors
}

/**
 * 任务内容预登记的形状判据（计划位 → 测试位；测试提前知情）。
 *
 * @param {object} normalized
 * @param {object} payload
 * @returns {string[]}
 */
export function validatePrebrief(normalized, payload) {
  const errors = []
  const na = Array.isArray(normalized.not_yet_available) ? normalized.not_yet_available : []
  if (na.length === 0) {
    errors.push(
      'not_yet_available 不能是空数组。\n' +
        '★ 「提前知情 ≠ 提前开工」的落点就在这里：预登记必须**显式回答现在还拿不到什么**' +
        '（编写产物是必然拿不到的那一项）。空数组会让"我已经有全套了"变成一个可以蒙混的声明。',
    )
  }
  const src = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const smuggled = PREBRIEF_FORBIDDEN_FIELDS.filter((f) => src[f] !== undefined && src[f] !== null)
  if (smuggled.length > 0) {
    errors.push(
      `字段「${smuggled.join('」「')}」不属于 prebrief。\n` +
        '★ 用户口径③写死：测试位**不许看编写的产物**（保持独立性），' +
        '也不许提前拿到测试结论类的字段（那是它自己的产物）。\n' +
        '  预登记交的是**计划位安排的任务内容**：要测什么、按哪几条验收、制品标识、还缺什么。',
    )
  }
  // 自由文本字段也扫一道代码形态（同一个扫描器，不另起一套）。
  for (const [label, v] of [
    ['artifact_under_test', normalized.artifact_under_test],
    ...(Array.isArray(normalized.assigned_scope) ? normalized.assigned_scope.map((x, i) => [`assigned_scope[${i}]`, x]) : []),
    ...(Array.isArray(normalized.notes) ? normalized.notes.map((x, i) => [`notes[${i}]`, x]) : []),
  ]) {
    const hit = hubEvidenceDigestHit(v)
    if (hit !== null) errors.push(`字段「${label}」里出现了代码正文形态（${hit}）—— 预登记交的是任务内容，不是实现。`)
  }
  return errors
}

/**
 * 交接物 schema 表。
 *
 * `required` 里的字段缺一不可；`text` 类字段要求非空字符串。
 * `from` / `to` 声明方向 —— 这是「编写不能直接把产物交给审核」在数据层的表达。
 *
 * @type {Record<string, {zh:string, from:string[], to:string, fields:Record<string,object>, required:string[]}>}
 */
export const HANDOFF_SCHEMAS = {
  // --- 主 → 执行角色 -------------------------------------------------------
  dispatch: {
    zh: '派活单',
    from: ['main'],
    to: 'writer|tester|reviewer|orchestrator|architect|security|release|docs|performance|arbiter',
    fields: {
      task_id: F('string', '任务ID'),
      requirement: F('text', '原始需求'),
      acceptance: F('string[]', '验收标准'),
      constraints: F('string[]', '约束条件'),
      deliverable_format: F('text', '交付格式'),
      deadline: F('string', '截止要求'),
      roster_tier: F('string', '本次采用的档位'),
    },
    required: ['task_id', 'requirement', 'acceptance', 'constraints', 'deliverable_format', 'deadline'],
  },

  // --- ★需求分析（第 1 轮）------------------------------------------------
  //
  // ⚠️ 与 `orchestration` 的区别（本轮把这两个角色拆开了，别混）：
  //   · 本类型 = `orchestrator`（需求分析）回答「**这东西到底要做什么**」：
  //     任务卡、验收标准、边界条件、测试要点，外加一份**需求不清楚处清单**。
  //   · `orchestration` = `planner`（计划）回答「**这活怎么切、给谁、什么次序**」。
  //   拆分理由见 README / REPORT 本轮更正记录。
  requirement_analysis: {
    zh: '需求分析结论',
    from: ['orchestrator'],
    to: 'main|planner',
    fields: {
      task_id: F('string', '任务ID'),
      task_card: F('object', '任务卡（人话版：要做什么、不做什么）'),
      acceptance: F('string[]', '验收标准（可执行的、可判定的）'),
      test_points: F('string[]', '测试要点'),
      boundaries: F('string[]', '边界条件（没有就显式给空数组）', { allowEmpty: true }),
      /**
       * ★ 本轮的核心字段：**需求不清楚处清单**。
       *
       * 它是**必填**的，而且允许为空数组 —— "没有不清楚处"本身是一个必须
       * 显式回答的答案（与 known_issues / risk_notes 同一条设计）。
       * 这份清单会被完整带进 human_request（reason_kind=requirement_confirmation），
       * 由主对话转告用户确认。
       */
      unclear_points: F('string[]', '★ 需求不清楚处清单（没有就显式给空数组）', { allowEmpty: true }),
      analysis_reason: F('text', '分析依据：为什么这么理解这份需求、为什么这么定验收标准'),
      open_assumptions: F('string[]', '你替用户假设了什么（没有就给空数组；有假设时用户确认才有意义）', { allowEmpty: true }),
      /**
       * ★ 职责自限声明（设计目的第 3 条）：**我这次只做什么、不做什么**。
       *
       * 为什么它是必填而不是"最好写一下"：分析与计划这两个角色最容易"顺手多干" ——
       * 需求分析顺手把档位与角色清单定了（那是计划的活），
       * 计划顺手把实现方案也写了（那是编写的活）。
       * 把"我不做什么"写成**必填字段**之后，越界的产物就有了一个可机械检查的落点：
       * `will_not_do` 里写了"不分配 AI"，产物里却出现"派 writer#1" → 自相矛盾，拒。
       */
      role_scope: F('object', '★ 职责自限声明 { will_do: string[], will_not_do: string[] } —— 只做什么 / 不做什么'),
    },
    required: ['task_id', 'task_card', 'acceptance', 'test_points', 'boundaries', 'unclear_points', 'analysis_reason', 'role_scope'],
  },

  // --- ★计划（planner 的产出）--------------------------------------------
  //
  // 一条硬规矩：**自检没通过就不许分配 AI**。
  // 所以 `self_check.verdict=gaps` 时这份交接物会把状态推到「等待需求分析答复」
  // （退回需求分析），planner 在那之后**不能**再写角色清单（store 层拦）。
  plan: {
    zh: '开发计划（含自检）',
    from: ['planner'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      based_on_analysis: F('string', '依据哪份需求分析结论（requirement_analysis 的 handoff_id）'),
      plan_steps: F('string[]', '计划步骤（按顺序）'),
      // ⚠️ 允许空数组：**单席位**（count=1）时层清单退化成 ['all']，计划里本来就没有层要声明。
      //    多席位时必须给 —— 那一条由 buildWriters 执法（没给 layers 又 count>1 直接拒）。
      layers: F('object[]', '★ 层清单 [{layer, scope_paths[], deliverables[]}] —— 一个层一个编写席位（单席位可给空数组）', { allowEmpty: true }),
      self_check: F('object', '★ 自检结果 { verdict: "ok"|"gaps", checked: string[], gaps: string[] }'),
      // --- 自检发现缺失（verdict=gaps）时必填：回流要问的问题 ---
      gap_stage: F('string', '卡在哪一步（verdict=gaps 时必填）'),
      gap_question: F('text', '要问需求分析的问题（问句；verdict=gaps 时必填）'),
      gap_context: F('text', '★ 脱敏摘要（不许含代码；verdict=gaps 时必填）'),
      gap_urgency: F('enum', '紧急度', { values: HUMAN_URGENCIES }),
      plan_reason: F('text', '为什么这么计划（可追溯）'),
      risks: F('string[]', '计划层面的风险（没有就给空数组）', { allowEmpty: true }),
      /**
       * ★ **授权改动面**（设计目的第 1 条：最小改动）。
       *
       * 「改动面必须与授权面相等」—— 多改一行也算越界。
       * 逐条 = 一处授权：`{ id, path, action, why }`
       *   · `id`     授权条目 id（编写在 `dev_to_test.change_manifest` 里要**逐条引用**它，
       *              于是"每一处改动都有一个授权来源"这件事变成可机械核对的）
       *   · `path`   允许动的文件（也可以是一个目录/前缀，守门按前缀判定）
       *   · `action` `modify` / `create` / `delete` —— **新增文件也算越界**，
       *              要新建就必须在这里显式授权（写 `create`）
       *   · `why`    为什么非动它不可（"顺手重构 / 统一风格 / 升级依赖"在这里写不出理由 ⇒ 没有授权）
       */
      change_scope: F('object[]', '★ 授权改动面 [{ id, path, action: modify|create|delete, why }] —— 编写只能在这个清单内动'),
      /**
       * ★ **越界清单**：这次**不许做什么**。
       *
       * 与 `change_scope`（允许什么）配对：一个是白名单，一个是明令禁止。
       * 用户点名的四条要在这里写死：不许顺手重构、不许改测试、不许扩范围、不许改依赖；
       * 另有 `role_scope.will_not_do`（**角色级**自限）与它互补 ——
       * 这里是**任务级**的禁令，派活时会一起交给 writer 与 reviewer。
       */
      forbidden: F('string[]', '★ 越界清单（这次**不许**做什么；至少 1 条。例如：不许顺手重构 / 不许改测试 / 不许扩范围 / 不许改依赖）'),
      /**
       * ★ 每个角色的**边界卡**：这个角色只干什么、不干什么。
       *
       * 派活时按它派（`pipeline_dispatch` 会把对应那条写进派活单），
       * 于是"别让谁顺手多干"这件事在**派活那一刻**就被写死，而不是靠事后追责。
       * 覆盖性由 store 在写角色清单时核对（必须覆盖 roster 里每一个执行角色）。
       */
      role_boundaries: F('object[]', '★ 每个角色的边界卡 [{ role, only: string[], not: string[] }] —— 必须覆盖清单里每一个执行角色'),
      /** ★ 职责自限声明（同 requirement_analysis）。 */
      role_scope: F('object', '★ 职责自限声明 { will_do: string[], will_not_do: string[] } —— 只做什么 / 不做什么'),
    },
    required: ['task_id', 'plan_steps', 'layers', 'self_check', 'plan_reason', 'change_scope', 'forbidden', 'role_boundaries', 'role_scope'],
  },

  // --- ★分配结论（角色清单）—— 本轮从 orchestrator 改归 planner -----------
  orchestration: {
    zh: '分配结论（角色清单）',
    from: ['planner'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      tier: F('enum', '档位', { values: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] }),
      ai_count: F('number', '需要几个独立对话'),
      roles: F('string[]', '角色清单'),
      sequence: F('string[]', '调用顺序'),
      reason: F('text', '判断理由（每次判断都要有理由记录）'),
      task_card: F('object', '任务卡'),
      acceptance: F('string[]', '验收标准'),
      test_points: F('string[]', '测试要点'),
      boundaries: F('string[]', '边界条件'),
      /** ★ 本轮新增：编写层清单（与 writers.partitions[].layer 同源）。 */
      layers: F('string[]', '★ 层清单（席位数 = 层数）'),
    },
    required: ['task_id', 'tier', 'ai_count', 'roles', 'sequence', 'reason', 'acceptance', 'test_points'],
  },

  // --- 编写 → 测试 ---------------------------------------------------------
  dev_to_test: {
    zh: '编写交付给测试',
    from: ['writer'],
    to: 'tester',
    fields: {
      task_id: F('string', '任务ID'),
      artifact_version: F('string', '制品版本号，例如 v1'),
      patch_or_code: F('text', '代码或补丁'),
      change_note: F('text', '变更说明'),
      run_commands: F('string[]', '运行命令'),
      selftest_result: F('text', '自测结果'),
      known_issues: F('string[]', '已知问题（可以为空数组 —— "没有已知问题"本身是一个必须显式回答的答案）', { allowEmpty: true }),
      acceptance_map: F('object', '验收标准 → 实现位置 的对照（可空对象）'),
      /** ★ 席位元数据：多席位分工时必填，单席位可省（省了按 writer#1 算）。 */
      partition: F('object', '分区元数据 { seat, index, total, layer, scope_paths }'),
      /**
       * ★ **实际改动面**（设计目的第 1 条：最小改动）。
       *
       * 「改动面必须与授权面相等」—— 这份清单是**实际动了什么**的账：
       * `{ path, action, scope_id, lines, note }`
       *   · `scope_id` 必须指向计划里 `change_scope` 的某一条 ⇒
       *     **每一处改动都有一个授权来源**，可机械核对；
       *   · 测试与审核按这个面核对（"只改了这三行"是可验证的声明，不是形容词）。
       *
       * ⚠️ 它在 schema 里是**可选**的，但当任务**有**授权改动面（即有计划）时，
       *    store 层会把它变成**必填**并逐条核对 —— 为什么不在 schema 里直接必填：
       *    L0 没有"计划"这一站（规则引擎自批），所以 L0 任务不存在授权面，
       *    那时它是弃权的（见 README「待确认项」P4）。
       */
      change_manifest: F('object[]', '★ 实际改动面 [{ path, action, scope_id, lines, note }] —— 有授权面时必填，且每条必须引用授权条目', { allowEmpty: true }),
    },
    required: ['task_id', 'artifact_version', 'patch_or_code', 'change_note', 'run_commands', 'selftest_result', 'known_issues'],
  },

  // --- ★编写完成之后：架构图（交付物之一）---------------------------------
  //
  // ⚠️ 与 `design` 的区别：`design` 是 `architect` 在**编写之前**给的文字方案；
  //    本类型是 `diagrammer` 在**编写之后**交的**图**，而且必须带着
  //    "我确实走过闸门"的回执。
  architecture_diagram: {
    zh: '架构图交付',
    from: ['diagrammer'],
    to: 'main|reviewer',
    fields: {
      task_id: F('string', '任务ID'),
      based_on_artifact_version: F('string', '这张图对应哪个制品版本'),
      diagram_path: F('text', '渲染出来的图（HTML）路径'),
      /** ★ 走没走过 diagram_deliver 的闸门 —— 决定要不要收据。 */
      produced_by: F('enum', '怎么产出的', { values: ['diagram_deliver', 'self-provided'] }),
      receipt_path: F('string', '交付收据路径（produced_by=diagram_deliver 时必填，且必须真实存在）'),
      receipt_id: F('string', '收据 id（可空）'),
      html_sha256: F('string', '产物 sha256（可空；给了就会与磁盘上的文件核对）'),
      covered_modules: F('string[]', '这张图覆盖了哪些模块'),
      degraded: F('boolean', '是否降级产出（没走 diagram_deliver）'),
      degraded_reason: F('text', '降级原因（degraded=true 时必填）'),
      notes: F('string[]', '说明（可空）'),
    },
    required: ['task_id', 'based_on_artifact_version', 'diagram_path', 'produced_by', 'covered_modules', 'degraded'],
  },

  // --- ★★主管枢纽（T-20261011-56a37e）：五道确认的留痕载体 ------------------
  //
  //   为什么是**一种**带 station 字段的交接物、而不是五种各一个类型：
  //   五道站点的**形态必须一致**（验收 5 的原话），而"形态一致"最省事的落地
  //   就是同一张 schema —— 判据只写一遍，站点之间的差异全部落在一个枚举字段上。
  //   反过来（五个类型）会让"单确认冒充双确认"有五个可以各写一遍的地方。
  //
  //   ★ 双确认的**形态**（照抄既有 `effectiveReviewOk` 的强度，安全预审 B1/准入判据）：
  //     ① 必须是**两份**交接物，`from` 分别落在 `confirmers` 里的不同角色上
  //        —— from_role 由**调用方令牌**决定（lib/tools.js → lib/handoff.js），
  //        payload **自述不算数**（否则一份记录里写两个布尔字段就能冒充双确认）；
  //     ② 两份都绑定**同一个 artifact_version**；
  //     ③ 都必须在**最近一次打回之后**（打回即作废）；
  //     ④ 缺任一份 ⇒ 目标状态不可达，拒绝原文指名还缺谁；
  //     ⑤ 第③道与第④道**不得复用同一份确认记录**（station 字段写死在哪一站）。
  station_confirm: {
    zh: '站点确认（主管枢纽的确认留痕：五道站点里那四道 + ②b/②c 两个交接确认点）',
    from: ['supervisor', 'orchestrator'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      /**
       * ★ 哪一道站点 —— 这一个字段把"这份确认属于哪一站"写死（跨站复用即被拒）。
       *
       * ★ P0-1：枚举 = **五道站点**（①②③④⑤）+ **②b / ②c 两个交接确认点**
       *   （用户新口径第 7~8 跳：需求位确认架构图 → 主管二次确认）。
       *   唯一出处 `states.js` 的 `HUB_STATION_NAMES`（派生自两张同形的确认方表）——
       *   手抄一份的下场就是"某一站的确认记录交不上来"（第⑤道刻意不在枚举里，正是这个道理）。
       */
      station: F('enum', '★ 站点', { values: [...HUB_STATION_NAMES] }),
      /** ★ 确认针对的制品版本（双确认必须**绑同一版本**；打回即作废）。 */
      artifact_version: F('string', '被确认的制品版本（架构图站为图的产物标识；需求站为需求结论的 handoff_id）'),
      decision: F('enum', '确认结论', { values: ['ok', 'ng'] }),
      /**
       * ★ **证据标识**（不是正文搬运）。
       *
       * 安全预审阻断项 B1 的原话：控制角色在两道确认里引用的材料必须带
       * 「**可查的证据标识**（哪份交接物 id + 制品版本 + 内容哈希 + 计数/结论字段），
       * 而不是正文搬运」。
       */
      basis_refs: F('string[]', '★ 依据的证据标识（交接物 id / 制品版本 / 内容哈希 / 计数或结论字段；**不许搬正文**）'),
      /** ★ 依据的类别：本单只允许"脱敏证据正文"这一类（用户口径⑤）。 */
      basis_kind: F('enum', '依据类别', { values: ['evidence_digest'] }),
      /**
       * ★ **脱敏后的证据正文**（用户口径⑤：需求位两次确认看脱敏后的证据正文，
       *   而「证据 ≠ 代码正文」）。
       *   它会被 handoff 层的**形态判据**扫一遍：出现代码形态即拒（见 hubDigestErrors）。
       */
      basis_digest: F('text', '★ 脱敏后的证据正文（结论 / 计数 / 路径 / 哈希；**不许含代码正文**）'),
      reason: F('text', '为什么这么确认（可追溯）'),
    },
    required: ['task_id', 'station', 'artifact_version', 'decision', 'basis_refs', 'basis_kind', 'basis_digest', 'reason'],
  },

  // --- ★计划位 → 测试位的「任务内容预登记」（测试提前知情）-------------------
  //
  //   用户原话：「测试ai**提前**收到计划ai安排任务内容」。
  //   ★ 三条边界写死在字段与判据上（用户口径③ + 越界清单第 15 条）：
  //     · 它是**内容提前交到测试位手里**（本类型就是那个载体），不是"提前打个招呼"；
  //     · **不许看编写的产物** —— 提交时机判据：必须**在 dev_to_test 之前**；
  //       payload 里出现编写产物字段（patch_or_code / change_manifest / selftest_result）
  //       或测试结论字段（TEST_VERDICT_FIELDS）一律拒；
  //     · **提前知情 ≠ 提前开工**：`not_yet_available` 必须显式列出"还没有的东西"，
  //       而测试位在 `dev_submitted` 之前的**一切测试行动**由守门层拦（见 lib/guard.js）。
  prebrief: {
    zh: '任务内容预登记（计划位 → 测试位）',
    from: ['planner'],
    to: 'tester',
    fields: {
      task_id: F('string', '任务ID'),
      plan_handoff_id: F('string', '★ 这份预登记依据的计划交接物 id（可查）'),
      assigned_scope: F('string[]', '★ 计划位安排给测试的任务内容（要测什么、按哪几条验收）'),
      acceptance_refs: F('string[]', '对应的验收标准条目（引用需求档/计划里的序号或原文要点）'),
      artifact_under_test: F('string', '将要被测试的制品标识（版本号**在编写交付之前**还只是占位）'),
      /** ★ "还没有的东西"必须显式回答（同 known_issues 的设计：空集也是一个答案）。 */
      not_yet_available: F('string[]', '★ 现在还拿不到的东西（**编写产物必须在列**；显式回答，不许省）'),
      must_not_start_before: F('enum', '★ 开工闸：到哪个事件之后才允许开跑', { values: ['dev_submitted'] }),
      notes: F('string[]', '说明（可空）', { allowEmpty: true }),
    },
    required: ['task_id', 'plan_handoff_id', 'assigned_scope', 'acceptance_refs', 'artifact_under_test', 'not_yet_available', 'must_not_start_before'],
  },

  // --- ★主管 → 架构位：架构图重画指令（限 1 次）-----------------------------
  diagram_rework: {
    zh: '架构图重画指令（主管 → 架构位）',
    from: ['supervisor'],
    to: 'diagrammer',
    fields: {
      task_id: F('string', '任务ID'),
      reason: F('text', '★ 哪里不满足要求（可追溯；重画要照着它改）'),
      round: F('number', '第几次重画（**限 1 次**，即 round 只能是 1）'),
      escalate_after: F('boolean', '用尽预算后是否升级人工（用户口径④：是）'),
    },
    required: ['task_id', 'reason', 'round', 'escalate_after'],
  },

  // --- 测试 → 审核 ---------------------------------------------------------
  test_to_review: {
    zh: '测试报告交审核',
    from: ['tester'],
    to: 'reviewer',
    fields: {
      task_id: F('string', '任务ID'),
      artifact_version: F('string', '被测试的制品版本（必须与编写交付一致）'),
      test_cases: F('string[]', '测试用例'),
      execution_result: F('text', '执行结果'),
      failure_logs: F('string[]', '失败日志（通过时可以为空数组）', { allowEmpty: true }),
      pass_evidence: F('string[]', '通过证据'),
      risk_notes: F('string[]', '风险说明（没有风险时显式给空数组）', { allowEmpty: true }),
      verdict: F('enum', '测试结论', { values: ['pass', 'fail'] }),
    },
    required: ['task_id', 'artifact_version', 'test_cases', 'execution_result', 'failure_logs', 'pass_evidence', 'risk_notes', 'verdict'],
  },

  // --- 审核 → 主对话 / 用户 ------------------------------------------------
  review_verdict: {
    zh: '审核结论',
    from: ['reviewer'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      artifact_version: F('string', '被审核的制品版本（必须与测试报告一致）'),
      conclusion: F('enum', '审核结论', { values: ['OK', 'NG'] }),
      risk_notes: F('string[]', '风险说明（没有风险时显式给空数组）', { allowEmpty: true }),
      /**
       * ★ 安全确认（**必填**）。「审核必须确认网络安全/本地泄密是否发生」的落点。
       *   shape:
       *     {
       *       network:    { checked, applicable, reason?, evidence[], checks_ref[] },
       *       local_leak: { checked, evidence[], checks_ref[] },
       *       attestation: 'clean' | 'issues' | 'unknown',
       *       checked_by:  <role>,
       *       checks_ref:  [<检查工具的产物路径或 sha256>],
       *       findings:    [{ location, type, why, resolved }]
       *     }
       */
      security: F('object', '★ 安全确认（网络面 + 本地泄密面，含 attestation 与依据）'),
      release_approved: F('boolean', '是否放行'),
      final_delivery_note: F('text', '最终交付说明'),
      acceptance_check: F('object', '逐条验收标准的核对结果'),
      /**
       * ★ **前后版本对比结论**（用户原话：「审核 ai 确认没有干不该干的事（前后版本对比）」）。
       *
       * 审核不是靠"我看了一遍"，而是拿**改动基线**（派活那一刻记录的文件清单 + 哈希）
       * 与当前状态逐文件对比，产出对照结论。三种都要报出来：
       *   · **多改**：清单外的文件被改 / 被新增
       *   · **少改**：授权了却没动
       *   · **改错地方**：动的是别处
       *
       * shape：`{ baseline_id, verdict: 'within_scope'|'out_of_scope', added[], modified[],
       *          removed[], unauthorized[], missing[], note? }`
       *
       * ⚠️ **必填条件**：任务**有基线**时必填（`store` 层判）。
       *    它与 `pipeline_change_audit` 工具算出来的结果**必须一致** ——
       *    store 会自己再算一遍并核对 `baseline_id` 与 `verdict`，对不上就拒。
       *    完整的对照明细（added/modified/…）可以由工具产出后原样贴进来。
       */
      change_audit: F('object', '★ 前后版本对比结论 { baseline_id, verdict: within_scope|out_of_scope, added[], modified[], removed[], unauthorized[], missing[] }'),
      reject_to: F('enum', '不通过时打回给谁', { values: ['writer', 'tester', 'none'] }),
      reject_reason: F('text', '不通过原因（NG 时必填）'),
    },
    required: ['task_id', 'artifact_version', 'conclusion', 'risk_notes', 'release_approved', 'final_delivery_note', 'security'],
  },

  // --- 打回 ---------------------------------------------------------------
  test_to_dev: {
    zh: '测试打回编写',
    from: ['tester'],
    to: 'writer',
    fields: {
      task_id: F('string', '任务ID'),
      artifact_version: F('string', '被驳回的制品版本'),
      failed_cases: F('string[]', '失败的用例'),
      failure_logs: F('string[]', '失败日志'),
      expected: F('text', '期望行为 / 修复要求'),
    },
    required: ['task_id', 'artifact_version', 'failed_cases', 'failure_logs', 'expected'],
  },

  // --- 咨询角色（L2+ 按需）-------------------------------------------------
  design: {
    zh: '架构/技术方案',
    from: ['architect'],
    to: 'writer|main',
    fields: {
      task_id: F('string', '任务ID'),
      modules: F('string[]', '模块划分'),
      contracts: F('string[]', '接口契约'),
      decisions: F('string[]', '技术决策'),
      risks: F('string[]', '风险'),
    },
    required: ['task_id', 'modules', 'decisions'],
  },
  security_review: {
    zh: '安全/合规审计',
    from: ['security'],
    to: 'main|writer|reviewer',
    fields: {
      task_id: F('string', '任务ID'),
      findings: F('string[]', '发现项'),
      severity: F('enum', '最高严重级别', { values: ['none', 'low', 'medium', 'high', 'critical'] }),
      blocked: F('boolean', '是否存在阻断项'),
      remediation: F('string[]', '整改要求'),
    },
    required: ['task_id', 'findings', 'severity', 'blocked'],
  },
  release_plan: {
    zh: '发布/运维计划',
    from: ['release'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      steps: F('string[]', '上线步骤'),
      rollback: F('text', '回滚方案'),
      monitoring: F('string[]', '监控与告警'),
      window: F('string', '发布窗口'),
    },
    required: ['task_id', 'steps', 'rollback'],
  },
  docs_note: {
    zh: '文档产物',
    from: ['docs'],
    to: 'main',
    fields: { task_id: F('string', '任务ID'), files: F('string[]', '文档文件'), summary: F('text', '摘要') },
    required: ['task_id', 'summary'],
  },
  perf_report: {
    zh: '性能/压测报告',
    from: ['performance'],
    to: 'main|reviewer',
    fields: {
      task_id: F('string', '任务ID'),
      baseline: F('text', '基线'),
      measured: F('text', '实测'),
      regression: F('boolean', '是否有性能回归'),
      notes: F('string[]', '说明'),
    },
    required: ['task_id', 'baseline', 'measured', 'regression'],
  },
  arbitration: {
    zh: '仲裁裁定',
    from: ['arbiter'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      dispute: F('text', '争议点'),
      ruling: F('text', '裁定'),
      binding: F('boolean', '是否具约束力'),
    },
    required: ['task_id', 'dispute', 'ruling', 'binding'],
  },
  human_note: {
    zh: '人工干预记录',
    from: ['human'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      action: F('enum', '人工动作', { values: ['block', 'unblock', 'cancel', 'approve_override', 'rollback', 'note'] }),
      note: F('text', '说明'),
    },
    required: ['task_id', 'action', 'note'],
  },

  // --- ★席位继任的交接物（"换班"，不是"改角色"）----------------------------
  //
  // 为什么必须有它：继任的全部意义就是"新来的不用从零开始"。
  // 所以 must_read_files（至少含需求档）与 open_questions 是**硬要求**。
  seat_handover: {
    zh: '席位交接（换班）',
    from: ['architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'diagrammer', 'orchestrator', 'planner'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      from_seat: F('string', '旧席位（roster 席位 id 或角色）'),
      to_seat: F('string', '新席位'),
      reason: F('text', '★ 为什么换班（水位 + 依据）'),
      context_percent: F('number', '上报时的水位百分比'),
      progress_done: F('string[]', '已经做完的'),
      progress_todo: F('string[]', '还没做的'),
      must_read_files: F('string[]', '★ 必读文件清单（**至少含需求档**）'),
      key_decisions: F('string[]', '关键决定（决定 + 理由）'),
      open_questions: F('string[]', '★ 悬而未决的问题（没有就写空数组，必须显式给）', { allowEmpty: true }),
      next_step: F('text', '接手后的第一步做什么'),
      do_not_repeat: F('string[]', '★ 不要重复做的事（走过的弯路）'),
      pending_requests: F('object[]', '★ **编排专有**：待处理的请求队列 [{from, about, waiting_since}] —— 谁在等答复（没有就写空数组）', { allowEmpty: true }),
    },
    required: ['task_id', 'from_seat', 'to_seat', 'reason', 'progress_done', 'progress_todo', 'must_read_files', 'key_decisions', 'open_questions', 'next_step', 'do_not_repeat'],
  },

  // --- ★两级升级梯 · 第一级：角色 → 需求分析/编排判断 ---------------------
  //
  // 执行/顾问角色遇到确定不了的事，**先问需求分析**，不要一步就去找用户。
  // 需求分析能在需求层裁定（验收标准、边界条件、优先级、范围取舍、测试要点）就自己答；
  // 答不了才升级成 human_request。理由见 README「人工介入（两级升级梯）」。
  clarification_request: {
    zh: '请求需求分析裁定',
    // ★ planner 也在册：它的「计划自检发现缺失」就是退回需求分析。
    from: ['architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'diagrammer', 'planner'],
    to: 'orchestrator',
    fields: {
      task_id: F('string', '任务ID'),
      from_role: F('enum', '发起角色（必须与调用方一致）', {
        values: ['architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'diagrammer', 'planner'],
      }),
      stage: F('string', '卡在哪一步（例如"编写：接口字段命名"）'),
      question: F('text', '要问的问题 —— 必须是个**清晰可答**的问句'),
      context_digest: F('text', '★ 脱敏摘要（**不许含代码正文**）—— 让需求分析不读代码也能判断'),
      options: F('object[]', '你想到的可选方案（每项 {label, consequence}，可空）'),
      blocking: F('boolean', '是否阻塞本任务推进'),
      urgency: F('enum', '紧急度', { values: HUMAN_URGENCIES }),
      deadline: F('string', '希望什么时候答复（ISO 8601，可空）'),
    },
    required: ['task_id', 'from_role', 'stage', 'question', 'context_digest', 'blocking', 'urgency'],
  },

  // --- ★两级升级梯 · 第一级的回复：需求分析 → 发起角色 ---------------------
  clarification_reply: {
    zh: '需求分析裁定',
    from: ['orchestrator'],
    to: '*',
    fields: {
      task_id: F('string', '任务ID'),
      answer_to: F('string', '回给哪条请求（clarification_request 的 handoff_id 或 request_id）'),
      verdict: F('enum', '裁定结果', { values: ['answered', 'cannot_answer'] }),
      answer: F('text', '★ 结论（verdict=answered 时必填）'),
      reason: F('text', '★ 为什么这么答 / 为什么答不了（**必填**，可追溯）'),
      constraints_added: F('string[]', '因这次裁定而新增/收紧的约束（可空数组）'),
      escalate: F('boolean', '是否已/准备升级给人工（verdict=cannot_answer 时通常为 true）'),
    },
    required: ['task_id', 'answer_to', 'verdict', 'reason'],
  },

  // --- ★全量测试审批链（第 1 站）：测试 → 需求分析 --------------------------
  //
  // 用户原话：「需求 ai 要确认是否，并尽可能让测试 ai 少跑全量测试，如果测试 ai 要跑
  // 必须提交给需求 ai 和审核 ai 确认，如果都认为要做再提交给主对话给用户人工审核，
  // 确认人工通过后再提交给计划 ai 安排」。
  //
  // ★ 与**澄清梯**（clarification_request/reply）**问的不是同一个问题**：
  //   · 澄清梯问的是「**需求本身不清楚**」—— 答案在需求层，答完就能继续干活；
  //   · 这条链问的是「**这件事值不值得做**」—— 它不改需求、不改计划范围，
  //     只是给"要不要跑一整套测试"这个**成本决策**盖章。
  //   两者的形状一样（提出 → 逐级裁定 → 顶到人工），所以**合流**在同一个两级梯机制上：
  //   升级到人工那一级用的就是既有的 `human_request` / `human_reply`，不另起一套。
  full_test_request: {
    zh: '全量测试申请',
    from: ['tester'],
    to: 'orchestrator',
    fields: {
      task_id: F('string', '任务ID'),
      /** 本次**改动面**（授权面 / 实际改动清单）——定向测试就是按它挑用例的。 */
      affected_paths: F('string[]', '★ 本次改动面（改动清单里的路径）—— 定向测试按它挑用例'),
      /** 已经跑过的定向测试（先证明"定向不够"，这是提全量的前提）。 */
      targeted_already_run: F('string[]', '★ 已经跑过的定向/增量测试（命令 + 结论）—— 先证明定向不够'),
      /** ④ 为什么定向不够（对应 Stop Ladder 第四问：没它会失败吗？）。 */
      why_targeted_insufficient: F('text', '★ **为什么定向测试不够** —— 不做全量的话，会在哪一步失败？（答不上来就别申请）'),
      /** 打算怎么跑（范围 + 命令），审批链就是批这个。 */
      what_will_run: F('text', '★ 打算跑什么（**具体的全量命令 / 范围**）—— 审批批的就是它'),
      estimated_cost: F('string', '预计耗时/资源（可空，但审批人会想看）'),
      risk_if_not_run: F('text', '不跑的话风险是什么（可空）'),
    },
    required: ['task_id', 'affected_paths', 'targeted_already_run', 'why_targeted_insufficient', 'what_will_run'],
  },

  // --- ★全量测试审批链（第 2~4 站）：三站裁定 ------------------------------
  //
  // 一站一份，`stage` 区分；**必须按 need → worth → arrange 的顺序**（顺序由 store 判，
  // 不是靠自觉）。任一站 `ok=false` 就是**否决**，链当场停住并留痕。
  full_test_review: {
    zh: '全量测试裁定',
    from: ['orchestrator', 'reviewer', 'planner'],
    to: '*',
    fields: {
      task_id: F('string', '任务ID'),
      /** 回给哪条申请（full_test_request 的 handoff_id 或 request_id）。 */
      request_id: F('string', '★ 回给哪条 full_test_request'),
      stage: F('enum', '★ 这是哪一站（必须与你的角色匹配：需求分析=need / 审核=worth / 计划=arrange）', {
        values: ['need', 'worth', 'arrange'],
      }),
      ok: F('boolean', '★ 同意还是否决 —— 否决也要交这一份（留痕），理由是必填'),
      reason: F('text', '★ 判断理由（**同意与否决都必须写**）'),
      /** 只有 need 站该填：这次到底需不需要全量。 */
      necessity: F('text', 'need 站：这次为什么**需要/不需要**全量（可空）'),
      /** 只有 worth 站该填：值不值得（成本 vs 风险）。 */
      worth_it: F('text', 'worth 站：值不值得跑（成本 vs 风险，可空）'),
      /** 只有 arrange 站该填：怎么跑（派谁 / 范围 / 命令）—— 会变成放行凭据的内容。 */
      scope: F('string', 'arrange 站：跑的范围（例如"全部用例" / "除 e2e 外"）'),
      command: F('string', 'arrange 站：**最终批准的全量命令**（放行时按它比对，避免"批一条跑另一条"）'),
      notes: F('text', 'arrange 站：其它安排（派谁跑、注意什么）'),
    },
    required: ['task_id', 'request_id', 'stage', 'ok', 'reason'],
  },

  // --- ★人工介入请求（执行/顾问角色 → 主对话 → 用户）----------------------  //
  // 拓扑上这是**唯一**的上升通道：用户只与主对话相连，执行角色根本没有
  // 用户的对话框。所以"我这边卡住了，要人拍板"必须先变成一份结构化请求
  // 交给主对话，由主对话**转告**。`question_for_human` 强制是**给人看的人话**
  // 且**不许含代码** —— 因为主对话不读代码，含代码的请求它转告不了。
  human_request: {
    zh: '人工介入请求',
    from: ['orchestrator', 'planner', 'architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'human'],
    to: 'main',
    fields: {
      task_id: F('string', '任务ID'),
      from_role: F('enum', '发起角色（必须与调用方一致）', {
        values: ['orchestrator', 'planner', 'architect', 'security', 'writer', 'tester', 'reviewer', 'release', 'docs', 'performance', 'arbiter', 'human'],
      }),
      created_at: F('string', '发起时间（ISO 8601；留空则由插件按服务器时间补上）'),
      reason_kind: F('enum', '为什么要人拍板', { values: Object.keys(HUMAN_REASON_KINDS) }),
      question_for_human: F('text', '★ 给用户看的人话问题（不含代码、不含补丁、必须是个问句）'),
      context_for_human: F('text', '给用户的补充背景（同样不许含代码，可空）'),
      options: F('object[]', '可选方案（每项 {label, consequence}，可空）'),
      recommended: F('string', '你的建议（必须是 options 里某个 label；仅供参考，不构成决定）'),
      blocking: F('boolean', '是否阻塞本任务推进'),
      blocked_stage: F('string', '卡在哪一步（blocking=true 时必填）'),
      urgency: F('enum', '紧急度', { values: HUMAN_URGENCIES }),
      decision_kind: F('enum', '需要用户给什么形式的答复', { values: Object.keys(HUMAN_DECISION_KINDS) }),
      timeout_behavior: F('enum', '无人回应时怎么办', { values: Object.keys(HUMAN_TIMEOUT_BEHAVIORS) }),
      // --- ★两级升级梯：由需求分析升级上来时必填 ---
      escalated_from: F('string', '从哪条 clarification_request 升上来的（handoff_id）'),
      raised_by: F('string', '原本是谁问的（上游请求的发起角色）'),
      orchestrator_reason: F('text', '需求分析为什么答不了（用户有权知道为什么这事轮到他拍板）'),
      default_option: F('string', '默认选项（timeout_behavior=proceed_with_default 时必填）'),
    },
    required: [
      'task_id',
      'from_role',
      'reason_kind',
      'question_for_human',
      'blocking',
      'urgency',
      'decision_kind',
      'timeout_behavior',
    ],
  },
}

/**
 * 校验一份交接物 payload。
 *
 * @param {string} kind
 * @param {any} payload
 * @returns {{ok:boolean, errors:string[], normalized?:object}}
 */
export function validateHandoff(kind, payload) {
  const schema = HANDOFF_SCHEMAS[kind]
  if (schema === undefined) {
    return { ok: false, errors: [`未知交接物类型「${kind}」；合法值：${Object.keys(HANDOFF_SCHEMAS).join(' / ')}`] }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, errors: [`交接物「${kind}」必须是一个对象。`] }
  }

  const errors = []
  const normalized = {}

  for (const [name, spec] of Object.entries(schema.fields)) {
    const raw = payload[name]
    const required = schema.required.includes(name)
    const missing = raw === undefined || raw === null

    if (missing) {
      if (required) errors.push(`缺少必填字段「${name}」（${spec.zh}）`)
      continue
    }

    switch (spec.type) {
      case 'string': {
        if (typeof raw !== 'string' || raw.trim().length === 0) {
          if (required) errors.push(`字段「${name}」（${spec.zh}）必须是非空字符串`)
          break
        }
        normalized[name] = raw.trim()
        break
      }
      case 'text': {
        if (typeof raw !== 'string' || raw.trim().length === 0) {
          if (required) errors.push(`字段「${name}」（${spec.zh}）必须是非空文本`)
          break
        }
        normalized[name] = raw
        break
      }
      case 'string[]': {
        const arr = toStringArray(raw)
        // 必填的数组字段：默认要求至少 1 条；显式标 `allowEmpty: true` 的例外 ——
        // 「已知问题：无」「风险说明：无」本身就是一个必须显式回答的答案，
        // 强行要求非空会逼模型编一条假风险出来，那是更坏的结果。
        if (arr.length === 0 && required && spec.allowEmpty !== true) {
          errors.push(`字段「${name}」（${spec.zh}）至少要有 1 条`)
          break
        }
        normalized[name] = arr
        break
      }
      case 'number': {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          errors.push(`字段「${name}」（${spec.zh}）必须是数字`)
          break
        }
        normalized[name] = raw
        break
      }
      case 'boolean': {
        if (typeof raw !== 'boolean') {
          errors.push(`字段「${name}」（${spec.zh}）必须是布尔值`)
          break
        }
        normalized[name] = raw
        break
      }
      case 'enum': {
        if (typeof raw !== 'string' || !spec.values.includes(raw)) {
          errors.push(`字段「${name}」（${spec.zh}）必须是 ${spec.values.join(' / ')} 之一，当前是 ${JSON.stringify(raw)}`)
          break
        }
        normalized[name] = raw
        break
      }
      case 'object': {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          errors.push(`字段「${name}」（${spec.zh}）必须是对象`)
          break
        }
        normalized[name] = raw
        break
      }
      case 'object[]': {
        if (!Array.isArray(raw)) {
          errors.push(`字段「${name}」（${spec.zh}）必须是数组`)
          break
        }
        const bad = raw.findIndex((x) => typeof x !== 'object' || x === null || Array.isArray(x))
        if (bad >= 0) {
          errors.push(`字段「${name}」（${spec.zh}）第 ${bad + 1} 项不是对象`)
          break
        }
        if (raw.length === 0 && required && spec.allowEmpty !== true) {
          errors.push(`字段「${name}」（${spec.zh}）至少要有 1 条`)
          break
        }
        normalized[name] = raw
        break
      }
      default:
        errors.push(`字段「${name}」的 schema 类型「${spec.type}」不被支持（插件内部错误）`)
    }
  }

  // --- ★设计目的：控制角色的产物里不许出现代码正文 ------------------------
  //
  //   需求分析与计划**不看代码**（守门拦读），所以它们的结论里本来就不该有代码。
  //   判据只查解释性文本字段（见 scanControlRoleProductForCode 的注释）。
  //   为什么按 `kind` 判而不是按 from_role 判：方向表已经保证
  //   `requirement_analysis` 只能由 orchestrator 交、`plan` 只能由 planner 交
  //   （`HANDOFF_SCHEMAS[*].from` + 守门的方向表两道），所以 kind 就等价于角色，
  //   而且它是**声明式**的 —— 以后加控制角色时，只要它交这两种产物就自动受约束。
  if (kind === 'requirement_analysis' || kind === 'plan') {
    errors.push(...scanControlRoleProductForCode(kind, normalized))
  }

  // --- ★设计目的：分析与计划「只干什么，不要多干」--------------------------
  //
  //   ① 两份产物都必须有**职责自限声明**（will_do / will_not_do）；
  //   ② 需求分析的产物里**不许出现分配内容**（派谁 / 用几个 AI / 档位 / 角色清单）——
  //      那是计划 AI 的活，写了就等于把计划这一站掏空；
  //   ③ 计划的产物里不许出现代码正文 —— 由上面的 scanControlRoleProductForCode 管，
  //      与上一轮"编排别看代码"是**同一条判据**（这里刻意不另写一份，避免两套规则漂移）。
  if (kind === 'requirement_analysis' || kind === 'plan') {
    errors.push(...validateRoleScope(normalized.role_scope, 'role_scope'))
  }
  if (kind === 'requirement_analysis') {
    errors.push(...scanRequirementAnalysisForAllocation(normalized))
  }
  if (kind === 'plan') {
    errors.push(...validateChangeScope(normalized.change_scope))
    errors.push(...validateRoleBoundaries(normalized.role_boundaries))
  }

  // --- ★设计目的：最小改动（改动面必须与授权面相等）------------------------
  //
  //   这里只做**形状**校验：每条改动要有 path / action / scope_id。
  //   "每条改动是否真的落在授权面内"要读计划里的 `change_scope`，
  //   那是 store 层的判据（`checkManifestAgainstScope`）。
  if (kind === 'dev_to_test' && Array.isArray(normalized.change_manifest)) {
    normalized.change_manifest.forEach((m, i) => {
      const path = typeof m?.path === 'string' ? m.path.trim() : ''
      const action = typeof m?.action === 'string' ? m.action : ''
      const sid = typeof m?.scope_id === 'string' ? m.scope_id.trim() : ''
      if (path.length === 0) errors.push(`change_manifest[${i}].path 必填（实际动了哪个文件）`)
      if (!CHANGE_ACTIONS.includes(action)) {
        errors.push(`change_manifest[${i}].action=「${action || '(缺失)'}」非法；必须是 ${CHANGE_ACTIONS.join(' / ')} 之一`)
      }
      if (sid.length === 0) errors.push(`change_manifest[${i}].scope_id 必填（指向计划里那条授权）`)
    })
  }

  // --- ★设计目的：编写不得产出测试结论 --------------------------------------
  //
  //   ① `dev_to_test` 里不许夹带测试结论字段（换个信封寄结论，同样是越界）；
  //   ② 方向表本身已经把 `test_to_review` / `test_to_dev` / `review_verdict`
  //      限定给 tester / reviewer（白名单方向），这里再做一道**内容**判据。
  if (kind === 'dev_to_test') {
    // ⚠️ 必须查**原始 payload**，不能查 `normalized`：`normalized` 只装 schema 里声明过的
    //    字段 —— 夹带进来的测试结论字段**恰恰是没声明的那些**，查 normalized 一个都看不见。
    const src = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
    const smuggled = TEST_VERDICT_FIELDS.filter((f) => src[f] !== undefined && src[f] !== null)
    if (smuggled.length > 0) {
      errors.push(
        `字段「${smuggled.join('」「')}」不属于 dev_to_test（编写交付给测试）。\n` +
          '★ 设计目的：**编写不跑测试** —— 用例、执行结果、通过证据、失败日志、测试结论，' +
          '全部是 `tester` 的产物。\n' +
          '  在 dev_to_test 里夹带这些字段，等于把测试结论换个信封寄出来，' +
          '下游（测试/审核）也无法分辨"这是谁判的"。\n' +
          '你要交的只有五样：代码或补丁、变更说明、运行命令、自测结果、已知问题。\n' +
          '（"自测的最小限度"是待用户拍板项 —— 见 README「待确认项」。）',
      )
    }
  }

  // --- ★★主管枢纽（T-20261011-56a37e）：站点确认 / 预登记的形状判据 ----------
  //
  //   这一段是**判据**，不是文案。三条硬事：
  //     ① 「脱敏证据正文」不许变成"控制角色看代码正文"的后门（安全预审风险③ / 阻断项 B1）；
  //     ② 「提前知情 ≠ 提前开工」：预登记里不许夹带编写产物或测试结论字段；
  //     ③ `basis_refs` 必须是**可查的证据标识**，不许是"我看了没问题"。
  if (kind === 'station_confirm') {
    errors.push(...validateStationConfirm(normalized, payload))
  }
  if (kind === 'prebrief') {
    errors.push(...validatePrebrief(normalized, payload))
  }
  if (kind === 'diagram_rework') {
    if (normalized.round !== 1) {
      errors.push(
        `diagram_rework.round=「${String(normalized.round)}」非法：架构图重画**限 1 次**（用户口径④）。\n` +
          '★ 第 2 次不满足时不许再发重画指令 —— 走 pipeline_human_request 升给用户定。',
      )
    }
  }

  // --- ★安全确认（review_verdict）------------------------------------------
  //
  // 这一段的每一条都是**硬闸**，因为用户的原话是"审核**必须**确认网络安全/本地泄密
  // 是否发生" —— "必须"在实现上就是"没有就过不去"。
  if (kind === 'review_verdict') {
    const sec = normalized.security
    const isObj = typeof sec === 'object' && sec !== null && !Array.isArray(sec)

    if (!isObj) {
      errors.push(
        '缺少 security 段。\n' +
          '★ 审核**必须**确认"网络安全 / 本地泄密是否发生"，没确认就不算完成审核。\n' +
          'shape：{ network:{checked,applicable,reason?,evidence[],checks_ref[]}, local_leak:{checked,evidence[],checks_ref[]}, ' +
          "attestation:'clean'|'issues'|'unknown', checked_by, checks_ref[], findings[{location,type,why,resolved}] }\n" +
          '最省事的做法：调 pipeline_security_check 扫一遍，把它返回的 checks_ref 与结论填进来。',
      )
    } else {
      // ① attestation 必须明确
      const att = sec.attestation
      if (att !== 'clean' && att !== 'issues' && att !== 'unknown') {
        errors.push(`security.attestation=「${att ?? '(缺失)'}」非法；必须是 clean / issues / unknown 之一。`)
      } else if (att === 'unknown') {
        errors.push(
          'security.attestation=unknown —— **不允许通过**。\n' +
            '★ 要么查清（clean / issues），要么打回让编写补齐可查的证据。\n' +
            '"没查"和"查了没问题"是两件完全不同的事，不能都算过。\n' +
            '如果确实查不了（例如缺环境），走 pipeline_rework 打回，或 pipeline_human_request 升级给用户。',
        )
      }

      // ② 两个面都要有 checked，且各自的依据非空
      const faces = [
        ['local_leak', '本地泄密面'],
        ['network', '网络面'],
      ]
      for (const [key, zh] of faces) {
        const f = sec[key]
        if (typeof f !== 'object' || f === null || Array.isArray(f)) {
          errors.push(`security.${key}（${zh}）缺失 —— 两个面都要给结论（哪怕是"不适用"，也要说明依据）。`)
          continue
        }
        const applicable = f.applicable === false ? false : true
        if (applicable === false) {
          // 不适用：必须说明依据
          if (typeof f.reason !== 'string' || f.reason.trim().length === 0) {
            errors.push(
              `security.${key}.applicable=false（${zh}不适用）时必须给 reason —— 说明**依据**是什么。\n` +
                '（例如网络面："本任务产物只有本地脚本，没有出网调用，证据见 checks_ref"。）',
            )
          }
        } else {
          if (f.checked !== true) {
            errors.push(
              `security.${key}.checked 不为 true（${zh}没查）。\n` +
                '★ 审核不能跳过检查 —— checked:false 与"没写"一样，都不算确认过。',
            )
          }
          const refs = toStringArray(f.checks_ref)
          if (refs.length === 0) {
            errors.push(
              `security.${key}.checks_ref 为空（${zh}没有依据）。\n` +
                '★ 结论必须可追问依据：填 pipeline_security_check 返回里的 checks_ref，' +
                '或你自己写下的检查产物路径 / sha256。\n' +
                '"我看了，没问题"不是依据。',
            )
          }
        }
      }

      // ③ 顶层 checks_ref 也要有
      if (toStringArray(sec.checks_ref).length === 0) {
        errors.push('security.checks_ref 为空 —— 整段安全确认至少要给一份检查依据（通常就是 pipeline_security_check 的结果文件）。')
      }

      // ④ 有未解决的 finding ⇒ 不许 clean
      const secFindings = Array.isArray(sec.findings) ? sec.findings : []
      secFindings.forEach((f, i) => {
        const loc = typeof f?.location === 'string' ? f.location.trim() : ''
        const why = typeof f?.why === 'string' ? f.why.trim() : ''
        const typ = typeof f?.type === 'string' ? f.type.trim() : ''
        if (loc.length === 0) errors.push(`security.findings[${i}] 缺 location（哪个文件/哪一行/哪份制品）—— 不可追问的 finding 等于没提`)
        if (typ.length === 0) errors.push(`security.findings[${i}] 缺 type`)
        if (why.length === 0) errors.push(`security.findings[${i}] 缺 why（为什么算问题）`)
        // ★ 不得把命中原文写进结论
        const leak = looksLikeRawSecret(`${loc} ${typ} ${why}`)
        if (leak !== null) {
          errors.push(
            `security.findings[${i}] 里出现了疑似凭证**原文**（${leak.type}）。\n` +
              '★ 这条是刻意的：把命中的密钥原文抄进审核结论，等于**把泄露从制品搬到了结论里** —— ' +
              '结论会落盘、会被转告、会进审计。\n' +
              '正确写法：只写\'哪个文件第几行命中哪一类\'（例如 "artifacts/v1/x.json 第 3 行命中 generic_assigned_secret"）。',
          )
        }
      })
      if (secFindings.some((f) => f?.resolved !== true) && att === 'clean') {
        errors.push(
          `security.attestation=clean，但有 ${secFindings.filter((f) => f?.resolved !== true).length} 条未解决的 finding —— 自相矛盾。\n` +
            '有未解决的问题时要么标 issues（然后打回/升级），要么先说清它为什么不算问题（写进 why）。',
        )
      }

      // ⑤ 审核必须自己出结论：不能只引用安全角色的说法
      if (typeof sec.checked_by !== 'string' || sec.checked_by.trim().length === 0) {
        errors.push('security.checked_by 必须写清**是谁做的这次确认**（通常是 reviewer）。安全角色给的 security_review 只能作为输入证据被引用，不能替代你自己的结论。')
      } else if (sec.checked_by.trim() === 'security') {
        errors.push(
          'security.checked_by=security —— 审核不能只写"安全角色说没问题"。\n' +
            '★ 安全角色（L3+）产出的 security_review 是**输入证据**，不是审核结论。\n' +
            '审核必须自己跑一遍检查（或复核安全角色的证据）并给出自己的 attestation。',
        )
      }
    }
  }

  // --- ★席位交接 -----------------------------------------------------------
  if (kind === 'seat_handover') {
    const v = validateSeatHandover(normalized)
    if (v.ok !== true) errors.push(...v.errors)
    if (typeof normalized.context_percent === "number" && (normalized.context_percent < 0 || normalized.context_percent > 100)) {
      errors.push("context_percent 必须是 0~100 的数字。")
    }
  }

  // --- ★两级升级梯 ---------------------------------------------------------
  if (kind === 'clarification_request') {
    if (typeof normalized.question === 'string' && !looksLikeQuestion(normalized.question)) {
      errors.push('字段「question」里没有问号 —— 需求分析看完不知道该回答什么。请把要问的事写成一个明确的问句。')
    }
    if (typeof normalized.question === 'string' && normalized.question.length > HUMAN_TEXT_MAX) {
      errors.push(`字段「question」${normalized.question.length} 字符，超过 ${HUMAN_TEXT_MAX} 上限 —— 问题要短到能一眼读完`)
    }
    // context_digest 是**脱敏摘要** —— 不许含代码正文。
    // 为什么这条要执法：需求分析是"不读代码也能判断"的那一级；
    // 摘要里塞了代码，要么它读不懂，要么它被迫去读代码 —— 两条路都违背这一级存在的意义。
    // 而且升级到用户时这份摘要会被复用，含代码就转告不了。
    if (typeof normalized.context_digest === 'string') {
      const hit = detectCodeInHumanText(normalized.context_digest)
      if (hit !== null) {
        errors.push(
          `字段「context_digest」里混进了代码（${hit}）。\n` +
            '这个字段是**脱敏摘要** —— 需求分析靠它在不读代码的前提下判断，升级时它还会被复用给用户看。\n' +
            '请改写成纯中文/纯英文的说明；需要保留技术细节就放到 options 的 consequence 里（那也会被一起检查）。',
        )
      }
    }
    if (Array.isArray(normalized.options)) {
      normalized.options.forEach((o, i) => {
        const cons = typeof o?.consequence === 'string' ? o.consequence.trim() : ''
        if (typeof o?.label !== 'string' || o.label.trim().length === 0) errors.push(`options[${i}] 缺 label`)
        if (cons.length === 0) errors.push(`options[${i}] 缺 consequence（选了它会怎样）`)
      })
    }
  }

  if (kind === 'clarification_reply') {
    const v = normalized.verdict
    const answer = typeof normalized.answer === 'string' ? normalized.answer.trim() : ''
    if (v === 'answered' && answer.length === 0) {
      errors.push('verdict=answered 时必须给 answer —— 说了"答得了"却没给结论，发起角色拿不到东西。')
    }
    if (v === 'cannot_answer' && answer.length > 0) {
      errors.push('verdict=cannot_answer 时不该给 answer —— 答不了就不该有结论，只能给升级理由（reason）。')
    }
    if (typeof normalized.reason === 'string' && normalized.reason.trim().length === 0) {
      errors.push('reason 必须写清"为什么这么答 / 为什么答不了" —— 这一级的每一步都要可追溯。')
    }
    if (typeof normalized.reason === 'string' && normalized.reason.length > HUMAN_TEXT_MAX) {
      errors.push(`字段「reason」${normalized.reason.length} 字符，超过 ${HUMAN_TEXT_MAX} 上限`)
    }
    if (typeof v === 'string' && v === 'cannot_answer' && normalized.escalate !== true) {
      errors.push(
        'verdict=cannot_answer 时 escalate 必须为 true。\n' +
          '★ 这一级"答不了"的唯一合法去处就是升级给用户（human_request），不允许答不了又不升级 —— ' +
          '那会让发起角色卡在「等待需求分析答复」里永远等不到东西。',
      )
    }
  }

  // --- ★编写席位（dev_to_test 的 partition 字段）---------------------------
  if (kind === 'dev_to_test' && normalized.partition !== undefined) {
    const p = normalized.partition
    const seat = typeof p?.seat === 'string' ? p.seat.trim() : ''
    if (!/^writer#[1-9]\d*$/.test(seat)) {
      errors.push(`partition.seat=「${seat}」不是合法席位 id（形如 writer#1 … writer#6）`)
    }
    if (!Number.isInteger(p?.index) || p.index < 1) errors.push('partition.index 必须是 >=1 的整数')
    if (!Number.isInteger(p?.total) || p.total < 1) errors.push('partition.total 必须是 >=1 的整数')
    if (Number.isInteger(p?.index) && Number.isInteger(p?.total) && p.index > p.total) {
      errors.push(`partition.index=${p.index} 大于 total=${p.total}`)
    }
    if (!Array.isArray(p?.scope_paths) || p.scope_paths.length === 0) {
      errors.push('partition.scope_paths 至少要有一条 —— 没有范围就没法执法越界写入')
    }
    // ★ 本轮新增：层字段。**按层分工不取消路径执法** —— 两条判据同时在。
    //
    // ⚠️ 这里只在**给了 layer 时**校验形状：层清单在 roster 里，而 schema 层
    //    看不到 roster。缺 layer 时由 store 层从 roster 的分区表**回填**
    //    （`checkSeatOwnership`），回填完仍是空就说明这个席位不在册 —— 那条判据
    //    在 store 层，比这里更准。（早先在这里直接判"缺了就拒"，会把
    //    "席位自己交自己那份、层由机制回填"这条正常路径也一起挡掉。）
    if (typeof p?.layer !== 'undefined' && p.layer !== null) {
      if (typeof p.layer !== 'string' || !/^[a-z][a-z0-9_-]{0,23}$/.test(p.layer.trim())) {
        errors.push(
          `partition.layer=「${p.layer}」不是合法层 id（小写字母开头，可含数字/下划线/连字符）。\n` +
            '★ 层是"这个席位负责哪一层"的机器可读字段 —— 缺了它，按层分工就只能靠人嘴说。\n' +
            '单席位退化时用 layer="all"（一个席位负责全部层）；多席位时会从角色清单的分区表自动回填。',
        )
      }
    }
  }

  // --- ★计划（planner）：自检通过才谈得上分配 ------------------------------
  if (kind === 'plan') {
    const sc = normalized.self_check
    const verdict = typeof sc?.verdict === 'string' ? sc.verdict : ''
    if (verdict !== 'ok' && verdict !== 'gaps') {
      errors.push(`self_check.verdict=「${verdict || '(缺失)'}」非法；必须是 ok / gaps 之一（"自检过没有"必须是一个显式答案）。`)
    }
    const checked = toStringArray(sc?.checked)
    if (checked.length === 0) {
      errors.push(
        'self_check.checked 为空 —— 自检不能只说结论。\n' +
          '★ 请逐条列出你核对过什么（需求覆盖、层边界、依赖顺序、验收标准可测、风险…），否则"自检通过"无法复核。',
      )
    }
    const gaps = toStringArray(sc?.gaps)
    if (verdict === 'gaps' && gaps.length === 0) {
      errors.push('self_check.verdict=gaps 但 gaps 是空数组 —— 说"有缺失"就得说出缺什么。')
    }
    if (verdict === 'ok' && gaps.length > 0) {
      errors.push(
        `self_check.verdict=ok 却有 ${gaps.length} 条 gaps —— 自相矛盾。\n` +
          '★ 有缺失就必须 verdict=gaps，走回流（退回需求分析）而不是硬分配 AI。',
      )
    }
    if (verdict === 'gaps') {
      if (typeof normalized.gap_stage !== 'string' || normalized.gap_stage.trim().length === 0) {
        errors.push('verdict=gaps 时必须给 gap_stage（卡在哪一步）—— 需求分析要知道你是卡在哪儿才问得出东西。')
      }
      if (typeof normalized.gap_question !== 'string' || !looksLikeQuestion(normalized.gap_question)) {
        errors.push('verdict=gaps 时必须给 gap_question，且里面要有问号 —— 退回需求分析总得问出个问题来。')
      }
      const ctx = typeof normalized.gap_context === 'string' ? normalized.gap_context : ''
      if (ctx.trim().length === 0) {
        errors.push('verdict=gaps 时必须给 gap_context（脱敏摘要）—— 需求分析不读代码，你得像陈述一样把它讲清楚。')
      } else {
        const hit = detectCodeInHumanText(ctx)
        if (hit !== null) {
          errors.push(
            `gap_context 里混进了代码（${hit}）。\n` +
              '这个字段是**脱敏摘要** —— 需求分析靠它在不读代码的前提下判断，升级给用户时它还会被复用。',
          )
        }
      }
    }
    // ★ 层清单与步骤：都要有，且层不能重名。
    const layers = Array.isArray(normalized.layers) ? normalized.layers : []
    const ids = layers.map((l) => String(l?.layer ?? '').trim())
    if (ids.some((x) => x.length === 0)) errors.push('layers 里每一项都必须给 layer（层 id）')
    if (new Set(ids).size !== ids.length) errors.push('layers 里有重复的层 id —— 一个层只能有一个席位负责。')
    for (const [i, l] of layers.entries()) {
      if (toStringArray(l?.scope_paths).length === 0) {
        errors.push(
          `layers[${i}]（${ids[i] || '?'}）没有 scope_paths。\n` +
            '★ **按层分工不取消路径执法**：层说明"负责什么"，路径说明"能写哪里"，两个都要，缺一不可。',
        )
      }
    }
  }

  // --- ★需求分析结论 -------------------------------------------------------
  if (kind === 'requirement_analysis') {
    // 「不清楚处」是必填的（可以为空数组），但要与 open_assumptions 一起读得通：
    // 有假设却不提任何不清楚处 = 把自己的假设当成用户的意图，那是**最危险的一种"没问题"**。
    const unclear = toStringArray(normalized.unclear_points)
    const assumptions = toStringArray(normalized.open_assumptions)
    if (unclear.length === 0 && assumptions.length > 0) {
      errors.push(
        `unclear_points 是空的，但 open_assumptions 里有 ${assumptions.length} 条假设 —— 自相矛盾。\n` +
          '★ 你替用户假设了事情却不说"这里我不清楚"，等于把假设当成了用户的意图。\n' +
          '两条出路：把假设提请确认（写进 unclear_points），或者删掉假设（确有依据才留）。',
      )
    }
    normalized.unclear_points = unclear
    normalized.open_assumptions = assumptions
  }

  // --- ★架构图交付 ---------------------------------------------------------
  if (kind === 'architecture_diagram') {
    const by = normalized.produced_by
    const degraded = normalized.degraded === true

    if (by === 'diagram_deliver') {
      // 声称走过闸门 ⇒ 必须有收据，而且收据得真实存在（**这条由 store 层落地校验**，
      // 因为要读磁盘；这里只查字段本身是否给全）。
      if (typeof normalized.receipt_path !== 'string' || normalized.receipt_path.trim().length === 0) {
        errors.push(
          'produced_by=diagram_deliver 时必填 receipt_path。\n' +
            'diagram_deliver 的价值就在于它落了一份**交付收据**（含模块 fingerprint、规格 sha256、产物 sha256、' +
            '所用命令与版本）—— 没有收据就没法事后回答"这张图基于哪一版结构数据、当时校验过没有"。\n' +
            '如果确实没走它，请把 produced_by 改成 self-provided 并标注 degraded=true + 原因。',
        )
      }
      if (degraded === true) {
        errors.push('produced_by=diagram_deliver 与 degraded=true 自相矛盾：走了闸门就不算降级。')
      }
    } else if (by === 'self-provided') {
      if (degraded !== true) {
        errors.push(
          'produced_by=self-provided 时 degraded 必须是 true。\n' +
            '★ 这条是刻意的：没走 diagram_deliver 就没有闸门、没有收据，那必须在交接物上**明确标出来**，' +
            '不能让下游（测试/审核/主对话）误以为这张图过了 normify 校验与组件映射闸门。',
        )
      }
      if (typeof normalized.degraded_reason !== 'string' || normalized.degraded_reason.trim().length === 0) {
        errors.push('degraded=true 时必须给 degraded_reason（为什么降级 —— 例如"dsh-archigate 未安装"）。')
      }
    }

    if (Array.isArray(normalized.covered_modules) && normalized.covered_modules.length === 0 && !degraded) {
      errors.push('covered_modules 为空 —— 一张不覆盖任何模块的"架构图"没有交付价值（降级产出可以放宽，请标 degraded=true）。')
    }
    if (typeof normalized.notes !== 'undefined') normalized.notes = toStringArray(normalized.notes)
  }

  // --- 跨字段约束 ---------------------------------------------------------
  if (kind === 'review_verdict') {
    if (normalized.conclusion === 'NG') {
      if (typeof normalized.reject_to !== 'string' || normalized.reject_to === 'none') {
        errors.push('审核结论为 NG 时，字段「reject_to」必须明确打回给 writer 或 tester（不能在 NG 的同时不定去向）')
      }
      if (typeof normalized.reject_reason !== 'string' || normalized.reject_reason.trim().length === 0) {
        errors.push('审核结论为 NG 时，字段「reject_reason」必填')
      }
    }
    if (normalized.conclusion === 'NG' && normalized.release_approved === true) {
      errors.push('审核结论为 NG 时，「release_approved」不能是 true（自相矛盾）')
    }
    if (normalized.conclusion === 'OK' && normalized.release_approved !== true) {
      errors.push('审核结论为 OK 时，「release_approved」必须是 true（OK 即放行）')
    }
  }
  if (kind === 'test_to_review') {
    if (normalized.verdict === 'fail') {
      errors.push('测试结论为 fail 的交接物不能提交审核；请改用 pipeline_rework（打回编写），或把 verdict 改成 pass 并附通过证据。')
    }
    if (normalized.verdict === 'pass' && Array.isArray(normalized.pass_evidence) && normalized.pass_evidence.length === 0) {
      errors.push('测试结论为 pass 时必须给出「通过证据」（pass_evidence）')
    }
  }
  if (kind === 'orchestration' && normalized.ai_count !== undefined && normalized.ai_count < 4) {
    errors.push(`ai_count=${normalized.ai_count} 少于硬性下限 4（最少 4 个独立对话：主/编写/测试/审核）`)
  }
  if (kind === 'orchestration' && Array.isArray(normalized.roles)) {
    for (const r of ['writer', 'tester', 'reviewer']) {
      if (!normalized.roles.includes(r)) errors.push(`角色清单缺少三权分立角色「${r}」，不能通过`)
    }
  }

  // --- ★人工介入请求 -------------------------------------------------------
  if (kind === 'human_request') {
    // ① 给用户看的文本必须是**人话**：主对话不读代码，含代码它转告不了。
    for (const field of ['question_for_human', 'context_for_human']) {
      const text = normalized[field]
      if (typeof text !== 'string') continue
      const hit = detectCodeInHumanText(text)
      if (hit !== null) {
        errors.push(
          `字段「${field}」里混进了代码（${hit}）。\n` +
            '这个字段是**给用户看的人话** —— 主对话不读代码、也转告不了代码。\n' +
            '请把它改写成纯中文/纯英文的说明；需要保留技术细节就放到别的字段里，' +
            '或者交给主对话的 pipeline_status 脱敏摘要去呈现。',
        )
      }
      if (text.length > HUMAN_TEXT_MAX) {
        errors.push(`字段「${field}」${text.length} 字符，超过 ${HUMAN_TEXT_MAX} 上限 —— 给用户看的内容要短到能一眼读完`)
      }
    }
    // ② 它得真是个问句
    if (typeof normalized.question_for_human === 'string' && !looksLikeQuestion(normalized.question_for_human)) {
      errors.push(
        '字段「question_for_human」里没有问号 —— 用户看完不知道该回答什么。\n' +
          '请把要问的事写成一个明确的问句（是/否、选哪个、还是给一段说明）。',
      )
    }
    // ③ 阻塞就得说清卡在哪
    if (normalized.blocking === true && (typeof normalized.blocked_stage !== 'string' || normalized.blocked_stage.trim().length === 0)) {
      errors.push('blocking=true 时必须给 blocked_stage（卡在哪一步），否则主对话没法告诉用户"现在停在哪"')
    }
    // ④ 选项类答复必须有方案
    if (normalized.decision_kind === 'choose_option') {
      if (!Array.isArray(normalized.options) || normalized.options.length < 2) {
        errors.push('decision_kind=choose_option 时至少要给 2 个 options（一个"选项"不构成选择）')
      }
    }
    // ⑤ 建议必须是选项之一（避免"我建议选 C"，而 C 不在选项里）
    if (typeof normalized.recommended === 'string' && normalized.recommended.trim().length > 0) {
      const labels = Array.isArray(normalized.options) ? normalized.options.map((o) => String(o?.label ?? '').trim()) : []
      if (labels.length > 0 && !labels.includes(normalized.recommended.trim())) {
        errors.push(`recommended=「${normalized.recommended}」不在 options 的 label 里。建议必须是你自己给出的选项之一，否则用户没法照着选。`)
      }
    }
    // ⑥ 默认继续就必须说清默认是哪个
    if (normalized.timeout_behavior === 'proceed_with_default') {
      const d = typeof normalized.default_option === 'string' ? normalized.default_option.trim() : ''
      if (d.length === 0) {
        errors.push('timeout_behavior=proceed_with_default 时必须给 default_option（没人回应时按哪个走）')
      } else {
        const labels = Array.isArray(normalized.options) ? normalized.options.map((o) => String(o?.label ?? '').trim()) : []
        const okYesNo = normalized.decision_kind === 'yes_no' || normalized.decision_kind === 'approve_reject'
        if (labels.length > 0 && !labels.includes(d) && !(okYesNo && ['yes', 'no', 'approve', 'reject', '是', '否', '批准', '驳回'].includes(d))) {
          errors.push(`default_option=「${d}」既不在 options 的 label 里，也不是 yes/no 类答复的取值。`)
        }
      }
    }
    // ⑦ 每个 option 要有 label + consequence（只有 label 的话用户不知道代价）
    if (Array.isArray(normalized.options)) {
      normalized.options.forEach((o, i) => {
        const label = typeof o?.label === 'string' ? o.label.trim() : ''
        const cons = typeof o?.consequence === 'string' ? o.consequence.trim() : ''
        if (label.length === 0) errors.push(`options[${i}] 缺 label`)
        if (cons.length === 0) errors.push(`options[${i}] 缺 consequence（选了它会怎样）`)
        if (cons.length > 0) {
          const hit = detectCodeInHumanText(cons)
          if (hit !== null) errors.push(`options[${i}].consequence 里混进了代码（${hit}）`)
        }
      })
    }
  }

  return { ok: errors.length === 0, errors, normalized }
}

/**
 * 把一份交接物包装成可落盘的记录（带 id、时间、来源、内容哈希）。
 *
 * @param {object} input
 * @param {string} input.kind
 * @param {string} input.taskId
 * @param {string} input.fromRole
 * @param {string} input.toRole
 * @param {object} input.payload
 * @param {string} [input.artifactVersion]
 * @param {string} [input.seq]
 * @returns {object}
 */
export function buildHandoffRecord(input) {
  const payload = input.payload ?? {}
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  return {
    // ⚠️ 哈希必须带**序号**与**毫秒**：光靠"秒级时间戳 + payload"会让
    //    "同一秒内提交两份内容完全相同的交接物"撞成同一个 id
    //    （两级升级梯里"同一个问题问第二遍"正好就是这样）。
    handoff_id: `H-${shortHash(`${input.kind}|${input.taskId}|${input.seq ?? 0}|${new Date().toISOString()}|${JSON.stringify(payload).slice(0, 200)}`)}`,
    task_id: input.taskId,
    kind: input.kind,
    kind_zh: HANDOFF_SCHEMAS[input.kind]?.zh ?? input.kind,
    from_role: input.fromRole,
    to_role: input.toRole,
    created_at: stamp,
    artifact_version: input.artifactVersion ?? payload.artifact_version ?? null,
    payload,
    /** 内容的稳定哈希：用于"审核的是不是同一个版本"这类判定。 */
    content_hash: shortHash(JSON.stringify(payload)),
  }
}

/**
 * 生成给主对话看的**脱敏摘要**。
 *
 * ★ 这是「主对话与代码正文隔离」的落地手段之一：主对话在 pipeline_status 里
 *   拿到的是摘要，不是 patch 正文。真正的隔离仍然依赖守门（主对话读源码文件
 *   会被拦），这里做的是"默认不给"。
 *
 * @param {object} record
 * @param {number} [maxText]
 * @returns {object}
 */
export function summarizeHandoff(record, maxText = 400) {
  const redactedFields = new Set(['patch_or_code', 'failure_logs', 'run_commands'])
  const out = {
    handoff_id: record.handoff_id,
    kind: record.kind,
    kind_zh: record.kind_zh,
    from_role: record.from_role,
    to_role: record.to_role,
    created_at: record.created_at,
    artifact_version: record.artifact_version,
    summary: {},
    redacted: [...redactedFields].filter((f) => Object.hasOwn(record.payload ?? {}, f)),
  }
  for (const [k, v] of Object.entries(record.payload ?? {})) {
    if (redactedFields.has(k)) {
      const len = typeof v === 'string' ? v.length : Array.isArray(v) ? v.length : 0
      out.summary[k] = `«已隐去正文：${len} ${typeof v === 'string' ? '字符' : '条'}»`
      continue
    }
    if (typeof v === 'string') out.summary[k] = clamp(v, maxText)
    else if (Array.isArray(v)) out.summary[k] = v.map((x) => clamp(x, 200))
    else out.summary[k] = v
  }
  return out
}

/** 生成一个默认的任务 id（供测试与示例用）。 */
export function makeTaskId() {
  return newTaskId()
}
