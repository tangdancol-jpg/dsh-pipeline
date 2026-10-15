// 预设包的**事实常量**：main 多出来的源文件、本机证不了 schema 的模块名。
//
// 从 `tests/p11-presets-check.mjs` 抽出来（2026-10-16 · 行数纪律：那一份要加行，先拆）。
// 它们是**判据的取值域**（不是断言本身），放这里能让 p11 与 p11b 共用同一份。
//
// @module dsh-pipeline/tests/preset-package-facts

export const MAIN_EXTRA_FILES = ['prefix.md', 'suffix.md', 'capability.json']

export const EXTRA_FILES_BY_ROLE = { main: MAIN_EXTRA_FILES }

export const UNVERIFIABLE_MODULES = [
  'cordis:group',
  'dsh-orb/computer-use',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
]
