// SVG 图元库 —— 手写内联 SVG，无外部依赖
export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const C = {
  blue:   { fill: '#dae8fc', stroke: '#6c8ebf' },
  green:  { fill: '#d5e8d4', stroke: '#82b366' },
  red:    { fill: '#f8cecc', stroke: '#b85450' },
  orange: { fill: '#ffe6cc', stroke: '#d79b00' },
  purple: { fill: '#e1d5e7', stroke: '#9673a6' },
  grey:   { fill: '#f5f5f5', stroke: '#8c8c8c' },
  white:  { fill: '#ffffff', stroke: '#333333' },
  yellow: { fill: '#fff2cc', stroke: '#d6b656' },
  dark:   { fill: '#23445d', stroke: '#10243a' },
}

const CJK = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/

/** 估算字符串渲染宽度（px） */
export function textW(s, fs) {
  let w = 0
  for (const ch of String(s)) w += CJK.test(ch) ? fs : fs * 0.548
  return w
}

/** 按可用宽度折行（CJK 逐字断，ASCII 优先在空格处断） */
export function wrapText(s, fs, maxW) {
  const str = String(s)
  if (maxW <= 0) return [str]
  const out = []
  let cur = ''
  for (const ch of str) {
    if (textW(cur + ch, fs) > maxW && cur.length > 0) {
      out.push(cur)
      cur = ch === ' ' ? '' : ch
    } else cur += ch
  }
  if (cur.length > 0) out.push(cur)
  return out.length > 0 ? out : ['']
}

const WARN = []
export const warnings = WARN

/** 清掉 markdown 标记（SVG 里不渲染 ** 与 `） */
const clean = (s) => String(s).replace(/\*\*/g, '').replace(/`/g, '')

/**
 * 圆角矩形 + 标题 + 若干行说明
 * 自动折行 → 自动缩号 → 仍放不下就画红框并把坐标报进 warnings
 */
export function box(o) {
  const c = C[o.c || 'blue']
  const x = o.x, y = o.y, w = o.w, h = o.h
  const pad = 9
  const avail = w - pad * 2
  const out = []

  const title = clean(o.title || '')
  const sub0 = o.sub ? clean(o.sub) : ''
  const lines0 = (o.lines || []).map(clean)

  const trunc = (s, fs) => {
    if (textW(s, fs) <= avail) return s
    let t = s
    while (t.length > 1 && textW(t + '…', fs) > avail) t = t.slice(0, -1)
    return t + '…'
  }

  /** 给定字号，算出折行结果与所需高度 */
  const layout = (ts, ls) => {
    let subLines = []
    if (sub0) {
      subLines = wrapText(sub0, ls, avail)
      if (subLines.length > 2) subLines = [subLines[0], trunc(subLines.slice(1).join(' '), ls)]
      subLines = subLines.map((s) => trunc(s, ls))
    }
    const bodyLines = []
    for (const ln of lines0) for (const p of wrapText(ln, ls, avail)) bodyLines.push(p)
    let n = (o.tp ?? ts + 12)
    if (title) n += ts + 5
    if (subLines.length) n += subLines.length * (ls + 2.5) + 2
    n += bodyLines.length * (ls + 3.4)
    n += 3
    return { subLines, bodyLines, need: n }
  }

  // 标题缩号（最小 9）
  let ts = o.ts || 14
  while (ts > 9 && textW(title, ts) > w - 14) ts -= 0.5

  // 先缩说明字号，再缩标题字号
  let ls = o.ls || 11.2
  let L = layout(ts, ls)
  let guard = 0
  while (L.need > h && ls > 7.8 && guard++ < 80) { ls -= 0.2; L = layout(ts, ls) }
  while (L.need > h && ts > 9 && guard++ < 160) { ts -= 0.3; L = layout(ts, ls) }

  const overflow = L.need > h + 1
  if (overflow) WARN.push(`OVERFLOW ${x},${y} ${w}x${h} need=${L.need.toFixed(0)} :: ${title || lines0[0] || ''}`)

  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx ?? 7}" fill="${c.fill}" stroke="${overflow ? '#ff0000' : c.stroke}" stroke-width="${overflow ? 2.4 : (o.sw || 1.4)}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`)

  let cy = y + (o.tp ?? ts + 12)
  if (title) {
    out.push(`<text x="${x + w / 2}" y="${cy}" text-anchor="middle" font-size="${ts}" font-weight="700" fill="#111">${esc(title)}</text>`)
    cy += ts + 5
  }
  for (const sl of L.subLines) {
    out.push(`<text x="${x + w / 2}" y="${cy}" text-anchor="middle" font-size="${ls}" fill="#444" font-style="italic">${esc(sl)}</text>`)
    cy += ls + 2.5
  }
  if (L.subLines.length) cy += 2
  for (const ln of L.bodyLines) {
    out.push(`<text x="${x + pad}" y="${cy}" font-size="${ls}" fill="#222">${esc(ln)}</text>`)
    cy += ls + 3.4
  }
  return out.join('\n')
}

/** 纯文本 */
export function txt(x, y, s, o = {}) {
  return `<text x="${x}" y="${y}" text-anchor="${o.anchor || 'start'}" font-size="${o.size || 12}" font-weight="${o.weight || 400}" fill="${o.fill || '#222'}"${o.italic ? ' font-style="italic"' : ''}${o.mono ? ' font-family="Consolas,Menlo,monospace"' : ''}${o.rotate ? ` transform="rotate(${o.rotate} ${x} ${y})"` : ''}>${esc(s)}</text>`
}

/** 分区外框 + 左上角标题 */
export function frame(x, y, w, h, title, o = {}) {
  const c = C[o.c || 'grey']
  const out = []
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${o.fill || 'none'}" stroke="${c.stroke}" stroke-width="${o.sw || 1.6}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`)
  if (title) {
    const ts = o.tsize || 15
    const tw = textW(title, ts) + 20
    out.push(`<rect x="${x + 14}" y="${y - 13}" width="${tw}" height="${ts + 12}" rx="6" fill="${c.stroke}"/>`)
    out.push(txt(x + 14 + tw / 2, y + 5, title, { anchor: 'middle', size: ts, weight: 700, fill: '#fff' }))
  }
  return out.join('\n')
}

/** 折线箭头（正交） */
export function arrow(pts, o = {}) {
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ')
  const color = o.color || '#4a4a4a'
  const head = o.head === false ? '' : ` marker-end="url(#${o.marker || 'ah'})"`
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${o.sw || 1.6}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}${head} stroke-linejoin="round"/>`
}

/** 直线箭头 */
export function edge(x1, y1, x2, y2, o = {}) {
  return arrow([[x1, y1], [x2, y2]], o)
}

export function marker(id, color) {
  return `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/></marker>`
}

export function svgWrap(w, h, body, defs = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px;height:auto;display:block;margin:0 auto;background:#fff" role="img" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif">
<defs>
${marker('ah', '#4a4a4a')}
${marker('ahRed', '#b85450')}
${marker('ahGreen', '#82b366')}
${marker('ahBlue', '#6c8ebf')}
${marker('ahOrange', '#d79b00')}
${marker('ahPurple', '#9673a6')}
${defs}
</defs>
${body}
</svg>`
}
