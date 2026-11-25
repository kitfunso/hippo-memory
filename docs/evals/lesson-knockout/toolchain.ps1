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
$toolKeys=@('MAVEN_ARGS','npm_config_cache','UV_CACHE_DIR','PIP_CACHE_DIR','PIP_CONSTRAINT',
  'GEM_PATH','PNPM_HOME','npm_config_store_dir','pnpm_config_store_dir','BUNDLE_USER_HOME',
  'HEX_CACHE_HOME','NUGET_HTTP_CACHE_PATH','NUGET_PLUGINS_CACHE_PATH',
  'POETRY_CACHE_DIR','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0') + $variables
