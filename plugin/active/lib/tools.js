/**
 * dsh-pipeline · 工具面
 * ============================================================================
 * 二十六个工具，覆盖需求原文点名的全部动作：
 *   创建任务 → 输出/读取编排角色清单 → 状态迁移 → 生成与校验各环节结构化
 *   交接物 → 查询状态 → 打回 → 关单（关单校验审核 OK）
 *
 * ---------------------------------------------------------------------------
 * ★ 三个 defineTool 的硬约束（读 `dsh-tools/lib/index.js` 得到，写错就直接不注册）
 * ---------------------------------------------------------------------------
 *   ① `output` 是**必填**，且 `output.render` 必须是函数（`:842` 无条件读它）。
 *   ② `output.schema` 的对象根**必须显式写 `additionalProperties: false`**，
 *      否则 `compilePropertyMap` 直接 authorError（`:699`）。
 *   ③ `parameters` 是「属性名 → 值 schema」的映射，`required` 只能写在**属性**上
 *      且值必须是 `true`（`:603-604`）；根上不允许写 `required`。
 *
 * ★ 「拒绝」的表达方式：
 *   `execute` 返回 `{ok:false}` **不是错误**（注册表根本不看 `ok`）。所以每一次
 *   拒绝都是**正常返回值**，靠 `output.render` 把拒绝原文交给模型；真正在
 *   dispatch 之前拦住的是 `lib/guard.js` 里那层 `tools.guard`。
 *
 * @module dsh-pipeline/lib/tools
 */

// ---------------------------------------------------------------------------
// 文件布局：工具定义按主题拆在 `lib/tools/` 下，本文件保留 buildTools 的骨架
// （共享闭包、工具面、最终的工具清单），各组在原位置调用、按原顺序产出工具。
//   tools/kit.js       schema 拼装、tool() 包装、输出渲染、调用方识别
//   tools/notifier.js  席位侧投递器 createSeatNotifier
//   tools/intake.js    开单、需求分析            tools/plan.js     计划、授权面变更
//   tools/audit.js     改动审计、边界清单、全量测试进度
//   tools/dispatch.js  派活、角色认领            tools/flow.js     交接、迁移、主管枢纽、打回、关单
//   tools/status.js    状态查询与速查            tools/admin.js    角色变更、制品、自检、开关
//   tools/records.js   落档、联系人、上下文水位、席位继任
//   tools/security.js  安全确认                  tools/human.js    澄清与人工介入
// ---------------------------------------------------------------------------

import { roleLabel } from './roles.js'
import { STATE_LABEL } from './states.js'
import { guardDecision } from './guard.js'
import { deriveToolFace, eventLevelToolNames } from './boundaries.js'
import { createSeatNotifier } from './tools/notifier.js'
import { buildIntakeTools } from './tools/intake.js'
import { buildPlanTools } from './tools/plan.js'
import { buildAuditTools } from './tools/audit.js'
import { buildDispatchTools } from './tools/dispatch.js'
import { buildFlowTools } from './tools/flow.js'
import { buildStatusTools } from './tools/status.js'
import { buildAdminTools } from './tools/admin.js'
import { buildRecordTools } from './tools/records.js'
import { buildSecurityTools } from './tools/security.js'
import { buildHumanTools } from './tools/human.js'
import { buildPurgeTools } from './tools/purge.js'
// ★★ P1/P4 接线（`WIRING.md` §W5）：两个新工具面。
//    `defineTool` 只在 `buildTools` 里被调用 —— 没被调用 = **不注册** = 模型看不到这两个工具。
//    ★ P2 的 AGENTS.md 落盘步骤（`ensureAgentsMd`）在这里**注入**给 `project.js`
//      （那个文件刻意自己不 import 它，见其文件头）。
import { buildProjectTools } from './tools/project.js'
import { buildDemoTools } from './tools/demo.js'
import { ensureAgentsMd } from './project/agents-md.js'

export {
  FULL_TEST_STAGE_ZH,
  rememberMainCaller,
  resolveActor,
  dispatchEventFor,
} from './tools/kit.js'

export {
  createSeatNotifier,
} from './tools/notifier.js'

export function buildTools(deps) {
  const { defineTool, config, store, tokens, transport, indexTask, sw, counter, retireAgent } = deps
  /**
   * ★ 席位侧投递器：**唯一实现**（见 {@link createSeatNotifier} 的文件级说明）。
   *   `notifyOnly` / `nudgeSeat` 就是本文件里原来那三个函数，行为逐字未变。
   */
  const { nudgeSeat, notifyOnly } = createSeatNotifier(deps)

  // =========================================================================
  // ★★ **E 路 ③：工具面**（"某角色实际能用哪些 pipeline_* 工具"）
  // =========================================================================
  //
  //   参考 `dsh-ops` 的 `lib/index.js:128-139` + `lib/policy.js:26-66`
  //   （提示词按**实际可见工具**惰性渲染，"absent tools never get advertised"）。
  //
  //   ★ 权威只有一个：**守门自己的判据**。`guardDecision()` 对一个匿名调用方
  //     会吐出 `允许角色：main / human`（`lib/guard/decide.js` 的 `decide`）——
  //     白名单从**判词**里读，本文件不存第二份（手抄必漂移，而漂移的坏方向是放宽）。
  //   ★ 认不出就**不收紧**（`deriveToolFace` 的纪律①）：宁可少省字节。
  //   ★★ **事件级工具（入参里有 `event`，如 `pipeline_transition`）不按角色收紧** ——
  //     它的权限是**逐事件**判的（状态机 `TRANSITIONS[].by` + `store` 的前置条件），
  //     守门那一行 `['main','human']` 比它粗，不足以定这一类的工具面
  //     （2026-10-14 回归修复：`dev_submitted` 的 by 名单里明明写着 `writer`）。
  //     名单从**真实注册定义**里认（`eventLevelToolNames`），不手抄。
  //   ★ `pipeline_boundaries` 的 `tool_face` 与 `index.js` 的席位收紧**同用这一份**，
  //     所以"导出说的"与"实际做的"不可能漂移。
  const toolNameList = []
  /** ★★ 注册定义本身（事件级工具的判定要读参数表 —— 与工具名同源、同时到齐）。 */
  const toolDefList = []
  let faceCache = null
  const toolAuthorityJudge = (name) => guardDecision({ name, arguments: {} }, { tokens })
  /** @returns {object} 工具面（首次算完即缓存；工具名到齐后由 `buildTools` 末尾作废一次） */
  function pipelineToolFace() {
    if (faceCache === null) {
      faceCache = deriveToolFace({
        toolNames: toolNameList,
        judge: toolAuthorityJudge,
        eventLevel: eventLevelToolNames(toolDefList),
      })
    }
    return faceCache
  }
  /** ★ 交给 `index.js`（席位收紧 + 提示词渲染要用**同一份**面）。 */
  deps.pipelineToolFace = pipelineToolFace

  /** 读任务；顺手登记进同步索引（守门判据要同步查）。 */
  async function load(taskId) {
    const t = await store.get(taskId)
    if (t !== null) indexTask(taskId, t)
    return t
  }

  // 开单与需求分析（pipeline_task_open / pipeline_orchestrate） —— 见 `lib/tools/intake.js`
  const {
    lastAnalysisOf,
    taskOpen,
    orchestrate,
  } = buildIntakeTools({ deps, config, store, tokens, indexTask, load })

  // 计划与授权面变更（pipeline_plan / pipeline_scope_amend） —— 见 `lib/tools/plan.js`
  const {
    planTool,
    scopeAmend,
  } = buildPlanTools({
    deps,
    config,
    store,
    tokens,
    indexTask,
    load,
    lastAnalysisOf,
  })

  // 改动审计、边界清单、全量测试进度 —— 见 `lib/tools/audit.js`
  const {
    changeAuditTool,
    boundariesTool,
    fullTestTool,
  } = buildAuditTools({ deps, store, indexTask, pipelineToolFace, load, paginate })

  // 派活与角色认领（pipeline_dispatch / pipeline_bind_role） —— 见 `lib/tools/dispatch.js`
  const {
    dispatchSlots,
    dispatch,
    bindRole,
  } = buildDispatchTools({
    deps,
    config,
    store,
    tokens,
    transport,
    indexTask,
    notifyOnly,
    load,
  })

  // 交接、迁移、主管枢纽、打回、关单 —— 见 `lib/tools/flow.js`
  const {
    handoff,
    transition,
    supervise,
    rework,
    close,
  } = buildFlowTools({ deps, store, tokens, indexTask, nudgeSeat, load })

  // =========================================================================
  // 9. pipeline_status —— 查询（可追溯）
  // =========================================================================
  /**
   * ★★ **E 路 ②：只读导出的「省字节档」（summary / count）**。
   *
   * ---------------------------------------------------------------------------
   * 为什么要有它
   * ---------------------------------------------------------------------------
   * 现场痛点：`pipeline_status` 是**主对话最常调**的工具，而它要么全给、
   * 要么不给 —— 一次查询就是几万字节（真实量见 `E路-输出投影与工具面-实现报告.md`）。
   * 参考 `dsh-ops` 的 `lib/file/contract.js:20,29`（glob/grep 的
   * `paths|details` / `files_with_matches|content|count|summary` 四种输出模式）与
   * `native/src/results.rs:147-169`（`fields` 投影 + 分页信封）：
   * **让模型先用最便宜的投影探路，确认有货再取正文**。
   *
   * ---------------------------------------------------------------------------
   * 三条铁律（写在代码里，不是写在文档里）
   * ---------------------------------------------------------------------------
   *   ① **不传参数 ⇒ 与改前逐字节相同**：紧凑档只在 `detail` 显式给了
   *      `summary|count` 时才走（`detail` 缺省 / `full` 一律走原路）；
   *   ② **不许少报关键信息**：紧凑档必须回答「**有没有卡、卡在哪、下一步该谁**」，
   *      而且**总数与分布由这里算好**（`blockers` / `next_owners` / `counts`），
   *      绝不把"你自个儿数去"甩给调用方；
   *   ③ **截断必须给续页口径**：任何被切掉的清单都要写明 `page/total` 与
   *      「下一段怎么取」，否则模型只能靠"看起来像完了"判断（然后重跑一遍 = 再付一次）。
   */

  /** 段落长度（紧凑档/显式分页时用；与 `dsh-ops` 的 `limit` 同一条思路）。 */
  const BRIEF_PAGE_SIZE = 20

  /**
   * 把一个清单切成一段 —— **只在调用方显式给了 `page` 时**才会被走到。
   *
   * @returns {{slice:any[], page:number, pages:number, total:number, more:boolean}}
   */
  function paginate(list, page, size = BRIEF_PAGE_SIZE) {
    const arr = Array.isArray(list) ? list : []
    const total = arr.length
    const pages = Math.max(1, Math.ceil(total / size))
    const want = Number(page)
    const p = Number.isFinite(want) && want >= 1 ? Math.min(Math.floor(want), pages) : 1
    const start = (p - 1) * size
    return { slice: arr.slice(start, start + size), page: p, pages, total, more: start + size < total }
  }

  /** 「下一段怎么取」的统一话术（截断时**必须**跟着走）。 */
  function pageHint(pg, toolName, extra = '') {
    if (pg.more !== true) return ''
    return `\n  …（本段 ${pg.page}/${pg.pages}，共 ${pg.total} 条；取下一段：\`${toolName} { …, page: ${pg.page + 1}${extra} }\`）`
  }

  // 状态查询与速查（pipeline_status） —— 见 `lib/tools/status.js`
  const { status } = buildStatusTools({ deps, store, indexTask, load, paginate })

  // 角色变更、制品、自检、开关 —— 见 `lib/tools/admin.js`
  const {
    rosterRequest,
    rosterReview,
    artifact,
    selftest,
    switchTool,
  } = buildAdminTools({ deps, store, indexTask, sw })

  // 分权落档、联系人、上下文水位、席位继任 —— 见 `lib/tools/records.js`
  const {
    recordSubmit,
    compileRequirement,
    contacts,
    contextReport,
    succession,
  } = buildRecordTools({
    deps,
    config,
    store,
    tokens,
    transport,
    indexTask,
    counter,
    retireAgent,
    dispatchSlots,
  })

  // 收尾清理（pipeline_task_purge） —— 见 `lib/tools/purge.js`
  const { taskPurge } = buildPurgeTools({ deps, store, load })

  // ★★ P1 接线：项目目录与仓库（pipeline_project_init） —— 见 `lib/tools/project.js`
  //    `ensureAgentsMd` 是 P2 的落盘步骤，从此处注入；`dshHome` 在 config 上不一定有，
  //    没有就是 `undefined` ⇒ `resolveProjectDir` 返回可读的 `NO_DSH_HOME`，**不会崩**。
  const { projectInit } = buildProjectTools({
    ...deps,
    dshHome: deps.dshHome ?? config.dshHome,
    ensureAgentsMd,
  })
  // ★★ P4 接线：DEMO 阶段（pipeline_demo） —— 见 `lib/tools/demo.js`
  const { demo } = buildDemoTools({ deps, store, load })

  // 安全确认（pipeline_security_check） —— 见 `lib/tools/security.js`
  const { securityCheck } = buildSecurityTools({ deps, config, store, indexTask, load, paginate })

  // 澄清与人工介入 —— 见 `lib/tools/human.js`
  const {
    clarifyRequest,
    clarifyReply,
    humanRequest,
    humanRelay,
    humanReply,
  } = buildHumanTools({ deps, store, indexTask, load, wakeResumedSeat })


  // =========================================================================
  // ★★ B3 / B8：**叫醒一个席位**（裁定落地后唤醒发起席位；也给"催办/停"一条可见通道）
  // =========================================================================
  //
  // 现场（2026-10-12）：
  //   · 席位提了 `blocking` 澄清 → 按规矩停手等 → 需求分析出了裁定 → 状态**正确恢复** →
  //     **但那个停手的席位再没有任何人被叫醒**（实测其会话自 21:03:01 起完全冻结，
  //     45 秒观测 size 恒定）；解除任务阻塞同样叫不醒它。
  //     ⇒ **每一次 blocking 澄清 = 永久废掉一个席位**。
  //   · 主对话也**停不掉空转席位**，也没有"给既有席位发一条消息"的通道 ——
  //     当晚只能由用户用 GUI 手动打字把席位叫醒。
  //
  // 判据（三条，写死在这里）：
  //   ① **投递失败必须看得见** —— 叫不醒就返回 `ok:false` 并写清"为什么、去哪儿看"，
  //      绝不当成功（用户原话：「不许静默失败」）；
  //   ② 会话 id 从**派活台账**取（`task.dispatched`），不从调用方传 —— 结构上不可能投错人；
  //   ③ 不新开状态、不新开机制：投递走既有的通道 `transport.notifyRole`。
  //
  // ★ 2026-10-14（孤儿单自恢复）：`notifyOnly` / `nudgeSeat` / `noteSeatDelivery`
  //   三个函数**原样搬进** `createSeatNotifier(deps)`（本文件顶部），本作用域只做
  //   `const { nudgeSeat, notifyOnly } = createSeatNotifier(deps)`。
  //   搬运的原因只有一个：**孤儿单自恢复的重投必须与 `notify_only` 是同一份实现**
  //   （见 `lib/orphan.js` 的文件头与 `createSeatNotifier` 的 JSDoc）。
  //   行为逐字未变 —— 判据①②③仍然落在上面那三条上。

  /**
   * ★★ **B3：裁定落地后唤醒"停手等答复"的那个席位**。
   *
   * 失败**绝不静默**：把失败原文拼进返回的 summary，让主对话当场看见，
   * 并且给出等价可达路径（`pipeline_dispatch { notify_only: true }` 手动催 / `reassign` 重派）。
   */
  async function wakeResumedSeat(task, role, seat, why, meta = {}) {
    const body =
      `【流水线 · 裁定已落地】你之前停手等的那件事有结论了（${why}）。\n` +
      `任务 ${task.id} 当前状态：${STATE_LABEL[task.state] ?? task.state}（\`${task.state}\`）。\n` +
      '★ 这条是**运行时上下文**，不是用户说的话。\n' +
      '下一步：用 pipeline_status 重读任务状态，然后继续你那一份活（你原来的边界不变）。'
    const r = await nudgeSeat(task, role, seat, body, meta)
    if (r.ok === true) return { ok: true, line: `★ 已唤醒发起席位「${roleLabel(role)}${seat === null ? '' : `（${seat}）`}」（会话 ${r.sessionId}）。\n` }
    return {
      ok: false,
      line:
        `⚠ **裁定已落地，但叫不醒发起席位**「${roleLabel(role)}${seat === null ? '' : `（${seat}）`}」—— 这是**看得见的失败**（不是静默）：\n` +
        `  原因：${r.note}\n` +
        `  等价可达路径（择一）：\n` +
        `    · 手动催一次：pipeline_dispatch { task_id: "${task.id}", role: "${role}"${seat === null ? '' : `, seat: "${seat}"`}, notify_only: true, note: "裁定已落地，请继续" }（**不建会话、不改状态**）\n` +
        `    · 重派同一席位：pipeline_dispatch { task_id: "${task.id}", role: "${role}"${seat === null ? '' : `, seat: "${seat}"`}, reassign: true }\n`,
    }
  }

  const allTools = {
    taskOpen,
    orchestrate,
    // ★ 本轮新增：计划 AI 的工具（出计划 → 自检 → 分配 AI）
    planTool,
    // ★ 本轮新增：**授权面变更（amendment）** —— 一条只动 change_scope / forbidden 的窄通道
    //   （只在「待开发」由计划 AI 生效；席位/角色清单/档位/顺序/层一个字都动不了）
    scopeAmend,
    // ★ 本轮新增：前后版本对比（基线 → 当前），审核的判据式证据
    changeAuditTool,
    // ★ 本轮新增：机器可读的边界清单（给 DSH 层的钩子复用）
    boundariesTool,
    // ★ 本轮新增：全量测试审批链的进度（只读）
    fullTestTool,
    dispatch,
    bindRole,
    handoff,
    transition,
    // ★★ T-20261011-56a37e：主管枢纽的**具名动作**（只有 supervisor 能调）。
    supervise,
    rework,
    close,
    status,
    rosterRequest,
    rosterReview,
    artifact,
    selftest,
    switchTool,
    humanRequest,
    humanRelay,
    humanReply,
    clarifyRequest,
    clarifyReply,
    securityCheck,
    contextReport,
    succession,
    recordSubmit,
    compileRequirement,
    contacts,
    // ★ 缺陷 ⑦：终态单的**收尾清理**（归档 / 删除）—— 唯一的具名入口，主对话专用。
    taskPurge,
    // ★★ P1 接线：项目目录与仓库（幂等建目录 / git 化闸门 / 快照版本目录）
    projectInit,
    // ★★ P4 接线：DEMO 阶段（档位策略 / 交轮次 / 用户确认）
    demo,
  }
  /**
   * ★ E 路 ③：工具名**从真实注册对象派生**（不另抄一份会漂移的名单）——
   *   到这一步名字才齐，所以把之前可能算过的缓存作废重算。
   * ★ 定义也一并收下：事件级工具（入参里有 `event`）要靠**参数表**认，
   *   而参数表只在定义里 —— 从这里派生，"导出说的"与"实际注册的"才不可能漂移。
   */
  for (const def of Object.values(allTools)) {
    if (typeof def?.name !== 'string') continue
    if (!toolNameList.includes(def.name)) toolNameList.push(def.name)
    if (!toolDefList.some((d) => d?.name === def.name)) toolDefList.push(def)
  }
  faceCache = null
  return allTools
}
