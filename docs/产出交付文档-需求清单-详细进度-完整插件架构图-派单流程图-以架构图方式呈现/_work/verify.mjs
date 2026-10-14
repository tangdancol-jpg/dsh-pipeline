import fs from 'node:fs'
const OUT = '~\\.dsh\\dsh_orb\\产出交付文档-需求清单-详细进度-完整插件架构图-派单流程图-以架构图方式呈现'
const h = fs.readFileSync(OUT + '\\交付文档.html', 'utf8')
const m = fs.readFileSync(OUT + '\\交付文档.md', 'utf8')

// --- 抽 SVG 数量与尺寸 ---
const svgs = [...h.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((x) => x[0])
console.log('HTML 内嵌 SVG 数量:', svgs.length)
svgs.forEach((s, i) => {
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(s)
  console.log(`  #${i + 1} viewBox=${vb ? vb[1] + 'x' + vb[2] : '?'}  chars=${s.length}  <text>=${(s.match(/<text/g) || []).length}  <rect>=${(s.match(/<rect/g) || []).length}  <path>=${(s.match(/<path/g) || []).length}`)
  // 括号配平粗检
  const open = (s.match(/<[a-zA-Z]/g) || []).length
  const close = (s.match(/<\//g) || []).length + (s.match(/\/>/g) || []).length
  if (open !== close) console.log(`      ⚠ 标签配平可疑: open=${open} close=${close}`)
})

// --- 关键事实串是否都在两份里 ---
const must = [
  'T-20261011-214043', 'T-20261011-56a37e', 'T-20261012-6884af', 'T-20261012-8cdee0',
  'T-20261011-4a2dc7', 'T-20261011-a5fe41',
  '70/70', '38/38', '70/72',
  '10,717', '563,327', '575,960',
  'no-stable-identity', 'no-main-session',
  'MALFORMED_RESPONSE', 'H-7d661abef1479500',
  'quiet_streak', 'gate_applicable', 'root === null',
  'waterfall=no-live-request', 'card=absent', 'reveal=false',
  'ROLE.SUPERVISOR', 'ROLES_CAN_RAISE_HUMAN',
  'B10', 'B9', 'B2',
  '主管枢纽', '三权分立', '哈希前置闸门', '守门作用域', '闸门链',
  'dispatch_writer', 'dev_submitted', 'test_failed', 'review_ok',
  'requirement_confirm_gate', 'plan_gap_gate', 'rework_budget', 'close_gates',
]
console.log('\n关键事实串核对：')
let missH = [], missM = []
for (const k of must) { if (!h.includes(k)) missH.push(k); if (!m.includes(k)) missM.push(k) }
console.log('  HTML 缺:', missH.length ? missH.join(' / ') : '（无）')
console.log('  MD   缺:', missM.length ? missM.join(' / ') : '（无）')

// --- 章节锚点 ---
console.log('\nHTML 章节：')
;[...h.matchAll(/<h2 id="([^"]+)">([^<]+)</g)].forEach((x) => console.log('  #' + x[1] + '  ' + x[2]))
console.log('\nMD 一级/二级标题：')
m.split('\n').filter((l) => /^#{1,2} /.test(l)).forEach((l) => console.log('  ' + l))

// --- HTML 基本结构 ---
console.log('\nHTML 结构检查：')
console.log('  <!DOCTYPE>:', h.startsWith('<!DOCTYPE html>'))
console.log('  </html> 收尾:', h.trimEnd().endsWith('</html>'))
console.log('  <table> 数:', (h.match(/<table>/g) || []).length, ' </table> 数:', (h.match(/<\/table>/g) || []).length)
console.log('  <div 数:', (h.match(/<div/g) || []).length, ' </div> 数:', (h.match(/<\/div>/g) || []).length)
console.log('  <h3> 数:', (h.match(/<h3>/g) || []).length, ' <h4> 数:', (h.match(/<h4>/g) || []).length)
console.log('  状态徽章:', (h.match(/class="st /g) || []).length)
console.log('\nMD 长度: 行数', m.split('\n').length, '/ 表格行', (m.match(/^\|/gm) || []).length)
