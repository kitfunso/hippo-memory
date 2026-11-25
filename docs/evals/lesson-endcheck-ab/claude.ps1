param(
  [Parameter(Mandatory)][ValidateSet('Z0_SUB_TOKEN','Z0_SUB_TOKEN_1','Z0_SUB_TOKEN_2','Z0_SUB_TOKEN_3')][string]$TokenVar,
  [Parameter(Mandatory)][ValidateSet('apply','pick')][string]$Mode,
  [Parameter(Mandatory)][string]$SessionId,
  [Parameter(Mandatory)][string]$Settings,
  [Parameter(Mandatory)][string]$PromptFile
)
$ErrorActionPreference = 'Stop'
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
$info.EnvironmentVariables['CLAUDE_CODE_OAUTH_TOKEN'] = [Environment]::GetEnvironmentVariable($TokenVar,'User')
if (!$info.EnvironmentVariables['CLAUDE_CODE_OAUTH_TOKEN']) { throw 'Selected User credential unavailable' }
$child = [Diagnostics.Process]::Start($info)
$info.EnvironmentVariables.Remove('CLAUDE_CODE_OAUTH_TOKEN')
$out = $child.StandardOutput.ReadToEndAsync()
$errStream = $child.StandardError.ReadToEndAsync()
$promptBytes = [IO.File]::ReadAllBytes($PromptFile)
$child.StandardInput.BaseStream.Write($promptBytes,0,$promptBytes.Length)
$child.StandardInput.Close()
if (!$child.WaitForExit(1800000)) {
  & "$env:SystemRoot\System32\taskkill.exe" /PID $child.Id /T /F | Out-Null
  throw 'Owned Claude Code session timed out'
}
$null = $errStream.Result
if ($child.ExitCode -ne 0) { throw "Claude Code exited $($child.ExitCode)" }
$result = $out.Result | ConvertFrom-Json
if ($result.is_error -or $result.subtype -ne 'success' -or $result.session_id -ne $SessionId) {
  throw 'Claude Code returned an incomplete session'
}
if ($Mode -eq 'pick') { [Console]::WriteLine($result.result) }
else { [Console]::WriteLine($result.session_id) }

