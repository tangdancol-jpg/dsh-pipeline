/**
 * dsh-pipeline · 交接物 · 内容扫描与站点确认
 * ============================================================================
 * 从 `lib/handoff.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/handoff.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/handoff/scans
 */

import { toStringArray } from '../util.js'
import { hubConfirmersOf } from '../states.js'
import { detectCodeInHumanText } from './fields.js'

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
