# Per-task writable caches keep language tools off the shared Z0 stores.
param([string]$Chain,[string]$Live)
. 'C:/eval-authors/s3x-env.ps1'
Set-S3xEnv $Chain $Live
$assets='C:/z0-lessons/lesson-knockout/toolchains'
$privateCache="$Live/cache"
# The controller owns this checkout; the worker trusts only the active worktree.
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
if($Chain -eq 'maven') { $env:MAVEN_ARGS="-o -Dmaven.repo.local=$privateCache/maven" }
if($Chain -eq 'ruby') { $env:GEM_PATH=$env:GEM_HOME }
$env:CARGO_NET_OFFLINE='true'
$env:RUSTUP_AUTO_INSTALL='0'
$env:PNPM_HOME="$privateCache/PNPM_HOME"
$env:npm_config_store_dir="$privateCache/pnpm-store"
$env:pnpm_config_store_dir=$env:npm_config_store_dir
$env:pnpm_config_offline='true'
$env:COREPACK_ENABLE_NETWORK='0'
$env:BUNDLE_USER_HOME="$privateCache/bundler"
$env:BUNDLE_ALLOW_OFFLINE_INSTALL='true'
$env:JULIA_PKG_OFFLINE='true'
$env:JULIA_PKG_SERVER=''
$env:HEX_OFFLINE='1'
$env:HEX_CACHE_HOME="$privateCache/hex-cache"
$env:NUGET_HTTP_CACHE_PATH="$privateCache/nuget-http"
$env:NUGET_PLUGINS_CACHE_PATH="$privateCache/nuget-plugins"
$env:RestoreSources="$assets/nuget-feed"
$env:NuGetAudit='false'
$env:POETRY_CACHE_DIR="$privateCache/poetry"
$env:npm_config_cache="$privateCache/npm"
$env:npm_config_offline='true'
$env:UV_OFFLINE='1'
$env:UV_CACHE_DIR="$privateCache/uv"
$env:PIP_NO_INDEX='1'
$env:PIP_FIND_LINKS="$assets/wheels"
$env:PIP_CACHE_DIR="$privateCache/pip"
$env:GOPROXY='off'
$env:GOSUMDB='off'
if($Chain -eq 'python') {
  $env:PIP_CONSTRAINT="$assets/pip-constraints.txt"
  $env:PATH="$Live/venv/Scripts;$assets/poetry-2.5.1/Scripts;$env:PATH"
}
$toolKeys=@('MAVEN_ARGS','npm_config_cache','npm_config_offline','UV_OFFLINE','UV_CACHE_DIR',
  'PIP_CACHE_DIR','PIP_NO_INDEX','PIP_FIND_LINKS','PIP_CONSTRAINT','GOPROXY','GOSUMDB','CARGO_NET_OFFLINE',
  'RUSTUP_AUTO_INSTALL','GEM_PATH','PNPM_HOME','npm_config_store_dir','pnpm_config_store_dir','pnpm_config_offline',
  'COREPACK_ENABLE_NETWORK','BUNDLE_USER_HOME','BUNDLE_ALLOW_OFFLINE_INSTALL','JULIA_PKG_OFFLINE','JULIA_PKG_SERVER',
  'HEX_OFFLINE','HEX_CACHE_HOME','NUGET_HTTP_CACHE_PATH','NUGET_PLUGINS_CACHE_PATH','RestoreSources','NuGetAudit',
  'POETRY_CACHE_DIR','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0') + $variables
