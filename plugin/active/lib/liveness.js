/**
 * dsh-pipeline · **席位失联检测**
 * ============================================================================
 * 用户原话：
 *   「**被切断后要能自我意识到**」+「不是卡死、不是报错终止、也不是反复撞同一面墙」
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它：一个真实事故留下的空洞
 * ---------------------------------------------------------------------------
 * 2026-10-11：主对话 `pipeline_dispatch role=orchestrator` **成功**建了子会话、
 * 投递了派活单、返回了令牌；然后那个子会话在 `turn/start` 之后 **277 ms** 就死了
 * （宿主报 `Cannot read properties of undefined (reading 'kind')`）。
 *
 * 结果：任务永远停在「需求分析中」、`pipeline_status` 显示「交接物（0 份）」，
 * **机制自己一句话都不说** —— 主对话是从宿主的通知里才知道的，用户是从主对话口里
 * 才知道的。这就是「被切断后不能自我意识到」最贵的一种形态：**静默**。
 *
 * 本模块补的就是这一层：**派出去的席位有没有回话，机制得知道**。
 *
 * ---------------------------------------------------------------------------
 * 判据（三条同时成立才算"失联"，宁可漏报也不误报）
 * ---------------------------------------------------------------------------
 *   ① **超时**：`now - dispatched_at >= silenceMs`（默认 5 分钟，可配）。
 *   ② **轮到场了**：该角色的**下一步就该它动**（见 {@link EXPECTED_ROLES_BY_STATE}）。
 *      ★ 这一条是**防误报的关键**：双轨派活下审核是与编写同时开工的，它可能
 *        合法地沉默很久（链路是 编写 → 测试 → **才**交审核）。没有这一条，
 *        审核每次都会被误判成失联。
 *   ③ **没有任何活着的证据**：自派活之后，该席位没产出交接物、没写过历史、
 *      没自报过水位、也没被继任过（见 {@link evidenceOfLife}）。
 *
 * ---------------------------------------------------------------------------
 * 刻意**不做**的三件事
 * ---------------------------------------------------------------------------
 *   · **不起定时器**。插件没有生命周期外的调度面，定时器还会与"不安装不重启"的
 *     纪律打架。判据是**纯函数**，"什么时候查"由调用方决定 —— 本插件挂在
 *     既有的两个点上：`pipeline_status`（读时暴露）与 `tools/pre-execute`
 *     （任意角色的下一次工具调用；写时检查，带节流）。
 *   · **不猜**。查不到就报"查不到"，不把"没证据"写成"它还活着"，
 *     也不把"没证据"直接写成"它死了"——超时阈值就是"没证据"到"失联"的那条线。
 *   · **不新开状态**。失联的处置复用**既有**的异常出口 `block`（`states.js` 里
 *     `{ from:'*', event:'block', to: BLOCKED, by:['main','human'] }`），
 *     理由写进 `task.liveness.escalations[]` + 审计 —— 不新开一套并行机制。
 *
 * @module dsh-pipeline/lib/liveness
 */

import { appendFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { roleLabel } from './roles.js'
import { STATE_LABEL } from './states.js'

/**
 * 默认静默阈值：5 分钟。
 *
 * 为什么是 5 分钟而不是 30 秒：子会话**冷启动**（建会话 + 装配上下文 + 第一次
 * 模型请求）在慢机器上就可能要几十秒；阈值太紧会把"它正在想"误报成"它死了"。
 * 为什么不是 30 分钟：用户要的是"被切断后**能自己意识到**" —— 半小时之后
 * 才意识到，任务已经白等了半小时。
 */
export const DEFAULT_SEAT_SILENCE_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// ★★ B2 修复：**"会话还在活动"判据**（会话日志的 size / mtime 是不是在长）
// ---------------------------------------------------------------------------
//
// 现场（2026-10-12，带数字）：席位 `session-…` 被判「0 交接物 / 0 流水 /
// 0 水位自报」⇒ 机制自动把任务推到「已阻塞」；**同一时段**它的会话日志
// `session.v4.jsonl.zstd` 30 秒内从 381,679 B 长到 392,396 B（**+10,717 B**），
// 后续再测 +14,158 B / 20 s、+23,207 B / 20 s。那一次自动冻结**直接挡掉了一份
// 已经提交的 dev_to_test**。
//
// 为什么原来的三条判据看不见它：那三条（超时 / 轮到场 / 没有任何活着的证据）
// **全部只看任务台账**（交接物、席位提交表、水位自报、历史流水、继任），
// 而席位"正在读源码、逐文件算哈希、编译级冒烟"这类**纯工作**根本不产生台账事件。
//
// 补的判据（第四条，且**优先级最高**）：
//   会话日志在**距上次采样**之间**长大了**（≥ {@link DEFAULT_ACTIVITY_MIN_BYTES}，
//   且两次采样间隔 ≤ {@link DEFAULT_ACTIVITY_MAX_MS}）⇒ 这个席位**还活着**。
//
// ★ 修误判 ≠ 关掉检测：
//   · 判据是**纯函数**（`activityOfSamples`）—— 采样由 store 层做，判据只吃数字，
//     所以"当晚真实数据离线复算"与线上走的是**同一条判据**；
//   · **拿不到活动证据时不许只凭一次安静就冻结**：`opts.confirmations`（默认 2）
//     要求连续几次观察都没有活动证据才判失联（见 `seatLiveness` 的 `pending`）。
//   · 真死掉的席位：日志不再增长 ⇒ 采样会显示 0 增长 ⇒ 照旧被判失联并冻结。

/** 会话日志文件名（DSH 会话 v4 的一条会话 = 一个目录 + 这一个文件）。 */
export const SESSION_LOG_NAME = 'session.v4.jsonl.zstd'

/** 一次采样里至少长了这么多字节才算"在活动"（太小可能是元数据抖动）。 */
export const DEFAULT_ACTIVITY_MIN_BYTES = 1024

/** 两次采样间隔超过它就不算"刚才还在动"（默认 2 分钟）。 */
export const DEFAULT_ACTIVITY_MAX_MS = 2 * 60 * 1000

/** 拿不到活动证据时，**连续几次**安静才允许冻结（默认 2 —— 不许只凭一次安静就冻结）。 */
export const DEFAULT_SILENCE_CONFIRMATIONS = 2

/**
 * ★★ **2026-10-13 快修（②）：会话日志"刚刚被写过"的宽限窗**（默认 60 秒）。
 *
 * 现场：机制把**正在写交接物**的席位判成失联并冻结。反证是冻结同刻
 * 该席位的 `session.v4.jsonl.zstd` **仍在长**（实测 `563,327 → 575,960 B / 13 秒`、
 * 另有 `+10,717 B / 30 秒`）。
 *
 * ★ **计数以账本为准**（2026-10-14 逐单实读 `task.json` + `audit.jsonl` 修正）：
 *   · `T-20261012-8cdee0` = **6 次**（`liveness.escalations` 长度 = 6，6 条 `transition:block`
 *     的 note 全部是"机制触发（不是人叫停）"）；
 *   · `T-20261011-214043` = **7 次** —— 这才是"7"的真正出处；
 *   · 其余：`T-20261012-6884af` = 3、`T-20261011-5a871c` = 3、`T-20261011-a5fe41` = 1、
 *     `T-20261011-63633e` = 0。
 *   本注释改前写的「一夜 7 次」把 214043 的 7 误挂到了 8cdee0 头上。
 *   错数源头：8cdee0 的 6 条 `transition:unblock` 里，人工自编号一路写到了
 *   "本单第 **7** 次同型误冻"（另有 1 条 unblock 是"席位失联重派"、不是误冻解除）。
 *   ⚠️ **两条口径别混**（它们不是一回事）：
 *     ① **`transition:block` ≠ 机制误报次数** —— 6884af 的 5 条里有 2 条是**人为冻结**
 *        （"主对话按用户裁定主动冻结（非误报触发）"、"★ 按用户裁定挂起（合流）"）；
 *        `T-20261011-63633e` 的那 1 条是"**用户指示按住**"（点餐单不再推进），**不是失联**。
 *     ② 论"机制误报"只数 `liveness.escalations`：`transition:block` 里混着人为冻结与
 *        用户指示，`unblock` 的 note 自编号还会漂移。
 *   ★ 本条**只是注释**：阈值与判据一个字节没动（`seatLiveness` 的静默阈值仍是
 *     `config.seatSilenceMs` 默认 5 分钟，连续确认仍是 {@link DEFAULT_SILENCE_CONFIRMATIONS}）。
 *
 * 为什么需要它 —— 两次采样差值**覆盖不到**这个形状：
 *   · 采样只在"任意角色的下一次工具调用"时发生；席位写报告的那几分钟里**没人调工具**，
 *     于是上一次采样可能已经是几分钟前 ⇒ 差值窗口（{@link DEFAULT_ACTIVITY_MAX_MS}，2 分）
 *     用不上，`activityOfSamples` 只能回一句"这段不算刚才还在动"；
 *   · 更要命的是旧代码把这句判成 `known:true` ⇒ **绕过了"连续确认"门** ⇒ 一次观察即冻结。
 * 所以补一条**单样本**就能判的硬证据：文件的 `mtime` 就在刚才 ⇒ 它此刻正在被写。
 *
 * 取值理由：必须**远小于**静默阈值（默认 5 分），否则"死了之后 4 分钟才来看"也会被
 * 当成活着 —— 那就等于把检测关掉了（用户点名不许）。60 秒既容得下上面实测到的
 * 13 s / 30 s 两种写入节奏，又比 5 分钟阈值小一个量级。
 */
export const DEFAULT_ACTIVITY_FRESH_MS = 60 * 1000

/**
 * ★★ **2026-10-13 快修（②，P0-1）：会话根目录的候选列表**。
 *
 * 根因（`T-2026/10-12` 只读诊断报告 §3.3 用排除法锁定，本次实测复核）：
 * `sampleSessionActivity` **只认** `DSH_SESSIONS_DIR` / `DSH_HOME` 两个环境变量；
 * 插件进程里取不到 ⇒ `root === null` ⇒ 采样**从来没成功过一次**
 * （实测台账：`task.json` 的 `liveness.samples` 键从未出现、6 条 `transition:block`
 * 的 `evidence[].activity.sample_at` 全是 `null`）⇒ 「会话文件在增长」这条证据
 * **恒等于零**，退回到老三条台账判据、一次安静即冻结。
 *
 * 候选按"越具体越先试"排序，**每一个都必须真的命中 `<sid>/session.v4.jsonl.zstd` 才认**
 * —— 猜错目录只会退化成"没证据"，不会误判活着。
 *
 * @param {object} [env] - 默认 `process.env`
 * @param {string} [home] - 默认 `os.homedir()`（便于自测固定）
 * @returns {string[]} 去重后的候选根目录（可能为空数组）
 */
export function sessionsRootCandidates(env = process.env, home = homedir()) {
  const out = []
  const push = (p) => {
    if (typeof p === 'string' && p.length > 0 && !out.includes(p)) out.push(p)
  }
  push(env?.DSH_SESSIONS_DIR)
  if (typeof env?.DSH_HOME === 'string' && env.DSH_HOME.length > 0) push(join(env.DSH_HOME, 'sessions'))
  // profile 目录形状 `<home>/profiles/<name>` ⇒ 往上两级就是 `<home>`。
  if (typeof env?.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR.length > 0) {
    push(join(dirname(dirname(env.DSH_PROFILE_DIR)), 'sessions'))
  }
  if (typeof home === 'string' && home.length > 0) push(join(home, '.dsh', 'sessions'))
  return out
}

/**
 * ★ **活动判据**（纯函数）：拿两次采样回答"这中间它动了吗"。
 *
 * @param {{atMs:number, size:number, mtimeMs:number}|null|undefined} prev - 上次采样
 * @param {{atMs:number, size:number, mtimeMs:number}|null|undefined} cur - 本次采样
 * @param {{minBytes?:number, maxMs?:number, freshMs?:number}} [opts]
 * @returns {{known:boolean, grew:boolean, conclusive:boolean, fresh:boolean, fresh_age_ms:number|null, delta_bytes:number|null, delta_ms:number|null, reason:string}}
 *   `known:false` = **本次拿不到活动证据**（不是"它没动"——别把两件事混起来）。
 *   ★ 2026-10-13 快修（②）新增 `conclusive`：`false` = 这次结论**不能单独用来判死**
 *   （首次采样、两次采样跨窗），必须走确认门。`known:false` ⇒ `conclusive` 也是 `false`。
 *   ★★ 2026-10-14 新增 `fresh`：**单样本**的"它此刻正在被写"（`mtime` 距今 ≤ `freshMs`）。
 *   它**独立于** `grew` 成立 —— 见下面那段"同窗小增量"的说明：`fresh:true` 与
 *   `grew:false` **可以同时为真**，那种组合不许被读成"它死了"。
 */
export function activityOfSamples(prev, cur, opts = {}) {
  const minBytes = Number.isInteger(opts.minBytes) && opts.minBytes >= 0 ? opts.minBytes : DEFAULT_ACTIVITY_MIN_BYTES
  const maxMs = Number.isInteger(opts.maxMs) && opts.maxMs > 0 ? opts.maxMs : DEFAULT_ACTIVITY_MAX_MS
  const freshMs = Number.isInteger(opts.freshMs) && opts.freshMs > 0 ? opts.freshMs : DEFAULT_ACTIVITY_FRESH_MS
  if (cur === null || cur === undefined || !Number.isFinite(cur.size) || !Number.isFinite(cur.atMs)) {
    return { known: false, grew: false, conclusive: false, fresh: false, fresh_age_ms: null, delta_bytes: null, delta_ms: null, reason: `拿不到会话日志（${SESSION_LOG_NAME}）—— 没有活动证据，不等于它没动` }
  }
  /**
   * ★★ **2026-10-13 快修（②）：单样本的"它此刻正在被写"判据**。
   *
   * `mtime` 比 `atMs` 新不超过 `freshMs` ⇒ 这个文件**刚刚被写过**。
   * 这是本次唯一一条**不需要两次采样**的阳性证据 —— 正是"席位在写交接物、
   * 期间没有任何工具调用"那种形状唯一的救命判据（见 {@link DEFAULT_ACTIVITY_FRESH_MS}）。
   * `mtimeMs` 从 B2 起就一直被 `sampleSessionLog` 采下来，只是一直没人用。
   */
  const freshAgeMs = Number.isFinite(cur.mtimeMs) ? cur.atMs - cur.mtimeMs : null
  const fresh = freshAgeMs !== null && freshAgeMs >= 0 && freshAgeMs <= freshMs
  const freshAge = Number.isFinite(freshAgeMs) ? Math.max(0, Math.round(freshAgeMs)) : null
  const freshTxt = `会话日志刚刚被写过（mtime 距今 ${formatDuration(Math.max(0, Math.round(freshAgeMs ?? 0)))} ≤ ${formatDuration(freshMs)}）`
  if (prev === null || prev === undefined || !Number.isFinite(prev.size) || !Number.isFinite(prev.atMs)) {
    // ★ 首次采样：只建立基线。但"刚刚被写过"是**单样本**证据，不受基线缺失影响。
    return fresh
      ? { known: true, grew: true, conclusive: true, fresh, fresh_age_ms: freshAge, delta_bytes: null, delta_ms: null, reason: `首次采样（只建立基线），但${freshTxt} ⇒ 仍在活动` }
      : { known: true, grew: false, conclusive: false, fresh, fresh_age_ms: freshAge, delta_bytes: null, delta_ms: null, reason: '首次采样：只建立基线，不据此判断死活' }
  }
  const deltaMs = cur.atMs - prev.atMs
  const deltaBytes = cur.size - prev.size
  if (deltaMs <= 0 || deltaMs > maxMs) {
    // ★ 两次采样没能覆盖成"刚才"这一段。**不许**因此就判它安静：
    //   ① 只要这一段里文件确实长了（≥ 阈值）⇒ 它**在这个窗口内仍在增长**，就是本次要补的那条证据；
    //   ② 或者 mtime 显示它刚刚被写过 ⇒ 同样算活着。
    const moved = deltaBytes >= minBytes
    if (moved || fresh) {
      return {
        known: true,
        grew: true,
        conclusive: true,
        fresh,
        fresh_age_ms: freshAge,
        delta_bytes: deltaBytes,
        delta_ms: deltaMs,
        reason: moved
          ? `两次采样相隔 ${formatDuration(deltaMs)}（超窗口 ${formatDuration(maxMs)}），但会话日志这一段里 +${deltaBytes} 字节 ⇒ 窗口内仍在增长`
          : `两次采样相隔 ${formatDuration(deltaMs)}（超窗口 ${formatDuration(maxMs)}），但${freshTxt} ⇒ 仍在活动`,
      }
    }
    // ★ 没长也没动过：这才是**实证的安静**（旧行为不变 —— 真死席位照旧判死）。
    return {
      known: true,
      grew: false,
      conclusive: true,
      fresh,
      fresh_age_ms: freshAge,
      delta_bytes: deltaBytes,
      delta_ms: deltaMs,
      reason: `两次采样间隔 ${formatDuration(deltaMs)} 超出窗口 ${formatDuration(maxMs)} —— 这一段不算"刚才还在动"`,
    }
  }
  const grew = deltaBytes >= minBytes
  /**
   * ★★ **P1-6 修复（2026-10-14）：这一格的 `fresh` 必须被单独报出去。**
   *
   * 现场（本格就是根因）：两次采样**落在同一个活动窗口内**（间隔 ≤ 2 分），但这段
   * 增量小于 `minBytes`（1024 B）—— 于是这里回 `grew:false, conclusive:true`。
   * 而 `mtime` 可能就在**几秒前**（席位刚刚写完报告、正要交交接物），上面三条
   * 分支全都认这条证据，**只有这一格把它丢掉了**。
   *
   * 为什么这里**不**直接把 `grew` 改成 `deltaBytes >= minBytes || fresh`：
   *   `grew:false` 是**既有断言**（`quickfix-20261013-check` ②-4b、
   *   `t14-fix-check` 的"活动阈值是实数"那条），而"同窗小增量不算在活动"这条
   *   in-window 语义本身没有错 —— 不动的席位在 30 秒里只长 100 字节，确实不该
   *   直接被读成"它在活跃工作"。
   * 所以口径拆成两个**互不冒充**的结论：
   *   · `grew`   = 「按字节增量判，它这一段在长」；
   *   · `fresh`  = 「按 mtime 判，这个文件**此刻正在被写**」（单样本阳性）。
   * 冻结那一边（`seatLiveness`）拿 `fresh` 当"这一次观察不算实证的安静"，
   * 于是"刚要交交接物的那几十秒"不会再被**一次观察**判死。
   */
  return {
    known: true,
    grew,
    conclusive: true,
    fresh,
    fresh_age_ms: freshAge,
    delta_bytes: deltaBytes,
    delta_ms: deltaMs,
    reason: grew
      ? `会话日志在活动：${formatDuration(deltaMs)} 内 +${deltaBytes} 字节`
      : `会话日志没长（${formatDuration(deltaMs)} 内 ${deltaBytes >= 0 ? '+' : ''}${deltaBytes} 字节 < 阈值 ${minBytes}）`,
  }
}

/**
 * 找一条会话的 `session.v4.jsonl.zstd`（**只读探测**：找不到就返回 null，不抛）。
 *
 * 为什么按"扫一层目录"而不是拼路径：会话目录名是**工作目录的编码**
 * （`--~-.dsh-profiles-desktop--`），编码规则属于宿主实现细节，
 * 拼错了会得到一个"永远 stat 不到"的路径 —— 那会让本判据静默失效。
 *
 * ★ 2026-10-13 快修（②）：`sessionsRoot` 现在也接受**候选根数组**（见
 *   {@link sessionsRootCandidates}）—— 逐个试，命中即返回。传字符串时行为与改前逐字相同。
 *
 * @param {string|string[]} sessionsRoot - 例如 `~/.dsh/sessions`（或它的候选列表）
 * @param {string} sessionId
 * @returns {string|null}
 */
export function findSessionLog(sessionsRoot, sessionId) {
  const roots = (Array.isArray(sessionsRoot) ? sessionsRoot : [sessionsRoot])
    .filter((r) => typeof r === 'string' && r.length > 0)
  const sid = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
  if (roots.length === 0 || sid === null) return null
  // ★ 会话目录名的前缀不总是带 `session-`（实测 `<root>/<bucket>/` 下既有
  //   `session-…` 也有裸 UUID 目录）⇒ 两种都试一次，避免"差一个前缀就永远采不到"。
  const names = sid.startsWith('session-') ? [sid, sid.slice('session-'.length)] : [sid, `session-${sid}`]
  for (const root of roots) {
    try {
      if (!existsSync(root)) continue
      for (const bucket of readdirSync(root)) {
        for (const name of names) {
          const p = join(root, bucket, name, SESSION_LOG_NAME)
          if (existsSync(p)) return p
        }
      }
    } catch {
      // 这个候选根读不动就换下一个 —— 不抛、不静默判死。
      continue
    }
  }
  return null
}

/**
 * 采样一条会话日志的 size / mtime（**只读**；stat 不到就返回 null）。
 *
 * @param {string|null} logPath
 * @param {number} atMs
 * @returns {{atMs:number, size:number, mtimeMs:number}|null}
 */
export function sampleSessionLog(logPath, atMs) {
  if (typeof logPath !== 'string' || logPath.length === 0) return null
  try {
    const st = statSync(logPath)
    return { atMs, size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

/**
 * ★ **哪些状态下"该轮到谁动"**。
 *
 * 只列**有唯一明确责任人**的状态。没列到的状态（待分配 / 待计划 / 已通过 /
 * 各等待态 / 已阻塞 / 已取消 / 已关闭）一律**不报失联** —— 那些状态下
 * "没人说话"是正常的（活儿还没派、或者正在等别人）。
 *
 * ★ 防误报：`developing` 只列 `writer`。审核即便刚被双轨派活、一直没吭声，
 *   也不会在这里被判失联 —— 它的轮次还没到。
 */
export const EXPECTED_ROLES_BY_STATE = {
  analyzing: ['orchestrator'],
  planning: ['planner'],
  developing: ['writer'],
  testing: ['tester'],
  reviewing: ['reviewer'],
  returned_to_dev: ['writer'],
  returned_to_test: ['tester'],
  ready_plan: ['planner'],
  ready_dev: ['writer'],
  ready_test: ['tester'],
  ready_review: ['reviewer'],
}

/**
 * 席位键。
 *
 * ★ 口径**必须**与项目既有的一致（`lib/store/records.js` 里的 `const seatKey = seat || role`）：
 *   编写席位的 id **本身就是全限定**的（`writer#1`），非编写角色的 `seat` 是 `null`。
 *   所以这里**不是** `${role}#${seat}` —— 那会造出 `writer#writer#1` 这种键，
 *   与 `writer_submissions` / `seat_handover.payload.from_seat` 全部对不上。
 *
 * @param {string} role
 * @param {string|null} [seat]
 * @returns {string}
 */
export function seatKey(role, seat = null) {
  const s = typeof seat === 'string' && seat.length > 0 ? seat : ''
  return s.length > 0 ? s : String(role ?? '')
}

/** 把 ISO 字符串或数字收敛成毫秒数；取不到时 null（**不猜**）。 */
export function msOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/**
 * 写一条派活记录（**纯函数**：返回新数组，不改入参）。
 *
 * 同一个 (role, seat) 重复派活时**覆盖**旧记录（最新一次派活才是有意义的计时起点 ——
 * 重派之后不该还按上一次的时间算超时）。
 *
 * @param {Array<object>|null|undefined} list - `task.dispatched`
 * @param {object} entry
 * @param {string} entry.role
 * @param {string|null} [entry.seat]
 * @param {string|null} [entry.agentId]
 * @param {string|null} [entry.token]
 * @param {string} [entry.at] - ISO 时间戳
 * @param {number} [entry.atMs]
 * @param {string} [entry.via] - 通道（subagent / manual）
 * @returns {Array<object>}
 */
export function upsertDispatch(list, entry) {
  const arr = Array.isArray(list) ? list : []
  const role = String(entry?.role ?? '')
  const seat = typeof entry?.seat === 'string' && entry.seat.length > 0 ? entry.seat : null
  const key = seatKey(role, seat)
  const rec = {
    key,
    role,
    seat,
    agent_id: typeof entry?.agentId === 'string' && entry.agentId.length > 0 ? entry.agentId : null,
    /**
     * ★ **会话 id**（真实会话通道下 = 侧栏里那个一等公民会话）。
     * 与 `agent_id` 分开记：一个是"进程内身份"，一个是"用户能点开的会话"——
     * 失联提示要指到后者，用户才知道该去看哪一条。
     */
    session_id: typeof entry?.sessionId === 'string' && entry.sessionId.length > 0 ? entry.sessionId : null,
    token: typeof entry?.token === 'string' && entry.token.length > 0 ? entry.token : null,
    at: typeof entry?.at === 'string' ? entry.at : null,
    at_ms: typeof entry?.atMs === 'number' ? entry.atMs : msOf(entry?.at),
    via: typeof entry?.via === 'string' ? entry.via : '',
  }
  const out = []
  let replaced = false
  for (const raw of arr) {
    const rRole = String(raw?.role ?? '')
    const rSeat = typeof raw?.seat === 'string' && raw.seat.length > 0 ? raw.seat : null
    if (seatKey(rRole, rSeat) === key) {
      out.push(rec)
      replaced = true
    } else {
      out.push(raw)
    }
  }
  if (!replaced) out.push(rec)
  return out
}

/**
 * 该席位自派活之后**有没有活着的证据**。
 *
 * 顺序按"最硬的证据在前"：交接物 > 席位提交表 > 自报水位 > 历史流水 > 继任。
 *
 * @param {object} task
 * @param {{role:string, seat:string|null, atMs:number|null}} entry
 * @returns {string|null} 证据描述；null = 查不到任何证据
 */
export function evidenceOfLife(task, entry) {
  const role = String(entry?.role ?? '')
  const seat = entry?.seat ?? null
  const at = entry?.atMs
  const since = (iso) => {
    if (at === null || at === undefined) return true // 没有起点就没法比 —— 一律算"比它新"
    const t = msOf(iso)
    return t === null ? true : t >= at
  }

  // ① 交接物：最硬的证据（席位真的产出东西了）
  const handoffs = Array.isArray(task?.handoffs) ? task.handoffs : []
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i]
    if (String(h?.from_role ?? '') === role && since(h?.created_at)) {
      return `交接物 ${String(h?.kind ?? '?')}（${String(h?.created_at ?? '')}）`
    }
  }

  // ② 编写席位提交表（按 seat 精确匹配 —— 多席位时不会互相顶替）
  if (seat !== null) {
    const subs = task?.writer_submissions
    if (subs !== null && typeof subs === 'object') {
      const mine = subs[seat]
      if (mine !== undefined && mine !== null && since(mine.at)) return `席位提交（${String(mine.at ?? '')}）`
    }
  }

  // ③ 自报上下文水位（席位主动说话的一种）
  const reports = Array.isArray(task?.context_reports) ? task.context_reports : []
  for (let i = reports.length - 1; i >= 0; i--) {
    const r = reports[i]
    if (String(r?.role ?? '') === role && since(r?.at)) return `水位自报（${String(r?.at ?? '')}）`
  }

  // ④ 历史流水：该角色**自己**触发过的动作（actor 是角色名）
  const history = Array.isArray(task?.history) ? task.history : []
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]
    if (String(h?.actor ?? '') === role && since(h?.at)) return `流水 ${String(h?.action ?? '')}（${String(h?.at ?? '')}）`
  }

  // ⑤ 继任：老席位被换班之后不该再催（换班本身就是处置）
  const successions = Array.isArray(task?.successions) ? task.successions : []
  for (let i = successions.length - 1; i >= 0; i--) {
    const s = successions[i]
    if (String(s?.role ?? '') === role && since(s?.at)) return `已继任（${String(s?.at ?? '')}）`
  }

  return null
}

/**
 * ★ 算一次失联检测（**纯函数**：不读盘、不写盘、不抛异常）。
 *
 * @param {object|null} task
 * @param {number} [now] - 当前毫秒时间（自测要固定它）
 * @param {object} [opts]
 * @param {number} [opts.silenceMs] - 静默阈值
 * @param {object|null} [opts.activity] - ★ B2：本次**现采**的会话日志样本
 *   `{ [seatKey]: {atMs,size,mtimeMs}|null }`（拿不到就整份给 null —— 不是给空对象）
 * @param {number} [opts.confirmations] - 拿不到活动证据时，连续几次安静才冻结
 * @returns {{silenceMs:number, state:string, state_zh:string, expected:string[], seats:Array<object>, silent:Array<object>, pending:Array<object>, ok:boolean, summary:string}}
 */
export function seatLiveness(task, now = Date.now(), opts = {}) {
  const silenceMs =
    Number.isInteger(opts.silenceMs) && opts.silenceMs > 0 ? opts.silenceMs : DEFAULT_SEAT_SILENCE_MS
  const confirmations =
    Number.isInteger(opts.confirmations) && opts.confirmations >= 1 ? opts.confirmations : DEFAULT_SILENCE_CONFIRMATIONS
  /**
   * ★ **确认门是否适用**（B2 的"不许只凭一次安静就冻结"要有适用范围，别变成"关掉检测"）。
   *
   * 规则（写死在这里，别再各处理解一遍）：
   *   · `opts.gateApplicable === true` —— **本任务的活动采样是"本来做得到"的**
   *     （至少一个已派席位带 `session-…` 形状的会话 id，或至少采到一条日志）；
   *     这时"拿不到证据"是**偶发缺失** ⇒ 必须连续 `confirmations` 次都没有活动证据才冻结。
   *   · `false` / 未给 —— 本任务**结构上采不到**活动（台账里根本没有会话 id、
   *     或会话目录不可达）⇒ 退回原来的台账三条判据，一次安静即可冻结，
   *     并在处置留痕里写明 `activity_known:false`（**不许假装看过日志**）。
   */
  const gateOn = confirmations >= 2 && opts.gateApplicable === true
  /** 现采样本；`null`/`undefined` = 本次**根本拿不到**活动证据（≠"它没动"）。 */
  const activity = opts.activity !== null && typeof opts.activity === 'object' ? opts.activity : null
  const prevSamples =
    task?.liveness?.samples !== null && typeof task?.liveness?.samples === 'object' ? task.liveness.samples : {}
  const quietMap =
    task?.liveness?.quiet !== null && typeof task?.liveness?.quiet === 'object' ? task.liveness.quiet : {}
  const state = String(task?.state ?? '')
  /** ★ A4：本次有没有拿到活动证据（`false` ⇒ 摘要素写成"拿不到会话日志"，不许写"它没在长"）。 */
  const activityKnownHere = activity !== null
  const expected = Array.isArray(EXPECTED_ROLES_BY_STATE[state]) ? EXPECTED_ROLES_BY_STATE[state] : []
  const list = Array.isArray(task?.dispatched) ? task.dispatched : []

  const seats = []
  const silent = []
  const pending = []
  for (const raw of list) {
    const role = String(raw?.role ?? '')
    if (role.length === 0) continue
    const seat = typeof raw?.seat === 'string' && raw.seat.length > 0 ? raw.seat : null
    const key = seatKey(role, seat)
    const atMs = typeof raw?.at_ms === 'number' ? raw.at_ms : msOf(raw?.at)
    const isExpected = expected.includes(role)
    const evidence = evidenceOfLife(task, { role, seat, atMs })
    // ★ B2：第四条判据 —— 会话日志还在长吗？（优先级最高，因为它是最硬的"它还在动"）
    const act = activityOfSamples(
      prevSamples[key] ?? null,
      activity === null ? null : activity[key] ?? null,
      opts.activityOpts ?? {},
    )
    const alive = act.grew === true
    // ★ 活动采样命中 ⇒ 把静默计时**从这次活动重新起算**（"它一直在动"不该被算成静默）。
    const clock = alive && Number.isFinite(activity?.[key]?.atMs) ? activity[key].atMs : atMs
    const elapsedMs = clock === null ? null : Math.max(0, now - clock)
    const quiet = Number.isInteger(quietMap[key]) && quietMap[key] >= 0 ? quietMap[key] : 0
    const timedOut = elapsedMs !== null && elapsedMs >= silenceMs
    /**
     * ★★ **P1-6 修复（2026-10-14）：「正在写交付」的席位不许被判失联并冻结。**
     *
     * 现象（本机实测，见 `_cprobe/p16-probe.mjs`）：席位派活很久、台账里还没有任何
     * 交接物（**它正要交的那一份还没落盘**），而它的会话日志 `mtime` **就在几秒前**
     * —— 也就是"写完报告、正要交交接物的那几十秒"。改前这一格照样被冻结：
     *   · 两次采样**落在同一个活动窗口内**（间隔 ≤ 2 分）；
     *   · 这段里的字节增量 **< `minBytes`（1024 B）** ⇒ `grew:false`；
     *   · 而 `activityOfSamples` 的"同窗小增量"那一格**把 mtime 证据丢掉了**，
     *     并且回的是 `conclusive:true` ⇒ **绕过确认门 ⇒ 一次观察即冻结**。
     * 后果是真实损失：任务在席位**发出交付调用之前**被推成「已阻塞」，
     * 那份 `test_to_review`（`T-20261012-6884af`）因此**从未落盘**。
     *
     * 判据（**只加一条阳性证据，不动任何阈值**）：
     *   `fresh === true`（`mtime` 距今 ≤ {@link DEFAULT_ACTIVITY_FRESH_MS}，60 秒）
     *   ⇒ 这个文件**此刻正在被写** ⇒ 这一次观察**不算实证的安静**：
     *   既不冻结，也**不累计**"连续没证据"的计数（计数归零 —— 席位刚回来动了一下，
     *   不该把它之前那段安静接着数下去，否则"它刚复活"会被读成"安静两轮了"）。
     *
     * ★★ 铁律（一个字都没动）：
     *   · **静默阈值仍是 {@link DEFAULT_SEAT_SILENCE_MS}（5 分）**，`silenceMs` 一毫秒没改；
     *   · **既有反例照旧判死**：真死席位的日志不再被写 ⇒ `mtime` 很快越过 60 秒
     *     ⇒ `fresh:false` ⇒ 走原来那条路（该一次判死的一次判死，该走确认门的走确认门）。
     *     60 秒这条线**本来就写着**"必须远小于静默阈值，否则等于把检测关掉"
     *     （见 {@link DEFAULT_ACTIVITY_FRESH_MS} 的取值理由）—— 本修复把这个界守住了，
     *     没有把它放宽成"多久都算活"。
     *   · 只认 `fresh`，**不认**"增量为正"之类更松的口径 —— `grew` 的语义一个字没改。
     */
    const freshWrite = act.fresh === true
    let silentHere = timedOut && isExpected && evidence === null && !alive && !freshWrite
    let pendingHere = null
    /**
     * ★★ **2026-10-13 快修（②，P0-2/P0-3）**：
     *
     *   · 门条件从 `act.known !== true` 改成 `act.conclusive !== true`。
     *     旧写法把三种**其实没有实证**的形状（首次采样、两次采样跨窗、时钟回退）
     *     当成"测到了、没长" ⇒ **绕过确认门、一次观察即冻结**。正是"正在写文件造成的
     *     静默"被判死的那条路径。现在这三种形状一律走确认门。
     *   · ⚠️ **反例一个字没动**：「同一窗口内测到没长」与「跨窗且文件完全没动过」
     *     仍然是 `conclusive:true` ⇒ 真死席位照旧一次判死（`t14-fix-check` 的反例②）。
     *     ★ P1-6 修复后这一条要连着 `fresh` 一起读：`conclusive:true` 仍然成立，
     *     但那两格里真死席位的 `fresh` 都是 `false`（mtime 早已陈旧）⇒ 行为不变。
     *   · `quiet + 1` 这个计数**在 pending 时也必须落盘**（下面 `quiet_streak`），
     *     否则计数器永远回不到 `confirmations` ⇒ 门一旦开着就**永不冻结**
     *     （等于把检测静默关掉 —— 那正是 6884af 诊断报告 §3.2⑦ 点名的独立缺陷）。
     */
    if (silentHere && gateOn && act.conclusive !== true && quiet + 1 < confirmations) {
      // ★ 用户原话：「拿不到活动证据时**不许只凭一次安静**就冻结」。
      silentHere = false
      pendingHere = `第 ${quiet + 1}/${confirmations} 次观察：没有可用来判死的活动证据（${act.reason}）—— 再观察一次，本轮不冻结`
    }
    const rec = {
      key,
      role,
      role_zh: roleLabel(role),
      seat,
      agent_id: raw?.agent_id ?? null,
      session_id: raw?.session_id ?? null,
      at: raw?.at ?? null,
      at_ms: atMs,
      elapsed_ms: elapsedMs,
      elapsed_zh: elapsedMs === null ? '（没有派活时间戳）' : formatDuration(elapsedMs),
      expected: isExpected,
      evidence,
      /** ★ B2：活动采样结论（`known:false` = 本次拿不到证据，不是"它没动"）。 */
      activity: { known: act.known, grew: act.grew, conclusive: act.conclusive, fresh: act.fresh === true, fresh_age_ms: act.fresh_age_ms ?? null, delta_bytes: act.delta_bytes, delta_ms: act.delta_ms, reason: act.reason, sample_at: activity?.[key]?.atMs ?? null },
      /**
       * ★ P1-6：这一次观察有没有拿到**单样本**的阳性证据（"文件此刻正在被写"）。
       *   它**不是** `alive`（`alive` 只看字节增量）：两个口径互不冒充。
       */
      fresh_write: freshWrite,
      /** ★ P1-6：这一次观察算不算"没有实证的安静"（它才是决定冻不冻的那一个比特）。 */
      quiet_evidence: silentHere,
      /**
       * ★ 连续"没有实证"的次数（本次之后）。
       *   ★ 2026-10-13 快修（②，P0-3）：**pending 也要 +1**。旧写法 `silentHere ? quiet+1 : 0`
       *   在 pending 分支写回 0 ⇒ 下一次读回来还是 0 ⇒ 永远凑不满 `confirmations`
       *   ⇒ 门开着的时候机制**一个席位都冻不掉**（静默把检测关掉）。
       */
      quiet_streak: silentHere || pendingHere !== null ? quiet + 1 : 0,
      silent: silentHere,
    }
    seats.push(rec)
    if (silentHere) silent.push(rec)
    else if (pendingHere !== null) pending.push({ ...rec, pending_reason: pendingHere })
  }

  return {
    silenceMs,
    silence_zh: formatDuration(silenceMs),
    confirmations,
    /** ★ 确认门本次是否生效（见函数内 `gateOn` 的规则）。 */
    gate_applicable: gateOn,
    /** ★ 本次有没有拿到会话活动证据（`false` ⇒ 判据会更保守，见 `confirmations`）。 */
    activity_known: activity !== null,
    state,
    state_zh: STATE_LABEL[state] ?? state,
    expected,
    seats,
    silent,
    pending,
    ok: silent.length === 0,
    summary: describeSilentSeats(silent, {
      state,
      state_zh: STATE_LABEL[state] ?? state,
      silenceMs,
      // ★ 把任务 id 传下去：处置动作要写成"可以直接复制去调"的形式
      taskId: typeof task?.id === 'string' ? task.id : '',
      /**
       * ★★ **A4 补丁（2026-10-12 · writer#1）：本次到底有没有拿到会话日志。**
       *
       * `describeSilentSeats` 里那一支（"并且**这一次拿不到会话日志**"）本来就存在，
       * 但这里**一直没传** ⇒ 它永远走不到，正文永远声称"会话日志也没在长"。
       * 那是**把"拿不到证据"说成了"它没动"** —— 与审计里 `activity_known:false` 自相矛盾。
       */
      activityKnown: activityKnownHere,
    }),
  }
}

/** 毫秒 → 人话时长（`4 分 30 秒` / `2 小时 5 分`）。 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000))
  if (total < 60) return `${total} 秒`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s === 0 ? `${m} 分` : `${m} 分 ${s} 秒`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm === 0 ? `${h} 小时` : `${h} 小时 ${mm} 分`
}

/**
 * ★ **"下一步可执行动作"** —— 失联被报出来时，必须同时告诉主对话"现在能调什么"。
 *
 * 为什么这一条不能省：用户原话是「**切断后自己能意识到，然后重新输出正确内容**」。
 * 只报"它失联了"而不给可执行动作，等于让人自己猜 —— 那不是机制，是提示。
 *
 * ⚠️ 诚实的边界（写在这里，别在别处又吹一遍）：
 *   · **重派**是唯一**必然可用**的恢复路径（席位已死，它给不出任何东西）；
 *   · **换班**（`pipeline_succession`）要求该席位**先产出过 `seat_handover` 交接物** ——
 *     席位秒死时它根本没来得及交，所以这条**通常不可用**，必须标注清楚；
 *   · 人工/取消两条永远可用。
 *
 * @param {Array<object>} silent - `seatLiveness().silent`
 * @param {{taskId?:string}} [ctx]
 * @returns {string[]} 逐行的可执行动作（空数组 = 没有失联）
 */
export function nextActionsFor(silent, ctx = {}) {
  const list = Array.isArray(silent) ? silent : []
  if (list.length === 0) return []
  const taskId = String(ctx.taskId ?? '<任务id>')
  const out = ['★ **下一步（可直接调，择一）**：']
  for (const s of list) {
    const seatField = s.seat === null ? '' : `, seat: "${s.seat}"`
    out.push(
      `  · **重派同一席位**（推荐 —— 唯一必然可用的恢复路径）：` +
        `pipeline_dispatch { task_id: "${taskId}", role: "${s.role}"${seatField}, reassign: true }` +
        `　⇒ 任务若在「已阻塞」会**先自动恢复到阻塞前的状态**，且**不消耗打回预算**。`,
    )
    out.push(
      `  · 换人接着干：pipeline_succession { task_id: "${taskId}", role: "${s.role}", seat: "${s.seat ?? s.role}" }` +
        `　★ **仅当该席位留下过 「seat_handover」 交接物时可用** —— 席位秒死时它根本没来得及交，这条通常不可用。`,
    )
  }
  out.push('  · 升级给用户：pipeline_human_request（由执行角色发起；主对话用 pipeline_human_relay 转告）。')
  out.push(`  · 放弃这个任务：pipeline_transition { task_id: "${taskId}", event: "cancel" }。`)
  return out
}

/**
 * 把失联席位写成**给人看的一句话**（没有失联时给空串）。
 *
 * ★ 处置动作**不再在这里手写**：统一走 {@link nextActionsFor}。
 *   为什么：早先这里有一份手写的三步清单（重派 / 换班 / 取消），后来 `nextActionsFor`
 *   又写了一份更准的（标出了"换班在席位秒死时通常不可用"）—— **两份清单并存就会互相矛盾**，
 *   而主对话只会照其中一份做。判据只能有一个源。
 *
 * @param {Array<object>} silent
 * @param {{state?:string, state_zh?:string, silenceMs?:number, taskId?:string}} [ctx]
 * @returns {string}
 */
export function describeSilentSeats(silent, ctx = {}) {
  const list = Array.isArray(silent) ? silent : []
  if (list.length === 0) return ''
  const head =
    `⚠ **席位失联**：任务停在「${String(ctx.state_zh ?? ctx.state ?? '?')}」，` +
    `但该动的席位已经静默超过 ${ctx.silenceMs === undefined ? '' : formatDuration(ctx.silenceMs)}，` +
    '且**没有任何活着的证据**（0 交接物、0 流水、0 水位自报，' +
    `${ctx.activityKnown === false ? '并且**这一次拿不到会话日志**' : `会话日志 ${SESSION_LOG_NAME} 也没在长`}）。\n`
  const rows = list
    .map(
      (s) =>
        `  · ${s.role_zh}${s.seat === null ? '' : `（${s.seat}）`}：派活于 ${String(s.at ?? '?')}，` +
        `已静默 ${String(s.elapsed_zh ?? '?')}${s.agent_id === null ? '' : `，会话 ${s.agent_id}`}`,
    )
    .join('\n')
  return (
    head +
    rows +
    '\n★ 这**不是**"它还在想" —— 是它可能已经死了（宿主侧崩溃 / 会话被切 / 派活失败），而没人发现。\n' +
    nextActionsFor(list, { taskId: ctx.taskId }).join('\n')
  )
}

// ===========================================================================
// ★★ 误判**自愈** —— "座位其实活着"时，把那次误判造成的阻塞**收回**
// ===========================================================================
//
// ---------------------------------------------------------------------------
// 现场（2026-10-14 今晚，同一类第 5 次；后果最重的一次）
// ---------------------------------------------------------------------------
// 形状：席位**在干活、但不产那三类证据**（交接物 / 流水 / 水位自报）⇒ 5 分钟静默
// 阈值把它判「失联」⇒ 机制自动把任务推到「已阻塞」⇒ 而**阻塞态下 `dev_submitted`
// 这类唯一出口根本不合法** ⇒ **已经干完的活交不上去**。
//
// 实证（逐字来自线上台账，不是我转述）：
//   · `.pipeline/T-20261011-5a871c/audit.jsonl` 2026-10-14T11:02:20Z 的
//     `transition:unblock` 备注：「检查发现又被失联误报推成「已阻塞」，导致
//     "编写交测试（dev_submitted）"这一唯一出口在当前状态不合法 ⇒ 那件已干完的活
//     交不上去。」
//   · 同刻实测该席位会话日志仍在长：`writer#1` 样本
//     `size=351292`、`session.v4.jsonl.zstd` 6 秒内 **+12611 字节**
//     （复算命令见本轮 `_probe/p4-live.mjs`，判据与线上同一条）。
//
// ---------------------------------------------------------------------------
// 机制缺的那一环：**冻结是一次性的，收回却只能靠人**
// ---------------------------------------------------------------------------
// {@link activityOfSamples} 明明能在**下一次观察**就看见"它的会话日志还在长"，
// 但那个结论只被用来**阻止新的冻结**（`silentHere = … && !alive`），
// **没有人**拿它去检查**已经发生过的**冻结是不是错的。于是每误判一次，就要人
// （或主对话）手工 `pipeline_transition { event: "unblock" }` 一次 —— 机制自己
// 一句话都不说，状态页上写的就是「已阻塞」。
//
// ---------------------------------------------------------------------------
// 判据（**纯函数**；采样仍由 store 层做，判据只吃数字）
// ---------------------------------------------------------------------------
// 把 `task.liveness.escalations[]` 里**最后一条**拿出来（那一份台账**只由**
// `store.checkLiveness` 的自动阻塞分支写入 ⇒ 它天然就是"机制自己推的那次阻塞"，
// 人工/用户指示的阻塞不会进这个数组），逐席问一句：
//
//   「它现在有没有**阳性**的存活证据？」
//     阳性 = `activity.grew === true`
//       —— 会话日志在长，或 `mtime` 显示它此刻正在被写（见 {@link activityOfSamples}）。
//
// 只有**该次处置点名的每一个席位都阳性**，才允许收回。
//
// ★★ 反例红线（**一个字都不许放宽** —— 用户点名不许）：
//   · **真死掉的席位**：会话日志不再增长、`mtime` 也旧 ⇒ `grew === false`
//     ⇒ 拿不到任何阳性证据 ⇒ 本函数**一个字节都不动**（不改状态、连"疑似误判"
//     都不写），任务照旧停在「已阻塞」，等人处理。真失联的判定**没有被动过**。
//   · `known:false`（这一次拿不到日志）**不算阳性** —— "看不见"永远不写成"它还活着"。
//   · 点名席位里**只要有一个**仍拿不到阳性证据 ⇒ **只留痕、不自动收回**
//     （那一个可能是真的死了，状态决定权留给主对话）。
//   · 只有在**恢复点仍在**（`task.previous_state` 与那次处置记的 `previous_state`
//     逐字相等）时才自动收回；期间有人动过状态 ⇒ 只留痕。
//
// ★ 判据**只有一个源**：本条与"不许只凭一次安静就冻结"读的是同一个
//   {@link activityOfSamples} 结论，不另起一套"心跳"口径 —— 两套口径并存迟早互相矛盾。

/**
 * ★ **权威来源**（写给"存活判据取自哪"这个问题，别再各处猜一遍）：
 *
 *   **DSH 宿主的会话存储**：`~/.dsh/sessions/<工作目录编码>/<会话id>/session.v4.jsonl.zstd`
 *   （文件名见 {@link SESSION_LOG_NAME}）—— 宿主自己一边跑会话一边写这一个文件，
 *   **与流水线台账完全无关**，所以席位"纯工作"（读源码、逐文件算哈希、跑命令）
 *   期间它照样在长。
 *
 * 定位：{@link findSessionLog}（候选根见 {@link sessionsRootCandidates}，扫一层 bucket，
 *   不拼路径）；采样：`lib/store.js` 的 `sampleSessionActivity`；取数：{@link sampleSessionLog}。
 * 判据：{@link activityOfSamples}（size 增长 / mtime 新鲜度两路，任一成立即为阳性）。
 *
 * ⚠️ 诚实边界：这是一条**文件级**证据（"这个会话的日志在写"），不是"这个席位正在
 *    正确地思考"。它只能证明**会话没死**，不能证明它在做对的事 —— 后者靠交接物/流水。
 */
export const LIVENESS_ACTIVITY_SOURCE = 'DSH 会话存储 ~/.dsh/sessions/<bucket>/session-…/session.v4.jsonl.zstd 的 size / mtime'

/**
 * ★ **误判自愈判据**（纯函数：不读盘、不写盘、不抛）。
 *
 * @param {object|null} task
 * @param {object|null} live - {@link seatLiveness} 的结果（要它的 `seats[].activity`）
 * @param {{atMs?:number}} [opts]
 * @returns {{applicable:boolean, suspects:Array<object>, basis:string, can_unblock:boolean,
 *   will_return_to:string|null, escalation_at:string|null, already:boolean, reason:string}}
 *   `applicable:false` = 本次**没有**"疑似误判"要写（不是"查不到"）；
 *   `suspects` 非空 = 有席位拿到了**阳性**存活证据，`basis` 是人话依据（写进 audit）。
 */
export function livenessSelfHeal(task, live, opts = {}) {
  const state = String(task?.state ?? '')
  const stateZh = STATE_LABEL[state] ?? state
  /** 统一出口：把"不适用"也写成一句**能回答为什么**的话，不返回光秃秃的 false。 */
  const no = (reason, extra = {}) => ({
    applicable: false,
    suspects: [],
    basis: '',
    can_unblock: false,
    will_return_to: null,
    escalation_at: null,
    already: false,
    reason,
    ...extra,
  })

  const escs = Array.isArray(task?.liveness?.escalations) ? task.liveness.escalations : []
  if (escs.length === 0) return no('本任务没有「机制触发的席位失联」处置记录 —— 没有要收回的误判阻塞')
  const esc = escs[escs.length - 1]
  const escAt = typeof esc?.at === 'string' ? esc.at : null

  if (state !== 'blocked') {
    return no(`任务不在「已阻塞」（当前「${stateZh}」）—— 没有需要收回的阻塞`, { escalation_at: escAt })
  }
  if (String(esc?.to_state ?? '') !== 'blocked') {
    return no(`最后一条失联处置没有把任务推成「已阻塞」（to_state=${String(esc?.to_state ?? '?')}）—— 不是它的账`, { escalation_at: escAt })
  }
  if (esc?.self_heal !== undefined && esc.self_heal !== null) {
    return no('这次阻塞已经做过一次误判自愈标注 —— 不重复处置', { already: true, escalation_at: escAt })
  }
  const seats = (Array.isArray(esc?.seats) ? esc.seats : []).map((x) => String(x)).filter((x) => x.length > 0)
  if (seats.length === 0) return no('那一次失联处置没有记下席位 —— 不知道要收回谁', { escalation_at: escAt })

  const byKey = new Map()
  for (const s of Array.isArray(live?.seats) ? live.seats : []) {
    if (s === null || typeof s !== 'object') continue
    byKey.set(String(s.key ?? seatKey(s.role, s.seat)), s)
  }

  const suspects = []
  const stillQuiet = []
  for (const k of seats) {
    const s = byKey.get(k)
    const a = s?.activity ?? null
    // ★ 只认**阳性**：`grew === true`。`known:false`（拿不到日志）与"测到没长"都不算。
    if (a !== null && a.grew === true) {
      const role = String(s?.role ?? '')
      suspects.push({
        seat: k,
        role,
        role_zh: String(s?.role_zh ?? roleLabel(role)),
        session_id: typeof s?.session_id === 'string' && s.session_id.length > 0 ? s.session_id : null,
        delta_bytes: Number.isFinite(a.delta_bytes) ? a.delta_bytes : null,
        delta_ms: Number.isFinite(a.delta_ms) ? a.delta_ms : null,
        sample_at: Number.isFinite(a.sample_at) ? a.sample_at : null,
        basis: String(a.reason ?? ''),
      })
    } else {
      stillQuiet.push(k)
    }
  }

  const label = (s) => `${s.role_zh}${s.seat === s.role ? '' : `（${s.seat}）`}`
  if (suspects.length === 0) {
    return no('本次观察里，那次处置点名的席位**没有一个**拿到阳性存活证据（会话日志没长 / 拿不到日志）—— 按真失联处理，不动状态', { escalation_at: escAt })
  }
  const basis = suspects.map((s) => `${label(s)}：${s.basis}`).join('；')

  if (stillQuiet.length > 0) {
    return {
      applicable: true,
      suspects,
      basis,
      can_unblock: false,
      will_return_to: null,
      escalation_at: escAt,
      already: false,
      reason: `点名席位里仍有 ${stillQuiet.join('、')} 拿不到阳性存活证据 ⇒ **只留痕、不自动收回**（那一个可能是真的死了，状态决定权留给主对话）`,
    }
  }

  const prev = typeof task?.previous_state === 'string' && task.previous_state.length > 0 ? task.previous_state : null
  const escPrev = typeof esc?.previous_state === 'string' && esc.previous_state.length > 0 ? esc.previous_state : null
  const base = { applicable: true, suspects, basis, escalation_at: escAt, already: false }
  if (prev === null) return { ...base, can_unblock: false, will_return_to: null, reason: '账本里的恢复点缺失 ⇒ 不知道收回后回到哪个状态，**只留痕、不自动收回**' }
  if (prev !== escPrev) {
    return { ...base, can_unblock: false, will_return_to: null, reason: `恢复点与那次处置记的不一致（账本 ${prev} / 处置 ${escPrev ?? '无'}）⇒ 期间有人动过状态，**只留痕、不自动收回**` }
  }
  if (prev === 'blocked') return { ...base, can_unblock: false, will_return_to: null, reason: '恢复点指向「已阻塞」自身 ⇒ 收回会退化成空操作，**只留痕、不自动收回**' }
  return {
    ...base,
    can_unblock: true,
    will_return_to: prev,
    reason: `该次处置点名的席位**全部**拿到阳性存活证据，恢复点仍在（${prev}）⇒ 自动收回这次误判造成的阻塞`,
  }
}

/**
 * 把"疑似误判"写成**给人看的一句话**（没有疑似误判时给空串）。
 *
 * 用户原话：「让主对话**一眼能看出**」。所以这里第一行就给结论 + 席位 + 依据，
 * 不要求读的人自己去翻 `task.json`。
 *
 * @param {Array<object>} suspects - {@link livenessSelfHeal} 的 `suspects`
 * @param {{taskId?:string, state?:string, state_zh?:string, unblocked?:boolean, will_unblock?:boolean, return_to?:string|null, reason?:string}} [ctx]
 * @returns {string}
 */
export function describeSuspectedFalsePositive(suspects, ctx = {}) {
  const list = Array.isArray(suspects) ? suspects : []
  if (list.length === 0) return ''
  const taskId = String(ctx.taskId ?? '<任务id>')
  const rows = list
    .map((s) => `  · ${s.role_zh}${s.seat === s.role ? '' : `（${s.seat}）`}：${String(s.basis ?? '')}${s.session_id === null ? '' : `，会话 ${s.session_id}`}`)
    .join('\n')
  const tail =
    ctx.unblocked === true
      ? `★ **机制已自动收回**这次阻塞，恢复到「${STATE_LABEL[String(ctx.return_to ?? '')] ?? String(ctx.return_to ?? '?')}」。`
      : ctx.will_unblock === true
        ? `★ 机制**即将自动收回**这次阻塞（恢复回「${STATE_LABEL[String(ctx.return_to ?? '')] ?? String(ctx.return_to ?? '?')}」）—— 收回那一步会在同一轮里落一条独立审计。`
        : `★ 本次**只留痕、没有自动收回**：${String(ctx.reason ?? '')}`
  return (
    `⚠ **疑似误判：席位其实活着**（任务 ${taskId} 停在「${String(ctx.state_zh ?? ctx.state ?? '已阻塞')}」）\n` +
    `上一次「席位失联」处置点名的席位**现在有阳性的存活证据**：\n` +
    rows +
    `\n★ 依据（权威来源）：${LIVENESS_ACTIVITY_SOURCE}。\n` +
    `${tail}\n`
  )
}

// ===========================================================================
// 通道侧审计 —— 派活通道的**判决**必须留痕
// ===========================================================================
//
// 为什么单开这一段：通道侧有三类判决的处置都是「先上报、等用户定」——
//   · 通道不可达（缺服务）：不降级、不派活；
//   · 「完全」档被拒：默认禁用，缺一段即拒；
//   · 项目分组建不起来 / 会话建不出来 / 读回证明不了它不是子代理会话：一律按失败处理。
// 如果这些只活在**一次工具调用的返回值**里，任务停下来之后就没人能回答
// 「它为什么没派出去」。所以落进既有的只追加流水 `.pipeline/<任务>/audit.jsonl`
// （与 store 的审计同一份文件、同一种行格式），不新开机制、不新开文件。

/** 派活通道 kind 里「真实会话」这一档的名字（与 lib/transport 的 SESSION_KIND 同值）。 */
export const VIA_SESSION = 'session'

/**
 * 造一个通道侧审计出口。
 *
 * @param {{auditFile?:(taskId:string)=>string, log?:(msg:string)=>void}} [deps]
 * @returns {{record:(entry:{taskId:string, action:string, detail?:object})=>void, entries:()=>object[]}}
 */
export function createChannelAudit(deps = {}) {
  const fileOf = typeof deps.auditFile === 'function' ? deps.auditFile : null
  const log = typeof deps.log === 'function' ? deps.log : null
  /** 内存镜像：诊断与自测可读；落盘失败也不至于把判决吞掉。有界，不无限增长。 */
  const ring = []

  function record(entry) {
    const taskId = String(entry?.taskId ?? '')
    const action = String(entry?.action ?? 'unknown')
    const detail = entry?.detail !== null && entry.detail !== undefined && typeof entry.detail === 'object' ? entry.detail : {}
    ring.push({ taskId, action, detail })
    while (ring.length > 200) ring.shift()
    if (log !== null) log(`通道审计：${action}（任务 ${taskId.length === 0 ? '(未知)' : taskId}）`)
    if (fileOf === null || taskId.length === 0) return
    const line = { at: new Date().toISOString(), task_id: taskId, actor: 'channel', action, ...detail }
    try {
      appendFileSync(fileOf(taskId), `${JSON.stringify(line)}\n`, 'utf8')
    } catch (err) {
      // 审计写失败不该让判决本身失败；内存镜像里还有一份，且**说出来**，不静默。
      if (log !== null) log(`通道审计写盘失败（判决仍留在返回值与内存镜像里）：${String(err?.message ?? err)}`)
    }
  }

  return { record, entries: () => [...ring] }
}
