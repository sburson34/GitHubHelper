@echo off
REM ============================================================================
REM  GitHubHelper launcher  -  just double-click me.
REM
REM  Keeps githubhelper.exe in THIS folder current, then runs it:
REM    * not here yet     -> downloads the latest release
REM    * already here     -> updates to the latest release when a newer one
REM                          exists, otherwise launches the copy you have
REM    * already running  -> stops it first when an update must replace the
REM                          file (and tells you if it could not)
REM
REM  Pass flags straight through, e.g.:  githubhelper.cmd --port 5000
REM  Force a fresh download any time:    githubhelper.cmd update
REM
REM  Requires: GitHub CLI (gh) installed and `gh auth login` run once, plus git.
REM ============================================================================
setlocal enableextensions
set "DIR=%~dp0"
set "EXE=%DIR%githubhelper.exe"
set "VERFILE=%DIR%.githubhelper-version"
set "REPO=sburson34/GitHubHelper"

set "FORCE=0"
if /I "%~1"=="update" (
  set "FORCE=1"
  shift
)

where gh >nul 2>nul
if errorlevel 1 (
  echo GitHub CLI ^(gh^) was not found. Install it from https://cli.github.com/ and run: gh auth login
  pause
  exit /b 1
)

REM --- latest published release tag (stays empty if GitHub is unreachable) ---
set "LATEST="
for /f "usebackq delims=" %%v in (`gh release view --repo %REPO% --json tagName -q ".tagName" 2^>nul`) do set "LATEST=%%v"

REM --- the tag we downloaded last time ----------------------------------------
set "CURRENT="
if exist "%VERFILE%" set /p CURRENT=<"%VERFILE%"

REM --- decide whether a (re)download is needed --------------------------------
set "NEED=0"
if not exist "%EXE%" set "NEED=1"
if "%FORCE%"=="1" set "NEED=1"
if defined LATEST if not "%CURRENT%"=="%LATEST%" set "NEED=1"

if "%NEED%"=="0" goto run

REM --- no network: run what we have, or explain if we have nothing ------------
if not defined LATEST (
  if exist "%EXE%" (
    echo Could not check for updates ^(offline?^) - launching the copy you have.
    goto run
  )
  echo Could not reach GitHub to download GitHubHelper.
  echo Check your connection and `gh auth status`, then try again.
  pause
  exit /b 1
)

REM --- free the file if a running instance is holding it ----------------------
if exist "%EXE%" call :stop_running

echo Downloading GitHubHelper %LATEST% into "%DIR%" ...
gh release download %LATEST% --repo %REPO% --pattern githubhelper.exe --dir "%DIR%" --clobber
if errorlevel 1 goto dlerr
> "%VERFILE%" echo %LATEST%
echo Updated to %LATEST%.
echo.

:run
"%EXE%" %1 %2 %3 %4 %5 %6 %7 %8 %9
goto :eof

:stop_running
tasklist /FI "IMAGENAME eq githubhelper.exe" /NH 2>nul | find /I "githubhelper.exe" >nul && (
  echo Stopping the running GitHubHelper so it can be updated ...
  taskkill /F /IM githubhelper.exe >nul 2>nul
  REM give Windows a moment to release the file handle before we overwrite it
  ping -n 3 127.0.0.1 >nul
)
REM never leak the probe's errorlevel back to the caller's download check
ver >nul
goto :eof

:dlerr
echo.
echo Could not download or replace githubhelper.exe.
echo   * Not signed in?  Run:  gh auth login
echo   * Still running?  If a GitHubHelper window is open, close it (Ctrl+C)
echo     and run this again - it could not be stopped automatically.
pause
exit /b 1
