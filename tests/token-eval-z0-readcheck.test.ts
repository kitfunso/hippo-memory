// Z0 G1 read check and delivery voids (prereg 113, 159-162) with the fake Claude Code: a session that read past its own memory is void.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { symlinkSync, writeFileSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveToken, foldPath, sessionVoid } from '../scripts/token-eval/readcheck.mjs';
import { codexAdapter } from '../scripts/token-eval/codex-rollout.mjs';
import { runDirs } from '../scripts/token-eval/homes.mjs';
import { __setSettleHook } from '../scripts/token-eval/runs.mjs';
import { g1 } from '../scripts/token-eval/z0-gates.mjs';
import { validateCorpus } from './fixtures/z0-contract.js';
import { cleanup, tmp, isolate, makeRepo, task, plain, spec, oneLesson, run, readRecords, readPlan, find, logLines, runRoot, type RunRecord } from './fixtures/z0-harness.js';

const classes = (r: RunRecord) => (r.voidHits ?? []).map((h) => h.class);
interface SettledRun { arm: string }

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
    contentPretty: 'ECHO_TRANSCRIPT_PRETTY',
    subagent: 'SUBAGENT\nREAD:{OUT}/runs/seqF/A2/seed1/work/lib.js',
    own: 'READ:lib.js\nREAD:{RUN}/claude-config/CLAUDE.md\nGREP:.\nBASH:cat $CLAUDE_CONFIG_DIR/projects/x/memory/MEMORY.md',
    cache: 'READ:{OUT}/repo-cache/seqF/HEAD',
    quotedHome: 'BASH:cat "$HOME"/.claude/projects/p/s.jsonl',
    sessionIdOnly: 'ECHO:{"type":"delivery","sessionId":"not-a-transcript-line"}',
    scattered: 'ECHO:{"user":{"uuid":"u"},"event":{"type":"delivery","sessionId":"s"}}',
    nestedRecord: 'ECHO:{"wrap":{"type":"user","uuid":"u1","sessionId":"other-session"}}',
    coloured: 'ECHO:{"uuid":"u1",\x1b[0m\x1b[1m\x1b[31m"type":"user"\x1b[0m,"sessionId":"other-session"}',
    heredocFile: "BASH:mkdir -p t && cat > t/x.test.js <<'EOF'\\nconst lib = require('../../../A2/seed1/work/lib.js');\\nEOF\\nnode --test t",
    heredocPiped: "BASH:cat <<'EOF' | sh\\ncat ../../../A2/seed1/work/lib.js\\nEOF",
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
  it('a transcript line printed over several lines voids too', () => expectRead('contentPretty', 'transcript-content'));
  it('a subagent\'s read counts', () => expectRead('subagent', 'other-run'));
  it('own memory, own instructions and own workspace reads do not void', () => {
    expect(find(recs, 'A1', 'own')).toMatchObject({ invalid: null, void: null });
    expect(find(recs, 'A1', 'own').voidHits).toBeUndefined();
  });
  it('reading the repo cache, which holds every fix ref, voids as other-arm', () => expectRead('cache', 'other-arm'));
  it('a quoted env form joined to a bare path is one shell word', () => expectRead('quotedHome', 'operator'));
  it('a sessionId in output that is not a transcript line does not void', () => expect(find(recs, 'A1', 'sessionIdOnly').void).toBeNull());
  it('type, uuid and sessionId from different objects do not make a transcript line', () => expect(find(recs, 'A1', 'scattered').void).toBeNull());
  it('a transcript record nested inside other output still voids', () => expectRead('nestedRecord', 'transcript-content'));
  it('a transcript line printed with colour escapes still voids', () => expectRead('coloured', 'transcript-content'));
  it('a path in a heredoc that cat writes to a file is file content, not a read', () => expect(find(recs, 'A1', 'heredocFile').void).toBeNull());
  it('a heredoc piped on to a shell is a script, so its reads still void', () => expectRead('heredocPiped', 'other-run'));
});

describe('a Codex call\'s workdir is a read of that dir', () => {
  afterEach(cleanup);

  /** G1 over one fake rollout whose only call is `cmd` run in `workdir` (null: no workdir), from the X1 run's own session cwd. */
  function codexVerdict(cmd: string, workdir: (own: string, other: string) => string | null) {
    const out = tmp('z0-workdir-');
    const own = runDirs(out, 'seqF', 'X1', 1);
    const other = runDirs(out, 'seqF', 'X2', 1);
    for (const d of [own.work, other.work]) mkdirSync(d, { recursive: true });
    const wd = workdir(own.work, other.work);
    const items = [{ type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd, workdir: wd ?? undefined }) }];
    const lines = [{ type: 'session_meta', payload: { id: 't1', cwd: own.work } }, ...items.map((payload) => ({ type: 'response_item', payload }))];
    const file = join(out, 'rollout-t1.jsonl');
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const ctx = { outDir: out, cacheDir: join(out, 'repo-cache'), operatorEnv: { ...process.env }, foreignDirs: [], canaries: [] };
    return sessionVoid(ctx, { arm: 'X1', dirs: own, env: {} }, { order: 1 }, { files: [file], ownIds: ['t1'], delivery: [], adapter: codexAdapter, env: {} });
  }

  it('a bare filename read in another run\'s work dir voids; the same read in the run\'s own work dir does not', () => {
    const foreign = codexVerdict('Get-Content MEMORY.md', (_own, other) => other);
    expect(foreign.void).toBe('read');
    expect(foreign.voidHits.map((h: { class: string | null }) => h.class)).toContain('other-run');
    expect(codexVerdict('Get-Content MEMORY.md', (own) => own)).toEqual({ void: null, voidHits: [] });
    expect(codexVerdict('Get-Content MEMORY.md', () => null)).toEqual({ void: null, voidHits: [] });
  });

  it('a relative workdir naming another run\'s dir resolves against the session cwd and voids', () => {
    const verdict = codexVerdict('Get-Content MEMORY.md', (own, other) => relative(own, other));
    expect(verdict.void).toBe('read');
    expect(verdict.voidHits.map((h: { class: string | null }) => h.class)).toContain('other-run');
    expect(codexVerdict('Get-Content MEMORY.md', () => 'src').void).toBeNull();
  });
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

describe('paths realpath cannot take', () => {
  afterEach(cleanup);
  // Under the root, which is never a link (macOS links /tmp), so the expected fold is the input's.
  const base = process.platform === 'win32' ? 'C:/z0-no-such-dir' : '/z0-no-such-dir';
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

  it('fold to their deepest resolvable prefix instead of throwing', () => {
    // ENAMETOOLONG: the whole path on Windows, any segment over 255 characters on Linux.
    expect(foldPath(`${base}/${'c'.repeat(40000)}`)).toBe(fold(`${base}/${'c'.repeat(40000)}`));
    expect(foldPath(`${base}/${'d'.repeat(300)}/x`)).toBe(fold(`${base}/${'d'.repeat(300)}/x`));
    // ERR_INVALID_ARG_VALUE, a TypeError rather than a system error.
    expect(foldPath(`${base}/a\0b`)).toBe(fold(`${base}/a\0b`));
  });

  it.skipIf(process.platform !== 'win32')('fold a file Windows keeps locked (EBUSY)', (t) => {
    // Listed, though stat on it fails, so existsSync says false.
    if (!readdirSync('C:/').includes('pagefile.sys')) t.skip();
    expect(foldPath('C:/pagefile.sys')).toBe('c:/pagefile.sys');
  });

  it('an overlong path in a tool call is a plain token, never a run fault', async () => {
    const { out } = isolate('long-path');
    const r = makeRepo();
    await run(spec(r, [], [task(r, 't1', `READ:/${'c'.repeat(40000)}\nBASH:echo /${'d'.repeat(40000)}`), plain(r, 't2')]), ['A1'], out);
    const recs = readRecords(out);
    expect(recs).toHaveLength(2);
    expect(find(recs, 'A1', 't1')).toMatchObject({ invalid: null, void: null });
  }, 300_000);
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

  it('a canary seen only in an apply\'s resume leaves its void to session 1, and still fails the run at G1', async () => {
    const { out } = isolate('resume-canary');
    const canary = 'zz-canary-r';
    await run(oneLesson(makeRepo(), { a1: `LESSON_BAD\nRESUME_ECHO:{B64:${Buffer.from(canary).toString('base64')}}` }), ['A1'], out, { canaries: [canary] });
    const recs = readRecords(out);
    const a1 = find(recs, 'A1', 'a1');
    expect(a1).toMatchObject({ invalid: null, void: null });
    expect((a1.resumeVoidHits ?? []).map((h) => h.reason)).toEqual(['operator-canary']);
    expect(g1(recs, {})).toMatchObject({ pass: false, operatorCanaries: 1 });
  }, 300_000);
});

describe('an ancestor file seen only at an apply\'s resume is kept, never invalidating it', () => {
  afterEach(() => {
    __setSettleHook(null);
    cleanup();
  });
  const above = (out: string, arm: string) => join(runRoot(out, arm), 'CLAUDE.md');

  it('one a hook writes before a failing apply\'s resume skips the resume and leaves the apply valid', async () => {
    const { out, log } = isolate('resume-ancestor');
    // A passing apply takes no resume, so a file written at this point could never invalidate it.
    __setSettleHook((_run: SettledRun, cell: string, when: string) => {
      if (cell === 'a1' && when === 'pre-resume') writeFileSync(above(out, 'A2'), 'written by a late hook\n');
      if (cell === 'a1' && when === 'end') rmSync(above(out, 'A2'), { force: true });
    });
    await run(oneLesson(makeRepo(), { a1: 'LESSON_BAD' }), ['A2'], out);
    const recs = readRecords(out);
    const a1 = find(recs, 'A2', 'a1');
    expect(a1).toMatchObject({ invalid: null, void: null, correctionTurns: 0, resumeAncestorHits: ['runs/seqF/A2/seed1/CLAUDE.md'] });
    expect(logLines(log).filter((l) => l === `resume ${a1.sessionId}`)).toEqual([]);
    expect(find(recs, 'A2', 'a2').invalid).toBeNull();
    expect(validateCorpus(recs, readPlan(out))).toEqual([]);
  }, 300_000);

  it('one a cut-off resume plants stops the rerun, keeps the retry count, and leaves the apply valid', async () => {
    const { out } = isolate('resume-ancestor-cut');
    await run(oneLesson(makeRepo(), { a1: 'LESSON_BAD CUT_ON_RESUME ANCESTOR_ON_CUT' }), ['A1'], out, { limitWaitMs: 0 });
    const recs = readRecords(out);
    expect(find(recs, 'A1', 'a1')).toMatchObject({ invalid: null, void: null, limitRetries: 1, correctionTurns: 0, resumeAncestorHits: ['runs/seqF/A1/seed1/CLAUDE.md'] });
    // The file stays, so the next session would load it: that cell's own session-1 check voids it.
    expect(find(recs, 'A1', 'a2').invalid).toBe('ancestor-instructions');
    expect(validateCorpus(recs, readPlan(out))).toEqual([]);
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
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`], { windowsVerbatimArguments: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`cmd.exe gave no short name for ${dir}: ${r.stderr}`);
  return r.stdout.trim();
}
