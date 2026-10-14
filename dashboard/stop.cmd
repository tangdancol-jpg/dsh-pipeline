@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "dashboard.pid" (
  echo 没有 dashboard.pid，面板大概没在跑。
  echo 要手工排查：netstat -ano ^| findstr :18240
  pause
  exit /b 0
)

set /p DPID=<dashboard.pid
rem 只结束面板自己记下的那个进程号
taskkill /PID %DPID% /F
if errorlevel 1 (
  echo 结束进程 %DPID% 失败（可能已经退出）。
)
del "dashboard.pid"
pause
