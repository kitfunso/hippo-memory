# Stops a process and its descendants (plan amendment W4-49) for s4-units.sh stop_finished and exec.mjs's timeout kill, in place of taskkill /T, which walks reused parent pids.
# ASCII lines `killed|gone|listed <pid>` or `failed|not-mine <pid> <why>`, then `end`; a script error prints `error <why>` and no `end`.
# Exit 0 when each one was killed or gone, 1 on a failed line, 2 on a script error, 3 for not-mine; a listed-table run exits 4 where a live one exits 0.
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
  function Utc($d) { if ($null -eq $d) { return $null }; return ([datetime]$d).ToUniversalTime() }
  # WMI keeps whole microseconds, so a row's start and a handle's start are compared at that precision.
  function Micro([datetime]$d) { return $d.Ticks - ($d.Ticks % 10) }
  $script:handles = [System.Collections.Generic.List[IntPtr]]::new()
  if (-not $listed) {
    Add-Type -Namespace Z0 -Name Proc -UsingNamespace System.ComponentModel -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
static extern IntPtr OpenProcess(int access, bool inherit, int pid);
[DllImport("kernel32.dll", SetLastError = true)]
static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
[DllImport("kernel32.dll", SetLastError = true)]
static extern uint WaitForSingleObject(IntPtr h, uint ms);
[DllImport("kernel32.dll", SetLastError = true)]
static extern bool TerminateProcess(IntPtr h, uint code);
[DllImport("kernel32.dll")]
public static extern bool CloseHandle(IntPtr h);
// PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE | PROCESS_TERMINATE; the error is read here, before PowerShell's own calls can reset it.
public static IntPtr Open(int pid, out int error) {
  IntPtr h = OpenProcess(0x1000 | 0x100000 | 0x1, false, pid);
  error = h == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
  return h;
}
public static DateTime Start(IntPtr h) {
  long created, exited, kernel, user;
  if (!GetProcessTimes(h, out created, out exited, out kernel, out user)) throw new Win32Exception();
  return DateTime.FromFileTimeUtc(created);
}
public static bool Ended(IntPtr h, uint ms) {
  uint r = WaitForSingleObject(h, ms);
  if (r == 0xFFFFFFFF) throw new Win32Exception();
  return r == 0;
}
public static void Kill(IntPtr h) { if (!TerminateProcess(h, 1)) throw new Win32Exception(); }
'@
  }
  # Z0_STOP_TREE_LISTED, a test's JSON {root, reads}, replaces the live handles and reads: root is the start a handle on the root reports (null: gone), reads one table per round, the last repeating.
  # A row's HandleStart is what a handle opened right after that read would report: absent means its CreationDate, null means the process is gone.
  $script:tables = [System.Collections.Generic.List[object]]::new()
  $script:reads = 0
  $listedRoot = $null
  if ($listed) {
    $doc = $env:Z0_STOP_TREE_LISTED | ConvertFrom-Json
    $keys = @($doc.PSObject.Properties.Name)
    if ($keys -notcontains 'root' -or $keys -notcontains 'reads') { throw 'Z0_STOP_TREE_LISTED is not a {root, reads} object' }
    $listedRoot = $doc.root
    foreach ($t in $doc.reads) {
      $rows = foreach ($r in $t) {
        $start = if ($r.PSObject.Properties.Name -notcontains 'HandleStart') { [datetime]$r.CreationDate } elseif ($null -ne $r.HandleStart) { [datetime]$r.HandleStart } else { $null }
        [pscustomobject]@{ ProcessId = [uint32]$r.ProcessId; ParentProcessId = [uint32]$r.ParentProcessId; CreationDate = [datetime]$r.CreationDate; CommandLine = [string]$r.CommandLine; HandleStart = $start }
      }
      $script:tables.Add(@($rows))
    }
  }
  function Table {
    if (-not $listed) {
      $all = @(Get-CimInstance Win32_Process)
      if ($all.Count -eq 0) { throw 'the process read listed no process' }
      return $all
    }
    if ($script:tables.Count -eq 0) { return }
    $i = [Math]::Min($script:reads, $script:tables.Count - 1)
    $script:reads++
    return $script:tables[$i]
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
  # A handle on $id and the start it reports, or $null after a gone or failed line; OpenProcess reaches a process that exited while another handle holds it, which keeps its pid and children its own, and which no process list shows.
  function Open([int]$id) {
    $err = 0
    $x = [Z0.Proc]::Open($id, [ref]$err)
    if ($x -eq [IntPtr]::Zero) {
      # ERROR_INVALID_PARAMETER is the one answer for a pid no process holds; any other refusal leaves a process that may still run.
      if ($err -eq 87) { Say "gone $id" } else { Say "failed $id $((New-Object System.ComponentModel.Win32Exception $err).Message)"; $script:failed = $true }
      return $null
    }
    $script:handles.Add($x)
    return [pscustomobject]@{ H = $x; Start = [Z0.Proc]::Start($x); Id = $id; Done = $false }
  }
  # The process a row nominates, held through its own handle, or $null after a gone or failed line; a handle start that differs from the row's means the pid changed hands since the read.
  function Hold($row, [datetime]$made) {
    $id = [int]$row.ProcessId
    if (-not $listed) { $h = Open $id }
    elseif ($null -eq $row.HandleStart) { Say "gone $id"; $h = $null }
    else { $h = [pscustomobject]@{ H = $null; Start = Utc $row.HandleStart; Id = $id; Done = $false } }
    if ($h -and (Micro $h.Start) -ne (Micro $made)) { Say "gone $id"; return $null }
    return $h
  }
  # Breadth-first from every held pid, alive or exited: its open handle keeps the pid its own, so a row that names it as parent and started at or after its start is its child.
  function Grow($table) {
    $kids = @{}
    foreach ($c in $table) { $pp = [int]$c.ParentProcessId; if (-not $kids.ContainsKey($pp)) { $kids[$pp] = [System.Collections.Generic.List[object]]::new() }; $kids[$pp].Add($c) }
    $new = [System.Collections.Generic.List[object]]::new()
    $queue = [System.Collections.Generic.Queue[object]]::new()
    foreach ($h in @($held.Values)) { $queue.Enqueue($h) }
    while ($queue.Count) {
      $up = $queue.Dequeue()
      if (-not $kids.ContainsKey($up.Id)) { continue }
      foreach ($c in $kids[$up.Id]) {
        $id = [int]$c.ProcessId
        $made = Utc $c.CreationDate
        if ($held.ContainsKey($id) -or $id -eq [int]$PID -or $null -eq $made -or (Micro $made) -lt (Micro $up.Start)) { continue }
        $h = Hold $c $made
        if (-not $h) { continue }
        $held[$id] = $h
        $new.Add($h)
        $queue.Enqueue($h)
      }
    }
    return , $new
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

  # The root's handle and its start come before the first read, so a root that exits later is still walked and its pid stays its own.
  $failed = $false
  $top = if (-not $listed) { Open $root } elseif ($null -eq $listedRoot) { Say "gone $root"; $null } else { [pscustomobject]@{ H = $null; Start = Utc $listedRoot; Id = $root; Done = $false } }
  if (-not $top) { Say 'end'; if ($failed) { Done 1 }; Done 0 }
  # The caller held the root's handle at -StartedBy, so a root that started later holds a pid the caller's process gave up.
  if ($by -and $top.Start -gt $by) { Say "not-mine $root started after $StartedBy"; Say 'end'; Done 3 }
  $first = @(Table)
  $row = $first | Where-Object { [int]$_.ProcessId -eq $root } | Select-Object -First 1
  if ($want -and -not $row) { Say "not-mine $root exited before its command line was read"; Say 'end'; Done 3 }
  if ($want -and -not (Names $row.CommandLine $want)) { Say "not-mine $root its command line names no $want"; Say 'end'; Done 3 }

  # Each round reads once, holds what it finds under a held pid, then kills every held process not yet killed; a kill can race a fork, so the next read looks again.
  # $held keeps every handle to the end, which keeps each held pid its own.
  $rounds = 5
  $held = @{}
  $held[$root] = $top
  for ($round = 1; $round -le $rounds + 1; $round++) {
    $table = if ($round -eq 1) { $first } else { @(Table) }
    $new = Grow $table
    $todo = @($held.Values | Where-Object { -not $_.Done })
    if ($todo.Count -eq 0) { break }
    # SHORTCUT: a descendant whose Windows parent left the process list before a read (an orphan, an msys program exec'd from a fork, or an exited parent another handle holds) is out of reach, as under taskkill /T; a job object per unit would hold it.
    # Oldest first by handle start, pid breaking ties: a parent killed first cannot fork a new child while its children die.
    foreach ($h in @($todo | Sort-Object -Property Start, Id)) {
      $h.Done = $true
      if ($listed) { Say "listed $($h.Id)"; continue }
      if ([Z0.Proc]::Ended($h.H, 0)) { Say "gone $($h.Id)"; continue }
      try {
        [Z0.Proc]::Kill($h.H)
        if ([Z0.Proc]::Ended($h.H, 10000)) { Say "killed $($h.Id)" } else { Say "failed $($h.Id) still running 10 s after its kill"; $failed = $true }
      } catch {
        if ([Z0.Proc]::Ended($h.H, 5000)) { Say "gone $($h.Id)" } else { Say "failed $($h.Id) $($_.Exception.Message)"; $failed = $true }
      }
    }
    # A sixth round's nominees pass the same handle check, so they die too, but a tree that still spawns may have more, so the stop fails.
    if ($round -gt $rounds) { foreach ($h in $new) { Say "failed $($h.Id) still spawning after $rounds rounds" }; $failed = $true }
  }
  Say 'end'
  if ($failed) { Done 1 }
  Done 0
} catch {
  Say "error $($_.Exception.Message)"
  exit 2
} finally {
  # Every handle stays open until here, so no held pid passes to another process before the last kill.
  foreach ($x in $script:handles) { $null = [Z0.Proc]::CloseHandle($x) }
}
