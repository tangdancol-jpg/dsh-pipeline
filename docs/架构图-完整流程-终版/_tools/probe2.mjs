// 细粒度对照：把"改名就崩"拆开，先排除位置/文件名/格式化，再逐字段试。
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'

const [src, outDir] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const raw = readFileSync(src, 'utf8')
const base = JSON.parse(raw)
const emit = (name, doc) => writeFileSync(`${outDir}/${name}.json`, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2))
const clone = () => JSON.parse(JSON.stringify(base))
const re = (doc, patch) => { patch(doc); return doc }

// Z0 —— 逐字节复制（只换位置与文件名）
copyFileSync(src, `${outDir}/Z0_bytecopy.json`)
// Z1 —— 只重新格式化（parse + stringify(2)），语义零改动
emit('Z1_reformat_only', clone())
// Z2 —— 只把 label 改成「测试位」（id 不动）
emit('Z2_label_only', re(clone(), (d) => { d.nodes.find((n) => n.id === 'n_verification').label = '测试位' }))
// Z3 —— 只把 sublabel 改掉
emit('Z3_sublabel_only', re(clone(), (d) => { d.nodes.find((n) => n.id === 'n_verification').sublabel = '自己跑判据' }))
// Z4 —— 只把 tag 改掉
emit('Z4_tag_only', re(clone(), (d) => { d.nodes.find((n) => n.id === 'n_verification').tag = 'test_passed / test_failed' }))
// Z5 —— 只把 meta.output 改掉
emit('Z5_output_only', re(clone(), (d) => { d.meta.output = 'main-path.html' }))
// Z6 —— 只把节点 id 改掉（边不动 ⇒ 故意留悬空边，看是否走结构化诊断而不是崩）
emit('Z6_id_only', re(clone(), (d) => { d.nodes.find((n) => n.id === 'n_verification').id = 'n_test' }))
// Z7 —— id + 边一起改（等价 A，但 label/sublabel/tag 全部保持原样）
emit('Z7_id_plus_edges', re(clone(), (d) => {
  d.nodes.find((n) => n.id === 'n_verification').id = 'n_test'
  for (const e of d.edges) { if (e.from === 'n_verification') e.from = 'n_test'; if (e.to === 'n_verification') e.to = 'n_test' }
}))
// Z8 —— 原样文本，只把 n_verification 这个字符串全局替换（保持原排版）
emit('Z8_text_replace', raw.split('n_verification').join('n_test'))

console.log('written')
