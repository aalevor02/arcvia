# Start the floor-plan detector from THIS tree, with its AI credentials.
#
# Two things this exists to prevent, both of which have already happened:
#
#   1. A detector started from the un-versioned C:\Users\aalev\Arcvia copy.
#      uvicorn sets SO_REUSEADDR, and on Windows that lets a second process
#      bind a port already in use -- no "address in use" error, the last
#      binder just quietly starts answering. The A: and C: copies differ in
#      labels.py, so the wrong one returns a different class taxonomy for the
#      same plan: mislabelled, not merely stale.
#
#   2. A detector started without NVIDIA_API_KEY. adjudicate.py then reports
#      itself unavailable and the vision adjudicator silently degrades to
#      heuristic-only proposals -- design.py rides on the same client, so the
#      deck design reader goes with it. Both fail quiet, not loud.
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\dev-detect.ps1

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# Config lives in .env even though main.py reads only os.environ -- one home
# for the values, and this script is what carries them into the process.
$envFile = Join-Path $repo '.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $name, $value = $line -split '=', 2
    Set-Item -Path "env:$($name.Trim())" -Value $value.Trim()
  }
}

# The NVIDIA key is shared with other tools on this machine and is not checked
# in. Fall back to its own file so a fresh clone still gets an adjudicator.
if (-not $env:NVIDIA_API_KEY -and (Test-Path 'A:\Tools\Nvidia\.env')) {
  foreach ($line in Get-Content 'A:\Tools\Nvidia\.env') {
    if ($line -match '^\s*NVIDIA_API_KEY\s*=\s*(.+)$') { $env:NVIDIA_API_KEY = $Matches[1].Trim() }
  }
}

if (-not $env:NVIDIA_API_KEY) {
  Write-Warning 'NVIDIA_API_KEY is not set. The detector will run, but the vision adjudicator and the deck design reader will both report themselves unavailable.'
}

# Same failure shape as the missing key above, one layer deeper. The trained
# classifier is switched on by FLOORPLAN_MODEL alone. Without it the detector
# still answers -- it just answers without the pass that makes railings
# deterministic and drops furniture outlines, so a balcony edge goes back to
# being whatever the vision model happened to say that run. /health reports
# "not configured", and nothing else reports anything at all.
#
# This is not hypothetical. The value lived only in one shell's environment for
# a day; the next restart of this service dropped the classifier silently, and
# the only reason anyone noticed was reading /health line by line.
if (-not $env:FLOORPLAN_MODEL) {
  Write-Warning 'FLOORPLAN_MODEL is not set. The detector will run WITHOUT the trained classifier: railings fall back to the varying vision verdict and furniture outlines stay walls. Set it in .env.'
} elseif (-not (Test-Path $env:FLOORPLAN_MODEL -PathType Leaf)) {
  # -PathType Leaf, not a bare Test-Path. A truncated path very often still
  # names a real DIRECTORY -- this guard was written, then immediately fooled
  # by a value cut short at ...\kaggle, which exists and is not a model.
  Write-Warning "FLOORPLAN_MODEL points at $($env:FLOORPLAN_MODEL), which is not on this machine. Same effect as leaving it unset, and just as quiet."
}

$python = Join-Path $repo 'services\floorplan-ai\.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { throw "No venv at $python. See services/floorplan-ai setup in START-HERE.md." }

# 127.0.0.1, not 0.0.0.0: this is a dev service holding a provider key, and it
# has no business being reachable from the network.
& $python -m uvicorn main:app --host 127.0.0.1 --port 8090 --app-dir (Join-Path $repo 'services\floorplan-ai')
