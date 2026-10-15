// 记忆库的**追加写**（JSONL）：异步、**绝不抛**、失败只 warn —— 写库不许把触发它的那次调用带崩。
/**
 * dsh-pipeline · 记忆 · 追加写
 * ============================================================================
 * 判据 R3（`design/memory/05-判据与测试.md`）：**记忆追加失败时，被包裹的那次工具调用
 * 仍然返回原结果**。所以这个文件的每一条出口都包在 try/catch 里，最坏情况下
 * 只做两件事：`warn` 一句、返回 `{ok:false}` —— **一个异常都不许出去**。
 *
 * ---------------------------------------------------------------------------
 * 为什么是"一行一次追加"而不是"整批一次追加"
 * ---------------------------------------------------------------------------
 * 并发写靠的是 `O_APPEND` 的语义（`fs.appendFile` 的 `'a'` 标志），
 * 而 **`O_APPEND` 的原子性只对"单次写入"成立**：把 N 条拼成一个大字符串一次写出去，
 * 一旦超过内核的原子写上限（管道缓冲量级），两次并发写就会**交错**，
 * 结果是两行都坏（JSONL 里那叫"半行"）。
 * ⇒ 一条一行、逐条追加：每次写入都很短，**后写不丢前写**（判据 m3 的第二条）。
 *
 * ★ 本文件**不负责"该不该写"**（那是 `retain-hook.js` / 总开关的事），
 *   也不负责建库以外的任何目录（只 `mkdir` 记忆库自己那一层）。
 *
 * @module dsh-pipeline/lib/memory/append
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { toJsonlLine, validateRecord } from './record.js'

/**
 * ★ 追加一批记忆到 JSONL。
 *
 * @param {string} file - 记忆库正文文件（`bank.memoryFile(projectDir)`）
 * @param {object[]} records - 待写入的记忆（**逐条校验**，坏的不写）
 * @param {object} [opts]
 * @param {{appendFile:Function, mkdir:Function}} [opts.fs] - 文件系统缝（自测注入用）
 * @param {(m:string)=>void} [opts.warn] - 失败时的唯一发声渠道
 * @param {boolean} [opts.createDir] - 是否建目录（默认 true；**只有 retain 才负责建**）
 * @returns {Promise<{ok:boolean, appended:number, skipped:number, path:string, reason:string}>}
 */
export async function appendRecords(file, records, opts = {}) {
  const target = String(file ?? '').trim()
  const fs = opts.fs ?? { appendFile, mkdir }
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {}
  const out = { ok: false, appended: 0, skipped: 0, path: target, reason: '' }
  if (target.length === 0) {
    out.reason = 'NO_MEMORY_FILE'
    return out
  }

  const list = Array.isArray(records) ? records : []
  const good = []
  for (const r of list) {
    const v = validateRecord(r)
    if (v.ok) good.push(r)
    else out.skipped += 1
  }
  if (good.length === 0) {
    out.ok = true
    out.reason = list.length === 0 ? 'EMPTY_BATCH' : 'ALL_INVALID'
    return out
  }

  try {
    if (opts.createDir !== false) await fs.mkdir(dirname(target), { recursive: true })
    for (const r of good) {
      // ★ 一行一次写入：单次写入才享有 `O_APPEND` 的原子性（见文件头）。
      await fs.appendFile(target, toJsonlLine(r), 'utf8')
      out.appended += 1
    }
    return { ...out, ok: true }
  } catch (err) {
    // ★★ 这里就是判据 R3 的落点：**绝不抛**，只如实说"没写成"。
    out.ok = false
    out.reason = `APPEND_FAILED: ${String(err?.message ?? err)}`
    try {
      warn(`[pipeline] 记忆追加失败（不影响触发它的那次调用）：${out.reason}`)
    } catch {
      /* warn 自己坏了也不许抛 */
    }
    return out
  }
}
