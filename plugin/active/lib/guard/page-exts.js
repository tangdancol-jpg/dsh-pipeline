/**
 * dsh-pipeline · 守门 · **"只写自己那一片"允许哪些扩展名**
 * ============================================================================
 * -----------------------------------------------------------------------------
 * 修的是哪条缺陷（真机端到端 T-20261015-bb30bc 实测，缺陷 ④）
 * -----------------------------------------------------------------------------
 * 测试席位要写一份**可运行的用例/探针**（`tester-cases.mjs`），被守门拒了 ——
 * 因为 `own-dir` 的允许面里只有 `log / jsonl / md / json / txt`，**可执行扩展名
 * 一个都不在**。它只能退回"把用例塞进 stdin 管道喂给解释器"这条别扭的路。
 *
 * -----------------------------------------------------------------------------
 * 为什么扩这一档是安全的（不是放宽"测试不许改代码"）
 * -----------------------------------------------------------------------------
 * `own-dir` 的落点是**唯一**的：
 *
 *     <项目根>/.pipeline/<任务id>/reports/<角色>/<角色>[-后缀].<ext>
 *
 * —— 那是**流水线自己的报告目录**，不是项目源码树。测试席位写一份
 * `reports/tester/tester-cases.mjs` 与写 `reports/tester/tester-cases.txt`
 * 在**越界语义**上完全等价（都出不了自己那一格）；
 * 而"测试不得改项目源码"那条判据由**另一条路径判据**管（`decide.js` 的 2 段），
 * 一个字都没动。
 *
 * -----------------------------------------------------------------------------
 * 两条一起做（用户口径是"要么…要么…"，两条都做才不留死角）
 * -----------------------------------------------------------------------------
 *   ① **扩充允许面**：加上 `mjs` / `cjs` / `js`（可执行脚本）；
 *   ② **拒绝文案给出可行替代**：被拒时直接写出"你这个角色允许哪些扩展名、
 *      以及想跑一次性用例可以走哪条路"，而不是让人自己去猜。
 *
 * @module dsh-pipeline/lib/guard/page-exts
 */

// ★ 「允许写的位置（唯一）：…」那一行的**唯一出处**（`lib/errors/text.js`）——
//   与 `decide.js` 的"只能写自己那一片"拒绝文案共用同一句。
import { ownPathLine } from '../errors/text.js'

/** `own-dir` 允许的扩展名（测试产物 / 报告 / 日志 / **可执行用例**）。 */
export const OWN_DIR_EXTS = Object.freeze(['log', 'jsonl', 'md', 'json', 'txt', 'mjs', 'cjs', 'js'])

/** `own-log` 允许的扩展名（**只有日志** —— 审核只要能把意见写下来）。 */
export const OWN_LOG_EXTS = Object.freeze(['log', 'jsonl'])

/** 缺陷 ④ 补进来的那几个（自测里按这个名字断言"确实补上了"）。 */
export const EXECUTABLE_EXTS = Object.freeze(['mjs', 'cjs', 'js'])

/** 按类别取允许面（`decide.js` 只需要一个入口）。 */
export function extsOf(cls) {
  return cls === 'own-log' ? OWN_LOG_EXTS : OWN_DIR_EXTS
}

/**
 * 被拒时给出的**可行替代**（缺陷 ④ 的第二半）。
 *
 * @param {object} input
 * @param {string} input.role
 * @param {string} input.cls - 'own-dir' | 'own-log'
 * @param {string} input.dir - 允许写的目录（绝对路径）
 * @param {string} input.base - 本次的文件名（可空）
 * @returns {string}
 */
export function ownPathHint({ role, cls, dir, base = '' }) {
  const exts = extsOf(cls)
  const r = String(role ?? '')
  // ★ 这一行的**唯一出处**是 `lib/errors/text.js` 的 `ownPathLine()`
  //   （`decide.js` 的"只能写自己那一片"拒绝文案用的是同一句）。
  const L = [ownPathLine(dir, r, exts.join('|'))]
  const ext = String(base).includes('.') ? String(base).slice(String(base).lastIndexOf('.') + 1).toLowerCase() : ''
  if (ext.length > 0 && !exts.includes(ext)) {
    L.push(
      `本次是 \`.${ext}\` —— **不在**你这个角色的允许面里。两条出路：\n` +
        `  · 换个扩展名：${exts.join(' / ')}（可执行用例用 \`${r}-cases.mjs\` 这种命名）；\n` +
        `  · 只想跑一次性用例、不想落文件：把用例从 stdin 管道喂给解释器（例如 \`node --input-type=module -e "…"\`），` +
        '或把结论写进 `.md` / `.txt` 报告。',
    )
  }
  if (cls === 'own-log') {
    L.push('★ 你这个角色**只能写日志**，不能产出报告文件 —— 要交结论请用 pipeline_handoff（结构化交接物）。')
  }
  return L.join('\n')
}
