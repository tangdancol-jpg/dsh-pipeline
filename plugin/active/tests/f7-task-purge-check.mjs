/**
 * dsh-pipeline · 缺陷 ⑦：没有任何"删除任务"的工具
 * ============================================================================
 *     node tests/f7-task-purge-check.mjs
 *
 * 真机现场（T-20261015-bb30bc）：用户要清掉跑完的旧单，而插件**没有任何删除任务的
 * 入口**（唯一官方出口 `cancel` 只改状态、文件全留着）；主对话想用 shell 手工删，
 * 又被守门「角色「main」不得通过 shell 修改项目文件」挡住 ⇒ 只能**去资源管理器里手删**。
 *
 * 本套钉住六件事：
 *   A. **只认终态单**（在跑的单一个字节都不许动 —— 那是数据损坏，不是"少一层保护"）；
 *   B. **默认进回收站**（可恢复）；永久删要 `mode:"delete"` **且** `confirm:true`；
 *   C. **先留痕后动手**：墓碑行落 `.pipeline/_purge-log.jsonl`（**在被删目录之外**），
 *      永久删之后仍然查得到"谁、什么时候、什么理由、删了哪张单"；
 *   D. **删不动就如实报错**，绝不"删一半当成功"；
 *   E. **路径穿越挡得住**（`../` 之类的任务 id 直接拒）；
 *   F. **工具层**：`defineTool` 定义真的产出、只有主对话能调、README 里那条 shell 判据**没被动过**。
 *
 * ★ 项目根是自造的临时目录：不读、不写任何活体真单。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createTaskStore } from '../lib/store.js'
import { PURGE_LOG_NAME, TRASH_DIR_NAME, isSafeTaskDirName, isTerminalState, measureDir } from '../lib/store/purge.js'
import { buildPurgeTools } from '../lib/tools/purge.js'
import { PIPELINE_TOOL_ROLES } from '../lib/guard/rules.js'
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
      const L = ['dsh-pipeline · 缺陷 ⑦：没有"删除任务"的工具（收尾清理通道）', '='.repeat(78)]
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

const first = (s) => String(s ?? '').split('\n')[0]

export async function runF7TaskPurgeCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f7-'))
  try {
    const store = createTaskStore({ projectRoot: root, artifactDirName: '.pipeline', maxReworkPerLeg: 2 })
    const pipelineDir = join(root, '.pipeline')
    const open = (id, requirement = 'fixture') => store.open({ id, requirement, actorRole: 'main', actorAgentId: 'main-s' })

    // ------------------------------------------------------------ A 只认终态
    const G1 = 'A 硬约束：只认终态单（在跑的单一个字节都不许动）'
    const a = await open('T-F7-RUN')
    rec.add(G1, '夹具：开出一张**非终态**单（pending）', a.ok === true && a.task.state === 'pending', a.task?.state ?? a.error)
    const refused = await store.purgeTask({ taskId: 'T-F7-RUN', mode: 'delete', by: 'main' })
    rec.add(G1, '★★ 非终态 ⇒ **拒绝**，且不会把它删掉', refused.ok === false && refused.code === 'NOT_TERMINAL' && existsSync(join(pipelineDir, 'T-F7-RUN')), first(refused.error))
    rec.add(G1, '★ 拒绝文案指出"非终态单里可能有席位正在写 ⇒ 那是数据损坏"', String(refused.error).includes('数据损坏'), '')
    rec.add(G1, '★ 拒绝文案给出可行下一步（cancel / close）', String(refused.error).includes('cancel') && String(refused.error).includes('close'), '')
    rec.add(G1, '`isTerminalState` 与状态机同一份名单（closed / cancelled 是终态，developing 不是）', isTerminalState('closed') && isTerminalState('cancelled') && !isTerminalState('developing') && !isTerminalState('pending'), '')

    // ------------------------------------------------------------ B 归档
    const G2 = 'B 默认进回收站（可恢复）'
    await open('T-F7-TRASH')
    writeFileSync(join(pipelineDir, 'T-F7-TRASH', 'artifacts-note.txt'), 'x'.repeat(64))
    await store.transition({ taskId: 'T-F7-TRASH', event: 'cancel', actorRole: 'human', actorAgentId: 'human-s' })
    const t = await store.get('T-F7-TRASH')
    rec.add(G2, '夹具：这张单已到终态（cancelled）', isTerminalState(t.state), t.state)
    const trashed = await store.purgeTask({ taskId: 'T-F7-TRASH', mode: 'trash', by: 'main', reason: '夹具：归档' })
    rec.add(G2, '★★ 归档成功，并报出目标位置与体量', trashed.ok === true && typeof trashed.moved_to === 'string' && trashed.files > 0, `${trashed.moved_to}　${trashed.files} 文件 / ${trashed.bytes} B`)
    rec.add(G2, '★ 原位置**没了**', !existsSync(join(pipelineDir, 'T-F7-TRASH')), '')
    rec.add(G2, '★★ 归档目录里**内容完好**（可恢复：把这一份移回去就还原）', existsSync(join(trashed.moved_to, 'task.json')) && readFileSync(join(trashed.moved_to, 'artifacts-note.txt'), 'utf8').length === 64, '')
    rec.add(G2, '★ 归档落在 `<项目根>/.pipeline/_trash/` 下（与被删目录**平级**，不会跟着被删）', trashed.moved_to.replace(/\\/g, '/').includes(`/.pipeline/${TRASH_DIR_NAME}/`), '')
    rec.add(G2, '★ 缓存也摘掉了（后续读盘不会拿到一份已经不存在的任务）', (await store.get('T-F7-TRASH')) === null, '')

    // ------------------------------------------------------------ C 墓碑账本
    const G3 = 'C 先留痕后动手：墓碑账本在**被删目录之外**，删完仍可追溯'
    const logFile = join(root, '.pipeline', PURGE_LOG_NAME)
    rec.add(G3, '★ 账本文件已生成（就在 `.pipeline/` 下，不在被删目录里）', existsSync(logFile), logFile.replace(/\\/g, '/'))
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    rec.add(G3, '★ 墓碑行带齐"谁 / 什么时候 / 什么理由 / 哪张单 / 多大"', lines.some((l) => l.task_id === 'T-F7-TRASH' && l.by === 'main' && l.reason === '夹具：归档' && l.mode === 'trash' && typeof l.bytes === 'number' && typeof l.at === 'string'), JSON.stringify(lines.at(-1)))
    rec.add(G3, '★ `store.purgeLogPath` 把它导出（状态查询 / 报告指得过去）', store.purgeLogPath === logFile, store.purgeLogPath)

    // ------------------------------------------------------------ D 永久删除
    const G4 = 'D 永久删除：要显式确认；删完墓碑仍在；删不动如实报错'
    const before = lines.length
    const del = await store.purgeTask({ taskId: 'T-F7-RUN', mode: 'delete', by: 'main', reason: '不该成功' })
    rec.add(G4, '★ 非终态单即便指名 delete 也仍然拒（冻结判据不变）', del.ok === false && del.code === 'NOT_TERMINAL', first(del.error))
    rec.add(G4, '★★ 被拒时**不写墓碑**（没动手就不留一笔假账）', readFileSync(logFile, 'utf8').trim().split('\n').length === before, '')

    await open('T-F7-DEL')
    await store.transition({ taskId: 'T-F7-DEL', event: 'cancel', actorRole: 'human', actorAgentId: 'human-s' })
    rec.add(G4, '★ store 层 `delete` 成功（工具层还要 `confirm`，见 F）', (await store.purgeTask({ taskId: 'T-F7-DEL', mode: 'delete', by: 'main', reason: '夹具：永久删' })).ok === true, '')
    rec.add(G4, '★★ 永久删之后，墓碑行**仍然查得到**（这就是"先留痕后动手"的意义）', readFileSync(logFile, 'utf8').includes('T-F7-DEL'), '')
    rec.add(G4, '★ 目录真的没了', !existsSync(join(pipelineDir, 'T-F7-DEL')), '')

    // ------------------------------------------------------------ E 路径穿越
    const G5 = 'E 路径穿越挡得住'
    rec.add(G5, '★ `..` / 含分隔符 / 含盘符的任务 id 一律判非法', !isSafeTaskDirName('..') && !isSafeTaskDirName('../x') && !isSafeTaskDirName('a/b') && !isSafeTaskDirName('C:x') && isSafeTaskDirName('T-20261015-abc123'), '')
    const trav = await store.purgeTask({ taskId: '../evil', mode: 'delete', by: 'main' })
    rec.add(G5, '★★ 拿 `../evil` 调 ⇒ 拒（BAD_TASK_ID），不会碰到 `.pipeline` 之外的任何东西', trav.ok === false && trav.code === 'BAD_TASK_ID', first(trav.error))
    rec.add(G5, '`measureDir` 统计的是文件数与字节数（删之前先算）', measureDir(join(pipelineDir, TRASH_DIR_NAME)).files >= 1, JSON.stringify(measureDir(join(pipelineDir, TRASH_DIR_NAME))))

    // ------------------------------------------------------------ F 工具层
    const G6 = 'F 工具层：真定义 + 只有主对话能调'
    let clock = 1000
    const tokens = createTokenStore({ now: () => clock })
    tokens.mint({ taskId: 'T-F7-T1', role: 'main', agentId: 'main-session' })
    tokens.mint({ taskId: 'T-F7-T1', role: 'writer', agentId: 'writer-session' })
    const deps = { tokens, config: { requireAgentBinding: false }, defineTool: (def) => def, sw: null }
    const { taskPurge } = buildPurgeTools({ deps, store, load: async (id) => store.get(id) })
    rec.add(G6, '★★ 工具定义真的产出了（`defineTool` 被调用、有 name / parameters / output）', taskPurge?.name === 'pipeline_task_purge' && taskPurge.parameters !== undefined && taskPurge.output !== undefined, taskPurge?.name ?? '(无)')
    rec.add(G6, '★ 守门白名单里它是 **main 独占**（与关单同档）', Array.isArray(PIPELINE_TOOL_ROLES.pipeline_task_purge) && PIPELINE_TOOL_ROLES.pipeline_task_purge.length === 1 && PIPELINE_TOOL_ROLES.pipeline_task_purge[0] === 'main', JSON.stringify(PIPELINE_TOOL_ROLES.pipeline_task_purge))

    await open('T-F7-T1')
    await store.transition({ taskId: 'T-F7-T1', event: 'cancel', actorRole: 'human', actorAgentId: 'human-s' })
    const asWriter = await taskPurge.execute({ task_id: 'T-F7-T1', mode: 'delete', confirm: true }, { agent: { id: 'writer-session' } })
    rec.add(G6, '★★ 非主对话调 ⇒ **拒**（不可逆的数据动作责任落在主对话）', asWriter.ok === false && String(asWriter.summary).includes('主对话'), first(asWriter.summary))
    rec.add(G6, '★ 被拒时那张单**还在**（拒得干净）', existsSync(join(pipelineDir, 'T-F7-T1')), '')

    const noConfirm = await taskPurge.execute({ task_id: 'T-F7-T1', mode: 'delete' }, { agent: { id: 'main-session' } })
    rec.add(G6, '★★ `mode:"delete"` 不带 `confirm: true` ⇒ **拒**（永久删除要连写两个字段才算数）', noConfirm.ok === false && String(noConfirm.summary).includes('confirm'), first(noConfirm.summary))
    rec.add(G6, '★ 被拒时那张单还在，且墓碑没多一行', existsSync(join(pipelineDir, 'T-F7-T1')) && !readFileSync(logFile, 'utf8').includes('T-F7-T1'), '')

    const viaTool = await taskPurge.execute({ task_id: 'T-F7-T1', reason: '夹具：走工具归档' }, { agent: { id: 'main-session' } })
    rec.add(G6, '★★ 主对话 + 默认 mode ⇒ 归档成功，输出四件套齐全（ok/mode/moved_to/files/bytes）', viaTool.ok === true && viaTool.mode === 'trash' && String(viaTool.moved_to).length > 0 && typeof viaTool.files === 'number' && typeof viaTool.bytes === 'number', `${viaTool.mode} → ${viaTool.moved_to}（${viaTool.files} 文件）`)
    rec.add(G6, '★ 摘要写明"可恢复"与"墓碑账本在哪"', String(viaTool.summary).includes('可恢复') && String(viaTool.summary).includes(PURGE_LOG_NAME), String(viaTool.summary).split('\n').slice(0, 3).join(' / '))

    // ------------------------------------------------------------ G shell 判据没动
    const G7 = 'G 这条通道**不碰** shell 判据（不是给主对话开 shell 后门）'
    const guardSrc = readFileSync(join(process.cwd(), 'lib', 'guard', 'shell.js'), 'utf8')
    rec.add(G7, '★ 「main 不得通过 shell 修改项目文件」那条文案仍在（一个字没动）', guardSrc.includes('不得通过 shell 修改项目文件'), '')
    rec.add(G7, '★ 收尾清理走的是 store 的具名方法，不是 shell 字符串匹配', typeof store.purgeTask === 'function' && !JSON.stringify(Object.keys(PIPELINE_TOOL_ROLES)).includes('shell'), '')
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF7TaskPurgeCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
