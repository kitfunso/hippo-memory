$ErrorActionPreference='Stop'
$scratch=Join-Path ([IO.Path]::GetTempPath()) ('knockout-tools-'+[guid]::NewGuid())
$live=(Join-Path $scratch 'live') -replace '\\','/'
New-Item -ItemType Directory -Force -Path "$live/venv/Scripts","$scratch/planted","$scratch/shadow","$scratch/empty/venv/Scripts" | Out-Null
foreach ($file in @("$live/venv/Scripts/python.exe","$scratch/shadow/python.exe")) { Set-Content -LiteralPath $file -Value '' }
Set-Content -LiteralPath "$scratch/planted/hippo.cmd" -Value '@exit /b 0'
$saved=[Environment]::GetEnvironmentVariables('Process')
function Restore-Env {
  foreach ($key in @([Environment]::GetEnvironmentVariables('Process').Keys)) { if (!$saved.Contains($key)) { [Environment]::SetEnvironmentVariable($key,$null) } }
  foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key,$saved[$key]) }
}
function Assert-Throws([scriptblock]$Block,[string]$Pattern,[string]$Label='') {
  $tag=if ($Label) { " [$Label]" } else { '' }
  try { & $Block } catch { if ($_.Exception.Message -match $Pattern) { return }; throw "Expected /$Pattern/$tag, got: $($_.Exception.Message)" }
  throw "Expected a refusal matching /$Pattern/$tag"
}
function Test-GradleRefusal([string]$Name,[string]$LinkRelative,[string]$HomeRelative) {
  $jlive=(Join-Path $scratch "j-$Name/live") -replace '\\','/'
  $outside=Join-Path $scratch "j-$Name/outside"
  $link=Join-Path $jlive $LinkRelative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $link),$outside | Out-Null
  New-Item -ItemType Junction -Path $link -Target $outside | Out-Null
  $env:GRADLE_USER_HOME=Join-Path $jlive $HomeRelative
  try { Assert-Throws { Copy-GradleProperties gradle $jlive } 'reparse point' }
  finally { [IO.Directory]::Delete($link) }
  if (@(Get-ChildItem -LiteralPath $outside -Recurse -Force).Count) { throw "Gradle copy escaped through the $Name junction" }
}
function Remove-PathEntry([string]$PathValue,[string[]]$Drop) {
  (($PathValue -split ';') | Where-Object { $Drop -notcontains (($_ -replace '/','\').TrimEnd('\')) }) -join ';'
}
$cases=@{
  npm=@('npm_config_cache'); pnpm=@('PNPM_HOME','npm_config_store_dir'); python=@('PIP_CACHE_DIR','UV_CACHE_DIR','POETRY_CACHE_DIR')
  gradle=@('GRADLE_USER_HOME'); gradle17=@('GRADLE_USER_HOME'); 'gradle-android'=@('GRADLE_USER_HOME')
  rust=@('CARGO_HOME','RUSTUP_HOME'); 'rust-ucrt'=@('CARGO_HOME','CARGO_TARGET_DIR')
  ruby=@('GEM_PATH','GEM_HOME','BUNDLE_PATH'); julia=@('JULIA_DEPOT_PATH'); maven=@('MAVEN_ARGS')
  elixir=@('MIX_HOME','HEX_HOME','HEX_CACHE_HOME'); go=@('GOPATH','GOCACHE'); dotnet=@('NUGET_PACKAGES','DOTNET_CLI_HOME')
}
try {
  foreach ($chain in $cases.Keys) {
    $env:PATH="$scratch\planted;$env:PATH"
    . "$PSScriptRoot/toolchain.ps1" $chain $live
    foreach ($key in $cases[$chain]) {
      $value=[Environment]::GetEnvironmentVariable($key) -replace '\\','/'
      if (!$value.Contains($live) -or $value.Contains('eval-envs')) { throw "Shared writable cache for $chain / $key" }
    }
    Assert-SessionPath $env:PATH $chain $live
    Assert-Throws { Assert-SessionPath "$scratch\planted;$env:PATH" $chain $live } 'hippo launcher'
    $copied=Copy-GradleProperties $chain $live
    if ($chain -like 'gradle*') {
      $source=Join-Path (Get-S3xTool $chain).env['GRADLE_USER_HOME'] 'gradle.properties'
      if (!$copied -or (Get-FileHash -LiteralPath $copied).Hash -ne (Get-FileHash -LiteralPath $source).Hash) { throw "Gradle properties missing for $chain" }
      $env:GRADLE_USER_HOME=(Get-S3xTool $chain).env['GRADLE_USER_HOME']
      Assert-Throws { Copy-GradleProperties $chain $live } 'outside the private cache'
      Remove-Item -LiteralPath "$live/cache/GRADLE_USER_HOME" -Recurse -Force
    } elseif ($copied -or (Test-Path -LiteralPath "$live/cache/GRADLE_USER_HOME")) { throw "Unexpected Gradle home for $chain" }
    Restore-Env
  }
  foreach ($target in @("$scratch\planted","$scratch\empty")) {
    $env:KO_PATH_PROBE=$target
    $env:PATH="%KO_PATH_PROBE%;$env:PATH"
    . "$PSScriptRoot/toolchain.ps1" python $live
    if (@($env:PATH -split ';' | Where-Object { $_.Contains('%') }).Count) { throw "A PATH entry with a variable survived the launcher filter" }
    Restore-Env
  }
  . "$PSScriptRoot/toolchain.ps1" python $live
  Assert-Throws { Assert-SessionPath "$scratch\shadow;$env:PATH" python $live } 'outside the python toolchain'
  Restore-Env
  $empty=(Join-Path $scratch 'empty') -replace '\\','/'
  . "$PSScriptRoot/toolchain.ps1" python $empty
  Assert-Throws { Assert-SessionPath $env:PATH python $empty } 'python resolves to .*outside|does not resolve python'
  Assert-SmokePath $env:PATH
  Assert-Throws { Assert-SmokePath "$scratch\planted;$env:PATH" } 'hippo launcher'
  Assert-Throws { Assert-SmokePath "$scratch\empty" } 'Session PATH lacks git'
  Restore-Env
  . "$PSScriptRoot/toolchain.ps1" ruby $live
  $rubyDirs=@(Get-ChainFolders ruby $live)
  $rubyLast=[regex]::Escape($rubyDirs[-1])
  Assert-Throws { Assert-SessionPath (Remove-PathEntry $env:PATH @($rubyDirs[-1])) ruby $live } "$rubyLast is not on the session PATH"
  $variant=(($env:PATH -split ';') | ForEach-Object { if ($rubyDirs -contains $_.TrimEnd('\')) { ($_.ToUpperInvariant() -replace '\\','/') + '/' } else { $_ } }) -join ';'
  Assert-SessionPath $variant ruby $live
  Restore-Env
  foreach ($chain in @('rust','go')) {
    . "$PSScriptRoot/toolchain.ps1" $chain $live
    $tail=@(Get-ChainFolders $chain $live 'tail')
    if ($tail.Count -ne 1 -or $tail[0] -notmatch 'rust-as$|ucrt64\\bin$') { throw "Unexpected $chain tail folders: $($tail -join ';')" }
    Assert-SessionPath $env:PATH $chain $live
    Assert-Throws { Assert-SessionPath (Remove-PathEntry $env:PATH $tail) $chain $live } "$([regex]::Escape($tail[0])) is not on the session PATH"
    Restore-Env
  }
  . "$PSScriptRoot/toolchain.ps1" rust $live
  $registry=${function:Get-S3xTool}
  ${function:Get-S3xTool}={ param([string]$Toolchain) $tool=(& $registry $Toolchain).Clone(); $tool.tail='{work}\missing-tail'; $tool }
  $missingTail=Join-Path ([IO.Path]::GetFullPath($live)) 'missing-tail'
  if (Test-Path -LiteralPath $missingTail) { throw "Fixture folder $missingTail exists" }
  Assert-Throws { Assert-SessionPath "$env:PATH;$missingTail" rust $live } "$([regex]::Escape($missingTail)) is missing"
  ${function:Get-S3xTool}=$registry
  Restore-Env
  . "$PSScriptRoot/toolchain.ps1" python $live
  Assert-Throws { Assert-SessionPath (Remove-PathEntry $env:PATH @('C:\z0-runs\r4\poetry-2.5.1\Scripts')) python $live } 'poetry-2.5.1.Scripts is not on the session PATH'
  Restore-Env
  . "$PSScriptRoot/toolchain.ps1" gradle $live
  foreach ($refusal in @(@('home','cache/GRADLE_USER_HOME','cache/GRADLE_USER_HOME'),@('parent','cache/linked','cache/linked/GRADLE_USER_HOME'),@('cache','cache','cache/GRADLE_USER_HOME'))) {
    Test-GradleRefusal $refusal[0] $refusal[1] $refusal[2]
  }
  $existing=(Join-Path $scratch 'j-existing/live') -replace '\\','/'
  $env:GRADLE_USER_HOME=Join-Path $existing 'cache/GRADLE_USER_HOME'
  New-Item -ItemType Directory -Force -Path $env:GRADLE_USER_HOME | Out-Null
  $planted=Join-Path $env:GRADLE_USER_HOME 'gradle.properties'
  Set-Content -LiteralPath $planted -Value 'planted'
  Assert-Throws { Copy-GradleProperties gradle $existing } 'already exists'
  if ((Get-Content -LiteralPath $planted -Raw).Trim() -ne 'planted') { throw 'Existing gradle.properties was overwritten' }
  Restore-Env
  . "$PSScriptRoot/denials.ps1"
  $parse={ param($text) Get-PermissionDenials ($text | ConvertFrom-Json) }
  $none=& $parse '{"permission_denials":[]}'
  $one=& $parse '{"permission_denials":[{"tool_name":"Edit","tool_use_id":"t1"}]}'
  if ($none -isnot [array] -or $none.Count -ne 0) { throw 'Empty denial list changed' }
  if ($one -isnot [array] -or $one.Count -ne 1 -or $one[0].tool -ne 'Edit' -or $one[0].id -ne 't1') { throw 'Single denial lost' }
  $json=([ordered]@{none=$none;one=$one} | ConvertTo-Json -Compress -Depth 4)
  if ($json -ne '{"none":[],"one":[{"tool":"Edit","id":"t1"}]}') { throw "Denials saved as $json" }
  foreach ($bad in @('{}','{"permission_denials":null}','{"permission_denials":{"tool_name":"Edit","tool_use_id":"t"}}',
    '{"permission_denials":[null]}','{"permission_denials":[{"tool_name":"Edit"}]}','{"permission_denials":[{"tool_use_id":"t"}]}')) {
    Assert-Throws { & $parse $bad } 'permission_denials'
  }
  foreach ($bad in @('{"permission_denials":[{"tool_name":5,"tool_use_id":"t"}]}','{"permission_denials":[{"tool_name":"Edit","tool_use_id":{"a":1}}]}',
    '{"permission_denials":[{"tool_name":["Edit"],"tool_use_id":"t"}]}','{"permission_denials":[{"tool_name":"Edit","tool_use_id":true}]}',
    '{"permission_denials":[{"tool_name":"","tool_use_id":"t"}]}')) {
    Assert-Throws { & $parse $bad } 'Malformed permission_denials entry'
  }
  . "$PSScriptRoot/record.ps1"
  $prompt="line one`nunicode: caf$([char]0xE9) $([char]0x4E2D) $([char]0xD83D)$([char]0xDE00)"
  $promptBytes=[Text.Encoding]::UTF8.GetBytes($prompt)
  $promptFile=Join-Path $scratch 'prompt.bin'
  [IO.File]::WriteAllBytes($promptFile,$promptBytes)
  $digest=(Get-FileHash -Algorithm SHA256 -LiteralPath $promptFile).Hash.ToLowerInvariant()
  $call=[pscustomobject]@{id='apply';session='11111111-1111-1111-1111-111111111111';apparatus=3;prompt=$prompt}
  $cut=New-CallRecord $call $promptBytes 1 $null $true $null
  if ($cut.promptSha256 -cne $digest) { throw 'Prompt digest differs from an independent SHA-256 of the UTF-8 bytes' }
  $cutJson=$cut | ConvertTo-Json -Compress -Depth 12
  $cutWant='{"session":"11111111-1111-1111-1111-111111111111","call":"apply","promptSha256":"'+$digest+'","json":false,"exit":1,"apparatus":3,"stopped":true,"permissionDenials":null}'
  if ($cutJson -cne $cutWant) { throw "No-JSON record saved as $cutJson" }
  $reply='{"session_id":"11111111-1111-1111-1111-111111111111","subtype":"success","is_error":false,"num_turns":2,"usage":{"input_tokens":5},"modelUsage":{"m1":{"x":1}},"permission_denials":[]}' | ConvertFrom-Json
  $full=New-CallRecord $call $promptBytes 0 $reply $false (Get-PermissionDenials $reply)
  $fullJson=$full | ConvertTo-Json -Compress -Depth 12
  $fullWant='{"session":"11111111-1111-1111-1111-111111111111","call":"apply","promptSha256":"'+$digest+'","json":true,"subtype":"success","isError":false,"turns":2,"usage":{"input_tokens":5},"models":["m1"],"exit":0,"apparatus":3,"stopped":false,"permissionDenials":[]}'
  if ($fullJson -cne $fullWant) { throw "Normal record saved as $fullJson" }
  if ((New-CallRecord $call $promptBytes 75 $reply $true @()).stopped -ne $true) { throw 'Stop flag lost' }
  $recordFile=Join-Path $scratch 'record.json'
  Write-CallRecord $recordFile $cut
  $recordBytes=[IO.File]::ReadAllBytes($recordFile)
  if ($recordBytes[0] -eq 0xEF) { throw 'Call record has a byte-order mark' }
  if (([Text.Encoding]::UTF8.GetString($recordBytes) | ConvertFrom-Json).promptSha256 -cne $digest) { throw 'Saved call record lost the prompt digest' }
  $tokens=$null
  $errors=$null
  $launch=[Management.Automation.Language.Parser]::ParseFile("$PSScriptRoot/launch.ps1",[ref]$tokens,[ref]$errors)
  if ($errors.Count) { throw "launch.ps1 does not parse: $($errors[0].Message)" }
  $ifs=@($launch.FindAll({ param($node) $node -is [Management.Automation.Language.IfStatementAst] },$true))
  $smokeIf=@($ifs | Where-Object { $_.Clauses[0].Item1.Extent.Text -eq '$call.smoke' -and $_.Clauses[0].Item2.Extent.Text -match 'Assert-SmokePath' -and $_.ElseClause.Extent.Text -match 'Assert-SessionPath' })
  if ($smokeIf.Count -ne 1) { throw 'launch.ps1 does not pick Assert-SmokePath for a smoke call' }
  $stopIf=@($ifs | Where-Object { $_.Clauses[0].Item1.Extent.Text -eq '$stopped' -and $_.Clauses[0].Item2.Extent.Text -match '^\{\s*exit 75\s*\}$' })
  if ($stopIf.Count -ne 1) { throw 'launch.ps1 does not exit 75 on a stopped call' }
  if ($launch.Extent.Text -match 'usage limit|limit reached|hit your|rate_limit_error|overloaded_error') { throw 'launch.ps1 still reads limit wording' }
  $writes=@($launch.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Write-CallRecord' },$true))
  if ($writes.Count -ne 1) { throw 'launch.ps1 must write one call record through Write-CallRecord' }
  if ($writes[0].Extent.StartOffset -gt $stopIf[0].Extent.StartOffset) { throw 'launch.ps1 exits before it writes the call record' }
  $stopSets=@($launch.FindAll({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$stopped' },$true))
  if ($stopSets.Count -ne 1) { throw 'launch.ps1 does not set the stop flag once' }
  $stopRule=[scriptblock]::Create('param($p,$result,$capped) '+$stopSets[0].Right.Extent.Text)
  foreach ($case in @(@('clean',0,$false,$false,$false),@('is-error',0,$true,$false,$true),@('exit-1',1,$false,$false,$true),@('capped',1,$true,$true,$false))) {
    $got=[bool](& $stopRule ([pscustomobject]@{ExitCode=$case[1]}) ([pscustomobject]@{is_error=$case[2]}) $case[3])
    if ($got -ne $case[4]) { throw "launch.ps1 stop rule is wrong for the $($case[0]) case" }
  }
  if (-not [bool](& $stopRule ([pscustomobject]@{ExitCode=0}) $null $false)) { throw 'launch.ps1 stop rule is wrong for the no-json case' }
  $named={ param($Name) @($launch.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq $Name },$true)) }
  if ((& $named 'Get-WireEnv').Count -ne 1 -or (& $named 'Assert-WireOnly').Count -ne 1) { throw 'launch.ps1 does not take and check its wire settings once' }
  if ($launch.Extent.Text -match 'OTEL_|Get-DispatchEnv') { throw 'launch.ps1 still sets a telemetry or dispatch log setting' }
  $settings=[ordered]@{HTTPS_PROXY='http://wire:0123456789abcdef0123456789abcdef@127.0.0.1:50123';NO_PROXY='127.0.0.1,localhost';NODE_EXTRA_CA_CERTS='C:/z0-lessons/lesson-knockout/wire-ca/ca.pem'}
  $callWith={ param([scriptblock]$Change) $d=[ordered]@{}; foreach ($k in $settings.Keys) { $d[$k]=$settings[$k] }; & $Change $d; [pscustomobject]@{wireEnv=[pscustomobject]$d} }
  if (@(Get-WireEnv (& $callWith {})).Count -ne 3) { throw 'Valid wire settings were refused' }
  Assert-Throws { Get-WireEnv (& $callWith { param($d) $d['HTTP_PROXY']='http://127.0.0.1:1' }) } 'Unexpected wire settings'
  Assert-Throws { Get-WireEnv (& $callWith { param($d) $d.Remove('NO_PROXY') }) } 'Unexpected wire settings'
  Assert-Throws { Get-WireEnv (& $callWith { param($d) $d.Remove('NO_PROXY'); $d['ANTHROPIC_UNIX_SOCKET']='C:/pipe' }) } 'Unexpected wire settings'
  Assert-Throws { Get-WireEnv (& $callWith { param($d) $d['HTTPS_PROXY']='http://proxy.example:8080' }) } 'not a local listener' 'proxy-host'
  Assert-Throws { Get-WireEnv (& $callWith { param($d) $d['HTTPS_PROXY']='http://127.0.0.1:50123' }) } 'not a local listener' 'proxy-no-auth'
  Assert-Throws { Get-WireEnv (& $callWith { param($d) $d['HTTPS_PROXY']='http://wire:0123456789abcdef0123456789abcdef@proxy.example:8080' }) } 'not a local listener' 'proxy-remote-host'
  Assert-Throws { Get-WireEnv (& $callWith { param($d) $d['HTTPS_PROXY']='http://wire:0123456789abcdef0123456789abcdef@127.0.0.1:0' }) } 'not a local listener' 'proxy-port-zero'
  Assert-Throws { Get-WireEnv (& $callWith { param($d) $d['HTTPS_PROXY']='http://wire:0123456789abcdef0123456789abcdef@127.0.0.1:65536' }) } 'not a local listener' 'proxy-port-high'
  Assert-Throws { Get-WireEnv (& $callWith { param($d) $d['HTTPS_PROXY']=@('http://wire:0123456789abcdef0123456789abcdef@127.0.0.1:50123') }) } 'not a local listener' 'proxy-array'
  Assert-Throws { Get-WireEnv (& $callWith { param($d) $d['HTTPS_PROXY']="http://wire:0123456789abcdef0123456789abcdef@127.0.0.1:50123`n" }) } 'not a local listener' 'proxy-trailing-lf'
  Assert-Throws { Get-WireEnv (& $callWith { param($d) $d['NO_PROXY']='*' }) } 'Unexpected wire bypass list'
  Assert-Throws { Get-WireEnv (& $callWith { param($d) $d['NODE_EXTRA_CA_CERTS']='C:/other/ca.pem' }) } 'Unexpected wire CA'
  Assert-Throws { Get-WireEnv ([pscustomobject]@{id='probe'}) } 'Unexpected wire settings'
  $applied=(New-Object Diagnostics.ProcessStartInfo).EnvironmentVariables
  $applied.Clear()
  foreach ($k in @('PATH','SystemRoot','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) { $applied[$k]='x' }
  foreach ($p in (Get-WireEnv (& $callWith {}))) { $applied[$p.Name]=[string]$p.Value }
  Assert-WireOnly $applied
  foreach ($k in @('ANTHROPIC_UNIX_SOCKET','ANTHROPIC_BASE_URL','http_proxy','ALL_PROXY','CLAUDE_CODE_USE_BEDROCK','OTEL_LOG_RAW_API_BODIES','NODE_TLS_REJECT_UNAUTHORIZED','SSL_CERT_FILE')) {
    $applied[$k]='x'
    Assert-Throws { Assert-WireOnly $applied } 'Unexpected network setting'
    $applied.Remove($k)
  }
} catch {
  $ex=$_.Exception
  $msg=($ex.Message -split "\r?\n")[0].Trim()
  if ($ex -is [IO.IOException] -or $ex -is [UnauthorizedAccessException] -or $ex -is [OutOfMemoryException]) {
    [Console]::Error.WriteLine("VERIFY_INFRA: $($ex.GetType().Name): $msg")
  } else {
    [Console]::Error.WriteLine("VERIFY_FAIL: $msg")
  }
  throw
} finally {
  Restore-Env
  Remove-Item -LiteralPath $scratch -Recurse -Force
}
Write-Output "Passed private cache paths, Gradle copy and junction refusal, planted launcher, tool resolution, smoke path, call records, wire settings and denial parsing for $($cases.Count) declared toolchains."
