// 制品版本记录 · `task.artifacts[]` 与 `artifacts/v<N>/` 的形状：版本号 / 路径 / 字节数 / sha256 / 登记时间 / 备注。
/**
 * dsh-pipeline · 领域对象（实现）
 * ============================================================================
 * 从 `lib/store/review.js` 的 `registerArtifact()` 原样搬来（**只改了 import 路径、取值来源与说明文字，行为未改**）。
 * 对外仍经原模块使用 / 转出，调用方不需要改 import。
 *
 * ★ 依赖方向（单向）：`lib/store/**` 与 `lib/handoff/**` → `lib/model/**`；
 *   `lib/model/**` **不 import** store / handoff。
 * ★ 字面量**原样搬过来**（字段顺序、默认值都没动）。
 *
 * ---------------------------------------------------------------------------
 * ★★ P1-10（设计档 `design/conventions/04-demo与制品模型.md` §3「推荐 B」）：
 *   制品 = **整体交付快照**，不再只是"某席位最新登记的那个版本号"。
 *
 *   · `pipeline_artifact` 登记时可选 `files: [{ path, sha256? }]` ——
 *     路径相对 `task.project_root`；缺 `sha256` 时由服务端从磁盘算；
 *   · 服务端按 **path 排序** 算 `snapshot_id = sha256(join(path + ':' + hash))`；
 *   · 逐条核对磁盘哈希，记下 `snapshot:{ snapshot_id, files, complete, verified_at, missing[], mismatch[] }`；
 *   · `complete = 无 missing 无 mismatch`；
 *   · L3+ 关单要求当前有效制品的登记带 `complete:true` 的快照（legacy 旧登记在 L3+ 视为不完整）。
 *
 *   本文件只放**纯函数**（哈希 / 规整 / 视图），不读盘、不写盘、不认识 store ——
 *   磁盘核对在 `lib/store/review.js`（那里才允许有 fs 副作用）。
 *
 * @module dsh-pipeline/lib/model/artifact
 */

import { fullHash, nowIso } from '../util.js'

/**
 * 一个制品快照最多列多少个文件。
 *
 * 为什么要有上限：`files` 会原样落进 `task.json`（一个任务卡本来就 MB 级），
 * 而"整棵仓的每个文件"既不是"交付物"、也会把任务卡撑爆。超限**拒绝登记**并让人
 * 显式缩小范围 —— 不静默截断（截断后的快照会假装"完整"，比拒收更危险）。
 */
export const SNAPSHOT_MAX_FILES = 2000

/**
 * 登记一个制品版本（编写角色的动作）。
 *
 * @param {object} spec
 * @param {string} spec.version - 形如 `v1` 的版本号
 * @param {string} spec.file - 制品落盘路径
 * @param {string} spec.content - 制品正文
 * @param {string|undefined} spec.note - 备注
 * @param {() => Date} spec.now - 时钟
 * @param {object|undefined} spec.snapshot - 可选：已核对好的快照记录（`null`/缺省 = 旧行为，不带快照）
 * @returns {object}
 */
export function makeArtifactRecord({ version, file, content, note, now, snapshot }) {
  const rec = {
    version,
    file,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: fullHash(content),
    created_at: nowIso(now()),
    note: typeof note === 'string' ? note : '',
  }
  // ★ P1-10：只有调用方**真的给了** `files` 才带这个键 —— 不传时记录形状与改前逐字节相同
  //   （旧单 / 旧测试读 `{version,file,bytes,sha256,created_at,note}` 时不会多出字段）。
  if (snapshot !== undefined && snapshot !== null) rec.snapshot = snapshot
  return rec
}

/**
 * 规整一条快照文件路径（**纯字符串规整**；解析到项目根、判越界是 store 的事）。
 *
 * @param {unknown} raw
 * @returns {string} 空串 = 调用方没给路径
 */
export function normalizeSnapshotPath(raw) {
  let s = typeof raw === 'string' ? raw.trim() : ''
  if (s.length === 0) return ''
  s = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  if (s.length > 1 && s.endsWith('/')) s = s.replace(/\/+$/, '')
  return s
}

/**
 * 算 `snapshot_id`：**按 path 排序**后把 `path:sha256` 逐条拼起来求 sha256。
 *
 * 三条性质（判据就靠它们）：
 *   · **与输入顺序无关** —— 同一组文件无论怎么排列都得到同一个 id；
 *   · **与内容绑定** —— 任一文件内容（哈希）变了，id 就变；
 *   · **可复算** —— verify 拿磁盘重算出来的 id 与登记时的一比就知道"登记后有没有被改"。
 *
 * @param {Array<{path:string, sha256?:string|null}>} files
 * @returns {string} 64 位十六进制
 */
export function snapshotIdOf(files) {
  const list = (Array.isArray(files) ? files : []).map((f) => ({
    path: normalizeSnapshotPath(f?.path),
    sha256: typeof f?.sha256 === 'string' ? f.sha256.toLowerCase() : '',
  }))
  list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return fullHash(list.map((f) => `${f.path}:${f.sha256}`).join('\n'))
}

/**
 * 构造落进 `task.artifacts[vN].snapshot` 的记录。
 *
 * ★ `complete` **由 missing / mismatch 推导**，不接受调用方传入 ——
 *   否则"手工把 complete 改成 true"就能绕过 L3+ 的关单判据。
 *
 * @param {object} spec
 * @param {string} spec.snapshotId
 * @param {Array<{path:string, sha256:string|null}>} spec.files
 * @param {string} spec.verifiedAt - ISO 时间
 * @param {Array<object>} [spec.missing]
 * @param {Array<object>} [spec.mismatch]
 * @returns {{snapshot_id:string, files:Array<object>, complete:boolean, verified_at:string, missing:Array<object>, mismatch:Array<object>}}
 */
export function makeArtifactSnapshotRecord({ snapshotId, files, verifiedAt, missing, mismatch }) {
  const miss = Array.isArray(missing) ? missing : []
  const mism = Array.isArray(mismatch) ? mismatch : []
  return {
    snapshot_id: String(snapshotId ?? ''),
    files: (Array.isArray(files) ? files : []).map((f) => ({
      path: normalizeSnapshotPath(f?.path),
      sha256: typeof f?.sha256 === 'string' ? f.sha256.toLowerCase() : null,
    })),
    complete: miss.length === 0 && mism.length === 0,
    verified_at: String(verifiedAt ?? ''),
    missing: miss,
    mismatch: mism,
  }
}

/**
 * 任务卡上某个版本的登记记录（没有就是 `null`）。
 *
 * @param {object} task
 * @param {string|null|undefined} version
 * @returns {object|null}
 */
export function artifactRecordOf(task, version) {
  if (typeof version !== 'string' || version.length === 0) return null
  const list = Array.isArray(task?.artifacts) ? task.artifacts : []
  return list.find((a) => a !== null && typeof a === 'object' && a.version === version) ?? null
}

/**
 * 一份快照记录是不是**真的快照**（旧单 / 手改数据里可能是任意形状 —— 一律不认）。
 *
 * @param {unknown} snapshot
 * @returns {boolean}
 */
export function isSnapshotRecord(snapshot) {
  return (
    snapshot !== null &&
    typeof snapshot === 'object' &&
    !Array.isArray(snapshot) &&
    typeof snapshot.snapshot_id === 'string' &&
    snapshot.snapshot_id.length > 0
  )
}

/**
 * 当前有效制品的**快照状态视图**（`pipeline_status` 展示 + 关单判据**同一份**派生）。
 *
 * 为什么抽成纯函数：状态展示与关单闸各算一套 ⇒ "status 说完整、close 说没有"，
 * 那是必然。这里只有一处口径。
 *
 * @param {object} task
 * @param {string|null|undefined} version - 当前有效制品版本（`currentArtifactVersion(task)`；由调用方传入）
 * @returns {{
 *   version:string|null, registered:boolean, has_snapshot:boolean, legacy:boolean,
 *   complete:boolean, snapshot_id:string, file_count:number, verified_at:string|null,
 *   missing:Array<object>, mismatch:Array<object>, missing_count:number, mismatch_count:number
 * }}
 */
export function describeArtifactSnapshot(task, version) {
  const record = artifactRecordOf(task, version)
  const snap = isSnapshotRecord(record?.snapshot) ? record.snapshot : null
  const missing = Array.isArray(snap?.missing) ? snap.missing : []
  const mismatch = Array.isArray(snap?.mismatch) ? snap.mismatch : []
  return {
    version: typeof version === 'string' && version.length > 0 ? version : null,
    registered: record !== null,
    has_snapshot: snap !== null,
    /** ★ legacy：有登记、但登记的样子是**没有快照**的旧记录 —— L3+ 视为不完整。 */
    legacy: record !== null && snap === null,
    complete: snap !== null && snap.complete === true,
    snapshot_id: snap?.snapshot_id ?? '',
    file_count: Array.isArray(snap?.files) ? snap.files.length : 0,
    verified_at: typeof snap?.verified_at === 'string' && snap.verified_at.length > 0 ? snap.verified_at : null,
    missing,
    mismatch,
    missing_count: missing.length,
    mismatch_count: mismatch.length,
  }
}
