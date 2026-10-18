/**
 * dsh-pipeline · 安全确认扫描器
 * ============================================================================
 *
 * 「审核必须确认网络安全/本地泄密是否发生」—— 这个模块把那条要求变成**可执行的扫描**，
 * 而不是验收标准里的一行字。
 *
 * ## 三条面
 *   · **local_leak**（本地泄密）：密钥/凭证/隐私是否出现在**不该出现的地方**
 *     （制品、报告、日志、收据、audit.jsonl）
 *   · **credential_store**（凭证落盘，P0-2 新增）：工作区里是不是躺着**浏览器 Profile
 *     的凭证库 / 隐私数据**（Cookies / Login Data / Web Data / Local State / History /
 *     Bookmarks / Vpn Tokens / `*.sqlite` / `edge-profile*` / `User Data` …）。
 *     ★ 它是**按路径认**的：那些文件是二进制 SQLite，原来的文本扫描根本看不见；
 *     而"按内容认"会把几百 MB 读一遍（扫描器自己成了资源消耗点）。
 *   · **network**（网络面）：产物/脚本/依赖里有没有**外联地址**，有没有**未解释**的外联，
 *     有没有**凭证出现在出网请求里**
 *
 * ## ★ 扫描范围边界（重要）
 * **只扫本任务工作区**：`<项目>/.pipeline/<taskId>/` 底下的东西（制品、报告、交接物、审计日志），
 * 加上调用方显式给出的、**必须落在项目根之内**的补充路径。
 *
 * 为什么不扫全盘：越界（读无关目录）、慢（且随磁盘增大而变慢）、
 * 而且违反最小权限 —— 一个做安全扫描的工具如果自己去遍历用户整个硬盘，那本身就是个安全问题。
 *
 * ## ★ 自我指涉：扫描结果**不得回显命中原文**
 * 这是本模块最要紧的一条设计约束 —— **否则这个工具本身就成了泄密渠道**。
 *   · 命中只记 `{ file, line, type, why, preview }`
 *   · `preview` 是**打码后**的片段（保留可辨识的头尾，中间打掉）
 *   · 摘要里只出现「`<文件>` 第 N 行命中 `<类型>`」
 * 自测里有一条断言专门盯这件事（把命中原文从整个结果 JSON 里搜一遍，搜到就判失败）。
 *
 * @module dsh-pipeline/lib/security
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'

import { isInside, pathKey } from './util.js'
// ★★ P0-2：浏览器 profile / 凭证库的**路径**识别 —— 唯一出处是 `guard/credential-paths.js`，
//    与守门（`guard/browser-profile.js`）共用同一份名单，不在这里另写一套（两份必然漂移）。
import { classifyBrowserProfileDirName, classifyCredentialFileName } from './guard/credential-paths.js'

// ---------------------------------------------------------------------------
// 一、模式表
// ---------------------------------------------------------------------------

/**
 * 本地泄密面：疑似凭证 / 隐私。
 *
 * `severity`：`high` = 泄露即事故；`medium` = 需要人看一眼；`low` = 提示。
 */
export const SECRET_PATTERNS = [
  { type: 'private_key_header', severity: 'high', re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/, why: '私钥头 —— 私钥绝不该出现在产物、报告或日志里' },
  { type: 'openai_style_key', severity: 'high', re: /\bsk-[A-Za-z0-9_-]{16,}\b/, why: 'OpenAI 风格密钥（sk- 前缀 + 长随机串）' },
  { type: 'aws_access_key_id', severity: 'high', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, why: 'AWS Access Key ID' },
  { type: 'sessdata', severity: 'high', re: /SESSDATA\s*[=:]\s*\S{8,}/i, why: 'B 站 SESSDATA 会话凭证' },
  { type: 'cookie', severity: 'high', re: /\b(?:set-)?cookie\s*[:=]\s*\S{12,}/i, why: 'Cookie 值' },
  { type: 'bearer_token', severity: 'high', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i, why: 'Bearer 令牌' },
  { type: 'jwt', severity: 'high', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/, why: 'JWT' },
  { type: 'conn_string_with_password', severity: 'high', re: /\b(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^\s"'`]{0,64}:[^\s"'`@]{3,}@/i, why: '带密码的连接串' },
  { type: 'generic_assigned_secret', severity: 'medium', re: /\b(?:api[_-]?key|secret|passwd|password|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}/i, why: '疑似凭证赋值（key=value 形状）' },
  { type: 'email_address', severity: 'medium', re: /(?<![\w.-])[\w.+-]{1,64}@[\w-]{1,63}\.[A-Za-z]{2,10}(?![\w.-])/, why: '真实邮箱地址' },
  {
    type: 'cn_mobile',
    severity: 'medium',
    /**
     * ⚠️ 前后各加一个「不能在十六进制串里」的约束。
     *
     * 为什么：本插件在 `.pipeline/` 里存了一堆 **sha256**（制品摘要、改动基线的逐文件哈希）。
     * 64 位十六进制里出现 `1[3-9]` + 9 位数字是**必然会发生**的（量级上每十几个哈希就有一个），
     * 于是"扫描自己的台账"会随机报出**假手机号** —— 而且随文件内容变、跑一次一个样，
     * 是最难查的那种 flake（真实现象：`security-check` 的正例偶发失败）。
     *
     * 真正的手机号旁边不会紧贴十六进制字母（`a`-`f`），所以这个约束不会漏真号码：
     * `联系电话 13800138000` 前后是空格/引号，照旧命中。
     */
    re: /(?<![0-9a-f])1[3-9]\d{9}(?![0-9a-f])/,
    why: '中国大陆手机号',
  },
]

/**
 * 网络面：外联地址。
 */
export const NETWORK_PATTERNS = [
  { type: 'http_url', severity: 'low', re: /\bhttps?:\/\/[^\s"'`<>)\]}，。；]+/gi, why: '外联 URL' },
  { type: 'host_with_port', severity: 'low', re: /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,12}:\d{2,5}\b/gi, why: '外联主机:端口' },
]

/** 这些 host 不算"外联"（本机 / 保留地址 / 占位符）。 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'example.com', 'example.org', 'example.net', 'test.local'])

// ---------------------------------------------------------------------------
// 二、打码
// ---------------------------------------------------------------------------

/**
 * ★ 把命中片段**打码**。
 *
 * 保留头尾各几个字符（够人认出"这是哪一类东西"），中间全部换成 `*`。
 * 长度也一并报出来 —— 长度通常不敏感，但对判断"这是不是真凭证"很有用。
 *
 * @param {string} raw
 * @returns {string}
 */
export function mask(raw) {
  const s = String(raw ?? '')
  if (s.length <= 6) return '*'.repeat(s.length)
  const head = s.slice(0, 3)
  const tail = s.slice(-2)
  return `${head}${'*'.repeat(Math.min(12, s.length - 5))}${tail}（共 ${s.length} 字符）`
}

/**
 * ★ 判定一段文本里**有没有**疑似凭证原文。
 *
 * 用途：拦住"审核把命中的密钥原文抄进了审核结论"这种行为 ——
 * 那等于把泄露从制品搬到了结论里。
 *
 * @param {string} text
 * @returns {{type:string, why:string} | null}
 */
export function looksLikeRawSecret(text) {
  const s = String(text ?? '')
  for (const p of SECRET_PATTERNS) {
    if (p.severity === 'high' && p.re.test(s)) return { type: p.type, why: p.why }
  }
  return null
}

// ---------------------------------------------------------------------------
// 三、扫描
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 2 * 1024 * 1024 // 单文件 2MB 上限：再大基本是二进制/产物，跳过
const MAX_FILES = 500

/** 跳过这些目录/文件名（噪音大且与安全面无关系）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '__pycache__'])
/**
 * ★ 跳过本插件**自己的哈希台账**（`baseline-*.json`：只有路径 + sha256，没有内容）。
 *
 * 它不是交付物、不含人能读的信息 —— 但里面有几百个 64 位十六进制串，
 * 会把"高熵/像号码"这类模式打成筛子（见 `cn_mobile` 那条规则的注释）。
 * 这是"扫描范围"的取舍，不是"少扫一点更省事"：要扫的是产物与报告，哈希台账不在其中。
 */
const SKIP_FILES = /^baseline-BL-[\w-]+\.json$/
const TEXT_EXT = /\.(json|jsonl|md|txt|log|js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|yml|yaml|toml|ini|cfg|conf|sh|ps1|sql|csv|html|htm|xml|env|pem|key|crt)$/i

/**
 * 走一遍目录，收集要扫的文件（**只在这棵树里走**），顺手收集**凭证落盘**命中。
 *
 * ★ P0-2：凭证库是**二进制 SQLite**，而且「浏览器 profile 目录」可能几百 MB ——
 * 所以必须在**遍历时按路径认**，不能等读内容再判：
 *   · 目录名命中 profile 目录标记（`User Data` / `edge-profile*` / `google-chrome` …）
 *     ⇒ 记一条命中，并且**不再向下遍历**（既省掉几百 MB 的读取，也不去碰里面的会话数据）；
 *   · 文件名命中凭证名 / 凭证扩展名（`Cookies` / `Login Data` / `*.sqlite` …）⇒ 记一条命中。
 *
 * @param {string} root
 * @param {string[]} acc - 收集到的**文本**文件（照旧走内容扫描）
 * @param {number} [depth]
 * @param {Array<{abs:string, kind:string, matched:string, why:string}>|null} [storeHits]
 *   - 凭证落盘命中（`null` = 不收集，行为与改前一致）
 */
async function collectFiles(root, acc, depth = 0, storeHits = null) {
  if (depth > 6 || acc.length >= MAX_FILES) return
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) return
    const p = join(root, e.name)
    if (storeHits !== null) {
      if (e.isDirectory()) {
        const hit = classifyBrowserProfileDirName(e.name)
        if (hit !== null) {
          storeHits.push({ abs: p, kind: hit.kind, matched: hit.matched, why: hit.why })
          continue // 命中目录即整个跳过：不再向下读（二进制、几百 MB、且属于隐私数据）
        }
      } else if (e.isFile()) {
        const hit = classifyCredentialFileName(e.name)
        if (hit !== null) storeHits.push({ abs: p, kind: hit.kind, matched: hit.matched, why: hit.why })
      }
    }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      await collectFiles(p, acc, depth + 1, storeHits)
    } else if (e.isFile()) {
      // 只扫文本类；`audit.jsonl` / `task.json` 没有扩展名特征，但都被 json 覆盖
      if (SKIP_FILES.test(e.name)) continue
      if (TEXT_EXT.test(e.name) || e.name === 'audit.jsonl') acc.push(p)
    }
  }
  return acc
}

/**
 * 扫描一批文件。
 *
 * @param {object} input
 * @param {string[]} input.files - 绝对路径列表
 * @param {string} input.relBase - 相对路径的基准（写进结果的 `file` 字段，避免泄露绝对路径）
 * @param {string[]} [input.allowedHosts] - 已解释的外联 host
 * @param {string} [input.requirement] - 需求文本（用来判断外联"有没有解释"）
 * @returns {Promise<object>}
 */
export async function scanFiles(input) {
  const relBase = input.relBase
  const allowed = new Set((input.allowedHosts ?? []).map((h) => String(h).toLowerCase()))
  const requirement = String(input.requirement ?? '').toLowerCase()

  const leakFindings = []
  const netHits = []
  const files = []
  let scannedBytes = 0

  for (const abs of input.files) {
    let info
    try {
      info = await stat(abs)
    } catch {
      continue
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
    let text
    try {
      text = await readFile(abs, 'utf8')
    } catch {
      continue
    }
    // 二进制嗅探：NUL 字节直接跳过
    if (text.includes('\u0000')) continue
    scannedBytes += info.size
    const rel = relative(relBase, abs).replace(/\\/g, '/')
    files.push({ path: rel, bytes: info.size })

    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // --- 本地泄密面 ---
      for (const p of SECRET_PATTERNS) {
        p.re.lastIndex = 0
        const m = p.re.exec(line)
        if (m === null) continue
        leakFindings.push({
          file: rel,
          line: i + 1,
          type: p.type,
          severity: p.severity,
          why: p.why,
          // ★ 只给打码片段，绝不回显原文
          preview: mask(m[0]),
        })
      }
      // --- 网络面 ---
      for (const p of NETWORK_PATTERNS) {
        p.re.lastIndex = 0
        let m
        const found = []
        while ((m = p.re.exec(line)) !== null) {
          found.push(m[0])
          if (p.re.lastIndex === m.index) p.re.lastIndex += 1
        }
        for (const raw of found) {
          const host = hostOf(raw)
          if (host === null || LOCAL_HOSTS.has(host)) continue
          netHits.push({
            file: rel,
            line: i + 1,
            type: p.type,
            host,
            target: mask(raw),
            // 同一行里还有凭证 ⇒ 凭证可能随出网请求发出去
            withCredential: SECRET_PATTERNS.some((sp) => {
              sp.re.lastIndex = 0
              return sp.severity === 'high' && sp.re.test(line)
            }),
          })
        }
      }
    }
  }

  // --- 外联"有没有解释" ----------------------------------------------------
  const byHost = new Map()
  for (const h of netHits) {
    if (!byHost.has(h.host)) byHost.set(h.host, { host: h.host, hits: [], withCredential: false })
    const g = byHost.get(h.host)
    g.hits.push({ file: h.file, line: h.line })
    if (h.withCredential) g.withCredential = true
  }

  const netFindings = []
  for (const g of byHost.values()) {
    const explainedByAllow = allowed.has(g.host)
    const explainedByRequirement = requirement.includes(g.host)
    if (!explainedByAllow && !explainedByRequirement) {
      netFindings.push({
        file: g.hits[0].file,
        line: g.hits[0].line,
        type: 'unexplained_outbound',
        severity: 'medium',
        why: '出现了外联地址，但需求/验收/白名单里都没有解释它 —— 未解释的外联必须能对应到需求，对不上就要打回',
        host: g.host,
        occurrences: g.hits.length,
      })
    }
    if (g.withCredential) {
      netFindings.push({
        file: g.hits[0].file,
        line: g.hits[0].line,
        type: 'credential_in_outbound',
        severity: 'high',
        why: '★ 同一行里既有外联地址又有疑似凭证 —— 凭证可能随出网请求发出去，这类一律记为问题',
        host: g.host,
        occurrences: 1,
      })
    }
  }

  return {
    files_scanned: files.length,
    bytes_scanned: scannedBytes,
    files,
    local_leak: { findings: leakFindings },
    network: { findings: netFindings, hosts: [...byHost.values()].map((g) => ({ host: g.host, occurrences: g.hits.length, withCredential: g.withCredential })) },
    hosts_allowed: [...allowed],
  }
}

/** 从一段 URL / host:port 里取出小写 host。 */
export function hostOf(raw) {
  const s = String(raw ?? '').trim()
  try {
    if (/^https?:\/\//i.test(s)) return new URL(s).hostname.toLowerCase()
  } catch {
    /* 不是合法 URL，落下去按 host:port 处理 */
  }
  const m = /^([a-z0-9.-]+):\d{2,5}$/i.exec(s)
  return m === null ? null : m[1].toLowerCase()
}

// ---------------------------------------------------------------------------
// 四、对外入口
// ---------------------------------------------------------------------------

/**
 * ★ 对一个任务做安全确认扫描。
 *
 * @param {object} input
 * @param {object} input.task
 * @param {string} input.projectRoot
 * @param {string} input.pipelineDir
 * @param {string[]} [input.extraPaths] - 补充扫描路径（**必须落在项目根之内**）
 * @param {string[]} [input.allowedHosts]
 * @returns {Promise<object>}
 */
export async function runSecurityScan(input) {
  const { task, projectRoot, pipelineDir } = input
  const taskDir = join(pipelineDir, task.id)
  const rejected = []

  const roots = [taskDir]
  for (const raw of input.extraPaths ?? []) {
    const abs = pathKey(isAbsoluteLike(raw) ? raw : join(projectRoot, raw))
    if (!isInside(pathKey(projectRoot), abs)) {
      rejected.push({ path: String(raw), reason: '超出本任务工作区（项目根之外）—— 按最小权限，扫描不越界' })
      continue
    }
    roots.push(abs)
  }

  const files = []
  /** ★ P0-2：遍历时按**路径**收集到的浏览器 profile / 凭证库命中。 */
  const storeHits = []
  for (const r of roots) await collectFiles(r, files, 0, storeHits)
  const uniq = [...new Set(files.map((f) => pathKey(f)))]

  /**
   * ★★ P0-2：凭证落盘命中（`credential_store` 面）。
   *
   * 它是**一等命中**：进 `finding_count`，所以 `attestation` 不会再是 clean。
   * 但摘要里**只给"哪个文件 / 目录命中哪一类"**（文件内容一个字节都不读、不回显）——
   * 与 `local_leak` 的打码口径同一条：工具自身不得成为泄密渠道。
   */
  const storeFindings = []
  const seenStore = new Set()
  for (const h of storeHits) {
    const key = pathKey(h.abs)
    if (seenStore.has(key)) continue
    seenStore.add(key)
    storeFindings.push({
      file: relative(pathKey(projectRoot), h.abs).replace(/\\/g, '/') || String(h.abs),
      line: 0,
      type: h.kind,
      category: 'credential_store',
      severity: 'high',
      why:
        h.kind === 'browser_profile_dir'
          ? `${h.why} —— 里面是 Cookies / Login Data / Local State 等真实登录态，不该出现在交付工作区`
          : `${h.why} —— 属于用户真实登录态，不该出现在交付工作区`,
      matched: String(h.matched ?? ''),
    })
  }

  const scan = await scanFiles({
    files: uniq,
    relBase: pathKey(projectRoot),
    allowedHosts: input.allowedHosts ?? [],
    requirement: `${task.requirement ?? ''} ${(task.roster?.acceptance ?? []).join(' ')}`,
  })

  const total = scan.local_leak.findings.length + scan.network.findings.length + storeFindings.length
  return {
    ok: true,
    task_id: task.id,
    scanned_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    scope: {
      roots: roots.map((r) => relative(pathKey(projectRoot), r).replace(/\\/g, '/') || '.'),
      rejected_paths: rejected,
      files_scanned: scan.files_scanned,
      bytes_scanned: scan.bytes_scanned,
      // ★ 边界写进结果，让调用方一眼看到"扫到哪为止"
      boundary: '只扫本任务工作区（.pipeline/<taskId>/ 与显式给出的、落在项目根内的路径）；不遍历用户其它目录。',
    },
    local_leak: scan.local_leak,
    credential_store: {
      findings: storeFindings,
      /**
       * ★ 这条边界要写在结果里：profile 目录命中后**不再向下读**。
       * 理由：里面是二进制 SQLite 与几百 MB 隐私数据，内容扫描既没用又危险。
       */
      boundary: '凭证库按**路径**认（文件名 / 目录段），不读内容；浏览器 profile 目录命中后不再向下遍历。',
    },
    network: scan.network,
    hosts_allowed: scan.hosts_allowed,
    finding_count: total,
  }
}

const isAbsoluteLike = (s) => /^[a-z]:[\\/]/i.test(String(s)) || String(s).startsWith('/')

/**
 * ★ 把扫描结果渲染成**脱敏**的人可读摘要。
 *
 * 逐条只写「`<文件>` 第 N 行命中 `<类型>`」+ 打码片段，
 * **任何情况下都不出现命中原文**。
 */
export function renderScanSummary(scan) {
  const lines = []
  lines.push(`安全确认扫描：任务 ${scan.task_id}`)
  lines.push(`扫描范围：${scan.scope.roots.join('、')}　文件 ${scan.scope.files_scanned} 个 / ${(scan.scope.bytes_scanned / 1024).toFixed(1)} KB`)
  lines.push(`边界：${scan.scope.boundary}`)
  if (scan.scope.rejected_paths.length > 0) {
    lines.push(`⚠ 被拒绝的扫描路径（越界，未扫）：`)
    for (const r of scan.scope.rejected_paths) lines.push(`   · ${r.path} —— ${r.reason}`)
  }
  lines.push('')

  lines.push(`【本地泄密面】命中 ${scan.local_leak.findings.length} 处`)
  if (scan.local_leak.findings.length === 0) {
    lines.push('  （未发现密钥/凭证/隐私特征）')
  } else {
    for (const f of scan.local_leak.findings) {
      // ★ 只写"哪个文件第几行命中了哪一类"，**不回显原文**
      lines.push(`  · ${f.file} 第 ${f.line} 行命中 ${f.type}（${f.severity}）　${f.preview}`)
      lines.push(`      ${f.why}`)
    }
  }
  lines.push('')

  /**
   * ★★ P0-2：**凭证落盘**面（一等命中，不是外联假阳性）。
   *
   * 只给「哪个文件 / 目录命中哪一类」—— 这类发现本来就不看内容（二进制 SQLite），
   * 所以摘要里连打码片段都没有：命中信息**只有路径与类型**。
   */
  const cred = Array.isArray(scan.credential_store?.findings) ? scan.credential_store.findings : []
  lines.push(`【凭证落盘】命中 ${cred.length} 处`)
  if (cred.length === 0) {
    lines.push('  （未见浏览器 Profile / 凭证库文件）')
  } else {
    for (const f of cred) {
      lines.push(`  ✗ ${f.file} 命中 ${f.type}（${f.severity}）`)
      lines.push(`      ${f.why}`)
    }
    if (typeof scan.credential_store?.boundary === 'string' && scan.credential_store.boundary.length > 0) {
      lines.push(`      边界：${scan.credential_store.boundary}`)
    }
  }
  lines.push('')

  const hosts = scan.network.hosts ?? []
  lines.push(`【网络面】外联主机 ${hosts.length} 个，命中 ${scan.network.findings.length} 处`)
  if (hosts.length === 0) {
    lines.push('  （未发现外联地址）')
  } else {
    for (const h of hosts) {
      lines.push(`  · ${h.host}　出现 ${h.occurrences} 次${h.withCredential ? '　⚠ 伴随凭证' : ''}`)
    }
    for (const f of scan.network.findings) {
      lines.push(`  ✗ ${f.file} 第 ${f.line} 行：${f.type} → ${f.host}${f.occurrences > 1 ? `（共 ${f.occurrences} 次）` : ''}`)
      lines.push(`      ${f.why}`)
    }
  }
  lines.push('')
  lines.push(`合计 ${scan.finding_count} 处。★ 本摘要**不含任何命中原文** —— 只给位置与类型（工具自身不得成为泄密渠道）。`)
  return lines.join('\n')
}
