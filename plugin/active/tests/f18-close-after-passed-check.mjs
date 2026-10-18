// 缺陷 ⑬ 回归：审核通过（passed）后，关单前必须补齐的那几票（安全独立结论 / 性能结论）要交得上去。
/**
 * dsh-pipeline · F18：passed 上补交关单必需的交接物
 * ============================================================================
 *     node tests/f18-close-after-passed-check.mjs
 *
 * 现场（L5）：审核给了 OK ⇒ 状态到 passed ⇒ 安全位再交 security_review 被
 * 「跳步：交接物「security_review」只能在这些状态下提交 …」拒；而关单闸又要求 L3+ 必须有一份
 * security_review ⇒ 两个各自合理的判据把唯一出口夹死。现存绕法是主管"流程性打回"，会污染打回计数。
 * 同一张表里 perf_report 也不含 passed，而 L5 关单同样要求它（role_products_delivered）。
 *
 * 钉住：
 *   ⑬-A passed 上交 security_review 不再被拒，且关单闸 security_not_blocked 取得到它
 *   ⑬-A′ 同类项：passed 上交 perf_report 不再被拒，关单闸 role_products_delivered 取得到它
 *   ⑬-B 反向：终态（closed / cancelled）上照旧不许交
 *   ⑬-C 不需要打回绕行：全程没有打回记录，打回计数不动
 */

import { pathToFileURL } from 'node:url'

import { createHarness, disposeHarness } from './selftest-core.mjs'

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
      const L = ['dsh-pipeline · F18：passed 上补交关单必需的交接物（缺陷 ⑬）', '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('', `【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(`      ${it.detail.split('\n').join('\n      ')}`)
      }
      L.push('', '='.repeat(78), `总计：${this.passed}/${this.total} 通过`, '='.repeat(78))
      return L.join('\n')
    },
  }
}

/** 一张 L5、停在指定状态的任务（直接摆状态：本套只验"这个状态能不能交"，不验前面怎么走到这里）。 */
async function taskAt(h, id, state) {
  const opened = await h.store.open({ actorRole: 'main', requirement: `F18 夹具：L5 任务停在 ${state}。`, id })
  if (opened.ok !== true) throw new Error(`开单失败：${opened.error}`)
  const t = h.store.peek(id)
  t.state = state
  t.roster = { ...(t.roster ?? {}), tier: 'L5', execution_roles: ['writer', 'tester', 'reviewer', 'security', 'performance'] }
  return t
}

const securityReview = (h, id) =>
  h.store.submitHandoff({ taskId: id, kind: 'security_review', actorRole: 'security', actorAgentId: 'f18-sec', payload: { task_id: id, findings: ['未发现阻断项（F18 夹具）'], severity: 'none', blocked: false } })
const perfReport = (h, id) =>
  h.store.submitHandoff({ taskId: id, kind: 'perf_report', actorRole: 'performance', actorAgentId: 'f18-perf', payload: { task_id: id, baseline: '120ms', measured: '118ms', regression: false } })

export async function runF18CloseAfterPassedCheck() {
  const rec = createRecorder()
  const h = await createHarness({})
  try {
    {
      const G = '⑬-A passed 上补交安全独立结论'
      const t = await taskAt(h, 'T-F18A', 'passed')
      const before = await h.store.checkPrecondition(t, 'security_not_blocked')
      rec.add(G, '夹具：补交之前关单闸确实缺这一票（MISSING_SECURITY_REVIEW）', before.ok !== true && before.code === 'MISSING_SECURITY_REVIEW', before.code)
      const r = await securityReview(h, 'T-F18A')
      rec.add(G, '★★ passed 上交 security_review ⇒ 不再被 HANDOFF_STEP_SKIPPED 拒', r.ok === true, r.ok === true ? '' : `${r.code}\n${String(r.error).split('\n')[0]}`)
      const t2 = h.store.peek('T-F18A')
      const after = await h.store.checkPrecondition(t2, 'security_not_blocked')
      rec.add(G, '★★ 关单闸 security_not_blocked 取得到这一份 ⇒ 放行', after.ok === true, after.code ?? 'ok')
      rec.add(G, '★ 交了也不推状态（仍在 passed）', t2.state === 'passed', t2.state)
    }

    {
      const G = '⑬-A′ 同类项：passed 上补交性能结论'
      const t = await taskAt(h, 'T-F18P', 'passed')
      const before = await h.store.checkPrecondition(t, 'role_products_delivered')
      rec.add(G, '夹具：补交之前关单闸确实缺性能结论（MISSING_ROLE_PRODUCT）', before.ok !== true && before.code === 'MISSING_ROLE_PRODUCT', before.code)
      const r = await perfReport(h, 'T-F18P')
      rec.add(G, '★★ passed 上交 perf_report ⇒ 不再被拒', r.ok === true, r.ok === true ? '' : `${r.code}\n${String(r.error).split('\n')[0]}`)
      const after = await h.store.checkPrecondition(h.store.peek('T-F18P'), 'role_products_delivered')
      rec.add(G, '★ 关单闸 role_products_delivered 取得到它 ⇒ 放行', after.ok === true, after.code ?? 'ok')
    }

    {
      const G = '⑬-B 反向：终态照旧不许交'
      for (const s of ['closed', 'cancelled']) {
        await taskAt(h, `T-F18-${s}`, s)
        const r = await securityReview(h, `T-F18-${s}`)
        rec.add(G, `★★ ${s} 上交 security_review ⇒ 拒`, r.ok !== true, `${r.code ?? 'ok'}`)
        const r2 = await perfReport(h, `T-F18-${s}`)
        rec.add(G, `★ ${s} 上交 perf_report ⇒ 拒`, r2.ok !== true, `${r2.code ?? 'ok'}`)
      }
    }

    {
      const G = '⑬-C 不需要打回绕行'
      const t = h.store.peek('T-F18A')
      const reworks = (t.history ?? []).filter((e) => /rework|reject_review/.test(String(e.action)))
      rec.add(G, '★ 全程没有打回记录，打回计数不动', reworks.length === 0 && (t.rework?.dev ?? 0) === 0 && (t.rework?.test ?? 0) === 0, JSON.stringify({ reworks: reworks.map((e) => e.action), rework: t.rework }))
    }

    {
      // ★★ 2026-10-18 测试报告 P1-6：关单失败要**一次列全**所有缺口（改前一次只报一个，
      //    主对话要往返 3 轮、每轮新派一个席位等 3–10 分钟）。
      const G = '⑬-D 关单缺口一次列全'
      const t = await taskAt(h, 'T-F18G', 'passed')
      const gaps = await h.store.closeGaps(t)
      rec.add(
        G,
        '★★ `store.closeGaps` 一次返回**全部**缺口（不早退、顺序与 close_gates 一致）',
        gaps.length >= 3 && gaps.every((g) => typeof g.code === 'string' && g.code.length > 0),
        `缺口 ${gaps.length} 项：${gaps.map((g) => `[${g.code}]`).join(' ')}`,
      )
      const tok = h.tokens.mint({ taskId: 'T-F18G', role: 'main', agentId: 'f18-main', note: 'f18-close-gaps' })
      const dry = await h.byName.get('pipeline_close').execute({ task_id: 'T-F18G', dry_run: true, role_token: tok.token }, { agent: { id: 'f18-main' } })
      const summary = String(dry?.summary ?? '')
      rec.add(
        G,
        '★★ `pipeline_close { dry_run: true }` 返回完整缺口清单（`完整缺口清单` + 逐项 code）',
        dry?.ok !== true && summary.includes('完整缺口清单') && summary.includes(dry?.summary?.match(/\[[A-Z_]+\]/)?.[0] ?? '\u0000'),
        summary.split('\n').slice(0, 4).join('\n'),
      )
      const after = h.store.peek('T-F18G')
      rec.add(G, '★ dry_run **不改状态、不写 close_report**', after.state === 'passed' && (after.close_report === undefined || after.close_report === null), `state=${after.state} close_report=${String(after.close_report)}`)
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF18CloseAfterPassedCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
