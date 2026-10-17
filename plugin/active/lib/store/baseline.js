/**
 * dsh-pipeline · 任务存储 · 改动基线与前后对比
 * ============================================================================
 * 从 `lib/store.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/store.js` 转出，调用方不需要改 import。
 *
 * @module dsh-pipeline/lib/store/baseline
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ROLE } from '../roles.js'
import { fullHash, isInside, nowIso, resolveAgainstAnchor } from '../util.js'
import {
  WRITE_LEDGER_FILE_NAME,
  WRITE_LEDGER_SOURCES,
  makeWriteLedgerEntry,
  parseWriteLedger,
  resetHashGateOrigin,
} from '../hashgate.js'
import { writeJsonAtomic, appendJsonl } from './shared.js'
// ★ 领域对象集中：改动基线记录的形状在 `lib/model/baseline.js`。
import { makeBaselineRecord } from '../model/baseline.js'
import { seatTouchedKeys, splitSelfTree } from '../hashgate/self-tree.js'

/**
 * 任务存储 · 改动基线与前后对比
 * 返回的方法由 `createTaskStore` 原位展开进同一个对象，方法里的 `this` 仍指向那个对象。
 * @param {object} ctx - `createTaskStore` 闭包里本组用到的名字（由 `lib/store.js` 原位传入）
 */
export function baselineMethods(ctx) {
  const {
    dirName,
    root,
    anchorOf,
    cmpKey,
    scopeAbsKey,
    baselineAbsKey,
    now,
    taskDir,
    audit,
    deny,
    loadTask,
    persist,
  } = ctx

  return {
    // --- ★改动基线（前后版本对比的基准）------------------------------------

    /**
     * ★ **记录改动基线**（派活那一刻的项目快照）。
     *
     * 用户原话：「**派活那一刻记录基线**（项目根的文件清单 + 每个文件的哈希；
     * 只存清单与哈希，不复制源码，避免体积膨胀），并让基线**可证明就是派活那一刻的状态**」。
     *
     * 三条设计：
     *   ① **只存清单与哈希**（不复制源码）：体积与"文件数"同阶，不随项目大小膨胀；
     *   ② **可证明**：记下 `taken_at` / `taken_by` / `plan_handoff_id`（绑定这次计划的交接物 id）
     *      与 `digest`（整份清单的 sha256）—— 三者一起构成"这一版基线就是那一刻的状态"；
     *   ③ **排除 `.pipeline/`**：那是流水线自己的台账（报告、记录、审计），
     *      它本来就会被写，算进基线只会让"改动面"永远对不上；
     *   ④ ★ **重取基线 = 新起点**：新基线一落地，就按 `resetHashGateOrigin`
     *      把"哈希闸门连续不通过"的计数归零、并作废基于旧基线算出的那份闸门判定
     *      （留痕 `gate:hash_reset`）。理由与边界见下方内联注释 ——
     *      **越界判定本身一个字没放宽**。
     *
     * @param {object} input
     * @param {string} input.taskId
     * @param {string} [input.by] - 谁记的（默认 planner）
     * @param {string} [input.planHandoffId]
     * @param {string} [input.note]
     */
    async takeBaseline(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const root = task.project_root
      const { readdir, stat, readFile: rf } = await import('node:fs/promises')
      const skipDir = String(dirName).toLowerCase()

      const files = {}
      let bytes = 0
      const walk = async (dir, rel) => {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (e.name.startsWith('.git')) continue
          const abs = join(dir, e.name)
          const r = rel.length === 0 ? e.name : `${rel}/${e.name}`
          if (e.isDirectory()) {
            if (r.toLowerCase() === skipDir) continue // 流水线台账不算改动面
            await walk(abs, r)
            continue
          }
          if (!e.isFile()) continue
          try {
            const st = await stat(abs)
            const buf = await rf(abs)
            files[r.replace(/\\/g, '/')] = { sha256: fullHash(buf.toString('utf8')), bytes: st.size }
            bytes += st.size
          } catch {
            /* 读不到就跳过（权限/临时文件）：基线宁可少一条，也不要整个失败 */
          }
        }
      }
      await walk(root, '')

      const digest = fullHash(JSON.stringify(Object.keys(files).sort().map((k) => `${k}|${files[k].sha256}`)))
      // 基线记录的形状集中在 `lib/model/baseline.js`（本文件只给上下文值）。
      const rec = makeBaselineRecord({ task, digest, files, bytes, now, input })
      task.baselines = task.baselines ?? []
      task.baselines.push(rec)
      // ⚠️ 顺序：**先**按"新基线 id"清旧起点，**再**把基线指针指过去 ——
      //    这样 `origin.prev_baseline_id` 记的才是"被换掉的那一份"，审计读得懂。
      const origin = resetHashGateOrigin(task, rec.baseline_id)
      task.baseline_current = rec.baseline_id

      // ★★ **重取基线 = 新起点**（本轮修的第二个拦路虎）------------------------
      //
      //   闸门判的是「**相对基线**的变化」。基线取早了（本单开工基线早于当晚几次
      //   基础设施前置修复）⇒ 那批**与本单无关**的改动会永远显示成"本单越界"，
      //   编写席修不掉（它撤不回别人的活），唯一出路就是重取基线。
      //   可早先重取基线**不清"连续不通过"的计数**：旧基线下的 1/3 跟着走到新基线，
      //   再攒两次就触发"机制自动交人工" —— 等于让编写替别人的改动挨那张人工单。
      //
      //   所以这里按 `resetHashGateOrigin` 把计数归零、并作废基于**旧基线**算出的
      //   那份闸门判定（它自己的 baseline_id 就是过期证据；留着会继续拦"跑测试"）。
      //
      //   ⚠️ **一个字都没放宽**：三类越界（新增/修改/删除清单外）与"声明不实"
      //      照旧被拒、照旧计数、照旧在连续 N 次后自动交人工 —— 改的只是**起点**。
      //   ⚠️ **不碰 `hash_gate_escalation`**：已经交到用户手上的单不会因为重取基线
      //      被悄悄撤回（机制不替用户撤单）。
      const file = join(taskDir(task.id), `baseline-${rec.baseline_id}.json`)
      await writeJsonAtomic(file, rec)
      rec.file = file
      const entry = await audit(task.id, rec.taken_by, 'baseline:take', {
        baseline_id: rec.baseline_id,
        file_count: rec.file_count,
        digest,
        plan_handoff_id: rec.plan_handoff_id,
      })
      task.history.push(entry)
      if (origin.changed) {
        // 留痕：事主要能回答"这次重取到底清掉了什么"。
        task.history.push(
          await audit(task.id, rec.taken_by, 'gate:hash_reset', {
            baseline_id: rec.baseline_id,
            prev_baseline_id: origin.prev_baseline_id,
            prev_streak: origin.prev_streak,
            now_streak: 0,
            prev_gate_baseline_id: origin.prev_gate_baseline_id,
            prev_gate_blocked: origin.prev_gate_blocked,
            why:
              '重取基线 = 新起点：连续不通过计数按新基线重新起算，基于旧基线算出的闸门判定一并作废。' +
              '三类越界判定与"声明不实"判定**一个字没放宽**（授权面之外的改动仍必须被拒）。',
          }),
        )
      }
      await persist(task)
      return { ok: true, task, baseline: rec, origin }
    },

    /** 取当前基线（读回记录）。 */
    currentBaseline(task) {
      const id = task?.baseline_current ?? null
      if (id === null) return null
      return (task.baselines ?? []).find((b) => b.baseline_id === id) ?? null
    },

    // --- ★★ 席位级写入台账（选项 B）：「谁改的」按**归属**判，而不是只看路径形状 ---
    //
    // 判据本体（三条不许破的线、为什么必须带哈希）在 `lib/hashgate.js` 顶部那一整段；
    // 这里只做两件事：**喂账本**（席位交东西的时候）与**读账本**（判定之前）。
    //
    // 为什么落点是 `.pipeline/<任务>/write-ledger.jsonl`：
    //   · **基线明确排除 `.pipeline/`** ⇒ 台账永远不会把自己变成一处"改动"
    //     （放别处的话，台账自己就会被判越界 —— 这是硬约束，不是偏好）；
    //   · 与 `audit.jsonl` 同级同性质：**只追加**，事后能回答"谁在什么时候写了什么路径"。

    /** 本单的台账文件（与 `audit.jsonl` 并排）。 */
    writeLedgerFileOf(taskId) {
      return join(taskDir(taskId), WRITE_LEDGER_FILE_NAME)
    },

    /**
     * ★★ **记一笔席位写入**：哪张单 / 哪个角色 / 哪个席位 / 哪个会话 / 哪份基线 /
     * 交出了哪些路径 / 那些路径**当时**的内容 sha256。
     *
     * 两条实现要点：
     *   ① **哈希优先取本次审计算出来的那份**（`changeAudit` 的 added/modified 带 sha256，
     *      它就是"现在这一刻"的内容哈希，不必再读一遍文件）；
     *   ② 声明里那些**本次审计没列出**的路径（相对本单基线没变过），**直读一次**补哈希；
     *      读不到就留 `null` —— 归属判据**不认没有哈希的证据**（宁可多拒）。
     *
     * ⚠️ 它**不是授权**、也**不拦任何提交**：写失败只留痕（见调用点的 `ledger:seat-write-failed`），
     *    因为台账是判据的**辅助证据**，不是判据本身 —— 证据缺了，判据退回严格那一支。
     *
     * @returns {Promise<{ok:boolean, written:number, entries:number, error:string|null}>}
     */
    async recordSeatWrites(spec) {
      const task = spec?.task ?? null
      const manifest = Array.isArray(spec?.manifest) ? spec.manifest : []
      if (task === null || typeof task !== 'object' || typeof task.id !== 'string') {
        return { ok: false, written: 0, entries: 0, error: '没有任务对象（内部调用错误）' }
      }
      if (manifest.length === 0) {
        return { ok: true, written: 0, entries: 0, error: null }
      }
      const hashByKey = new Map()
      for (const x of [...(spec?.audit?.added ?? []), ...(spec?.audit?.modified ?? [])]) {
        const key = baselineAbsKey(x?.path)
        if (typeof x?.sha256 === 'string' && x.sha256.length > 0) hashByKey.set(key, x.sha256.toLowerCase())
      }
      const anchor = anchorOf(task)
      const paths = []
      for (const m of manifest) {
        const raw = String(m?.path ?? '').trim()
        if (raw.length === 0) continue
        // ★ 用**本单自己的锚点**把路径解析成原始大小写的绝对路径（读文件要它），
        //   再算规范绝对键（小写 POSIX）—— 台账里存的是后者：读的人不必知道写的人用哪个锚点。
        const absRaw = resolveAgainstAnchor(anchor, raw)
        const key = absRaw.length === 0 ? '' : cmpKey(absRaw)
        if (key.length === 0) continue
        let sha = hashByKey.get(key) ?? null
        if (sha === null) {
          try {
            const buf = await readFile(absRaw)
            sha = fullHash(buf.toString('utf8')).toLowerCase()
          } catch {
            sha = null
          }
        }
        paths.push({ path: raw, key, sha256: sha })
      }
      const entry = makeWriteLedgerEntry({
        at: nowIso(now()),
        taskId: task.id,
        role: String(spec?.role ?? ''),
        seat: spec?.seat ?? null,
        agentId: spec?.agentId ?? null,
        baselineId: spec?.baselineId ?? null,
        submissionSeq: Number.isInteger(spec?.submissionSeq) ? spec.submissionSeq : null,
        source: WRITE_LEDGER_SOURCES.devManifest,
        paths,
      })
      if (entry === null) return { ok: true, written: 0, entries: 0, error: null }
      try {
        await appendJsonl(this.writeLedgerFileOf(task.id), entry)
      } catch (err) {
        return { ok: false, written: 0, entries: paths.length, error: String(err?.message ?? err) }
      }
      return { ok: true, written: 1, entries: paths.length, error: null }
    },

    /**
     * ★★ **读全部台账**（本单的 + 别单的）—— 判定之前调用。
     *
     * 「只能由**别的单**豁免本单」这条线**不在读这一侧**实现，而在
     * `lib/hashgate.js` 的 `buildForeignWriteIndex` 里（`task_id === 本单` 的行在那里被丢）
     * —— 一处实现，免得两边各写一份口径。
     *
     * 读不到 / 坏行 ⇒ 该行不算证据（**不猜、不半信半疑**）：坏行计数如实返回，写进审计。
     *
     * @returns {Promise<{entries:object[], damaged:number, files:number, list_error:string|null}>}
     */
    async loadSeatWriteLedger() {
      const entries = []
      let damaged = 0
      let files = 0
      let listError = null
      let names = []
      try {
        names = await readdir(root, { withFileTypes: true })
      } catch (err) {
        // 一个任务都还没有 / 目录读不到 ⇒ 空台账（判定退回严格那一支），但**说出来**。
        return { entries, damaged, files, list_error: String(err?.message ?? err) }
      }
      for (const e of names) {
        if (e === null || typeof e !== 'object' || e.isDirectory?.() !== true) continue
        try {
          const text = await readFile(join(root, e.name, WRITE_LEDGER_FILE_NAME), 'utf8')
          const parsed = parseWriteLedger(text)
          entries.push(...parsed.entries)
          damaged += parsed.damaged
          files += 1
        } catch {
          /* 这张单没有台账 / 读不到 ⇒ 跳过（**不猜**：没有证据就照旧严格） */
        }
      }
      return { entries, damaged, files, list_error: listError }
    },

    /**
     * ★ **前后版本对比**：拿基线逐文件对照当前状态。
     *
     * 产出用户点名要的三类结论：
     *   · **多改**（`unauthorized` + `added` 里清单外的）
     *   · **少改**（`missing`：授权了却没动）
     *   · **改错地方**（`unauthorized`：动的不是授权的那份）
     * 外加 `modified`（改了且在授权内）与 `removed`。
     *
     * 判据是**哈希比对 + 授权面逐条核对**，不看代码内容 —— 所以审核可以在
     * "不读代码"的前提下拿到判据式证据（与"控制角色不看代码"那条边界兼容）。
     */
    async changeAudit(input) {
      const task = await loadTask(input.taskId)
      if (task === null) return deny('TASK_NOT_FOUND', `找不到任务 ${input.taskId}。`)
      const base = this.currentBaseline(task)
      if (base === null) {
        return deny(
          'NO_BASELINE',
          `任务 ${task.id} 还没有**改动基线** —— 没有基线就做不了前后版本对比。\n` +
            '★ 基线应当在**派活那一刻**记录：有计划的单由 pipeline_plan 自动记；' +
            '**L0 的单由规则引擎在角色清单写入后自动记**（见 lib/store/l0-baseline.js）。\n' +
            '若这里仍然报没有基线：那张单是本次修复**之前**开的 —— 主对话可以补救一次：' +
            '`pipeline_change_audit { task_id: "...", take: true }`。',
        )
      }
      const snap = await this.takeBaselineSnapshot(task)
      const scope = Array.isArray(task.change_scope) ? task.change_scope : []
      /**
       * ★★ **"没有授权面" ≠ "违反了授权面"**（缺陷 ⑤ 的第二半，2026-10-15）。
       *
       * L0 刻意**不塞**一个"整棵项目根"的假授权（见 `store/roster.js`：
       * 「不塞一个'整棵项目根'的假授权：那只会制造'看起来在管、其实没管'的假执法」）
       * ⇒ 它的 `change_scope` 就是 `null`。
       *
       * 而本函数早先的判据是 `inScope(rel) === null ⇒ unauthorized` ——
       * 授权面为空时**每一条改动都命中这一条**，于是 L0 上任何写入都被算成"多改"、
       * `verdict` 恒为 `out_of_scope`。
       *
       * 这在缺陷 ⑤ 修好之前**看不出来**（L0 压根没有基线，本函数直接 `NO_BASELINE` 返回）；
       * 一旦 L0 也记了基线，它就会把**每一张 L0 单**都判成越界 —— 那是个更坏的结果。
       *
       * 所以留第三个结论 `no_scope`，**如实说清"这一判据在本单上不适用"**：
       *   · `unauthorized = []`（没有授权，就没有"越界"可言）；
       *   · `missing = []`（没有授权，就没有"少改"可言）；
       *   · 前后差异（`added` / `modified` / `removed`）**照给** ——
       *     那正是缺陷 ⑤ 要的"最小基线"的价值：审核至少拿得到"动了哪些文件"。
       */
      const hasScope = scope.length > 0

      const added = []
      const modified = []
      const removed = []
      // ★ 每条都带上哈希：打回理由要"可执行"（基线哈希 / 实际哈希 / 期望），
      //   光说"你越界了"编写还得自己去猜哪一处。
      for (const [rel, info] of Object.entries(snap.files)) {
        const before = base.files[rel]
        if (before === undefined) {
          added.push({ path: rel, bytes: info.bytes, sha256: info.sha256, baseline_sha256: null })
        } else if (before.sha256 !== info.sha256) {
          modified.push({ path: rel, bytes: info.bytes, sha256: info.sha256, baseline_sha256: before.sha256 })
        }
      }
      for (const rel of Object.keys(base.files)) {
        if (snap.files[rel] === undefined) {
          removed.push({ path: rel, bytes: base.files[rel].bytes, sha256: null, baseline_sha256: base.files[rel].sha256 })
        }
      }

      const inScope = (rel) => {
        // ★ 修 ③：两边先落到**同一个坐标系**（规范绝对键）再比。
        //   早先这里直接拿"相对项目根的基线键"去比 `scopeRelOf()` 出来的
        //   相对路径，而授权面条目一旦写成**绝对路径**就解析成 `null` ⇒
        //   那条授权被静默作废（真单 T-20261011-5a871c 的源码树两条）。
        const absFile = baselineAbsKey(rel)
        for (const e of scope) {
          const abs = scopeAbsKey(e?.path, task)
          if (abs.length === 0) continue
          if (isInside(abs, absFile)) return e
        }
        return null
      }
      // ★★ 缺陷 ⑧：插件自身文件不在授权面内、本单席位也没碰过的，单列进 self_tree，不进越界判据（见 lib/hashgate/self-tree.js）
      const seatKeys = seatTouchedKeys((await this.loadSeatWriteLedger()).entries, task.id)
      const self = splitSelfTree({
        diff: { added, modified, removed },
        knownPaths: [...Object.keys(base.files), ...Object.keys(snap.files)],
        isAuthorized: (rel) => hasScope && inScope(rel) !== null,
        touchedBySeat: (rel) => seatKeys.has(baselineAbsKey(rel)),
      })
      added.splice(0, added.length, ...self.added)
      modified.splice(0, modified.length, ...self.modified)
      removed.splice(0, removed.length, ...self.removed)

      const unauthorized = []
      if (hasScope) {
        for (const x of added) {
          if (inScope(x.path) === null) {
            unauthorized.push({ path: x.path, how: 'created_unauthorized', baseline_sha256: null, actual_sha256: x.sha256 ?? null })
          }
        }
        for (const x of modified) {
          if (inScope(x.path) === null) {
            unauthorized.push({ path: x.path, how: 'modified_unauthorized', baseline_sha256: x.baseline_sha256 ?? null, actual_sha256: x.sha256 ?? null })
          }
        }
        for (const x of removed) {
          if (inScope(x.path) === null) {
            unauthorized.push({ path: x.path, how: 'removed_unauthorized', baseline_sha256: x.baseline_sha256 ?? null, actual_sha256: null })
          }
        }
      }

      // 少改：授权了（modify/create）却**一点没动**的条目
      //
      // ★ 修 ③：这里早先直接拿授权条目的**原文**去比 `touched`（相对项目根的基线键）
      //   ⇒ 条目写成绝对路径时**永远**匹配不上，「少改」于是变成一条恒真的误报。
      //   改成与 `inScope` 同一套归一化：条目 → 规范绝对键，touched → 同一个坐标系。
      const touchedAbs = new Set([...added, ...modified].map((x) => baselineAbsKey(x.path)))
      const missing = []
      for (const e of hasScope ? scope : []) {
        const abs = scopeAbsKey(e?.path, task)
        if (abs.length === 0) continue
        if (e.action === 'delete') continue // 删除类不参与"少改"
        const hit = [...touchedAbs].some((t) => isInside(abs, t))
        if (!hit) missing.push({ scope_id: String(e.id ?? ''), path: String(e.path ?? '') })
      }

      /**
       * 三种结论（**第三种的措辞不许被读成"通过"**）：
       *   · `within_scope`    —— 有授权面，且实测全在面内；
       *   · `out_of_scope`    —— 有授权面，且实测有面外的改动；
       *   · `no_scope`        —— **本单没有授权面**（L0）："越界/少改"这两条判据
       *     在本单上**不适用**，本结论只给前后差异。
       */
      const verdict = hasScope ? (unauthorized.length === 0 ? 'within_scope' : 'out_of_scope') : 'no_scope'
      return {
        ok: true,
        task,
        baseline: { baseline_id: base.baseline_id, taken_at: base.taken_at, taken_by: base.taken_by, file_count: base.file_count, digest: base.digest },
        added,
        modified,
        removed,
        unauthorized,
        missing,
        verdict,
        /** ★ 本单有没有授权面（`false` ⇒ 上面那个 `unauthorized` 空数组是"不适用"，不是"全通过"）。 */
        has_scope: hasScope,
        no_scope_reason: hasScope
          ? ''
          : '本单**没有授权面**（L0 自批：没有"计划"这一站，`change_scope` 是 null）—— ' +
            '"多改 / 少改 / 改错地方"三条判据在本单上**不适用**；下面的 added / modified / removed 是**前后差异**，不是"越界"结论。',
        self_tree: self.excluded, // ★ 缺陷 ⑧：被排除的插件自身文件（路径 · 类别 · 增改删）
        profile_root: self.profileRoot, // 项目根是不是装着本插件的 profile
        counts: { added: added.length, modified: modified.length, removed: removed.length, unauthorized: unauthorized.length, missing: missing.length, self_tree: self.counts },
      }
    },

    /** 扫一遍当前项目根（基线用的同一个算法）。 */
    async takeBaselineSnapshot(task) {
      const { readdir, stat, readFile: rf } = await import('node:fs/promises')
      const skipDir = String(dirName).toLowerCase()
      const files = {}
      const walk = async (dir, rel) => {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (e.name.startsWith('.git')) continue
          const abs = join(dir, e.name)
          const r = rel.length === 0 ? e.name : `${rel}/${e.name}`
          if (e.isDirectory()) {
            if (r.toLowerCase() === skipDir) continue
            await walk(abs, r)
            continue
          }
          if (!e.isFile()) continue
          try {
            const st = await stat(abs)
            const buf = await rf(abs)
            files[r.replace(/\\/g, '/')] = { sha256: fullHash(buf.toString('utf8')), bytes: st.size }
          } catch {
            /* 同上：读不到就跳过 */
          }
        }
      }
      await walk(task.project_root, '')
      return { files }
    },
  }
}
