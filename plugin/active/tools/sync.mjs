#!/usr/bin/env node
// 把仓库的 plugin/active 镜像到安装副本：只拷有差异的文件（字节原样，保 LF），同步两次第二次零改动。
/**
 *   node tools/sync.mjs --repo <仓库>/plugin/active --installed <profile>/node_modules/dsh-pipeline [--prune]
 *
 * 规则（与 install-items.json 同一份范围）：
 *   · missing / changed ⇒ 按字节拷过去；内容相同的文件**不碰**（mtime 不变 ⇒ 幂等可证）；
 *   · extra（范围内、仓库已经没有的）⇒ 删掉 —— 旧模块留在副本里只会让人看不清跑的是哪一版；
 *   · 根目录上范围外的东西默认只报不删，`--prune` 才删；
 *   · 永不拷贝、永不删除：`.bak*`、`*-last-run.txt`、运行期 `*.jsonl`（见 sync-scope.mjs）；
 *   · 不写任何备份文件。
 * 拷完再比一次：仍不一致 ⇒ exit 1。
 *
 * @module dsh-pipeline/tools/sync
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { compareTrees } from './sync-scope.mjs'
import { parseArgs, renderReport } from './sync-check.mjs'

/**
 * 执行一次同步。
 * @returns {{copied:string[], removed:string[], unchanged:number, after:object}}
 */
export function syncTrees(repoDir, installedDir, { prune = false } = {}) {
  const cmp = compareTrees(repoDir, installedDir)
  const copied = []
  for (const rel of [...cmp.missing, ...cmp.changed]) {
    const dst = join(installedDir, rel)
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(cmp.repoFiles.get(rel), dst)
    copied.push(rel)
  }
  const removed = []
  for (const rel of cmp.extra) {
    rmSync(join(installedDir, rel), { force: true })
    removed.push(rel)
  }
  if (prune) {
    for (const name of cmp.strayRoot) {
      rmSync(join(installedDir, name), { recursive: true, force: true })
      removed.push(name)
    }
  }
  return { copied, removed, unchanged: cmp.same.length, after: compareTrees(repoDir, installedDir) }
}

export function main(argv) {
  const a = parseArgs(argv)
  if (a.repo === null || a.installed === null) {
    console.error('用法：node tools/sync.mjs --repo <仓库>/plugin/active --installed <profile>/node_modules/dsh-pipeline [--prune]')
    return 2
  }
  const repo = resolve(a.repo)
  const installed = resolve(a.installed)
  if (!existsSync(repo)) {
    console.error(`仓库目录不存在：${repo}`)
    return 2
  }
  mkdirSync(installed, { recursive: true })
  const r = syncTrees(repo, installed, { prune: argv.includes('--prune') })
  console.log(`已同步：拷贝 ${r.copied.length} · 删除 ${r.removed.length} · 未变 ${r.unchanged}`)
  for (const p of r.copied) console.log(`  copy    ${p}`)
  for (const p of r.removed) console.log(`  remove  ${p}`)
  const rep = renderReport(r.after)
  console.log(rep.text)
  return rep.ok ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
