// The stdio loop in process: stdin's listeners are captured and fed frames, stdout is read, and exit is stubbed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, MockInstance } from 'vitest';
import { startStdioLoop } from '../../src/surface/mcp/stdio.js';
import { cliStdioHost, type CliStore } from '../../src/surface/cli/api-context.js';
import type { McpHost } from '../../src/surface/mcp/protocol.js';
import { log } from '../../src/base/util/log.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { captureWrites, fire, recordListeners, stubExit, type Listener } from '../_helpers/process-stubs.js';
import { makeRoot } from '../_helpers/make-root.js';
import { startHashedEmbeddings } from '../_helpers/hashed-embedding-server.js';
import { loadEmbeddingIndex } from '../_helpers/root-forms.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

interface Reply {
  readonly id: number | string | null;
  readonly result?: {
    readonly tools?: ReadonlyArray<{ readonly name: string }>;
    readonly content?: ReadonlyArray<{ readonly text: string }>;
  };
  readonly error?: { readonly code: number; readonly message: string };
}

let dir: string;
let stdin: Map<string, Listener[]>;
let written: string[];
let exit: MockInstance;

beforeEach(() => {
  dir = makeRoot('mcp-stdio', { init: false });
  mkdirSync(join(dir, 'project'));
  vi.stubEnv('HIPPO_HOME', join(dir, 'global'));
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
});

function feed(...frames: string[]): void {
  fire(stdin, 'data', Buffer.from(frames.map((f) => f + '\n').join(''), 'utf8'));
}

function replies(): Reply[] {
  return written.map((line): Reply => JSON.parse(line));
}

function toolCall(id: number, name: string, args: Record<string, string | boolean>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

/** The id in brackets in the text of the reply to call `id`. */
async function bracketedId(id: number): Promise<string> {
  await vi.waitFor(() => expect(replies().map((r) => r.id)).toContain(id), { timeout: 15_000 });
  const text = replies().find((r) => r.id === id)?.result?.content?.[0]?.text ?? '';
  const found = /\[([^\]]+)\]/.exec(text)?.[1];
  if (found === undefined) throw new Error(`no id in the reply to ${id}: ${text}`);
  return found;
}

describe('startStdioLoop, in process', () => {
  it('answers bad frames, lists tools, saves a remembered row in a new global store, and exits 0 once stdin ends', async () => {
    startStdioLoop(cliStdioHost());
    feed(
      'not json',
      JSON.stringify({ jsonrpc: '2.0', id: 1 }),
      JSON.stringify({ jsonrpc: '2.0' }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
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
      expect((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT content FROM memories').get() as { content: string }).content).toBe(
        'the staging queue drains at midnight',
      );
    } finally {
      closeHippoDb(db);
    }

    fire(stdin, 'end');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('assembles a frame that arrives over many chunks, newline-delimited or Content-Length', async () => {
    startStdioLoop(cliStdioHost());
    const list = (id: number): string => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' });
    const dribble = (text: string, size: number): void => {
      const bytes = Buffer.from(text);
      for (let i = 0; i < bytes.length; i += size) fire(stdin, 'data', bytes.subarray(i, i + size));
    };
    const ids = (): Array<Reply['id']> => replies().map((r) => r.id);

    dribble(`${list(1)}\n`, 3);
    await vi.waitFor(() => expect(ids()).toEqual([1]), { timeout: 15_000 });

    const body = list(2);
    dribble(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, 4);
    await vi.waitFor(() => expect(ids()).toContain(2), { timeout: 15_000 });

    // Two frames split mid-way across one chunk boundary each still come out in order.
    dribble(`${list(3)}\n${list(4)}\n`, 17);
    await vi.waitFor(() => expect(ids()).toContain(4), { timeout: 15_000 });
    expect(ids().filter((id) => id === 3 || id === 4)).toEqual([3, 4]);
  });

  it("lands the embed of the last call's global copy before it exits once stdin ends", async () => {
    const embeddings = await startHashedEmbeddings();
    try {
      mkdirSync(join(dir, 'project', '.hippo'));
      mkdirSync(join(dir, 'global'));
      const config = { embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url } };
      writeFileSync(join(dir, 'global', 'config.json'), JSON.stringify(config));
      vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
      startStdioLoop(cliStdioHost());
      feed(toolCall(1, 'hippo_remember', { text: 'the staging queue drains at midnight' }));
      const local = await bracketedId(1);
      // The share answers before its embed does, so the vector is there at exit only if the drain waits for it.
      embeddings.setFault(500);
      feed(toolCall(2, 'hippo_share', { id: local, force: true }));
      const shared = await bracketedId(2);
      fire(stdin, 'end');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 15_000 });
      expect(Object.keys(loadEmbeddingIndex(join(dir, 'global')))).toEqual([shared]);
    } finally {
      await embeddings.close();
    }
  });

  it('names how many handed-off tasks were still running when the drain bound ended', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const real = cliStdioHost();
    const host: McpHost<CliStore> = { runFrame: (signal, run) => real.runFrame(signal, run), settle: async () => 2 };
    startStdioLoop(host);
    fire(stdin, 'end');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(warn).toHaveBeenCalledWith(
      'mcp: 2 handed-off task(s), such as an embed, still running 5000 ms after stdin closed',
      { left: 2 },
    );
  });
});
