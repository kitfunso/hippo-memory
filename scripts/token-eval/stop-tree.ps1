# Stops a process and its descendants (plan amendment W4-49) for s4-units.sh stop_finished and exec.mjs's timeout kill, in place of taskkill /T, which walks reused parent pids.
# ASCII lines `killed|gone <pid>` or `failed|left|not-mine <pid> <why>`, then `end`; a script error prints `error <why>` and no `end`.
# Exit 0 when each one was killed or gone, 1 on a failed or left line, 2 on a script error, 3 for not-mine; a listed-table run exits 4 where a live one exits 0.
param([string]$RootPid = '', [string]$Mark = '', [string]$StartedBy = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
function Say([string]$line) { [Console]::Out.Write(($line -replace '[^\x20-\x7e]', '?') + "`n") }
$listed = [bool]$env:Z0_STOP_TREE_LISTED
# A listed run never exits 0, so a leaked table can never read as a stop.
function Done([int]$code) { if ($listed -and $code -eq 0) { exit 4 }; exit $code }

try {
  # Lowercase, `\` as `/`, a leading `/<letter>/` as `<letter>:/`, no trailing slash, as s4-procs.ps1 compares folders.
  function Norm([string]$s) {
    $t = $s.ToLowerInvariant().Replace('\', '/')
    if ($t -match '^/([a-z])/') { $t = $matches[1] + ':/' + $t.Substring(3) }
    if ($t.Length -gt 3) { $t = $t.TrimEnd('/') }
    return $t
  }
  # Z0_STOP_TREE_LISTED, a test's process table as JSON, replaces the first read and Z0_STOP_TREE_LISTED2 (else the same table) the second; a listed run opens no handle and kills nothing.
  function Table([string]$json) {
    if ($listed) {
      $rows = @(($json | ConvertFrom-Json) | ForEach-Object { [pscustomobject]@{ ProcessId = [uint32]$_.ProcessId; ParentProcessId = [uint32]$_.ParentProcessId; CreationDate = [datetime]$_.CreationDate; CommandLine = [string]$_.CommandLine } })
      return $rows
    }
    $all = @(Get-CimInstance Win32_Process)
    if ($all.Count -eq 0) { throw 'the process read listed no process' }
    return $all
  }
  # The rows under the root, each taken only if it started at or after its parent, so nothing an earlier holder of a parent's pid left behind is taken.
  function Walk($table, [int]$root, $created) {
    $kids = @{}
    foreach ($c in $table) { $pp = [int]$c.ParentProcessId; if (-not $kids.ContainsKey($pp)) { $kids[$pp] = [System.Collections.Generic.List[object]]::new() }; $kids[$pp].Add($c) }
    $seen = @{}
    $seen[$root] = $true
    $seen[[int]$PID] = $true
    $queue = [System.Collections.Generic.Queue[object]]::new()
    $queue.Enqueue([pscustomobject]@{ Id = $root; Created = $created })
    while ($queue.Count) {
      $up = $queue.Dequeue()
      if ($null -eq $up.Created -or -not $kids.ContainsKey($up.Id)) { continue }
      foreach ($c in $kids[$up.Id]) {
        $id = [int]$c.ProcessId
        if ($seen.ContainsKey($id) -or $null -eq $c.CreationDate -or $c.CreationDate -lt $up.Created) { continue }
        $seen[$id] = $true
        $c
        $queue.Enqueue([pscustomobject]@{ Id = $id; Created = $c.CreationDate })
      }
    }
  }
  # Argv from CommandLineToArgvW, as s4-procs.ps1 splits it: a word names the folder only as the whole path or a path under it, never a longer folder name.
  function Names([string]$line, [string]$want) {
    if (-not $line) { return $false }
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
    foreach ($word in [Z0.Argv]::Split($line)) { $n = Norm $word; if ($n -eq $want -or $n.StartsWith("$want/")) { return $true } }
    return $false
  }

  $root = 0
  if (-not [int]::TryParse($RootPid, [ref]$root) -or $root -le 0) { throw "-RootPid $RootPid is not a process id" }
  $want = $null
  if ($PSBoundParameters.ContainsKey('Mark')) {
    $want = Norm $Mark
    if ($want -notmatch '^([a-z]:|//[^/]+)/[^/]') { throw "-Mark $Mark is not an absolute folder below a drive or share" }
  }
  $by = $null
  if ($PSBoundParameters.ContainsKey('StartedBy')) {
    $t = [datetime]::MinValue
    $ok = $StartedBy -match '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,7})?Z$' -and [datetime]::TryParse($StartedBy, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$t)
    if (-not $ok -or $t.Kind -ne [DateTimeKind]::Utc) { throw "-StartedBy $StartedBy is not a UTC round-trip time" }
    $by = $t
  }

  # The handle opens before the read, so the root's row and every kill reach the process it holds, never a later holder of its pid.
  $p = $null
  if (-not $listed) {
    $p = Get-Process -Id $root -ErrorAction SilentlyContinue
    if ($p) { try { $null = $p.Handle } catch { if (Get-Process -Id $root -ErrorAction SilentlyContinue) { Say "failed $root $($_.Exception.Message)"; Say 'end'; Done 1 }; $p = $null } }
    if (-not $p) { Say "gone $root"; Say 'end'; Done 0 }
  }
  $first = @(Table $env:Z0_STOP_TREE_LISTED)
  $row = $first | Where-Object { [int]$_.ProcessId -eq $root } | Select-Object -First 1
  if (-not $row -or ($p -and $p.HasExited)) { Say "gone $root"; Say 'end'; Done 0 }
  # The caller held the root's handle at -StartedBy, so a root that started later holds a pid the caller's process gave up.
  if ($by -and $null -eq $row.CreationDate) { Say "not-mine $root has no start time to check against $StartedBy"; Say 'end'; Done 3 }
  if ($by -and $row.CreationDate.ToUniversalTime() -gt $by) { Say "not-mine $root started after $StartedBy"; Say 'end'; Done 3 }
  if ($want -and -not (Names $row.CommandLine $want)) { Say "not-mine $root its command line names no $want"; Say 'end'; Done 3 }

  $failed = $false
  $held = [System.Collections.Generic.List[object]]::new()
  $held.Add([pscustomobject]@{ P = $p; Created = $row.CreationDate; Id = $root })
  foreach ($c in @(Walk $first $root $row.CreationDate)) {
    $id = [int]$c.ProcessId
    if ($listed) { $held.Add([pscustomobject]@{ P = $null; Created = $c.CreationDate; Id = $id }); continue }
    $q = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $q) { Say "gone $id"; continue }
    try { $null = $q.Handle; $held.Add([pscustomobject]@{ P = $q; Created = $c.CreationDate; Id = $id }) }
    catch { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Say "failed $id $($_.Exception.Message)"; $failed = $true } else { Say "gone $id" } }
  }
  # A second read with every handle open proves each held process is still under the root, so a pid that changed hands before its handle opened is left alone.
  $again = if ($env:Z0_STOP_TREE_LISTED2) { $env:Z0_STOP_TREE_LISTED2 } else { $env:Z0_STOP_TREE_LISTED }
  $still = @{}
  $still[$root] = $true
  foreach ($c in @(Walk @(Table $again) $root $row.CreationDate)) { $still[[int]$c.ProcessId] = $true }
  # SHORTCUT: a descendant whose Windows parent exited before the read (an orphan, or an msys program exec'd from a fork) is out of reach, as under taskkill /T; a job object per unit would hold it.
  # Oldest first, pid breaking ties: a parent killed first cannot fork a new child while its children die, and each held handle keeps a child's pid its own until its kill.
  foreach ($h in @($held | Sort-Object -Property Created, Id)) {
    $q = $h.P
    if ($q -and $q.HasExited) { Say "gone $($h.Id)"; continue }
    if (-not $still.ContainsKey($h.Id)) { Say "left $($h.Id) not under the root at the second read"; $failed = $true; continue }
    if ($listed) { Say "listed $($h.Id)"; continue }
    try {
      $q.Kill()
      if ($q.WaitForExit(10000)) { Say "killed $($h.Id)" } else { Say "failed $($h.Id) still running 10 s after its kill"; $failed = $true }
    } catch {
      $null = $q.WaitForExit(5000)
      if ($q.HasExited) { Say "gone $($h.Id)" } else { Say "failed $($h.Id) $($_.Exception.Message)"; $failed = $true }
    }
  }
  Say 'end'
  if ($failed) { Done 1 }
  Done 0
} catch {
  Say "error $($_.Exception.Message)"
  exit 2
}
