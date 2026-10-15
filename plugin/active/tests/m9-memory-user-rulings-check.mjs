/**
 * m9 · 记忆 · **跨项目"用户裁定"库**（E4）：幂等 / 不覆盖外来文件 / 写前备份 / 只在有用例时写
 * ============================================================================
 * 两种跑法（**同一条断言路径**）：
 *   · 直接跑：`node tests/m9-memory-user-rulings-check.mjs`
 *   · 聚合跑：`node tests/run-all.mjs`
 *
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * ---------------------------------------------------------------------------
 * 本文件只测用户给的**四条硬要求** + 一条 off 语义（`CONVENTIONS.md` §3.2 一测试一文件）
 * ---------------------------------------------------------------------------
 *   ① **幂等**：同一批裁定重复发布 ⇒ 一次写盘都不发生（不是"重写一份一样的"）。
 *   ② **绝不覆盖既有 skill 文件**：同名已存在但**不是本插件写的** ⇒ 停下报告，零字节改动。
 *   ③ **写之前先备份**：目标是我们写的 ⇒ 先留一份 `SKILL.md.bak-<时刻>` 再写。
 *   ④ **只在确有用例时写**：一条裁定都没有 ⇒ **连目录都不建**。
 *   ⑤ **off ⇒ 不写盘**（面清单里的 `user-rulings` 那一行）。
 *
 * ★ 全部落在自造的临时目录里：**不碰真实的 `~/.dsh/skills/`**（那份是用户的）。
 *
 * @module dsh-pipeline/tests/m9-memory-user-rulings-check
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RULINGS_SURFACE,
  RULING_KIND,
  collectRulings,
  defaultSkillsRoot,
  parseSkillFile,
  publishRulings,
  publishRulingsForProject,
  rulingId,
  rulingOf,
  skillsRootCandidates,
} from '../lib/memory/user-rulings.js'
import { memoryFile } from '../lib/memory/bank.js'
import { RULINGS_BEGIN, RULINGS_MARKER, RULINGS_SKILL_NAME } from '../lib/memory/live-doc-render.js'
import { shouldFire } from '../lib/switch/gate.js'

let passed = 0
let failed = 0
const lines = []

function ok(cond, title, detail = '') {
  if (cond) {
    passed += 1
    lines.push(`  ✓ ${title}`)
  } else {
    failed += 1
    lines.push(`  ✗ ${title}`)
  }
  if (detail.length > 0) lines.push(`      ${detail}`)
}

/** 造一条 `kind:'ruling'` 的记忆（形状与 `record.js` 一致）。 */
const rulingRec = (text, at = '2026-01-01T00:00:00Z', taskId = 'T-1') => ({
  id: `ruling:${text.slice(0, 8)}`,
  at,
  kind: RULING_KIND,
  scope: 'project',
  text,
  entity: [`task:${taskId}`],
  refs: { task_id: taskId, state: '', state_label: '', paths: [], handoff: '', artifact_version: '', roles: [] },
})

const R1 = '项目记忆库 = <project_dir>/.pipeline/_memory/'
const R2 = '既有文件可改，但每处只加几行，并逐处报告'

async function main() {
  lines.push('='.repeat(78))
  lines.push('m9 · 用户裁定库（E4）：幂等 + 不覆盖外来文件 + 写前备份 + 只在有用例时写')
  lines.push('='.repeat(78))

  // ---- ① 纯函数：归一、收集、解析 -----------------------------------------
  lines.push('')
  lines.push('【① 纯函数：裁定 id 由正文算出（同物同名）、收集去重、解析既有文件】')
  ok(rulingId(R1) === rulingId(`  ${R1}  `), '★ 同一条裁定的不同写法（前后空白）⇒ **同一个 id**', rulingId(R1))
  ok(rulingId(R1) !== rulingId(R2), '★ 不同裁定 ⇒ 不同 id（不许折到一起）', `${rulingId(R1)} / ${rulingId(R2)}`)
  ok(rulingId('   ') === '' && rulingOf({ kind: 'task', text: R1 }) === null, '不是裁定 / 正文为空 ⇒ **不收**（`kind` 是唯一判据）', '')
  const collected = collectRulings([rulingRec(R1, '2026-02-02T00:00:00Z', 'T-9'), rulingRec(R2, '2026-01-01T00:00:00Z'), rulingRec(R1, '2026-01-05T00:00:00Z', 'T-3'), { kind: 'task', text: 'x' }])
  ok(collected.length === 2, '★ 同一条裁定记了两次（跨任务）⇒ **合并成一条**', JSON.stringify(collected.map((r) => r.id)))
  ok(collected.find((r) => r.id === rulingId(R1)).at === '2026-01-05T00:00:00Z', '★ 同 id 取**最早记下**的那次（确定性取舍，不看谁后到）', collected.map((r) => `${r.id}@${r.at}`).join(' '))
  ok(JSON.stringify(collectRulings([rulingRec(R2), rulingRec(R1)])) === JSON.stringify(collectRulings([rulingRec(R1), rulingRec(R2)])), '★ 收集结果与入参顺序无关（排序）', '')
  const foreign = parseSkillFile('# 某个别的插件写的 skill\n\n正文\n')
  ok(foreign.ours === false, '★ 没有本插件的 marker ⇒ `ours:false`（下面据此"停下报告"）', '')

  // ---- ② 发布：创建 / 幂等 / 备份 / 尾部保留 ------------------------------
  lines.push('')
  lines.push('【② 发布：创建一次；再发布一次**一次写盘都不发生**；改了才备份再写】')
  const skills = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m9-skills-'))
  const project = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m9-proj-'))
  try {
    const dir = join(skills, RULINGS_SKILL_NAME)
    const file = join(dir, 'SKILL.md')
    const rulings = collectRulings([rulingRec(R1), rulingRec(R2)])
    const fsCounter = countWrites()

    const first = await publishRulings({ skillsRoot: skills, rulings, fs: fsCounter.fs })
    ok(first.wrote === true && first.reason === 'CREATED' && existsSync(file), '★ 第一次：建目录 + 写文件（`CREATED`）', `path=${first.path}`)
    const text1 = readFileSync(file, 'utf8')
    ok(text1.startsWith('---\nname: ') && text1.includes('description:'), '★ 形状是合法 skill：frontmatter **第 0 字节起就是 `---`**（`dsh-skill-filesystem` 的硬要求）', text1.split('\n')[1])
    ok(text1.includes(RULINGS_SKILL_NAME) && text1.includes('当你在流水线里做决定'), '★ `description` 里**写清触发条件**（`whenToUse` 不进目录，写错位置模型就不知道要读它）', '')
    ok(text1.includes(RULINGS_MARKER) && text1.includes(RULINGS_BEGIN), '★ 文件里带"本插件生成"的凭据 + 受管区块标记', '')
    ok(text1.includes(rulingId(R1)) && text1.includes(rulingId(R2)), '★ 两条裁定都进了区块', '')

    const writesAfterFirst = fsCounter.writes
    const second = await publishRulings({ skillsRoot: skills, rulings, fs: fsCounter.fs })
    ok(
      second.wrote === false && second.reason === 'UNCHANGED' && fsCounter.writes === writesAfterFirst,
      '★★ ①**幂等**：同一批裁定再发布 ⇒ **一次写盘都没发生**（"重写一份一样的"不算幂等）',
      `reason=${second.reason}｜写盘次数 ${writesAfterFirst} → ${fsCounter.writes}`,
    )

    // 用户在区块外手写了一段 ⇒ 重建时**原样保留**。
    const handEdited = `${text1}\n## 我补充的\n- 这条是用户手写的，重建时不许吃掉\n`
    writeFileSync(file, handEdited, 'utf8')
    const third = await publishRulings({ skillsRoot: skills, rulings, fs: fsCounter.fs, now: () => new Date('2026-07-07T00:00:00Z') })
    const text3 = readFileSync(file, 'utf8')
    ok(third.wrote === false && third.reason === 'UNCHANGED', '★ 区块外的手改**不算内容变化**（受管区块没变 ⇒ 不写）', `reason=${third.reason}`)
    ok(text3.includes('这条是用户手写的，重建时不许吃掉'), '★★ 手写在**区块之外**的内容**原样保留**（"可见、可编辑"的落点）', '')

    const R3 = '不许跑 pnpm install，也不许动 profile 配置'
    const fourth = await publishRulings({ skillsRoot: skills, rulings: collectRulings([rulingRec(R1), rulingRec(R2), rulingRec(R3)]), fs: fsCounter.fs, now: () => new Date('2026-07-07T00:00:00Z') })
    const text4 = readFileSync(file, 'utf8')
    const backups = readdirSync(dir).filter((n) => n.startsWith('SKILL.md.bak-'))
    ok(fourth.wrote === true && fourth.reason === 'UPDATED' && fourth.backup.length > 0, '★ 真变了 ⇒ 写（`UPDATED`）', `reason=${fourth.reason}`)
    ok(backups.length === 1 && readFileSync(fourth.backup, 'utf8') === handEdited, '★★ ③**写之前先备份**：备份文件里是**改动前那一份**（逐字节相同）', `backup=${backups.join(',')}`)
    ok(text4.includes(rulingId(R3)) && text4.includes('这条是用户手写的'), '★ 新裁定进区块，手写段仍在（两者都不丢）', '')

    // ---- ③ 绝不覆盖外来文件 -------------------------------------------------
    lines.push('')
    lines.push('【③ 同名已存在但**不是我们写的** ⇒ 停下报告，一个字节都不动】')
    const skills2 = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m9-foreign-'))
    try {
      const dir2 = join(skills2, RULINGS_SKILL_NAME)
      const file2 = join(dir2, 'SKILL.md')
      mkdirSync(dir2, { recursive: true })
      const theirs = '---\nname: pipeline-user-rulings\ndescription: 用户自己写的一份\n---\n\n（用户的正文）\n'
      writeFileSync(file2, theirs, 'utf8')
      const r = await publishRulings({ skillsRoot: skills2, rulings, fs: countWrites().fs })
      ok(r.ok === false && r.wrote === false && r.reason === 'FOREIGN_SKILL_EXISTS', '★★ ②**绝不覆盖**：返回 `FOREIGN_SKILL_EXISTS`（停下报告）', `reason=${r.reason}`)
      ok(readFileSync(file2, 'utf8') === theirs, '★★ 那个文件**一个字节都没变**（也没有备份/临时文件留下）', `目录内容=${JSON.stringify(readdirSync(dir2))}`)
    } finally {
      rmSync(skills2, { recursive: true, force: true })
    }

    // ---- ④ 只在确有用例时写 ------------------------------------------------
    lines.push('')
    lines.push('【④ 没有用例 ⇒ 连目录都不建（不写空壳）】')
    const skills3 = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m9-empty-'))
    try {
      const r = await publishRulings({ skillsRoot: skills3, rulings: [], fs: countWrites().fs })
      ok(r.ok === true && r.wrote === false && r.reason === 'NO_RULINGS', '★ 空集合 ⇒ `NO_RULINGS`（不是错误）', `reason=${r.reason}`)
      ok(readdirSync(skills3).length === 0, '★★ ④**连目录都没建**（不写空壳）', `skillsRoot 内容=${JSON.stringify(readdirSync(skills3))}`)
      const noRoot = await publishRulings({ skillsRoot: '', rulings, fs: countWrites().fs })
      ok(noRoot.wrote === false && noRoot.reason === 'NO_SKILLS_ROOT', '★ 取不到 skills 根 ⇒ 不猜落点、不写', `reason=${noRoot.reason}`)
    } finally {
      rmSync(skills3, { recursive: true, force: true })
    }

    // ---- ⑤ off ⇒ 不写盘 + 装配期入口（真读项目记忆库）----------------------
    lines.push('')
    lines.push('【⑤ 总开关：off ⇒ 不写盘；装配期入口真读项目记忆库的裁定】')
    const skills4 = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m9-off-'))
    try {
      const off = await publishRulings({ skillsRoot: skills4, rulings, swOf: { isOn: () => false }, fs: countWrites().fs })
      ok(off.wrote === false && off.reason === 'SWITCH_OFF', '★ off ⇒ `SWITCH_OFF`（第一句就返回）', `reason=${off.reason}`)
      ok(existsSync(skills4) && readdirSync(skills4).length === 0, '★★ ⑤off ⇒ **一个字节都不写**（连目录都没有）', `内容=${JSON.stringify(readdirSync(skills4))}`)
      ok(
        shouldFire({ isOn: () => true }, RULINGS_SURFACE) === true && shouldFire({ isOn: () => false }, RULINGS_SURFACE) === false,
        `★ 面 \`${RULINGS_SURFACE}\` 在面清单里且过闸门（开 true / 关 false）`,
        `开=${shouldFire({ isOn: () => true }, RULINGS_SURFACE)} 关=${shouldFire({ isOn: () => false }, RULINGS_SURFACE)}`,
      )
      ok((await publishRulings({ skillsRoot: skills4, rulings, swOf: { isOn: () => true } })).wrote === true, '★ 同一个根、开着的开关 ⇒ 照写（证明 off 那条红不是"本来就写不进去"）', '')

      // —— 装配期入口：真读 `<project>/.pipeline/_memory/memory.jsonl` ——
      mkdirSync(join(project, '.pipeline', '_memory'), { recursive: true })
      writeFileSync(
        memoryFile(project),
        `${[rulingRec(R1), rulingRec(R1), rulingRec(R2), { ...rulingRec('这不是裁定'), kind: 'task' }].map((r) => JSON.stringify(r)).join('\n')}\n`,
        'utf8',
      )
      const skills5 = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m9-proj-'))
      try {
        const p = await publishRulingsForProject({ projectDir: project, skillsRoot: skills5 })
        const t = readFileSync(join(skills5, RULINGS_SKILL_NAME, 'SKILL.md'), 'utf8')
        ok(p.wrote === true && p.count === 2, '★ 装配期入口：从**真项目记忆库**里读出 2 条裁定（重复的折成 1 条、非裁定的不收）', `count=${p.count}`)
        ok(t.includes(rulingId(R1)) && t.includes(rulingId(R2)) && !t.includes('这不是裁定'), '★ 只有 `kind:ruling` 的进库（`kind` 是唯一判据）', '')
        const again = await publishRulingsForProject({ projectDir: project, skillsRoot: skills5 })
        ok(again.wrote === false && again.reason === 'UNCHANGED', '★★ 装配期入口也**幂等**（第二次启动不再写盘）', `reason=${again.reason}`)
      } finally {
        rmSync(skills5, { recursive: true, force: true })
      }
      const emptyProject = mkdtempSync(join(tmpdir(), 'dsh-pipeline-m9-emptyproj-'))
      try {
        const none = await publishRulingsForProject({ projectDir: emptyProject, skillsRoot: skills4 })
        ok(none.reason === 'NO_RULINGS' && none.wrote === false, '★ 记忆库里没有裁定 ⇒ `NO_RULINGS`（**装配期不写空壳**）', `reason=${none.reason}`)
      } finally {
        rmSync(emptyProject, { recursive: true, force: true })
      }
    } finally {
      rmSync(skills4, { recursive: true, force: true })
    }

    // ---- ⑥ 家目录候选（不硬编码）------------------------------------------
    lines.push('')
    lines.push('【⑥ skills 根目录的候选（与 dsh-skill-filesystem 的发现根同源）】')
    const cands = skillsRootCandidates({ DSH_SKILLS_DIR: 'X:\\s', DSH_HOME: 'X:\\h' }, '<用户目录>')
    ok(cands[0] === 'X:\\s' && cands.includes(join('X:\\h', 'skills')), '★ 显式 `DSH_SKILLS_DIR` 优先，其次 `$DSH_HOME/skills`（照 `lib/liveness.js` 同一套写法）', JSON.stringify(cands))
    ok(defaultSkillsRoot({}, '<用户目录>').endsWith(join('.dsh', 'skills')), '★ 都取不到 ⇒ `~/.dsh/skills`', defaultSkillsRoot({}, '<用户目录>'))
  } finally {
    rmSync(skills, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }

  lines.push('')
  lines.push('='.repeat(78))
  lines.push(`m9 总计：${passed}/${passed + failed} 通过`)
  lines.push('='.repeat(78))
  return { passed, total: passed + failed, text: lines.join('\n') }
}

/**
 * 文件系统缝：**真的写盘**（幂等那条判据要能看见"写没写"，所以这里给真 fs + 写次数计数）。
 * 为什么要计数：真盘上"重写一份一样的内容"看不出来（mtime 可能同毫秒）——
 * 数写次数才是"没写"的硬证据。
 */
function countWrites() {
  const box = { writes: 0, fs: null }
  box.fs = {
    readFile: async (p, enc) => readFileSync(p, enc),
    writeFile: async (p, text) => {
      box.writes += 1
      writeFileSync(p, text, 'utf8')
    },
    mkdir: async (p) => {
      mkdirSync(p, { recursive: true })
    },
  }
  return box
}

/**
 * 聚合跑入口（`tests/run-all.mjs` 登记用）。断言、计数与"直接跑"**同一条路径**，
 * 区别只有两条：不 `process.exit`、把原文收进 `text`。
 *
 * @returns {Promise<{passed:number, total:number, text:string}>}
 */
export async function runM9MemoryUserRulingsCheck() {
  passed = 0
  failed = 0
  lines.length = 0
  try {
    return await main()
  } catch (err) {
    lines.push(`\n✗ m9 运行失败（异常）：${err?.stack ?? err}`)
    return { passed, total: passed + failed + 1, text: lines.join('\n') }
  }
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('m9-memory-user-rulings-check.mjs')) {
  const r = await runM9MemoryUserRulingsCheck()
  process.stdout.write(`${r.text}\n`)
  process.exit(r.passed === r.total ? 0 : 1)
}
