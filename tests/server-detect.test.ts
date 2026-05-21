import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { detectServer, writePidfile, removePidfile } from '../src/server-detect.js';
import { serve } from '../src/server.js';

// hippoRoot is the directory the pidfile sits directly inside, matching the
// api.ts / store.ts convention. serve() and detectServer take it as-is.
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'hippo-pidf-'));
}

describe('server-detect', () => {
  it('returns null when no pidfile exists', async () => {
    const home = makeRoot();
    try {
      expect(await detectServer(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns null and unlinks a pidfile whose process is dead (H1 case d)', async () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    try {
      writeFileSync(pidfile, JSON.stringify({
        schema: 1, pid: 99_999_999, port: 6789,
        url: 'http://127.0.0.1:6789', started_at: new Date().toISOString(),
      }));
      expect(await detectServer(home)).toBeNull();
      // Stale pidfile should have been deleted.
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns the info when a live server /health started_at matches (H1 case a)', async () => {
    const home = makeRoot();
    const handle = await serve({ hippoRoot: home, port: 0 });
    try {
      const detected = await detectServer(home);
      expect(detected).not.toBeNull();
      expect(detected?.url).toBe(handle.url);
      expect(detected?.pid).toBe(process.pid);
    } finally {
      await handle.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns null and unlinks when /health started_at does not match (H1 case b)', async () => {
    const home = makeRoot();
    const handle = await serve({ hippoRoot: home, port: 0 });
    const pidfile = join(home, 'server.pid');
    try {
      // The server is genuinely live, but rewrite the pidfile's started_at to
      // a value /health will never report — simulates the pid + port being
      // held by a different process than the one named in the pidfile.
      const info = JSON.parse(readFileSync(pidfile, 'utf8'));
      info.started_at = '1999-01-01T00:00:00.000Z';
      writeFileSync(pidfile, JSON.stringify(info));

      expect(await detectServer(home)).toBeNull();
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      await handle.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns null and unlinks when /health is unreachable (H1 case c)', async () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    try {
      // pid is alive (this very test process) but nothing listens on the url,
      // so the probe gets connection-refused — the pidfile is stale.
      writeFileSync(pidfile, JSON.stringify({
        schema: 1, pid: process.pid, port: 59_999,
        url: 'http://127.0.0.1:59999', started_at: new Date().toISOString(),
      }));
      expect(await detectServer(home)).toBeNull();
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns null but keeps the pidfile when /health times out (H1 case c)', async () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    // A stub server that accepts the connection but never answers, so the
    // AbortSignal.timeout inside detectServer fires.
    const stub: Server = createServer(() => { /* deliberately never responds */ });
    try {
      const port = await new Promise<number>((resolve) => {
        stub.listen(0, '127.0.0.1', () => {
          const addr = stub.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });
      writeFileSync(pidfile, JSON.stringify({
        schema: 1, pid: process.pid, port,
        url: `http://127.0.0.1:${port}`, started_at: new Date().toISOString(),
      }));
      expect(await detectServer(home)).toBeNull();
      // A timeout is ambiguous (the server may be alive but busy), so the
      // pidfile is left in place for the next probe to re-confirm.
      expect(existsSync(pidfile)).toBe(true);
    } finally {
      stub.closeAllConnections?.();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writePidfile stamps schema 1 and the caller-supplied started_at (L3)', () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    try {
      const startedAt = '2026-05-21T12:00:00.000Z';
      writePidfile(home, { port: 6789, url: 'http://127.0.0.1:6789', startedAt });
      const info = JSON.parse(readFileSync(pidfile, 'utf8'));
      expect(info.schema).toBe(1);
      expect(info.started_at).toBe(startedAt);
      expect(info.pid).toBe(process.pid);
      removePidfile(home);
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('detectServer still accepts a legacy pidfile with no schema field (L3)', async () => {
    const home = makeRoot();
    const handle = await serve({ hippoRoot: home, port: 0 });
    const pidfile = join(home, 'server.pid');
    try {
      // Strip `schema` to mimic a pidfile written before L3. A missing schema
      // is legacy, not invalid — detectServer must still accept it.
      const info = JSON.parse(readFileSync(pidfile, 'utf8'));
      delete info.schema;
      writeFileSync(pidfile, JSON.stringify(info));

      const detected = await detectServer(home);
      expect(detected).not.toBeNull();
      expect(detected?.schema).toBeUndefined();
    } finally {
      await handle.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects and unlinks a pidfile whose url is not loopback (forged pidfile)', async () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    try {
      // pid is alive (this test process), but the url points off-box. A real
      // hippo server only binds loopback, so detectServer must treat this as a
      // forged or malformed pidfile and never probe the off-box host.
      writeFileSync(pidfile, JSON.stringify({
        schema: 1, pid: process.pid, port: 6789,
        url: 'http://malicious.example.com:6789',
        started_at: new Date().toISOString(),
      }));
      expect(await detectServer(home)).toBeNull();
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
