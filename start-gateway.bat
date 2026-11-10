@echo off
title RedLine Knowledge & Model Gateway (RKMG)
echo ===================================================
echo   Starting RedLine Knowledge & Model Gateway (RKMG)
echo ===================================================
echo.
cd /d "%~dp0\rkmg"
npm run dev
pause

