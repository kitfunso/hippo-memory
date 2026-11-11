param(
  [Parameter(Mandatory)][string]$Checkout,
  [Parameter(Mandatory)][string]$Root,
  [Parameter(Mandatory)][string]$Key,
  [Parameter(Mandatory)][string]$Toolchain,
  [Parameter(Mandatory)][string]$Folder,
  [Parameter(Mandatory)][ValidateSet('regrade', 'reader-draw', 'stored-draw', 'reader-score', 'stored-score', 'grading')][string]$Call,
  [string]$BoxCheck = 'C:/z0-runs/s7/box-check.sh'
)
# Runs one z0-regrade.mjs call (G5, prereg 166) on a finished round 4 run folder, detached from the shell but waited on, in the env its runner used.
# Every refusal prints one line on stdout and exits 1 (3 for a pins mismatch).
$ErrorActionPreference = 'Stop'
$POETRY = 'C:/z0-runs/r4/poetry-2.5.1'
$GITBASH = 'C:/Program Files/Git/bin/bash.exe'
$DEFAULT_BOX = 'C:/z0-runs/s7/box-check.sh'
$DRAW_SEED = '20261110'

function Stop-Launch([string]$Message, [int]$Code = 1) { Write-Output $Message; exit $Code }
function Quote-Arg([string]$Value) { if ($Value -match '[\s"]') { '"' + ($Value -replace '"', '\"') + '"' } else { $Value } }

# A native program with both streams captured and no PowerShell error wrapping; the env is this process's.
function Invoke-Native([string]$Exe, [string[]]$ArgList) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Exe
  $info.Arguments = (($ArgList | ForEach-Object { Quote-Arg $_ }) -join ' ')
  $info.UseShellExecute = $false
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $proc = [System.Diagnostics.Process]::Start($info)
  $out = $proc.StandardOutput.ReadToEndAsync()
  $err = $proc.StandardError.ReadToEndAsync()
  $proc.WaitForExit()
  @{ code = $proc.ExitCode; out = $out.Result; err = $err.Result }
}
function Lines([string]$Text) { @($Text -split "`r?`n" | Where-Object { $_ -ne '' }) }

$bound = $PSBoundParameters
if ($Root -cnotmatch '^[A-Z]:/' -or $Root -match '\\' -or $Root.EndsWith('/')) { Stop-Launch "-Root $Root is not in cygpath -m form (C:/dir, forward slashes, no trailing slash)" }
if ($Folder -cnotmatch '^[A-Z]:/' -or $Folder -match '\\' -or $Folder.EndsWith('/')) { Stop-Launch "-Folder $Folder is not in cygpath -m form (C:/dir, forward slashes, no trailing slash)" }
$dryRoot = Test-Path -LiteralPath "$Root/DRYRUN"
if (-not $dryRoot -and $bound.ContainsKey('BoxCheck')) { Stop-Launch "-BoxCheck is for a DRYRUN root; $Root runs the box's own check" }
if (-not $Folder.StartsWith("$Root/")) { Stop-Launch "-Folder $Folder is not under -Root $Root" }
if (-not (Test-Path -LiteralPath "$Folder/run" -PathType Container)) { Stop-Launch "$Folder/run does not exist; the regrade reads a finished run's out folder" }

$parent = Split-Path -Parent $Folder
$tasksDir = if (@('smoke', 'pilot', 'effort') -contains (Split-Path -Leaf $parent)) { 'pilot-tasks' } else { 'tasks' }
$tasks = "$Root/$tasksDir/$Key/tasks-run.json"
$pins = "$Root/pins-r4.json"
$out = "$Folder/run"
$node = (Get-Command node).Source

$boxScript = if ($dryRoot -and $bound.ContainsKey('BoxCheck')) { $BoxCheck } else { $DEFAULT_BOX }
$box = Invoke-Native $GITBASH @($boxScript)
if ($box.code -ne 0) {
  foreach ($l in (Lines ($box.out + "`n" + $box.err))) { Write-Output $l }
  Stop-Launch 'box check failed: reboot before a scored session'
}
$pinsRun = Invoke-Native $node @("$Checkout/scripts/token-eval/z0-pins-check.mjs", '--pins', $pins, '--checkout', $Checkout, '--roles', "$Root/pin-roles.txt", '--poetry', $POETRY)
if ($pinsRun.code -ne 0) {
  foreach ($l in (Lines ($pinsRun.out + "`n" + $pinsRun.err))) { Write-Output $l }
  Stop-Launch "pins check failed (exit $($pinsRun.code))" $(if ($pinsRun.code -eq 3) { 3 } else { 1 })
}

. 'C:/eval-authors/s3x-env.ps1'
Set-S3xEnv $Toolchain $Folder
# The regrade makes its own scratch venv per cell, so the launcher's one venv and its Scripts folder must not be there.
$own = ($Folder -replace '/', '\') + '\venv\Scripts'
$env:PATH = (($env:PATH -split ';') | Where-Object { $_ -and ($_.TrimEnd('\') -ne $own) }) -join ';'
Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue

$script = "$Checkout/scripts/token-eval/z0-regrade.mjs"
$mode = switch ($Call) {
  'regrade' { @('regrade', '--out', $out, '--tasks', $tasks) + $(if ($Toolchain -eq 'python') { @('--poetry', $POETRY, '--pip-constraint', "$Root/pip-constraints.txt") } else { @() }) }
  'reader-draw' { @('reader', '--out', $out, '--tasks', $tasks, '--seed', $DRAW_SEED, '--n', '5') }
  'stored-draw' { @('stored', '--out', $out, '--tasks', $tasks, '--seed', $DRAW_SEED, '--n', '2') }
  'reader-score' { @('reader', '--out', $out, '--labels', "$out/g5/reader-r1/labels.tsv") }
  'stored-score' { @('stored', '--out', $out, '--labels', "$out/g5/stored/labels.tsv") }
  'grading' { @('grading', '--out', $out) }
}
$a = @($script) + $mode
$log = "$Folder/g5-$Call"
# The regrade checks that the run's env names are set, never their values, and no checker calls Claude.
$env:CLAUDE_CODE_OAUTH_TOKEN = 'placeholder-regrade-runs-no-session'
$argText = @($a | ForEach-Object { Quote-Arg $_ })
$p = Start-Process -FilePath $node -ArgumentList $argText -WorkingDirectory $Folder -RedirectStandardOutput "$log.log" -RedirectStandardError "$log.err" -WindowStyle Hidden -PassThru
Remove-Item Env:CLAUDE_CODE_OAUTH_TOKEN
# Read now, since PowerShell 5.1 loses the exit code of a process whose handle it never took.
$handle = $p.Handle
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::AppendAllText("$parent/regrade-pids.txt", "$Key $($p.Id) $Folder $Call`n", $utf8)
Write-Output "$Call pid $($p.Id)"
$p.WaitForExit()
exit $p.ExitCode
