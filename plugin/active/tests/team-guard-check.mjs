/**
 * dsh-pipeline · Agent Teams 深度整合 · WP-G：守门覆盖**官方新工具面**
 * ============================================================================
 *     node tests/team-guard-check.mjs
 *
 * 钉住四件事（判据见 `design/agent-teams/01-目标与边界.md` §D8）：
 *
 *   A. **越权面**：绑定角色（非 main）调 team 协作类 / 委派类 / 插件管理类 /
 *      会话搜索类 ⇒ 守门拒，且拒绝原文点名"绕过三权分立 / 旁路"。
 *   B. **不误伤**：main（Lead）调 team 协作类照旧放行；未绑定角色的会话也照旧放行
 *      （守门只约束流水线参与者）；`write` 的正文里出现 `>` 不被当 shell 命令。
 *   C. **shell 旁路**：持久终端的命令在 `text` 里（`terminal_send`）——
 *      `echo x > src/a.js` 这种必须被当命令拦，纯 `ls` 放行。
 *   D. **工具面**：`applyOfficialDeny(deriveToolFace(...))` 后，席位的 `denied` 含这些
 *      官方工具（席位"看不见"），main 的 `denied` 仍为空。
 *
 * ★ 全程密闭：项目根是自造的临时目录，不读任何活体真单。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  applyOfficialDeny,
  collectCommandStrings,
  guardDecision,
  isShellTextArgTool,
  makeTaskIndexEntry,
  officialCategoryOf,
  officialDenyForRole,
  officialOutsideRole,
} from '../lib/guard.js'
import { deriveToolFace } from '../lib/boundaries.js'
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
      const L = ['dsh-pipeline · Agent Teams · WP-G：守门覆盖官方新工具面', '='.repeat(78)]
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

export async function runTeamGuardCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-teamguard-'))
  try {
    const R = root.replace(/\\/g, '/')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1\n')
    const T = 'T-TEAMGUARD'
    const index = new Map([[
      T,
      makeTaskIndexEntry({ taskId: T, projectRoot: root, pipelineDir: join(root, '.pipeline') }),
    ]])
    const tokens = createTokenStore()
    const bound = (role) => tokens.mint({ taskId: T, role, agentId: `tg-${role}`, note: 'team-guard-check' })
    for (const role of ['main', 'writer', 'tester', 'reviewer', 'planner', 'architect']) bound(role)
    /** 调用一个工具，返回守门判词（`undefined` = 放行）。 */
    const call = (role, name, args = {}) =>
      guardDecision({ name, arguments: args, agent: { id: `tg-${role}` } }, { tokens, taskIndex: index, config: {} })

    // =====================================================================
    // A. 越权面：角色调官方新工具 ⇒ 拒（四类各点名）
    // =====================================================================
    const GA = 'A 越权面（角色调官方新工具一律拒）'
    const denyGroup = (role, tools, must) => {
      for (const name of tools) {
        const r = call(role, name, name.startsWith('team_task') ? { task_id: 'x' } : {})
        rec.add(
          GA,
          `${role} 调 ${name} ⇒ 拒`,
          r !== undefined && String(r).includes('绕过三权分立') && String(r).includes(must),
          first(r),
        )
      }
    }
    // ① 委派类（测试/审核借子代理的手改代码 = 三权分立当场作废）
    denyGroup('tester', ['subagent', 'subagent_fork', 'workflow', 'ralph'], '委派类')
    denyGroup('reviewer', ['subagent_claude_code', 'workflow'], '委派类')
    // ② team 协作类（私下拉人 / 自己开任务板 = 绕过"结构化交接是唯一交付入口"）
    denyGroup('tester', ['spawn_teammate', 'send_message', 'team_task_create', 'team_task_update'], '团队协作类')
    denyGroup('writer', ['wait_agent', 'interrupt_agent', 'team_task_list'], '团队协作类')
    // ③ 插件管理类（直接改运行环境）
    denyGroup('reviewer', ['plugin_manager', 'plugin_market'], '插件管理')
    // ④ 会话搜索类（读别的会话正文 = 旁路读代码）
    denyGroup('tester', ['session_search', 'session_trace', 'session_event_read'], '会话搜索类')
    rec.add(
      GA,
      '★ 拒绝原文带"允许角色"之外的两条关键信息：当前角色 + 该用的通道（pipeline_*）',
      String(call('tester', 'subagent') ?? '').includes('当前角色：tester') &&
        String(call('tester', 'subagent') ?? '').includes('pipeline_clarify_request'),
      first(call('tester', 'subagent')),
    )

    // =====================================================================
    // B. 不误伤：main 放行 / 未绑定放行 / 分类名单本身没有多拦
    // =====================================================================
    const GB = 'B 不误伤（main 是 Lead / 无关会话不管）'
    const mainAllowed = ['spawn_teammate', 'send_message', 'wait_agent', 'list_agents', 'interrupt_agent',
      'team_task_create', 'team_task_list', 'subagent', 'workflow', 'plugin_manager', 'session_search']
    const mainBad = mainAllowed.filter((n) => call('main', n) !== undefined)
    rec.add(
      GB,
      '★★ main（Lead）调 team 协作类 / 委派类**放行**（不因这条收窄主对话）',
      mainBad.length === 0,
      mainBad.length === 0 ? `全部放行：${mainAllowed.join('、')}` : `被误拒：${mainBad.join('、')}`,
    )
    const unbound = guardDecision(
      { name: 'spawn_teammate', arguments: {}, agent: { id: 'tg-nobody' } },
      { tokens, taskIndex: index, config: {} },
    )
    rec.add(
      GB,
      '★★ 未绑定角色的会话**照旧放行**（守门只约束流水线参与者，这是与其它插件共存的前提）',
      unbound === undefined,
      first(unbound),
    )
    rec.add(
      GB,
      '★ 名单口径：main 的拒绝面为空，其它角色 = 四类全集（22 个，排序稳定、无重复）',
      officialDenyForRole('main').length === 0 &&
        officialDenyForRole('tester').length === 22 &&
        new Set(officialDenyForRole('tester')).size === 22 &&
        JSON.stringify(officialDenyForRole('tester')) === JSON.stringify([...officialDenyForRole('tester')].sort()),
      `main=${JSON.stringify(officialDenyForRole('main'))}　tester ${officialDenyForRole('tester').length} 个\n` +
        officialDenyForRole('tester').join('、'),
    )
    rec.add(
      GB,
      '★ 分类归属可查（拒绝文案按类别说原因，不是一句"不允许"）：四类各给一个代表，非官方工具返回 null',
      officialCategoryOf('subagent') === 'delegation' &&
        officialCategoryOf('team_task_create') === 'team_coord' &&
        officialCategoryOf('plugin_manager') === 'escape' &&
        officialCategoryOf('session_search') === 'session_read' &&
        officialCategoryOf('terminal_send') === null &&
        officialCategoryOf('pipeline_status') === null,
      ['subagent', 'team_task_create', 'plugin_manager', 'session_search', 'terminal_send', 'pipeline_status']
        .map((n) => `${n}=${officialCategoryOf(n)}`).join('　'),
    )
    rec.add(
      GB,
      '★ 委派类**不拒 main 以外的人**这句话不成立 —— 用函数口径核对：tester 命中、main 不命中',
      officialOutsideRole('tester', 'subagent') === 'delegation' && officialOutsideRole('main', 'subagent') === null,
      `tester=${officialOutsideRole('tester', 'subagent')}　main=${officialOutsideRole('main', 'subagent')}`,
    )

    // =====================================================================
    // C. shell 旁路：持久终端的命令在 `text` 里
    // =====================================================================
    const GC = 'C shell 旁路（terminal_send 的 text 必须进命令扫描）'
    rec.add(
      GC,
      '★★ tester 用持久终端 `terminal_send{text:"echo x > 项目源码"}` 改代码 ⇒ 被当 shell 命令拦',
      (() => {
        const r = call('tester', 'terminal_send', { sessionId: 'term-1', text: `echo x > ${R}/src/a.js` })
        return r !== undefined && String(r).includes('不得通过 shell 修改项目文件')
      })(),
      first(call('tester', 'terminal_send', { sessionId: 'term-1', text: `echo x > ${R}/src/a.js` })),
    )
    rec.add(
      GC,
      '★★ 同一条对 reviewer 同样成立（相对路径也算）',
      (() => {
        const r = call('reviewer', 'terminal_send', { sessionId: 'term-2', text: 'echo x > out.txt' })
        return r !== undefined && String(r).includes('不得通过 shell 修改项目文件')
      })(),
      first(call('reviewer', 'terminal_send', { sessionId: 'term-2', text: 'echo x > out.txt' })),
    )
    rec.add(
      GC,
      '★ 对照：`terminal_send{text:"ls"}` 只读 ⇒ 放行（拦的是写，不是终端本身）',
      call('tester', 'terminal_send', { sessionId: 'term-1', text: 'ls' }) === undefined,
      first(call('tester', 'terminal_send', { sessionId: 'term-1', text: 'ls' })),
    )
    rec.add(
      GC,
      '★★ 不误伤：`write` 的**正文**里出现 `>`（Markdown 引用）不被当 shell 命令（它压根不是 shell 类工具）',
      call('tester', 'write', {
        path: `${R}/.pipeline/${T}/reports/tester/tester.log`,
        text: '结论\n\n> 引用一段需求原文\n\n=> 不是重定向',
      }) === undefined,
      first(call('tester', 'write', {
        path: `${R}/.pipeline/${T}/reports/tester/tester.log`,
        text: '> 引用',
      })),
    )
    rec.add(
      GC,
      '★ 名单口径：`SHELL_TEXT_ARG_TOOLS` 只覆盖持久终端三件套，`write`/`pwsh` 不在里面',
      isShellTextArgTool('terminal_send') === true &&
        isShellTextArgTool('terminal_write') === true &&
        isShellTextArgTool('terminal_input') === true &&
        isShellTextArgTool('write') === false &&
        isShellTextArgTool('pwsh') === false,
      ['terminal_send', 'terminal_write', 'terminal_input', 'write', 'pwsh']
        .map((n) => `${n}=${isShellTextArgTool(n)}`).join('　'),
    )
    rec.add(
      GC,
      '★ `collectCommandStrings(args,{toolName})`：持久终端的 `text` 被收进命令串（按工具名补扫）',
      collectCommandStrings({ sessionId: 't1', text: 'echo x > src/a.js' }, { toolName: 'terminal_send' })
        .includes('echo x > src/a.js'),
      JSON.stringify(collectCommandStrings({ sessionId: 't1', text: 'echo x > src/a.js' }, { toolName: 'terminal_send' })),
    )

    // =====================================================================
    // D. 工具面：席位"看不见"这些工具（不只是调用时被拒）
    // =====================================================================
    const GD = 'D 工具面（deriveToolFace + applyOfficialDeny）'
    {
      // 判词探针给"全都放行"：把流水线工具本身的影响降到 0，这样 denied 里剩下的
      // 只可能来自官方名单 —— 断言才锐利。
      const face = applyOfficialDeny(deriveToolFace({
        toolNames: ['pipeline_status', 'pipeline_dispatch'],
        judge: () => undefined,
      }))
      const w = face.by_role.writer
      const m = face.by_role.main
      const want = officialDenyForRole('writer')
      rec.add(
        GD,
        '★★ 席位的 `denied` 含全部官方新工具（22 个；`index.js` 的 restrict({deny}) 读的就是它）',
        want.every((t) => w.denied.includes(t)) && w.denied.length === want.length,
        `writer.denied ${w.denied.length} 个：${w.denied.join('、')}`,
      )
      rec.add(
        GD,
        '★★ main 的 `denied` 仍为空（主对话看全量 —— 它是用户的对话框）',
        m.denied.length === 0,
        `main.denied=${JSON.stringify(m.denied)}　official_denied=${JSON.stringify(face.official_denied?.main ?? [])}`,
      )
      rec.add(
        GD,
        '★ 合并**不动**流水线工具那两栏：`visible` / `hidden` 仍是守门判词推导的结果',
        w.visible.includes('pipeline_status') && w.visible.includes('pipeline_dispatch') && w.hidden.length === 0,
        `visible=${JSON.stringify(w.visible)}　hidden=${JSON.stringify(w.hidden)}`,
      )
      rec.add(
        GD,
        '★ 合并留下可追溯证据：`by_role[x].official_denied` 与 `face.official_denied` 都有账',
        Array.isArray(w.official_denied) && w.official_denied.length === want.length &&
          Array.isArray(face.official_denied?.writer),
        `writer.official_denied ${w.official_denied?.length} 个`,
      )
      rec.add(
        GD,
        '★ `applyOfficialDeny` 不抛也不改形状：没有 `by_role` 的输入原样返回（判据认不出就少做，不炸）',
        applyOfficialDeny(null) === null && applyOfficialDeny({}) !== null,
        `null⇒${applyOfficialDeny(null)}　{}⇒${JSON.stringify(applyOfficialDeny({}))}`,
      )
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 8).join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runTeamGuardCheck().then((r) => {
    console.log(r.text)
    if (r.passed !== r.total) process.exitCode = 1
  })
}
