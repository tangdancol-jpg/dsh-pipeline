/**
 * dsh-pipeline · 边界清单的**工具面**（E 路 ③）
 * ============================================================================
 * 从 `lib/boundaries.js` 拆出（纯搬迁：标识符 / 字符串 / 默认值 / 逻辑逐字未动）：
 *   · `eventLevelToolNames`：认出"入参里有 `event`"的事件级工具
 *   · `deriveToolFace`：按角色推导**实际可见**的流水线工具面
 *   · `parseToolAuthority`：从守门判词里读出角色白名单
 *
 * 由 `lib/boundaries.js`（barrel）与 `lib/boundaries/manifest.js` 复用。
 *
 * @module dsh-pipeline/lib/boundaries/tool-face
 */

import { ROLES } from '../roles.js'
import { TRANSITIONS } from '../states.js'

/**
 * ★★ **事件级工具**：入参里有 `event`（事件名）的那些 —— 它们的权限是**逐事件**判的。
 *
 * ---------------------------------------------------------------------------
 * 为什么它们必须从"按角色收紧"里移出去（2026-10-14 回归修复）
 * ---------------------------------------------------------------------------
 * `pipeline_transition` 在守门里的白名单是 `['main','human']`（`lib/guard/rules.js` 的 `PIPELINE_TOOL_ROLES`），
 * 于是工具面把它当成"编写 / 测试 / 审核 / 计划 / 主管都会被拒的工具"**藏掉了**。
 * 但它的真实判据**不在那一行**：它执行的是状态机的**逐事件**边 ——
 * `TRANSITIONS[].by`（`lib/states.js:595` 的 `dev_submitted: by ['writer']`、
 * `:620` 的 `review_ok: by ['reviewer']`、`:633` 的 `clarification_reply: by ['orchestrator']` …）
 * 加上 `store.transition` 的逐事件前置条件。也就是说：
 * **同一行白名单对 `dev_submitted`（by writer）与 `cancel`（by main/human）是两个不同的答案**，
 * 而"按角色隐藏"只能表达一个 —— 那等于**工具面替状态机做了逐事件判断** ✗。
 *
 * 与 E 路自己那三条机械判据同源：**不隐藏守门放行的工具**；
 * 这里的补丁是它的对偶面：**也不替状态机去隐藏"逐事件才判得清"的工具**。
 * 判据仍然在原来的地方（状态机的 `by` 名单 + 守门 + `store` 的前置条件），
 * 本函数**不产出任何拒绝**，只把这一类的**工具面归属**说清楚。
 *
 * ★ **不写死工具名**：从**注册定义**的参数表里认（`parameters.event`）——
 *   以后再有"以事件为入参"的工具，它**自动**进入这一类，不需要回来改名单。
 *   两种 schema 形态都认（已编译的 `{type,properties}` / 退化的裸属性表），
 *   与 `lib/tools.js` 的 `propsOf` 同源。
 *
 * @param {Array|object} [defs] - 注册定义（数组或 `{key: def}` 映射）
 * @returns {string[]} 事件级工具名（可能为空 —— 空 = 这一类不存在，行为与改前逐字节相同）
 */
export function eventLevelToolNames(defs = []) {
  const list = Array.isArray(defs) ? defs : Object.values(defs ?? {})
  const out = []
  for (const d of list) {
    const name = typeof d?.name === 'string' ? d.name : ''
    if (name.length === 0 || out.includes(name)) continue
    const props = d?.parameters?.properties ?? d?.parameters ?? {}
    if (props !== null && typeof props === 'object' && Object.prototype.hasOwnProperty.call(props, 'event')) out.push(name)
  }
  return out
}

/**
 * 把 `eventLevel` 的两种给法（工具名数组 / 注册定义）归一成工具名数组。
 *
 * @param {Array|object|null} v
 * @returns {string[]}
 */
function normalizeEventLevel(v) {
  if (v === null || v === undefined) return []
  return (Array.isArray(v) ? v : Object.values(v))
    .map((x) => (typeof x === 'string' ? x : typeof x?.name === 'string' ? x.name : ''))
    .filter((s) => s.length > 0)
}

/**
 * ★★ **E 路 ③：按角色推导"实际可见的流水线工具面"**（给别的执法层 + 给本插件自己用）。
 *
 * ---------------------------------------------------------------------------
 * 它解决什么
 * ---------------------------------------------------------------------------
 * 改前：20+ 个 `pipeline_*` 工具**对每个子代理全量注册** —— 一个 `writer` 席位
 * 的每一轮请求里都背着 `pipeline_dispatch` / `pipeline_close` / `pipeline_supervise`
 * 这些它**根本调不动**（守门按角色白名单直接拒）的工具 schema。那是**每个请求
 * 都要付**的固定成本，而它买到的是零能力。
 * 参考 `dsh-ops` 的 `lib/index.js:128-139` + `lib/policy.js:26-66`（"absent tools
 * never get advertised"：提示词按**实际可见工具**惰性渲染，一个可见工具都没有
 * 就返回空串）+ `lib/session-shells.js:75-81`（用 `restrict({deny})` 遮蔽）。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么"推导"而不是"手抄一份名单"
 * ---------------------------------------------------------------------------
 * 手抄的名单一定会与守门漂移，而漂移的方向有两种，**坏的那一种是放宽**。
 * 所以这里的权威只有一个：**守门自己的判据**。做法是把
 * `guardDecision()`（`lib/guard.js` 导出的公开判据）拿**一个匿名调用方**问一遍 ——
 * 它对"按角色白名单管着的工具"会吐出那句
 * `允许角色：main / human`（`lib/guard/decide.js` 的 `decide`），
 * 于是白名单**从判词里读出来**，而不是从源码里抄出来。
 *
 * 三条纪律（全部是**安全方向**的）：
 *   ① **认不出 ⇒ 不收紧**：判词读不到角色白名单（判据改了措辞 / 该工具压根不按角色管）
 *      ⇒ 该工具**对所有角色可见**。宁可少省字节，绝不因为"读不懂"而藏掉一个角色需要的工具；
 *   ② **不判据化就不隐藏**：本模块**只**产出"谁看得见谁看不见"，不产出任何拒绝 ——
 *      守门一个字都不动（少注册 ≠ 放行）；
 *   ③ **可追溯**：结论连同**判词原文的出处**一起进 `pipeline_boundaries` 的只读导出。
 *
 * @param {object} opts
 * @param {string[]} [opts.toolNames] - 实际注册的 `pipeline_*` 工具名（由 `lib/tools.js` 给）
 * @param {(name:string)=>string|undefined} [opts.judge] - 守门判词探针（匿名调用方）
 * @param {string[]} [opts.roles] - 要展开的角色（默认取 `roles.js` 的 `ROLES`）
 * @param {Array|object} [opts.eventLevel] - **事件级工具**（工具名数组，或直接给注册定义
 *   —— 由 {@link eventLevelToolNames} 认）。★ 这一类**不按角色收紧**：权限逐事件判。
 * @returns {object} 纯数据，可直接 JSON 序列化
 */
export function deriveToolFace({ toolNames = [], judge = null, roles = null, eventLevel = null } = {}) {
  const roleIds = (Array.isArray(roles) && roles.length > 0 ? roles : Object.values(ROLES).map((r) => r.id)).map(String)
  const names = (Array.isArray(toolNames) ? toolNames : []).map(String)
  const hasJudge = typeof judge === 'function'
  /** ★★ 事件级工具（只认**在册工具名**里的那些 —— 拼错的名字不会凭空造出一个工具）。 */
  const eventSet = new Set(normalizeEventLevel(eventLevel).filter((n) => names.includes(n)))
  const judged = []
  for (const name of names) {
    /**
     * ★★ **事件级工具：不按角色收紧**（见 {@link eventLevelToolNames} 的文件级说明）。
     *
     * 判词照旧读一次（留证：守门那一行白名单到底写了谁），但**结论不受它支配** ——
     * 因为这一类的权限是逐事件的，工具面这一层没有资格替状态机回答
     * "这个角色能不能发这个事件"。**少给定义 ≠ 放宽拒绝**：守门与状态机一个字没动。
     */
    if (eventSet.has(name)) {
      let guardRoles = null
      if (hasJudge) {
        try {
          guardRoles = parseToolAuthority(judge(name))
        } catch {
          guardRoles = null
        }
      }
      judged.push({
        tool: name,
        roles: null,
        event_level: true,
        guard_roles: guardRoles,
        why:
          '事件级工具（入参里有 `event`）⇒ 权限**逐事件**判（状态机 `TRANSITIONS[].by` + ' +
          '`store.transition` 的逐事件前置条件）⇒ 工具面这一层**不按角色收紧**' +
          (guardRoles === null ? '' : `（守门那一行白名单写的是：${guardRoles.join(' / ')} —— 它比状态机的 by 名单粗，不足以定这一类的工具面）`),
      })
      continue
    }
    if (!hasJudge) {
      judged.push({ tool: name, roles: null, why: '没有注入守门判词探针 ⇒ **不收紧**（全角色可见）' })
      continue
    }
    let verdict
    try {
      verdict = judge(name)
    } catch (err) {
      judged.push({ tool: name, roles: null, why: `判词读取抛错 ⇒ 不收紧：${String(err?.message ?? err).split('\n')[0]}` })
      continue
    }
    const allowed = parseToolAuthority(verdict)
    judged.push(
      allowed === null
        ? {
            tool: name,
            roles: null,
            why:
              typeof verdict === 'string' && verdict.length > 0
                ? '判词里没有角色白名单（该工具不按角色管；判据在 execute / 状态机里）⇒ 不收紧'
                : '守门放行匿名调用 ⇒ 该工具不按角色收紧',
          }
        : { tool: name, roles: allowed, why: `守门角色白名单（判词原文）：${allowed.join(' / ')}` },
    )
  }

  const byRole = {}
  for (const role of roleIds) {
    const visible = []
    const hidden = []
    for (const e of judged) {
      if (e.roles === null || e.roles.includes(role)) visible.push(e.tool)
      else hidden.push(e.tool)
    }
    byRole[role] = {
      visible,
      hidden,
      visible_count: visible.length,
      hidden_count: hidden.length,
      /** ★ **实际**会不会对它收紧：主对话**不收紧**（口径：主对话看到全量）。 */
      denied: role === 'main' ? [] : hidden,
      why: role === 'main' ? '主对话看全量（它是用户的对话框，也是"该知道有哪些工具"的那一方）' : '其余角色：隐藏面 = 守门本来就会按角色白名单拒掉的那些',
    }
  }

  const hiddenTotal = {}
  for (const role of roleIds) hiddenTotal[role] = byRole[role].denied.length
  const most = roleIds
    .map((r) => ({ role: r, hidden: byRole[r].hidden_count }))
    .sort((a, b) => b.hidden - a.hidden)
  /**
   * ★★ **事件级工具**那一条诚实边界（2026-10-14 回归修复）。
   *
   * `transition_actors` 是**状态机自己**说"哪些角色能发事件"的并集
   * （`TRANSITIONS[].by`）—— 它通常**宽于**守门那一行工具白名单，两者不一致
   * 正是"这一类不能按角色收紧"的证据（谁对谁错由状态机 + store 逐事件判，
   * 工具面这一层不下结论）。
   */
  const transitionActors = []
  for (const t of Array.isArray(TRANSITIONS) ? TRANSITIONS : []) {
    for (const r of Array.isArray(t?.by) ? t.by : []) {
      const s = String(r)
      if (s.length > 0 && !transitionActors.includes(s)) transitionActors.push(s)
    }
  }
  const eventLevelList = judged
    .filter((e) => e.event_level === true)
    .map((e) => ({
      tool: e.tool,
      guard_roles: Array.isArray(e.guard_roles) ? e.guard_roles : null,
      transition_actors: transitionActors,
      why: e.why,
    }))

  return {
    plugin: 'dsh-pipeline',
    version: 1,
    /** 判词从哪来（**唯一权威**；本模块不存第二份白名单）。 */
    source: hasJudge
      ? 'guard:guardDecision（匿名调用方的真实判词；白名单**从判词里读**，不手抄）'
      : 'unavailable（没注入探针 ⇒ 一个工具都不收紧）',
    tool_count: names.length,
    /** 逐个工具的判词结论（`roles: null` = 不按角色收紧）。 */
    judged,
    /** ★ 「某角色可见哪些工具」—— 只读导出要能直接回答这个问题。 */
    by_role: byRole,
    /** ★ 一眼看出"给谁减了几个"。 */
    hidden_total: hiddenTotal,
    /** 减得最多的几个角色（排序只是给人看，判据不依赖它）。 */
    hidden_rank: most,
    /** ★ 诚实边界：这些工具**不按角色收紧**（它们的判据在别处），别以为它们在工具面上是有保障的。 */
    not_role_gated: judged.filter((e) => e.roles === null).map((e) => ({ tool: e.tool, why: e.why })),
    /**
     * ★★ **事件级工具**（入参里有 `event`）：权限**逐事件**判 ⇒ 工具面这一层不按角色收紧。
     * 空数组 = 这一类不存在（行为与改前逐字节相同）。
     */
    event_level: eventLevelList,
    /**
     * ★★ 四条**不会**发生的事（机械判据，不是形容词）。
     */
    tightening: {
      changes_guard_decision: false,
      hides_guard_allowed_tool: false,
      /** ★ 事件级工具（如 `pipeline_transition`）**一个都不隐藏** —— 判据在状态机里，不在这里。 */
      hides_event_level_tool: false,
      applies_to_main: false,
      when: '只在 guardEnabled=true 且总开关为开时、对该会话角色首次确定之后收紧一次；失败即放弃（不抛、不重试）',
      unregistered_call: '没注册/被隐藏的工具被调用时的行为与"守门按角色白名单拒"一致或更明确（不是放行）',
    },
  }
}

/**
 * 从守门的判词里读出**角色白名单**。
 *
 * 判词形状（`lib/guard/decide.js` 的 `decide`）：
 *   `[pipeline] 角色越权被拦下。\n工具：X\n允许角色：main / human\n当前角色：writer\n…`
 *
 * ★ **认不出返回 `null`**（= 不按角色收紧），而不是返回空数组 ——
 *   空数组会被下游读成"谁都不许用"，那是**收紧**方向；这个函数只在证据充分时收窄。
 *
 * @param {unknown} verdict - `guardDecision()` 的返回值
 * @returns {string[]|null}
 */
export function parseToolAuthority(verdict) {
  if (typeof verdict !== 'string' || verdict.length === 0) return null
  const m = /允许角色：([^\n]+)/.exec(verdict)
  if (m === null) return null
  const roles = m[1]
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return roles.length > 0 ? roles : null
}
