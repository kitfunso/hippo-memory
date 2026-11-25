$ErrorActionPreference='Stop'
$live='C:/z0-lessons/lesson-knockout/active/live'
$cases=@{
  npm=@('npm_config_cache'); pnpm=@('PNPM_HOME','npm_config_store_dir'); python=@('PIP_CACHE_DIR','UV_CACHE_DIR','POETRY_CACHE_DIR')
  gradle=@('GRADLE_USER_HOME'); gradle17=@('GRADLE_USER_HOME'); 'gradle-android'=@('GRADLE_USER_HOME')
  rust=@('CARGO_HOME','RUSTUP_HOME'); 'rust-ucrt'=@('CARGO_HOME','CARGO_TARGET_DIR')
  ruby=@('GEM_PATH','GEM_HOME','BUNDLE_PATH'); julia=@('JULIA_DEPOT_PATH'); maven=@('MAVEN_ARGS')
  elixir=@('MIX_HOME','HEX_HOME','HEX_CACHE_HOME'); go=@('GOPATH','GOCACHE'); dotnet=@('NUGET_PACKAGES','DOTNET_CLI_HOME')
}
foreach($chain in $cases.Keys){
  . "$PSScriptRoot/toolchain.ps1" $chain $live
  foreach($key in $cases[$chain]){
    $value=[Environment]::GetEnvironmentVariable($key) -replace '\\','/'
    if(!$value.Contains($live) -or $value.Contains('eval-envs')){throw "Shared writable cache for $chain / $key"}
  }
}
Write-Output "Passed private cache paths for $($cases.Count) declared toolchains."
