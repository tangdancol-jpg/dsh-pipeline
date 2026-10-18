// 等待工具面 · `pipeline_wait`：等到状态/事件再返回的长轮询（只读；替代主对话的 sleep 轮询）。
/**
 * dsh-pipeline · 工具面 · `pipeline_wait`（P2-11）
 * ============================================================================
 * 现场痛点：长单里主对话**没有"等一等"的接口**，只能
 *   ① `pipeline_status`（一次几万字节）→ ② `sleep 40s`（真机实测 40+ 次）→ ③ 再查。
 * 一条几分钟的活，光轮询就烧掉几十次工具调用与几十次 sleep —— token 浪费大户。
 *
 * 本工具把"等"变成**一次调用**：
 *   · 读 store 快照（`store.peek`；只有在缓存里没有时才 `load` 一次）；
 *   · 条件命中**立刻返回**；否则按 interval 轮询，最长 timeout；
 *   · **只读**：不改任务状态、不写文件、不追加审计；
 *   · 尊重 `exec.signal`：调用方中止时**立刻**返回（不把 2 分钟的等待挂满）；
 *   · 超时**不静默**：返回 `ok:false` + 当前状态 + 最近动作 + 建议。
 *
 * 条件语义（**或**关系 —— 命中任意一条就返回）：
 *   · `until_state`：任务 `state` ∈ 给定状态（单个字符串或字符串数组）；
 *   · `until_event`：`task.history` 里出现过该动作（单个或字符串数组）。
 *     ★ 动作名**自动归一化**：`transition:review_ok` / `review:ok` / `review_ok` 视为同一个，
 *       所以主对话可以直接写状态机上的事件名（`close` / `dev_submitted` / `review:ok`）。
 *
 * ★ 为什么"历史上出现过"就算命中（而不是"必须发生在本次等待期间"）：
 *   调用方的真实顺序是「派活 → 等」，而事件几乎总在 `pipeline_wait` **之前**就落了账；
 *   要求"等待开始之后发生"会让最常见的那条路必然超时。需要"只认新事件"的场景不在本工具里。
 *
 * ★ 本文件按 `CONVENTIONS.md` 的分工只做三件事：**参数表、校验、人话摘要**；
 *   读任务走 `store.peek` / 传入的 `load`，不碰状态机、不写盘。
 *
 * @module dsh-pipeline/lib/tools/wait
 */

import { ST, STATE_LABEL, TERMINAL_STATES, WAITING_STATES } from '../states.js'
import { S, SNullable, resolveActor, tool } from './kit.js'
import { toStringArray } from '../util.js'

/** 工具名（唯一出处）。 */
export const WAIT_TOOL_NAME = 'pipeline_wait'

/** 默认 / 允许的等待上限（毫秒）。上限拉到 2 分钟是为了**一次调用顶掉几十次 sleep**。 */
export const DEFAULT_TIMEOUT_MS = 60_000
export const MAX_TIMEOUT_MS = 120_000

/** 默认 / 允许的轮询间隔（毫秒）。下限 100 防止"空转烧 CPU"。 */
export const DEFAULT_INTERVAL_MS = 1_000
export const MIN_INTERVAL_MS = 100
export const MAX_INTERVAL_MS = 5_000

/** 全部合法状态 id（`until_state` 拼错时列出来 —— 免得白等满一个 timeout 才发现）。 */
export const KNOWN_STATE_IDS = Object.freeze(Object.values(ST))

/** 极小的等待原语（本工具唯一的"动作"就是等）。 */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * 可被打断的睡眠：**只在调用了带 `exec.signal` 的宿主里**才多挂一个 abort 监听。
 *
 * ★ 为什么必须有它：本工具一次可能挂到 2 分钟。若调用方中止（用户取消 / 外层超时），
 *   死等到 timeout 才返回会让"取消"白白多等两分钟。abort 一到就醒，循环会看到
 *   `signal.aborted` 并如实返回"被取消"。没有 signal（自测 / 别的宿主）⇒ 行为与
 *   普通 `sleep` 逐字节相同。
 *
 * @param {number} ms
 * @param {AbortSignal|null|undefined} signal
 * @returns {Promise<void>}
 */
function sleepInterruptible(ms, signal) {
  if (signal === null || signal === undefined || typeof signal.addEventListener !== 'function') return sleep(ms)
  if (signal.aborted === true) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/**
 * 状态 id → 「中文名（id）」。
 *
 * @param {unknown} state
 * @returns {string}
 */
function stateText(state) {
  const id = String(state ?? '')
  if (id.length === 0) return '（未知状态）'
  const zh = STATE_LABEL[id]
  return zh === undefined ? id : `${zh}（${id}）`
}

/**
 * 历史动作名归一化。
 *
 * ★ 为什么必须归一化：`task.history` 里状态迁移的动作是 `transition:<事件>`，
 *   而主对话脑子里的事件名是 `close` / `review_ok`；规格给的示例又是 `review:ok`。
 *   三份写法不该让调用方去猜 —— 这里统一成「小写 + 去掉 `transition` 前缀 + `:`→`_`」。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeEventName(value) {
  let s = String(value ?? '').trim().toLowerCase()
  if (s.length === 0) return ''
  s = s.replace(/^transition[:_]+/, '')
  return s.replace(/:/g, '_')
}

/**
 * 在 `task.history` 里找**最近一条**命中 `wanted` 的动作（`wanted` 已归一化）。
 *
 * @param {Array|unknown} history
 * @param {Set<string>} wanted
 * @returns {object|null} 命中的历史条目（原样返回，供摘要引用）
 */
export function matchHistoryEvent(history, wanted) {
  if (!Array.isArray(history) || wanted.size === 0) return null
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i]
    if (entry === null || typeof entry !== 'object') continue
    // 动作名与（部分条目带的）event 字段都认；归一到同一口径再比。
    for (const raw of [entry.action, entry.event]) {
      if (typeof raw !== 'string') continue
      if (wanted.has(normalizeEventName(raw))) return entry
    }
  }
  return null
}

/**
 * 最后一条带动作名（`action`）的历史条目 —— "最近事件"的出处。
 *
 * @param {Array|unknown} history
 * @returns {object|null}
 */
function lastHistoryEntry(history) {
  if (!Array.isArray(history)) return null
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i]
    if (entry !== null && typeof entry === 'object' && typeof entry.action === 'string' && entry.action.length > 0) return entry
  }
  return null
}

/**
 * 最近动作 → 一行人话（超时与命中都要给，不许只给个 null 了事）。
 *
 * @param {object|null} entry
 * @returns {string}
 */
function describeEntry(entry) {
  if (entry === null || entry === undefined) return '（历史为空）'
  const action = String(entry.action ?? '')
  const at = typeof entry.at === 'string' ? entry.at : ''
  const by = typeof entry.actor === 'string' && entry.actor.length > 0 ? entry.actor : ''
  if (at.length === 0) return action
  return `${action}（${at}${by.length > 0 ? `，by ${by}` : ''}）`
}

/**
 * 超时时的**下一步建议** —— 按当前状态给不同的话，而不是一句"再试试"。
 *
 * @param {string} state
 * @returns {string}
 */
function suggestionFor(state) {
  if (TERMINAL_STATES.includes(state)) {
    return `任务已是终态（${stateText(state)}）—— **不会再有状态变化**。要看结果用 pipeline_status；要接着做请开新单或用 reattach 认领。`
  }
  if (WAITING_STATES.includes(state)) {
    return `当前在等「${stateText(state)}」—— 等的是**人**（主对话转告 / 需求分析裁定 / 用户答复），不是席位在跑；先把那一步处理掉，再回来等。`
  }
  if (state === ST.BLOCKED) {
    return '任务已阻塞（blocked）—— 要推进先由主对话/人工 `unblock`；阻塞期间状态不会自己变。'
  }
  return '先用 pipeline_status { task_id } 看卡点与"下一步该谁"；如果相关席位还在跑，就**再调一次 pipeline_wait**（长轮询）。★ 不要用 sleep 轮询 —— 那正是本工具要消灭的成本。'
}

/**
 * 解析"有上下限的整数毫秒"参数。
 *
 * @param {unknown} raw - 原始入参
 * @param {{key:string, def:number, min:number, max:number, extra?:string}} spec
 * @returns {{ok:true, value:number} | {ok:false, summary:string}}
 */
function parseBoundedNumber(raw, spec) {
  const { key, def, min, max, extra = '' } = spec
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: def }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return {
      ok: false,
      summary: `参数被拒绝：${key}=${JSON.stringify(raw)} 不是整数毫秒值（默认 ${def}；允许 ${min}–${max}ms${extra}）。`,
    }
  }
  if (n < min || n > max) {
    return {
      ok: false,
      summary: `参数被拒绝：${key}=${n} 超出范围（默认 ${def}；允许 ${min}–${max}ms${extra}）。`,
    }
  }
  return { ok: true, value: n }
}

/**
 * 解析"字符串或字符串数组"条件。
 *
 * @param {unknown} raw
 * @param {string} key
 * @returns {{ok:true, list:string[]} | {ok:false, summary:string}}
 */
function parseConditionList(raw, key) {
  if (raw === undefined || raw === null) return { ok: true, list: [] }
  const list = toStringArray(raw)
  if (list.length === 0) {
    return {
      ok: false,
      summary: `参数被拒绝：${key} 必须是**字符串或字符串数组**（拿到的是 ${JSON.stringify(raw)}）。`,
    }
  }
  return { ok: true, list }
}

/**
 * 等待工具面（`pipeline_wait`）。
 *
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字
 * @param {object} ctx.deps
 * @param {object} ctx.store - 任务存储（只读使用：`peek` / `root`）
 * @param {(taskId:string)=>Promise<object|null>} ctx.load - 读任务（缓存没命中时才用一次）
 */
export function buildWaitTools(ctx) {
  const { deps, store, load } = ctx

  /** 统一的失败返回（字段必须齐全 —— 输出 schema 把每个字段都声明成必填）。 */
  const failure = (summary) => ({ ok: false, matched: false, state: '', waited_ms: 0, last_event: null, summary })

  const wait = tool(deps, {
    name: WAIT_TOOL_NAME,
    description:
      '【长轮询 · 只读】等到任务进入某个状态 / 某个事件落账再返回 —— 用它**替代**"pipeline_status + sleep"轮询（长单里主对话实测 sleep 40+ 次）。' +
      '条件为**或**关系：until_state（单个或数组，如 ["passed","blocked"]）与 until_event（单个或数组，如 close / review:ok / dev_submitted）。' +
      `超时（默认 ${DEFAULT_TIMEOUT_MS}ms，上限 ${MAX_TIMEOUT_MS}ms，轮询间隔默认 ${DEFAULT_INTERVAL_MS}ms）**不静默**：返回 ok:false + 当前状态 + 最近事件 + 建议。` +
      '★ 只读：不改任务状态、不写文件、不追加审计；条件已经满足时 waited_ms 只有个位数。',
    parameters: {
      task_id: S('string', '任务 ID（必填）', { required: true }),
      until_state: {
        description:
          '想等到的状态（**单个字符串或字符串数组**，命中任意一个就返回）。合法值见 `lib/states.js` 的 `ST`：' +
          'pending / analyzing / ready_plan / planning / ready_dev / developing / ready_test / testing / ready_review / reviewing / passed / closed / blocked / cancelled / awaiting_human …' +
          '与 until_event 是"或"关系。',
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      },
      until_event: {
        description:
          '想等到的事件 / 历史动作（**单个或字符串数组**，如 close / review:ok / dev_submitted）。' +
          '按 `task.history` 的动作名匹配，**自动兼容** `transition:` 前缀与 `:`/`_` 写法（`transition:review_ok` = `review:ok` = `review_ok`）。' +
          '与 until_state 是"或"关系。',
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      },
      timeout_ms: S('number', `最长等待毫秒（默认 ${DEFAULT_TIMEOUT_MS}；上限 ${MAX_TIMEOUT_MS} = 2 分钟；非法值直接拒绝）。`),
      interval_ms: S('number', `轮询间隔毫秒（默认 ${DEFAULT_INTERVAL_MS}，范围 ${MIN_INTERVAL_MS}–${MAX_INTERVAL_MS}；非法值直接拒绝）。`),
      role_token: S('string', '角色令牌（可选）：带了就校验；不带也允许 —— 只读查询不按角色细分，主对话与任意角色都能用。'),
    },
    output: {
      ok: S('boolean', '是否等到（超时 / 参数被拒 / 任务不存在 ⇒ false）'),
      matched: S('boolean', '是否由条件命中而返回（false = 没等到）'),
      state: S('string', '返回时刻的当前状态 id（任务不存在时为空串）'),
      waited_ms: S('number', '实际等待的毫秒数（条件已满足时是个位数）'),
      last_event: SNullable('string', '最近一条历史动作（命中事件时为命中的那条；无历史时为 null）'),
      summary: S('string', '可读结论（超时也一定说清：当前状态 + 最近事件 + 建议）'),
    },
    async run(args, exec) {
      // ---- ① 参数校验：错就立刻回，绝不让调用方白等一个 timeout ------------
      const taskId = typeof args?.task_id === 'string' ? args.task_id.trim() : ''
      if (taskId.length === 0) {
        return failure('参数被拒绝：缺少 task_id —— 本工具必须指定要等哪张任务单（不会替你在全部任务里猜）。')
      }
      const timeout = parseBoundedNumber(args?.timeout_ms, {
        key: 'timeout_ms',
        def: DEFAULT_TIMEOUT_MS,
        min: 1,
        max: MAX_TIMEOUT_MS,
        extra: `；上限 ${MAX_TIMEOUT_MS}ms = 2 分钟`,
      })
      if (timeout.ok !== true) return failure(timeout.summary)
      const interval = parseBoundedNumber(args?.interval_ms, {
        key: 'interval_ms',
        def: DEFAULT_INTERVAL_MS,
        min: MIN_INTERVAL_MS,
        max: MAX_INTERVAL_MS,
      })
      if (interval.ok !== true) return failure(interval.summary)

      const stateParsed = parseConditionList(args?.until_state, 'until_state')
      if (stateParsed.ok !== true) return failure(stateParsed.summary)
      const eventParsed = parseConditionList(args?.until_event, 'until_event')
      if (eventParsed.ok !== true) return failure(eventParsed.summary)
      const untilStates = stateParsed.list
      const untilEvents = eventParsed.list
      if (untilStates.length === 0 && untilEvents.length === 0) {
        return failure(
          '参数被拒绝：至少给 until_state / until_event 之一 —— 两个都不给就只会空等满 timeout（那正是本工具要消灭的 sleep 轮询）。',
        )
      }
      const unknownStates = untilStates.filter((s) => !KNOWN_STATE_IDS.includes(s))
      if (unknownStates.length > 0) {
        return failure(
          `参数被拒绝：until_state 里有不认识的状态：${unknownStates.join(' / ')}。\n` +
            `  · 可用状态（lib/states.js 的 ST）：${KNOWN_STATE_IDS.join(' / ')}`,
        )
      }

      // ★ 令牌：带了就按既有判据校验（无效令牌不许蒙混）；不带也放行 —— 只读查询不细分角色。
      const declaredToken = typeof args?.role_token === 'string' ? args.role_token.trim() : ''
      if (declaredToken.length > 0) {
        const actor = resolveActor({ ...args, task_id: taskId, role_token: declaredToken }, exec, deps)
        if (actor.ok !== true) return failure(`角色令牌无效：${actor.error}`)
      }

      // ---- ② 轮询 ----------------------------------------------------------
      const startedAt = Date.now()
      /** 条件的人话形态（命中与超时都要原样交代"等的是什么"）。 */
      const conditionText = [
        untilStates.length > 0 ? `until_state=${JSON.stringify(untilStates)}` : '',
        untilEvents.length > 0 ? `until_event=${JSON.stringify(untilEvents)}` : '',
      ]
        .filter((s) => s.length > 0)
        .join(' ｜ ')
      /** 事件的匹配集合（归一化一次，轮询里不重复算）。 */
      const wantedEvents = new Set(untilEvents.map((e) => normalizeEventName(e)).filter((e) => e.length > 0))

      for (;;) {
        // ★ 只读快照：优先 `peek`（同进程内所有写都经过 store 缓存 ⇒ 它足够新）；
        //   缓存没有才 `load` 一次（首次访问 / 别的入口还没读过这张单）。
        let task = store.peek(taskId)
        if (task === null || task === undefined) task = await load(taskId)
        if (task === null || task === undefined) {
          const waited = Date.now() - startedAt
          return {
            ok: false,
            matched: false,
            state: '',
            waited_ms: waited,
            last_event: null,
            summary:
              `找不到任务「${taskId}」，没有可等待的状态/事件（工作区：${store.root}）。\n` +
              '  · 请核对 task_id；本工具**不创建任务**、也不猜。',
          }
        }
        const state = String(task.state ?? '')
        const history = Array.isArray(task.history) ? task.history : []
        const stateHit = untilStates.includes(state)
        const eventEntry = wantedEvents.size > 0 ? matchHistoryEvent(history, wantedEvents) : null
        const waited = Date.now() - startedAt

        if (stateHit || eventEntry !== null) {
          const last = eventEntry !== null ? eventEntry : lastHistoryEntry(history)
          return {
            ok: true,
            matched: true,
            state,
            waited_ms: waited,
            last_event: typeof last?.action === 'string' ? last.action : null,
            summary: [
              `✅ 等到了（${waited}ms）：任务 ${taskId} ${stateHit ? `状态命中「${stateText(state)}」` : `事件命中「${String(eventEntry?.action ?? '')}」`}。`,
              `  · 当前状态：${stateText(state)}`,
              `  · 最近动作：${describeEntry(last)}`,
              `  · 条件：${conditionText}`,
              '  · ★ 本工具只读：没有改状态、没有写文件。',
            ].join('\n'),
          }
        }

        if (waited >= timeout.value) {
          const last = lastHistoryEntry(history)
          return {
            ok: false,
            matched: false,
            state,
            waited_ms: waited,
            last_event: typeof last?.action === 'string' ? last.action : null,
            summary: [
              `⏱ 等待超时（等了 ${waited}ms，上限 ${timeout.value}ms）：任务 ${taskId} 仍停在「${stateText(state)}」，没有等到指定条件。`,
              `  · 等待条件：${conditionText}`,
              `  · 最近动作：${describeEntry(last)}`,
              `  · 建议：${suggestionFor(state)}`,
              '  · ★ 本工具只读：没有改状态、没有写文件。需要继续等就再调一次 pipeline_wait（**别用 sleep 轮询**）。',
            ].join('\n'),
          }
        }

        // ★ 调用方中止（用户取消 / 外层超时）：**立刻**返回，不把 2 分钟的等待挂满。
        //   条件已经命中时上面那条已经返回了 —— 命中优先于取消（结论更有用）。
        if (exec?.signal?.aborted === true) {
          const last = lastHistoryEntry(history)
          return {
            ok: false,
            matched: false,
            state,
            waited_ms: waited,
            last_event: typeof last?.action === 'string' ? last.action : null,
            summary: [
              `⏹ 等待被调用方取消（${waited}ms）：任务 ${taskId} 仍停在「${stateText(state)}」。`,
              `  · 等待条件：${conditionText}`,
              `  · 最近动作：${describeEntry(last)}`,
              '  · 这是**取消**（`exec.signal` abort），不是超时 —— 外层中止了这次工具调用。',
              '  · ★ 本工具只读：没有改状态、没有写文件。',
            ].join('\n'),
          }
        }

        // 睡到"下一次轮询"或"到点"里更早的那个 —— 间隔大于剩余时间时不会白睡过头。
        await sleepInterruptible(Math.max(1, Math.min(interval.value, timeout.value - waited)), exec?.signal)
      }
    },
  })

  return { wait }
}
