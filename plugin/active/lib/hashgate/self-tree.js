// 哈希闸门 · 插件自身文件的识别与排除：安装树、profile 根上的备份残留与 profile 配置不是"被开发项目的文件"（缺陷 ⑧）。
/**
 * 现场（T-20261016-ff9ba7）：任务的 project_root 就是 DSH 的 profile 目录，插件安装副本
 * `<profile>/node_modules/dsh-pipeline/**` 落在项目根之内 ⇒ 同步一次副本，`dev_to_test` 就被判
 * 306 处越界（安装树 298 · 备份残留 6 · profile 配置 2），没有一条是项目文件 ⇒ 整单交不出交接物。
 *
 * 识别三类（只看相对项目根的路径，不读盘）：
 *   · `install` 插件安装树：路径里有 `node_modules/<本插件包名>/`；
 *   · `backup`  备份残留：profile 根上的 `*.bak` / `*.bak-*`；
 *   · `config`  profile 配置：profile 根上由宿主自己写的 `orb-update.json`。
 *
 * ★ profile 根上的 `cordis.patch.yml` / `package.json` **不排除**：它们是越界清单点名禁改的档
 *   （`lib/util.js` 的 PACKAGE_ROOT 注释、`tests/scope-check.mjs` 的 C 组钉着），被改了照常算越界；
 *   拒绝时由 {@link describeProtectedProfileConfig} 点明"这是禁改配置，确认是人工改的就重取基线"。
 * 后两类只在"项目根就是装着本插件的 profile"时才认（项目根下确有那棵安装树）——
 * 普通项目根上的同名文件照常审计。
 *
 * ★ 排除有两道前提，缺一不排（不放松"项目文件被越界改动必须 fail"）：
 *   ① 这条路径**不在**本单授权面内 —— 本单就是来改插件自己的，就照常审计；
 *   ② 本单的席位**没有**写过 / 申报过它（席位级写入台账里没有它）—— 席位亲手碰过的照常算。
 *
 * @module dsh-pipeline/lib/hashgate/self-tree
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PACKAGE_ROOT } from '../util.js'

/** 本插件的包名（唯一出处：插件自己的 package.json）。 */
export const PLUGIN_PACKAGE_NAME = (() => {
  try {
    return String(JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).name ?? 'dsh-pipeline')
  } catch {
    return 'dsh-pipeline'
  }
})()

export const SELF_TREE_KIND_ZH = Object.freeze({ install: '插件安装树', backup: '备份残留', config: 'profile 配置' })

const PROFILE_CONFIG_NAMES = new Set(['orb-update.json'])
/** profile 根上点名禁改的配置（不排除，照常审计）。 */
const PROTECTED_PROFILE_NAMES = new Set(['cordis.patch.yml', 'package.json'])
const BACKUP_RE = /\.bak(-[^/]*)?$/i

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
const installMark = () => `node_modules/${PLUGIN_PACKAGE_NAME.toLowerCase()}/`

/** 本单席位在席位级写入台账里写过 / 申报过的路径（规范绝对键，小写）。 */
export function seatTouchedKeys(entries, taskId) {
  const keys = new Set()
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e?.task_id !== taskId) continue
    for (const x of Array.isArray(e.paths) ? e.paths : []) keys.add(String(x?.key ?? '').toLowerCase())
  }
  return keys
}

/** 这条相对路径在不在插件安装树里。 */
export function isInstallTreePath(rel) {
  const k = norm(rel)
  return k.startsWith(installMark()) || k.includes(`/${installMark()}`)
}

/**
 * 归类一条相对项目根的路径。
 * @param {string} rel
 * @param {{profileRoot:boolean}} ctx - 项目根是不是装着本插件的 profile
 * @returns {'install'|'backup'|'config'|null}
 */
export function classifySelfTree(rel, { profileRoot }) {
  if (isInstallTreePath(rel)) return 'install'
  const k = norm(rel)
  if (!profileRoot || k.includes('/')) return null
  if (BACKUP_RE.test(k)) return 'backup'
  if (PROFILE_CONFIG_NAMES.has(k)) return 'config'
  return null
}

/**
 * 把前后差异里的插件自身文件拣出来。
 *
 * @param {object} input
 * @param {{added:object[], modified:object[], removed:object[]}} input.diff
 * @param {string[]} input.knownPaths - 基线 ∪ 当前快照的全部相对路径（用来判"项目根是不是 profile"）
 * @param {(rel:string)=>boolean} input.isAuthorized - 这条路径在不在本单授权面内
 * @param {(rel:string)=>boolean} input.touchedBySeat - 本单席位有没有写过 / 申报过它
 * @returns {{added:object[], modified:object[], removed:object[], excluded:Array<{path:string, kind:string, change:string}>, counts:Record<string,number>, profileRoot:boolean}}
 */
export function splitSelfTree({ diff, knownPaths, isAuthorized, touchedBySeat }) {
  const profileRoot = knownPaths.some((p) => isInstallTreePath(p))
  const excluded = []
  const keep = (list, change) =>
    list.filter((x) => {
      const kind = classifySelfTree(x.path, { profileRoot })
      if (kind === null || isAuthorized(x.path) || touchedBySeat(x.path)) return true
      excluded.push({ path: x.path, kind, change })
      return false
    })
  const out = { added: keep(diff.added, 'added'), modified: keep(diff.modified, 'modified'), removed: keep(diff.removed, 'removed') }
  const counts = { install: 0, backup: 0, config: 0 }
  for (const e of excluded) counts[e.kind] += 1
  return { ...out, excluded, counts, profileRoot }
}

/**
 * 违规里有 profile 根上的禁改配置时给一句说明（照常算越界，只是告诉人怎么处理）；没有就返回空串。
 * @param {string[]} paths - 违规路径（相对项目根）
 * @param {boolean} profileRoot - 项目根是不是装着本插件的 profile（`changeAudit` 的 `profile_root`）
 */
export function describeProtectedProfileConfig(paths, profileRoot) {
  if (profileRoot !== true) return ''
  const hit = [...new Set(paths.map(norm).filter((k) => PROTECTED_PROFILE_NAMES.has(k)))]
  if (hit.length === 0) return ''
  return `其中 ${hit.join('、')} 是 profile 根上点名禁改的配置，照常算越界、不自动排除；确认是人工改的（不是本单席位），就重取基线（pipeline_change_audit { take: true }）。`
}

/** 分类摘要（一行人话）；没有排除时返回空串。 */
export function describeSelfTree(counts) {
  const total = (counts?.install ?? 0) + (counts?.backup ?? 0) + (counts?.config ?? 0)
  if (total === 0) return ''
  const parts = Object.keys(SELF_TREE_KIND_ZH).filter((k) => (counts[k] ?? 0) > 0).map((k) => `${SELF_TREE_KIND_ZH[k]} ${counts[k]}`)
  return `已排除插件自身改动 ${total} 处（${parts.join(' · ')}）—— 不是被开发项目的文件，不计入越界；本单席位写过的、或在授权面内的照常审计。`
}
