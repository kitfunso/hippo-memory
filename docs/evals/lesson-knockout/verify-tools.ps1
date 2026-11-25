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
function Assert-Throws([scriptblock]$Block,[string]$Pattern) {
  try { & $Block } catch { if ($_.Exception.Message -match $Pattern) { return }; throw "Expected /$Pattern/, got: $($_.Exception.Message)" }
  throw "Expected a refusal matching /$Pattern/"
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
  . "$PSScriptRoot/toolchain.ps1" python $live
  Assert-Throws { Assert-SessionPath "$scratch\shadow;$env:PATH" python $live } 'outside the python toolchain'
  Restore-Env
  $empty=(Join-Path $scratch 'empty') -replace '\\','/'
  . "$PSScriptRoot/toolchain.ps1" python $empty
  Assert-Throws { Assert-SessionPath $env:PATH python $empty } 'python resolves to .*outside|does not resolve python'
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
} finally {
  Restore-Env
  Remove-Item -LiteralPath $scratch -Recurse -Force
}
Write-Output "Passed private cache paths, Gradle copy, planted launcher, tool resolution and denial parsing for $($cases.Count) declared toolchains."
