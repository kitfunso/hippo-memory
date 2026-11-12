# The listing (round 4 plan, Failure model): one scan of Win32_Process that prints `<pid> <role> <path>` for the runners, launchers, batches and free commands of a round 4 run.
# Argv comes from CommandLineToArgvW and no rule matches a substring of a whole command line, so a wrapper whose text names a folder is never read as that folder's process.
$ErrorActionPreference = 'Stop'
try {
  Add-Type -Namespace Z0 -Name Argv -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll", SetLastError = true)]
static extern System.IntPtr CommandLineToArgvW([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string line, out int count);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
static extern System.IntPtr LocalFree(System.IntPtr mem);
public static string[] Split(string line) {
  int n;
  System.IntPtr p = CommandLineToArgvW(line, out n);
  if (p == System.IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
  try {
    string[] r = new string[n];
    for (int i = 0; i < n; i++) r[i] = System.Runtime.InteropServices.Marshal.PtrToStringUni(System.Runtime.InteropServices.Marshal.ReadIntPtr(p, i * System.IntPtr.Size));
    return r;
  } finally { LocalFree(p); }
}
'@

  # Lowercase, `\` as `/`, a leading `/<letter>/` as `<letter>:/`, no trailing slash.
  function Norm([string]$s) {
    $t = $s.ToLowerInvariant().Replace('\', '/')
    if ($t -match '^/([a-z])/') { $t = $matches[1] + ':/' + $t.Substring(3) }
    if ($t.Length -gt 3) { $t = $t.TrimEnd('/') }
    return $t
  }
  function Leaf([string]$s) { return ($s.Replace('\', '/') -split '/')[-1].ToLowerInvariant() }
  function IsAbsolute([string]$s) { return $s -match '^([A-Za-z]:[\\/]|\\\\|/[A-Za-z]/)' }
  function FlagValue($argv, [string]$name) {
    for ($i = 1; $i -lt $argv.Count - 1; $i++) { if ($argv[$i] -ieq $name) { return $argv[$i + 1] } }
    return $null
  }
  function ArgvOf($p) {
    if (-not $script:argvs.ContainsKey([int]$p.ProcessId)) {
      $script:argvs[[int]$p.ProcessId] = if ($p.CommandLine) { [Z0.Argv]::Split($p.CommandLine) } else { $null }
    }
    $argv = $script:argvs[[int]$p.ProcessId]
    if ($null -eq $argv) { return $null }
    return , $argv
  }
  # The words after argv[0], which a bash fork shares with the script that forked it.
  function Tail($argv) { return ($argv | Select-Object -Skip 1) -join "`0" }

  $script:argvs = @{}
  $procs = @(Get-CimInstance Win32_Process)
  $byPid = @{}
  $kids = @{}
  foreach ($p in $procs) { $byPid[[int]$p.ProcessId] = $p }
  foreach ($p in $procs) {
    $parent = $byPid[[int]$p.ParentProcessId]
    # A parent created after its child is a reused PID, never an ancestor.
    if ($parent -and $parent.CreationDate -and $p.CreationDate -and $parent.CreationDate -le $p.CreationDate -and $parent.ProcessId -ne $p.ProcessId) {
      if (-not $kids.ContainsKey([int]$parent.ProcessId)) { $kids[[int]$parent.ProcessId] = New-Object System.Collections.ArrayList }
      [void]$kids[[int]$parent.ProcessId].Add($p)
    }
  }

  # A Git Bash exec leaves a dead process between a batch and the driver that called it, so the parent links stop short of the driver; s4-drive.sh names itself in Z0_DRIVER_WINPID.
  # The value counts only when it is a live s4-drive.sh bash.exe, so a stale or wrong one hides nothing.
  $seeds = @([int]$PID)
  $named = 0
  if ([int]::TryParse([string]$env:Z0_DRIVER_WINPID, [ref]$named) -and $byPid.ContainsKey($named)) {
    $driver = $byPid[$named]
    $driverArgv = if ($driver.Name -ieq 'bash.exe') { ArgvOf $driver } else { $null }
    if ($driverArgv -and $driverArgv.Count -gt 4 -and (Leaf $driverArgv[1]) -eq 's4-drive.sh') { $seeds += $named }
  }
  $drop = @{}
  foreach ($seed in $seeds) {
    $drop[$seed] = $true
    $cur = $byPid[$seed]
    while ($cur) {
      $parent = $byPid[[int]$cur.ParentProcessId]
      if (-not $parent -or $drop.ContainsKey([int]$parent.ProcessId) -or -not $parent.CreationDate -or $parent.CreationDate -gt $cur.CreationDate) { break }
      $drop[[int]$parent.ProcessId] = $true
      $cur = $parent
    }
  }
  # Git Bash shows every fork of a script with the script's own command line, so a fork under a bash ancestor is the batch's own.
  foreach ($id in @($drop.Keys)) {
    $ancestor = $byPid[$id]
    if ($ancestor.Name -ine 'bash.exe') { continue }
    if (-not (ArgvOf $ancestor)) { continue }
    $want = Tail (ArgvOf $ancestor)
    $stack = New-Object System.Collections.Stack
    $stack.Push($id)
    while ($stack.Count -gt 0) {
      foreach ($c in @($kids[[int]$stack.Pop()])) {
        if (-not $c) { continue }
        $stack.Push([int]$c.ProcessId)
        if ($c.Name -ieq 'bash.exe' -and (ArgvOf $c) -and (Tail (ArgvOf $c)) -ceq $want) { $drop[[int]$c.ProcessId] = $true }
      }
    }
  }

  $lines = New-Object System.Collections.ArrayList
  foreach ($p in $procs | Sort-Object ProcessId) {
    if ($drop.ContainsKey([int]$p.ProcessId) -or -not $p.CommandLine -or $p.Name -notin 'node.exe', 'powershell.exe', 'bash.exe') { continue }
    $argv = ArgvOf $p
    if ($argv.Count -lt 2) { continue }
    $role = $null
    $paths = @()
    if ($p.Name -ieq 'node.exe') {
      $entry = $argv | Select-Object -Skip 1 | Where-Object { -not $_.StartsWith('-') } | Select-Object -First 1
      if (-not $entry) { continue }
      $out = FlagValue $argv '--out'
      if (((Leaf $entry) -in ('ab-run.mjs', 'z0-regrade.mjs')) -and $out) {
        $role = (Leaf $entry).Replace('.mjs', '')
        $paths = , ((Norm $out) -replace '/run$', '')
      } elseif ((Norm $entry).Contains('/scripts/token-eval/')) {
        $role = 'cli'
        $paths = @($argv | Select-Object -Skip 1 | Where-Object { $_ -ne $entry -and (IsAbsolute $_) } | ForEach-Object { Norm $_ })
      }
    } elseif ($p.Name -ieq 'powershell.exe') {
      $file = FlagValue $argv '-File'
      $folder = FlagValue $argv '-Folder'
      if ($file -and $folder -and ((Leaf $file) -in ('s4-run.ps1', 's4-regrade.ps1'))) {
        $role = (Leaf $file).Replace('.ps1', '')
        $paths = , (Norm $folder)
      }
    } else {
      $at = @{ 's4-batch.sh' = 4; 's4-drive.sh' = 4; 's4-read.sh' = 3 }[(Leaf $argv[1])]
      if ($at -and $argv.Count -gt $at) {
        $role = (Leaf $argv[1]).Replace('.sh', '')
        $paths = , (Norm $argv[$at])
      }
    }
    if ($role) { foreach ($path in $paths) { [void]$lines.Add(('{0} {1} {2}' -f $p.ProcessId, $role, $path)) } }
  }
  foreach ($l in $lines) { [Console]::Out.Write($l + "`n") }
  exit 0
} catch {
  [Console]::Out.Write("scan failed: $($_.Exception.Message)`n")
  exit 1
}
