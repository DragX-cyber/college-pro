@echo off
setlocal EnableDelayedExpansion
title REDLINE - startup
echo.
echo  =====================================================
echo   REDLINE - AI Red Team Operations Platform
echo  =====================================================
echo.

REM ── 1. locate bun (PATH first, then the default install location) ──
set "BUN="
where bun >nul 2>&1
if not errorlevel 1 set "BUN=bun"
if not defined BUN if exist "%USERPROFILE%\.bun\bin\bun.exe" set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
if defined BUN goto :bun_ok
echo  [ERROR] bun was not found.
echo          Install it:  winget install Oven-sh.Bun
echo          or           powershell -c "irm bun.sh/install.ps1 ^| iex"
echo          then run this script again.
pause
exit /b 1
:bun_ok
echo  [1/5] bun: !BUN!

REM ── 2. dependencies ──
if exist "node_modules\next" goto :deps_ok
echo  [2/5] node_modules missing - installing dependencies...
"!BUN!" install
if errorlevel 1 goto :fail_install
goto :deps_done
:deps_ok
echo  [2/5] dependencies: ok
:deps_done

REM ── 3. database (create schema only if the db file is missing) ──
if exist "db\custom.db" goto :db_ok
echo  [3/5] db\custom.db missing - creating schema...
"!BUN!" run db:push >nul 2>&1
if errorlevel 1 goto :fail_db
goto :db_done
:db_ok
echo  [3/5] database: ok
:db_done

REM ── 4. llama.cpp check (provider is set to llamacpp :8080) ──
curl -s -o nul -m 3 http://localhost:8080/v1/models >nul 2>&1
if errorlevel 1 goto :llama_down
echo  [4/5] llama-server: reachable on :8080
goto :llama_done
:llama_down
echo  [4/5] llama-server NOT reachable on :8080
echo           chat needs it - start it in another terminal:
echo             llama-server -m path\to\model.gguf --host 0.0.0.0 --port 8080 --parallel 1
echo           the console and this script continue anyway
:llama_done

curl -s -o nul -m 3 http://localhost:8081/v1/models >nul 2>&1
if errorlevel 1 goto :embedder_down
echo       embedding server: reachable on :8081 - vector search active
goto :embedder_done
:embedder_down
echo       embedding server NOT reachable on :8081 - knowledge search runs keyword-only
echo         optional, to enable semantic search:
echo           llama-server -m nomic-embed-text-v1.5.Q8_0.gguf --embedding --pooling cls -c 8192 --port 8081
:embedder_done

REM ── 5. start services (skip any port already listening) ──
netstat -ano | findstr ":3003 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto :start_service
echo  [5/5] agent service already running on :3003
goto :service_done
:start_service
echo  [5/5] starting agent service on :3003 in a new window...
start "REDLINE agent service (:3003)" cmd /k ""!BUN!" run service"
:service_done

ping -n 4 127.0.0.1 >nul

netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 goto :start_web
echo        web console already running on :3000
goto :web_done
:start_web
echo        starting web console on :3000 in a new window...
start "REDLINE web console (:3000)" cmd /k ""!BUN!" run dev"
:web_done

echo.
echo  opening http://localhost:3000 ...
start http://localhost:3000
echo.
echo  READY. Two console windows are running - keep them open.
echo    agent service :3003   chat engine, guards, approvals
echo    web console   :3000   the UI you just opened
echo  To stop everything: run stop.bat
echo.
ping -n 6 127.0.0.1 >nul
exit /b 0

:fail_install
echo  [ERROR] bun install failed
pause
exit /b 1
:fail_db
echo  [ERROR] prisma db push failed
pause
exit /b 1
