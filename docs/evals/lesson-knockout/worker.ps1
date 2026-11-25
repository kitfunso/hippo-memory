param([ValidateSet('check','prepare','launch')][string]$Action='check',
  [string]$Live='C:/z0-lessons/lesson-knockout/active/live',[string]$TokenVar='Z0_SUB_TOKEN',
  [string]$ProbeUrl='',[string]$ProbeEvent='')
$ErrorActionPreference='Stop'
if((Get-Service WinRM).Status -ne 'Running'){throw 'Worker qualification blocked: WinRM is stopped'}
$root='C:/z0-lessons/lesson-knockout'
if([IO.Path]::GetFullPath($Live) -ne [IO.Path]::GetFullPath("$root/active/live")) { throw 'Unexpected live directory' }
$controller=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$runtime="$root/worker-runtime"
$scripts=@('launch.ps1','prepare.ps1','toolchain.ps1')
$hashes=@{}
foreach($name in $scripts){$hashes[$name]=(Get-FileHash "$PSScriptRoot/$name").Hash}
$roster=& node "$PSScriptRoot/plan.mjs" guards
if($LASTEXITCODE){throw 'Cannot establish protected task paths'}
$guards=@(($roster -join "`n" | ConvertFrom-Json)) + @($root,"$root/unit","$root/smoke","$root/limit-archives",
  "$root/checkpoints",$PSScriptRoot,$PSCommandPath,"C:/z0-runs/r4/tasks","C:/z0-runs/r4/pins-r4.json")
foreach($u in @(Get-ChildItem "$root/unit","$root/smoke" -Directory -ErrorAction SilentlyContinue)){
  foreach($rel in @('design.json','freeze.json','pre/manifest.json','snapshot/hippo.db','evidence','pre','snapshot')){
    if(Test-Path -LiteralPath "$($u.FullName)/$rel"){ $guards+="$($u.FullName)/$rel" }
  }
}
foreach($dir in @('unit','smoke','limit-archives','checkpoints')){
  if(!(Test-Path -LiteralPath "$root/$dir" -PathType Container)){throw "Missing operator directory: $dir"}
}
$fileGuards=@($guards | Where-Object {Test-Path -LiteralPath $_ -PathType Leaf})
$dirGuards=@($guards | Where-Object {Test-Path -LiteralPath $_ -PathType Container})
$session=New-PSSession -ComputerName localhost -ConfigurationName LessonKnockoutWorker -Authentication Negotiate
try {
  $code=Invoke-Command -Session $session -ArgumentList $controller,$Live,$runtime,$hashes,$dirGuards,$fileGuards,$Action,$TokenVar,$ProbeUrl,$ProbeEvent -ScriptBlock {
    param($controller,$live,$runtime,$hashes,$dirs,$files,$action,$name,$url,$eventJson)
    $ErrorActionPreference='Stop'
    $id=[Security.Principal.WindowsIdentity]::GetCurrent()
    $principal=New-Object Security.Principal.WindowsPrincipal($id)
    if($id.User.Value -eq $controller -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
      throw 'Worker requires a separate unprivileged Windows identity'
    }
    foreach($p in $dirs){
      try { $null=[IO.Directory]::GetFileSystemEntries($p); throw "Worker can list $p" }
      catch [UnauthorizedAccessException] {}
    }
    foreach($p in $files){
      try { ([IO.File]::OpenRead($p)).Dispose(); throw "Worker can read $p" }
      catch [UnauthorizedAccessException] {}
    }
    foreach($script in $hashes.Keys){
      $p=Join-Path $runtime $script
      if((Get-FileHash $p).Hash -ne $hashes[$script]){throw "Worker script drift: $script"}
      try { ([IO.File]::OpenWrite($p)).Dispose(); throw "Worker can write $p" }
      catch [UnauthorizedAccessException] {}
    }
    if($url){
      if($action -ne 'check' -or ([uri]$url).Host -ne '127.0.0.1'){throw 'Unexpected loopback probe'}
      $eventText=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($eventJson))
      $reply=Invoke-RestMethod -Uri $url -Method Post -ContentType application/json -Body $eventText
      if($reply.hookSpecificOutput.additionalContext -notlike 'Project notes*'){throw 'Worker hook failed'}
    }
    if($action -eq 'check'){return 0}
    if($action -eq 'launch'){
      & 'C:/Program Files/Git/bin/bash.exe' 'C:/z0-runs/s7/box-check.sh' | Out-Host
      if($LASTEXITCODE){throw 'Z0 box check refused launch'}
      & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$runtime/launch.ps1" -Live $live -TokenVar $name
    } else {
      & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$runtime/prepare.ps1" -Live $live
    }
    return $LASTEXITCODE
  }
  exit [int]@($code)[-1]
} finally { Remove-PSSession $session }
