/**
 * dsh-pipeline · Agent Teams 通道 · **teammate 命名**
 * ============================================================================
 * 官方 `spawnTeammate` 的名字是**Team 内永久唯一、永不重用**的 kebab 串
 * （`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`、≤64、≠`lead`；证据见
 * `.team-recon/team-api.md` §Q1 与 `_tmp/teamservice.txt:1023,1162-1166,1908-1913`）。
 *
 * 而 pipeline 的身份轴是 `(taskId, role, seat)`，且**一个主对话会话可以服务多张单**
 * —— 所以任务必须编进名字里，否则第二个任务的 `writer#1` 会撞上第一个任务的
 * `p-t1-writer-1` 被判 `TEAM_MEMBER_NAME_TAKEN`（成员只增不减，撞了就再也派不出去）。
 *
 * 命名契约（01 §D5 写死）：
 *   `<teamNamePrefix>-<task 小写>-<role>[-<seat 序号>]`，默认前缀 `p`。
 *   重派/继任 = 同名不许复用 ⇒ 追加 `-r<N>`（`nextNameForReassign`）。
 *
 * ★ 本模块**只做纯字符串**：不读 ctx、不查名单、不抛异常。查"这个名字是否已被用掉"
 *   是调用方用 `listMembers` 现查的事（不新开落盘格式）。
 *
 * @module dsh-pipeline/lib/team/naming
 */

import { ROLES } from '../roles.js'

/** 官方名字判据（逐字取自 `_tmp/teamservice.txt:1908-1913`）。 */
export const TEAM_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const TEAM_NAME_MAX = 64
/** 官方保留名：主对话永远叫 `lead`，teammate 不能叫这个。 */
export const TEAM_LEAD_NAME = 'lead'
/** 默认前缀（配置项 `teamNamePrefix`）。 */
export const DEFAULT_TEAM_NAME_PREFIX = 'p'

/**
 * 把一个任意字符串折成 kebab 段（只留 `[a-z0-9]`，其余压成一个 `-`）。
 * @param {unknown} s
 * @returns {string}
 */
function kebab(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 席位 → 名字里的那一段。
 *
 * 归一顺��（与 `lib/wakeup/keys.js` 的 `seatSegmentOf` **同一口径**，
 * 理由见那里的注释：`tester`+`tester` 这种"单席位角色的席位名就是角色名"必须视作无席位，
 * 否则名字里会多一段，同一个席位重派时被当成另一个人）：
 *   ① `writer#1` → 去掉 `^[a-z_]+#` 前缀 → `1`；
 *   ② `tester` + `tester` → 空串（无席位）；
 *   ③ 其它按 kebab 折（`writer#a b` → `a-b`）。
 *
 * @param {string} role
 * @param {string|null|undefined} seat
 * @returns {string} 空串 = 该角色只有一个席位，名字里不出现席位段
 */
export function normalizeSeatKey(role, seat) {
  const r = String(role ?? '')
  const raw = typeof seat === 'string' && seat.trim().length > 0 ? seat.trim() : ''
  if (raw.length === 0) return ''
  const stripped = raw.replace(/^[a-z_]+#/i, '')
  if (stripped.toLowerCase() === r.toLowerCase()) return ''
  return kebab(stripped)
}

/**
 * 按长度预算截断一个段（官方上限 64，截断比"拼出来被拒"更容易排查）。
 * @param {string} s
 * @param {number} max
 */
function clip(s, max) {
  const t = String(s ?? '')
  if (max <= 0) return ''
  return t.length <= max ? t : t.slice(0, max).replace(/-+$/, '')
}

/**
 * `(taskId, role, seat, prefix)` → 合法 teammate name。
 *
 * @param {{taskId:string, role:string, seat?:string|null, prefix?:string}} input
 * @returns {string} 一定满足 `TEAM_NAME_RE` 且 ≤64 且 ≠`lead`
 */
export function teamNameOf(input) {
  const role = kebab(input?.role) || 'role'
  const prefix = kebab(input?.prefix || DEFAULT_TEAM_NAME_PREFIX) || DEFAULT_TEAM_NAME_PREFIX
  const seat = normalizeSeatKey(input?.role, input?.seat)
  // 预留的固定开销：`<prefix>-<role>` 与可选的 `-<seat>`。
  const fixed = `${prefix}-${role}${seat.length > 0 ? `-${seat}` : ''}`.length
  const task = clip(kebab(input?.taskId), Math.max(0, TEAM_NAME_MAX - fixed - 1))
  const parts = [prefix, task, role, ...(seat.length > 0 ? [seat] : [])].filter((x) => x.length > 0)
  let name = parts.join('-')
  if (name.length > TEAM_NAME_MAX) name = clip(name, TEAM_NAME_MAX)
  // 官方保留名：`lead` 是 Lead 自己的名字，teammate 不许叫这个。
  // （前缀默认 `p` 时结构上不可能撞上；这里只挡"调用方把前缀配成空/怪值"的极端情形。）
  if (name === TEAM_LEAD_NAME || name.length === 0) name = `${DEFAULT_TEAM_NAME_PREFIX}-${name || 'seat'}`
  return name
}

/**
 * 名字的**尽力反解**（拿 `listMembers` 的名单做"这名字是谁"的诊断用）。
 *
 * ★ 诚实边界：taskId 与 role **都可能含 `-`**，所以这是个**启发式**而不是双射。
 *   判据优先级：末尾 `-r<N>`（重派）→ 找一个**已知角色名**的段当 role
 *   → 名字尾部的纯数字段当席位序号。反解不出来就 `ok:false`，
 *   调用方应当**以 `listMembers` 的 id 反查为准**（那才是权威映射）。
 *
 * @param {string} name
 * @returns {{ok:boolean, name:string, prefix:string, role:string|null, seat:string|null, reassign:number|null, taskPart:string|null}}
 */
export function parseTeamName(name) {
  const raw = String(name ?? '')
  const out = { ok: false, name: raw, prefix: '', role: null, seat: null, reassign: null, taskPart: null }
  if (!TEAM_NAME_RE.test(raw)) return out
  const parts = raw.split('-')
  out.prefix = parts[0] ?? ''
  let rest = parts.slice(1)
  const tail = rest.length > 0 ? rest[rest.length - 1] : ''
  if (/^r\d+$/.test(tail)) {
    out.reassign = Number(tail.slice(1))
    rest = rest.slice(0, -1)
  }
  // role：从右往左找第一个**已知角色名**（`lib/roles.js` 是唯一角色清单）。
  let roleIdx = -1
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    if (ROLES[rest[i]] !== undefined) {
      roleIdx = i
      break
    }
  }
  if (roleIdx < 0) return out
  out.role = rest[roleIdx]
  out.taskPart = rest.slice(0, roleIdx).join('-') || null
  const seatPart = rest.slice(roleIdx + 1).join('-')
  out.seat = seatPart.length > 0 ? seatPart : null
  out.ok = true
  return out
}

/**
 * 重派要"换人"时的下一个名字：`base` 被占 ⇒ `base-r2`、`base-r3`……
 *
 * 为什么不能复用旧名：官方名字**同 Team 内永不重用**（失败成员也占名），
 * 复用只会拿到 `TEAM_MEMBER_NAME_TAKEN`。所以"同一个席位换个人"在官方轴上
 * **必然是新名字**，而 (task,role,seat)→name 的映射只能现查名单。
 *
 * @param {Iterable<string>} usedNames 已在名单里的名字
 * @param {string} base `teamNameOf` 的产物
 * @returns {string}
 */
export function nextNameForReassign(usedNames, base) {
  const used = new Set(Array.from(usedNames ?? [], (x) => String(x ?? '')))
  const b = String(base ?? '')
  if (!used.has(b)) return b
  let max = 1
  for (const n of used) {
    const m = /^(.*)-r(\d+)$/.exec(n)
    if (m !== null && m[1] === b) max = Math.max(max, Number(m[2]))
  }
  // 从 r2 起（r1 隐含就是 base 本身），保证每次重派都是新名字。
  const suffix = `-r${max + 1 < 2 ? 2 : max + 1}`
  const room = TEAM_NAME_MAX - suffix.length
  const head = b.length > room ? clip(b, room) : b
  return `${head}${suffix}`
}
