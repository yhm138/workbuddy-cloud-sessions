@echo off
setlocal
chcp 65001 >nul 2>&1
title WorkBuddy Cloud Sessions - Uninstall
cd /d "%~dp0"

if "%WBCS_HOME%"=="" set "WBCS_HOME=%LOCALAPPDATA%\wbcs"

set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" (
  echo.
  echo   [x] runtime\node.exe not found.
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "%~dp0app\bin\wbcs.js" uninstall %*
set "RC=%ERRORLEVEL%"
echo.
if not "%WBCS_NO_PAUSE%"=="1" pause
exit /b %RC%
