/**
 * dsh-pipeline · 配置
 * ============================================================================
 * 刻意**不导出 Cordis 的 `Config` schema**（与已装的 dsh-archigate 同一取舍）：
 * 少一个 `@deepseek-ai/schemastery` 的运行期依赖，就少一类"link: 安装时解析
 * 不到 z、插件整行不激活"的故障。代价是插件管理器里不会自动生成配置表单 ——
 * 调参请直接改 profile 的 `cordis.patch.yml`。
 *
 * @module dsh-pipeline/lib/config
 */

import { DEFAULT_READ_TOOLS, DEFAULT_SEARCH_TOOLS, DEFAULT_SHELL_TOOLS, DEFAULT_SHELL_TOOL_PATTERN, DEFAULT_WRITE_TOOLS } from './guard.js'

/** 配置默认值。 */
export const DEFAULTS = {
  /** 总开关。false = 不注册任何工具、不注册守门。 */
  enabled: true,
  /** 硬拦截总开关。 */
  guardEnabled: true,
  /** 流水线工作区目录名，落在项目根下。 */
  artifactDirName: '.pipeline',
  /** 单条打回链的最大次数（审核→编写、测试→编写 各自计数）。 */
  maxReworkPerLeg: 2,
  /**
   * 角色驱动通道：
   *   auto     先试真实会话通道，拿不到就**只上报**（默认；不静默降级）
   *   session  强制真实会话通道（拿不到就报错）
   *   subagent 强制真实子代理（拿不到就报错）
   *   manual   只发角色令牌，不创建任何会话（人工复制通道，零副作用）
   *   team     ★ 官方 Agent Teams 通道：派「具名 teammate」、走官方 sendMessage 投递
   *            （四槽里的 mode 下发不了 —— 官方 spawnTeammate 没有这个参数，见 lib/transport/team.js）
   */
  transport: 'auto',
  /**
   * ★ `transport:'auto'` 时是否**先**试团队通道（默认 false ⇒ 生产行为一个字节不变）。
   *
   * 为什么默认关：`auto` 的既有语义是"先试真实会话通道"，改优先级等于改变现有生产行为；
   * 团队通道的价值（官方名单可见 / 官方投递）要显式选，验证过再谈默认。
   */
  teamAuto: false,
  /**
   * 团队通道派活用哪个 subagent provider。实测本机可用值：`spawn` / `fork`
   * （`context:'fresh'` 对应 spawn，`'fork'` 对应 fork —— 官方工具层就是这么映射的）。
   * ★ teammate 只能用带 `prepareContinuable` 的 local provider：换成 `claude-code` / `codex`
   *   这类 external provider 会被官方以 `UNSUPPORTED_CAPABILITY` 拒掉。
   */
  teamProvider: 'spawn',
  /**
   * ★ teammate 名字前缀（kebab）：名字 = `<前缀>-<任务小写>-<角色>[-<席位序号>]`。
   * 官方名字**同 Team 内永久唯一、永不重用**，所以任务必须编进名字里（见 lib/team/naming.js）。
   */
  teamNamePrefix: 'p',
  /**
   * ★ **严格四槽**：官方 `spawnTeammate` 没有 agentPreset / permission / model 参数，
   * 四槽只能 spawn 之后补钉（mode 根本补不上）。默认 false = 补钉失败时**如实登记**并继续；
   * true = 任一槽"显式非默认却钉不上"就**拒绝派活**（`mode` 恒钉不上，所以显式给了 mode 必拒）。
   */
  teamStrictSlots: false,
  /**
   * ★ 团队通道不可达时是否自动退回别的通道。默认 `off` = **不降级**（与 `allowChannelFallback`
   * 同一纪律：拿近似物冒名比"看得见的失败"危险得多）。本阶段只接受 `off`。
   */
  teamFallback: 'off',
  /**
   * ★ 任务板镜像（pipeline 任务 ↔ 官方 `team_task_*`）：`auto` = team 通道与服务可用时镜像，
   * `off` = 关。镜像**失败不阻断流水线**（任务板是辅助面，错误只进 audit）。
   */
  teamBoard: 'auto',
  /** 是否真的创建子代理会话。false = 自测/演示用（只发令牌，不建会话）。 */
  spawnRoles: true,
  /**
   * 真实子代理用哪个 provider。实测本机可用值：spawn / fork
   * （`dsh-subagent-spawn-in-process` / `dsh-subagent-fork-in-process`）。
   */
  subagentProvider: 'spawn',
  /** 角色子代理的 provider（含上下文继承语义的）—— 留空表示与 subagentProvider 相同。 */
  roleProvider: '',
  /**
   * 真实会话通道的默认内置模式（= 会话头 `agentPreset`）。留空 = `standard`。
   * ★ 以前它是**隐式键**：`SessionTransport` 读 `cfg.sessionPreset`，而本文件既没默认值
   *   也没类型校验 ⇒ 填个数字会一路落进宿主 `create({agentPreset: 42})`。现在有默认值与校验。
   */
  sessionPreset: '',
  /** 子代理标签前缀（便于在会话列表里一眼认出流水线角色）。 */
  labelPrefix: 'pipeline',
  /** 参与「测试/审核不得改代码」「控制角色不得读代码」判定的读写工具名。 */
  guardFileTools: { write: [...DEFAULT_WRITE_TOOLS], read: [...DEFAULT_READ_TOOLS], search: [...DEFAULT_SEARCH_TOOLS] },
  /** 参与 shell 旁路判定的 shell 工具名。 */
  guardShellTools: [...DEFAULT_SHELL_TOOLS],
  /** shell 工具名的宽松判据（正则）；空串 = 关掉这条，只用显式名单。 */
  guardShellToolPattern: DEFAULT_SHELL_TOOL_PATTERN,
  /** 是否拦截主对话读取受保护路径的代码正文。 */
  guardMainReadsCode: true,
  /**
   * ★ 是否拦截**编写角色跑测试**（设计目的：编程别跑测试）。
   *
   * 拦的是"明确的测试执行形态"（`npm test` / `pytest` / `node --test` / `node tests/x.mjs` …），
   * **不拦**构建/启动级冒烟（`npm run build` / `node build.mjs` / `node -e …`）。
   * 关掉（false）则这一层整体弃权 —— 但"独立验证"就重新退回成一句纪律。
   *
   * ⚠️ 自测的**最小限度**（冒烟算不算测试判定、`dev_to_test.selftest_result` 还要不要）
   * 与 `writer` 既有 summary 里的"自测结果"存在冲突，属于**待用户拍板项**（README 有清单）。
   */
  guardWriterRunsTests: true,
  /**
   * ★ 是否执法「**最小改动：改动面必须与授权面相等**」。
   *
   * 拦的是：编写写到计划 `change_scope` **没有授权**的路径上（含**新增文件**）。
   * 关掉（false）则这一层弃权 —— 但"修一个 bug 就别该整个模块"就只剩一句口号。
   *
   * ⚠️ 只有**有计划**的任务才执法：L0 没有"计划"这一站（规则引擎自批），
   *    不存在授权面 ⇒ 该判据弃权（见 README「待确认项」P4）。
   */
  guardChangeScope: true,
  /**
   * ★ **授权面锚点**（设计目的：最小改动 —— 裸相对路径按"包根"解析）。
   *
   * `change_scope[].path` 与 `writers.partitions[].scope_paths` 里写的裸相对路径
   * （`index.js`、`lib/tools.js`、`tests/` …）**按这个目录解析**。
   *
   * 为什么必须是一个显式配置项，而不是"拿任务的 `project_root` 拼"：
   *   本插件常被用来**改自己** —— 此时任务的 `project_root` 是工作区根
   *   （例如 `<profile>/`），而真正要改的文件在 `<profile>/node_modules/dsh-pipeline/` 之下。
   *   真单 T-20261011-214043 实测：拿工作区根拼裸相对路径 ⇒ **20 条授权条条落空**，
   *   三个编写席全被挡死（交付面 = 0）；而工作区根下**恰好同名**的
   *   `package.json` / `cordis.patch.yml` 又会被**误放行**（越界清单点名禁改的那两份）。
   *
   * 取值：**绝对路径**（相对写法按项目根解析）；留空（默认）= **本任务的项目根**。
   * 优先级：`task.scope_anchor`（非空才算）> 本项 > 项目根 > 插件包根（最后手段）。
   * ★ 缺陷 ①（2026-10-17）：默认值从"插件包根"改成"项目根"——普通项目在计划里写相对路径
   *   是最自然的写法，落到包根会让编写一个字都写不出。用流水线改插件自己时，把本项（或任务的
   *   scope_anchor）显式设成插件包根，或把授权路径写全（node_modules/dsh-pipeline/…）。
   *
   * ⚠️ 有意**不**做"从授权面自身推断唯一落点目录"：那会让判定基准依赖被判定对象。
   * 改了本项**需要重启 DSH** 才生效（配置在装配时读入）。
   */
  changeScopeAnchor: '',
  /**
   * ★ **拦截缝总闸**：是否把守门判据挂到宿主的拦截扩展点上
   * （`tools/pre-execute` / `agent/pre-step` / `tools/post-execute`）。
   *
   * 用户原话：「**我是让你安排写入多 ai 协同插件中去阻止他们干不该干的事，而不是新写**」
   *          「真正的拦截必须是代码」。
   *
   * 与 `guardEnabled` 的区别：
   *   · `guardEnabled` 管的是**工具服务**那条缝（`ctx.tools.guard`），靠令牌/会话绑定认人；
   *   · `intercept` 管的是**宿主拦截缝**，靠"这个会话是不是管线席位"认人 ——
   *     管线席位**派生出来的子会话**（没有自己的令牌）也躲不掉。
   *   两条缝调用的是**同一份** `guard(exec)`，所以判据不会漂移。
   *
   * 作用域：只有本插件派出去的管线席位受影响，其它会话一律直通。
   * 想整体关掉：`intercept: false`（需要重启）或翻**总开关**（`pipeline_switch` / 右上角按钮，即时）。
   */
  intercept: true,
  /**
   * ★★ **主对话侧的重启自动认领总闸**（2026-10-14 补的那一半）。
   *
   * 背景：令牌表是**进程内存态**，DSH 一重启就全空。席位侧已经会自动认回来
   * （`index.js` 的 A27(b)，按 `task.dispatched[]` 台账），而**主对话侧原来仍是手动** ——
   * 每次重启后都要人（或主对话自己）发一次
   * `pipeline_task_open { task_id, reattach: true }`。
   *
   * 这条闸门开着时：**每一次**工具调用的前置缝（`tools/pre-execute`）上，若调用方
   * 会话手上没有任何 main 令牌，就按盘上 `task.json` 的 `contacts.main.agent_id`
   * 逐字比对 —— 相等才把 main 身份认回来（判据本体在 `lib/reattach.js` 的
   * `judgeMainClaim`，纯函数、只读）。
   *
   * ★ 它**不放宽任何身份校验**：比手动通道**更严**（手动 `reattach` 不校验调用方，
   *   本闸门要求 `contacts.main.agent_id === 调用方会话 id`）。
   * ★ 它**不补位、不新建会话、不改状态**（留痕只追加 `audit.jsonl`，不碰 `task.json`）。
   * 关掉（false）= 回到"重启后主对话必须手动认领"的旧行为。
   */
  mainReattachEnabled: true,
  /**
   * ★ **全量测试审批链总闸**：测试角色跑"整套测试"时必须有四级凭据
   * （需求分析 → 审核 → 人工 → 计划）。
   *
   * 用户原话：「需求 ai 要确认是否，并尽可能让测试 ai 少跑全量测试，如果测试 ai 要跑
   * 必须提交给需求 ai 和审核 ai 确认，如果都认为要做再提交给主对话给用户人工审核，
   * 确认人工通过后再提交给计划 ai 安排」。
   *
   * 判据分两步（都纯函数，见 lib/testscope.js）：
   *   · classifyTestCommand —— 有收窄参数（-k/--grep/-t/--filter/具体测试文件/具体包）⇒ 定向**放行**；
   *     裸跑整套（npm test / pytest / go test ./... / node --test tests/）⇒ 全量，要凭据；
   *   · fullTestCredential —— 四级都点头了吗？点头的是**哪一条命令**（批一条跑另一条也拒）。
   *
   * 关掉（false）= 这条链弃权（测试想跑全量就跑）—— 但"少跑全量"就只剩一句口号。
   */
  guardFullTestApproval: true,
  /**
   * ★ **哈希前置闸门总闸**：提交（dev_to_test）时先按基线做哈希对比，
   * 不通过就**直接打回编写**（不进入测试、不消耗测试预算、不进全量审批链）；
   * 且闸门没过期间**任何角色都不许跑测试**（含定向）。
   *
   * 用户原话：「**先过哈希对比，哈希对比不过全量测试直接打回**」。
   * 关掉（false）= 这道闸弃权 —— 但"不合格的提交不该消耗测试资源"就只剩一句口号。
   */
  guardHashGate: true,
  /**
   * ★ **哈希前置闸门「连续不通过」多少次 ⇒ 自动交人工**（默认 3；`0` = 关掉自动升级）。
   *
   * 用户拍板（P13 的结论，2026-10-11）：
   *   · 闸门不通过 **不消耗** `maxReworkPerLeg`（**保持现状**）——
   *     任务从未离开 `developing`，"打回"严格说没发生（提交本身不成立）；
   *   · 但"编写可以无限重交"这个副作用必须堵上 ⇒ **连续 N 次不过就自动交人工**。
   *
   * 语义（三句话，别改）：
   *   ① **连续** = 同一个任务上"闸门不通过"的次数；**一次通过（闸门真过了）就归零**。
   *      撤回越界改动**不**归零 —— 撤回不是机制可观测的事件（机制只看得到下一次提交
   *      过没过），看得到的那件事是"这个任务连续几次交上来的东西没过闸门"。
   *   ② 到了阈值 ⇒ **自动**交人工，走**既有**的 `human_request` / 两级梯
   *      （不新开状态、不新开工具、不新开一套并行机制）。
   *   ③ 升级之后、用户答复之前，**同一任务的 `dev_to_test` 被硬拒**（不是提醒，是拒收）。
   *      用户答复后重新武装（计数归零，可再次累计、再次升级）—— 理由见 `lib/hashgate.js`。
   *
   * 与 `guardHashGate` 的分工：前者管"这道闸要不要执法"，这条管"执法不过之后怎么办"。
   */
  hashGateEscalateAfter: 3,
  /**
   * ★ **席位失联的静默阈值（毫秒）**。默认 5 分钟（`300000`）。
   *
   * 用户原话：「要让每个工具 AI 知道自己要干什么，而不是去运行，**然后被切断**，
   *           或者**切断后自己能意识到**」。
   *
   * 为什么需要它：`pipeline_dispatch` 可以**成功**建出子会话、投递派活单、返回令牌，
   * 而那个子会话在第一步就静默死亡（2026-10-11 的事故就是这样：`turn/start` 之后
   * 277 ms 报错收尾，一句话都没说）。没有这条判据时，任务会**永远**停在
   * 「需求分析中」、`pipeline_status` 显示「交接物（0 份）」，机制自己不知道 ——
   * 用户是从主对话口里才知道的。
   *
   * 判据见 `lib/liveness.js`（三条同时成立才算失联：超时 + **轮到场了** + 毫无活着的证据）。
   * `0` 或负数 = **关掉失联检测**（`checkLiveness` 直接弃权）。
   */
  seatSilenceMs: 5 * 60 * 1000,
  /**
   * ★ **发现席位失联时是否自动处置**（默认 true）。
   *
   * true = 把任务推到「已阻塞」并写明原因（走 `states.js` 里既有的 `block` 异常出口，
   * 不新开状态），处置台账落在 `task.liveness.escalations[]` + 审计。
   * 解除：`pipeline_transition event=unblock`（回到阻塞前的状态）。
   *
   * false = **只报告不处置**（`pipeline_status` 与席位简报里照样写出来，但状态不动）。
   */
  seatLivenessEscalate: true,
  /**
   * L0 是否也拆出独立的编排对话。
   * 默认 false = 按需求原文的「L0 极简脚本=4」理解（编排由确定性规则引擎承担）。
   * 改成 true 则 L0 也变成 5 个独立对话。这条是**规格歧义的开关**，
   * README「待确认项」里有说明。
   */
  l0OrchestratorSeparate: false,
  /** 规则引擎拿不准时的兜底档。 */
  defaultTier: 'L1',
  /** 角色令牌有效期（毫秒）。 */
  tokenTtlMs: 2 * 60 * 60 * 1000,
  /**
   * 是否要求角色令牌与会话身份二次绑定。
   * true = 令牌转手即失效（更严，但要求走真实子代理通道）。
   *
   * ★ 默认值本轮由 false 改为 **true**（用户裁定 ★6：「开令牌与会话绑定」）。
   *   为什么现在能翻：本插件的**两条**通道铸令牌时都已经绑定身份 ——
   *   真实会话通道拿 sessionId 当绑定，子代理通道在 spawn 之后立刻绑定；
   *   人工通道那条路由是先 pipeline_bind_role 认领、再动作 ⇒ 不会出现"绑不上"的令牌。
   *
   * ⚠️ **生效需要重启 DSH**（配置在装配时读入），且它改变的是提交语义：
   *   任何**没有绑定会话**的令牌从此一律被拒。启停方法：本项设回 false（同样要重启）。
   *   影响面：其它正在跑的任务若走人工复制通道，需要在重启后重新认领一次角色。
   */
  requireAgentBinding: true,
  /** 是否注册一段 system prompt（告诉模型这套流水线怎么用）。 */
  registerPromptSection: true,
  /**
   * ★ 人工介入请求的默认截止时长（小时）。0（默认）= 不设截止。
   *
   * 只有在设了截止（这里 >0，或请求自带 timeout_at）时，才允许
   * `pipeline_human_reply { answer_source: "timeout" }` 按事前声明的策略放行 ——
   * **没有截止时间就不存在"超时"这回事**，否则那会变成一条绕过用户答复的后门。
   */
  humanRequestTimeoutHours: 0,
  /**
   * ★ 是否强制答复回带转告时给出的确认码。
   *
   * 默认 false（方便）。设成 true 之后，主对话必须把用户答复里带的 HC-xxxx 抄回来才作数 ——
   * 这把"主对话替用户拍板"的门槛从"编一句话"抬高到"连确认码一起编"。
   * 诚实的边界：它挡不住铁了心伪造的主对话，但它让伪造**多一个具体、可被用户本人核对的破绽**。
   */
  requireHumanConfirmCode: false,
  /**
   * ★ 同一个澄清问题最多问几次（**防踢皮球**）。默认 2。
   *
   * 允许问第二次（"答了我还是不明白，再确认一下"是合理的），
   * 但第三次开始就拒 —— 反复问同一件事说明它根本不是"需求层能定的"，
   * 那就该走升级路径，而不是原地打转。
   */
  maxClarifyRounds: 2,
  /**
   * 多 AI 协调功能开关（右上角 UI 那个按钮控制的**同一个**开关位）。
   * 首次启动（还没有状态文件）时的初值。默认 true。
   */
  switchDefaultOn: true,
  /**
   * 开关状态文件。留空 = `<项目根>/.pipeline/switch.json`。
   * 状态会落盘，所以重启后保持上次的选择。
   */
  switchStateFile: '',
  /**
   * 是否挂载开关的 HTTP 端点（客户端 UI 靠它读写宿主开关）。
   * 拿不到 `ctx.webServer` 时自动跳过，不影响工具与守门。
   * 如果你的 profile 把 webServer 配成对外监听，建议设成 false。
   */
  switchRoute: true,
  /**
   * ★★ **文件规模提醒**（用户需求 2026-10-18）：
   * 文件行数 >150 / >300 / ≥400 时，由**程序自动发起**一次对话（注入成用户消息）问：
   * 「有必要写这么大吗？是顺手写在一起了还是功能需求？」；400 时第三次问「一定要这个
   * 写法吗？有没有更优的写法？」，并要求 AI 实际调用 `web_search` / `web_fetch` 查更优写法。
   *
   * 只是**提醒**（不判红、不阻塞）：去重（同文件同档只问一次）在 `lib/size-reminder.js`；
   * 两条缝在 `lib/guard/hook-size.js`（post-execute 记行数 → pre-step 投递问句）。
   * 关掉（`enabled:false`）则整条提醒链不做事。
   */
  sizeReminder: {
    enabled: true,
    firstLines: 150,
    secondLines: 300,
    thirdLines: 400,
    maxAsksPerStep: 2,
  },
  /** 项目根：留空 = 用 session 工作目录。 */
  projectRoot: '',
  /**
   * ★★ **已播报账本**（A19 / A20；用户裁定 D5「允许新增状态文件」）。
   *
   * 留空 = `<插件目录>/wake-ledger.jsonl`（**生效副本插件目录内** —— B16 的落点约束）。
   * 它的用途只有一个：让「同一条事件恰播一次」**跨进程**成立。删掉会怎样：
   * 去重退回"内存表 + 目标会话队列"两道既有判据 ⇒ 重启后同一条事件可能被**再播一次**
   * （不会丢事件、不会错投）；随时可用重建口径从既有事件数据重建（见交付说明）。
   */
  wakeLedgerFile: '',
  /** 账本的开关（false = 只在内存里去重 —— 自测/排障用，**不是**默认形态）。 */
  wakeLedgerEnabled: true,
  /**
   * ★★ **巡检兜底**（A21–A25；用户裁定 D4「加一条巡检兜底」）。
   *
   * 它只播报、不动作（不补位 / 不继任 / 不冻结 / 不解冻 / 不推进状态 / 不重置失联计数）。
   * 默认 5 分钟一轮 —— 相对"无进展 20 分钟"的口径足够及时，也不会变成心跳刷屏源。
   */
  patrolEnabled: true,
  patrolIntervalMs: 5 * 60 * 1000,
  /** 「任务长时间无进展」的口径（毫秒）。 */
  patrolStallMs: 20 * 60 * 1000,
  /** 「已投递但没人接管」的升级叫醒口径（R1 / A28；毫秒）。 */
  wakeUnconsumedMs: 15 * 60 * 1000,
  /**
   * ★★ **孤儿单自恢复**（用户原话：「席位被切断后，机制要能**自己意识到**并**重新投递**」）。
   *
   * 与巡检是**两件事**（判据不同源、动作不同）：
   *   · 巡检 = 「长时间无进展」⇒**只播报**（A22 写死了"不动作"）；
   *   · 自恢复 = 「席位被切断 / 这单没人管了」⇒**识别 + 自己重新投递**（走 `notify_only`）。
   *
   * ★ 它**不建会话、不派新席位**（用户裁定：「不要求自动补新席位」）、**不改任务状态**。
   */
  orphanRescueEnabled: true,
  orphanIntervalMs: 5 * 60 * 1000,
  /** 判定窗：任务超过这么久没有任何进展/证据，才允许判孤儿（毫秒）。 */
  orphanGraceMs: 15 * 60 * 1000,
  /** 两次重投之间的最小间隔（毫秒）——同一身份失败后的退避。 */
  orphanRedeliverBackoffMs: 30 * 60 * 1000,
  /** 同一身份最多重投几次（超过就记"已放弃"，不再骚扰）。 */
  orphanMaxRedeliverAttempts: 3,
}

/** 合并配置：只认对象，未给的字段走默认值；数组字段做类型保护。 */
export function mergeConfig(raw) {
  const c = raw !== null && typeof raw === 'object' ? raw : {}
  const out = { ...DEFAULTS, ...c }

  if (!Array.isArray(out.guardShellTools) || out.guardShellTools.length === 0) {
    out.guardShellTools = [...DEFAULTS.guardShellTools]
  }
  if (typeof out.guardShellToolPattern !== 'string') out.guardShellToolPattern = DEFAULT_SHELL_TOOL_PATTERN
  if (typeof out.artifactDirName !== 'string' || out.artifactDirName.trim().length === 0) {
    out.artifactDirName = DEFAULTS.artifactDirName
  }
  if (!Number.isInteger(out.maxReworkPerLeg) || out.maxReworkPerLeg < 0) out.maxReworkPerLeg = DEFAULTS.maxReworkPerLeg
  // ★ 0 是**合法值**（= 关掉"连续不过就自动交人工"）—— 所以这里只挡"不是非负整数"。
  if (!Number.isInteger(out.hashGateEscalateAfter) || out.hashGateEscalateAfter < 0) {
    out.hashGateEscalateAfter = DEFAULTS.hashGateEscalateAfter
  }
  if (!Number.isInteger(out.tokenTtlMs) || out.tokenTtlMs <= 0) out.tokenTtlMs = DEFAULTS.tokenTtlMs
  // ★ 失联静默阈值允许「0 / 负数 = 关掉」——所以只挡"不是非负整数"，不回落成默认值。
  if (!Number.isInteger(out.seatSilenceMs)) out.seatSilenceMs = DEFAULTS.seatSilenceMs
  // ★ 账本与巡检的新配置：类型不对就回落默认值（**不许**因为配置写错就把它们悄悄关掉）。
  if (typeof out.wakeLedgerFile !== 'string') out.wakeLedgerFile = DEFAULTS.wakeLedgerFile
  if (typeof out.wakeLedgerEnabled !== 'boolean') out.wakeLedgerEnabled = DEFAULTS.wakeLedgerEnabled
  if (typeof out.patrolEnabled !== 'boolean') out.patrolEnabled = DEFAULTS.patrolEnabled
  if (!Number.isInteger(out.patrolIntervalMs) || out.patrolIntervalMs <= 0) out.patrolIntervalMs = DEFAULTS.patrolIntervalMs
  if (!Number.isInteger(out.patrolStallMs) || out.patrolStallMs <= 0) out.patrolStallMs = DEFAULTS.patrolStallMs
  if (!Number.isInteger(out.wakeUnconsumedMs) || out.wakeUnconsumedMs < 0) out.wakeUnconsumedMs = DEFAULTS.wakeUnconsumedMs
  // ★ 孤儿单自恢复（同一条纪律：类型不对就回落默认值，**不许**因为配置写错就把它悄悄关掉）。
  if (typeof out.orphanRescueEnabled !== 'boolean') out.orphanRescueEnabled = DEFAULTS.orphanRescueEnabled
  // ★ 主对话侧自动认领（同一条纪律：类型不对就回落默认值，**不许**因为配置写错就把它悄悄关掉）。
  if (typeof out.mainReattachEnabled !== 'boolean') out.mainReattachEnabled = DEFAULTS.mainReattachEnabled
  if (!Number.isInteger(out.orphanIntervalMs) || out.orphanIntervalMs <= 0) out.orphanIntervalMs = DEFAULTS.orphanIntervalMs
  // ★ 过短的判定窗会把"刚派完活、席位冷启动"误判成孤儿 —— 所以下限卡在一个静默窗口（5 分钟）。
  if (!Number.isInteger(out.orphanGraceMs) || out.orphanGraceMs < DEFAULTS.seatSilenceMs) out.orphanGraceMs = DEFAULTS.orphanGraceMs
  if (!Number.isInteger(out.orphanRedeliverBackoffMs) || out.orphanRedeliverBackoffMs < 0) out.orphanRedeliverBackoffMs = DEFAULTS.orphanRedeliverBackoffMs
  if (!Number.isInteger(out.orphanMaxRedeliverAttempts) || out.orphanMaxRedeliverAttempts <= 0) out.orphanMaxRedeliverAttempts = DEFAULTS.orphanMaxRedeliverAttempts

  const ft = out.guardFileTools !== null && typeof out.guardFileTools === 'object' ? out.guardFileTools : {}
  out.guardFileTools = {
    write: Array.isArray(ft.write) && ft.write.length > 0 ? ft.write : [...DEFAULT_WRITE_TOOLS],
    read: Array.isArray(ft.read) && ft.read.length > 0 ? ft.read : [...DEFAULT_READ_TOOLS],
    search: Array.isArray(ft.search) && ft.search.length > 0 ? ft.search : [...DEFAULT_SEARCH_TOOLS],
  }

  // ★ 通道白名单：`team` / `session` 是**显式**选项（`session` 以前不在白名单里 ⇒
  //   显式写 `transport:'session'` 会被静默改回 auto，那是"配置被悄悄吃掉"）。
  if (!['auto', 'subagent', 'manual', 'session', 'team'].includes(out.transport)) out.transport = DEFAULTS.transport
  // ★ 团队通道（WP-T）：类型写错一律回落默认值 —— **不许**因为配置写错就把能力悄悄关掉。
  if (typeof out.teamAuto !== 'boolean') out.teamAuto = DEFAULTS.teamAuto
  if (typeof out.teamProvider !== 'string' || out.teamProvider.trim().length === 0) out.teamProvider = DEFAULTS.teamProvider
  // 前缀必须是合法 kebab 段（否则拼出来的 teammate 名字会被官方以 TEAM_INVALID_MEMBER_NAME 拒）。
  if (typeof out.teamNamePrefix !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(out.teamNamePrefix)) {
    out.teamNamePrefix = DEFAULTS.teamNamePrefix
  }
  if (typeof out.teamStrictSlots !== 'boolean') out.teamStrictSlots = DEFAULTS.teamStrictSlots
  if (!['off'].includes(out.teamFallback)) out.teamFallback = DEFAULTS.teamFallback
  if (!['auto', 'off'].includes(out.teamBoard)) out.teamBoard = DEFAULTS.teamBoard
  // `sessionPreset` 以前是**隐式键**（SessionTransport 读它，config.js 里既没默认值也没校验）
  // ⇒ 填个数字会让 `create({agentPreset: 42})` 直接落进宿主，报错还看不懂。
  if (typeof out.sessionPreset !== 'string' || out.sessionPreset.trim().length === 0) out.sessionPreset = DEFAULTS.sessionPreset
  if (!['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].includes(out.defaultTier)) out.defaultTier = DEFAULTS.defaultTier
  if (typeof out.subagentProvider !== 'string' || out.subagentProvider.length === 0) out.subagentProvider = DEFAULTS.subagentProvider

  return out
}
