# 沙箱 temp 根：`%TEMP%` 不得在 workspace 之内

Windows 上，如果会话的 workspace 根**包住了** `%TEMP%`，该会话里每一次
受限（`workspace-write`）的 shell 调用都会**直接失败**，命令根本没机会执行。

## 症状

```
Error: Windows ACL temp root must be outside the workspace:
       workspace=<workspace 根>; temp=<%TEMP%>
```

最容易踩到的形态：拿**用户主目录**（`%USERPROFILE%`）当 workspace 开会话 ——
`%TEMP%` 正好在它下面。

## 为什么是这样

上游判据（读 DSH 实现得来，不是推测）：

```
assertTempRootOutsideWorkspace(workspaceRoot, tempRoot)
  containsDirectory(workspaceRoot, tempRoot) ⇒ throw

调用点：materializeAclGrant(sessionId, workspaceRoot) → tmpdir()
```

- `workspaceRoot` = **会话的 cwd**（不是 `process.cwd()`）
- `tempRoot` = **宿主进程的 `os.tmpdir()`**（Windows 上先取 `%TMP%` 再取 `%TEMP%`，`TMPDIR` 被忽略）

上游是写死的 `tmpdir()` 调用，**没有任何配置键**能覆盖它。插件跑在另一个进程里，
也改不了已经启动的宿主的进程环境 —— 所以**插件层修不了这个问题**，
只能靠下面的环境侧修法。

## 修法（按推荐顺序）

1. **换一个更窄的目录当 workspace**：先 `cd` 到项目目录，再从那里开会话。
   这是最干净的一条，不动任何机器级设置。
2. **启动 DSH 之前**把 temp 指到 workspace 之外（只影响这一个进程）：

   ```powershell
   $outside = Join-Path $env:SystemDrive 'dsh-tmp'   # 任何 workspace 之外的目录都行
   $env:TEMP = $outside
   $env:TMP  = $outside
   ```

3. **落成用户级持久值**，用安装脚本的显式开关（**默认关闭**）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -SetUserTempRoot "$env:SystemDrive\dsh-tmp" -DryRun
   ```

   去掉 `-DryRun` 才真的写。它写的是 `HKCU\Environment` 下的 `TEMP` / `TMP`，
   改完**所有**用户进程的 temp 落点 —— 一个插件安装器不该悄悄做这件事，所以默认不动；
   而且它只对**新启动**的进程生效，必须重启 DSH。

   脚本会拒绝一个"仍落在 workspace 里"的新 temp 根（那样等于没改），
   并在设置前打印原值与撤销命令。

4. 该会话改用 `read-only` / `danger-full-access` —— 只有 `workspace-write` 会走到这条检查。

## 安装期的预检

`install.ps1` 的第 **§0b** 段会做一次预检：取宿主 temp 根，逐个比对三个候选 workspace 根
（当前目录、「读目录设定」算出的工作目录、`$env:USERPROFILE`），命中就**告警 + 打印上面这些修法**。

它只告警、**不中止安装** —— 这是环境配置问题，装插件本身不受影响。

预检里**没有任何个人路径字面量**：temp 根与候选根一律运行时求值
（`$env:TMP` / `$env:TEMP` / `GetTempPath()` / `$env:USERPROFILE`）。
