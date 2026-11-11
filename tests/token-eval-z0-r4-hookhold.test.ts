// Round 4 prereg item 9 (Amendment B): the hook hold rule and the sensitivity drop list, from transcripts under round 3 and from `hookCancels` under round 4.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../scripts/token-eval/z0-hookhold.mjs';
import { cleanup, tmp } from './fixtures/z0-harness.js';

interface Rec { kind: string; arm: string; sessionId: string | null; startedAt?: string; sequence: string; seed: number; position: number; hookCancels?: Record<string, number> }
const at = (i: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();
const rec = (i: number, extra: Partial<Rec> = {}): Rec => ({ kind: 'apply', arm: 'S2', sessionId: `s${i}`, startedAt: at(i), sequence: 'rn-q1', seed: 1, position: i, hookCancels: {}, ...extra });
const cancelled = { UserPromptSubmit: 1 };
const write = (file: string, recs: Rec[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recs.map((r) => `${JSON.stringify(r)}\n`).join(''));
  return file;
};
const folder = () => tmp('z0-hookhold-');
const hold = (design: string, ...files: string[]) => runCli(['--design', design, ...(design === 'r4' ? files.flatMap((f) => ['--runs', f]) : files.flatMap((f) => ['--run', f])), '--hold']);

describe('z0-hookhold under round 4: hookCancels on the S2 and S5 apply sessions', () => {
  afterEach(cleanup);
  const fifty = (cancels: number[], arm = 'S2') => Array.from({ length: 50 }, (_, i) => rec(i, { arm, hookCancels: cancels.includes(i) ? cancelled : {} }));

  it('prints ok 1 of 50 at 2% and hold 2 of 50 above it', () => {
    const dir = folder();
    expect(hold('r4', write(path.join(dir, 'a.jsonl'), fifty([7])))).toMatchObject({ code: 0, stdout: 'ok 1 of 50\n' });
    expect(hold('r4', write(path.join(dir, 'b.jsonl'), fifty([7, 30])))).toMatchObject({ code: 0, stdout: 'hold 2 of 50\n' });
    expect(hold('r4', write(path.join(dir, 'c.jsonl'), fifty([])))).toMatchObject({ stdout: 'ok 0 of 50\n' });
  });

  it('counts only the last 50 by startedAt, whatever the line order, and only S2 and S5 apply sessions with a session id', () => {
    const dir = folder();
    const older = Array.from({ length: 10 }, (_, i) => rec(100 + i, { startedAt: at(i), hookCancels: cancelled }));
    const recent = fifty([]).map((r) => ({ ...r, startedAt: at(1000 + r.position) }));
    const ignored = [rec(1, { arm: 'S1', hookCancels: cancelled, startedAt: at(5000) }), rec(2, { kind: 'teach', hookCancels: cancelled, startedAt: at(5001) }), rec(3, { sessionId: null, hookCancels: cancelled, startedAt: at(5002) })];
    const file = write(path.join(dir, 'runs.jsonl'), [...recent.reverse(), ...ignored, ...older]);
    expect(hold('r4', file)).toMatchObject({ stdout: 'ok 0 of 50\n' });
    const half = fifty([]).map((r, i) => ({ ...r, arm: i % 2 ? 'S5' : 'S2', hookCancels: i === 49 ? cancelled : {} }));
    expect(hold('r4', write(path.join(dir, 'both.jsonl'), half))).toMatchObject({ stdout: 'ok 1 of 50\n' });
  });

  it('orders records with no startedAt by file mtime and then line, across files', () => {
    const dir = folder();
    const bare = (recs: Rec[]): Rec[] => recs.map((r) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'startedAt' ? undefined : v))));
    const early = write(path.join(dir, 'early.jsonl'), bare(Array.from({ length: 10 }, (_, i) => rec(i, { hookCancels: cancelled }))));
    const late = write(path.join(dir, 'late.jsonl'), bare(fifty([])));
    fs.utimesSync(early, new Date(2026, 0, 1), new Date(2026, 0, 1));
    fs.utimesSync(late, new Date(2026, 0, 2), new Date(2026, 0, 2));
    expect(hold('r4', early, late)).toMatchObject({ stdout: 'ok 0 of 50\n' });
    fs.utimesSync(early, new Date(2026, 0, 3), new Date(2026, 0, 3));
    expect(hold('r4', early, late)).toMatchObject({ stdout: 'hold 10 of 50\n' });
  });

  it('writes the drop list from S2 and S5 positions only, so a cancelled hook on S1 voids nothing, and prints no arm', () => {
    const dir = folder();
    const out = path.join(dir, 'hook.json');
    const file = write(path.join(dir, 'runs.jsonl'), [
      rec(1, { arm: 'S1', hookCancels: cancelled, position: 1 }),
      rec(2, { arm: 'S2', hookCancels: cancelled, position: 2 }),
      rec(3, { arm: 'S5', hookCancels: cancelled, position: 2 }),
      rec(4, { arm: 'S2', hookCancels: cancelled, kind: 'teach', position: 4, seed: 2 }),
      rec(5, { arm: 'S5', position: 5 }),
    ]);
    const result = runCli(['--design', 'r4', '--runs', file, '--sensitivity', out]);
    expect(result).toMatchObject({ code: 0, stdout: '4 sessions, 2 positions dropped\n' });
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual({
      droppedLessons: [], droppedFamilies: [], hookVoids: [{ sequence: 'rn-q1', seed: 1, position: 2 }, { sequence: 'rn-q1', seed: 2, position: 4 }],
    });
    expect(result.stdout).not.toMatch(/S[0-9]/);
  });

  it('lists the drop list in file and line order whatever the startedAt order, as r3-sensitivity.py does', () => {
    const dir = folder();
    const out = path.join(dir, 'hook.json');
    const file = write(path.join(dir, 'runs.jsonl'), [rec(1, { position: 9, hookCancels: cancelled, startedAt: at(900) }), rec(2, { position: 3, hookCancels: cancelled, startedAt: at(100) })]);
    runCli(['--design', 'r4', '--runs', file, '--sensitivity', out]);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).hookVoids.map((v: { position: number }) => v.position)).toEqual([9, 3]);
  });

  it('writes an empty hookVoids when no session lost its hook', () => {
    const dir = folder();
    const out = path.join(dir, 'hook.json');
    runCli(['--design', 'r4', '--runs', write(path.join(dir, 'runs.jsonl'), fifty([])), '--sensitivity', out]);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).hookVoids).toEqual([]);
  });

  it('exits 1 with its usage on the wrong source for the design, both sources, neither mode and both modes', () => {
    const dir = folder();
    const file = write(path.join(dir, 'runs.jsonl'), fifty([]));
    for (const argv of [['--design', 'r4', '--run', dir, '--hold'], ['--design', 'r3', '--runs', file, '--hold'], ['--design', 'r4', '--runs', file, '--run', dir, '--hold'],
      ['--design', 'r4', '--runs', file], ['--design', 'r4', '--runs', file, '--hold', '--sensitivity', path.join(dir, 'x.json')], ['--runs', file, '--hold']]) {
      expect(runCli(argv), argv.join(' ')).toMatchObject({ code: 1, stderr: expect.stringContaining('usage:') });
    }
  });
});

/** A round 3 out folder: runs.jsonl and one transcript per session under claude-config, as the runner lays them out. */
function transcripts(sessions: { rec: Rec; lines: object[] | null }[]) {
  const out = folder();
  write(path.join(out, 'runs.jsonl'), sessions.map((s) => s.rec));
  for (const { rec: r, lines } of sessions) {
    if (lines === null) continue;
    const file = path.join(out, 'runs', r.sequence, r.arm, `seed${r.seed}`, 'claude-config', 'projects', 'proj', `${r.sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  }
  return out;
}
const attach = (type: string, event: string, key: 'hookEvent' | 'hookName' = 'hookEvent') => ({ type: 'attachment', attachment: { type, [key]: event } });

describe('z0-hookhold under round 3: the hook state in each session\'s transcript', () => {
  afterEach(cleanup);
  const session = (i: number, lines: object[], extra: Partial<Rec> = {}) => ({ rec: rec(i, { arm: 'A2', ...extra }), lines });
  const filler = (n: number) => Array.from({ length: n }, (_, i) => session(100 + i, [attach('hook_success', 'UserPromptSubmit')]));

  it('holds at two of 50 and not at one, reading the first prompt-hook attachment of each session', () => {
    const out = transcripts([session(0, [attach('hook_cancelled', 'UserPromptSubmit')]), ...filler(49)]);
    expect(hold('r3', out)).toMatchObject({ stdout: 'ok 1 of 50\n' });
    const two = transcripts([session(0, [attach('hook_cancelled', 'UserPromptSubmit')]), session(1, [attach('hook_cancelled', 'UserPromptSubmit', 'hookName')]), ...filler(48)]);
    expect(hold('r3', two)).toMatchObject({ stdout: 'hold 2 of 50\n' });
  });

  it('counts a cancelled hook of another event as no loss, and a delivered hook followed by a cancelled one as delivered for the hold rule', () => {
    const out = transcripts([session(0, [attach('hook_cancelled', 'SessionStart')]), session(1, [attach('hook_success', 'UserPromptSubmit'), attach('hook_cancelled', 'UserPromptSubmit')]), session(2, [{ note: 'UserPromptSubmit but not an attachment' }]), ...filler(47)]);
    expect(hold('r3', out)).toMatchObject({ stdout: 'ok 0 of 50\n' });
  });

  it('skips an A1 session, and counts a session with no transcript as a session that lost nothing', () => {
    const out = transcripts([session(0, [attach('hook_cancelled', 'UserPromptSubmit')], { arm: 'A1' }), ...filler(49), { rec: rec(1, { arm: 'A5' }), lines: null }]);
    expect(hold('r3', out)).toMatchObject({ stdout: 'ok 0 of 50\n' });
  });

  it('writes the sensitivity list from any cancelled prompt hook of an A2 or A5 session, teach sessions included, in folder and line order', () => {
    const first = transcripts([
      session(1, [attach('hook_success', 'UserPromptSubmit'), attach('hook_cancelled', 'UserPromptSubmit')], { kind: 'teach', position: 1 }),
      session(2, [attach('hook_cancelled', 'UserPromptSubmit', 'hookName')], { arm: 'A5', position: 2 }),
      session(3, [attach('hook_cancelled', 'SessionStart')], { position: 3 }),
      session(4, [attach('hook_cancelled', 'UserPromptSubmit')], { arm: 'A1', position: 4 }),
    ]);
    const second = transcripts([session(5, [attach('hook_cancelled', 'UserPromptSubmit')], { position: 2, sequence: 'rn-q2' }), session(6, [attach('hook_cancelled', 'UserPromptSubmit')], { arm: 'A5', position: 1 })]);
    const out = path.join(folder(), 'hook.json');
    const result = runCli(['--design', 'r3', '--run', first, '--run', second, '--sensitivity', out]);
    expect(result).toMatchObject({ code: 0, stdout: '5 sessions, 3 positions dropped\n' });
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).hookVoids).toEqual([
      { sequence: 'rn-q1', seed: 1, position: 1 }, { sequence: 'rn-q1', seed: 1, position: 2 }, { sequence: 'rn-q2', seed: 1, position: 2 },
    ]);
  });
});
