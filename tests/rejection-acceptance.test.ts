/**
 * AT1 T3 acceptance-critical tests: docs/plans/2026-08-15-at1-rejected-value-tombstone.md
 * §7 (tests) + the six cases assigned to T3.
 *
 * Real DB, per the project convention (mirrors tests/rejection-guard.test.ts
 * and tests/rejection-verbs.test.ts, which already cover guard mechanics,
 * verbs, and resolveConflict — none of that is repeated here).
 *
 * Six cases:
 *   1. Acceptance (roadmap-verbatim): reject-by-id then capture re-assertion.
 *   2. Refused supersede: CAS rollback + one reject_refusal audit row.
 *   3. Copy-path: syncGlobalToLocal skips a locally-rejected value.
 *   4. Rebuild resurrection pin: a stale markdown mirror cannot resurrect.
 *   5. Migration v41 idempotence (fresh re-open + a v40-shaped upgrade).
 *   6. AT5 paired case: reject removes a value from recall, permanently.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, getSchemaVersion } from '../src/db.js';
import { initStore, writeEntry, readEntry, loadAllEntries, rebuildIndex } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { queryAuditEvents } from '../src/audit.js';
import {
  RejectedValueError,
  rejectionDigest,
  normalizeValueForRejection,
  insertRejectedValue,
  findRejectedValue,
} from '../src/rejection.js';
import { cmdCapture } from '../src/capture.js';
import { syncGlobalToLocal } from '../src/shared.js';
import * as api from '../src/api.js';
import { consolidate } from '../src/consolidate.js';
import { importEntries } from '../src/importers.js';

function tmpHome(prefix: string = 'hippo-rejection-acceptance-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ctx(hippoRoot: string, tenantId: string = 'default'): api.Context {
  return { hippoRoot, tenantId, actor: { subject: 'cli', role: 'admin' } };
}

describe('AT1 case 1: acceptance (roadmap-verbatim)', () => {
  it('reject X by id -> capture re-assertion refused, 2 siblings written, one reject_refusal audit row, extraction does not throw; supersession unchanged', () => {
    const home = tmpHome();
    try {
      initStore(home);

      // Seed X, then reject it by id — removes the row and tombstones its digest.
      const xContent = 'use bearer tokens for outbound api calls';
      const x = createMemory(xContent, { layer: Layer.Episodic });
      writeEntry(home, x);
      api.reject(ctx(home), { memoryId: x.id, reason: 'no longer approved for outbound calls' });
      expect(readEntry(home, x.id)).toBeNull();

      // A transcript re-asserting X among 3 extractable decision items.
      const fixturePath = join(home, 'transcript-fixture.txt');
      writeFileSync(
        fixturePath,
        [
          `decision: ${xContent}`,
          // Siblings need a specificity signal (number/proper-noun/path/code)
          // per audit.ts's isContentWorthStoring gate (hasNoSpecificity) — a
          // vague under-40-char sentence with no digits gets filtered before
          // it ever reaches the rejection guard, which would silently turn
          // this into a 1-item extraction instead of the intended 3.
          'decision: cache dns lookups for 5 minutes',
          'decision: rotate deploy keys every 90 days',
        ].join('\n'),
        'utf8',
      );

      expect(() =>
        cmdCapture(home, { source: 'file', filePath: fixturePath, dryRun: false, global: false }),
      ).not.toThrow();

      const contents = loadAllEntries(home).map((e) => e.content);
      expect(contents).not.toContain(xContent);
      expect(contents.some((c) => c.includes('cache dns lookups'))).toBe(true);
      expect(contents.some((c) => c.includes('rotate deploy keys'))).toBe(true);

      const db = openHippoDb(home);
      try {
        const refusals = queryAuditEvents(db, { tenantId: 'default', op: 'reject_refusal' });
        expect(refusals.length).toBe(1);
      } finally {
        closeHippoDb(db);
      }

      // Supersession unchanged for non-rejected values: api.supersede.
      const u = createMemory('unrelated baseline for api supersede', { layer: Layer.Episodic });
      writeEntry(home, u);
      const supersedeResult = api.supersede(ctx(home), u.id, 'unrelated baseline, revised');
      expect(supersedeResult.ok).toBe(true);
      expect(readEntry(home, u.id)!.superseded_by).toBe(supersedeResult.newId);
      expect(readEntry(home, supersedeResult.newId)!.content).toBe('unrelated baseline, revised');

      // cmdSupersede-style 2-write flow (cli.ts's cmdSupersede pattern,
      // replicated inline — cmdSupersede itself is not exported): mutate
      // old.superseded_by then writeEntry both rows.
      const v = createMemory('second unrelated baseline', { layer: Layer.Episodic });
      writeEntry(home, v);
      const vNew = createMemory('second unrelated baseline, revised', { layer: Layer.Episodic });
      v.superseded_by = vNew.id;
      expect(() => {
        writeEntry(home, v);
        writeEntry(home, vNew);
      }).not.toThrow();
      expect(readEntry(home, v.id)!.superseded_by).toBe(vNew.id);
      expect(readEntry(home, vNew.id)!.content).toBe('second unrelated baseline, revised');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('AT1 case 2: refused supersede audit surface', () => {
  it('api.supersede onto a rejected successor value throws, CAS rolls back (superseded_by unchanged), one reject_refusal audit row', () => {
    const home = tmpHome();
    try {
      initStore(home);
      const old = createMemory('supersede baseline content', { layer: Layer.Episodic });
      writeEntry(home, old);

      const yContent = 'rejected successor content for supersede';
      api.reject(ctx(home), { value: yContent, reason: 'pre-emptively rejected successor' });

      expect(() => api.supersede(ctx(home), old.id, yContent)).toThrow(RejectedValueError);

      // CAS rolled back: the old row's superseded_by pointer is untouched.
      const stored = readEntry(home, old.id);
      expect(stored).not.toBeNull();
      expect(stored!.superseded_by).toBeNull();

      const db = openHippoDb(home);
      try {
        const refusals = queryAuditEvents(db, { tenantId: 'default', op: 'reject_refusal' });
        expect(refusals.length).toBe(1);
        expect(refusals[0]!.metadata.digest).toBe(rejectionDigest(yContent));
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('AT1 case 3: copy-path refusal (syncGlobalToLocal)', () => {
  it('global store holds Z; local store rejects Z; sync skips Z, syncs siblings, and counts the skip', () => {
    const globalRoot = tmpHome('hippo-rejection-acceptance-global-');
    const localRoot = tmpHome('hippo-rejection-acceptance-local-');
    try {
      initStore(globalRoot);
      initStore(localRoot);

      const zContent = 'value rejected locally but present globally';
      const z = createMemory(zContent, { layer: Layer.Episodic });
      const s1 = createMemory('sibling one synced from global', { layer: Layer.Episodic });
      const s2 = createMemory('sibling two synced from global', { layer: Layer.Episodic });
      writeEntry(globalRoot, z);
      writeEntry(globalRoot, s1);
      writeEntry(globalRoot, s2);

      api.reject(ctx(localRoot), { value: zContent, reason: 'rejected locally, must not sync from global' });

      // mockRestore() (unlike a bare unspy) also clears recorded call
      // history, so every assertion against errorSpy must run BEFORE it —
      // restore happens last, after the spy has served its purpose.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const count = syncGlobalToLocal(localRoot, globalRoot);
      expect(count).toBe(2); // siblings only — Z was skipped, not counted as copied

      const localContents = loadAllEntries(localRoot).map((e) => e.content);
      expect(localContents).not.toContain(zContent);
      expect(localContents).toContain('sibling one synced from global');
      expect(localContents).toContain('sibling two synced from global');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('skipped 1 rejected value'));
      errorSpy.mockRestore();
    } finally {
      rmSync(globalRoot, { recursive: true, force: true });
      rmSync(localRoot, { recursive: true, force: true });
    }
  });
});

describe('AT1 case 4: rebuild resurrection pin', () => {
  it('a stale markdown mirror of a rejected raw row is skipped on rebuildIndex, not resurrected', () => {
    const home = tmpHome();
    try {
      initStore(home);

      // Sentinel row so `memories` never drops to zero once rawEntry is
      // archived below. bootstrapLegacyStore (run from every initStore()
      // prologue, including the ones inside readEntry/rebuildIndex) only
      // scans legacy mirrors when memoryCount === 0 — without this sentinel,
      // the store would re-enter that path on every subsequent open as long
      // as the stale mirror sits on disk, each time re-running (and
      // re-auditing) the guard skip. The sentinel isolates the assertion to
      // rebuildIndex's own dedicated per-row guard loop, which is what this
      // test targets.
      const sentinel = createMemory('unrelated sentinel entry keeps memories non-empty', {
        layer: Layer.Episodic,
      });
      writeEntry(home, sentinel);

      const rawContent = 'raw transcript content later rejected and archived';
      const rawEntry = createMemory(rawContent, { layer: Layer.Episodic, kind: 'raw' });
      writeEntry(home, rawEntry);

      const mirrorPath = join(home, Layer.Episodic, `${rawEntry.id}.md`);
      expect(existsSync(mirrorPath)).toBe(true);
      const mirrorSnapshot = readFileSync(mirrorPath, 'utf8');

      api.reject(ctx(home), { memoryId: rawEntry.id, reason: 'raw content rejected' });
      expect(readEntry(home, rawEntry.id)).toBeNull();
      // Post-commit purge removed the mirror (reuses the api.archiveRaw pattern).
      expect(existsSync(mirrorPath)).toBe(false);

      // Construct the resurrection precondition explicitly: a mirror the
      // purge missed (best-effort purge failure, or a not-yet-synced copy).
      writeFileSync(mirrorPath, mirrorSnapshot, 'utf8');

      const dbBefore = openHippoDb(home);
      let refusalsBefore: number;
      try {
        refusalsBefore = queryAuditEvents(dbBefore, { tenantId: 'default', op: 'reject_refusal' }).length;
      } finally {
        closeHippoDb(dbBefore);
      }

      rebuildIndex(home);

      // Value stays absent — the guard skipped the stale-mirror re-insert.
      expect(readEntry(home, rawEntry.id)).toBeNull();

      const dbAfter = openHippoDb(home);
      try {
        const refusalsAfter = queryAuditEvents(dbAfter, { tenantId: 'default', op: 'reject_refusal' });
        expect(refusalsAfter.length).toBe(refusalsBefore + 1);
      } finally {
        closeHippoDb(dbAfter);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('AT1 case 5: migration v41 idempotence', () => {
  it('fresh store stays at schema_version 41 across re-open; rejected_values data survives', () => {
    const home = tmpHome();
    try {
      initStore(home);
      const digest = rejectionDigest('idempotence-check value');

      const db1 = openHippoDb(home);
      try {
        expect(getSchemaVersion(db1)).toBe(41);
        insertRejectedValue(db1, {
          tenantId: 'default',
          digest,
          reason: 'idempotence check',
          rejectedBy: 'test',
          rejectedAt: new Date().toISOString(),
          normalizedChars: normalizeValueForRejection('idempotence-check value').length,
        });
      } finally {
        closeHippoDb(db1);
      }

      // Re-open: runMigrations runs again (it is invoked unconditionally from
      // openHippoDb) but migration.version=41 <= currentVersion=41 is
      // skipped — a no-op that must not disturb existing data.
      const db2 = openHippoDb(home);
      try {
        expect(getSchemaVersion(db2)).toBe(41);
        const row = findRejectedValue(db2, 'default', digest);
        expect(row).not.toBeNull();
        expect(row!.reason).toBe('idempotence check');
      } finally {
        closeHippoDb(db2);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a v40-shaped store (schema_version rolled back, rejected_values dropped) upgrades cleanly to 41 on re-open, without touching min_compatible_binary', () => {
    const home = tmpHome();
    try {
      initStore(home);

      let minCompatBefore: string | undefined;
      const db1 = openHippoDb(home);
      try {
        expect(getSchemaVersion(db1)).toBe(41);
        minCompatBefore = (
          db1.prepare(`SELECT value FROM meta WHERE key = 'min_compatible_binary'`).get() as
            | { value?: string }
            | undefined
        )?.value;

        // Simulate a v40-shaped store: roll the version marker back and drop
        // the v41 table, leaving everything else (including
        // min_compatible_binary) untouched.
        db1.exec(`DROP TABLE IF EXISTS rejected_values`);
        db1.prepare(`UPDATE meta SET value = '40' WHERE key = 'schema_version'`).run();
      } finally {
        closeHippoDb(db1);
      }

      const db2 = openHippoDb(home); // re-open re-runs runMigrations
      try {
        expect(getSchemaVersion(db2)).toBe(41);
        expect(() =>
          insertRejectedValue(db2, {
            tenantId: 'default',
            digest: rejectionDigest('post-upgrade value'),
            reason: 'post-upgrade check',
            rejectedBy: 'test',
            rejectedAt: new Date().toISOString(),
            normalizedChars: normalizeValueForRejection('post-upgrade value').length,
          }),
        ).not.toThrow();

        const minCompatAfter = (
          db2.prepare(`SELECT value FROM meta WHERE key = 'min_compatible_binary'`).get() as
            | { value?: string }
            | undefined
        )?.value;
        expect(minCompatAfter).toBe(minCompatBefore);
      } finally {
        closeHippoDb(db2);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('AT1 case 6: AT5 paired case — reject removes a value from recall, permanently', () => {
  it('reject removes a value from recall; re-remember attempt is refused; recall stays clean', () => {
    const home = tmpHome();
    try {
      initStore(home);
      const wContent = 'do not use the deprecated zynthkey rotation script for staging credentials';
      const remembered = api.remember(ctx(home), { content: wContent });

      const before = api.recall(ctx(home), { query: 'zynthkey', limit: 5 });
      expect(before.results.some((r) => r.id === remembered.id)).toBe(true);

      api.reject(ctx(home), { memoryId: remembered.id, reason: 'staging creds process changed' });

      const afterReject = api.recall(ctx(home), { query: 'zynthkey', limit: 5 });
      expect(afterReject.results.some((r) => r.content === wContent)).toBe(false);

      let caught: unknown = null;
      try {
        api.remember(ctx(home), { content: wContent });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RejectedValueError);

      const afterReattempt = api.recall(ctx(home), { query: 'zynthkey', limit: 5 });
      expect(afterReattempt.results.some((r) => r.content === wContent)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('AT1 consolidation-loop fix: merge tombstone check', () => {
  it('a rejected would-be-merged content digest makes consolidate skip that merge: no semantic row with that digest, sources not demoted/deleted, skip counted', async () => {
    const home = tmpHome('hippo-rejection-acceptance-consolidate-');
    try {
      initStore(home);
      // Disable replay: it independently rehearses (and half-life-boosts)
      // survivors regardless of the merge pass, which would confound the
      // "sources not demoted" half_life_days assertion below.
      writeFileSync(join(home, 'config.json'), JSON.stringify({ replay: { count: 0 } }), 'utf8');

      // longText is the longer of the two, so mergeContents' length-sort
      // deterministically picks it as the 2-entry merge base.
      const shortText = 'migrate the billing database before the next release window';
      const longText = 'migrate the billing database before the next release window with full backups enabled';
      const e1 = createMemory(shortText, { layer: Layer.Episodic });
      const e2 = createMemory(longText, { layer: Layer.Episodic });
      writeEntry(home, e1);
      writeEntry(home, e2);

      const mergedContent = `[Consolidated from 2 related memories]\n\n${longText}`;
      const mergedDigest = rejectionDigest(mergedContent);
      const db = openHippoDb(home);
      try {
        insertRejectedValue(db, {
          tenantId: 'default',
          digest: mergedDigest,
          reason: 'pre-rejected merge rollup',
          rejectedBy: 'test',
          rejectedAt: new Date().toISOString(),
          normalizedChars: normalizeValueForRejection(mergedContent).length,
        });
      } finally {
        closeHippoDb(db);
      }

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await consolidate(home, { dryRun: false });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipped 1 merge(s) whose content matches a rejected value'),
      );
      errorSpy.mockRestore();

      expect(result.semanticCreated).toBe(0);

      const allAfter = loadAllEntries(home);
      // No row anywhere carries the rejected merge digest.
      expect(allAfter.some((e) => rejectionDigest(e.content) === mergedDigest)).toBe(false);

      // Sources survive, UNMERGED: still present, still episodic, half-life
      // untouched (the demotion loop never ran for this cluster).
      const e1After = allAfter.find((e) => e.id === e1.id);
      const e2After = allAfter.find((e) => e.id === e2.id);
      expect(e1After).toBeDefined();
      expect(e2After).toBeDefined();
      expect(e1After!.layer).toBe(Layer.Episodic);
      expect(e2After!.layer).toBe(Layer.Episodic);
      expect(e1After!.half_life_days).toBe(e1.half_life_days);
      expect(e2After!.half_life_days).toBe(e2.half_life_days);

      const dbAfter = openHippoDb(home);
      try {
        const refusals = queryAuditEvents(dbAfter, { tenantId: 'default', op: 'reject_refusal' });
        expect(refusals.length).toBe(1);
      } finally {
        closeHippoDb(dbAfter);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('AT1 P2 fix: import dry-run tombstone accuracy', () => {
  it('importEntries dry-run counts a tombstoned chunk as rejected (not imported), writes nothing, and agrees with a real run', () => {
    const home = tmpHome('hippo-rejection-acceptance-import-dryrun-');
    try {
      initStore(home);
      const rejectedChunk = 'never re-import this specific chunk of text again please';
      const otherChunk = 'a completely different unrelated chunk of text here';
      api.reject(ctx(home), { value: rejectedChunk, reason: 'pre-emptive dry-run test tombstone' });

      const dryResult = importEntries([rejectedChunk, otherChunk], 'import:test', [], {
        hippoRoot: home,
        dryRun: true,
      });
      expect(dryResult.rejected).toBe(1);
      expect(dryResult.imported).toBe(1);
      expect(loadAllEntries(home).length).toBe(0); // dry-run writes nothing

      const realResult = importEntries([rejectedChunk, otherChunk], 'import:test', [], {
        hippoRoot: home,
        dryRun: false,
      });
      expect(realResult.rejected).toBe(1);
      expect(realResult.imported).toBe(1);
      const contents = loadAllEntries(home).map((e) => e.content);
      expect(contents).not.toContain(rejectedChunk);
      expect(contents).toContain(otherChunk);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
