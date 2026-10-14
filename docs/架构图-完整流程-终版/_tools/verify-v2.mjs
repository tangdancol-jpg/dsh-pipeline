import { readFileSync } from 'node:fs'
const h = readFileSync(process.argv[2], 'utf8')
const c = (s) => h.split(s).length - 1
const keys = [
  'data-preset="signal-flow"',
  'archify-reader-contract',
  '打回 / 异常出口',
  '①否掉 ⇒ 退回补析',
  '②否掉 ⇒ 退回重画',
  '③否掉 ⇒ 退回重跑',
  '④否掉 ⇒ 退回重审',
  '审核 NG ⇒ 打回编写',
  '审核 NG ⇒ 打回测试',
  '澄清 ⇒ 发起席停等',
  '裁定 ⇒ 投回原席',
  '再打回 ⇒ 超限',
  '也计预算',
  '无 OK 关单被拒',
  '预算用尽 ⇒ 交人工',
  '退回需求补析',
  '退回架构重画',
  'x_ret_dev',
  'x_clarify',
  '测试位',
  '审核位',
  'n_verification',
]
console.log('bytes', Buffer.byteLength(h))
for (const k of keys) console.log(String(c(k)).padStart(4), k)
// 边数：统计 data-* 里表示 relationship 的属性
const m = h.match(/data-edge-id="([^"]+)"/g) || h.match(/data-relationship="[^"]*"/g)
console.log('关系标记命中：', m ? m.length : 'n/a')
const v1 = readFileSync(process.argv[3])
console.log('v1 main-path.html bytes', v1.length, '（未被覆盖）')
