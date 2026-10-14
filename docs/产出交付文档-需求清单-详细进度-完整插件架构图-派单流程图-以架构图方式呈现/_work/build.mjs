import fs from 'node:fs'
import path from 'node:path'
import { META, S1 } from './content1.mjs'
import { S2, S2_FAILURES, S3, S4 } from './content2.mjs'
import { archDiagram } from './arch.mjs'
import { flowDiagram, hubDiagram } from './flow.mjs'

const OUT = path.resolve(import.meta.dirname, '..')
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 行内 markdown（**粗** 与 `代码`）→ HTML；先转义 */
function mi(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

const ST = {
  done: ['✅', '已实现', 'st-done'],
  partial: ['🟡', '部分实现', 'st-partial'],
  not: ['❌', '未实现', 'st-not'],
  cancelled: ['⚪', '已取消', 'st-cancelled'],
  unverified: ['❓', '未核实', 'st-unverified'],
}

// 合并：S1 来自 content1；S2/S3/S4 用 content2 的完整版
const _S2 = S2
const _F = S2_FAILURES
const _S3 = S3
const _S4 = S4

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
function html() {
  const H = []
  const w = (s = '') => H.push(s)

  w(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(META.title)}</title>
<style>
:root{--fg:#1a1a1a;--mut:#5b5b5b;--line:#d8d8d8;--bg:#fff;--acc:#23445d;--red:#b85450;--org:#d79b00;--grn:#3d7a2f}
*{box-sizing:border-box}
body{margin:0;background:#f4f5f7;color:var(--fg);font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 22px 90px;background:var(--bg);box-shadow:0 0 0 1px var(--line)}
header.top{border-bottom:3px solid var(--acc);padding-bottom:16px;margin-bottom:8px}
h1{font-size:27px;margin:0 0 6px;line-height:1.35}
h2{font-size:22px;margin:44px 0 12px;padding:9px 14px;background:var(--acc);color:#fff;border-radius:6px;scroll-margin-top:14px}
h3{font-size:17.5px;margin:30px 0 10px;padding-left:10px;border-left:5px solid var(--acc)}
h4{font-size:15.5px;margin:20px 0 8px;color:#333}
p{margin:9px 0}
code{background:#eef1f4;padding:1.5px 5px;border-radius:4px;font:13px/1.5 Consolas,Menlo,monospace;word-break:break-word}
pre{background:#f6f8fa;border:1px solid var(--line);border-radius:6px;padding:12px 14px;overflow:auto}
pre code{background:none;padding:0}
blockquote{margin:9px 0;padding:8px 14px;border-left:4px solid #b9c4cc;background:#f8fafb;color:#333;border-radius:0 6px 6px 0}
ul,ol{margin:8px 0 8px 22px;padding:0}
li{margin:4px 0}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13.4px}
th,td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{background:#eef2f6;font-weight:700}
tr:nth-child(even) td{background:#fafbfc}
.st{display:inline-block;padding:1px 8px;border-radius:11px;font-size:12px;font-weight:700;white-space:nowrap}
.st-done{background:#dff0d8;color:#2c5f22;border:1px solid #a8d08d}
.st-partial{background:#fff2cc;color:#7a5b00;border:1px solid #d6b656}
.st-not{background:#f8cecc;color:#7a2b28;border:1px solid #b85450}
.st-cancelled{background:#eee;color:#555;border:1px solid #bbb}
.st-unverified{background:#e6e6fa;color:#4b3f8f;border:1px solid #9b8fd0}
.meta{background:#f8fafb;border:1px solid var(--line);border-radius:8px;padding:14px 18px;margin:14px 0 6px;font-size:13.6px}
.meta li{margin:5px 0}
.card{border:1px solid var(--line);border-radius:8px;margin:18px 0;overflow:hidden}
.card>.hd{background:#eef2f6;padding:10px 14px;font-weight:700;font-size:15.5px;border-bottom:1px solid var(--line)}
.card>.bd{padding:12px 16px}
.sub{border-left:4px solid #c9d4dc;padding:2px 0 2px 12px;margin:14px 0}
.sub>.stt{font-weight:700;margin-bottom:4px}
.src{font-size:13px;color:var(--mut);margin:2px 0 8px}
.q{background:#fbfbf6;border:1px solid #e8e4d0;border-radius:6px;padding:10px 14px;margin:8px 0;font-size:13.4px}
.q div{margin:3px 0}
.ev{font-size:13.4px}
.ev li{margin:5px 0}
.fig{margin:22px 0;border:1px solid var(--line);border-radius:8px;padding:10px;background:#fff;overflow:auto}
.figcap{font-size:13px;color:var(--mut);margin-top:8px;text-align:center}
.toc{background:#f8fafb;border:1px solid var(--line);border-radius:8px;padding:14px 18px;font-size:14px}
.toc a{color:var(--acc);text-decoration:none;margin-right:16px;white-space:nowrap}
.toc a:hover{text-decoration:underline}
.warn{background:#fff7f6;border:1px solid #f0c8c4;border-left:5px solid var(--red);border-radius:0 8px 8px 0;padding:12px 16px;margin:14px 0}
.ok{background:#f6fbf4;border:1px solid #cfe4c4;border-left:5px solid var(--grn);border-radius:0 8px 8px 0;padding:12px 16px;margin:14px 0}
hr{border:none;border-top:1px solid var(--line);margin:34px 0}
footer{margin-top:50px;padding-top:16px;border-top:1px solid var(--line);font-size:12.6px;color:var(--mut)}
@media print{
  body{background:#fff}
  .wrap{box-shadow:none;max-width:none;padding:0}
  h2{background:#23445d!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;page-break-after:avoid}
  .card,.sub,.fig,table{page-break-inside:avoid}
  .toc{page-break-after:always}
  a{color:inherit;text-decoration:none}
}
</style>
</head>
<body><div class="wrap">
<header class="top">
<h1>${esc(META.title)}</h1>
<div class="src">${mi(META.subtitle)}　·　生成于 ${esc(META.generatedAt)}</div>
</header>
<div class="meta"><strong>本档的口径与边界</strong><ul>
${META.scope.map((s) => `<li>${mi(s)}</li>`).join('\n')}
</ul></div>
<div class="toc">
<strong>目录</strong>　
<a href="#s1">① 需求清单</a><a href="#s2">② 详细进度</a><a href="#s2f">②-3 今晚的故障</a><a href="#s3">③ 插件架构图</a><a href="#s4">④ 派单流程图</a><a href="#s5">⑤ 证据出处与未核实项</a>
</div>`)

  // ---- ① ----
  w(`<h2 id="s1">① 需求清单</h2>`)
  S1.intro.forEach((p) => w(`<p>${mi(p)}</p>`))
  for (const it of S1.items) {
    w(`<div class="card"><div class="hd">${esc(it.rid)}　${esc(it.title)}</div><div class="bd">`)
    w(`<div class="src"><strong>来源：</strong>${mi(it.source)}</div>`)
    if (it.quote?.length) {
      w(`<div class="q"><strong>原文（照抄）</strong>${it.quote.map((q) => `<div>${mi(q)}</div>`).join('')}</div>`)
    }
    for (const s of it.sub) {
      const [icon, label, cls] = ST[s.st]
      w(`<div class="sub"><div class="stt"><span class="st ${cls}">${icon} ${label}</span>　${mi(s.t)}</div>`)
      if (s.note) w(`<p>${mi(s.note)}</p>`)
      if (s.ev?.length) w(`<ul class="ev">${s.ev.map((e) => `<li>${mi(e)}</li>`).join('')}</ul>`)
      w(`</div>`)
    }
    w(`</div></div>`)
  }

  // ---- ② ----
  w(`<h2 id="s2">② 详细进度</h2>`)
  _S2.intro.forEach((p) => w(`<p>${mi(p)}</p>`))
  w(`<h3>2.1 逐单总览</h3>`)
  w(`<table><thead><tr>${_S2.overview.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>`)
  for (const r of _S2.overview.rows) w(`<tr>${r.map((c) => `<td>${mi(c)}</td>`).join('')}</tr>`)
  w(`</tbody></table><p>${mi(_S2.overview.foot)}</p>`)

  w(`<h3>2.2 逐单关键时间线（只挑有意义的，不贴流水账）</h3>`)
  for (const t of _S2.timelines) {
    w(`<h4>${esc(t.tid)}</h4><p class="src">${mi(t.note)}</p>`)
    w(`<table><thead><tr><th style="width:170px">时间（UTC）</th><th style="width:300px">动作</th><th>说明</th></tr></thead><tbody>`)
    for (const r of t.rows) w(`<tr><td><code>${esc(r[0])}</code></td><td>${mi(r[1])}</td><td>${mi(r[2])}</td></tr>`)
    w(`</tbody></table>`)
  }

  // ---- ②-3 ----
  w(`<h2 id="s2f">②-3　今晚（2026-10-12 夜）发生的全部故障</h2>`)
  _F.intro.forEach((p) => w(`<p>${mi(p)}</p>`))

  const D = _F.defects
  w(`<h3>${esc(D.title)}</h3><p>${mi(D.intro)}</p>`)
  w(`<table><thead><tr>${D.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>`)
  for (const r of D.rows) w(`<tr>${r.map((c, i) => `<td>${i === 2 && /未修|部分/.test(c) ? `<span class="st ${/未修/.test(c) ? 'st-not' : 'st-partial'}">${esc(c)}</span>` : mi(c)}</td>`).join('')}</tr>`)
  w(`</tbody></table>`)
  w(`<div class="warn"><strong>自述里的遗留（原样引用）</strong><ul>${D.quotes.map((q) => `<li>${mi(q)}</li>`).join('')}</ul></div>`)
  w(`<h4>三个关键数字逐个查证</h4><table><thead><tr><th style="width:220px">数字</th><th>查证结论</th></tr></thead><tbody>`)
  for (const [k, v] of D.numbers) w(`<tr><td><code>${esc(k)}</code></td><td>${mi(v)}</td></tr>`)
  w(`</tbody></table>`)
  w(`<h4>我实测到、且与自述冲突的事实</h4><div class="warn"><ul>${D.extra.map((q) => `<li>${mi(q)}</li>`).join('')}</ul></div>`)
  w(`<p class="src">${mi(D.allSuites)}</p>`)

  const B = _F.b2
  w(`<h3>${esc(B.title)}</h3><p class="src">${mi(B.report)}</p>`)
  w(`<table><thead><tr><th style="width:70px">环节</th><th style="width:240px">环节</th><th style="width:180px">报告结论</th><th>证据（原文 / 行号）</th></tr></thead><tbody>`)
  for (const r of B.chain) w(`<tr><td><strong>${esc(r[0])}</strong></td><td>${mi(r[1])}</td><td>${mi(r[2])}</td><td class="ev">${r.slice(3).map((x) => `<div>${mi(x)}</div>`).join('')}</td></tr>`)
  w(`</tbody></table>`)
  w(`<h4>报告给出的其他证据</h4><ul class="ev">${B.evidence.map((q) => `<li>${mi(q)}</li>`).join('')}</ul>`)
  w(`<div class="warn"><strong>报告自己标的「未核实」</strong><ul>${B.honest.map((q) => `<li>${mi(q)}</li>`).join('')}</ul></div>`)
  w(`<div class="warn"><strong>修复状态（关键：报告写「本轮不实施」，而根因我现在仍能在盘上读到）</strong><ul>${B.fixStatus.map((q) => `<li>${mi(q)}</li>`).join('')}</ul></div>`)

  const WK = _F.wake
  w(`<h3>${esc(WK.title)}</h3><p>${mi(WK.intro)}</p>`)
  w(`<table><thead><tr><th style="width:110px">吞法</th><th style="width:160px">名字</th><th style="width:200px">后果</th><th>现场原文 / 证据</th><th style="width:150px">是否已修</th></tr></thead><tbody>`)
  for (const r of WK.rows) w(`<tr><td><strong>${esc(r[0])}</strong><br>${esc(r[1])}</td><td>${mi(r[2])}</td><td class="ev">${mi(r[3])}</td><td class="ev">${r.slice(4).map((x) => `<div>${mi(x)}</div>`).join('')}</td></tr>`)
  w(`</tbody></table>`)
  w(`<h4>席位侧（唤醒送不到席位）</h4><ul class="ev">${WK.seatSide.map((q) => `<li>${mi(q)}</li>`).join('')}</ul>`)

  const CR = _F.crash
  w(`<h3>${esc(CR.title)}</h3>`)
  w(`<table><thead><tr><th style="width:120px">维度</th><th>内容</th></tr></thead><tbody>`)
  for (const [k, v] of CR.rows) w(`<tr><td><strong>${esc(k)}</strong></td><td class="ev">${mi(v)}</td></tr>`)
  w(`</tbody></table>`)

  const MF = _F.misfreeze
  w(`<h3>${esc(MF.title)}</h3><p>${mi(MF.intro)}</p>`)
  w(`<table><thead><tr>${MF.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>`)
  for (const r of MF.rows) w(`<tr>${r.map((c) => `<td>${mi(c)}</td>`).join('')}</tr>`)
  w(`</tbody></table><p class="src">${mi(MF.foot)}</p>`)

  const AK = _F.askcard
  w(`<h3>${esc(AK.title)}</h3>`)
  w(`<table><thead><tr><th style="width:200px">轮次</th><th style="width:150px">结论</th><th>根因与修法 / 证据</th></tr></thead><tbody>`)
  for (const r of AK.rows) w(`<tr><td><strong>${esc(r[0])}</strong></td><td>${mi(r[1])}</td><td class="ev">${mi(r[2])}</td></tr>`)
  w(`</tbody></table>`)
  w(`<div class="warn"><strong>仍未解决的那一层</strong><ul>${AK.unresolved.map((q) => `<li>${mi(q)}</li>`).join('')}</ul></div>`)
  w(`<div class="warn"><strong>关于那条现场串的诚实说明</strong><ul>${AK.stringHonesty.map((q) => `<li>${mi(q)}</li>`).join('')}</ul></div>`)

  const OT = _F.other
  w(`<h3>${esc(OT.title)}</h3>`)
  w(`<table><thead><tr><th style="width:230px">项</th><th style="width:130px">状态</th><th>说明</th></tr></thead><tbody>`)
  for (const r of OT.rows) w(`<tr><td><strong>${esc(r[0])}</strong></td><td><span class="st ${/未修|未实现|未通过|仍在|孤立|0 站|零制品|不是通过|未复现|已过期|转述|半修|表里不存在|2 条/.test(r[1]) ? 'st-not' : 'st-partial'}">${esc(r[1])}</span></td><td class="ev">${mi(r[2])}</td></tr>`)
  w(`</tbody></table>`)

  // ---- ③ ----
  w(`<h2 id="s3">③ 完整插件架构图</h2>`)
  _S3.intro.forEach((p) => w(`<p>${mi(p)}</p>`))
  w(`<div class="fig">${archDiagram()}<div class="figcap">图③-A · dsh-pipeline 插件完整架构图（内嵌 SVG，无外部依赖，可缩放/打印）</div></div>`)

  // ---- ④ ----
  w(`<h2 id="s4">④ 派单任务的流程图</h2>`)
  _S4.intro.forEach((p) => w(`<p>${mi(p)}</p>`))
  w(`<div class="fig">${flowDiagram()}<div class="figcap">图④-A · 派单任务端到端流程图（含打回环 / 打回预算 / 两级澄清梯 / 唤醒投递路径与今晚断点）</div></div>`)
  w(`<div class="fig">${hubDiagram()}<div class="figcap">图④-B · 「主管枢纽」目标拓扑：应然（用户设计）vs 实然（实读代码与账本）</div></div>`)

  // ---- ⑤ 证据出处 ----
  w(`<h2 id="s5">⑤ 证据出处与未核实项</h2>`)
  w(`<h3>5.1 我实读过的文件（逐条列出）</h3>
<table><thead><tr><th style="width:340px">路径</th><th>读到了什么</th></tr></thead><tbody>
<tr><td><code>.pipeline\\T-*\\task.json</code> × 11</td><td>state / previous_state / roster / requirement 原文 / constraints / acceptance / artifact_version_counter / rework / handoffs[] / artifacts[] / dispatched[] / clarification_requests[] / human_requests[] / records[] / liveness.escalations / hash_gate / contacts / amendments / roster_requests / context_reports / writer_submissions / close_report / history 动作计数</td></tr>
<tr><td><code>.pipeline\\T-*\\audit.jsonl</code> × 11</td><td>transition:* / handoff:* / wake:* / gate:* / clarify:* / human:* / artifact:register / seat:submit / roster:* / baseline:take / scope:amend / context:report / record:compile —— 共 592 行有意义的条目（全量另存）</td></tr>
<tr><td><code>node_modules\\dsh-pipeline\\lib\\states.js</code></td><td>ST 18 状态 / WAITING_STATES / ROLES_CAN_ASK_CLARIFICATION / ROLES_CAN_RAISE_HUMAN / STATE_LABEL / TERMINAL_STATES / TRANSITIONS（24 条）/ STATE_OWNER / findTransition / explainRefusal / applyTransition / resolveUnblockRecovery</td></tr>
<tr><td><code>lib\\roles.js</code> · <code>lib\\tiers.js</code> · <code>lib\\boundaries.js</code></td><td>ROLES 表（含 ROLE.SUPERVISOR:160–193）/ RULE_CLASS / RULES R1–R8 / ADVISORY_LIMITS C1–C4 / ROSTER_SLOT_KEYS / 权限三档 / dispatchOpenRecord / boundaryManifest</td></tr>
<tr><td><code>lib\\liveness.js</code> · <code>lib\\store.js</code></td><td>B2 判据常量与 <code>seatLiveness()</code> 全文（385–471）/ <code>sampleSessionActivity()</code> 全文（360–419）/ gateOn 与 quiet_streak 的原样代码</td></tr>
<tr><td><code>lib\\wakeup.js</code></td><td>discriminatorOf / ledgerIdentityOf / transitionDiscOf / deliverWake（两条投递路与其代价）/ createWaker 依赖装配</td></tr>
<tr><td><code>index.js</code> · <code>cordis.patch.yml</code> · <code>package.json</code></td><td>apply() 装配顺序 / 同步任务索引 / 交付即唤醒登记 / 挂载声明 / dsh.bundle.patch 与 dsh.client 声明</td></tr>
<tr><td><code>tests\\*-last-run.txt</code> × 29</td><td>逐份末行通过数（见 5.3）</td></tr>
<tr><td><code>dsh_orb\\只读诊断-…\\诊断报告-B2会话活动判据为什么没拦住.md</code></td><td>B2 三段因果链、8 个实测场景、修法 P0–P2、以及报告自标的 3 处未核实</td></tr>
<tr><td><code>dsh_orb\\插件缺陷修复规格-20261012.md</code> · <code>…14-条缺陷…\\changes.md</code></td><td>B1–B14 规格与逐条修复自述、遗留项原文</td></tr>
<tr><td><code>dsh_orb\\DSH-多AI流水线-交接档.md</code>（§18 L463–546 / §19 L548–755）</td><td>11 项已修地基 / 6 项待修 / §19.4 当晚未修 6 项 / 询问卡三轮 / 「转述」声明</td></tr>
<tr><td><code>dsh_orb\\修-dsh-web-gui-的-询问卡正文-渲染-…\\报告-第二层-询问卡正文渲染.md</code> · <code>…修-dsh-询问卡的选项按钮-…\\报告-选项按钮点击无反应.md</code></td><td>两轮询问卡的根因、落点、夹具结果与自陈未自证项</td></tr>
<tr><td><code>dsh_orb\\_asar-work\\plugin-waterfall.test.cjs</code> · <code>plugin-rejection.test.cjs</code> · <code>audit.cjs</code></td><td>第 4 轮询问卡的行为夹具与断言（四个探针分量的唯一可核出处）</td></tr>
</tbody></table>`)

  w(`<h3>5.2 我**没能拿到证据**的条目（如实列出）</h3>
<div class="warn"><ul>
<li><strong>那条现场串的逐字原文</strong>：<code>waterfall=no-live-request; card=absent; remote={"ok":true,"value":false}; reveal=false</code> —— 全库检索不到整串；解压全部 65 份会话日志（约 55.5 MB）零命中。只有它的四个分量与一个格式不同的模板。</li>
<li><strong>第一轮 / 第二轮询问卡「已生效」的独立核对</strong>：交接档自己标为「转述」（用户重启后现场确认），我无法独立核对。</li>
<li><strong>70/70、38/38、70/72、0 泄漏 四组数字的独立复跑</strong>：交接档 :690 明写「上表四行为转述（修复者当晚自报，本次未复跑）」。</li>
<li><strong>「离线复算」的真实性</strong>：夹具里写死了 381,679 / 392,396 两个数重放，不是重读那台会话文件 ⇒ 不能算独立复测。</li>
<li><strong>B2 的 root===null 是不是真的</strong>：报告 L446 自陈「我没有直证插件进程的 process.env.DSH_HOME 为空…属高置信推断」。我也没有进程内直测手段。</li>
<li><strong>「审批不流转到主对话」的可核证据</strong>：交接档 :510 原文「<code>approval:allowed-once</code>…一处都没有…没有可核证据」。</li>
<li><strong>分组名 B7 在真单上是否生效</strong>：账本里没有任何 <code>via:"session"</code> 的派活记录 ⇒ 无法验证。</li>
<li><strong>误冻的准确总次数</strong>：我按 liveness.escalations 条目数得到 17 次；交接档按「自动阻塞事件数」写「6 次中至少 4 次误报」。两组口径不同，哪个为准我未核实。</li>
<li><strong>R-01 的 1d「角色专属模式」</strong>：没找到可按角色登记模式的表；<code>modes.js</code> / <code>permissions.js</code> 都不存在（当时的 change_scope 允许并入既有模块，所以我没把它判成未实现，只判未核实）。</li>
<li><strong>R-06 的「事后自纠」正反例原始输出</strong>：两张孤儿单上都没有制品，我没有拿到任何正反例输出。</li>
<li><strong>B6 的原始现象</strong>：changes.md 自陈「我没复现」。</li>
<li><strong>运行中进程与磁盘的差异</strong>：B2 报告给出 liveness.js 现盘 30,416 B vs 运行版 29,724 B、store.js 现盘 325,426 B vs 运行版 324,171 B ⇒ 我读的是**磁盘上的生效副本**，但**不能断言运行中的进程已加载这一版**。</li>
</ul></div>`)

  w(`<h3>5.3 29 套自测的逐份结果（实读各 *-last-run.txt 末行）</h3>
<table><thead><tr><th style="width:300px">套件</th><th style="width:110px">结果</th><th>备注</th></tr></thead><tbody>
${[
      ['selftest', '70/70', 'tests/selftest-last-run.txt:626'],
      ['t14-fix-check', '38/38', 'tests/t14-fix-check-last-run.txt:98 —— 14 条缺陷的专属夹具（7+7+8+2+3+6+3+2 = 38，自洽）'],
      ['switch-check', '38/38', '内含一次内联 selftest 70/70'],
      ['roster-authority', '<span class="st st-not">70/72</span>', '**唯一非全绿**：:83、:85 两条 ✗；changes.md 自陈那 2 条断言自相矛盾且未改'],
      ['load-smoke', '24/24', '含降级甲/乙的如实说明'],
      ['client', '23/23', ''], ['human', '44/44', ''], ['human-registry', '46/46', ''],
      ['writers', '39/39', '四步全过：派测试 → 测试通过 → 派审核 → 审核 OK'],
      ['ladder', '39/39', '澄清梯单向门'],
      ['security', '36/36', ''], ['plan', '56/56', '含「E 引导步死锁」12/12'],
      ['records', '29/29', ''], ['relay', '56/56', ''], ['review', '51/51', ''],
      ['boundary', '43/43', ''], ['scope', '41/41', '★ 正例：20 条授权全部命中（病根「条条落空」已消除）'],
      ['amend', '51/51', ''], ['intercept', '25/25', ''], ['fulltest', '44/44', ''],
      ['hashgate', '68/68', ''], ['liveness', '44/44', ''], ['channel', '57/57', ''],
      ['wake', '55/55', 'stats={attempts:3, injected:1, deduped:1, skipped:0, failed:1, fallback:0}'],
      ['wake-fidelity', '18/18', 'D3 只读查询不唤醒 + 明确失败（ok:false）不唤醒'],
      ['output-check', '<span class="st st-cancelled">未测</span>', 'last-run 原文「所以**没有测**（这不是通过）」'],
      ['schema-check', '<span class="st st-cancelled">未测</span>', '同上'],
      ['switch-route-check', '<span class="st st-cancelled">未测</span>', '同上'],
      ['last-run.txt', '聚合报告', '另有 gate-states-check / dispatch-channel-check 尚未落地（:8793/:8797），不计入通过率'],
    ].map((r) => `<tr><td><code>${r[0]}</code></td><td>${r[1]}</td><td>${mi(r[2])}</td></tr>`).join('\n')}
</tbody></table>`)

  w(`<footer>
本档由主对话席位在一次只读会话中产出：<strong>未改动 dsh-pipeline 插件的任何文件，未改动 .pipeline\\ 下的任何账本</strong>。<br>
所有事实来自 5.1 列出的实读文件；凡我做的归纳均标「（归纳）」，凡原话均标「（照抄）」，凡不确定均写「未核实」。<br>
HTML 与 Markdown 两份内容由同一份数据生成，逐节一致。
</footer></div></body></html>`)

  return H.join('\n')
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------
function md() {
  const M = []
  const w = (s = '') => M.push(s)
  const B = (s) => `**${s}**`

  w(`# ${META.title}`)
  w()
  w(`> ${META.subtitle}`)
  w(`> 生成于 ${META.generatedAt}`)
  w()
  w(`## 本档的口径与边界`)
  w()
  META.scope.forEach((s) => w(`- ${s}`))
  w()
  w(`**目录**：① [需求清单](#①-需求清单)　② [详细进度](#②-详细进度)　②-3 [今晚的故障](#②-3今晚2026-10-12-夜发生的全部故障)　③ [插件架构图](#③-完整插件架构图)　④ [派单流程图](#④-派单任务的流程图)　⑤ [证据出处与未核实项](#⑤-证据出处与未核实项)`)
  w()
  w('---')
  w()

  // ①
  w(`## ① 需求清单`)
  w()
  S1.intro.forEach((p) => { w(p); w() })
  for (const it of S1.items) {
    w(`### ${it.rid}　${it.title}`)
    w()
    w(`**来源**：${it.source}`)
    w()
    if (it.quote?.length) {
      w(`**原文（照抄）**`)
      w()
      it.quote.forEach((q) => w(`> ${q}`))
      w()
    }
    for (const s of it.sub) {
      const [icon, label] = ST[s.st]
      w(`#### ${icon} ${label}　${s.t}`)
      w()
      if (s.note) { w(s.note); w() }
      if (s.ev?.length) { s.ev.forEach((e) => w(`- ${e}`)); w() }
    }
    w('---')
    w()
  }

  // ②
  w(`## ② 详细进度`)
  w()
  _S2.intro.forEach((p) => { w(p); w() })
  w(`### 2.1 逐单总览`)
  w()
  w(`| ${_S2.overview.head.join(' | ')} |`)
  w(`|${_S2.overview.head.map(() => '---').join('|')}|`)
  _S2.overview.rows.forEach((r) => w(`| ${r.join(' | ')} |`))
  w()
  w(_S2.overview.foot)
  w()
  w(`### 2.2 逐单关键时间线`)
  w()
  for (const t of _S2.timelines) {
    w(`#### ${t.tid}`)
    w()
    w(t.note)
    w()
    w(`| 时间（UTC） | 动作 | 说明 |`)
    w(`|---|---|---|`)
    t.rows.forEach((r) => w(`| \`${r[0]}\` | ${r[1]} | ${r[2]} |`))
    w()
  }

  // ②-3
  w(`## ②-3　今晚（2026-10-12 夜）发生的全部故障`)
  w()
  _F.intro.forEach((p) => { w(p); w() })

  const D = _F.defects
  w(`### ${D.title}`)
  w()
  w(D.intro)
  w()
  w(`| ${D.head.join(' | ')} |`)
  w(`|${D.head.map(() => '---').join('|')}|`)
  D.rows.forEach((r) => w(`| ${r.join(' | ')} |`))
  w()
  w(`**自述里的遗留（原样引用）**`)
  w()
  D.quotes.forEach((q) => w(`- ${q}`))
  w()
  w(`**三个关键数字逐个查证**`)
  w()
  D.numbers.forEach(([k, v]) => w(`- \`${k}\` —— ${v}`))
  w()
  w(`**我实测到、且与自述冲突的事实**`)
  w()
  D.extra.forEach((q) => w(`- ${q}`))
  w()
  w(D.allSuites)
  w()

  const Bx = _F.b2
  w(`### ${Bx.title}`)
  w()
  w(`报告：\`${Bx.report}\``)
  w()
  Bx.chain.forEach((r) => {
    w(`#### ${r[0]}　${r[1]}`)
    w()
    w(`**报告结论**：${r[2]}`)
    w()
    r.slice(3).forEach((x) => { w(`- ${x}`); })
    w()
  })
  w(`**报告给出的其他证据**`)
  w()
  Bx.evidence.forEach((q) => w(`- ${q}`))
  w()
  w(`**报告自己标的「未核实」**`)
  w()
  Bx.honest.forEach((q) => w(`- ${q}`))
  w()
  w(`**修复状态（关键）**`)
  w()
  Bx.fixStatus.forEach((q) => w(`- ${q}`))
  w()

  const WK = _F.wake
  w(`### ${WK.title}`)
  w()
  w(WK.intro)
  w()
  WK.rows.forEach((r) => {
    w(`#### ${r[0]}　${r[1]} —— ${r[2]}`)
    w()
    r.slice(3).forEach((x) => w(`- ${x}`))
    w()
  })
  w(`**席位侧（唤醒送不到席位）**`)
  w()
  WK.seatSide.forEach((q) => w(`- ${q}`))
  w()

  const CR = _F.crash
  w(`### ${CR.title}`)
  w()
  CR.rows.forEach(([k, v]) => w(`- **${k}**：${v}`))
  w()

  const MF = _F.misfreeze
  w(`### ${MF.title}`)
  w()
  w(MF.intro)
  w()
  w(`| ${MF.head.join(' | ')} |`)
  w(`|${MF.head.map(() => '---').join('|')}|`)
  MF.rows.forEach((r) => w(`| ${r.join(' | ')} |`))
  w()
  w(MF.foot)
  w()

  const AK = _F.askcard
  w(`### ${AK.title}`)
  w()
  AK.rows.forEach((r) => w(`- **${r[0]}**（${r[1]}）：${r[2]}`))
  w()
  w(`**仍未解决的那一层**`)
  w()
  AK.unresolved.forEach((q) => w(`- ${q}`))
  w()
  w(`**关于那条现场串的诚实说明**`)
  w()
  AK.stringHonesty.forEach((q) => w(`- ${q}`))
  w()

  const OT = _F.other
  w(`### ${OT.title}`)
  w()
  w(`| 项 | 状态 | 说明 |`)
  w(`|---|---|---|`)
  OT.rows.forEach((r) => w(`| ${r[0]} | ${r[1]} | ${r[2]} |`))
  w()
  w('---')
  w()

  // ③
  w(`## ③ 完整插件架构图`)
  w()
  _S3.intro.forEach((p) => { w(p); w() })
  w(`> 下面这张图是**内嵌 SVG**（手绘，无外部依赖）。在不支持内联 HTML 的渲染器里它不会显示，此时请看紧随其后的 ASCII 降级。`)
  w()
  w(archDiagram())
  w()
  w(`*图③-A · dsh-pipeline 插件完整架构图*`)
  w()
  w(`### ASCII 降级 · 架构图骨架`)
  w()
  w('```text')
  w(ASCII_ARCH)
  w('```')
  w()
  w('---')
  w()

  // ④
  w(`## ④ 派单任务的流程图`)
  w()
  _S4.intro.forEach((p) => { w(p); w() })
  w()
  w(flowDiagram())
  w()
  w(`*图④-A · 派单任务端到端流程图*`)
  w()
  w(`### ASCII 降级 · 端到端主链与事件`)
  w()
  w('```text')
  w(ASCII_FLOW)
  w('```')
  w()
  w(hubDiagram())
  w()
  w(`*图④-B · 「主管枢纽」目标拓扑：应然 vs 实然*`)
  w()
  w(`### ASCII 降级 · 应然 vs 实然`)
  w()
  w('```text')
  w(ASCII_HUB)
  w('```')
  w()
  w('---')
  w()

  // ⑤
  w(`## ⑤ 证据出处与未核实项`)
  w()
  w(`### 5.1 我实读过的文件`)
  w()
  w(`| 路径 | 读到了什么 |`)
  w(`|---|---|`)
  w(`| \`.pipeline\\T-*\\task.json\` × 11 | state / previous_state / roster / requirement 原文 / constraints / acceptance / artifact_version_counter / rework / handoffs[] / artifacts[] / dispatched[] / clarification_requests[] / human_requests[] / records[] / liveness.escalations / hash_gate / contacts / amendments / roster_requests / context_reports / writer_submissions / close_report / history 动作计数 |`)
  w(`| \`.pipeline\\T-*\\audit.jsonl\` × 11 | transition:* / handoff:* / wake:* / gate:* / clarify:* / human:* / artifact:register / seat:submit / roster:* / baseline:take / scope:amend / context:report / record:compile |`)
  w(`| \`node_modules\\dsh-pipeline\\lib\\states.js\` | ST 18 状态 / TRANSITIONS 24 条 / ROLES_CAN_ASK_CLARIFICATION / ROLES_CAN_RAISE_HUMAN / STATE_OWNER / applyTransition / resolveUnblockRecovery |`)
  w(`| \`lib\\roles.js\` · \`lib\\tiers.js\` · \`lib\\boundaries.js\` | ROLES 表（含 ROLE.SUPERVISOR:160–193）/ RULES R1–R8 / ADVISORY_LIMITS / ROSTER_SLOT_KEYS / 权限三档 / dispatchOpenRecord |`)
  w(`| \`lib\\liveness.js\` · \`lib\\store.js\` | B2 判据常量与 seatLiveness() 全文（385–471）/ sampleSessionActivity() 全文（360–419）|`)
  w(`| \`lib\\wakeup.js\` | discriminatorOf / ledgerIdentityOf / deliverWake / createWaker |`)
  w(`| \`index.js\` · \`cordis.patch.yml\` · \`package.json\` | apply() 装配 / 挂载声明 / dsh.bundle.patch |`)
  w(`| \`tests\\*-last-run.txt\` × 29 | 逐份末行通过数 |`)
  w(`| \`dsh_orb\\只读诊断-…\\诊断报告-B2会话活动判据为什么没拦住.md\` | B2 三段因果链 / 8 场景 / 修法 P0–P2 / 3 处自标未核实 |`)
  w(`| \`dsh_orb\\插件缺陷修复规格-20261012.md\` · \`…14-条缺陷…\\changes.md\` | B1–B14 规格与逐条自述 + 遗留原文 |`)
  w(`| \`dsh_orb\\DSH-多AI流水线-交接档.md\` §18/§19 | 11 项已修 / 6 项待修 / §19.4 未修 6 项 / 询问卡三轮 / 「转述」声明 |`)
  w(`| 两份询问卡报告 + \`_asar-work\\plugin-waterfall.test.cjs\` | 三轮根因、夹具结果、四探针分量 |`)
  w()
  w(`### 5.2 我**没能拿到证据**的条目`)
  w()
  const noEv = [
    '那条现场串的逐字原文 `waterfall=no-live-request; card=absent; remote={"ok":true,"value":false}; reveal=false` —— 全库检索不到整串；解压全部 65 份会话日志（约 55.5 MB）零命中。只有四个分量与一个格式不同的模板。',
    '第一轮 / 第二轮询问卡「已生效」的独立核对 —— 交接档自己标为「转述」。',
    '`70/70`、`38/38`、`70/72`、`0 泄漏` 四组数字的独立复跑 —— 交接档 :690 明写「上表四行为转述（修复者当晚自报，本次未复跑）」。',
    '「离线复算」的真实性 —— 夹具里写死了 381,679 / 392,396 两个数重放，不是重读那台会话文件。',
    'B2 的 `root===null` 是不是真的 —— 报告 L446 自陈「我没有直证插件进程的 process.env.DSH_HOME 为空…属高置信推断」。',
    '「审批不流转到主对话」的可核证据 —— 交接档 :510 原话「一处都没有…没有可核证据」。',
    '分组名 B7 在真单上是否生效 —— 账本里没有任何 `via:"session"` 的派活记录。',
    '误冻的准确总次数 —— 我数 17（liveness.escalations 条目），交接档写「6 次中至少 4 次误报」，口径不同，未核实哪个为准。',
    'R-01 的 1d「角色专属模式」—— 没找到按角色登记模式的表。',
    'R-06 的「事后自纠」正反例原始输出 —— 两张孤儿单上都没有制品。',
    'B6 的原始现象 —— changes.md 自陈「我没复现」。',
    '运行中进程与磁盘的差异 —— 报告给出 liveness.js 现盘 30,416 B vs 运行版 29,724 B、store.js 现盘 325,426 B vs 运行版 324,171 B；我读的是磁盘上的生效副本，**不能断言运行中的进程已加载这一版**。',
  ]
  noEv.forEach((q) => w(`- ${q}`))
  w()
  w(`### 5.3 29 套自测逐份结果`)
  w()
  w(`| 套件 | 结果 | 备注 |`)
  w(`|---|---|---|`)
  const suites = [
    ['selftest', '70/70', 'tests/selftest-last-run.txt:626'],
    ['t14-fix-check', '38/38', '14 条缺陷专属夹具（7+7+8+2+3+6+3+2=38，自洽）'],
    ['switch-check', '38/38', '内含一次内联 selftest 70/70'],
    ['roster-authority', '**70/72**', '唯一非全绿；:83、:85 两条 ✗；自陈那 2 条断言自相矛盾且未改'],
    ['load-smoke', '24/24', '含降级甲/乙的如实说明'], ['client', '23/23', ''], ['human', '44/44', ''],
    ['human-registry', '46/46', ''], ['writers', '39/39', '四步全过'], ['ladder', '39/39', '澄清梯单向门'],
    ['security', '36/36', ''], ['plan', '56/56', '含「E 引导步死锁」12/12'], ['records', '29/29', ''],
    ['relay', '56/56', ''], ['review', '51/51', ''], ['boundary', '43/43', ''],
    ['scope', '41/41', '正例：20 条授权全部命中（病根「条条落空」已消除）'], ['amend', '51/51', ''],
    ['intercept', '25/25', ''], ['fulltest', '44/44', ''], ['hashgate', '68/68', ''],
    ['liveness', '44/44', ''], ['channel', '57/57', ''], ['wake', '55/55', 'stats={attempts:3, injected:1, deduped:1, skipped:0, failed:1, fallback:0}'],
    ['wake-fidelity', '18/18', 'D3 只读查询不唤醒 + ok:false 不唤醒'],
    ['output-check', '未测', '「所以没有测（这不是通过）」'], ['schema-check', '未测', '同上'], ['switch-route-check', '未测', '同上'],
    ['last-run.txt', '聚合报告', 'gate-states-check / dispatch-channel-check 尚未落地（:8793/:8797）'],
  ]
  suites.forEach((r) => w(`| \`${r[0]}\` | ${r[1]} | ${r[2]} |`))
  w()
  w('---')
  w()
  w(`本档由主对话席位在一次只读会话中产出：**未改动 dsh-pipeline 插件的任何文件，未改动 \`.pipeline\\\` 下的任何账本**。`)
  w(`所有事实来自 5.1 列出的实读文件；凡我做的归纳均标「（归纳）」，凡原话均标「（照抄）」，凡不确定均写「未核实」。`)

  return M.join('\n')
}

// ---------------------------------------------------------------------------
// ASCII 降级图
// ---------------------------------------------------------------------------
const ASCII_ARCH = `
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ① 宿主半边（Node / Cordis 进程）                                                      │
│                                                                                      │
│ [入口与装配]  index.js·apply(ctx,cfg)          lib/config.js         lib/switch.js     │
│               · 装配依赖（tokens/store/         · DEFAULTS           + switch-routes  │
│                 transport/wakeup/switch）        · changeScopeAnchor  · 总开关（落盘） │
│               · 注册 29 个 pipeline_* 工具                            · /.dsh-pipeline │
│               · 注册守门链 + 拦截缝                                   · 关≠卸载       │
│               · 同步任务索引 taskIndex（内存，重启即空）                              │
│                                                                                      │
│ [工具面]      lib/tools.js · 29 个 pipeline_* 工具 ★唯一能写 task.json/audit/handoffs │
│               defineTool 退化兜底 · 每次调用后登记主对话会话（唤醒登记点）            │
│                                                    lib/context.js（水位自报/继任策略） │
│                                                                                      │
│ [判据面]      lib/guard.js      lib/guard-factory  lib/handoff.js   lib/hashgate.js   │
│               · decide()        · fail-closed      · SCHEMAS        · 改动面 vs 授权面│
│               · NO_CODE_READ    · ⚠ 冷索引         · 方向表         · 三类越界       │
│                 _ROLES            fail-open 仍在   · ★三权分立落点 · 连续 3 次升级   │
│               · scanTestRunner                     · ⚠B9 半修                        │
│                                                    lib/testscope.js（全量测试四级链） │
│                                                                                      │
│ [状态与角色]  lib/states.js     lib/roles.js       lib/tiers.js     lib/boundaries.js │
│               · ST 18 状态      · ROLES 表         · TIERS L0–L5    · RULES R1–R8 (a) │
│               · TRANSITIONS     · ★SUPERVISOR      · 四槽 SLOT_KEYS · ADVISORY (c)    │
│                 (by + guard)      已登记(只读)     · 权限三档       · 诚实分档        │
│               · 等待态不覆盖    · 白名单方向       · dispatchOpen    · manifest 导出  │
│                 previous_state                     · 开对话留痕                       │
│                                                                                      │
│ [账本与通道]  lib/store.js      lib/transport/     tokens  hostmsg   lib/wakeup.js    │
│               · task.json       · SessionTransport · TTL 2h · source  · ledgerIdentity│
│               · audit 只追加    · Subagent/Manual  · 内存   .kind 必填 · deliverWake  │
│               · planAdvance     · Unreachable      · ★重启失效       · ⚠no-stable-    │
│               · checkAllSeats   · FULL_PERM_CHAIN                    identity 静默   │
│               · sampleSession     [orchestrator,main,user]                            │
│                 Activity        · ensureProjectGroup                                  │
│               · ⚠root===null                                                          │
│                 ⇒ gate off                                                            │
│               lib/liveness.js   lib/security.js    lib/util.js      lib/intercept.js  │
│               · 5 分静默阈值    · 泄密/外联扫描    · PACKAGE_ROOT   · 三个拦截事件    │
│               · B2 活动判据     · 只回打码片段     · 路径锚点解析   · seatBriefing    │
│               · ⚠gateOn 被关                       · 稳定哈希       · 60s 节流        │
└──────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ② 客户端半边（Web GUI · 浏览器）                                                      │
│ lib/client.js（非 ESM，window.__ModuleLoader__.load）→ 挂 conversation.session.header │
│  .utilities（list 槽）→ 多 AI 协调开关按钮 → fetch '/.dsh-pipeline/state'             │
│ ⚠ 询问卡/提问气泡不属本插件（宿主 dsh-user-questions + dsh-client-ui-tool）           │
└──────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ③ 角色层（lib/roles.js 的 ROLES 表 = 能力边界表）                                     │
│ 控制角色(readonly)： main 主对话 │ orchestrator 需求分析 │ planner 计划 │ supervisor  │
│                      只调度不干活  出任务卡+不清楚处       自检+分配      主管(新登记) │
│                                                                                      │
│ 执行角色(三权分立)：  writer 编写          tester 测试           reviewer 审核         │
│                      writes=workdir       writes=own-dir        writes=own-log        │
│                      白名单无 test_to_   可打回编写             唯一出 review_verdict │
│                      review/review_verdict                                            │
│                                                                                      │
│ 顾问角色(own-dir)： architect·security·diagrammer·archivist·release·docs·performance  │
│                     ·arbiter　|　human（人工出口）                                    │
└──────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ④ 四类不变量（任何一单都不许改，只能把新站点纳入同一套判据）                          │
│  三权分立            闸门链              守门作用域           哈希前置闸门            │
│  roles.js 白名单     states.js by+guard  guard.js decide()    hashgate.js 判定       │
│  + 方向表 HANDOFF_   + store.planAdvance + writeClassOf       + baseline-BL-*.json   │
│    DIRECTION                               + checkOwnPath     + 连续 3 次升级人工    │
│  反例：writer 交     反例：跳步/单确认     ⚠今晚 3 次判据      ⚠他单足迹污染本单      │
│    test_to_review      冒充双确认           抖动，只报备未修                          │
└──────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⑤ 状态机（实读 lib/states.js，18 状态 / 24 条迁移）                                   │
│                                                                                      │
│  pending → analyzing → ready_plan → planning → ready_dev                              │
│  ──────────────────────────────────────────────────────────────────────→             │
│  developing → ready_test → testing → ready_review → reviewing → passed → closed       │
│       ↑                        │                       │                             │
│       └── returned_to_dev ←────┘   returned_to_test ←──┘   (打回环, guard=rework_budget)│
│  等待态：awaiting_clarification · awaiting_human（不覆盖 previous_state）             │
│  异常出口：blocked（任意非终态）· cancelled（任意非终态）                             │
└──────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⑥ 数据面 .pipeline\\<taskId>\\（只有 pipeline_* 工具能写）                            │
│  task.json       audit.jsonl     handoffs\\        artifacts\\vN\\   records\\ reports\\ │
│  唯一真相源      只追加动作流水  结构化交接物     制品版本+sha256   席位记录+证据     │
│  state/roster/   transition:*   NNN-<kind>.json  审核结论必须写    baseline-BL-*.json │
│  handoffs[]/     handoff:*/     requirement_     「针对哪个 vN」   改动基线（逐文件   │
│  artifacts[]/    wake:*/gate:*  analysis/plan/   ——不一致即拒      哈希）             │
│  human_requests  clarify:*/     design/dev_to_                                        │
│  history[]/      human:*/       test/test_to_                                         │
│  contacts.main   artifact:reg   review/review_                                        │
│                  seat:submit    verdict/seat_handover                                 │
└──────────────────────────────────────────────────────────────────────────────────────┘
`

const ASCII_FLOW = `
【A · 端到端主链（11 站）】

 ①用户下达 ──open(main)──▶ ②主对话登记 ──dispatch_orchestrator(main)──▶ ③需求分析
                                                                          │
                          ┌───────────────────────────────────────────────┘
                          ▼
 ④需求确认(用户) ──requirement_confirmed(main, guard=requirement_confirm_gate)──▶ ready_plan
                          │
                          ▼
 ⑤计划 ──dispatch_planner(main)──▶ planning ──planned(planner, guard=plan_ready)──▶ ready_dev
        └── plan_gap(planner, guard=plan_gap_gate) ──▶ awaiting_clarification（走 C 面板的澄清梯）
                          │
 ⑥留档（旁路，不推状态）：各角色 record_submit → compile_requirement 汇总 requirement.md
                          │
                          ▼
 ⑦编写 ──dispatch_writer(main)──▶ developing ──dev_submitted(writer, guard=dev_to_test)──▶ ready_test
                          │
                          ▼
 ⑧测试 ──dispatch_tester(main)──▶ testing
        ├── test_passed(tester, guard=test_to_review) ──▶ ready_review
        └── test_failed(tester, guard=rework_budget) ──▶ returned_to_dev
                          │
                          ▼
 ⑨审核 ──dispatch_reviewer(main)──▶ reviewing
        ├── review_ok(reviewer, guard=review_verdict_ok) ──▶ passed
        ├── review_ng_dev(reviewer|security, guard=rework_budget) ──▶ returned_to_dev
        └── review_ng_test(reviewer, guard=rework_budget) ──▶ returned_to_test
                          │
                          ▼
 ⑩关单 ──close(main, guard=close_gates)──▶ closed ──▶ ⑪交付用户

 本项目 11 张单里，走到第 ⑪ 站的：**0 张**。

【B · 打回环与打回预算】
 三条打回边：test_failed / review_ng_dev / review_ng_test —— 全部 guard=rework_budget
 回程边：returned_to_dev → developing（dispatch_writer）
         returned_to_test → testing（dispatch_tester）
 预算：maxReworkPerLeg = 2；计数分 rework.dev / rework.test 两条腿
 ★ 关键设计（states.js:211-215 注释原话）：预算在**打回那一刻**就扣过了；
   回程边再扣一次会造成「第 2 次打回成功 → 再也派不出编写 → 永久卡在已打回编写」的死结。
 超限出路：pipeline_rework 被拒 → 用 transition{block} 交人工，或走 roster_request 追加仲裁角色。

【C · 两级澄清梯】
 第 0 级（不存在）：执行角色直接找用户 —— 拓扑上无此路（用户只与主对话相连）
 第 1 级：clarification_request（by 11 个执行/顾问角色，guard=clarification_blocking）
          → awaiting_clarification
          ├ orchestrator 裁定 answered  → clarification_reply → (previous) 原地继续
          └ orchestrator 裁定 cannot_answer → 升级（★单向门，不能再改口）
 第 2 级：human_request（by 除 main 外全部角色，guard=human_request_blocking）→ awaiting_human
          main → human_relay（**不改状态**，只留痕 + 给确认码 HC-…）
          用户答复 → main → human_reply（guard=human_reply_has_source，必须带 user_quote
          + attribution）→ (previous)

【E · 唤醒投递路径与今晚断掉的 6 处】
 ✅ 席位 交付/提问/人工请求 ──deliverWake──▶ 主对话
 ⚠ 机制（liveness 冻结 / 闸门升级 / 预算超限）──▶ 主对话
 ⚠ 裁定答复 clarify_reply ──wakeResumedSeat/nudgeSeat──▶ 发起席位
 ✗ 缺失：席位 ⇄ 主管/需求       （用户口径：「编写→主管/需求…而现在缺失这一层」）
 ✗ 缺失：主管 → 主对话/需求      （states.js 的 ROLES_CAN_RAISE_HUMAN 里没有 supervisor）

 吞法 1 静默：wake:skipped reason=no-stable-identity（8cdee0 15:36:58Z / 6884af 14:36:22Z）
 吞法 2 去重吃掉不同消息：note=「目标会话里已有同一条（确定性消息 id 命中），不再注入。」
         —— 214043 15:14:01Z：冻结播报**从未送达**
 吞法 3 拿错身份：键 = T-20261012-6884af|handoff|tester|H-7d661abef1479500（用了编写席的 id）
 吞法 4 延迟重放：T-20261012-6884af|clarify|writer#1|CQ-ae58365e3cdea060 投了两次
 吞法 5 投错单：同一主对话在 A 单交的记录被报成 B 单的交付（**三次复现**）
 吞法 6 无主会话可投：wake:skipped reason=no-main-session（214043 共 20 条）
`

const ASCII_HUB = `
【应然】（T-20261011-56a37e 用户原话）
 用户下达 → 主对话转发 → 主管发起三方对话（需求分析 / 计划 / 架构 —— 后两者【待机】）
   → 需求分析出结论 ──★双确认① 主管同意──▶ 架构位出架构图
   → ★双确认② 主管确认架构图满足要求 ──▶ 计划位接活
   → 计划位安排执行位（★ 测试位**提前**收到任务内容 = 预 brief）
   → 编写完成 → 交测试 → 测试无问题 ──★双确认③ 主管+需求 双确认──▶ 审核
   → 审核无问题 ──★双确认④ 主管+需求 确认──▶ 提交主对话
   → ★第⑤道 主对话关单 → 用户收到结果

【实然】（实读代码与账本）
 ✗ 主对话仍是唯一推手：states.js:174-232 里 open / dispatch_* / close 的 by **全部是 [main]**
 ✗ 主管角色已登记（roles.js:160-193），但 states.js 的 TRANSITIONS **没有一条 by 含 supervisor**
 ✗ 架构图不在计划之前：现行顺序是 orchestrator → planner → architect/security → writer/… → diagrammer
 ✗ 没有「待机」语义（无 standby 状态）
 ✗ 没有「测试提前预 brief」（tester 白名单里没有预登记类型）
 ✗ 五道双确认只落地 1 道（close 的 guard=close_gates）；另四道在 states.js 里一条都不存在
 ✗ 「两次独立确认」的语义无处安放（5a871c 审计里没有任何 double-confirm 记录）

【差集 · 缺这 6 件事】
 G1 主管站进状态机        G2 两次独立确认（两条各自留痕的审计记录）
 G3 主管向上报的通道 ★    G4 架构图前置硬序（计划产物在主管确认前不得出现）
 G5 待机与两个唤醒点      G6 测试位预 brief

 载体现状：T-20261011-56a37e 状态 ready_dev / artifacts = 0 / 三个编写席零制品 ⇒ 10 站 0 站落地。
`

// ---------------------------------------------------------------------------
import { warnings } from './svglib.mjs'
const HTML = html()
const MD = md()
fs.writeFileSync(path.join(OUT, '交付文档.html'), HTML, 'utf8')
fs.writeFileSync(path.join(OUT, '交付文档.md'), MD, 'utf8')
if (warnings.length) {
  console.log('\n⚠ 布局溢出告警 (' + warnings.length + '):')
  ;[...new Set(warnings)].forEach((x) => console.log('  ' + x))
} else {
  console.log('\n布局：无溢出告警')
}
console.log('OK')
console.log('HTML bytes:', fs.statSync(path.join(OUT, '交付文档.html')).size)
console.log('MD   bytes:', fs.statSync(path.join(OUT, '交付文档.md')).size)
