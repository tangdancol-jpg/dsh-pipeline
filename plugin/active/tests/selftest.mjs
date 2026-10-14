/**
 * dsh-pipeline · 命令行自测
 * ============================================================================
 * 用法：
 *
 *     node tests/selftest.mjs
 *     node tests/selftest.mjs --quiet      # 只打结论，不贴完整拒绝原文
 *
 * 退出码：0 = 全部通过；1 = 有失败用例。
 *
 * 这个脚本**不创建任何真实会话**，工作目录是临时目录、跑完即删。
 *
 * @module dsh-pipeline/tests/selftest
 */

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runSelfTest } from './selftest-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const verbose = !process.argv.includes('--quiet')

const report = await runSelfTest({ verbose })
console.log(report.text)

// 顺手把这一次的报告落到 tests/last-run.txt，方便贴给用户/留档。
try {
  const out = join(HERE, 'last-run.txt')
  await writeFile(out, `${report.text}\n`, 'utf8')
  console.log(`\n报告已写入：${out}`)
} catch (err) {
  console.log(`\n（报告落盘失败，不影响结论：${String(err?.message ?? err)}）`)
}

process.exit(report.passed === report.total ? 0 : 1)
