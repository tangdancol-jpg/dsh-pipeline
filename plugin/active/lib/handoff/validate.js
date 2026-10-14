/**
 * dsh-pipeline · 交接物 · 校验
 * ============================================================================
 * 从 `lib/handoff.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/handoff.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/handoff/validate
 */

import { toStringArray } from '../util.js'
import { looksLikeRawSecret } from '../security.js'
import { validateSeatHandover } from '../context.js'
import {
  detectCodeInHumanText,
  looksLikeQuestion,
  HUMAN_TEXT_MAX,
  CHANGE_ACTIONS,
  validateRoleScope,
  validateChangeScope,
  validateRoleBoundaries,
} from './fields.js'
import {
  scanRequirementAnalysisForAllocation,
  TEST_VERDICT_FIELDS,
  scanControlRoleProductForCode,
  validateStationConfirm,
  validatePrebrief,
} from './scans.js'
import { HANDOFF_SCHEMAS } from './schemas.js'

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
