// 放大镜：把生成的架构 SVG 的某个 viewBox 区域单独渲染出来，用于人工核对排版
import fs from 'node:fs'
const OUT = '<DSH_HOME>\\dsh_orb\\产出交付文档-需求清单-详细进度-完整插件架构图-派单流程图-以架构图方式呈现'
const SHOT = OUT + '\\_work\\shot'
const h = fs.readFileSync(OUT + '\\交付文档.html', 'utf8')
const svgs = [...h.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((x) => x[0])
const names = ['arch', 'flow', 'hub']

const regions = JSON.parse(fs.readFileSync(SHOT + '\\regions.json', 'utf8'))
regions.forEach(([di, x, y, w, hh, tag]) => {
  const s = svgs[di].replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${w} ${hh}"`).replace(/max-width:[^;"]*/, `max-width:${w}px`)
  fs.writeFileSync(`${SHOT}\\z-${tag}.html`, `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:6px;background:#fff}svg{width:${w}px!important;max-width:none!important;height:auto}</style></head><body>${s}</body></html>`, 'utf8')
  console.log('wrote z-' + tag)
})
