/** Z0 lesson reach read: tag classes, No-lead forms, nested-escape decoding, hook-block bounds, headroom, teach-form keys, the JSON shape and the errors it names. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { blocksHold, entryTags, flat, headroomOf, hookBlocksOf, ruleFormOf, ruleLinesOf, runCli, tagClass, teachFormIndex } from '../../scripts/token-eval/z0-reach.mjs';

const KEYS = ['grade', 'inputs', 'crossCheck', 'funnel', 'paired', 'blocks', 'rules', 'hippoReach', 'headroom', 'errors'];
const PHRASE = 'run uv run';
const BLOCK_TEXT = [
  'SessionStart hook additional context: ## Rules from the user',
  '- No: run uv run, because the maintainers require it',
  '- Keep lines short',
  '',
  '',
  '## Prompt-Relevant Memory (2 entries, 120 tokens)',
  '',
  '- **[observed] I fixed the parser.** [session-digest]',
  '- **[observed] Bash: Exit code 1** [auto-captured, error]',
  '',
  "Today's date is 2026-11-06.",
].join('\n');

interface Lesson { lessonId: string; first: 'pass' | 'fail' | 'na'; final: 'pass'; staleFollow: null }
interface Rec {
  schema: string; tool: string; repo: string; sequence: string; taskId: string; position: number; order: number; set: string; seed: number;
  arm: string; kind: 'teach' | 'apply'; familyId: string; lessonSource: string; applyIndex: number | null; afterReversal: boolean | null;
  tasksSinceTeach: number | null; lessons: Lesson[]; acceptancePassed: boolean; resolved: boolean; usage: Usage; turns: number; toolCalls: number;
  fileReads: number; wallMs: number; teachTurns: number; correctionTurns: number; invalid: null; timedOut: boolean; void: null; leak: boolean;
  limitRetries: number; carryUnionMerges: number; teachForm?: string; chain?: { stored: boolean; shown: boolean; followed: boolean; captured: boolean | null };
}
interface Usage { firstSession: Bucket; extra: Bucket }
interface Bucket { inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number }
interface Report {
  grade: string;
  errors: Record<string, string[]>;
  inputs: { records: number };
  funnel: { arms: Record<string, { n: number }> };
  rules: { allLessons: Record<string, Record<string, { lessons: number; failed: number }>>; byOwnTeachForm: Record<string, Record<string, { lessons: number }>> };
  hippoReach: { lessons: number; routes: Record<string, number> };
  blocks: { sessions: number; withBlock: number; entries: number; byClass: Record<string, { entries: number }> };
  headroom: { unit: string };
}
interface Options { teachForm?: string | null; withA5Log?: boolean; duplicateA2?: boolean; withPhrase?: boolean }

const bucket: Bucket = { inputTokens: 1, cacheWriteTokens: 1, cacheReadTokens: 1, outputTokens: 1 };

function rec(arm: string, kind: 'teach' | 'apply', position: number, extra: Partial<Rec> = {}): Rec {
  const apply = kind === 'apply';
  const r: Rec = {
    schema: 'z0-record/1', tool: 'claude-code', repo: 'r1', sequence: 'seq', taskId: `f1-${arm.toLowerCase()}-${kind}${position}`, position, order: position, set: 'R', seed: 1,
    arm, kind, familyId: 'f1', lessonSource: 'maintainer', applyIndex: apply ? 1 : null, afterReversal: apply ? false : null, tasksSinceTeach: apply ? 2 : null,
    lessons: [{ lessonId: 'f1-l1', first: 'pass', final: 'pass', staleFollow: null }], acceptancePassed: true, resolved: true, usage: { firstSession: bucket, extra: bucket },
    turns: 1, toolCalls: 1, fileReads: 1, wallMs: 1, teachTurns: 0, correctionTurns: 0, invalid: null, timedOut: false, void: null, leak: false, limitRetries: 0, carryUnionMerges: 0,
    ...extra,
  };
  if (apply) r.chain = { stored: true, shown: true, followed: true, captured: arm === 'A2' ? true : null };
  return r;
}

const logLine = (text: string): string => {
  const body = JSON.stringify({ tools: [{}, {}, {}, {}], messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
  return JSON.stringify({ method: 'POST', url: '/v1/messages?beta=true', body });
};

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A scored folder shaped like round 3's: one run, one A2 and one A5 first apply, their teaches, key phrases and the blind file. */
function scoredDir(o: Options = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-reach-'));
  const teach = (arm: string): Rec => rec(arm, 'teach', 0, o.teachForm === null ? {} : { teachForm: o.teachForm ?? 'correction' });
  const records = [teach('A2'), rec('A2', 'apply', 3), teach('A5'), rec('A5', 'apply', 3)];
  if (o.duplicateA2) records.push(rec('A2', 'apply', 3));
  write(path.join(dir, 'r3run/ab-w1/run/runs.jsonl'), records.map((r) => JSON.stringify(r)).join('\n'));
  write(path.join(dir, 'r3run/gr3-w1b/run/runs.jsonl'), '');
  const families = [{ id: 'f1', lessons: o.withPhrase === false ? [] : [{ id: 'f1-l1', keyPhrase: PHRASE }] }];
  write(path.join(dir, 'merged-r3/ab-r/tasks-run.json'), JSON.stringify({ families }));
  write(path.join(dir, 'r3-final/unblind.json'), JSON.stringify({ hypotheses: { H1: { violation: { estimate: -0.1 } } }, gates: { G5: { n: 10, disagreements: 1 } } }));
  const logs = path.join(dir, 'r3run/ab-w1/run/raw/seq');
  write(path.join(logs, 'A2/seed1/f1-a2-apply3.session1.requests.jsonl'), `${logLine(BLOCK_TEXT)}\n`);
  if (o.withA5Log !== false) write(path.join(logs, 'A5/seed1/f1-a5-apply3.session1.requests.jsonl'), `${logLine('nothing from hippo here')}\n`);
  return dir;
}

interface Read { code: number; stderr: string; report: Report }
interface Dupes { duplicatePair: string[] }

function read(dir: string): Read {
  const res = runCli(['--scored', dir, '--json']);
  return { code: res.code, stderr: res.stderr, report: JSON.parse(res.stdout) };
}

describe('Z0 lesson reach pure parts', () => {
  it('decodes a nested-escaped body the way the rules block needs', () => {
    const inner = 'SessionStart ## Rules from the user\n- No: run uv run\n- keep short\n';
    const nested = JSON.stringify(JSON.stringify(inner));
    expect(nested).toContain('\\\\n');
    expect([...ruleLinesOf(flat(nested))]).toEqual(['- No: run uv run', '- keep short']);
    expect(flat('x\\ny')).toBe('x\ny');
    expect(flat('x\\\\ny')).toBe('x\ny');
  });

  it('classes an entry by its tag list in the fixed order', () => {
    expect(tagClass(['session-digest', 'error'])).toBe('session-digest');
    expect(tagClass(['claude-code-memory', 'error'])).toBe('claude-code-memory');
    expect(tagClass(['error', 'captured'])).toBe('error');
    expect(tagClass(['auto-captured', 'error'])).toBe('error');
    expect(tagClass(['rule', 'captured', 'follow-up', 'from-user'])).toBe('from-user');
    expect(tagClass(['preference', 'captured'])).toBe('captured');
    expect(tagClass(['rule', 'captured'])).toBe('captured');
    expect(tagClass(['changelog', 'convention', 'path:q105'])).toBe('other:changelog');
    expect(entryTags('- **[observed] a** [session-digest]\n- **[observed] b** [auto-captured, error]')).toEqual([['session-digest'], ['auto-captured', 'error']]);
  });

  it('finds a No-lead for "No:" and "No," and folds case and spacing in the key phrase', () => {
    expect(ruleFormOf('run uv run', new Set(['- No: Run  UV run, because x']))).toBe('No-lead');
    expect(ruleFormOf('run uv run', new Set(['- No, run uv run']))).toBe('No-lead');
    expect(ruleFormOf('run uv run', new Set(['- Never skip: run uv run', '- Run uv run']))).toBe('clean');
    expect(ruleFormOf('run uv run', new Set(['- Not: run uv run', '- Run uv run']))).toBe('clean');
    expect(ruleFormOf('run uv run', new Set(['- run uv run', '- No: run uv run']))).toBe('No-lead');
    expect(ruleFormOf('run uv run', new Set(['- Keep lines short']))).toBe('absent');
  });

  it('holds a phrase inside a hook block and misses one after its bound', () => {
    const text = "## Prompt-Relevant Memory (1 entry, 40 tokens)\n\n- **[observed] use uv run** [session-digest]\n\nToday's date is 2026-11-06.\nlater: pnpm lint";
    const blocks = hookBlocksOf(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ header: 'Prompt-Relevant Memory', entries: 1, tokens: 40 });
    expect(blocksHold(blocks, 'USE  uv run')).toBe(true);
    expect(blocksHold(blocks, 'pnpm lint')).toBe(false);
    const next = hookBlocksOf('## Project Memory (1 entry, 9 tokens)\n\n- **[verified] pinned** [rule]\n\n## Other\npnpm lint');
    expect(blocksHold(next, 'pinned')).toBe(true);
    expect(blocksHold(next, 'pnpm lint')).toBe(false);
  });

  it('does not take the CLAUDE.md "Project Memory (Hippo)" heading for a block', () => {
    expect(hookBlocksOf('## Project Memory (Hippo)\n\nThe installed hook injects rules.')).toEqual([]);
  });

  it('computes the best-case A2 gain per lesson', () => {
    const h = headroomOf({ lessons: 50, failed: 11 }, { lessons: 109, failed: 7 }, 162);
    expect(h).toMatchObject({ unit: 'lesson', a5NotShown: 50, a5NotShownFailed: 11, a4Failed: 7, a4Lessons: 109, a2Lessons: 162 });
    expect(h.bestCaseGain).toBeCloseTo(11 - (50 * 7) / 109, 6);
    expect(h.bestCaseGain).toBeCloseTo(7.79, 2);
    expect(h.bestCaseGainPoints).toBeCloseTo(4.81, 2);
  });

  it('keys a teach form by run, arm, seed and lesson, so a two-lesson family keeps two forms', () => {
    const errors: Dupes = { duplicatePair: [] };
    const teach = (lessonId: string, teachForm: string) => ({ kind: 'teach', runName: 'ab-w1', arm: 'A2', seed: 1, teachForm, lessons: [{ lessonId }] });
    const forms = teachFormIndex([teach('f1-l1', 'correction'), teach('f1-l2', 'confirmation')], errors);
    expect([...forms]).toEqual([['ab-w1|A2|1|f1-l1', 'correction'], ['ab-w1|A2|1|f1-l2', 'confirmation']]);
    expect(errors.duplicatePair).toEqual([]);
    teachFormIndex([teach('f1-l1', 'correction'), teach('f1-l1', 'confirmation')], errors);
    expect(errors.duplicatePair).toEqual(['teach ab-w1|A2|1|f1-l1']);
  });
});

describe('Z0 lesson reach read', () => {
  it('prints one JSON object with the ten top-level keys, and reads a block and its rule line', () => {
    const res = read(scoredDir());
    expect(res).toMatchObject({ code: 0, stderr: '' });
    expect(Object.keys(res.report)).toEqual(KEYS);
    expect(res.report.grade).toBe('runner-first-check');
    expect(Object.values(res.report.errors).flat()).toEqual([]);
    expect(res.report.inputs.records).toBe(4);
    expect(res.report.funnel.arms.A2?.n).toBe(1);
    expect(res.report.blocks).toMatchObject({ sessions: 1, withBlock: 1, entries: 2, byClass: { 'session-digest': { entries: 1 }, error: { entries: 1 } } });
    expect(res.report.rules.allLessons['No-lead']?.A2).toEqual({ lessons: 1, failed: 0 });
    expect(res.report.hippoReach).toMatchObject({ lessons: 1, routes: { ruleLine: 1, hookBlock: 0, both: 0, neither: 0 } });
    expect(res.report.headroom.unit).toBe('lesson');
  });

  it('prints text with the grade and the built-in memory note, and exits 0', () => {
    const res = runCli(['--scored', scoredDir()]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('grade: runner-first-check');
    expect(res.stdout).toContain('builtInShown');
    expect(res.stdout).toContain('not the blind G5 grades');
  });

  it('names a missing request log, keeps reading, and exits 1', () => {
    const res = read(scoredDir({ withA5Log: false }));
    expect(res.code).toBe(1);
    expect(res.report.errors.missingLogs).toHaveLength(1);
    expect(res.report.errors.missingLogs[0]).toContain('f1-a5-apply3.session*.requests.jsonl');
    expect(res.stderr).toContain('missing request log:');
    expect(res.stderr).toContain('z0-reach: errors.missingLogs has 1 entries, first:');
    expect(res.report.blocks.withBlock).toBe(1);
  });

  it('names a duplicate (run, sequence, seed, position, arm) key and never overwrites it', () => {
    const res = read(scoredDir({ duplicateA2: true }));
    expect(res.code).toBe(1);
    expect(res.report.errors.duplicatePair).toEqual(['A2 ab|seq#1@3']);
    expect(res.stderr).toContain('errors.duplicatePair has 1 entries, first: A2 ab|seq#1@3');
  });

  it('names a lesson with no key phrase and never calls it absent', () => {
    const res = read(scoredDir({ withPhrase: false }));
    expect(res.code).toBe(1);
    expect(res.report.errors.missingKeyPhrase).toEqual(['f1-l1']);
    expect(res.report.rules.allLessons.absent?.A2).toEqual({ lessons: 0, failed: 0 });
    expect(res.report.hippoReach.lessons).toBe(0);
  });

  it('names a first-apply lesson with no teach form and never buckets it', () => {
    const res = read(scoredDir({ teachForm: null }));
    expect(res.code).toBe(1);
    expect(res.report.errors.missingTeachForm.length).toBeGreaterThan(0);
    expect(res.report.errors.missingTeachForm[0]).toContain('ab-w1|A2|1|f1-l1');
    expect(res.report.rules.byOwnTeachForm.A2?.correction?.lessons).toBe(0);
    expect(res.report.rules.byOwnTeachForm.A2?.confirmation?.lessons).toBe(0);
  });

  it('exits 1 with a usage line on an unknown flag', () => {
    const res = runCli(['--nope']);
    expect(res).toMatchObject({ code: 1, stdout: '' });
    expect(res.stderr).toContain('unknown flag --nope');
  });
});
