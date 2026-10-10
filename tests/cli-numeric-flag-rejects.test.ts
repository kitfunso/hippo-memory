// A junk numeric flag exits 1 with a message; before, it became NaN and slid past every `<` gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { handleEval } from '../src/cli/eval.js';
import { handleShare } from '../src/cli/transfer.js';
import { numberFlag } from '../src/cli/flag-values.js';
import { runInProcess } from './_helpers/run-in-process.js';

let root = '';
let store = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-numflag-'));
  store = join(root, 'local');
  vi.stubEnv('HIPPO_HOME', join(root, 'global'));
  vi.stubEnv('HIPPO_TENANT', '');
  initStore(store);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('numeric CLI flags', () => {
  it('numberFlag exits on a non-finite or empty value and passes a number', () => {
    expect(numberFlag({ x: '0.5' }, 'x')).toBe(0.5);
    expect(numberFlag({}, 'x')).toBeUndefined();
    expect(() => numberFlag({ x: 'abc' }, 'x')).toThrow();
    expect(() => numberFlag({ x: '' }, 'x')).toThrow();
    expect(() => numberFlag({ x: 'Infinity' }, 'x')).toThrow();
  });

  it('hippo eval --min-mrr abc exits 1 with the message', async () => {
    const corpus = join(root, 'corpus.json');
    writeFileSync(corpus, JSON.stringify({ cases: [{ id: 'a', query: 'deploy', expectedIds: ['x'] }] }));
    const bad = await runInProcess(() => handleEval({ hippoRoot: store, tenantId: 'default', args: [corpus], flags: { 'min-mrr': 'abc' } }));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('Invalid --min-mrr: "abc". Must be a number.');
    const ok = await runInProcess(() => handleEval({ hippoRoot: store, tenantId: 'default', args: [corpus], flags: { 'min-mrr': '0' } }));
    expect(ok.status).toBe(0);
  });

  it('hippo share --auto --min-score abc exits 1 with the message', async () => {
    const bad = await runInProcess(() => handleShare({ hippoRoot: store, tenantId: 'default', args: [], flags: { auto: true, 'min-score': 'abc' } }));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('Invalid --min-score: "abc". Must be a number.');
  });
});
