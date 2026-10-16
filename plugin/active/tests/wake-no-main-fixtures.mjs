/**
 * dsh-pipeline · 唤醒「找不到主对话会话」两条自测的**共享夹具**
 * ============================================================================
 *     （**不是测试文件本身** —— `run-all` 刻意不登记它：它没有断言。）
 *
 * 为什么单独一个文件：`CONVENTIONS.md` 的「单个测试文件 ≤ 400 行」＋「一测试一文件」——
 * 原先把五组断言塞进一个 403 行的 `wake-no-main-check.mjs`，超限。
 * 拆开后两条测试各自只测一件事：
 *   ① **不许静默 / 待领账本** ⇒ `tests/wake-pending-check.mjs`
 *   ② **兜底解析与幂等**       ⇒ `tests/wake-last-resort-check.mjs`
 * 它们共用的临时目录 scope、假宿主、现场同形台账、唤醒器装配放在这里，
 * 免得各抄一份（抄两份就等于两处会漂移的判据）。
 * 同一形状的先例：`tests/switch-fixtures.mjs`、`tests/roster-fixtures.mjs`。
 *
 * ★ 本文件**不含任何断言** —— 断言全在上面那两个 `*-check.mjs` 里。
 *
 * @module dsh-pipeline/tests/wake-no-main-fixtures
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createMainSessionRegistry, createWaker } from '../lib/wakeup.js'

// ---------------------------------------------------------------------------
// 临时目录：每次 `dir()` 建一个全新的；`cleanup()` 只清**本 scope** 建的那些。
//
//   为什么做成一等 scope 而不是模块级数组：两条测试跑在**同一个进程**里
//   （`run-all` 逐个 import），模块级数组会让先跑完的那条把后一条正在用的目录删掉。
// ---------------------------------------------------------------------------

/**
 * @param {string} tag - 目录名前缀标记（便于在 %TEMP% 里认出来源）
 * @returns {{dir:(name:string)=>string, cleanup:()=>void}}
 */
export function makeTmpScope(tag) {
  const roots = []
  return {
    dir(name) {
      const d = mkdtempSync(join(tmpdir(), `dsh-nomain-${tag}-${name}-`))
      roots.push(d)
      return d
    },
    cleanup() {
      for (const d of roots.splice(0)) {
        try {
          rmSync(d, { recursive: true, force: true })
        } catch {
          /* 临时目录清理失败不影响结论 */
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 记录与报告
// ---------------------------------------------------------------------------

export function createRecorder() {
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
  }
}

/** 把一条测试的结论渲染成统一形状（沿用拆分前那套输出格式，逐字不变）。 */
export function renderReport(title, rec) {
  const lines = [title]
  let group = ''
  for (const it of rec.items) {
    if (it.group !== group) {
      group = it.group
      lines.push(`\n== ${group} ==`)
    }
    lines.push(`  ${it.pass ? '✅' : '❌'} ${it.name}`)
    if (it.pass !== true) lines.push(`        → ${it.detail}`)
  }
  lines.push(`\n断言：${rec.passed}/${rec.total} 通过`)
  const failed = rec.items.filter((i) => !i.pass)
  if (failed.length > 0) {
    lines.push('\n失败明细：')
    for (const f of failed) lines.push(`  ❌ [${f.group}] ${f.name}\n     ${f.detail}`)
  }
  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: [...rec.items] }
}

/**
 * 直接 `node tests/xxx-check.mjs` 时的收尾（打印报告 + 退出码 = 结论）。
 *
 * ★ `metaUrl` **必须传调用方自己的** `import.meta.url`：本函数住在夹具文件里，
 *   拿夹具文件的 URL 去比 `process.argv[1]` 永远不相等 ⇒ 直接跑会一声不响什么都不做。
 *   （同一个坑 `switch-fixtures.mjs` 里已经记过一次。）
 *
 * ★ `cleanup` 由调用方给：它要在**抛异常时也执行**，所以挂 `.finally`。
 *
 * @param {Function} run - 测试入口
 * @param {string} metaUrl - 调用方自己的 `import.meta.url`
 * @param {Function} [cleanup] - 收尾（清临时目录）
 */
export function runDirect(run, metaUrl, cleanup) {
  if (process.argv[1] === undefined || metaUrl !== pathToFileURL(process.argv[1]).href) return
  run()
    .then((r) => {
      console.log(r.text)
      if (r.passed !== r.total) process.exitCode = 1
    })
    .catch((err) => {
      console.error('[wake-no-main] 内部异常（这是用例自身的 bug，请修用例）：', err)
      process.exitCode = 1
    })
    .finally(() => {
      if (typeof cleanup === 'function') cleanup()
    })
}

// ---------------------------------------------------------------------------
// 假宿主与台账夹具
// ---------------------------------------------------------------------------

/** 假宿主：只要能"看见投递"就够（与线上同形：`agents.followup` 优先）。 */
export function fakeHost() {
  const delivered = []
  const sessions = new Map()
  const ensure = (id) => {
    if (!sessions.has(id)) {
      sessions.set(id, {
        id,
        inbox: { nextTurn: [], nextStep: [] },
        followup(msg) {
          this.inbox.nextTurn.push(msg)
          delivered.push({ sessionId: id, message: msg })
        },
      })
    }
    return sessions.get(id)
  }
  return {
    ensure,
    delivered,
    ctx: {
      logger: { info() {}, warn() {}, debug() {} },
      get: (name) => (name === 'agents' ? { get: (id) => sessions.get(id) ?? undefined } : undefined),
    },
  }
}

/** 假 audit：收集落痕（断言"可见落点"就靠它）。 */
export function auditSink() {
  const lines = []
  return { lines, audit: async (taskId, action, detail) => lines.push({ taskId, action, detail }) }
}

export function seedTask(over = {}) {
  return { id: 'T-NOMAIN-1', state: 'awaiting_human', handoffs: [], human_requests: [], history: [], ...over }
}

/**
 * ★ 现场同形的台账：`history` 里同时放四种行 —— 真单 `T-20261016-ff9ba7` 的
 * `history[0]` 逐字段同形的那条 `open`，加上三种**不许当选**的行。
 */
export function liveShapedTask(over = {}) {
  return seedTask({
    history: [
      { at: '2026-10-15T17:52:44Z', task_id: 'T-NOMAIN-1', actor: 'main', action: 'open', requirement_digest: 'ae33d0328a1de1c2', agent: 'session-main-live' },
      { at: '2026-10-15T17:52:44Z', task_id: 'T-NOMAIN-1', actor: 'main', action: 'hub:force_on_open', seat_added: false },
      // 机制自己的留痕（`actor` 也被写成 `main`，见 index.js 的留痕回调）—— 不是证据。
      { at: '2026-10-15T17:55:26Z', task_id: 'T-NOMAIN-1', actor: 'main', action: 'wake:skipped', reason: 'no-main-session' },
      // 席位行有 `agent`，但那是**席位会话** —— 投过去就是投错人。
      { at: '2026-10-16T13:41:36Z', task_id: 'T-NOMAIN-1', actor: 'writer', action: 'handoff:human_request', agent: 'session-writer-9' },
    ],
    ...over,
  })
}

/** 造一个唤醒器。`mainSession`=登记表；`persisted`=落盘兜底；`lastResort`=台账兜底。 */
export async function makeWaker(spec = {}) {
  const host = spec.host ?? fakeHost()
  const sinks = spec.sinks ?? auditSink()
  const warns = []
  const task = spec.task ?? seedTask()
  const registry = createMainSessionRegistry()
  if (typeof spec.mainSession === 'string' && spec.mainSession.length > 0) {
    registry.remember(task.id, spec.mainSession, 'test')
    host.ensure(spec.mainSession)
  }
  const persistCalls = []
  const rememberContact =
    spec.rememberContact === undefined
      ? async (taskId, sessionId) => {
          persistCalls.push({ taskId, sessionId })
          return { ok: true }
        }
      : spec.rememberContact
  const waker = createWaker({
    ctx: host.ctx,
    registry,
    ledger: spec.ledger ?? null,
    getTask: () => task,
    audit: sinks.audit,
    warn: (m) => warns.push(String(m)),
    rememberContact,
    ...(typeof spec.persisted === 'string' ? { mainContactOf: async () => spec.persisted } : {}),
    ...(typeof spec.lastResort === 'function' ? { lastResortMainOf: spec.lastResort } : {}),
  })
  return { waker, host, task, sinks, warns, registry, persistCalls }
}
