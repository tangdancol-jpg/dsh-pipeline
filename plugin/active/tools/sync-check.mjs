#!/usr/bin/env node
// 只读校验：仓库的 plugin/active 与 DSH 实际加载的安装副本逐文件哈希一致吗？不一致就非零退出并逐条列出。
/**
 *   node tools/sync-check.mjs --repo <仓库>/plugin/active --installed <profile>/node_modules/dsh-pipeline
 *
 * 一致 ⇒ exit 0，输出 `OK: N/N 一致`；
 * 不一致 ⇒ exit 1，逐条列出 missing（仓库有、副本没有）/ extra（副本多出来的）/ changed（字节不同）。
 * 安装副本根目录上范围外的东西（strayRoot）也列出来并判不一致 —— 镜像里不该有来历不明的文件。
 * 缺参数 / 目录不存在 ⇒ exit 2。
 *
 * 为什么要有它（缺陷 ⑦）：DSH 加载的是安装副本，不是仓库。改完仓库没同步就重启，
 * 跑的仍是旧码 —— 判据明明写了却测不出来，最容易让人误判"修复无效"。
 *
 * @module dsh-pipeline/tools/sync-check
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { compareTrees } from './sync-scope.mjs'

export function parseArgs(argv) {
  const out = { repo: null, installed: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') out.repo = argv[++i] ?? null
    else if (argv[i] === '--installed') out.installed = argv[++i] ?? null
  }
  return out
}

/** 把比对结果渲染成报告；返回 `{ ok, text }`。 */
export function renderReport(cmp) {
  const total = cmp.repoFiles.size
  const bad = cmp.missing.length + cmp.extra.length + cmp.changed.length + cmp.strayRoot.length
  if (bad === 0) return { ok: true, text: `OK: ${cmp.same.length}/${total} 一致` }
  const L = [`不一致：${cmp.same.length}/${total} 一致（missing ${cmp.missing.length} · extra ${cmp.extra.length} · changed ${cmp.changed.length} · 根目录多余 ${cmp.strayRoot.length}）`]
  for (const p of cmp.missing) L.push(`  missing  ${p}`)
  for (const p of cmp.extra) L.push(`  extra    ${p}`)
  for (const p of cmp.changed) L.push(`  changed  ${p}`)
  for (const p of cmp.strayRoot) L.push(`  extra    ${p}（安装副本根目录上、不在复制范围里）`)
  L.push('修法：node tools/sync.mjs --repo <同上> --installed <同上>，同步后重启 DSH。')
  return { ok: false, text: L.join('\n') }
}

export function main(argv) {
  const a = parseArgs(argv)
  if (a.repo === null || a.installed === null) {
    console.error('用法：node tools/sync-check.mjs --repo <仓库>/plugin/active --installed <profile>/node_modules/dsh-pipeline')
    return 2
  }
  const repo = resolve(a.repo)
  const installed = resolve(a.installed)
  if (!existsSync(repo)) {
    console.error(`仓库目录不存在：${repo}`)
    return 2
  }
  if (!existsSync(installed)) {
    console.error(`安装副本不存在：${installed}（还没装过？先跑 install.ps1）`)
    return 2
  }
  const r = renderReport(compareTrees(repo, installed))
  console.log(r.text)
  return r.ok ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
