param(
  [Parameter(Mandatory)][ValidateSet('Z0_SUB_TOKEN','Z0_SUB_TOKEN_1','Z0_SUB_TOKEN_2','Z0_SUB_TOKEN_3')][string]$TokenVar,
  [Parameter(Mandatory)][ValidateSet('apply','pick')][string]$Mode,
  [Parameter(Mandatory)][string]$SessionId,
  [Parameter(Mandatory)][string]$Settings,
  [Parameter(Mandatory)][string]$PromptFile,
  [Parameter(Mandatory)][ValidateSet('ON','OFF')][string]$Arm,
  [Parameter(Mandatory)][string]$SeedHash,
  [Parameter(Mandatory)][string]$Intent
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'limit.ps1')
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = 'C:\z0-runs\scored\bin\claude.exe'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.WorkingDirectory = (Get-Location).Path
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
$info.Arguments = '-p --output-format json --strict-mcp-config --setting-sources project --settings "' +
  $Settings + '" --session-id ' + ([guid]$SessionId).ToString()
if ($Mode -eq 'apply') {
  $info.Arguments += ' --model claude-opus-5-5 --permission-mode bypassPermissions'
} else {
  $info.Arguments += ' --model claude-sonnet-5-5 --tools ""'
}
foreach ($name in @($info.EnvironmentVariables.Keys)) {
  if ($name -match '^(ANTHROPIC_|Z0_SUB_|HIPPO_LLM_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_)') {
    $info.EnvironmentVariables.Remove($name)
  }
}
$promptBytes = [IO.File]::ReadAllBytes($PromptFile)
if (!$promptBytes.Length) { throw 'Empty prompt' }
if (![IO.File]::Exists($info.FileName)) { throw 'Claude Code executable unavailable' }
$null = [IO.File]::ReadAllText($Settings) | ConvertFrom-Json
$info.EnvironmentVariables['CLAUDE_CODE_OAUTH_TOKEN'] = [Environment]::GetEnvironmentVariable($TokenVar,'User')
if ([string]::IsNullOrWhiteSpace($info.EnvironmentVariables['CLAUDE_CODE_OAUTH_TOKEN'])) { throw 'Selected User credential unavailable' }
$slot = [IO.Path]::GetDirectoryName($PromptFile)
$dispatch = @{id=$SessionId;dir=$slot;pre=$env:LESSON_PRE;arm=$Arm;seedHash=$SeedHash;tokenVar=$TokenVar}
$staged = [IO.Path]::Combine($slot,"$SessionId.pending.json")
[IO.File]::WriteAllText($staged,($dispatch | ConvertTo-Json -Compress))
[IO.File]::Move($staged,$Intent)
try { $child = [Diagnostics.Process]::Start($info) }
catch { [IO.File]::Move($Intent,$staged); throw }
$info.EnvironmentVariables.Remove('CLAUDE_CODE_OAUTH_TOKEN')
$out = $child.StandardOutput.ReadToEndAsync()
$errStream = $child.StandardError.ReadToEndAsync()
$child.StandardInput.BaseStream.Write($promptBytes,0,$promptBytes.Length)
$child.StandardInput.Close()
if (!$child.WaitForExit($SessionTimeoutMs)) {
  & "$env:SystemRoot\System32\taskkill.exe" /PID $child.Id /T /F | Out-Null
  throw 'Owned Claude Code session timed out'
}
$result = $null
try { $result = $out.Result | ConvertFrom-Json } catch {
  try { $result = ($out.Result.Trim() -split "\n")[-1] | ConvertFrom-Json } catch { $result = $null }
}
# Only the classification leaves the launcher. Child output can contain task text.
if (Test-SubscriptionLimit $result ($out.Result + [Environment]::NewLine + $errStream.Result)) {
  [Console]::WriteLine('LIMITED')
  exit 0
}
if ($child.ExitCode -ne 0) { throw "Claude Code exited $($child.ExitCode)" }
if ($result.is_error -or $result.subtype -ne 'success' -or $result.session_id -ne $SessionId) {
  throw 'Claude Code returned an incomplete session'
}
if ($Mode -eq 'pick') { [Console]::WriteLine($result.result) }
else { [Console]::WriteLine($result.session_id) }

