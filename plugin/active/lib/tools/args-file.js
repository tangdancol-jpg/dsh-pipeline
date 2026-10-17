/**
 * dsh-pipeline · 工具层 · **长入参走文件**（`spec_path` / `payload_path`）
 * ============================================================================
 * -----------------------------------------------------------------------------
 * 修的是哪条缺陷（用户截图为证）
 * -----------------------------------------------------------------------------
 * 现场：席位调 `pipeline_plan`，入参**全是长中文段落**（`reason` / `plan_steps` /
 * `role_scope` / `role_boundaries` / `change_scope`）⇒ 模型侧把工具参数写成了
 * 坏 JSON ⇒ 宿主报 `tool input is invalid JSON` ⇒ `MALFORMED_RESPONSE` ⇒
 * **整轮作废（含此前全部上下文）**。
 *
 * 根因：`pipeline_plan` / `pipeline_orchestrate` / `pipeline_handoff` **没有
 * "从文件读入参"的通道** ⇒ 只能内联 ⇒ 长中文必然周期性写坏。
 * 参数越长、中文越多，写坏的概率越高 —— 这不是模型不听话，是**通道选错了**。
 *
 * -----------------------------------------------------------------------------
 * 成熟做法（本项目内就有参照点）
 * -----------------------------------------------------------------------------
 * `diagram_deliver` 的 **`spec_path`**：大规格先写文件、传路径、工具内部读 ⇒
 * 大段内容**根本不经过工具参数**。本模块把同一条通道给到流水线工具。
 *
 * 语义（三条，与 `diagram_deliver` 一致）：
 *   ① 从文件读**整份入参** → ② 与**内联**字段合并 → ③ **同名内联优先**。
 *   ⇒ 于是"只传 `task_id` + `spec_path`"和"把所有字段内联"是**同一件事**，
 *     产物逐字节相同（自测 `p16-args-file-check.mjs` 的 ⑥ 专门盯这条）。
 *
 * -----------------------------------------------------------------------------
 * ★★ 安全：这条通道**不许成为"不读代码"的后门**
 * -----------------------------------------------------------------------------
 * 读参数文件这件事本身受**与 `read` 工具同一套**的守门判据约束 ——
 * 那是 `guard/rules.js` 的 {@link codeReadRefusal}，**同一个函数**，不是抄一份：
 * 控制角色（主对话 / 需求分析 / 计划 / 主管）只许读 `.pipeline/**`，
 * 与它们用 `read` 时一模一样。
 *
 * 另外加一条**对任何角色都生效**的：参数文件不许落在**实现源码树**里
 * （`plugin/**` `lib/**` `src/**` `node_modules/**`）——
 * 参数文件是**数据**，不是代码。详见 {@link ARGS_FILE_DENY_TOP}。
 *
 * 判据顺序刻意这样排（**先判路径、后读盘**）：所有拒绝理由都在**打开文件之前**
 * 就能给出，所以既没有"读了再拒"的泄露面，也不会为了拒绝去读一个大文件。
 *
 * @module dsh-pipeline/lib/tools/args-file
 */

import { readFileSync, statSync } from 'node:fs'

import { codeReadRefusal } from '../guard/rules.js'
import { isInside, pathKey, resolveAgainstAnchor } from '../util.js'
// ★ 「被拒路径：…」那一行的**唯一出处**（`lib/errors/text.js`）：本文件只换成引用，字面值未动。
import { rejectedPath } from '../errors/text.js'

/**
 * 参数文件**大小上限**（256 KiB）。
 *
 * 为什么必须有上限：`spec_path` 指向什么是调用方说了算 —— 没有上限的话，
 * 一个手滑的路径就能让工具去读一个几百 MB 的文件。"给上限"也是错误形状的要求：
 * 超限要**明确报出来**，不能读到内存里再炸。
 *
 * 256 KiB 对"长中文段落"绰绰有余：一份典型的两层计划规格约 3–8 KB。
 */
export const ARGS_FILE_MAX_BYTES = 256 * 1024

/**
 * ★ 参数文件**永远**不许落在这几个顶层目录下（**对任何角色**生效，不只是控制角色）。
 *
 * 为什么对任何角色都要拦：`spec_path` / `payload_path` 是**数据通道**。
 * 一份实现源码既不可能是一份合法的入参对象，也没有任何理由被当成入参来源 ——
 * 放行它只会让"参数文件"变成**绕过"不读代码"的通道**（控制角色只要把
 * `spec_path` 指向 `lib/guard/decide.js`，工具就会去读它）。
 *
 * ⚠️ 这一条是**兜底**，不是替代：控制角色还有上面那条更严的
 * `NO_CODE_READ_ROLES`（只许 `.pipeline/**`），它先判。
 *
 * 合法落点：`.pipeline/**`（首选）、任务目录、工作区里新建的规格文件（如
 * `plan-spec.json`）。写在这几个目录之外的顶层目录下会被拒 ——
 * 换到 `.pipeline/<任务id>/` 下面就对了。
 */
export const ARGS_FILE_DENY_TOP = Object.freeze(['plugin', 'lib', 'src', 'node_modules'])

/** 只支持 JSON。写出来是为了让拒绝文案与文档同源。 */
export const ARGS_FILE_FORMATS = 'JSON（YAML 暂不支持：本插件不带 YAML 解析器）'

/**
 * ★★ **字段说明的唯一出处** —— 三个工具的 schema 都从这里取，不各抄一份。
 *
 * 为什么说明必须写进 schema（而不是只写在 CONVENTIONS.md 里）：
 * 这段文字是**模型唯一一定会看到**的地方（工具定义随每次调用一起给）。
 * 缺陷现场就是"模型不知道还有文件通道" ⇒ 只能内联 ⇒ 长中文写坏 JSON。
 */
export const ARGS_FILE_DOC = {
  spec_path:
    '★★ **长入参走这里，不要内联长中文段落** —— 传一个 **JSON 文件**的路径，工具内部读它当整份入参。' +
    '修的是 `MALFORMED_RESPONSE`：长中文（`reason` / `plan_steps` / `role_scope` / `role_boundaries` / `change_scope`…）' +
    '内联进工具参数时**必然周期性写坏 JSON**，而宿主一旦判 `tool input is invalid JSON` 就**整轮作废（含此前全部上下文）**。' +
    '写进文件则大段内容**根本不经过工具参数**。' +
    '语义：**从文件读整份入参 → 与内联字段合并 → 同名内联优先** ⇒ 只给 `task_id` + 本字段，效果与全部内联**逐字节相同**。' +
    '`task_id` 必须内联（判据要先知道任务才判得了路径）。只支持 JSON。' +
    '安全：本字段读文件走**与 `read` 工具同一套**守门判据（控制角色只许 `.pipeline/**`），' +
    '且**任何角色**都不许把参数文件放进实现源码树（`plugin/**` `lib/**` `src/**`）—— 参数文件是数据，不是代码。' +
    '示例：`.pipeline/<任务id>/plan-spec.json`。',
  payload_path:
    '★★ **长入参走这里，不要内联长中文段落** —— 传一个 **JSON 文件**的路径，工具内部读它当交接物内容（`kind` 仍内联）。' +
    '修的是 `MALFORMED_RESPONSE`：长中文正文（测试用例 / 失败日志 / 风险说明 / 验收证据…）' +
    '内联进工具参数时**必然周期性写坏 JSON**，宿主一判 `tool input is invalid JSON` 就**整轮作废（含此前全部上下文）**。' +
    '两种写法**都对**（规则确定，不猜）：① 文件直接写 payload 的字段，如 `{"patch":"…","commands":[…],"self_test":"…"}`；' +
    '② 文件写整份入参，如 `{"payload":{…}}`。合并语义：**同名内联优先**。' +
    '`task_id` 与 `kind` 必须内联（判据要先知道任务才判得了路径）。只支持 JSON。' +
    '安全：本字段读文件走**与 `read` 工具同一套**守门判据（控制角色只许 `.pipeline/**`），' +
    '且**任何角色**都不许把参数文件放进实现源码树（`plugin/**` `lib/**` `src/**`）—— 参数文件是数据，不是代码。' +
    '示例：`.pipeline/<任务id>/handoff-payload.json`。',
}

const isYamlName = (p) => /\.(ya?ml)$/i.test(String(p ?? ''))

/**
 * 把拒绝理由拼成工具返回的 `summary`。
 *
 * 统一带上**字段名 / 判据 / 被拒路径**三样 —— 用户的要求是"越界必须给明确文案
 * （点明判据 + 被拒路径）"，所以这三样不许省。
 */
function refuse(field, headline, detail, lines = []) {
  return (
    `[pipeline] 拒绝：${headline}\n` +
    `字段：${field}\n${detail}\n` +
    (lines.length > 0 ? `${lines.join('\n')}\n` : '') +
    '★ 这一条不是"文件读不到"那么简单：`' + field + '` 是一条**读文件的通道**，' +
    '它和 `read` 工具受**同一套**守门判据约束（见 lib/guard/rules.js 的 codeReadRefusal）——' +
    '否则"把参数写进文件"就成了绕过"不读代码"的后门。'
  )
}

/** 取首个非空白字符，用来判"这份文件像 JSON 还是像 YAML"。 */
const firstChar = (text) => {
  const m = /\S/.exec(text)
  return m === null ? '' : m[0]
}

/**
 * ★★ **长入参通道的唯一入口**。
 *
 * @param {object} o
 * @param {string} o.field - 参数字段名（`spec_path` / `payload_path`）
 * @param {object} o.args - 内联入参（**原样**，本函数不改它）
 * @param {object} o.deps - 工具层依赖（要 `deps.store` / `deps.config`）
 * @param {string|null} o.role - 调用方角色（判不出传 `null` ⇒ 按**最严**处理）
 * @param {string[]} o.allowedKeys - 该工具**声明过**的参数字段名（用来挡拼错的键）
 * @param {string} [o.wrap] - 可选：**把整份文件包进这个键**（`pipeline_handoff` 用 `'payload'`）。
 *   规则（确定性，无歧义）：文件里**已经有**这个键 ⇒ 按"整份入参"处理（正常合并）；
 *   没有 ⇒ 把整个文件对象当作这个键的值。于是两种写法都对：
 *   `{"kind":"x","payload":{…}}` 与 `{…payload 的字段…}`。
 *   ⚠️ 它由**工具自己声明**（`argsFile: { field, wrap }`，见 `kit.js`），不是这里猜的。
 * @returns {Promise<{ok:true, args:object, from:string|null} | {ok:false, summary:string}>}
 *          `from === null` ⇒ **没走文件通道**，`args` 就是原样的内联入参
 *          （⇒ 向后兼容：不传这个字段时行为**一个字节都不变**）。
 */
export async function resolveArgsFile({ field, args, exec, deps, role, allowedKeys, wrap }) {
  void exec
  const raw = args === null || typeof args !== 'object' ? undefined : args[field]
  // ---------------------------------------------------------------- 向后兼容 --
  // ★ 没给文件通道 ⇒ 原样返回。**这是既有行为的保证**：不传 `spec_path` 的调用
  //   连一次 stat 都不会发生。
  if (typeof raw !== 'string' || raw.trim().length === 0) return { ok: true, args, from: null }

  const given = raw.trim()

  // ---------------------------------------------------- ① 先要有任务才能判路径 --
  // 判据要同时知道"项目根"与".pipeline/"才能判，而这两样都在任务上。
  // `task_id` 因此**必须内联给**（它很短，没有写坏 JSON 的风险）——
  // 这也是"先判路径、后读盘"的前提：判不出任务就**不打开文件**（fail-closed）。
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
  if (taskId.length === 0) {
    return {
      ok: false,
      summary: refuse(
        field,
        `走文件通道时必须**内联**给 \`task_id\`（判据要先知道任务才判得了路径）。`,
        rejectedPath(given),
        [`实际内联的 task_id：${'（空）'}`],
      ),
    }
  }
  const task = deps?.store === undefined ? null : await deps.store.get(taskId)
  if (task === null || task === undefined) {
    return {
      ok: false,
      summary: refuse(field, `找不到任务 ${taskId}，判不出项目根 ⇒ 按 fail-closed 拒绝。`, rejectedPath(given)),
    }
  }

  const projectRoot = pathKey(String(task.project_root ?? ''))
  const artifactDir = String(deps?.config?.artifactDirName ?? '.pipeline')
  const pipelineDir = pathKey(`${projectRoot}/${artifactDir}`)
  if (projectRoot.length === 0) {
    return {
      ok: false,
      summary: refuse(field, `任务 ${taskId} 没有 project_root，判不出项目根 ⇒ 按 fail-closed 拒绝。`, rejectedPath(given)),
    }
  }

  // ------------------------------------------------------ ② 解析成绝对路径 --
  const abs = resolveAgainstAnchor(projectRoot, given)
  if (abs.length === 0) {
    return { ok: false, summary: refuse(field, '这不是一条路径。', rejectedPath(given)) }
  }

  // ------------------------------------------------------ ③ 必须在项目根之内 --
  if (!isInside(projectRoot, abs) && !isInside(pipelineDir, abs)) {
    return {
      ok: false,
      summary: refuse(
        field,
        '参数文件必须落在**本任务的项目根之内**。',
        rejectedPath(abs),
        [
          `判据：项目根 = ${projectRoot}`,
          '允许的落点：`.pipeline/**`（首选）、任务目录、工作区里新建的规格文件。',
          '★ 落到项目根之外 ⇒ 那已经不是"这次任务的入参"，而是别处的文件。',
        ],
      ),
    }
  }

  // ------------------------------------- ④ ★ 与 `read` **同一套**守门判据 --
  // 控制角色（主对话 / 需求分析 / 计划 / 主管）只许读 .pipeline/**。
  // ★ 判不出角色（role === null）时按**控制角色**处理 —— 严的那一档。
  const effRole = typeof role === 'string' && role.length > 0 ? role : 'planner'
  const readWhy = codeReadRefusal(effRole, { pipelineDir }, abs)
  if (readWhy !== undefined) {
    return {
      ok: false,
      summary: refuse(
        field,
        '这个角色不得读取该路径的正文 —— 与 `read` 工具**同一条判据**。',
        rejectedPath(abs),
        [
          `当前角色：${effRole}${typeof role === 'string' && role.length > 0 ? '' : '（判不出角色 ⇒ 按最严的一档处理）'}`,
          `判据：${readWhy}`,
          '要把规格写进文件：写 `.pipeline/<任务id>/` 下面（那里允许读）。',
        ],
      ),
    }
  }

  // ------------------------------- ⑤ ★★ 参数文件不许是实现源码（任何角色） --
  const rel = pathKey(abs.slice(pathKey(projectRoot).length)).replace(/^\/+/, '')
  const top = rel.split('/')[0] ?? ''
  if (ARGS_FILE_DENY_TOP.includes(top)) {
    return {
      ok: false,
      summary: refuse(
        field,
        '参数文件不许落在**实现源码树**里 —— 这条对**任何角色**都生效。',
        rejectedPath(abs),
        [
          `判据：ARGS_FILE_DENY_TOP = ${ARGS_FILE_DENY_TOP.join(' / ')}（项目根下的顶层目录名）`,
          `命中的顶层目录：${top}/`,
          '★ 为什么连有写权限的角色也拦：`' + field + '` 是**数据通道**。',
          '  一份实现源码既不可能是一份合法的入参，也没有理由被当成入参来源 ——',
          '  放行它，这条通道就成了绕过"不读代码"的后门。',
          '把规格换到 `.pipeline/<任务id>/` 下面即可。',
        ],
      ),
    }
  }

  // ------------------------------------------------------ ⑥ 存在 + 是普通文件 --
  let st = null
  try {
    st = statSync(abs)
  } catch (err) {
    return {
      ok: false,
      summary: refuse(
        field,
        '参数文件**不存在**（或读不到）。',
        rejectedPath(abs),
        [`系统错误：${String(err?.code ?? err?.message ?? err)}`, '先把规格写到这个路径上，再把它传给 ' + field + '。'],
      ),
    }
  }
  if (!st.isFile()) {
    return { ok: false, summary: refuse(field, '参数文件必须是一个**普通文件**（给的是目录或特殊文件）。', rejectedPath(abs)) }
  }

  // ------------------------------------------------------ ⑦ 大小上限（给上限） --
  if (st.size > ARGS_FILE_MAX_BYTES) {
    return {
      ok: false,
      summary: refuse(
        field,
        '参数文件**过大**。',
        rejectedPath(abs),
        [
          `实际大小：${st.size} B`,
          `上限：${ARGS_FILE_MAX_BYTES} B（${Math.round(ARGS_FILE_MAX_BYTES / 1024)} KiB）`,
          '★ 入参文件不该有这么大 —— 多半是路径指错了（指到了一个数据文件或产物）。',
        ],
      ),
    }
  }

  // ------------------------------------------------------ ⑧ 只支持 JSON --
  if (isYamlName(abs)) {
    return {
      ok: false,
      summary: refuse(field, '暂不支持 YAML。', rejectedPath(abs), [`★ 本通道只支持 ${ARGS_FILE_FORMATS}。把规格改写成 .json 再来。`]),
    }
  }
  let text = ''
  try {
    text = readFileSync(abs, 'utf8')
  } catch (err) {
    return { ok: false, summary: refuse(field, '参数文件读失败。', rejectedPath(abs), [`系统错误：${String(err?.code ?? err?.message ?? err)}`]) }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // 去掉 BOM（JSON.parse 不认它）

  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    const fc = firstChar(text)
    return {
      ok: false,
      summary: refuse(
        field,
        '参数文件**不是合法 JSON**。',
        rejectedPath(abs),
        [
          `解析错误：${String(err?.message ?? err)}`,
          fc !== '' && fc !== '{' && fc !== '[' ? `★ 这份文件的第一个非空白字符是 \`${fc}\` —— 看着像 YAML。本通道只支持 ${ARGS_FILE_FORMATS}。` : '',
          '★ 这就是 `MALFORMED_RESPONSE` 的同一类问题，只是提前到了文件里：',
          '  在内联之前**先本地校验一次**，坏 JSON 只会让这一次调用失败，不会作废整轮上下文。',
        ].filter((l) => l.length > 0),
      ),
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, summary: refuse(field, '参数文件的顶层必须是**一个 JSON 对象**（`{...}`）。', rejectedPath(abs), [`实际类型：${Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed}`]) }
  }

  // ------------------------------------------------------ ⑨ 可选：整份包进 wrap --
  // ★ `pipeline_handoff` 的字段名叫 `payload_path` ⇒ 文件直接写成 payload 的字段最顺手；
  //   但"整份入参"那种写法（`{"payload":{…}}`）也必须能work。两条都收，规则是确定性的：
  //   **文件里有 `payload` 键就用它，没有就把整个文件当 payload**。
  let fromFile = parsed
  if (typeof wrap === 'string' && wrap.length > 0 && !Object.hasOwn(parsed, wrap)) {
    fromFile = { [wrap]: parsed }
  }

  // ------------------------------------------------------ ⑩ 挡拼错的键 --
  const allow = new Set(Array.isArray(allowedKeys) ? allowedKeys : [])
  const unknown = Object.keys(fromFile).filter((k) => !allow.has(k) && k !== field)
  if (unknown.length > 0 && allow.size > 0) {
    return {
      ok: false,
      summary: refuse(
        field,
        '参数文件里有**这个工具不认识的字段**（多半是拼错了）。',
        rejectedPath(abs),
        [
          `不认识的字段：${unknown.join('、')}`,
          `本工具认识的字段：${[...allow].filter((k) => k !== field).join('、')}`,
          '★ 不静默忽略：字段被悄悄丢掉，调用方会以为"我明明写了"。',
        ],
      ),
    }
  }

  // ------------------------------------------------------ ⑪ 合并：内联优先 --
  // ★ 只让**内联给过的**键覆盖文件里的（`undefined` 视为"没给"）——
  //   否则"内联没写"会把文件里的同名键覆盖成 undefined，等于文件白写。
  const merged = { ...fromFile }
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined) merged[k] = v
  }
  return { ok: true, args: merged, from: abs }
}
