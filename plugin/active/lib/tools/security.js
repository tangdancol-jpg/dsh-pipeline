/**
 * dsh-pipeline · 安全确认（pipeline_security_check）
 * ============================================================================
 * 从 `lib/tools.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/tools.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/tools/security
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { renderScanSummary, runSecurityScan } from '../security.js'
import { fullHash, toStringArray } from '../util.js'
import { S, tool, resolveActor } from './kit.js'
// ★ 拒绝文案的**唯一出处**（`lib/errors/text.js`）：本文件只换成引用，字面值未动。
import { TASK_ID_REQUIRED, taskNotFound } from '../errors/text.js'

/**
 * 安全确认（pipeline_security_check）
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字（由 `lib/tools.js` 原位传入）
 */
export function buildSecurityTools(ctx) {
  const { deps, config, store, indexTask, load, paginate } = ctx

  // =========================================================================
  // 20. ★安全确认扫描（审核必须确认"网络安全 / 本地泄密是否发生"）
  // =========================================================================

  const securityCheck = tool(deps, {
    name: 'pipeline_security_check',
    mutating: false,
    description:
      '★ 对本任务工作区做**安全确认扫描**：本地泄密面（密钥/凭证/隐私是否出现在制品、报告、日志、收据、audit.jsonl 里）' +
      '+ 网络面（产物/脚本里有没有外联地址、有没有**未解释**的外联、有没有凭证出现在出网请求里）。' +
      '产出结构化 JSON + **脱敏**的人可读摘要。' +
      '★ 扫描范围**只限本任务工作区**（.pipeline/<taskId>/ 与显式给出且落在项目根内的路径）—— 不遍历用户其它目录。' +
      '★ 结果里**不回显命中原文**，只写"哪个文件第几行命中哪一类"+ 打码片段（工具自身不得成为泄密渠道）。' +
      '审核把它返回的 checks_ref 与结论填进 review_verdict.security。',
    parameters: {
      task_id: S('string', '任务 ID'),
      extra_paths: S('array', '补充扫描路径（必须落在项目根之内；越界会被拒绝并记入结果）', { items: { type: 'string' } }),
      allowed_hosts: S('array', '已解释的外联主机白名单（出现在这里的不算"未解释外联"）', { items: { type: 'string' } }),
      /**
       * ★★ **E 路 ②**：命中多的时候摘要会逐条列出（每条 2 行 + 原因），
       *   而"能不能给 clean"这件事只需要**算好的计数**。
       *   ★ 不传 = 与改前**逐字节相同**（`checks_ref` / 落盘 / 审计都不受影响）。
       */
      detail: S('string', '★ 输出档（**不传 = 与改前逐字节相同**）：summary = 计数 + 前若干条命中｜count = 只回计数与建议结论｜full = 现状全文', { enum: ['summary', 'count', 'full'] }),
      fields: S('array', '★ 只回**点名的字段**（投影）：如 ["finding_count","attestation_hint","checks_ref"]；`ok` 永远保留', { items: { type: 'string' } }),
      page: S('number', '★ 命中清单分段取（1 起，每段 10 条；不传 = 不分页，与改前一致）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '脱敏的可读摘要（不含任何命中原文）'),
      finding_count: S('number', '命中总数'),
      checks_ref: S('string', '本次扫描结果的落盘路径（填进 review_verdict.security.checks_ref）'),
      attestation_hint: S('string', '按扫描结果给出的建议结论：clean / issues'),
      report_path: S('string', '完整结构化 JSON 的落盘路径'),
    },
    async run(args, exec) {
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, summary: actor.error, finding_count: 0, checks_ref: '', attestation_hint: '', report_path: '' }
      const taskId = String(args.task_id ?? '')
      if (taskId.length === 0) return { ok: false, summary: TASK_ID_REQUIRED, finding_count: 0, checks_ref: '', attestation_hint: '', report_path: '' }
      const task = await load(taskId)
      if (task === null) return { ok: false, summary: taskNotFound(taskId), finding_count: 0, checks_ref: '', attestation_hint: '', report_path: '' }

      const root = task.project_root
      const pipelineDir = join(root, config.artifactDirName)
      const scan = await runSecurityScan({
        task,
        projectRoot: root,
        pipelineDir,
        extraPaths: toStringArray(args.extra_paths),
        allowedHosts: toStringArray(args.allowed_hosts),
      })

      // 落盘：结构化 JSON 进本任务的 reports/ —— 它就是 checks_ref 指的东西
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-d{3}Z$/, 'Z')
      const reportsDir = join(pipelineDir, taskId, 'reports')
      await mkdir(reportsDir, { recursive: true })
      const reportPath = join(reportsDir, `security-scan-${stamp}.json`)
      const body = JSON.stringify(scan, null, 2)
      await writeFile(reportPath, body, 'utf8')
      const digest = fullHash(body)
      const relRef = relative(root, reportPath).replace(/\\/g, '/')

      const hint = scan.finding_count === 0 ? 'clean' : 'issues'
      /**
       * ★★ **E 路 ②：紧凑档**（`detail: "summary" | "count"`）。
       *
       * ★ 判据一个字节没动：扫描范围、落盘、`checks_ref`、审计留痕、
       *   以及"有命中就不许给 clean"这条结论**全部照旧** —— 省掉的只是
       *   "把每一条命中逐条排开"的那部分正文（命中多时它是大头）。
       * ★ 截断**必须**给出续页口径（不然审核只能重扫一遍 = 再付一次）。
       * ★ 不传 `detail` / 传 `"full"` ⇒ **原路，逐字节不变**。
       */
      const sBrief = typeof args.detail === 'string' ? String(args.detail) : ''
      let summary
      if (sBrief === 'summary' || sBrief === 'count') {
        const sPage = paginate(scan.network.findings, args.page, 10)
        const hosts = scan.network.hosts ?? []
        const sL = [
          `安全确认扫描：任务 ${scan.task_id}`,
          `扫描范围：${scan.scope.roots.join('、')}　文件 ${scan.scope.files_scanned} 个 / ${(scan.scope.bytes_scanned / 1024).toFixed(1)} KB` +
            `${scan.scope.rejected_paths.length > 0 ? `　⚠ 被拒路径 ${scan.scope.rejected_paths.length} 条（越界，未扫）` : ''}`,
          `计数（算好的）：合计 ${scan.finding_count} 处　·　本地泄密面 ${scan.local_leak.findings.length} 处　·　网络面 ${scan.network.findings.length} 处（外联主机 ${hosts.length} 个${hosts.some((h) => h.withCredential) ? '，其中**伴随凭证**' : ''}）`,
        ]
        if (sBrief === 'summary') {
          if (scan.local_leak.findings.length > 0) {
            sL.push('【本地泄密面】前若干条（★ 不回显原文）：')
            for (const f of scan.local_leak.findings.slice(0, 10)) sL.push(`  · ${f.file} 第 ${f.line} 行命中 ${f.type}（${f.severity}）`)
            if (scan.local_leak.findings.length > 10) sL.push(`  …（还有 ${scan.local_leak.findings.length - 10} 条）`)
          }
          if (hosts.length > 0) sL.push(`【网络面】外联主机：${hosts.map((h) => `${h.host}${h.withCredential ? '(伴随凭证)' : ''}`).join('、')}`)
          if (sPage.total > 0) {
            sL.push(`【网络面命中】本段 ${sPage.page}/${sPage.pages}：`)
            for (const f of sPage.slice) sL.push(`  ✗ ${f.file} 第 ${f.line} 行：${f.type} → ${f.host}`)
            if (sPage.more) sL.push(`  …（下一段：\`pipeline_security_check { task_id: "${taskId}", detail: "summary", page: ${sPage.page + 1} }\`；或全量：detail="full"）`)
          }
        }
        summary =
          sL.join('\n') +
          '\n' +
          `\n落盘：${relRef}` +
          `\nsha256：${digest.slice(0, 32)}…` +
          `\n\n★ 建议结论：attestation=${hint}` +
          (hint === 'clean'
            ? '\n（扫描未见命中。注意：**扫描不是万能的** —— 它只查已知模式；结论仍要你自己负责。）'
            : `\n（有 ${scan.finding_count} 处命中，**不能**给 clean。要么打回编写，要么让 security 角色复核，要么升级给用户。）`) +
          `\n★ 本段是**紧凑档**（${sBrief}）：要全文（逐条 + 原因 + 打码片段）用 \`detail="full"\`。`
      } else {
        summary =
          renderScanSummary(scan) +
          '\n' +
          `\n落盘：${relRef}` +
          `\nsha256：${digest.slice(0, 32)}…` +
          `\n\n★ 建议结论：attestation=${hint}` +
          (hint === 'clean'
            ? '\n（扫描未见命中。注意：**扫描不是万能的** —— 它只查已知模式；结论仍要你自己负责。）'
            : `\n（有 ${scan.finding_count} 处命中，**不能**给 clean。要么打回编写，要么让 security 角色复核，要么升级给用户。）`)
      }

      const logged = await store.recordAudit(taskId, actor.role, 'security:scan', {
        report: relRef,
        digest,
        finding_count: scan.finding_count,
        local_leak: scan.local_leak.findings.length,
        network: scan.network.findings.length,
        files_scanned: scan.scope.files_scanned,
        rejected_paths: scan.scope.rejected_paths.length,
        agent: actor.agentId,
      })
      if (logged.ok === true) indexTask(taskId, logged.task)

      return {
        ok: true,
        summary,
        finding_count: scan.finding_count,
        checks_ref: `${relRef}#${digest.slice(0, 16)}`,
        attestation_hint: hint,
        report_path: reportPath,
      }
    },
  })

  return { securityCheck }
}
