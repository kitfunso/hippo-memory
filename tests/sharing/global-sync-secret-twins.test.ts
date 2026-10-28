// A sync down finds a twin by its stored form, so a raw older row on either side is never copied again.
import { beforeEach, describe, expect, it } from 'vitest';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { closeHippoDb, openHippoDb, setFtsInSync } from '../../src/db/index.js';
import { syncGlobalToLocal } from '../../src/domain/sharing/global-sync.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { restoreRawTextAt } from '../_helpers/legacy-rows.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot, makeStore } from '../_helpers/make-root.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';
import { TEST_RUN } from '../_helpers/test-run.js';

const GH = runtimeJoin('ghp_', 'Tw1'.repeat(12));
const BEARER = runtimeJoin('Bearer ', 'Qw3rTy7uIo9pAs5dFg1hJk8l');

let localRoot: string;
let globalRoot: string;
beforeEach(() => {
  localRoot = makeStore('secret-twins').root;
  globalRoot = makeRoot('secret-twins-global');
});

function write(root: string, rows: readonly MemoryEntry[]): void {
  const db = openHippoDb(root);
  try {
    for (const entry of rows) writeEntryDbOnly(db, entry);
    setFtsInSync(db, true);
  } finally {
    closeHippoDb(db);
  }
}

const row = (content: string): MemoryEntry => ({
  ...createMemory(content, { layer: Layer.Semantic }),
  originProject: '',
});

const localTexts = (): string[] => loadAllEntries(localRoot, 'default').map((e) => e.content);

describe('sync down over secret twins', () => {
  it('copies no global row whose stored form a raw older local row holds', async () => {
    const raw = `the release job reads ${GH} from the vault before it tags`;
    const local = row(raw);
    write(localRoot, [local]);
    restoreRawTextAt(localRoot, [local]);
    write(globalRoot, [row(raw)]);

    expect(await syncGlobalToLocal(...sharingStores(localRoot, globalRoot), { embed: TEST_RUN })).toBe(0);
    expect(localTexts()).toEqual([raw]);
  });

  it('copies no raw older global row whose stored form a local row holds', async () => {
    const raw = `the smoke job sends ${BEARER} to the staging gateway`;
    write(localRoot, [row(raw)]);
    const global = row(raw);
    write(globalRoot, [global]);
    restoreRawTextAt(globalRoot, [global]);

    expect(await syncGlobalToLocal(...sharingStores(localRoot, globalRoot), { embed: TEST_RUN })).toBe(0);
    expect(localTexts()).toHaveLength(1);
  });
});
