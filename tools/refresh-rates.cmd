@echo off
setlocal
rem Weekly rate-library refresh - scheduled half of "rates --refresh".
rem Keep this file ASCII-safe because Windows cmd.exe parses it directly.
rem
rem Refresh guarantees are implemented and tested in quantify/refresh.py:
rem - never stamp a date the source page did not provide
rem - refuse changes beyond TRUST_BAND
rem - return nonzero when sources are unreachable or untrusted

for %%I in ("%~dp0..") do set "ARCVIA_REPO=%%~fI"
set "ARCVIA_LOG=%ARCVIA_REPO%\data\rates\refresh.log"

cd /d "%ARCVIA_REPO%\services\reconstruct"
if errorlevel 1 exit /b 2

>>"%ARCVIA_LOG%" echo ================= %date% %time% =================
.venv\Scripts\python.exe cli.py rates --refresh --write >>"%ARCVIA_LOG%" 2>&1
set "ARCVIA_REFRESH_RC=%errorlevel%"
exit /b %ARCVIA_REFRESH_RC%
