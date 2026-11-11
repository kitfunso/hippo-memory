# Stub of s4-run.ps1 for the s4-batch.sh tests: the launch contract (plan :200) over the stub ab-run.mjs beside it.
# Knobs come from $env:Z0_STUB_KNOBS/<folder name>.json: box and pins (once|always), pidsDelayS, exitRelease (a file it waits for before exit.txt).
param(
  [Parameter(Mandatory = $true)][string]$Checkout,
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Batch,
  [Parameter(Mandatory = $true)][string]$Key,
  [Parameter(Mandatory = $true)][string]$Toolchain,
  [Parameter(Mandatory = $true)][string]$Folder,
  [string]$Retry = '', [string]$FakeAgent = '', [string]$Arms = '', [string]$Seeds = '', [string]$OnlySeed = '', [string]$SeedRule = '', [string]$MaxSeed = ''
)
$ErrorActionPreference = 'Stop'
$name = Split-Path -Leaf $Folder
if ($name -notmatch "^$([regex]::Escape($Key))-(w[12]|e[0-9]+)(-a[23])?$") { Write-Output "folder $name does not match the layout name for key $Key"; exit 1 }
New-Item -ItemType Directory -Force $Folder | Out-Null
$args2 = @{}
foreach ($k in $PSBoundParameters.Keys) { $args2[$k] = $PSBoundParameters[$k] }
$args2 | ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $Folder 'launcher-args.json')
Add-Content -Encoding ascii (Join-Path $Folder 'launcher-calls.txt') 'call'

$knobs = [pscustomobject]@{}
foreach ($f in @((Join-Path $env:Z0_STUB_KNOBS "$name.json"), (Join-Path $env:Z0_STUB_KNOBS 'default.json'))) {
  if (Test-Path $f) { $knobs = Get-Content -Raw $f | ConvertFrom-Json; break }
}
# A once-knob fires on the first call of the folder only.
function Fires($mode, $tag) {
  if (-not $mode) { return $false }
  $mark = Join-Path $Folder "$tag.fired"
  if ($mode -eq 'once' -and (Test-Path $mark)) { return $false }
  Set-Content $mark 'x'
  return $true
}
if (Fires $knobs.pins 'pins') { Write-Output 'PINS: the stub pinned file changed'; exit 1 }
if (Fires $knobs.box 'box') { Write-Output 'box check failed: the stub box is busy'; exit 1 }

$run = Join-Path $Folder 'run'
New-Item -ItemType Directory -Force $run | Out-Null
$p = Start-Process -FilePath (Get-Command node).Source -ArgumentList @("$PSScriptRoot/ab-run.mjs", '--out', "$Folder/run") -RedirectStandardOutput (Join-Path $Folder 'run.log') -RedirectStandardError (Join-Path $Folder 'run.err') -WindowStyle Hidden -PassThru
$null = $p.Handle
if ($knobs.pidsDelayS) { Start-Sleep -Seconds $knobs.pidsDelayS }
Add-Content -Encoding ascii (Join-Path (Split-Path -Parent $Folder) 'pids.txt') "$Key $($p.Id) $Folder"
Write-Output "run pid $($p.Id)"
$p.WaitForExit()
if ($knobs.exitRelease) { while (-not (Test-Path $knobs.exitRelease)) { Start-Sleep -Milliseconds 200 } }
Set-Content -Encoding ascii (Join-Path $run 'exit.txt') $p.ExitCode
exit $p.ExitCode
