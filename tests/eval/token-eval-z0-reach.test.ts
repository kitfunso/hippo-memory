/** Z0 lesson reach read: tag classes, No-lead forms, JSON-string decoding, hook-block bounds and dedupe, hippoReach routes, unscored pairs, the JSON shape and the errors it names. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { blocksHold, bodyTexts, entryTags, headroomOf, hookBlocksOf, ruleFormOf, ruleLinesOf, runCli, tagClass, teachFormIndex } from '../../scripts/token-eval/z0-reach.mjs';

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

const rulesText = (phrase: string): string => `SessionStart hook additional context: ## Rules from the user\n- No: ${phrase}\n- Keep lines short\n\n`;
const blockText = (phrase: string): string => `## Prompt-Relevant Memory (1 entry, 30 tokens)\n\n- **[observed] ${phrase}** [session-digest]\n\nToday's date is 2026-11-06.`;

type First = 'pass' | 'fail' | 'na';
interface Lesson { lessonId: string; first: First; final: 'pass'; staleFollow: null }
interface Rec {
  schema: string; tool: string; repo: string; sequence: string; taskId: string; position: number; order: number; set: string; seed: number;
  arm: string; kind: 'teach' | 'apply'; familyId: string; lessonSource: string; applyIndex: number | null; afterReversal: boolean | null;
  tasksSinceTeach: number | null; lessons: Lesson[]; acceptancePassed: boolean; resolved: boolean; usage: Usage; turns: number; toolCalls: number;
  fileReads: number; wallMs: number; teachTurns: number; correctionTurns: number; invalid: null; timedOut: boolean; void: null; leak: boolean;
  limitRetries: number; carryUnionMerges: number; teachForm?: string; chain?: { stored: boolean; shown: boolean; followed: boolean; captured: boolean | null };
}
interface Usage { firstSession: Bucket; extra: Bucket }
interface Bucket { inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number }
interface Counts { lessons: number; failed: number }
interface Mismatch { run: string; taskId: string; seed: number; position: number; header: string; declared: number; parsed: number }
interface ClassShare { entries: number; chars: number; share: number; charShare: number }
interface Blocks {
  sessions: number; withBlock: number; distinctBlocks: number; sessionsWithSeveralBlocks: number; entries: number; entryChars: number; declaredEntries: number;
  entryMismatches: Mismatch[]; byClass: Record<string, ClassShare>;
}
interface Cell { a2: string; a5: string; positions: number }
interface Unscored { a2: string; a5: string; position: number }
interface Reach { a2: Counts; a5AtSamePositions: Counts }
interface Report {
  grade: string;
  errors: Record<string, string[]>;
  inputs: { records: number };
  funnel: { arms: Record<string, { n: number; unscored: number }> };
  paired: { cells: Cell[]; unscored: Unscored[]; onHippoReach: Record<string, Reach> };
  blocks: Blocks;
  rules: {
    perArm: Record<string, { sessions: { ruleBlock: boolean; noLine: boolean; outcome: string; sessions: number }[] }>;
    allLessons: Record<string, Record<string, Counts>>;
    byOwnTeachForm: Record<string, Record<string, { lessons: number }>>;
  };
  hippoReach: { lessons: number; reached: Counts; notReached: Counts; routes: Record<string, number> };
  headroom: { unit: string };
}
interface Options {
  teachForm?: string | null; withA5Log?: boolean; duplicateA2?: boolean; withPhrase?: boolean; phrase?: string; a2Texts?: (string | string[])[]; a5First?: First; extra?: Rec[];
}
interface Phrase { id: string; keyPhrase: string }
interface LogFile { file: string; texts: (string | string[])[] }
interface Read { code: number; stderr: string; report: Report }
interface Dupes { duplicatePair: string[] }
interface RouteCase { lessonId: string; phrase: string; a2: First; a5: First; a2Texts: string[] }

const bucket: Bucket = { inputTokens: 1, cacheWriteTokens: 1, cacheReadTokens: 1, outputTokens: 1 };
const lesson = (lessonId: string, first: First = 'pass'): Lesson => ({ lessonId, first, final: 'pass', staleFollow: null });

function rec(arm: string, kind: 'teach' | 'apply', position: number, extra: Partial<Rec> = {}): Rec {
  const apply = kind === 'apply';
  const r: Rec = {
    schema: 'z0-record/1', tool: 'claude-code', repo: 'r1', sequence: 'seq', taskId: `f1-${arm.toLowerCase()}-${kind}${position}`, position, order: position, set: 'R', seed: 1,
    arm, kind, familyId: 'f1', lessonSource: 'maintainer', applyIndex: apply ? 1 : null, afterReversal: apply ? false : null, tasksSinceTeach: apply ? 2 : null,
    lessons: [lesson('f1-l1')], acceptancePassed: true, resolved: true, usage: { firstSession: bucket, extra: bucket },
    turns: 1, toolCalls: 1, fileReads: 1, wallMs: 1, teachTurns: 0, correctionTurns: 0, invalid: null, timedOut: false, void: null, leak: false, limitRetries: 0, carryUnionMerges: 0,
    ...extra,
  };
  if (apply) r.chain = { stored: true, shown: true, followed: true, captured: arm === 'A2' ? true : null };
  return r;
}

/** One logged request; an array puts several text parts in the same request, as a real session's history does. */
const logLine = (parts: string | string[]): string => {
  const content = (Array.isArray(parts) ? parts : [parts]).map((text) => ({ type: 'text', text }));
  const body = JSON.stringify({ tools: [{}, {}, {}, {}], messages: [{ role: 'user', content }] });
  return JSON.stringify({ method: 'POST', url: '/v1/messages?beta=true', body });
};

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A scored folder shaped like round 3's: one run, its records, key phrases, request logs and the blind file. */
function build(records: Rec[], phrases: Phrase[], logs: LogFile[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-reach-'));
  write(path.join(dir, 'r3run/ab-w1/run/runs.jsonl'), records.map((r) => JSON.stringify(r)).join('\n'));
  write(path.join(dir, 'r3run/gr3-w1b/run/runs.jsonl'), '');
  const families = [{ id: 'f1', lessons: phrases.map((p) => ({ id: p.id, keyPhrase: p.keyPhrase })) }];
  write(path.join(dir, 'merged-r3/ab-r/tasks-run.json'), JSON.stringify({ families }));
  write(path.join(dir, 'r3-final/unblind.json'), JSON.stringify({ hypotheses: { H1: { violation: { estimate: -0.1 } } }, gates: { G5: { n: 10, disagreements: 1 } } }));
  for (const l of logs) write(path.join(dir, 'r3run/ab-w1/run/raw/seq', l.file), `${l.texts.map(logLine).join('\n')}\n`);
  return dir;
}

/** One A2 and one A5 first apply at position 3, their teaches and logs; options bend one part at a time. */
function scoredDir(o: Options = {}): string {
  const teach = (arm: string): Rec => rec(arm, 'teach', 0, o.teachForm === null ? {} : { teachForm: o.teachForm ?? 'correction' });
  const a5Apply = rec('A5', 'apply', 3);
  a5Apply.lessons = [lesson('f1-l1', o.a5First ?? 'pass')];
  const records = [teach('A2'), rec('A2', 'apply', 3), teach('A5'), a5Apply];
  if (o.duplicateA2) records.push(rec('A2', 'apply', 3));
  records.push(...(o.extra ?? []));
  const phrases = o.withPhrase === false ? [] : [{ id: 'f1-l1', keyPhrase: o.phrase ?? PHRASE }];
  const logs = [{ file: 'A2/seed1/f1-a2-apply3.session1.requests.jsonl', texts: o.a2Texts ?? [BLOCK_TEXT] }];
  if (o.withA5Log !== false) logs.push({ file: 'A5/seed1/f1-a5-apply3.session1.requests.jsonl', texts: ['nothing from hippo here'] });
  return build(records, phrases, logs);
}

/** Four A2 lessons, one for each way hippo can reach the model, each with its own A2 and A5 outcome. */
function routesDir(cases: RouteCase[]): string {
  const records: Rec[] = [];
  const logs: LogFile[] = [];
  cases.forEach((c, i) => {
    for (const arm of ['A2', 'A5']) {
      records.push(rec(arm, 'teach', 20 + i, { lessons: [lesson(c.lessonId)], teachForm: 'correction' }));
      records.push(rec(arm, 'apply', 3 + i, { lessons: [lesson(c.lessonId, arm === 'A2' ? c.a2 : c.a5)] }));
      logs.push({ file: `${arm}/seed1/f1-${arm.toLowerCase()}-apply${3 + i}.session1.requests.jsonl`, texts: arm === 'A2' ? c.a2Texts : ['nothing from hippo here'] });
    }
  });
  return build(records, cases.map((c) => ({ id: c.lessonId, keyPhrase: c.phrase })), logs);
}

function read(dir: string): Read {
  const res = runCli(['--scored', dir, '--json']);
  return { code: res.code, stderr: res.stderr, report: JSON.parse(res.stdout) };
}

const message = (text: string) => [{ role: 'user', content: [{ type: 'text', text }] }];

describe('Z0 lesson reach pure parts', () => {
  it('reads a text part that is itself a JSON string as its decoded text only, and leaves backslash sequences in plain text alone', () => {
    const inner = 'say "hi"\n## Rules from the user\n- No: run uv run\n- keep short\n';
    const quoted = JSON.stringify(inner);
    expect(bodyTexts(message(inner))).toEqual([inner]);
    expect(bodyTexts(message(quoted))).toEqual([inner]);
    expect([...ruleLinesOf(quoted)]).toEqual([]);
    expect([...ruleLinesOf(inner)]).toEqual(['- No: run uv run', '- keep short']);
    const digest = 'the digest holds a\\nb as typed';
    expect(bodyTexts(message(digest))).toEqual([digest]);
  });

  it('keeps a quoted text that is not valid JSON as plain text', () => {
    const winPath = '"C:\\Users\\x"';
    const newline = '"first\nsecond"';
    expect(bodyTexts(message(winPath))).toEqual([winPath]);
    expect(bodyTexts(message(newline))).toEqual([newline]);
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

  it('holds a phrase inside a hook block and misses one after the "Today\'s date" bound', () => {
    const text = "## Prompt-Relevant Memory (1 entry, 40 tokens)\n\n- **[observed] use uv run** [session-digest]\n\nToday's date is 2026-11-06.\nlater: pnpm lint";
    const blocks = hookBlocksOf(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ header: 'Prompt-Relevant Memory', entries: 1, tokens: 40 });
    expect(blocksHold(blocks, 'USE  uv run')).toBe(true);
    expect(blocksHold(blocks, 'pnpm lint')).toBe(false);
  });

  it('ends a block at the reminder end or the next hippo block header, and caps one with no bound', () => {
    const closed = hookBlocksOf('## Prompt-Relevant Memory (1 entry, 9 tokens)\n\n- **[observed] a** [rule]\n</system-reminder>\npnpm lint');
    expect(blocksHold(closed, 'pnpm lint')).toBe(false);
    const two = hookBlocksOf('## Prompt-Relevant Memory (1 entry, 9 tokens)\n\n- **[observed] first** [rule]\n\n## Project Memory (1 entry, 9 tokens)\n\n- **[verified] pinned** [error]');
    expect(two.map((b) => b.header)).toEqual(['Prompt-Relevant Memory', 'Project Memory']);
    expect(blocksHold(two.slice(0, 1), 'pinned')).toBe(false);
    expect(blocksHold(two.slice(1), 'pinned')).toBe(true);
    const long = hookBlocksOf(`## Project Memory (1 entry, 9 tokens)\n${'x'.repeat(20_000)}`);
    expect(long[0]?.text.length).toBeLessThanOrEqual(12_000);
  });

  it('keeps a "## " line inside an entry in its block and counts both entries', () => {
    const text = "## Project Memory (2 entries, 50 tokens)\n\n- **[observed] first\n## Heading in the body\nmore text** [session-digest]\n- **[verified] second** [rule]\n\nToday's date is 2026-11-06.\n## Later\nnot in the block";
    const blocks = hookBlocksOf(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toContain('## Heading in the body');
    expect(blocks[0]?.text).not.toContain('not in the block');
    expect(entryTags(blocks[0]?.text ?? '')).toEqual([['session-digest'], ['rule']]);
  });

  it('reads two copies of a block that differ only in trailing blank lines as one text', () => {
    const base = '## Prompt-Relevant Memory (1 entry, 9 tokens)\n\n- **[observed] a** [rule]';
    expect(hookBlocksOf(`${base}\n\n`)[0]?.text).toBe(hookBlocksOf(base)[0]?.text);
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
    expect(res.report.paired.cells).toEqual([{ a2: 'Sp', a5: 'Sp', positions: 1 }]);
    expect(res.report.paired.unscored).toEqual([]);
    expect(res.report.rules.allLessons['No-lead']?.A2).toEqual({ lessons: 1, failed: 0 });
    expect(res.report.hippoReach).toMatchObject({ lessons: 1, routes: { ruleLine: 1, hookBlock: 0, both: 0, neither: 0 } });
    expect(res.report.headroom.unit).toBe('lesson');
  });

  it('counts a block by entries and by characters, and the entries its header declares', () => {
    const { blocks } = read(scoredDir()).report;
    expect(blocks).toMatchObject({ sessions: 1, withBlock: 1, distinctBlocks: 1, sessionsWithSeveralBlocks: 0, entries: 2, declaredEntries: 2, entryChars: 66, entryMismatches: [] });
    expect(blocks.byClass['session-digest']).toEqual({ entries: 1, chars: 34, share: 0.5, charShare: 34 / 66 });
    expect(blocks.byClass.error).toEqual({ entries: 1, chars: 32, share: 0.5, charShare: 32 / 66 });
  });

  it('lists a block whose header declares more entries than were parsed', () => {
    const three = "## Project Memory (3 entries, 90 tokens)\n\n- **[observed] one** [session-digest]\n- **[observed] two** [error]\n\nToday's date is 2026-11-06.";
    const dir = scoredDir({ a2Texts: [three] });
    const { blocks } = read(dir).report;
    expect(blocks).toMatchObject({ entries: 2, declaredEntries: 3 });
    expect(blocks.entryMismatches).toEqual([{ run: 'ab-w1', taskId: 'f1-a2-apply3', seed: 1, position: 3, header: 'Project Memory', declared: 3, parsed: 2 }]);
    expect(runCli(['--scored', dir]).stdout).toContain('declared 3, parsed 2');
  });

  it('counts a block once when its copies differ only in trailing blank lines, and a second block separately', () => {
    const spaced = BLOCK_TEXT.replace("\nToday's", "\n\n\nToday's");
    expect(spaced).not.toBe(BLOCK_TEXT);
    expect(read(scoredDir({ a2Texts: [BLOCK_TEXT, spaced] })).report.blocks).toMatchObject({ distinctBlocks: 1, entries: 2, sessionsWithSeveralBlocks: 0 });
    const other = read(scoredDir({ a2Texts: [BLOCK_TEXT, spaced, blockText('beta path')] })).report.blocks;
    expect(other).toMatchObject({ distinctBlocks: 2, entries: 3, sessionsWithSeveralBlocks: 1 });
  });

  it('matches a key phrase with quote marks in a plain text part and in a text part that is a JSON string', () => {
    const quoted = 'say "{{ ok }}" first';
    for (const text of [rulesText(quoted), JSON.stringify(rulesText(quoted))]) {
      const { report } = read(scoredDir({ phrase: quoted, a2Texts: [text] }));
      expect(report.rules.allLessons['No-lead']?.A2).toEqual({ lessons: 1, failed: 0 });
      expect(report.hippoReach.routes).toMatchObject({ ruleLine: 1, neither: 0 });
    }
  });

  it('finishes the read when a request holds a quoted text that is not valid JSON', () => {
    const { code, report } = read(scoredDir({ a2Texts: [[BLOCK_TEXT, '"C:\\Users\\x"', '"first\nsecond"']] }));
    expect(code).toBe(0);
    expect(report.blocks).toMatchObject({ withBlock: 1, distinctBlocks: 1, entries: 2 });
    expect(report.rules.allLessons['No-lead']?.A2).toEqual({ lessons: 1, failed: 0 });
  });

  it('counts a block delivered as a JSON-encoded text part once', () => {
    const { code, report } = read(scoredDir({ a2Texts: [[JSON.stringify(BLOCK_TEXT), 'a later message']] }));
    expect(code).toBe(0);
    expect(report.blocks).toMatchObject({ withBlock: 1, distinctBlocks: 1, sessionsWithSeveralBlocks: 0, entries: 2, declaredEntries: 2, entryMismatches: [] });
    expect(report.rules.allLessons['No-lead']?.A2).toEqual({ lessons: 1, failed: 0 });
  });

  it('sorts four lessons into ruleLine, hookBlock, both and neither, and pairs them with A5 at the same positions', () => {
    const dir = routesDir([
      { lessonId: 'f1-l1', phrase: 'alpha path', a2: 'pass', a5: 'pass', a2Texts: [rulesText('alpha path')] },
      { lessonId: 'f1-l2', phrase: 'beta path', a2: 'fail', a5: 'fail', a2Texts: [blockText('beta path')] },
      { lessonId: 'f1-l3', phrase: 'gamma path', a2: 'pass', a5: 'fail', a2Texts: [rulesText('gamma path'), blockText('gamma path')] },
      { lessonId: 'f1-l4', phrase: 'delta path', a2: 'fail', a5: 'pass', a2Texts: ['nothing from hippo here'] },
    ]);
    const { code, report } = read(dir);
    expect(code).toBe(0);
    expect(report.hippoReach).toMatchObject({ lessons: 4, reached: { lessons: 3, failed: 1 }, notReached: { lessons: 1, failed: 1 }, routes: { ruleLine: 1, hookBlock: 1, both: 1, neither: 1 } });
    expect(report.paired.onHippoReach).toEqual({
      reached: { a2: { lessons: 3, failed: 1 }, a5AtSamePositions: { lessons: 3, failed: 2 } },
      notReached: { a2: { lessons: 1, failed: 1 }, a5AtSamePositions: { lessons: 1, failed: 0 } },
    });
    expect(report.paired.cells).toEqual([
      { a2: 'SF', a5: 'SF', positions: 1 }, { a2: 'SF', a5: 'Sp', positions: 1 }, { a2: 'Sp', a5: 'SF', positions: 1 }, { a2: 'Sp', a5: 'Sp', positions: 1 },
    ]);
  });

  it('keeps a pair with no scored lesson out of the paired cells and the pass counts, and names it', () => {
    const { code, report } = read(scoredDir({ a5First: 'na' }));
    expect(code).toBe(0);
    expect(report.paired.cells).toEqual([]);
    expect(report.paired.unscored).toEqual([{ run: 'ab', sequence: 'seq', seed: 1, position: 3, a2: 'Sp', a5: 'Su' }]);
    expect(report.funnel.arms.A5?.unscored).toBe(1);
    expect(report.funnel.arms.A2?.unscored).toBe(0);
    expect(report.rules.perArm.A5?.sessions).toEqual([{ ruleBlock: false, noLine: false, outcome: 'unscored', sessions: 1 }]);
  });

  it('prints text with the grade and the built-in memory note, and exits 0', () => {
    const res = runCli(['--scored', scoredDir()]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('grade: runner-first-check');
    expect(res.stdout).toContain('builtInShown');
    expect(res.stdout).toContain('not the blind G5 grades');
    expect(res.stdout).toContain('entries parsed 2, declared by the headers 2');
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

  it('names a duplicated first apply in an arm the pairing does not read', () => {
    const extra = [rec('A1', 'teach', 0, { teachForm: 'correction' }), rec('A1', 'apply', 3), rec('A1', 'apply', 3)];
    const res = read(scoredDir({ extra }));
    expect(res.code).toBe(1);
    expect(res.report.errors.duplicatePair).toEqual(['A1 ab|seq#1@3']);
    expect(res.report.errors.missingTeachForm).toEqual([]);
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

  it('exits 1 with the missing path and the --scored flag when the scored folder has no r3run', () => {
    const missing = path.join(os.tmpdir(), 'z0-reach-no-such-folder');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-reach-empty-'));
    for (const dir of [missing, empty]) {
      const res = runCli(['--scored', dir]);
      expect(res).toMatchObject({ code: 1, stdout: '' });
      expect(res.stderr).toContain(path.join(dir, 'r3run'));
      expect(res.stderr).toContain('--scored');
      expect(res.stderr).not.toContain('ENOENT');
    }
  });
});
