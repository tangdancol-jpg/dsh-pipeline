// 缺陷 ⑦ 回归：仓库 ↔ 安装副本要有一条命令能证明"一致"，同步要幂等，且永不碰备份 / 测试报告 / 运行期数据。
/**
 * dsh-pipeline · F15：安装副本同步与一致性校验
 * ============================================================================
 *     node tests/f15-install-sync-check.mjs
 *
 * 现场：DSH 加载的是 `profiles/desktop/node_modules/dsh-pipeline`，不是仓库。修完仓库重启，
 * 行为不变（旧码还在跑），差点误判"修复无效"；install.ps1 只会覆盖式拷贝、按时间戳堆 `.bak-*`，
 * 没有一致性比对，也没有幂等证明。
 *
 * 钉住（在临时目录里搭一个假仓库 + 假安装副本，不碰真 profile）：
 *   A 一致 ⇒ sync-check exit 0 且输出 "OK: N/N 一致"
 *   B 改一个字节 ⇒ 非零退出，并点名是哪个文件（changed）
 *   C 副本多一个文件 ⇒ 非零退出，标 extra；少一个 ⇒ 标 missing
 *   D 幂等：连续同步两次，第二次零拷贝、文件 mtime 不变；字节原样（保 LF）
 *   E 永不碰：`.bak*` / `*-last-run.txt` 不拷过去；副本里的 `*.jsonl` 不覆盖、不删、不报
 *   F 唯一出处：install.ps1 的复制范围来自 tools/install-items.json，不再自己抄一份
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const SYNC = join(PLUGIN, 'tools', 'sync.mjs')
const CHECK = join(PLUGIN, 'tools', 'sync-check.mjs')

function createRecorder() {
  const items = []
  return {
    items,
    add(group, name, pass, detail) {
      items.push({ group, name, pass: pass === true, detail: String(detail ?? '') })
    },
    get passed() {
      return items.filter((i) => i.pass).length
    },
    get total() {
      return items.length
    },
    text() {
      const L = ['dsh-pipeline · F15：安装副本同步与一致性校验（缺陷 ⑦）', '='.repeat(78)]
      let g = ''
      for (const it of items) {
        if (it.group !== g) {
          g = it.group
          L.push('', `【${g}】`)
        }
        L.push(`  ${it.pass ? '✓' : '✗'} ${it.name}`)
        if (it.detail.length > 0) L.push(`      ${it.detail.split('\n').join('\n      ')}`)
      }
      L.push('', '='.repeat(78), `总计：${this.passed}/${this.total} 通过`, '='.repeat(78))
      return L.join('\n')
    },
  }
}

const run = (tool, repo, installed, extra = []) => {
  const r = spawnSync(process.execPath, [tool, '--repo', repo, '--installed', installed, ...extra], { encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function put(root, rel, text) {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}

/** 假仓库：几个运行期文件 + 几样"永不该装过去"的东西。 */
function seedRepo(repo) {
  put(repo, 'index.js', "export const name = 'dsh-pipeline'\n")
  put(repo, 'lib/a.js', 'export const a = 1\n')
  put(repo, 'lib/state.js', 'export const s = 1\n')
  put(repo, 'tests/x-check.mjs', '// test\n')
  put(repo, 'package.json', '{"name":"dsh-pipeline"}\n')
  put(repo, 'cordis.patch.yml', '- insert: []\n')
  put(repo, 'tests/x-check-last-run.txt', '测试报告（产物）\n')
  put(repo, 'lib/a.js.bak-20261016', '备份\n')
  put(repo, 'lib/seed.jsonl', '{"t":"repo"}\n')
}

export async function runF15InstallSyncCheck() {
  const rec = createRecorder()
  const root = mkdtempSync(join(tmpdir(), 'dsh-pipeline-f15-'))
  const repo = join(root, 'repo')
  const inst = join(root, 'installed')
  try {
    seedRepo(repo)
    put(inst, 'wake-ledger.jsonl', '{"t":"runtime"}\n')
    put(inst, 'lib/seed.jsonl', '{"t":"installed-runtime"}\n')
    put(inst, 'cordis.patch.yml.bak-scopeanchor-20261016-202504', '手工备份\n')

    {
      const G = 'A 同步后一致'
      const s = run(SYNC, repo, inst)
      rec.add(G, '★ 首次同步 exit 0', s.code === 0, s.out)
      const c = run(CHECK, repo, inst)
      rec.add(G, '★★ sync-check exit 0 且输出 "OK: N/N 一致"', c.code === 0 && /OK: (\d+)\/\1 一致/.test(c.out), c.out)
    }

    {
      const G = 'E 永不碰：备份 / 测试报告 / 运行期数据'
      rec.add(G, '★ `*-last-run.txt` 没拷过去', !existsSync(join(inst, 'tests/x-check-last-run.txt')), '')
      rec.add(G, '★ `.bak*` 没拷过去', !existsSync(join(inst, 'lib/a.js.bak-20261016')), '')
      rec.add(G, '★ 副本里的运行期 jsonl 没被仓库那份覆盖', readFileSync(join(inst, 'lib/seed.jsonl'), 'utf8').includes('installed-runtime'), readFileSync(join(inst, 'lib/seed.jsonl'), 'utf8'))
      rec.add(G, '★ 根目录的 wake-ledger.jsonl 与手工备份原样保留', existsSync(join(inst, 'wake-ledger.jsonl')) && existsSync(join(inst, 'cordis.patch.yml.bak-scopeanchor-20261016-202504')), '')
    }

    {
      const G = 'D 幂等与字节原样'
      const f = join(inst, 'lib/a.js')
      const past = new Date(Date.now() - 3600_000)
      utimesSync(f, past, past)
      const before = statSync(f).mtimeMs
      const s2 = run(SYNC, repo, inst)
      rec.add(G, '★★ 第二次同步零拷贝、零删除', s2.code === 0 && /拷贝 0 · 删除 0/.test(s2.out), s2.out.split('\n')[0])
      rec.add(G, '★ 内容没变的文件 mtime 不变（没被重写）', statSync(f).mtimeMs === before, `${before} → ${statSync(f).mtimeMs}`)
      const bytes = readFileSync(join(inst, 'index.js'))
      rec.add(G, '★ 字节原样（LF 没被改成 CRLF）', bytes.equals(readFileSync(join(repo, 'index.js'))) && !bytes.includes(13), '')
    }

    {
      const G = 'B 改一个字节 ⇒ 非零退出并点名'
      writeFileSync(join(inst, 'lib/state.js'), 'export const s = 1\n// 多了一行\n')
      const c = run(CHECK, repo, inst)
      rec.add(G, '★★ exit 非零，且报 changed lib/state.js', c.code !== 0 && /changed\s+lib\/state\.js/.test(c.out), c.out)
      run(SYNC, repo, inst)
    }

    {
      const G = 'C 多一个 / 少一个文件'
      put(inst, 'lib/leftover.js', '// 边界残留\n')
      const c = run(CHECK, repo, inst)
      rec.add(G, '★★ 副本多一个文件 ⇒ exit 非零，标 extra', c.code !== 0 && /extra\s+lib\/leftover\.js/.test(c.out), c.out)
      rmSync(join(inst, 'lib/a.js'))
      const c2 = run(CHECK, repo, inst)
      rec.add(G, '★ 副本少一个文件 ⇒ 标 missing', c2.code !== 0 && /missing\s+lib\/a\.js/.test(c2.out), c2.out)
      const s = run(SYNC, repo, inst)
      rec.add(G, '★ 同步把残留删掉、把缺的补上，之后一致', s.code === 0 && !existsSync(join(inst, 'lib/leftover.js')) && existsSync(join(inst, 'lib/a.js')), s.out)
      put(inst, 'stray.txt', '根目录上来历不明\n')
      const c3 = run(CHECK, repo, inst)
      rec.add(G, '★ 根目录上范围外的文件也报出来', c3.code !== 0 && c3.out.includes('stray.txt'), c3.out)
      run(SYNC, repo, inst)
      rec.add(G, '★ 不加 --prune 只报不删', existsSync(join(inst, 'stray.txt')), '')
      const s3 = run(SYNC, repo, inst, ['--prune'])
      rec.add(G, '★ 加 --prune 才删，删完一致', s3.code === 0 && !existsSync(join(inst, 'stray.txt')), s3.out)
    }

    {
      const G = 'F 复制范围只有一个出处'
      const ps = readFileSync(join(PLUGIN, 'install.ps1'), 'utf8')
      rec.add(G, '★ install.ps1 从 tools/install-items.json 读复制范围', ps.includes('install-items.json'), '')
      rec.add(G, '★ install.ps1 里不再自己写死一份复制清单（$RuntimeItems 不再是字面量列表）', !/\$RuntimeItems\s*=\s*@\(\s*\n\s*'/.test(ps) && /\$RuntimeItems\s*=\s*@\(\$Items\.runtime\)/.test(ps), '')
      rec.add(G, '★ install.ps1 收尾调用 sync-check 自检', ps.includes('sync-check.mjs'), '')
    }
  } catch (err) {
    rec.add('!! 执行异常', `夹具执行中途抛出：${String(err?.message ?? err)}`, false, String(err?.stack ?? '').split('\n').slice(0, 6).join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { passed: rec.passed, total: rec.total, text: rec.text() }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  runF15InstallSyncCheck().then((r) => {
    console.log(r.text)
    process.exitCode = r.passed === r.total ? 0 : 1
  })
}
