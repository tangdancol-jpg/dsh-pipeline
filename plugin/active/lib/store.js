/**
 * dsh-pipeline · 任务存储与状态推进（机制的落地点）
 * ============================================================================
 * 这里是把「状态机 + 交接物 + 打回预算 + 制品版本」串成一条**不可绕**的流程
 * 的地方。所有拒绝都返回结构化结果，不抛异常 —— 拒绝是正常结果，不是事故。
 *
 * 落盘布局（需求原文点名要的那种）：
 *
 *   <项目根>/.pipeline/<taskId>/
 *     task.json                 任务卡 + 当前状态 + 角色清单 + 计数器
 *     handoffs/<seq>-<kind>.json 每一份结构化交接物，一份一个文件
 *     artifacts/v<N>/           编写角色登记的制品版本
 *     audit.jsonl                只追加的审计日志（每次动作一行）
 *
 * ★ 只在**任务被打开时**才建目录；没有任务时 `.pipeline/` 不存在。
 * ★ 所有写文件都是「先写临时文件再 rename」，避免半截 JSON 把任务卡写坏。
 *
 * @module dsh-pipeline/lib/store
 */

// ---------------------------------------------------------------------------
// 文件布局：实现按主题拆在 `lib/store/` 下，本文件保留 createTaskStore 的骨架
// （各组在原位置调用；返回对象里的方法按原顺序展开进同一个对象，`this` 指向不变）。
//   store/shared.js       模块级辅助：答复形态、读写 JSON、枢纽推进表、人工请求条目、席位采样
//   store/base.js         配置、缓存、读盘 / 落盘、审计、人工请求登记表自愈
//   store/hub.js          主管枢纽判据（待机、站点、打回预算、副作用）
//   store/lifecycle.js    开单、认领、查询、状态迁移      store/liveness.js   席位失联、被拒交付留档
//   store/precondition.js 迁移前置条件                    store/roster.js     角色清单
//   store/baseline.js     改动基线、席位写入台账、前后对比  store/seat-checks.js 席位归属、架构图交付、哈希闸门升级
//   store/submit.js       提交交接物                      store/review.js     交接物与状态核对、打回、关单、制品
//   store/amend.js        角色变更、授权面变更            store/fulltest.js   全量测试审批链
//   store/records.js      需求档、分权落档、上下文水位、席位继任
//   store/clarify.js      澄清请求与边界                  store/human.js      人工介入请求
//   store/status.js       状态汇总
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROLE } from './roles.js'
import { DISPATCH_OPEN_ACTION, dispatchOpenRecord } from './tiers.js'
import { isInside, nowIso, pathKey } from './util.js'
import { createStoreBase } from './store/base.js'
import { createStoreHub } from './store/hub.js'
import { lastKnownMainAgentOf } from './wakeup/last-resort.js'
import { lifecycleMethods } from './store/lifecycle.js'
import { livenessMethods } from './store/liveness.js'
import { preconditionMethods } from './store/precondition.js'
import { rosterMethods } from './store/roster.js'
import { baselineMethods } from './store/baseline.js'
import { seatCheckMethods } from './store/seat-checks.js'
import { submitMethods } from './store/submit.js'
import { reviewMethods } from './store/review.js'
import { amendMethods } from './store/amend.js'
import { fullTestMethods } from './store/fulltest.js'
import { recordMethods } from './store/records.js'
import { clarifyMethods } from './store/clarify.js'
import { humanMethods } from './store/human.js'
import { statusMethods } from './store/status.js'
import { dispatchSlotMethods } from './store/dispatch-slots.js'
import { purgeMethods } from './store/purge.js'
// ★★ P4/P5 接线（`WIRING.md` §W2）：DEMO 阶段的推进/回退与「L3+ 强制主管」两组方法。
//    本文件**只做展开** —— 判定与写盘都在各自的新模块里（规范 §5：不往大文件堆）。
import { demoMethods } from './store/demo.js'
import { hubRequireMethods } from './store/hub-require.js'

export {
  REPLY_CHANNELS,
  checkAnswerShape,
  AMEND_ALLOWED_KEYS,
  findNonScopeKeys,
  planAdvance,
  hubAdvanceFor,
  writerSeatsOf,
  seatPartitionOf,
  sampleSessionActivity,
  checkAllSeatsSubmitted,
  requirementPaths,
} from './store/shared.js'

/**
 * 建立任务存储。
 *
 * @param {object} opts
 * @param {string} opts.projectRoot - 项目根（`.pipeline` 就建在它下面）
 * @param {string} opts.artifactDirName - 默认 `.pipeline`
 * @param {number} opts.maxReworkPerLeg - 单条打回链上限
 * @param {() => Date} [opts.now]
 */
export function createTaskStore(opts) {
  // 任务存储 · 配置、缓存与读写落盘 —— 见 `lib/store/base.js`
  const {
    projectRoot,
    dirName,
    root,
    maxRework,
    seatSilence,
    hashGateEscalateAfter,
    anchorOf,
    cmpKey,
    scopeAbsKey,
    baselineAbsKey,
    scopeRelOf,
    timeoutHours,
    requireHumanConfirmCode,
    maxClarifyRounds,
    now,
    MAX_REJECTED_PAYLOAD_CHARS,
    cache,
    cacheStamp,
    taskDir,
    taskFile,
    handoffDir,
    relKey,
    auditFile,
    artifactDir,
    audit,
    deny,
    requireTask,
    loadTask,
    persist,
    reconcileHumanRequests,
    currentArtifactVersion,
    lastHandoff,
  } = createStoreBase({ opts })

  // 任务存储 · 主管枢纽判据 —— 见 `lib/store/hub.js`
  const {
    hubOf,
    hubEnabled,
    hubStandby,
    hubStandbyOf,
    hubStandbyBlocks,
    hubRejectRecords,
    hubLatestValidReject,
    hubRejectBudget,
    hubStationTarget,
    hubValidConfirms,
    hubStationGate,
    stationLabel,
    renderStandbyBlock,
    applyHubSideEffects,
    effectiveReviewOk,
  } = createStoreHub({ now, deny, currentArtifactVersion, lastHandoff })

  // -------------------------------------------------------------------------
  // 公开 API
  // -------------------------------------------------------------------------

  /**
   * ★ E3：**晚绑定的开关读取口** —— `index.js` 里 `createSwitch(...)` 建在 `createTaskStore`
   * **之后**（`:235` vs `:174`），所以 store 只能拿到一个闭包，不能拿开关对象本身。
   * 判据仍然只有 `lib/switch/gate.js` 一处（这里一个字都不判）。
   */
  const swOf = typeof opts.switchRef === 'function' ? opts.switchRef : () => null

  return {
    projectRoot,
    root,
    artifactDirName: dirName,
    maxReworkPerLeg: maxRework,
    /** ★ 失联静默阈值（毫秒）——`checkLiveness` 用它，工具层也会原样报给用户看。 */
    seatSilenceMs: seatSilence,
    /**
     * ★★ **运行失败取证**（A9 的"判词必须携带该次失败的证据"）。
     *
     * 由插件入口（`index.js`）注入：它拿得到 `ctx.agents`（进程内会话事件）与
     * 会话目录（落盘日志）。**没注入时**（自测替身 / 装配不全）`checkLiveness`
     * 退回改前那三条判据 —— 既不算崩也不算闲的那一档**不许假装知道**。
     *
     * @type {((task:object, silent:Array<object>) => Promise<{known:boolean, found:boolean, evidence:object|null, source:string, note:string}>)|null}
     */
    detectRunFailure: typeof opts.detectRunFailure === 'function' ? opts.detectRunFailure : null,
    taskDir,
    handoffDir,
    artifactDir,
    auditFile,

    /** 内部查表（守门判据要用同步接口，所以暴露同步的缓存查询）。 */
    peek: requireTask,
    /** 同步：任务是否在缓存里（落盘后首次访问前为 false）。 */
    isLoaded: (id) => cache.has(id),
    /** 某个任务的工作区目录 —— 守门判据用它做"受保护路径"判定。 */
    workspaceOf: (id) => taskDir(id),
    // 任务存储 · 开单、认领、查询、状态迁移 —— 见 `lib/store/lifecycle.js`
    ...lifecycleMethods({
      projectRoot,
      root,
      now,
      cache,
      taskFile,
      audit,
      deny,
      loadTask,
      persist,
      applyHubSideEffects,
      /** ★ E3：活文档写盘的闸门与兜底项目目录（见上面的 `swOf`）。 */
      swOf,
    }),
    // 任务存储 · 席位失联与被拒交付留档 —— 见 `lib/store/liveness.js`
    ...livenessMethods({ now, MAX_REJECTED_PAYLOAD_CHARS, audit, deny, loadTask, persist }),
    // 任务存储 · 迁移前置条件 —— 见 `lib/store/precondition.js`
    ...preconditionMethods({
      maxRework,
      now,
      deny,
      currentArtifactVersion,
      lastHandoff,
      hubOf,
      hubEnabled,
      hubStandbyOf,
      hubRejectRecords,
      hubLatestValidReject,
      hubRejectBudget,
      hubStationTarget,
      hubStationGate,
      stationLabel,
      effectiveReviewOk,
    }),
    // 任务存储 · 角色清单 —— 见 `lib/store/roster.js`
    ...rosterMethods({ maxRework, audit, deny, loadTask, persist, lastHandoff }),
    // 任务存储 · 改动基线与前后对比 —— 见 `lib/store/baseline.js`
    ...baselineMethods({
      dirName,
      root,
      anchorOf,
      cmpKey,
      scopeAbsKey,
      baselineAbsKey,
      now,
      taskDir,
      audit,
      deny,
      loadTask,
      persist,
    }),
    // 任务存储 · 席位归属、架构图交付、哈希闸门升级 —— 见 `lib/store/seat-checks.js`
    // ★ P1-9：`checkForeignPathsAck` 要用与闸门**同一套**路径归一化器，所以把两个键一并传进去。
    ...seatCheckMethods({ hashGateEscalateAfter, now, handoffDir, audit, deny, persist, scopeAbsKey, baselineAbsKey }),
    // 任务存储 · 提交交接物 —— 见 `lib/store/submit.js`
    ...submitMethods({
      maxRework,
      hashGateEscalateAfter,
      scopeAbsKey,
      baselineAbsKey,
      scopeRelOf,
      now,
      audit,
      deny,
      loadTask,
      persist,
      currentArtifactVersion,
      hubEnabled,
    }),
    // 任务存储 · 交接物核对、打回、关单、制品 —— 见 `lib/store/review.js`
    ...reviewMethods({
      maxRework,
      now,
      artifactDir,
      audit,
      deny,
      loadTask,
      persist,
      currentArtifactVersion,
      lastHandoff,
      hubEnabled,
      hubStandbyBlocks,
      renderStandbyBlock,
      effectiveReviewOk,
      /** ★ E3：关单是"语义上完整的时刻" —— 活文档在这里重建（见上面的 `swOf`）。 */
      swOf,
      projectRoot,
    }),
    // 任务存储 · 角色变更与授权面变更 —— 见 `lib/store/amend.js`
    ...amendMethods({ now, audit, deny, loadTask, persist }),
    // 任务存储 · 全量测试审批链 —— 见 `lib/store/fulltest.js`
    ...fullTestMethods({ now, deny }),
    // 任务存储 · 需求档、分权落档、上下文水位、席位继任 —— 见 `lib/store/records.js`
    ...recordMethods({ dirName, now, taskDir, relKey, audit, deny, loadTask, persist }),
    // 任务存储 · 澄清请求与边界 —— 见 `lib/store/clarify.js`
    ...clarifyMethods({ hashGateEscalateAfter, maxClarifyRounds, now, audit, deny, loadTask, persist }),
    // 任务存储 · 人工介入请求 —— 见 `lib/store/human.js`
    ...humanMethods({
      hashGateEscalateAfter,
      timeoutHours,
      requireHumanConfirmCode,
      now,
      audit,
      deny,
      loadTask,
      persist,
      reconcileHumanRequests,
    }),
    // 任务存储 · 状态汇总 —— 见 `lib/store/status.js`
    ...statusMethods({
      maxRework,
      hashGateEscalateAfter,
      deny,
      loadTask,
      currentArtifactVersion,
      lastHandoff,
      hubOf,
      hubEnabled,
      hubStandby,
      hubRejectRecords,
      hubStationTarget,
      hubValidConfirms,
      effectiveReviewOk,
    }),
    /**
     * 任务存储 · **每次派活的四槽实际生效值** —— 见 `lib/store/dispatch-slots.js`。
     * ★ 缺陷 ②：`roster.slots` 是**声明表**，不是"席位实际拿到了什么" ——
     *   实际值单独记在 `task.dispatch_slots[]`（只追加、有上限、永不改写名单）。
     */
    ...dispatchSlotMethods({ now, audit, deny, loadTask, persist }),
    /**
     * 任务存储 · **收尾清理**（终态单的归档 / 删除）—— 见 `lib/store/purge.js`。
     * ★ 缺陷 ⑦：这条是"删除任务"唯一的具名入口（**不碰** shell 判据，也不放宽它）。
     */
    ...purgeMethods({ root, taskDir, deny, loadTask, cache, cacheStamp }),
    // ★★ P4 接线：DEMO 阶段的推进/回退与三条软约束 —— 见 `lib/store/demo.js`。
    //    不展开的后果：`store.demoRound` 等全是 `undefined`，工具一调就崩；
    //    且 `checkPrecondition` 里的 `this.checkDemoPrecondition(...)` 找不到方法。
    ...demoMethods({ now, audit, deny, loadTask, persist }),
    // ★★ P5 接线：L3+ 强制主管（先设后撤）—— 见 `lib/store/hub-require.js`。
    ...hubRequireMethods({ now, audit, deny, loadTask, persist }),

    /**
     * 往本任务的 audit.jsonl 追加一行（**工具层写审计的正规入口**）。
     *
     * 为什么要有这个方法：审计行必须与任务一起落盘、并进 `task.history`，
     * 直接往文件里 append 会让内存与磁盘两份状态漂移。
     *
     * @param {string} taskId
     * @param {string} actorRole
     * @param {string} action
     * @param {object} [extra]
     */
    /**
     * ★★ **记下主对话所在会话**（`task.contacts.main`）—— 「交付即唤醒」的持久层。
     *
     * ---------------------------------------------------------------------
     * 为什么需要落盘（光有内存登记表不够）
     * ---------------------------------------------------------------------
     * 唤醒要投到"主对话那个会话"。进程内那张登记表（`lib/wakeup.js` 的
     * `createMainSessionRegistry`）**重启就没了** —— 而 DSH 重启恰恰是最常见的
     * 场景（用户关掉再打开）。重启后主对话只要再调一次 pipeline 工具就会重新登记，
     * 但**在它调之前**，机制是不知道唤醒该投到哪的。
     * 落一份 `contacts.main` 就能让这件事跨重启**可查** —— 与既有
     * `contacts.planner`（继任时登记）是同一张表、同一种形状，不新开机制。
     *
     * ★ 与 `commitSuccession` 里那张表**共用 `task.contacts` 这一个键**，
     *   所以 `pipeline_contacts` 能一处看到全部联系人。
     *
     * @param {string} taskId
     * @param {string} agentId - 主对话的会话 id（`exec.agent.id`）
     * @returns {Promise<{ok:boolean, changed:boolean, task?:object, error?:string}>}
     */
    async rememberMainContact(taskId, agentId) {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        return { ok: false, changed: false, error: '主对话会话 id 是空的，不登记。' }
      }
      const task = await loadTask(taskId)
      if (task === null) return { ok: false, changed: false, error: `找不到任务 ${taskId}。` }
      task.contacts = task.contacts ?? {}
      const cur = task.contacts.main ?? null
      // ★ 没变就不写盘 —— 这个函数在**每一次** pipeline 工具调用后都会跑。
      if (cur !== null && cur.agent_id === agentId) return { ok: true, changed: false, task }
      task.contacts.main = {
        role: ROLE.MAIN,
        seat: null,
        agent_id: agentId,
        generation: (cur?.generation ?? 0) + 1,
        since: nowIso(now()),
        previous_agent: cur?.agent_id ?? null,
        why: '交付即唤醒：唤醒消息要投到主对话所在会话',
      }
      await persist(task)
      return { ok: true, changed: true, task }
    },

    /**
     * 读主对话会话 id（内存没有时回落盘上那份）。
     *
     * ★ **同步优先**：调用方（唤醒路径）先查内存登记表，查不到才来这儿。
     *   返回 `''` 表示"没登记" —— **不是异常**，调用方据此静默跳过 + 留痕。
     *
     * @param {string} taskId
     * @returns {Promise<string>}
     */
    async mainContact(taskId) {
      const task = await loadTask(taskId)
      if (task === null) return ''
      const id = task.contacts?.main?.agent_id
      return typeof id === 'string' ? id : ''
    },

    /**
     * ★★ **兜底解析**：主对话上一次在哪个会话里（读这张单**自己**的 `task.history`）。
     *
     * ---------------------------------------------------------------------
     * 为什么必须有它（2026-10-16 · 真单 `T-20261016-ff9ba7`）
     * ---------------------------------------------------------------------
     * 唤醒的地址原来只有两份：内存登记表 + `task.contacts.main`。这张单**两份都空**
     * （`task.json` 顶层连 `contacts` 键都没有），于是**整张单 22 次唤醒全部
     * `no-main-session`**，跨两天、跨多次重启 —— 人工请求静默积压。
     *
     * 而它**自愈不了**：`rememberMainCaller` 只认内存里的 `main` 令牌（重启即清空），
     * 而重启后自动认回身份的那条路（`lib/config.js` 的 `mainReattachEnabled` →
     * `judgeMainClaim`）**要求 `contacts.main` 已经存在**。缺记录 ⇒ 认不回身份 ⇒
     * 写不了记录。本方法给的是这条死锁的**只读**出口。
     *
     * ★ 判据本体在 `lib/wakeup/last-resort.js` 的 {@link lastKnownMainAgentOf}
     *   （**纯函数**：只用 `actor === 'main'` 且带 `agent` 且不是机制记账行的那一行）。
     *   本方法只负责"读盘 + 交给它"，**一个字都不判**。
     * ★ 本方法是**只读**的：它**不写** `task.contacts.main` —— 兜底解析是提示，
     *   不是权威登记（把近似物写进去，"谁是主对话"就再没人说得清了）。
     *
     * @param {string} taskId
     * @returns {Promise<{agentId:string, at:string, action:string}|null>} 取不到就是 `null`
     */
    async lastKnownMainAgent(taskId) {
      const task = await loadTask(taskId)
      if (task === null) return null
      return lastKnownMainAgentOf(task)
    },

    /**
     * ★ **开对话留痕**（A1、A2、B6）：一次「开对话」请求 —— **被接受与被拒绝都留**。
     *
     * 为什么落点在这里（而不是在守门层）：守门那条路是**同步纯函数**、fail-closed、不写盘，
     * 它只能返回一句拒绝理由；而验收要的是「被拒也留痕」。所以被拒的那一侧也要能调到这里来，
     * 于是本函数把「写不进去」压到最小：**认不出的结论、缺原因的拒绝，照样产出一条记录**
     * （违约项列在 defects 里返回，不吞掉、不假装无事发生）。
     *
     * 它与 `recordDispatch` 是**两件事**，刻意不合并：
     *   · `recordDispatch` 是派活台账（失联检测按席位 upsert，**会被覆盖**）；
     *   · 本函数是**只追加**的审计行（动作名 = 名单权威层冻结的那个常量），一次请求一行，永不改写。
     * 把留痕塞进台账，就会让「重派覆盖旧记录」顺手抹掉历史 —— 那正是审计最怕的。
     *
     * 字段与顺序由名单权威层冻结（12 个平级字段，含四个槽位与 verdict、reason）；
     * `roster_version` 取当前名单的版本位，老清单没有版本位时写 null（不编造版本号）。
     *
     * @param {string|object} taskIdOrInput - 任务 id，或 { taskId, actorRole, actorSeat, targetRole, targetSeat, permission, mode, model, reasoning, verdict, reason }
     * @param {object} [maybe] - 第一个参数是字符串时，这里是那次请求的内容
     * @returns {Promise<object>}
     */
    async recordDispatchOpen(taskIdOrInput, maybe = {}) {
      const input =
        typeof taskIdOrInput === 'string' ? { ...(maybe ?? {}), taskId: taskIdOrInput } : (taskIdOrInput ?? {})
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const at = nowIso(now())
      const built = dispatchOpenRecord({ ...input, at }, task.roster ?? null, { at })
      const entry = await audit(task.id, String(input.actorRole ?? '?'), DISPATCH_OPEN_ACTION, built.record)
      task.history.push(entry)
      await persist(task)
      return { ok: true, task, entry, record: built.record, defects: built.defects }
    },

    async recordAudit(taskId, actorRole, action, extra = {}) {
      const task = await loadTask(taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${taskId}。`)
      const entry = await audit(task.id, actorRole, action, extra)
      task.history.push(entry)
      await persist(task)
      return { ok: true, task, entry }
    },

    /** 完整审计日志（读盘，不受内存缓存影响）。 */
    async auditLog(taskId) {
      const file = auditFile(taskId)
      if (!existsSync(file)) return []
      const text = await readFile(file, 'utf8')
      return text
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return { raw: l }
          }
        })
    },

    /** 守门判据用的同步查询：受保护路径（本任务工作区）。 */
    guardedRootsFor(taskId) {
      const t = cache.get(taskId)
      if (t === undefined) return []
      return [t.project_root]
    },

    /** 守门判据用：某个 agent 在某个任务里的角色。 */
    roleOfAgentSync(agentId, roleIndex) {
      if (typeof agentId !== 'string' || agentId.length === 0) return null
      if (roleIndex === undefined || roleIndex === null) return null
      const role = roleIndex.roleOfAgent(agentId)
      return role
    },

    /** 任务是否有受保护路径包含该绝对路径（守门判据）。 */
    isPathGuarded(taskId, absPath) {
      const t = cache.get(taskId)
      if (t === undefined) return false
      // 项目工作区整体受保护；但 .pipeline 自己的目录除外（工具自己要写）。
      if (!isInside(t.project_root, absPath)) return false
      if (isInside(join(t.project_root, dirName), absPath)) return false
      return true
    },

    /** 任务当前有效制品版本（对外暴露，供测试与状态展示）。 */
    async artifactVersion(taskId) {
      const t = await loadTask(taskId)
      return t === null ? null : currentArtifactVersion(t)
    },

    /** 有效审核 OK（对外暴露）。 */
    async reviewOk(taskId) {
      const t = await loadTask(taskId)
      return t === null ? null : effectiveReviewOk(t)
    },

    /** 测试用：丢掉内存缓存，强制下次从盘上读。 */
    dropCache(taskId) {
      if (taskId === undefined) {
        cache.clear()
        cacheStamp.clear()
      } else {
        cache.delete(taskId)
        cacheStamp.delete(taskId)
      }
    },

    /** 把 pathKey 暴露出去，避免使用方各自实现一份。 */
    pathKey,
  }
}
