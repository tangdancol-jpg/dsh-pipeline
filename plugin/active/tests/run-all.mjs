/**
 * dsh-pipeline · 全部自测一次跑完
 * ============================================================================
 *     node tests/run-all.mjs [--quiet]
 *
 * 十八套：
 *   1. selftest      正例全流程 + 10 组反例 + 分档验证（真跑，含拒绝原文）
 *   2. load-smoke    插件装载冒烟（假 ctx，验证 apply/注册/守门/路由/卸载路径）
 *   3. schema-check  用**真** `defineTool` 编译器校验 27 个工具定义
 *   4. switch-check  功能开关：开关语义 / 守门弃权 / 工具拒绝 / HTTP 路由
 *   5. client-check  客户端半边：装载契约 / 挂载契约 / 按钮行为（桩 React，无浏览器）
 *   6. human-check   ★人工介入链路：四步留痕 + 四类越权（用户只与主对话相连）
 *   7. writers-check ★编写席位分工 + 架构图角色（回执闸 / 降级路径）
 *   8. ladder-check  ★两级升级梯：角色 → 需求分析 → 用户（L0 例外 / 防踢皮球）
 *   9. security-check ★安全确认：本地泄密 + 网络面扫描、attestation 闸、工具自身脱敏
 *  10. relay-check    ★需求留档 + 上下文水位 + 席位继任（含计划 AI 自己继任 + 广播）
 *  11. records-check  ★分权落档 + 留档 AI（各写各的 → 专人汇总）
 *  12. plan-check     ★拆角色（需求分析 / 计划）+ 澄清前置到人工确认
 *                     + 计划缺失回流 + 按层分工与席位 3→6
 *  12.5 amend-check   ★★**授权面变更（amendment）**：一条只动 change_scope / forbidden
 *                     的窄通道（只在「待开发」由计划 AI 生效）+ 四组反例
 *                     （非 planner / 借道改席位档位顺序层 / 其它状态 / 既有路径不许回退）
 *  13. boundary-check ★★**设计目的**规则一、二：编写不跑测试 / 控制角色不看代码 / 白名单方向
 *  14. scope-check    ★★**设计目的**规则三、四：最小改动（改动面 = 授权面）
 *                     + 职责自限（分析与计划只干什么，不要多干）
 *  15. review-check   ★★**设计目的**规则五、六：双轨派活（writer+reviewer 同时接任务）
 *                     + 改动基线 / 前后版本对比 + **审核只读**（只有自己的日志可写）
 *  16. intercept-check ★★**拦截缝**：宿主扩展点上真拦（PreToolUse / UserPromptSubmit /
 *                     PostToolUse）+ **作用域**（非管线会话直通）+ kill-switch
 *  17. fulltest-check  ★★**全量测试审批链**：定向/全量的判定（不许误拦定向）
 *                     + 四级凭据（需求分析 → 审核 → 人工 → 计划）正反例
 *  18. hashgate-check ★★**哈希前置闸门**（排在一切测试之前）：新增/修改/删除三类越界
 *                     + 声明不实 ⇒ 直接打回编写，**测试根本没被触发**
 *                     + ★**连续 3 次不过 ⇒ 自动交人工**（走既有的 human_request / 两级梯）
 *                       且答复前**拒收**重交；撤回不归零、通过才归零；计数不跨任务串台；
 *                       `hashGateEscalateAfter: 0` = 关掉自动升级；打回扣预算的回归对照
 *                     + ★★**重取基线 = 新起点**（本轮修复 ②）：计数归零 + 旧基线判定作废
 *                       + `gate:hash_reset` 留痕，而**越界照拒**（只改起点，不放宽判定）
 *  19. wake-check     ★★**交付即唤醒主对话**（紧急前置修复 #4）：真实会话通道缺的
 *                     **第四步「交付回调」** —— 注入形状（`source.kind=runtime-context`，
 *                     不伪装成用户消息）/ **同一次交付只注入一次**（内存表 + 宿主队列
 *                     查重 + 确定性 requestId 三道）/ 只投主对话（结构上不可能投错）/
 *                     没登记就静默跳过 + audit 留痕（不抛错带崩调用方）/
 *                     六个触发工具 + 席位失联自动阻塞，走**同一个**入口
 *  20. human-registry-check ★★**人工介入请求「登记表」**（紧急修复 #5）：
 *                     现场是「状态里列得出交接物、收件箱却说没有任何请求」⇒
 *                     主对话取不出问题、也记不回答复 ⇒ 永久卡死。这一套验：
 *                     **两条提交路径都登记**（摊平 / 结构化）/
 *                     **兜底能把已卡死的单救回来**（登记表被清空但交接物在 ⇒
 *                     读盘即自愈、收件箱列得出、答复记得回）/
 *                     **既有反例不许回退**（主对话不能自行把请求标记为已解决）/
 *                     **兜底不覆盖已有记录**（answered 一个字节都不许变）
 *                     + ★★本轮补的两条漏路：**非阻塞请求**（blocking=false 不进等待态）
 *                       也要能反推；**热缓存路径**（cache 从不失效）也要能自愈
 *                     + ★★**读侧**（现场 T-20261012-7b9408「写进去了、读不到」）：
 *                       **写入后立刻读**必须拿得到 / 写事务期间不出现
 *                       「交接物可见、登记不可见」的半截状态 /
 *                       **读前对账**（盘比内存新 ⇒ 重载）；且对账不误伤本进程刚写完的
 *  21. wake-fidelity-check ★★**唤醒机制的保真度**（紧急修复 #5 追加）：
 *                     现场三处不实 —— ①正文报**转换之前**的状态（正文/下一步/谁全错，
 *                     把主对话引去处理不存在的状态）；②同一转换因判别子取错字段
 *                     （写的是 ['state','event']，工具返回的是 from/to）而退到 `h<n>`，
 *                     幂等键不稳定 ⇒ 刷屏；③操作没落地也发。
 *                     这一套全部走**真状态机 + 真工具 + 真拦截缝**验：
 *                     正文取转换后状态 / 键含真实转换前后状态 / 同转换只出一次 /
 *                     被拒或没落地都不发
 *
 * ★★ T-20261011-56a37e（主管枢纽）新增两套，**按约定名自动发现**（见下面的注册点）：
 *
 *  gate-states-check     守门与状态层：发起面只认主管 / 架构图前置是**表上不存在的边** /
 *                        两个唤醒点 / 五道确认站点（③④ 必须是**双**确认）/
 *                        方向表两处逐字一致 / 只读边界导出里新站点直接可见 /
 *                        控制角色不看代码（full 按角色受限）/ 站点确认的证据形状判据。
 *                        （计划里writer#1 的 `topology-check` 与 writer#2 的
 *                          `gate-criteria-check` 两组断言合并落在**这一个注册名**下 ——
 *                          注册名只能有一个，多开一个文件就是第二份清单。）
 *  dispatch-channel-check 通道与派活层：main 代发被拒 / 主管发起且**待机可读回** /
 *                        待机期三条产物判据（交接物·文件·测试）各一条反例 + 一条正例 /
 *                        站点①②的缺确认与唤醒点 A·B / 架构图前置与重画预算 = 1 /
 *                        测试提前知情（预登记只在计划站交、编写交付后不许再交、交付前不许开跑）/
 *                        留痕与真实 actor。
 *
 * ★★ **孤儿单自恢复**（2026-10-14 新增，第 26 套，显式注册）：
 *  orphan-rescue-check    席位被切断 ⇒ 机制**自己意识到 + 自己重新投递**：
 *                        两张真孤儿单（只读引用）被识别 / 孤儿形状 ⇒ 识别+重投+留痕 /
 *                        投不出去 ⇒ 审计 + 账本 unresolved + **既有巡检**那条播报 /
 *                        七条反例一律**不判**孤儿（含"刚被正常唤醒过"与"会话还在长"）/
 *                        判词与既有各条分得开（运行失败中止 ≠ 孤儿）/ 不建席位是**机械判据**。
 *
 * ★★ **D1（2026-10-14）新并入两套**（登记点见文件末尾那两段，各有逐条理由）：
 *  supervisor-check       主管站单元判据（死锁判据 / 现行链不受影响 / 越权仍被硬拒 /
 *                        五元组与两次确认的可判定性）—— **原来漏登记**，本单补上（21/21）。
 *  main-reattach-check    ★★ **主对话侧的重启自动认领**（「模拟重启后的空令牌表 ⇒
 *                        主对话自动重新绑定成功」+「不该绑的会话不得被绑上」+ 接线）——
 *                        判据本体 `lib/reattach.js` 的 `judgeMainClaim()`，只读导出
 *                        `index.js` 的 `lastMainReattach()`。
 *  ⚠️ **`quickfix-20261013-check` 刻意不注册**（理由逐条写在注册点旁边：
 *     带日期的一次性定点验证 + 没有导出运行器 + 它的两条红在 `dsh-archigate` 的几何求解器上）。
 *     独立跑法保留：`node tests/quickfix-20261013-check.mjs`（30/32、exit 1）。
 *
 * 退出码：0 = 全绿；1 = 有失败。
 * 报告落到 `tests/last-run.txt`，方便贴给用户/留档。
 *
 * ★ 全程零副作用：不创建任何真实会话，不监听任何端口，临时目录跑完即删。
 *
 * @module dsh-pipeline/tests/run-all
 */

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { leakedTempDirs, runSelfTest } from './selftest-core.mjs'
import { EXTRA_SUITES } from './registry.mjs'

import { runLoadSmoke } from './load-smoke.mjs'
import { checkToolSchemas } from './schema-check.mjs'
import { runSwitchCheck } from './switch-check.mjs'
import { runClientCheck } from './client-check.mjs'
import { runHumanCheck } from './human-check.mjs'
import { runHumanRegistryCheck } from './human-registry-check.mjs'
import { runWritersCheck } from './writers-check.mjs'
import { runLadderCheck } from './ladder-check.mjs'
import { runSecurityCheck } from './security-check.mjs'
import { runRelayCheck } from './relay-check.mjs'
import { runRecordsCheck } from './records-check.mjs'
import { runPlanCheck } from './plan-check.mjs'
import { runAmendCheck } from './amend-check.mjs'
import { runBoundaryCheck } from './boundary-check.mjs'
import { runScopeCheck } from './scope-check.mjs'
import { runReviewCheck } from './review-check.mjs'
import { runInterceptCheck } from './intercept-check.mjs'
import { runFullTestCheck } from './fulltest-check.mjs'
import { runHashGateCheck } from './hashgate-check.mjs'
import { runLivenessCheck } from './liveness-check.mjs'
import { checkToolOutputs } from './output-check.mjs'
import { checkSwitchRoute } from './switch-route-check.mjs'
import { runChannelCheck } from './channel-check.mjs'
import { runWakeCheck } from './wake-check.mjs'
import { runWakeFidelityCheck } from './wake-fidelity-check.mjs'
import { runRosterAuthorityCheck } from './roster-authority-check.mjs'
import { runT14FixCheck } from './t14-fix-check.mjs'
// ★ 唤醒 / 投递通道（T-20261012-8cdee0 编写席新增；判据 A1–A28 的落点见该文件头）
import { runWakeChannelCheck } from './wake-channel-check.mjs'
// ★★ 孤儿单自恢复（2026-10-14 新增）：「席位被切断 ⇒ 自己意识到 + 自己重新投递」。
//    为什么显式注册：本文件是**唯一的汇总口径** —— 注册不进来的用例集跑不到，
//    而"跑不到"的全绿是**假绿**（同上一条的理由）。
import { runOrphanRescueCheck } from './orphan-rescue-check.mjs'
// ★★ D1 第 2 件（2026-10-14）：**两个已经写好的套件没进聚合跑** ⇒ 按本文件既有的
//    显式注册约定纳入。登记薄里原来缺的是这两个：
//      · supervisor-check      主管站单元判据（它**有** `runSupervisorCheck()`，
//                              返回 {passed,total,text} —— 与其余各套同形，直接注册）；
//      · quickfix-20261013-check  **刻意不注册**，理由逐条写在下面的注册点旁边
//                              （它是带日期的一次性定点验证，且没有导出运行器）。
import { runSupervisorCheck } from './supervisor-check.mjs'
// ★★ D1 第 1 件（2026-10-14）：**主对话侧的重启自动认领** ——
//    「模拟重启后的空令牌表 ⇒ 主对话自动重新绑定成功」+「不该绑的会话不得被绑上」。
import { runMainReattachCheck } from './main-reattach-check.mjs'
// ★★ p11（2026-10-15）：**16 个角色专属 Agent 预设**。预设不是文件、是 bundle patch 里的
//    一条 `@deepseek-ai/dsh-agent-preset` 行；本套钉住六条判据（角色集合双向相等 /
//    每目录文件齐全 / meta.id 不撞车 / 权限档取值与 writeClassOf 同源 / 生成物可被 YAML
//    解析且 config.id 唯一 / **五条负例自证**）。角色集合是 **import** `lib/roles.js` 的
//    `ALL_ROLE_IDS` 来的 —— 测试里没有第二份角色清单。
import { runPresetsCheck } from './p11-presets-check.mjs'
// ★★ 守门「静默否决 + 把自己文档当违规」（2026-10-16 真机缺陷）：`agent/pre-step` 的
//    `{kind:"reject"}` 是宿主的**一票否决** —— turn 不开始 ⇒ 拒绝理由**没有出口**。
//    现场：把 `pl-main` 预设全文粘进主对话 ⇒ 命中自己文档里的那条规则散文 ⇒
//    「这一轮 1 秒结束、消息像没发出去」，插件侧零留痕。这一套钉三条：
//    ① 假阳性（H/I 预测：pl-main 全文 + 那一行 ⇒ 放行）；② 真违规仍被拦（判据落点收窄到
//    `tools/pre-execute`）；③ 绝不静默（可见文案 + 审计行）。不注册 = 跑不到 = 假绿。
import { runSilentVetoCheck } from './silent-veto-check.mjs'
// ★★ 席位路径（真机缺陷的第二条通道 · 用户优先级提升）：**扫的是整轮 prompt** ——
//    `collectPromptText(payload)` 把 `payload.messages[]` 每条都拼起来跑判据，
//    席位自己的 persona / 边界卡 / 记忆切片 / 派活单**全在扫描面内**。
//    这一套钉"席位开工不会被自己的说明书掐死"（回归 16/17）。
import { runSilentVetoSeatCheck } from './silent-veto-seat-check.mjs'
// ★★ 第三条路径（**真凶**）：**注入 / 回灌**。席位干完把结论回灌 / 唤醒给主对话，
//    走 `lib/hostmsg.js` 的注入通道 —— 那条注入消息同样进 prompt 扫描
//    （`collectPromptText` 只读 `messages[].content`，**一个字节都不读 `source`**）
//    ⇒ 主对话那一轮被静默掐掉，席位看起来"停了"、任务看起来"卡住了"。
//    不注册 = 跑不到 = 假绿。
import { runSilentVetoInjectCheck } from './silent-veto-inject-check.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const verbose = !process.argv.includes('--quiet')

const parts = []
/**
 * ★ 每套的原始输出单独落盘（`tests/<suite>-last-run.txt`）。
 *
 * 为什么要程序自己写：这些文件是交付物里"原始输出"的证据。
 * 早先它们靠**人手**生成 —— 于是出现过一个**陈旧**的 records-last-run.txt，
 * 内容与代码不符（写着 22/23），被当成"顺序耦合"的证据读。
 * 让跑测试的人自己写，就不可能再漂。
 */
const suiteTexts = new Map()
let schemaText = null
let passed = 0
let total = 0
let ok = true

{
  const r = await runSelfTest({ verbose })
  suiteTexts.set('selftest', r.text)
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runLoadSmoke()
  suiteTexts.set('load-smoke', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await checkToolSchemas()
  schemaText = r.text
  parts.push('')
  parts.push('='.repeat(78))
  parts.push('工具定义：真 defineTool 编译器校验')
  parts.push('='.repeat(78))
  parts.push('')
  parts.push(r.text)
  if (r.checked) {
    total += r.total
    passed += r.total - r.failures.length
    if (!r.ok) ok = false
  } else {
    // 没测 ≠ 通过：明确标出来，且不计入分子 —— 免得"跳过"看起来像满分。
    parts.push('')
    parts.push('⚠ 这一套被跳过了，不计入通过率。')
    ok = ok && true
  }
}

{
  // ★ 工具**返回值**的契约：每个 pipeline_* 工具的真跑结果过一遍宿主的输出校验器。
  //   注册期看不出来，只有真跑一次才知道 —— 这条就是为那次宿主报
  //   `tool "pipeline_status" returned invalid output: missing required property …` 加的。
  const r = await checkToolOutputs()
  suiteTexts.set('output-check', r.text)
  parts.push('')
  parts.push('='.repeat(78))
  parts.push('工具输出契约：每个工具的**真实返回值**都过宿主的校验器')
  parts.push('='.repeat(78))
  parts.push('')
  parts.push(r.text)
  if (r.checked) {
    total += r.total
    passed += r.total - (r.failed ?? r.failures.length)
    if (!r.ok) ok = false
  } else {
    parts.push('')
    parts.push('⚠ 这一套被跳过了，不计入通过率。')
  }
}

{
  // ★ 开关路由的**可选注入**：有 webServer 才挂、没有也要跑完（headless 形态）。
  const r = await checkSwitchRoute()
  suiteTexts.set('switch-route-check', r.text)
  parts.push('')
  parts.push(r.text)
  if (r.checked) {
    total += r.total
    passed += r.total - (r.failed ?? r.failures.length)
    if (!r.ok) ok = false
  } else {
    parts.push('')
    parts.push('⚠ 这一套被跳过了，不计入通过率。')
  }
}

{
  const r = await runSwitchCheck()
  suiteTexts.set('switch-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runClientCheck()
  suiteTexts.set('client-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runHumanCheck()
  suiteTexts.set('human-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  // ★★ 人工介入请求「登记表」（紧急修复 #5）：两条数据源各写各的 ⇒
  //    「状态里列得出交接物、收件箱却说没有任何请求」⇒ 主对话取不出问题、
  //    也记不回答复 ⇒ 任务永久卡死。这一套盯的就是这个形状不再出现。
  const r = await runHumanRegistryCheck()
  suiteTexts.set('human-registry-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runWritersCheck()
  suiteTexts.set('writers-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runLadderCheck()
  suiteTexts.set('ladder-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runSecurityCheck()
  suiteTexts.set('security-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runRelayCheck()
  suiteTexts.set('relay-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runRecordsCheck()
  suiteTexts.set('records-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runPlanCheck()
  suiteTexts.set('plan-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  // ★★ 授权面变更（amendment）：用户已裁定"允许纳入授权面"，但计划工具在「待开发」
  //    拒绝再出计划（跳步）⇒ 裁定有了、动作做不了。这条窄通道补的就是这一步，
  //    并且**不许**把计划那道闸放松（反例④专门盯着这件事）。
  const r = await runAmendCheck()
  suiteTexts.set('amend-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runBoundaryCheck()
  suiteTexts.set('boundary-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runScopeCheck()
  suiteTexts.set('scope-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runReviewCheck()
  suiteTexts.set('review-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runInterceptCheck()
  suiteTexts.set('intercept-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runFullTestCheck()
  suiteTexts.set('fulltest-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  const r = await runHashGateCheck()
  suiteTexts.set('hashgate-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  // ★★ 2026-10-11 事故：注入给宿主的消息缺 `source` ⇒ 子会话 turn/start 之后
  //    277 ms 报 `Cannot read properties of undefined (reading 'kind')` 静默死亡；
  //    以及"席位死了机制不知道"（任务永远停在「需求分析中」）。
  const r = await runLivenessCheck()
  suiteTexts.set('liveness-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  // ★★ 真实会话派活通道（本次改造的通道侧）：能力探测 / 四槽物理分离 /
  //    最小档兜底 / 「完全」档默认禁用（三段闸门）/ 归组失败即拒 /
  //    **不许拿子代理冒名** / 不可达只上报不降级。
  const r = await runChannelCheck()
  suiteTexts.set('channel-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  // ★★ **交付即唤醒主对话**（紧急前置修复 #4）：真实会话通道只做了
  //    「建会话 → 投递 → 读回」三步、**没有第四步「交付回调」** ⇒
  //    席位交付 / 状态推进 / 席位失联时主对话完全不知情，用户看到的就是"没动静了"。
  //    这一套验：注入形状（source=runtime-context，不伪装成用户消息）/
  //    **同一次交付只注入一次**（三道幂等）/ 只投主对话 / 没登记就静默跳过 + audit 留痕 /
  //    六个工具 + 失联自动阻塞的触发点接线。
  const r = await runWakeCheck()
  suiteTexts.set('wake-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

{
  // ★★ 唤醒机制的**保真度**（现场修复 #5 追加）：三处不实 ——
  //    「状态取值早于转换」/「同一转换重复唤醒（幂等键不稳定）」/「操作没落地也发」。
  //    全部走**真状态机 + 真工具 + 真拦截缝**，不靠合成 spec（合成 spec 正是这三处
  //    当初漏掉的原因：旧 wake-check 的 transition 用例自己拼 disc，工具真实返回形状
  //    从来没被喂进去过）。
  const r = await runWakeFidelityCheck()
  suiteTexts.set('wake-fidelity-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

// ---------------------------------------------------------------------------
// ★★ 2026-10-12 新增的第 23 套：**十四条缺陷修复的夹具化回归**。
//   含用户裁定的验收第 2 条：用当晚真实数字（30 秒 +10,717 字节）离线复算失联判据。
// ---------------------------------------------------------------------------
{
  const r = await runT14FixCheck()
  suiteTexts.set('t14-fix-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

// ---------------------------------------------------------------------------
// ★★ 本轮新增的第 22 套：**名单权威层**（四槽 / 版本位 / 人数上限 / 硬性次序 / 留痕字段）。
//   与既有 21 套同形：同一个汇总口径、同一份 per-suite 原始输出落盘。
// ---------------------------------------------------------------------------
{
  const r = await runRosterAuthorityCheck()
  suiteTexts.set('roster-authority-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

// ---------------------------------------------------------------------------
// ★ 唤醒 / 投递通道（本轮新增）：纪律与既有各套同形（临时目录、跑完即删）。
//
//   为什么显式注册而不是让它自己跑：本文件是**唯一的汇总口径** ——
//   注册进不来的用例集跑不到，而"跑不到"的全绿是**假绿**。
// ---------------------------------------------------------------------------
{
  const r = await runWakeChannelCheck()
  suiteTexts.set('wake-channel-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

// ---------------------------------------------------------------------------
// ★★ 孤儿单自恢复（2026-10-14 新增）：**席位被切断 ⇒ 机制自己意识到 + 自己重新投递**。
//    它验五件事：① 本机两张真孤儿单（只读引用）被识别；② 孤儿形状 ⇒ 识别 + 重投 + 留痕；
//    ③ 投不出去 ⇒ 审计 + 账本 unresolved + **既有巡检**那条播报（不是静默）；
//    ④ 反例（正常闲置 / 刚被唤醒过 / 会话还在长 / 有活证据 / 人工阻塞 / 终态 / 窗口内）
//       **一条都不许**判成孤儿；⑤ 判词与既有各条分得开（运行失败中止 ≠ 孤儿）。
// ---------------------------------------------------------------------------
{
  const r = await runOrphanRescueCheck()
  suiteTexts.set('orphan-rescue-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

// ---------------------------------------------------------------------------
// ★★ D1 第 2 件（2026-10-14）：**把两个漏登记的套件纳进唯一的汇总口径**。
//
//   现场（实读结论）：`tests/supervisor-check.mjs`（21/21）与
//   `tests/quickfix-20261013-check.mjs`（30/32、exit 1）**都没注册进来** ⇒
//   聚合跑看不到它们，而"跑不到的全绿"= **假绿**（本文件头写过两次的同一句话）。
//
//   ── ① supervisor-check：**已注册**（就在下面这一段）────────────────────
//      它本来就导出了 `runSupervisorCheck()`，返回 `{passed,total,text}` ——
//      与同目录其余各套**逐字同形**，所以形状照抄即可，不新造任何机制。
//      ⚠️ 纳入后聚合跑的**总数会变**（分母 +21）—— 这是预期的，见 D1 报告。
//
//   ── ② quickfix-20261013-check：**如实说明并跳过**（不注册）──────────────
//      三条理由，逐条可核：
//        (a) 它是**带日期的一次性定点验证**（文件名含 `20261013`，文件头自述
//            "本套只做**本次四条快修**的定点验证"）；
//        (b) 它**没有导出运行器** —— 全文是顶层脚本 + `process.exit()`，
//            要注册就得把 548 行整篇改写成一个函数（那是**重构既有测试**，
//            不在本单授权面内）；
//        (c) 它当前 **30/32**，那两条红在 `dsh-archigate` 的几何求解器
//            （`maxViewBoxWidthFor` 的字号目标用例）上 —— **不是本插件的判据**。
//            纳进来会让本插件的聚合跑因**别的插件**的期望值而长期变红，
//            而"不许为变绿改断言"这条纪律又禁止我动它。
//      ⇒ 它的**独立跑法**保留：`node tests/quickfix-20261013-check.mjs`（30/32、exit 1）。
//         这一条结论是**明写**的，不是"忘了注册"。
// ---------------------------------------------------------------------------
{
  const r = await runSupervisorCheck()
  suiteTexts.set('supervisor-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

// ---------------------------------------------------------------------------
// ★★ D1 第 1 件（2026-10-14）：**主对话侧的重启自动认领**。
//
//   它验的就是机制对比文档 §二 ④ 照出来的那一半：「席位侧已自动、**主对话侧仍手动**」。
//   本命断言一条：**模拟重启后的空令牌表 ⇒ 主对话自动重新绑定成功**
//   （`tokens.clear()` ⇒ `autoReattachMain` ⇒ `roleOfAgent` 重新拿到 main）；
//   外加反例「另一个会话在同一张空表下**一张都认不到**」、
//   「依据坏了 ⇒ 认领不了**且报出来**（warn + `main:reattach-refused` 留痕）」、
//   以及"不补位 / 不建会话 / 不改状态"的**机械判据**。
// ---------------------------------------------------------------------------
{
  const r = await runMainReattachCheck()
  suiteTexts.set('main-reattach-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

// ---------------------------------------------------------------------------
// ★★ p11 · 角色专属 Agent 预设（16 条）。
//   为什么必须注册进来：`presets/` 是本插件里**唯一会被 DSH 直接读取**的新面
//   （`package.json` 的 `dsh.bundle.patch` 第二条），它错了不会让任何既有测试变红 ——
//   只有这一套会。负例自证在**临时副本**上跑，全程不碰真树。
// ---------------------------------------------------------------------------
{
  const r = await runPresetsCheck()
  suiteTexts.set('p11-presets-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

// ---------------------------------------------------------------------------
// ★★ 守门「静默否决 + 把自己文档当违规」（2026-10-16 真机缺陷的夹具化回归）。
//   为什么必须注册进来：本文件是**唯一的汇总口径** —— 注册不进来的用例集跑不到，
//   而"跑不到"的全绿是**假绿**（本文件头写过三次的同一句话）。
// ---------------------------------------------------------------------------
{
  const r = await runSilentVetoCheck()
  suiteTexts.set('silent-veto-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

// ---------------------------------------------------------------------------
// ★★ 席位路径（真机缺陷的第二条通道）：**扫的是整轮 prompt** ⇒ 席位可能被自己的
//    人格 / 边界卡 / 派活单一票否决，而且那条路 `turn` 根本不开始 ⇒ 零留痕。
//    单开一套的理由：与"用户消息层不判"是**两个不同的判据面**（一个是文本来源，
//    一个是生效位置），分开才好按条核对。不注册 = 跑不到 = 假绿。
// ---------------------------------------------------------------------------
{
  const r = await runSilentVetoSeatCheck()
  suiteTexts.set('silent-veto-seat-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

// ---------------------------------------------------------------------------
// ★★ 注入 / 回灌路径（真机缺陷的第三条通道 · 用户点名的"真凶"）：
//    席位结论回灌 → hostmsg 注入 → 命中 prompt 扫描 → 主对话这一轮被静默掐掉，
//    于是"席位像是停住了 / 任务像是卡住了"，且零报错。不注册 = 跑不到 = 假绿。
// ---------------------------------------------------------------------------
{
  const r = await runSilentVetoInjectCheck()
  suiteTexts.set('silent-veto-inject-check', r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

// ---------------------------------------------------------------------------
// ★★ 另两席（守门与状态层 / 通道与派活层）的用例集：**按约定名发现**。
//
//   为什么由本文件发现、而不是各自加一行 import：`tests/run-all.mjs` 的注册点
//   是**本席位**的文件面（另两席不得改它），而"另两席新加的用例必须真的被跑到"
//   是硬要求 —— 跑不到的话"全绿"是**假绿**。所以发现动作放在这里，另两席只需把
//   文件按约定名放好（`tests/<层名>-check.mjs`，导出 `run<层名驼峰>Check`）。
//
//   ⚠️ 刻意**不做 glob 通配**：本文件是静态注册表，通配会把备份件、在制件、别人
//   放进来的杂项一起扫进来 —— 那是另一种漂移。这里只认三个约定名。
// ---------------------------------------------------------------------------
for (const extra of EXTRA_SUITES) {
  let mod = null
  try {
    mod = await import(extra.file)
  } catch {
    mod = null
  }
  const fn = mod === null ? null : mod[extra.exportName]
  if (typeof fn !== 'function') {
    parts.push('')
    parts.push(`【${extra.file.replace('./', '').replace('.mjs', '')}】尚未落地（${extra.zh}）—— **不计入通过率**`)
    parts.push(`    （本席在注册点按约定名发现它：文件缺失或没导出 ${extra.exportName} 都算"尚未落地"。）`)
    parts.push('')
    continue
  }
  const r = await fn()
  suiteTexts.set(extra.file.replace('./', '').replace('.mjs', ''), r.text)
  parts.push('')
  parts.push(r.text)
  passed += r.passed
  total += r.total
  if (r.passed !== r.total) ok = false
}

// ---------------------------------------------------------------------------
// ★ 残留检查：每套自测都该把自己建的临时目录清掉。
//
//   为什么单独查这个：这些目录**不影响结果**（每次 mkdtemp 都是全新唯一目录、
//   taskId 也唯一），但它们看起来像"外部残留"，会把排查引偏。
//   实测积过 47 个（41 个里带着真 `.pipeline` 数据）—— 所以做成**会红**的断言，
//   而不是靠人记得清。
// ---------------------------------------------------------------------------
const leaked = leakedTempDirs()
parts.push('')
parts.push('─'.repeat(78))
parts.push(`【残留检查】每套自测的临时目录是否清干净：${leaked.length === 0 ? '0 个泄漏 ✓' : `${leaked.length} 个泄漏 ✗`}`)
parts.push('─'.repeat(78))
if (leaked.length === 0) {
  parts.push('✓ 全部临时目录已清理（没有跨次残留）')
  total += 1
  passed += 1
} else {
  parts.push('✗ 有临时目录没清掉 —— 清掉它们，或让对应套自己 rm：')
  for (const d of leaked.slice(0, 20)) parts.push(`    · ${d}`)
  total += 1
  ok = false
}

const header = [
  '',
  '#'.repeat(78),
  `#  dsh-pipeline 自测汇总：${passed}/${total} 通过${ok ? '' : '  ← 有失败'}`,
  `#  跑法：node tests/run-all.mjs   （node 版本 ${process.version}，平台 ${process.platform}）`,
  '#'.repeat(78),
]

const text = [...header, ...parts].join('\n')
console.log(text)

const written = []
try {
  for (const [name, body] of suiteTexts) {
    const p = join(HERE, `${name}-last-run.txt`)
    await writeFile(p, `${body}\n`, 'utf8')
    written.push(name)
  }
  // 工具定义那套没有汇总行，单独落一份
  if (schemaText !== null) await writeFile(join(HERE, 'schema-check-last-run.txt'), `${schemaText}\n`, 'utf8')
  await writeFile(join(HERE, 'last-run.txt'), `${text}\n`, 'utf8')
  console.log(`\n报告已写入：${join(HERE, 'last-run.txt')}`)
  console.log(`每套原始输出也已同步落盘（${written.length + (schemaText !== null ? 1 : 0)} 份）：${[...written, ...(schemaText !== null ? ['schema-check'] : [])].map((x) => `${x}-last-run.txt`).join(' / ')}`)
} catch (err) {
  console.log(`\n（报告落盘失败，不影响结论：${String(err?.message ?? err)}）`)
}

process.exit(ok ? 0 : 1)
