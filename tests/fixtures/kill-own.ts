// Finds and stops a test's processes by a folder their command line names, so a test never signals a pid that has passed to another process.
import { spawnSync, type ChildProcess } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';

const win = process.platform === 'win32';
const norm = (s: string) => s.replace(/\\+/g, '/').toLowerCase();

// Marks and pids arrive as env vars and only ASCII pids come back, so no path is quoted into the script or passes through a code page.
const PS_MINE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$marks = @($env:Z0_OWN_MARKS -split '\\|' | Where-Object { $_ })
$only = @($env:Z0_OWN_ONLY -split ',' | Where-Object { $_ })
$roots = @($env:Z0_OWN_ROOTS -split ',' | Where-Object { $_ })
# Each live process (of all, or of $only) that is one of $roots or whose command line names a mark, as the mark's index (-1 for a root) and the process, parents before children.
# Z0_OWN_LISTED, a test's process table, replaces the live read; PS_KILL refuses it, so no kill acts on a listed pid.
# A sweep (no $only) adds each one's descendants under its mark; a child counts only if it started at or after its parent, so no process an earlier holder of the parent's pid left is taken.
function Mine {
  if ($only.Count) { $all = @(Get-CimInstance Win32_Process -Filter (($only | ForEach-Object { "ProcessId=$_" }) -join ' OR ')) }
  elseif ($env:Z0_OWN_LISTED) { $all = @(($env:Z0_OWN_LISTED | ConvertFrom-Json) | ForEach-Object { [pscustomobject]@{ ProcessId = [uint32]$_.ProcessId; ParentProcessId = [uint32]$_.ParentProcessId; CreationDate = [datetime]$_.CreationDate; CommandLine = [string]$_.CommandLine } }) }
  else { $all = @(Get-CimInstance Win32_Process); if ($all.Count -eq 0) { throw 'the process read listed no process' } }
  $found = [System.Collections.Generic.List[object]]::new()
  foreach ($p in $all) {
    if ($roots -contains [string]$p.ProcessId) { $found.Add([pscustomobject]@{ Mark = -1; Proc = $p }); continue }
    $t = ([string]$p.CommandLine -replace '\\\\+', '/').ToLowerInvariant()
    for ($i = 0; $i -lt $marks.Count; $i++) { if ($t.Contains($marks[$i])) { $found.Add([pscustomobject]@{ Mark = $i; Proc = $p }); break } }
  }
  if ($only.Count) { return $found }
  $kids = @{}
  foreach ($c in $all) { $pp = [int]$c.ParentProcessId; if (-not $kids.ContainsKey($pp)) { $kids[$pp] = [System.Collections.Generic.List[object]]::new() }; $kids[$pp].Add($c) }
  $seen = @{}
  foreach ($f in $found) { $seen[[int]$f.Proc.ProcessId] = $true }
  for ($k = 0; $k -lt $found.Count; $k++) {
    $up = $found[$k].Proc
    if (-not $kids.ContainsKey([int]$up.ProcessId) -or $null -eq $up.CreationDate) { continue }
    foreach ($c in $kids[[int]$up.ProcessId]) {
      if ($seen.ContainsKey([int]$c.ProcessId) -or $null -eq $c.CreationDate -or $c.CreationDate -lt $up.CreationDate) { continue }
      $seen[[int]$c.ProcessId] = $true
      $found.Add([pscustomobject]@{ Mark = $found[$k].Mark; Proc = $c })
    }
  }
  $found
}
`;
const PS_LIST = `${PS_MINE}
foreach ($m in Mine) { [string]$m.Mark + [char]9 + [string]$m.Proc.ProcessId }
'end'
`;
// SHORTCUT: a descendant whose Windows parent has exited (an orphan, or an msys program exec'd from a fork) is out of the walk's reach; a job object per case would hold it.
const PS_KILL = `${PS_MINE}
if ($env:Z0_OWN_LISTED) { throw 'a kill never acts on a listed process table' }
# An open handle keeps a pid on its process, so the second read and the kill reach the process the handle holds.
$held = [System.Collections.Generic.List[object]]::new()
$out = [System.Collections.Generic.List[string]]::new()
foreach ($m in Mine) {
  $id = [int]$m.Proc.ProcessId
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  try { $null = $p.Handle; $held.Add([pscustomobject]@{ P = $p; Created = $m.Proc.CreationDate; Id = $id }) } catch { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $out.Add("failed $id $($_.Exception.Message)") } }
}
$still = @(Mine | ForEach-Object { [int]$_.Proc.ProcessId })
# Oldest first, pid breaking ties: a parent killed first cannot fork a new child while its children die, and each held handle keeps a child's pid its own until its kill.
foreach ($h in @($held | Sort-Object -Property Created, Id)) {
  $p = $h.P
  if ($still -notcontains $p.Id) { continue }
  try { $p.Kill(); if ($p.WaitForExit(10000)) { $out.Add("killed $($p.Id)") } else { $out.Add("failed $($p.Id) still running 10 s after its kill") } } catch { $null = $p.WaitForExit(5000); if (-not $p.HasExited) { $out.Add("failed $($p.Id) $($_.Exception.Message)") } }
}
$out
'end'
`;

/** Each mark in the form the scripts compare; an empty, relative or root mark would match unrelated processes, so it is refused. */
function marksOf(marks: string[]) {
  const bad = marks.filter((m) => m.trim() === '' || !isAbsolute(m) || dirname(m) === m);
  if (bad.length > 0) throw new Error(`a process mark must be an absolute folder path below a drive or root, but got ${bad.map((m) => JSON.stringify(m)).join(' ')}`);
  return marks.map(norm);
}

/** The script's output lines before its closing `end`; a script that failed or stopped early throws, so a failed read never reads as no process. */
function ps(script: string, marks: string[], only: number[], what: string, roots: number[] = [], listed = '') {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true, env: { ...process.env, Z0_OWN_MARKS: marks.join('|'), Z0_OWN_ONLY: only.join(','), Z0_OWN_ROOTS: roots.join(','), Z0_OWN_LISTED: listed },
  });
  const lines = (r.stdout ?? '').split(/\r?\n/).filter((l) => l !== '');
  if (r.status !== 0 || lines.at(-1) !== 'end') throw new Error(`the ${what} failed: exit ${r.status} ${r.error?.message ?? r.stderr}`);
  return lines.slice(0, -1);
}

/** One row of a process table a test lists in place of the live read: the Win32_Process fields the walk reads, CreationDate as an ISO string. */
export interface ListedProcess { ProcessId: number; ParentProcessId: number; CreationDate: string; CommandLine: string }

/** For each folder, the live processes (or `listed`'s, for a test of the walk) whose command line names it, and their descendants; a case's folder is unique, so a reused pid never matches. */
export function procsNaming(dirs: string[], listed?: readonly ListedProcess[]) {
  const want = marksOf(dirs);
  if (!win) throw new Error('procsNaming walks descendants through Win32_Process, so it runs on Windows only; no POSIX caller needs it');
  const found = new Map<string, number[]>(dirs.map((d) => [d, []]));
  for (const l of ps(PS_LIST, want, [], 'process read', [], listed ? JSON.stringify(listed) : '')) {
    const [mark, pid] = l.split('\t').map(Number);
    found.get(dirs[mark])?.push(pid);
  }
  return found;
}

/** The pids PS_KILL's lines say it killed; a "failed" line, a process still alive after its kill, throws. */
function killedBy(lines: string[], what: string) {
  const failed = lines.filter((l) => l.startsWith('failed '));
  if (failed.length > 0) throw new Error(`the kill of ${what} failed: ${failed.join('; ')}`);
  return lines.filter((l) => l.startsWith('killed ')).map((l) => Number(l.slice('killed '.length)));
}

/** Kills `child`, which this test spawned and whose exit Node has not seen, so Node's open handle keeps its pid its own, and its descendants, children first; returns the pids killed. */
export function killOwnTree(child: ChildProcess): number[] {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return [];
  if (!win) throw new Error('killOwnTree walks descendants through Win32_Process, so it runs on Windows only; no POSIX caller needs it');
  return killedBy(ps(PS_KILL, [], [], `kill of the tree of ${child.pid}`, [child.pid]), `the tree of ${child.pid}`);
}

/** Kills each live process (of all, or of `only`) naming one of `marks` and returns the pids it killed; a sweep (no `only`) also kills each match's descendants, children first, while a kill of `only` stops just those, as a test crashing one launcher needs. */
export function killNaming(marks: string[], only: number[] = []): number[] {
  const want = marksOf(marks);
  if (win) {
    return killedBy(ps(PS_KILL, want, only, `kill of processes naming ${marks.join(' ')}`), `processes naming ${marks.join(' ')}`);
  }
  if (only.length === 0) throw new Error('a sweep that also stops descendants runs on Windows only; on POSIX pass the pids to kill');
  // SHORTCUT: POSIX reads then signals with no handle between; pids there climb to pid_max before reuse, pidfd if that ever matters.
  const r = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  const rows = (r.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (r.status !== 0 || rows.length === 0) throw new Error(`the process read failed: exit ${r.status} ${r.error?.message ?? r.stderr}`);
  const killed: number[] = [];
  for (const row of rows) {
    const at = row.indexOf(' ');
    const pid = Number(at < 0 ? row : row.slice(0, at));
    if (!only.includes(pid) || !want.some((m) => norm(at < 0 ? '' : row.slice(at + 1)).includes(m))) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ESRCH')) throw err;
    }
  }
  return killed;
}
