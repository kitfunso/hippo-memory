// autoShare over a store larger than one page: the same picks, skips and writes as one whole read gave; and a hand-run share
// of a text the global store already holds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { Layer, type CreateMemoryOptions, type MemoryEntry } from '../../src/base/memory/entry.js';
import { autoShare, shareMemory, type ShareOutcome } from '../../src/domain/sharing/share.js';
import { BadRequestError } from '../../src/base/errors/api-errors.js';
import { quarantineScopeFor } from '../../src/domain/trust/quarantine.js';
import { getGlobalRoot } from '../../src/host/global-store.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entries/entry-writes.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { duplicateKey, mergedText } from '../../src/base/util/same-text.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, loadAllEntries, loadEveryTenantEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { TEST_DETACHED, TEST_RUN } from '../_helpers/test-run.js';

type AutoShareStats = NonNullable<NonNullable<Parameters<typeof autoShare>[2]>['stats']>;

const ROWS = 1100;
const text = (label: string): string => `${label}: the step needs its flag or the command silently does nothing`;

let root: string;

beforeEach(() => {
  const tmp = makeRoot('autoshare-pages', { init: false });
  vi.stubEnv('HIPPO_HOME', join(tmp, 'global'));
  initTestStore(getGlobalRoot());
  root = join(tmp, 'proj', '.hippo');
  initTestStore(root);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Rows that differ from a plain filler row, by their place in store order. */
const SPECIAL: ReadonlyMap<number, Partial<MemoryEntry>> = new Map<number, Partial<MemoryEntry>>([
  [3, { content: text('first error'), tags: ['error'] }],
  [499, { content: text('already global'), tags: ['error'] }],
  [500, { content: text('page edge error'), tags: ['error'] }],
  [501, { content: text('inside a global merge'), tags: ['error'] }],
  [750, { content: text('git seed'), tags: ['git-learned', 'error'] }],
  [900, { content: 'aws creds AKIAIOSFODNN7EXAMPLE for the deploy user', tags: ['error'] }],
  [1050, { content: text('pinned lesson'), pinned: true }],
]);

/** One write transaction and no mirrors: the walk reads rows only. */
function seedLocal(): string[] {
  const ids: string[] = [];
  const db = openHippoDb(root);
  db.exec('BEGIN');
  try {
    for (let i = 0; i < ROWS; i++) {
      const extra = SPECIAL.get(i) ?? {};
      const base = createMemory(extra.content ?? text(`filler ${i}`), {
        tags: extra.tags ?? [],
        emotionalValence: 'neutral',
      });
      const created = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      writeEntryDbOnly(db, { ...base, ...extra, created });
      ids.push(base.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    closeHippoDb(db);
  }
  return ids;
}

function seedGlobal(): void {
  const spaced = createMemory(`  ${text('already global').replace(/ /g, '   ')}  `, { tenantId: 'other' });
  writeEntry(getGlobalRoot(), spaced);
  const merged = createMemory(
    mergedText('[Consolidated from 2 related memories, newest first]', [
      text('inside a global merge'),
      'a different lesson',
    ]),
    { source: 'consolidation', layer: Layer.Semantic },
  );
  writeEntry(getGlobalRoot(), merged);
}

const at = (ids: readonly string[], ...places: number[]): string[] => places.map((i) => ids[i]);

describe('autoShare across pages', () => {
  it('picks the signal rows in store order and skips global copies, git seeds and secrets', async () => {
    const ids = seedLocal();
    seedGlobal();
    const stats: AutoShareStats = { secretSkipped: 0 };

    const picked = await autoShare(...sharingStores(root), {
      embed: TEST_RUN,
      detached: TEST_DETACHED,
      dryRun: true,
      tenantId: 'default',
      stats,
    });

    expect(picked.map((e) => e.id)).toEqual(at(ids, 3, 500, 1050));
    expect(stats).toEqual({ secretSkipped: 1, neverAutoShareSkipped: 1 });
  });

  it('below the neutral score picks every other row of the tenant in store order', async () => {
    const ids = seedLocal();
    seedGlobal();
    const skipped = new Set(at(ids, 499, 501, 750, 900));

    const picked = await autoShare(...sharingStores(root), {
      embed: TEST_RUN,
      detached: TEST_DETACHED,
      minScore: 0.3,
      dryRun: true,
      tenantId: 'default',
    });

    expect(picked.map((e) => e.id)).toEqual(ids.filter((id) => !skipped.has(id)));
  });

  it('writes the picks to the global store, and a second run finds them there', async () => {
    const ids = seedLocal();
    seedGlobal();
    const stores = sharingStores(root);

    const shared = await autoShare(...stores, { embed: TEST_RUN, detached: TEST_DETACHED, tenantId: 'default' });

    const local = new Map(loadAllEntries(root, 'default').map((e) => [e.id, e.content]));
    expect(shared.map((e) => e.content)).toEqual(at(ids, 3, 500, 1050).map((id) => local.get(id)));
    const global = loadAllEntries(getGlobalRoot(), 'default').map((e) => e.content);
    expect(global).toEqual(expect.arrayContaining(shared.map((e) => e.content)));
    expect(await autoShare(...stores, { embed: TEST_RUN, detached: TEST_DETACHED, tenantId: 'default' })).toEqual([]);
  });
});

describe('shareMemory of a text the global store already holds', () => {
  const HELD = text('already shared by hand');
  const LOW_SCORE_TAGS = ['file-path', 'config'];

  const share = (id: string, { force = false, tenantId = 'default' } = {}): Promise<ShareOutcome> =>
    shareMemory(...sharingStores(root), id, {
      embed: TEST_RUN,
      detached: TEST_DETACHED,
      skipEmbed: true,
      force,
      tenantId,
    });

  function localRow(content: string, extra: Partial<CreateMemoryOptions> = {}): string {
    const entry = createMemory(content, { tenantId: 'default', ...extra });
    writeEntry(root, entry);
    return entry.id;
  }

  /** Every global row of any tenant or scope that holds this text. */
  const globalCopies = (content: string): MemoryEntry[] =>
    loadEveryTenantEntries(getGlobalRoot()).filter((e) => duplicateKey(e.content) === duplicateKey(content));

  it('a second share of the same row writes nothing, even forced, and names the first copy', async () => {
    const id = localRow(HELD);

    const first = await share(id);
    const second = await share(id, { force: true });

    const copies = globalCopies(HELD);
    expect(copies).toHaveLength(1);
    expect(first).toEqual({ kind: 'shared', entry: expect.objectContaining({ id: copies[0]!.id, content: HELD }) });
    expect(second).toEqual({ kind: 'already-shared', existingId: copies[0]!.id });
  });

  it('text equal apart from spacing counts as the same', async () => {
    const first = localRow(HELD);
    const spaced = localRow(`  ${HELD.replace(/ /g, ' \n  ')}\n`);

    await share(first);
    const second = await share(spaced);

    expect(globalCopies(HELD)).toHaveLength(1);
    expect(second).toEqual({ kind: 'already-shared', existingId: globalCopies(HELD)[0]!.id });
  });

  it('a low-score row reports already-shared when its text is held and low-score when it is not', async () => {
    const heldCopy = createMemory(HELD, { tenantId: 'default' });
    writeEntry(getGlobalRoot(), heldCopy);
    const heldRow = localRow(HELD, { tags: LOW_SCORE_TAGS });
    const freshRow = localRow(text('project only'), { tags: LOW_SCORE_TAGS });

    expect(await share(heldRow)).toEqual({ kind: 'already-shared', existingId: heldCopy.id });
    expect(await share(freshRow)).toEqual({ kind: 'low-score' });
    expect(loadEveryTenantEntries(getGlobalRoot()).map((e) => e.id)).toEqual([heldCopy.id]);
  });

  it("another tenant's global copy does not block a share", async () => {
    writeEntry(getGlobalRoot(), createMemory(HELD, { tenantId: 'other' }));
    const id = localRow(HELD);

    expect(await share(id)).toEqual({ kind: 'shared', entry: expect.objectContaining({ content: HELD }) });
    expect(
      globalCopies(HELD)
        .map((e) => e.tenantId)
        .sort(),
    ).toEqual(['default', 'other']);
  });

  it("the caller's own global copy is the existing id", async () => {
    const own = createMemory(HELD, { tenantId: 'default' });
    writeEntry(getGlobalRoot(), own);

    expect(await share(localRow(HELD))).toEqual({ kind: 'already-shared', existingId: own.id });
    expect(globalCopies(HELD)).toHaveLength(1);
  });

  const SECRET = 'aws creds AKIAIOSFODNN7EXAMPLE for the deploy user';
  const VETOED: ReadonlyArray<[string, string, Partial<CreateMemoryOptions>]> = [
    ['a secret row', SECRET, {}],
    ['a quarantined row', HELD, { scope: quarantineScopeFor(null) }],
    ['a personal row', HELD, { scope: 'personal:private:alice' }],
  ];

  it.each(VETOED)('%s whose text is held still throws its refusal', async (_label, content, extra) => {
    writeEntry(getGlobalRoot(), createMemory(content, { tenantId: 'default' }));
    const id = localRow(content, extra);

    await expect(share(id, { force: true })).rejects.toBeInstanceOf(BadRequestError);
    expect(globalCopies(content)).toHaveLength(1);
  });

  // The default scope filter hides a connector-private copy, so its row is not seen as held.
  it('residual: a second share of a connector-private row writes a second global row', async () => {
    const id = localRow(HELD, { scope: 'slack:private:C123' });

    await share(id);
    const second = await share(id);

    expect(second.kind).toBe('shared');
    expect(globalCopies(HELD)).toHaveLength(2);
  });
});
