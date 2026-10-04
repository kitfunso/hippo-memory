// Pins `hippo eval` stdout, stderr and exit code across corpus, compare, bootstrap and suite modes, in process,
// so a split of cmdEval that changes a byte or an exit path fails here. Timings and timestamps are masked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../src/memory.js';
import { PACKAGE_VERSION } from '../src/version.js';
import { cmdEval } from '../src/cli/eval.js';
import { runInProcess } from './_helpers/run-in-process.js';

let root = '';
let store = '';

function seeded(content: string, id: string): MemoryEntry {
  return { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), id, strength: 1 };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-eval-golden-'));
  store = join(root, 'local');
  vi.stubEnv('HIPPO_HOME', join(root, 'global'));
  vi.stubEnv('HIPPO_TENANT', '');
  initStore(store);
  writeEntry(store, seeded('the deploy pipeline uses blue green rollout for the api', 'mem_eval_deploy'));
  writeEntry(store, seeded('billing service freezes deploys every friday afternoon', 'mem_eval_billing'));
  writeEntry(store, seeded('lunch options near the office include a noodle bar', 'mem_eval_lunch'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function mask(text: string): string {
  return text
    .split(root).join('<root>')
    .replace(/\\/g, '/')
    .replace(/\b\d+ms\b/g, '<n>ms')
    .replace(/"durationMs": \d+/g, '"durationMs": <n>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>')
    .split(PACKAGE_VERSION).join('<version>');
}

type Flags = Record<string, string | boolean | string[]>;

describe('hippo eval output (in process)', () => {
  it('prints the same bytes and exit codes in every mode', async () => {
    const transcript: string[] = [];
    const step = async (label: string, corpus: string | null, flags: Flags = {}): Promise<void> => {
      const r = await runInProcess(() => cmdEval(store, corpus, flags));
      transcript.push(`$ eval ${label} -> ${r.status}\n--- stdout\n${mask(r.stdout)}--- stderr\n${mask(r.stderr)}`);
    };
    const corpus = join(root, 'corpus.json');
    writeFileSync(corpus, JSON.stringify({
      cases: [
        { id: 'deploy', query: 'deploy pipeline rollout', expectedIds: ['mem_eval_deploy'] },
        { id: 'billing', query: 'billing friday', expectedIds: ['mem_eval_billing', 'mem_eval_missing'] },
        { id: 'miss', query: 'quantum chromodynamics', expectedIds: ['mem_eval_lunch'] },
      ],
    }));
    const badCorpus = join(root, 'bad.json');
    writeFileSync(badCorpus, '{"cases": 3}');
    const baseline = join(root, 'baseline.json');
    const baselineRun = await runInProcess(() => cmdEval(store, corpus, { json: true }));
    // SAFETY: `eval --json` prints the EvalSummary, whose cases each carry a numeric ndcgAt10.
    const prior = JSON.parse(baselineRun.stdout) as { cases: Array<{ ndcgAt10: number }> };
    prior.cases[0].ndcgAt10 = 0.5;
    prior.cases[1].ndcgAt10 = 1;
    writeFileSync(baseline, JSON.stringify(prior));

    await step('(no corpus)', null);
    await step('(missing corpus)', join(root, 'nope.json'));
    await step('(bad corpus)', badCorpus);
    await step('corpus', corpus);
    await step('corpus --show-cases', corpus, { 'show-cases': true, 'no-mmr': true });
    await step('corpus --json', corpus, { json: true, 'equal-sources': true });
    await step('corpus --min-mrr 2', corpus, { 'min-mrr': '2' });
    await step('corpus --compare', corpus, { compare: baseline, 'local-bump': '1.5' });
    await step('corpus --compare --json', corpus, { compare: baseline, json: true, 'mmr-lambda': '0.5', 'embedding-weight': '0.2' });
    await step('corpus --compare (missing)', corpus, { compare: join(root, 'nope.json') });
    writeFileSync(join(root, 'corpus.txt'), 'not json');
    await step('corpus --compare (unparseable)', corpus, { compare: join(root, 'corpus.txt') });
    await step('--bootstrap', null, { bootstrap: true, 'max-cases': '2' });
    const out = join(root, 'out', 'boot.json');
    await step('--bootstrap --out', null, { bootstrap: true, out });
    transcript.push(`boot.json:\n${readFileSync(out, 'utf8')}`);
    await step('--suite', null, { suite: true, 'save-baseline': true, baseline: join(root, 'suite', 'base.json') });
    await step('--suite (with baseline) --json', null, { suite: true, json: true, baseline: join(root, 'suite', 'base.json') });
    writeFileSync(join(root, 'suite', 'base.json'), 'garbage');
    await step('--suite (unreadable baseline)', null, { suite: true, baseline: join(root, 'suite', 'base.json') });

    expect(transcript.join('\n')).toMatchSnapshot();
  });
});
