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
# Launches one round 4 runner chunk (ab-run.mjs --design r4) detached, in its toolchain's env, on a root laid out by the plan.
# Every refusal prints one line on stdout and exits 1 (3 for a pins mismatch), so a caller reads the reason from the output.
$ErrorActionPreference = 'Stop'
$POETRY = 'C:/z0-runs/r4/poetry-2.5.1'
$CLAUDE = 'C:/z0-runs/scored/bin/claude.exe'
$GITBASH = 'C:/Program Files/Git/bin/bash.exe'
$DEFAULT_BOX = 'C:/z0-runs/s7/box-check.sh'

function Stop-Launch([string]$Message, [int]$Code = 1) { Write-Output $Message; exit $Code }
function Quote-Arg([string]$Value) { if ($Value -match '[\s"]') { '"' + ($Value -replace '"', '\"') + '"' } else { $Value } }

# A native program with both streams captured and no PowerShell error wrapping; the env is this process's.
function Invoke-Native([string]$Exe, [string[]]$ArgList, [string]$Cwd = '') {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Exe
  $info.Arguments = (($ArgList | ForEach-Object { Quote-Arg $_ }) -join ' ')
  $info.UseShellExecute = $false
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  if ($Cwd) { $info.WorkingDirectory = $Cwd }
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
if ($dryRoot -and -not $FakeAgent) { Stop-Launch "$Root is a DRYRUN root: pass -FakeAgent <knobs file>, so no session is paid" }
if (-not $dryRoot) {
  if ($FakeAgent) { Stop-Launch "-FakeAgent is for a DRYRUN root; $Root has no DRYRUN file" }
  if ($bound.ContainsKey('BoxCheck')) { Stop-Launch "-BoxCheck is for a DRYRUN root; $Root runs the box's own check" }
}
if ($dryRoot -and $TokenSchedule) { Stop-Launch "-TokenSchedule is for a real root; a fake agent runs on its one fake token" }
$batchOnly = @('1', '2', 'raise')
if ($OnlySeed -and $batchOnly -notcontains $Batch) { Stop-Launch "-OnlySeed goes with batch 1, 2 or raise, not $Batch" }
if ($OnlySeed -and $OnlySeed -notmatch '^[1-9][0-9]*$') { Stop-Launch "-OnlySeed must be a positive whole number, got $OnlySeed" }
if ($bound.ContainsKey('Retry') -and $Retry -lt 2) { Stop-Launch "-Retry $Retry is not a retry; the first launch of a folder has no -a suffix, so -Retry starts at 2" }
if ($Batch -eq 'effort' -and $Effort -eq 'medium') { Stop-Launch 'the effort batch runs low or high; pass -Effort low or -Effort high' }

# The folder is a function of the batch, so two launches never share one and a retry is named by its number.
$name = switch ($Batch) {
  'smoke' { "smoke/w$Attempt" }
  'pilot' { "pilot/$Key-p$Attempt" }
  'effort' { "effort/$Effort-p$Attempt" }
  '1' { 'batch1/' + $Key + $(if ($OnlySeed) { "-e$OnlySeed" } else { '-w1' }) }
  '2' { 'batch2/' + $Key + $(if ($OnlySeed) { "-e$OnlySeed" } else { '-w1' }) }
  'raise' { 'raise/' + $Key + $(if ($OnlySeed) { "-e$OnlySeed" } else { '-w2' }) }
}
if ($Retry -ge 2) { $name = "$name-a$Retry" }
$expected = "$Root/$name"
if ($Folder -ne $expected) { Stop-Launch "-Folder $Folder does not match the layout for batch $Batch; expected $expected" }
if ((Test-Path -LiteralPath "$Folder/run") -or (Test-Path -LiteralPath "$Folder/run.log")) { Stop-Launch "$Folder already holds a run (run/ or run.log); pick a new -Attempt or -Retry" }

$tasksDir = if (@('smoke', 'pilot', 'effort') -contains $Batch) { 'pilot-tasks' } else { 'tasks' }
$tasks = "$Root/$tasksDir/$Key/tasks-run.json"
$pins = if ($Effort -eq 'medium') { "$Root/pins-r4.json" } else { "$Root/pins-r4-effort-$Effort.json" }
$constraints = "$Root/pip-constraints.txt"
$node = (Get-Command node).Source

# A launch is the only step that spends plan usage, so only it measures the box; a dry run and a plan stop before that.
if (-not $DryRun -and -not $PlanOnly) {
  $boxScript = if ($dryRoot -and $bound.ContainsKey('BoxCheck')) { $BoxCheck } else { $DEFAULT_BOX }
  $box = Invoke-Native $GITBASH @($boxScript)
  if ($box.code -ne 0) {
    foreach ($l in (Lines ($box.out + "`n" + $box.err))) { Write-Output $l }
    Stop-Launch 'box check failed: reboot before a scored session'
  }
}

$pinsRun = Invoke-Native $node @("$Checkout/scripts/token-eval/z0-pins-check.mjs", '--pins', $pins, '--checkout', $Checkout, '--roles', "$Root/pin-roles.txt", '--poetry', $POETRY)
if ($pinsRun.code -ne 0) {
  foreach ($l in (Lines ($pinsRun.out + "`n" + $pinsRun.err))) { Write-Output $l }
  Stop-Launch "pins check failed (exit $($pinsRun.code))" $(if ($pinsRun.code -eq 3) { 3 } else { 1 })
}

# The token: a real root reads the user variable, a DRYRUN root the knobs file's fake one, and neither is ever printed. A plan needs none.
$token = $null
$tokenSource = $null
if (-not $PlanOnly) {
  if ($dryRoot) {
    if (-not (Test-Path -LiteralPath $FakeAgent)) { Stop-Launch "-FakeAgent $FakeAgent does not exist" }
    $knobs = Get-Content -Raw -LiteralPath $FakeAgent | ConvertFrom-Json
    $token = if ($knobs.token) { [string]$knobs.token } else { 'fake-tok-placeholder' }
    $tokenSource = $token
  } else {
    $token = [Environment]::GetEnvironmentVariable($TokenVar, 'User')
    if (-not $token) { Stop-Launch "User env var $TokenVar is not set" }
    $tokenSource = "user env var $TokenVar"
  }
}

. 'C:/eval-authors/s3x-env.ps1'
Set-S3xEnv $Toolchain $Folder
# The runner gives each task its own venv, so the launcher's one venv and its Scripts folder must not be there.
$own = ($Folder -replace '/', '\') + '\venv\Scripts'
$env:PATH = (($env:PATH -split ';') | Where-Object { $_ -and ($_.TrimEnd('\') -ne $own) }) -join ';'
Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue

$out = if ($PlanOnly) { "$Folder/dry" } else { "$Folder/run" }
$a = @("$Checkout/scripts/token-eval/ab-run.mjs", '--tasks', $tasks, '--out', $out, '--design', 'r4', '--effort', $Effort, '--pins', $pins, '--arms', $Arms)
if ($Seeds) { $a += '--seeds', $Seeds }
if ($SeedRule) { $a += '--seed-rule', $SeedRule }
if ($MaxSeed) { $a += '--max-seed', $MaxSeed }
if ($OnlySeed) { $a += '--only-seed', $OnlySeed }
if ($MaxPosition) { $a += '--max-position', $MaxPosition }
$names = @((Get-S3xTool $Toolchain).env.Keys | Where-Object { $_ -ne 'VIRTUAL_ENV' } | Sort-Object)
foreach ($n in $names) { $a += '--pass-env', $n }
if ($Toolchain -eq 'python') { $a += '--venv', '--poetry', $POETRY, '--pip-constraint', $constraints }
if ($dryRoot) { $a += '--fake-agent', $FakeAgent } else {
  $a += '--claude-bin', $CLAUDE
  if ($TokenSchedule) { $a += '--token-schedule', $TokenSchedule, '--token-var', $TokenVar }
}

if ($DryRun) {
  Write-Output ('ab-run argv ' + (ConvertTo-Json -Compress -InputObject @($a)))
  Write-Output "token $tokenSource"
  exit 0
}
if ($PlanOnly) {
  New-Item -ItemType Directory -Force $Folder | Out-Null
  $plan = Invoke-Native $node (($a + '--dry-run'))
  foreach ($l in (Lines $plan.out)) { Write-Output $l }
  if ($plan.code -ne 0) { foreach ($l in (Lines $plan.err)) { Write-Output $l } }
  exit $plan.code
}

New-Item -ItemType Directory -Force $Folder | Out-Null
$env:CLAUDE_CODE_OAUTH_TOKEN = $token
$argText = @($a | ForEach-Object { Quote-Arg $_ })
$p = Start-Process -FilePath $node -ArgumentList $argText -RedirectStandardOutput "$Folder/run.log" -RedirectStandardError "$Folder/run.err" -WindowStyle Hidden -PassThru
Remove-Item Env:CLAUDE_CODE_OAUTH_TOKEN
# Read now, since PowerShell 5.1 loses the exit code of a process whose handle it never took.
$handle = $p.Handle
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::AppendAllText((Split-Path -Parent $Folder) + '/pids.txt', "$Key $($p.Id) $Folder`n", $utf8)
Write-Output "run pid $($p.Id)"
$p.WaitForExit()
$code = $p.ExitCode
New-Item -ItemType Directory -Force "$Folder/run" | Out-Null
[System.IO.File]::WriteAllText("$Folder/run/exit.txt", "$code`n", $utf8)
exit $code
