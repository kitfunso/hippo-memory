function Get-PermissionDenials($Result) {
  $field=$Result.PSObject.Properties['permission_denials']
  if ($null -eq $field -or $field.Value -isnot [array]) { throw 'Claude Code result lacks a permission_denials list' }
  ,@(foreach ($d in $field.Value) {
    if ($null -eq $d -or $d.tool_name -isnot [string] -or $d.tool_use_id -isnot [string] -or $d.tool_name -eq '' -or $d.tool_use_id -eq '') { throw 'Malformed permission_denials entry' }
    [ordered]@{tool=[string]$d.tool_name;id=[string]$d.tool_use_id}
  })
}
