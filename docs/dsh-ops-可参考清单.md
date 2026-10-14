# dsh-ops 可参考清单

> **对象**：`https://github.com/T-Auto/dsh-ops`，浅克隆到 `%USERPROFILE%\.dsh\dsh_orb\_ref-dsh-ops\`
> **读到的版本**：commit `***`（2026-10-14），`dsh-plugin.json` 声明 version `0.3.0`，manifestVersion `0.15`
> **顶层目录**（427 个文件，不含 `.git`）：`.github/ bin/ docs/ lib/ locale/ native/ packages/ scripts/ test/ vendor/` + `CHANGELOG.md cordis.patch.yml dsh-plugin.json LICENSE NOTICE PROVENANCE.md README.md README.en.md README.zh.md`
> **读法**：clone 成功，**结论全部来自源码**；凡只从文档得出的说法都标了"（文档声称）"。**未核实**的标"未核实"。
> **本次只读**：未安装、未运行其任何脚本、未改我们的插件、未改 `.pipeline\`。本文件是唯一产物。

## 0. 先说三件事（避免误读）

1. **它的 token 数字不可信**（见 ⑤）：README 头版写 97%/65%，但仓库里**没有任何 benchmark 脚本、数据或口径**，而且它**自己的 docs 在至少 5 处明确否认**做过模型轮次 benchmark。以"机制可信、数字不可信"来用它。
2. **它的 shell 工具不会绕过我们的守门，但它的文件工具会**（见 ④-冲突）。`ops_bash` 会被我们认得；`ops_replace` / `ops_grep` / `ops_inspect_local_file` **不在**我们守门的三个名单里，按默认配置**直接绕过**。这是本次最该记住的一条。
3. **许可干净度比预期好**：插件本体 MIT、`vendor/fastctx/` Apache-2.0、GPL-2.0 的 bash 只是"指针不转发"。但有一处它自己都说"需要单独做许可审查"（见许可章）。

---

## 1. 逐条清单

### ① shell 路由：优先 bash、必要时回退 pwsh7、不改系统 PATH / 终端指向

| # | 它是什么（文件:行 / 文档章节） | 解决什么问题 · 怎么省 token | 我们能不能参考 | 参考进来要改我们哪块 | ★ 冲突风险 | ★ 许可 |
|---|---|---|---|---|---|---|
| 1.1 | **单一解析阶梯**：`config → provisioned → bundled → 系统 PATH / well-known`，且默认 `allowSystemShellFallback:false`。`lib/shells.js:589-677`（resolveBash）、`:742-785`（resolveShells） | 把"这台机器现在能不能跑 bash、在哪个文件"收敛到**一个纯函数**里答。没有它就只能在报错后猜；有它就能在挂载期一次性判定，**把"报错-重试"的轮次提前消掉**（每省一轮 = 省一整次往返的 prompt+补全） | **能** | 我们插件目前不解析 shell，只是**假定** `bash`/`pwsh` 可用。可在 `lib/` 加一个 `shell-ladder.js`，把"这台机器上哪个 shell 真能用"变成同步可读的事实，供守门与角色卡引用 | 低。纯读、无副作用；但引入后会与宿主自己的 shell 解析**并行存在**，需要明确"谁说了算" | MIT（`lib/` 为插件本体）。见 `LICENSE:25-30` |
| 1.2 | **绝不改环境**：模块头显式承诺"no PATH writes, no profile writes, no `process.chdir`"，`process.env` 只读不写。`lib/shells.js:1-51`（模块契约）、`:102-107`（`ENV_OVERRIDES` 只有 `NO_COLOR/TERM=dumb/PAGER=cat/GIT_PAGER=cat`） | 这是"不改系统 PATH/终端指向"的**代码级证据**（README 的说法在代码里成立）。对我们是**姿态参考**：任何"装一个更好的 shell"的方案，只要改 PATH 就会污染同一台机器上的其它 profile —— 它证明了不改也能做到 | **能（作为约束照抄）** | 写成我们侧的一条硬约束：任何 shell 相关改动**禁止写 `process.env.PATH`、禁止 `process.chdir`、禁止写 profile 配置**。可加进 `lib/boundaries.js` 的边界清单与自检 | 无 | MIT |
| 1.3 | **每调用注入 PATH，而不是全局改 PATH**：受限 bash 用私有 MSYS 副本时，只在该次 spawn 的 `env.PATH` 前面插目录。`lib/bash-ipc.js:64` | 让"用我们自己的 bash"与"不污染宿主"同时成立。对我们是**实现范式**：将来若我们要给子代理指定不同 shell，应当走 per-call env，而不是全局 | **能** | 同上，属约束条；若我们将来要 publish 自己的 shell 工具，照此实现 | 无 | MIT（但该副本**运行时产物**含 GPL 组件，见许可章末条） |
| 1.4 | **不写 profile 就能换 pwsh7**：挂 `loader` 的 `internal/config` 钩子，把 `pwsh-sandbox` 行的 `pwshPath` 在**运行时**改掉，`fiber.update(config, /*noSave*/ true)`；组件卸载时 `unhook()` + `refresh()` 恢复。`lib/session-pwsh.js:1-31` | 让"宿主 `pwsh` 工具跑的是随包 PowerShell 7"这件事**不落盘**。省 token 的路径是间接的：pwsh7 的报错与转义坑少于 Windows PowerShell 5.1，**报错轮次减少 = token 减少** | **部分** | 若要参考，改的是我们对 `loader`/`cordis.patch.yml` 的使用方式（我们目前只用 `cordis.patch.yml` 声明组件）。**但这是 hook 宿主的私有配置生命周期** | **中-高**。① 它 hook 的是宿主 loader 的内部事件（`internal/config`），宿主升级可能变；② 它与"任何也想改执行器配置的插件"会争用同一行 —— 我们或第三方插件若也改 `pwshPath`，两者会互相覆盖 | MIT（代码）。**但依赖宿主的非公开接口，属"未核实其长期稳定性"** |
| 1.5 | **排除 WSL 假 bash**：`%SystemRoot%\System32\bash.exe` 是 WSL 发行版启动器而不是 POSIX shell，必须排除。`lib/shells.js:470-487`、`:492-496` | 这是**真实的 Windows 坑**：一旦选中它，命令会跑到另一个 Linux 发行版里，症状是"莫名其妙找不到文件"，模型会陷入长时间瞎试 —— **这是最贵的 token 浪费形态** | **能（照抄判据）** | 若我们做任何 shell 解析，必须带上这条排除。也可作为**判据**加进守门：见到 `System32\bash.exe` 就提示风险 | 无 | MIT |
| 1.6 | **`script_path` 契约**：超过约 1KB、或含 heredoc/引号/反斜杠/非 ASCII 的多行脚本，**先写文件再传路径**；`command` 与 `script_path` 二选一。`lib/shells.js:933-942`（工具描述）、`lib/policy.js:62`（提示词）、`README.zh.md:178-186` | **这是它最有价值的一条，也最贴我们的痛点**。作者明说目的是"减少模型在工具调用 JSON 中进行多层转义的负担，降低整轮因 `MALFORMED_RESPONSE` 作废的概率"。一次 `MALFORMED_RESPONSE` 作废的是**整轮**（含此前所有上下文），是最贵的失败 | **能（强烈建议）** | ① 写进我们的角色卡/技能：给 `writer`/`tester` 的 shell 指引加这条；② 我们自己的 `install.ps1`/`rollback.ps1` 类脚本调用照此办理；③ 若我们将来暴露 shell 工具，把 `script_path` 做成**首选**参数 | **★ 高（但方向相反）**：这条恰好**打开我们守门的盲区** —— 见 ④-C3。参考它 = 必须同时给守门补上"读脚本文件内容"的能力 | MIT |
| 1.7 | **严格参数 + 明确拒绝 `run_in_background`**：未声明的键在执行前被拒，错误信息同时点出未知键与可接受键。`lib/shells.js:800-831`（assertKnownArguments）、`:812-815`（点名 `run_in_background` 这个高危误用） | 防"静默忽略了你要的语义还报成功"。它的自述很到位：宿主 `bash`/`pwsh` 真接受 `run_in_background`，模型很容易套到自己的工具上，那样一个常驻进程会**前台占满 `timeoutMs`（上限约 24.9 天）** | **能** | 我们的守门在收到无法识别的参数时，也应"点名未知键 + 列出可接受键"，而不是放过 | 无 | MIT |
| 1.8 | **渲染形状对齐宿主**：`renderBashResult` 按"stdout → `[stderr]` 段 → 中断标记 → `[exit code: N]` 最后"输出。`lib/shells.js:844-863` | 对齐宿主形状，模型不必学两套格式；`[exit code: N]` 放最后便于锚定。属"减少理解成本"的省钱法 | **能** | 我们插件若渲染命令结果，照此形状即可 | 无 | MIT |
| 1.9 | **不靠 npm `optionalDependencies` 承载载荷**（镜像会**静默跳过**平台包，退出码仍为 0）；改用 `provision-shells` 从上游 Release 取钉版资产并校验 sha256。`README.md:63-97`、`lib/shells.js:144-181`（`SHELL_UPSTREAM_PINS`）、`:546-587`（按 cause 给不同补救话术） | 省的是**排障轮次**：安装"看起来成功但缺件"会让人和模型都往错方向查。它把"为什么缺、该怎么办"编码成 `cause → remedy` 映射 | **能（作为经验）** | 我们插件目前没有二进制载荷，暂不适用；但"**按 cause 给补救话术**而不是给一句通用话术"值得抄进我们的错误文案（我们的 `lib/guard-factory.js:30` 已有类似精神） | 无 | MIT |

### ② 工具定义的"渐进式披露"：具体怎么做的

> **先给结论（重要）**：它**没有**"延迟加载 / 按需检索工具 / 子工具按需暴露"这种机制。我全仓 grep `lazy|defer|on-demand|按需|渐进|tool_search|searchTools`，`lib/` 下**只命中 1 处且无关**（`lib/config-updates.js:19` 的 "Write-back is deferred"，讲配置迁移时序）。它实际做的是**四件事**，都是"少注册、少广告、少写字"，不是"运行时懒加载"。**别把它当成 tool-search 方案的样板。**

| # | 它是什么（文件:行 / 文档章节） | 解决什么问题 · 怎么省 token | 我们能不能参考 | 参考进来要改我们哪块 | ★ 冲突风险 | ★ 许可 |
|---|---|---|---|---|---|---|
| 2.1 | **四个可独立开关的组件行**，各自可 `disabled: true`。`cordis.patch.yml:3-30`、`dsh-plugin.json:106-133`（`x-components`）。关掉的组件**不注册任何工具** | 关掉的工具连 schema 都不进 system prompt。这是"渐进式披露"的**主体**：省的是**固定声明成本**（每个请求都要付的那部分） | **能** | 我们的 `cordis.patch.yml` 目前是单行配置。若要参考，得把功能拆成可独立开关的组件行 —— 但**我们已经在用 `guardEnabled` 之类的配置开关达到类似效果**，收益有限 | 低 | MIT |
| 2.2 | **按会话权限条件注册**：只有 `policy.mode === 'danger-full-access'` 或宿主 `sandbox.confine` 可用时，才为该 agent 注册 `ops_bash`；否则不注册。`lib/session-shells.js:18-25`（`allowed(agent)`）、`:30-82`（reconcile） | 受限会话里**根本不出现**这个工具 ⇒ schema 不进 prompt。且权限变化时（`session/event: sandbox/mode`，`:108`）实时重算 —— 工具面随权限**收缩/扩张** | **能（高价值）** | 我们插件不发布 shell 工具，所以不能直接照搬；但**同一手法可用于我们的 `pipeline_*` 工具**：例如只有 `main` 会话才注册 `pipeline_close`/`pipeline_dispatch`。当前我们把所有 `pipeline_*` 都注册给所有会话，**每个子代理的 prompt 里都背着全套流水线工具的 schema** | 低。但要注意 `ctx.tools.restrict` 的继承语义（见 2.3） | MIT |
| 2.3 | **用 `restrict({deny})` 遮蔽继承来的工具**，而不是"不注册"：受限子代理继承到祖先的 bash 时，显式 deny 掉。`lib/session-shells.js:75-81`、`lib/index.js:44-59`（宿主 shell 遮蔽） | 处理"工具是从父层继承来的、我不能不注册"的情况。省的是**子代理 prompt 里那部分本不该有的 schema** | **能** | 同理可用于我们的 `pipeline_*`：给子代理 `restrict({deny:[...]})` 掉它在流水线里用不到的工具 | 低-中。`restrict` 是宿主 API，语义要与宿主的"own-layer exemption"对齐（作者在 `PROVENANCE.md:273` 引了宿主 `packages/core/tools/src/index.ts:1090-1124,1163-1206` 作为依据） | MIT |
| 2.4 | **提示词分段 + 按"实际可见工具"惰性渲染**：每个组件注册自己的 section（`x-prompt-sections`，`dsh-plugin.json:51-67`），渲染时 `interpolate:false` + `text: context => renderToolingPolicy({ published: visibleTools(ctx, context.agent)... })`；**没有任何可见工具时返回空串**。`lib/index.js:128-139`、`lib/policy.js:26-66`（`:36` 是空串早返） | **这是"不广告不存在的工具"的机制**。省 token 的地方在于：提示词里的工具清单**随会话权限/组件开关动态收缩**，而不是每个会话都带一张全集表。作者自述"absent tools never get advertised"（`lib/policy.js:26`） | **能（高价值）** | 我们的 `lib/boundaries.js` 已有"导出机器可读边界清单"的思路，但**提示词侧的动态收缩没有**。可参考：把"本次会话实际可用的 `pipeline_*` 清单"做成动态 section，而不是静态文档 | 低 | MIT |
| 2.5 | **不发布重复工具**：不再发布前台 `ops_run`；`duplicate ops_run (751 bytes) is no longer published`。`docs/schema-measurement.md:14-18`、`lib/index.js:126`、`:149`（background 只挂 `BACKGROUND_TOOLS`） | 直接删掉一份重复 schema（751 字节 ≈ 188 token，**每个请求**都省） | **能** | 检查我们自己的工具面有没有重复/近义工具 | 低。但注意其自述：排除 `ops_run` 靠的是 `mountServer` 的 `commandTools` 入参，**不是结构性排除** —— `lib/policy.js:9` 里 `SHELL_TOOLS` 仍含 `'run'`。属于"靠调用点自律"的设计 | MIT |
| 2.6 | **按宿主 prompt 装配模式门控发布**：PTC 组件只在宿主是 **PTC-only** 呈现时发布工具与提示（识别 `tools:ptc-only` section + 保留线 schema），standard/native 与 hybrid 下**既无工具也无额外提示**。`docs/native-ptc.md:63-69` | 同一插件的工具面随**会话形态**变化。省的是"用不到的模式下那整套 schema" | **部分** | 概念可借（按会话形态/角色门控），实现强绑宿主 PTC 装配细节，我们未必要跟 | 中：它显式说"不猜 `modeFor`、不靠 `run_code` 存在与否" —— 作者自己在防"猜宿主内部状态"的脆弱性 | MIT |
| 2.7 | **描述压缩**：4 个文件工具的 schema 从 **12,807 → 6,724 字节**（−47.5%），`ops_grep` 3,766→2,019、inspect 4,375→1,968。`docs/schema-measurement.md:27-32`、实现见 `lib/file/contract.js:60-65`（每条描述 1 句、约 15–25 词） | 纯固定成本削减，**可复现**（见 ⑤）。注意其提示：这是"插件新旧对比，**不是**官方宿主 vs 插件对比"（`schema-measurement.md:32`） | **能（强烈建议）** | 我们 `pipeline_*` 共 20+ 个工具，描述普遍偏长（举例：`pipeline_plan`/`pipeline_dispatch` 的参数描述很长）。**这是我们可以立刻吃到的一笔固定节省** —— 但要用真实 tokenizer 量，别用 `bytes/4` 估（见 ⑤） | 无 | MIT |

### ③ 文件工具的"输出精简"：比 DSH 原装省在哪

> 说明：0.3.0 的四个文件工具已**不是** FastCtx，而是插件自有的 Rust worker（`native/src/file.rs`），FastCtx 只留给默认关闭的 background 组件（`docs/native-ptc.md:4-5`、`README.md:112`）。所以下面前 7 条的许可证就是 **MIT**（`native/Cargo.toml:5  license = "MIT"`，`PROVENANCE.md:59` 亦称其为本仓库原创）。

| # | 它是什么（文件:行 / 文档章节） | 解决什么问题 · 怎么省 token | 我们能不能参考 | 参考进来要改我们哪块 | ★ 冲突风险 | ★ 许可 |
|---|---|---|---|---|---|---|
| 3.1 | **全维度有界**：`MAX_ENTRIES=100_000`、`MAX_DEPTH=128`、`MAX_FILE_BYTES=32MiB`；`limit ≤ 10_000`；上下文行 `≤ 32`；超限报 `OUTPUT_LIMIT` 而不是截断。`native/src/file.rs:15-17`、`:234`、`:263-264` | 把"工具输出把上下文打爆"变成**不可能**。省 token 的方式是**消灭尾部风险**：一次 `grep node_modules` 就能吃掉几万 token，而这类事故的代价还包括后续所有轮次都要背着它 | **能** | 我们没有文件工具；但**同一原则适用于我们的工具输出**：`pipeline_status(full)`、`pipeline_change_audit`、`pipeline_security_check` 都可能吐大段。应加硬上限 + 明确 `OUTPUT_LIMIT` | 无 | MIT |
| 3.2 | **统一的结果信封**：每个结果都带 `status/phase/changed/matched/skipped/failed/complete/truncated/omitted/items/total/nextOffset`。`native/src/file.rs:228-229`（`result()` 单点构造） | 让模型**自己知道看全了没有**。没有 `complete/omitted/nextOffset` 时，模型只能靠"看起来像完了"判断，于是要么漏读、要么重跑一遍 —— **重跑就是重复付一次读取的 token** | **能（强烈建议）** | 我们的 `pipeline_*` 返回体已有部分分页字段（如 `job_list status/limit/offset`），但不统一。可把"完整性 + 续页"做成**统一信封** | 无 | MIT |
| 3.3 | **输出模式让模型选投影**：`glob`: `paths`（只给裸路径串）/ `details`（`{path,bytes,modified}`）；`grep`: `files_with_matches` / `content` / `count` / `summary`。`lib/file/contract.js:20`、`:29`；`native/src/file.rs:258`、`:271` | **这是最直接的省 token 手法**：`summary` 只回 `{files, matches}` 两个计数、**零正文**；`paths` 只回裸字符串、零 metadata。模型先用最便宜的投影探路，确认有货再取正文 | **能（最高性价比）** | 可立刻用于我们：① 给 `pipeline_status` 加 `summary` 模式（只回状态+计数，不回交接物摘要）；② 给 `pipeline_security_check`、`pipeline_change_audit` 加 `paths`/`count` 模式；③ 在技能里教模型"先 summary 后 detail" | 低。唯一风险是模型不会用 —— 需在工具描述里点明"先用最省的投影" | MIT |
| 3.4 | **逐项投影而非原样倒出**：文本模式每行只出 `{path,line,text}`；glob details 出 `{path,bytes,modified}`。`native/src/file.rs:246`、`:258` | 去掉重复的路径头、去掉模型不需要的字段。省的是**每一条**的固定开销 × 条数 | **能** | 我们多数工具直接 `JSON.stringify` 整个对象。可对列表型返回做字段投影 | 无 | MIT |
| 3.5 | **够了就停**：`if matches.len() >= offset + limit { break }`。`native/src/file.rs:269` | 省的是**扫描时间**不是 token；但缩短了"等待中就以为卡死"的误判窗口 | **能** | 低优先 | 无 | MIT |
| 3.6 | **按"序列化字节"分页，且预留信封空间**：逐行累加，每加一行就把整个候选信封 `serde_json::to_vec` 量一次，`+128` 字节预留给宿主之后追加的沙箱字段；超预算就回退该行。`native/src/results.rs:171-183`；`maxBytes` 合法区间 `512..=65536`、`limit ≤ 512`、`fields ≤ 32`。`native/src/results.rs:130-146` | **按模型真正看到的字节数分页**，而不是按条数。这是"条数分页"常见事故（10 条超长行 = 一张巨页）的正解。`+128` 预留更细：它知道宿主会在结果上**再加字段** | **能（强烈建议）** | 我们若有任何"分页返回"的工具，应按字节而非条数分页，并预留信封空间 | 无 | MIT |
| 3.7 | **引用句柄 + 投影 + 分页，而不是把大批数据塞回上下文**：`ops_result put/page/release`；`page` 支持 `fields` 投影与顶层等值 `equals` 过滤，显式回 `nextOffset/total/complete/omitted`；TTL 24h。`docs/native-ptc.md:183-199`、`native/src/results.rs:19`（TTL）、`:45-129`、`:147-169` | **这条是它全部设计里最省 token 的一条**：批量操作的明细留在盘上，模型只拿一个 id；要看就**只取自己要的那几个字段**。把 O(全部行) 的上下文成本降到 O(需要的字段) | **能（高价值）** | 我们已有类似机制（`.pipeline/<task>/` 落盘 + `pipeline_status` 读摘要），但**缺 `fields` 投影**。可给 `pipeline_status`/`pipeline_change_audit` 加 `fields` 参数 | 低 | MIT |
| 3.8 | **默认跳过噪声目录**：遍历默认跳过 `symlink/junction/reparse`、隐藏项、`.git`、`.dsh-ops`、`node_modules`、`target`、`.venv`，且"跳过子项"**不算整次操作失败**。`docs/native-ptc.md:84-88` | 直接消灭最常见的巨型输出源。`node_modules` 一跳过，`grep` 的输出量常常差一个数量级 | **能（强烈建议）** | 我们的 `pipeline_security_check` 会扫工作区（`extra_paths` 落在项目根内）。应显式跳过 `node_modules`/`.git`/`target`/`.venv`/`.pipeline` 之外的构建产物，并在结果里**说明跳过了什么** | 低。注意"跳过 ≠ 安全"：若安全扫描静默跳过目录，会给出**假绿** —— 必须把跳过清单报出来（它用 `skipped` 字段做到了） | MIT |
| 3.9 | **渲染即紧凑 JSON**：`render: (_args,value) => [{type:'text', text: JSON.stringify(value)}]`；字段名短（`matched/skipped/omitted/nextOffset`）。`lib/file/contract.js:73` | 去掉人类可读的排版（对齐、空行、表头）。**排版是纯开销** | **能** | 检查我们的工具返回：是否有为了"好看"而加的对齐/emoji/空行 | 低。反作用：过度压缩会降低模型可读性，需权衡 | MIT |

### ④ 权限与沙箱对齐 —— 以及**与我们守门会不会打架**

> **先给结论**：
> **`ops_bash` 不会绕过我们的守门**（它走宿主的 `tools/pre-execute` + `ctx.tools.guard` 同一道缝，且我们的正则认得出它）。
> **但它的四个文件工具会绕过** —— `ops_replace` / `ops_grep` / `ops_inspect_local_file` **不在**我们守门的 `write`/`search`/`read` 三个默认名单里，按默认配置是**判据完全不跑**。
> 这是本次最重要的发现。

| # | 它是什么（文件:行 / 文档章节） | 解决什么问题 · 怎么省 token | 我们能不能参考 | 参考进来要改我们哪块 | ★ 冲突风险 | ★ 许可 |
|---|---|---|---|---|---|---|
| 4.1 | **每次调用重解权限**，且异步准备**之后再解一次**；模式或工作区根变了就拒绝执行。`lib/session-shells.js:39-54`（`:52-53` 是二次校验）、`docs/native-ptc.md:203-212` | 防 TOCTOU：准备沙箱期间用户改了权限选择器，命令就不能照旧跑。省的是**安全事故的代价**（远超 token） | **能** | 我们守门目前是**同步**判据（`lib/guard-factory.js:9-11` 明说只能用同步数据源）。可以借鉴"执行前二次确认"这一条，即使不能全盘异步 | 无 | MIT |
| 4.2 | **confine 失败绝不放行**：显式 `SANDBOX_UNAVAILABLE`，且自述"no unconfined fallback"；`lib/session-shells.js:46-51`、`lib/bash-ipc.js:20`、`:24`。文档承诺见 `README.zh.md:13`、`docs/native-ptc.md:207` | fail-closed 而非 fail-open。省 token 的间接路径：不会出现"以为被沙箱保护着其实裸跑"导致的事故排查 | **能（照抄姿态）** | 我们守门的"内部异常按 fail-closed 拒绝"（`lib/guard-factory.js:16,30`）已是同一姿态 —— 属**互认**，无需改 | 无 | MIT |
| 4.3 | **诚实上报执行强度**：把宿主的 `full` / `partial`（含 Windows ACL partial）如实回报，不假装是 full。`lib/session-shells.js:70`、`docs/native-ptc.md:16-17` | 防"假绿"。我们要的正是这种"部分执行就说部分" | **能** | 我们的 `pipeline_security_check` 已强调"不冒充实测"；可把"执行强度"作为字段显式回报 | 无 | MIT |
| 4.4 | **挂在同一批公开缝上**：它自己用 `ctx.on('tools/pre-execute')`、`ctx.tools.guard()`、`ctx.on('tools/execute')`、`ctx.tools.restrict()`。`lib/index.js:60-63`、`lib/workspace-preparation.js:47`、`lib/session-shells.js:72`、`:78` | 说明它**没有绕开**宿主工具层：第三方守门（我们）与它是**同一道缝上的两个守卫**，`undefined` = 弃权，可共存 | **能（作为兼容性证据）** | 无需改。但要在文档里明确这条兼容性结论 | 低 | MIT |
| 4.5 | **`ops_bash` 是普通注册工具**，走宿主 registry → 必过 `tools/pre-execute` 与 `guard`，再进工具体；没有"插件自带工具豁免"的分支。`lib/shells.js:946-951`（自述"registered through the caller's own `ctx.tools.register`, never by rewriting the shared registry"）、`lib/session-shells.js:72` | **兼容性核心证据** | —（这是结论，不是可抄的东西） | **无需改** | **无（好消息）**：我们守门的 `DEFAULT_SHELL_TOOL_PATTERN`（`lib/guard.js:77`）**不带锚点**，`'ops_bash'` 命中子串 `bash`（`lib/guard.js:448-455` 的 `new RegExp(pattern,'i').test(name)`）⇒ 会被当 shell 工具判，且 `command` 会被 `collectCommandStrings` 取到（`lib/guard.js:421`）。**前提**：该会话在守门令牌表里（`seatOf(...)===null` 则直通，非管线席位不受影响） | MIT |
| 4.6 | ⚠️ **C1：`ops_replace` 不在我们的写工具名单里** | — | — | 见下方"冲突处置" | **★ 高**。我们 `DEFAULT_WRITE_TOOLS = ['write','edit','str_replace_editor','notebook_edit','apply_patch','multi_edit']`（**`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-pipeline\lib\guard.js:68`**）**不含 `ops_replace`**。而 `lib/guard.js:752,767` 起的一整族判据（"只读角色一字节不许写"、"测试/审核不得改代码"、"writer 只能写自己分区"、"不得越出 change_scope"）全部以 `writeTools.includes(name)` 为前提 ⇒ 对 `ops_replace` **一条都不跑**。`ops_replace` 是**跨文件批量替换**，它由 **file 组件**发布，而 file 组件**默认开启**（`cordis.patch.yml:11-17`、`dsh-plugin.json:124-127`） | MIT |
| 4.7 | ⚠️ **C2：`ops_grep` / `ops_inspect_local_file` 不在我们的检索/读名单里** | — | — | **★ 高**。`DEFAULT_SEARCH_TOOLS`（`lib/guard.js:315-327`）含 `grep` 但**不含 `ops_grep`**，且匹配是**精确相等**（`lib/guard.js:1070`：`String(t).toLowerCase() === name.toLowerCase()`）⇒ `ops_grep` 不命中。`DEFAULT_READ_TOOLS`（`lib/guard.js:71`）同理不含 `ops_inspect_local_file`。后果："主对话/需求分析/计划/审核不得读代码"这类判据（`lib/guard.js:1066`，`NO_CODE_READ_ROLES`）会被这两个工具绕过 | MIT |
| 4.8 | ⚠️ **C3：`ops_bash` 的 `script_path` 是内容盲区** | — | — | **★ 中-高，且被它自己的文档放大**。我们的 `collectCommandStrings`（`lib/guard.js:412-436`）只遍历实参；`script_path` 收集到的是**一个文件名**，不是脚本内容。而 `SHELL_WRITE_RE` / `SHELL_CONTENT_SEARCH_RE` / 测试目录判据（`lib/guard.js:273-279,392-393`）全部是**内容正则** ⇒ 对 `ops_bash({script_path:"run.ps1"})` 全部失效。**它恰恰在教模型把长命令放进 `script_path`**（`lib/shells.js:936-938`、`lib/policy.js:62`、`README.zh.md:180`）⇒ 装它会把命令正文**系统性地移出**我们守门的视野 | MIT |
| 4.9 | ⚠️ **C4：`shellPolicy: deny-host-shell` 会把宿主 `pwsh`/`bash` 藏掉** | — | — | **★ 中（仅在显式开启时）**。`lib/index.js:40-64` 会 `restrict({deny})` 掉 `deniedHostTools`（默认 `[pwsh, bash, pwsh_persistent]`，`lib/config.js:34`）。默认是 `advise`（不生效），但一旦有人为"更安全"打开它，**我们整条流水线的 shell 工作方式（writer/tester 跑命令）会直接失去执行器** | MIT |
| 4.10 | **Windows ACL 预处理（有备份、只改目录自身、不递归）**：给 workspace 根目录自身加 `WRITE_OWNER`（`TakeOwnership`），**改前把 DACL 存成 JSON 备份**到 `%USERPROFILE%/.dsh/dsh-ops/acl-backups`；拒绝情况：非当前用户所有、祖先含 reparse point、显式 Deny 了 WRITE_OWNER；改动失败会**回滚**并抛错。`bin/prepare-workspace.ps1:1-53`、`lib/workspace-preparation.js:13-42` | 解决 Windows 下 workspace-write 沙箱需要 WRITE_OWNER 才能打完整性标签的前置条件。省 token 的路径：**避免"沙箱起不来"变成一串看不懂的报错** | **部分** | 我们不改 ACL，**不建议引入** | **中**。它确实**修改文件系统 ACL**（尽管有备份、只改一层、有回滚）。对我们是新增的攻击面与运维面；且它调用的是 **Windows PowerShell 5.1**（`lib/workspace-preparation.js:30`）—— 恰是它想逃离的那个 shell | MIT |
| 4.11 | **诚实边界：文件工具不在宿主文件沙箱内** | — | — | —（这是**我们该知道的负面事实**，非可抄项） | 它自己承认：`docs/manual-validation.md:71-73`"四个 FastCtx 文件工具仍是**非宿主沙箱后端**，`ops_replace` **没有 workspace confinement**…不作为不可信受限环境的安全方案"；`PROVENANCE.md:279`"file tools remain outside the host filesystem sandbox; shell-mode gating does not confine `ops_replace`"。**⇒ 装它 = 给每个角色一个不受 DSH 沙箱约束的写工具**，这使 C1 的严重性再升一级 | MIT |

**冲突处置（若要参考/安装，我们这边要改什么）**

1. **必改（两行配置，但有坑）**：把 `ops_*` 补进守门名单。注意我们的配置是**整体替换而非追加**（`lib/guard.js:752-753,1067-1069`：`length > 0 ? cfg值 : 默认值`），所以必须**把默认项一并抄上**：
   ```yaml
   guardFileTools:
     write:  ['write','edit','str_replace_editor','notebook_edit','apply_patch','multi_edit',
              'ops_replace','ops_batch']
     read:   ['read','read_image','read_file','view_file','ops_inspect_local_file']
     search: ['grep','ripgrep','rg','search','findstr','select-string','search_files',
              'search_content','code_search','codebase_search','semantic_search','ops_grep']
   ```
   （`ops_batch` 属 PTC 组件，默认关闭，但它是 copy/move/remove，**建议预防性加上**。配置键位置见我们 `README.md:2271-2279`。）
2. **建议改**：给守门的 shell 判据加"若收到脚本路径参数，则尝试读该文件内容再判"，补上 C3 盲区；或在提示词里禁止 `writer` 用 `script_path` 跑测试。
3. **建议加自检**：既然我们的守门是**按工具名清单**判的，就应有一条测试断言"守门名单覆盖当前会话实际发布的全部写/读/检索工具名" —— 这正是 `dsh-ops` 在 `test/shells.test.mjs:1161-1471` 对"补丁表达式与本模块解析一致"做的那种**漂移检查**。我们已有 `tests/review-check.mjs` 做"角色 writes 与守门逐字节对齐"，可把 `ops_*` 也纳入。

### ⑤ 97% / 65% 是怎么量出来的 —— **结论：量不出来，不信**

| # | 它是什么（文件:行 / 文档章节） | 解决什么问题 · 怎么省 token | 我们能不能参考 | 参考进来要改我们哪块 | ★ 冲突风险 | ★ 许可 |
|---|---|---|---|---|---|---|
| 5.1 | **数字的唯一出处**：`README.md:11-13`——"在**自用benchmark**中获得了 / **97% token减免**（开启ops插件的ptc专用工具 对比 windows原装标准模式）/ **65% token减免**（…对比 linux 原装ptc模式）" | — | **不能参考（数字不可采信）** | 无 | — | — |
| 5.2 | **方法在哪**：**不在**。全仓 `grep benchmark|自用|token减|saving` 只在这些地方命中：`README.md:11-13`（就是这句）、以及**5 处否认**（见 5.3）。仓库里唯一的度量脚本是 `scripts/measure-schemas.mjs`，它量的是 **schema JSON 字节**，且自己写着 `metric: '…not a tokenizer or usage-frequency count'`（`scripts/measure-schemas.mjs:33`） | — | — | — | — | — |
| 5.3 | **它自己的文档否认这个口径**（5 处，逐一给出）：① `docs/schema-measurement.md:3`"Manual measurement only; **not a tokenizer, CI, or proof of whole-task savings**"；② 同文件 `:36-37`"Actual request count, **cache pricing**, tool output and repeated history can outweigh fixed schema savings; **no percentage here predicts task-total provider tokens**"；③ `docs/native-ptc.md:288-289`"**No fixed token/time saving percentage, actual model-turn benchmark**, live Desktop upgrade … **is claimed**"；④ `docs/manual-validation.md:69`"…**不是使用频率或准确账单**"；⑤ `PROVENANCE.md:36`"**No benchmark is inferred** from these gates"、`:95`"**No** … claimed model-token/turn benchmark took place"；另 `CHANGELOG.md:99`"the **limits** of token savings" | — | — | — | — | — |
| 5.4 | **口径本身有混淆变量**：对照物是"windows 原装**标准模式**"与"linux 原装 **ptc 模式**"—— 同时变了 **操作系统 + 会话模式 + 工具面**三个变量。而且 0.3.0 **只发布 Windows x64**（`README.md:39`、`docs/native-ptc.md:9`），"linux 原装 ptc" 这条对照**在已发布产物里根本跑不了** | — | — | — | — | — |
| 5.5 | 同一段落里的"改善智力表现"（`README.md:15`）**没有任何度量定义** | — | — | — | — | — |

**⑤ 判定（直说）**：**不信**。理由按可核查性排序：
1. 无脚本、无数据、无对照设计、无重复次数、无缓存命中口径（它自己承认"cache pricing"能盖过 schema 节省）；
2. **仓库自己的文档在 5 处明确否认**做过模型轮次 benchmark 或声称任何固定节省比例；
3. 对照同时改了三个变量，且其中一个平台未发布；
4. 唯一**可复现**的量是 schema 字节（Δ = 4 个文件工具 12,807 → 6,724 字节，−47.5%；`docs/schema-measurement.md:30-31`，基线 JSON 已入库 `docs/schema-baseline.json`，`node scripts/measure-schemas.mjs docs/schema-current.json` 可复算）—— 而它明确写着这**不能**外推到任务总 token。

> 对我们的实际含义：**可以参考它的机制，但绝不能引用它的 97%/65% 去说服任何人**（包括说服我们自己）。我们要报数字就自己量：同一任务、同一模型、固定轮次、记录真实 provider token（含缓存读写），至少跑多次取分布。

---

## 2. 三条结论

### 结论一：★ 最值得参考的前三条（按"省 token 的确定性"从高到低排）

**第 1 名 · `script_path` 契约（1.6）—— 确定性最高，因为它消除的是"整轮作废"**
`lib/shells.js:933-942` + `lib/policy.js:62` + `README.zh.md:180`。一次 `MALFORMED_RESPONSE` 作废的不是一个工具调用，而是**整轮**（含此前积累的全部上下文），这是 token 消耗里最贵的一种形态，而它的成因（多层转义）在 Windows + PowerShell 场景下高频复发 —— 正好是我们的头号痛点。**参考它不需要写任何新代码**，只要改角色卡/技能里的 shell 指引。⚠️ 唯一代价：它会打开我们守门的 C3 盲区（4.8），**必须成对处理**。

**第 2 名 · 输出模式 + 投影（3.3 / 3.7）—— 确定性高，且是我们"本来就有数据、只是全倒出来"的地方**
`lib/file/contract.js:20,29`（四种 grep 输出模式、两种 glob 模式）+ `native/src/results.rs:147-169`（`fields` 投影 + `equals` 过滤）。逻辑是：**让模型先用最便宜的投影探路，确认有货再取正文**。我们的 `pipeline_status`、`pipeline_change_audit`、`pipeline_security_check` 目前都是"要么全给、要么不给"，加一个 `summary`/`count` 模式 + `fields` 参数，省下的是**每一次探路调用**的正文。这条的确定性来自它不依赖任何度量假设 —— 少回字节就是少 token。

**第 3 名 · 提示词按"实际可见工具"惰性渲染（2.4）+ 描述压缩（2.7）—— 确定性高，但收益是固定成本那一小块**
`lib/index.js:128-139` + `lib/policy.js:26-66`（无可发布工具时返回空串）+ `lib/file/contract.js:60-65`（描述压到 1 句）。它是**每个请求都要付**的固定成本，所以省下来的比例不高、但永远省。它对我们特别贴切：我们 20+ 个 `pipeline_*` 工具目前**对每个子代理都全量注册**，而子代理实际只会用到其中少数几个（如 `writer` 用不到 `pipeline_dispatch`）。用 `restrict({deny})`（2.3）+ 动态 section，可以给每个席位只留它该看到的工具面。

> 并列提名（不进前三但值得做）：**引用句柄而非内联大批数据（3.7）**——我们已有落盘机制，只差 `fields` 投影这一步。

### 结论二：★ 明确不该参考的

| 不该参考的 | 为什么 |
|---|---|
| **`PROVENANCE.md:36,95` 的 97%/65% 及其"自用 benchmark"** | 无方法、无数据、无对照；**它自己的文档 5 处否认**；对照同时改了 OS/模式/工具面三个变量，且其中一个平台未发布。**引用它会污染我们自己的可信度** |
| **`shellPolicy: deny-host-shell`（4.9）** | 会把宿主 `pwsh`/`bash` 从工具面藏掉。我们的流水线**整个执行模型建立在"有 shell 可跑"上** —— 一旦有人为"更安全"打开它，writer/tester 直接失去执行器。默认 `advise` 时无害，但这是个**埋着的开关** |
| **Windows ACL 预处理（4.10）** | 它确实**修改文件系统 ACL**（`bin/prepare-workspace.ps1:34-52`）。虽然只改目录自身、有 JSON 备份、有回滚、拒绝条件也严谨（非本人所有/祖先含 reparse point/显式 Deny），但对我们是**新增的攻击面与运维面**，换来的只是"沙箱能起来"。而且它为此调用 **Windows PowerShell 5.1**（`lib/workspace-preparation.js:30`）—— 恰是它要逃离的 shell |
| **hook 宿主 loader 私有生命周期改执行器（1.4）** | `lib/session-pwsh.js:17-21` 依赖 `internal/config` 事件与 `fiber.update(config, true)` 的 `noSave` 语义。这是宿主**非公开**接口，宿主升级即可能失效；且与"任何也想改 `pwshPath` 的插件"**互相覆盖**。我们自己的教训（本轮插件反复因宿主内部假设而修）已经够多 |
| **把它的四个文件工具当"沙箱内工具"用（4.11）** | 它自己承认 `ops_replace` **没有 workspace confinement**、文件工具是**非宿主沙箱后端**（`docs/manual-validation.md:71-73`、`PROVENANCE.md:279`）。**不装则无此风险；一旦装、又没同时改我们的守门名单（C1/C2），等于给每个角色开一个不受约束的写/读通道** |
| **把 PTC 组件当通用能力引入（2.6 / 3.7）** | 它只在**宿主 PTC-only 呈现**下发布（`docs/native-ptc.md:63-69`），而且 0.3.0 只发 Windows x64。我们多数会话不是 PTC-only ⇒ **引入也拿不到** |
| **`bash-ipc` 私有 MSYS 副本这条路（1.3）** | 运行时在 `%USERPROFILE%\.dsh` 下生成 **GPL MSYS 载荷的修改副本**，其 `README.md:48-51` 自述"默认载荷仍是 GPL 软件…**公开发布修改过的 MSYS 需要单独的许可/源码合规审查**"。**未核实**其合规闭环，不建议我们碰 |

### 结论三：★ 要装吗

**判断：不装，只参考做法。**（按你的要求，我只给判断，不替你装。）

代价对照：

- **装它的代价**：
  1. **立刻打开两个守门盲区**（C1 `ops_replace` 不受写判据管、C2 `ops_grep`/`ops_inspect_local_file` 不受读/检索判据管）—— 这两条是**默认开启**的 file 组件带来的，不装就完全没有；装了若忘了改配置，**守门的"只读角色一字节不许写""主对话不得读代码"会静默失效**。
  2. 它的 `script_path` 指引会**主动放大** C3 盲区。
  3. 它是**全平台级插件**：`restrict`、`loader` hook、ACL 改动都在**所有会话**生效，而我们的流水线只是其中一个使用者 —— 一旦与它打架，排查面从"我们的插件"扩到"两个插件的交互"。
  4. 版本/平台约束：0.3.0 仅 Windows x64、目标宿主 `0.2.0-rc.2`（`README.md:39`），与当前宿主版本的兼容性**未核实**。
- **只参考做法的代价**：
  1. 要自己写代码（但结论一的前三名里，**第 1 名零代码、第 3 名是配置+文案**，只有第 2 名要改工具实现）。
  2. 拿不到它的 Shell 载荷（bash 5.3.15 / pwsh 7.6.6）——**但这条恰恰不该由插件承担**：装一个独立 bash 意味着多一份 GPL 载荷、多一套 IPC 兼容层（见不该参考清单末条），换来的是"少几轮 PowerShell 转义报错"。**更便宜的做法是先只做结论一第 1 名（`script_path` 契约），用零成本验证收益，再决定要不要重投入。**
  3. 拿不到 Rust 文件工具的性能 —— 但我们缺的不是性能，是**输出投影**，那是设计问题不是语言问题（3.3/3.6/3.7 全部可在 JS 侧实现）。

**一句话**：它的**设计思路**值得抄（尤其是 `script_path` 契约、输出模式/投影/字节预算分页、按可见工具惰性渲染提示词）；它的**成品**不建议装，因为在我们的守门语境下，**装它带来的静默失效风险 > 它带来的省 token 收益**，而收益里最大的那一块（`script_path`）本来就是我们零成本能自己做的。

---

## 3. 许可核验（逐块）

| 块 | 许可 | 能不能抄代码 | 要不要署名 | 传染性 | 依据 |
|---|---|---|---|---|---|
| `lib/` `bin/` `scripts/` `test/` `cordis.patch.yml` `dsh-plugin.json` `docs/` | **MIT** | **能** | 要（保留版权与许可声明） | 无 | `LICENSE:1-21`、`LICENSE:25-30`、`NOTICE:14-16`、`PROVENANCE.md:285` |
| `native/`（Rust 文件工具 + bash-ipc **源码**） | **MIT** | **能** | 要 | 无 | `native/Cargo.toml:5` `license = "MIT"`；`PROVENANCE.md:59`"The independent MIT Rust core in `native/` is original dsh-ops code" |
| `vendor/fastctx/`（vendored FastCtx 源码） | **Apache-2.0** | **能** | **要**（Apache-2.0 §4 有 NOTICE 要求，作者已给出必须逐字转载的声明） | 无（Apache-2.0 非传染） | `NOTICE:17-22`、`:76-92`（须逐字转载的 FastCtx 声明）、`vendor/fastctx/LICENSE-APACHE`、`vendor/fastctx/NOTICE` |
| 整体分发 | **`MIT AND Apache-2.0`**（复合表达式） | — | — | 无 | `README.md:117`、`LICENSE:25-30`、`NOTICE:8-12`、`dsh-plugin.json:7` |
| `@dsh-ops/bash-win32-x64`（Git for Windows / PortableGit） | **GPL-2.0-only** | **这是"指针"不是"转发"**：不构成本仓库分发的一部分 | — | **不传染到 dsh-ops 本体**（作者明说"No GPL-2.0-covered component is part of this distribution"） | `NOTICE:46-59`、`PROVENANCE.md:314-319`、`:327`（标注"fetched by the user, **not redistributed here**"）、`lib/shells.js:157`（pin 里 `license: 'GPL-2.0-only'`） |
| `@dsh-ops/pwsh-win32-x64`（PowerShell） | **MIT**，同样是 pin | 同上 | — | 无 | `NOTICE:61-70`、`PROVENANCE.md:328` |
| ⚠️ `lib/bash-ipc.js` 的**运行时行为** | MIT 代码，但**运行时生成 GPL MSYS 的修改副本** | 代码可抄，**做法不建议** | — | **未核实**：作者自述"公开发布修改过的 MSYS 需要单独的许可/源码合规审查" | `native/bash-ipc/README.md:42-51`；历史遗留见 `PROVENANCE.md:255-259`"PortableGit's … includes many GPL/LGPL components; complete matching source closure/delivery has not been collected or reviewed. **Retaining upstream licenses does not attest that those obligations have been fulfilled.** No source offer is invented." |
| PDF 引擎（vendored pdfium） | 多许可（BSD 类 + 见清单） | 我们用不到 | — | 无 | `vendor/fastctx/third-party/pdfium-7763/licenses/`、`vendor/fastctx/THIRD_PARTY_LICENSES.md` |

**许可小结**：
1. **要抄代码 → 抄得动**。`lib/` 与 `native/` 都是 **MIT**，唯一义务是**署名 + 附许可声明**。**没有 GPL 等传染性许可覆盖它的原创代码**。
2. **引用 `vendor/fastctx/` → 必须带上那段逐字声明**（`NOTICE:83-92`）。我们若要抄 FastCtx 的输出精简手法，务必先确认抄的是 `native/`（MIT）还是 `vendor/fastctx/`（Apache-2.0 + NOTICE）—— **这两块许可不同**，而它 0.3.0 的四个文件工具属**前者**。
3. **GPL 那部分与我们无关**：GPL-2.0 的是 Git for Windows 载荷，且是"**pin 而非 redistribution**"——用户在自己机器上从上游下载。我们不转发它就不承担其分发义务。
4. **唯一"不确定"**：`lib/bash-ipc.js` 在运行时**生成 GPL MSYS 的修改副本**，作者自己说需要"单独的许可/源码合规审查"，并承认历史 PortableGit 载荷的**源码交付闭环未完成**。⇒ 这一块我们标注 **"不确定"**，不替它下结论，也**不建议我们走这条路**。

---

## 附：本次读到的证据边界（诚实清单）

- ✅ **读到代码**：`lib/`（16 个模块全部）、`native/src/`（file.rs / results.rs / contract.rs 等）、`native/Cargo.toml`、`bin/prepare-workspace.ps1`、`cordis.patch.yml`、`dsh-plugin.json`、`LICENSE`、`NOTICE`、`PROVENANCE.md`（部分）、`docs/`（schema-measurement / manual-validation / native-ptc 全篇）、`scripts/measure-schemas.mjs`、`test/shells.test.mjs`（部分）、`vendor/fastctx/FORK.md`（部分）。
- ⚠️ **只读了文档、没读代码**：`vendor/fastctx/` 的绝大部分实现（`grep_tool.rs` 85KB、`budget.rs` 28KB、`render_plan.rs`、`skip_report.rs`、`context_guard.rs`、`ordered_window.rs`、`read_tool/*` 等）**未逐一读**。因此本清单中 ③ 的条目**全部**来自 `native/src/`（MIT，0.3.0 实际在用的那套），**没有**一条依赖 FastCtx 的实现细节。
- ⚠️ **未核实**：`lib/ptc/*` 的完整实现（只读了文档 `docs/native-ptc.md`）、`lib/jobs.js`、`lib/runtime-pool.js`、`lib/handshake.js`、`test/` 全量、`.github/workflows/`、`packages/` 三个载荷包的 `package.json`。
- ⚠️ **未运行任何代码**：所有结论来自静态阅读；其测试、`npm run verify`、`measure-schemas.mjs` **均未执行**（遵守"只读"纪律）。因此 5.5 里"可复算"的说法指的是**脚本与基线都在库里**，不是"我算过"。
- ⚠️ **关于宿主侧**：4.5–4.9 的冲突判定，我读的是**本机实际安装的** `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-pipeline\lib\guard.js`（当前生效版本），**不是**仓库里的源码树 —— 若两者不一致，以本机为准。
