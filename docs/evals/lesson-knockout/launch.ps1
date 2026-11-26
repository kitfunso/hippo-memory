param(
  [Parameter(Mandatory)][string]$Live,
  [ValidateSet('Z0_SUB_TOKEN','Z0_SUB_TOKEN_1','Z0_SUB_TOKEN_2','Z0_SUB_TOKEN_3','Z0_WIRE_DUMMY')][string]$TokenVar='Z0_SUB_TOKEN',
  [switch]$BoxChecked
)
$ErrorActionPreference='Stop'
$base=[IO.Path]::GetFullPath('C:/z0-lessons/lesson-knockout') + '\'
$Live=[IO.Path]::GetFullPath($Live)
if (-not $Live.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) { throw 'Outside experiment root' }
$scored=$Live -eq (Join-Path $base 'active\live')
$records=if ($scored) { Join-Path $base 'active\operator' } else { $Live }
$call=Get-Content -Encoding UTF8 -Raw -LiteralPath "$records/call.json" | ConvertFrom-Json
if ($scored -eq $call.smoke) { throw 'Unexpected session mode for this directory' }
$dummy=$TokenVar -eq 'Z0_WIRE_DUMMY'
if ($dummy -and !($call.smoke -and $call.diagnostic)) { throw 'The dummy credential runs only a diagnostic smoke' }
if ($call.smoke -and !$dummy -and $TokenVar -ne 'Z0_SUB_TOKEN') { throw 'Smoke requires Z0_SUB_TOKEN' }
$credential=[Environment]::GetEnvironmentVariable($TokenVar,$(if ($dummy) { 'Process' } else { 'User' }))
if ($scored -and !$BoxChecked) { throw 'Scored attempts require the unit runner box check' }
. "$PSScriptRoot/toolchain.ps1" $call.toolchain $Live
. "$PSScriptRoot/record.ps1"
$pi=New-Object Diagnostics.ProcessStartInfo
$pi.FileName='C:/z0-runs/scored/bin/claude.exe'
$pi.WorkingDirectory="$Live/work"
$pi.UseShellExecute=$false
$pi.CreateNoWindow=$true
$pi.RedirectStandardInput=$true
$pi.RedirectStandardOutput=$true
$pi.RedirectStandardError=$true
$pi.StandardOutputEncoding=New-Object Text.UTF8Encoding($false)
$pi.EnvironmentVariables.Clear()
$system=@('PATH','PATHEXT','SystemRoot','WINDIR','COMSPEC','SYSTEMDRIVE','ProgramFiles','ProgramFiles(x86)','ProgramData','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS')
foreach ($key in ($system + @((Get-S3xTool $call.toolchain).env.Keys) + $toolKeys)) {
  $v=[Environment]::GetEnvironmentVariable($key)
  if ($v) { $pi.EnvironmentVariables[$key]=$v }
}
$private=@{ HOME="$Live/home"; USERPROFILE="$Live/home"; CLAUDE_CONFIG_DIR="$Live/home/.claude";
  APPDATA="$Live/home/roaming"; LOCALAPPDATA="$Live/home/local"; TEMP="$Live/home/tmp"; TMP="$Live/home/tmp";
  HIPPO_HOME="$Live/home/.hippo"; CLAUDE_CODE_PROJECT_DIR_NAME='unit'; CLAUDE_CODE_DISABLE_AUTO_MEMORY='0';
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1'; CLAUDE_CODE_GATEWAY_HINT_HEADERS='1'; DISABLE_AUTOUPDATER='1'; GIT_TERMINAL_PROMPT='0'; EVAL_SEED='1' }
foreach ($k in $private.Keys) { $pi.EnvironmentVariables[$k]=$private[$k] }
foreach ($p in (Get-WireEnv $call)) { $pi.EnvironmentVariables[$p.Name]=[string]$p.Value }
Assert-WireOnly $pi.EnvironmentVariables
if ($call.smoke) { Assert-SmokePath $pi.EnvironmentVariables['PATH'] } else { Assert-SessionPath $pi.EnvironmentVariables['PATH'] $call.toolchain $Live }
$pi.EnvironmentVariables['CLAUDE_CODE_OAUTH_TOKEN']=$credential
$credential=$null
if ($pi.EnvironmentVariables['CLAUDE_CODE_OAUTH_TOKEN'] -notlike 'sk-ant-oat*') { throw 'Missing subscription credential or unexpected credential type' }
if ($dummy -and $pi.EnvironmentVariables['CLAUDE_CODE_OAUTH_TOKEN'] -cnotmatch '^sk-ant-oat01-(wirecanary)+$') { throw 'Unexpected dummy credential' }
$argv=@('-p','--output-format','json','--setting-sources','','--strict-mcp-config','--settings',"$Live/settings.json",'--model',$call.model,'--effort',$call.effort)
if ($call.diagnostic) {
  if (!$call.smoke -or $call.resume) { throw 'Invalid diagnostic' }
  $argv+=@('--restricted','--permission-mode','dontAsk','--tools','','--max-turns','1')
} elseif ($call.smoke) {
  $maxTurns=if ($call.frozenSmoke) { '2' } else { '3' }
  $argv+=@('--restricted','--permission-mode','acceptEdits','--tools','Read,Glob,Grep,Edit,Write','--max-turns',$maxTurns)
} else { $argv+=@('--permission-mode','bypassPermissions') }
if ($call.resume) { $argv+=@('--resume',$call.session) } else { $argv+=@('--session-id',$call.session) }
$pi.Arguments=(($argv | ForEach-Object { '"'+$_+'"' }) -join ' ')
$p=New-Object Diagnostics.Process
$p.StartInfo=$pi
if (-not $p.Start()) { throw 'Claude Code failed to start' }
$pi.EnvironmentVariables.Remove('CLAUDE_CODE_OAUTH_TOKEN')
$out=$p.StandardOutput.ReadToEndAsync()
$err=$p.StandardError.ReadToEndAsync()
# Write UTF-8 without the console code page or a byte-order mark.
$bytes=[Text.Encoding]::UTF8.GetBytes($call.prompt)
$p.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
$p.StandardInput.BaseStream.Close()
if (-not $p.WaitForExit(3600000)) { & taskkill /PID $p.Id /T /F | Out-Null; throw 'Owned session timed out' }
$p.WaitForExit()
$result=$null
try { $result=($out.Result.Trim() | ConvertFrom-Json) } catch { if(!$out.IsCompleted){throw} }
if ($result -and $result.session_id -ne $call.session) { throw 'Session id mismatch' }
$capped=$call.smoke -and $result.subtype -eq 'error_max_turns'
$stopped=!$result -or (($p.ExitCode -ne 0 -or $result.is_error) -and !$capped)
$denials=$null
if ($result) { . "$PSScriptRoot/denials.ps1"; $denials=Get-PermissionDenials $result }
Write-CallRecord "$records/$($call.id).json" (New-CallRecord $call $bytes $p.ExitCode $result $stopped $denials)
if ($stopped) { exit 75 }
