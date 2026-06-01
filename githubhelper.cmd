@echo off
REM ============================================================================
REM  GitHubHelper launcher
REM
REM  Drop this tiny file in your projects folder and double-click it. It pulls
REM  the latest githubhelper.exe from GitHub straight into THIS folder (no
REM  browser, no Downloads directory, no copying) and runs it.
REM
REM  Usage:
REM    githubhelper.cmd            download if missing, then run
REM    githubhelper.cmd update     force re-download the latest release, then run
REM    githubhelper.cmd --port 5000   pass any flags through to the exe
REM
REM  Requires: GitHub CLI (gh) installed and `gh auth login` run once, plus git.
REM ============================================================================
setlocal
set "DIR=%~dp0"
set "EXE=%DIR%githubhelper.exe"
set "REPO=sburson34/GitHubHelper"

where gh >nul 2>nul || (
  echo GitHub CLI ^(gh^) was not found. Install it from https://cli.github.com/ and run: gh auth login
  pause
  exit /b 1
)

if /I "%~1"=="update" (
  echo Downloading the latest release into "%DIR%" ...
  gh release download --repo %REPO% --pattern githubhelper.exe --dir "%DIR%" --clobber || goto :dlerr
  shift
) else if not exist "%EXE%" (
  echo githubhelper.exe not found here - downloading the latest release ...
  gh release download --repo %REPO% --pattern githubhelper.exe --dir "%DIR%" || goto :dlerr
)

"%EXE%" %1 %2 %3 %4 %5 %6 %7 %8 %9
goto :eof

:dlerr
echo.
echo Download failed. Make sure you are signed in: gh auth login
pause
exit /b 1
