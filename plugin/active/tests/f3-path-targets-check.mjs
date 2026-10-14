/**
 * dsh-pipeline · 缺陷 ③：write 工具的"目标"判定
 * ============================================================================
 *     node tests/f3-path-targets-check.mjs
 *
 * 真机现场（T-20261015-bb30bc，审核席位写自己的报告）：
 *   · `reports/reviewer/reviewer-report.log` **被拒**，而同一目录、同一后缀的
 *     `reviewer-verify.log` 两次都**通过** —— 间歇发生；
 *   · 拒绝文案里那行「目标：…」打的是**工作区目录 + 正文首行**拼出来的假路径，
 *     跟调用方给的 `file_path` 无关；而同一段文案还自称"这条按**路径**判"。
 *   根因：`collectPaths` 把**正文**也当候选路径，正文里一个斜杠就拼出怪路径。
 *
 * 本套钉住四件事：
 *   A. **现场形状**：带多行正文（含斜杠）的合法写入 ⇒ 放行；同目录同后缀两个文件名**不再一个过一个拒**；
 *   B. 假路径**不再出现在目标清单里**（真目标一个都没少）；
 *   C. **没有放宽**：真正写到分区外 / 项目源码 ⇒ 照旧拒，且拒绝文案点名**真实**目标与**来源参数**；
 *   D. 补充扫描的伏笔（正文里藏路径）仍然扫得到 —— 不许把"多扫"变成"漏扫"。
 *
 * ★ 全程密闭：项目根是自造的临时目录，不读任何活体真单。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { guardDecision, makeTaskIndexEntry } from '../lib/guard.js'
import { collectPaths, collectTargets, targetLine } from '../lib/guard/targets.js'
import { createTokenStore } from '../lib/tokens.js'

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
      const L = ['dsh-pipeline · 缺陷 ③：write 工具的"目标"判定（假路径误拒）', '='.repeat(78)]
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

/** 现场形状的正文：多行、含斜杠、含反引号与路径字样（就是当初拼出假路径的那一份）。 */
const REPORT_BODY = [
  '# 审核报告',
  '',
  '被审制品：.pipeline/T-X/artifacts/v1/fizzbuzz.mjs',
  '判据落点：lib/guard/decide.js:260 与 tests/review-check.mjs',
  '结论：OK',
].join('\n')

export async function runF3PathTargetsCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f3-'))
  try {
    const R = root.replace(/\\/g, '/')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, '.pipeline', 'T-F3', 'reports', 'reviewer'), { recursive: true })

    // ------------------------------------------------------------ A 现场形状
    const G1 = 'A 现场形状：带多行正文的**合法**写入不再被误拒'
    const cwd = R
    const legal = join(root, '.pipeline', 'T-F3', 'reports', 'reviewer', 'reviewer-report.log')
    const legal2 = join(root, '.pipeline', 'T-F3', 'reports', 'reviewer', 'reviewer-verify.log')

    const t1 = collectTargets({ file_path: legal, content: REPORT_BODY }, cwd)
    rec.add(G1, '★★ `collectTargets({file_path, content})` 只回**一个**目标（改前会多出"工作区+正文首行"的怪路径）', t1.length === 1, t1.map((x) => `${x.path}  ← ${x.from}${x.explicit ? '(显式)' : '(扫描)'}`).join('\n'))
    rec.add(G1, '★ 那一个就是显式给的 `file_path`', t1[0]?.path === legal.replace(/\\/g, '/').toLowerCase() || t1[0]?.path === legal.replace(/\\/g, '/'), `${t1[0]?.path}`)
    rec.add(G1, '★ 正文里**藏着的路径字样**没有被误当成目标（`content` 是正文类键）', !t1.some((x) => x.path.includes('审核报告')), '')
    rec.add(G1, '★ 间歇性消失：同目录同后缀的两个文件名，目标清单**都恰好一个**（改前会因正文内容多出一个假目标）', collectPaths({ file_path: legal, content: REPORT_BODY }, cwd).length === 1 && collectPaths({ file_path: legal2, content: REPORT_BODY }, cwd).length === 1, `${collectPaths({ file_path: legal, content: REPORT_BODY }, cwd).length} / ${collectPaths({ file_path: legal2, content: REPORT_BODY }, cwd).length}`)
    rec.add(G1, '★ 假目标（`<工作区>/审核报告/…`）在任何一次调用里都不出现', ![...collectPaths({ file_path: legal, content: REPORT_BODY }, cwd), ...collectPaths({ file_path: legal2, content: REPORT_BODY }, cwd)].some((p) => p.includes('# 审核报告') || p.includes('被审制品')), '')

    // ------------------------------------------------------------ D 伏笔扫描
    const G4 = 'D 补充扫描的伏笔仍然扫得到（"多扫"不许变成"漏扫"）'
    const sneaky = collectPaths({ file_path: legal, extra_target: join(root, 'src', 'a.js') }, cwd)
    rec.add(G4, '★ 非正文类的**单行**字符串参数里的路径照样被收进来', sneaky.some((p) => p.endsWith('/src/a.js')), sneaky.join('\n'))
    const inner = collectPaths({ file_path: legal, paths: [join(root, 'src', 'b.js')] }, cwd)
    rec.add(G4, '★ 数组里的路径（`apply_patch` / `multi_edit` 的形状）照样被收进来', inner.some((p) => p.endsWith('/src/b.js')), inner.join('\n'))
    rec.add(G4, '★ 反例：多行字符串**永远不是**路径（路径不跨行）', !collectPaths({ file_path: legal, blob: `x\ny/${'z'.repeat(3)}` }, cwd).some((p) => p.includes('\n')), '')
    rec.add(G4, '★ 反例：超长单行（>512 字符）不参与路径判定', !collectPaths({ file_path: legal, big: `a/${'q'.repeat(600)}` }, cwd).some((p) => p.includes('q'.repeat(600))), '')
    rec.add(G4, '★ 畸形 `file_path`（含换行）只取**首行** —— 不许借换行躲开判定', collectTargets({ file_path: `${join(root, 'src', 'a.js')}\nx.js` }, cwd)[0]?.path.endsWith('/src/a.js') === true, '')

    // ------------------------------------------------------------ B/C 端到端
    const G2 = 'B/C 端到端（真令牌表 + 真守门）：合法写入放行、越界写入照拒且文案可核'
    let clock = 1000
    const tokens = createTokenStore({ now: () => clock })
    tokens.mint({ taskId: 'T-F3', role: 'reviewer', agentId: 'reviewer-session' })
    const index = new Map([
      ['T-F3', makeTaskIndexEntry({ taskId: 'T-F3', projectRoot: root, pipelineDir: join(root, '.pipeline') })],
    ])
    const decide = (args, name = 'write') =>
      guardDecision({ name, arguments: args, agent: { id: 'reviewer-session' } }, { tokens, taskIndex: index, config: {} })

    const rOk = decide({ file_path: legal, content: REPORT_BODY })
    rec.add(G2, '★★ 现场形状：审核席位写 `reviewer-report.log`（多行正文含斜杠）⇒ **放行**', rOk === undefined, first(rOk))
    const rOk2 = decide({ file_path: legal2, content: REPORT_BODY })
    rec.add(G2, '★ 同目录同后缀的另一个名字同样放行 —— 不再"一个过一个拒"', rOk2 === undefined, first(rOk2))

    const rOut = decide({ file_path: join(root, '.pipeline', 'T-F3', 'reports', 'reviewer', 'notes.log'), content: REPORT_BODY })
    rec.add(G2, '★ 反例：名字不以角色名开头的日志 ⇒ 照旧拒', typeof rOut === 'string' && rOut.includes('只能写'), first(rOut))
    rec.add(G2, '★★ 拒绝文案点的是**真实目标**（调用方给的 file_path），不是正文拼出来的假路径', typeof rOut === 'string' && rOut.includes('notes.log') && !rOut.includes('审核报告'), String(rOut).split('\n')[2] ?? '')
    rec.add(G2, '★ 拒绝文案**点名来源参数**（`来自参数 file_path`）—— 文案与判据对得上', typeof rOut === 'string' && rOut.includes('来自参数 `file_path`'), String(rOut).split('\n')[2] ?? '')

    const rSrc = decide({ file_path: join(root, 'src', 'a.js'), content: 'export const a = 1\n' })
    rec.add(G2, '★ 反例：审核席位改项目源码 ⇒ 照旧拒（由 own-log 那条先拦；三权分立一个字没动）', typeof rSrc === 'string' && (rSrc.includes('只能写') || rSrc.includes('不得修改项目源码制品')), first(rSrc))
    rec.add(G2, '★ 该拒绝文案同样点名真实目标与来源', typeof rSrc === 'string' && rSrc.includes('src/a.js') && rSrc.includes('来自参数 `file_path`'), String(rSrc).split('\n')[2] ?? '')

    // 反例：正文里的路径**不得**被拿去当"你在写它"（否则又会绕回来）
    const rBody = decide({ file_path: legal, content: `见 ${root}/src/a.js 这一行\n第二行` })
    rec.add(G2, '★★ 反例：正文里出现的项目源码路径**不构成越界**（那只是文字，不是目标）', rBody === undefined, first(rBody))

    // ------------------------------------------------------------ 文案渲染器
    const G3 = 'A′ 文案渲染器'
    rec.add(G3, '`targetLine({path, from})` 带上来源', targetLine({ path: '/x/a.log', from: 'file_path' }) === '目标：/x/a.log（来自参数 `file_path`）', targetLine({ path: '/x/a.log', from: 'file_path' }))
    rec.add(G3, '`targetLine(字符串)` 兼容旧调法（不带来源）', targetLine('/x/a.log') === '目标：/x/a.log', targetLine('/x/a.log'))
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF3PathTargetsCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
