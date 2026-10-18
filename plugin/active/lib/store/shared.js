/**
 * dsh-pipeline · 任务存储 · 模块级辅助
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/shared
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HUB_HANDOFF_CONFIRM_EVENTS, HUB_HANDOFF_CONFIRM_STATIONS, ST, TRANSITIONS } from '../states.js'
import { clip } from '../util.js'
import { SESSION_LOG_NAME, findSessionLog, sampleSessionLog, seatKey, sessionsRootCandidates } from '../liveness.js'

/** 用户答复可以走哪些渠道（留痕用；`chat` = 用户在主对话里直接说的）。 */
export const REPLY_CHANNELS = ['chat', 'typed', 'selected', 'relayed', 'other']

/**
 * ★★ **恢复型重入**：`to: '(previous)'` 的那些事件 —— 语义就是「回到被打断前的状态」。
 *
 * 为什么需要它（真单 T-20261011-5a871c）：`transition()` 里那条
 * 「进 developing ⇒ 清空席位提交表」原本是按**状态**判的（`res.to === developing`），
 * 把「恢复」也当成了「开新一轮」。而进 developing 的边有两类：
 *   · `dispatch_writer`（ready_dev / returned_to_dev ⇒ developing）= **新一轮开工**；
 *   · `unblock` / `human_reply` / `clarification_reply`（⇒ `(previous)` = developing）= **同一轮续做**。
 * 于是「block 一下再 unblock」会把**同一轮里已经交过的那几份**悄悄作废：席位白交、
 * 「全部到齐」永远凑不齐，交付也不再算「本轮交付」（`patrol.js:262` 的兜底支看的正是
 * "晚于进 developing 那一刻"）⇒ 任务停在「开发中」、交付躺在盘上、**一条播报都没有**。
 *
 * ⚠️ 名单**从 `TRANSITIONS` 派生**，不手抄第二份：状态表里加一条恢复边，这里自动跟上。
 * ⚠️ 这一支**不放宽任何闸门**：`dispatch_writer`（含打回重做那一次）照旧清空，
 *    「上一轮的提交记录不许冒充本轮已齐」那条反例一个字没动。
 */
export const RESUME_EVENTS = new Set(TRANSITIONS.filter((t) => t.to === '(previous)').map((t) => t.event))

/**
 * ★ 答复形状必须与 `decision_kind` 相符。
 *
 * 这条挡的是"主对话替用户拍板"里最隐蔽的一种：**答复的形式根本对不上**。
 * 例如请求问的是"选 A 还是 B"，主对话回一句 `answer: true` ——
 * 那不可能是用户说的，因为用户面前根本没有是非题。
 *
 * @param {object} entry - 请求记录
 * @param {object} input - 调用参数
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function checkAnswerShape(entry, input) {
  const dk = entry.decision_kind
  if (dk === 'yes_no' || dk === 'approve_reject') {
    if (typeof input.answer !== 'boolean') {
      return {
        ok: false,
        error:
          `decision_kind=${dk}：答复必须给布尔值 answer（true/false）。\n` +
          '问题是是非题，用户只能回答"是"或"否" —— 给别的形状说明这条答复不是从那个问题来的。',
      }
    }
    return { ok: true, value: { decision: input.answer, answer_bool: input.answer } }
  }
  if (dk === 'choose_option') {
    const chosen = typeof input.chosenOption === 'string' ? input.chosenOption.trim() : ''
    if (chosen.length === 0) {
      return { ok: false, error: 'decision_kind=choose_option：答复必须给 chosen_option。' }
    }
    const labels = entry.options.map((o) => o.label)
    if (!labels.includes(chosen)) {
      return {
        ok: false,
        error:
          `decision_kind=choose_option：chosen_option=「${chosen}」不在给用户的选项里。\n` +
          `可选：${labels.join(' / ') || '（这条请求没有给选项）'}\n` +
          '★ 选项之外的东西不可能是用户从这个选择题里选出来的。',
      }
    }
    return { ok: true, value: { decision: chosen, chosen_option: chosen } }
  }
  if (dk === 'free_text') {
    const text = typeof input.answerText === 'string' ? input.answerText.trim() : ''
    if (text.length === 0) {
      return { ok: false, error: 'decision_kind=free_text：答复必须给 answer_text。' }
    }
    return { ok: true, value: { decision: clip(text, 200), answer_text: text } }
  }
  return { ok: false, error: `未知的 decision_kind「${dk}」（插件内部错误）。` }
}

/**
 * ★ **授权面变更（amendment）** 允许出现的入参字段 —— 白名单，**fail-closed**。
 *
 * 为什么用白名单而不是"禁列几个敏感字段"：
 *   "只许动授权面"是一句否定式约束，否定式清单永远列不全（明天冒出一个
 *   `seat_order_hint` 就不在列里了）。所以反过来：**只有这几个键认得**，
 *   其余一律当场拒 —— 席位 / 角色清单 / 档位 / 调用顺序 / 层划分碰巧用哪个名字都进不来。
 *
 * ⚠️ 与 `lib/tools.js` 的 `pipeline_scope_amend.parameters` **必须同源**：
 *    声明了却不在白名单里 ⇒ 正规调用会被自己拒掉；白名单里有而没声明 ⇒ 形同虚设。
 *
 * ★ P1-18 残余（本单）：加了 `deferred_artifacts` —— 它与 `change_scope` / `forbidden`
 *   同属"计划声明面"（这次**要求什么 / 不许什么 / 哪些仪式性产物可以不交**），
 *   仍然是**只追加不覆盖**；席位 / 档位 / 角色清单那些键依旧一律拒。
 */
export const AMEND_ALLOWED_KEYS = ['task_id', 'role_token', 'why', 'note', 'add', 'remove', 'forbidden_add', 'forbidden_remove', 'deferred_artifacts']

/**
 * 从一次「授权面变更」调用的原始入参里，挑出**不属于授权面**的字段名。
 *
 * @param {unknown} raw - 调用方原样给的参数对象
 * @returns {string[]} 越界的字段名（空数组 = 只带了授权面字段）
 */
export function findNonScopeKeys(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.keys(raw).filter((k) => !AMEND_ALLOWED_KEYS.includes(k) && raw[k] !== undefined)
}

/** 原子写：先写 `.tmp` 再 rename（同目录 rename 在 NTFS 上是原子的）。 */
export async function writeJsonAtomic(file, value) {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

export async function appendJsonl(file, value) {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const line = `${JSON.stringify(value)}\n`
  // 追加写：node 的 append flag 在本地盘上是原子的（单次 write < PIPE_BUF 时）。
  const { appendFile } = await import('node:fs/promises')
  await appendFile(file, line, 'utf8')
}

export async function readJson(file) {
  const text = await readFile(file, 'utf8')
  return JSON.parse(text)
}

/**
 * 一份交接物提交之后，状态该怎么动。
 *
 * 「交接物」与「状态推进」合一是有意的：分开就会出现"交了东西但状态没动"
 * 或者"状态动了但没有交接物"的半截现场，而这两种半截现场没法机械判定。
 * 合一之后，一条断言就能覆盖两者。
 *
 * `leg` 非 null 表示这次推进消耗打回预算。
 *
 * @param {string} kind
 * @param {object} payload
 * @returns {{event:string, leg:'dev'|'test'|null} | null}
 */
export function planAdvance(kind, payload) {
  switch (kind) {
    case 'dev_to_test':
      return { event: 'dev_submitted', leg: null }
    case 'test_to_review':
      return { event: 'test_passed', leg: null }
    case 'review_verdict':
      if (payload?.conclusion === 'OK') return { event: 'review_ok', leg: null }
      // NG：按 reject_to 决定打到谁那儿；两边都消耗打回预算。
      return payload?.reject_to === 'tester' ? { event: 'review_ng_test', leg: 'test' } : { event: 'review_ng_dev', leg: 'dev' }
    case 'test_to_dev':
      return { event: 'test_failed', leg: 'dev' }
    // ★ 本轮新增：计划自检发现缺失 ⇒ **退回需求分析**（第一级澄清梯）。
    //   为什么挂在"交计划"这一刻而不是让 planner 另外发一条澄清请求：
    //   自检结果与回落问题本来就是**同一件事**（缺什么 → 问什么），
    //   分成两步只会在中间制造一个"交了计划但没回流"的半截现场。
    //   状态落到「等待需求分析答复」之后，裁定/升级走的全是既有的那条链。
    case 'plan':
      return payload?.self_check?.verdict === 'gaps' ? { event: 'plan_gap', leg: null } : null
    // ★ 两级升级梯第一级：**只有 blocking 的才推状态**（非阻塞的照样要问，但不打断流程）。
    case 'clarification_request':
      return payload?.blocking === true ? { event: 'clarification_request', leg: null } : null
    // 需求分析的裁定：不管 answered 还是 cannot_answer，都先**恢复状态**
    //（cannot_answer 之后由 orchestrator 再发 human_request 升级，那是另一条边）。
    case 'clarification_reply':
      return { event: 'clarification_reply', leg: null }
    // ★ 人工介入请求：**只有 blocking 的才推状态**。
    //   非阻塞请求（"顺便问一下"）照样进待办、照样要主对话转告，但不打断流程。
    case 'human_request':
      return payload?.blocking === true ? { event: 'human_request', leg: null } : null
    default:
      return null
  }
}

/**
 * ★★ **主管枢纽**下的交接物 → 状态推进（T-20261011-56a37e）。
 *
 * 为什么单独一份、而不是并进 `planAdvance`：`planAdvance` 是**纯函数**（只吃 kind + payload），
 * 而这两条边**只在枢纽任务上存在**。并进去会让所有既有任务的需求分析一交就跳到
 * 「主管受理中」—— 那是把既有链改掉，不是扩展。
 * 所以调用点写成"枢纽任务才问这一份"（见 submitHandoff 的 ⑤）：
 *   未启用枢纽 ⇒ `planAdvance` 原样，一个字节没变。
 *
 * @param {string} kind
 * @param {object} [payload]
 * @param {string|null} [state] - 提交时的状态（**只用于"只有首次出图推状态"这一条**，缺陷 ⑯；不传 = 按首次出图答）
 * @returns {{event:string, leg:null} | null}
 */
export function hubAdvanceFor(kind, payload = {}, state = null) {
  // 需求结论交主管（状态落到「主管受理中」，等第①道确认）。
  if (kind === 'requirement_analysis') return { event: 'need_to_supervisor', leg: null }
  /**
   * 架构图产出 ⇒ 落到「架构图待主管确认」（第②道）。
   *
   * ★★ 2026-10-16（真机 `T-20261016-fullai` 的 L5 关单死锁）：这条边是**前置站**那条
   *   （`arch_drawing → arch_confirm`）。枢纽的**交付站**（编写完成之后）也能交图了 ——
   *   那里它**不推动状态**：交付站重交是"更新当前是哪张图"，不是一步状态迁移。
   *   不做这一条会出现"交接物交得上、状态却推不动"的**半截现场**：
   *   `submitHandoff` 的 ⑤ 会先 `applyTransition` 预检，`diagram_submitted` 在
   *   `passed` 上没有边 ⇒ 整个提交以 `BAD_TRANSITION` 被拒（图根本落不了盘）。
   *
   * ★★ 2026-10-17 改口径（缺陷 ⑯）：判据从"排除交付站"改成「**只有首次出图推状态**」——
   *   状态表上 `diagram_submitted` 只有 `arch_drawing → arch_confirm` 一条边，前置站另外三个状态
   *   （`arch_confirm` / ②b `arch_need_confirm` / ②c `arch_reconfirm`）上重交原先照样去发它 ⇒
   *   `BAD_TRANSITION`，与 `review.js`"②b/②c 可以再交一次"的承诺不符（想改图只能靠主管限 1 次的重画）。
   *   现在：`arch_drawing` 上交 = 出图，推到 `arch_confirm`；其余状态上交 = 更新"当前是哪张图"，不推状态
   *   （交付站行为不变）。哪些状态**允许**交图仍由 `review.js` 的状态判据决定，这里只回答推不推。
   *   不传 `state`（推导工具从 kind 表实算可达事件，见 e-route-check）⇒ 照旧报 `diagram_submitted`。
   */
  if (kind === 'architecture_diagram') {
    return state === null || state === ST.ARCH_DRAWING ? { event: 'diagram_submitted', leg: null } : null
  }
  /**
   * ★★ P0-1：**需求位确认架构图 ⇒ 递交主管二次确认**（用户新口径第 8 跳前半）。
   *
   * 与上面两条**逐项同构**：`to_role` 由 schema 决定（需求位 → main），
   * 而"这份交接物一交，状态就跟着走"这件事由本函数回答 —— 需求位不需要
   * 第二个工具、也不会出现"记录交了但状态没动"的半截现场。
   *
   * ★ 触发面刻意收窄到三个条件同时成立：`kind=station_confirm` ·
   *   `station=arch_need_confirm` · `decision=ok`。缺任一条 ⇒ 返回 null（走原表）。
   *   于是 ③④ 两站的确认记录、以及任何 `decision='ng'` 的记录**都不会**推动状态。
   *   角色那一道由状态机的 `by: [orchestrator]` 负责（`applyTransition` 会拒非需求位）。
   */
  if (
    kind === 'station_confirm' &&
    String(payload?.station ?? '') === HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM &&
    payload?.decision === 'ok'
  ) {
    return { event: HUB_HANDOFF_CONFIRM_EVENTS[HUB_HANDOFF_CONFIRM_STATIONS.ARCH_NEED_CONFIRM], leg: null }
  }
  return null
}

// ---------------------------------------------------------------------------
// ★ 人工介入请求的「登记」—— 实现已集中到 `lib/model/human-request.js`
// ---------------------------------------------------------------------------
//
// `buildHumanRequestEntry` 是**人工介入请求这个领域对象的构造**（字段清单 + 默认值 +
// 生命周期起点），按「领域对象集中」搬进 `lib/model/`；本文件只做转出，调用方
// （`store/base.js` 的兜底自愈、`store/human.js` 的正规提交）**不需要改 import**。
// 那段设计说明（现场、根因、两条修补）随实现一起搬了过去。

export { buildHumanRequestEntry } from '../model/human-request.js'

/**
 * ★ **兜底**：把「有交接物、没登记」的人工介入请求补回登记表。
 *
 * 实现在**工厂内部**（`reconcileHumanRequests` / `enforceHumanRequestRegistration`
 * 两个 store 方法）—— 因为它们要落盘（`persist`）与留痕（`audit`），
 * 那是工厂闭包里的东西。这里只留设计说明：
 *
 * ① 先按交接物补全**缺**的登记（`question_for_human` 空的）；
 * ② 若某份 human_request 交接物**完全没有**登记，就按那份交接物重建一条 ——
 *    这是"已经卡住的单也能救回来"的那一步。
 *
 * 为什么第 ① 步是安全的：交接物是**不可变原文**，用它补齐缺字段不会引入新信息。
 * 为什么第 ② 步**不再**加「停在 awaiting_human」这个条件：那条限定只覆盖
 * blocking=true 的请求，**非阻塞请求（blocking=false）永远进不了等待态**，
 * 于是它们一旦漏登记就再也救不回来（真单里点名取不出的三条全是 blocking=false）。
 * 判据回到不可辩驳的那一条：**"有交接物、没登记"本身就是一次没写完的登记**。
 *
 * ⚠️ 绝不触碰 `answered` / `withdrawn` 的记录（见本节开头那条反例）——
 *    它们本来就有条目，落不进"完全没有登记"这一档。
 */

/**
 * ★ 本任务在册的编写席位列表。**单席位也走这里**（count=1 时就是 `['writer#1']`）。
 */
export function writerSeatsOf(task) {
  const w = task?.roster?.writers
  if (w === null || w === undefined || typeof w !== 'object') return ['writer#1']
  const parts = Array.isArray(w.partitions) ? w.partitions : []
  if (parts.length === 0) return ['writer#1']
  return parts.map((p) => p.seat)
}

/**
 * 由某个席位在 roster 里的分区定义。
 * @returns {object|null}
 */
export function seatPartitionOf(task, seat) {
  const w = task?.roster?.writers
  const parts = Array.isArray(w?.partitions) ? w.partitions : []
  return parts.find((p) => p.seat === seat) ?? null
}

/**
 * 会话 id 的形状（宿主真实会话 id 形如 `session-<uuid>`）。
 * 用它回答一个问题：**本任务的活动采样"本来做得到"吗** —— 做得到才启用"连续确认"门
 * （见 `lib/liveness.js` 的 `gateOn`），做不到就退回台账三条判据并如实留痕。
 */
const SESSION_ID_SHAPE = /^session-/

/**
 * ★★ B2：**现采一次会话日志**（每个已派席位一个样本）。
 *
 * 采不到就给 `null`（**不是给空对象**）—— "拿不到活动证据"与"它没动"是两件事，
 * 混起来就会把"查不到"误报成"死了"（这正是 B2 那次误冻的形状）。
 *
 * 会话目录由 `DSH_HOME/sessions` 推出（可用 `sessionsRoot` 覆盖，自测要固定它）；
 * 目录名是工作目录的编码，属宿主实现细节 ⇒ 用 {@link findSessionLog} 扫一层找，
 * 不拼字符串。
 *
 * @param {object|null} task
 * @param {number} atMs
 * @param {number} [maxMs] - 只用于给结果里的人话说明，不改变采样行为
 * @returns {{samples:object|null, note:string, root:string|null, found:number}}
 */
export function sampleSessionActivity(task, atMs, maxMs) {
  /**
   * ★★ **2026-10-13 快修（②，P0-1）：会话根目录改成"候选列表"，不再只认两个环境变量。**
   *
   * 根因（只读诊断报告 §3.3 排除法 + 本次实测复核）：插件进程里 `DSH_SESSIONS_DIR` /
   * `DSH_HOME` 取不到 ⇒ 旧代码在这里就 `root === null` 早退，并**硬编码**
   * `gate_applicable: false` ⇒ 采样从未成功过一次 ⇒ 「会话文件在增长」这条证据恒等于零。
   *
   * 两处改动：
   *   ① 根目录按 {@link sessionsRootCandidates} 逐个试（env → `DSH_HOME/sessions` →
   *      profile 上两级 → `~/.dsh/sessions`），**哪个真的命中日志就以哪个为准**；
   *   ② 「一个都没命中」**不等于**「看得见且没动」⇒ `gate_applicable` 一律按
   *      "台账里有没有真实形状的会话 id"（`samplable`）来定，**不再硬编码 false**。
   *      语义：看得见 ⇒ 由活动判据说话；看不见但有真实会话 ⇒ 走确认门（连续确认才冻）；
   *      结构上本来就没有会话 id（自测替身 / 手搓台账）⇒ 才允许一次观察即判。
   *      ⚠️ 这一支**不放松任何闸门**：静默阈值一毫秒没动，真死席位照旧在有限次观察内冻结。
   */
  const roots = sessionsRootCandidates()
  const root = roots.length > 0 ? roots[0] : null
  const list = Array.isArray(task?.dispatched) ? task.dispatched : []
  const samples = {}
  let found = 0
  let looked = 0
  /** ★ 至少一个已派席位带 `session-…` 形状的会话 id ⇒ 本任务的活动采样"本来做得到"。 */
  let samplable = false
  for (const raw of list) {
    const role = String(raw?.role ?? '')
    if (role.length === 0) continue
    const seat = typeof raw?.seat === 'string' && raw.seat.length > 0 ? raw.seat : null
    const sid = typeof raw?.session_id === 'string' && raw.session_id.length > 0
      ? raw.session_id
      : typeof raw?.agent_id === 'string' && raw.agent_id.length > 0
        ? raw.agent_id
        : null
    if (sid === null) continue
    if (SESSION_ID_SHAPE.test(sid)) samplable = true
    looked += 1
    const s = sampleSessionLog(findSessionLog(roots, sid), atMs)
    if (s !== null) {
      samples[seatKey(role, seat)] = s
      found += 1
    }
  }
  const gateApplicable = samplable || found > 0
  if (roots.length === 0) {
    return {
      samples: null,
      note: `一个候选会话根都取不到（DSH_SESSIONS_DIR / DSH_HOME / DSH_PROFILE_DIR / ~/.dsh 全都没有）—— 本次没有活动证据${gateApplicable ? '（但台账里有真实形状的会话 id ⇒ 启用"连续确认"门，不许一次安静就冻结）' : '（且台账里没有真实形状的会话 id ⇒ 不启用"连续确认"门）'}`,
      root: null,
      found: 0,
      gate_applicable: gateApplicable,
    }
  }
  if (looked === 0) return { samples: null, note: '台账里没有任何带会话 id 的派活记录 —— 本次没有活动证据（结构上采不到 ⇒ 不启用"连续确认"门）', root, found: 0, gate_applicable: false }
  if (found === 0) {
    return {
      samples: null,
      note: `在 ${root} 下没找到任何已派席位的会话日志 ${SESSION_LOG_NAME} —— 本次没有活动证据${gateApplicable ? '（但会话 id 是真实形状 ⇒ 启用"连续确认"门）' : '（且台账里没有真实形状的会话 id ⇒ 不启用"连续确认"门）'}`,
      root,
      found: 0,
      gate_applicable: gateApplicable,
    }
  }
  return {
    samples,
    note: `已采到 ${found}/${looked} 个席位的会话日志（窗口 ≤ ${maxMs === undefined ? '默认' : maxMs} ms）`,
    root,
    found,
    gate_applicable: gateApplicable,
  }
}

/**
 * ★「全部编写席位到齐」判据。
 *
 * 取舍（详见 README「编写分工」）：**全部席位到齐才推进**，而不是让某个"主编写席位"汇总成一份。
 * 理由见 README；这里只负责执法。
 *
 * @returns {{ok:true} | {ok:false, code:string, error:string}}
 */
export function checkAllSeatsSubmitted(task) {
  const seats = writerSeatsOf(task)
  if (seats.length <= 1) return { ok: true }
  const subs = task.writer_submissions ?? {}
  const missing = seats.filter((s) => subs[s] === undefined)
  if (missing.length === 0) return { ok: true }
  const done = seats.filter((s) => subs[s] !== undefined)
  return {
    ok: false,
    code: 'SEATS_INCOMPLETE',
    error:
      `编写席位未到齐：本任务在册 ${seats.length} 个席位，已交 ${done.length} 个（${done.join('、') || '无'}），` +
      `还差 ${missing.length} 个（${missing.join('、')}）。\n` +
      '规矩：**全部席位各交一份 dev_to_test 之后**才能推进到「待测试」。\n' +
      '为什么不是"由主编写席位汇总成一份"：汇总会引入一个隐藏的等级（谁是主？谁定的？），' +
      '而且汇总那一步本身不可审计 —— 测试与审核直接看 N 份分区报告反而更清楚谁改了什么。\n' +
      '如果某个席位确实交不了（例如它那块被取消），走 pipeline_roster_request 让编排复核后改分区，' +
      '而不是在这里硬推。',
  }
}

/** ★ 需求档的**约定路径**（由目录约定推导，不写进任务卡）。 */
export function requirementPaths(pipelineDir, taskId) {
const dir = join(pipelineDir, String(taskId))
return {
  dir,
  md: join(dir, "requirement.md"),
  json: join(dir, "requirement.json"),
  index: join(dir, "requirement.index.json"),
  /** 相对项目根的展示用路径（POSIX）。 */
  rel: `.pipeline/${String(taskId)}/requirement.md`,
}
}

/** 两版之间的**差异摘要**（写进版本索引，供"可追溯"用）。 */
export function diffSummary(prev, next) {
const bits = []
bits.push(`由 ${prev.version} → ${next.version}`)
if (prev.sha256 !== next.sha256) bits.push("正文有改动")
else bits.push("正文未变（仅元数据）")
if (typeof next.note === "string" && next.note.length > 0) bits.push(`说明：${next.note}`)
return bits.join("；")
}
