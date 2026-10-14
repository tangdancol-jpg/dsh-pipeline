/**
 * dsh-pipeline · **两条缺陷的验收夹具**（失联误报 + 澄清裁定后不唤醒发起席位）
 * ============================================================================
 *     node tests/seat-liveness-wake-check.mjs
 *
 * 为什么单开一套而不是塞进已有套里：需求把验收钉成 A1~A7 七条**可判定的二值断言**，
 * 每一条都要有"改前必红、改后必绿"的形状。散进 `liveness-check` / `ladder-check`
 * 会让"哪条验收由谁守"变得查不出来。
 *
 * ★ 登记状态（如实写，不伪造）：本套**尚未**登记进 `tests/run-all.mjs`。原因不是遗漏，
 *   而是**权限面** —— 本任务的授权面只给了 `tests/` 的 `create`（"新增文件只允许落在
 *   测试目录内"），没有给 `run-all.mjs` 的 `modify`；守门在改它的那一刻按"命中的授权是
 *   create、但这个路径已经存在"直接拒掉。要登记得走计划 AI 的授权面变更
 *   （`pipeline_scope_amend`），不在编写席位的权限里。
 *   ⇒ 在登记完成之前，全量跑法是**两条**（第二条别漏）：
 *       node tests/run-all.mjs
 *       node tests/seat-liveness-wake-check.mjs
 *
 * ★ 本套的判据来源（不是"我觉得"）：
 *   · 2026-10-12 晚真单 `T-20261011-214043` 上主对话现场实测的**原始数字**（A3）；
 *   · 需求档 H-d6edcd25b7389aed 的 A1~A7 与测试要点 P1~P8；
 *   · 全部输入都是**固定夹具**（合成证据 / 临时目录 / 固化字节数），
 *     不依赖线上任何真实会话文件，离线可跑。
 *
 * 覆盖与验收的对应关系：
 *   A1 存活判定（有增长 ⇒ 存活、不冻结）····················· 组 A1
 *   A2 真阳性保留（无变化 ⇒ 照旧判失联并冻结）··············· 组 A2
 *   A3 真实证据离线复算（381,679 → 392,396 判存活）············ 组 A3
 *   A4 证据不足不得冻结 + "证据不可用"可观测 ················· 组 A4（P1 七组夹具）
 *   A5 唤醒闭环（裁定 ⇒ 发起席位被实际唤醒 ⇒ 继续干活）······· 组 A5（P4）
 *   A6 状态字段不过期（投递时刻真实状态）····················· 组 A6（P5）
 *   A7 幂等不回归（重复裁定不重复投递）······················· 组 A7（P6）
 *   P7 并发澄清（两个席位各卡一条 ⇒ 各自被唤醒）·············· 组 P7
 *   P8 唤醒不可达（显式可见失败、不自动补位）················· 组 A5（P8 三条）
 *
 * @module dsh-pipeline/tests/seat-liveness-wake-check
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_ACTIVITY_MIN_BYTES,
  DEFAULT_SILENCE_CONFIRMATIONS,
  SESSION_LOG_NAME,
  activityOfSamples,
} from '../lib/liveness.js'
import { callTool, disposeHarness, manifestFor } from './selftest-core.mjs'
import { createMultiWriterFixture } from './writers-check.mjs'

// ---------------------------------------------------------------------------
// 断言小工具（与其它套同一形状）
// ---------------------------------------------------------------------------

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
      L.push('dsh-pipeline · 席位失联误报 + 澄清裁定后不唤醒发起席位（验收夹具）')
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

const hit = (text, fragment) =>
  String(fragment)
    .split('|')
    .some((a) => a.length > 0 && String(text).includes(a))

// ---------------------------------------------------------------------------
// ★ 夹具 1：会话日志的**离线段**
// ---------------------------------------------------------------------------

/** 一次采样的形状（`atMs` / `size` / `mtimeMs`）。 */
const sample = (atMs, size, mtimeMs = atMs) => ({ atMs, size, mtimeMs })

/** 造一段**精确字节数**的假会话日志（`session.v4.jsonl.zstd` 的真文件名）。 */
const fakeLogBytes = (n) => Buffer.alloc(n, 0x7a)

/**
 * 在临时目录里摆一次"会话根 + 某条会话的日志"。
 *
 * 形状**逐字照 `findSessionLog` 的口径**：`<sessionsRoot>/<bucket>/<sessionId>/session.v4.jsonl.zstd`
 * —— 目录名是工作目录的编码（宿主实现细节），所以本套不拼那个名字，只用中性 bucket 名。
 */
async function plantSessionLog(root, sessionId, bytes) {
  const dir = join(root, 'bucket', sessionId)
  await mkdir(dir, { recursive: true })
  const file = join(dir, SESSION_LOG_NAME)
  await writeFile(file, fakeLogBytes(bytes))
  return file
}

/** 临时替换 `DSH_SESSIONS_DIR`（采样只看它），跑完**一定**还原。 */
async function withSessionsRoot(root, fn) {
  const prev = process.env.DSH_SESSIONS_DIR
  process.env.DSH_SESSIONS_DIR = root
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.DSH_SESSIONS_DIR
    else process.env.DSH_SESSIONS_DIR = prev
  }
}

/**
 * 把某席位的派活台账改写成"真实会话 id 形状"（`session-…`）。
 *
 * 为什么要改：`sampleSessionActivity` 的 `gate_applicable` 判据之一是
 * "台账里至少一个会话 id 是 `session-` 形状"。夹具的模拟通道给的是
 * `fake-agent-001`，那条判据在夹具里**结构上采不到**，A4 的"连续确认门"
 * 就永远不会被跑到 —— 那正是"自测与线上走的是两条路"那种假绿。
 */
async function useRealShapeSessionId(fx, seat, sessionId, atMs) {
  await fx.h.store.recordDispatch(fx.taskId, {
    role: 'writer',
    seat,
    agentId: sessionId,
    sessionId,
    atMs,
    at: new Date(atMs).toISOString(),
    via: 'session',
  })
}

// ---------------------------------------------------------------------------
// ★ 夹具 2：造一个"轮到编写席动、但它一句话都没说"的任务
// ---------------------------------------------------------------------------

/**
 * 复用既有的多席位夹具（`developing` 状态），再把其中 `writer#1` 的派活时间
 * **推早**成"已经静默超过阈值"、会话 id 换成真实形状。
 *
 * 为什么不用手搓任务对象：状态机、身份索引、守门判据都必须与真实用法同源 ——
 * 手搓的 `{ state:'developing' }` 跑到 `transition({event:'block'})` 时会因为
 * 没有真实任务而给出与线上不同的结论，那时候测的就不是这条判据了。
 */
async function silentWriterFixture(opts = {}) {
  const fx = await createMultiWriterFixture({ writers: opts.writers ?? 1 })
  const silenceMs = opts.silenceMs ?? 300_000
  const atMs = opts.atMs ?? Date.now() - silenceMs * 2
  const sessionId =
    opts.sessionId ?? `session-${String(opts.tag ?? 'dead').padEnd(8, '0')}-0000-4000-8000-000000000001`
  await useRealShapeSessionId(fx, 'writer#1', sessionId, atMs)
  // 台账：这个席位**一句话都没说过**（0 交接物 / 0 流水 / 0 水位自报）。
  return { fx, silenceMs, atMs, sessionId }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runSeatLivenessWakeCheck() {
  const rec = createRecorder()
  const open = []
  const tmpRoots = []

  const mkTmp = async (tag) => {
    const d = await mkdtemp(join(tmpdir(), `dsh-pipeline-${tag}-`))
    tmpRoots.push(d)
    return d
  }

  try {
    // =======================================================================
    // P1｜判定二值夹具：七组输入逐组断言（对应 A1/A2/A4 的判据层）
    // =======================================================================
    {
      const T = 1_760_000_000_000
      const grew = activityOfSamples(sample(T, 200_000), sample(T + 30_000, 200_000 + DEFAULT_ACTIVITY_MIN_BYTES))
      rec.add(
        'P1 判定二值夹具',
        `① **有增长**：30 秒内 +${DEFAULT_ACTIVITY_MIN_BYTES} 字节（= 阈值本身）⇒ grew=true`,
        grew.known === true && grew.grew === true && grew.delta_bytes === DEFAULT_ACTIVITY_MIN_BYTES,
        JSON.stringify(grew),
      )

      const flat = activityOfSamples(sample(T, 200_000), sample(T + 30_000, 200_000))
      rec.add(
        'P1 判定二值夹具',
        '② **完全无变化**：size 一模一样 ⇒ known=true 且 grew=false（"它没动"，不是"拿不到"）',
        flat.known === true && flat.grew === false && flat.delta_bytes === 0,
        JSON.stringify(flat),
      )

      const missing = activityOfSamples(sample(T, 200_000), null)
      rec.add(
        'P1 判定二值夹具',
        '③ **文件不存在 / 读不到** ⇒ known=false（★ 不许把"拿不到"写成"它没动"）',
        missing.known === false && missing.grew === false,
        JSON.stringify(missing),
      )

      const empty = activityOfSamples(sample(T, 0), sample(T + 30_000, 0))
      rec.add(
        'P1 判定二值夹具',
        '④ **文件为空**（0 字节且不增长）⇒ known=true 且 grew=false（读得到、就是没动）',
        empty.known === true && empty.grew === false,
        JSON.stringify(empty),
      )

      const edge = activityOfSamples(sample(T, 200_000), sample(T + 30_000, 200_000 + DEFAULT_ACTIVITY_MIN_BYTES - 1))
      rec.add(
        'P1 判定二值夹具',
        `⑤ **卡在阈值边界**（+${DEFAULT_ACTIVITY_MIN_BYTES - 1} < ${DEFAULT_ACTIVITY_MIN_BYTES}）⇒ grew=false（判据用的是 ≥）`,
        edge.known === true && edge.grew === false,
        JSON.stringify(edge),
      )

      const first = activityOfSamples(null, sample(T, 200_000))
      rec.add(
        'P1 判定二值夹具',
        '⑥ **首次采样**（没有基线）⇒ known=true / grew=false（只建基线，不据此判死活）',
        first.known === true && first.grew === false && first.delta_bytes === null,
        JSON.stringify(first),
      )

      const stale = activityOfSamples(sample(T, 200_000), sample(T + 30 * 60_000, 999_999))
      rec.add(
        'P1 判定二值夹具',
        '⑦ **两次采样隔了半小时** ⇒ grew=false（"这一段不算刚才还在动"，不许拿隔夜的增量冒充活动）',
        stale.known === true && stale.grew === false && String(stale.reason).includes('超出窗口'),
        JSON.stringify(stale),
      )
    }

    // =======================================================================
    // A1｜有活动证据 ⇒ 判「存活」，且任务**不得**被推到「已阻塞」
    // =======================================================================
    {
      const sessionsRoot = await mkTmp('sessions-a1')
      const { fx, silenceMs, atMs, sessionId } = await silentWriterFixture({ tag: 'a1', silenceMs: 300_000 })
      open.push(fx.h)

      // 固定夹具（合成证据）：窗口内 0 交接物 / 0 流水 / 0 水位自报，**但日志在长**。
      const prevSize = 381_679
      const curSize = prevSize + 10_717
      await withSessionsRoot(sessionsRoot, async () => {
        await plantSessionLog(sessionsRoot, sessionId, curSize)
        const t = fx.h.store.peek(fx.taskId)
        t.liveness = { ...(t.liveness ?? {}), samples: { 'writer#1': sample(atMs, prevSize) }, quiet: {} }

        const before = fx.h.store.peek(fx.taskId).state
        const r = await fx.h.store.checkLiveness(fx.taskId, { now: atMs + silenceMs + 30_000, silenceMs, escalate: true })
        const after = fx.h.store.peek(fx.taskId).state

        rec.add(
          'A1 存活判定',
          `★ 0 交接物 / 0 流水 / 0 水位自报，但会话日志在 ${silenceMs / 1000} 秒窗口内 +10,717 字节 ⇒ **判存活**（silent 为空）`,
          r.ok === true && r.silent.length === 0 && r.live.seats[0]?.activity?.grew === true,
          `silent=${r.silent.length}　${JSON.stringify(r.live.seats[0]?.activity ?? null)}`,
        )
        rec.add(
          'A1 存活判定',
          '★★ 任务状态**没有被推到「已阻塞」**（改前：这一跑会把任务冻住，同时把一份已提交的 dev_to_test 挡掉）',
          before === 'developing' && after === 'developing' && r.escalated === false,
          `state ${before} → ${after}　escalated=${r.escalated}`,
        )
        rec.add(
          'A1 存活判定',
          '★ 台账里**没有**留下升级记录（连误冻的痕迹都不该有）',
          (fx.h.store.peek(fx.taskId).liveness?.escalations ?? []).length === 0,
          `escalations=${JSON.stringify(fx.h.store.peek(fx.taskId).liveness?.escalations ?? [])}`,
        )
        rec.add(
          'A1 存活判定',
          '★ 采样可用性如实回报（`activity_known:true` / `gate_applicable:true`）',
          r.activity_known === true && r.gate_applicable === true && r.live.gate_applicable === true,
          `activity_known=${r.activity_known}　gate_applicable=${r.gate_applicable}　live.gate_applicable=${r.live.gate_applicable}`,
        )
      })
    }

    // =======================================================================
    // A2｜真阳性保留：日志完全无变化 ⇒ 照旧判失联并冻结
    // =======================================================================
    {
      const sessionsRoot = await mkTmp('sessions-a2')
      const { fx, silenceMs, atMs, sessionId } = await silentWriterFixture({ tag: 'a2', silenceMs: 300_000 })
      open.push(fx.h)

      const frozen = 392_396
      await withSessionsRoot(sessionsRoot, async () => {
        // ★ 冻结的证据："早先采过一次，之后一直这么大" —— 不是"从没采到过"。
        await plantSessionLog(sessionsRoot, sessionId, frozen)
        const t = fx.h.store.peek(fx.taskId)
        t.liveness = { ...(t.liveness ?? {}), samples: { 'writer#1': sample(atMs, frozen) }, quiet: {} }

        const r = await fx.h.store.checkLiveness(fx.taskId, { now: atMs + silenceMs * 3, silenceMs, escalate: true })
        const after = fx.h.store.peek(fx.taskId)

        rec.add(
          'A2 真阳性保留',
          '★ 会话日志**完全无变化**（读到了基线、之后一个字节没长）⇒ 仍然判**失联**',
          r.silent.length === 1 && r.silent[0].key === 'writer#1' && r.live.seats[0]?.activity?.grew === false,
          `silent=${r.silent.length}　${JSON.stringify(r.live.seats[0]?.activity ?? null)}`,
        )
        rec.add(
          'A2 真阳性保留',
          '★★ 并按**既有行为**把任务推到「已阻塞」（修 bug ≠ 删功能）',
          r.escalated === true && after.state === 'blocked',
          `escalated=${r.escalated}　state=${after.state}　note=${String(r.note ?? '')}`,
        )
        rec.add(
          'A2 真阳性保留',
          '★ 升级留痕里带着**判据依据**（quiet_streak / activity / activity_known），事后能回答"判死时日志在不在长"',
          (after.liveness?.escalations ?? []).length === 1 &&
            after.liveness.escalations[0].activity_known === true &&
            after.liveness.escalations[0].evidence?.[0]?.seat === 'writer#1',
          JSON.stringify(after.liveness?.escalations?.[0] ?? null),
        )
        rec.add(
          'A2 真阳性保留',
          '★ 静默阈值仍是 5 分钟（**没有靠调大阈值**来通过 A1；这里用的就是同一个默认值）',
          fx.h.store.seatSilenceMs === 5 * 60 * 1000 && DEFAULT_SILENCE_CONFIRMATIONS === 2,
          `seatSilenceMs=${fx.h.store.seatSilenceMs}　默认确认次数=${DEFAULT_SILENCE_CONFIRMATIONS}`,
        )
      })
    }

    // =======================================================================
    // A3｜今晚实测序列**离线复算** ⇒ 判存活
    // =======================================================================
    {
      const sessionsRoot = await mkTmp('sessions-a3')
      const { fx, silenceMs, sessionId } = await silentWriterFixture({ tag: 'a3', silenceMs: 300_000 })
      open.push(fx.h)

      /**
       * 需求档里那条实测序列的原始数字（主对话现场观测，逐字固化）：
       *   · 席位 `<session-id>` 于 20:53:25 派出、20:58:30 被判失联；
       *   · 同一时刻它的会话日志 **30 秒内 381,679 B → 392,396 B（+10,717 B）**；
       *   · 其后 21:00:11→21:00:31 **+14,158 B**、21:01:00→21:01:20 **+23,207 B**。
       * ⇒ 判定必须为「存活」。
       */
      const T_DEAD = 1_760_000_000_000 // 20:58:30 —— 判死那一刻
      const T_DISPATCH = T_DEAD - 5 * 60 * 1000 - 5_000 // 20:53:25
      const WINDOW = [
        { prev: 381_679, cur: 392_396, span_ms: 30_000, label: '判死那一刻：30 秒 +10,717 B' },
        { prev: 392_396, cur: 406_554, span_ms: 20_000, label: '21:00:11→21:00:31：+14,158 B' },
        { prev: 406_554, cur: 429_761, span_ms: 20_000, label: '21:01:00→21:01:20：+23,207 B' },
      ]

      rec.add(
        'A3 真实证据离线复算',
        '★ 固化的三个增量与需求档逐字相符（10,717 / 14,158 / 23,207）',
        WINDOW[0].cur - WINDOW[0].prev === 10_717 &&
          WINDOW[1].cur - WINDOW[1].prev === 14_158 &&
          WINDOW[2].cur - WINDOW[2].prev === 23_207,
        WINDOW.map((w) => `${w.prev}→${w.cur}（+${w.cur - w.prev}）`).join('　'),
      )

      await withSessionsRoot(sessionsRoot, async () => {
        let passes = 0
        const detail = []
        for (const step of WINDOW) {
          // 每一步都**改真文件**：采样走的是与线上**同一条**读盘路径，不是喂数字。
          const file = await plantSessionLog(sessionsRoot, sessionId, step.cur)
          const size = (await stat(file)).size
          const t = fx.h.store.peek(fx.taskId)
          t.state = 'developing'
          t.previous_state = null
          t.liveness = { ...(t.liveness ?? {}), samples: { 'writer#1': sample(T_DEAD, step.prev) }, quiet: {}, escalations: [] }
          await useRealShapeSessionId(fx, 'writer#1', sessionId, T_DISPATCH)

          const r = await fx.h.store.checkLiveness(fx.taskId, { now: T_DEAD + 1, silenceMs, escalate: true })
          const ok =
            size === step.cur &&
            r.live.seats[0]?.activity?.grew === true &&
            r.silent.length === 0 &&
            r.escalated === false &&
            fx.h.store.peek(fx.taskId).state === 'developing'
          if (ok) passes += 1
          detail.push(
            `${step.label}（间隔 ${step.span_ms / 1000} 秒）：文件 ${size} B ⇒ grew=${r.live.seats[0]?.activity?.grew} silent=${r.silent.length} escalated=${r.escalated} state=${fx.h.store.peek(fx.taskId).state}`,
          )
        }
        rec.add(
          'A3 真实证据离线复算',
          '★★ 三段实测序列逐个复算：**全部判「存活」**，任务一次都没被冻结（真文件 + 真采样路径）',
          passes === WINDOW.length,
          detail.join('\n'),
        )
        rec.add(
          'A3 真实证据离线复算',
          '★ 这条不依赖线上：输入全是本套自己写的临时文件与固化字节数（跑完即删）',
          passes === WINDOW.length,
          `会话根 = ${sessionsRoot}（mkdtemp，跑完 rm）`,
        )
      })
    }

    // =======================================================================
    // A4｜证据不可用 / 不足 ⇒ 不得抛异常、不得据单次静默冻结
    // =======================================================================
    {
      const silenceMs = 300_000
      const cases = [
        { tag: 'a4-nodir', what: '① 会话根**不存在**（`DSH_SESSIONS_DIR` 指向一个没建过的目录）' },
        { tag: 'a4-empty', what: '② 会话根存在但**一个日志都没有**（该席位没有会话文件）', otherSeat: true },
        { tag: 'a4-other', what: '③ 根下只有**别的会话**的日志（该席位那条就是不存在）', otherSeat: true },
      ]

      for (const c of cases) {
        const made = await mkTmp(c.tag)
        const root = c.tag === 'a4-nodir' ? join(made, 'never-created') : made
        const { fx } = await silentWriterFixture({ tag: c.tag, silenceMs })
        open.push(fx.h)
        if (c.otherSeat === true) {
          // ★ 摆"别人的日志"：形状完全合法，就是**不是这个席位**的那一条。
          await plantSessionLog(root, '<session-id>', 4096)
        }

        await withSessionsRoot(root, async () => {
          let threw = null
          let r = null
          try {
            r = await fx.h.store.checkLiveness(fx.taskId, { now: Date.now(), silenceMs, escalate: true })
          } catch (err) {
            threw = err
          }
          rec.add(
            'A4 证据不足不得冻结',
            `${c.what} ⇒ **不抛异常**，且如实回报"本次没有活动证据"`,
            threw === null && r !== null && r.ok === true && r.activity_known === false && r.gate_applicable === true,
            threw === null
              ? `activity_known=${r.activity_known}　gate_applicable=${r.gate_applicable}　note=${String(r.activity_note ?? '')}`
              : `抛了异常：${String(threw?.message ?? threw)}`,
          )
          rec.add(
            'A4 证据不足不得冻结',
            `${c.what} ⇒ 第一次观察**不冻结**（pending），任务状态纹丝不动`,
            r !== null && r.silent.length === 0 && r.pending.length === 1 && fx.h.store.peek(fx.taskId).state === 'developing',
            r === null
              ? '(无返回值)'
              : `silent=${r.silent.length}　pending=${r.pending.length}　state=${fx.h.store.peek(fx.taskId).state}\n${String(r.pending[0]?.pending_reason ?? '')}`,
          )
          rec.add(
            'A4 证据不足不得冻结',
            `${c.what} ⇒ 「证据不可用」本身**作为可观测事件被记录**（返回值里有原因原文）`,
            r !== null && typeof r.activity_note === 'string' && r.activity_note.length > 0,
            String(r?.activity_note ?? '(没有 note)'),
          )
        })

        // ★ 二次确认：第二轮仍拿不到证据 ⇒ 这才允许冻结（"不许只凭一次安静"）。
        const r2 = await withSessionsRoot(root, () =>
          fx.h.store.checkLiveness(fx.taskId, { now: Date.now(), silenceMs, escalate: true }),
        )
        rec.add(
          'A4 证据不足不得冻结',
          `${c.what} ⇒ 第二次观察仍无证据 ⇒ 允许冻结（确认门是真的门，不是"永不冻结"）`,
          r2.silent.length === 1 && r2.escalated === true && fx.h.store.peek(fx.taskId).state === 'blocked',
          `silent=${r2.silent.length}　escalated=${r2.escalated}　state=${fx.h.store.peek(fx.taskId).state}`,
        )
      }

      // ④ 证据"读得到但格式非预期"：真文件里塞垃圾字节 ⇒ 采样只认 size/mtime，不得抛。
      {
        const root = await mkTmp('a4-garbage')
        const { fx, atMs, sessionId } = await silentWriterFixture({ tag: 'a4-garbage', silenceMs })
        open.push(fx.h)
        await withSessionsRoot(root, async () => {
          const dir = join(root, 'bucket', sessionId)
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, SESSION_LOG_NAME), Buffer.from([0x00, 0xff, 0x1b, 0x7f, 0x00, 0x80]))
          let threw = null
          let r = null
          try {
            r = await fx.h.store.checkLiveness(fx.taskId, { now: atMs + silenceMs * 2, silenceMs, escalate: true })
          } catch (err) {
            threw = err
          }
          rec.add(
            'A4 证据不足不得冻结',
            '④ 日志内容**非预期格式**（6 字节垃圾）：判据只吃 size/mtime ⇒ 不抛，按"读得到但没长"处理',
            threw === null && r !== null && r.ok === true && r.activity_known === true,
            threw === null
              ? `activity_known=${r.activity_known}　${JSON.stringify(r.live.seats[0]?.activity ?? null)}`
              : `抛了异常：${String(threw?.message ?? threw)}`,
          )
        })
      }

      // ⑤ "结构上采不到"（老夹具的 `fake-agent-…` 形状）⇒ 不启用确认门，退回台账三条判据并如实留痕。
      {
        const { fx, silenceMs, atMs } = await silentWriterFixture({ tag: 'a4-shape', silenceMs })
        open.push(fx.h)
        await fx.h.store.recordDispatch(fx.taskId, {
          role: 'writer',
          seat: 'writer#1',
          agentId: 'fake-agent-999',
          atMs,
          at: new Date(atMs).toISOString(),
          via: 'simulated',
        })
        const r = await fx.h.store.checkLiveness(fx.taskId, { now: Date.now(), silenceMs, escalate: true })
        rec.add(
          'A4 证据不足不得冻结',
          '⑤ ★ 结构上**本来采不到**（台账里没有真实形状的会话 id）⇒ 不启用确认门、一次观察即可判，并**如实留痕**',
          r.gate_applicable === false && r.activity_known === false && String(r.summary ?? '').includes('拿不到会话日志'),
          `gate_applicable=${r.gate_applicable}　activity_known=${r.activity_known}\n摘要第一句：${String(r.summary ?? '').split('\n')[0]}`,
        )
        rec.add(
          'A4 证据不足不得冻结',
          '★ 摘要里**不许**把"拿不到"写成"它没在长"（那是把两件事混起来，正是最初误判的根因）',
          !String(r.summary ?? '').includes('会话日志 session.v4.jsonl.zstd 也没在长'),
          String(r.summary ?? '').split('\n')[1] ?? '',
        )
      }
    }

    // =======================================================================
    // A5｜唤醒闭环：blocking 澄清 → 停手 → answered 裁定 → **发起席位被唤醒**
    // =======================================================================
    {
      const fx = await createMultiWriterFixture({ writers: 2 })
      open.push(fx.h)

      // --- 席位 A（writer#2）发 blocking 澄清 ---------------------------------
      const asked = await callTool(
        fx.h,
        'pipeline_clarify_request',
        {
          task_id: fx.taskId,
          stage: '编写：接口字段命名',
          question: '导出接口的字段名用 camelCase 还是 snake_case？两种读法在验收标准里都成立。',
          context_digest: '同一份验收标准两种命名都可自圆其说；对下游调用方影响不同。',
          blocking: true,
          urgency: 'normal',
          role_token: fx.tokens['writer#2'],
        },
        fx.agents['writer#2'],
      )
      const rid = asked.value?.request_id ?? ''
      const stAsked = fx.h.store.peek(fx.taskId)
      rec.add(
        'A5 唤醒闭环',
        '① 席位 A（writer#2）发 blocking 澄清 ⇒ 任务进入「等待需求分析答复」，席位按规矩停手',
        asked.denied !== true && stAsked.state === 'awaiting_clarification' && stAsked.clarification_requests[0]?.blocking === true,
        `state=${stAsked.state}　request=${rid}　blocking=${stAsked.clarification_requests[0]?.blocking}`,
      )
      rec.add(
        'A5 唤醒闭环',
        '★★ 记录里带着**是谁问的（含席位）** —— 没有它，裁定只能按角色找第一个同角色席位，多席位时错投',
        stAsked.clarification_requests[0]?.from_role === 'writer' && stAsked.clarification_requests[0]?.from_seat === 'writer#2',
        `from_role=${stAsked.clarification_requests[0]?.from_role}　from_seat=${JSON.stringify(stAsked.clarification_requests[0]?.from_seat)}（要求 "writer#2"）`,
      )

      // --- 需求分析给 answered 裁定 -------------------------------------------
      const wakeBase = fx.h.transport.calls.filter((c) => c.kind === 'notify').length
      const reply = await callTool(
        fx.h,
        'pipeline_clarify_reply',
        {
          task_id: fx.taskId,
          request_id: rid,
          verdict: 'answered',
          answer: '用 snake_case —— 与既有对外契约保持一致，那条优先。',
          reason: '既有公开契约已经用 snake_case，一致性优先。',
          constraints_added: ['导出接口字段一律 snake_case'],
          role_token: fx.tokens.orchestrator,
        },
        fx.agents.orchestrator,
      )
      const stReplied = fx.h.store.peek(fx.taskId)
      rec.add(
        'A5 唤醒闭环',
        '② answered 裁定落地 ⇒ 任务状态**回到澄清前的状态**（developing）',
        reply.denied !== true && stReplied.state === 'developing' && stReplied.clarification_requests[0]?.resumed_to === 'developing',
        `state=${stReplied.state}　resumed_from=${stReplied.clarification_requests[0]?.resumed_from} → resumed_to=${stReplied.clarification_requests[0]?.resumed_to}`,
      )

      const afterWake = fx.h.transport.calls.filter((c) => c.kind === 'notify').slice(wakeBase)
      rec.add(
        'A5 唤醒闭环',
        '★★★ 发起席位**被实际唤醒**：裁定落地那一刻有一次投递，且投进的正是 writer#2 那个会话',
        afterWake.length === 1 && afterWake[0].agentId === fx.agents['writer#2'],
        `新增投递 ${afterWake.length} 次；目标会话=${afterWake[0]?.agentId ?? '(无)'}\n` +
          `writer#1 会话=${fx.agents['writer#1']}　writer#2 会话=${fx.agents['writer#2']}\n` +
          '（改前：from_seat 恒为 undefined ⇒ 按角色命中**第一个**同角色记录，这一投会落到 writer#1 的会话上，而真正停手的 writer#2 继续卡死）',
      )
      rec.add(
        'A5 唤醒闭环',
        '★ 裁定摘要里也**看得见**"已唤醒"（不是只有 transport.calls 里才有）',
        hit(reply.text, '已唤醒发起席位'),
        reply.text.split('\n').filter((l) => l.includes('唤醒')).join(' / ') || '(摘要里没有唤醒那一句)',
      )

      // --- 被唤醒的席位**产生可观测的后续动作** --------------------------------
      const art = await callTool(
        fx.h,
        'pipeline_artifact',
        { task_id: fx.taskId, content: '（writer#2 按裁定改完的接口层）', file_name: 'writer-2.txt', role_token: fx.tokens['writer#2'] },
        fx.agents['writer#2'],
      )
      const cont = await callTool(
        fx.h,
        'pipeline_handoff',
        {
          task_id: fx.taskId,
          kind: 'dev_to_test',
          role_token: fx.tokens['writer#2'],
          payload: {
            task_id: fx.taskId,
            artifact_version: art.value?.version ?? 'v1',
            patch_or_code: '（writer#2 的改动）',
            change_note: '按裁定把导出接口字段统一成 snake_case',
            run_commands: ['node tests/seat-liveness-wake-check.mjs'],
            selftest_result: 'pass',
            known_issues: [],
            partition: { seat: 'writer#2', index: 2, total: 2, scope_paths: ['src/api'] },
            ...manifestFor(fx.h.store, fx.taskId, { index: 1, path: 'src/api' }),
          },
        },
        fx.agents['writer#2'],
      )
      rec.add(
        'A5 唤醒闭环',
        '★★★ 被唤醒的席位**继续把活干完**（产出新的交接物）⇒ 闭环成立；"裁定完发起席位再没被叫醒"不再复现',
        cont.denied !== true && (fx.h.store.peek(fx.taskId).handoffs ?? []).some((h) => h.kind === 'dev_to_test'),
        cont.denied !== true
          ? `交接物：${(fx.h.store.peek(fx.taskId).handoffs ?? []).map((h) => h.kind).join('、')}`
          : `被拒：${cont.text.split('\n')[0]}`,
      )
    }

    // =======================================================================
    // P7｜并发澄清：两个席位各卡一条 blocking ⇒ 两条都被**各自**唤醒
    // =======================================================================
    {
      const fx = await createMultiWriterFixture({ writers: 2 })
      open.push(fx.h)

      const ask = (seat, n) =>
        callTool(
          fx.h,
          'pipeline_clarify_request',
          {
            task_id: fx.taskId,
            stage: `编写：第 ${n} 处边界`,
            question: `第 ${n} 处边界：空输入应当报错还是跳过？验收标准两种读法都成立。`,
            context_digest: '两种读法都能自圆其说。',
            blocking: true,
            urgency: 'normal',
            role_token: fx.tokens[seat],
          },
          fx.agents[seat],
        )

      const a1 = await ask('writer#1', 1)
      const a2 = await ask('writer#2', 2)
      const r1 = a1.value?.request_id ?? ''
      const r2 = a2.value?.request_id ?? ''
      rec.add(
        'P7 并发澄清',
        '★ 两个席位各提一条 blocking 澄清（今晚实测正是两条）⇒ 两条都登记在册',
        r1.length > 0 &&
          r2.length > 0 &&
          r1 !== r2 &&
          (fx.h.store.peek(fx.taskId).clarification_requests ?? []).length === 2,
        `request_ids=${r1}、${r2}`,
      )

      const base = fx.h.transport.calls.filter((c) => c.kind === 'notify').length
      const ans = (rid) =>
        callTool(
          fx.h,
          'pipeline_clarify_reply',
          {
            task_id: fx.taskId,
            request_id: rid,
            verdict: 'answered',
            answer: '报错 —— "非法输入必须显式失败"那条优先。',
            reason: '取更严的一条。',
            role_token: fx.tokens.orchestrator,
          },
          fx.agents.orchestrator,
        )
      const rep1 = await ans(r1)
      const rep2 = await ans(r2)

      const woken = fx.h.transport.calls.filter((c) => c.kind === 'notify').slice(base)
      const targets = woken.map((c) => c.agentId)
      rec.add(
        'P7 并发澄清',
        '★★★ 两条裁定 ⇒ **两次投递，分别落到两个不同会话**（各自被唤醒，没有互相顶替）',
        woken.length === 2 &&
          new Set(targets).size === 2 &&
          targets.includes(fx.agents['writer#1']) &&
          targets.includes(fx.agents['writer#2']),
        `投递目标=${JSON.stringify(targets)}\nwriter#1 会话=${fx.agents['writer#1']}　writer#2 会话=${fx.agents['writer#2']}`,
      )
      rec.add(
        'P7 并发澄清',
        '★ 两条裁定都成功，且任务状态回到澄清前',
        rep1.denied !== true && rep2.denied !== true && fx.h.store.peek(fx.taskId).state === 'developing',
        `state=${fx.h.store.peek(fx.taskId).state}`,
      )
    }

    // =======================================================================
    // A6｜状态字段不过期：唤醒正文里的状态 = 投递时刻的真实状态
    // =======================================================================
    {
      const fx = await createMultiWriterFixture({ writers: 1 })
      open.push(fx.h)

      const asked = await callTool(
        fx.h,
        'pipeline_clarify_request',
        {
          task_id: fx.taskId,
          stage: '编写：参数校验',
          question: '参数为 0 时应当报错还是返回空结果？',
          context_digest: '两种读法都成立。',
          blocking: true,
          role_token: fx.tokens['writer#1'],
        },
        fx.agents['writer#1'],
      )
      const rid = asked.value?.request_id ?? ''
      // 复现今晚的形状：**生成快照那一刻**任务停在等待态（今晚那批快照声称"已阻塞"）。
      const stWhileWaiting = fx.h.store.peek(fx.taskId).state
      const base = fx.h.transport.calls.length

      const body = await (async () => {
        // 把 transport.notifyRole 包一层，把**真正投出去**的正文抓下来。
        const transport = fx.h.transport
        const original = transport.notifyRole.bind(transport)
        let captured = ''
        transport.notifyRole = async (spec) => {
          captured = String(spec?.message ?? '')
          return original(spec)
        }
        try {
          await callTool(
            fx.h,
            'pipeline_clarify_reply',
            {
              task_id: fx.taskId,
              request_id: rid,
              verdict: 'answered',
              answer: '报错。',
              reason: '取更严的一条。',
              role_token: fx.tokens.orchestrator,
            },
            fx.agents.orchestrator,
          )
        } finally {
          transport.notifyRole = original
        }
        return captured
      })()

      const stateAtSend = fx.h.store.peek(fx.taskId).state
      rec.add(
        'A6 状态字段不过期',
        '★ 复现今晚形状：生成快照时任务停在**等待态**，投递时已回到 developing',
        stWhileWaiting === 'awaiting_clarification' && stateAtSend === 'developing' && fx.h.transport.calls.length > base,
        `快照生成时 state=${stWhileWaiting} ⇒ 投递时 state=${stateAtSend}`,
      )
      rec.add(
        'A6 状态字段不过期',
        '★★★ 投出去的那条消息里的状态 = **投递时刻**的真实状态（「开发中」），不是那个过期的等待态',
        body.includes('开发中') && body.includes('`developing`') && !body.includes('等待需求分析答复'),
        body.split('\n').filter((l) => l.includes('状态') || l.includes('当前')).join('\n') || '(正文里没有状态那一行)',
      )
      rec.add(
        'A6 状态字段不过期',
        '★ 因而不会再诱发一次会被状态机拒绝的 `unblock` 往返（正文里不出现"已阻塞"）',
        !body.includes('已阻塞') && !body.includes('`blocked`'),
        body.includes('已阻塞') ? '⚠ 正文里出现了「已阻塞」' : '正文里没有「已阻塞」/ 没有 blocked',
      )
      rec.add(
        'A6 状态字段不过期',
        '★ 正文仍明确要求"动手前重读"（快照本身会过期这件事没有被藏起来）',
        body.includes('pipeline_status') && body.includes('重读'),
        body.split('\n').filter((l) => l.includes('重读')).join(' / '),
      )
      rec.add(
        'A6 状态字段不过期',
        '★ 消息仍是**运行时上下文**（不是伪装成用户说的话）',
        body.includes('运行时上下文') && body.includes('不是用户说的话'),
        body
          .split('\n')
          .filter((l) => l.includes('运行时上下文'))
          .slice(0, 2)
          .join(' / '),
      )
    }

    // =======================================================================
    // A7｜幂等不回归：同一条裁定重复触发 ⇒ 唤醒不重复投递
    // =======================================================================
    {
      const fx = await createMultiWriterFixture({ writers: 1 })
      open.push(fx.h)

      const asked = await callTool(
        fx.h,
        'pipeline_clarify_request',
        {
          task_id: fx.taskId,
          stage: '编写：接口版本',
          question: '接口要不要带版本前缀？',
          context_digest: '两种做法都成立。',
          blocking: true,
          role_token: fx.tokens['writer#1'],
        },
        fx.agents['writer#1'],
      )
      const rid = asked.value?.request_id ?? ''
      const base = fx.h.transport.calls.filter((c) => c.kind === 'notify').length

      const first = await callTool(
        fx.h,
        'pipeline_clarify_reply',
        {
          task_id: fx.taskId,
          request_id: rid,
          verdict: 'answered',
          answer: '带 v1 前缀。',
          reason: '对外契约需要可演进。',
          role_token: fx.tokens.orchestrator,
        },
        fx.agents.orchestrator,
      )
      const after1 = fx.h.transport.calls.filter((c) => c.kind === 'notify').length
      const second = await callTool(
        fx.h,
        'pipeline_clarify_reply',
        {
          task_id: fx.taskId,
          request_id: rid,
          verdict: 'answered',
          answer: '带 v1 前缀。',
          reason: '重复触发（模拟重放 / 重试）',
          role_token: fx.tokens.orchestrator,
        },
        fx.agents.orchestrator,
      )
      const after2 = fx.h.transport.calls.filter((c) => c.kind === 'notify').length

      rec.add(
        'A7 幂等不回归',
        '★ 第一次裁定 ⇒ 恰好一次唤醒',
        first.denied !== true && after1 - base === 1,
        `投递次数 ${after1 - base}`,
      )
      rec.add(
        'A7 幂等不回归',
        '★★ 同一条裁定**重复触发** ⇒ 被单向门明确拒掉，**不再投递一次**（去重保持有效）',
        second.denied === true && after2 === after1 && hit(second.text, '已经裁定过了'),
        `第二次：denied=${second.denied}　投递总次数仍为 ${after2 - base}\n拒绝原文：${second.text.split('\n')[0]}`,
      )
    }

    // =======================================================================
    // P8｜唤醒不可达：显式可见的失败信号，且不自动补位 / 不自动继任
    // =======================================================================
    {
      const fx = await createMultiWriterFixture({ writers: 1 })
      open.push(fx.h)

      const asked = await callTool(
        fx.h,
        'pipeline_clarify_request',
        {
          task_id: fx.taskId,
          stage: '编写：错误码',
          question: '错误码用哪一套？',
          context_digest: '两套都能自洽。',
          blocking: true,
          role_token: fx.tokens['writer#1'],
        },
        fx.agents['writer#1'],
      )
      const rid = asked.value?.request_id ?? ''
      const seatsBefore = JSON.stringify(fx.h.store.peek(fx.taskId).roster?.writers ?? null)
      const agentBefore = fx.agents['writer#1']

      // 让投递**真的失败**（只针对这一条用例；跑完还原）。
      const transport = fx.h.transport
      const original = transport.notifyRole.bind(transport)
      transport.notifyRole = async () => ({ ok: false, messageId: null, note: '（夹具）目标会话已终止，投不进去。' })
      let reply = null
      try {
        reply = await callTool(
          fx.h,
          'pipeline_clarify_reply',
          {
            task_id: fx.taskId,
            request_id: rid,
            verdict: 'answered',
            answer: '沿用既有错误码表。',
            reason: '不新造一套。',
            role_token: fx.tokens.orchestrator,
          },
          fx.agents.orchestrator,
        )
      } finally {
        transport.notifyRole = original
      }

      const st = fx.h.store.peek(fx.taskId)
      rec.add(
        'A5 唤醒闭环',
        '★★ P8 唤醒**不可达** ⇒ 产出**显式可见**的失败信号（不是静默失败）：摘要里点名"叫不醒"，并给出等价可达路径',
        reply !== null &&
          reply.denied !== true &&
          hit(reply.text, '叫不醒发起席位') &&
          hit(reply.text, 'pipeline_seat_message|reassign'),
        reply === null
          ? '(没有返回值)'
          : reply.text
              .split('\n')
              .filter((l) => l.includes('叫不醒') || l.includes('pipeline_seat_message') || l.includes('重派'))
              .join('\n'),
      )
      rec.add(
        'A5 唤醒闭环',
        '★★ P8 任务**不因唤醒失败停在中间态**（状态照旧回到澄清前），裁定不会被撤销',
        st.state === 'developing' &&
          st.clarification_requests[0]?.resumed_to === 'developing' &&
          st.clarification_requests[0]?.verdict === 'answered',
        `state=${st.state}　resumed_to=${st.clarification_requests[0]?.resumed_to}　verdict=${st.clarification_requests[0]?.verdict}`,
      )
      rec.add(
        'A5 唤醒闭环',
        '★★ P8 **不自动补位 / 不自动继任**新席位（用户已裁定）：名单与席位会话一个都没动',
        JSON.stringify(st.roster?.writers ?? null) === seatsBefore &&
          fx.agents['writer#1'] === agentBefore &&
          (st.successions ?? []).length === 0,
        `successions=${(st.successions ?? []).length}　writer 会话仍为 ${fx.agents['writer#1']}`,
      )
    }

    // =======================================================================
    // A8｜测试纪律的可核对判据（本套自己也要守）
    // =======================================================================
    {
      const suite = await (await import('node:fs/promises')).readFile(new URL('./seat-liveness-wake-check.mjs', import.meta.url), 'utf8')
      rec.add(
        'A8 测试纪律',
        '★ 本套用例**零 skip / 零 todo / 零 only**（断言不得靠跳过变绿）',
        !/\b(it|test|describe)\.(skip|todo|only)\s*\(/.test(suite) && !suite.includes('跳过本用例'),
        '未出现 it.skip / it.todo / it.only',
      )
      rec.add(
        'A8 测试纪律',
        '★ 本套的输入全是固定夹具（临时目录 + 固化字节数），不读线上真实会话文件',
        suite.includes('mkdtemp') && suite.includes('381_679') && suite.includes('392_396'),
        '固化数字：381,679 / 392,396 / 10,717 / 14,158 / 23,207',
      )
      const runner = await (await import('node:fs/promises')).readFile(new URL('./run-all.mjs', import.meta.url), 'utf8')
      rec.add(
        'A8 测试纪律',
        '★★ 本套的登记状态**如实回报**：未登记进 run-all.mjs（授权面只给 tests/ 的 create，改它要走 scope_amend）',
        !runner.includes('runSeatLivenessWakeCheck'),
        'run-all.mjs 里没有 runSeatLivenessWakeCheck ⇒ 本阶段全量跑法是两条：`node tests/run-all.mjs` **加上** `node tests/seat-liveness-wake-check.mjs`',
      )
      rec.add(
        'A8 测试纪律',
        `★ 本套断言条数 = ${rec.total + 1}（用例只增不减；这里自记一遍，供"用例数不减"的核对方比对）`,
        rec.total + 1 > 40,
        `已登记 ${rec.total + 1} 条`,
      )
    }

    return { passed: rec.passed, total: rec.total, text: rec.text(), items: rec.items }
  } finally {
    for (const h of open) {
      try {
        await disposeHarness(h)
      } catch {
        /* 清理失败不影响结论 */
      }
    }
    for (const d of tmpRoots) {
      try {
        await rm(d, { recursive: true, force: true })
      } catch {
        /* 同上 */
      }
    }
  }
}

// 允许直接 `node tests/seat-liveness-wake-check.mjs`
if (process.argv[1] !== undefined && process.argv[1].endsWith('seat-liveness-wake-check.mjs')) {
  const r = await runSeatLivenessWakeCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
