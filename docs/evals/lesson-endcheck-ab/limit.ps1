$SessionTimeoutMs = [int][TimeSpan]::FromMinutes(30).TotalMilliseconds

function Test-SubscriptionLimit($Result, [string]$OutputText) {
  if ($Result -and (!$Result.is_error -or $Result.subtype -like 'error_max*')) { return $false }
  if ($OutputText -match 'authentication_error|invalid_grant|unauthorized|(?:expired|invalid|revoked) (?:oauth |access )?token|token (?:has )?(?:expired|been revoked)') { return $false }
  return $OutputText -match 'usage limit|hit your (?:[\w-]+ )*limit|limit reached|rate_limit_error|overloaded_error'
}
