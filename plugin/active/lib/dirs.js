/**
 * dsh-pipeline · 读目录设定（安装目录 / 工作目录的**唯一出处**）
 * ============================================================================
 * 本模块回答一个问题：**这个插件该去读写哪几个目录**。答案只有这一处，
 * 安装脚本（`install.ps1`）与插件运行期（`index.js`）都从这里取，
 * 所以两边**不会各推各的**。
 *
 * 它存在的理由（用户原话）：「**换个机器、换个用户名照样能用**」。
 * 换句话说：仓库里、插件里都不许出现某个人的绝对路径；机器的差异只能从
 * **运行时的环境**推导出来，并且要留一个**能覆盖**的口子。
 *
 * ---------------------------------------------------------------------------
 * 三个目录
 * ---------------------------------------------------------------------------
 *   · `dshHome`     —— DSH 用户目录（安装落点、全新项目的默认父根都在它下面）
 *   · `projectRoot` —— 流水线**工作目录**（`.pipeline/` 就建在它下面；即"读目录"）
 *   · `skillsDir`   —— 插件自带 Skill 的落点（默认 `<dshHome>/skills`）
 *
 * ---------------------------------------------------------------------------
 * 取值顺序（四条，从高到低；**别改顺序**）
 * ---------------------------------------------------------------------------
 *   ① **显式入参** —— `resolveDirs({ explicit })`
 *      插件侧来自 profile 配置（`projectRoot` / `dshHome`），
 *      安装侧来自命令行参数（`-ProjectRoot` / `-DshHome`）。
 *   ② **环境变量** —— 见 {@link DIRS_ENV}
 *   ③ **配置文件** —— 见 {@link dirsFilePath} / {@link DIRS_FILE_NAME}
 *   ④ **运行时推导** —— 见 {@link resolveDirs} 的 `derived` 段
 *
 * ★ 为什么把"显式入参"排在环境变量之前：命令行/配置是**这一次**的意图，
 *   环境变量是**这台机器**的默认。谁更具体谁优先。
 *
 * ---------------------------------------------------------------------------
 * 诚实的边界
 * ---------------------------------------------------------------------------
 *   · 配置文件**读不到、读坏了、字段类型不对**一律**不抛**，只是该字段退回
 *     下一级来源，并把原因写进返回值的 `notes` —— 一个目录设定不该让插件起不来。
 *   · 本模块**不建目录、不写盘**（纯解析 + 一次只读的 `readFileSync`）。
 *     建目录是 `project/create.js` 与 `install.ps1` 的事。
 *
 * @module dsh-pipeline/lib/dirs
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { pathKey } from './util.js'

/** 覆盖**配置文件落点**的环境变量（连文件放哪儿都能改）。 */
export const DIRS_FILE_ENV = 'DSH_PIPELINE_DIRS_FILE'

/** 配置文件名（默认落在 `<DSH 用户目录>/` 下）。 */
export const DIRS_FILE_NAME = 'dsh-pipeline.dirs.json'

/**
 * 覆盖单个目录的环境变量。
 *
 * ★ 名字刻意与既有的宿主变量（`DSH_HOME` / `DSH_PROFILE_DIR` / `DSH_SKILLS_DIR`）
 *   区分开：宿主那几个是**宿主导出的事实**，本组是**用户给的指令**。
 *   混用会让"谁说了算"变得不可判定。
 */
export const DIRS_ENV = Object.freeze({
  dshHome: 'DSH_PIPELINE_DSH_HOME',
  projectRoot: 'DSH_PIPELINE_PROJECT_ROOT',
  skillsDir: 'DSH_PIPELINE_SKILLS_DIR',
})

/** 配置文件里认的字段（多余的键**忽略**，不报错也不透传）。 */
export const DIRS_KEYS = Object.freeze(Object.keys(DIRS_ENV))

/**
 * 默认 DSH 用户目录：`<用户主目录>/.dsh`。
 *
 * ★ 主目录从 `os.homedir()` 或调用方传入的 `home` 取，**本文件里没有任何
 *   具体用户名 / 盘符的字面量** —— 这正是"换机器换个用户名照样能用"的落点。
 *
 * 与宿主导出的 `DSH_HOME` 的关系：{@link resolveDirs} 把它排在**更高**优先级，
 * 因为那是宿主亲口说的；本函数只是**宿主没说时**的兜底。
 *
 * @param {object} [env] - 环境变量表（默认 `process.env`；自测可注入）
 * @param {string} [home] - 用户主目录（默认 `os.homedir()`；自测可注入）
 * @returns {string} pathKey 形式的绝对路径
 */
export function defaultDshHome(env = process.env, home = homedir()) {
  const fromHost = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (fromHost.length > 0) return pathKey(resolve(fromHost))
  const base = typeof home === 'string' && home.trim().length > 0 ? home.trim() : '.'
  return pathKey(resolve(base, '.dsh'))
}

/**
 * 配置文件该去哪儿找。
 *
 * 顺序：`DSH_PIPELINE_DIRS_FILE`（给了就**只认它**，相对路径按当前目录解析）
 *      → `<dshHome>/dsh-pipeline.dirs.json`。
 *
 * ⚠️ 这里有个**先有鸡还是先有蛋**：`dshHome` 本身可以被配置文件覆盖，
 *    而配置文件又在 `dshHome` 下面。取舍是：**找文件这一步只用环境变量与推导值**
 *    （即宿主的 `DSH_HOME` / 用户主目录），文件里写的 `dshHome` 只影响
 *    "目录本身是谁"，**不再回头改变文件的位置**。这样无论怎么配都不会绕圈。
 *
 * @param {object} [env] - 环境变量表
 * @param {string} [home] - 用户主目录
 * @returns {string} pathKey 形式的绝对路径
 */
export function dirsFilePath(env = process.env, home = homedir()) {
  const explicit = typeof env?.[DIRS_FILE_ENV] === 'string' ? env[DIRS_FILE_ENV].trim() : ''
  if (explicit.length > 0) return pathKey(isAbsolute(explicit) ? resolve(explicit) : resolve(process.cwd(), explicit))
  return pathKey(join(defaultDshHome(env, home), DIRS_FILE_NAME))
}

/**
 * 读配置文件。**任何异常都不抛**。
 *
 * 返回值的 `ok:false` 只表示"这份文件没被采纳"，不代表出错 ——
 * 文件不存在（`exists:false`）是最常见、也最正常的一种。
 *
 * @param {string} file - 配置文件绝对路径
 * @returns {{ok:boolean, exists:boolean, values:object, note:string|null}}
 */
export function readDirsFile(file) {
  const p = String(file ?? '')
  if (p.length === 0) return { ok: false, exists: false, values: {}, note: '没有配置文件路径。' }
  if (!existsSync(p)) return { ok: false, exists: false, values: {}, note: null }
  let raw
  try {
    raw = readFileSync(p, 'utf8')
  } catch (err) {
    return { ok: false, exists: true, values: {}, note: `配置文件读不出来（${String(err?.message ?? err)}），已忽略。` }
  }
  // 宽容 UTF-8 BOM：Windows 上的编辑器很容易给它加上，而 JSON.parse 不认。
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, exists: true, values: {}, note: `配置文件不是合法 JSON（${String(err?.message ?? err)}），已忽略。` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, exists: true, values: {}, note: '配置文件顶层必须是对象 `{ "dshHome": …, "projectRoot": … }`，已忽略。' }
  }
  const values = {}
  for (const key of DIRS_KEYS) {
    const v = parsed[key]
    if (typeof v === 'string' && v.trim().length > 0) values[key] = v.trim()
  }
  return { ok: true, exists: true, values, note: null }
}

/** 内部：把相对路径按 `base` 解析成 pathKey 形式的绝对路径。 */
function asDir(value, base) {
  const s = typeof value === 'string' ? value.trim() : ''
  if (s.length === 0) return ''
  return pathKey(isAbsolute(s) ? resolve(s) : resolve(base, s))
}

/**
 * 解析三个目录。**纯函数**：只读一次配置文件，绝不建目录、绝不写盘。
 *
 * @param {object} [input]
 * @param {object} [input.explicit] - ① 显式入参（`{ dshHome?, projectRoot?, skillsDir? }`）
 * @param {object} [input.env] - 环境变量表（默认 `process.env`）
 * @param {string} [input.home] - 用户主目录（默认 `os.homedir()`）
 * @param {string} [input.cwd] - 相对路径的解析基准（默认 `process.cwd()`）
 * @param {string} [input.file] - 直接指定配置文件（默认按 {@link dirsFilePath} 找）
 * @returns {{dshHome:string, projectRoot:string, skillsDir:string, sources:object,
 *            file:string, fileExists:boolean, notes:string[]}}
 */
export function resolveDirs(input = {}) {
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  const cwd = pathKey(input.cwd ?? process.cwd())
  const explicit = input.explicit ?? {}
  const notes = []

  // ---- ④ 运行时推导（最低一级，也是每一级的兜底基准）----------------------
  const derivedDshHome = defaultDshHome(env, home)
  const derivedProjectRoot = cwd
  const derivedSkillsDir = pathKey(join(derivedDshHome, 'skills'))

  // ---- ③ 配置文件 ---------------------------------------------------------
  const file = input.file ? pathKey(input.file) : dirsFilePath(env, home)
  const read = readDirsFile(file)
  if (read.note) notes.push(read.note)

  // ★ 配置文件里的相对路径按**它自己的目录**解析（不是 cwd）—— 那样整份文件
  //   连同它描述的相对布局可以一起搬到别的机器上。
  const fileBase = pathKey(resolve(file, '..'))

  /** 逐字段按 ①→②→③→④ 走一遍，并记下最终是谁说了算。 */
  const pick = (key, derived, base) => {
    const fromExplicit = asDir(explicit[key], cwd)
    if (fromExplicit.length > 0) return { value: fromExplicit, source: 'explicit' }
    const fromEnv = asDir(env?.[DIRS_ENV[key]], cwd)
    if (fromEnv.length > 0) return { value: fromEnv, source: 'env' }
    const fromFile = asDir(read.values[key], base ?? fileBase)
    if (fromFile.length > 0) return { value: fromFile, source: 'file' }
    return { value: derived, source: 'derived' }
  }

  const dshHome = pick('dshHome', derivedDshHome)
  // ⚠️ skillsDir 的推导基准是**已经定下来的 dshHome**，不是最初那个推导值 ——
  //    否则 `dshHome` 被改掉之后 skills 还落在老地方。
  const skillsDir = pick('skillsDir', pathKey(join(dshHome.value, 'skills')))
  const projectRoot = pick('projectRoot', derivedProjectRoot)

  return {
    dshHome: dshHome.value,
    projectRoot: projectRoot.value,
    skillsDir: skillsDir.value,
    sources: { dshHome: dshHome.source, projectRoot: projectRoot.source, skillsDir: skillsDir.source },
    file,
    fileExists: read.exists,
    notes,
  }
}
