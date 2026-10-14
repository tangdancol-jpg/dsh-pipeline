import { readFileSync, writeFileSync } from 'node:fs'
const s = readFileSync('_probe4.mjs', 'utf8')
const anchor = "for (const b of sides) combos.push({ toSide: b })"
if (!s.includes(anchor)) { console.error('anchor missing'); process.exit(1) }
const add = anchor + `
for (const r of ['drop', 'outside-right', 'return-left', 'bottom-channel', 'up-channel', 'straight']) {
  for (const a of sides) for (const b of sides) combos.push({ route: r, fromSide: a, toSide: b })
}`
writeFileSync('_probe5.mjs', s.replace(anchor, add), 'utf8')
console.log('probe5 written')
