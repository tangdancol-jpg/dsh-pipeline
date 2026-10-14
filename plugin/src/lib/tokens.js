/**
 * dsh-pipeline · 角色令牌（能力凭证）
 * ============================================================================
 * 「谁在调用」这件事必须**不可自称**。本模块是让角色身份变成真机制的零件：
 *
 *   主对话派出一个角色时，`pipeline_dispatch` 铸一枚**一次性绑定**的令牌，
 *   令牌里带着 (task_id, role, 铸币时间)。这枚令牌只交给那一个角色会话。
 *
 * 于是：
 *   · 编写会话手里只有 writer 令牌 → 它伪造不出 reviewer 令牌 → 发不出审核结论；
 *   · 令牌与会话身份**二次绑定**：真实子代理通道下，令牌铸造时就记下 agentId，
 *     之后每次调用都要求 `exec.agent.id` 与之相符 → 令牌被转手也无效。
 *
 * ★ 诚实的边界（写在这里，也写进 README）：
 *   令牌机制能挡住"角色会话自己搞错/越权"，**挡不住主对话主动把别人的令牌
 *   转交出去**。主对话手里握着所有令牌，这是设计上的信任根。要收紧就把
 *   `requireAgentBinding` 打开并只走真实子代理通道 —— 那时令牌与 agent 一一
 *   对应，转手即失效。
 *
 * @module dsh-pipeline/lib/tokens
 */

import { ROLE } from './roles.js'
import { randomId } from './util.js'

/** 令牌默认有效期（毫秒）。2 小时足够跑完一个任务，又不至于永久有效。 */
export const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000

/**
 * ★「最近过期」留痕的条数上限。
 *
 * 只影响**错误文案的措辞**（见 `expiredRecently`），不参与任何放行/拒绝判定。
 */
export const EXPIRED_KEEP_MAX = 64

/**
 * 令牌表。内存态 —— 进程重启即失效，这正是想要的语义：
 * "上一次会话拿过令牌"不构成这一次的通行证。
 *
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]
 * @param {() => number} [opts.now]
 */
export function createTokenStore(opts = {}) {
  const ttlMs = Number.isInteger(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TOKEN_TTL_MS
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()

  /** @type {Map<string, {token:string, taskId:string, role:string, agentId:string|null, issuedAt:number, expiresAt:number, used:number, note:string}>} */
  const tokens = new Map()

  /**
   * ★ **最近因过期被清扫掉的令牌**（只为把「真过期」和「表里根本没有」分开说清楚）。
   *
   * 为什么必须有它：{@link sweep} 是**静默删除**的，删掉之后 `resolve()` 就再也分不清
   * 「这枚令牌 TTL 超时了」和「这枚令牌从来不存在」—— 而这两件事的**处置完全不同**：
   *   · 前者：重派一次铸枚新的即可；
   *   · 后者：通常是 **DSH 重启**导致内存态丢失（尤其主对话开单那枚），
   *           或者令牌字符串抄错/被截断/属于另一个工作区。
   *
   * 2026-10-11 的现场就是被那句合并文案（"无效或已过期"）误导，
   * 让 AI 把"重启丢失"当成"过期"，多绕了一圈才定位。
   *
   * ⚠️ 代价与边界：**有界**（最多 {@link EXPIRED_KEEP_MAX} 条，先进先出）、
   * **不落盘**、**不参与任何判定** —— 它只影响错误文案措辞。
   */
  const expiredRecently = new Map()

  /** 清掉过期项（每次读取时顺手做，不需要定时器），同时留下诊断痕迹。 */
  const sweep = () => {
    const t = now()
    for (const [k, v] of tokens) {
      if (v.expiresAt <= t) {
        tokens.delete(k)
        expiredRecently.set(k, v)
        // 有界：超了就把最早那条挤掉（只为文案，不留全量历史，避免无限增长）
        while (expiredRecently.size > EXPIRED_KEEP_MAX) {
          const oldest = expiredRecently.keys().next().value
          expiredRecently.delete(oldest)
        }
      }
    }
  }

  /**
   * ★ 造「这枚令牌不在表里」的错误 —— **必须把两种原因分开**。
   *
   * （2026-10-11 修的文案缺陷）原来两种原因共用一句
   * 「role_token 无效或已过期」，导致用户与 AI 分不清"重启丢失"和"真过期"。
   *
   * ★ 措辞纪律：**「表里没有」这一支里不许出现"过期"二字** ——
   *   它必须明确说出"重启导致的丢失，和 TTL 超时是两回事"。
   *   判据见 `tests/` 里对应的断言（文案含"重启"且不含"过期"）。
   *
   * @param {string} token
   * @returns {{ok:false, error:string, expired:boolean}}
   */
  const missingTokenError = (token) => {
    const gone = expiredRecently.get(token)
    if (gone !== undefined) {
      const ttlMin = Math.round((gone.expiresAt - gone.issuedAt) / 60000)
      const overMin = Math.max(0, Math.round((now() - gone.expiresAt) / 60000))
      return {
        ok: false,
        expired: true,
        error:
          `role_token 已过期：${token}\n` +
          `  铸造于 ${new Date(gone.issuedAt).toISOString()}，有效期至 ${new Date(gone.expiresAt).toISOString()}` +
          `（TTL ${ttlMin} 分钟，已超时约 ${overMin} 分钟）。\n` +
          '★ 这是**真超时**：TTL 从铸造那一刻起算，与「DSH 有没有重启」无关。\n' +
          '  重新派活铸一枚新的即可（`pipeline_dispatch`）。',
      }
    }
    return {
      ok: false,
      expired: false,
      error:
        `role_token 无效：本机令牌表里**没有**这枚令牌（${token}）。\n` +
        '★ 两种最常见的原因，处置方式**完全不同**，请先分辨：\n' +
        '  ① **DSH 刚重启过**（或插件刚重载）—— 令牌表是**进程内存态**，重启后\n' +
        '     **所有**令牌（**包括主对话开单时铸的那一枚**）**必定全部丢失**。\n' +
        '     这与「TTL 超时」是两回事：TTL 从铸造时刻起算，跟重启没有关系。\n' +
        '     ⇒ 恢复：让主对话 `pipeline_dispatch` 重新派活铸新令牌；\n' +
        '       若**主对话自己也没了身份**（重启后必然如此），先重新认领这张单：\n' +
        '       `pipeline_task_open { task_id: "<任务id>", reattach: true }`。\n' +
        '  ② 令牌字符串**抄错 / 被截断 / 复制时带了多余空白**，或它属于**另一个项目根**的工作区。\n' +
        '     ⇒ 恢复：核对原文（`PT-` + 24 位十六进制，共 27 个字符）。',
    }
  }

  return {
    /**
     * 铸一枚令牌。
     * @param {{taskId:string, role:string, seat?:string|null, agentId?:string|null, note?:string}} spec
     * @returns {object} 令牌记录（含 token 字符串）
     */
    mint(spec) {
      sweep()
      const t = now()
      const rec = {
        token: `PT-${randomId(12)}`,
        taskId: String(spec.taskId ?? ''),
        role: String(spec.role ?? ''),
        /**
         * ★ 席位。同一个 `writer` 角色的 1~3 个席位各持一枚令牌，
         * `seat` 是区分它们的唯一标识（形如 `writer#1`）。非编写角色为 null。
         */
        seat: typeof spec.seat === 'string' && spec.seat.length > 0 ? spec.seat : null,
        agentId: typeof spec.agentId === 'string' && spec.agentId.length > 0 ? spec.agentId : null,
        /**
         * ★ **会话 id**（真实会话通道下就是侧栏里那个一等公民会话的 id）。
         *
         * 为什么单列一个字段、而不是只复用 `agentId`：子代理通道里 `agentId` 是
         * 一个**后台**子会话，真实会话通道里它是**用户可见、能点开**的会话 ——
         * 两者语义不同，失联检测与审计要能分辨（面板上要指给用户看的是后者）。
         * 绑定校验仍走 `agentId`（既有判据一个字不改），这里只是把"它是会话"记下来。
         */
        sessionId: typeof spec.sessionId === 'string' && spec.sessionId.length > 0
          ? spec.sessionId
          : (typeof spec.agentId === 'string' && spec.agentId.length > 0 ? spec.agentId : null),
        issuedAt: t,
        expiresAt: t + ttlMs,
        used: 0,
        note: typeof spec.note === 'string' ? spec.note : '',
      }
      tokens.set(rec.token, rec)
      return { ...rec }
    },

    /**
     * 校验并解析一枚令牌。
     *
     * @param {string} token
     * @param {object} [expect]
     * @param {string} [expect.taskId] - 期望的任务 id
     * @param {string[]} [expect.roles] - 允许的角色集合
     * @param {string|null} [expect.agentId] - 调用方的 agent id（用于二次绑定校验）
     * @param {boolean} [expect.requireAgentBinding] - 是否强制 agent 绑定
     * @returns {{ok:true, rec:object} | {ok:false, error:string}}
     */
    resolve(token, expect = {}) {
      sweep()
      if (typeof token !== 'string' || token.length === 0) {
        return { ok: false, error: '缺少 role_token。流水线的每个动作都必须携带角色令牌（由 pipeline_dispatch 铸造）。' }
      }
      const rec = tokens.get(token)
      if (rec === undefined) return missingTokenError(token)
      if (expect.taskId !== undefined && rec.taskId !== expect.taskId) {
        return { ok: false, error: `role_token 属于任务 ${rec.taskId}，不能用于任务 ${expect.taskId}。` }
      }
      if (Array.isArray(expect.roles) && expect.roles.length > 0 && !expect.roles.includes(rec.role)) {
        return {
          ok: false,
          error: `角色越权：该 role_token 绑定的是「${rec.role}」，本动作只允许 ${expect.roles.join(' / ')}。`,
        }
      }
      if (rec.agentId !== null && typeof expect.agentId === 'string' && expect.agentId.length > 0 && rec.agentId !== expect.agentId) {
        return {
          ok: false,
          error: `role_token 绑定的是会话 ${rec.agentId}，当前调用会话是 ${expect.agentId}。令牌不可转手。`,
        }
      }
      if (expect.requireAgentBinding === true && rec.agentId === null) {
        return {
          ok: false,
          error: '本插件配置要求令牌与会话绑定（requireAgentBinding=true），但这枚令牌没有绑定任何会话；请改用真实子代理通道派活。',
        }
      }
      rec.used += 1
      return { ok: true, rec }
    },

    /**
     * 把一个未绑定会话的令牌**就地绑定**到当前会话。
     * 人工复制通道（manual transport）下，角色会话拿到令牌后先自报家门：
     * 调用一次 `pipeline_bind_role`，从此这个会话与这个角色锁死。
     *
     * 绑定是**排他**的：同一个会话不能被绑到两个角色。
     *
     * @param {string} token
     * @param {string} agentId
     * @returns {{ok:true, rec:object} | {ok:false, error:string}}
     */
    bindAgent(token, agentId) {
      sweep()
      const rec = tokens.get(token)
      if (rec === undefined) return missingTokenError(token)
      if (typeof agentId !== 'string' || agentId.length === 0) {
        return { ok: false, error: '无法绑定：当前会话没有可用的身份（exec.agent 为空）。' }
      }
      if (rec.agentId !== null && rec.agentId !== agentId) {
        return { ok: false, error: `这枚令牌已经绑定到会话 ${rec.agentId}，不能改绑到 ${agentId}。` }
      }
      for (const other of tokens.values()) {
        if (other.token !== token && other.agentId === agentId && other.taskId === rec.taskId) {
          return {
            ok: false,
            error: `会话 ${agentId} 已绑定任务 ${rec.taskId} 的角色「${other.role}」，一个会话在同一任务里只能担任一个角色。`,
          }
        }
      }
      rec.agentId = agentId
      // ★ 真实会话通道下绑定的是**一等公民会话**：同步记进 sessionId，供审计分辨。
      if (rec.sessionId === null || rec.sessionId === undefined) rec.sessionId = agentId
      return { ok: true, rec: { ...rec } }
    },

    /**
     * ★ 按**会话 id** 反查令牌 —— 真实会话通道下的「会话 ↔ 席位」映射。
     * 与 {@link roleOfAgent} 的区别：这个认的是"用户能点开的那个会话"。
     *
     * @param {string} sessionId
     * @param {string} [taskId]
     */
    bySession(sessionId, taskId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null
      sweep()
      for (const rec of tokens.values()) {
        const sid = rec.sessionId ?? rec.agentId ?? null
        if (sid === sessionId && (taskId === undefined || rec.taskId === taskId)) return { ...rec }
      }
      return null
    },

    /**
     * ★★ **A27(b)：进程重启后，仍能认出重启前已经存在的席位。**
     *
     * 现场（用户裁定 ②「并入本单」的那半）：令牌与派活登记都在**进程内存**里，
     * DSH 一重启就全没了 ⇒ 机制的表现为「**认不出 → 干脆不叫 → 再派一席**」，
     * 而那正是本单要消灭的循环。
     *
     * 判据：**盘上有登记就把它认回来**（`task.dispatched[]` 是跨进程的那一份，
     * 由 `pipeline_dispatch` 在派活成功之后落盘）。识别依据的优先级：
     *   ① 令牌字符串（有就照原样恢复 —— 席位手上那枚令牌随即恢复可用）；
     *   ② 没有令牌 ⇒ 用 (会话 id + 角色 + 席位) 恢复**席位身份**（够用来"认出它、
     *      并给它投递"，不够用来"用旧令牌动作" —— 这一层区别如实保留）。
     *
     * ★ 识别依据缺失 / 损坏 / 不可读时**不抛、也不新建席位**：
     *   返回 `{ok:false, reason}`，由调用方按"看得见的失败"处理（A27(c)）。
     *
     * @param {{taskId:string, role:string, seat?:string|null, agentId?:string|null, sessionId?:string|null, token?:string|null, atMs?:number}} spec
     * @returns {{ok:boolean, restored:boolean, reason:string}}
     */
    restore(spec = {}) {
      const taskId = String(spec.taskId ?? '')
      const role = String(spec.role ?? '')
      const agentId = typeof spec.agentId === 'string' && spec.agentId.length > 0
        ? spec.agentId
        : typeof spec.sessionId === 'string' && spec.sessionId.length > 0 ? spec.sessionId : ''
      if (taskId.length === 0 || role.length === 0 || agentId.length === 0) {
        return { ok: false, restored: false, reason: '识别依据不完整（缺任务 id / 角色 / 会话 id）—— **不凭空新建席位**。' }
      }
      const token = typeof spec.token === 'string' && spec.token.length > 0 ? spec.token : null
      if (token !== null && tokens.has(token)) {
        const rec = tokens.get(token)
        // 已经在表里 ⇒ 只把会话绑定补齐（重启后表是空的，这一支通常不会走到）。
        if (rec.agentId === null) rec.agentId = agentId
        return { ok: true, restored: false, reason: '该令牌已在表里，无需恢复。' }
      }
      const t = now()
      const rec = {
        token: token ?? `PT-restored-${randomId(12)}`,
        taskId,
        role,
        seat: typeof spec.seat === 'string' && spec.seat.length > 0 ? spec.seat : null,
        agentId,
        sessionId: typeof spec.sessionId === 'string' && spec.sessionId.length > 0 ? spec.sessionId : agentId,
        issuedAt: Number.isFinite(spec.atMs) ? spec.atMs : t,
        /**
         * ★ TTL 从**恢复时刻**起算（不是从原始派活时刻）：重启之后原令牌的 TTL
         *   可能早就过了，但"这个会话是这个席位"这个**事实**不会因为 TTL 过期而消失。
         *   如实标注 `restored:true` + `note`，事后能分辨"这枚是认回来的"。
         */
        expiresAt: t + ttlMs,
        used: 0,
        note: 'A27：进程重启后按派活台账恢复的席位身份（恢复自 task.dispatched）。',
        restored: true,
      }
      tokens.set(rec.token, rec)
      return { ok: true, restored: true, reason: `已按派活台账认出席位「${role}${rec.seat === null ? '' : `#${rec.seat}`}」（会话 ${agentId}）。` }
    },

    /** 按 agent id 反查它在本任务里的角色与席位（守门判据用）。 */
    roleOfAgent(agentId, taskId) {
      if (typeof agentId !== 'string' || agentId.length === 0) return null
      sweep()
      for (const rec of tokens.values()) {
        if (rec.agentId === agentId && (taskId === undefined || rec.taskId === taskId)) {
          return { taskId: rec.taskId, role: rec.role, seat: rec.seat, token: rec.token }
        }
      }
      return null
    },

    /**
     * ★★ **这个会话手上「某一个角色的」全部任务**（不是"随便挑一个"）。
     *
     * ---------------------------------------------------------------------
     * 为什么必须有这个入口（2026-10-11 的现场）
     * ---------------------------------------------------------------------
     * {@link roleOfAgent} 是按 `Map` 插入顺序返回**第一条**命中。而主对话会话
     * 会为**每一张它开过 / 认领过的单**各持一枚 `main` 令牌（`lib/tools.js` 的
     * `task_open` 与 `reattach` 各铸一枚）。两种语义于是被混成了一件事：
     *
     *   · "这个会话是 `T-A` 的主对话吗" —— 想要的；
     *   · "这个会话第一个被绑成主对话的是哪张单" —— `roleOfAgent(agentId)` 给的。
     *
     * 后果是**沉默的**：`lib/tools.js` 的 `rememberMainCaller` 拿它当"我是哪张单的
     * 主对话"，于是每次工具调用都把 `contacts.main` 反复写在**老单**上，**新单一个
     * 字节都落不下来** ⇒ 新单的交付唤醒全部 `wake:skipped / no-main-session`，
     * 而老单看着一切正常（现场：`T-…5a871c` 一直响到它没事件为止，
     * `T-…214043` / `T-…56a37e` 从头到尾一条唤醒都没有）。
     *
     * 判据与 {@link roleOfAgent} **同源**（同两个字段：`agentId` + `role`），
     * 只是**不做取舍** —— 该由调用方决定要哪一张单，不该由 `Map` 的插入顺序决定。
     *
     * @param {string} agentId - 会话 id
     * @param {string} [role] - 角色（默认主对话，与 `lib/roles.js` 的 `ROLE.MAIN` 同源）
     * @returns {string[]} 去重后的任务 id（保持令牌表顺序；没绑定就是空数组）
     */
    tasksOfAgent(agentId, role = ROLE.MAIN) {
      if (typeof agentId !== 'string' || agentId.length === 0) return []
      sweep()
      const out = []
      for (const rec of tokens.values()) {
        if (rec.agentId !== agentId || rec.role !== role) continue
        if (!out.includes(rec.taskId)) out.push(rec.taskId)
      }
      return out
    },

    /**
     * 按 (任务, 角色, 席位) 找令牌 —— 派活时用它判断"这个席位是否已经派出过"。
     * @param {string} taskId
     * @param {string} role
     * @param {string|null} seat
     */
    findSeat(taskId, role, seat) {
      sweep()
      for (const rec of tokens.values()) {
        if (rec.taskId === taskId && rec.role === role && (rec.seat ?? null) === (seat ?? null)) return { ...rec }
      }
      return null
    },

    /** 全部令牌（审计用；token 只回显前缀）。 */
    list() {
      sweep()
      return [...tokens.values()].map((r) => ({ ...r, token: `${r.token.slice(0, 8)}…` }))
    },

    /**
     * 撤销**单枚**令牌（席位继任时用：旧席位换班之后不得再写）。
     *
     * 为什么不只用 `revokeTask`：那个是关单时回收整批；继任只该撤掉**一个席位**的令牌，
     * 同一任务的其它席位照常干活。
     *
     * @param {string} token
     * @returns {boolean} 是否真的撤掉了一枚
     */
    revoke(token) {
      if (typeof token !== 'string' || token.length === 0) return false
      return tokens.delete(token)
    },

    /** 撤销某任务的全部令牌（关单 / 取消时调用）。 */
    revokeTask(taskId) {
      let n = 0
      for (const [k, v] of tokens) {
        if (v.taskId === taskId) {
          tokens.delete(k)
          n += 1
        }
      }
      return n
    },

    /** 测试用：清空。 */
    clear() {
      tokens.clear()
      expiredRecently.clear()
    },

    /** 测试用：只看"最近过期"留痕（诊断文案的判据）。 */
    expiredCount() {
      return expiredRecently.size
    },

    size() {
      sweep()
      return tokens.size
    },
  }
}
