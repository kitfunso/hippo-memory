// `hippo serve` answers HTTPS when given a certificate and key; half a pair or an unreadable file stops it, never a quiet fall back to cleartext.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '../src/util/log.js';
import { serve, type ServerHandle } from '../src/server.js';
import { initStore } from '../src/store/open.js';

const CLI_PATH = join(process.cwd(), 'dist', 'cli.js');
const savedRequireAuth = process.env.HIPPO_REQUIRE_AUTH;

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length = body.length < 0x80 ? [body.length]
    : body.length < 0x100 ? [0x81, body.length]
    : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts);
const oid = (hex: string): Buffer => der(0x06, Buffer.from(hex, 'hex'));
const utcTime = (at: Date): Buffer => der(0x17, Buffer.from(`${at.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`, 'ascii'));
const ECDSA_WITH_SHA256 = sequence(oid('2a8648ce3d040302'));
const DAY_MS = 86_400_000;

interface TestPair {
  cert: string;
  key: string;
}

/** A throwaway self-signed pair for 127.0.0.1, built per run so no key is committed; node:crypto signs but cannot build X.509, hence the DER by hand. */
function selfSignedPair(): TestPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('hippo test only', 'utf8')))));
  // DER wants the shortest positive form: top bit clear and a first byte that is never zero.
  const serialBytes = randomBytes(8);
  serialBytes.writeUInt8((serialBytes.readUInt8(0) & 0x3f) | 0x40, 0);
  const altNames = sequence(der(0x82, Buffer.from('localhost', 'ascii')), der(0x87, Buffer.from([127, 0, 0, 1])));
  const extensions = sequence(
    sequence(oid('551d11'), der(0x04, altNames)),
    // CA:TRUE, so the client can trust this one certificate as its own issuer.
    sequence(oid('551d13'), der(0x01, Buffer.from([0xff])), der(0x04, sequence(der(0x01, Buffer.from([0xff]))))),
  );
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serialBytes),
    ECDSA_WITH_SHA256,
    name,
    sequence(utcTime(new Date(Date.now() - DAY_MS)), utcTime(new Date(Date.now() + DAY_MS))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, extensions),
  );
  const certificate = sequence(tbs, ECDSA_WITH_SHA256, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  const lines = certificate.toString('base64').match(/.{1,64}/g) ?? [];
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** GET /health over TLS, trusting only the test certificate, so a server holding any other certificate fails the handshake. */
function healthOverTls(port: number, ca: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port, path: '/health', ca, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

function healthInCleartext(port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/health', agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('hippo serve over TLS', () => {
  let pair: TestPair;
  let home: string;
  let hippoRoot: string;
  let certPath: string;
  let keyPath: string;
  let handle: ServerHandle | undefined;
  const children: Array<() => void> = [];

  beforeAll(() => {
    pair = selfSignedPair();
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-serve-tls-'));
    hippoRoot = join(home, '.hippo');
    mkdirSync(hippoRoot, { recursive: true });
    initStore(hippoRoot);
    certPath = join(home, 'test-only-cert.pem');
    keyPath = join(home, 'test-only-key.pem');
    writeFileSync(certPath, pair.cert);
    writeFileSync(keyPath, pair.key);
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    vi.restoreAllMocks();
    if (savedRequireAuth === undefined) delete process.env.HIPPO_REQUIRE_AUTH;
    else process.env.HIPPO_REQUIRE_AUTH = savedRequireAuth;
    for (const kill of children.splice(0)) kill();
    // A killed child holds the store open for a moment on Windows.
    if (process.platform === 'win32') await new Promise((r) => setTimeout(r, 200));
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv =>
    ({ ...process.env, HIPPO_HOME: join(home, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1', ...extra });

  it('answers HTTPS with the given certificate on a network bind, takes no cleartext request and logs no cleartext warning', async () => {
    process.env.HIPPO_REQUIRE_AUTH = '1';
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    handle = await serve({ hippoRoot, host: '0.0.0.0', port: 0, tls: pair });
    expect(handle.url).toBe(`https://0.0.0.0:${handle.port}`);
    expect(await healthOverTls(handle.port, pair.cert)).toBe(200);
    await expect(healthInCleartext(handle.port)).rejects.toThrow();
    expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('cleartext'))).toEqual([]);
  });

  it('refuses to start on certificate text that is not a certificate, naming TLS as the cause', async () => {
    await expect(serve({ hippoRoot, port: 0, tls: { cert: 'not a certificate', key: pair.key } }))
      .rejects.toThrow(/TLS certificate or key was refused/);
  });

  /** Starts the real command and resolves with what it printed once its start lines are complete. */
  function startServe(args: string[], env: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_PATH, 'serve', '--port', '0', ...args], {
        cwd: home, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      children.push(() => child.kill('SIGKILL'));
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => reject(new Error(`no start lines within 30 s. stdout=${stdout} stderr=${stderr}`)), 30_000);
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (!stdout.includes('press Ctrl+C to stop')) return;
        clearTimeout(timer);
        resolve(stdout);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`hippo serve exited early (code=${code}). stdout=${stdout} stderr=${stderr}`));
      });
    });
  }

  it.each([
    ['--tls-cert and --tls-key', (cert: string, key: string) => ({ args: ['--tls-cert', cert, '--tls-key', key], env: {} })],
    ['HIPPO_TLS_CERT and HIPPO_TLS_KEY', (cert: string, key: string) => ({ args: [], env: { HIPPO_TLS_CERT: cert, HIPPO_TLS_KEY: key } })],
  ])('the command serves HTTPS from %s, and says at start that local requests need no key', async (_source, given) => {
    const { args, env } = given(certPath, keyPath);
    const stdout = await startServe(args, env);
    const port = Number(/listening on https:\/\/127\.0\.0\.1:(\d+) /.exec(stdout)?.[1]);
    expect(await healthOverTls(port, pair.cert)).toBe(200);
    expect(stdout).toContain('requests from this machine need no API key and act as host admin (HIPPO_ALLOW_KEYLESS_LOCAL=1); unset it to require a key on every request');
  }, 60_000);

  it.each([
    ['only a certificate', ['--tls-cert', 'cert.pem'], /needs both a certificate and a key/],
    ['a file that does not exist', ['--tls-cert', 'no-such-cert.pem', '--tls-key', 'no-such-key.pem'], /cannot read the TLS files/],
  ])('the command exits 1 on %s rather than serve in cleartext', (_case, args, message) => {
    // The timeout ends a run that served anyway, which then fails the status check.
    const run = spawnSync(process.execPath, [CLI_PATH, 'serve', '--port', '0', ...args], {
      cwd: home, env: childEnv({}), encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(message);
  }, 60_000);
});
