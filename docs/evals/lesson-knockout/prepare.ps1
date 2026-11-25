param([Parameter(Mandatory)][string]$Live)
$ErrorActionPreference='Stop'
$Live=[IO.Path]::GetFullPath($Live)
if($Live -ne 'C:\z0-lessons\lesson-knockout\active\live'){ throw 'Unexpected task root' }
$spec=Get-Content -Raw -Encoding UTF8 "$Live/setup.json" | ConvertFrom-Json
. "$PSScriptRoot/toolchain.ps1" $spec.toolchain $Live
foreach($item in @(Get-ChildItem Env: | Where-Object Name -match 'TOKEN|SECRET|API.?KEY|^ANTHROPIC_|^AWS_')) {
  [Environment]::SetEnvironmentVariable($item.Name,$null)
}
$env:HOME="$Live/setup-home"
$env:USERPROFILE=$env:HOME
$env:LOCALAPPDATA="$env:HOME/local"
$env:APPDATA="$env:HOME/roaming"
$env:TEMP="$env:HOME/tmp"
$env:TMP=$env:TEMP
foreach($d in @($env:LOCALAPPDATA,$env:APPDATA,$env:TEMP)) { [IO.Directory]::CreateDirectory($d) | Out-Null }
if(Test-Path "$assets/cache/$($spec.toolchain)") {
  Copy-Item -LiteralPath "$assets/cache/$($spec.toolchain)" -Destination $privateCache -Recurse
}
if($spec.toolchain -like 'gradle*') {
  $init=Join-Path $env:GRADLE_USER_HOME 'init.d'
  [IO.Directory]::CreateDirectory($init) | Out-Null
  [IO.File]::WriteAllText("$init/knockout-offline.gradle",'gradle.startParameter.offline = true')
}
if($spec.toolchain -eq 'python') {
  if((Get-FileHash -Algorithm SHA256 $env:PIP_CONSTRAINT).Hash -ne $spec.constraintHash){throw 'pip constraint differs from frozen pin'}
  if(!(Test-Path "$assets/poetry-2.5.1/Scripts/poetry.exe")){throw 'Missing offline Poetry distribution'}
  & python -m venv "$Live/venv"
  if($LASTEXITCODE){throw 'Task venv creation failed'}
}
if($spec.setup) {
  Push-Location -LiteralPath "$Live/work"
  try {
    & $env:ComSpec /d /c ([string]$spec.setup)
    if($LASTEXITCODE){throw "Task setup exited $LASTEXITCODE"}
  } finally { Pop-Location }
}
