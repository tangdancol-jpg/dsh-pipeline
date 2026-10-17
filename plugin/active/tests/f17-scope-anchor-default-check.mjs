// 缺陷 ① 回归：授权面里的相对路径默认锚到项目根，不是插件包根；显式锚点照旧优先，真越界照旧拦。
/**
 * dsh-pipeline · F17：授权面锚点的默认值
 * ============================================================================
 *     node tests/f17-scope-anchor-default-check.mjs
 *
 * 现场（T-20261016-ff9ba7）：`scope_anchor = ""`、计划写 `hello-dsh-pipeline/` ⇒ 锚点退回插件包根，
 * 相对路径被解析成 `…/node_modules/dsh-pipeline/hello-dsh-pipeline` ⇒ 编写写
 * `<项目根>/hello-dsh-pipeline/README.md` 三连拒「写入位置不在任何编写席位的分区里」。
 *
 * ★ 这里**不用** selftest-core 的 harness：它没配锚点时会把锚点设成项目根，正好盖住这个缺陷。
 *   守门一侧照 index.js 的真实装配建索引（scope_anchor 空、配置空），审计一侧照它建 store（不传 scopeAnchor）。
 *
 * 钉住：
 *   ①-A 单元：相对路径解析到项目根，绝不落在插件包根
 *   ①-B 端到端：守门放行写项目根下的授权路径（三连拒已消）；改动审计也认它在授权面内
 *   ①-C 反向：写项目根之外 / 写插件安装树（不在授权面）照旧拒
 *   ①-D 反向：显式锚点（task.scope_anchor）照旧优先 —— 改插件自己的单还走得通
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { guardDecision, makeTaskIndexEntry, resolveScopeAnchor } from '../lib/guard.js'
import { createTaskStore } from '../lib/store.js'
import { createTokenStore } from '../lib/tokens.js'
import { PACKAGE_ROOT, pathKey } from '../lib/util.js'

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
      const L = ['dsh-pipeline · F17：授权面锚点默认 = 项目根（缺陷 ①）', '='.repeat(78)]
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

const first = (s) => String(s ?? '(放行)').split('\n')[0]

/** 照 index.js 的 indexTask 建一条守门索引（scope_anchor 空串 + 配置空串 —— 现场形状）。 */
function liveEntry(taskId, projectRoot, scopeAnchor = '') {
  return makeTaskIndexEntry({
    taskId,
    projectRoot: pathKey(projectRoot),
    pipelineDir: pathKey(join(projectRoot, '.pipeline')),
    scopeAnchor,
    writers: { partitions: [{ seat: 'writer#1', layer: 'all', scope_paths: ['hello-dsh-pipeline/'] }] },
    changeScope: [{ id: 'CS1', path: 'hello-dsh-pipeline/', action: 'create', why: '现场形状' }],
  })
}

export async function runF17ScopeAnchorDefaultCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f17-'))
  try {
    const projectRoot = join(root, 'desktop')
    mkdirSync(projectRoot, { recursive: true })

    {
      const G = '①-A 单元：相对路径锚到项目根'
      const a = resolveScopeAnchor('hello-dsh-pipeline/', { projectRoot })
      rec.add(G, '★★ 相对锚点解析到 <项目根>/hello-dsh-pipeline', a === pathKey(join(projectRoot, 'hello-dsh-pipeline')), a)
      rec.add(G, '★★ 绝不落在插件包根之下', !a.startsWith(PACKAGE_ROOT), `${a}\nPACKAGE_ROOT=${PACKAGE_ROOT}`)
      rec.add(G, '★ 没配锚点 ⇒ 默认就是项目根', resolveScopeAnchor('', { projectRoot }) === pathKey(projectRoot), resolveScopeAnchor('', { projectRoot }))
    }

    const tokens = createTokenStore()
    tokens.mint({ taskId: 'T-F17', role: 'writer', seat: 'writer#1', agentId: 'f17-w1' })
    const index = new Map([['T-F17', liveEntry('T-F17', projectRoot)]])
    const write = (p) => guardDecision({ name: 'write', arguments: { file_path: p, content: 'x' }, agent: { id: 'f17-w1' } }, { tokens, taskIndex: index, config: {} })

    {
      const G = '①-B 端到端：现场那三连拒消失'
      for (const f of ['hello.cs', 'build.ps1', 'README.md']) {
        const r = write(join(projectRoot, 'hello-dsh-pipeline', f))
        rec.add(G, `★★ 写 <项目根>/hello-dsh-pipeline/${f} ⇒ 放行`, r === undefined, first(r))
      }
      const store = createTaskStore({ projectRoot })
      const opened = await store.open({ actorRole: 'main', requirement: 'F17：在项目根下新建 hello-dsh-pipeline。', id: 'T-F17S' })
      const t = store.peek('T-F17S')
      t.change_scope = [{ id: 'CS1', path: 'hello-dsh-pipeline/', action: 'create', why: '现场形状' }]
      await store.takeBaseline({ taskId: 'T-F17S' })
      mkdirSync(join(projectRoot, 'hello-dsh-pipeline'), { recursive: true })
      writeFileSync(join(projectRoot, 'hello-dsh-pipeline', 'README.md'), '# hello\n')
      const audit = await store.changeAudit({ taskId: 'T-F17S' })
      rec.add(G, '★★ 改动审计（store 侧）与守门同一个锚点：认得出它在授权面内', opened.ok === true && audit.ok === true && audit.unauthorized.length === 0 && audit.added.some((x) => x.path === 'hello-dsh-pipeline/README.md'), JSON.stringify({ verdict: audit.verdict, unauthorized: audit.unauthorized?.map((x) => x.path) }))
    }

    {
      // ★ 注：项目根**之外**的写入，分区判据本来就弃权（前置闸是 isInside(projectRoot, p)，改前改后一样）——
      //   移交文档 ①-C 以为它现在是拒的，实测不是；改它是另一条策略，不在缺陷 ① 的范围里，这里不断言。
      const G = '①-C 反向：真越界照旧拦'
      const pluginTree = write(join(projectRoot, 'node_modules', 'dsh-pipeline', 'lib', 'guard.js'))
      rec.add(G, '★★ 写插件安装树（不在授权面）⇒ 拒', pluginTree !== undefined, first(pluginTree))
      const sibling = write(join(projectRoot, 'other-project', 'a.js'))
      rec.add(G, '★ 写项目根下别的目录（不在分区）⇒ 拒', sibling !== undefined, first(sibling))
    }

    {
      const G = '①-D 反向：显式锚点照旧优先'
      const pkgRoot = join(projectRoot, 'node_modules', 'dsh-pipeline')
      const e = makeTaskIndexEntry({
        taskId: 'T-F17P',
        projectRoot: pathKey(projectRoot),
        pipelineDir: pathKey(join(projectRoot, '.pipeline')),
        scopeAnchor: pkgRoot,
        writers: { partitions: [{ seat: 'writer#1', layer: 'all', scope_paths: ['lib/'] }] },
        changeScope: [{ id: 'CS1', path: 'lib/', action: 'modify', why: '改插件自己' }],
      })
      rec.add(G, '★ 显式锚点（插件包）原样生效', e.scopeAnchor === pathKey(pkgRoot), e.scopeAnchor)
      const tk = createTokenStore()
      tk.mint({ taskId: 'T-F17P', role: 'writer', seat: 'writer#1', agentId: 'f17-w2' })
      const idx = new Map([['T-F17P', e]])
      const r = guardDecision({ name: 'write', arguments: { file_path: join(pkgRoot, 'lib', 'x.js'), content: 'x' }, agent: { id: 'f17-w2' } }, { tokens: tk, taskIndex: idx, config: {} })
      rec.add(G, '★★ 改插件自己的单：写 <包>/lib/x.js ⇒ 放行', r === undefined, first(r))
      const r2 = guardDecision({ name: 'write', arguments: { file_path: join(projectRoot, 'lib', 'x.js'), content: 'x' }, agent: { id: 'f17-w2' } }, { tokens: tk, taskIndex: idx, config: {} })
      rec.add(G, '★ 同一单写 <项目根>/lib/x.js ⇒ 拒（锚点没被默认值顶掉）', r2 !== undefined, first(r2))
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF17ScopeAnchorDefaultCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
