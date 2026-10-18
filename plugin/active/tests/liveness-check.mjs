/**
 * dsh-pipeline · **注入形状 + 席位失联检测**自测
 * ============================================================================
 *     node tests/liveness-check.mjs
 *
 * 这一套是两次真实事故留下的判据：
 *
 *   A. **注入形状**（2026-10-11 事故：子会话 277 ms 静默死亡）
 *      · 全体注入点都登记在 `HOST_INJECTION_SITES` 里（防漏）
 *      · 每条注入给宿主的消息都要满足「block 数组 + `source.kind`」——
 *        宿主有多处**无守卫**地读 `message.source.kind`
 *        （`@deepseek-ai/dsh-session-reference#prepareDirectMessages`、app.asar @55346974）
 *      · **反例**：旧形状（`{role:'user', content:'字符串'}`，无 source）必须被判违规
 *      · **静态扫描**：`lib/` 下除 `hostmsg.js` 外不许再出现裸的 `role: 'user'` 字面量
 *        —— 这是"一处都不能漏"的机械判据
 *      · 下游给了非对象（含 `undefined`）时**原样透传**（不替宿主发明形状）
 *
 *   B. **失联判据**（纯函数，正反例）
 *      · 反例：`analyzing` + 需求分析席位派活 6 分钟 + 0 证据 ⇒ **必须报出来**
 *      · 正例：阈值内 / 有交接物 / **双轨派活下的审核** / 状态与角色不匹配 ⇒ 不报
 *
 *   C. **端到端处置**：机制自己把任务推到「已阻塞」并写明原因；不重复升级；
 *      `unblock` 之后仍静默可以再升一次。
 *
 *   D. **拦截缝端到端**：`tools/pre-execute` 真的会触发自动阻塞；节流生效；
 *      检查失败**绝不影响工具调用**；非管线会话完全不参与。
 *
 * @module dsh-pipeline/tests/liveness-check
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HOST_INJECTION_SITES, PRODUCER_KIND_PREFIX, assertHostMessage, hostMessage, isProducerOwnedKind } from '../lib/hostmsg.js'
import { DEFAULT_SEAT_SILENCE_MS, seatKey, seatLiveness, upsertDispatch } from '../lib/liveness.js'
import { registerInterception } from '../lib/intercept.js'
import { createHarness, disposeHarness } from './selftest-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')

const indent = (s, n = 4) =>
  String(s ?? '')
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n')

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
  }
}

/**
 * 造一个**假的宿主**（语义照抄：中间件是链，`next()` 往下走）。
 * 与 `intercept-check.mjs` 里那个同源 —— 这里再写一份是为了让本套能独立跑。
 *
 * ⚠️ `hasResult=false` 用来模拟"下游什么都没给"（`next()` 解析成 `undefined`）——
 *    **不能**靠传 `undefined` 来表达，那样会被默认参数吃掉（写这一套时踩过）。
 */
function createFakeHost(nextResult = { kind: 'enter', messages: [] }, hasResult = true) {
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {
        const arr = handlers.get(event) ?? []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      }
    },
  }
  async function emit(event, ...args) {
    const arr = handlers.get(event) ?? []
    let idx = 0
    const next = async () => {
      if (idx >= arr.length) return hasResult ? nextResult : undefined
      const fn = arr[idx++]
      return fn(...args, next)
    }
    return next()
  }
  return { ctx, emit, handlers, events: () => [...handlers.keys()] }
}

const MIN = 60 * 1000

/** 开一台干净 harness + 一张处于 `analyzing` 的任务（失联检测的标准现场）。 */
async function analyzingFixture(agentId = 'agent-main', opts = {}) {
  const h = await createHarness(opts)
  const opened = await h.store.open({ requirement: '自测：席位失联检测', actorRole: 'main', actorAgentId: agentId })
  const taskId = opened.task.id
  h.tokens.mint({ taskId, role: 'main', agentId })
  await h.store.transition({ taskId, event: 'dispatch_orchestrator', actorRole: 'main', actorAgentId: agentId })
  return { h, taskId, agentId }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function runLivenessCheck() {
  const rec = createRecorder()
  const open = []

  // =========================================================================
  // A. 注入形状（防回归）
  // =========================================================================
  {
    // --- A1 注入点清单：必须覆盖 agent/pre-step 的两处注入 ---
    const ids = HOST_INJECTION_SITES.map((s) => s.id)
    rec.add(
      'A 注入形状',
      '★ 注入点清单覆盖 `agent/pre-step` 的两处注入（席位简报 + 失联提示）',
      ids.includes('pre-step-seat-briefing') && ids.includes('pre-step-stale-seat-notice'),
      `HOST_INJECTION_SITES = ${JSON.stringify(ids)}`,
    )

    // --- A2 正例：hostMessage 产出的消息 0 违规 ---
    const good = hostMessage({ text: '正文', form: 'seat-briefing', taskId: 'T-1', role: 'main', seat: 'writer#1' })
    const goodV = assertHostMessage(good)
    rec.add(
      'A 注入形状',
      '正例：`hostMessage()` 产出的消息**符合宿主期望**（0 违规）',
      goodV.length === 0,
      `产出：${JSON.stringify(good)}\n违规：${goodV.length} 条`,
    )

    // --- A2b 正例：source.kind 必须是**生产者自有**的 kind ------------------
    //
    //   ★ 2026-10-11 的第二起事故就出在这个**取值**上：
    //     上一版把 `kind` 写成裸的 `'plugin'`，而那是会话格式 v4 **明确退役**的值
    //     ⇒ `encodeEvent` 阶段被 `assertV4SourceRowAdmission` 拒收 ⇒ 会话「处理失败」。
    //     而当时的 A2 只判"kind 是非空字符串" ⇒ **'plugin' 能通过**，自测全绿、线上全炸。
    //     所以判据必须查取值，不能只查类型 —— 这一条就是那个补丁。
    const goodSource = good.source
    rec.add(
      'A 注入形状',
      '★★ `hostMessage()` 的 `source.kind` 是**生产者自有**的 kind（`plugin:<插件名>`），不是退役的裸 `\'plugin\'`',
      isProducerOwnedKind(goodSource.kind) === true &&
        String(goodSource.kind).startsWith(PRODUCER_KIND_PREFIX) &&
        goodSource.kind !== 'plugin' &&
        goodSource.kind === 'plugin:dsh-pipeline',
      `source = ${JSON.stringify(goodSource)}\nkind = ${JSON.stringify(goodSource.kind)}　isProducerOwnedKind = ${isProducerOwnedKind(goodSource.kind)}`,
    )
    rec.add(
      'A 注入形状',
      '★ v4 把身份放进 `kind` ⇒ `source` 上**不再有**并列的 `plugin` 键（v3 包装形态已退役）',
      !Object.hasOwn(goodSource, 'plugin'),
      `source 的键 = ${JSON.stringify(Object.keys(goodSource))}`,
    )

    // --- A2c 反例：**旧形态 `kind:'plugin'` 必须被判违规** ------------------
    //   这条是真正的防回归：把 HOST_SOURCE_KIND 改回 `'plugin'` 时，它会立刻变红。
    const retiredKind = { role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'dsh-pipeline', form: 'seat-briefing' } }
    const retiredV = assertHostMessage(retiredKind)
    rec.add(
      'A 注入形状',
      '★★ 反例：**退役形态** `source.kind = \'plugin\'`（+ 并列 `plugin` 字段）⇒ 判违规',
      retiredV.length >= 1 && retiredV.some((v) => v.includes('source.kind')) && retiredV.some((v) => v.includes('producer')),
      `违规 ${retiredV.length} 条：\n${indent(retiredV.join('\n'))}\n` +
        '（★ 这一条在修复前是**绿的** —— 旧判据只查 "kind 是非空字符串"，而 \'plugin\' 正好是合法非空字符串。\n' +
        '  后果：DSH 的 v4 准入在**写盘之前**抛 "format v4 message requires a producer-owned source kind"，\n' +
        '  整个会话「处理失败」，而坏行根本没写进盘 ⇒ 线上查不到任何痕迹。）',
    )

    // --- A3 反例：旧形状（事故现场）必须被判违规 ---
    const old = { role: 'user', content: '【多 AI 协同流水线 · 你的边界】…' }
    const oldV = assertHostMessage(old)
    rec.add(
      'A 注入形状',
      '★★ 反例：**旧形状**（`{role:"user", content:"字符串"}`，无 `source`）⇒ 判违规（2 条）',
      oldV.length >= 2 && oldV.some((v) => v.includes('source')) && oldV.some((v) => v.includes('block 数组')),
      `违规清单：\n${indent(oldV.map((v, i) => `${i + 1}. ${v}`).join('\n'))}`,
    )

    // --- A4 反例：有 source 但没有 kind ---
    //   这一条只测"kind"一个缺陷，所以别的字段（含 id）都给合规值 —— 一例一缺陷。
    const noKind = { id: 'test-a4', role: 'user', content: [{ type: 'text', text: 'x' }], source: { plugin: 'dsh-pipeline' } }
    const noKindV = assertHostMessage(noKind)
    rec.add(
      'A 注入形状',
      '反例：`source` 存在但**没有 `kind`** ⇒ 判违规（宿主靠 kind 分流）',
      noKindV.length === 1 && noKindV[0].includes('source.kind'),
      `违规：${JSON.stringify(noKindV)}`,
    )

    // --- A4b 反例：**缺 `id`**（2026-10-11 第三次事故：会话永久打不开）----------
    //   这条是本次事故的防回归：缺 id 的消息**能写进盘**，但**再也读不出来** ——
    //   症状是 `历史加载失败: … session event at seq N lacks an identified message`，
    //   坏行永久留在日志里。把 `hostMessage()` 里的 `id` 去掉，这一条必须立刻变红。
    const noId = { role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin:dsh-pipeline', form: 'seat-briefing' } }
    const noIdV = assertHostMessage(noId)
    rec.add(
      'A 注入形状',
      '★★ 反例：**缺 `id`** ⇒ 判违规（会话 v4 读盘校验要求消息带非空 `id`）',
      noIdV.length >= 1 && noIdV.some((v) => v.includes('.id')),
      `违规：${JSON.stringify(noIdV)}\n` +
        '（★ 缺 id 的消息能写进盘 —— 后果不是当轮报错，而是这个会话以后每次打开都失败。\n' +
        '  修法：一律用 `hostMessage()` 构造，它每次铸一枚新 UUID。）',
    )

    // --- A5 静态扫描：lib/ 下不许再有裸的 role 字面量 ---
    //
    //   ★ 这是"一处都不能漏"的机械判据：只要有人手写一条消息，
    //     这一条就会红 —— 不依赖人去数有几个注入点。
    const offenders = []
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          walk(p)
          continue
        }
        if (!e.name.endsWith('.js')) continue
        if (e.name === 'hostmsg.js') continue // 构造器自己当然有
        const rel = p.slice(PKG.length + 1).split('\\').join('/')
        const lines = readFileSync(p, 'utf8').split('\n')
        lines.forEach((line, i) => {
          const t = line.trim()
          if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return // 注释不算
          if (/role:\s*['"](user|assistant)['"]/.test(line)) offenders.push(`${rel}:${i + 1}　${t.slice(0, 90)}`)
        })
      }
    }
    walk(join(PKG, 'lib'))
    rec.add(
      'A 注入形状',
      '★★ 静态扫描：`lib/**` 里除 `hostmsg.js` 外**不存在**裸的 `role: \'user\'` 字面量（防漏的机械判据）',
      offenders.length === 0,
      offenders.length === 0
        ? '扫描 lib/ 全部 .js：0 处裸消息字面量 ✓（所有注入都走 hostMessage）'
        : `发现裸消息字面量：\n${indent(offenders.join('\n'))}`,
    )
  }

  // =========================================================================
  // A6–A8. 真跑拦截缝：注入的消息必须合规；下游给 undefined 要原样透传
  // =========================================================================
  {
    const { h, taskId, agentId } = await analyzingFixture()
    open.push(h)
    const fake = createFakeHost()
    const ic = registerInterception(fake.ctx, {
      tokens: h.tokens,
      guard: h.guard,
      warn: () => {},
      getTask: (id) => h.store.peek(id) ?? null,
      seatSilenceMs: h.config.seatSilenceMs,
      checkLiveness: async (id) => h.store.checkLiveness(id, { escalate: true }),
    })

    const stepR = await fake.emit('agent/pre-step', {
      agent: { id: agentId },
      messages: [{ role: 'user', content: '开始干活' }],
      turn: 1,
      step: 1,
    })
    const msgs = stepR?.messages ?? []
    const violations = []
    msgs.forEach((m, i) => violations.push(...assertHostMessage(m, { path: `messages[${i}]` })))
    rec.add(
      'A 注入形状',
      '★★ 真跑 `agent/pre-step`：注入的**每条**消息都过宿主形状校验（0 违规）',
      stepR?.kind === 'enter' && msgs.length > 0 && violations.length === 0,
      `注入 ${msgs.length} 条　违规 ${violations.length} 条\n第一条原样：\n${indent(JSON.stringify(msgs[0]))}`,
    )

    // --- A7 失联提示也必须是宿主形状 + 只发给控制角色 ---
    await h.store.recordDispatch(taskId, {
      role: 'orchestrator',
      seat: null,
      agentId: 'dead-child',
      token: 'PT-dead',
      atMs: Date.now() - 6 * MIN,
      at: new Date(Date.now() - 6 * MIN).toISOString(),
    })
    // 清掉"席位简报只注入一次"的状态：换一个席位键来观察失联提示
    const step2 = await fake.emit('agent/pre-step', {
      agent: { id: agentId },
      messages: [{ role: 'user', content: '继续' }],
      turn: 1,
      step: 2,
    })
    const msgs2 = step2?.messages ?? []
    const staleMsg = msgs2.find((m) => m?.source?.form === 'stale-seat-notice') ?? null
    const v2 = []
    msgs2.forEach((m, i) => v2.push(...assertHostMessage(m, { path: `messages[${i}]` })))
    rec.add(
      'A 注入形状',
      '★ 失联提示（`stale-seat-notice`）也走 `hostMessage`：形状合规 + 正文含"席位失联"',
      staleMsg !== null && v2.length === 0 && String(staleMsg.content?.[0]?.text ?? '').includes('席位失联'),
      `找到 stale 提示：${staleMsg !== null}\n原样：\n${indent(JSON.stringify(staleMsg))}`,
    )

    // --- A8 下游给 undefined ⇒ 原样透传（不替宿主发明形状）---
    //
    //   判据来源：宿主 cordis 的 `waterfall` **不给默认值**
    //   （`const next = () => (cbs.shift() ?? inner)(...args); … return next();`）。
    //   本插件的缝如果在这里"顺手补一个对象"，就掩盖了下游的 bug。
    const fake2 = createFakeHost(null, false) // ← 下游什么都不给（`next()` → undefined）
    const ic2 = registerInterception(fake2.ctx, {
      tokens: h.tokens,
      guard: h.guard,
      warn: () => {},
      getTask: () => null,
      seatSilenceMs: h.config.seatSilenceMs,
    })
    const passThrough = await fake2.emit('agent/pre-step', {
      agent: { id: agentId },
      messages: [{ role: 'user', content: 'x' }],
      turn: 1,
      step: 1,
    })
    rec.add(
      'A 注入形状',
      '★ 下游返回非对象（`undefined`）时**原样透传** —— 不替宿主发明形状、不掩盖下游 bug',
      passThrough === undefined,
      `下游给 undefined ⇒ 本插件返回：${JSON.stringify(passThrough)}\n（宿主随后会在自己的 decision.kind 上炸 —— 那是宿主/dsh-orb 的账，不是本插件的）`,
    )

    void ic
    void ic2
  }

  // =========================================================================
  // B. 失联判据（纯函数，正反例）
  // =========================================================================
  {
    const now = 1791706556000 + 6 * MIN
    const at = 1791706556000

    // --- B1 反例：事故现场 ---
    const acc = {
      state: 'analyzing',
      dispatched: [{ role: 'orchestrator', seat: null, agent_id: '00000000-0000-4000-8000-000000000101', at, at_ms: at }],
      handoffs: [],
      history: [],
      successions: [],
    }
    const r1 = seatLiveness(acc, now, {})
    rec.add(
      'B 失联判据',
      '★★ 反例（**事故现场**）：`analyzing` + 需求分析席位派活 6 分钟 + **0 交接物/0 流水/0 水位** ⇒ 必须报失联',
      r1.silent.length === 1 && r1.silent[0].key === 'orchestrator' && r1.summary.includes('席位失联'),
      `silent=${r1.silent.length}（${r1.silent.map((s) => s.key).join(',')}）\n摘要原文：\n${indent(r1.summary.split('\n').slice(0, 6).join('\n'))}`,
    )

    // --- B2 正例：阈值内不报 ---
    const r2 = seatLiveness(acc, at + 1 * MIN, {})
    rec.add(
      'B 失联判据',
      '正例：同一席位只过了 **1 分钟**（阈值 5 分钟）⇒ 不报（它可能只是还在想）',
      r2.silent.length === 0,
      `silent=${r2.silent.length}　elapsed=${r2.seats[0]?.elapsed_zh}`,
    )

    // --- B3 正例：有交接物不报 ---
    const withHandoff = {
      ...acc,
      handoffs: [{ kind: 'requirement_analysis', from_role: 'orchestrator', created_at: new Date(at + MIN).toISOString() }],
    }
    const r3 = seatLiveness(withHandoff, now, {})
    rec.add(
      'B 失联判据',
      '正例：席位**产出过交接物** ⇒ 不报（它活着，只是慢）',
      r3.silent.length === 0 && String(r3.seats[0]?.evidence ?? '').includes('交接物'),
      `silent=${r3.silent.length}　evidence=${r3.seats[0]?.evidence}`,
    )

    // --- B4 正例：双轨派活下的审核**不许**被误判 ---
    const dual = {
      state: 'developing',
      dispatched: [
        { role: 'reviewer', seat: null, at_ms: at },
        { role: 'writer', seat: 'writer#1', at_ms: at },
      ],
      handoffs: [],
      history: [],
      successions: [],
    }
    const r4 = seatLiveness(dual, now, {})
    const rev = r4.seats.find((s) => s.key === 'reviewer')
    rec.add(
      'B 失联判据',
      '★★ 正例（**防误判**）：双轨派活下审核与编写同时开工，`developing` 时审核沉默是合法的 ⇒ **不报**',
      rev !== undefined && rev.silent === false && rev.expected === false,
      `reviewer：expected=${rev?.expected}　silent=${rev?.silent}\n（判据：只有"轮到场了"的角色（EXPECTED_ROLES_BY_STATE[state]）才会被判失联）`,
    )

    // --- B4b 同一个状态里，编写席位是真的会报的 ---
    const w = r4.seats.find((s) => s.key === 'writer#1')
    rec.add(
      'B 失联判据',
      '对照：同一状态下**编写席位**（轮到了）沉默 6 分钟 ⇒ 报失联',
      w !== undefined && w.silent === true,
      `writer#1：expected=${w?.expected}　silent=${w?.silent}`,
    )

    // --- B5 正例：状态与角色不匹配 ---
    const r5 = seatLiveness({ ...acc, state: 'ready_plan' }, now, {})
    rec.add(
      'B 失联判据',
      '正例：状态是「待计划」而台账里只有需求分析席位 ⇒ 不报（现在不该它动）',
      r5.silent.length === 0,
      `state=ready_plan　expected=${JSON.stringify(r5.expected)}　silent=${r5.silent.length}`,
    )

    // --- B6 正例：还没轮到（pending）---
    const r6 = seatLiveness({ ...acc, state: 'pending' }, now, {})
    rec.add(
      'B 失联判据',
      '正例：「待分配」状态下派了席位也不报（活儿还没到它）',
      r6.silent.length === 0,
      `state=pending　expected=${JSON.stringify(r6.expected)}　silent=${r6.silent.length}`,
    )

    // --- B7 upsertDispatch：重派重新计时 ---
    const list1 = upsertDispatch([], { role: 'orchestrator', at, atMs: at })
    const list2 = upsertDispatch(list1, { role: 'orchestrator', atMs: at + 5 * MIN, at: new Date(at + 5 * MIN).toISOString() })
    rec.add(
      'B 失联判据',
      '★ `upsertDispatch`：同一席位**重派覆盖**旧记录（重新计时，不拿旧时间算超时）',
      list2.length === 1 && list2[0].at_ms === at + 5 * MIN,
      `重派后台账：${JSON.stringify(list2)}`,
    )

    // --- B8 空台账不报 ---
    const r8 = seatLiveness({ state: 'analyzing', dispatched: [], handoffs: [], history: [], successions: [] }, now, {})
    rec.add(
      'B 失联判据',
      '正例：**没派过活**（台账为空）⇒ 不报（"没派"与"派了没人回"是两件事）',
      r8.silent.length === 0 && r8.seats.length === 0,
      `seats=${r8.seats.length}　silent=${r8.silent.length}　silence=${r8.silence_zh}`,
    )

    rec.add(
      'B 失联判据',
      '★ 默认静默阈值 = 5 分钟（`DEFAULT_SEAT_SILENCE_MS`）',
      DEFAULT_SEAT_SILENCE_MS === 5 * MIN,
      `DEFAULT_SEAT_SILENCE_MS=${DEFAULT_SEAT_SILENCE_MS}`,
    )

    rec.add(
      'B 失联判据',
      '席位键口径与项目既有的一致（`seat || role`，不是 `role#seat`）',
      seatKey('writer', 'writer#1') === 'writer#1' && seatKey('main', null) === 'main',
      `seatKey('writer','writer#1')=${seatKey('writer', 'writer#1')}　seatKey('main',null)=${seatKey('main', null)}`,
    )
  }

  // =========================================================================
  // C. 端到端：机制自己把任务推到「已阻塞」
  // =========================================================================
  {
    const { h, taskId, agentId } = await analyzingFixture()
    open.push(h)

    // --- C1 recordDispatch 落盘 ---
    const deadAt = Date.now() - 6 * MIN
    const d1 = await h.store.recordDispatch(taskId, {
      role: 'orchestrator',
      seat: null,
      agentId: '00000000-0000-4000-8000-000000000102',
      token: 'PT-465b3a2aadc0dee42f1ea750',
      atMs: deadAt,
      at: new Date(deadAt).toISOString(),
      via: 'subagent',
    })
    const d2 = await h.store.recordDispatch(taskId, { role: 'orchestrator', seat: null, agentId: 'retry-1', atMs: deadAt + 1000 })
    rec.add(
      'C 端到端处置',
      '★ `recordDispatch` 落盘 + 同一席位重派**覆盖**（台账仍 1 条，时间是新的）',
      d1.ok === true && d2.ok === true && (h.store.peek(taskId).dispatched ?? []).length === 1 &&
        h.store.peek(taskId).dispatched[0].agent_id === 'retry-1',
      `台账：${JSON.stringify(h.store.peek(taskId).dispatched)}`,
    )

    // --- C2 只报告不处置 ---
    const reportOnly = await h.store.checkLiveness(taskId, { escalate: false, now: Date.now() })
    rec.add(
      'C 端到端处置',
      '★ `escalate:false`（`pipeline_status` 走这条）⇒ **只报告，不动状态**',
      reportOnly.ok === true && reportOnly.silent.length === 1 && h.store.peek(taskId).state === 'analyzing' &&
        reportOnly.escalated === false,
      `silent=${reportOnly.silent.length}　state=${h.store.peek(taskId).state}　escalated=${reportOnly.escalated}`,
    )

    // --- C3 自动处置 ---
    const esc = await h.store.checkLiveness(taskId, { escalate: true, now: Date.now() })
    const after = h.store.peek(taskId)
    rec.add(
      'C 端到端处置',
      '★★ `escalate:true` ⇒ 任务被推到「**已阻塞**」，且台账/审计写明**原因与是谁触发的**',
      esc.escalated === true && after.state === 'blocked' &&
        Array.isArray(after.liveness?.escalations) && after.liveness.escalations.length === 1 &&
        String(after.liveness.escalations[0].reason ?? '').includes('席位失联'),
      `state：analyzing → ${after.state}\nescalations=${JSON.stringify(after.liveness?.escalations ?? null, null, 1)}\n` +
        `历史最后一条：${JSON.stringify((after.history ?? []).slice(-1)[0] ?? null)}`,
    )

    // --- C4 不重复升级（self-disarm）---
    const again = await h.store.checkLiveness(taskId, { escalate: true, now: Date.now() })
    rec.add(
      'C 端到端处置',
      '★ 升级之后**不重复升级**（`blocked` 不在 `EXPECTED_ROLES_BY_STATE` 里 ⇒ 机制自我解除武装）',
      again.escalated === false && again.silent.length === 0 &&
        (h.store.peek(taskId).liveness?.escalations ?? []).length === 1,
      `第二次：silent=${again.silent.length}　escalated=${again.escalated}　escalations=${(h.store.peek(taskId).liveness?.escalations ?? []).length}`,
    )

    // --- C5 unblock 之后：**同一个静默窗口内不重复升级**（防 block/unblock 乒乓）---
    await h.store.transition({ taskId, event: 'unblock', actorRole: 'main', actorAgentId: agentId })
    const stateAfterUnblock = h.store.peek(taskId).state
    const third = await h.store.checkLiveness(taskId, { escalate: true, now: Date.now() })
    rec.add(
      'C 端到端处置',
      '★ `unblock` 之后**同一个静默窗口内**不再升级（防"人工刚放行、机制立刻又关"的乒乓），且给出说明',
      stateAfterUnblock === 'analyzing' && third.escalated === false && third.silent.length === 1 &&
        String(third.note ?? '').includes('已处置过') &&
        (h.store.peek(taskId).liveness?.escalations ?? []).length === 1,
      `unblock → ${stateAfterUnblock}　silent=${third.silent.length}　escalated=${third.escalated}\n说明：${String(third.note ?? '')}`,
    )

    // --- C5b 窗口过去之后仍然静默 ⇒ 允许**再升一次**（不会永远放过）---
    const lastAt = (h.store.peek(taskId).liveness?.escalations ?? []).slice(-1)[0]?.at_ms ?? 0
    const later = lastAt + h.store.seatSilenceMs + 1000
    const fourth = await h.store.checkLiveness(taskId, { escalate: true, now: later })
    rec.add(
      'C 端到端处置',
      '★ 又过了一个静默窗口、席位**仍然**没动静 ⇒ 允许**再升一次**（机制不会因为"升过了"就永远放过）',
      fourth.escalated === true && h.store.peek(taskId).state === 'blocked' &&
        (h.store.peek(taskId).liveness?.escalations ?? []).length === 2,
      `再查（now = 上次处置 + ${h.store.seatSilenceMs}ms + 1s）：escalated=${fourth.escalated}　state=${h.store.peek(taskId).state}　escalations=${(h.store.peek(taskId).liveness?.escalations ?? []).length}`,
    )
  }

  // =========================================================================
  // C6. pipeline_status 的可见面（主对话最自然的那个动作）
  // =========================================================================
  {
    const { h, taskId, agentId } = await analyzingFixture()
    open.push(h)
    await h.store.recordDispatch(taskId, {
      role: 'orchestrator',
      seat: null,
      agentId: 'dead-child-2',
      atMs: Date.now() - 6 * MIN,
    })
    const def = h.byName.get('pipeline_status')
    const out = await def.execute({ task_id: taskId }, { agent: { id: agentId } })
    rec.add(
      'C 端到端处置',
      '★★ `pipeline_status` 里**看得见**席位失联（不必等宿主通知才知道）',
      out.ok === true && String(out.summary).includes('席位失联') &&
        out.liveness?.silent?.length === 1 && out.liveness.silent[0].key === 'orchestrator',
      `摘要里的失联段：\n${indent(
        String(out.summary)
          .split('\n')
          .filter((l) => l.includes('失联') || l.includes('席位'))
          .slice(0, 8)
          .join('\n'),
      )}\nliveness 字段：${JSON.stringify({ ok: out.liveness?.ok, silence_ms: out.liveness?.silence_ms, silent: out.liveness?.silent?.map((s) => s.key) })}`,
    )
  }

  // =========================================================================
  // D. 拦截缝端到端：任意角色的下一次工具调用 ⇒ 自动阻塞
  // =========================================================================
  {
    const { h, taskId, agentId } = await analyzingFixture()
    open.push(h)
    await h.store.recordDispatch(taskId, {
      role: 'orchestrator',
      seat: null,
      agentId: 'dead-child-3',
      atMs: Date.now() - 6 * MIN,
    })

    const fake = createFakeHost()
    registerInterception(fake.ctx, {
      tokens: h.tokens,
      guard: h.guard,
      warn: () => {},
      getTask: (id) => h.store.peek(id) ?? null,
      seatSilenceMs: h.config.seatSilenceMs,
      checkLiveness: async (id) => {
        const r = await h.store.checkLiveness(id, { escalate: true })
        if (r !== null && r !== undefined && r.task !== undefined && r.task !== null) h.indexTask(r.task.id, r.task)
        return r
      },
    })

    // --- D1 一次普通工具调用 ⇒ 任务被自动阻塞 ---
    const call1 = await fake.emit('tools/pre-execute', { name: 'read', arguments: { path: 'x' }, agent: { id: agentId } })
    rec.add(
      'D 拦截缝端到端',
      '★★ 管线的任意角色**下一次工具调用** ⇒ 机制自己把任务推到「已阻塞」（无需定时器）',
      h.store.peek(taskId).state === 'blocked' && call1?.kind === 'enter',
      `state=${h.store.peek(taskId).state}　工具调用结果=${JSON.stringify(call1)}\n（写时检查：本次调用**照常放行**，只是任务状态被如实推到阻塞）`,
    )

    // --- D2 节流 ---
    const before = (h.store.peek(taskId).liveness?.escalations ?? []).length
    const call2 = await fake.emit('tools/pre-execute', { name: 'read', arguments: { path: 'y' }, agent: { id: agentId } })
    rec.add(
      'D 拦截缝端到端',
      '★ 节流：紧接着的第二次调用**不再查盘**（`LIVENESS_CHECK_THROTTLE_MS`），不重复升级',
      call2?.kind === 'enter' && (h.store.peek(taskId).liveness?.escalations ?? []).length === before,
      `escalations 前后：${before} → ${(h.store.peek(taskId).liveness?.escalations ?? []).length}　第二次调用=${JSON.stringify(call2)}`,
    )

    // --- D3 检查失败绝不影响工具调用 ---
    const fake3 = createFakeHost()
    registerInterception(fake3.ctx, {
      tokens: h.tokens,
      guard: h.guard,
      warn: () => {},
      getTask: () => null,
      seatSilenceMs: h.config.seatSilenceMs,
      // 故意炸的检查器
      checkLiveness: async () => {
        throw new Error('模拟：失联检测内部炸了')
      },
    })
    const call3 = await fake3.emit('tools/pre-execute', { name: 'read', arguments: { path: 'z' }, agent: { id: agentId } })
    rec.add(
      'D 拦截缝端到端',
      '★ 失联检测**内部异常** ⇒ 被吞掉，本次工具调用照常放行（检查不许拖垮调用）',
      call3?.kind === 'enter',
      `炸掉的检查器下，工具调用返回：${JSON.stringify(call3)}`,
    )

    // --- D4 非管线会话完全不参与 ---
    const fake4 = createFakeHost()
    let touched = 0
    registerInterception(fake4.ctx, {
      tokens: h.tokens,
      guard: h.guard,
      warn: () => {},
      getTask: () => null,
      seatSilenceMs: h.config.seatSilenceMs,
      checkLiveness: async () => {
        touched += 1
        return null
      },
    })
    const call4 = await fake4.emit('tools/pre-execute', {
      name: 'read',
      arguments: { path: 'q' },
      agent: { id: 'user-own-session' },
    })
    rec.add(
      'D 拦截缝端到端',
      '★★ 作用域：**非管线会话**的工具调用 ⇒ 完全不参与（一次检查都不跑；事故防线）',
      call4?.kind === 'enter' && touched === 0,
      `touched=${touched}（应为 0）　返回=${JSON.stringify(call4)}`,
    )
  }

  // =========================================================================
  // E. ★★ 事故现场回放：席位秒死之后**没有任何角色再调用工具**
  //
  //    这一组是 2026-10-11 复盘补的。原来的两个触发点都救不了那种情形：
  //      · `tools/pre-execute` —— 等"下一次工具调用"，而事故里**不存在**下一次调用；
  //      · `pipeline_status`   —— 只报告不处置 ⇒ 任务依旧停在「需求分析中」。
  //    现在：查状态即处置（`pipeline_status`）+ 用户说话也算一步（`agent/pre-step`）
  //          + 一键重派通道（`pipeline_dispatch { reassign: true }`）。
  // =========================================================================
  {
    // --- E1 反例（旧行为）：什么都不做 ⇒ 任务就停在「需求分析中」---
    const { h: h1, taskId: t1 } = await analyzingFixture()
    open.push(h1)
    await h1.store.recordDispatch(t1, { role: 'orchestrator', seat: null, agentId: '00000000-0000-4000-8000-000000000103', atMs: Date.now() - 6 * MIN })
    rec.add(
      'E 事故回放',
      '★★ 反例（**旧行为的病**）：席位秒死后**没有任何角色调用工具** ⇒ 任务就停在「需求分析中」，机制不发一言',
      h1.store.peek(t1).state === 'analyzing' && (h1.store.peek(t1).liveness?.escalations ?? []).length === 0,
      `state=${h1.store.peek(t1).state}（没有任何东西会自动推进它 —— 这正是用户说的"静静停住"）`,
    )

    // --- E2 正例：主对话查一次 pipeline_status（带 task_id）⇒ 立刻处置 ---
    const defStatus = h1.byName.get('pipeline_status')
    const out2 = await defStatus.execute({ task_id: t1 }, { agent: { id: h1.agents?.main ?? 'agent-main' } })
    rec.add(
      'E 事故回放',
      '★★ 正例：**查一次 `pipeline_status`** ⇒ 席位失联被识别并**自动推到「已阻塞」**（不再只是报一句）',
      out2.ok === true && h1.store.peek(t1).state === 'blocked' && out2.liveness?.escalated === true &&
        String(out2.summary).includes('已自动处置'),
      `state=analyzing → ${h1.store.peek(t1).state}　liveness.escalated=${out2.liveness?.escalated}\n` +
        `liveness.silent=${JSON.stringify(out2.liveness?.silent?.map((s) => s.key))}`,
    )
    rec.add(
      'E 事故回放',
      '★★ 正例：`pipeline_status` 的返回里给出**可直接调用的下一步动作**（重派 / 换班 / 人工 / 取消）',
      Array.isArray(out2.liveness?.next_actions) && out2.liveness.next_actions.some((l) => l.includes('reassign: true')) &&
        out2.liveness.next_actions.some((l) => l.includes('pipeline_transition')) &&
        String(out2.summary).includes('reassign: true'),
      `next_actions（${out2.liveness?.next_actions?.length ?? 0} 行）：\n${indent((out2.liveness?.next_actions ?? []).join('\n'))}`,
    )

    // --- E3 正例：不带 task_id（列全部任务）也会扫出来并处置 ---
    const { h: h3, taskId: t3, agentId: a3 } = await analyzingFixture()
    open.push(h3)
    await h3.store.recordDispatch(t3, { role: 'orchestrator', seat: null, agentId: 'dead-1', atMs: Date.now() - 6 * MIN })
    const out3 = await h3.byName.get('pipeline_status').execute({}, { agent: { id: a3 } })
    rec.add(
      'E 事故回放',
      '★ 正例：`pipeline_status` **不带 task_id**（列全部任务）时也扫一遍失联并处置',
      out3.ok === true && h3.store.peek(t3).state === 'blocked' &&
        String(out3.summary).includes('席位失联') && out3.liveness?.escalated?.includes(t3),
      `state=${h3.store.peek(t3).state}　escalated=${JSON.stringify(out3.liveness?.escalated)}\n` +
        indent(String(out3.summary).split('\n').filter((l) => l.includes('失联') || l.includes('⚠')).join('\n')),
    )

    // --- E4 关掉自动处置 ⇒ 只报告、不动状态，且**明写**这一点 ---
    const { h: h4, taskId: t4, agentId: a4 } = await analyzingFixture('agent-main', {
      config: { seatLivenessEscalate: false },
    })
    open.push(h4)
    await h4.store.recordDispatch(t4, { role: 'orchestrator', seat: null, agentId: 'dead-2', atMs: Date.now() - 6 * MIN })
    const out4 = await h4.byName.get('pipeline_status').execute({ task_id: t4 }, { agent: { id: a4 } })
    rec.add(
      'E 事故回放',
      '★ `seatLivenessEscalate:false` ⇒ `pipeline_status` **只报告不处置**，且输出里**明写**"未处置"（不假装）',
      out4.ok === true && h4.store.peek(t4).state === 'analyzing' && out4.liveness?.escalated === false &&
        String(out4.summary).includes('只报告、未处置'),
      `state=${h4.store.peek(t4).state}（应保持 analyzing）　escalated=${out4.liveness?.escalated}\n` +
        indent(String(out4.summary).split('\n').filter((l) => l.includes('只报告')).join('\n')),
    )

    // --- E5 一键重派：blocked 任务自动恢复 + 重派 + 台账刷新 + **不消耗打回预算** ---
    const before = JSON.parse(JSON.stringify(h1.store.peek(t1)))
    const out5 = await h1.byName
      .get('pipeline_dispatch')
      .execute({ task_id: t1, role: 'orchestrator', spawn: false, reassign: true }, { agent: { id: 'agent-main' } })
    const after = h1.store.peek(t1)
    rec.add(
      'E 事故回放',
      '★★ 正例：`pipeline_dispatch { reassign: true }` ⇒ 从「已阻塞」**自动恢复**并重派同一席位（一键）',
      out5.ok === true && before.state === 'blocked' && after.state === 'analyzing' &&
        String(out5.summary).includes('席位失联重派'),
      `state：${before.state} → ${after.state}　新会话=${out5.agent_id}\n` +
        indent(String(out5.summary).split('\n').slice(0, 4).join('\n')),
    )
    rec.add(
      'E 事故回放',
      '★★ 正例：重派**刷新派活台账**（重新计时 ⇒ 不再被判失联）',
      (after.dispatched ?? []).length === 1 && after.dispatched[0].at_ms > before.dispatched[0].at_ms &&
        seatLiveness(after, Date.now(), {}).silent.length === 0,
      `台账：${JSON.stringify(after.dispatched)}　重算 silent=${seatLiveness(after, Date.now(), {}).silent.length}`,
    )
    rec.add(
      'E 事故回放',
      '★★ 正例：重派**不消耗打回预算**（`rework` 前后不变 —— 席位死亡不是任何角色的错）',
      JSON.stringify(before.rework) === JSON.stringify(after.rework),
      `rework：${JSON.stringify(before.rework)} → ${JSON.stringify(after.rework)}`,
    )
    // ★★ 2026-10-18 测试报告 P1-5：重派必须**吊销旧席位令牌** —— 否则旧会话还在活动，
    //    两个 tester 会同时写同一目录（现场：`tester-results.jsonl` 属另一个会话，结论可能互相矛盾）。
    rec.add(
      'E 事故回放',
      '★★ 正例：重派**吊销旧席位令牌**（旧会话之后的写会被守门以"没有身份"拒掉，不会双写）',
      h1.tokens.roleOfAgent(before.dispatched[0].agent_id) === null && out5.token !== '',
      `旧 agent=${before.dispatched[0].agent_id}　roleOfAgent=${JSON.stringify(h1.tokens.roleOfAgent(before.dispatched[0].agent_id))}\n` +
        `新令牌=${String(out5.token).slice(0, 8)}…（旧令牌已撤，新令牌可用）`,
    )

    // --- E6 reassign 对**非阻塞**任务不误伤 ---
    const { h: h6, taskId: t6 } = await analyzingFixture()
    open.push(h6)
    const out6 = await h6.byName
      .get('pipeline_dispatch')
      .execute({ task_id: t6, role: 'orchestrator', spawn: false, reassign: true }, { agent: { id: 'agent-main' } })
    rec.add(
      'E 事故回放',
      '★ 正例：任务**不在阻塞态**时 `reassign:true` 只是普通派活（不误伤、不乱改状态）',
      out6.ok === true && h6.store.peek(t6).state === 'analyzing' && !String(out6.summary).includes('席位失联重派'),
      `state=${h6.store.peek(t6).state}　摘要首行=${String(out6.summary).split('\n')[0]}`,
    )

    // --- E7 用户只是**说话**（没调任何工具）也够触发 ---
    const { h: h7, taskId: t7, agentId: a7 } = await analyzingFixture()
    open.push(h7)
    await h7.store.recordDispatch(t7, { role: 'orchestrator', seat: null, agentId: 'dead-3', atMs: Date.now() - 6 * MIN })
    const fake7 = createFakeHost()
    registerInterception(fake7.ctx, {
      tokens: h7.tokens,
      guard: h7.guard,
      warn: () => {},
      getTask: (id) => h7.store.peek(id) ?? null,
      seatSilenceMs: h7.config.seatSilenceMs,
      checkLiveness: async (id) => {
        const r = await h7.store.checkLiveness(id, { escalate: true })
        if (r !== null && r !== undefined && r.task !== undefined && r.task !== null) h7.indexTask(r.task.id, r.task)
        return r
      },
    })
    const step7 = await fake7.emit('agent/pre-step', {
      agent: { id: a7 },
      messages: [{ role: 'user', content: '（用户只是发了条消息，没调任何工具）' }],
      turn: 2,
      step: 1,
    })
    rec.add(
      'E 事故回放',
      '★★ 正例：**用户只是发了一条消息**（没调任何工具）⇒ `agent/pre-step` 也会触发处置',
      h7.store.peek(t7).state === 'blocked' && step7?.kind === 'enter',
      `state=${h7.store.peek(t7).state}　pre-step 返回=${JSON.stringify(step7?.kind)}`,
    )
  }

  for (const h of open) await disposeHarness(h)

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------
  const lines = []
  lines.push('='.repeat(78))
  lines.push('dsh-pipeline 自测：**注入形状**（宿主面消息） + **席位失联检测**')
  lines.push('='.repeat(78))
  const groups = [...new Set(rec.items.map((i) => i.group))]
  for (const g of groups) {
    const items = rec.items.filter((i) => i.group === g)
    const ok = items.filter((i) => i.pass).length
    lines.push('')
    lines.push(`【${g}】${ok}/${items.length} 通过`)
    lines.push('─'.repeat(78))
    for (const i of items) {
      lines.push(`  ${i.pass ? '✓' : '✗'} ${i.name}`)
      if (i.detail.length > 0) lines.push(indent(i.detail, 6))
      lines.push('')
    }
  }
  lines.push('─'.repeat(78))
  lines.push(`合计：${rec.passed}/${rec.total} 通过${rec.passed === rec.total ? '' : '  ← 有失败'}`)
  lines.push('─'.repeat(78))

  return { passed: rec.passed, total: rec.total, text: lines.join('\n'), items: rec.items }
}

// 直接跑（`node tests/liveness-check.mjs`）时自己出报告
if (process.argv[1] !== undefined && process.argv[1].endsWith('liveness-check.mjs')) {
  const r = await runLivenessCheck()
  console.log(r.text)
  process.exit(r.passed === r.total ? 0 : 1)
}
