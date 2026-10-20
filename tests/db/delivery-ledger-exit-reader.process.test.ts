// The delivery reader on rows the real ledger writer built: every ledger value, the reuse arms and the fold edge cases.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { blockHash } from '../../src/base/util/token-text.js';
import { seed, verdictOf } from '../_helpers/host-transcript.js';
import { upsertEntryRow } from '../../src/store/sqlite/entry-row.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { deleteEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import {
  STAGES,
  REASONS,
  CREATED,
  type Json,
  dir,
  useExitReaderStore,
  event,
  row,
  write,
  read,
  present,
  transcript,
} from '../_helpers/delivery-exit-reader.js';

useExitReaderStore();

describe('every ledger value, on rows from the real writer', () => {
  it('R1 every stage and every reject reason on a rejected row is copied verbatim', () => {
    const cases = STAGES.flatMap((stage) => REASONS.map((reason) => ({ stage, reason })));
    cases.forEach(({ stage, reason }, i) => {
      write(
        event(`r1-${i}`, {
          emittedCount: 0,
          rejectedCount: 1,
          candidates: [row(`mem_${i}`, { stage, reason, outcome: 'rejected', rank: null })],
        }),
      );
    });
    expect(cases).toHaveLength(42);
    cases.forEach(({ stage, reason }, i) => {
      const v = read(`r1-${i}`, `mem_${i}`);
      expect([v.class, v.stage, v.cand_reason, v.reason]).toEqual(['rejected', stage, reason, reason]);
    });
  });

  it('R2 every block state maps per the table', () => {
    const m = present();
    write(event('r2-sent', { candidates: [row(m.id)] }));
    write(event('r2-reused', { blockState: 'reused', candidates: [row(m.id, { outcome: 'reused' })] }));
    write(event('r2-mixed', { blockState: 'reused-recall-sent', candidates: [row(m.id, { outcome: 'reused' })] }));
    write(event('r2-empty', { blockState: 'empty', consideredCount: 0, selectedCount: 0, emittedCount: 0 }));
    write(event('r2-disabled', { blockState: 'disabled', consideredCount: 0, selectedCount: 0, emittedCount: 0 }));
    const got = ['sent', 'reused', 'mixed', 'empty', 'disabled'].map((s) => {
      const v = read(`r2-${s}`, m.id);
      return [v.class, v.reason];
    });
    expect(got).toEqual([
      ['delivery-unconfirmed', 'no-transcript'],
      ['delivery-unconfirmed', 'no-original'],
      ['delivery-unconfirmed', 'no-original'],
      ['not-retrieved', 'not-loaded'],
      ['rejected', 'block-disabled'],
    ]);
  });

  it('R3 a context row with no target row is indeterminate context-surface, and a rejected one is rejected', () => {
    const m = present();
    write(event('r3', { eventType: 'context', surface: 'context', promptHash: null, candidates: [] }));
    expect(read('r3', m.id)).toMatchObject({ class: 'indeterminate', reason: 'context-surface' });
    write(
      event('r3b', {
        eventType: 'context',
        surface: 'context',
        promptHash: null,
        emittedCount: 0,
        rejectedCount: 1,
        candidates: [row(m.id, { outcome: 'rejected', stage: 'limit', reason: 'limit', rank: null })],
      }),
    );
    expect(read('r3b', m.id)).toMatchObject({ class: 'rejected', reason: 'limit' });
  });
});

describe('defensive reuse arms', () => {
  it('R4 a compaction row between a send and a reuse leaves the reuse unconfirmed compacted-since-send', () => {
    const m = present();
    const first = write(event('r4', { emittedHash: blockHash('the block'), candidates: [row(m.id)] }));
    write(
      event('r4', { eventType: 'pre-compact', promptHash: null, candidates: [], selectedCount: 0, emittedCount: 0 }),
    );
    const third = write(event('r4', { blockState: 'reused', candidates: [row(m.id, { outcome: 'reused' })] }));
    const v = read('r4', m.id);
    expect(v.notes.some((n: string) => n.startsWith('pre-compact:'))).toBe(true);
    expect([v.turns.map((t) => t.event_id), v.turns[1].why, v.turns[1].delivery]).toEqual([
      [first, third],
      'compacted-since-send',
      'unconfirmed',
    ]);
  });

  it('R5 a numbered reused row whose duplicate was sent and emitted the target is confirmed through the duplicate', () => {
    const m = present();
    const block = 'the block both parallel fires carried';
    const promptHash = blockHash('one prompt fired twice');
    const t = Date.parse('2026-10-02T00:00:00.000Z');
    const a = write(
      event('r5', {
        ts: new Date(t).toISOString(),
        promptHash,
        blockState: 'reused',
        candidates: [row(m.id, { outcome: 'reused' })],
      }),
    );
    const b = write(
      event('r5', {
        ts: new Date(t + 500).toISOString(),
        promptHash,
        emittedHash: blockHash(block),
        candidates: [row(m.id)],
      }),
    );
    const check = new DatabaseSync(path.join(dir, 'hippo.db'), { readOnly: true });
    const rows = check.prepare('SELECT id, turn_seq, duplicate_of FROM delivery_events ORDER BY id').all();
    check.close();
    expect(rows.map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([
      [a, 1, null],
      [b, null, a],
    ]);
    const v = read('r5', m.id, { transcript: transcript([{ prompt: 'one prompt fired twice', attach: block }]) });
    expect([v.class, v.turns[0].duplicates, v.turns[0].delivery]).toEqual(['application-unknown', [b], 'confirmed']);
  });

  it('R17 a recall-only attachment does not confirm a pin whose duplicate row printed the full block', () => {
    const m = present();
    const promptHash = blockHash('one prompt fired twice');
    const t = Date.parse('2026-10-02T00:00:00.000Z');
    const a = write(
      event('r17', {
        ts: new Date(t).toISOString(),
        promptHash,
        blockState: 'reused-recall-sent',
        emittedHash: blockHash('the recall block'),
        candidates: [row(m.id, { outcome: 'reused' })],
      }),
    );
    const b = write(
      event('r17', {
        ts: new Date(t + 500).toISOString(),
        promptHash,
        emittedHash: blockHash('the full block'),
        candidates: [row(m.id)],
      }),
    );
    const check = new DatabaseSync(path.join(dir, 'hippo.db'), { readOnly: true });
    const rows = check.prepare('SELECT id, turn_seq, duplicate_of FROM delivery_events ORDER BY id').all();
    check.close();
    expect(rows.map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([
      [a, 1, null],
      [b, null, a],
    ]);
    const v = read('r17', m.id, {
      transcript: transcript([{ prompt: 'one prompt fired twice', attach: 'the recall block' }]),
    });
    expect([v.class, v.reason, v.turns[0].delivery, v.turns[0].why]).toEqual([
      'delivery-unconfirmed',
      'no-attachment',
      'unconfirmed',
      'no-attachment',
    ]);
  });

  it('R6 a reused turn whose latest send had another static hash has no original', () => {
    const m = present();
    write(
      event('r6', { staticHash: 'bbbbbbbbbbbbbbbb', emittedHash: blockHash('old block'), candidates: [row(m.id)] }),
    );
    const second = write(event('r6', { blockState: 'reused', candidates: [row(m.id, { outcome: 'reused' })] }));
    const v = read('r6', m.id);
    expect([v.turns[1].event_id, v.turns[1].why]).toEqual([second, 'no-original']);
  });
});

describe('fold edge cases', () => {
  it('R7 only range turns fold to indeterminate, and a valid label on them is unused', () => {
    const m = present();
    write(event('r7', { candidates: [], selectedCount: 0, emittedCount: 0, rejectedCount: 3, rejectedUnlisted: 3 }));
    const label = {
      session_id: 'r7',
      memory_id: m.id,
      application: 'observed',
      signal: 'resolved-check',
      evidence: 'a passing run',
    };
    const v = read('r7', m.id, { labels: [label] });
    expect([v.class, v.reason, v.notes]).toEqual(['indeterminate', 'undecided', ['label-unused']]);
  });

  it('R8 a store without the ledger table is indeterminate no-ledger-table', () => {
    const bare = path.join(dir, 'bare');
    fs.mkdirSync(bare);
    const db = new DatabaseSync(path.join(bare, 'hippo.db'));
    db.exec('CREATE TABLE memories (id TEXT)');
    db.close();
    const v = verdictOf({ store: bare, session: 's', memory: 'mem_x' });
    expect([v.class, v.reason, v.memory_id]).toEqual(['indeterminate', 'no-ledger-table', 'mem_x']);
  });

  it('R9 a key two memories hold is indeterminate key-ambiguous', () => {
    seed(dir, 'the shared phrase appears in the first lesson', { created: CREATED });
    seed(dir, 'the shared phrase appears in the second lesson', { created: CREATED });
    write(event('r9', { candidates: [] }));
    const v = verdictOf({ store: dir, session: 'r9', key: 'shared phrase' });
    expect([v.class, v.reason, v.memory_id]).toEqual(['indeterminate', 'key-ambiguous', null]);
  });

  it('R10 a memory forgotten after the first turn is indeterminate forgotten', () => {
    const m = present();
    write(event('r10', { candidates: [], selectedCount: 0, emittedCount: 0 }));
    expect(deleteEntry(dir, m.id)).toBe(true);
    const v = read('r10', m.id);
    expect([v.class, v.reason]).toEqual(['indeterminate', 'forgotten']);
  });

  it('R10b a memory forgotten in a session with no rows is indeterminate forgotten, not not-written', () => {
    const m = present();
    expect(deleteEntry(dir, m.id)).toBe(true);
    const v = read('r10b', m.id);
    expect([v.class, v.reason, v.turn]).toEqual(['indeterminate', 'forgotten', null]);
  });

  it('R19 a memory with no row, no forget row and a trace in another session is indeterminate forgotten', () => {
    write(event('r19-other', { candidates: [row('mem_gone')] }));
    write(event('r19', { candidates: [], selectedCount: 0, emittedCount: 0 }));
    const v = read('r19', 'mem_gone');
    expect([v.class, v.reason]).toEqual(['indeterminate', 'forgotten']);
  });

  it('R24 a disabled turn before the lesson was written is not-written, and after it is rejected', () => {
    const ts = new Date('2026-10-02T00:00:00.000Z');
    const id = write(
      event('r24', {
        ts: ts.toISOString(),
        blockState: 'disabled',
        consideredCount: 0,
        selectedCount: 0,
        emittedCount: 0,
      }),
    );
    const later = seed(dir, 'a lesson written a minute after the disabled turn', {
      created: new Date(ts.getTime() + 60_000).toISOString(),
    });
    const earlier = seed(dir, 'a lesson written a minute before the disabled turn', {
      created: new Date(ts.getTime() - 60_000).toISOString(),
    });
    const after = read('r24', later.id);
    expect([after.class, after.reason, after.turns[0].event_id]).toEqual(['not-written', 'written-after', id]);
    const before = read('r24', earlier.id);
    expect([before.class, before.reason, before.turns[0].event_id]).toEqual(['rejected', 'block-disabled', id]);
  });

  it('R30 a shared copy with no remember row has no presence time, so a turn with no candidate row is indeterminate presence-unknown', () => {
    const copy = {
      ...createMemory('a lesson copied in without an audit row', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      created: CREATED,
      source: 'shared:elsewhere:2026-10-05T00:00:00.000Z',
    };
    const db = openHippoDb(dir);
    try {
      upsertEntryRow(db, copy);
    } finally {
      closeHippoDb(db);
    }
    write(event('r30', { candidates: [], selectedCount: 0, emittedCount: 0 }));
    const v = read('r30', copy.id);
    expect([v.class, v.reason, v.turns[0].range]).toEqual([
      'indeterminate',
      'presence-unknown',
      ['not-written', 'not-retrieved'],
    ]);
  });

  it('R31 a lesson in no store and no candidate row is indeterminate global-unread when the global store was skipped, and not-written when it was read', () => {
    write(event('r31', { candidates: [], selectedCount: 0, emittedCount: 0 }));
    expect(read('r31', 'mem_nowhere', { global: false })).toMatchObject({
      class: 'indeterminate',
      reason: 'global-unread',
    });
    const g = path.join(dir, 'g31');
    fs.mkdirSync(g);
    initTestStore(g);
    expect(read('r31', 'mem_nowhere', { global: g })).toMatchObject({ class: 'not-written', reason: 'no-row' });
  });

  it('R25 a reuse after a group whose sent row was a duplicate is confirmed through that group', () => {
    const m = present();
    const block = 'the block the duplicate row sent';
    const promptHash = blockHash('prompt a');
    const t = Date.parse('2026-10-02T00:00:00.000Z');
    const a = write(
      event('r25', {
        ts: new Date(t).toISOString(),
        promptHash,
        blockState: 'reused',
        candidates: [row(m.id, { outcome: 'reused' })],
      }),
    );
    const a2 = write(
      event('r25', {
        ts: new Date(t + 500).toISOString(),
        promptHash,
        emittedHash: blockHash(block),
        candidates: [row(m.id)],
      }),
    );
    const c = write(
      event('r25', {
        ts: new Date(t + 5_000).toISOString(),
        promptHash: blockHash('prompt c'),
        blockState: 'reused',
        candidates: [row(m.id, { outcome: 'reused' })],
      }),
    );
    const check = new DatabaseSync(path.join(dir, 'hippo.db'), { readOnly: true });
    const rows = check.prepare('SELECT id, turn_seq, duplicate_of FROM delivery_events ORDER BY id').all();
    check.close();
    expect(rows.map((r) => [r.id, r.turn_seq !== null, r.duplicate_of])).toEqual([
      [a, true, null],
      [a2, false, a],
      [c, true, null],
    ]);
    const v = read('r25', m.id, {
      transcript: transcript([{ prompt: 'prompt a', attach: block }, { prompt: 'prompt c' }]),
    });
    expect([v.class, v.turns[1].event_id, v.turns[1].delivery, v.turns[1].via_event_id]).toEqual([
      'application-unknown',
      c,
      'confirmed',
      a,
    ]);
  });

  it('R20 a valid label on a not-written or key-ambiguous read is noted, not applied', () => {
    const label = {
      session_id: 'r20',
      memory_id: 'mem_never',
      application: 'observed',
      signal: 'resolved-check',
      evidence: 'a passing run',
    };
    const never = read('r20', 'mem_never', { labels: [label], global: path.join(dir, 'no-global') });
    expect([never.class, never.reason, never.notes, never.label]).toEqual([
      'not-written',
      'no-row',
      ['label-conflict'],
      null,
    ]);
    const first = seed(dir, 'the shared phrase appears in the first lesson', { created: CREATED });
    seed(dir, 'the shared phrase appears in the second lesson', { created: CREATED });
    const amb = verdictOf({
      store: dir,
      session: 'r20',
      key: 'shared phrase',
      labels: [{ ...label, memory_id: first.id }],
    });
    expect([amb.class, amb.reason, amb.notes]).toEqual(['indeterminate', 'key-ambiguous', ['label-unused']]);
  });

  it('R21 a row from another store and its duplicate are both noted as dropped', () => {
    const m = present();
    const promptHash = blockHash('one prompt fired twice');
    const t = Date.parse('2026-10-02T00:00:00.000Z');
    const a = write(
      event('r21', {
        ts: new Date(t).toISOString(),
        promptHash,
        storeHash: 'aaaaaaaaaaaaaaaa',
        candidates: [row(m.id)],
      }),
    );
    const b = write(event('r21', { ts: new Date(t + 500).toISOString(), promptHash, candidates: [row(m.id)] }));
    const check = new DatabaseSync(path.join(dir, 'hippo.db'), { readOnly: true });
    const rows = check.prepare('SELECT id, turn_seq, duplicate_of FROM delivery_events ORDER BY id').all();
    check.close();
    expect(rows.map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([
      [a, 1, null],
      [b, null, a],
    ]);
    const v = read('r21', m.id);
    expect(v.notes).toEqual([`foreign-store:${a}`, `orphan-duplicate:${b}`]);
  });

  it('R23 a duplicate of a row that is not a main row is noted (the writer cannot produce the pair, so one UPDATE unnumbers the original)', () => {
    const m = present();
    const promptHash = blockHash('one prompt fired twice');
    const t = Date.parse('2026-10-02T00:00:00.000Z');
    const a = write(event('r23', { ts: new Date(t).toISOString(), promptHash, candidates: [row(m.id)] }));
    const b = write(event('r23', { ts: new Date(t + 500).toISOString(), promptHash, candidates: [row(m.id)] }));
    const db = new DatabaseSync(path.join(dir, 'hippo.db'));
    const raw = () =>
      db
        .prepare('SELECT id, turn_seq, duplicate_of, session_state FROM delivery_events ORDER BY id')
        .all()
        .map((r) => [r.id, r.turn_seq, r.duplicate_of, r.session_state]);
    expect(raw()).toEqual([
      [a, 1, null, 'payload'],
      [b, null, a, 'payload'],
    ]);
    db.prepare('UPDATE delivery_events SET turn_seq = NULL WHERE id = ?').run(a);
    expect(raw()).toEqual([
      [a, null, null, 'payload'],
      [b, null, a, 'payload'],
    ]);
    db.close();
    expect(read('r23', m.id).notes).toEqual([`unnumbered:${a}`, `orphan-duplicate:${b}`]);
  });

  it('R11 label validation: bad fields, other sessions and duplicates', () => {
    const m = present();
    const block = 'the block that was sent';
    write(event('r11', { emittedHash: blockHash(block), promptHash: blockHash('a prompt'), candidates: [row(m.id)] }));
    const t = transcript([{ prompt: 'a prompt', attach: block }]);
    const ok = {
      session_id: 'r11',
      memory_id: m.id,
      application: 'observed',
      signal: 'revert',
      evidence: 'git revert abc',
    };
    const run = (labels: Json[]) => read('r11', m.id, { transcript: t, labels });
    for (const signal of ['failed-check', 'explicit-correction', 'revert', 'repeated-error']) {
      expect(run([{ ...ok, signal }])).toMatchObject({ class: 'applied-but-wrong', label: { signal } });
    }
    expect(run([{ ...ok, signal: 'guess' }])).toMatchObject({
      class: 'application-unknown',
      notes: ['label-error:signal'],
      label: null,
    });
    expect(run([{ ...ok, evidence: '  ' }]).notes).toEqual(['label-error:evidence']);
    expect(
      run([
        { ...ok, session_id: 'other' },
        { ...ok, memory_id: 'other' },
      ]),
    ).toMatchObject({ class: 'application-unknown', notes: [] });
    expect(run([ok, { ...ok, signal: 'failed-check' }])).toMatchObject({
      class: 'application-unknown',
      notes: ['label-error:duplicate'],
      label: null,
    });
    expect(run([{ ...ok, application: 'unknown', signal: 'unknown', evidence: '' }]).class).toBe('application-unknown');
    expect(run([ok]).class).toBe('applied-but-wrong');
  });
});
