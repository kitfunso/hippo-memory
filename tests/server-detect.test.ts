import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectServer, writePidfile, removePidfile } from '../src/server-detect.js';

describe('server-detect', () => {
  it('returns null when no pidfile exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-pidf-'));
    expect(detectServer(home)).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when pidfile exists but process is dead', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-pidf-'));
    // hippoRoot is the .hippo directory itself, matching the api.ts/store.ts
    // convention; pidfile sits directly inside it.
    const pidfile = join(home, 'server.pid');
    writeFileSync(pidfile,
      JSON.stringify({ pid: 99999999, port: 6789, url: 'http://127.0.0.1:6789', started_at: new Date().toISOString() }));
    expect(detectServer(home)).toBeNull();
    // Stale pidfile should have been deleted
    expect(existsSync(pidfile)).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it('writePidfile + removePidfile roundtrip', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-pidf-'));
    writePidfile(home, { port: 6789, url: 'http://127.0.0.1:6789' });
    const detected = detectServer(home);
    expect(detected?.url).toBe('http://127.0.0.1:6789');
    expect(detected?.pid).toBe(process.pid);
    removePidfile(home);
    expect(detectServer(home)).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});
