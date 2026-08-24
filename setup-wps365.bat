@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "PROJECT_ROOT=%CD%"
set "WPS365_APP_ID=AK20260629HIZHYJ"
set "EXPECTED_WPS_USER=高晶娣"

if /I "%~1"=="--help" goto :help

echo [1/7] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
  where winget >nul 2>nul || goto :node_missing
  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  where node >nul 2>nul || goto :node_missing
)

echo [2/7] Installing project dependencies...
if exist package-lock.json (call npm ci) else (call npm install)
if errorlevel 1 goto :failed

echo [3/7] Preparing portable project configuration...
if not exist config.json (
  if not exist config.portable.json goto :config_missing
  copy /Y config.portable.json config.json >nul
)

echo [4/7] Checking WPS 365 CLI...
set "WPS365_CLI=%USERPROFILE%\.wps365\bin\wps365-cli.exe"
if not exist "%WPS365_CLI%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/wps365-open/cli/main/install.ps1 | iex"
)
if not exist "%WPS365_CLI%" for /f "delims=" %%I in ('where wps365-cli 2^>nul') do if not defined WPS365_CLI_FOUND set "WPS365_CLI_FOUND=%%I"
if defined WPS365_CLI_FOUND set "WPS365_CLI=%WPS365_CLI_FOUND%"
if not exist "%WPS365_CLI%" goto :wps_missing

echo [5/7] Binding WPS application %WPS365_APP_ID%...
"%WPS365_CLI%" config init --app-id "%WPS365_APP_ID%" --force
if errorlevel 1 goto :failed
"%WPS365_CLI%" auth logout >nul 2>nul
echo Select the WPS account "%EXPECTED_WPS_USER%" in the browser.
"%WPS365_CLI%" auth login --device
if errorlevel 1 goto :failed

echo [6/7] Verifying account and document access...
node scripts\check-wps365-auth.js --expected-user "%EXPECTED_WPS_USER%" --probe
if errorlevel 1 goto :wrong_account

echo [7/7] Installing the OpenClaw skill...
set "OPENCLAW_SKILL_HOME=%USERPROFILE%\.openclaw\skills"
if not exist "%OPENCLAW_SKILL_HOME%" mkdir "%OPENCLAW_SKILL_HOME%"
if exist "%OPENCLAW_SKILL_HOME%\multi-team-meeting-summary" rmdir /S /Q "%OPENCLAW_SKILL_HOME%\multi-team-meeting-summary"
xcopy /E /I /Y "skills\multi-team-meeting-summary" "%OPENCLAW_SKILL_HOME%\multi-team-meeting-summary" >nul
setx MULTI_TEAM_MEETING_SUMMARY_HOME "%PROJECT_ROOT%" >nul

echo.
echo Setup complete. Restart OpenClaw once so it can load the skill and project path.
echo Project: %PROJECT_ROOT%
echo WPS account: %EXPECTED_WPS_USER%
goto :success

:node_missing
echo Node.js is required. Install Node.js LTS and run this BAT again.
goto :failed

:config_missing
echo config.portable.json is missing. Copy the complete repository and run this BAT again.
goto :failed

:wps_missing
echo WPS 365 CLI installation failed. Check network access and run this BAT again.
goto :failed

:wrong_account
echo Authorization or document permission verification failed.
echo Sign out of WPS in the browser, sign in as "%EXPECTED_WPS_USER%", and run this BAT again.
goto :failed

:failed
echo.
echo Setup failed. No access token was written to the project.
pause
exit /b 1

:success
pause
exit /b 0

:help
echo Usage: setup-wps365.bat
echo Run once after copying or cloning this project to a new Windows OpenClaw machine.
echo The setup installs dependencies, binds WPS app %WPS365_APP_ID%, verifies %EXPECTED_WPS_USER%, and installs the OpenClaw skill.
exit /b 0
