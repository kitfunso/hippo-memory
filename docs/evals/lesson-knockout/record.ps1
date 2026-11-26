function Get-Sha256Hex([byte[]]$Bytes) {
  $sha=[Security.Cryptography.SHA256]::Create()
  try { -join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}
$WireKeys=@('HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS')
function Get-WireEnv($Call) {
  $pairs=@($Call.wireEnv.PSObject.Properties)
  if ($pairs.Count -ne $WireKeys.Count -or ($pairs | Where-Object { $WireKeys -cnotcontains $_.Name })) { throw 'Unexpected wire settings' }
  $proxy=$Call.wireEnv.HTTPS_PROXY
  if ($proxy -isnot [string] -or $proxy -cnotmatch '^http://wire:[0-9a-f]{32}@127\.0\.0\.1:([1-9]\d{0,4})\z' -or [int]$Matches[1] -gt 65535) { throw 'Wire proxy is not a local listener' }
  if ($Call.wireEnv.NO_PROXY -cne '127.0.0.1,localhost') { throw 'Unexpected wire bypass list' }
  if ($Call.wireEnv.NODE_EXTRA_CA_CERTS -cne 'C:/z0-lessons/lesson-knockout/wire-ca/ca.pem') { throw 'Unexpected wire CA' }
  $pairs
}
function Assert-WireOnly($Variables) {
  foreach ($k in @($Variables.Keys)) {
    if ($WireKeys -contains $k) { continue }
    if ($k -match '(?i)proxy|^ANTHROPIC_|^CLAUDE_CODE_USE_|^OTEL_|^NODE_TLS|^NODE_EXTRA_CA|^SSL_CERT|^REQUESTS_CA|^CURL_CA') { throw "Unexpected network setting $k" }
  }
}
function New-CallRecord($Call,[byte[]]$PromptBytes,[int]$ExitCode,$Result,[bool]$Stopped,$Denials) {
  $hash=Get-Sha256Hex $PromptBytes
  if ($null -eq $Result) {
    return [ordered]@{session=$Call.session;call=$Call.id;promptSha256=$hash;json=$false;exit=$ExitCode;apparatus=$Call.apparatus;stopped=$true;permissionDenials=$null}
  }
  [ordered]@{session=$Result.session_id;call=$Call.id;promptSha256=$hash;json=$true;subtype=$Result.subtype;isError=$Result.is_error;turns=$Result.num_turns;usage=$Result.usage;models=@($Result.modelUsage.PSObject.Properties.Name);exit=$ExitCode;apparatus=$Call.apparatus;stopped=$Stopped;permissionDenials=$Denials}
}
function Write-CallRecord([string]$Path,$Record) {
  [IO.File]::WriteAllText($Path,($Record | ConvertTo-Json -Depth 12),(New-Object Text.UTF8Encoding($false)))
}
