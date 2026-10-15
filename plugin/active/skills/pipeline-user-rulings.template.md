---
name: pipeline-user-rulings
description: 跨项目的「用户裁定」库模板 —— 别人部署这套插件时，长出来的文件就是**这个形状**。
---

<!-- generated-by: dsh-pipeline user-rulings -->
# 用户裁定（跨项目）

> 这份文件由 `lib/memory/user-rulings.js` **幂等维护**：受管区块内按裁定 id 去重合并，
> **区块之外你写的东西原样保留**（可见、可编辑）。要加一条裁定，写在下面"我补充的"那一段里。

## 裁定

<!-- dsh-pipeline:user-rulings:begin -->
<!-- dsh-pipeline:user-rulings:end -->

## 我补充的（手写区，插件不会动这里）

- （在这里写你自己的规矩。它**不会**被重建吃掉 —— 上面那两行注释之间才是受管区块。）

---

## 这份模板是干什么的（读完可以删掉这一段）

**它是随插件发布的**：`plugin/active/skills/pipeline-user-rulings.template.md`。
运行时真正长出来的文件**不在这里**，而在你的 dsh-home 下：

```
<dsh-home>/skills/pipeline-user-rulings/SKILL.md
```

为什么模板与产物**不同路径**：`lib/memory/user-rulings.js` 有一条硬要求 ——
目标文件若存在但**没有本插件的 marker**，它会停下报告 `FOREIGN_SKILL_EXISTS`，
**一个字节都不动**。把模板直接放到那个路径上，等于让插件永远不敢写自己的产物。

### 形状（改模板时照这份对齐，否则产出会对不上）

| 位置 | 内容 | 谁写 |
|---|---|---|
| frontmatter | `name: pipeline-user-rulings` + 一行 `description` | 渲染器 |
| 第 5 行 | `<!-- generated-by: dsh-pipeline user-rulings -->`（**marker**：没有它就不是我们的文件） | 渲染器 |
| `<!-- dsh-pipeline:user-rulings:begin -->` … `:end -->` | **受管区块**：每条裁定一行 `- [R-xxxxxxxx] 正文（记于 …，来源 …）` | 渲染器（幂等合并、按 id 去重） |
| 区块之外 | 用户手写的一切 | **人**（渲染器原样保留） |

### 三条能被断言的性质

1. **marker 在** ⇒ `parseSkillFile()` 认它是我们的文件（`ours === true`）；
2. **幂等** —— 同一批裁定重复发布 ⇒ **一次写盘都不发生**；
3. **不覆盖外来文件** —— 没有 marker 的同名文件 ⇒ `FOREIGN_SKILL_EXISTS`，一个字节不动。

判据钉在 `tests/p15-user-rulings-template-check.mjs`（模板里的 marker / begin / end
**逐字取自** `lib/memory/live-doc-render.js` 的常量，漂了就红）。
