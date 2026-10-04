// Pins output text, JSON key order and exit codes of CLI verbs whose long functions were split, where coverage was thin.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRoot } from './_helpers/make-root.js';
import { initStore } from '../src/store/open.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = makeRoot('q10cli');
  // The CLI looks for <cwd>/.hippo; makeRoot made that folder but put its store at the root.
  initStore(path.join(root, '.hippo'));
  env = { ...process.env, HIPPO_HOME: path.join(root, 'global'), HOME: root, USERPROFILE: root };
  delete env.ANTHROPIC_API_KEY;
  delete env.HIPPO_TENANT;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(...args: string[]): RunResult {
  const r = spawnSync(process.execPath, [HIPPO_JS, ...args], { cwd: root, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function remember(text: string, ...extra: string[]): string {
  const r = run('remember', text, '--force', ...extra);
  expect(r.status, r.stderr).toBe(0);
  const id = /Remembered \[([^\]]+)\]/.exec(r.stdout)?.[1];
  expect(id).toBeTruthy();
  return id ?? '';
}

describe('hippo remember output', () => {
  it('prints the receipt lines in order', () => {
    const r = run('remember', 'the deploy script needs the staging flag set first', '--tag', 'ops', '--pin', '--observed');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(
      /^Remembered \[[^\]]+\]\n {3}Layer: episodic \| Strength: [\d.]+ \| Half-life: [\d.]+d \| Confidence: observed\n {3}Tags: ops[^\n]*\n {3}Pinned \(no decay\)\n$/,
    );
  });

  it('rejects --kind raw with both error lines and exit 1', () => {
    const r = run('remember', 'some note about the release train', '--kind', 'raw');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Invalid --kind: "raw". Must be one of: distilled, superseded');
    expect(r.stderr).toContain("(kind='raw' is reserved for ingestion connectors; kind='archived' is internal.)");
  });
});

describe('hippo trace <id>', () => {
  it('prints the text report sections', () => {
    const id = remember('haddock quotas changed in the spring review');
    const r = run('trace', id);
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe(`Memory: ${id}  [local]`);
    expect(lines[1]).toBe('='.repeat(50));
    expect(lines[2]).toBe('Content:   haddock quotas changed in the spring review');
    expect(lines[3]).toMatch(/^Layer: {5}episodic {3}Confidence: \S+ +Pinned: no$/);
    for (const head of ['Strength trajectory:', 'Retrieval:', '  in 30 days: ', '  in 90 days: ', 'Outcomes:   +0 / -0']) {
      expect(r.stdout).toContain(head);
    }
  });

  it('keeps the --json key order', () => {
    const id = remember('cod quotas stayed flat this year');
    const out: object = JSON.parse(run('trace', id, '--json').stdout);
    expect(Object.keys(out)).toEqual([
      'id', 'source', 'layer', 'confidence', 'aged_out', 'pinned', 'starred', 'tags', 'content', 'created',
      'age_days', 'last_retrieved', 'days_since_last_retrieval', 'retrieval_count', 'strength_now', 'half_life_days',
      'reward_factor', 'effective_half_life_days', 'projected_strength_30d', 'projected_strength_90d',
      'outcome_positive', 'outcome_negative', 'parents', 'open_conflicts',
    ]);
  });

  it('exits 1 on an unknown id', () => {
    const r = run('trace', 'mem_does_not_exist');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Memory not found: mem_does_not_exist');
  });
});

describe('hippo explain', () => {
  it('keeps the --json shape and the text table', () => {
    remember('haddock fishing rules changed in spring');
    const json: { results: object[] } = JSON.parse(run('explain', 'haddock', '--json').stdout);
    expect(Object.keys(json)).toEqual(['query', 'mode', 'candidates', 'returned', 'results']);
    expect(Object.keys(json.results[0])).toEqual([
      'rank', 'id', 'layer', 'confidence', 'aged_out', 'score', 'tokens', 'tags', 'content', 'breakdown',
    ]);
    const text = run('explain', 'haddock').stdout;
    expect(text.startsWith('Query: "haddock"\nMode:  ')).toBe(true);
    expect(text).toContain('Rank  Score   Strength  Age    Layer      ID                Preview');
    expect(text).toMatch(/\n\[1\] \S+ {3}composite=/);
    expect(text).toContain('    final:     ');
    expect(text.trimEnd().endsWith('Note: explain does not mark memories as retrieved (read-only).')).toBe(true);
  });

  it('says so when nothing matches', () => {
    remember('haddock fishing rules changed in spring');
    expect(run('explain', 'zzqqxx').stdout).toMatch(/^No memories matched "zzqqxx" \(scanned \d+\)\.\n$/);
  });
});

describe('hippo embed --status', () => {
  it('reports unembedded rows without a provider check', () => {
    remember('vectors are built lazily on first embed');
    expect(run('embed', '--status').stdout).toBe(
      'Embedding status: 0/1 memories embedded\n  1 memories need embedding (run `hippo embed` to embed them)\n',
    );
  });
});

describe('hippo wm', () => {
  it('push then read prints the entry', () => {
    const push = run('wm', 'push', '--scope', 'repo', '--content', 'check the flaky test first', '--importance', '0.8');
    expect(push.stdout).toMatch(/^Pushed working memory #\d+ \(scope=repo, importance=0\.8\)\n$/);
    const read = run('wm', 'read').stdout;
    expect(read).toMatch(/^Working memory \(1 entries\):\n\n {2}#\d+ \[repo\] importance=0\.8\n {4}check the flaky test first\n {4}created=/);
    expect(run('wm', 'push').status).toBe(1);
  });
});

describe('hippo hook', () => {
  it('lists hooks and rejects a bad subcommand', () => {
    const list = run('hook', 'list').stdout;
    expect(list.startsWith('Available hooks:\n\n')).toBe(true);
    expect(list).toContain('  claude-code     -> CLAUDE.md (');
    expect(list.endsWith('\nUsage: hippo hook install <name>\n       hippo hook uninstall <name>\n')).toBe(true);
    const bad = run('hook', 'nope');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('Usage: hippo hook <install|uninstall|list> [target]');
    const unknown = run('hook', 'install', 'nope');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('Unknown hook target: nope');
  });

  it('install claude-code without a CLAUDE.md skips the file and installs settings hooks', () => {
    const r = run('hook', 'install', 'claude-code');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`CLAUDE.md not found in ${root} — skipping agent-instructions patch.`);
    expect(r.stdout).toContain('Installed hippo session-end SessionEnd hook in ');
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.claude', 'settings.json'))).toBe(true);
  });
});

describe('hippo status', () => {
  it('prints the count block and the embedding line', () => {
    remember('status counts every layer');
    const out = run('status').stdout;
    expect(out.startsWith('Hippo Status\n---------------------------\nTotal memories:    1\n  Buffer:          0\n  Episodic:        1\n')).toBe(true);
    expect(out).toContain('Last sleep:        never');
    expect(out).toMatch(/\nEmbeddings: {8}\S/);
  });
});
