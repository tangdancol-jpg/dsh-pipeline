// 官方新工具分类 · **名单唯一出处**（团队协作 / 委派 / 插件管理 / 会话搜索 / 持久终端）
/**
 * dsh-pipeline · 守门 · **官方新工具的分类名单**
 * ============================================================================
 * 为什么需要这一份（`design/agent-teams/01-目标与边界.md` §D8）：
 *
 * 官方「智能体团队」插件给**每个会话**都注册了 `spawn_teammate` / `send_message` /
 * `team_task_*` / `wait_agent` / `interrupt_agent` / `list_agents`；再加上宿主一直有的
 * 委派类（`subagent` / `workflow` / `ralph`）、插件管理类（`plugin_manager`）、
 * 会话搜索类（`session_search` / `session_*`）、持久终端类（`terminal_*`）。
 *
 * 而 pipeline 在 Team 通道下派出去的**角色会话继承 Lead 的预设**（官方事实 F2：
 * `spawnTeammate` 走 `composeFrom(parent)`），工具面比原来的 `pl-*` 角色预设宽得多。
 * 于是出现三条**真实的绕过路径**（不是假想）：
 *
 *   ① 委派：测试/审核调 `subagent` / `workflow` / `ralph` 派个子代理去改代码 ——
 *      "测试/审核不得改代码"当场作废（改代码的不是它自己，是它的替身）。
 *   ② 绕交接：角色调 `send_message` / `team_task_*` 私下拉人、自己开任务板条目 ——
 *      绕开"结构化交接物 + 状态机 + 打回链"这套唯一交付入口。
 *   ③ shell 旁路：持久终端 `terminal_send` 的**命令在 `text` 参数里** ——
 *      不让它的命令串进 `collectCommandStrings`，等于给测试/审核留了一条改代码的后门。
 *
 * 所以本文件做两件事，且**只做这两件**：
 *   · 把"哪些工具名属于哪一类"写死成名单（唯一出处，别处只 import，不手抄）；
 *   · 给出"某个角色该被遮掉哪些"的纯函数（`officialDenyForRole`）与工具面合并
 *     （`applyOfficialDeny`），让守门（`decide.js`）与工具面（`deriveToolFace`）
 *     用的是**同一份**判断 —— 两处各写一份名单必然漂移，漂移的坏方向是放宽。
 *
 * ★ 口径：**main 不拒**。主对话就是 Lead —— team 协作类工具对它是本职（派活、投消息、
 *   任务板镜像都靠它）；对其它已绑定角色，四类全拒。
 * ★ 这一层**只拒不放**：它不改变任何既有判据，只多一条"这几个工具对角色会话一律拒绝"。
 *
 * @module dsh-pipeline/lib/guard/official-tools
 */

/** ① 团队协作原语（官方 Agent Teams 的工具面）。 */
export const DEFAULT_TEAM_COORD_TOOLS = [
  'spawn_teammate',
  'send_message',
  'wait_agent',
  'list_agents',
  'interrupt_agent',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
]

/** ② 委派类（派子代理 / 跑工作流 / 起 Ralph 循环）—— 角色会话用它们等于"借手改代码"。 */
export const DEFAULT_DELEGATION_TOOLS = [
  'subagent',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
  'workflow',
  'ralph',
]

/** ③ 插件管理 / 市场（能启停插件、改 profile）—— 直接改运行环境，不是角色的能力。 */
export const DEFAULT_ESCAPE_TOOLS = ['plugin_manager', 'plugin_market']

/** ④ 会话搜索（能读别的会话 / 别的事件正文）—— 绕开"结构化交接 + 脱敏摘要"的旁路读。 */
export const DEFAULT_SESSION_READ_TOOLS = [
  'session_search',
  'session_event_search',
  'session_event_read',
  'session_event_trace',
  'session_trace',
]

/**
 * ⑤ **shell 命令在 `text` 参数里**的工具（持久终端）。
 *
 * ★ 这一类**不拒**（终端本身是给席位干活的），只要求它的 `text` 进命令串扫描 ——
 *   见 `tool-names.js` 的 `collectCommandStrings({toolName})`。
 * ★ 只补扫 `text`，**不把任意正文当命令**：`write` 的正文里出现 `>` 是 Markdown，
 *   不是重定向；把那种内容当命令扫会误伤（审核写报告会被拦），那是我们踩过的坑。
 */
export const SHELL_TEXT_ARG_TOOLS = ['terminal_send', 'terminal_write', 'terminal_input']

/** 四类**角色会话一律拒绝**的名单（顺序固定：team → delegation → escape → session）。 */
const DENIED_CATEGORIES = [
  ['team_coord', DEFAULT_TEAM_COORD_TOOLS],
  ['delegation', DEFAULT_DELEGATION_TOOLS],
  ['escape', DEFAULT_ESCAPE_TOOLS],
  ['session_read', DEFAULT_SESSION_READ_TOOLS],
]

/** 小写归一（宿主工具名是小写；这里容错，避免大小写差异绕过）。 */
function norm(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}

/** 全部四类去重后的稳定排序名单（`officialDenyForRole` 的返回值就取它）。 */
const ALL_DENIED = (() => {
  const seen = new Set()
  for (const [, list] of DENIED_CATEGORIES) for (const name of list) seen.add(norm(name))
  return Object.freeze([...seen].filter((s) => s.length > 0).sort())
})()

/** 工具名 → 类别（认不出 = null）。 */
const CATEGORY_OF = (() => {
  const map = new Map()
  for (const [category, list] of DENIED_CATEGORIES) for (const name of list) map.set(norm(name), category)
  return map
})()

/** 每个角色的拒绝面缓存（守门是热路径，不许每次重算排序）。 */
const DENY_CACHE = new Map()

/**
 * 某角色该被**遮掉并拒绝**的官方工具名（排序稳定、已去重）。
 *
 * @param {string} role - 已绑定角色 id（`main` / `tester` / `reviewer` / …）
 * @returns {string[]} `main` ⇒ `[]`（它就是 Lead，team 协作类是它的本职）；其余已绑定角色 ⇒ 四类全集
 */
export function officialDenyForRole(role) {
  const key = norm(role)
  const hit = DENY_CACHE.get(key)
  if (hit !== undefined) return hit
  // ★ 只认 main 是 Lead。没绑定角色的调用方根本走不到这里（守门只约束流水线参与者）。
  const out = key === 'main' || key.length === 0 ? [] : [...ALL_DENIED]
  DENY_CACHE.set(key, out)
  return out
}

/**
 * 这个工具名属于哪一类官方新工具（认不出 = `null`）。
 *
 * 给拒绝文案用：不同类别**绕的是什么**不一样，说清楚才拦得住下一次。
 *
 * @param {string} toolName
 * @returns {'team_coord'|'delegation'|'escape'|'session_read'|null}
 */
export function officialCategoryOf(toolName) {
  return CATEGORY_OF.get(norm(toolName)) ?? null
}

/**
 * 该角色调用这个工具，是否命中"官方新工具越权面"。
 *
 * @param {string} role
 * @param {string} toolName
 * @returns {'team_coord'|'delegation'|'escape'|'session_read'|null} 命中类别；`null` = 不拦
 */
export function officialOutsideRole(role, toolName) {
  const category = officialCategoryOf(toolName)
  if (category === null) return null
  return officialDenyForRole(role).includes(norm(toolName)) ? category : null
}

/** 这个工具名是不是"命令在 `text` 里"的持久终端类（见 {@link SHELL_TEXT_ARG_TOOLS}）。 */
export function isShellTextArgTool(toolName) {
  const name = norm(toolName)
  if (name.length === 0) return false
  return SHELL_TEXT_ARG_TOOLS.some((t) => norm(t) === name)
}

/**
 * 「官方新工具」越权的**拒绝原文**（§D8 第 2 条）。
 *
 * ★ 为什么拒绝文案要**分类说原因**（而不是一句"不允许"）：这四类绕的**不是同一件事** ——
 *   委派绕的是"测试/审核不得改代码"（借子代理的手改），team 协作绕的是"结构化交接
 *   是唯一交付入口"（私下拉人 / 自己开任务板），插件管理绕的是"运行环境不是角色能力"，
 *   会话搜索绕的是"脱敏摘要 + 结构化交接"（偷看别的会话正文）。
 *   只写"不允许"的话，下一次它还会换个同类工具再试。
 *
 * ★ 文案与名单**同源**：名单里加一个工具，这里的分支自然覆盖它 —— 不会出现
 *   "名单拦住了、文案还写着别的理由"的漂移。
 *
 * @param {string} toolName - 工具名
 * @param {string} role - 当前角色 id
 * @param {'team_coord'|'delegation'|'escape'|'session_read'} category - 类别
 * @param {{roleLabel?:string, tag?:string}} [opts] - `roleLabel` 角色中文名 / `tag` 前缀（都由调用方给：
 *   本文件**不 import `rules.js`** —— `rules.js → tool-names.js → 本文件` 已经是一条边，
 *   反向再 import 就成环了；文案要用的 `TAG` 与 `roleZh()` 由 `decide.js` 传进来）
 * @returns {string} 拒绝理由
 */
export function officialRefusalText(toolName, role, category, opts = {}) {
  const roleLabel = typeof opts.roleLabel === 'string' ? opts.roleLabel : ''
  const tag = typeof opts.tag === 'string' && opts.tag.length > 0 ? opts.tag : '[pipeline]'
  const why =
    category === 'delegation'
      ? '这是**委派类**工具（派子代理 / 跑工作流 / 起循环）。测试与审核一旦能派人，' +
        '"测试/审核不得改代码"当场作废 —— 改代码的不是它自己，是它派出去的替身。'
      : category === 'team_coord'
        ? '这是**团队协作类**原语（派队友 / 投消息 / 等变化 / 任务板）。角色之间只能走' +
          '「结构化交接物 + 状态机」，不许私下串供、也不许自己拉人开任务板条目 —— ' +
          '否则"唯一交付入口"就只是文案。'
        : category === 'escape'
          ? '这是**插件管理 / 市场**类工具（启停插件、装 bundle、改 profile）。' +
            '那是直接改运行环境 —— "完全档"的三段闸门要挡的正是这种事，角色不该有这个能力。'
          : '这是**会话搜索类**工具（能读别的会话 / 别的历史事件正文）。它的用途是绕开' +
            '「结构化交接 + 脱敏摘要」去偷看主对话或其它席位的正文 —— 那就是旁路读代码。'
  return (
    `${tag} 拒绝：官方工具「${toolName}」在你这个角色上等于**绕过三权分立 / 触发旁路**。\n` +
    `工具：${toolName}\n当前角色：${role}${roleLabel.length > 0 ? `（${roleLabel}）` : ''}\n` +
    `为什么拦：${why}\n` +
    '★ 背景（官方事实，不是本插件的约定）：团队通道下派出的角色会话**继承主对话（Lead）的预设**，' +
    '工具面比原来的角色预设宽得多。放行这几类，上面那些既有判据就都能被绕开。\n' +
    '★ 你该用的通道：流水线动作一律走 pipeline_* 工具（交接物 / 打回 / 澄清 / 记录都有具名入口）；' +
    '要人拍板 → pipeline_clarify_request（先问需求分析）或 pipeline_human_request（升给用户）。\n' +
    '★ 这条对主对话（main）不生效：它就是 Lead，团队协作类工具是它的本职。'
  )
}

/**
 * 把官方新工具并进"按角色的工具面"（`deriveToolFace()` 的返回值）。
 *
 * ★ 为什么在这里而不是在 `boundaries.js`：`boundaries.js` 只认**流水线自己**的工具
 *   （`toolNames` 是注册的 `pipeline_*` 名单，白名单从守门判词里读）。官方这些工具
 *   的"允许角色"不是守门白名单给的，而是**本文件的名单** —— 两者合并只允许发生在
 *   一处，否则两个面一定会漂移。
 * ★ 只并入 `denied`（**实际收紧**那一栏，`index.js` 的 `ctx.tools.restrict({deny})`
 *   读的就是它），不动 `visible` / `hidden`（那两栏说的是流水线工具）。
 * ★ main 的 `denied` 保持空数组：主对话看不到的应该是"不该知道的"，不是它的本职工具。
 *
 * @param {object|null} face - `deriveToolFace()` 的返回值（纯数据）
 * @returns {object|null} 同一个对象（就地合并；`null` 原样返回）
 */
export function applyOfficialDeny(face) {
  if (face === null || typeof face !== 'object') return face
  const byRole = face.by_role
  if (byRole === null || typeof byRole !== 'object') return face
  const extra = {}
  for (const role of Object.keys(byRole)) {
    const bucket = byRole[role]
    if (bucket === null || typeof bucket !== 'object') continue
    const add = officialDenyForRole(role).filter((t) => !Array.isArray(bucket.denied) || !bucket.denied.includes(t))
    if (add.length === 0) continue
    const before = Array.isArray(bucket.denied) ? bucket.denied : []
    bucket.denied = [...before, ...add]
    extra[role] = add
    // 诚实边界：`hidden` / `hidden_count` 说的是**流水线工具**（从守门判词推导）；
    // 官方工具不是守门白名单管的，故只进 `denied`，并在 `official_denied` 里单列一笔。
    bucket.official_denied = add
  }
  face.official_denied = extra
  return face
}
