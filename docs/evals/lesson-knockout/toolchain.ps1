# Per-task writable caches keep language tools off the shared Z0 stores.
param([string]$Chain,[string]$Live)
. 'C:/eval-authors/s3x-env.ps1'
Set-S3xEnv $Chain $Live
$privateCache="$Live/cache"
$env:GIT_CONFIG_NOSYSTEM='1'
$env:GIT_CONFIG_GLOBAL='NUL'
$env:GIT_CONFIG_COUNT='1'
$env:GIT_CONFIG_KEY_0='safe.directory'
$env:GIT_CONFIG_VALUE_0=([IO.Path]::GetFullPath("$Live/work") -replace '\\','/')
$variables=@('GRADLE_USER_HOME','GOPATH','GOCACHE','NUGET_PACKAGES','DOTNET_CLI_HOME','MIX_HOME','HEX_HOME',
  'CARGO_HOME','RUSTUP_HOME','GEM_HOME','BUNDLE_PATH','JULIA_DEPOT_PATH')
foreach($key in $variables) {
  if ((Get-S3xTool $Chain).env.ContainsKey($key)) {
    [Environment]::SetEnvironmentVariable($key,"$privateCache/$key")
  }
}
if($Chain -eq 'maven') { $env:MAVEN_ARGS="-Dmaven.repo.local=$privateCache/maven" }
if($Chain -eq 'ruby') { $env:GEM_PATH=$env:GEM_HOME }
$env:PNPM_HOME="$privateCache/PNPM_HOME"
$env:npm_config_store_dir="$privateCache/pnpm-store"
$env:pnpm_config_store_dir=$env:npm_config_store_dir
$env:BUNDLE_USER_HOME="$privateCache/bundler"
$env:HEX_CACHE_HOME="$privateCache/hex-cache"
$env:NUGET_HTTP_CACHE_PATH="$privateCache/nuget-http"
$env:NUGET_PLUGINS_CACHE_PATH="$privateCache/nuget-plugins"
$env:POETRY_CACHE_DIR="$privateCache/poetry"
$env:npm_config_cache="$privateCache/npm"
$env:UV_CACHE_DIR="$privateCache/uv"
$env:PIP_CACHE_DIR="$privateCache/pip"
if($Chain -eq 'python') {
  $env:PIP_CONSTRAINT='C:/z0-runs/r4/pip-constraints.txt'
  $env:PATH="$Live/venv/Scripts;C:/z0-runs/r4/poetry-2.5.1/Scripts;$env:PATH"
}
$chainTools=@{ python=@('python','poetry'); maven=@('mvn'); dotnet=@('dotnet'); gradle=@('gradlew'); gradle17=@('gradlew');
  'gradle-android'=@('gradlew'); elixir=@('mix','elixir','erl'); go=@('go'); pnpm=@('pnpm'); npm=@();
  rust=@('cargo'); 'rust-ucrt'=@('cargo'); ruby=@('ruby','bundle'); julia=@('julia') }
function Resolve-OnPath([string[]]$Dirs,[string]$Name) {
  foreach ($dir in $Dirs) {
    foreach ($ext in @('') + ($env:PATHEXT -split ';')) {
      $file=Join-Path $dir ($Name+$ext)
      if (Test-Path -LiteralPath $file -PathType Leaf) { return $file }
    }
  }
  $null
}
$toolFolders=@{ poetry='C:\z0-runs\r4\poetry-2.5.1\Scripts' }
function Get-ChainFolders([string]$Chain,[string]$Root) {
  $root=[IO.Path]::GetFullPath($Root)
  @((Get-S3xTool $Chain).path -replace '\{work\}',$root -split ';' | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') })
}
function Assert-SessionPath([string]$PathValue,[string]$Chain,[string]$Root) {
  $dirs=@($PathValue -split ';' | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"')).TrimEnd('\','/') -replace '/','\' } | Where-Object { $_ })
  if (Resolve-OnPath $dirs 'hippo') { throw 'A hippo launcher resolves on the session PATH' }
  foreach ($tool in @('git','node','npm','npx')) { if (!(Resolve-OnPath $dirs $tool)) { throw "Session PATH lacks $tool" } }
  if (!$chainTools.ContainsKey($Chain)) { throw "No expected tools for toolchain $Chain" }
  $folders=@(Get-ChainFolders $Chain $Root)
  foreach ($tool in $chainTools[$Chain]) {
    $allowed=if ($toolFolders.ContainsKey($tool)) { @($toolFolders[$tool]) } else { $folders }
    foreach ($dir in $allowed) { if (!(Test-Path -LiteralPath $dir -PathType Container)) { throw "Toolchain folder $dir is missing" } }
    $hit=Resolve-OnPath $dirs $tool
    if (!$hit) { throw "Session PATH does not resolve $tool" }
    if ($allowed -notcontains (Split-Path -Parent $hit)) { throw "$tool resolves to $hit, outside the $Chain toolchain" }
  }
  foreach ($key in @('JAVA_HOME','GOROOT','DOTNET_ROOT','ANDROID_HOME')) {
    $value=(Get-S3xTool $Chain).env[$key]
    if ($value -and !(Test-Path -LiteralPath $value -PathType Container)) { throw "Toolchain $key folder $value is missing" }
  }
}
function Copy-GradleProperties([string]$Chain,[string]$Live) {
  $source=(Get-S3xTool $Chain).env['GRADLE_USER_HOME']
  if (!$source) { return $null }
  $private=[IO.Path]::GetFullPath("$Live/cache").TrimEnd('\') + '\'
  $gradleHome=[IO.Path]::GetFullPath($env:GRADLE_USER_HOME).TrimEnd('\')
  if (!$gradleHome.StartsWith($private,[StringComparison]::OrdinalIgnoreCase)) { throw "GRADLE_USER_HOME $gradleHome is outside the private cache" }
  if ($gradleHome -eq [IO.Path]::GetFullPath($source).TrimEnd('\')) { throw 'GRADLE_USER_HOME is the shared Z0 home' }
  $from=Join-Path $source 'gradle.properties'
  $target=Join-Path $gradleHome 'gradle.properties'
  New-Item -ItemType Directory -Force -Path $gradleHome | Out-Null
  Copy-Item -LiteralPath $from -Destination $target -Force
  if ((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $from).Hash) { throw 'Private gradle.properties differs from the Z0 file' }
  $target
}
$hippoLaunchers=@('hippo','hippo.cmd','hippo.ps1','hippo.exe','hippo.bat')
$env:PATH=(@($env:PATH -split ';' | Where-Object {
  $dir=[Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"'))
  $dir -and -not ($hippoLaunchers | Where-Object { Test-Path -LiteralPath (Join-Path $dir $_) })
}) -join ';')
$toolKeys=@('MAVEN_ARGS','npm_config_cache','UV_CACHE_DIR','PIP_CACHE_DIR','PIP_CONSTRAINT',
  'GEM_PATH','PNPM_HOME','npm_config_store_dir','pnpm_config_store_dir','BUNDLE_USER_HOME',
  'HEX_CACHE_HOME','NUGET_HTTP_CACHE_PATH','NUGET_PLUGINS_CACHE_PATH',
  'POETRY_CACHE_DIR','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0') + $variables
