// 名单权威层自测的**夹具**（不是测试：没有断言，所以刻意**不登记**进 `registry.mjs`）。
//
// 从 `tests/roster-authority-check.mjs` 抽出来（2026-10-16 · 行数纪律：那一份 600 行，
// 而本次要改它的 D·B2 那一段 —— 规矩是"给 ≥400 行的文件加行，先拆再改"）。
// 内容**逐字节原样**，只是换了个文件放；同一形状的先例见 `tests/switch-fixtures.mjs`。
//
// @module dsh-pipeline/tests/roster-fixtures

import { buildRoster } from '../lib/tiers.js'

/** 编写席位的**席位名**（夹具与判据共用同一个字面量）。 */
export const SEAT = 'writer#1'

export const FIXTURE_WRITERS = {
  count: 1,
  reason: '夹具：单席位（count=1 是同一套机制的退化情形）',
  partitions: [{ seat: SEAT, scope_paths: ['.'], deliverables: ['夹具产物'] }],
}
export function fixture(over = {}) {
  return buildRoster({
    tier: 'L3',
    reason: '名单权威层自测夹具（不落盘）',
    judgedBy: 'planner',
    writers: FIXTURE_WRITERS,
    ...over,
  })
}

/** 一份"四槽声明齐全"的夹具（strict 模式下必须齐）。 */
export function fullSlots(over = {}) {
  const base = { 'writer@writer#1': { permission: 'workspace-write' } }
  for (const r of ['architect', 'security', 'tester', 'reviewer', 'diagrammer', 'archivist']) {
    base[r] = { permission: 'read-only' }
  }
  return { ...base, ...over }
}

