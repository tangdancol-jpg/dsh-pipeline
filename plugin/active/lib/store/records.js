/**
 * dsh-pipeline · 任务存储 · 需求档、分权落档、上下文水位、席位继任
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/records
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROLE } from '../roles.js'
import { fullHash, nowIso, shortHash, toStringArray } from '../util.js'
import { LEVELS, checkRelayAuthorization, levelOf, relayEnabled, validateContextReport } from '../context.js'
import { requirementPaths, diffSummary } from './shared.js'

/**
 * 任务存储 · 需求档、分权落档、上下文水位、席位继任
 * 返回的方法由 `createTaskStore` 原位展开进同一个对象，方法里的 `this` 仍指向那个对象。
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function recordMethods(ctx) {
  const { dirName, now, taskDir, relKey, audit, deny, loadTask, persist } = ctx

  return {
    // --- ★需求留档（权威需求快照）--------------------------------------------

    /**
     * ★ 落一份需求档（人可读 markdown + 结构化 JSON），并把路径与 sha256 记进任务。
     * 变更时**不覆盖当前文件名**（requirement.md 永远是最新版），历史另存 vN 并追加进 requirement_history[]。
     */
    async writeRequirementDoc(input) {
      const { task, markdown, structured, by } = input
      const dir = taskDir(task.id)
      await mkdir(dir, { recursive: true })

      // 版本索引是"可追溯"的**凭据**：每一版的 sha256、时间、谁改的、差异摘要都在里面。
      const idxPath = join(dir, "requirement.index.json")
      let idx = { task_id: task.id, versions: [] }
      try {
        idx = JSON.parse(await readFile(idxPath, "utf8"))
        if (!Array.isArray(idx.versions)) idx = { task_id: task.id, versions: [] }
      } catch { /* 第一次写，或索引坏了 —— 从空开始重建 */ }

      const version = `r${idx.versions.length + 1}`
      const mdBody = markdown
      const jsonBody = JSON.stringify(structured, null, 2)
      const sha = fullHash(mdBody)
      const prev = idx.versions.at(-1) ?? null

      // 当前版本固定这两个路径（"随时可查"靠的就是它们不变）
      await writeFile(join(dir, "requirement.md"), mdBody, "utf8")
      await writeFile(join(dir, "requirement.json"), jsonBody, "utf8")
      // 历史版本另存，**绝不覆盖**
      await writeFile(join(dir, `requirement.${version}.md`), mdBody, "utf8")
      await writeFile(join(dir, `requirement.${version}.json`), jsonBody, "utf8")

      idx.versions.push({
        version,
        sha256: sha,
        json_sha256: fullHash(jsonBody),
        bytes: mdBody.length,
        at: nowIso(now()),
        amended_by: by,
        supersedes: prev === null ? null : prev.version,
        note: typeof input.note === "string" ? input.note : "",
        diff_summary: prev === null ? "（首版）" : diffSummary(prev, { version, sha256: sha, note: input.note }),
      })
      await writeFile(idxPath, JSON.stringify(idx, null, 2), "utf8")
      return { version, sha256: sha, index: idx }
    },
    /**
     * ★ 需求档是否可用（**分发任务前的硬闸**）：① 任务卡登记过路径；② 文件真的在盘上。
     */
    /**
     * ★ 需求档是否可用（**分发任务前的硬闸**）。
     *
     * 更正 A 之后这里**不再看任务卡**（路径不进任务卡），改成查两件事：
     *   ① 约定目录下的 `requirement.md` **存在**；
     *   ② **版本可追溯** —— 有版本索引、索引里有版本、每版的文件都在盘上、
     *      且**当前 md 的 sha256 与索引里最新一版对得上**。
     *
     * ② 是"可追溯"的实质：光有一个 md 文件，你不知道它是哪一版、改过没有、
     *   改之前长什么样 —— 那不算可追溯。
     */
    async checkRequirementDoc(task) {
      const p = requirementPaths(join(task.project_root, dirName), task.id)
      const relMd = `.pipeline/${task.id}/requirement.md`

      if (!existsSync(p.md)) {
        return deny(
          "NO_REQUIREMENT_DOC",
          `拒绝分发任务：约定目录下**没有需求档**（找的是 ${relMd}）。\n` +
            '★ 规矩：产出任务卡 / 角色清单时必须同时落一份本地需求档 —— **没有留档就不许开工**。\n' +
            '   路径是**目录约定**推出来的，不需要谁告诉你；任何角色需要需求时自己去读。\n' +
            '为什么：上下文会溢出、会失忆、席位会换人。需求档是唯一能在"什么都忘了"之后' +
            '把"要做什么、验收标准是什么"还原出来的东西。\n' +
            '下一步：L0 由 pipeline_orchestrate 落档；L1+ 由留档 AI 用 pipeline_compile_requirement 汇总落档。',
        )
      }

      if (!existsSync(p.index)) {
        return deny(
          "REQUIREMENT_NOT_TRACEABLE",
          "拒绝分发任务：需求档存在，但**没有版本索引**（requirement.index.json）。\n" +
            '★ "可追溯"指的是：知道现在是第几版、每一版的 sha256 是什么、谁在什么时候改的、' +
            '改之前长什么样。光有一个 md 文件做不到这些。\n' +
            '下一步：让编排重新落一次档（会重建索引并保留历史）。',
        )
      }

      let idx
      try {
        idx = JSON.parse(await readFile(p.index, "utf8"))
      } catch (err) {
        return deny("REQUIREMENT_NOT_TRACEABLE", `拒绝分发任务：版本索引读不出来（${String(err?.message ?? err)}）。`)
      }
      const versions = Array.isArray(idx?.versions) ? idx.versions : []
      if (versions.length === 0) {
        return deny(
          "REQUIREMENT_NOT_TRACEABLE",
          "拒绝分发任务：版本索引里**一个版本都没有** —— 不可追溯。\n" +
            "下一步：让编排重新落一次档。",
        )
      }

      // 每一版的历史文件都得在（历史不许被删）
      const missing = versions.filter((v) => !existsSync(join(p.dir, `requirement.${v.version}.md`)))
      if (missing.length > 0) {
        return deny(
          "REQUIREMENT_HISTORY_MISSING",
          `拒绝分发任务：版本索引里记了 ${versions.length} 版，但有 ${missing.length} 版的历史文件不在盘上。\n` +
            missing.slice(0, 5).map((v) => `  · ${v.version}（requirement.${v.version}.md）`).join("\n") +
            "\n★ 历史被删掉 = 追溯链断了。宁可重建也不要删历史。",
        )
      }

      // ★ 当前 md 必须与索引里最新一版对得上（防"文件被改过但索引没更新"）
      const latest = versions.at(-1)
      const actual = fullHash(await readFile(p.md, "utf8"))
      if (actual !== latest.sha256) {
        return deny(
          "REQUIREMENT_TAMPERED",
          "拒绝分发任务：当前 requirement.md 的 sha256 与版本索引里最新一版**对不上**。\n" +
            `  索引里最新：${latest.version}　${String(latest.sha256).slice(0, 32)}…\n` +
            `  磁盘上实际：　　${actual.slice(0, 32)}…\n` +
            '★ 这说明有人绕过了编排直接改了需求档 —— 而**只有编排能写它**。\n' +
            '下一步：查清是谁改的，然后让编排重新落一次档（会把改动记成新版本）。',
        )
      }

      return { ok: true, paths: p, version: latest.version, versions: versions.length, sha256: latest.sha256 }
    },
    // --- ★分权落档（更正 A：各写各的，留档 AI 汇总）---------------------------

    /** ★ 记录目录的**约定路径**。 */
    recordDirPath(task) {
      return join(taskDir(task.id), "records")
    },

    /** ★ 某角色 / 席位的记录文件**约定名**（谁的记录谁写，互不覆盖）。 */
    recordBaseName(role, seat) {
      const s = typeof seat === "string" && seat.length > 0 && seat !== role ? `-${seat.replace(/#/g, "")}` : ""
      return `${role}${s}`
    },

    /**
     * ★ 提交一份**自己的**记录给留档 AI（更正 A）。
     *
     * 三件事一次做完：
     *   ① 写入约定路径 `records/<role>[-<seat>].md` + `.json`（**只写自己那份**）
     *   ② 校验来路：调用方必须持有**该席位自己的令牌**（拒绝匿名 / 冒名）
     *   ③ 登记一条 submission（留档 AI 汇总时按它追溯来源）
     */
    async submitRecord(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny("TASK_NOT_FOUND", `找不到任务 ${input.taskId}。`)

      const role = String(input.role ?? "")
      const seat = typeof input.seat === "string" ? input.seat : ""
      const markdown = String(input.markdown ?? "")
      if (markdown.trim().length === 0) return deny("EMPTY_RECORD", "记录内容为空 —— 空记录等于凭空写入，会被汇总时拒收。")

      // ② 来路校验：令牌必须属于 (task, role, seat)
      const tok = input.token ?? null
      if (tok === null || typeof tok.token !== "string" || tok.token.length === 0) {
        return deny(
          "NO_CREDENTIAL",
          "拒绝收下这份记录：**没有带席位令牌**。\n" +
            "★ 留档 AI 要**校验来路** —— 谁写的、哪个席位、哪一版。拒绝匿名提交。\n" +
            "请用 pipeline_record_submit 提交（它会带上你的角色令牌）。",
        )
      }
      if (tok.taskId !== task.id || tok.role !== role) {
        return deny(
          "IMPERSONATION",
          `拒绝收下这份记录：令牌与声明的来路**不符**（冒名）。\n` +
            `  令牌属于：任务 ${tok.taskId} / 角色 ${tok.role} / 席位 ${tok.seat ?? "(无)"}\n` +
            `  声明的是：任务 ${task.id} / 角色 ${role} / 席位 ${seat || "(无)"}\n` +
            "★ 记录的价值全在「这是谁说的」—— 来路不明或冒名的记录，汇总时一文不值。",
        )
      }
      if ((tok.seat ?? "") !== seat) {
        return deny(
          "SEAT_MISMATCH",
          `拒绝收下这份记录：令牌的席位是「${tok.seat ?? "(无)"}」，声明的是「${seat || "(无)"}」。\n` +
            "★ 只能提交**自己那份**。",
        )
      }

      // ① 落盘（只写自己那份）
      const dir = this.recordDirPath(task)
      await mkdir(dir, { recursive: true })
      const base = this.recordBaseName(role, seat)
      const mdPath = join(dir, `${base}.md`)
      const jsonPath = join(dir, `${base}.json`)
      await writeFile(mdPath, markdown, "utf8")
      const meta = {
        record_id: `RC-${shortHash(`${task.id}|${base}|${fullHash(markdown).slice(0, 8)}`)}`,
        task_id: task.id,
        role,
        seat: seat || null,
        base,
        at: nowIso(now()),
        sha256: fullHash(markdown),
        bytes: markdown.length,
        source: typeof input.source === "string" ? input.source : "自述",
        sections: toStringArray(input.sections),
      }
      const body = JSON.stringify({ ...meta, structured: input.structured ?? null }, null, 2)
      await writeFile(jsonPath, body, "utf8")

      // ③ 登记 submission
      task.records = task.records ?? []
      const prev = task.records.filter((r) => r.base === base).length
      const rec = { ...meta, revision: prev + 1, rel_path: relKey(task.project_root, mdPath) }
      task.records.push(rec)

      const aentry = await audit(task.id, role, "record:submit", {
        record_id: rec.record_id, base, seat: seat || null, revision: rec.revision,
        sha256: rec.sha256, agent: input.actorAgentId,
      })
      task.history.push(aentry)
      await persist(task)

      return {
        ok: true,
        task,
        record: rec,
        summary: [
          `记录已收下：${rec.record_id}（${role}${seat ? ` / ${seat}` : ""}，第 ${rec.revision} 版）`,
          `落盘：${rec.rel_path}（${rec.bytes} 字符，sha256 ${rec.sha256.slice(0, 16)}…）`,
          "来路已校验：令牌 ↔ 角色 ↔ 席位三者一致。",
          "",
          "留档 AI 会在汇总时按 record_id 追溯来源。",
        ].join("\n"),
      }
    },

    /** 列出已收下的记录。 */
    async listRecords(input = {}) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny("TASK_NOT_FOUND", `找不到任务 ${input.taskId}。`)
      const all = task.records ?? []
      // 同一 base 只留最新那一版
      const latest = new Map()
      for (const r of all) if (!latest.has(r.base) || latest.get(r.base).revision < r.revision) latest.set(r.base, r)
      return { ok: true, task, all, latest: [...latest.values()] }
    },

    /**
     * ★ 留档 AI 汇总：把各方的记录编成**唯一的需求档**（更正 A）。
     *
     * 两条硬规则：
     *   ① **每条内容必须有来源** —— `source_record` 必须指向一份真实存在的记录；
     *   ② **有矛盾不得自己拍板** —— conflicts 非空时拒绝汇总，要求先提问 / 升级。
     */
    async compileRequirement(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny("TASK_NOT_FOUND", `找不到任务 ${input.taskId}。`)

      const entries = Array.isArray(input.entries) ? input.entries : []
      const conflicts = Array.isArray(input.conflicts) ? input.conflicts : []
      if (entries.length === 0) return deny("NO_ENTRIES", "汇总至少要给一条 entries。")

      // ② 矛盾 → 不得自己拍板
      if (conflicts.length > 0) {
        return deny(
          "CONFLICTS_UNRESOLVED",
          `拒绝汇总：你报告了 ${conflicts.length} 处**互相矛盾的记录**。\n` +
            conflicts.slice(0, 5).map((c) => `  · ${c.about ?? "(未说明)"}　(${(c.between ?? []).join(" vs ")})`).join("\n") +
            "\n★ 留档 AI **不得自己拍板** —— 你的职责是收集与统一编写，不是裁定谁对。\n" +
            "两条出路：\n" +
            "  ① 走 pipeline_clarify_request 问需求分析/编排；\n" +
            "  ② 确实定不了 → 由编排升级给用户（pipeline_human_request）。\n" +
            "（把 conflicts 清空之前，requirement.md 不会被改写。）",
        )
      }

      // ① 每条必须有来源
      const all = task.records ?? []
      const byId = new Map(all.map((r) => [r.record_id, r]))
      const byRel = new Map(all.map((r) => [r.rel_path, r]))
      const noSource = []
      for (const [i, e] of entries.entries()) {
        const src = typeof e?.source_record === "string" ? e.source_record.trim() : ""
        if (src.length === 0) { noSource.push(`entries[${i}]：没有 source_record`); continue }
        if (!byId.has(src) && !byRel.has(src)) noSource.push(`entries[${i}]：source_record=「${src}」找不到对应的记录`)
      }
      if (noSource.length > 0) {
        return deny(
          "UNSOURCED_CONTENT",
          `拒绝汇总：有 ${noSource.length} 条内容**没有可追溯的来源**。\n` +
            noSource.slice(0, 5).map((s) => `  · ${s}`).join("\n") +
            "\n★ 留档 AI **不得凭空写入没有记录来源的内容**。\n" +
            "  否则需求档就不再是「大家说的话的汇总」，而是你自己编的东西。\n" +
            `  当前已收下的记录：${all.length === 0 ? "（一份都没有）" : all.map((r) => r.record_id).join("、")}`,
        )
      }

      // 生成 md（带来源标注）
      const lines = []
      lines.push(`# 需求档 · ${task.id}`)
      lines.push("")
      lines.push("> ★ **本文件是权威需求快照**，由**留档 AI** 汇总各方记录统一编写。")
      lines.push("> 每条内容都标了来源（记录 id + 提交者 + 时间）—— 可追溯。")
      lines.push("> **所有角色默认以本文件为准**；路径靠目录约定，任务卡里不登记。")
      lines.push("> 路径靠**目录约定**：`.pipeline/<taskId>/requirement.md`；**任务卡里不登记**。")
      lines.push("")
      lines.push("## 需求原文")
      lines.push("")
      lines.push(String(task.requirement ?? "(未登记)"))
      lines.push("")
      for (const e of entries) {
        const src = byId.get(e.source_record) ?? byRel.get(e.source_record)
        lines.push(`## ${String(e.section ?? "（未命名小节）")}`)
        lines.push("")
        lines.push(String(e.text ?? ""))
        lines.push("")
        lines.push(`<sub>来源：${src.record_id}（${src.role}${src.seat ? ` / ${src.seat}` : ""}，第 ${src.revision} 版，${src.at}）</sub>`)
        lines.push("")
      }
      // ★ 安全面：**每一版需求档都要带**（来源指向产出角色清单的那份记录）。
      //   否则继任上来的席位要等审核被拒了才知道"审核会查网络安全 / 本地泄密"。
      //   ⚠️ 本轮改动：来源从 `orchestrator` 改成 **`planner`** ——
      //      计划 AI 才是产出角色清单的那个角色（需求分析只出分析结论）。
      //      旧任务文件里没有 planner 记录，所以保留 orchestrator 作为回退。
      const orchRec =
        all.filter((r) => r.role === 'planner').at(-1) ??
        all.filter((r) => r.role === 'orchestrator').at(-1)
      if (orchRec !== undefined) {
        lines.push("## 安全面（审核必查）")
        lines.push("")
        lines.push("审核**必须**确认**网络安全 / 本地泄密是否发生**，并在 `review_verdict.security` 里给出")
        lines.push("`attestation`（`clean` / `issues`）与可核对的依据（`checks_ref` 必须真实存在）。")
        lines.push("`unknown` 不允许通过；有未解决 finding 不允许关单；安全角色 `blocked: true` 时强制打回。")
        lines.push("")
        lines.push(`<sub>来源：${orchRec.record_id}（${orchRec.role}，第 ${orchRec.revision} 版，${orchRec.at}）—— 计划分配</sub>`)
        lines.push("")
      }

      if (toStringArray(input.notes).length > 0) {
        lines.push("## 留档说明")
        lines.push("")
        for (const x of toStringArray(input.notes)) lines.push(`- ${x}`)
        lines.push("")
      }
      lines.push("---")
      lines.push("")
      lines.push("_由留档 AI 汇总生成；每条内容均标注来源记录，可逐条追溯。_")

      const doc = await this.writeRequirementDoc({
        task,
        markdown: lines.join("\n"),
        structured: {
          task_id: task.id,
          compiled_by: ROLE.ARCHIVIST,
          compiled_at: nowIso(now()),
          entries: entries.map((e) => ({ section: e.section, source_record: e.source_record })),
          records_used: entries.map((e) => e.source_record),
          requirement: task.requirement,
        },
        by: ROLE.ARCHIVIST,
        note: `汇总 ${entries.length} 条，来自 ${new Set(entries.map((e) => e.source_record)).size} 份记录`,
      })

      const aentry = await audit(task.id, ROLE.ARCHIVIST, "record:compile", {
        version: doc.version, sha256: doc.sha256,
        entries: entries.length, sources: [...new Set(entries.map((e) => e.source_record))],
        agent: input.actorAgentId,
      })
      task.history.push(aentry)
      await persist(task)

      return {
        ok: true,
        task,
        doc,
        summary: [
          `需求档已汇总：${doc.version}（sha256 ${String(doc.sha256).slice(0, 16)}…）`,
          `来源：${entries.length} 条内容，来自 ${new Set(entries.map((e) => e.source_record)).size} 份记录`,
          `路径（目录约定）：.pipeline/${task.id}/requirement.md`,
          "",
          "★ 每条内容都标了来源（记录 id + 提交者 + 时间），可逐条追溯。",
        ].join("\n"),
      }
    },

    // --- ★上下文水位与继任 -----------------------------------------------------

    /** 记录一条水位上报（`observed` 由插件侧工具计数器给出，是客观量）。 */
    async reportContext(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny("TASK_NOT_FOUND", `找不到任务 ${input.taskId}。`)

      const v = validateContextReport({ percent: input.percent, basis: input.basis })
      if (v.ok !== true) return deny("BAD_CONTEXT_REPORT", v.error)

      const en = relayEnabled(task)
      const policy = en.policy
      const percent = Math.round(Number(input.percent))
      const level = levelOf(percent, policy)
      const observed = input.observed ?? { tool_calls: 0, active_minutes: 0, top_tools: [] }
      task.context_reports = task.context_reports ?? []

      const entry = {
        report_id: `CR-${shortHash(`${task.id}|${input.seat ?? input.role}|${task.context_reports.length}|${percent}`)}`,
        seat: input.seat ?? null,
        role: input.role,
        agent: input.actorAgentId ?? null,
        percent,
        level,
        basis: String(input.basis).trim(),
        requested_succession: input.requestedSuccession === true,
        observed,
        at: nowIso(now()),
        relay_enabled: en.enabled,
      }
      task.context_reports.push(entry)

      const aentry = await audit(task.id, input.role, "context:report", {
        report_id: entry.report_id,
        seat: entry.seat,
        percent,
        level,
        basis: entry.basis,
        requested_succession: entry.requested_succession,
        observed_tool_calls: observed.tool_calls,
        observed_active_minutes: observed.active_minutes,
        agent: input.actorAgentId,
      })
      task.history.push(aentry)
      await persist(task)

      const lines = [
        `水位已上报：${entry.report_id}　${input.role}${entry.seat ? `（${entry.seat}）` : ""}　**${percent}%**　档位：${LEVELS[level]}`,
        `依据：${entry.basis}`,
        `插件侧客观观测：工具调用 ${observed.tool_calls} 次，活跃 ${observed.active_minutes} 分钟` +
          (observed.top_tools && observed.top_tools.length > 0 ? `（主要：${observed.top_tools.join("、")}）` : ""),
        "",
        `阈值（来自编排的 relayPolicy）：预警 ${policy.warnPercent}% / 触发继任 ${policy.triggerContextPercent}% / 硬限 ${policy.hardLimitPercent}%`,
      ]
      if (en.enabled !== true) {
        lines.push("", `本任务不启用继任：${en.why}`)
      } else if (level === "hard_limit") {
        lines.push(
          "",
          "★ **硬限**：你已经不允许再领新活了 —— 只允许交接与收尾。",
          "  请立刻产出 seat_handover 交接物，并让主对话执行 pipeline_succession。",
        )
      } else if (level === "succession") {
        lines.push(
          "",
          "★ **触发继任**：必须上报给分配 AI（主对话）。",
          "  下一步：① 产出一份 seat_handover 交接物（含 must_read_files 与 open_questions）；",
          "           ② 主对话调 pipeline_succession 换班。",
          "  ★ 别等自己撑不住才交 —— 交接物写得清不清楚，取决于你还记得多少。",
        )
      } else if (level === "warn") {
        lines.push("", "预警：开始准备交接材料（把进度、决定、必读文件记下来），还没到换班的时候。")
      }
      return { ok: true, task, report: entry, summary: lines.join("\n") }
    },

    /**
     * ★ 继任的第一步：**只做校验**，不改任何东西。
     * 真正的换班（建会话、铸令牌、撤旧令牌）由工具层做完 transport 之后调 commitSuccession。
     */
    async planSuccession(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny("TASK_NOT_FOUND", `找不到任务 ${input.taskId}。`)

      const seat = String(input.seat ?? "")
      const role = String(input.role ?? "")

      // ① 编排授权（档位 / 角色白名单 / 次数上限 / 是否要复核）
      const auth = checkRelayAuthorization({ task, seat, role })
      if (auth.ok !== true) return deny("RELAY_NOT_AUTHORIZED", auth.error)
      const policy = auth.policy

      // ② 该席位必须**上报过水位**，且达到触发线
      // ★ 席位 key 统一成 seat || role：非编写角色的 context_report 里 seat 是 null，
      //   用 seat 去比永远匹配不上（它会以 role 作为自己的席位标识）。
      const seatKey = seat || role
      const reports = (task.context_reports ?? []).filter((r) => (r.seat ?? r.role) === seatKey && r.role === role)
      const last = reports.at(-1)
      if (last === undefined) {
        return deny(
          "NO_CONTEXT_REPORT",
          `拒绝继任：席位 ${seat || role} **从未上报过上下文水位**。\n` +
            "★ 继任必须有依据 —— \"我觉得它快满了\"不是依据。\n" +
            "下一步：先让该席位调 pipeline_context_report 上报水位（百分比 + 依据）。",
        )
      }
      if (last.percent < policy.triggerContextPercent) {
        return deny(
          "BELOW_TRIGGER",
          `拒绝继任：席位 ${seat || role} 最近一次上报是 **${last.percent}%**，低于触发线 ${policy.triggerContextPercent}%。\n` +
            `依据：${last.basis}\n` +
            "★ 没到线就换班 = 白白丢掉一个还记得上下文的席位，新来的还得从头读一遍。",
        )
      }

      // ③ 必须有合法的 seat_handover 交接物
      const handover = [...(task.handoffs ?? [])].reverse().find(
        (h) => h.kind === "seat_handover" && (h.payload?.from_seat === seatKey || h.payload?.from_seat === seat || h.payload?.from_seat === role),
      )
      if (handover === undefined) {
        return deny(
          "NO_SEAT_HANDOVER",
          `拒绝继任：席位 ${seat || role} 没有产出 seat_handover 交接物。\n` +
            "★ 换班必须留交接物 —— 否则新来的席位从零开始，而那正是继任要避免的事。\n" +
            "必填：from_seat / to_seat / reason / progress_done / progress_todo / must_read_files（至少含需求档）" +
            " / key_decisions / open_questions / next_step / do_not_repeat。",
        )
      }
      if ((task.successions ?? []).some((s) => s.handoff_id === handover.handoff_id)) {
        return deny("HANDOVER_ALREADY_USED", `这份交接物（${handover.handoff_id}）已经用过了，不能重复继任。`)
      }
      return { ok: true, task, policy, lastReport: last, handover }
    },

    /** ★ 继任的第二步：落记录 + 把旧 agent 标记为"已退休"。令牌撤销由工具层做。 */
    async commitSuccession(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny("TASK_NOT_FOUND", `找不到任务 ${input.taskId}。`)
      task.successions = task.successions ?? []
      const generation = (task.successions.filter((s) => s.seat === input.seat).at(-1)?.generation ?? 1) + 1
      const rec = {
        succession_id: `SC-${shortHash(`${task.id}|${input.seat}|${task.successions.length}|${input.toAgent}`)}`,
        seat: input.seat,
        role: input.role,
        from_agent: input.fromAgent ?? null,
        to_agent: input.toAgent ?? null,
        handoff_id: input.handoffId,
        reason: input.reason ?? "",
        at: nowIso(now()),
        generation,
      }
      task.successions.push(rec)

      // ★ 更正 B：登记「当前联系人」—— 每个席位都该能查到"现在谁是指派者"。
      //   不登记的话，继任之后各席位还会把上报发给**已经退场的旧编排**。
      task.contacts = task.contacts ?? {}
      task.contacts[input.role] = {
        role: input.role,
        seat: rec.seat,
        agent_id: rec.to_agent,
        generation,
        since: rec.at,
        previous_agent: rec.from_agent,
      }

      const aentry = await audit(task.id, "main", "seat:succession", {
        succession_id: rec.succession_id,
        seat: rec.seat,
        role: rec.role,
        from_agent: rec.from_agent,
        to_agent: rec.to_agent,
        handoff_id: rec.handoff_id,
        generation,
        reason: rec.reason,
      })
      task.history.push(aentry)
      await persist(task)
      return { ok: true, task, succession: rec }
    },

    /** 取某席位当前有效的令牌记录（规划继任时要撤掉它）。 */
    activeSeatToken(taskId, role, seat) {
      return null
    },
  }
}
