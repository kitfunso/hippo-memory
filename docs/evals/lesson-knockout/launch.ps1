param(
  [Parameter(Mandatory)][string]$Live,
  [ValidateSet('Z0_SUB_TOKEN','Z0_SUB_TOKEN_1','Z0_SUB_TOKEN_2','Z0_SUB_TOKEN_3')][string]$TokenVar='Z0_SUB_TOKEN'
)
$ErrorActionPreference='Stop'
$base=[IO.Path]::GetFullPath('C:/z0-lessons/lesson-knockout') + '\'
$Live=[IO.Path]::GetFullPath($Live)
if (-not $Live.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) { throw 'Outside experiment root' }
$call=Get-Content -Encoding UTF8 -Raw -LiteralPath "$Live/call.json" | ConvertFrom-Json
if ($call.smoke -and $TokenVar -ne 'Z0_SUB_TOKEN') { throw 'Smoke requires Z0_SUB_TOKEN' }
. "$PSScriptRoot/toolchain.ps1" $call.toolchain $Live
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
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1'; CLAUDE_CODE_SUBPROCESS_ENV_SCRUB='1'; DISABLE_AUTOUPDATER='1';
  OTEL_LOG_RAW_API_BODIES="file:$Live/bodies/$($call.id)"; GIT_TERMINAL_PROMPT='0'; EVAL_SEED='1' }
foreach ($k in $private.Keys) { $pi.EnvironmentVariables[$k]=$private[$k] }
$pi.EnvironmentVariables['CLAUDE_CODE_OAUTH_TOKEN']=[Environment]::GetEnvironmentVariable($TokenVar,'User')
if ($pi.EnvironmentVariables['CLAUDE_CODE_OAUTH_TOKEN'] -notlike 'sk-ant-oat*') { throw 'Missing subscription credential or unexpected credential type' }
$argv=@('-p','--output-format','json','--setting-sources','project','--strict-mcp-config','--settings',"$Live/settings.json",'--model',$call.model,'--effort',$call.effort)
if ($call.diagnostic) {
  if (!$call.smoke -or $call.resume) { throw 'Invalid diagnostic' }
  $argv+=@('--restricted','--permission-mode','dontAsk','--tools','','--max-turns','1')
} elseif ($call.smoke) {
  $argv+=@('--restricted','--permission-mode','acceptEdits','--tools','Read,Glob,Grep,Edit,Write','--max-turns','3')
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
try { $result=($out.Result.Trim() | ConvertFrom-Json) } catch { throw "Claude Code returned no JSON (exit $($p.ExitCode))" }
if ($result.session_id -ne $call.session) { throw 'Session id mismatch' }
# The operator record contains counters and status only. The CLI owns transcript evidence.
$record=[ordered]@{session=$result.session_id;subtype=$result.subtype;isError=$result.is_error;turns=$result.num_turns;usage=$result.usage;models=@($result.modelUsage.PSObject.Properties.Name);exit=$p.ExitCode}
[IO.File]::WriteAllText("$Live/$($call.id).json",($record | ConvertTo-Json -Depth 12),(New-Object Text.UTF8Encoding($false)))
if (($p.ExitCode -ne 0 -or $result.is_error) -and -not ($call.smoke -and $result.subtype -eq 'error_max_turns')) { throw "Claude Code stopped ($($result.subtype), exit $($p.ExitCode))" }
