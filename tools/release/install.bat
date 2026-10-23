@echo off
setlocal
chcp 65001 >nul 2>&1
title WorkBuddy Cloud Sessions - Install
cd /d "%~dp0"

rem Data (login profile + fetched bodies) goes to %LOCALAPPDATA%\wbcs so it
rem survives re-extracting the zip. Override by setting WBCS_HOME first.
if "%WBCS_HOME%"=="" set "WBCS_HOME=%LOCALAPPDATA%\wbcs"

set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" (
  echo.
  echo   [x] runtime\node.exe not found.
  echo       Please re-download the release zip and extract it completely.
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "%~dp0app\bin\wbcs.js" install %*
set "RC=%ERRORLEVEL%"
echo.
if not "%WBCS_NO_PAUSE%"=="1" pause
exit /b %RC%
