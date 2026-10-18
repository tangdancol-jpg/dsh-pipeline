// P2 小修批次回归（F28）：文案与返回字段四处小修，判据一处都没动。
/**
 * dsh-pipeline · F28：P2 小修批次自测
 * ============================================================================
 *     node tests/f28-p2-polish-check.mjs
 *
 * 四处**只改文案 / 返回字段**的小修，各自独立：
 *
 *   ① `pipeline_human_relay` 的「照抄给用户看」块：换行必须是**真实换行**；
 *      请求正文里误存成**字面 `\n` 两个字符**的转义，也要在展示层还原
 *      （存盘原文不动）。
 *   ② `pipeline_demo` 的 `confirm` 动作**必填** `round_index` + `human_request_id`：
 *      参数描述与 tool description 都要写明（改前只在 `round` 那条里提过）。
 *   ③ `pipeline_status` 的 `fields=[…]` 投影：点了不存在的字段要**附可用键清单**，
 *      并给「建议 fields / detail=summary」的提示；`task.json` 过大时全文路要提示体积。
 *   ④ 席位被拒文案补「允许的替代形态」（内联 `node --check`、只读命令、write/edit 工具）——
 *      **判据不许放宽**，所以这里同时断言"照旧被拒"。
 *
 * ★ 本套自包含：不读任何活体真单；夹具用临时目录，跑完即删。
 * ★ 不注册进 `run-all.mjs`、不改任何既有测试。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { callTool, createGuardFixture, disposeHarness } from './selftest-core.mjs'
import { makeTaskIndexEntry, scanCommandWithScripts, scanShellCommand } from '../lib/guard.js'
import { normalizeCopyText, renderHumanRelaySummary, renderHumanRequestCopy } from '../lib/store/human.js'
import { TASK_JSON_WARN_BYTES, taskJsonSizeHint } from '../lib/tools/status.js'
import { demoGate } from '../lib/guard/demo-gate.js'

const NL = String.fromCharCode(10)
const BACKSLASH = String.fromCharCode(92)
/** 字面「反斜杠 + n」两个字符（回归断言：结果文本里不许出现它）。 */
const LITERAL_NL = BACKSLASH + 'n'

function createRecorder() {
  const items = []
  return {
    items,
    add(group, name, pass, detail) {
      items.push({ group, name, pass: pass === true, detail: String(detail ?? '') })
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
    text() {
      const L = ['dsh-pipeline · F28：P2 小修批次（文案 / 返回字段，不动判据）', '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('', '【' + g + '】')
        }
        L.push('  ' + (it.pass ? '✓' : '✗') + ' ' + it.name)
        if (it.detail.length > 0) L.push(...it.detail.split(NL).map((l) => '      ' + l))
      }
      L.push('', '='.repeat(78), '总计：' + this.passed + '/' + this.total + ' 通过', '='.repeat(78))
      return L.join(NL)
    },
  }
}

/** 详情只留前几行，报告不被大段正文淹没。 */
const brief = (s, n = 4) => String(s ?? '').split(NL).slice(0, n).join(' / ')

/** 一份带"字面转义"的人工请求登记（模拟实测现场：多行文本被存成了字面 `\n`）。 */
function literalEscapeEntry() {
  return {
    request_id: 'HR-F28',
    handoff_id: 'H-F28',
    from_role: 'tester',
    reason_zh: '结论冲突',
    question_for_human:
      '下面这段给你过一眼：' + LITERAL_NL + LITERAL_NL + '1) 交付形态：一个可点的页面' + LITERAL_NL + '2) 验收标准：点一下有反馈。这样可以吗？',
    context_for_human: '第一行背景' + LITERAL_NL + '第二行背景',
    options: [
      { label: '方案 A' + LITERAL_NL + '（改动最小）', consequence: '改测试期望' + LITERAL_NL + '不用改实现' },
      { label: '方案 B', consequence: '语义更严，要补错误分支' },
    ],
    recommended: '方案 A' + LITERAL_NL + '（改动最小）',
    blocking: true,
    blocked_stage: '测试用例设计' + LITERAL_NL + '（边界值定不下来）',
    urgency: 'normal',
    decision_kind: 'choose_option',
    timeout_behavior: 'stay_blocked',
    timeout_at: null,
    confirm_code: 'HC-F28',
  }
}

/**
 * 跑 F28 自测。
 *
 * @returns {Promise<{passed:number,total:number,text:string,items:object[]}>}
 */
export async function runF28P2PolishCheck() {
  const rec = createRecorder()
  const f = await createGuardFixture({ stopAfter: 5 })
  try {
    // =======================================================================
    // ① pipeline_human_relay：照抄块用真实换行
    // =======================================================================
    {
      const G = '① relay 照抄块：真实换行（无字面 ' + LITERAL_NL + '）'
      const entry = literalEscapeEntry()

      rec.add(
        G,
        '纯函数 normalizeCopyText：字面 ' + LITERAL_NL + ' / 字面 CRLF 都还原成真实换行',
        normalizeCopyText('第一行' + LITERAL_NL + '第二行') === '第一行' + NL + '第二行' &&
          normalizeCopyText('a' + BACKSLASH + 'r' + BACKSLASH + 'n' + 'b') === 'a' + NL + 'b' &&
          normalizeCopyText(null) === '',
        JSON.stringify(normalizeCopyText('第一行' + LITERAL_NL + '第二行')),
      )

      const copy = renderHumanRequestCopy(entry)
      rec.add(
        G,
        '★ 照抄块**不含**字面反斜杠 n（两个字符）',
        copy.includes(LITERAL_NL) === false,
        brief(copy),
      )
      rec.add(
        G,
        '★ 照抄块含**真实换行**：被转义的多行正文按行铺开',
        copy.includes('给你过一眼：' + NL + NL + '1) 交付形态') && copy.includes(NL),
        brief(copy),
      )
      rec.add(
        G,
        '照抄块的既有要素一个不少（照抄这段 / 确认码 / 用户原文 / 可选方案）',
        copy.includes('照抄这段') && copy.includes('确认码：HC-F28') && copy.includes('2) 验收标准') && copy.includes('方案 B'),
        brief(copy),
      )

      const summary = renderHumanRelaySummary({ id: 'T-F28' }, entry)
      rec.add(
        G,
        '整段 relay 摘要同样无字面 ' + LITERAL_NL + '、有真实换行（含下一步调法）',
        summary.includes(LITERAL_NL) === false && summary.includes(NL) && summary.includes('pipeline_human_reply'),
        brief(summary),
      )

      // --- 集成：真提交一条带字面转义的请求 → 真转告 -----------------------
      const literalQuestion =
        '下面这段给你过一眼：' + LITERAL_NL + LITERAL_NL + '1) 交付形态：一个可点的页面' + LITERAL_NL + '2) 验收标准：点一下有反馈。这样可以吗？'
      const asked = await callTool(
        f.h,
        'pipeline_human_request',
        {
          task_id: f.taskId,
          reason_kind: 'conclusion_conflict',
          question_for_human: literalQuestion,
          context_for_human: '第一行背景' + LITERAL_NL + '第二行背景',
          options: [
            { label: '方案 A' + LITERAL_NL + '（改动最小）', consequence: '改测试期望' + LITERAL_NL + '不用改实现' },
            { label: '方案 B', consequence: '语义更严，要补错误分支' },
          ],
          recommended: '方案 A' + LITERAL_NL + '（改动最小）',
          blocking: true,
          blocked_stage: '测试用例设计' + LITERAL_NL + '（边界值定不下来）',
          urgency: 'normal',
          decision_kind: 'choose_option',
          timeout_behavior: 'stay_blocked',
          role_token: f.tokens.tester,
        },
        f.agents.tester,
      )
      const rid = asked.value?.request_id ?? ''
      rec.add(
        G,
        '集成前置：带字面转义的请求正常提交（没有因为转义被拒）',
        asked.denied !== true && rid.length > 0,
        brief(asked.text),
      )

      const relayed = await callTool(
        f.h,
        'pipeline_human_relay',
        { task_id: f.taskId, request_id: rid, role_token: f.tokens.main },
        f.agents.main,
      )
      const relaySummary = String(relayed.value?.summary ?? '')
      rec.add(
        G,
        '★★ 真实 relay 结果：无字面 ' + LITERAL_NL + '，转义的多行正文变成真实分行',
        relayed.denied !== true &&
          relaySummary.includes(LITERAL_NL) === false &&
          relaySummary.includes('给你过一眼：' + NL + NL + '1) 交付形态'),
        brief(relaySummary),
      )
      const stored = String(
        (f.h.store.peek(f.taskId)?.human_requests ?? []).find((r) => r.request_id === rid)?.question_for_human ?? '',
      )
      rec.add(
        G,
        '存盘原文**没有被改写**（只在展示层还原，不动数据）',
        stored.includes(LITERAL_NL) && stored === literalQuestion,
        brief(stored),
      )
    }

    // =======================================================================
    // ② pipeline_demo：confirm 的必填参数写进描述 / help
    // =======================================================================
    {
      const G = '② pipeline_demo：confirm 必填参数写进描述'
      const demoDef = f.h.byName.get('pipeline_demo')
      const desc = String(demoDef?.description ?? '')
      rec.add(
        G,
        '★ tool description 的 confirm 一条写明了必填 round_index + human_request_id',
        desc.includes('confirm') && desc.includes('human_request_id') && desc.includes('round_index') && desc.includes('必填'),
        brief(desc),
      )
      const props = demoDef?.parameters?.properties ?? demoDef?.parameters ?? {}
      const hid = String(props.human_request_id?.description ?? '')
      rec.add(
        G,
        '★ human_request_id 参数描述同时覆盖 round（软约束②）与 confirm（必填）',
        hid.includes('round') && hid.includes('confirm') && hid.includes('必填'),
        hid,
      )
      const ridx = String(props.round_index?.description ?? '')
      rec.add(
        G,
        'round_index 参数描述写明 confirm 必填',
        ridx.includes('confirm') && ridx.includes('必填'),
        ridx,
      )

      const fakeTask = {
        id: 'T-F28-DEMO',
        demo: {
          plan: { tier: 'L3', action: 'require' },
          rounds: [{ index: 1, digest: 'd1', ref: 'demo/a.html', human_request_id: 'HR-9' }],
          confirmed_at: null,
          confirm_request_id: null,
        },
        human_requests: [],
      }
      const g = demoGate(fakeTask)
      rec.add(
        G,
        '★ 闸门「下一步」的调法用真实参数名 human_request_id（改前写错成 request_id）',
        g.ok === false && g.error.includes('human_request_id: "HR-9"') && g.error.includes(', request_id: "HR-9"') === false,
        brief(g.error),
      )
      rec.add(
        G,
        '判据没变：未确认照旧被拦（DEMO_NOT_CONFIRMED）',
        g.ok === false && g.code === 'DEMO_NOT_CONFIRMED',
        String(g.code),
      )
    }

    // =======================================================================
    // ③ pipeline_status：fields 未知键给可用清单 + 全文体积提示
    // =======================================================================
    {
      const G = '③ pipeline_status：fields 可用键 + 体积提示'
      const big = Math.round(5.3 * 1024 * 1024)
      const bigHint = taskJsonSizeHint(big)
      rec.add(
        G,
        '纯函数 taskJsonSizeHint：5.3MB 给提示（含 task.json / fields / detail=summary）',
        bigHint.includes('5.3 MB') && bigHint.includes('task.json') && bigHint.includes('fields') && bigHint.includes('detail="summary"'),
        bigHint,
      )
      rec.add(
        G,
        '纯函数 taskJsonSizeHint：小文件与取不到体积都不提示（不加噪音）',
        taskJsonSizeHint(4096) === '' && taskJsonSizeHint(null) === '' && TASK_JSON_WARN_BYTES === 1024 * 1024,
        'threshold=' + TASK_JSON_WARN_BYTES,
      )

      const statusDef = f.h.byName.get('pipeline_status')
      const args = { task_id: f.taskId, role_token: f.tokens.main, fields: ['hash_gate', '不存在的字段'] }
      const res = await callTool(f.h, 'pipeline_status', args, f.agents.main)
      const text = String(statusDef.output.render(args, res.value)?.[0]?.text ?? '')
      let projected = null
      try {
        projected = JSON.parse(text)
      } catch {
        projected = null
      }
      rec.add(
        G,
        '★ 未知字段：返回里附 _available_fields 可用键清单',
        res.denied !== true &&
          projected !== null &&
          Array.isArray(projected._unknown_fields) &&
          projected._unknown_fields.includes('不存在的字段') &&
          Array.isArray(projected._available_fields) &&
          projected._available_fields.includes('hash_gate') &&
          projected._available_fields.includes('liveness'),
        text.slice(0, 400),
      )
      rec.add(
        G,
        '★ 未知字段：附「建议 fields / detail=summary」的提示',
        projected !== null &&
          typeof projected._hint === 'string' &&
          projected._hint.includes('fields') &&
          projected._hint.includes('detail="summary"'),
        String(projected?._hint ?? text).slice(0, 300),
      )
      rec.add(
        G,
        '投影既有语义没变：ok 永远在、点名的字段照给',
        projected !== null && projected.ok === true && projected.hash_gate !== undefined,
        text.slice(0, 200),
      )

      // --- 集成：全文路在 task.json 过大时给体积提示（不改真实任务数据）----
      const origTaskFile = f.h.store.taskFile
      const bigFile = join(f.h.projectRoot, 'f28-big-task.json')
      writeFileSync(bigFile, 'x'.repeat(TASK_JSON_WARN_BYTES + 1024), 'utf8')
      f.h.store.taskFile = () => bigFile
      try {
        const fullRes = await callTool(
          f.h,
          'pipeline_status',
          { task_id: f.taskId, role_token: f.tokens.main },
          f.agents.main,
        )
        const fullSummary = String(fullRes.value?.summary ?? '')
        rec.add(
          G,
          '★ 全文路（detail 缺省）在 task.json 过大时给出体积提示（不吃"默认路径逐字节不变"）',
          fullRes.denied !== true &&
            fullSummary.includes('task.json 已有') &&
            fullSummary.includes('detail="summary"') &&
            fullSummary.includes('fields'),
          brief(fullSummary.slice(-260), 6),
        )
        const briefRes = await callTool(
          f.h,
          'pipeline_status',
          { task_id: f.taskId, role_token: f.tokens.main, detail: 'summary' },
          f.agents.main,
        )
        rec.add(
          G,
          '紧凑档不重复劝（它本来就在省字节）',
          briefRes.denied !== true && String(briefRes.value?.summary ?? '').includes('task.json 已有') === false,
          brief(briefRes.value?.summary),
        )
      } finally {
        f.h.store.taskFile = origTaskFile
      }
    }

    // =======================================================================
    // ④ 席位被拒文案：补「允许的替代形态」，判据不放宽
    // =======================================================================
    {
      const G = '④ 拒绝文案：允许的替代形态（判据不放宽）'
      const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f28-guard-'))
      try {
        mkdirSync(join(root, 'src'), { recursive: true })
        writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1' + NL, 'utf8')
        const task = makeTaskIndexEntry({ taskId: 'T-F28-GUARD', projectRoot: root, pipelineDir: join(root, '.pipeline') })

        // (a) 命令执行的脚本正文里有被禁止的内容
        const badScript = join(root, 'f28-bad.ps1')
        writeFileSync(badScript, 'Set-Content "' + join(root, 'src', 'a.js') + '" x', 'utf8')
        const scriptMsg = String(scanCommandWithScripts('pwsh -File f28-bad.ps1', task, 'tester', {}) ?? '')
        rec.add(
          G,
          '★★ 脚本正文命中照旧被拒（判据一个字没放宽）',
          scriptMsg.includes('脚本正文') && scriptMsg.includes('被禁止的内容'),
          brief(scriptMsg),
        )
        rec.add(
          G,
          '★ 脚本正文拒绝文案给出替代形态：内联 node --check / 只读命令 / write-edit 工具',
          scriptMsg.includes('node --check') && scriptMsg.includes('只读命令') && scriptMsg.includes('write / edit'),
          brief(scriptMsg),
        )

        // (b) 角色不得通过 shell 修改项目文件
        const shellMsg = String(scanShellCommand('Set-Content "' + join(root, 'src', 'a.js') + '" x', task, 'tester', {}) ?? '')
        rec.add(
          G,
          '★★ 「不得通过 shell 修改项目文件」照旧被拒（判据一个字没放宽）',
          shellMsg.includes('不得通过 shell 修改项目文件'),
          brief(shellMsg),
        )
        rec.add(
          G,
          '★ 该拒绝文案也给出替代形态：只读命令 / node --check / write-edit 工具',
          shellMsg.includes('只读命令') && shellMsg.includes('node --check') && shellMsg.includes('write / edit'),
          brief(shellMsg),
        )
        // 反向对照：只读命令**没有被**新增的替代形态文案带歪（照旧放行）
        rec.add(
          G,
          '对照：只读命令仍放行（补的只是文案，不是新判据）',
          scanShellCommand('node --check -e "const a = 1"', task, 'tester', {}) === null,
          'node --check -e "const a = 1" ⇒ 放行',
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    // =======================================================================
    // ⑤ 与既有断言的一致性：relay 的既有要素还在（human-check 钉过的三句）
    // =======================================================================
    {
      const G = '⑤ 与既有断言一致'
      const copy = renderHumanRequestCopy(literalEscapeEntry())
      const summary = renderHumanRelaySummary({ id: 'T-F28' }, literalEscapeEntry())
      rec.add(
        G,
        'human-check 钉住的三句仍在（照抄这段 / 确认码 / 不要替用户选）',
        copy.includes('照抄这段') && copy.includes('确认码') && summary.includes('不要替用户选'),
        brief(summary),
      )
      rec.add(
        G,
        'relay 摘要仍给出下一步工具与参数（request_id / user_quote）',
        summary.includes('pipeline_human_reply') && summary.includes('user_quote'),
        brief(summary),
      )
    }
  } catch (err) {
    rec.add('!! 执行异常', '夹具执行中途抛出：' + String(err?.message ?? err), false, String(err?.stack ?? '').split(NL).slice(0, 6).join(NL))
  } finally {
    await disposeHarness(f.h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text(), items: rec.items }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF28P2PolishCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
