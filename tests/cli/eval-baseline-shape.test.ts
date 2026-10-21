// The eval baseline file is checked for its shape before the suite compares against it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleEval, parseEvalBaseline } from '../../src/surface/cli/eval.js';
import { CliExit } from '../../src/surface/cli/exit.js';
import type { JsonValue } from '../../src/base/util/json.js';

const METRICS = { mrr: 0.9, recallAt5: 0.8, ndcgAt5: 0.7 };
const GOOD: JsonValue = {
  version: '1.0.0',
  timestamp: '2026-01-01T00:00:00.000Z',
  features: { 'direct-recall': METRICS },
  overall: METRICS,
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-eval-baseline-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseEvalBaseline', () => {
  it('accepts a baseline with every field', () => {
    expect(parseEvalBaseline(GOOD)).toEqual(GOOD);
  });

  it.each<[string, JsonValue]>([
    ['an array', []],
    ['no overall', { version: '1', timestamp: 't', features: {} }],
    [
      'a feature with a string metric',
      {
        version: '1',
        timestamp: 't',
        features: { x: { ...METRICS, mrr: 'high' } },
        overall: METRICS,
      },
    ],
    ['a numeric version', { version: 1, timestamp: 't', features: {}, overall: METRICS }],
  ])('refuses %s', (_name, value) => {
    expect(parseEvalBaseline(value)).toBeNull();
  });
});

describe('hippo eval --suite --baseline', () => {
  it('stops with the file path when the baseline has the wrong shape', async () => {
    const baseline = path.join(dir, 'baseline.json');
    fs.writeFileSync(baseline, JSON.stringify({ version: '1', overall: 'bad' }));
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    const run = handleEval({
      hippoRoot: dir,
      tenantId: 'default',
      args: [],
      flags: { suite: true, baseline },
    });

    await expect(run).rejects.toBeInstanceOf(CliExit);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(baseline);
  });
});
