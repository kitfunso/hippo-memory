// A rethrown failure keeps the original error as `cause`, so a log or debugger can reach the real fault.
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspect } from 'node:util';
import { GitReadError, gitLsFilesAtHead } from '../src/churn-git.js';
import { resolveEmbeddingProvider } from '../src/embedding-provider.js';
import { createListener } from '../src/server/tls.js';
import { parseSteps } from '../src/trace.js';

const tmpDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function mkdtemp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cause-'));
  tmpDirs.push(dir);
  return dir;
}

function portOf(server: http.Server): number {
  const addr = server.address();
  if (!(addr instanceof Object)) throw new Error('server is not listening on a TCP port');
  return addr.port;
}

async function listen(handler?: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function closedPort(): Promise<number> {
  const server = await listen();
  const port = portOf(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function caught<T>(run: () => T): Promise<Error> {
  try {
    await run();
  } catch (err) {
    if (err instanceof Error) return err;
  }
  throw new Error('expected the call to throw an Error');
}

function embeddingRoot(port: number): string {
  const root = mkdtemp();
  const embeddings = { provider: 'openai', model: 'm', apiBaseUrl: `http://127.0.0.1:${port}/v1` };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings }), 'utf8');
  return root;
}

describe('rethrown errors keep their cause', () => {
  it.each([
    ['trace steps that are not JSON', () => { parseSteps('{not json'); }, 'Invalid trace steps JSON'],
    ['a git read in a folder that is not a repository', () => { gitLsFilesAtHead(mkdtemp()); }, 'failed'],
    ['a TLS certificate OpenSSL refuses', () => { createListener({ cert: 'nope', key: 'nope' }, () => undefined); }, 'refused'],
  ])('%s', async (_label, run, text) => {
    const err = await caught(run);
    expect(err.message).toContain(text);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('a git failure is a GitReadError whose cause is the child-process error', async () => {
    const err = await caught(() => gitLsFilesAtHead(mkdtemp()));
    expect(err).toBeInstanceOf(GitReadError);
    expect(err.cause).toBeInstanceOf(Error);
  });

  describe('embedding provider', () => {
    const saved = process.env['OPENAI_API_KEY'];
    afterEach(() => {
      if (saved === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = saved;
    });

    it('keeps the transport error when the API port refuses the connection', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';
      const provider = resolveEmbeddingProvider(embeddingRoot(await closedPort()));
      const err = await caught(() => provider.embed(['hello']));
      expect(err.message).toContain('embedding request to openai failed');
      expect(err.cause).toBeInstanceOf(Error);
    });

    it('keeps the parse error when a 200 answer is not JSON', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';
      const port = portOf(await listen((_req, res) => { res.writeHead(200); res.end('not json'); }));
      const provider = resolveEmbeddingProvider(embeddingRoot(port));
      const err = await caught(() => provider.embed(['hello']));
      expect(err.message).toContain('returned invalid JSON');
      expect(err.cause).toBeInstanceOf(Error);
      expect(err.cause instanceof Error ? err.cause.name : '').toBe('SyntaxError');
    });

    it('keeps the key out of the cause when the transport refuses the header', async () => {
      process.env['OPENAI_API_KEY'] = 'sk-test' + String.fromCharCode(10) + 'SECRETPART';
      const provider = resolveEmbeddingProvider(embeddingRoot(await closedPort()));
      const err = await caught(() => provider.embed(['hello']));
      expect(err.cause).toBeInstanceOf(Error);
      expect(inspect(err, { depth: 5 })).not.toContain('SECRETPART');
    });
  });
});
