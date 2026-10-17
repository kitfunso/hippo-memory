// autoShare above the neutral score reads only rows that carry a score signal or a never-share mark, and picks the same rows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { MemoryEntry } from '../../src/core/memory.js';
import { autoShare } from '../../src/sharing/share.js';
import { getGlobalRoot } from '../../src/sharing/global-store.js';
import { initStore } from '../../src/store/open.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { loadAllEntries } from '../../src/store/entry-reads.js';
import { MEMORY_SELECT_COLUMNS } from '../../src/store/rows.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { quarantineScopeFor } from '../../src/trust/quarantine.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadEveryTenantEntries } from '../_helpers/root-forms.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

type AutoShareStats = NonNullable<NonNullable<Parameters<typeof autoShare>[2]>['stats']>;

/** loadAllEntries' statements: every full row of the store, or of one tenant. */
const WHOLE_READ = new RegExp(`^SELECT ${MEMORY_SELECT_COLUMNS} FROM memories (WHERE tenant_id = \\? )?ORDER BY created ASC, id ASC$`);

let tmp: string;
let root: string;
let origHippoHome: string | undefined;

beforeEach(() => {
  tmp = makeRoot('autoshare-prefilter', { init: false });
  origHippoHome = process.env.HIPPO_HOME;
  vi.stubEnv('HIPPO_HOME', join(tmp, 'global'));
  initStore(getGlobalRoot());
  root = join(tmp, 'proj', '.hippo');
  initStore(root);
});

afterEach(() => {
  if (origHippoHome !== undefined) vi.stubEnv('HIPPO_HOME', origHippoHome);
  else vi.stubEnv('HIPPO_HOME', undefined);
});

function put(label: string, extra: Partial<MemoryEntry> = {}, tags: string[] = [], tenantId = 'default'): string {
  const entry = { ...createMemory(`${label}: the step needs its flag or the command silently does nothing`, { tags, emotionalValence: 'neutral', tenantId }), ...extra };
  writeEntry(root, entry);
  return entry.id;
}

/** One row per score signal and per skip rule, each labelled with the transfer score it should get. */
function seedSignalRows(): Map<string, string> {
  const ids = new Map<string, string>();
  ids.set('plain 0.5', put('plain'));
  ids.set('negative 0.55', put('negative', { emotional_valence: 'negative' }));
  ids.set('critical 0.55', put('critical', { emotional_valence: 'critical' }, ['ops']));
  ids.set('retrieved twice 0.5', put('retrieved twice', { retrieval_count: 2 }));
  ids.set('retrieved thrice 0.6', put('retrieved thrice', { retrieval_count: 3 }));
  ids.set('pinned 0.6', put('pinned', { pinned: true }));
  ids.set('error 0.6', put('error', {}, ['error']));
  ids.set('error deploy 0.45', put('error deploy', {}, ['error', 'deploy']));
  ids.set('config 0.35', put('config', {}, ['config']));
  ids.set('pinned config 0.45', put('pinned config', { pinned: true }, ['config']));
  ids.set('python shell 0.7', put('python shell', {}, ['python', 'shell']));
  ids.set('escaped error 0.6', put('escaped error'));
  ids.set('git learned', put('git learned', {}, ['git-learned', 'error']));
  ids.set('digest', put('digest', {}, ['session-digest']));
  ids.set('agent', put('agent', { source: 'agent-memory:claude-code:abc' }));
  ids.set('quarantined', put('quarantined', { scope: quarantineScopeFor(null) }, ['error']));
  ids.set('other error 0.6', put('other error', {}, ['error'], 'other'));
  ids.set('other digest', put('other digest', {}, ['session-digest'], 'other'));
  // The JSON escape spells the same tag, so a plain substring of tags_json cannot find it.
  const db = openHippoDb(root);
  try {
    db.prepare('UPDATE memories SET tags_json = ? WHERE id = ?').run('["\\u0065rror"]', ids.get('escaped error 0.6')!);
  } finally {
    closeHippoDb(db);
  }
  return ids;
}

const PICKED: ReadonlyArray<[number, string[]]> = [
  [0.3, ['plain 0.5', 'negative 0.55', 'critical 0.55', 'retrieved twice 0.5', 'retrieved thrice 0.6', 'pinned 0.6', 'error 0.6',
    'error deploy 0.45', 'config 0.35', 'pinned config 0.45', 'python shell 0.7', 'escaped error 0.6']],
  [0.5, ['plain 0.5', 'negative 0.55', 'critical 0.55', 'retrieved twice 0.5', 'retrieved thrice 0.6', 'pinned 0.6', 'error 0.6',
    'python shell 0.7', 'escaped error 0.6']],
  [0.52, ['negative 0.55', 'critical 0.55', 'retrieved thrice 0.6', 'pinned 0.6', 'error 0.6', 'python shell 0.7', 'escaped error 0.6']],
  [0.6, ['retrieved thrice 0.6', 'pinned 0.6', 'error 0.6', 'python shell 0.7', 'escaped error 0.6']],
  [0.65, ['python shell 0.7']],
  [0.75, []],
];

describe('autoShare prefilter', () => {
  it('picks the same rows, in store order, with the same skip count, on both sides of the neutral score', () => {
    const ids = seedSignalRows();
    for (const tenantId of ['default', undefined]) {
      for (const [minScore, labels] of PICKED) {
        const wanted = new Set(labels.map((l) => ids.get(l)!));
        if (tenantId === undefined && minScore <= 0.6) wanted.add(ids.get('other error 0.6')!);
        const stats: AutoShareStats = { secretSkipped: 0 };
        const picked = autoShare(...sharingStores(root), { minScore, dryRun: true, tenantId, stats });
        const inOrder = (tenantId === undefined ? loadEveryTenantEntries(root) : loadAllEntries(root, tenantId)).filter((e) => wanted.has(e.id));
        expect(picked.map((e) => e.id), `minScore ${minScore} tenant ${tenantId}`).toEqual(inOrder.map((e) => e.id));
        expect(picked).toEqual(inOrder);
        expect(stats.neverAutoShareSkipped).toBe(tenantId === undefined ? 4 : 3);
      }
    }
  });

  it('reads only the rows that can clear a score above neutral', () => {
    for (let i = 0; i < 60; i++) put(`plain ${i}`);
    const errorId = put('error', {}, ['error']);
    for (const tenantId of ['default', undefined]) {
      const { result, statements, rowsRead } = recordStatements(() => autoShare(...sharingStores(root), { dryRun: true, tenantId }));
      expect(result.map((e) => e.id)).toEqual([errorId]);
      expect(countMatching(statements, WHOLE_READ)).toBe(0);
      expect(rowsRead).toBeLessThan(10);
    }
  });
});
