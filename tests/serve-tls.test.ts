// `hippo serve` answers HTTPS when given a certificate, and says so at boot when a network bind would carry keys and memories in cleartext.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTlsFiles } from '../src/cli/serve.js';
import { log } from '../src/log.js';
import { serve, type ServerHandle } from '../src/server.js';
import { initStore } from '../src/store/open.js';
import { makeRoot } from './_helpers/make-root.js';
import { runInProcess } from './_helpers/run-in-process.js';
import { makeTestCertificate, type TestCertificate } from './_helpers/self-signed-cert.js';

const ENV_KEYS = ['HIPPO_REQUIRE_AUTH', 'HIPPO_TLS_CERT', 'HIPPO_TLS_KEY'] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
const CLI_PATH = join(process.cwd(), 'dist', 'cli.js');

let pair: TestCertificate;
let dir: string;
let certPath: string;
let keyPath: string;

beforeAll(() => {
  pair = makeTestCertificate();
  dir = mkdtempSync(join(tmpdir(), 'hippo-tls-files-'));
  certPath = join(dir, 'test-only-cert.pem');
  keyPath = join(dir, 'test-only-key.pem');
  writeFileSync(certPath, pair.cert);
  writeFileSync(keyPath, pair.key);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface Reply {
  status: number;
  body: string;
}

/** GET over TLS, trusting only the test certificate, so a server with any other certificate fails the handshake. */
function getOverTls(port: number, path: string): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port, path, ca: pair.cert, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function getInCleartext(port: number, path: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('serve({ tls })', () => {
  let root: string;
  let handle: ServerHandle | undefined;

  beforeEach(() => {
    root = makeRoot('serve-tls');
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('answers HTTPS with the given certificate, reports an https URL, and takes no cleartext request', async () => {
    handle = await serve({ hippoRoot: root, port: 0, tls: pair });
    expect(handle.url).toBe(`https://127.0.0.1:${handle.port}`);
    const health = await getOverTls(handle.port, '/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, pid: process.pid });
    expect((await getOverTls(handle.port, '/v1/memories?q=x')).status).toBe(200);
    await expect(getInCleartext(handle.port, '/health')).rejects.toThrow();
  });

  it('refuses to start on certificate text that is not a certificate, naming TLS as the cause', async () => {
    await expect(serve({ hippoRoot: root, port: 0, tls: { cert: 'not a certificate', key: pair.key } }))
      .rejects.toThrow(/TLS certificate or key was refused/);
  });

  const cleartextWarnings = (warn: { mock: { calls: unknown[][] } }): string[] =>
    warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('cleartext'));

  it('warns once at boot when a network bind has no TLS, and still starts', async () => {
    process.env.HIPPO_REQUIRE_AUTH = '1';
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    handle = await serve({ hippoRoot: root, host: '0.0.0.0', port: 0 });
    expect(cleartextWarnings(warn)).toEqual([
      expect.stringMatching(/listening on 0\.0\.0\.0 without TLS.*API keys and memory text travel in cleartext unless a TLS-terminating proxy sits in front.*--tls-cert and --tls-key/),
    ]);
    expect(await getInCleartext(handle.port, '/health')).toBe(200);
  });

  it('does not warn on a network bind with TLS, or on a loopback bind without it', async () => {
    process.env.HIPPO_REQUIRE_AUTH = '1';
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    handle = await serve({ hippoRoot: root, host: '0.0.0.0', port: 0, tls: pair });
    expect((await getOverTls(handle.port, '/health')).status).toBe(200);
    await handle.stop();
    handle = await serve({ hippoRoot: root, port: 0 });
    expect(cleartextWarnings(warn)).toEqual([]);
  });
});

describe('the --tls-cert and --tls-key flags', () => {
  it('reads both files from the flags', () => {
    const files = readTlsFiles({ 'tls-cert': certPath, 'tls-key': keyPath });
    expect(files?.cert.toString()).toBe(pair.cert);
    expect(files?.key.toString()).toBe(pair.key);
  });

  it('reads both files from HIPPO_TLS_CERT and HIPPO_TLS_KEY, and lets a flag win', () => {
    process.env.HIPPO_TLS_CERT = join(dir, 'missing.pem');
    process.env.HIPPO_TLS_KEY = keyPath;
    expect(readTlsFiles({ 'tls-cert': certPath })?.cert.toString()).toBe(pair.cert);
    process.env.HIPPO_TLS_CERT = certPath;
    expect(readTlsFiles({})?.key.toString()).toBe(pair.key);
  });

  it('means no TLS when neither is given', () => {
    expect(readTlsFiles({})).toBeUndefined();
  });

  it.each([
    ['only a certificate', { 'tls-cert': 'cert.pem' }, /needs both a certificate and a key/],
    ['only a key', { 'tls-key': 'key.pem' }, /needs both a certificate and a key/],
    ['a flag with no value', { 'tls-cert': true, 'tls-key': 'key.pem' }, /--tls-cert requires a value/],
    ['a file that does not exist', { 'tls-cert': 'no-such-cert.pem', 'tls-key': 'no-such-key.pem' }, /cannot read the TLS files/],
  ])('exits 1 on %s rather than serve in cleartext', async (_case, flags, message) => {
    const run = await runInProcess(() => { readTlsFiles(flags); });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(message);
  });
});

describe('the hippo serve command', () => {
  let home: string;
  const children: Array<() => void> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-serve-cli-'));
    mkdirSync(join(home, '.hippo'), { recursive: true });
    initStore(join(home, '.hippo'));
  });

  afterEach(async () => {
    for (const kill of children.splice(0)) kill();
    // The child holds the store open for a moment after the kill on Windows.
    await new Promise((r) => setTimeout(r, 200));
    try { rmSync(home, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  /** Starts `hippo serve` and resolves with what it printed once the banner is complete. */
  function startServe(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_PATH, 'serve', '--port', '0', ...args], {
        cwd: home,
        env: { ...process.env, HIPPO_HOME: join(home, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      children.push(() => child.kill('SIGKILL'));
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => reject(new Error(`no banner within 30 s. stdout=${stdout} stderr=${stderr}`)), 30_000);
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (!stdout.includes('press Ctrl+C to stop')) return;
        clearTimeout(timer);
        resolve({ stdout, stderr });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`hippo serve exited early (code=${code}). stdout=${stdout} stderr=${stderr}`));
      });
    });
  }

  it('serves HTTPS from --tls-cert and --tls-key and says that local requests need no key', async () => {
    const { stdout, stderr } = await startServe(['--tls-cert', certPath, '--tls-key', keyPath], {});
    const port = Number(/listening on https:\/\/127\.0\.0\.1:(\d+) /.exec(stdout)?.[1]);
    expect(port).toBeGreaterThan(0);
    expect((await getOverTls(port, '/health')).status).toBe(200);
    expect(stdout).toContain('local requests need no API key and act as host admin; set HIPPO_REQUIRE_AUTH=1 to require a key on every request');
    expect(stderr).not.toContain('unknown flag');
    expect(stderr).not.toContain('cleartext');
  }, 60_000);

  it('serves HTTPS from HIPPO_TLS_CERT and HIPPO_TLS_KEY', async () => {
    const { stdout } = await startServe([], { HIPPO_TLS_CERT: certPath, HIPPO_TLS_KEY: keyPath });
    const port = Number(/listening on https:\/\/127\.0\.0\.1:(\d+) /.exec(stdout)?.[1]);
    expect((await getOverTls(port, '/health')).status).toBe(200);
  }, 60_000);

  it('warns about cleartext on a network bind, and drops the local-trust line once every request needs a key', async () => {
    const { stdout, stderr } = await startServe(['--host', '0.0.0.0'], { HIPPO_REQUIRE_AUTH: '1' });
    expect(stdout).toMatch(/listening on http:\/\/0\.0\.0\.0:\d+ /);
    expect(stdout).not.toContain('local requests need no API key');
    expect(stderr).toMatch(/warn: serve: listening on 0\.0\.0\.0 without TLS.*cleartext unless a TLS-terminating proxy sits in front/);
  }, 60_000);
});
