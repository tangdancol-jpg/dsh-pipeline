// 记忆工具面 · `pipeline_recall`（只读切片）：参数表 + 人话摘要，判定与写盘**一律委托** lib/memory/**。
/**
 * dsh-pipeline · 工具面 · `pipeline_recall`（E0：只读切片）
 * ============================================================================
 * 它兑现的是痛点 A（设计 `01` §1）：**"要看之前发生了什么"今天只能整份读**
 * （`requirement.md` / `handoffs/*.json` / `reports/**`），读进来就下不去。
 * `pipeline_recall` 给的是**按相关性取回的切片**，并且有一个**硬的 token 上限**。
 *
 * ---------------------------------------------------------------------------
 * E0 的边界（设计 `06-分阶段.md` 的 E0 定义，一个字都不多）
 * ---------------------------------------------------------------------------
 *   · **不建库、不写盘、不注入** —— 数据源就是既有的 `.pipeline/` 档案；
 *   · 两路取回：**时间**（recency / 时间窗 / 某个任务）＋**关键词**（确定性切词计分）；
 *   · 合并去重后按分数定序，再用 {@link applyBudget} **硬截断**到上限。
 *
 * ★ 本文件按 `CONVENTIONS.md` §2 只做三件事：**参数表、人话摘要、委托调用**。
 *   切词 / 打分 / 定序 / 截断全在 `lib/memory/` 里（那样才能各自单测，不必造一个工具宿主）。
 *
 * ★ 为什么 `mutating` 不写：它是**只读**动作 —— 总开关关掉时**不拒绝它**
 *   （语义与 `pipeline_status` 同档，见 `SWITCH_SURFACES` 的 `mutating-tools` 那一行）。
 *
 * @module dsh-pipeline/lib/tools/memory
 */

import { agentIdOf } from '../guard.js'
import { S, tool } from './kit.js'
import { resolveBank } from '../memory/bank.js'
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  applyBudget,
  clampLimit,
  meterFrom,
  noteRecallUsage,
  pressureOf,
  reduceBudgetForPressure,
  wireLine,
} from '../memory/budget.js'
import { readArchive, readBank } from '../memory/load.js'
import { ensureLiveDoc } from '../memory/live-doc-write.js'
import { mergeRoutes } from '../memory/merge.js'
import { hostContextPressure, hostTurnOutline } from '../memory/reflect-source.js'
import { routeEntity } from '../memory/route-entity.js'
import { routeKeyword } from '../memory/route-keyword.js'
import { routeTime } from '../memory/route-time.js'

/** 工具名（唯一出处）。 */
export const RECALL_TOOL_NAME = 'pipeline_recall'

/** 候选条数的默认上限（`max_items`）。★ 有它才不会"500 条命中全算一遍分"。 */
export const DEFAULT_MAX_ITEMS = 20

/** `max_items` 的绝对天花板。 */
export const MAX_MAX_ITEMS = 200

/**
 * 一次 recall 最多从**记忆库**读几条（★ E2 起库也是数据源之一）。
 *
 * 有它才不会"库长到几千行以后一次 recall 把全库算一遍分"（设计 `05` §3 的
 * 「同一实体大量命中」那条边界的同一处置：**取够上限即停**）。
 */
export const MAX_BANK_LINES = 2000

/**
 * 取宿主的计价器（**懒读 + 绝不抛**）。
 *
 * 为什么不写进 `inject`：本插件只 `inject: ['tools']`（`index.js`），
 * `load-smoke` 把"服务依赖只有一个"写成了既有断言 —— 为一次只读取回多要一个
 * 服务依赖，会换来一条"少一个必需服务就装不上"的新失败面。所以这里**能拿到就用、
 * 拿不到就降级并如实报** `metered_by`（设计 `02` §5 的复用点仍然吃到了）。
 *
 * @param {object} deps
 * @returns {object|null}
 */
function hostTokenMeter(deps) {
  try {
    const svc = deps?.ctx?.tokenMeter
    return svc === null || svc === undefined ? null : svc
  } catch {
    return null
  }
}

/** 把毫秒钳到合法上限（`max_items`）。 */
function clampMaxItems(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_MAX_ITEMS
  const i = Math.floor(n)
  if (i < 1) return 1
  return i > MAX_MAX_ITEMS ? MAX_MAX_ITEMS : i
}

/**
 * 记忆工具面。
 *
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字
 * @param {object} ctx.deps
 * @param {object} ctx.store - 任务存储（`projectRoot` / `root` 是档案根的权威出处）
 * @param {(taskId:string)=>Promise<object|null>} ctx.load
 */
export function buildMemoryTools(ctx) {
  const { deps, store, load } = ctx

  const memoryRecall = tool(deps, {
    name: RECALL_TOOL_NAME,
    description:
      '【任何角色 · 只读】按相关性取回**记忆切片**，替代"把 requirement.md / handoffs/*.json 整份读进来"。' +
      'E2 起数据源 = **记忆库**（`.pipeline/_memory/memory.jsonl`，由 retain 自动积累）**＋既有 `.pipeline/` 档案**。' +
      '三路取回：**时间**（不传 `query` ⇒ 等价于"最近 N 条"；`task_id` / `since` / `until` 都是时间路的条件）' +
      '＋**关键词**（确定性切词计分，无模型、无向量）' +
      '＋**实体**（把查询里的任务 id / 路径 / 角色 / 状态 / 交接物折成实体键后**精确**命中：' +
      '`编写` 与 `writer`、`T-1` 与 `t-1`、`SRC\\A.JS` 与 `src/a.js` 是**同一个实体**）。' +
      `★ 返回内容有**硬的 token 上限**：默认 ${DEFAULT_LIMIT}，天花板 ${MAX_LIMIT}（超了夹到天花板并如实报 clamped）。` +
      '★ 典型用法：接手一张单之前问"这张单之前怎么走的" / 问"某个文件上次改动的结论是什么"。' +
      '★ 只读：不写盘、不注入、不建库。',
    parameters: {
      query: S('string', '关键词查询（可空；空 = 走时间路，等价于"最近 N 条"）。确定性切词：ASCII 连词、中文按字 + 二元组'),
      task_id: S('string', '只看这一张任务单（按档案里的 task_id / 交接物的 task_id 精确匹配）'),
      since: S('string', '时间窗起点（ISO 8601，含；可空 = 不限）'),
      until: S('string', '时间窗终点（ISO 8601，含；可空 = 不限）'),
      limit: S('number', `★ 返回内容的 token 上限（默认 ${DEFAULT_LIMIT}，天花板 ${MAX_LIMIT}；0 = 只要计数、不要内容）`),
      max_items: S('number', `候选条数上限（默认 ${DEFAULT_MAX_ITEMS}，天花板 ${MAX_MAX_ITEMS}）—— 防止"命中 500 条全算一遍分"`),
      project_dir: S('string', '显式指定项目目录（可空；缺省按 task_id 绑定的 project_dir，再退到本插件当前工作区）'),
    },
    output: {
      ok: S('boolean', '是否成功（取不到切片**不算失败**：返回空 + reason，见 summary）'),
      summary: S('string', '给人看的切片（**每一行就是被计价的那一行** —— 计价对象 = 返回对象）'),
      source: S('string', '数据源标识（`bank+archive` / `archive` / `bank`；E2 起记忆库也是数据源）'),
      reason: S('string', '为什么是空切片（取不到项目目录 / 档案目录不存在时为非空）'),
      scanned: S('string', '扫了什么（`TASKS:<n>` / `TASK:<id>`）'),
      candidates: S('number', '候选条目数（记忆库 + 既有档案的摘要，去重前）'),
      bank_records: S('number', '记忆库里读到的条数（0 = 库还没长出来；**不是错误**）'),
      bank_skipped: S('number', '记忆库里的坏行数（半行 JSONL —— 跳过并计数，不整库丢弃）'),
      count: S('number', '返回条数'),
      tokens: S('number', '★ 返回内容的计价 token（**必须 ≤ limit**）'),
      limit: S('number', '本次真正生效的上限（已夹过天花板）'),
      clamped: S('boolean', '上限是否被夹到天花板'),
      truncated: S('number', '被**单条截断**的条数（单条就超上限时）'),
      dropped: S('number', '因上限被丢掉的条数（丢的永远是**尾部**）'),
      skipped: S('number', '读档案时跳过的坏条目数（坏行不整库丢弃）'),
      metered_by: S('string', '计价器来源（`tokenMeter.estimateMessage` / `estimate-fallback`）'),
      dropped_reason: S('string', '被丢掉的尾部是"放不下"还是"超了 max_items"'),
      budget_reduced_by: S('string', '本次上限被谁下调（E5 起在水位到预警线及以上时为 `context-pressure`，否则空）'),
      pressure_percent: S('string', '★ E5：本次读到的**会话水位百分比**（读不到 ⇒ 空串，**不下调也不猜**）'),
      pressure_band: S('string', '★ E5：水位的档位（`ok` / `warn` / `succession` / `hard_limit` / `unknown`，档位由 `lib/context.js` 的 `levelOf()` 判）'),
      live_doc: S('string', '活文档（`MEMORY.md`）本次的状态：`REBUILT` / `UNCHANGED` / `FRESH` / `SWITCH_OFF` / `EMPTY_BANK` / `FAILED:…`（E3 的**读时惰性兜底**：库比文档新就先重建再返回）'),
      items: S('array', '切片段（每项含 id / at / kind / text / score / routes / tokens / truncated）', {
        items: { type: 'object', additionalProperties: true },
      }),
    },
    async run(args, exec) {
      const empty = {
        ok: true,
        source: 'archive',
        reason: '',
        scanned: '',
        candidates: 0,
        bank_records: 0,
        bank_skipped: 0,
        count: 0,
        tokens: 0,
        limit: 0,
        clamped: false,
        truncated: 0,
        dropped: 0,
        skipped: 0,
        metered_by: '',
        dropped_reason: '',
        budget_reduced_by: '',
        pressure_percent: '',
        pressure_band: 'unknown',
        live_doc: '',
        items: [],
      }

      // ---- ① 落在哪个项目目录 ------------------------------------------------
      //   顺序（每一步都写出来，避免"到底读了谁"说不清）：
      //     ① 显式 `project_dir` > ② `task_id` 绑定的 `project_dir` > ③ 本插件当前工作区。
      const taskId = String(args.task_id ?? '').trim()
      const explicitDir = String(args.project_dir ?? '').trim()
      let projectDir = explicitDir
      let via = explicitDir.length > 0 ? 'args.project_dir' : ''
      /** ★ E5：手边这张单的 `relayPolicy`（水位档位读它；没有就用 `lib/context.js` 的默认值）。 */
      let taskPolicy = null
      if (projectDir.length === 0 && taskId.length > 0) {
        const task = await load(taskId)
        taskPolicy = task?.roster?.relay_policy ?? null
        const bound = typeof task?.project_dir === 'string' ? task.project_dir.trim() : ''
        if (bound.length > 0) {
          projectDir = bound
          via = 'task.project_dir'
        }
      }
      if (projectDir.length === 0) {
        // ★ 退到**本插件当前的工作区**（`store.projectRoot` 是既有权威出处；
        //   `.pipeline` 就建在它下面 —— 见 `lib/store/base.js`）。
        const fallback = String(store?.projectRoot ?? '').trim()
        if (fallback.length > 0) {
          projectDir = fallback
          via = 'store.projectRoot（本插件当前工作区）'
        }
      }
      const bank = resolveBank(projectDir, taskId.length > 0 ? 'TASK_HAS_NO_PROJECT_DIR' : 'NO_PROJECT_DIR')
      const baseLimit = clampLimit(args.limit)
      const report = (partial) => ({ ...empty, limit: baseLimit.limit, ...partial })
      if (!bank.ok) {
        return report({
          reason: bank.reason,
          summary:
            `【记忆取回】**没有可读的档案根**（${bank.reason}）：没有给 project_dir，` +
            '也没有从 task_id 绑定的项目目录里读出来 —— **不猜落点、不建目录**。\n' +
            '  · 怎么让它可用（择一）：带上 `task_id`（若那张单绑过 project_dir），或显式给 `project_dir`。',
        })
      }

      // ---- ② 读既有档案 + **记忆库**（只读；坏行跳过并计数） ----------------
      const arch = await readArchive({ archiveDir: bank.archiveDir, taskId })
      // ★ E2：数据源 = **记忆库 + 既有档案**（设计 `06-分阶段.md` 的 E2 原话）。
      //   库不存在 / 为空 ⇒ 空数组（**不建目录、不报错** —— 建库是 retain 的事），
      //   所以 E0 的"零写盘"性质在 E2 一点没变（这一路只有 `readFile`）。
      const mem = await readBank(bank.memoryFile, { limit: MAX_BANK_LINES })
      // ★ 库里的排在前面：同一个 id 两边都有时（`merge` 保序去重），留**库**里那份 ——
      //   库是 retain 当时记下的事实，档案是事后重算的投影。
      const candidates = [...mem.records, ...arch.records]
      const bankCount = mem.records.length
      const sourceKind =
        bankCount > 0 ? (arch.records.length > 0 ? 'bank+archive' : 'bank') : 'archive'
      const maxItems = clampMaxItems(args.max_items)
      const { meter, metered_by } = meterFrom(hostTokenMeter(deps))

      // ---- ②b 活文档的**读时惰性兜底**（设计 `04` §3.5）--------------------
      //   ★ 为什么"读"也要写：3.1–3.3 那几个触发点漏掉一个时，活文档会长期陈旧
      //     而**没人会发现** —— 这一句就是那个兜底。判据是"库比活文档新"，
      //     而且**一旦写就幂等**（同内容不重写，mtime 不变）；库为空则一个字节都不动。
      //   ★ 会话投影（`turnOutline`）能拿到就带上；拿不到不算错，文档里如实写这一句。
      const outline = await hostTurnOutline({ ctx: deps?.ctx }, agentIdOf(exec))
      const liveDoc = await ensureLiveDoc(bank.projectDir, {
        records: mem.records,
        bankFile: bank.memoryFile,
        swOf: deps?.sw ?? null,
        outline: outline.outline,
        outlineNote: outline.note,
        warn: (m) => deps?.ctx?.logger?.warn?.(m),
      })

      // ---- ③ 三路取回 + 合并去重 + 硬截断 ----------------------------------
      //
      //   ★ 三路**不是无条件都上**（这条口径写死，测试钉住）：
      //     · 给了 `query` ⇒ 关键词路 + 实体路都上；一条都没命中就是**空切片**
      //       —— 不拿"最近若干条"来凑数（那会让人以为它相关）。
      //     · 没给 `query` ⇒ 时间路兜底（等价于"最近 N 条"）；
      //       实体路在有 `task_id` 时仍然上（"这张单的东西"本身就是一个实体条件）。
      const query = String(args.query ?? '').trim()
      const time = query.length === 0
        ? routeTime(candidates, { since: args.since, until: args.until, taskId, limit: maxItems })
        : []
      const keyword = routeKeyword(candidates, { query, limit: maxItems })
      const entity = routeEntity(candidates, {
        query,
        entities: taskId.length > 0 ? [`task:${taskId}`] : [],
        limit: maxItems,
      })
      // ---- ②c ★ E5：读**会话水位**并按水位下调本次上限（设计 `04` §7.2/§7.3）----
      //   · 档位**读既有阈值**（`lib/context.js` 的 `levelOf` + relayPolicy）——不新造一套；
      //   · 读不到水位 ⇒ **不下调、也不猜**（`pressure_band:'unknown'`，如实报）；
      //   · 下调**只减不增**：真正的硬上限仍然由 `applyBudget` 兜住（判据 R8 一点没松）。
      const pressureGot = await hostContextPressure({ ctx: deps?.ctx }, agentIdOf(exec))
      const pressure = pressureOf(pressureGot.pressure)
      const scaled = reduceBudgetForPressure(baseLimit.limit, pressure, taskPolicy ?? undefined)
      const merged = mergeRoutes({ entity, time, keyword }, { limit: maxItems })
      const budget = applyBudget(merged, { limit: scaled.limit, meter, metered_by })
      // ★ `clamped` 的口径要**合并两处**：天花板是在 `baseLimit` 上夹的（E0 起就有的语义），
      //   而现在传给 `applyBudget` 的已经是夹过的值 —— 不合并就会把"你给超了"这件事吞掉。
      const clamped = baseLimit.clamped || budget.clamped

      const lines = budget.items.map((it) => wireLine(it))
      const head =
        `【记忆取回】来源：${sourceKind}（记忆库 ${bankCount} 条 + 档案 ${arch.records.length} 条）\n` +
        `  · 查询：${query.length > 0 ? `\`${query}\`` : '(无 —— 走时间路：最近 N 条)'}` +
        `${taskId.length > 0 ? `｜任务：${taskId}` : ''}` +
        `${typeof args.since === 'string' && args.since.length > 0 ? `｜since: ${args.since}` : ''}\n` +
        `  · 档案根：${bank.archiveDir}（取自 ${via}；${arch.scan}；档案候选 ${arch.records.length} 条，跳过坏条目 ${arch.skipped} 条）\n` +
        `  · 记忆库：${bank.memoryFile}（读到 ${bankCount} 条，坏行 ${mem.skipped} 条${mem.reason.length > 0 ? `，${mem.reason}` : ''}）\n` +
        `  · 活文档：${bank.liveDoc}（本次 \`${liveDoc.reason}\`${liveDoc.written ? '，**已重建**' : ''}）\n` +
        `  · 上限：${budget.limit} token${clamped ? `（**被夹到天花板**；你给的是 ${String(args.limit)}）` : ''}` +
        `${scaled.reduced ? `（★ **水位 ${scaled.percent}% ⇒ 被 context-pressure 下调**（\`${scaled.band}\` 档）：${scaled.base} → ${scaled.limit}）` : ''}` +
        `｜本次用 ${budget.tokens}｜计量：${budget.metered_by}\n` +
        `  · 水位：${pressure === null ? `读不到（${pressureGot.note || '宿主没有可用投影'}）—— 不下调` : `${scaled.percent}%（档位 \`${scaled.band}\`，折扣 ×${scaled.factor}，来源 ${pressureGot.via}）`}\n` +
        `  · 取回 ${budget.items.length} 条（时间路 ${time.length} / 关键词路 ${keyword.length} / 实体路 ${entity.length}` +
        ` ⇒ 合并去重 ${merged.length} 条，丢 ${budget.dropped} 条${budget.truncated > 0 ? `，单条截断 ${budget.truncated} 条` : ''}）`
      const body = lines.length > 0 ? `\n切片（每行即被计价的内容）：\n${lines.join('\n')}` : '\n切片：（空 —— 没有命中）'
      const tail =
        budget.items.length === 0
          ? query.length > 0
            ? '\n★ 空切片不是错误：**这个查询**在记忆库与档案里都没有命中（没有拿"最近若干条"来凑数）。换个关键词，或去掉 `query` 看最近 N 条。'
            : '\n★ 空切片不是错误：记忆库与档案里确实没有命中，或还没到有记忆的时候。**不建库、不写盘。**'
          : ''

      const result = {
        ok: true,
        source: sourceKind,
        reason: '',
        scanned: arch.scan,
        candidates: candidates.length,
        bank_records: bankCount,
        bank_skipped: mem.skipped,
        count: budget.items.length,
        tokens: budget.tokens,
        limit: budget.limit,
        clamped,
        truncated: budget.truncated,
        dropped: budget.dropped,
        skipped: arch.skipped,
        metered_by: budget.metered_by,
        dropped_reason: budget.dropped > 0 ? 'budget-tail' : '',
        budget_reduced_by: scaled.reduced ? 'context-pressure' : '',
        pressure_percent: scaled.percent === null ? '' : String(scaled.percent),
        pressure_band: scaled.band,
        live_doc: liveDoc.reason,
        items: budget.items.map((it) => ({
          id: it.id,
          at: it.at,
          kind: it.kind,
          text: it.text,
          score: it.score,
          routes: it.routes,
          tokens: it.tokens,
          truncated: it.truncated === true,
          task_id: it.refs?.task_id ?? '',
          handoff: it.refs?.handoff ?? '',
        })),
        summary: `${head}${body}${tail}`,
      }
      // ★ E5（04 §7.4）：把本次用量留给 `pipeline_context_report`（进程内观测，不落盘）。
      noteRecallUsage({
        tokens: result.tokens,
        limit: result.limit,
        count: result.count,
        reduced_by: result.budget_reduced_by,
        project_dir: bank.projectDir,
      })
      return result
    },
  })

  return { memoryRecall }
}
