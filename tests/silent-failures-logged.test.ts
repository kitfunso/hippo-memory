// Each failure here used to be swallowed; the test forces it and reads the line it now leaves on stderr.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fetchWithRetry } from '../src/util/http-retry.js';
import { heartbeatVerdict } from '../src/server/auth.js';
import { resolveEmbeddingProvider } from '../src/embeddings/provider.js';
import { handleInit } from '../src/cli/init.js';
import { cmdCapture } from '../src/capture/command.js';
import { loadConfig } from '../src/core/config.js';
import { resolveEmbeddingModel } from '../src/embeddings/local.js';
import { countTableRows } from '../src/db/tables.js';
import { insertDormantRow, listDormantSnapshots } from '../src/store/dormant.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { initStore } from '../src/store/open.js';
import { renderGraphHtml } from '../src/graph/view.js';
import { resetLogOnce } from '../src/util/log.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

let root: string;
let stderr: MockInstance<typeof process.stderr.write>;

const logged = (): string[] => stderr.mock.calls.map((call) => String(call[0]));
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: forced`), { code });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-silent-'));
  resetLogOnce();
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.HIPPO_LOG;
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Makes fs.readdirSync throw `code` for the rest of the test, mirrored into the ESM named exports. */
function failReaddir(code: string): void {
  vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw errno(code); });
  syncBuiltinESMExports();
}

/** Makes fs.statSync throw `code` for `target` only. */
function failStat(code: string, target: string): void {
  const real = fs.statSync;
  // SAFETY: the stand-in forwards every call it does not fail to the real statSync with the caller's own arguments.
  const stand = ((p: fs.PathLike, ...rest: [fs.StatSyncOptions?]) => {
    if (String(p) === target) throw errno(code);
    return real(p, ...rest);
  }) as typeof fs.statSync;
  vi.spyOn(fs, 'statSync').mockImplementation(stand);
  syncBuiltinESMExports();
}

describe('http retry', () => {
  it('logs each retry at debug with method, host and path, never the query', async () => {
    process.env.HIPPO_LOG = 'debug';
    const replies = [new Response('', { status: 503 }), new Response('', { status: 429 }), new Response('ok')];
    const fetchFn = vi.fn(async () => replies.shift()!);
    const res = await fetchWithRetry('https://api.example.test/v1/items?key=SECRET', { method: 'POST' }, {
      timeoutMs: 1000, fetchFn, sleep: async () => {}, retryOn: (r) => r.status === 503 || r.status === 429,
    });
    expect(await res.text()).toBe('ok');
    const lines = logged().filter((l) => l.includes('http retry'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('method=POST');
    expect(lines[0]).toContain('target=api.example.test/v1/items');
    expect(lines[0]).toContain('reason=status 503');
    expect(lines[0]).toContain('attempt=1/3');
    expect(lines[1]).toContain('reason=status 429');
    expect(logged().join('')).not.toContain('SECRET');
  });
});

describe('heartbeatVerdict', () => {
  it('logs a non-HttpError at error and still answers unavailable', async () => {
    // A request with no socket makes the keyless-local check throw a TypeError, not an HttpError.
    // SAFETY: a bare object stands in for the request and the options; only the code path under test reads them.
    const req = { headers: {} } as IncomingMessage;
    // SAFETY: see above.
    const verdict = await heartbeatVerdict(req, { hippoRoot: root } as Parameters<typeof heartbeatVerdict>[1]);
    expect(verdict).toBe('unavailable');
    expect(logged().some((l) => l.includes('error: heartbeat auth check failed'))).toBe(true);
  });
});

describe('embedding provider', () => {
  it('logs at debug why an error body could not be read', async () => {
    initStore(root);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'm' } }), 'utf8');
    process.env.HIPPO_LOG = 'debug';
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key-not-real';
    try {
      const body = new ReadableStream({ start(c) { c.error(new Error('socket reset mid-body')); } });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 400 })));
      const provider = resolveEmbeddingProvider(root, {});
      await expect(provider.embed(['x'], 'passage')).rejects.toThrow(/HTTP 400/);
      expect(logged().some((l) => l.includes('debug:') && l.includes('socket reset mid-body'))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe('repo scan in init', () => {
  const scan = (dir: string): void => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    handleInit({ hippoRoot: root, tenantId: 'default', args: [], flags: { scan: dir } });
  };

  it('warns with path and code for an unexpected readdir failure', () => {
    failReaddir('EIO');
    scan(root);
    const line = logged().find((l) => l.includes('repo scan skipped'));
    expect(line).toContain(root);
    expect(line).toContain('code=EIO');
  });

  it.each(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'])('stays silent for %s', (code) => {
    failReaddir(code);
    scan(root);
    expect(logged().filter((l) => l.includes('repo scan skipped'))).toEqual([]);
  });
});

describe('capture log append', () => {
  it('warns once when appends fail after the banner', () => {
    initStore(root);
    const logFile = path.join(root, 'capture.log');
    const blank = path.join(root, 'blank.txt');
    fs.writeFileSync(blank, ' ');
    const real = fs.appendFileSync;
    // SAFETY: the stand-in fails every append but the banner and forwards that one to the real appendFileSync.
    const stand = ((p: fs.PathOrFileDescriptor, data: string | Uint8Array, ...rest: [fs.WriteFileOptions?]) => {
      if (String(p) === logFile && !String(data).includes('capturing session')) throw errno('ENOSPC');
      return real(p, data, ...rest);
    }) as typeof fs.appendFileSync;
    vi.spyOn(fs, 'appendFileSync').mockImplementation(stand);
    syncBuiltinESMExports();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // The test runner replaces console, so route its lines through the stream the tee wraps.
    vi.spyOn(console, 'log').mockImplementation((line: string) => process.stdout.write(`${line}
`));
    cmdCapture(root, { source: 'file', filePath: blank, dryRun: true, global: false, logFile });
    expect(logged().filter((l) => l.includes('is no longer writable'))).toHaveLength(1);
  });
});

describe('config stamp', () => {
  it('warns with path and code when config.json is unreadable, and falls back', () => {
    initStore(root);
    const config = path.join(root, 'config.json');
    fs.writeFileSync(config, '{}');
    failStat('EACCES', config);
    const cfg = loadConfig(root);
    expect(cfg.embeddings).toBeDefined();
    const line = logged().find((l) => l.includes('warn:') && l.includes('could not be reached'));
    expect(line).toContain('code=EACCES');
    expect(line).toContain('config.json');
  });
});

describe('resolveEmbeddingModel', () => {
  it('warns with the reason before it falls back to the default model', () => {
    // @ts-expect-error a non-string root is the cheapest way to make loadConfig throw
    const model = resolveEmbeddingModel(undefined);
    expect(model.length).toBeGreaterThan(0);
    expect(logged().some((l) => l.includes('warn: embedding model config unreadable'))).toBe(true);
  });
});

describe('countTableRows', () => {
  it('warns with the table name and keeps the null', () => {
    initStore(root);
    const db = openHippoDb(root);
    try {
      expect(countTableRows(db, 'no_such_table')).toBeNull();
    } finally {
      closeHippoDb(db);
    }
    const line = logged().find((l) => l.includes('could not count rows'));
    expect(line).toContain('table=no_such_table');
  });
});

describe('dormant snapshot', () => {
  it('warns when the stored content no longer matches its snapshot', () => {
    initStore(root);
    const db = openHippoDb(root);
    try {
      const entry = createMemory('the retired cron host was called nightly-02');
      insertDormantRow(db, { entry, strength: 0.01, reason: 'decay', dormantAt: new Date().toISOString() });
      db.prepare('UPDATE dormant_memories SET content = ? WHERE id = ?').run('edited by hand', entry.id);
      expect(listDormantSnapshots(db, entry.tenantId)).toEqual([]);
      const line = logged().find((l) => l.includes('dormant_memories.entry_json'));
      expect(line).toContain('wrong shape');
      expect(line).toContain(`id=${entry.id}`);
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('graph page script', () => {
  it('reports a model that will not parse instead of swallowing it', () => {
    const html = renderGraphHtml({ nodes: [], edges: [], truncated: false });
    expect(html).toContain('catch(e){console.error(');
    expect(html).not.toContain('catch(_){}');
  });
});
