/**
 * dsh-pipeline · 交接物 · 字段枚举与授权面校验
 * ============================================================================
 * 从 `lib/handoff.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/handoff.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/handoff/fields
 */

import { isInside, toStringArray } from '../util.js'

/** 字段类型 DSL：'string' | 'text' | 'string[]' | 'object[]' | 'number' | 'boolean' | 'object' | 'enum'。 */
export const F = (type, zh, opts = {}) => ({ type, zh, ...opts })

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
export const HUMAN_TEXT_MAX = 600

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
