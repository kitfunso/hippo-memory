// The snapshot cache: when a read reuses it, when an outside commit, a dashboard write, the TTL or ?fresh=1 rebuilds it, and what it never writes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Layer } from '../src/memory.js';
import { closeHippoDb, getMeta, openHippoDb } from '../src/db.js';
import { EMBEDDING_MODEL_META_KEY } from '../src/embeddings.js';
import { quarantineScopeFor } from '../src/quarantine.js';
import { COALESCE_MS, TTL_MS, createSnapshotService, type SnapshotService } from '../src/dashboard-snapshot.js';
import { buildOverview } from '../src/dashboard-queries.js';
import {
  NOW, get, makeStore, parse, postJson, seed, startDashboard, type RunningDashboard, type TmpStore,
} from './_helpers/dashboard-fixture.js';
import type { MemoryDetail, Overview } from '../src/dashboard-types.js';

let store: TmpStore;
let clock: number;
let service: SnapshotService;

beforeEach(() => {
  store = makeStore('hippo-dash-cache');
  clock = NOW;
  service = createSnapshotService(store.hippoRoot, () => clock);
});

afterEach(() => {
  service.close();
  store.cleanup();
});

describe('snapshot reuse and rebuild', () => {
  it('reuses the snapshot when nothing was written', () => {
    seed(store.hippoRoot, 'first');
    const first = service.get('default');
    clock += 1_000;

    expect(service.get('default').id).toBe(first.id);
  });

  it('shows an outside write after the coalescing window, and at once with fresh', () => {
    seed(store.hippoRoot, 'first');
    const first = service.get('default');
    seed(store.hippoRoot, 'second');

    clock += COALESCE_MS - 1;
    expect(service.get('default').id).toBe(first.id);

    clock += 2;
    const later = service.get('default');
    expect(later.id).toBeGreaterThan(first.id);
    expect(later.facts).toHaveLength(2);

    seed(store.hippoRoot, 'third');
    const forced = service.get('default', true);
    expect(forced.id).toBeGreaterThan(later.id);
    expect(forced.facts).toHaveLength(3);
  });

  it('rebuilds after the TTL even with no write', () => {
    seed(store.hippoRoot, 'first');
    const first = service.get('default');

    clock += TTL_MS + 1;

    expect(service.get('default').id).toBeGreaterThan(first.id);
  });

  it('rebuilds on the next read after invalidate', () => {
    seed(store.hippoRoot, 'first');
    const first = service.get('default');

    service.invalidate();

    expect(service.get('default').id).toBeGreaterThan(first.id);
  });

  it('serves an empty snapshot while hippo.db is missing, then picks the database up', () => {
    const emptyRoot = join(store.home, 'fresh', '.hippo');
    mkdirSync(emptyRoot, { recursive: true });
    const early = createSnapshotService(emptyRoot, () => clock);
    try {
      expect(early.get('default').facts).toHaveLength(0);
      seed(emptyRoot, 'now there is a row');
      clock += COALESCE_MS + 1;
      expect(early.get('default').facts).toHaveLength(1);
    } finally {
      early.close();
    }
  });
});

describe('live population', () => {
  it('drops superseded, archived and quarantined rows and reports them in excluded', () => {
    seed(store.hippoRoot, 'live one');
    seed(store.hippoRoot, 'live two', { layer: Layer.Trace });
    const successor = seed(store.hippoRoot, 'the replacement');
    seed(store.hippoRoot, 'replaced', { kind: 'superseded', superseded_by: successor.id });
    seed(store.hippoRoot, 'archived row', { kind: 'archived' });
    seed(store.hippoRoot, 'quarantined row', { scope: quarantineScopeFor(null) });
    // Quarantine wins over superseded, so this row is counted once, as quarantined.
    seed(store.hippoRoot, 'both', { kind: 'superseded', superseded_by: successor.id, scope: quarantineScopeFor('x') });

    const overview = buildOverview(service.get('default'));

    expect(overview.total).toBe(3);
    expect(overview.excluded).toEqual({ superseded: 1, archived: 1, quarantined: 2 });
  });
});

describe('embeddings.json handling', () => {
  const dbMeta = (): string => {
    const db = openHippoDb(store.hippoRoot);
    try {
      return getMeta(db, EMBEDDING_MODEL_META_KEY, '(unset)');
    } finally {
      closeHippoDb(db);
    }
  };

  it('answers null coverage for a corrupt file and leaves the file and the DB meta alone', () => {
    seed(store.hippoRoot, 'a row');
    const file = join(store.hippoRoot, 'embeddings.json');
    writeFileSync(file, '{not json');
    const metaBefore = dbMeta();

    const snap = service.get('default');

    expect(snap.embeddingCoverage).toBeNull();
    expect(readdirSync(store.hippoRoot).filter((name) => name.includes('.corrupt-'))).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(dbMeta()).toBe(metaBefore);
  });

  it('answers null coverage for an unreadable file (a directory) and does not fail the snapshot', () => {
    seed(store.hippoRoot, 'a row');
    mkdirSync(join(store.hippoRoot, 'embeddings.json'));

    const snap = service.get('default');

    expect(snap.facts).toHaveLength(1);
    expect(snap.embeddingCoverage).toBeNull();
  });

  it('refreshes coverage when only embeddings.json changes', () => {
    const row = seed(store.hippoRoot, 'a row');
    expect(service.get('default').embeddingCoverage).toBe(0);

    writeFileSync(join(store.hippoRoot, 'embeddings.json'), JSON.stringify({ [row.id]: [0.1, 0.2] }));
    clock += 1_000;

    expect(service.get('default').embeddingCoverage).toBe(1);
  });
});

describe('through the server', () => {
  let dash: RunningDashboard;

  beforeEach(async () => {
    seed(store.hippoRoot, 'before the click');
    dash = await startDashboard(store.hippoRoot, () => clock);
  });

  afterEach(async () => {
    await dash.close();
  });

  it('shows a dashboard write on the very next read, inside the coalescing window', async () => {
    const before = parse<Overview>(await get(dash.port, '/api/overview'));
    const target = seed(store.hippoRoot, 'pin me');
    const cached = parse<Overview>(await get(dash.port, '/api/overview'));
    expect(cached.snapshotId).toBe(before.snapshotId);

    const pinned = await postJson(dash.port, `/api/memory/${target.id}/pin`, { pinned: true });
    expect(pinned.status).toBe(200);
    expect(parse<MemoryDetail>(pinned).band).toBe('pinned');

    const after = parse<Overview>(await get(dash.port, '/api/overview'));
    expect(after.snapshotId).toBeGreaterThan(before.snapshotId);
    expect(after.total).toBe(2);
    expect(after.projects[0].pinned).toBe(1);
  });

  it('rebuilds on ?fresh=1 only when asked', async () => {
    const first = parse<Overview>(await get(dash.port, '/api/overview'));
    seed(store.hippoRoot, 'written elsewhere');

    const plain = parse<Overview>(await get(dash.port, '/api/overview'));
    const forced = parse<Overview>(await get(dash.port, '/api/overview?fresh=1'));

    expect(plain.snapshotId).toBe(first.snapshotId);
    expect(forced.snapshotId).toBeGreaterThan(first.snapshotId);
    expect(forced.total).toBe(2);
  });
});
