// The Z10 reader on rows the real ledger writer built, plus the transcript parser and the CLI arguments.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { initStore } from '../src/store/open.js';
import { deleteEntry } from '../src/store/delete-and-batch.js';
import { writeDeliveryEventOnHandle } from '../src/store/recall-trace.js';
import type { DeliveryCandidateInput, DeliveryEventInput, DeliveryRejectReason, DeliveryStage } from '../src/store/delivery-recorder.js';
import { blockHash } from '../src/util/token-text.js';
import type { JsonValue } from '../src/util/json.js';
import { seed, verdictOf, writeHostTranscript, type ReadOpts } from './_helpers/host-transcript.js';
import type { Project } from './_helpers/delivery-boundary.js';
import { parseTranscript } from '../scripts/z10/transcript.mjs';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'z10-reconstruct.mjs');
const STAGES: DeliveryStage[] = ['load', 'eligible', 'gate', 'budget', 'limit', 'final'];
const REASONS: DeliveryRejectReason[] = ['budget', 'gate-below-threshold', 'gate-max-items', 'duplicate', 'scope', 'quality', 'limit'];
const CREATED = '2026-09-01T00:00:00.000Z';
const STATIC = 'aaaaaaaaaaaaaaaa';

interface Json { [key: string]: JsonValue }

let dir: string;
let tick = 0;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-z10-reader-'));
  initStore(dir);
  tick = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Event inputs are 10 s apart so the writer's duplicate window never joins two of them. */
function event(session: string, o: Partial<DeliveryEventInput> = {}): DeliveryEventInput {
  tick += 1;
  return {
    ts: new Date(Date.parse('2026-10-01T00:00:00.000Z') + tick * 10_000).toISOString(), tenantId: 'default', runtime: 'claude-code',
    eventType: 'prompt-submit', surface: 'hook', storeHash: blockHash(path.resolve(dir)), writeStore: 'local', projectHash: null,
    sessionId: session, sessionState: 'payload', hostTurnId: null, promptHash: blockHash(`prompt ${tick}`), promptLength: 5, queryHash: null,
    recallTraceId: null, blockState: 'sent', promptRecall: false, consideredCount: 1, filteredCount: 0, selectedCount: 1, emittedCount: 1,
    rejectedCount: 0, rejectedUnlisted: 0, sectionsShown: 0, sectionsDropped: 0, budgetTokens: 1000, selectedTokens: 10, injectedTokens: 10,
    staticHash: STATIC, recallHash: null, emittedHash: null, elapsedMs: 1, candidates: [], ...o,
  };
}

const row = (memoryId: string, o: Partial<DeliveryCandidateInput> = {}): DeliveryCandidateInput => ({
  memoryId, sourceStore: 'local', pool: 'pin', stage: 'final', outcome: 'emitted', reason: null, rank: 1, score: 1, tokens: 10, ...o,
});

function write(input: DeliveryEventInput): number {
  const db = openHippoDb(dir);
  try {
    const id = writeDeliveryEventOnHandle(db, input);
    expect(id).not.toBeNull();
    return Number(id);
  } finally {
    closeHippoDb(db);
  }
}

const read = (session: string, memory: string, extra: ReadOpts = {}) => verdictOf({ store: dir, session, memory, ...extra });
const present = (content = 'a lesson that was written before every turn here') => seed(dir, content, { created: CREATED });
// SAFETY: writeHostTranscript reads only the project's dir.
const transcript = (specs: Parameters<typeof writeHostTranscript>[1]): string => writeHostTranscript({ dir } as Project, specs, { noise: false });

describe('every ledger value, on rows from the real writer', () => {
  it('R1 every stage and every reject reason on a rejected row is copied verbatim', () => {
    const cases = STAGES.flatMap((stage) => REASONS.map((reason) => ({ stage, reason })));
    cases.forEach(({ stage, reason }, i) => {
      write(event(`r1-${i}`, { emittedCount: 0, rejectedCount: 1, candidates: [row(`mem_${i}`, { stage, reason, outcome: 'rejected', rank: null })] }));
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
      ['delivery-unconfirmed', 'no-transcript'], ['delivery-unconfirmed', 'no-original'], ['delivery-unconfirmed', 'no-original'],
      ['not-retrieved', 'not-loaded'], ['rejected', 'block-disabled'],
    ]);
  });

  it('R3 a context row with no target row is indeterminate context-surface, and a rejected one is rejected', () => {
    const m = present();
    write(event('r3', { eventType: 'context', surface: 'context', promptHash: null, candidates: [] }));
    expect(read('r3', m.id)).toMatchObject({ class: 'indeterminate', reason: 'context-surface' });
    write(event('r3b', { eventType: 'context', surface: 'context', promptHash: null, emittedCount: 0, rejectedCount: 1, candidates: [row(m.id, { outcome: 'rejected', stage: 'limit', reason: 'limit', rank: null })] }));
    expect(read('r3b', m.id)).toMatchObject({ class: 'rejected', reason: 'limit' });
  });
});

describe('defensive reuse arms', () => {
  it('R4 a compaction row between a send and a reuse leaves the reuse unconfirmed compacted-since-send', () => {
    const m = present();
    const first = write(event('r4', { emittedHash: blockHash('the block'), candidates: [row(m.id)] }));
    write(event('r4', { eventType: 'pre-compact', promptHash: null, candidates: [], selectedCount: 0, emittedCount: 0 }));
    const third = write(event('r4', { blockState: 'reused', candidates: [row(m.id, { outcome: 'reused' })] }));
    const v = read('r4', m.id);
    expect(v.notes.some((n: string) => n.startsWith('pre-compact:'))).toBe(true);
    expect([v.turns.map((t) => t.event_id), v.turns[1].why, v.turns[1].delivery]).toEqual([[first, third], 'compacted-since-send', 'unconfirmed']);
  });

  it('R5 a numbered reused row whose duplicate was sent and emitted the target is confirmed through the duplicate', () => {
    const m = present();
    const block = 'the block both parallel fires carried';
    const promptHash = blockHash('one prompt fired twice');
    const t = Date.parse('2026-10-02T00:00:00.000Z');
    const a = write(event('r5', { ts: new Date(t).toISOString(), promptHash, blockState: 'reused', candidates: [row(m.id, { outcome: 'reused' })] }));
    const b = write(event('r5', { ts: new Date(t + 500).toISOString(), promptHash, emittedHash: blockHash(block), candidates: [row(m.id)] }));
    const check = new DatabaseSync(path.join(dir, 'hippo.db'), { readOnly: true });
    const rows = check.prepare('SELECT id, turn_seq, duplicate_of FROM delivery_events ORDER BY id').all();
    check.close();
    expect(rows.map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([[a, 1, null], [b, null, a]]);
    const v = read('r5', m.id, { transcript: transcript([{ prompt: 'one prompt fired twice', attach: block }]) });
    expect([v.class, v.turns[0].duplicates, v.turns[0].delivery]).toEqual(['application-unknown', [b], 'confirmed']);
  });

  it('R6 a reused turn whose latest send had another static hash has no original', () => {
    const m = present();
    write(event('r6', { staticHash: 'bbbbbbbbbbbbbbbb', emittedHash: blockHash('old block'), candidates: [row(m.id)] }));
    const second = write(event('r6', { blockState: 'reused', candidates: [row(m.id, { outcome: 'reused' })] }));
    const v = read('r6', m.id);
    expect([v.turns[1].event_id, v.turns[1].why]).toEqual([second, 'no-original']);
  });
});

describe('fold edge cases', () => {
  it('R7 only range turns fold to indeterminate, and a valid label on them is unused', () => {
    const m = present();
    write(event('r7', { candidates: [], selectedCount: 0, emittedCount: 0, rejectedCount: 3, rejectedUnlisted: 3 }));
    const label = { session_id: 'r7', memory_id: m.id, application: 'observed', signal: 'resolved-check', evidence: 'a passing run' };
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
    expect([v.class, v.reason]).toEqual(['indeterminate', 'no-ledger-table']);
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

  it('R11 label validation: bad fields, other sessions and duplicates', () => {
    const m = present();
    const block = 'the block that was sent';
    write(event('r11', { emittedHash: blockHash(block), promptHash: blockHash('a prompt'), candidates: [row(m.id)] }));
    const t = transcript([{ prompt: 'a prompt', attach: block }]);
    const ok = { session_id: 'r11', memory_id: m.id, application: 'observed', signal: 'revert', evidence: 'git revert abc' };
    const run = (labels: Json[]) => read('r11', m.id, { transcript: t, labels });
    expect(run([{ ...ok, signal: 'guess' }])).toMatchObject({ class: 'application-unknown', notes: ['label-error:signal'], label: null });
    expect(run([{ ...ok, evidence: '  ' }]).notes).toEqual(['label-error:evidence']);
    expect(run([{ ...ok, session_id: 'other' }, { ...ok, memory_id: 'other' }])).toMatchObject({ class: 'application-unknown', notes: [] });
    expect(run([ok, { ...ok, signal: 'failed-check' }])).toMatchObject({ class: 'application-unknown', notes: ['label-error:duplicate'], label: null });
    expect(run([{ ...ok, application: 'unknown', signal: 'unknown', evidence: '' }]).class).toBe('application-unknown');
    expect(run([ok]).class).toBe('applied-but-wrong');
  });
});

describe('the transcript parser', () => {
  it('R12 every candidate kind, an image prompt, tool results, meta, summary and a compaction line', () => {
    const user = (content: string | Json[], extra: Json = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
    const hook = (text: string, extra: Json = {}) => JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [text, 'second part'], hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', ...extra } });
    const lines = [
      user('<command-name>/clear</command-name>'), user('<local-command-stdout>ok</local-command-stdout>'), user('<local-command-caveat>x</local-command-caveat>'),
      user('<bash-input>ls</bash-input>'), user('<bash-stdout>a</bash-stdout>'), user('<bash-stderr>b</bash-stderr>'), user('<task-notification>done</task-notification>'),
      user('a plain prompt'), hook('hippo block'), hook('other event', { hookEvent: 'SessionStart' }), JSON.stringify({ type: 'attachment', attachment: { type: 'file' } }),
      user('meta line', { isMeta: true }), user('summary line', { isCompactSummary: true }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
      user([{ type: 'tool_result', tool_use_id: 't', content: 'out' }]), user([{ type: 'text', text: 'see' }, { type: 'text', text: 'this' }, { type: 'image', source: {} }]),
      user([{ type: 'image', source: {} }]), JSON.stringify({ type: 'system', subtype: 'compact_boundary' }), 'not json', '', user('after the compaction'),
    ];
    const parsed = parseTranscript(lines.join('\n'));
    expect(parsed.candidates.map((c: { kind: string }) => c.kind)).toEqual([
      'command-name', 'local-command-stdout', 'local-command-caveat', 'bash-input', 'bash-stdout', 'bash-stderr', 'task-notification', 'prompt', 'prompt', 'prompt',
    ]);
    const [plain, image, after] = parsed.candidates.slice(7);
    expect([plain.attachments, plain.fired, image.text, image.image, after.fired]).toEqual([['hippo block\nsecond part'], true, 'see\nthis', true, false]);
    expect([parsed.compactions, parsed.skipped]).toEqual([[{ pos: 17 }], [18]]);
  });
});

describe('the command line', () => {
  it('R13 the script prints the verdict the function returns', () => {
    const m = present();
    const block = 'the block that was sent';
    write(event('r13', { emittedHash: blockHash(block), promptHash: blockHash('a prompt'), candidates: [row(m.id)] }));
    const t = transcript([{ prompt: 'a prompt', attach: block }]);
    const r = spawnSync(process.execPath, [SCRIPT, '--store', dir, '--session', 'r13', '--memory', m.id, '--transcript', t, '--no-global'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(JSON.stringify(read('r13', m.id, { transcript: t }))));
    expect(JSON.parse(r.stdout).class).toBe('application-unknown');
  });

  it.each([
    ['no arguments', []],
    ['both a memory and a key', ['--store', 'x', '--session', 's', '--memory', 'a', '--key', 'b']],
    ['neither a memory nor a key', ['--store', 'x', '--session', 's']],
    ['an unknown flag', ['--store', 'x', '--session', 's', '--memory', 'a', '--bogus']],
    ['a flag with no value', ['--store', 'x', '--session', 's', '--memory']],
  ])('R14 %s exits 2 with usage on stderr', (_name, args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    expect([r.status, r.stdout, r.stderr.includes('usage:')]).toEqual([2, '', true]);
  });
});
