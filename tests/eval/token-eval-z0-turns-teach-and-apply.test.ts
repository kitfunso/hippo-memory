import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { planRuns, validateTasks } from '../../scripts/token-eval/ab-run.mjs';
import * as records from '../../scripts/token-eval/records.mjs';
import { teachMessage, drawOrder } from '../../scripts/token-eval/lessons.mjs';
import { stateCommit, holdPre, dropPre, runCheck } from '../../scripts/token-eval/checks.mjs';
import { hippoBuild } from '../../scripts/token-eval/pins.mjs';
import { validateCorpus, type Z0PlanCell } from '../fixtures/z0-contract.js';
import { CHECKS, tmp, isolate, makeRepo, lesson, family, task, teach, apply, plain, type Spec, spec, reversal, run, readRecords, readPlan, logLines, checkLog, seen, find, ZERO, cleanup } from '../fixtures/z0-turns-harness.js';

afterEach(cleanup);

describe('runner git', () => {
  it('holdPre, dropPre and stateCommit run no hook and read no global config', () => {
    isolate('rgit');
    const r = makeRepo();
    const hooks = tmp('z0-turns-hooks-');
    const marker = join(hooks, 'ran').replace(/\\/g, '/');
    writeFileSync(join(hooks, 'reference-transaction'), `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
    const cfg = join(hooks, 'gitconfig');
    writeFileSync(cfg, `[core]\n\thooksPath = ${hooks.replace(/\\/g, '/')}\n[i18n]\n\tcommitEncoding = ISO-8859-1\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', cfg);
    execFileSync('git', ['update-ref', 'refs/z0/probe', r.base], { cwd: r.repo });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    holdPre(r.repo, r.base);
    dropPre(r.repo);
    const sha = stateCommit(r.repo, r.base);
    expect(existsSync(marker)).toBe(false);
    expect(execFileSync('git', ['cat-file', '-p', sha], { cwd: r.repo, encoding: 'utf8' })).not.toMatch(/^encoding /m);
  });

  it('stateCommit keeps a tracked edit outside a sparse-checkout cone the agent turned on', () => {
    isolate('sparse');
    const r = makeRepo();
    execFileSync('git', ['config', 'core.sparseCheckout', 'true'], { cwd: r.repo });
    mkdirSync(join(r.repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(r.repo, '.git', 'info', 'sparse-checkout'), '/elsewhere/\n');
    writeFileSync(join(r.repo, 'lib.js'), 'edited outside the cone\n');
    const sha = stateCommit(r.repo, r.base);
    expect(execFileSync('git', ['show', `${sha}:lib.js`], { cwd: r.repo, encoding: 'utf8' })).toBe('edited outside the cone\n');
  });

  it("a checker's own git status runs no core.fsmonitor program from the workspace config", () => {
    isolate('fsmon');
    const r = makeRepo();
    const d = tmp('z0-turns-fsmon-');
    const marker = join(d, 'ran').replace(/\\/g, '/');
    const script = join(d, 'fsmon.sh');
    writeFileSync(script, `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.fsmonitor', script.replace(/\\/g, '/')], { cwd: r.repo });
    execFileSync('git', ['status', '--porcelain'], { cwd: r.repo });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const check = join(d, 'status.mjs');
    writeFileSync(check, [
      "import { spawnSync } from 'node:child_process';",
      "if (!(process.env.GIT_CONFIG_PARAMETERS ?? '').includes('color.ui=never')) process.exit(2);",
      "process.exit(spawnSync('git', ['status', '--porcelain']).status === 0 ? 0 : 2);",
    ].join('\n'));
    const l = { id: 'x-l1', checkPath: check, check: { script: 'status.mjs', args: [] } };
    const env = { ...process.env, GIT_CONFIG_PARAMETERS: "'color.ui=never'" };
    expect(runCheck(l, { work: r.repo, env, preCommit: r.base, postCommit: r.fix, commands: [], scratch: join(d, 'scratch') })).toBe('pass');
    expect(existsSync(marker)).toBe(false);
  });

  it("a checker's own git status runs no filter driver from the workspace config, a required one included", () => {
    isolate('filter');
    const r = makeRepo();
    const d = tmp('z0-turns-filter-');
    const marker = join(d, 'ran').replace(/\\/g, '/');
    execFileSync('git', ['config', "filter.z0'agent.clean", `sh -c 'echo ran >> "${marker}"; cat'`], { cwd: r.repo });
    execFileSync('git', ['config', "filter.z0'agent.required", 'true'], { cwd: r.repo });
    writeFileSync(join(r.repo, '.gitattributes'), "* filter=z0'agent\n");
    const restat = () => {
      writeFileSync(join(r.repo, 'lib.js'), readFileSync(join(r.repo, 'lib.js')));
      utimesSync(join(r.repo, 'lib.js'), new Date(), new Date(Date.now() + 60_000));
    };
    restat();
    execFileSync('git', ['status', '--porcelain'], { cwd: r.repo });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    restat();
    const check = join(d, 'status.mjs');
    writeFileSync(check, "import { spawnSync } from 'node:child_process';\nprocess.exit(spawnSync('git', ['status', '--porcelain']).status === 0 ? 0 : 2);\n");
    const l = { id: 'x-l1', checkPath: check, check: { script: 'status.mjs', args: [] } };
    expect(runCheck(l, { work: r.repo, env: process.env, preCommit: r.base, postCommit: r.fix, commands: [], scratch: join(d, 'scratch') })).toBe('pass');
    expect(existsSync(marker)).toBe(false);
  });
});


describe('transcript reads across turns', () => {
  it('commandLog and transcriptWork count each tool_use once across files and session ids', () => {
    const dir = tmp('z0-turns-tx-');
    const use = (id: string, name: string, command?: string) => JSON.stringify({ message: { content: [{ type: 'tool_use', id, name, input: command ? { command } : {} }] } });
    const lines = [use('a1', 'Bash', 'echo one'), use('a2', 'Read'), use('a3', 'Bash', 'cat x'), use('a1', 'Bash', 'echo one'), use('b1', 'Bash', 'echo two'), use('b2', 'PowerShell', 'Get-Content y')];
    const file = join(dir, 's.jsonl');
    const copy = join(dir, 'copy.jsonl');
    writeFileSync(file, lines.join('\n'));
    writeFileSync(copy, lines.join('\n'));
    expect(records.commandLog([file, file])).toEqual(['echo one', 'cat x', 'echo two', 'Get-Content y']);
    expect(records.commandLog([file, copy])).toHaveLength(4);
    expect(records.transcriptWork([file, file], new Set())).toMatchObject({ toolCalls: 5, fileReads: 3, shellReads: 2 });
    expect(records.transcriptWork([file, copy], new Set())).toMatchObject({ toolCalls: 5 });
    expect(records.transcriptWork([], new Set())).toMatchObject({ toolCalls: null, fileReads: null });
  });
});


describe('Z0 lesson tasks end to end (fake Claude Code)', () => {
  it('runs a reversal family in all five arms; every record meets the z0-record/1 contract', async () => {
    const { out, log } = isolate('e2e');
    const r = makeRepo();
    const s = spec(r, [reversal()], [
      teach(r, 't1', 'f1-l1', 'LESSON_OK'), plain(r, 'n1'), task(r, 'n2', 'FIX add in lib.js'), apply(r, 'a1', 'f1-l1', 'LESSON_BAD\nRUN_CMD npm run lint'),
      teach(r, 't2', 'f1-l2', 'LESSON_BAD'), plain(r, 'n3'), plain(r, 'n4'), apply(r, 'a3', 'f1-l2', 'LESSON_OK'),
    ]);
    await run(s, ['A0', 'A1', 'A2', 'A4', 'A5'], out);
    const recs = readRecords(out);
    expect(recs).toHaveLength(40);
    const build = hippoBuild();
    expect(build).toMatchObject({ hippoCommit: expect.stringMatching(/^[0-9a-f]{40}$/), hippoDistHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    for (const x of recs) expect(x, `${x.arm} ${x.taskId}`).toMatchObject(build);
    const plan = readPlan(out);
    expect(validateCorpus(recs, plan)).toEqual([]);
    const cells = (xs: Z0PlanCell[]) => xs.map((x) => JSON.stringify([x.seed, x.position, x.arm, x.sequence, x.taskId, x.set, x.kind, x.familyId])).sort();
    expect(cells(plan)).toEqual(cells(recs));
    for (const arm of ['A0', 'A1', 'A2', 'A4', 'A5']) {
      const get = (id: string) => find(recs, arm, id);
      expect(get('t1'), arm).toMatchObject({ kind: 'teach', set: 'R', teachTurns: 1, correctionTurns: 0, teachForm: 'confirmation', lessons: [{ lessonId: 'f1-l1', first: 'pass', final: 'pass', staleFollow: null }] });
      expect(get('t1').usage?.extra.outputTokens, arm).toBe(50);
      expect(get('t2'), arm).toMatchObject({ teachForm: 'correction', lessons: [{ lessonId: 'f1-l2', first: 'fail', final: 'pass' }] });
      expect(get('a1'), arm).toMatchObject({ kind: 'apply', applyIndex: 1, afterReversal: false, tasksSinceTeach: 2, teachTurns: 0, correctionTurns: 1, teachForm: null, lessons: [{ first: 'fail', final: 'pass', staleFollow: null }] });
      expect(get('a3'), arm).toMatchObject({ applyIndex: 2, afterReversal: true, tasksSinceTeach: 2, lessons: [{ lessonId: 'f1-l2', staleFollow: true }] });
      expect(get('n2'), arm).toMatchObject({ set: 'N', lessons: [], acceptancePassed: true, resolved: true, usage: { extra: ZERO } });
      for (const x of recs.filter((y) => y.arm === arm)) {
        expect(x.resolved, x.taskId).toBe(x.acceptancePassed && x.lessons.every((l) => l.final === 'pass') && !x.timedOut);
        expect('wordOverlap' in x, x.taskId).toBe(x.kind === 'apply');
        expect('scored' in x).toBe(false);
      }
    }
    const a1Checks = checkLog(log).filter((c) => c.commands.includes('npm run lint'));
    expect(a1Checks).toHaveLength(10);
    for (const c of a1Checks) expect(c.commands.slice(0, 2)).toEqual(['git status && cat lib.js', 'npm run lint']);
    expect(a1Checks.filter((c) => c.commands.length === 3).map((c) => c.commands[2])).toEqual(Array(5).fill('echo resumed No:'));
    expect(a1Checks.map((c) => c.resume)).toEqual(a1Checks.map((c) => (c.commands.length === 3 ? ['echo resumed No:'] : null)));
  }, 600_000);

  it('--pins refuses a run off its pins before any session, so it writes no record', async () => {
    const { out, log } = isolate('pins');
    const r = makeRepo();
    const s = spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file')])], [
      teach(r, 't1', 'f1-l1', 'LESSON_OK'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK'), apply(r, 'a2', 'f1-l1', 'LESSON_OK'),
    ]);
    await expect(run(s, ['A0'], out, { pins: { claudeVersion: '0.0.0', model: 'claude-sonnet-5-5' } }))
      .rejects.toThrow(/differs from --pins: model is pinned claude-sonnet-5-5, this run has null; hippoCommit is not pinned/);
    expect(existsSync(join(out, 'runs.jsonl'))).toBe(false);
    expect(logLines(log)).toEqual([]);
  }, 120_000);

  it('a checker diffs CHECK_PRE_COMMIT against CHECK_POST_COMMIT: unstaged new files count, runner writes never do', async () => {
    const { out } = isolate('diff');
    const r = makeRepo();
    const want = family('f1', [lesson('f1-l1', 'Add a changelog fragment', { check: { script: 'diff.mjs', args: ['want=changelog.d/x.md'] } })]);
    await run(spec(r, [want], [teach(r, 't1', 'f1-l1', 'NEW_FILE changelog.d/x.md'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'NEW_FILE changelog.d/x.md'), apply(r, 'a2', 'f1-l1', 'look around only')]), ['A0'], out);
    const a = readRecords(out);
    expect(find(a, 'A0', 't1').lessons[0].first).toBe('pass');
    expect(find(a, 'A0', 'a1').lessons[0].first).toBe('pass');
    expect(find(a, 'A0', 'a2').lessons[0].first).toBe('fail');

    const out2 = tmp('z0-turns-out-diff2-');
    const quiet = family('f1', [lesson('f1-l1', 'Leave instruction files alone', { check: { script: 'diff.mjs', args: [] } })]);
    await run(spec(r, [quiet], [plain(r, 'c0'), teach(r, 't1', 'f1-l1', 'look around only'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'CARRY')].map((t) => (t.id === 'c0' ? { ...t, prompt: 'CARRY' } : t))), ['A1', 'A2', 'A4'], out2);
    const b = readRecords(out2);
    for (const arm of ['A1', 'A2', 'A4']) {
      expect(find(b, arm, 't1').lessons[0].first, arm).toBe('pass');
      expect(find(b, arm, 'a1').lessons[0].first, arm).toBe('pass');
      expect(find(b, arm, 'a2').lessons[0].first, arm).toBe('fail');
    }
    expect(seen(out2, 'A1', 't1')['.claude/rules/r.md']).toBe('carried rule\n');
    expect(seen(out2, 'A1', 't1')['AGENTS.md']).toContain('carried agents note');
    expect(seen(out2, 'A2', 't1')['CLAUDE.md']).toContain('hippo:start');
    expect(seen(out2, 'A4', 'a1')['CLAUDE.md']).toContain('- Leave instruction files alone, because the f1-l1 checker reads it.');
  }, 300_000);

  it('no resume after a passing apply, no checker on a no-lesson task, the message byte for byte, staleFollow both ways', async () => {
    const { out, log } = isolate('neg');
    const r = makeRepo();
    const fam = reversal({ rule: 'Write the stale file for the café menu', check: { script: 'lesson.mjs', args: ['file=stale.txt'] } });
    await run(spec(r, [fam], [
      teach(r, 't1', 'f1-l1', 'NEW_FILE stale.txt'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'NEW_FILE stale.txt'),
      teach(r, 't2', 'f1-l2', 'LESSON_OK'), plain(r, 'n3'), plain(r, 'n4'), apply(r, 'a3', 'f1-l2', 'LESSON_OK\nNEW_FILE stale.txt'), apply(r, 'a4', 'f1-l2', 'LESSON_OK'),
    ]), ['A0'], out);
    const recs = readRecords(out);
    const a1 = find(recs, 'A0', 'a1');
    expect(a1).toMatchObject({ correctionTurns: 0, usage: { extra: ZERO }, lessons: [{ first: 'pass', final: 'pass' }] });
    expect(logLines(log).filter((l) => l === `resume ${a1.sessionId}`)).toEqual([]);
    expect(checkLog(log)).toHaveLength(9);
    const sent = logLines(log).find((l) => l.startsWith('resume-msg '))!.slice('resume-msg '.length);
    expect(Buffer.from(sent, 'base64').equals(Buffer.from(teachMessage(fam.lessons[0], 'confirmation'), 'utf8'))).toBe(true);
    expect(find(recs, 'A0', 'a3').lessons[0].staleFollow).toBe(true);
    expect(find(recs, 'A0', 'a4').lessons[0].staleFollow).toBe(false);
  }, 300_000);

  it('end-of-task steps run after the last turn: a resume-written line carries, and hippo settles before the resume and at the end', async () => {
    const { out } = isolate('carry');
    const r = makeRepo();
    const fam = family('f1', [lesson('f1-l1', 'Write the lesson file')]);
    await run(spec(r, [fam], [teach(r, 't1', 'f1-l1', 'LESSON_OK\nWRITE_ON_RESUME taught-line-xyz'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'look around only'), apply(r, 'a2', 'f1-l1', 'look around only')]), ['A1', 'A2'], out);
    for (const arm of ['A1', 'A2']) {
      expect(seen(out, arm, 't1')['CLAUDE.md'], arm).not.toContain('taught-line-xyz');
      for (const id of ['n1', 'n2']) expect(seen(out, arm, id)['CLAUDE.md'], `${arm} ${id}`).toContain('taught-line-xyz');
    }
    expect(seen(out, 'A2', 'n2')['CLAUDE.md']).toContain('hippo:start');
    const settle = readFileSync(join(out, 'runs', 'seqF', 'A2', 'seed1', 'settle.log'), 'utf8').trim().split('\n');
    expect(settle).toEqual(['t1 pre-resume', 't1 end', 'n1 end', 'n2 end', 'a1 end', 'a2 end']);
    expect(existsSync(join(out, 'runs', 'seqF', 'A1', 'seed1', 'settle.log'))).toBe(false);
  }, 300_000);
});


describe('drawn order in the plan', () => {
  it('plan cells follow the drawn order per seed and carry kind, familyId and set; the dry run prints orders and spacing', () => {
    const file = join(CHECKS, 'toy-tasks.json');
    const s: Spec = validateTasks(JSON.parse(readFileSync(file, 'utf8')), CHECKS);
    const steps: Array<{ seed: number; taskId: string; position: number }> = planRuns(s, ['A0', 'A4'], () => 2);
    for (const seed of [1, 2]) {
      const order = drawOrder(s.sequences[0], s.families, seed);
      for (const st of steps.filter((x) => x.seed === seed)) expect(st.taskId).toBe(order[st.position]);
    }
    const out = tmp('z0-turns-dry-');
    const res = spawnSync(process.execPath, [resolve(__dirname, '..', '..', 'scripts', 'token-eval', 'ab-run.mjs'), '--tasks', file, '--out', out, '--dry-run', '--arms', 'A0,A4'], { encoding: 'utf8', env: { ...process.env, Z0_ANCESTOR_STOP: out } });
    expect(res.status, res.stderr).toBe(0);
    const plan = readPlan(out);
    for (const c of plan) {
      const t = s.sequences[0].tasks.find((x) => x.id === c.taskId);
      if (!t) throw new Error(`plan cell names unknown task ${c.taskId}`);
      expect(c).toMatchObject({ kind: t.kind, familyId: t.familyId ?? null, set: t.kind === 'no-lesson' ? 'N' : 'R' });
      expect(c.taskId).toBe(drawOrder(s.sequences[0], s.families, c.seed)[c.position]);
    }
    for (const seed of [1, 2]) expect(res.stdout).toContain(`order seqA seed${seed}: ${drawOrder(s.sequences[0], s.families, seed).join(' ')}`);
    expect(res.stdout).toMatch(/seqA tasksSinceTeach over 10 applies: min \d+, median \d+(\.\d+)?, max \d+/);
  });
});

