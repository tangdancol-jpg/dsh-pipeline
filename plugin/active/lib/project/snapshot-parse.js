// 快照版本号 · 解析与序数换算：把 `b.2026.10.15.A-01` 这类版本号拆开并换成一个**可比较的整数序数**。
/**
 * dsh-pipeline · 快照版本号 · 解析与序数换算
 * ============================================================================
 * 裁定 12：快照版本号形如 `b.<年>.<月>.<日>.<段>`，段 = `01…99 → A-01…A-99 → B-01…`。
 *
 * ★★ **本文件存在的唯一理由：比较必须解析成序数，禁止字符串排序。**
 *
 * 为什么字符串排序会判错「最新快照」—— 现场反例（`tests/p2` 里有可执行的那一条）：
 *
 *   候选：`b.2026.10.9.01`（10 月 9 日）与 `b.2026.10.15.01`（10 月 15 日）
 *     · 字符串排序：`"…10.15.01" < "…10.9.01"`（比较到第 9 个字符时 `'1' < '9'`）
 *       ⇒ 结论「10 月 9 日更早」—— 但它把 **10 月 15 日** 判成了更早的那个，
 *         于是 `sort()[n-1]` 取到的"最新"是 **10 月 9 日**。**是错的。**
 *     · 序数比较：日 15 > 日 9 ⇒ 10 月 15 日更新。**是对的。**
 *
 *   同一天内的段也有一个陷阱（不是"排序方向"而是"解析方式"）：
 *     · `parseInt('A-01')` ⇒ `NaN` —— 拿它去比大小，`NaN` 与谁比都是 false，
 *       于是"最新"会**静默地**变成"第一个碰到的"。
 *     · 本文件把 `A-01` 明确换成序数 **101**（见 {@link ordinalOfSegment}）。
 *
 * ⚠️ 一处**如实说明**（不替谁圆场）：设计定稿 §3.1 举的反例写作 `"A-01" < "01"`。
 *   在 JS 里 `'A-01' < '01'` 其实是 **false**（`'0'(48) < 'A'(65)`），所以那个字面例子
 *   本身不成立。但**它指出的风险是真的**：字符串序与序数序**会在日期段上分叉**
 *   （上面的 10.9 / 10.15 就是），而且 `parseInt` 在字母段上会给出 `NaN`。
 *   本文件按"序数"实现，并由 `tests/p2-snapshot-version-check.mjs` 用**真会判错**的
 *   反例把这件事钉住。
 *
 * @module dsh-pipeline/lib/project/snapshot-parse
 */

/** 版本号前缀（`b.` = 快照版，与 `v.` 之类的语义版本区分开）。 */
export const SNAPSHOT_PREFIX = 'b'

/** 段的两种合法形态：两位数字，或「一个大写字母 + `-` + 两位数字」。 */
export const PLAIN_SEGMENT_RE = /^(\d{2})$/
export const LETTER_SEGMENT_RE = /^([A-Z])-(\d{2})$/

/** 字母段的最大字母（`Z-99` 之后再无可用段）。 */
export const MAX_LETTER = 'Z'

/** 全部合法字母段字母（A…Z）。 */
export const SEGMENT_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))

/** 序数 → 字母（1 → `A`，26 → `Z`）。 */
export function letterOfIndex(index) {
  const i = Number(index)
  if (!Number.isInteger(i) || i < 1 || i > SEGMENT_LETTERS.length) return null
  return SEGMENT_LETTERS[i - 1]
}

/** 字母 → 序数（`A` → 1，`Z` → 26）。 */
export function indexOfLetter(letter) {
  const s = String(letter ?? '')
  const i = SEGMENT_LETTERS.indexOf(s)
  return i < 0 ? null : i + 1
}

/** 段的序数上界：`Z-99` ⇒ 26 × 100 + 99 = 2699。 */
export const MAX_SEGMENT_ORDINAL = SEGMENT_LETTERS.length * 100 + 99

/**
 * 段 → 序数。
 *
 *   `01`…`99`   ⇒ 1…99
 *   `A-01`…`A-99` ⇒ 101…199
 *   `B-01`      ⇒ 201
 *   `Z-99`      ⇒ 2699
 *
 * @param {string} segment
 * @returns {{ok:true, ordinal:number, form:'plain'|'letter', letter:string|null, n:number}
 *          |{ok:false, code:string, message:string}}
 */
export function ordinalOfSegment(segment) {
  const s = String(segment ?? '').trim()
  if (s.length === 0) {
    return { ok: false, code: 'SEGMENT_EMPTY', message: '快照段是空的 —— 需要两位数字（`01`）或「字母-两位数字」（`A-01`）。' }
  }
  const plain = PLAIN_SEGMENT_RE.exec(s)
  if (plain !== null) {
    const n = Number(plain[1])
    if (n < 1) {
      return { ok: false, code: 'SEGMENT_ZERO', message: `快照段 \`${s}\` 非法：段从 \`01\` 起，没有 \`00\`。` }
    }
    return { ok: true, ordinal: n, form: 'plain', letter: null, n }
  }
  const letter = LETTER_SEGMENT_RE.exec(s)
  if (letter !== null) {
    const idx = indexOfLetter(letter[1])
    const n = Number(letter[2])
    if (idx === null || n < 1) {
      return { ok: false, code: 'SEGMENT_ILLEGAL', message: `快照段 \`${s}\` 非法：字母段必须是 \`A-01\`…\`Z-99\`，且段从 \`-01\` 起。` }
    }
    return { ok: true, ordinal: idx * 100 + n, form: 'letter', letter: letter[1], n }
  }
  return {
    ok: false,
    code: 'SEGMENT_MALFORMED',
    message:
      `快照段 \`${s}\` 格式非法：只接受两位数字（\`01\`…\`99\`）或「一个大写字母 + \`-\` + 两位数字」（\`A-01\`…\`Z-99\`）。\n` +
      '★ 边界：段序号格式非法时**拒绝并给出可读原因，不靠猜测补位**。',
  }
}

/**
 * 序数 → 段。
 *
 *   1…99    ⇒ `01`…`99`
 *   101…199 ⇒ `A-01`…`A-99`
 *   201     ⇒ `B-01`
 *
 * @param {number} ordinal
 * @returns {{ok:true, segment:string}|{ok:false, code:string, message:string}}
 */
export function segmentOfOrdinal(ordinal) {
  const n = Number(ordinal)
  if (!Number.isInteger(n) || n < 1 || n > MAX_SEGMENT_ORDINAL) {
    return {
      ok: false,
      code: 'ORDINAL_OUT_OF_RANGE',
      message: `段序数 ${ordinal} 超出范围（合法区间 1…${MAX_SEGMENT_ORDINAL}，即 \`01\`…\`Z-99\`）。`,
    }
  }
  if (n <= 99) return { ok: true, segment: String(n).padStart(2, '0') }
  const idx = Math.floor(n / 100)
  const rest = n % 100
  const letter = letterOfIndex(idx)
  if (letter === null || rest < 1) {
    return { ok: false, code: 'ORDINAL_OUT_OF_RANGE', message: `段序数 ${n} 无法映射成合法段。` }
  }
  return { ok: true, segment: `${letter}-${String(rest).padStart(2, '0')}` }
}

/**
 * 解析完整快照版本号。
 *
 * 形态：`b.<年>.<月>.<日>.<段>`。年月日按**整数**取（**不要求补零** —— 补零与否
 * 不影响序数比较，但不补零正是字符串排序会判错的原因，见文件头）。
 *
 * @param {string} version - 例如 `b.2026.10.15.A-01`
 * @returns {{ok:true, version:string, year:number, month:number, day:number,
 *            segment:string, ordinal:number, dateOrdinal:number, totalOrdinal:number}
 *          |{ok:false, code:string, message:string}}
 */
export function parseSnapshotVersion(version) {
  const s = String(version ?? '').trim()
  const parts = s.split('.')
  if (parts.length !== 5) {
    return {
      ok: false,
      code: 'VERSION_MALFORMED',
      message: `快照版本号 \`${s}\` 非法：形态必须是 \`b.<年>.<月>.<日>.<段>\`（5 段），实际 ${parts.length} 段。`,
    }
  }
  const [prefix, y, m, d, segment] = parts
  if (prefix !== SNAPSHOT_PREFIX) {
    return {
      ok: false,
      code: 'VERSION_BAD_PREFIX',
      message: `快照版本号 \`${s}\` 非法：前缀必须是 \`${SNAPSHOT_PREFIX}\`（快照版），实际是 \`${prefix}\`。`,
    }
  }
  const num = (raw, label, min, max) => {
    if (!/^\d+$/.test(raw)) return { ok: false, code: 'VERSION_BAD_DATE', message: `快照版本号 \`${s}\` 的${label} \`${raw}\` 不是数字。` }
    const v = Number(raw)
    if (v < min || v > max) return { ok: false, code: 'VERSION_BAD_DATE', message: `快照版本号 \`${s}\` 的${label} ${v} 超出 ${min}…${max}。` }
    return { ok: true, value: v }
  }
  const year = num(y, '年', 1970, 9999)
  if (!year.ok) return year
  const month = num(m, '月', 1, 12)
  if (!month.ok) return month
  const day = num(d, '日', 1, 31)
  if (!day.ok) return day
  const seg = ordinalOfSegment(segment)
  if (!seg.ok) return seg

  const dateOrdinal = year.value * 10000 + month.value * 100 + day.value
  return {
    ok: true,
    version: s,
    year: year.value,
    month: month.value,
    day: day.value,
    segment: String(segment).trim(),
    ordinal: seg.ordinal,
    dateOrdinal,
    /**
     * ★ **唯一可用于比较的整数**：`日期序数 × 10000 + 段序数`。
     *
     * 用 10000 而不是 2700 做进位基数，是为了让"日期变了"**永远压过**"段变了" ——
     * 段最大 2699，留出足够余量，跨天比较就不会因为段大而被翻盘。
     */
    totalOrdinal: dateOrdinal * 10000 + seg.ordinal,
  }
}

/**
 * 组装一个快照版本号（不做进位，进位见 `snapshot-next.js`）。
 *
 * @param {{year:number, month:number, day:number, segment:string}|{year:number,month:number,day:number,ordinal:number}} input
 * @returns {{ok:true, version:string}|{ok:false, code:string, message:string}}
 */
export function formatSnapshotVersion(input) {
  const src = input ?? {}
  const segment = typeof src.segment === 'string' ? src.segment : segmentOfOrdinal(src.ordinal)
  if (typeof segment !== 'string') {
    return { ok: false, code: segment?.code ?? 'BAD_SEGMENT', message: segment?.message ?? '段非法。' }
  }
  const seg = ordinalOfSegment(segment)
  if (!seg.ok) return seg
  const y = Number(src.year)
  const m = Number(src.month)
  const d = Number(src.day)
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1 || d > 31) {
    return { ok: false, code: 'BAD_DATE', message: `快照版本号的日期非法：年=${src.year} 月=${src.month} 日=${src.day}。` }
  }
  return { ok: true, version: `${SNAPSHOT_PREFIX}.${y}.${m}.${d}.${String(segment).trim()}` }
}

/**
 * 从一棵本机日期取「年月日」。
 *
 * 边界：跨天时版本号取**建快照当日本机日期**（本函数就是那个来源）。
 *
 * @param {Date} [date]
 * @returns {{year:number, month:number, day:number}}
 */
export function datePartsOf(date = new Date()) {
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }
}
