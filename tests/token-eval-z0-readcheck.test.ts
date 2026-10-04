// Z0 G1 read check and delivery voids (prereg 113, 159-162) with the fake Claude Code: a session that read past its own memory is void.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveToken } from '../scripts/token-eval/readcheck.mjs';
import { validateCorpus } from './fixtures/z0-contract';
import { cleanup, tmp, isolate, makeRepo, task, plain, spec, oneLesson, run, readRecords, readPlan, find, type RunRecord } from './fixtures/z0-harness';

const classes = (r: RunRecord) => (r.voidHits ?? []).map((h) => h.class);

describe('reads outside the cell (one A1 run, one read per task)', () => {
  let recs: RunRecord[] = [];
  const reads = {
    otherRun: 'READ:{OUT}/runs/seqF/A2/seed1/claude-config/x',
    past: 'READ_PAST',
    operator: 'BASH:cat ~/.claude/projects/p/s.jsonl',
    envConfig: 'BASH:cat $CLAUDE_CONFIG_DIR/history.jsonl',
    envUp: 'BASH:ls ${HIPPO_HOME}/../../../A2',
    rgHome: 'BASH:rg secret ~',
    grepRun: 'GREP:{RUN}',
    rgHere: 'BASH:rg secret .',
    content: 'BASH:sh x.sh\nECHO_TRANSCRIPT',
    subagent: 'SUBAGENT\nREAD:{OUT}/runs/seqF/A2/seed1/work/lib.js',
    own: 'READ:lib.js\nREAD:{RUN}/claude-config/CLAUDE.md\nGREP:.\nBASH:cat $CLAUDE_CONFIG_DIR/projects/x/memory/MEMORY.md',
    cache: 'READ:{OUT}/repo-cache/seqF/HEAD',
    quotedHome: 'BASH:cat "$HOME"/.claude/projects/p/s.jsonl',
    sessionIdOnly: 'ECHO:{"type":"delivery","sessionId":"not-a-transcript-line"}',
  };

  beforeAll(async () => {
    const { out } = isolate('reads');
    const r = makeRepo();
    await run(spec(r, [], [...Object.entries(reads).map(([id, prompt]) => task(r, id, prompt)), plain(r, 'after')]), ['A1'], out);
    recs = readRecords(out);
    expect(validateCorpus(recs, readPlan(out))).toEqual([]);
  }, 600_000);
  afterAll(cleanup);

  const expectRead = (id: string, cls: string) => {
    const rec = find(recs, 'A1', id);
    expect(rec, id).toMatchObject({ invalid: null, void: 'read' });
    expect(classes(rec), id).toContain(cls);
  };

  it('reading another arm\'s dir voids only that session', () => {
    expectRead('otherRun', 'other-run');
    expect(find(recs, 'A1', 'after').void).toBeNull();
  });
  it('reading a past transcript voids', () => expectRead('past', 'past-transcript'));
  it('a shell read of the operator\'s ~/.claude voids', () => expectRead('operator', 'operator'));
  it('env forms resolve against the agent\'s env', () => {
    expectRead('envConfig', 'past-transcript');
    expectRead('envUp', 'other-run');
  });
  it('a recursive search from an ancestor of a forbidden root voids; one from the workspace does not', () => {
    expectRead('rgHome', 'ancestor-search');
    expectRead('grepRun', 'ancestor-search');
    expect(find(recs, 'A1', 'rgHere').void).toBeNull();
  });
  it('a tool result holding another session\'s transcript lines voids', () => expectRead('content', 'transcript-content'));
  it('a subagent\'s read counts', () => expectRead('subagent', 'other-run'));
  it('own memory, own instructions and own workspace reads do not void', () => {
    expect(find(recs, 'A1', 'own')).toMatchObject({ invalid: null, void: null });
    expect(find(recs, 'A1', 'own').voidHits).toBeUndefined();
  });
  it('reading the repo cache, which holds every fix ref, voids as other-arm', () => expectRead('cache', 'other-arm'));
  it('a quoted env form joined to a bare path is one shell word', () => expectRead('quotedHome', 'operator'));
  it('a sessionId in output that is not a transcript line does not void', () => expect(find(recs, 'A1', 'sessionIdOnly').void).toBeNull());
});

describe('resolveToken', () => {
  it('maps a Git Bash drive path on win32 and expands env forms', () => {
    expect(resolveToken('/c/Users/x', { platform: 'win32', env: {}, cwd: 'C:/w' })).toBe('C:/Users/x');
    expect(resolveToken('%HIPPO_HOME%/a', { platform: 'win32', env: { HIPPO_HOME: 'D:/h' }, cwd: 'C:/w' })).toBe('D:/h/a');
    expect(resolveToken('$env:HOME/a', { platform: 'win32', env: { HOME: 'D:/h' }, cwd: 'C:/w' })).toBe('D:/h/a');
    expect(resolveToken('~/x', { platform: 'linux', env: { HOME: '/home/u' }, cwd: '/w' })).toBe('/home/u/x');
    expect(resolveToken('../y', { platform: 'linux', env: {}, cwd: '/w/a' })).toBe('/w/y');
  });

  it('on win32 HOME and USERPROFILE stand in for each other in every env form', () => {
    const opts = { platform: 'win32', cwd: 'C:/w' };
    expect(resolveToken('$HOME/a', { ...opts, env: { USERPROFILE: 'D:/u' } })).toBe('D:/u/a');
    expect(resolveToken('${HOME}/a', { ...opts, env: { USERPROFILE: 'D:/u' } })).toBe('D:/u/a');
    expect(resolveToken('~/a', { ...opts, env: { USERPROFILE: 'D:/u' } })).toBe('D:/u/a');
    expect(resolveToken('%USERPROFILE%/a', { ...opts, env: { HOME: 'D:/h' } })).toBe('D:/h/a');
    expect(resolveToken('$HOME/a', { platform: 'linux', env: { USERPROFILE: '/u' }, cwd: '/w' })).toBe('/w/$HOME/a');
  });
});

describe('resume hits: session 1 decides void, and only a teach\'s resume adds to it', () => {
  afterEach(cleanup);
  const other = 'READ:{OUT}/runs/seqF/A2/seed1/claude-config/x';

  it('a resume read voids a teach; on an apply it is only kept, while the same read in session 1 voids', async () => {
    const { out } = isolate('resume-reads');
    const r = makeRepo();
    await run(oneLesson(r, { t1: `LESSON_BAD\nRESUME_${other}`, a1: `LESSON_BAD\nRESUME_${other}`, a2: `LESSON_BAD\n${other}` }), ['A1'], out);
    const recs = readRecords(out);
    expect(find(recs, 'A1', 't1')).toMatchObject({ invalid: null, void: 'read' });
    const a1 = find(recs, 'A1', 'a1');
    expect(a1).toMatchObject({ invalid: null, void: null, correctionTurns: 1 });
    expect(a1.voidHits).toBeUndefined();
    expect((a1.resumeVoidHits ?? []).map((h) => h.class)).toEqual(['other-run']);
    expect(find(recs, 'A1', 'a2')).toMatchObject({ invalid: null, void: 'read' });
    expect(validateCorpus(recs, readPlan(out))).toEqual([]);
  }, 300_000);

  it('memory session 1 writes reaches the resume, so it voids a teach', async () => {
    const { out } = isolate('resume-delivery-teach');
    await run(oneLesson(makeRepo(), { t1: 'LESSON_BAD\nUSERMEM:a user rule' }), ['A0'], out);
    expect(find(readRecords(out), 'A0', 't1')).toMatchObject({ invalid: null, void: 'user-instructions' });
  }, 300_000);

  it('memory session 1 writes that reaches an apply\'s resume is kept, never voiding it', async () => {
    const { out } = isolate('resume-delivery-apply');
    await run(oneLesson(makeRepo(), { a1: 'LESSON_BAD\nUSERMEM:a user rule' }), ['A0'], out);
    const a1 = find(readRecords(out), 'A0', 'a1');
    expect(a1).toMatchObject({ invalid: null, void: null });
    expect((a1.resumeVoidHits ?? []).map((h) => h.reason)).toEqual(['user-instructions']);
  }, 300_000);
});

describe('delivery voids and the worktree read', () => {
  afterEach(cleanup);

  it('auto memory or a user-level CLAUDE.md voids A0 from the next session on, and never A1', async () => {
    const { out } = isolate('delivery');
    const r = makeRepo();
    await run(spec(r, [], [task(r, 't1', 'MEMWRITE:a note\nUSERMEM:a user rule'), plain(r, 't2')]), ['A0', 'A1'], out);
    const recs = readRecords(out);
    expect(find(recs, 'A0', 't1').void).toBeNull();
    const t2 = find(recs, 'A0', 't2');
    expect(t2).toMatchObject({ invalid: null, void: 'auto-memory' });
    expect((t2.voidHits ?? []).map((h) => h.reason)).toEqual(expect.arrayContaining(['auto-memory', 'user-instructions']));
    expect(find(recs, 'A1', 't2').void).toBeNull();
  }, 300_000);

  it('a user-level CLAUDE.md alone voids A0 as user-instructions', async () => {
    const { out } = isolate('usermem');
    const r = makeRepo();
    await run(spec(r, [], [task(r, 't1', 'USERMEM:a user rule'), plain(r, 't2')]), ['A0'], out);
    expect(find(readRecords(out), 'A0', 't2')).toMatchObject({ invalid: null, void: 'user-instructions' });
  }, 300_000);

  it('a hippo marker outside A2/A5 voids, from setup or from a user-level file', async () => {
    const { out } = isolate('hippo-text');
    const r = makeRepo();
    const setup = 'node -e "require(\'fs\').writeFileSync(\'CLAUDE.md\', \'<!-- hippo:start -->\\n\')"';
    await run(spec(r, [], [task(r, 't1', 'look around only', { setup }), task(r, 't2', 'USERMEM:<!-- hippo:start -->'), plain(r, 't3')]), ['A1'], out);
    const recs = readRecords(out);
    expect(find(recs, 'A1', 't1')).toMatchObject({ invalid: null, void: 'hippo-text' });
    expect(find(recs, 'A1', 't2').void).toBeNull();
    expect(find(recs, 'A1', 't3')).toMatchObject({ invalid: null, void: 'hippo-text' });
  }, 300_000);

  it('a worktree made outside the workspace voids later reads of it; a canary wins over a read in its session', async () => {
    const { out } = isolate('worktree');
    const r = makeRepo();
    process.env.FAKE_WT_DIR = `${tmp('z0-wt-')}/wt`;
    const s = spec(r, [], [
      task(r, 't1', 'WORKTREE'), task(r, 't2', 'READ:{WT}/lib.js'),
      task(r, 't3', 'ECHO:zz-canary-1\nREAD:{OUT}/runs/seqF/A2/seed1/claude-config/x'), plain(r, 't4'),
    ]);
    await run(s, ['A1'], out, { canaries: ['zz-canary-1'] });
    const recs = readRecords(out);
    expect(find(recs, 'A1', 't1').void).toBeNull();
    expect(find(recs, 'A1', 't2')).toMatchObject({ invalid: null, void: 'read' });
    expect(classes(find(recs, 'A1', 't2'))).toEqual(['worktree']);
    const t3 = find(recs, 'A1', 't3');
    expect(t3).toMatchObject({ invalid: null, void: 'operator-canary' });
    expect((t3.voidHits ?? []).map((h) => h.reason)).toEqual(['operator-canary', 'read']);
    expect(find(recs, 'A1', 't4').void).toBeNull();
  }, 300_000);

  it.skipIf(process.platform !== 'win32')('an out dir and a worktree under 8.3 short names classify long-path reads, as on the CI runner', async (t) => {
    const { out } = isolate('shortname');
    const r = makeRepo();
    const wtParent = tmp('z0-surf-worktree-parent-');
    const [shortOut, shortWt] = [out, wtParent].map(shortName);
    if (shortOut === out || shortWt === wtParent) t.skip();
    // The run and the worktree live under short names, while git prints and the agent reads the long forms.
    process.env.FAKE_WT_DIR = `${shortWt}/wt`;
    await run(spec(r, [], [
      task(r, 't1', 'WORKTREE'), task(r, 't2', `READ:${out}/runs/seqF/A2/seed1/claude-config/x`), task(r, 't3', `READ:${shortWt}/wt/lib.js`),
      task(r, 't4', `READ:${out}/runs/seqF/A1/seed1/work/lib.js`),
    ]), ['A1'], shortOut);
    const recs = readRecords(out);
    expect(find(recs, 'A1', 't2')).toMatchObject({ invalid: null, void: 'read' });
    expect(classes(find(recs, 'A1', 't2'))).toEqual(['other-run']);
    expect(classes(find(recs, 'A1', 't3'))).toEqual(['worktree']);
    expect(find(recs, 'A1', 't4')).toMatchObject({ invalid: null, void: null });
  }, 300_000);

  it('a read through a link alias of the out dir is classified like the out dir itself', async (t) => {
    const { out } = isolate('alias');
    const r = makeRepo();
    const alias = join(tmp('z0-surf-alias-'), 'alias');
    try {
      symlinkSync(out, alias, 'junction');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'EPERM') t.skip();
      throw err;
    }
    await run(spec(r, [], [task(r, 't1', `READ:${alias}/runs/seqF/A2/seed1/claude-config/x`), task(r, 't2', `READ:${alias}/runs/seqF/A1/seed1/work/lib.js`)]), ['A1'], out);
    const recs = readRecords(out);
    expect(find(recs, 'A1', 't1')).toMatchObject({ invalid: null, void: 'read' });
    expect(classes(find(recs, 'A1', 't1'))).toEqual(['other-run']);
    expect(find(recs, 'A1', 't2').void).toBeNull();
  }, 300_000);
});

/** The 8.3 short form of a dir, or the dir itself when the volume makes no short names. */
function shortName(dir: string): string {
  return execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`], { windowsVerbatimArguments: true, encoding: 'utf8' }).trim();
}
