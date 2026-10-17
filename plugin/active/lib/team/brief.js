/**
 * dsh-pipeline · Agent Teams 通道 · **角色人格拼进派活单**
 * ============================================================================
 * 为什么角色人格要写进正文（不是配进会话）：官方 `spawnTeammate` 的请求体
 * 只有 `{name, description, prompt, context, provider, signal}` —— **没有**
 * `agentPreset` / permission / model / reasoning（证据：`_tmp/teamservice.txt:1004-1020`
 * 与 `.team-recon/team-api.md` §Q1）。teammate 的人格 = **Lead 会话那张 preset 的同一份
 * revision**（`[sub]:373-383` 的 `composeFrom`）⇒ team 通道**下发不了**角色预设。
 *
 * 所以：角色固定提示词只能**随派活单一起投进正文**（01 §D2 的裁定）。
 *
 * ★ 不新抄一份提示词：前缀 / 后缀一律经 `presets/render.js` 的
 *   `composePrefix` / `composeSuffix` 读 `presets/src/<role>/`（那是生成器自己的
 *   拼装口径，抄一份就会与 `generated/pipeline-presets.patch.yml` 漂移）。
 *
 * @module dsh-pipeline/lib/team/brief
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PACKAGE_ROOT } from '../util.js'
import { composePrefix, composeSuffix } from '../../presets/render.js'

/** 角色 → 预设目录的派生索引（不是第二份真源：它由 `presets/validate.js` 与 roles.js 对齐）。 */
const PRESETS_ROOT = join(PACKAGE_ROOT, 'presets')

/** 读过的 persona 缓存（同一个 role 在一次进程里只读一次盘）。 */
const CACHE = new Map()

/**
 * 读一个角色的固定提示词：`prefix`（`prefix.md` + `prompt.md`）与
 * `suffix`（`suffix.md` + 运行时后缀），**与预设生成器同一份拼装函数**。
 *
 * 失败**不抛**：返回 `{ok:false, note}` 让调用方在派活单里如实写"人格没带上"，
 * 而不是把一次派活整死（人格缺了是降级、不是故障 —— 但必须看得见）。
 *
 * @param {string} role
 * @param {{root?:string}} [opts] `root` = 预设根目录（默认插件包根下的 `presets/`；测试可传临时副本）
 * @returns {{ok:boolean, prefix:string, suffix:string, dir:string|null, note:string}}
 */
export function rolePersona(role, opts = {}) {
  const root = typeof opts.root === 'string' && opts.root.length > 0 ? opts.root : PRESETS_ROOT
  const key = `${root}\u0000${String(role ?? '')}`
  const hit = CACHE.get(key)
  if (hit !== undefined) return hit
  const fail = (note) => {
    const rec = { ok: false, prefix: '', suffix: '', dir: null, note }
    CACHE.set(key, rec)
    return rec
  }
  const r = String(role ?? '')
  if (r.length === 0) return fail('没给角色名，读不到角色预设。')
  let dir = ''
  try {
    const index = JSON.parse(readFileSync(join(root, '_index.json'), 'utf8'))
    const entry = index?.presets?.[r]
    if (entry === null || typeof entry !== 'object' || typeof entry.dir !== 'string') {
      return fail(`预设索引里没有角色「${r}」的条目（${join(root, '_index.json')}）。`)
    }
    dir = join(root, entry.dir)
    if (!existsSync(join(dir, 'prompt.md'))) {
      return fail(`角色「${r}」的预设目录里没有 prompt.md（${dir}）。`)
    }
    const rec = { ok: true, prefix: composePrefix(dir), suffix: composeSuffix(dir), dir, note: '' }
    CACHE.set(key, rec)
    return rec
  } catch (err) {
    return fail(`读角色「${r}」的预设失败（${dir || root}）：${String(err?.message ?? err)}`)
  }
}

/**
 * 把「角色人格」与「派活单」拼成 `spawnTeammate` 的正文。
 *
 * 版式顺序：**先人格、后派活单、最后后缀** —— 与预设里 `persona.prefix` / 正文 /
 * `persona.suffix` 的相对位置一致，teammate 读到的顺序与它当普通会话时相同。
 *
 * @param {{brief:string, persona:{ok:boolean, prefix:string, suffix:string, note?:string}}} input
 * @returns {string}
 */
export function composeTeamBrief(input) {
  const brief = String(input?.brief ?? '')
  const persona = input?.persona ?? { ok: false, prefix: '', suffix: '', note: '（没有人格记录）' }
  const out = []
  if (persona.ok === true) {
    out.push('# 你的角色（固定提示词）', persona.prefix, '', '---', '')
  } else {
    // 降级**必须看得见**：人格没带上时，正文里明说，别让读的人以为它是普通会话。
    out.push(
      '# 你的角色（固定提示词未能带上）',
      `★ 本次派活**没能把角色固定提示词拼进正文**：${String(persona.note ?? '原因未知')}`,
      '  原因：官方 `spawnTeammate` 没有 agentPreset 参数，team 通道只能把人格写进正文 —— 写不进去就等于**没带上**。',
      '  请以下面的派活单与 `pipeline_status` 为准，不要按别的角色的职责行事。',
      '',
      '---',
      '',
    )
  }
  out.push(brief)
  if (persona.ok === true && persona.suffix.length > 0) out.push('', persona.suffix)
  return out.join('\n')
}
