param([Parameter(Mandatory)][string]$Chain,[Parameter(Mandatory)][string]$Live)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/toolchain.ps1" $Chain $Live
$out=[ordered]@{}
foreach($key in (@('PATH') + @((Get-S3xTool $Chain).env.Keys) + $toolKeys)) {
  $value=[Environment]::GetEnvironmentVariable($key)
  if($value) { $out[$key]=$value }
}
[Console]::Out.Write(($out | ConvertTo-Json -Compress))
