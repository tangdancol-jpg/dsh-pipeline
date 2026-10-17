/**
 * dsh-pipeline · 自建流水线面板 · **写操作面**（用户在面板里点的那几个按钮）
 * ============================================================================
 * 快照（`lib/panel/snapshot.js`）回答"这张单现在能点哪几个按钮"；本模块回答
 * "点下去到底发生了什么"。两边共用**同一份判据来源**：
 *
 *   · 终态 / 可取消 / 可恢复 —— `lib/states.js`（`TERMINAL_STATES` / `findTransition`）；
 *   · 归档 / 删单 —— `store.purgeTask()`（`lib/store/purge.js`，那边自己就有
 *     "只认终态单 / 先留痕后动手 / 默认进回收站"三条硬约束）；
 *   · 终止 / 恢复 —— `store.transition()`（`lib/store/lifecycle.js`，状态机 + 审计都它管）。
 *
 * ★★ 本文件**不发明第二套判据**：它只做三件事 —— 白名单、开关门、把这些返回
 *   归一成面板好显示的一个形状。状态机不接受的操作由 store 原话拒绝，这里**原样透出**
 *   （含 `code`），绝不把"被拒"粉饰成"成功"。
 *
 * ---------------------------------------------------------------------------
 * 安全边界（与 `lib/switch-routes.js` 同一条口径，如实写出来）
 * ---------------------------------------------------------------------------
 *   · **开关关着 = 一律不执行**（`sw.isOn() !== true`）。理由与 `pipeline_switch` 一样：
 *     关掉功能时本插件的写动作全停，面板不能变成那条纪律的后门。
 *   · **`delete` 必须二次确认**（`confirm === true`）。它对应 `purgeTask(mode:'delete')`
 *     —— **不可恢复**；`archive`（= 回收站）才是默认出口。
 *   · **绝不抛**：底层抛异常、返回形状不对，一律归一成 `{ok:false, code?}`。
 *     面板是一个 5 秒轮询的 UI，抛出去只会变成一句"未知错误"。
 *
 * 返回形状（成功 / 失败**同一套键**，客户端不必分支猜形状）：
 *
 *     { ok:true,  action, task_id, message }        // message 是中文人话
 *     { ok:false, action, task_id, error, code? }   // error 是底层拒绝原文
 *
 *   · `cancel` 成功 ⇒ `已终止：<state>`（`<state>` 是迁移落点的 **状态 id**，
 *     如 `已终止：cancelled`；中文名由快照的 `state_label` 给，这边不重复翻译）；
 *   · `restore` 成功 ⇒ `已恢复`；`archive` ⇒ `已留档`；`delete` ⇒ `已删单`。
 *
 * @module dsh-pipeline/lib/panel/actions
 */

/**
 * 面板动作白名单（顺序与快照 `allowed_actions` 的契约顺序一致）。
 * ★ `lib/panel/snapshot.js` 的 `PANEL_ACTION_ORDER` 与这里是同一组名字 ——
 *   那边判"能不能点"，这边判"点了认不认"。
 */
export const PANEL_ACTION_IDS = Object.freeze(['cancel', 'restore', 'archive', 'delete'])

/** 开关关着时的拒绝原文（与 `lib/switch/gate.js` 那条纪律同义，面板侧一句人话）。 */
export const SWITCH_OFF_ERROR = '多AI协同已关闭（先打开右上角开关再操作）'

/** 删单缺二次确认时的拒绝原文。 */
export const DELETE_CONFIRM_ERROR = '删单需要在面板里二次确认'

/** 底层方法不存在（接线不完整）时的错误码。 */
export const CODE_STORE_UNAVAILABLE = 'STORE_UNAVAILABLE'

/** 底层抛异常时的错误码。 */
export const CODE_ACTION_FAILED = 'PANEL_ACTION_FAILED'

/**
 * 造一个面板操作执行器。
 *
 * @param {object} deps
 * @param {object} deps.store - `createTaskStore()` 的实例（用它的 `purgeTask` / `transition`）
 * @param {object} deps.sw - 总开关（`lib/switch.js` 的 `createSwitch()`；读 `isOn()`）
 * @param {(m:string)=>void} [deps.log] - 异常留痕出口（**只记日志，不改返回值**）
 * @returns {{ run: (input:{task_id?:string, action?:string, confirm?:boolean}) => Promise<object> }}
 */
export function createPanelActions(deps = {}) {
  const store = deps !== null && typeof deps === 'object' ? deps.store ?? null : null
  const sw = deps !== null && typeof deps === 'object' ? deps.sw ?? null : null
  const log = typeof deps?.log === 'function' ? deps.log : () => {}

  /** 开关门：读一次 `isOn()`；缺方法 / 抛异常一律按"关"处理（fail-closed，不抛）。 */
  const switchOn = () => {
    try {
      return sw?.isOn?.() === true
    } catch (err) {
      log(`面板操作：读开关状态抛异常，按「关」处理（${reasonOf(err)}）`)
      return false
    }
  }

  return {
    /**
     * 执行一次面板操作（**绝不抛**）。
     *
     * @param {object} input
     * @param {string} input.task_id
     * @param {'cancel'|'restore'|'archive'|'delete'} input.action
     * @param {boolean} [input.confirm] - 仅 `delete` 需要；必须**严格** `true`
     * @returns {Promise<{ok:boolean, action:string, task_id:string, message?:string, error?:string, code?:string}>}
     */
    async run(input) {
      const req = input !== null && typeof input === 'object' ? input : {}
      const action = textOf(req.action)
      const taskId = textOf(req.task_id)
      const base = { action, task_id: taskId }

      // ① 白名单：认不出就明说认不出（不是"未知错误"）。
      if (!PANEL_ACTION_IDS.includes(action)) {
        return { ok: false, ...base, error: `未知操作：${action}` }
      }

      // ② 开关门：关着 ⇒ 一个动作都不执行（也不去读盘 / 不写盘）。
      if (!switchOn()) {
        return { ok: false, ...base, error: SWITCH_OFF_ERROR }
      }

      // ③ 删单二次确认（不可恢复的那一个动作单独加闸）。
      if (action === 'delete' && req.confirm !== true) {
        return { ok: false, ...base, error: DELETE_CONFIRM_ERROR }
      }

      try {
        if (action === 'archive') {
          const purge = store?.purgeTask
          if (typeof purge !== 'function') return unavailable(base, 'purgeTask')
          return normalizePurge(action, taskId, await purge.call(store, {
            taskId,
            mode: 'trash',
            by: 'human',
            reason: '面板·留档',
          }))
        }
        if (action === 'delete') {
          const purge = store?.purgeTask
          if (typeof purge !== 'function') return unavailable(base, 'purgeTask')
          return normalizePurge(action, taskId, await purge.call(store, {
            taskId,
            mode: 'delete',
            by: 'human',
            reason: '面板·删单',
          }))
        }
        // cancel / restore 走同一条状态机入口（与 `pipeline_transition` **同一份**实现）。
        const transition = store?.transition
        if (typeof transition !== 'function') return unavailable(base, 'transition')
        const result = await transition.call(store, action === 'cancel'
          ? { taskId, event: 'cancel', actorRole: 'human', note: '面板·终止' }
          : { taskId, event: 'unblock', actorRole: 'human', note: '面板·恢复' })
        return normalizeTransition(action, taskId, result)
      } catch (err) {
        // ④ 底层抛异常：留痕 + 归一成一句人话，**不抛**（面板轮询经不起异常）。
        log(`面板操作 ${action}（任务 ${taskId}）抛异常：${String(err?.stack ?? err)}`)
        return { ok: false, ...base, error: `操作失败：${reasonOf(err)}`, code: CODE_ACTION_FAILED }
      }
    },
  }
}

/* ------------------------------------------------------------------------- */
/* 归一化：底层两种返回形状 —— 照它们写，不另立判据                            */
/* ------------------------------------------------------------------------- */

/**
 * `store.purgeTask()` 的形状（`lib/store/purge.js`）：
 *   成功 `{ok:true, mode, task_id, moved_to, files, bytes, purged_at}`
 *   失败 `deny(code, message)` ⇒ `{ok:false, code, error}`
 */
function normalizePurge(action, taskId, result) {
  if (result !== null && typeof result === 'object' && result.ok === true) {
    return { ok: true, action, task_id: taskId, message: action === 'archive' ? '已留档' : '已删单' }
  }
  return failOf(action, taskId, result)
}

/**
 * `store.transition()` 的形状（`lib/store/lifecycle.js`）：
 *   成功 `{ok:true, task, from, to, state_zh, summary}`
 *   失败 `deny(code, message)` ⇒ `{ok:false, code, error}`（`TASK_NOT_FOUND` / `BAD_TRANSITION` 等）
 */
function normalizeTransition(action, taskId, result) {
  if (result !== null && typeof result === 'object' && result.ok === true) {
    const to = textOf(result.to)
    return {
      ok: true,
      action,
      task_id: taskId,
      // 「已终止：<state>」用**状态 id**（`to`），中文名由快照的 `state_label` 提供。
      message: action === 'cancel' ? `已终止：${to}` : '已恢复',
    }
  }
  return failOf(action, taskId, result)
}

/** 底层拒绝原文透出（`code` 有就带，没有就不硬编）。 */
function failOf(action, taskId, result) {
  const out = {
    ok: false,
    action,
    task_id: taskId,
    error: textOf(result?.error).length > 0 ? textOf(result?.error) : '操作被拒（底层没有给出原因）',
  }
  const code = textOf(result?.code)
  if (code.length > 0) out.code = code
  return out
}

/** 接线不完整（store 上没这个方法）—— 说清缺什么，不拿 TypeError 充当判词。 */
function unavailable(base, method) {
  return { ok: false, ...base, error: `面板操作未接线（store 没有 ${method}）`, code: CODE_STORE_UNAVAILABLE }
}

/** 宽松取文本：只收字符串（动作 id / 任务 id / 状态 id 都不该是对象）。 */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 异常 → 一句人话（不带堆栈；堆栈只进 log）。 */
function reasonOf(err) {
  const code = typeof err?.code === 'string' && err.code.length > 0 ? `${err.code} ` : ''
  return `${code}${String(err?.message ?? err)}`
}
