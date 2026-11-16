import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { consolidate } from '../../src/index.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { getHippoDbPath } from '../../src/db/connect.js';
import { replacesOne } from '../../src/domain/consolidate/supersede-pass.js';
import { sleepResultLines } from '../../src/surface/cli/sleep-render.js';
import { auditRowsOn } from '../_helpers/audit-rows.js';
import { FIXED_NOW, pinClock } from '../_helpers/fixed-clock.js';
import { loadEveryTenantEntries } from '../_helpers/root-forms.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';
import { AGAIN, DAY, HIDE, OLD, SOFT, THIRD, fact, iso, root } from '../_helpers/supersede-facts.js';

const { writeEntry, readEntry, sessionDb } = sessionPerTest();

pinClock();

const supersedeAudits = (hippoRoot: string) =>
  auditRowsOn(sessionDb(hippoRoot)).filter((row) => row.op === 'supersede');

const semanticTexts = (hippoRoot: string): string[] =>
  loadEveryTenantEntries(hippoRoot)
    .filter((e) => e.layer === Layer.Semantic)
    .map((e) => e.content);

const eventsOf = (result: { events: readonly { kind: string }[] }) =>
  result.events.filter((e) => e.kind === 'superseded');

describe('replacesOne', () => {
  it.each([
    ['I live in Denver.', 'I live in Austin now.'],
    ['We run tests with Jest.', 'We run tests with Vitest now.'],
    ['We run tests with Jest.', 'We run tests with Vitest.'],
    [OLD, HIDE],
    [OLD, SOFT],
    [HIDE, AGAIN],
  ])('links %j to %j', (oldText, newText) => {
    expect(replacesOne(oldText, newText)).toBe(true);
  });

  it.each([
    ['a different subject', 'My sister has a parrot as a pet.', 'My cousin has a parrot as a pet.'],
    ['a restatement', 'I live in Denver.', 'I live in Denver.'],
    ['a restatement with only a cue added', 'I live in Denver.', 'I live in Denver now.'],
    ['an elaboration', 'I live in Denver.', 'I live in Denver near the park.'],
    ['one shared word before the change', 'Denver is where I live.', 'Austin is where I live.'],
    ['a change of more than four words', 'We run all the tests with Jest.', 'We run a new tool called Vitest instead.'],
    ['a short text with little in common', 'We use pnpm', 'We use yarn and npm workspaces'],
  ])('does not link %s', (_label, oldText, newText) => {
    expect(replacesOne(oldText, newText)).toBe(false);
  });
});

describe('sleep links an old fact to the memory that changed it', () => {
  it('hides the old row when the newer text says it is an update, audits it and keeps merge from folding the pair', async () => {
    const home = root();
    const old = fact(OLD, 2 * DAY);
    const next = fact(HIDE, DAY);
    writeEntry(home, old);
    writeEntry(home, next);

    const result = await consolidate(home, { now: FIXED_NOW });

    expect(readEntry(home, old.id)?.supersededBy).toBe(next.id);
    expect(readEntry(home, next.id)?.supersededBy).toBeNull();
    expect(result.superseded).toBe(1);
    expect(result.demoted).toBe(0);
    expect(eventsOf(result)).toEqual([
      { kind: 'superseded', oldId: old.id, newId: next.id, rule: 'one-span', mode: 'hide' },
    ]);
    expect(supersedeAudits(home)).toMatchObject([
      {
        actor: 'sleep',
        targetId: old.id,
        metadata: { newId: next.id, by: 'sleep', rule: 'one-span', mode: 'hide' },
      },
    ]);
    expect(result.merged).toBe(0);
    expect(semanticTexts(home)).toEqual([]);
  });

  it('marks the old row stale, with no half-life cut, when the newer text has no update word', async () => {
    const home = root();
    const old = fact(OLD, 2 * DAY);
    const next = fact(SOFT, DAY);
    writeEntry(home, old);
    writeEntry(home, next);

    const result = await consolidate(home, { now: FIXED_NOW });

    const after = readEntry(home, old.id);
    expect(after).toMatchObject({ confidence: 'stale', supersededBy: null, halfLifeDays: old.halfLifeDays });
    expect(after?.tags).toContain(`replaced-by:${next.id}`);
    expect(readEntry(home, next.id)).toMatchObject({ confidence: next.confidence, supersededBy: null });
    expect(result.superseded).toBe(0);
    expect(result.demoted).toBe(1);
    expect(eventsOf(result)).toEqual([
      { kind: 'superseded', oldId: old.id, newId: next.id, rule: 'one-span', mode: 'soft' },
    ]);
    expect(supersedeAudits(home)).toMatchObject([
      {
        actor: 'sleep',
        targetId: old.id,
        metadata: { newId: next.id, by: 'sleep', rule: 'one-span', mode: 'soft' },
      },
    ]);
    expect(result.merged).toBe(0);
    expect(semanticTexts(home)).toEqual([]);
  });

  it.each([
    ['now', 'with Vitest now', 'hide'],
    ['a capitalised cue', 'with Vitest Now', 'hide'],
    ['instead', 'with Vitest instead', 'hide'],
    ['again', 'with Vitest again', 'hide'],
    ['actually', 'with Vitest actually', 'hide'],
    ['anymore', 'with Vitest anymore', 'hide'],
    ['no longer', 'with Vitest no longer', 'hide'],
    ['moved to', 'moved to Vitest', 'hide'],
    ['switched to', 'switched to Vitest', 'hide'],
    ['changed to', 'changed to Vitest', 'hide'],
    ['back to', 'back to Vitest', 'hide'],
    ['a word that only holds a cue inside it', 'with Vitest knowing', 'soft'],
    ['no cue', 'with Vitest', 'soft'],
  ])('picks the mode by the update word: %s', async (_label, change, mode) => {
    const home = root();
    const sentence = (how: string): string => `We run all the unit tests ${how} on the staging server every night.`;
    const old = fact(sentence('with Jest'), 2 * DAY);
    const next = fact(sentence(change), DAY);
    writeEntry(home, old);
    writeEntry(home, next);

    await consolidate(home, { now: FIXED_NOW });

    const after = readEntry(home, old.id);
    if (mode === 'hide') {
      expect(after?.supersededBy).toBe(next.id);
    } else {
      expect(after?.supersededBy).toBeNull();
      expect(after?.tags).toContain(`replaced-by:${next.id}`);
    }
  });

  it('links a pair once, so the next sleep finds nothing to do', async () => {
    const home = root();
    writeEntry(home, fact(OLD, 2 * DAY));
    writeEntry(home, fact(HIDE, DAY));
    writeEntry(home, fact('We run tests with Jest.', 2 * DAY));
    writeEntry(home, fact('We run tests with Vitest.', DAY));

    await consolidate(home, { now: FIXED_NOW });
    const again = await consolidate(home, { now: FIXED_NOW });

    expect(again.superseded + again.demoted).toBe(0);
    expect(supersedeAudits(home)).toHaveLength(2);
  });

  it('merges the same pair when no link is made, so the merge checks are not idle', async () => {
    const home = root();
    writeEntry(home, fact(OLD, 2 * DAY));
    writeEntry(home, fact(HIDE, DAY, { outcomeNegative: 1 }));

    const result = await consolidate(home, { now: FIXED_NOW });

    expect(result.superseded + result.demoted).toBe(0);
    expect(result.merged).toBe(2);
  });

  describe('follows a fact through its versions', () => {
    it('links each version to the next in one sleep', async () => {
      const home = root();
      const v1 = fact(OLD, 3 * DAY);
      const v2 = fact(HIDE, 2 * DAY);
      const v3 = fact(THIRD, DAY);
      [v3, v1, v2].forEach((row) => writeEntry(home, row));

      const result = await consolidate(home, { now: FIXED_NOW });

      expect(readEntry(home, v1.id)?.supersededBy).toBe(v2.id);
      expect(readEntry(home, v2.id)?.supersededBy).toBe(v3.id);
      expect(readEntry(home, v3.id)?.supersededBy).toBeNull();
      expect(eventsOf(result)).toMatchObject([
        { oldId: v1.id, newId: v2.id, mode: 'hide' },
        { oldId: v2.id, newId: v3.id, mode: 'hide' },
      ]);
      expect(result.superseded).toBe(2);
      expect(semanticTexts(home)).toEqual([]);
    });

    it('demotes each version of a chain with no update word', async () => {
      const home = root();
      const v1 = fact(OLD, 3 * DAY);
      const v2 = fact(SOFT, 2 * DAY);
      const v3 = fact(SOFT.replace('Buildkite', 'CircleCI'), DAY);
      [v1, v2, v3].forEach((row) => writeEntry(home, row));

      const result = await consolidate(home, { now: FIXED_NOW });

      expect(readEntry(home, v1.id)?.tags).toContain(`replaced-by:${v2.id}`);
      expect(readEntry(home, v2.id)?.tags).toContain(`replaced-by:${v3.id}`);
      expect(readEntry(home, v3.id)).toMatchObject({ confidence: v3.confidence, supersededBy: null });
      expect(result.demoted).toBe(2);
      expect(semanticTexts(home)).toEqual([]);
    });

    it('treats the same text written twice as one value and links to the earlier copy', async () => {
      const home = root();
      const old = fact(OLD, 3 * DAY);
      const first = fact(HIDE, 2 * DAY);
      const twin = fact(HIDE, DAY);
      [old, first, twin].forEach((row) => writeEntry(home, row));

      await consolidate(home, { now: FIXED_NOW });

      expect(readEntry(home, old.id)?.supersededBy).toBe(first.id);
    });

    it('follows a reversal A, B, A again as a chain and leaves the last row current', async () => {
      const home = root();
      const a = fact(OLD, 3 * DAY);
      const b = fact(HIDE, 2 * DAY);
      const a2 = fact(AGAIN, DAY);
      [a, b, a2].forEach((row) => writeEntry(home, row));

      await consolidate(home, { now: FIXED_NOW });

      expect(readEntry(home, a.id)?.supersededBy).toBe(b.id);
      expect(readEntry(home, b.id)?.supersededBy).toBe(a2.id);
      expect(readEntry(home, a2.id)?.supersededBy).toBeNull();
    });
  });

  describe('leaves the old row alone', () => {
    const untouched = async (
      home: string,
      old: MemoryEntry,
      options: { dryRun?: boolean } = {},
    ) => {
      const result = await consolidate(home, { now: FIXED_NOW, ...options });
      const after = readEntry(home, old.id);
      expect(after?.supersededBy).toBeNull();
      expect(after?.tags.some((t) => t.startsWith('replaced-by:'))).toBe(false);
      expect(supersedeAudits(home)).toHaveLength(0);
      return result;
    };

    it('across tenants', async () => {
      const home = root();
      const old = fact(OLD, 2 * DAY, { tenantId: 'tenant-a' });
      writeEntry(home, old);
      writeEntry(home, fact(HIDE, DAY, { tenantId: 'tenant-b' }));

      expect((await untouched(home, old)).superseded).toBe(0);
    });

    it('across projects', async () => {
      const home = root();
      const old = fact(OLD, 2 * DAY, { originProject: 'project-a' });
      writeEntry(home, old);
      writeEntry(home, fact(HIDE, DAY, { originProject: 'project-b' }));

      expect((await untouched(home, old)).superseded).toBe(0);
    });

    it('when the old row is pinned', async () => {
      const home = root();
      const old = fact(OLD, 2 * DAY, { pinned: true });
      writeEntry(home, old);
      writeEntry(home, fact(HIDE, DAY));

      expect((await untouched(home, old)).superseded).toBe(0);
    });

    it('when the new row was marked bad', async () => {
      const home = root();
      const old = fact(OLD, 2 * DAY);
      writeEntry(home, old);
      writeEntry(home, fact(HIDE, DAY, { outcomeNegative: 1 }));

      expect((await untouched(home, old)).superseded).toBe(0);
    });

    describe('when a row did not come from a person', () => {
      it.each(['tool-failure', 'compaction:run-1', 'consolidation', 'session-digest', 'shared:proj:2026-01-01'])(
        'on the old side: source %s',
        async (source) => {
          const home = root();
          const old = fact(OLD, 2 * DAY, { source });
          writeEntry(home, old);
          writeEntry(home, fact(HIDE, DAY));

          expect((await untouched(home, old)).superseded).toBe(0);
        },
      );

      it.each(['tool-failure', 'compaction:run-1', 'consolidation', 'session-digest', 'shared:proj:2026-01-01'])(
        'on the new side: source %s',
        async (source) => {
          const home = root();
          const old = fact(OLD, 2 * DAY);
          writeEntry(home, old);
          writeEntry(home, fact(HIDE, DAY, { source }));

          expect((await untouched(home, old)).superseded).toBe(0);
        },
      );

      it('on either side: an error-tagged row', async () => {
        const home = root();
        const old = fact(OLD, 2 * DAY, { tags: ['error'] });
        writeEntry(home, old);
        writeEntry(home, fact(HIDE, DAY));

        expect((await untouched(home, old)).superseded).toBe(0);
      });

      it.each(['cli', 'cli-global', 'capture', 'claude-memory:notes'])('but links source %s', async (source) => {
        const home = root();
        const old = fact(OLD, 2 * DAY, { source });
        const next = fact(HIDE, DAY, { source });
        writeEntry(home, old);
        writeEntry(home, next);

        await consolidate(home, { now: FIXED_NOW });

        expect(readEntry(home, old.id)?.supersededBy).toBe(next.id);
      });
    });

    describe('when a text is long', () => {
      const lead = (n: number): string => Array.from({ length: n }, (_, i) => `item${i}`).join(' ');

      it('at 21 words', async () => {
        const home = root();
        const old = fact(`${lead(20)} Jenkins`, 2 * DAY);
        writeEntry(home, old);
        writeEntry(home, fact(`${lead(20)} Buildkite`, DAY));

        expect((await untouched(home, old)).demoted).toBe(0);
      });

      it('but links a pair at 20 words', async () => {
        const home = root();
        const old = fact(`${lead(19)} Jenkins`, 2 * DAY);
        writeEntry(home, old);
        writeEntry(home, fact(`${lead(19)} Buildkite`, DAY));

        expect((await consolidate(home, { now: FIXED_NOW })).demoted).toBe(1);
      });

      it('counting an update word, which the match later drops', async () => {
        const home = root();
        const old = fact(`${lead(19)} Jenkins`, 2 * DAY);
        writeEntry(home, old);
        writeEntry(home, fact(`${lead(19)} Buildkite now`, DAY));

        expect((await untouched(home, old)).superseded).toBe(0);
      });
    });

    describe('when the confidence does not carry over', () => {
      it('the new row is stale', async () => {
        const home = root();
        const old = fact(OLD, 2 * DAY);
        writeEntry(home, old);
        writeEntry(home, fact(HIDE, DAY, { confidence: 'stale' }));

        expect((await untouched(home, old)).superseded).toBe(0);
      });

      it('the new row ranks below the old one', async () => {
        const home = root();
        const old = fact(OLD, 2 * DAY, { confidence: 'verified' });
        writeEntry(home, old);
        writeEntry(home, fact(HIDE, DAY, { confidence: 'inferred' }));

        expect((await untouched(home, old)).superseded).toBe(0);
      });

      it('but a new row of higher rank links', async () => {
        const home = root();
        const old = fact(OLD, 2 * DAY, { confidence: 'inferred' });
        const next = fact(HIDE, DAY, { confidence: 'verified' });
        writeEntry(home, old);
        writeEntry(home, next);

        await consolidate(home, { now: FIXED_NOW });

        expect(readEntry(home, old.id)?.supersededBy).toBe(next.id);
      });
    });

    describe('when a person kept the old row current', () => {
      it('the tag names the new row', async () => {
        const home = root();
        const next = fact(HIDE, DAY);
        const old = fact(OLD, 2 * DAY, { tags: [`kept-current:${next.id}`] });
        writeEntry(home, old);
        writeEntry(home, next);

        expect((await untouched(home, old)).superseded).toBe(0);
      });

      it('but a tag that names another row does not hold the pair apart', async () => {
        const home = root();
        const next = fact(HIDE, DAY);
        const old = fact(OLD, 2 * DAY, { tags: ['kept-current:other'] });
        writeEntry(home, old);
        writeEntry(home, next);

        await consolidate(home, { now: FIXED_NOW });

        expect(readEntry(home, old.id)?.supersededBy).toBe(next.id);
      });
    });

    describe('when the two clocks do not say the same', () => {
      it('the rows share one time', async () => {
        const home = root();
        const old = fact(OLD, DAY);
        writeEntry(home, old);
        writeEntry(home, fact(HIDE, DAY));

        expect((await untouched(home, old)).superseded).toBe(0);
      });

      it('the rows share a valid time but not a creation time', async () => {
        const home = root();
        const old = fact(OLD, 2 * DAY, { validFrom: iso(3 * DAY) });
        writeEntry(home, old);
        writeEntry(home, fact(HIDE, DAY, { validFrom: iso(3 * DAY) }));

        expect((await untouched(home, old)).superseded).toBe(0);
      });

      it('the rows share a creation time but not a valid time', async () => {
        const home = root();
        const old = fact(OLD, 2 * DAY, { validFrom: iso(4 * DAY) });
        writeEntry(home, old);
        writeEntry(home, fact(HIDE, 2 * DAY, { validFrom: iso(3 * DAY) }));

        expect((await untouched(home, old)).superseded).toBe(0);
      });

      it('the new row was created later but holds the earlier valid time', async () => {
        const home = root();
        const old = fact(OLD, 2 * DAY);
        writeEntry(home, old);
        writeEntry(home, fact(HIDE, DAY, { validFrom: iso(3 * DAY) }));

        expect((await untouched(home, old)).superseded).toBe(0);
      });

      it('the new row holds the later valid time but was created earlier', async () => {
        const home = root();
        const old = fact(OLD, 2 * DAY);
        writeEntry(home, old);
        writeEntry(home, fact(HIDE, 3 * DAY, { validFrom: iso(DAY) }));

        expect((await untouched(home, old)).superseded).toBe(0);
      });

      it('but the valid time orders the pair when it agrees with creation', async () => {
        const home = root();
        const old = fact(OLD, 2 * DAY, { validFrom: iso(5 * DAY) });
        const next = fact(HIDE, DAY, { validFrom: iso(4 * DAY) });
        writeEntry(home, old);
        writeEntry(home, next);

        await consolidate(home, { now: FIXED_NOW });

        expect(readEntry(home, old.id)?.supersededBy).toBe(next.id);
      });
    });

    describe('under a dry run', () => {
      const dry = async (newText: string, mode: 'hide' | 'soft') => {
        const home = root();
        const old = fact(OLD, 2 * DAY);
        const next = fact(newText, DAY);
        writeEntry(home, old);
        writeEntry(home, next);
        const files = (): Buffer[] =>
          [getHippoDbPath(home), `${getHippoDbPath(home)}-wal`].map((f) =>
            existsSync(f) ? readFileSync(f) : Buffer.alloc(0),
          );
        const before = files();
        expect(before[0]?.length).toBeGreaterThan(0);

        const result = await untouched(home, old, { dryRun: true });

        expect(files()).toEqual(before);
        expect(eventsOf(result)).toEqual([
          { kind: 'superseded', oldId: old.id, newId: next.id, rule: 'one-span', mode },
        ]);
        return result;
      };

      it('reports a hide and writes no byte', async () => {
        expect((await dry(HIDE, 'hide')).superseded).toBe(1);
      });

      it('reports a demotion and writes no byte', async () => {
        expect((await dry(SOFT, 'soft')).demoted).toBe(1);
      });
    });
  });

  describe('the real run and its dry run agree on what merge does next', () => {
    it('folds no linked pair into a summary', async () => {
      const dryHome = root();
      const realHome = root();
      for (const home of [dryHome, realHome]) {
        writeEntry(home, fact(OLD, 2 * DAY));
        writeEntry(home, fact(SOFT, DAY));
      }

      const dryRun = await consolidate(dryHome, { now: FIXED_NOW, dryRun: true });
      const real = await consolidate(realHome, { now: FIXED_NOW });

      expect(dryRun.merged).toBe(0);
      expect(real.merged).toBe(0);
    });
  });
});

describe('the sleep report', () => {
  const report = (counts: { superseded?: number; demoted?: number }) =>
    sleepResultLines({
      active: 2,
      removed: 0,
      mergedEpisodic: 0,
      newSemantic: 0,
      dryRun: false,
      ...counts,
      events: [
        { kind: 'superseded', oldId: 'mem_a', newId: 'mem_b', rule: 'one-span', mode: 'hide' },
        { kind: 'superseded', oldId: 'mem_c', newId: 'mem_d', rule: 'one-span', mode: 'soft' },
      ],
    });

  it('shows each count, each pair and how to undo', () => {
    const lines = report({ superseded: 1, demoted: 1 });
    expect(lines).toContain('   Replaced:          1');
    expect(lines).toContain('   Demoted:           1  (no update word)');
    expect(lines).toContain('  replaced: mem_a -> mem_b');
    expect(lines).toContain('  demoted: mem_c -> mem_d');
    expect(lines.at(-1)).toBe('  undo: hippo unsupersede <id>');
  });

  it('words a dry run as what would happen', () => {
    const lines = sleepResultLines({
      active: 2,
      removed: 0,
      mergedEpisodic: 0,
      newSemantic: 0,
      dryRun: true,
      superseded: 1,
      events: [{ kind: 'superseded', oldId: 'mem_a', newId: 'mem_b', rule: 'one-span', mode: 'hide' }],
    });
    expect(lines).toContain('  would be replaced: mem_a -> mem_b');
  });

  it('adds no count or undo line when nothing was linked', () => {
    const lines = sleepResultLines({
      active: 2,
      removed: 0,
      mergedEpisodic: 0,
      newSemantic: 0,
      dryRun: false,
    });
    expect(lines.some((l) => l.includes('Replaced:') || l.includes('Demoted:') || l.includes('undo:'))).toBe(false);
  });
});
