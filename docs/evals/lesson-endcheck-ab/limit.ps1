function Test-SubscriptionLimit($Result, [string]$OutputText) {
  if ($Result -and (!$Result.is_error -or $Result.subtype -like 'error_max*')) { return $false }
  return $OutputText -match 'usage limit|hit your (?:[\w-]+ )*limit|limit reached|rate_limit_error|overloaded_error'
}
