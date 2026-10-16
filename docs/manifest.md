# `MANIFEST.sha256`：逐文件校验清单

`MANIFEST.sha256` 是**除自身以外**每个受版本管理文件的 sha256。

## 校验

```bash
sha256sum -c MANIFEST.sha256
```

Windows 上没有 `sha256sum` 时（Git for Windows 自带的那个可以直接用）：

```powershell
& "$(git --exec-path)\..\..\usr\bin\sha256sum.exe" -c MANIFEST.sha256
```

拿不到 `sha256sum` 时，用 `Get-FileHash` 等价复算也可以 —— 它是**替代**，不是原命令：

```powershell
# ⚠️ -Encoding UTF8 不能省：清单里有非 ASCII 路径，Windows PowerShell 5.1 默认按
#    ANSI 代码页读，路径会被解成乱码，校验结果全是"文件缺失"的假红。
$lines = Get-Content MANIFEST.sha256 -Encoding UTF8
$ok = 0; $bad = @(); $missing = @()
foreach ($l in $lines) {
  if ($l.Trim() -eq '') { continue }
  $sp = $l.IndexOf(' *')
  $want = $l.Substring(0, $sp); $rel = $l.Substring($sp + 2)
  if (-not (Test-Path -LiteralPath $rel)) { $missing += $rel; continue }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $rel).Hash.ToLowerInvariant() -eq $want) { $ok++ }
  else { $bad += $rel }
}
"OK=$ok  mismatched=$($bad.Count)  missing=$($missing.Count)"
```

## 生成口径

清单是**推导出来的**，三条约定：

1. **范围**：`git ls-files` 的全部受管文件，**排除 `MANIFEST.sha256` 自己**。
   未跟踪文件（`DEPLOY-REPORT.md` 之类）与 gitignore 掉的东西**不入清单**。
2. **顺序**：路径按 `InvariantCultureIgnoreCase` 排序（大小写不敏感、文化无关）。
   所以 `README.md` 排在 `plugin/…` **之后**（`r` > `p`），
   `CONVENTIONS.md` 排在 `cordis.patch.yml` 之前。
3. **格式**：每行 `<64 位小写十六进制> *<正斜杠相对路径>`，行尾 **LF**，无 BOM。

## 什么时候要重算

改过任何受管文件就要重算，否则校验会红。**注意顺序**：先把内容改完，
最后一步再生成清单 —— 先算清单再改文件等于白算。

增加或删除文件同样要重算（清单是文件全集，不只是哈希表）。
