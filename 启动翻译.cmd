@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 20.12 或更新版本，再双击启动。
  pause
  exit /b 1
)
node translation-server.mjs --open
if errorlevel 1 pause
