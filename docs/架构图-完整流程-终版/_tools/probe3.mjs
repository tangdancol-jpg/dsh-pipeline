// 探 tag 的容量边界：tag 在最小字号下放不进盒宽时，渲染器是不是就崩。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const [src, outDir] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const base = JSON.parse(readFileSync(src, 'utf8'))
const clone = () => JSON.parse(JSON.stringify(base))
const emit = (name, mutate) => { const d = clone(); mutate(d); writeFileSync(`${outDir}/${name}.json`, JSON.stringify(d, null, 2)) }
const N = (d) => d.nodes.find((n) => n.id === 'n_verification')

const tags = [
  ['t11', 'test_passed'],
  ['t17', 'test_* / review_ok'],
  ['t20', 'review_ok / rev_ng_*'],
  ['t23', 'test_passed / test_fai'],
  ['t24', 'test_passed / test_fail'],
  ['t25', 'test_passed / test_failed'],
  ['t29', 'test_passed / test_failed_x123'],
]
for (const [name, tag] of tags) {
  emit(`T_${name}_w92`, (d) => { N(d).tag = tag })
}

// 同样 25 字的 tag，但把盒子加宽 / 整体加宽
emit('W120_t25', (d) => { N(d).tag = 'test_passed / test_failed'; N(d).width = 120 })
emit('W150_t25', (d) => { N(d).tag = 'test_passed / test_failed'; N(d).width = 150 })
emit('W120_allnodes_t25', (d) => { for (const n of d.nodes) n.width = 120; N(d).tag = 'test_passed / test_failed' })
// 中文 tag（CJK 单位更宽）
emit('T_cjk6', (d) => { N(d).tag = '测试位 / 审核位' })
emit('T_cjk12', (d) => { N(d).tag = '测试位产出 / 审核位结论' })
console.log('written')
