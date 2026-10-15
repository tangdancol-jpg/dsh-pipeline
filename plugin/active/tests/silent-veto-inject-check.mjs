/**
 * dsh-pipeline · **注入 / 回灌路径不被静默掐掉**（真机缺陷的第三条通道 · 真凶）
 * ============================================================================
 *     node tests/silent-veto-inject-check.mjs
 *
 * 用户原话：「**是你的对话有**（1 秒结束），而且**他当时停了**，应该是**他给你发的消息被砍了**」。
 *
 * ---------------------------------------------------------------------------
 * ★★ 因果链（这条才是"流水线看起来卡住"的真凶）
 * ---------------------------------------------------------------------------
 *     席位干完 → 结论**回灌 / 唤醒**到主对话（走 `lib/hostmsg.js` 的注入通道）
 *             → 那条**注入消息**命中 prompt 扫描
 *             → 主对话这一轮被**静默掐掉**（UI 显示"已完成，用时 1 秒"）
 *             → 席位看起来"停住了"、任务看起来"卡住了"，而且**零报错**
 *
 * ---------------------------------------------------------------------------
 * ★★ 扫的到底是哪一段文本（三条路径共用的那一个判据输入端）
 * ---------------------------------------------------------------------------
 *   · `lib/intercept/prompt-rules.js:73-81` —— `collectPromptText(payload)`：
 *     遍历 `payload?.messages`，取 `m?.content`（字符串或 block 数组里的 `.text`）**拼起来**。
 *     ⚠️ **它一个字节都不读 `m.source`** —— 所以
 *     `source.kind = 'runtime-context'` / `'plugin:dsh-pipeline'` / `'computer-use'`
 *     的**注入消息**与用户在输入框里打的字**被同等对待**。
 *   · `lib/guard/hook-prompt.js:80-81` —— **唯一调用点**：
 *     `const advice = judgePrompt(seat, collectPromptText(payload))`。
 *   · 注入的生产者登记在 `lib/hostmsg.js` 的 `HOST_INJECTION_SITES`
 *     （`pre-step-seat-briefing` / `pre-step-stale-seat-notice` / `pre-step-prompt-advice` /
 *      `pre-step-memory-recall` / `wake-main-session` / `post-execute-block-feedback`）。
 *
 *   ⇒ **三条路径**（本套 + `silent-veto-check` + `silent-veto-seat-check` 合起来覆盖）：
 *       ① **用户输入**            → `tests/silent-veto-check.mjs`（A/B 组 25 条语料）
 *       ② **席位派活与唤醒**      → `tests/silent-veto-seat-check.mjs`（回归 16/17）
 *       ③ **注入 / 回灌**（本套） → 系统通知 · 唤醒投递 · 记忆切片 · 边界卡 · 席位结论回灌
 *
 * ---------------------------------------------------------------------------
 * ★ 实测取证（70 份会话日志 · 多帧 zstd 逐帧解压）
 * ---------------------------------------------------------------------------
 *   把改前判据（`512aebb` 的 `PROMPT_CODE_READ_RE`）逐条跑一遍所有 `user/message`：
 *     **24 条命中**，其中 **11 条是注入 / 回灌**（`source.kind` 分别为
 *     `computer-use`×10 / `subagent-settled`×1，`form` 全是 `notice`），
 *     13 条才是用户输入 ⇒ **注入路径确实会踩中**，不是理论风险。
 *
 *   那 11 条的**实测体量**（行 / 字符）：69/2959 · 39/2966 · 38/3736 · 58/3895 ·
 *   54/4000 · 36/4000 · 74/4000 · 53/4000 · 68/4000 · 58/4000 · 309/29496
 *   —— 中位约 **54 行 / 4000 字符**（4000 像是投递侧的截断上限），
 *   与用户说的「25 行 / 3505 字符」同属一族。
 *   本套的 `INJECTED_NOTICE` 取其中**实测触发行的集合**作为等价形状
 *   （`REAL_TRIGGER_LINES`，逐字来自那 11 条）。
 *
 * @module dsh-pipeline/tests/silent-veto-inject-check
 */

import { hostMessage } from '../lib/hostmsg.js'
import { judgePrompt } from '../lib/intercept.js'
import {
  closeFixtures,
  createRecorder,
  indent,
  renderSuite,
  setupInterceptHost,
} from './silent-veto-fixtures.mjs'

/**
 * ★★ 实测里**真正触发**过旧判据的那些行（逐字，来自 11 条注入消息；
 *    只把会话 uuid / 绝对路径打码）。
 *
 * 它们全是**叙述 / 引用**：列文件清单、写改动点、引用 README —— 没有一条是"让谁去读代码"。
 */
export const REAL_TRIGGER_LINES = [
  '- `dsh-compaction-basic/lib/index.js:839`, `dsh-plan-mode/lib/index.js:152`, `dsh-session-reference/lib/index.js:468`',
  '- 若是 `guard` 语义/时机不对：按 DSH 的真实实现改成正确写法（你的注释里引用了 README，但**以源码为准**）；',
  '   - 特别确认：`src/writer/`、`src/reviewer/`、`src/supervisor/` 是否各有 **prefix.md 与 suffix.md**',
  '3. **三个角色的首尾提示词落点**：`src/writer/`、`src/reviewer/`、`src/supervisor/` 各自的 `prefix.md` / `suffix.md` 是否存在（一行一条）',
  '`lib/switch/gate.js:94` `SWITCH_SURFACES` 加 3 行 → 不接则 off 后仍写盘/注入',
  '- 关单触发点按草案 `lib/store/review.js:304`（**不接则活文档永不更新**）',
  '2. **既有文件逐处改动**（文件:行 · 一行说明 · 覆盖它的测试）—— `lib/store/review.js:304` 的关单触发点',
  '| `README.md` 1877 / `ARCHITECTURE.md` 991 / `WIRING.md` 397 / `CONVENTIONS.md` 133 | **A** | 权威契约 |',
  '- `README.md:87-90`（人肉 `sha256sum -c MANIFEST.sha256`）⇒ `MANIFEST.sha256` 本身是契约',
  '- **8 守门**：`NO_CODE_READ`/字符串匹配的能力边界在哪（指代码）、已知误拦怎么表现',
  '逐个抓取 README、源码（index.js / 客户端脚本）、Config 字段与人设正文，列出**各自的长处与短板**。',
]

/**
 * ★★ **回归 19**：一条真机形状的「后台会话干完了」**系统通知**（注入 / 回灌）。
 *
 * 形状取自实测（`source.kind=computer-use`，`form=notice`，收尾行逐字来自现场）；
 * 正文里带 `REAL_TRIGGER_LINES`（实测触发行的等价形状）—— 改前**必被一票否决**。
 */
export const INJECTED_NOTICE = [
  'Background Code agent session session-<uuid> finished this task:',
  '',
  '## 结论（交给主对话）',
  '结构核对完成，逐条如下：',
  '',
  ...REAL_TRIGGER_LINES,
  '',
  '## 下一步建议',
  '1. 按上面的清单逐条接上；',
  '2. 每处都要有一行说明 + 覆盖它的测试；',
  '3. 拿不准的以源码为准，不要凭印象改。',
  '',
  '## 备注',
  '本消息由子会话结束时**自动回灌**给主对话，**不是用户输入**。',
].join('\n')

/** ★ **回归 20**：席位回灌给主对话的**结论**（含 `read` / `grep` / `源码树` 字样）。 */
export const SEAT_REPLY = [
  '【流水线 · 席位交付】需求分析完成，结论摘要：',
  '',
  '· 判据面：守门按角色收紧，控制角色（`main` / `orchestrator` / `planner` / `supervisor`）',
  '  不读代码正文 —— 这是 `NO_CODE_READ_ROLES` 的口径，`read` / `grep` 指向源码树时拒。',
  '· 已知误拦形态：`read / grep 等指向源码树` 这类**规则说明文字**会被旧判据当成请求。',
  '· 交付物：可执行文件 + 源码 + 一条重建命令 + 一行运行说明。',
  '',
  '★ 本条是**席位回灌**（唤醒投递），不是用户输入。',
].join('\n')

/** 注入件清单：`kind` 覆盖真机上会出现的三种生产者 kind，`form` 取实测值 `notice`。 */
export const INJECT_CASES = [
  {
    tag: '19a 系统通知（子会话结束自动回灌，实测形状；改前 ⇒ 一票否决）',
    text: INJECTED_NOTICE,
    kind: 'computer-use',
    form: 'notice',
    oldHit: true,
  },
  {
    tag: '19b 同一份通知走**唤醒投递**的 kind（`runtime-context`）',
    text: INJECTED_NOTICE,
    kind: 'runtime-context',
    form: 'wake-main',
    oldHit: true,
  },
  {
    tag: '19c 同一份通知走**本插件自己的**注入 kind（`plugin:dsh-pipeline`）',
    text: INJECTED_NOTICE,
    kind: 'plugin:dsh-pipeline',
    form: 'stale-seat-notice',
    oldHit: true,
  },
  {
    tag: '20 席位回灌给主对话的**结论**（含 `read` / `grep` / `源码树`）',
    text: SEAT_REPLY,
    kind: 'runtime-context',
    form: 'wake-main',
    oldHit: true,
  },
]

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runSilentVetoInjectCheck() {
  const rec = createRecorder()
  const open = []

  {
    const { f, host } = await setupInterceptHost()
    open.push(f.h)
    const MAIN = f.agents.main
    const ORCH = 'silent-veto-inject-orch'
    f.h.tokens.mint({ taskId: f.taskId, role: 'orchestrator', agentId: ORCH, note: 'silent-veto-inject-check' })

    // ★★ 注入消息用**生产代码自己的构造器**造（`lib/hostmsg.js` 的 `hostMessage`）——
    //    这样"被扫的确实是注入通道产出的那种消息"，不是手搓的形状。
    const send = (agentId, messages) => host.emit('agent/pre-step', { agent: { id: agentId }, messages, turn: 1 })
    const asInjected = (c) =>
      hostMessage({
        text: c.text,
        kind: c.kind === 'plugin:dsh-pipeline' ? undefined : c.kind,
        form: c.form,
        taskId: f.taskId,
        role: 'main',
      })

    for (const c of INJECT_CASES) {
      const msg = asInjected(c)
      // ① 单独发（模拟：这一轮只有这一条注入消息）
      const rMain = await send(MAIN, [msg])
      // ② 与用户那一轮的其它消息一起发（模拟真实形状：注入 + 用户文字同轮）
      const rMix = await send(MAIN, [msg, { role: 'user', content: [{ type: 'text', text: '继续' }] }])
      // ③ 发给**席位**（同一份文本回灌到席位会话）
      const rOrch = await send(ORCH, [msg])
      const byFn = judgePrompt({ role: 'main', taskId: f.taskId, seat: null }, c.text)
      const pass =
        rMain?.kind === 'enter' && rMix?.kind === 'enter' && rOrch?.kind === 'enter' && byFn === null
      rec.add(
        '注入 / 回灌路径不被拦',
        `★★【${c.tag}】${c.text.split('\n').length} 行 / ${c.text.length} 字符（\`source.kind=${c.kind}\`、\`form=${c.form}\`）⇒ **放行**`,
        pass,
        `旧判据（实测）：${c.oldHit ? '**命中 ⇒ 一票否决 + 零留痕**' : '不命中'}\n` +
          `新：单独发 kind=${JSON.stringify(rMain?.kind)}　与用户文字同轮 kind=${JSON.stringify(rMix?.kind)}　发席位 kind=${JSON.stringify(rOrch?.kind)}　judgePrompt=${JSON.stringify(byFn)}\n` +
          `命中过的触发行（实测等价形状，前 3 条）：\n${indent(REAL_TRIGGER_LINES.slice(0, 3).join('\n'))}`,
      )
    }

    // ★ 三路汇总：注入路径**一条 reject 都不许有**
    const probes = []
    for (const c of INJECT_CASES) {
      const msg = asInjected(c)
      for (const id of [MAIN, ORCH]) probes.push({ c, r: await send(id, [msg]), id })
      probes.push({ c, r: await send(MAIN, [msg, { role: 'user', content: [{ type: 'text', text: '继续' }] }]), id: MAIN })
    }
    const rejects = probes.filter((p) => p.r?.kind === 'reject')
    rec.add(
      '注入 / 回灌路径不被拦',
      `★★ **凡经注入通道进来的运行时上下文，一律不得被 prompt 扫描一票否决**：${probes.length} 次探针（${INJECT_CASES.length} 类注入 × {单发 / 与用户同轮 / 发席位}）⇒ \`reject\` **${rejects.length} 次**`,
      probes.length > 0 && rejects.length === 0,
      rejects.length === 0
        ? '全部 enter ⇒ 因果链上"回灌消息被砍"这一环已断\n' +
          '实测对照：命中的注入消息 11 条，体量 36–309 行 / 2959–29496 字符（中位约 54 行 / 4000 字符）'
        : rejects.map((p) => `${p.id}: ${JSON.stringify(p.c.text.slice(0, 60))}`).join('\n'),
    )

    // ★★ 留痕要求（用户第 2 条）：**任何否决都必须有一行审计**。
    //   提示词缝对这三条路径**不产生任何否决** ⇒ 结构上不存在"拒绝了却没留痕"。
    //   真正还会拒的那条路是工具缝（真去读源码），它的审计在 `silent-veto-check.mjs` 的 C 组。
    rec.add(
      '注入 / 回灌路径不被拦',
      '★★ **绝不静默**：提示词缝对注入路径**零否决** ⇒ 不存在"被拦却没有留痕"的路径；剩下的否决面只有工具缝，而它**每条 deny 各落一行** `seam:tool-deny` 审计（含判据 / 命中位置 / 时间）',
      rejects.length === 0,
      `注入探针 ${probes.length} 次 ⇒ reject ${rejects.length} 次、提示词缝审计行 0 行（没有否决就没有"只拒绝不记录"）。\n` +
        '工具缝的"仍被拦 + 可见文案 + 审计行"证据见 `tests/silent-veto-check.mjs` 的 B 组（C 组语料 5 条）。',
    )
  }

  await closeFixtures(open)
  return {
    passed: rec.passed,
    total: rec.total,
    items: rec.items,
    text: renderSuite(
      'dsh-pipeline 注入路径自测（回归 19/20：回灌消息不得被 prompt 扫描一票否决）',
      '机制核心：collectPromptText(payload) 只读 messages[].content，**一个字节都不读 source** ⇒ 注入消息与用户输入同权（prompt-rules.js:73-81 → hook-prompt.js:81）。',
      rec,
    ),
  }
}

// 直接跑：`node tests/silent-veto-inject-check.mjs`
if (process.argv[1] !== undefined && /silent-veto-inject-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runSilentVetoInjectCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
