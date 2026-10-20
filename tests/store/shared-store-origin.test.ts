// A store flagged `"sharedStore": true` stamps NULL on a write that names no project, never the folder that holds it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stampOriginProjectForImport } from '../../src/store/sqlite/entry-row.js';
import { getGlobalRoot } from '../../src/domain/sharing/global-store.js';
import { shareMemory } from '../../src/domain/sharing/share.js';
import { syncGlobalToLocal } from '../../src/domain/sharing/global-sync.js';
import { BadRequestError } from '../../src/base/errors/api-errors.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { originFromSource } from '../../src/base/scope/project-identity.js';
import { projectNameRepairOnce } from '../../src/api/objects/projects.js';
import { cliApiContext } from '../../src/surface/cli/api-context.js';
import { saveCompaction } from '../../src/surface/capture/compaction-record.js';
import { COMPACTION_MEMORY_TAG } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { summaryWith } from '../_helpers/compaction-hooks.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { compactionFolder } from '../_helpers/cli-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { copyToGlobal, writeEntry, readEntry, loadAllEntries, batchWriteAndDelete } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

let tmp: string;

beforeEach(() => {
  tmp = makeRoot('shared-origin', { init: false });
  vi.stubEnv('HIPPO_HOME', path.join(tmp, 'global'));
});

interface Layout {
  readonly store: string;
  readonly folderStamp: string;
}

/** a: a server folder with no project marker (stamps ''); b: a store inside a git checkout (stamps 'team'). */
function layouts(flagged: boolean): readonly Layout[] {
  const a = path.join(tmp, 'a', 'srv', 'hippo-team');
  const teamDir = path.join(tmp, 'b', 'team');
  fs.mkdirSync(path.join(teamDir, '.git'), { recursive: true });
  const b = path.join(teamDir, '.hippo');
  for (const store of [a, b]) {
    fs.mkdirSync(store, { recursive: true });
    initTestStore(store);
    if (flagged) fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ sharedStore: true }));
  }
  return [
    { store: a, folderStamp: '' },
    { store: b, folderStamp: 'team' },
  ];
}

function originOf(store: string, id: string): string | null | undefined {
  return readEntry(store, id)?.originProject;
}

describe('shared store origin stamp', () => {
  it('writeEntry of a fresh memory stamps NULL on a flagged store', () => {
    for (const { store } of layouts(true)) {
      const entry = createMemory('the deploy window closes at five on fridays');
      writeEntry(store, entry);
      expect(originOf(store, entry.id)).toBeNull();
    }
  });

  it('an unflagged store keeps the folder stamp', () => {
    for (const { store, folderStamp } of layouts(false)) {
      const entry = createMemory('the deploy window closes at five on fridays');
      writeEntry(store, entry);
      expect(originOf(store, entry.id)).toBe(folderStamp);
    }
  });

  it('a flagged store keeps an explicit origin', () => {
    for (const { store } of layouts(true)) {
      const entry = { ...createMemory('the billing queue drains before a migration'), originProject: 'acme/app' };
      writeEntry(store, entry);
      expect(originOf(store, entry.id)).toBe('acme/app');
    }
  });

  it('the batch write path stamps NULL on a flagged store', () => {
    for (const { store } of layouts(true)) {
      batchWriteAndDelete(store, [createMemory('a consolidated summary of the release notes')], []);
      const [entry] = loadAllEntries(store, 'default');
      expect(entry?.originProject).toBeNull();
    }
  });

  it('the import stamp gives NULL with no source evidence and keeps the source evidence', () => {
    for (const { store } of layouts(true)) {
      expect(stampOriginProjectForImport(store, createMemory('an imported row')).originProject).toBeNull();
      const shared = createMemory('an imported shared row', { source: 'shared:proj:2026-01-01T00:00:00Z' });
      expect(stampOriginProjectForImport(store, shared).originProject).toBe('proj');
    }
  });

  it('a NULL row from a flagged store stays NULL in the global copy, labelled shared::', async () => {
    for (const { store } of layouts(true)) {
      const entry = { ...createMemory('the handbook lives in the wiki under ops'), originProject: null };
      writeEntry(store, entry);
      const promoted = await copyToGlobal(store, entry.id);
      expect(originOf(getGlobalRoot(), promoted.id)).toBeNull();
      expect(promoted.source.startsWith('shared::')).toBe(true);
      expect(originFromSource(promoted.source)).toBeNull();
      const shared = await shareMemory(...sharingStores(store), entry.id, {
        tenantId: 'default',
        force: true,
        skipEmbed: true,
      });
      expect(shared?.source.startsWith('shared::')).toBe(true);
      expect(originFromSource(shared?.source)).toBeNull();
      expect(originOf(getGlobalRoot(), shared?.id ?? '')).toBeNull();
    }
  });

  it('a NULL row from an unflagged store gets the folder stamp and the folder label in the global copy', async () => {
    for (const { store, folderStamp } of layouts(false)) {
      const entry = { ...createMemory('the handbook lives in the wiki under ops'), originProject: null };
      writeEntry(store, entry);
      const promoted = await copyToGlobal(store, entry.id);
      expect(originOf(getGlobalRoot(), promoted.id)).toBe(folderStamp);
      expect(promoted.source).toBe(`promoted:${store}`);
      const shared = await shareMemory(...sharingStores(store), entry.id, {
        tenantId: 'default',
        force: true,
        skipEmbed: true,
      });
      const label = folderStamp === '' ? path.basename(path.dirname(store)) : folderStamp;
      expect(shared?.source.startsWith(`shared:${label}:`)).toBe(true);
      expect(shared?.originProject).toBe(folderStamp);
    }
  });

  it('hippo sync refuses a flagged store and copies nothing', async () => {
    initTestStore(getGlobalRoot());
    writeEntry(getGlobalRoot(), { ...createMemory('my personal shell aliases live in dotfiles'), originProject: '' });
    for (const { store } of layouts(true)) {
      await expect(syncGlobalToLocal(...sharingStores(store, getGlobalRoot()))).rejects.toThrow(BadRequestError);
      expect(loadAllEntries(store, 'default')).toHaveLength(0);
    }
  });

  it('hippo sync into an unflagged store copies as before', async () => {
    initTestStore(getGlobalRoot());
    writeEntry(getGlobalRoot(), { ...createMemory('my personal shell aliases live in dotfiles'), originProject: '' });
    for (const { store } of layouts(false)) {
      expect(await syncGlobalToLocal(...sharingStores(store, getGlobalRoot()))).toBe(1);
      expect(loadAllEntries(store, 'default')).toHaveLength(1);
    }
  });

  it('a flagged NULL row comes back NULL when the emptied store opens and reads its markdown mirror', () => {
    for (const { store } of layouts(true)) {
      const entry = { ...createMemory('the on-call rota changes on mondays'), originProject: null };
      writeEntry(store, entry);
      const db = openHippoDb(store);
      try {
        db.prepare('DELETE FROM memories WHERE id = ?').run(entry.id);
      } finally {
        closeHippoDb(db);
      }
      initTestStore(store);
      expect(originOf(store, entry.id)).toBeNull();
    }
  });
});

interface TaggedStore {
  readonly store: string;
  readonly id: string;
}

/** `<tmp>/c/hippo-team/.hippo`, whose folder's id `server-id` is unlike its legacy name `hippo-team`, holding one row a member tagged `hippo-team`. */
function storeWithFoldableTag(flagged: boolean): TaggedStore {
  const folder = path.join(tmp, 'c', 'hippo-team');
  const store = path.join(folder, '.hippo');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(folder, '.hippo-project.json'), JSON.stringify({ id: 'server-id' }));
  initTestStore(store);
  if (flagged) fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ sharedStore: true }));
  const entry = { ...createMemory('the member checkout is also called hippo-team'), originProject: 'hippo-team' };
  writeEntry(store, entry);
  return { store, id: entry.id };
}

function repairOnce(store: string): void {
  projectNameRepairOnce(cliApiContext(store, 'default'));
}

describe('the one-time sleep repair', () => {
  it("leaves a flagged store's rows under the tag the caller gave them", () => {
    const { store, id } = storeWithFoldableTag(true);
    repairOnce(store);
    expect(originOf(store, id)).toBe('hippo-team');
  });

  it("folds the legacy name into the folder's id on a store that is not shared", () => {
    const { store, id } = storeWithFoldableTag(false);
    repairOnce(store);
    expect(originOf(store, id)).toBe('server-id');
  });
});

const ITEM = 'The billing service drains its queue before every deploy.';

function compact(store: string, cwd: string | null): void {
  const payload = {
    sessionId: `s-${cwd === null ? 'none' : 'cwd'}`,
    trigger: 'auto',
    cwd,
    transcriptPath: null,
    compactSummary: summaryWith([ITEM]),
  };
  expect(saveCompaction(compactionFolder(store), payload, () => undefined).written).toBe(1);
}

const itemOrigins = (store: string): ReadonlyArray<string | null | undefined> =>
  loadAllEntries(store, 'default')
    .filter((e) => e.tags.includes(COMPACTION_MEMORY_TAG))
    .map((e) => e.originProject);

describe('compaction items', () => {
  it("take the session folder's project on a flagged store", () => {
    const member = path.join(tmp, 'member', 'app');
    fs.mkdirSync(path.join(member, '.git'), { recursive: true });
    for (const { store } of layouts(true)) {
      compact(store, member);
      expect(itemOrigins(store)).toEqual(['app']);
    }
  });

  it('are stamped NULL on a flagged store when the session folder is unknown', () => {
    for (const { store } of layouts(true)) {
      compact(store, null);
      expect(itemOrigins(store)).toEqual([null]);
    }
  });

  it('keep the folder stamp on a store that is not shared', () => {
    const member = path.join(tmp, 'member', 'app');
    fs.mkdirSync(path.join(member, '.git'), { recursive: true });
    for (const { store, folderStamp } of layouts(false)) {
      compact(store, member);
      expect(itemOrigins(store)).toEqual([folderStamp]);
    }
  });
});
