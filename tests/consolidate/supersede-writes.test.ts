import { afterEach, describe, it, expect, vi } from 'vitest';
import { sleepWholeStore } from '../../src/api/index.js';
import { autoShareToGlobal, shareToGlobal } from '../../src/api/sharing.js';
import { deduplicateStore } from '../../src/domain/consolidate/dedupe.js';
import { auditRowsOn } from '../_helpers/audit-rows.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadEveryTenantEntries } from '../_helpers/root-forms.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';
import { DAY, HIDE, OLD, SOFT, THIRD, fact, root } from '../_helpers/supersede-facts.js';
import { pinClock } from '../_helpers/fixed-clock.js';

const { apiCtx, writeEntry, readEntry, sessionDb } = sessionPerTest();

pinClock();

afterEach(() => {
  vi.unstubAllEnvs();
});

const supersedeAudits = (hippoRoot: string) =>
  auditRowsOn(sessionDb(hippoRoot)).filter((row) => row.op === 'supersede');

describe('the write that links', () => {
  const link = (tenantId: string, id: string, newId: string, mode: 'hide' | 'soft' = 'hide') => ({
    tenantId,
    id,
    newId,
    mode,
  });

  it('lands nothing when the new row was forgotten first', async () => {
    const home = root();
    const ctx = apiCtx(home);
    const old = fact(OLD, 2 * DAY);
    const next = fact(HIDE, DAY);
    writeEntry(home, old);
    writeEntry(home, next);
    await ctx.store.auditMaintenance.deleteAutomatically([{ id: next.id, reason: 'test' }], 'test');

    const written = await ctx.store.consolidation.supersedeLinks([link('default', old.id, next.id)]);

    expect(written).toEqual([]);
    expect(readEntry(home, old.id)?.supersededBy).toBeNull();
    expect(supersedeAudits(home)).toHaveLength(0);
  });

  it('lands nothing when the new row was itself replaced first', async () => {
    const home = root();
    const ctx = apiCtx(home);
    const [old, next, third] = [fact(OLD, 3 * DAY), fact(HIDE, 2 * DAY), fact(THIRD, DAY)];
    [old, next, third].forEach((row) => writeEntry(home, row));

    const hidden = await ctx.store.consolidation.supersedeLinks([link('default', next.id, third.id)]);
    const refused = await ctx.store.consolidation.supersedeLinks([link('default', old.id, next.id)]);

    expect(hidden).toEqual([next.id]);
    expect(refused).toEqual([]);
    expect(readEntry(home, old.id)?.supersededBy).toBeNull();
  });

  it('refuses a soft mark on a row that is no longer current', async () => {
    const home = root();
    const ctx = apiCtx(home);
    const [old, next, third] = [fact(OLD, 3 * DAY), fact(SOFT, 2 * DAY), fact(THIRD, DAY)];
    [old, next, third].forEach((row) => writeEntry(home, row));
    await ctx.store.consolidation.supersedeLinks([link('default', old.id, third.id)]);

    const written = await ctx.store.consolidation.supersedeLinks([link('default', old.id, next.id, 'soft')]);

    expect(written).toEqual([]);
    expect(readEntry(home, old.id)?.supersededBy).toBe(third.id);
  });
});

describe('dedup of the row a link points at', () => {
  it('repoints the hidden row and the demoted row to the copy that stays', async () => {
    const home = root();
    const ctx = apiCtx(home);
    const hidden = fact(OLD, 3 * DAY);
    const demoted = fact('Staging deploys go through the Jenkins pipeline every night.', 3 * DAY);
    const loser = fact(HIDE, 2 * DAY);
    const winner = fact(HIDE, DAY, { retrievalCount: 5 });
    [hidden, demoted, loser, winner].forEach((row) => writeEntry(home, row));
    await ctx.store.consolidation.supersedeLinks([
      { tenantId: 'default', id: hidden.id, newId: loser.id, mode: 'hide' },
      { tenantId: 'default', id: demoted.id, newId: loser.id, mode: 'soft' },
    ]);

    const result = await deduplicateStore(ctx.store, { actor: 'test' });

    expect(result.pairs.map((p) => [p.kept, p.removed])).toEqual([[winner.id, loser.id]]);
    expect(readEntry(home, loser.id)).toBeNull();
    expect(readEntry(home, hidden.id)?.supersededBy).toBe(winner.id);
    const tags = readEntry(home, demoted.id)?.tags ?? [];
    expect(tags).toContain(`replaced-by:${winner.id}`);
    expect(tags).not.toContain(`replaced-by:${loser.id}`);
  });

  it('leaves a link alone when the row it points at is not the one deleted', async () => {
    const home = root();
    const ctx = apiCtx(home);
    const hidden = fact(OLD, 3 * DAY);
    const kept = fact(HIDE, 2 * DAY);
    const other = fact('The nightly backup of the billing database runs on Postgres.', 2 * DAY);
    const copy = fact('The nightly backup of the billing database runs on Postgres.', DAY, { retrievalCount: 5 });
    [hidden, kept, other, copy].forEach((row) => writeEntry(home, row));
    await ctx.store.consolidation.supersedeLinks([
      { tenantId: 'default', id: hidden.id, newId: kept.id, mode: 'hide' },
    ]);

    await deduplicateStore(ctx.store, { actor: 'test' });

    expect(readEntry(home, other.id)).toBeNull();
    expect(readEntry(home, hidden.id)?.supersededBy).toBe(kept.id);
  });
});

describe('a global copy of a replaced memory', () => {
  const PROJECT = 'proj-a';
  const base = { originProject: PROJECT };

  function setup() {
    const globalHome = makeRoot('supersede-global');
    vi.stubEnv('HIPPO_HOME', globalHome);
    return { home: root(), globalHome };
  }

  // Auto-share off, so a copy exists only where the test shared it.
  function contextOf(home: string): ReturnType<typeof apiCtx> {
    const ctx = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
    return { ...ctx, config: { ...ctx.config, autoShareOnSleep: false } };
  }

  it('is hidden toward the global copy of the new row when the global store holds one', async () => {
    const { home, globalHome } = setup();
    const old = fact(OLD, 2 * DAY, base);
    const next = fact(HIDE, DAY, base);
    writeEntry(home, old);
    writeEntry(home, next);
    const ctx = contextOf(home);
    const sharedOld = await shareToGlobal(ctx, old.id, { force: true });
    const sharedNext = await shareToGlobal(ctx, next.id, { force: true });
    if (sharedOld.kind !== 'shared' || sharedNext.kind !== 'shared') throw new Error('both rows share');

    const result = await sleepWholeStore(ctx, {});

    expect(readEntry(home, old.id)?.supersededBy).toBe(next.id);
    expect(readEntry(globalHome, sharedOld.entry.id)?.supersededBy).toBe(sharedNext.entry.id);
    expect(readEntry(globalHome, sharedNext.entry.id)?.supersededBy).toBeNull();
    expect(result.events?.some((e) => e.kind === 'phaseSkipped')).toBe(false);
  });

  it('is marked stale, naming the local new row, when the global store has no copy of it', async () => {
    const { home, globalHome } = setup();
    const old = fact(OLD, 2 * DAY, base);
    const next = fact(HIDE, DAY, base);
    writeEntry(home, old);
    writeEntry(home, next);
    const ctx = contextOf(home);
    const sharedOld = await shareToGlobal(ctx, old.id, { force: true });
    if (sharedOld.kind !== 'shared') throw new Error('the old row shares');

    await sleepWholeStore(ctx, {});

    const copy = readEntry(globalHome, sharedOld.entry.id);
    expect(copy).toMatchObject({ confidence: 'stale', supersededBy: null });
    expect(copy?.tags).toContain(`replaced-by:${next.id}`);
  });

  it('is demoted, not hidden, when the newer text has no update word', async () => {
    const { home, globalHome } = setup();
    const old = fact(OLD, 2 * DAY, base);
    const next = fact(SOFT, DAY, base);
    writeEntry(home, old);
    writeEntry(home, next);
    const ctx = contextOf(home);
    const sharedOld = await shareToGlobal(ctx, old.id, { force: true });
    const sharedNext = await shareToGlobal(ctx, next.id, { force: true });
    if (sharedOld.kind !== 'shared' || sharedNext.kind !== 'shared') throw new Error('both rows share');

    await sleepWholeStore(ctx, {});

    const copy = readEntry(globalHome, sharedOld.entry.id);
    expect(copy).toMatchObject({ confidence: 'stale', supersededBy: null });
    expect(copy?.tags).toContain(`replaced-by:${sharedNext.entry.id}`);
  });

  it('is left alone when it comes from another project', async () => {
    const { home, globalHome } = setup();
    const old = fact(OLD, 2 * DAY, base);
    const next = fact(HIDE, DAY, base);
    writeEntry(home, old);
    writeEntry(home, next);
    const ctx = contextOf(home);
    const sharedOld = await shareToGlobal(ctx, old.id, { force: true });
    if (sharedOld.kind !== 'shared') throw new Error('the old row shares');
    const elsewhere = { ...sharedOld.entry, id: 'g_elsewhere', originProject: 'proj-b', content: OLD };
    writeEntry(globalHome, elsewhere);

    await sleepWholeStore(ctx, {});

    expect(readEntry(globalHome, 'g_elsewhere')).toMatchObject({ confidence: elsewhere.confidence, supersededBy: null });
  });

  it('is left alone by a sleep that does not share', async () => {
    const { home, globalHome } = setup();
    const old = fact(OLD, 2 * DAY, base);
    const next = fact(HIDE, DAY, base);
    writeEntry(home, old);
    writeEntry(home, next);
    const ctx = contextOf(home);
    const sharedOld = await shareToGlobal(ctx, old.id, { force: true });
    if (sharedOld.kind !== 'shared') throw new Error('the old row shares');

    await sleepWholeStore(ctx, { noShare: true });

    expect(readEntry(globalHome, sharedOld.entry.id)).toMatchObject({
      confidence: sharedOld.entry.confidence,
      supersededBy: null,
    });
  });

  describe('is never made by share', () => {
    it('for a hidden row', async () => {
      const { home } = setup();
      const old = fact(OLD, 2 * DAY, { ...base, supersededBy: 'mem_newer' });
      writeEntry(home, old);
      const ctx = contextOf(home);

      await expect(shareToGlobal(ctx, old.id, { force: true })).rejects.toThrow(/newer memory replaced it/);
    });

    it('for a stale row', async () => {
      const { home } = setup();
      const old = fact(OLD, 2 * DAY, { ...base, confidence: 'stale' });
      writeEntry(home, old);
      const ctx = contextOf(home);

      await expect(shareToGlobal(ctx, old.id, { force: true })).rejects.toThrow(/newer memory replaced it/);
    });

    it('by auto-share, which copies the current row and skips the stale one', async () => {
      const { home, globalHome } = setup();
      const current = fact('The release train leaves the depot every Thursday afternoon.', DAY, base);
      const stale = fact(OLD, DAY, { ...base, confidence: 'stale' });
      writeEntry(home, current);
      writeEntry(home, stale);
      const ctx = contextOf(home);

      const copied = await autoShareToGlobal(ctx, { minScore: 0, dryRun: false });

      expect(copied.map((e) => e.content)).toEqual([current.content]);
      expect(loadEveryTenantEntries(globalHome).map((e) => e.content)).toEqual([current.content]);
    });
  });
});

describe('the sleep result and its audit row', () => {
  it('count the rows hidden and demoted', async () => {
    const home = root();
    writeEntry(home, fact(OLD, 2 * DAY));
    writeEntry(home, fact(HIDE, DAY));
    writeEntry(home, fact('We run tests with Jest.', 2 * DAY));
    writeEntry(home, fact('We run tests with Vitest.', DAY));
    const ctx = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });

    const result = await sleepWholeStore(ctx, { noShare: true });

    expect(result).toMatchObject({ superseded: 1, demoted: 1 });
    const audit = auditRowsOn(sessionDb(home)).filter((row) => row.op === 'consolidate');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({ hiddenCount: 1, demotedCount: 1 });
  });

  it('carry no count when nothing was linked', async () => {
    const home = root();
    writeEntry(home, fact(OLD, DAY));
    const ctx = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });

    const result = await sleepWholeStore(ctx, { noShare: true });

    expect(result.superseded).toBeUndefined();
    expect(result.demoted).toBeUndefined();
    const audit = auditRowsOn(sessionDb(home)).filter((row) => row.op === 'consolidate');
    expect(audit[0]?.metadata).toMatchObject({ hiddenCount: 0, demotedCount: 0 });
  });
});

