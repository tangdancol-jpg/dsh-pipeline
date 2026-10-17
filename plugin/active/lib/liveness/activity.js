/**
 * dsh-pipeline · **席位失联检测** · 活动判据（会话日志的 size / mtime）
 * ============================================================================
 * 从 `lib/liveness.js` 拆出来的一部分（代码原样搬过来，行为未改）；
 * 对外仍经 `lib/liveness.js` 转出，调用方不需要改 import。
 *
 * ★ {@link formatDuration} 落在这一层：{@link activityOfSamples} 的判词要用它，
 *   席位层与描述层也用它 —— 放在最底层模块，`lib/liveness/*.js` 之间才不会成环。
 *
 * @module dsh-pipeline/lib/liveness/activity
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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
