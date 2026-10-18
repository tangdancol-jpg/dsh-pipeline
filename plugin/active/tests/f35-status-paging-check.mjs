// P2-13 第一步回归：`pipeline_status` 大对象分页 + 存储体积诊断（只读，不动盘上数据）。
/**
 * dsh-pipeline · F35：status 分页 + 存储体积诊断
 * ============================================================================
 *     node tests/f35-status-paging-check.mjs
 *
 * 现场：长单的 `task.json` 到 MB 级，`pipeline_status` 一次把
 * `handoffs` / `history` / `dispatch_slots` / `human_requests` 全倒出来 ——
 * 既慢又贵，而且没有"这段之外还有多少、下一段怎么取"的口径。
 *
 * 本套钉住（P2-13 第一步的三条边界）：
 *   A **只在显式给 `page` 时才分页**：不传 page ⇒ 正文与改前逐字节一致（两次调用对比）、
 *     分页段字段一律 null、正文不出 `_pagination`；
 *   B 分页正确：总数 / 页数 / 页内条数 / 越界空数组（不报错）/ `page_size` 夹到 [1,200] /
 *     `_pagination` 信封字段逐字齐全 / 主对话仍能"照抄调用形状"；
 *   C 存储体积诊断：`storage` 块字段齐、`task_json_bytes` 取得对、`>1MiB` 给 hint；
 *   D 紧凑档**只加一行**存储摘要、不撑体积（且比全文档明显小）。
 *
 * ★ 本套用真实 harness 任务（L0，停在 testing），**在内存里**加几条假账目来看分页；
 *   `audit.jsonl` 的追加只发生在临时目录里 —— 不碰任何真实任务。
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { callTool, createGuardFixture, disposeHarness } from './selftest-core.mjs'
import {
  STORAGE_HINT_BYTES,
  STATUS_PAGE_SIZE_DEFAULT,
  STATUS_PAGE_SIZE_MAX,
  formatBytes,
  normalizePaging,
  pageWindowOf,
  renderStorageBriefLine,
} from '../lib/tools/status.js'

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
      const L = ['dsh-pipeline · F35：pipeline_status 分页 + 存储体积诊断（P2-13 第一步）', '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('', `【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(...it.detail.split('\n').map((l) => `      ${l}`))
      }
      L.push('', '='.repeat(78), `总计：${this.passed}/${this.total} 通过`, '='.repeat(78))
      return L.join('\n')
    },
  }
}

const bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8')
const firstLine = (s) => String(s ?? '').split('\n')[0]

/** 在内存里给任务加几条"假账目"，好让分页真的有东西可分（不动盘上数据、不碰真实任务）。 */
function enrichTask(h, taskId) {
  const t = h.store.peek(taskId)
  const baseAt = '2026-10-19T00:00:00Z'
  if (!Array.isArray(t.handoffs)) t.handoffs = []
  const before = t.handoffs.length
  for (let i = 1; i <= 24; i += 1) {
    t.handoffs.push({
      handoff_id: `H-F35-${String(i).padStart(4, '0')}`,
      kind: 'fixture_note',
      kind_zh: '夹具记录',
      from_role: 'writer',
      to_role: 'main',
      created_at: baseAt,
      artifact_version: null,
      payload: { note: `第 ${i} 条` },
    })
  }
  if (!Array.isArray(t.human_requests)) t.human_requests = []
  for (let i = 1; i <= 7; i += 1) {
    t.human_requests.push({
      request_id: `HR-F35-${i}`,
      from_role: 'writer',
      created_at: baseAt,
      reason_kind: 'approval_needed',
      reason_zh: '需要人审批',
      question_for_human: `夹具问题 ${i}？`,
      blocking: false,
      blocked_stage: '',
      urgency: 'normal',
      decision_kind: 'yes_no',
      status: 'answered',
      relayed_at: baseAt,
      answered_at: baseAt,
      answer_source: 'user',
      resolved_at: baseAt,
      timeout_at: null,
      timeout_behavior: 'stay_blocked',
      state_at_request: 'testing',
      escalated_from: null,
      raised_by: null,
      orchestrator_reason: null,
    })
  }
  if (!Array.isArray(t.history)) t.history = []
  for (let i = 1; i <= 24; i += 1) {
    t.history.push({ at: baseAt, actor: 'main', action: `fixture:${i}`, note: `第 ${i} 条` })
  }
  if (!Array.isArray(t.dispatch_slots)) t.dispatch_slots = []
  for (let i = 1; i <= 23; i += 1) {
    t.dispatch_slots.push({ role: 'writer', seat: `writer#${i}`, effective: { permission: 'workspace-write' }, at: baseAt })
  }
  return { handoffs: t.handoffs.length, human_requests: t.human_requests.length, history: t.history.length, dispatch_slots: t.dispatch_slots.length, handoffsBefore: before }
}

/**
 * 跑 F35 自测。
 *
 * @returns {Promise<{passed:number,total:number,text:string,items:object[]}>}
 */
export async function runF35StatusPagingCheck() {
  const rec = createRecorder()
  const f = await createGuardFixture({ stopAfter: 5 })
  const taskId = f.taskId
  try {
    // =====================================================================
    // 0 纯函数：分页参数归一 + 切段（不依赖任何夹具）
    // =====================================================================
    {
      const G = '0 纯函数：分页参数与切段'
      rec.add(
        G,
        '★ `normalizePaging`：不给 page ⇒ enabled=false；默认 page_size=20',
        normalizePaging({}).enabled === false && normalizePaging({}).page === 1 && normalizePaging({}).page_size === STATUS_PAGE_SIZE_DEFAULT,
        JSON.stringify(normalizePaging({})),
      )
      rec.add(
        G,
        '★ `page_size` 夹到 [1,200]；非法 page 归一为 1（越界在切段处报，不在这里报错）',
        normalizePaging({ page: 2, page_size: 999 }).page_size === STATUS_PAGE_SIZE_MAX &&
          normalizePaging({ page: 2, page_size: 0 }).page_size === 1 &&
          normalizePaging({ page: -3 }).page === 1 &&
          normalizePaging({ page: 'abc' }).page === 1 &&
          normalizePaging({ page: 3, page_size: 10 }).enabled === true,
        JSON.stringify({ big: normalizePaging({ page: 2, page_size: 999 }), zero: normalizePaging({ page: 2, page_size: 0 }), neg: normalizePaging({ page: -3 }) }),
      )
      const arr = Array.from({ length: 25 }, (_, i) => i + 1)
      const p3 = pageWindowOf(arr, 3, 10)
      rec.add(
        G,
        '★ `pageWindowOf`：第 3 页（page_size=10）⇒ 后 5 条，total_items=25、total_pages=3',
        p3.slice.length === 5 && p3.slice[0] === 21 && p3.total_items === 25 && p3.total_pages === 3 && p3.out_of_range === false,
        JSON.stringify(p3),
      )
      const p4 = pageWindowOf(arr, 4, 10)
      rec.add(
        G,
        '★ **页码越界**：返回空数组 + `out_of_range=true`（**不报错**）',
        p4.slice.length === 0 && p4.out_of_range === true && p4.total_pages === 3,
        JSON.stringify(p4),
      )
      rec.add(
        G,
        '★ `formatBytes` 可读（B / KB / MB）',
        formatBytes(512) === '512 B' && formatBytes(2048) === '2.0 KB' && formatBytes(3 * 1024 * 1024) === '3.0 MB',
        [formatBytes(512), formatBytes(2048), formatBytes(3 * 1024 * 1024)].join(' / '),
      )
      rec.add(
        G,
        '★ `renderStorageBriefLine` 是**一行**（紧凑档不撑体积）',
        typeof renderStorageBriefLine({ task_json_bytes: 1024, handoff_count: 1, history_count: 2, audit_lines: 3 }) === 'string' &&
          !renderStorageBriefLine({ task_json_bytes: 1024, handoff_count: 1, history_count: 2, audit_lines: 3 }).includes('\n'),
        renderStorageBriefLine({ task_json_bytes: 1024, handoff_count: 1, history_count: 2, audit_lines: 3 }),
      )
    }

    // 给任务补一些假账目（内存里；只为让分页有东西可分）
    const counts = enrichTask(f.h, taskId)
    // 审计日志：往临时目录的 audit.jsonl 追加几行（只影响本夹具）
    const auditFile = f.h.store.auditFile(taskId)
    for (let i = 1; i <= 24; i += 1) {
      appendFileSync(auditFile, JSON.stringify({ at: '2026-10-19T00:00:00Z', actor: 'main', action: `fixture:audit:${i}`, note: `第 ${i} 行` }) + '\n', 'utf8')
    }
    const auditTotal = 13 + 24 // 夹具自带 13 行 + 追加的 24 行

    const call = (args) => callTool(f.h, 'pipeline_status', { task_id: taskId, role_token: f.tokens.main, ...args }, f.agents.main)
    const isNullish = (v) => v === null || v === undefined

    // =====================================================================
    // A 不传 page：正文与改前一致（两次调用对比）、分页字段全 null
    // =====================================================================
    {
      const G = 'A 不传 page：不分页、与改前一致'
      const a1 = await call({})
      const a2 = await call({})
      const s1 = String(a1.value?.summary ?? '')
      const s2 = String(a2.value?.summary ?? '')
      rec.add(
        G,
        '★★ 不传 page：同一任务两次调用**逐字节相同**（稳定复现）',
        a1.denied !== true && s1.length > 0 && s1 === s2,
        `sha 长度 ${bytes(s1)} B；两次相等=${s1 === s2}`,
      )
      rec.add(
        G,
        '★★ 不传 page：**没有任何 `_pagination` 脚注**（正文与改前一致）',
        !s1.includes('_pagination') && !s1.includes('本段为空 —— 页码越界'),
        s1.split('\n').filter((l) => l.includes('pagination') || l.includes('越界')).join('\n') || '（无）',
      )
      rec.add(
        G,
        '★★ 不传 page：分页段的结构化字段一律 null（不偷偷回全量/半量）',
        isNullish(a1.value?.handoffs) &&
          isNullish(a1.value?.history) &&
          isNullish(a1.value?.dispatch_slots) &&
          isNullish(a1.value?.human_requests) &&
          isNullish(a1.value?.audit) &&
          isNullish(a1.value?._pagination) &&
          isNullish(a1.value?.total_handoffs),
        JSON.stringify({
          handoffs: a1.value?.handoffs,
          history: a1.value?.history,
          dispatch_slots: a1.value?.dispatch_slots,
          human_requests: a1.value?.human_requests,
          _pagination: a1.value?._pagination,
        }),
      )
      rec.add(
        G,
        '★ 不传 page：交接物**全量**列出（改前行为），条数与 storage.handoff_count 一致',
        s1.includes(`交接物（${counts.handoffs} 份）`) &&
          s1.split('\n').filter((l) => l.includes('→main') || l.includes('→')).length >= counts.handoffs,
        `交接物行数=${s1.split('\n').filter((l) => l.includes('[')).length}，storage=${a1.value?.storage?.handoff_count}`,
      )
    }

    // =====================================================================
    // B 显式给 page：分页正确 / 页数 / 越界 / page_size / 审计
    // =====================================================================
    {
      const G = 'B 显式 page：分页正确 + 越界不报错'
      const p1 = await call({ page: 1, page_size: 10 })
      const v1 = p1.value ?? {}
      const pg1 = v1._pagination ?? {}
      rec.add(
        G,
        '★★ 第 1 页：四个大对象都只回**本段**（≤10 条），且回带 total_*',
        p1.denied !== true &&
          Array.isArray(v1.handoffs) && v1.handoffs.length === 10 &&
          Array.isArray(v1.human_requests) && v1.human_requests.length === Math.min(10, counts.human_requests) &&
          Array.isArray(v1.history) && v1.history.length === 10 &&
          Array.isArray(v1.dispatch_slots) && v1.dispatch_slots.length === 10 &&
          v1.total_handoffs === counts.handoffs &&
          v1.total_history === counts.history &&
          v1.total_dispatch_slots === counts.dispatch_slots &&
          v1.total_human_requests === counts.human_requests,
        JSON.stringify({ handoffs: v1.handoffs?.length, human: v1.human_requests?.length, history: v1.history?.length, slots: v1.dispatch_slots?.length, totals: [v1.total_handoffs, v1.total_human_requests, v1.total_history, v1.total_dispatch_slots] }),
      )
      const expectRec = (section, win) =>
        pg1[section]?.section === section &&
        pg1[section]?.page === win.page &&
        pg1[section]?.page_size === win.page_size &&
        pg1[section]?.total_pages === win.total_pages &&
        pg1[section]?.total_items === win.total_items
      rec.add(
        G,
        '★★ `_pagination` 每段一条，字段**逐字齐全**：section / page / page_size / total_pages / total_items',
        expectRec('handoffs', { page: 1, page_size: 10, total_pages: Math.ceil(counts.handoffs / 10), total_items: counts.handoffs }) &&
          expectRec('human_requests', { page: 1, page_size: 10, total_pages: Math.ceil(counts.human_requests / 10), total_items: counts.human_requests }) &&
          expectRec('history', { page: 1, page_size: 10, total_pages: Math.ceil(counts.history / 10), total_items: counts.history }) &&
          expectRec('dispatch_slots', { page: 1, page_size: 10, total_pages: Math.ceil(counts.dispatch_slots / 10), total_items: counts.dispatch_slots }),
        JSON.stringify(pg1),
      )
      const s1 = String(v1.summary ?? '')
      rec.add(
        G,
        '★★ 正文：每段都带 `_pagination` 信封 + "下一段怎么取"（可照抄的调用形状）',
        s1.includes('_pagination handoffs') &&
          s1.includes('_pagination human_requests') &&
          s1.includes('_pagination history') &&
          s1.includes('_pagination dispatch_slots') &&
          s1.includes('page: 2') &&
          s1.includes(`task_id: "${taskId}"`),
        s1.split('\n').filter((l) => l.includes('_pagination')).join('\n'),
      )

      const lastPage = Math.ceil(counts.handoffs / 10)
      const pLast = await call({ page: lastPage, page_size: 10 })
      rec.add(
        G,
        `★ 最后一页（第 ${lastPage} 页）只回剩下的 ${counts.handoffs - (lastPage - 1) * 10} 条，且写明"已是最后一段"`,
        Array.isArray(pLast.value?.handoffs) &&
          pLast.value.handoffs.length === counts.handoffs - (lastPage - 1) * 10 &&
          String(pLast.value?.summary ?? '').includes('已是最后一段'),
        `本段=${pLast.value?.handoffs?.length}`,
      )

      const pOver = await call({ page: 999, page_size: 10 })
      const vo = pOver.value ?? {}
      rec.add(
        G,
        '★★ 页码越界（999）：**返回空数组 + `_pagination.out_of_range/note`，不报错**',
        pOver.denied !== true &&
          Array.isArray(vo.handoffs) && vo.handoffs.length === 0 &&
          Array.isArray(vo.history) && vo.history.length === 0 &&
          vo._pagination?.handoffs?.out_of_range === true &&
          typeof vo._pagination?.handoffs?.note === 'string' &&
          vo._pagination.handoffs.page === 999 &&
          vo._pagination.handoffs.total_items === counts.handoffs,
        JSON.stringify({ ok: vo.ok, handoffs: vo.handoffs, rec: vo._pagination?.handoffs }),
      )
      rec.add(
        G,
        '★ 越界时正文也说清"本段为空 / 页码越界 / 不报错"（不是静默给空）',
        String(vo.summary ?? '').includes('页码越界') && String(vo.summary ?? '').includes('不报错'),
        String(vo.summary ?? '').split('\n').filter((l) => l.includes('越界')).join('\n'),
      )

      const pClamp = await call({ page: 1, page_size: 999 })
      rec.add(
        G,
        '★ `page_size` 超上限 ⇒ 夹到 200（不报错、不撑爆）',
        pClamp.denied !== true && pClamp.value?._pagination?.handoffs?.page_size === STATUS_PAGE_SIZE_MAX,
        String(pClamp.value?._pagination?.handoffs?.page_size),
      )

      const pAudit = await call({ page: 1, page_size: 5, include_audit: true })
      const auditRec = pAudit.value?._pagination?.audit
      rec.add(
        G,
        '★★ `include_audit` + page ⇒ 审计日志**也分页**（本段 5 条 + `_pagination.audit` 信封）',
        pAudit.denied !== true &&
          Array.isArray(pAudit.value?.audit) &&
          pAudit.value.audit.length === 5 &&
          auditRec !== undefined &&
          auditRec.section === 'audit' &&
          auditRec.total_items === auditTotal &&
          auditRec.total_items === pAudit.value?.total_audit,
        JSON.stringify({ len: pAudit.value?.audit?.length, rec: auditRec, total_audit: pAudit.value?.total_audit }),
      )
      rec.add(
        G,
        '★ 不分页但 include_audit ⇒ 审计日志照旧**整段内联**（既有口径不变）',
        String((await call({ include_audit: true })).value?.summary ?? '').includes(`审计日志（${auditTotal} 条）`),
        `期望条数 ${auditTotal}`,
      )

      const pSum = await call({ detail: 'summary', page: 1, page_size: 10 })
      rec.add(
        G,
        '★ 紧凑档 + page：结构化的分页字段照给，正文只加**一行**分页摘要（`分页：page=…`）',
        pSum.denied !== true &&
          pSum.value?._pagination?.handoffs?.page === 1 &&
          String(pSum.value?.summary ?? '').split('\n').filter((l) => l.startsWith('分页：')).length === 1,
        String(pSum.value?.summary ?? '').split('\n').filter((l) => l.startsWith('分页：')).join(' | '),
      )
    }

    // =====================================================================
    // C 存储体积诊断：字段齐 + 阈值提示
    // =====================================================================
    {
      const G = 'C storage 块：字段齐 + >1MiB 给 hint'
      const a = await call({})
      const st = a.value?.storage ?? {}
      rec.add(
        G,
        '★★ `storage` 块字段齐全（task_json_bytes / baseline_bytes / artifacts_bytes / handoff_count / history_count / audit_lines）',
        typeof st.task_json_bytes === 'number' &&
          st.task_json_bytes > 0 &&
          (st.baseline_bytes === null || typeof st.baseline_bytes === 'number') &&
          (st.artifacts_bytes === null || typeof st.artifacts_bytes === 'number') &&
          st.handoff_count === counts.handoffs &&
          st.history_count === counts.history &&
          st.audit_lines === auditTotal &&
          a.value?.storage?.hint === null,
        JSON.stringify(st),
      )

      // --- 阈值（baseline）：baseline 就住在 task.json 里，超 1MiB 也要给 hint -------
      {
        const t = f.h.store.peek(taskId)
        const orig = t.baselines
        t.baselines = [{ baseline_id: 'BL-F35-BIG', files: Array.from({ length: 12000 }, (_, i) => ({ path: `src/f${i}.js`, sha256: 'a'.repeat(64) })) }]
        try {
          const bigBase = await call({})
          const bs = bigBase.value?.storage ?? {}
          rec.add(
            G,
            '★★ `baseline_bytes` 超 1MiB ⇒ 也触发 hint（不是只看 task.json）',
            bigBase.denied !== true &&
              typeof bs.baseline_bytes === 'number' &&
              bs.baseline_bytes > STORAGE_HINT_BYTES &&
              typeof bs.hint === 'string' &&
              bs.hint.includes('baseline'),
            JSON.stringify({ baseline_bytes: bs.baseline_bytes, hint: bs.hint }),
          )
        } finally {
          t.baselines = orig
        }
      }

      // --- 阈值：把 taskFile 指到一个 >1MiB 的文件上（只影响本次调用；随后还原）------
      const origTaskFile = f.h.store.taskFile
      const bigFile = join(f.h.projectRoot, 'f35-big-task.json')
      writeFileSync(bigFile, 'x'.repeat(STORAGE_HINT_BYTES + 4096), 'utf8')
      f.h.store.taskFile = () => bigFile
      try {
        const big = await call({})
        const bigSt = big.value?.storage ?? {}
        rec.add(
          G,
          '★★ 任一指标 >1MiB ⇒ `storage.hint` 触发，且提示里给出 page / fields / detail=summary 三条取法',
          big.denied !== true &&
            typeof bigSt.task_json_bytes === 'number' &&
            bigSt.task_json_bytes > STORAGE_HINT_BYTES &&
            typeof bigSt.hint === 'string' &&
            bigSt.hint.includes('page=') &&
            bigSt.hint.includes('fields=[') &&
            bigSt.hint.includes('detail="summary"'),
          String(bigSt.hint ?? '（无 hint）'),
        )
        rec.add(
          G,
          '★ hint 也进正文（全文档的存储行末尾），不是只藏在结构化字段里',
          String(big.value?.summary ?? '').includes('存储偏大'),
          String(big.value?.summary ?? '')
            .split('\n')
            .filter((l) => l.includes('存储'))
            .join('\n'),
        )
      } finally {
        f.h.store.taskFile = origTaskFile
      }
    }

    // =====================================================================
    // D 紧凑档不撑体积
    // =====================================================================
    {
      const G = 'D 紧凑档只一行、比全文档明显小'
      const full = await call({})
      const brief = await call({ detail: 'summary' })
      const fullText = String(full.value?.summary ?? '')
      const briefText = String(brief.value?.summary ?? '')
      rec.add(
        G,
        '★★ 紧凑档比全文档**明显小**（< 50%），且仍含"卡点 / 下一步该谁 / 计数"',
        brief.denied !== true &&
          bytes(briefText) < bytes(fullText) * 0.5 &&
          briefText.includes('卡点') &&
          briefText.includes('下一步该谁') &&
          briefText.includes('计数：'),
        `全文档 ${bytes(fullText)} B → 紧凑 ${bytes(briefText)} B`,
      )
      const storageLines = briefText.split('\n').filter((l) => l.startsWith('存储：'))
      rec.add(
        G,
        '★★ 紧凑档的存储诊断**只有一行**（不展开字节明细，不撑体积）',
        storageLines.length === 1 && !storageLines[0].includes('\n'),
        storageLines.join(' | '),
      )
      rec.add(
        G,
        '★ 紧凑档**不**内联交接物/历史/派活清单（那是分页/全文档的事）',
        !briefText.includes('交接物（') && !briefText.includes('_pagination handoffs'),
        firstLine(briefText),
      )
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    await disposeHarness(f.h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text(), items: rec.items }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF35StatusPagingCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
