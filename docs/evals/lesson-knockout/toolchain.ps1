# Per-task writable caches keep language tools off the shared Z0 stores.
param([string]$Chain,[string]$Live)
. 'C:/eval-authors/s3x-env.ps1'
Set-S3xEnv $Chain $Live
$assets='C:/z0-lessons/lesson-knockout/toolchains'
$privateCache="$Live/cache"
$variables=@('GRADLE_USER_HOME','GOPATH','GOCACHE','NUGET_PACKAGES','DOTNET_CLI_HOME','MIX_HOME','HEX_HOME')
foreach($key in $variables) {
  if ((Get-S3xTool $Chain).env.ContainsKey($key)) {
    [Environment]::SetEnvironmentVariable($key,"$privateCache/$key")
  }
}
if($Chain -eq 'maven') { $env:MAVEN_ARGS="-o -Dmaven.repo.local=$privateCache/maven" }
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
  'PIP_CACHE_DIR','PIP_NO_INDEX','PIP_FIND_LINKS','PIP_CONSTRAINT','GOPROXY','GOSUMDB') + $variables
