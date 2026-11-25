param([Parameter(Mandatory)][string]$Live)
$ErrorActionPreference='Stop'
$Live=[IO.Path]::GetFullPath($Live)
if($Live -ne 'C:\z0-lessons\lesson-knockout\active\live'){ throw 'Unexpected task root' }
if($env:USERPROFILE -ne (Join-Path $Live 'setup-home')){ throw 'Start setup through the unit runner' }
$spec=Get-Content -Raw -Encoding UTF8 'C:/z0-lessons/lesson-knockout/active/operator/setup.json' | ConvertFrom-Json
. "$PSScriptRoot/toolchain.ps1" $spec.toolchain $Live
foreach($item in @(Get-ChildItem Env: | Where-Object Name -match 'TOKEN|SECRET|API.?KEY|^ANTHROPIC_|^AWS_')) {
  [Environment]::SetEnvironmentVariable($item.Name,$null)
}
$gradleSource=(Get-S3xTool $spec.toolchain).env['GRADLE_USER_HOME']
if($gradleSource) {
  $source=Join-Path $gradleSource 'gradle.properties'
  $target=Join-Path $env:GRADLE_USER_HOME 'gradle.properties'
  New-Item -ItemType Directory -Force -Path $env:GRADLE_USER_HOME | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
  if((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $source).Hash){throw 'Private gradle.properties differs from the Z0 file'}
}
if($spec.toolchain -eq 'python') {
  if((Get-FileHash -Algorithm SHA256 $env:PIP_CONSTRAINT).Hash -ne $spec.constraintHash){throw 'pip constraint differs from frozen pin'}
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
