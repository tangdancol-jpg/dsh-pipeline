/**
 * dsh-pipeline · 哈希前置闸门 · **席位级写入台账与归属判据**
 * ============================================================================
 * 从 `lib/hashgate.js` 机械拆分而来（判据与文案逐字未改）：
 * 机器产物识别、台账行的整形 / 解析 / 索引，以及「这处改动归谁」的归属判据。
 * 纯函数、无 IO。
 *
 * @module dsh-pipeline/lib/hashgate/ledger
 */

// ★ 本模块刻意保持"无 IO、纯判据"。唯一的依赖是**角色常量**（不引第二份字面量：
//   席位台账要按"谁是编写席"分账，写死字符串迟早与 `lib/roles.js` 漂移）。
import { ROLE } from '../roles.js'

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

/**
 * 守门放行一次写类工具调用时追加的观察行的 `source`（`lib/guard-factory.js` 写、这里读）。
 * 观察行**不带产出哈希**，所以不参与任何放宽；它只被 {@link seatTouchOf} 用来**收回**机器产物豁免。
 */
export const GUARD_WRITE_ALLOWED_SOURCE = 'guard.write-allowed'

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
 * 本单这些角色**用写类工具真的写过**这条路径吗（守门的放行观察行）。
 *
 * 与 {@link seatClaimOf} 互补：那条认"申报过、哈希对得上"，这条认"守门亲眼看见它写过"。
 * ★ 只用于**收回**机器产物豁免（方向只会更严）：编写不申报、把产物起名成
 *   `tests/<随便什么>-last-run.txt` 的形态，只要是写类工具写的，就躲不过去。
 *   shell 里的写入守门看不见，这一条照样拦不到。
 *
 * @param {Map<string, object[]>} index - `buildSeatWriteIndex` 的产物
 * @param {string} key - 规范绝对键
 * @returns {object|null}
 */
export function seatTouchOf(index, key) {
  const k = String(key ?? '').trim().toLowerCase()
  if (k.length === 0) return null
  const list = index instanceof Map ? index.get(k) : null
  if (!Array.isArray(list)) return null
  return list.find((c) => c.source === GUARD_WRITE_ALLOWED_SOURCE) ?? null
}
