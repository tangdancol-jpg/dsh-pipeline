// 缺陷 ⑧ 回归：哈希闸门不再把插件自身安装树与 profile 配置算成项目改动，但项目文件越界、席位偷改插件照样拒。
/**
 * dsh-pipeline · F16：哈希闸门排除插件自身文件
 * ============================================================================
 *     node tests/f16-hashgate-self-tree-check.mjs
 *
 * 现场（T-20261016-ff9ba7）：project_root 就是 profile，插件安装副本落在项目根内；同步一次副本后
 * `dev_to_test` 被判越界 306 处（安装树 298 · 备份残留 6 · profile 配置 2），没有一条是项目文件。
 *
 * 钉住：
 *   ⑧-A 只动了插件自身文件（同步副本 / 备份 / profile 配置）⇒ 闸门 pass，审计记下分类计数
 *   ⑧-B 项目文件越界 ⇒ 照样 fail，violations 里有它
 *   ⑧-C 拒绝文案给分类摘要（不是甩一长串原始清单）
 *   ⑧-D 本单席位写过的插件文件照常审计（席位偷改插件 ⇒ fail）
 *   ⑧-E 本单就是来改插件的（插件路径在授权面内）⇒ 照常审计、照常计入改动
 *   ⑧-F 普通项目根（不是 profile）上的同名配置 ⇒ 照常审计
 *   ⑧-G profile 根上的 cordis.patch.yml 是点名禁改的档 ⇒ 不自动排除、照常判越界，文案点明"人工改的就重取基线"
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { callTool, createHarness, disposeHarness, runAnalysisThenPlan } from './selftest-core.mjs'
import { makeWriteLedgerEntry, WRITE_LEDGER_FILE_NAME } from '../lib/hashgate.js'
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
      const L = ['dsh-pipeline · F16：哈希闸门排除插件自身文件（缺陷 ⑧）', '='.repeat(78)]
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

const put = async (root, rel, text) => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), text, 'utf8')
}

/**
 * 单席位、停在「开发中」的任务。`profile:true` ⇒ 项目根摆成 DSH profile 的样子（基线之前就有插件安装树与 profile 配置）。
 * `scope` 默认只授权 `src/all`。
 */
async function fixture(tag, { profile = true, scope = [{ id: 'CS1', path: 'src/all', action: 'modify', why: '夹具：源码目录' }] } = {}) {
  const h = await createHarness({})
  const root = h.projectRoot
  await put(root, 'src/all/a.js', 'export const a = 1\n')
  await put(root, 'cordis.patch.yml', '- insert: []\n')
  await put(root, 'orb-update.json', '{"v":1}\n')
  if (profile) await put(root, 'node_modules/dsh-pipeline/lib/x.js', 'export const x = 1\n')
  const MAIN = `f16-${tag}-main`
  const opened = await callTool(h, 'pipeline_task_open', { requirement: `F16 夹具（${tag}）：改一处导出逻辑。`, deliverable_format: '补丁 + 变更说明' }, MAIN)
  if (opened.denied) throw new Error(`开单失败：\n${opened.text}`)
  const taskId = opened.value.task_id
  const tokens = { main: opened.value.role_token }
  const agents = { main: MAIN }
  // ★ 2026-10-18：分区范围必须覆盖授权面（新的分区覆盖校验 P0-1）——
  //   本夹具按 `scope` 生成分区，而不是写死 `src/all`（否则"授权了却没人能写"）。
  const scopePaths = [...new Set(scope.map((s) => String(s?.path ?? '').trim()).filter((x) => x.length > 0))]
  await runAnalysisThenPlan(h, {
    taskId,
    tokens,
    agents,
    tier: 'L2',
    reason: 'F16 夹具：单席位 + 一份授权面',
    layers: [{ layer: 'all', scope_paths: scopePaths, deliverables: ['全部产物'] }],
    writers: { layers: ['all'], partitions: [{ seat: 'writer#1', layer: 'all', scope_paths: scopePaths, deliverables: ['全部产物'] }], reason: '单席位即可' },
    changeScope: scope,
  })
  const tr = await h.store.transition({ taskId, event: 'dispatch_writer', actorRole: 'main' })
  if (tr.ok !== true) throw new Error(`推进到开发中失败：${tr.error}`)
  return { h, root, taskId }
}

/** 模拟"同步了一次安装副本"：改插件文件、加插件文件、profile 根上多一份备份、宿主改了 orb-update.json。 */
async function simulateSync(root) {
  await put(root, 'node_modules/dsh-pipeline/lib/x.js', 'export const x = 2\n')
  await put(root, 'node_modules/dsh-pipeline/lib/new.js', 'export const y = 1\n')
  await put(root, 'cordis.patch.yml.bak-before-timeout-20261016-183614', '- insert: []\n')
  await put(root, 'orb-update.json', '{"v":2}\n')
}

const submitDev = (f, manifest) =>
  f.h.store.submitHandoff({
    taskId: f.taskId,
    kind: 'dev_to_test',
    actorRole: 'writer',
    actorSeat: 'writer#1',
    actorAgentId: 'f16-writer1',
    payload: { task_id: f.taskId, artifact_version: 'v1', patch_or_code: 'x', change_note: 'x', run_commands: ['node build.mjs'], selftest_result: '构建通过', known_issues: [], change_manifest: manifest },
  })

const lastGate = (f) => [...(f.h.store.peek(f.taskId).history ?? [])].reverse().find((e) => e.action === 'gate:hash') ?? null
const MANIFEST = [{ path: 'src/all/a.js', action: 'modify', scope_id: 'CS1' }]

export async function runF16HashgateSelfTreeCheck() {
  const rec = createRecorder()
  const open = []
  try {
    {
      const G = '⑧-A 只动了插件自身文件 ⇒ 闸门不拦'
      const f = await fixture('a')
      open.push(f.h)
      await put(f.root, 'src/all/a.js', 'export const a = 2\n')
      await simulateSync(f.root)
      const r = await submitDev(f, MANIFEST)
      const g = lastGate(f)
      rec.add(G, '★★ dev_to_test 交得上去（不再 HASH_GATE_FAILED）', r.ok === true, r.ok === true ? '' : `${r.code}\n${String(r.error).split('\n').slice(0, 8).join('\n')}`)
      rec.add(G, '★ 审计里这一次 gate:hash 是 pass', g?.pass === true, JSON.stringify(g?.counts ?? null))
      const audit = await f.h.store.changeAudit({ taskId: f.taskId })
      rec.add(G, '★ 改动审计把它们单列成 self_tree：安装树 2 · 备份残留 1 · profile 配置 1', audit.counts?.self_tree?.install === 2 && audit.counts?.self_tree?.backup === 1 && audit.counts?.self_tree?.config === 1, JSON.stringify(audit.counts))
      rec.add(G, '★ 项目文件那一处照常记在 modified 里', audit.modified.some((x) => x.path === 'src/all/a.js'), audit.modified.map((x) => x.path).join(', '))
    }

    {
      const G = '⑧-B / ⑧-C 项目文件越界照样拒，且给分类摘要'
      const f = await fixture('b')
      open.push(f.h)
      await put(f.root, 'src/all/a.js', 'export const a = 2\n')
      await simulateSync(f.root)
      await put(f.root, 'src/forbidden.js', '// 越界写入\n')
      const r = await submitDev(f, MANIFEST)
      const g = lastGate(f)
      rec.add(G, '★★ 被拒（HASH_GATE_FAILED）', r.ok !== true && r.code === 'HASH_GATE_FAILED', r.code)
      rec.add(G, '★★ violations 里有 src/forbidden.js', (g?.violations ?? []).some((v) => String(v).includes('src/forbidden.js')), JSON.stringify(g?.violations ?? null))
      rec.add(G, '★ violations 里没有任何插件自身文件', !(g?.violations ?? []).some((v) => /node_modules|cordis\.patch\.yml|orb-update|\.bak/.test(String(v))), JSON.stringify(g?.violations ?? null))
      rec.add(G, '★★ 拒绝文案给分类摘要（安装树 · 备份残留 · profile 配置 各几处）', /插件安装树 2/.test(String(r.error)) && /备份残留 1/.test(String(r.error)) && /profile 配置 1/.test(String(r.error)), String(r.error).split('\n').filter((l) => l.includes('插件自身')).join('\n'))
    }

    {
      const G = '⑧-D 席位亲手写过的插件文件照常审计'
      const f = await fixture('d')
      open.push(f.h)
      await put(f.root, 'src/all/a.js', 'export const a = 2\n')
      await simulateSync(f.root)
      const row = makeWriteLedgerEntry({
        at: '2026-10-17T00:00:00Z',
        taskId: f.taskId,
        role: 'writer',
        seat: 'writer#1',
        source: 'guard.write-allowed',
        paths: [{ path: join(f.root, 'node_modules/dsh-pipeline/lib/x.js'), key: pathKey(join(f.root, 'node_modules/dsh-pipeline/lib/x.js')).toLowerCase(), sha256: null }],
      })
      await appendFile(join(f.root, '.pipeline', f.taskId, WRITE_LEDGER_FILE_NAME), `${JSON.stringify(row)}\n`, 'utf8')
      const r = await submitDev(f, MANIFEST)
      const g = lastGate(f)
      rec.add(G, '★★ 本单编写席写过 node_modules/dsh-pipeline/lib/x.js ⇒ 不排除、判越界', r.ok !== true && (g?.violations ?? []).some((v) => String(v).includes('node_modules/dsh-pipeline/lib/x.js')), JSON.stringify(g?.violations ?? null))
    }

    {
      const G = '⑧-E 本单就是来改插件的 ⇒ 照常审计'
      const f = await fixture('e', { scope: [{ id: 'CS1', path: 'src/all', action: 'modify', why: '源码' }, { id: 'CS2', path: 'node_modules/dsh-pipeline/lib', action: 'modify', why: '本单就是改插件' }] })
      open.push(f.h)
      await put(f.root, 'node_modules/dsh-pipeline/lib/x.js', 'export const x = 3\n')
      const audit = await f.h.store.changeAudit({ taskId: f.taskId })
      rec.add(G, '★ 授权面内的插件文件照常出现在 modified 里，不进 self_tree', audit.modified.some((x) => x.path === 'node_modules/dsh-pipeline/lib/x.js') && (audit.counts?.self_tree?.install ?? 0) === 0, JSON.stringify({ modified: audit.modified.map((x) => x.path), counts: audit.counts }))
    }

    {
      const G = '⑧-F 普通项目根上的同名配置照常审计'
      const f = await fixture('f', { profile: false })
      open.push(f.h)
      await put(f.root, 'src/all/a.js', 'export const a = 2\n')
      await put(f.root, 'cordis.patch.yml', '- insert: [x]\n')
      const r = await submitDev(f, MANIFEST)
      const g = lastGate(f)
      rec.add(G, '★★ 项目根不是 profile ⇒ 改 cordis.patch.yml 照样判越界', r.ok !== true && (g?.violations ?? []).some((v) => String(v).includes('cordis.patch.yml')), JSON.stringify(g?.violations ?? null))
    }

    {
      const G = '⑧-G profile 根上的禁改配置不自动排除'
      const f = await fixture('g')
      open.push(f.h)
      await put(f.root, 'src/all/a.js', 'export const a = 2\n')
      await simulateSync(f.root)
      await put(f.root, 'cordis.patch.yml', '- insert: [x]\n')
      const r = await submitDev(f, MANIFEST)
      const g = lastGate(f)
      rec.add(G, '★★ profile 根上的 cordis.patch.yml 被改 ⇒ 照常判越界', r.ok !== true && (g?.violations ?? []).some((v) => String(v).endsWith(':cordis.patch.yml')), JSON.stringify(g?.violations ?? null))
      rec.add(G, '★ 其余插件自身文件照样被排除（违规里只有这一份配置）', (g?.violations ?? []).every((v) => String(v).endsWith(':cordis.patch.yml')), JSON.stringify(g?.violations ?? null))
      rec.add(G, '★ 文案点明这是禁改配置、人工改的就重取基线', /点名禁改/.test(String(r.error)) && /重取基线/.test(String(r.error)), String(r.error).split('\n').filter((l) => l.includes('点名禁改')).join('\n'))
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    for (const h of open) await disposeHarness(h)
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF16HashgateSelfTreeCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
