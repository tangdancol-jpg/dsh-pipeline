/**
 * dsh-pipeline · 开关回归 · **关掉的文案 = 事实**（且面清单不许与实现漂移）
 * ============================================================================
 *     node tests/switch-off-text-check.mjs
 *
 * 缺陷的**措辞侧现场**：`pipeline_switch { on: false }` 返回
 *   「守门已弃权（**任何调用都不再被本插件拦**）」
 * —— 而实际仍在拦。**文案与事实不一致本身就是缺陷的一半**，所以它要能被测。
 *
 * 本套只钉**一件事**：说给人/模型听的每一句都由 `lib/switch/gate.js` 的
 * `SWITCH_SURFACES` 生成，且与实现逐条对齐。
 *   A 清单**逐条列出**每一个不生效 / 停表的面（清单加一条，文案自动跟着变）
 *   B "关不掉"的两类如实写出来（仍然拒绝写操作 / 允许只读面，并各说清为什么）
 *   C 旧的那句假话**已经从插件里消失**
 *   D 防漂移：`lib/intercept.js` + `lib/intercept/registry.js` 的每条缝都必须过闸门
 *
 * ★ 全程密闭：只读源码 + 拼字符串，不建任务、不碰真单。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SWITCH_SURFACES, isEnabled, shouldFire } from '../lib/switch/gate.js'
import { readSwitchState } from '../lib/switch/state.js'
import { offModeCopy, offModeReport } from '../lib/switch/text.js'
import { createRecorder, renderReport, runDirect } from './switch-fixtures.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 只数**代码行**上的某个串（注释里引一句说明不算 —— 注释会跟着历史一起留在文件里）。 */
function countInCode(src, re) {
  const code = src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
  return (code.match(re) ?? []).length
}

export async function runSwitchOffTextCheck() {
  const rec = createRecorder()
  try {
    const copy = offModeCopy({ stateFile: 'X/.pipeline/switch.json' })
    const text = copy.join('\n')

    // =======================================================================
    // A. 清单驱动文案
    // =======================================================================
    const inert = SWITCH_SURFACES.filter((s) => s.off === 'inert')
    const stopped = SWITCH_SURFACES.filter((s) => s.off === 'stopped')
    rec.add(
      'A 清单驱动文案',
      '★★ 关掉的说明**逐条列出**每一个不生效 / 停表的面（清单里加一条，文案自动跟着变）',
      inert.every((s) => text.includes(s.label)) && stopped.every((s) => text.includes(s.label)),
      `缺的：${[...inert, ...stopped].filter((s) => !text.includes(s.label)).map((s) => s.id).join('、') || '(无)'}\n清单共 ${SWITCH_SURFACES.length} 条：${SWITCH_SURFACES.map((s) => `${s.id}(${s.off})`).join(' ')}`,
    )
    rec.add(
      'A 清单驱动文案',
      '★ 文案里点名"判据只有一处"（读者知道去哪儿核对，不必翻五个文件）',
      text.includes('lib/switch/gate.js') && text.includes('isEnabled()'),
      text.split('\n').find((l) => l.includes('判据只有一处')) ?? '(没找到)',
    )

    // =======================================================================
    // B. "关不掉"的两类如实写出来
    // =======================================================================
    rec.add(
      'B 关不掉的两类如实写',
      '★★ 仍然拒绝写操作 / 允许只读面，**并各说清为什么**（不是含糊的"部分功能仍可用"）',
      text.includes('仍然拒绝') && text.includes('允许照常') && text.includes('关一次就再也开不回来'),
      `仍然拒绝=${text.includes('仍然拒绝')}　允许照常=${text.includes('允许照常')}　开关端点为什么必须留=${text.includes('关一次就再也开不回来')}`,
    )
    rec.add(
      'B 关不掉的两类如实写',
      '★ 关掉状态下唯一还会被写入的文件被点名（用户能自己核对磁盘）',
      text.includes('switch.json') && text.includes('项目目录里'),
      text.split('\n').find((l) => l.includes('switch.json')) ?? '(没找到)',
    )

    // =======================================================================
    // C. 旧的那句假话已消失
    // =======================================================================
    {
      const FALSE_CLAIM = '任何调用都不再被本插件拦'
      const files = ['lib/tools/admin.js', 'lib/client.js', 'index.js']
      const left = files.flatMap((f) => [...readFileSync(join(ROOT, f), 'utf8').matchAll(new RegExp(FALSE_CLAIM, 'g'))])
      rec.add(
        'C 假话已消失',
        `★★ 旧的那句「${FALSE_CLAIM}」在插件里**一处都不剩**（它就是缺陷的措辞侧现场）`,
        left.length === 0,
        `残留：${left.length} 处（扫了 ${files.join(' / ')}）`,
      )
      const adminSrc = readFileSync(join(ROOT, 'lib/tools/admin.js'), 'utf8')
      const clientSrc = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
      rec.add(
        'C 假话已消失',
        '★★ 模型可见（工具描述）与用户可见（按钮 tooltip）都写全了"不拦什么 / 仍然拒什么"',
        adminSrc.includes('不再拦任何调用') && adminSrc.includes('写入动作仍被拒绝') &&
          clientSrc.includes('不再拦任何调用') && clientSrc.includes('写入动作仍会被拒绝'),
        `工具描述：不拦=${adminSrc.includes('不再拦任何调用')} 仍拒=${adminSrc.includes('写入动作仍被拒绝')}\n` +
          `按钮 tooltip：不拦=${clientSrc.includes('不再拦任何调用')} 仍拒=${clientSrc.includes('写入动作仍会被拒绝')}`,
      )
      rec.add(
        'C 假话已消失',
        '★ 工具返回与启动日志**同一份出处**（`lib/switch/text.js` 的 `offModeCopy` / `offModeStartupLines`）',
        adminSrc.includes("from '../switch/text.js'") && readFileSync(join(ROOT, 'index.js'), 'utf8').includes('offModeStartupLines'),
        `admin.js 引 text.js：${adminSrc.includes("from '../switch/text.js'")}　index.js 引 offModeStartupLines：${readFileSync(join(ROOT, 'index.js'), 'utf8').includes('offModeStartupLines')}`,
      )
    }

    // =======================================================================
    // D. 防漂移：每条缝都必须过闸门（按**条数**核对，不是靠读代码相信）
    // =======================================================================
    {
      const registry = readFileSync(join(ROOT, 'lib/intercept', 'registry.js'), 'utf8')
      const hooks = (registry.match(/^ {2}\{ id: 'seam-/gm) ?? []).length
      rec.add(
        'D 防漂移',
        '★★ 编排表里的每条缝都有闸门兜底（缝 ' + hooks + ' 条；挂载前问闸门 + 每条缝自带闸门）',
        hooks === 4 && registry.includes('shouldFire(deps.sw, h.id)') && registry.includes('createSeamGate'),
        `编排表里的缝：${hooks}　挂载前问闸门：${registry.includes('shouldFire(deps.sw, h.id)')}　每条缝自带闸门：${registry.includes('createSeamGate')}`,
      )
      const shells = ['lib/intercept.js', 'lib/guard/hook-pre.js', 'lib/guard/hook-prompt.js', 'lib/guard/hook-wake.js', 'lib/guard/hook-post.js']
      const raw = shells.reduce((n, f) => n + countInCode(readFileSync(join(ROOT, f), 'utf8'), /sw\.isOn\(\)/g), 0)
      rec.add(
        'D 防漂移',
        '★ 缝里**不许自己读开关**（代码行里 `sw.isOn()` 出现 0 次）—— 判据只有闸门一处',
        raw === 0,
        shells.map((f) => `${f}=${countInCode(readFileSync(join(ROOT, f), 'utf8'), /sw\.isOn\(\)/g)}`).join('　'),
      )
      rec.add(
        'D 防漂移',
        '★ 判据本身：没给开关 / `isOn` 抛错都**按开**（fail-closed，不许静默放行）；只有明确 false 才算关',
        isEnabled(null) === true &&
          isEnabled({ isOn: () => { throw new Error('boom') } }) === true &&
          isEnabled({ isOn: () => false }) === false &&
          readSwitchState(undefined).on === true &&
          readSwitchState({ isOn: () => { throw new Error('boom') } }).error === 'boom',
        `null=${isEnabled(null)}　抛错=${isEnabled({ isOn: () => { throw new Error('boom') } })}　关=${isEnabled({ isOn: () => false })}　error=${readSwitchState({ isOn: () => { throw new Error('boom') } }).error}`,
      )
      rec.add(
        'D 防漂移',
        '★ `shouldFire` 对**没登记**的缝 id 返回 false（漏登记 = 宁可不动手，不是"没登记就随便动"）',
        shouldFire({ isOn: () => true }, 'seam-does-not-exist') === false &&
          shouldFire({ isOn: () => true }, 'seam-pre-execute') === true &&
          shouldFire({ isOn: () => false }, 'seam-pre-execute') === false,
        `未登记=${shouldFire({ isOn: () => true }, 'seam-does-not-exist')}　登记且开=${shouldFire({ isOn: () => true }, 'seam-pre-execute')}　登记且关=${shouldFire({ isOn: () => false }, 'seam-pre-execute')}`,
      )
      const ids = offModeReport()
      rec.add(
        'D 防漂移',
        '★ 面清单覆盖四条缝 + 唤醒咽喉 + 两条周期机制（自测与文案读的是**同一份** `SWITCH_SURFACES`）',
        ['seam-pre-execute', 'seam-pre-step', 'seam-post-execute-wake', 'seam-post-execute-result-net', 'wake-delivery'].every((x) => ids.inert.includes(x)) &&
          ['patrol', 'orphan-rescue'].every((x) => ids.stopped.includes(x)),
        `inert=${ids.inert.join(',')}\nstopped=${ids.stopped.join(',')}\nrefuse=${ids.refuse.join(',')}　allowed=${ids.allowed.join(',')}`,
      )
    }
  } catch (err) {
    rec.add('!! 执行异常', '本套没能跑完', false, String(err?.stack ?? err).split('\n').slice(0, 8).join('\n'))
  }
  return renderReport(
    'dsh-pipeline 开关回归 · 关掉的文案 = 事实（面清单不许与实现漂移）',
    '（文案与事实不一致本身就是缺陷的一半：现场那句「任何调用都不再被本插件拦」是最直接的证据。）',
    rec,
  )
}

runDirect(runSwitchOffTextCheck, import.meta.url)
