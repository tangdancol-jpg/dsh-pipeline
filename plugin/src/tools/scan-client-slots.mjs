/**
 * dsh-pipeline · 客户端槽位侦察脚本（取证用）
 * ============================================================================
 *     node tools/scan-client-slots.mjs <解包出来的 @deepseek-ai 目录>
 *
 * 为什么需要它：**DSH 的插槽名不是集中枚举的。**
 * `@deepseek-ai/dsh-client-ui-slots` 只是纯注册表机制（`SlotCore`），里面没有任何
 * 具体槽位名；槽位名由**声明方**（各 `ui-*` 包的 client 半边）在
 * `register({children: {...}})` 里就地写死。所以想知道"有没有右上角槽位"，
 * 只能把全部客户端 bundle 扫一遍。
 *
 * 本脚本就是为此写的：它同时收三种东西
 *   · `renderSlot("x")` —— 谁**渲染**了哪个槽（渲染方 = 定义位置的那一侧）
 *   · `registerFactory({name:"x"})` —— 声明出的 factory 名
 *   · `.register({name:"x"})` —— 谁**占用**了哪个槽
 * 然后按关键词（head / top / bar / leading / overlay / shell …）挑出候选项。
 *
 * 怎么拿到输入目录：用 `tools/asar.ps1` 从 `app.asar` 里把各
 * `@deepseek-ai` 包的 `lib` 目录解出来（见 README 的侦察一节）。
 *
 * ⚠️ 写注释时别在块注释里写带星号的 glob —— `…/lib/*` 里的那个 `*` 加斜杠
 *    会**提前闭合块注释**。这个脚本第一版就是这么坏的（`lib is not defined`）。
 *
 * 本插件当初就是靠它得出结论的：**没有窗口级顶栏槽位**；`shell.leading`
 * 只在 macOS 且侧栏收起时挂载；最终选了 `conversation.session.header.utilities`。
 *
 * ★ 只读脚本：只读文件、只打 stdout，不写任何东西。
 *
 * @module dsh-pipeline/tools/scan-client-slots
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (root === undefined || root.length === 0) {
  console.error('用法：node tools/scan-client-slots.mjs <解包出来的 @deepseek-ai 目录>')
  process.exit(2)
}

const files = []
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.js')) files.push(p)
  }
}
walk(root)

const renderers = new Map()
const factories = new Map()
const occupants = new Map()

const pkgOf = (f) => {
  const m = f.replace(/\\/g, '/').match(/@deepseek-ai\/([^/]+)\//)
  return m ? m[1] : f
}
const add = (map, key, val) => {
  if (!map.has(key)) map.set(key, [])
  map.get(key).push(val)
}

for (const f of files) {
  if (statSync(f).size > 3_000_000) continue
  const text = readFileSync(f, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const loc = `${pkgOf(f)}:${i + 1}`
    for (const m of lines[i].matchAll(/renderSlot\(\s*["'`]([^"'`]+)["'`]/g)) add(renderers, m[1], loc)
    for (const m of lines[i].matchAll(/renderSlot\(\s*([A-Za-z_$][\w$]*)\s*,/g)) add(renderers, `«变量 ${m[1]}»`, loc)
    for (const m of lines[i].matchAll(/slots:\s*\{/g)) add(factories, '«slots:{ 块»', loc)
  }
  for (const m of text.matchAll(/registerFactory\(\s*\{[\s\S]{0,400}?name:\s*["'`]([^"'`]+)["'`]/g)) add(factories, `factory:${m[1]}`, pkgOf(f))
  for (const m of text.matchAll(/\.register\(\s*\{[\s\S]{0,300}?name:\s*["'`]([^"'`]+)["'`]/g)) add(occupants, m[1], pkgOf(f))
}

const dump = (title, map) => {
  console.log(`\n########## ${title} ##########`)
  for (const k of [...map.keys()].sort()) {
    const uniq = [...new Set(map.get(k))]
    console.log(`${k}  ←  ${uniq.slice(0, 4).join(' , ')}${uniq.length > 4 ? ` …(+${uniq.length - 4})` : ''}`)
  }
}

console.log(`扫描了 ${files.length} 个 .js`)
dump('renderSlot(...) 渲染的槽位名', renderers)
dump('registerFactory 声明的 factory 名', factories)
dump('.register({name:...}) 注册的条目名', occupants)

const interesting = (name) => /head|top|bar|leading|overlay|toolbar|status|tray|shell|action/i.test(name)
console.log('\n########## 与「头部/右上角」相关的候选 ##########')
const all = new Map()
for (const [map, tag] of [[renderers, 'render'], [factories, 'declare'], [occupants, 'register']]) {
  for (const k of map.keys()) {
    if (!interesting(k)) continue
    if (!all.has(k)) all.set(k, new Set())
    all.get(k).add(tag)
  }
}
for (const k of [...all.keys()].sort()) console.log(`${k}   [${[...all.get(k)].join(',')}]`)
