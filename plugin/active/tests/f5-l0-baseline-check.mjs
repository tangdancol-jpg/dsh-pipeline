/**
 * dsh-pipeline · 缺陷 ⑤：L0 任务没有改动基线 ⇒ 审核的 R6「前后版本对比」无判据可用
 * ============================================================================
 *     node tests/f5-l0-baseline-check.mjs
 *
 * 真机现场（T-20261015-bb30bc，L0 单）：审核席位要按 R6 出 `change_audit`，
 * `pipeline_change_audit` 却报"没有基线"，它只能**手工清点**。
 * 根因：基线只在**计划**那一站记，而 **L0 没有计划站**（规则引擎自批）。
 *
 * 本套钉住五件事：
 *   A. **会记**：L0 自批后（清单写入那一刻）补一次基线，且 `taken_by = rule-engine`；
 *   B. **可判定**：有了基线之后 `changeAudit()` 真的能给出结论（R6 的判据从"无"变"有"）；
 *   C. **幂等且不覆盖**：再调一次**什么都不做**（重取基线是计划 AI / 主对话的动作）；
 *   D. **不拦流程**：store 没有 `takeBaseline`（装配不全）/ 记不上 ⇒ 如实报错但**不抛**；
 *   E. **改造前后对照**：**不补基线**的同一张单，`changeAudit` 仍然报"没有基线"
 *      —— 证明这条红是真的被这条修复消掉的，不是本来就没有。
 *
 * ★ 项目根是自造的临时目录：不读、不写任何活体真单。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createTaskStore } from '../lib/store.js'
import { L0_BASELINE_ACTOR, describeL0Baseline, ensureL0Baseline, needsL0Baseline } from '../lib/store/l0-baseline.js'

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
      const L = ['dsh-pipeline · 缺陷 ⑤：L0 没有改动基线（审核 R6 无判据）', '='.repeat(78)]
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

export async function runF5L0BaselineCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f5-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'fizzbuzz.mjs'), 'export const fizzbuzz = (n) => []\n')

    const store = createTaskStore({ projectRoot: root, artifactDirName: '.pipeline', maxReworkPerLeg: 2 })
    const open = (id) => store.open({ id, requirement: '写 fizzbuzz', actorRole: 'main', actorAgentId: 'main-s' })

    // ------------------------------------------------------------ A 会记
    const G1 = 'A L0 自批之后补一次基线'
    const a = await open('T-F5-A')
    rec.add(G1, '夹具：开单成功', a.ok === true, a.error ?? '')
    rec.add(G1, '★ 判据：没基线 ⇒ 需要补', needsL0Baseline(a.task) === true, '')
    const r1 = await ensureL0Baseline({ store, task: a.task, reason: 'L0 自批（夹具）' })
    rec.add(G1, '★★ `ensureL0Baseline` ⇒ created=true，拿到一份真基线', r1.ok === true && r1.created === true && typeof r1.baseline?.baseline_id === 'string', `${r1.baseline?.baseline_id}（${r1.baseline?.file_count} 个文件）`)
    rec.add(G1, '★ `taken_by` 记的是 `rule-engine`（谁记的，可追溯）', r1.baseline?.taken_by === L0_BASELINE_ACTOR, r1.baseline?.taken_by)
    rec.add(G1, `★ 基线清单里有夹具文件（${'src/fizzbuzz.mjs'}）`, Object.hasOwn(r1.baseline?.files ?? {}, 'src/fizzbuzz.mjs'), Object.keys(r1.baseline?.files ?? {}).slice(0, 5).join('、'))
    rec.add(G1, '★ 摘要如实说"记上了"', describeL0Baseline(r1).includes(r1.baseline.baseline_id), describeL0Baseline(r1).split('\n')[0])

    // ------------------------------------------------------------ B 可判定
    const G2 = 'B 有了基线之后，R6 的判据真的可用了'
    const after = await store.get('T-F5-A')
    rec.add(G2, '★ `task.baseline_current` 指向刚记的那份', after?.baseline_current === r1.baseline.baseline_id, String(after?.baseline_current))
    const before = await store.changeAudit({ taskId: 'T-F5-A' })
    /**
     * ★★ **"没有授权面" ≠ "违反了授权面"**（缺陷 ⑤ 的第二半）。
     *
     * L0 刻意不塞"整棵项目根"的假授权（`change_scope` 是 null）。改前因为没有基线，
     * 这条判据根本跑不到；一旦 L0 也有基线，若照旧把"授权面为空 ⇒ 每条改动都越界"
     * 套上去，**每一张 L0 单**都会被判成"多改"—— 那是个更坏的结果。
     * 所以第三个结论 `no_scope` 必须成立：越界/少改**不适用**，前后差异照给。
     */
    rec.add(G2, '★★ 刚记完 ⇒ 结论 = `no_scope`（**不是** `within_scope` 那种假通过，也不是 `out_of_scope` 那种冤枉）', before.ok === true && before.verdict === 'no_scope', `${before.verdict}　has_scope=${before.has_scope}`)
    rec.add(G2, '★★ `no_scope` 时 `unauthorized` / `missing` **都为空**（没有授权面就没有"越界/少改"可言）', before.unauthorized.length === 0 && before.missing.length === 0, `unauthorized=${before.unauthorized.length} missing=${before.missing.length}`)
    rec.add(G2, '★ 并给出**为什么**（说的话不许被读成"通过"）', String(before.no_scope_reason).includes('不适用') && String(before.no_scope_reason).includes('前后差异'), String(before.no_scope_reason).slice(0, 60))
    writeFileSync(join(root, 'src', 'extra.mjs'), 'export const x = 1\n')
    const after2 = await store.changeAudit({ taskId: 'T-F5-A' })
    rec.add(G2, '★★ 基线之后动的文件**被算进前后对比**（这就是审核 R6 要的那份判据）', after2.ok === true && after2.counts.added >= 1 && after2.added.some((x) => String(x.path).includes('extra.mjs')), `added=${after2.counts?.added}　${JSON.stringify(after2.added?.slice(0, 3))}`)
    rec.add(G2, '★★ 而且**不会**因为"L0 没有授权面"就把这次新增冤枉成越界', after2.verdict === 'no_scope' && after2.unauthorized.length === 0, `${after2.verdict}　unauthorized=${after2.unauthorized.length}`)
    // 对照：**有**授权面的任务照旧走原来那两档（`no_scope` 没有污染 L1+）
    {
      const c = await open('T-F5-C')
      const ct = await store.get('T-F5-C')
      ct.change_scope = [{ id: 'CS1', path: 'src', action: 'modify', why: '夹具：只授权 src/' }]
      await store.takeBaseline({ taskId: 'T-F5-C', by: 'planner', note: '夹具' })
      writeFileSync(join(root, 'outside.mjs'), 'export const y = 1\n')
      const scoped = await store.changeAudit({ taskId: 'T-F5-C' })
      rec.add(G2, '★★ 对照（有授权面）：面外的改动照旧判 `out_of_scope` —— 第三档没有把真判据稀释掉', scoped.ok === true && scoped.verdict === 'out_of_scope' && scoped.unauthorized.length === 1, `${scoped.verdict}　unauthorized=${scoped.unauthorized.length}`)
      void c
    }

    // ------------------------------------------------------------ C 幂等
    const G3 = 'C 幂等且**不覆盖**（重取基线是计划 AI / 主对话的动作，不是机制的）'
    const r2 = await ensureL0Baseline({ store, task: await store.get('T-F5-A'), reason: '再来一次' })
    rec.add(G3, '★ 已经有基线 ⇒ `created=false`，一个字节都不动', r2.ok === true && r2.created === false, r2.skipped ?? '')
    rec.add(G3, '★ 指针**没变**（还是原来那份）', (await store.get('T-F5-A'))?.baseline_current === r1.baseline.baseline_id, '')
    rec.add(G3, '★ 基线条数没涨（没有悄悄堆第二份）', ((await store.get('T-F5-A'))?.baselines ?? []).length === 1, `count=${((await store.get('T-F5-A'))?.baselines ?? []).length}`)
    rec.add(G3, '★ 摘要如实说"已有基线、未覆盖"', describeL0Baseline(r2).includes('已经有基线了') && describeL0Baseline(r2).includes('不覆盖'), describeL0Baseline(r2))

    // ------------------------------------------------------------ D 不拦流程
    const G4 = 'D 记不上**不拦流程**，如实报错不抛'
    const noBl = await ensureL0Baseline({ store: {}, task: { id: 'X' } })
    rec.add(G4, '★ store 没有 `takeBaseline`（装配不全）⇒ 返回 ok=false 且**说清原因**', noBl.ok === false && String(noBl.error).includes('takeBaseline'), noBl.error)
    rec.add(G4, '★ 没有任务对象 ⇒ 同样只报错、不抛', (await ensureL0Baseline({ store, task: null })).ok === false, '')
    rec.add(G4, '★ 摘要把它渲染成"⚠ 没能记录"（不假装成功）', describeL0Baseline(noBl).includes('⚠'), describeL0Baseline(noBl))
    const badStore = { takeBaseline: async () => ({ ok: false, error: '项目根读不到' }) }
    const rBad = await ensureL0Baseline({ store: badStore, task: { id: 'Y' } })
    rec.add(G4, '★ 底层失败 ⇒ 原样把它的原因带上来', rBad.ok === false && rBad.error.includes('项目根读不到'), rBad.error)

    // ------------------------------------------------------------ E 改造前后对照
    const G5 = 'E 对照：**不补基线**的同一张单，R6 仍然报"没有基线"（证明这条红是真被消掉的）'
    const b = await open('T-F5-B')
    rec.add(G5, '夹具：另一张 L0 单，**不调** ensureL0Baseline', b.ok === true && needsL0Baseline(b.task) === true, '')
    const noBase = await store.changeAudit({ taskId: 'T-F5-B' })
    rec.add(G5, '★★ 它的 `changeAudit` 报的就是**没有基线**（= 真机现场那条红）', noBase.ok === false && String(noBase.error).includes('没有基线'), String(noBase.error).split('\n')[0])
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF5L0BaselineCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
