/**
 * dsh-pipeline · 设计目的第 5、6 条自测：**双轨派活 + 改动基线 + 审核只读**
 * ============================================================================
 *     node tests/review-check.mjs
 *
 * 用户原话：
 *   「**审核 ai 要一起配合确认有没有多改**，分析和计划 ai 确认他们只干什么，
 *     然后**计划 ai 发任务给编程 ai 和审核 ai**，编程 ai 完成后测试 ai 跑测试，
 *     完成后给审核 ai，**审核 ai 确认没有干不该干的事（前后版本对比）**，
 *     **审核 ai 只读，只有属于他的日志文件有权限写入**」
 *
 * 拆成四条，本套逐条验：
 *   A. **双轨派活**：计划一出，writer 与 reviewer **同时**接任务；审核开工前就拿到
 *      授权面 / 越界清单 / 边界卡 / 改动基线。链路不变：编写 → 测试 → 才交审核。
 *   B. **改动基线**：派活那一刻记录（文件清单 + 哈希，**不复制源码**），
 *      绑定那次计划的 handoff id ⇒ 可证明就是那一刻的状态。
 *   C. **前后版本对比**：`pipeline_change_audit` 逐文件比，多改 / 少改 / 改错地方三类都报；
 *      审核的结论必须进 `review_verdict.change_audit`，且 store 会**自己重算核对**。
 *   D. **审核只读**：除 `reports/reviewer/*.log` 之外，任何位置都写不了。
 *
 * @module dsh-pipeline/tests/review-check
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { auditFor, callTool, cleanSecurity, createHarness, manifestFor } from './selftest-core.mjs'
import { createBoundaryFixture } from './boundary-check.mjs'

// ---------------------------------------------------------------------------
// 断言小工具（与其它套同形）
// ---------------------------------------------------------------------------

const indent = (s, n = 4) =>
  String(s ?? '')
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n')

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
  }
}

const hit = (text, fragment) =>
  String(fragment)
    .split('|')
    .some((a) => a.length > 0 && String(text).includes(a))

function expectDenied(rec, group, name, res, mustContain = []) {
  const ok = res.denied === true && res.layer !== 'missing'
  const missing = mustContain.filter((s) => !hit(res.text, s))
  const pass = ok && missing.length === 0
  rec.add(
    group,
    name,
    pass,
    pass
      ? `拦截层：${res.layer}\n拒绝原文：\n${indent(res.text)}`
      : `期望被拒但 denied=${res.denied} layer=${res.layer}` +
        (missing.length > 0 ? `\n缺少关键片段：${missing.join(' ｜ ')}` : '') +
        `\n实际原文：\n${indent(res.text)}`,
  )
  return pass
}

function expectOk(rec, group, name, res, mustContain = []) {
  const missing = mustContain.filter((s) => !hit(res.text, s))
  const pass = res.denied !== true && missing.length === 0
  rec.add(
    group,
    name,
    pass,
    pass
      ? `结果摘要：\n${indent(res.text)}`
      : `期望成功但被拒（layer=${res.layer}）${missing.length > 0 ? `，缺少：${missing.join(' / ')}` : ''}\n原文：\n${indent(res.text)}`,
  )
  return pass
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runReviewCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // A. 双轨派活：writer 与 reviewer 同时接任务
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)
    const t = f.h.store.peek(f.taskId)

    rec.add(
      'A 双轨派活',
      '（夹具）计划里已备齐四样：授权面 / 越界清单 / 边界卡 / 改动基线',
      Array.isArray(t.change_scope) &&
        Array.isArray(t.plan_forbidden) &&
        Array.isArray(t.role_boundaries) &&
        f.h.store.currentBaseline(t) !== null,
      `change_scope=${t.change_scope.length} 条\nplan_forbidden=${JSON.stringify(t.plan_forbidden)}\n` +
        `role_boundaries=${t.role_boundaries.map((b) => b.role).join('/')}\nbaseline=${f.h.store.currentBaseline(t)?.baseline_id}`,
    )

    // 留档（派活前置条件）—— 与真实流程同一条路
    const dA = await callTool(f.h, 'pipeline_dispatch', { task_id: f.taskId, role: 'archivist', spawn: false, role_token: f.tokens.main }, f.agents.main)
    expectOk(rec, 'A 双轨派活', '（前置）派出留档 AI', dA, ['已派出'])
    {
      const src = (t.records ?? []).find((x) => x.role === 'planner')
      const comp = await callTool(
        f.h,
        'pipeline_compile_requirement',
        {
          task_id: f.taskId,
          role_token: dA.value.token,
          entries: [
            { section: '需求原文', text: '给订单系统加导出：三层并行。', source_record: src.record_id },
            { section: '验收标准', text: '1. 三层各自可用 2. 审核通过', source_record: src.record_id },
          ],
        },
        dA.value.agent_id,
      )
      expectOk(rec, 'A 双轨派活', '（前置）需求档已汇总（开工条件）', comp, ['需求档已汇总'])
    }

    const stateBefore = f.h.store.peek(f.taskId).state
    const dW = await callTool(
      f.h,
      'pipeline_dispatch',
      { task_id: f.taskId, role: 'writer', seat: 'writer#1', spawn: false, role_token: f.tokens.main },
      f.agents.main,
    )
    expectOk(rec, 'A 双轨派活', '★ 派编写（第一轨）', dW, ['已派出'])

    const dR = await callTool(
      f.h,
      'pipeline_dispatch',
      { task_id: f.taskId, role: 'reviewer', spawn: false, role_token: f.tokens.main },
      f.agents.main,
    )
    expectOk(rec, 'A 双轨派活', '★★ 派审核（第二轨）—— **开工前**就派出，不是等产物到了才唤起', dR, ['已派出', '开工前简报'])
    for (const [what, frag] of [
      ['① 这次**授权了什么**（授权面）', '这次授权了什么'],
      ['② 这次**不许做什么**（越界清单）', '这次不许做什么'],
      ['③ 它的**边界卡**', '你的边界卡'],
      ['④ **改动基线**（前后版本对比的基准）', '改动基线'],
    ]) {
      rec.add('A 双轨派活', `★ 审核的开工前简报里带上了 ${what}`, hit(dR.text, frag), `找「${frag}」：${hit(dR.text, frag)}\n${indent(dR.text)}`)
    }
    rec.add(
      'A 双轨派活',
      '★ 简报里明说"**现在不要出审核结论**"（链路没变：编写 → 测试 → 才交审核）',
      hit(dR.text, '现在不要出审核结论') && hit(dR.text, '编写 → 测试'),
      `状态=${stateBefore}（派审核前后都不动）\n${indent(dR.text.split('\n').slice(-4).join('\n'))}`,
    )
    rec.add(
      'A 双轨派活',
      '★ 派审核**没有**把状态推到审核态（双轨是"提前知情"，不是"提前判定"）',
      f.h.store.peek(f.taskId).state === stateBefore,
      `状态：${stateBefore} → ${f.h.store.peek(f.taskId).state}`,
    )

    // 此刻审核**不能**出结论（状态机那道闸还在）
    const early = await callTool(
      f.h,
      'pipeline_handoff',
      {
        task_id: f.taskId,
        kind: 'review_verdict',
        role_token: dR.value.token,
        payload: {
          task_id: f.taskId,
          artifact_version: 'v1',
          conclusion: 'OK',
          risk_notes: [],
          release_approved: true,
          final_delivery_note: 'x',
          security: cleanSecurity(),
          change_audit: { baseline_id: f.h.store.currentBaseline(f.h.store.peek(f.taskId)).baseline_id, verdict: 'within_scope' },
        },
      },
      dR.value.agent_id,
    )
    expectDenied(rec, 'A 双轨派活', '★ 反例：双轨派活后审核**想提前出结论** → 状态机拒（链路不变）', early, ['跳步', '待审核|审核中'])
  }

  // =========================================================================
  // B. 改动基线：派活那一刻的状态，可证明、不复制源码
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)
    const t = f.h.store.peek(f.taskId)
    const base = f.h.store.currentBaseline(t)

    rec.add(
      'B 改动基线',
      '★ 基线在**计划产出那一刻**自动记录（不需要谁手动去取）',
      base !== null && typeof base.taken_at === 'string' && base.taken_by === 'planner',
      `baseline_id=${base?.baseline_id}\ntaken_at=${base?.taken_at}\ntaken_by=${base?.taken_by}`,
    )
    rec.add(
      'B 改动基线',
      '★ 可证明：绑定那次计划的 handoff id + 清单指纹（digest）',
      typeof base.plan_handoff_id === 'string' && base.plan_handoff_id.length > 0 && typeof base.digest === 'string' && base.digest.length > 0,
      `plan_handoff_id=${base.plan_handoff_id}\ndigest=${base.digest}\nfile_count=${base.file_count}`,
    )
    rec.add(
      'B 改动基线',
      '★ 只存**清单与哈希**，不复制源码（基线条目里没有文件正文）',
      (() => {
        const one = Object.entries(base.files ?? {})[0]
        if (one === undefined) return true // 夹具项目根是空的：本来就没有文件
        const body = JSON.stringify(one[1])
        return Object.keys(one[1]).sort().join(',') === 'bytes,sha256' && body.length < 200
      })(),
      `files 条目数=${Object.keys(base.files ?? {}).length}\n样例=${JSON.stringify(Object.entries(base.files ?? {})[0] ?? '(空)')}`,
    )
    rec.add(
      'B 改动基线',
      '★ 排除 `.pipeline/`：流水线自己的台账不算改动面',
      !Object.keys(base.files ?? {}).some((p) => p.toLowerCase().startsWith('.pipeline')),
      `基线里的路径：${Object.keys(base.files ?? {}).join('、') || '（空）'}`,
    )
    rec.add(
      'B 改动基线',
      '★ 基线落盘（.pipeline/<任务>/baseline-*.json），不只在内存里',
      typeof base.file === 'string' && existsSync(base.file),
      `baseline 文件：${base.file}`,
    )
  }

  // =========================================================================
  // C. 前后版本对比：多改 / 少改 / 改错地方
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)
    const T = f.taskId
    const root = f.h.projectRoot
    const baseline = f.h.store.currentBaseline(f.h.store.peek(T))

    // 造"编写干完活"的现场：授权面内一个 + 授权面外一个（多改）
    await mkdir(join(root, 'src/interface'), { recursive: true })
    await writeFile(join(root, 'src/interface/a.js'), '// 授权面内\n', 'utf8')
    await writeFile(join(root, 'src/sneaky.js'), '// 清单外，我顺手加的\n', 'utf8')

    const audit = await callTool(f.h, 'pipeline_change_audit', { task_id: T, role_token: f.tokens.main }, f.agents.main)
    expectOk(rec, 'C 前后版本对比', '★ 审核跑 `pipeline_change_audit`（哈希比对，不读代码）', audit, ['前后版本对比', '基线'])
    rec.add(
      'C 前后版本对比',
      '★ **多改**：清单外的文件被新增 → 报出来',
      audit.value?.verdict === 'out_of_scope' && (audit.value?.unauthorized ?? []).some((x) => x.path === 'src/sneaky.js'),
      `verdict=${audit.value?.verdict}\nunauthorized=${JSON.stringify(audit.value?.unauthorized)}`,
    )
    rec.add(
      'C 前后版本对比',
      '★ **少改**：授权了却一个都没动的条目 → 报出来',
      (audit.value?.missing ?? []).length > 0,
      `missing=${JSON.stringify(audit.value?.missing)}`,
    )
    rec.add(
      'C 前后版本对比',
      '★ 三类结论在摘要里都写明了（多改 / 少改 / 明细）',
      hit(audit.text, '多改') && hit(audit.text, '少改') && hit(audit.text, '明细'),
      indent(String(audit.text).split('\n').slice(0, 10).join('\n')),
    )

    // --- 改错地方：动的是"别人的那份"（授权面内但引用了别人的 scope_id）---
    {
      const payload = {
        task_id: T,
        artifact_version: 'v1',
        patch_or_code: 'x',
        change_note: 'x',
        run_commands: ['x'],
        selftest_result: 'x',
        known_issues: [],
        partition: { seat: 'writer#1', index: 1, total: 3, layer: 'interface', scope_paths: ['src/interface'] },
        change_manifest: [{ path: 'src/data/x.js', action: 'modify', scope_id: 'CS1', lines: 1 }],
      }
      const wrong = await callTool(f.h, 'pipeline_handoff', { task_id: T, kind: 'dev_to_test', role_token: f.tokens['writer#1'], payload }, f.agents['writer#1'])
      expectDenied(rec, 'C 前后版本对比', '★ **改错地方**：改动清单引用了**别人的**授权条目 → 拒', wrong, ['不在它引用的授权条目', '改动面必须与授权面相等'])
    }

    // --- 重取基线 ⇒ 干净现场 ⇒ within_scope ---
    const retake = await callTool(f.h, 'pipeline_change_audit', { task_id: T, take: true, note: '清理越界文件后重新基准', role_token: f.tokens.planner }, f.agents.planner)
    expectOk(rec, 'C 前后版本对比', '正例：计划 AI 可以**重取基线**（会留痕）', retake, ['已重新记录改动基线'])
    {
      const t = f.h.store.peek(T)
      const bad = await callTool(f.h, 'pipeline_change_audit', { task_id: T, take: true, role_token: f.tokens['writer#1'] }, f.agents['writer#1'])
      expectDenied(rec, 'C 前后版本对比', '反例：编写想**自己重设基线**（洗掉越界）→ 拒', bad, ['只有', '计划 AI'])
      void t
    }

    // 现在只剩授权面内的改动 → within_scope
    await writeFile(join(root, 'src/interface/a.js'), '// 改了一下（授权面内）\n', 'utf8')
    const clean = await callTool(f.h, 'pipeline_change_audit', { task_id: T, role_token: f.tokens.main }, f.agents.main)
    rec.add(
      'C 前后版本对比',
      '正例：只有授权面内的改动时 ⇒ **within_scope**（且列出 modified）',
      clean.value?.verdict === 'within_scope' && (clean.value?.unauthorized ?? []).length === 0,
      `verdict=${clean.value?.verdict}\n${indent(String(clean.text).split('\n').slice(9, 16).join('\n'))}`,
    )
    rec.add(
      'C 前后版本对比',
      '★ 摘要里直接给出可粘贴的 `change_audit`（审核不用自己拼）',
      hit(clean.text, 'change_audit = {') && hit(clean.text, String(clean.value?.baseline_id ?? '@@').slice(0, 6)),
      indent(String(clean.text).split('\n').slice(-2).join('\n')),
    )
  }

  // =========================================================================
  // C2. 审核的结论必须带对照结论，且 store 会自己重算核对
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)
    const T = f.taskId
    const root = f.h.projectRoot
    const base = f.h.store.currentBaseline(f.h.store.peek(T))

    const mk = (change_audit) => ({
      task_id: T,
      artifact_version: 'v1',
      conclusion: 'OK',
      risk_notes: [],
      release_approved: true,
      final_delivery_note: 'x',
      security: {
        attestation: 'clean',
        checked_by: 'reviewer',
        checks_ref: ['a.json'],
        local_leak: { checked: true, checks_ref: ['a.json'] },
        network: { checked: true, checks_ref: ['a.json'] },
        findings: [],
      },
      ...(change_audit === undefined ? {} : { change_audit }),
    })
    const submitViaStore = (payload) => f.h.store.submitHandoff({ taskId: T, kind: 'review_verdict', payload, actorRole: 'reviewer' })

    // ① 不交对照结论 → 拒
    {
      const r = await submitViaStore(mk(undefined))
      rec.add(
        'C 前后版本对比',
        '★ 反例① 有基线却不交 `change_audit` → 拒（不能只说"我看了没问题"）',
        r.ok !== true && hit(r.error, 'MISSING_CHANGE_AUDIT|前后版本对比结论') && hit(r.error, 'pipeline_change_audit'),
        `ok=${r.ok}\n${indent(r.error ?? '')}`,
      )
    }
    // ② baseline_id 过期 → 拒
    {
      const r = await submitViaStore(mk({ baseline_id: 'BL-STALE', verdict: 'within_scope' }))
      rec.add(
        'C 前后版本对比',
        '★ 反例② `baseline_id` 不是当前基线 → 拒（拿旧基线的结论审新状态等于没审）',
        r.ok !== true && hit(r.error, 'CHANGE_AUDIT_STALE|与当前基线'),
        `ok=${r.ok}\n${indent(r.error ?? '')}`,
      )
    }
    // ③ 结论与实测不符（伪造）→ 拒
    {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src/out-of-scope.js'), '// 我多改的\n', 'utf8')
      const r = await submitViaStore(mk({ baseline_id: base.baseline_id, verdict: 'within_scope' }))
      rec.add(
        'C 前后版本对比',
        '★ 反例③ `verdict` 与实测不符（把"有多改"填成 within_scope）→ 拒（store 自己重算）',
        r.ok !== true && hit(r.error, 'CHANGE_AUDIT_MISMATCH|实测'),
        `ok=${r.ok}\n${indent(r.error ?? '')}`,
      )
    }
    // ④ 如实填"有多改"但仍发 OK → 拒
    {
      const r = await submitViaStore(mk({ baseline_id: base.baseline_id, verdict: 'out_of_scope', unauthorized: ['src/out-of-scope.js'] }))
      rec.add(
        'C 前后版本对比',
        '★ 反例④ 如实报了"有多改"却仍发 OK → 拒（"确认没有干不该干的事"是发 OK 的前提）',
        r.ok !== true && hit(r.error, '有多改') && hit(r.error, 'pipeline_rework'),
        `ok=${r.ok}\n${indent(r.error ?? '')}`,
      )
    }
  }

  // =========================================================================
  // D. 审核只读：只有自己的日志文件可写
  // =========================================================================
  {
    const f = await createBoundaryFixture()
    open.push(f.h)
    const T = f.taskId
    const root = f.h.projectRoot
    // 夹具只造了 writer/tester/orchestrator/planner 的令牌 —— 这里补一枚审核的
    const revTok = f.h.tokens.mint({ taskId: T, role: 'reviewer', agentId: 'review-agent', note: 'review-check' })
    const tok = revTok.token
    const agent = 'review-agent'
    const w = (p, label) => callTool(f.h, 'write', { path: join(root, p), content: `${label}\n`, role_token: tok }, agent)

    // 正例：自己的日志
    expectOk(rec, 'D 审核只读', '★ 正例：写**自己的日志** `reports/reviewer/reviewer.log` → 放行', await w('.pipeline/' + T + '/reports/reviewer/reviewer.log', '审核日志'), ['放行|已执行'])

    // 反例：别的文件名 / 别人的目录 / 别处
    expectDenied(rec, 'D 审核只读', '★ 反例① 在**自己的日志目录**里放非日志文件名（reviewer.md）→ 拒', await w('.pipeline/' + T + '/reports/reviewer/reviewer.md', 'x'), ['只能写**自己那一片**', 'reports/reviewer', '只能写日志'])
    expectDenied(rec, 'D 审核只读', '★ 反例② 写 `reports/` 下**别的文件**（旧行为允许，现在不行）→ 拒', await w('.pipeline/' + T + '/reports/review-note.md', 'x'), ['只能写**自己那一片**'])
    expectDenied(rec, 'D 审核只读', '★ 反例③ 写**测试的报告**（reports/tester/…）→ 拒', await w('.pipeline/' + T + '/reports/tester/tester.log', 'x'), ['只能写**自己那一片**'])
    expectDenied(rec, 'D 审核只读', '★ 反例④ 写项目源码 → 拒', await w('src/interface/hack.js', 'x'), ['只能写**自己那一片**'])
    expectDenied(rec, 'D 审核只读', '★ 反例⑤ 写需求档（requirement.md）→ 拒', await w('.pipeline/' + T + '/requirement.md', 'x'), ['只能写**自己那一片**'])
    expectDenied(rec, 'D 审核只读', '★ 反例⑥ 写到**别的任务**目录 → 拒', await w('.pipeline/T-OTHER/reports/reviewer/reviewer.log', 'x'), ['只能写**自己那一片**'])

    // ★ 本轮追加：`tester` 也收紧成 `own-dir`（只写自己那一片）——
    //   用户原话「**测试 ai 等同理，没有权限动文件的就只能只读**」。
    {
      const tOwn = await callTool(
        f.h,
        'write',
        { path: join(root, '.pipeline', T, 'reports', 'tester', 'tester-report.md'), content: 'x', role_token: f.h.tokens.tester },
        f.agents.tester,
      )
      rec.add(
        'D 审核只读',
        '★ 对照：`tester` 写**自己那一片**（reports/tester/tester-report.md）→ 放行',
        tOwn.denied !== true,
        `layer=${tOwn.layer}\n${tOwn.text}`,
      )
      const tRoot = await callTool(
        f.h,
        'write',
        { path: join(root, '.pipeline', T, 'reports', 'test-report.md'), content: 'x', role_token: f.h.tokens.tester },
        f.agents.tester,
      )
      expectDenied(rec, 'D 审核只读', '★ 反例⑦ `tester` 写 reports/ **根下**（旧位置，现在不给）→ 拒', tRoot, ['只能写**自己那一片**'])
    }

    // 对照：控制角色（主对话 / 需求分析 / 计划）是**真只读** —— 连 reports/ 都不给
    for (const [who, tok, ag] of [
      ['主对话', f.h.tokens.main, f.agents.main],
      ['计划 AI', f.h.tokens.planner, f.agents.planner],
    ]) {
      const r = await callTool(
        f.h,
        'write',
        { path: join(root, '.pipeline', T, 'reports', 'anything.md'), content: 'x', role_token: tok },
        ag,
      )
      expectDenied(rec, 'D 审核只读', `★ 反例⑧ ${who} 是**真只读**（连 reports/ 也不给）→ 拒`, r, ['只读', '没有'])
    }
  }

  // =========================================================================
  // E. 总原则「不靠自然语言，靠代码层拦截」：全角色权限对齐 + 机器可读边界清单
  // =========================================================================
  {
    const { boundaryManifest } = await import('../lib/boundaries.js')
    const { writeClassOf } = await import('../lib/guard.js')
    const { ROLES } = await import('../lib/roles.js')
    const man = boundaryManifest()

    // --- ① 逐角色对账：角色表里的 writes 必须都能被守门认出来 ---
    rec.add(
      'E 代码层拦截',
      '★★ 全角色 `writes` 与守门**逐字节对齐**（没有"文档说只读、代码里还能写"的角色）',
      man.unmapped.length === 0 && Object.values(ROLES).every((r) => writeClassOf(r.id) !== null),
      `unmapped=${JSON.stringify(man.unmapped)}\n` +
        Object.values(ROLES)
          .map((r) => `  ${r.id}：writes=${r.writes} → 守门=${writeClassOf(r.id)}`)
          .join('\n'),
    )

    // --- ② 只有编写（与人工兜底）能写项目源码；其余一律"只写自己那一片"或"全只读" ---
    {
      const canWriteSource = Object.values(ROLES)
        .filter((r) => writeClassOf(r.id) === 'workdir')
        .map((r) => r.id)
        .sort()
      rec.add(
        'E 代码层拦截',
        '★ 能写项目源码的角色**只有** writer / human（其余全是只读或只写自己那一片）',
        canWriteSource.join(',') === 'human,writer',
        `实际可写源码的角色：${canWriteSource.join(' / ')}`,
      )
      const readOnly = Object.values(ROLES)
        .filter((r) => writeClassOf(r.id) === 'readonly')
        .map((r) => r.id)
        .sort()
      rec.add(
        'E 代码层拦截',
        '★ 控制角色（主对话 / 需求分析 / 计划）是**真只读**：一字节都不许写',
        readOnly.join(',') === 'main,orchestrator,planner',
        `只读角色：${readOnly.join(' / ')}`,
      )
    }

    // --- ③ 规则表：每条设计目的都指向代码里的判据（没有"只写在文档里"的）---
    rec.add(
      'E 代码层拦截',
      `★ 规则表里 ${man.rules.length} 条设计目的**全部**指向代码判据（class=a），没有一条是纯文档`,
      man.rules.length >= 6 && man.rules.every((r) => r.class === 'a' && String(r.enforce).length > 0),
      man.rules.map((r) => `  [${r.id}] ${r.zh}\n        判据：${r.enforce}`).join('\n'),
    )

    // --- ④ 诚实边界：判据化不了的必须如实列出来 ---
    rec.add(
      'E 代码层拦截',
      `★ 判据化不了的（**如实列出，不假装被执法**）：${man.advisory_limits.length} 条，每条都写了原因`,
      man.advisory_limits.length >= 5 && man.advisory_limits.every((x) => String(x.zh).length > 0 && String(x.why).length > 20),
      man.advisory_limits.map((x) => `  [${x.id}] ${x.zh}`).join('\n'),
    )

    // --- ⑤ 工具面：机器可读清单给别的执法层复用 ---
    {
      const h = await createHarness()
      open.push(h)
      const txt = await callTool(h, 'pipeline_boundaries', {}, 'boundaries-agent')
      expectOk(rec, 'E 代码层拦截', '★ 只读子命令 `pipeline_boundaries`：人读摘要', txt, ['总原则', '判据化不了', '无漂移'])
      const js = await callTool(h, 'pipeline_boundaries', { format: 'json' }, 'boundaries-agent')
      let parsed = null
      try {
        parsed = JSON.parse(String(js.value?.summary ?? ''))
      } catch {
        parsed = null
      }
      rec.add(
        'E 代码层拦截',
        '★ `format=json` 返回**可解析**的结构化清单（钩子层直接吃这个）',
        parsed !== null && Array.isArray(parsed.roles) && Array.isArray(parsed.rules) && Array.isArray(parsed.lists?.read_only_roles),
        parsed === null ? `不是合法 JSON：\n${String(js.value?.summary ?? '').slice(0, 300)}` : `roles=${parsed.roles.length} rules=${parsed.rules.length} read_only=${parsed.lists.read_only_roles.join('/')}`,
      )
      rec.add(
        'E 代码层拦截',
        '★ 清单里带**读禁 / 写禁 / 只写自己那一片**三张名单（钩子层不用读源码就能判）',
        parsed !== null &&
          parsed.lists.read_only_roles.length === 3 &&
          parsed.lists.own_log_roles.includes('reviewer') &&
          parsed.lists.own_dir_roles.includes('tester'),
        parsed === null ? '(无)' : JSON.stringify(parsed.lists),
      )
    }

    // --- ⑥ (b) 本轮做掉：在册角色必须交出它那一份 ---
    {
      const f = await createBoundaryFixture()
      open.push(f.h)
      const t = f.h.store.peek(f.taskId)
      const before = [...t.roster.execution_roles]
      t.roster.execution_roles = [...new Set([...before, 'release', 'docs', 'performance'])]
      // ⚠️ 这是**判据单测**，不是流程走查：直接调 `checkPrecondition` 验那一条闸。
      //    所以这里把状态摆到"关单前"（否则提交产物会先撞上状态闸，测的就不是这条判据了）。
      t.state = 'passed'
      const r1 = await f.h.store.checkPrecondition(t, 'role_products_delivered', {})
      rec.add(
        'E 代码层拦截',
        '★ 关单闸：在册的 release/docs/performance **没交产物** → 拒（以前只写在角色卡里）',
        r1.ok !== true && hit(r1.error, 'MISSING_ROLE_PRODUCT|发布与回滚计划'),
        `ok=${r1.ok}\n${indent(r1.error ?? '')}`,
      )
      // perf_report 的合法状态里**不含** passed（性能结论是发版前的东西），
      // 所以它要在 'reviewing' 交；交完再摆回 passed 验关单闸。
      t.state = 'reviewing'
      for (const [kind, actor, extra] of [
        ['release_plan', 'release', { steps: ['备份', '停流', '发版', '验活'], rollback: '回滚到上一版（保留旧制品 sha256，一条命令切回）' }],
        ['docs_note', 'docs', { summary: '使用说明已更新（README 的导出一节）' }],
        ['perf_report', 'performance', { baseline: 'p95 120ms（发版前）', measured: 'p95 118ms（发版后）', regression: false }],
      ]) {
        const sub = await f.h.store.submitHandoff({
          taskId: f.taskId,
          kind,
          payload: { task_id: f.taskId, artifact_version: 'v1', ...extra },
          actorRole: actor,
        })
        if (sub.ok !== true) console.log(`（夹具提示）${kind} 提交失败：${sub.error}`)
      }
      t.state = 'passed'
      const r2 = await f.h.store.checkPrecondition(t, 'role_products_delivered', {})
      rec.add(
        'E 代码层拦截',
        '★ 三份产物交齐之后 → 这一条**过**（同一条判据的正例）',
        r2.ok === true,
        `ok=${r2.ok}\n${indent(r2.error ?? '（通过）')}`,
      )
    }
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
  lines.push('dsh-pipeline 双轨派活 + 改动基线 + 前后版本对比 + 审核只读 自测')
  lines.push('='.repeat(78))
  lines.push('')
  lines.push('用户原话：计划 ai 发任务给编程 ai 和审核 ai；审核 ai 确认没有干不该干的事（前后版本对比）；')
  lines.push('          审核 ai 只读，只有属于他的日志文件有权限写入。')
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

  const { disposeHarness } = await import('./selftest-core.mjs')
  for (const h of open) {
    try {
      await disposeHarness(h)
    } catch {
      /* 清不掉不影响结论 */
    }
  }

  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

// 直接跑：`node tests/review-check.mjs`
if (process.argv[1] !== undefined && /review-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runReviewCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
