// The delivery reader against host transcripts: a lesson copied to the global store, prompt pairing and the transcript parser.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { blockHash } from '../../src/base/util/token-text.js';
import { seed, verdictOf, type Verdict } from '../_helpers/host-transcript.js';
import { dispose, hippo, project, type Project } from '../_helpers/delivery-boundary.js';
import { fire } from '../_helpers/host-transcript.js';
import { parseTranscript } from '../../scripts/z10/transcript.mjs';
import {
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

describe('a lesson copied to the global store', () => {
  let p: Project;
  afterEach(() => dispose(p));

  it('R29 a lesson shared after the turn keeps its old created time, and the copy still reads not-written written-after', () => {
    p = project();
    const note = 'office note: the coffee machine schedule changes for team lunch on friday';
    const target = seed(p.hippoRoot, `${note} oldest`, { created: '2026-05-01T00:00:00.000Z' });
    for (let i = 0; i < 6; i++) seed(p.hippoRoot, `${note} ${i}`, { created: `2026-06-0${i + 1}T00:00:00.000Z` });
    fire(p, 'r29', 'first question about deploys');
    const shared = hippo(p, ['share', target.id, '--force']);
    expect(shared.status, shared.stderr).toBe(0);
    const copyId = /Shared \[(\S+)\] to global store\./.exec(shared.stdout)?.[1] ?? '';
    expect(copyId).not.toBe('');
    const db = new DatabaseSync(path.join(p.globalRoot, 'hippo.db'), { readOnly: true });
    const raw = db.prepare('SELECT created, source FROM memories WHERE id = ?').get(copyId);
    db.close();
    expect([raw?.created, String(raw?.source).startsWith('shared:')]).toEqual([target.created, true]);
    const v = verdictOf({ store: p.hippoRoot, session: 'r29', memory: copyId, global: p.globalRoot });
    expect([v.class, v.reason, v.memory_store, v.turns.map((t) => t.cand_reason)]).toEqual([
      'not-written',
      'written-after',
      'global',
      [null],
    ]);
  });
});

describe('pairing', () => {
  it('R18 transcript lines of another session are skipped and counted, and lines of this session pair', () => {
    const m = present();
    const block = 'the block that was sent';
    write(event('r18', { promptHash: blockHash('a prompt'), emittedHash: blockHash(block), candidates: [row(m.id)] }));
    const lines = (sessionId: string) => {
      const user = JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: 'a prompt' } });
      const hook = JSON.stringify({
        type: 'attachment',
        sessionId,
        attachment: {
          type: 'hook_additional_context',
          content: [block],
          hookName: 'UserPromptSubmit',
          hookEvent: 'UserPromptSubmit',
        },
      });
      return `${user}
${hook}
`;
    };
    const file = (name: string, sessionId: string): string => {
      const f = path.join(dir, `${name}.jsonl`);
      fs.writeFileSync(f, lines(sessionId));
      return f;
    };
    const foreign = read('r18', m.id, { transcript: file('foreign', 'someone-else') });
    expect([foreign.class, foreign.notes]).toEqual(['delivery-unconfirmed', ['transcript-foreign-lines:2']]);
    expect(foreign.turns[0].delivery).toBe('unconfirmed');
    const own = read('r18', m.id, { transcript: file('own', 'r18') });
    expect([own.class, own.notes, own.turns[0].delivery]).toEqual(['application-unknown', [], 'confirmed']);
  });

  it('R22 torn and non-object transcript lines are skipped and noted, and a torn attachment reads unconfirmed', () => {
    const m = present();
    const block = 'the block that was sent';
    write(event('r22', { promptHash: blockHash('a prompt'), emittedHash: blockHash(block), candidates: [row(m.id)] }));
    const user = JSON.stringify({ type: 'user', message: { role: 'user', content: 'a prompt' } });
    const hook = JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'hook_additional_context',
        content: [block],
        hookName: 'UserPromptSubmit',
        hookEvent: 'UserPromptSubmit',
      },
    });
    const file = (name: string, ...lines: string[]): string => {
      const f = path.join(dir, `${name}.jsonl`);
      fs.writeFileSync(f, `${lines.join('\n')}\n`);
      return f;
    };
    const fields = (v: Verdict) => [v.class, v.turn, v.turns[0].delivery];
    const clean = read('r22', m.id, { transcript: file('clean', user, hook) });
    expect(clean.class).toBe('application-unknown');
    expect(clean.notes.some((n: string) => n.startsWith('transcript-skipped-lines'))).toBe(false);
    const noisy = read('r22', m.id, { transcript: file('noisy', '{"type":"user",', user, 'null', hook) });
    expect(fields(noisy)).toEqual(fields(clean));
    expect(noisy.notes).toContain('transcript-skipped-lines:2');
    const torn = read('r22', m.id, { transcript: file('torn', user, hook.slice(0, hook.length / 2)) });
    expect(torn.class).toBe('delivery-unconfirmed');
    expect(torn.notes).toContain('transcript-skipped-lines:1');
  });

  it('R15 a sent turn whose prompt hash and attachment match no transcript prompt is delivery-unconfirmed no-paired-prompt', () => {
    const m = present();
    const block = 'the block that was sent';
    const id = write(
      event('r15', {
        promptHash: blockHash('the payload prompt'),
        emittedHash: blockHash(block),
        candidates: [row(m.id)],
      }),
    );
    const t = transcript([
      { prompt: 'a typed line one', fired: false },
      { prompt: 'a typed line two', fired: false },
    ]);
    const v = read('r15', m.id, { transcript: t });
    expect([
      v.class,
      v.reason,
      v.turn,
      v.turns[0].paired_by,
      v.notes.some((n: string) => n.startsWith('gap:')),
    ]).toEqual(['delivery-unconfirmed', 'no-paired-prompt', { event_id: id, turn_seq: 1 }, null, false]);
  });
});

describe('the transcript parser', () => {
  it('R12 every candidate kind, an image prompt, tool results, meta, summary and a compaction line', () => {
    const user = (content: string | Json[], extra: Json = {}) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
    const hook = (text: string, extra: Json = {}) =>
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'hook_additional_context',
          content: [text, 'second part'],
          hookName: 'UserPromptSubmit',
          hookEvent: 'UserPromptSubmit',
          ...extra,
        },
      });
    const lines = [
      user('<command-name>/clear</command-name>'),
      user('<local-command-stdout>ok</local-command-stdout>'),
      user('<local-command-caveat>x</local-command-caveat>'),
      user('<bash-input>ls</bash-input>'),
      user('<bash-stdout>a</bash-stdout>'),
      user('<bash-stderr>b</bash-stderr>'),
      user('<task-notification>done</task-notification>'),
      user('a plain prompt'),
      hook('hippo block'),
      hook('other event', { hookEvent: 'SessionStart' }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'file' } }),
      user('meta line', { isMeta: true }),
      user('summary line', { isCompactSummary: true }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
      user([{ type: 'tool_result', tool_use_id: 't', content: 'out' }]),
      user([
        { type: 'text', text: 'see' },
        { type: 'text', text: 'this' },
        { type: 'image', source: {} },
      ]),
      user([{ type: 'image', source: {} }]),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
      'not json',
      '',
      user('after the compaction'),
    ];
    const parsed = parseTranscript(lines.join('\n'));
    expect(parsed.candidates.map((c: { kind: string }) => c.kind)).toEqual([
      'command-name',
      'local-command-stdout',
      'local-command-caveat',
      'bash-input',
      'bash-stdout',
      'bash-stderr',
      'task-notification',
      'prompt',
      'prompt',
      'prompt',
    ]);
    const [plain, image, after] = parsed.candidates.slice(7);
    expect([plain.attachments, plain.fired, image.text, image.image, after.fired]).toEqual([
      ['hippo block\nsecond part'],
      true,
      'see\nthis',
      true,
      false,
    ]);
    expect([parsed.compactions, parsed.skipped]).toEqual([[{ pos: 17 }], [18]]);
    expect(parsed.candidates.map((c: { queued: boolean }) => c.queued)).toEqual(Array(10).fill(false));
  });

  it('R16 a queued_command attachment is a candidate kinded by its text, and the hooks under it are its own', () => {
    const attach = (a: Json) => JSON.stringify({ type: 'attachment', attachment: a });
    const queued = (prompt: string | Json[], extra: Json = {}) =>
      attach({ type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' }, ...extra });
    const hook = (text: string) =>
      attach({
        type: 'hook_additional_context',
        content: [text],
        hookName: 'UserPromptSubmit',
        hookEvent: 'UserPromptSubmit',
      });
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'a typed prompt' } }),
      queued('<task-notification>done</task-notification>', { commandMode: 'task-notification' }),
      hook('h1'),
      queued('<cross-session-message from="x">hi</cross-session-message>'),
      hook('h2'),
      queued('<agent-message from="x">hi</agent-message>'),
      hook('h3'),
      queued('a plain human prompt'),
      hook('h4'),
      queued('ls', { commandMode: 'bash' }),
      queued([{ type: 'text', text: 'blocks prompt' }]),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<command-message>run the skill</command-message>' },
      }),
      hook('h5'),
    ];
    const { candidates } = parseTranscript(lines.join('\n'));
    expect(candidates.map((c: { kind: string }) => c.kind)).toEqual([
      'prompt',
      'task-notification',
      'cross-session-message',
      'agent-message',
      'prompt',
      'queued-bash',
      'prompt',
      'prompt',
    ]);
    expect(candidates.map((c: { queued: boolean }) => c.queued)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(candidates.map((c: { attachments: string[] }) => c.attachments)).toEqual([
      [],
      ['h1'],
      ['h2'],
      ['h3'],
      ['h4'],
      [],
      [],
      ['h5'],
    ]);
    expect(candidates[6].text).toBe('blocks prompt');
    expect([candidates[7].kind, candidates[7].fired]).toEqual(['prompt', true]);
  });
});
