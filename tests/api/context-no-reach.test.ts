// A Context with no reach (an integrator's own store) reads one project and no global store, as the old "other" branch did.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { contextGet } from '../../src/api/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const PROJECT = 'proj-a';
let tmpRoot: string;
let local: string;
let globalRoot: string;
let localPin: string;
let globalPin: string;

function seedPin(root: string, content: string): string {
  const entry = {
    ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    originProject: PROJECT,
    pinned: true,
  };
  writeEntry(root, entry);
  return entry.id;
}

const idsOf = (r: { entries: Array<{ entry: { id: string } }> }): string[] => r.entries.map((e) => e.entry.id);

beforeEach(() => {
  tmpRoot = makeRoot('no-reach', { init: false });
  local = path.join(tmpRoot, 'local', '.hippo');
  globalRoot = path.join(tmpRoot, 'global');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(globalRoot, { recursive: true });
  initTestStore(local);
  initTestStore(globalRoot);
  vi.stubEnv('HIPPO_HOME', globalRoot);
  localPin = seedPin(local, 'a local pin that the prompt must carry every turn');
  globalPin = seedPin(globalRoot, 'a global pin that only a reach to the global store brings');
});

afterEach(() => {
  vi.stubEnv('HIPPO_HOME', undefined);
});

const OPTS = { pinnedOnly: true, includeRecent: 5, currentProject: PROJECT } as const;

describe('contextGet without a reach', () => {
  it('reads the global store only when the root gave a reach', async () => {
    const withReach = apiCtx(local);
    expect(idsOf(await contextGet(withReach, OPTS))).toEqual(expect.arrayContaining([localPin, globalPin]));
    const { reach: _reach, ...bare } = withReach;
    expect(idsOf(await contextGet(bare, OPTS))).toEqual([localPin]);
  });

  it('reads a store of another kind as one project with no global store', async () => {
    const { reach: _reach, ...bare } = apiCtx(local);
    const other = { ...sqliteStore(local), localFiles: undefined };
    expect(idsOf(await contextGet({ ...bare, store: other }, OPTS))).toEqual([localPin]);
  });

  it('still reads the shared flag from config, so a shared store needs the caller project', async () => {
    fs.writeFileSync(path.join(local, 'config.json'), JSON.stringify({ sharedStore: true }));
    const { reach: _reach, ...bare } = apiCtx(local);
    await expect(contextGet(bare, { pinnedOnly: true, currentProject: '' })).rejects.toThrow(
      /shared store needs the caller's project/,
    );
  });
});
