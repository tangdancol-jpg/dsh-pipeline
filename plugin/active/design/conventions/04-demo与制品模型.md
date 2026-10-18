# DEMO 状态机 / 角色权限 / 制品快照 / 产物矩阵（设计档 · P1-7/8/10/18）

> 来源：一张 L5 单的实测反馈（内部复盘）：DEMO 闸门自相矛盾、`pipeline_demo` 角色权限与计划打架、
> 制品版本语义模糊、L5 产物矩阵不封顶。四项都需要**改机制**而不是改文案，所以先出设计档，
> 由用户拍板后再落实现。本文只写"建议怎么做 + 为什么"，不写实现代码。

## 1. P1-7：DEMO 闸门自相矛盾（先有鸡还是先有蛋）

**现场**：`pipeline_demo status` 说"闸门 `demo_confirmed` 拦着（DEMO_NOT_DELIVERED）—— 不能进待开发"，
但任务早已被 `planned` 推进到 `ready_dev`；逻辑上也不可能先满足：`round` 需要交付物 → 交付物需要编写
席位 → 编写席位需要 `ready_dev`。结果闸门只能**事后补登记**。附带：`round` 要求"挂一条人工请求"，
传一条**已答复的历史请求**也能通过（软约束可复用旧凭据）。

**建议设计**：把 DEMO 做成状态机里的**显式阶段**，而不是挂在 `ready_dev` 外面的软闸：

```
planning ──demo_started──▶ demo_building ──demo_submitted──▶ demo_review
   ▲                                                          │
   └────────────── demo_rework（否掉一轮）◀────────────────────┘
                                                              │ demo_passed
                                                              ▼
                                                          ready_dev
```

- 新增状态 `demo_building` / `demo_review`（或复用 `awaiting_human` + 子状态）；转移表加四条边；
- `demo_started` 只能由 **planner**（或 main 按计划）触发；`demo_submitted` 由交付 DEMO 的席位；
  `demo_passed`/`demo_rework` 由 **main**（用户确认后）触发；
- 闸门 `demo_confirmed` 的判据改为"存在一轮 `confirmed` 且其 human_request 晚于该轮创建"；
- `round` 的 `human_request_id` 必须是**本轮创建**、`status=answered`、且**未被消费过**（一条请求只能用一次）。

**取舍**：多两个状态会让状态机变宽，但换来"不可跳过"；比"软闸 + 事后补登记"强。

## 2. P1-8：`pipeline_demo` 角色权限与计划打架

**现场**：计划位步骤 2 要求"DEMO 前置由某两个席位各交一半"，但工具只允许 `main` 调
（memo 里能看到 planner 被拒的留痕）。计划写了、机制不允许 —— 这类矛盾应该让计划自检就发现。

**建议设计（推荐 A）**：

- **A. 拆工具**：`pipeline_demo` 保留给 main（`round` / `confirm` / `status` / `reject`）；
  新增 `pipeline_demo_submit`（交付 DEMO 内容的席位：writer / architect / diagrammer）——
  角色清单里**谁在册谁可交**，与 `pipeline_handoff` 的方向白名单同形。这样计划里写
  "两个席位各交一半"就真的可执行，且不需要把 main 的调度权和交付权混在一起。
- **B. 扩 main 工具的角色**：把 `pipeline_demo` 的白名单扩到交付角色 —— 不推荐：
  那会让"谁都能触发 DEMO 轮次"，混淆调度与交付。
- **配套**：`pipeline_plan` 自检加一条硬校验：计划里出现的 DEMO 动作若要求非 main 角色，
  必须同时给出对应的角色与交付物；否则拒收（把矛盾拦在计划这一站）。

## 3. P1-10：制品版本语义（"最后登记的那个" vs 整体交付快照）

**现场**：三个编写席位分别登记 v1/v2/v3，`status` 显示"制品 v3"，审核绑定也是 v3，
但 v3 只是 writer#3 那份产物的版本号；之后若有人登记 v4，v3 的审核 OK 是否还有效没有定义。

**建议设计**：制品 = **整体交付快照**，不是"某席位最新登记"：

- `pipeline_artifact` 登记时必填 `files: [{path, sha256}]`（或 `range`：由 baseline 对比自动算）；
  服务端计算 `snapshot_id`（内容哈希），并记 `is_complete: true`；
- 审核/测试只能绑定 `snapshot_id`（不再接受"最新版本号"）；
- `pipeline_status` 显示"当前有效快照 + 是否完整 + 各席位贡献了哪几个文件"；
- 新增 `pipeline_artifact_verify {task_id, snapshot_id}`：重算哈希，不一致即红（防"登记后又被改"）；
- 打回/重试：旧快照保留可追溯，但"当前有效快照"只认最新完整的那一个。

**迁移**：旧单没有 `files` 的登记视为 legacy（`is_complete:false`），审核仍可绑但 `status` 标"不完整"。

## 4. P1-18：产物矩阵与档位不绑定（L5 约 60% 时间是仪式性产物）

**现场**：L5 强制 10 个角色全交产物，一个 7 文件静态页被要求交架构图/发布计划/性能报告/
安全审计/文档/留档；全链路约 2.5 小时里相当一部分是仪式性产物。

**建议设计**：按档位给一张**必需产物矩阵**，允许计划声明"本次豁免"：

| 档位 | 必需产物 | 可选（可 `deferred_artifacts` 豁免） |
|---|---|---|
| L0/L1 | 交付物本体 + 自测 | 无 |
| L2 | + 测试报告 | 文档、性能 |
| L3 | + 安全审计 + 审核 OK | 架构图、发布计划 |
| L4 | + 架构图 + 发布与回滚计划 | 文档、性能 |
| L5 | + 文档 / 性能 / 安全全量 | 由计划显式声明豁免项与理由 |

- `pipeline_plan` / `pipeline_roster_review` 新增 `deferred_artifacts: [{kind, why, accepted_by}]`；
- 关单的 `role_products_delivered` 判据改为读**档位矩阵**（在册角色 ∧ 未被豁免）；
- 豁免必须写理由，且 `accepted_by` 只能是人（用户）或主管（L4+）—— 不能由计划自己豁免自己；
- `pipeline_status` 显示"还差哪些产物 / 哪些被豁免（理由 / 批准人）"。

## 5. 落地顺序与验收（建议）

1. P1-18（低风险、收益最大）：矩阵 + `deferred_artifacts` + 关单判据改造 + 测试；
2. P1-10（中风险）：快照登记/校验 + 审核绑定 + 迁移 legacy；
3. P1-7（状态机改造，影响面最大）：新增两状态 + 四条边 + 闸门重判 + 测试；
4. P1-8（依赖 7）：`pipeline_demo_submit` + plan 自检 + 测试。

**每步验收**：全量自测绿、旧单兼容（legacy 不红）、拒绝文案给下一步、无新增"静默降级"。

## 6. 待用户拍板

- [ ] DEMO 是否值得新增两个状态（P1-7），还是接受"软闸 + 强校验"（不新增状态，只加"请求必须新、必须答"）？
- [ ] P1-8 选 A（拆 `pipeline_demo_submit`）还是 B（扩 main 工具角色）？
- [ ] 制品快照（P1-10）是否要求"所有单都走快照"，还是 L3+ 才强制？
- [ ] 产物矩阵（P1-18）的档位映射是否按上表？`deferred_artifacts` 的批准人只允许用户/主管，可以吗？
