#!/usr/bin/env node
/**
 * dsh-pipeline · 本地控制面板（需求单 / bug 单 / 变动日志 · 只读 · 带密钥门）
 * ============================================================================
 * 只给控制角色看的单页面板。**每次请求现读**三份文档本身（不另存副本），
 * 所以文档一改、刷新即最新，不需要重新部署。
 *
 *   node server.mjs --init     生成 dashboard-keys.json（四把随机钥匙 + 探测到的空闲端口）；
 *                              已有文件时会**重新生成钥匙**（= 轮换）
 *   node server.mjs            启动面板
 *   node server.mjs --print    只打印地址 / 端口 / 钥匙掩码，不启服务
 *   --docs <目录>              数据源所在目录（默认：仓库的 docs/；也认环境变量 DSH_DASHBOARD_DOCS）
 *
 * 硬约束（每一条都落在下面的代码里）：
 *   · 零依赖：只 import `node:` 内置模块
 *   · 只监听 127.0.0.1；Host 头也只认 127.0.0.1 / localhost
 *   · 纯 GET：其余方法一律 405（allow: GET）；只有 `/` 一个路由，其余 404
 *   · 钥匙：`?k=<key>` 或请求头 `x-dsh-key`，与四把钥匙逐字全等比对；不中 ⇒ 403，
 *     且 403 之前**不碰数据源**（不读、不列目录、不回显路径）
 *   · 页面与命令行输出里从不出现完整钥匙（只给前 6 位）；完整值只在 dashboard-keys.json
 *   · 页面外链 0：样式全内嵌，没有 <script> / <link> / <img> / 任何 href
 *
 * @module dsh-pipeline/dashboard/server
 */

import http from 'node:http'
import net from 'node:net'
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { userInfo } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEYS_FILE = join(HERE, 'dashboard-keys.json')
const PID_FILE = join(HERE, 'dashboard.pid')
const PORT_FROM = 18240
const PORT_TO = 18340

/** 四个控制角色。四把钥匙权限相同（只读全量视图），区别只在页面顶部标注的身份。 */
export const ROLES = ['main', 'orchestrator', 'supervisor', 'archivist']
export const ROLE_ZH = { main: '主对话', orchestrator: '需求分析', supervisor: '主管', archivist: '归档' }

/** 数据源（相对数据源目录）。文件名与原 dsh_orb 目录下的一致，换目录只需 --docs。 */
export const SOURCES = [
  { id: 'req', label: '需求清单', rel: join('需求清单与进度-20261014', '需求清单与进度.md') },
  { id: 'bug', label: 'bug 单', rel: 'bug待修复单-20261014.md' },
  { id: 'log', label: '变动日志', rel: '变动日志.md' },
]

// ---------------------------------------------------------------------------
// 钥匙与配置
// ---------------------------------------------------------------------------

const newKey = () => randomBytes(16).toString('hex')
export const mask = (key) => `${String(key).slice(0, 6)}…（${String(key).length} 位）`

/** 真 bind 探测：返回区间里第一个能在 127.0.0.1 上监听的端口。 */
function probeFreePort(from, to) {
  return new Promise((done, fail) => {
    const tryPort = (p) => {
      if (p > to) return fail(new Error(`${from}–${to} 之间没有空闲端口`))
      const s = net.createServer()
      s.once('error', () => tryPort(p + 1))
      s.listen(p, '127.0.0.1', () => s.close(() => done(p)))
    }
    tryPort(from)
  })
}

/**
 * 把钥匙文件锁到只有当前用户能读。
 * Windows 上 chmod 基本是空操作，真正执法的是 ACL：去掉继承、只留当前用户。
 */
function lockDown(file) {
  try { chmodSync(file, 0o600) } catch { /* Windows 上无效，下面的 ACL 才是执法面 */ }
  if (process.platform !== 'win32') return true
  try {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${userInfo().username}:F`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function readConfig() {
  if (!existsSync(KEYS_FILE)) return null
  const cfg = JSON.parse(readFileSync(KEYS_FILE, 'utf8'))
  for (const r of ROLES) {
    if (!/^[0-9a-f]{32}$/.test(String(cfg.keys?.[r] ?? ''))) throw new Error(`dashboard-keys.json 里 ${r} 的钥匙缺失或格式不对，请重跑 --init`)
  }
  if (!Number.isInteger(cfg.port)) throw new Error('dashboard-keys.json 里没有 port，请重跑 --init')
  return cfg
}

async function doInit() {
  const old = existsSync(KEYS_FILE) ? JSON.parse(readFileSync(KEYS_FILE, 'utf8')) : null
  const port = Number.isInteger(old?.port) ? old.port : await probeFreePort(PORT_FROM, PORT_TO)
  const cfg = {
    _note: '★ 本文件含完整密钥，权限已写死 600；页面与报告里只允许出现前 6 位。',
    port,
    keys: Object.fromEntries(ROLES.map((r) => [r, newKey()])),
    created_at: new Date().toISOString(),
  }
  writeFileSync(KEYS_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  const locked = lockDown(KEYS_FILE)
  console.log(old ? '已轮换钥匙（旧钥匙全部作废）。' : '已生成钥匙。')
  console.log(`端口：${port}${old?.port ? '（沿用）' : '（探测得到）'}`)
  for (const r of ROLES) console.log(`  ${r.padEnd(12)} ${ROLE_ZH[r].padEnd(4)}  ${mask(cfg.keys[r])}`)
  console.log(locked ? '钥匙文件已限制为只有当前用户可读。' : '⚠ 钥匙文件权限没锁上（icacls 失败），请手动检查。')
}

// ---------------------------------------------------------------------------
// Markdown 解析（只认这三份文档用到的形态）
// ---------------------------------------------------------------------------

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 行内：`code` 与 **粗体**；其余一律转义（`<DSH_HOME>` 这类占位符必须转义，否则浏览器当成标签吞掉）。 */
export function inline(s) {
  return String(s ?? '')
    .split(/(`[^`]*`)/)
    .map((part) => (part.length >= 2 && part.startsWith('`') && part.endsWith('`')
      ? `<code>${esc(part.slice(1, -1))}</code>`
      : esc(part).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')))
    .join('')
}

/** 表格行切格：`\|` 是格内的竖线，不切。 */
function cellsOf(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

/** 全文的表格，带所在的 ## / ### 标题。 */
export function parseTables(md) {
  const lines = md.split(/\r?\n/)
  const out = []
  let h2 = ''
  let h3 = ''
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^## /.test(l)) { h2 = l.slice(3).trim(); h3 = '' }
    else if (/^### /.test(l)) h3 = l.slice(4).trim()
    if (l.startsWith('|') && /^\|\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const header = cellsOf(l)
      const rows = []
      let j = i + 2
      while (j < lines.length && lines[j].startsWith('|')) rows.push(cellsOf(lines[j++]))
      out.push({ h2, h3, header, rows })
      i = j - 1
    }
  }
  return out
}

const REQ_STATUS = [
  ['✅', 'done', '已完成'],
  ['🔄', 'doing', '进行中'],
  ['⏳', 'todo', '待实现'],
  ['📜', 'rule', '流程约定'],
  ['❌', 'no', '不做'],
]

/**
 * 需求单：「一、…」到「七、…」七个小节里的五列表（# · 一句话 · 状态 · 判据落点 · 报告出处）。
 * 「📜 流程约定」那一节是同一批条目的归类处（文档明说不计入 33），所以不收。
 */
export function parseRequirements(md) {
  const tables = parseTables(md)
  const items = []
  for (const t of tables) {
    if (!/^[一二三四五六七八九十]+、/.test(t.h2) || t.header[0] !== '#' || !t.header.includes('状态')) continue
    const si = t.header.indexOf('状态')
    for (const r of t.rows) {
      const raw = r[si] ?? ''
      const st = REQ_STATUS.find(([e]) => raw.includes(e))
      items.push({ section: t.h2, id: r[0], text: r[1], status: st?.[1] ?? 'unknown', statusZh: st ? `${st[0]} ${st[2]}` : raw, criteria: r[si + 1] ?? '', source: r[si + 2] ?? '' })
    }
  }
  const newSections = md.split(/\r?\n/).filter((l) => /^## ★★/.test(l)).map((l) => l.replace(/^## ★★\s*/, ''))
  const doneTable = tables.find((t) => /今天做完的/.test(t.h3) && t.header.includes('报告文件'))
  const done = doneTable ? doneTable.rows.map((r) => ({ n: r[0], file: r[1], bytes: r[2], what: r[3] })) : []
  return { items, newSections, done }
}

const BUG_STATUS = [
  [/已修完并活体验收通过/, 'ok'],
  [/已止血/, 'partial'],
  [/未修/, 'open'],
  [/设计如此/, 'design'],
  [/已修/, 'fixed'],
]

/** bug 单：`## P0 组` 下的 `### P0-1 标题` + `**状态**：` + `**一句证据**：`；以及「重启后需复验」勾选清单。 */
export function parseBugs(md) {
  const lines = md.split(/\r?\n/)
  const bugs = []
  const recheck = []
  let group = null
  let inRecheck = false
  let cur = null
  for (const l of lines) {
    if (/^## /.test(l)) {
      const g = l.match(/^## (P\d) 组/)
      group = g ? g[1] : null
      inRecheck = /重启后需复验/.test(l)
      cur = null
      continue
    }
    if (group) {
      const h = l.match(/^### (P\d-\d+)\s+(.*)$/)
      if (h) { cur = { group, id: h[1], title: h[2], status: '', statusKind: 'unknown', evidence: '' }; bugs.push(cur); continue }
      if (cur) {
        const s = l.match(/^\*\*状态\*\*\s*[:：]\s*(.*)$/)
        if (s) { cur.status = s[1]; cur.statusKind = (BUG_STATUS.find(([re]) => re.test(s[1])) ?? [null, 'unknown'])[1] }
        const e = l.match(/^\*\*一句证据\*\*\s*[:：]\s*(.*)$/)
        if (e) cur.evidence = e[1]
      }
    }
    if (inRecheck) {
      const c = l.match(/^- \[( |x|X)\]\s*(.*)$/)
      if (c) {
        const [title, ...fields] = c[2].split(/\s*[｜|]\s*(?=\*\*)/)
        recheck.push({ checked: c[1] !== ' ', title, fields })
      }
    }
  }
  return { bugs, recheck }
}

/** 变动日志一行：`- [YYYY-MM-DD HH:mm] 谁：…｜单：…｜变动：…｜证据：…`（全角/半角分隔符都认，字段名前后可有空格）。 */
const LOG_LINE = /^- \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*谁\s*[:：]\s*(.*?)\s*[｜|]\s*单\s*[:：]\s*(.*?)\s*[｜|]\s*变动\s*[:：]\s*(.*?)\s*[｜|]\s*证据\s*[:：]\s*(.*)$/

export function parseLog(md) {
  const lines = md.split(/\r?\n/)
  const entries = []
  const usage = []
  let bad = 0
  let section = ''
  lines.forEach((l, i) => {
    if (/^## /.test(l)) { section = l; return }
    if (/这个日志怎么用/.test(section) && /^- /.test(l)) usage.push(l.slice(2))
    if (/^## 记录/.test(section) && /^- \[/.test(l)) {
      const m = l.match(LOG_LINE)
      if (m) entries.push({ at: m[1], who: m[2], ticket: m[3], change: m[4], evidence: m[5], order: i })
      else bad++
    }
  })
  // 时间倒序；同一时刻按文件里的先后倒排（后追加的在前）
  entries.sort((a, b) => (a.at === b.at ? b.order - a.order : a.at < b.at ? 1 : -1))
  const countBy = (f) => [...entries.reduce((m, e) => m.set(f(e), (m.get(f(e)) ?? 0) + 1), new Map())]
  return {
    entries,
    usage,
    bad,
    byDay: countBy((e) => e.at.slice(0, 10)),
    byWho: countBy((e) => e.who.replace(/[（(].*$/, '').trim()),
  }
}

// ---------------------------------------------------------------------------
// 读数据源（★ 每次请求都现读）
// ---------------------------------------------------------------------------

function readSources(docsDir) {
  return SOURCES.map((s) => {
    const path = join(docsDir, s.rel)
    try {
      const st = statSync(path)
      const buf = readFileSync(path)
      return { ...s, path, ok: true, mtime: st.mtime, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), text: buf.toString('utf8') }
    } catch (err) {
      return { ...s, path, ok: false, error: err.code ?? String(err.message ?? err) }
    }
  })
}

const pad = (n) => String(n).padStart(2, '0')
const fmtTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const num = (n) => Number(n).toLocaleString('en-US')

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

const CSS = `
:root{--bg:#f3f5f7;--card:#fff;--fg:#161a1f;--muted:#5a636f;--line:#e2e6ea;--code:#f1f3f5;--accent:#2457c5;
--ok:#1d7a3e;--ok-bg:#e6f4ea;--warn:#8a5a00;--warn-bg:#fdf3dc;--bad:#a3231f;--bad-bg:#fbe9e8;--info:#2457c5;--info-bg:#e8eefb;--grey-bg:#eef0f2}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1f25;--fg:#e6e9ed;--muted:#9aa4b0;--line:#2b323a;--code:#252c34;--accent:#7aa2ff;
--ok:#6fcf8f;--ok-bg:#163222;--warn:#e9c46a;--warn-bg:#352b12;--bad:#ff8a80;--bad-bg:#3a1a19;--info:#8fb0ff;--info-bg:#1b2742;--grey-bg:#242a31}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 "Microsoft YaHei","PingFang SC",-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1500px;margin:0 auto;padding:20px 16px 40px}
code{background:var(--code);border-radius:4px;padding:0 5px;font:12.5px ui-monospace,Consolas,monospace;word-break:break-all}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:16px}
h1{font-size:22px;margin:6px 0 2px}h2{font-size:17px;margin:0 0 10px}h3{font-size:14.5px;margin:16px 0 6px;color:var(--muted)}
.who{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.badge{background:var(--info-bg);color:var(--info);border-radius:999px;padding:3px 12px}
.ro{color:var(--muted);font-size:12.5px}.sub,.src-note,.readat{color:var(--muted);font-size:12.5px;margin:4px 0}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600;white-space:nowrap}
td.m{white-space:nowrap;font-variant-numeric:tabular-nums}td.h{font:11.5px ui-monospace,Consolas,monospace;word-break:break-all}
td.p{word-break:break-all}
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}
@media (max-width:1000px){.grid{grid-template-columns:minmax(0,1fr)}}
.pill{display:inline-block;border-radius:999px;padding:0 8px;font-size:12px;white-space:nowrap}
.done,.ok{background:var(--ok-bg);color:var(--ok)}.fixed{background:var(--info-bg);color:var(--info)}
.doing,.partial{background:var(--warn-bg);color:var(--warn)}.todo,.open,.no{background:var(--bad-bg);color:var(--bad)}
.rule,.design,.unknown{background:var(--grey-bg);color:var(--muted)}
.dist{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 8px}
.bug{border-top:1px solid var(--line);padding:8px 0}.bug:first-of-type{border-top:0}
.bug .t{font-weight:600}.bug .s,.bug .e{font-size:13px;margin-top:2px}.bug .e{color:var(--muted)}
.rc{list-style:none;padding:0;margin:0}.rc li{border-top:1px solid var(--line);padding:6px 0;font-size:13px}
.rc .f{color:var(--muted);display:block;padding-left:22px}
.bad{color:var(--bad);font-weight:600}.missing{color:var(--bad)}
.agg{display:flex;gap:18px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);margin:6px 0}
ul.usage{margin:6px 0;padding-left:20px;font-size:13px;color:var(--muted)}
footer{color:var(--muted);font-size:12px;text-align:center;margin-top:10px}
`

const srcNote = (s, readAt) => `<p class="src-note">数据来自 <code>${esc(s.rel)}</code> · 读取于 ${esc(fmtTime(readAt))}</p>`
const missing = (s) => `<p class="missing">读不到数据源 <code>${esc(s.rel)}</code>（${esc(s.error)}）。</p>`

function renderLog(s, readAt) {
  if (!s.ok) return `<section class="card"><h2>变动日志</h2>${missing(s)}</section>`
  const L = parseLog(s.text)
  const rows = L.entries.map((e) => `<tr><td class="m">${esc(e.at)}</td><td>${inline(e.who)}</td><td>${inline(e.ticket)}</td><td>${inline(e.change)}</td><td>${inline(e.evidence)}</td></tr>`).join('')
  return `<section class="card">
<h2>变动日志　共 ${L.entries.length} 条 · 时间倒序</h2>
<p class="src-note">来源 <code>${esc(s.rel)}</code>（append-only：只追加，不改不删）· 读取于 ${esc(fmtTime(readAt))} · mtime ${esc(fmtTime(s.mtime))} · ${num(s.bytes)} B</p>
${L.bad > 0 ? `<p class="bad">⚠ 有 ${L.bad} 行形状坏掉（以「- [」开头但不符合行格式），没有进下表 —— 请按行格式修正。</p>` : ''}
${L.usage.length ? `<ul class="usage">${L.usage.map((u) => `<li>${inline(u)}</li>`).join('')}</ul>` : ''}
<div class="agg"><span>按天：${L.byDay.map(([d, n]) => `${esc(d)} × ${n}`).join(' · ') || '—'}</span><span>按人：${L.byWho.map(([w, n]) => `${inline(w)} × ${n}`).join(' · ') || '—'}</span></div>
<div class="scroll"><table><thead><tr><th>时间</th><th>谁（角色/席位）</th><th>哪个单</th><th>变了什么</th><th>证据（能回到实物）</th></tr></thead><tbody>${rows || '<tr><td colspan="5">（还没有记录）</td></tr>'}</tbody></table></div>
<p class="src-note">★ 本栏是 <code>${esc(s.rel)}</code> 的只读投影：归档位（archivist）每追加一条，刷新即多一条。</p>
</section>`
}

function renderRequirements(s, readAt) {
  if (!s.ok) return { html: `<section class="card"><h2>需求进度</h2>${missing(s)}</section>`, done: [] }
  const R = parseRequirements(s.text)
  const dist = REQ_STATUS.map(([e, k, zh]) => `<span class="pill ${k}">${e} ${zh} ${R.items.filter((i) => i.status === k).length}</span>`).join('')
  const sections = [...new Set(R.items.map((i) => i.section))].map((sec) => {
    const rows = R.items.filter((i) => i.section === sec).map((i) => `<tr><td class="m">${inline(i.id)}</td><td>${inline(i.text)}</td><td><span class="pill ${i.status}">${esc(i.statusZh)}</span></td><td>${inline(i.criteria)}</td><td>${inline(i.source)}</td></tr>`).join('')
    return `<h3>${esc(sec)}</h3><div class="scroll"><table><thead><tr><th>#</th><th>一句话</th><th>状态</th><th>判据落点</th><th>报告出处</th></tr></thead><tbody>${rows}</tbody></table></div>`
  }).join('')
  return { html: `<section class="card">
<h2>需求进度　共 ${R.items.length} 条</h2>
<div class="dist">${dist}</div>
${sections}
${R.newSections.length ? `<h3>今天新增的小节</h3><ul class="usage">${R.newSections.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>` : ''}
${srcNote(s, readAt)}
</section>`, done: R.done }
}

function renderBugs(s, readAt) {
  if (!s.ok) return `<section class="card"><h2>bug 单</h2>${missing(s)}</section>`
  const B = parseBugs(s.text)
  const groups = ['P0', 'P1', 'P2'].map((g) => {
    const list = B.bugs.filter((b) => b.group === g)
    if (list.length === 0) return ''
    return `<h3>${g}（${list.length} 条）</h3>` + list.map((b) => `<div class="bug"><div class="t">${esc(b.id)}　${inline(b.title)}</div><div class="s"><span class="pill ${b.statusKind}">状态</span> ${inline(b.status)}</div>${b.evidence ? `<div class="e">证据：${inline(b.evidence)}</div>` : ''}</div>`).join('')
  }).join('')
  const rc = B.recheck.length
    ? `<h3>重启后需复验（${B.recheck.filter((r) => r.checked).length}/${B.recheck.length} 已勾）</h3><ul class="rc">${B.recheck.map((r) => `<li>${r.checked ? '☑' : '☐'} ${inline(r.title)}${r.fields.map((f) => `<span class="f">${inline(f)}</span>`).join('')}</li>`).join('')}</ul>`
    : ''
  return `<section class="card">
<h2>bug 单　共 ${B.bugs.length} 条</h2>
${groups}
${rc}
${srcNote(s, readAt)}
</section>`
}

function renderDone(done, s, readAt) {
  if (!done || done.length === 0) return ''
  const rows = done.map((d) => `<tr><td class="m">${esc(d.n)}</td><td>${inline(d.file)}</td><td class="m">${esc(d.bytes)}</td><td>${inline(d.what)}</td></tr>`).join('')
  return `<section class="card"><h2>今天做完的　${done.length} 份报告</h2>
<div class="scroll"><table><thead><tr><th>#</th><th>报告文件</th><th>字节数</th><th>做了什么</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="src-note">字节数是文档里写的静态值；要判断文档此刻有没有被改过，看顶部的 mtime / sha256。</p>
${srcNote(s, readAt)}</section>`
}

export function renderPage(role, sources, readAt) {
  const [req, bug, log] = ['req', 'bug', 'log'].map((id) => sources.find((s) => s.id === id))
  const srcRows = sources.map((s) => (s.ok
    ? `<tr><td class="p">${esc(s.path)}</td><td class="m">${esc(fmtTime(s.mtime))}</td><td class="m">${num(s.bytes)}</td><td class="h">${esc(s.sha256)}</td></tr>`
    : `<tr><td class="p">${esc(s.path)}</td><td colspan="3" class="missing">读不到（${esc(s.error)}）</td></tr>`)).join('')
  const reqPart = renderRequirements(req, readAt)
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>控制面板 · 需求与 bug</title><style>${CSS}</style></head>
<body><main>
<header class="card">
  <div class="who"><span class="badge">你以 <b>${esc(role)}</b>（${esc(ROLE_ZH[role])}）身份查看</span><span class="ro">只读 · 纯 GET · 无任何写入接口</span></div>
  <h1>控制面板 · 需求与 bug</h1>
  <p class="sub">单一页 · 零依赖 · 只监听 127.0.0.1 · 页面外链数 <b>0</b></p>
  <div class="scroll"><table><thead><tr><th>数据源文件</th><th>mtime（文件最后修改）</th><th>字节数</th><th>sha256</th></tr></thead><tbody>${srcRows}</tbody></table></div>
  <p class="readat">★ 本页是<b>每次请求现读</b>这几个文件生成的 —— 文件一改，<b>刷新即最新</b>（不需要重新部署）。本次读取时刻：<b>${esc(fmtTime(readAt))}</b></p>
</header>
${renderLog(log, readAt)}
<div class="grid">
${reqPart.html}
${renderBugs(bug, readAt)}
</div>
${renderDone(reqPart.done, req, readAt)}
<footer>只读面板 · 数据源 ${sources.map((s) => esc(s.rel)).join(' 与 ')} · 每次请求现读 · 无外链</footer>
</main></body></html>`
}

/** 403 页：固定文本，不含任何文件名、路径、条目或计数。 */
export function render403() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>403 Forbidden</title>
<style>
body{margin:0;background:#f3f5f7;color:#161a1f;font-family:"Microsoft YaHei","PingFang SC",-apple-system,"Segoe UI",Roboto,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#fff;border:1px solid #e2e6ea;border-radius:12px;padding:34px 38px;max-width:560px;text-align:center}
code{background:#f1f3f5;border-radius:4px;padding:1px 6px;font-family:ui-monospace,Consolas,monospace}
h1{font-size:44px;margin:0;color:#a3231f;letter-spacing:.04em}
p{color:#5a636f;font-size:13.5px;margin:10px 0 0}
</style></head>
<body><div class="box"><h1>403 Forbidden</h1>
<p>密钥无效或未提供。</p>
<p>本面板只对持有有效密钥的控制角色开放。</p>
<p>访问方式：<code>?k=&lt;key&gt;</code> 或请求头 <code>x-dsh-key</code>。</p>
<p>★ 未通过校验的请求<b>不会返回任何文档内容</b>。</p>
</div></body></html>
`
}

// ---------------------------------------------------------------------------
// 请求处理
// ---------------------------------------------------------------------------

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

function send(res, status, body, extra = {}) {
  const buf = Buffer.from(body, 'utf8')
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-length': String(buf.length), ...extra })
  res.end(buf)
}

/** 钥匙 → 角色：与每一把逐字全等比对（定长比较，不做前缀 / 正则 / 模糊匹配）。 */
export function roleOfKey(keys, candidate) {
  const c = Buffer.from(String(candidate ?? ''), 'utf8')
  let hit = null
  for (const r of ROLES) {
    const k = Buffer.from(keys[r], 'utf8')
    if (c.length === k.length && timingSafeEqual(c, k)) hit = r
  }
  return hit
}

/**
 * @param {{ port:number, keys:Record<string,string> }} cfg
 * @param {string} docsDir
 * @param {() => Date} [now]
 */
export function createHandler(cfg, docsDir, now = () => new Date()) {
  const okHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`])
  return function handle(req, res) {
    try {
      if (req.method !== 'GET') return send(res, 405, '<!DOCTYPE html><title>405</title><p>只读面板：只接受 GET。</p>', { allow: 'GET' })
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/') return send(res, 404, '<!DOCTYPE html><title>404</title><p>没有这个页面。</p>')
      // 鉴权在任何数据源读取之前；Host 不对（例如 DNS rebinding）同样按 403 处理
      const role = okHosts.has(String(req.headers.host ?? '').toLowerCase())
        ? roleOfKey(cfg.keys, url.searchParams.get('k') ?? req.headers['x-dsh-key'])
        : null
      if (role === null) return send(res, 403, render403())
      const readAt = now()
      send(res, 200, renderPage(role, readSources(docsDir), readAt), { 'x-dsh-role': role })
    } catch (err) {
      console.error(`处理请求出错：${err?.stack ?? err}`)
      try { send(res, 500, '<!DOCTYPE html><title>500</title><p>面板内部错误（详情见服务端控制台）。</p>') } catch { /* 头已发出 */ }
    }
  }
}

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

function docsDirFromArgs(argv, cfg) {
  const i = argv.indexOf('--docs')
  if (i >= 0 && argv[i + 1]) return resolve(argv[i + 1])
  if (process.env.DSH_DASHBOARD_DOCS) return resolve(process.env.DSH_DASHBOARD_DOCS)
  if (cfg?.docsDir) return resolve(HERE, cfg.docsDir)
  return resolve(HERE, '..', 'docs')
}

function runningPid() {
  if (!existsSync(PID_FILE)) return null
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return null
  try { process.kill(pid, 0); return pid } catch { return null }
}

function doPrint(cfg, docsDir) {
  const pid = runningPid()
  console.log(`地址：http://127.0.0.1:${cfg.port}/?k=<你的密钥>　（也认请求头 x-dsh-key）`)
  console.log(`数据源目录：${docsDir}`)
  console.log(`状态：${pid ? `在跑（pid ${pid}）` : '没在跑'}`)
  for (const r of ROLES) console.log(`  ${r.padEnd(12)} ${ROLE_ZH[r].padEnd(4)}  ${mask(cfg.keys[r])}`)
  console.log(`完整钥匙只在：${KEYS_FILE}`)
}

function startServer(cfg, docsDir) {
  const server = http.createServer(createHandler(cfg, docsDir))
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE'
      ? `端口 ${cfg.port} 被占用，面板没有启动（不会自动换口）。换口：删掉 dashboard-keys.json 里的 port 再跑 --init。`
      : `面板启动失败：${err.message}`)
    process.exit(1)
  })
  server.listen(cfg.port, '127.0.0.1', () => {
    writeFileSync(PID_FILE, String(process.pid))
    console.log(`控制面板已启动：http://127.0.0.1:${cfg.port}/?k=<你的密钥>（pid ${process.pid}）`)
    console.log(`数据源目录：${docsDir}`)
  })
  const stop = () => {
    try { if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE) } catch { /* 已删 */ }
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function main(argv) {
  if (argv.includes('--init')) return doInit()
  const cfg = readConfig()
  if (cfg === null) {
    console.error('还没有 dashboard-keys.json：先跑 node server.mjs --init（start.cmd 会自动做）。')
    process.exit(1)
  }
  const docsDir = docsDirFromArgs(argv, cfg)
  if (argv.includes('--print')) return doPrint(cfg, docsDir)
  startServer(cfg, docsDir)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err?.message ?? err)
    process.exit(1)
  })
}
