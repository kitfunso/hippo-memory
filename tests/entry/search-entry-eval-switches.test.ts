// The domain rankers take the eval switches as input; the `./search` and `./testing` entries fill them from the
// environment, so frozen evals that set HIPPO_ABLATE_*, HIPPO_EVAL_RECENCY_DAYS or HIPPO_FAKE_NOW still see each one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOutcome, createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { hybridSearch, search } from '../../src/entry/search.js';
import { hybridSearchWire } from '../../src/entry/testing.js';
import { toWire } from '../../src/base/memory/memory-wire.js';
import { hybridSearch as rankHybrid } from '../../src/domain/search/hybrid.js';
import { DAY_MS } from '../../src/base/util/time.js';
import { evalSwitches } from '../../src/infra/eval-switches.js';

const SWITCHES = [
  'HIPPO_ABLATE_DECAY',
  'HIPPO_ABLATE_RECALL_BOOST',
  'HIPPO_ABLATE_OUTCOME',
  'HIPPO_ABLATE_OUTCOME_SLOW',
  'HIPPO_ABLATE_OUTCOME_FAST',
  'HIPPO_ABLATE_RECENCY',
  'HIPPO_EVAL_RECENCY_DAYS',
  'HIPPO_FAKE_NOW',
] as const;

const NOW = new Date('2026-06-11T12:00:00.000Z');

beforeEach(() => {
  for (const name of SWITCHES) vi.stubEnv(name, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** A deploy-runbook memory created `createdDaysAgo` and last read `readDaysAgo` days before NOW. */
function aged(
  createdDaysAgo: number,
  readDaysAgo = createdDaysAgo,
  outcome?: boolean,
): MemoryEntry {
  const base = createMemory('deploy runbook for the staging cluster', {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
  });
  const m = outcome === undefined ? base : applyOutcome(base, outcome);
  m.created = new Date(NOW.getTime() - createdDaysAgo * DAY_MS).toISOString();
  m.lastRetrieved = new Date(NOW.getTime() - readDaysAgo * DAY_MS).toISOString();
  m.halfLifeDays = 7;
  return m;
}

async function breakdownOf(entry: MemoryEntry, clock: { now?: Date } = { now: NOW }) {
  const [hit] = await hybridSearch('deploy runbook', [entry], {
    budget: 10000,
    explain: true,
    ...clock,
  });
  return hit.breakdown!;
}

describe('the ./search entry reads each eval switch from the environment', () => {
  it('HIPPO_ABLATE_DECAY: a month-old memory ranks as strong as a fresh one', async () => {
    expect((await breakdownOf(aged(30))).strengthMultiplier).toBeLessThan(
      (await breakdownOf(aged(0))).strengthMultiplier,
    );
    vi.stubEnv('HIPPO_ABLATE_DECAY', '1');
    expect((await breakdownOf(aged(30))).strengthMultiplier).toBe(
      (await breakdownOf(aged(0))).strengthMultiplier,
    );
  });

  it('HIPPO_ABLATE_RECALL_BOOST: decay runs from creation, so a recent read no longer refreshes strength', async () => {
    const reread = aged(30, 0);
    const live = (await breakdownOf(reread)).strengthMultiplier;
    vi.stubEnv('HIPPO_ABLATE_RECALL_BOOST', '1');
    expect((await breakdownOf(reread)).strengthMultiplier).toBeLessThan(live);
  });

  it('HIPPO_ABLATE_OUTCOME: the outcome boost drops to 1', async () => {
    expect((await breakdownOf(aged(0, 0, true))).outcomeBoost).toBeGreaterThan(1);
    vi.stubEnv('HIPPO_ABLATE_OUTCOME', '1');
    expect((await breakdownOf(aged(0, 0, true))).outcomeBoost).toBe(1);
  });

  it('HIPPO_ABLATE_OUTCOME_SLOW: a good outcome no longer slows decay, the fast boost stays', async () => {
    const plain = (await breakdownOf(aged(30))).strengthMultiplier;
    expect((await breakdownOf(aged(30, 30, true))).strengthMultiplier).toBeGreaterThan(plain);
    vi.stubEnv('HIPPO_ABLATE_OUTCOME_SLOW', '1');
    const rewarded = await breakdownOf(aged(30, 30, true));
    expect(rewarded.strengthMultiplier).toBe(plain);
    expect(rewarded.outcomeBoost).toBeGreaterThan(1);
  });

  it('HIPPO_ABLATE_OUTCOME_FAST: the outcome boost drops to 1, the slow channel stays', async () => {
    const plain = (await breakdownOf(aged(30))).strengthMultiplier;
    vi.stubEnv('HIPPO_ABLATE_OUTCOME_FAST', '1');
    const rewarded = await breakdownOf(aged(30, 30, true));
    expect(rewarded.outcomeBoost).toBe(1);
    expect(rewarded.strengthMultiplier).toBeGreaterThan(plain);
  });

  it('HIPPO_ABLATE_RECENCY: the recency multiplier is 1', async () => {
    expect((await breakdownOf(aged(30))).recencyMultiplier).toBeLessThan(1);
    vi.stubEnv('HIPPO_ABLATE_RECENCY', '1');
    expect((await breakdownOf(aged(30))).recencyMultiplier).toBe(1);
  });

  it('HIPPO_EVAL_RECENCY_DAYS: a 7-day scale lowers the recency multiplier', async () => {
    const thirty = (await breakdownOf(aged(30))).recencyMultiplier;
    vi.stubEnv('HIPPO_EVAL_RECENCY_DAYS', '7');
    expect((await breakdownOf(aged(30))).recencyMultiplier).toBeLessThan(thirty);
  });

  it('HIPPO_FAKE_NOW: with no `now` passed, scoring runs on the fake clock', async () => {
    vi.stubEnv('HIPPO_FAKE_NOW', '2030-01-01T00:00:00.000Z');
    // Dated 2026, so the 2030 clock leaves almost no strength: 0.5 + 0.5 * strength.
    expect((await breakdownOf(aged(0), {})).strengthMultiplier).toBeLessThan(0.51);
  });

  it('the BM25 search reads them too', () => {
    const live = search('deploy runbook', [aged(30)], { now: NOW })[0].score;
    vi.stubEnv('HIPPO_ABLATE_RECENCY', '1');
    expect(search('deploy runbook', [aged(30)], { now: NOW })[0].score).toBeGreaterThan(live);
  });
});

describe('the ./testing entry reads them as well', () => {
  it('hybridSearchWire drops the recency multiplier under HIPPO_ABLATE_RECENCY', async () => {
    vi.stubEnv('HIPPO_ABLATE_RECENCY', '1');
    const [hit] = await hybridSearchWire('deploy runbook', [toWire(aged(30))], {
      explain: true,
      now: NOW,
    });
    expect(hit.breakdown!.recencyMultiplier).toBe(1);
  });
});

describe('the domain ranker takes the switches as input', () => {
  it('ignores the environment and follows the switches it is handed', async () => {
    vi.stubEnv('HIPPO_ABLATE_RECENCY', '1');
    const options = { budget: 10000, explain: true, now: NOW };
    const [unswitched] = await rankHybrid('deploy runbook', [aged(30)], options);
    expect(unswitched.breakdown!.recencyMultiplier).toBeLessThan(1);
    const [switched] = await rankHybrid('deploy runbook', [aged(30)], {
      ...options,
      switches: evalSwitches(),
    });
    expect(switched.breakdown!.recencyMultiplier).toBe(1);
  });
});
