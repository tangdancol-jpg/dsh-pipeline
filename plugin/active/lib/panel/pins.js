/**
 * dsh-pipeline · 自建流水线面板 · **置顶**（用户手点的那几颗星）
 * ============================================================================
 * 面板默认按 `updated_at` 倒序：跑得最勤的那几张单会一直在顶上，而"我盯着的那几张"
 * 被时间挤下去。置顶就是把这件**纯展示偏好**记下来，让快照排序时先看它。
 *
 * ---- 硬边界 ----------------------------------------------------------------
 *   · **只存一个 id 数组**，绝不碰任何任务目录 / 任务数据（置顶不是状态变更，
 *     不该让 `task.json` 多出哪怕一个字节 —— 否则"只读快照"那条边界就破了）；
 *   · **落在工作区里**（`<项目根>/<artifactDirName>/_panel-pins.json`），
 *     于是它跟着 profile 走，不散落在机器的别处；
 *   · **原子写**：先写 `<file>.tmp` 再 `rename` —— 面板是 5 秒轮询的，
 *     读到半个 JSON 会把整张面板的置顶一次性抖没了；
 *   · **坏文件当空**：手改坏了 / 读到一半被杀 ⇒ 当作"没有置顶"，**不抛**
 *     （置顶丢了只是排序变化，不该让面板变成 500）；
 *   · **上限 200**：这是给"人盯着看的几十张单"用的，不是索引表。满了就**明说满了**
 *     （而不是悄悄丢掉刚点的那一颗星 —— 那等于骗用户"已置顶"）。
 *
 * ---- 为什么 id 是"不透明字符串"而不是任务对象 -------------------------------
 *   置顶表是**历史**：任务被归档 / 删掉之后，它那一条还留着（无害）。
 *   所以这里既不校验 id 是否存在，也不在删单时清理 —— 删单清理是另一件事，
 *   而"置顶表里有一条指向不存在任务"是**显式无害**的：快照只对存在的行看 `pinned`。
 *
 * @module dsh-pipeline/lib/panel/pins
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 置顶文件名（在 `<项目根>/<artifactDirName>/` 之下，与任务目录平级）。 */
export const PINS_FILE_NAME = '_panel-pins.json'

/** 文件格式版本（将来要加字段就靠它分流）。 */
export const PINS_VERSION = 1

/** 置顶条数上限。 */
export const PINS_MAX = 200

/** 单个 id 的长度上限（任务 id 远小于这个数；超了就是垃圾数据，直接不收）。 */
const ID_MAX_LENGTH = 128

/**
 * 工作区目录名归一（与快照同一个默认值 `.pipeline`）。
 * @param {string} [dirName]
 * @returns {string}
 */
function dirNameOf(dirName) {
  const s = typeof dirName === 'string' ? dirName.trim() : ''
  return s.length === 0 ? '.pipeline' : s
}

/**
 * 置顶文件的绝对路径。
 *
 * @param {string} root - 项目根
 * @param {string} [dirName] - 工作区目录名，默认 `.pipeline`
 * @returns {string}
 */
export function pinsFileOf(root, dirName) {
  return join(String(root ?? ''), dirNameOf(dirName), PINS_FILE_NAME)
}

/**
 * 读置顶列表（**同步 · 纯读 · 绝不抛**）。
 *
 * 坏文件（不存在 / 不是 JSON / 形状不对）一律当**空表** —— 置顶是展示偏好，
 * 读坏了不该让面板停摆（与 `buildPanelSnapshot` 对坏输入的口径一致：降级，不 500）。
 *
 * @param {string} root
 * @param {string} [dirName]
 * @returns {string[]} 去重后的 id 列表（最多 {@link PINS_MAX} 条；坏输入 ⇒ `[]`）
 */
export function readPins(root, dirName) {
  const raw = typeof root === 'string' ? root.trim() : ''
  if (raw.length === 0) return []
  let text = null
  try {
    text = readFileSync(pinsFileOf(raw, dirName), 'utf8')
  } catch {
    // ENOENT（还没置顶过）是常态；其它读失败也按"没有置顶"降级，不抛。
    return []
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  // 形状必须就是 `{"version":1,"ids":[...]}`：别的形状一律按"坏文件"降级成空表
  // （宁可少置顶几颗星，也不拿一份看不懂的文件去猜用户想要什么）。
  const list = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.ids)
    ? parsed.ids
    : []
  const out = []
  const seen = new Set()
  for (const item of list) {
    const id = typeof item === 'string' ? item.trim() : ''
    if (id.length === 0 || id.length > ID_MAX_LENGTH || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= PINS_MAX) break
  }
  return out
}

/**
 * 某个任务是否被置顶。
 *
 * @param {string} root
 * @param {string} [dirName]
 * @param {string} id
 * @returns {boolean}
 */
export function isPinned(root, dirName, id) {
  const key = typeof id === 'string' ? id.trim() : ''
  if (key.length === 0) return false
  return readPins(root, dirName).includes(key)
}

/**
 * 置顶 / 取消置顶（**同步 · 原子写 · 绝不抛**）。
 *
 * 幂等：已经置顶再置顶 = 不变（不产生重复项）；取消一个没置顶的 = 不变。
 * 顺序：新置顶**追加在末尾**（顺序不影响显示 —— 快照里置顶组内部仍按 `updated_at` 倒序，
 * 这样"置顶"只回答"要不要往上提"，不另造一套排序规则）。
 *
 * @param {string} root
 * @param {string} [dirName]
 * @param {string} id
 * @param {boolean} on - `true` = 置顶，其它一律 = 取消
 * @returns {{ok:boolean, pinned:boolean, ids:string[], error?:string}}
 */
export function setPinned(root, dirName, id, on) {
  const raw = typeof root === 'string' ? root.trim() : ''
  const key = typeof id === 'string' ? id.trim() : ''
  const ids = readPins(raw, dirName)
  const wanted = on === true

  if (raw.length === 0) {
    return { ok: false, pinned: key.length > 0 && ids.includes(key), ids, error: '置顶需要一个项目根（projectRoot 为空）。' }
  }
  if (key.length === 0 || key.length > ID_MAX_LENGTH) {
    return { ok: false, pinned: false, ids, error: `置顶需要一个合法的任务 id：${JSON.stringify(id)}` }
  }

  const has = ids.includes(key)
  const next = ids.slice()
  if (wanted) {
    if (!has) {
      // ★ 满了就如实拒 —— 悄悄丢掉刚点的那一颗星等于骗用户"已置顶"。
      if (next.length >= PINS_MAX) {
        return { ok: false, pinned: false, ids, error: `置顶已达上限（${PINS_MAX} 条），先取消一些再置顶。` }
      }
      next.push(key)
    }
  } else if (has) {
    next.splice(next.indexOf(key), 1)
  }

  // 没变化就不写盘（面板每 5 秒轮询，不做无谓的写 —— 也让 mtime 更有信息量）。
  if (next.length === ids.length && next.every((v, i) => v === ids[i])) {
    return { ok: true, pinned: wanted, ids: next }
  }

  try {
    const file = pinsFileOf(raw, dirName)
    mkdirSync(join(raw, dirNameOf(dirName)), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ version: PINS_VERSION, ids: next }, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return { ok: true, pinned: wanted, ids: next }
  } catch (err) {
    // 写失败：**内存里也没改**（本函数无状态），如实报错，绝不说"已置顶"。
    return { ok: false, pinned: has, ids, error: `置顶写不进去：${reasonOf(err)}` }
  }
}

/** 异常 → 一句人话（不带堆栈）。 */
function reasonOf(err) {
  const code = typeof err?.code === 'string' && err.code.length > 0 ? `${err.code} ` : ''
  return `${code}${String(err?.message ?? err)}`
}
