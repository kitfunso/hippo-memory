// Two serve() boots on one store started together: the pidfile claim lets exactly one listen.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { serve, type ServerHandle } from '../../src/server.js';
import { detectServer, claimPidfile } from '../../src/server/server-detect.js';
import { makeRoot } from '../_helpers/make-root.js';

let root: string;
const handles: ServerHandle[] = [];

beforeEach(() => {
  root = makeRoot('one-per-store');
});

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
  rmSync(root, { recursive: true, force: true });
});

async function boot(): Promise<ServerHandle> {
  const handle = await serve({ hippoRoot: root, port: 0 });
  handles.push(handle);
  return handle;
}

describe('one server per store', () => {
  it('lets exactly one of two boots started together listen, and the other fail as already running', async () => {
    const results = await Promise.allSettled([boot(), boot()]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(String(lost[0]!.reason)).toMatch(/already running/);
    const info = JSON.parse(readFileSync(join(root, 'server.pid'), 'utf8'));
    expect(info.port).toBe(handles[0]!.port);
    expect(info.url).toBe(handles[0]!.url);
  });

  it('refuses a third boot while the first is serving, and boots again once it stopped', async () => {
    const first = await boot();
    await expect(boot()).rejects.toThrow(/already running on port/);
    await first.stop();
    handles.length = 0;
    const second = await boot();
    expect(second.port).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(root, 'server.pid'), 'utf8')).url).toBe(second.url);
  });

  it('removes a pidfile left by a dead process and boots', async () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const stale = { schema: 1, pid: Number(dead.stdout), port: 6789, url: 'http://127.0.0.1:6789', started_at: 'old' };
    writeFileSync(join(root, 'server.pid'), JSON.stringify(stale));
    const handle = await boot();
    expect(JSON.parse(readFileSync(join(root, 'server.pid'), 'utf8')).port).toBe(handle.port);
  });

  it('clears a corrupt pidfile and boots', async () => {
    writeFileSync(join(root, 'server.pid'), '{not json');
    const handle = await boot();
    expect(JSON.parse(readFileSync(join(root, 'server.pid'), 'utf8')).port).toBe(handle.port);
  });

  it('releases its claim when the bind fails, so the next boot is not refused', async () => {
    const otherRoot = makeRoot('one-per-store-other');
    const blocker = await serve({ hippoRoot: otherRoot, port: 0, host: '127.0.0.1' });
    try {
      await expect(serve({ hippoRoot: root, port: blocker.port, host: '127.0.0.1' })).rejects.toThrow();
      expect(existsSync(join(root, 'server.pid'))).toBe(false);
    } finally {
      await blocker.stop();
      rmSync(otherRoot, { recursive: true, force: true });
    }
    const handle = await boot();
    expect(JSON.parse(readFileSync(join(root, 'server.pid'), 'utf8')).port).toBe(handle.port);
  });

  it("keeps a live process's claim that has no port yet, for detectServer and for a second claim", async () => {
    await claimPidfile(root, 'now');
    expect(await detectServer(root)).toBeNull();
    expect(existsSync(join(root, 'server.pid'))).toBe(true);
    await expect(claimPidfile(root, 'later')).rejects.toThrow(/still starting/);
  });
});
