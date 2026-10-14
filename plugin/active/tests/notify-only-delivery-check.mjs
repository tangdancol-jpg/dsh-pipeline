/**
 * dsh-pipeline · tests/notify-only-delivery-check.mjs
 * ============================================================================
 * **只传话、不派活的投递面**（P0-2：递给宿主的 `signal` 不许是 `undefined`）
 *   —— `pipeline_dispatch { notify_only: true }` 真的投得出去
 *
 * 现场（修复前的真 bug；本套就是它的**回归锁**）：
 *   宿主 `ctx.sessionController.prompt(request, signal)` 的 `signal` 是**非可选**参数，
 *   第一句就是裸的 `signal.throwIfAborted()`。而通知路径**结构上没有** signal ——
 *   `lib/tools.js` 的 `nudgeSeat` 调 `transport.notifyRole({ task, roster, role, seat,
 *   sessionId, message })`，报文里根本没有 `signal` 这个字段；旧代码把它原样递下去 ⇒
 *   宿主抛 `Cannot read properties of undefined (reading 'throwIfAborted')` ⇒
 *   **席位永远叫不醒**（裁定 / 答复落地了，发起席收不到任何东西，每一轮澄清都要重派席位）。
 *   修复：没有调用方 signal 时递一枚「永不中止」的 signal（语义 = 调用方没有请求取消）。
 *
 * 纪律（本套自己遵守的三条）：
 *   · **只用真件**：真 `SessionTransport` + 真 `createSeatNotifier` + 真
 *     `createWakeLedger`（指向**临时**文件）。不用假通道替身，也**不用**
 *     `SimulatedTransport` 做投递断言 —— 它根本不碰 `sessionController.prompt`，
 *     拿它测这条 bug 会永远绿（"测不到"冒充"测过了"）。
 *   · **自建夹具**：在自己的临时目录里现造 `.pipeline/<自造任务 id>/task.json`
 *     + 临时账本文件 + 临时审计文件，跑完 `rm`。**不读任何真实任务单**
 *     （不看 `.pipeline/T-*`）、不依赖任何在跑的插件进程 —— 那正是
 *     `tests/orphan-rescue-check.mjs` 随机变红的成因（它读活任务 id），不重蹈。
 *   · **宿主替身逐字照抄契约**：服务只经 `ctx.get('sessionController')` 取；
 *     `prompt(request, signal)` 的第一句是**裸的** `signal.throwIfAborted()`。
 *     所以"递 undefined"在这里会**真的**抛成宿主那个 TypeError —— P3 锁的就是这件事。
 *
 * 判据分组：
 *   【P】正例：投得出去 / 投递真的走了宿主 prompt / 账本留痕 / **signal 是 defined**
 *             / 调用方真中止时仍然 ok:false（"没有 signal" ≠ "永不取消"）
 *   【N】反例：四条，每条 `ok:false` 且**理由对得上**（不是笼统的"不行"）
 *   【V】看得见的失败：失败一律走**返回值**（一条都不 reject）+ 成败都留痕
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * @module dsh-pipeline/tests/notify-only-delivery-check
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSeatNotifier } from '../lib/tools.js'
import { SessionTransport } from '../lib/transport/index.js'
import { createWakeLedger } from '../lib/wakeledger.js'

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
      L.push('dsh-pipeline · 只传话不派活（notify_only 投递面：递给宿主的 signal 不许是 undefined）')
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

/** 一句原文里有没有那些要点（拒绝要**指名**，不能只说"不行"）。 */
const says = (text, ...needles) => needles.every((n) => String(text ?? '').includes(n))

/**
 * **宿主替身 —— 逐字照抄宿主契约**（本套唯一的"假"东西，假的是宿主，不是被测件）：
 *   · 服务只经 `ctx.get(name)` 取（宿主的安全读法：拿不到返回 undefined，不抛）；
 *   · `prompt(request, signal)` 的 `signal` 是**非可选**参数，第一句是**裸的**
 *     `signal.throwIfAborted()` —— 与宿主源码同形。
 * ⇒ 一旦投递方递 `undefined`，这里会真的抛出宿主那个
 *   `Cannot read properties of undefined (reading 'throwIfAborted')`，而不是被悄悄兜住。
 *
 * @param {{controller?:boolean, promptError?:Error|null}} [opts]
 * @returns {{ctx:object, services:object, received:Array<{request:object, signal:AbortSignal}>}}
 */
function hostDouble(opts = {}) {
  const controller = opts.controller !== false
  const promptError = opts.promptError ?? null
  /** 宿主真正收到过什么（P3 读它；**记在裸 deref 之后** —— deref 先抛就说明递了 undefined）。 */
  const received = []
  const services = {}
  if (controller) {
    services.sessionController = {
      async prompt(request, signal) {
        signal.throwIfAborted()
        received.push({ request, signal })
        if (promptError !== null) throw promptError
        return { accepted: true }
      },
    }
  }
  return { ctx: { get: (name) => services[name] }, services, received }
}

export async function runNotifyOnlyDeliveryCheck() {
  const rec = createRecorder()
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-pipeline-notify-only-'))
  try {
    await drive(tmp, rec)
  } catch (err) {
    // 夹具执行中途抛异常**不许静默**：如实记一条 ✗ 并把原文留在 detail 里。
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 5).join('\n'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

async function drive(tmp, rec) {
  // =========================================================================
  // 夹具：**本套自己造**的任务目录 + 账本 + 审计出口，全部落在自己建的临时目录里。
  // =========================================================================
  const TASK_ID = 'T-FIXTURE-NOTIFYONLY-0001'
  const SESSION = { writer1: 'sess-fixture-writer-1', writer2: 'sess-fixture-writer-2' }
  const taskDir = join(tmp, '.pipeline', TASK_ID)
  mkdirSync(taskDir, { recursive: true })
  const taskFile = join(taskDir, 'task.json')
  writeFileSync(
    taskFile,
    `${JSON.stringify(
      {
        id: TASK_ID,
        state: 'developing',
        requirement: '夹具单（本套自建；自始至终不指向任何真实任务）',
        dispatched: [
          // ① 正常席位：台账里有会话 id（P1 / P2 / P3 / P4 用）
          { role: 'writer', seat: 'writer#1', session_id: SESSION.writer1, agent_id: '' },
          // ② 通道侧反例用（N3 服务不可用 / N4 宿主抛错）
          { role: 'writer', seat: 'writer#2', session_id: SESSION.writer2, agent_id: '' },
          // ③ 台账有这一条、但**没有会话 id**（N2 用）
          { role: 'tester', seat: null, session_id: '', agent_id: '' },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  /** ★ 投递用的 task 就是从这颗临时文件里**读回来**的（不是凭空捏的对象）。 */
  const task = JSON.parse(readFileSync(taskFile, 'utf8'))

  /** 审计出口：形状与真 store 的 `audit()` 同源（`{ at, task_id, actor, action, ...detail }` 一行一个 JSON）。 */
  const auditFile = join(taskDir, 'audit.jsonl')
  const store = {
    async recordAudit(taskId, actor, action, detail) {
      appendFileSync(auditFile, `${JSON.stringify({ at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), task_id: taskId, actor, action, ...detail })}\n`, 'utf8')
      return { ok: true }
    },
  }

  /** 真账本，指向**临时**文件（`createWakeLedger` 首次运行会自己建它，跑完随 tmp 一起删）。 */
  const ledgerFile = join(tmp, 'wake-ledger.jsonl')
  const ledger = createWakeLedger({ file: ledgerFile })
  /** 与 `lib/wakeup.js` 的 `noteSeatDelivery(spec)` 同形：原样交给账本。 */
  const wakeup = { noteSeatDelivery: (spec = {}) => ledger.recordSeatDelivery(spec) }

  /** 宿主替身 + **真**通道 + **真**席位投递器（三者一一对应，免得不小心串台）。 */
  function freshNotifier(opts = {}) {
    const host = hostDouble(opts)
    /** ★ 通道侧的 audit 出口：`notifyRole` 本身不落审计，这里按构造契约把它给全。 */
    const channelAudit = []
    const transport = new SessionTransport({ ctx: host.ctx, config: {}, audit: (e) => channelAudit.push(e) })
    const notifier = createSeatNotifier({ store, transport, wakeup })
    return { host, transport, channelAudit, notifier }
  }

  /** 调一次投递：**不许 reject**（真 reject 也记下来 —— V 组判"看得见的失败"）。 */
  const rejections = []
  let callCount = 0
  async function call(label, fn) {
    callCount += 1
    try {
      return { rejected: false, value: await fn() }
    } catch (err) {
      rejections.push(`${label} → ${String(err?.message ?? err)}`)
      return { rejected: true, value: null }
    }
  }

  /** 账本**读盘**（不是读内存镜像）："真的写了一行"才是判据。 */
  function seatRows(key) {
    if (!existsSync(ledgerFile)) return []
    return readFileSync(ledgerFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return { t: '(解析不了)', raw: l.slice(0, 120) }
        }
      })
      .filter((e) => e.t === 'seat-wake' && e.key === key)
  }
  const lastSeatRow = (key) => seatRows(key).slice(-1)[0] ?? null

  const KEY_W1 = `${TASK_ID}|notify|seat:writer#1|`
  const KEY_REVIEWER = `${TASK_ID}|notify|seat:reviewer|`

  // =========================================================================
  // 【P】正例：投得出去 + 递给宿主的 signal 是 defined（这条 bug 的回归锁）
  // =========================================================================
  {
    const w1 = freshNotifier()
    const p1 = await call('P1 notifyOnly(writer#1)', () => w1.notifier.notifyOnly(task, 'writer', 'writer#1', '夹具：请继续手上的活（P1）', false))
    rec.add(
      'P 正例',
      '★★ 台账里有会话 id ⇒ **投得出去**（ok:true）且 sessionId 就是台账里那一个',
      p1.rejected === false && p1.value.ok === true && p1.value.sessionId === SESSION.writer1,
      p1.rejected ? '★ 被 reject 了' : JSON.stringify(p1.value),
    )

    const got = w1.host.received[0] ?? null
    const req = got?.request ?? null
    const body = Array.isArray(req?.content) ? String(req.content[0]?.text ?? '') : ''
    rec.add(
      'P 正例',
      '★ 投递**真的**走了宿主的 `sessionController.prompt`（会话 id / mode / 正文都对得上）',
      w1.host.received.length === 1 && req?.sessionId === SESSION.writer1 && req?.mode === 'queue' && says(body, '夹具：请继续手上的活（P1）') && says(body, TASK_ID),
      `宿主收到 ${w1.host.received.length} 次 prompt；sessionId=${String(req?.sessionId)} mode=${String(req?.mode)} 正文 ${body.length} 字`,
    )

    const row = lastSeatRow(KEY_W1)
    rec.add(
      'P 正例',
      '★★ 同一次投递在**账本**（真 createWakeLedger，落临时文件）里留了一行，键 = `<任务>|notify|seat:<角色#席位>|`，ok:true',
      row !== null && row.ok === true,
      `期望键 ${KEY_W1}；实得 ${row === null ? '(没有这一行)' : JSON.stringify(row)}`,
    )
    rec.add(
      'P 正例',
      '★ 账本那一行带着**投给谁**（role / seat / session —— 事后能回答"这条投到哪个会话去了"）',
      row !== null && row.role === 'writer' && row.seat === 'writer#1' && row.session === SESSION.writer1,
      JSON.stringify(row === null ? null : { role: row.role, seat: row.seat, session: row.session, kind: row.kind }),
    )

    // ---- P3：这条 bug 的**回归锁** -------------------------------------------------
    const sig = got?.signal
    rec.add(
      'P 正例',
      '★★ **回归锁**：递给宿主的 signal 是 **defined** 的（不是 undefined / null），且带 `throwIfAborted`',
      w1.host.received.length === 1 && sig !== undefined && sig !== null && typeof sig.throwIfAborted === 'function',
      `宿主收到 ${w1.host.received.length} 次 prompt（递 undefined 时这里是 0 —— 裸 deref 先抛）；signal=${sig === undefined ? 'undefined' : sig === null ? 'null' : `AbortSignal(aborted=${String(sig.aborted)})`}`,
    )
    rec.add(
      'P 正例',
      '★ 投递话术里**不再出现** `throwIfAborted`（那是旧 bug 的症状，不许回潮）',
      p1.rejected === false && p1.value.ok === true && !says(p1.value.note, 'throwIfAborted'),
      p1.rejected ? '★ 被 reject 了' : String(p1.value?.note ?? ''),
    )
  }

  // =========================================================================
  // 【P】调用方**真**中止时仍然如实失败（"没有 signal" ≠ "永不取消"）
  // =========================================================================
  {
    const ctl = new AbortController()
    ctl.abort()
    const w4 = freshNotifier()
    const r4 = await call('P4 notifyRole(signal 已中止)', () =>
      w4.transport.notifyRole({ task, roster: task.roster, role: 'writer', seat: 'writer#1', sessionId: SESSION.writer1, message: '夹具：P4', signal: ctl.signal }),
    )
    rec.add(
      'P 正例',
      '★★ 通道层：调用方给的 signal **已中止** ⇒ 仍然 `ok:false` + 「投递失败：」（真取消没被吞掉 —— 修的是"没 signal"，不是"永不取消"）',
      r4.rejected === false && r4.value.ok === false && says(r4.value.note, '投递失败：'),
      r4.rejected ? '★ 被 reject 了' : `宿主 prompt 被走到 ${w4.host.received.length} 次（中止应发生在它第一句之前）；${JSON.stringify(r4.value)}`,
    )
  }

  // =========================================================================
  // 【N】反例：每条 ok:false，且**理由对得上**（不是笼统的"不行"）
  // =========================================================================
  {
    // ---- N1：台账里没有这个席位 -------------------------------------------------
    const n1 = freshNotifier()
    const r1 = await call('N1 notifyOnly(reviewer)', () => n1.notifier.notifyOnly(task, 'reviewer', null, '夹具：N1', false))
    rec.add(
      'N 反例',
      '★★ 台账里**没有**这个角色/席位 ⇒ ok:false，理由指名「派活台账里没有」（且不是"N2 那句"）',
      r1.rejected === false && r1.value.ok === false && says(r1.value.note, '派活台账里没有') && !says(r1.value.note, '没有会话 id'),
      r1.rejected ? '★ 被 reject 了' : String(r1.value?.note ?? ''),
    )
    rec.add(
      'N 反例',
      '★ 投不出去**也留痕**：账本里那一行 ok:false，键还是同一个形状（失败不留白）',
      (() => {
        const row = lastSeatRow(KEY_REVIEWER)
        return row !== null && row.ok === false
      })(),
      `期望键 ${KEY_REVIEWER}；实得 ${JSON.stringify(lastSeatRow(KEY_REVIEWER))}`,
    )

    // ---- N2：台账有这一条，但没有会话 id ----------------------------------------
    const n2 = freshNotifier()
    const r2 = await call('N2 notifyOnly(tester)', () => n2.notifier.notifyOnly(task, 'tester', null, '夹具：N2', false))
    rec.add(
      'N 反例',
      '★★ 台账有这一条、但 `session_id` / `agent_id` 都是空的 ⇒ ok:false，理由指名「没有会话 id」',
      r2.rejected === false && r2.value.ok === false && says(r2.value.note, '没有会话 id') && r2.value.sessionId === null,
      r2.rejected ? '★ 被 reject 了' : String(r2.value?.note ?? ''),
    )

    // ---- N3：sessionController 服务不可用 ---------------------------------------
    const n3 = freshNotifier({ controller: false })
    const r3 = await call('N3 notifyOnly(sessionController 不可用)', () => n3.notifier.notifyOnly(task, 'writer', 'writer#2', '夹具：N3', false))
    rec.add(
      'N 反例',
      '★★ `sessionController` 服务不可用 ⇒ ok:false，理由指名「不可用」（并点名是哪个服务）',
      r3.rejected === false && r3.value.ok === false && says(r3.value.note, '不可用') && says(r3.value.note, 'sessionController'),
      r3.rejected ? '★ 被 reject 了' : String(r3.value?.note ?? ''),
    )

    // ---- N4：宿主 prompt 抛普通 Error -------------------------------------------
    const HOST_ERR = new Error('宿主拒绝了这次投递（夹具）')
    const n4 = freshNotifier({ promptError: HOST_ERR })
    const r4 = await call('N4 notifyOnly(宿主抛错)', () => n4.notifier.notifyOnly(task, 'writer', 'writer#2', '夹具：N4', false))
    rec.add(
      'N 反例',
      '★★ 宿主 `prompt` 抛普通 Error ⇒ ok:false，理由以「投递失败：」开头且**带上抛出的原话**',
      r4.rejected === false && r4.value.ok === false && String(r4.value.note).startsWith('投递失败：') && says(r4.value.note, HOST_ERR.message),
      r4.rejected ? '★ 被 reject 了' : String(r4.value?.note ?? ''),
    )
  }

  // =========================================================================
  // 【V】看得见的失败：失败走**返回值**（不抛）+ 成败都留痕
  // =========================================================================
  {
    rec.add(
      'V 看得见的失败',
      '★★ 四条反例 + 已中止那条**全部以返回值形态失败**：一条都没有 reject（"看得见的失败"契约）',
      rejections.length === 0,
      rejections.length === 0 ? `${callCount} 次投递调用，0 次 reject` : rejections.join('\n'),
    )

    const auditLines = existsSync(auditFile)
      ? readFileSync(auditFile, 'utf8')
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .map((l) => {
            try {
              return JSON.parse(l)
            } catch {
              return { action: '(解析不了)' }
            }
          })
      : []
    const actions = auditLines.map((e) => String(e.action ?? ''))
    rec.add(
      'V 看得见的失败',
      '★★ 投递的**成败都落审计**（append 到临时任务目录的 `audit.jsonl`）：`seat:wake-delivered` / `seat:wake-failed`',
      actions.includes('seat:wake-delivered') && actions.includes('seat:wake-failed') && auditLines.every((e) => e.task_id === TASK_ID),
      `共 ${auditLines.length} 行，动作：${[...new Set(actions)].join('、')}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 直接跑：`node tests/notify-only-delivery-check.mjs`
//
// 形状照抄同目录的兄弟（`dispatch-channel-check.mjs` / `gate-states-check.mjs`
// 等 30 余份用的是同一段）：
//   · 只在**本文件被直接执行**时跑一遍、打印与 run-all 同源的汇总、并给出退出码；
//   · 被 `run-all.mjs` import 时**不产生任何副作用**。
// ---------------------------------------------------------------------------
if (process.argv[1] !== undefined && /notify-only-delivery-check\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const r = await runNotifyOnlyDeliveryCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
