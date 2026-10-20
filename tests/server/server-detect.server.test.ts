import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  detectServer,
  writePidfile,
  removePidfileIfOwned,
  ServerUnresponsiveError,
} from '../../src/surface/server/server-detect.js';
import { serve } from '../../src/server.js';
import { boundPort } from '../_helpers/listen.js';

// hippoRoot is the directory the pidfile sits directly inside, matching the
// api.ts / store.ts convention. serve() and detectServer take it as-is.
// Bare tmp dir on purpose: no `.hippo` and no store, detectServer takes the dir as-is.
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
      writeFileSync(
        pidfile,
        JSON.stringify({
          schema: 1,
          pid: 99_999_999,
          port: 6789,
          url: 'http://127.0.0.1:6789',
          started_at: new Date().toISOString(),
        }),
      );
      expect(await detectServer(home)).toBeNull();
      // Stale pidfile should have been deleted.
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps an empty pidfile that a starting server has just created', async () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    try {
      writeFileSync(pidfile, '');
      expect(await detectServer(home)).toBeNull();
      expect(existsSync(pidfile)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('removes an empty pidfile that has sat unfilled past the claim window', async () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      writeFileSync(pidfile, '');
      const tenSecondsAgo = new Date(Date.now() - 10_000);
      utimesSync(pidfile, tenSecondsAgo, tenSecondsAgo);
      expect(await detectServer(home)).toBeNull();
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      warn.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ['a live pid', process.pid, true],
    ['a dead pid', 99_999_999, false],
  ])('a port-0 claim with %s is kept only while its claimant lives', async (_name, pid, kept) => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    try {
      writeFileSync(pidfile, JSON.stringify({ schema: 1, pid, port: 0, url: '', started_at: 'x' }));
      expect(await detectServer(home)).toBeNull();
      expect(existsSync(pidfile)).toBe(kept);
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

  it('finds a live server bound to IPv6 loopback through its http://[::1]:port pidfile url', async () => {
    const home = makeRoot();
    const handle = await serve({ hippoRoot: home, port: 0, host: '::1' });
    try {
      expect(handle.url).toBe(`http://[::1]:${handle.port}`);
      const detected = await detectServer(home);
      expect(detected?.url).toBe(handle.url);
      expect(existsSync(join(home, 'server.pid'))).toBe(true);
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
      writeFileSync(
        pidfile,
        JSON.stringify({
          schema: 1,
          pid: process.pid,
          port: 59_999,
          url: 'http://127.0.0.1:59999',
          started_at: new Date().toISOString(),
        }),
      );
      expect(await detectServer(home)).toBeNull();
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps the pidfile and warns when the probe fails for a reason other than refusal', async () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
      }),
    );
    try {
      writeFileSync(
        pidfile,
        JSON.stringify({
          schema: 1,
          pid: process.pid,
          port: 59_998,
          url: 'http://127.0.0.1:59998',
          started_at: new Date().toISOString(),
        }),
      );
      expect(await detectServer(home)).toBeNull();
      expect(existsSync(pidfile)).toBe(true);
      expect(warn.mock.calls.map((c) => String(c[0])).join('')).toContain('kept: the /health probe failed');
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON number', '42'],
    ['an object without a port', JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:1', started_at: 'x' })],
  ])('treats a pidfile holding %s as no server, warns and unlinks it', async (_name, text) => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      writeFileSync(pidfile, text);
      expect(await detectServer(home)).toBeNull();
      expect(existsSync(pidfile)).toBe(false);
      expect(warn.mock.calls.map((c) => String(c[0])).join('')).toContain('is unreadable');
    } finally {
      warn.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('unlinks the pidfile when /health answers with JSON null, a body no hippo server sends', async () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    const stub: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('null');
    });
    try {
      stub.listen(0, '127.0.0.1');
      const port = await boundPort(stub);
      writeFileSync(
        pidfile,
        JSON.stringify({ schema: 1, pid: process.pid, port, url: `http://127.0.0.1:${port}`, started_at: 'x' }),
      );
      expect(await detectServer(home)).toBeNull();
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      stub.closeAllConnections?.();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('logs the error code when a stale pidfile cannot be removed, instead of dropping it', async () => {
    const home = makeRoot();
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // A directory in the pidfile's place cannot be read as JSON and cannot be unlinked either.
      mkdirSync(join(home, 'server.pid'));
      expect(await detectServer(home)).toBeNull();
      expect(warn.mock.calls.map((c) => String(c[0])).join('')).toMatch(
        /could not be removed \((EISDIR|EPERM|EACCES)\)/,
      );
    } finally {
      warn.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('throws ServerUnresponsiveError and keeps the pidfile when /health times out, and serve() refuses to start beside it', async () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    // A stub server that accepts the connection but never answers, so the
    // AbortSignal.timeout inside detectServer fires.
    const stub: Server = createServer(() => {
      /* deliberately never responds */
    });
    try {
      const port = await new Promise<number>((resolve) => {
        stub.listen(0, '127.0.0.1', () => {
          const addr = stub.address();
          // SAFETY: stub.address() is AddressInfo | string | null. Casting straight to
          // AddressInfo | null and reading .port is safe without a typeof check: when addr
          // is actually a string, property access on it yields undefined (strings have no
          // "port"), so `?? 0` below still falls back correctly.
          resolve((addr as AddressInfo | null)?.port ?? 0);
        });
      });
      writeFileSync(
        pidfile,
        JSON.stringify({
          schema: 1,
          pid: process.pid,
          port,
          url: `http://127.0.0.1:${port}`,
          started_at: new Date().toISOString(),
        }),
      );
      // A busy server misses the probe too, so a timeout must stop the caller from opening the store as a second writer.
      await expect(detectServer(home)).rejects.toThrow(ServerUnresponsiveError);
      expect(existsSync(pidfile)).toBe(true);
      await expect(serve({ hippoRoot: home, port: 0 })).rejects.toThrow(
        /did not answer \/health within \d+ ms; it may be busy/,
      );
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
      expect(removePidfileIfOwned(home, { pid: process.pid, startedAt })).toBe(true);
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
      writeFileSync(
        pidfile,
        JSON.stringify({
          schema: 1,
          pid: process.pid,
          port: 6789,
          url: 'http://malicious.example.com:6789',
          started_at: new Date().toISOString(),
        }),
      );
      expect(await detectServer(home)).toBeNull();
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('removePidfileIfOwned removes the pidfile when pid and started_at both match', () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    try {
      const startedAt = new Date().toISOString();
      writeFileSync(
        pidfile,
        JSON.stringify({
          schema: 1,
          pid: process.pid,
          port: 6789,
          url: 'http://127.0.0.1:6789',
          started_at: startedAt,
        }),
      );
      expect(removePidfileIfOwned(home, { pid: process.pid, startedAt })).toBe(true);
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('removePidfileIfOwned keeps the pidfile when started_at differs (a newer server rewrote it)', () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    try {
      // Same pid (a second server could share this process), different
      // started_at. The (pid, started_at) tuple must treat this as not-ours.
      writeFileSync(
        pidfile,
        JSON.stringify({
          schema: 1,
          pid: process.pid,
          port: 6790,
          url: 'http://127.0.0.1:6790',
          started_at: '2099-01-01T00:00:00.000Z',
        }),
      );
      expect(
        removePidfileIfOwned(home, {
          pid: process.pid,
          startedAt: '2026-01-01T00:00:00.000Z',
        }),
      ).toBe(false);
      expect(existsSync(pidfile)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('removePidfileIfOwned keeps the pidfile when pid differs', () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    try {
      const startedAt = new Date().toISOString();
      // started_at matches but the pid is a different process. The pid value
      // is arbitrary — removePidfileIfOwned compares it, never probes it.
      writeFileSync(
        pidfile,
        JSON.stringify({
          schema: 1,
          pid: process.pid + 1,
          port: 6789,
          url: 'http://127.0.0.1:6789',
          started_at: startedAt,
        }),
      );
      expect(removePidfileIfOwned(home, { pid: process.pid, startedAt })).toBe(false);
      expect(existsSync(pidfile)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('removePidfileIfOwned returns false without throwing when no pidfile exists', () => {
    const home = makeRoot();
    try {
      expect(
        removePidfileIfOwned(home, {
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
      ).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('removePidfileIfOwned leaves a malformed pidfile in place without throwing', () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    try {
      writeFileSync(pidfile, 'not json at all');
      expect(
        removePidfileIfOwned(home, {
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
      ).toBe(false);
      // Not provably ours, so left alone; detectServer unlinks malformed
      // pidfiles on its next probe.
      expect(existsSync(pidfile)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('removePidfileIfOwned keeps a valid-JSON pidfile that lacks pid and started_at', () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    try {
      // Parses as JSON but carries no pid/started_at — info.pid is undefined,
      // so the identity check fails closed and the file is left in place.
      writeFileSync(pidfile, JSON.stringify({ schema: 1, port: 6789 }));
      expect(
        removePidfileIfOwned(home, {
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
      ).toBe(false);
      expect(existsSync(pidfile)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('removePidfileIfOwned leaves a pidfile that is literally JSON null without throwing', () => {
    const home = makeRoot();
    const pidfile = join(home, 'server.pid');
    try {
      // `null` parses cleanly but is not an object — property access on it
      // throws. removePidfileIfOwned must absorb that, not propagate it.
      writeFileSync(pidfile, 'null');
      expect(
        removePidfileIfOwned(home, {
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
      ).toBe(false);
      expect(existsSync(pidfile)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
