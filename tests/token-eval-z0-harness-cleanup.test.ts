// The shared Z0 cleanup stops a hung fake's grandchild only while its pid is still that grandchild, never a process that took the pid after it exited.
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, isolate } from './fixtures/z0-harness.js';

const started: ChildProcess[] = [];
const exited = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve();
  else child.once('exit', () => resolve());
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A node child this test holds a handle to, so the test can always end it itself; it starts outside isolate's cwd, which cleanup removes. */
function node(script: string) {
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore', windowsHide: true, cwd: tmpdir() });
  started.push(child);
  return child;
}

afterEach(async () => {
  for (const child of started.splice(0)) {
    child.kill();
    await exited(child);
  }
  cleanup();
});

describe('cleanup and a hung fake grandchild\'s pid file', () => {
  it('a grandchild.pid whose number now belongs to another process leaves that process running', async () => {
    const { out } = isolate('pid-reused');
    const other = node('setInterval(() => {}, 1000)');
    writeFileSync(join(out, 'grandchild.pid'), String(other.pid));
    cleanup();
    await Promise.race([exited(other), sleep(2000)]);
    expect({ exitCode: other.exitCode, signalCode: other.signalCode }).toEqual({ exitCode: null, signalCode: null });
  });

  it('a grandchild.pid whose process has exited is never signalled, and no other process is killed in its place', async () => {
    const { out } = isolate('pid-gone');
    const gone = node('');
    await exited(gone);
    // On Windows no pid reaches process.kill, so a live node that names no folder of the test shows that no fallback, such as a kill by image name, ran instead.
    const bystander = node('setInterval(() => {}, 1000)');
    writeFileSync(join(out, 'grandchild.pid'), String(gone.pid));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      cleanup();
      expect(kill.mock.calls.map(([pid]) => pid)).not.toContain(gone.pid);
    } finally {
      kill.mockRestore();
    }
    await Promise.race([exited(bystander), sleep(2000)]);
    expect({ exitCode: bystander.exitCode, signalCode: bystander.signalCode }).toEqual({ exitCode: null, signalCode: null });
  });

  it('a live grandchild whose command line names the out folder, as the fakes\' tick does, is stopped', async () => {
    const { out } = isolate('pid-live');
    // The path sits in the script as the fakes write it, and the child never touches it, so only a kill can end it.
    const live = node(`const tick = ${JSON.stringify(join(out, 'tick.txt'))}; setInterval(() => {}, 1000);`);
    writeFileSync(join(out, 'grandchild.pid'), String(live.pid));
    cleanup();
    await Promise.race([exited(live), sleep(15_000)]);
    expect(live.exitCode ?? live.signalCode).not.toBeNull();
  });
});
