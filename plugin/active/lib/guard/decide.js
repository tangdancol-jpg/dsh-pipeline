/**
 * dsh-pipeline · 守门 · 主判定
 * ============================================================================
 * 从 `lib/guard.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/guard.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/guard/decide
 */

import { existsSync } from 'node:fs'
import { isInside } from '../util.js'
import {
  TAG,
  DEFAULT_WRITE_TOOLS,
  DEFAULT_READ_TOOLS,
  PIPELINE_TOOL_PREFIX,
  OWN_DIR_EXTS,
  OWN_LOG_EXTS,
  writeClassOf,
  checkOwnPath,
  DEFAULT_SEARCH_TOOLS,
  NO_CODE_READ_ROLES,
  codeReadRefusal,
  roleZh,
  collectCommandStrings,
  isShellToolName,
  PIPELINE_TOOL_ROLES,
  HANDOFF_DIRECTION,
} from './rules.js'
import { scanCommandWithScripts } from './scripts.js'
import { collectTargets, targetLine } from './targets.js'
// ★★ 用户第 1 件（2026-10-16）：**能力额度闸**。
//    「平常不许用 / 必要时应先向用户申请 / 批准后只放行一次」三句话全在
//    `capability-gate.js` 里（分类 → 台账 → 消耗一次性额度）；本文件只留**接线**。
//    ⚠ 它**不覆盖** shell 内容判据（§4）与授权面判据（§3a）：
//      那两条不是"一种能力"，是边界集合（见 `capability.js` 文件头）。
import { CAPABILITY, createCapabilityGate } from './capability-gate.js'
// ★★ Agent Teams 深度整合（`design/agent-teams/01-目标与边界.md` §D8）：
//    官方新工具面（team 协作 / 委派 / 插件管理 / 会话搜索）的分类名单 —— **唯一出处**
//    `official-tools.js`。本文件只用它判定"绑定角色能不能调这个工具"，不另抄名单。
import { officialOutsideRole, officialRefusalText } from './official-tools.js'
import {
  makeTaskOf,
  agentIdOf,
  bindingForAgent,
  owningSeat,
  describeSeat,
  describePartitions,
  describeChangeScope,
  hubStandbyBlocksWrite,
  owningChangeScopeEntry,
} from './seats.js'
// ★ 判据码常量 + 「允许写的位置」那一行 —— **唯一出处** `lib/errors/`
//   （与 `page-exts.js` 的 `ownPathHint()` 共用同一句，两边不会再各自润色）。
import { HUB_STANDBY_NOT_WOKEN } from '../errors/codes.js'
import { ownPathLine } from '../errors/text.js'

/**
 * 守门的判据本体。**必须同步**（`guardReason` 是同步遍历），且**必须不抛**。
 *
 * @param {object} exec - DSH 的 ToolExecution：`{ name, arguments, agent }`。
 * @param {object} deps
 * @param {ReturnType<import('./tokens.js').createTokenStore>} deps.tokens
 * @param {{get:(taskId:string)=>object|null}} deps.taskIndex - 同步任务索引（项目根/报告目录）
 * @param {object} [deps.config]
 * @returns {string|undefined} 返回字符串 = 拒绝理由；`undefined` = 放行。
 */
export function guardDecision(exec, deps) {
  try {
    return decide(exec, deps)
  } catch (err) {
    // ★ fail-closed：守门自身出问题时不静默放行。
    return (
      `${TAG} 守门内部异常，按 fail-closed 拒绝本次调用（这不是模型的问题，是插件 bug）。\n` +
      `工具：${String(exec?.name ?? '(未知)')}\n异常：${String(err?.message ?? err)}`
    )
  }
}

function decide(exec, deps) {
  const name = typeof exec?.name === 'string' ? exec.name : ''
  if (name.length === 0) return undefined

  /** ★ 继任后退休的会话 id 集合（同步可查）。 */
  const retired = deps?.retired ?? null

  const taskOf = makeTaskOf({ deps, tool: name, bindingOf: () => binding })
  const cfg = deps?.config ?? {}
  const tokens = deps?.tokens
  if (tokens === undefined) return undefined

  const agentId = agentIdOf(exec)
  const args = exec?.arguments

  // --- 0) 该调用是否"流水线相关" ------------------------------------------
  const isPipelineTool = name.startsWith(PIPELINE_TOOL_PREFIX)

  // ★ 已退休的席位（继任之后）：令牌已撤销，所以 `roleOfAgent` 找不到它 ——
  //   那会让守门把它当成"与流水线无关的会话"直接放行（这是个真陷阱）。
  //   所以退休名单单独查，且**排在所有放行分支之前**。
  if (retired !== null && agentId !== null && retired.has(agentId)) {
    return (
      `${TAG} 拒绝：本会话所属的席位已经**继任换班**了（它的令牌已撤销）。\n` +
      `工具：${name}\n会话：${agentId}\n` +
      '★ 继任是**换班** —— 工作由新席位接着做，旧席位不得再写、不得再提交、不得再推进。\n' +
      '为什么这条要单独判：令牌撤销之后角色绑定就没了，普通判据会把它当成"无关会话"放行。\n' +
      '如果你是**新席位**：请用主对话在 pipeline_succession 返回里给你的那枚新令牌。'
    )
  }
  // ★ 绑着多张单时挑"还没结束、最近绑定"的那张（P1-4 的作用域放大，见 bindingForAgent）
  const binding = bindingForAgent(tokens, agentId, deps?.taskIndex ?? null)
  /** ★★ 用户第 1 件：能力额度闸 —— **调用级**（一次调用只消耗一份额度，见 `capability-gate.js`）。 */
  const capGate = createCapabilityGate({ role: binding?.role ?? '', tool: name, cfg: deps?.config ?? {}, task: binding === null ? null : taskOf(binding.taskId) })

  // 非流水线工具、且调用方没有绑定任何角色 → 与流水线无关，直接放行。
  // （守门只约束流水线参与者，绝不去管无关会话 —— 这是与其它插件共存的前提。）
  if (!isPipelineTool && binding === null) return undefined

  // --- 0b) ★★ 官方新工具面：绑定角色（非 main）命中即拒 --------------------
  //
  //   `design/agent-teams/01-目标与边界.md` §D8 第 2 条。为什么这条必须存在：
  //   角色会话在 Team 通道下**继承 Lead 的预设**（官方事实 F2：`spawnTeammate` 走
  //   `composeFrom(parent)`），工具面比原来的 `pl-*` 角色预设宽得多。不拦这三类，
  //   下面这些既有判据全部可以被**绕过**（不是"可能"）：
  //     · 委派类（subagent / workflow / ralph）→ 测试/审核借子代理的手改代码；
  //     · team 协作类（spawn_teammate / send_message / team_task_*）→ 私下拉人、
  //       自己开任务板条目，绕开"结构化交接物 + 状态机"这道唯一交付入口；
  //     · 插件管理类（plugin_manager / plugin_market）→ 直接改运行环境；
  //     · 会话搜索类（session_search / session_*）→ 读别的会话正文，旁路读代码。
  //   ★ 主对话（main）**不拒**：它就是 Lead，team 协作类是它的本职（派活/投消息/
  //     任务板镜像都靠它）。名单的这层口径写在 `official-tools.js` 里，不在本文件。
  //   ★ 未绑定角色的会话照旧放行（上面那行已经返回）—— 守门只约束流水线参与者。
  if (!isPipelineTool && binding !== null) {
    const category = officialOutsideRole(binding.role, name)
    // ★ 拒绝原文的**唯一出处在 `official-tools.js`**（与名单同源：名单加一个工具，
    //   文案里那条类别说明自然覆盖它，不会出现"名单拦住了、文案还在讲别的理由"）。
    if (category !== null) return officialRefusalText(name, binding.role, category, { roleLabel: roleZh(binding.role), tag: TAG })
  }

  // --- 1) 流水线工具的角色白名单（pre-dispatch 早拦）---------------------
  if (isPipelineTool) {
    // 1a) 交接物的**方向**在守门层就判一次：编写不能直接把产物交给审核。
    //     这条判据在 execute 里还有一份（同源），这里提前拦是为了让拒绝发生在
    //     dispatch 之前 —— 参数校验、落盘都不会发生。
    if (name === 'pipeline_handoff') {
      const kind = typeof args?.kind === 'string' ? args.kind : ''
      const direction = HANDOFF_DIRECTION[kind]
      if (direction !== undefined) {
        let role = binding?.role ?? null
        const declared = typeof args?.role_token === 'string' ? args.role_token : ''
        if (declared.length > 0) {
          const r = tokens.resolve(declared, { taskId: typeof args?.task_id === 'string' ? args.task_id : undefined })
          if (!r.ok) return `${TAG} ${r.error}`
          role = r.rec.role
        }
        if (role !== null && !direction.includes(role)) {
          const isTestProduct = kind === 'test_to_review' || kind === 'test_to_dev'
          return (
            `${TAG} 角色越权被拦下（交接物方向）。\n` +
            `交接物：${kind}\n允许产出该交接物的角色：${direction.join(' / ')}\n当前角色：${role}\n` +
            (kind === 'review_verdict'
              ? '原因：★ 编写角色不能直接把产物提交审核。编写的产物只能先交测试（dev_to_test）；\n' +
                '由测试独立验证、产出 test_to_review 之后，审核才介入。这是三权分立的核心一条。'
              : kind === 'human_request'
                ? '原因：★ 主对话不产出人工介入请求。用户的对话框就在主对话里 —— 它需要人拍板时直接问即可，\n' +
                  '不需要"发起请求给自己"这一圈。人工介入请求是**执行/顾问角色**向上发起用的。'
                : isTestProduct && role === 'writer'
                  ? '原因：★ **编写不跑测试** —— 用例、执行结果、通过证据、失败日志、测试结论\n' +
                    '全部是 `tester` 的产物，编写的白名单里**压根没有**这一类型。\n' +
                    '  一个既写实现又自己判"通过"的角色，会把测试写成"刚好证明我对"的样子 ——\n' +
                    '  那不是独立验证，是自证。所以这条边界不是文案，是**能力边界**。\n' +
                    '  你要交的是 dev_to_test（补丁 + 变更说明 + 运行命令 + 自测结果 + 已知问题）。\n' +
                    '（设计目的：防过度工程化 —— 每个 AI 只干自己该干的。）'
                  : '原因：交接物的方向由类型固定，不能自选。')
          )
        }
      }
    }

    // 1b) 人工介入的发起方向：**只有非 main** 能发起。
    //     这条与上面那张方向表互补：表管"哪种交接物谁能产出"，这里管"这个工具谁不能调"。
    if (name === 'pipeline_human_request') {
      let role = binding?.role ?? null
      const declared = typeof args?.role_token === 'string' ? args.role_token : ''
      if (declared.length > 0) {
        const r = tokens.resolve(declared, { taskId: typeof args?.task_id === 'string' ? args.task_id : undefined })
        if (!r.ok) return `${TAG} ${r.error}`
        role = r.rec.role
      }
      if (role === 'main') {
        return (
          `${TAG} 主对话不能发起人工介入请求。\n` +
          '原因：用户的对话框**就在主对话里** —— 你要问用户，直接在会话里问就行了，\n' +
          '不需要走"发起请求 → 自己转告 → 等自己答复"这一圈。\n' +
          '这个工具是给**执行/顾问角色**用的：它们没有用户的对话框，只能把问题交给你。\n' +
          '如果你收到别的角色用 pipeline_human_request 提交的请求，用 pipeline_human_relay 转告用户，' +
          '再用 pipeline_human_reply 记答复。'
        )
      }
      if (role === null) {
        return (
          `${TAG} 拒绝：发起人工介入请求必须能确定发起角色。\n` +
          '本会话既没有绑定角色，也没有携带 role_token。请先 pipeline_bind_role 认领角色。'
        )
      }
    }

    const allowed = Object.hasOwn(PIPELINE_TOOL_ROLES, name) ? PIPELINE_TOOL_ROLES[name] : undefined
    if (allowed === null || allowed === undefined) return undefined // 交给 execute 内部判
    // 有令牌的以令牌角色为准；没有令牌但会话已绑定的以绑定为准。
    const declared = typeof args?.role_token === 'string' ? args.role_token : ''
    let role = binding?.role ?? null
    if (declared.length > 0) {
      const r = tokens.resolve(declared, { taskId: typeof args?.task_id === 'string' ? args.task_id : undefined })
      if (!r.ok) return `${TAG} ${r.error}`
      role = r.rec.role
    }
    if (role === null) {
      return (
        `${TAG} 拒绝：流水线工具的调用方身份无法确定。\n` +
        `工具：${name}\n允许角色：${allowed.join(' / ')}\n` +
        '本会话既没有绑定任何角色，也没有携带 role_token。\n' +
        '请二选一：① 由主对话用 pipeline_dispatch 派活拿到令牌（派活单里会带）；' +
        '② 本会话调用 pipeline_bind_role 认领角色。\n' +
        '★ 流水线的每个动作都必须能回答"你是谁" —— 身份不明即拒绝。'
      )
    }
    if (!allowed.includes(role)) {
      return (
        `${TAG} 角色越权被拦下。\n工具：${name}\n允许角色：${allowed.join(' / ')}\n当前角色：${role}\n` +
        (name === 'pipeline_close'
          ? '原因：关单是主对话的独占动作，且必须已存在审核 OK。'
          : name === 'pipeline_dispatch'
            ? '原因：派活是主对话的独占动作 —— 主对话按编排给出的角色清单调用，别人不代劳。'
            : name === 'pipeline_roster_review'
              ? '原因：角色增减必须由「计划 AI」复核（加人减人 = 改角色清单 = 分配），主对话与执行角色都不能自己批。'
              : '原因：本工具被限定给上列角色。')
      )
    }
    return undefined
  }

  // --- 2) 文件写工具：测试/审核不得改代码 ---------------------------------
  const writeTools = Array.isArray(cfg.guardFileTools?.write) && cfg.guardFileTools.write.length > 0 ? cfg.guardFileTools.write : DEFAULT_WRITE_TOOLS
  const readTools = Array.isArray(cfg.guardFileTools?.read) && cfg.guardFileTools.read.length > 0 ? cfg.guardFileTools.read : DEFAULT_READ_TOOLS

  // --- 2a) ★只读角色 / 只写自己那一片的角色：按**能力**拦，不按 summary 拦 ----
  //
  //   用户原话：「**测试 ai 等同理，没有权限动文件的就只能只读**；
  //             总的来说 **ai 的行为不要靠自然语言限制，要靠代码层直接拦截**」。
  //
  //   与 2) 的关系：2) 说的是"非编写角色不得改项目源码"（还允许写 reports/）；
  //   这一条把每个角色**实际能写哪**按 `writeClassOf` 判死：
  //     · readonly（主对话 / 需求分析 / 计划）—— **一字节都不许写**（含 reports/）；
  //     · none（主管：真只读，但不进控制三角那两张对外名单）—— **同样一字节都不许写**；
  //     · own-dir（测试 / 架构 / 安全 / 留档 / 架构图 / 发布 / 文档 / 性能 / 仲裁）
  //       —— 只写 `<任务>/reports/<role>/<role>*.<ext>`；
  //     · own-log（审核）—— 同上但**只有日志扩展名**。
  if (writeTools.includes(name) && binding !== null) {
    const cls = writeClassOf(binding.role)
    if (cls === 'readonly' || cls === 'none' || cls === 'own-dir' || cls === 'own-log') {
      const task = taskOf(binding.taskId)
      if (task !== null) {
        const targets = collectTargets(args, task.projectRoot).filter((t) => t.path.length > 0)
        /** ★ 本次调用的**全部**目标（额度必须覆盖它们全部才放行，见 `tryRelease` 的 ④）。 */
        const writeTargets = targets.map((t) => t.path)
        for (const t of targets) {
          const p = t.path
          if (!isInside(task.projectRoot, p)) continue // 项目外不归本插件管
          if (cls === 'readonly' || cls === 'none') {
            if (capGate.take(CAPABILITY.WRITE_FILE, writeTargets)) continue // 用户第 1 件：已批准 ⇒ 放行一次
            return (
              `${TAG} 拒绝：角色「${roleZh(binding.role)}」**只读** —— 它没有任何写文件的权限。\n` +
              `工具：${name}\n${targetLine(t)}\n任务：${binding.taskId}\n` +
              '★ 为什么连 reports/ 也不给：它的产物是**结构化交接物**（由 pipeline_* 工具落盘），\n' +
              '  不需要也不该动文件。用户的原则是：**行为不靠自然语言限制，靠代码层直接拦截** ——\n' +
              '  所以"只读"不是写在角色卡里的一句话，是这里的一条判据。\n' +
              '要把结论交出去：用 pipeline_handoff（结构化交接物）或对应的 pipeline_* 工具。'
            )
          }
          const chk = checkOwnPath(p, task, binding.role, cls)
          if (chk.ok !== true) {
            const dir = `${task.taskSelfDir}/reports/${binding.role}/`
            return (
              `${TAG} 拒绝：角色「${roleZh(binding.role)}」只能写**自己那一片**。\n` +
              `工具：${name}\n${targetLine(t)}\n任务：${binding.taskId}\n` +
              `原因：${chk.why}\n` +
              `${ownPathLine(dir, binding.role, cls === 'own-log' ? OWN_LOG_EXTS.join('|') : OWN_DIR_EXTS.join('|'))}\n` +
              '★ 这条按**路径**判，不按角色卡里的措辞判 ——\n' +
              '  谁能写哪由代码层的 `writes` 决定，文档只是把它写清楚。\n' +
              '  要交结论：用结构化交接物（pipeline_handoff）；要让别人看到东西：交给你该交给的那个角色。'
            )
          }
          /**
           * ★★ **待机期的产物面判据（第 2 条：文件面）** —— T-20261011-56a37e。
           *
           * 安全预审阻断项 B3 的原话：「待机必须落**产物面三条判据**（交接物 / own-dir 写入 /
           * 测试执行），缺任一条 ⇒ 验收 3、4 不通过」。这是**第 2 条**。
           *
           * 为什么 own-dir 也算"产物"：待机位写自己目录的报告，等于**已经开过工**了 ——
           * 而用户口径③要的是"**压根没产出**"，不是"产物被藏起来"。
           * 位置排在路径判据**之后**：先把"你写错地方了"说清楚，再说"你还没到点"。
           */
          const standby = hubStandbyBlocksWrite(task, binding.role)
          if (standby.blocked === true) {
            const wp = standby.wake_point
            return (
              `${TAG} 拒绝：席位「${roleZh(binding.role)}」现在处于**已登记待机**，还没到唤醒点 —— 写自己目录的报告也算开工。\n` +
              `工具：${name}\n${targetLine(t)}\n任务：${binding.taskId}\n` +
              `唤醒点：**${wp === 'need_agree' ? '主管同意需求结论' : '主管确认架构图满足要求'}**（${wp}）\n` +
              '★ 用户口径③：「待机」是**可见的「已登记未开工」** —— 而未到点不得开工是**产物面**的判据：\n' +
              `  ① 交产物      ⇒ store 的交接物状态判据拒（${HUB_STANDBY_NOT_WOKEN}）；\n` +
              '  ② 写自己目录  ⇒ **就是这一条**；\n' +
              '  ③ 跑测试      ⇒ 同文件里"编写交付之前不许开跑"那一条。\n' +
              '  三条同源、同一份数据（task.hub.standby）。\n' +
              '下一步：等主管在**到点**之后唤醒（pipeline_supervise）。'
            )
          }
        }
      }
    }
  }

  // --- 2) 文件写工具：测试/审核不得改代码 ---------------------------------
  if (writeTools.includes(name) && binding !== null) {
    const task = taskOf(binding.taskId)
    if (task !== null && binding.role !== 'writer' && binding.role !== 'human') {
      const cwd = task.projectRoot
      const targets = collectTargets(args, cwd)
      const writeTargets = targets.map((t) => t.path).filter((p) => p.length > 0)
      for (const t of targets) {
        const p = t.path
        if (p.length === 0) continue
        if (!isInside(task.projectRoot, p)) continue
        if (isInside(task.reportsDir, p)) continue // 报告目录是允许的
        if (capGate.take(CAPABILITY.WRITE_FILE, writeTargets)) continue // 用户第 1 件：已批准 ⇒ 放行一次
        return (
          `${TAG} 拒绝：角色「${binding.role}」不得修改项目源码制品。\n` +
          `工具：${name}\n${targetLine(t)}\n任务：${binding.taskId}（受保护根：${task.projectRoot}）\n` +
          `允许写入的位置只有本任务的报告目录：${task.reportsDir}\n` +
          '原因：编写/测试/审核三权分立 —— 测试与审核**不得替编写改代码**（改了就没有独立验证了）。\n' +
          '如果你发现了缺陷，请用 pipeline_handoff（test_to_dev）或 pipeline_rework 把问题打回编写，由编写角色修改。'
        )
      }
    }

    // --- 2a2) ★分权落档（更正 A）--------------------------------------------
    //
    //   两条规矩：
    //     ① `requirement.md` / `.json` / 版本索引 —— **只有留档 AI（archivist）能写**。
    //        （上一轮是"需求分析独占写权"，那条**已作废**：现在是分权写 + 专人汇总。）
    //     ② `records/<role>[-<seat>].{md,json}` —— 各写各的，且**只能写自己那份**。
    if (writeTools.includes(name) && binding !== null) {
      const task = taskOf(binding.taskId)
      if (task !== null) {
        const targets = collectTargets(args, task.projectRoot)
        const root = `${String(task.pipelineDir).toLowerCase()}/${String(task.taskId).toLowerCase()}`
        const recordsDir = `${root}/records/`
        for (const t of targets) {
          const p = t.path
          if (p.length === 0 || !isInside(root, p)) continue
          const base = p.slice(p.lastIndexOf('/') + 1)

          // ② records/：只能写自己那份
          if (p.startsWith(recordsDir)) {
            const expectName = `${binding.role}${binding.seat ? `-${String(binding.seat).replace(/#/g, '')}` : ''}.md`
            const stem = base.replace(/\.(md|json)$/i, '')
            const mine = stem === String(binding.role) ||
              stem === `${binding.role}-${String(binding.seat ?? '').replace(/#/g, '')}`
            if (!mine) {
              return (
                `${TAG} 拒绝：**只能写自己那份记录**。\n` +
                `工具：${name}\n${targetLine(t)}\n` +
                `你的身份：${binding.role}${binding.seat ? ` / ${binding.seat}` : ''}　→ 你那份应该叫 ${expectName}\n` +
                '★ 记录的价值全在「这是谁说的」—— 写别人的记录等于伪造来源。\n' +
                '  需要别人补内容 → 让它自己写（pipeline_record_submit），或由留档 AI 去问它。'
              )
            }
            continue
          }

          // ① requirement.*：只有留档 AI
          if (!base.startsWith('requirement.')) continue
          if (binding.role === 'archivist') continue
          return (
            `${TAG} 拒绝：**需求档只有留档 AI（archivist）能写**，你是「${binding.role}」。\n` +
            `工具：${name}\n${targetLine(t)}\n` +
            '★ 需求档是**权威需求快照** —— 所有角色默认以它为准。\n' +
            '  现在它是**分权写 + 专人汇总**出来的：各角色在 records/ 下写自己那份，\n' +
            '  留档 AI 收集后统一编写成这一个文件（每条内容都标了来源，可逐条追溯）。\n' +
            '★ 你要补内容 → 用 pipeline_record_submit 写**自己那份**记录，留档 AI 会汇总进去。\n' +
            '  只是**读**需求 → 直接读 .pipeline/<任务id>/requirement.md 就行（只读不受限制）。'
          )
        }
      }
    }

    // --- 2b) ★编写席位的分区边界 ------------------------------------------
    //
    // 每个 `writer#k` 只能写自己那段范围。写到别人的分区、或写到分区之外 → 拒。
    //
    // 单席位（count=1）时范围是整棵项目根 ⇒ 本判据恒真，与旧行为**完全等价**
    // —— 这就是"count=1 是同一套机制的退化情形"在守门层的体现。
    if (writeTools.includes(name) && binding !== null && binding.role === 'writer') {
      const task = taskOf(binding.taskId)
      const writers = task?.writers ?? null
      const seat = binding.seat ?? 'writer#1'
      if (task !== null && writers !== null) {
        const parts = Array.isArray(writers.partitions) ? writers.partitions : []
        if (parts.length > 0) {
          const targets = collectTargets(args, task.projectRoot)
          for (const t of targets) {
            const p = t.path
            if (p.length === 0) continue
            if (!isInside(task.projectRoot, p)) continue
            // ★ 分区约束管的是**项目源码**；流水线自己的台账（task.json / handoffs /
            //   artifacts / reports / records）不属于任何席位的"那一段"。
            //   `records/` 尤其重要：那是"各写各的落档"，把席位挡在外面等于让分权落档没法用。
            if (task.taskSelfDir !== undefined && task.taskSelfDir !== null && isInside(task.taskSelfDir, p)) continue
            if (isInside(task.reportsDir, p)) continue
            const owner = owningSeat(parts, p, task.scopeAnchor, task.projectRoot)
            if (owner === null) {
              return (
                `${TAG} 拒绝：写入位置不在任何编写席位的分区里。\n` +
                `工具：${name}\n${targetLine(t)}\n你是：${seat}\n` +
                `在册分区：\n${describePartitions(parts, task.projectRoot)}\n` +
                '原因：编写已被拆成多个席位，每个人只写自己那一段 —— 写到分区外等于越过了编排划的界。\n' +
                '要改范围请走 pipeline_roster_request（提出）→ pipeline_roster_review（编排复核），' +
                '主对话与你自己都不能改分区。'
              )
            }
            if (owner.seat !== seat) {
              return (
                `${TAG} 拒绝：越界写入别人的分区。\n` +
                `工具：${name}\n${targetLine(t)}\n你是：${seat}（范围：${describeSeat(parts, seat, task.projectRoot)}）\n` +
                `该路径属于：${owner.seat}（范围：${describeSeat(parts, owner.seat, task.projectRoot)}，命中「${owner.matched}」）\n` +
                '原因：编排把编写拆成了多个席位，各自范围**互不重叠** —— 那正是分区的意义。\n' +
                '如果你认为某处应该由你改，请让编排复核后重新划界（pipeline_roster_request → pipeline_roster_review），' +
                '不要直接动手。\n' +
                (owner.overlaps.length > 0
                  ? `⚠ 另外：这条路径同时命中 ${owner.overlaps.join('、')} —— 分区表疑似有重叠（编排层本应拦下）。`
                  : '')
              )
            }
          }
        }
      }
    }
  }

  // --- 2c) ★设计目的：**最小改动**（改动面必须与授权面相等）----------------
  //
  //   用户原话：「修一个 bug 就别该整个模块」。
  //
  //   它与 2b（席位分区 `scope_paths`）是**两层**、**同时**生效：
  //     · `scope_paths` = "你负责哪一块"（长期边界，按层/分区）
  //     · `change_scope`= "这次任务允许你动哪些文件"（本次授权面）
  //   写入必须**同时**满足两者 —— 这是"越写越严"的正确方向，不是二选一。
  //
  //   三条判据：
  //     ① 路径必须命中某条授权（`owningChangeScopeEntry`）；
  //     ② 该授权条目的 `action` 必须与实际动作相符 —— **新增文件也算越界**，
  //        要新建就得在计划里显式写 `create`（文件不存在却声明 modify 也会被拦）；
  //     ③ 没有任何授权面（L0）时**弃权**（不是放行，是这段判据不存在 —— 见 README P4）。
  if (writeTools.includes(name) && binding !== null && binding.role === 'writer' && cfg.guardChangeScope !== false) {
    const task = taskOf(binding.taskId)
    const scope = task?.changeScope ?? null
    if (task !== null && Array.isArray(scope) && scope.length > 0) {
      const targets = collectTargets(args, task.projectRoot)
      for (const t of targets) {
        const p = t.path
        if (p.length === 0) continue
        if (!isInside(task.projectRoot, p)) continue
        // 流水线台账不属于改动面（与分区判据同一豁免）
        if (task.taskSelfDir !== undefined && task.taskSelfDir !== null && isInside(task.taskSelfDir, p)) continue
        if (isInside(task.reportsDir, p)) continue
        const hitScope = owningChangeScopeEntry(scope, p, task.scopeAnchor, task.projectRoot)
        if (hitScope === null) {
          return (
            `${TAG} 拒绝：**改动面超出了授权面**。\n` +
            `工具：${name}\n${targetLine(t)}\n任务：${binding.taskId}\n` +
            `本次授权改动面（计划里给的，箭号后是**锚点解析结果**）：\n${describeChangeScope(scope, task.scopeAnchor, task.projectRoot)}\n` +
            '★ 原则：**改动面必须与授权面相等** —— 多改一行也算越界。\n' +
            '  · **新增文件也算越界**（要新建必须在计划里显式授权 create）；\n' +
            '  · "顺手重构 / 顺手统一风格 / 顺手升级依赖" = **没有授权** ⇒ 不许。\n' +
            '真需要扩大范围（例如 bug 根因在别的模块）→ **不许自作主张扩**：\n' +
            '  走澄清/变更：pipeline_clarify_request 升给需求分析，或 pipeline_roster_request 让计划 AI 重出计划，\n' +
            '  拿到新授权（新的 change_scope）之后再动。'
          )
        }
        // ② 动作是否对得上（`create` 授权只给"新建"，`delete` 授权不给写入）
        //
        //    为什么要判这一条：`action` 是**授权的意图**。
        //      · `modify` = "这个路径可以改"（含在其中新建/删文件 —— 那正是"改这个模块"的含义）
        //      · `create` = **只**授权"新建"；拿它去改一个**已存在**的文件 ⇒ 拦
        //        （那说明编写动的是别的东西，不是计划授权它建的那份）
        //      · `delete` = 授权删除；写成内容不属于它授权的事 ⇒ 拦
        let exists = true
        try {
          exists = existsSync(p)
        } catch {
          exists = true // 判不出来就不判这一条（宁可漏一次，不要误拦）
        }
        if (exists && hitScope.action === 'create') {
          return (
            `${TAG} 拒绝：命中的授权是 create，但这个路径**已经存在**。\n` +
            `工具：${name}\n${targetLine(t)}\n命中的授权：${hitScope.id}（action=create，${hitScope.path}）\n` +
            '★ `create` 只授权"新建这一份"，**不包括改已有文件**。\n' +
            '  两种可能：① 你要改的是已有文件 → 让计划 AI 给你一条 `modify` 授权；' +
            '② 你走错了路径。都不该按"新建"处理。'
          )
        }
        if (hitScope.action === 'delete') {
          return (
            `${TAG} 拒绝：命中的授权是 delete，它只授权**删除**，不授权写入内容。\n` +
            `工具：${name}\n${targetLine(t)}\n命中的授权：${hitScope.id}（${hitScope.path}）\n` +
            '★ 要改内容 → 让计划 AI 给你一条 `modify` 授权。'
          )
        }
      }
    }
  }

  // --- 3) ★文件读工具：控制角色不得读代码正文 ---------------------------
  //
  //   ★ 本轮扩展（设计目的：**编排别看代码**）：
  //     判据从"只判 main"扩成 `NO_CODE_READ_ROLES`（主对话 / 需求分析 / 计划）。
  //     为什么需求分析与计划也算"控制角色"：它们**不实现**，只出任务卡与计划。
  //     一旦读了实现细节，它们就会开始对实现指手画脚（定字段名、选库、加抽象），
  //     而每多一层"不必要的复杂度要求"就是一次过度工程化。
  //
  //   允许读的位置：`.pipeline/` 下的东西（需求档 / 交接物 / 记录 / 脱敏摘要 / 报告）——
  //   那正是它们该看的。判据按**路径**判，不按"读了什么内容"判。
  if (readTools.includes(name) && binding !== null && cfg.guardMainReadsCode !== false) {
    const task = taskOf(binding.taskId)
    if (task !== null && NO_CODE_READ_ROLES.includes(binding.role)) {
      const targets = collectTargets(args, task.projectRoot)
      /** ★ 本次调用的**全部**目标（额度必须覆盖它们全部才放行，见 `tryRelease` 的 ④）。 */
      const readTargets = targets.map((t) => t.path).filter((p) => p.length > 0)
      for (const t of targets) {
        const p = t.path
        if (p.length === 0) continue
        if (!isInside(task.projectRoot, p)) continue
        // ★★ 判据本体已抽到 `rules.js` 的 `codeReadRefusal` —— 长入参通道
        //    （`spec_path` / `payload_path`）用的是**同一个函数**，边界只有一处。
        if (codeReadRefusal(binding.role, task, p) === undefined) continue // 任务卡 / 需求档 / 交接物是它们该看的
        if (capGate.take(CAPABILITY.READ_SOURCE, readTargets)) continue // 用户第 1 件：已批准 ⇒ 放行一次
        return (
          `${TAG} 拒绝：${roleZh(binding.role)}不得读取代码正文。\n` +
          `工具：${name}\n${targetLine(t)}\n任务：${binding.taskId}\n` +
          '原因：' +
          (binding.role === 'main'
            ? '主对话只负责接需求、派活、跟踪状态、关单 —— 不读代码、不做技术判断。\n'
            : `${roleZh(binding.role)}只吃**需求原文 + 需求档 + 脱敏摘要**，不看实现。\n` +
              '  ★ 读了实现就会开始对实现指手画脚（定字段名、选库、加抽象）——\n' +
              '    每多一层"不必要的复杂度要求"，就是一次**过度工程化**。\n') +
          '需要了解进展/需求请用 pipeline_status（返回脱敏摘要），' +
          '或读 .pipeline/<任务id>/ 下的需求档与交接物（那些是允许读的）。'
        )
      }
    }
  }

  // --- 3b) ★检索类工具：控制角色不得用它把代码正文捞回来 -------------------
  //
  //   判据画在"**返回值里有没有代码正文**"上：
  //     · grep / ripgrep / findstr / Select-String / codebase_search —— 返回匹配到的**行** ⇒ 拦
  //     · glob / list_dir / ls / tree —— 只返回**路径名** ⇒ 不拦
  //       （列个文件名不构成"看代码"，拦了反而让计划 AI 做出不合实际的计划。）
  //
  //   检索类工具往往**不给路径**（默认就在整个工作区里搜），所以这里比读工具更严：
  //   只要没有明确限定在 `.pipeline/` 内，就当它会翻到源码树。
  if (binding !== null && cfg.guardMainReadsCode !== false && NO_CODE_READ_ROLES.includes(binding.role)) {
    const searchTools = Array.isArray(cfg.guardFileTools?.search) && cfg.guardFileTools.search.length > 0
      ? cfg.guardFileTools.search
      : DEFAULT_SEARCH_TOOLS
    const isSearch = searchTools.some((t) => String(t).toLowerCase() === name.toLowerCase())
    if (isSearch) {
      const task = taskOf(binding.taskId)
      if (task !== null) {
        const targets = collectTargets(args, task.projectRoot).filter((t) => t.path.length > 0)
        /** ★ 本次调用的**全部**目标（额度必须覆盖它们全部才放行，见 `tryRelease` 的 ④）。 */
        const searchTargets = targets.map((t) => t.path)
        const scopedToPipeline = targets.length > 0 && targets.every((t) => isInside(task.pipelineDir, t.path))
        if (!scopedToPipeline) {
          if (capGate.take(CAPABILITY.SEARCH_SOURCE, searchTargets)) return undefined // 已批准 ⇒ 放行一次
          return (
            `${TAG} 拒绝：${roleZh(binding.role)}不得用检索工具翻源码树。\n` +
            `工具：${name}\n任务：${binding.taskId}\n` +
            (targets.length === 0
              ? '本次调用**没有限定路径** ⇒ 默认范围就是这个工作区的源码树。\n'
              : `目标：${targets.slice(0, 3).map((t) => t.path).join('、')}\n`) +
            '原因：检索工具返回的是**匹配到的代码行** —— 那就是代码正文，与"用 read 读它"没有区别。\n' +
            '★ 这条边界的画法：拦"会吐正文的"检索（grep / findstr / Select-String），' +
            '不拦"只给路径名的"（glob / 列目录）—— 后者不构成"看代码"。\n' +
            '要看自己的收件箱就在 .pipeline/<任务id>/ 下面搜（那里允许）。'
          )
        }
      }
    }
  }

  // --- 4) shell 旁路（best-effort，字符串匹配）----------------------------
  if (isShellToolName(name, cfg) && binding !== null) {
    const task = taskOf(binding.taskId)
    if (task !== null) {
      // ★ Agent Teams（§D8 第 1 条）：持久终端的命令在 `text` 里 —— 按工具名补扫
      //   （只对 `SHELL_TEXT_ARG_TOOLS`；`write` 正文不算命令，见 `collectCommandStrings`）。
      const commands = collectCommandStrings(args, { toolName: name })
      for (const cmd of commands) {
        // ★★ C3（2026-10-14）：既有判据先跑（逐字节不变）；它放行时才展开**脚本正文**，
        //   把正文喂回同一个 `scanShellCommand`。理由见 `collectCommandStrings` 下面那一段。
        const m = scanCommandWithScripts(cmd, task, binding.role, cfg)
        if (m !== null) return m
      }
    }
  }

  return undefined
}
