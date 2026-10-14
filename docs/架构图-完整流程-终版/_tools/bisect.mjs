// 二分定位：拆分里的哪个元素让 workflow 渲染器崩（internal/unclassified）。
// 从**原封不动的旧规格**派生若干变体，逐个写文件，随后由外部循环跑 archify validate。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const [src, outDir] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const base = JSON.parse(readFileSync(src, 'utf8'))

const clone = () => JSON.parse(JSON.stringify(base))

/** 把 n_verification 改名成 n_test（单节点版），并重指三条边。 */
function renameOnly(doc) {
  const n = doc.nodes.find((x) => x.id === 'n_verification')
  n.id = 'n_test'
  n.label = '测试位'
  n.sublabel = '自己跑判据'
  n.tag = 'test_passed / test_failed'
  for (const e of doc.edges) {
    if (e.from === 'n_verification') e.from = 'n_test'
    if (e.to === 'n_verification') e.to = 'n_test'
  }
  return doc
}

function addReview(doc, { col = 4, yOffset = 80 } = {}) {
  const node = {
    id: 'n_review',
    lane: 'gates',
    col,
    type: 'cloud',
    label: '审核位',
    sublabel: '唯一开闸结论',
    tag: 'review_ok / review_ng_*',
    width: 92,
    height: 68,
  }
  if (yOffset !== null) node.yOffset = yOffset
  doc.nodes.push(node)
  return doc
}

function rewireReview(doc) {
  const e = doc.edges.find((x) => x.id === 'e_review_ok')
  e.from = 'n_review'
  return doc
}

function addTestToReview(doc) {
  doc.edges.splice(5, 0, {
    id: 'e_test_to_review',
    from: 'n_test',
    to: 'n_review',
    label: 'test_passed',
    variant: 'emphasis',
    role: 'main',
  })
  return doc
}

const variants = {
  // A: 只改名 + 重指边（单节点）
  A_rename_only: () => renameOnly(clone()),
  // B: 改名 + 加第二个节点（col4/yOffset80），但不加任何连到它的边
  B_two_nodes_no_edge: () => addReview(renameOnly(clone())),
  // C: 完整拆分（= try-01，已知失败，作为对照）
  C_full: () => addTestToReview(rewireReview(addReview(renameOnly(clone())))),
  // D: 第二个节点放 col5（不叠行），保留 test→review 边
  D_review_col5: () => addTestToReview(rewireReview(addReview(renameOnly(clone()), { col: 5, yOffset: null }))),
  // E: 两个节点都在 col4，但只重指 e_review_ok（不加 test→review 边）
  E_two_nodes_review_out_only: () => rewireReview(addReview(renameOnly(clone()))),
  // F: 两个节点都在 col4，加 test→review 边，但不重指 e_review_ok（review 有入无出）
  F_two_nodes_test_to_review_only: () => addTestToReview(addReview(renameOnly(clone()))),
  // G: 第二个节点 col4 不给 yOffset（默认叠在一起），保留两条边
  G_no_yoffset: () => addTestToReview(rewireReview(addReview(renameOnly(clone()), { yOffset: null }))),
  // H: 只改名 + 只重指 e_review_ok（不新增节点）——对照 A
  H_rename_rewire: () => rewireReview(renameOnly(clone())),
}

for (const [name, fn] of Object.entries(variants)) {
  const doc = fn()
  const ids = new Set(doc.nodes.map((n) => n.id))
  for (const e of doc.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) throw new Error(`${name}: dangling ${e.id}`)
  }
  writeFileSync(`${outDir}/${name}.json`, JSON.stringify(doc, null, 2))
}
console.log(Object.keys(variants).join(' '))
