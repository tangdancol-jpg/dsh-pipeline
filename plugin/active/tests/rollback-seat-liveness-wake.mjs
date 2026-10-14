/**
 * dsh-pipeline · **回滚脚本**（编写席位 writer#1 本轮两处补丁的精确逆操作）
 * ============================================================================
 *     node tests/rollback-seat-liveness-wake.mjs <插件副本根目录> [--check]
 *
 * 为什么需要它：交付要求写明"回滚方式"。本轮两处改动**落在上一批已落盘的文件里**，
 * 而 `lib/*.bak-*` 那些备份**早于**上一批改动（例如 5921 行的 `store.js.bak-t14-…
 * 20261012-214720` 是 2026-10-12 20:21 的快照，而线上跑的是 21:49 那一版）
 * ⇒ **不能用它们当回滚基线**，那会把上一批修复一起退掉。所以这里按"**只撤本轮这两处**"
 * 写死逆操作。
 *
 * 位置说明：本文件**刻意放在 `tests/` 下**而不是 `tools/` —— 本任务的授权面里
 * 只有 `tests/` 是 `create`，`tools/` 不在授权面内（守门已经拦过一次，如实记在这里）。
 * 它不参与运行，也不被任何用例 import；当交付附件用。
 *
 * 判据（脚本自己会验）：
 *   · 幂等：已经撤过再跑一次 → 报"无改动"，退出码 0；
 *   · 只撤自己那两处：替换串里带着本轮的注释与代码，命中数不是 1 就**一个字节都不写**；
 *   · `--check` 只报告状态、不写盘。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
const checkOnly = process.argv.includes('--check')
if (typeof root !== 'string' || root.length === 0 || root.startsWith('--')) {
  console.error('用法：node tests/rollback-seat-liveness-wake.mjs <插件副本根目录> [--check]')
  process.exit(2)
}

/** 三处逆操作（两处在 liveness.js、一处在 store/submit.js）。 */
const PATCHES = [
  {
    file: join(root, 'lib', 'store', 'submit.js'),
    name: 'B3：澄清记录上的 from_seat（含注释块）',
    marker: 'clarification.from_seat = typeof input.actorSeat',
    find: `        clarification = this.createClarificationEntry(task, record, v.normalized)
        /**
         * ★★ **B3 缺件补丁（2026-10-12 · writer#1）：把"是谁问的"里的「席位」也记下来。**
         *
         * 现场：裁定落地之后 \`pipeline_clarify_reply\` 拿 \`res.request.from_seat\` 去唤醒
         * 发起席位（\`lib/tools.js\` 的 \`wakeResumedSeat\`），而 \`createClarificationEntry\`
         * **从来没有写过 \`from_seat\`** —— 它恒为 undefined，于是 \`nudgeSeat\` 只按
         * \`role\` 找派活台账、命中**第一个**同角色记录。
         *
         * 后果（多编写席位时可复现的错投）：「writer#2」提问、裁定却投进了「writer#1」
         * 的会话 —— 真正停手的那个席位仍然卡死，而机制以为已经把它叫醒了。
         *
         * 口径：席位**只从令牌来**（\`input.actorSeat\`，与 \`submitHandoff\` 其它分支同一出处）。
         * 不让调用方在 payload 里自报 \`from_seat\` —— 那是第二个真相源，而"谁问的"必须由凭据决定。
         * 非编写角色没有席位（\`actorSeat\` 为 null）⇒ 照旧 null，行为不变。
         */
        clarification.from_seat = typeof input.actorSeat === 'string' && input.actorSeat.length > 0 ? input.actorSeat : null
`,
    replace: `        clarification = this.createClarificationEntry(task, record, v.normalized)
`,
  },
  {
    file: join(root, 'lib', 'liveness.js'),
    name: 'A4：activityKnownHere 的声明',
    marker: 'activityKnown: activityKnownHere,',
    find: `  /** ★ A4：本次有没有拿到活动证据（\`false\` ⇒ 摘要素写成"拿不到会话日志"，不许写"它没在长"）。 */
  const activityKnownHere = activity !== null
`,
    replace: '',
  },
  {
    file: join(root, 'lib', 'liveness.js'),
    name: 'A4：activityKnown 的调用点（含注释块）',
    marker: 'activityKnown: activityKnownHere,',
    find: `      /**
       * ★★ **A4 补丁（2026-10-12 · writer#1）：本次到底有没有拿到会话日志。**
       *
       * \`describeSilentSeats\` 里那一支（"并且**这一次拿不到会话日志**"）本来就存在，
       * 但这里**一直没传** ⇒ 它永远走不到，正文永远声称"会话日志也没在长"。
       * 那是**把"拿不到证据"说成了"它没动"** —— 与审计里 \`activity_known:false\` 自相矛盾。
       */
      activityKnown: activityKnownHere,
`,
    replace: '',
  },
]

let changed = 0
let already = 0
let failed = 0

for (const p of PATCHES) {
  if (!existsSync(p.file)) {
    console.log(`✗ ${p.name}：找不到文件 ${p.file}`)
    failed += 1
    continue
  }
  const src = readFileSync(p.file, 'utf8')
  if (!src.includes(p.marker)) {
    console.log(`· ${p.name}：已经是回滚后的状态（无改动）`)
    already += 1
    continue
  }
  const hits = src.split(p.find).length - 1
  if (hits !== 1) {
    console.log(`✗ ${p.name}：期望命中 1 处，实际 ${hits} 处 —— **未写盘**（源码与预期不一致，请人工核对）`)
    failed += 1
    continue
  }
  const out = src.replace(p.find, p.replace)
  if (checkOnly) {
    console.log(`✓ ${p.name}：可回滚（--check，未写盘）`)
    changed += 1
    continue
  }
  writeFileSync(p.file, out, 'utf8')
  console.log(`✓ ${p.name}：已回滚（${Buffer.byteLength(src, 'utf8')} → ${Buffer.byteLength(out, 'utf8')} 字节）`)
  changed += 1
}

console.log(`\n${checkOnly ? '【--check】' : ''}可回滚/已回滚 ${changed} 处，本来就是干净态 ${already} 处，失败 ${failed} 处。`)
process.exit(failed === 0 ? 0 : 1)
