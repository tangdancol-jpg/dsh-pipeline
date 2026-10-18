// 守门判据 · 浏览器 Profile / 凭证数据不得进入流水线工作区（写工具 + shell 复制/写入）。
/**
 * dsh-pipeline · 守门 · **浏览器 Profile / 凭证数据不得进入工作区**
 * ============================================================================
 * 修的是哪条缺陷（P0-2，2026-10-18 内部复盘第 2 条）
 * -----------------------------------------------------------------------------
 * 现场（L5 实测）：**测试席位把用户真实浏览器 Profile 复制进流水线工作区**
 * （报告实测 374.6 MB）—— `reports/tester/edge-profile-*` 下面躺着真实的
 * Cookies / Login Data / Web Data / Local State / History / Bookmarks / Vpn Tokens。
 *
 * 为什么原来看不见：既有 shell 判据 4a 拦的是"**用 shell 改项目文件**"
 * （判据 = 写动词 + 命令里出现项目根的绝对路径）。而这次的动作是
 * 「从用户目录**复制**进工作区」，目标写的是**相对路径**
 * （`reports/tester/edge-profile`）⇒ `mentionsProtectedPath` 为 false ⇒ 整段判据
 * 静默失效。换句话说：**它不是被绕过的，是从判据的缝里漏过去的**。
 *
 * -----------------------------------------------------------------------------
 * 判据是什么（两条入口，同一份名单）
 * -----------------------------------------------------------------------------
 *   ① **写类文件工具**（`write` / `edit` / `patch` …）：目标落在项目根内，
 *      且目标路径命中浏览器 profile 目录段或凭证文件名 ⇒ 拒；
 *   ② **shell**：命令里出现复制 / 写入动作，且
 *      · 候选路径中**落在项目根内**的那一条本身就像 profile / 凭证 ⇒ 拒
 *        （覆盖 `Copy-Item src/a.js reports/tester/edge-profile/x`、
 *          `Set-Content reports/tester/Cookies`、`echo … > reports/tester/x.sqlite`）；
 *      · 或者是**从 profile 复制进工作区**：复制类动词 + 某个候选路径像 profile / 凭证
 *        （源，常常在 `%LOCALAPPDATA%` / `~/.config` 下）+ 存在"落在项目里 / 取不准"的
 *        目的地 ⇒ 拒（覆盖 `Copy-Item -Recurse "%LOCALAPPDATA%\...\User Data" reports/tester/x`）。
 *
 * 命中即拒，**对所有角色生效（含 writer）**：数据卫生不是角色权限，是"不能发生的事"。
 * 拒绝文案必须给**可操作的下一步**（脱敏夹具 / 临时空 profile），否则席位只会原地重试。
 *
 * -----------------------------------------------------------------------------
 * 诚实边界（shell 侧是 best-effort，与其它 shell 判据同一条口径）
 * -----------------------------------------------------------------------------
 *   · 命令里**没有出现任何**可识别路径（全部变量拼接、base64 解码后再落盘）⇒ 认不出；
 *   · 先把 profile 拷到工作区外、改名后再拷进来（源与目标都不像 profile）⇒ 认不出；
 *   · 用 `write` 工具**逐字节**重写一份改名后的 Cookie 库（内容像二进制）⇒ 路径判据不管；
 *   · 写到项目根**之外**不归本插件管（与其它路径判据同一条边界）。
 * 这些边界如实登记，不靠"看起来像拦住了"充数。
 *
 * @module dsh-pipeline/lib/guard/browser-profile
 */

import { isInside, pathKey } from '../util.js'
import { TAG } from './rules.js'
import { classifyCredentialFileName, classifyCredentialPath } from './credential-paths.js'

/** 判据名（拒绝文案与自测都按它认这条判据）。 */
export const BROWSER_PROFILE_GUARD = 'BROWSER_PROFILE_NO_DATA'

/**
 * shell 里的**复制类动作**特征。
 *
 * 为什么单独列而不是复用 `SHELL_WRITE_RE`：`SHELL_WRITE_RE` 认的是"改文件"
 * （`Set-Content` / 重定向 …），而 P0-2 的动作是 `Copy-Item` / `cp -r` / `robocopy`
 * —— 它们在旧判据里不算"写动词"，却在**把用户数据搬进工作区**这件事上更危险。
 */
const COPY_VERB_RE =
  /(?:^|[\s|;&("'])(?:copy-item|copy|xcopy|robocopy|move-item|move|mv|cp|rsync)\b|\bcpSync\b|\bcopyFile(?:Sync)?\b|\bcopytree\b|\bshutil\.(?:copy|copy2|copyfile|copytree|move)\b|\bfs\.cp\b/i

/** shell 里的**写入类动作**特征（含 `>` 重定向）——用来确认"这条命令在落盘"。 */
const WRITE_VERB_RE =
  /(?:^|[\s|;&("'])(?:set-content|out-file|add-content|new-item|tee|writealltext|writeallbytes|writefile|write_text|write_bytes)\b|\bwriteFile(?:Sync)?\b|\bappendFile(?:Sync)?\b/i
/** 真正的重定向（排除 `2>&1` / `=>` 这类不是写文件的形态）。 */
const REDIRECT_RE = /(?<![=\-<>])(?:\d|\*)?>>?(?![=&])\s*\S/

/** 去引号（成对优先，其次是残余引号）。 */
function stripQuotes(v) {
  const s = String(v ?? '').trim()
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) return s.slice(1, -1)
  return s.replace(/^["']+|["']+$/g, '')
}

/** 命令里的裸 token（不含引号、命令分隔符、重定向符号）。 */
const SHELL_TOKEN_RE = /[^\s"';|&()<>]+/g

/**
 * 把命令里的**相对路径**与**裸凭证名**补进候选集。
 *
 * 为什么需要这一步：`shell.js` 的 `extractCommandPaths` 只捞"像绝对路径"的 token
 * （盘符 / `/` / `./` 开头），而 P0-2 现场的目标恰恰是**相对写法**
 * （`echo x > reports/tester/Cookies`）。不补这一道，重定向 / `Set-Content` 写
 * 相对路径的形态会漏。这里**只做候选收集**，判不判仍由分类器说话。
 */
function mergeRelativeCandidates(cmd, paths) {
  const out = Array.isArray(paths) ? [...paths] : []
  const seen = new Set(out.map((p) => stripQuotes(p)))
  const add = (raw) => {
    const s = stripQuotes(raw)
    if (s.length === 0 || seen.has(s)) return
    seen.add(s)
    out.push(s)
  }
  SHELL_TOKEN_RE.lastIndex = 0
  let m = SHELL_TOKEN_RE.exec(cmd)
  while (m !== null) {
    const tok = m[0].replace(/[.,;:]+$/, '')
    m = SHELL_TOKEN_RE.exec(cmd)
    if (tok.length === 0 || tok.startsWith('-')) continue
    if (/^[a-z]+:\/\//i.test(tok)) continue // URL 不是文件路径
    if (tok.includes('/') || tok.includes('\\')) add(tok)
    else if (classifyCredentialFileName(tok) !== null) add(tok) // 裸 `Cookies` / `Local State` 之类
  }
  return out
}

/** 变量 / 家目录 / 占位符打头的路径：解析不出绝对位置。 */
function isUnresolvable(raw) {
  return /^(?:~|\$|\$\{|%|\.\$)/.test(stripQuotes(raw))
}

/**
 * 这个候选是不是**相对写法**（解析不出绝对位置、但按项目根拼是合理近似）。
 * 绝对路径与变量/占位符都返回 false。
 */
function isRelativeLike(raw) {
  const s = stripQuotes(raw)
  if (s.length === 0 || isUnresolvable(raw)) return false
  return !(/^[a-z]:[\\/]/i.test(s) || s.startsWith('/') || s.startsWith('\\\\'))
}

/**
 * 把一个候选路径解析成"落点"。
 *
 * 三种结果，调用方必须分开处理（别把"取不准"和"不在项目里"混成一回事）：
 *   · 绝对路径 ⇒ 归一化后的绝对路径（能不能落在项目根内由 `isInside` 判）；
 *   · 相对路径 / 裸 token（含 `edge-profile-1` 这种单个目录名）⇒ 按项目根拼
 *     —— **取不准工作目录，就按"落在项目里"处理**（与既有 shell 重定向判据同一条保守口径）；
 *   · 变量 / 家目录 / 占位符打头（`$env:` / `%LOCALAPPDATA%` / `~`）⇒ 返回空串：
 *     它解析不出绝对位置，**不能**当成"落在项目里"。
 *
 * @param {string} raw
 * @param {string} root - 项目根（pathKey 形式）
 * @returns {string} pathKey 形式；解析不出返回空串
 */
function resolveCandidate(raw, root) {
  const s = stripQuotes(raw)
  if (s.length === 0 || isUnresolvable(raw)) return ''
  if (/^[a-z]:[\\/]/i.test(s) || s.startsWith('/') || s.startsWith('\\\\')) return pathKey(s)
  if (root.length === 0) return ''
  if (s.startsWith('./') || s.startsWith('.\\')) return pathKey(`${root}/${s.slice(2)}`)
  return pathKey(`${root}/${s}`)
}

/**
 * 渲染一条**可操作**的拒绝文案。
 *
 * 用户口径：拒绝必须写清"为什么"与"怎么办"（只写"不行"的判词会让模型原地重试）。
 * 这里的"怎么办"照 P0-2 的修复建议写死三条出路：脱敏夹具 / 临时空 profile / 自造结构，
 * 三条都**不需要**真实浏览器数据。
 *
 * @param {object} input
 * @param {string} input.tool
 * @param {string} [input.role]
 * @param {string} [input.targetLine] - 「目标：…」那行（写工具）/「命令片段：…」（shell）
 * @param {string} [input.sourceLine] - 「复制来源：…」那行（shell 复制时）
 * @param {{matched:string, why:string, kind:string}} input.hit
 * @param {'write'|'shell'} input.via
 * @returns {string}
 */
function renderRefusal(input) {
  const L = []
  L.push(`${TAG} 拒绝：**浏览器 Profile / 凭证数据不得进入流水线工作区**。`)
  L.push(`判据：${BROWSER_PROFILE_GUARD}`)
  L.push(`工具：${String(input.tool ?? '(未知)')}${input.role ? `　角色：${input.role}` : ''}`)
  if (typeof input.targetLine === 'string' && input.targetLine.length > 0) L.push(input.targetLine)
  if (typeof input.sourceLine === 'string' && input.sourceLine.length > 0) L.push(input.sourceLine)
  L.push(`命中：${input.hit.matched} —— ${input.hit.why}`)
  L.push('')
  L.push('为什么拒：这类文件是**用户真实的登录态与隐私数据**（Cookie / 密码库 / 浏览历史 / 收藏 / VPN 令牌）。')
  L.push('  把它们复制进工作区有两个后果：')
  L.push('  ① 交付物被用户隐私污染（上一张单实测 374.6 MB）；')
  L.push('  ② pipeline_security_check 会把它记成「凭证落盘」命中 —— 整单不能给 clean，只能返工。')
  L.push('')
  L.push('下一步（三条都不需要真实浏览器数据）：')
  L.push('  ① 要测"读 profile / 导入 profile"这类逻辑：用**脱敏夹具** —— 自己造同结构的小文件或纯 JSON 假数据，')
  L.push('     文件名别用真实库名（Cookies / Login Data / Local State …），内容也不要是真实数据；')
  L.push('  ② 要跑真实浏览器自动化：让 Playwright / Puppeteer 用**临时空 profile** ——')
  L.push('     launchPersistentContext / userDataDir 指向 $env:TEMP（或 os.tmpdir()）下的**新目录**，')
  L.push('     不要复制 %LOCALAPPDATA% / ~/.config 下的用户 profile；')
  L.push('  ③ 只是要一份"目录结构样例"：在工作区里手造空结构，不要从用户目录拷。')
  L.push('')
  L.push('★ 这条判据按**路径**认（文件名 / 目录段），不读文件内容。')
  if (input.via === 'shell') {
    L.push('★ shell 侧是**字符串匹配**的 best-effort 判据（与其它 shell 判据同一条口径）：刻意混淆的写法可能绕过；')
    L.push('  要真正封死需要环境侧配合（不给席位访问用户 profile 的权限）。')
  }
  return L.join('\n')
}

/**
 * ① 写类文件工具的判据：目标落在项目根内，且目标路径像 profile / 凭证 ⇒ 拒。
 *
 * @param {object} input
 * @param {string} input.tool - 工具名（写进拒绝文案）
 * @param {string} [input.role]
 * @param {{projectRoot:string}} input.task - 同步索引条目
 * @param {string[]} input.targets - 本次调用的全部候选目标（绝对路径）
 * @returns {string|undefined} 拒绝理由；`undefined` = 放行
 */
export function browserProfileWriteRefusal(input) {
  const root = typeof input?.task?.projectRoot === 'string' ? pathKey(input.task.projectRoot) : ''
  if (root.length === 0) return undefined
  for (const raw of Array.isArray(input?.targets) ? input.targets : []) {
    const abs = pathKey(raw)
    if (abs.length === 0) continue
    // 项目根之外不归本插件管（与其它路径判据同一条边界）。
    if (!isInside(root, abs)) continue
    const hit = classifyCredentialPath(abs)
    if (hit === null) continue
    return renderRefusal({
      tool: input.tool,
      role: input.role,
      targetLine: `目标：${abs}`,
      hit,
      via: 'write',
    })
  }
  return undefined
}

/**
 * ② shell 的判据：命令里出现复制 / 写入动作，且源或目标像 profile / 凭证 ⇒ 拒。
 *
 * 两类命中（顺序有讲究，先报"目标本身像凭证"这种更确定的）：
 *   A. 某个候选路径**落在项目根内**、且它自己就像 profile / 凭证
 *      ⇒ 不管命令是写还是复制，都拒（工作区里不该出现这种落点）；
 *   B. 复制类动作 + 某个候选路径像 profile / 凭证（通常是**源**），
 *      且存在"落在项目里 / 取不准"的目的地 ⇒ 拒（"从用户目录拷进来"的现场形状）。
 *
 * @param {object} input
 * @param {string} input.tool - 工具名（拒绝文案用）
 * @param {string} [input.role]
 * @param {{projectRoot:string}} input.task
 * @param {string} input.cmd - 命令原文
 * @param {string[]} input.paths - 命令里的候选路径（由调用方用既有提取器给出）
 * @returns {string|undefined} 拒绝理由；`undefined` = 放行
 */
export function browserProfileShellRefusal(input) {
  const cmd = String(input?.cmd ?? '')
  if (cmd.length === 0) return undefined
  const root = typeof input?.task?.projectRoot === 'string' ? pathKey(input.task.projectRoot) : ''
  const paths = mergeRelativeCandidates(
    cmd,
    (Array.isArray(input?.paths) ? input.paths : []).map((p) => String(p ?? '')).filter((p) => p.length > 0),
  )
  if (paths.length === 0) return undefined

  const isCopy = COPY_VERB_RE.test(cmd)
  const isWrite = isCopy || WRITE_VERB_RE.test(cmd) || REDIRECT_RE.test(cmd)
  if (!isWrite) return undefined

  // A. 候选落点本身像 profile / 凭证，且落在项目根内。
  if (root.length > 0) {
    for (const raw of paths) {
      const abs = resolveCandidate(raw, root)
      if (abs.length === 0 || !isInside(root, abs)) continue
      const hit = classifyCredentialPath(abs)
      if (hit === null) continue
      return renderRefusal({
        tool: input.tool,
        role: input.role,
        targetLine: `命令片段：${cmd.slice(0, 200)}\n落点：${abs}`,
        hit,
        via: 'shell',
      })
    }
  }

  // B. 复制类动作 + 源像 profile / 凭证 + 目的地落在项目里（或取不准）⇒ 拒。
  if (isCopy) {
    let source = null
    let sourceRaw = ''
    for (const raw of paths) {
      const hit = classifyCredentialPath(raw)
      if (hit === null) continue
      // 落在项目根内的候选在 A 段已经处理过；这里只找"项目外 / 取不准"的那一侧（源）。
      const abs = resolveCandidate(raw, root)
      if (abs.length > 0 && root.length > 0 && isInside(root, abs)) continue
      source = hit
      sourceRaw = raw
      break
    }
    if (source !== null) {
      let dest = ''
      for (const raw of paths) {
        if (raw === sourceRaw) continue
        const abs = resolveCandidate(raw, root)
        if (abs.length > 0) {
          if (root.length > 0 && isInside(root, abs)) {
            dest = abs
            break
          }
          continue
        }
        // 解析不出绝对位置：**变量 / 占位符打头的不算**（例如 `$env:TEMP\out` 是项目外），
        // 只有相对写法（`reports/tester/x`、裸目录名 `edge-profile-1`）才按"落在项目里"处理。
        if (isRelativeLike(raw) && classifyCredentialPath(raw) === null) {
          dest = raw
          break
        }
      }
      if (dest.length > 0) {
        return renderRefusal({
          tool: input.tool,
          role: input.role,
          targetLine: `命令片段：${cmd.slice(0, 200)}\n落点：${dest}`,
          sourceLine: `复制来源：${sourceRaw}`,
          hit: source,
          via: 'shell',
        })
      }
    }
  }

  return undefined
}
