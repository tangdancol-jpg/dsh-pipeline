# 角色预设 · 结构与生成说明（`presets/`）

本目录把 **16 个流水线角色**各做成一个 **DSH Agent 预设**。这里只放**源**与**生成器**；
DSH 真正读取的只有 `generated/pipeline-presets.patch.yml` 一个文件。

---

## 1. 预设是什么：一条 Cordis patch 行，不是文件

一个「预设」= **bundle patch 里的一条 `@deepseek-ai/dsh-agent-preset` 行**。
它由**本插件 `package.json` 的 `dsh.bundle.patch`** 引用（数组登记，与
`@deepseek-ai/dsh-web-app/package.json` 同构）。

```jsonc
"dsh": { "bundle": { "patch": ["./cordis.patch.yml",
                               "./presets/generated/pipeline-presets.patch.yml"] } }
```

> ⚠️ 它不是 `~/.dsh/profiles/<name>/cordis.patch.yml`。profile 那个文件是「按 id 定位覆盖」，
> 语义不同，不要混用。
>
> ⚠️ 改 **bundle 内**的 patch 文件（即本目录的产物）**需要重启 DSH** 才生效
> （`node_modules` 在 HMR ignored 里）；改 profile patch 则不用。

## 2. 声明行**只有**这几个字段

| 字段 | 必填 | 取值域 | 本目录的来源 |
|---|---|---|---|
| 行 `id` | ✅ | 任意唯一串 | `_index.json` 的 `rowIdPrefix` + role ⇒ `preset-pl-<role>` |
| 行 `name` | ✅ | **固定** `'@deepseek-ai/dsh-agent-preset'` | 常量 |
| `config.id` | ✅ | 稳定标识，全库唯一 | `src/<role>/meta.json` 的 `id` ⇒ `pl-<role>` |
| `config.plugins` | ✅ | 子插件行数组 | `render.js` 组装（见 §4） |
| `config.name` | — | 展示名 | `meta.json` 的 `name` ⇒ `流水线·<中文角色名>` |
| `config.description` | — | 展示说明 | `meta.json` 的 `description` |
| `config.order` | — | 列表排序 | `meta.json` 的 `order`（100 起、按 `ALL_ROLE_IDS` 顺序递增） |

**没有** `permission` / `model` / `reasoning` / `systemPrompt` 字段 —— 多写的键会被**静默丢弃**，
所以本目录把它们记在**注释块**里，而不是塞进 `config`：

- **提示词** ⇒ `config.plugins` 里的一条 **`@deepseek-ai/dsh-persona`** 行（`prefix` / `suffix`）
- **工具面** ⇒ **`config.plugins` 列表本身**

## 3. 目录

```
presets/
├── _schema.md                      ← 本文件
├── _index.json                     ← 派生索引（role → preset id → 目录）+ 生成参数
├── src/<role>/meta.json            ← config.id / name / description / order
├── src/<role>/prompt.md            ← 该角色的系统提示词（persona prefix 的主体）
├── src/<role>/tools.json           ← 该角色可见的 pipeline_* 工具（允许清单）
├── src/<role>/permission.json      ← 权限档（readonly | own-log | own-dir | workdir）
├── src/{writer,reviewer,supervisor}/{prefix,suffix}.md   ← 三个角色的首尾提示词
├── generate 产物 ↓
├── generated/pipeline-presets.patch.yml   ← **唯一被 DSH 读取的产物**
├── render.js                       ← 读 src/ + _index.json → 写 generated/
├── validate.js                     ← 交叉校验（import lib/roles.js）
└── apply.js                        ← 把 generated/ 同步到运行时安装副本（保 LF）
```

## 4. `config.plugins` 怎么拼

每个角色预设的 `config.plugins` 依次是：

1. **`persona`** —— `@deepseek-ai/dsh-persona`，`config.prefix` / `config.suffix`：
   - `prefix` = `[prefix.md?] + prompt.md`（有 `prefix.md` 的三角色，首尾提示词在最前）
   - `suffix` = `[suffix.md?]`（**只拼源文件，不追加任何运行时变量模板**：DSH 0.2.1-rc.2 的 `deployment:persona-suffix` 只注册 `provider` / `model`，`cwd` 不是合法变量，写进去会让用该预设发起的一轮直接失败）
2. **`agent-instructions`** —— 让 `AGENTS.md` 进上下文（`maxBytes: 65536`）。
3. **底座工具行**（角色无关，见下方判据）：`tool-bash` / `tool-pwsh`（`!!js` 按平台互斥）、
   `tool-fs`、`tool-fs-search`、`tool-jobs`。
4. **`pipeline`** —— 不在这里挂：`dsh-pipeline` 已由 `cordis.patch.yml` **全局挂载**，
   在预设里再挂一次 = 重复注册同一批工具。

> ⚠️ **行的 `config` 不是可选项**：宿主会用**每个插件自己的** schemastery schema 校验这一行的
> `config`；插件里标了 `.required()` 的键**缺一个，整条预设就挂不起来**（16 条一起挂，
> 因为底座行 16 个角色一致）。真机 2026-10-15 的事故就是这样：`tool-fs-search` 一行没给
> `config` ⇒ `$.sampleOverCapGlobResults missing required value` ⇒ 设置页 16 张卡片全标「加载失败」。
>
> 两条纪律：**取值逐字取自 shipped 预设**（`dsh-web-app/presets/*.patch.yml`，不自己发明）；
> **不要为了躲一个 config 就删行** —— 行是原子的（`tool-fs-search` 同时提供 `glob` 与 `grep`，
> 而 `glob` 是控制角色该看的东西，见 `lib/guard/decide.js` §3b）。
>
> 判据是**可执行的**：`validate.js` 的 ⑧（`presets/plugin-schema.js`）与
> `tests/p11-presets-check.mjs` 的 ⑦，逐行拿插件自己的 schema 校验，
> 并与 shipped 预设的 config 形状比对；找不到宿主安装 ⇒ **如实判红**，不当成通过。

### 底座工具行为什么 16 个角色一样

详见 §6「为什么不把 pipeline 工具面写进 `config.plugins`」。

## 5. `tools.json` 与 `permission.json` 是**声明面**，不是第二份判据

- `tools.json.visible` 逐字取自 **`pipeline_boundaries.tool_face.by_role.<role>.visible`**。
- `permission.json.permission` 由 **`lib/roles.js` 的 `write_class`** 映射而来
  （`readonly` / `none` ⇒ `readonly`；`own-log` ⇒ `own-log`；`own-dir` ⇒ `own-dir`；
  `workdir` ⇒ `workdir`），与守门 `writeClassOf` **同源**。

`render.js` 把它们渲染进**每个预设上方的注释块**，`p11` 测试断言**注释块与源文件逐字一致** ——
所以这两个文件是**有载荷的**（改了不同步 ⇒ 生成物过期 ⇒ 测试变红），而不是装饰。

## 6. 为什么不把 pipeline 工具面写进 `config.plugins`

因为**那样会造出第二份更粗的真源，而且它会漂移**：

- 真正的工具面判据在**守门自己**那里 —— `lib/tools.js` 用
  `deriveToolFace({ toolNames, judge: guardDecision, eventLevel })` 现算，
  白名单是**从判词里读**的（`lib/guard/decide.js`），本仓库刻意**不存第二份**（手抄必漂移，
  而漂移的坏方向是**放宽**）。
- 运行时收紧走 `agent.ctx.tools.restrict({ deny })`，**逐会话、按已绑定角色**发生一次。
  预设里再写一份名单，只可能与之**冲突或漂移**，不可能更严。
- 预设能表达的只有「挂哪些插件行」。`pipeline_*` 全部来自**同一个** `dsh-pipeline` 行，
  行是原子的 —— 预设层根本没有"只挂其中 19 个"这种粒度。

所以本目录的取舍是：**预设管身份（提示词）与底座工具行；pipeline 工具面按声明记录 +
可核对**（注释块 + `tools.json` + `p11` 往返断言），**执法仍在守门**。

> 反向的证据也在：`_schema.md` 里这条判据可执行 —— 若哪天 `dsh-pipeline` 支持了
> 逐角色工具面的声明式配置，`validate.js` 与 `p11` 的往返断言会立刻告诉你
> "声明面"与"渲染面"需要重新对齐。

## 7. 生成流程

```
node presets/render.js            # 写 generated/pipeline-presets.patch.yml
node presets/render.js --check    # 只比对，不写；过期则 exit 1（p11 用这个）
node presets/validate.js          # 交叉校验（含 import lib/roles.js 的双向集合相等）
node presets/apply.js [--dry]     # 同步到运行时安装副本（先备份、保 LF）
```

`_index.json` 是**派生索引**：`validate.js` 强制它与 `lib/roles.js` 的 `ALL_ROLE_IDS`
**双向集合相等**，不等就报错 —— 所以它**不是**角色清单的第二份真源。

## 8. 撞车

现有 5 个 shipped preset id：`standard` / `ptc` / `minimal` / `cordis` / `computer-use`。
它们记在 `_index.json` 的 `reservedPresetIds`；`validate.js` 与 `p11` 都断言
16 个 `pl-*` 与这 5 个**无交集**（`pl-` 前缀本身也保证了这一点，但仍然显式判）。

## 9. 能力追加行：`src/<role>/capability.json`（目前只有 `main`）

用户原话（2026-10-16）：「**补全主对话的能力，不能比 Computer Use 模式能力差**，
且主对话的限制应该是平常禁止读代码、写面、工具面按角色收紧等，但**必要时能向用户申请**，
主对话**能知道工具**，但是被告知**必要申请**，且**最好别碰**。」

这条要求拆成三件，落在三个不同的地方 —— 混在一起就会做成后门：

| 要求 | 落点 | 判据 |
|---|---|---|
| **能力不低于** `computer-use` | `src/main/capability.json` 的 `capabilities[].rows` | `validate.js` ⑨：CU 的行名集合 ⊖ (底座 ∪ 追加 ∪ 显式排除) = 0 |
| **能知道工具**（可见但不给） | `lib/boundaries.js` 的 `deriveToolFace`：`main.denied` 写死为 `[]` | `tests/p12-main-capability-check.mjs` |
| **必要申请 / 最好别碰** | `src/main/prefix.md` / `suffix.md`（persona）+ `pipeline_capability_request` + `lib/guard/grant.js` | `tests/p13-capability-grant-check.mjs`（未申请拒 / 申请中仍拒 / 批准后放行一次 / 用完再拒） |

### 这个文件为什么**按角色**可选，而不是把行加进 `BASE_PLUGIN_ROWS`

`BASE_PLUGIN_ROWS` 是 **16 个角色共用**的底座。把 `tool-web` / `tool-computer-use`
加进底座 = 把 15 个别的角色一起改宽 —— 那是"顺手放宽"，不是本次要的东西。
所以追加行做成**按角色可选的一份文件**：谁要谁声明，`render.js` 只给声明过的角色加行。

### 不许自己发明 config

`capability.json` 里每一条 `{id, name, config}` 都**逐字取自**范本
（`dsh-orb/cordis.patch.yml` 的 `preset-computer-use`）。判据是**可执行的**：

- 范本在本机取得到（`presets/computer-use-parity.js` 的 `findOrbPatch`）⇒ **逐字比对**；
- 取不到 ⇒ 与 `capability.json` 里那份**冻结快照**（`source.rows`，含全部 `id | name`）比对，
  并**如实登记**"未与现场范本比对" —— 拿不到范本**不等于**通过。
- 每条 `excluded[]` **必须带 `why`**：没有理由的排除就是"悄悄少一个能力"，⑨ 会红。

### 部署耦合（写在这里，不藏在注释里）

`tool-computer-use`（`dsh-orb/computer-use`）来自 **dsh-orb** 这个插件包 ——
没装 dsh-orb 的部署方，这一行会加载失败。要桌面 GUI 能力就必须有它（用户点名要的正是它）；
不想要的部署方：删掉 `capabilities` 里 `desktop-gui` 那一条，⑨ 会告诉你差哪一项。
