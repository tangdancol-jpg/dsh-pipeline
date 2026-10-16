# 编码与行尾约定

本仓库对文件编码有**硬性要求**：违反它不会得到风格提示，而是脚本**根本起不来**。

## `.ps1`：必须 UTF-8 **with BOM**

Windows PowerShell 5.1 读**无 BOM** 的 `.ps1` 时按系统 ANSI 代码页解码。
本仓库的脚本里都有中文，于是字符串引号会被吃掉，报出与真实原因毫不相干的
`Unexpected token ')'` / 「缺少右 }」之类的解析错误。

```powershell
# 检查（应有 EF BB BF）
$b = [System.IO.File]::ReadAllBytes('<path>\install.ps1')
($b[0..2] | ForEach-Object { $_.ToString('X2') }) -join ' '   # → EF BB BF
```

```powershell
# 补 BOM（保留原内容，只加三个字节）
$p = '<path>\install.ps1'
$bytes = [System.IO.File]::ReadAllBytes($p)
$text  = [System.Text.Encoding]::UTF8.GetString($bytes)
[System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($true)))
```

保存时在编辑器里选「UTF-8 with BOM」（VS Code：右下角编码 → Save with Encoding）。
第 3 个字节是 BOM，**git 不会替你补**。

## 其它文本：UTF-8 **不带** BOM

`.js` / `.mjs` / `.cjs` / `.json` / `.yml` / `.md` 一律无 BOM。

尤其是 `.json`：Node 的 `JSON.parse` **不认** BOM，带 BOM 会直接解析失败。
安装脚本往 profile 写 JSON 时用的是 `UTF8Encoding($false)`，就是这个原因。

## 行尾：一律 LF

由 [`.gitattributes`](../.gitattributes) 锁定（`* text=auto eol=lf` 兜底 + 逐类显式声明），
所以约定**不依赖每个人本机的 `core.autocrlf`**。

为什么必须写进仓库：有些生成物（如 `presets/render.js` 的输出）与源文件要做
**逐字节相等**的判据。本机 `core.autocrlf=true` 时检出的是 CRLF，判据恒红。

## 改完脚本要做什么

`MANIFEST.sha256` 记录每个文件的 sha256，改完任何受管文件都要重算 ——
见 [manifest.md](manifest.md)。
