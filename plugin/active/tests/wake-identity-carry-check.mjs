/**
 * dsh-pipeline · tests/wake-identity-carry-check.mjs
 * ============================================================================
 * **机制自己的唤醒留痕，逐条不许顶走孤儿身份**（P2-8 的「仍未验证」那半边）
 *
 * ---------------------------------------------------------------------------
 * 本条要关的是哪个口（逐字引用 bug 单 P2-8 的登记）：
 * ---------------------------------------------------------------------------
 *   > ★ **仍未验证（如实登记）**：`wake:delivered` / `wake:failed` / `wake:dedup` /
 *   >   `wake:escalated` 这四条各自的「顶走身份」效果 —— 探针与用例只跑了
 *   >   `wake:skipped` 这一支（最常发的那一支）；它们**写入路径逐字相同**，
 *   >   按同一判据剔除，但**逐条实测没有做**。
 *
 * 所以本套**只做一件事**：把那四条名字**逐个**放进生产形状里跑，看限次到底生不生效。
 * ★ 这不是"再抄一遍 C3 段" —— C3 段跑的是 `wake:skipped` 一支 + 结构判据
 *   （"这五个名字在不在剔除表里"）。**"在表里"不等于"用了它对"**：
 *   一个名字完全可以既在表里、又在真实判定路径上失效（例如剔除发生在身份算完之后）。
 *   本套跑的是**身份与计数**那条链路本身。
 *
 * ---------------------------------------------------------------------------
 * 判据（三条，缺一条就不算实现）
 * ---------------------------------------------------------------------------
 *   ① **正例（逐条 × 4）**：机制每轮写一行 `wake:<名字>` ⇒ 孤儿身份**一个字不变**
 *      ⇒ `attemptsOf` 照数 ⇒ 第 3 次失败之后（第 4 轮扫描）落 `orphan:redeliver-abandoned`
 *      + 账本 `markEscalated` + 播报一次；再扫两轮恒 `skip`（不无限重投）。
 *   ② **反例①（逐条 × 4）**：把同一个名字改一个字符（`wake:delivered-x`）⇒ 身份**每轮都换**
 *      ⇒ 计数每轮从 0 重数 ⇒ **四轮全是 `failed`、永不 abandon**。
 *      ★ 这一条是"证明正例不是假绿"的那一条：如果判据其实是"什么都不剔"，
 *        正例照样会绿，而这一条会红。
 *   ③ **反例②（逐字性）**：`wake:Delivered`（大小写漂移）同样必须**不命中** ——
 *      剔除是**逐字比对动作名**，不是前缀匹配、不做大小写归一。
 *
 * ---------------------------------------------------------------------------
 * 密闭性（P1-12 的教训：判据不许读活体）
 * ---------------------------------------------------------------------------
 *   · 全部夹具**自造临时任务目录**（`createHarness()`），不读任何真单、不碰真账本；
 *   · 身份里的"最后一次进展时刻"由夹具**写死在盘上**（`history[].at`），
 *     **不靠 sleep 等它换秒** —— 于是这套的结果与"插件是否正在活动"完全无关；
 *   · 全程不建任何真实会话、不监听端口、跑完即删临时目录。
 *
 * 用法：`node tests/wake-identity-carry-check.mjs`（独立跑）或经 `tests/run-all.mjs` 汇总。
 *
 * @module dsh-pipeline/tests/wake-identity-carry-check
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_MAX_REDELIVER_ATTEMPTS,
  MECHANISM_BOOKKEEPING_ACTIONS,
  createOrphanAudit,
  createOrphanRescue,
  judgeView,
  orphanVerdict,
  sampleSeatActivity,
} from '../lib/orphan.js'
import { createSeatNotifier } from '../lib/tools.js'
import { createWakeLedger } from '../lib/wakeledger.js'
import { createHarness, disposeHarness } from './selftest-core.mjs'

const MIN = 60 * 1000

/**
 * ★ 本条要验的**四条名字**（逐字来自 `lib/wakeup/keys.js` 的 `WAKE_AUDIT`）：
 *   `wake:skipped` 那一支 C3 段已经跑过，这里跑剩下的四条。
 */
const WAKE_NAMES = ['wake:delivered', 'wake:failed', 'wake:dedup', 'wake:escalated']

/** 近似名（改一个字符）：用来证明"剔除是逐字比对"，也是反例①的夹具。 */
const nearMiss = (name) => `${name}-x`

const indent = (s, n = 4) =>
  String(s ?? '')
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n')

/** 秒级 ISO（与项目其余留痕同口径）。 */
const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

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
      L.push('dsh-pipeline · 唤醒留痕与孤儿身份（P2-8 四条未验证的逐条实测）')
      L.push('='.repeat(78))
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('')
          L.push(`【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(indent(it.detail, 6))
      }
      L.push('')
      L.push('='.repeat(78))
      L.push(`总计：${this.passed}/${this.total} 通过`)
      L.push('='.repeat(78))
      return L.join('\n')
    },
  }
}

/** 记录型投递通道替身：**一律投不出去**（要走"失败 → 计数 → 放弃"那条链）。 */
function createSpyTransport() {
  const notifies = []
  return {
    notifies,
    async notifyRole(spec) {
      notifies.push({ role: String(spec?.role ?? ''), seat: spec?.seat ?? null, sessionId: String(spec?.sessionId ?? '') })
      return { ok: false, messageId: null, note: '（夹具）会话已经不在宿主里，投递被拒。' }
    },
    async spawnRole() {
      return { ok: false, agentId: null, token: null, note: '（替身通道）本机制**不许**建会话。' }
    },
  }
}

/** 从盘上读回本测试自己的 `task.json`（只读）。 */
function readTaskFile(h, taskId) {
  return JSON.parse(readFileSync(join(h.store.taskDir(taskId), 'task.json'), 'utf8'))
}

/**
 * ★★ **本套的核心夹具原语**：往**盘上**那张自己的 `task.json` 里补一行 `history`，
 *   再让 store 按"盘比内存新 ⇒ 重载"的既有对账读回来。
 *
 * 为什么必须写死时刻、不靠 sleep 换秒：
 *   身份 = `<任务>|orphan|<判词>|<状态>|<最后一次进展时刻>`（`lib/orphan.js:610`），
 *   秒级。若靠 sleep 让它自然换秒，这套的结论就会随"跑得多快"漂 ——
 *   那正是 P1-12 判"非密闭测试"的理由。写死时刻 ⇒ **同一份代码跑多少次都一样**。
 */
async function appendHistoryRow(h, taskId, row) {
  const file = join(h.store.taskDir(taskId), 'task.json')
  const t = JSON.parse(readFileSync(file, 'utf8'))
  t.history = [...(Array.isArray(t.history) ? t.history : []), row]
  writeFileSync(file, JSON.stringify(t, null, 2), 'utf8')
  return h.store.get(taskId)
}

/** 把一张刚建出来的夹具单整体"变旧"（判据取"最后一次进展"的最大值 ⇒ 必须连 history 一起挪）。 */
async function ageTask(h, taskId, minutes = 40) {
  const file = join(h.store.taskDir(taskId), 'task.json')
  const t = JSON.parse(readFileSync(file, 'utf8'))
  const shift = (iso) =>
    typeof iso === 'string' && iso.length > 0 && Number.isFinite(Date.parse(iso))
      ? isoOf(Date.parse(iso) - minutes * MIN)
      : iso
  t.created_at = shift(t.created_at)
  t.updated_at = shift(t.updated_at)
  for (const x of Array.isArray(t.history) ? t.history : []) x.at = shift(x.at)
  for (const d of Array.isArray(t.dispatched) ? t.dispatched : []) {
    if (typeof d.at === 'string') {
      d.at = shift(d.at)
      d.at_ms = Date.parse(d.at)
    }
  }
  writeFileSync(file, JSON.stringify(t, null, 2), 'utf8')
  return h.store.get(taskId)
}

/**
 * 一个"什么都投不出去、但一切都记下来"的最小运行期。
 * ★ `backoffMs: 0`：本套要验的是**限次**，退避会把轮次吃掉（退避本身在 C 段有专条）。
 */
async function makeRig(tag, over = {}) {
  const h = await createHarness()
  const opened = await h.store.open({ requirement: `自测：唤醒留痕不许顶走身份（${tag}）`, actorRole: 'main', actorAgentId: 'agent-main' })
  const taskId = opened.task.id
  await h.store.transition({ taskId, event: 'dispatch_orchestrator', actorRole: 'main', actorAgentId: 'agent-main' })
  await h.store.recordDispatch(taskId, { role: 'orchestrator', seat: null, agentId: `session-gone-${tag}`, token: 'PT-dead' })
  const ledger = createWakeLedger({ file: join(h.projectRoot, '_ledger', 'wake-ledger.jsonl') })
  const transport = createSpyTransport()
  const notifier = createSeatNotifier({ store: h.store, transport, wakeup: {} })
  const wakes = []
  const audits = []
  const rescue = createOrphanRescue({
    store: h.store,
    ledger,
    notify: (spec) => notifier.notifyOnly(spec.task, spec.role, spec.seat, spec.text, false),
    wake: async (spec) => {
      wakes.push(spec)
    },
    audit: async (id, action, detail) => {
      audits.push({ task_id: id, action, detail })
      await createOrphanAudit((x) => h.store.auditFile(x))(id, action, detail)
    },
    detectRunFailure: async () => ({ known: true, found: false, evidence: null, source: 'fixture', note: '夹具：没有失败证据' }),
    sampleActivity: (task) => sampleSeatActivity(task, Date.now(), { roots: [join(h.projectRoot, '_sessions')] }),
    graceMs: over.graceMs ?? 15 * MIN,
    backoffMs: 0,
    maxAttempts: DEFAULT_MAX_REDELIVER_ATTEMPTS,
    warn: () => {},
  })
  await ageTask(h, taskId, 40)
  return { h, taskId, ledger, transport, rescue, wakes, audits }
}

/** 主入口。 */
export async function runWakeIdentityCarryCheck() {
  const rec = createRecorder()
  const own = []
  const now = Date.now()

  /**
   * 每轮写一行留痕的**时刻表**：一律落在判定窗（15 分）**之外**、且**一轮比一轮新**
   * （身份取"最大值"）。这样"这一行有没有被剔掉"就能从身份上直接读出来：
   *   · 被剔 ⇒ 身份还停在最初那条（40 分钟前）⇒ 同一个身份 ⇒ 计数累加；
   *   · 没剔 ⇒ 身份换成本轮这一行 ⇒ 新身份 ⇒ 计数从 0 重数。
   */
  const ROUND_AT = [38, 32, 26, 20].map((m) => now - m * MIN)

  // =========================================================================
  // A. 前提与逐字性（先把"下面两条为什么算判据"钉死）
  // =========================================================================
  {
    const missing = WAKE_NAMES.filter((n) => !MECHANISM_BOOKKEEPING_ACTIONS.includes(n))
    rec.add(
      'A 前提与逐字性',
      '★ 四条名字**逐条在剔除表里**（`wake:delivered` / `wake:failed` / `wake:dedup` / `wake:escalated`）',
      missing.length === 0,
      `剔除表 ${MECHANISM_BOOKKEEPING_ACTIONS.length} 条；缺：${missing.length === 0 ? '（无）' : missing.join('、')}`,
    )
    /** 近似名清单：逐条名字加后缀 × 4 + 两个大小写漂移。它们**一个都不许**在表里。 */
    const variants = [...WAKE_NAMES.map(nearMiss), 'wake:Delivered', 'Wake:delivered']
    const wrong = variants.filter((v) => MECHANISM_BOOKKEEPING_ACTIONS.includes(v))
    rec.add(
      'A 前提与逐字性',
      '★ **近似名一律不在表里**（`wake:<名字>-x` × 4 + `wake:Delivered` + `Wake:delivered`）—— 否则下面那条反例①就是假的反例',
      wrong.length === 0,
      wrong.length === 0 ? `近似名 ${variants.length} 个，命中 0 个 ✓：${variants.join('、')}` : `被误纳入：${wrong.join('、')}`,
    )
    /**
     * ★ **行为**判据（不是"表里有没有"）：把两行放进同一张任务上，
     *   `judgeView` 之后应当**只剩真实那一行**。
     */
    const t0 = isoOf(now - 40 * MIN)
    const t1 = isoOf(now - 30 * MIN)
    const t2 = isoOf(now - 20 * MIN)
    const view = judgeView({
      id: 'T-FIXTURE-view',
      history: [
        { at: t0, actor: 'main', action: 'transition:dispatch_orchestrator' },
        { at: t1, actor: 'main', action: 'wake:delivered' },
        { at: t2, actor: 'main', action: nearMiss('wake:delivered') },
      ],
    })
    rec.add(
      'A 前提与逐字性',
      '★★ **行为判据**：`judgeView` 真的剔掉 `wake:delivered` 那一行，而**留下** `wake:delivered-x` 那一行（替换掉"在表里"这种结构判据）',
      view.history.length === 2 &&
        view.history.some((x) => x.action === 'transition:dispatch_orchestrator') &&
        !view.history.some((x) => x.action === 'wake:delivered') &&
        view.history.some((x) => x.action === nearMiss('wake:delivered')),
      `留 ${view.history.length} 行：${view.history.map((x) => x.action).join(' / ')}`,
    )
  }

  // =========================================================================
  // B. 正例（**逐条** × 4）：身份不变 ⇒ 限次真的生效 ⇒ 第 4 轮放弃 + 播报
  // =========================================================================
  for (const name of WAKE_NAMES) {
    const rig = await makeRig(`pos${WAKE_NAMES.indexOf(name)}`)
    own.push(rig)
    const rounds = []
    const ids = []
    for (let i = 0; i < 6; i += 1) {
      // ★ 复刻生产形状：每轮扫描**之前**，唤醒层已经往 history 写过一行（同形夹具）。
      if (i < ROUND_AT.length) {
        await appendHistoryRow(rig.h, rig.taskId, { at: isoOf(ROUND_AT[i]), actor: 'main', action: name, note: `夹具：机制自己那一行（${name}）` })
      }
      rounds.push(await rig.rescue.runOnce())
      ids.push(String(rounds[i]?.actions?.[0]?.id ?? '(未判)'))
    }
    const acts = rounds.map((r) => String(r.actions?.[0]?.action ?? '(未判)'))
    const landed = readTaskFile(rig.h, rig.taskId).history.filter((x) => x.action === name).length
    const aband = rig.audits.find((x) => x.action === 'orphan:redeliver-abandoned') ?? null
    rec.add(
      `B 正例 · ${name}`,
      `★★ 同形留痕写满四轮（盘上真的有 ${name} × 4 行）⇒ **身份一个字不变**，前三轮 \`failed\`、**第 4 轮 \`abandon\`**、之后恒 \`skip\``,
      landed === ROUND_AT.length &&
        new Set(ids).size === 1 &&
        acts.join('/') === 'failed/failed/failed/abandon/skip/skip' &&
        aband !== null &&
        Number(aband.detail?.attempts) === DEFAULT_MAX_REDELIVER_ATTEMPTS &&
        rig.ledger.escalatedEntry(String(aband.detail?.orphan_id ?? '')) !== null &&
        rig.wakes.length === 1 &&
        rig.wakes[0].kind === 'orphan-abandoned' &&
        rig.transport.notifies.length === DEFAULT_MAX_REDELIVER_ATTEMPTS,
      `盘上 ${name} 行数=${landed}（应 4，证明留痕真的落了盘）\n` +
        `六轮动作=${acts.join('/')}（应 failed/failed/failed/abandon/skip/skip）\n` +
        `身份去重数=${new Set(ids).size}（应恒为 1）　身份=${ids[3]}\n` +
        `放弃审计=${JSON.stringify(aband?.detail ?? null)}\n` +
        `投递次数=${rig.transport.notifies.length}（应 ${DEFAULT_MAX_REDELIVER_ATTEMPTS}）　播报=${rig.wakes.map((w) => w.kind).join(',') || '(无)'}`,
    )
  }

  // =========================================================================
  // C. 反例①（**逐条** × 4）：把名字改一个字符 ⇒ 身份每轮都换 ⇒ 永不放弃
  // =========================================================================
  for (const name of WAKE_NAMES) {
    const fake = nearMiss(name)
    const rig = await makeRig(`neg${WAKE_NAMES.indexOf(name)}`)
    own.push(rig)
    const rounds = []
    const ids = []
    for (let i = 0; i < ROUND_AT.length; i += 1) {
      await appendHistoryRow(rig.h, rig.taskId, { at: isoOf(ROUND_AT[i]), actor: 'main', action: fake, note: `夹具：近似名（${fake}）` })
      rounds.push(await rig.rescue.runOnce())
      ids.push(String(rounds[i]?.actions?.[0]?.id ?? '(未判)'))
    }
    const acts = rounds.map((r) => String(r.actions?.[0]?.action ?? '(未判)'))
    const un = rig.ledger.unresolvedEntries({ taskId: rig.taskId, limit: 50 })
    rec.add(
      `C 反例① · ${fake}`,
      `★★ **近似名不命中**：每轮一行 \`${fake}\` ⇒ 身份**每轮都换**（4 个不同身份）、四轮全是 \`failed\`、**永不 \`abandon\`**、账本无 \`escalated\`、**一次播报都没有**`,
      new Set(ids).size === ROUND_AT.length &&
        acts.every((a) => a === 'failed') &&
        un.length === ROUND_AT.length &&
        un.every((e) => Number(e?.detail?.attempt) === 1) &&
        ids.every((id) => rig.ledger.escalatedEntry(id) === null) &&
        rig.wakes.length === 0 &&
        rig.transport.notifies.length === ROUND_AT.length &&
        ids.every((id, i) => id.endsWith(isoOf(ROUND_AT[i]))),
      `身份去重数=${new Set(ids).size}（应 ${ROUND_AT.length} —— 每轮一个新身份）\n` +
        `四轮动作=${acts.join('/')}（应全 failed：身份换了 ⇒ 计数每轮从 0 重数）\n` +
        `账本 unresolved=${un.length} 条，attempt 全是 ${un.map((e) => Number(e?.detail?.attempt)).join('/')}（应全是 1）\n` +
        `播报=${rig.wakes.length}（应 0）　投递=${rig.transport.notifies.length}（应 ${ROUND_AT.length}）\n` +
        `★ 这一条绿，才证明 B 那四条不是"什么都不剔也照样对"的假绿。`,
    )
  }

  // =========================================================================
  // D. 反例②（逐字性）：大小写漂移同样不许命中
  // =========================================================================
  {
    const rig = await makeRig('case')
    own.push(rig)
    const variants = ['wake:Delivered', 'Wake:delivered']
    const seen = []
    for (let i = 0; i < variants.length; i += 1) {
      await appendHistoryRow(rig.h, rig.taskId, { at: isoOf(ROUND_AT[i]), actor: 'main', action: variants[i], note: `夹具：大小写漂移（${variants[i]}）` })
      const r = await rig.rescue.runOnce()
      seen.push({ id: String(r.actions?.[0]?.id ?? '(未判)'), action: String(r.actions?.[0]?.action ?? '(未判)') })
    }
    rec.add(
      'D 反例② 逐字性',
      '★★ **剔除是逐字比对动作名**：`wake:Delivered` / `Wake:delivered` 都**不命中**（身份被它们换掉 ⇒ 计数从 0 重数）',
      new Set(seen.map((x) => x.id)).size === variants.length &&
        seen.every((x) => x.action === 'failed') &&
        seen.every((x, i) => x.id.endsWith(isoOf(ROUND_AT[i]))),
      `两轮：${seen.map((x) => `${x.action}@${x.id.split('|').slice(-1)[0]}`).join('  ')}\n` +
        `身份去重数=${new Set(seen.map((x) => x.id)).size}（应 ${variants.length}）\n` +
        `★ 结论：既不前缀匹配、也不做大小写归一 —— 名字写错就是"没剔"，而不是"差不多也算"。`,
    )
    rec.add(
      'D 反例② 逐字性',
      '★ 且这**不是**"把判定窗关掉"：身份照旧由 `orphanVerdict` 内容派生（同一份 task 连算两次，id 逐字相同）',
      (() => {
        const task = readTaskFile(rig.h, rig.taskId)
        const spec = {
          task,
          now: Date.now(),
          graceMs: 15 * MIN,
          activity: {},
          prevSamples: null,
          lastDeliveryAtMs: null,
          runFailure: null,
        }
        const a = orphanVerdict(spec)
        const b = orphanVerdict(spec)
        return String(a.findings?.[0]?.id ?? '') === String(b.findings?.[0]?.id ?? '') && a.findings.length === b.findings.length
      })(),
      '同一份台账连算两次 ⇒ 身份逐字相同（内容派生，不是随机 / 不是按次数编的）',
    )
  }

  // --- 清理（临时目录跑完即删）---
  for (const rig of own) await disposeHarness(rig.h)

  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

// 独立跑：`node tests/wake-identity-carry-check.mjs`
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await runWakeIdentityCarryCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
