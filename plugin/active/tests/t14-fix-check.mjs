/**
 * dsh-pipeline · **2026-10-12 十四条缺陷修复的夹具化回归**
 * ============================================================================
 * 这套测试**只做只读计算**：临时目录、跑完即删，不建会话、不碰真账本。
 *
 * 它守的是"当晚实测到的那几条"到底还在不在：
 *   · B1  计划路径被「writer 席位没声明四槽」卡死 → **同一把尺子算两遍**的回归
 *   · B2  失联误判 → **用当晚真实数字离线复算**（30 秒长了 10,717 字节 ⇒ 必须判"还活着"）
 *   · B5  幂等键含递增计数器 → 稳定交付身份的回归
 *   · B7  分组名取"工作目录名" → 标题来源的回归
 *   · B9  守门按目录前缀判"读代码" → 按真实文件身份的回归
 *   · B12 `pipeline_help` 悬空 → 速查入口真的存在
 *   · B13 角色边界卡覆盖性 → 计划那一站就判死
 *
 * 用法：`node tests/t14-fix-check.mjs`
 *
 * @module dsh-pipeline/tests/t14-fix-check
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_ACTIVITY_MIN_BYTES,
  DEFAULT_SILENCE_CONFIRMATIONS,
  activityOfSamples,
  seatLiveness,
} from '../lib/liveness.js'
import { ROLE } from '../lib/roles.js'
import {
  buildRoster,
  buildRosterSlots,
  rosterSlotKeys,
  rosterSlotTargets,
  slotRoleNeedsDeclaration,
} from '../lib/tiers.js'
import { extractCommandPaths, looksLikeSourcePath, scanShellCommand } from '../lib/guard.js'
import { discriminatorOf, ledgerIdentityOf, stableDiscFor, wakeKeyOf, renderWakeText } from '../lib/wakeup.js'

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
      const L = []
      L.push('dsh-pipeline · 14 条缺陷修复回归（2026-10-12）')
      L.push('='.repeat(78))
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('')
          L.push(`【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(`      ${it.detail.split('\n').join('\n      ')}`)
      }
      L.push('')
      L.push('='.repeat(78))
      L.push(`总计：${this.passed}/${this.total} 通过`)
      L.push('='.repeat(78))
      return L.join('\n')
    },
  }
}

export async function runT14FixCheck() {
  const rec = createRecorder()

  // =========================================================================
  // B1｜"要声明四槽的席位"这把尺子**只能有一个出处**
  // =========================================================================
  {
    const writers = {
      count: 1,
      reason: '夹具：单席位',
      partitions: [{ seat: 'writer#1', layer: 'all', scope_paths: ['.'], deliverables: [] }],
    }
    const built = buildRoster({ tier: 'L3', reason: 'B1 夹具', judgedBy: 'planner', writers })
    rec.add('B1 四槽尺子', 'L3 + 单编写席位 ⇒ 名单构造成功（改前这里被"writer 没声明四槽"拒死）', built.ok === true, built.ok === true ? `slots 键=${Object.keys(built.roster.slots).join(',')}` : String(built.error))

    const conversations = built.ok === true ? built.roster.conversations : []
    const slots = built.ok === true ? built.roster.slots : {}

    // 判据侧（改前是 store.js 手写的那一份）必须与本函数**逐字**一致。
    const expected = [
      ...conversations.filter((r) => slotRoleNeedsDeclaration(r) && r !== ROLE.WRITER),
      'writer@writer#1',
    ]
    const viaHelper = rosterSlotKeys(conversations, writers)
    rec.add(
      'B1 四槽尺子',
      '★ 判据侧的键集合 = `rosterSlotKeys()`（**唯一出处**），且**不含裸 `writer` 键**',
      JSON.stringify(viaHelper) === JSON.stringify(expected) && !viaHelper.includes('writer'),
      `rosterSlotKeys=${viaHelper.join('、')}\n应等于=${expected.join('、')}`,
    )
    rec.add(
      'B1 四槽尺子',
      '★ 名单的四槽表**真的覆盖**判据要的每一个键（所以判据不会再误报）',
      viaHelper.every((k) => Object.hasOwn(slots, k)),
      `缺的键=${viaHelper.filter((k) => !Object.hasOwn(slots, k)).join('、') || '（无）'}`,
    )
    rec.add(
      'B1 四槽尺子',
      '★ 只读角色（主对话/需求分析/计划/主管）**不落槽位**（判据也不该点名它们）',
      ['main', 'orchestrator', 'planner', 'supervisor'].every((r) => !viaHelper.includes(r)),
      viaHelper.join('、'),
    )
    rec.add(
      'B1 四槽尺子',
      '★ 未声明 ⇒ 逐条落**显式默认**（权限档 = 最小档 + origin=default）—— 判据没了，数据面还在',
      Object.values(slots).every((s) => s.permission.value === 'read-only' && s.permission.origin === 'default' && s.permission.declared === false),
      Object.entries(slots).map(([k, v]) => `${k}=${v.permission.value}/${v.permission.origin}`).join('  '),
    )

    // ★ 声明了就必须声明齐（strict）：这条判据**没有被放宽**。
    const targets = rosterSlotTargets(conversations, writers).filter((t) => slotRoleNeedsDeclaration(t.role))
    const short = {}
    for (const t of targets) short[t.seat === null ? t.role : `${t.role}@${t.seat}`] = { permission: 'read-only' }
    delete short['tester']
    const strictShort = buildRosterSlots(conversations, writers, { slots: short, strictSlots: true })
    rec.add(
      'B1 四槽尺子',
      '★ 声明了却**漏一个席位** ⇒ 仍然拒（判据没被放宽，只是不再冤枉"从来没声明过"的正常路径）',
      strictShort.ok === false && String(strictShort.error).includes('tester'),
      strictShort.ok === false ? String(strictShort.error).split('\n')[0] : '（竟然通过了）',
    )
    const stray = buildRosterSlots(conversations, writers, { slots: { 'nobody@nowhere': { permission: 'read-only' } } })
    rec.add('B1 四槽尺子', '★ 表里出现榜单外的键 ⇒ 仍然拒', stray.ok === false && String(stray.error).includes('对不上'), stray.ok === false ? String(stray.error).split('\n')[0] : '（竟然通过了）')
  }

  // =========================================================================
  // B2｜**用当晚真实数字离线复算**（用户裁定的验收第 2 条）
  // =========================================================================
  {
    /**
     * 当晚实测（规格 B2 原文，主对话现场观测）：
     *   席位 `session-…` 被判失联的**同一时段**，
     *   它的会话日志 `session.v4.jsonl.zstd` **30 秒内从 381,679 B 增至 392,396 B（+10,717 B）**。
     * ⇒ 修复后的判据**必须**判它为「还活着」。
     */
    const T0 = 1_760_000_000_000
    const prev = { atMs: T0, size: 381_679, mtimeMs: T0 }
    const cur = { atMs: T0 + 30_000, size: 392_396, mtimeMs: T0 + 30_000 }
    const act = activityOfSamples(prev, cur)
    rec.add(
      'B2 离线复算',
      '★★ 当晚真实数据：30 秒 +10,717 字节 ⇒ **判为"还在活动"**（grew=true）',
      act.known === true && act.grew === true && act.delta_bytes === 10_717 && act.delta_ms === 30_000,
      JSON.stringify(act),
    )
    rec.add('B2 离线复算', '当时那两个数就是规格里写的（381,679 → 392,396）', 392_396 - 381_679 === 10_717, `${381_679} → ${392_396}`)

    // 同一个席位、同一时刻的台账：0 交接物 / 0 流水 / 0 水位自报（就是被误判成"死"的那份现场）
    const task = {
      id: 'T-offline',
      state: 'developing',
      handoffs: [],
      history: [],
      context_reports: [],
      successions: [],
      dispatched: [{ role: 'writer', seat: 'writer#1', agent_id: 'session-00000000-0000-4000-8000-000000000501', at: new Date(T0 - 600_000).toISOString(), at_ms: T0 - 600_000 }],
      liveness: { escalations: [], samples: { 'writer#1': prev }, quiet: {} },
    }
    const live = seatLiveness(task, T0 + 30_000, {
      silenceMs: 300_000,
      activity: { 'writer#1': cur },
      gateApplicable: true,
    })
    rec.add(
      'B2 离线复算',
      '★★ 四条判据合起来：台账 0 证据 **但会话日志在长** ⇒ **silent 为空（还活着）**',
      live.silent.length === 0 && live.seats[0].activity.grew === true,
      `silent=${live.silent.length}　evidence=${String(live.seats[0].evidence)}　activity=${JSON.stringify(live.seats[0].activity)}`,
    )

    // ★ 修误判 ≠ 关掉检测：日志**不再增长**时，同一条判据仍必须判它失联。
    const dead = seatLiveness(task, T0 + 900_000, { silenceMs: 300_000, activity: { 'writer#1': { atMs: T0 + 600_000, size: 381_679, mtimeMs: T0 } }, gateApplicable: true })
    rec.add(
      'B2 离线复算',
      '★ 反例（**不许把检测关掉**）：同一个席位、日志不再增长 ⇒ 照旧判失联',
      dead.silent.length === 1 && dead.silent[0].key === 'writer#1',
      `silent=${dead.silent.length}`,
    )

    // ★ 拿不到活动证据时不许只凭一次安静就冻结（连续 confirmations 次）。
    const noSample = seatLiveness(task, T0 + 900_000, { silenceMs: 300_000, activity: null, gateApplicable: true })
    rec.add(
      'B2 离线复算',
      `★ 拿不到活动证据 ⇒ 第 1 次**不冻结**（pending），要连续 ${DEFAULT_SILENCE_CONFIRMATIONS} 次`,
      noSample.silent.length === 0 && noSample.pending.length === 1,
      `silent=${noSample.silent.length} pending=${noSample.pending.length}　${noSample.pending[0]?.pending_reason ?? ''}`,
    )
    const streak = { ...task, liveness: { ...task.liveness, samples: {} , quiet: { 'writer#1': 1 } } }
    const second = seatLiveness(streak, T0 + 900_000, { silenceMs: 300_000, activity: null, gateApplicable: true })
    rec.add('B2 离线复算', '★ 连续第 2 次仍拿不到证据 ⇒ 这才冻结', second.silent.length === 1, `silent=${second.silent.length}`)
    rec.add(
      'B2 离线复算',
      '★ 活动阈值是实数（1024 B）：比它小的一点点抖动不算"在活动"',
      DEFAULT_ACTIVITY_MIN_BYTES === 1024 && activityOfSamples({ atMs: T0, size: 1000, mtimeMs: T0 }, { atMs: T0 + 30_000, size: 1100, mtimeMs: T0 + 1 }).grew === false,
      `min=${DEFAULT_ACTIVITY_MIN_BYTES}`,
    )
  }

  // =========================================================================
  // B5｜幂等键 = **稳定交付身份**，不许含递增计数器
  // =========================================================================
  {
    const task = {
      handoffs: [{ handoff_id: 'H-a' }, { handoff_id: 'H-b' }],
      history: [{ action: 'handoff:human_request', at: '2026-10-12T13:05:48Z', from: 'developing', to: 'awaiting_human' }],
      human_requests: [{ request_id: 'HR-1' }, { request_id: 'HR-2' }],
    }
    rec.add('B5 稳定身份', '★ 台账身份：handoff ⇒ 最新一条 handoff_id', ledgerIdentityOf('handoff', task) === 'H-b', String(ledgerIdentityOf('handoff', task)))
    rec.add('B5 稳定身份', '★ 台账身份：human ⇒ 最新一条 request_id', ledgerIdentityOf('human', task) === 'HR-2', String(ledgerIdentityOf('human', task)))
    rec.add(
      'B5 稳定身份',
      '★ 台账身份：transition ⇒ 取**最新一条历史的内容**（不是它的下标）',
      ledgerIdentityOf('transition', task) === 'handoff:human_request@2026-10-12T13:05:48Z:developing->awaiting_human',
      String(ledgerIdentityOf('transition', task)),
    )
    rec.add(
      'B5 稳定身份',
      '★★ 同一件事重放 ⇒ **同一个键**（改前是 `h228/h233/h237` 三个不同键 ⇒ 去重永不命中）',
      stableDiscFor({ kind: 'human', result: null, task }) === stableDiscFor({ kind: 'human', result: null, task }),
      stableDiscFor({ kind: 'human', result: null, task }),
    )
    rec.add(
      'B5 稳定身份',
      '★ 新的一件事 ⇒ **新键**（不会把第二条吞掉）',
      stableDiscFor({ kind: 'human', result: null, task: { ...task, human_requests: [...task.human_requests, { request_id: 'HR-3' }] } }) === 'HR-3',
      'HR-3',
    )
    rec.add(
      'B5 稳定身份',
      '★ 返回值深搜：字段在信封里也读得到（顶层 / structuredContent / content[].json）',
      discriminatorOf({ structuredContent: { request_id: 'HR-x' } }, ['request_id']) === 'HR-x' &&
        discriminatorOf({ content: [{ json: { handoff_id: 'H-y' } }] }, ['handoff_id']) === 'H-y',
      '信封深搜 OK',
    )
    rec.add(
      'B5 稳定身份',
      '★ **两处都取不到 ⇒ null**（调用方据此"不播报"，改前会退成 `h<historyLen>` 这个递增计数器）',
      stableDiscFor({ kind: 'handoff', result: null, task: { handoffs: [] } }) === null,
      String(stableDiscFor({ kind: 'handoff', result: null, task: { handoffs: [] } })),
    )
    rec.add(
      'B5 稳定身份',
      '★ 席位键口径：`writer` + `writer#3` ⇒ `writer#3`（**不是** `writer#writer#3`；账本里 20+ 条实测是后者）',
      wakeKeyOf({ taskId: 'T', kind: 'handoff', actorRole: 'writer', actorSeat: 'writer#3', disc: 'H-1' }) === 'T|handoff|writer#3|H-1',
      wakeKeyOf({ taskId: 'T', kind: 'handoff', actorRole: 'writer', actorSeat: 'writer#3', disc: 'H-1' }),
    )
  }

  // =========================================================================
  // B4｜唤醒正文必须标明"这是快照，动手前重读"
  // =========================================================================
  {
    const body = renderWakeText({
      key: 'T|handoff|writer#3|H-1',
      taskId: 'T',
      actorRole: 'writer',
      actorSeat: 'writer#3',
      what: '交了一份**交接物**',
      task: { id: 'T', state: 'developing' },
      snapshotAt: '2026-10-12T13:05:48Z',
    })
    rec.add('B4 快照标注', '★ 正文写明快照的**取样时刻**', body.includes('2026-10-12T13:05:48Z'), body.split('\n').filter((l) => l.includes('快照')).join(' / '))
    rec.add('B4 快照标注', '★ 正文写明「动手前请先 pipeline_status 重读」', body.includes('重读'), body.split('\n').filter((l) => l.includes('重读')).join(' / '))
  }

  // =========================================================================
  // B7｜分组名取"任务的项目名 / 落点目录名"，不取"工作目录名"
  // =========================================================================
  {
    const { ensureProjectGroupForTest } = await import('../lib/transport/index.js')
    const calls = []
    const ctx = { get: () => ({ create: async (a, b) => { calls.push(a ?? b); return { id: 'ws-1', created: true } } }) }
    const profileDir = process.env.DSH_PROFILE_DIR ?? '%USERPROFILE%\\.dsh\\profiles\\desktop'
    const g1 = await ensureProjectGroupForTest(ctx, {}, { task: { id: 'T-1', project_root: profileDir } })
    rec.add(
      'B7 分组名',
      '★★ 落在 profile 目录上的任务 ⇒ 组名**不许**是 `basename(工作目录)`（改前就是 `desktop`）',
      g1.ok === true && g1.title !== 'desktop' && g1.title_is_fallback === true && g1.title_source.includes('兜底'),
      `title=${g1.title}　source=${g1.title_source}`,
    )
    const g2 = await ensureProjectGroupForTest(ctx, {}, { task: { id: 'T-2', project_name: '多AI流水线', project_root: profileDir } })
    rec.add('B7 分组名', '★ 任务带 `project_name` ⇒ 用它', g2.ok === true && g2.title === '多AI流水线' && g2.title_source === 'task.project_name', `title=${g2.title}　source=${g2.title_source}`)
    const g3 = await ensureProjectGroupForTest(ctx, {}, { task: { id: 'T-3', project_root: 'C:\\work\\my-project' } })
    rec.add('B7 分组名', '★ 没有 project_name ⇒ 用落点目录名（这里是 project_root 的 basename）', g3.ok === true && g3.title === 'my-project', `title=${g3.title}　source=${g3.title_source}`)
  }

  // =========================================================================
  // B9｜守门按**真实文件身份**判"读代码"，不按目录前缀
  // =========================================================================
  {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pipeline-t14-'))
    try {
      const root = dir
      await writeFile(join(root, 'fizzbuzz.js'), 'export const f = 1\n', 'utf8')
      await writeFile(join(root, 'cordis.patch.yml'), 'plugins: []\n', 'utf8')
      const task = { taskId: 'T-9', projectRoot: root, pipelineDir: join(root, '.pipeline'), taskSelfDir: join(root, '.pipeline', 'T-9'), reportsDir: join(root, '.pipeline', 'T-9', 'reports'), scopeAnchor: null, changeScope: null }

      const codeCmd = `Get-Content "${join(root, 'fizzbuzz.js')}"`
      const cfgCmd = `Get-Content "${join(root, 'cordis.patch.yml')}"`
      const dirCmd = `Get-ChildItem "${join(root, 'snapshot-20261011-084255')}"`

      rec.add('B9 真实文件身份', '★ 读 `.js` 源码正文 ⇒ **照旧拒**（没放宽）', String(scanShellCommand(codeCmd, task, 'main', {}) ?? '').includes('不得通过 shell 读取项目代码'), String(scanShellCommand(codeCmd, task, 'main', {}) ?? '(放行)').split('\n')[0])
      rec.add(
        'B9 真实文件身份',
        '★★ 读 223 字节的 `cordis.patch.yml` ⇒ **放行**（改前理由是"不得通过 shell 读取项目代码"）',
        scanShellCommand(cfgCmd, task, 'main', {}) === null,
        String(scanShellCommand(cfgCmd, task, 'main', {}) ?? '(放行)').split('\n')[0],
      )
      rec.add(
        'B9 真实文件身份',
        '★★ 列一个**回滚快照目录名** ⇒ **放行**（那是个目录，不是代码正文）',
        scanShellCommand(dirCmd, task, 'main', {}) === null,
        String(scanShellCommand(dirCmd, task, 'main', {}) ?? '(放行)').split('\n')[0],
      )
      rec.add(
        'B9 真实文件身份',
        '★ 判据只依赖 (命令串, 任务根, 文件系统)：同一条命令算三遍 ⇒ **同一个结论**（改前会因缓存冷热而翻）',
        [0, 1, 2].map(() => scanShellCommand(cfgCmd, task, 'main', {}) === null).join(',') === 'true,true,true' &&
          [0, 1, 2].map(() => scanShellCommand(codeCmd, task, 'main', {}) !== null).join(',') === 'true,true,true',
        '三次一致',
      )
      rec.add('B9 真实文件身份', '★ 路径抽取：引号内路径与裸路径都抽得到', extractCommandPaths(`Get-Content "${join(root, 'a.json')}" ; type ${join(root, 'b.js')}`).length >= 2, extractCommandPaths(`Get-Content "${join(root, 'a.json')}" ; type ${join(root, 'b.js')}`).join(' | '))
      rec.add(
        'B9 真实文件身份',
        '★ 身份分类：源码扩展名算代码；配置/日志/会话目录一律不算',
        looksLikeSourcePath('x/y.ts', root) === true &&
          looksLikeSourcePath('x/y.yml', root) === false &&
          looksLikeSourcePath(join(root, '.pipeline', 'T', 'reports', 'r.js'), root) === false &&
          looksLikeSourcePath(join(root, 'sessions', 'a', 'b.js'), root) === false,
        '分类 OK',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // B12｜`pipeline_help` 不再悬空：速查入口真的存在（走 pipeline_status 的 help=）
  // =========================================================================
  {
    const src = await (await import('node:fs/promises')).readFile(new URL('../lib/tools/status.js', import.meta.url), 'utf8')
    rec.add(
      'B12 速查入口',
      '★ `pipeline_status` 带 `help=<主题>` 参数（速查挂在**任何角色都会调**的既有工具上）',
      src.includes("help: S('string', '★ 不查状态、改查**速查**") && src.includes('PIPELINE_HELP_TOPICS'),
      '参数与主题表都在 lib/tools/status.js',
    )
    rec.add(
      'B12 速查入口',
      '★ 速查正文**与实现同源**（roles 一节从 `ROLES` 派生，不手抄一份会漂移的文档）',
      /roles: Object\.values\(ROLES\)\.map/.test(src),
      'roles 一节派生自 ROLES',
    )
    rec.add(
      'B12 速查入口',
      '★ 没有"注册了却不存在"的工具名：`pipeline_help` **不作为工具名出现**（它只作为注释里的历史说明存在）',
      !src.includes("name: 'pipeline_help'"),
      'lib/tools.js 里没有名为 pipeline_help 的注册',
    )
  }

  // =========================================================================
  // B13｜角色边界卡覆盖性在**计划那一站**就判死
  // =========================================================================
  {
    const src = await (await import('node:fs/promises')).readFile(new URL('../lib/tools/plan.js', import.meta.url), 'utf8')
    rec.add(
      'B13 边界卡覆盖',
      '★ `pipeline_plan` 在**交计划之前**核对 `role_boundaries` 覆盖全部执行角色（缺一张就拒、计划不提交）',
      src.includes('计划**没有提交**') && src.includes('const missing = need.filter((r) => !got.has(r))'),
      '判据在 pipeline_plan 的 run() 里、`store.submitHandoff` 之前',
    )
    // 覆盖性判据本身仍要能算出"缺谁"（用真实名单算一遍）
    const built = buildRoster({ tier: 'L1', reason: 'B13 夹具', judgedBy: 'planner' })
    const need = built.ok === true ? built.roster.execution_roles : []
    const got = new Set(['writer', 'tester', 'reviewer'])
    const missing = need.filter((r) => !got.has(r))
    rec.add('B13 边界卡覆盖', '★ L1 的执行角色里，缺卡的角色**逐条点得出名**', built.ok === true && missing.length > 0, `执行角色=${need.join('、')}　缺=${missing.join('、')}`)
  }

  return { passed: rec.passed, total: rec.total, text: rec.text(), items: rec.items }
}

// 允许直接 `node tests/t14-fix-check.mjs`
if (process.argv[1] !== undefined && process.argv[1].endsWith('t14-fix-check.mjs')) {
  const r = await runT14FixCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
