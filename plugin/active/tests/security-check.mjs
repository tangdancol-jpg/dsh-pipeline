/**
 * dsh-pipeline · 安全确认自测
 * ============================================================================
 *     node tests/security-check.mjs
 *
 * 验的是：「审核必须确认网络安全 / 本地泄密是否发生」被做成了**可执行、可追问依据**的机制。
 *
 *   · 扫描工具真的能扫出东西（假密钥、未解释外联）
 *   · 扫描结果**自身不回显命中原文**（工具不得成为泄密渠道）—— 反例⑤
 *   · attestation 缺失 / unknown / 有未解决 finding / 跳过检查 ⇒ **关单被拒**
 *   · security 角色 blocked=true ⇒ 强制拦截
 *   · L3+ 必须同时有 security_review 与审核的安全确认
 *
 * @module dsh-pipeline/tests/security-check
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { callTool, auditFor, cleanSecurity, manifestFor } from './selftest-core.mjs'
import { createMultiWriterFixture } from './writers-check.mjs'

// ---------------------------------------------------------------------------
// 断言小工具
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
    add(name, pass, detail) {
      items.push({ name, pass: pass === true, detail: String(detail ?? '') })
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

function expectDenied(rec, name, res, mustContain = []) {
  const ok = res.denied === true && res.layer !== 'missing'
  const missing = mustContain.filter((s) => !hit(res.text, s))
  const pass = ok && missing.length === 0
  rec.add(
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

function expectOk(rec, name, res, mustContain = []) {
  const missing = mustContain.filter((s) => !hit(res.text, s))
  const pass = res.denied !== true && missing.length === 0
  rec.add(
    name,
    pass,
    pass
      ? `结果摘要：\n${indent(res.text)}`
      : `期望成功但被拒（layer=${res.layer}）${missing.length > 0 ? `，缺少：${missing.join(' / ')}` : ''}\n原文：\n${indent(res.text)}`,
  )
  return pass
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** ★ 测试专用假密钥（不是真凭证）。 */
const FAKE_KEY = '<redacted>'

/**
 * 把任务推到「已通过」之前：编写交测试 → 测试交审核。
 * 返回 `{ cur, ok }`，`ok === false` 说明中途出问题了。
 */
async function advanceToReviewing(fx) {
  const art = await callTool(
    fx.h, 'pipeline_artifact',
    { task_id: fx.taskId, content: 'export function f(n){ return n }\n', file_name: 'f.js', note: '实现', role_token: fx.tokens['writer#1'] },
    fx.agents['writer#1'],
  )
  const version = art.value?.version ?? 'v1'
  await callTool(
    fx.h, 'pipeline_handoff',
    {
      task_id: fx.taskId, kind: 'dev_to_test', role_token: fx.tokens['writer#1'],
      payload: {
        task_id: fx.taskId, artifact_version: version, patch_or_code: 'export function f(n){ return n }',
        change_note: '实现', run_commands: ['node t.mjs'], selftest_result: 'pass', known_issues: [],
        ...manifestFor(fx.h.store, fx.taskId),
      },
    },
    fx.agents['writer#1'],
  )
  await callTool(fx.h, 'pipeline_dispatch', { task_id: fx.taskId, role: 'tester', spawn: false, role_token: fx.tokens.main }, fx.agents.main)
  await callTool(
    fx.h, 'pipeline_handoff',
    {
      task_id: fx.taskId, kind: 'test_to_review', role_token: fx.tokens.tester,
      payload: {
        task_id: fx.taskId, artifact_version: version, test_cases: ['f(1)===1'], execution_result: '1/1 通过',
        failure_logs: [], pass_evidence: ['跑了'], risk_notes: [], verdict: 'pass',
      },
    },
    fx.agents.tester,
  )
  await callTool(fx.h, 'pipeline_dispatch', { task_id: fx.taskId, role: 'reviewer', spawn: false, role_token: fx.tokens.main }, fx.agents.main)
  return { cur: version, state: fx.h.store.peek(fx.taskId)?.state }
}

/**
 * 交一张**降级**的架构图（L2 清单里有 diagrammer ⇒ 关单前必须有图）。
 * 用降级路径是因为这一套测的是安全面，不想把 diagram_deliver 的依赖扯进来。
 */
async function degradedDiagram(fx) {
  const dir = join(fx.h.projectRoot, '.pipeline', fx.taskId, 'reports')
  await mkdir(dir, { recursive: true })
  const html = join(dir, 'architecture.html')
  await writeFile(html, '<html>架构图</html>', 'utf8')
  return callTool(
    fx.h, 'pipeline_handoff',
    {
      task_id: fx.taskId, kind: 'architecture_diagram', role_token: fx.tokens.diagrammer,
      payload: {
        task_id: fx.taskId, based_on_artifact_version: cur0(fx), diagram_path: html,
        produced_by: 'self-provided', degraded: true,
        degraded_reason: '安全测试夹具：不引入 diagram_deliver 依赖，用自备产物。',
        covered_modules: ['x'], notes: [],
      },
    },
    fx.agents.diagrammer,
  )
}

/** 审核出结论。 */
async function verdict(fx, cur, securityOver, conclusion = 'OK') {
  const sec = securityOver === null ? undefined : cleanSecurity(securityOver)
  // ★ 前后版本对比结论：有基线时必填，且 store 会自己重算核对
  const audit = await auditFor(fx.h, fx.taskId)
  return callTool(
    fx.h, 'pipeline_handoff',
    {
      task_id: fx.taskId, kind: 'review_verdict', role_token: fx.tokens.reviewer,
      payload: {
        task_id: fx.taskId, artifact_version: cur, conclusion,
        checklist: ['功能对', '安全面查过'], findings: [], residual_risk: [], risk_notes: [],
        release_approved: conclusion === 'OK', final_delivery_note: '交付',
        ...(sec === undefined ? {} : { security: sec }),
        ...audit,
      },
    },
    fx.agents.reviewer,
  )
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runSecurityCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // 正例：干净制品 → attestation clean → 可关单
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    open.push(fx.h)
    const { cur } = await advanceToReviewing(fx)

    // 先跑一次扫描，拿到真实的 checks_ref
    const scan = await callTool(fx.h, 'pipeline_security_check', { task_id: fx.taskId, role_token: fx.tokens.reviewer }, fx.agents.reviewer)
    expectOk(rec, '正例 审核自己跑安全确认扫描', scan, ['安全确认扫描', '本地泄密面', '网络面', '边界'])
    rec.add('正例 干净制品：命中数 0，建议结论 clean',
      scan.value?.finding_count === 0 && scan.value?.attestation_hint === 'clean',
      `finding_count=${scan.value?.finding_count}  attestation_hint=${scan.value?.attestation_hint}`)
    rec.add('正例 扫描结果落盘并给出 checks_ref（可追问依据）',
      typeof scan.value?.checks_ref === 'string' && scan.value.checks_ref.includes('security-scan-'),
      `checks_ref = ${scan.value?.checks_ref}\nreport_path = ${scan.value?.report_path}`)

    const ref = scan.value?.checks_ref ?? ''
    const v = await verdict(fx, cur, {
      attestation: 'clean',
      checks_ref: [ref],
      local_leak: { checked: true, checks_ref: [ref], evidence: ['扫过，未见凭证特征'] },
      network: { checked: true, checks_ref: [ref], evidence: ['产物无出网调用'] },
    })
    expectOk(rec, '正例 审核出结论（带安全确认）', v, ['审核结论'])

    await degradedDiagram(fx)
    const closed = await callTool(fx.h, 'pipeline_close', { task_id: fx.taskId, role_token: fx.tokens.main, note: '安全面已确认' }, fx.agents.main)
    expectOk(rec, '正例 ★ 可关单：attestation=clean + 依据真实存在', closed, ['已关闭|关闭'])
  }

  // =========================================================================
  // ★ 反例①′：哈希台账 / 十六进制摘要**不能**被误判成手机号（真 flake 的回归测试）
  // =========================================================================
  //
  //   背景：本插件在 `.pipeline/` 里存 sha256（制品摘要、改动基线的逐文件哈希）。
  //   旧判据是 `(?<!\d)1[3-9]\d{9}(?!\d)` —— 64 位十六进制里**必然**会出现这种片段，
  //   于是"扫描自己的台账"会随机报出假手机号（跑一次一个样）。
  //   这条用例把它钉死：**必须不命中**。
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    open.push(fx.h)
    const { cur } = await advanceToReviewing(fx)
    void cur
    const artDir = join(fx.h.projectRoot, '.pipeline', fx.taskId, 'artifacts', 'v1')
    await mkdir(artDir, { recursive: true })
    // 这段十六进制里**故意**塞了一个 11 位的 `1[3-9]\d{9}` 片段（<redacted>），
    // 它前后都紧贴十六进制字母 ⇒ 是哈希，不是号码。
    const hexWithPhoneLikeRun = 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef13333333333deadbeef00'
    await writeFile(
      join(artDir, 'digests.json'),
      JSON.stringify({ sha256: hexWithPhoneLikeRun, note: '制品摘要（哈希，不是号码）' }, null, 2),
      'utf8',
    )
    const scan = await callTool(fx.h, 'pipeline_security_check', { task_id: fx.taskId, role_token: fx.tokens.reviewer }, fx.agents.reviewer)
    expectOk(rec, '反例①′ 扫描照常返回', scan, ['本地泄密面'])
    rec.add(
      '反例①′ ★ 64 位十六进制里的 `1[3-9]\\d{9}` 片段**不**被误判成手机号',
      scan.value?.finding_count === 0 && scan.value?.attestation_hint === 'clean',
      `finding_count=${scan.value?.finding_count}  attestation_hint=${scan.value?.attestation_hint}\n摘要：\n${indent(scan.text.slice(0, 400))}`,
    )
    // 对照：真手机号照旧命中（别把这条修成"永远不报"）
    await writeFile(
      join(artDir, 'contact.md'),
      '联系人电话：<redacted>（这是真的手机号，必须被扫出来）\n',
      'utf8',
    )
    const scan2 = await callTool(fx.h, 'pipeline_security_check', { task_id: fx.taskId, role_token: fx.tokens.reviewer }, fx.agents.reviewer)
    rec.add(
      '反例①′ 对照：**真**手机号照旧命中（收紧不等于失灵）',
      scan2.value?.finding_count > 0 && hit(scan2.text, 'cn_mobile'),
      `finding_count=${scan2.value?.finding_count}\n${indent(String(scan2.text).split('\n').filter((l) => l.includes('cn_mobile') || l.includes('命中')).slice(0, 6).join('\n'))}`,
    )
  }

  // =========================================================================
  // 反例①：制品里放一个**假密钥** → 命中 finding → 关单被拒
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    open.push(fx.h)
    // 先把任务推到「审核中」（否则 review_verdict 会被跳步闸拦）
    const { cur } = await advanceToReviewing(fx)
    const artDir = join(fx.h.projectRoot, '.pipeline', fx.taskId, 'artifacts', 'v1')
    await mkdir(artDir, { recursive: true })
    // ★ 测试专用假密钥（非真实凭证），并且**故意**用 OpenAI 风格前缀
    await writeFile(join(artDir, 'config.json'), JSON.stringify({ note: '本地调试', api_key: FAKE_KEY }, null, 2), 'utf8')

    const scan = await callTool(fx.h, 'pipeline_security_check', { task_id: fx.taskId, role_token: fx.tokens.reviewer }, fx.agents.reviewer)
    expectOk(rec, '反例① 扫描有命中（不报错，照常返回结果）', scan, ['本地泄密面'])
    rec.add('反例① ★ 假密钥被扫出来（命中数 > 0，建议 issues）',
      scan.value?.finding_count > 0 && scan.value?.attestation_hint === 'issues',
      `finding_count=${scan.value?.finding_count}  attestation_hint=${scan.value?.attestation_hint}`)
    rec.add('反例① 命中定位到"哪个文件第几行命中哪一类"（可追问）',
      hit(scan.text, 'config.json') && hit(scan.text, '第 3 行') && hit(scan.text, 'openai_style_key'),
      `摘要原文：\n${indent(scan.text)}`)
    const ref = scan.value?.checks_ref ?? ''

    // 审核如实标 issues + 未解决 finding
    const v = await verdict(fx, cur, {
      attestation: 'issues', checks_ref: [ref],
      local_leak: { checked: true, checks_ref: [ref], evidence: ['命中 1 处'] },
      network: { checked: true, checks_ref: [ref], evidence: ['无外联'] },
      findings: [{ location: `artifacts/v1/config.json 第 3 行`, type: 'openai_style_key', why: '制品里出现了疑似 API 密钥', resolved: false }],
    })
    expectOk(rec, '反例① 审核如实标 issues（结论本身可以提交）', v, ['审核结论'])
    const closed = await callTool(fx.h, 'pipeline_close', { task_id: fx.taskId, role_token: fx.tokens.main, note: '想关' }, fx.agents.main)
    expectDenied(rec, '反例① ★ 有未解决的安全问题 → **关单被拒**', closed,
      ['SECURITY_FINDINGS_OPEN|未解决', 'artifacts/v1/config.json 第 3 行', 'pipeline_rework', '升级给用户'])
  }

  // =========================================================================
  // 反例②：报告里夹带疑似凭证且未脱敏 → 命中 → 拒
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    open.push(fx.h)
    const { cur } = await advanceToReviewing(fx)
    const repDir = join(fx.h.projectRoot, '.pipeline', fx.taskId, 'reports')
    await mkdir(repDir, { recursive: true })
    // 测试报告里夹带了一段"未脱敏的调试输出"
    await writeFile(
      join(repDir, 'test-report.md'),
      '# 测试报告\n\n## 复现步骤\n\ncurl -H "Authorization: <redacted>" https://api.internal.example.net/v1/items\n\n以上是复现用的调试输出（未脱敏）。\n',
      'utf8',
    )

    const scan = await callTool(fx.h, 'pipeline_security_check', { task_id: fx.taskId, role_token: fx.tokens.reviewer }, fx.agents.reviewer)
    rec.add('反例② ★ 报告里夹带的 Bearer 令牌被扫出来',
      scan.value?.finding_count > 0 && hit(scan.text, 'test-report.md') && hit(scan.text, 'bearer_token'),
      `摘要原文：\n${indent(scan.text)}`)
    rec.add('反例② ★ 同一行既有外联地址又有凭证 → 额外记一条 credential_in_outbound',
      hit(scan.text, 'credential_in_outbound') || hit(scan.text, '伴随凭证'),
      `网络面段：\n${indent(String(scan.text).split('【网络面】')[1] ?? '(无)')}`)

    const ref = scan.value?.checks_ref ?? ''
    const v = await verdict(fx, cur, {
      attestation: 'issues', checks_ref: [ref],
      local_leak: { checked: true, checks_ref: [ref], evidence: ['命中 bearer_token'] },
      network: { checked: true, checks_ref: [ref], evidence: ['报告里的调试输出含外联'] },
      findings: [
        { location: 'reports/test-report.md 第 5 行', type: 'bearer_token', why: '测试报告里夹带了未脱敏的令牌', resolved: false },
        { location: 'reports/test-report.md 第 5 行', type: 'credential_in_outbound', why: '凭证与外联在同一行，可能已随请求发出', resolved: false },
      ],
    })
    expectOk(rec, '反例② 审核如实记录两条 finding', v, ['审核结论'])
    const closed = await callTool(fx.h, 'pipeline_close', { task_id: fx.taskId, role_token: fx.tokens.main, note: '想关' }, fx.agents.main)
    expectDenied(rec, '反例② ★ 报告里有未脱敏凭证 → **关单被拒**', closed, ['未解决', 'test-report.md 第 5 行'])
  }

  // =========================================================================
  // 反例③：attestation = unknown → 拒
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    open.push(fx.h)
    const { cur } = await advanceToReviewing(fx)
    const v = await verdict(fx, cur, { attestation: 'unknown' })
    expectDenied(rec, '反例③ ★ attestation=unknown → 审核结论本身就被拒', v,
      ['attestation=unknown', '不允许通过', '要么查清'])
  }

  // =========================================================================
  // 反例④：缺 security 段 / 跳过检查 → 拒
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    open.push(fx.h)
    const { cur } = await advanceToReviewing(fx)

    const missing = await verdict(fx, cur, null)
    expectDenied(rec, '反例④a 审核结论里**完全没有** security 段', missing,
      ['缺少必填字段「security」', '必须', '网络安全'])

    const notChecked = await verdict(fx, cur, {
      local_leak: { checked: false, checks_ref: ['x.json'] },
      network: { checked: true, checks_ref: ['x.json'] },
    })
    expectDenied(rec, '反例④b 本地泄密面 checked=false（跳过检查）', notChecked,
      ['checked 不为 true', '不能跳过检查'])

    const noRef = await verdict(fx, cur, {
      local_leak: { checked: true, checks_ref: [] },
      network: { checked: true, checks_ref: [] },
      checks_ref: [],
    })
    expectDenied(rec, '反例④c checks_ref 为空（没有依据）', noRef,
      ['checks_ref 为空', '结论必须可追问依据', '不是依据'])

    const ghostRef = await verdict(fx, cur, {
      attestation: 'clean',
      local_leak: { checked: true, checks_ref: ['reports/never-written.json'] },
      network: { checked: true, checks_ref: ['reports/never-written.json'] },
      checks_ref: ['reports/never-written.json'],
    })
    expectOk(rec, '反例④d 前提：只写路径不落盘，字段形状是合法的', ghostRef, ['审核结论'])
    const closed = await callTool(fx.h, 'pipeline_close', { task_id: fx.taskId, role_token: fx.tokens.main, note: '想关' }, fx.agents.main)
    expectDenied(rec, '反例④d ★ 依据指向的文件一个都不存在 → 关单被拒', closed,
      ['SECURITY_CHECKS_REF_MISSING|一个都不存在', 'never-written.json', '只写路径不落盘'])
  }

  // =========================================================================
  // 反例⑤：★ 扫描结果**自身不得回显命中原文**（盯住工具缺陷）
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    open.push(fx.h)
    const artDir = join(fx.h.projectRoot, '.pipeline', fx.taskId, 'artifacts', 'v1')
    await mkdir(artDir, { recursive: true })
    await writeFile(join(artDir, 'leak.json'), JSON.stringify({ api_key: FAKE_KEY }), 'utf8')

    const scan = await callTool(fx.h, 'pipeline_security_check', { task_id: fx.taskId, role_token: fx.tokens.reviewer }, fx.agents.reviewer)
    rec.add('反例⑤ ★ 工具缺陷断言：摘要里**不含**命中原文',
      scan.denied !== true && !String(scan.text).includes(FAKE_KEY),
      String(scan.text).includes(FAKE_KEY)
        ? `✗✗ 工具缺陷：摘要里回显了命中原文！\n${indent(scan.text)}`
        : `摘要已脱敏（搜索 "${FAKE_KEY.slice(0, 8)}…" 未命中）：\n${indent(scan.text)}`)

    // 落盘的 JSON 报告也要查一遍
    const { readFile } = await import('node:fs/promises')
    let body = ''
    try {
      body = await readFile(scan.value?.report_path ?? '', 'utf8')
    } catch { /* 读不到就按失败算 */ }
    rec.add('反例⑤ ★ 工具缺陷断言：落盘的完整 JSON 报告里**也不含**命中原文',
      body.length > 0 && !body.includes(FAKE_KEY),
      body.length === 0
        ? '报告没读到（这本身也是问题）'
        : body.includes(FAKE_KEY)
          ? '✗✗ 工具缺陷：落盘报告里回显了命中原文！'
          : `报告 ${body.length} 字节，搜索命中原文未找到。（只写"哪个文件第几行命中哪一类" + 打码片段）`)

    // 打码片段确实存在（证明"打了码"而不是"什么都没给"）
    rec.add('反例⑤ 对照：摘要里给了**打码**片段（便于人认出是哪一类，又不泄露内容）',
      hit(scan.text, 'sk-') && hit(scan.text, '*'),
      `摘要里的片段：${(String(scan.text).match(/sk-\*+[^\s（]*（共 \d+ 字符）/) ?? ['(未找到打码片段)'])[0]}`)
  }

  // =========================================================================
  // 反例⑥：审核把命中原文抄进了结论 → 拒
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    open.push(fx.h)
    const { cur } = await advanceToReviewing(fx)
    const v = await verdict(fx, cur, {
      attestation: 'issues',
      findings: [{ location: 'artifacts/v1/config.json 第 3 行', type: 'openai_style_key', why: `命中了 ${FAKE_KEY}`, resolved: false }],
    })
    expectDenied(rec, '反例⑥ ★ 审核把命中原文抄进了 finding.why', v,
      ['疑似凭证**原文**', '把泄露从制品搬到了结论里', '哪个文件第几行命中哪一类'])
  }

  // =========================================================================
  // 反例⑦：审核只写"安全角色说没问题" → 拒
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    open.push(fx.h)
    const { cur } = await advanceToReviewing(fx)
    const v = await verdict(fx, cur, { checked_by: 'security' })
    expectDenied(rec, '反例⑦ ★ 审核不能只写"安全角色说没问题"（必须自己出结论）', v,
      ['checked_by=security', '安全角色说没问题', '输入证据', '审核结论'])
  }

  // =========================================================================
  // 反例⑧：security 角色 blocked=true → 强制拦截（L3）
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1, tier: 'L3' })
    open.push(fx.h)
    rec.add('反例⑧ 夹具：L3（安全敏感），清单里有 security 角色',
      fx.h.store.peek(fx.taskId)?.roster?.tier === 'L3',
      `tier=${fx.h.store.peek(fx.taskId)?.roster?.tier}  执行角色=${(fx.h.store.peek(fx.taskId)?.roster?.execution_roles ?? []).join('/')}`)

    const dSec = await callTool(fx.h, 'pipeline_dispatch', { task_id: fx.taskId, role: 'security', spawn: false, role_token: fx.tokens.main }, fx.agents.main)
    expectOk(rec, '反例⑧ 派出安全角色', dSec, ['已派出'])
    // ★ 安全角色是后派的，令牌得从派活结果里取（夹具里没有）
    fx.tokens.security = dSec.value?.token ?? ''
    fx.agents.security = dSec.value?.agent_id ?? 'manual-security'

    const { cur } = await advanceToReviewing(fx)

    // ★ 安全角色的独立结论必须**在 passed 之前**出（security_review 允许的状态里没有 passed）
    const veto = await callTool(
      fx.h, 'pipeline_handoff',
      {
        task_id: fx.taskId, kind: 'security_review', role_token: fx.tokens.security,
        payload: {
          task_id: fx.taskId, findings: ['对外接口缺少速率限制'], severity: 'high', blocked: true,
          remediation: ['补上限流'],
        },
      },
      fx.agents.security,
    )
    expectOk(rec, '反例⑧ 安全角色出 blocked=true 的独立结论', veto, ['安全'])

    const v1 = await verdict(fx, cur, { attestation: 'issues', findings: [{ location: 'src/api/route.js', type: 'security_veto', why: '安全角色报 blocked=true：对外接口缺少速率限制', resolved: false }] })
    expectOk(rec, '反例⑧ 前提：审核给了 OK（带安全确认）', v1, ['审核结论'])
    await degradedDiagram(fx)

    const c2 = await callTool(fx.h, 'pipeline_close', { task_id: fx.taskId, role_token: fx.tokens.main, note: '想关' }, fx.agents.main)
    expectDenied(rec, '反例⑧a ★ security 角色报 blocked=true → **关单被拒**，不得放行', c2,
      ['SECURITY_VETO|阻断项', 'blocked=true', '安全否决**优先于**审核 OK', 'pipeline_rework'])
  }

  // =========================================================================
  // 扫描范围边界
  // =========================================================================
  {
    const fx = await createMultiWriterFixture({ writers: 1 })
    open.push(fx.h)
    const outside = join(fx.h.projectRoot, '..', 'somewhere-else')
    const scan = await callTool(
      fx.h, 'pipeline_security_check',
      { task_id: fx.taskId, extra_paths: [outside], role_token: fx.tokens.reviewer },
      fx.agents.reviewer,
    )
    expectOk(rec, '边界 越界路径不会让扫描失败（照常出结果）', scan, ['安全确认扫描'])
    rec.add('边界 ★ 越界的补充路径被**拒绝**并记入结果（不遍历项目根之外）',
      hit(scan.text, '被拒绝的扫描路径') && hit(scan.text, '超出本任务工作区'),
      `摘要里的边界段：\n${indent(String(scan.text).split('\n').slice(0, 8).join('\n'))}`)
    rec.add('边界 结果里写明了扫描边界（文档化）',
      hit(scan.text, '只扫本任务工作区'),
      `边界说明已出现在摘要里`)
  }

  // =========================================================================
  // 出报告
  // =========================================================================
  const groupOf = (name) => {
    if (name.startsWith('正例')) return '正例 干净制品 → clean → 可关单'
    if (name.startsWith('反例①')) return '反例① 制品里放假密钥 → 命中 → 关单被拒'
    if (name.startsWith('反例②')) return '反例② 报告夹带未脱敏凭证 → 命中 → 拒'
    if (name.startsWith('反例③')) return '反例③ attestation=unknown → 拒'
    if (name.startsWith('反例④')) return '反例④ 缺 security 段 / 跳过检查 / 依据不存在'
    if (name.startsWith('反例⑤')) return '反例⑤ ★ 工具缺陷断言：扫描结果自身不回显原文'
    if (name.startsWith('反例⑥')) return '反例⑥ 审核把命中原文抄进结论 → 拒'
    if (name.startsWith('反例⑦')) return '反例⑦ 审核只写"安全角色说没问题" → 拒'
    if (name.startsWith('反例⑧')) return '反例⑧ security 角色 blocked=true → 强制拦截（L3）'
    if (name.startsWith('边界')) return '扫描范围边界'
    return '其它'
  }
  const groups = {}
  for (const it of rec.items) {
    const g = groupOf(it.name)
    if (groups[g] === undefined) groups[g] = []
    groups[g].push(it)
  }

  const lines = []
  lines.push('='.repeat(78))
  lines.push('dsh-pipeline 安全确认自测（网络安全 / 本地泄密是否发生）')
  lines.push('='.repeat(78))
  for (const [g, items] of Object.entries(groups)) {
    lines.push('')
    lines.push('─'.repeat(78))
    lines.push(`【${g}】${items.filter((i) => i.pass).length}/${items.length} 通过`)
    lines.push('─'.repeat(78))
    for (const it of items) {
      lines.push('')
      lines.push(`${it.pass ? '✓' : '✗'} ${it.name}`)
      for (const l of String(it.detail).split('\n')) lines.push(`    ${l}`)
    }
  }
  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`总计：${rec.passed}/${rec.total} 通过`)
  lines.push('='.repeat(78))

  for (const hh of open) await hh.store.dropCache()
  for (const hh of open) {
    try { await rm(hh.projectRoot, { recursive: true, force: true }) } catch { /* 清不掉不影响结论 */ }
  }

  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

/** 取当前有效制品版本。 */
function cur0(fx) {
  const t = fx.h.store.peek(fx.taskId)
  const hs = (t.handoffs ?? []).filter((h) => h.kind === 'dev_to_test')
  return hs.at(-1)?.artifact_version ?? 'v1'
}

if (process.argv[1] !== undefined && /security-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runSecurityCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
