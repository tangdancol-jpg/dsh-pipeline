// 仓库 ↔ 安装副本的比对口径：哪些文件在范围内、哪些永远不碰，以及逐文件哈希比对。
/**
 * 范围来自同目录的 `install-items.json`（与 install.ps1 同一份）：
 *   · `runtime` 一定在范围内；`docs` 只有安装副本里**已经有**时才比（install.ps1 -WithDocs 才装）；
 *   · `excludeNames` / `excludePatterns` 命中的一律不比、不拷、不删 ——
 *     备份残留（`.bak*`）、测试报告（`*-last-run.txt`）、运行期数据（`*.jsonl`）都不是"代码"。
 *
 * @module dsh-pipeline/tools/sync-scope
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 读复制范围（唯一出处）。 */
export function loadInstallItems(file = join(HERE, 'install-items.json')) {
  const j = JSON.parse(readFileSync(file, 'utf8'))
  return {
    runtime: j.runtime ?? [],
    docs: j.docs ?? [],
    excludeNames: j.excludeNames ?? [],
    excludePatterns: j.excludePatterns ?? [],
  }
}

const globToRe = (g) => new RegExp(`^${g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')

/** 这个名字（只看最后一段）是不是永远不碰的那一类。 */
export function makeExcluder(items) {
  const names = new Set(items.excludeNames.map((n) => n.toLowerCase()))
  const res = items.excludePatterns.map(globToRe)
  return (name) => names.has(String(name).toLowerCase()) || res.some((re) => re.test(name))
}

/** 把一棵树里范围内的文件列成 `相对路径(正斜杠) → 绝对路径`。 */
function walk(root, rel, excluded, out) {
  const abs = join(root, rel)
  const st = statSync(abs)
  if (!st.isDirectory()) {
    out.set(rel.split('\\').join('/'), abs)
    return
  }
  for (const name of readdirSync(abs)) {
    if (excluded(name)) continue
    walk(root, rel.length > 0 ? `${rel}/${name}` : name, excluded, out)
  }
}

/**
 * 列出一棵树在范围内的全部文件。
 * @param {string} root
 * @param {string[]} entries - 顶层条目（runtime + 适用的 docs）
 * @param {(name:string)=>boolean} excluded
 */
export function listScoped(root, entries, excluded) {
  const out = new Map()
  for (const e of entries) {
    if (excluded(e) || !existsSync(join(root, e))) continue
    walk(root, e, excluded, out)
  }
  return out
}

export const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/**
 * 逐文件比对仓库与安装副本。
 * @returns {{entries:string[], same:string[], missing:string[], extra:string[], changed:string[], strayRoot:string[], repoFiles:Map, installedFiles:Map}}
 *   `strayRoot`：安装副本**根目录**上不属于任何条目的东西（范围外，只报不删）。
 */
export function compareTrees(repoDir, installedDir, items = loadInstallItems()) {
  const excluded = makeExcluder(items)
  const docsPresent = items.docs.filter((d) => existsSync(join(installedDir, d)))
  const entries = [...items.runtime, ...docsPresent]
  const repoFiles = listScoped(repoDir, entries, excluded)
  const installedFiles = existsSync(installedDir) ? listScoped(installedDir, entries, excluded) : new Map()
  const same = []
  const missing = []
  const changed = []
  for (const [rel, abs] of repoFiles) {
    const got = installedFiles.get(rel)
    if (got === undefined) missing.push(rel)
    else if (sha256Of(abs) === sha256Of(got)) same.push(rel)
    else changed.push(rel)
  }
  const extra = [...installedFiles.keys()].filter((rel) => !repoFiles.has(rel))
  const known = new Set(entries.map((e) => e.toLowerCase()))
  const strayRoot = existsSync(installedDir)
    ? readdirSync(installedDir).filter((n) => !known.has(n.toLowerCase()) && !excluded(n) && !items.docs.includes(n))
    : []
  return { entries, same, missing, extra, changed, strayRoot, repoFiles, installedFiles }
}
