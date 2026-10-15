// 能力申请工具面 · `pipeline_capability_request`：申请 / 批准 / 驳回 / 查台账（**主对话唯一**）。
/**
 * dsh-pipeline · 工具面 · `pipeline_capability_request`
 * ============================================================================
 * 用户原话第 1 件的下半条：
 *
 *   「主对话的限制应该是平常禁止读代码、写面、工具面按角色收紧等，
 *     **但是必要时能向用户申请**，主对话能知道工具，**但是被告知必要申请**，
 *     且**最好别碰**」
 *
 * 这句话里三个词各落一处，缺一条这条通道就变成后门：
 *   · **能知道工具** ⇒ 受限工具**不从清单里摘掉**（`lib/boundaries.js` 的
 *     `deriveToolFace` 把 `main.denied` 写死为空）。这一条不是本工具做的，是它的前提。
 *   · **必要申请** ⇒ **本工具**：把"我要用一次 X、作用域是 Y、理由是 Z"落成台账。
 *   · **最好别碰** ⇒ persona 的原话（`presets/src/main/prefix.md`），
 *     以及本工具在**申请**这一步就把过分的要求挡回去（`*` 全域要写清理由、
 *     `shell` 不可申请 —— 见 `lib/guard/capability.js` 的文件头）。
 *
 * ---------------------------------------------------------------------------
 * 三步（**谁申请 · 向谁申请 · 怎么留痕 · 批准后怎么放行一次**）
 * ---------------------------------------------------------------------------
 *   ① `action:"request"`  —— **主对话**（只有它）发起：能力 + 作用域 + 理由 ⇒ 台账落一行，
 *      返回一段**照抄给用户**的原文。
 *   ② 用户答复 —— 主对话**不能替用户拍板**：`approve` 必须带 `user_quote`（用户原话）。
 *   ③ `action:"approve"`  —— 台账再落一行 `approve` ⇒ 这条额度变成 `approved`。
 *      此后**守门**在 `decide()` 里遇到同一能力、且目标落在作用域内的那一次调用 ⇒
 *      **放行一次**并追加一行 `release`；额度随即变成 `used`，**再调就被拒**。
 *
 * ★ 留痕 = `<任务目录>/capability-grants.jsonl`（追加式，见 `lib/guard/grant.js`）。
 * ★ 只有主对话能调（守门白名单 `pipeline_capability_request: ['main']`）：
 *   别的角色要"多要一点权限"，走既有的两级梯（`pipeline_clarify_request`）或人工介入
 *   （`pipeline_human_request`）—— 那两条通道的受理人是需求分析与用户，本来就对。
 *
 * @module dsh-pipeline/lib/tools/capability
 */

import { join } from 'node:path'

import { ROLE } from '../roles.js'
import { pathKey } from '../util.js'
import { S, tool, resolveActor } from './kit.js'
import { CAPABILITY_ZH, GRANTABLE_CAPABILITIES, SCOPE_ANY, describeScope, isGrantable, normalizeScope } from '../guard/capability.js'
import { GRANT_FILE, GRANT_STATE, appendGrant, grantFileOf, grantIdOf, readGrants } from '../guard/grant.js'
import { taskSelfDirOf } from '../guard/seats.js'

/** 台账摘要里状态的人话。 */
const STATE_ZH = {
  [GRANT_STATE.PENDING]: '申请中（**还没批准 ⇒ 调用照旧被拒**）',
  [GRANT_STATE.APPROVED]: '已批准（**还可用 1 次**）',
  [GRANT_STATE.USED]: '已用尽（**再调就被拒**，要再申请一次）',
  [GRANT_STATE.REJECTED]: '已驳回',
}

/**
 * 能力申请工具。
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字
 */
export function buildCapabilityTools(ctx) {
  const { deps, config, store, load } = ctx

  /** 台账落点：任务自己的目录（公式唯一出处 = `guard/seats.js` 的 `taskSelfDirOf`）。 */
  const fileOfTask = (task) => {
    const root = pathKey(task?.project_root ?? store?.projectRoot ?? '')
    if (root.length === 0) return ''
    return grantFileOf({ taskSelfDir: taskSelfDirOf(join(root, config.artifactDirName ?? '.pipeline'), task.id) })
  }

  const capabilityRequest = tool(deps, {
    name: 'pipeline_capability_request',
    mutating: true,
    description:
      '【主对话专用】★ 能力申请通道：把「我要用一次 X（作用域 Y），理由是 Z」落成台账，' +
      '经**用户明确答复**后**放行一次**。' +
      '可用能力：' + GRANTABLE_CAPABILITIES.join(' / ') + '（**shell 不可申请** —— 它是边界集合，不是能力）。' +
      '三步：`action:"request"` ⇒ 拿返回原文问用户 ⇒ 用户答复后 `action:"approve"`（**必须带 user_quote**）。' +
      '★ **批准只放行一次**：额度用完即 `used`，再调就被拒；要再要一次就再走一遍三步。' +
      '★ 台账：`<任务目录>/capability-grants.jsonl`（追加式，可追溯）。',
    parameters: {
      task_id: S('string', '任务 ID'),
      action: S('string', '要做什么：request = 申请｜approve = 记下用户批准｜reject = 记下用户驳回｜list = 查台账', {
        enum: ['request', 'approve', 'reject', 'list'],
      }),
      capability: S('string', `能力 id（request 时必填）：${GRANTABLE_CAPABILITIES.join(' / ')}`),
      scope: S('string', '★ 作用域（request 时必填）：一个路径，或 `*`（任意路径，**要写清理由**）。一次只申请一件事。'),
      reason: S('string', '为什么要这一次（会进台账；也是 `*` 能不能被批准的依据）'),
      request_id: S('string', '申请 id（approve / reject 时必填；就是 request 返回里的 request_id）'),
      user_quote: S('string', '★ approve 时必填：**用户本人的原话**（转述不算 —— 主对话不能替用户拍板）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      action: S('string', '实际执行的动作'),
      request_id: S('string', '这次申请 / 操作的 id'),
      state: S('string', '这条额度现在的状态（pending / approved / used / rejected）'),
      summary: S('string', '给人看的摘要（request 时会附一段**照抄给用户**的原文）'),
    },
    async run(args, exec) {
      const empty = { action: '', request_id: '', state: '' }
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, ...empty, summary: actor.error }
      if (actor.role !== ROLE.MAIN) {
        return {
          ok: false,
          ...empty,
          summary:
            `拒绝：只有**主对话**能走能力申请通道（当前角色是「${actor.role}」）。\n` +
            '★ 你要多要一点权限，走你自己的那条梯子：`pipeline_clarify_request`（问需求分析）' +
            '或 `pipeline_human_request`（升给用户）。那两条的受理人本来就对。',
        }
      }
      const task = await load(String(args.task_id ?? ''))
      if (task === null) return { ok: false, ...empty, summary: `找不到任务 ${args.task_id}。` }
      const file = fileOfTask(task)
      if (file.length === 0) return { ok: false, ...empty, summary: `任务 ${task.id} 的项目根取不到 ⇒ 台账无处可落（拒，不静默）。` }

      const action = String(args.action ?? '')
      const grants = readGrants(file)

      // ---- list -------------------------------------------------------------
      if (action === 'list') {
        const lines = grants.map(
          (g) => `  · ${g.id}　${g.capability}（${CAPABILITY_ZH[g.capability] ?? g.capability}）　作用域 ${describeScope(g.scope)}　⇒ ${STATE_ZH[g.state] ?? g.state}`,
        )
        return {
          ok: true,
          action,
          request_id: '',
          state: '',
          summary:
            `任务 ${task.id} 的能力额度台账（${GRANT_FILE}，共 ${grants.length} 条）：\n` +
            (lines.length > 0 ? lines.join('\n') : '  （空 —— 还没申请过）'),
        }
      }

      // ---- request ----------------------------------------------------------
      if (action === 'request') {
        const capability = String(args.capability ?? '').trim()
        if (!isGrantable(capability)) {
          return {
            ok: false,
            ...empty,
            summary:
              `拒绝申请：能力「${capability}」不在可申请之列（可申请：${GRANTABLE_CAPABILITIES.join(' / ')}）。\n` +
              '★ `shell` 刻意不可申请：它的判据是**按命令内容**判的（改项目文件 / 跑测试 / 绕过收尾清理），' +
              '那是"一堆边界的集合"，不是一个能力。给它一条"申请即可整体放行"的路 = 用一个布尔关掉整层判据。\n' +
              '  要用 shell 走**具名工具**：`pipeline_status` / `pipeline_task_purge` / `pipeline_security_check` …',
          }
        }
        const scope = normalizeScope(args.scope, task.project_root ?? store?.projectRoot ?? '')
        if (scope.length === 0) {
          return { ok: false, ...empty, summary: '拒绝申请：`scope` 为空 —— 没有作用域的额度等于没有额度。填一个路径，或写 `*`（任意路径）。' }
        }
        if (scope.includes(SCOPE_ANY) && String(args.reason ?? '').trim().length === 0) {
          return {
            ok: false,
            ...empty,
            summary: '拒绝申请：作用域 `*`（任意路径）**必须写 `reason`** —— 全域额度的理由要能被用户看见。\n★ 更稳的做法：把作用域收窄到真正要碰的那一个路径。',
          }
        }
        const id = grantIdOf({ capability, scope, reason: args.reason })
        const existing = grants.find((g) => g.id === id)
        if (existing !== undefined && existing.state !== GRANT_STATE.REJECTED) {
          return {
            ok: true,
            action,
            request_id: id,
            state: existing.state,
            summary:
              `这条申请**已经存在**（${id}）—— 同能力 + 同作用域 + 同理由 = 同一条，不会刷出第二份待批。\n` +
              `  当前状态：${STATE_ZH[existing.state] ?? existing.state}\n` +
              '★ 还需要用户答复：把下面这段照抄给用户。\n' + relayText(task.id, id, capability, scope, args.reason),
          }
        }
        const w = appendGrant(file, {
          id,
          op: 'request',
          capability,
          scope,
          reason: String(args.reason ?? ''),
          by: actor.role,
          task_id: task.id,
          at: new Date().toISOString(),
        })
        if (w.ok !== true) return { ok: false, ...empty, summary: `申请没落盘（${w.error}）—— 没落盘就不算申请过。` }
        return {
          ok: true,
          action,
          request_id: id,
          state: GRANT_STATE.PENDING,
          summary:
            `已记下申请（${id}）：${capability}（${CAPABILITY_ZH[capability] ?? capability}）· 作用域 ${describeScope(scope)}。\n` +
            '★ 状态是 **申请中** ⇒ **调用照旧被拒**。要放行必须先拿到用户答复，再调 `action:"approve"`。\n' +
            relayText(task.id, id, capability, scope, args.reason),
        }
      }

      // ---- approve / reject -------------------------------------------------
      const id = String(args.request_id ?? '').trim()
      const target = grants.find((g) => g.id === id)
      if (id.length === 0 || target === undefined) {
        return { ok: false, ...empty, summary: `找不到申请 ${id || '(空)'} —— 先用 action:"request" 发起，或先用 action:"list" 看台账。` }
      }
      if (action === 'approve') {
        const quote = String(args.user_quote ?? '').trim()
        if (quote.length === 0) {
          return {
            ok: false,
            ...empty,
            summary:
              '拒绝记录批准：`user_quote` 为空。\n' +
              '★ **主对话不能替用户拍板**：这条字段必须是用户本人的原话（转述不算）。先问用户，再把他怎么说的抄回来。',
          }
        }
        if (target.state === GRANT_STATE.USED) {
          return { ok: false, ...empty, summary: `申请 ${id} 已经**用尽**了 —— 批准只放行一次，要再用就重新申请一次（action:"request"）。` }
        }
        const w = appendGrant(file, { id, op: 'approve', by: 'user', quote, at: new Date().toISOString() })
        if (w.ok !== true) return { ok: false, ...empty, summary: `批准没落盘（${w.error}）—— 没落盘就不算批准过，调用照旧被拒。` }
        return {
          ok: true,
          action,
          request_id: id,
          state: GRANT_STATE.APPROVED,
          summary:
            `已记下用户批准（${id}）：${target.capability} · 作用域 ${describeScope(target.scope)}。\n` +
            '★ **只放行一次**：下一次落在同一能力、且目标在该作用域内的调用会被守门放行，并立刻记一行 `release`；' +
            '那之后这条额度就是 `used`，**再调就被拒**。',
        }
      }
      if (action === 'reject') {
        const w = appendGrant(file, { id, op: 'reject', by: 'user', reason: String(args.reason ?? ''), at: new Date().toISOString() })
        if (w.ok !== true) return { ok: false, ...empty, summary: `驳回没落盘（${w.error}）。` }
        return { ok: true, action, request_id: id, state: GRANT_STATE.REJECTED, summary: `已记下驳回（${id}）—— 这条额度不会放行任何调用。` }
      }
      return { ok: false, ...empty, summary: `不认识的 action「${action}」（可用：request / approve / reject / list）。` }
    },
  })

  return { capabilityRequest }
}

/** 「照抄给用户」的那一段（**给人看的原话**，不是给模型看的命令）。 */
function relayText(taskId, id, capability, scope, reason) {
  return (
    '\n──── 照抄给用户 ────\n' +
    `我需要**临时**用一次「${CAPABILITY_ZH[capability] ?? capability}」的能力，这次只碰：${describeScope(scope)}。\n` +
    `理由：${String(reason ?? '').trim() || '（没写）'}\n` +
    '批准只生效**一次**，用完就失效；不批准我就换别的办法（派活或查状态）。可以吗？\n' +
    `（申请号 ${id} · 任务 ${taskId}）\n` +
    '────────────────────\n'
  )
}
