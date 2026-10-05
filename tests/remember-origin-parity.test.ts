// The CLI thin client sends no project, so a routed remember stamps what the direct path stamps on the same store.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as client from '../src/client.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { readEntry } from '../src/store/entry-reads.js';
import { _resetSharedStoreCacheForTests } from '../src/config.js';
import type { JsonValue } from '../src/json.js';
import { clearProjectIdentityCache } from '../src/project-identity.js';
import { serve, type ServerHandle } from '../src/server.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

let tmp: string;
let handle: ServerHandle | null = null;
const origHome = process.env.HIPPO_HOME;

/** `<tmp>/proj/.hippo` inside a git checkout, so the folder stamp is `proj`. */
function projectStore(config: Record<string, JsonValue>): string {
  fs.mkdirSync(path.join(tmp, 'proj', '.git'), { recursive: true });
  const store = path.join(tmp, 'proj', '.hippo');
  fs.mkdirSync(store, { recursive: true });
  initStore(store);
  fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify(config));
  return store;
}

/** cmdRemember's store write (cli/remember.ts:138-155), without its salience gate, embedder and fact extraction. */
function directRemember(store: string, text: string): string {
  const entry = createMemory(text, { source: 'cli', tags: ['path:proj'] });
  writeEntry(store, entry);
  return entry.id;
}

/** The body the thin path posts (cli/remember.ts:514-521): no `project`. */
async function thinRemember(store: string, text: string): Promise<string> {
  handle = await serve({ hippoRoot: store, port: 0 });
  const { id } = await client.remember(handle.url, undefined, {
    content: text,
    kind: undefined,
    scope: undefined,
    owner: undefined,
    artifactRef: undefined,
    tags: ['path:proj'],
  });
  return id;
}

async function bothOrigins(store: string): Promise<ReadonlyArray<string | null | undefined>> {
  const direct = directRemember(store, 'the build cache lives under the shared drive');
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
