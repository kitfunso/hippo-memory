// The stdio loop in process: stdin's listeners are captured and fed frames, stdout is read, and exit is stubbed.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { startStdioLoop } from '../src/mcp/stdio.js';
import { cliStdioHost } from '../src/cli/api-context.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { captureWrites, fire, recordListeners, stubExit, type Listener } from './_helpers/process-stubs.js';

interface Reply {
  readonly id: number | string | null;
  readonly result?: { readonly tools?: ReadonlyArray<{ readonly name: string }> };
  readonly error?: { readonly code: number; readonly message: string };
}

let dir: string;
let priorHome: string | undefined;
let stdin: Map<string, Listener[]>;
let written: string[];
let exit: MockInstance;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hippo-mcp-stdio-'));
  mkdirSync(join(dir, 'project'));
  priorHome = process.env.HIPPO_HOME;
  process.env.HIPPO_HOME = join(dir, 'global');
  // A cwd under the temp dir has no project store above it, so the first tool call creates the global store.
  vi.spyOn(process, 'cwd').mockReturnValue(join(dir, 'project'));
  stdin = recordListeners(process.stdin, 'on');
  recordListeners(process.stdout, 'on');
  recordListeners(process, 'on');
  written = captureWrites(process.stdout);
  captureWrites(process.stderr);
  exit = stubExit();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (priorHome === undefined) delete process.env.HIPPO_HOME;
  else process.env.HIPPO_HOME = priorHome;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function feed(...frames: string[]): void {
  fire(stdin, 'data', Buffer.from(frames.map((f) => f + '\n').join(''), 'utf8'));
}

function replies(): Reply[] {
  return written.map((line): Reply => JSON.parse(line));
}

describe('startStdioLoop, in process', () => {
  it('answers bad frames, lists tools, saves a remembered row in a new global store, and exits 0 once stdin ends', async () => {
    startStdioLoop(cliStdioHost);
    feed(
      'not json',
      JSON.stringify({ jsonrpc: '2.0', id: 1 }),
      JSON.stringify({ jsonrpc: '2.0' }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'hippo_remember', arguments: { text: 'the staging queue drains at midnight' } },
      }),
    );
    await vi.waitFor(() => expect(replies().map((r) => r.id)).toContain(3), { timeout: 15_000 });

    const byId = new Map(replies().map((r) => [r.id, r]));
    expect(byId.get(null)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    expect(byId.get(1)?.error?.code).toBe(-32600);
    expect(byId.get(2)?.result?.tools?.map((t) => t.name)).toContain('hippo_remember');
    expect(byId.get(3)?.error).toBeUndefined();
    expect(replies()).toHaveLength(4);

    const db = openHippoDb(join(dir, 'global'));
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM memories').get<{ n: number }>().n).toBe(1);
      expect(db.prepare('SELECT content FROM memories').get<{ content: string }>().content)
        .toBe('the staging queue drains at midnight');
    } finally {
      closeHippoDb(db);
    }

    fire(stdin, 'end');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
