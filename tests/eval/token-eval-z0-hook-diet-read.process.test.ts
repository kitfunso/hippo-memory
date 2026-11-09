/** Z0 hook diet read end to end over a tiny scored tree and a stub hippo checkout: staging, the clock pin, the store counts and the named failures. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../../scripts/token-eval/z0-hook-diet.mjs';

const AT = '2026-11-07T23:10:57Z';
const ISO = '2026-11-07T23:10:57.000Z';
const PROMPT = 'fix the parser';
const RECORDED = '## Project Memory (1 entries, 100 tokens)\n\n- **[observed] one** [rule]\n';
const TAGS = { digest: ['session-digest'], list3: ['session-digest', 'claude-code-memory', 'auto-captured'] };

const STUB_HEAD = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
  "const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.hippo', 'config.json'), 'utf8'));",
  'const pinned = cfg.pinnedInject ?? null;',
  'const exclude = pinned?.excludeTags ?? null;',
  "fs.appendFileSync(path.join(__dirname, 'seen.jsonl'), JSON.stringify({",
  '  now: process.env.HIPPO_FAKE_NOW ?? null, prompt: input.prompt, hook: input.hook_event_name, pinned, args: process.argv.slice(2),',
  "  project: fs.readFileSync(path.join(process.cwd(), '.hippo-project.json'), 'utf8'),",
  "  storeMarker: fs.existsSync(path.join(process.cwd(), '.hippo', 'marker.txt')),",
  "  homeMarker: fs.existsSync(path.join(process.env.HIPPO_HOME, 'marker.txt')),",
  '  home: process.env.HOME, envKeys: Object.keys(process.env),',
  "}) + '\\n');",
].join('\n');
const PRINTS_BLOCK = [
  'const tokens = exclude === null ? 100 : exclude.length === 1 ? 40 : 10;',
  "const text = '## Project Memory (1 entries, ' + tokens + ' tokens)\\n\\n- **[observed] one** [rule]\\n';",
  "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));",
].join('\n');
const EXITS_NON_ZERO = "process.stderr.write('boom\\nsecond line\\n'); process.exit(3);";
const PRINTS_NON_JSON = "process.stdout.write('hippo: no wrapper here\\n');";

interface Seen {
  now: string | null; prompt: string; hook: string; pinned: Record<string, string[] | boolean> | null; args: string[]; project: string;
  storeMarker: boolean; homeMarker: boolean; home: string; envKeys: string[];
}
interface Rep {
  stores: number; rendered: number; noLog: number; noPrompt: number; fidelity: { recorded: number; exact: number };
  arms: Record<string, { sumTokens: number }>; sessions: { n: number; meanCallsWithBlock: number };
  rows: { noLog: boolean; noPrompt: boolean; log: string; taskId: string | null }[];
}
interface SeedSpec { seed: number; log: string | null; usage: string | null }

const HEAD_LINE = JSON.stringify({ at: AT, method: 'HEAD', url: '/api/hello', body: '' });
const reminder = (inner: string): string => `<system-reminder>\n${inner}\n</system-reminder>`;
const post = (parts: string[]): string => {
  const content = parts.map((text) => ({ type: 'text', text }));
  return JSON.stringify({ at: AT, method: 'POST', url: '/v1/messages?beta=true', body: JSON.stringify({ tools: ['a', 'b', 'c', 'd'], messages: [{ role: 'user', content }] }) });
};
const BLOCK_PART = reminder(`UserPromptSubmit hook additional context: ${RECORDED}`);
const GOOD_LOG = `${[HEAD_LINE, post([BLOCK_PART, PROMPT]), post([BLOCK_PART, PROMPT])].join('\n')}\n`;
const REMINDER_ONLY_LOG = `${[HEAD_LINE, post([reminder('only a reminder')])].join('\n')}\n`;
const USAGE = JSON.stringify({ usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, input_tokens: 5, output_tokens: 50 }, num_turns: 3, total_cost_usd: 0.1 });

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A scored folder shaped like round 3's: one final-read run whose plan has two A2 steps per seed, and a snapshot, log and usage file per seed spec. */
function scoredTree(base: string, seeds: SeedSpec[]): string {
  const run = path.join(base, 'scored', 'r3run', 'q1-w1', 'run');
  const steps = seeds.flatMap(({ seed }) => [
    { seed, arm: 'A2', sequence: 'seq', taskId: 'seq-a1' },
    { seed, arm: 'A2', sequence: 'seq', taskId: 'seq-a2' },
    { seed, arm: 'A5', sequence: 'seq', taskId: 'seq-a3' },
  ]);
  write(path.join(run, 'plan.json'), JSON.stringify(steps));
  for (const s of seeds) {
    const pre = path.join(run, 'snap', 'seq', 'A2', `seed${s.seed}`, 'pre-session');
    write(path.join(pre, 'hippoWork', '.hippo', 'config.json'), JSON.stringify({ pinnedInject: { promptRecall: false } }));
    write(path.join(pre, 'hippoWork', '.hippo', 'marker.txt'), 'store');
    write(path.join(pre, 'hippoGlobal', 'hippo-home', 'marker.txt'), 'home');
    const raw = path.join(run, 'raw', 'seq', 'A2', `seed${s.seed}`);
    if (s.log !== null) write(path.join(raw, 'seq-a2.session1.requests.jsonl'), s.log);
    if (s.usage !== null) write(path.join(raw, 'seq-a2.json'), s.usage);
  }
  return path.join(base, 'scored');
}

/** A hippo checkout whose bin/hippo.js is a stub: it logs what it saw to bin/seen.jsonl, then runs `tail`. */
function stubCheckout(base: string, tail: string, withDist = true): string {
  const dir = path.join(base, 'checkout');
  write(path.join(dir, 'package.json'), '{"type":"commonjs"}');
  write(path.join(dir, 'bin', 'hippo.js'), `${STUB_HEAD}\n${tail}\n`);
  if (withDist) write(path.join(dir, 'dist', 'cli.js'), '');
  return dir;
}

const tempBase = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'z0-hook-diet-read-'));

function read(base: string, scored: string, checkout: string, clock = 'session') {
  const prices = path.join(base, 'prices.json');
  write(prices, JSON.stringify({ 'claude-code': { cacheWritePerMTok: 8, cacheReadPerMTok: 0.2 } }));
  return runCli(['--scored', scored, '--checkout', checkout, '--work', path.join(base, 'work'), '--prices', prices, '--clock', clock, '--json']);
}

function seenBy(checkout: string): Seen[] {
  const text = fs.readFileSync(path.join(checkout, 'bin', 'seen.jsonl'), 'utf8');
  return text.trim().split('\n').map((line): Seen => JSON.parse(line));
}

const onlyGoodSeed: SeedSpec[] = [{ seed: 1, log: GOOD_LOG, usage: USAGE }];

describe('Z0 hook diet read', () => {
  it('stages each arm, pins the clock to the first log line and counts noLog and noPrompt apart', () => {
    const base = tempBase();
    const scored = scoredTree(base, [{ seed: 1, log: GOOD_LOG, usage: USAGE }, { seed: 2, log: null, usage: null }, { seed: 3, log: REMINDER_ONLY_LOG, usage: null }]);
    const co = stubCheckout(base, PRINTS_BLOCK);
    const res = read(base, scored, co);
    expect(res).toMatchObject({ code: 0, stderr: '' });
    const rep: Rep = JSON.parse(res.stdout);
    expect(rep).toMatchObject({ stores: 3, rendered: 1, noLog: 1, noPrompt: 1, fidelity: { recorded: 1, exact: 1 }, sessions: { n: 1, meanCallsWithBlock: 2 } });
    expect(rep.rows.map((r) => [r.taskId, r.noLog, r.noPrompt])).toEqual([['seq-a2', false, false], ['seq-a2', true, false], ['seq-a2', false, true]]);
    expect(rep.rows[1]?.log).toBe(path.join(scored, 'r3run', 'q1-w1', 'run', 'raw', 'seq', 'A2', 'seed2', 'seq-a2.session1.requests.jsonl'));
    expect(['none', 'digest', 'list3'].map((arm) => rep.arms[arm]?.sumTokens)).toEqual([100, 40, 10]);

    const seen = seenBy(co);
    expect(seen).toHaveLength(3);
    expect(seen.map((s) => s.now)).toEqual([ISO, ISO, ISO]);
    expect(seen.map((s) => s.pinned)).toEqual([{ promptRecall: false }, { promptRecall: false, excludeTags: TAGS.digest }, { promptRecall: false, excludeTags: TAGS.list3 }]);
    for (const s of seen) {
      expect(s).toMatchObject({ prompt: PROMPT, hook: 'UserPromptSubmit', project: '{"id":"work"}', storeMarker: true, homeMarker: true });
      expect(s.args).toEqual(['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context']);
      expect(s.home.startsWith(path.join(base, 'work'))).toBe(true);
      expect(s.envKeys.filter((k) => /_(KEY|TOKEN)$/.test(k))).toEqual([]);
    }
    expect(fs.readdirSync(path.join(base, 'work'))).toEqual([]);
  });

  it('sets no HIPPO_FAKE_NOW under the wall clock', () => {
    const base = tempBase();
    const co = stubCheckout(base, PRINTS_BLOCK);
    expect(read(base, scoredTree(base, onlyGoodSeed), co, 'wall').code).toBe(0);
    expect(seenBy(co).map((s) => s.now)).toEqual([null, null, null]);
  });

  it('fails with a named error when the stub exits non-zero', () => {
    const base = tempBase();
    const res = read(base, scoredTree(base, onlyGoodSeed), stubCheckout(base, EXITS_NON_ZERO));
    expect(res).toMatchObject({ code: 1, stdout: '' });
    expect(res.stderr).toContain('z0-hook-diet: 3 renders failed, first q1-w1 seq seed 1 arm none (exit 3: boom);');
  });

  it('fails when the stub prints output that is not the hook JSON wrapper on exit 0', () => {
    const base = tempBase();
    const res = read(base, scoredTree(base, onlyGoodSeed), stubCheckout(base, PRINTS_NON_JSON));
    expect(res).toMatchObject({ code: 1, stdout: '' });
    expect(res.stderr).toContain('z0-hook-diet: 3 renders failed, first q1-w1 seq seed 1 arm none (output is not the hook JSON wrapper');
  });

  it('fails with the first missing log when no store renders, never a NaN report', () => {
    const base = tempBase();
    const scored = scoredTree(base, [{ seed: 1, log: null, usage: null }, { seed: 2, log: REMINDER_ONLY_LOG, usage: null }]);
    const res = read(base, scored, stubCheckout(base, PRINTS_BLOCK));
    expect(res).toMatchObject({ code: 1, stdout: '' });
    expect(res.stderr).toContain('z0-hook-diet: 0 of 2 stores rendered (noLog 1, noPrompt 1), first missing log');
    expect(res.stderr).toContain(path.join('seed1', 'seq-a2.session1.requests.jsonl'));
  });

  it('names a usage file with no usage object and says to rerun the session', () => {
    const base = tempBase();
    const scored = scoredTree(base, [{ seed: 1, log: GOOD_LOG, usage: JSON.stringify({ num_turns: 3 }) }]);
    const res = read(base, scored, stubCheckout(base, PRINTS_BLOCK));
    expect(res).toMatchObject({ code: 1, stdout: '' });
    expect(res.stderr).toMatch(/z0-hook-diet: .*seq-a2\.json has no usage object; .*rerun the session/);
  });

  it('names an unbuilt checkout and says to build it', () => {
    const base = tempBase();
    const res = read(base, scoredTree(base, onlyGoodSeed), stubCheckout(base, PRINTS_BLOCK, false));
    expect(res).toMatchObject({ code: 1, stdout: '' });
    expect(res.stderr).toMatch(/z0-hook-diet: .* has no dist.cli\.js; run npm run build there/);
  });
});
