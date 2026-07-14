@echo off
cd /d "%~dp0"
if exist "%~dp0Nixart Course Manager.exe" (
  start "" "%~dp0Nixart Course Manager.exe"
  exit /b
)
start "" powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\nixart-course-manager.ps1"
