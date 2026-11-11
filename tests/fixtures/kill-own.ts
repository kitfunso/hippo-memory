// Finds and stops a test's processes by a folder their command line names, so a test never signals a pid that has passed to another process.
import { spawnSync } from 'node:child_process';

const win = process.platform === 'win32';
const norm = (s: string) => s.replace(/\\+/g, '/').toLowerCase();

// Marks and pids arrive as env vars, so no path is quoted into the script.
const PS_LIST = `
$only = @($env:Z0_OWN_ONLY -split ',' | Where-Object { $_ })
$q = if ($only.Count) { Get-CimInstance Win32_Process -Filter (($only | ForEach-Object { "ProcessId=$_" }) -join ' OR ') } else { Get-CimInstance Win32_Process }
$q | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }
`;
const PS_KILL = `
$ErrorActionPreference = 'Stop'
$marks = @($env:Z0_OWN_MARKS -split '\\|' | Where-Object { $_ })
$only = @($env:Z0_OWN_ONLY -split ',' | Where-Object { $_ })
function Mine {
  $q = if ($only.Count) { Get-CimInstance Win32_Process -Filter (($only | ForEach-Object { "ProcessId=$_" }) -join ' OR ') } else { Get-CimInstance Win32_Process }
  @($q | Where-Object { $t = ([string]$_.CommandLine -replace '\\\\+', '/').ToLower(); @($marks | Where-Object { $t.Contains($_) }).Count -gt 0 } | ForEach-Object { [int]$_.ProcessId })
}
# An open handle keeps a pid on its process, so the second read and the kill reach the process the handle holds.
$held = [System.Collections.Generic.List[object]]::new()
$out = [System.Collections.Generic.List[string]]::new()
foreach ($id in Mine) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  try { $null = $p.Handle; $held.Add($p) } catch { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $out.Add("failed $id $($_.Exception.Message)") } }
}
$still = Mine
foreach ($p in $held) {
  if ($still -notcontains $p.Id) { continue }
  try { $p.Kill(); $null = $p.WaitForExit(10000); $out.Add("killed $($p.Id)") } catch { if (-not $p.HasExited) { $out.Add("failed $($p.Id) $($_.Exception.Message)") } }
}
$out
`;

const ps = (script: string, env: Record<string, string>) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true, env: { ...process.env, ...env },
});

/** Every live process (or each of `only` still alive) as pid and command line, from one process read. */
function list(only: number[]) {
  const r = win ? ps(PS_LIST, { Z0_OWN_ONLY: only.join(',') }) : spawnSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`the process read failed: exit ${r.status} ${r.error?.message ?? r.stderr}`);
  const rows = r.stdout.split(/\r?\n/).map((l) => (win ? l : l.trim())).filter((l) => l !== '').map((l) => {
    const at = win ? l.indexOf('\t') : l.indexOf(' ');
    return { pid: Number(at < 0 ? l : l.slice(0, at)), cmd: at < 0 ? '' : l.slice(at + 1) };
  });
  return only.length ? rows.filter((p) => only.includes(p.pid)) : rows;
}

/** For each folder, the live processes whose command line names it; a case's folder is unique, so a reused pid never matches. */
export function procsNaming(dirs: string[]) {
  const found = new Map<string, number[]>(dirs.map((d) => [d, []]));
  for (const { pid, cmd } of list([])) {
    const text = norm(cmd);
    for (const d of dirs) if (text.includes(norm(d))) found.get(d)?.push(pid);
  }
  return found;
}

/** Kills each live process (of all, or of `only`) whose command line names one of `marks`, and returns the pids it killed; a pid whose process is gone or names no mark is skipped. */
export function killNaming(marks: string[], only: number[] = []): number[] {
  const want = marks.map(norm);
  if (!win) {
    // SHORTCUT: POSIX reads then signals with no handle between; pids there climb to pid_max before reuse, pidfd if that ever matters.
    const killed: number[] = [];
    for (const { pid, cmd } of list(only)) {
      if (!want.some((m) => norm(cmd).includes(m))) continue;
      try {
        process.kill(pid, 'SIGKILL');
        killed.push(pid);
      } catch (err) {
        if (!(err instanceof Error && 'code' in err && err.code === 'ESRCH')) throw err;
      }
    }
    return killed;
  }
  const r = ps(PS_KILL, { Z0_OWN_MARKS: want.join('|'), Z0_OWN_ONLY: only.join(',') });
  const lines = r.stdout.split(/\r?\n/).filter((l) => l !== '');
  const failed = lines.filter((l) => l.startsWith('failed '));
  if (r.status !== 0 || failed.length > 0) throw new Error(`the kill of processes naming ${marks.join(' ')} failed: exit ${r.status} ${[...failed, r.error?.message ?? r.stderr].join('; ')}`);
  return lines.filter((l) => l.startsWith('killed ')).map((l) => Number(l.slice('killed '.length)));
}
