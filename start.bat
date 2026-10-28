@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 飲食日誌

rem ===== 設定 =====
set "PORT=3000"
set "SERVE_PORT=8443"
if exist "%~dp0start.local.bat" call "%~dp0start.local.bat"
if not exist "%TAILSCALE%" set "TAILSCALE=%ProgramFiles%\Tailscale\tailscale.exe"

where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 Node.js，請先安裝 Node.js 24 以上：https://nodejs.org
  goto fail
)

rem 已經在執行就直接開網頁，不重複啟動
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo 飲食日誌已經在執行，開啟網頁。
  start "" "http://127.0.0.1:%PORT%"
  goto end
)

if not exist "node_modules\" (
  echo 第一次執行，安裝套件中...
  call npm.cmd ci
  if errorlevel 1 goto fail
)

echo 建置畫面中...
call npm.cmd run build
if errorlevel 1 goto fail

rem Tailscale serve 設定會保留，這裡只確保它指向這個連接埠；失敗不影響本機使用
if exist "%TAILSCALE%" (
  "%TAILSCALE%" serve --https=%SERVE_PORT% --bg %PORT% >nul 2>nul
  if errorlevel 1 echo [提醒] Tailscale serve 設定失敗，手機可能連不上；電腦本機仍可使用。
) else (
  echo [提醒] 找不到 Tailscale，只能在這台電腦使用。
)

rem 伺服器啟動後再開瀏覽器
start "" /b powershell -NoProfile -Command "Start-Sleep 2; Start-Process 'http://127.0.0.1:%PORT%'"

call npm.cmd start
if errorlevel 1 goto fail
goto end

:fail
echo.
echo 啟動失敗，請把上方訊息複製給我。
pause
exit /b 1

:end
endlocal
