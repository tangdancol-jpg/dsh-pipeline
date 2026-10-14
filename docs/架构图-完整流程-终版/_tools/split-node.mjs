// 最小改动 1：把合并节点 n_verification「测试与审核」拆成 n_test「测试位」+ n_review「审核位」。
// 做法：对 JSON 文本做定点替换（保持原文件排版），每处替换都断言命中次数，最后整体 JSON.parse 校验。
import { readFileSync, writeFileSync } from 'node:fs'

const [src, dst] = process.argv.slice(2)
let text = readFileSync(src, 'utf8')

const patches = [
  // output 改名（本图自己的文件名）
  [`"output": "ai-pipeline-flow.html"`, `"output": "main-path.html"`, 1],

  // 两个视图的 focus 列表：n_verification → n_test + n_review
  [
    `          "n_execution",\n          "n_verification",\n          "n_archiving",\n          "n_closeout"\n        ],`,
    `          "n_execution",\n          "n_test",\n          "n_review",\n          "n_archiving",\n          "n_closeout"\n        ],`,
    1,
  ],
  [
    `          "n_execution",\n          "n_verification",\n          "n_closeout"\n        ],`,
    `          "n_execution",\n          "n_test",\n          "n_review",\n          "n_closeout"\n        ],`,
    1,
  ],

  // 节点本体：一个合并节点 → 两个节点（label 逐字等于结构树模块名）
  [
    `    {
      "id": "n_verification",
      "lane": "gates",
      "col": 4,
      "type": "cloud",
      "label": "测试与审核",
      "sublabel": "独立复核出结论",
      "tag": "test_* / review_ok",
      "width": 92,
      "height": 68
    },`,
    `    {
      "id": "n_test",
      "lane": "gates",
      "col": 4,
      "type": "cloud",
      "label": "测试位",
      "sublabel": "自己跑判据",
      "tag": "test_passed / test_failed",
      "width": 92,
      "yOffset": 0,
      "height": 68
    },
    {
      "id": "n_review",
      "lane": "gates",
      "col": 4,
      "type": "cloud",
      "label": "审核位",
      "sublabel": "唯一开闸结论",
      "tag": "review_ok / review_ng_*",
      "width": 92,
      "yOffset": 80,
      "height": 68
    },`,
    1,
  ],

  // 边：指向/离开 n_verification 的三条按语义重指
  //   编写 → 测试位（dev_to_test 的收件人是测试位）
  [
    `      "id": "e_dev_submitted",
      "from": "n_execution",
      "to": "n_verification",`,
    `      "id": "e_dev_submitted",
      "from": "n_execution",
      "to": "n_test",`,
    1,
  ],
  //   审核位 → 留档（review_ok 是审核位独有的开闸结论）
  [
    `      "id": "e_review_ok",
      "from": "n_verification",
      "to": "n_archiving",`,
    `      "id": "e_review_ok",
      "from": "n_review",
      "to": "n_archiving",`,
    1,
  ],
  //   测试位 → 编写（test_failed 是测试位独有的打回 kind test_to_dev）
  [
    `      "id": "e_rework",
      "from": "n_verification",
      "to": "n_execution",`,
    `      "id": "e_rework",
      "from": "n_test",
      "to": "n_execution",`,
    1,
  ],
  //   新增：测试位 → 审核位（test_passed → ready_review，唯一入口），否则主路径断开
  [
    `    {
      "id": "e_review_ok",`,
    `    {
      "id": "e_test_to_review",
      "from": "n_test",
      "to": "n_review",
      "label": "test_passed",
      "variant": "emphasis",
      "role": "main"
    },
    {
      "id": "e_review_ok",`,
    1,
  ],
]

for (const [find, repl, expect] of patches) {
  const hits = text.split(find).length - 1
  if (hits !== expect) {
    console.error(`PATCH MISS (hits=${hits}, expect=${expect}) for:\n${find.slice(0, 120)}`)
    process.exit(1)
  }
  text = text.replace(find, repl)
}

const doc = JSON.parse(text)
const ids = new Set(doc.nodes.map((n) => n.id))
if (ids.has('n_verification')) throw new Error('n_verification still present')
for (const n of doc.nodes) {
  if (n.id === 'n_test' && n.label !== '测试位') throw new Error('n_test label wrong: ' + n.label)
  if (n.id === 'n_review' && n.label !== '审核位') throw new Error('n_review label wrong: ' + n.label)
}
for (const e of doc.edges) {
  if (!ids.has(e.from)) throw new Error(`dangling from ${e.from}`)
  if (!ids.has(e.to)) throw new Error(`dangling to ${e.to}`)
}
writeFileSync(dst, text)
console.log(`ok: nodes=${doc.nodes.length} edges=${doc.edges.length} bytes=${Buffer.byteLength(text)}`)
