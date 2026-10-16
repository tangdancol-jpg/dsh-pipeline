# 读目录设定：安装目录与工作目录从哪来

插件与安装脚本需要知道三个目录。它们**都不写死在代码里**，统一由「读目录设定」解析，
所以换个机器、换个用户名照样能用。

| 键 | 含义 | 推导默认值 |
|---|---|---|
| `dshHome` | DSH 用户目录（安装落点；全新项目的默认父根） | `$env:DSH_HOME` → `<用户主目录>/.dsh` |
| `projectRoot` | 流水线**工作目录**（`.pipeline/` 建在它下面） | 当前目录 |
| `skillsDir` | 插件自带技能的落点 | `<dshHome>/skills` |

安装脚本（`install.ps1` §0a）与插件运行期（`plugin/active/lib/dirs.js`）读的是
**同一份判据、同一个配置文件、同一组环境变量** —— 改一处要改两处，但两边不会各推各的。

## 取值顺序

从高到低，**先命中先算**：

| 级 | 来源 | `dshHome` | `projectRoot` | `skillsDir` |
|---|---|---|---|---|
| ① | 命令行参数 / profile 配置 | `-DshHome` / `config.dshHome` | `-ProjectRoot` / `config.projectRoot` | `-SkillsDir` |
| ② | 环境变量 | `DSH_PIPELINE_DSH_HOME` | `DSH_PIPELINE_PROJECT_ROOT` | `DSH_PIPELINE_SKILLS_DIR` |
| ③ | 配置文件 | `dshHome` | `projectRoot` | `skillsDir` |
| ④ | 运行时推导 | 见上表 | 见上表 | 见上表 |

命令行/配置是**这一次**的意图，环境变量是**这台机器**的默认 —— 谁更具体谁优先。

## 配置文件

- **文件名**：`dsh-pipeline.dirs.json`
- **默认落点**：`<DSH 用户目录>/dsh-pipeline.dirs.json`
- **落点可覆盖**：环境变量 `DSH_PIPELINE_DIRS_FILE`（给了就**只认它**；相对路径按当前目录解析）
- **格式**：顶层是对象，认三个字段，多余的键忽略

```json
{
  "dshHome": "%USERPROFILE%\\.dsh",
  "projectRoot": ".",
  "skillsDir": "skills"
}
```

**相对路径按配置文件自己所在的目录解析**（不是当前目录）—— 那样整份文件连同它描述的
相对布局可以一起搬到别的机器上。

文件**不存在、读不出来、不是合法 JSON、字段类型不对**，一律**不中止**：该字段退回下一级来源，
安装脚本把原因告警出来。UTF-8 BOM 会被自动容忍。

### 找文件时的先后

`dshHome` 本身可以被配置文件覆盖，而配置文件又在 `dshHome` 下面。取舍是：
**找文件这一步只用环境变量与推导值**（`DSH_PIPELINE_DIRS_FILE` → `$env:DSH_HOME` → 用户主目录），
文件里写的 `dshHome` 只决定"目录是谁"，**不回头改变文件的位置** —— 所以怎么配都不会绕圈。

## 命令行怎么覆盖

```powershell
# 装到另一个 DSH 用户目录
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DshHome "$env:USERPROFILE\.dsh-alt"

# 把工作目录固定到某个仓库
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ProjectRoot "<path\to\your\repo>"

# 临时改一次（只影响本次进程）
$env:DSH_PIPELINE_PROJECT_ROOT = '<path\to\your\repo>'
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会打印**每一项目前取自哪一级**，例如：

```
[pipeline] 读目录设定：dsh-home = <...>（来自：运行时推导（DSH_HOME / 用户主目录））
[pipeline]             配置文件 = <...>\dsh-pipeline.dirs.json
```

`projectRoot` 只有**显式给**（①/②/③）时才会写进 `cordis.patch.yml`。
推导出来的"当前目录"**不写** —— 那等于把本机绝对路径烙进 profile 配置；
不写时插件按 session 工作目录走。

## 相关

- 装完之后的事：[install.md](install.md)
- 工作目录选得太宽会导致 shell 全挂：[sandbox-temp-root.md](sandbox-temp-root.md)
