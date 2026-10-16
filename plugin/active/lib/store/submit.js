/**
 * dsh-pipeline · 任务存储 · 提交交接物
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/submit
 */

import { HANDOFF_SCHEMAS, buildHandoffRecord, checkManifestAgainstScope, validateHandoff } from '../handoff.js'
import { ST, STATE_LABEL, applyTransition } from '../states.js'
import { ROLE, canProduceHandoff, roleLabel } from '../roles.js'
import { nowIso, shortHash } from '../util.js'
import { hashGateEscalationPending, hashGateVerdict, nextHashGateStreak, renderGateRejection } from '../hashgate.js'
import { planAdvance, hubAdvanceFor, writerSeatsOf, checkAllSeatsSubmitted } from './shared.js'

/**
 * 任务存储 · 提交交接物
 * 返回的方法由 `createTaskStore` 原位展开进同一个对象，方法里的 `this` 仍指向那个对象。
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function submitMethods(ctx) {
  const {
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
  } = ctx

  return {
    /**
     * 提交一份结构化交接物。**这是流水线上唯一的"交付"入口。**
     *
     * @param {object} input
     * @param {string} input.taskId
     * @param {string} input.kind
     * @param {string} input.actorRole
     * @param {object} input.payload
     * @param {string} [input.actorAgentId]
     * @param {boolean} [input.systemEscalation] - **仅供 store 内部**：这是机制触发的自动升级（工具面不给）
     */
    async submitHandoff(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)

      const kind = String(input.kind ?? '')
      const schema = HANDOFF_SCHEMAS[kind]
      if (schema === undefined) {
        return deny('UNKNOWN_HANDOFF', `未知交接物类型「${kind}」；合法值：${Object.keys(HANDOFF_SCHEMAS).join(' / ')}`)
      }

      // --- ① 角色是否有权产出这种交接物 ------------------------------------
      //
      //   ★ 设计目的（防过度工程化：只干自己该干的）：这张表就是**白名单** ——
      //     忘了给某角色加能力 = 少一条能力（会被明确拒绝）；忘了删 = 悄悄多一条能力。
      //     所以"编写不得产出测试结论"这条**不是靠文案**，是靠 writer 的
      //     `handoffKinds` 里压根没有 `test_to_review` / `test_to_dev`。
      if (!canProduceHandoff(input.actorRole, kind)) {
        const allowed = HANDOFF_SCHEMAS[kind].from
        const TEST_PRODUCT_KINDS = ['test_to_review', 'test_to_dev']
        return deny(
          'ROLE_NOT_ALLOWED',
          `角色越权：交接物「${kind}」（${schema.zh}）只能由 ${allowed.map(roleLabel).join(' / ')} 产出，` +
            `当前调用方是「${roleLabel(input.actorRole)}」。\n` +
            (kind === 'review_verdict' && input.actorRole === ROLE.WRITER
              ? '★ 编写角色不能直接提交审核。编写完成后只能产出 dev_to_test（提交测试），由测试通过后再交审核。'
              : '') +
            (TEST_PRODUCT_KINDS.includes(kind) && input.actorRole === ROLE.WRITER
              ? '★ **编写不跑测试**：用例、执行结果、通过证据、失败日志、测试结论全部是 `tester` 的产物。\n' +
                '  一个既写实现又自己判"通过"的角色，会把测试写成"刚好证明我对"的样子 —— 那不是独立验证。\n' +
                '  你要交的是 dev_to_test（补丁 + 变更说明 + 运行命令 + 自测结果 + 已知问题）。'
              : '') +
            (input.actorRole === ROLE.MAIN ? '★ 主对话不产出技术交接物 —— 它只负责派活、路由与关单。' : ''),
        )
      }

      // --- ② payload 字段校验 ----------------------------------------------
      const v = validateHandoff(kind, input.payload)
      if (v.ok !== true) {
        return deny('BAD_HANDOFF', `交接物「${kind}」（${schema.zh}）字段校验不通过：\n- ${v.errors.join('\n- ')}`)
      }

      // --- ④a ★最小改动：审核必须面对"改动面 vs 授权面"的核对结果 -----------
      //
      //   用户要求：「改了清单外的文件要能在**审核阶段**查出来（判据级，不是靠人看）」。
      //   做法：每次 dev_to_test 提交时都会算出 `task.scope_conformance`；
      //   审核提交结论时，如果那个结果是"越界"，这里**直接拒** ——
      //   逼审核先处理它（打回编写 / 走变更），而不是带着越界事实发 OK。
      //
      //   ⚠️ 位置：排在**状态检查之前**。理由：这是"结论本身的性质"，
      //      不该因为任务停在哪一站而看不到它（否则"跳步"会先把它盖住）。
      if (kind === 'review_verdict') {
        const conf = task.scope_conformance ?? null
        if (conf !== null && conf.within_scope === false) {
          return deny(
            'SCOPE_CONFORMANCE_FAILED',
            `拒绝审核结论：本次任务的**改动面超出了授权面**，审核不能带着这个事实出结论。\n` +
              `越界的路径：${(conf.out_of_scope ?? []).join('、') || '(见 scope_conformance)'}\n` +
              '★ 原则：**改动面必须与授权面相等** —— 多改一行也算越界。\n' +
              '两条路：① pipeline_rework 打回编写（让它撤回越界改动，或改回授权范围内）；' +
              '② 让计划 AI 重出计划、把新范围补进 change_scope，拿到新授权再交。\n' +
              '（这条判据是**自动**的：审核不需要自己逐个文件去比对。）',
          )
        }
      }

      // --- ④a2 ★前后版本对比：审核必须交"改动基线对照结论" -------------------
      //
      //   用户原话：「审核 ai 确认没有干不该干的事（**前后版本对比**）」+ 
      //   「这份对照结论要进审核的**交接物**（判据式证据，不是一句"我看了没问题"）」。
      //
      //   两道：
      //     ① 任务**有基线**时，`change_audit` 必填。
      //        ★ 缺陷 ⑤（2026-10-15）之后 **L0 也有基线了**（规则引擎在角色清单写入后
      //          自动记一次）⇒ 这一条对 L0 同样生效 —— 那正是修它的目的（R6 在 L0 上要有判据）。
      //          但 L0 **没有授权面**，所以 `changeAudit` 给的是第三种结论 `no_scope`
      //          （"越界/少改"不适用，只给前后差异）—— 本判据只核对结论**一致**，不把
      //          `no_scope` 当成 `out_of_scope`（见下面那道 `CHANGE_OUT_OF_SCOPE_OK`）。
      //     ② store **自己再算一遍**（`changeAudit`），与审核交的 `verdict` / `baseline_id` 核对 ——
      //        防"抄一份好看的结论"。审核不需要自己逐个文件比，它拿工具跑一遍即可。
      if (kind === 'review_verdict' && this.currentBaseline(task) !== null) {
        const audit = v.normalized.change_audit
        if (audit === null || typeof audit !== 'object' || Array.isArray(audit)) {
          return deny(
            'MISSING_CHANGE_AUDIT',
            `拒绝审核结论：本次任务**有改动基线**，所以必须交「前后版本对比结论」（change_audit）。\n` +
              `基线：${this.currentBaseline(task).baseline_id}（记录于 ${this.currentBaseline(task).taken_at}，${this.currentBaseline(task).file_count} 个文件）\n` +
              '★ 审核不能只说"我看了没问题"：要拿 `pipeline_change_audit` 跑一遍，把对照结论交上来 ——\n' +
              '  多改（清单外被改/被新增）、少改（该改的没改）、改错地方，三种都要有结论。\n' +
              '  （你不用逐个文件去比：那个工具按基线哈希比对，判据级出结论。）',
          )
        }
        const mine = await this.changeAudit({ taskId: task.id })
        if (mine.ok !== true) return mine
        if (String(audit.baseline_id ?? '') !== mine.baseline.baseline_id) {
          return deny(
            'CHANGE_AUDIT_STALE',
            `拒绝审核结论：change_audit.baseline_id=「${audit.baseline_id ?? '(缺失)'}」与当前基线「${mine.baseline.baseline_id}」不一致。\n` +
              '★ 基线换了就得重跑对比 —— 拿旧基线的结论去审新状态，等于没审。\n' +
              '下一步：重跑 pipeline_change_audit 拿到当前结论。',
          )
        }
        if (audit.verdict !== mine.verdict) {
          return deny(
            'CHANGE_AUDIT_MISMATCH',
            `拒绝审核结论：change_audit.verdict=「${audit.verdict ?? '(缺失)'}」，` +
              `但按基线实测是「${mine.verdict}」。\n` +
              (mine.unauthorized.length > 0
                ? `实测**有多改**（清单外的改动 ${mine.unauthorized.length} 处）：\n${mine.unauthorized.slice(0, 8).map((x) => `  · ${x.how}：${x.path}`).join('\n')}\n`
                : '') +
              '★ 这一条是**复核**，不是让你抄：store 会自己按基线再算一遍，结论对不上就拒。\n' +
              '下一步：重跑 pipeline_change_audit 并如实填写；真有多改就走 pipeline_rework 打回编写。',
          )
        }
        if (mine.verdict === 'out_of_scope' && v.normalized.conclusion === 'OK') {
          return deny(
            'CHANGE_OUT_OF_SCOPE_OK',
            `拒绝：**实测有多改**（${mine.unauthorized.length} 处清单外的改动），但审核结论是 OK。\n` +
              mine.unauthorized.slice(0, 8).map((x) => `  · ${x.how}：${x.path}`).join('\n') +
              '\n★ 用户要求是"审核确认没有干不该干的事" —— 有多改就不能发 OK。\n' +
              '下一步：pipeline_rework 打回编写（撤回越界改动），或让计划 AI 把新范围补进 change_scope 后重交。',
          )
        }
      }

      // --- ③a ★闸门已升级：用户还没答复之前，**拒收**同一任务的再次提交 -----
      //
      //   用户拍板（P13）：「升级发生后，**不许**继续接受同一任务的无限重交」。
      //
      //   为什么这条要单独写、而不是靠状态机顺手拦下：升级之后任务停在
      //   「等待人工答复」，`dev_to_test` 本来也推不动 —— 但那句拒绝是
      //   `HANDOFF_STEP_SKIPPED`（"跳步"），读起来像"你顺序搞错了"；
      //   而事实是"机制已经把这件事交给人了，你在等人回话"。两句话对应两种处置，
      //   所以这里给一个**专门的**拒绝码与文案。机制不是提醒，这里就是拒收。
      //
      //   位置：排在状态预检（③）**之前** —— 否则会被"跳步"先盖住，用户看到的就是错的理由。
      if (kind === 'dev_to_test' && hashGateEscalationPending(task)) {
        const esc = task.hash_gate_escalation
        return deny(
          'HASH_GATE_ESCALATED',
          `拒绝提交（HASH_GATE_ESCALATED）：本任务的**哈希前置闸门已经连续 ${esc.streak ?? '?'} 次不通过**，` +
            `机制已按规则把这件事**交人工**（阈值 ${esc.threshold ?? hashGateEscalateAfter} 次），` +
            '在用户答复之前**不再接受同一任务的提交**。\n' +
            `任务当前状态：${STATE_LABEL[task.state]}(${task.state})　人工请求：${esc.request_id ?? '(见 task.human_requests)'}（第 ${esc.round ?? 1} 次升级，${esc.at ?? ''} 发起）\n` +
            '★ 这一条是**拒收**，不是提醒：闸门不通过不消耗打回预算，等于"编写可以无限重交" ——\n' +
            '  那个副作用就堵在这里（连续 N 次不过 ⇒ 把人请回来，且在他回话前不收新提交）。\n' +
            '★ 你的改动本身没有被否定：撤回越界改动/补齐改动声明这些活照样可以先做，\n' +
            '  只是**提交**要等用户答复之后（答复会让状态回到「开发中」，计数重新从零开始）。\n' +
            '下一步：等主对话把这条请求转告用户并拿到答复（pipeline_human_relay → pipeline_human_reply）。\n' +
            '  主对话可查：pipeline_status（human_requests 那一栏列出了待答复的人工请求）。',
        )
      }

      /**
       * ★★ **哈希前置闸门覆盖新站点**（T-20261011-56a37e）。
       *
       * 安全预审整改项 L5/L8 要求「哈希前置闸门**覆盖新站点**」。
       * 新站点里唯一与"改动面合法性"有关的动作是第③④道的**站点确认** ——
       * 它们是"我确认这份产物没问题"的书面动作，而闸门一旦已经判定改动面不合法
       * （连续不通过到阈值 ⇒ 已交人工），**任何人都不许替它背书**：
       * 那时连测试都不许跑，更不许主管/需求位盖章。
       *
       * ★ 与上面那条（`dev_to_test` 拒收）判的是**同一个事实**（`hash_gate_escalation`），
       *   只是执法点从"编写重交"扩到"别人替它确认" —— 这是**扩展**，不是新机制；
       *   既有那条一个字没动。
       */
      if (kind === 'station_confirm' && hubEnabled(task) && hashGateEscalationPending(task)) {
        const esc = task.hash_gate_escalation
        return deny(
          'HASH_GATE_ESCALATED',
          `拒绝提交站点确认：本任务的**哈希前置闸门已经连续 ${esc.streak ?? '?'} 次不通过**（阈值 ${esc.threshold ?? hashGateEscalateAfter} 次），` +
            '机制已按规则把这件事**交人工**。\n' +
            `任务当前状态：${STATE_LABEL[task.state]}(${task.state})　人工请求：${esc.request_id ?? '(见 task.human_requests)'}\n` +
            '★ 哈希前置闸门排在**一切测试与一切确认之前**：改动面本身不合法时，' +
            '  谁都不许替它盖章（连测试都没被触发）。\n' +
            '  用户原话：「哈希对比不过全量测试直接打回」+「不许"先跑一下看看"」。\n' +
            '下一步：等用户答复（答复会让状态回到「开发中」，计数从零开始），再让编写重交 dev_to_test。',
        )
      }

      // --- ③ 状态是否允许 --------------------------------------------------
      // ★ 2026-10-16：把**交接物本身**一并交给状态判据（第三个参数，可选、只增不改）。
      //   为什么必须带上：枢纽任务的**交付站**上，"重交的架构图必须绑当前有效制品版本"
      //   是**状态面判据**（真机 T-20261016-fullai 的 L5 关单死锁），而那条判据要读 payload。
      //   不传的话它只能在"没有 payload"的前提下弃权 —— 那等于把闸门改成一句空话。
      const stateCheck = this.checkHandoffAgainstState(task, kind, v.normalized)
      if (stateCheck.ok !== true) return stateCheck

      /**
       * ★★ **站点否掉的预算前置**（T-20261011-56a37e 补齐）。
       *
       * 为什么否掉记录也要在这里挡一道：否掉是"**一份记录 + 一条回边**"两步
       * （与站点确认"先交记录、再放行"同形）。如果只在回边那一步判预算，
       * 预算用尽时记录**已经落盘**了 —— 而否掉记录会作废此前的全部确认
       * （`lastReworkIndex` 的"否掉即作废"），于是一次**被拒**的动作
       * 却改掉了后续的判定结果。所以判定必须**提前到提交这一步**：
       * 预算用尽 ⇒ 记录根本交不上来，盘上不会留下半截状态。
       *
       * ★ 判据体**只有一个**（`checkPrecondition` 的 `hub_station_reject_budget`），
       *   这里与回边那一步调的是同一个 —— 不会出现"两道判得不一样"。
       */
      if (kind === 'station_confirm' && hubEnabled(task) && v.normalized?.decision === 'ng') {
        const chk = await this.checkPrecondition(task, 'hub_station_reject_budget', { station: String(v.normalized?.station ?? '') })
        if (chk.ok !== true) return chk
      }

      // --- ④ 版本一致性 ----------------------------------------------------
      if (kind === 'test_to_review' || kind === 'test_to_dev' || kind === 'review_verdict') {
        const version = currentArtifactVersion(task)
        if (version !== null && v.normalized.artifact_version !== version) {
          return deny(
            'VERSION_MISMATCH',
            `交接物里的 artifact_version=${v.normalized.artifact_version} 与当前有效制品 ${version} 不一致。` +
              `制品已更新或被换过，请基于当前版本操作（制品版本化就是为了防这个）。`,
          )
        }
      }

      // --- ④b ★席位归属校验（dev_to_test）----------------------------------
      //
      // 提交的席位必须**在册**，且调用方令牌的席位要和提交的席位一致。
      // 这条挡的是"拿 writer#1 的令牌去交 writer#2 的分区"。
      if (kind === 'dev_to_test') {
        const seatCheck = this.checkSeatOwnership(task, v.normalized, input)
        if (seatCheck.ok !== true) return seatCheck
        // 补上席位元数据（单席位没给 partition 时按 writer#1 补全 —— 保持与旧行为等价）
        v.normalized.partition = seatCheck.partition
      }

      // --- ④b0 ★最小改动：实际改动面必须落在**授权改动面**内 -----------------
      //
      //   「改动面必须与授权面相等」—— 多改一行也算越界。
      //   判据在这里（而不是在 handoff.js 的 schema 里）是因为要读**计划**里的
      //   `change_scope`，那是任务级数据。
      //
      //   ⚠️ 只有"有计划"的任务才执法：L0 没有计划这一站（规则引擎自批），
      //      所以 L0 任务不存在授权面，这里弃权并留痕（见 README「待确认项」P4）。
      /** ★ 本次提交的改动面核对结果（要落进任务里，供测试/审核/状态查询读）。 */
      let scopeAudit = null
      if (kind === 'dev_to_test') {
        const scope = task.change_scope ?? null
        if (Array.isArray(scope) && scope.length > 0) {
          const manifest = Array.isArray(v.normalized.change_manifest) ? v.normalized.change_manifest : null
          if (manifest === null || manifest.length === 0) {
            return deny(
              'MISSING_CHANGE_MANIFEST',
              `拒绝提交：本次任务**有授权改动面**，所以 dev_to_test 必须带上「实际改动面」\n` +
                `（change_manifest: [{ path, action, scope_id, lines?, note? }]）。\n` +
                '★ 规矩是**改动面必须与授权面相等** —— 测试与审核要按这个面逐条核对，\n' +
                '  "我只改了三行"必须是**可验证的声明**，不是形容词。\n' +
                `本次授权面（计划里给的）：\n${scope.map((e) => `  · ${e.id} ${e.action} ${e.path}`).join('\n')}`,
            )
          }
          const chk = checkManifestAgainstScope(manifest, scope, {
            scopeRel: (p) => scopeRelOf(p, task),
            // ★ 修 ③：把"授权条目"和"改动声明"都归一到**同一个坐标系的绝对键**再比 ——
            //   授权面写成绝对路径（源码树那两条）时，声明这边不再只剩"逐字节写对"一条路。
            absOf: (p) => scopeAbsKey(p, task),
          })
          if (chk.ok !== true) {
            return deny(
              'CHANGE_OUT_OF_SCOPE',
              `拒绝提交：**改动面超出了授权面**。\n- ${chk.errors.join('\n- ')}\n` +
                `\n本次授权面（计划里给的）：\n${scope.map((e) => `  · ${e.id} ${e.action} ${e.path}（${e.why}）`).join('\n')}\n` +
                (chk.outOfScope.length > 0 ? `\n越界的路径：${chk.outOfScope.join('、')}\n` : '') +
                '★ 原则：**改动面必须与授权面相等** —— 多改一行也算越界。\n' +
                '  真需要扩大范围（例如 bug 根因在别的模块）→ **不许自作主张扩**：\n' +
                '  走澄清/变更 —— pipeline_clarify_request 升给需求分析，或 pipeline_roster_request 让计划 AI 重出计划，\n' +
                '  拿到新授权（新的 change_scope）之后再动。',
            )
          }
          scopeAudit = chk
        } else {
          scopeAudit = null
        }
      }

      // --- ④b1 ★**哈希前置闸门**：排在一切测试之前 -------------------------
      //
      //   用户原话：「**先过哈希对比，哈希对比不过全量测试直接打回**」。
      //
      //   位置：**在 ④b0（形状核对）之后、任何测试之前**。不通过时：
      //     · dev_to_test **本身被拒** ⇒ 任务停在"开发中"，**没有进入测试**；
      //     · 不消耗测试预算（连测试角色都还没被唤起）；
      //     · 更谈不上"是否跑全量"那条审批链。
      //   设计意图：**不合格的提交不该消耗测试资源** —— 这是省时间省 token 的第一道闸。
      //
      //   ⚠️ 只有"**有计划 ⇒ 有授权面**"的任务才执法；L0 没有计划这一站
      //      ⇒ **没有授权面**（`change_scope` 是 null）⇒ 这道闸弃权（与 P4 同源）。
      //
      //   ★★ 2026-10-15 更正（缺陷 ⑤）：这里的判据由「有没有基线」改为
      //      「**有没有授权面**」。原因：缺陷 ⑤ 让 L0 也记了一次基线（R6 在 L0 上要有
      //      判据），若仍按"有基线就执法"，这道闸会**顺带在 L0 上武装起来** ——
      //      而它判的是「改动面 vs **授权面**」，L0 压根没有授权面 ⇒ 无事可判，
      //      只会把"没申报"当成罪。那是**改了另一件事**（P4 是用户待拍板项），
      //      不在本次修复范围内。判据与 `changeAudit` 新增的 `has_scope` **同源**。
      //
      //   ★ 本轮新增（用户拍板 P13）：
      //     · 闸门不通过**不消耗** `maxReworkPerLeg`（保持现状）——
      //       任务从未离开 `developing`，"打回"严格说没发生（提交本身不成立），
      //       而那笔预算是为"真的来回拉锯过"设的。这一段**一个字都没动**（回归用例盯着它）。
      //     · 但"编写可以无限重交"这个副作用要堵 ⇒ **连续 N 次不过 ⇒ 自动交人工**。
      //       连续的定义与归零点见 `lib/hashgate.js` 的 `nextHashGateStreak`。
      if (kind === 'dev_to_test') {
        const baseline = this.currentBaseline(task)
        const hasScope = Array.isArray(task.change_scope) && task.change_scope.length > 0
        if (baseline !== null && hasScope) {
          const auditRes = await this.changeAudit({ taskId: task.id })
          if (auditRes.ok === true) {
            const manifest = Array.isArray(v.normalized.change_manifest) ? v.normalized.change_manifest : []
            // ★★ **席位级写入台账（选项 B）**：**先记账，再判定** —— 顺序是硬要求：
            //    · 本单这一笔必须留下（别单的判定要读得到它）；
            //    · 判定也要读得到**别单**已经留下的账（P2-13 就是被"不知道谁改的"绊住的）。
            //    记的是"这一席这次交出的路径 + 它们**此刻**的内容哈希"（只追加，永不覆盖）。
            const ledgerWrite = await this.recordSeatWrites({
              task,
              role: input.actorRole,
              seat: v.normalized.partition?.seat ?? null,
              agentId: input.actorAgentId ?? null,
              baselineId: auditRes.baseline.baseline_id,
              submissionSeq: task.handoffs.length,
              manifest,
              audit: auditRes,
            })
            const ledgerRead = await this.loadSeatWriteLedger()
            // ★ 台账写失败**不拦提交**（它是判据的辅助证据，不是判据本身）——
            //   但**不静默**：失败要留一行审计，别让"这次没有归属证据"变成看不见的事。
            if (ledgerWrite.ok !== true) {
              task.history.push(
                await audit(task.id, input.actorRole, 'ledger:seat-write-failed', {
                  error: ledgerWrite.error,
                  paths: ledgerWrite.entries,
                  why: '席位级写入台账写失败 —— 本次判定退回严格那一支（没有归属证据 ⇒ 照旧拒），且别单将读不到这一笔。',
                }),
              )
            }
            // ★ 修 ③：`touched` 是**相对项目根**的基线键，而编写可能按授权面的写法
            //   在声明里填**绝对路径** —— 两条字符串直接比，"实际动过"永远盖不住"声明"
            //   ⇒ 每一处都被判"声明不实"。这里把两侧归一到同一个坐标系（绝对键）。
            const verdict = hashGateVerdict(auditRes, manifest, {
              absOfDeclared: (p) => scopeAbsKey(p, task),
              absOfTouched: (p) => baselineAbsKey(p),
              // ★★ 归属判据的两样输入：台账全部行 + 本单是谁（"只有别的单能豁免本单"由判据侧执法）
              writeLedger: ledgerRead.entries,
              writeLedgerTaskId: task.id,
            })
            // ★ 连续不过计数：**只有"闸门真过了"才归零**（撤回不归零，理由见 hashgate.js）
            const streak = nextHashGateStreak(task.hash_gate_streak, verdict.pass)
            task.hash_gate_streak = streak
            task.hash_gate_checks = task.hash_gate_checks ?? []
            task.hash_gate_checks.push({
              at: nowIso(now()),
              by: input.actorRole,
              seat: v.normalized.partition?.seat ?? null,
              handoff_kind: kind,
              baseline_id: auditRes.baseline.baseline_id,
              pass: verdict.pass,
              // ★ 每一次失败/通过都带上"这是连续第几次" —— 审计要能一眼看出趋势
              streak,
              threshold: hashGateEscalateAfter,
              counts: verdict.counts,
              violations: verdict.violations,
              added: auditRes.added.map((x) => ({ path: x.path, sha256: x.sha256 ?? null })),
              modified: auditRes.modified.map((x) => ({ path: x.path, sha256: x.sha256 ?? null, baseline_sha256: x.baseline_sha256 ?? null })),
              removed: auditRes.removed.map((x) => ({ path: x.path, baseline_sha256: x.baseline_sha256 ?? null })),
              /** ★★ 归属判据这一轮**看见了什么**（谁被归属给了谁 —— 与 violations 同级可核）。 */
              attributed_foreign: verdict.attributed_foreign,
              withdrawn_machine_artifacts: verdict.withdrawn_machine_artifacts,
              /** ★ 台账这一轮的读写情况（"没有归属证据"必须是看得见的事实，不是静默）。 */
              write_ledger: {
                written: ledgerWrite.written,
                write_error: ledgerWrite.error,
                entries_read: ledgerRead.entries.length,
                files_read: ledgerRead.files,
                damaged_lines: ledgerRead.damaged,
                list_error: ledgerRead.list_error,
              },
            })
            task.history.push(
              await audit(task.id, input.actorRole, 'gate:hash', {
                baseline_id: auditRes.baseline.baseline_id,
                pass: verdict.pass,
                streak,
                threshold: hashGateEscalateAfter,
                counts: verdict.counts,
                violations: verdict.violations.map((x) => `${x.how}:${x.path}`),
                attributed_foreign: verdict.attributed_foreign.map((x) => `${x.path}→${x.attributed_to.task_id}`),
                write_ledger: {
                  written: ledgerWrite.written,
                  write_error: ledgerWrite.error,
                  entries_read: ledgerRead.entries.length,
                  damaged_lines: ledgerRead.damaged,
                },
                agent: input.actorAgentId,
              }),
            )
            task.hash_gate = {
              blocked: verdict.pass !== true,
              at: nowIso(now()),
              baseline_id: auditRes.baseline.baseline_id,
              counts: verdict.counts,
              violations: verdict.violations.map((x) => ({ how: x.how, path: x.path })),
              streak,
              threshold: hashGateEscalateAfter,
            }
            await persist(task)
            if (verdict.pass !== true) {
              // ★★ 连续 N 次不过 ⇒ **自动交人工**（走既有的 human_request / 两级梯）
              //    在返回拒绝之前做 —— 因为"已经交人工"这件事必须体现在这次拒绝的文案里
              //    （否则编写会以为"再交一次就好"）。
              const escalation = await this.escalateHashGate(task, {
                streak,
                threshold: hashGateEscalateAfter,
                verdict,
                baseline,
              })
              // ★ 把 task 一起带出去：工具层要拿它刷新**同步索引**，
              //   否则守门看不到 hash_gate.blocked（"闸门没过不许跑测试"会静默失效）。
              return deny(
                'HASH_GATE_FAILED',
                renderGateRejection({ verdict, audit: auditRes, scope: task.change_scope ?? [], baseline, streak, threshold: hashGateEscalateAfter, escalation }),
                { task },
              )
            }
          }
        }
      }

      // --- ④b2 ★两级升级梯：跳级闸 + 防踢皮球闸 ----------------------------
      if (kind === 'clarification_request') {
        const pp = this.checkClarificationPingPong(task, v.normalized)
        if (pp.ok !== true) return pp
      }
      if (kind === 'human_request') {
        const ch = await this.checkHumanRequestChannel(task, v.normalized, input.actorRole, {
          // ★ 只有机制自己（哈希闸门连续不通过）能置这个标记；
          //   工具面拿不到它 —— `pipeline_handoff` 调 submitHandoff 时压根不传这个键。
          systemEscalation: input.systemEscalation === true,
        })
        if (ch.ok !== true) return ch
        // 升级来源要落到记录上（审计里一眼能看出这条 human_request 是从哪升上来的）
        if (ch.escalated !== undefined && ch.escalated !== null) {
          v.normalized.escalated_from = ch.escalated.handoff_id
          v.normalized.raised_by = ch.escalated.from_role
        }
      }

      // --- ④b3 ★计划缺失回流：把它接到**既有**的第一级澄清梯上 ----------------
      //
      //   为什么这么做：用户明确要求"沿用现有两级梯，不要另起一套并行机制"。
      //   计划自检发现缺口时，planner 交的那份 plan 里已经带着
      //   gap_stage / gap_question / gap_context —— 那就是一份**澄清请求**的内容。
      //   于是这里按同一份 `createClarificationEntry` 建记录（from_role=planner），
      //   后面的裁定（pipeline_clarify_reply）、升级（human_request + escalated_from）、
      //   单向门、防踢皮球、恢复语义**全部照旧生效**，一行新机制都不用加。
      //
      //   ⚠️ 顺序说明：这一步必须**早于** ⑤ 的状态预检 —— 回流那条边的前置判据
      //   （plan_gap_gate）就是靠"这条澄清记录存在"来判的。而真正的 plan 交接物
      //   要到 ⑤ 之后才落盘，所以这里先用一个占位 id 建记录，落盘后回填真 id。
      let planGapEntry = null
      if (kind === 'plan' && v.normalized.self_check?.verdict === 'gaps') {
        planGapEntry = this.createClarificationEntry(
          task,
          { handoff_id: `PLAN-PENDING-${shortHash(`${task.id}|${task.handoffs.length}|${String(v.normalized.gap_question ?? '')}`)}` },
          {
            from_role: ROLE.PLANNER,
            stage: v.normalized.gap_stage,
            question: v.normalized.gap_question,
            context_digest: v.normalized.gap_context,
            options: [],
            blocking: true,
            urgency: v.normalized.gap_urgency ?? 'blocking',
          },
        )
      }

      // --- ④c ★架构图回执校验（要读磁盘，所以放在 store 层）------------------
      if (kind === 'architecture_diagram') {
        const dg = await this.checkDiagramDelivery(task, v.normalized)
        if (dg.ok !== true) return dg
        v.normalized.diagram_path = dg.diagramPath
        if (dg.receiptPath !== null) v.normalized.receipt_path = dg.receiptPath
      }

      // --- ⑤ 交接物与状态推进合一 ------------------------------------------
      //
      // 先**预检**这一步会导致的状态迁移（角色权限、合法边、打回预算），
      // 再写交接物，最后真正迁移。预检失败就一个字节都不写 ——
      // 不会留下"有交接物但状态没动"的半截现场。
      const advance = hubEnabled(task)
        ? (planAdvance(kind, v.normalized) ?? hubAdvanceFor(kind, v.normalized, task.state))
        : planAdvance(kind, v.normalized)
      if (advance !== null) {
        const tr = applyTransition(task.state, advance.event, input.actorRole, task.previous_state ?? undefined)
        if (tr.ok !== true) {
          return deny(
            'BAD_TRANSITION',
            `交接物「${kind}」不能推动任务 ${task.id} 的状态：${tr.error}\n` +
              (kind === 'dev_to_test' && task.state === ST.DEVELOPING
                ? ''
                : '（交接物未写入。）'),
          )
        }
        // ★ 目标状态与当前状态相同 → 不做这次迁移。
        //   为什么需要这条：`human_request` 的边是 `from:'*'`（任何非终态都能提问）。
        //   若任务已经在「等待人工答复」而另一个角色又提一个 blocking 请求，
        //   迁移会变成 awaiting_human → awaiting_human，而 `transition()` 会把
        //   `previous_state` 覆盖成 'awaiting_human' —— 之后 `human_reply`
        //   回到 'awaiting_human'，任务**永久卡死**。
        //   规则本身是通用的：**不要迁到你已经待着的那个状态**。
        if (tr.to !== task.state) {
          // 打回类事件要预检预算，避免"写了交接物才发现超限"。
          if (advance.leg !== null) {
            const pre = await this.checkPrecondition(task, 'rework_budget', { leg: advance.leg, event: advance.event })
            if (pre.ok !== true) return pre
          }
        }
      }
      const willAdvance = advance !== null && (() => {
        const tr = applyTransition(task.state, advance.event, input.actorRole, task.previous_state ?? undefined)
        return tr.ok === true && tr.to !== task.state
      })()

      const record = buildHandoffRecord({
        kind,
        taskId: task.id,
        fromRole: input.actorRole,
        toRole: schema.to,
        payload: v.normalized,
        artifactVersion: v.normalized.artifact_version ?? null,
        seq: task.handoffs.length, // ★ 让同一秒内的相同内容也有不同的 id
      })
      // ★★ **登记与落盘同块**（凡"能落交接物"的路径必须同时登记）-----------------
      //
      //   ⚠️ 位置是硬要求，而且**顺序也是硬要求**：登记要建在 `appendHandoff`
      //   **之前**，让"交接物可见"与"登记可见"之间**不存在任何 await 点**。
      //
      //   为什么（这是读侧那条漏路的根治）：`appendHandoff` 是
      //   `task.handoffs.push(record)` 之后才 `await writeJsonAtomic(...)` —— 那个
      //   await 就是一个让出点。只要登记排在它后面，**并发读者就能在这个让出点上
      //   观察到一个半截状态**：`handoffs` 里已经有这份 human_request，而
      //   `human_requests` 里还没有 ⇒ 收件箱答「目前没有人工介入请求」，而
      //   `pipeline_status` 却列得出那份交接物。真单 T-20261012-7b9408 现场就是
      //   这个形状（详见 `cacheStamp` 的注释）。
      //
      //   摆到前面之后：两个数组在**同一个同步块**里各自就位，中间没有让出点 ⇒
      //   读者要么两者都还没看到，要么两者都看到。这是消除竞态，不是缓解。
      //
      //   ⚠️ 反方向（登记已可见、交接物还没落）是**可接受**的：收件箱、转告、答复
      //   读的都是登记本体；`reconcileHumanRequests` 只按交接物补缺、从不删条目。
      //   万一落交接物失败，下面把它撤掉（两条数据源一起落、也一起撤）。
      //
      //   幂等由 `createHumanRequestEntry` 保证（同一个 handoff_id 永不重复登记）。
      let humanRequest = null
      if (kind === 'human_request') {
        humanRequest = this.createHumanRequestEntry(task, record, v.normalized)
      }
      try {
        await this.appendHandoff(task, record)
      } catch (err) {
        if (humanRequest !== null && Array.isArray(task.human_requests)) {
          task.human_requests = task.human_requests.filter((r) => r.handoff_id !== record.handoff_id)
        }
        throw err
      }

      // ★ 计划缺失回流：把占位 id 换成真正的 plan 交接物 id（审计里要对得上）。
      if (planGapEntry !== null) {
        planGapEntry.handoff_id = record.handoff_id
      }

      const entry = await audit(task.id, input.actorRole, `handoff:${kind}`, {
        handoff_id: record.handoff_id,
        artifact_version: record.artifact_version,
        digest: record.content_hash,
        agent: input.actorAgentId,
      })
      task.history.push(entry)
      await persist(task)

      // ★ 编写席位：登记本席位的提交。**先登记再判定能不能推进** ——
      //   否则最后一个席位提交时，判据还看不到它自己。
      let seatsNote = ''
      if (kind === 'dev_to_test') {
        const seat = v.normalized.partition?.seat ?? writerSeatsOf(task)[0]
        task.writer_submissions = task.writer_submissions ?? {}
        task.writer_submissions[seat] = {
          handoff_id: record.handoff_id,
          artifact_version: v.normalized.artifact_version ?? null,
          at: nowIso(now()),
        }
        const seats = writerSeatsOf(task)
        const done = seats.filter((s) => task.writer_submissions[s] !== undefined)
        seatsNote =
          seats.length > 1
            ? `\n本席位「${seat}」已交（${done.length}/${seats.length}）。` +
              (done.length < seats.length
                ? `还差：${seats.filter((s) => task.writer_submissions[s] === undefined).join('、')} —— 全部到齐前不会推进到「待测试」。`
                : '全部席位到齐，可以推进了。')
            : ''
        // ★ 最小改动：把改动面核对结果落进任务 —— 测试与审核按它核对，
        //   **判据级，不是靠人看**（`pipeline_status` 会把它原样回显）。
        if (scopeAudit !== null) {
          const prevManifest = (task.scope_conformance?.manifest ?? [])
          task.scope_conformance = {
            checked_at: nowIso(now()),
            within_scope: true,
            out_of_scope: [],
            unused_scope: scopeAudit.unused,
            manifest: [...prevManifest, ...(v.normalized.change_manifest ?? []).map((m) => ({ seat, ...m }))],
            handoff_id: record.handoff_id,
          }
        }
        const sentry = await audit(task.id, input.actorRole, 'seat:submit', {
          seat,
          done: done.length,
          total: seats.length,
          handoff_id: record.handoff_id,
          change_manifest: (v.normalized.change_manifest ?? []).length,
          within_scope: scopeAudit === null ? null : true,
          agent: input.actorAgentId,
        })
        task.history.push(sentry)
        await persist(task)
      }

      // ★ 澄清请求：建一条生命周期记录（提问 → 裁定 →（必要时）升级）。
      //   ★ 本轮起，**计划缺失回流**也走这里：它的记录在 ④b3 已经建好（因为要赶在
      //     状态预检之前），这里只补一条审计 —— 两个入口，同一条记录、同一条链。
      let clarification = null
      if (planGapEntry !== null) {
        const pentry = await audit(task.id, input.actorRole, 'clarify:request', {
          request_id: planGapEntry.request_id,
          handoff_id: record.handoff_id,
          from_role: planGapEntry.from_role,
          stage: planGapEntry.stage,
          question_key: planGapEntry.question_key,
          round: planGapEntry.round,
          blocking: planGapEntry.blocking,
          urgency: planGapEntry.urgency,
          state_at_request: planGapEntry.state_at_request,
          source: 'plan_self_check',
          agent: input.actorAgentId,
        })
        task.history.push(pentry)
        await persist(task)
      }
      if (kind === 'clarification_request') {
        clarification = this.createClarificationEntry(task, record, v.normalized)
        /**
         * ★★ **B3 缺件补丁（2026-10-12 · writer#1）：把"是谁问的"里的「席位」也记下来。**
         *
         * 现场：裁定落地之后 `pipeline_clarify_reply` 拿 `res.request.from_seat` 去唤醒
         * 发起席位（`lib/tools.js` 的 `wakeResumedSeat`），而 `createClarificationEntry`
         * **从来没有写过 `from_seat`** —— 它恒为 undefined，于是 `nudgeSeat` 只按
         * `role` 找派活台账、命中**第一个**同角色记录。
         *
         * 后果（多编写席位时可复现的错投）：「writer#2」提问、裁定却投进了「writer#1」
         * 的会话 —— 真正停手的那个席位仍然卡死，而机制以为已经把它叫醒了。
         *
         * 口径：席位**只从令牌来**（`input.actorSeat`，与 `submitHandoff` 其它分支同一出处）。
         * 不让调用方在 payload 里自报 `from_seat` —— 那是第二个真相源，而"谁问的"必须由凭据决定。
         * 非编写角色没有席位（`actorSeat` 为 null）⇒ 照旧 null，行为不变。
         */
        clarification.from_seat = typeof input.actorSeat === 'string' && input.actorSeat.length > 0 ? input.actorSeat : null
        const centry = await audit(task.id, input.actorRole, 'clarify:request', {
          request_id: clarification.request_id,
          handoff_id: record.handoff_id,
          from_role: clarification.from_role,
          stage: clarification.stage,
          question_key: clarification.question_key,
          round: clarification.round,
          blocking: clarification.blocking,
          urgency: clarification.urgency,
          state_at_request: clarification.state_at_request,
          agent: input.actorAgentId,
        })
        task.history.push(centry)
        await persist(task)
      }

        // ★ 全量测试审批链：四站同一条链（见 lib/testscope.js 的凭据判据）
        if (kind === 'full_test_request') {
          const ft = this.applyFullTestRequest(task, record, v.normalized)
          if (ft.ok !== true) return ft
          task.history.push(await audit(task.id, input.actorRole, 'fulltest:request', {
            approval_id: ft.chain.approval_id,
            what_will_run: ft.chain.request.what_will_run,
            affected_paths: ft.chain.request.affected_paths,
          }))
          await persist(task)
        }
        if (kind === 'full_test_review') {
          const ft = this.applyFullTestReview(task, record, v.normalized, input.actorRole)
          if (ft.ok !== true) return ft
          task.history.push(await audit(task.id, input.actorRole, 'fulltest:review', {
            approval_id: ft.chain.approval_id,
            stage: v.normalized.stage,
            ok: v.normalized.ok === true,
            status: ft.chain.status,
          }))
          await persist(task)
        }

      // ★ 人工介入请求：除了那份**不可变**的交接物，还要建一条**活的**生命周期记录。
      //
      //   两份东西的分工要写清楚，否则以后必然漂移：
      //     · `handoffs/NNN-human_request.json` = 提交时的**原件**（不可变，可审计"当时问了什么"）
      //       ⇒ `pipeline_status` 里那行「[人工介入请求] …」读的就是 `task.handoffs[]`
      //     · `task.human_requests[i]`          = 这条请求的**生命周期**（转告/答复/恢复都记在这里）
      //       ⇒ `pipeline_human_relay`（收件箱）与 `pipeline_human_reply` 读的是这里
      //   它们用 `handoff_id` 对上。
      //
      //   ⚠️ 两条数据源**必须一起落**：写第一份的是 `appendHandoff`（前面已经落盘了），
      //      写第二份的是**紧贴它的那一小段**（`createHumanRequestEntry`，见上方 ★★）。
      //      早先两处是分开的两步、还隔着几百行 ⇒ 中间一中断就留下
      //      「交接物在盘上、登记表空的」半截现场，而推进状态只看 `payload.blocking`，
      //      照样能把任务推成 awaiting_human ⇒ 永久卡死（真单 T-20261011-63633e、
      //      T-20261011-214043、T-20261011-5a871c）。
      //      所以下面再补一道**登记闸**：交接物落地时登记必须同时落上。
      if (kind === 'human_request' && humanRequest !== null) {
        const hentry = await audit(task.id, input.actorRole, 'human:request', {
          request_id: humanRequest.request_id,
          handoff_id: record.handoff_id,
          reason_kind: humanRequest.reason_kind,
          blocking: humanRequest.blocking,
          urgency: humanRequest.urgency,
          decision_kind: humanRequest.decision_kind,
          timeout_behavior: humanRequest.timeout_behavior,
          state_at_request: humanRequest.state_at_request,
          agent: input.actorAgentId,
        })
        task.history.push(hentry)
        await persist(task)

        // ★ **登记闸**：此刻登记表里若没有这条请求（说明上面那一步没能落上），
        //   立刻按交接物补齐并留痕 —— "能进状态、能落交接物"的路径**必须同时登记**。
        await this.enforceHumanRequestRegistration(task, record)

        // ★ 单向门：把上游那条澄清请求标成"已升级"，从此**只能由用户答复解决**。
        if (typeof humanRequest.escalated_from === 'string' && humanRequest.escalated_from.length > 0) {
          const up = (task.clarification_requests ?? []).find((r) => r.handoff_id === humanRequest.escalated_from)
          if (up !== undefined && up.escalated_at === null) {
            up.escalated_at = humanRequest.created_at
            up.escalated_to = humanRequest.request_id
            up.status = 'escalated'
            const eentry = await audit(task.id, input.actorRole, 'clarify:escalate', {
              request_id: up.request_id,
              escalated_to: humanRequest.request_id,
              raised_by: up.from_role,
              orchestrator_reason: v.normalized.orchestrator_reason ?? null,
              agent: input.actorAgentId,
            })
            task.history.push(eentry)
            await persist(task)
          }
        }
      }

      let advanced = null
      // ★ 席位未到齐时：**交接物照收，但先不推进**。
      //
      //   这里是有意为之，不是漏判：一个席位先干完先交，是完全正常的节奏；
      //   如果因为它交得早就把它的活退回去（或拒绝），那才是坏的。
      //   所以：先落盘、先留痕，等最后一个席位到齐时由**它**触发推进。
      let heldForSeats = false
      if (advance !== null && willAdvance && kind === 'dev_to_test') {
        const gate = checkAllSeatsSubmitted(task)
        if (gate.ok !== true) heldForSeats = true
      }

      if (advance !== null && willAdvance && !heldForSeats) {
        const applied = await this.transition({
          taskId: task.id,
          event: advance.event,
          actorRole: input.actorRole,
          actorAgentId: input.actorAgentId,
          note: `由交接物 ${record.handoff_id} 自动推进`,
        })
        if (applied.ok !== true) {
          // 回滚：把刚写的交接物摘掉，保持"要么全成、要么全不成"。
          task.handoffs.pop()
          await this.removeHandoffFile(task, record)
          // ★ 登记也要一起摘掉：否则会留下一条"指着一份已被删掉的交接物"的**悬空登记** ——
          //   收件箱会把它列成待转告，转告时却找不到原件，答复更是无从记回。
          //   与上面那句同源：两条数据源**一起落、也要一起撤**。
          if (humanRequest !== null && Array.isArray(task.human_requests)) {
            task.human_requests = task.human_requests.filter((r) => r.handoff_id !== record.handoff_id)
          }
          // ★ 计划缺失回流那条澄清记录也要一并摘掉 —— 否则会留下一条
          //   "指着一份不存在的计划"的悬空请求（需求分析会去答一个不存在的缺口）。
          if (planGapEntry !== null) {
            task.clarification_requests = (task.clarification_requests ?? []).filter((r) => r.request_id !== planGapEntry.request_id)
          }
          await persist(task)
          return deny('BAD_TRANSITION', `交接物已回滚（状态推进失败）：${applied.error}`)
        }
        advanced = { from: applied.from, to: applied.to }
        if (advance.leg !== null) {
          task.rework[advance.leg] = (task.rework[advance.leg] ?? 0) + 1
          const rentry = await audit(task.id, input.actorRole, `rework:${advance.leg === 'dev' ? 'writer' : 'tester'}`, {
            via: `handoff:${kind}`,
            used: task.rework[advance.leg],
            budget: task.roster?.rework_budget ?? maxRework,
            agent: input.actorAgentId,
          })
          task.history.push(rentry)
          await persist(task)
        }
      }

      return {
        ok: true,
        task,
        handoff: record,
        advanced,
        summary:
          `交接物已提交：${record.handoff_id}（${schema.zh}，${roleLabel(input.actorRole)} → ${schema.to}）。` +
          (advanced === null ? '' : `\n任务状态：${STATE_LABEL[advanced.from]} → ${STATE_LABEL[advanced.to]}。`) +
          seatsNote +
          (heldForSeats ? '\n（席位未到齐：这份交接物已收下并留痕，但状态先不动 —— 等最后一个席位交完自动推进。）' : ''),
      }
    },
  }
}
