function Get-Sha256Hex([byte[]]$Bytes) {
  $sha=[Security.Cryptography.SHA256]::Create()
  try { -join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}
function Get-DispatchEnv($Call) {
  $keys=@('CLAUDE_CODE_ENABLE_TELEMETRY','OTEL_LOGS_EXPORTER','OTEL_METRICS_EXPORTER','OTEL_EXPORTER_OTLP_LOGS_PROTOCOL','OTEL_EXPORTER_OTLP_LOGS_ENDPOINT','OTEL_LOGS_EXPORT_INTERVAL')
  $pairs=@($Call.dispatchEnv.PSObject.Properties)
  if ($pairs.Count -ne $keys.Count -or ($pairs | Where-Object { $keys -cnotcontains $_.Name })) { throw 'Unexpected dispatch log settings' }
  if ($Call.dispatchEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT -notmatch '^http://127\.0\.0\.1:\d+/[0-9a-f-]{36}/v1/logs$') { throw 'Dispatch log endpoint is not a local collector' }
  $pairs
}
function New-CallRecord($Call,[byte[]]$PromptBytes,[int]$ExitCode,$Result,[bool]$Limited,$Denials) {
  $hash=Get-Sha256Hex $PromptBytes
  if ($null -eq $Result) {
    return [ordered]@{session=$Call.session;call=$Call.id;promptSha256=$hash;json=$false;exit=$ExitCode;apparatus=$Call.apparatus;cutOff=$true;permissionDenials=$null}
  }
  [ordered]@{session=$Result.session_id;call=$Call.id;promptSha256=$hash;json=$true;subtype=$Result.subtype;isError=$Result.is_error;turns=$Result.num_turns;usage=$Result.usage;models=@($Result.modelUsage.PSObject.Properties.Name);exit=$ExitCode;apparatus=$Call.apparatus;cutOff=$Limited;permissionDenials=$Denials}
}
function Write-CallRecord([string]$Path,$Record) {
  [IO.File]::WriteAllText($Path,($Record | ConvertTo-Json -Depth 12),(New-Object Text.UTF8Encoding($false)))
}
