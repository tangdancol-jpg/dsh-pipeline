/**
 * dsh-pipeline · **全量测试 vs 定向测试**的判定
 * ============================================================================
 * 用户原话：
 *   「**需求 ai 要确认是否，并尽可能让测试 ai 少跑全量测试**，如果测试 ai 要跑
 *     必须提交给需求 ai 和审核 ai 确认，如果都认为要做再提交给主对话给用户人工审核，
 *     确认人工通过后再提交给计划 ai 安排」
 *
 * 这个模块只回答**一个问题**：这条命令是不是"**整套/全量**"？
 * 它不判身份、不判状态、不做决定 —— 那些在守门里。
 *
 * ---------------------------------------------------------------------------
 * 判定口径（这是判据，不是感觉）
 * ---------------------------------------------------------------------------
 * **先认出"这是测试命令"**（按各生态最常见的形态），再看它**有没有收窄范围**：
 *
 *   · **带收窄 ⇒ 定向（放行）**：出现下列任一
 *       - 过滤参数：`-k / -m / -t / --grep / --fgrep / --testNamePattern / --testPathPattern /
 *         --test-name-pattern / --testPathIgnorePatterns / --filter / -Dtest= / --tests / -run / --run`
 *       - `--` 之后的**具体文件/路径**（`npm test -- src/a.test.ts`）
 *       - 明确的**文件或目录前缀**：`tests/unit/a.test.ts`、`./pkg/x`、`src/x_test.go`
 *       - 单个测试名：`jest -t "adds two"`
 *
 *   · **没有收窄 ⇒ 全量（要审批）**：裸跑
 *       - `npm test` / `npm run test` / `pnpm test` / `yarn test` / `bun test`
 *       - `npx jest` / `npx vitest run` / `npx mocha`（无参数）
 *       - `pytest` / `python -m pytest`（无 `-k/-m/路径`）
 *       - `go test ./...`（**全包**；`go test ./pkg/x` 是定向）
 *       - `cargo test`（无 `--test/过滤`）、`dotnet test`（无 `--filter`）
 *       - `mvn test`（无 `-Dtest=`）、`gradle test`（无 `--tests`）
 *       - `node --test tests/`（**整目录**；`node --test tests/a.test.mjs` 是定向）
 *       - `phpunit`（无 `--filter`/路径）、`rspec`（无路径）、`dotnet test`（无 filter）
 *
 *   · **认不出是测试命令 ⇒ null**（本模块弃权，交给别的判据）
 *
 * ⚠️ 已知边界（诚实写出来，别假装它更聪明）：
 *   · 变量拼接、脚本里再调 `npm test`、`sh -c "…"` 套一层 —— 字符串判据看不到。
 *   · `make test` / 自定义脚本名（`npm run check`）认不出 ⇒ 弃权（宁可漏判也不误拦）。
 *     这类要靠 `pipeline_full_test` 的**自觉申请** + 审核看 `what_will_run` 兜。
 *
 * @module dsh-pipeline/lib/testscope
 */

/** 各生态的"整套测试"命令形态。`re` 命中即候选，再看有没有收窄参数。 */
const FULL_TEST_FORMS = [
  { re: /(^|[\s;&|(])(npm|pnpm|yarn|bun)\s+(run\s+)?t(est)?([\s:.-]|$)/i, what: '包管理器的 test 脚本' },
  { re: /(^|[\s;&|(])npx\s+(jest|vitest|mocha|ava|jasmine|tape)\b/i, what: 'npx 跑的测试框架' },
  { re: /(^|[\s;&|(])(jest|vitest|mocha|ava|jasmine)\b/i, what: '测试框架直跑' },
  { re: /(^|[\s;&|(])(python[0-9.]*\s+-m\s+)?pytest\b/i, what: 'pytest' },
  { re: /(^|[\s;&|(])python[0-9.]*\s+-m\s+unittest\b/i, what: 'unittest' },
  { re: /(^|[\s;&|(])go\s+test\b/i, what: 'go test' },
  { re: /(^|[\s;&|(])cargo\s+test\b/i, what: 'cargo test' },
  { re: /(^|[\s;&|(])dotnet\s+test\b/i, what: 'dotnet test' },
  { re: /(^|[\s;&|(])(mvn|maven)\s+.*\btest\b/i, what: 'maven test' },
  { re: /(^|[\s;&|(])(gradle|\.\/gradlew)\s+.*\btest\b/i, what: 'gradle test' },
  { re: /(^|[\s;&|(])node\s+--test\b/i, what: 'node --test' },
  { re: /(^|[\s;&|(])(phpunit|rspec|pest)\b/i, what: 'php/phpunit · ruby/rspec' },
]

/**
 * **收窄参数**：出现任意一个 ⇒ 这次只跑一部分 ⇒ 定向。
 *
 * 这些是所有主流测试运行器上"缩小范围"的通用拼法（逐个核对过语义）。
 */
const NARROWING_FLAGS =
  /(^|\s)(-k|-m|-t|-run|--run|--test|--grep|--fgrep|--invert|--testNamePattern|--testPathPattern|--test-name-pattern|--testPathIgnorePatterns|--testMatch|--testPathPatterns|--filter|--tests|--only|--scope|-Dtest=|--filters?)\b/i
// ⚠️ `--test` 的语义**取决于运行器**：
//    · `cargo test --test adds`  里的 `--test <name>` 是"只跑这个集成测试目标" ⇒ **收窄**；
//    · `node --test tests/`      里的 `--test` 是"用 node 自带测试运行器" ⇒ **选运行器，不收窄**。
//    两种写法前面都是 `--test`，所以判据里先把 node 那个**消掉**再认收窄参数。
//    （踩过一次：不区分会把 `node --test tests/` 整目录跑法误判成定向 —— 那是**漏拦**。）
const NODE_TEST_RUNNER_RE = /(^|[\s;&|(])node\s+--test\b/gi

/** 命令里出现**具体的**测试文件/包路径（不是 `./...` 这种"全包"写法）⇒ 定向。 */
const NARROWING_PATH = /(^|\s)(\.?\/)?[\w.@-]*\/[\w.@/-]*(test|spec)[\w.-]*\.[a-z]{1,4}\b/i

/** 明确的"全包/全部"写法 ⇒ 全量（哪怕带着路径形态）。 */
const ALL_PACKAGE_MARKERS = /(\.\/\.\.\.|\*\*\/\*|--all\b|\ball-tests\b|\bfull[-_]?suite\b)/i

/**
 * 从命令串里剥掉 `--` 之前的包管理器调用，拿到"真正传给了测试运行器"的那部分。
 * @param {string} cmd
 */
function payloadOf(cmd) {
  const i = cmd.indexOf(' -- ')
  return i >= 0 ? cmd.slice(i + 4) : ''
}

/**
 * ★ 判一条命令是"全量"还是"定向"。
 *
 * @param {string} cmd - shell 命令原文
 * @returns {{kind:'full'|'targeted'|null, what:string, why:string, matched:string}}
 *   `kind=null` = 认不出是测试命令（本判据弃权）
 */
export function classifyTestCommand(cmd) {
  const text = String(cmd ?? '')
  if (text.length === 0) return { kind: null, what: '', why: '', matched: '' }

  const form = FULL_TEST_FORMS.find((f) => f.re.test(text))
  if (form === undefined) return { kind: null, what: '', why: '', matched: '' }

  const matched = (text.match(form.re) ?? [''])[0].trim()

  // ① 明确的"全包"写法 ⇒ 直接判全量（这类写法本身就是"跑全部"的意思）
  if (ALL_PACKAGE_MARKERS.test(text)) {
    return { kind: 'full', what: form.what, why: `出现"全包/全部"写法（${(text.match(ALL_PACKAGE_MARKERS) ?? [''])[0]}）`, matched }
  }

  // ② 有收窄参数 ⇒ 定向（认之前先把 `node --test` 这个"选运行器"的写法消掉）
  const probed = text.replace(NODE_TEST_RUNNER_RE, '$1node ')
  const flag = probed.match(NARROWING_FLAGS)
  if (flag !== null) {
    return { kind: 'targeted', what: form.what, why: `带了收窄参数 ${flag[0].trim()}`, matched }
  }

  // ③ `--` 之后给了具体文件 ⇒ 定向
  const payload = payloadOf(text)
  if (payload.length > 0 && /[\w./-]+\.(test|spec)\.[a-z]{1,4}\b|[\w./-]+\/(tests?|specs?)\//i.test(payload)) {
    return { kind: 'targeted', what: form.what, why: `\`--\` 之后指定了具体用例（${payload.trim().slice(0, 60)}）`, matched }
  }

  // ④ 命令里直接给了具体测试文件路径 ⇒ 定向
  if (NARROWING_PATH.test(text)) {
    return { kind: 'targeted', what: form.what, why: `命令里指定了具体测试文件（${(text.match(NARROWING_PATH) ?? [''])[0].trim()}）`, matched }
  }

  // ⑤ `go test ./pkg/x`（给了具体包，不是 ./...）⇒ 定向
  if (/go\s+test\b/i.test(text) && /(^|\s)\.?\/?[\w.-]+\/[\w./-]+/.test(text)) {
    return { kind: 'targeted', what: form.what, why: 'go test 指定了具体包', matched }
  }

  // ⑥ 其余 = 裸跑 ⇒ 全量
  return { kind: 'full', what: form.what, why: '没有任何收窄参数或具体用例范围（整套跑）', matched }
}

/**
 * 两段命令是不是"同一件事"（用于放行时比对"批的是这条吗"）。
 *
 * 口径**故意宽**：审批批的是"跑全量"这件事与它的范围，不是逐字节比对 ——
 * 多一个 `--ci` 之类的开关不该导致"批了却跑不了"。所以比对**规范化后的主干**。
 *
 * @param {string} approved - 计划 AI 批准的命令
 * @param {string} actual - 实际要跑的命令
 * @returns {{same:boolean, why:string}}
 */
export function sameTestCommand(approved, actual) {
  const norm = (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
  const a = norm(approved)
  const b = norm(actual)
  if (a.length === 0) return { same: false, why: '批准的命令是空的' }
  if (a === b) return { same: true, why: '逐字一致' }
  // 前缀/包含关系也算（允许加 `--ci` / `--reporter=…` 这类不改变范围的开关）
  if (b.startsWith(a)) return { same: true, why: '实际命令 = 批准的命令 + 附加开关' }
  const aHead = a.split(' ').slice(0, 3).join(' ')
  if (aHead.length > 0 && b.startsWith(aHead)) return { same: true, why: `主干相同（${aHead}）` }
  return { same: false, why: `批准的是「${a}」，实际要跑「${b}」—— 不是同一条` }
}

/**
 * ★ **全量测试的放行凭据**：从任务对象里算出"现在能不能跑全量、能跑哪一条"。
 *
 * 纯函数（不读盘、不抛异常）—— 因为守门那条路是**同步**的，
 * 而任务数据在盘上：同步索引里存的就是这个函数的结果。
 *
 * 凭据 = 审批链**四级全部通过**：
 *   ① 需求分析 need.ok === true（这次真的需要）
 *   ② 审核 worth.ok === true（值得跑）
 *   ③ 人工 human.approved === true（用户点了头，且答复带原话引用）
 *   ④ 计划 AI 已 arrange（定了范围与**最终批准的那条命令**）
 *
 * @param {object|null} task
 * @returns {null|{approval_id:string, round:number, command:string, what_will_run:string, scope:string}}
 */
export function fullTestCredential(task) {
  const list = Array.isArray(task?.full_test_approvals) ? task.full_test_approvals : []
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i]
    if (c?.status !== 'approved') continue
    const command = typeof c?.arranged?.command === 'string' ? c.arranged.command : ''
    if (command.length === 0) continue
    return {
      approval_id: String(c.approval_id ?? ''),
      round: Number.isInteger(c.round) ? c.round : 0,
      command,
      scope: String(c?.arranged?.scope ?? ''),
      what_will_run: String(c?.request?.what_will_run ?? ''),
    }
  }
  return null
}

/** 当前**进行中**的那条申请（最近一条还没结案的）。 */
export function pendingFullTestApproval(task) {
  const list = Array.isArray(task?.full_test_approvals) ? task.full_test_approvals : []
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.status === 'pending') return list[i]
  }
  return null
}

/** 审批链的**下一站**（给人看的"还差谁点头"）。 */
export function nextFullTestStage(chain) {
  if (chain === null || chain === undefined) return 'tester-request'
  if (chain.status === 'rejected') return 'stopped'
  if (chain.status === 'approved') return 'done'
  if (chain.need === null) return 'orchestrator-need'
  if (chain.need.ok !== true) return 'stopped'
  if (chain.worth === null) return 'reviewer-worth'
  if (chain.worth.ok !== true) return 'stopped'
  if (chain.human === null) return 'main-to-human'
  if (chain.human.approved !== true) return 'stopped'
  if (chain.arranged === null) return 'planner-arrange'
  return 'done'
}
