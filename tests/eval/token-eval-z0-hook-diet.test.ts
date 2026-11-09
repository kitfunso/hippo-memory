/** Z0 hook diet replay pure parts: hook block parsing, config staging, the isolated env, the fidelity rule, request-log reads, the work-dir guard and the saving sums. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { blockOf, checkPathDirs, checkWorkDir, lastA2Task, mainCallsWithBlock, parseArgs, renderEnv, runCli, sameBlock, stagedConfig, summarize, userPrompt } from '../../scripts/token-eval/z0-hook-diet.mjs';

type Section = [string, number, number];
interface Part { type: string; text: string }
interface Body { model?: string; tools?: string[]; messages?: { role: string; content: string | Part[] }[] }
interface Arm { exit: number; chars: number; sections: Section[] }
interface Row {
  run: string; task: string; seed: number; taskId: string | null; log: string; noLog: boolean; noPrompt: boolean; recorded: Section[]; calls: number;
  usage: { cacheRead: number; cacheWrite: number; input: number; output: number; turns: number; costUsd: number } | null;
  arms: Record<string, Arm> | null;
}

const BLOCK = [
  '## Pinned rules (2 entries, 40 tokens)',
  '',
  '- **[verified] keep lines short** [rule]',
  '',
  '## Prompt-Relevant Memory (3 entries, 90 tokens)',
  '',
  '- **[observed] I fixed the parser.** [session-digest]',
].join('\n');
const PRICES = { cacheWritePerMTok: 8, cacheReadPerMTok: 0.2 };
const wrapped = (text: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });

/** One logged request, shaped like the proxy's request log. */
const logLine = (body: Body, method = 'POST', url = '/v1/messages?beta=true'): string => JSON.stringify({ at: '2026-11-07T23:10:57.497Z', method, url, body: JSON.stringify(body) });
const mainBody = (text: string): Body => ({ tools: ['a', 'b', 'c', 'd'], messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
const arm = (tokens: number, chars: number, name = 'Project Memory'): Arm => ({ exit: 0, chars, sections: [[name, 5, tokens]] });

function row(over: Partial<Row>): Row {
  const usage = { cacheRead: 100_000, cacheWrite: 10_000, input: 10, output: 1_000, turns: 4, costUsd: 0.5 };
  return { run: 'ab-w1', task: 'seq', seed: 1, taskId: 'f1-a2', log: 'raw/f1-a2.session1.requests.jsonl', noLog: false, noPrompt: false, recorded: [], calls: 3, usage, arms: null, ...over };
}

describe('Z0 hook diet block parsing', () => {
  it('reads the block text and section headers out of the hook JSON wrapper', () => {
    expect(blockOf(wrapped(BLOCK))).toEqual({ text: BLOCK, sections: [['Pinned rules', 2, 40], ['Prompt-Relevant Memory', 3, 90]], error: null });
  });

  it('gives an empty text, no sections and no error for empty output', () => {
    expect(blockOf('')).toEqual({ text: '', sections: [], error: null });
    expect(blockOf('  \n')).toEqual({ text: '', sections: [], error: null });
  });

  it('gives an empty wrapper text as an empty block with no error', () => {
    expect(blockOf(wrapped(''))).toEqual({ text: '', sections: [], error: null });
  });

  it('reports output that is not the hook JSON wrapper as an error, never as block text', () => {
    for (const stdout of [BLOCK, 'hippo: something went wrong', '{"other":1}', 'null', '[]', JSON.stringify({ hookSpecificOutput: { additionalContext: 7 } })]) {
      expect(blockOf(stdout)).toMatchObject({ text: '', sections: [], error: expect.stringContaining('not the hook JSON wrapper') });
    }
  });

  it('gives a Rules heading with no token header no section, and keeps one that carries a header', () => {
    expect(blockOf(wrapped(`## Rules from the user\n- No: run uv run\n\n${BLOCK}`)).sections).toEqual([['Pinned rules', 2, 40], ['Prompt-Relevant Memory', 3, 90]]);
    expect(blockOf(wrapped('## Rules from the user (1 entry, 7 tokens)\n- a\n')).sections).toEqual([['Rules from the user', 1, 7]]);
  });

  it('does not take the CLAUDE.md "Project Memory (Hippo)" heading for a section', () => {
    expect(blockOf(wrapped('## Project Memory (Hippo)\n\nThe hook injects rules.')).sections).toEqual([]);
  });
});

describe('Z0 hook diet config staging', () => {
  it('sets excludeTags and keeps every other key, including the other pinnedInject keys', () => {
    const cfg = { pinnedInject: { promptRecall: false, skipUnchanged: true }, other: { a: 1 } };
    expect(stagedConfig(cfg, ['session-digest'])).toEqual({ pinnedInject: { promptRecall: false, skipUnchanged: true, excludeTags: ['session-digest'] }, other: { a: 1 } });
    expect(stagedConfig({}, ['x'])).toEqual({ pinnedInject: { excludeTags: ['x'] } });
  });

  it('returns a copy with no excludeTags key for null', () => {
    const cfg = { pinnedInject: { promptRecall: false } };
    const out = stagedConfig(cfg, null);
    expect(out).toEqual(cfg);
    expect(out).not.toBe(cfg);
    expect(out.pinnedInject).not.toBe(cfg.pinnedInject);
    expect(Object.keys(out.pinnedInject)).toEqual(['promptRecall']);
  });

  it('never changes its input, and the output shares no list with the arm', () => {
    const cfg = { pinnedInject: { skipUnchanged: true } };
    const tags = ['session-digest'];
    const out = stagedConfig(cfg, tags);
    expect(cfg).toEqual({ pinnedInject: { skipUnchanged: true } });
    expect(out.pinnedInject.excludeTags).not.toBe(tags);
  });
});

describe('Z0 hook diet render env', () => {
  const parent = {
    SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\tmp', LANG: 'en', PATH: path.dirname(process.execPath),
    HIPPO_SCOPE: 'work', HIPPO_TENANT: 'acme', ANTHROPIC_API_KEY: 'unset-in-test', GITHUB_TOKEN: 'unset-in-test', NPM_TOKEN: 'unset-in-test', HIPPO_FAKE_NOW: '2020-01-01T00:00:00.000Z',
  };

  it('keeps the allowlisted names and drops the parent scope, tenant, key and every token', () => {
    const env = renderEnv('/w/run', null, parent);
    expect(env).toMatchObject({ SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\tmp', LANG: 'en' });
    for (const name of ['HIPPO_SCOPE', 'HIPPO_TENANT', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN']) expect(env).not.toHaveProperty(name);
    expect(Object.keys(env).filter((k) => k.endsWith('_TOKEN'))).toEqual([]);
  });

  it('sets HIPPO_FAKE_NOW only when a time is given, never from the parent', () => {
    expect(renderEnv('/w/run', null, parent)).not.toHaveProperty('HIPPO_FAKE_NOW');
    expect(renderEnv('/w/run', '2026-11-07T23:10:57.497Z', parent).HIPPO_FAKE_NOW).toBe('2026-11-07T23:10:57.497Z');
  });

  it('puts home, app data and the hippo home under the run folder and skips the integrations', () => {
    const env = renderEnv('/w/run', null, parent);
    const user = path.join('/w/run', 'user');
    expect(env).toMatchObject({ HOME: user, USERPROFILE: user, HIPPO_HOME: path.join('/w/run', 'home') });
    expect(env.APPDATA).toBe(path.join(user, 'AppData', 'Roaming'));
    expect(env.LOCALAPPDATA).toBe(path.join(user, 'AppData', 'Local'));
    expect(env).toMatchObject({ HIPPO_SKIP_AUTO_INTEGRATIONS: '1', HIPPO_SKIP_SCHEDULE: '1', HIPPO_SKIP_POSTINSTALL: '1' });
    expect((env.PATH ?? '').split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
  });
});

describe('Z0 hook diet codex launcher guard', () => {
  it('refuses a PATH folder that holds a codex launcher, naming the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-hook-diet-codex-'));
    for (const name of ['git', 'git.exe', 'git.cmd', 'codex.cmd']) fs.writeFileSync(path.join(dir, name), '');
    expect(() => checkPathDirs({ PATH: dir })).toThrow(/a codex launcher .*codex/);
  });
});

describe('Z0 hook diet fidelity rule', () => {
  const pinned: Section = ['Pinned rules', 2, 40];
  const recall: Section = ['Prompt-Relevant Memory', 3, 90];
  const recorded = [pinned, recall];

  it('matches the same headers, entry counts and token counts in the same order', () => {
    expect(sameBlock(recorded, [['Pinned rules', 2, 40], ['Prompt-Relevant Memory', 3, 90]])).toBe(true);
  });

  it('fails when the order, an entry count or a token count differs', () => {
    expect(sameBlock(recorded, [recall, pinned])).toBe(false);
    expect(sameBlock(recorded, [pinned, ['Prompt-Relevant Memory', 4, 90]])).toBe(false);
    expect(sameBlock(recorded, [['Pinned rules', 2, 41], recall])).toBe(false);
    expect(sameBlock(recorded, [pinned])).toBe(false);
  });

  it('ignores a Rules section in the replay', () => {
    expect(sameBlock(recorded, [['Rules from the user', 2, 9], ['Pinned rules', 2, 40], ['Prompt-Relevant Memory', 3, 90]])).toBe(true);
  });
});

describe('Z0 hook diet request-log reads', () => {
  it('counts only main-agent calls whose messages hold a hippo header', () => {
    const lines = [
      JSON.stringify({ at: '2026-11-07T23:10:57.497Z', method: 'HEAD', url: '/api/hello', body: '' }),
      logLine(mainBody(BLOCK)),
      logLine({ tools: ['a'], messages: [{ role: 'user', content: [{ type: 'text', text: BLOCK }] }] }),
      logLine(mainBody('no hippo block in this request')),
      '',
      logLine(mainBody(`${BLOCK}\nlater turn`)),
    ];
    expect(mainCallsWithBlock(lines)).toBe(2);
  });

  it('takes the first user text that is not a system reminder as the prompt', () => {
    const lines = [
      JSON.stringify({ at: '2026-11-07T23:10:57.497Z', method: 'HEAD', url: '/api/hello', body: '' }),
      logLine({ model: 'm' }),
      logLine({ messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>\nrules\n</system-reminder>' }, { type: 'text', text: 'fix the parser' }] }] }),
      logLine({ messages: [{ role: 'user', content: 'a later prompt' }] }),
    ];
    expect(userPrompt(lines)).toBe('fix the parser');
  });

  it('reads a string message and gives null when only reminders or no messages are logged', () => {
    expect(userPrompt([logLine({ messages: [{ role: 'user', content: 'plain prompt' }] })])).toBe('plain prompt');
    expect(userPrompt([logLine({ messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] }] })])).toBeNull();
    expect(userPrompt([logLine({ model: 'm' }), ''])).toBeNull();
  });

  it('names a cut-off request log line', () => {
    expect(() => userPrompt(['{"at":'])).toThrow(/cut off/);
  });

  it('picks the last A2 task of the sequence and seed in plan order', () => {
    const plan = [
      { arm: 'A2', seed: 1, sequence: 'q1', taskId: 'q1-a' },
      { arm: 'A5', seed: 1, sequence: 'q1', taskId: 'q1-x' },
      { arm: 'A2', seed: 2, sequence: 'q1', taskId: 'q1-s2' },
      { arm: 'A2', seed: 1, sequence: 'q2', taskId: 'q2-a' },
      { arm: 'A2', seed: 1, sequence: 'q1', taskId: 'q1-b' },
    ];
    expect(lastA2Task(plan, 'q1', 1)).toBe('q1-b');
    expect(lastA2Task(plan, 'q1', 3)).toBeNull();
  });
});

describe('Z0 hook diet work-dir guard', () => {
  it('accepts a folder under the temp root, made or not yet made', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-hook-diet-guard-'));
    expect(path.relative(fs.realpathSync.native(base), checkWorkDir(path.join(base, 'not', 'yet')))).toBe(path.join('not', 'yet'));
    expect(() => checkWorkDir(base)).not.toThrow();
  });

  it('refuses a folder outside the temp root and the temp root itself', () => {
    expect(() => checkWorkDir(path.dirname(os.tmpdir()))).toThrow(/not under the temp root/);
    expect(() => checkWorkDir(os.tmpdir())).toThrow(/not under the temp root/);
  });

  it('refuses a folder with a .hippo store on the way up to the temp root', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-hook-diet-stray-'));
    fs.mkdirSync(path.join(base, '.hippo'));
    expect(() => checkWorkDir(path.join(base, 'work'))).toThrow(/stray store/);
  });
});

describe('Z0 hook diet summary', () => {
  const rows = [
    row({ recorded: [['Project Memory', 5, 400]], calls: 3, arms: { none: arm(400, 2000), digest: arm(200, 1500), list3: arm(100, 1000) } }),
    row({
      seed: 2, recorded: [['Project Memory', 5, 999]], calls: 5, usage: { cacheRead: 300_000, cacheWrite: 10_000, input: 10, output: 1_000, turns: 6, costUsd: 1.5 },
      arms: { none: { exit: 0, chars: 3000, sections: [['Project Memory', 5, 600], ['Rules from the user', 2, 50]] }, digest: arm(400, 2400), list3: arm(300, 2000) },
    }),
    row({ seed: 3, calls: 0, arms: { none: arm(0, 0), digest: arm(0, 0), list3: arm(0, 0) } }),
    row({ seed: 4, noPrompt: true, usage: null }),
    row({ seed: 5, noLog: true, taskId: null, usage: null }),
  ];
  const rep = summarize(rows, PRICES);

  it('counts stores, rendered stores, stores with no session log and stores with no first prompt apart', () => {
    expect(rep).toMatchObject({ stores: 5, rendered: 3, noLog: 1, noPrompt: 1 });
  });

  it('sums header tokens per arm without the Rules section, and counts empty blocks', () => {
    expect(rep.arms.none).toMatchObject({ sumTokens: 1000, meanTokens: 1000 / 3, medianTokens: 400, sumChars: 5000, empty: 1 });
    expect(rep.arms.list3).toMatchObject({ sumTokens: 400, medianTokens: 100, empty: 1 });
  });

  it('cuts each arm against none by header tokens and by chars', () => {
    expect(rep.cut.digest.tokensPct).toBeCloseTo(40, 9);
    expect(rep.cut.list3.tokensPct).toBeCloseTo(60, 9);
    expect(rep.cut.digest.charsPct).toBeCloseTo(22, 9);
    expect(rep.cut.list3.charsPct).toBeCloseTo(40, 9);
  });

  it('counts a recorded block and an exact match of the none arm against it', () => {
    expect(rep.fidelity).toEqual({ recorded: 2, exact: 1 });
  });

  it('leaves a session whose round 3 logs hold no block out of the session means and the saving', () => {
    expect(rep.sessions).toEqual({ n: 2, noRecordedBlock: 1, meanCallsWithBlock: 4, meanTurns: 5, meanCacheReadTokens: 200_000, meanCostUsd: 1 });
  });

  it('prices the cut as one cache write plus a cache read on each later main call', () => {
    const list3 = (300 * (8 + 2 * 0.2) + 300 * (8 + 4 * 0.2)) / 2 / 1e6;
    expect(rep.saving.list3.meanUsd).toBeCloseTo(list3, 12);
    expect(rep.saving.list3.meanUsd).toBeCloseTo(0.00258, 9);
    expect(rep.saving.list3.shareOfMeanCostPct).toBeCloseTo(0.258, 9);
    expect(rep.saving.list3.rereadSharePct).toBeCloseTo((100 * (300 * 2 + 300 * 4)) / 400_000, 9);
    expect(rep.saving.digest.meanUsd).toBeCloseTo(0.00172, 9);
  });
});

describe('Z0 hook diet arguments', () => {
  it('defaults to the session clock, a fresh work folder and no limit', () => {
    expect(parseArgs([])).toMatchObject({ clock: 'session', work: null, limit: 0, json: false, help: false });
  });

  it('takes the session and wall clocks and refuses any other', () => {
    expect(parseArgs(['--clock', 'wall']).clock).toBe('wall');
    expect(parseArgs(['--clock', 'session']).clock).toBe('session');
    expect(() => parseArgs(['--clock', 'fast'])).toThrow('--clock needs session or wall');
    expect(() => parseArgs(['--clock'])).toThrow('--clock needs session or wall');
  });

  it('reads the value flags, --limit and --json', () => {
    const args = parseArgs(['--scored', 'S', '--checkout', 'C', '--work', 'W', '--prices', 'P', '--limit', '3', '--json']);
    expect(args).toMatchObject({ scored: 'S', checkout: 'C', work: 'W', prices: 'P', limit: 3, json: true });
  });

  it('refuses an unknown flag, a flag with no value and a bad limit', () => {
    expect(() => parseArgs(['--nope'])).toThrow('unknown flag --nope');
    expect(() => parseArgs(['--scored'])).toThrow('--scored needs a directory');
    expect(() => parseArgs(['--prices', '--json'])).toThrow('--prices needs a file');
    expect(() => parseArgs(['--limit', '0'])).toThrow('--limit needs a whole number above 0');
  });

  it('exits 1 with a named error on an unknown flag and prints usage for --help', () => {
    const bad = runCli(['--nope']);
    expect(bad).toMatchObject({ code: 1, stdout: '' });
    expect(bad.stderr).toContain('z0-hook-diet: unknown flag --nope');
    expect(runCli(['--help'])).toMatchObject({ code: 0, stderr: '' });
  });
});
