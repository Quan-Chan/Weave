@echo off
rem Double-click to generate weave_250_fullmesh.json in this folder.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org/ and retry.
  pause
  exit /b 1
)

node "gen-fullmesh.js"
echo.
pause
