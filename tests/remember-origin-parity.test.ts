// The CLI thin client sends no project, so a routed remember stamps what the direct path stamps on the same store.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cmdRemember, handleRemember } from '../src/cli/remember.js';
import { initStore } from '../src/store/open.js';
import { loadAllEntries, readEntry } from '../src/store/entry-reads.js';
import { _resetSharedStoreCacheForTests } from '../src/config.js';
import type { JsonValue } from '../src/json.js';
import { clearProjectIdentityCache } from '../src/project-identity.js';
import { serve, type ServerHandle } from '../src/server.js';

let tmp: string;
let handle: ServerHandle | null = null;
const origHome = process.env.HIPPO_HOME;

/** `<tmp>/proj/.hippo` inside a git checkout, so the folder stamp is `proj`; no embedder, so a write starts no model load. */
function projectStore(config: Record<string, JsonValue>): string {
  fs.mkdirSync(path.join(tmp, 'proj', '.git'), { recursive: true });
  const store = path.join(tmp, 'proj', '.hippo');
  fs.mkdirSync(store, { recursive: true });
  initStore(store);
  fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ ...config, embeddings: { enabled: false } }));
  return store;
}

/** The real direct path, `hippo remember` with no server up; `force` skips the salience gate, which is not under test. */
async function directRemember(store: string, text: string): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await cmdRemember(store, text, { force: true });
  } finally {
    log.mockRestore();
  }
  const row = loadAllEntries(store).find((e) => e.content === text);
  expect(row).toBeDefined();
  return row?.id ?? '';
}

/** `hippo remember` with a server up: the CLI itself decides to route and builds the body, so the test fails if it stops routing. */
async function thinRemember(store: string, text: string): Promise<string> {
  handle = await serve({ hippoRoot: store, port: 0 });
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let printed = '';
  try {
    await handleRemember({ hippoRoot: store, args: [text], flags: {} });
  } finally {
    printed = log.mock.calls.map((c) => String(c[0])).join(' ');
    log.mockRestore();
  }
  expect(printed).toMatch(/Remembered \[.*\] \(via http/);
  const row = loadAllEntries(store).find((e) => e.content === text);
  expect(row).toBeDefined();
  return row?.id ?? '';
}

async function bothOrigins(store: string): Promise<ReadonlyArray<string | null | undefined>> {
  const direct = await directRemember(store, 'the build cache lives under the shared drive');
  const thin = await thinRemember(store, 'the release branch is cut on thursdays');
  return [readEntry(store, direct)?.origin_project, readEntry(store, thin)?.origin_project];
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-origin-parity-'));
  process.env.HIPPO_HOME = path.join(tmp, 'global');
  clearProjectIdentityCache();
  _resetSharedStoreCacheForTests();
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (origHome === undefined) delete process.env.HIPPO_HOME;
  else process.env.HIPPO_HOME = origHome;
  _resetSharedStoreCacheForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('remember origin: direct path and thin client agree', () => {
  it('both stamp the folder project on a store that is not shared', async () => {
    expect(await bothOrigins(projectStore({}))).toEqual(['proj', 'proj']);
  });

  it('both stamp NULL on a shared store', async () => {
    expect(await bothOrigins(projectStore({ sharedStore: true }))).toEqual([null, null]);
  });
});
