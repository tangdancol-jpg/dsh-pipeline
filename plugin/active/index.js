/**
 * dsh-pipeline —— Host 半边（DSH 插件入口）
 * ============================================================================
 * 多对话 AI 协作开发流水线。主对话只调度不干活；编写/测试/审核三权分立。
 *
 * 本插件把下面这些**从约定变成机制**：
 *
 *   1. **分档编排是唯一出口**（`lib/tiers.js` + `pipeline_orchestrate`）
 *      主对话不能自己决定要几个 AI。要么由独立编排对话给 tier + reason，
 *      要么由确定性规则引擎判 L0 —— 而引擎要输出 L0，需求必须先通过一组
 *      保守的平凡性判据。简单需求不超配，复杂需求不漏配。
 *
 *   2. **结构化交接物 + 状态机**（`lib/handoff.js` / `lib/states.js` / `lib/store.js`）
 *      每份交接物有固定字段；状态迁移表里**没有** developing → ready_review 这条边，
 *      所以"编写绕过测试直接找审核"连状态都推不动。
 *
 *   3. **硬拦截**（`lib/guard.js`，注册进 `ctx.tools.guard`）
 *      越权、跳步、无 OK 关单、测试改代码、主对话读代码 —— 在 dispatch 之前拒。
 *
 *   4. **角色令牌**（`lib/tokens.js`）
 *      角色身份不可自称：主对话派活时铸一枚只属于那个角色的令牌，
 *      真实子代理通道下还会与子会话 id 二次绑定（令牌转手即失效）。
 *
 *   5. **可审计落盘**（`<项目>/.pipeline/<taskId>/`）
 *      task.json / handoffs/*.json / artifacts/vN/ / audit.jsonl 全流程可追溯。
 *
 *   6. **一个界面上能点的总开关**（`lib/switch.js` / `lib/switch-routes.js` / `lib/client.js`）
 *      DSH 窗口右上角头部那一排里的「多AI 协调」按钮 —— 开 = 上面 1~5 全管；
 *      关 = **本插件不再拦任何调用、不再往任何会话注入消息**（四条拦截缝全直通、
 *      唤醒不投递、巡检与孤儿单自恢复停表），只剩"流水线写操作被拒"这一条**故意**保留。
 *      ★ 逐条面清单与唯一闸门在 `lib/switch/gate.js` 的 `SWITCH_SURFACES` / `isEnabled()` ——
 *        它就是"关 = 彻底摘干净"的可执行定义（缺陷"开关只关一半"的根因修复）。
 *      ★ 关掉时**不注销守卫、不注销工具**（结构恒常、行为可变）：
 *        守卫注销再注册会改变它在 `ToolLayer.guards` 里的顺序，而守卫链是
 *        "取第一个非 undefined"（`dsh-tools:2646-2651`）—— 顺序一变，与
 *        dsh-archigate 同时命中时的**拒绝文案**就会跟着变，那是对用户可见的行为抖动。
 *
 * ---------------------------------------------------------------------------
 * 机制依据（读本机 DSH 实现得到，不是从 README 抄的一句话）
 * ---------------------------------------------------------------------------
 *   · 插件形态：`export apply/inject` + `dsh.bundle.patch`（与已装的
 *     dsh-archigate / dsh-drawai / dsh-normify 同形）。
 *   · 工具注册：`ctx.tools.register(defineTool({...}))` 返回**精确 disposer**
 *     （`dsh-tools/lib/index.js:2878`）。`defineTool` 的 `output` 必填
 *     （`:842` 无条件读 `output.render`）。
 *   · 执行流水线：`tools/pre-execute`（waterfall，`:3225`）
 *     → `ctx.tools.guard()`（**单调**守卫，`:2921`/`:3241`）→ dispatch
 *     → `tools/post-execute` → `tools/result`。
 *     拒绝判据是 `reason !== undefined`（`:2649`）——**放行必须返回 `undefined`**；
 *     而 guard **抛异常不是拒绝**（`:3267` 会吞成通用 tool error），
 *     所以本插件的守门整体包在 try/catch 里、内部异常按 fail-closed 处理。
 *   · 调用方身份：`exec.agent`（`:3149`；**global 调用时为 undefined，必须判空**），
 *     且 `agent.id === agent.session.id`（`dsh-agent/lib/index.js:511`）——
 *     这让"令牌 ↔ 会话"二次绑定成为可能。
 *   · 角色驱动：`ctx.subagents.startContinuable({provider,label,request,signal})`
 *     → `{childId, messageId}`（`dsh-subagent/lib/index.js:2871`）、
 *     `ctx.subagents.sendMessage(sender,targetId,content,options)`
 *     （`typert.host.js:142`）。
 *
 * ---------------------------------------------------------------------------
 * 与 dsh-archigate 的共存（需求原文点名要处理的）
 * ---------------------------------------------------------------------------
 * 两边都只注册 `tools.guard`，都**只拒不放**：`guardReason` 取第一个非 undefined
 * 就返回（`:2646-2651`），没有任何通路能让后一个守卫把前一个的拒绝翻回允许。
 * 而且 guard 只在 pre-execute 决议为 `allow` 时才跑（`:3241`）—— 别的插件
 * （archigate 的 archify 交付守门、experimental-auto-review 的授权闸门）先拒的
 * 调用根本走不到这里，不可能互相翻转。自测里有一条专门验证这件事。
 *
 * @module dsh-pipeline
 */

import { join } from 'node:path'

import { DEFAULTS, mergeConfig } from './lib/config.js'
import { createGuardFor } from './lib/guard-factory.js'
import { makeTaskIndexEntry } from './lib/guard.js'
import { createCallCounter } from './lib/context.js'
import { createTaskStore } from './lib/store.js'
import { createSwitch, defaultSwitchStateFile } from './lib/switch.js'
// ★★ 总开关（缺陷"开关只关一半"）：判据/面清单在 lib/switch/gate.js，
//    文案在 lib/switch/text.js，周期机制起停在 lib/switch/mechanisms.js，
//    唤醒投递闸门在 lib/switch/waker-gate.js。**本文件只做接线**。
import { isEnabled } from './lib/switch/gate.js'
import { offModeStartupLines } from './lib/switch/text.js'
import { createMechanismItems, createSwitchDrivenMechanisms } from './lib/switch/mechanisms.js'
import { withSwitchGate } from './lib/switch/waker-gate.js'
import { registerInterception } from './lib/intercept.js'
import { fullTestCredential } from './lib/testscope.js'
import { hashGateBlocksTests, hashGateEscalationPending } from './lib/hashgate.js'
import { mountSwitchRoute, ROUTE_PREFIX, STATE_PATH } from './lib/switch-routes.js'
import { createTokenStore } from './lib/tokens.js'
// ★★ E 路 ③：角色常量（"主对话不收紧工具面"这条口径要按**同一个**角色 id 判）。
import { ROLE, ROLES, roleLabel } from './lib/roles.js'
import { TERMINAL_STATES } from './lib/states.js'
import { buildTools, createSeatNotifier } from './lib/tools.js'
import { createTransport, probeSessionChannel } from './lib/transport/index.js'
import { createChannelAudit } from './lib/liveness.js'
import { createMainSessionRegistry, createWaker } from './lib/wakeup.js'
// ★★ 本轮新增：已播报账本（A19/A20）、巡检兜底（A21–A25）、运行失败取证（A9–A11）。
import { LEDGER_FILE_NAME, createWakeLedger, defaultLedgerPath } from './lib/wakeledger.js'
import { createPatrol, patrolFindings } from './lib/patrol.js'
import { patrolNotice } from './lib/patrol/notice-text.js'
// ★★ 2026-10-14 新增：**主对话侧的重启自动认领**（席位侧那半已在 indexTask 里，
//    见下面的 1.7；这两半**判据不同源、互不冒充**）。
import { autoReattachMain, formatMainReattachReport } from './lib/reattach.js'
// ★★ 2026-10-14 新增：**孤儿单自恢复**（席位被切断 ⇒ 自己意识到 + 自己重新投递）。
import { createOrphanAudit, createOrphanRescue } from './lib/orphan.js'
import { detectRunFailure, sessionsRootOf } from './lib/runfail.js'
// ★★ E4：跨项目"用户裁定"库（装配期发布成 `<dsh-home>/skills/<名字>/SKILL.md`）。
import { publishRulingsForProject } from './lib/memory/user-rulings.js'
import { pathKey, PACKAGE_ROOT } from './lib/util.js'
// ★★ **读目录设定**：安装目录 / 工作目录的**唯一出处**（配置 > 环境变量 > 文件 > 推导）。
//    同一份判据也被 `install.ps1` 读，两边不会各推各的。见 lib/dirs.js。
import { resolveDirs } from './lib/dirs.js'

/** 插件名。 */
export const name = 'dsh-pipeline'

/**
 * 本插件在 profile 里的 entry id。
 * ⚠️ 必须与 `cordis.patch.yml` 里 `- id:` 的值一致。
 */
export const NS = 'dsh-pipeline'

/**
 * 装配期依赖（`inject`）—— **精确集合**、每一项"为什么在"、以及**为什么别的不在**
 * （可选服务走运行期探测而不是装配期依赖），全部在 `lib/host-surface.js` 的单一出处里。
 * 这里只做**一行接线**；改这个面要**重启 DSH** 才生效（装配期依赖，热重载不重新装配）。
 */
export { PLUGIN_INJECT as inject } from './lib/host-surface.js'

/** 版本号（与 package.json 保持一致；日志与收据里会打印）。 */
export const TOOL_VERSION = '0.1.0'

/** system prompt 段的排序键。取个不撞别人的数（实测宿主里 2800 是子代理、5000 是 ptc SDK）。 */
const PROMPT_ORDER = 2650

/**
 * 插件主体。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [rawConfig] - profile patch 里那条插件行的 `config`。
 */
export function apply(ctx, rawConfig) {
  const config = mergeConfig(rawConfig)

  if (config.enabled !== true) {
    const msg = `[pipeline] ${NS} ${TOOL_VERSION}：enabled=false，未注册任何工具与守门。`
    ctx.logger?.info?.(msg)
    console.log(msg)
    return
  }

  // -------------------------------------------------------------------------
  // 1) 依赖装配
  // -------------------------------------------------------------------------
  /**
   * ★★ **读目录设定**（`lib/dirs.js`）：一次解析、全程复用。
   *
   * 取值顺序：profile 配置（`config.dshHome` / `config.projectRoot`）> 环境变量
   * （`DSH_PIPELINE_DSH_HOME` / `DSH_PIPELINE_PROJECT_ROOT`）> 配置文件
   * （`<DSH 用户目录>/dsh-pipeline.dirs.json`）> 运行时推导
   * （`DSH_HOME` / 用户主目录 / `process.cwd()`）。
   *
   * ★ 以前 `projectRoot` 直接写 `process.cwd()`、`dshHome` 只认 `DSH_HOME`：
   *   换个用户名、换台机器就只能靠"恰好开在对的目录里"。现在默认值仍然等价，
   *   但**多了一条能显式覆盖的路**，且安装脚本读的是同一份判据。
   */
  const dirs = resolveDirs({
    explicit: { dshHome: config.dshHome, projectRoot: config.projectRoot },
  })
  const projectRoot = pathKey(dirs.projectRoot)

  const tokens = createTokenStore({ ttlMs: config.tokenTtlMs })
  /**
   * ★★ **已播报账本**（A19 / A20；用户裁定 D5「允许新增状态文件」）。
   *
   * 落点：插件目录内（`config.wakeLedgerFile` 留空时 = `<插件目录>/wake-ledger.jsonl`）
   * —— B16 明确要求"账本与巡检**不得越出插件目录写文件**"。
   * 三种"用不了"的形态（缺失 / 损坏 / 不可写）各有可判定行为且都走
   * 「看得见的失败」，判据写在 `lib/wakeledger.js` 的文件头。
   */
  const wakeLedger = createWakeLedger({
    file: config.wakeLedgerFile && config.wakeLedgerFile.length > 0 ? config.wakeLedgerFile : defaultLedgerPath(PACKAGE_ROOT),
    disabled: config.wakeLedgerEnabled === false,
    warn: (m) => ctx.logger?.warn?.(m),
  })
  const store = createTaskStore({
    projectRoot,
    artifactDirName: config.artifactDirName,
    // ★ **授权面锚点**：`change_scope` / `scope_paths` 里的裸相对路径按它解析
    //   （默认 = 本插件包根，不是 projectRoot）。改动面审计与守门必须**用同一个锚点**，
    //   否则同一份授权面在两处会得出不同结论。
    scopeAnchor: config.changeScopeAnchor,
    maxReworkPerLeg: config.maxReworkPerLeg,
    // ★ 席位失联的静默阈值（毫秒）——工具层与拦截缝都用它，见 lib/liveness.js
    seatSilenceMs: config.seatSilenceMs,
    // ★ 哈希闸门连续不通过 ⇒ 自动交人工（用户拍板 P13；0 = 关掉自动升级）
    hashGateEscalateAfter: config.hashGateEscalateAfter,
    humanRequestTimeoutHours: config.humanRequestTimeoutHours,
    requireHumanConfirmCode: config.requireHumanConfirmCode === true,
    maxClarifyRounds: config.maxClarifyRounds,
    /**
     * ★★ **A9：运行失败取证**（"崩"与"闲"在判词与证据上分开）。
     *
     * 判据是纯的（`lib/runfail.js`），**采样**在这里：先看进程内会话事件
     * （`ctx.agents.get(sessionId).session.snapshotEvents()`），拿不到再看落盘会话日志
     * （`session.v4.jsonl.zstd`，席位崩没了时的唯一线索）。
     *
     * ★ 取证只做一件事：**回答"这一轮是不是运行失败中止了"**。它不参与"要不要判失联"
     *   —— 拿不到证据时 `checkLiveness` 照旧走既有三条判据（A12 真阳性一个字没动）。
     */
    detectRunFailure: async (task, silent) => {
      const seats = Array.isArray(silent) ? silent : []
      let last = null
      for (const s of seats) {
        const sessionId = typeof s?.session_id === 'string' && s.session_id.length > 0
          ? s.session_id
          : typeof s?.agent_id === 'string' && s.agent_id.length > 0 ? s.agent_id : ''
        if (sessionId.length === 0) {
          last = { known: false, found: false, evidence: null, source: 'none', note: `席位 ${String(s?.key ?? '?')} 没有会话 id —— 判不出崩还是闲（如实说读不到）。` }
          continue
        }
        const r = detectRunFailure({ ctx, sessionId, sessionsRoot: sessionsRootOf(), warn: (m) => ctx.logger?.warn?.(m) })
        if (r.found === true) return r
        last = r
      }
      return last ?? { known: false, found: false, evidence: null, source: 'none', note: '没有可取证的席位。' }
    },
    /** ★ E3：`sw` 建在下面（`:235`）⇒ 这里只能给一个闭包；判据仍然只有 `lib/switch/gate.js` 一处。 */
    switchRef: () => sw,
  })
  // ★ 通道侧留痕出口：通道不可达 / 「完全」档被拒 / 归组建不起来 —— 这三类判决
  //   都必须落盘。写进**既有**的 `.pipeline/<任务>/audit.jsonl`（只追加），不新开机制。
  const channelAudit = createChannelAudit({
    auditFile: (id) => store.auditFile(id),
    log: (m) => ctx.logger?.warn?.(`[pipeline] ${m}`),
  })
  const transport = createTransport(ctx, config, { tokens, audit: channelAudit.record })
  /** ★ 真实会话派活通道的能力探测结论（可观测：日志 + `lastChannelProbe()`）。 */
  const channelProbe = probeSessionChannel(ctx)
  LAST_CHANNEL_PROBE = channelProbe

  // -------------------------------------------------------------------------
  // 1.5) 功能开关（右上角 UI ↔ 宿主机制之间的那根线）
  // -------------------------------------------------------------------------
  //
  // ★ 关掉 ≠ 卸载：守卫与工具**照旧注册**，只是守门第一句就弃权、写工具第一句就拒。
  //   理由见 `lib/switch.js` 文件头（守卫注销再注册会改变守卫链顺序，
  //   而顺序会改变与其它插件同时命中时的拒绝文案 —— 那是用户可见的行为抖动）。
  const sw = createSwitch({
    stateFile: config.switchStateFile && config.switchStateFile.length > 0
      ? config.switchStateFile
      : defaultSwitchStateFile(projectRoot, config.artifactDirName),
    initial: config.switchDefaultOn !== false,
    log: (m) => {
      ctx.logger?.warn?.(`[pipeline] ${m}`)
      console.warn(`[pipeline] ${m}`)
    },
  })

  /**
   * 守门用的**同步**任务索引。
   *
   * 为什么需要它：`guardReason` 是**同步**遍历（`dsh-tools:2928`），而任务数据在
   * 盘上、读取是异步的。所以在任务被打开/加载时顺手把守门需要的那几个字段
   * （项目根、流水线目录、报告目录）登记进这个内存索引。
   *
   * 代价与边界（诚实写出来）：**进程重启后、任务被再次加载之前，索引是空的**，
   * 这段时间里文件工具层面的越权判定不生效（令牌层面的判定不受影响，它只看内存
   * 令牌表）。所以首次调用任何 pipeline 工具时会顺带把任务加载进索引。
   */
  const taskIndex = new Map()

  /** ★ 客观观测：每个席位调用过多少次工具（守门那一层数）。 */
  const counter = createCallCounter()
  /** ★ 继任后退休的会话：守门靠它拦住旧席位的后续写入。 */
  const retiredAgents = new Set()
  const retireAgent = (agentId) => {
    if (typeof agentId === 'string' && agentId.length > 0) retiredAgents.add(agentId)
  }

  /** 把任务登记进同步索引。 */
  const indexTask = (taskId, task) => {
    if (task === null || task === undefined) return
    const root = pathKey(task.project_root ?? projectRoot)
    const pipelineDir = join(root, config.artifactDirName)
    // ★ `writers` 必须进索引：守门要**同步**判"这个席位有没有越界写别人的分区"。
    // ★ `scopeAnchor` 也必须进索引：授权面里的裸相对路径按它解析（见 lib/config.js
    //   的 `changeScopeAnchor`）。任务元数据里显式写了 `scope_anchor` 就优先用它 ——
    //   于是锚点是**按任务各一份**的，一个任务的锚点影响不到另一个任务。
    taskIndex.set(taskId, makeTaskIndexEntry({ taskId, projectRoot: root, pipelineDir, scopeAnchor: task.scope_anchor ?? config.changeScopeAnchor, writers: task.roster?.writers ?? null, changeScope: task.change_scope ?? null, fullTest: fullTestCredential(task), hashGateBlocked: hashGateBlocksTests(task), hashGate: task.hash_gate ?? null, hashGateEscalated: hashGateEscalationPending(task),
      // ★★ T-20261011-56a37e（主管枢纽）：待机面与"编写交付了没有"必须进**同步**索引 ——
      //   守门要在文件工具与 shell 两层同步判它们，运行时读不到盘。
      //   数据源只有一个：`task.hub` 与 `task.handoffs`（派生，不另存一份）。
      hubEnabled: task.hub?.enabled === true,
      hubStandby: Array.isArray(task.hub?.standby)
        ? task.hub.standby.map((s) => ({ role: String(s?.role ?? ''), wake_point: String(s?.wake_point ?? ''), status: s?.status === 'woken' ? 'woken' : 'standby' }))
        : [],
      devDelivered: (Array.isArray(task.handoffs) ? task.handoffs : []).some((h) => h?.kind === 'dev_to_test'),
      terminal: TERMINAL_STATES.includes(task.state) }))

    /**
     * ★★ **A27(b)：重启后认出既有席位**（用户裁定 ② 的"席位侧那半"）。
     *
     * 令牌表是**进程内存态** ⇒ DSH 一重启，"这个会话是哪个席位"就全没了，
     * 机制的表现为「认不出 → 干脆不叫 → 再派一席」，而那正是本单要消灭的循环。
     *
     * 判据：**盘上有登记就把它认回来**（`task.dispatched[]` 由 `pipeline_dispatch`
     * 在派活成功之后落盘，跨进程活着）。识别依据缺失 / 损坏时 `tokens.restore`
     * 返回 `ok:false` —— 这里**如实留痕**（不静默、也不凭空新建席位，A27(c)）。
     */
    const dispatches = Array.isArray(task.dispatched) ? task.dispatched : []
    for (const d of dispatches) {
      const role = String(d?.role ?? '')
      const agentId = typeof d?.agent_id === 'string' && d.agent_id.length > 0
        ? d.agent_id
        : typeof d?.session_id === 'string' && d.session_id.length > 0 ? d.session_id : ''
      if (role.length === 0 || agentId.length === 0) continue
      try {
        if (tokens.roleOfAgent(agentId, taskId) !== null) continue
        const r = tokens.restore({
          taskId,
          role,
          seat: d?.seat ?? null,
          agentId,
          sessionId: d?.session_id ?? null,
          token: d?.token ?? null,
          atMs: typeof d?.at_ms === 'number' ? d.at_ms : null,
        })
        if (r.ok !== true) {
          ctx.logger?.warn?.(`[pipeline] 重启后认出席位失败（任务 ${taskId}，席位 ${role}${d?.seat === null || d?.seat === undefined ? '' : `#${d.seat}`}）：${r.reason}`)
        }
      } catch (err) {
        ctx.logger?.warn?.(`[pipeline] 重启后认出席位异常（不影响本次调用）：${String(err?.message ?? err)}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // 1.8) ★★ 交付即唤醒主对话（本次前置修复）
  // -------------------------------------------------------------------------
  //
  //   现场（用户原话）：「真实会话干完活，**主对话收不到任何信号**，
  //   只能靠人问或轮询，整条流水线看着像停摆。」
  //
  //   根因：子代理通道自带回调（会话结束 ⇒ harness 往协调者注入
  //   `Background subagent … finished`），真实会话通道只做了三步
  //   （建会话 / 投递 / 读回），**没有第四步「交付回调」**。
  //
  //   两条登记一起用（缺一不可）：
  //     · **内存**（`registry`）—— 唤醒路径同步即查，热；
  //     · **落盘**（`task.contacts.main`）—— 跨重启可查（DSH 重启后内存登记表没了，
  //       主对话在它下次调工具之前是"不知道唤醒该投给谁"的）。
  //   登记发生在**每一次** pipeline 工具调用之后（`lib/tools.js` 的唯一出口），
  //   所以它不依赖任何一条特定路径。
  const mainSessions = createMainSessionRegistry()
  /**
   * ★★ **总开关**：唤醒是本插件"往会话里说话"的唯一咽喉（四条来路都走它），
   *    所以在装配处包一层就够 —— 见 `lib/switch/waker-gate.js`。
   *    ★ `createWaker` 本体（`lib/wakeup/waker.js`）**一个字节都不用改**。
   */
  const wakeup = withSwitchGate(createWaker({
    ctx,
    registry: mainSessions,
    /** ★★ 已播报账本：让「同一条事件恰播一次」**跨进程**成立（A19）。 */
    ledger: wakeLedger,
    // 渲染"当前状态 + 下一步合法事件"要用任务（读盘，但唤醒是低频事件：一次交付一条）
    getTask: (taskId) => store.peek?.(taskId) ?? null,
    // ★ 内存登记表没命中时的**兜底**：读落盘的 `task.contacts.main`。
    //   补的正是"DSH 重启后、主对话还没再调过任何工具"的那个窗口 ——
    //   没有它，重启后的第一次交付会被静默跳过（而那是最常见的场景）。
    mainContactOf: (taskId) => store.mainContact(taskId),
    /**
     * ★★ **第三道来源（兜底解析）**：上面两条都空时，从这张单**自己**的
     * `task.history` 里翻"主对话上一次在哪个会话"（判据在
     * `lib/wakeup/last-resort.js`，纯函数、只读、**不写** `contacts.main`）。
     *
     * 现场（真单 `T-20261016-ff9ba7`）：顶层连 `contacts` 键都没有 ⇒ 前两条全空
     * ⇒ **整张单 22 次唤醒全部 `no-main-session`**，人工请求静默积压。
     * 没给这一条（自测替身 / 旧装配）时行为不变：照样跳过，但**不静默**。
     */
    lastResortMainOf: (taskId) => store.lastKnownMainAgent(taskId),
    // 留痕走**既有**的 `.pipeline/<任务>/audit.jsonl`（只追加，不新开机制）
    audit: async (taskId, action, detail) => {
      if (typeof taskId !== 'string' || taskId.length === 0) return
      await store.recordAudit(taskId, 'main', action, detail)
    },
    // 主对话会话落盘（跨重启可查）—— 只在**变了**的时候写
    rememberContact: async (taskId, sessionId) => {
      const r = await store.rememberMainContact(taskId, sessionId)
      if (r.ok !== true) ctx.logger?.warn?.(`[pipeline] 主对话会话登记失败：${String(r.error ?? '')}`)
      return r
    },
    warn: (m) => ctx.logger?.warn?.(m),
  }))

  const deps = {
    defineTool: DEFINE_TOOL,
    // ★ 退化时必须让工具层知道：入参要自己吐严格 JSON Schema（见 lib/tools.js 的 tool()）
    defineToolDegraded: DEFINE_TOOL_DEGRADED,
    ctx,
    config,
    store,
    tokens,
    transport,
    indexTask,
    sw,
    // ★ 客观观测 + 继任后的退休名单（工具层与守门层共用）
    counter,
    retireAgent,
    // ★★ **交付即唤醒主对话**（本次前置修复）：工具层每调一次就记下"主对话在哪个
    //    会话"（`lib/tools.js` 的 `rememberMainCaller` 读它），拦截缝的触发点读
    //    `deps.wakeMain` 投递。见 lib/wakeup.js 的文件头。
    wakeup,
    /**
     * ★★ P1 接线（`WIRING.md` §W9）：**DSH 用户目录** —— 全新项目的默认父根
     * （`<DSH 用户目录>/projects/<首单 task_id>`）从这里算。
     *
     * 取值走 `lib/dirs.js` 的**同一份判据**（与 `projectRoot` 同一个出处）：
     *   ① profile 配置里的 `config.dshHome`
     *   ② 环境变量 `DSH_PIPELINE_DSH_HOME`
     *   ③ 配置文件 `<DSH 用户目录>/dsh-pipeline.dirs.json` 的 `dshHome`
     *   ④ 宿主自己导出的 `DSH_HOME`，再退到 `<用户主目录>/.dsh`
     *
     * ★ 第 ④ 级的兜底是本轮新增的：以前两处都没有就是**空串**，
     *   `resolveProjectDir` 会给出可读的 `NO_DSH_HOME` 拒绝（**不会崩**）——
     *   那条路径仍在（主目录也取不到时），但"换个用户名"不再会掉进去。
     */
    dshHome: dirs.dshHome,
  }

  // -------------------------------------------------------------------------
  // 1.85) ★★ **主对话侧的重启自动认领**（机制对比文档 §二 ④ 照出来的另一半）
  // -------------------------------------------------------------------------
  //
  //   现场：**席位侧早就是自动的**（上面 `indexTask` 里那段 A27(b)：按
  //   `task.dispatched[]` 台账调 `tokens.restore()`），而**主对话侧仍是手动** ——
  //   DSH 每重启一次，就得由人或主对话自己发一次
  //   `pipeline_task_open { task_id, reattach: true }` 才拿得回身份。
  //   根因是同一个：**令牌表是进程内存态**，重启即全空。
  //
  //   判据（凭什么认定这个会话是某任务的主对话）：
  //     **盘上那条主对话自己写下的、跨进程活着的记录** ——
  //     `.pipeline/<任务>/task.json` → `contacts.main.agent_id`
  //     （由 `lib/store.js` 的 `rememberMainContact()` 落盘；而它挂在
  //      `lib/tools.js` 的**唯一工具出口**上，所以每一次 pipeline 工具调用都会刷新它）。
  //     四条同时成立才认：① 记录存在 ② `role === 'main'` ③ `agent_id` 非空
  //     ④ **它与本次调用方的会话 id 逐字相等**。判据本体 =
  //     `lib/reattach.js` 的 `judgeMainClaim()`（**纯函数、只读、不写盘、不抛**）。
  //
  //   为什么挂在 `tools/pre-execute` 而**不是**工具出口：
  //     宿主的执行流水线是 `tools/pre-execute`（:3225）→ `ctx.tools.guard`（:3241）
  //     → dispatch。挂在出口就**太晚了** —— 重启后主对话的第一次
  //     `pipeline_transition` 会先被守门以"没有身份"拒掉。挂在**前置缝**上，
  //     认领在守门之前完成，于是"第一次调用就是通的"。
  //
  //   ★ 为什么**搭在既有那条拦截缝里**（`lib/intercept.js` 的 `tools/pre-execute`），
  //     而不是自己 `ctx.on` 再挂一条：`tests/load-smoke.mjs` 把
  //     「`tools/pre-execute` 恰好 **1** 条中间件」写成了**既有断言**（条数一变它就红，
  //     而"不许改既有断言/期望值"是本单的硬约束）。本调用**不改变**那条缝的
  //     放行/拒绝语义 —— 它既不 deny 也不 ask，只在最前面顺手把身份认回来。
  //     代价（如实写出来）：`config.intercept !== true` 时它不生效，退化为旧的手动认领
  //     —— 那种配置下会打一条 `warn` 把这件事说出来，不静默。
  //
  //   ★ 三条纪律（写在装配上，不写在善意里）：
  //     · **不放宽任何身份校验**：不碰 `lib/guard.js` 一个字、不碰
  //       `tokens.resolve` / `roleOfAgent` / `bindAgent`。反而**更严** ——
  //       手动通道 `store.reattach()` 文件头写明"不校验调用方身份"，而这里要求
  //       会话 id 与盘上记录**逐字相等**。
  //     · **不补位、不建会话、不改状态**：本段装配里**没有**
  //       `transport.spawnRole` / `store.recordDispatch` / 任何状态迁移入口；
  //       留痕只追加 `.pipeline/<任务>/audit.jsonl`，**不碰 `task.json`**
  //       （碰了会把巡检的"最后一次进展时刻"推前 = 机制自己制造进展）。
  //     · **认领不了就报"认领不了"**：依据缺失 / 损坏 / 恢复被拒 ⇒
  //       `warn` 喊出来 + `main:reattach-refused` 留痕，且**不静默跳过、不用近似物冒名**。
  // -------------------------------------------------------------------------
  /** 负缓存：扫过一次、一张都没认到的会话不再重复扫盘（见 lib/reattach.js 的说明）。 */
  const mainReattachCache = new Set()
  /** ★ "同一条认领不了"只报警/留痕一次（不刷屏）—— 但**每次都还进报告**，不静默。 */
  const mainReattachRefusalMemo = new Set()
  /**
   * ★ 认领入口（返回报告，同时把报告存进只读导出 `lastMainReattach()`）。
   *
   * 它被注入 `registerInterception()`，由那条**既有**的 `tools/pre-execute` 缝
   * 在**席位作用域判定之前**调用 —— 理由见上面那段注释。
   */
  const mainReattach = async (sessionId) => {
    const report = await autoReattachMain({
      store,
      tokens,
      sessionId,
      cache: mainReattachCache,
      refusalMemo: mainReattachRefusalMemo,
      log: (m) => ctx.logger?.info?.(m),
      warn: (m) => {
        ctx.logger?.warn?.(m)
        console.warn(m)
      },
    })
    LAST_MAIN_REATTACH = report
    return report
  }
  /**
   * 交给拦截缝的那个可调用体 —— 挂不上时是 `null`（缝里那一句就整体跳过）。
   *
   * `config.mainReattachEnabled === false` ⇒ 显式关闭，交 `null`（并**喊出来**）。
   */
  const mainReattachForSeam = config.mainReattachEnabled === false ? null : mainReattach
  /**
   * ★★ **A 件②（2026-10-16）**：同一条认领入口**也交给工具层** ——
   *   `pipeline_status` 的主对话身份自查会在"本会话还没绑上"时先试一次它，
   *   再决定要不要把那条手动命令印出来（见 `lib/tools/status.js` 的那一段）。
   *
   * 为什么同一个函数交两处而不是各写一份：判据**只有一份**（`lib/reattach.js` 的
   *   `judgeMainClaim`），两处只是**触发点**不同 —— 拦截缝（每一次工具调用）与
   *   状态查询（主对话出事时唯一一定会做的动作）。幂等由 `autoReattachMain`
   *   自己的快路径（"手上已经有 main 令牌 ⇒ 连盘都不扫"）保证。
   *
   * ⚠ 顺序：`deps` 在**上面**就建好了（普通对象，按引用），而 `buildTools(deps)`
   *   在**后面**才调 —— 所以这里补一个键是安全的，不是"改了已经用过的对象"。
   */
  deps.mainReattach = mainReattachForSeam
  if (config.mainReattachEnabled === false) {
    ctx.logger?.warn?.(
      '[pipeline] 主对话侧自动认领**已关闭**（config.mainReattachEnabled=false）—— DSH 重启后主对话**必须手动**重新认领（`pipeline_task_open { reattach: true }`）。',
    )
  }

  // -------------------------------------------------------------------------
  // 1.9) ★★ **孤儿单自恢复**（用户原话：「席位被切断后，机制要能**自己意识到**并
  //      **重新投递** —— 不是等人来救。」）
  // -------------------------------------------------------------------------
  //
  //   它补的是**唯一剩下没人管的那一格**：席位失联只**冻**不**叫**（`lib/liveness.js`），
  //   巡检只**播报**不**动作**（`lib/patrol.js`，用户裁定 A22 写死），运行失败中止
  //   是**另一条判词**（`lib/runfail.js`）。于是"席位被切断"的单就永远停在那里 ——
  //   现场两例：`T-20261011-4a2dc7`（`analyzing` / 0 交接物 / 连派活台账都没有）、
  //   `T-20261011-a5fe41`（机制阻塞 / planner 零交接物 / 会话 id 不是会话形状）。
  //
  //   ★ 纪律（写在装配上，不是写在善意里）：
  //     · **不建会话、不派新席位**（用户裁定：「不要求自动补新席位」）——
  //       这里注入的只有 `notify`，它就是 `pipeline_dispatch { notify_only: true }` 的
  //       **同一份实现**（`createSeatNotifier().notifyOnly`）；装配里**没有**
  //       `transport.spawnRole` / `store.recordDispatch` 这两条能造出席位的路；
  //     · **不改任务状态**：留痕走 `.pipeline/<任务>/audit.jsonl`（只追加），
  //       **不碰 `task.json`** —— 碰了就等于"机制自己制造了进展"，会把无进展计时清零；
  //     · **幂等与失败都复用既有账本**（`wake-ledger.jsonl`）：成功记 `record`、
  //       失败记 `noteUnresolved`（⇒ **既有巡检**那条 `unresolved-wake` 会播报出来）、
  //       连续失败到上限记 `markEscalated`（放弃，不再骚扰）；
  //     · 每轮**绝不抛**（抛出去会把定时器带死 —— 那正是"停摆"的成因）。
  //
  //   ★ 为什么必须在这里（`buildTools` **之前**）装配：`pipeline_status` 的"列全部任务"
  //     那一段要能把**最近一轮扫描的结论**当成只读可见面报出来（主对话不必读日志）。
  let orphanRescue = null
  if (config.orphanRescueEnabled === true) {
    const seatNotifier = createSeatNotifier(deps)
    orphanRescue = createOrphanRescue({
      store,
      ledger: wakeLedger,
      // ★ 重新投递 = `notify_only` 的同一份实现（不建会话、不改状态、失败返回 ok:false）。
      notify: (spec) => seatNotifier.notifyOnly(spec.task, spec.role, spec.seat, spec.text, false),
      wake: (spec) => wakeup.wake(spec),
      audit: createOrphanAudit((id) => store.auditFile(id), (m) => ctx.logger?.warn?.(`[pipeline] ${m}`)),
      detectRunFailure: async (task, seats) =>
        typeof store.detectRunFailure === 'function' ? store.detectRunFailure(task, seats) : null,
      intervalMs: config.orphanIntervalMs,
      graceMs: config.orphanGraceMs,
      backoffMs: config.orphanRedeliverBackoffMs,
      maxAttempts: config.orphanMaxRedeliverAttempts,
      warn: (m) => ctx.logger?.warn?.(m),
    })
    deps.orphanRescue = orphanRescue
    ctx.effect(() => () => orphanRescue.stop(), 'pipeline: orphan rescue (detect + redeliver)')
  }

  // -------------------------------------------------------------------------
  // 2) 工具面
  // -------------------------------------------------------------------------
  const tools = buildTools(deps)
  for (const [key, def] of Object.entries(tools)) {
    ctx.effect(() => ctx.tools.register(def), `pipeline: ${def.name}`)
    void key
  }

  // -------------------------------------------------------------------------
  // 2.05) ★★ **E4：跨项目"用户裁定"库**（装配期把本项目记忆库里的裁定发布成 SKILL.md）
  // -------------------------------------------------------------------------
  //
  //   用户裁定（本单硬约束①）：裁定库落成 **`<dsh-home>/skills/<名字>/SKILL.md`** ——
  //   **可见、可编辑**；**不用**运行时注册（`ctx.skills.register()`）⇒ 也**不把 `skills`
  //   写进 `inject`**（写进去就多一种"少一个服务依赖就装不上"的形态，而
  //   `tests/load-smoke.mjs:200` 把"依赖只有一个"写成了既有断言）。
  //
  //   ★ 四条硬要求全在 `lib/memory/user-rulings.js` 里（幂等 / 不覆盖外来文件 / 写前备份 /
  //     只在确有用例时写）。这里只负责"什么时候发布一次"：**装配期一次**，
  //     与巡检、孤儿单自恢复那些 `ctx.effect` 并列（同一个装配段、同一种语义）。
  //   ★ 总开关：off ⇒ `publishRulings()` 第一句就返回（面清单里的 `user-rulings` 那一行）。
  //   ★ 绝不抛：发布失败只留一句 warn（它不该影响工具面、守卫、拦截缝的挂载）。
  ctx.effect(() => {
    void publishRulingsForProject({
      projectDir: store.projectRoot,
      swOf: () => sw,
      warn: (m) => ctx.logger?.warn?.(`[pipeline] ${m}`),
    })
    return () => {}
  }, 'pipeline: user-rulings skill')

  // -------------------------------------------------------------------------
  // 2.1) ★★ **E 路 ③：按"该席位实际能用的工具面"惰性收紧**（少给定义 ≠ 放宽拒绝）
  // -------------------------------------------------------------------------
  //
  //   问题（现场口径）：31 个 `pipeline_*` 工具**对每个子代理全量注册** ——
  //   一个 `writer` 席位的每一轮请求里都背着 `pipeline_dispatch` / `pipeline_close` /
  //   `pipeline_supervise` 这些它**根本调不动**（守门按角色白名单直接拒）的工具 schema。
  //   那是**每个请求都要付**的固定成本，买到的是零能力。
  //
  //   参考 `dsh-ops` 的 `lib/session-shells.js:75-81`（用 `restrict({deny})` 遮蔽继承来的
  //   工具，而不是"不注册"）+ `lib/index.js:128-139`（提示词按**实际可见工具**惰性渲染，
  //   "absent tools never get advertised"）。
  //
  //   ★★ 五条纪律（写在装配上，不写在善意里）：
  //     ① **判据一个字没动**：本段只调 `agent.ctx.tools.restrict({deny})`
  //        （宿主 API），**不碰** `guard.js` / `guard-factory.js`，不放宽任何拒绝；
  //     ② **隐藏面 = 守门本来就会拒的那些**：面由 `lib/boundaries.js` 的
  //        `deriveToolFace()` 从**守门自己的判词**里读出来（`guardDecision` 对匿名
  //        调用方的原话 `允许角色：…`），**认不出就不收紧** —— 于是不可能藏掉
  //        一个守门会放行的工具（"漏一个 = 它干不了活"是硬约束）；
  //     ③ **主对话不收紧**（`deriveToolFace` 里写死 `main.denied = []`）：它是用户的对话框，
  //        也是"该知道有哪些工具"的那一方 —— 口径就是「主对话看到全量」；
  //     ④ **只在守门真的在执法时收紧**（`guardEnabled === true` 且总开关为开）：
  //        守门弃权时去隐藏工具，就成了"比守门更严"，那不是本次要的省字节；
  //     ⑤ **失败即放弃**：`restrict` 不可用 / 抛错 ⇒ 打一条 warn（一次）+ 不再重试，
  //        席位退回"全量可见"（= 改前行为），绝不因为收紧失败而影响任何一次工具调用。
  const pipelineFace = typeof deps.pipelineToolFace === 'function' ? deps.pipelineToolFace : null
  const tightenSeatFace = createSeatFaceTightener({
    tokens,
    config,
    sw,
    face: pipelineFace,
    warn: (m) => ctx.logger?.warn?.(m),
  })
  /** 交给工具层：每次工具调用之后再试一次（"角色刚被认领"就发生在那一刻）。 */
  deps.tightenSeatFace = tightenSeatFace
  /** ★ 只读面登记（`lastSeatFaceTighten()` 现算，见那边的注释）。 */
  noteSeatFaceTighten(tightenSeatFace)
  //
  //   ★ **为什么不挂 `ctx.on('agent/created')`**：`tests/load-smoke.mjs` 把
  //     「本插件挂在 `ctx.on` 上的事件**恰好是那三个**（tools/pre-execute ·
  //     agent/pre-step · tools/post-execute）」写成了**既有断言** —— 加一条新缝就红。
  //     而"少挂一条缝"本身也是对的：收紧的**唯一触发点**就是"这个会话动了流水线工具"
  //     （那也是它**角色被确定**的那一刻），不需要第二条生命周期缝。
  //     代价（如实写出来）：席位**首次**工具调用那一轮仍会看到全量 schema；
  //     从第二轮起就是收窄后的面。这是"惰性"的本义，不是缺陷。
  //     拿不到 `agent.ctx.tools.restrict` 时退回全量可见（= 改前行为）并打一条 warn，
  //     **不静默**、也不影响任何一次工具调用。

  // -------------------------------------------------------------------------
  // 3) 硬拦截
  // -------------------------------------------------------------------------
  //
  //   两条缝、**同一份判据**：
  //     · `ctx.tools.guard`      —— 工具服务那条路（靠令牌/会话绑定认人，同步）
  //     · `tools/pre-execute` 等 —— 宿主的**拦截扩展点**，按"这个会话是不是管线席位"认人
  //       （管线席位派生出来的子会话也躲不掉；详见 lib/intercept.js 的文件头）
  let guardFn = null
  if (config.guardEnabled === true || config.intercept === true) {
    guardFn = createGuardFor({
      tokens,
      config,
      taskIndex,
      sw,
      counter,
      retired: retiredAgents,
      // ★ 索引未命中要留痕（不是拒绝，是"这段判据没跑到"）—— 静默 fail-open 就是假绿。
      warn: (m) => ctx.logger?.warn?.(m),
    })
  }
  if (config.guardEnabled === true && guardFn !== null) {
    ctx.effect(() => ctx.tools.guard(guardFn), 'pipeline: separation-of-powers guard')
  }

  // -------------------------------------------------------------------------
  // 3.2) ★ 拦截缝：把同一份判据挂到宿主的工具前置/提示词/工具后置缝上
  // -------------------------------------------------------------------------
  //
  //   用户原话：「我是让你安排写入多 ai 协同插件中去阻止他们干不该干的事，而不是新写」。
  //   所以它挂在**本插件**里，不是另起一套 Skill + 钩子。
  //
  //   作用域：**只有本插件派出去的管线席位**受影响（判据 = 该 agentId 在令牌表里绑了角色）；
  //   其它会话（用户自己的对话、别的项目、别的插件）一律直通。
  //   kill-switch：`config.intercept === true`（配置层）+ 总开关（即时）。
  //   ★ 总开关的判据**只有一处**：`lib/switch/gate.js` 的 `isEnabled()` / `shouldFire()`。
  //     四条缝**关掉时不挂**（真挂真摘，见 `lib/intercept/registry.js`），且各自第一句
  //     仍问一次闸门 —— 两层，前者可断言"挂着的缝 = 0"，后者覆盖两次采样之间的调用。
  let interception = null
  if (config.intercept === true && guardFn !== null && typeof ctx.on === 'function') {
    try {
      interception = registerInterception(ctx, {
        tokens,
        guard: guardFn,
        sw,
        warn: (m) => ctx.logger?.warn?.(m),
        getTask: (taskId) => store.peek?.(taskId) ?? null,
        /**
         * ★★ **拦截缝的留痕落点**（用户裁定：「只有'拒绝'没有'说明' = 失败」）。
         *
         * 落 `.pipeline/<任务>/audit.jsonl`（**只追加**）—— 与 `lib/reattach.js` 的
         * 认领留痕、`lib/orphan.js` 的自恢复留痕**同一份文件、同一套行格式**。
         * ⚠️ **刻意不走 `store.recordAudit()`**：那个会 push `task.history` 并重写
         *    `task.json`，而**"拒绝"不是进展** —— `lib/patrol.js` 的
         *    "最后一次进展时刻"读的正是 `history` 的末条（同 `lib/reattach.js:498-505`）。
         */
        auditFileOf: (id) => store.auditFile(id),
        /**
         * ★★ **主对话侧的重启自动认领**（D1 第 1 件）—— 搭在这条**既有**缝的最前面调用。
         *
         * 为什么搭这里而不是自己再挂一条 `ctx.on('tools/pre-execute')`：
         * `tests/load-smoke.mjs` 把"`tools/pre-execute` 恰好 1 条中间件"写成了既有断言，
         * 而"不许改既有断言/期望值"是硬约束。本调用**不改变**这条缝的任何决议。
         */
        mainReattach: mainReattachForSeam,
        // ★★ 交付即唤醒：拦截缝的触发点（post-execute 交付 / 失联自动阻塞）
        //    投递用的**同一个**入口（幂等与投递路径都在 lib/wakeup.js 里，唯一一份）。
        wakeMain: (spec) => wakeup.wake(spec),
        /**
         * ★★ **唤醒器本体**（不只是投递入口）—— 拦截缝要用它的两件事：
         *   · A28(b)：席位**接管**留痕（席位下一次动工具时记一笔）；
         *   · 席位侧投递的成败留痕（`seat:wake-delivered` / `seat:wake-failed`）。
         */
        waker: wakeup,
        // ★ 失联检测的静默阈值（席位简报里那条提示要用它，与 store 用**同一个**值）
        seatSilenceMs: config.seatSilenceMs,
        // ★★ 记忆域（E1）：项目目录（算 `.pipeline/_memory/` 落点）+ 计价器（注入的硬上限）。
        projectDir: projectRoot,
        tokenMeter: (() => {
          try {
            return ctx.tokenMeter ?? null
          } catch {
            return null
          }
        })(),
        /**
         * ★ 失联检测的**处置**入口（`tools/pre-execute` 那条缝调它）。
         *
         * 两件事必须一起做，所以包在这里而不是直接暴露 store 方法：
         *   ① 查 + 必要时把任务推到「已阻塞」；
         *   ② **立刻刷新同步索引** —— `taskIndex` 是守门判据的同步数据源，
         *      状态变了不刷索引，后面那段判据就会拿旧状态判（"失败分支没刷新同步索引
         *      ⇒ 拦截静默失效"—— 这个坑本项目踩过一次，这里显式堵上）。
         */
        checkLiveness: async (taskId) => {
          if (config.seatLivenessEscalate !== true) {
            // 只报告不处置：仍然算一遍并留痕，但不动状态。
            const r = await store.checkLiveness(taskId, { escalate: false })
            return r
          }
          const r = await store.checkLiveness(taskId, { escalate: true })
          if (r !== null && r !== undefined && r.task !== undefined && r.task !== null) indexTask(r.task.id, r.task)
          return r
        },
      })
      ctx.effect(() => interception.dispose, 'pipeline: interception seams')
      // ★ 如实播报：本条由本插件管，但**此刻真的挂着几条**要看闸门（关掉 ⇒ 0 条）。改前那句
      //   无条件说"已挂"，开关关着时它就是假的 —— 与"开关只关一半"同一类问题。
      ctx.logger?.info?.(
        `[pipeline] 拦截缝就绪：${interception.seams.join(' / ')}（只对管线席位生效；` +
          `当前挂载 ${interception.mounted().length} 条${interception.mounted().length === 0 ? ' —— 总开关是关的，一条都不挂' : ''}）`,
      )
    } catch (err) {
      ctx.logger?.warn?.(`[pipeline] 拦截缝挂载失败（守门与工具不受影响）：${String(err?.message ?? err)}`)
    }
  }

  // -------------------------------------------------------------------------
  // 3.3) ★★ 巡检兜底（A21–A25；用户裁定 D4「加一条巡检兜底」）
  // -------------------------------------------------------------------------
  //
  //   它修的正是**唯一剩下的静默面**：「席位中止的播报恰好也不通」。
  //   中止检测挂在"下一次工具调用 / 下一次开步"上（写时检查，见 intercept），
  //   而"没有任何人在动"恰恰让那两个触发点都失效 —— 所以需要一条**与任何人无关的**
  //   周期性检查：它只回答「这张单已经多久没有任何进展了？」，然后**播报**出去。
  //
  //   ★ 纪律（写在判据里，不是写在善意里）：
  //     · **只播报，不动作** —— 巡检器自己不认识任何"补位 / 继任 / 冻结 / 解冻 /
  //       推进状态 / 重置失联计数"的接口（结构上就做不到，A22/B17）；
  //     · 与**失联检测不同源、互不冒充**（A24）：失联 = 静默**超阈值**（判词在
  //       `lib/liveness.js`），巡检 = **无进展**超口径（判词在 `lib/patrol.js`）；
  //       巡检不调用 `checkLiveness`，一次都不调；
  //     · 同一条无进展跨多次巡检**只播一次**（身份 = `<状态>|<最后进展时刻>`，
  //       跨进程靠已播报账本去重）；进展恢复后再卡住算**新的一条**（A23）；
  //     · 巡检自己抛错**不许停摆**，连续失败到阈值就把"巡检已停摆"播出去（A25）。
  let patrol = null
  if (config.patrolEnabled === true) {
    /** 内存节流：同一个 finding 在窗口内不重复走唤醒路径（跨进程去重仍靠账本）。 */
    const reportedFindings = new Map()
    const PATROL_REPORT_WINDOW_MS = 30 * 60 * 1000
    const noteFinding = (id, atMs) => {
      reportedFindings.set(id, atMs)
      if (reportedFindings.size > 512) {
        const oldest = [...reportedFindings.entries()].sort((a, b) => a[1] - b[1])[0]
        if (oldest !== undefined) reportedFindings.delete(oldest[0])
      }
    }
    const reportFinding = async (taskId, task, finding) => {
      const nowMs = Date.now()
      const last = reportedFindings.get(finding.id)
      if (last !== undefined && nowMs - last < PATROL_REPORT_WINDOW_MS) return false
      noteFinding(finding.id, nowMs)
      /**
       * ★★ **正文按判据本身写**（缺陷 ⑥，真机 T-20261015-bb30bc）。
       *
       * 改前这里把 `what` 写死成「**巡检发现长时间无进展**」，而
       * `patrolFindings()` 会出**五种**判据 —— 于是"一条唤醒没投出去"
       * （`unresolved-wake`）也被报成"长时间无进展"：主对话被引去查"谁不动了"，
       * 真正该处理的那件事没人管。
       * 文案唯一出处：`lib/patrol/notice-text.js`（本文件不存第二份）。
       */
      const notice = patrolNotice(finding)
      await wakeup.wake({
        taskId,
        actorRole: 'mechanism',
        actorSeat: null,
        kind: notice.kind,
        what: notice.what,
        disc: String(finding.id ?? ''),
        identitySource: 'patrol-finding',
        task,
        note: notice.note,
        via: 'patrol',
      })
      return true
    }
    patrol = createPatrol({
      intervalMs: config.patrolIntervalMs,
      failureThreshold: 3,
      warn: (m) => ctx.logger?.warn?.(m),
      /**
       * ★ A25 的最小出口：tick 整体抛错到阈值时，**不依赖 tick** 地把"巡检已停摆"
       *   播出去（往账本里认得的那几张单各播一条；同一次停摆只播一条 —— 身份含段号）。
       */
      onStalled: async (stats) => {
        const ids = wakeLedger.knownTaskIds()
        for (const id of ids) {
          const task = await store.get(id)
          if (task === null) continue
          await wakeup.wake({
            taskId: id,
            actorRole: 'mechanism',
            actorSeat: null,
            kind: 'patrol-stalled',
            what: '**巡检自身已停摆**（连续抛错到阈值）',
            disc: `patrol-stalled|${Number(stats?.stall_episodes ?? 1)}`,
            identitySource: 'patrol-stalled',
            task,
            note:
              `巡检已连续失败 ${Number(stats?.consecutive_failures ?? 0)} 次（阈值 ${Number(stats?.failure_threshold ?? 3)}），` +
              `最后一次错误：${String(stats?.last_error ?? '(无)')}\n` +
              '★ 停摆本身**必须可见**（A25）；巡检仍在**继续重试**，恢复后这一条不会重复播报。',
            via: 'patrol',
          })
        }
      },
      tick: async ({ stats }) => {
        const list = await store.list()
        for (const entry of list) {
          const task = await store.get(entry.id)
          if (task === null) continue
          const res = patrolFindings({
            task,
            now: Date.now(),
            stallMs: config.patrolStallMs,
            unconsumed: wakeup.pendingDeliveries(entry.id, { olderThanMs: config.wakeUnconsumedMs, limit: 5 }),
            unresolved: wakeLedger.unresolvedEntries({ taskId: entry.id, limit: 5 }),
            patrolFailures: Number(stats?.consecutive_failures ?? 0),
            failureThreshold: Number(stats?.failure_threshold ?? 3),
            stallEpisodes: Number(stats?.stall_episodes ?? 0),
            patrolOwner: 'patrol',
          })
          for (const f of res.findings) await reportFinding(entry.id, task, f)
          /**
           * ★ R1：**未被消费的投递不得从此静默消失** —— 由唤醒器发一条**可配对读出
           *   的升级事件**（不是把原事件原地重放）。它只在"没被消费且没升过级"时发，
           *   一旦被消费即不再发（判据在 `wakeup.escalateUnconsumed`）。
           * ★ P0-3 收口：终态单不进升级链 —— 终态没有合法事件，主对话"消费"不了它，
           *   发出去只会是一条永远没人接的升级（A 路报告 §6.2 的已知边界）。
           */
          if (TERMINAL_STATES.includes(task.state)) continue
          await wakeup.escalateUnconsumed(entry.id, { olderThanMs: config.wakeUnconsumedMs, limit: 2, reason: 'patrol:unconsumed' })
        }
      },
    })
    ctx.effect(() => () => patrol.stop(), 'pipeline: patrol (report-only sweep)')
  }

  // -------------------------------------------------------------------------
  // 3.4) ★★ **孤儿单自恢复的扫描器启动**（装配见 1.9；这里只负责起表）
  // -------------------------------------------------------------------------
  //
  //   ★ 它与上面那条巡检**是两条并行的周期**，各自跑各自的：
  //     · 巡检（3.3）**只播报**「长时间无进展」——A22 的不动作纪律一个字没动；
  //     · 自恢复（本条）**识别 + 自己重新投递**（走 `notify_only` 的同一份实现）。
  //   判据不同源、动作不同，互不冒充（A24 的同一条纪律）。
  if (orphanRescue !== null) {
    // 起停与**如实播报**都在 `lib/switch/mechanisms.js` 的条目工厂里（本文件不写第二份）。
  } else {
    ctx.logger?.info?.('[pipeline] 孤儿单自恢复已关闭（config.orphanRescueEnabled=false）—— 席位被切断时不会有人重新投递。')
  }

  // -------------------------------------------------------------------------
  // 3.4.1) ★★ **总开关 = 唯一权威：关 ⇒ 两条周期机制整个停表**（缺陷的"半挂面"）
  // -------------------------------------------------------------------------
  //
  //   改前这两条周期的定时器与开关**毫无关系**：关掉功能之后它们照跑照写
  //   （往会话注入 + 写 `.pipeline` 账本/审计 + 主动往席位会话重投）。
  //   现在交给 `lib/switch/mechanisms.js`：**停表**（不是"跑着但空转"），
  //   订阅式跟随开关翻转，起停幂等、抛错只留痕。
  //   为什么是导出工厂而不是写在这里：它会真的起停定时器、真的影响磁盘写入，
  //   必须能被自测独立复现与断言（与 `createSeatFaceTightener` 同一条理由）。
  // -------------------------------------------------------------------------
  {
    const mechanisms = createSwitchDrivenMechanisms({
      sw,
      warn: (m) => ctx.logger?.warn?.(m),
      items: createMechanismItems({
        patrol,
        orphanRescue,
        config,
        log: (m) => ctx.logger?.info?.(m),
      }),
    })
    ctx.effect(() => () => mechanisms.dispose(), 'pipeline: switch ⇄ 周期机制起停')
  }

  // -------------------------------------------------------------------------
  // 3.5) 开关的 HTTP 面（客户端 UI 用）
  // -------------------------------------------------------------------------
  //
  // ★ 仍然**不把 webServer 写进 inject**：那样在没有 webServer 的形态（headless）下
  // 整个插件都不会激活，而守门与工具在 headless 下照样有用。
  //
  // ★ 但也不能"在 apply 里探测一次就完事"——探不探得到取决于**激活顺序**：
  //   本插件只 inject `tools`，`tools` 一就绪它的 fiber 就激活；而 `webServer`
  //   是后一层的插件才提供的。两者一前一后时那次探测必然拿到 undefined，
  //   于是路由永远挂不上 —— 表现就是工具全都注册成功、`/.dsh-pipeline/state`
  //   却一直 404（实测确认过这条）。
  //   真实 cordis 上的语义微测：先提供 webServer 时 `ctx.get('webServer')`
  //   拿得到服务；后提供时拿到的就是 undefined（且 `ctx.webServer` 属性直读会抛
  //   `cannot get property "webServer" without inject`）。
  //
  // ★ 所以改用 cordis 的**可选注入**惯用法 `ctx.inject(['webServer'], cb)`
  //   （`@deepseek-ai/cordis/src/registry.ts:300-302`，机制是 fiber 的依赖触发：
  //   `fiber.ts:611-623` 的 `_refresh()`）。它建一个**子 fiber**：
  //     · webServer 可用 ⇒ 回调跑 ⇒ 挂路由（disposer 记在这个子 fiber 上）；
  //     · webServer 不可用/被卸载 ⇒ 回调不跑/子 fiber 卸载 ⇒ 路由自动摘掉。
  //   于是有 webServer 就挂、没有就静默跳过：apply 照常跑完，工具与守门照常注册。
  //
  // ⚠️ 回调是**异步**跑的（cordis `fiber.ts:650` 先 `await Promise.resolve()`），
  //    所以"挂上了没有"这句话只能由回调自己说，不能拿 apply 结尾那一刻的状态去断言。
  let routeMounted = false

  /** 把路由挂到 target（有 webServer 才算数）；返回是否挂上。 */
  const mountSwitchRouteWhenReady = (target, via) => {
    try {
      const mounted = mountSwitchRoute(target, {
        sw,
        version: TOOL_VERSION,
        log: (m) => target.logger?.debug?.(`[pipeline] ${m}`),
      })
      if (mounted === null) return false
      target.effect(() => mounted.dispose, 'pipeline: switch route')
      routeMounted = true
      const rmsg =
        `[pipeline] 开关 UI 端点已挂载：GET/POST ${STATE_PATH}` +
        `（右上角「多AI 协调」按钮走它；经 ${via}）。`
      target.logger?.info?.(rmsg)
      console.log(rmsg)
      return true
    } catch (err) {
      // 路由注册失败（例如别人已经占了同一前缀）不该让整个插件不激活。
      target.logger?.warn?.(
        `[pipeline] 开关路由挂载失败（UI 按钮会显示未知，pipeline_switch 工具仍然可用）：${String(err?.message ?? err)}`,
      )
      return false
    }
  }

  let routeDeferred = false
  if (config.switchRoute !== false) {
    if (typeof ctx.inject === 'function') {
      routeDeferred = true
      ctx.inject(['webServer'], (child) => {
        mountSwitchRouteWhenReady(child, 'ctx.inject(["webServer"])')
      })
    } else {
      // 没有 ctx.inject（非 cordis 宿主 / 极老形态）：退回运行期探测，能挂就挂。
      routeDeferred = false
      mountSwitchRouteWhenReady(ctx, "ctx.get('webServer')（运行期探测）")
    }
  }

  // -------------------------------------------------------------------------
  // 4) system prompt 段（告诉模型这套流水线怎么用）
  // -------------------------------------------------------------------------
  //
  //   ★★ **E 路 ③：按"实际可见工具"惰性渲染**（参考 `dsh-ops` 的
  //      `lib/index.js:128-139` + `lib/policy.js:26-66` —— 那个 `text` 回调收
  //      **本次会话的 context**，于是提示词能随"这个会话实际有哪些工具"收缩；
  //      作者的原话是 "absent tools never get advertised"）。
  //
  //   ★ 三条纪律：
  //     ① **默认逐字节不变**：拿不到 context / 拿不到角色 / 角色是 main ⇒ 原样返回
  //        `PIPELINE_PROMPT`（这就是改前那一个字符串，一个字节都没动）；
  //     ② **只对"已认领角色的席位"收缩**，且**只丢别的角色的段落**（那些话本来就不是
  //        说给它听的）—— 六条规则、开工顺序、收尾那句**一律保留**（那是行为契约）；
  //     ③ **不广告不存在的东西**：末尾那行"你可见的工具"取自**与收紧同一份**工具面
  //        （`deps.pipelineToolFace()`），所以"提示词说的"与"它真能调到的"不可能漂移。
  if (config.registerPromptSection === true) {
    try {
      ctx.systemPrompt?.section?.({
        name: 'pipeline:roles',
        order: PROMPT_ORDER,
        text: (context) => renderPromptForContext(context, { tokens, face: pipelineFace }),
      })
    } catch (err) {
      ctx.logger?.warn?.(`[pipeline] system prompt 段注册失败（不影响工具与守门）：${String(err?.message ?? err)}`)
    }
  }

  const snap = sw.snapshot()
  const msg =
    `[pipeline] ${NS} ${TOOL_VERSION} 已加载：29 个 pipeline_* 工具已注册；` +
    (config.guardEnabled === true ? '守门已启用；' : '**guardEnabled=false（没有硬拦截）**；') +
    `通道=${transport.kind}（transport=${config.transport}，spawnRoles=${config.spawnRoles !== false}）；` +
    `真实会话通道=${channelProbe.ok ? '可用' : '**不可达**'}${channelProbe.ok ? '' : `（缺 ${channelProbe.missing.join('、')}）`}；` +
    `工作区=${join(projectRoot, config.artifactDirName)}；` +
    `多AI 协调开关=**${snap.on ? '开' : '关'}**（revision ${snap.revision}${snap.restored ? '，自状态文件恢复' : '，默认值'}）。`
  ctx.logger?.info?.(msg)
  console.log(msg)

  // ★ 通道不可达要**喊出来**（不是只在返回值里）：先上报、不静默降级。
  if (channelProbe.ok !== true) {
    const wmsg =
      '[pipeline] ⚠ 真实会话派活通道**不可达**，已按「先上报、不静默降级」停住（不会自动退回子代理）：\n' +
      channelProbe.evidence.map((e) => `  · ${e}`).join('\n') + '\n' +
      '  降级方案（交用户裁定后再改配置）：\n' +
      channelProbe.degradations.map((x, i) => `  ${i + 1}. ${x}`).join('\n')
    ctx.logger?.warn?.(wmsg)
    console.warn(wmsg)
  }

  if (routeMounted) {
    // ★ 关掉时的说明**唯一出处**在 `lib/switch/text.js`（与 `pipeline_switch` 的返回同一份）。
    const rmsg =
      `[pipeline] 开关 UI 端点已就绪：GET/POST ${STATE_PATH}（右上角「多AI 协调」按钮走它）。` +
      offModeStartupLines(snap, STATE_PATH).join('')
    ctx.logger?.info?.(rmsg)
    console.log(rmsg)
  } else if (config.switchRoute !== false) {
    // routeDeferred 时 apply 已经登记了可选注入 —— 此刻没挂上不代表最终没挂上
    // （回调至少晚一个微任务），所以这里不能报"未挂载"。
    const rmsg = routeDeferred
      ? `[pipeline] 开关 UI 端点：已登记可选注入（webServer），服务就绪后自动挂载 ${STATE_PATH}；` +
        'headless 形态下它永远不会就绪 —— 那是设计内的降级，不是故障。'
      : `[pipeline] 未挂载开关 UI 端点（拿不到 ctx.webServer，或前缀 ${ROUTE_PREFIX} 已被占用）—— ` +
        '右上角不会出现「多AI 协调」按钮；开关仍可用 pipeline_switch 工具切换。'
    if (routeDeferred) {
      ctx.logger?.info?.(rmsg)
      console.log(rmsg)
    } else {
      ctx.logger?.warn?.(rmsg)
      console.warn(rmsg)
    }
  }
}

/**
 * `defineTool` 从 `@deepseek-ai/dsh-tools` 拿。
 *
 * 解析不到时退化成"恒等函数"：这时工具定义仍是合法对象（注册表只需要
 * name/description/parameters/output/execute），插件还能工作 ——
 * 总比整行 import 失败、插件完全不激活要好。退化会打一条警告日志。
 */
let DEFINE_TOOL = (definition) => definition
let DEFINE_TOOL_DEGRADED = true
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (typeof mod.defineTool === 'function') {
    DEFINE_TOOL = mod.defineTool
    DEFINE_TOOL_DEGRADED = false
  }
} catch {
  /* 保持退化实现 */
}
if (DEFINE_TOOL_DEGRADED) {
  console.warn(
    '[pipeline] 未能解析 @deepseek-ai/dsh-tools：defineTool 退化为恒等函数。\n' +
    '[pipeline] 这不再是致命故障 —— lib/tools.js 自己就吐严格 JSON Schema' +
    '（required 为字符串数组、parameters 带 type/properties），' +
    '宿主 Tools.register() 的 assertSupportedJsonSchema 仍会通过，工具照常注册。'
  )
}

/** 给 index.js 的使用者一个查询退化状态的出口（bin/ 与自测会用到）。 */
export function isDefineToolDegraded() {
  return DEFINE_TOOL_DEGRADED
}

/**
 * ★ 上一次 `apply()` 时**真实会话派活通道**的能力探测结论。
 *
 * 为什么必须能查：派活通道的「可达 / 不可达 + 证据 + 降级方案」如果只写在日志里，
 * 排查时就得翻日志；它是**判决**，得能被程序读到、被自测断言、被审查引用。
 */
let LAST_CHANNEL_PROBE = null
export function lastChannelProbe() {
  return LAST_CHANNEL_PROBE
}

/**
 * ★★ 最近一次**主对话侧自动认领**的结论（只读导出）。
 *
 * 为什么必须能查（与 `lastChannelProbe()` 同一条理由）：认领是**判决** ——
 * 「它凭什么认定这个会话是这张单的主对话」「认领上了没有 / 为什么认领不了」
 * 如果只活在一次工具调用的返回值或日志里，审查与自测就没法**程序化**核对它。
 *
 * 字段（完整定义见 `lib/reattach.js` 的 `autoReattachMain` 返回值）：
 *   · `session_id` / `swept` / `reason`（结论码取自 `CLAIM_REASONS`）
 *   · `claims[]`  —— 认领成功的单（`restored` 标明"令牌是按台账认回来的"）
 *   · `refused[]` —— **认领不了**的单（`reason` + `detail` + `evidence` 原文）
 *   · `created_sessions` / `created_seats` / `touched_task_json` —— 机械判据：
 *     本机制**没有**创建会话、没有派席位、没有改 `task.json`（三个恒为 0/false）。
 *
 * 取值出口还有一条给人看的：`formatMainReattachReport()`（`lib/reattach.js`）。
 */
let LAST_MAIN_REATTACH = null
export function lastMainReattach() {
  return LAST_MAIN_REATTACH
}

/** 导出配置默认值，便于文档与自测引用同一份。 */
export { DEFAULTS }

/**
 * 注册进 system prompt 的说明。
 *
 * 写得短而硬：模型要先知道"你是谁、你不能干什么"，才谈得上协作。
 * 措辞里刻意保留"必须/不得"这类硬词，因为它是给模型看的行为契约。
 */
export const PIPELINE_PROMPT = [
  '本机装有多对话 AI 协作开发流水线（dsh-pipeline）。它的核心是「主对话只调度不干活；编写/测试/审核三权分立」。',
  '',
  '★ 这套流水线的**设计目的**是**防过度工程化**：每个 AI 只干自己该干的。六条规则：',
  '  ① **编程别跑测试**：编写角色跑测试类命令（npm test / pytest / node --test / node tests/xxx）会被拒；',
  '     你也不能产出测试报告或测试结论（用例、通过证据、判定全是 tester 的产物）。',
  '  ② **编排别看代码**：主对话 / 需求分析 / 计划**读不到源码正文**（read、检索工具、shell 读都会被拦），',
  '     你们的产物里也不许出现代码正文；只吃需求档 + 脱敏摘要 + 只给路径的目录结构。',
  '  ③ **最小改动**：计划的 change_scope 是**授权改动面**，编写只能在这个清单内动 ——',
  '     **新增文件也算越界**；"顺手重构 / 统一风格 / 升级依赖"= 没有授权 = 不许；',
  '     要扩大范围就走澄清/变更拿到新授权。dev_to_test 必须带 change_manifest（每条引用一个授权条目）。',
  '  ④ **职责自限**：需求分析与计划的产物里要写明"我只做什么、不做什么"（role_scope），',
  '     计划还要为**每个执行角色**写边界卡（role_boundaries），派活时按它派 —— 别让谁顺手多干。',
  '  ⑤ **双轨派活**：计划一出，**编写与审核同时接任务** —— 审核开工前就拿到授权面、越界清单、',
  '     自己的边界卡与改动基线；但它**不能提前出结论**（链路不变：编写 → 测试 → 才交审核）。',
  '  ⑥ **审核只读 + 前后版本对比**：审核除了自己的日志（.pipeline/<任务>/reports/reviewer/*.log）',
  '     **什么都写不了**；它靠**改动基线**做前后版本对比（pipeline_change_audit），把"多改 / 少改 /',
  '     改错地方"写进 review_verdict.change_audit；有多改就不许发 OK。',
  '',
  '★ **跑 shell 的写法（省的是最贵的一种失败）**：多行命令，或命令里带引号 / 反斜杠 / 中文 / 换行时，',
  '  **不要**整段塞进 shell 的 command 参数 —— 先把脚本落到**你有权写的位置**，再执行那个文件',
  '  （`pwsh -File x.ps1` / `bash x.sh`）。为什么：Windows + PowerShell 下**多层转义**（引号/中文/路径/换行叠在一起）',
  '  会把**工具调用本身的 JSON** 写坏 ⇒ MALFORMED_RESPONSE —— 它作废的不是一次调用，而是**整轮**',
  '  （连此前积累的全部上下文一起丢），是 token 消耗里最贵的一种形态。多花一次 write，换整轮不炸。',
  '  ★ 它是**写法**，不是后门：落盘的脚本与直接写在 command 里的命令，受**同一套判据**管，',
  '    脚本落在授权面之外照样被拒（新增文件也要在授权面里）。',
  '',
  '如果你是被开单的主对话：你只负责接需求、开单、按角色清单派活、跟踪状态、收到审核 OK 后关单。',
  '你**不读代码、不写代码、不跑测试、不做技术判断**，也**不自行决定要调用几个 AI** —— 那是计划 AI 的产物。',
  '要增减角色，只能走「执行角色提申请 → 计划 AI 复核」，你不能自己批。',
  '',
  '★ 开工前的顺序是固定的：① 需求分析（orchestrator）出任务卡 + **需求不清楚处清单**；',
  '   ② 把不清楚处交**用户**人工确认（你是唯一的通道，不得替用户拍板）；',
  '   ③ 确认后派计划 AI（planner）出计划 → 自检 → **分配 AI**（角色清单 / 用几个 / 派谁 / 什么顺序 / 按层分席位）。',
  '   计划自检发现缺失时，planner 会走澄清梯退回需求分析；需求分析答不了才升级到你 → 用户。',
  '',
  '如果你是编写角色：按任务卡改程序、自测，然后产出 dev_to_test 交接物**直接提交测试**。你不能直接提交审核。',
  '  多席位时你只写自己那一段（按层分工，范围由 scope_paths 卡死）；**越界写别人的分区会被守门拦下**。',
  '  **不要跑测试** —— 构建/启动级冒烟可以（npm run build / node build.mjs），但"通过与否"由 tester 判。',
  '如果你是测试角色：独立设计用例并执行，通过后产出 test_to_review 交审核；不通过就用 pipeline_rework 打回编写。',
  '**你不能替编写改代码** —— 发现了缺陷就打回，不要自己动手。',
  '如果你是审核角色：核对需求、产物、测试报告，通过就产出 conclusion=OK 的 review_verdict，否则用 pipeline_rework 打回。',
  '',
  '每一个动作都要带 role_token；每个环节都要产出结构化交接物；状态推进由机制判定，不接受"我觉得可以了"。',
].join('\n')

// ---------------------------------------------------------------------------
// ★★ E 路 ③：**按"实际可见工具"惰性渲染提示词**
// ---------------------------------------------------------------------------
//
//   `PIPELINE_PROMPT` 是**每个会话**都会拿到的那一段。里面有几段话是**只对某个角色**
//   说的（"如果你是被开单的主对话…" / "如果你是编写角色…" / …），而一个席位每轮请求
//   都要背着其它角色那几段 —— 那是固定成本，且对它毫无用处。
//
//   这里做的事**只有一件**：给**已认领角色的非主对话席位**渲染一份"只留它自己那一段 +
//   它实际可见的工具清单"的版本。判据全在下面这几条上，**不猜**：
//     · 拿不到 context / 拿不到 agent id ⇒ 原样返回全文（**默认逐字节不变**）；
//     · `roleOfAgent` 查不到角色（用户自己的会话、还没认领的席位）⇒ 原样返回全文；
//     · 角色是 `main` ⇒ 原样返回全文（"主对话看到全量"是同一条口径）；
//     · 其它情况才收缩，且**只丢别的角色的段落**（六条规则 / 开工顺序 / 收尾一律保留）。
//
//   ★ 段落边界**由标记行算出来**（不是写死行号）—— 上面那个数组被谁改了一行，
//     这里跟着变，不会错位。

/** 段落标记（`key` 是"这一段是说给谁的"；顺序即数组里的顺序）。 */
const PROMPT_BLOCK_MARKS = [
  { key: 'main', at: '如果你是被开单的主对话：' },
  { key: 'order', at: '★ 开工前的顺序是固定的：' },
  { key: 'writer', at: '如果你是编写角色：' },
  { key: 'tester', at: '如果你是测试角色：' },
  { key: 'reviewer', at: '如果你是审核角色：' },
  { key: 'tail', at: '每一个动作都要带 role_token；' },
]

/** 角色 → 它自己那一段的 `key`（没有专属段落的角色返回 null）。 */
function promptBlockOfRole(role) {
  if (role === ROLE.WRITER) return 'writer'
  if (role === ROLE.TESTER) return 'tester'
  if (role === ROLE.REVIEWER) return 'reviewer'
  if (role === ROLE.MAIN) return 'main'
  return null
}

/**
 * 渲染"席位版"提示词：**只留它自己那一段**，并列出它**实际可见**的工具。
 *
 * @param {string} role - 角色 id
 * @param {string[]} toolNames - 该角色可见的 `pipeline_*` 工具（来自 `deriveToolFace`）
 * @returns {string}
 */
export function seatPrompt(role, toolNames = []) {
  const lines = PIPELINE_PROMPT.split('\n')
  const marks = []
  for (const m of PROMPT_BLOCK_MARKS) {
    const i = lines.findIndex((l) => l.startsWith(m.at))
    if (i >= 0) marks.push({ ...m, at: i })
  }
  const want = promptBlockOfRole(role)
  const keep = new Set(['order', 'tail'])
  if (want !== null && want !== 'main') keep.add(want)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const owner = marks.filter((m) => m.at <= i).pop()?.key ?? 'head'
    // 段落按**归属**判：头（六条规则那一带）与 `order` / `tail` 永远保留，
    // 只丢"说给别的角色听"的那几段。
    if (owner === 'head' || keep.has(owner)) out.push(lines[i])
  }
  const zh = ROLES[role]?.zh ?? role
  const toolLine =
    toolNames.length === 0
      ? `★ 你是「${zh}」（${role}）。本会话**没有任何** pipeline_* 工具可见 —— 需要流水线动作时交给主对话。`
      : `★ 你是「${zh}」（${role}）。本会话**可见**的流水线工具 ${toolNames.length} 个：${toolNames.join('、')}。\n` +
        '  其余 pipeline_* 工具**不在你的工具面上**（少给定义 ≠ 放宽拒绝：它们本来就会被守门按角色白名单拒）。\n' +
        '  需要它们做的事，交回主对话或对应角色。'
  // 丢段之后可能留下连续空行 —— 收成单空行（不留"排版垃圾"）。
  return (out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n\n' + toolLine).trim()
}

/** 最近一次"提示词按可见工具渲染"的结论（只读导出 —— 判决要能被程序化核对）。 */
let LAST_PROMPT_RENDER = null
/**
 * 读最近一次的渲染结论。
 *
 * 为什么要它：`text` 回调的 context 形态是**宿主的**契约，若哪天它变了，
 * 本机制会**静默退回全文**（那是安全方向，但"没生效"必须看得见）。
 * 所以每次渲染都留一份结论在这里，自测/审查可以直接读它，不必猜。
 */
export function lastPromptRender() {
  return LAST_PROMPT_RENDER
}

/**
 * ★★ **E 路 ③ 的"施加器"**：把一个会话的工具面收紧到"它这个角色实际能用的那些"。
 *
 * 为什么单独做成一个**导出的工厂**（而不是埋在 `apply()` 里）：
 *   "收紧"是一次会**真的改会话工具面**的动作，所以它必须可被**独立复现与断言** ——
 *   自测要能拿一个真令牌 + 一份真工具面把它跑一遍，看它到底给宿主递了什么
 *   `deny` 列表。埋在 `apply()` 里就只能靠读代码相信。
 *
 * ★ 五条纪律（与 `apply()` 里那段注释同源，这里写死成判据）：
 *   ① 只调宿主的 `agent.ctx.tools.restrict({ deny })`，**不碰任何守门判据**；
 *   ② `deny` **只**来自 `deriveToolFace()`（守门判词推导），推导不可用 ⇒ 空集 ⇒ 不收紧；
 *   ③ `main` 的角色面为空（`deriveToolFace` 写死）⇒ 主对话永不收紧；
 *   ④ `guardEnabled !== true` 或总开关为关 ⇒ 不收紧（守门弃权时不去"比守门更严"）；
 *   ⑤ 任何异常 ⇒ 打一条 warn（每实例一次）后放弃，**不抛**、不影响工具调用。
 *
 * @param {object} opts
 * @param {object} opts.tokens - 令牌表（`roleOfAgent` 是唯一的认人依据）
 * @param {object} opts.config - 插件配置（只看 `guardEnabled`）
 * @param {{isOn?:Function}} [opts.sw] - 总开关
 * @param {Function|null} [opts.face] - `() => 工具面`（`lib/tools.js` 的 `pipelineToolFace`）
 * @param {(m:string)=>void} [opts.warn] - 留痕
 * @returns {(agentOrExec:object)=>(object|null)} 幂等：同一个会话只处理一次
 */
export function createSeatFaceTightener(opts = {}) {
  const { tokens, config, sw, face = null, warn = null } = opts
  const state = { tightened: new Map(), warned: false, calls: 0, restricted: 0, last: null }
  const say = (m) => {
    if (typeof warn === 'function') warn(m)
  }
  const tighten = (agentOrExec) => {
    try {
      state.calls += 1
      const agent = agentOrExec?.agent ?? agentOrExec
      const agentId = typeof agent?.id === 'string' && agent.id.length > 0 ? agent.id : null
      if (agentId === null) return null
      const prev = state.tightened.get(agentId)
      if (prev !== undefined) return prev
      const bound = tokens?.roleOfAgent?.(agentId, undefined) ?? null
      if (bound === null || bound === undefined) return null // 还没认领角色 ⇒ 不动（等它认领）
      const role = String(bound.role ?? '')
      if (role.length === 0) return null
      if (config?.guardEnabled !== true) return null
      // ★ 判据唯一出处：lib/switch/gate.js（不许自己写 sw.isOn()）。
      if (!isEnabled(sw)) return null
      const f = typeof face === 'function' ? face() : null
      const deny = Array.isArray(f?.by_role?.[role]?.denied) ? f.by_role[role].denied : []
      const record = { agent: agentId, role, denied: [...deny], restricted: false, note: '' }
      const done = () => {
        if (state.tightened.size > 512) state.tightened.delete(state.tightened.keys().next().value)
        state.tightened.set(agentId, record)
        state.last = record
        return record
      }
      if (deny.length === 0) {
        record.note = role === ROLE.MAIN ? '主对话看全量（口径）' : '守门不按角色限制它的任何工具 ⇒ 不收紧'
        return done()
      }
      const scoped = agent?.ctx?.tools
      if (scoped === null || scoped === undefined || typeof scoped.restrict !== 'function') {
        record.note = '拿不到 agent.ctx.tools.restrict（宿主形态不同）⇒ 退回全量可见（= 改前行为）'
        if (!state.warned) {
          state.warned = true
          say(`[pipeline] 席位工具面收紧不可用（${record.note}）—— 守门与工具行为**不受影响**，只是每个席位仍会看到全量工具 schema。`)
        }
        return done()
      }
      scoped.restrict.call(scoped, { deny })
      record.restricted = true
      record.note = `已按守门角色白名单隐藏 ${deny.length} 个它本来就会被拒的工具`
      state.restricted += 1
      return done()
    } catch (err) {
      if (!state.warned) {
        state.warned = true
        say(`[pipeline] 席位工具面收紧异常（不影响任何一次工具调用）：${String(err?.message ?? err)}`)
      }
      return null
    }
  }
  /** ★ 只读面（与 `lastChannelProbe` / `lastMainReattach` 同一种做法）。 */
  tighten.snapshot = () => ({
    calls: state.calls,
    restricted: state.restricted,
    sessions: state.tightened.size,
    last: state.last,
    warned: state.warned,
  })
  return tighten
}

/** 最近一次"按可见工具收紧席位工具面"的结论（只读导出）。 */
let LIVE_SEAT_FACE_TIGHTENER = null
/**
 * 读当前这一份收紧结论（**活**快照 —— 每次调用现算）。
 *
 * 为什么必须能查：收紧是**判决**（"这个席位从第几轮起看不到哪些工具"），
 * 只活在一次工具调用里就没法程序化核对。字段：
 * `{ calls, restricted, sessions, last: { agent, role, denied[], restricted, note }, warned }`。
 */
export function lastSeatFaceTighten() {
  return typeof LIVE_SEAT_FACE_TIGHTENER?.snapshot === 'function' ? LIVE_SEAT_FACE_TIGHTENER.snapshot() : null
}
/** 让 `apply()` 把本实例登记到模块级（自测/审查可查；只读面，谁都能读）。 */
export function noteSeatFaceTighten(tightener) {
  LIVE_SEAT_FACE_TIGHTENER = tightener ?? null
  return lastSeatFaceTighten()
}

/**
 * 提示词段的唯一渲染入口（`ctx.systemPrompt.section({ text })` 的那个回调）。
 *
 * ★ **任何一步不确定都退回全文**（= 改前行为），并且把"为什么退回"记进
 *   {@link lastPromptRender}；**不抛** —— 提示词渲染失败绝不能把请求带崩。
 *
 * @param {object} context - 宿主给的渲染上下文（吃了 `context.agent.id`）
 * @param {{tokens:object, face:Function|null}} deps
 */
export function renderPromptForContext(context, deps = {}) {
  const stamp = () => new Date().toISOString()
  try {
    const agentId = typeof context?.agent?.id === 'string' ? context.agent.id : ''
    if (agentId.length === 0) {
      LAST_PROMPT_RENDER = {
        at: stamp(),
        mode: 'full',
        reason: context === undefined || context === null ? '宿主没给 context（回调按无参调用）⇒ 退回全文' : 'context 里没有 agent.id ⇒ 退回全文',
        bytes: PIPELINE_PROMPT.length,
      }
      return PIPELINE_PROMPT
    }
    const bound = deps.tokens?.roleOfAgent?.(agentId, undefined) ?? null
    const role = bound === null ? '' : String(bound.role ?? '')
    if (role.length === 0) {
      LAST_PROMPT_RENDER = { at: stamp(), session: agentId, mode: 'full', reason: '该会话还没认领角色 ⇒ 退回全文', bytes: PIPELINE_PROMPT.length }
      return PIPELINE_PROMPT
    }
    if (role === ROLE.MAIN) {
      LAST_PROMPT_RENDER = { at: stamp(), session: agentId, role, mode: 'full', reason: '主对话看全量（口径）', bytes: PIPELINE_PROMPT.length }
      return PIPELINE_PROMPT
    }
    const face = typeof deps.face === 'function' ? deps.face() : null
    const visible = Array.isArray(face?.by_role?.[role]?.visible) ? face.by_role[role].visible : null
    if (visible === null) {
      LAST_PROMPT_RENDER = { at: stamp(), session: agentId, role, mode: 'full', reason: '工具面推导不可用 ⇒ 退回全文（不猜它有什么工具）', bytes: PIPELINE_PROMPT.length }
      return PIPELINE_PROMPT
    }
    const text = seatPrompt(role, visible)
    LAST_PROMPT_RENDER = {
      at: stamp(),
      session: agentId,
      role,
      mode: 'seat',
      tools: visible.length,
      bytes: text.length,
      full_bytes: PIPELINE_PROMPT.length,
      saved_bytes: PIPELINE_PROMPT.length - text.length,
    }
    return text
  } catch (err) {
    LAST_PROMPT_RENDER = { at: stamp(), mode: 'full', reason: `渲染异常 ⇒ 退回全文：${String(err?.message ?? err)}`, bytes: PIPELINE_PROMPT.length }
    return PIPELINE_PROMPT
  }
}
