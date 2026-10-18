// 浏览器 Profile / 凭证类路径 · 识别（守门与安全扫描器共用的**唯一**出处）。
/**
 * dsh-pipeline · 浏览器 Profile 与凭证类路径的识别
 * ============================================================================
 * 修的是哪条缺陷（P0-2，2026-10-18 内部复盘第 2 条）
 * -----------------------------------------------------------------------------
 * 现场：**测试席位把用户真实浏览器 Profile 复制进流水线工作区**（实测 374.6 MB）：
 *   `%LOCALAPPDATA%\Microsoft\Edge\User Data` 下的 Cookies / Login Data / Web Data /
 *   Local State / History / Bookmarks / Vpn Tokens / `*.sqlite` …
 *
 * 它有两个受害面，所以需要**两个**执法点：
 *   · **守门**（`guard/browser-profile.js`）—— 拦在写入 / 复制**发生之前**；
 *   · **安全扫描**（`lib/security.js`）—— 事后把已经落盘的列成一等命中「凭证落盘」。
 *
 * -----------------------------------------------------------------------------
 * 为什么单开一个文件（而不是各写一份名单）
 * -----------------------------------------------------------------------------
 * 同一份"什么算浏览器 profile / 凭证文件"的名单，一旦在两个执法点各写一遍，
 * 就**必然漂移**；而漂移的方向总是**放宽**：扫描器认得、守门拦不住（或者反过来），
 * 于是"扫描能报出来"被当成"守门已经拦住了"——那是假绿。
 * 所以名单与判定**只在这里**，两个执法点都 import 这一份。
 *
 * -----------------------------------------------------------------------------
 * 判据口径（三条，别放宽）
 * -----------------------------------------------------------------------------
 *   ① **按路径认，不按内容认**。Cookie 库是有 NUL 的二进制 SQLite，文本扫描本来
 *      就看不见它；而"读内容判是不是凭证"会先把 374 MB 读一遍（守门自己成了资源消耗点）。
 *   ② **文件名精确匹配**（`Cookies` / `Login Data` / `Local State` …）或**扩展名**
 *      （`*.sqlite` / `*.sqlite3`）。刻意不做 `*cookie*` 这类模糊匹配：
 *      `reports/cookies.md` 是**关于** Cookie 的普通文档，不是凭证；
 *      把它拦下就是误伤（"扫描要准，不是要多"）。
 *   ③ **浏览器 profile 目录段**按路径**段级**认（`User Data` / `edge-profile*` /
 *      `google-chrome` …）：复制时改名字也躲不掉，因为**源**那几段还在路径里。
 *
 * ★ 边界（诚实登记，README「哪些是约定」同一条）：
 *   · 用户先把 profile 拷到工作区外、再**改名**拷进来（源与目标都不像 profile）
 *     —— 路径判据认不出来，这是 best-effort 的能力边界；
 *   · 无扩展名的 `History` / `Bookmarks` 是精确名匹配：项目里如果真有一份名叫
 *     `History` 的普通文件，也会命中（宁可偶尔多拦一次，也不放过真实 profile 数据）。
 *
 * @module dsh-pipeline/lib/guard/credential-paths
 */

import { pathKey } from '../util.js'

/**
 * 浏览器 profile **目录段**的识别规则（大小写不敏感；匹配单个路径段）。
 *
 * 为什么按"段"而不是按"整条路径"：本机现场是
 *   `C:\Users\<用户>\AppData\Local\Microsoft\Edge\User Data\Default\Cookies`
 * —— 只要任意一段是 `User Data`，它底下**所有东西**都属 profile 数据
 * （Local Storage / Session Storage / IndexedDB … 那些没有固定文件名的目录也一样）。
 */
export const BROWSER_PROFILE_DIR_RULES = Object.freeze([
  {
    re: /^user\s?data$/,
    why: 'Chromium 系浏览器（Chrome / Edge）的 User Data 根目录',
  },
  {
    re: /^(?:edge|chrome|chromium|brave|vivaldi|opera|firefox|safari|arc|yandex)[-_ ]?profile(?:[-_ ].*)?$/,
    why: '浏览器 profile 目录（edge-profile* / chrome-profile* …）',
  },
  {
    re: /^(?:google[-_ ]?chrome|microsoft[-_ ]?edge|chromium|brave[-_ ]?browser|vivaldi|yandexbrowser|firefox|mozilla)$/,
    why: '浏览器自己的数据目录（Chrome / Edge / Chromium / Firefox …）',
  },
])

/**
 * 浏览器**凭证库 / 隐私数据文件名**（精确匹配，不含扩展名的那种也算）。
 *
 * 名字来源：Chromium 系（Chrome / Edge / Brave …）与 Firefox 的固定文件名。
 * 这里**只收"名字本身就是凭证"的**；`Preferences` / `Visits` 这类名字太泛、
 * 而且不含登录态，刻意不收。
 */
export const CREDENTIAL_BASENAMES = Object.freeze([
  'cookies',
  'login data',
  'login data for account',
  'web data',
  'local state',
  'history',
  'bookmarks',
  'vpn tokens',
  // Firefox 的登录库 / 密钥库（`.sqlite` 由扩展名那条覆盖）
  'logins.json',
  'key3.db',
  'key4.db',
])

/** 浏览器凭证库的扩展名（浏览器把 Cookie / 历史 / 登录都存成 SQLite）。 */
export const CREDENTIAL_EXTS = Object.freeze(['sqlite', 'sqlite3'])

/** 文件名归一化：小写 + 下划线/连字符折成空格（`vpn_tokens` ≡ `Vpn Tokens`）。 */
export function normalizeCredentialName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
}

const CREDENTIAL_BASENAME_SET = new Set(CREDENTIAL_BASENAMES)

/**
 * 这个**文件名**是不是浏览器凭证库 / 隐私数据。
 *
 * @param {string} name - 单个文件名（不要传整条路径）
 * @returns {{kind:'credential_file', matched:string, why:string} | null}
 */
export function classifyCredentialFileName(name) {
  const n = normalizeCredentialName(name)
  if (n.length === 0 || n.length > 120) return null
  if (CREDENTIAL_BASENAME_SET.has(n)) {
    return {
      kind: 'credential_file',
      matched: n,
      why: '浏览器凭证库 / 隐私数据文件（Cookie、密码、历史、收藏或 VPN 令牌）',
    }
  }
  const dot = n.lastIndexOf('.')
  if (dot > 0) {
    const ext = n.slice(dot + 1)
    if (CREDENTIAL_EXTS.includes(ext)) {
      return {
        kind: 'credential_file',
        matched: n,
        why: `SQLite 数据库（.${ext}）：浏览器把 Cookie / 登录 / 历史都存成这种格式`,
      }
    }
  }
  return null
}

/**
 * 这个**目录名**是不是浏览器 profile 目录。
 *
 * @param {string} name - 单个路径段（目录名）
 * @returns {{kind:'browser_profile_dir', matched:string, why:string} | null}
 */
export function classifyBrowserProfileDirName(name) {
  const n = String(name ?? '').trim().toLowerCase()
  if (n.length === 0 || n.length > 120) return null
  for (const rule of BROWSER_PROFILE_DIR_RULES) {
    if (rule.re.test(n)) return { kind: 'browser_profile_dir', matched: n, why: rule.why }
  }
  return null
}

/**
 * 一条**路径**是不是浏览器 profile / 凭证数据（守门与扫描器的共同入口）。
 *
 * 判序：文件名（精确名 / 凭证扩展名）→ 路径段（profile 目录标记）。
 * 先判文件名，是为了拒绝文案能说出"命中的是 Cookies"这种最具体的信息；
 * 落在 profile 目录里的其它文件（`Local Storage/leveldb/000003.log`）走第二道。
 *
 * @param {string} raw - 绝对或相对路径（相对路径也认：复制的目标常常是相对写法）
 * @returns {{kind:'credential_file'|'browser_profile_dir', matched:string, why:string} | null}
 */
export function classifyCredentialPath(raw) {
  const key = pathKey(String(raw ?? ''))
  if (key.length === 0) return null
  const segs = key.split('/')
  const file = classifyCredentialFileName(segs[segs.length - 1] ?? '')
  if (file !== null) return file
  for (const seg of segs) {
    const dir = classifyBrowserProfileDirName(seg)
    if (dir !== null) return dir
  }
  return null
}
