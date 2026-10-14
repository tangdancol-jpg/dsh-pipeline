/**
 * dsh-pipeline · **哈希前置闸门**（排在一切测试之前）
 * ============================================================================
 * 用户原话：
 *   「**先过哈希对比，哈希对比不过全量测试直接打回**」
 *
 * ---------------------------------------------------------------------------
 * 它在流程里的位置（这是本模块存在的全部理由）
 * ---------------------------------------------------------------------------
 *
 *   编写交产物（dev_to_test）
 *     └─ ① 形状核对：change_manifest 每条引用一个存在的授权条目（既有）
 *     └─ ② ★**哈希闸门**：按派活基线逐文件比 —— 新增 / 修改 / 删除三类都查
 *          ├─ 通过（实际改动面 ⊆ 授权面，且声明与实际一致）→ 放行 → 进测试
 *          │    └─ ★ **连续不过的计数归零**（唯一的归零点）
 *          └─ 不通过 → **直接打回编写**：
 *               · 不进入测试（状态停在"开发中"）
 *               · **不消耗测试预算**（也不消耗 `maxReworkPerLeg` —— 打回严格说没发生）
 *               · **不进"是否跑全量"的审批链**
 *               · ★ 连续不过计数 +1；**连续 N 次**（`hashGateEscalateAfter`，默认 3）
 *                 ⇒ **机制自动交人工**（走既有的 human_request / 两级梯），
 *                 并在用户答复之前**拒收**同一任务的再次提交
 *     └─ ③ 之后的才是：测试 → 审核 → 关单
 *
 * **设计意图：不合格的提交不该消耗测试资源。** 让测试去跑一套注定被打回的产物，
 * 是纯浪费 —— 时间、token、以及测试角色的注意力。这是省时间省 token 的**第一道闸**。
 *
 * **为什么还要"连续 N 次就交人工"**：不消耗打回预算有一个副作用 ——
 * 编写**可以无限重交**。预算是为"来回拉锯"设的（打回真的发生过），
 * 而闸门不通过时任务从未离开"开发中"，那笔预算不该被扣；所以堵这个副作用的
 * 正确位置不是"扣预算"，而是"**连续 N 次不过就把人请回来**"（用户 P13 的拍板）。
 *
 * ---------------------------------------------------------------------------
 * 判定口径（三类 + 一类"声明不实"）
 * ---------------------------------------------------------------------------
 *   比对对象 = ① 派活那一刻的**基线**（文件清单 + 每个文件的 sha256）
 *             ② 计划给的**授权改动面**（change_scope）
 *             ③ 编写自己交的**改动声明**（change_manifest）
 *
 *   · **新增**（基线里没有、现在有）—— 不在授权面内 ⇒ 越界
 *   · **修改**（两边都有、哈希不同）—— 不在授权面内 ⇒ 越界
 *   · **删除**（基线里有、现在没有）—— 不在授权面内 ⇒ 越界
 *   · **声明不实**：实际动了、但 change_manifest 里没报 ⇒ 也算不过
 *     （哈希是真相，声明是承诺，两者必须对得上）
 *
 * ⚠️ **L0 没有"计划"这一站 ⇒ 没有基线**，所以这道闸在 L0 上**不适用**
 *    （与"改动面 = 授权面"那条同源，见 README 待拍板 P4）。
 *
 * @module dsh-pipeline/lib/hashgate
 */

// ★ 本模块刻意保持"无 IO、纯判据"。唯一的依赖是**角色常量**（不引第二份字面量：
//   席位台账要按"谁是编写席"分账，写死字符串迟早与 `lib/roles.js` 漂移）。
import { ROLE } from './roles.js'

/** 越界类型 → 人话。 */
const HOW_ZH = {
  created_unauthorized: '新增了**清单外**的文件',
  modified_unauthorized: '修改了**清单外**的文件',
  removed_unauthorized: '删除了**清单外**的文件',
  undeclared_change: '动了但**没在改动声明里报**（声明与实际不一致）',
}

/**
 * ★★ **机器产物**（`tests/*-last-run.txt`）—— 「谁改的」分账口径（T-20261011-56a37e 追加项 ①）。
 *
 * ---------------------------------------------------------------------------
 * 现场（上一个外包会话用真函数复现，可直接采信）
 * ---------------------------------------------------------------------------
 *   同一张单里，**测试席跑测试**留下的 `tests/*-last-run.txt` 等机器产物脚印，
 *   被算成**编写席**"未申报"：实测 `unauthorized=0` 但 `undeclared=2`（那两条编写席
 *   根本没碰过）⇒ `pass=false`，编写被这道闸反复打回。
 *
 *   根因：`store.changeAudit()` 算的是"**基线以来的所有变化**"，它**没有任何归属信息**
 *   —— 不问是谁写的。于是"测试台自己写的运行产物"和"编写偷偷改的文件"在它眼里一样。
 *
 * ---------------------------------------------------------------------------
 * 修法（**选项 A：排除机器产物**，最小改动）
 * ---------------------------------------------------------------------------
 *   把"**由跑测试自动产生、且不属于任何席位**"的那一类文件从 `undeclared` 计算里排除。
 *   ★ 名单是**白名单 + 收得很紧**：只认插件自带测试台自己写的运行产物
 *     （`tests/last-run.txt` 与 `tests/<套件名>-last-run.txt`）。
 *     源码（`tests/*.mjs`）、夹具、以及任何别的文件**都不在名单里**，照旧要申报。
 *
 * ★★ **为什么这不放松闸门**（两条硬论证，可机械复核）
 *   ① **越界那一支一个字节没动**：`unauthorized` 仍然由 `changeAudit` 按授权面算，
 *      机器产物只要**落在授权面之外**，照样进 `unauthorized` ⇒ 照样 `pass=false`。
 *   ② **豁免只对"没被判越界"的路径生效**（见 `hashGateVerdict` 里的 `unauthorizedKeys`）：
 *      一条路径只要出现在 `audit.unauthorized` 里，它就**不会**被豁免 ——
 *      于是"豁免"在数学上不可能掩盖任何一处越界改动。
 *      推论：豁免影响到的只可能是"**本来就在授权面内**"的机器产物，
 *      即"被授权的那点噪声不该逼编写去为它背书"。
 *
 * ⚠️ **残余风险（如实写出来）**：如果某张单把 `tests/` 授权给了编写席，
 *   而编写把一处真实改动**故意命名**成 `tests/<随便什么>-last-run.txt`，
 *   它会落进豁免。这是选项 A 的已知代价；选项 B（席位级写入台账）能根治，
 *   但那是"改动更大的分账机制"，本单按"拿不准就选最保守的"取了 A，
 *   并把这条残余风险写进交付说明与测试台（反例只覆盖"非机器产物"那一侧）。
 *
 * ★ 豁免**不静默**：被豁免的路径逐条进 `verdict.ignored_machine_artifacts` 与
 *   `counts.machine_artifacts`，并进 `store` 的 `hash_gate_checks` / `gate:hash` 审计行。
 */
export const MACHINE_ARTIFACT_BASENAMES = [
  /** 汇总报告（`tests/last-run.txt`；`tests/selftest.mjs` 也会写它）。 */
  /^last-run\.txt$/i,
  /** 逐套原始输出（`tests/<suite>-last-run.txt`；`run-all.mjs` 写这些）。 */
  /^[a-z0-9._-]+-last-run\.txt$/i,
]

/**
 * 这条路径是不是**机器产物**（测试台自己写的运行产物）。
 *
 * 判据只用两样：**目录段是 `tests`** + **文件名命中上面那张白名单**。
 * 不做任何"猜测式"匹配（不看内容、不看是不是二进制、不看大小）——
 * 猜的判据迟早会把某一处真实改动吞掉。
 *
 * @param {string} p
 * @returns {boolean}
 */
export function isMachineArtifactPath(p) {
  const s = String(p ?? '').replace(/\\/g, '/').toLowerCase()
  if (s.length === 0) return false
  const i = s.lastIndexOf('/')
  const dir = i < 0 ? '' : s.slice(0, i)
  const base = i < 0 ? s : s.slice(i + 1)
  if (!/(^|\/)tests$/.test(dir)) return false
  return MACHINE_ARTIFACT_BASENAMES.some((re) => re.test(base))
}

// ===========================================================================
// ★★ 席位级**写入台账**（选项 B）—— 「谁改的」按**归属**判，而不是只看路径形状
// ===========================================================================
//
// 用户点名要的根治方案。它同时对着两个同源的现场：
//
//   · **P2-13（实际损失，2026-10-14）**：真单 T-20261011-5a871c 第一层**已经干完**
//     （7 个文件 · 两棵树哈希一致 · 本层判据 56/56），却因为闸门拿的是开工那一刻的
//     15,925 个文件指纹、其中混进了 **102 处别的单 / 别的插件 / 根配置 / 备份件 /
//     结构数据目录**的改动 ⇒ 机械判定【一处对不上就整单拒收】⇒ **活干完了交不上去**。
//     根因一句话：**闸门不知道"这处改动是不是本单改的"**。
//   · **P1-5 的残余风险**：机器产物豁免只按**路径形状**认 —— 若某单把 `tests/` 授权给
//     编写席，而编写把一处真实改动**故意命名**成 `tests/<随便什么>-last-run.txt`，
//     它会落进豁免。
//
// ---------------------------------------------------------------------------
// 归属判据（这是本模块**唯一**新增的放宽点，而且是**证据式**的）
// ---------------------------------------------------------------------------
//   一条路径被**另一张单的席位**在它自己的 `dev_to_test` 交接物里声明过
//   （`change_manifest[].path` 逐条），**并且当前内容与那张单当时产出的 sha256
//   逐字节一致** ⇒ 当前这份内容**可证明是那张单的产物**，不是本单的改动。
//   ⇒ 不计入本单的「越界 / 声明不实」，改为计入 `verdict.attributed_foreign`
//     （**不静默**：谁归属给了谁、凭什么，逐条列出来）。
//
//   ★ **为什么必须带哈希**（否则就是真漏路）：只按路径认，会放开
//     「本单编写席越界改了 `lib/x.js`，而另一张单**恰好也声明过** `lib/x.js`」
//     —— 那处越界会被算成别人的活。带上"**当前内容 == 那张单产出的内容**"之后，
//     只要本单动过它哪怕一个字节，哈希就对不上 ⇒ **照旧判越界**。
//
// ---------------------------------------------------------------------------
// 三条不许破的线（下面每一条在 `hashGateVerdict` / `buildForeignWriteIndex` 里都有落点）
// ---------------------------------------------------------------------------
//   ① **只有"别的单"能豁免本单**：本单自己的台账条目**永远不豁免本单**
//      （自己声明自己 = 既有那套"改动声明 ↔ 实际改动"对账，不是归属豁免）。
//   ② **哈希拿不到就不算证据**：任一侧缺 sha256（目录、删除、读不到）⇒ 不豁免
//      ⇒ 与改前**逐字相同**地拒。
//   ③ **越界的硬栏杆不撤**：`unauthorizedKeys` 仍然由**原始**越界清单构造 ——
//      一条路径只要被判越界，机器产物豁免就吞不掉它（原文那条硬论证原样保留）。
//
// ---------------------------------------------------------------------------
// 谁在什么时候喂账本（喂的时机与落点见 `lib/store.js` 的 `recordSeatWrites`）
// ---------------------------------------------------------------------------
//   每次 `dev_to_test` 提交、**在闸门判定之前**，把
//   「哪张单 / 哪个角色 / 哪个席位 / 哪个会话 / 哪份基线 / 交了哪些路径 / 这些路径
//     当时的内容 sha256」追加一行（只追加，永不覆盖、永不删）。
//
//   ⚠️ **它记的是"席位自己交上来的改动面"，不是"它偷偷写过的每个字节"** ——
//   后者需要**写拦截**（守门那一层才看得见工具调用的目标路径），而守门不在本单的
//   改动范围内。所以这条台账把"有证据的归属"做扎实了，把"无证据的写入"留给
//   既有的严格判据（**没证据 ⇒ 照旧拒**）。这个边界在交付报告里如实写明。
//
//   ★ 台账文件本身落在 `.pipeline/<任务>/` 里 —— 那是**基线明确排除**的目录，
//     所以台账永远不会把自己变成一处"改动"。

/** 台账文件名（落在 `.pipeline/<任务>/` 下，与 `audit.jsonl` 同级、同性质：只追加）。 */
export const WRITE_LEDGER_FILE_NAME = 'write-ledger.jsonl'

/** 台账行类型标记（读的时候据此**丢弃**不是台账的行 —— 坏行不许污染判据）。 */
export const WRITE_LEDGER_KIND = 'seat-write'

/** 台账行的来源标记（"这条归属是怎么来的"）。 */
export const WRITE_LEDGER_SOURCES = {
  /** 编写席的 `dev_to_test.change_manifest`（席位**自己交上来的改动面**）。 */
  devManifest: 'dev_to_test.change_manifest',
}

/**
 * 造一行台账（**纯函数**：只整形，不落盘、不读盘）。
 *
 * @param {object} spec
 * @param {string} spec.at - ISO 时间
 * @param {string} spec.taskId - 哪张单
 * @param {string} spec.role - 哪个角色（`writer` / `tester` / …）
 * @param {string|null} [spec.seat] - 哪个席位（`writer#1` …）
 * @param {string|null} [spec.agentId] - 哪个会话（agent / session id）
 * @param {string|null} [spec.baselineId] - 相对哪份基线交的
 * @param {number|null} [spec.submissionSeq] - 这次提交在 `task.handoffs` 里的序号（事后可核）
 * @param {string} [spec.source] - 来源标记（见 `WRITE_LEDGER_SOURCES`）
 * @param {object[]} spec.paths - `[{ path, key, sha256 }]`：`key` = **规范绝对键**
 *   （小写 POSIX；由 `store` 用它自己那套锚点算好 —— 台账里存绝对键，
 *   读的人不必知道写的人用的是哪个锚点）
 * @returns {object|null} 一行台账；`paths` 为空（或没有 taskId）时返回 `null`（不写空行）
 */
export function makeWriteLedgerEntry(spec = {}) {
  const paths = []
  for (const p of Array.isArray(spec.paths) ? spec.paths : []) {
    const raw = String(p?.path ?? '').replace(/\\/g, '/').trim()
    const key = String(p?.key ?? '').replace(/\\/g, '/').trim().toLowerCase()
    if (raw.length === 0 || key.length === 0) continue
    const sha = typeof p?.sha256 === 'string' && p.sha256.length > 0 ? p.sha256.toLowerCase() : null
    paths.push({ path: raw, key, sha256: sha })
  }
  const taskId = String(spec.taskId ?? '').trim()
  if (paths.length === 0 || taskId.length === 0) return null
  return {
    t: WRITE_LEDGER_KIND,
    at: String(spec.at ?? ''),
    task_id: taskId,
    role: String(spec.role ?? ''),
    seat: spec.seat === null || spec.seat === undefined ? null : String(spec.seat),
    agent_id: spec.agentId === null || spec.agentId === undefined ? null : String(spec.agentId),
    baseline_id: spec.baselineId ?? null,
    submission_seq: Number.isInteger(spec.submissionSeq) ? spec.submissionSeq : null,
    source: String(spec.source ?? ''),
    paths,
  }
}

/**
 * 读一份台账文本（只追加的 JSONL）—— **坏行丢掉并计数，绝不半信半疑地用**。
 *
 * @param {string} text
 * @returns {{entries:object[], damaged:number}}
 */
export function parseWriteLedger(text) {
  const entries = []
  let damaged = 0
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim()
    if (s.length === 0) continue
    let o = null
    try {
      o = JSON.parse(s)
    } catch {
      damaged += 1
      continue
    }
    if (o === null || typeof o !== 'object' || o.t !== WRITE_LEDGER_KIND || typeof o.task_id !== 'string' || !Array.isArray(o.paths)) {
      damaged += 1
      continue
    }
    entries.push(o)
  }
  return { entries, damaged }
}

/**
 * 把"**别的单**写过的路径"编成索引：规范绝对键 → 候选归属（可能多条，逐个比哈希）。
 *
 * ★ 线 ① 的落点：`task_id === selfTaskId` 的条目**在这里就被丢掉** ——
 *   本单永远豁免不了本单（想豁免自己请走既有的"改动声明"那套对账）。
 *
 * @param {object[]} entries - 台账里的全部行（本单的 + 别单的）
 * @param {string} selfTaskId - 本单 id
 * @returns {Map<string, object[]>}
 */
export function buildForeignWriteIndex(entries, selfTaskId) {
  const self = String(selfTaskId ?? '')
  const index = new Map()
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e === null || typeof e !== 'object') continue
    const tid = String(e.task_id ?? '')
    if (tid.length === 0 || tid === self) continue
    for (const p of Array.isArray(e.paths) ? e.paths : []) {
      const key = String(p?.key ?? '').trim().toLowerCase()
      if (key.length === 0) continue
      const list = index.get(key) ?? []
      list.push({
        task_id: tid,
        role: typeof e.role === 'string' && e.role.length > 0 ? e.role : null,
        seat: e.seat ?? null,
        agent_id: e.agent_id ?? null,
        at: typeof e.at === 'string' && e.at.length > 0 ? e.at : null,
        source: typeof e.source === 'string' && e.source.length > 0 ? e.source : null,
        sha256: typeof p?.sha256 === 'string' && p.sha256.length > 0 ? p.sha256.toLowerCase() : null,
      })
      index.set(key, list)
    }
  }
  return index
}

/**
 * 把"**本单某些角色**写过的路径"编成索引（用于收回机器产物豁免 —— 只会**更严**）。
 *
 * @param {object[]} entries
 * @param {string} selfTaskId
 * @param {string[]} [roles] - 默认 `['writer']`（与 `lib/roles.js` 的 `ROLE.WRITER` 同源）
 * @returns {Map<string, object[]>}
 */
export function buildSeatWriteIndex(entries, selfTaskId, roles) {
  const self = String(selfTaskId ?? '')
  const want = (Array.isArray(roles) && roles.length > 0 ? roles : [ROLE.WRITER]).map(String)
  const index = new Map()
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e === null || typeof e !== 'object') continue
    if (String(e.task_id ?? '') !== self) continue
    if (!want.includes(String(e.role ?? ''))) continue
    for (const p of Array.isArray(e.paths) ? e.paths : []) {
      const key = String(p?.key ?? '').trim().toLowerCase()
      if (key.length === 0) continue
      const list = index.get(key) ?? []
      list.push({
        role: String(e.role ?? ''),
        seat: e.seat ?? null,
        at: typeof e.at === 'string' && e.at.length > 0 ? e.at : null,
        source: typeof e.source === 'string' && e.source.length > 0 ? e.source : null,
        sha256: typeof p?.sha256 === 'string' && p.sha256.length > 0 ? p.sha256.toLowerCase() : null,
      })
      index.set(key, list)
    }
  }
  return index
}

/**
 * 这处改动能不能归到**别的单**头上（★ 线 ② 的落点：两边哈希都有、且相等才算）。
 *
 * @param {Map<string, object[]>} index - `buildForeignWriteIndex` 的产物
 * @param {string} key - 这处改动的**规范绝对键**
 * @param {string|null|undefined} sha256 - 这处改动**当前**的内容哈希
 * @returns {object|null} 归属证据（谁的单 / 谁的角色席位 / 什么时候 / 来源）；拿不到证据返回 `null`
 */
export function foreignAttributionOf(index, key, sha256) {
  const k = String(key ?? '').trim().toLowerCase()
  const h = typeof sha256 === 'string' && sha256.length > 0 ? sha256.toLowerCase() : null
  if (k.length === 0 || h === null) return null
  const list = index instanceof Map ? index.get(k) : null
  if (!Array.isArray(list)) return null
  for (const c of list) {
    if (c.sha256 !== null && c.sha256 === h) return c
  }
  return null
}

/**
 * 这处改动是不是**本单某个角色**（默认编写席）按哈希认领过的（用于**收回**机器产物豁免）。
 *
 * @param {Map<string, object[]>} index - `buildSeatWriteIndex` 的产物
 * @param {string} key
 * @param {string|null|undefined} sha256
 * @returns {object|null}
 */
export function seatClaimOf(index, key, sha256) {
  const k = String(key ?? '').trim().toLowerCase()
  const h = typeof sha256 === 'string' && sha256.length > 0 ? sha256.toLowerCase() : null
  if (k.length === 0 || h === null) return null
  const list = index instanceof Map ? index.get(k) : null
  if (!Array.isArray(list)) return null
  for (const c of list) {
    if (c.sha256 !== null && c.sha256 === h) return c
  }
  return null
}

/**
 * 从 `store.changeAudit()` 的结果算出闸门判定。
 *
 * @param {object} audit - changeAudit 的返回值
 * @param {object[]} [manifest] - 编写交的 change_manifest
 * @param {object} [opts] - ★ 路径归一化器（本轮修 ③「授权面用绝对路径、校验只认相对路径」）
 * @param {(p:string)=>string} [opts.absOfDeclared] - `change_manifest[].path` → 规范绝对键
 *   （按**授权面锚点**解析：绝对路径原样归一化，裸相对路径拼到锚点下）
 * @param {(p:string)=>string} [opts.absOfTouched] - 审计里那条路径（**相对项目根的基线键**）
 *   → 同一个坐标系里的绝对键
 *
 *   ← 为什么必须有这两个：`touched` 的路径是**相对项目根**的（`audit` 由基线算出来），
 *   而编写在 `change_manifest` 里完全可能按授权面的写法填**绝对路径**（本单授权面就是
 *   绝对路径）。两条字符串直接比 ⇒ 实际动过的那条**永远**盖不住声明 ⇒ 每一处改动
 *   都被判"声明不实"。归一到同一个坐标系之后，"同一个文件身份"才对得上。
 *   ⚠️ 这是**附加**判据：下面那套字符串前缀比对**原样保留**，只会少报"声明不实"，
 *      **不会**让任何一处越界改动（`unauthorized`）放行 —— 那一支一个字节没动。
 * @param {object[]} [opts.writeLedger] - ★★ **席位级写入台账**的全部行（本单的 + 别单的，
 *   由 `store` 读盘后原样传进来；见模块顶部「席位级写入台账」）
 * @param {string} [opts.writeLedgerTaskId] - 本单 id（台账里 `task_id === 它` 的行
 *   **永远不豁免本单** —— 线 ①）
 * @param {string[]} [opts.writerRoles] - 哪些角色算"编写席"（默认 `['writer']`；只影响
 *   机器产物豁免的**收回**方向，即只会更严）
 * @returns {{pass:boolean, violations:object[], counts:object, summary:string}}
 */
export function hashGateVerdict(audit, manifest = [], opts = {}) {
  const violations = []
  /**
   * ★★ 归属给**别的单**的改动（不静默：逐条列出来，谁归属给了谁、凭什么）。
   * ⚠️ **按路径去重**：同一条路径可能同时被"越界"和"声明不实"两支碰到，
   *    但对人来说它只该出现一次（"这处改动是别人的"）。
   */
  const attributedForeign = []
  const attributedForeignKeys = new Set()
  const noteForeign = (path, how, extra) => {
    const k = String(path ?? '').replace(/\\/g, '/').toLowerCase()
    if (k.length === 0 || attributedForeignKeys.has(k)) return
    attributedForeignKeys.add(k)
    attributedForeign.push({ path, how, ...extra })
  }
  /**
   * ★ 声明面与改动面各自的归一化器（缺任一个就退回纯字符串比对 = 历史行为）。
   * ⚠️ 位置在**函数最前面**：它同时被 ①（越界那一支的归属判据）与 ②（声明对账）用。
   */
  const { absOfDeclared, absOfTouched } = opts
  const canAbs = typeof absOfDeclared === 'function' && typeof absOfTouched === 'function'
  const safeAbs = (fn, p) => {
    try {
      return String(fn(p) ?? '')
    } catch {
      return ''
    }
  }
  /**
   * ★★ 席位级写入台账（见模块顶部那一整段）：**只**用于两件事 ——
   *   ① 把"可证明是别的单的产物"从本单的越界/未申报里排除出去（**带哈希证据**）；
   *   ② 收回"本单编写席按哈希认领过的"机器产物豁免（这个方向只会**更严**）。
   * 台账为空 / 读不到 / 坏行 ⇒ 两个索引都是空 Map ⇒ 判定与改前**逐字相同**。
   */
  const writeLedger = Array.isArray(opts.writeLedger) ? opts.writeLedger : []
  const writeLedgerTaskId = String(opts.writeLedgerTaskId ?? '')
  const foreignWriteIndex = buildForeignWriteIndex(writeLedger, writeLedgerTaskId)
  const writerClaimIndex = buildSeatWriteIndex(writeLedger, writeLedgerTaskId, opts.writerRoles)

  // ① 三类越界（新增 / 修改 / 删除，只要不在授权面内）
  for (const x of Array.isArray(audit?.unauthorized) ? audit.unauthorized : []) {
    // ★★ 归属判据（见模块顶部）：这处改动**可证明是别的单的产物**（另一张单的席位
    //    声明过这条路径，且当前内容与它当时产出的哈希逐字节一致）⇒ 不算本单越界。
    //    ⚠️ 拿不到哈希（删除 / 目录 / 读不到）⇒ `foreignAttributionOf` 返回 null
    //       ⇒ 这一支与改前**逐字相同**地进 violations。
    const attr = foreignAttributionOf(
      foreignWriteIndex,
      canAbs ? safeAbs(absOfTouched, x?.path) : '',
      x?.actual_sha256 ?? null,
    )
    if (attr !== null) {
      noteForeign(x.path, x.how, {
        baseline_sha256: x.baseline_sha256 ?? null,
        actual_sha256: x.actual_sha256 ?? null,
        attributed_to: attr,
        evidence: `另一张单（${attr.task_id}）的${attr.role ?? '席位'}${attr.seat === null ? '' : `#${String(attr.seat).replace(/^[^#]*#/, '')}`}在 ${attr.at ?? '(时间未记)'} 的 ${attr.source ?? '交接物'} 里声明过这条路径，且当前内容的 sha256 与它当时产出的**逐字节一致**`,
      })
      continue
    }
    violations.push({
      how: x.how,
      zh: HOW_ZH[x.how] ?? x.how,
      path: x.path,
      baseline_sha256: x.baseline_sha256 ?? null,
      actual_sha256: x.actual_sha256 ?? null,
      expected: '要么撤回这处改动，要么让计划 AI 把该路径补进 change_scope 拿到新授权',
    })
  }

  // ② 声明不实：实际动了、但没在 change_manifest 里报
  //
  //    判据：把 changeAudit 算出的"实际动过"与 manifest 里的 path 对一遍。
  //    为什么也算不过：哈希是**真相**，声明是**承诺**；两者不一致时，
  //    测试与审核按声明去核对就等于核对了假的 —— 那比越界更危险（越界至少看得见）。
  const declared = new Set(
    (Array.isArray(manifest) ? manifest : [])
      .map((m) => String(m?.path ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase())
      .filter((p) => p.length > 0),
  )
  const touched = [
    ...(audit?.added ?? []).map((x) => ({ path: x.path, sha256: x.sha256 ?? null })),
    ...(audit?.modified ?? []).map((x) => ({ path: x.path, sha256: x.sha256 ?? null })),
    // 删除类**拿不到"当前内容"** ⇒ 没有哈希 ⇒ 归属判据对它一律返回 null（照旧拒）
    ...(audit?.removed ?? []).map((x) => ({ path: x.path, sha256: null })),
  ]
  /**
   * ★★ 「谁改的」分账（T-20261011-56a37e 追加项 ①）—— 见 `isMachineArtifactPath` 的模块注释。
   *
   * `exemptMachineArtifacts` 默认 **true**（= 排除机器产物）。
   * 传 **false** = **严格模式**（等价于改前的行为，机器产物也要求申报）——
   * 这个开关**只能收紧、不能放松**：它的默认值是"已豁免"，而 `false` 是把豁免收回去。
   * 它存在的唯一目的是让"改前 / 改后"能在**同一份真实数据**上做对照复现
   * （见 `tests/quickfix-20261013-check.mjs` 与 `tests/hashgate-check.mjs`）。
   */
  const exemptMachineArtifacts = opts.exemptMachineArtifacts !== false
  /**
   * ★ 已被判**越界**的那批路径 —— 豁免对它们**不生效**。
   *
   * 这就是"不放松闸门"的第二条硬论证：一条路径只要进了 `unauthorized`，
   * 它就**永远**不会被机器产物豁免吞掉 ⇒ 豁免在数学上不可能掩盖任何越界改动。
   *
   * ⚠️ ★ 构造它用的是**原始**越界清单（`audit.unauthorized`），**不是**被归属判据
   *    排除之后剩下的那份 —— 这个选择是刻意的：一条越界路径即使可证明是别的单的产物，
   *    也**不该**顺带获得"机器产物豁免"的资格（两套豁免各管各的，不叠加）。
   */
  const unauthorizedKeys = new Set(
    (Array.isArray(audit?.unauthorized) ? audit.unauthorized : []).map((x) =>
      String(x?.path ?? '').replace(/\\/g, '/').toLowerCase(),
    ),
  )
  const ignoredMachineArtifacts = []
  /** ★ 被**收回**豁免的机器产物（本单编写席按哈希认领过它 —— 只会更严，不静默）。 */
  const withdrawnMachineArtifacts = []
  for (const item of touched) {
    const p = item.path
    const key = String(p).replace(/\\/g, '/').toLowerCase()
    const tKey = canAbs ? safeAbs(absOfTouched, p) : ''
    // ★★ 归零：这处改动**可证明是别的单的产物** ⇒ 不进本单的声明对账（见模块顶部）。
    const foreign = foreignAttributionOf(foreignWriteIndex, tKey, item.sha256)
    if (foreign !== null) {
      noteForeign(p, 'attributed_foreign', {
        baseline_sha256: null,
        actual_sha256: item.sha256,
        attributed_to: foreign,
        evidence: `另一张单（${foreign.task_id}）在 ${foreign.at ?? '(时间未记)'} 的 ${foreign.source ?? '交接物'} 里声明过这条路径，且当前内容的 sha256 与它当时产出的**逐字节一致**`,
      })
      continue
    }
    // ★ 机器产物豁免：**只对"没被判越界"的路径生效**（见上面那段注释）。
    if (exemptMachineArtifacts && !unauthorizedKeys.has(key) && isMachineArtifactPath(p)) {
      // ★★ 归属判据对**豁免本身**的收紧（P1-5 的残余风险）：这条机器产物若**本单编写席
      //    按哈希认领过**（它在自己某次 `dev_to_test` 里声明过这条路径，且当前内容与
      //    那次产出的哈希一致），那它就不是"测试台自己写的运行产物"，而是**编写的产物**
      //    ⇒ 豁免**收回**，落回下面的"声明不实"对账。**只会更严，不会更松**。
      const claim = seatClaimOf(writerClaimIndex, tKey, item.sha256)
      if (claim === null) {
        ignoredMachineArtifacts.push({ path: p, why: '机器产物（测试台自己写的运行产物）：不属于任何席位，不该逼谁为它背书' })
        continue
      }
      withdrawnMachineArtifacts.push({
        path: p,
        why: `这条路径被**本单的${claim.role}${claim.seat === null ? '' : `（${claim.seat}）`}**在 ${claim.at ?? '(时间未记)'} 声明过，且当前内容的 sha256 与那次产出的**逐字节一致** ⇒ 它不是"测试台自己写的运行产物"，豁免收回`,
      })
    }
    // 目录级声明（授权的是一个目录）也算覆盖到了里面
    let covered = [...declared].some((d) => key === d || key.startsWith(`${d}/`) || d.startsWith(`${key}/`))
    // ★ 修 ③：字符串比不过时，再按**规范绝对键**比一次（同一文件身份就算覆盖到）。
    if (!covered && canAbs) {
      const tAbs = safeAbs(absOfTouched, p)
      if (tAbs.length > 0) {
        covered = (Array.isArray(manifest) ? manifest : []).some((m) => {
          const dAbs = safeAbs(absOfDeclared, m?.path)
          return dAbs.length > 0 && (dAbs === tAbs || dAbs.startsWith(`${tAbs}/`) || tAbs.startsWith(`${dAbs}/`))
        })
      }
    }
    if (!covered) {
      violations.push({
        how: 'undeclared_change',
        zh: HOW_ZH.undeclared_change,
        path: p,
        baseline_sha256: null,
        actual_sha256: null,
        expected: '把这处改动补进 change_manifest（path / action / scope_id）再提交',
      })
    }
  }

  const counts = {
    added: audit?.counts?.added ?? (audit?.added ?? []).length,
    modified: audit?.counts?.modified ?? (audit?.modified ?? []).length,
    removed: audit?.counts?.removed ?? (audit?.removed ?? []).length,
    // ★ 剩下的越界处数 = 原始越界数 − 可证明是**别的单**的产物那部分（前者在 audit 里）
    unauthorized: violations.filter((x) => x.how !== 'undeclared_change').length,
    undeclared: violations.filter((x) => x.how === 'undeclared_change').length,
    /** ★ 被豁免的机器产物条数（**不静默**：豁免了什么都看得见）。 */
    machine_artifacts: ignoredMachineArtifacts.length,
    /** ★ 归属给**别的单**、因而不计入本单的改动处数（P2-13 的那个病：不静默，可核）。 */
    attributed_foreign: attributedForeign.length,
    /** ★ 被**收回**机器产物豁免的条数（本单编写席按哈希认领过 —— 更严，也要看得见）。 */
    machine_artifacts_withdrawn: withdrawnMachineArtifacts.length,
  }
  return {
    pass: violations.length === 0,
    violations,
    counts,
    /** ★ 逐条列出被豁免的路径（审计与交付说明直接引用这一栏，不靠 summary 措辞）。 */
    ignored_machine_artifacts: ignoredMachineArtifacts,
    /** ★★ 逐条列出**归属给别的单**的改动（谁归属给了谁、凭什么 —— 事后可核）。 */
    attributed_foreign: attributedForeign,
    /** ★ 逐条列出**被收回豁免**的机器产物。 */
    withdrawn_machine_artifacts: withdrawnMachineArtifacts,
    summary:
      violations.length === 0
        ? `哈希对比通过：新增 ${counts.added} · 修改 ${counts.modified} · 删除 ${counts.removed}，全部落在授权面内` +
          (counts.machine_artifacts > 0
            ? `（另有机器产物 ${counts.machine_artifacts} 条不计入声明对账：${ignoredMachineArtifacts.map((x) => x.path).join('、')}）`
            : '') +
          (counts.attributed_foreign > 0
            ? `（另有 ${counts.attributed_foreign} 处改动**可证明是别的单的产物**，不计入本单：${attributedForeign.map((x) => `${x.path}→${x.attributed_to.task_id}`).join('、')}）`
            : '')
        : `哈希对比**不通过**：越界 ${counts.unauthorized} 处 · 声明不实 ${counts.undeclared} 处` +
          (counts.machine_artifacts > 0 ? `（机器产物 ${counts.machine_artifacts} 条已排除在声明对账之外）` : '') +
          (counts.attributed_foreign > 0
            ? `（**已排除** ${counts.attributed_foreign} 处可证明是别的单的产物，未计入你头上）`
            : '') +
          (counts.machine_artifacts_withdrawn > 0
            ? `（另有 ${counts.machine_artifacts_withdrawn} 条机器产物**豁免被收回** —— 它们其实是本单编写的产物：${withdrawnMachineArtifacts.map((x) => x.path).join('、')}）`
            : ''),
  }
}

/**
 * ★ **打回理由必须可执行**：列出越界/失配的文件、基线哈希、实际哈希、期望是什么。
 * 让编写一眼知道该改哪儿 —— 而不是收到一句"你的改动不合规"。
 *
 * @param {object} input
 * @param {object} input.verdict - hashGateVerdict 的结果
 * @param {object} input.audit - changeAudit 的结果
 * @param {object[]} input.scope - task.change_scope
 * @param {object|null} input.baseline - 当前基线
 * @returns {string}
 */
export function renderGateRejection({ verdict, audit, scope, baseline, streak = null, threshold = null, escalation = null }) {
  const L = []
  L.push('拒绝提交（**哈希前置闸门**）：实际改动面与授权面/声明对不上，**直接打回编写**。')
  L.push('')
  L.push(`基线：${baseline?.baseline_id ?? '(无)'}（${baseline?.file_count ?? 0} 个文件，记于 ${baseline?.taken_at ?? '-'}）`)
  L.push(`判定：${verdict.summary}`)
  L.push('')
  L.push('**要改哪里**（逐条给出证据）：')
  for (const v of verdict.violations.slice(0, 20)) {
    L.push(`  · ${v.zh}：${v.path}`)
    if (v.baseline_sha256 !== null || v.actual_sha256 !== null) {
      L.push(`      基线哈希：${v.baseline_sha256 ?? '(基线里没有这个文件)'}`)
      L.push(`      实际哈希：${v.actual_sha256 ?? '(现在没有这个文件)'}`)
    }
    L.push(`      期望：${v.expected}`)
  }
  if (verdict.violations.length > 20) L.push(`  …（还有 ${verdict.violations.length - 20} 处，见审计记录 gate:hash）`)
  // ★★ 归属判据的**可见面**：已经按席位级写入台账排除掉的那批（可证明是别的单的产物）。
  //    为什么必须列出来：不静默是这套机制的一贯要求 —— 编写要能看见"哪些**不是**它的活"，
  //    否则它会去撤回别人的改动（那是它做不到的事）。
  if (Array.isArray(verdict.attributed_foreign) && verdict.attributed_foreign.length > 0) {
    L.push('')
    L.push(`★ **已按席位级写入台账排除 ${verdict.attributed_foreign.length} 处**（可证明是**别的单**的产物，不计入你头上）：`)
    for (const x of verdict.attributed_foreign.slice(0, 10)) {
      L.push(`  · ${x.path} —— 属于 ${x.attributed_to?.task_id ?? '?'}（${x.attributed_to?.role ?? '席位'}${x.attributed_to?.seat === null || x.attributed_to?.seat === undefined ? '' : ` ${x.attributed_to.seat}`}）`)
    }
    if (verdict.attributed_foreign.length > 10) L.push(`  …（还有 ${verdict.attributed_foreign.length - 10} 处）`)
    L.push('  判据：另一张单的席位在自己的交接物里声明过这条路径，**且当前内容的哈希与它当时产出的逐字节一致**。')
  }
  // ★ 机器产物豁免**被收回**的那些（它们其实是本单编写的产物）—— 也要看得见。
  if (Array.isArray(verdict.withdrawn_machine_artifacts) && verdict.withdrawn_machine_artifacts.length > 0) {
    L.push('')
    L.push(`★ **机器产物豁免已收回 ${verdict.withdrawn_machine_artifacts.length} 条**（它们不是测试台的运行产物，而是本单的产物）：`)
    for (const x of verdict.withdrawn_machine_artifacts.slice(0, 10)) L.push(`  · ${x.path} —— ${x.why}`)
  }
  L.push('')
  L.push('**本次授权改动面**（计划给的，超出即越界）：')
  L.push(...(Array.isArray(scope) && scope.length > 0 ? scope.map((e) => `  · ${e.id} ${e.action} ${e.path}（${e.why}）`) : ['  （无）']))
  L.push('')
  L.push('**实测明细**（哈希比对结果）：')
  L.push(`  新增 ${verdict.counts.added} · 修改 ${verdict.counts.modified} · 删除 ${verdict.counts.removed}`)
  for (const x of (audit?.added ?? []).slice(0, 10)) L.push(`  + ${x.path}  ${x.sha256 ?? ''}`)
  for (const x of (audit?.modified ?? []).slice(0, 10)) L.push(`  ~ ${x.path}  ${x.sha256 ?? ''}`)
  for (const x of (audit?.removed ?? []).slice(0, 10)) L.push(`  - ${x.path}`)
  L.push('')
  L.push('★ **测试没有被触发** —— 这次提交根本没进测试，也**没有消耗测试预算**，')
  L.push('  更不需要走"是否跑全量"的审批链。修好改动面再交即可。')
  L.push('★ 不合格的提交不该消耗测试资源：让测试去跑一套注定被打回的产物，是纯浪费。')
  L.push('')
  // --- ★ 连续不过的计数与自动升级（P13 的结论）-----------------------------
  if (Number.isInteger(streak) && Number.isInteger(threshold) && threshold > 0) {
    L.push(`★ **连续不通过计数：${streak} / ${threshold}**（一次通过就归零；撤回越界改动**不**归零）。`)
    if (escalation?.escalated === true) {
      L.push('')
      L.push(`★★ 已到阈值 ⇒ **机制自动交人工**：这件事不再由编写反复重交，改由用户拍板。`)
      L.push(`  人工请求：${escalation.request_id ?? '(见 task.human_requests)'}（由 ${escalation.from_role ?? '?'} 发起，第 ${escalation.round ?? 1} 次升级）`)
      L.push('  任务已推进到「等待人工答复」。**在用户答复之前，本任务的再次提交会被直接拒收** ——')
      L.push('  这不是提醒，是拒收（`HASH_GATE_ESCALATED`）：机制不许无限重交。')
      L.push('  人工那一站走的是**既有**的 human_request / 两级梯（发起 → 主对话转告 → 用户答复 → 恢复），')
      L.push('  答复仍然必须带来源与用户本人的原话。')
    } else if (escalation?.escalated === false && escalation.reason === 'request_denied') {
      L.push(`⚠ 本轮本该自动交人工，但那条 human_request 没发出去（${escalation.error ?? '见审计 gate:hash_escalate_failed'}）。`)
      L.push('  已记入审计；下一次不通过时会再试一次。')
    } else {
      L.push(`（离自动交人工还差 ${Math.max(0, threshold - streak)} 次；到了就由机制直接交人工，不需要谁去申请。）`)
    }
  }
  L.push('')
  L.push('两条出路：① 撤回越界改动（或被删的文件找回来）；② 真需要扩大范围 →')
  L.push('  走澄清/变更（pipeline_clarify_request 或 pipeline_roster_request），拿到**新授权**再交。')
  return L.join('\n')
}

// ===========================================================================
// ★ 本轮新增：**连续不通过**的计数与"自动交人工"
// ===========================================================================
//
// 用户拍板（P13，2026-10-11）：
//   · 闸门不通过 **不消耗** `maxReworkPerLeg`（保持现状）；
//   · 但**同一任务连续 N 次不过 ⇒ 自动交人工**（走既有的 human_request / 两级梯）。
//
// 下面这段全是**纯函数**：判定与文案在这里，执法在 `lib/store.js`。
// 分开的理由与 `hashGateVerdict` / `renderGateRejection` 一样 ——
// 判定能单测，执法能被夹具真跑，两边不会各写一份口径。

/**
 * ★ 连续失败计数的下一步。
 *
 * 语义（用户要求"写死"，所以写在这里，不许别处再定义一遍）：
 *   · **闸门真通过一次 ⇒ 归零**（这是"连续"唯一的终点）；
 *   · 不通过 ⇒ +1。
 *
 * **撤回越界改动为什么不归零**：机制看不到"撤回"这个动作 ——
 * 编写把文件改回来，机制看到的只是"文件变了"。它唯一能看到的事实是
 * "这个任务连续几次交上来的东西没过闸门"。若按"撤回就归零"，
 * `撤回 → 重交 → 再越界 → 再撤回` 可以无限循环，而每一次都**看起来有进展**。
 *
 * @param {number|undefined|null} prev - 当前计数
 * @param {boolean} passed - 这一次闸门过了没有
 * @returns {number}
 */
export function nextHashGateStreak(prev, passed) {
  if (passed === true) return 0
  const n = Number.isInteger(prev) && prev > 0 ? prev : 0
  return n + 1
}

/**
 * ★ **重取基线 = 新起点**：把「连续不通过」的计数与判定按**新基线**重新起算。
 *
 * -----------------------------------------------------------------------------
 * 为什么需要这一条（现场：真单 T-20261011-214043，闸门长期显示「卡着 连续不通过 1/3」）
 * -----------------------------------------------------------------------------
 * 闸门判的是「**相对基线**的变化」：基线记的是"派活那一刻的项目快照"。
 * 可这个项目里，基线一旦取早了（本单开工基线早于当晚那几次**基础设施前置修复**），
 * 那些**与本单无关**的改动就会永远显示成"本单越界" ——
 * 修不掉：编写席没法把别人的活撤回；许可的出路只有一条，就是**重取基线**。
 *
 * 而重取基线之后，旧基线下的"连续不通过 **1/3**"却**跟着走了** ——
 * 下一次提交仍背着那一格，再攒两次就触发"机制自动交人工"，
 * 等于**让编写替别人的改动去挨那张人工单**。这是归属错位，不是执法。
 *
 * 所以：**基线换了，连续计数就重新起算**（新基线 = 新起点），
 * 同时**作废基于旧基线算出的那份闸门判定**（`task.hash_gate`）——
 * 它自己的 `baseline_id` 就是"它已经过期"的证据，留着只会让守门继续拿旧结论
 * 拦"跑测试"（`hashGateBlocksTests` 读的就是它）。
 *
 * ⚠️ **这不是放宽越界判定**：三类越界（新增/修改/删除清单外）与"声明不实"
 *    一个字都没动，仍然照拒；拒了仍然照计数、照在连续 N 次后自动交人工。
 *    改的只有**起点**：新基线之下的越界，从 1 开始数。
 *
 * ⚠️ **不碰 `hash_gate_escalation`**：那张已经交到用户手上的单不会因为重取基线
 *    而被悄悄撤回（"机制不替用户撤单"）。要了结它，只能走答复。
 *
 * 语义写死在这里（与 `nextHashGateStreak` 同源）—— 不许别处再定义一遍。
 *
 * @param {object|null} task
 * @param {string} baselineId - **新**基线的 id
 * @returns {{changed:boolean, prev_baseline_id:string|null, prev_streak:number, prev_gate_baseline_id:string|null, prev_gate_blocked:boolean}}
 *          改动前的现场（供审计留痕；`changed=false` 表示本来就没什么要清的）
 */
export function resetHashGateOrigin(task, baselineId) {
  const before = {
    changed: false,
    prev_baseline_id: typeof task?.baseline_current === 'string' ? task.baseline_current : null,
    prev_streak: Number.isInteger(task?.hash_gate_streak) ? task.hash_gate_streak : 0,
    prev_gate_baseline_id: typeof task?.hash_gate?.baseline_id === 'string' ? task.hash_gate.baseline_id : null,
    prev_gate_blocked: task?.hash_gate?.blocked === true,
  }
  if (task === null || typeof task !== 'object') return before

  const gateIsStale = task.hash_gate !== null && task.hash_gate !== undefined && before.prev_gate_baseline_id !== baselineId
  if (before.prev_streak === 0 && !gateIsStale) return before

  task.hash_gate_streak = 0
  if (gateIsStale) task.hash_gate = null
  return { ...before, changed: true }
}

/**
 * ★ 升级是否**还没了结**（= 已经交人工、但用户还没答复）。
 *
 * 这个布尔值有两个用处，缺一不可：
 *   ① 决定"要不要再升级"（了结之前不重复升级）；
 *   ② 决定"还收不收重交"（了结之前**拒收** `dev_to_test`）。
 *
 * @param {object|null} task
 * @returns {boolean}
 */
export function hashGateEscalationPending(task) {
  const e = task?.hash_gate_escalation
  if (e === null || e === undefined || typeof e !== 'object') return false
  return e.answered_at === null || e.answered_at === undefined
}

/**
 * ★ 到阈值了没有（纯判据，不含任何 IO）。
 *
 * @param {object|null} task
 * @param {number} threshold - `config.hashGateEscalateAfter`（0 = 关掉自动升级）
 * @returns {boolean}
 */
export function shouldEscalateHashGate(task, threshold) {
  const cap = Number.isInteger(threshold) ? threshold : 0
  if (cap <= 0) return false
  if (hashGateEscalationPending(task)) return false
  const streak = Number.isInteger(task?.hash_gate_streak) ? task.hash_gate_streak : 0
  return streak >= cap
}

/**
 * ★ 交给用户看的**选项**（人话，不含代码、不含路径）。
 *
 * ⚠️ `consequence` 会被 `detectCodeInHumanText` 扫（它是要给用户看的），
 *    所以这里刻意不写任何路径/命令/代码片段。
 */
export const HASH_GATE_ESCALATION_OPTIONS = [
  {
    label: '按原授权范围重做（把越界的改动撤回去）',
    consequence: '任务回到「开发中」，编写只动已经授权的部分，改完重新提交；连续不过的计数从零开始。',
  },
  {
    label: '重新出计划，把范围补齐之后再交',
    consequence: '由计划角色重出授权改动面与新基线，会多一次计划往返；期间任务停在「等待人工答复」。',
  },
  {
    label: '先停住，等我看过实际改动再定',
    consequence: '任务保持「等待人工答复」，不会自己往下走；想继续时由主对话重新派活。',
  },
]

/**
 * ★ 自动升级时的**给用户看的内容**（问句 + 背景 + 选项）。
 *
 * 三条硬约束（都由 `lib/handoff.js` 在提交时执法，写错就提交失败）：
 *   ① 必须**不含代码**（主对话不读代码，含代码它转告不了）；
 *   ② 必须真的是个**问句**（有个问号）；
 *   ③ 长度有上限（几百字符 —— 给用户看的东西要能一眼读完）。
 *
 * @param {object} input
 * @param {number} input.streak
 * @param {number} input.threshold
 * @param {number} [input.round] - 第几次升级（用户答复过之后可以再来一次）
 * @returns {{question:string, context:string, options:object[]}}
 */
export function renderHashGateEscalation({ streak, threshold, round = 1 }) {
  const n = Number.isInteger(streak) ? streak : 0
  const cap = Number.isInteger(threshold) ? threshold : 0
  const question =
    `同一个任务的改动面已经连续 ${n} 次没有通过哈希前置闸门（改动落在授权范围之外，或与编写自己交的改动声明对不上），` +
    '机制已经把它停下来交给你定夺。接下来想怎么走？'
  const context =
    `这道闸排在"提交进测试"之前：它拿派活那一刻的文件基线逐个文件比对，查出四类问题 —— ` +
    '动了授权清单外的文件、新增了清单外的文件、删了清单外的文件，以及"实际动了却没在改动声明里报"。' +
    `连续 ${n} 次都没过（阈值 ${cap}），说明不是一次手滑。按机制规定，这时不再让编写自己反复重交。` +
    '任务现在仍停在「开发中」：测试没有被触发，也没有消耗测试的打回预算。' +
    (round > 1 ? `（这是第 ${round} 次升级：上一次你已经拍板过，但之后又连续不过。）` : '')
  return { question, context, options: HASH_GATE_ESCALATION_OPTIONS.map((o) => ({ ...o })) }
}

/**
 * ★ **同步判据**：这道闸是不是正卡着？
 *
 * 守门要用它拦"绕过闸门先跑一下看看"——守门是**同步**的，所以读的是同步索引里
 * 预先算好的布尔值（`makeTaskIndexEntry({ hashGateBlocked })`）。
 *
 * @param {object|null} task
 * @returns {boolean}
 */
export function hashGateBlocksTests(task) {
  return task?.hash_gate?.blocked === true
}
