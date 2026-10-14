@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 node，请先安装 Node.js 20 以上版本。
  pause
  exit /b 1
)

if not exist "dashboard-keys.json" (
  echo 首次启动：生成钥匙与端口……
  node "server.mjs" --init
  if errorlevel 1 (
    echo 生成钥匙失败。
    pause
    exit /b 1
  )
)

start "dsh-dashboard" /min node "server.mjs" %*
timeout /t 2 /nobreak >nul

echo.
node "server.mjs" --print %*
echo.
echo 完整钥匙在 dashboard-keys.json 里，地址后面接 ?k=^<你的钥匙^> 打开。
echo 停止：stop.cmd
pause
