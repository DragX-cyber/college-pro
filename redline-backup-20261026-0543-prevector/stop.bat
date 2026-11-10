@echo off
setlocal
title REDLINE - stop
echo.
echo  Stopping REDLINE services...
echo.

netstat -ano | findstr ":3003 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto :svc_not_running
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3003 " ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1
echo   agent service :3003 - stopped
goto :web
:svc_not_running
echo   agent service :3003 - not running
:web

netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto :web_not_running
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1
echo   web console :3000 - stopped
goto :done
:web_not_running
echo   web console :3000 - not running
:done

echo.
echo  Done. llama-server is not touched - stop it in its own window.
echo.
ping -n 4 127.0.0.1 >nul
exit /b 0
