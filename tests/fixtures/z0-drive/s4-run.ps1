# Stub of s4-run.ps1 for the s4-drive.sh tests: the 2b param block and layout rule, a dry plan from the knob's `plan` file, and a launch of the stub ab-run.mjs beside it.
# Knobs come from $env:Z0_STUB_KNOBS/<folder name>.json, else default.json: plan (a plan.json to copy), planExit, and the stub runner's own (fixture, records, exit, hang ...).
param(
  [Parameter(Mandatory)][string]$Checkout,
  [Parameter(Mandatory)][string]$Root,
  [Parameter(Mandatory)][ValidateSet('smoke', 'pilot', 'effort', '1', '2', 'raise')][string]$Batch,
  [Parameter(Mandatory)][string]$Key,
  [Parameter(Mandatory)][string]$Arms,
  [Parameter(Mandatory)][string]$Toolchain,
  [Parameter(Mandatory)][string]$Folder,
  [ValidateSet('low', 'medium', 'high')][string]$Effort = 'medium',
  [string]$Seeds = '', [string]$OnlySeed = '', [string]$SeedRule = '', [string]$MaxSeed = '', [string]$MaxPosition = '',
  [int]$Attempt = 1, [int]$Retry = 0,
  [switch]$PlanOnly, [switch]$DryRun,
  [string]$FakeAgent = '', [string]$TokenVar = 'Z0_SUB_TOKEN', [string]$TokenSchedule = '', [string]$BoxCheck = 'C:/z0-runs/s7/box-check.sh'
)
$ErrorActionPreference = 'Stop'
$bound = $PSBoundParameters
$name = switch ($Batch) {
  'smoke' { "smoke/w$Attempt" }
  'pilot' { "pilot/$Key-p$Attempt" }
  'effort' { "effort/$Effort-p$Attempt" }
  '1' { "batch1/$Key-w1" }
  '2' { "batch2/$Key-w1" }
  'raise' { "raise/$Key-w2" }
}
if ($Retry -ge 2) { $name = "$name-a$Retry" }
if ($Folder -ne "$Root/$name") { Write-Output "-Folder $Folder does not match the layout for batch $Batch; expected $Root/$name"; exit 1 }
if (-not $PlanOnly -and ((Test-Path -LiteralPath "$Folder/run") -or (Test-Path -LiteralPath "$Folder/run.log"))) { Write-Output "$Folder already holds a run (run/ or run.log); pick a new -Attempt or -Retry"; exit 1 }
New-Item -ItemType Directory -Force $Folder | Out-Null
$flat = @{}
foreach ($k in $bound.Keys) { $flat[$k] = "$($bound[$k])" }
$flat | ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $Folder 'launcher-args.json')
Add-Content -Encoding ascii (Join-Path $Folder 'launcher-calls.txt') $(if ($PlanOnly) { 'plan' } else { 'launch' })

$leaf = Split-Path -Leaf $Folder
$knobs = [pscustomobject]@{}
foreach ($f in @((Join-Path $env:Z0_STUB_KNOBS "$leaf.json"), (Join-Path $env:Z0_STUB_KNOBS 'default.json'))) {
  if (Test-Path $f) { $knobs = Get-Content -Raw $f | ConvertFrom-Json; break }
}
if ($PlanOnly) {
  if ($knobs.planExit) { Write-Output "the stub plan failed: exit $($knobs.planExit)"; exit $knobs.planExit }
  New-Item -ItemType Directory -Force "$Folder/dry" | Out-Null
  Copy-Item -LiteralPath $knobs.plan -Destination "$Folder/dry/plan.json"
  Write-Output "wrote $Folder/dry/plan.json"
  exit 0
}

$p = Start-Process -FilePath (Get-Command node).Source -ArgumentList @("$PSScriptRoot/ab-run.mjs", '--out', "$Folder/run") -RedirectStandardOutput (Join-Path $Folder 'run.log') -RedirectStandardError (Join-Path $Folder 'run.err') -WindowStyle Hidden -PassThru
$null = $p.Handle
Add-Content -Encoding ascii (Join-Path (Split-Path -Parent $Folder) 'pids.txt') "$Key $($p.Id) $Folder"
Write-Output "run pid $($p.Id)"
$p.WaitForExit()
New-Item -ItemType Directory -Force "$Folder/run" | Out-Null
Set-Content -Encoding ascii (Join-Path $Folder 'run/exit.txt') $p.ExitCode
exit $p.ExitCode
