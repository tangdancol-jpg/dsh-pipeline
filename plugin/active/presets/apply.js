/**
 * dsh-pipeline · 把生成的预设 patch 同步到**运行时安装副本**
 * ============================================================================
 *     node presets/apply.js [--dry] [--dest <目录>]
 *
 * 为什么需要它：改 **bundle 内**的 patch 文件需要重启 DSH 才生效，而"改的是仓库、
 * 生效的是安装副本"这两份**必须逐字节一致** —— 否则用户看到的行为与仓库里的源不一致，
 * 而且没人会发现。所以同步这一步要有判据，不能靠手抄。
 *
 * 三条纪律：
 *   ① **先备份**：目标文件已存在就先写成 `<file>.bak-<时间戳>`，再覆盖；
 *   ② **保 LF**：写入前统一 `\r\n → \n`（Windows 上默认 `writeFileSync` 写的是字节，
 *      但源文件若被编辑器改成 CRLF，这里必须把它拉回 LF —— 两份不能只有行尾不同）；
 *   ③ **如实报数**：新增 / 覆盖 / 未改 三个计数都打出来，"0 改动"也是一条结论。
 *
 * @module dsh-pipeline/presets/apply
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 运行时安装副本的默认落点（可用 `--dest` 覆盖 / 用 `DSH_PIPELINE_DEST` 覆盖）。
 *
 * ★ **脱敏（2026-10-16）**：改前这里写死的是**本机真实路径**
 * （`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-pipeline`）——
 * 那既泄露了机器上的用户名，又让别的部署方拿到一个**对他无意义**的默认值。
 * 现在按环境推导（`DSH_PROFILE_DIR` → `~/.dsh/profiles/desktop`），**行为在本机逐字不变**。
 */
export const DEFAULT_DEST = join(
  process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop'),
  'node_modules',
  'dsh-pipeline',
).replace(/\//g, sep)

/** 预设目录相对插件根的位置 —— 与 `package.json` 的 `dsh.bundle.patch` 第二条同源。 */
export const PRESETS_REL = 'presets'

/**
 * ★ **本次布线还改到的运行时文件**（不在 `presets/` 下，但安装副本必须一致）。
 *
 * 为什么 `apply.js` 要管它们：光把 `presets/**` 拷过去**不生效** ——
 * 安装副本的 `package.json` 里 `dsh.bundle.patch` 若还写着旧的那一行（单个
 * `./cordis.patch.yml`），那份生成的 patch 就**没有任何人引用**，整批预设是死的。
 * 判据就是「安装副本是最终态」这一条：要么一起同步，要么别声称同步过。
 *
 * ⚠️ 这里**只收本批次真正改过**的文件。把整棵树拷过去会顺手把别人未提交的改动
 *    带进运行时 —— 那是另一种"悄悄改了没授权的东西"。
 */
export const WIRING_FILES = ['package.json', 'install.ps1', 'tests/run-all.mjs', 'tests/p11-presets-check.mjs']

/** 递归列出目录下所有文件（相对路径，POSIX 分隔符）。 */
export function listFiles(root, base = root) {
  const out = []
  if (!existsSync(root)) return out
  for (const e of readdirSync(root)) {
    const p = join(root, e)
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base))
    else out.push(relative(base, p).split('\\').join('/'))
  }
  return out
}

/** 读成 LF 文本（保 LF 的唯一入口）。 */
export function readLf(p) {
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}

/** 把源同步到目标。@returns {{added:string[], updated:string[], same:string[], backups:string[]}} */
export function applyPresets(srcRoot = join(HERE, '..'), destRoot = DEFAULT_DEST, dry = false) {
  const res = { added: [], updated: [], same: [], backups: [] }
  /** 待同步清单：`presets/` 整棵树 + 本次布线的几个文件。键 = 插件根相对 POSIX 路径。 */
  const jobs = [
    ...listFiles(join(srcRoot, PRESETS_REL)).map((rel) => `${PRESETS_REL}/${rel}`),
    ...WIRING_FILES,
  ]
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const rel of jobs) {
    const from = join(srcRoot, rel)
    if (!existsSync(from)) continue
    const to = join(destRoot, rel)
    const text = readLf(from)
    if (!existsSync(to)) {
      if (!dry) {
        mkdirSync(dirname(to), { recursive: true })
        writeFileSync(to, text, 'utf8')
      }
      res.added.push(rel)
      continue
    }
    if (readLf(to) === text) {
      res.same.push(rel)
      continue
    }
    if (!dry) {
      const bak = `${to}.bak-${stamp}`
      copyFileSync(to, bak)
      res.backups.push(relative(destRoot, bak).split('\\').join('/'))
      writeFileSync(to, text, 'utf8')
    }
    res.updated.push(rel)
  }
  return res
}

/** 当前生效的安装副本里，presets/ 下有哪些文件（用于「同步后校验」）。 */
export function installedPresets(destRoot = DEFAULT_DEST) {
  return listFiles(join(destRoot, PRESETS_REL))
}

// ---------------------------------------------------------------- CLI
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(HERE, 'apply.js')
if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const dry = argv.includes('--dry')
  const i = argv.indexOf('--dest')
  const dest = i >= 0 ? resolve(argv[i + 1]) : (process.env.DSH_PIPELINE_DEST ?? DEFAULT_DEST)
  if (!existsSync(dest)) {
    console.error(`[presets] 目标不存在：${dest}`)
    process.exit(1)
  }
  const r = applyPresets(join(HERE, '..'), dest, dry)
  console.log(`[presets] → ${dest}  ${dry ? '（--dry，未写盘）' : ''}`)
  console.log(`  新增 ${r.added.length} · 覆盖 ${r.updated.length} · 未改 ${r.same.length} · 备份 ${r.backups.length}`)
  for (const f of r.added) console.log(`  + ${f}`)
  for (const f of r.updated) console.log(`  ~ ${f}`)
}
