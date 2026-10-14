/**
 * 2026-10-13「重启后快修」四条缺陷的**最小可复现验证**。
 * ============================================================================
 *
 * 跑法：`node tests/quickfix-20261013-check.mjs`
 * 期望：最后一行 `总计：N/N 通过`，退出码 0。
 *
 * 为什么单独一个文件而不是并进 `run-all.mjs`：`run-all.mjs` 是**静态注册表**
 * （它自己写明"刻意不做 glob 通配"，见该文件 :493），本套只做本次四条快修的
 * 定点验证，不改变既有套件的通过率口径。
 *
 * 每一条都**用真代码**验证，不靠"读一眼源码觉得对了"：
 *   ① 哈希前置闸门「谁改的」——  调**真的** `hashGateVerdict`
 *   ② 静默窗口内仍在增长       ——  调**真的** `activityOfSamples` / `sampleSessionActivity` / `seatLiveness`
 *   ③ diagram_deliver 几何     ——  调**真的** `dsh-archigate` 求解器的 `maxViewBoxWidthFor`
 *   ④ notify_only 传话通道     ——  走**真的** `pipeline_dispatch` 工具（`callTool`）
 *
 * @module dsh-pipeline/tests/quickfix-20261013-check
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_ACTIVITY_FRESH_MS,
  DEFAULT_SILENCE_CONFIRMATIONS,
  SESSION_LOG_NAME,
  activityOfSamples,
  findSessionLog,
  sampleSessionLog,
  seatLiveness,
  sessionsRootCandidates,
} from '../lib/liveness.js'
import { hashGateVerdict } from '../lib/hashgate.js'
import { sampleSessionActivity } from '../lib/store.js'
import { callTool, createGuardFixture, disposeHarness } from './selftest-core.mjs'

const results = []
const open = []

function ok(group, what, pass, detail) {
  results.push({ group, what, pass: pass === true, detail: String(detail ?? '') })
}

function mkTmp(tag) {
  const d = mkdtempSync(join(tmpdir(), `qf-${tag}-`))
  open.push(d)
  return d
}

/** 摆一份假的会话日志：`<root>/<bucket>/<sid>/session.v4.jsonl.zstd`。 */
function plantLog(root, sid, bytes, mtimeMs) {
  const dir = join(root, 'bucket', sid)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, SESSION_LOG_NAME)
  writeFileSync(file, Buffer.alloc(bytes, 0x7a))
  if (Number.isFinite(mtimeMs)) {
    const sec = mtimeMs / 1000
    utimesSync(file, sec, sec)
  }
  return file
}

/** 临时替换若干环境变量，跑完一定还原（含"删掉"这种状态）。 */
function withEnv(patch, fn) {
  const saved = new Map()
  for (const k of Object.keys(patch)) {
    saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined)
    if (patch[k] === undefined) delete process.env[k]
    else process.env[k] = patch[k]
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

// ===========================================================================
// ① 哈希前置闸门分不清「谁改的」
//    ★★ T-20261011-56a37e 追加项 ① 已**修**（经用户显式授权的四类不变量改动）。
//    本段改成**改前/改后对照 + 反例**：同一份 audit，默认（改后）与严格模式（改前）各算一次。
//    端到端（走真 store + 真 changeAudit + 真 dev_to_test）的对照在
//    `tests/hashgate-check.mjs` 的【D 「谁改的」分账】那一组。
// ===========================================================================
{
  // 现场（T-20261012-8cdee0 的 gate:hash）：unauthorized 0、undeclared 36，
  // 其中约 26 条是**测试席跑测试**留下的 `tests/*-last-run.txt`。
  const audit = {
    added: [],
    modified: [
      { path: 'node_modules/dsh-pipeline/tests/liveness-check-last-run.txt', sha256: 'aa' },
      { path: 'node_modules/dsh-pipeline/tests/hashgate-check-last-run.txt', sha256: 'bb' },
    ],
    removed: [],
    unauthorized: [],
    counts: { added: 0, modified: 2, removed: 0 },
  }
  const manifest = [{ path: 'node_modules/dsh-pipeline/lib/tools.js' }]

  // 改前形状（严格模式 = 收回豁免 ⇒ 与改前逐字等价）
  const before = hashGateVerdict(audit, manifest, { exemptMachineArtifacts: false })
  ok(
    '① 归属',
    '★ 改前形状（严格模式重算同一份 audit）：编写席**没碰过**的测试痕迹照样被算成它的 undeclared',
    before.pass === false && before.counts.unauthorized === 0 && before.counts.undeclared === 2,
    `pass=${before.pass} unauthorized=${before.counts.unauthorized} undeclared=${before.counts.undeclared} —— ${before.summary}`,
  )

  // 改后：豁免生效 ⇒ pass 转真，且豁免逐条可见（不静默）
  const after = hashGateVerdict(audit, manifest)
  ok(
    '① 归属',
    '★★ 改后：同一条运行产物不再被算成编写席的 undeclared ⇒ **pass 转真**（豁免只对授权面内的机器产物生效）',
    after.pass === true && after.counts.undeclared === 0 && after.counts.machine_artifacts === 2,
    `pass=${after.pass} unauthorized=${after.counts.unauthorized} undeclared=${after.counts.undeclared} 机器产物=${after.counts.machine_artifacts}`,
  )
  ok(
    '① 归属',
    '★ 豁免**不静默**：被豁免的路径逐条列出（可审计，不靠 summary 措辞）',
    after.ignored_machine_artifacts.length === 2 &&
      after.ignored_machine_artifacts.every((x) => x.path.includes('-last-run.txt')),
    JSON.stringify(after.ignored_machine_artifacts.map((x) => x.path)),
  )

  // ★★ 反例（**最关键**）：授权面内的**真实改动**没申报 ⇒ 照样 pass=false
  const neg = hashGateVerdict(
    { ...audit, modified: [{ path: 'src/all/a.js', sha256: 'cc' }] },
    [{ path: 'src/all/declared.js' }],
  )
  ok(
    '① 归属',
    '★★ 反例：编写席真的改了**授权面内**的文件却没写进改动声明 ⇒ **仍然 pass=false**，undeclared 里仍然是那一条',
    neg.pass === false && neg.violations.some((x) => x.how === 'undeclared_change' && x.path === 'src/all/a.js'),
    `pass=${neg.pass} undeclared=${neg.counts.undeclared} —— 命中：${neg.violations.map((x) => `${x.how}:${x.path}`).join('、')}`,
  )

  // ★ 反例 2：越界的机器产物**吞不掉**（豁免只对"没被判越界"的路径生效）
  const esc = hashGateVerdict(
    {
      ...audit,
      modified: [{ path: 'outside/x-last-run.txt', sha256: 'ee' }],
      unauthorized: [{ path: 'outside/x-last-run.txt', how: 'modified_unauthorized' }],
    },
    [],
  )
  ok(
    '① 归属',
    '★★ 反例 2：同样叫 `*-last-run.txt` 但落在**授权面之外** ⇒ 仍然进 unauthorized、仍然 pass=false',
    esc.pass === false && esc.counts.unauthorized === 1,
    `pass=${esc.pass} unauthorized=${esc.counts.unauthorized} 机器产物豁免=${esc.counts.machine_artifacts}`,
  )

  // ★ 反例 3：名单收得很紧 —— 同一个 tests/ 下的**源码**照旧要申报
  ok(
    '① 归属',
    '★★ 反例 3：`tests/foo.mjs`（源码）**不在**豁免名单里 ⇒ 照旧 undeclared（豁免只认 `last-run.txt` / `*-last-run.txt`）',
    hashGateVerdict({ ...audit, modified: [{ path: 'tests/foo.mjs', sha256: 'ff' }] }, []).counts.undeclared === 1,
    `undeclared=${hashGateVerdict({ ...audit, modified: [{ path: 'tests/foo.mjs', sha256: 'ff' }] }, []).counts.undeclared}`,
  )
}

// ===========================================================================
// ② 「静默窗口内会话文件仍在增长」纳入活着证据
// ===========================================================================
{
  const T0 = 1_790_000_000_000

  // ②-1 现场数字（实测 563,327 → 575,960 B / 13 秒）**在同一个窗口内** ⇒ 判活。
  const act13 = activityOfSamples(
    { atMs: T0, size: 563_327, mtimeMs: T0 },
    { atMs: T0 + 13_000, size: 575_960, mtimeMs: T0 + 13_000 },
  )
  ok(
    '② 会话活动',
    '★ 现场数字：13 秒 +12,633 字节 ⇒ grew=true（窗口内，旧行为本来就对）',
    act13.grew === true && act13.delta_bytes === 12_633,
    JSON.stringify(act13),
  )

  // ②-2 ★ 本次修的那一格：**两次采样跨窗**（间隔 5 分 > 2 分窗口），
  //      但会话文件在这一段里确实长了 ⇒ 必须判活，不许再回一句"超出窗口"就当安静。
  const actWide = activityOfSamples(
    { atMs: T0, size: 563_327, mtimeMs: T0 },
    { atMs: T0 + 5 * 60_000, size: 575_960, mtimeMs: T0 + 5 * 60_000 },
  )
  ok(
    '② 会话活动',
    '★★ 快修点：两次采样**跨窗**（5 分 > 2 分），但文件在窗口内 +12,633 字节 ⇒ grew=true（改前是 grew=false ⇒ 一次判死）',
    actWide.grew === true && actWide.conclusive === true,
    JSON.stringify(actWide),
  )

  // ②-3 ★ 单样本救命判据：**没有基线**（台账里 samples 从未建立），
  //      但文件 mtime 就在刚才 ⇒ 它此刻正在被写 ⇒ 判活。
  //      （这正是本案 6 条 transition:block 的形状：evidence[].activity.sample_at 全是 null）
  const actFresh = activityOfSamples(null, { atMs: T0, size: 575_960, mtimeMs: T0 - 13_000 })
  ok(
    '② 会话活动',
    '★★ 快修点：**没有基线**但 mtime 距今 13 秒 ⇒ grew=true（单样本证据，旧行为只会说"首次采样，只建立基线"）',
    actFresh.grew === true && actFresh.known === true,
    JSON.stringify(actFresh),
  )
  ok(
    '② 会话活动',
    '★ 宽限窗是有限的：它必须**远小于**静默阈值（默认 5 分），否则等于关掉检测',
    DEFAULT_ACTIVITY_FRESH_MS === 60_000 && DEFAULT_ACTIVITY_FRESH_MS < 5 * 60_000,
    `freshMs=${DEFAULT_ACTIVITY_FRESH_MS}`,
  )

  // ②-4 反例（**不许把检测关掉**）：跨窗 + 文件**完全没动** + mtime 早已陈旧 ⇒ 照旧判死。
  const actDead = activityOfSamples(
    { atMs: T0, size: 575_960, mtimeMs: T0 },
    { atMs: T0 + 10 * 60_000, size: 575_960, mtimeMs: T0 },
  )
  ok(
    '② 会话活动',
    '★ 反例：跨窗 + 一个字节都没长 + mtime 陈旧 ⇒ grew=false 且 conclusive=true（真死席位照旧一次判死）',
    actDead.grew === false && actDead.conclusive === true,
    JSON.stringify(actDead),
  )
  // ②-4b 反例：同一窗口内测到没长 ⇒ 照旧判死（in-window 语义一个字没动）。
  const actQuiet = activityOfSamples(
    { atMs: T0, size: 1000, mtimeMs: T0 },
    { atMs: T0 + 30_000, size: 1100, mtimeMs: T0 + 1 },
  )
  ok(
    '② 会话活动',
    '★ 反例：同窗内只长了 100 字节（< 1024 阈值）⇒ grew=false（既有断言不回退）',
    actQuiet.grew === false,
    JSON.stringify(actQuiet),
  )

  // ②-5 根目录候选：**清空两个环境变量**也必须还能解析出候选（本案根因就是 root===null）。
  const cands = withEnv({ DSH_SESSIONS_DIR: undefined, DSH_HOME: undefined, DSH_PROFILE_DIR: undefined }, () =>
    sessionsRootCandidates(process.env, 'C:/fake/home'),
  )
  ok(
    '② 会话根',
    '★★ 快修点：DSH_SESSIONS_DIR / DSH_HOME / DSH_PROFILE_DIR 全清空 ⇒ 仍解析出 ~/.dsh/sessions 候选（改前 root===null）',
    cands.length === 1 && cands[0].replace(/\\/g, '/') === 'C:/fake/home/.dsh/sessions',
    JSON.stringify(cands),
  )
  const candsProfile = sessionsRootCandidates({ DSH_PROFILE_DIR: 'C:/u/.dsh/profiles/desktop' }, 'C:/fake/home')
  ok(
    '② 会话根',
    '★ DSH_PROFILE_DIR 给 `<home>/profiles/<name>` 形状时，往上两级取 `<home>/sessions`',
    candsProfile.some((p) => p.replace(/\\/g, '/') === 'C:/u/.dsh/sessions'),
    JSON.stringify(candsProfile),
  )

  // ②-6 findSessionLog 认候选数组（逐个试，命中即返回）。
  const rootA = mkTmp('qf2-a')
  const rootB = mkTmp('qf2-b')
  const sidB = 'session-00000000-0000-4000-8000-000000000301'
  plantLog(rootB, sidB, 4096, Date.now())
  const hit = findSessionLog([join(rootA, 'never-created'), rootB], sidB)
  ok(
    '② 会话根',
    '★ `findSessionLog` 接受候选数组：第一个候选不存在 ⇒ 自动落到第二个并命中',
    hit !== null && hit.replace(/\\/g, '/').startsWith(rootB.replace(/\\/g, '/')),
    String(hit),
  )

  // ②-7 端到端采样：环境变量全清空 + 临时目录里摆一条日志 ⇒
  //      `sampleSessionActivity` 必须采到（samples 非空、gate_applicable true）。
  {
    const root = mkTmp('qf2-e2e')
    const sid = 'session-00000000-0000-4000-8000-000000000302'
    plantLog(root, sid, 563_327, Date.now())
    const task = {
      id: 'T-qf-2',
      dispatched: [{ role: 'writer', seat: 'writer#1', agent_id: sid, at_ms: Date.now() - 600_000 }],
    }
    const res = withEnv({ DSH_SESSIONS_DIR: root, DSH_HOME: undefined, DSH_PROFILE_DIR: undefined }, () =>
      sampleSessionActivity(task, Date.now(), undefined),
    )
    ok(
      '② 会话根',
      '★★ 端到端：摆一份真日志 ⇒ samples 非空、found=1、gate_applicable=true（这就是"采样从未成功过一次"的反面）',
      res.samples !== null && res.found === 1 && res.gate_applicable === true,
      `found=${res.found} gate_applicable=${res.gate_applicable} note=${res.note}`,
    )

    // ②-8 ★ P0-1 硬不变量：候选根全都取不到时，**不许**再硬编码 gate_applicable:false
    //      （真实形状的会话 id 在场 ⇒ 必须走确认门，一次安静不冻结）。
    const resNoRoot = withEnv({ DSH_SESSIONS_DIR: undefined, DSH_HOME: undefined, DSH_PROFILE_DIR: undefined }, () => {
      // 用一份不存在的 sid（形状仍是 session-…）—— 保证任何候选根都命中不了它。
      const t = {
        id: 'T-qf-2b',
        dispatched: [
          { role: 'writer', seat: 'writer#1', agent_id: 'session-00000000-0000-4000-8000-000000000303', at_ms: Date.now() - 600_000 },
        ],
      }
      return sampleSessionActivity(t, Date.now(), undefined)
    })
    ok(
      '② 会话根',
      '★★ 硬不变量：一个候选根都命中不了 + 台账里是真实形状会话 id ⇒ gate_applicable=true（走确认门，不再一次判死）',
      resNoRoot.gate_applicable === true && resNoRoot.samples === null,
      `gate_applicable=${resNoRoot.gate_applicable} samples=${String(resNoRoot.samples)} note=${resNoRoot.note}`,
    )
  }

  // ②-9 确认门**会关闭**：连续两次都没有可判死的证据 ⇒ 第 2 次必须冻结。
  //      （改前 `quiet_streak` 在 pending 分支被写成 0 ⇒ 永远凑不满 ⇒ 永不冻结）
  {
    const base = {
      id: 'T-qf-2c',
      state: 'developing',
      handoffs: [],
      history: [],
      context_reports: [],
      successions: [],
      dispatched: [
        { role: 'writer', seat: 'writer#1', agent_id: 'session-00000000-0000-4000-8000-000000000304', at_ms: T0 - 600_000 },
      ],
      liveness: { escalations: [], samples: {}, quiet: {} },
    }
    const first = seatLiveness(base, T0 + 600_000, { silenceMs: 300_000, activity: null, gateApplicable: true })
    const streak = first.seats[0].quiet_streak
    const second = seatLiveness(
      { ...base, liveness: { ...base.liveness, quiet: { 'writer#1': streak } } },
      T0 + 600_000,
      { silenceMs: 300_000, activity: null, gateApplicable: true },
    )
    ok(
      '② 确认门',
      '★★ 快修点：第 1 次 pending 时 `quiet_streak` 必须 +1（改前写 0 ⇒ 门永远关不上 ⇒ 静默关掉检测）',
      first.silent.length === 0 && first.pending.length === 1 && streak === 1,
      `silent=${first.silent.length} pending=${first.pending.length} quiet_streak=${streak}`,
    )
    ok(
      '② 确认门',
      `★ 第 2 次仍无证据 ⇒ 允许冻结（与既有断言一致：连续 ${DEFAULT_SILENCE_CONFIRMATIONS} 次才冻）`,
      second.silent.length === 1 && second.silent[0].key === 'writer#1',
      `silent=${second.silent.length}`,
    )
  }

  // ②-10 采样出来的样本能被 `sampleSessionLog` 正确读出 size/mtime（判据只吃这两个数）。
  {
    const root = mkTmp('qf2-sample')
    const sid = 'session-00000000-0000-4000-8000-000000000305'
    const file = plantLog(root, sid, 1234, Date.now())
    const s = sampleSessionLog(file, T0)
    ok(
      '② 会话活动',
      '★ `sampleSessionLog` 读出 size=1234（判据只吃 size/mtime，不解析内容）',
      s !== null && s.size === 1234,
      JSON.stringify(s),
    )
  }
}

// ===========================================================================
// ③ diagram_deliver 的几何判断（实现在**另一个插件** `dsh-archigate`，见报告）
// ===========================================================================
{
  let solver = null
  try {
    solver = await import('../../dsh-archigate/lib/geometry-solver.js')
  } catch {
    solver = null
  }
  if (solver === null) {
    ok('③ 几何', '（跳过）本机没有 dsh-archigate —— 这一条不是 dsh-pipeline 的代码', true, 'skipped')
  } else {
    // ③-a 复现「无解（font-below-target）」：求解器把渲染器写死的 8px 边标签字号
    //      当成投影字号天花板 ⇒ 目标 >8 一律早退。
    const bad10 = solver.maxViewBoxWidthFor({ sourceFontPx: 8, stageW: 930, targetProjectedPx: 10 })
    ok(
      '③ 几何',
      '★ 现象复现：sourceFontPx=8 / 目标 10px ⇒ ok:false（这就是「无解（font-below-target）」）',
      bad10.ok === false && bad10.maxViewBoxW === 0,
      JSON.stringify(bad10),
    )
    const bad11 = solver.maxViewBoxWidthFor({ sourceFontPx: 8, stageW: 930, targetProjectedPx: 11 })
    ok('③ 几何', '★ 同上：目标 11px ⇒ ok:false', bad11.ok === false, JSON.stringify(bad11))
    // 而工具自己的契约写着「可调范围 6~12」⇒ 8 以上的取值被自己拒掉，契约与实现不一致。
    const ok8 = solver.maxViewBoxWidthFor({ sourceFontPx: 8, stageW: 930, targetProjectedPx: 8 })
    ok(
      '③ 几何',
      '★ 目标 ≤8 时才通过 —— 与其自身契约「geometry_target_px … 可调范围 6~12」矛盾',
      ok8.ok === true,
      JSON.stringify(ok8),
    )
  }

  // ③-b 复现 `Error: g.rounds is not iterable`。
  //      对象字面量**逐字**取自 `dsh-archigate/lib/pipeline.js:1286-1292`
  //      （auto_geometry 未开启时的 geometry 段）；循环**逐字**取自
  //      `dsh-archigate/index.js:429`（`for (const r of g.rounds)`）。
  const geometryWhenNotRequested = {
    requested: false,
    note: 'auto_geometry 未开启（默认关）—— 本次交付没有走几何求解器……',
  }
  let threw = null
  try {
    for (const r of geometryWhenNotRequested.rounds) void r
  } catch (err) {
    threw = err
  }
  ok(
    '③ 几何',
    '★ 现象复现：`index.js:423` 的 `if (result.geometry)` 对「未开启」那一支也成立，而它**没有 rounds** ⇒ TypeError',
    threw !== null && String(threw.message).includes('not iterable'),
    threw === null ? '（没抛——那说明复现脚本过期了）' : String(threw.message),
  )
}

// ===========================================================================
// ④ `notify_only` 传话通道（走**真的** pipeline_dispatch 工具）
// ===========================================================================
{
  // 用既有的"走到派完编写席"夹具（`runHappyPath({stopAfter:5})`）——
  // 这样 `task.dispatched` 里**真的有一条 writer 席位**，notify_only 才有东西可投。
  const f = await createGuardFixture()
  const h = f.h
  const taskId = f.taskId
  const mainToken = f.tokens.main
  try {
    const task = h.store.peek(taskId)
    const seat = (task.dispatched ?? []).find((d) => d.role === 'writer')?.seat ?? null
    ok(
      '④ notify_only',
      '夹具：已派出的 writer 席位在台账里',
      typeof seat === 'string' && seat.length > 0,
      `seat=${String(seat)} dispatched=${(task.dispatched ?? []).length}`,
    )

    // ★ 本命：notify_only=true —— 改前**每次必崩**
    //   `ReferenceError: Cannot access 'seat' before initialization`（lib/tools.js 的暂时性死区）。
    let err = null
    let res = null
    try {
      res = await callTool(
        h,
        'pipeline_dispatch',
        {
          task_id: taskId,
          role: 'writer',
          seat,
          notify_only: true,
          note: '快修验证：主对话让这个席位回一句话。',
          role_token: mainToken,
        },
        f.agents.main,
      )
    } catch (e) {
      err = e
    }
    ok(
      '④ notify_only',
      "★★★ 本命：notify_only=true **不再抛** `Cannot access 'seat' before initialization`",
      err === null && res !== null,
      err === null ? '未抛异常' : `抛了：${String(err?.message ?? err)}`,
    )
    ok(
      '④ notify_only',
      '★ 走的是**投递分支**：返回体里有 ok + 一句说清投没投出去的 summary',
      res !== null &&
        typeof res.value?.ok === 'boolean' &&
        typeof res.value?.summary === 'string' &&
        res.value.summary.length > 0,
      res === null ? '(无返回值)' : `ok=${res.value?.ok}　${String(res.value?.summary).split('\n')[0]}`,
    )
    ok(
      '④ notify_only',
      '★ 席位键被原样带上（没有把 `undefined` 递下去当匹配键 —— 旧代码 `seat === undefined ? null : seat` 的意图）',
      res !== null && String(res.value?.seat ?? '') === seat,
      `ok=${res.value?.ok} seat=${String(res.value?.seat)}`,
    )
    ok(
      '④ notify_only',
      '★ 真的投进了**既有席位**（台账里那条 writer 的会话），不是"没反馈"也不是新建会话',
      res !== null && res.value?.ok === true && String(res.value?.agent_id ?? '').length > 0,
      `ok=${res.value?.ok} agent_id=${String(res.value?.agent_id)}`,
    )
    // 空 note 那条早退分支本来就在用 args.seat —— 它必须仍然工作（证明这块没被改坏）。
    const empty = await callTool(
      h,
      'pipeline_dispatch',
      { task_id: taskId, role: 'writer', seat, notify_only: true, note: '   ', role_token: mainToken },
      f.agents.main,
    )
    ok(
      '④ notify_only',
      '★ 回归：note 为空时照旧拒（ok:false 且不抛）—— 早退分支一个字没动',
      empty.value?.ok === false && String(empty.value?.summary).includes('note'),
      String(empty.value?.summary).split('\n')[0],
    )
    // 不带 seat（caller 省略）⇒ 归一成 null，按 role 匹配 —— 也必须不崩且能投出去。
    const noSeat = await callTool(
      h,
      'pipeline_dispatch',
      { task_id: taskId, role: 'writer', notify_only: true, note: '不带席位键再投一次。', role_token: mainToken },
      f.agents.main,
    )
    ok(
      '④ notify_only',
      '★ 省略 seat ⇒ `notifySeat` 归一成 null（不是字符串 "undefined"），按 role 匹配照样投得出去',
      noSeat.value?.ok === true && String(noSeat.value?.seat ?? '') === '',
      `ok=${noSeat.value?.ok} seat=${JSON.stringify(noSeat.value?.seat)}`,
    )
    // ★ 不改状态：notify_only 不许动任务状态。
    ok(
      '④ notify_only',
      '★ 不改状态：投完话之后任务状态纹丝不动（notify_only 的契约就是"只投递"）',
      h.store.peek(taskId).state === task.state,
      `before=${task.state} after=${h.store.peek(taskId).state}`,
    )
  } finally {
    await disposeHarness(h)
  }
}

// ===========================================================================
for (const d of open) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {
    void 0
  }
}

const byGroup = new Map()
for (const r of results) {
  if (!byGroup.has(r.group)) byGroup.set(r.group, [])
  byGroup.get(r.group).push(r)
}
let pass = 0
for (const [g, rs] of byGroup) {
  console.log(`\n== ${g} ==`)
  for (const r of rs) {
    if (r.pass) pass += 1
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.what}`)
    console.log(`      ${r.detail}`)
  }
}
console.log(`\n${'='.repeat(78)}`)
console.log(`总计：${pass}/${results.length} 通过`)
console.log('='.repeat(78))
process.exit(pass === results.length ? 0 : 1)
