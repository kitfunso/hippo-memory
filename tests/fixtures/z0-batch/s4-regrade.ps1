# Stub of s4-regrade.ps1 for the s4-batch.sh tests: one G5 call as one stub z0-regrade.mjs run, blocking (plan :124).
param(
  [Parameter(Mandatory = $true)][string]$Checkout,
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Key,
  [Parameter(Mandatory = $true)][string]$Toolchain,
  [Parameter(Mandatory = $true)][string]$Folder,
  [Parameter(Mandatory = $true)][ValidateSet('regrade', 'reader-draw', 'stored-draw', 'reader-score', 'stored-score', 'grading')][string]$Call
)
$ErrorActionPreference = 'Stop'
$tasks = "$(Split-Path -Parent (Split-Path -Parent $Folder))/tasks/$Key/tasks-run.json"
$g5 = "$Folder/run/g5"
$modeArgs = switch ($Call) {
  'regrade' { @('regrade', '--out', "$Folder/run", '--tasks', $tasks) }
  'reader-draw' { @('reader', '--out', "$Folder/run", '--tasks', $tasks, '--seed', '20261110', '--n', '5') }
  'stored-draw' { @('stored', '--out', "$Folder/run", '--tasks', $tasks, '--seed', '20261110', '--n', '2') }
  'reader-score' { @('reader', '--out', "$Folder/run", '--labels', "$g5/reader-r1/labels.tsv") }
  'stored-score' { @('stored', '--out', "$Folder/run", '--labels', "$g5/stored/labels.tsv") }
  'grading' { @('grading', '--out', "$Folder/run") }
}
Set-Content -Encoding ascii (Join-Path $Folder "g5-$Call.launcher.pid") $PID
@{ Toolchain = $Toolchain; Call = $Call; Args = $modeArgs } | ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $Folder "g5-$Call.launcher.json")
$p = Start-Process -FilePath (Get-Command node).Source -ArgumentList (@("$PSScriptRoot/z0-regrade.mjs") + $modeArgs) -RedirectStandardOutput (Join-Path $Folder "g5-$Call.log") -RedirectStandardError (Join-Path $Folder "g5-$Call.err") -WindowStyle Hidden -PassThru
$null = $p.Handle
Add-Content -Encoding ascii (Join-Path (Split-Path -Parent $Folder) 'regrade-pids.txt') "$Key $($p.Id) $Folder $Call"
Write-Output "$Call pid $($p.Id)"
$p.WaitForExit()
exit $p.ExitCode
