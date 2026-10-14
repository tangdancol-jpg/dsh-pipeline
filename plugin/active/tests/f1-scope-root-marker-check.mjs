/**
 * dsh-pipeline · 缺陷 ①：`scope_paths: ['.']` 被解析到插件包根
 * ============================================================================
 *     node tests/f1-scope-root-marker-check.mjs
 *
 * 真机现场（T-20261015-bb30bc）：
 *   L0 自批产出的编写分区是 `scope_paths: ['.']`，`requirement.md` 与所有渲染口径
 *   都把它读作「**整棵项目根**」；而判据把它解析成**插件包根**
 *   （`node_modules/dsh-pipeline`）⇒ 项目根下**任何**路径都判越界，
 *   编写席写不进项目源码树，交付物只能落在 `.pipeline/<任务>/artifacts/`。
 *
 * 本套钉住四件事：
 *   A. `'.'` 这个根标记 ⇒ **本任务的 project_root**（与渲染口径一致）；
 *   B. 其它裸相对路径 ⇒ **锚点**（改前行为，一个字没动 —— 不制造第二个分叉）；
 *   C. 不给 projectRoot 的老调用 ⇒ 与改前**逐字节等价**（既有测试不受影响）；
 *   D. 分区判据 / 授权面判据 / 渲染 三处**同一个结论**（缺陷的另一半：文案与判据不许再打架）。
 *
 * ★ 全程密闭：路径是拼出来的假目录，不读任何活体真单、不落盘。
 */

import { pathToFileURL } from 'node:url'

import { describeScopePaths, isRootMarker, resolveScopePath } from '../lib/scope/root-marker.js'
import { owningChangeScopeEntry, owningSeat } from '../lib/guard.js'
import { describePartitions, describeSeat } from '../lib/guard/seats.js'
import { pathKey } from '../lib/util.js'

function createRecorder() {
  const items = []
  return {
    items,
    add(group, name, pass, detail) {
      items.push({ group, name, pass: pass === true, detail: String(detail ?? '') })
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
    text() {
      const L = ['dsh-pipeline · 缺陷 ①：scope_paths=[\x27.\x27] 被解析到插件包根', '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('', `【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(`      ${it.detail.split('\n').join('\n      ')}`)
      }
      L.push('', '='.repeat(78), `总计：${this.passed}/${this.total} 通过`, '='.repeat(78))
      return L.join('\n')
    },
  }
}

export async function runF1ScopeRootMarkerCheck() {
  const rec = createRecorder()

  // 真机的布局形状（profile 工作区 里装着 node_modules/dsh-pipeline）
  const PROJECT = pathKey('%USERPROFILE%/.dsh/profiles/desktop')
  const PACKAGE = pathKey(`${PROJECT}/node_modules/dsh-pipeline`)
  const CTX = { anchor: PACKAGE, projectRoot: PROJECT }

  try {
    // ------------------------------------------------------------ A 根标记
    const G1 = 'A 根标记 `\x27.\x27` ⇒ 项目根（容器级判据）'
    rec.add(G1, '`.`, `./`, `.\\` 三种写法都认成根标记', isRootMarker('.') && isRootMarker('./') && isRootMarker('.\\'), '')
    rec.add(G1, '★ `resolveScopePath(".", {anchor, projectRoot})` === **项目根**', resolveScopePath('.', CTX) === PROJECT, `${resolveScopePath('.', CTX)}`)
    rec.add(G1, '对照：改前口径（`resolveAgainstAnchor(anchor, ".")`）给的是**包根**', resolveScopePath('.', { anchor: PACKAGE, projectRoot: '' }) === PACKAGE, `${resolveScopePath('.', { anchor: PACKAGE, projectRoot: '' })}`)

    // ------------------------------------------------------------ B 其它相对路径
    const G2 = 'B 其它裸相对路径仍按**锚点**解析（改前行为，不许制造第二个分叉）'
    rec.add(G2, '`index.js` ⇒ 包根下的那一份（真单 T-20261011-214043 的实测口径）', resolveScopePath('index.js', CTX) === `${PACKAGE}/index.js`, `${resolveScopePath('index.js', CTX)}`)
    rec.add(G2, '`lib/tools.js` ⇒ 包根下的那一份', resolveScopePath('lib/tools.js', CTX) === `${PACKAGE}/lib/tools.js`, `${resolveScopePath('lib/tools.js', CTX)}`)
    rec.add(G2, '绝对路径原样归一化（不受根标记改动影响）', resolveScopePath('C:\\proj\\src\\a.mjs', CTX) === pathKey('C:/proj/src/a.mjs'), `${resolveScopePath('C:\\proj\\src\\a.mjs', CTX)}`)
    rec.add(G2, '空串 ⇒ 空串（"压根没写路径"仍然判得出）', resolveScopePath('', CTX) === '', '')

    // ------------------------------------------------------------ C 向后兼容
    const G3 = 'C 不给 projectRoot 的老调用 ⇒ 与改前逐字节等价'
    rec.add(G3, '★ 三参数 `owningChangeScopeEntry(scope, abs, anchor)`（既有测试的调法）里 `\x27.\x27` 仍落锚点', owningChangeScopeEntry([{ id: 'S', path: '.', action: 'modify' }], `${PACKAGE}/lib/a.js`, PACKAGE)?.id === 'S', '')
    rec.add(G3, '★ 同上：项目根下的文件**不**被老调法命中（= 改前行为，既有断言不会被我改动翻掉）', owningChangeScopeEntry([{ id: 'S', path: '.', action: 'modify' }], `${PROJECT}/src/a.mjs`, PACKAGE) === null, '')

    // ------------------------------------------------------------ D 三处同结论
    const G4 = 'D 分区判据 / 授权面判据 / 渲染 —— 三处同一个结论（真机缺陷的另一半）'
    const parts = [{ seat: 'writer#1', layer: 'all', scope_paths: ['.'], deliverables: [] }]
    const target = `${PROJECT}/src/fizzbuzz.mjs`
    const owner = owningSeat(parts, target, PACKAGE, PROJECT)
    rec.add(G4, '★★ 现场形状：`scope_paths:[\x27.\x27]` 的席位**拥有**项目根下的 `src/fizzbuzz.mjs`', owner?.seat === 'writer#1', `owner=${owner === null ? 'null（改前就是这个 ⇒ 编写席写不进项目）' : owner.seat}`)
    rec.add(G4, '★ 项目根**之外**的路径仍然不归它（`\x27.\x27` 不是"整台机器"）', owningSeat(parts, pathKey('C:/elsewhere/x.mjs'), PACKAGE, PROJECT) === null, '')
    rec.add(G4, '★ 包根之下的那一份同样归它（项目根 ⊇ 包根，一个都没丢）', owningSeat(parts, `${PACKAGE}/lib/util.js`, PACKAGE, PROJECT)?.seat === 'writer#1', '')
    rec.add(G4, '★ 渲染说「整棵项目根」', describeSeat(parts, 'writer#1', PROJECT) === '整棵项目根', describeSeat(parts, 'writer#1', PROJECT))
    rec.add(G4, '★ `describePartitions` 与 `describeSeat` 同口径', describePartitions(parts, PROJECT).includes('整棵项目根'), describePartitions(parts, PROJECT))
    rec.add(G4, '`describeScopePaths` 空清单 ⇒ 「(未声明)」（不假装有范围）', describeScopePaths([]) === '(未声明)' && describeScopePaths(undefined) === '(未声明)', '')

    const scope = [{ id: 'WS', path: '.', action: 'modify', why: '单席位：范围是整棵项目根' }]
    const hit = owningChangeScopeEntry(scope, target, PACKAGE, PROJECT)
    rec.add(G4, '★★ 授权面 `path:\x27.\x27`（同一套自测夹具里的写法）也命中项目根下的文件', hit?.id === 'WS', `hit=${hit === null ? 'null' : hit.id}`)
    rec.add(G4, '★ 授权面 `\x27.\x27` 仍然**不**覆盖项目根之外', owningChangeScopeEntry(scope, pathKey('C:/elsewhere/x.mjs'), PACKAGE, PROJECT) === null, '')

    // 反例：多席位分区表里 `'.'` 只属于声明它的那个席位，不误伤别人的具体范围
    const two = [
      { seat: 'writer#1', layer: 'interface', scope_paths: ['.'] },
      { seat: 'writer#2', layer: 'data', scope_paths: ['lib/data'] },
    ]
    rec.add(G4, '★ 反例：`\x27.\x27` 不与别人的具体范围互相翻转 —— 各自命中各自那条', owningSeat(two, `${PACKAGE}/lib/data/x.js`, PACKAGE, PROJECT)?.matched === '.' && owningSeat(two, `${PROJECT}/other.js`, PACKAGE, PROJECT)?.seat === 'writer#1', '')
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  }

  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF1ScopeRootMarkerCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
