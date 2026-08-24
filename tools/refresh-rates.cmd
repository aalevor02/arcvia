@echo off
rem Weekly rate-library refresh — the scheduled half of `rates --refresh`.
rem
rem The CLI half has existed and been verified for a while; nothing called it
rem on a timer, so the library aged silently toward the 90-day warning. This
rem wrapper is what the Windows scheduled task "Arcvia rate refresh" runs.
rem
rem Semantics worth knowing (from quantify/refresh.py, all asserted in tests):
rem   - never stamps a date the source page did not give it
rem   - a move past TRUST_BAND is refused as a parse failure, not written
rem   - exits 1 when nothing updated AND sources were unreachable/untrusted,
rem     so Task Scheduler's Last Result distinguishes a dead run from a quiet
rem     one. The log below carries the detail.
rem
rem Where the report goes is still an open decision (email vs log-only); until
rem the owner decides, everything lands in the log next to the rates file.

cd /d A:\Web\Arcvia\services\reconstruct
echo ================= %date% %time% ================= >> data\rates\refresh.log
.venv\Scripts\python.exe cli.py rates --refresh --write >> data\rates\refresh.log 2>&1
exit /b %errorlevel%
