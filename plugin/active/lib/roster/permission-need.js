// 权限档的**角色需求底线**：会产生落盘产物的角色至少 workspace-write。
/**
 * dsh-pipeline · 角色清单 · **权限档的角色需求底线**
 * ============================================================================
 * 修的是哪条缺陷（真机 `T-20261016-fullai`，实测）
 * ----------------------------------------------------------------------------
 * 架构位 / 架构图位的权限档是 **read-only**，却被要求把产物落盘到
 * `.pipeline/<任务>/reports/<role>/`（关单判据 `diagram_delivered` 以磁盘文件为依据）。
 * 于是**宿主弹了人工审批窗**（「● 等待审批：允许本次操作使用 workspace-write 权限…
 * [拒绝][允许一次]」），用户被弹了两次；现场只能靠"带 `permission: workspace-write`
 * 重派"绕过 —— 那是撞运气，不是机制。
 *
 * ----------------------------------------------------------------------------
 * 判据：**权限档的默认值原来在哪推导**（改前的两处，都在这一步之前）
 * ----------------------------------------------------------------------------
 *   ① `lib/tools/dispatch-slots.js:61-73` 的 `dispatchSlots` —— 只给 `mode` 兜底，
 *      `permission` 这一槽**不产出**（返回 `undefined`）⇒ 交给下游；
 *   ② `lib/transport/index.js:1043-1048` 的 `normalizeSlots(spec, {...})` ——
 *      兜底恒为 `MIN_PERMISSION`（`read-only`），与角色是谁**毫无关系**。
 *   ⇒ 于是"这个角色到底要不要写盘"这件事，**在整条派活链上一次都没有被问过**。
 *
 * ----------------------------------------------------------------------------
 * 改成什么规则（**一条，只有一条**）
 * ----------------------------------------------------------------------------
 *   `permissionNeedOf(role)` 把守门**已经在执法的那张表**（`guard.js` 的
 *   `writeClassOf`，实现 `lib/guard/rules.js:83-91`）读成权限档底线：
 *
 *     · `own-dir`  （tester / architect / security / archivist / diagrammer /
 *                   release / docs / performance / arbiter）⇒ `workspace-write`
 *     · `own-log`  （reviewer）                                  ⇒ `workspace-write`
 *     · `workdir`  （writer / human）                            ⇒ `workspace-write`
 *     · `readonly` （main / orchestrator / planner）             ⇒ `read-only`
 *     · `none`     （supervisor）                                ⇒ `read-only`
 *     · 认不出的角色                                             ⇒ `read-only`
 *
 * ----------------------------------------------------------------------------
 * 为什么这条规则能覆盖"顾问角色要写自己的报告目录"
 * ----------------------------------------------------------------------------
 * 因为**这张表就是守门用来判"这个角色能不能写、能写多宽"的同一张表**
 * （`writeClassOf` 的返回值直接决定 `checkOwnPath` 走哪一支）。也就是说：
 *   权限档 < 守门允许面 ⇒ 守门放行、**宿主拦住**（现场那种弹窗）；
 *   权限档 ≥ 守门允许面 ⇒ 两边一致。
 * 一个角色的 `writes` 只要是 `own-dir` / `own-log` / `workdir`，它的**正当产物**
 * 就必然落在磁盘上 ⇒ 它的会话权限档就必须至少 `workspace-write`。
 * 这不是"按角色猜"，而是把**已有的授权数据面**接到**已有的权限槽**上。
 *
 * ★ 为什么**不**放宽成"所有角色都给写权限"：`readonly` / `none` 那四个角色
 *   （main / orchestrator / planner / supervisor）的产物是**结构化交接物**
 *   （由 `pipeline_handoff` 这个工具写），它们**不需要**、也**不该**碰文件系统 ——
 *   给它们写权限等于把最小权限原则取消掉，与 `roles.js` 的 `writes` 表直接冲突。
 *
 * ★ 位置纪律：本模块**只读、纯函数、零 IO**。它不改名单（`roster.slots` 的占位值
 *   一个字节都不动 —— 那三处既有断言钉着它），只给"派活那一刻的下限"提供唯一出处。
 *
 * @module dsh-pipeline/lib/roster/permission-need
 */

import { writeClassOf } from '../guard.js'

/**
 * 这一槽的来源名（写进 `dispatch_slots[].provenance.permission.origin`）。
 *
 * 三档来源各有一个稳定的名字，事后核对时一眼分得清：
 *   · `declared`  —— 名单里**显式声明**的（计划/规则引擎定的）；
 *   · `request`   —— 本次派活**调用方显式给**的；
 *   · `role-need` —— ★ 本模块：**按角色需求推导**的（本条缺陷的产物）；
 *   · `default`   —— 谁都没给、按契约取兜底。
 */
export const ROLE_NEED_ORIGIN = 'role-need'

/** 推导出来的档名（它就是通道三档里中间那一档，逐字相等、不做归一）。 */
export const ROLE_NEED_PERMISSION = 'workspace-write'

/** 只读角色落的档（与 `transport.MIN_PERMISSION` 同义；这里刻意写字面量保持本模块零依赖）。 */
export const ROLE_NEED_READONLY = 'read-only'

/**
 * 会产生落盘产物的 `writes` 类别（判据与 `lib/guard/rules.js` 的 `writeClassOf` 同源）。
 *
 * ★ 一旦守门那边加了新的可写类别，这里**不会自动跟上** —— 所以有一条自测
 *   （`tests/heal-perm-check.mjs`）按 `writeClassOf` 的**实际返回值**逐角色比对，
 *   漂移会被抓红，而不是静默漏掉。
 */
export const WRITE_CLASSES = Object.freeze(['own-dir', 'own-log', 'workdir'])

/**
 * ★★ **权限档的角色需求底线**（本模块唯一的判据）。
 *
 * 纯函数：不读盘、不写盘、不抛、不改入参。
 *
 * @param {string} role - 角色 id（`lib/roles.js` 的 `ROLE`）
 * @returns {{value:string, origin:string, write_class:string|null, known:boolean, because:string}}
 *   `origin` 三档：`role-need`（按角色推导出来了）/ `default`（角色认不出，按最保守处理）。
 */
export function permissionNeedOf(role) {
  const r = String(role ?? '')
  const cls = r.length === 0 ? null : writeClassOf(r)
  if (cls !== null && WRITE_CLASSES.includes(cls)) {
    return {
      value: ROLE_NEED_PERMISSION,
      origin: ROLE_NEED_ORIGIN,
      write_class: cls,
      known: true,
      because:
        `角色 ${r} 的写入类别是 \`${cls}\`（守门 \`writeClassOf\`）—— 它的正当产物落在磁盘上，` +
        `所以会话权限档至少 ${ROLE_NEED_PERMISSION}（否则守门放行、宿主拦住：现场就是那个审批弹窗）。`,
    }
  }
  if (cls !== null) {
    return {
      value: ROLE_NEED_READONLY,
      origin: ROLE_NEED_ORIGIN,
      write_class: cls,
      known: true,
      because: `角色 ${r} 的写入类别是 \`${cls}\` —— 一字节都不许写，权限档保持 ${ROLE_NEED_READONLY}（最小权限不放宽）。`,
    }
  }
  return {
    value: ROLE_NEED_READONLY,
    origin: 'default',
    write_class: null,
    known: false,
    because: `角色 ${r === '' ? '(空)' : r} 不在守门的角色表里 ⇒ **不猜**，按最保守的 ${ROLE_NEED_READONLY} 处理。`,
  }
}
