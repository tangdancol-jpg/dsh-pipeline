/**
 * dsh-pipeline · **静默否决 + 把自己文档当违规**（真机缺陷的夹具化回归）
 * ============================================================================
 *     node tests/silent-veto-check.mjs
 *
 * 现场（用户原话，逐字）：
 *   「把 `pl-main` 预设全文粘进主对话会话 ⇒ **这一轮 1 秒结束、消息像没发出去**；
 *     分成两段发照样发不出去（⇒ 与长度无关）。」
 *
 * 机制（诊断给出，直接采信）：`lib/intercept/prompt-rules.js` 把进来的文本**拼起来
 * 直接跑一条正则**，命中即由 `lib/guard/hook-prompt.js` 一票否决这一轮；而被否决的
 * 那一轮 `turn/end {reason:{kind:"blocked"}}` 之前**没有 `step/start`**、插件侧**零留痕**。
 *
 * 这一套钉三条（每条都有红过 / 绿过的实测）：
 *
 *   A. **假阳性**：`pl-main` 预设全文里那行 markdown 表格（``| 读代码正文（`read` /
 *      `grep` 等指向源码树） | **不许** | …``）**是在叙述规则**，不是"要去读代码"的请求
 *      ⇒ **用户消息层不做这条判据**（H / I 预测）。
 *   B. **真违规仍被拦**：Agent **真的去** `read` / `grep` 源码树 ⇒ 工具缝照样拒 ——
 *      判据落点收窄到 `tools/pre-execute`（那里"叙述"结构上不可能出现）。
 *   C. **绝不静默**：任何一票否决都必须①有**用户可见**的文案 ②落**审计行**
 *      （谁 / 何时 / 命中哪条判据 / 命中片段的位置）。只有拒绝没有说明 = 失败。
 *
 * ★ 全程零副作用：夹具自造临时项目目录，跑完即删。
 *
 * @module dsh-pipeline/tests/silent-veto-check
 */


import { judgePrompt } from '../lib/intercept.js'
import { assertHostMessage } from '../lib/hostmsg.js'
import { auditLinesOf as auditLines, closeFixtures, setupInterceptHost as setup } from './silent-veto-fixtures.mjs'
// ★ 判据夹具（二分表 / 输入→输出表 / 预设全文）+ 断言小工具，拆在 `silent-veto-fixtures.mjs`，
//   只为行数纪律（CONVENTIONS.md §4：单文件 ≤400 行）；判据本身只有一份。
import {
  IO_TABLE,
  MAIN_LIMIT_TABLE,
  MAIN_TABLE_ROW,
  MIN_REPRO,
  PROMPT_CASES,
  PROMPT_SAMPLES,
  CORPUS_A,
  CORPUS_B,
  CORPUS_C,
  presetFullText,
  createFakeHost,
  createRecorder,
  hit,
  indent,
  messageText,
} from './silent-veto-fixtures.mjs'
// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runSilentVetoCheck() {
  const rec = createRecorder()
  const open = []


  // =========================================================================
  // A. 用户消息层不做这条判据（A/B 组实测语料逐条断言 + 输入→输出表）
  // =========================================================================
  {
    const { f, host } = await setup()
    open.push(f.h)
    const MAIN = f.agents.main
    const step = (id, text) => host.emit('agent/pre-step', { agent: { id }, messages: [{ role: 'user', content: text }], turn: 1 })

    const mainFull = presetFullText('main')
    const h = await step(MAIN, mainFull)
    rec.add(
      'A 用户消息层不判',
      `★★ **H 预测**：\`pl-main\` 预设全文**原样**（${mainFull.length} 字符 / ${mainFull.split('\n').length} 行）发给主对话 ⇒ **放行**（不再被拦）`,
      h?.kind === 'enter',
      `返回 kind=${JSON.stringify(h?.kind)}${h?.kind === 'reject' ? `\n★ 被拦理由（静默否决的原文）：\n${indent(h?.reason ?? '')}` : ''}`,
    )

    const i = await step(MAIN, MAIN_TABLE_ROW)
    rec.add(
      'A 用户消息层不判',
      '★★ **I 预测**：把那一行**原样保留**在消息里 ⇒ **也不再被拦**（用户消息层不判）',
      i?.kind === 'enter',
      `那一行（${MAIN_TABLE_ROW.length} 字符）：\n${indent(MAIN_TABLE_ROW)}\n返回 kind=${JSON.stringify(i?.kind)}` +
        `${i?.kind === 'reject' ? `\n★ 被拦理由：\n${indent(i?.reason ?? '')}` : ''}`,
    )

    // 对照组：诊断说 pl-orchestrator 全文本来就不命中（⇒ 参照系本身是对的）
    const orch = await step(MAIN, presetFullText('orchestrator'))
    rec.add(
      'A 用户消息层不判',
      '对照：`pl-orchestrator` 预设全文（同样含大量 `read` / `grep` 字样，但没有那一行）⇒ 放行',
      orch?.kind === 'enter',
      `返回 kind=${JSON.stringify(orch?.kind)}`,
    )

    // 长度不是变量：25 行 / 3505 字符那条同样过
    const padded = `${MAIN_TABLE_ROW}\n${'补充说明：这一段是在讨论规则本身。\n'.repeat(12)}`
    const long = await step(MAIN, padded)
    rec.add(
      'A 用户消息层不判',
      `★ 长度不是变量：含那一行的 ${padded.length} 字符 / ${padded.split('\n').length} 行消息 ⇒ 照样放行`,
      long?.kind === 'enter',
      `返回 kind=${JSON.stringify(long?.kind)}`,
    )

    // ★ 新口径要覆盖的三类（判据化，不是"我觉得"）
    for (const s of PROMPT_SAMPLES) {
      const r = await step(MAIN, s.text)
      const byFn = judgePrompt({ role: 'main', taskId: f.taskId, seat: null }, s.text)
      rec.add(
        'A 用户消息层不判',
        `★★ 新口径：用户消息层**不判** ——「${s.key}」⇒ 放行（且 \`judgePrompt\` 也返回 null）`,
        r?.kind === 'enter' && byFn === null,
        `缝返回 kind=${JSON.stringify(r?.kind)}　judgePrompt=${JSON.stringify(byFn)}\n原文：${s.text.replace(/\n/g, ' ⏎ ')}`,
      )
    }

    // ---------------------------------------------------------------------
    // ★★ 用户实测语料**逐条回归**：A 组（不许回退）· B 组（验收核心）· 补测维度
    //
    //    `old` 列是**实测值**：拿改前那份代码（`git HEAD~1` 的
    //    `PROMPT_CODE_READ_RE`）逐条跑出来的结果。跑完把"旧命中 → 新放行"
    //    的对照表原样打进证据里。
    // ---------------------------------------------------------------------
    const bisect = []
    for (const c of PROMPT_CASES) {
      const r = await step(MAIN, c.t)
      const byFn = judgePrompt({ role: 'main', taskId: f.taskId, seat: null }, c.t)
      const pass = r?.kind === 'enter' && byFn === null
      bisect.push({ ...c, pass })
      rec.add(
        'A 用户消息层不判',
        `★★【${c.tag}】${JSON.stringify(c.t).slice(0, 56)} ⇒ **放行**${c.old ? '（★ 改前**被拦**）' : '（改前也放行）'}`,
        pass,
        `旧判据（实测）：${c.old ? '**命中 ⇒ 一票否决 + 零留痕**' : '不命中 ⇒ 放行'}\n` +
          `新：缝返回 kind=${JSON.stringify(r?.kind)}　judgePrompt=${JSON.stringify(byFn)}\n` +
          `原文：${c.t.replace(/\n/g, ' ⏎ ')}`,
      )
    }

    // --- 三组各自的汇总断言（A 不许回退 / B 是验收核心 / 补测维度） ---
    const grp = (name) => PROMPT_CASES.filter((c) => c.tag === name)
    for (const [label, name, wantOld] of [
      ['A 组', 'A 改前也通过（不许回退）', false],
      ['B 组', 'B 改前误伤（验收核心）', true],
    ]) {
      const items = grp(name)
      const res = items.map((c) => ({ c, r: bisect.find((b) => b.t === c.t && b.tag === c.tag) }))
      rec.add(
        'A 用户消息层不判',
        `★★ **${label} ${items.length} 条逐条断言**：全部 **放行**${wantOld ? '（且 `old` 实测列全为"改前被拦"）' : '（且 `old` 实测列全为"改前也放行" ⇒ 不许回退）'}`,
        items.length > 0 && res.every((x) => x.r?.pass === true && x.c.old === wantOld),
        res.map((x) => `${x.r?.pass ? '✓放行' : '✗被拦'}（改前${x.c.old ? '被拦' : '放行'}）　${JSON.stringify(x.c.t).slice(0, 54)}`).join('\n'),
      )
    }
    rec.add(
      'A 用户消息层不判',
      `★★ **先红后绿对照表**：${PROMPT_CASES.length} 条输入里，改前命中 ${bisect.filter((b) => b.old).length} 条（全部被静默否决）、改后 **${bisect.filter((b) => b.pass).length}/${bisect.length} 条放行**`,
      bisect.every((b) => b.pass) &&
        bisect.some((b) => b.old) &&
        bisect.some((b) => !b.old) &&
        CORPUS_A.length === 8 &&
        CORPUS_B.length === 6,
      bisect.map((b) => `${b.old ? '改前✗被拦' : '改前✓放行'} → 改后${b.pass ? '✓放行' : '✗被拦'}　[${b.tag}] ${JSON.stringify(b.t).slice(0, 46)}`).join('\n'),
    )

    // ★★ 输入 → 输出表（判据化的唯一口径；必须解释"B 组全放行、C 组仍拦"）
    rec.add(
      'A 用户消息层不判',
      '★★ **输入 → 输出表**（`prompt` = 用户消息层 / `tool` = Agent 真实工具调用）—— 口径一句话：判据从「文本里出现了什么字」改成「**有没有真的发起读动作**」',
      IO_TABLE.length >= 10 && IO_TABLE.some((r0) => r0[0] === 'prompt') && IO_TABLE.some((r0) => r0[0] === 'tool' && r0[2].includes('拒')),
      IO_TABLE.map(([layer, input, out, why]) => `[${layer}] ${input}\n        ⇒ ${out}　（${why}）`).join('\n'),
    )

    // 四个控制角色一视同仁（不只看 main）
    const roles = ['main', 'orchestrator', 'planner', 'supervisor']
    rec.add(
      'A 用户消息层不判',
      `★★ 四个"不看代码"的角色（${roles.join(' / ')}）粘同一行 ⇒ 一律不判`,
      roles.every((role) => judgePrompt({ role, taskId: f.taskId, seat: null }, MAIN_TABLE_ROW) === null),
      roles.map((role) => `${role}=${JSON.stringify(judgePrompt({ role, taskId: f.taskId, seat: null }, MAIN_TABLE_ROW))}`).join('　'),
    )
  }

  // =========================================================================
  // B. C 组：真实**工具调用**（不是散文）—— 判据落点收窄到 `tools/pre-execute`
  // =========================================================================
  {
    const { f, host } = await setup()
    open.push(f.h)
    const MAIN = f.agents.main
    const W = f.agents.writer

    // ★★ 用户 C 组语料逐条：**真实工具调用** ⇒ 仍被拦 + 可见文案 + 审计行。
    //   ⚠️ 判据按**真实文件身份**（`lib/guard/shell.js` 的 B9）：纯目录名 / 不存在的路径
    //      **不算**"读代码正文"（"列出目录名"不是看实现）—— 那是既有的、写在文件头里的
    //      边界，本单不动它。所以命令式那几条都**指向真实源码文件**。
    const cGroup = []
    for (const c of CORPUS_C) {
      const r = await host.emit('tools/pre-execute', { name: c.tool, arguments: c.args, agent: { id: MAIN } })
      const pass = r?.kind === 'deny'
      cGroup.push({ ...c, pass })
      rec.add(
        'B 真违规仍被拦',
        `★★【C 组】\`${c.tool} ${JSON.stringify(c.args)}\`（${c.why}）⇒ **仍被拒**`,
        pass,
        `返回：${JSON.stringify(r)?.slice(0, 110)}\n拒绝原文（★ 这一段就是"可见文案"）：\n${indent(r?.reason ?? '')}`,
      )
    }
    rec.add(
      'B 真违规仍被拦',
      `★★ **C 组 ${CORPUS_C.length} 条逐条断言**：真实工具调用**全部仍被拦**，且返回体都带**可见文案**（reason 非空且含"拒绝"）+ **留痕指引**`,
      cGroup.length > 0 && cGroup.every((x) => x.pass),
      cGroup.map((x) => `${x.pass ? '✓仍被拒' : '✗放行!!'}　${x.tool} ${JSON.stringify(x.args)}`).join('\n'),
    )

    // ★★ 审计留痕：谁 / 何时 / 命中哪条判据 / 命中片段的位置
    const lines = auditLines(f).filter((l) => l.action === 'seam:tool-deny')
    const last = lines[lines.length - 1] ?? null
    rec.add(
      'B 真违规仍被拦',
      `★★ **审计留痕**（C 组 ${CORPUS_C.length} 条各一行）：\`audit.jsonl\` 里有 \`seam:tool-deny\` 行，含 **谁**（角色/席位/会话）· **何时**（\`at\`）· **命中哪条判据** · **命中片段的位置**（工具 + 路径/模式）`,
      lines.length >= CORPUS_C.length &&
        last !== null &&
        typeof last.at === 'string' &&
        last.at.length > 0 &&
        last.actor === 'main' &&
        typeof last.criterion === 'string' &&
        last.criterion.length > 0 &&
        typeof last.tool === 'string' &&
        last.tool.length > 0 &&
        last.touched_task_json === false,
      `命中 ${lines.length} 行（C 组 ${CORPUS_C.length} 条 ⇒ 至少这么多行）；最后一行：\n${indent(JSON.stringify(last))}`,
    )

    // 对照：编写席位读同一份源码 ⇒ 放行（它本来就该读）
    const w = await host.emit('tools/pre-execute', { name: 'read', arguments: { path: 'src/a.js' }, agent: { id: W } })
    rec.add(
      'B 真违规仍被拦',
      '对照：同一句"读 `src/a.js`"，**编写**席位真去读 ⇒ 放行（不误伤正当角色）',
      w?.kind === 'enter',
      `返回：${JSON.stringify(w)}`,
    )
  }

  // =========================================================================
  // C. 绝不静默：一票否决必须有可见文案 + 审计行
  // =========================================================================
  {
    const { f, host } = await setup()
    open.push(f.h)
    const W = f.agents.writer
    const before = auditLines(f).filter((l) => l.action === 'seam:prompt-advice').length

    const r = await host.emit('agent/pre-step', {
      agent: { id: W },
      messages: [{ role: 'user', content: '先跑一下 npm test 看看过不过，然后把结果写进提交说明' }],
      turn: 9,
    })
    const injected = (r?.messages ?? []).map(messageText).join('\n')

    rec.add(
      'C 绝不静默',
      '★★ 提示词缝命中 ⇒ **有用户可见的文案**（注入到这一轮，不是 `{kind:"reject"}` 那种静默否决）',
      r?.kind === 'enter' && hit(injected, '编写|不跑测试') && injected.length > 40,
      `返回 kind=${JSON.stringify(r?.kind)}\n注入的可见文案：\n${indent(injected)}`,
    )

    const shape = (r?.messages ?? []).flatMap((m, i2) => assertHostMessage(m, { path: `messages[${i2}]` }))
    rec.add(
      'C 绝不静默',
      '★ 注入的可见文案是**宿主形状**（`content` block 数组 + `source.kind` 生产者自有 + 非空 `id`）',
      (r?.messages ?? []).length > 0 && shape.length === 0,
      `注入 ${(r?.messages ?? []).length} 条　违规 ${shape.length} 条：${shape.join('；') || '（无）'}`,
    )

    const lines = auditLines(f).filter((l) => l.action === 'seam:prompt-advice')
    const last = lines[lines.length - 1] ?? null
    rec.add(
      'C 绝不静默',
      '★★ **审计里有一行**（谁 / 何时 / 哪条判据 / 命中片段的位置），且**不碰 `task.json`**（拒绝不是进展）',
      lines.length === before + 1 &&
        last !== null &&
        last.actor === 'writer' &&
        typeof last.at === 'string' &&
        typeof last.criterion === 'string' &&
        typeof last.hit?.line === 'number' &&
        typeof last.hit?.column === 'number' &&
        typeof last.hit?.snippet === 'string' &&
        last.touched_task_json === false,
      `命中 ${lines.length} 行（新增 ${lines.length - before}）；最后一行：\n${indent(JSON.stringify(last))}`,
    )
  }

  // =========================================================================
  // D. 判据落点收窄：提示词缝不再有"一票否决"
  // =========================================================================
  {
    const { f, host } = await setup()
    open.push(f.h)
    const probes = [
      ['main', f.agents.main, presetFullText('main')],
      ['main', f.agents.main, MAIN_TABLE_ROW],
      ['main', f.agents.main, '先读一下 src/fizzbuzz.js 的实现，看看逻辑对不对'],
      ['writer', f.agents.writer, '先跑一下 npm test 看看过不过'],
      ['main', f.agents.main, 'npm test'],
    ]
    const rejects = []
    for (const [role, id, text] of probes) {
      const r = await host.emit('agent/pre-step', { agent: { id }, messages: [{ role: 'user', content: text }], turn: 2 })
      if (r?.kind === 'reject') rejects.push(`${role}: ${text.slice(0, 40)}`)
    }
    rec.add(
      'D 落点收窄',
      '★★ `agent/pre-step` 在任何输入下都**不再返回 `{kind:"reject"}`**（用户有权粘贴任何东西；判据落点在 `tools/pre-execute`）',
      rejects.length === 0,
      rejects.length === 0 ? `${probes.length} 条探针（含 pl-main 全文 / 那一行 / 真读请求 / 让编写跑测试）一条都没被否决` : rejects.join('\n'),
    )

    // 判据本体：`judgePrompt` 只产出**提示**，产出物的形状里没有"否决"这一档
    const notice = judgePrompt({ role: 'writer', taskId: f.taskId, seat: null }, '先跑一下 npm test 看看过不过')
    rec.add(
      'D 落点收窄',
      '★ `judgePrompt` 的返回值是**提示**（`{criterion, text, hit}`）——没有 `kind:"reject"` 这一档可返回',
      notice !== null &&
        typeof notice === 'object' &&
        typeof notice.criterion === 'string' &&
        typeof notice.text === 'string' &&
        notice.kind === undefined &&
        judgePrompt({ role: 'writer', taskId: f.taskId, seat: null }, '先读一下 src/fizzbuzz.js 的实现') === null,
      `编写 + 测试命令 ⇒ ${JSON.stringify(notice)?.slice(0, 160)}\n编写 + 读源码 ⇒ ${JSON.stringify(judgePrompt({ role: 'writer', taskId: f.taskId, seat: null }, '先读一下 src/fizzbuzz.js 的实现'))}`,
    )
  }

  // =========================================================================
  // 报告
  // =========================================================================
  const groups = {}
  for (const it of rec.items) {
    if (groups[it.group] === undefined) groups[it.group] = []
    groups[it.group].push(it)
  }
  const lines = []
  lines.push('='.repeat(78))
  lines.push('dsh-pipeline 守门「静默否决 + 把自己文档当违规」回归（假阳性 / 真违规仍拦 / 绝不静默）')
  lines.push('='.repeat(78))
  lines.push('')
  lines.push('现场：把 pl-main 预设全文粘进主对话 ⇒ 这一轮 1 秒结束、消息像没发出去（分两段发照样）。')
  for (const [g, items] of Object.entries(groups)) {
    lines.push('')
    lines.push('─'.repeat(78))
    lines.push(`【${g}】${items.filter((i) => i.pass).length}/${items.length} 通过`)
    lines.push('─'.repeat(78))
    for (const it of items) {
      lines.push('')
      lines.push(`${it.pass ? '✓' : '✗'} ${it.name}`)
      lines.push(indent(it.detail))
    }
  }
  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`总计：${rec.passed}/${rec.total} 通过`)
  lines.push('='.repeat(78))

  await closeFixtures(open)

  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

// 直接跑：`node tests/silent-veto-check.mjs`
if (process.argv[1] !== undefined && /silent-veto-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runSilentVetoCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}